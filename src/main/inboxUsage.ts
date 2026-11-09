/**
 * SketchUp 插件 → ID BOX 主程序「**使用记录**」回传的**发现**（主进程专用，只做 IO）。
 *
 * ## 事实底稿
 *
 * - 磁盘契约与判废规则：`src/shared/inboxUsage.ts`（纯逻辑、零依赖、可单测）
 * - 相邻通道（导出 / 更新）：`src/main/inbox.ts`，**本文件一行都不碰它**
 *
 * ## 本文件只做三件事
 *
 * 1. **扫描**：启动时把 `%APPDATA%\idbox_export\usage\` 里既有的记录读出来（{@link scanUsageDir}）；
 * 2. **发现**：运行期用**独立的** chokidar 只盯 `usage\` 目录（{@link startInboxUsageWatcher}）；
 * 3. **清理**：渲染层 ack 之后删掉那一个文件（{@link removeUsageFile}）。
 *
 * ## ⛔ 绝不在这里做业务
 *
 * 不读 Dexie、不累加计数、不判断资产是否存在 —— 主进程拿不到 IndexedDB，
 * 计数落库在渲染层。本文件只负责"把盘上的字节变成 `InboxUsageEvent` 交出去"。
 *
 * ## 为什么没有"派发重发定时器"（与 `inbox.ts` 的 `InboxDispatcher` 刻意不同）
 *
 * 收件箱的任务目录一旦搬走就没了，所以必须在渲染层没就绪时重发，否则任务永久丢失。
 * 使用记录**本身就是队列**：渲染层不 ack，文件就不删，下次启动扫描会再发一次。
 * 于是本通道的语义是"**进程内至多一次、跨启动至少一次**"：
 * - 进程内用 `dispatched` 集合去重（chokidar 的重复 `add` + 启动扫描撞车时不会发两条，
 *   否则同一次插入会被算成用过两次 —— 统计数字错了用户是无感且不可挽回的）；
 * - 跨启动靠"文件还在"兜底（渲染层崩了 / 窗口没建好 → 下次启动补上）。
 *
 * 代价（明写在契约里）：如果渲染层在**同一次运行内**处理失败又不 ack，
 * 这条记录要等到下次启动才会重试。使用统计是附属行为，这个延迟可接受；
 * 反过来说，多一个定时器就多一处"退出流程里还在 send"的风险（见 `inbox.ts` 的教训）。
 *
 * ## 为什么连 logger 都不直接 import
 *
 * `src/main/logger.ts` 顶部 `import { app } from 'electron'`。本文件要在
 * `environment: 'node'` 的 vitest 里被直接 import（`tests/inboxUsage.test.ts` 的 IO 用例），
 * 所以照 `src/main/inboxUpdate.ts` 的纪律：**只 import node:* 与不含 electron 的模块**，
 * 日志走调用方注入的 `warn` / `info`（缺省落 console）。真实接线在 `src/main/index.ts`。
 */

import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { INBOX_ROOT_DIR_NAME } from '../shared/inbox'
import {
  INBOX_USAGE_DIR_NAME,
  INBOX_USAGE_MAX_BYTES,
  isInboxUsageFileName,
  parseInboxUsage,
  type InboxUsageEntry,
  type InboxUsageEvent,
  type InboxUsageRecord
} from '../shared/inboxUsage'

// ── 路径（契约：%APPDATA%\idbox_export\usage\，与 %APPDATA%\idbox\ **同级**）──────

/**
 * `usage\` 目录的绝对路径：`<appData>\idbox_export\usage`。
 *
 * ⚠️ 调用方必须传 `app.getPath('appData')`（= `%APPDATA%` Roaming），**不是**
 * `getPath('userData')`：契约要求 `idbox_export\` 与 `idbox\` 同级，而 `userData`
 * 恰好就是 `%APPDATA%\idbox`。路径**由调用方注入**（本文件不 import electron），
 * 所以这里只是纯字符串拼接 + 一个空值兜底。
 *
 * `appData` 为空 / 非字符串 → 返回 `''`（**不猜路径**：拿不准就不写不读，
 * 与插件侧 `Paths.export_root` 的"APPDATA 缺失 ⇒ 推空串"同口径）。
 */
