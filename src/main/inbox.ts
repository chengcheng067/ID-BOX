/**
 * SketchUp 插件 → ID BOX 主程序「收件箱」的**发现 + 搬运**（主进程专用）。
 *
 * ## 事实底稿
 *
 * `docs/probe/su-export-to-idbox.md` §推荐方案 A / §风险 R7（job 永不被消费）。
 * 用户口径：`docs/48-V1.0拍板台账-20261109.md` §7。
 *
 * ## 本文件只做两件事
 *
 * 1. **发现**：启动扫一遍 `incoming\`、运行期用 chokidar 盯 `manifest.json` 的出现；
 * 2. **搬运**：ack 之后把 `incoming\<jobId>\` 整目录挪到 `done\<jobId>\` /
 *    `failed\<jobId>\`（**绝不删除** —— 留给用户排查，见勘察 §推荐方案最后一行）。
 *
 * ⛔ **绝不在这里读 Dexie / 绝不落库**：主进程拿不到 IndexedDB，导入与分类一律由
 * 渲染层走既有通道（create → `importPaths`；update → `inboxApplyUpdate`）。
 *
 * ## 为什么 manifest.json 一出现就可以信
 *
 * 插件**最后**写 manifest，且是 `.tmp` → `rename`（同目录同卷原子）。所以只要看到
 * `manifest.json` 这个名字存在，同目录的 `.skp` / `.cover.png` 必然已经写完、关闭。
 * 这就是"不需要 awaitWriteFinish 等 3 秒"的依据（与 `watcher.ts` 的下载目录监控不同：
 * 那里浏览器是边下边写，名字先出现、内容后到）。
 *
 * ## 为什么派发要重试（`InboxDispatcher`）
 *
 * 主进程 `webContents.send` 在渲染层还没注册监听时会**静默丢弃**（没有队列、没有回执）。
 * 启动扫描恰好跑在窗口刚建、`store.init()` 还没订阅的那一刻 —— 只发一次就会丢。
 * 但"等页面就绪再发"没有任何可靠信号可用（`did-finish-load` 早于 React 的 init）。
 *
 * 所以采用 **at-least-once + 渲染层按 jobId 去重**：每 3 秒重发一次，直到收到
 * `inbox:ack`（`settleInboxJob`）才停；上限 40 次（约 2 分钟）后放弃并记 warn
 * （任务目录仍在 `incoming\`，下次启动会再扫到）。渲染层 `consumeInboxJob` 对
 * 同一 jobId 只处理一次、重复到达时补一次 ack —— 重发是安全的。
 * 这样不需要为"页面就绪"新增第四条 IPC 通道（契约里只有 1 事件 + 2 handle）。
 */

import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logError, logInfo, logWarn } from './logger'
import { moveDir, pathExists } from './fsutil'
import {
  INBOX_API_VERSION,
  INBOX_DONE_DIR_NAME,
  INBOX_FAILED_DIR_NAME,
  INBOX_INCOMING_DIR_NAME,
  INBOX_MANIFEST_FILE,
  INBOX_MANIFEST_MAX_BYTES,
  INBOX_MAX_REASON_LEN,
  INBOX_ORPHAN_MAX_AGE_MS,
  INBOX_ROOT_DIR_NAME,
  isIgnoredInboxPath,
  isInboxJobId,
  isInboxManifestFileName,
  parseInboxManifest,
  type InboxAckPayload,
  type InboxAckResult,
  type InboxJob
} from '../shared/inbox'

// ── 路径（契约：%APPDATA%\idbox_export\，与 %APPDATA%\idbox\ **同级**）─────────

/**
 * 收件箱根目录。
 *
 * ⚠️ 用 `app.getPath('appData')`（= `%APPDATA%` Roaming）而**不是** `getPath('userData')`：
 * 契约要求 `idbox_export\` 与 `idbox\` **同级**，而 `userData` 恰好就是 `%APPDATA%\idbox`。
 * 拼成 `userData + '..\\idbox_export'` 也可以，但那是靠字符串抵消，改名即断。
 */
