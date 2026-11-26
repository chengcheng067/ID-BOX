/**
 * 自动检查更新（GitHub Releases）——**纯函数 + 一次 fetch**，零第三方依赖。
 *
 * 设计约束（用户需求 + 工程质量）：
 * 1. **绝不影响启动**：任何失败都折进 `UpdateInfo.error`，本模块**从不抛异常**；
 *    调用方（主进程 IPC handler）直接返回结果即可，不需要 try/catch。
 * 2. **绝不真联网做单测**：`fetchLatestRelease` 接受注入的 `fetcher`，测试传桩。
 * 3. **不在本模块 import electron**：`app.getVersion()` 由调用方传进来，
 *    这样 `tests/*.test.ts`（node 环境）可以直接 import 本文件而不需要 electron 运行时。
 * 4. 未认证请求（不带 Authorization）：GitHub 限流 60 次/小时/IP，
 *    每次启动 1 次 + 手动点击少量，足够；带 token 反而会把用户凭据写进源码。
 * 5. **发布说明（`body`）原样透传**（2026-11）：本模块只做类型收敛 + 换行归一化 + 限长，
 *    **不做任何 HTML/脚本清洗** —— 那是渲染层的事（`logic/releaseNotes.ts` 把它解析成
 *    结构化 token，永不拼 HTML）。在"数据搬运层"做半套清洗只会让人误以为安全。
 */
import type { UpdateInfo } from '../shared/types'

export type { UpdateInfo }

/** 公开仓库的「最新正式版」端点（`/releases/latest` 本身已排除 draft / prerelease） */
export const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/chengcheng067/ID-BOX/releases/latest'

/** 请求超时：8 秒。断网 / DNS 挂掉时不能让 UI 的「正在检查…」无限转。 */
export const UPDATE_CHECK_TIMEOUT_MS = 8_000

/**
 * 安装包资产名规则：`IDBOX-Setup-<version>.<ext>`（见 package.json 的 artifactName）。
 * ★ 2026-11-26（用户 11-23 提出的 T-UPD-ZIP）：**优先 zip，退回 exe**。
 * 未签名 exe 会被 Chrome/Edge 的 Safe Browsing 拦成「不安全文件」不让下；zip 不会被拦。
 * 从 v1.1.0 起每个 Release 都同时传 exe + zip，但老 Release 只有 exe —— 所以保留 exe 兜底，
 * 两个都没有时 pickAssetUrl 返回 null，调用方（UpdateNotesDialog 的 assetUrl || url）退回 Release 页。
 */
const ASSET_PREFIX = 'IDBOX-Setup-'
const ZIP_SUFFIX = '.zip'
const EXE_SUFFIX = '.exe'

/**
 * Release 说明（`body`）的长度上限（字符数，UTF-16 码元）。
 *
 * 为什么要设上限：这段字符串要**过 IPC**（结构化克隆，每个字符都要复制）并常驻渲染层
 * 内存 + 进 React 渲染树。Release body 理论上可以写几十万字，不设限时一次检查就可能
 * 把几十 MB 文案塞进渲染进程 —— 而用户能看到的只有弹窗里那几屏。
 *
 * 20k 字符 ≈ 700 行中文，足够覆盖任何正常的版本说明；超出部分由
 * `NOTES_TRUNCATED_SUFFIX` 明确告知用户去 Release 页面看全文。
 */
export const MAX_NOTES_CHARS = 20_000

/** 截断后追加的中文提示（用户可见，所以措辞直白；长度算进上限） */
const NOTES_TRUNCATED_SUFFIX = '\n\n（说明过长，已截断显示，完整内容见 Release 页面）'

/**
 * 解析 `body` 字段 → 展示用 Markdown 文本。
 *
 * **不做任何 Markdown 清洗 / 转义 / 转 HTML** —— 这是渲染层的职责
 * （`logic/releaseNotes.ts` 产出结构化 token，永不拼 HTML）。主进程只负责三件事：
 * 1. 类型收敛：只接受 `string`，其余（null / number / object / 缺失）→ `null`；
 * 2. 换行归一化：去掉 `\r`。GitHub 的 body 来自 Windows 编辑器时是 `\r\n`，
 *    残留的 `\r` 会让渲染层按行切分后每行末尾都粘一个回车（表现为行尾多一个方块）；
 * 3. 长度封顶：超长截断 + 中文提示（见 `MAX_NOTES_CHARS`）。
 *
 * @param value GitHub release JSON 里的 `body` 原始值
 * @returns 归一化后的 Markdown；`null` = 没有说明（trim 后为空也算没有）
 */
