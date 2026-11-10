import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, SVGProps } from 'react'
import { useVault, useVisibleAssets, SAVED_VIEW_LIMIT } from './store'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { HomeCover } from './components/home/HomeCover'
import type { HomeFolderItem, HomeStatsData } from './components/home/HomeCover'
// 首页 → 分类库的过场（卡片长成全屏 → 淡出 → 露出库）。类型来自 GlassFolder：
// 那是**量起点矩形**的地方，App 只是接力播放，不自己定义一份坐标契约。
import { HomeOutro } from './components/home/HomeOutro'
import type { GlassFolderOpenPayload } from './components/home/GlassFolder'
import type { HomeSearchGroup, HomeSearchItem } from './components/home/HomeSearchCommand'
import { AssetGrid } from './components/AssetGrid'
import { DetailPanel } from './components/DetailPanel'
import { DropOverlay } from './components/DropOverlay'
import { ImportQueue } from './components/ImportQueue'
import { SettingsDialog } from './components/SettingsDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ImportConflictDialog } from './components/ImportConflictDialog'
import { NoticeToast } from './components/NoticeToast'
import { CategoryPicker } from './components/CategoryPicker'
import { RenameDialog } from './components/RenameDialog'
import { ColorTagPicker } from './components/MarkControls'
import { canStage, stageController } from './logic/stageController'
import { setMotionQuality } from './logic/motionProfile'
import { decideEsc } from './logic/escPriority'
import { hasEscLayer } from './logic/escLayer'
import { resolveQuickLookTarget } from './logic/quickLook'
// DEF-19-3：库目录漂移体检。与设置页的警示条**共用同一个纯函数** ——
// 两处各写一套"路径在不在库内 / 缺不缺尺寸"的判据，迟早会给出两个数字。
import { planLibraryDrift, resolutionDriftHint } from './logic/libraryDrift'

/**
 * 舞台落点尺寸（2026-10-21 用户拍板：球放**标题下方居中**，不再放顶栏。
 * 2026-10-25 反馈：148 → **140**，视觉上更贴齐右栏预览那颗球）。
 * `MaterialStage` 只读 `#stage-slot` 的 `getBoundingClientRect`，不写死尺寸；
 * 这里改完**只需改这一个常量**。
 */
const STAGE_SLOT = 140

/**
 * 舞台懒加载：静态 import 会把 three.js（~1.2MB）并进主包，启动要多解析一倍代码
 * （实测 735KB → 1905KB）。改成首次双击才拉这个块；之后常驻挂载以保住 WebGL 上下文。
 */
const MaterialStageLazy = lazy(() =>
  import('./components/MaterialStage').then((m) => ({ default: m.MaterialStage }))
)

/**
 * HDR 预览弹窗（0.6.5）也走懒加载：它静态 import three.js。
 * 三处入口（网格双击 HDR 卡 / 文件视图双击 `.hdr` / 详情面板按钮）共用
 * store 的 `hdrPreviewAssetId`，弹窗**只在这里挂一次**。
 */
const HdrPreviewDialogLazy = lazy(() =>
  import('./components/HdrPreviewDialog').then((m) => ({ default: m.HdrPreviewDialog }))
)

/**
 * Quick Look 全屏快览浮层（0.8.3，docs/32 §4）：同样懒加载（首次按空格才拉这个块）。
 * store 的 `quickLookAssetId` 是唯一真相，浮层**只在这里挂一次** —— 挂两个实例会出现
 * 两个 Esc 层（层栈里占两格），关掉一个后另一个还在应答，表现成"按一次 Esc 没反应"。
 */
const QuickLookOverlayLazy = lazy(() =>
  import('./components/QuickLookOverlay').then((m) => ({ default: m.QuickLookOverlay }))
)

/**
 * 未分类整理流水线浮层（P2）：同样懒加载。
 *
 * 与 Quick Look 相同的一条纪律：**只在这里挂一次**。挂两个实例会有两个 Esc 层、
 * 两个 keydown 监听，一次确认会归类两次。
 */
const TriageOverlayLazy = lazy(() =>
  import('./components/TriageOverlay').then((m) => ({ default: m.TriageOverlay }))
)

/**
 * 「发现新版本」弹窗（2026-11，Release 发布说明）：同样懒加载 —— 大多数启动都是
 * "已是最新"，没必要把 Markdown 解析器和弹窗并进主包。
 *
 * 挂载条件由 `useUpdateDialogOpen()` 决定（`logic/updateState.ts` 里的纯函数判定：
 * 有新版本 + 没跳过着一版 + 本次启动没点稍后）。**只在这里挂一次** —— 弹窗占一层 Esc 栈，
 * 挂两个实例会出现"按一次 Esc 只关掉其中一个"。
 */
const UpdateNotesDialogLazy = lazy(() =>
  import('./components/UpdateNotesDialog').then((m) => ({ default: m.UpdateNotesDialog }))
)
import { formatBytes, thumbVaultUrl } from '../shared/format'
import { resolveTheme } from '../shared/theme'
import { displayName } from '../shared/naming'
import {
  KIND_LABEL,
  MATERIAL_GROUP,
  capsOfFilter,
  kindFilterLabel,
  kindsOfFilter
} from '../shared/classify'
import { HOME_FOLDER_KEYS } from './logic/homeKinds'
import { MODEL_FORMAT_OPTIONS } from '../shared/modelFormat'
import {
  SIZE_PRESET_BYTES,
  SORT_OPTIONS,
  TIME_PRESET_LABEL,
  activeImportedRange,
  activeSizeRange,
  allViewFilterPatch,
  describeNumericFilters,
  effectiveSortDesc,
  helpHintText,
  hiddenActiveFilterLabels,
  isAllViewActive,
  resolutionChipTitle,
  resolutionOptionsFor,
  resolutionPanelTitle,
  sizePresetLabel,
  sizePresetOf,
  styleCountsFor,
  timePresetOf,
  timePresetRange,
  toggleColorTag,
  type TimePresetKey
} from './logic/filters'
import { summarizeAsset } from './logic/fileView'
import { isAllSelected } from './logic/selection'
import { isDeletedAsset } from './logic/trashView'
import { isCategoryIncomplete } from './logic/category'
import type { AssetKind } from '../shared/types'
import { hasAssetDragPayload } from './logic/dragAssign'
import { isInternalDragOut, resetInternalDragOut } from './logic/dragOut'
import { pathsOutsideLibrary } from './logic/libraryPath'
import type { SortKey } from './logic/filters'
import { IconDownload, IconEmptyLibrary, IconPlus } from './icons'
import { useUpdateDialogOpen } from './logic/updateState'

/**
 * 中栏头快速筛选浮层的展开态（体积 / 时间 / 色标；null = 收起）
 *
 * ⚠️ 0.6.0 新增的「分辨率 / 存为集合」**不并进这个联合类型**：
 * `tests/marks.test.ts` 把这一行字面量当作「色标入口在中栏头」的契约钉住了，
 * 加成员会连带改动别人的测试文件。两者共用同一套定位 / 关闭逻辑（`quickPos` +
 * 下面那个 effect），只是状态分开存 —— 行为上没有任何区别。
 */
type QuickPanel = 'size' | 'time' | 'color' | null

/** 0.6.0 新增的中栏头浮层（分辨率 / 存为集合；2026-10 再加「模型格式」；null = 收起） */
type ExtraPanel = 'resolution' | 'save' | 'format' | null

/**
 * 中栏头快速筛选的选项表（单选）。
 * 体积对应 `minBytes`（只设下界），时间对应 `importedAfter`（从现在往前 N 天）。
 * 「不限」= 把该维度清回 null；两个按钮的取值语义与侧栏旧实现完全一致。
 */
const SIZE_QUICK_OPTIONS: { label: string; bytes: number | null }[] = [
  { label: '不限', bytes: null },
  ...SIZE_PRESET_BYTES.map((bytes) => ({ label: sizePresetLabel(bytes), bytes }))
]

const TIME_QUICK_OPTIONS: { label: string; key: TimePresetKey | null }[] = [
  { label: '不限', key: null },
  ...(Object.keys(TIME_PRESET_LABEL) as TimePresetKey[]).map((key) => ({
    label: TIME_PRESET_LABEL[key],
    key
  }))
]

/** 「存为集合」浮层宽度（与下方 `w-[208px]` 必须一致：定位按它右对齐） */
const SAVE_PANEL_WIDTH = 208

/** 排序浮层宽度（与下方 `w-[176px]` 必须一致：定位按它右对齐） */
const SORT_PANEL_WIDTH = 176

/**
 * 风格筛选浮层宽度（px）。
 *
 * 与「体积 / 时间 / 色标」那族一样是 `position: fixed` + 按触发按钮矩形定位，
 * 定位算式里要用真实宽度做右边界夹紧（否则在窄窗口下会顶出屏幕右边）。
 * 面板内容仍是「标题 + 可换行的风格 chip」，248 与之前顶栏那颗面板同一数值。
 */
const STYLE_PANEL_WIDTH = 248

// ── 左右侧边栏折叠（0.8.3，用户 2026-10-28 反馈）─────────────────────────
//
// 形态（已拍板）：折叠 = **完全隐藏**（不是收成窄条）+ 中栏对应边缘的竖向唤出按钮。
// 宽度过渡走 CSS transition（ease），内容保持固定宽（不做挤压变形），动画结束后
// 才把内容 visibility:hidden（折叠方向延迟到动画结束，展开方向立即可见 → 两个方向都平滑）。

/** 左栏宽（与 `Sidebar.tsx` 的 `w-[216px]` 必须一致：动画两端都要对齐它） */
const SIDEBAR_W = 216
/** 右栏宽（与 `DetailPanel.tsx` 的 `w-[300px]` 必须一致） */
const DETAIL_W = 300
/**
 * 左栏「折叠成轨道」后的宽（px）。
 *
 * 2026-11-09 侧栏换皮（钩线轨道）：折叠不再等于"整列消失"，而是收成一根只留图标与
 * 轨道的窄条 —— 与 `sidebar-hook.css` 的 `.sidebar-hook.is-collapsed { width: 48px }`
 * 必须一致（动画两端都要对齐它）。
 * **首页态例外**：首页要整块干净的封面，左栏在那时仍按 0 宽 + 隐藏处理（见调用处）。
 */
const SIDEBAR_RAIL_W = 48
/** 宽度过渡时长（ms，规范口径 150-200ms ease） */
const SIDEBAR_COLLAPSE_MS = 180
/** 中栏边缘竖向唤出按钮的宽（px）；高度 56 居中，hover 走 tint */
const EDGE_TOGGLE_W = 16

/**
 * chevron 箭头（本地定义：`icons.tsx` 没有方向箭头，且不在本批文件边界内）。
 * 规格照抄 `icons.tsx` 的 Base 约定：24×24 viewBox、stroke currentColor、
 * strokeWidth 2.25（16px 渲染尺寸 = 视觉 1.5）、round cap/join。
 */
const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M14.5 5l-7 7 7 7" />
  </svg>
)
const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M9.5 5l7 7-7 7" />
  </svg>
)

/**
 * 可折叠侧栏的包裹层：外层动画宽度 + 裁切，内层（children）保持固定宽 ——
 * 内容永不挤压变形。
 *
 * 两种折叠形态（2026-11-09 起）：
 * - `railWidth` 未传或为 0 → 老形态：宽度归 0 + 动画结束后 `visibility:hidden`
 *   （把它从焦点 / 无障碍树里彻底拿掉）。首页态用这条。
 * - `railWidth > 0` → 轨道形态：收到 `railWidth` 宽，**保持可见**（左栏折叠成只留
 *   图标与钩线轨道的窄条），不做 aria-hidden —— 它仍然可点、可聚焦。
 */
function CollapsibleColumn({
  id,
  collapsed,
  width,
  railWidth = 0,
  children
}: {
  id: string
  collapsed: boolean
  width: number
  /** 折叠后保留的宽度（px）。0 = 完全收起（老形态）；>0 = 收成轨道窄条 */
  railWidth?: number
  children: ReactNode
}) {
  const asRail = collapsed && railWidth > 0
  const hidden = collapsed && !asRail
  return (
    <div
      id={id}
      className="flex shrink-0 overflow-hidden"
      style={{
        width: collapsed ? railWidth : width,
        visibility: hidden ? 'hidden' : 'visible',
        // 折叠：内容滑出的 180ms 里保持可见，动画结束才隐藏；展开：立即可见随宽度滑入。
        // 轨道形态不需要延迟隐藏（它一直可见），所以只用宽度过渡。
        transition: hidden
          ? `width ${SIDEBAR_COLLAPSE_MS}ms ease, visibility 0s linear ${SIDEBAR_COLLAPSE_MS}ms`
          : `width ${SIDEBAR_COLLAPSE_MS}ms ease, visibility 0s`
      }}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  )
}

/**
 * 中栏边缘的竖向唤出 / 收起按钮（折叠后唯一的入口，展开时可点它收起）。
 * 视觉极简：透明底 + tertiary 色 chevron；hover 才出现 tint（bg-elevated）与提亮，
 * 色值全部来自设计规范既有 token（不新造颜色）。
 */
function SidebarEdgeToggle({
  side,
  collapsed,
  onToggle
}: {
  side: 'left' | 'right'
  collapsed: boolean
  onToggle: () => void
}) {
  const label = `${collapsed ? '展开' : '折叠'}${side === 'left' ? '左侧栏' : '右侧栏'}`
  return (
    <button
      type="button"
      className="flex h-14 shrink-0 cursor-pointer self-center items-center justify-center rounded-md text-tertiary transition hover:bg-elevated/60 hover:text-secondary"
      style={{ width: EDGE_TOGGLE_W }}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={side === 'left' ? 'sidebar-left' : 'detail-panel'}
      title={label}
      onClick={onToggle}
    >
      {side === 'left' ? (
        collapsed ? <IconChevronRight /> : <IconChevronLeft />
      ) : collapsed ? (
        <IconChevronLeft />
      ) : (
        <IconChevronRight />
      )}
    </button>
  )
}

