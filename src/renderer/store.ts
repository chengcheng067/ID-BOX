import { create } from 'zustand'
import { useMemo } from 'react'
import { db, type IndexBackup } from './db'
import type {
  Asset,
  AssetFile,
  BallRenderShape,
  ClassifyReview,
  ColorTag,
  CoverSource,
  FetchZhimoCoverResult,
  FetchZhimoMetaResult,
  ImportConflictAnswer,
  ImportConflictAsk,
  ImportEvent,
  MergeMaterialDetectResult,
  MergeMaterialSource,
  SavedView,
  Settings,
  ThumbStatus
} from '../shared/types'
import { baseNameOf, dedupeKeyOf, normalizeCategoryPair, zhimoIdFromSources, zhimoIdOf } from '../shared/naming'
import { kindFolder } from '../shared/classify'
import { UNCLASSIFIED } from '../shared/taxonomy'
import { classifyAssetName } from '../shared/classifyAsset'
import {
  DEFAULT_FILTERS,
  applyFilters,
  filtersFromSavedView,
  normalizeRating,
  sanitizeFiltersForKind,
  snapshotFilters,
  sortAssets,
  type Filters,
  type LibraryView,
  type SortKey
} from './logic/filters'
import { dedupeIds, pruneToVisible, selectRangeIds } from './logic/selection'
import { isDeletedAsset } from './logic/trashView'
import { buildTriageQueue } from './logic/triageFlow'
import { buildReviewQueue, type ReviewReason } from './logic/reviewFlow'
import { planDuplicateCleanup, planThumbPresenceRepair } from './logic/recordHygiene'
import { planCoverSelfHeal } from './logic/coverSelfHeal'
import { assetFileAbs } from './logic/assetPath'
import { toDeleteTargets, type DeleteTarget } from './logic/deleteFlow'
// 删除撤销期三档（0 / 3000 / 5000）：用户可在设置·数据与备份里改。
// `graceMs` 已是 `pendingDelete` 的字段，所以这里只负责**取值**，纯函数的默认参数
// （`DELETE_GRACE_MS`）保持不动，避免既有 import 炸掉。
import { normalizeUndoGraceMs } from '../shared/undoGrace'
import {
  countCustomUsage,
  sanitizeCustomTerm
} from '../shared/customTaxonomy'
import type { CustomTaxonomy } from '../shared/types'
import { isLegacyLayout, planLegacyMoves, categoriesOf } from './logic/category'
import { reconcile, type ReconcileReport } from './logic/reconcile'
import {
  ASSIGN_GRACE_MS,
  buildAssignUndo,
  categoryPairLabel,
  groupAssignUndo,
  type AssignUndoRecord
} from './logic/dragAssign'
import { effectiveMaterialSlots, hasMaterialSlots } from './logic/materialBall'
import {
  ballThumbName,
  normalizeParams,
  paramsKey,
  resolveRenderParams,
  resolveRenderShape,
  type BallParamScales
} from '../shared/ballParams'
import { withAssetCoverLock } from './logic/coverLock'
import {
  hasCoverAssetFile,
  isZhimoCoverBackfillCandidate,
  isZhimoCoverKind,
  pickZhimoCoverTargets,
  runZhimoCoverQueue,
  zhimoCoverFailText,
  zhimoCoverIdOf,
  type ZhimoCoverQueueResult,
  type ZhimoCoverTarget
} from './logic/zhimoCover'
import { resolveZhimoStyle } from './logic/zhimoStyle'
import {
  ZHIMO_RECLASS_BACKUP_PREFIX,
  groupByCategoryPair,
  isZhimoVerifyCandidate,
  parseCategoryPairKey,
  planZhimoVerify,
  runZhimoReclassQueue,
  zhimoReclassIdOf,
  zhimoReclassSummaryText,
  type ZhimoReclassLogContext,
  type ZhimoReclassProgress,
  type ZhimoReclassTarget
} from './logic/zhimoReclass'
import { buildDedupeSnapshot } from './logic/importConflict'
import {
  applyThumbRescue,
  planRenderParamsRestore,
  planThumbRescue,
  RESCUE_PREFER
} from './logic/thumbRescue'
import {
  isTerminalStatus,
  junkCleanupSummaryText,
  overwriteSummaryText,
  skippedSummaryText
} from './logic/importText'

export type { Filters, SortKey, KindFilter } from './logic/filters'

/**
 * 导入重复处置（docs/27 T-06）的**模块级**状态。
 *
 * 为什么不在 store 里：
 * ① `onImportConflictAsk` 的订阅只能注册一次（重复注册 = 一次询问被处理多次）；
 *    放在 store 状态里每次 init 都会重订，必须由模块级的"已订阅"标志兜住；
 * ② 批次计数是"当前批次的临时账"，不是 UI 状态——批次结束即归零，不该进 store 快照
 *    （否则每条跳过 / 覆盖都触发全库订阅者重渲染）。
 */
/** 已注册的退订函数（下标 0 = ask / 1 = expired）；非空 = 已订阅，保证只订一次 */
let conflictUnsubscribers: Array<() => void> = []
let skippedInBatchCount = 0
/** 本批次 `resolution='overwrite'` 的条数（含退化分支） */
let overwrittenInBatchCount = 0
/** 其中走了退化路径的条数（`ImportEvent.conflict.degraded === true`：旧版没进回收站） */
let overwrittenDegradedCount = 0

/**
 * 本批**物理删除**的杂质文件数（`ImportEvent.cleanedJunk.length` 之和）。
 *
 * 0.9.0 起导入会 `fs.rm` 掉包里的推广件 / 说明网页（见 `shared/junkCleanup.ts`）。
 * 删除不可逆、不进回收站，所以批次结束必须给一条汇总回执 —— 否则用户发现包里
 * 少了文件却不知道是谁删的。
 *
 * 消费型（`flushJunkSummary` 读后归零），与 `skippedInBatchCount` 同款：
 * 逐条事件只累加，**绝不在这里发任何提示**。
 */
let cleanedJunkInBatchCount = 0

/**
 * 本批**真正落库**的素材数（`status === 'done'` 的事件计数）。
 *
 * 只为批次汇总的文案（"本批 N 个素材"）服务：`import:event` 逐条到达时累加，
 * 由 `reportReviewSummary()` **消费后归零**（消费型，与 `skippedInBatchCount` 同款）。
 *
 * ⚠️ **不在 `import:batchDone` 里复位**：那个回调正是知识末流水线的起点，
 * 而汇总要等流水线跑完（几分钟）才发 —— 在批次边界清零会让 `N` 永远是 0。
 */
let importedInBatchCount = 0

/**
 * 本批交叉验证判为 `conflict` 的条数（消费型，见 `reportReviewSummary`）。
 *
 * 由 `runZhimoCategoryReclass` 的**自动路径**累加（手动重排的数字不属于"本批导入"）。
 */
let conflictsInBatchCount = 0

/**
 * 本批「站方单源」（`medium-s2`）已搬的条数（消费型）。
 *
 * 语义是 `ZhimoReclassSummary.unverified`：**`moved` 的子集**，回答"这批里有多少条
 * 是没被第二源验证就搬了"。只在"本批没有存疑、但有单源搬运"时用于提示。
 */
let unverifiedInBatchCount = 0

/**
 * 正在跑（或排队中）的知末后置流水线条数。
 *
 * 只为一件事：让批次汇总（`reportReviewSummary`）**只由最后一条退出流水线的那次**发。
 * 详见 `scheduleZhimoPipeline` 的注释 —— 无此计数时，被重入锁立刻挡掉的那一次会把
 * 本批计数提前消费掉，用户永远看不到「本批 N 个分类存疑」。
 */
let pipelineInFlight = 0

/**
 * 批次级「分类存疑」汇总（`docs/35 §4.3 入口②` · R-11）。
 *
 * ## 为什么绝不可能逐包发（本函数存在的第一理由）
 *
 * 用户原话是"弹窗提示"，但一次拖 50 个包会弹 50 次。所以汇总点**只挂在
 * `scheduleZhimoPipeline()` 的收尾**（批次级事件 `import:batchDone` 之后、流水线跑完），
 * **绝不挂在 `onImportEvent` 的逐条回调里** —— 那是"拖 50 个包弹 50 次"的写法。
 * 改这一处之前先读 `docs/35 §4.3 入口②` 与 R-11。
 *
 * ## 为什么不用全库数
 *
 * 全库的 conflict 数是用户历史上积压的，每次导入都报一遍会变成噪音（用户对
 * 每条导入 toast 都读一次，久了就整体忽略）。所以三个数字都是**本批增量**：
 * `importedInBatchCount` / `conflictsInBatchCount` / `unverifiedInBatchCount`。
 *
 * ## 为什么走 `enqueueNotice` 而不是新造 modal
 *
 * ① 模态阻断：用户批量导入 50 个包后可能立刻去干别的，一个必须点掉的 modal 是打扰；
 * ② `enqueueNotice` 已经解决了"多条批次汇总互不吞并"（队列 + 逐条 4.5s），
 *    另起一个弹窗等于把并发展示问题重写一遍；
 * ③ 已有 Esc 层级栈（Quick Look / 整理浮层 / 分类弹窗）再加一层要重排优先级。
 *
 * ## 文案（`M` = 本批存疑，`K` = 本批站方单源搬的）
 *
 * | 情况 | 文案 |
 * |---|---|
 * | `M > 0` | `本批 N 个素材，其中 M 个分类存疑 → 点侧栏「待确认」处理` |
 * | `M === 0 && K > 0` | `本批 N 个素材已分类，其中 K 个仅据知末分类` |
 * | `M === 0 && K === 0`（或本批没有落库素材） | **不发** |
 */
function reportReviewSummary(): void {
  const imported = importedInBatchCount
  const conflicts = conflictsInBatchCount
  const unverified = unverifiedInBatchCount
  // 先消费再判断：无论发不发，这三个计数都只属于这一批
  importedInBatchCount = 0
  conflictsInBatchCount = 0
  unverifiedInBatchCount = 0
  // 本批没有素材落库（设置页手动重排 / 监控目录空扫描）→ 没什么可汇总的
  if (imported <= 0) return
  if (conflicts > 0) {
    enqueueNotice(`本批 ${imported} 个素材，其中 ${conflicts} 个分类存疑 → 点侧栏「待确认」处理`)
    return
  }
  if (unverified > 0) {
    enqueueNotice(`本批 ${imported} 个素材已分类，其中 ${unverified} 个仅据知末分类`)
  }
}

/**
 * 本批导入是否**已经**把视图从「最近删除」切回资产视图（**一批只切一次**）。
 *
 * 为什么不放 store：它是"当前这一批"的临时账，批次结束即复位，不属于 UI 快照
 * （放进 store 会让每条 `done` 都触发一次全库订阅者重渲染）。
 *
 * 复位点有两处，缺一不可：
 * - `importPaths()` 入口：UI 导入（拖入 / 选择文件）在有资产落库之前就先把闩锁打开；
 * - main 的 `import:batchDone` 回调：监控目录导入**不走** `importPaths`，只有批次结束
 *   事件能给它复位（且 main 保证该事件在整批 `import:event` 之后才发，不会提前放开）。
 *
 * 语义：一旦本批的某个 `done` 已经拿到过"切不切"的决定权（无论当时是不是已经在资产视图），
 * 后续 `done` 都不再抢 —— 这正是"用户中途手动切回回收站，本批不再抢"的实现方式。
 */
let libraryViewRestoredInBatch = false

/**
 * 「询问过期」看门狗（DEF-19-1 兜底）：
 *
 * 正常路径是主进程超时后推 `import:conflictExpired`（见 `ensureConflictAskSubscribed`），
 * 渲染层据此清 `conflictAsk`。这个计时器是**最后一道保险**——万一那条事件没到
 * （旧主进程 / 消息丢失 / 主进程在超时瞬间异常），`conflictAsk` 仍会永久残留，
 * 弹窗又变成"点得动但永不生效"的僵尸。
 *
 * 取值 = 主进程 `CONFLICT_ASK_TIMEOUT_MS`（`main/index.ts:170` = 120_000）**+ 1s 余量**，
 * 确保主进程（唯一权威）先兜底。文案与 expired 事件**完全一致**，两条路径不会互相矛盾；
 * 先到的那条把 `conflictAsk` 清空，后到的看到 null 就什么都不做（幂等）。
 * 用户答复 / 主动关闭时立即撤表。
 */
const CONFLICT_ASK_WATCHDOG_MS = 121_000
let conflictAskWatchdog: ReturnType<typeof setTimeout> | null = null

/** 超时的统一提示（expired 事件与看门狗共用，别写两份文案） */
const CONFLICT_EXPIRED_NOTICE = '已超时未答复，本次重复项已全部按跳过处理'

function clearConflictAskWatchdog(): void {
  if (conflictAskWatchdog !== null) {
    clearTimeout(conflictAskWatchdog)
    conflictAskWatchdog = null
  }
}

function armConflictAskWatchdog(requestId: string): void {
  clearConflictAskWatchdog()
  conflictAskWatchdog = setTimeout(() => {
    conflictAskWatchdog = null
    clearExpiredAsk(requestId)
  }, CONFLICT_ASK_WATCHDOG_MS)
}

/**
 * 清掉一条**已作废**的询问（expired 事件与看门狗共用；事件是权威路径，看门狗只是兜底）。
 *
 * - `requestId` 必须与当前 `conflictAsk` 相等才清：迟到的作废绝不能把**下一次**询问关掉；
 * - 当前本来就是 null → 直接 return：这同时是"同一 requestId 只入队一次提示"的闸门
 *   （事件与看门狗都可能触发，先到的清空 + 入队，后到的看到 null 什么都不做）；
 * - 提示**走 `enqueueNotice()` 而不是裸写 `notice`**：同一批次的「已跳过 N 个重复素材，
 *   原文件保留在原位」等汇总也走这条队列，裸写会把正在展示的那条顶掉。
 *   实际到达顺序由主进程钉死：`send(importConflictExpired)` 在 `resolve(null)` **之前**，
 *   所以渲染层先收到作废事件 → 「超时」提示立即展示；随后该条被 skip、`batchDone` 到达
 *   → 批次汇总入队，4.5s 后才轮到。两条都会出现（顺序不人为调整：宁可保证"一定说出口"）。
 */
function clearExpiredAsk(requestId: string): void {
  const current = useVault.getState().conflictAsk
  if (!current || current.requestId !== requestId) return
  clearConflictAskWatchdog()
  useVault.setState({ conflictAsk: null })
  enqueueNotice(CONFLICT_EXPIRED_NOTICE)
}

/**
 * 订阅「导入发现重复，请裁决」+「询问已作废」（幂等：进程内只注册一次）。
 *
 * 必须幂等的原因：`init()` 在开发模式（React StrictMode / HMR）与"重扫后重建"路径上
 * 都可能被调用多次；若每次都 `ipcRenderer.on`，主进程发来的**同一次询问**会被
 * 多个 handler 依次处理 → 弹窗状态被覆盖、答复被发出多次。两个通道共用一个守卫，
 * 退订函数全部模块级保存。
 */
export function ensureConflictAskSubscribed(): void {
  if (conflictUnsubscribers.length > 0) return
  conflictUnsubscribers = [
    window.modvault.onImportConflictAsk((ask) => {
      useVault.setState({ conflictAsk: ask })
      armConflictAskWatchdog(ask.requestId)
    }),
    // 主进程 120s 超时是**单方面**结束（内部 resolve(null) = 全跳过），这条事件
    // 是它唯一会回推的通知；不是自己答复的场合，只有它能证明"这条询问已经作废"。
    window.modvault.onImportConflictExpired((ev) => {
      clearExpiredAsk(ev.requestId)
    })
  ]
}

/**
 * 设置广播（`settings:changed`）的**幂等订阅守卫**（DEF-22-1）。
 *
 * 与 `conflictUnsubscribers` 同一手法，但**必须独立**一个标志：两者生命周期不同
 * （冲突询问的订阅一旦建立就永不需要重建；设置订阅同理，但绝不能因为
 * 「冲突那条已经订阅过了」就把设置那条也跳过）。
 *
 * 为什么必须幂等：`init()` 有重入闸门，但闸门只挡「同时进行中的第二次调用」，
 * 挡不住**跑完之后再跑**（rescan 重建、单测逐条 init、未来 HMR 重挂）。
 * 每次 init 都 `ipcRenderer.on` 一次 → 主进程推来一条设置变更会被 N 个 handler 处理 N 次
 * （`set({settings})` 是幂等的，所以用户看不出来；但订阅数会线性泄漏，
 * 而单测里"广播只被处理一次"这条断言会直接钉住它）。
 */
let settingsChangedSubscribed = false

/**
 * 仅供单测：复位设置广播订阅守卫。
 *
 * ## 🚫 只给单测用 —— 运行时**不允许**调用（硬约束，不是建议）
 *
 * `src/renderer/` 下的生产代码**一律不许** import 本函数。目前全仓调用点只有
 * `tests/settingsBroadcast.test.ts` 的 `beforeEach`（每条用例前复位，否则前一条留下的
 * `true` 会让后一条的 `init()` 直接跳过订阅、测试假绿）。
 *
 * 运行时不能用的原因：复位只把标志打回 false、**不会**退订已注册的 handler
 * （订阅时返回的 `off` 没有保存）。于是下一次 `init()` 会再挂一个 handler →
 * 同一条广播被处理 N 次。`set({settings})` 恰好幂等，所以用户看不出来；
 * 但订阅数会随每次误用线性泄漏，而且是**进程内不可回收**的
 * （handler 挂在 `ipcRenderer` 上，没有引用就永远摘不掉）。
 *
 * TODO（将来若主进程热重启 / 渲染进程不重载但 IPC 桥重建，需要运行时重建订阅时）：
 * **`settingsChangedSubscribed` 必须跟着复位**，但**不能**靠直接调本函数 ——
 * 必须让 `ensureSettingsChangedSubscribed()` 把 `onSettingsChanged` 返回的 `off` 存到
 * 模块级变量，新的 reset 改成「先 `off()` 再清标志」。否则就是上面说的泄漏。
 */
export function resetSettingsBroadcastForTests(): void {
  settingsChangedSubscribed = false
}

/** 订阅「主进程改写了设置」。幂等 —— 进程内只注册一次。 */
function ensureSettingsChangedSubscribed(): void {
  if (settingsChangedSubscribed) return
  settingsChangedSubscribed = true
  window.modvault.onSettingsChanged((next) => {
    // 直接落 store，**不重读盘**：广播携带的就是主进程写盘后归一化的那一份。
    // 重读一次 getSettings 只会多一次 IPC，还可能读到更晚的第三次写入 —— 界面跳一下。
    useVault.setState({ settings: next })
  })
}

/**
 * 底部 toast 的展示时长，与 `NoticeToast.tsx` 的 `setTimeout(..., 4500)` 一致。
 * 只有"需要排队"时才会用到这个值（见 `enqueueNotice`）。
 */
const NOTICE_SHOW_MS = 4500

/** 待展示的 toast 文案（顺序即发生顺序） */
const noticeQueue: string[] = []
let noticeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 把一条 toast 排进队列并立刻尝试展示（同一批次可能同时有"跳过"和"覆盖"两条汇总）。
 *
 * 为什么要队列：`notice` 是单字段，直接连写两次 `set({ notice })` 在同一个 tick 里
 * 只有最后一条能看见 —— 两条汇总互不吞并必须靠**依次展示**（每条 4.5s）。
 * `NoticeToast` 的自动消失逻辑不受影响（它只看当前 `notice`）。
 *
 * 自愈：若排期期间「正在展示的那条」已被清空（用户关掉 / 4.5s 到 / 别处 setNotice），
 * 就立即续上下一条，不会白等 4.5 秒。
 */
function enqueueNotice(text: string): void {
  noticeQueue.push(text)
  drainNoticeQueue()
}

function drainNoticeQueue(): void {
  if (noticeTimer !== null) {
    // 正在展示中：等它到点（下面是续排逻辑）
    if (useVault.getState().notice !== null) return
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  const next = noticeQueue.shift()
  if (next === undefined) return
  useVault.setState({ notice: next })
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    drainNoticeQueue()
  }, NOTICE_SHOW_MS)
}

/**
 * 批次结束：把本轮跳过数汇总成一条 toast（docs/27 §3.1）。
 * 文案：`已跳过 N 个重复素材，原文件保留在原位`；N=0 不发。
 */
function flushSkippedSummary(): void {
  const n = skippedInBatchCount
  skippedInBatchCount = 0
  const text = skippedSummaryText(n)
  if (text) enqueueNotice(text)
}

/**
 * 批次结束：把本轮覆盖数汇总成一条 toast。
 *
 * 为什么覆盖也要汇总（而不是只靠导入队列明细）：覆盖**有副作用**——旧版本要去系统回收站，
 * 而队列条目 6 秒就自动消失、批量导入时还会被后续条目顶掉，用户很可能一次都没看见
 * 「已覆盖到「…」」。这里有任意一条走了退化分支（旧版没进回收站 / 旧目录已不存在）时
 * 必须如实改口，不能说成"在回收站"。
 */
function flushOverwriteSummary(): void {
  const total = overwrittenInBatchCount
  const degraded = overwrittenDegradedCount
  overwrittenInBatchCount = 0
  overwrittenDegradedCount = 0
  const text = overwriteSummaryText(total, degraded)
  if (text) enqueueNotice(text)
}

/**
 * 批次结束：汇总本轮**物理删除**的杂质文件数（0.9.0）。
 *
 * 位置在跳过 / 覆盖之后：那两条是"你的东西被怎么处理了"，这条是"我们主动删了什么"，
 * 用户关心程度递减，放在最后一条不抢前两条的注意力。
 *
 * 只报条数不报文件名 —— 批量导入时文件名能刷满三屏，而用户真正需要知道的只有
 * "删了几个 + 这事不可逆"。
 */
function flushJunkSummary(): void {
  const n = cleanedJunkInBatchCount
  cleanedJunkInBatchCount = 0
  const text = junkCleanupSummaryText(n)
  if (text) enqueueNotice(text)
}

/**
 * 导入真的有资产落库之后，把用户从「最近删除」拉回资产视图。
 *
 * 为什么需要：回收站视图只列软删资产，新导入的资产进去后**看不见** ——
 * 用户以为"导入没生效"，实际上东西已经在库里了（2026-10 反馈）。
 *
 * 为什么不粗暴：只在"本批第一条真正落库的 `done`"上切一次；用户之后手动切回回收站，
 * 本批剩余 `done` 不会再把他拽出来（见 `libraryViewRestoredInBatch` 的注释）。
 * 已经在资产视图时只置闩锁、不弹提示（用户没有任何感知需要）。
 *
 * 提示文案刻意**不说"导入成功"**（那是导入队列的职责）：这里只说视图发生了什么变化、
 * 新素材在哪能找到，否则用户会以为这是导入结果的唯一回执。
 */
function restoreLibraryViewAfterImport(): void {
  if (libraryViewRestoredInBatch) return
  // 先置闩锁再切：切换本身是同步 set，不存在重入窗口，但顺序上"已决定过"更清楚
  libraryViewRestoredInBatch = true
  if (useVault.getState().libraryView === 'assets') return
  // 复用 `setLibraryView`，顺带清掉选择 / 文件视图 / 分类弹窗快照（不要手写第二份清场逻辑）
  useVault.getState().setLibraryView('assets')
  enqueueNotice('已切回资产视图：新导入的素材在「全部」或对应分类里（回收站只显示已删除的资产）')
}

/**
 * 「指派分类」弹窗的目标是 selection 的**快照**（`categoryPickerIds`）。
 *
 * 它不会跟着 selection / assets 自动失效：选中被清空、资产被删、重扫换了记录之后，
 * 组件按 ids 过滤得到空集合 → 弹窗看起来"自己卸载了"，但 store 里旧数组还挂着，
 * 下次 `openCategoryPicker` 之前一直悬着（脏状态）。
 *
 * 所以**任何会写 `selectedId` / `selectedIds` 的 action** 都用这个包装把快照一并收掉：
 * 只有一处实现，不会出现"六处各写一遍、新加的第七处忘了写"。
 */
function withPickerClosed<P extends object>(patch: P): P & { categoryPickerIds: null } {
  return { ...patch, categoryPickerIds: null }
}

// ── P2 整理浮层的两种模式（docs/35 §4.2 · R-10）──────────────────────

/**
 * 整理浮层的模式。与 `logic/reviewFlow.ts` 的 `ReviewReason` 同名同义，但**不复用**那个
 * 类型：`ReviewReason` 是"判据的返回值"（永不为 null），这里是"浮层状态"（可为 null）。
 * 混用会让 `triageMode` 的 null 分支要靠 `| null` 硬套，读起来像笔误。
 */
export type TriageMode = ReviewReason

/**
 * 某个模式的待办集（**口径的唯一实现点**，`openTriage` 与三个 hook 都走它）。
 *
 * 三步，一步都不能少也不能换顺序：
 * ① 滤软删（走 `isDeletedAsset`，与 `activeAssets` / `applyFilters` 同一判据来源）；
 * ② 按当前排序排（`sortAssets` 走同一份 `filters.sort`，不自己另排）；
 * ③ 按模式挑（`unclassified` 走 `buildTriageQueue`，`conflict` 走 `buildReviewQueue`）。
 *
 * ## 为什么必须合成一个函数（本卡最容易犯的错）
 *
 * `openTriage` 要知道"队列空不空"、`useTriageQueue` / `useReviewQueue` 要渲同一批 ——
 * 三处各写一遍 `filter + sort + build`，就是三套真相。历史上"侧栏数字与浮层条数对不上"
 * 的 bug 全部来自这种重复（`logic/triageFlow.ts` 文件头有记）。
 *
 * **不套 `filters`**（搜索词 / 大类 / 分类 / chip 都不参与）：两种队列都是全库口径，
 * 理由见 `useTriageQueue` 的注释 —— 侧栏那两个数字本身也是全库口径。
 *
 * ## 为什么导出（它本是 store 内部实现细节）
 *
 * ① `openTriage` 与三个 hook 共用，已经是**公开行为的一部分**（"入口说有 3 条、
 *    浮层就渲 3 条"就是它的契约），不属于私有实现；
 * ② vitest 是 `environment: 'node'`，没有 jsdom / react-test-renderer，而 zustand v4
 *    在 SSR 下用 `getServerSnapshot`（返回初始 state），`renderToStaticMarkup` 读不到
 *    `setState` 之后的值 —— hook 本体在现有设施下**没法真跑**。把内核导出后，测试能
 *    直接断言"含软删的混合数据在两个模式里都被滤掉"，而不是退化成扫源码字符串。
 */
export function triageQueueOf(
  assets: readonly Asset[],
  sort: SortKey,
  mode: TriageMode
): Asset[] {
  const live = assets.filter((a) => !isDeletedAsset(a))
  const ordered = sortAssets(live, sort)
  return mode === 'unclassified'
    ? buildTriageQueue(ordered)
    : buildReviewQueue(ordered, 'conflict')
}

/**
 * 进入某模式时队列为空给的那句话。**两种模式各不相同**（不能复用）：
 *
 * - `unclassified` 那句是 P2 的既有文案，用户已经熟悉，改一个字都算回归；
 * - `conflict` 是新文案：如果复用未分类那句，用户在"待确认"入口看到「没有未分类的资产」
 *   会以为点错了按钮 —— 而此时库里**可能确实还有几百张未分类**，是两句不同的事实。
 */
const TRIAGE_EMPTY_NOTICE: Record<TriageMode, string> = {
  unclassified: '没有未分类的资产',
  conflict: '目前没有待确认的素材'
}

/**
 * 写 `triageMode` 的**唯一入口**（`triageActive` 是它的派生值）。
 *
 * 两个字段必须一起变：单独 `set({ triageActive: true })` 会让 `triageMode` 留在 null
 * （浮层挂起来但不知道渲哪个队列），单独 `set({ triageMode: 'conflict' })` 会让
 * `triageActive` 停在 false（模式变了但浮层不挂）。所以只留这一个写点。
 */
function withTriageMode(mode: TriageMode | null): { triageMode: TriageMode | null; triageActive: boolean } {
  return { triageMode: mode, triageActive: mode !== null }
}

/** 本会话已尝试过生成缩略图且失败的资产 id（防止网格反复触发同一个失败的 ensureThumb） */
const thumbAttempted = new Set<string>()

/** rescan / init 后批量补缩略图的单轮上限（防止大库一次性打爆 IPC 与 CPU） */
const ENSURE_THUMB_BATCH = 120

/**
 * 补齐队列最多连续跑几轮（0.8.3，用户 2026-10-28 追问「重装后扫描预览图」时发现）。
 *
 * 病根：`ENSURE_THUMB_BATCH` 只是**单轮**上限，但 0.8.3 之前跑完一轮就收工、没有接力。
 * 重装 / 首次扫描后一次可能缺几百张缩略图（`thumbStatus` 全被重置成 none），
 * 于是第 121 张之后就一直停在图标占位，用户看到的是"预览图只补了一部分"——
 * 表现和"没修好"一模一样。
 *
 * 为什么不会死循环：每张进过队列的 id 都写进 `thumbAttempted`（成功的写 ready 后
 * 不再进候选，失败的本会话不再重试），所以候选集**单调收缩**；再加一条"本轮一张都
 * 没补上就收手"，以及 20 轮（= 2400 张）的硬上限兜住病态数据。
 */
const ENSURE_THUMB_MAX_ROUNDS = 20

/**
 * `init()` 的重入闸门（模块级，与 `conflictUnsubscribers` 同一种守卫）。
 *
 * 用户 2026-10-26 点名：「init() 一次加载跑两次」。真实来源是 React 18 StrictMode
 * 在开发模式下的**双挂载**（`App.tsx:369` 的 effect 被跑两次）：第二次调用时第一次
 * 的 promise 还挂着 → 看到本标志为 true，直接 return，不做任何第二次 DB 写、不重订事件。
 *
 * ⚠️ 语义是**互斥**而不是"只跑一次"：闸门只在**正在跑的那次未结束时**生效，跑完后复位。
 * 所以真需要重跑的路径（rescan 后重建、单测里逐条 `await init()`）仍能完整执行——
 * 这与"进程内只允许跑一次"的写法有实质区别，绝不能改成一次性标志。
 *
 * 为什么不能靠调用方防：`App.tsx` 的 effect 依赖 `[init]`，StrictMode 下 React 自己
 * 就会重跑 effect；渲染层没有别的时机能把两次压成一次。
 */
let initInFlight = false

/** 仅供单测：复位重入闸门（运行时无调用点） */
export function resetInitGuardForTests(): void {
  initInFlight = false
}

/**
 * 材质球离屏渲染（2026-10 任务 6）：**后台串行队列**。
 * 每个球要自建自销一个 WebGL 上下文（Chromium 上限 8-16 个），并发必炸，
 * 所以严格串行；`BALL_THUMB_BATCH` 封顶防止大库一次性排队几千个。
 */
const BALL_THUMB_BATCH = 40

/**
 * 已尝试渲染球图的资产：`id → 期望缓存名`（DEF-09）。
 *
 * 用 Map 而不是 Set：期望名由槽位集合算出，**换贴图 → 名字变 → 自动重新入队**；
 * 同一名字下无论成功还是失败都只试一次（无 GPU / 贴图加载失败时不会反复重试）。
 * 旧实现用 Set<id>，导致 rescan 换贴图后本会话内再也不重渲。
 *
 * 2026-10 调参持久化（docs/12 §3.3）：参数进入 hash 后，期望名同样会随参数变化
 * → 调过参的资产天然获得重渲能力（方案 B：未调参的期望名与既有缓存一致，不重渲）。
 */
const ballAttempted = new Map<string, string>()

/**
 * 参数变化后待清理的旧球图：`id → 落库前的球图缓存名`（docs/12 §4.2）。
 *
 * 只记录**确实由球管线产出**的名字（`thumbPath === ballThumbName(id, slots, 旧参数)`）——
 * 封面 salt（`coverSource='named'` 的官方渲染图、手动封面）不是球图，不能删。
 * 时序严格「先建新、再删旧」：新文件已落盘 → 删旧 → 原子更新 `thumbPath`。
 * 渲染失败时不删（与 `renderBallThumbFor` 的静默降级口径一致）。
 */
const ballStaleNames = new Map<string, string>()

/** 待渲染队列（asset id） */
const ballQueue: string[] = []

/** 队列运行标志（重入保护） */
let ballQueueRunning = false

// ─────────────────────────────────────────────────────────────────────────────
// 球图**缓存升级策略**（2026-10，用户反馈：不许每次更新就全量重渲）
//
// 三档优先级，全部共用下面那份「过期候选」惰性索引，**没有一处遍历全库**：
// ① 首屏缺图（`thumbPath` 空 / 非 ready）→ `ensureMissingBallThumbs()` 一次性补齐，
//    只有这一类会在启动时入队；
// ② 用户滚到哪就升哪（`noteVisibleAssets`）——名字过期但**文件还在**的球图，
//    等卡片真的出现在屏幕上才重渲，上限 `VISIBLE_UPGRADE_MAX` 条/次；
// ③ 兜底涓流（3s 一条，本次会话最多 `STALE_TRICKLE_SESSION_MAX` 条）——
//    覆盖「用户不再滚动」的库，让它自己慢慢收敛，不抢首屏。
//
// 硬不变量（改这里之前先读）：升级期间卡片**始终显示旧球图**（先建新、再删旧，
// 见 `renderBallThumbFor`）；`renderParams` / `renderShape` 一个字节都不动；
// 没升完不影响下次启动（`thumbPath` 仍是旧名 → 仍在过期候选里 → 继续）。
// ─────────────────────────────────────────────────────────────────────────────

/** 单次可见性上报最多入队几条（一次滚动渲染出几十张卡，不能一口气全排上） */
export const VISIBLE_UPGRADE_MAX = 6

/** 涓流间隔（渲染进程用 `setTimeout` 自续，不用 `setInterval`：不会在 dispose 后泄漏） */
export const STALE_TRICKLE_INTERVAL_MS = 3000

/** 涓流本次会话的总产出上限（60 条 ≈ 3 分钟，之后交给「看到才升」这条主路径） */
export const STALE_TRICKLE_SESSION_MAX = 60

/** 涓流定时器句柄；`null` = 链已停 */
let staleTrickleTimer: ReturnType<typeof setTimeout> | null = null

/** 本次会话已由涓流入队的条数（跨 init / rescan 保留 = 真正的"每会话"上限） */
let staleTrickleProduced = 0

/**
 * 过期候选索引的**缓存源**：`assets` 数组引用变了才重建（见 `upgradeCandidates`）。
 *
 * 为什么要缓存：`noteVisibleAssets` 每次滚动都会调用；如果每次都 `filter` 全库，
 * 1 万条资产滚一下就是几十万次比较，纯属白烧（这正是本文件其它地方
 * `useVisibleAssets` 用 memo 的同一条理由）。
 */
let upgradeIndexSource: Asset[] | null = null

/** 过期候选（**名字过期但文件还在**的球图），与上面的源引用配对使用 */
let upgradeIndex: Array<{ id: string; want: string }> = []

/** `assetId → Asset` 惰性索引（同上：只在 `assets` 引用变化时重建） */
let assetIndexSource: Asset[] | null = null
let assetIndexById = new Map<string, Asset>()

/** 启动自动迁移的规模上限：≤ 此数自动搬，> 此数改设置页手动触发（03 §4.4） */
export const AUTO_MIGRATE_LIMIT = 50

/**
 * AI 辅助分类（docs/15 §7）：每次 IPC 请求携带的名字数。
 * 与 main 侧 `AI_CLASSIFY_BATCH_SIZE` 同值——一批 = 一次 HTTP 请求，便于逐批落库。
 */
export const AI_CLASSIFY_BATCH_SIZE = 20

/** AI 补分类结果（notice 文案三个数字） */
export interface AiClassifySummary {
  /** 成功归类（真实移动了目录）的资产数 */
  ok: number
  /** 模型明确判断不了（返回 null / 校验不过）的资产数 */
  unknown: number
  /** 请求整体失败（网络 / HTTP / 解析 / 超时）+ 移动失败的资产数 */
  failed: number
}

const EMPTY_AI_SUMMARY: AiClassifySummary = { ok: 0, unknown: 0, failed: 0 }

/**
 * 并发保护：同一时刻只允许一个补分类流程在跑。
 * 用模块级布尔而不是 state，是为了在 `set()` 之前就能拦住重入（state 读取有微任务间隙）。
 */
let aiClassifyRunning = false

/**
 * 知末封面（docs/24 §3.6，T-04）—— 模块级状态，理由同 `aiClassifyRunning`：
 * 必须在 `set()` 之前就能拦住重入（state 读取有微任务间隙）。
 *
 * `zhimoCoverRunning`：同一时刻只允许一个抓取流程（自动 / 手动都算）；
 * `pendingZhimoIds`：本次导入批次里**可能是目标**的资产 id（只收 model / cad 里能取到知末 ID 的：
 * `asset.zhimoId` 优先，为空回退 `zhimoIdOf(asset.name)`）。
 * 收在模块级而不是 state：它是短暂的过程量，不需要触发渲染，也不该被组件读到。
 */
let zhimoCoverRunning = false
const pendingZhimoIds: string[] = []

/**
 * 收一个"待抓"资产（导入 done 时调用；重复 id 直接丢弃）。
 *
 * ⚠️ **不设上限**（DEF-Z2）：pending 是"待办清单"，上限只会让第 51 个模型
 * **永远**抓不到（导入批次早就结束，没人会再把它放回来）。
 * 真正的节流在 `runZhimoCoverQueue`（并发 2 / 间隔 250ms / 每 50 条停 2 秒），
 * 那里是"慢"，不是"丢"。
 */
function enqueueZhimoCover(asset: Asset): void {
  // 与 `pickZhimoCoverTargets` / `isZhimoCoverBackfillCandidate` 同一个口径函数：
  // 曾经这里是第三处裸的 `kind !== 'model'`，2026-10 加 `cad` 时差点漏掉 →
  // 那样会出现"手动按钮点了能抓、导完自动任务却不抓"的静默失效。
  if (!isZhimoCoverKind(asset.kind)) return
  // 知末 ID 口径（0.6.3）：**优先落库的 `asset.zhimoId`**，为空才回退名字解析。
  // ⚠️ 这一处曾漏改：ID 只在**压缩包名**上的资产（`现代壁灯ID_1232108421.rar`）
  // 手动按钮能点、自动任务却永远不入队 → 默认开启的「导入后自动补封面」对它们静默失效。
  const storedId = typeof asset.zhimoId === 'string' ? asset.zhimoId.trim() : ''
  if (!(storedId || zhimoIdOf(asset.name))) return
  if (pendingZhimoIds.includes(asset.id)) return
  pendingZhimoIds.push(asset.id)
}

/**
 * 自动任务的结果全 0 常量（`ids` 为空 / 开关关闭时返回）。
 * 不复用同一个可变对象：调用方可能把它塞进 state，冻结一份更安全。
 */
function emptyZhimoResult(stopped = false): ZhimoCoverQueueResult {
  return { ok: 0, failed: 0, skipped: 0, stopped }
}

/** 排队提示文案（DEF-Z8：用户操作排队不拒绝，但要让他们知道"点了有反应"） */
const COVER_LOCK_WAIT_NOTICE = '正在后台写入封面，请稍候'