export function resolveInboxUsageDir(appData: string): string {
  if (typeof appData !== 'string') return ''
  const root = appData.trim()
  if (root.length === 0) return ''
  return path.join(root, INBOX_ROOT_DIR_NAME, INBOX_USAGE_DIR_NAME)
}

// ── 日志（注入；缺省落 console，绝不因为日志失败抛）──────────────────────────

/** 日志出口（`main/index.ts` 注入 `logWarn` / `logInfo`；测试里不注入走 console） */
export interface InboxUsageDeps {
  warn?: (message: string, context?: unknown) => void
  info?: (message: string, context?: unknown) => void
}

function warn(deps: InboxUsageDeps | undefined, message: string, context?: unknown): void {
  const sink = deps?.warn
  if (typeof sink === 'function') {
    try {
      sink(message, context)
      return
    } catch {
      /* 日志本身失败绝不能影响业务 */
    }
  }
  try {
    console.warn(`[inbox-usage] ${message}`, context ?? '')
  } catch {
    /* 同上 */
  }
}

function info(deps: InboxUsageDeps | undefined, message: string, context?: unknown): void {
  const sink = deps?.info
  if (typeof sink === 'function') {
    try {
      sink(message, context)
      return
    } catch {
      /* 同上 */
    }
  }
  try {
    console.info(`[inbox-usage] ${message}`, context ?? '')
  } catch {
    /* 同上 */
  }
}

// ── 单文件读取 ────────────────────────────────────────────────────────

/** 读一个文件的结果：`bad` 的 reason 只进日志（不进界面），保证"判废原因可查" */
type ReadUsageFileResult =
  | { ok: true; record: InboxUsageRecord }
  | { ok: false; reason: string }

/**
 * 读 + 校验 `usage\<fileName>` 这一个文件。
 *
 * 两层判废，理由不同：
 * - **大小层**（本函数）：超过 {@link INBOX_USAGE_MAX_BYTES} 或为 0 字节 —— 这个目录是
 *   外部进程可写的，不能假设文件大小，超限直接判废（不读进内存）；
 * - **形状层**（`parseInboxUsage`，纯函数）：字段缺失 / 版本不认 / id 形态非法。
 *
 * 永不抛：任何 IO 异常都翻译成 `{ ok:false, reason }`。
 */
