import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, type NativeImage } from 'electron'
import fs from 'node:fs/promises'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_SETTINGS,
  type AiClassifyPayload,
  type AiClassifySettings,
  type AssignCategoryPayload,
  type AssignCategoryResult,
  type Asset,
  type FetchZhimoCoverPayload,
  type FetchZhimoCoverResult,
  type ImportConflictAnswer,
  type ImportConflictAsk,
  type ImportConflictContext,
  type ImportEvent,
  type LogExportResult,
  type MergeMaterialAssetRef,
  type MergeMaterialPayload,
  type RendererLogPayload,
  type RenameFolderPlanItem,
  type SaveBallThumbPayload,
  type SetCoverImagePayload,
  type Settings,
  type TrashPurgeItem,
  type TrashRestoreItem,
  type TrashSoftDeleteItem,
  TRASH_RETENTION_DAYS,
  type UpdateInfo
} from '../shared/types'
import { loadSettings, normalizeAiClassify, normalizeSettings, saveSettings } from './settings'
import {
  exportLogsTo,
  flushLogsSync,
  initLogger,
  logDebug,
  logDir,
  logError,
  logExportFileName,
  logFromRenderer,
  logInfo,
  logStats,
  logWarn,
  setVerboseLogging
} from './logger'
import {
  AI_CLASSIFY_MAX_NAMES,
  aiClassifyDetailed,
  testAiConnection
} from './aiClassify'
import { findSevenZip, thumbsDir } from './paths'
import { fetchLatestRelease } from './updateCheck'
import { freeBytesOf } from './disk'
import { deleteThumb, deleteOneThumb, ensureThumb, clearThumbs, listThumbFiles, pruneThumbs, thumbStats } from './thumb'
import { MAX_COVER_IMAGE_BYTES, writeCoverImageInto } from './coverImage'
import {
  refreshZhimoCoverInto,
  zhimoCoverFailLogContext,
  type ZhimoAttemptFailure
} from './zhimoCover'
import {
  MAX_BALL_IMAGE_BYTES,
  saveBallThumbBytes,
  validateBallImageBase64
} from './ballThumb'
import { applyLayoutMigration, moveAssetCategory, planLayoutMigration } from './layout'
import {
  detectMaterialMerge,
  manifestDirOf,
  mergeMaterial,
  rollbackMaterialMerge
} from './materialMerge'
import { isWithinRoot } from '../shared/vault'
import { probeSizes } from './probeSizes'
import { isKindFolderName } from '../shared/classify'
import { composeRelFolder, normalizeCategoryPair } from '../shared/naming'
import {
  cleanupStaging,
  DEFAULT_CONCURRENCY,
  importPaths,
  renameAssetFolder
} from './importer'
import { createConflictGate } from './conflictGate'

/**
 * HDR 预览缓存目录（0.6.5）：`<userData>/hdr-cache`。
 *
 * **绝不放进用户库目录**：库是用户自己的资产，混进按 `sha1` 命名的中间产物
 * 既污染目录树，也会被 rescan 当成"结构不符"报警。缓存可随时整体删掉（会重算）。
 */
function hdrCacheDir(): string {
  return path.join(app.getPath('userData'), 'hdr-cache')
}
import {
  emptyLibraryTrash,
  moveToLibraryTrash,
  purgeToRecycleBin,
  restoreFromLibraryTrash,
  sweepExpired,
  TRASH_MAX_BYTES,
  TRASH_SWEEP_INTERVAL_MS,
  trashOne,
  trashPaths,
  type TrashStrategy
} from './trash'
import { rescanLibrary } from './rescan'
import { renameAssetFolders } from './rename'
import { ArchiveWatcher } from './watcher'
import { registerVaultScheme, serveVault } from './protocol'
import { normalizeTargetWidth, prepareHdrFile } from './hdrDecode'
import { isHdrExt } from '../shared/hdrExts'
import { sanitizeName } from '../shared/naming'
import {
  CRASH_WINDOW_MS,
  MAX_RELOADS_PER_WINDOW,
  STABLE_ALIVE_MS,
  decideCrashRecovery,
  isStableAlive
} from './crashGuard'

let win: BrowserWindow | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
const watcher = new ArchiveWatcher()

// ── 渲染进程崩溃自动恢复（DEF-19-5）────────────────────────────────────
//
// 决策逻辑全在 `crashGuard.ts`（纯函数，可单测）；这里只持有**运行时状态**：
// - `crashHistory`：真的触发过自动 reload 的崩溃时间戳（ms）。用时间戳而不是计数器，
//   是因为"5 分钟窗口"必须能自然过期 —— 用户白天崩一次、晚上再崩一次不算连续；
// - `crashReloadTimer`：退避中的 reload 定时器，窗口销毁 / 退出前必须清掉，
//   否则定时器在 `win` 已销毁后触发会碰 `webContents` 而抛异常；
// - `stableTimer`：reload 成功后观察"是否稳住 60s"的定时器，满了就清零历史；
// - `appQuitting`：`before-quit` 之后为 true。退出过程中的崩溃一律不救
//   （这是 `killed` 也能安全 reload 的前提，见 crashGuard 注释）；
// - `recoveryDialogOpen`：放弃恢复的原生弹窗只弹一个，别让后续崩溃叠窗。
let crashHistory: number[] = []
let crashReloadTimer: ReturnType<typeof setTimeout> | null = null
let stableTimer: ReturnType<typeof setTimeout> | null = null
let appQuitting = false
let recoveryDialogOpen = false

/** 清掉崩溃恢复相关定时器（窗口关闭 / 退出 / 已排队的 reload 执行前都会调用） */
function clearCrashTimers(): void {
  if (crashReloadTimer !== null) {
    clearTimeout(crashReloadTimer)
    crashReloadTimer = null
  }
  if (stableTimer !== null) {
    clearTimeout(stableTimer)
    stableTimer = null
  }
}

/**
 * reload 成功后的"稳定性观察"：页面 `did-finish-load` 起存活满 {@link STABLE_ALIVE_MS}
 * 就把崩溃历史清零。
 *
 * 注意**每次 load 都要重置这个定时器**：reload 后立刻再崩，`did-finish-load` 可能已经
 * 触发过一次，旧定时器如果继续跑，会在新一轮崩溃后把历史清空 → 退避上限被绕过 → 循环崩溃。
 */
function armStableTimer(): void {
  if (stableTimer !== null) {
    clearTimeout(stableTimer)
    stableTimer = null
  }
  if (crashHistory.length === 0) return
  stableTimer = setTimeout(() => {
    stableTimer = null
    if (!isStableAlive(STABLE_ALIVE_MS)) return
    const cleared = crashHistory.length
    crashHistory = []
    logInfo('crash:recovery-stable', {
      cleared,
      stableMs: STABLE_ALIVE_MS,
      reason: '页面持续存活，崩溃计数已重置'
    })
  }, STABLE_ALIVE_MS)
  // 短命场景（单测 / 无窗口）不该被这个定时器吊住
  stableTimer.unref?.()
}

/**
 * 连续崩溃超过上限后的兜底：原生弹窗告知 + 「打开日志目录」/「重启应用」。
 *
 * 重启的安全性说明：本应用所有用户数据都在 **IndexedDB（渲染进程）与磁盘库目录**里，
 * 主进程没有"未保存缓冲区"这类易失状态；导入批次是落盘后台任务，`app.exit` 前会
 * `clearPendingAsks` 把挂起的重复询问按「跳过」收尾、`flushLogsSync` 把日志冲刷完。
 * 已写入磁盘的文件不会因为重启丢失，最坏情况是某个正在解压的批次留下 `.staging`
 * （启动时的 `cleanupStaging` 会清掉）。因此这里可以直接 relaunch。
 */