/** 封面写入锁的提示选项（四条写入路径共用；`useVault.setState` 在调用时才求值） */
function coverLockWaitOptions(): { onWaitNotice: () => void } {
  return {
    onWaitNotice: () => useVault.setState({ notice: COVER_LOCK_WAIT_NOTICE })
  }
}

/**
 * 「重跑自动分类」（v1.0.13）结果 —— notice 文案的三个数字。
 *
 * 背景：分类只在**导入那一刻**跑一次。词表/匹配规则升级后，旧资产仍躺在
 * `未分类/未分类` 里；用户装上新版本会以为"没修好"。这个动作把历史未分类资产
 * 按**当前**词表重判一次。
 */
export interface ReclassifySummary {
  /** 真实移动了目录（或已落到目标分类）的资产数 */
  moved: number
  /** 按当前词表仍判不出来（保持未分类）的资产数 */
  missed: number
  /** 移动失败（目录不存在 / 路径非法 / IPC 异常）的资产数 */
  failed: number
}

const EMPTY_RECLASSIFY_SUMMARY: ReclassifySummary = { moved: 0, missed: 0, failed: 0 }

/**
 * 知末「站方分类」重排的结果计数（`runZhimoCategoryReclass`）。
 *
 * 为什么有这么多桶：站方分类的失败**不是一种**。
 * - `noStation`：站方根本没给分类（`ok:false` 或 `classifyBaseName` 空且无面包屑）
 *   → 正常结果，不是故障；
 * - `unmapped`：**站方说了话但我们还原不出路径** —— 有 `classifyBaseName`、
 *   面包屑却缺失（实测约 20%）或映射不出来。与 `noStation` 必须分开：
 *   合成一个会让"站方覆盖不全"和"我们的词表有缺口"永远分不清；
 * - `ambiguous`：**恒 0（老通道语义）** —— 映射表返回候选数组（筛不出唯一）。
 *   交叉验证通道**不产生这个桶**：`s2FromBreadcrumbGeneric` 遇到 `ARR(n>1)` 直接
 *   整条 S2 放弃（返回 null），此时若 `classifyBaseName` 有值就落进 `unmapped`。
 *   这是**唯一允许恒 0 的桶**，见 2026-10-29 裁定；
 * - `failed`：详情页请求失败 + `assignCategory` 移动失败；
 * - `conflicts`：S1 与 S2 冲突 → 进待确认队列，等用户裁定（R-05：绝不自动消歧）。
 *   这类**不搬**；
 * - `unverified`：**`moved` 的子集** —— 其中"站方单源（`medium-s2`）"搬了多少条。
 *   语义与 `approx` 同角色：一个"这批里有多少条是没被第二源验证过就搬了"的锚点。
 *
 * ⚠️ 2026-10-29：门槛从「只搬 high」改为「**high 或 medium-s2 都搬**」，
 * 所以 `moved` 现在包含单源搬运；`unverified` 因此从"只标记不搬的计数"
 * 变成"单源搬的计数"。**结果弹窗的文案要等 T-14 统一改，本批先保证数字正确**
 * （`SettingsDialog.tsx:1321` 仍按老口径展示 `approx/ambiguous/unmapped`）。
 */
export interface ZhimoReclassSummary {
  /** 实际发出详情页请求的条数（含失败；取消时为已发出的部分） */
  scanned: number
  /** 真实移动了目录的资产数（含 `high` 两源互证 + `medium-s2` 站方单源） */
  moved: number
  /**
   * ⚠️ `moved` 的**子集**：其中"按相近类目归并"的条数。
   * 来源是 `S2Parsed.approx` 的透传（映射表里 `approx: true` 的条目，如 `茶具`）；
   * CAD 通道不做近似归并，恒 0。这是"有多少条是猜的"的唯一锚点。
   */
  approx: number
  /** ⚠️ **恒 0**（老通道语义，交叉验证通道不产生；详见接口注释） */
  ambiguous: number
  /** 站方给了末级名但还原不出路径（面包屑缺失 / 映射不出来）的条数 */
  unmapped: number
  /** 站方完全没给分类（正常结果）而跳过的条数 */
  noStation: number
  /** 详情页请求失败 + 移动失败的条数 */
  failed: number
  /** 交叉验证判为 conflict 的条数（进待确认队列，不搬目录） */
  conflicts: number
  /** ⚠️ `moved` 的**子集**：其中站方单源（`medium-s2`）搬的条数 */
  unverified: number
}

const EMPTY_ZHIMO_RECLASS_SUMMARY: ZhimoReclassSummary = {
  scanned: 0,
  moved: 0,
  approx: 0,
  ambiguous: 0,
  unmapped: 0,
  noStation: 0,
  failed: 0,
  conflicts: 0,
  unverified: 0
}

/**
 * 「站方分类重排」的进度状态（设置页显示 / 取消按钮读它）。
 *
 * 放 state（不像 `pendingZhimoIds` 那样放模块级）的原因：设置页要实时显示
 * "已完成 12 / 共 30"，这是**渲染层要读**的状态，不是过程量。
 */
export interface ZhimoReclassState {
  /** 正在跑（含正在落库阶段） */
  running: boolean
  /** 已处理条数（抓取阶段单调递增） */
  done: number
  /** 本轮候选总数 */
  total: number
  /** 用户点了取消（停止发新请求；已抓到的仍然落库） */
  cancelRequested: boolean
}

const IDLE_ZHIMO_RECLASS_STATE: ZhimoReclassState = {
  running: false,
  done: 0,
  total: 0,
  cancelRequested: false
}

/**
 * 「一键重扫 · 从知末获取封面」的进度状态（设置页显示 / 取消按钮）。
 *
 * 形态与 `ZhimoReclassState` 一致但**单独命名**：两条通道各自独立计数与取消，
 * 复用同一个类型会让人误以为状态互通。
 */
export interface ZhimoCoverBackfillState {
  running: boolean
  /** 已处理条数（含成功 / 失败 / 跳过），单调递增 */
  done: number
  /** 本次候选总数 */
  total: number
  /** 用户点了取消（停止发新请求；已抓到的封面照常落库） */
  cancelRequested: boolean
}

/** `runZhimoCoverBackfill()` 的可选参数 */
export interface RunZhimoCoverBackfillOptions {
  /**
   * 节流 sleep 的注入点（**仅供单测**传即时桩，运行时不传）。
   * 与 `runZhimoCoverQueue({ sleep })` 同款，避免用例真等 N×250ms。
   */
  sleep?: (ms: number) => Promise<void>
}

/** `runZhimoCoverBackfill()` 的返回（队列计数 + 本轮候选总数） */
export interface ZhimoCoverBackfillSummary {
  /** 抓取成功（落盘成功）的条数 */
  ok: number
  /** 失败条数（任何 reason） */
  failed: number
  /** 锁内重查发现"已有封面 / 手动封面"而主动跳过的条数 */
  skipped: number
  /** true = 被取消叫停，剩余条目没有发请求 */
  stopped: boolean
  /** 本次启动时的候选总数 */
  total: number
}

/**
 * 并发保护：封面补抓同一时刻只允许一个在跑（模块级布尔，理由同 `zhimoReclassRunning`）。
 */
let zhimoCoverBackfillRunning = false