export function normalizeReleaseNotes(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // `\r\n` 与孤立的 `\r` 统一成 `\n`（先归一化再判空：纯 `\r\n` 的 body 等于空）
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return null
  if (normalized.length <= MAX_NOTES_CHARS) return normalized
  // 预留后缀的位置：截断后的总长度仍然 ≤ MAX_NOTES_CHARS
  const room = Math.max(0, MAX_NOTES_CHARS - NOTES_TRUNCATED_SUFFIX.length)
  let cut = normalized.slice(0, room)
  // 不把代理对（emoji 等）切一半：切点落在高位代理上就再退一个码元，
  // 否则渲染层会拿到孤立代理并显示成 ▯（U+FFFD）
  const tail = cut.charCodeAt(cut.length - 1)
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}${NOTES_TRUNCATED_SUFFIX}`
}

/**
 * 最小化的 fetch 形参类型：真实 `fetch` 可直接赋值（参数/返回值双向兼容），
 * 测试里手写的桩也不必构造完整的 `Response`。
 */
export interface UpdateFetchInit {
  headers: Record<string, string>
  signal?: AbortSignal
}

/** 只用到 `ok` / `status` / `json()` —— 不依赖 DOM 的完整 Response 类型 */
export interface UpdateFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type UpdateFetcher = (
  url: string,
  init: UpdateFetchInit
) => Promise<UpdateFetchResponse>

/** `fetchLatestRelease` 的可选入参（全部为可注入项，便于单测） */
export interface FetchLatestReleaseOptions {
  /** 当前版本（无 v 前缀）。生产传 `app.getVersion()`；缺省按 `0.0.0` 处理 */
  current?: string
  /**
   * 允许测试注入的 fetcher。生产不传 → 用 `globalThis.fetch`（Electron 33 / Node 20+ 自带）。
   * 传 `null` 表示「刻意没有网络能力」，直接返回 network 错误。
   */
  fetcher?: UpdateFetcher | null
  /** 超时毫秒（缺省 8s） */
  timeoutMs?: number
  /** 结果里的 `checkedAt`（缺省 Date.now()；测试注入固定值） */
  now?: number
}

/** 解析后的版本：数字段 + 预发布后缀（`1.0.0-beta.2` 的 `beta.2`） */
interface ParsedVersion {
  parts: number[]
  /** 空串 = 正式版（正式版 **大于** 同号预发布版） */
  prerelease: string
}

/**
 * 解析版本号：'v0.6.8' / 'V0.7.0' / '0.7' / '1.2.3+build.7' / '1.0.0-beta.2'。
 *
 * 返回 `null` 表示不是可比较的版本（例如 'latest'、'abc'）——
 * 调用方应当把它当作解析失败，而不是猜一个数字。
 */
function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s) return null
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1)
  // 构建元数据（+build.7）不参与比较
  const plus = s.indexOf('+')
  if (plus >= 0) s = s.slice(0, plus)
  // 预发布后缀（-beta.2）：只做「有/无」比较，避免实现一套多余的 semver 规则
  let prerelease = ''
  const dash = s.indexOf('-')
  if (dash >= 0) {
    prerelease = s.slice(dash + 1)
    s = s.slice(0, dash)
  }
  if (!s) return null
  const parts: number[] = []
  for (const seg of s.split('.')) {
    // 只接受纯数字段：'0.6.x' 不是版本号，不能静默当 0 处理（会误判成 0.6.0）
    if (!/^\d+$/.test(seg)) return null
    parts.push(Number.parseInt(seg, 10))
  }
  if (parts.length === 0) return null
  return { parts, prerelease }
}

/** 去掉 `v` 前缀的展示用版本（解析失败时原样返回，仅裁剪空白） */
export function normalizeVersion(input: string): string {
  if (typeof input !== 'string') return ''
  let s = input.trim()
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1)
  return s
}

/**
 * 语义化版本比较（**数字逐段比较，绝不字符串比较**）。
 *
 * @returns `-1` = a < b；`0` = 相等；`1` = a > b
 *
 * 边界：
 * - `'0.6.10' > '0.6.9'`（字符串比较会得出相反结论）
 * - `'v0.7.0' > '0.6.8'`（v 前缀不影响）
 * - `'0.6.8' == 'v0.6.8'`（版本相同视为相等）
 * - `'0.7' > '0.6.9'`（位数不齐按缺位 0 补齐）
 * - `'1.0.0' > '1.0.0-beta'`（正式版大于预发布版）
 * - 任一侧无法解析时退化为**字符串比较**（保证「有返回值、不抛错」）
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) {
    const sa = normalizeVersion(a)
    const sb = normalizeVersion(b)
    if (sa === sb) return 0
    return sa < sb ? -1 : 1
  }
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i += 1) {
    // 缺位按 0 补齐：'0.7' 等价于 '0.7.0'
    const na = pa.parts[i] ?? 0
    const nb = pb.parts[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  // 数字部分相同：正式版 > 预发布版；两个预发布版之间按字典序（够用且稳定）
  const preA = pa.prerelease
  const preB = pb.prerelease
  if (preA === preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return preA < preB ? -1 : 1
}

/**
 * 从 release JSON 里挑「推荐下载」直链：**先找 zip，找不到退 exe，都没有返回 null**。
 * 两趟扫描而不是一趟里"谁先出现用谁"—— 资产列表顺序不可控，必须 zip 绝对优先。
 */
function pickAssetUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const prefix = ASSET_PREFIX.toLowerCase()
  // 归一化一次：只留合法 {name,url} 对，避免两趟重复做类型判断
  const candidates: Array<{ lower: string; url: string }> = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const asset = item as Record<string, unknown>
    const name = typeof asset.name === 'string' ? asset.name.trim() : ''
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!name || !url) continue
    candidates.push({ lower: name.toLowerCase(), url })
  }
  for (const suffix of [ZIP_SUFFIX, EXE_SUFFIX]) {
    for (const { lower, url } of candidates) {
      if (lower.startsWith(prefix) && lower.endsWith(suffix)) return url
    }
  }
  return null
}

/** 读一个可选字符串字段（非字符串 → null），空串也归 null */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s ? s : null
}

/** 空结果（`error` 由调用方补） */
function emptyInfo(current: string, checkedAt: number, error: UpdateInfo['error']): UpdateInfo {
  return {
    current,
    latest: null,
    hasUpdate: false,
    url: null,
    assetUrl: null,
    publishedAt: null,
    // 失败 / 无数据时没有说明可展示（弹窗据此显示「这个版本没有写更新说明」）
    notes: null,
    checkedAt,
    error
  }
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较。
 *
 * **永不抛错**：网络异常 / 超时 → `error:'network'`；非 2xx → `error:'http'`；
 * JSON 结构不符（缺 `tag_name`、tag 不是版本号）→ `error:'parse'`。
 *
 * `prerelease === true` / `draft === true` 一律视为「无更新」（`hasUpdate:false`，
 * `error:null`）—— 即使将来端点行为变化，用户也不会被推到测试版上。
 */
export async function fetchLatestRelease(
  opts: FetchLatestReleaseOptions = {}
): Promise<UpdateInfo> {
  const current = normalizeVersion(opts.current ?? '0.0.0') || '0.0.0'
  const checkedAt = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : UPDATE_CHECK_TIMEOUT_MS

  const fetcher: UpdateFetcher | null =
    opts.fetcher === null
      ? null
      : (opts.fetcher ??
        (typeof globalThis.fetch === 'function'
          ? (globalThis.fetch as unknown as UpdateFetcher)
          : null))

  if (!fetcher) return emptyInfo(current, checkedAt, 'network')

  // AbortSignal.timeout 在 Electron 33 (Node 20+) / 现代浏览器都有；
  // 旧运行时没有就退化成「无超时」，功能仍可用（只是断网时要等系统超时）。
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined

  let res: UpdateFetchResponse
  try {
    res = await fetcher(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `IDBOX/${current}`
      },
      signal
    })
  } catch {
    // DNS 失败 / 断网 / TLS 错误 / 超时（AbortError）全部落在这里
    return emptyInfo(current, checkedAt, 'network')
  }

  if (!res || typeof res.ok !== 'boolean') return emptyInfo(current, checkedAt, 'network')
  if (!res.ok) return emptyInfo(current, checkedAt, 'http')

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return emptyInfo(current, checkedAt, 'parse')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return emptyInfo(current, checkedAt, 'parse')
  }

  const release = body as Record<string, unknown>
  const rawTag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const latest = normalizeVersion(rawTag)
  const parsed = parseVersion(rawTag)
  // tag 缺失 / 不是版本号（'latest'、'nightly'）→ parse 失败，不当成"有更新"
  if (!latest || !parsed) return emptyInfo(current, checkedAt, 'parse')

  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate: false,
    url: optionalString(release.html_url),
    assetUrl: pickAssetUrl(release.assets),
    publishedAt: optionalString(release.published_at),
    // 发布说明：原样 Markdown（归一化 + 限长，见 normalizeReleaseNotes）。
    // 渲染层会把它解析成结构化 token —— 本模块不碰 HTML、不转义、不清洗语法。
    notes: normalizeReleaseNotes(release.body),
    checkedAt,
    error: null
  }

  // draft / prerelease：明确当作「无更新」（`/releases/latest` 正常不会返回它们，
  // 这里是对未来端点行为变化 + 手工错误标记的防御）
  if (release.prerelease === true || release.draft === true) return info

  info.hasUpdate = compareVersions(latest, current) > 0
  return info
}

// ── 跨版本更新说明合并（2026-11，用户需求：「跳过两个版本时不能只显示最新那一条」） ──
//
// 用户原话：从很老的版本（例如第一个能收到推送的版本）直接跳到最新版时，弹窗里的更新
// 说明应当**包含中间跳过的每个版本的具体内容**，而不是只有最新一条。
//
// 实现路线（最小侵入）：
// 1. 改用**列表端点** `GET /releases?per_page=100`（`/releases/latest` 只能拿到一条）；
// 2. 版本区间 = `current < v <= latest`，按版本降序；
// 3. 逐版清洗 body 后拼成一份 Markdown，写回既有的 `UpdateInfo.notes` ——
//    **不改 `UpdateInfo` 形状**（`tests/updateCheck.test.ts` 用 `toEqual` 钉死了全字段），
//    渲染层 `logic/releaseNotes.ts` 一行都不用改。
// 4. 总预算仍是 `MAX_NOTES_CHARS`（这段字符串要过 IPC + 常驻渲染进程）。

/**
 * 公开仓库的**发布列表**端点（按 `created_at` 倒序，最多 100 条）。
 *
 * 为什么不用 `/releases/latest`：那个端点只返回一条，拿不到"中间跳过的版本"。
 * `per_page=100` 是本仓库的量级（单条 Release 说明通常几百字）够用的上限，
 * 也是 GitHub 允许的最大值；超出的部分对"跳版本提示"没有意义。
 */
export const GITHUB_RELEASES_LIST_URL =
  'https://api.github.com/repos/chengcheng067/ID-BOX/releases?per_page=100'

/** 合并时最多拼进多少个版本（用户从 1.0.0 跳到 1.5.0 时不能把全部中间版都塞进来） */
const MAX_MERGED_VERSIONS = 10

/** 单版 body 的字符上限（合并后还要再过 `MAX_NOTES_CHARS` 总预算） */
const MAX_SINGLE_NOTES_CHARS = 6_000

/** 单版截断后缀（长度算进 6000 上限） */
const SINGLE_NOTES_SUFFIX = '\n\n（本版本说明过长，已截断）'

/** 合并后总预算被裁掉旧版本时的说明 */
const OLDER_OMITTED_HINT = '\n\n（更早的更新说明已省略，完整内容见 Release 页面）'

/** 版本条数超过 `MAX_MERGED_VERSIONS` 时的说明 */
const MORE_VERSIONS_HINT = '\n\n还有更早的更新未展示'

/** 某一版本来没有写说明时的占位（空块看起来像 bug，必须给一句人话） */
const EMPTY_BODY_PLACEHOLDER = '（这个版本没有写更新说明）'

/**
 * 行内图片语法 `![alt](url)` —— 解析器不支持图片，必须换成纯文本。
 *
 * 刻意分成**两个**正则：`.test()` 用非全局的（全局正则的 `lastIndex` 会被 `.test()`
 * 推进，下次调用从上次停的位置开始找，是一个典型的偶发漏判 bug）；
 * 替换用全局的（`String.replace` 配 `/g` 每次都会自己归零）。
 */
const IMAGE_INLINE_RE = /!\[[^\]]*\]\([^)]*\)/
const IMAGE_INLINE_ALL_RE = /!\[[^\]]*\]\([^)]*\)/g

/** 整行就是一个图片 */
const IMAGE_LINE_RE = /^!\[[^\]]*\]\([^)]*\)$/

/** 整行以 HTML 标签开头（`<img ...>` / `<br>` / `</div>`）—— 解析器会把它们当文本显示 */
const HTML_LINE_RE = /^<\/?[A-Za-z][^>]*>/

/** 标题行（1~6 个 `#` + 空白） */
const HEADING_LINE_RE = /^(#{1,6})\s/

/** 合并后仍可能超预算：先按「丢最旧版本」裁，极端情况才硬截断 */
function cutText(value: string, limit: number, suffix: string): string {
  if (value.length <= limit) return value
  const room = Math.max(0, limit - suffix.length)
  let cut = value.slice(0, room)
  // 不把代理对（emoji 等）切一半：孤立代理在渲染层会显示成 ▯
  const tail = cut.charCodeAt(cut.length - 1)
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}${suffix}`
}

/** 把连续空行压成一个（清洗掉表格行/引用行后常会留下空档） */
function collapseBlankLines(lines: string[]): string {
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim()) {
      if (out.length > 0 && out[out.length - 1] === '') continue
      out.push('')
      continue
    }
    out.push(line)
  }
  return out.join('\n').trim()
}

/**
 * 单个版本的 `body` → 能被 `logic/releaseNotes.ts` 完整吃下的受限 Markdown。
 *
 * 清洗顺序（**不可调换**）：
 * 1. `normalizeReleaseNotes` —— 复用既有的类型收敛 + `\r` 归一化 + 20000 上限保护；
 * 2. 引用块行（`>` 开头）整行丢弃 —— 解析器不支持引用，留着会显示成字面 `>`；
 * 3. 表格行（`|` 开头，含 `|---|` 分隔行）整行丢弃 —— 解析器不支持表格；
 * 4. 纯图片行 → `[图片已省略]`；行内图片 → 同样替换（解析器没有 image token，
 *    `![x](url)` 会渲染成 "!" + 链接文字，很难看）；
 * 5. HTML 标签行整行丢弃 —— 解析器会把 `<img onerror=...>` 当字面文本显示（安全，
 *    但用户看到的是源码）；
 * 6. **正文小标题降一级**（`#` → `##`、`##` → `###`）—— 否则正文的 `## 新增`
 *    会和版头 `## v1.2.0` 同级，读起来分不清"这是哪个版本的"；
 * 7. 单版封顶 6000 字符（见 `MAX_SINGLE_NOTES_CHARS`）。
 *
 * 围栏代码块不做状态机：解析器本来就不支持 ``` ，块内内容原样当段落是既有行为。
 *
 * @returns 清洗后的 Markdown；`null` = 这一版没有可展示的内容
 */
function sanitizeReleaseBody(value: unknown): string | null {
  const normalized = normalizeReleaseNotes(value)
  if (!normalized) return null

  const lines: string[] = []
  for (const rawLine of normalized.split('\n')) {
    let line = rawLine.trim()
    if (!line) {
      lines.push('')
      continue
    }
    // ② 引用块
    if (line.startsWith('>')) continue
    // ③ 表格（含 `|---|` 分隔行）
    if (line.startsWith('|')) continue
    // ⑤ HTML 整行
    if (HTML_LINE_RE.test(line)) continue
    // ④ 图片
    if (IMAGE_LINE_RE.test(line)) {
      lines.push('[图片已省略]')
      continue
    }
    if (IMAGE_INLINE_RE.test(line)) {
      line = line.replace(IMAGE_INLINE_ALL_RE, '[图片已省略]')
    }
    // ⑥ 小标题降一级（已经是 6 级就不再加，否则 7 个 `#` 会被解析器当成段落）
    const heading = HEADING_LINE_RE.exec(line)
    if (heading && heading[1].length < 6) line = `#${line}`
    lines.push(line)
  }

  const cleaned = collapseBlankLines(lines)
  if (!cleaned) return null
  return cutText(cleaned, MAX_SINGLE_NOTES_CHARS, SINGLE_NOTES_SUFFIX)
}