export function inboxRootDir(): string {
  return path.join(app.getPath('appData'), INBOX_ROOT_DIR_NAME)
}

export function inboxIncomingDir(): string {
  return path.join(inboxRootDir(), INBOX_INCOMING_DIR_NAME)
}

export function inboxDoneDir(): string {
  return path.join(inboxRootDir(), INBOX_DONE_DIR_NAME)
}

export function inboxFailedDir(): string {
  return path.join(inboxRootDir(), INBOX_FAILED_DIR_NAME)
}

// ── 单个任务的读取 + 校验（manifest 形状 + 文件是否真的在盘上）──────────────

export type InboxJobReadResult = { ok: true; job: InboxJob } | { ok: false; reason: string }

/** 文件存在、是普通文件、且非空（0 字节的 `.skp` / 半截 PNG 一定是导出失败） */
async function isNonEmptyFile(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/**
 * 读一个任务目录并做**完整校验**（manifest 严格模式 + 交付文件真实性）。
 *
 * 校验分两层，理由不同：
 * - 形状层（`parseInboxManifest`，纯函数）：字段缺失 / 版本不认 / 路径形态非法；
 * - 文件层（本函数）：manifest 说的文件必须**真的在盘上**。插件崩在写 `.skp` 的中途、
 *   或用户手动清了目录里的 `.skp`，都会命中这一层。
 *
 * ⚠️ `manifest.skp` / `manifest.cover` 已在形状层保证是**单段文件名**，所以
 * `path.join(jobDir, name)` 不可能穿出任务目录；这里不再重复做包含判定（做了也是死代码，
 * 反而会让后人以为"这里挡得住，别处可以放松"）。
 */
export async function readInboxJob(jobDir: string): Promise<InboxJobReadResult> {
  const absDir = path.resolve(jobDir)
  const jobId = path.basename(absDir)
  if (!isInboxJobId(jobId)) {
    return { ok: false, reason: `任务目录名「${jobId}」不是合法的 jobId（应形如 20261109-184000-ab12）` }
  }

  const manifestAbs = path.join(absDir, INBOX_MANIFEST_FILE)
  let text: string
  try {
    const st = await fs.stat(manifestAbs)
    if (!st.isFile()) return { ok: false, reason: 'manifest.json 不是普通文件' }
    if (st.size > INBOX_MANIFEST_MAX_BYTES) {
      return { ok: false, reason: `manifest.json 异常大（${st.size} 字节），已丢弃` }
    }
    if (st.size === 0) return { ok: false, reason: 'manifest.json 是空文件（插件写入可能被中断）' }
    text = await fs.readFile(manifestAbs, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { ok: false, reason: '任务目录里没有 manifest.json（导出可能被中断）' }
    return { ok: false, reason: `读取 manifest.json 失败（${code ?? '未知错误'}）` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'manifest.json 不是合法 JSON（可能被截断）' }
  }

  const parsed = parseInboxManifest(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const manifest = parsed.manifest

  const skpAbs = path.join(absDir, manifest.skp)
  if (!(await isNonEmptyFile(skpAbs))) {
    return { ok: false, reason: `交付的 skp 不存在或为空：${manifest.skp}` }
  }

  let coverAbs: string | null = null
  if (manifest.cover) {
    const c = path.join(absDir, manifest.cover)
    if (!(await isNonEmptyFile(c))) return { ok: false, reason: `交付的封面不存在或为空：${manifest.cover}` }
    coverAbs = c
  }

  return { ok: true, job: { jobId, jobDir: absDir, skpPath: skpAbs, coverPath: coverAbs, manifest } }
}

// ── 派发器（at-least-once + 渲染层按 jobId 去重）───────────────────────────

/** 重发间隔（毫秒）：够用户看清一条 toast，又不会把 IPC 打爆 */
const DISPATCH_RETRY_MS = 3000
/** 重发上限（40 × 3s ≈ 2 分钟）：超过就不再打扰，任务留在 incoming 等下次启动 */
const DISPATCH_MAX_ATTEMPTS = 40

interface PendingDispatch {
  job: InboxJob
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

const pendingDispatches = new Map<string, PendingDispatch>()
/** 正在做 IO 校验的任务目录（chokidar 的重复 add + 启动扫描可能同时命中同一个目录） */
const validating = new Set<string>()
/** 发送回调（`main/index.ts` 注入：`win.webContents.send(IPC.inboxJob, job)`） */
let sender: ((job: InboxJob) => void) | null = null

function sendNow(job: InboxJob): void {
  try {
    sender?.(job)
  } catch (err) {
    logWarn('inbox:dispatch:send-failed', {
      jobId: job.jobId,
      err: err instanceof Error ? err.message : String(err)
    })
  }
}

function scheduleRetry(jobId: string): void {
  const entry = pendingDispatches.get(jobId)
  if (!entry) return
  const timer = setTimeout(() => {
    const cur = pendingDispatches.get(jobId)
    if (!cur) return
    if (cur.attempts >= DISPATCH_MAX_ATTEMPTS) {
      pendingDispatches.delete(jobId)
      logWarn('inbox:dispatch:give-up', {
        jobId,
        attempts: cur.attempts,
        hint: '界面可能一直没就绪；任务目录仍在 incoming，下次启动会再扫到'
      })
      return
    }
    cur.attempts += 1
    sendNow(cur.job)
    scheduleRetry(jobId)
  }, DISPATCH_RETRY_MS)
  // 定时器不该把进程吊在退出流程上
  timer.unref?.()
  entry.timer = timer
}

function enqueueDispatch(job: InboxJob): void {
  if (pendingDispatches.has(job.jobId)) return
  const entry: PendingDispatch = { job, attempts: 1, timer: null }
  pendingDispatches.set(job.jobId, entry)
  logInfo('inbox:job:dispatch', {
    jobId: job.jobId,
    op: job.manifest.op,
    name: job.manifest.name,
    targetRelFolder: job.manifest.targetRelFolder,
    hasCover: job.coverPath !== null,
    pluginVersion: job.manifest.pluginVersion
  })
  sendNow(job)
  scheduleRetry(job.jobId)
}

/** 渲染层 ack 之后调用：停止重发（任务目录已经被搬走，重发只会让渲染层空 ack 一次） */
export function settleInboxJob(jobId: string): void {
  const entry = pendingDispatches.get(jobId)
  if (!entry) return
  if (entry.timer !== null) clearTimeout(entry.timer)
  pendingDispatches.delete(jobId)
}

// ── done\ 的保留期清理（启动扫一次，无常驻计时器）──────────────────────────

/**
 * `done\<jobId>\` 的保留天数。
 *
 * 为什么必须有保留期：每个 job 目录里都躺着一份完整的 `.skp`（几十 MB 很常见），
 * 而归档是"只 move 不删"—— 不清的话 `%APPDATA%\idbox_export\done` 会随每次导出
 * 线性增长，一年后能吃掉几个 GB 的 C 盘。30 天足够用户回头查"我什么时候导过这个模型"，
 * 又不会无限堆。
 */
export const INBOX_DONE_RETENTION_DAYS = 30

/**
 * 清理 `done\` 里超过保留期的任务目录。
 *
 * ⚠️ **只在启动时扫一次**（`startInboxWatcher` 调用），不挂常驻计时器：
 * 收件箱是低频通道（一天几次导出），为它养一个定时器不值当，而且定时器在
 * 退出流程里还要额外收尾。
 *
 * ⚠️ **不清理 `failed\`**：那是排查凭据（目录里有 `error.txt` + 原始交付文件），
 * 用户/我们可能过一个月才回头看这条失败的导出。失败的次数本该远少于成功，
 * 增长风险可接受 —— 若真出现"失败风暴"，`failed\` 里的目录名本身就是线索。
 *
 * 幂等、永不抛（权限 / 占用失败只记 warn）。用 `mtimeMs` 判老：目录内容搬进来之后
 * 就不会再被改，mtime 就是"归档时刻"。
 */
export async function sweepInboxDoneArchive(
  retentionDays: number = INBOX_DONE_RETENTION_DAYS
): Promise<{ removed: number; kept: number; bytes: number }> {
  const done = inboxDoneDir()
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  let entries: Dirent[]
  try {
    entries = await fs.readdir(done, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT') logWarn('inbox:sweep:readdir-failed', { done, code: code ?? null })
    return { removed: 0, kept: 0, bytes: 0 }
  }

  let removed = 0
  let kept = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(done, entry.name)
    const st = await fs.stat(dir).catch(() => null)
    if (!st) continue
    if (st.mtimeMs > cutoff) {
      kept += 1
      continue
    }
    const size = await dirSize(dir).catch(() => 0)
    try {
      await fs.rm(dir, { recursive: true, force: true })
      removed += 1
      bytes += size
    } catch (err) {
      logWarn('inbox:sweep:rm-failed', {
        dir,
        code: (err as NodeJS.ErrnoException | null)?.code ?? null
      })
    }
  }
  if (removed > 0) logInfo('inbox:sweep', { done, retentionDays, removed, kept, bytes })
  return { removed, kept, bytes }
}

/** 递归统计目录字节数（清理埋点用；失败返回 0，绝不影响清理本身） */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(abs)
    else {
      const st = await fs.stat(abs).catch(() => null)
      if (st) total += st.size
    }
  }
  return total
}

// ── 归档（ack 的真实动作）──────────────────────────────────────────────

/** `baseDir` 里给我一个不冲突的目录名：`<jobId>` → `<jobId>-2` → `<jobId>-3`… */
async function uniqueArchivePath(baseDir: string, jobId: string): Promise<string> {
  let candidate = path.join(baseDir, jobId)
  let n = 2
  while (await pathExists(candidate)) {
    candidate = path.join(baseDir, `${jobId}-${n}`)
    n += 1
    if (n > 999) break
  }
  return candidate
}

/**
 * 把 `incoming\<jobId>\` 整目录搬到 `done\` / `failed\`。
 *
 * 语义细节：
 * - 源目录已不存在 → `{ ok: true, archivedTo: null }`（**幂等**：渲染层重复 ack、
 *   或上一轮已经搬过，都不算错误）；
 * - 失败时先在任务目录**内**写 `error.txt`（人类可读中文原因）再整体搬走 ——
 *   写在搬走之前，`error.txt` 才能跟着目录一起进 `failed\`；
 * - 目标重名 → 追加 `-2`（同一个 jobId 被复用 / 两次 ack 的极端情形）；
 * - **绝不 rm**：即使搬运失败也把目录留在 `incoming\`，下次启动重试。
 */
export async function archiveInboxJob(jobId: string, ok: boolean, reason = ''): Promise<InboxAckResult> {
  if (!isInboxJobId(jobId)) {
    return { ok: false, archivedTo: null, reason: '任务编号不合法' }
  }
  const src = path.join(inboxIncomingDir(), jobId)
  if (!(await pathExists(src))) {
    return { ok: true, archivedTo: null }
  }

  const baseDir = ok ? inboxDoneDir() : inboxFailedDir()
  try {
    await fs.mkdir(baseDir, { recursive: true })
  } catch (err) {
    logError('inbox:archive:mkdir-failed', err, { baseDir })
    return { ok: false, archivedTo: null, reason: '无法创建归档目录' }
  }

  if (!ok) {
    const text =
      [
        `时间：${new Date().toISOString()}`,
        `任务：${jobId}`,
        `结果：失败，已在 ID BOX 中跳过`,
        `原因：${reason || '未知（渲染层没有给出原因）'}`,
        '',
        '这个目录是原样保留的（skp / 封面 / manifest 都还在），排查完可以直接删除。'
      ].join('\n') + '\n'
    // 写失败不影响搬运：error.txt 只是给用户看的辅助信息
    await fs.writeFile(path.join(src, 'error.txt'), text, 'utf-8').catch(() => {})
  }

  const dest = await uniqueArchivePath(baseDir, jobId)
  try {
    await moveDir(src, dest)
  } catch (err) {
    logError('inbox:archive:move-failed', err, { jobId, dest })
    return { ok: false, archivedTo: null, reason: '目录搬运失败（可能被其他程序占用）' }
  }

  logInfo('inbox:archive', { jobId, archivedTo: ok ? 'done' : 'failed', dest })
  return { ok: true, archivedTo: ok ? 'done' : 'failed' }
}

/**
 * `IPC.inboxAck` 的实现。
 *
 * ⚠️ 无论 `ok` 真假都**先 `settleInboxJob`**：渲染层已经处理完了（成功或失败），
 * 继续重发只会让它反复走"已处理过 → 补一个 ack"的空转分支。
 */
export async function ackInboxJob(payload: unknown): Promise<InboxAckResult> {
  const raw = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<InboxAckPayload>
  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : ''
  if (!isInboxJobId(jobId)) {
    return { ok: false, archivedTo: null, reason: '任务编号不合法' }
  }
  const ok = raw.ok === true
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, INBOX_MAX_REASON_LEN) : ''
  settleInboxJob(jobId)
  return archiveInboxJob(jobId, ok, reason)
}

// ── 发现（启动扫描 + chokidar）─────────────────────────────────────────

/** 一次目录处理的结果（只用于日志 / 计数） */
type JobDirOutcome = 'dispatched' | 'discarded' | 'skipped'

async function handleJobDir(jobDir: string): Promise<JobDirOutcome> {
  const key = path.resolve(jobDir)
  if (validating.has(key)) return 'skipped'
  validating.add(key)
  try {
    const r = await readInboxJob(jobDir)
    if (!r.ok) {
      // 形状不对 → 直接判废并搬进 failed（带 error.txt），别让它一直躺在 incoming 里
      logWarn('inbox:job:rejected', { jobDir, reason: r.reason })
      await archiveInboxJob(path.basename(key), false, r.reason)
      return 'discarded'
    }
    if (pendingDispatches.has(r.job.jobId)) return 'skipped'
    enqueueDispatch(r.job)
    return 'dispatched'
  } catch (err) {
    // 兜底：本函数被 `void` 调用（watcher 回调 / 扫描），绝不允许抛成 unhandledRejection
    logError('inbox:job:threw', err, { jobDir })
    return 'skipped'
  } finally {
    validating.delete(key)
  }
}

/**
 * 启动扫描 `incoming\`（幂等，可重复调用）。
 *
 * 三种目录形态：
 * - 有 manifest → 立即校验 + 派发（插件写完时主程序没开，攒到现在的任务）；
 * - 无 manifest 且**超过 24 小时**没动过 → 判废搬 `failed\`（插件写一半崩了 / 主程序
 *   在写过程中被关掉）；
 * - 无 manifest 但很新 → **不动它**（插件可能正在写这个任务；判废会把它从
 *   `incoming\` 里搬走，插件随后 rename 进来的 manifest 就永远没人看了）；
 * - 目录名不是合法 jobId → 只记 warn 跳过（不碰外来目录）。
 */
export async function scanInboxIncoming(): Promise<{
  dispatched: number
  discarded: number
  waiting: number
}> {
  const incoming = inboxIncomingDir()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(incoming, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT') logWarn('inbox:scan:readdir-failed', { incoming, code: code ?? null })
    return { dispatched: 0, discarded: 0, waiting: 0 }
  }

  let dispatched = 0
  let discarded = 0
  let waiting = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const jobId = entry.name
    if (!isInboxJobId(jobId)) {
      logWarn('inbox:scan:skip-foreign-dir', { name: jobId, hint: '不是 jobId 形态的目录一律不碰' })
      continue
    }
    const dir = path.join(incoming, jobId)
    if (!(await pathExists(path.join(dir, INBOX_MANIFEST_FILE)))) {
      const st = await fs.stat(dir).catch(() => null)
      const age = st ? Date.now() - st.mtimeMs : 0
      if (st && age > INBOX_ORPHAN_MAX_AGE_MS) {
        await archiveInboxJob(
          jobId,
          false,
          '任务目录里没有 manifest.json（超过 24 小时未完成，判为中断的导出），文件已原样保留'
        )
        discarded += 1
      } else {
        waiting += 1
      }
      continue
    }
    const outcome = await handleJobDir(dir)
    if (outcome === 'discarded') discarded += 1
    else if (outcome === 'dispatched') dispatched += 1
    else waiting += 1
  }

  logInfo('inbox:scan', { incoming, total: entries.length, dispatched, discarded, waiting })
  return { dispatched, discarded, waiting }
}