/** `runZhimoCategoryReclass()` 的可选参数 */
export interface RunZhimoCategoryReclassOptions {
  /**
   * true = 用户在设置页手动点的：**不看** `settings.zhimoAutoCategory`，
   * 且结束后给一条 notice；false / 缺省 = 导入批次后的自动任务（全程静默）。
   */
  manual?: boolean
  /** 外部停止条件（窗口关闭等）；与 `zhimoReclass.cancelRequested` 取「或」 */
  shouldStop?: () => boolean
  /** 进度回调（除了写 store 状态，还额外通知调用方） */
  onProgress?: (progress: ZhimoReclassProgress) => void
  /**
   * 节流 sleep 的注入点（**仅供单测**传即时桩，运行时不传）。
   * 与 `runZhimoCovers({ sleep })` 同款：避免 N 条用例真等 N×250ms。
   */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 并发保护：站方分类重排同一时刻只允许一个在跑（理由同 `aiClassifyRunning`：
 * 必须在 `set()` 之前就能拦住重入）。
 */
let zhimoReclassRunning = false

/** 「撤销上次重跑」结果 */
export interface ReclassUndoSummary {
  /** 成功搬回原分类的资产数 */
  restored: number
  /** 索引里已找不到 / 搬回失败的资产数 */
  failed: number
}

/**
 * 重跑分类的备份保留条数（`reclass-*`）。
 * 比重扫备份（5）更小：这只是"移动目录"的撤销凭证，撤销即消费掉，
 * 留太多没有意义，还会让「撤销上次重跑」到底撤哪一次变得不可预期。
 */
export const RECLASS_BACKUP_KEEP = 3

/**
 * 并发保护：重跑分类 / 撤销重跑同一时刻只允许一个在跑（模块级布尔，理由同 `aiClassifyRunning`）。
 */
let reclassifyRunning = false

/**
 * 一次重跑分类里被移动资产的**最小还原凭证**。
 * 只记还原分类目录所必需的字段（不复制整份 Asset，避免备份里出现会过期的派生字段）。
 */
interface ReclassRecord {
  id: string
  name: string
  folder: string
  relFolder: string
  category1: string
  category2: string
}


/** 删除流程阶段：`confirming`=待二次确认；`grace`=已确认、撤销倒计时中（时长见 `graceMs`） */
export type DeleteStage = 'confirming' | 'grace'

/**
 * 删除安全状态（P0-16）。**两阶段里文件都还在磁盘上**：
 * - `confirming`：ConfirmDialog 展示中，用户还没确认；
 * - `grace`：用户已确认，UndoToast 倒计时中，到期 `commitDelete()` 才真正 `trashPaths` + 删索引。
 */
export interface PendingDelete {
  ids: string[]
  targets: DeleteTarget[]
  stage: DeleteStage
  /** grace 阶段的起始时间戳；confirming 阶段为 0 */
  startedAt: number
  /**
   * 本次删除的撤销期（毫秒，来自设置 `undoGraceMs`，三档 0 / 3000 / 5000）。
   * `0` = 不等待：`confirmDelete()` 不进 `grace`，直接 `commitDelete()`。
   */
  graceMs: number
  /**
   * 确认框里的额外警示（v0.4 重复资产：「体积差异较大，请先确认是同一套资产」）。
   * 普通删除不传 → 确认框保持原样。
   */
  warning?: string
  /** 用户确认后要落的轻提示（v0.4 重复资产；文案由 `logic/graceText.ts` 按档位生成） */
  notice?: string
}

/** `requestDelete` 的可选参数（只有「保留这份」这类批量清理场景需要） */
export interface RequestDeleteOptions {
  /** 二次确认框里的额外红色警示行 */
  warning?: string
  /** 确认后（进入撤销宽限期，`graceMs === 0` 时不展示）的轻提示 */
  notice?: string
}

/**
 * 拖拽归类撤销（反馈 6d / docs/15 §6d）。
 *
 * 与删除撤销的区别：**归类是不可回滚的磁盘移动**（`fs.rename`），所以
 * - 归类在 drop 时立即执行（不等倒计时），撤销是**再搬一次**（原值反向移动）；
 * - `records` 是归类**之前**的分类快照，撤销按原分类对分组搬回；
 * - 到期只是清状态（`commitAssign`），不需要任何落盘动作。
 */
export interface PendingAssign {
  /** 每个被移动资产的原分类（快照；只有真的会移动的资产才登记） */
  records: AssignUndoRecord[]
  /** 目标分类（规范化后） */
  category1: string
  category2: string
  /** 展示文案「一级 / 二级」 */
  label: string
  /** 撤销条起始时间戳（倒计时按绝对时间算，不怕定时器漂移） */
  startedAt: number
  graceMs: number
  /** 实际移动成功数（撤销条文案用） */
  moved: number
}

/**
 * 重扫结果（2026-10 库安全：`rescan` 不再返回 void）。
 *
 * `aborted` 非 null = **安全守卫中止**：本次没有删除任何记录、没有写库、
 * 没有触发 pruneThumbs / 缩略图队列。UI 据此提示用户而不是假装"重扫成功"。
 */
export interface RescanOutcome {
  aborted: 'empty-scan' | 'mass-delete' | null
  /** 本次新索引到的资产数（扫描结果条数） */
  scanned: number
  /** 本次从索引移除的资产数（中止时恒为 0） */
  removed: number
}

/** 重扫前备份的保留条数（`rescan-*`，多了删最旧，别把库撑大） */
export const RESCAN_BACKUP_KEEP = 5

/** v0.4 对账修复的入参（三个数组对应三类差异；空数组 = 该类别不处理） */
export interface ReconcileActions {
  /** 要移除的索引记录 id（磁盘上已不存在的） */
  removeIndex: string[]
  /** 要补入索引的扫描对象（磁盘上有、索引没有的） */
  addIndex: Asset[]
  /** 要按磁盘值修正分类的索引记录 id */
  fixCategory: string[]
}

/** v0.4 对账修复的结果（失败项不回滚，如实报数） */
export interface ReconcileResult {
  removed: number
  added: number
  fixed: number
  /** 未能完成的条数（含备份失败 / 写库失败） */
  failed: number
}

export interface ImportItem {
  item: string
  itemName: string
  status: ImportEvent['status'] | 'pending'
  message?: string
  asset?: Asset
  /** 空间不足时的可行动数字（P0-3：可用 X GB / 需要 Y GB） */
  needBytes?: number
  freeBytes?: number
  /**
   * 重复处置结果（docs/27）。`done` + `overwrite` / `keep-both` 时用来改写明细文案
   * （「已覆盖到「…」」/「已保留为「…」」），`skipped` 时随事件存在但文案走 `message`。
   */
  conflict?: ImportEvent['conflict']
  /**
   * 进入终态（done / error / skipped）的**绝对时间戳**；进行中为 undefined。
   *
   * 队列条目的自动消失倒计时以它为起点（见 `logic/importText.ts` 的
   * `dismissRemainingMs`）。用时间戳而不是"收到事件后 setTimeout"，
   * 是为了在**悬停暂停 / 恢复**、组件重渲染、条目增删时都能算出正确的剩余时间，
   * 不会因为重建 timer 而把 6 秒重新计时一遍。
   */
  settledAt?: number
}

export interface AssignSummary {
  moved: number
  /** 因目标重名被 uniqueName 追加序号的个数（renamed） */
  renamed: number
  failed: number
  /** 已处于目标分类的个数（跳过——不跳过会被 main 的 uniqueName 误判成同名冲突而改名 -2） */
  skipped: number
  /** 入参被 normalizeCategoryPair 改写（级联降级 / 非法字符 / 截断） */
  changed: boolean
}

/**
 * 批量改名的一条请求（由重命名弹窗从预览表投影）。
 * 只带 `id` + 目标名：绝对路径由 store 从当前记录里取，**不信任 UI 传来的路径**。
 */
export interface RenameRequestRow {
  id: string
  /** 目标文件夹名（预览表里已经清洗过；main 侧还会再校验一次） */
  to: string
}

/** 批量改名结果摘要（notice 文案直接用） */
export interface RenameSummary {
  /** 真的改了名的条数 */
  renamed: number
  /** 失败的条数（磁盘未动，索引也保持原样） */
  failed: number
  /** 跳过的条数（名称没变 / 找不到记录 / 重复 id） */
  skipped: number
  /** 主进程是否发生了"失败后回滚"（true = 磁盘零改动，UI 要说明） */
  rolledBack: boolean
  /** 第一条失败原因（只在全部失败时展示，避免 notice 过长） */
  reason?: string
}

/** 材质大类合并结果摘要（notice 文案 / 设置页卡片共用；明细不在这里） */
export interface MergeMaterialSummary {
  moved: number
  /** 因目标重名被追加 -2/-3 的个数 */
  renamed: number
  failed: number
  /** 计划阶段跳过的结构数（3 段草稿、位置是文件等） */
  skipped: number
  /** true = 超出自动阈值（>50），未执行任何搬移，需用户手动点 */
  needsManual: boolean
  /** 待迁移资产总数 */
  count: number
}

const EMPTY_MERGE_SUMMARY: MergeMaterialSummary = {
  moved: 0,
  renamed: 0,
  failed: 0,
  skipped: 0,
  needsManual: false,
  count: 0
}

// ── 0.6.0 智能集合（保存的筛选视图） ────────────────────────────────
//
// 纯虚拟层：不占磁盘、不动资产，只是把「当前 filters + sort」存进 settings.json。
// 上限存在的理由：侧栏是常驻列表，20 条已经占满整屏；再多用户就找不到东西了
// （且 settings 每次写全量，没有分页/搜索，越长越难管理）。

/** 智能集合条数上限（UI 与 store 共用，避免两处写 20） */
export const SAVED_VIEW_LIMIT = 20

/** `saveCurrentView` 的结果：失败原因要能直接显示在行内输入框下方 */
export type SaveViewResult =
  | { ok: true; view: SavedView }
  | {
      ok: false
      reason: 'empty-name' | 'duplicate' | 'limit' | 'no-settings' | 'error'
      message: string
    }

/** 智能集合 id：优先 UUID（与资产 id 同一口径），无 crypto 时退化为时间戳 + 随机串 */
function newSavedViewId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

interface VaultState {
  assets: Asset[]
  filters: Filters
  selectedId: string | null
  /** 多选（Ctrl/Cmd+点击切换；批量删除 / 批量指派分类复用） */
  selectedIds: string[]
  /**
   * 最后一次点击的资产 id —— **Shift 范围选择的锚点**（2026-10 多选入口补齐）。
   *
   * `null` = 没有锚点（刚启动 / 选择被清空 / 锚点已被筛掉），此时 Shift+点击
   * 退化为单点选择，不会"什么也选不上"。
   */
  lastClickedId: string | null
  imports: ImportItem[]
  settings: Settings | null
  ready: boolean
  pendingDelete: PendingDelete | null
  /** 拖拽归类后的 5 秒撤销条状态；null = 没有待撤销的归类（反馈 6d） */
  pendingAssign: PendingAssign | null
  /** 全局轻提示（assignCategory 的 renamed/failed 反馈、迁移结果等）；null = 无 */
  notice: string | null
  /** 遗留布局（relFolder 段数 ≠ 4）资产数；> AUTO_MIGRATE_LIMIT 时只在设置页手动迁移 */
  legacyLayoutCount: number
  /** 可用的「重扫前索引备份」条数（>0 时设置页「恢复上次重扫前索引」按钮可用） */
  rescanBackupCount: number
  /** 材质大类合并：待合并资产数（0 = 无需合并）；> AUTO_MIGRATE_LIMIT 时只提示、设置页手动触发 */
  materialMergeCount: number
  /** 待合并的来源目录信息（贴图 / 材质预设），设置页卡片展示用 */
  materialMergeSources: MergeMaterialSource[]
  /** 合并进行中：迁移期间禁用「重新扫描」与重复点击 */
  materialMergeBusy: boolean
  /** AI 补分类进行中（后台任务，仅用于防重入 / 将来 UI 显示进度） */
  aiClassifyBusy: boolean
  /**
   * 手动抓取中的**资产 id**（null = 没有手动任务在跑）。
   *
   * 为什么不是全局布尔：自动批次动辄跑几十秒，全局布尔会让用户点开**任意**资产
   * 都看到「正在从知末获取…」，像是卡死了。自动任务全程静默，**只有手动路径**写这个字段。
   */
  zhimoCoverBusyId: string | null
  /** 「重跑自动分类」进行中：禁用按钮、防重复启动 */
  reclassifyBusy: boolean
  /** 可用的「重跑分类备份」条数（>0 时设置页「撤销上次重跑」按钮可用） */
  reclassifyBackupCount: number
  /**
   * 可用的「**知末**重排备份」条数（`zhimo-reclass-*`，>0 时设置页
   * 「撤销上次知末重排」按钮可用）。
   *
   * 与 `reclassifyBackupCount` 分开计数：两条通道前缀不同、各留 3 份，
   * 合成一个数字会让撤销按钮在错误的通道上亮起。
   */
  zhimoReclassBackupCount: number
  /**
   * 「站方分类重排」进度（设置页显示 / 取消按钮）。
   *
   * 与 `reclassifyBusy` 分开：老「重跑自动分类」按本地词表重判，
   * 本项按**知末站方分类**重判，两者是不同通道（备份前缀也不同）。
   */
  zhimoReclass: ZhimoReclassState
  /** 「一键重扫 · 从知末获取封面」进度（设置页「数据与备份」tab；与 `zhimoReclass` 互不互通） */
  zhimoCoverBackfill: ZhimoCoverBackfillState
  /** CategoryPicker 当前打开的目标 id 集合；null = 关闭（详情面板 / 右键菜单 / 批量栏共用） */
  categoryPickerIds: string[] | null
  /**
   * 中栏「软件内文件夹浏览器」当前展示的资产 id；null = 正常网格 / 列表视图。
   *
   * 双击卡片进入（不再是调系统资源管理器，用户反馈 docs/15 §6c）；Esc / 中栏头「← 返回」退出。
   * 该 id 对应的资产被删除或被 rescan 丢弃时自动置 null（见 commitDelete / rescan 收尾）。
   */
  folderViewAssetId: string | null
  /**
   * 「重复资产」视图开关（v0.4）。
   *
   * 为什么不放进 `Filters`：`Filters` 定义在 `logic/filters.ts`（另一个 worker 的口径面），
   * 且这是一个**视图模式**而不是匹配条件——`applyFilters` 不该为它做逐条判断。
   * 网格在 `dupOnly=true` 时把 `groupDuplicates()` 的结果当渲染骨架。
   */
  dupOnly: boolean
  /**
   * 中栏视图（C 线「最近删除」）：`'assets'` = 正常资产，`'trash'` = 回收站。
   *
   * 与 `Filters` 分开的理由同 `dupOnly`：这是**视图切换**而不是匹配条件；
   * 软删过滤本身落在 `applyFilters(..., view)`（唯一落点），这里只持有状态。
   */
  libraryView: LibraryView
  /**
   * 导入中发现重复时的询问载荷（docs/27 T-06 / T-07 的约定）；`null` = 没有弹窗。
   *
   * 由 `onImportConflictAsk` 推送写入（模块级只订阅一次），由 `ImportConflictDialog`
   * 只读渲染；答复后（含取消）必须归空 —— 用户没答完时**不存在第二个弹窗**
   * （主进程一次导入只问一次，见 §4.5）。
   */
  conflictAsk: ImportConflictAsk | null
  /**
   * 答复一次重复询问：调 `window.modvault.answerImportConflict` 后**无论如何清空** `conflictAsk`。
   *
   * 清空放在 `finally`：主进程已崩溃 / 窗口正在关闭时 invoke 会 reject，
   * 若此时不清，弹窗会永远挂在屏幕上（用户只能强行关窗口）。
   */
  answerConflict: (answer: ImportConflictAnswer) => Promise<void>
  /** 切换视图；进入回收站时清空选择 / 关闭文件视图（右栏不能停在一个当前视图看不见的资产上） */
  setLibraryView: (view: LibraryView) => void
  init: () => Promise<void>
  setFilter: (patch: Partial<Filters>) => void
  // ── 0.6.0 智能集合（保存的筛选视图） ────────────────────────
  /**
   * 套用智能集合：**整组替换** `filters`（以 `DEFAULT_FILTERS` 为底 + 视图快照 + sort）。
   *
   * 必须整组替换而不是 `setFilter` 增量合并：否则「先点收藏视图、再点 4K 视图」会让
   * 收藏条件残留在 4K 视图上。同时退出「重复资产」视图（它不属于筛选快照）。
   */
  applySavedView: (view: SavedView) => void
  /**
   * 把当前 `filters + sort` 存成一个智能集合。
   *
   * 三条拒绝规则（UI 直接显示 `message`）：名字为空 / 重名 / 已达 `SAVED_VIEW_LIMIT`。
   * 写 settings 失败不回滚内存（本来也没改内存），返回 `reason:'error'`。
   */
  saveCurrentView: (name: string) => Promise<SaveViewResult>
  /**
   * 删除指定智能集合（**删的是视图，不是资产**，所以不做二次确认）。
   * 返回 false = 找不到该 id / 写 settings 失败（失败时会落 notice）。
   */
  deleteSavedView: (id: string) => Promise<boolean>
  /** 切换「重复资产」视图；进入时由调用方负责清掉其它筛选维度 */
  setDupOnly: (on: boolean) => void
  select: (id: string | null) => void
  toggleSelect: (id: string) => void
  /** 整批选中（重复组标题行「点标题选中该组全部」用）；空数组 = 清空选择 */
  selectMany: (ids: string[]) => void
  /**
   * 全选**当前可见结果**（Ctrl/Cmd+A、中栏头「全选」按钮）。
   *
   * 语义与 `selectMany` 相同，但独立命名以便调用方表达意图；空数组 = 取消全选。
   * 只接受调用方传入的可见集 id —— **不要**在这里回读全库，否则筛选态下会选中看不见的资产。
   */
  selectAll: (ids: string[]) => void
  /**
   * Shift+点击的范围选择：以 `anchorId`（通常是 `lastClickedId`）为起点，
   * 在 `visibleIds`（当前渲染顺序）上取**含两端**的区间。
   *
   * 纯逻辑在 `logic/selection.ts#selectRangeIds`（锚点丢失 → 退化为单点）。
   */
  selectRange: (anchorId: string | null, targetId: string, visibleIds: string[]) => void
  /**
   * 把选择裁剪到可见集（切换筛选 / 排序 / 视图后由网格调用）。
   *
   * 不变量：`selectedIds` 只包含当前可见结果里的 id——否则批量删除会删掉
   * 用户根本看不见的资产（筛选态下尤其危险）。
   */
  pruneSelection: (visibleIds: string[]) => void
  importPaths: (paths: string[]) => Promise<void>
  dismissImport: (item: string) => void
  // ── 删除安全四件套（P0-16）──────────────────────────────────
  /**
   * 请求删除：只登记待删清单并弹二次确认，**不碰磁盘**。
   * `opts` 仅供「重复资产 → 保留这份」使用（额外警示 + 确认后提示），普通调用不传。
   */
  requestDelete: (ids: string[], opts?: RequestDeleteOptions) => void
  confirmDelete: () => void
  undoDelete: () => void
  commitDelete: () => Promise<void>
  // ── C 线「最近删除」 ─────────────────────────────────────────
  /**
   * 还原软删资产：调 preload → 用返回值（最终 folder / relFolder）写回 Dexie →
   * 清掉 `deletedAt` / `trashRel` → 触发一次重扫（复用现有 rescan 路径）。
   *
   * `renamed` 为真（原位置被占，主进程追加了 `-2`）必须提示，不能静默改名。
   */
  restoreAssets: (ids: string[]) => Promise<void>
  /** 彻底删除（送进系统回收站）；失败项保留索引，提示「N 项失败」 */
  purgeAssets: (ids: string[]) => Promise<void>
  /** 清空回收站（全部软删项 → 系统回收站） */
  emptyTrash: () => Promise<void>
  // ── 分类（T07）─────────────────────────────────────────────
  assignCategory: (ids: string[], category1: string, category2: string) => Promise<AssignSummary>
  /**
   * 用户在待确认浮层里**定案**（T2，`docs/35 §5.1` · `docs/35 §4.2`）。
   *
   * ## 为什么需要单独一个 action 而不是复用 `assignCategory`
   *
   * `assignCategory` 只搬目录、改 `category1/2`，**不碰 `classifyReview`**；而
   * `classifyReview.reason === 'conflict'` 正是这条资产被排进待确认队列的理由
   * （`logic/reviewFlow.ts::reviewReasonOf` 的第 2 条）。不清它，用户确认完下一轮
   * `reconcileTriage` 又会被排回来 —— 表现为"确认了但队列长度纹丝不动"。
   *
   * ## `decidedAt` 的语义是「有人裁定过了」，不是「目录动了」
   *
   * 所以**分类未变（skipped）也要写**：用户点了「用站方的」而资产本来就在那个分类，
   * 这是一次明确的裁定（"就该是这样"），队列该把他放走。若只在 `moved > 0` 时写，
   * 那条资产会永远卡在待确认队列里，每轮都弹回给他。
   *
   * ## 但 `failed > 0` **绝不写**
   *
   * 移动失败 + 标记已定案 = 这条永远停在待确认队列且**不再重试**（`isZhimoVerifyCandidate`
   * 会按 `decidedAt` 跳过它，`reviewReasonOf` 也会返回 null）。这与 `zhimoReclass.ts`
   * 里"只在移动成功后写 `decidedAt`"是同一条理由。
   *
   * @returns `assignCategory` 的原始结果（调用方据此决定前进 / 留在当前张 / 报错）
   */
  decideReview: (id: string, category1: string, category2: string) => Promise<AssignSummary>
  /**
   * 拖拽归类（反馈 6d）：快照原分类 → 走既有 `assignCategory` → 成功后登记 5 秒撤销。
   *
   * - **全部资产都已在目标分类** → 直接返回（不发 IPC、不弹撤销条）；
   * - 归类立即执行（不像删除那样等宽限期），因此撤销是一次**反向真实移动**；
   * - 失败（`moved === 0`）不弹撤销条——失败已由 assignCategory 的 notice 反馈。
   */
  assignCategoryWithUndo: (
    ids: string[],
    category1: string,
    category2: string
  ) => Promise<AssignSummary>
  /** 撤销本次归类：按原分类对分组，逐个搬回（重名由 main 的 uniqueName 兜底） */
  undoAssign: () => Promise<void>
  /** 撤销条到期：只清状态，不做任何落盘动作 */
  commitAssign: (startedAt?: number) => void
  migrateLegacyLayout: () => Promise<{ moved: number; failed: number }>
  /**
   * 材质大类合并（`贴图/` + `材质预设/` → `材质/`）。
   *
   * 顺序固定（docs/14 §2.3.6）：main 搬盘 → **单个 Dexie 事务**逐条 `put` 局部字段
   * （`folder` / `relFolder` / 重名时的 `name`+`dedupeKey`）→ 缩略图重生 → notice →
   * **最后**才布局迁移。`Asset.id` 是 UUID 主键，**禁止 delete+put**（会丢 tags/note/styles）。
   * `force:true` = 设置页手动触发（跳过 >50 保护）。
   */
  mergeMaterial: (opts?: { force?: boolean }) => Promise<MergeMaterialSummary>
  /** 只读刷新待合并数量/来源（设置页打开时用；不搬任何文件） */
  detectMaterialMerge: () => Promise<void>
  /** 双击卡片 → 进入该资产的文件视图；id 不存在时静默忽略（防越界 / 陈旧 id） */
  openFolderView: (id: string) => void
  /** 退出文件视图，恢复原网格 / 列表 */
  closeFolderView: () => void
  /**
   * HDR 预览弹窗的目标资产 id（null = 未打开）。
   *
   * **唯一真相**：三个入口共用它 —— 网格双击 HDR 卡 / 文件视图双击 `.hdr` 行 /
   * 详情面板「预览 HDR」按钮。弹窗本体只在 `App.tsx` 挂一次（lazy），
   * 组件里不要再各复制一份 open state（那会出现两个弹窗 / 关不掉的幽灵窗）。
   */
  hdrPreviewAssetId: string | null
  /** 打开 HDR 预览（非 `kind==='hdri'` 的 id 静默忽略，避免弹出一个必然失败的窗） */
  openHdrPreview: (id: string) => void
  closeHdrPreview: () => void
  /**
   * Quick Look（空格全屏快览浮层，0.8.3，docs/32 §4）的目标资产 id（null = 未打开）。
   *
   * 与 `hdrPreviewAssetId` 同一模式：**唯一真相**，弹窗本体只在 `App.tsx` 挂一次，
   * 组件里不再各复制一份 open state。空格的作用对象由 `logic/quickLook.ts` 的
   * `resolveQuickLookTarget` 决定（纯函数可测），这里只负责"目标是否真实存在"。
   *
   * ⚠️ 关闭浮层**不清空选中**（用户口径：退回时选中态要留着）。第二次 Esc 才走
   * 原有 `clear-selection`（见 `logic/escPriority.ts` 的顺序与理由）。
   */
  quickLookAssetId: string | null
  /** 打开 Quick Look（不在索引里的 id 静默忽略：空格可能命中刚被 rescan 丢弃的陈旧 DOM 节点） */
  openQuickLook: (id: string) => void
  closeQuickLook: () => void
  // ── P2 未分类整理流水线（键盘驱动的串行整理）──────────────────
  /**
   * 整理浮层的**模式**（`null` = 未开启）。
   *
   * 为什么从"只存布尔"扩成"存模式"（docs/35 §4.2 · R-10）：待确认队列有两种原因 ——
   * `unclassified`（双未分类，语义与 P2 完全一致）与 `conflict`（两源冲突，新）。
   * 两者共用**同一个**浮层：`TriageOverlay` 的 509 行里真正与"未分类"耦合的只有 4 处
   * （队列来源 / 标题文案 / 收尾文案 / 右栏内容），另起一个浮层会把另外 30+ 条纪律
   * （Esc 栈顺序、`reconcileTriage` 接位、`busy` 防连按、`panelOpen` 让路、选中态跟随）
   * 复制一遍，必然漂移。
   *
   * 所以浮层必须知道"打开的是哪个队列" —— 只存布尔的话 `conflict` 模式会去渲未分类那批。
   * 两种原因共用同一套游标（`TriageCursor` 只吃 `Asset[]`，与原因无关），
   * 差别只在**队列来源**一处（见 `triageQueueOf`）。
   */
  triageMode: TriageMode | null
  /**
   * 整理模式是否开启；`true` 时 `App` 挂一个 `TriageOverlay`。
   *
   * ⚠️ **派生值，不是独立真相**。唯一写入口是模块内的 `withTriageMode()`：
   * 它同时写 `triageMode` 与 `triageActive`（`triageActive === (triageMode !== null)`），
   * 任何地方都不许单独 `set({ triageActive })` —— 两个字段各写一次迟早不一致。
   *
   * 保留这个字段而不是让调用方自己算，是因为它是**既有公共 API**（`App.tsx:730` 的挂载
   * 判据、`triageWiring.test.ts` 的多处断言都直接读它）。改成派生 selector 要动十几处，
   * 收益为零，风险是把"浮层到底该不该挂"这个判据散开。
   *
   * 存**布尔 + 模式**而不是"当前资产 id"：待办集的游标（当前第几张 / 跳过集）是**会话内**
   * 状态，关掉就该丢（需求：跳过"关闭浮层后不保留状态 —— 不做持久化"）。
   * 把它放进 store 只会让"哪些字段要跟着清理"变成一堆额外案件；浮层内部用
   * `logic/triageFlow.ts` 的 `TriageCursor` 自己管，store 只回答"开没开、开的是哪个"。
   *
   * ## 悬空问题怎么解（**与 `quickLookAssetId` 的 5 个清理站点不同的做法**）
   *
   * Quick Look 存的是「当前那张的 id」，所以每个会删资产的地方都得自己判一句
   * "删的是不是它"。整理模式**不**这样：浮层每帧用 `applyFilters(assets, filters, view)`
   * 现算待办集，再用 `reconcileTriage(cursor, queue)` 稳游标 ——
   * - 当前那张被删 → 落到它原来的下标位置（下一张接位），用户看到的是"这张没了，下一张顶上来"；
   * - 整个待办集空 → `currentId = null` → 浮层自己关闭并发收尾提示。
   *
   * 好处是不会漏站点：本批之后**任何**新的删资产路径（或归类路径、筛选变化、排序变化）
   * 都自动被覆盖，不需要回来补第 6 个、第 7 个清理点。代价是浮层要做一次
   * `applyFilters`（已 memo、1 万条 2.6ms），而它一屏只渲一张、每次操作才重算一次。
   *
   * 唯一仍要显式清理的是**切视图**（`setLibraryView` 里置 null）：那时待办集的
   * 语义整个换了（比如进回收站），继续整理没有意义。
   */
  triageActive: boolean
  /**
   * 打开整理模式。
   *
   * 待办集为空时**不打开**、只给一条 notice（需求：「进入时若待办集为空，不要开浮层」）。
   * 判据走 `logic/triageFlow.ts::buildTriageQueue`（与浮层内部同一份实现）。
   *
   * @param mode `unclassified`（默认，等价于 P2 的既有行为）/ `conflict`（待确认队列）。
   *   **`unclassified` 的每一步（队列、notice 文案、选中态）都与本卡之前逐字相同** ——
   *   那是用户已经熟悉的路径，改一个字都算回归。
   * @returns 是否真的打开了（调用方一般不用，测试与排障用）
   */
  openTriage: (mode?: TriageMode) => boolean
  /**
   * 打开待确认队列（= `openTriage('conflict')`）。
   *
   * 单独一个方法而不是让调用方写 `openTriage('conflict')`：侧栏「待确认」节点 / 批次
   * 汇总 notice / 卡片角「存疑」徽标三个入口都调它（docs/35 §4.3），
   * 入口处不该知道"conflict 是 openTriage 的一个参数"这种实现细节。
   */
  openReview: () => boolean
  closeTriage: () => void
  openCategoryPicker: (ids: string[]) => void
  closeCategoryPicker: () => void
  // ── 0.6.0 批量重命名（docs/22 §3.4） ────────────────────────
  /**
   * 批量重命名弹窗的目标集合；`null` = 关闭。
   *
   * 与 `categoryPickerIds` 同一模式（App 挂一个弹窗），不放组件本地 state 的理由：
   * 弹窗要在执行后刷新 notice 并可能被 Esc 关掉，状态放在 store 里只有一份真相。
   */
  renameIds: string[] | null
  /** 打开重命名弹窗（空数组 = 忽略，不弹空窗） */
  openRenameDialog: (ids: string[]) => void
  closeRenameDialog: () => void
  /**
   * 执行批量改名（**唯一写入口**）。顺序不可调换：
   * ① 调 `window.modvault.renameFolders`（main 侧预检 + 落盘 + 失败回滚）；
   * ② 对 `renamed` 里的每条**原地更新** Dexie 记录（`id` 不变 → `put` 即覆盖，
   *    tags/note/styles/renderParams 全保留；**禁止 delete+put**）；
   * ③ 缩略图重生（封面 salt 依赖绝对路径，目录改名后必然失效）；
   * ④ 一条 notice：`重命名 X 条，失败 Y 条`。
   *
   * 失败条目**保持原记录**（磁盘没动，索引也不能动）。
   */
  applyRenames: (rows: RenameRequestRow[]) => Promise<RenameSummary>
  setNotice: (n: string | null) => void
  // ── 资产操作 ────────────────────────────────────────────────
  renameAsset: (id: string, newName: string) => Promise<void>
  /**
   * 重扫库目录。
   *
   * `opts.force = true` 时跳过两道安全守卫（**唯一**合法调用方是设置页的
   * 「强制重扫」二次确认；不要在其他地方传）。即使 force，**删除前仍会写备份**——
   * 强制不等于不救。
   */
  rescan: (opts?: { force?: boolean }) => Promise<RescanOutcome>
  /** 强制重扫：语义 = `rescan({ force: true })`（共用同一条实现，不复制逻辑） */
  forceRescan: () => Promise<RescanOutcome>
  /**
   * 恢复最近一次「重扫前索引备份」（`db.backups` 里 `rescan-*` 最新一条）。
   * 只恢复**索引**（含 tags/note/styles）：磁盘文件需要用户自己放回原位置。
   * 返回恢复条数（0 = 没有备份 / 数据不可解析）。
   */
  restoreLastRescanBackup: () => Promise<number>
  /** 刷新可用备份条数（设置页打开时调用；只读） */
  refreshRescanBackupCount: () => Promise<void>
  // ── v0.4 库一致性对账（按需检查，不在启动时跑）───────────────────
  /**
   * **只读**检查：调 `window.modvault.rescan()`（主进程 `rescanLibrary()` 纯扫描，
   * 不写库、不动盘、不生成缩略图）→ 用 `reconcile()` 与内存索引对比。
   *
   * 本方法**不写 IndexedDB、不改 store 状态、不改磁盘**（纯只读）。
   * 抛错 = IPC / 库目录不可读，调用方提示即可。
   */
  checkLibraryConsistency: () => Promise<ReconcileReport>
  /**
   * 执行用户勾选的修复（**只有用户确认后才会写库**）。
   *
   * - `removeIndex`：先 `backupRescanDeletions()` 落备份，再 `bulkDelete`（顺序不可颠倒）；
   * - `addIndex`：`bulkPut` 扫描对象（dedupeKey 已由 main 侧算好，**不重算**）；
   * - `fixCategory`：按**当前磁盘**的分类覆盖索引（同时同步 folder/relFolder）；
   * - 三批都是批量写，不逐条 await；单项失败如实计入 `failed`，已成功的**不回滚**；
   * - **幂等**：同一份扫描结果连续 apply 两次，第二次三个计数都是 0（内部会先过滤
   *   「已经是目标状态」的项，并重新扫一次拿当前磁盘真相）。
   */
  applyReconcile: (actions: ReconcileActions) => Promise<ReconcileResult>
  updateAsset: (
    id: string,
    patch: Partial<Pick<Asset, 'tags' | 'note' | 'source' | 'styles'>>
  ) => Promise<void>
  // ── v0.4 资产标记（收藏 / 评分 / 色标），全部支持批量（单选 = 长度 1 的数组）──
  /**
   * 批量设置收藏。落库用一次 `bulkPut`（不逐条 await），只改 favorite + updatedAt；
   * 失败落 notice（不静默）。
   */
  setFavorite: (ids: string[], value: boolean) => Promise<void>
  /** 批量设置评分：0–5 取整并夹紧（见 `normalizeRating`），0 = 清除评分 */
  setRating: (ids: string[], value: number) => Promise<void>
  /** 批量设置色标；传 null = 清除色标 */
  setColorTag: (ids: string[], value: ColorTag | null) => Promise<void>
  /** P0-8 手动封面：更新 cover + coverSource='manual'，并按新封面重生成缩略图（换封面即换 salt） */
  setCover: (id: string, rel: string) => Promise<void>
  /**
   * 2026-10 任务 3：把剪贴板/本地图片写进资产文件夹并设为封面。
   * 前半程走 IPC（main 校验 magic bytes/大小/路径后落盘 `<资产名>.cover.<ext>`），
   * 后半程复用 setCover（coverSource='manual' + RA3 缩略图重生）。
   * 返回 false = 失败（store 已置 notice，UI 直接忽略即可）。
   */
  setCoverFromImage: (
    id: string,
    input: { source: 'clipboard' | 'file'; data?: string; path?: string }
  ) => Promise<boolean>
  // ── 知末封面（docs/24，T-04）─────────────────────────────────
  /**
   * 自动抓取（导入批次结束后由 `scheduleZhimoPipeline()` **在站方分类重排之后**触发）
   * **与手动抓取共用的唯一入口**。
   *
   * 只处理 `kind === 'model'` 且名字里有知末 ID 的资产；**成功逐个 `commitCover`
   * （卡片逐张变化），自动任务失败全程静默**（不 notice、不弹错、不阻塞导入）。
   * `settings.zhimoCover === false` → 自动路径零 IPC 调用（并清空 pending）；
   * **`manual: true` 不看两个开关**（用户点了就是要）。
   *
   * 互斥：本方法持有模块级 `zhimoCoverRunning` 锁。`writeCoverImageInto()` 是
   * `removeStaleCovers()` → `writeFile()` **两步**（没有原子性），所以自动与手动
   * **必须**串行，否则会出现「A 清完同族文件、B 写入、A 再写」的双写竞态（DEF-Z1）。
   */
  runZhimoCovers: (opts?: {
    /** 只抓这些资产 id（自动任务用导入批次收集的清单） */
    ids?: string[]
    /** 显式目标（手动路径用；传了就完全绕过 ids / 全库筛选） */
    items?: ZhimoCoverTarget[]
    /** 手动路径：绕过「已有 manual/zhimo 封面」与 replacePacked 两道过滤 */
    force?: boolean
    /** true = 手动：成功/失败都要给 notice；false（默认）= 自动：全程静默 */
    manual?: boolean
    /** 手动路径取回单条结果（`refreshZhimoCover` 用它拼返回值） */
    onItemResult?: (item: ZhimoCoverTarget, res: FetchZhimoCoverResult) => void
    /**
     * 节流 sleep 的注入点（**仅供单测**传即时桩，运行时不传）。
     * 与 `runZhimoCoverQueue({ sleep })` 同款，避免 60 条用例真等 15 秒。
     */
    sleep?: (ms: number) => Promise<void>
  }) => Promise<ZhimoCoverQueueResult>
  /**
   * 手动「从知末取封面」（详情面板按钮）。
   *
   * 与自动任务的区别：`force`（不看 manual/zhimo 已有封面）、**不读两个设置开关**
   * （用户点了就是要）、失败要给可区分文案（notice）。
   * 实现上**直接复用 `runZhimoCovers`**（同一把锁 + 同一套落库），不复制任何逻辑。
   */
  refreshZhimoCover: (id: string) => Promise<FetchZhimoCoverResult>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  /**
   * 新增一条自定义分类词条（2026-10）。`level: 'level2'` 时 `parent` = 所属一级名。
   *
   * 清洗 / 去重 / 与预设撞名剔除都在 `sanitizeCustomTerm` + 归一化里收口；
   * 清洗后为空或已存在（含预设同名）→ 返回 false（调用方无需提示，词条本来就在）。
   * 走既有 `saveSettings` 落档（主进程 normalizeSettings 再洗一遍，双保险）。
   */
  addCustomCategory: (level: 'level1' | 'level2', parent: string | null, name: string) => Promise<boolean>
  /**
   * 删除一条自定义分类词条（删除保护在 store 层）：
   * 已被任何资产使用 → 拒绝并返回使用数（调用方拿去拼提示），**不改任何资产与目录**。
   * 不做"删除并搬目录"语义（需批量改 relFolder，风险大，用户明确要求前不实现）。
   */
  removeCustomCategory: (
    level: 'level1' | 'level2',
    parent: string | null,
    name: string
  ) => Promise<{ ok: boolean; used: number }>
  /**
   * AI 辅助分类（docs/15 §7，可选功能，默认关闭）。
   *
   * 只处理 `未分类/未分类` 的资产：按名字分批（20 个/批）→ 主进程发请求 →
   * **校验通过的结论**逐组调用既有 `assignCategory`（真实移动目录 + 更新 DB，
   * 不复制移动逻辑）→ 完成后汇总一条 notice。
   *
   * 四条纪律：① 绝不覆盖已有分类；② 任何失败静默降级（不弹错误框）；
   * ③ 正在跑时不重复启动；④ 未启用 / 未配置 → 立即返回，**零网络请求**。
   */
  runAiClassify: () => Promise<AiClassifySummary>
  /**
   * 「重跑自动分类」（v1.0.13）——把历史遗留的 `未分类/未分类` 资产按**当前**词表重判一次。
   *
   * 为什么需要它：分类只在导入那一刻跑。v1.0.11/v1.0.12 修好匹配规则与闸门后，
   * **已入库的旧资产不会自己变好**（用户库里就躺着 10 个 `材质/未分类`），
   * 用户会认为"没修好"。本动作给一个显式入口。
   *
   * 顺序（不可调换）：
   * ① 候选 = `未分类/未分类` 的资产（**已分类的一个都不碰**）；
   * ② 用 `shared/classifyAsset.classifyAssetName` 判定（与导入侧**同一份**实现）；
   * ③ 两个都还是未分类 → 计入 `missed`，不产生任何移动；
   * ④ **先写备份**（`db.backups` 的 `reclass-*`，含还原所需字段），再按分类对**分组**
   *    逐组调既有 `assignCategory`（真实移动 + 缩略图重生 + 写库，不复制移动逻辑）；
   * ⑤ 一条 notice：`重跑分类：移动 X / 未识别 Y / 失败 Z`。
   *
   * 同一时刻只允许一个在跑（`reclassifyRunning`）。
   */
  reclassifyUnclassified: () => Promise<ReclassifySummary>
  /**
   * 按**知末站方分类**重排（`未分类/未分类` → 站方分类）。
   *
   * 为什么不是导入时写分类：站方分类来自详情页，而详情页抓取是 `import:batchDone`
   * 之后的后置任务（见 `shared/types.ts` 的 `classifyBaseName` 契约），**不在导入链路里**。
   * 所以真实形态是：导入先按既有规则落盘 → 批次结束后抓详情页 → 用 `assignCategory` 搬目录。
   *
   * 顺序（不可调换）：
   * ① 候选 = `!isDeletedAsset` + `未分类/未分类` + 能取到知末 ID（**软删记录必须排除**，
   *    它们目录已在 `.trash/`，调 `assignCategory` 必然失败）；
   * ② **先全部抓完**（`fetchZhimoMeta`，只 GET 详情页、不下图片）并按
   *    `shared/zhimoTaxonomyMap` 判定，攒出命中；
   * ③ **抓完之后**才 `backupReclassMoves(hits, 'zhimo-reclass-')`（备份早于任何移动）；
   * ④ 按分类对分组，逐组调既有 `assignCategory`（真实搬目录 + 缩略图重生 + 写库）；
   * ⑤ 返回分桶计数（`approx` 是 `moved` 的子集，必须单独报）。
   *
   * 取消语义：`shouldStop` 每轮查一次；取消后**不再发新请求**，但**已抓到的仍然落库**
   * （搬到一半丢结果比不搬更糟）。
   *
   * 自动触发由 `settings.zhimoAutoCategory` 控制（缺省 true），
   * 且必须**先跑本重排、跑完再抓封面**——两者不许并行打同一个站。
   */
  runZhimoCategoryReclass: (opts?: RunZhimoCategoryReclassOptions) => Promise<ZhimoReclassSummary>
  /**
   * 取消正在跑的站方分类重排：置 `zhimoReclass.cancelRequested = true`。
   * 停止的是"发新请求"；已抓到的命中仍会落库（见 `runZhimoCategoryReclass` 注释）。
   */
  cancelZhimoCategoryReclass: () => void
  /**
   * 一键重扫 · 从知末获取封面（设置页「数据与备份」tab 的手动动作，2026-10 用户拍板）。
   *
   * 场景：重装 ID BOX 后模型重扫，卡片封面选的是 `*.preview.jpg`（SKP 内嵌提取图）；
   * 库内**没有 cover 文件**的资产可以批量重走「知末详情页 → 主图抓取 →
   * 落盘 `<资产名>.cover.jpg`」链路。抓取完全复用既有 IPC `fetchZhimoCover`
   * （`main/zhimoCover.ts` 的重试/超时/限速一律不动），落库复用 `commitCover`。
   *
   * 候选范围（用户裁定）：只补 `isZhimoCoverBackfillCandidate` 命中的资产 ——
   * 已有 cover 文件的一律不重抓；`coverSource='manual'` 的资产永不参与。
   *
   * 与 `runZhimoCovers` 的关系：同一队列形态（`runZhimoCoverQueue`）+ 同一把按资产的
   * 写入锁（DEF-Z1/Z8），但不经过 `zhimoCoverRunning` 互斥与 pending 队列 ——
   * 本动作是全库维度的存量补齐，进度/取消/汇总都独立（`zhimoCoverBackfill`）。
   */
  runZhimoCoverBackfill: (
    opts?: RunZhimoCoverBackfillOptions
  ) => Promise<ZhimoCoverBackfillSummary>
  /** 取消正在跑的封面补抓：置 `zhimoCoverBackfill.cancelRequested = true`（已抓到的照常落库） */
  cancelZhimoCoverBackfill: () => void
  /**
   * 撤销**最近一次**重跑分类：把备份里的资产按原 `category1/category2` 搬回。
   *
   * - `prefix` 是**通道选择**：缺省 `'reclass-'` = 老通道「重跑自动分类」（行为与改造前
   *   逐字一致，所有老调用点一行都不用改）；知末通道传 `'zhimo-reclass-'`。
   *   两个通道的备份互不可见（见 `logic/zhimoReclass.ts` 的前缀注释）。
   * - 同样走 `assignCategory`（不自己写移动逻辑）；原值是 `未分类` 就搬回双哨兵目录；
   * - 资产在当前索引里已不存在（被删了）→ 跳过并计入 `failed`；
   * - 该前缀没有备份 → `{ restored: 0, failed: 0 }`，只给一句 notice，**不报错**；
   * - 备份在还原成功后即删除（"撤销"是消费型操作，避免无限撤销到更早状态）。
   */
  undoLastReclassify: (prefix?: string) => Promise<ReclassUndoSummary>
  /** 刷新「可撤销的重跑备份」条数（设置页打开时 / 重跑或撤销完成后调用） */
  refreshReclassBackupCount: () => Promise<void>
  /**
   * 刷新「可撤销的**知末**重排备份」条数（`zhimo-reclass-*`）。
   *
   * 与 `refreshReclassBackupCount` 分开：两个通道的前缀不同、上限各自 3 份，
   * 混用一个计数器会让「撤销上次知末重排」在只剩老通道备份时错误地亮起。
   */
  refreshZhimoReclassBackupCount: () => Promise<void>
  /**
   * 材质球调参持久化（docs/12 §5.2）。
   *
   * 落库的是 **`normalizeParams` 后的值**（不是原始值）——否则 DB 存
   * `0.30000000000000004` 而 hash 用 `0.30`，两者漂移，`ballThumbIsFresh` 判错。
   * 规范化后与已存值相等 → 直接 return（防无意义写库 + 无意义重渲）。
   * 写库后走 `enqueueBallThumb`（§4.2 的「先建新、再删旧」）。
   *
   * ⚠️ §4.3 竞态：这里**不**把 `thumbStatus` 置非 ready——保持 ready，
   * 等渲染成功再原子更新 `thumbPath`。否则 `ensureMissingThumbs`（候选筛选要求
   * `thumbStatus !== 'ready'`）会把该资产抢进封面缩略图分支，球图丢失。
   */
  persistRenderParams: (assetId: string, scales: BallParamScales) => Promise<void>
  /**
   * 记住材质球的几何形态（`'sphere'` / `'plane'` / `'roundedBox'`）。
   *
   * 形态参与球图 hash（只在非球面时），换形态 = 换期望缓存名 → 走与调参相同的
   * 「先建新、再删旧」链路。与 `persistRenderParams` 一样**不改** `thumbStatus`
   * （否则会被封面缩略图分支抢走，§4.3）。传非法值一律按 `'sphere'` 处理。
   */
  setRenderShape: (assetId: string, shape: BallRenderShape) => Promise<void>
}

function upsert(list: Asset[], asset: Asset): Asset[] {
  const idx = list.findIndex((a) => a.id === asset.id)
  if (idx === -1) return [asset, ...list]
  const next = [...list]
  next[idx] = asset
  return next
}

/** 把某条资产的新版本写回 IndexedDB + 内存（单点收口，避免各处手写 map） */
function commitAsset(set: (fn: (s: VaultState) => Partial<VaultState>) => void, updated: Asset): void {
  void db.assets.put(updated)
  set((s) => ({ assets: s.assets.map((a) => (a.id === updated.id ? updated : a)) }))
}

/**
 * 知末商品 ID 一次性回填（0.6.3，用户 2026-10 反馈）。
 *
 * 背景：`Asset.zhimoId` 是本期新增字段，历史索引记录**全都没有**。
 * 没有它，「从知末取封面」按钮在老资产上仍然不可点、重复判定也还是老口径 ——
 * 用户装了新版本却感觉"没修好"。所以库加载后跑一次回填。
 *
 * 三条纪律：
 * ① **只能从「资产名 + 包内文件相对路径」两处补算** —— 源压缩包名在库里早已不可得
 *    （导入时就被按设置处置了），压缩包名那一档只有**新导入**才吃得到；
 * ② **纯幂等**：只处理 `zhimoId` 为空的记录，算出来是 `null` 就**不写库**
 *    （绝不产生无谓写库 → 不会每次启动刷一遍全库 `updatedAt`）；
 * ③ **不改 `updatedAt`** —— 回填不是用户编辑，不该影响"最近修改"排序。
 *
 * 返回实际回填的条数（调用方一般忽略；日志/测试可用）。
 */
async function backfillZhimoIds(): Promise<number> {
  const pending = useVault
    .getState()
    .assets.filter((a) => !a.zhimoId && Array.isArray(a.files) && a.files.length > 0)
  if (pending.length === 0) return 0

  const updated: Asset[] = []
  for (const a of pending) {
    const zhimoId = zhimoIdFromSources(
      null,
      a.name,
      a.files.map((f) => f.rel)
    )
    if (!zhimoId) continue // 算不出 → 不写（宁可下次再算，也不写空值刷库）
    updated.push({ ...a, zhimoId })
  }
  if (updated.length === 0) return 0

  await db.assets.bulkPut(updated)
  const byId = new Map(updated.map((a) => [a.id, a]))
  useVault.setState((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
  return updated.length
}

/** 标记补丁：只允许这三个 v0.4 字段，防止误改 name/folder 等身份字段 */
type MarkPatch = Partial<Pick<Asset, 'favorite' | 'rating' | 'colorTag'>>

/**
 * 批量改标记（收藏 / 评分 / 色标共用）。
 *
 * 三条纪律：
 * ① **一次 `bulkPut`**（不逐条 await）——批量标记 50 个资产也只开一个事务；
 * ② 只改 `MarkPatch` 里的字段 + `updatedAt`，`importedAt` / tags / note / 分类全原样保留；
 * ③ 写库失败 → 落 notice 并**不更新内存**（避免 UI 显示成功、重启后打回原形）。
 *
 * 返回 true = 成功写入。
 */
async function patchAssets(ids: string[], patch: MarkPatch): Promise<boolean> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (unique.length === 0) return false

  const targets = useVault.getState().assets.filter((a) => unique.includes(a.id))
  if (targets.length === 0) return false

  const now = Date.now()
  const updated: Asset[] = targets.map((a) => ({
    ...a,
    ...patch,
    importedAt: a.importedAt,
    updatedAt: now
  }))

  try {
    await db.assets.bulkPut(updated)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    useVault.setState({ notice: `保存标记失败：${reason}（原标记已保留）` })
    return false
  }

  const byId = new Map(updated.map((a) => [a.id, a]))
  useVault.setState((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
  return true
}

/**
 * RA3 缩略图重生（**先生成新的，再删旧**，06 §12-RA3 / 03 §5.4）。
 *
 * 两种资产走**两条不同的删旧策略**（2026-10 回归修复：用户报「材质球渲染完变成有底的方块」）：
 *
 * **A. 球图适用的资产（材质 / 贴图，见 `ballThumbTarget`）——绝不允许通配删。**
 *    球图缓存与封面缩略图同处 thumbs 目录、同属一个 id，文件名只差 salt
 *    （球图 `<id>-<ballHash>.png`，封面 `<id>-<内容salt>.jpg`）。
 *    旧实现在这里无条件 `deleteThumb(id)`（按 id 通配全删），会把**刚渲好的透明球图
 *    一起删掉**；紧接着 `commitCover` 又把 `thumbPath` 写成新的封面缩略图（不透明 JPEG）
 *    → 卡片上出现一块方形的底色（深色主题下就是黑块）。更糟的是球队列的
 *    `ballAttempted` 让本会话不再重渲 → 只有重启才自愈。
 *    所以这里改为：① 只**精确删上一张封面缩略图**（`deleteOneThumb`，四道校验见
 *    `main/thumb.ts:deleteOneThumb`）；② `thumbPath` 当前就是球图时**原样返回球图名**
 *    ——卡片继续显示透明球，保存封面不会把它顶掉。
 *
 * **B. 其它资产（模型 / HDR / 字体…）**：没有任何球图可误删，沿用原策略
 *    （通配删旧 salt → 再补回），保证缓存目录不残留历史 salt。
 *
 * 两条策略共同的时序约束：新文件在状态切换前必然已在磁盘 → 网格不闪灰格；
 * `ensureThumb` 的 salt 是**内容身份**（路径 + mtime + 尺寸），内容一变就换名
 * → 原地覆盖同名封面（如 HDR 预览「拍照」）也能立刻刷新，不需要重启。
 * 生成失败（无封面 / 图损坏）→ 不删任何旧文件，退化为 'none'（不彻底丢图）。
 */
async function regenThumbSweep(
  id: string,
  coverAbs: string,
  nextCoverSource?: CoverSource
): Promise<{ thumbPath?: string; thumbStatus: ThumbStatus }> {
  const first = await window.modvault.ensureThumb(id, coverAbs).catch(() => null)
  if (!first) return { thumbStatus: 'none' }

  const asset = useVault.getState().assets.find((a) => a.id === id)
  // ⚠️ `nextCoverSource` 是**必须先有**的入参：`commitCover` 的时序是"先重算缩略图、
  // 最后才写 coverSource"，若这里读库里那份旧记录，用户刚点的「更换封面」会被判成
  // "仍该保球图" → 换了封面卡片还显示球（2026-10-23 用户的真实症状）。
  // 所以调用方要把**即将落库的来源**传进来，判定用"未来态"而不是"现状"。
  const ball = asset ? ballThumbTarget(nextCoverSource ? { ...asset, coverSource: nextCoverSource } : asset) : null

  // A：球图资产 —— 精确删「上一张封面缩略图」，球图一个字节都不碰。
  if (asset && ball) {
    // `asset.thumbPath === ball.name` 时上一张就是球图本身，**不能删**（prev 置 null）。
    const prev = asset.thumbPath && asset.thumbPath !== ball.name ? asset.thumbPath : null
    if (prev && prev !== first) {
      // 老 preload / 测试桩可能没有 deleteOneThumb：缺失时静默跳过（不影响落盘）
      const del = window.modvault?.deleteOneThumb
      if (typeof del === 'function') {
        await del.call(window.modvault, id, prev).catch(() => false)
      }
    }
    // 球图仍是当前缩略图（且上面没删它）→ 继续用它（透明 PNG，卡片透出画布色）
    if (asset.thumbPath === ball.name) {
      return { thumbPath: ball.name, thumbStatus: 'ready' }
    }
    // 还没渲过球图 / 参数变了：先用封面缩略图兜底，`commitCover` 会紧接着补一次球图
    return { thumbPath: first, thumbStatus: 'ready' }
  }

  // B：非球图资产（模型 / HDR / 字体…，本资产没有球图可误删）
  //    —— 通配删旧 salt → 再补回（与历史行为一致，缓存目录不残留历史 salt）
  await window.modvault.deleteThumb(id).catch(() => 0)
  const finalName = await window.modvault.ensureThumb(id, coverAbs).catch(() => null)
  return finalName
    ? { thumbPath: finalName, thumbStatus: 'ready' }
    : { thumbStatus: 'none' }
}

/**
 * 是不是**资产根层**的封面文件：`<任意名>.cover.<ext>`（不含 `/`）。
 *
 * 只用于 files 合并时清理同族旧条目 —— 主进程 `writeCoverImageInto()` 落盘前会
 * **删掉同族的其它 `*.cover.*`**，所以 `.cover.png` ↔ `.cover.jpg` 互换之后，
 * 旧 file 条目会指向一个已被删除的文件（体积统计虚高、详情面板里点开 404）。
 * 嵌套路径（如 `Textures/x.cover.jpg`）不属于同族，不碰。
 */
function isRootCoverRel(rel: string): boolean {
  return !rel.includes('/') && /\.cover\.[^./]+$/i.test(rel)
}

/**
 * 封面落库的**唯一入口**（三处共用：`setCover` / `setCoverFromImage` / 知末抓取）。
 *
 * 为什么必须抽出来：封面不只是 `cover` 一个字段。zhimo 落盘后如果**不把新文件并进
 * `files` 并重算 `size`**，详情面板的文件列表看不到它、资产体积也对不上，
 * 要等一次 rescan 才自愈（与 `setCoverFromImage` 原有的补丁同因）。
 *
 * 与"照抄 `setCoverFromImage`"相比多一道：过滤条件从 `f.rel !== rel` 扩成
 * **「同 rel 或 根层同族封面」全部剔除**，见 `isRootCoverRel()` 的注释。
 *
 * 顺序不可调换（RA3）：先合并 files + 算体积 → 再 `regenThumbSweep`（先生成新、
 * 再删旧（球图适用时**只精确删上一张封面缩略图**，绝不通配删））→ 一次性写库 →
 * **最后**补一次球图（`enqueueBallThumb`，fresh 时零成本早退）。中途任何一步失败都不会
 * 留下"cover 指向不存在文件"的中间态（缩略图失败只退化 `thumbStatus`，cover 仍然成立）。
 */
async function commitCover(
  id: string,
  rel: string,
  size: number,
  source: 'manual' | 'zhimo'
): Promise<void> {
  const asset = useVault.getState().assets.find((a) => a.id === id)
  if (!asset) return

  const existing = asset.files.find((f) => f.rel === rel)
  // `setCover`（从资产内挑图）传 size=0 → 沿用索引里该文件的体积；
  // 既不在 files 里、又不知道体积（CustomRenderDialog 那条老路径只回传 rel）→ 不动 files，
  // 保持 0.6.2 的既有行为（等下一次 rescan 自然补上），避免写进一条 size=0 的假记录。
  const knownSize = Number.isFinite(size) && size > 0
  const shouldUpsertFile = knownSize || existing !== undefined
  const entrySize = knownSize ? size : (existing?.size ?? 0)
  const dot = rel.lastIndexOf('.')
  const entry: AssetFile = {
    rel,
    name: rel.slice(rel.lastIndexOf('/') + 1),
    ext: dot > 0 ? rel.slice(dot + 1) : '',
    size: entrySize,
    kind: existing?.kind ?? 'texture'
  }
  const files = shouldUpsertFile
    ? [...asset.files.filter((f) => f.rel !== rel && !isRootCoverRel(f.rel)), entry]
    : asset.files
  const totalSize = shouldUpsertFile ? files.reduce((sum, f) => sum + f.size, 0) : asset.size

  // RA3：先生成新缩略图（salt = 封面路径 + mtime + 尺寸，见 `thumbFileSalt`），
  //      **内容一变就换名** → 渲染层的 `vault://thumb/<名>` URL 跟着变，
  //      原地覆盖同名封面（如 HDR 预览「拍照」）也能立刻刷新，不再需要重启。
  //      失败退化为 'none'（网格走类型占位）。
  const thumb = await regenThumbSweep(id, assetFileAbs(asset.folder, rel), source)

  // 缩略图生成期间资产可能被删 / 被 rescan 替换 → 以**最新**记录为底
  const latest = useVault.getState().assets.find((a) => a.id === id) ?? asset
  const updated: Asset = {
    ...latest,
    files,
    size: totalSize,
    cover: rel,
    coverSource: source,
    thumbPath: thumb.thumbPath,
    thumbStatus: thumb.thumbStatus,
    updatedAt: Date.now()
  }
  void db.assets.put(updated)
  useVault.setState((s) => ({ assets: s.assets.map((a) => (a.id === id ? updated : a)) }))

  // ── 2026-10 回归修复：保存封面后**补一次球图**（不需要重启） ────────────────
  // 上面的 `regenThumbSweep` 已经保证「球图适用时绝不通配删、thumbPath 是球图就继续用球图」
  // （正常路径到这里已是透明球图，下面的入队会命中 fresh 直接早退，零成本）。
  // 这里兜住另一种状态：资产此前**还没渲过球图**（或参数刚变），thumbPath 只能先落在
  // 封面缩略图上（不透明 JPEG）→ 主动入队重渲，卡片随即回到透明球。
  // 清 `ballAttempted` 的理由：它是"同一期望名只试一次"的防抖闸（DEF-09），而保存封面是
  // **显式用户动作**，值得再试一次；否则早先失败过的那次记录会把该资产永久挡在队列外。
  if (ballThumbTarget(updated) && !ballThumbIsFresh(updated)) {
    ballAttempted.delete(updated.id)
  }
  enqueueBallThumb(updated)
}

/**
 * 记一条"站方风格不在本地词表"的 debug 日志（**不打扰用户**）。
 *
 * 为什么必须记：用户说"风格没自动填"时，第一件事是区分
 * ① 站方没给风格（`empty`）② 站方给了但我们不认（`not-in-list`，词表缺口）。
 * 只有 ② 值得记 —— 它是可统计的"词表缺口"信号，不能靠猜。
 *
 * 渲染层日志走 `reportLog`（fire-and-forget）；老 preload / 测试桩没有该 API 时静默跳过。
 */
function reportZhimoStyleNotInList(id: string, style: string, kind: string): void {
  try {
    window.modvault?.reportLog?.({
      level: 'debug',
      message: 'zhimo:style-not-in-list',
      context: { id, style, kind }
    })
  } catch {
    /* 日志失败绝不影响落库 */
  }
}

/**
 * 把知末抓来的风格**补**进资产（TODO-3 / docs/25）：只补空、只认受控词表、只对 model。
 *
 * 落库点刻意放在 `commitCover` **之后**（同一个 `fetchOne` 的按资产锁内）：
 * - 封面与风格来自**同一次详情页 GET**（`res.detailParamsExtract.style`），零额外请求；
 * - `commitCover` 已把新 `cover` / `files` / `size` 写进 state + db，这里读到的
 *   `asset` 一定是新封面那条 → **不会把封面改动覆盖回去**（整对象 `...asset` 展开）；
 * - 先写 Dexie、再同步内存（与 `commitCover` 的次序一致：持久化是事实，state 是视图）。
 *
 * ⚠️ 三条硬约束见 `resolveZhimoStyle()`；本函数**绝不抛错**
 * （风格是锦上添花，Dexie 写失败不能把整批封面队列打断）。
 */
async function applyZhimoStyle(id: string, style: string | null | undefined): Promise<void> {
  try {
    const asset = useVault.getState().assets.find((a) => a.id === id)
    if (!asset) return

    const decision = resolveZhimoStyle(asset, style)
    if (!decision.write) {
      // 只有"站方给了但我们不认"值得记：这是词表缺口的可观测信号
      if (decision.reason === 'not-in-list' && typeof style === 'string') {
        reportZhimoStyleNotInList(id, style.trim(), asset.kind)
      }
      return
    }

    const updated: Asset = { ...asset, styles: [decision.style], updatedAt: Date.now() }
    await db.assets.put(updated)
    useVault.setState((s) => ({ assets: s.assets.map((a) => (a.id === id ? updated : a)) }))
  } catch {
    /* 写库/日志异常一律吞掉：风格失败不该让用户丢封面 */
  }
}

// ── 重扫安全：删除前备份（2026-10 库安全三件套） ─────────────────────
//
// 背景（真实丢数据通道）：切到空目录后自动 rescan → scanned=[] → 本地全部记录
// 匹配不到 → bulkDelete 全库。tags / note / styles / importedAt / source
// **只存在于索引里**，磁盘没有副本 → 删了就永久没了。
// 三层防御：① 空扫描中止；② 批量删除超过一半中止；③ 真删前落完整记录快照。
// 第四层（2026-10 事故后补）：④ 覆盖前把"将被改写的原记录"另存 `rescan-pre-*` 快照
// —— ③ 只保"被删的"，而这次事故丢的是"还在库里、字段被改写的"。

/**
 * 取 `rescan-*` 备份，按时间降序（最新在前）。
 *
 * **排除 `rescan-pre-*`**：那是"重扫覆盖前快照"（见 `backupRescanPreSnapshot`），
 * 语义是"记录被改动之前的样子"，不是"被删记录的还原凭证"。若混进来，
 * 「恢复上次重扫前索引」会取到它 —— 而那些记录都还在索引里 → 恢复 0 条、按钮形同失效。
 */
async function listRescanBackups(): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all
    .filter(
      (b) =>
        typeof b.id === 'string' && b.id.startsWith('rescan-') && !b.id.startsWith('rescan-pre-')
    )
    .sort((a, b) => b.at - a.at)
}

/**
 * 删除前把**完整 records**（不是只有 id）写进 `db.backups`。
 *
 * 只保留最近 `RESCAN_BACKUP_KEEP` 条 `rescan-*`：备份是"救急"，不是归档，
 * 无限增长会把 IndexedDB 撑大且拖慢启动。
 */
async function backupRescanDeletions(records: Asset[]): Promise<void> {
  if (records.length === 0) return
  const at = Date.now()
  await db.backups.put({ id: `rescan-${at}`, at, json: JSON.stringify(records) })
  const list = await listRescanBackups()
  const stale = list.slice(RESCAN_BACKUP_KEEP)
  if (stale.length > 0) await db.backups.bulkDelete(stale.map((b) => b.id))
}

/** 取 `rescan-pre-*`（重扫覆盖前快照），按时间降序（最新在前） */
async function listRescanPreBackups(): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all
    .filter((b) => typeof b.id === 'string' && b.id.startsWith('rescan-pre-'))
    .sort((a, b) => b.at - a.at)
}

/**
 * 重扫**改库之前**把"将被覆盖的本地原记录"整份存进 `db.backups`（`rescan-pre-<ts>`）。
 *
 * 为什么必须有这条：2026-10 的事故里，`rescan` 把 127 条记录的
 * `favorite / rating / colorTag / styles / renderParams` 覆盖掉，而 `db.backups`
 * 里当时**只有** `rescan-*`（仅存被删记录）与 `reclass-*` —— 没有任何"被改之前"
 * 的快照，那批用户数据再也捞不回来。有了这条，同类损伤可以按 json 回退/比对。
 *
 * - 只存**能按 folder 对上本地记录**的原记录（新导入的扫描记录没有"被覆盖"的过去）；
 * - 与删除备份同构：`{ id, at, json }`，json 是原记录数组；
 * - 数量为 0 不写（不制造空备份）；保留期与删除备份同一口径 `RESCAN_BACKUP_KEEP`。
 */
async function backupRescanPreSnapshot(records: Asset[]): Promise<void> {
  if (records.length === 0) return
  const at = Date.now()
  await db.backups.put({ id: `rescan-pre-${at}`, at, json: JSON.stringify(records) })
  const list = await listRescanPreBackups()
  const stale = list.slice(RESCAN_BACKUP_KEEP)
  if (stale.length > 0) await db.backups.bulkDelete(stale.map((b) => b.id))
}

// ── 索引记录卫生：重复记录清理前备份（T-PRUNE，0.7.7） ─────────────────
//
// 与「重扫删除备份」同构，但**刻意用独立前缀** `dup-clean-`：
//
// - `listRescanBackups()` 的过滤条件是 `id.startsWith('rescan-')`，
//   `dup-clean-` 天然**不在**里面 → 设置页的「可恢复的重扫备份」条数
//   （`refreshRescanBackupCount`）不会被这类备份污染；「恢复上次重扫前索引」
//   也不会误取到它（它存的是 `{dropped, rewritten}` 对象，不是 `Asset[]`）。
// - 这就是"显式排除"：**不要**为了让计数变好看把它塞进 rescan 家族，
//   否则那两个按钮的语义会一起被搞坏（一个按 `Asset[]` 解析，一个用来撤销删除）。
//
// 不做成"可一键恢复"的入口：清理是幂等的，被丢弃的记录整条存在这里，
// 需要时从 `db.backups` 手工取即可（本版不给 UI 加按钮，避免多一条误操作路径）。

/** `db.backups` 里「重复索引记录清理」快照的 id 前缀 */
export const DUP_CLEAN_BACKUP_PREFIX = 'dup-clean-'

/** 这类快照的保留条数（清理幂等，正常只有一条；留几份只为可回退） */
export const DUP_CLEAN_BACKUP_KEEP = 3

/** `dup-clean-*` 快照的 json 形状（对象，不是数组 —— 见上面的说明） */
interface DupCleanSnapshot {
  /** 被丢弃的**原始**记录（完整字段，原样） */
  dropped: Asset[]
  /** 幸存者被改写**之前**的原记录（完整字段，原样） */
  rewritten: Asset[]
}

/** 取 `dup-clean-*` 备份，按时间降序（最新在前） */
async function listDupCleanBackups(): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all
    .filter((b) => typeof b.id === 'string' && b.id.startsWith(DUP_CLEAN_BACKUP_PREFIX))
    .sort((a, b) => b.at - a.at)
}

/**
 * 清理重复记录**之前**把原样记录写进 `db.backups`（`dup-clean-<ts>`）。
 *
 * 顺序不可颠倒：先备份、再 put / bulkDelete。备份失败 → 调用方直接放弃本次清理
 * （`cleanupDuplicateRecords` 里 put 在 await 之后），宁可留着重复记录，
 * 也不能在没有还原凭证的情况下删掉用户数据。
 */
async function backupDupCleanup(dropped: Asset[], rewritten: Asset[]): Promise<void> {
  if (dropped.length === 0) return
  const at = Date.now()
  const snapshot: DupCleanSnapshot = { dropped, rewritten }
  await db.backups.put({
    id: `${DUP_CLEAN_BACKUP_PREFIX}${at}`,
    at,
    json: JSON.stringify(snapshot)
  })
  const list = await listDupCleanBackups()
  const stale = list.slice(DUP_CLEAN_BACKUP_KEEP)
  if (stale.length > 0) await db.backups.bulkDelete(stale.map((b) => b.id))
}

/**
 * init 里的「同 folder 重复索引记录」清理（T-PRUNE 治本档 C 的存量迁移）。
 *
 * ## 为什么必须在 `rescueDamagedIndex()` **之前**
 *
 * 后面所有步骤（救援 / 缩略图存在性修复 / 补齐队列）都以"索引记录"为准。
 * 重复记录先收掉，后面的判断才不会对着 12 份必然被删的副本做无用功
 * （其中 11 份的缩略图文件根本不存在，救援也无从下手）。
 *
 * ## 行为
 *
 * - 计划为空（正常库）→ 直接返回同一个数组，**零日志、零 DB 写**；
 * - 有重复 → 先写 `dup-clean-<ts>` 快照，再 `put(merged)` + `bulkDelete(dropIds)`；
 *   全程**只动索引行，绝不碰磁盘上的资产文件夹**（目录由用户与导入流程管理）；
 * - 内存态同步收掉被丢弃的记录、替换幸存者，并返回新数组供后续步骤使用；
 * - 一条 toast，**不弹窗**：用户不需要为一次数据卫生操作做任何决定。
 *
 * ## 为什么整段包 try/catch
 *
 * 这是启动路径。清理是"额外的好事"，任何一步失败（Dexie 配额 / 短暂锁表 / 备份写不进）
 * 都必须让 init 继续 —— 修数据的版本绝不能因为修数据本身打不开。
 * 失败时返回**原始**数组（后续步骤看到的就是未清理的库，行为退回 0.7.6）。
 */
async function cleanupDuplicateRecords(assets: Asset[]): Promise<Asset[]> {
  try {
    const plan = planDuplicateCleanup(assets)
    if (plan.length === 0) return assets

    const byId = new Map(assets.map((a) => [a.id, a]))
    const dropped: Asset[] = []
    const rewritten: Asset[] = []
    for (const group of plan) {
      const keeperBefore = byId.get(group.keepId)
      if (keeperBefore) rewritten.push(keeperBefore)
      for (const id of group.dropIds) {
        const rec = byId.get(id)
        if (rec) dropped.push(rec)
      }
    }

    // ① 先备份（失败即放弃本次清理，见 backupDupCleanup 注释）
    await backupDupCleanup(dropped, rewritten)

    // ② 再写幸存者 + 删多余索引行（只删索引行，不动磁盘目录）
    for (const group of plan) {
      await db.assets.put(group.merged)
    }
    const dropIds = plan.flatMap((g) => g.dropIds)
    if (dropIds.length > 0) await db.assets.bulkDelete(dropIds)

    // ③ 内存态：删掉被丢弃的、替换幸存者（保持原顺序，选中/滚动不错位）
    const dropSet = new Set(dropIds)
    const mergedById = new Map(plan.map((g) => [g.keepId, g.merged]))
    const next = assets
      .filter((a) => !dropSet.has(a.id))
      .map((a) => mergedById.get(a.id) ?? a)
    useVault.setState({ assets: next })

    console.info(
      `[recordHygiene] 合并 ${plan.length} 组重复索引，删除 ${dropIds.length} 条（原始记录已备份 dup-clean-*）`
    )
    enqueueNotice(`已合并 ${dropIds.length} 条重复索引记录（原始记录已备份）`)
    return next
  } catch (err) {
    console.info('[recordHygiene] 重复记录清理跳过：', err instanceof Error ? err.message : err)
    return assets
  }
}

/**
 * init 里的「缩略图索引指向不存在的文件」修复（T-PRUNE 自愈档 B 的存量迁移）。
 *
 * ## 为什么在 `rescueDamagedIndex()` **之后**、`ensureMissingThumbs()` **之前**
 *
 * - 救援先跑：它能把"盘上其实有图、只是 `thumbPath` 被抹掉"的记录挂回去。
 *   若本函数先跑，它会把这类记录判成缺图 → 救援被自己触发的重置挡住。
 * - 补齐队列后跑：本函数把记录置成 `none`，正是队列的候选判据，随后照常重生
 *   （封面缩略图 / 材质球图各有自己的队列）。
 *
 * ## 定向写，不整对象 put
 *
 * `.where('id').equals(id).modify()` 只删 `thumbPath`、写 `thumbStatus`。
 * 整对象 `put` 会拿旧快照把并发写入的字段（尺寸回填 / 分类 / 封面）盖回去
 * —— 这是仓库既有纪律（见 `thumbRescue` / `sizeBackfill`）。
 *
 * ## 静默
 *
 * 用户不需要知道"有几条索引撒谎了"，只需看到卡片自己恢复。只留一条 `console.info`。
 */
async function repairThumbPresence(): Promise<void> {
  try {
    const assets = useVault.getState().assets
    // ⚠️ 失败必须传 **null**，不能传空数组：`[]` 现在是一条合法事实（重装后 thumbs 目录就是空的），
    // 把"列不出来"也传成 `[]` 会让重装后整库缩略图被标成缺图 —— 反过来传 null 才是安全的那一侧。
    const files = await window.modvault.listThumbs().then(
      (r) => r,
      () => null
    )
    const plan = planThumbPresenceRepair(assets, files === null ? null : files.map((f) => f.name))
    if (plan.length === 0) return

    for (const item of plan) {
      await db.assets
        .where('id')
        .equals(item.id)
        .modify((a: Asset) => {
          delete a.thumbPath
          a.thumbStatus = 'none'
        })
      // 本会话可能已经尝试过为它生成过图（init 重复调用 / HMR）→ 解除一次性封锁，
      // 否则补齐队列会跳过它，卡片永远不恢复。
      thumbAttempted.delete(item.id)
    }

    const ids = new Set(plan.map((p) => p.id))
    useVault.setState((s) => ({
      assets: s.assets.map((a) => {
        if (!ids.has(a.id)) return a
        const next: Asset = { ...a, thumbStatus: 'none' as ThumbStatus }
        delete next.thumbPath
        return next
      })
    }))
    console.info(`[recordHygiene] ${plan.length} 条缩略图索引指向不存在的文件，已置为 none 交给补齐队列`)
  } catch {
    // 失败静默：修数据不能阻塞启动；下次启动会重新计算（幂等）
  }
}

/**
 * init 里的「封面死锁自愈」（0.8.3，外部用户 v0.8.2 实测反馈）。
 *
 * ## 修的是什么
 *
 * 0.8.1 重扫入库的资产：盘上根层明明有 `<x>.cover.jpg`（知末抓的主图），
 * 但当时 `pickCover` 还不认 cover 文件 → 索引 `cover` 没指向它 → 卡片缺图；
 * 而 0.8.2 的补抓候选规则④（`hasCoverAssetFile`）见到"已有 cover 文件"又一律
 * 不重抓 → **补抓永远跳过这批资产**，手动单个取又走 `force` 能成 ——
 * 用户看到的就是"一键重扫没效果、按钮坏了"。
 *
 * ## 两段（计划由 `logic/coverSelfHeal.planCoverSelfHeal` 纯函数算出）
 *
 * - **A 重指**：`coverSource` 不是 manual/zhimo、根层有 cover 文件、`cover` 未指向它
 *   → 改指该文件、`coverSource='named'`（与 `pickCover` ① 对 cover 文件同口径），
 *   缩略图置 `none` 交给既有补齐队列重生（**不新造队列**，同 `repairThumbPresence` 的做法）；
 * - **C folder 重建**：`folder` 与 `libraryDir + relFolder` 脱同步（重排/去重改名后
 *   folder 字段未同步的存量，外部日志实锤 `cover:write-failed … ENOENT`）
 *   → 按 `relFolder` 重建绝对路径；落库前用 `probeSizes` 探一张索引内图片核实
 *   重建路径真的在盘上，探不到记一条带 folder 的 WARN 并跳过（宁可不修也不写错）。
 *
 * ## 顺序与静默
 *
 * 在 `repairThumbPresence()` 之后、`ensureMissingThumbs()` 之前（置 none 正好是
 * 队列的候选判据）；整段包 try/catch：修数据的版本绝不能因为修数据本身打不开，
 * 失败静默，下次启动重算（幂等：重指后条件不再成立、重建后字符串相等）。
 */
async function selfHealCoverIndex(): Promise<void> {
  try {
    const state = useVault.getState()
    const plan = planCoverSelfHeal(state.assets, { libraryDir: state.settings?.libraryDir ?? null })
    if (plan.repoints.length === 0 && plan.folderResyncs.length === 0) return

    // ── A：cover 重指（定向 modify，不整对象 put —— 仓库既有纪律） ──
    const repointById = new Map(plan.repoints.map((r) => [r.id, r]))
    for (const item of plan.repoints) {
      await db.assets
        .where('id')
        .equals(item.id)
        .modify((a: Asset) => {
          a.cover = item.rel
          a.coverSource = item.source
          // 封面换了 salt（thumbFileSalt 含 cover 路径）→ 旧缩略图作废，
          // 置 none 让 `ensureMissingThumbs` 按新封面重生
          delete a.thumbPath
          a.thumbStatus = 'none'
          a.updatedAt = Date.now()
        })
      // 本会话可能已为它试过一次（HMR / init 重复调用）→ 解除一次性封锁
      thumbAttempted.delete(item.id)
    }

    // ── C：folder 重建（落库前先核实重建路径在盘上） ────────────────────
    // 同一重建路径只探一次（多个资产同 folder 时去重）
    const probeOk = new Map<string, boolean>()
    const appliedFolders = new Map<string, string>()
    for (const item of plan.folderResyncs) {
      let ok: boolean
      if (item.probeRel) {
        const cached = probeOk.get(item.folder)
        ok =
          cached ??
          (await window.modvault
            .probeSizes(item.folder, [item.probeRel])
            .then((r) => r.length > 0)
            .catch(() => false))
        probeOk.set(item.folder, ok)
      } else {
        // 索引里没有图片可探：按 relFolder 口径直接重建。relFolder 与 folder 由
        // 同一套改名/指派流程一起维护，脱同步只发生在"单边写失败"的存量上，
        // 盲建的风险远小于放着不管（放着它连知末封面都写不进去）。
        ok = true
      }
      if (!ok) {
        // 重建路径也不在盘上 = 整棵子树没了（真漂移），不是字段脱同步 → WARN 跳过
        console.info(`[coverSelfHeal] folder 重建路径在盘上不存在，跳过：${item.folder}`)
        try {
          window.modvault?.reportLog?.({
            level: 'warn',
            message: 'cover:folder-resync-missing',
            context: { id: item.id, folder: item.folder }
          })
        } catch {
          /* 日志失败绝不影响自愈 */
        }
        continue
      }
      await db.assets
        .where('id')
        .equals(item.id)
        .modify((a: Asset) => {
          a.folder = item.folder
        })
      appliedFolders.set(item.id, item.folder)
    }

    // ── 内存态同步（一次 setState 合并 A + C，保持原顺序不错位） ─────────
    if (appliedFolders.size > 0 || repointById.size > 0) {
      useVault.setState((s) => ({
        assets: s.assets.map((a) => {
          const rp = repointById.get(a.id)
          const nf = appliedFolders.get(a.id)
          if (!rp && !nf) return a
          const next: Asset = { ...a }
          if (rp) {
            next.cover = rp.rel
            next.coverSource = rp.source
            next.thumbStatus = 'none'
            delete next.thumbPath
            next.updatedAt = Date.now()
          }
          if (nf) next.folder = nf
          return next
        })
      }))
    }
    console.info(
      `[coverSelfHeal] 重指封面 ${plan.repoints.length} 条，重建 folder ${appliedFolders.size}/${plan.folderResyncs.length} 条`
    )
  } catch {
    // 失败静默：修数据不能阻塞启动；下次启动会重新计算（幂等）
  }
}

// ── 重跑自动分类：移动前备份（v1.0.13） ─────────────────────────────

/**
 * 取 `reclass-*` 备份，按时间降序（最新在前）。
 *
 * `prefix` 是**通道隔离**用的，默认 `'reclass-'` = 与改造前逐字一致（老调用点不传）。
 * 知末站方分类重排传 `'zhimo-reclass-'`（见 `logic/zhimoReclass.ts` 的注释：
 * 两个通道必须各有各的前缀，否则会互相消费对方备份 / 挤掉对方的 3 条上限）。
 */
async function listReclassBackups(prefix: string = 'reclass-'): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all
    .filter((b) => typeof b.id === 'string' && b.id.startsWith(prefix))
    .sort((a, b) => b.at - a.at)
}