/** `published_at`（ISO 8601）→ `YYYY-MM-DD`；格式不符返回 null（版头就不写日期） */
function releaseDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(publishedAt)
  return match ? match[1] : null
}

/** 单个版本的列表项（已过滤 draft / prerelease / 非版本号 tag） */
interface ReleaseEntry {
  /** 去掉 `v` 前缀的版本号 */
  version: string
  /** 原始 `body`（未清洗，可能在拼接阶段因总预算被丢弃） */
  body: unknown
  htmlUrl: string | null
  assetUrl: string | null
  publishedAt: string | null
}

/**
 * 列表端点返回的 JSON → 可比较的条目数组。
 *
 * @returns `null` = 结构不符（不是数组，→ `error:'parse'`）；`[]` = 没有可用的正式版
 */
function parseReleaseList(value: unknown): ReleaseEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: ReleaseEntry[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const release = item as Record<string, unknown>
    // draft / prerelease 一律不参与（绝不给用户推测试版）
    if (release.draft === true || release.prerelease === true) continue
    const rawTag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const parsed = parseVersion(rawTag)
    // 不是版本号（'nightly' / 'latest'）→ 丢弃
    if (!parsed) continue
    // 带预发布后缀的 tag（`v1.3.0-beta.1`）即使没打 prerelease 标记也不参与，
    // 否则它会被当成"最新版"把正式版挡在外面
    if (parsed.prerelease) continue
    const version = normalizeVersion(rawTag)
    if (!version || seen.has(version)) continue
    seen.add(version)
    entries.push({
      version,
      body: release.body,
      htmlUrl: optionalString(release.html_url),
      assetUrl: pickAssetUrl(release.assets),
      publishedAt: optionalString(release.published_at)
    })
  }
  return entries
}

