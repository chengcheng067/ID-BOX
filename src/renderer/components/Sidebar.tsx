import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SAVED_VIEW_LIMIT, useVault } from '../store'
import {
  KIND_LABEL,
  KIND_NAV_ORDER,
  KIND_GROUP_MEMBERS,
  MATERIAL_GROUP,
  kindFilterLabel,
  kindsOfFilter,
  type KindGroup
} from '../../shared/classify'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { countLevel1, countLevel2, duplicatedLevel2Names } from '../logic/category'
import { extraCopyCount, groupDuplicates } from '../logic/duplicates'
import { allViewFilterPatch, isAllViewActive, nextExpandKind } from '../logic/filters'
import { countDeletedAssets, isDeletedAsset } from '../logic/trashView'
import { countPendingReview } from '../logic/reviewFlow'
import { StarIcon } from './MarkControls'
import {
  ASSET_DRAG_MIME,
  hasAssetDragPayload,
  parseDragIds,
  planDropAssign
} from '../logic/dragAssign'
import {
  IconAlert,
  IconBox,
  IconCad,
  IconDownload,
  IconFile,
  IconHdr,
  IconImage,
  IconMaterial,
  IconOther,
  IconSettings,
  IconTrash
} from '../icons'
import type { AssetKind } from '../../shared/types'
import type { DragEvent, SVGProps } from 'react'
import './sidebar-hook.css'

/**
 * 大类 → 图标。
 *
 * ⚠️ 用 `Partial<Record<...>>` 而不是 `Record<...>`：`AssetKind` 是**跨端新增**的类型
 * （2026-11 V1.0 正在加 `d5a`），任何"全量映射"都会在大类新增的那一刻编译失败 ——
 * 而侧栏只需要"有个图标"，缺项回落到 `IconOther` 即可，不必等新图标的作者。
 * 这样并行的 D5A 增量线落地时，侧栏不会成为它的阻塞点。
 */
const KIND_ICON: Partial<Record<AssetKind, typeof IconBox>> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  cad: IconCad,
  other: IconOther
}

/** 侧栏节点 key：单个大类，或「材质」分组哨兵（texture + material 共用一个节点） */
type NavNode = AssetKind | KindGroup

/**
 * 节点 → 计数范围（交给 logic/category 的 KindScope 求和）。
 *
 * ⚠️ 走 `kindsOfFilter` —— **唯一语义入口**，不要在组件里手写成员表：
 * - 「材质」分组 = `{texture, material}`；
 * - 「所有模型」= `{model, d5a}`（2026-11-09 收口：`.d5a` 属于模型的**格式**，
 *   不是独立大类）⇒ 侧栏这个节点的计数与一级分类树自动包含 d5a 资产，
 *   与点进去的网格条数、首页「模型」卡的数字三方一致。
 *
 * 传单个 kind 时 `kindsOfFilter` 返回只含它自己的集合，所以单 kind 节点行为不变。
 */
function scopeOf(node: NavNode | null): AssetKind | readonly AssetKind[] {
  if (!node) return []
  const kinds = kindsOfFilter(node)
  return kinds ? [...kinds] : []
}

// ── 钩线轨道引擎（照 docs/probe/tuneshape/src-hook-sidebar.ts 逐行对齐） ──────
//
// 与参考实现的**一一对应**（行号指 `docs/probe/tuneshape/src-hook-sidebar.ts`）：
//   · `hookPath`       ← 第 23 行 `function path(y, from = 0)`
//   · `hookHoverStart` ← 第 24 行 `function hoverStart(activeY, hoverY)`
//   · `hookSpring`     ← 第 25 行 `function spring(position, velocity, target, dt, durationMs)`
//   · 三条弹簧 / 收敛阈值 / 停帧条件 ← 第 46-59 行（`snap` / `moving` / `wake` / `frame`）
//   · 行中心测量 offsetTop + offsetHeight/2 ← 第 61 行 `measure()`
//   · 强调轨 = `path(selected)`，灰线轨 = `path(hovered, hoverStart(...))` ← 第 41 行 `paint()`
//
// **唯一的有意偏离**：参考的 `H12.5` 是写死的水平段终点（它的列表是扁平的）。
// 本仓的分类树是子层，缩进后标签离轨道更远，所以 `endX` 随层级外扩
// （HOOK_BASE_END_X + 层级 × HOOK_INDENT），让 S 形折线仍然**接到标签**而不是悬在半空。

/** 水平段终点（参考 `H12.5`）：与 `.hook-row` 顶层左内边距 20px 差 7.5px */
const HOOK_BASE_END_X = 12.5
/** 子层每深一级，水平段外扩 12px（与 CSS 里 20 → 32 → 44 的左内边距同增量） */
const HOOK_INDENT = 12
/** 轨道跟随基准（参考 seo-hook-sidebar.html 的 `durationMs: 360`） */
const HOOK_SPRING_MS = 360
/** 灰线显隐响应上限（参考：`Math.min(200, durationMs)`） */
const HOOK_FADE_MS = 200

/**
 * 轨道 path：竖直主线 → 圆角折线 → 水平段接到标签。
 *
 * 逐字照参考：`M.5 ${start} V${end - r} Q.5 ${end} ${r + .5} ${end} H12.5`
 * - `r` 拐角半径（≤6，行高 32 时很"钩"）；
 * - `start` 是本段竖直线的起点：强调轨恒从列表顶（0）起画，
 *   灰线则由 `hookHoverStart` 决定（悬停在选中项上方时只画弯钩）。
 */
function hookPath(endY: number, fromY: number, endX: number): string {
  const end = Math.max(0, endY)
  const r = Math.min(6, end)
  const start = Math.max(0, Math.min(fromY, end - r))
  const y = (v: number): string => v.toFixed(2)
  return `M0.5 ${y(start)} V${y(end - r)} Q0.5 ${y(end)} ${y(r + 0.5)} ${y(end)} H${endX}`
}

/**
 * 灰线起点（参考 `hoverStart`）：悬停项在选中项**下方**时从选中行接出去，
 * 在**上方**时留 6px 只画弯钩 —— 否则灰线会整段盖住强调轨。
 */
function hookHoverStart(activeY: number, hoverY: number): number {
  return hoverY <= activeY ? Math.max(0, hoverY - 6) : activeY
}

/** 弹簧一步（参考 `spring`）：解析解临界阻尼，保留位置与速度 → 打断时可"接续"而不是重起 */
function hookSpring(
  position: number,
  velocity: number,
  target: number,
  dt: number,
  durationMs: number = HOOK_SPRING_MS
): { position: number; velocity: number } {
  const w = 8 / Math.max(0.08, durationMs / 1000)
  const x = position - target
  const b = velocity + w * x
  const e = Math.exp(-w * dt)
  return { position: target + (x + b * dt) * e, velocity: (velocity - w * b * dt) * e }
}

/** 一行在轨道坐标系里的几何：纵向中心 + 该层级的水平段终点 */
interface HookRowGeometry {
  center: number
  endX: number
}

/** 三条弹簧的位姿（强调轨 y / x、灰线 y / x / 不透明度），全部用 ref 存 → 每帧不触发 React 重渲染 */
interface HookPose {
  y: number
  vy: number
  x: number
  vx: number
  hy: number
  hvy: number
  hx: number
  hvx: number
  o: number
  vo: number
}

/**
 * 系统「减少动效」开关（跟着系统设置实时变）。
 *
 * 为什么用 state 而不是每帧 `matchMedia`：轨道在 reduced 下要**直接到位**，
 * 开关变化时必须立刻 `snap()` 一次；用 ref 读的话变化不会驱动任何东西。
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 首页图标（只在本文件用；顶栏 Logo 与它无关，故不放进 icons.tsx） */
const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    <path d="M3.5 10.6 12 3.4l8.5 7.2" />
    <path d="M5.8 9.6V20h12.4V9.6" />
  </svg>
)