/**
 * 重跑分类**移动前**的还原凭证。
 *
 * 必须在任何 `assignCategory` 之前调用：目录一旦搬走，原 `folder` 只存在于这份 json 里
 * （就像重扫前备份的意义一样——磁盘上没有"它原来在哪"的副本）。
 * 只保留最近 `RECLASS_BACKUP_KEEP` 条**同前缀**备份。
 *
 * `prefix` 默认 `'reclass-'`：不传 = 现有行为**逐字不变**（id 形状、保留条数、清理范围）。
 */
async function backupReclassMoves(
  records: ReclassRecord[],
  prefix: string = 'reclass-'
): Promise<void> {
  if (records.length === 0) return
  const at = Date.now()
  await db.backups.put({ id: `${prefix}${at}`, at, json: JSON.stringify(records) })
  const list = await listReclassBackups(prefix)
  const stale = list.slice(RECLASS_BACKUP_KEEP)
  if (stale.length > 0) await db.backups.bulkDelete(stale.map((b) => b.id))
}

/**
 * 启动材质合并探测只处理一次：main 的 `materialMergeNotice` 推送与 `init()` 的主动
 * `detectMaterialMerge()` 可能都到达（顺序不定），重复处理会弹两条 notice。
 */
let mergeProbeHandled = false
/**
 * 处理一次只读探测结果：≤50 自动合并；>50 只提示（批量搬 GB 级目录必须让用户知情）。
 *
 * ⚠️ 库索引为空时**不自动搬**：没有 DB 记录可更新，搬完只能靠用户手动重扫，
 * 不如先把「待合并」状态显示出来（设置页/ notice 都能触发）。
 */
async function handleMergeProbe(info: MergeMaterialDetectResult): Promise<void> {
  if (mergeProbeHandled) return
  mergeProbeHandled = true

  useVault.setState({
    materialMergeCount: info.needMerge ? info.count : 0,
    materialMergeSources: info.sources
  })
  if (!info.needMerge) return
  if (info.count > AUTO_MIGRATE_LIMIT) {
    useVault.setState({
      notice: `检测到 ${info.count} 个资产仍在旧「贴图 / 材质预设」目录下，请在「设置 → 库 → 材质大类合并」中手动合并`
    })
    return
  }
  if (useVault.getState().assets.length === 0) return
  await useVault.getState().mergeMaterial()
}

/**
 * 启动迁移总入口：**先材质大类合并，再遗留布局迁移**（顺序固定，docs/14 §2.3.6）。
 * 反了的话同一资产可能被搬两次（布局迁移先搬到 `材质/…`，合并计划里的 `from` 已不存在 → 噪音失败）。
 */
/**
 * 侧栏入口被关掉时，**必须同时清掉对应的筛选维度**。
 *
 * 用户反馈：收藏 / 色标 / 重复资产三个入口可以在设置里关掉，
 * 但如果关掉时该筛选正生效，就会出现「筛选还在过滤，但侧栏看不到入口也点不掉」的死角。
 * 重置放在 store（唯一的 settings 写入口 `saveSettings` 里），不在渲染层 setState。
 *
 * 纯映射，无副作用：返回 null = 无需重置；`dupOnly` 原样带回，方便调用方一次 set 完。
 */
export function hiddenSidebarFilterReset(
  settings: Settings,
  filters: Filters,
  dupOnly: boolean
): { filters: Partial<Filters>; dupOnly: boolean } | null {
  const patch: Partial<Filters> = {}
  if (settings.showFavorites === false && filters.favoriteOnly) patch.favoriteOnly = false
  if (settings.showColorTags === false && filters.colorTags.length > 0) patch.colorTags = []
  const clearDup = settings.showDuplicates === false && dupOnly
  if (Object.keys(patch).length === 0 && !clearDup) return null
  return { filters: patch, dupOnly: clearDup ? false : dupOnly }
}

async function bootstrapMigrations(): Promise<void> {
  try {
    const info = await window.modvault.detectMaterialMerge()
    await handleMergeProbe(info)
  } catch {
    /* 只读探测失败不阻塞启动（迁移失败下次启动重试） */
  }
  await maybeAutoMigrate()
}

/**
 * **一次性数据救援**（2026-10-23 rescan 事故）：把被抹掉的 `thumbPath` 按盘上真实
 * 文件挂回，并恢复被抹掉的事故参数。规格见 `logic/thumbRescue.ts` 头部注释。
 *
 * ## 为什么必须在 init 的这个位置、并且 await
 *
 * ```
 * db.assets.toArray() → set({ assets }) → ★ 这里 ★ → repairStaleBallThumbs()
 *   → ensureMissingThumbs() → ensureMissingBallThumbs()
 * ```
 *
 * 三个补齐队列的候选判据都是「`thumbStatus !== 'ready'`」。救援晚一步，记录就会先被
 * `ensureMissingThumbs` 抓去按**封面 salt** 生成一张封面缩略图并写成 `ready`
 * ——球图再也挂不回去（用户丢的还是那张调过 UV 的图）。
 *
 * ## 四条硬纪律
 *
 * ① **空跑零成本**：`listThumbs` 失败 / 返回空 / 计划为空 → 直接返回，不写快照、不打日志；
 * ② **失败静默**：整个函数包在 try/catch 里。救援是"额外的好事"，绝不能让 init 打不开；
 * ③ **只写目标字段**：`thumbPath` / `thumbStatus` 与 `renderParams`，用 `.modify()`
 *    定向更新（不整对象 put），并发写入的别的字段原样保留；
 * ④ **不清理孤儿**：这里**绝不**调用 `pruneThumbs`（传部分清单就是批量删盘），
 *    清孤儿是独立的、可预演的另一步。
 *
 * 幂等：计划由"当前状态 + 盘上文件"算出；修完之后谓词自然为假，下次启动零动作。
 */
