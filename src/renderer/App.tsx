import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVault, useVisibleAssets, SAVED_VIEW_LIMIT } from './store'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
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
import { formatBytes } from '../shared/format'
import { resolveTheme } from '../shared/theme'
import { displayName } from '../shared/naming'
import { capsOfFilter, kindFilterLabel, kindsOfFilter } from '../shared/classify'
import { UNCLASSIFIED } from '../shared/taxonomy'
import {
  SIZE_PRESET_BYTES,
  SORT_OPTIONS,
  TIME_PRESET_LABEL,
  activeImportedRange,
  activeSizeRange,
  describeNumericFilters,
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
import { categoriesOf } from './logic/category'
import { hasAssetDragPayload } from './logic/dragAssign'
import { isInternalDragOut, resetInternalDragOut } from './logic/dragOut'
import { pathsOutsideLibrary } from './logic/libraryPath'
import type { SortKey } from './logic/filters'
import { IconDownload, IconEmptyLibrary, IconPlus } from './icons'

/**
 * 中栏头快速筛选浮层的展开态（体积 / 时间 / 色标；null = 收起）
 *
 * ⚠️ 0.6.0 新增的「分辨率 / 存为集合」**不并进这个联合类型**：
 * `tests/marks.test.ts` 把这一行字面量当作「色标入口在中栏头」的契约钉住了，
 * 加成员会连带改动别人的测试文件。两者共用同一套定位 / 关闭逻辑（`quickPos` +
 * 下面那个 effect），只是状态分开存 —— 行为上没有任何区别。
 */
type QuickPanel = 'size' | 'time' | 'color' | null

/** 0.6.0 新增的中栏头浮层（分辨率 / 存为集合；null = 收起） */
type ExtraPanel = 'resolution' | 'save' | null

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
        // HDR 预览自己吃 Esc（见 HdrPreviewDialog）；这里先让路，
        // 否则一次按键会「关掉预览 + 顺手关掉底下的文件视图 / 清空选择」。
        if (st.hdrPreviewAssetId) return
        // 删除确认中先关确认框（= 撤销）
        if (st.pendingDelete) {
          undoDelete()
          return
        }
        // 软件内文件视图：Esc 退回原网格 / 列表（不顺手清掉选择，退出后选中态还在）。
        // 弹窗（设置 / 分类选择器）在场时让它们先吃 Esc，避免一次按键关两层。
        if (st.folderViewAssetId && !st.categoryPickerIds && !settingsOpen) {
          closeFolderView()
          return
        }
        select(null)
        setSettingsOpen(false)
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
  }, [selectedId, selectedIds, select, requestDelete, undoDelete, closeFolderView, settingsOpen])

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
  /** 设置里关掉色标入口时，中栏头这个 chip 不渲染（settings 未加载 → 按默认显示） */
  const showColorTagsEntry = useVault((s) => s.settings?.showColorTags !== false)

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
  // 大类筛选可能是分组哨兵（materialGroup）→ 显示名统一走 kindFilterLabel
  const headerTitle =
    libraryView === 'trash'
      ? '最近删除'
      : filters.category2 || filters.category1 || (filters.kind !== 'all' ? kindFilterLabel(filters.kind) : '全部')
  const trashMode = libraryView === 'trash'
  const unclassified = assets.filter((a) => {
    const c = categoriesOf(a)
    return c.category1 === UNCLASSIFIED || c.category2 === UNCLASSIFIED
  }).length

  // v0.4 数值筛选摘要（体积 / 导入时间）：无生效条件时返回 ''，不渲染、不占位。
  // 纯函数在 logic/filters.ts（可单测），组件只负责摆位置。
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
   */
  const showResolutionEntry = capsOfFilter(filters.kind, 'resolution')
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
  }, [showResolutionEntry])

  // ── 排序胶囊（自绘浮层）────────────────────────────────────────────
  /** 胶囊上显示的当前排序名；`SORT_OPTIONS` 与 `SortKey` 同源，兜底防止脏值留下空白胶囊 */
  const sortLabel = SORT_OPTIONS.find((o) => o.value === filters.sort)?.label ?? '排序'
  /** 当前生效项在 `SORT_OPTIONS` 里的下标（键盘高亮初始位置） */
  const sortActiveIndex = SORT_OPTIONS.findIndex((o) => o.value === filters.sort)

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
    setFilter({ sort: value })
    setSortPanel(false)
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
      <Toolbar view={view} onView={setView} />

      <div className="flex min-h-0 flex-1">
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} />

        {/* 2026-10：中栏 + 右栏包一层 `relative`，用来挂舞台遮罩（`#stage-veil`）。
            flex 分配不变 —— wrapper 接管中栏原来的 `min-w-0 flex-1`，内部再分给中栏与右栏。
            这里没有重新缩进内部 400 行 JSX（纯缩进变更会让 diff 失去可读性）。 */}
        <div className="relative flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!ready ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">正在加载素材库…</div>
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
                      {!trashMode && unclassified > 0 ? ` · ${UNCLASSIFIED} ${unclassified}` : ''}
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
                          回到资产视图后原样继续生效。 */}
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
                          aria-label={extraPanel === 'save' ? '存为智能集合' : '按分辨率筛选'}
                        >
                          <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">
                            {extraPanel === 'save' ? '存为智能集合' : resolutionPanelTitle(filters.kind)}
                          </div>

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
                    <div ref={sortRef} className="relative shrink-0" onKeyDown={onSortKeyDown}>
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
                  双击卡片查看文件（HDR 直接进预览）· 拖拽卡片可拖到建模软件
                </div>
              )}
              <AssetGrid view={view} />
            </>
          )}
        </div>

        <DetailPanel />

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
      {/* 规范 §3.5：底部合并 toast（左=轻提示 / 右=删除撤销条），替代原 NoticeToast+UndoToast 两个浮窗 */}
      <NoticeToast />
    </div>
  )
}