function showCrashGiveUpDialog(context: {
  reason: string
  crashesInWindow: number
  attempt: number
}): void {
  if (recoveryDialogOpen) return
  recoveryDialogOpen = true
  const logs = logDir()
  const options = {
    type: 'error' as const,
    title: 'ID BOX 界面组件连续崩溃',
    message: '界面组件连续崩溃，已停止自动恢复',
    detail:
      `最近 ${CRASH_WINDOW_MS / 60_000} 分钟内界面组件崩溃 ${context.crashesInWindow} 次` +
      `（最后一次原因：${context.reason}），自动恢复已停止。\n\n` +
      `请先点「重启应用」；若重启后仍然崩溃，请把日志目录里的文件发给我们：\n${logs}`,
    buttons: ['重启应用', '打开日志目录', '稍后'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  const show = win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  void show
    .then((result) => {
      recoveryDialogOpen = false
      logInfo('crash:give-up:choice', {
        response: result.response,
        reason: context.reason,
        crashesInWindow: context.crashesInWindow
      })
      if (result.response === 1) {
        void shell.openPath(logs)
        return
      }
      if (result.response !== 0) return
      // 重启：先置退出标记并停掉所有恢复定时器，避免渲染进程退出时又被 reload 一次
      appQuitting = true
      clearCrashTimers()
      clearPendingAsks('app-relaunch')
      flushLogsSync()
      app.relaunch()
      app.exit(0)
    })
    .catch((err: unknown) => {
      recoveryDialogOpen = false
      logWarn('crash:give-up:dialog-failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
}

/**
 * 排一次自动 reload。
 *
 * 执行前重新校验窗口与退出状态：退避期间用户可能已经关窗 / 退出应用，
 * 这时 `win.webContents` 已销毁，`reload()` 会抛 `Object has been destroyed`。
 */
function scheduleCrashReload(delayMs: number): void {
  if (crashReloadTimer !== null) {
    clearTimeout(crashReloadTimer)
    crashReloadTimer = null
  }
  const run = (): void => {
    crashReloadTimer = null
    if (appQuitting) {
      logWarn('crash:reload:skipped', { why: '应用正在退出' })
      return
    }
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      logWarn('crash:reload:skipped', { why: '窗口已销毁' })
      return
    }
    try {
      logInfo('crash:reload:do', { delayMs })
      win.webContents.reload()
    } catch (err) {
      // reload 本身失败（极少数：webContents 在检查与调用之间被销毁）：
      // 不再重试，留给下一次 render-process-gone 或用户手动重开
      logError('crash:reload:failed', err)
    }
  }
  if (delayMs <= 0) {
    run()
    return
  }
  crashReloadTimer = setTimeout(run, delayMs)
}

/**
 * 回收站策略（P0-16 删除链路 / P0-5 原包处置共用）。
 *
 * 首选 `shell.trashItem`：Electron 内置，无外部可执行文件，**打包态（asar）唯一可靠**；
 * `trash` npm 包仅作兜底（shell.trashItem 不可用的平台 / 开发态）。
 * 历史缺陷：曾直接调 trash 包，其 Windows 实现从 asar 内 spawn exe 报 ENOENT，
 * 导致「删除模型」静默失效——详见 `main/trash.ts` 顶部说明。
 */
const trashStrategy: TrashStrategy = {
  trashItem: (p) => shell.trashItem(p),
  packageTrash: async (p) => {
    const { default: trash } = await import('trash')
    await trash(p)
  }
}

/** 原包处置（P0-5 三档）：keep 保留 / delete 彻底删 / recycle 走回收站策略 */
async function disposeArchiveWithStrategy(src: string, mode: Settings['archiveDisposal']): Promise<void> {
  if (mode === 'keep') return
  if (mode === 'delete') {
    await fs.rm(src, { force: true }).catch(() => {})
    return
  }
  try {
    await trashOne(src, trashStrategy)
  } catch (err) {
    // 与 importer 语义一致：失败不阻断导入（原包保留在下载目录），但必须留日志
    console.error('[idbox] 原包入回收站失败，已保留原包：', src, err)
    logWarn('import:archive-recycle-failed', { src })
  }
}

function emitImportEvent(ev: ImportEvent): void {
  win?.webContents.send(IPC.importEvent, ev)
  // `skipped` 也算「该源文件已有结论」：watcher 不能把它的 inflight 占位一直挂着
  if (ev.status === 'done' || ev.status === 'error' || ev.status === 'skipped') {
    watcher.markDone(ev.item)
  }
}

// ── 导入重复处置（docs/27 T-05）────────────────────────────────────────
//
// 两个模块级状态：
// - `batchChain`：**批次串行锁**（D18）。两个批次并发写同一个 cat2 目录时，
//   `uniqueName` + 批内台账 + 覆盖的「挪旧/落新」会互相踩（尤其覆盖把旧目录改名，
//   另一批正好在读到这个名字）。第二个批次排队等第一个跑完，UI 里它以 pending 挂着。
// - `pendingAsks`：`requestId → 兑现函数`。渲染进程答复 / 超时 / 关窗 / 渲染进程崩溃
//   都从这里收口，保证**任何情况下都不会有 Promise 永久悬挂**（D08）。

/** 重复询问的超时（§4.4：20 行明细 + 逐条判断，60s 会掐断正在认真读的用户） */
const CONFLICT_ASK_TIMEOUT_MS = 120_000

let batchChain: Promise<unknown> = Promise.resolve()
const pendingAsks = new Map<string, (answer: ImportConflictAnswer | null) => void>()

/**
 * 发一次重复询问给渲染层，等用户裁决（§4.3）。
 *
 * - **窗口不可用 → 立刻返回 null**（= 全部跳过），绝不等 120s；
 * - 120s 无人应答 → 兑现 null（= 全部跳过，D08）；
 * - 答复经 `IPC.importConflictAnswer` handler 兑现；过期 requestId 的答复被丢弃（幂等）。
 */
function sendConflictAsk(ask: ImportConflictAsk): Promise<ImportConflictAnswer | null> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    logInfo('import:conflict', {
      requestId: ask.requestId,
      items: ask.items.length,
      batchDefault: ask.batchDefault,
      timedOut: false,
      phase: 'no-window'
    })
    return Promise.resolve(null)
  }
  const target = win
  return new Promise<ImportConflictAnswer | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(ask.requestId)
      // ── 作废事件（真机 P1 补丁）────────────────────────────────────
      // 超时是主进程**单方面**结束：不通知的话，渲染层的 conflictAsk 仍非 null → 弹窗一直
      // 挂在屏幕上；用户之后点「确定」/「全部取消」只会命中答复 handler 的 stale 分支
      // （幂等丢弃，语义正确），表现却是「点了没反应、弹窗不关」。
      // ⚠️ 只在这里发（超时路径）。`clearPendingAsks()` 走的是渲染进程已崩 / 窗口正在销毁 /
      //    退出中，那三条路要么没有接收方、要么窗口正在销毁 —— 发过去只会在日志里造噪音。
      let notified = false
      if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
        try {
          target.webContents.send(IPC.importConflictExpired, { requestId: ask.requestId })
          notified = true
        } catch (err) {
          // 发送失败只记日志：Promise 必须照常兑现（绝不能让窗口状态影响导入批次收尾）
          logWarn('import:conflict', {
            requestId: ask.requestId,
            phase: 'expire-send-failed',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      logInfo('import:conflict', {
        requestId: ask.requestId,
        items: ask.items.length,
        batchDefault: ask.batchDefault,
        timedOut: true,
        // 是否成功推送了「询问已作废」事件（排障用：false = 弹窗可能仍挂在屏幕上）
        notified,
        phase: 'timeout'
      })
      resolve(null)
    }, CONFLICT_ASK_TIMEOUT_MS)

    pendingAsks.set(ask.requestId, (answer) => {
      clearTimeout(timer)
      resolve(answer)
    })
    logInfo('import:conflict', {
      requestId: ask.requestId,
      items: ask.items.length,
      batchDefault: ask.batchDefault,
      remainingItems: ask.remainingItems,
      timedOut: false,
      phase: 'ask'
    })
    try {
      target.webContents.send(IPC.importConflictAsk, ask)
    } catch (err) {
      // 发送瞬间窗口没了：按超时兜底（绝不把异常漏给整批导入）
      pendingAsks.delete(ask.requestId)
      clearTimeout(timer)
      logWarn('import:conflict', {
        requestId: ask.requestId,
        phase: 'send-failed',
        error: err instanceof Error ? err.message : String(err)
      })
      resolve(null)
    }
  })
}

/**
 * 清场：兑现所有挂起的询问为 `null`（= 全部跳过）并清空表。
 *
 * 三个调用点：`render-process-gone` / `win.on('closed')` / `before-quit`。
 * 渲染进程崩了不能干等 120s（§4.3 / 端到端验收 6）。
 */
function clearPendingAsks(reason: string): void {
  if (pendingAsks.size === 0) return
  const count = pendingAsks.size
  for (const resolve of pendingAsks.values()) resolve(null)
  pendingAsks.clear()
  logWarn('import:conflict:cancelled', { pending: count, reason })
}

/**
 * 执行一个导入批次。
 *
 * `ctx` = 渲染层算好的判重快照（docs/27）：不传 → 完全不判重、不询问，
 * 行为与 0.6.9 逐字节等价（D21）。主进程**不自己扫盘**（D22）。
 */
async function runImport(paths: string[], ctx?: ImportConflictContext): Promise<Asset[]> {
  // 一批一个询问门：聚合窗口、逐键复用、超时锁定都只在本批次内生效
  const gate = createConflictGate({ sendAsk: sendConflictAsk })
  try {
    const assets = await importPaths(paths, {
      libraryDir: settings.libraryDir,
      sevenZipPath: settings.sevenZipPath ?? findSevenZip(),
      archiveDisposal: settings.archiveDisposal,
      defaultSource: settings.defaultSource,
      codepage: settings.codepage,
      timeoutMs: settings.extractTimeoutMs,
      maxBytesForJsFallback: settings.maxBytesForJsFallback,
      spaceSafetyFactor: settings.spaceSafetyFactor,
      // §3.6 导入 tab「同时解压任务数」stepper（默认 2，旧档无此键时回退 importer 内置值）
      concurrency: settings.extractConcurrency ?? DEFAULT_CONCURRENCY,
      // T04 核心接线点：真实缩略图服务注入（原来是 placeholderEnsureThumb）
      ensureThumb: (id, coverAbs) => ensureThumb(id, coverAbs, { maxPx: settings.thumbMaxPx }),
      // P0-16/P0-5：原包处置走回收站策略（shell.trashItem 优先，打包态可靠）
      disposeArchive: disposeArchiveWithStrategy,
      // docs/27：判重快照 + 询问门 + 覆盖时旧目录进**系统回收站**（D11，不进库内 .trash）
      conflictContext: ctx,
      askConflict: (query) => gate.ask(query),
      trashFolder: (abs) => trashOne(abs, trashStrategy),
      warn: (event, context) => logWarn(event, context),
      emit: emitImportEvent
    })
    // ── AI 辅助分类触发点（docs/15 §7）────────────────────────────────
    // 批次结束后**通知渲染层**去后台补分类：这里只 `send`（fire-and-forget），
    // **不 await 任何网络请求**——导入耗时与是否配置 AI 完全无关。
    // 覆盖两条导入入口：UI 的 import:paths 与监控目录（watcher 直接调 runImport）。
    try {
      win?.webContents.send(IPC.importBatchDone, { count: assets.length })
    } catch {
      /* 窗口已销毁：忽略（导入本身已成功） */
    }
    return assets
  } finally {
    // 批次结束（含异常）：兑现所有还挂着的询问，绝不留 pending
    gate.cancelAll()
  }
}

function restartWatcher(): void {
  watcher.stop()
  if (settings.watchEnabled && settings.watchDir) {
    watcher.start(settings.watchDir, (p) => {
      // docs/27 D19：监控目录的自动导入**不弹窗**（后台任务弹窗会在用户不在电脑前时
      // 长期挂起），固定按现状「同时存在并重命名」。显式传空快照 = 不判重、不询问，
      // 与不传 ctx 完全等价（D21），写出来是为了让后来者一眼看到这是刻意的。
      void runImport([p], { index: [] })
    })
  }
}

/**
 * 拖出图标的**最后兜底**：把 `resources/drag-icon.png`（64×64 RGBA）以 base64 内嵌，
 * 保证即使打包漏带资源 / 用户删了文件，拖出也不会因为缺 icon 而失败。
 */
const EMBEDDED_DRAG_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWElEQVR4nO3QQREAIAwEsepDGgKxAxb66vFIZtbAVgEAAAA03c8YYIAB2QFnr9EMMMAAAwwwwAADDDDAAAMMMMAAAwwwwAADDDDAgNyANAMMMAAAAACg5QGtM3TztR4UtwAAAABJRU5ErkJggg=='

/** 拖出图标的解析结果（埋点要记录用的是哪一档、文件是否真的存在） */
export interface DragIconResolution {
  icon: string | NativeImage
  /** 缩略图 / resources 兜底 / 内嵌 base64 / 渲染层预热的卡片位图 */
  kind: 'thumb' | 'fallback' | 'embedded' | 'card'
  /** 图标来源文件路径（embedded / card 档为 null：图标来自内存） */
  path: string | null
  /** 来源文件是否真的存在于磁盘（embedded / card 档恒为 false） */
  exists: boolean
}

/**
 * 拖出时的拖拽图标：优先用该资产自己的缩略图 → 回退 `resources/drag-icon.png`（T01 已建）
 * → 再回退内嵌 base64。Electron 的 `Item.icon` 是**必填**且 macOS 上不允许空图，
 * 所以这里必须永远返回一个非空图标。
 *
 * 返回解析细节（而不只是图标）是为了 `drag:start` 埋点：闪退现场需要知道
 * 当时用的是哪一档图标、文件在不在（缺图标也是 startDrag 崩溃的嫌疑之一）。
 */
function resolveDragIcon(thumbName: string | null | undefined): DragIconResolution {
  if (thumbName) {
    const p = path.join(thumbsDir(), thumbName)
    if (existsSync(p)) return { icon: p, kind: 'thumb', path: p, exists: true }
  }
  const fallback = path.join(app.getAppPath(), 'resources', 'drag-icon.png')
  if (existsSync(fallback)) return { icon: fallback, kind: 'fallback', path: fallback, exists: true }
  return {
    icon: nativeImage.createFromBuffer(Buffer.from(EMBEDDED_DRAG_ICON_BASE64, 'base64')),
    kind: 'embedded',
    path: null,
    exists: false
  }
}

/** 拖出物件的字节数（stat 失败/不是文件 → null，埋点绝不因此抛错） */
function sizeBytesOrNull(file: string): number | null {
  try {
    const st = statSync(file)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/**
 * 预渲染「拖拽卡片」PNG 的体积上限。
 *
 * 168×210 @2x 的 RGBA PNG 实际 < 300KB；8MB 只是防御被注入的超大 payload
 * （解码一张超大图会卡住主线程，而 `startDrag` 必须在同步段里返回）。
 */
const MAX_DRAG_CARD_BYTES = 8 * 1024 * 1024

/**
 * 渲染层 hover 预热好的卡片 PNG → 拖拽图标（v0.5.4）。
 *
 * ## 为什么必须落成临时文件再传路径（2026-10-21 用户第三次反馈后定位）
 *
 * 原来直接把 `nativeImage.createFromBuffer()` 的 NativeImage 交给
 * `webContents.startDrag({ icon })`。日志显示 `iconKind: "card"`、图片也解码成功，
 * 但用户实测拖起来的仍是 **Windows 默认那张「文件图标 + 文件名」占位图**
 * （固定约 100×145 的深色框，中间一张缩略图，底下文件名）—— 说明 Windows 侧
 * **没有采用这个 NativeImage**。改成先把 PNG 写进临时文件、把**路径**传给 icon，
 * 走的是 Electron 支持的「icon 为文件路径」那条分支，Windows 才会拿它当拖拽影像。
 *
 * 临时文件固定一个名字、每次拖拽覆盖（拖拽是同步段，必须 `writeFileSync`）；
 * 内容只是一张 176×176 的卡片，几 MB 上限已在调用前校验。
 *
 * 任何一步失败都返回 `null`，交给调用方回退 `resolveDragIcon(thumbName)`。
 */
function resolveDragCard(cardPng: unknown): DragIconResolution | null {
  if (!(cardPng instanceof Uint8Array) || cardPng.byteLength === 0) return null
  if (cardPng.byteLength > MAX_DRAG_CARD_BYTES) {
    logWarn('drag:start:card-too-large', { bytes: cardPng.byteLength })
    return null
  }
  const buf = Buffer.from(cardPng)
  try {
    const image = nativeImage.createFromBuffer(buf)
    if (image.isEmpty()) {
      logWarn('drag:start:card-decode-empty', { bytes: cardPng.byteLength })
      return null
    }
  } catch (err) {
    logWarn('drag:start:card-decode-failed', {
      bytes: cardPng.byteLength,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
  try {
    const file = path.join(app.getPath('temp'), 'idbox-drag-card.png')
    writeFileSync(file, buf)
    return { icon: file, kind: 'card', path: file, exists: true }
  } catch (err) {
    logWarn('drag:start:card-write-failed', {
      bytes: cardPng.byteLength,
      error: err instanceof Error ? err.message : String(err)
    })
    // 写盘失败也不要让拖拽失效：退回 NativeImage 那条老路（至少不是裸缩略图）
    try {
      return { icon: nativeImage.createFromBuffer(buf), kind: 'card', path: null, exists: false }
    } catch {
      return null
    }
  }
}


/**
 * 崩溃现场捕获 + staging 三重清理（K2）。
 *
 * 2026-10 变更（拖出闪退取证）：**不再在 `uncaughtException` 里 `process.exit(1)`**。
 * 桌面应用直接死掉会让用户丢掉未保存的工作，也丢掉了"日志能不能冲刷完"的机会；
 * 现在只记 `error` + `fatal` 标记、同步冲刷日志、清 staging，然后**继续运行**。
 *
 * `gpu-process-crashed` 在 Electron 33 已移除（Electron 10 起由 `child-process-gone` 取代），
 * 因此这里**不挂**该事件，GPU 崩溃由 `child-process-gone` 覆盖（type = 'GPU'）。
 */
function installCrashHandlers(): void {
  const cleanup = (): void => {
    // 退出流程开始：崩溃自动恢复必须立刻停手（否则关窗时 render-process-gone
    // 会把正在销毁的窗口又 reload 回来，用户看到"关不掉"）
    appQuitting = true
    clearCrashTimers()
    // 退出前必须把挂起的重复询问兑现掉，否则正在等答复的批次会卡在 await 上，
    // `cleanupStaging` 会把它的 staging 删掉而 Promise 永远不返回（docs/27 §4.3）
    clearPendingAsks('before-quit')
    void cleanupStaging(settings.libraryDir)
  }
  app.on('before-quit', cleanup)

  process.on('uncaughtException', (err) => {
    console.error('[idbox] uncaughtException', err)
    logError('fatal:uncaughtException', err, {
      fatal: true,
      libraryDir: settings.libraryDir,
      stack: err?.stack ?? null
    })
    // 进程随时可能被系统收走：同步冲刷队列，保证这条 error 一定落盘
    flushLogsSync()
    cleanup()
    // 故意不终止进程：吞掉异常、保留窗口，让用户还能导出日志 / 保存工作
    // （退出码只能由用户主动关闭窗口产生，日志里已用 fatal:true 标记这条现场）
  })

  process.on('unhandledRejection', (err) => {
    console.error('[idbox] unhandledRejection', err)
    logError('unhandledRejection', err, { fatal: false })
    flushLogsSync()
    cleanup()
  })

  // 渲染进程崩溃（含 OOM / 被系统 kill）：reason + exitCode 是唯一线索
  app.on('render-process-gone', (_event, webContents, details) => {
    const reason = details?.reason ?? null
    logError('process:render-gone', undefined, {
      reason,
      exitCode: details?.exitCode ?? null,
      webContentsId: webContents?.id ?? null,
      url: (() => {
        try {
          return webContents?.getURL?.() ?? null
        } catch {
          return null
        }
      })()
    })
    // 渲染进程没了 = 没人能回答重复询问：**立刻**全按「跳过」收尾，绝不干等 120s
    // （docs/27 §4.3 / 端到端验收 6：kill 渲染进程后主进程要立即收尾）
    clearPendingAsks('render-gone')
    // 新一轮崩溃开始：旧"稳定观察"定时器必须停掉，否则它会在本轮崩溃后把历史清零，
    // 把退避上限绕过去（= 循环崩溃）
    if (stableTimer !== null) {
      clearTimeout(stableTimer)
      stableTimer = null
    }

    // 只处理主窗口的崩溃；其他 webContents（极少数隐藏窗口）只留日志
    if (!win || win.isDestroyed() || webContents !== win.webContents) {
      logWarn('crash:recovery:skipped', {
        reason,
        why: '不是主窗口的渲染进程，无法自动恢复'
      })
      flushLogsSync()
      return
    }

    const now = Date.now()
    const decision = decideCrashRecovery({
      reason,
      now,
      history: crashHistory,
      quitting: appQuitting
    })

    if (decision.action === 'ignore') {
      logWarn('crash:recovery', {
        action: 'ignore',
        reason: decision.reason,
        why: decision.why,
        crashesInWindow: crashHistory.length
      })
      flushLogsSync()
      return
    }

    // 进入历史：这一条代表"本次已经消耗了一次自动恢复额度"。
    // 先记账再排定时器，保证退避期间若窗口被关/再崩，计数不会漏。
    crashHistory.push(now)

    logWarn('crash:recovery', {
      action: decision.action,
      reason: decision.reason,
      why: decision.why,
      attempt: decision.attempt,
      delayMs: decision.action === 'reload' ? decision.delayMs : 0,
      crashesInWindow: decision.crashesInWindow,
      windowMs: CRASH_WINDOW_MS,
      maxPerWindow: MAX_RELOADS_PER_WINDOW
    })
    // 先冲刷：reload 会销毁当前渲染进程，这条现场必须已经落盘
    flushLogsSync()

    if (decision.action === 'reload') {
      scheduleCrashReload(decision.delayMs)
      return
    }

    showCrashGiveUpDialog({
      reason: decision.reason,
      crashesInWindow: decision.crashesInWindow,
      attempt: decision.attempt
    })
  })

  // 子进程（GPU / utility / plugin）崩溃
  app.on('child-process-gone', (_event, details) => {
    logError('process:child-gone', undefined, {
      type: details?.type ?? null,
      reason: details?.reason ?? null,
      exitCode: details?.exitCode ?? null,
      serviceName: details?.serviceName ?? null,
      name: details?.name ?? null
    })
    flushLogsSync()
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    // UI 规范 v0.2 §3.1/§4-2：无边框窗口，软件内自绘窗口控制（WindowControls.tsx），
    // 顶栏 -webkit-app-region: drag 负责拖动，交互元素 no-drag。
    frame: false,
    backgroundColor: '#f8fafc',
    title: 'ID BOX',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out/preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 最大化状态广播：WindowControls 切 □ / ❐ 图标（§3.1 加分项）
  const sendMaximized = (): void => {
    win?.webContents.send(IPC.winMaximizedEvent, win?.isMaximized() ?? false)
  }
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)

  // 窗口关掉 = 没人能回答重复询问（docs/27 §4.3）：立即按「跳过」收尾
  win.on('closed', () => {
    // 窗口没了：崩溃恢复的定时器必须清掉。否则退避中的 reload 会在 `win` 已销毁后
    // 触发（碰 webContents 抛异常），"稳定观察"也会在进程退出前继续跑。
    appQuitting = true
    clearCrashTimers()
    clearPendingAsks('window-closed')
  })

  // 每次页面加载完成都重新起"稳定观察"：只有 reload 之后才需要观察，
  // 历史为空时 `armStableTimer` 直接返回，不会平白多一个定时器。
  win.webContents.on('did-finish-load', () => {
    armStableTimer()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(app.getAppPath(), 'out/renderer/index.html'))
  }

  // ── 材质大类合并：启动**只读探测**（docs/14 §2.3.6） ──────────────────
  // 只 stat/readdir 两个历史目录，有货才发 notice 给渲染层；**绝不在启动时搬**
  // （≤50 由渲染层自动触发、>50 提示用户去设置页；搬移必须由 IPC 显式调用）。
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      // 库目录为空时不要探测：path.resolve('') 会变成 cwd，等于去扫启动目录
      if (!settings.libraryDir) return
      try {
        const info = await detectMaterialMerge(settings.libraryDir)
        if (info.needMerge) win?.webContents.send(IPC.materialMergeNotice, info)
      } catch {
        /* 只读探测失败静默：迁移失败不得阻塞启动，下轮启动再试 */
      }
    })()
  })
}

/**
 * 首个实例的完整启动流程（纯搬运：原逻辑一行未改）。
 *
 * 只在拿到单实例锁后调用 —— 第二个实例连 scheme 注册、staging 清理、窗口创建都不做，
 * 绝不碰 userData（两个进程共用同一份 IndexedDB 会导致 `init()` reject、界面永久卡在
 * 「正在加载…」）。
 */
function bootstrap(): void {
  // 诊断日志**尽早**初始化（在 loadSettings 之前）：启动阶段的崩溃同样需要现场。
  // 此时还不知道 verboseLogging，先按默认 info 记，读到设置后再校正级别。
  initLogger()

  // 第二个实例启动时：把已有窗口唤到前台，然后自己退出（由 Electron 自动触发 quit）
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  registerVaultScheme()
  installCrashHandlers()
  logInfo('app:bootstrap', {
    pid: process.pid,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    logDir: logDir()
  })

  app.whenReady().then(async () => {
    settings = await loadSettings()
    // 设置到手后校正日志级别（「记录详细日志」开关）
    setVerboseLogging(settings.verboseLogging)
    serveVault(() => ({
      libraryDir: settings.libraryDir,
      thumbsDir: thumbsDir(),
      hdrDir: hdrCacheDir()
    }))
    await fs.mkdir(settings.libraryDir, { recursive: true }).catch(() => {})
    // 启动时先清掉上次崩溃可能留下的 .staging 垃圾
    await cleanupStaging(settings.libraryDir).catch(() => {})
    // C 线：回收区清理（到期项 + 超 5GB 从最旧开始清）——启动一次 + 每 6 小时一次。
    // 不阻塞建窗：`void` 掉；`unref` 让定时器不阻止进程退出。
    void runTrashSweep()
    const trashSweepTimer = setInterval(() => void runTrashSweep(), TRASH_SWEEP_INTERVAL_MS)
    trashSweepTimer.unref?.()
    createWindow()
    restartWatcher()

    // 启动快照：崩溃报告里的第一段上下文（**不含 apiKey / 密钥**）
    logInfo('app:ready', {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      libraryDir: settings.libraryDir,
      userData: app.getPath('userData'),
      logDir: logDir(),
      verboseLogging: settings.verboseLogging,
      theme: settings.theme,
      watchEnabled: settings.watchEnabled
    })
    logDebug('app:ready:settings', {
      archiveDisposal: settings.archiveDisposal,
      sevenZipPath: settings.sevenZipPath,
      thumbMaxPx: settings.thumbMaxPx,
      extractConcurrency: settings.extractConcurrency,
      aiClassifyEnabled: settings.aiClassify.enabled,
      aiClassifyBaseUrl: settings.aiClassify.baseUrl,
      aiClassifyModel: settings.aiClassify.model
      // ⚠️ 故意不记 apiKey：脱敏逻辑兜底，这里连键都不放
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// ── 单实例锁（C3，架构盘点第二塌点） ────────────────────────────────
//
// 旧实现丢弃了 `requestSingleInstanceLock()` 的返回值：第二个进程照常启动，
// 两个进程共用同一份 userData → IndexedDB 可能打不开 → `init()` reject →
// 界面永久停在「正在加载…」。
//
// ⚠️ **必须有 else 分支**：`app.quit()` 只是"请求退出"，不会中断当前 tick；
// 若写成 `app.quit()` 后面继续执行 `bootstrap()`，whenReady 仍会跑，等于没修。
// 后人若想简化成"一行 quit"，请先看 goto：这条注释就是防止那种简化。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // 第二个实例：直接退出。不注册任何 handler、不建窗口、不读写 userData。
  app.quit()
} else {
  bootstrap()
}

app.on('window-all-closed', () => {
  void cleanupStaging(settings.libraryDir).catch(() => {})
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC ──────────────────────────────────────────────────────────

/**
 * 导入入口（docs/27 T-05）。
 *
 * **批次串行**（D18）：`batchChain` 让第二个批次排队等第一个跑完 —— 两个批次并发写
 * 同一个 cat2 目录时，`uniqueName` + 台账 + 覆盖的「挪旧/落新」会互相踩。
 * `batchChain` 用「then(空, 空)」吸收失败，失败的批次不会卡死后续所有导入。
 *
 * `ctx` 缺省 = 不判重（D21，与 0.6.9 等价）；老渲染层不传第二个参数也不会报错。
 */
ipcMain.handle(IPC.importPaths, (_e, paths: string[], ctx?: ImportConflictContext) => {
  const list = Array.isArray(paths) ? paths : []
  const run = batchChain.then(() => runImport(list, ctx))
  batchChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
})

/**
 * 重复询问的答复（docs/27 §4.3）。
 *
 * 按 `requestId` 兑现挂起的 Promise；**过期 requestId 幂等丢弃**（超时后才到的答复
 * 不能影响后续批次）。渲染层被注入也不会造成越权：这里只认主进程自己发出去的 id。
 */
ipcMain.handle(IPC.importConflictAnswer, (_e, answer: ImportConflictAnswer | undefined) => {
  const requestId = typeof answer?.requestId === 'string' ? answer.requestId : ''
  if (!requestId) return
  const resolve = pendingAsks.get(requestId)
  if (!resolve) {
    logWarn('import:conflict:answer', { requestId, phase: 'stale' })
    return
  }
  pendingAsks.delete(requestId)
  logInfo('import:conflict', {
    requestId,
    items: Array.isArray(answer?.overrides) ? answer!.overrides!.length : 0,
    batchDefault: answer?.batchDefault ?? null,
    cancelled: answer?.cancelled === true,
    timedOut: false,
    phase: 'answer'
  })
  resolve(answer ?? null)
})

ipcMain.handle(IPC.getSettings, () => settings)

ipcMain.handle(IPC.setSettings, async (_e, patch: Partial<Settings>) => {
  const safePatch: Partial<Settings> = patch ?? {}
  // `aiClassify` 是**嵌套对象**：浅合并会让只改 `enabled` 的 patch 把 baseUrl/apiKey 抹掉，
  // 所以这里单独深合并一层，再交给 normalizeSettings 逐字段降级/裁剪。
  settings = normalizeSettings({
    ...settings,
    ...safePatch,
    aiClassify: safePatch.aiClassify
      ? { ...settings.aiClassify, ...safePatch.aiClassify }
      : settings.aiClassify
  })
  await saveSettings(settings)
  // 「记录详细日志」开关立即生效（无需重启）
  setVerboseLogging(settings.verboseLogging)
  logInfo('settings:updated', {
    keys: Object.keys(safePatch),
    verboseLogging: settings.verboseLogging
  })
  restartWatcher()
  return settings
})

ipcMain.handle(IPC.chooseLibrary, async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择模型库目录',
    buttonLabel: '设为库目录'
  })
  if (r.canceled || !r.filePaths[0]) return null
  settings = { ...settings, libraryDir: r.filePaths[0] }
  await saveSettings(settings)
  return settings
})

ipcMain.handle(IPC.pickArchives, async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    title: '选择要导入的压缩包 / 图片',
    // 2026-10 任务 2：单张图片（jpg/png/webp…）直导为独立贴图资产，与压缩包同一入口
    filters: [
      {
        name: '压缩包 / 图片',
        extensions: ['zip', 'rar', '7z', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif']
      }
    ]
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle(IPC.pickWatchDir, async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择要监控的下载目录',
    buttonLabel: '监控此目录'
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
})

ipcMain.handle(IPC.openPath, async (_e, p: string) => {
  const err = await shell.openPath(p)
  return err || null
})

ipcMain.handle(IPC.reveal, (_e, p: string) => {
  shell.showItemInFolder(p)
})

/**
 * 删除链路（P0-16）：把资产目录移入回收站。
 *
 * 2026-10 装机缺陷修复：原实现直接调 `trash` 包，打包态从 asar 内 spawn
 * `windows-trash.exe` 报 ENOENT → 静默失败 →「删除模型功能失效」。
 * 现走 `main/trash.ts` 策略（shell.trashItem 优先），**失败不再静默**：
 * 记日志 + 返回失败清单，渲染层据此保留索引并提示用户。
 */
ipcMain.handle(IPC.trashPaths, async (_e, paths: string[]) => {
  const failed = await trashPaths(Array.isArray(paths) ? paths : [], trashStrategy)
  if (failed.length > 0) {
    console.error('[idbox] trashPaths 失败（文件可能被占用或不存在）：', failed)
    logError('trash:failed', undefined, { failed, requested: paths.length })
  }
  return failed
})

// ── C 线：库内「最近删除」（docs/20 §4） ─────────────────────────────
//
// 保留期四档（Settings.trashRetention）：
//   '5d' | '10d' | '30d' → 软删进 `.trash/`（本组 IPC）
//   'recycle'            → 渲染层继续用上面的 `trashPaths`（旧行为，5 秒撤销条）
// 到期/超容量/手动清空才 `trashOne` 进**系统回收站**（双保险）。

/** 错误 → 可读原因（失败项上报用） */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 软删：批量把资产目录移到 `<库根>/.trash/`（单个失败不阻断其余） */
ipcMain.handle(IPC.trashSoftDelete, async (_e, items: TrashSoftDeleteItem[]) => {
  const ok: Array<{ id: string; trashRel: string; deletedAt: number; size: number }> = []
  const failed: Array<{ id: string; reason: string }> = []
  for (const it of Array.isArray(items) ? items : []) {
    const id = typeof it?.id === 'string' ? it.id : ''
    const folder = typeof it?.folder === 'string' ? it.folder : ''
    try {
      const r = await moveToLibraryTrash(settings.libraryDir, id, folder)
      ok.push({ id, trashRel: r.trashRel, deletedAt: r.deletedAt, size: r.size })
    } catch (err) {
      failed.push({ id, reason: reasonOf(err) })
    }
  }
  if (failed.length > 0) logWarn('trash:softDelete', { ok: ok.length, failed })
  else if (ok.length > 0) logInfo('trash:softDelete', { ok: ok.length })
  return { ok, failed }
})

/** 还原：从 `.trash/` 搬回原路径（重名 → 追加序号，`renamed` 必须由 UI 提示） */
ipcMain.handle(IPC.trashRestore, async (_e, items: TrashRestoreItem[]) => {
  const ok: Array<{ id: string; folder: string; relFolder: string; renamed: boolean }> = []
  const failed: Array<{ id: string; reason: string }> = []
  for (const it of Array.isArray(items) ? items : []) {
    const id = typeof it?.id === 'string' ? it.id : ''
    try {
      const r = await restoreFromLibraryTrash(settings.libraryDir, {
        trashRel: String(it?.trashRel ?? ''),
        relFolder: String(it?.relFolder ?? ''),
        name: String(it?.name ?? '')
      })
      ok.push({ id, folder: r.folder, relFolder: r.relFolder, renamed: r.renamed })
    } catch (err) {
      failed.push({ id, reason: reasonOf(err) })
    }
  }
  if (failed.length > 0) logWarn('trash:restore', { ok: ok.length, failed })
  return { ok, failed }
})

/** 彻底删除：指定软删项 → 系统回收站 */
ipcMain.handle(IPC.trashPurge, async (_e, items: TrashPurgeItem[]) => {
  const failures: Array<{ id: string; reason: string }> = []
  let purged = 0
  for (const it of Array.isArray(items) ? items : []) {
    const id = typeof it?.id === 'string' ? it.id : ''
    try {
      await purgeToRecycleBin(settings.libraryDir, String(it?.trashRel ?? ''), trashStrategy)
      purged += 1
    } catch (err) {
      failures.push({ id, reason: reasonOf(err) })
    }
  }
  return { purged, failed: failures.length, failures }
})

/** 清空回收区：全部 → 系统回收站（单个失败不阻断其余） */
ipcMain.handle(IPC.trashEmptyAll, async () => {
  const r = await emptyLibraryTrash(settings.libraryDir, trashStrategy)
  if (r.purged > 0 || r.failed > 0) logInfo('trash:emptyAll', r)
  return { purged: r.purged, failed: r.failed, failures: r.failures }
})

/** 到期 / 超容量清理（设置页手动触发 / 启动 / 定时共用） */
ipcMain.handle(
  IPC.trashSweep,
  async (_e, opts?: { retentionDays?: number; maxBytes?: number }) => {
    return runTrashSweep(opts)
  }
)

/**
 * 执行一次回收区清理。
 *
 * `recycle` 档（天数 0）**仍做容量兜底**：用户从 30 天档切到 recycle 时，
 * 历史 `.trash` 残留不会被永久遗忘。失败只记日志，不影响启动/UI。
 */
async function runTrashSweep(opts?: {
  retentionDays?: number
  maxBytes?: number
}): Promise<{ purged: number; failed: number; bytes: number }> {
  const configured = TRASH_RETENTION_DAYS[settings.trashRetention] ?? 30
  // recycle 档（0 天）按 30 天清理历史残留，避免旧档遗留永远占盘
  const days = Number.isFinite(opts?.retentionDays)
    ? Math.max(0, Math.floor(opts!.retentionDays!))
    : configured > 0
      ? configured
      : 30
  const maxBytes =
    typeof opts?.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : TRASH_MAX_BYTES
  try {
    const r = await sweepExpired(settings.libraryDir, days, maxBytes, trashStrategy)
    if (r.purged > 0 || r.failed > 0) logInfo('trash:sweep', { ...r, days, maxBytes })
    return r
  } catch (err) {
    logError('trash:sweep:error', err)
    return { purged: 0, failed: 0, bytes: 0 }
  }
}

ipcMain.handle(IPC.openLibrary, async () => {
  const err = await shell.openPath(settings.libraryDir)
  return err || null
})

ipcMain.handle(IPC.renameAsset, async (_e, folder: string, newName: string) => {
  return renameAssetFolder(folder, sanitizeName(newName))
})

/**
 * 批量重命名资产**文件夹**（0.6.0，docs/22 §3.4）。
 *
 * 安全边界全部在 `main/rename.ts` 里（预检 + 同父目录约束 + 失败回滚）；
 * 这里只做两件事：① 用**主进程的** libraryDir 做根目录校验（不信任渲染层）；
 * ② 落一条 info 日志（批量磁盘动作必须可追溯）。
 * 渲染层的 Dexie 更新不在这里做（main 拿不到 Dexie），见 `store.applyRenames`。
 */
ipcMain.handle(IPC.renameFolders, async (_e, plan: RenameFolderPlanItem[]) => {
  const list = Array.isArray(plan) ? plan : []
  if (list.length === 0) return { renamed: [], failed: [], rolledBack: false }
  try {
    const result = await renameAssetFolders(list, { libraryDir: settings.libraryDir })
    logInfo('asset:renameFolders', {
      total: list.length,
      renamed: result.renamed.length,
      failed: result.failed.length,
      rolledBack: result.rolledBack,
      reasons: result.failed.slice(0, 5).map((f) => f.reason)
    })
    return result
  } catch (err) {
    // renameAssetFolders 内部已把可预期错误转成 failed 列表；走到这里说明是意外异常
    logError('asset:renameFolders:threw', err, { total: list.length })
    return {
      renamed: [],
      failed: list.map((it) => ({
        id: String(it?.id ?? ''),
        reason: `重命名异常：${err instanceof Error ? err.message : String(err)}`
      })),
      rolledBack: false
    }
  }
})

/**
 * 截图/本地图片设为封面（2026-10 装机反馈，任务 3）。
 *
 * 安全三查（与 drag:start 同口径）：
 *   ① 资产 folder 必须 resolve 后位于库目录内（isWithinRoot）——防渲染层被注入时
 *      把封面写进任意目录；
 *   ② 图片必须过 magic bytes 校验（JPEG/PNG）且 ≤20MB（coverImage.ts 纯函数）；
 *   ③ **源文件允许在库外**（用户的截图常在桌面/下载目录）——只有落点被约束。
 * 返回 rel（相对资产文件夹）供渲染层 `setCover(id, rel)` 收尾；任何一步失败返回 null。
 */
ipcMain.handle(IPC.setCoverImage, async (_e, payload: SetCoverImagePayload) => {
  if (!payload?.folder || (payload.source !== 'clipboard' && payload.source !== 'file')) return null
  const lib = path.resolve(settings.libraryDir)
  const folder = path.resolve(payload.folder)
  if (!isWithinRoot(lib, folder, path.sep)) {
    console.warn('[idbox] setCoverImage 拒绝越界资产目录：', payload.folder)
    logWarn('cover:rejected-outside-library', { folder: payload.folder })
    return null
  }

  let buf: Buffer
  try {
    if (payload.source === 'file') {
      if (!payload.path) return null
      // 先 stat 预检体积：超大文件直接拒，不读进内存
      const st = await fs.stat(payload.path)
      if (!st.isFile() || st.size > MAX_COVER_IMAGE_BYTES) return null
      buf = await fs.readFile(payload.path)
    } else {
      if (!payload.data) return null
      // base64 长度 ≈ 字节数 × 4/3；超限先按字符串长度拒，避免无谓 decode
      if (payload.data.length > Math.ceil((MAX_COVER_IMAGE_BYTES * 4) / 3)) return null
      buf = Buffer.from(payload.data, 'base64')
    }
  } catch {
    return null
  }

  try {
    return await writeCoverImageInto(folder, buf)
  } catch (err) {
    console.error('[idbox] setCoverImage 写盘失败：', payload.folder, err)
    logError('cover:write-failed', err, { folder: payload.folder })
    return null
  }
})

/**
 * 知末封面抓取（docs/24 §3.4，T-03）。
 *
 * 只做四件事（抓取/解析/校验/落盘全在 `zhimoCover.ts`，那里刻意不 import electron，
 * 好处是能被 vitest 直接单测）：
 *   ① `folder` 必须 resolve 后位于库目录内（`isWithinRoot`）——核心模块**故意不做**
 *      越界校验，安全边界必须落在 IPC 这一层（防渲染层被注入时往任意目录写文件）；
 *      越界一律返回 `{ok:false, reason:'write-failed'}`（IPC 表面只有一种形状）；
 *   ② 调 `refreshZhimoCoverInto(folder, id)`（它**绝不抛错**，失败也返回 reason）；
 *   ③ 走 `mainImageUrl` 兜底（`watermarked === true`）时记**一条** warn ——
 *      这是"静默产出带水印封面"的唯一可观测信号，不记就再也没人知道；
 *   ④ 失败记 warn（**不是 error**：知末上没有这个 ID / 网络抖动都是正常业务结果，
 *      记 error 会把日志噪音顶满，真异常反而被淹），并带上**能定位**的字段：
 *      `step`（page|image）/ `attempt`（1|2）/ `elapsedMs`（本次尝试）/
 *      `totalMs`（入口起累计）。2026-10 那次事故只有 `reason` 可用，
 *      只能靠"两条日志间隔 15s"反推卡在详情页 —— 这种猜法不该再来一次；
 *   ⑤ 每次"还会重试"的尝试失败各记一条 `zhimo:cover-retry`：让"重试过"这件事
 *      在日志里是**显式**的，而不是靠 attempt 字段去推。
 *
 * 写库（cover / coverSource / files / 缩略图）由渲染层 `commitCover` 完成。
 */
ipcMain.handle(
  IPC.fetchZhimoCover,
  async (_e, payload: FetchZhimoCoverPayload): Promise<FetchZhimoCoverResult> => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    // 语义分开：ID 不合法 → no-id（核心模块会再校验一次）；folder 缺失 → write-failed
    if (!id) return { ok: false, reason: 'no-id' }
    if (!payload?.folder) return { ok: false, reason: 'write-failed' }

    const lib = path.resolve(settings.libraryDir)
    const folder = path.resolve(payload.folder)
    if (!isWithinRoot(lib, folder, path.sep)) {
      console.warn('[idbox] zhimo:fetchCover 拒绝越界资产目录：', payload.folder)
      logWarn('zhimo:cover-rejected-outside-library', { id, folder: payload.folder })
      return { ok: false, reason: 'write-failed' }
    }

    // 最后一次尝试的失败现场：`onAttemptFailed` 每发失败都回调，这里只留最后一发，
    // 它就是 `cover-failed` 日志里 step / attempt / elapsedMs 的来源。
    const diagnostics: { last: ZhimoAttemptFailure | null } = { last: null }
    const res = await refreshZhimoCoverInto(folder, id, {
      onAttemptFailed: (failure) => {
        diagnostics.last = failure
        // 只有"还会再试"才单独记一条：日志能直接看出"抖了一下 → 重试"，
        // 不必从两条 `cover-failed` 的时间差去反推。
        if (failure.willRetry) {
          logWarn('zhimo:cover-retry', {
            id,
            reason: failure.reason,
            step: failure.step,
            attempt: failure.attempt,
            elapsedMs: failure.elapsedMs,
            totalMs: failure.totalMs
          })
        }
      }
    })
    if (!res.ok) {
      // `FetchZhimoCoverResult.reason` 在类型上是可选的（IPC 表面只有一种形状），
      // 但走到这里 `refreshZhimoCoverInto` 一定给了 reason；兜底只为收窄类型。
      const reason = res.reason ?? 'network'
      logWarn('zhimo:cover-failed', zhimoCoverFailLogContext(id, reason, diagnostics.last))
      return { ok: false, reason }
    }
    if (res.watermarked) {
      // 主路径（image6 无水印 400×300）成功时不会走到这里；走到说明站点把
      // `listImageUrl` 字段去掉了、只能用 image2 的带水印大图兜底。
      logWarn('zhimo:cover-watermarked', { id, host: res.sourceHost })
    }
    return res
  }
)

ipcMain.handle(IPC.rescan, () => rescanLibrary(settings.libraryDir))
ipcMain.handle(IPC.sevenZipPath, () => settings.sevenZipPath ?? findSevenZip())

// ── T04 新增：拖出 / 缩略图 / 磁盘 / 索引备份 ─────────────────────

/**
 * 拖出到 DCC（P0-14）。**必须是 `ipcMain.on` 不是 handle**：
 * `startDrag` 需要同步发起拖拽手势，invoke 的 Promise 往返会丢失手势上下文。
 *
 * ⚠️ 2026-10 闪退取证埋点（改动前请先读这段）：
 * 用户反馈「拖出的瞬间整个应用闪退」。进程级崩溃没有日志就无法定位，所以这里在
 * `startDrag` **前后各记一条 info**：
 *   - `drag:start`         → 进入 native drag 之前的现场（路径 / 图标档位 / 图标是否存在）
 *   - `drag:start:returned` → native 调用**返回之后**（同步调用，只是下一行代码）
 * 只有 before 没有 returned = 进程死在 `event.sender.startDrag()` 内部（native/Chromium 层），
 * 不是 JS 异常（JS 异常会被 uncaughtException 记下来且进程继续活着）。
 */
ipcMain.on(IPC.dragStart, (event, filePath: string, thumbName?: string | null, cardPng?: Uint8Array | null) => {
  if (!filePath) {
    logWarn('drag:start:empty-path')
    return
  }
  const startedAt = Date.now()
  const lib = path.resolve(settings.libraryDir)
  const abs = path.resolve(filePath)
  // 只允许拖出库目录内的文件（防渲染层被注入时拖出任意路径）
  if (!isWithinRoot(lib, abs, path.sep)) {
    console.warn('[idbox] drag:start 拒绝越界路径', filePath)
    logWarn('drag:start:rejected-outside-library', { filePath, libraryDir: lib })
    return
  }

  // 埋点 ①：native drag 之前的现场。这里必须把可能影响 startDrag 的东西都记下来。
  // v0.5.4：优先用渲染层 hover 预热好的卡片位图；没有/解码失败才回退缩略图 → resources → 内嵌。
  const card = resolveDragCard(cardPng)
  const icon = card ?? resolveDragIcon(thumbName)
  logInfo('drag:start', {
    abs,
    fileName: path.basename(abs),
    ext: path.extname(abs).toLowerCase(),
    sizeBytes: sizeBytesOrNull(abs),
    thumbName: thumbName ?? null,
    cardBytes: cardPng instanceof Uint8Array ? cardPng.byteLength : 0,
    iconKind: icon.kind,
    iconExists: icon.exists,
    iconPath: icon.path,
    senderId: event.sender?.id ?? null
  })
  // ⚠️ 必须**同步冲刷**：普通写入走 setTimeout(0) 队列，而 `startDrag` 是同步进入
  // native 拖拽循环的——若进程崩在 native 内部，事件循环再也不会转，排队的这一行
  // 就永远写不进磁盘，取证直接失效。这里多花不到 1ms，换"崩溃前现场一定在"。
  flushLogsSync()

  // 同步发起拖拽：若进程崩在 native 内部，下面这行之后的日志永远不会出现
  event.sender.startDrag({ file: abs, icon: icon.icon })

  // 埋点 ②：native 调用已返回（同步调用，能走到这里说明 JS 侧没有抛错）
  logInfo('drag:start:returned', {
    abs,
    iconKind: icon.kind,
    elapsedMs: Date.now() - startedAt
  })
  // 同理同步冲刷：保证 returned 也落盘，"只有 before 没有 returned" 才是可靠结论
  flushLogsSync()
})

ipcMain.handle(IPC.thumbEnsure, (_e, id: string, coverAbs: string | null) =>
  ensureThumb(id, coverAbs, { maxPx: settings.thumbMaxPx })
)

ipcMain.handle(IPC.thumbDelete, (_e, id: string) => deleteThumb(id))

/**
 * 单删一个缓存文件（材质球调参持久化，docs/12 §4.2「先建新再删旧」）。
 * `deleteThumb(id)` 是按 id 通配全删——若直接用它，会把该资产的封面缩略图一起删掉，
 * 且旧球图在新图落盘前被删会破坏「先建新」的顺序保证。故新开此通道，
 * 三道校验（文件名可解析 / id 匹配 / 落点在 thumbs 根内）在 `main/thumb.ts` 内完成。
 */
ipcMain.handle(IPC.thumbDeleteOne, (_e, id: string, name: string) =>
  deleteOneThumb(id, name)
)

ipcMain.handle(IPC.thumbPrune, (_e, liveIds: string[]) => pruneThumbs(liveIds ?? []))

ipcMain.handle(IPC.thumbClear, () => clearThumbs())

ipcMain.handle(IPC.thumbStats, () => thumbStats())

/**
 * **只读**列出缩略图缓存文件（2026-10 数据救援）。
 *
 * 用途：rescan 曾把 `thumbPath` 抹空而图片还在盘上——渲染层需要"盘上有什么"
 * 才能按 `<id>-<8hex>` 精确挂回（通用修复，取代硬编码对照表）。
 *
 * 安全边界：只读 `thumbsDir`，只回 `name/size/mtimeMs`，**不提供删除能力**；
 * 越界/解析失败/stat 失败的条目在 `listThumbFiles` 内静默跳过。
 */
ipcMain.handle(IPC.thumbList, () => listThumbFiles())

/**
 * HDR 预览准备（0.6.5）：流式解码 + 盒式降采样 + 落缓存。
 *
 * 为什么必须在主进程：用户样本 16384×8192 / 367MB。three 的 `HDRLoader` 在渲染进程
 * 会把它解成 Float32 ≈1.6GB，且 16384 正好是很多显卡的 `MAX_TEXTURE_SIZE` 上限 ——
 * 一律崩。这里只交出 ≤4096 宽的产物，渲染进程拿 `hdr://<key>.hdr` 读。
 *
 * 契约：
 * - **不抛错**：任何失败都返回 `{ ok:false, reason }`（reason 可直接给用户看）；
 * - 进度经 `hdr:progress` 单向推送，payload **必须带 path**（多资产并发时防串台），
 *   节流在解码器内部做（<0.1% 的变化不推）；
 * - `targetWidth` 只认 512/2048/4096，其他值夹到最近的（防渲染层传 16384 打爆主进程）。
 */
ipcMain.handle(
  IPC.hdrPrepare,
  async (_e, payload: { path?: unknown; targetWidth?: unknown } | undefined) => {
    const src = typeof payload?.path === 'string' ? payload.path : ''
    if (!src) return { ok: false, reason: '缺少 HDR 文件路径' }
    // ⚠️ 必须取 `extname` 再判：`isHdrExt` 接受的是**扩展名**（可带点），
    // 直接把整条路径传进去会永远 false（真机联调时踩过：弹窗只能显示"不是 HDR 文件"）。
    if (!isHdrExt(path.extname(src))) return { ok: false, reason: '不是 HDR / EXR 文件' }
    if (/\.exr$/i.test(src)) {
      return { ok: false, reason: '暂时只支持 RADIANCE .hdr 预览（OpenEXR 解码器尚未实现）' }
    }
    const targetWidth = normalizeTargetWidth(payload?.targetWidth)
    try {
      const st = await fs.stat(src)
      if (!st.isFile()) return { ok: false, reason: '不是一个文件' }
      const res = await prepareHdrFile({
        filePath: src,
        cacheDir: hdrCacheDir(),
        targetWidth,
        onProgress: (ratio) => {
          win?.webContents.send(IPC.hdrProgress, { path: src, ratio })
        }
      })
      logInfo('hdr:prepare', {
        path: src,
        targetWidth,
        width: res.width,
        height: res.height,
        fromCache: res.fromCache
      })
      return { ok: true, ...res }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logWarn('hdr:prepare-failed', { path: src, targetWidth, message })
      return { ok: false, reason: message }
    }
  }
)

/**
 * 材质球离屏渲染图落盘（2026-10，任务 6）。
 *
 * 渲染进程 `renderBallToPng`（three.js 离屏渲一帧，**透明背景 PNG**）产出 Blob →
 * base64 → 这里写进 thumbs 目录，文件名 `ballThumbName(assetId, slots, params, shape)`
 * （与既有缩略图同格式，delete/prune/stats 自动覆盖）。网格只读 `vault://thumb/<name>`，
 * **永不开 WebGL**。
 *
 * 为什么是 PNG：透明背景让卡片 `bg-canvas` 透出来，深浅两个主题共用同一个缓存文件
 * 都正确（JPEG 无 alpha 通道，只能把纸色烤进像素 → 深色主题下是亮白方块）。
 *
 * 安全：① assetId 合法（单段、无路径分隔符）；② base64 先按字符串长度预检再 decode，
 * 且 decode 后仍校验 ≤5MB；③ 落点在 thumbs 目录内（isWithinRoot）。失败一律 null。
 */
ipcMain.handle(IPC.saveBallThumb, async (_e, payload: SaveBallThumbPayload) => {
  if (!payload?.assetId || !payload.base64) return null
  if (!validateBallImageBase64(payload.base64)) return null
  try {
    const buf = Buffer.from(payload.base64, 'base64')
    if (buf.length > MAX_BALL_IMAGE_BYTES) return null
    // params 是第 5 参、shape 是第 6 参（第 4 参 thumbsRoot 保持默认值）——
    // `saveBallThumbBytes` 内部会 `normalizeParams` 后再进 hash，与渲染进程同一口径
    // （docs/12 §3.4）。shape 只影响非球面的名字，存量球面缓存名不受影响。
    return await saveBallThumbBytes(
      payload.assetId,
      payload.slots ?? {},
      buf,
      thumbsDir(),
      payload.params,
      payload.shape
    )
  } catch (err) {
    console.error('[idbox] thumb:saveBall 写盘失败：', payload.assetId, err)
    logError('thumb:saveBall-failed', err, { assetId: payload.assetId })
    return null
  }
})

/**
 * 尺寸**回填**（2026-10「分辨率筛选在材质与 HDR 都失效」）。
 *
 * 老库的资产从没采过 `w/h`（0.6.0 起才在导入时采集），所以这里给渲染层一条
 * **只读探测**通道：它只读文件头（64KB）、不解码整图，也不做任何回填调度 ——
 * 什么时候探、怎么落库全由调用方决定。
 *
 * 安全边界（与 `drag:start` / `setCoverImage` 同口径）：`folder` 必须 resolve 后
 * 位于库目录内。核心模块 `probeSizes` **故意不做**这条校验（它只认 folder 字符串），
 * 所以 IPC 这层是唯一的防线，越界一律返回空数组（IPC 表面只有一种形状）。
 */
ipcMain.handle(IPC.probeSizes, async (_e, folder: string, rels: string[]) => {
  if (typeof folder !== 'string' || folder.length === 0) return []
  if (!Array.isArray(rels)) return []

  const lib = path.resolve(settings.libraryDir)
  const target = path.resolve(folder)
  if (!isWithinRoot(lib, target, path.sep)) {
    console.warn('[idbox] [probeSizes] 拒绝越界资产目录：', folder)
    logWarn('probe-sizes:rejected-outside-library', { folder })
    return []
  }

  try {
    return await probeSizes(target, rels.filter((r): r is string => typeof r === 'string'))
  } catch (err) {
    // probeSizes 内部已逐条静默容错，走到这里只可能是意料之外（如 settings 未就绪）
    console.error('[idbox] [probeSizes] 探测失败：', target, err)
    logWarn('probe-sizes:failed', { folder: target })
    return []
  }
})

ipcMain.handle(IPC.diskFree, (_e, dir: string | null) => freeBytesOf(dir ?? settings.libraryDir))

/**
 * 索引快照导出（P0-6）：渲染进程把 Dexie 里的资产 JSON 传过来，
 * 主进程弹保存对话框并落盘（渲染进程无权写任意路径）。
 */
ipcMain.handle(IPC.indexBackup, async (_e, json: string) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const r = await dialog.showSaveDialog(win!, {
    title: '导出素材库索引快照',
    defaultPath: `idbox-index-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return null
  try {
    await fs.writeFile(r.filePath, json ?? '', 'utf-8')
    return r.filePath
  } catch {
    return null
  }
})

// ── T06 新增：分类指派 / 遗留布局迁移 ─────────────────────────────

/**
 * 校验大类目录名是否合法（防渲染层传任意路径当父目录）。
 *
 * ⚠️ 必须用 `isKindFolderName`（= `Object.values(KIND_FOLDER)` + 历史别名），
 * **不能**再用 `KIND_LABEL` 的值集合做白名单：材质大类合并后目录名是「材质」，而
 * `KIND_LABEL.texture` 仍是「贴图」（显示名）——用显示名做白名单会把「材质」
 * 判成非法，导致**指派分类整条链路静默失效**（返回 null，UI 只表现为"没反应"）。
 * 见 docs/14 §2.1 #13 / §9 RM1。
 */
function kindFolderNameOf(name: string): string | null {
  return isKindFolderName(name) ? name : null
}

/**
 * 指派分类（06 §12.1 `asset:assignCategory`，03 §5.1 顺序：先磁盘后索引）。
 *
 * 只负责**移动目录**；缩略图重生（RA3：先生成新、再通配删旧）与 Dexie 更新由渲染层做。
 * 返回 null = 入参不合法或源目录不存在（渲染层跳过该资产并汇总提示）。
 */
ipcMain.handle(IPC.assignCategory, async (_e, payload: AssignCategoryPayload) => {
  if (!payload?.folder || !payload.kindFolderName) return null
  // 大类目录名必须是合法大类目录（`KIND_FOLDER` 的值 + 历史别名），防渲染层传任意路径
  const kindName = kindFolderNameOf(payload.kindFolderName)
  if (!kindName) return null


  const pair = normalizeCategoryPair(payload.category1, payload.category2)
  const parent = path.join(settings.libraryDir, kindName, pair.category1, pair.category2)

  let moved
  try {
    moved = await moveAssetCategory(payload.folder, parent)
  } catch {
    return null
  }

  return {
    folder: moved.folder,
    name: moved.name,
    relFolder: composeRelFolder(kindName, pair.category1, pair.category2, moved.name),
    category1: pair.category1,
    category2: pair.category2,
    // T08 self-target 守卫：资产已在目标分类下时 moved=false（no-op，渲染层可据此计入 skipped）
    moved: moved.moved,
    renamed: moved.renamed,
    changed: pair.changed
  } satisfies AssignCategoryResult
})

ipcMain.handle(IPC.migrateLayout, async (_e, assets: Asset[]) => {
  const plan = planLayoutMigration(assets ?? [], settings.libraryDir)
  return applyLayoutMigration(plan.moves)
})

// ── 2026-10-19 材质大类合并（docs/14 §2.3，T-03） ──────────────────────
//
// 主进程只负责**磁盘**：plan/apply/manifest/rollback。Dexie 在渲染层，
// 所以返回值必须携带最终落盘值（`to` / `relFolderTo` / `assetId`），由渲染层在
// 单个事务里 put 局部字段。main 绝不 delete+put（拿不到 DB，也不该拿）。

/** 只读探测：库里是否还有 `贴图/` / `材质预设/` 待合并（零写入，不建 `.idbox`） */
ipcMain.handle(IPC.detectMaterialMerge, async () => {
  return detectMaterialMerge(settings.libraryDir)
})

/**
 * 执行迁移。入参两道校验（防渲染层被注入后传任意路径）：
 * ① 库根只取 `settings.libraryDir`，**不接受渲染层传入**；
 * ② `assets` 白名单里的 `folder` 必须 resolve 后仍在库内（否则丢弃该项，只是少一条回滚凭据，
 *    不影响磁盘路径决策——路径全部由 plan 从库根重新推导）。
 */
ipcMain.handle(IPC.mergeMaterial, async (_e, raw?: MergeMaterialPayload) => {
  const lib = path.resolve(settings.libraryDir)
  const refs: MergeMaterialAssetRef[] = []
  if (Array.isArray(raw?.assets)) {
    for (const r of raw.assets) {
      if (!r || typeof r !== 'object') continue
      const item = r as Partial<MergeMaterialAssetRef>
      if (typeof item.id !== 'string' || !item.id) continue
      if (typeof item.folder !== 'string' || !item.folder) continue
      if (!isWithinRoot(lib, path.resolve(item.folder), path.sep)) continue
      refs.push({
        id: item.id,
        folder: item.folder,
        relFolder: typeof item.relFolder === 'string' ? item.relFolder : ''
      })
    }
  }
  return mergeMaterial(lib, { force: raw?.force === true, assets: refs })
})

/**
 * 回滚（P2 UI，函数已可用）。manifestPath 必须落在本库的
 * `<库根>/.idbox/merge-material/` 内且是 `.json` —— 防任意文件读写。
 */
ipcMain.handle(IPC.rollbackMaterialMerge, async (_e, manifestPath: unknown) => {
  const dir = manifestDirOf(settings.libraryDir)
  if (typeof manifestPath !== 'string' || !manifestPath) {
    return { restored: [], restoredCount: 0, failures: [{ from: '', reason: 'manifest 路径为空' }], manifestPath: '' }
  }
  const abs = path.resolve(manifestPath)
  if (!isWithinRoot(path.resolve(dir), abs, path.sep) || !abs.toLowerCase().endsWith('.json')) {
    return {
      restored: [],
      restoredCount: 0,
      failures: [{ from: '', reason: 'manifest 路径不在本库迁移记录目录内' }],
      manifestPath
    }
  }
  return rollbackMaterialMerge(abs, settings.libraryDir)
})

// ── 2026-10 UI 规范 v0.2：无边框窗口控制（§3.1/§4-2）+ 应用版本 ──────────
//
// 窗口控制走 `ipcMain.on`（send，fire-and-forget）：无返回值需求，
// invoke 的 Promise 往返纯属浪费；最大化切换后经 `win:maximizedChanged` 广播，
// 渲染层 WindowControls 据此切 □ / ❐ 图标。

ipcMain.on(IPC.winMinimize, () => {
  win?.minimize()
})

ipcMain.on(IPC.winMaximizeToggle, () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})

ipcMain.on(IPC.winClose, () => {
  win?.close()
})

/** 设置·关于 tab 的版本胶囊 / tab 栏左下角小字（§3.6） */
ipcMain.handle(IPC.getAppVersion, () => app.getVersion())

// ── 2026-10 自动检查更新（GitHub Releases，关于页） ────────────────────
//
// 为什么缓存放主进程而不是渲染层：
// ① 渲染层有两个入口（启动自动检查 + 设置页「立即检查」），天然会重复请求；
// ② 主进程是单例，缓存天然全局；GitHub 未认证限流 60 次/小时/IP，必须省着用；
// ③ **失败不写缓存** —— 断网时用户点「立即检查」应当真的重试一次，
//    而不是拿到 10 分钟前的失败结论（否则用户会以为"永远修不好了"）。
// 同一时刻的并发请求合并到一个 in-flight Promise（启动检查 + 用户立刻点按钮只发一次）。
const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000
let updateCache: UpdateInfo | null = null
let updateInFlight: Promise<UpdateInfo> | null = null

function checkUpdateWithCache(force: boolean): Promise<UpdateInfo> {
  const now = Date.now()
  if (!force && updateCache && now - updateCache.checkedAt < UPDATE_CACHE_TTL_MS) {
    return Promise.resolve(updateCache)
  }
  if (updateInFlight) return updateInFlight
  const current = app.getVersion()
  updateInFlight = fetchLatestRelease({ current })
    .then((info) => {
      // 只缓存成功结论；失败留空 → 下次调用真的重试
      updateCache = info.error === null ? info : null
      logDebug('update:checked', {
        current: info.current,
        latest: info.latest,
        hasUpdate: info.hasUpdate,
        error: info.error
      })
      return info
    })
    .catch((err: unknown) => {
      // fetchLatestRelease 契约上**从不抛错**；这里是最后一道保险：
      // 无论如何都要给渲染层一个结构完整的 UpdateInfo，绝不把异常穿过 IPC。
      logWarn('update:check 意外异常', err)
      updateCache = null
      const fallback: UpdateInfo = {
        current,
        latest: null,
        hasUpdate: false,
        url: null,
        assetUrl: null,
        publishedAt: null,
        checkedAt: Date.now(),
        error: 'network'
      }
      return fallback
    })
    .finally(() => {
      updateInFlight = null
    })
  return updateInFlight
}

ipcMain.handle(IPC.checkUpdate, (_e, force: unknown) => checkUpdateWithCache(force === true))

/**
 * 用系统默认浏览器打开外链（「去下载」）。
 * 与 `openPath` 分开：`shell.openPath` 面向本地路径，喂 URL 在 Windows 上会返回错误串。
 * **只放行 http(s)**：防止渲染层被注入后借 `file://` / 自定义协议拉起本机程序。
 */
ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
  try {
    await shell.openExternal(url)
    return true
  } catch (err) {
    logWarn('openExternal 失败', err)
    return false
  }
})

// ── 2026-10 诊断日志（崩溃取证 + 用户自助导出） ────────────────────────
//
// 三条通道：
//   logWrite  ← 渲染进程 send（fire-and-forget，渲染层已做去重/限流）
//   logStats  → 设置页展示目录 / 文件数 / 总大小
//   logExport → 弹保存对话框，把 logs 目录打成 zip
//
// 主进程对渲染层传入的内容**只做类型收紧**（不信任 message 长度/level 取值），
// 落盘前统一走 logger 的脱敏（apiKey / Authorization / token → ***）。

ipcMain.on(IPC.logWrite, (_e, payload: RendererLogPayload) => {
  logFromRenderer(payload)
})

ipcMain.handle(IPC.logStats, () => logStats())

ipcMain.handle(IPC.logExport, async (): Promise<LogExportResult> => {
  const r = await dialog.showSaveDialog(win!, {
    title: '导出诊断日志',
    defaultPath: logExportFileName(),
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
  })
  // 用户取消不是错误：返回 canceled，渲染层不提示失败
  if (r.canceled || !r.filePath) return { canceled: true, path: null, files: 0 }
  try {
    const files = await exportLogsTo(r.filePath)
    logInfo('log:export', { path: r.filePath, files })
    return { canceled: false, path: r.filePath, files }
  } catch (err) {
    logError('log:export 失败', err, { path: r.filePath })
    return { canceled: false, path: null, files: 0 }
  }
})

// ── 2026-10-19 AI 辅助分类（docs/15 §7）─────────────────────────────
//
// 为什么在主进程发请求：渲染进程受 CORS / CSP 限制，用户自接的服务通常不带
// `Access-Control-Allow-Origin`。这里只做两条通道：批量分类 + 测试连接。
//
// handler 侧三道闸门（渲染层不可信）：
// ① `names` 必须是字符串数组、逐项去空白、截断到 `AI_CLASSIFY_MAX_NAMES`；
// ② **未启用或 baseUrl 为空 → 直接返回空结果，不发任何网络请求**；
// ③ 密钥只从**主进程 settings** 读取（不接受渲染层传入的 apiKey，避免 XSS 后外带）。

ipcMain.handle(IPC.aiClassify, async (_e, payload: AiClassifyPayload | undefined) => {
  const rawNames = Array.isArray(payload?.names) ? payload.names : []
  const names = rawNames
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .slice(0, AI_CLASSIFY_MAX_NAMES)
  if (names.length === 0) {
    return { items: [], failedNames: [], error: null }
  }
  if (!settings.aiClassify.enabled || !settings.aiClassify.baseUrl.trim()) {
    return { items: names.map(() => null), failedNames: [], error: null }
  }
  return aiClassifyDetailed({ names, settings: settings.aiClassify })
})

ipcMain.handle(
  IPC.aiClassifyTest,
  (_e, raw: Partial<AiClassifySettings> | undefined) => {
    // 只取四个已知字段；缺省回落到已保存值（允许「先测通再保存」）
    const merged = normalizeAiClassify({
      enabled: raw?.enabled ?? settings.aiClassify.enabled,
      baseUrl: raw?.baseUrl ?? settings.aiClassify.baseUrl,
      apiKey: raw?.apiKey ?? settings.aiClassify.apiKey,
      model: raw?.model ?? settings.aiClassify.model
    })
    return testAiConnection(merged)
  }
)