async function rescueDamagedIndex(assets: Asset[]): Promise<void> {
  try {
    const files = await window.modvault.listThumbs().catch(() => [])
    const thumbPlan =
      files.length > 0 ? planThumbRescue(assets, files, { prefer: RESCUE_PREFER }) : []
    const paramsPlan = planRenderParamsRestore(assets)
    // ① 空跑保护：正常库每次启动都走到这里，必须零副作用
    if (thumbPlan.length === 0 && paramsPlan.length === 0) return

    const touched = new Set<string>()

    // ② 缩略图：先快照（applyThumbRescue 内部做）→ 逐条定向写
    if (thumbPlan.length > 0) {
      await applyThumbRescue(thumbPlan, {
        loadAssets: async (ids) => {
          const rows = await db.assets.bulkGet([...ids])
          return rows
            .filter((a): a is Asset => !!a)
            .map((a) => ({
              id: a.id,
              thumbPath: a.thumbPath,
              thumbStatus: a.thumbStatus,
              deletedAt: a.deletedAt
            }))
        },
        saveSnapshot: async (snapshot) => {
          await db.backups.put(snapshot)
        },
        updateThumb: async (assetId, thumbPath) => {
          await db.assets
            .where('id')
            .equals(assetId)
            .modify((a: Asset) => {
              a.thumbPath = thumbPath
              a.thumbStatus = 'ready'
            })
        }
      })
      for (const item of thumbPlan) touched.add(item.assetId)
    }

    // ③ 事故参数：只在**当前为空**时写（用户事后新调的值优先级最高）。
    //    这里不写快照：写入是"填空"，不覆盖任何既有用户数据，回退只需删字段。
    //    也不动 `updatedAt`——救援不是用户编辑（与 backfillZhimoIds 同一纪律）。
    for (const item of paramsPlan) {
      await db.assets
        .where('id')
        .equals(item.assetId)
        .modify((a: Asset) => {
          if (a.renderParams && Object.keys(a.renderParams).length > 0) return
          a.renderParams = item.params
        })
      touched.add(item.assetId)
    }

    // ④ 内存态**按 id 窄替换**（不要整体替换 `assets`：那会让正在进行的选中/滚动错位）
    if (touched.size === 0) return
    const rows = await db.assets.bulkGet([...touched])
    const byId = new Map<string, Asset>()
    for (const row of rows) if (row) byId.set(row.id, row)
    if (byId.size === 0) return
    useVault.setState((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
  } catch {
    // ② 救援失败一律静默：绝不能让"修数据的版本"打不开
  }
}

export const useVault = create<VaultState>((set, get) => ({
  assets: [],
  filters: { ...DEFAULT_FILTERS },
  selectedId: null,
  selectedIds: [],
  lastClickedId: null,
  imports: [],
  settings: null,
  ready: false,
  pendingDelete: null,
  pendingAssign: null,
  notice: null,
  legacyLayoutCount: 0,
  rescanBackupCount: 0,
  materialMergeCount: 0,
  materialMergeSources: [],
  materialMergeBusy: false,
  aiClassifyBusy: false,
  zhimoCoverBusyId: null,
  reclassifyBusy: false,
  reclassifyBackupCount: 0,
  zhimoReclassBackupCount: 0,
  zhimoReclass: { ...IDLE_ZHIMO_RECLASS_STATE },
  zhimoCoverBackfill: { running: false, done: 0, total: 0, cancelRequested: false },
  categoryPickerIds: null,
  renameIds: null,
  folderViewAssetId: null,
  hdrPreviewAssetId: null,
  quickLookAssetId: null,
  triageMode: null,
  triageActive: false,
  dupOnly: false,
  libraryView: 'assets',
  conflictAsk: null,

  async init() {
    // 重入闸门（见模块级 `initInFlight` 注释）：正在跑的这一次未结束前，第二次调用直接返回。
    // 跑完即复位，所以 rescan 后重建、单测里逐条 `await init()` 仍能正常执行。
    if (initInFlight) return
    initInFlight = true
    try {
    const [settings, assets] = await Promise.all([
      window.modvault.getSettings(),
      db.assets.toArray()
    ])
    set({ settings, assets, ready: true })

    // ── 设置广播订阅（DEF-22-1）────────────────────────────────────────
    // **必须在上面那次 `set` 之后**：`getSettings()` 是 await 的，若先订阅，
    // 「init 还没跑完、用户从主进程改了设置 → 广播写入新值」随后会被这次
    // `set({ settings })` 用**更早的快照**盖回去，用户看到的是"改了又弹回去"。
    // 放这里之后最坏情况是漏掉"init 完成前这几十毫秒内的那次变更"，
    // 而那种变更主进程已落盘、下一次 init / 重启必然生效（不会出现"永久不一致"）。
    // 幂等由模块级 `settingsChangedSubscribed` 保证（StrictMode 双跑不会重复订阅）。
    ensureSettingsChangedSubscribed()

    // ── ① 索引记录卫生：同 folder 重复记录先收掉（T-PRUNE 治本档 C 的存量迁移） ──
    // 必须在救援之前：后面每一步都以"索引记录"为准，12 份必然被删的副本先出局，
    // 救援 / 存在性修复 / 补齐队列才不会对着它们做无用功。
    // 正常库（无重复）→ 原样返回、零日志、零 DB 写。
    // 返回的 `cleaned` 是**清理后**的列表，后续步骤必须用它，不能再用上面那份快照。
    const cleaned = await cleanupDuplicateRecords(assets)

    // 一次性数据救援（2026-10-23 rescan 事故）：**必须 await 且必须在三个补齐队列之前**。
    // 晚一步，`ensureMissingThumbs` 会先按封面 salt 生成封面缩略图并写成 ready，
    // 被抹掉的球图就再也挂不回去了（详见 `rescueDamagedIndex` 的注释）。
    await rescueDamagedIndex(cleaned)

    // ── ② 缩略图存在性修复（T-PRUNE 自愈档 B）──────────────────────────────
    // 顺序：救援之后（先让它把盘上真实存在的图挂回去）、补齐队列之前（置成 none
    // 正好是队列的候选判据）。静默执行：用户只需要看到卡片自己恢复。
    await repairThumbPresence()

    // ── ②b 封面死锁自愈（0.8.3，A 重指 + C folder 重建）──────────────────
    // 同样卡在"救援之后、补齐队列之前"：重指后的 cover 置 none，正好交给下面的
    // `ensureMissingThumbs` 按新封面重生；folder 先修好，缩略图生成才不会对着
    // 失效路径空跑。静默执行，幂等。
    await selfHealCoverIndex()

    // 知末 ID 一次性回填（0.6.3）：老索引记录没有 `zhimoId` → 从资产名/包内文件补算。
    // 纯幂等：算不出就不写库，已回填过的记录下次启动直接跳过。失败不影响启动（catch 吞掉）。
    void backfillZhimoIds().catch(() => 0)

    // 可恢复的重扫备份条数（设置页按钮可用性；只读）
    void get().refreshRescanBackupCount()

    // 清理孤儿缩略图缓存（索引里已不存在的 id），失败静默
    window.modvault.pruneThumbs(cleaned.map((a) => a.id)).catch(() => 0)
    // 修「封面已被用户指定、缩略图却还是旧球图」的存量记录（2026-10-23 反馈，幂等、封顶 40 条）
    void repairStaleBallThumbs()
    // 启动后后台补齐缺缩略图的资产（v1 迁移 / rescan 后 thumbStatus 都是 none）
    void ensureMissingThumbs()
    // 材质类资产补材质球图（后台串行队列，2026-10 任务 6）
    void ensureMissingBallThumbs()
    // 遗留布局自动迁移（≤50 条自动搬，>50 条等设置页手动触发，03 §4.4）
    // 2026-10 材质合并：入口改为「先合并材质大类、再布局迁移」（顺序固定，docs/14 §2.3.6）
    void bootstrapMigrations()
    // main 侧启动只读探测的推送（与上面的主动探测二选一，由 mergeProbeHandled 去重）
    window.modvault.onMaterialMergeNotice((info) => {
      void handleMergeProbe(info)
    })

    // AI 辅助分类（docs/15 §7）：导入批次结束后**后台**补分类。
    // 事件由 main 在 `importPaths` 返回后 fire-and-forget 发出（UI 导入与监控目录导入都覆盖）。
    window.modvault.onImportBatchDone(() => {
      scheduleAiClassify()
      // 知末后置流水线：**先按站方分类重排、跑完再抓封面**（串行，不并行打同一个站）。
      // 同 `scheduleAiClassify`：`setTimeout(0)`，绝不 await 网络请求。
      scheduleZhimoPipeline()
      // docs/27 §3.1：批次结束后把「已跳过 N 个」/「已覆盖 N 个」各汇总成一条 toast。
      // 两条**互不吞并**（用 `enqueueNotice` 依次展示）：先跳过、后覆盖，顺序即发生顺序。
      flushSkippedSummary()
      flushOverwriteSummary()
      flushJunkSummary()
      // 批次边界复位：监控目录导入不走 `importPaths`，只有这里能给下一批重新开门。
      // main 保证 `import:batchDone` 在整批 `import:event` 之后才发 → 复位不会吞掉本批的切换。
      libraryViewRestoredInBatch = false
    })

    // docs/27 T-06：重复询问的订阅（**幂等**，模块级只注册一次；重复订阅会让一次询问被处理多次）
    ensureConflictAskSubscribed()

    window.modvault.onImportEvent((ev) => {
      // 终态（done / error / skipped）记下**绝对时间戳**：ImportQueue 的自动消失倒计时以它为起点，
      // 悬停暂停 / 恢复、重建 timer 都不会重新计时（见 logic/importText.ts）。
      // ⚠️ `skipped` 必须是终态：它不是进行中，没有倒计时条目就永远留在队列里。
      const settled = isTerminalStatus(ev.status)
      /**
       * 一条事件 = 对同一个 `item` 的一次状态推进（pending → extracting → done）。
       *
       * 队列顺序**必须是"首次出现顺序"（稳定）**：导入队列现在是「居中 + 向上堆叠」，
       * 条目下标一变，整张卡就会在屏幕下方跳一下。所以已在队列里的条目**原地更新**
       * （`map` 保留下标），只有第一次出现才追加到尾部。
       *
       * ⚠️ 与呈现层的契约：store 只保证"首次出现顺序"，**"最新在底部"的视觉倒序由组件
       * 做**（`[...imports].slice(-6).reverse()`）。这里绝不倒序，否则两边各倒一次 = 又反了。
       *
       * `settledAt` 必须**显式覆盖**：就地更新时 `{ ...i, ...patch }` 会把上一次的
       * `settledAt` 原样带过来；新一轮 `extracting` 必须写 `undefined` 清掉，
       * 否则 ImportQueue 会给"进行中"的条目起一根倒计时（详见 `logic/importText.ts`）。
       */
      const patch = {
        itemName: ev.itemName,
        status: ev.status,
        message: ev.message,
        asset: ev.asset,
        needBytes: ev.needBytes,
        freeBytes: ev.freeBytes,
        conflict: ev.conflict,
        settledAt: settled ? Date.now() : undefined
      }
      set((s) => {
        const exists = s.imports.some((i) => i.item === ev.item)
        // 第一次出现 → 追加到队尾（与旧行为一致；队尾 = 最新出现的条目）
        if (!exists) return { imports: [...s.imports, { item: ev.item, ...patch }] }
        // 已在队列里 → **原地更新**（`map` 保留下标：状态推进不改变位置）
        const updated = s.imports.map((i) => (i.item === ev.item ? { ...i, ...patch } : i))
        // 兜底去重：历史遗留的同 item 重复条目只保留"首次出现"那一条
        // （旧实现用 filter 重建数组，天然去重；保序后必须显式补回来，
        //   否则 `importPaths` 预置的 pending 条目与后续事件可能各留一份）
        const firstAt = s.imports.findIndex((i) => i.item === ev.item)
        return { imports: updated.filter((i, idx) => i.item !== ev.item || idx === firstAt) }
      })
      // 跳过的重复素材：只累计，等批次结束汇总成一条 notice（§3.1）
      if (ev.status === 'skipped') skippedInBatchCount += 1
      // 物理删除的杂质文件数：同样只累计（0.9.0）。`cleanedJunk` 字段**缺席 = 没删**，
      // 不是空数组——所以这里用 `?.length ?? 0`，不要写成 `ev.cleanedJunk.length`。
      if (ev.cleanedJunk) cleanedJunkInBatchCount += ev.cleanedJunk.length
      // 覆盖的重复素材：批次级汇总的累计。
      // 退化判定**只读结构化字段** `ImportEvent.conflict.degraded`（`: true` 仅当 overwrite 走了
      // 退化路径：旧目录不存在 / kind 变 / 库外 / 旧版没进回收站）。
      // 不嗅探 `message` 文案；`degraded === undefined`（旧主进程 / 老日志）按 false ——
      // 同包发布、不存在跨版本混用，这是唯一能从类型上做出的判断。
      if (ev.status === 'done' && ev.conflict?.resolution === 'overwrite') {
        overwrittenInBatchCount += 1
        if (ev.conflict.degraded === true) {
          overwrittenDegradedCount += 1
        }
      }
      if (ev.status === 'done' && ev.asset) {
        // 本批落库数：给批次汇总的"本批 N 个素材"用（消费型，见 `reportReviewSummary`）。
        // ⚠️ 只累加、**绝不在这里发任何汇总** —— 那就是"拖 50 个包弹 50 次"。
        importedInBatchCount += 1
        void db.assets.put(ev.asset)
        set((s) => ({ assets: upsert(s.assets, ev.asset!) }))
        // 导入完成后才渲球图（**不阻塞导入进度条**）：入队即返回，后台串行消费
        enqueueBallThumb(ev.asset)
        // 知末封面：只收 model + 名字里有 ID 的（材质/贴图不做，docs/24 口径 #8）
        enqueueZhimoCover(ev.asset)
        // 资产**真的落库**（不是 skipped / error）→ 若用户停在「最近删除」，切回资产视图。
        // 一批只切一次；只有 skipped / error 的批次不切（没有新资产可看）。
        restoreLibraryViewAfterImport()
      }
    })
    } finally {
      initInFlight = false
    }
  },

  setFilter: (patch) =>
    set((s) => {
      const merged: Filters = { ...s.filters, ...patch }
      // 切大类时才归一化（`sanitizeFiltersForKind`）：新视图不支持的维度 / 新视图没有的
      // 分辨率档必须清掉，否则入口消失了条件还在生效 → 网格空着且用户找不到原因。
      // 只在 `patch.kind` 存在时跑：改其它维度不必每次重建对象（memo 引用稳定）。
      return { filters: 'kind' in patch ? sanitizeFiltersForKind(merged) : merged }
    }),

  // ── 0.6.0 智能集合 ─────────────────────────────────────────

  applySavedView: (view) =>
    set({
      // 整组替换：`filtersFromSavedView` 已用 DEFAULT_FILTERS 补齐缺失键、丢弃非法值
      filters: filtersFromSavedView(view),
      // 「重复资产」是视图模式而非筛选条件，套用筛选视图时一并退出
      dupOnly: false
    }),

  async saveCurrentView(name) {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, reason: 'empty-name', message: '集合名称不能为空' }
    }
    const settings = get().settings
    if (!settings) {
      return { ok: false, reason: 'no-settings', message: '设置尚未加载，请稍后重试' }
    }
    const savedViews = Array.isArray(settings.savedViews) ? settings.savedViews : []
    if (savedViews.length >= SAVED_VIEW_LIMIT) {
      return {
        ok: false,
        reason: 'limit',
        message: `最多保存 ${SAVED_VIEW_LIMIT} 个集合，请先删除一个`
      }
    }
    if (savedViews.some((v) => v.name === trimmed)) {
      return { ok: false, reason: 'duplicate', message: '已有同名集合，请换个名字' }
    }

    const filters = get().filters
    const view: SavedView = {
      id: newSavedViewId(),
      name: trimmed,
      // 纯数据快照（逐键挑选，不含任何函数 / 派生字段）
      filters: snapshotFilters(filters),
      sort: filters.sort,
      createdAt: Date.now()
    }
    try {
      await get().saveSettings({ savedViews: [...savedViews, view] })
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        message: `保存失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
    set({ notice: `已保存智能集合「${trimmed}」` })
    return { ok: true, view }
  },

  async deleteSavedView(id) {
    const settings = get().settings
    if (!settings) return false
    const savedViews = Array.isArray(settings.savedViews) ? settings.savedViews : []
    if (!savedViews.some((v) => v.id === id)) return false
    try {
      await get().saveSettings({ savedViews: savedViews.filter((v) => v.id !== id) })
      return true
    } catch (err) {
      set({ notice: `删除集合失败：${err instanceof Error ? err.message : String(err)}` })
      return false
    }
  },

  setDupOnly: (on) => set({ dupOnly: on }),

  /**
   * 切换「资产 / 最近删除」视图。
   *
   * - 清空选择与文件视图：否则右栏详情会停在一个当前视图里根本看不见的资产上；
   * - 进入回收站时关掉「重复资产」视图（重复检测只对在库资产有意义）；
   * - **不清空 filters**：按需求，分类/风格/收藏在回收站里灰置但保留，
   *   返回资产视图时原样继续生效（回收站视图本来也不套用它们，见 matchesFilters）。
   */
  setLibraryView: (view) =>
    set((s) =>
      withPickerClosed({
        libraryView: view,
        selectedId: null,
        selectedIds: [],
        lastClickedId: null,
        folderViewAssetId: null,
        // 切视图（含进入回收站）关闭 Quick Look：浮层是"当前视图序列"上的快览，
        // 视图一换序列就变了，留着浮层会让 ←/→ 跳到另一个视图的对象上。
        quickLookAssetId: null,
        // 整理模式同理，而且更严格：待办集就是"当前视图里双未分类的"，
        // 视图一换待办集整个换掉，留着会让用户对着另一批资产继续按确认。
        // 走 `withTriageMode(null)` 而不是裸写 `triageActive: false`：两个字段必须一起清
        // （否则会留下 `triageMode: 'conflict'` + `triageActive: false` 的脏组合）。
        ...withTriageMode(null),
        dupOnly: view === 'trash' ? false : s.dupOnly
      })
    ),

  // 首次点开该资产且球图缓存未命中 → 后台渲一张（网格/详情共用这张缓存图）
  select: (id) => {
    set(withPickerClosed({ selectedId: id, selectedIds: id ? [id] : [], lastClickedId: id }))
    if (id) {
      const asset = get().assets.find((a) => a.id === id)
      if (asset) enqueueBallThumb(asset)
    }
  },

  // Ctrl/Cmd+点击：切换多选；普通 select 走单选语义
  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id)
      const selectedIds = has
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id]
      const selectedId = has ? (selectedIds[0] ?? null) : id
      // 切换也算一次"点击" → 更新 Shift 锚点（取消选中后仍以它为锚点，
      // 这是文件管理器的通行手感：勾掉一个再 Shift 点另一个，从刚才那格开始扩）
      return withPickerClosed({ selectedIds, selectedId, lastClickedId: id })
    }),

  // 整批选中：重复组标题行点击 → 组内全部进入多选（批量删除 / 批量指派可直接用）。
  // 普通 `select` 会清空多选，所以这里必须走独立入口。
  selectMany: (ids) => {
    const next = dedupeIds(ids)
    set(withPickerClosed({ selectedIds: next, selectedId: next[0] ?? null, lastClickedId: next[0] ?? null }))
  },

  // 全选当前可见结果（Ctrl/Cmd+A / 中栏头「全选」）；空数组 = 取消全选
  selectAll: (ids) => {
    const next = dedupeIds(ids)
    set(withPickerClosed({ selectedIds: next, selectedId: next[0] ?? null, lastClickedId: next[0] ?? null }))
  },

  // Shift+点击的范围选择（区间顺序 = 可见顺序，含两端）
  selectRange: (anchorId, targetId, visibleIds) => {
    const next = selectRangeIds(anchorId, targetId, visibleIds)
    set(
      withPickerClosed({
        selectedIds: next,
        // target 不可见时 next 为空 → 详情面板同时清空，不留下"选中了看不见的东西"的错觉
        selectedId: next.length > 0 ? targetId : null,
        lastClickedId: targetId
      })
    )
  },

  /**
   * 选择裁剪：只保留可见集里的 id（**按可见顺序重排**）。
   *
   * 无变化时返回 `{}` —— zustand 仍会通知订阅者，但不会改变任何字段，
   * 且本方法只在可见集变化（`AssetGrid` 的 pruneKey 变化）时被调用，不会每帧跑。
   */
  pruneSelection: (visibleIds) =>
    set((s) => {
      if (s.selectedIds.length === 0) return {}
      const next = pruneToVisible(s.selectedIds, visibleIds)
      const unchanged =
        next.length === s.selectedIds.length && next.every((id, i) => id === s.selectedIds[i])
      if (unchanged) return {}
      const keep = new Set(next)
      return withPickerClosed({
        selectedIds: next,
        selectedId: s.selectedId && keep.has(s.selectedId) ? s.selectedId : (next[0] ?? null),
        lastClickedId: s.lastClickedId && keep.has(s.lastClickedId) ? s.lastClickedId : null
      })
    }),

  async importPaths(paths) {
    // 新一轮导入开始：复位「本批已切回资产视图」闩锁。
    // ⚠️ 只在这里（和批次结束）复位，**绝不在每条 `done` 里复位** ——
    // 否则用户中途手动切回回收站后，下一条 `done` 又会把他拽回资产视图。
    // 放在空数组短路之前：`importPaths([])` 是一次"空批次"，复位它是正确语义
    // （也让单测可以用它显式开一批）。
    libraryViewRestoredInBatch = false
    if (paths.length === 0) return
    set((s) => ({
      // 队列顺序契约 = **首次出现顺序**（稳定）：新条目一律**追加到队尾**。
      // 旧实现是前置（`...paths, ...s.imports`），那会让"后来的一批"排到最前 ——
      // 与呈现层 `imports.slice(-6).reverse()`（最新在底部）刚好相反：
      // 队列超过 6 条时，新导入的条目会被 `slice(-6)` 挡在可见窗口之外。
      // store 只负责"首次出现顺序"，视觉倒序只在组件里做一次（别两边都倒）。
      imports: [
        ...s.imports,
        ...paths.map((p) => ({ item: p, itemName: p.split(/[\\/]/).pop() ?? p, status: 'pending' as const }))
      ]
    }))
    // docs/27 §4.1 / D22：判重快照由**渲染层**在调用时一次性传入（主进程拿不到 Dexie）。
    // 快照排除软删资产（D17）；`index` 为空数组 = 不判重 = 0.6.9 的旧行为。
    const ctx = { index: buildDedupeSnapshot(get().assets) }
    await window.modvault.importPaths(paths, ctx)
    // 导入批次结束 → 后台补分类（docs/15 §7）。
    // ⚠️ `scheduleAiClassify` 只是 `setTimeout(..., 0)`，**没有 await 任何网络请求**：
    // 导入动作的耗时不因配置了 AI 而增加一个毫秒（main 侧也会推 import:batchDone，双保险）。
    scheduleAiClassify()
    // 同上：知末这边是**一条链**（先站方分类重排 → 再抓封面），不是两个并行任务。
    // 链式的原因：两者打同一个站；重排只取详情页（便宜）且必须先跑完，封面才开工。
    scheduleZhimoPipeline()
  },

  /**
   * 答复一次重复询问（docs/27 T-07 提交入口）。
   *
   * `conflictAsk` 的清空放在 `finally`：主进程崩溃 / 窗口关闭时 invoke 会 reject，
   * 不清就会留一个永远点不掉的弹窗。失败不抛给 UI（用户没有可行动项，且主进程侧
   * 超时兜底本身就会全跳过）。
   */
  async answerConflict(answer) {
    // **先同步清再等 IPC**：主进程可能早已超时、根本不理这条答复（回 `phase:'stale'`），
    // 若等返回值再清，弹窗会卡在屏幕上（DEF-19-1 的真机症状）。所以任何用户点击
    // 都必须立刻让弹窗消失，与 IPC 成败无关。
    clearConflictAskWatchdog()
    set({ conflictAsk: null })
    try {
      await window.modvault.answerImportConflict(answer)
    } catch {
      // 主进程已不可达：答复必然已被超时兜底接住，UI 已经收场，无需再做什么
    }
  },

  dismissImport: (item) => set((s) => ({ imports: s.imports.filter((i) => i.item !== item) })),

  // ── P0-16 删除安全 ───────────────────────────────────────────

  /** 第一步：只记录待删清单、弹确认框。**不碰磁盘、不碰索引。** */
  requestDelete(ids, opts) {
    // C 线守卫：已软删的资产不能再走删除流程（文件已经在 `.trash/`，旧 folder 已不存在）
    const targets = get().assets.filter((a) => ids.includes(a.id) && !isDeletedAsset(a))
    if (targets.length === 0) return
    set({
      pendingDelete: {
        ids: targets.map((t) => t.id),
        targets: toDeleteTargets(targets),
        stage: 'confirming',
        startedAt: 0,
        // 撤销期由用户在设置·数据与备份里决定（0 = 不等待 / 3000 / 5000，默认 5000）。
        // 快照在**这一刻**取值：确认过程中用户去改设置，不改变本次删除的等待时长。
        // `normalizeUndoGraceMs` 兜脏值（存档被手改成 9999 之类），绝不返回 undefined。
        graceMs: normalizeUndoGraceMs(get().settings?.undoGraceMs),
        warning: opts?.warning,
        notice: opts?.notice
      }
    })
  },

  /**
   * 第二步：用户确认。
   *
   * 两条分支（2026-10 用户裁定「删除是否要等 5 秒给用户自己定」）：
   * - `graceMs > 0`（3 / 5 秒）→ 进入 `grace` 宽限期，底部撤销条倒计时，
   *   此时文件仍在磁盘上（这正是 undo 可行的前提）；
   * - `graceMs === 0`（不等待）→ **不进入 `grace`**，直接调 `commitDelete()` 落盘。
   *
   * 为什么用"跳过 grace"而不是"grace 但 0 秒"：`NoticeToast` 只在
   * `pendingDelete.stage === 'grace'` 时渲染撤销条，跳过阶段就**天然没有倒计时条**，
   * 不需要在 toast 里加 `graceMs === 0` 的特判（少一处分支 = 少一处漂移）。
   * 二次确认弹窗**仍然存在**（它绑定的是 `stage === 'confirming'`，与本分支无关）。
   */
  confirmDelete() {
    const p = get().pendingDelete
    if (!p || p.stage !== 'confirming') return
    // 不等待：直接走真正落盘的那一步（commitDelete 内部先同步清 pendingDelete，
    // 再 await IPC —— 所以调用返回时状态机已经收场，不会残留 grace 阶段）。
    if (p.graceMs <= 0) {
      void get().commitDelete()
      return
    }
    set({
      pendingDelete: { ...p, stage: 'grace', startedAt: Date.now() },
      // 场景化提示（v0.4 重复资产）：普通删除不传 notice → 行为与原来完全一致
      ...(p.notice ? { notice: p.notice } : {})
    })
  },

  /** 撤销：宽限期内什么都没删，直接清状态即可。 */
  undoDelete() {
    if (!get().pendingDelete) return
    set({ pendingDelete: null })
  },

  /**
   * 第三步（宽限期到期或用户点「确认删」）：真正删除。
   *
   * C 线分流（2026-10）：
   * - `trashRetention === 'recycle'` → **旧行为完全不变**（`trashPaths` 直接进系统回收站 +
   *   从索引删除 + 删缩略图缓存）；
   * - 其余三档（5d / 10d / 30d）→ 软删到 `<库根>/.trash/`：**索引记录保留**，
   *   写回 `deletedAt` / `trashRel`，用户可在「最近删除」里还原。
   *
   * 铁律：`failed[]` 里的项**绝不写 deletedAt**。否则界面显示"已删除"，文件却还在原位，
   * 还原时又没有 trashRel —— 两条路径同时坏掉。
   */
  async commitDelete() {
    const pending = get().pendingDelete
    if (!pending) return
    const targets = get().assets.filter((a) => pending.ids.includes(a.id))
    set({ pendingDelete: null })
    if (targets.length === 0) return

    const retention = get().settings?.trashRetention ?? '30d'

    // ── 旧行为：直接进系统回收站（保留期 = 'recycle'）──────────────────
    if (retention === 'recycle') {
      // 失败的路径留在原地（下次还能再删），成功的不返回
      const failed = await window.modvault.trashPaths(targets.map((a) => a.folder))
      const failedSet = new Set(failed)
      const removed = targets.filter((a) => !failedSet.has(a.folder))

      // 2026-10 装机缺陷修复：删除失败曾**完全静默**（主进程 trashPaths 在打包态
      // 因 asar 内 spawn ENOENT 把每个路径都报成 failed，渲染层看到 removed 为空
      // 就直接 return，资产原地不动且毫无提示）。现在失败必须给用户反馈。
      if (removed.length === 0) {
        set({
          notice: `删除失败：${targets.length} 个资产未能移入回收站（文件可能被其他程序占用），已保留在原位置`
        })
        return
      }

      await db.assets.bulkDelete(removed.map((a) => a.id))
      // 缩略图缓存同步清理（宽限期到期才删，撤销期内缩略图自然还在）
      for (const a of removed) {
        window.modvault.deleteThumb(a.id).catch(() => 0)
      }
      set((s) => {
        const removedIds = new Set(removed.map((a) => a.id))
        return withPickerClosed({
          assets: s.assets.filter((a) => !removedIds.has(a.id)),
          selectedId: s.selectedId && removedIds.has(s.selectedId) ? null : s.selectedId,
          selectedIds: s.selectedIds.filter((id) => !removedIds.has(id)),
          // 正看着的资产被删掉了 → 退回网格，否则中栏会停在「找不到该资产」的空视图
          folderViewAssetId:
            s.folderViewAssetId && removedIds.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
          // 快览浮层正显示的被删 → 关闭（与文件视图同一判据：目标不存在时浮层必然空转）
          quickLookAssetId:
            s.quickLookAssetId && removedIds.has(s.quickLookAssetId) ? null : s.quickLookAssetId,
          notice:
            failed.length > 0
              ? `已删除 ${removed.length} 个；${failed.length} 个失败（文件可能被占用），已保留`
              : s.notice
        })
      })
      return
    }

    // ── 软删：移到库内 `.trash/`（C 线主路径）──────────────────────────
    const res = await window.modvault.softDeleteAssets(
      targets.map((a) => ({ id: a.id, folder: a.folder }))
    )
    const okById = new Map(res.ok.map((o) => [o.id, o]))
    const now = Date.now()
    const updated: Asset[] = []
    for (const a of targets) {
      const ok = okById.get(a.id)
      if (!ok) continue
      updated.push({
        ...a,
        deletedAt: ok.deletedAt,
        trashRel: ok.trashRel,
        updatedAt: now
      })
    }

    if (updated.length > 0) await db.assets.bulkPut(updated)

    if (updated.length === 0) {
      // 一项都没成功：不改任何记录，明确告诉用户文件还在原地
      set({
        notice: `删除失败：${targets.length} 个资产未能移入「最近删除」（文件可能被其他程序占用），已保留在原位置`
      })
      return
    }

    set((s) => {
      const patched = new Map(updated.map((u) => [u.id, u]))
      const movedIds = new Set(updated.map((u) => u.id))
      return withPickerClosed({
        // 原地替换成带 deletedAt/trashRel 的记录：资产仍在 `assets` 里（回收站要能列出来），
        // 只是 `applyFilters(..., 'assets')` 会把它排除掉。
        assets: s.assets.map((a) => patched.get(a.id) ?? a),
        selectedId: s.selectedId && movedIds.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !movedIds.has(id)),
        folderViewAssetId:
          s.folderViewAssetId && movedIds.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
        // 快览目标被软删 → 关闭：它已不在当前视图序列里，浮层继续显示会停在
        // 「找不到该资产」的空态（与文件视图同一判据）
        quickLookAssetId:
          s.quickLookAssetId && movedIds.has(s.quickLookAssetId) ? null : s.quickLookAssetId,
        notice:
          res.failed.length > 0
            ? `已移入「最近删除」${updated.length} 项；${res.failed.length} 项失败（文件可能被占用），已保留在原位置`
            : `已移入「最近删除」（左侧栏可还原）`
      })
    })
  },

  // ── C 线：最近删除（还原 / 彻底删除 / 清空）─────────────────────

  /**
   * 还原：主进程把目录从 `.trash/` 搬回原路径，返回**最终落盘值**（重名时追加了 `-2`）。
   *
   * 顺序：先写库（清 deletedAt / trashRel + 用返回值覆盖 folder / relFolder）→ 再重扫。
   * 重扫复用既有 `rescan()`（不手写目录遍历）：它按 `folder` 合并、保留 id/tags/note，
   * 正好把"刚搬回来、缩略图状态待定"的这条记录补齐（thumbPath 由后续队列重建）。
   */
  async restoreAssets(ids) {
    const targets = get().assets.filter((a) => ids.includes(a.id) && isDeletedAsset(a) && a.trashRel)
    if (targets.length === 0) return

    const res = await window.modvault.restoreAssets(
      targets.map((a) => ({
        id: a.id,
        trashRel: a.trashRel as string,
        relFolder: a.relFolder,
        name: a.name
      }))
    )
    const okById = new Map(res.ok.map((o) => [o.id, o]))
    const now = Date.now()
    const updated: Asset[] = []
    for (const a of targets) {
      const ok = okById.get(a.id)
      if (!ok) continue
      const next: Asset = {
        ...a,
        folder: ok.folder,
        relFolder: ok.relFolder,
        updatedAt: now
      }
      // 用 delete 而不是置 undefined：Dexie v5 的 deletedAt 是索引字段，
      // 写 undefined 会让"未删除"落成索引里的一个空值（与老记录不一致）。
      delete next.deletedAt
      delete next.trashRel
      updated.push(next)
    }
    if (updated.length > 0) await db.assets.bulkPut(updated)
    const restoredIds = new Set(updated.map((u) => u.id))
    if (restoredIds.size > 0) {
      set((s) => {
        const patched = new Map(updated.map((u) => [u.id, u]))
        return { assets: s.assets.map((a) => patched.get(a.id) ?? a) }
      })
    }

    const renamed = res.ok.filter((o) => o.renamed).length
    const parts: string[] = []
    if (updated.length > 0) parts.push(`已还原 ${updated.length} 项`)
    if (renamed > 0) parts.push(`${renamed} 项因原位置重名已改名`)
    if (res.failed.length > 0) parts.push(`${res.failed.length} 项失败（${res.failed[0]?.reason ?? '未知原因'}）`)

    // 重扫：让主进程按磁盘现状重建这批记录（失败不阻断，已写库的还原结果仍然有效）
    if (updated.length > 0) {
      try {
        await get().rescan()
      } catch {
        /* 重扫失败不回滚还原：文件已经在原位置，索引字段也已更新 */
      }
    }
    if (parts.length > 0) set({ notice: parts.join(' · ') })
  },

  /**
   * 彻底删除：指定的软删项 → 系统回收站（**不可还原**，调用方必须先二次确认）。
   *
   * 失败项（`failures[].id`）保留索引，用户可重试；成功项删索引 + 删缩略图缓存。
   */
  async purgeAssets(ids) {
    const targets = get().assets.filter((a) => ids.includes(a.id) && isDeletedAsset(a) && a.trashRel)
    if (targets.length === 0) return

    const res = await window.modvault.purgeAssets(
      targets.map((a) => ({ id: a.id, trashRel: a.trashRel as string }))
    )
    const failedIds = new Set(res.failures.map((f) => f.id))
    const purged = targets.filter((a) => !failedIds.has(a.id))
    const purgedIds = purged.map((a) => a.id)

    if (purgedIds.length > 0) {
      await db.assets.bulkDelete(purgedIds)
      for (const a of purged) {
        window.modvault.deleteThumb(a.id).catch(() => 0)
      }
    }

    set((s) => {
      const gone = new Set(purgedIds)
      return withPickerClosed({
        assets: s.assets.filter((a) => !gone.has(a.id)),
        selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
        folderViewAssetId:
          s.folderViewAssetId && gone.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
        quickLookAssetId:
          s.quickLookAssetId && gone.has(s.quickLookAssetId) ? null : s.quickLookAssetId,
        notice:
          failedIds.size > 0
            ? `已彻底删除 ${purgedIds.length} 项；${failedIds.size} 项失败（文件可能被占用），可重试`
            : `已彻底删除 ${purgedIds.length} 项`
      })
    })
  },

  /** 清空回收站：全部软删项 → 系统回收站；失败项保留（可重试） */
  async emptyTrash() {
    const res = await window.modvault.emptyTrash()
    const failedIds = new Set(res.failures.map((f) => f.id))
    const victims = get().assets.filter((a) => isDeletedAsset(a) && !failedIds.has(a.id))
    const victimIds = victims.map((a) => a.id)
    if (victimIds.length > 0) {
      await db.assets.bulkDelete(victimIds)
      for (const a of victims) {
        window.modvault.deleteThumb(a.id).catch(() => 0)
      }
    }
    set((s) => {
      const gone = new Set(victimIds)
      return withPickerClosed({
        assets: s.assets.filter((a) => !gone.has(a.id)),
        selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
        notice:
          failedIds.size > 0
            ? `已清空 ${victimIds.length} 项；${failedIds.size} 项失败（文件可能被占用）`
            : `已清空回收站（${victimIds.length} 项）`
      })
    })
  },

  // ── T07 分类指派 / 遗留布局迁移 ─────────────────────────────

  /**
   * 指派分类（03 §5.1，顺序严格）：normalize → 逐个调 IPC 移动目录 →
   * RA3 缩略图重生（先生成新再删旧）→ **最后**才写 Dexie（id 不变，禁止 delete+put）。
   * 同一大类才能批量（父目录由 asset.kind 算，调用方已把守，这里按资产各自算仍然安全）。
   */
  async assignCategory(ids, category1, category2) {
    const pair = normalizeCategoryPair(category1, category2)
    const targets = get().assets.filter((a) => ids.includes(a.id))
    const updatedList: Asset[] = []
    let renamed = 0
    let failed = 0
    let skipped = 0

    for (const asset of targets) {
      // 已在目标分类的资产直接跳过：main 的 moveAssetCategory 用 readdir + uniqueName 防重名，
      // 资产自己就在目标目录里 → 会被误判为同名冲突而改成「名字-2」（no-op 变成误改名）
      const cur = categoriesOf(asset)
      if (cur.category1 === pair.category1 && cur.category2 === pair.category2) {
        skipped += 1
        continue
      }
      const res = await window.modvault
        .assignCategory({
          folder: asset.folder,
          kindFolderName: kindFolder(asset.kind),
          category1: pair.category1,
          category2: pair.category2
        })
        .catch(() => null)
      if (!res) {
        failed += 1
        continue
      }
      if (res.renamed) renamed += 1

      // RA3：目录移动 → coverAbs 变了 → salt 失效；先生成新、再通配删旧
      let thumb: { thumbPath?: string; thumbStatus: ThumbStatus } = {
        thumbPath: asset.thumbPath,
        thumbStatus: asset.thumbStatus ?? 'none'
      }
      if (asset.cover) {
        thumb = await regenThumbSweep(asset.id, assetFileAbs(res.folder, asset.cover))
      }

      updatedList.push({
        ...asset,
        name: res.name,
        folder: res.folder,
        relFolder: res.relFolder,
        category1: res.category1,
        category2: res.category2,
        // `res.name` 可能带 main 侧 `uniqueName` 追加的 `-2`（目标目录重名）→
        // 剥回基础名再算 key，否则移动一次分类就把重复关系断开了（v0.4 口径）
        dedupeKey: dedupeKeyOf(baseNameOf(res.name), asset.kind),
        thumbPath: thumb.thumbPath,
        thumbStatus: thumb.thumbStatus,
        updatedAt: Date.now()
      })
    }

    if (updatedList.length > 0) {
      await db.assets.bulkPut(updatedList)
      const byId = new Map(updatedList.map((a) => [a.id, a]))
      set((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
    }

    const summary: AssignSummary = {
      moved: updatedList.length,
      renamed,
      failed,
      skipped,
      changed: pair.changed
    }
    if (summary.moved === 0 && failed === 0) return summary
    const label = `${pair.category1} / ${pair.category2}`
    let notice = `已移动 ${summary.moved} 个资产到「${label}」`
    if (renamed > 0) notice += `（${renamed} 个因目标重名自动改名）`
    if (skipped > 0) notice += `，${skipped} 个已在该分类未动`
    if (failed > 0) notice += `，${failed} 个失败（目录不存在或路径非法）`
    // changed=false 的幂等操作不提示（06 v1.0.3 §9.2 规则 6）；changed=true（非法字符/截断被改写）才提示
    if (pair.changed) notice += '。注意：输入的分类名已被规范化（非法字符清洗或超长截断）'
    set({ notice })
    return summary
  },

  /**
   * 待确认浮层里的**定案**（T2，`docs/35 §5.1`）。语义与两段式理由见接口注释。
   *
   * ## 两段式，顺序不可调换
   *
   * ① `assignCategory` —— 唯一搬盘入口（重名 `uniqueName` / 缩略图重生 / `dedupeKey` 重算 /
   *    写库 / 内存同步全在它里面）。**不复制其中任何一段**，否则两边迟早漂移。
   * ② 拿到 `summary` 之后再决定写不写 `decidedAt` —— 这正是"失败不写"能成立的前提：
   *    若先写 `decidedAt` 再搬，搬失败就永久钉死（`reviewReasonOf` 与 `isZhimoVerifyCandidate`
   *    都会按它跳过，用户再也看不到这条）。
   *
   * ## 哪些算"定案"
   *
   * - `moved > 0` → 搬成功了，用户的选择已落到磁盘；
   * - `moved === 0 && failed === 0` → **skipped**（资产本来就在这个分类）。这**也是定案**：
   *   用户点了「用站方的」而 S2 恰好等于当前分类，他表达的是"就该是这样"。
   *   不写的话这条会永远卡在队列里，每轮都弹回给他（"队列纹丝不动"）。
   * - `failed > 0` → **不写**（理由见上）。
   *
   * ## `reason` 必须**删掉**而不是置 undefined
   *
   * `reviewReasonOf` 判的是 `=== 'conflict'`，置 `undefined` 在本仓能工作；但 `ClassifyReview`
   * 会进 Dexie / 进日志 JSON —— `{ reason: undefined }` 序列化后不但语义含混，还会让
   * "字段存在与否"这类判据（比如 `'reason' in review`）得出反直觉的答案。用解构**真删**。
   *
   * `sources` **保留**：用户之后可能想看"当初为什么存疑"（`s2` / `s3` 是站方当时说的话，
   * 重抓会变，所以它是唯一留痕）。
   */
  async decideReview(id, category1, category2) {
    // ① 唯一搬盘入口。注意它内部会对"已在目标分类"判 skipped 并**不写库**，
    //    所以下面那一步不能依赖"assignCategory 已经把新记录写进去了"。
    const summary = await get().assignCategory([id], category1, category2)

    // ② 失败一律不写 `decidedAt`（移动失败还标记已定案 = 这条永远停在队列且不再重试）
    if (summary.failed > 0) return summary

    // ③ 写库前**重查当下记录**：`assignCategory` 期间这条可能已被 rescan 换掉 / 被删除，
    //    用旧快照会把它写回去（与 `runZhimoCategoryReclass` 的写回同一纪律）。
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return summary

    const now = Date.now()
    const old: ClassifyReview = asset.classifyReview ?? {}
    // 显式解构删 `reason`（不是置 undefined，理由见函数头）
    const { reason: _droppedReason, ...rest } = old
    const review: ClassifyReview = { ...rest, confidence: 'high', decidedAt: now }

    const updated: Asset = { ...asset, classifyReview: review, updatedAt: now }
    await db.assets.put(updated)
    set((s) => ({ assets: s.assets.map((a) => (a.id === id ? updated : a)) }))
    return summary
  },

  /**
   * 拖拽归类（反馈 6d / docs/15 §6d）——「松手即归类 → 5 秒撤销」，复用删除那套撤销条。
   *
   * 顺序（不可调换）：
   * ① 用 `normalizeCategoryPair` 得到与 `assignCategory` **完全相同**的目标分类对；
   * ② 先判定哪些资产真的会移动（已在目标分类的不进撤销快照，否则撤销会白搬一次）；
   * ③ 全部已在目标分类 → 直接返回（**不发 IPC、不弹撤销条**，口径如此）；
   * ④ `assignCategory` 真实移动目录 + 缩略图重生 + 写库；
   * ⑤ 只有真的移动成功（`moved > 0`）才登记撤销条。
   */
  async assignCategoryWithUndo(ids, category1, category2) {
    const pair = normalizeCategoryPair(category1, category2)
    const targets = get().assets.filter((a) => ids.includes(a.id))
    const noop: AssignSummary = {
      moved: 0,
      renamed: 0,
      failed: 0,
      skipped: targets.length,
      changed: pair.changed
    }
    if (targets.length === 0) return noop

    const willMove = targets.filter((a) => {
      const cur = categoriesOf(a)
      return !(cur.category1 === pair.category1 && cur.category2 === pair.category2)
    })
    // 全部已在目标分类：不发请求、不弹撤销条（QA 口径）
    if (willMove.length === 0) return noop

    // 归类前快照（只登记会移动的资产）
    const records = buildAssignUndo(
      targets,
      willMove.map((a) => a.id)
    )
    // 传完整 ids：assignCategory 自己会跳过「已在目标分类」的，并在 notice 里报出个数
    const summary = await get().assignCategory(ids, pair.category1, pair.category2)

    // 全失败 / 没有真实移动 → 不弹撤销条（失败原因已由 assignCategory 的 notice 说明）
    if (summary.moved === 0) return summary

    set({
      pendingAssign: {
        records,
        category1: pair.category1,
        category2: pair.category2,
        label: categoryPairLabel(pair.category1, pair.category2),
        startedAt: Date.now(),
        graceMs: ASSIGN_GRACE_MS,
        moved: summary.moved
      }
    })
    return summary
  },

  /**
   * 撤销归类：按**原分类对**分组（一次 `assignCategory` 只能接受一个分类对），
   * 逐个反向搬回。撤销也是一次真实磁盘移动：
   * - 目标重名 → main 的 `uniqueName` 追加 -2/-3（绝不覆盖，沿用既有实现）；
   * - 资产在宽限期内被删除 / 重扫丢弃 → `assignCategory` 按 id 找不到即忽略（跳过）；
   * - 任何失败都必须给提示（不能静默，否则用户以为已经搬回去了）。
   */
  async undoAssign() {
    const pending = get().pendingAssign
    if (!pending) return
    // 先清状态：倒计时到期与点击「撤销」并发时只执行一次
    set({ pendingAssign: null })

    const groups = groupAssignUndo(pending.records)
    let moved = 0
    let failed = 0
    try {
      for (const g of groups) {
        const s = await get().assignCategory(g.ids, g.category1, g.category2)
        moved += s.moved
        failed += s.failed
      }
    } catch (err) {
      set({
        notice: `撤销归类失败：${err instanceof Error ? err.message : String(err)}`
      })
      return
    }

    if (failed > 0) {
      set({
        notice:
          moved > 0
            ? `撤销归类：${moved} 个已搬回原分类，${failed} 个失败（目录可能被占用）`
            : `撤销归类失败：${failed} 个资产未能搬回原分类（目录可能被占用）`
      })
      return
    }
    set({ notice: moved > 0 ? `已撤销归类：${moved} 个资产已搬回原分类` : '已撤销归类' })
  },

  /**
   * 撤销条到期（5 秒）：归类的撤销只是「再搬一次」，到期无需任何落盘动作。
   *
   * `startedAt` 用于**防止旧倒计时误清新一批**：拖拽归类可以连续发生，
   * 上一批的 interval 在切换瞬间若刚好归零，会调用本方法；带上时间戳比对后，
   * 只有「同一批」才允许清状态（不传 = 无条件清，测试与手动调用用）。
   */
  commitAssign: (startedAt) => {
    const current = get().pendingAssign
    if (!current) return
    if (startedAt !== undefined && current.startedAt !== startedAt) return
    set({ pendingAssign: null })
  },

  /**
   * 遗留布局迁移（设置页手动触发 / 启动自动触发共用）。
   * main 侧 plan + apply；T08 起 `ok` 回传**最终落盘值**的 LayoutMove
   * （目标重名被追加序号后 `to`/`relFolder` 与计划值不同），索引直接按它写回，
   * 不再需要等下轮 rescan 自愈。
   */
  async migrateLegacyLayout() {
    const { assets, settings } = get()
    if (!settings) return { moved: 0, failed: 0 }
    const moves = planLegacyMoves(assets, settings.libraryDir)
    if (moves.length === 0) return { moved: 0, failed: 0 }

    const result = await window.modvault.migrateLayout(assets).catch(() => null)
    if (!result) return { moved: 0, failed: moves.length }

    const now = Date.now()
    const updatedList: Asset[] = []
    for (const done of result.ok) {
      const asset = assets.find((a) => a.id === done.id)
      if (!asset) continue
      updatedList.push({
        ...asset,
        // `done.to` / `done.relFolder` 是 main 回传的**最终落盘值**（重名追加序号后 ≠ 计划值）
        folder: done.to,
        relFolder: done.relFolder,
        category1: UNCLASSIFIED,
        category2: UNCLASSIFIED,
        updatedAt: now
      })
    }

    if (updatedList.length > 0) {
      await db.assets.bulkPut(updatedList)
      const byId = new Map(updatedList.map((a) => [a.id, a]))
      set((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
    }

    // 迁移移动了目录 → coverAbs 变 → salt 失效：缩略图全部需要重生（有封面的才要）
    for (const a of updatedList) {
      if (!a.cover) continue
      void regenThumbSweep(a.id, assetFileAbs(a.folder, a.cover))
        .then((thumb) => {
          const current = get().assets.find((x) => x.id === a.id)
          if (!current) return
          commitAsset(set, { ...current, thumbPath: thumb.thumbPath, thumbStatus: thumb.thumbStatus })
        })
        .catch(() => undefined)
    }

    const failedCount = result.failed.length
    set({
      legacyLayoutCount: 0,
      notice:
        failedCount > 0
          ? `迁移完成：成功 ${updatedList.length} 个，失败 ${failedCount} 个（详见日志）`
          : `迁移完成：${updatedList.length} 个资产已搬入新版目录结构`
    })
    return { moved: updatedList.length, failed: failedCount }
  },

  async detectMaterialMerge() {
    const info = await window.modvault.detectMaterialMerge().catch(() => null)
    if (!info) return
    set({
      materialMergeCount: info.needMerge ? info.count : 0,
      materialMergeSources: info.sources
    })
  },

  /**
   * 材质大类合并：`贴图/` + `材质预设/` → `材质/`（docs/14 §2.3）。
   *
   * 顺序**不可调换**：
   * ① main 逐资产搬盘（重名 `-2`、先写 manifest 再动盘）→ 回传最终落盘值；
   * ② 写 DB 快照（`backups`）→ **单个事务**逐条 `put` 局部字段；
   * ③ 缩略图重生（先生成新、再通配删旧）；
   * ④ notice；
   * ⑤ 最后才 `maybeAutoMigrate()`（先合并、后布局迁移）。
   *
   * 四条禁令：`Asset.id` 永不变；**禁止 delete+put**（丢 tags/note/styles/renderParams）；
   * 禁止依赖 rescan 自愈路径（合并键是 folder，会删旧建新）；不升 Dexie 版本。
   */
  async mergeMaterial(opts) {
    if (get().materialMergeBusy) return { ...EMPTY_MERGE_SUMMARY, needsManual: false }

    const { assets } = get()
    set({ materialMergeBusy: true })
    try {
      const result = await window.modvault.mergeMaterial({
        force: opts?.force === true,
        // 全量资产引用：main 按 folder 匹配 → 把 assetId / 旧 relFolder 写进 manifest（回滚凭据）
        assets: assets.map((a) => ({ id: a.id, folder: a.folder, relFolder: a.relFolder }))
      })

      const summary: MergeMaterialSummary = {
        moved: result.moved,
        renamed: result.renamed,
        failed: result.failures.length,
        skipped: result.skipped,
        needsManual: result.needsManual,
        count: result.count
      }

      // 超阈值：磁盘零改动，只把数字挂到 state 供设置页消费
      if (result.needsManual) {
        set({
          materialMergeCount: result.count,
          notice: `检测到 ${result.count} 个资产的旧大类目录待合并，请在「设置 → 库 → 材质大类合并」中手动合并`
        })
        return summary
      }

      // ── ② 只按成功的 move 改 DB（失败项留在源目录，下次启动重试） ──
      const moveByAsset = new Map<string, (typeof result.moves)[number]>()
      for (const m of result.moves) {
        if (m.assetId) moveByAsset.set(m.assetId, m)
      }
      const now = Date.now()
      const updated: Asset[] = []
      for (const a of assets) {
        const m = moveByAsset.get(a.id)
        if (!m) continue
        // 重名时资产名变了（末段），dedupeKey 必须同步重算，否则去重键与实际名字漂移
        const derivedName = m.relFolderTo.split('/').filter((s) => s.length > 0).pop() ?? a.name
        const newName = m.renamed ? derivedName : a.name
        updated.push({
          ...a,
          folder: m.to,
          relFolder: m.relFolderTo,
          name: newName,
          // 重名改名是 main 的 uniqueName 追加的 `-2` → 用基础名算 key（见 v0.4 口径）
          dedupeKey: m.renamed ? dedupeKeyOf(baseNameOf(newName), a.kind) : a.dedupeKey,
          updatedAt: now
        })
      }

      if (updated.length > 0) {
        // 迁移前快照（与 manifest 的 assetId/prevRelFolder 互为双保险）
        const affectedIds = new Set(updated.map((u) => u.id))
        const snapshot = assets.filter((a) => affectedIds.has(a.id))
        await db.backups.put({
          id: `material-merge-${now}`,
          at: now,
          json: JSON.stringify(snapshot)
        })

        // 单事务批量 put：主键不变 = 原地覆盖，tags/note/styles/renderParams/thumbPath 全保留
        await db.transaction('rw', db.assets, async () => {
          for (const u of updated) await db.assets.put(u)
        })
        const byId = new Map(updated.map((u) => [u.id, u]))
        set((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
      }

      // ── ③ 缩略图重生（folder 变 → coverAbs 变 → salt 变；先生成新再删旧） ──
      for (const a of updated) {
        if (!a.cover) continue
        void regenThumbSweep(a.id, assetFileAbs(a.folder, a.cover))
          .then((thumb) => {
            const current = get().assets.find((x) => x.id === a.id)
            if (!current) return
            commitAsset(set, {
              ...current,
              thumbPath: thumb.thumbPath,
              thumbStatus: thumb.thumbStatus
            })
          })
          .catch(() => undefined)
      }

      // ── ④ notice + 计数归零 ──
      if (result.moved > 0 || result.failures.length > 0) {
        let notice = `材质大类合并完成：成功 ${result.moved} 个`
        if (result.renamed > 0) notice += `，${result.renamed} 个因重名自动加序号`
        if (result.failures.length > 0) notice += `，${result.failures.length} 个失败（下次启动会重试）`
        set({ materialMergeCount: 0, notice })
      } else {
        set({ materialMergeCount: 0 })
      }

      // ── ⑤ 顺序固定：先合并、后布局迁移（已合并的 4 段资产会被它自动 skip） ──
      await maybeAutoMigrate()

      return summary
    } catch (err) {
      // 磁盘可能已变、DB 没变 → 明确告诉用户不要重扫（下次启动会重试/可回滚）
      set({ notice: `材质大类合并失败：${err instanceof Error ? err.message : String(err)}` })
      return EMPTY_MERGE_SUMMARY
    } finally {
      set({ materialMergeBusy: false })
    }
  },

  openFolderView(id) {
    // 只有索引里真实存在的资产才允许进入（双击可能命中刚被 rescan 丢弃的陈旧 DOM 节点）
    if (!get().assets.some((a) => a.id === id)) return
    set({ folderViewAssetId: id })
  },
  closeFolderView: () => set({ folderViewAssetId: null }),

  openHdrPreview(id) {
    // 只对 HDRI 资产生效：三个入口都可能拿到陈旧 / 错误 id，弹一个必然
    // "预览打不开"的窗比什么都不发生更糟。
    const asset = get().assets.find((a) => a.id === id)
    if (!asset || asset.kind !== 'hdri') return
    set({ hdrPreviewAssetId: id })
  },
  closeHdrPreview: () => set({ hdrPreviewAssetId: null }),

  openQuickLook(id) {
    // 只对索引里真实存在的资产生效：空格可能命中刚被 rescan 丢弃的陈旧 DOM 节点
    // （与 openHdrPreview / openFolderView 同一守卫），不在索引里就静默忽略。
    if (!get().assets.some((a) => a.id === id)) return
    set({ quickLookAssetId: id })
  },
  // 关闭只撤浮层，**不动选中**（用户口径：退回网格时选中态要留着，第二次 Esc 才清）
  closeQuickLook: () => set({ quickLookAssetId: null }),

  // ── P2 未分类整理流水线 ─────────────────────────────────────

  /**
   * 打开整理浮层（两种模式共用，见 `TriageMode`）。
   *
   * 待办集口径与 `useTriageQueue()` / `useReviewQueue()` **完全一致**：全库（只滤软删）
   * + 当前排序 + 该模式的判据 —— 三处共用 `triageQueueOf`，不会各写一遍。
   * 不套 `filters` 的理由见 `useTriageQueue` 的注释（全库口径才能和侧栏数字对上）。
   *
   * 两个**不做**的动作，理由写在下面：
   * - **不改 `libraryView`**：用户可能正停在「最近删除」里点侧栏的整理按钮
   *   （那个视图里侧栏分类树仍在）。待办集本身是全库的，与视图无关；切视图会顺手关掉
   *   `quickLookAssetId` / `folderViewAssetId` / 清选中，用户还没开始就被清了状态。
   * - **不改筛选**：待办集不套 filters，所以改了也没意义；而且会打乱用户正在看的视图。
   *
   * ## 空队列时**绝不退化成另一个模式**（本卡的核心约束）
   *
   * `openReview()` 在没有 conflict 但有一堆未分类时，必须"不开浮层 + 给待确认的 notice"，
   * **不能**顺手把用户丢进未分类队列：用户点的是"处理存疑"，进去看到的却是一批从没分过
   * 类的资产，会以为"存疑"这个词指的是没分类。同理 `openTriage()` 也不会在做完未分类后
   * 把用户带进 conflict 队列。
   *
   * @param mode `unclassified`（默认，P2 既有行为，逐字不变）/ `conflict`（待确认队列）
   * @returns 是否真的打开了
   */
  openTriage(mode = 'unclassified') {
    const st = get()
    // 当前模式（未开启 → null）。`triageMode` 为 null 而 `triageActive` 为 true 是**不该
    // 出现**的组合（唯一写入口 `withTriageMode` 不可能产生它），只有测试里手工 `setState`
    // 才造得出来。这里按 `unclassified` 兜底 —— 那是 P2 的唯一模式，也就是"老状态"。
    const current: TriageMode | null = st.triageActive ? (st.triageMode ?? 'unclassified') : null
    // 已开着**同一个模式**就别重开会话：会把跳过集清空、游标重置，用户会莫名其妙
    // 回到第一张。这是 P2 的既有行为，一个字节不改。
    if (current === mode) return true
    const queue = triageQueueOf(st.assets, st.filters.sort, mode)
    if (queue.length === 0) {
      // 需求：「进入时若待办集为空，不要开浮层，直接给一条 notice」。
      // 已经开着另一个模式时**不动那个浮层**（用户正在里面干活，不能因为点了另一个
      // 入口就被踢出来），只给一句"这边现在是空的"。
      set({ notice: TRIAGE_EMPTY_NOTICE[mode] })
      return false
    }
    // 进入时把焦点落到待办集第一张：关闭后选中态要落回"最后整理的那张"（需求 7），
    // 而最后整理的那张是从这一张开始走的 —— 先把起点选上，即使中途一张都没归类就退出，
    // 选中态也是用户刚看到的那张（与 Quick Look 的"关浮层不清选中"同精神）。
    //
    // 从另一个模式切过来时走的也是这条路：`triageMode` 一换，两个 hook 的队列就换了，
    // 浮层的 `reconcileTriage` 会把游标稳到新队列的第一张 —— 不需要先关再开
    // （那会闪一次，还会多发一条收尾提示）。
    set({
      ...withTriageMode(mode),
      selectedId: queue[0].id,
      selectedIds: [queue[0].id]
    })
    return true
  },

  /** 打开待确认队列（docs/35 §4.3 三个入口共用）。空队列时**不**退化成未分类模式。 */
  openReview: () => get().openTriage('conflict'),

  /**
   * 关闭整理浮层。**不动选中**（保留"最后整理的那张"，与 `closeQuickLook` 同口径）。
   *
   * 收尾提示由浮层自己发（它才知道本次会话结束后的真实剩余数），这里只撤标志。
   */
  closeTriage: () => set(withTriageMode(null)),

  openCategoryPicker(ids) {
    if (ids.length === 0) return
    set({ categoryPickerIds: ids })
  },
  closeCategoryPicker: () => set({ categoryPickerIds: null }),

  openRenameDialog: (ids) => {
    // `dedupeIds` 已在选择逻辑里用同一份实现：空数组 / 全空串 → 不弹空窗
    const unique = dedupeIds(Array.isArray(ids) ? ids : [])
    if (unique.length === 0) return
    set({ renameIds: unique })
  },

  closeRenameDialog: () => set({ renameIds: null }),

  /**
   * 批量改名（唯一写入口）。
   *
   * 为什么**不换 id**：`Asset.id` 是导入时生成的 UUID，项目的不变量是"永不因改名 /
   * 改库目录 / 改大类而变"（Dexie v2 迁移专门把旧库的 `id = relFolder` 换成了 UUID）。
   * 换 id 会让 aliasOverride / settings.aliases 的 `scope='asset'` 记录、材质球图
   * (`<id>-<hash>`) 与所有按 id 持有的 UI 状态同时失效，收益为零、风险极大。
   * 所以这里与 `assignCategory` / `mergeMaterial` 完全同构：**主键不变 → put 即覆盖**。
   */
  async applyRenames(rows) {
    const list = Array.isArray(rows) ? rows : []
    const byId = new Map(get().assets.map((a) => [a.id, a]))
    const plan: Array<{ id: string; folder: string; to: string }> = []
    const planned = new Set<string>()
    let skipped = 0

    for (const row of list) {
      const asset = byId.get(String(row?.id ?? ''))
      const to = String(row?.to ?? '').trim()
      // 找不到记录 / 同一资产重复 / 名字没变 → 跳过（不算失败，也不发 IPC）
      if (!asset || planned.has(asset.id) || !to || to === asset.name) {
        skipped += 1
        continue
      }
      planned.add(asset.id)
      plan.push({ id: asset.id, folder: asset.folder, to })
    }

    if (plan.length === 0) {
      if (skipped > 0) set({ notice: '重命名：没有需要改名的资产' })
      return { renamed: 0, failed: 0, skipped, rolledBack: false }
    }

    const res = await window.modvault.renameFolders(plan).catch(() => null)
    if (!res) {
      set({ notice: `重命名失败：主进程无响应（${plan.length} 个资产均未改动）` })
      return { renamed: 0, failed: plan.length, skipped, rolledBack: false }
    }

    const now = Date.now()
    const updated: Asset[] = []
    for (const ok of res.renamed) {
      const asset = byId.get(ok.id)
      if (!asset) continue

      // `relFolder` 只换**末段**（与单条 renameAsset 同一规则）：分类层级由磁盘目录决定，
      // 本功能不移动资产，所以父链一个字都不能动。
      const segs = String(asset.relFolder ?? '')
        .split('/')
        .filter((s) => s.length > 0)
      const relFolder = segs.length > 0 ? [...segs.slice(0, -1), ok.name].join('/') : ok.name

      // 缩略图缓存名是 `<id>-<封面绝对路径哈希>.<ext>`：目录改名 → salt 变 → 旧缓存失效。
      // 与 assignCategory 用同一套「先生成新、再通配删旧」（regenThumbSweep）。
      // ⚠️ 材质球图（`<id>-<槽位hash>.png`）与目录名无关，**跳过**，否则会把球图
      //    覆盖成封面缩略图（用户拍板过"材质卡片走球图"）。
      // 生成失败 → `thumbStatus='none'`（宁可重生成也绝不指向不存在的文件）。
      let thumb: { thumbPath?: string; thumbStatus: ThumbStatus } = {
        thumbPath: asset.thumbPath,
        thumbStatus: asset.thumbStatus ?? 'none'
      }
      if (asset.cover && !ballThumbIsFresh(asset)) {
        thumb = await regenThumbSweep(asset.id, assetFileAbs(ok.folder, asset.cover))
      }

      updated.push({
        ...asset,
        name: ok.name,
        folder: ok.folder,
        relFolder,
        // 与 rescan 口径一致：先剥自动序号再算 key（模板可能产出「椅子-2」这种字面名）
        dedupeKey: dedupeKeyOf(baseNameOf(ok.name), asset.kind),
        thumbPath: thumb.thumbPath,
        thumbStatus: thumb.thumbStatus,
        updatedAt: now
      })
    }

    const failed = res.failed.length
    const firstReason = res.failed[0]?.reason

    if (updated.length > 0) {
      try {
        // 主键不变 = 原地覆盖：tags / note / styles / renderParams / favorite 全部保留
        await db.assets.bulkPut(updated)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        set({
          notice: `磁盘已改名，但索引写入失败（${reason}）。请到「设置 → 导入 → 重新扫描」对齐索引。`
        })
        return { renamed: updated.length, failed, skipped, rolledBack: res.rolledBack }
      }
      const patched = new Map(updated.map((a) => [a.id, a]))
      set((s) => ({ assets: s.assets.map((a) => patched.get(a.id) ?? a) }))
    }

    let notice = `重命名 ${updated.length} 条，失败 ${failed} 条`
    if (skipped > 0) notice += `，跳过 ${skipped} 条（名称未变）`
    if (res.rolledBack) notice += '。磁盘已回滚，所有文件保持原名'
    else if (updated.length === 0 && firstReason) notice += `：${firstReason}`
    set({ notice })

    return { renamed: updated.length, failed, skipped, rolledBack: res.rolledBack, reason: firstReason }
  },

  setNotice: (n) => set({ notice: n }),

  async renameAsset(id, newName) {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return
    const newFolder = await window.modvault.renameAsset(asset.folder, newName)
    // P0-7 / D1：`id` 是 UUID 且**永不变更**；**禁止** delete+put（会丢 tags/note）——
    // 主键不变时 Dexie put 就是原地覆盖，tags/note/source/thumbPath 全部原样保留。
    // relFolder 只替换**末段**（资产名），分类层级原样保留（T08/DEF-02 附带修复）：
    // 旧实现 `\`${kindFolder(asset.kind)}/${newName}\`` 会把 4 段资产的 relFolder 退化成 2 段，
    // 导致改名后封面 vault://asset/<relFolder>/... 404、侧栏分类计数错位。
    // 2 段遗留布局同样被此规则正确处理（首段大类不动，末段换新名）。
    const relSegs = asset.relFolder.split('/')
    relSegs[relSegs.length - 1] = newName
    const relFolder = relSegs.join('/')
    const updated: Asset = {
      ...asset,
      name: newName,
      folder: newFolder,
      relFolder,
      // 用户**显式**改名：名字就是新身份，直接按原文算 key（不剥 `-n`，
      // 用户可能真的把它叫「沙发-2」）；自动序号场景见上方 assignCategory / mergeMaterial
      dedupeKey: dedupeKeyOf(newName, asset.kind),
      updatedAt: Date.now()
    }
    commitAsset(set, updated)
  },

  async rescan(opts) {
    const force = opts?.force === true
    const localAssets = get().assets
    const { assets: scanned, ignored } = await window.modvault.rescan()

    // ── 安全守卫 ①：扫描结果为空但索引里有资产 → 一律中止 ──────────────
    // 典型事故：切库时选错目录（空目录 / 盘符根）→ 主进程返回 [] → 旧实现把索引全删。
    // 中止路径**不碰 db.assets、不 pruneThumbs、不入缩略图队列**（三者都会造成不可逆副作用）。
    if (!force && scanned.length === 0 && localAssets.length > 0) {
      set({
        notice: `重扫已中止：扫描结果为空，但索引里有 ${localAssets.length} 个资产——库目录可能选错了，索引未改动。若确认要清空索引，请到「设置 → 导入 → 强制重扫」。`
      })
      return { aborted: 'empty-scan', scanned: 0, removed: 0 } satisfies RescanOutcome
    }

    // rescan 主进程侧生成**新 UUID**，所以合并键必须用 `folder`（绝对路径），
    // 不能用 id —— 否则每次 rescan 都全量重建、tags/note 全丢（P0-17 / R9）。
    //
    // ── T-PRUNE ③：软删记录**不进 Map**（0.7.6「每次刷新 +1 条」的根因）──────
    //
    // 旧实现：先无条件 `new Map(localAssets.map(a => [a.folder, a]))`，再
    // `for (const a of trashedRecords) localByFolder.delete(a.folder)`。
    // 问题：软删记录的 `folder` 字段**不变**（目录搬进了 `<库根>/.trash/`，索引里
    // 保留的还是原路径），所以它和"同位置的活记录"必然撞同一个 key —— 那一行
    // `delete(a.folder)` 会把**活记录**的键一起删掉。本次 rescan 于是认不出它 →
    // 主进程给一个新 UUID → 每条记录每次刷新 +1（真机 13→15，DB 174→177）。
    //
    // 现在反过来：软删记录从头到尾**不参与建 Map**，也就不需要（更不能）按 folder 删键。
    // `trashedRecords` 仍然在合并完 `merged.push(...)` 原样放回索引。
    const trashedRecords = localAssets.filter((a) => isDeletedAsset(a))
    const liveLocal = localAssets.filter((a) => !isDeletedAsset(a))
    // 补充（C 线「最近删除」的原始理由，仍然成立）：main 的 rescan **明确跳过 `.trash`**
    // （isLibraryTrashName），软删资产的目录永远不会出现在 `scanned` 里。若把它们按普通
    // 记录走，任何一次重扫都会判成"磁盘已删除"→ 写备份 + 清出索引 → 回收站凭空消失、
    // 用户再也还原不了。所以它们既不进 Map、也不参与 gone 判定，合并完原样放回 `merged`。

    // ── 同 folder 的多条**活**记录：显式取舍，绝不悬空 ─────────────────
    //
    // 理论上 init 的 `cleanupDuplicateRecords` 已经把存量收干净，但 rescan 期间
    // 并发导入 / 上一版遗留仍可能造出新的冲突。这里复用**同一套**优先级结论
    // （`planDuplicateCleanup`：有缩略图 > 用户字段多 > updatedAt > id 字典序），
    // 并把被丢弃的记录放进 `dupDropIds` → 与 gone 记录一起**先备份再删**。
    // 不做 `Map` 的静默覆盖：那正是 0.7.6 让 12 份副本悬空（不在 merged、不在
    // goneIds、永不被更新也不被删除）的机制。
    //
    // 只删索引行；磁盘上同 folder 只有一个目录，不需要（也不能）动。
    const dupPlan = planDuplicateCleanup(liveLocal)
    const dupDropIds: string[] = []
    const dupDropRecords: Asset[] = []
    const dupDropSet = new Set<string>()
    const dupMergedById = new Map<string, Asset>()
    const liveById = new Map(liveLocal.map((a) => [a.id, a]))
    for (const group of dupPlan) {
      // 幸存者带上"只补空"的合并结果（别条的用户字段不能随记录一起消失）
      dupMergedById.set(group.keepId, group.merged)
      for (const id of group.dropIds) {
        dupDropSet.add(id)
        dupDropIds.push(id)
        const rec = liveById.get(id)
        if (rec) dupDropRecords.push(rec)
      }
    }
    const liveCollapsed = liveLocal
      .filter((a) => !dupDropSet.has(a.id))
      .map((a) => dupMergedById.get(a.id) ?? a)
    if (dupDropIds.length > 0) {
      console.info(
        `[recordHygiene] rescan 期间发现 ${dupPlan.length} 组同 folder 重复记录，合并 ${dupDropIds.length} 条`
      )
    }

    const localByFolder = new Map(liveCollapsed.map((a) => [a.folder, a]))

    const merged: Asset[] = []
    /** 即将被合并结果覆盖的**本地原记录**（新记录不算）→ 改库前落一份快照 */
    const overwrittenRecords: Asset[] = []
    const goneIds: string[] = []
    for (const s of scanned) {
      const local = localByFolder.get(s.folder)
      if (local) {
        localByFolder.delete(s.folder)
        // 改库前快照的收集点：这条记录**即将被合并结果覆盖**，先留一份原样副本
        overwrittenRecords.push(local)
        // ── 合并方向：**以 local 为底，只覆盖磁盘权威字段** ──────────────
        //
        // 反向（`{...s, 挑几个本地字段补}`）是一个真实的丢数据事故：`rescan.ts`
        // 产出的 `s` 里用户字段全是占位默认值（favorite:false / rating:0 /
        // colorTag:null / styles:[] / tags:[] / note:'' / source:''），而且
        // **完全没有** `renderParams` / `renderShape`。于是每次「重新扫描库」
        // 都把用户调好的材质球参数、收藏、评分、色标、风格整片打回默认
        // （2026-10 真机取证：一次 rescan 覆盖 143 条中的 127 条）。
        //
        // 白名单式"再补几个字段"治不了根 —— 新字段一加就又漏一次。所以这里翻过来：
        // 任何在 `Asset` 上新增的字段默认**天然保留本地值**，只有下面显式列出的
        // 磁盘权威字段才被 `s` 覆盖。`tests/rescanMergePreserve.test.ts` 逐键枚举
        // `Asset` 的每个字段并要求归入「磁盘权威 / 本地保留」之一，加字段忘了归类就红。

        // 手动封面 / 知末封面都是"用户显式指定或抓来的"，rescan 不得覆盖
        //（仅当文件仍在 index 的文件清单里时保留；文件被删了就如实回落到扫描值）。
        // ⚠️ 漏掉 'zhimo' 会让抓到的封面在下次「重新扫描库」时被 SKP 内嵌灰图打回
        //    —— 这是本项目最容易漏的一处（docs/24 §4.9）。
        const keepStickyCover =
          (local.coverSource === 'manual' || local.coverSource === 'zhimo') &&
          !!local.cover &&
          s.files.some((f) => f.rel === local.cover)

        // 缩略图：本地已生成就**原样保留**。
        //
        // 旧实现额外要求 `local.cover === s.cover`，封面一被重扫改动就整片清空
        // `thumbPath` 并写 `thumbStatus: 'none'`（真机上 37 条的图文件明明还在盘上，
        // 索引里却被抹成 null）。封面真的变了的情况交给 `regenThumbSweep()` /
        // 惰性升级机制（`708caf3`）处理 —— 那里会按新的 cover salt 重算并覆盖。
        const keepThumb = local.thumbStatus === 'ready' && !!local.thumbPath

        merged.push({
          ...local,
          // ── 磁盘权威（重扫真正该更新的字段） ────────────────────────
          kind: s.kind,
          name: s.name,
          folder: s.folder,
          relFolder: s.relFolder,
          files: s.files,
          size: s.size,
          suVersion: s.suVersion,
          suMajor: s.suMajor,
          // 分类以磁盘目录名为准（rescan 的权威语义），本地记录不覆盖
          category1: s.category1,
          category2: s.category2,
          dedupeKey: s.dedupeKey,
          // 材质包元数据只在扫描**真有值**时覆盖（json 读失败 / 被删 → 保留已知值）
          materialMeta: s.materialMeta ?? local.materialMeta,
          // ── 条件覆盖：默认取磁盘值，本地在明确条件下优先 ─────────────
          cover: keepStickyCover ? local.cover : s.cover,
          coverSource: keepStickyCover ? local.coverSource : s.coverSource,
          thumbPath: keepThumb ? local.thumbPath : s.thumbPath,
          thumbStatus: keepThumb ? 'ready' : s.thumbStatus,
          // 知末 ID（0.6.3）：本地记录已有值就**原样保留** —— 导入时从压缩包名解析出的 ID
          // 是磁盘上再也找不回来的信息（包已处置）；只有本地为空时才用磁盘扫描值兜底。
          zhimoId: local.zhimoId || s.zhimoId,
          // ── 本地保留（显式写出，表达"这里刻意不取磁盘值"） ───────────
          // 重扫不是用户编辑：`updatedAt` 必须留着，否则「最近修改」排序被整库顶到当下。
          updatedAt: local.updatedAt,
          importedAt: local.importedAt
          // 其余（id / source / tags / note / favorite / rating / colorTag /
          // styles / renderParams / renderShape / mojibake / deletedAt / trashRel /
          // aliasOverride）由 `...local` 原样带过来。
        })
      } else {
        merged.push(s)
      }
    }
    const goneRecords: Asset[] = []
    for (const left of localByFolder.values()) {
      goneIds.push(left.id)
      goneRecords.push(left)
    }
    // 软删记录原样放回（磁盘上在 `.trash/` 里，索引里也必须还在）
    merged.push(...trashedRecords)

    // ── 安全守卫 ②：一次要删掉超过一半（且数量显著）→ 中止 ────────────
    // 覆盖"切到一个只有几个文件的新目录"：scanned 不为 0，但大部分旧记录要被删。
    // 阈值取 gone > 10 是为了不干扰小库的正常删除（如 2 个里删 1 个）。
    //
    // ⚠️ 分子分母都**不含** `dupDropIds`：那是"索引内部去重"（数据全部来自索引本身、
    // 已落 `rescan-*` 备份、可还原），不是"磁盘说这些资产没了"。若把它算进来，
    // 一个只由重复记录构成的库（真机：33 个文件夹 / 69 条记录）在清理前永远过不了
    // 这个阈值 → 永远无法自愈。真正危险的是 `goneIds`（磁盘侧消失），守卫只盯它。
    if (!force && goneIds.length > 10 && goneIds.length / localAssets.length > 0.5) {
      set({
        notice: `重扫已中止：本次扫描将删除 ${goneIds.length}/${localAssets.length} 个资产（超过一半），索引未改动。请确认库目录是否正确；若确认要清空，请到「设置 → 导入 → 强制重扫」。`
      })
      return { aborted: 'mass-delete', scanned: scanned.length, removed: 0 } satisfies RescanOutcome
    }

    // ── 安全网 ③：真删之前先把**完整记录**写进 backups（tags/note/styles 只在这里有副本） ──
    // 两类删除共用一次备份（同构、同保留期）：
    // - `goneRecords`：磁盘上已经不存在的（原语义）；
    // - `dupDropRecords`：本次 rescan 因同 folder 重复被合并掉的（内容会并进幸存者，
    //   但**原样快照**才是唯一可精确回退的东西）。
    const deleteIds = [...goneIds, ...dupDropIds]
    const deleteRecords = [...goneRecords, ...dupDropRecords]
    if (deleteIds.length > 0) {
      await backupRescanDeletions(deleteRecords)
      await db.assets.bulkDelete(deleteIds)
    }
    // ── 安全网 ④：覆盖之前先把"将被改写的那批原记录"整份快照（`rescan-pre-*`） ──
    // 顺序刻意放在 `bulkPut` 之前、删除之后：删除有自己的备份（③），这里只负责
    // "仍在库里、但字段即将被重扫改写"的那些记录（本次事故的真正受害者）。
    await backupRescanPreSnapshot(overwrittenRecords).catch(() => {
      // 快照失败不该阻断重扫本身（磁盘真相仍要同步）；失败了宁可少一份凭证，
      // 也不要让用户卡在"重扫永远失败"上。
    })
    await db.assets.bulkPut(merged)
    const rescanBackupCount = (await listRescanBackups()).length
    // 文件视图看着的资产可能在重扫中消失（目录被删 / 被重建换 UUID）→ 退回网格
    const viewedId = get().folderViewAssetId
    // 快览浮层同理：重扫可能丢弃正在显示的那条记录 → 关闭浮层（与文件视图同一判据）
    const quickLookId = get().quickLookAssetId
    set(
      withPickerClosed({
        assets: merged,
        rescanBackupCount,
        folderViewAssetId: viewedId && merged.some((a) => a.id === viewedId) ? viewedId : null,
        quickLookAssetId:
          quickLookId && merged.some((a) => a.id === quickLookId) ? quickLookId : null
      })
    )
    // ── T-PRUNE ④：prune 白名单必须是**库里写入后的真实 id 集合** ──────────
    //
    // 旧实现传的是 `merged`（本次 rescan 的合并结果）当白名单 —— 那是 0.7.6 真机
    // 误删 36 张缩略图的根因：任何**没参与本次合并**的记录（历史悬空记录、
    // rescan 期间并发导入的新记录）都不在 `merged` 里 → 它们的缩略图被判成孤儿
    // → `thumbPrune` 直接从磁盘删文件。文件没了，索引却还写着 `ready`，
    // 于是"每次启动一大批预览图不出现"。
    //
    // 为什么 `db.assets.toArray()` 才是权威：写库已经完成（上面 `bulkPut` + 删除），
    // 此刻表里的 id 集合**就是**"这些缩略图还有人认领"的完整答案 —— 包括本次没被
    // 合并、但在库里活着的记录，以及并发写入的新记录。`merged ∪ localAssets`
    // 便宜一点，但漏掉并发导入的记录，需要靠"没人这时导入"这种假设，不采用。
    //
    // 读表失败 / 空库 → **一次也不 prune**：传部分清单就是批量删盘，而空白名单会删掉
    // 全部缓存。没有孤儿可清是小事，删错文件是事故。
    let idsAfter: string[] | null = null
    try {
      idsAfter = (await db.assets.toArray()).map((a) => a.id)
    } catch {
      // 读表失败（含运行在无 IndexedDB 的环境里）：保持 null = 本次不清孤儿
      idsAfter = null
    }
    if (idsAfter && idsAfter.length > 0) {
      window.modvault.pruneThumbs(idsAfter).catch(() => 0)
    } else {
      console.info('[recordHygiene] 跳过缩略图孤儿清理：读表失败或库为空（不冒删盘风险）')
    }
    // rescan 会把新/变更资产的 thumbStatus 重置为 none → 后台补齐（封顶 ENSURE_THUMB_BATCH）
    void ensureMissingThumbs()
    // 同上：材质球缓存也可能失效（贴图换了 → hash 变）→ 重新入队
    void ensureMissingBallThumbs()
    // rescan 可能发现新的遗留布局目录 → 重新计数（自动迁移策略同 init）
    void maybeAutoMigrate()
    // RA6：结构不符被跳过的目录必须上报，否则用户会当成 bug（T08）
    if (ignored.length > 0) {
      const depth = ignored.filter((e) => e.reason === 'depth').length
      const notDir = ignored.length - depth
      set({ notice: `重扫完成，${ignored.length} 个目录结构异常已跳过（${depth} 个深度不符、${notDir} 个位置是文件）` })
    }
    return { aborted: null, scanned: scanned.length, removed: goneIds.length } satisfies RescanOutcome
  },

  async forceRescan() {
    // 与 rescan 共用同一条实现（只有 opts 不同），避免两套行为漂移
    return get().rescan({ force: true })
  },

  async refreshRescanBackupCount() {
    const count = (await listRescanBackups().catch(() => [] as IndexBackup[])).length
    set({ rescanBackupCount: count })
  },

  // ── v0.4 库一致性对账 ────────────────────────────────────────
  /**
   * 只读检查。`window.modvault.rescan()` 走 main 的 `rescanLibrary()`：纯目录扫描
   * （walkFiles + 解版本头 + 读材质 json），**不写 IndexedDB、不动磁盘、不生成缩略图**。
   */
  async checkLibraryConsistency() {
    const indexAssets = get().assets
    const { assets: scanned } = await window.modvault.rescan()
    return reconcile(indexAssets, scanned)
  },

  async applyReconcile(actions) {
    const result: ReconcileResult = { removed: 0, added: 0, fixed: 0, failed: 0 }
    const removeIds = [...new Set(actions.removeIndex)]
    const addCandidates = actions.addIndex.filter(
      (a) => a && typeof a.folder === 'string' && a.folder !== ''
    )
    const fixIds = [...new Set(actions.fixCategory)]
    if (removeIds.length === 0 && addCandidates.length === 0 && fixIds.length === 0) {
      return result
    }

    // 重新扫一次拿**当前**磁盘真相：弹窗可能已经开了几分钟，报告是快照。
    // 顺带保证「幂等」——第二次 apply 时磁盘与索引已一致，下面全部会被过滤成 0。
    let scanned: Asset[]
    try {
      scanned = (await window.modvault.rescan()).assets
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      set({ notice: `库一致性修复已取消：读不到库目录（${reason}）` })
      result.failed = removeIds.length + addCandidates.length + fixIds.length
      return result
    }

    const current = get().assets
    const byId = new Map(current.map((a) => [a.id, a]))
    const indexFolders = new Set(current.map((a) => a.folder))
    const scannedByFolder = new Map(scanned.map((a) => [a.folder, a]))

    let removedIds = new Set<string>()
    const addedAssets: Asset[] = []
    const fixedById = new Map<string, Asset>()

    // ① 移除：**先落备份再删**（顺序不可颠倒，备份失败就不删）
    const removeTargets = removeIds
      .map((id) => byId.get(id))
      .filter((a): a is Asset => Boolean(a))
    if (removeTargets.length > 0) {
      try {
        await backupRescanDeletions(removeTargets)
        await db.assets.bulkDelete(removeTargets.map((a) => a.id))
        result.removed = removeTargets.length
        removedIds = new Set(removeTargets.map((a) => a.id))
      } catch {
        result.failed += removeTargets.length
      }
    }

    // ② 补入：按 folder 去重；已索引的跳过（= 幂等）。
    //    用**本次扫描的新鲜对象**而不是弹窗里的旧快照：检查之后文件可能已被删掉
    //    （那就别再补入），也可能它的 id/封面已经变了。
    const seen = new Set<string>()
    for (const a of addCandidates) {
      if (indexFolders.has(a.folder) || seen.has(a.folder)) continue
      const fresh = scannedByFolder.get(a.folder)
      if (!fresh) continue
      seen.add(a.folder)
      addedAssets.push(fresh)
    }
    if (addedAssets.length > 0) {
      try {
        await db.assets.bulkPut(addedAssets)
        result.added = addedAssets.length
      } catch {
        result.failed += addedAssets.length
        addedAssets.length = 0 // 写失败 → 内存也不加，避免假成功
      }
    }

    // ③ 修正分类：以**当前磁盘**值为准；已一致 / 磁盘上已不存在的跳过（= 幂等）
    const fixedCandidates: Asset[] = []
    for (const id of fixIds) {
      const idx = byId.get(id)
      if (!idx) continue
      const disk = scannedByFolder.get(idx.folder)
      if (!disk) continue // 磁盘没了 → 归「移除索引」，不该走修正
      const idxCat = [idx.category1 ?? UNCLASSIFIED, idx.category2 ?? UNCLASSIFIED]
      const diskCat = [disk.category1 ?? UNCLASSIFIED, disk.category2 ?? UNCLASSIFIED]
      const same =
        idxCat[0] === diskCat[0] && idxCat[1] === diskCat[1] && idx.relFolder === disk.relFolder
      if (same) continue
      fixedCandidates.push({
        ...idx,
        category1: diskCat[0],
        category2: diskCat[1],
        folder: disk.folder,
        relFolder: disk.relFolder,
        updatedAt: Date.now()
      })
    }
    if (fixedCandidates.length > 0) {
      try {
        await db.assets.bulkPut(fixedCandidates)
        result.fixed = fixedCandidates.length
        for (const a of fixedCandidates) fixedById.set(a.id, a)
      } catch {
        result.failed += fixedCandidates.length
      }
    }

    // 内存状态与库对齐（批量写成功的那部分才更新）
    if (removedIds.size > 0 || addedAssets.length > 0 || fixedById.size > 0) {
      set((s) => {
        const kept = s.assets
          .filter((a) => !removedIds.has(a.id))
          .map((a) => fixedById.get(a.id) ?? a)
        // 移除索引后，按旧 id 派生的弹窗快照必须一起收掉（否则组件按 ids 过滤得到空集）
        return withPickerClosed({ assets: [...addedAssets, ...kept] })
      })
      if (removedIds.size > 0) {
        // 被移除资产的缩略图缓存成了孤儿 → 清掉（只动缓存，不动素材）
        window.modvault.pruneThumbs(get().assets.map((a) => a.id)).catch(() => 0)
      }
      if (addedAssets.length > 0) {
        // 补入的资产没有缩略图 → 后台补齐（与 rescan 同一条队列，不阻塞 UI）
        void ensureMissingThumbs()
      }
    }

    const done = result.removed + result.added + result.fixed
    if (done > 0 || result.failed > 0) {
      set({
        notice:
          `已移除 ${result.removed} / 补入 ${result.added} / 修正 ${result.fixed} 项` +
          (result.failed > 0 ? `（${result.failed} 项失败）` : '')
      })
    }
    return result
  },

  async restoreLastRescanBackup() {
    const backups = await listRescanBackups().catch(() => [] as IndexBackup[])
    const last = backups[0]
    if (!last) {
      set({ notice: '没有可恢复的重扫备份' })
      return 0
    }
    let records: Asset[] = []
    try {
      const parsed: unknown = JSON.parse(last.json)
      if (!Array.isArray(parsed)) throw new Error('备份内容不是数组')
      records = parsed as Asset[]
    } catch {
      set({ notice: '重扫备份已损坏，无法恢复' })
      return 0
    }
    if (records.length === 0) {
      set({ notice: '重扫备份为空，无需恢复' })
      return 0
    }
    // 只补回缺失的记录：已在索引里的（同 id）以当前为准，不覆盖用户之后的手工修改
    const existing = new Set(get().assets.map((a) => a.id))
    const missing = records.filter((r) => r && typeof r.id === 'string' && !existing.has(r.id))
    if (missing.length > 0) {
      await db.assets.bulkPut(missing)
      set((s) => ({ assets: [...missing, ...s.assets] }))
    }
    set({
      notice: `已恢复 ${missing.length} 个资产（磁盘文件需你自己放回原位）`
    })
    await get().refreshRescanBackupCount()
    return missing.length
  },

  async updateAsset(id, patch) {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return
    const updated: Asset = { ...asset, ...patch, updatedAt: Date.now() }
    commitAsset(set, updated)
  },

  // ── v0.4 资产标记（批量）──────────────────────────────────────
  async setFavorite(ids, value) {
    await patchAssets(ids, { favorite: value === true })
  },

  async setRating(ids, value) {
    await patchAssets(ids, { rating: normalizeRating(value) })
  },

  async setColorTag(ids, value) {
    await patchAssets(ids, { colorTag: value ?? null })
  },

  async setCover(id, rel) {
    // 换封面 = 换 salt（P0-8 / T04 §4.1）；RA3 的「先生成新、再通配删旧」与
    // files/size 的合并统一在 `commitCover` 里（setCover / setCoverFromImage / zhimo 共用）。
    // size 传 0 = "沿用索引里该文件的体积"（从资产内挑图时体积是已知的）。
    //
    // DEF-Z8：**缩略图重生 + 索引提交**必须与"写盘"同处一个按资产的锁内，
    // 否则自动任务可能在两步之间把文件删掉（方向 1/2 的双写）。
    await withAssetCoverLock(id, () => commitCover(id, rel, 0, 'manual'), coverLockWaitOptions())
  },

  async setCoverFromImage(id, input) {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return false
    // DEF-Z8：**IPC 写盘 → files/size 合并 → 索引提交**必须在同一把按资产锁内。
    // ⚠️ 锁内**不能**再调 `setCover`（同 id 会自己等自己 → 死锁），所以直接调内层 `commitCover`。
    return withAssetCoverLock(
      id,
      async () => {
        const res = await window.modvault
          .setCoverImage({ assetId: id, folder: asset.folder, ...input })
          .catch(() => null)
        if (!res) {
          set({ notice: '封面设置失败：仅支持 PNG/JPEG 且不超过 20MB 的图片' })
          return false
        }
        // 新封面文件进 files / 体积 + coverSource='manual' + 缩略图重生，全部在 commitCover 里；
        // 与 importer/rescan 的 walkFiles 视图保持一致，否则详情面板文件列表里看不到它。
        await commitCover(id, res.rel, res.size, 'manual')
        return true
      },
      coverLockWaitOptions()
    )
  },

  // ── 知末封面（docs/24，T-04）──────────────────────────────────

  async runZhimoCovers(opts) {
    const manual = opts?.manual === true

    // 重入保护**只拦自动批次**（防同一批被重复调度）。
    // 手动不在这里拦（DEF-Z8 第 4 条）：它要么排在该资产的写入锁后面，
    // 要么直接写；用"正在忙请稍后再试"拒绝用户才是坏体验。
    if (!manual && zhimoCoverRunning) return emptyZhimoResult(true)

    const settings = get().settings
    // 总开关只约束**自动**任务；关闭 → 零 IPC 调用，顺手清空 pending
    //（否则关了开关仍留一堆待抓 id，下次打开会突然开抓）。
    if (!manual && (!settings || settings.zhimoCover === false)) {
      pendingZhimoIds.length = 0
      return emptyZhimoResult()
    }

    // 自动任务用「本批导入收集的 id」；显式传 ids 时以调用方为准。
    // 注意 `splice` 会清空 pending —— 这是**预期**的消费语义（同 AI 分类的批次推进）。
    const ids = opts?.items ? [] : (opts?.ids ?? pendingZhimoIds.splice(0, pendingZhimoIds.length))
    const targets: ZhimoCoverTarget[] =
      opts?.items ??
      pickZhimoCoverTargets(get().assets, {
        replacePacked: settings?.zhimoCoverReplacePacked !== false,
        ids,
        // ⚠️ DEF-Z2：**不能**用默认 50 截断。本批导入 60 个模型时，第 51 个起
        // 会在这里被静默丢掉（配合 enqueue 不设上限，才能全量抓完）。
        // 分块节流由 runZhimoCoverQueue 的 chunkSize=50 负责，**不丢条目**。
        limit: ids.length,
        force: opts?.force === true
      })
    if (targets.length === 0) return emptyZhimoResult()

    if (!manual) zhimoCoverRunning = true
    if (manual) set({ zhimoCoverBusyId: targets[0]!.id })
    try {
      return await runZhimoCoverQueue(targets, {
        /**
         * DEF-Z8：**抓取（主进程写盘）+ 索引提交**必须在**同一个按资产的锁**内。
         *
         * 锁内还要重查一次资产状态（TOCTOU 闸门）：等锁的这段时间里，用户可能
         * 刚用「更换封面」设了图 —— 那就绝不能再写盘（`writeCoverImageInto()`
         * 会删掉同族的用户文件，正是竞态方向 2）。
         */
        fetchOne: async (t) =>
          withAssetCoverLock(
            t.id,
            async () => {
              const asset = get().assets.find((a) => a.id === t.id)
              // 排队期间被删 / 被 rescan 换掉 → 不抓（按失败计，不影响整批）
              if (!asset) return { ok: false, reason: 'no-id' }

              // ── 锁内重查：用户显式意图优先 ────────────────────────────
              // `force`（详情面板手动按钮）不跳：用户点了就是要覆盖。
              if (!opts?.force) {
                if (asset.coverSource === 'manual') return { skipped: true, reason: 'manual' }
                if (asset.coverSource === 'zhimo') return { skipped: true, reason: 'zhimo' }
              }

              const res = await window.modvault
                .fetchZhimoCover({ folder: asset.folder, id: t.zhimoId })
                .catch(() => ({ ok: false, reason: 'network' }) as FetchZhimoCoverResult)
              if (res.ok && res.rel && typeof res.size === 'number') {
                await commitCover(t.id, res.rel, res.size, 'zhimo')
                // TODO-3：风格来自**同一次**详情页 GET（`res.style`），封面成功后顺手补。
                // 只补空 / 只认词表 / 只对 model，判定全在 `resolveZhimoStyle()`。
                await applyZhimoStyle(t.id, res.style)
              }
              return res
            },
            coverLockWaitOptions()
          ),
        onEach: (t, res) => {
          // 写盘与提交已在 `fetchOne` 的锁内完成，这里只负责**反馈**（不碰磁盘/索引）
          if (res.ok) {
            // 手动才给反馈（自动任务全程静默：不 notice、不弹错、不写 UI）
            if (manual) {
              const size =
                typeof res.width === 'number' && typeof res.height === 'number'
                  ? `（${res.width}×${res.height}）`
                  : ''
              set({ notice: `已从知末更新封面${size}` })
            }
          } else if (manual) {
            set({ notice: zhimoCoverFailText(res.reason) })
          }
          opts?.onItemResult?.(t, res)
        },
        // 用户中途关掉总开关 → 自动批次立刻停（剩余条目不再发请求）；
        // 手动是一次性动作，没有"中途关开关"的语义，不挂停止条件。
        shouldStop: manual ? undefined : () => get().settings?.zhimoCover === false,
        // 仅单测注入（运行时不传 → 队列用真实 setTimeout）
        sleep: opts?.sleep
      })
    } finally {
      if (!manual) zhimoCoverRunning = false
      if (manual) set({ zhimoCoverBusyId: null })
      // 运行期间又导入了新资产（pending 非空）→ 再排一次。
      // 不会无限循环：pending 为空 / 开关关闭时 schedule 内部立刻早退。
      if (pendingZhimoIds.length > 0) scheduleZhimoCovers()
    }
  },

  async refreshZhimoCover(id) {
    const asset = get().assets.find((a) => a.id === id)
    if (!asset) return { ok: false, reason: 'no-id' }
    // 0.6.3：优先用**落库时算好的** zhimoId —— 知末有大量包只在**压缩包名**上带 ID
    // （解包后 `attachment_…\现代壁灯\现代壁灯.skp` 零 ID 痕迹），只看 `asset.name`
    // 会让这类资产永远抓不到封面。`zhimoIdOf` 兜底覆盖"老记录还没回填 / 包名 ID 无法事后找回"的情况。
    // 空串/纯空白视同"没有"（与 `enqueueZhimoCover` / `pickZhimoCoverTargets` 同口径）。
    const storedId = typeof asset.zhimoId === 'string' ? asset.zhimoId.trim() : ''
    const zhimoId = storedId || zhimoIdOf(asset.name)
    if (!zhimoId) {
      set({ notice: zhimoCoverFailText('no-id') })
      return { ok: false, reason: 'no-id' }
    }

    // DEF-Z1 / DEF-Z8：手动**复用同一条落库路径**（不复制逻辑），
    // 但**不再被批次锁拒绝** —— 真正的互斥是按资产的写入锁（`withAssetCoverLock`），
    // 它会把这次点击排在该资产当前写入的后面（排队 >3s 才给一句提示）。
    const box: { res: FetchZhimoCoverResult | null } = { res: null }
    await get().runZhimoCovers({
      items: [{ id, zhimoId }],
      force: true,
      manual: true,
      onItemResult: (_item, res) => {
        box.res = res
      }
    })
    return box.res ?? { ok: false }
  },

  async saveSettings(patch) {
    const settings = await window.modvault.setSettings(patch)
    set({ settings })
    // 侧栏入口关闭 → 顺带重置对应筛选（否则"筛选生效但入口不存在"，用户无法解除）
    const reset = hiddenSidebarFilterReset(settings, get().filters, get().dupOnly)
    if (reset) {
      set((s) => ({
        filters: { ...s.filters, ...reset.filters },
        dupOnly: reset.dupOnly
      }))
    }
  },

  async addCustomCategory(level, parent, name) {
    const cur = get().settings?.customTaxonomy
    const term = sanitizeCustomTerm(name)
    if (!term) return false
    const base: CustomTaxonomy = cur ?? { level1: [], level2: {} }
    if (level === 'level1') {
      if (base.level1.includes(term)) return false
      const next: CustomTaxonomy = { level1: [...base.level1, term], level2: { ...base.level2 } }
      await get().saveSettings({ customTaxonomy: next })
      return true
    }
    const p = sanitizeCustomTerm(parent)
    if (!p) return false
    const list = base.level2[p] ?? []
    if (list.includes(term)) return false
    const next: CustomTaxonomy = {
      level1: [...base.level1],
      level2: { ...base.level2, [p]: [...list, term] }
    }
    await get().saveSettings({ customTaxonomy: next })
    return true
  },

  async removeCustomCategory(level, parent, name) {
    const assets = get().assets
    const used = countCustomUsage(assets, { level, parent: parent ?? undefined, name })
    if (used > 0) return { ok: false, used }
    const cur = get().settings?.customTaxonomy
    if (!cur) return { ok: false, used }
    const term = sanitizeCustomTerm(name)
    if (!term) return { ok: false, used }
    let next: CustomTaxonomy
    if (level === 'level1') {
      if (!cur.level1.includes(term)) return { ok: false, used }
      // 连带语义：删一级时其名下的自定义二级一并失锚 → 同步移除（二级词条本身没有资产使用才会走到这里）
      const level2: Record<string, string[]> = { ...cur.level2 }
      delete level2[term]
      next = { level1: cur.level1.filter((v) => v !== term), level2 }
    } else {
      const p = sanitizeCustomTerm(parent)
      if (!p) return { ok: false, used }
      const list = cur.level2[p]
      if (!list || !list.includes(term)) return { ok: false, used }
      const remain = list.filter((v) => v !== term)
      const level2: Record<string, string[]> = { ...cur.level2 }
      if (remain.length > 0) level2[p] = remain
      else delete level2[p]
      next = { level1: [...cur.level1], level2 }
    }
    await get().saveSettings({ customTaxonomy: next })
    return { ok: true, used: 0 }
  },

  /**
   * AI 辅助分类（docs/15 §7）——**词表优先、模型兜底**。
   *
   * 执行顺序（不可调换）：
   * ① 只取 `未分类/未分类` 的资产（**绝不覆盖已有分类**，这也是唯一合法输入域）；
   * ② 每次最多 20 个名字调 `ai:classify`（main 侧发 HTTP；串行，不并发打用户的服务）；
   * ③ 按结论的「一级/二级」**分组**，每组调一次既有 `assignCategory`
   *    （真实移动目录 + 缩略图重生 + 写 Dexie —— 不复制任何移动逻辑）；
   * ④ 完成后只发**一条** notice：`成功 X / 未识别 Y / 失败 Z`。
   *
   * 失败语义：网络 / 解析 / 超时失败的名字计入「失败」，模型明确不判的计入「未识别」，
   * 两者都保持未分类 —— **不弹错误对话框**（后台任务，打扰用户没有收益）。
   */
  async runAiClassify() {
    if (aiClassifyRunning) return EMPTY_AI_SUMMARY
    const cfg = get().settings?.aiClassify
    // 未启用 / 未配置 → 零网络请求（与「默认关闭」拍板一致）
    if (!cfg || !cfg.enabled || !cfg.baseUrl.trim() || !cfg.model.trim()) {
      return EMPTY_AI_SUMMARY
    }

    const pending = get().assets.filter((a) => {
      const cur = categoriesOf(a)
      return cur.category1 === UNCLASSIFIED && cur.category2 === UNCLASSIFIED
    })
    if (pending.length === 0) return EMPTY_AI_SUMMARY

    aiClassifyRunning = true
    set({ aiClassifyBusy: true })
    let ok = 0
    let unknown = 0
    let failed = 0
    try {
      for (let offset = 0; offset < pending.length; offset += AI_CLASSIFY_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + AI_CLASSIFY_BATCH_SIZE)
        // 空名字不发请求（也不占对齐位），直接计入「未识别」
        const sendable: Asset[] = []
        const names: string[] = []
        for (const asset of batch) {
          if (typeof asset.name === 'string' && asset.name.trim()) {
            sendable.push(asset)
            names.push(asset.name)
          } else {
            unknown += 1
          }
        }
        if (names.length === 0) continue

        // 这一批请求失败（网络/超时/IPC 异常）→ 全部计入「失败」，继续下一批
        const res = await window.modvault.aiClassify({ names }).catch(() => null)
        if (!res) {
          failed += names.length
          continue
        }
        const failedSet = new Set(res.failedNames)

        // 同批内按分类对分组：一次 assignCategory 只接受一个分类对，分组能少发大量 IPC
        const groups = new Map<
          string,
          { category1: string; category2: string; ids: string[] }
        >()
        res.items.forEach((item, i) => {
          const asset = sendable[i]
          if (!asset) return
          if (!item) {
            const name = names[i] ?? ''
            if (failedSet.has(name)) failed += 1
            else unknown += 1
            return
          }
          const key = `${item.category1}\u0000${item.category2}`
          const group = groups.get(key) ?? {
            category1: item.category1,
            category2: item.category2,
            ids: []
          }
          group.ids.push(asset.id)
          groups.set(key, group)
        })

        for (const group of groups.values()) {
          // 复用既有指派链路：真实移动 + 缩略图重生 + DB 更新（含 notice）
          const summary = await get().assignCategory(group.ids, group.category1, group.category2)
          ok += summary.moved
          failed += summary.failed
        }
      }
    } catch {
      // 后台任务兜底：任何未预期异常都静默降级，不冒泡到 UI
      failed += 1
    } finally {
      aiClassifyRunning = false
      set({ aiClassifyBusy: false })
    }

    const summary: AiClassifySummary = { ok, unknown, failed }
    if (ok + unknown + failed > 0) {
      set({ notice: `AI 归类完成：成功 ${ok} / 未识别 ${unknown} / 失败 ${failed}` })
    }
    return summary
  },

  /**
   * 重跑自动分类（v1.0.13）——把历史 `未分类/未分类` 资产按**当前**词表重判一次。
   *
   * 为什么要这个入口：分类只在导入那一刻跑。v1.0.11（`ID_<数字>` 尾巴剥离）与
   * v1.0.12（容器口径闸门 + 一级回退）修好之后，**已入库的旧资产不会自己变好**——
   * 用户库里 10 个材质资产仍躺在 `材质/未分类` 或 `未分类` 里，看上去就像没修。
   *
   * 顺序（不可调换）：
   * ① 候选 = `未分类/未分类`（已分类的一个都不碰，避免"重跑一次把人工归类冲掉"）；
   * ② 判定用 `shared/classifyAsset.classifyAssetName`——与导入侧**同一份**实现；
   * ③ 判不出（仍双未分类）→ `missed`，**不产生任何移动**；
   * ④ **先写备份**再按分类对分组，逐组调既有 `assignCategory`
   *    （真实移动 + 缩略图重生 + 写库；不复制任何移动逻辑）；
   * ⑤ 一条 notice：`重跑分类：移动 X / 未识别 Y / 失败 Z`。
   */
  async reclassifyUnclassified() {
    // 防重入：按钮已禁用，但 IPC/快捷键将来可能再次触发；模块级布尔能拦住微任务间隙
    if (reclassifyRunning) return EMPTY_RECLASSIFY_SUMMARY

    const pending = get().assets.filter((a) => {
      const cur = categoriesOf(a)
      return cur.category1 === UNCLASSIFIED && cur.category2 === UNCLASSIFIED
    })
    if (pending.length === 0) {
      set({ notice: '没有需要重新分类的资产' })
      return EMPTY_RECLASSIFY_SUMMARY
    }

    reclassifyRunning = true
    set({ reclassifyBusy: true })
    let moved = 0
    let missed = 0
    let failed = 0
    try {
      // ① 纯判定（不碰磁盘）：先算完，才知道要备份哪些
      const hits: Array<{ asset: Asset; category1: string; category2: string }> = []
      for (const asset of pending) {
        const out = classifyAssetName(
          asset.name,
          asset.files.map((f) => f.name),
          asset.kind
        )
        if (out.category1 === UNCLASSIFIED && out.category2 === UNCLASSIFIED) {
          missed += 1
          continue
        }
        hits.push({ asset, category1: out.category1, category2: out.category2 })
      }

      if (hits.length > 0) {
        // ② 备份（**早于任何移动**）：备份写不进去就整体放弃，宁可不搬
        await backupReclassMoves(
          hits.map((h) => {
            const cur = categoriesOf(h.asset)
            return {
              id: h.asset.id,
              name: h.asset.name,
              folder: h.asset.folder,
              relFolder: h.asset.relFolder,
              category1: cur.category1,
              category2: cur.category2
            }
          })
        )

        // ③ 按分类对分组：一次 assignCategory 只接受一个分类对（同 AI 补分类的口径）
        const groups = new Map<
          string,
          { category1: string; category2: string; ids: string[] }
        >()
        for (const h of hits) {
          const key = `${h.category1}\u0000${h.category2}`
          const group = groups.get(key) ?? {
            category1: h.category1,
            category2: h.category2,
            ids: []
          }
          group.ids.push(h.asset.id)
          groups.set(key, group)
        }
        for (const group of groups.values()) {
          const summary = await get().assignCategory(group.ids, group.category1, group.category2)
          moved += summary.moved
          failed += summary.failed
        }
      }
    } catch {
      // 后台动作兜底：任何未预期异常都静默降级（备份/移动失败已由上行归类），不冒泡到 UI
      failed += 1
    } finally {
      reclassifyRunning = false
      set({ reclassifyBusy: false })
    }

    await get()
      .refreshReclassBackupCount()
      .catch(() => undefined)
    const summary: ReclassifySummary = { moved, missed, failed }
    set({ notice: `重跑分类：移动 ${moved} / 未识别 ${missed} / 失败 ${failed}` })
    return summary
  },

  /**
   * 按**知末站方分类**重排（`未分类/未分类` → 站方分类）。
   *
   * ## ⚠️ 2026-10-29 语义变化（读这里再改代码）
   *
   * 本函数从「按站方**末级名单源**搬」改成「按 **S1×S2 两源交叉验证**搬」：
   *
   * | | 改造前 | 改造后 |
   * |---|---|---|
   * | 判定依据 | `classifyBaseName` + `mapZhimoCategory` 单源 | 标题语义（S1）× 面包屑（S2），末级名只做旁证 |
   * | 会搬 | 站方给了映射得上的名字就搬 | `high`（两源互证）**或** `medium-s2`（站方单源） |
   * | 不搬 | 映射不上 / 多候选 | `conflict`（进待确认队列）· `medium-s1` · `none` |
   *
   * **对已经用过这个按钮的人：N 会变小。** 因为 `conflict` 那部分（两源打架）从
   * "按站方搬"变成"交用户裁定"，不再自动搬。对新用户没有感知差异（按钮文案仍是
   * 「按站方分类重排」，`SettingsDialog` 的文案统一由 T-14 处理）。
   *
   * `medium-s2` 仍然搬的理由见 `planZhimoVerify()` 的函数头（导入链路现状本来就按
   * 文件名匹配直接落盘，站方单源不比它差；不搬会让"自动采用"变成空话）。
   *
   * ## 为什么必须"先全部抓完、再统一搬"（顺序不可调换）
   * ① 备份必须在**任何移动之前**写完 —— 否则搬了一半崩了就没有还原凭证；
   * ② 抓取是慢活（站点限流），先攒命中再一次落库，备份只需写一条、日志只有一个总数；
   * ③ 取消时**已抓到的仍然落库**：用户点取消是"别再打站了"，不是"把已拿到的结果丢掉"。
   *
   * 落库**只**走 `get().assignCategory()`：目标重名 `X-2`、缩略图重生、`dedupeKey` 重算、
   * `db.assets.bulkPut`、内存同步都由它负责。这里**绝不**自己 `fs.rename` 或改记录。
   *
   * 失败语义：详情页请求失败 + 移动失败都计入 `failed`；单组失败不中断其余组。
   * 自动任务（`manual !== true`）全程静默（不 notice），但**必写一条日志**（含 approx 计数）。
   */
  async runZhimoCategoryReclass(opts) {
    // 防重入：两个触发点（importPaths 收尾 + main 的 import:batchDone）可能几乎同时到
    if (zhimoReclassRunning) return EMPTY_ZHIMO_RECLASS_SUMMARY

    const manual = opts?.manual === true
    // 自动路径受设置开关约束；手动路径不看开关（用户点了就是要）。缺省 true。
    if (!manual && !zhimoAutoCategoryEnabled(get().settings)) {
      return EMPTY_ZHIMO_RECLASS_SUMMARY
    }

    // ① 候选：非软删 + 能取到知末 ID + 未被用户定案（判定全在纯函数里，与单测同一口径）
    const candidates = get().assets.filter(isZhimoVerifyCandidate)
    if (candidates.length === 0) {
      if (manual) set({ notice: '没有需要按知末分类整理的资产' })
      return EMPTY_ZHIMO_RECLASS_SUMMARY
    }

    const targets: ZhimoReclassTarget[] = []
    for (const asset of candidates) {
      const zhimoId = zhimoReclassIdOf(asset)
      // `isZhimoVerifyCandidate` 已保证非 null；这里只是类型收窄 + 防御
      if (!zhimoId) continue
      targets.push({ id: asset.id, zhimoId, kind: asset.kind, name: asset.name })
    }
    if (targets.length === 0) {
      if (manual) set({ notice: '没有需要按知末分类整理的资产' })
      return EMPTY_ZHIMO_RECLASS_SUMMARY
    }

    // 判定用的**实时**查找（不是抓取开始时的快照）：抓一轮可能几分钟，
    // 期间用户完全可能手工把某条拖到别的分类 / 删掉它。用快照判定会让门槛②
    // （落点 ≠ 当前磁盘分类）失去意义 —— 那正是它存在的原因：**别把用户刚分的类再搬一次**。
    const liveAssetOf = (id: string): Asset | undefined =>
      get().assets.find((a) => a.id === id)

    zhimoReclassRunning = true
    set({
      zhimoReclass: { running: true, done: 0, total: targets.length, cancelRequested: false }
    })
    const summary: ZhimoReclassSummary = { ...EMPTY_ZHIMO_RECLASS_SUMMARY }
    let cancelled = false
    try {
      // ② 抓取 + 判定（不碰磁盘）。`fetchZhimoMeta` 永不抛错，这里再兜一层 IPC 异常。
      const out = await runZhimoReclassQueue(targets, {
        fetchMeta: (target) =>
          window.modvault
            .fetchZhimoMeta({ id: target.zhimoId })
            .catch(() => ({ ok: false, reason: 'network' }) as FetchZhimoMetaResult),
        // 判定走交叉验证（docs/35 §5）：S1（资产名/文件名语义）× S2（面包屑）× S3（旁证）。
        // 取不到资产（抓取期间被删）→ 按"站方没给"跳过，绝不凭空造一个落点。
        decide: (target, meta) => {
          const asset = liveAssetOf(target.id)
          // 抓取期间资产被删 / 被 rescan 换掉 → 没有可判对象，什么都不做
          if (!asset) return { kind: 'untouched', reason: 'gone' } as const
          return planZhimoVerify({ asset, meta, now: Date.now() })
        },
        onProgress: (progress) => {
          set((s) => ({
            zhimoReclass: { ...s.zhimoReclass, done: progress.done, total: progress.total }
          }))
          opts?.onProgress?.(progress)
        },
        shouldStop: () =>
          opts?.shouldStop?.() === true || get().zhimoReclass.cancelRequested === true,
        // 仅单测注入（运行时不传 → 队列用真实 setTimeout 节流）
        sleep: opts?.sleep
      })

      cancelled = out.stopped
      summary.scanned = out.scanned
      summary.ambiguous = out.ambiguous
      summary.unmapped = out.unmapped
      summary.noStation = out.noStation
      summary.failed = out.failed
      summary.conflicts = out.conflicts

      // ③ 写回「不搬目录」那两种的 `classifyReview`（conflict / 落点相同）。
      //    这批条目**完全不动磁盘**，所以先写它们、再搬目录，两条路径互不干扰。
      //    ⚠️ 写回一律"整条记录覆盖式 bulkPut"，所以必须用**当下**的 `get().assets`
      //    （不是抓取开始时的快照）—— 否则会把别人刚改的 field 冲掉。
      if (out.reviews.length > 0) {
        const byIdNow = new Map(get().assets.map((a) => [a.id, a]))
        const pending: Asset[] = []
        for (const item of out.reviews) {
          const asset = byIdNow.get(item.id)
          if (!asset) continue
          // 用户/上一轮在此期间已定案 → 不覆盖（同门槛③，这里是最后一道闸）
          if (typeof asset.classifyReview?.decidedAt === 'number') continue
          pending.push({ ...asset, classifyReview: item.review, updatedAt: Date.now() })
        }
        if (pending.length > 0) {
          await db.assets.bulkPut(pending)
          const byId = new Map(pending.map((a) => [a.id, a]))
          set((s) => ({ assets: s.assets.map((a) => byId.get(a.id) ?? a) }))
        }
      }

      if (out.hits.length > 0) {
        // 抓取期间资产可能被删 / 被 rescan 换掉 → 落库前按 id 重查（找不到计入失败）
        const byId = new Map(get().assets.map((a) => [a.id, a]))
        const kept: typeof out.hits = []
        const records: ReclassRecord[] = []
        for (const hit of out.hits) {
          const asset = byId.get(hit.id)
          if (!asset) {
            summary.failed += 1
            continue
          }
          const cur = categoriesOf(asset)
          records.push({
            id: asset.id,
            name: asset.name,
            folder: asset.folder,
            relFolder: asset.relFolder,
            category1: cur.category1,
            category2: cur.category2
          })
          kept.push(hit)
        }

        if (records.length > 0) {
          // ③ 备份（**早于任何移动**；前缀区分通道，见 ZHIMO_RECLASS_BACKUP_PREFIX 注释）
          await backupReclassMoves(records, ZHIMO_RECLASS_BACKUP_PREFIX)

          /** 每条命中的置信度（从要落库的 `review` 反查，见下方注释） */
          const reviewConfidenceOf = new Map(
            kept
              .filter((h) => h.review !== undefined)
              .map((h) => [h.id, h.review!.confidence] as const)
          )

          // ④ 按分类对分组：一次 assignCategory 只接受一个分类对
          const groups = groupByCategoryPair(
            kept.map((h) => ({ id: h.id, category1: h.category1, category2: h.category2 }))
          )
          const approxIds = new Set(kept.filter((h) => h.approx).map((h) => h.id))
          for (const [key, ids] of groups) {
            const pair = parseCategoryPairKey(key)
            const groupApprox = ids.reduce((n, id) => n + (approxIds.has(id) ? 1 : 0), 0)
            /**
             * 这一组里**站方单源**（`medium-s2`）搬的条数。
             *
             * 从 `hit.review.confidence` 反查（不是从判定结果另存一份）：`review` 是**要落库的
             * 真值**，用它当唯一来源就不会出现"计数说 medium-s2、库里写的是 high"这种漂移。
             */
            const groupUnverified = ids.reduce(
              (n, id) => n + (reviewConfidenceOf.get(id) === 'medium-s2' ? 1 : 0),
              0
            )
            try {
              const assigned = await get().assignCategory(ids, pair.category1, pair.category2)
              summary.moved += assigned.moved
              summary.failed += assigned.failed
              // approx / unverified 都必须是 moved 的**子集**：按该组真实移动数封顶
              // （个别资产失败时不虚报 —— 没搬成功的既不算"猜的"也不算"单源搬的"）
              summary.approx += Math.min(groupApprox, assigned.moved)
              summary.unverified += Math.min(groupUnverified, assigned.moved)
            } catch {
              // 单组异常（不该发生：assignCategory 内部已逐条 catch）→ 计失败，继续下一组
              summary.failed += ids.length
            }
          }

          // ⑤ 已搬的条目：写回 `classifyReview`（`decidedAt` 是"已定案"的凭据，
          //    写早了会在移动失败时把这条永久钉死 → 必须**移动之后**、且**只对真正落到目标
          //    分类的那些**写。没搬成功的保持原样，下一批还会再试。
          const plannedReview = new Map(
            kept.filter((h) => h.review !== undefined).map((h) => [h.id, h.review!])
          )
          if (plannedReview.size > 0) {
            const byIdAfter = new Map(get().assets.map((a) => [a.id, a]))
            const moved: Asset[] = []
            for (const hit of kept) {
              const review = plannedReview.get(hit.id)
              if (!review) continue
              const asset = byIdAfter.get(hit.id)
              if (!asset) continue
              const cur = categoriesOf(asset)
              if (cur.category1 !== hit.category1 || cur.category2 !== hit.category2) continue
              moved.push({ ...asset, classifyReview: review, updatedAt: Date.now() })
            }
            if (moved.length > 0) {
              await db.assets.bulkPut(moved)
              const byId2 = new Map(moved.map((a) => [a.id, a]))
              set((s) => ({ assets: s.assets.map((a) => byId2.get(a.id) ?? a) }))
            }
          }
        }
      }
    } catch {
      // 后台任务兜底：任何未预期异常都静默降级，不冒泡到 UI
      summary.failed += 1
    } finally {
      zhimoReclassRunning = false
      set((s) => ({
        zhimoReclass: { ...s.zhimoReclass, running: false, cancelRequested: false }
      }))
    }

    // ⑤ 日志：approx 必须出现在这里（"有多少条是猜的"的唯一锚点）
    const ctx: ZhimoReclassLogContext = {
      scanned: summary.scanned,
      moved: summary.moved,
      approx: summary.approx,
      ambiguous: summary.ambiguous,
      unmapped: summary.unmapped,
      noStation: summary.noStation,
      failed: summary.failed,
      conflicts: summary.conflicts,
      unverified: summary.unverified,
      cancelled,
      manual
    }
    try {
      window.modvault?.reportLog?.({
        level: 'info',
        message: 'zhimo:reclass',
        context: { ...ctx, text: zhimoReclassSummaryText(ctx) }
      })
    } catch {
      /* 日志失败绝不影响落库 */
    }
    // 自动任务静默（同封面：不 notice、不弹错）；手动才给汇总
    if (manual) set({ notice: zhimoReclassSummaryText(ctx) })
    // ⑥ 批次汇总的两个增量（`docs/35 §4.3 入口②`）：**只累加自动路径**。
    //    手动重排是用户在设置页主动点的，与"这一批导入"无关 —— 混进来会让下次导入的
    //    汇总数字凭空变大（甚至在本批没有落库素材时也无处消费，一直挂到下一批）。
    //    这两个计数由 `reportReviewSummary()` 消费后归零，**这里绝不发 notice**。
    if (!manual) {
      conflictsInBatchCount += summary.conflicts
      unverifiedInBatchCount += summary.unverified
    }
    return summary
  },

  cancelZhimoCategoryReclass() {
    set((s) => ({ zhimoReclass: { ...s.zhimoReclass, cancelRequested: true } }))
  },

  /**
   * 一键重扫 · 从知末获取封面（存量补齐，2026-10 用户拍板）。
   *
   * 候选 = `isZhimoCoverBackfillCandidate`（与单测同一口径；真正跑的时候队列里
   * 每一条还会在**锁内重查**：排队期间被用户手动接管 / 被其它通道补上的按 skipped 跳过，
   * 绝不写盘 —— `writeCoverImageInto()` 会删同族文件，顶掉用户封面是 0.7.2 修过的
   * 那类事故，不能在这里复发）。
   *
   * 进度：`fetchOne` 的 `finally` 里逐条 +1（成功/失败/跳过/异常都不漏），
   * 设置页实时可见；取消语义与重排一致：只停"发新请求"，已抓到的照常落库。
   */
  async runZhimoCoverBackfill(opts) {
    const idle: ZhimoCoverBackfillSummary = {
      ok: 0,
      failed: 0,
      skipped: 0,
      stopped: false,
      total: 0
    }
    if (zhimoCoverBackfillRunning) return idle

    const targets: ZhimoCoverTarget[] = []
    for (const asset of get().assets) {
      if (!isZhimoCoverBackfillCandidate(asset)) continue
      const zhimoId = zhimoCoverIdOf(asset)
      // `isZhimoCoverBackfillCandidate` 已保证非 null；这里只是类型收窄 + 防御
      if (!zhimoId) continue
      targets.push({ id: asset.id, zhimoId })
    }
    if (targets.length === 0) {
      set({ notice: '没有需要从知末补封面的资产（已有 cover 文件的一律不重抓）' })
      return idle
    }

    zhimoCoverBackfillRunning = true
    set({
      zhimoCoverBackfill: {
        running: true,
        done: 0,
        total: targets.length,
        cancelRequested: false
      }
    })
    const summary: ZhimoCoverBackfillSummary = { ...idle, total: targets.length }
    // 跳过原因分票（0.8.3）：队列只有一个 skipped 总数，但用户反馈"跳过"被误解成
    // 按钮坏了 —— 文案必须能区分"已有 cover 文件"（本次自愈的目标人群，看到它
    // 说明启动自愈该接管了）与"手动封面"（用户自己设的，本来就不该动）。
    let skippedCoverFile = 0
    let skippedManual = 0
    try {
      const out = await runZhimoCoverQueue(targets, {
        fetchOne: async (t) => {
          try {
            return await withAssetCoverLock(
              t.id,
              async () => {
                const asset = get().assets.find((a) => a.id === t.id)
                // 排队期间被删 / 被 rescan 换掉 → 不抓（按失败计，不影响整批）
                if (!asset) {
                  return { ok: false, reason: 'no-id' } satisfies FetchZhimoCoverResult
                }
                // 锁内重查（TOCTOU 闸门，同 runZhimoCovers）：用户刚手动设了封面 /
                // 已有 cover 文件（别的通道先抓到了）→ 跳过
                if (asset.coverSource === 'manual') {
                  skippedManual += 1
                  return { skipped: true, reason: 'manual' } as const
                }
                if (hasCoverAssetFile(asset.files)) {
                  skippedCoverFile += 1
                  return { skipped: true, reason: 'zhimo' } as const
                }
                const res = await window.modvault
                  .fetchZhimoCover({ folder: asset.folder, id: t.zhimoId })
                  .catch(() => ({ ok: false, reason: 'network' }) as FetchZhimoCoverResult)
                if (res.ok && res.rel && typeof res.size === 'number') {
                  await commitCover(t.id, res.rel, res.size, 'zhimo')
                  // 风格来自同一次详情页 GET：只补空 / 只认词表 / 只对 model
                  await applyZhimoStyle(t.id, res.style)
                } else if (!res.ok && res.reason === 'write-failed') {
                  // 写盘失败的 WARN 必须带 folder（0.8.3 C 段的取证通道）：
                  // DB folder 与磁盘脱同步时，这条日志是"写的哪个目录、为何 ENOENT"
                  // 的唯一线索（main 侧 catch 只有 reason，folder 只有渲染层有）。
                  try {
                    window.modvault?.reportLog?.({
                      level: 'warn',
                      message: 'zhimo:cover-write-failed',
                      context: { id: t.id, folder: asset.folder, name: asset.name }
                    })
                  } catch {
                    /* 日志失败绝不影响结果 */
                  }
                }
                return res
              },
              coverLockWaitOptions()
            )
          } finally {
            // 进度：每处理完一条都 +1（取消与异常也不漏，否则进度条会停在半路）
            set((s) => ({
              zhimoCoverBackfill: {
                ...s.zhimoCoverBackfill,
                done: s.zhimoCoverBackfill.done + 1
              }
            }))
          }
        },
        shouldStop: () => get().zhimoCoverBackfill.cancelRequested,
        // 仅单测注入（运行时不传 → 队列用真实 setTimeout 节流）
        sleep: opts?.sleep
      })
      summary.ok = out.ok
      summary.failed = out.failed
      summary.skipped = out.skipped
      summary.stopped = out.stopped
    } catch {
      // 后台动作兜底：未预期异常静默降级（单条失败已由队列计入），不冒泡到 UI
      summary.failed += 1
    } finally {
      zhimoCoverBackfillRunning = false
      set((s) => ({
        zhimoCoverBackfill: {
          ...s.zhimoCoverBackfill,
          running: false,
          cancelRequested: false
        }
      }))
    }

    try {
      window.modvault?.reportLog?.({
        level: 'info',
        message: 'zhimo:cover-backfill',
        context: {
          total: summary.total,
          ok: summary.ok,
          failed: summary.failed,
          skipped: summary.skipped,
          cancelled: summary.stopped
        }
      })
    } catch {
      /* 日志失败绝不影响结果 */
    }

    // 跳过明细分票展示（0.8.3）：「已有 cover 文件」单列 —— 用户按外部教程把
    // cover 图放回盘上后，看到这句就知道"软件认到了"，而不是按钮坏了。
    const skipNotes: string[] = []
    if (skippedCoverFile > 0) skipNotes.push(`跳过 ${skippedCoverFile}（已有 cover 文件）`)
    if (skippedManual > 0) skipNotes.push(`跳过 ${skippedManual}（手动封面）`)
    const skippedNote = skipNotes.length > 0 ? ` · ${skipNotes.join('，')}` : ''
    set({
      notice: `知末封面补抓${summary.stopped ? '（已取消）' : ''}：成功 ${summary.ok} / 失败 ${summary.failed}${skippedNote}`
    })
    return summary
  },

  cancelZhimoCoverBackfill() {
    set((s) => ({ zhimoCoverBackfill: { ...s.zhimoCoverBackfill, cancelRequested: true } }))
  },

  /**
   * 撤销最近一次重跑分类（v1.0.13）。
   *
   * 依据**同通道**备份里记录的**原分类对**搬回（原值是 `未分类` 就搬回双哨兵目录），
   * 同样走 `assignCategory`。索引里已不存在的资产（用户删了）跳过并计入 `failed`。
   * 还原成功后**删除该备份**——"撤销"是消费型操作，否则按钮会永远亮着且行为不可预期。
   *
   * `prefix` 缺省 `'reclass-'`（老通道，行为逐字不变）；知末通道传
   * `ZHIMO_RECLASS_BACKUP_PREFIX`。前缀同时决定：读哪条通道的备份、刷新哪个计数器、
   * 以及 notice 的措辞（"重跑" vs "知末重排"）。
   */
  async undoLastReclassify(prefix: string = 'reclass-') {
    if (reclassifyRunning) return { restored: 0, failed: 0 }

    const isZhimo = prefix === ZHIMO_RECLASS_BACKUP_PREFIX
    /** 刷新**本通道**的备份条数（两条通道各自计数，不能互相覆盖） */
    const refreshCount = async (): Promise<void> => {
      try {
        if (isZhimo) await get().refreshZhimoReclassBackupCount()
        else await get().refreshReclassBackupCount()
      } catch {
        /* 计数刷新失败不影响还原结果（按钮下一次打开设置会再刷） */
      }
    }

    const backups = await listReclassBackups(prefix).catch(() => [] as IndexBackup[])
    const last = backups[0]
    if (!last) {
      set({ notice: isZhimo ? '没有可撤销的知末重排记录' : '没有可撤销的重跑记录' })
      return { restored: 0, failed: 0 }
    }

    let records: ReclassRecord[] = []
    try {
      const parsed: unknown = JSON.parse(last.json)
      records = Array.isArray(parsed) ? (parsed as ReclassRecord[]) : []
    } catch {
      records = []
    }
    if (records.length === 0) {
      await db.backups.bulkDelete([last.id]).catch(() => undefined)
      await refreshCount()
      set({ notice: isZhimo ? '知末重排备份内容不可用，已清理' : '重跑备份内容不可用，已清理' })
      return { restored: 0, failed: 0 }
    }

    reclassifyRunning = true
    set({ reclassifyBusy: true })
    let restored = 0
    let failed = 0
    try {
      const byId = new Map(get().assets.map((a) => [a.id, a]))
      const groups = new Map<
        string,
        { category1: string; category2: string; ids: string[] }
      >()
      for (const r of records) {
        if (!byId.has(r.id)) {
          // 资产已被删除 / 被 rescan 丢弃 → 无法搬回，计入失败（不阻断其它资产的还原）
          failed += 1
          continue
        }
        const key = `${r.category1}\u0000${r.category2}`
        const group = groups.get(key) ?? {
          category1: r.category1,
          category2: r.category2,
          ids: []
        }
        group.ids.push(r.id)
        groups.set(key, group)
      }
      for (const group of groups.values()) {
        const summary = await get().assignCategory(group.ids, group.category1, group.category2)
        restored += summary.moved
        failed += summary.failed
      }
      // 消费掉这次备份（还原已尽力完成，重复点不应再搬一次）
      await db.backups.bulkDelete([last.id]).catch(() => undefined)
    } catch {
      failed += 1
    } finally {
      reclassifyRunning = false
      set({ reclassifyBusy: false })
    }

    await refreshCount()
    set({ notice: `已还原 ${restored} 个资产（${failed} 个失败）` })
    return { restored, failed }
  },

  /** 刷新「可撤销的重跑备份」条数（设置页打开时 / 重跑或撤销完成后调用） */
  async refreshReclassBackupCount() {
    const list = await listReclassBackups().catch(() => [] as IndexBackup[])
    set({ reclassifyBackupCount: list.length })
  },

  /**
   * 刷新「可撤销的知末重排备份」条数（`zhimo-reclass-*`）。
   * 与 `refreshReclassBackupCount` 同形，只是换了通道前缀。
   */
  async refreshZhimoReclassBackupCount() {
    const list = await listReclassBackups(ZHIMO_RECLASS_BACKUP_PREFIX).catch(
      () => [] as IndexBackup[]
    )
    set({ zhimoReclassBackupCount: list.length })
  },

  /**
   * 材质球调参持久化（docs/12 §5.2）——滑块 change 防抖 400ms 后调用（不挂在弹窗关闭）。
   *
   * 步骤：① `normalizeParams`（先 clamp 再 round2）→ 与 hash 输入完全一致的值；
   * ② 与已存值（同样规范化后）比较，无变化直接 return（防无意义写库 / 重渲）；
   * ③ 登记旧球图名到 `ballStaleNames`（仅当旧 thumbPath 确实是球图）；
   * ④ `db.assets.put` + `commitAsset`；
   * ⑤ `enqueueBallThumb` → 走 §4.2 的「先建新、再删旧」。
   *
   * ⚠️ §4.3 竞态：全程**不**改 `thumbStatus`。`ensureMissingThumbs` 的候选筛选要求
   * `thumbStatus !== 'ready'`，若这里先置非 ready，该资产会被封面缩略图分支抢走
   * （`ensureThumb` 的 salt 是封面路径哈希，不是球图 hash）→ 网格变回封面图、球图丢失。
   */
  async persistRenderParams(assetId, scales) {
    const normalized = normalizeParams(scales)
    const asset = get().assets.find((a) => a.id === assetId)
    if (!asset) return
    if (paramsKey(normalized) === paramsKey(resolveRenderParams(asset))) return

    // 旧 thumbPath 只有「确实是球图」才登记待删——封面 salt（官方渲染图 / 手动封面）
    // 不是球图，删它会连带删掉封面缓存（§4.1 场景 ①②）。
    // 用 `wantedBallName`（而非就地拼 hash）保证与判新鲜 / 落盘同一口径。
    const oldName = asset.thumbPath
    if (oldName && oldName === wantedBallName(asset)) {
      ballStaleNames.set(asset.id, oldName)
    }

    const updated: Asset = { ...asset, renderParams: normalized, updatedAt: Date.now() }
    commitAsset(set, updated)
    enqueueBallThumb(updated)
  },

  /**
   * 记住材质球的**几何形态**（2026-10 缓存策略：形态是球图身份的一部分）。
   *
   * 与 `persistRenderParams` 完全同构，理由也一样：
   * ① 形态参与 hash → 换形态 = 换期望名，旧图登记到 `ballStaleNames` 后按
   *    「先建新、再删旧」替换（升级期间卡片仍显示旧图，不闪灰格）；
   * ② 全程**不**改 `thumbStatus`（§4.3 竞态：置非 ready 会被封面缩略图分支抢走）；
   * ③ 与已存形态相同直接 return（防无意义写库 / 重渲）。
   *
   * ## 写回口径：切回球面时写**显式 `'sphere'`**，不清字段
   *
   * 二选一里选了「写 `'sphere'`」而不是「写回 `undefined`/删字段」，理由：
   * ① `Asset.renderShape` 是可选字段，选 `undefined` 需要 `delete updated.renderShape`
   *    或重建对象去掉键 —— 而 `commitAsset` / Dexie 的 `put` 对"键不存在"与"键为 undefined"
   *    处理不一致（Dexie 会把 `undefined` 值当成缺省，但对象上仍带这个键，
   *    调试时 `'renderShape' in asset === true` 却读不到值，排查极易误判）；
   * ② 显式值让库里"用户选过球面"和"从没选过"在**调试/日志/导出**里可区分，
   *    而二者在**渲染**上必须等价 —— 这一点由 hash 保证，不靠字段值为 None 来表达。
   *
   * 「从非球切回球」的缓存正确性是硬要求：`shapeHashKey()` 对 `'sphere'` 与 `undefined`
   * 都返回空串，所以 `ballHash(slots, params, 'sphere') === ballHash(slots, params)`
   * （`tests/ballShapeEntry.test.ts` 与 `tests/ballParams.test.ts` 各有一份 golden 钉住）。
   * 即：切回球面后期的期望名**逐字符回到历史默认那个**，不会像 plane / roundedBox
   * 那样额外多出一份同形态缓存；`ballStaleNames` 记下的是刚离开的 plane 名，
   * 渲染完按「先建新、再删旧」清掉 → 库里最终只留球面那一份。
   */
  async setRenderShape(assetId, shape) {
    const asset = get().assets.find((a) => a.id === assetId)
    if (!asset) return
    const normalized: BallRenderShape =
      shape === 'plane' || shape === 'roundedBox' ? shape : 'sphere'
    if (resolveRenderShape(asset) === normalized) return

    const oldName = asset.thumbPath
    if (oldName && oldName === wantedBallName(asset)) {
      ballStaleNames.set(asset.id, oldName)
    }

    const updated: Asset = { ...asset, renderShape: normalized, updatedAt: Date.now() }
    commitAsset(set, updated)
    enqueueBallThumb(updated)
  }
}))