/** chokidar 实例（`incoming\` 一个就够：任务目录是它的直接子目录） */
let watcher: FSWatcher | null = null

/**
 * 起收件箱监听（先建 watcher 再扫存量，两次都靠 `pendingDispatches` / `validating` 去重）。
 *
 * 监听口径（与 `watcher.ts` 的下载目录监控刻意不同）：
 * - `depth: 3`：只需要 `incoming\<jobId>\manifest.json` 这一层（给到 3 是留余量 ——
 *   给小了的表现是**整个功能静默失效**：manifest 事件永远不来）；
 * - `ignoreInitial: true`：存量由 `scanInboxIncoming` 负责，避免同一次启动两条路径重复派发；
 * - **不设 `awaitWriteFinish`**：manifest 是 `.tmp` → rename 原子写，出现即完整（见文件头）；
 * - 只认 `manifest.json` 的 `add`：`change` / `unlink` 一律不理（`.skp` 写完不会变）。
 */
export async function startInboxWatcher(send: (job: InboxJob) => void): Promise<void> {
  const incoming = inboxIncomingDir()
  try {
    await fs.mkdir(incoming, { recursive: true })
  } catch (err) {
    // 建不出来不致命（只读盘 / 权限）：监听会失败，但主程序必须照常启动
    logWarn('inbox:incoming:mkdir-failed', {
      incoming,
      code: (err as NodeJS.ErrnoException | null)?.code ?? null
    })
  }

  // ⚠️ 顺序：先停旧的（stopInboxWatcher 会把 sender 清成 null），再挂新的 sender
  stopInboxWatcher()
  sender = send

  const rootResolved = path.resolve(incoming)
  watcher = chokidar.watch(incoming, {
    ignoreInitial: true,
    // 层级：incoming(被监听根) → <jobId>(1) → manifest.json(2)；给到 3 留一层余量。
    // 给小了的表现是**整个功能静默失效**（manifest 事件永远不来），所以宁大勿小。
    depth: 3,
    ignored: (p: string) => {
      // chokidar 会对**被监听根自身**也问一次 ignored；根被判忽略 = 什么都没监听到
      if (path.resolve(p) === rootResolved) return false
      return isIgnoredInboxPath(p)
    }
  })
  watcher.on('add', (p: string) => {
    if (!isInboxManifestFileName(path.basename(p))) return
    void handleJobDir(path.dirname(p))
  })
  watcher.on('error', (err: unknown) => {
    // 监听失败不致命：启动扫描仍在，下一次启动也能收下任务
    logWarn('inbox:watch:error', { err: err instanceof Error ? err.message : String(err) })
  })

  await scanInboxIncoming()
  // done\ 保留期清理：**只在启动时扫一次**（见 `sweepInboxDoneArchive` 头注）
  void sweepInboxDoneArchive()
  logInfo('inbox:watcher:started', { incoming, apiVersion: INBOX_API_VERSION })
}

/** 停监听（退出 / 重启时调用；挂起的派发重发一并停掉，避免退出过程中还在 send） */
export function stopInboxWatcher(): void {
  if (watcher !== null) {
    void watcher.close()
    watcher = null
  }
  for (const [jobId, entry] of pendingDispatches) {
    if (entry.timer !== null) clearTimeout(entry.timer)
    pendingDispatches.delete(jobId)
  }
  sender = null
}