/**
 * 首页过场相关的约束值（2026-11 用户第三轮口径：「第一，文件夹移动，而不是我们的
 * 缩略图移动。第二，移动到比如模型的这个文件夹时，它应该是中心消隐的，而不是瞬间
 * 不见的」）。
 *
 * 时间轴（主人分散在三个文件里，但只有一张表，见 `HomeCover.tsx` 的 EXIT_* 常量）：
 *   0 ── 360 到中心 ── 600 停留完 ── 880 消隐完 ── 880 切视图（库卡片随即滑入）
 *        飞 360ms        停 240ms        消隐 280ms
 * 飞行与消隐发生在**真实文件夹节点**上（`GlassFolder` + `glass-folder.css`，由
 * `HomeCover` 驱动 rAF），本文件只关心「**什么时候切视图**」。
 *
 * 为什么切点是 880：
 * · 360ms 之前切 = 文件夹刚起飞画面就换了；360–600 切 = 用户明确要的那口"停留"被吃掉；
 * · 600–880 切 = 消隐做到一半就被换掉，等于"瞬间不见"，正是用户这次否掉的观感；
 * · 880 之后切 → 文件夹已经彻底化开、屏幕上空着等网格，会闪一帧空屏。
 * 所以切点必须**卡在消隐结束那一刻**：上一帧它刚好化完，下一帧库已经在那儿了。
 */
const HOME_OUTRO_SWITCH_MS = 880

/**
 * 切视图后 `enterFromHome` 挂多久（ms，**从切视图那一刻起算**）。
 *
 * ⚠️ 2026-11-09 起语义收窄：它**不再是**「唯一会触发卡片入场的东西」，而只是
 * `AssetGrid` 四个入场边沿之一（另三个是首挂载、导航身份变化、从文件视图返回）。
 * 入场的主判据已经搬进 `AssetGrid` 内部的「网格出现请求」（`enterSeq` + `enterNavKey`），
 * 所以正常导航（侧栏 / 搜索 / 进分类 / 从文件夹返回）**现在也会播入场**，不再"零行为"。
 *
 * 这里是"来源标记"不是动画时长：`AssetGrid` 只取它的**上升沿**（1100ms 后置 false 的
 * 下降沿不触发）。留长一点的唯一目的是不要在动画尾巴上改父级 state（那会让网格跟着
 * 重渲染一次）。1100 与 `AssetGrid` 侧注释里的数字一致。
 */
const HOME_GRID_ENTER_MS = 1100

/**
 * 读一次「减少动效」系统偏好（**不订阅**）。
 *
 * 为什么另开一份而不是复用 `HomeCover` / `GlassFolder` 里那两个 hook：
 * 那两处是各自组件私有的实现（没有导出），为了一个 `matchMedia(...).matches`
 * 去改别人的文件、或者新开一个 hooks 文件，代价都比收益大。**两处各读一次**，
 * 语义完全一致（都是系统级偏好，不跟随变化 —— 过场最长 700ms，中途改设置不需要改道）。
 *
 * @returns 当前是否要求「减少动效」
 */