/**
 * 整理浮层的待办集（派生数据，**不是 store 状态**）。两个 hook 共用这一份。
 *
 * ## 口径：**全库**的该模式候选（不是"当前筛选结果"）
 *
 * 需求原文是「待办集 = **当前库中** `category1 === 未分类 && category2 === 未分类`
 * 且未软删的资产」。所以这里**不套 `filters`**（搜索词 / 大类 / 分类 / 各种 chip 都不参与）：
 * - 用户点整理时可能正搜着 "wood" 或筛着某个大类，把待办集缩成那几条会让他误以为
 *   "就剩这么点没分类"，整理完一退回来发现还有几百张；
 * - 侧栏「未分类」那个数字本身也是全库口径（`Sidebar` 的 `activeAssets` 只滤软删、
 *   不套筛选）→ 数字与待办集数量必须对得上，否则点进去就看到两个不同的数。
 *
 * **但顺序跟随当前排序**（需求 2「复用既有排序结果，不要自己另排」）：用 `sortAssets`
 * 走同一份 `filters.sort`，用户在中栏头选的是"按体积"，整理模式下"下一张"也按体积走。
 *
 * ## 为什么每帧现算而不是进 store
 *
 * 待办集会随 `assets`（归类 / 删除 / rescan）与 `filters.sort` **任何一个**变化，
 * 把结果缓存进 store 就要在每一处写"更新它"，漏一处就是悬空。现算的代价是
 * `filter + sort`（1 万条约 3ms），而整理浮层一屏只渲一张、每次用户操作才重算一次。
 *
 * ## 为什么两个 hook 都走 `triageQueueOf`（而不是各自写一遍 filter + sort）
 *
 * `openTriage` 判"空不空"用的是同一个函数 —— 若 hook 里另写一遍，就有三套真相：
 * 入口说"有 3 条可以处理"，浮层却渲出 2 条（差在某个边界条件上），用户会以为丢数据。
 * 这个项目为"多处口径不同源"付过代价（见 `logic/triageFlow.ts` 文件头），别再来一次。
 */