/** 一个版本的 Markdown 块（版头 + 清洗后的正文） */
function buildReleaseBlock(entry: ReleaseEntry): string {
  const date = releaseDate(entry.publishedAt)
  const header = date ? `## v${entry.version} · ${date}` : `## v${entry.version}`
  const body = sanitizeReleaseBody(entry.body) ?? EMPTY_BODY_PLACEHOLDER
  return `${header}\n\n${body}`
}

/**
 * 多个块拼成一份 Markdown，并守住总字符预算。
 *
 * 超预算时**从最旧的版本开始丢**（而不是从末尾砍字符串）：用户最关心的是最新那几版，
 * 而把一个版本拦腰截断会留下半句话。全部丢完仍超（不可能，单版已封 6000，10 × 6000
 * 也只在极端情况下超 20000）才硬截断。
 *
 * @param limit 本次允许的总字符数（调用方会在需要时预留末尾提示的位置）
 */
function joinBlocks(blocks: string[], limit: number): string {
  const text = blocks.join('\n\n---\n\n')
  if (text.length <= limit) return text
  let kept = blocks.slice()
  while (kept.length > 1) {
    kept = kept.slice(0, -1)
    const candidate = `${kept.join('\n\n---\n\n')}${OLDER_OMITTED_HINT}`
    if (candidate.length <= limit) return candidate
  }
  // 只剩一块仍超：单块已被 `MAX_SINGLE_NOTES_CHARS` 封顶，这里只会发生在 limit 被
  // 预留压低到 6000 以下的情况 —— 直接硬截断，保证"总量恒定守住预算"这个不变量
  return cutText(`${blocks.join('\n\n---\n\n')}${OLDER_OMITTED_HINT}`, limit, '')
}