async function readUsageFile(dir: string, fileName: string): Promise<ReadUsageFileResult> {
  const abs = path.join(dir, fileName)
  let text: string
  try {
    const st = await fs.stat(abs)
    if (!st.isFile()) return { ok: false, reason: '不是普通文件' }
    if (st.size === 0) return { ok: false, reason: '文件是空的（插件写入可能被中断）' }
    if (st.size > INBOX_USAGE_MAX_BYTES) {
      return {
        ok: false,
        reason: `文件异常大（${st.size} > ${INBOX_USAGE_MAX_BYTES} 字节），已丢弃`
      }
    }
    text = await fs.readFile(abs, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    return { ok: false, reason: `读取失败（${code ?? '未知错误'}）` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '不是合法 JSON（可能被截断）' }
  }
  return parseInboxUsage(raw)
}

// ── 扫描（启动时的一遍；也用于测试）──────────────────────────────────────

/** `scanUsageDir` 的结果 */
export interface ScanUsageDirResult {
  /** 通过校验的记录（顺序 = 目录遍历顺序，不保证稳定） */
  records: InboxUsageRecord[]
  /** 文件名合法但内容判废的文件（**不会被删** —— 见下方注释） */
  bad: string[]
  /**
   * `records` 与各自文件名配对后的形态（`records[i]` 与 `entries[i]` 同序）。
   *
   * 为什么要有这个字段：主进程要把 `{ fileName, record }` 发给渲染层（`fileName` 是
   * ack 回来删文件的唯一凭据），而 `records` 是纯记录。把 `fileName` 塞进
   * `InboxUsageRecord` 会污染"磁盘契约的形状"（那个结构必须与插件 JSON 逐字对应），
   * 所以单独给一份配对视图；`records` 保持契约形状不变。
   */
  entries: InboxUsageEntry[]
}

/**
 * 扫一遍 `usage\` 目录（**幂等、永不抛**）。
 *
 * 三种输入形态：
 * - 目录不存在 → 返回空结果。这是**首次使用时的正常形态**（用户还没插过任何模型），
 *   不是错误，绝不记 error、绝不抛；
 * - 目录里全是别人的文件（`.tmp` / `desktop.ini` / 用户的杂项）→ 一律忽略，只处理
 *   文件名为合法 `YYYYMMDD-HHmmss-<4位随机>.json` 的那些；
 * - 名字合法但内容坏 → 进 `bad`，**留在盘上不删**：删掉就把"插件侧契约漂移"的证据
 *   一起删了，而这个文件只有几十字节，留着下次启动再判废一次的代价远小于失去现场。
 */
export async function scanUsageDir(
  dir: string,
  deps?: InboxUsageDeps
): Promise<ScanUsageDirResult> {
  const empty: ScanUsageDirResult = { records: [], bad: [], entries: [] }
  if (typeof dir !== 'string' || dir.trim().length === 0) return empty

  let listing: Dirent[]
  try {
    listing = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    // ENOENT = 目录还不存在（首次使用），属正常；其余（EACCES 等）只 warn
    if (code !== 'ENOENT') warn(deps, 'inbox:usage:scan:readdir-failed', { dir, code: code ?? null })
    return empty
  }

  const records: InboxUsageRecord[] = []
  const bad: string[] = []
  const entries: InboxUsageEntry[] = []

  for (const item of listing) {
    // 只认普通文件：目录 / 符号链接 / 特殊文件一律不碰（这个目录是外部可写的）
    if (!item.isFile()) continue
    const fileName = item.name
    if (!isInboxUsageFileName(fileName)) continue

    const read = await readUsageFile(dir, fileName)
    if (!read.ok) {
      bad.push(fileName)
      warn(deps, 'inbox:usage:scan:rejected', { fileName, reason: read.reason })
      continue
    }
    records.push(read.record)
    entries.push({ fileName, record: read.record })
  }

  info(deps, 'inbox:usage:scan', { dir, ok: records.length, bad: bad.length, total: listing.length })
  return { records, bad, entries }
}

// ── 删除（ack 的真实动作）───────────────────────────────────────────────

/**
 * 删掉**一个**使用记录文件。
 *
 * 返回值语义：
 * - `true`：文件已经不在了（删成功，或本来就不在 —— ENOENT 算成功，**幂等**：
 *   渲染层重复 ack / 上一轮已删，都不算错误）；
 * - `false`：文件名不合法（**防路径注入**：渲染层被注入后不能拿这个通道删任意文件），
 *   或其它 IO 错误（占用 / 权限）。**永不抛**。
 *
 * ⚠️ `dir` 只由调用方（主进程）算，渲染层能影响的**只有** `fileName`，而它必须过
 * `isInboxUsageFileName`（单段、无分隔符）。这是本通道唯一的安全边界，不要放松。
 */
export async function removeUsageFile(
  dir: string,
  fileName: string,
  deps?: InboxUsageDeps
): Promise<boolean> {
  if (typeof dir !== 'string' || dir.trim().length === 0) return false
  if (!isInboxUsageFileName(fileName)) {
    warn(deps, 'inbox:usage:remove:rejected', { fileName: String(fileName), hint: '文件名不过正则' })
    return false
  }
  const abs = path.join(dir, fileName)
  // 双保险：正则已保证单段无分隔符，这里再确认解析后仍在 dir 之内
  const resolvedDir = path.resolve(dir)
  if (path.dirname(path.resolve(abs)) !== resolvedDir) {
    warn(deps, 'inbox:usage:remove:outside', { fileName, abs })
    return false
  }

  try {
    await fs.unlink(abs)
    info(deps, 'inbox:usage:removed', { fileName })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return true
    warn(deps, 'inbox:usage:remove:failed', { fileName, code: code ?? null })
    return false
  }
}

// ── 派发（进程内至多一次）──────────────────────────────────────────────

/**
 * 本次进程内已经 send 过的文件名。
 *
 * 存在理由：同一条记录有**两条**到达路径 —— 启动扫描（`dispatchStoredInboxUsage`）
 * 与 chokidar 的 `add`（`startInboxUsageWatcher`），两者必然撞车（先起 watcher 再扫描
 * 是刻意的顺序，见 `startInboxUsageWatcher` 注释）。chokidar 自己也可能对同一个
 * `add` 事件重复回调（Windows 上 rename 落地的观察者抖动）。
 *
 * 撞车的后果不是"多发一条日志"，而是**用户的使用次数被多算一次**：
 * 统计数字错得无感、且无法追溯。所以进程内必须去重。
 *
 * 集合只在进程内有效（重启即清空）—— 跨启动的"至少一次"由文件本身兜底。
 * 文件被 ack 删除后**不从集合里移除**：同一个 fileName 不可能再出现第二次
 * （jobId 含秒级时间戳 + 随机段），留着可以让"删除后又冒出来"的异常形态也被挡住。
 */
const dispatched = new Set<string>()

function dispatchEntry(entry: InboxUsageEntry, send: (ev: InboxUsageEvent) => void): boolean {
  if (dispatched.has(entry.fileName)) return false
  dispatched.add(entry.fileName)
  try {
    send({ fileName: entry.fileName, record: entry.record })
    return true
  } catch {
    // send 抛了（窗口正在销毁）：撤销标记，让下一次扫描还有机会发出去
    dispatched.delete(entry.fileName)
    return false
  }
}

/**
 * 启动扫描 + 逐条交给渲染层（`main/index.ts` 在 `whenReady` 里调一次）。
 *
 * 渲染层此刻可能还没订阅（`webContents.send` 会静默丢弃）—— 这不要紧：
 * 文件没被 ack 就不会被删，下次启动会再发。**不要**为了这个加定时器（见文件头）。
 *
 * 单次派发上限 {@link MAX_DISPATCH_PER_SCAN}：极端情况（用户装了旧版渲染层、
 * 攒了几千条）下不能一口气把 IPC 打满；超出部分这次不发，留在盘上等下次。
 * 因为 `dispatched` 只标记"真正发出去的那些"，未发的下次还会被扫到。
 */
export const MAX_DISPATCH_PER_SCAN = 500

export async function dispatchStoredInboxUsage(
  dir: string,
  send: (ev: InboxUsageEvent) => void,
  deps?: InboxUsageDeps
): Promise<{ sent: number; bad: number; skipped: number }> {
  const scan = await scanUsageDir(dir, deps)
  let sent = 0
  let skipped = 0
  for (const entry of scan.entries) {
    if (sent >= MAX_DISPATCH_PER_SCAN) {
      skipped += 1
      continue
    }
    if (dispatchEntry(entry, send)) sent += 1
    else skipped += 1
  }
  if (skipped > 0) {
    warn(deps, 'inbox:usage:dispatch:skipped', {
      dir,
      skipped,
      hint: '超出单次上限或本次进程已发过；文件仍在盘上，下次启动会再扫到'
    })
  }
  if (sent > 0) info(deps, 'inbox:usage:dispatch', { dir, sent, bad: scan.bad.length })
  return { sent, bad: scan.bad.length, skipped }
}

// ── 监听（独立的 watcher，与 `inbox.ts` 的 incoming watcher 完全无关）────────────

/** 监听句柄（`main/index.ts` 在 `will-quit` 里 close） */
export interface InboxUsageWatchHandle {
  /** 是否真的起来了：`false` = 目录建不出来 / chokidar 起不来（启动扫描仍在，不影响主流程） */
  active: boolean
  close: () => Promise<void>
}

/** 空句柄（起不来时返回它，调用方无需判空） */
function noopHandle(): InboxUsageWatchHandle {
  return {
    active: false,
    close: () => Promise.resolve()
  }
}

/** 当前 watcher（模块内单例；重复 start 会先关掉旧的） */
let watcher: FSWatcher | null = null

/**
 * 起使用记录的监听（**独立 watcher，绝不与 `inbox.ts` 的 `incoming\` watcher 共用**）。
 *
 * 口径：
 * - 只盯 `usage\` 一个目录，`depth: 1`（文件是它的直接子项，多一层都不需要；
 *   层级给小了的表现是**整个功能静默失效**，所以这里按"文件就在根下"精确取值，
 *   由 `add` 回调里的文件名正则做第二道过滤）；
 * - `ignoreInitial: true`：存量由 `dispatchStoredInboxUsage` 负责，避免同一次启动
 *   两条路径重复派发（`dispatched` 集合是第二道保险）；
 * - **不设 `awaitWriteFinish`**：插件是 `.tmp` → `rename` 原子写，`.json` 出现即完整；
 *   而 `.tmp` 根本过不了文件名正则，所以也不会读到半截文件；
 * - 只认 `add`：`change` / `unlink` 一律不理（一条记录写完就不会再变；
 *   删除是我们自己 ack 造成的，回调里什么都不该做）。
 *
 * ⚠️ 顺序：**先建 watcher 再扫存量**（与 `inbox.ts:startInboxWatcher` 同款）——
 * 反过来的话，两步之间的那次插入会漏（扫描已经走完，watcher 还没开始听）。
 *
 * 起不来（目录建不出、权限不足）只 warn 后放弃：使用统计绝不能把启动流程搞挂。
 */
export async function startInboxUsageWatcher(
  dir: string,
  send: (ev: InboxUsageEvent) => void,
  deps?: InboxUsageDeps
): Promise<InboxUsageWatchHandle> {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    warn(deps, 'inbox:usage:watch:no-dir', { hint: '未注入 appData，跳过监听（启动扫描同样跳过）' })
    return noopHandle()
  }

  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    warn(deps, 'inbox:usage:mkdir-failed', { dir, code: code ?? null })
    return noopHandle()
  }

  // 重复 start：先停旧的，避免两个 watcher 同时往同一个渲染层发
  await stopInboxUsageWatcher()

  let handle: FSWatcher
  try {
    handle = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 1
    })
  } catch (err) {
    warn(deps, 'inbox:usage:watch:failed', {
      dir,
      err: err instanceof Error ? err.message : String(err)
    })
    return noopHandle()
  }
  watcher = handle

  const resolvedRoot = path.resolve(dir)
  handle.on('add', (p: string) => {
    const fileName = path.basename(p)
    if (!isInboxUsageFileName(fileName)) return // `.tmp` / 杂项：静默忽略
    // 只处理目录直属文件（depth:1 已经保证，这里再确认一次，避免未来调 depth 时误收子目录）
    if (path.dirname(path.resolve(p)) !== resolvedRoot) return
    void (async () => {
      try {
        const read = await readUsageFile(dir, fileName)
        if (!read.ok) {
          warn(deps, 'inbox:usage:watch:rejected', { fileName, reason: read.reason })
          return
        }
        dispatchEntry({ fileName, record: read.record }, send)
      } catch (err) {
        // watcher 回调是 `void` 调用的，绝不允许抛成 unhandledRejection
        warn(deps, 'inbox:usage:watch:threw', {
          fileName,
          err: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  })
  handle.on('error', (err: unknown) => {
    // 监听出错不致命：启动扫描仍在，下一次启动也能补上
    warn(deps, 'inbox:usage:watch:error', {
      dir,
      err: err instanceof Error ? err.message : String(err)
    })
  })

  info(deps, 'inbox:usage:watcher:started', { dir })
  return {
    active: true,
    close: async () => {
      if (watcher !== null) {
        const current = watcher
        watcher = null
        await current.close().catch(() => undefined)
      }
    }
  }
}

/** 停监听（退出 / 重启时调用）。幂等、永不抛。 */
export async function stopInboxUsageWatcher(): Promise<void> {
  if (watcher === null) return
  const current = watcher
  watcher = null
  try {
    await current.close()
  } catch {
    /* 退出流程里关不掉监听不值得打扰任何人 */
  }
}