/**
 * 未开启时的空队列。**必须是模块级常量**：`useMemo` 每次返回字面量 `[]` 会造新引用，
 * 而 `TriageOverlay` 的 `reconcileTriage(cursor, queue)` 与若干 `useEffect` 依赖 `queue`
 * —— 每次 render 换引用就是每次 render 重跑 effect，轻则白烧 CPU，重则
 * `setCursor` → 重渲 → 新 `[]` → 再 `setCursor` 的死循环。
 */
const NO_TRIAGE_QUEUE: Asset[] = []

/**
 * 「按模式选队列」的纯函数版（`useActiveTriageQueue` 的内核）。
 *
 * `mode === null`（浮层没开）→ **同一个**空数组引用（见 `NO_TRIAGE_QUEUE`）；
 * 否则就是 `triageQueueOf` 的结果。抽出来只为一件事：让这条分支**能被真跑**。
 *
 * 为什么需要它单独存在：`useActiveTriageQueue` 是 hook，在 `environment: 'node'` 下
 * 跑不了（zustand v4 的 `useStore` 把 `getServerSnapshot` 绑在**内部 api** 上，
 * 从外部 `useVault.getServerState = ...` 改不动它，实测三个模式都拿到 `[]`）。
 * 而"未开启时返回空"和"切模式返回对应队列"正是这两条新测试要钉的东西 ——
 * 不能因为 hook 跑不了就不测。
 */