/** `fetchMergedRelease` 的可选入参（全部可注入，便于单测） */
export interface FetchMergedReleaseOptions {
  /** 当前版本（无 v 前缀）。生产传 `app.getVersion()`；缺省按 `0.0.0` 处理 */
  current?: string
  /**
   * 测试注入的 fetcher。生产不传 → 用 `globalThis.fetch`；
   * 传 `null` 表示「刻意没有网络能力」，直接返回 network 错误。
   */
  fetcher?: UpdateFetcher | null
  /** 超时毫秒（缺省 8s） */
  timeoutMs?: number
  /** 结果里的 `checkedAt`（缺省 Date.now()；测试注入固定值） */
  now?: number
}

/**
 * 拉取**发布列表**，把 `current` 之后、直到最新版的每个版本的说明合并成一份 Markdown。
 *
 * 与 `fetchLatestRelease` 的关系：**并列的另一条路径**，不改动也不调用它
 * （它的 URL 被 `tests/updateCheck.test.ts` 用源码断言钉死了）。
 *
 * 返回的 `url` / `assetUrl` / `publishedAt` **一律取最新那一条** ——
 * 下载按钮永远指向最新安装包，合并进来的老版本只提供"更新内容"。
 *
 * **永不抛错**（同 `fetchLatestRelease` 的契约）：
 * - 无 fetch 能力 / 网络异常 / 超时 → `error:'network'`；
 * - 非 2xx → `error:'http'`；
 * - JSON 不是数组 / 解析失败 → `error:'parse'`；
 * - 列表里一个可用正式版都没有（仓库还没发过 Release）→ 当作"无更新"，`error:null`。
 */