/** 展开指示（只有带子层的大类行有；靠 CSS 旋转 90° 表示已展开） */
const IconCaret = (p: SVGProps<SVGSVGElement>) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    <path d="M9.5 5l7 7-7 7" />
  </svg>
)

/**
 * 顶部轨道的内容大类顺序 —— **拍板 §3 钦定**：模型 / 材质 / HDR / CAD。
 *
 * ⚠️ 它与 `shared/classify.KIND_NAV_ORDER`（模型 / CAD / 材质 / HDR / 其他）**不同**：
 * 那边是"大类全集 + 落盘顺序"的唯一权威表，这里是"侧栏顶层的展示顺序"，
 * 两份顺序在 2026-11-09 拍板后被显式分开（拍板把 CAD 放到 HDR 之后、把材质提到第二）。
 * `shared` 未改（跨端共用，且本批文件边界不含它），所以这里用 `filter` 与
 * `KIND_NAV_ORDER` 求交集：**只重排、不新增大类**，将来大类改名/拆分时不会静默丢项。
 */
const RAIL_KIND_SEQUENCE: ReadonlyArray<AssetKind | KindGroup> = [
  'model',
  MATERIAL_GROUP,
  'hdri',
  'cad'
]

const RAIL_KINDS: ReadonlyArray<AssetKind | KindGroup> = RAIL_KIND_SEQUENCE.filter((k) =>
  KIND_NAV_ORDER.includes(k)
)

/**
 * 轨道显示名 —— **拍板 §3 逐字**：模型 →「所有模型」、HDRI →「HDR」、CAD图纸 →「CAD」。
 *
 * ⚠️ 只改**侧栏顶层导航的写法**：`shared/classify.KIND_LABEL` 一个字不动
 * （网格徽标、详情面板、搜索 haystack 都读它），所以别处仍显示「HDRI」/「CAD图纸」。
 * 这是"导航是短语、分类名是名词"的取舍，不是命名漂移 —— 若要统一，得回签 `KIND_LABEL`。
 */
const RAIL_KIND_LABEL: Readonly<Record<string, string>> = {
  model: '所有模型',
  [MATERIAL_GROUP]: '材质',
  hdri: 'HDR',
  cad: 'CAD'
}

/** 轨道项的显示名（缺项回落到 `KIND_LABEL` 那套，避免将来新增大类时是一片空白） */
const railKindLabel = (node: AssetKind | KindGroup): string =>
  RAIL_KIND_LABEL[node] ?? kindFilterLabel(node)

/**
 * 「导航收口」的**纯函数内核**（导出仅为可单测，生产只经 `navTo` 使用）。
 *
 * 先离开文件视图，再执行导航动作；**顺序不可颠倒**——反过来会先按旧筛选渲染一帧，
 * 中栏短暂出现"筛选已经变了、却还盖着文件列表"的错帧。
 *
 * 两个依赖都用参数注入（而不是在这里直接摸 store），node 环境就能用调用数组断言顺序。
 */
export function runNavAction(closeFolderView: () => void, action: () => void): void {
  closeFolderView()
  action()
}

interface SidebarProps {
  onOpenSettings: () => void
  /**
   * 折叠态（可选）：只显示轨道与图标，不显示标签 / 计数。
   *
   * ⚠️ 折叠形态由 `App.tsx` 的 `CollapsibleColumn` 决定，不在本组件里算：
   * 左栏传 `railWidth={isHome ? 0 : SIDEBAR_RAIL_W}`（`SIDEBAR_RAIL_W = 48`），
   * 所以**非首页态折叠后保留 48px 轨道**、内容继续可见（`.is-collapsed` 只留图标）；
   * 首页态与右栏的 `railWidth` 为 0 ⇒ 走 `asRail=false` 分支，整列压成 0 宽并
   * `visibility:hidden`（那是封面页要的效果，不是折叠）。
   *
   * 2026-11-09 复核更正：这段注释此前写着"App 侧需改成 48px —— 本批不动"，
   * 那在写下的当时是对的，但 App 侧后来已经改了（`App.tsx:199` 定义了
   * `SIDEBAR_RAIL_W`、`:1427` 传入）。**别再照着旧注释判断"折叠只剩图标没做"** ——
   * 已做。这条是"注释比代码更让人信"的现成反例，改结论时请顺手改注释。
   */
  collapsed?: boolean
}

/**
 * 左栏库导航（UI 设计规范 v0.2 §3.2，宽 216，底 --bg-sidebar）。
 *
 * 2026-11-09 拍板 §3「主程序 · 侧栏换皮」（照抄 TuneShape Hook Sidebar）：
 * 顶部扁平导航走**钩线轨道**（一条竖直主线 + 选中项一段圆角折线接到标签），
 * 一级 / 二级分类收进「选中内容大类后展开的子层」，展开时沿轨道缩进。
 *
 * 信息架构（拍板 §3：6 内容 + 2 工具）：
 *   首页 · 所有模型 · 材质 · HDR · CAD · 收藏 ＋ 待确认 · 回收站
 * 另有两条**换皮前就存在、且不得删除**的筛选入口，保持原有分组归属，不升为顶层：
 *   ·「其他」大类 —— 原「分类」组末位（兜底桶，0 条且未选中时不占位）；
 *   ·「重复资产」—— 原「整理」组内（v0.4 的换视图入口）。
 * 智能集合 / 标签 / 库 三个既有分组原样保留（保存视图与标签不是"内容大类"）。
 *
 * 分组标题（分类 / 整理 / 智能集合 / 库）保留：轨道从它们左侧穿过，
 * 是一整根不断的线 —— 标题只负责分段，不切断几何。
 *
 * 风格 / 体积 / 时间 / 色标四类筛选入口**不在左栏**（分别在 `App.tsx` 的中栏头），
 * 本批不动；`filters.*` 的读写一行未改，只换呈现。
 */
