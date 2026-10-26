/**
 * 外链白名单策略 —— 「用系统浏览器打开外链」的**唯一判定入口**。
 *
 * 为什么单独一个文件：判定必须是**纯函数**才能在 `environment: 'node'` 的 vitest 里
 * 直接单测（`main/index.ts` 一 import 就拉进 electron，测不了）。本文件**绝不 import
 * electron / node 内置模块**，主进程与渲染进程都可安全导入。
 *
 * 安全边界（不可放宽）：只允许 `http:` / `https:`。
 * 渲染进程一旦被注入（XSS / 恶意资产名 / 恶意 URL 字段），它拿到的是
 * `window.modvault.openExternal()` 这把"能拉起本机程序"的钥匙：
 * - `file:///C:/Windows/System32/cmd.exe` → 直接跑本地程序
 * - `ms-settings:` / `ms-msdt:` / `search-ms:` → 拉起系统面板（历史上多个 RCE 链条入口）
 * - `javascript:` / `data:text/html,...` → 在浏览器上下文里执行脚本
 * 白名单是"只认这两种协议"，不是黑名单（黑名单永远漏协议）。
 */

/** 外链长度上限：正常 URL 远小于此值；超长串只可能是注入载荷或畸形输入。 */
export const EXTERNAL_URL_MAX_LENGTH = 2048

/**
 * 允许的协议白名单（`URL.protocol` 归一化后的值，含尾冒号、全小写）。
 * 用 `as const` 收窄，新增协议时必须显式改这里 —— 让 review 能一眼看到。
 */
export const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'http:'] as const

/** 拒绝原因（写进日志，便于线上定位是哪一类输入被拦下）。 */
export type ExternalUrlRejection =
  /** 入参不是字符串（null / number / object / undefined ...） */
  | 'not-string'
  /** 去掉首尾空白后为空串 */
  | 'empty'
  /** 超过 `EXTERNAL_URL_MAX_LENGTH` */
  | 'too-long'
  /** 含控制字符（\0-\x1F / \x7F）：`java\nscript:` 这类绕过手法的统一拦截点 */
  | 'control-char'
  /** `new URL()` 解析失败（如 `https://` 没有 host） */
  | 'unparsable'
  /** 协议不在白名单（`file:` / `javascript:` / `ms-settings:` / `data:` / `about:` ...） */
  | 'protocol'
  /** 解析成功但 host 为空（兜底，理论上 http(s) 不会走到） */
  | 'no-host'

/** 判定结果：成功携带**可直接交给 `shell.openExternal`** 的 URL（已去首尾空白）。 */
export type ExternalUrlVerdict =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: ExternalUrlRejection }

/** 控制字符（C0 区 + DEL）。合法 URL 里不允许出现，必须百分号编码。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

/**
 * 判定一个**未知入参**能否作为外链打开。
 *
 * 纯函数、无副作用、不抛错：任何输入都返回结构化结果，主进程据此决定
 * 「打开」还是「记日志 + 返回 false」。**永不 throw** —— IPC handler 里
 * 抛出的异常会变成渲染层的 rejected Promise，这里刻意不给那条路径。
 *
 * @param raw IPC 传进来的原始值（类型故意是 `unknown`：跨进程边界不可信）
 * @returns `{ ok:true, url }` 或 `{ ok:false, reason }`
 *
 * @example
 * resolveExternalUrl('https://github.com/chengcheng067/ID-BOX/issues')
 * // => { ok: true, url: 'https://github.com/chengcheng067/ID-BOX/issues' }
 * resolveExternalUrl('ms-settings:')
 * // => { ok: false, reason: 'protocol' }
 */
export function resolveExternalUrl(raw: unknown): ExternalUrlVerdict {
  // ① 类型：跨进程边界只信 string。number / object / null 一律拒绝。
  if (typeof raw !== 'string') return { ok: false, reason: 'not-string' }

  // ② 去首尾空白（URL 解析器本身也会去掉，这里先做是为了长度判定与空串判定准确）
  const trimmed = raw.trim()

  // ③ 长度：先判长度再解析 —— 超长串送进 `new URL()` 是无谓的 CPU 开销
  if (trimmed.length > EXTERNAL_URL_MAX_LENGTH) return { ok: false, reason: 'too-long' }

  // ④ 空串（含纯空白）
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }

  // ⑤ 控制字符：`java\nscript:alert(1)` 依赖解析器吞掉换行后变成 javascript:，
  //    虽然协议白名单也会拦下，但先拦更直观、且能挡住其它畸形输入
  if (CONTROL_CHARS_RE.test(trimmed)) return { ok: false, reason: 'control-char' }

  // ⑥ 语法解析：`https://`（无 host）、`ht!tp://x` 等在这里失败
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }

  // ⑦ 协议白名单：`URL.protocol` 已归一化为小写 + 带尾冒号（`HTTP://` → `http:`）
  const protocol = parsed.protocol
  if (!(ALLOWED_EXTERNAL_PROTOCOLS as readonly string[]).includes(protocol)) {
    return { ok: false, reason: 'protocol' }
  }

  // ⑧ host 兜底：白名单内的协议正常不会为空，但"不放行空 host"是硬要求
  if (parsed.hostname.length === 0) return { ok: false, reason: 'no-host' }

  // 返回**去空白后的原串**而不是 `parsed.href`：href 会改写路径（补尾斜杠、
  // 重编码 query），对 GitHub Issue 链接这类带 `?title=` 的地址可能改变语义。
  return { ok: true, url: trimmed }
}

/**
 * 布尔便捷版：只关心"能不能开"时用。
 *
 * @param raw IPC 传进来的原始值
 * @returns 允许打开返回 `true`
 */
export function isAllowedExternalUrl(raw: unknown): boolean {
  return resolveExternalUrl(raw).ok
}

/** 日志里 URL 的最大显示长度（拒绝时 `raw` 可能是 4KB 噪声，不整段落盘）。 */
const LOG_URL_MAX_CHARS = 200

/**
 * 为日志截断 URL：超长时保留前缀 + 标注原长度。
 * 只影响日志可读性，**不影响**实际打开行为（打开用的是 `resolveExternalUrl().url`）。
 *
 * @param url 待记录的 URL
 * @returns 最多 `LOG_URL_MAX_CHARS` 字符的字符串
 */
export function truncateUrlForLog(url: string): string {
  if (url.length <= LOG_URL_MAX_CHARS) return url
  return `${url.slice(0, LOG_URL_MAX_CHARS)}…(len=${url.length})`
}