function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function App() {
  const init = useVault((s) => s.init)
  const ready = useVault((s) => s.ready)
  const importPaths = useVault((s) => s.importPaths)
  const selectedId = useVault((s) => s.selectedId)
  const selectedIds = useVault((s) => s.selectedIds)
  const select = useVault((s) => s.select)
  // 2026-10 多选入口补齐：中栏头「全选 / 取消全选」（作用于当前筛选结果，不是全库）
  const selectAll = useVault((s) => s.selectAll)
  // P0-16：按 Delete 不再直接删，先 requestDelete（二次确认 + 5 秒撤销）
  const requestDelete = useVault((s) => s.requestDelete)
  const undoDelete = useVault((s) => s.undoDelete)
  // 双击卡片进入的「软件内文件夹浏览器」（docs/15 §6c）
  const folderViewAssetId = useVault((s) => s.folderViewAssetId)
  const closeFolderView = useVault((s) => s.closeFolderView)
  const assets = useVisibleAssets()

  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [dragging, setDragging] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── 中栏头「体积 / 时间」快速筛选（2026-10 用户反馈：从侧栏移到中栏头） ──
  // 浮层用 **fixed 定位**（按触发按钮的 rect 算坐标），不放在中栏滚动区里，
  // 避免被 `overflow-auto` 的资产网格裁切；坐标在打开那一刻取一次即可。
  const [quickPanel, setQuickPanel] = useState<QuickPanel>(null)
  const [extraPanel, setExtraPanel] = useState<ExtraPanel>(null)
  /**
   * 风格筛选浮层（2026-10 用户要求：从顶栏搬到中栏头这一排）。
   *
   * 与 0.6.0 的「分辨率 / 存为集合」同样的处理方式：**单独的展开态字段**，
   * 不并进上面那个 `QuickPanel` 联合类型 —— `tests/marks.test.ts` 把
   * `type QuickPanel = 'size' | 'time' | 'color' | null` 这一行字面量当契约钉住了。
   * 定位与关闭仍是**同一套机制**：共用 `quickPos` 与下面那个 effect（点外部 / Esc / resize）。
   */
  const [stylePanel, setStylePanel] = useState(false)
  const [quickPos, setQuickPos] = useState<{ left: number; top: number } | null>(null)
  /** 两个触发按钮 + 浮层的公共容器：判断「点击是否发生在浮层内部」用 */
  const quickRef = useRef<HTMLDivElement | null>(null)

  // ── 排序胶囊的自绘浮层（2026-10 用户反馈）───────────────────────────
  // 原来用原生 `<select>`：`appearance-none` 只去掉了**控件外观**，展开的弹层
  // 仍是 Chromium/系统控件（灰底、系统字体、系统高亮），与本产品 UI 两个风格。
  // 现在换成 `button` + 自绘面板，定位 / 关闭套路与左侧「体积 / 时间 / 分辨率」
  // **完全同构**（fixed 定位 + 单选即收起 + 点外部 / Esc 关闭）。
  // 单独一份 state / ref：排序胶囊在 `quickRef` 容器**右侧之外**，不能共用 ref。
  const [sortPanel, setSortPanel] = useState(false)
  const [sortPos, setSortPos] = useState<{ left: number; top: number } | null>(null)
  /** 键盘高亮行（↑/↓ 移动；打开时落在当前生效项上） */
  const [sortCursor, setSortCursor] = useState(0)
  const sortRef = useRef<HTMLDivElement | null>(null)
  const sortButtonRef = useRef<HTMLButtonElement | null>(null)

  /** 点按钮：已展开则收起；否则按按钮矩形定位后展开（另一族浮层同时收起） */
  const toggleQuickPanel = (which: Exclude<QuickPanel, null>) =>
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (quickPanel === which) {
        setQuickPanel(null)
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      setQuickPos({ left: Math.round(rect.left), top: Math.round(rect.bottom + 6) })
      setQuickPanel(which)
      setExtraPanel(null)
      setStylePanel(false)
      setSortPanel(false)
    }

  /**
   * 0.6.0 浮层（分辨率 / 存为集合）的开关：定位规则与上面一致，
   * 唯一差别是「存为集合」**右对齐**（它在整排最右侧，左对齐会顶出窗口）。
   */
  const toggleExtraPanel = (which: Exclude<ExtraPanel, null>) =>
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (extraPanel === which) {
        setExtraPanel(null)
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      setQuickPos(
        which === 'save'
          ? { left: Math.max(8, Math.round(rect.right - SAVE_PANEL_WIDTH)), top: Math.round(rect.bottom + 6) }
          : { left: Math.round(rect.left), top: Math.round(rect.bottom + 6) }
      )
      setExtraPanel(which)
      setQuickPanel(null)
      setStylePanel(false)
      setSortPanel(false)
    }

  /**
   * 风格浮层（2026-10 从中栏头这一排的 chip 展开）：定位与上面两族**完全同构**
   * （fixed 定位 + 打开时取一次按钮矩形 + 右边界夹紧），并同时收起同排其它浮层。
   */
  const toggleStylePanel = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (stylePanel) {
      setStylePanel(false)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const maxLeft = Math.max(8, window.innerWidth - STYLE_PANEL_WIDTH - 8)
    setQuickPos({
      left: Math.max(8, Math.min(Math.round(rect.left), maxLeft)),
      top: Math.round(rect.bottom + 6)
    })
    setStylePanel(true)
    setQuickPanel(null)
    setExtraPanel(null)
    setSortPanel(false)
  }

  /**
   * 0.6.0「存为集合」：行内输入（**不用 window.prompt** —— 阻塞式原生弹窗在
   * Electron 里会卡住整窗，且无法在输入框下方显示「重名 / 上限」这类行内错误）。
   */
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveCurrentView = useVault((s) => s.saveCurrentView)
  const savedViewCount = useVault((s) => s.settings?.savedViews.length ?? 0)

  /** 「＋ 存为集合」按钮：走 `toggleExtraPanel('save')`（右对齐定位） */
  const openSavePanel = (e: React.MouseEvent<HTMLButtonElement>) => {
    setSaveName('')
    setSaveError(null)
    toggleExtraPanel('save')(e)
  }

  /** 回车提交：成功 → 收起；失败 → 错误留在输入框下方（不弹全局 notice） */
  const submitSaveView = async (): Promise<void> => {
    const res = await saveCurrentView(saveName)
    if (res.ok) {
      setExtraPanel(null)
      setSaveName('')
      setSaveError(null)
      return
    }
    setSaveError(res.message)
  }

  // 点浮层外 / 按 Esc / 窗口 resize 关闭。Esc 用捕获阶段并阻断继续传播：
  // 中栏头浮层在场时，这一下 Esc 只关浮层，不顺手清掉当前选中项（App 另有全局 Esc 处理）。
  // （`stylePanel` 是风格筛选，与这三族共用同一套关闭路径 —— 见上面的 state 注释。）
  useEffect(() => {
    if (!quickPanel && !extraPanel && !stylePanel) return
    const onPointerDown = (e: MouseEvent) => {
      const root = quickRef.current
      if (root && e.target instanceof Node && root.contains(e.target)) return
      setQuickPanel(null)
      setExtraPanel(null)
      setStylePanel(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setQuickPanel(null)
      setExtraPanel(null)
      setStylePanel(false)
    }
    // 浮层是 `fixed`、坐标在打开那一刻按按钮矩形算好 → 尺寸一变就脱离按钮，直接收起最稳
    const onResize = (): void => {
      setQuickPanel(null)
      setExtraPanel(null)
      setStylePanel(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [quickPanel, extraPanel, stylePanel])

  // 进入软件内文件视图时收起（该视图下中栏头换成「返回 + 资产名」，没有这些按钮）
  useEffect(() => {
    setQuickPanel(null)
    setExtraPanel(null)
    setStylePanel(false)
    setSortPanel(false)
  }, [folderViewAssetId])

  /**
   * 排序浮层的关闭路径：点浮层外 / Esc / 窗口 resize。
   *
   * - Esc 用**捕获阶段 + stopPropagation**：同一次 Esc 不能再被 App 的全局快捷键消费
   *   （回收站视图里 Esc 有别的含义，一次按键关两层是最烦人的那种交互）。
   * - resize 必须关：浮层是 `fixed`、坐标在打开那一刻按按钮矩形写死 → 尺寸一变就错位。
   */
  useEffect(() => {
    if (!sortPanel) return
    const onPointerDown = (e: MouseEvent): void => {
      const root = sortRef.current
      if (root && e.target instanceof Node && root.contains(e.target)) return
      setSortPanel(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setSortPanel(false)
    }
    const onResize = (): void => setSortPanel(false)
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [sortPanel])

  // ── 主题（UI 规范 §1 + 0.6.0 跟随系统）：settings.theme → <html data-theme> ──
  // `system` 必须解析：DOM 只认 light/dark（styles.css 没有 [data-theme='system']）。
  // 系统深浅色变化时（Windows 设置里切）要**实时**跟随，所以监听 matchMedia。
  const theme = useVault((s) => s.settings?.theme ?? 'light')
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(theme, systemDark)
  }, [theme, systemDark])
  // C#19（已拍板「保留但可关闭」）：中栏头帮助文本开关，默认 true
  const showHelpHint = useVault((s) => s.settings?.showHelpHint ?? true)
  // ── 动效性能档位（设置·外观「动效性能」，默认 balanced） ──────────────
  // 与上面的 `theme` / `showHelpHint` 同一种订阅写法：**订阅 store 的 settings 字段**，
  // 切档时 effect 自动重跑（不能用 `useVault.getState()` 一次性读，那样切档不生效）。
  // 写进 `logic/motionProfile` 的进程内单例后，three 场景在**构建时读一次**——
  // 这里只同步配置，不触发任何场景重建 / 重渲染。
  const motionQuality = useVault((s) => s.settings?.motionQuality ?? 'balanced')
  useEffect(() => {
    setMotionQuality(motionQuality)
  }, [motionQuality])

  // ── 左右侧边栏折叠（0.8.3）：状态在 Settings 里持久化，切换即时落库 ──────
  // 订阅写法与 theme / motionQuality 同款（订阅字段，不能用一次性读）。
  // 文件视图 / 舞台球飞行**不改**折叠状态（各有布局，互不干扰）；折叠后
  // 拖卡片到左栏归类自然不可用（展开即恢复），无需额外处理。
  const saveSettings = useVault((s) => s.saveSettings)
  const sidebarLeftCollapsed = useVault((s) => s.settings?.sidebarLeftCollapsed ?? false)
  const sidebarRightCollapsed = useVault((s) => s.settings?.sidebarRightCollapsed ?? false)
  const toggleLeftSidebar = (): void => {
    void saveSettings({ sidebarLeftCollapsed: !sidebarLeftCollapsed })
  }
  const toggleRightSidebar = (): void => {
    void saveSettings({ sidebarRightCollapsed: !sidebarRightCollapsed })
  }

  useEffect(() => {
    void init()
  }, [init])

  // ── 全窗拖拽导入 ──
  // 两类**非导入**拖拽必须在这里被识别出来，否则会走「拖包导入」链路：
  // ① 应用内归类拖拽（抓手 → 左栏）：有自定义 MIME `application/x-idbox-asset`；
  // ② 卡片拖出到建模软件（`webContents.startDrag` 的 OLE 拖拽被 OS 回放到本窗口）：
  //    `types` 只有 `['Files']`，与「从资源管理器拖文件进来」**长得一模一样**，
  //    唯一信号是 `dragOut.ts` 的时间窗标记（OLE 期间没有 DOM 事件可用来清标志）。
  //
  // ⚠️ 时间窗只用于**不显示导入遮罩**，不用来跳过 preventDefault —— 否则用户在拖出后
  //    10 秒内从资源管理器拖入真文件时会因为「没人 preventDefault 过 dragover」而收不到
  //    drop，合法导入被静默吞掉。真正的防回灌在 onDrop 的**库内路径过滤**（A 层）。
  useEffect(() => {
    let depth = 0
    const isAssignDrag = (e: DragEvent): boolean => hasAssetDragPayload(e.dataTransfer?.types)
    const isInternalDragOutEvent = (): boolean => isInternalDragOut()
    const onEnter = (e: DragEvent) => {
      e.preventDefault()
      if (isAssignDrag(e) || isInternalDragOutEvent()) return
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      // 归类拖拽由左栏节点自己接管；其余拖拽都要 preventDefault，drop 才会来
      if (isAssignDrag(e)) return
      e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      e.preventDefault()
      if (isAssignDrag(e) || isInternalDragOutEvent()) return
      depth--
      if (depth <= 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      // 归类拖拽：左栏 onDrop 已处理（并 stopPropagation），这里绝不能再当导入
      if (isAssignDrag(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      // 一次 drop = 上一个拖拽手势已结束 → 立刻清掉内部拖出的时间窗，
      // 否则紧接着的外部拖入会在这 10 秒里没有「松手即导入」遮罩（导入本身仍然正常）
      resetInternalDragOut()

      const files = Array.from(e.dataTransfer?.files ?? [])
      const rawPaths = files.map((f) => window.modvault.getPathForFile(f)).filter(Boolean)
      if (rawPaths.length === 0) return

      // ── A 层：库内路径回灌守卫（2026-10-21 数据事故） ──────────────
      // 卡片拖出后在窗口内松手 → drop 拿到的是**库内文件**，若交给 importPaths 会
      // staging → uniqueName 生成「名字-2…-6」副本，且 disposeArchive 可能把原文件送走。
      // 库目录从 store 现取（**不进 effect 依赖**：设置变更不应重挂 window 监听）。
      const libraryDir = useVault.getState().settings?.libraryDir
      const outside = pathsOutsideLibrary(libraryDir, rawPaths)
      if (outside.length > 0) void importPaths(outside)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [importPaths])

  // ── 快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'Escape') {
        const st = useVault.getState()
        /*
         * 「Esc 该谁吃」全部收口到纯函数（logic/escPriority.ts），这里只做 dispatch。
         *
         * 修的是 0.7.5 及以前的连带缺陷：原来尾部**无条件** `select(null)` +
         * `setSettingsOpen(false)`，前面只对 HDR 预览 / 删除确认 / 文件视图让路。于是
         * 开着「批量重命名」按 Esc 会先清空选中（右侧面板卸载、`renameIds` 还在 → 弹窗悬空）；
         * 封面选择器 / 彻底删除确认那种组件局部弹窗更是靠"选中被清 → 组件卸载"顺带关掉的，
         * 附带"重开还得重新选"的副作用。
         *
         * 那两类局部弹窗（DetailPanel 的 `coverPickerOpen`、AssetGrid / DetailPanel 的
         * `purgeIds`）不进输入：它们都由 `Modal` 承载，Esc 在捕获阶段就被 `Modal` 吃掉并
         * `stopPropagation`，本监听（冒泡阶段）根本收不到；`modalOpen` 是同一件事的显式
         * 兜底 —— 即使事件阶段语义有出入，也不会一次按键关两层。
         */
        const action = decideEsc({
          modalOpen: hasEscLayer(),
          hdrPreviewOpen: !!st.hdrPreviewAssetId,
          pendingDelete: !!st.pendingDelete,
          renameOpen: !!st.renameIds,
          categoryPickerOpen: !!st.categoryPickerIds,
          settingsOpen,
          folderViewOpen: !!st.folderViewAssetId,
          quickLookOpen: !!st.quickLookAssetId,
          hasSelection: !!selectedId || selectedIds.length > 0
        })
        switch (action) {
          case 'undo-delete':
            undoDelete()
            break
          case 'close-rename':
            st.closeRenameDialog()
            break
          case 'close-category-picker':
            st.closeCategoryPicker()
            break
          case 'close-settings':
            setSettingsOpen(false)
            break
          case 'close-folder-view':
            closeFolderView()
            break
          case 'close-quick-look':
            st.closeQuickLook()
            break
          case 'clear-selection':
            select(null)
            break
          default:
            // 'none'：弹窗 / HDR 预览自己处理这次 Esc（或没有任何可关的东西）
            break
        }
        return
      }
      // 0.8.3 Quick Look（docs/32 §4）：空格 = 全屏快览浮层，作用对象 = 当前选中资产。
      //
      // 事件先后：React 的合成事件挂在 **root container**（冒泡路径上比 window 更早），
      // 所以卡片自己的 `onKeyDown` 先跑。AssetGrid 里已经改成"纯空格不在卡片处理"
      // （只有 Ctrl/Cmd/Shift+空格仍走多选），于是纯空格原样冒泡到这里 —— 两处不能都
      // 处理，否则一次按键既选中又开浮层。反过来，window **捕获**阶段的 Esc 层监听
      // （`logic/escLayer.ts`）比 React 合成事件更早，这是 Esc 必须走层栈、而空格
      // 只能在这里 dispatch 的原因。
      if (e.key === ' ' || e.key === 'Spacebar') {
        if (typing) return
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
        const st = useVault.getState()
        // 浮层已经开着：**空格在这里不动作**，交给 `QuickLookOverlay` 自己处理 ——
        // 它认得空格（关闭）、←/→（换图），判据在 `logic/quickLook.ts::decideQuickLookKey`。
        // 为什么必须由浮层自己关：App 这条监听比浮层的先注册（先到先得），若这里也关，
        // 就会和浮层的 `preventDefault`/`onClose` 抢同一次按键，出现"关两次"的不确定行为。
        if (st.quickLookAssetId) return
        // 上面还有别的层（弹窗层 / HDR 预览）：空格不该越过它们
        if (hasEscLayer() || st.hdrPreviewAssetId) return
        const target = resolveQuickLookTarget({
          focusId: selectedId,
          selectedIds,
          folderViewAssetId: st.folderViewAssetId,
          visibleOrder: assets.map((a) => a.id)
        })
        if (!target) return
        // 空格在浏览器里有默认行为（滚动页面），必须吃掉
        e.preventDefault()
        st.openQuickLook(target)
        return
      }
      // P0-16：Delete/Backspace 只触发 requestDelete（二次确认 + 5 秒撤销），
      // 不再有「按键直接删」的路径；支持 Ctrl 多选后的批量删除。
      //
      // C 线：回收站视图里 Delete 不映射为删除——已删资产再软删一次会拿旧 folder 去搬，
      // 必然失败（文件已在 `.trash/`）。彻底删除是不可逆动作，必须走界面上的二次确认。
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (useVault.getState().libraryView === 'trash') return
        const ids = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : []
        if (ids.length > 0) {
          e.preventDefault()
          requestDelete(ids)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, selectedIds, select, requestDelete, undoDelete, closeFolderView, settingsOpen, assets])

  const totalSize = assets.reduce((s, a) => s + a.size, 0)
  // 用户反馈第 5 条：全局空态（拖包 + 导入 CTA）只在**库真为空**时出现。
  // 此前用 useVisibleAssets() 判断，库里有资产但筛选结果为 0 时会误显示全局空态，
  // 把 AssetGrid 的「没有匹配的资产」挤掉。判断必须用 store 的全量 assets。
  const allAssets = useVault((s) => s.assets)
  // C 线「最近删除」：视图状态决定"空库"判据——回收站里库为空不该显示"拖压缩包进来"的 CTA
  // （否则中栏被 CTA 占满，用户看不到回收站里的东西，也没法点左侧的「最近删除」）。
  const libraryView = useVault((s) => s.libraryView)
  const activeAssetCount = allAssets.reduce((n, a) => n + (isDeletedAsset(a) ? 0 : 1), 0)
  const empty = libraryView === 'assets' && activeAssetCount === 0

  // 「全选 / 取消全选」按钮的态：以**当前可见结果**为准（assets = useVisibleAssets()），
  // 不是全库——筛选态下点「全选」只应选中屏幕上的这些。判定复用纯函数（与 store 同一口径）。
  const allSelected = isAllSelected(
    selectedIds,
    assets.map((a) => a.id)
  )

  // ── 软件内文件视图（docs/15 §6c）：id 失效（被删 / 重扫丢弃）时视为未打开，退回网格 ──
  const folderAsset = folderViewAssetId
    ? (allAssets.find((a) => a.id === folderViewAssetId) ?? null)
    : null

  // ── HDR 预览（0.6.5）：store 里的 id → 真实资产；资产被删 / 被筛掉时自动卸弹窗 ──
  const hdrPreviewAssetId = useVault((s) => s.hdrPreviewAssetId)
  const closeHdrPreview = useVault((s) => s.closeHdrPreview)
  const hdrPreviewAsset = hdrPreviewAssetId
    ? (allAssets.find((a) => a.id === hdrPreviewAssetId) ?? null)
    : null

  // ── Quick Look（0.8.3）：store 里的 id → 真实资产；store 的 5 个清理站点（硬删 / 软删 /
  //      彻底删除 / rescan / 进回收站）都会把 id 置 null，这里再兜一次：万一浮层打开后资产
  //      在别处被搬走，宁可整层消失，也不要显示一个指向已不存在资产的浮层。 ──
  const quickLookAssetId = useVault((s) => s.quickLookAssetId)
  const closeQuickLook = useVault((s) => s.closeQuickLook)
  const quickLookAsset = quickLookAssetId
    ? (allAssets.find((a) => a.id === quickLookAssetId) ?? null)
    : null

  /**
   * 整理流水线（P2）：只读一个布尔。
   *
   * 这里**不做**"当前资产还在不在"的兜底 —— 那个判断在浮层内部（`useTriageQueue`
   * + `reconcileTriage`）：待办集每帧现算，当前项没了就接位，整集空了就自己关闭。
   * 在 App 里再判一次会变成第二套真相，而且 App 不知道"跳过集"，判不准。
   */
  const triageActive = useVault((s) => s.triageActive)

  /**
   * 「发现新版本」弹窗是否显示（2026-11）。
   *
   * 判定全部在 `logic/updateState.ts` 的 `shouldShowUpdateDialog()`（纯函数，7 条规则）：
   * 这里只拿一个布尔，不参与任何逻辑。启动自动检查落结论 → `emit()` → 本值变 true，
   * 弹窗自然出现；用户点「稍后」/「跳过这个版本」→ 同样靠 `emit()` 变回 false。
   * ⚠️ 它**不会**在自动检查刚发起时就变 true（那时 state 还是 null），
   * 所以不会出现"刚启动就冒一个空弹窗"。
   */
  const updateDialogOpen = useUpdateDialogOpen()

  // A 线 T-03：舞台单例（球从卡片飞进顶栏）。状态机在 logic/ballStage.ts，这里只做订阅。
  const stageState = useSyncExternalStore(
    stageController.subscribe,
    stageController.get,
    stageController.get
  )
  const stageAsset = stageState.assetId
    ? (allAssets.find((a) => a.id === stageState.assetId) ?? null)
    : null

  /**
   * hover 预热：鼠标停在材质卡上时就把它交给舞台的球去解码贴图。
   * 舞台在 idle 态是 opacity:0、不跑 rAF，所以用户看不见 —— 但贴图已经进显存，
   * 双击时不掉帧（实测未预热：p95 99.7ms；预热后：见 tests 与走查记录）。
   */
  const previewId = useSyncExternalStore(
    stageController.subscribePreview,
    stageController.getPreview,
    stageController.getPreview
  )
  const preloadAsset = previewId
    ? (allAssets.find((a) => a.id === previewId) ?? null)
    : null

  // 文件视图关掉（Esc / 返回 / 任何路径）→ 球飞回卡片。
  // 用 folderViewAssetId 的变化兜住所有关闭入口，避免每条路径各写一次。
  useEffect(() => {
    if (!folderViewAssetId && stageController.get().phase !== 'idle') stageController.close()
  }, [folderViewAssetId])

  // 首次进过舞台（或首次预热）之后就不再卸载：否则每次回到网格都销毁 WebGL 上下文
  const [stageMounted, setStageMounted] = useState(false)
  useEffect(() => {
    if (stageState.assetId || previewId) setStageMounted(true)
  }, [stageState.assetId, previewId])
  // 「N 个文件 · 合计大小」；由 files 累加，不用 asset.size 快照（可能短暂漂移）
  const folderSummary = folderAsset ? summarizeAsset(folderAsset) : null

  // ── 中栏头（走查 v0.2.2 · 画布 2:79 / 深 2:356）：标题 = 当前最深一级筛选 ──
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  /** 色标是「属性筛选」，而重复资产是「换视图」：点色标时退出重复视图（与侧栏旧行为一致） */
  const setDupOnly = useVault((s) => s.setDupOnly)
  /**
   * 「重复资产」是视图模式而非筛选条件（`store.dupOnly`）。
   *
   * ⚠️ 必须**先订阅成普通变量**再参与判据：`useVault` 是 hook，若写成
   * `a && b && !useVault(...)`，短路求值会让这个 hook 在某些渲染里不被调用
   * → hook 顺序漂移，React 直接抛错。任何"用 store 值做布尔判据"的地方都遵守这条。
   */
  const dupOnly = useVault((s) => s.dupOnly)
  /** 设置里关掉色标入口时，中栏头这个 chip 不渲染（settings 未加载 → 按默认显示） */
  const showColorTagsEntry = useVault((s) => s.settings?.showColorTags !== false)
  /**
   * DEF-19-3：库目录漂移体检（只给分辨率浮层做就近提示用）。
   *
   * 用**全库 assets**（上面 `activeAssetCount` / `empty` 判据用的那一个，不是已筛选的
   * `assets`）：要回答的是"索引里有多少条路径已经不在当前库目录下"，与当前筛选无关；
   * 空库目录时纯函数返回全 0（不误报）。
   */
  const settingsLibraryDir = useVault((s) => s.settings?.libraryDir ?? '')
  const libraryDrift = useMemo(
    () => planLibraryDrift(allAssets, settingsLibraryDir),
    [allAssets, settingsLibraryDir]
  )
  /**
   * 浮层那行小字的内容（`null` = 不渲染）。裁决在纯函数里，单测可直接证明
   * 「选了档位 + 可见结果为 0 + 有路径漂移 → 提示出现」，组件这里不重复判条件。
   */
  const resolutionHint = resolutionDriftHint(libraryDrift, {
    minResolution: filters.minResolution,
    visibleCount: assets.length,
    inTrash: libraryView === 'trash'
  })

  // ── 搜索也是导航（与侧栏 `navTo` 同一条语义，2026-10 用户反馈第二个 bug）──
  // 文件视图打开时中栏被 `folderAsset` 分支占住，顶栏搜索框敲字只改 `filters.query`，
  // 画布不动。这里只在**搜索词变化**时判断（依赖数组只有 query）：
  // · 进入文件视图时不会触发 —— 否则「先搜索、再双击结果进文件列表」会被立刻弹出来；
  // · 首次敲字（query 变非空）时关一次；关完后 `folderViewAssetId` 已是 null，
  //   后面每敲一个字都直接跳过，不会反复 close（也不需要每敲一下都写 store）。
  const searchQuery = filters.query
  useEffect(() => {
    if (searchQuery.trim().length === 0) return
    const st = useVault.getState()
    if (st.folderViewAssetId) st.closeFolderView()
  }, [searchQuery])
  // ── 首页封面页（v0.9.4）：判据放在中栏头标题**之前** ─────────────────────
  /**
   * 首页 = 「全部」过滤态 + **无搜索词** + 非重复资产视图 + 未打开文件视图。
   *
   * 为什么搜索词必须单独判一次：`isAllViewActive` 把 `query` 当作"自己看得见的态"
   * （搜索框就在用户眼前，他知道自己搜了什么），所以「有搜索词、其余维度都干净」
   * 在它看来仍是「全部视图」——侧栏也确实该把「首页」高亮着。但首页**没有网格、也没有
   * 搜索态**：打第一个字就必须立刻离开首页去看搜索结果（产品口径 Q-R），否则用户会在
   * 一块没有结果列表的封面上看到一个"字打进去了、什么都没发生"的死界面。
   *
   * ⚠️ 不要在组件里手写多维 `&&` 链（仓库纪律）：维度语义统一由
   * `logic/filters.ts#isAllViewActive` 给出，这里只补它刻意不涵盖的三条
   * （`kind` / `query` / 视图）。
   *
   * ★ 2026-11-09 用户报「点文件夹只展开、缩不回」的**真正根因**就在这里：
   * `isAllViewActive()` 的实现是 `activeFilterDimensions(f).every(d => d.key === 'kind'
   * || d.key === 'query')` —— 它**刻意把 `kind` 和 `query` 排除在外**（那两个维度在
   * 侧栏有各自的可视入口，所以"只剩它们生效"时仍算全库视图）。于是点「模型」文件夹后
   * `filters.kind` 变成 `'model'`，`isAllViewActive` 仍返回 true → `isHome` 仍为 true
   * → `HomeCover` **不卸载** → 文件夹的 `data-open` 翻盖动画播完停在展开态，
   * 而跳转本该由"封面卸载"完成，于是表现成"点了只展开、永远展着"。
   * 这不是 `GlassFolder` 的动效 bug，是首页判据漏了一个维度。
   */
  const isHome =
    libraryView === 'assets' &&
    isAllViewActive(filters) &&
    // `kind` 必须显式为 `'all'`：它是"首页"与"某个分类"之间的**唯一分界**，
    // `isAllViewActive` 不看它（理由见上），所以这里必须自己补，否则点分类不生效。
    filters.kind === 'all' &&
    filters.query.trim() === '' &&
    !dupOnly &&
    !folderViewAssetId

  // 大类筛选可能是分组哨兵（materialGroup）→ 显示名统一走 kindFilterLabel
  const headerTitle =
    libraryView === 'trash'
      ? '最近删除'
      : filters.category2 ||
        filters.category1 ||
        // 兜底名的口径（v0.9.4 侧栏第一项由「全部」改名「首页」）：
        // 首页态走不到这里（渲染树里首页分支排在前面，不渲染中栏头），所以按 `isHome` 分档
        // 只是"口径一致"的意思；真正会落到这条兜底的是**搜索中**与**重复资产视图**两个可到达态
        // —— 那时网格里装的是全库的子集/重复组，标题写「首页」会是错的，必须仍是「全部」。
        (filters.kind !== 'all' ? kindFilterLabel(filters.kind) : isHome ? '首页' : '全部')
  const trashMode = libraryView === 'trash'
  // 「待补」计数：当前这批可见资产里还有多少要补分类（判据源在 logic/category.ts，
  // 套当前筛选；与侧栏分类树的「未分类」节点、整理流水线的双未分类都不是同一集合）。
  // 刻意不叫「未分类」—— docs/25「未分类三口径」已按语义统一，见该文件与三口径条目。
  const pendingCategory = assets.filter(isCategoryIncomplete).length

  /**
   * 首页文件夹排的数据：**与侧栏导航同序同源**（`HOME_FOLDER_KEYS` = `KIND_NAV_ORDER`
   * + 没进导航序但有落盘大类的那几类），计数只统计在库资产（软删的不算，与侧栏 /
   * 网格同一口径）。
   *
   * ── 为什么是 `HOME_FOLDER_KEYS` 而不是 `KIND_NAV_ORDER`（2026-11-09 P0）──────
   * 用户拖进来的 `.d5a` 导入成功（磁盘 + Dexie 都在、`deletedAt` 为空），但首页
   * 4 张卡里没有它、侧栏轨道也没有它（U-1 回签：导航序不含 D5A）→ 界面上零入口，
   * 用户原话「拖进去不在了，我找不到它」。现在候选集由 `logic/homeKinds.ts` 从
   * `KIND_FOLDER` 派生补齐（今天只补 `d5a`），**导航序与侧栏一个字节都没动**。
   *
   * ── 为什么末尾要 `.filter((f) => f.count > 0)`（用户 2026-11-09 原话）────────
   * 「我们目前其实没有其他选项的文件，那就把这个文件夹取消掉，变成下方 4 个文件夹」
   *
   * 落地口径是**通用规则**，不是硬删「其他」这个 key：**0 个素材的分类不占首页入口**。
   *   · 映射完再过滤，而不是把 `other` 从候选集里删掉 ——
   *     删 key 会波及侧栏导航（同一份 `KIND_NAV_ORDER` 驱动）与 `kind` 筛选，
   *     而且将来库里真出现「其他」素材时，入口还得再加回来。
   *   · 现在库是 4 类有素材（模型 / CAD图纸 / 材质 / HDRI）→ 首页排 4 张卡；
   *     哪天出现「其他」或 `.d5a` 素材，`count > 0` 自动把第 5 张卡带回来，
   *     无需改代码（用户库里有 1 个 D5A 时就是这条规则在生效）。
   *   · 卡片排布：`HomeCover` 的行宽上限是 820px（见该文件注释），
   *     1440 下 4×151 = 604 → 3 个间隙各 ≈72px，是"紧凑但不散架"的读数；
   *     第 5 张卡时 1440 下 5×151 = 755 ≤ 820 仍放得下，
   *     间隙缩到 ≈16px（(820−755)/4）—— 密但不重叠，属可接受，故不必为"5 张"再设特例。
   *   · 副作用（有意为之）：搜索面板的「分类」组与看板的分类数据都吃这份结果，
   *     空分类自然不会出现在搜索结果里（点进去也只会是空网格，本就不该有入口）。
   *
   * 缩略图取 3 张：优先"有可用缩略图"的，再按 `importedAt` 倒序（最新的在最前），
   * 不足 3 张补 `null` —— `GlassFolder` 的 `thumbs` 契约是**长度恒为 3**，
   * 由数据侧保证长度，组件侧就不用再判长度。
   */
  const homeFolders = useMemo<HomeFolderItem[]>(() => {
    const active = allAssets.filter((a) => !isDeletedAsset(a))
    return HOME_FOLDER_KEYS.map((node) => {
      /**
       * 成员集走 `kindsOfFilter`（**唯一语义入口**），不要在这里写
       * `node === MATERIAL_GROUP ? [...] : [node]`：
       * ① 材质分组 = texture + material；
       * ② 「模型」= model + **d5a**（2026-11-09 收口：d5a 是模型的一种格式，
       *    不是独立大类 —— 卡上的数字必须等于点进去后网格里的条数，否则用户会说
       *    「卡上写 62，进去 63」）。
       */
      const members = kindsOfFilter(node)
      const rows = members === null ? active : active.filter((a) => members.has(a.kind))
      const withThumb = rows
        .filter((a) => a.thumbStatus === 'ready' && a.thumbPath)
        .sort((x, y) => y.importedAt - x.importedAt)
      const thumbs: Array<string | null> = withThumb
        .slice(0, 3)
        .map((a) => thumbVaultUrl(a.thumbPath as string))
      while (thumbs.length < 3) thumbs.push(null)
      return {
        key: node as HomeFolderItem['key'],
        // 分组哨兵没有 KIND_LABEL（它是 texture + material 的导航合并节点）→ 手写「材质」；
        // 其余一律用 KIND_LABEL（「CAD图纸」「HDRI」「其他」都是既有 UI 文案，不要另写中文）
        label: node === MATERIAL_GROUP ? '材质' : KIND_LABEL[node as AssetKind],
        count: rows.length,
        thumbs
      }
    })
      // 空分类不占入口（见函数上方 doc：「其他」在库为空时自动收掉，有素材时自动回来）。
      // 放在 map 之后而不是 map 之前：`count` 是 map 内算出来的，过滤要读它。
      .filter((f) => f.count > 0)
  }, [allAssets])

  /** 首页数据看板：本月入库 / 库总量 / 待补分类（全部按在库资产统计） */
  const homeStats = useMemo<HomeStatsData>(() => {
    const active = allAssets.filter((a) => !isDeletedAsset(a))
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    return {
      monthImports: active.filter((a) => a.importedAt >= monthStart).length,
      totalAssets: active.length,
      pendingCategory: active.filter(isCategoryIncomplete).length
    }
  }, [allAssets])

  /**
   * 点首页文件夹 → 进对应分类。
   *
   * 顺序有意固定：先关文件视图（否则中栏会被 `folderAsset` 分支继续占住），
   * 再退出回收站（首页判据已含 `libraryView === 'assets'`，这里兜住"从回收站回来"），
   * 最后落筛选。`allViewFilterPatch()` 会把 `kind` 锁成 `'all'`（它是"回到全库"的语义），
   * 所以**必须在它之后**覆盖 `kind`，否则点文件夹会回到首页而不是那个分类。
   * `kind` 接受分组哨兵 `'materialGroup'`，与侧栏「材质」节点完全同一套值。
   */
  const openKindFromHome = (key: HomeFolderItem['key']): void => {
    const st = useVault.getState()
    if (st.folderViewAssetId) st.closeFolderView()
    if (st.libraryView !== 'assets') st.setLibraryView('assets')
    setDupOnly(false)
    setFilter({
      ...allViewFilterPatch(),
      kind: key === MATERIAL_GROUP ? MATERIAL_GROUP : key,
      query: ''
    })
  }

  // ── 首页 → 分类库的过场（2026-11 第三轮口径：文件夹**本体**飞中 + 中心消隐）──────
  //
  // 手绘画像：双击文件夹 → 它自己（玻璃本体 + 三张扇形卡 + 名字）飞到屏幕正中停住
  // → 其余信息向屏幕边缘退开 → 停 240ms → 从中心挖洞化开 → 切视图 → 库里的卡片从两侧
  // 滑入。分三段实现：
  //   ① `GlassFolder` 卸载前量好起点矩形 + 背板缩略图（`GlassFolderOpenPayload`）；
  //   ② `HomeCover` 用这份矩形算退场几何，交给那个文件夹自己飞（CSS transform）并驱动
  //      rAF 做中心消隐；`<HomeOutro>` 只负责铺一块**透明遮罩**吃点击；
  //   ③ 消隐结束（880ms）那一刻才真正切视图，并把 `enterFromHome` 交给 `AssetGrid`
  //      播「卡片从两侧滑入」。
  /** 非 null = 过场进行中（`HomeOutro` 播完回调里清回 null） */
  const [homeOutro, setHomeOutro] = useState<GlassFolderOpenPayload | null>(null)
  /**
   * 刚才是从首页转场进来的（`AssetGrid` 据此播"卡片从两侧边缘滑入"）。
   *
   * 生命周期：切视图那一帧置 true（与 `openKindFromHome` 同批 → 网格**挂载时就带着它**，
   * 入场动画从第一帧开始跑）；`HOME_GRID_ENTER_MS` 后置 false。
   * 必须在卸载时清定时器（下面那个 effect 与 `outroTimersRef` 共用），否则切走之后
   * 还会对已卸载组件 setState。
   */
  const [gridEnterFromHome, setGridEnterFromHome] = useState<boolean>(false)
  /** 过场期间排的定时器：卸载时**必须**全清（否则切走后还会 setState / 二次跳转） */
  const outroTimersRef = useRef<number[]>([])
  /** 减少动效：双击 / Enter 直接进库，不铺遮罩（读一次即可，理由见 readPrefersReducedMotion） */
  const [prefersReducedMotion] = useState<boolean>(readPrefersReducedMotion)

  useEffect(() => {
    return () => {
      for (const id of outroTimersRef.current) window.clearTimeout(id)
      outroTimersRef.current = []
    }
  }, [])

  /**
   * 双击 / Enter 某个首页文件夹 → 带过场地进入该分类。
   *
   * 与 `openKindFromHome` 的分工：这里只管**节奏**，落筛选仍然调它 ——
   * 保证「点文件夹进分类」「从搜索进分类」「侧栏点分类」落到同一套筛选组合上，
   * 不会出现两套口径。
   *
   * 两个短路条件：
   * · `prefersReducedMotion`：系统要求减少动效 → 直接切，不铺遮罩、不传 `enterFromHome`
   *   （无障碍优先；网格那边也有一层同样的兜底）；
   * · `homeOutro !== null`：已经在过场里了（遮罩会吃点击，理论上进不来）→
   *   直接切，绝不叠第二层动画。第二条同时兜住"连按两次 Enter"。
   *
   * 两个定时器（都在 `outroTimersRef` 里，卸载时统一清）：
   * · `HOME_OUTRO_SWITCH_MS`（600）：切视图 + 置 `enterFromHome=true`；
   * · `HOME_GRID_ENTER_MS`（1100，从切视图算）：清回 false。
   * 两个 setState 与 `openKindFromHome` 在同一个回调里 → React 18 合并成一次渲染，
   * 所以网格挂载那一帧就已经拿到了 `enterFromHome`，不会出现"先挂载再改标记"的闪烁。
   */
  const activateKindFromHome = (key: HomeFolderItem['key'], payload: GlassFolderOpenPayload): void => {
    if (prefersReducedMotion || homeOutro !== null) {
      openKindFromHome(key)
      return
    }
    setHomeOutro(payload)
    outroTimersRef.current.push(
      window.setTimeout(() => {
        setGridEnterFromHome(true)
        openKindFromHome(key)
        outroTimersRef.current.push(
          window.setTimeout(() => {
            setGridEnterFromHome(false)
          }, HOME_GRID_ENTER_MS)
        )
      }, HOME_OUTRO_SWITCH_MS)
    )
  }

  /**
   * 首页搜索面板取结果的纯函数（`HomeSearchCommand` 每次按键调一次）。
   *
   * 为什么返回「函数」而不是数组：查询词由搜索组件内部持有（受控输入框），
   * 父级不该为每一次按键重渲染整个首页。这里交出的是「给我词、我给你分组」，
   * 用 `useCallback` 固定引用，`activeAssets` 不变时函数引用也不变。
   *
   * 分组口径（产品定义，改动需走需求）：
   * - 「分类」：5 个首页文件夹节点，按 label 命中；
   * - 「素材」：在库资产按名称命中，最多 8 条 —— 面板是「跳过去」的入口，
   *   不是结果页，再多就该去网格里搜了；
   * - 空查询返回**全部**两组（组件一展开就必须有内容，否则像个坏掉的面板）。
   */
  const activeForSearch = useMemo(() => allAssets.filter((a) => !isDeletedAsset(a)), [allAssets])

  const homeSearchGroups = useCallback(
    (rawQuery: string): HomeSearchGroup[] => {
      const q = rawQuery.trim().toLowerCase()
      const hit = (text: string): boolean => q === '' || text.toLowerCase().includes(q)

      const folderItems: HomeSearchItem[] = homeFolders
        .filter((f) => hit(f.label))
        .map((f) => ({
          id: `kind:${f.key}`,
          label: f.label,
          meta: `${f.count} 个素材`
        }))

      const assetItems: HomeSearchItem[] =
        q === ''
          ? []
          : activeForSearch
              .filter((a) => hit(a.name))
              .slice(0, 8)
              .map((a) => ({
                id: `asset:${a.id}`,
                label: a.name,
                // 二级分类优先（更具体），没有就退回大类中文名
                meta: a.category2 && a.category2 !== '未分类' ? a.category2 : KIND_LABEL[a.kind],
                /* 行首 36×36 缩略图（v0.10.x 用户反馈：「如果给的是纯文字版，
                 * 不会特别直观，也不会快」）。与网格卡片封面**完全同源**：
                 * 只有缩略图已经生成好（thumbStatus==='ready'）才给 URL，
                 * 否则给 null —— 组件那边会把没有 thumb 的行退化成 44px 纯文字行，
                 * 不渲染空槽。分类条目刻意**不给** thumb：它是导航，不是素材。 */
                thumb:
                  a.thumbStatus === 'ready' && a.thumbPath ? thumbVaultUrl(a.thumbPath) : null
              }))

      const groups: HomeSearchGroup[] = [
        { title: '分类', items: folderItems },
        { title: '素材', items: assetItems }
      ]
      // 空分组不发出去：否则面板会渲染一个只有标题没有内容的段落
      return groups.filter((g) => g.items.length > 0)
    },
    [homeFolders, activeForSearch]
  )

  /**
   * 搜索面板选中某一项。
   *
   * `kind:` 前缀 → 与点文件夹完全同一条路径（`openKindFromHome`），
   * 保证「从搜索进分类」和「点文件夹进分类」落到同一个筛选组合上。
   * `asset:` 前缀 → 直接开该资产的文件夹视图，比先跳网格再让人自己找少一步。
   */
  const pickFromHomeSearch = (item: HomeSearchItem): void => {
    const sep = item.id.indexOf(':')
    const type = item.id.slice(0, sep)
    const value = item.id.slice(sep + 1)
    if (type === 'kind') {
      openKindFromHome(value as HomeFolderItem['key'])
      return
    }
    if (type === 'asset') {
      const st = useVault.getState()
      if (st.libraryView !== 'assets') st.setLibraryView('assets')
      setDupOnly(false)
      setFilter({ ...allViewFilterPatch(), query: '' })
      st.openFolderView(value)
    }
  }

  // v0.4 数值筛选摘要（体积 / 导入时间）：无生效条件时返回 ''，不渲染、不占位。  // 纯函数在 logic/filters.ts（可单测），组件只负责摆位置。
  // 2026-10：摘要跟着中栏头的「体积 / 时间」按钮走（侧栏那块已移除）。
  const numericSummary = describeNumericFilters(filters)
  const sizeFilterActive = activeSizeRange(filters) !== null
  const timeFilterActive = activeImportedRange(filters) !== null
  /** 0.6.0 分辨率档：非 null 即激活（'2k' / '4k' 都是「有下界」） */
  const resolutionFilterActive = filters.minResolution !== null
  /** 「存为集合」不可用：回收站视图（筛选不生效）或已达上限 */
  const saveViewDisabled = trashMode || savedViewCount >= SAVED_VIEW_LIMIT
  /** 色标是多选维度：只要有选中就算激活，chip 上带数量 */
  const colorFilterActive = filters.colorTags.length > 0

  // ── 风格筛选（2026-10 用户要求：入口从顶栏搬到中栏头这一排）─────────────
  /**
   * 风格 → 资产数（纯逻辑在 `filters.ts` 的 `styleCountsFor`，组件只做 useMemo 接线）。
   *
   * ⚠️ 统计范围 = **当前大类视图内**（`kindsOfFilter(filters.kind)` 先过滤 `allAssets`），
   * 不是全库。用户反馈「材质面板的顶栏不需要风格」的根因就在这里：以前拿全库计数，
   * 材质视图里也能看到风格 chip，点进去必然 0 条（材质根本不挂风格）。
   * 软删记录由 `styleCountsFor` 内部跳过。
   */
  const styleCounts = useMemo(() => {
    const kinds = kindsOfFilter(filters.kind)
    const scoped = kinds ? allAssets.filter((a) => kinds.has(a.kind)) : allAssets
    return styleCountsFor(scoped)
  }, [allAssets, filters.kind])
  /**
   * 入口可见性**统一走能力表**（`shared/classify` 的 `capsOfFilter`）：
   * - 分辨率：模型 / 其他视图不给（模型封面是 720px 渲染图，按它筛没有意义）；
   * - 风格：材质族 / HDR / 其他不给，且该视图内没有可选风格、也没有筛选在生效时不给
   *   （避免空浮层 / 避免筛不掉）。
   * ⚠️ 不要在组件里按大类名字硬编码判断（分组哨兵会被漏掉，将来加维度也必然漏改；
   * `tests/filterCaps.test.ts` 有源码守卫盯着）。
   *
   * 例外（2026-10-29 用户要求）：`体积` / `分辨率` / `格式` 三个入口在**「全部」视图下不再显示**。
   * 为什么单独排除而不是改 `capsOfFilter`：能力表的 `'all' = 并集` 是全局语义
   * （其它维度、`tests/filterCaps.test.ts`、`sanitizeFiltersForKind` 都依赖它）。
   * 「全部」视图下这些筛选仍然**生效**（filters 状态照旧保留），只是不给入口 ——
   * 用户进到具体大类里照样能看到并调整。
   */
  const hideInAllView = filters.kind === 'all'
  /** 体积：本来无条件渲染，「全部」下也要收起来（与分辨率 / 格式同一口径） */
  const showSizeEntry = !hideInAllView
  const showResolutionEntry = capsOfFilter(filters.kind, 'resolution') && !hideInAllView
  /** 模型格式（全部 / SU / 3DMAX）：只有模型视图开放（能力表唯一判定，与分辨率同一机制） */
  const showModelFormatEntry = capsOfFilter(filters.kind, 'modelFormat') && !hideInAllView
  const modelFormatFilterActive = filters.modelFormat !== null
  /**
   * 「全部」视图的隐形筛选兜底（2026-10-30 用户实测）：`体积` / `分辨率` / `格式` 三个 chip
   * 在「全部」视图被 `hideInAllView` 隐藏入口，但筛选值仍然生效 —— 用户肉眼看不出
   * （报的场景就是"格式=SU 仍在跑，界面无任何提示，全库 135 只剩 75"）。
   * 维度名列表由 `logic/filters.ts` 的 `hiddenActiveFilterLabels` 给出（纯函数、可单测），
   * 这里只负责渲染与一键清除。
   */
  const hiddenActiveLabels = hiddenActiveFilterLabels(filters)
  const showStyleEntry =
    capsOfFilter(filters.kind, 'style') && (styleCounts.length > 0 || filters.styles.length > 0)
  /** 风格是多选维度：只要有选中就算激活，chip 上带数量（与色标同规矩） */
  const styleFilterActive = filters.styles.length > 0
  /**
   * 切到回收站视图、或切到**不支持风格**的大类（材质族 / HDR / 其他）时把风格浮层收起：
   * 那些视图下入口不渲染（面板不再渲染），若不收状态，切回来时会"凭空"弹出一个浮层。
   * 筛选值本身由 store 的 `sanitizeFiltersForKind` 清掉（两者分工不同）。
   */
  useEffect(() => {
    if (trashMode || !showStyleEntry) setStylePanel(false)
  }, [trashMode, showStyleEntry])
  /**
   * 切到**不支持分辨率**的大类（模型 / 其他）时把分辨率浮层收起：
   * 入口消失、状态还开着的话，浮层会浮在一个没有触发按钮的位置上。
   * 筛选值本身由 store 的 `sanitizeFiltersForKind` 清掉（两者分工不同）。
   */
  useEffect(() => {
    if (!showResolutionEntry) setExtraPanel((p) => (p === 'resolution' ? null : p))
    // 模型格式浮层同理：切到材质 / HDR / 其他视图时收起（筛选值由 store 归一化清掉）
    if (!showModelFormatEntry) setExtraPanel((p) => (p === 'format' ? null : p))
    // 体积浮层走的是另一族 `quickPanel`：入口被「全部」视图收起时同样要收，
    // 否则 chip 消失了浮层还浮在屏幕上（没有触发按钮，点不到关闭）。
    if (!showSizeEntry) setQuickPanel((p) => (p === 'size' ? null : p))
  }, [showResolutionEntry, showModelFormatEntry, showSizeEntry])

  // ── 排序胶囊（自绘浮层）────────────────────────────────────────────
  /** 胶囊上显示的当前排序名；`SORT_OPTIONS` 与 `SortKey` 同源，兜底防止脏值留下空白胶囊 */
  const sortLabel = SORT_OPTIONS.find((o) => o.value === filters.sort)?.label ?? '排序'
  /** 当前生效项在 `SORT_OPTIONS` 里的下标（键盘高亮初始位置） */
  const sortActiveIndex = SORT_OPTIONS.findIndex((o) => o.value === filters.sort)
  /**
   * 当前**实际生效**的方向（`sortDesc === null` → 该键的自然方向）。
   * 按钮的图标浓淡 / `title` / `aria-label` 全读这一个值：原始 `sortDesc` 是三态，
   * 直接渲染会出现"按大小明明是降序，按钮却显示升序"的错位。
   */
  const sortDescNow = effectiveSortDesc(filters.sort, filters.sortDesc)
  /** 方向按钮唯一的说明文案（`title` 与 `aria-label` 同源，避免两处漂移） */
  const sortDirHint = sortDescNow ? '当前降序，点击切换为正序' : '当前正序，点击切换为降序'

  /**
   * 打开浮层：按**触发按钮**矩形定位（右对齐，避免顶出窗口右缘），
   * 同时收起同排另外两族浮层（体积 / 时间 / 色标 / 分辨率 / 存为集合）。
   */
  const showSortPanel = (anchor: HTMLElement | null, cursor?: number): void => {
    const rect = anchor?.getBoundingClientRect()
    if (rect) {
      setSortPos({
        left: Math.max(8, Math.round(rect.right - SORT_PANEL_WIDTH)),
        top: Math.round(rect.bottom + 6)
      })
    }
    setSortCursor(cursor ?? (sortActiveIndex >= 0 ? sortActiveIndex : 0))
    setSortPanel(true)
    setQuickPanel(null)
    setExtraPanel(null)
    setStylePanel(false)
  }

  /** 点胶囊：展开中则收起；否则展开 */
  const toggleSortPanel = (): void => {
    if (sortPanel) {
      setSortPanel(false)
      return
    }
    showSortPanel(sortButtonRef.current)
  }

  /** 选中一项：写回 `filters.sort`（取值域与 `SortKey` 不变）并立即收起 */
  const applySort = (value: SortKey): void => {
    // 只写 `sort`：**换键时方向回自然方向**这条规则落在 store 的 `setFilter` 里
    // （`sortChangePatch` 是它的纯函数内核），这样任何设置 sort 的入口都自动遵守，
    // 不会出现「popover 重置了、恢复集合没重置」这种两套行为。
    setFilter({ sort: value })
    setSortPanel(false)
  }

  /**
   * 方向按钮：**只翻方向，不收起浮层**（用户常在「选键 → 试方向」之间来回点）。
   *
   * 写的是**生效值取反**，不是三态轮转：`sortDesc === null`（= 自然方向）时按大小
   * 本来就是降序，第一次点击必须真的变成升序，否则按钮看起来"按了没反应"。
   */
  const toggleSortDesc = (): void => {
    setFilter({ sortDesc: !sortDescNow })
  }

  /**
   * 键盘操作（挂在胶囊 + 浮层共同的容器上，事件从当前焦点元素冒泡上来）：
   * - ↑/↓ 移动高亮（循环），未展开时 ↓ 展开；
   * - Enter 应用高亮项；
   * - Esc 由上面的 window 捕获监听处理（这里不重复）。
   */
  const onSortKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!sortPanel) {
        showSortPanel(sortButtonRef.current, sortActiveIndex >= 0 ? sortActiveIndex : 0)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSortCursor((i) => (i + step + SORT_OPTIONS.length) % SORT_OPTIONS.length)
      return
    }
    if (e.key === 'Enter' && sortPanel) {
      // preventDefault：胶囊是个 button，Enter 的默认行为会再触发一次 click（把刚关掉的面板又打开）
      e.preventDefault()
      const opt = SORT_OPTIONS[sortCursor]
      if (opt) applySort(opt.value)
    }
  }

  // 布局（规范 §3.1）：顶栏全窗宽（含窗口控制），其下 左栏 / 中栏 / 右栏 三列
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶栏搜索（v0.10.x）：与首页**同一个**变形搜索框组件，`variant="toolbar"`
          让它从左上角向右下展开；查询词受控写回 `filters.query`，中栏靠它实时过滤。
          `groups` / `onPick` 与首页 `HomeCover` 共用同一对，口径完全一致。 */}
      <Toolbar
        view={view}
        onView={setView}
        homeMode={isHome}
        searchGroups={homeSearchGroups}
        onPickSearch={pickFromHomeSearch}
      />

      <div className="flex min-h-0 flex-1">
        {/* 0.8.3 左栏折叠：包裹层动画宽度 + 裁切，Sidebar 内容保持 216 固定宽不变形。
            v0.9.4 首页态：左栏**始终折起**（传 `isHome || 用户偏好`，180ms 滑动动画复用
            `CollapsibleColumn` 既有实现，不做第二套动效）。
            2026-11-09 侧栏换皮后语义分叉：**用户手动折叠 = 收成 48px 轨道窄条**（只留
            图标与钩线，仍可点）；**首页态 = 仍按 0 宽隐藏**（封面页要干净）。判据就是
            `isHome ? 0 : SIDEBAR_RAIL_W`。 */}
        <CollapsibleColumn
          id="sidebar-left"
          collapsed={isHome || sidebarLeftCollapsed}
          width={SIDEBAR_W}
          railWidth={isHome ? 0 : SIDEBAR_RAIL_W}
        >
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} collapsed={sidebarLeftCollapsed && !isHome} />
        </CollapsibleColumn>
        {/* 左栏折叠后的唤出按钮（展开时可点它收起），位于中栏最左缘。
            首页态**不渲染**：封面页要干净，两枚边缘唤出箭头会把「一整块封面」割成三段。
            `collapsed` 入参跟着传 `isHome || 原值`，保证图标方向与真实折叠态一致。 */}
        {!isHome && (
          <SidebarEdgeToggle side="left" collapsed={isHome || sidebarLeftCollapsed} onToggle={toggleLeftSidebar} />
        )}

        {/* 2026-10：中栏 + 右栏包一层 `relative`，用来挂舞台遮罩（`#stage-veil`）。
            flex 分配不变 —— wrapper 接管中栏原来的 `min-w-0 flex-1`，内部再分给中栏与右栏。
            这里没有重新缩进内部 400 行 JSX（纯缩进变更会让 diff 失去可读性）。 */}
        <div className="relative flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!ready ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">正在加载素材库…</div>
          ) : isHome ? (
            /* 首页封面页（v0.9.4）：**排在 `empty` 之前** —— 空库也要渲染封面页
               （文件夹显示 0 + 「还没有素材」），不能被"拖压缩包进来"的 CTA 顶掉：
               首页是导航第一项，任何时候点它都该回到同一块封面。 */
            <HomeCover
              folders={homeFolders}
              stats={homeStats}
              searchGroups={homeSearchGroups}
              onPickSearch={pickFromHomeSearch}
              onOpenKind={activateKindFromHome}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : empty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              {/* 图标规格 A：空态图形走统一 SVG（40px、单色 currentColor） */}
              <IconEmptyLibrary className="text-tertiary" />
              <h2 className="text-lg font-semibold">把知末网的压缩包拖进来</h2>
              <p className="max-w-md text-center text-[13px] leading-relaxed text-muted">
                自动解压 → 按类型归档到「模型 / 材质 / HDRI / 其他」→ 原压缩包进回收站。
                <br />
                支持 zip / rar / 7z（rar、7z 需要本机装有 7-Zip），也可以直接拖入已解压的文件夹。
              </p>
              <div className="flex gap-2">
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    const files = await window.modvault.pickArchives()
                    if (files.length > 0) void importPaths(files)
                  }}
                >
                  <IconDownload />
                  选择压缩包导入
                </button>
                <button className="btn" onClick={() => setSettingsOpen(true)}>
                  <IconPlus />
                  先设好库目录
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 走查 v0.2.2 · 中栏头（画布浅 2:79 / 深 2:356）：h32、gap10、无描边——
                  ① 当前分类标题 17px Semi Bold primary ② 计数 12px tertiary
                  ③ 体积 / 时间两个紧凑筛选按钮（2026-10 从侧栏移入，排序胶囊左侧）
                  ④ 排序胶囊（有底）。
                  排序从顶栏移到这里（用户拍板 2026-10-15），顶栏不再放排序。

                  文件视图（docs/15 §6c）：同一行换成「← 返回 + 资产名 + N 个文件 · 合计大小」。
                  排序胶囊与下方帮助文本对文件列表无意义 → 该视图下不渲染。 */}
              <div className="flex shrink-0 items-center gap-2.5 px-5 pt-4">
                {folderAsset ? (
                  <>
                    {/* 复用 `.btn` + `.btn-ghost` token（不新造按钮样式），只收窄内边距 */}
                    <button
                      className="btn btn-ghost shrink-0 !px-2 !py-1"
                      onClick={closeFolderView}
                      title="返回资产列表（Esc）"
                    >
                      <span aria-hidden className="text-[13px] leading-none">
                        ←
                      </span>
                      返回
                    </button>
                    <span
                      className="min-w-0 truncate text-[17px] font-semibold text-primary"
                      title={displayName(folderAsset.name)}
                    >
                      {displayName(folderAsset.name)}
                    </span>
                    {/* C#17：灰阶分主题走 .header-count（浅 tertiary / 深 muted） */}
                    <span className="header-count shrink-0">{folderSummary?.text}</span>
                  </>
                ) : (
                  <>
                    {/* 宽度纪律：标题 `min-w-0 truncate`（窗口变窄先压缩标题），
                        计数 / 按钮组 / 排序胶囊 `shrink-0`（不许换行、不许被挤掉）。 */}
                    <span className="min-w-0 truncate text-[17px] font-semibold text-primary">
                      {headerTitle}
                    </span>
                    {/* C#17：计数灰阶分主题（浅 tertiary #6B7280 / 深 muted #636368）
                        → 不能共用 text-tertiary，走 .header-count */}
                    <span className="header-count shrink-0">
                      {assets.length} 项
                      {!trashMode && pendingCategory > 0 ? ` · 待补 ${pendingCategory}` : ''}
                      {` · ${formatBytes(totalSize)}`}
                    </span>
                    {/* 2026-10 多选入口补齐：计数旁的文字按钮（12px，复用既有字色 token）。
                        当前可见结果已全选 → 变成「取消全选」；Ctrl/Cmd+A 是同一个动作。
                        只在有可见结果时出现（空结果点全选没有意义）。 */}
                    {assets.length > 0 && (
                      <button
                        type="button"
                        className="shrink-0 text-[12px] text-secondary transition hover:text-primary"
                        aria-pressed={allSelected}
                        title={
                          allSelected
                            ? '取消全选（Ctrl/Cmd+A 也可全选当前结果）'
                            : '全选当前筛选结果（快捷键 Ctrl/Cmd+A）'
                        }
                        onClick={() => selectAll(allSelected ? [] : assets.map((a) => a.id))}
                      >
                        {allSelected ? '取消全选' : '全选'}
                      </button>
                    )}
                    <div className="min-w-2 flex-1" />

                    {/* ── 体积 / 导入时间（2026-10 用户反馈：从侧栏快速筛选移到这里） ──
                        排序胶囊**左侧**两个紧凑按钮，复用既有 chip token（不新造颜色）。
                        点击展开 fixed 定位的小浮层（单选，选中即应用并收起）；
                        有条件生效时按钮为激活态，旁边跟一行极小的条件摘要。 */}
                    <div ref={quickRef} className="flex shrink-0 items-center gap-1">
                      {/* 回收站视图里这两个维度不生效（见 matchesFilters：trash 只吃搜索词）→
                          直接置灰禁用，避免"点了筛选回收站没变化"的困惑。筛选状态不清空，
                          回到资产视图后原样继续生效。
                          2026-10-29 用户要求：「全部」视图下不显示 `体积` / `分辨率` / `格式`
                          三个入口（`hideInAllView`），筛选值仍保留、进具体大类可见。 */}
                      {showSizeEntry && (
                        <button
                          className={`${sizeFilterActive ? 'chip-accent' : 'chip-ghost'} shrink-0 ${
                            trashMode ? 'cursor-not-allowed opacity-40' : ''
                          }`}
                          disabled={trashMode}
                          aria-pressed={sizeFilterActive}
                          aria-haspopup="dialog"
                          aria-expanded={quickPanel === 'size'}
                          title={trashMode ? '回收站不支持体积筛选（返回资产视图后可用）' : '按体积筛选（> 10MB / > 50MB / > 200MB）'}
                          onClick={toggleQuickPanel('size')}
                        >
                          体积
                        </button>
                      )}
                      <button
                        className={`${timeFilterActive ? 'chip-accent' : 'chip-ghost'} shrink-0 ${
                          trashMode ? 'cursor-not-allowed opacity-40' : ''
                        }`}
                        disabled={trashMode}
                        aria-pressed={timeFilterActive}
                        aria-haspopup="dialog"
                        aria-expanded={quickPanel === 'time'}
                        title={trashMode ? '回收站不支持导入时间筛选（返回资产视图后可用）' : '按导入时间筛选（近 7 天 / 近 30 天 / 今年）'}
                        onClick={toggleQuickPanel('time')}
                      >
                        时间
                      </button>
                      {/* 0.6.0 分辨率（与体积 / 时间同一视觉与交互族：单选、选中即收起）。
                          判定口径是「该资产任一图片文件的长边 ≥ 2048 / 4096」（HDR 视图看
                          全景宽度，档位 4K/8K/16K），未知尺寸（旧索引 / 非 PNG-JPEG）
                          **不进**这些档 → title 里说明。
                          **按视图决定是否渲染**：模型 / 其他视图没有这个维度（能力表
                          `capsOfFilter`），入口不出现；切走时 store 会把残留档位清掉。 */}
                      {showResolutionEntry && (
                        <button
                          className={`${resolutionFilterActive ? 'chip-accent' : 'chip-ghost'} shrink-0 ${
                            trashMode ? 'cursor-not-allowed opacity-40' : ''
                          }`}
                          disabled={trashMode}
                          aria-pressed={resolutionFilterActive}
                          aria-haspopup="dialog"
                          aria-expanded={extraPanel === 'resolution'}
                          title={
                            trashMode
                              ? '回收站不支持分辨率筛选（返回资产视图后可用）'
                              : resolutionChipTitle(filters.kind)
                          }
                          onClick={toggleExtraPanel('resolution')}
                        >
                          分辨率
                        </button>
                      )}
                      {/* 模型格式（2026-10「3DMAX 支持」，2026-11-09 加 D5A）：
                          全部 / SU / 3DMAX / D5A 单选。
                          与分辨率同一族（单选、点完即收起），只对**模型域**（model + d5a）生效
                          —— 判定在 `shared/modelFormat.isModelKind`，本组件不重复 kind 名单；
                          材质 / HDR / 其他视图不渲染（能力表 `capsOfFilter`），
                          切走时残留值由 store 的 `sanitizeFiltersForKind` 清掉。 */}
                      {showModelFormatEntry && (
                        <button
                          className={`${modelFormatFilterActive ? 'chip-accent' : 'chip-ghost'} shrink-0 ${
                            trashMode ? 'cursor-not-allowed opacity-40' : ''
                          }`}
                          disabled={trashMode}
                          aria-pressed={modelFormatFilterActive}
                          aria-haspopup="dialog"
                          aria-expanded={extraPanel === 'format'}
                          title={
                            trashMode
                              ? '回收站不支持模型格式筛选（返回资产视图后可用）'
                              : '按模型格式筛选（SU / 3DMAX / D5A；只对模型资产生效）'
                          }
                          onClick={toggleExtraPanel('format')}
                        >
                          格式
                        </button>
                      )}
                      {/* 色标（2026-10-25 反馈：从侧栏移到中栏头，与体积 / 时间同一视觉族）。
                          与前两个不同，色标是**多选**：点色点不自动收起浮层，
                          收起只走「点外部 / Esc」那条既有路径（见上面的 quickPanel effect）。
                          设置里关掉色标入口 → 不渲染（settings 未加载时按默认显示）。 */}
                      {showColorTagsEntry && (
                        <button
                          className={`${colorFilterActive ? 'chip-accent' : 'chip-ghost'} shrink-0 ${
                            trashMode ? 'cursor-not-allowed opacity-40' : ''
                          }`}
                          disabled={trashMode}
                          aria-pressed={colorFilterActive}
                          aria-haspopup="dialog"
                          aria-expanded={quickPanel === 'color'}
                          title={
                            trashMode
                              ? '回收站不支持色标筛选（返回资产视图后可用）'
                              : '按色标筛选（可多选，点色点不会收起）'
                          }
                          onClick={toggleQuickPanel('color')}
                        >
                          色标{colorFilterActive ? ` ${filters.colorTags.length}` : ''}
                        </button>
                      )}
                      {/* 风格（2026-10 用户反馈：「风格这个按钮应该是在体积、时间、分辨率、色标的
                          这个部分的顶栏，而不是在搜索旁边」→ 从顶栏搬到这一排）。
                          位置：色标之后、条件摘要之前，与同排 chip 同款外形（chip 尺寸 / 边框 / 字号）。
                          视觉口径**不变**：只有分类组走蓝 tint（chip-accent），风格一律 neutral ——
                          激活 = `bg-elevated` + `text-primary`，未激活 = `text-secondary`。
                          交互与色标同族（多选）：点 chip 不收起浮层，收起只走「点外部 / Esc / resize」；
                          回收站视图只吃搜索词 → 与体积 / 时间 / 色标同规矩：置灰禁用（不清空状态）。 */}
                      {showStyleEntry && (
                        <button
                          className={`inline-flex shrink-0 items-center gap-1 rounded-chip border border-line px-2 py-0.5 text-xs transition ${
                            styleFilterActive
                              ? 'bg-elevated font-medium text-primary'
                              : 'text-secondary hover:bg-elevated/60'
                          } ${trashMode ? 'cursor-not-allowed opacity-40' : ''}`}
                          disabled={trashMode}
                          aria-pressed={styleFilterActive}
                          aria-haspopup="dialog"
                          aria-expanded={stylePanel}
                          title={
                            trashMode
                              ? '回收站不支持风格筛选（返回资产视图后可用）'
                              : styleFilterActive
                                ? `按风格筛选（已选 ${filters.styles.length} 个，可多选）`
                                : '按风格筛选（可多选，命中任一即出）'
                          }
                          onClick={toggleStylePanel}
                        >
                          风格
                          {styleFilterActive ? (
                            <span className="tabular-nums">{filters.styles.length}</span>
                          ) : null}
                        </button>
                      )}
                      {!trashMode && numericSummary && (
                        <span
                          className="max-w-[132px] truncate text-[11px] text-tertiary"
                          title={`当前数值筛选：${numericSummary}`}
                        >
                          {numericSummary}
                        </span>
                      )}
                      {/* 「全部」视图的隐形筛选兜底（2026-10-30 用户实测报的死角）：
                          这三个维度的 chip 在这里被 `hideInAllView` 隐藏，但筛选值仍生效，
                          不给出口就等于"网格少了 60 个、界面毫无提示"。点一下即清除三个维度。
                          只在「全部」视图渲染（其他视图 chip 自己可见，不需要这条）。 */}
                      {!trashMode && hideInAllView && hiddenActiveLabels.length > 0 && (
                        <button
                          className="max-w-[132px] truncate text-[11px] text-tertiary transition hover:text-primary"
                          title={`体积 / 分辨率 / 格式的筛选在「全部」视图不显示入口，但仍会过滤（当前生效：${hiddenActiveLabels.join(
                            '、'
                          )}）。点击清除。`}
                          onClick={() =>
                            setFilter({
                              minBytes: null,
                              maxBytes: null,
                              minResolution: null,
                              modelFormat: null
                            })
                          }
                        >
                          全部视图已隐去 {hiddenActiveLabels.length} 个筛选
                        </button>
                      )}

                      {quickPanel && quickPos && (
                        // 色标面板要宽一点（2026-10-21 走查 P2⑨）：色点放大到 16px 后，
                        // 176px 装不下 6 个点 + 「清除」，会挤成一条点线。
                        <div
                          className={`fixed z-40 rounded-btn border border-line bg-card p-1 shadow-modal ${
                            quickPanel === 'color' ? 'w-[204px]' : 'w-[176px]'
                          }`}
                          style={{ left: quickPos.left, top: quickPos.top }}
                          role="dialog"
                          aria-label={
                            quickPanel === 'size'
                              ? '按体积筛选'
                              : quickPanel === 'time'
                                ? '按导入时间筛选'
                                : '按色标筛选'
                          }
                        >
                          <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">
                            {quickPanel === 'size'
                              ? '体积'
                              : quickPanel === 'time'
                                ? '导入时间'
                                : `色标（可多选${colorFilterActive ? `，已选 ${filters.colorTags.length}` : ''}）`}
                          </div>

                          {quickPanel === 'size' &&
                            SIZE_QUICK_OPTIONS.map((opt) => {
                              const active =
                                opt.bytes === null
                                  ? filters.minBytes === null && filters.maxBytes === null
                                  : sizePresetOf(filters) === opt.bytes
                              return (
                                <button
                                  key={opt.label}
                                  className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                                    active
                                      ? 'bg-accent-tint font-medium text-accent-text'
                                      : 'text-secondary hover:bg-elevated/60'
                                  }`}
                                  aria-pressed={active}
                                  onClick={() => {
                                    setFilter({ minBytes: opt.bytes, maxBytes: null })
                                    setQuickPanel(null)
                                  }}
                                >
                                  {opt.label}
                                </button>
                              )
                            })}

                          {quickPanel === 'time' &&
                            TIME_QUICK_OPTIONS.map((opt) => {
                              const active =
                                opt.key === null
                                  ? filters.importedAfter === null && filters.importedBefore === null
                                  : timePresetOf(filters) === opt.key
                              return (
                                <button
                                  key={opt.label}
                                  className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                                    active
                                      ? 'bg-accent-tint font-medium text-accent-text'
                                      : 'text-secondary hover:bg-elevated/60'
                                  }`}
                                  aria-pressed={active}
                                  onClick={() => {
                                    if (opt.key === null) {
                                      setFilter({ importedAfter: null, importedBefore: null })
                                    } else {
                                      const range = timePresetRange(opt.key)
                                      setFilter({
                                        importedAfter: range.importedAfter,
                                        importedBefore: null
                                      })
                                    }
                                    setQuickPanel(null)
                                  }}
                                >
                                  {opt.label}
                                </button>
                              )
                            })}

                          {/* 色标：多选。**点色点不收起浮层**（与体积 / 时间不同），
                              收起只走「点浮层外 / Esc」（上面 quickPanel 的 effect 已覆盖）。
                              `onClear` 只在有选中时传，没选中时不渲染「清除」按钮。 */}
                          {quickPanel === 'color' && (
                            <div className="pb-1">
                              <ColorTagPicker
                                selected={filters.colorTags}
                                onToggle={(tag) => {
                                  setDupOnly(false)
                                  setFilter({ colorTags: toggleColorTag(filters.colorTags, tag) })
                                }}
                                onClear={
                                  colorFilterActive ? () => setFilter({ colorTags: [] }) : undefined
                                }
                                size={16}
                                className="px-2 py-1"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* 风格浮层（多选，2026-10 从顶栏搬来）。
                          与「体积 / 时间 / 色标」同一套：`quickPos` 定位、`quickRef` 判内外、
                          「点外部 / Esc / 窗口 resize」三条关闭路径都在上面那个共用 effect 里。
                          点 chip **不收起浮层**（多选，与色标同规矩）。 */}
                      {stylePanel && quickPos && !trashMode && (
                        <div
                          className="fixed z-40 rounded-btn border border-line bg-card p-2 shadow-modal"
                          style={{
                            left: quickPos.left,
                            top: quickPos.top,
                            width: STYLE_PANEL_WIDTH
                          }}
                          role="dialog"
                          aria-label="按风格筛选"
                        >
                          <div className="flex items-center justify-between pb-1.5">
                            <span className="text-[10px] text-tertiary">
                              风格（可多选
                              {styleFilterActive ? `，已选 ${filters.styles.length}` : ''}）
                            </span>
                            {styleFilterActive && (
                              <button
                                type="button"
                                className="text-[11px] text-accent-text"
                                onClick={() => setFilter({ styles: [] })}
                                title="清空风格筛选"
                              >
                                清空
                              </button>
                            )}
                          </div>
                          <div className="flex max-h-[280px] flex-wrap gap-1 overflow-auto">
                            {styleCounts.map(([style, count]) => {
                              const active = filters.styles.includes(style)
                              return (
                                <button
                                  key={style}
                                  type="button"
                                  className={`inline-flex items-center gap-1 rounded-chip border border-line px-2 py-0.5 text-xs transition ${
                                    active
                                      ? 'bg-elevated font-medium text-primary'
                                      : 'text-secondary hover:bg-elevated/60'
                                  }`}
                                  aria-pressed={active}
                                  onClick={() =>
                                    setFilter({
                                      styles: active
                                        ? filters.styles.filter((x) => x !== style)
                                        : [...filters.styles, style]
                                    })
                                  }
                                  title={`按风格「${style}」筛选（可多选，命中任一即出）`}
                                >
                                  {style}
                                  <span className="tabular-nums opacity-60">{count}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* 0.6.0 浮层：分辨率 / 存为集合。
                          与上面三个 chip **共用** `quickPos` 与「点外部 / Esc 关闭」那套逻辑
                          （状态分开只是为了让 `QuickPanel` 的字面量契约保持不变）。 */}
                      {extraPanel && quickPos && (
                        <div
                          className={`fixed z-40 rounded-btn border border-line bg-card p-1 shadow-modal ${
                            extraPanel === 'save' ? 'w-[208px]' : 'w-[176px]'
                          }`}
                          style={{ left: quickPos.left, top: quickPos.top }}
                          role="dialog"
                          aria-label={
                            extraPanel === 'save'
                              ? '存为智能集合'
                              : extraPanel === 'format'
                                ? '按模型格式筛选'
                                : '按分辨率筛选'
                          }
                        >
                          <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">
                            {extraPanel === 'save'
                              ? '存为智能集合'
                              : extraPanel === 'format'
                                ? '模型格式'
                                : resolutionPanelTitle(filters.kind)}
                          </div>

                          {/* 模型格式：与分辨率面板同构（单选、点完即收起、active 高亮同色）。
                              选项表在 `shared/modelFormat`（全部 / SU / 3DMAX / **D5A**），
                              与卡片徽标文案同源。
                              ⚠️ 本组件**不硬编码档位** —— 2026-11-09 用户要求「D5A 属于模型格式，
                              格式里要能选到」，只在 `MODEL_FORMAT_OPTIONS` 加一项即可，
                              弹层/摘要/空态文字全部自动跟随。 */}
                          {/* 模型格式：与分辨率面板同构（单选、点完即收起、active 高亮同色）。
                              选项表在 `shared/modelFormat`（全部 / SU / 3DMAX / **D5A**），
                              与卡片徽标文案同源。
                              ⚠️ 本组件**不硬编码档位** —— 2026-11-09 用户要求「D5A 属于模型格式，
                              格式里要能选到」，只在 `MODEL_FORMAT_OPTIONS` 加一项即可，
                              弹层/摘要/空态文字全部自动跟随。
                              2026-11-13 用户拍板「d5a 字体要是紫色」⇒ 只有 **D5A 这一行**走紫，
                              其余行照旧。走 `text-d5a`（小字档 token 类名），不写死 hex；
                              active 行的底仍是 accent-tint（紫 on accent-tint 实测 4.92:1，达标）。
                              ⛔ 禁止 `dark:` 变体（主题走 data-theme，见 styles.css 文件头回签段）。 */}
                          {extraPanel === 'format' &&
                            MODEL_FORMAT_OPTIONS.map((opt) => {
                              const active = filters.modelFormat === opt.value
                              const purpleText = opt.value === 'd5a'
                              return (
                                <button
                                  key={opt.label}
                                  className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                                    active
                                      ? `bg-accent-tint font-medium ${purpleText ? 'text-d5a' : 'text-accent-text'}`
                                      : `${purpleText ? 'text-d5a' : 'text-secondary'} hover:bg-elevated/60`
                                  }`}
                                  aria-pressed={active}
                                  onClick={() => {
                                    setFilter({ modelFormat: opt.value })
                                    setExtraPanel(null)
                                  }}
                                >
                                  {opt.label}
                                </button>
                              )
                            })}

                          {/* 分辨率：与体积面板**完全同构**（单选、点完即收起、active 高亮同色）。
                              选项表**按视图分**：材质族 2K/4K；HDR 4K/8K/16K（全景宽度）。 */}
                          {extraPanel === 'resolution' &&
                            resolutionOptionsFor(filters.kind).map((opt) => {
                              const active = filters.minResolution === opt.value
                              return (
                                <button
                                  key={opt.label}
                                  className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                                    active
                                      ? 'bg-accent-tint font-medium text-accent-text'
                                      : 'text-secondary hover:bg-elevated/60'
                                  }`}
                                  aria-pressed={active}
                                  onClick={() => {
                                    setFilter({ minResolution: opt.value })
                                    setExtraPanel(null)
                                  }}
                                >
                                  {opt.label}
                                </button>
                              )
                            })}

                          {/*
                            DEF-19-3 就近提示：选了分辨率档位、当前列表却是空的，而索引里
                            还有一批资产的 folder 不在当前库目录下（主进程 probeSizes 会
                            return []，尺寸永远补不上）—— 这时"筛不到"很可能不是没货，
                            而是那批资产的尺寸没采到。只加一行小字，**不加按钮**：
                            浮层的交互（单选 / 不限）保持原样，解释留在设置页那条警示里。

                            判条件全在 `resolutionDriftHint()` 里（`useVisibleAssets()` 的
                            长度直接传进去，不另算一套筛选 —— 两份判据必然漂移）。
                          */}
                          {extraPanel === 'resolution' && resolutionHint !== null && (
                            <div className="mt-0.5 border-t border-line/60 px-2 pb-0.5 pt-1 text-[10px] leading-relaxed text-tertiary">
                              {resolutionHint}
                            </div>
                          )}

                          {/* 存为集合：极简行内输入（回车保存 / Esc 取消）。
                              失败原因就地显示在输入框下方，不打断到全局 notice。 */}
                          {extraPanel === 'save' && (
                            <div className="px-1 pb-1.5">
                              <input
                                autoFocus
                                value={saveName}
                                maxLength={24}
                                placeholder="集合名称，回车保存"
                                aria-label="智能集合名称"
                                className="h-7 w-full rounded-nav border border-line bg-elevated/40 px-2 text-[12px] text-primary outline-none placeholder:text-muted focus:border-accent"
                                onChange={(e) => {
                                  setSaveName(e.target.value)
                                  setSaveError(null)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter') return
                                  e.preventDefault()
                                  void submitSaveView()
                                }}
                              />
                              <div className="mt-1 px-1 text-[10px] leading-relaxed text-tertiary">
                                {saveError ? (
                                  <span className="text-danger">{saveError}</span>
                                ) : (
                                  `${savedViewCount}/${SAVED_VIEW_LIMIT} · Enter 保存 · Esc 取消`
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 排序胶囊（2026-10 用户反馈：换成**自绘浮层**）。
                        原生 `<select>` 的展开层是浏览器/系统控件，`appearance-none` 只能改
                        控件外观、改不了弹层 → 会出现灰底系统下拉，与产品 UI 两个风格。
                        容器 / 定位 / 尺寸沿用同排「体积 / 时间 / 分辨率」浮层那一套：
                        fixed + 打开时取按钮矩形、`rounded-btn border border-line bg-card p-1
                        shadow-modal`、行高 h-7、`rounded-nav`、选中 `bg-accent-tint`。 */}
                    <div ref={sortRef} className="relative inline-flex shrink-0 items-center gap-1" onKeyDown={onSortKeyDown}>
                      <button
                        ref={sortButtonRef}
                        type="button"
                        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-pill-header bg-pill px-2.5"
                        title="排序"
                        aria-haspopup="listbox"
                        aria-expanded={sortPanel}
                        aria-label={`排序方式：${sortLabel}`}
                        onClick={toggleSortPanel}
                      >
                        <span className="text-[12px] text-secondary">{sortLabel}</span>
                        <span aria-hidden className="pointer-events-none text-[9px] text-tertiary">
                          ▾
                        </span>
                      </button>

                      {/* 排序方向（2026-11 用户反馈：「时间的筛选上应该是正序和倒序」）。
                          与胶囊同处 `sortRef` 容器内：浮层的「点外面关闭」判据是
                          `sortRef.contains(target)`，放在容器里 → 点方向按钮时浮层不会被
                          自己挤掉，用户可以「选键 → 就地试方向」。
                          图标是上下双向箭头，**当前方向那支不透明、反向那支 35%**，
                          所以深色主题下也能一眼看出现在哪个方向（不靠颜色差异，靠明度）。
                          配色只走既有语义 token：`text-secondary`（`--text-secondary`）在
                          浅底 `--pill-bg #f1f5f9` 上是 6.9:1、深底 `--pill-bg #1c1c1e` 上是
                          5.9:1（均为不透明主支，≥ 4.5:1 正文级）。主题切换由 token 自己跟，
                          ⛔ 不用 `dark:` 变体（`darkMode` 是 media，会跟系统而不是应用主题，
                          见 styles.css 文件头）。 */}
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-pill-header bg-pill text-secondary transition-colors hover:text-primary"
                        title={sortDirHint}
                        aria-label={sortDirHint}
                        aria-pressed={sortDescNow}
                        // Enter 在这枚按钮上是"切换方向"（原生 click 负责），不能被外层容器的
                        // `onSortKeyDown` 抢去"应用高亮项"——它是同容器里排序浮层的键盘处理。
                        // ↑/↓ 不拦：在方向按钮上按 ↓ 想翻浮层是合理意图，让它照常冒泡。
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.stopPropagation()
                        }}
                        onClick={toggleSortDesc}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                          className="pointer-events-none"
                        >
                          {/* 左支：向上（升序） */}
                          <path d="M3.2 9.4V2.6M3.2 2.6 1.6 4.2M3.2 2.6 4.8 4.2" opacity={sortDescNow ? 0.35 : 1} />
                          {/* 右支：向下（降序） */}
                          <path d="M8.8 2.6v6.8M8.8 9.4 7.2 7.8M8.8 9.4 10.4 7.8" opacity={sortDescNow ? 1 : 0.35} />
                        </svg>
                      </button>

                      {sortPanel && sortPos && (
                        <div
                          className="fixed z-40 w-[176px] rounded-btn border border-line bg-card p-1 shadow-modal"
                          style={{ left: sortPos.left, top: sortPos.top }}
                        >
                          <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">排序</div>
                          {/* 标题放在 listbox **外面**：listbox 的直接子节点只能是 option / group */}
                          <div role="listbox" aria-label="排序方式">
                            {SORT_OPTIONS.map((opt, i) => {
                              const active = opt.value === filters.sort
                              // 选中态**只用一个指示**（同排浮层的 accent-tint），不再叠勾号
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  role="option"
                                  aria-selected={active}
                                  className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                                    active
                                      ? 'bg-accent-tint font-medium text-accent-text'
                                      : i === sortCursor
                                        ? 'bg-elevated/60 text-secondary'
                                        : 'text-secondary hover:bg-elevated/60'
                                  }`}
                                  onClick={() => applySort(opt.value)}
                                >
                                  {opt.label}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 0.6.0 智能集合：把当前筛选 + 排序存成侧栏「智能集合」里的一行。
                        上限（SAVED_VIEW_LIMIT）与回收站视图都禁用，原因写在 title 里
                        （禁用按钮不给解释是最容易挨骂的那种交互）。 */}
                    <button
                      type="button"
                      className={`chip-ghost shrink-0 ${
                        saveViewDisabled ? 'cursor-not-allowed opacity-40' : ''
                      }`}
                      disabled={saveViewDisabled}
                      aria-haspopup="dialog"
                      aria-expanded={extraPanel === 'save'}
                      title={
                        trashMode
                          ? '回收站不支持保存筛选集合（返回资产视图后可用）'
                          : savedViewCount >= SAVED_VIEW_LIMIT
                            ? `最多保存 ${SAVED_VIEW_LIMIT} 个智能集合，请先在左侧「智能集合」里删除一个`
                            : '把当前筛选与排序保存为左侧栏的智能集合'
                      }
                      onClick={openSavePanel}
                    >
                      ＋ 存为集合
                    </button>
                  </>
                )}
              </div>
              {/* 2026-10-21 用户拍板：球放在**标题下方居中**，不再放顶栏。
                  固定占位是必须的 —— 否则球出现/消失会让下面的卡片网格整体跳动。
                  只有材质类才占位（模型等不出球，见 stageController.canStage）。 */}
              {folderAsset && canStage(folderAsset) ? (
                <div className="flex shrink-0 justify-center pt-4">
                  <div id="stage-slot" style={{ width: STAGE_SLOT, height: STAGE_SLOT }} />
                </div>
              ) : null}
              {/* C#19（已拍板「保留但可关闭」）：画布无样本，实现保留，
                  受设置·外观 tab 的 `showHelpHint` 控制（默认 true）。文件视图下隐藏。
                  2026-10-21 走查 P2⑩：原来把三条提示塞进一句话，中栏一窄就折成两行、
                  挤在标题下面像第二行标题。这里只留「进文件列表」和「拖出去」两条；
                  第三条（文件列表里双击文件用系统程序打开）已经在文件视图自己的提示条里
                  （AssetGrid 文件卡顶部），在资产网格重复它没有意义。 */}
              {!folderAsset && showHelpHint && (
                <div className="shrink-0 truncate px-5 pt-1 text-[11px] text-muted">
                  {helpHintText(filters.kind)}
                </div>
              )}
              {/* `enterFromHome`：首页过场的后半段（切视图那一帧 true，1100ms 后 false）。
                  它只是 `AssetGrid` 入场请求的四个边沿之一（另三个：首挂载、导航身份变化、
                  从文件视图返回）。所有进入网格的场景都会让卡片从各自那半边边缘滑入，
                  详见 `AssetGrid.tsx` 的「网格出现请求」两个 effect。 */}
              <AssetGrid view={view} enterFromHome={gridEnterFromHome} />
            </>
          )}
        </div>

        {/* 0.8.3 右栏折叠：与左栏同构（动画宽度 + 固定 300 内容宽 + visibility 收尾）。
            v0.9.4 首页态：与左栏同一判据，右栏也始终折起。 */}
        <CollapsibleColumn
          id="detail-panel"
          collapsed={isHome || sidebarRightCollapsed}
          width={DETAIL_W}
        >
          <DetailPanel />
        </CollapsibleColumn>
        {/* 右栏折叠后的唤出按钮，位于中栏最右缘（与左缘对称）；首页态不渲染（同左缘理由） */}
        {!isHome && (
          <SidebarEdgeToggle side="right" collapsed={isHome || sidebarRightCollapsed} onToggle={toggleRightSidebar} />
        )}

        {/* 舞台遮罩（2026-10）：双击出球时盖住中栏+右栏，随球落地淡出 →
            「内容逐渐浮现」。`opacity:0` 是**静止值**；动画由 MaterialStage 用 WAAPI
            起（`fill:'both'` 会压过这里的内联值，App 任意重渲染都打不回去）。
            pointer-events-none：遮罩不许吞掉点击。 */}
        <div
          id="stage-veil"
          className="pointer-events-none absolute inset-0 z-40 bg-canvas"
          style={{ opacity: 0 }}
          aria-hidden="true"
        />
        </div>
      </div>

      {/* A 线 T-03：舞台（z-index 60，浮在顶栏之上）。懒加载 + 首次进过就常驻，
          既不拖慢启动，也不反复销毁 WebGL 上下文。 */}
      {stageMounted && (
        <Suspense fallback={null}>
          <MaterialStageLazy
            asset={stageAsset ?? preloadAsset}
            phase={stageState.phase}
            originRect={stageState.originRect}
            handoffRect={stageState.handoffRect}
            handedOff={stageState.handedOff}
            onDone={() => {
              const s = stageController.get()
              if (s.phase === 'opening') stageController.settled(s.runId)
              else if (s.phase === 'closing') stageController.swept(s.runId)
              // 球飞进「自定义渲染」弹窗到位：舞台球隐身，弹窗球接管
              else if (s.phase === 'handoff') stageController.settledHandoff(s.runId)
              // 关弹窗：球从弹窗位置飞回顶栏槽位，结束后仍是 active（留在顶部可见）
              else if (s.phase === 'handback') stageController.settledHandback(s.runId)
            }}
          />
        </Suspense>
      )}

      <DropOverlay active={dragging} />
      <ImportQueue />
      {/* 2026-11：启动时检测到新版本 → 弹窗展示 GitHub Release 的发布说明。
          内容只来自 `UpdateInfo.notes`（受限 Markdown 解析成 token，见 logic/releaseNotes.ts），
          全应用只挂这一个实例；点「稍后」/「跳过这个版本」/ Esc / 点遮罩都会关掉它。 */}
      {updateDialogOpen && (
        <Suspense fallback={null}>
          <UpdateNotesDialogLazy />
        </Suspense>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {/* P0-16 删除安全：二次确认弹窗 + 5 秒撤销提示条 */}
      <ConfirmDialog />
      {/* docs/27 T-07：导入重复处置（跳过 / 覆盖 / 保留两者）。
          `conflictAsk` 为 null 时组件自己返回 null，所以这里无条件挂载。 */}
      <ImportConflictDialog />
      {/* T07：分类级联选择器（详情面板 / 右键菜单 / 多选批量共用） */}
      <CategoryPicker />
      {/* 0.6.0：批量重命名（模板 + 预览 + 失败回滚；只改文件夹名） */}
      <RenameDialog />
      {/* 0.6.5：HDR 预览（全景 + 小球 + 360° 滑块 + 拍照设为封面）。
          三处入口共用 store 的 `hdrPreviewAssetId`，全应用只挂这一个实例；
          关闭即卸载 → HdrScene 的 cleanup 会把 texture / pmrem / renderer / 上下文全 dispose。 */}
      {hdrPreviewAsset && (
        <Suspense fallback={null}>
          <HdrPreviewDialogLazy asset={hdrPreviewAsset} onClose={closeHdrPreview} />
        </Suspense>
      )}
      {/* 0.8.3 Quick Look（docs/32 §4）：空格全屏快览，纯预览无编辑控件。
          全应用只挂这一个实例；关闭即卸载，Esc 层随之出栈。 */}
      {quickLookAsset && (
        <Suspense fallback={null}>
          <QuickLookOverlayLazy asset={quickLookAsset} onClose={closeQuickLook} />
        </Suspense>
      )}
      {/* P2 未分类整理流水线：键盘驱动的串行整理（一屏一张 / 确认即归类并前进）。
          与 Quick Look 一样只挂一个实例 —— 两个实例会有两个 Esc 层和两个 keydown，
          一次 Enter 会归类两次。 */}
      {triageActive && (
        <Suspense fallback={null}>
          <TriageOverlayLazy />
        </Suspense>
      )}
      {/* 2026-11-10：底部 44px 通栏**整条取消**。三类内容（notice / 删除撤销 / 归类撤销）
          全部搬进底部居中的临时气泡（NoticeToast 内部已是 `fixed bottom-4 left-1/2` + z-48）。
          它现在是 out-of-flow 的浮层，**不再是根 flex column 的第三行布局行** ——
          三列区自然拿回原来被通栏吃掉的 44px；`ImportQueue` 的 bottom 已同步让位上移（`bottom-16`，最下一条留给气泡）。
          notice 的消失计时器也已从组件搬到 store 状态层（见 logic/noticeLifecycle.ts）。 */}
      <NoticeToast />

      {/* 首页 → 分类库的过场遮罩（最后渲染 = 文档最末 = 叠在所有兄弟之上，z-index 70）。
          它必须**在根节点内部最后**：过场期间任何下面的浮层都不该探出来。
          时间轴：0–360 文件夹本体飞到屏幕正中（×1.5）→ 360–600 停住 → 600–880 从中心
          挖洞化开 → 880 切视图（本组件上方那个定时器）→ 库卡片从两侧滑入。
          它自己只做一件事：0–880ms 挡住误触（飞行/消隐都在 `HomeCover` + `GlassFolder`
          身上，见 `HomeOutro.tsx` 文件头）。卸载时机由它自己的 `onDone` 决定。 */}
      {homeOutro ? <HomeOutro onDone={() => setHomeOutro(null)} /> : null}
    </div>
  )
}