export function Sidebar({ onOpenSettings, collapsed = false }: SidebarProps) {
  const assets = useVault((s) => s.assets)
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  const settings = useVault((s) => s.settings)
  const importPaths = useVault((s) => s.importPaths)
  // v0.4「重复资产」视图（不放进 Filters：它是视图模式，不是匹配条件）
  const dupOnly = useVault((s) => s.dupOnly)
  const setDupOnly = useVault((s) => s.setDupOnly)
  // C 线「最近删除」：视图切换 + 软删计数
  const libraryView = useVault((s) => s.libraryView)
  const setLibraryView = useVault((s) => s.setLibraryView)
  // 软件内文件视图（docs/15 §6c）：进入后中栏由 `folderAsset` 分支接管（优先于网格）
  const closeFolderView = useVault((s) => s.closeFolderView)
  // 0.6.0 智能集合：保存的筛选视图（settings.savedViews，纯虚拟层）
  // 选择器只取数组本身（不写 `?? []`，否则每次返回新引用），空值在外面兜底。
  const savedViewsOrNull = useVault((s) => s.settings?.savedViews)
  const savedViews = useMemo(() => savedViewsOrNull ?? [], [savedViewsOrNull])
  const applySavedView = useVault((s) => s.applySavedView)
  const deleteSavedView = useVault((s) => s.deleteSavedView)
  const [version, setVersion] = useState('')

  /**
   * 侧栏所有计数都只统计**在库资产**（`deletedAt` 无值）。
   *
   * 为什么必须在这里先剔一次：软删记录仍留在 `store.assets` 里（回收站要能列出来），
   * 若沿用 `assets` 计数，用户删了 3 个模型后左栏「模型」还是原来的数字——
   * 与网格对不上，是最容易被当成 bug 的那种不一致。
   */
  const activeAssets = useMemo(() => assets.filter((a) => !isDeletedAsset(a)), [assets])
  /** 回收站计数（徽标） */
  const trashCount = useMemo(() => countDeletedAssets(assets), [assets])
  /**
   * 回收站模式：仅用来判断「当前视图是不是最近删除」。
   *
   * 2026-10 TODO-6 用户拍板「位置不动，只修交互」：回收站只是一种**当前视图**，
   * 不是「把左栏其它筛选锁死」。此前这块导航整体挂了 `pointer-events-none` + 禁用态，
   * 进回收站后点侧栏任何一处都没反应，只能再点一次「最近删除」才能退出——
   * 现在改为：点任意条目 = 先退出回收站，再应用该条的筛选。
   *
   * 仍然保留的 `trashMode` 用途（逐个都有明确归属，别一刀切删光）：
   * ① 「最近删除」自身的选中态 / `aria-pressed` / 徽标 / toggle 文案（它是唯一切视图的入口）；
   * ② 各筛选条目的**高亮压制**：回收站视图下 `matchesFilters` 只吃搜索词（见 logic/filters.ts），
   *    分类/收藏/标签/色标实际都不生效 → 不能让它们显示成"筛选已生效"，
   *    否则和「最近删除」同时高亮，用户会以为筛选叠在回收站上。
   */
  const trashMode = libraryView === 'trash'

  /**
   * 退出回收站，回到资产视图（左栏**每一个**筛选入口点击时都先走这一步，由 `navTo` 统一调用）。
   *
   * 为什么只在确实是 trash 时才写 store：`setLibraryView` 会顺带清空选择 / 文件视图，
   * 资产视图里无谓地调一次会打断用户正在做的事情。
   * 注意顺序：必须先退视图**再**应用筛选，否则筛选会先落进回收站视图（用户看不到结果）。
   */
  const exitTrash = (): void => {
    if (libraryView !== 'assets') setLibraryView('assets')
  }

  /**
   * 2026-10 用户反馈（第二个 bug）：文件视图打开时，点左栏任何导航项只改了筛选 / 视图，
   * 中栏却仍被 `folderAsset` 分支盖住（`App.tsx` 里文件视图优先于网格）——
   * 用户看到的是「侧栏高亮变了、计数也变了，中心画布纹丝不动」。
   *
   * 收口：**所有**"会把中栏换成另一批资产"的入口统一走 `navTo`：
   * ① 先 `closeFolderView()`（中栏立刻回到网格 / 列表，`folderAsset` 变 null）；
   * ② 再 `exitTrash()`（既有逻辑：回收站是视图不是锁定态）；
   * ③ 最后执行筛选 / 视图变更。
   *
   * `closeFolderView` 本身就是幂等（`set({ folderViewAssetId: null })`），不必先判断是否打开；
   * 顺序由 `runNavAction` 固定（有单测钉住 close 在 action 之前）。
   */
  const navTo = (action: () => void): void => {
    runNavAction(closeFolderView, () => {
      exitTrash()
      action()
    })
  }

  /** 视图切换（「最近删除」）：它自己就是视图入口，**不能**套 `exitTrash`（会先被拉回资产视图） */
  const navToView = (action: () => void): void => {
    runNavAction(closeFolderView, action)
  }

  // ── 反馈 6d：拖拽归类（拖卡片上的「归类抓手」→ 松手在分类节点上） ──
  const assignCategoryWithUndo = useVault((s) => s.assignCategoryWithUndo)
  const setNotice = useVault((s) => s.setNotice)
  /** P2 整理流水线入口（待办集为空时自己给 notice、不开浮层） */
  const openTriage = useVault((s) => s.openTriage)
  /** 待确认队列入口（`docs/35 §4.3 入口①`）：打开浮层的 `conflict` 模式 */
  const openReview = useVault((s) => s.openReview)
  /** 当前高亮的投放节点 key（`l1:<大类>:<一级>` / `l2:<大类>:<一级>/<二级>`）；null = 无 */
  const [dropKey, setDropKey] = useState<string | null>(null)

  useEffect(() => {
    void window.modvault.getAppVersion().then(setVersion).catch(() => undefined)
  }, [])

  // 拖拽在别处结束 / Esc 取消时清掉高亮：`drop` 只在命中节点时触发，
  // 松手在空白处（或按 Esc）只会发 `dragend` → 不监听就会残留高亮。
  useEffect(() => {
    if (!dropKey) return
    const clear = () => setDropKey(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dropKey])

  // 树展开状态：有筛选时默认展开对应层级。
  // 用户反馈第 5 条缺陷 2：首次点击大类必须即展开一级树（此前只有 filters.category1 存在时
  // 才回退到 filters.kind，纯「只筛选」的首次点击不展开）。
  // `nextExpandKind` 是纯函数（logic/filters.ts，可单测）：首次选中 = 展开，
  // 已选中再点 = 折叠（toggle 语义不变）。展开态是**组件内 state**，
  // 换导航项时不清空 `expandL1` 以外的内容 —— 用户折回同一个大类仍是展开的。
  const [expandKind, setExpandKind] = useState<NavNode | null>(null)
  const [expandL1, setExpandL1] = useState<string | null>(null)
  const openKind = expandKind
  const openL1 = expandL1 ?? (filters.category2 ? filters.category1 : null)

  const kindCounts = useMemo(() => {
    const m = new Map<AssetKind, number>()
    for (const a of activeAssets) m.set(a.kind, (m.get(a.kind) ?? 0) + 1)
    return m
  }, [activeAssets])

  /**
   * 节点计数 = 它命中的**全部 kind** 之和。
   *
   * 同样走 `kindsOfFilter`（而不是"分组特判 + 单 kind 查表"）：
   * 「材质」= texture+material（既有口径）、「所有模型」= model+**d5a**（2026-11-09 收口）。
   * 与 `scopeOf` 同源，所以数字和展开后的一级分类树必然对得上。
   */
  const countOf = (n: NavNode): number => {
    const kinds = kindsOfFilter(n)
    if (!kinds) return 0
    let sum = 0
    for (const k of kinds) sum += kindCounts.get(k) ?? 0
    return sum
  }

  // 展开的树按**计数范围**算：分组节点时两类的分类树合并计数（未分类也是一类之和）
  const openScope = useMemo(() => scopeOf(openKind), [openKind])
  const l1Nodes = useMemo(
    () => (openKind ? countLevel1(activeAssets, openScope) : []),
    [activeAssets, openKind, openScope]
  )
  const l2Nodes = useMemo(
    () => (openKind && openL1 ? countLevel2(activeAssets, openScope, openL1) : []),
    [activeAssets, openKind, openL1, openScope]
  )
  // 同（组）大类内多个一级下重名的二级 → 按「一级/二级」完整路径展示（06 §15-④ 实测 8 组重名）
  const dupL2 = useMemo(
    () => (openKind ? duplicatedLevel2Names(activeAssets, openScope) : new Set<string>()),
    [activeAssets, openKind, openScope]
  )

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of activeAssets) for (const t of a.tags) m.set(t, (m.get(t) ?? 0) + 1)
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    // 当前筛中的标签**必须**在列表里：否则它跌出 top12 后入口消失，筛选生效却取消不掉
    //（与「全部」清理列表漏字段是同一类死角，2026-10-30 一并修）
    const picked = filters.tag
    if (picked && !sorted.some(([t]) => t === picked)) {
      const hit = m.get(picked)
      if (hit !== undefined) sorted.push([picked, hit])
    }
    return sorted
  }, [activeAssets, filters.tag])

  /**
   * v0.4 重复资产：徽标数是「多余份数」（Σ 组内份数−1），不是组数——
   * 用户关心的是「有多少份可以清掉」。为 0 时整行禁用（灰、不可点）。
   */
  const dupGroups = useMemo(() => groupDuplicates(activeAssets), [activeAssets])
  const dupExtra = useMemo(() => extraCopyCount(dupGroups), [dupGroups])

  /**
   * 2026-10 用户反馈：收藏 / 重复资产两个入口由设置决定是否显示。
   * 用 `!== false` 而不是 `=== true`：settings 尚未加载（null）时按默认「显示」处理，
   * 避免首屏闪一下再出现。
   * 2026-10-25 反馈：**色标筛选入口已移到中栏头**（与体积 / 时间同族），侧栏不再有这一行。
   */
  const showFavoritesEntry = settings?.showFavorites !== false
  const showDuplicatesEntry = settings?.showDuplicates !== false
  /**
   * 「待确认」计数（`docs/35 §4.3 入口①`）：**全库口径**，不套筛选。
   *
   * 三个口径细节，缺一个就会与浮层对不上：
   * ① 分母是 `activeAssets`（已滤软删）—— `countPendingReview` 自己**不滤软删**
   *    （软删过滤的唯一实现点仍是 `isDeletedAsset`，见 `logic/reviewFlow.ts` 的调用约定）；
   * ② 只取 `.conflict`，**不把 `.unclassified` 加进来**：后者已有「未分类」节点 +
   *    「整理」按钮，混在一起会让两个数字互相污染（同一个资产只属于其中一个，
   *    `reviewReasonOf` 的判定顺序保证互斥）；
   * ③ 不套 `filters`：与侧栏「未分类」那个数字同源（`docs/25` 口径表 ① 号），
   *    否则用户点进去看到的条数和徽标对不上（浮层队列也是全库口径）。
   */
  const conflictCount = useMemo(() => countPendingReview(activeAssets).conflict, [activeAssets])

  /**
   * 「整理」分组标题只在至少一项可见时渲染（不留空标题）。
   *
   * 「待确认」也参与判断：它没有设置开关（数据状态驱动），但**会占一行** ——
   * 若用户把「收藏」「重复资产」两个开关都关掉而库里还有 conflict，
   * 不把它算进来的话会出现一个**没有标题**的孤立行。
   *
   * 换皮后它的第二个用途：决定内容轨道与「整理」轨道之间那道分组标题是否出现
   * （轨道本身是一整根，标题只是分段，所以两者不会互相打架）。
   */
  const showOrganizeGroup = showFavoritesEntry || showDuplicatesEntry || conflictCount > 0

  /** v0.4 收藏计数：空收藏也要能点进去看空态 → 不禁用，只显示 0 */
  const favoriteCount = useMemo(
    () => activeAssets.reduce((n, a) => n + (a.favorite === true ? 1 : 0), 0),
    [activeAssets]
  )
  /**
   * 「收藏」行是否显示为选中态。
   * 回收站视图里收藏筛选并不生效（`matchesFilters` 在 trash 下只吃搜索词）→ 压掉高亮，
   * 点击时也按"未选中 → 打开收藏筛选"处理，避免出现「看着没选中却把筛选关掉」的反向 toggle。
   */
  const favoriteActive = filters.favoriteOnly && !trashMode

  /** 「其他」兜底大类：0 条且未选中时不占位（沿用换皮前「分类」组末位的既有规则） */
  const otherCount = kindCounts.get('other') ?? 0
  const showOtherEntry = otherCount > 0 || filters.kind === 'other'

  /**
   * 「首页」是否选中（`logic/filters.ts` 的 `isAllViewActive` 是唯一判据）。
   *
   * ⚠️ `isAllViewActive` **刻意不看 `kind`**（它把 kind/query 当作"有可视入口的维度"
   * 排除在外）。但「首页」与「模型 / 材质 / HDR / CAD」是**互斥**的 —— 所以这里必须
   * 自己补 `filters.kind === 'all'`，否则点进「模型」之后两者会同时高亮。
   */
  const homeActive =
    isAllViewActive(filters) && filters.kind === 'all' && !dupOnly && libraryView === 'assets'

  /**
   * 轨道取向的**候选链**（越具体越靠前，第一个"已渲染"的行胜出）。
   *
   * 为什么是链而不是单个 key：分类树是折叠的 —— `filters.category1` 有值时，
   * 对应的一级行可能压根没渲染（套用智能集合、从首页搜索直接跳进某个分类都会这样）。
   * 链式回退保证轨道永远指向一个**存在**的行（最差回落到大类行 / 首页）。
   *
   * 优先级 = 「越具体的筛选越靠前」：
   *   回收站 > 重复资产 > 收藏 > 二级 > 一级 > 大类 > 标签 > 首页
   */
  const railTargetKeys = useMemo<readonly string[]>(() => {
    if (trashMode) return ['nav:trash']
    if (dupOnly) return ['nav:dup']
    if (favoriteActive) return ['nav:favorite', 'nav:home']
    if (filters.kind !== 'all') {
      const chain: string[] = [`kind:${filters.kind}`]
      if (filters.category1) {
        chain.unshift(`l1:${filters.kind}:${filters.category1}`)
        if (filters.category2) {
          chain.unshift(`l2:${filters.kind}:${filters.category1}/${filters.category2}`)
        }
      }
      return chain
    }
    if (filters.tag) return [`tag:${filters.tag}`, 'nav:home']
    return ['nav:home']
  }, [
    trashMode,
    dupOnly,
    favoriteActive,
    filters.kind,
    filters.category1,
    filters.category2,
    filters.tag
  ])

  // 风格筛选的**沿革**（改这一块之前先读，别只按半句话改回去）：
  // 最初在顶栏 → 2026-10 用户反馈第 1 条挪进左栏（需求书 §1.2）→
  // 2026-10-22 用户要求「侧栏的风格选项也移到顶栏上面去」→ 搬回顶栏（`components/Toolbar.tsx`）
  // → **壳层改造后定稿：入口在 `App.tsx` 的中栏头那一排**（体积 / 时间 / 分辨率 / 色标
  //   同一排的「风格」chip + 浮层，含计数 / 多选 / 清空），Toolbar 已不再持有该入口。
  // 筛选状态与匹配语义不变：`filters.styles`（维度内 OR、与其他维度 AND，见 logic/filters.ts）。
  // 因此左栏不再有风格分组，也不再有「每个风格各挂多少个资产」那份派生计数。

  /**
   * 节点范围在提示文案里的说法（「材质」分组同时覆盖贴图与材质预设）
   */
  const scopeLabel = (node: NavNode): string =>
    node === MATERIAL_GROUP ? '贴图 / 材质预设' : KIND_LABEL[node]

  /**
   * 分类节点的投放目标（反馈 6d）。
   *
   * 只接管**应用内归类**拖拽（载荷带 `application/x-idbox-asset`）：
   * - 卡片本体的系统级拖出（`startDrag`）不产生该 MIME → `dragover` 不 `preventDefault`
   *   → 节点根本不会成为投放目标，也不会误吞「拖出到建模软件」的手势；
   * - 一级节点 → `assignCategory(ids, 一级, 未分类)`；
   * - 二级节点 → `assignCategory(ids, 一级, 二级)`。
   *
   * 三条口径：
   * ① 全部已在目标分类 → 静默 return（不发请求、不弹撤销条）；
   * ② 跨大类（节点范围不含该资产 kind）→ **整批取消 + 提示**（与本应用
   *    「跨大类不能批量指派」一致，父目录永远由 asset.kind 算）；
   * ③ 松手后高亮立即清除；拖到别处由 `dragend` 兜底清。
   */
  const dropProps = (
    key: string,
    node: NavNode,
    category1: string,
    category2: string = UNCLASSIFIED
  ) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasAssetDragPayload(e.dataTransfer?.types)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropKey((k) => (k === key ? k : key))
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      // 指针移到节点内部的 span / svg 也会触发 dragleave → relatedTarget 还在节点内则忽略
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
      setDropKey((k) => (k === key ? null : k))
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasAssetDragPayload(e.dataTransfer?.types)) return
      e.preventDefault()
      // 阻止冒泡到 App 的全窗 drop（导入通道）：同一次松手不能既归类又尝试导入
      e.stopPropagation()
      setDropKey(null)

      const ids = parseDragIds(e.dataTransfer.getData(ASSET_DRAG_MIME))
      if (ids.length === 0) return
      const plan = planDropAssign(activeAssets, ids, {
        scope: scopeOf(node),
        category1,
        category2
      })
      if (plan.total === 0) return

      if (plan.outOfScope > 0) {
        setNotice(
          `「${plan.label}」只接收${scopeLabel(node)}类资产，本次归类已取消（${plan.outOfScope} 个不属于该大类）`
        )
        return
      }
      // 全部已在目标分类 / id 已失效 → 不发请求、不弹撤销条
      if (plan.ids.length === 0) return
      void assignCategoryWithUndo(plan.ids, plan.category1, plan.category2)
    }
  })

  // ── 钩线轨道：DOM 位姿全走 ref（每帧只改 `d` / `opacity`，不触发 React 重渲染） ──
  const listRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const accentPathRef = useRef<SVGPathElement | null>(null)
  const mutedPathRef = useRef<SVGPathElement | null>(null)
  /** 可测量行：key → 几何（每次 commit 重新测，展开 / 折叠 / 标签变动都会跟着变） */
  const rowsRef = useRef<Map<string, HookRowGeometry>>(new Map())
  const poseRef = useRef<HookPose>({
    y: 0,
    vy: 0,
    x: HOOK_BASE_END_X,
    vx: 0,
    hy: 0,
    hvy: 0,
    hx: HOOK_BASE_END_X,
    hvx: 0,
    o: 0,
    vo: 0
  })
  /**
   * 轨道取向：`active` 是**候选链**（越具体越靠前），`hover` 是当前悬停行。
   *
   * 为什么是链而不是单个 key：分类树是折叠的，`filters.category1` 存在时
   * 对应的一级行可能压根没渲染（换皮前就有的情形，例如套用智能集合 / 首页搜索跳转）。
   * 链式回退保证轨道永远指向一个**存在**的行（最差回落到大类行）。
   */
  const targetRef = useRef<{ active: readonly string[]; hover: string | null }>({
    active: ['nav:home'],
    hover: null
  })
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  /** 减少动效：轨道直接到位（参考 spec「选中项和焦点轨道直接到位」） */
  const reducedRef = useRef(false)
  /** 由挂载 effect 安装的测量入口（测量会顺带唤醒轨道） */
  const measureRef = useRef<() => void>(() => undefined)
  /** 当前悬停的项目（只驱动灰线；行内的明暗由 CSS `:hover` 负责，不经过 React） */
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const reduced = useReducedMotion()
  reducedRef.current = reduced

  useEffect(() => {
    const resolveFirst = (keys: readonly string[]): HookRowGeometry | null => {
      for (const key of keys) {
        const hit = rowsRef.current.get(key)
        if (hit) return hit
      }
      return null
    }
    const firstKey = (keys: readonly string[]): string | null =>
      keys.find((key) => rowsRef.current.has(key)) ?? null

    /** 三条弹簧的目标位姿（参考 `targets()`） */
    const targets = () => {
      const pose = poseRef.current
      const activeGeo = resolveFirst(targetRef.current.active)
      const activeKey = firstKey(targetRef.current.active)
      const hoveredKey = targetRef.current.hover
      const hoverGeo = hoveredKey ? rowsRef.current.get(hoveredKey) ?? null : null
      // 悬停的正是选中项 → 灰线不画（两条线会完全重合，看起来像变粗）
      const hoverOn = hoverGeo && hoveredKey !== activeKey
      return {
        ay: activeGeo ? activeGeo.center : pose.y,
        ax: activeGeo ? activeGeo.endX : pose.x,
        hy: hoverGeo ? hoverGeo.center : pose.hy,
        hx: hoverGeo ? hoverGeo.endX : pose.hx,
        ho: hoverOn ? 1 : 0
      }
    }

    /** 只改 SVG 属性（参考 `paint()`）：强调轨 + 灰线轨 + 灰线不透明度 */
    const paint = (): void => {
      const pose = poseRef.current
      accentPathRef.current?.setAttribute('d', hookPath(pose.y, 0, pose.x))
      mutedPathRef.current?.setAttribute(
        'd',
        hookPath(pose.hy, hookHoverStart(pose.y, pose.hy), pose.hx)
      )
      mutedPathRef.current?.setAttribute('opacity', pose.o.toFixed(3))
    }

    /** 静止判定（参考 `moving()` 的反面）：到位后立刻停帧，不留常驻 rAF */
    const settled = (): boolean => {
      const pose = poseRef.current
      const t = targets()
      return (
        Math.abs(pose.y - t.ay) < 0.015 &&
        Math.abs(pose.vy) < 0.03 &&
        Math.abs(pose.x - t.ax) < 0.015 &&
        Math.abs(pose.vx) < 0.03 &&
        Math.abs(pose.hy - t.hy) < 0.015 &&
        Math.abs(pose.hvy) < 0.03 &&
        Math.abs(pose.hx - t.hx) < 0.015 &&
        Math.abs(pose.hvx) < 0.03 &&
        Math.abs(pose.o - t.ho) < 0.002 &&
        Math.abs(pose.vo) < 0.003
      )
    }

    /** 直接到位（参考 `snap()`）：减少动效、首次测量、行集合变化后都走这里 */
    const snap = (): void => {
      const t = targets()
      const pose = poseRef.current
      pose.y = t.ay
      pose.vy = 0
      pose.x = t.ax
      pose.vx = 0
      pose.hy = t.hy
      pose.hvy = 0
      pose.hx = t.hx
      pose.hvx = 0
      pose.o = t.ho
      pose.vo = 0
      paint()
    }

    /** 一帧（参考 `frame()`）：三条弹簧各走一步 → 落笔 → 未停就继续排帧 */
    const frame = (now: number): void => {
      rafRef.current = 0
      const dt =
        lastFrameRef.current === 0
          ? 1 / 60
          : Math.min(0.064, Math.max(0, (now - lastFrameRef.current) / 1000))
      lastFrameRef.current = now
      const t = targets()
      const pose = poseRef.current
      const y = hookSpring(pose.y, pose.vy, t.ay, dt)
      const x = hookSpring(pose.x, pose.vx, t.ax, dt)
      const hy = hookSpring(pose.hy, pose.hvy, t.hy, dt)
      const hx = hookSpring(pose.hx, pose.hvx, t.hx, dt)
      const o = hookSpring(pose.o, pose.vo, t.ho, dt, HOOK_FADE_MS)
      pose.y = y.position
      pose.vy = y.velocity
      pose.x = x.position
      pose.vx = x.velocity
      pose.hy = hy.position
      pose.hvy = hy.velocity
      pose.hx = hx.position
      pose.hvx = hx.velocity
      pose.o = o.position
      pose.vo = o.velocity
      paint()
      if (settled()) {
        lastFrameRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(frame)
    }

    /** 唤醒（参考 `wake()`）：没在跑且没到位才排帧 */
    const wake = (): void => {
      if (rafRef.current) return
      if (reducedRef.current) {
        snap()
        return
      }
      if (settled()) {
        paint()
        return
      }
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(frame)
    }

    /**
     * 测量（参考 `measure()`）：行中心 = `offsetTop + offsetHeight / 2`。
     *
     * `offsetTop` 的基准是最近的**定位**祖先 —— `.hook-list` 上是 `position: relative`
     * （sidebar-hook.css），所以子层行即使被 `<div>` 包着也仍在同一坐标系里。
     */
    measureRef.current = () => {
      const list = listRef.current
      if (!list) return
      const next = new Map<string, HookRowGeometry>()
      list.querySelectorAll<HTMLElement>('[data-row-key]').forEach((el) => {
        const key = el.dataset.rowKey
        // `offsetParent === null` = 行被 display:none 藏住（折叠态）→ 不参与取向
        if (!key || el.offsetParent === null) return
        const depth = Number(el.dataset.rowDepth ?? '0')
        next.set(key, {
          center: el.offsetTop + el.offsetHeight / 2,
          endX: HOOK_BASE_END_X + (Number.isFinite(depth) ? depth : 0) * HOOK_INDENT
        })
      })
      rowsRef.current = next
      svgRef.current?.setAttribute('height', String(list.offsetHeight))
      wake()
    }

    // 字体 / 行高变化会挪动行中心（参考同样在 fonts.ready 后重测）
    const observer = new ResizeObserver(() => measureRef.current())
    if (listRef.current) observer.observe(listRef.current)
    measureRef.current()
    void document.fonts?.ready.then(() => measureRef.current())

    return () => {
      observer.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      lastFrameRef.current = 0
      measureRef.current = () => undefined
    }
  }, [])

  /**
   * 每次 commit 后重新取向 + 重测（**不写依赖数组**）：
   * 行集合会因展开 / 折叠、标签变动、资产增减而变化，逐一列依赖必然漏；
   * 这里只读布局、不写 state，所以不会自激成环。
   */
  useLayoutEffect(() => {
    targetRef.current = { active: railTargetKeys, hover: hoverKey }
    measureRef.current()
  })

  return (
    <aside className={`sidebar-hook flex shrink-0 flex-col bg-sidebar${collapsed ? ' is-collapsed' : ''}`}>
      {/* 走查 v0.2.2 B6#37（灰阶按已拍板 B2#6：#6B7280 归 tertiary）：「本地素材库」小标题
          画布 2:33 是 #6B7280 = tertiary。其余组头保持 muted 待定。 */}
      <div className="sidebar-hook-head">本地素材库</div>

      <nav className="sidebar-hook-nav" aria-label="库导航">
        {/* 轨道坐标系：`.hook-list` 必须 position:relative（见 CSS），行中心靠它定位。
            悬停只挂**一个**冒泡监听（参考 `pointerover` + `closest` 的做法）：
            · 落在分组标题 / 子层间隙上 → `closest` 取不到行 → 灰线自动收起；
            · 用 updater 比较同一个 key，指针在行内移动不会触发重渲染。 */}
        <div
          className="hook-list"
          ref={listRef}
          onPointerOver={(e) => {
            const hit = e.target instanceof Element ? e.target.closest('[data-row-key]') : null
            const key = hit instanceof HTMLElement ? hit.dataset.rowKey ?? null : null
            setHoverKey((prev) => (prev === key ? prev : key))
          }}
          onPointerLeave={() => setHoverKey(null)}
          onPointerCancel={() => setHoverKey(null)}
        >
          {/* 轨道：下面两条 path 的 `d` 由 rAF 直接写（灰线在前，强调线压在上面） */}
          <svg className="hook-lines" aria-hidden="true" ref={svgRef}>
            <path ref={mutedPathRef} className="hook-line hook-line-muted" opacity="0" />
            <path ref={accentPathRef} className="hook-line hook-line-accent" />
          </svg>

          {/* ── 首页（拍板 §3 第 1 项）─────────────────────────────────
              「全部」= 退出文件视图 + 退出回收站 + 清空所有筛选维度（唯一能回到整库的入口）。
              清理列表与高亮判定都收敛在 `logic/filters.ts` 的
              `allViewFilterPatch` / `isAllViewActive`，不要在组件里再手写。 */}
          <button
            type="button"
            className="hook-row"
            data-row-key="nav:home"
            data-row-depth="0"
            data-active={homeActive ? '1' : '0'}
            aria-current={homeActive ? 'page' : undefined}
            onClick={() => {
              navTo(() => {
                setDupOnly(false)
                // v0.9.4：这个节点在 UI 上叫「首页」（点它进封面页，`App.tsx` 的 `isHome`）。
                // 封面页**没有网格也没有搜索态**，所以这里必须**额外清空搜索词** ——
                // `allViewFilterPatch()` 刻意保留 `query`（搜索框自己可见，点它不该悄悄清搜索），
                // 但带着搜索词点「首页」会落在一个"查询仍在生效、却没有结果列表"的空屏上。
                // 因此在本调用点覆盖 `query`，而不是去改那个纯函数本体。
                setFilter({ ...allViewFilterPatch(), query: '' })
              })
            }}
            title="首页：回到全库封面页（清空全部筛选）"
          >
            <IconHome className="hook-ico" />
            <span className="hook-label">首页</span>
            <span className="hook-count">{activeAssets.length}</span>
          </button>

          {/* ── 分类：大类 = 轨道项，一级 / 二级 = 选中后展开的子层（拍板 §3）── */}
          <div className="hook-group">分类</div>
          {RAIL_KINDS.map((key) => {
            const node: NavNode = key
            const Icon = node === MATERIAL_GROUP ? IconMaterial : KIND_ICON[node] ?? IconOther
            const count = countOf(node)
            const expanded = openKind === node
            const rowKey = `kind:${node}`
            // 高亮压制（换皮前既有口径）：回收站视图里分类筛选不生效，不能显示成"已选中"；
            // 重复资产是换视图，也会把分类筛选清掉 → 同样不显示。
            const active = filters.kind === node && !dupOnly && !trashMode
            return (
              <div key={node}>
                <button
                  type="button"
                  className="hook-row"
                  data-row-key={rowKey}
                  data-row-depth="0"
                  data-tone="accent"
                  data-active={active ? '1' : '0'}
                  aria-current={active ? 'page' : undefined}
                  aria-expanded={expanded}
                  onClick={() => {
                    // 点大类：退出文件视图 → 退出回收站 → 筛选到该大类（分组节点 = texture+material）、
                    // 清空分类筛选；首次点击即展开子层，再点该大类 = 折叠
                    navTo(() => {
                      setDupOnly(false)
                      setFilter({ kind: node, tag: null, source: null, category1: null, category2: null })
                      setExpandKind(nextExpandKind(expanded, node))
                      setExpandL1(null)
                    })
                  }}
                  title={
                    expanded
                      ? `${railKindLabel(node)}：点击折叠子分类`
                      : `${railKindLabel(node)}：点击筛选并展开子分类`
                  }
                >
                  <Icon className="hook-ico" />
                  <span className="hook-label">{railKindLabel(node)}</span>
                  <span className="hook-count">{count}</span>
                  <IconCaret className="hook-caret" data-open={expanded ? '1' : '0'} />
                </button>

                {/* 子层（depth 1）：材质先给两个单类 chip（docs/14 §2.4），再接一级分类树。
                    点中 chip 再点一次 → 回到分组（含两类），不会卡在单类上。 */}
                {expanded && (
                  <div className="hook-sub">
                    {node === MATERIAL_GROUP && (
                      <div className="hook-chips">
                        {KIND_GROUP_MEMBERS.materialGroup.map((member) => {
                          // 回收站里 chips 不算"已选中"（那只是回收站视图，筛选并未生效）
                          // → 点击语义恒为「退出回收站 + 切到该单类」
                          const on = filters.kind === member && !trashMode
                          return (
                            <button
                              key={member}
                              type="button"
                              className={on ? 'chip-accent' : 'chip-ghost'}
                              onClick={() => {
                                // 材质分组下的单类 chip：同样是导航（退出文件视图 + 退出回收站）
                                navTo(() => {
                                  setFilter({
                                    kind: on ? MATERIAL_GROUP : member,
                                    tag: null,
                                    source: null
                                  })
                                })
                              }}
                              title={on ? '再点回到「材质」（两类）' : `只看${KIND_LABEL[member]}`}
                            >
                              {KIND_LABEL[member]}
                              {/* chip 自带 gap-1，这里不再加 margin（否则 4+4=8px，数字飘太远） */}
                              <span className="tabular-nums opacity-60">
                                {kindCounts.get(member) ?? 0}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {l1Nodes.map((n) => {
                      // 高亮压制：回收站视图里分类筛选不生效，不能显示成"已选中"
                      const l1Active =
                        !trashMode &&
                        filters.kind === node &&
                        filters.category1 === n.value &&
                        filters.category2 === null
                      const l1Open = openL1 === n.value
                      const l1Key = `l1:${node}:${n.value}`
                      return (
                        <div key={n.value}>
                          {/* 一级节点行：主按钮 + （未分类时的）整理入口。
                              ⚠️ 整理按钮**不能**塞进主按钮内部 —— `<button>` 里套 `<button>`
                              是非法 HTML（浏览器会把它提出去，点击区域错乱）。
                              所以这一行是 `flex` 行容器：主按钮 `flex-1 min-w-0` + 兄弟节点整理按钮。 */}
                          <div className="group flex items-center">
                            <button
                              type="button"
                              className="hook-row min-w-0 flex-1"
                              data-row-key={l1Key}
                              data-row-depth="1"
                              data-tone="accent"
                              data-active={l1Active ? '1' : '0'}
                              data-drop={dropKey === l1Key ? '1' : '0'}
                              aria-current={l1Active ? 'page' : undefined}
                              aria-expanded={l1Open}
                              {...dropProps(l1Key, node, n.value)}
                              onClick={() => {
                                // 一级分类：退出文件视图 → 退出回收站 → 筛选到「大类 + 一级」，
                                // 再点同一节点折叠
                                navTo(() => {
                                  setFilter({
                                    kind: node,
                                    category1: n.value,
                                    category2: null,
                                    tag: null,
                                    source: null
                                  })
                                  setExpandL1(l1Open ? null : n.value)
                                })
                              }}
                              title={
                                n.value === UNCLASSIFIED
                                  ? '导入后未指派分类的资产（可把卡片拖到这里）'
                                  : `${n.value}（可把卡片拖到这里归类）`
                              }
                            >
                              <span className="hook-label">{n.value}</span>
                              <span className="hook-count">{n.count}</span>
                              <IconCaret className="hook-caret" data-open={l1Open ? '1' : '0'} />
                            </button>
                            {/* 「整理」入口（P2）：只在**未分类且有资产**时出现（需求 1）。
                                常显而不是 hover 才现 —— 它是这一行的**主行动**，用户找不到入口
                                这功能就等于不存在；hover 才现只适合次要操作。
                                走 `openTriage()` —— 待办集为空时它自己给 notice 且不开浮层。
                                视觉：实心 accent 蓝 + 白字（沿用 .btn-solid 的 token，尺寸压到 h20）。
                                它是 flex 兄弟节点 → 占位、把数字顶到左边，两者不可能重叠。 */}
                            {n.value === UNCLASSIFIED && n.count > 0 && (
                              <button
                                type="button"
                                className="h-[20px] shrink-0 rounded-[5px] bg-accent px-1.5 text-[10px] font-medium leading-none text-white transition hover:brightness-110"
                                title="一键整理：一屏一张，选完分类自动跳到下一张"
                                onClick={(e) => {
                                  // 不能冒泡到主按钮（那会顺手筛选到「未分类」并折叠树）
                                  e.stopPropagation()
                                  openTriage()
                                }}
                              >
                                整理
                              </button>
                            )}
                          </div>

                          {l1Open &&
                            openL1 === n.value &&
                            l2Nodes.map((c2) => {
                              const full = dupL2.has(c2.value) ? `${n.value}/${c2.value}` : c2.value
                              const l2Key = `l2:${node}:${n.value}/${c2.value}`
                              // 高亮压制（同 l1）：回收站里不显示成"已选中"，否则点击的 toggle 语义会反
                              const l2Active =
                                !trashMode &&
                                filters.kind === node &&
                                filters.category1 === n.value &&
                                filters.category2 === c2.value
                              return (
                                <button
                                  key={`${n.value}/${c2.value}`}
                                  type="button"
                                  className="hook-row"
                                  data-row-key={l2Key}
                                  data-row-depth="2"
                                  data-tone="accent"
                                  data-active={l2Active ? '1' : '0'}
                                  data-drop={dropKey === l2Key ? '1' : '0'}
                                  aria-current={l2Active ? 'page' : undefined}
                                  {...dropProps(l2Key, node, n.value, c2.value)}
                                  onClick={() => {
                                    // 二级分类：退出文件视图 → 退出回收站 → 筛选到「大类 + 一级 + 二级」，
                                    // 再点同一条取消二级
                                    navTo(() => {
                                      setFilter({
                                        kind: node,
                                        category1: n.value,
                                        category2: l2Active ? null : c2.value,
                                        tag: null,
                                        source: null
                                      })
                                    })
                                  }}
                                  title={full}
                                >
                                  <span className="hook-label">{full}</span>
                                  <span className="hook-count">{c2.count}</span>
                                </button>
                              )
                            })}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* 「其他」兜底大类（换皮前就在「分类」组末位，**不删能力**）：
              0 条且未选中时整行不渲染 —— 与它换皮前的规则完全一致。
              子层只对 4 个拍板大类开放，兜底桶没有一级/二级树。 */}
          {showOtherEntry && (
            <button
              type="button"
              className="hook-row"
              data-row-key="kind:other"
              data-row-depth="0"
              data-tone="accent"
              data-active={filters.kind === 'other' && !dupOnly && !trashMode ? '1' : '0'}
              aria-current={filters.kind === 'other' && !dupOnly && !trashMode ? 'page' : undefined}
              onClick={() => {
                // 兜底大类：退出文件视图 → 退出回收站 → 只筛这一类，并收起当前子层
                navTo(() => {
                  setDupOnly(false)
                  setFilter({ kind: 'other', tag: null, source: null, category1: null, category2: null })
                  setExpandKind(null)
                  setExpandL1(null)
                })
              }}
              title="其他：没能归入模型 / 材质 / HDRI / CAD 的资产"
            >
              <IconOther className="hook-ico" />
              <span className="hook-label">{KIND_LABEL.other}</span>
              <span className="hook-count">{otherCount}</span>
            </button>
          )}

          {/* ── 整理组（拍板 §3 的「收藏」+ 待确认；「重复资产」是换皮前旧成员，保留）──
              与「重复资产」的交互差异（产品取舍，见交付报告）：
              · 收藏是**属性筛选**：点「首页」或切大类时**保留**（用户是在同一批资产上换维度）；
              · 点「重复资产」是**换视图**：会清掉收藏/色标，避免两个视图叠加出「重复里再筛收藏」的困惑。 */}
          {showOrganizeGroup && <div className="hook-group">整理</div>}

          {showFavoritesEntry && (
            <button
              type="button"
              className="hook-row"
              data-row-key="nav:favorite"
              data-row-depth="0"
              data-active={favoriteActive ? '1' : '0'}
              aria-current={favoriteActive ? 'page' : undefined}
              onClick={() => {
                // 退出文件视图 + 退出回收站 + 只切这一个维度：
                // 收藏是属性筛选，不应顺带清掉分类/搜索
                navTo(() => {
                  setDupOnly(false)
                  setFilter({ favoriteOnly: !favoriteActive })
                })
              }}
              title={favoriteActive ? '取消「仅看收藏」' : `只看收藏（${favoriteCount} 个）`}
            >
              <span className="hook-ico flex w-[15px] justify-center">
                <StarIcon filled={favoriteActive} size={14} />
              </span>
              <span className="hook-label">收藏</span>
              <span className="hook-count">{favoriteCount}</span>
            </button>
          )}

          {showDuplicatesEntry && (
            <button
              type="button"
              // `dupOnly` 在回收站里恒为 false（进入 trash 时 store 会强制关掉，见 setLibraryView）
              // → 这里不需要 `!trashMode` 的额外压制
              className="hook-row"
              data-row-key="nav:dup"
              data-row-depth="0"
              data-active={dupOnly ? '1' : '0'}
              data-disabled={dupExtra === 0 ? '1' : '0'}
              aria-current={dupOnly ? 'page' : undefined}
              disabled={dupExtra === 0}
              onClick={() => {
                // 退出文件视图 + 退出回收站 + 进入重复视图时清掉其它筛选维度：
                // 入口语义是「看全库哪些资产重复了」。清理列表与「首页」按钮**同源**
                // （`allViewFilterPatch`），不要在这里另写一份 —— 0.9.0 这里漏了 6 个字段。
                navTo(() => {
                  setFilter(allViewFilterPatch())
                  setDupOnly(true)
                  setExpandKind(null)
                  setExpandL1(null)
                })
              }}
              title={
                dupExtra === 0
                  ? '库里没有重复资产'
                  : `按名字分组查看重复资产（${dupGroups.length} 组，可清理 ${dupExtra} 份）`
              }
            >
              <IconFile className="hook-ico" />
              <span className="hook-label">重复资产</span>
              <span className="hook-count">{dupExtra}</span>
            </button>
          )}

          {/* 「待确认」（docs/35 §4.3 入口①）：分类存在两源争议的资产（`reviewReasonOf === 'conflict'`）。
              三条形态纪律，逐条都对得上设计文档：
              · **0 时整行不渲染** —— 不是禁用、不是灰掉。与「整理」按钮"只在有资产时出现"
                同一纪律；也与「重复资产」的常驻形态刻意不同：那个是**常驻能力的入口**
                （用户要能知道它在哪），本行是**数据状态的提示**（没有存疑数据时它就不该占位）。
              · 点击只 `openReview()` —— **不套筛选、不切视图**（与 `openTriage()` 的两条既有
                纪律完全一致，见 `store.ts` 的 `openTriage` 注释）。待确认队列本身是全库口径，
                套上筛选会让用户看到的条数与徽标对不上。
              · **不冒泡**：侧栏的行级点击有历史包袱（`navTo` / 折叠树），
                不让一次点击顺手触发第二个动作。 */}
          {conflictCount > 0 && (
            <button
              type="button"
              className="hook-row"
              data-row-key="nav:review"
              data-row-depth="0"
              title={`分类存疑、等你裁定（${conflictCount} 个）：一屏一张，选完自动跳到下一张`}
              onClick={(e) => {
                e.stopPropagation()
                openReview()
              }}
            >
              <IconAlert className="hook-ico" />
              <span className="hook-label">待确认</span>
              <span className="hook-count">{conflictCount}</span>
            </button>
          )}

          {/* ── 0.6.0 智能集合（保存的筛选视图）──────────────────────────
              列 `settings.savedViews`；点击 = 整组套用（filters 以 DEFAULT_FILTERS 为底
              再覆盖，绝不在当前条件上叠加）。行尾 ✕ 直接删 —— 删的是**视图**不是资产，
              所以不做二次确认（与删除资产的安全等级不同）。
              零集合时也保留标题 + 一行提示：否则用户永远不知道这个功能在哪。 */}
          <div className="hook-group hook-group-row">
            <span>智能集合</span>
            {savedViews.length > 0 && (
              <span className="text-[10px] text-muted">
                {savedViews.length}/{SAVED_VIEW_LIMIT}
              </span>
            )}
          </div>
          {savedViews.length === 0 ? (
            <div className="px-2.5 pb-1 text-[11px] leading-relaxed text-muted">
              在中栏头点「＋ 存为集合」保存当前筛选
            </div>
          ) : (
            savedViews.map((v) => {
              const viewKey = `view:${v.id}`
              return (
                <div key={v.id} className="group flex items-center">
                  <button
                    type="button"
                    className="hook-row min-w-0 flex-1"
                    data-row-key={viewKey}
                    data-row-depth="0"
                    onClick={() => {
                      // 套用智能集合也是导航：先离开文件视图，再退出回收站
                      // （集合里的筛选只对资产视图有意义）
                      navTo(() => applySavedView(v))
                    }}
                    title={`套用「${v.name}」（替换当前全部筛选条件与排序）`}
                  >
                    <span className="hook-label">{v.name}</span>
                  </button>
                  <button
                    type="button"
                    className="hook-row-x"
                    title="删除该智能集合（只删视图，不动资产）"
                    aria-label={`删除智能集合 ${v.name}`}
                    onClick={(e) => {
                      // 行本身是按钮：不阻断会同时触发「套用」
                      e.stopPropagation()
                      void deleteSavedView(v.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            })
          )}

          {/* 2026-10 用户反馈：体积 / 导入时间两个控件已整体移到中栏头
              （App.tsx：排序胶囊左侧的「体积 / 时间」两个按钮 + 浮层）。
              侧栏不再保留这一块，避免同一维度出现两处入口。 */}

          {tagCounts.length > 0 && (
            <>
              <div className="hook-group">标签</div>
              {tagCounts.map(([tag, count]) => {
                const tagKey = `tag:${tag}`
                return (
                  <button
                    key={tag}
                    type="button"
                    className="hook-row"
                    data-row-key={tagKey}
                    data-row-depth="0"
                    // 高亮压制：回收站视图里标签筛选不生效 → 不显示成已选中，
                    // 点击语义相应按"未选中 → 选中该标签"处理（否则会出现反向 toggle）
                    data-active={filters.tag === tag && !trashMode ? '1' : '0'}
                    aria-current={filters.tag === tag && !trashMode ? 'page' : undefined}
                    onClick={() => {
                      // 标签筛选同样是导航：先离开文件视图，再退出回收站
                      navTo(() => {
                        setFilter({
                          tag: filters.tag === tag && !trashMode ? null : tag,
                          source: null
                        })
                      })
                    }}
                    title={`按标签筛选：${tag}`}
                  >
                    <span className="hook-label">{tag}</span>
                    <span className="hook-count">{count}</span>
                  </button>
                )
              })}
            </>
          )}

          {/* 2026-10 用户反馈：侧栏不再显示素材渠道分组（`filters.source` 仍是合法筛选状态，
              只是没有 UI 入口；其他路径写入的值依旧生效）。 */}

          {/* ── 库：最近删除（C 线，2026-10）──────────────────────────────
              放在轨道最底部、与筛选区**隔开**：它是视图切换，不是筛选维度。
              `recycle` 档不会产生软删记录（删除直接进系统回收站），此时徽标恒 0 —— 入口保留，
              让用户知道「这个功能在哪」，点进去是「回收站是空的」空态。 */}
          <div className="hook-group">库</div>
          <button
            type="button"
            className="hook-row"
            data-row-key="nav:trash"
            data-row-depth="0"
            data-active={trashMode ? '1' : '0'}
            aria-pressed={trashMode}
            onClick={() => navToView(() => setLibraryView(trashMode ? 'assets' : 'trash'))}
            title={
              trashMode
                ? '回收站（最近删除）：返回资产列表（筛选条件会原样恢复）'
                : '回收站（最近删除）：保留期内可还原，到期自动彻底删除'
            }
          >
            <IconTrash className="hook-ico" />
            <span className="hook-label">回收站</span>
            {trashCount > 0 ? (
              <span
                className="badge shrink-0 !px-1.5 !py-0 text-[10px]"
                title={`${trashCount} 个已删除资产`}
              >
                {trashCount}
              </span>
            ) : (
              <span className="hook-count">0</span>
            )}
          </button>
        </div>
      </nav>

      {/* 底部：导入 CTA → 设置 → 库路径 + 版本号小字（§3.2，10px muted）。
          反馈 2（反馈处置 §2）：唯一的导入入口放在设置行**上方**，`w-full` 撑满左栏
          （`.btn-cta` 自带 132px 定宽，utilities 层的 `w-full` 覆盖它），高度仍 32。 */}
      <div className="hook-foot">
        <button
          className="btn-cta mb-1.5 w-full"
          onClick={async () => {
            const files = await window.modvault.pickArchives()
            if (files.length > 0) void importPaths(files)
          }}
          title="选择压缩包 / 图片导入"
        >
          <IconDownload width={14} height={14} />
          导入压缩包
        </button>
        <button type="button" className="hook-foot-row" onClick={onOpenSettings}>
          <IconSettings width={15} height={15} className="shrink-0 text-tertiary" />
          <span className="flex-1 truncate text-left">设置</span>
        </button>
        <button
          type="button"
          className="hook-foot-path"
          onClick={() => window.modvault.openLibrary()}
          title="在资源管理器中打开库目录"
        >
          <span className="block truncate">{settings?.libraryDir ?? '库目录'}</span>
        </button>
        {version && <div className="hook-foot-version">v{version}</div>}
      </div>
    </aside>
  )
}
