import { create } from 'zustand'
import { useMemo } from 'react'
import { db, type IndexBackup } from './db'
import type {
  Asset,
  AssetFile,
  ColorTag,
  FetchZhimoCoverResult,
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
  snapshotFilters,
  type Filters,
  type LibraryView
} from './logic/filters'
import { dedupeIds, pruneToVisible, selectRangeIds } from './logic/selection'
import { isDeletedAsset } from './logic/trashView'
import { assetFileAbs } from './logic/assetPath'
import { DELETE_GRACE_MS, toDeleteTargets, type DeleteTarget } from './logic/deleteFlow'
import { isLegacyLayout, planLegacyMoves, categoriesOf } from './logic/category'
import { reconcile, type ReconcileReport } from './logic/reconcile'
import {
  ASSIGN_GRACE_MS,
  buildAssignUndo,
  categoryPairLabel,
  groupAssignUndo,
  type AssignUndoRecord
} from './logic/dragAssign'
import {
  ballThumbName,
  effectiveMaterialSlots,
  hasMaterialSlots
} from './logic/materialBall'
import {
  normalizeParams,
  paramsKey,
  resolveRenderParams,
  type BallParamScales
} from '../shared/ballParams'
import { withAssetCoverLock } from './logic/coverLock'
import {
  pickZhimoCoverTargets,
  runZhimoCoverQueue,
  zhimoCoverFailText,
  type ZhimoCoverQueueResult,
  type ZhimoCoverTarget
} from './logic/zhimoCover'
import { resolveZhimoStyle } from './logic/zhimoStyle'

export type { Filters, SortKey, KindFilter } from './logic/filters'

/** 本会话已尝试过生成缩略图且失败的资产 id（防止网格反复触发同一个失败的 ensureThumb） */
const thumbAttempted = new Set<string>()

/** rescan / init 后批量补缩略图的单轮上限（防止大库一次性打爆 IPC 与 CPU） */
const ENSURE_THUMB_BATCH = 120

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
 * `pendingZhimoIds`：本次导入批次里**可能是目标**的资产 id（只收 model + 能取到知末 ID 的：
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
  if (asset.kind !== 'model') return
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


/** 删除流程阶段：`confirming`=待二次确认；`grace`=已确认、5 秒撤销倒计时中 */
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
  graceMs: number
  /**
   * 确认框里的额外警示（v0.4 重复资产：「体积差异较大，请先确认是同一套资产」）。
   * 普通删除不传 → 确认框保持原样。
   */
  warning?: string
  /** 用户确认后要落的轻提示（v0.4 重复资产：「已移入回收站，5 秒内可撤销」） */
  notice?: string
}