export function activeTriageQueueOf(
  assets: readonly Asset[],
  sort: SortKey,
  mode: TriageMode | null
): Asset[] {
  return mode === null ? NO_TRIAGE_QUEUE : triageQueueOf(assets, sort, mode)
}

/**
 * hook 侧的薄封装：读三个 state，交给纯函数 `activeTriageQueueOf`。
 *
 * `mode === null` 时 `activeTriageQueueOf` 返回**模块级常量** `NO_TRIAGE_QUEUE`
 * （不是每次新造的 `[]`）—— 这一条对 `TriageOverlay` 不是洁癖：它的
 * `reconcileTriage(cursor, queue)` 与若干 `useEffect` 依赖 `queue`，每次 render 换引用
 * 就是每次重跑 effect，轻则白烧 CPU，重则 `setCursor` → 重渲 → 新 `[]` → 再 `setCursor`
 * 的死循环。
 */
function useTriageQueueOf(mode: TriageMode | null): Asset[] {
  const assets = useVault((s) => s.assets)
  const sort = useVault((s) => s.filters.sort)
  return useMemo(() => activeTriageQueueOf(assets, sort, mode), [assets, sort, mode])
}

/**
 * **按当前 `triageMode` 自动选队列** —— `TriageOverlay` 用它，而不是自己二选一。
 *
 * ## 为什么需要它（hooks 不能条件调用的后果）
 *
 * `TriageOverlay` 要按模式渲不同的批次。写成
 * `triageMode === 'conflict' ? useReviewQueue() : useTriageQueue()` 是**非法**的
 * （hooks 数量必须稳定），而"两个都调用再二选一"更糟：`startTriage(queue)` 在首次挂载时
 * 惰性初始化游标，若 queue 取自错的那个，用户一进 conflict 模式看到的是未分类那批。
 *
 * 所以把"选哪个"下沉到 store 层：调用方只调一个 hook，模式从 state 读。
 *
 * @returns `triageMode === null` → 空数组（浮层没开，不该有队列，也不该有游标）；
 *   否则该模式的队列（口径仍然只有 `triageQueueOf` 一份）
 */
export function useActiveTriageQueue(): Asset[] {
  const mode = useVault((s) => s.triageMode)
  return useTriageQueueOf(mode)
}

/** 整理模式的待办集：全库双未分类 + 当前排序 + 非软删。`TriageOverlay` 在 `unclassified` 模式下用它。 */
export function useTriageQueue(): Asset[] {
  return useTriageQueueOf('unclassified')
}

/**
 * 待确认队列：全库 `conflict` 资产 + 当前排序 + 非软删。`TriageOverlay` 在 `conflict` 模式下用它。
 *
 * 与 `useTriageQueue()` **同源**（同一个 `triageQueueOf`）—— 这是侧栏「待确认」数字
 * 与浮层条数能对上的唯一保证，也是本文件不留第二份软删过滤的原因。
 *
 * ⚠️ `TriageOverlay` **不用**这个也不用 `useTriageQueue`，用 `useActiveTriageQueue()`
 * （原因见那个函数的注释）。这两个保留给需要"无视模式、固定拿某一批"的调用方（侧栏计数、
 * 批次汇总 notice）—— 它们不该跟着 `triageMode` 变。
 */
export function useReviewQueue(): Asset[] {
  return useTriageQueueOf('conflict')
}

/** 过滤 + 排序（派生数据，纯函数内核在 logic/filters.ts，可单测） */
export function useVisibleAssets(): Asset[] {
  const assets = useVault((s) => s.assets)
  const filters = useVault((s) => s.filters)
  // 视图决定软删记录的归属：'trash' 只看已删，'assets' 只看未删（唯一过滤点在 matchesFilters）
  const libraryView = useVault((s) => s.libraryView)
  /**
   * 0.6.0 大库性能：`applyFilters` 是纯函数，但**每次 render 都会重跑一遍**。
   * 1 万条资产实测 2.6ms / 次，而选中、hover、开弹窗都会触发 render（App 与 AssetGrid
   * 各订阅一次）—— 一次点击就白烧 5ms 以上，滚起来更明显。
   * 依赖只有这三个引用（`setFilter` 每次造新对象，其余动作不动 filters），memo 命中率高。
   */
  return useMemo(
    () => applyFilters(assets, filters, libraryView),
    [assets, filters, libraryView]
  )
}

/** 当前遗留布局资产数（设置页显示 / 迁移前预检用） */
export function countLegacyLayout(assets: Asset[]): number {
  return assets.filter((a) => isLegacyLayout(a)).length
}

/**
 * 把 AI 补分类**推到当前调用栈之外**执行（docs/15 §7「不阻塞导入」）。
 *
 * 为什么必须是 `setTimeout(0)` 而不是直接 `void runAiClassify()`：
 * 直接调用会同步执行到第一个 `await` 之前的全部代码（筛选资产 + 组装批次），
 * 虽然只有毫秒级，但它坐在**导入的 Promise 链**里；`setTimeout` 让它彻底离开
 * 导入调用栈——导入流程的耗时应与「是否配置 AI」严格无关（可被单测/走查验证）。
 *
 * 双触发（store.importPaths 收尾 + main 的 import:batchDone）都走这里，
 * 由 `aiClassifyRunning` 与「无未分类资产」早退保证不会重复劳动。
 */
function scheduleAiClassify(): void {
  setTimeout(() => {
    void useVault.getState().runAiClassify()
  }, 0)
}

/**
 * 把知末封面抓取**推到当前调用栈之外**执行（docs/24 §3.6）。
 *
 * 与 `scheduleAiClassify` 同一理由与同一写法：抓取是**后置任务**，
 * 不能坐在导入的 Promise 链里（导入耗时必须与"是否开封面抓取"严格无关）。
 *
 * ⚠️ 导入结束的两个触发点（`store.importPaths` 收尾 + main 的 `import:batchDone`）
 * **不再**直接调本函数 —— 它们走 `scheduleZhimoPipeline()`（先站方分类重排、再抓封面，
 * 串行打同一个站）。本函数只剩 `runZhimoCovers` 收尾时的一个用途：
 * 运行期间又导入了新资产（`pendingZhimoIds` 非空）→ 再排一次**仅封面**的补齐。
 * `pendingZhimoIds` 是消费型的（`runZhimoCovers` 里 splice 清空），
 * 第二次拿到空清单 → `pickZhimoCoverTargets` 直接返回空 → 零请求。
 */
function scheduleZhimoCovers(): void {
  setTimeout(() => {
    void useVault.getState().runZhimoCovers()
  }, 0)
}

/**
 * 读「导入后按站方分类自动重排」开关（默认 **true**）。
 *
 * 字段已在 `shared/types.ts` 的 `Settings` 里定稿（`zhimoAutoCategory: boolean`），
 * 这里直接读类型化字段，不再需要可选扩展 / cast。
 * 语义与 `zhimoCover` 一致：只认严格 `false`，缺键 / 脏值一律按开
 * （`normalizeSettings` 已在主进程侧收口，这里再兜一层，防未归一化的对象流进来）。
 */
function zhimoAutoCategoryEnabled(settings: Settings | null): boolean {
  return settings?.zhimoAutoCategory !== false
}

/**
 * 导入批次结束后的**知末后置流水线**：先「站方分类重排」，跑完再「抓封面」。
 *
 * 为什么必须链式、不能像以前那样两个 `schedule*` 同时发起：
 * 两者打的是**同一个站**（`znzmo.com`），并行会让请求量翻倍、更容易被限流 403；
 * 而重排只 GET 详情页（便宜、且是分类的唯一来源），封面要下图片（贵），
 * 所以顺序写死为「重排 → 封面」。
 *
 * 仍然保持 `setTimeout(0)`：整条流水线必须离开导入的 Promise 链
 * （导入耗时不能因为开了这两个开关而增加一毫秒）。
 *
 * 双触发（`store.importPaths` 收尾 + main 的 `import:batchDone`）都走这里，
 * 由各自的模块级重入锁 + 消费型清单保证不会重复劳动。
 *
 * ## 为什么要 `pipelineInFlight`（不能两条都报汇总）
 *
 * 两个触发点几乎同时到：`importPaths` 返回后本函数排一条 `setTimeout(0)`，
 * 紧接着 main 的 `import:batchDone` 又排一条。第一条**真的**去抓详情页（几分钟），
 * 第二条被 `zhimoReclassRunning` / 封面锁**立刻挡掉**、几百毫秒就跑完了 ——
 * 若它到了末尾也调 `reportReviewSummary()`，会在第一条还没累加 `conflicts` 时
 * 就把本批计数**消费掉**（M/K 全是 0 → 不发），于是第一条跑完时已无数字可报，
 * 用户永远看不到「本批 N 个素材，其中 M 个分类存疑」。这是必然路径，不是边角。
 *
 * 所以只让**最后一个退出流水线**的那次汇总（并发时提前退出的那次不报）。
 */
function scheduleZhimoPipeline(): void {
  setTimeout(() => {
    void (async () => {
      pipelineInFlight += 1
      try {
        const state = useVault.getState()
        if (zhimoAutoCategoryEnabled(state.settings)) {
          // 永不抛错（内部兜底）；再 catch 一层只是防将来改坏
          await state.runZhimoCategoryReclass().catch(() => undefined)
        }
        // 重排结束后才抓封面（串行打站）；开关关闭时 runZhimoCovers 自己会早退
        await useVault.getState().runZhimoCovers().catch(() => undefined)
      } finally {
        pipelineInFlight -= 1
      }
      // ★ 批次级「分类存疑」汇总（docs/35 §4.3 入口② / R-11）。
      //   必须在**流水线跑完**才汇总：conflict 只有抓完详情页（T1）之后才知道，
      //   而 `import:batchDone` 在 T0 结束时就到了。
      //   ⚠️ 也只在这里调 —— 挂到 `onImportEvent` 的逐条回调上就是"拖 50 个包弹 50 次"。
      //   ⚠️ 且只在**最后一条**流水线退出时调（见函数头 `pipelineInFlight` 的理由）。
      if (pipelineInFlight === 0) reportReviewSummary()
    })()
  }, 0)
}

/**
 * 遗留布局迁移策略（03 §4.4）：≤ AUTO_MIGRATE_LIMIT 自动搬；
 * 超限只在设置页手动触发（批量搬 GB 级文件必须让用户知情）。
 */
async function maybeAutoMigrate(): Promise<void> {
  const { assets } = useVault.getState()
  const n = countLegacyLayout(assets)
  if (n === 0) {
    useVault.setState({ legacyLayoutCount: 0 })
    return
  }
  if (n <= AUTO_MIGRATE_LIMIT) {
    await useVault.getState().migrateLegacyLayout()
  } else {
    useVault.setState({
      legacyLayoutCount: n,
      notice: `检测到 ${n} 个资产仍是旧版目录结构，请在「设置 → 迁移旧版目录结构」中手动迁移`
    })
  }
}

/**
 * 该资产的材质球槽位；不值得渲球时返回 null。
 *
 * 两道门（2026-10 第 2 轮 QA 实测）：
 * ① 一个槽位都没有 → 素球，无信息量；
 * ② **没有 albedo** → MaterialBall 只会渲出基色灰球（QA 实测 DEF-07：AmbientCG 新版
 *    `Color`、PolyHaven `diff`（旧词表认不出）却仍能认出 roughness/ao → 照样渲球 →
 *    灰球比不渲更糟）。缺 albedo 一律退回封面 / 类型占位。
 */
function ballSlotsOf(asset: Asset): ReturnType<typeof effectiveMaterialSlots> | null {
  // 2026-10-21 用户反馈：「普通贴图的材质球，希望也像材质预设那样有质感」。
  // 改走 `effectiveMaterialSlots`：认不出 PBR 槽位时把**第一张图当 albedo**（与详情面板/舞台
  // 完全同一套兜底口径）。否则「一张 jpg 的贴图资产」永远拿不到球图，网格只能显示
  // 用户当年手动保存的旧封面（旧版相机渲的歪球），新旧观感永远不统一。
  const slots = effectiveMaterialSlots(asset.files)
  if (!slots.albedo) return null
  return hasMaterialSlots(slots) ? slots : null
}

/**
 * 这个资产的球图**应该**叫什么名字（只算名字，不管"该不该有球图"）。
 *
 * ⚠️ **全仓唯一口径**（2026-10 缓存策略）：`ballThumbTarget`、`ballThumbIsFresh`、
 * `enqueueBallThumb`、`isStaleBallThumb`、`renderBallThumbFor`（落盘时传给
 * `saveBallThumb` 的参数）、以及 `persistRenderParams` 的旧名登记，全部走这里。
 *
 * 历史上这里曾出现"四处各自拼 hash"的不一致（渲染用默认参数、判新鲜用当前参数、
 * 落盘用另一套扩展名）→ 结果是"渲染结果与文件名不符"→ 每次启动全库重渲。
 * 名字的构成只有三样东西：槽位集合、非默认参数、非球面形态，三者都由 shared
 * 的 `ballThumbName` 一条路径算出来。
 *
 * @returns 需要渲球时的期望缓存名；`null` = 连槽位都不成立（素球，不该有球图）
 */
export function wantedBallName(asset: Asset): string | null {
  const slots = ballSlotsOf(asset)
  if (!slots) return null
  return ballThumbName(
    asset.id,
    slots,
    resolveRenderParams(asset),
    resolveRenderShape(asset)
  )
}

/**
 * 这个资产的「球图**应该**叫什么」——`null` = 它不该有球图（网格走封面 / 类型占位）。
 *
 * 三道门必须与**入队侧**（`enqueueBallThumb`）和**渲染侧**（`renderBallThumbFor`）
 * 完全一致，否则会出现"缩略图指向一张永远不会被渲出来的球图"：
 * ① 只有 `material` / `texture` 渲球（模型资产即使带贴图也不渲，DEF-08）；
 * ② `coverSource === 'named'`（包内自带官方渲染图）优先官方图，不渲球；
 * ③ 没有 albedo 槽位 → 素球无信息量，不渲（`ballSlotsOf` 的两道门）。
 *
 * ⚠️ **`'manual'` 也必须排除**（2026-10-23 用户反馈修）：用户在「更换封面」里亲手选了
 * 某张图当封面，卡片就必须显示那张——不能被球图顶掉。之前的实现只排除 `'named'`，
 * 于是"选了包内 preview 图当封面、卡片仍是球"（`regenThumbSweep` 走球图分支、
 * 保留 `asset.thumbPath === ball.name`，封面缩略图根本没被生成）。
 * 判据是"用户是否明确指定过封面"，不是"封面好不好看"。
 *
 * 供 `regenThumbSweep` 判定「能不能保住球图」：球图适用的资产在换封面 / 改名 / 分类
 * 迁移时都必须**保留**透明球图，不能被封面缩略图顶掉（2026-10 回归修复）。
 */
export function ballThumbTarget(asset: Asset): { name: string } | null {
  if (asset.kind !== 'material' && asset.kind !== 'texture') return null
  if (asset.cover && (asset.coverSource === 'named' || asset.coverSource === 'manual')) return null
  const name = wantedBallName(asset)
  return name ? { name } : null
}

/**
 * 球图缓存是否已经是"当前槽位 + 当前参数 + 当前形态"的成品（换贴图 / 调参 /
 * 换形态 → hash 变 → 名字变 → 视为未命中）。
 *
 * ⚠️ 导出仅供 `tests/ballCache.test.ts`（docs/12 §6.4）直测——运行时调用路径不变。
 *
 * 2026-10 调参持久化（docs/12 §3.4）：必须传入 `resolveRenderParams(asset)`——
 * 不传则参数永远算默认 hash，网格与调参弹窗显示不一致（§5.1 第 2 条）。
 * 方案 B 下未调参资产的 hash 输入与既有磁盘缓存一致 → 这条判断对历史缓存仍为 true。
 */
export function ballThumbIsFresh(asset: Asset): boolean {
  const want = wantedBallName(asset)
  return !!asset.thumbPath && asset.thumbPath === want
}

/**
 * 材质类资产入队（导入完成 / 首次点开 / 补缺 / 可见升级 / 涓流都走这里）。
 *
 * @returns 是否**真的**入队（调用方据此计数：可见升级的 6 条上限、涓流的 60 条上限）
 */
function enqueueBallThumb(asset: Asset): boolean {
  // 入队闸门 = `ballThumbTarget`（**唯一口径**）：模型资产永不渲球（DEF-08）；
  // 官方渲染图（`'named'`）/ 用户手动封面（`'manual'`）优先，球图不许顶掉；
  // 没有 albedo 槽位的素球不渲。三条门与判新鲜 / 渲染 / 清理侧共用同一份实现，
  // 所以"缩略图指向一张永远不会被渲出来的球图"这类历史 bug 不会再出现。
  //
  // 2026-10-21 用户反馈：**「贴图」类也要渲球**——这一点由 `ballThumbTarget` 的
  // kind 判定（material | texture）承担，这里不再自己写一遍。
  if (ballThumbTarget(asset) === null) return false
  const want = wantedBallName(asset)
  if (!want) return false
  if (asset.thumbPath === want) return false // 缓存命中，网格直接读
  if (ballAttempted.get(asset.id) === want) return false // 同一期望名只试一次（DEF-09）
  if (ballQueue.length >= BALL_THUMB_BATCH) return false
  if (ballQueue.includes(asset.id)) return false
  ballAttempted.set(asset.id, want)
  ballQueue.push(asset.id)
  void runBallQueue()
  return true
}

/** Blob → base64（不含 data: 前缀），给 `thumb:saveBall` 过 IPC 用 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * 单个资产的球图渲染 → 落盘 → 回写索引。
 *
 * 失败路径：**静默降级**（网格走类型占位），并在有封面时回退到普通封面缩略图，
 * 避免"球没渲出来就彻底没图"。整个过程**永不抛**，不阻断任何 UI。
 */
async function renderBallThumbFor(asset: Asset): Promise<void> {
  // 用户拍板（v0.1.2 反馈 #3）：材质封面**优先用包内自带的官方渲染图**
  // （如 Crystal 包的 `*_Preview.png`，落库为 coverSource='named'）。包里已有成品渲染图时
  // 不再渲球顶掉它——官方渲染图观感优于我们的实时球（用户原话「渲染出来非常的油腻」）。
  // 我们的球只在包内**没有任何成品图**时才作为兜底出场。
  if (asset.coverSource === 'named' && asset.cover) return
  const slots = ballSlotsOf(asset)
  if (!slots) return
  const params = resolveRenderParams(asset)
  // 形态必须与"期望文件名"同源：渲的是 plane，落盘名就必须带 plane，
  // 否则 `ballThumbIsFresh` 永远 false → 每次启动都判过期（缓存永不自愈）。
  const shape = resolveRenderShape(asset)
  try {
    // 动态 import：three.js 只在真有材质球要渲时才加载，不拖慢首屏
    const mod = await import('./components/MaterialBall')
    // ⚠️ 既有 bug（docs/12 §0 补充发现）：这里此前不传 params → 落盘的图永远是默认参数，
    // 而 hash（文件名）用的是调参后的值 → 「渲染结果与文件名不符」。必须补 params。
    // 同一个坑在 2026-10 又出现在 shape 上（永远渲球面、名字却按形态算）—— 一并补上。
    //
    // 2026-10 深色主题修复：球图走**透明 PNG**（renderBallToPng）——卡片封面容器是
    // `bg-canvas`，透明像素透出卡片自身的画布色，因此同一个缓存文件在深浅主题下都正确。
    // 若用 JPEG，背景色会被烤进像素（浅色主题渲过的白底图切深色后就是一块白方块）。
    const blob = await mod.renderBallToPng(asset.relFolder, slots, { params, shape })
    const base64 = await blobToBase64(blob)
    if (!base64) return
    const name = await window.modvault
      .saveBallThumb({ assetId: asset.id, slots, params, shape, base64 })
      .catch(() => null)
    if (!name) return
    const current = useVault.getState().assets.find((a) => a.id === asset.id)
    if (!current) return

    // ── §4.2 先建新、再删旧（不能反） ─────────────────────────────
    // 新文件此刻已在磁盘上；网格引用的旧文件在状态切换前始终存在 → 不闪灰格。
    // 只删 `ballStaleNames` 里登记过的名字（确实由球管线产出的旧球图）——
    // 封面 salt（官方渲染图 / 手动封面）不是球图，不能删（§4.1 场景 ①②）。
    const stale = ballStaleNames.get(asset.id)
    if (stale && stale !== name) {
      await window.modvault.deleteOneThumb(asset.id, stale).catch(() => false)
    }
    ballStaleNames.delete(asset.id)

    commitAsset(useVault.setState, {
      ...current,
      thumbPath: name,
      thumbStatus: 'ready', // §4.3：渲染成功才原子更新，中途不置非 ready
      updatedAt: Date.now()
    })
  } catch {
    // 渲染失败：**不删旧球图**（docs/12 §4.2 末段）——`ballStaleNames` 的登记保留，
    // 参数已落库，下次入队重试成功后才删旧；网格此刻仍有图。
    // 无 GPU / 贴图被 CORS 拦 / 上下文创建失败 → 退化为封面缩略图（有封面才有得退）
    if (!asset.cover || asset.thumbStatus === 'ready') return
    const coverAbs = assetFileAbs(asset.folder, asset.cover)
    const thumbPath = await window.modvault.ensureThumb(asset.id, coverAbs).catch(() => null)
    const current = useVault.getState().assets.find((a) => a.id === asset.id)
    if (!current) return
    commitAsset(useVault.setState, {
      ...current,
      thumbPath: thumbPath ?? undefined,
      thumbStatus: thumbPath ? 'ready' : current.thumbStatus,
      updatedAt: Date.now()
    })
  }
}

/** 串行消费球图队列（重入保护：任何时刻只有一个消费者在渲） */
async function runBallQueue(): Promise<void> {
  if (ballQueueRunning) return
  ballQueueRunning = true
  try {
    while (ballQueue.length > 0) {
      const id = ballQueue.shift()
      if (!id) continue
      const asset = useVault.getState().assets.find((a) => a.id === id)
      if (!asset) continue // 等待期间被删
      await renderBallThumbFor(asset)
      // 性能（docs/12 补丁）：逐张之间**主动让路**。
      // 原来是一口气 while 到底：13 张球图 ≈ 13 次离屏渲染 + 13 次 IPC 全挤在一帧里，
      // 用户侧表现就是"刚启动那几秒整个界面木住"。这里每张之间让出一帧 +
      // 有 idle 就用 idle（50ms 上限），保证滚动/悬停始终能插进来。
      await yieldToIdle()
    }
  } finally {
    ballQueueRunning = false
  }
}

/** 让出一帧 / 空闲，供长队列分片（渲染进程没有 requestIdleCallback 时退化为 setTimeout 0） */
function yieldToIdle(): Promise<void> {
  return new Promise((resolve) => {
    // 注意：node 测试环境的 window 是部分桩（没有 setTimeout），所以这里只用全局 setTimeout
    const w = typeof window === 'undefined' ? null : (window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    })
    if (w && typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => resolve(), { timeout: 50 })
    else setTimeout(resolve, 0)
  })
}

/** `assetId → Asset` 惰性索引：`assets` 引用一变就重建（不在每次滚动时 O(n) 扫全库） */
function cachedAssetIndex(): Map<string, Asset> {
  const assets = useVault.getState().assets
  if (assetIndexSource !== assets) {
    assetIndexSource = assets
    const next = new Map<string, Asset>()
    for (const a of assets) next.set(a.id, a)
    assetIndexById = next
  }
  return assetIndexById
}

/**
 * 「名字过期但**文件还在**」的候选（惰性升级的对象）——三条入口共用的唯一视图。
 *
 * 判据刻意要求 `thumbStatus === 'ready'`：这类资产的旧图**确实在磁盘上**，
 * 所以升级过程中卡片一直有图可看（本策略的核心不变量）。
 * `thumbStatus !== 'ready'` / 无 `thumbPath` 的属于"根本没图"，由
 * `ensureMissingBallThumbs` 在启动时补，两者**互斥不重叠**。
 *
 * 索引只在 `assets` 数组引用变化时重建：`commitAsset` 每次都会换引用，
 * 升级完一条自然从候选里消失；滚动 / 悬停不会触发任何全库扫描。
 */
function upgradeCandidates(): Array<{ id: string; want: string }> {
  const assets = useVault.getState().assets
  if (upgradeIndexSource === assets) return upgradeIndex
  upgradeIndexSource = assets
  const next: Array<{ id: string; want: string }> = []
  for (const a of assets) {
    if (!a.thumbPath || a.thumbStatus !== 'ready') continue
    // 与入队侧同一道门（`ballThumbTarget`）：手动封面 / 官方图 / 模型资产不是候选，
    // 否则涓流会永远挑到它们（`enqueueBallThumb` 拒收 → 计数不增 → 空转到天荒地老）。
    const target = ballThumbTarget(a)
    if (!target || target.name === a.thumbPath) continue
    next.push({ id: a.id, want: target.name })
  }
  upgradeIndex = next
  return upgradeIndex
}

/** 从过期候选里挑一条**本会话没试过**的（涓流用；返回 null = 已全部尝试完） */
function pickStaleCandidate(): Asset | null {
  const byId = cachedAssetIndex()
  for (const c of upgradeCandidates()) {
    if (ballQueue.includes(c.id)) continue
    if (ballAttempted.get(c.id) === c.want) continue // 试过（成功会换名，失败也记名）
    const asset = byId.get(c.id)
    if (asset) return asset
  }
  return null
}

/**
 * 停止涓流（导出仅供测试 / 会话收尾；重复调用幂等）。
 *
 * 停掉定时器后**不重置** `staleTrickleProduced`：那样会让"每会话 60 条"的上限失效。
 * 重置由 `resetBallLazyUpgradeForTests` 单独负责。
 */
export function stopStaleTrickle(): void {
  if (staleTrickleTimer !== null) {
    clearTimeout(staleTrickleTimer)
    staleTrickleTimer = null
  }
}

/** 安排下一次涓流（幂等：已有定时器就不重复排） */
function scheduleStaleTrickle(): void {
  if (staleTrickleTimer !== null) return
  if (staleTrickleProduced >= STALE_TRICKLE_SESSION_MAX) return
  const handle = setTimeout(runStaleTrickleTick, STALE_TRICKLE_INTERVAL_MS)
  // node（单测环境）里定时器有 unref：不拖住进程退出；浏览器没有这个字段，可选调用。
  ;(handle as unknown as { unref?: () => void }).unref?.()
  staleTrickleTimer = handle
}

/**
 * 涓流：每 3s 从"名字过期且未尝试过"里挑**1 条**升级，本次会话产满 60 条就停。
 *
 * 三道闸：
 * ① 只在 `ballQueue` **空**时入队（用户滚动触发的可见升级永远优先，涓流不抢）；
 * ② `staleTrickleProduced` 只统计**真的入了队**的（找不到候选 / 已被闸门挡下都不计）；
 * ③ 找不到候选就**让链自然停**（不在空库上空转）；下次 `init` / `rescan` 会重新排。
 */
function runStaleTrickleTick(): void {
  staleTrickleTimer = null
  if (staleTrickleProduced >= STALE_TRICKLE_SESSION_MAX) return
  if (ballQueue.length > 0) {
    scheduleStaleTrickle() // 让路：等队列清空后的那一拍再做
    return
  }
  const next = pickStaleCandidate()
  if (!next) return // 收敛完毕（或全部尝试过）→ 停链
  if (enqueueBallThumb(next)) staleTrickleProduced += 1
  scheduleStaleTrickle()
}

/**
 * **启动 / 重扫**的球图入口：只补「屏幕上根本没图可看」的资产。
 *
 * 与改造前的区别（本次核心）：以前是 `for (const a of assets) enqueueBallThumb(a)`
 * ——遍历全库、把**所有名字过期**的资产一次性排进队列。RENDER_REV +1 或换相机
 * 之后，1 万条资产的库启动就要渲 1 万张球图（用户明确否掉："每一次更新软件都会
 * 全部重新渲染一次我的材质…刚刚启动的压力会非常非常的大"）。
 *
 * 现在只处理两类"真的有洞"的记录：
 * - 没有 `thumbPath`（新导入 / 索引迁移 / 缓存被清）；
 * - `thumbStatus !== 'ready'`（上次没渲成）。
 * 名字过期但**文件还在**的资产 **不入队** —— 交给 `noteVisibleAssets`（看到才升）
 * 与涓流（3s 一条）慢慢收敛；期间卡片一直显示旧球图，绝不出现灰格 / 白球。
 *
 * `BALL_THUMB_BATCH` 仍由 `enqueueBallThumb` 封顶；`ballAttempted` 保证同一期望名
 * 只试一次（断网 / 无 GPU 时不会反复重试）。
 *
 * ⚠️ 导出仅供 `tests/ballLazyUpgrade.test.ts` 断言"过期资产不入队"。
 */
export async function ensureMissingBallThumbs(): Promise<void> {
  const assets = useVault.getState().assets
  for (const a of assets) {
    if (a.thumbPath && a.thumbStatus === 'ready') continue // 有图：即便名字过期也等"被看见"
    enqueueBallThumb(a)
  }
  // 缺图补齐之后，把"慢慢收敛"的兜底链条挂上（幂等：已有定时器不会重复排）。
  scheduleStaleTrickle()
}

/**
 * **可见性上报**：AssetGrid 把这一帧真正渲染出来的卡片 id 报上来，
 * 这里只为「需要球图 + 名字过期」的资产入队升级（每次最多 `VISIBLE_UPGRADE_MAX` 条）。
 *
 * 为什么是这条设计：用户看到的卡片才值得渲。RENDER_REV +1 让全库名字过期时，
 * 首屏只渲当前那几屏；滚动到哪升到哪，升级完的图**立刻**在卡片上出现。
 *
 * 排序与去重：
 * - 入队顺序 = 传入 id 顺序（= 屏幕上从上到下的顺序，先升用户正在看的）；
 * - 已在队列里 / 本会话已试过同一期望名的跳过（不挤占这 6 个名额）；
 * - 每次调用独立计数，滚动节流不必由调用方负责（多报几次也不会雪崩：
 *   第一次入队的 6 条在队列里，后续调用会因为 `ballQueue.includes` 全部跳过）。
 *
 * 传入的 id 找不到（刚被删）静默跳过——这是渲染层与状态的正常竞态。
 */
export function noteVisibleAssets(ids: readonly string[]): void {
  if (!ids || ids.length === 0) return
  const byId = cachedAssetIndex()
  let queued = 0
  for (const id of ids) {
    if (queued >= VISIBLE_UPGRADE_MAX) break
    const asset = byId.get(id)
    if (!asset) continue
    const want = wantedBallName(asset)
    if (!want) continue
    if (asset.thumbPath === want) continue // 已是成品
    if (enqueueBallThumb(asset)) queued += 1
  }
}

/**
 * 重置惰性升级的会话状态（**仅供单测**；运行时没有任何调用点）。
 *
 * 需要它的理由：`staleTrickleProduced` 是"每会话"语义的模块级计数器，
 * 而 vitest 同一个文件里多次 `init` 共用同一个模块实例——不重置就无法断言
 * "首次 60 条、之后停"与"重入幂等"。
 */
export function resetBallLazyUpgradeForTests(): void {
  stopStaleTrickle()
  staleTrickleProduced = 0
  upgradeIndexSource = null
  upgradeIndex = []
  assetIndexSource = null
  assetIndexById = new Map()
  ballQueue.length = 0
  ballQueueRunning = false
  ballAttempted.clear()
}

/**
 * 只看不动的快照（**仅供单测**）：队列里排了谁、本会话尝试过谁。
 *
 * 为什么需要它：入队是**同步**的，渲染是异步的（动态 import + IPC + yield）。
 * 用"渲染被调用了几次"来断言入队，会被计时器和队列消费顺序带偏；
 * `attempted` 在入队那一刻写入、且只在成功/失败后保留，是唯一稳定的观测面。
 */
export function ballQueueSnapshotForTests(): {
  queued: string[]
  attempted: Array<[string, string]>
} {
  return { queued: [...ballQueue], attempted: [...ballAttempted.entries()] }
}

/**
 * 缩略图是否**仍然指向一张"已经不该用"的球图**（2026-10-23 用户反馈）。
 *
 * 场景：用户在「更换封面」里亲手选了某张图（`coverSource='manual'`），
 * 但库里存的 `thumbPath` 还是旧的球图名 → 卡片继续显示球。
 * 判据（三条同时成立才算）：
 * ① 有封面且缩略图已就绪；
 * ② `ballThumbTarget()` 现在返回 null（用户指定过封面 / 官方预览 / 非材质类）；
 * ③ `thumbPath` **恰好等于**该资产当前的球图名（精确比对，不能用前缀猜——
 *    封面缩略图也是 `<id>-<hash>.png`，前缀一致）。
 *
 * 导出仅供测试与 `repairStaleBallThumbs()` 使用。
 */
export function isStaleBallThumb(asset: Asset): boolean {
  if (!asset.cover || asset.thumbStatus !== 'ready' || !asset.thumbPath) return false
  if (ballThumbTarget(asset) !== null) return false
  // 名字口径统一走 `wantedBallName`（含形态）——四处分头拼 hash 是历史 bug 根源。
  return asset.thumbPath === wantedBallName(asset)
}

/** 每次启动最多修几条（正常只会有个位数，封顶防病态库把启动拖慢） */
const REPAIR_THUMB_BATCH = 40
const ballRepairAttempted = new Set<string>()

/**
 * 修「封面已被用户指定、缩略图却还是旧球图」的存量记录（只跑一次/启动，幂等）。
 *
 * 为什么需要它：`ballThumbTarget()` 的修复只影响**以后**的 `setCover`；
 * 用户库里已经存着"球图名"的记录不会自己变，重开还是看到球——等于没修。
 *
 * 走 `regenThumbSweep` 而不是 `ensureThumb`：前者会先清掉该资产的旧缩略图
 * （这里球图已不该用，通配删是安全的），保证磁盘上不留孤儿文件。
 */
export async function repairStaleBallThumbs(): Promise<number> {
  const pending = useVault
    .getState()
    .assets.filter((a) => isStaleBallThumb(a) && !ballRepairAttempted.has(a.id))
    .slice(0, REPAIR_THUMB_BATCH)
  let repaired = 0
  for (const a of pending) {
    ballRepairAttempted.add(a.id)
    // 等待期间可能被删 / 被重新设封面 → 复核一次
    const current = useVault.getState().assets.find((x) => x.id === a.id)
    if (!current || !current.cover || !isStaleBallThumb(current)) continue
    const coverAbs = assetFileAbs(current.folder, current.cover)
    const next = await regenThumbSweep(current.id, coverAbs).catch(() => null)
    if (!next) continue
    const latest = useVault.getState().assets.find((x) => x.id === a.id)
    if (!latest) continue
    const updated: Asset = { ...latest, thumbPath: next.thumbPath, thumbStatus: next.thumbStatus }
    void db.assets.put(updated)
    useVault.setState({ assets: useVault.getState().assets.map((x) => (x.id === updated.id ? updated : x)) })
    repaired += 1
  }
  return repaired
}

/**
 * 后台补齐缺缩略图的资产：选 `有封面但 thumbStatus !== 'ready'` 的前 N 条，
 * 串行调用主进程 ensureThumb（缩略图生成是 CPU + IO 活，并发没有收益）。
 * 已失败过的 id 本会话内不再重试（防止坏图死循环）。
 *
 * 2026-10：`ballThumbIsFresh` 的资产跳过——它的缩略图是**材质球**（用户拍板
 * 的网格形态），不能被封面缩略图覆盖回去。
 *
 * ⚠️ 导出仅供 `tests/ballCache.test.ts`（docs/12 §6.4）验证 §4.3 竞态守卫——
 * 运行时调用路径不变（init / rescan 仍是 `void ensureMissingThumbs()`）。
 */
export async function ensureMissingThumbs(): Promise<void> {
  // 一轮只处理 120 条（防打爆 IPC），但**跑完要接力**：直到没有候选或本轮零进展。
  // 见 `ENSURE_THUMB_MAX_ROUNDS` 的注释（重装后几百张缺图不该只补前 120 张）。
  for (let round = 0; round < ENSURE_THUMB_MAX_ROUNDS; round += 1) {
    const fixed = await runThumbBatch()
    if (fixed === 0) return
    // 让出主线程再跑下一轮：一轮 120 张的解码已经够久，别把首屏交互堵住
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 16)
    })
  }
}

/**
 * 补齐队列的**一轮**：返回本轮真正写成 `ready` 的条数（0 = 没有候选 / 全失败）。
 *
 * 拆出来只为让 `ensureMissingThumbs` 能判断"要不要接力"，判据不重复写两遍。
 */
async function runThumbBatch(): Promise<number> {
  const store = useVault
  let fixed = 0
  const candidates = store
    .getState()
    .assets.filter(
      (a) =>
        a.cover &&
        a.thumbStatus !== 'ready' &&
        !ballThumbIsFresh(a) &&
        !thumbAttempted.has(a.id)
    )
    .slice(0, ENSURE_THUMB_BATCH)
  for (const a of candidates) {
    // 每轮重新读最新状态：可能在等待期间被删除 / 手动换封面
    const current = store.getState().assets.find((x) => x.id === a.id)
    if (!current || !current.cover || current.thumbStatus === 'ready') continue
    thumbAttempted.add(a.id)
    const coverAbs = assetFileAbs(current.folder, current.cover)
    const thumbPath = await window.modvault.ensureThumb(a.id, coverAbs).catch(() => null)
    const state = store.getState()
    const latest = state.assets.find((x) => x.id === a.id)
    if (!latest) continue // 等待期间被删
    // DEF-10：写回前**再复核一次**球图状态。入队筛选时判过一次，但 ensureThumb
    // 是异步的，期间球队列可能刚好渲完并写回 thumbPath；不复核就会把封面缩略图
    // 盖回球图之上（用户拍板：材质类网格走球图）。
    if (ballThumbIsFresh(latest)) continue
    const updated: Asset = {
      ...latest,
      thumbPath: thumbPath ?? undefined,
      thumbStatus: thumbPath ? 'ready' : latest.thumbStatus
    }
    void db.assets.put(updated)
    store.setState({ assets: state.assets.map((x) => (x.id === a.id ? updated : x)) })
    if (updated.thumbStatus === 'ready') fixed += 1
  }
  return fixed
}