export async function fetchMergedRelease(
  opts: FetchMergedReleaseOptions = {}
): Promise<UpdateInfo> {
  const current = normalizeVersion(opts.current ?? '0.0.0') || '0.0.0'
  const checkedAt = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : UPDATE_CHECK_TIMEOUT_MS

  const fetcher: UpdateFetcher | null =
    opts.fetcher === null
      ? null
      : (opts.fetcher ??
        (typeof globalThis.fetch === 'function'
          ? (globalThis.fetch as unknown as UpdateFetcher)
          : null))

  if (!fetcher) return emptyInfo(current, checkedAt, 'network')

  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined

  let res: UpdateFetchResponse
  try {
    res = await fetcher(GITHUB_RELEASES_LIST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `IDBOX/${current}`
      },
      signal
    })
  } catch {
    return emptyInfo(current, checkedAt, 'network')
  }

  if (!res || typeof res.ok !== 'boolean') return emptyInfo(current, checkedAt, 'network')
  if (!res.ok) return emptyInfo(current, checkedAt, 'http')

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return emptyInfo(current, checkedAt, 'parse')
  }

  const entries = parseReleaseList(body)
  if (entries === null) return emptyInfo(current, checkedAt, 'parse')
  // 列表为空 = 仓库还没有已发布的正式版 → 不是错误，就是"没有更新"
  if (entries.length === 0) return emptyInfo(current, checkedAt, null)

  // 定 latest：按 compareVersions 取最大，**不信数组顺序**（API 是 created_at 倒序，
  // 补发的老版本 Release 可能排在前面）
  let newest = entries[0]
  for (const entry of entries) {
    if (compareVersions(entry.version, newest.version) > 0) newest = entry
  }

  const base: UpdateInfo = {
    current,
    latest: newest.version,
    hasUpdate: false,
    url: newest.htmlUrl,
    assetUrl: newest.assetUrl,
    publishedAt: newest.publishedAt,
    notes: null,
    checkedAt,
    error: null
  }

  // 已是最新（或本地版本更新）：没有可合并的区间
  if (compareVersions(newest.version, current) <= 0) return base

  const inRange = entries
    .filter(
      (entry) =>
        compareVersions(entry.version, current) > 0 &&
        compareVersions(entry.version, newest.version) <= 0
    )
    .sort((a, b) => compareVersions(b.version, a.version))

  // 理论上 inRange 至少含 newest 自身；空数组只可能出现在版本号畸形时
  if (inRange.length === 0) return base

  const capped = inRange.length > MAX_MERGED_VERSIONS
  const chosen = capped ? inRange.slice(0, MAX_MERGED_VERSIONS) : inRange
  // 条数提示也算进总预算：否则「10 条刚好 19990 字 + 提示」会越过 MAX_NOTES_CHARS，
  // 而这段字符串的契约是「绝不超 20000」（要过 IPC + 常驻渲染进程）
  const budget = capped ? MAX_NOTES_CHARS - MORE_VERSIONS_HINT.length : MAX_NOTES_CHARS
  const merged = joinBlocks(chosen.map(buildReleaseBlock), budget)

  return {
    ...base,
    hasUpdate: true,
    notes: capped ? `${merged}${MORE_VERSIONS_HINT}` : merged
  }
}