/** `requestDelete` 的可选参数（只有「保留这份」这类批量清理场景需要） */
export interface RequestDeleteOptions {
  /** 二次确认框里的额外红色警示行 */
  warning?: string
  /** 确认（进入 5 秒宽限期）后展示的轻提示 */
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
   * 进入终态（done / error）的**绝对时间戳**；进行中为 undefined。
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
   * 自动抓取（导入后由 `scheduleZhimoCovers()` 触发）**与手动抓取共用的唯一入口**。
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
   * 撤销**最近一次**重跑分类：把备份里的资产按原 `category1/category2` 搬回。
   *
   * - 同样走 `assignCategory`（不自己写移动逻辑）；原值是 `未分类` 就搬回双哨兵目录；
   * - 资产在当前索引里已不存在（被删了）→ 跳过并计入 `failed`；
   * - 没有 `reclass-*` 备份 → `{ restored: 0, failed: 0 }`，只给一句 notice，**不报错**；
   * - 备份在还原成功后即删除（"撤销"是消费型操作，避免无限撤销到更早状态）。
   */
  undoLastReclassify: () => Promise<ReclassUndoSummary>
  /** 刷新「可撤销的重跑备份」条数（设置页打开时 / 重跑或撤销完成后调用） */
  refreshReclassBackupCount: () => Promise<void>
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
  coverAbs: string
): Promise<{ thumbPath?: string; thumbStatus: ThumbStatus }> {
  const first = await window.modvault.ensureThumb(id, coverAbs).catch(() => null)
  if (!first) return { thumbStatus: 'none' }

  const asset = useVault.getState().assets.find((a) => a.id === id)
  const ball = asset ? ballThumbTarget(asset) : null

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
  const thumb = await regenThumbSweep(id, assetFileAbs(asset.folder, rel))

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

/** 取 `rescan-*` 备份，按时间降序（最新在前） */
async function listRescanBackups(): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all.filter((b) => typeof b.id === 'string' && b.id.startsWith('rescan-')).sort((a, b) => b.at - a.at)
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

// ── 重跑自动分类：移动前备份（v1.0.13） ─────────────────────────────

/** 取 `reclass-*` 备份，按时间降序（最新在前） */
async function listReclassBackups(): Promise<IndexBackup[]> {
  const all = await db.backups.toArray()
  return all
    .filter((b) => typeof b.id === 'string' && b.id.startsWith('reclass-'))
    .sort((a, b) => b.at - a.at)
}

/**
 * 重跑分类**移动前**的还原凭证。
 *
 * 必须在任何 `assignCategory` 之前调用：目录一旦搬走，原 `folder` 只存在于这份 json 里
 * （就像重扫前备份的意义一样——磁盘上没有"它原来在哪"的副本）。
 * 只保留最近 `RECLASS_BACKUP_KEEP` 条 `reclass-*`。
 */
async function backupReclassMoves(records: ReclassRecord[]): Promise<void> {
  if (records.length === 0) return
  const at = Date.now()
  await db.backups.put({ id: `reclass-${at}`, at, json: JSON.stringify(records) })
  const list = await listReclassBackups()
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
      notice: `检测到 ${info.count} 个资产仍在旧「贴图 / 材质预设」目录下，请在「设置 → 库与分类 → 材质大类合并」中手动合并`
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
  categoryPickerIds: null,
  renameIds: null,
  folderViewAssetId: null,
  hdrPreviewAssetId: null,
  dupOnly: false,
  libraryView: 'assets',

  async init() {
    const [settings, assets] = await Promise.all([
      window.modvault.getSettings(),
      db.assets.toArray()
    ])
    set({ settings, assets, ready: true })

    // 知末 ID 一次性回填（0.6.3）：老索引记录没有 `zhimoId` → 从资产名/包内文件补算。
    // 纯幂等：算不出就不写库，已回填过的记录下次启动直接跳过。失败不影响启动（catch 吞掉）。
    void backfillZhimoIds().catch(() => 0)

    // 可恢复的重扫备份条数（设置页按钮可用性；只读）
    void get().refreshRescanBackupCount()

    // 清理孤儿缩略图缓存（索引里已不存在的 id），失败静默
    window.modvault.pruneThumbs(assets.map((a) => a.id)).catch(() => 0)
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
      // 知末封面（docs/24，T-04）：同一时机、同样 `setTimeout(0)`，绝不 await
      scheduleZhimoCovers()
    })

    window.modvault.onImportEvent((ev) => {
      // 终态（done / error）记下**绝对时间戳**：ImportQueue 的自动消失倒计时以它为起点，
      // 悬停暂停 / 恢复、重建 timer 都不会重新计时（见 logic/importText.ts）。
      const settled = ev.status === 'done' || ev.status === 'error'
      set((s) => ({
        imports: [
          ...s.imports.filter((i) => i.item !== ev.item),
          {
            item: ev.item,
            itemName: ev.itemName,
            status: ev.status,
            message: ev.message,
            asset: ev.asset,
            needBytes: ev.needBytes,
            freeBytes: ev.freeBytes,
            settledAt: settled ? Date.now() : undefined
          }
        ]
      }))
      if (ev.status === 'done' && ev.asset) {
        void db.assets.put(ev.asset)
        set((s) => ({ assets: upsert(s.assets, ev.asset!) }))
        // 导入完成后才渲球图（**不阻塞导入进度条**）：入队即返回，后台串行消费
        enqueueBallThumb(ev.asset)
        // 知末封面：只收 model + 名字里有 ID 的（材质/贴图不做，docs/24 口径 #8）
        enqueueZhimoCover(ev.asset)
      }
    })
  },

  setFilter: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),

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
    set((s) => ({
      libraryView: view,
      selectedId: null,
      selectedIds: [],
      lastClickedId: null,
      folderViewAssetId: null,
      dupOnly: view === 'trash' ? false : s.dupOnly
    })),

  // 首次点开该资产且球图缓存未命中 → 后台渲一张（网格/详情共用这张缓存图）
  select: (id) => {
    set({ selectedId: id, selectedIds: id ? [id] : [], lastClickedId: id })
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
      return { selectedIds, selectedId, lastClickedId: id }
    }),

  // 整批选中：重复组标题行点击 → 组内全部进入多选（批量删除 / 批量指派可直接用）。
  // 普通 `select` 会清空多选，所以这里必须走独立入口。
  selectMany: (ids) => {
    const next = dedupeIds(ids)
    set({ selectedIds: next, selectedId: next[0] ?? null, lastClickedId: next[0] ?? null })
  },

  // 全选当前可见结果（Ctrl/Cmd+A / 中栏头「全选」）；空数组 = 取消全选
  selectAll: (ids) => {
    const next = dedupeIds(ids)
    set({ selectedIds: next, selectedId: next[0] ?? null, lastClickedId: next[0] ?? null })
  },

  // Shift+点击的范围选择（区间顺序 = 可见顺序，含两端）
  selectRange: (anchorId, targetId, visibleIds) => {
    const next = selectRangeIds(anchorId, targetId, visibleIds)
    set({
      selectedIds: next,
      // target 不可见时 next 为空 → 详情面板同时清空，不留下"选中了看不见的东西"的错觉
      selectedId: next.length > 0 ? targetId : null,
      lastClickedId: targetId
    })
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
      return {
        selectedIds: next,
        selectedId: s.selectedId && keep.has(s.selectedId) ? s.selectedId : (next[0] ?? null),
        lastClickedId: s.lastClickedId && keep.has(s.lastClickedId) ? s.lastClickedId : null
      }
    }),

  async importPaths(paths) {
    if (paths.length === 0) return
    set((s) => ({
      imports: [
        ...paths.map((p) => ({ item: p, itemName: p.split(/[\\/]/).pop() ?? p, status: 'pending' as const })),
        ...s.imports
      ]
    }))
    await window.modvault.importPaths(paths)
    // 导入批次结束 → 后台补分类（docs/15 §7）。
    // ⚠️ `scheduleAiClassify` 只是 `setTimeout(..., 0)`，**没有 await 任何网络请求**：
    // 导入动作的耗时不因配置了 AI 而增加一个毫秒（main 侧也会推 import:batchDone，双保险）。
    scheduleAiClassify()
    // 同上：知末封面是**后置任务**，不在导入链路上（双触发由 pending 清空 + 重入锁去重）
    scheduleZhimoCovers()
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
        graceMs: DELETE_GRACE_MS,
        warning: opts?.warning,
        notice: opts?.notice
      }
    })
  },

  /** 第二步：用户确认 → 进入 5 秒撤销宽限期。**此时文件仍在磁盘上**（这正是 undo 可行的前提）。 */
  confirmDelete() {
    const p = get().pendingDelete
    if (!p || p.stage !== 'confirming') return
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
        return {
          assets: s.assets.filter((a) => !removedIds.has(a.id)),
          selectedId: s.selectedId && removedIds.has(s.selectedId) ? null : s.selectedId,
          selectedIds: s.selectedIds.filter((id) => !removedIds.has(id)),
          // 正看着的资产被删掉了 → 退回网格，否则中栏会停在「找不到该资产」的空视图
          folderViewAssetId:
            s.folderViewAssetId && removedIds.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
          notice:
            failed.length > 0
              ? `已删除 ${removed.length} 个；${failed.length} 个失败（文件可能被占用），已保留`
              : s.notice
        }
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
      return {
        // 原地替换成带 deletedAt/trashRel 的记录：资产仍在 `assets` 里（回收站要能列出来），
        // 只是 `applyFilters(..., 'assets')` 会把它排除掉。
        assets: s.assets.map((a) => patched.get(a.id) ?? a),
        selectedId: s.selectedId && movedIds.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !movedIds.has(id)),
        folderViewAssetId:
          s.folderViewAssetId && movedIds.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
        notice:
          res.failed.length > 0
            ? `已移入「最近删除」${updated.length} 项；${res.failed.length} 项失败（文件可能被占用），已保留在原位置`
            : `已移入「最近删除」（左侧栏可还原）`
      }
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
      return {
        assets: s.assets.filter((a) => !gone.has(a.id)),
        selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
        folderViewAssetId:
          s.folderViewAssetId && gone.has(s.folderViewAssetId) ? null : s.folderViewAssetId,
        notice:
          failedIds.size > 0
            ? `已彻底删除 ${purgedIds.length} 项；${failedIds.size} 项失败（文件可能被占用），可重试`
            : `已彻底删除 ${purgedIds.length} 项`
      }
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
      return {
        assets: s.assets.filter((a) => !gone.has(a.id)),
        selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
        notice:
          failedIds.size > 0
            ? `已清空 ${victimIds.length} 项；${failedIds.size} 项失败（文件可能被占用）`
            : `已清空回收站（${victimIds.length} 项）`
      }
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
          notice: `检测到 ${result.count} 个资产的旧大类目录待合并，请在「设置 → 库与分类 → 材质大类合并」中手动合并`
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
    const localByFolder = new Map(localAssets.map((a) => [a.folder, a]))

    // ── C 线「最近删除」：软删记录保活 ──────────────────────────────
    // main 的 rescan **明确跳过 `.trash`**（isLibraryTrashName），软删资产的目录
    // 永远不会出现在 scanned 里。若按普通记录走，任何一次重扫都会把它们判成
    // "磁盘已删除" → 写备份 + 清出索引 → 回收站凭空消失、用户再也还原不了。
    // 因此：先摘出来（不参与 gone 判定），合并完再原样放回 merged。
    const trashedRecords = localAssets.filter((a) => isDeletedAsset(a))
    for (const a of trashedRecords) localByFolder.delete(a.folder)

    const merged: Asset[] = []
    const goneIds: string[] = []
    for (const s of scanned) {
      const local = localByFolder.get(s.folder)
      if (local) {
        localByFolder.delete(s.folder)
        // 主进程 rescan 会把 thumbPath 置空；本地已有缩略图且封面未变时沿用缓存文件
        //（缩略图文件名 = id + cover salt，封面没变就仍然有效，无需重新生成）
        const keepThumb =
          local.thumbStatus === 'ready' && !!local.thumbPath && !!local.cover && local.cover === s.cover
        // 手动封面 / 知末封面都是"用户显式指定或抓来的"，rescan 不得覆盖
        //（仅当文件仍在 index 的文件清单里时保留；文件被删了就如实回落到扫描值）。
        // ⚠️ 漏掉 'zhimo' 会让抓到的封面在下次「重新扫描库」时被 SKP 内嵌灰图打回
        //    —— 这是本项目最容易漏的一处（docs/24 §4.9）。
        const keepStickyCover =
          (local.coverSource === 'manual' || local.coverSource === 'zhimo') &&
          !!local.cover &&
          s.files.some((f) => f.rel === local.cover)
        merged.push({
          ...s,
          id: local.id,
          tags: local.tags,
          note: local.note,
          source: local.source || s.source,
          importedAt: local.importedAt,
          // 分类以磁盘目录名为准（rescan 的权威语义），本地记录不覆盖
          cover: keepStickyCover ? local.cover : s.cover,
          coverSource: keepStickyCover ? local.coverSource : s.coverSource,
          thumbPath: keepThumb ? local.thumbPath : undefined,
          thumbStatus: keepThumb ? 'ready' : s.thumbStatus,
          // 知末 ID（0.6.3）：本地记录已有值就**原样保留** —— 导入时从压缩包名解析出的 ID
          // 是磁盘上再也找不回来的信息（包已处置）；只有本地为空时才用磁盘扫描值兜底。
          zhimoId: local.zhimoId || s.zhimoId
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
    if (!force && goneIds.length > 10 && goneIds.length / localAssets.length > 0.5) {
      set({
        notice: `重扫已中止：本次扫描将删除 ${goneIds.length}/${localAssets.length} 个资产（超过一半），索引未改动。请确认库目录是否正确；若确认要清空，请到「设置 → 导入 → 强制重扫」。`
      })
      return { aborted: 'mass-delete', scanned: scanned.length, removed: 0 } satisfies RescanOutcome
    }

    // ── 安全网 ③：真删之前先把**完整记录**写进 backups（tags/note/styles 只在这里有副本） ──
    if (goneIds.length > 0) {
      await backupRescanDeletions(goneRecords)
      await db.assets.bulkDelete(goneIds)
    }
    await db.assets.bulkPut(merged)
    const rescanBackupCount = (await listRescanBackups()).length
    // 文件视图看着的资产可能在重扫中消失（目录被删 / 被重建换 UUID）→ 退回网格
    const viewedId = get().folderViewAssetId
    set({
      assets: merged,
      rescanBackupCount,
      folderViewAssetId: viewedId && merged.some((a) => a.id === viewedId) ? viewedId : null
    })
    window.modvault.pruneThumbs(merged.map((a) => a.id)).catch(() => 0)
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
        return { assets: [...addedAssets, ...kept] }
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
   * 撤销最近一次重跑分类（v1.0.13）。
   *
   * 依据 `reclass-*` 备份里记录的**原分类对**搬回（原值是 `未分类` 就搬回双哨兵目录），
   * 同样走 `assignCategory`。索引里已不存在的资产（用户删了）跳过并计入 `failed`。
   * 还原成功后**删除该备份**——"撤销"是消费型操作，否则按钮会永远亮着且行为不可预期。
   */
  async undoLastReclassify() {
    if (reclassifyRunning) return { restored: 0, failed: 0 }

    const backups = await listReclassBackups().catch(() => [] as IndexBackup[])
    const last = backups[0]
    if (!last) {
      set({ notice: '没有可撤销的重跑记录' })
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
      await get()
        .refreshReclassBackupCount()
        .catch(() => undefined)
      set({ notice: '重跑备份内容不可用，已清理' })
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

    await get()
      .refreshReclassBackupCount()
      .catch(() => undefined)
    set({ notice: `已还原 ${restored} 个资产（${failed} 个失败）` })
    return { restored, failed }
  },

  /** 刷新「可撤销的重跑备份」条数（设置页打开时 / 重跑或撤销完成后调用） */
  async refreshReclassBackupCount() {
    const list = await listReclassBackups().catch(() => [] as IndexBackup[])
    set({ reclassifyBackupCount: list.length })
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
    const oldSlots = ballSlotsOf(asset)
    const oldName = asset.thumbPath
    if (
      oldName &&
      oldSlots &&
      oldName === ballThumbName(asset.id, oldSlots, resolveRenderParams(asset))
    ) {
      ballStaleNames.set(asset.id, oldName)
    }

    const updated: Asset = { ...asset, renderParams: normalized, updatedAt: Date.now() }
    commitAsset(set, updated)
    enqueueBallThumb(updated)
  }
}))

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
 * 双触发（`store.importPaths` 收尾 + main 的 `import:batchDone`）都走这里：
 * `pendingZhimoIds` 是消费型的（`runZhimoCovers` 里 splice 清空），
 * 第二次调用拿到空清单 → `pickZhimoCoverTargets` 直接返回空 → 零请求。
 */
function scheduleZhimoCovers(): void {
  setTimeout(() => {
    void useVault.getState().runZhimoCovers()
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
 * 这个资产的「球图**应该**叫什么」——`null` = 它不该有球图（网格走封面 / 类型占位）。
 *
 * 三道门必须与**入队侧**（`enqueueBallThumb`）和**渲染侧**（`renderBallThumbFor`）
 * 完全一致，否则会出现"缩略图指向一张永远不会被渲出来的球图"：
 * ① 只有 `material` / `texture` 渲球（模型资产即使带贴图也不渲，DEF-08）；
 * ② `coverSource === 'named'`（包内自带官方渲染图）优先官方图，不渲球；
 * ③ 没有 albedo 槽位 → 素球无信息量，不渲（`ballSlotsOf` 的两道门）。
 *
 * 供 `regenThumbSweep` 判定「能不能保住球图」：球图适用的资产在换封面 / 改名 / 分类
 * 迁移时都必须**保留**透明球图，不能被封面缩略图顶掉（2026-10 回归修复）。
 */
function ballThumbTarget(asset: Asset): { name: string } | null {
  if (asset.kind !== 'material' && asset.kind !== 'texture') return null
  if (asset.coverSource === 'named' && asset.cover) return null
  const slots = ballSlotsOf(asset)
  if (!slots) return null
  return { name: ballThumbName(asset.id, slots, resolveRenderParams(asset)) }
}

/**
 * 球图缓存是否已经是"当前槽位 + 当前参数"的成品（换贴图 / 调参 → hash 变 →
 * 名字变 → 视为未命中）。
 *
 * ⚠️ 导出仅供 `tests/ballCache.test.ts`（docs/12 §6.4）直测——运行时调用路径不变。
 *
 * 2026-10 调参持久化（docs/12 §3.4）：必须传入 `resolveRenderParams(asset)`——
 * 不传则参数永远算默认 hash，网格与调参弹窗显示不一致（§5.1 第 2 条）。
 * 方案 B 下未调参资产的 hash 输入与既有磁盘缓存一致 → 这条判断对历史缓存仍为 true。
 */
export function ballThumbIsFresh(asset: Asset): boolean {
  const slots = ballSlotsOf(asset)
  if (!slots) return false
  return (
    !!asset.thumbPath &&
    asset.thumbPath === ballThumbName(asset.id, slots, resolveRenderParams(asset))
  )
}

/** 材质类资产入队（导入完成 / 首次点开 / init 与 rescan 后的全量补齐都走这里） */
function enqueueBallThumb(asset: Asset): void {
  // DEF-08（QA 第 2 轮严重缺陷）：模型资产**永不渲球**。
  // 模型资产即使附带 PBR 贴图（如 .skp + Textures/wood_{Diffuse,Normal}.jpg）也不渲——
  // 否则球图会顶掉刚提取出来的 SKP 内嵌预览（封面又变回看不见模型）。
  //
  // 2026-10-21 用户反馈：**「贴图」类也要渲球**。原先这里只放 `material`，导致贴图资产的
  // 卡片只能沿用资产目录里的 `*.cover.jpg`（用户当年手动保存的旧封面，旧版相机渲的歪球），
  // 而旧封面的缓存键不含渲染器版本、永远刷不掉，同一屏里两种观感永远统一不了。
  // 现在贴图与材质预设走同一条球图管线；`coverSource === 'named'`（包内自带官方预览）仍由
  // `renderBallThumbFor` 提前返回，官方图优先的口径不变。
  if (asset.kind !== 'material' && asset.kind !== 'texture') return
  const slots = ballSlotsOf(asset)
  if (!slots) return
  if (ballThumbIsFresh(asset)) return // 缓存命中，网格直接读
  const want = ballThumbName(asset.id, slots, resolveRenderParams(asset))
  if (ballAttempted.get(asset.id) === want) return // 同一期望名只试一次（DEF-09）
  if (ballQueue.length >= BALL_THUMB_BATCH) return
  if (ballQueue.includes(asset.id)) return
  ballAttempted.set(asset.id, want)
  ballQueue.push(asset.id)
  void runBallQueue()
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
  try {
    // 动态 import：three.js 只在真有材质球要渲时才加载，不拖慢首屏
    const mod = await import('./components/MaterialBall')
    // ⚠️ 既有 bug（docs/12 §0 补充发现）：这里此前不传 params → 落盘的图永远是默认参数，
    // 而 hash（文件名）用的是调参后的值 → 「渲染结果与文件名不符」。必须补 params。
    //
    // 2026-10 深色主题修复：球图走**透明 PNG**（renderBallToPng）——卡片封面容器是
    // `bg-canvas`，透明像素透出卡片自身的画布色，因此同一个缓存文件在深浅主题下都正确。
    // 若用 JPEG，背景色会被烤进像素（浅色主题渲过的白底图切深色后就是一块白方块）。
    const blob = await mod.renderBallToPng(asset.relFolder, slots, { params })
    const base64 = await blobToBase64(blob)
    if (!base64) return
    const name = await window.modvault
      .saveBallThumb({ assetId: asset.id, slots, params, base64 })
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

/** init / rescan 后的全量补齐（与 ensureMissingThumbs 同思路：只补缺的，封顶） */
async function ensureMissingBallThumbs(): Promise<void> {
  const assets = useVault.getState().assets
  for (const a of assets) enqueueBallThumb(a)
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
  const store = useVault
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
  }
}
