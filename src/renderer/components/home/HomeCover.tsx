import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useVault } from '../../store'
import { IconSettings } from '../../icons'
import { HomeParticles } from './HomeParticles'
import {
  WALLPAPER_TONE_SAMPLE,
  wallpaperToneFromImageData,
  type WallpaperTone
} from '../../logic/wallpaperTone'
import { HomeStats } from './HomeStats'
import { GlassFolder, NewProjectFolderCard } from './GlassFolder'
import type { GlassFolderOpenPayload } from './GlassFolder'
import {
  HomeFolderFilter,
  type HomeFolderFilterValue
} from './HomeFolderFilter'
import {
  HomeSearchCommand,
  type HomeSearchGroup,
  type HomeSearchItem
} from './HomeSearchCommand'
import { ContextMenu } from '../ContextMenu'
import {
  homeKindMenuItems,
  homePinnedMenuItems,
  homeRowMenuItems,
  type ContextMenuItem
} from '../../logic/contextMenu'
// F-1/F-2/F-3 的纯逻辑（增删移 / 查重 / 边缘滚动 / 底纹 key）都在这里，组件只消费
import {
  EDGE_HOT_ZONE_PX,
  edgeScrollDirection,
  edgeScrollStep,
  kindWallpaperKey,
  nextScrollLeft,
  pinWallpaperKey,
  wallpaperUrlOf
} from '../../logic/homePinned'
// 拖动排序（2026-11-25）：槽位键 / 归一化 / 排序 / 移动全是 shared 里的纯函数（单测覆盖），
// 组件只负责量几何、跟指针、让位与写档。
import {
  HOME_NEW_PROJECT_SLOT_KEY,
  applyHomeFolderOrder,
  buildHomeFolderSlots,
  dragSlotShift,
  homeKindFolderKey,
  homePinFolderKey,
  moveHomeFolderKey,
  nearestSlotIndex,
  normalizeHomeFolderOrder,
  sortHomeFolderSlots
} from '../../../shared/homeFolderOrder'
import type {
  HomeBackgroundSettings,
  HomePinnedFolder,
  MotionQuality,
  Settings
} from '../../../shared/types'
// 退场（`data-leaving`）那套规则的宿主。它和过场的时间轴是同一件事的两半，所以与
// `HomeOutro` 共用一份 CSS（本组件没有自己的样式文件，理由见 `home-outro.css` 里
// 「首页退场」那一节的注释）。显式 import，不依赖"HomeOutro 先渲染过"这种隐式前提。
import './home-outro.css'
// 新建项目虚卡（docs/60 §4.3 W0，T-03）：样式独立成文件（不掺 T-05 定稿的
// glass-folder.css），尺寸阶梯与 GlassFolder 逐档同步 —— 两处注释互相点名。
import './new-project-card.css'

/**
 * 首页封面页（v0.9.4「侧栏第一项『全部』→『首页』」的落地形态）。
 *
 * 产品口径（已定稿，不要再改设计）：
 * - 侧栏第一个节点「首页」进入的不是资产网格，而是**这一块封面页**；
 * - 首页态下左栏 / 右栏折起（由 `App.tsx` 传 `collapsed` 给 `CollapsibleColumn`）；
 * - 内容区 = 粒子背景（铺满、`pointer-events:none`、在内容层之下）
 *   + 右上数据看板（磨砂玻璃卡，含分类占比环，见 `HomeStats`）
 *   + 屏幕中央靠下的变形搜索条（`HomeSearchCommand`）
 *   + 下方磨砂文件夹排（数量 = 有素材的分类数，当前 4 个；空分类不占入口）
 *   + 一行提示字 + 左下角一个设置齿轮；
 * - 首页**不放**回收站 / 重复资产 / 排序 / 筛选 / 视图切换（那些都在网格态）。
 *
 * 本组件是**纯展示组件**，不直接读写业务数据：`folders` / `stats` / `searchValue`
 * 全部由 `App.tsx` 传进来（便于以后单测与 Storybook 预览）。
 *
 * 唯一的例外是下面那一次 `useVault`：粒子背景的"花哨程度"是全局外观设置
 * （`settings.motionQuality`），它既不是业务数据也不该由 App 逐层往下透传 ——
 * 与 `HomeParticles` 的 props 契约（`quality: MotionQuality`）对齐后只在这里读一次。
 *
 * 仓库纪律提醒：本文件**自己**不写任何 CSS 渐变、不用背景虚化类属性。
 * 玻璃质感由 `GlassFolder`（`glass-folder.css`）与 `HomeStats`（`home-stats.css`，
 * 用户明确要求「磨砂玻璃框住展示」的第二处豁免）各自负责；`HomeSearchCommand`
 * 只用 token 的实色 + 阴影 + 一条功能性 mask，无装饰渐变。
 * 布局数值全部是设计稿量出来的真规格。
 */

/** 类别筛选态下的稳定空集合（避免每次渲染新建 [] 让 slots useMemo 失效） */
const EMPTY_FOLDERS: HomeFolderItem[] = []
const EMPTY_PINNED: HomePinnedFolder[] = []

/** 首页文件夹卡的数据项（key 与侧栏导航节点一一对应） */
export interface HomeFolderItem {
  /**
   * `materialGroup` = 侧栏的「材质」分组节点（texture + material 两类合并）。
   *
   * ⚠️ **没有 `'d5a'`**（2026-11-09 收口后）：`.d5a` 不是大类，而是**模型的一种格式**，
   * 入口走「模型」卡 → 中栏头「格式」→ D5A（与 `.max` 同构）。所以首页不会出现
   * 独立的 D5A 文件夹 —— 同一个东西不该有第四种说法。
   *
   * 候选顺序由 `logic/homeKinds.ts#HOME_FOLDER_KEYS` 给出（= `KIND_NAV_ORDER`），
   * 仍然只显示 `count > 0` 的卡；「模型」卡的计数走 `kindsOfFilter('model')`
   * = `{model, d5a}`，与点进去的网格条数一致。
   */
  key: 'model' | 'cad' | 'materialGroup' | 'hdri' | 'other'
  label: string
  count: number
  /** 封面缩略图 URL；长度恒为 3，不足用 `null` 占位（由 `GlassFolder` 画空槽） */
  thumbs: Array<string | null>
}

/** 数据看板的三项数字（顺序固定：本月入库 / 库总量 / 待补分类） */
export interface HomeStatsData {
  monthImports: number
  totalAssets: number
  pendingCategory: number
}

/**
 * 首页文件夹排右键菜单的目标（T-05 F-1/F-3）。
 * `kind` = 素材大类卡 / `pin` = 钉选卡 / `row` = 排的空白处。
 */
type HomeFolderMenu =
  | { type: 'kind'; x: number; y: number; key: string }
  | { type: 'pin'; x: number; y: number; id: string }
  | { type: 'row'; x: number; y: number }

/**
 * 滚动容器的纵向补偿 padding（px）。**必须**与 `glass-folder.css`
 * `.hc-folder-scroll` 的 `--hc-scroll-pad-top / -bottom` 同值 —— CSS 负责把可视域
 * 撑大 + 负 margin 把布局补回原样；这里同一对数值把边缘热区的纵向安全带收回来
 * （不收 = 搜索框旁边悬停也会触发滚动）。改一处必须改另一处。
 */
const SCROLL_PAD_TOP = 110
const SCROLL_PAD_BOTTOM = 64

/* ─────────────────────────────────────────────────────────────────────────────
 * 拖动排序（2026-11-25 用户需求：「首页文件夹支持鼠标拖动调整顺序」）
 *
 * 手势共存是这一块最要紧的约束：卡片自己已有 **单击翻开 / 双击进入 / 右键菜单 /
 * 指针倾斜** 四套手势，拖动绝不能把它们误触掉。做法：
 *   · 按下只记起点（不 preventDefault、不 setPointerCapture、不改任何状态）；
 *   · 指针**横向**位移超过 `DRAG_THRESHOLD_PX` 才真正进入拖动态（竖向抖动不会
 *     启动拖动）；
 *   · 拖动真正开始后才捕获指针，并在松手那一帧把随后的 `click` 用捕获阶段的
 *     `onClickCapture` 吞掉 —— **但只在"真的换了槽位"时才吞**。
 *
 * ⚠️ 这里曾经写成"只要越过阈值进入拖动态，松手就吞 click"，结果真人手点卡片时
 * 4~8px 的横向手抖会越线 → 进入拖动态 → 松手落回原位 → 仍然把那次 click 吞掉
 * → **单击翻开文件夹点了没反应**（双击是另一条链路、设置齿轮不在这一行里，所以
 * 只有"单击卡片"坏掉，正是用户报的「点文件夹打不开」）。
 * 正确语义：**没换槽位就不算拖动，不算拖动就不许吞 click。**
 * 阈值只是把误触概率压低，真正保证"手抖还能点开"的是上面那条判断。
 *
 * 为什么不用 HTML5 drag-and-drop：`dragstart` 会与系统"拖出窗口"和卡片内
 * `<img>` 的默认拖拽抢同一个手势，且 drag 事件在 Electron 里拿不到可靠的
 * 指针坐标（只能靠 dragover 的节流数据）。Pointer Events + `setPointerCapture`
 * 全程拿得到真实 clientX，取消路径（Esc / pointercancel）也干净。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 拖动起步阈值（px）：横向位移小于它 → 仍按单击 / 双击处理。
 *  4px 对真人手速太窄（实测 4px 就能稳定触发误吞 click），提到 8px 与
 *  dnd-kit / 浏览器原生拖拽一个量级；但注意**阈值只是降低误触概率**，
 *  "手抖也能点开"靠的是 finishDrag 里"没换槽位就不吞 click"那条判断。 */
const DRAG_THRESHOLD_PX = 8

/**
 * 一次拖动期间的运行态（**不进 state**：每帧都要改，进 state 会把整页重渲染 60 次/秒）。
 * 指针移动只在 rAF 里直接写被拖卡与让位卡的 `transform`，React 只在
 * 「开始 / 结束」两次重渲染（打 `data-dragging`、切 `pendingOrder`）。
 */
interface FolderDragState {
  pointerId: number
  /** 被拖卡的槽位键（`kind:<key>` / `pin:<id>`） */
  key: string
  /** 视觉顺序下的可拖卡键（不含虚卡）——移动与合入 order 都以它为准 */
  keys: string[]
  /** 键 → 根节点（拖动开始那一刻量好的快照） */
  els: Map<string, HTMLElement>
  /** 每张可拖卡的中心 x（视觉顺序，视口坐标）——落点判定按"最近中心" */
  centers: number[]
  /** 相邻两格的中心距（px）：让位平移量 */
  step: number
  /** 指针按下时的 clientX（位移以它为零点） */
  startX: number
  fromIndex: number
  toIndex: number
  dx: number
  /** 被拖卡根节点（要单独 setPointerCapture / 抬升） */
  sourceEl: HTMLElement
}

/** 只是"按下了，还没到拖动阈值"的起点记录 */
interface FolderPressState {
  pointerId: number
  startX: number
  startY: number
  key: string
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 双击进入分类的**退场**时间轴（2026-11 第三轮用户口径）
 *
 * 用户原话（逐字）：
 *   「第一，文件夹移动，而不是我们的缩略图移动。第二，移动到比如模型的这个文件夹时，
 *     它应该是中心消隐的，而不是瞬间不见的，这个动画需要做进去。」
 *
 * 实现方式：**不复制**，直接让 DOM 里那个真的 `<button.gf-root>` 平移 + 放大到屏幕
 * 正中（FLIP 的思路，但只有"最后一帧"是 JS 算的位移，中间过程全交给 CSS transition），
 * 到位停住之后由 CSS `@keyframes` 用**高斯模糊晕开**（blur 0→14px + opacity 1→0）把它化掉。
 *
 *   0 ── 360 到中心 ── 600 停留完 ── 880 消隐完 ── 880 切视图（库卡片随即滑入）
 *        飞 360ms         停 240ms        消隐 280ms
 *
 * ⚠️ 三处必须同步的配对（改一处就要改另一处）：
 *   · EXIT_FLY_MS(360)      ↔ `glass-folder.css` 里 `.gf-root[data-leaving='self']` 的
 *                             `transition: transform 360ms`；
 *   · EXIT_FLY_MS+EXIT_HOLD_MS(600) ↔ 同一条规则里 `animation` 的 `600ms` 延迟
 *                             （顺序是"先停、后消隐"，不是"边飞边消隐"）；
 *   · EXIT_FLY_MS+EXIT_HOLD_MS+EXIT_DISSOLVE_MS(880) ↔ `App.tsx` 的
 *                             `HOME_OUTRO_SWITCH_MS`（= 880）与 `HomeOutro` 的
 *                             `HOME_OUTRO_TOTAL_MS`（= 880）。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 三段时长。**组件内部一处都不读**（飞行是 CSS transition、消隐是 CSS animation，
 * 时间全写在 `glass-folder.css` 里），之所以仍然保留并导出，是为了让这张时间轴
 * 在 JS 侧有一个可被引用/被测试断言的**唯一来源** —— 否则"880 = 360+240+280"
 * 这个等式只存在于三份互相抄的注释里，迟早会漂。
 */
export const EXIT_FLY_MS = 360
/** 在正中停住的时长（ms）——用户明确要的"停留一小段时间"，不要省 */
export const EXIT_HOLD_MS = 240
/** 消隐（高斯模糊晕开）用时（ms）↔ `@keyframes gf-folder-dissolve` 的 280ms */
export const EXIT_DISSOLVE_MS = 280
/** 过场总时长（ms）= 360 + 240 + 280 = **880**，与 `App.tsx` / `HomeOutro.tsx` 同值 */
export const HOME_COVER_TOTAL_MS = EXIT_FLY_MS + EXIT_HOLD_MS + EXIT_DISSOLVE_MS
/** 飞到中点时的放大倍率：104×84 → 156×126（近处看清，但不铺满屏） */
const EXIT_SCALE = 1.5

/**
 * 退场几何：由被双击那个文件夹的矩形算出来，交给 `GlassFolder` 内联成 CSS 变量。
 * 字段含义见 `GlassFolderExit`（`GlassFolder.tsx`）。
 */
interface ExitGeom {
  dx: number
  dy: number
  scale: number
}

/**
 * 算「飞到屏幕正中」的位移与倍率。
 *
 * dx/dy 是**中心对中心**的屏幕 px 差：`transform: translate() scale()` 里 translate
 * 作用在元素自身坐标（1 单位 = 1 屏幕 px），所以直接写这个差值即可，不需要按倍率换算。
 *
 * 消隐不需要任何几何参数（模糊半径是固定常数，写在 keyframes 里），所以这里只出三个数。
 *
 * @param rect 文件夹根节点的视口矩形（`GlassFolder` 在双击那一刻量好的快照）
 * @returns 退场几何（屏幕坐标）
 */
function computeExitGeom(rect: { left: number; top: number; width: number; height: number }): ExitGeom {
  const scale: number = EXIT_SCALE
  if (typeof window === 'undefined') {
    // SSR / 测试环境：退化成"原地不动、不放大"，绝不产生 NaN / Infinity
    return { dx: 0, dy: 0, scale }
  }
  return {
    dx: window.innerWidth / 2 - (rect.left + rect.width / 2),
    dy: window.innerHeight / 2 - (rect.top + rect.height / 2),
    scale
  }
}


/**
 * `prefers-reduced-motion: reduce` 订阅。
 *
 * 只在组件内部用（不进 store）：它是**系统级**偏好，与 `settings.motionQuality`
 * （用户显式选的性能档）是两件事，命中任一条都该退化。
 * 与 `AssetGrid.tsx` 里的同名 hook 同构 —— 那边是组件私有实现，没有导出，
 * 这里按同一写法本地再实现一份（不为一个 20 行的 matchMedia 订阅去改别人的文件）。
 */
function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (): void => setReduced(mq.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    // 老 Chromium 只有 addListener；Electron 33 两者都有，这里只是兜底
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])
  return reduced
}

export function HomeCover(props: {
  folders: HomeFolderItem[]
  stats: HomeStatsData
  /**
   * 搜索面板取结果用的纯函数（由 `App.tsx` memo 后传入）。
   *
   * 为什么是函数而不是现成数组：查询词由 `HomeSearchCommand` 内部持有
   * （它是受控输入框，父级不该为每一次按键重渲染整个首页），所以父级
   * 交出来的是「给我词、我给你分组」这个能力，不是一份快照。
   */
  searchGroups: (query: string) => HomeSearchGroup[]
  /** 用户在搜索面板里选中某一项 */
  onPickSearch: (item: HomeSearchItem) => void
  /**
   * 双击 / Enter 某个文件夹 → 进入该分类。
   *
   * 第二个形参是**过场素材**（起点矩形 + 背板缩略图），由 `GlassFolder` 在卸载前
   * 量好交上来；`App` 拿它播「该文件夹飞到屏幕正中 → 停一小段 → 淡出 → 露出库」的
   * 过场。本组件只负责透传，不认识也不使用这两个字段。
   */
  onOpenKind: (key: HomeFolderItem['key'], payload: GlassFolderOpenPayload) => void
  onOpenSettings: () => void
  /** 首页海浪两套主题的自定义色（透传给 `HomeParticles`，主题联动在那边按 DOM 现取） */
  waveColors: Settings['homeWaveColors']
  /** 已 clamp 的浪高（透传给 `HomeParticles`） */
  waveHeight: number
  /**
   * 自定义背景图设置（2026-11-23 用户口径：**壁纸与海浪互斥**）。
   *
   * 背景图层**不在本组件**：它在 `App.tsx` 根部，`fixed inset-0 z-0` 铺满整个窗口
   * （含顶栏区域，顶栏毛玻璃透出壁纸）。本组件只拿它推导 `hasWallpaper` ——
   * 挂壁纸时粒子层整体不渲染（壁纸就是背景本身）；没挂壁纸时粒子照常渲染
   * 不透明底色（v1.1.0 之前行为）。
   * `source === 'none'` / 无文件时 = 无壁纸。
   */
  homeBackground: HomeBackgroundSettings
  /**
   * 首页快速访问的钉选（T-05 F-1，docs/60 §6.1）：**数组顺序即显示顺序**，
   * 整体追加在素材大类卡之后同排（不分区、不换行 —— §6.1 形态拍板）。
   */
  pinnedFolders: HomePinnedFolder[]
  /**
   * 文件夹排的顺序表（2026-11-25 拖动排序，`Settings.homeFolderOrder`）：
   * 元素是槽位键 `kind:<key>` / `pin:<id>`，**数组顺序即显示顺序**。
   * 归一化已由 App（`normalizeHomeFolderOrder`）与主进程做掉，这里只消费。
   * 表里没有的卡按默认顺序（大类在前、钉选在后）追加到末尾。
   */
  folderOrder: string[]
  /**
   * 松手落位后写一次顺序（App → `saveSettings({ homeFolderOrder })`）。
   * 返回 `false` = 写档失败 —— 本组件据此丢掉乐观顺序，界面回到拖动前（App 侧
   * 同时给一句提示）。**拖动过程中绝不写档**，只在落位这一下写一次。
   */
  onReorderFolders: (order: string[]) => Promise<boolean>
  /** 文件夹底纹映射（T-05 F-3）：key = `kind:<分类键>` / `pin:<钉选id>`（命名空间见 logic/homePinned.ts） */
  folderWallpapers: Settings['homeFolderWallpaper']
  /**
   * 双击 / Enter 钉选卡 → **应用内文件浏览**（v1.2 反馈批 B：软件代替资源管理器，
   * 用户原话「双击用户自己的文件夹以后，进入的仍然是我们的软件界面」）。
   * App 侧接 `PinnedFolderBrowser`（按 pinId 打开），不再调 `home:pinnedOpen`。
   */
  onOpenPinned: (id: string) => void
  /**
   * 右键菜单「在资源管理器中打开」（v1.2 反馈批 B 由「打开」改名的**兜底出口**）：
   * 仍走主进程 `home:pinnedOpen(id)`（shell.showItemInFolder），给要在系统资源
   * 管理器里操作的用户留一条路。双击不经过它。
   */
  onRevealPinned: (id: string) => void
  /** 右键钉选卡「从快速访问移除」→ 只删 Settings 键，绝不删磁盘目录 */
  onRemovePinned: (id: string) => void
  /** 右键钉选卡「左移 / 右移」→ 交换相邻两个钉选（数组顺序即 order） */
  onMovePinned: (id: string, delta: -1 | 1) => void
  /** 右键文件夹排空白「添加快速访问…」→ pickDirectory 拾目录 → 追加钉选（App 接线） */
  onAddPinned: () => void
  /** 右键任一文件夹卡「设置底纹…」→ pickArchives 拾图 → homeBackground:save → 写映射（App 接线） */
  onSetFolderWallpaper: (key: string) => void
  /** 右键有底纹的文件夹卡「恢复默认底纹」→ 删映射键（不删缓存文件） */
  onClearFolderWallpaper: (key: string) => void
  /**
   * 「新建项目」虚卡（docs/60 §4.3 W0，T-03）：排在钉选卡**之后**的同排末尾。
   * 可选 prop —— 不传（undefined）时整张卡不渲染，T-05 既有渲染逐字不变；
   * 单击即开向导（虚卡无"双击"语义 —— 它不是文件夹，是动作入口）。
   */
  onNewProject?: () => void
}): JSX.Element {
  const {
    folders,
    stats,
    searchGroups,
    onPickSearch,
    onOpenKind,
    onOpenSettings,
    waveColors,
    waveHeight,
    homeBackground,
    pinnedFolders,
    folderOrder,
    onReorderFolders,
    folderWallpapers,
    onOpenPinned,
    onRevealPinned,
    onRemovePinned,
    onMovePinned,
    onAddPinned,
    onSetFolderWallpaper,
    onClearFolderWallpaper,
    onNewProject
  } = props

  /**
   * 是否挂了壁纸（2026-11-23 用户口径：**壁纸与海浪互斥**）。
   * 与 App 根部壁纸层的渲染条件保持同一口径 —— 挂壁纸时本组件不渲染粒子层，
   * 壁纸就是背景本身；没挂壁纸时粒子照常，与 v1.1.0 之前的画面逐字一致。
   */
  const hasWallpaper = homeBackground.source !== 'none' && Boolean(homeBackground.fileName)

  /**
   * 壁纸明暗档位（2026-11-23 用户需求：左下齿轮 / 底部提示行的**自适应对比度**）。
   * 壁纸亮 → 控件切深色；壁纸暗 → 控件切白色。取样判定见
   * `logic/wallpaperTone.ts`；判定失败（图挂了 / canvas taint）为 null，
   * 控件回退主题 token 原色 —— 取色失败绝不能搞挂首页。
   */
  const [wallTone, setWallTone] = useState<WallpaperTone | null>(null)
  const wallFileName = homeBackground.fileName
  useEffect(() => {
    if (!hasWallpaper || !wallFileName) {
      setWallTone(null)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      try {
        const c = document.createElement('canvas')
        c.width = WALLPAPER_TONE_SAMPLE
        c.height = WALLPAPER_TONE_SAMPLE
        const ctx = c.getContext('2d')
        if (!ctx) {
          setWallTone(null)
          return
        }
        ctx.drawImage(img, 0, 0, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE)
        const px = ctx.getImageData(0, 0, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE)
        setWallTone(wallpaperToneFromImageData(px.data, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE))
      } catch {
        // canvas 被 taint / 读像素失败：回退主题色
        setWallTone(null)
      }
    }
    img.onerror = () => {
      if (!cancelled) setWallTone(null)
    }
    img.src = `bg://${encodeURIComponent(wallFileName)}`
    return () => {
      cancelled = true
    }
  }, [hasWallpaper, wallFileName])

  /** 左下齿轮 / 底部提示行的自适应用色（无壁纸或判定失败 → 主题 token 原样） */
  const wallUiClass =
    hasWallpaper && wallTone === 'dark'
      ? { gear: 'text-white/80 hover:bg-white/15 hover:text-white', hint: 'text-white/70' }
      : hasWallpaper && wallTone === 'bright'
        ? { gear: 'text-black/60 hover:bg-black/10 hover:text-black', hint: 'text-black/55' }
        : { gear: 'text-tertiary hover:bg-elevated hover:text-primary', hint: 'text-tertiary' }

  /** 粒子背景的档位（唯一一次读 store，理由见文件头 doc） */
  const quality: MotionQuality = useVault((s) => s.settings?.motionQuality ?? 'balanced')
  /**
   * 右上数据卡是否显示（设置·外观「首页 · 数据卡片」，默认开）。
   *
   * 用 `!== false` 而不是 `=== true`：缺键 / 旧 settings.json / 脏值都按"显示"处理，
   * 与 `settings.ts` 的归一化方向一致（那里是"只有严格 false 才关"）。
   * 不传下来、在这里直接读 store 的理由同 `quality`：它是外观偏好，不是业务数据。
   */
  const showHomeStats: boolean = useVault((s) => s.settings?.showHomeStats !== false)
  const reduced = usePrefersReducedMotion()

  /**
   * 文件夹类别筛选（逆向 gallery10 的 Browse by type 气泡，2026-11-26）。
   * 语义：**主页内筛选，不离开主页** —— kind 只留素材大类卡、pin 只留钉选文件夹卡
   * + 新建项目虚卡、all 全显（但不带虚卡）。
   * 可见集合在下方从 folders / pinnedFolders 派生，slots / 拖拽 / 退场分半全部跟着它走，
   * 保证筛选态下拖拽只认当前可见卡（不会出现"拖一张看不见的卡"）。
   */
  const [folderFilter, setFolderFilter] = useState<HomeFolderFilterValue>('all')
  /**
   * 切档淡入用**交替的双 animation-name**（a↔b），而不是布尔开关：
   * CSS animation 只在 animation-name *变化*时重播，布尔 true→true 不会重挂。
   * 每次切档翻一次 variant → 同一次 React 渲染里新卡片带着新的 animation-name 挂载，
   * 第一帧就是 opacity:0（animation-fill-mode:both），彻底消除"先闪一下再淡入"。
   * reduced / smooth 档由 data-reveal-motion 关掉动画（见下方）。
   */
  const [revealVariant, setRevealVariant] = useState<'a' | 'b'>('a')
  // 首次挂载不播错峰（卡片走自己的入场体系）；只有用户主动切气泡才播
  const filterTouchedRef = useRef(false)

  // ── 拖动排序：顺序合成 + 运行态（2026-11-25）────────────────────────────────
  /**
   * 乐观顺序：松手后立刻按新顺序渲染，等写档结果。
   * `null` = 用 props 里的真值（`folderOrder`）。写档失败 → 清回 null =
   * **界面自动回滚到拖动前的顺序**（settings 没变，props 就是旧顺序）。
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  /** 非 null = 正在拖这一张（只在开始 / 结束各变一次，不是每帧） */
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  /** 排容器（事件委托 + 几何测量都在它上面） */
  const rowRef = useRef<HTMLDivElement | null>(null)
  /** 按下但还没到阈值的起点 */
  const pressRef = useRef<FolderPressState | null>(null)
  /** 拖动态运行快照（不进 state，理由见 FolderDragState 注释） */
  const dragRef = useRef<FolderDragState | null>(null)
  /** 指针 rAF（每帧只写 transform，不触发 React 渲染） */
  const dragRafRef = useRef<number | null>(null)
  /** 拖完那一下要吞掉的 click（捕获阶段拦，见 handleRowClickCapture） */
  const suppressClickRef = useRef(false)

  /**
   * 实际生效的顺序（乐观值优先）。两个来源都已归一化过（props 由 App 归，
   * 乐观值是本组件按同一套规则算出来的），这里不再重复洗一遍 —— 保持引用稳定，
   * `slots` 的 useMemo 才有意义。
   */
  const effectiveOrder = pendingOrder ?? folderOrder

  /**
   * 类别筛选后的可见集合（gallery10 气泡）。全部三个下游（渲染 map、slots、退场分半）
   * 都只读这两个派生值 —— 绝不在别处直接读 folders / pinnedFolders，否则筛选态下
   * "显示的卡" 与 "参与拖拽/排序的卡" 会分叉。
   * 虚卡（新建项目）在筛选态下也只跟随"全部"档：kind/pin 档里它不属于任何一类。
   */
  const visibleFolders = folderFilter === 'pin' ? EMPTY_FOLDERS : folders
  const visiblePinned = folderFilter === 'kind' ? EMPTY_PINNED : pinnedFolders
  /**
   * 「新建项目」虚卡**只在「项目文件夹」档显示**（用户 2026-11-26 拍板）：
   * 点「项目文件夹」气泡 → 钉选卡 + 新建项目卡一起出现；「全部」「素材板块」档都不显示。
   * ⚠️ 这是用户两次纠正后的最终口径 —— 不是"恒显示"也不是"恒不显示"，是跟档位走。
   */
  const showNewProject = onNewProject !== undefined && folderFilter === 'pin'

  const filterCounts: Record<HomeFolderFilterValue, number> = {
    all: folders.length + pinnedFolders.length,
    kind: folders.length,
    pin: pinnedFolders.length
  }

  /**
   * 切气泡：翻转 animation-name（a↔b）让每张可见卡的淡入动画从零重播。
   * ★ 关键（用户 2026-11-26「闪烁」反馈的根因）：不能用 rAF 延迟挂 animation ——
   *   那样新卡片第一帧是 opacity:1 完全显示、下一帧才被拉回 0 淡入 = 肉眼可见的闪。
   *   现在把「换筛选集合」和「换 animation-name」放进**同一次渲染**：
   *   新卡片挂载即命中新 name，首帧 opacity:0，只有渐入、没有闪。
   */
  const handleFilterChange = useCallback((next: HomeFolderFilterValue): void => {
    if (next === folderFilter) return
    filterTouchedRef.current = true
    setFolderFilter(next)
    setRevealVariant((v) => (v === 'a' ? 'b' : 'a'))
  }, [folderFilter])

  /**
   * 渲染顺序：大类 + 钉选 + 虚卡拼成一张槽位表 → 按 order 排（缺失键追加到末尾，
   * 虚卡恒末尾）。**统一排序**是本次需求的口径：钉选卡可以排到素材卡前面。
   * ⚠️ 输入用**可见集合**：筛选态下只排当前类别的卡，拖拽目标下标也随之收窄。
   */
  const slots = useMemo(
    () =>
      sortHomeFolderSlots(
        buildHomeFolderSlots(
          visibleFolders.map((folder) => folder.key),
          visiblePinned.map((pin) => pin.id),
          showNewProject
        ),
        effectiveOrder
      ),
    [visibleFolders, visiblePinned, showNewProject, effectiveOrder]
  )

  /** 槽位键 → 视觉下标（同时作为 `index` 错峰与 CSS `order` 的唯一来源） */
  const slotIndexByKey = useMemo(() => {
    const map = new Map<string, number>()
    slots.forEach((slot, index) => map.set(slot.key, index))
    return map
  }, [slots])

  /**
   * 退场分半的阈值（2026-11-25 拖动排序的配套修正）。
   *
   * `home-outro.css` 里"整排退场时左半向左、右半向右"原来按 DOM 的 `nth-child` 切，
   * 拖动重排后 DOM 顺序与视觉顺序不再一致（大类 map 在前、钉选 map 在后，视觉靠
   * flex `order`）→ 会把视觉左半的卡往右赶。现在由这里按**视觉槽位下标**算出
   * `data-exit-half`，CSS 只认属性。
   *
   * n = 可见卡张数（大类 + 钉选，**末尾虚卡不计**）：`i < ceil(n/2)` 为 left。
   */
  const exitHalfSplit = useMemo(
    () => Math.ceil(slots.filter((slot) => slot.type !== 'newProject').length / 2),
    [slots]
  )

  /**
   * 正在退场的那个文件夹（`null` = 还没开始退场）。
   *
   * 用途有两个，都是纯视觉：
   *   · 给根节点打上 `data-leaving` → 整页**其余**信息按 `home-outro.css` 那套规则
   *     向屏幕边缘退开并淡出，给「文件夹本体飞到正中」让出画面；
   *   · 决定 `exit` 几何交给哪一张卡（只有它自己会飞）。
   *
   * ⚠️ **不动任何业务状态**：双击的真正落地仍是 `onOpenKind`（`App` 里排 880ms 后切
   * 视图）。因此不需要"退场结束后复位"的逻辑 —— 880ms 时视图切换、本组件整体卸载，
   * `leavingKey` / `exitGeom` 随之消失。
   *
   * （早期版本还需要 `data-leaving-index` + `:nth-child` 才能把被双击的那张从"整排
   * 向两侧退开"里摘出来；现在卡自己带着 `data-leaving="self"`，CSS 一条
   * `:not([data-leaving='self'])` 就够了，下标已无用处，不要再把它加回来。）
   */
  const [leavingKey, setLeavingKey] = useState<HomeFolderItem['key'] | null>(null)

  /**
   * 被双击那个文件夹的**退场几何**（飞到屏幕正中的位移 / 倍率）。
   * `null` = 没有过场在进行。只在 `onOpen` 里算一次：起点矩形那一刻就固定了，
   * 中途窗口 resize 不该让它改道。
   */
  const [exitGeom, setExitGeom] = useState<ExitGeom | null>(null)

  /**
   * 一次性入场淡入（`opacity 0 → 1`，200ms）。
   *
   * 为什么用 state 而不是 CSS `animation`：`animation` 在"组件重挂载"与
   * "父级重渲染"两种情况下行为不同，而这里要的是"每次进首页淡一下"。
   * 首帧必须是 0、下一帧才置 1，transition 才会真正播放（同步设成 1 不会过渡）。
   */
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    setEntered(true)
  }, [])

  // ── F-2 悬停自动横向滚动（docs/60 §6.2）────────────────────────────────────
  // 排超宽（素材卡 + 钉选卡 > 820px）时：鼠标悬停左右 48px 热区 → rAF 匀速 ~320px/s。
  // 降级口径：`motionQuality === 'smooth'` 档**整体禁用**（rAF 不启动、箭头微光不显示，
  // 保留滚轮 / 触控板手动滚动 —— 项目唯一动效降级机制，`logic/motionProfile.ts` 同源）。
  // 方向判定 / 步长 / 滚到头停的收口全在 `logic/homePinned` 纯函数里（单测覆盖）。
  const edgeScrollEnabled = quality !== 'smooth'
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const edgeDirRef = useRef<-1 | 0 | 1>(0)
  const edgeRafRef = useRef<number | null>(null)
  const edgeLastTsRef = useRef<number>(0)
  /** 边缘箭头微光的当前侧（null = 不显示）。纯视觉，不参与滚动判定。 */
  const [edgeHint, setEdgeHint] = useState<'left' | 'right' | null>(null)

  /** 停 rAF 循环（方向清零 + 提示熄灭）。卸载 / 移出排 / 滚到头 / 切换方向都会走到。 */
  const stopEdgeScroll = useCallback((): void => {
    if (edgeRafRef.current !== null) {
      window.cancelAnimationFrame(edgeRafRef.current)
      edgeRafRef.current = null
    }
    edgeDirRef.current = 0
    edgeLastTsRef.current = 0
    setEdgeHint(null)
  }, [])

  // 卸载时必须清 rAF（StrictMode 双挂载下漏清会出现幽灵滚动循环）
  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  const startEdgeScroll = useCallback((): void => {
    if (!edgeScrollEnabled || edgeRafRef.current !== null) return
    edgeLastTsRef.current = 0
    const tick = (ts: number): void => {
      const el = scrollRef.current
      if (el === null) {
        edgeRafRef.current = null
        return
      }
      const dir = edgeDirRef.current
      const max = el.scrollWidth - el.clientWidth
      if (dir === 0 || max <= 0) {
        edgeRafRef.current = null
        return
      }
      // rAF 回拨兜底：首帧 / 挂起恢复后 dt 可能异常，edgeScrollStep 内部按 0 处理
      const dt = edgeLastTsRef.current > 0 ? ts - edgeLastTsRef.current : 16
      edgeLastTsRef.current = ts
      const next = nextScrollLeft(el.scrollLeft, dir, edgeScrollStep(dt), 0, max)
      el.scrollLeft = next
      if ((dir === -1 && next <= 0) || (dir === 1 && next >= max)) {
        // 滚到头自动停（docs/60 §6.2「边界」）
        edgeRafRef.current = null
        edgeDirRef.current = 0
        edgeLastTsRef.current = 0
        setEdgeHint(null)
        return
      }
      edgeRafRef.current = window.requestAnimationFrame(tick)
    }
    edgeRafRef.current = window.requestAnimationFrame(tick)
  }, [edgeScrollEnabled])

  const handleRowMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      // 拖动态下关掉悬停自动滚动：否则排会自己横向跑，落点判定与让位全部错位
      if (dragRef.current !== null) {
        if (edgeDirRef.current !== 0) stopEdgeScroll()
        return
      }
      const el = scrollRef.current
      if (el === null) return
      // 内容没超宽 = 没有可滚的东西，热区不吃任何行为（也不显示箭头微光）
      if (el.scrollWidth <= el.clientWidth + 1) {
        if (edgeDirRef.current !== 0) stopEdgeScroll()
        return
      }
      if (!edgeScrollEnabled) return
      const rect = el.getBoundingClientRect()
      const dir = edgeScrollDirection(
        event.clientX,
        event.clientY,
        { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        { topInset: SCROLL_PAD_TOP, bottomInset: SCROLL_PAD_BOTTOM },
        EDGE_HOT_ZONE_PX
      )
      if (dir !== edgeDirRef.current) {
        // 先停（清 rAF 与提示），再写新方向 —— 左热区直接划到右热区也要成立
        stopEdgeScroll()
        edgeDirRef.current = dir
        if (dir !== 0) {
          setEdgeHint(dir === -1 ? 'left' : 'right')
          startEdgeScroll()
        }
      }
    },
    [edgeScrollEnabled, startEdgeScroll, stopEdgeScroll]
  )

  const handleRowMouseLeave = useCallback((): void => {
    stopEdgeScroll()
  }, [stopEdgeScroll])

  // ── 拖动排序：指针手势（阈值 / 让位 / 取消 / 吞 click）──────────────────────
  /** rAF 里唯一的写入口：被拖卡跟手抬升，其余卡按目标位置让位一格 */
  const applyDragFrame = useCallback((): void => {
    dragRafRef.current = null
    const drag = dragRef.current
    if (drag === null) return
    for (let i = 0; i < drag.keys.length; i += 1) {
      const key = drag.keys[i]
      const element = drag.els.get(key)
      if (element === undefined) continue
      if (key === drag.key) {
        // 抬升：上移 4px + 放大 1.04 + 跟手位移（阴影加深在 CSS 的 data-drag-source 上）
        element.style.transform = `translate3d(${drag.dx.toFixed(1)}px, -4px, 0) scale(1.04)`
        continue
      }
      const shift = dragSlotShift(drag.fromIndex, drag.toIndex, i)
      const next = shift === 0 ? '' : `translate3d(${(shift * drag.step).toFixed(1)}px, 0, 0)`
      if (element.style.transform !== next) element.style.transform = next
    }
  }, [])

  const scheduleDragFrame = useCallback((): void => {
    if (dragRafRef.current === null) {
      dragRafRef.current = window.requestAnimationFrame(applyDragFrame)
    }
  }, [applyDragFrame])

  /** 命中卡片 → 真正进入拖动态（固定捕获 / 打抬升标记 / 写第一帧） */
  const beginDrag = useCallback(
    (press: FolderPressState, pointerX: number): void => {
      const row = rowRef.current
      if (row === null) return
      const els = new Map<string, HTMLElement>()
      row.querySelectorAll<HTMLElement>('[data-slot-key]').forEach((element) => {
        const key = element.dataset.slotKey
        if (key !== undefined && key.length > 0) els.set(key, element)
      })
      // 可拖卡 = 视觉顺序里的全部真实卡（虚卡不入 order、也不可拖）
      const keys = slots
        .filter((slot) => slot.type !== 'newProject')
        .map((slot) => slot.key)
      const fromIndex = keys.indexOf(press.key)
      const sourceEl = els.get(press.key)
      if (fromIndex < 0 || sourceEl === undefined) return
      const centers: number[] = []
      for (const key of keys) {
        const element = els.get(key)
        if (element === undefined) return
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0) return
        centers.push(rect.left + rect.width / 2)
      }
      // 槽位等宽等距（同一套 --gf-scale + justify-between），相邻中心距即让位步长；
      // 只有一张卡时退化成"卡宽 + 常见间隙"，拖动本身仍然可用（不会出现 0 步长）。
      const firstRect = sourceEl.getBoundingClientRect()
      const step =
        centers.length > 1 ? centers[1] - centers[0] : firstRect.width + 16
      dragRef.current = {
        pointerId: press.pointerId,
        key: press.key,
        keys,
        els,
        centers,
        step: Math.max(1, step),
        startX: press.startX,
        fromIndex,
        toIndex: fromIndex,
        dx: pointerX - press.startX,
        sourceEl
      }
      pressRef.current = null
      // 捕获落在被拖卡上：后续 move / up 全回这里（鼠标移出窗口也不会丢）
      try {
        sourceEl.setPointerCapture?.(press.pointerId)
      } catch {
        // 老浏览器 / 已释放的指针：捕获失败不影响拖动（move 仍冒泡到排容器）
      }
      sourceEl.dataset.dragSource = 'true'
      sourceEl.style.transition = 'none' // 跟手：不许有 160ms 过渡拖尾
      sourceEl.style.zIndex = '30'
      setDraggingKey(press.key)
      applyDragFrame()
    },
    [applyDragFrame, slots]
  )

  /**
   * 结束一次拖动（`commit` = 落位写档；`false` = Esc / pointercancel 取消）。
   *
   * 收尾顺序很讲究（否则会"飞两次"）：
   *   ① 先把**所有**卡的 transform 瞬时清零 —— 同时 React 在同一帧里把新的
   *      CSS `order` 提交上去，base 位移与 transform 归零相互抵消，不会看见跳变；
   *   ② 只有"原地松手（没换位）"的被拖卡保留默认过渡，让它 160ms 滑回原位；
   *   ③ 下一帧把内联 transition 撤掉，交回 CSS（含 prefers-reduced-motion 的降级）。
   */
  const finishDrag = useCallback(
    (commit: boolean): void => {
      const drag = dragRef.current
      if (drag === null) return
      dragRef.current = null
      pressRef.current = null
      if (dragRafRef.current !== null) {
        window.cancelAnimationFrame(dragRafRef.current)
        dragRafRef.current = null
      }
      const moved = commit && drag.toIndex !== drag.fromIndex
      const elements = [...drag.els.values()]
      for (const [key, element] of drag.els) {
        element.removeAttribute('data-drag-source')
        element.style.zIndex = ''
        if (moved || !commit || key !== drag.key) {
          // 换位 / 取消 → 必须瞬时复位（理由见①）
          element.style.transition = 'none'
          element.style.transform = ''
        } else {
          // 原地松手 → 被拖卡走 CSS 的 160ms 过渡滑回原位（先撤掉跟手时的 none）
          element.style.transition = ''
          element.style.transform = ''
        }
      }
      // 强制一次样式计算，让"无过渡复位"先落地，再在下一帧交回 CSS 过渡
      void (rowRef.current?.offsetWidth ?? 0)
      window.requestAnimationFrame(() => {
        for (const element of elements) element.style.transition = ''
      })
      try {
        if (drag.sourceEl.hasPointerCapture?.(drag.pointerId)) {
          drag.sourceEl.releasePointerCapture(drag.pointerId)
        }
      } catch {
        // 指针已消失（pointercancel / 窗口失焦）：无需释放
      }
      setDraggingKey(null)
      if (!commit) {
        // 取消路径（pointercancel / 指针离开）：本来就没有排序动作，但收尾仍可能有
        // 一次 click 落下来，照旧吞掉，避免"取消拖动"变成"翻开文件夹"。
        suppressClickRef.current = true
        return
      }

      // 顺序没变（原地松手 / 落回原位）→ 一个字都不写，**也不吞 click**。
      // 真人手点时的 4~8px 横向手抖会越过阈值进入拖动态，但落回原位什么都不改，
      // 那次点击应当照常翻开文件夹；无条件吞掉正是"点文件夹打不开"的根因。
      if (drag.toIndex === drag.fromIndex) return

      // 真正的排序发生了：这一下 click 必须吞掉，否则拖完会顺手翻开 / 进入文件夹
      suppressClickRef.current = true
      const base = normalizeHomeFolderOrder(folderOrder)
      const nextVisible = moveHomeFolderKey(drag.keys, drag.key, drag.toIndex)
      const nextOrder = applyHomeFolderOrder(base, nextVisible)
      if (nextOrder.length === base.length && nextOrder.every((key, i) => key === base[i])) return
      setPendingOrder(nextOrder)
      // 成功：props 已带着新顺序回来，清掉乐观值不会闪（同一批 setState）；
      // 失败：清掉乐观值 = 回到 props 的旧顺序（**回滚**），提示由 App 给。
      // 无论成败都不保留 pendingOrder —— 它只是"等写档"的临时遮罩。
      void onReorderFolders(nextOrder)
        .then(() => setPendingOrder(null))
        .catch(() => setPendingOrder(null))
    },
    [folderOrder, onReorderFolders]
  )

  /** Esc 取消本次拖动（不动数据、不写档） */
  useEffect(() => {
    if (draggingKey === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finishDrag(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [draggingKey, finishDrag])

  /** 卸载兜底：rAF 与指针捕获一个都不许漏 */
  useEffect(() => {
    return () => {
      if (dragRafRef.current !== null) {
        window.cancelAnimationFrame(dragRafRef.current)
        dragRafRef.current = null
      }
    }
  }, [])

  /**
   * 按下：只记起点。**不 preventDefault、不捕获指针、不改 state** ——
   * 单击 / 双击 / 右键的默认路径在这一刻之后完全照旧；只有真的拖起来才改变手势。
   */
  const handleRowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      suppressClickRef.current = false
      if (event.pointerType === 'touch') return // 触屏留给横向滚动，不做拖动排序
      if (event.button !== 0) return // 右键归 contextmenu
      if (dragRef.current !== null) return
      // 上一次的顺序还在写档（乐观值还没落定）→ 这一下先不接拖动，
      // 否则第二次拖动会以"旧 base"为起点合入，把前一次的改动叠掉。
      if (pendingOrder !== null) return
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest<HTMLElement>('[data-slot-key]')
      const key = card?.dataset.slotKey
      if (card === null || key === undefined || key.length === 0) return
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        key
      }
    },
    [pendingOrder]
  )

  /** 移动：先过阈值（横向优先）再进拖动态；进入后每帧只改 transform */
  const handleRowPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (drag !== null) {
        if (event.pointerId !== drag.pointerId) return
        drag.dx = event.clientX - drag.startX
        drag.toIndex = nearestSlotIndex(drag.centers, event.clientX)
        scheduleDragFrame()
        return
      }
      const press = pressRef.current
      if (press === null || event.pointerId !== press.pointerId) return
      const dx = event.clientX - press.startX
      const dy = event.clientY - press.startY
      // 阈值（≈4px）+ 横向优先：竖向手抖不抢单击 / 双击
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
      if (Math.abs(dx) < Math.abs(dy)) return
      beginDrag(press, event.clientX)
    },
    [beginDrag, scheduleDragFrame]
  )

  const handleRowPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (drag === null) {
        pressRef.current = null
        return
      }
      if (event.pointerId !== drag.pointerId) return
      finishDrag(true)
    },
    [finishDrag]
  )

  /** 系统打断（窗口失焦 / 触控被接管）→ 取消并复位，不写档 */
  const handleRowPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (drag === null) {
        pressRef.current = null
        return
      }
      if (event.pointerId !== drag.pointerId) return
      finishDrag(false)
    },
    [finishDrag]
  )

  /**
   * 指针离开排（还没到阈值就在外面松手了）→ 丢掉起点。
   * 鼠标的 `pointerId` 是跨按下/抬起恒定的，残留的起点会让"下一次悬停"被误判成
   * 一次大位移拖动 —— 必须清。
   */
  const handleRowPointerLeave = useCallback((): void => {
    if (dragRef.current === null) pressRef.current = null
  }, [])

  /**
   * 拖动松手后的那一次 `click`（`dblclick` 同理）在**捕获阶段**吞掉：
   * 卡片自己的 onClick / onDoubleClick 根本收不到，所以拖完绝不会翻开或进入。
   * 标志位在下一次 pointerdown 复位，不会误吞后续的正常点击。
   */
  const handleRowClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  // ── F-1/F-3 文件夹排右键菜单（docs/60 §6.1/§6.3）──────────────────────────
  // 菜单项构成在 logic/contextMenu 的纯函数里（单测覆盖）；组件只画 + 调回调。
  const [folderMenu, setFolderMenu] = useState<HomeFolderMenu | null>(null)
  const openFolderMenu = useCallback((menu: HomeFolderMenu): void => {
    setFolderMenu(menu)
  }, [])
  const buildFolderMenuItems = (): ContextMenuItem[] => {
    const menu = folderMenu
    if (menu === null) return []
    if (menu.type === 'row') {
      return homeRowMenuItems({ onAddPinned, onNewProject })
    }
    if (menu.type === 'kind') {
      const key = kindWallpaperKey(menu.key)
      return homeKindMenuItems(wallpaperUrlOf(folderWallpapers, key) !== null, {
        onSetWallpaper: () => onSetFolderWallpaper(key),
        onClearWallpaper: () => onClearFolderWallpaper(key)
      })
    }
    const key = pinWallpaperKey(menu.id)
    const index = pinnedFolders.findIndex((p) => p.id === menu.id)
    return homePinnedMenuItems({
      // v1.2 反馈批 B：菜单项「在资源管理器中打开」走 onRevealPinned（home:pinnedOpen 兜底出口）；
      // 双击卡片走 onOpenPinned（应用内浏览）—— 两条路互不借用。
      onOpen: () => onRevealPinned(menu.id),
      onMoveLeft: () => onMovePinned(menu.id, -1),
      onMoveRight: () => onMovePinned(menu.id, 1),
      onSetWallpaper: () => onSetFolderWallpaper(key),
      onClearWallpaper: () => onClearFolderWallpaper(key),
      onRemove: () => onRemovePinned(menu.id),
      canLeft: index > 0,
      canRight: index >= 0 && index < pinnedFolders.length - 1,
      hasWallpaper: wallpaperUrlOf(folderWallpapers, key) !== null
    })
  }


  /**
   * ⚠️ 这里**故意没有**驱动消隐的 effect。
   *
   * 消隐是一段纯 CSS 动画（`@keyframes gf-folder-dissolve`：blur 0→14px 同时
   * opacity 1→0，600ms 延迟、280ms 时长、`both` 填充），起止时刻由 `glass-folder.css`
   * 写死，与 `EXIT_FLY_MS / EXIT_HOLD_MS / EXIT_DISSOLVE_MS` 三个常量配成一对。
   *
   * 曾经有一版在这里起 rAF 逐帧写 `--gf-hole`（从中心挖一个圆洞）。用户看到真机后
   * 否掉了那个方案（「我要的是高斯模糊的消影哦，你给我的是中间一个圆圈，然后把它挖掉」），
   * 整套 mask + rAF 一起删除。**不要再加回来**：JS 逐帧改 filter/opacity 会让每一帧
   * 都穿越 React 之外的合成路径，且必然与 CSS 动画争同一个属性（animation origin
   * 高于 style attribute），形成"看不出谁在驱动"的随机 bug。
   */

  /**
   * 退场开关（过场时间轴的前半段，60–320ms）挂在根节点上：
   * `data-leaving="true"` = 整页其余信息向屏幕边缘退开 + 淡出。
   * 被双击的那张卡**不**参与这套规则（它自己带着 `data-leaving="self"` 在飞），
   * 靠 `home-outro.css` 里的 `:not([data-leaving='self'])` 摘出来。
   *
   * `data-folder-count`：这个排里实际有几张卡。**少于 4 张时排布要从"两端撑开"
   * 切成"居中紧凑"**，数据卡的位置也要跟着解耦（见 `home-outro.css` / `home-stats.css`）。
   * 用户的原话：「有很多用户可能只用我们的"材质"和"模型"文件夹，另外几个文件夹
   * 可能就不存在，那就不显示了。所以这个问题是需要考虑到的。」
   */
  return (
    <div
      className="hc-root relative flex min-h-0 flex-1 flex-col"
      data-leaving={leavingKey !== null ? 'true' : 'false'}
      data-folder-count={folders.length}
      style={{
        opacity: reduced || entered ? 1 : 0,
        transition: reduced ? undefined : 'opacity 200ms ease'
      }}
    >
      {/* ① 粒子层：铺满内容区、在一切内容之下、不吃点击（否则会吞掉文件夹的 hover）。
          2026-11-23 用户口径修正：**壁纸与海浪互斥** —— 挂了壁纸（source !== 'none'
          且有文件）时粒子层整体不渲染，壁纸就是背景本身；无壁纸时粒子画布走不透明
          底色，与 v1.1.0 之前的画面逐字一致。transparentBackground 传参随之移除
          （引擎能力保留在 particleTide 里，当前无调用场景）。
          退场时只压暗到 0.25、不位移（理由见 `home-outro.css` 的 `.hc-exit--faint`）。 */}
      {!hasWallpaper ? (
        <div className="hc-exit hc-exit--faint pointer-events-none absolute inset-0 z-0" aria-hidden="true">
          <HomeParticles quality={quality} waveColors={waveColors} waveHeight={waveHeight} />
        </div>
      ) : null}

      {/* ② 设置齿轮：**左下角**（用户 2026-11-09：「首页的设置放到左下角去」）。
          原先在右上角，和磨砂数据卡抢同一块视觉重心；挪到左下后右上只留数据卡，
          整屏重心也压回中间那排文件夹上。
          `app-no-drag` 是顶栏拖动区纪律的配套类 —— 虽然这里不在顶栏内，
          但内容区与顶栏拖动条视觉相连，保持一致并无害。
          退场时向左退 32px 并淡出（`hc-exit--left`）。 */}
      {/* 设置齿轮（T4 首页引导第 4 步锚点 data-guide：纯属性，不改布局 / 不改交互） */}
      <button
        type="button"
        data-guide="settings"
        className={`hc-exit hc-exit--left app-no-drag absolute bottom-[24px] left-[24px] z-20 flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors ${wallUiClass.gear}`}
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
      >
        <IconSettings width={16} height={16} />
      </button>

      {/* ③ 数据看板：磨砂玻璃卡（本月入库 / 库总量 / 待补分类），见 HomeStats。
          本版**不做**点击跳转（等验收后再加，避免一次交付两套交互）。
          退场时向右退 48px 并淡出 —— 但它**不能**在这里套一层带 `hc-exit` 的 div：
          `.hs-card` 是 `position: absolute`，一旦包一层会被加上 `translate` 的父级
          （= 新的包含块），它的 `right/top` 会改成相对那个零尺寸盒子解析、瞬间跳到
          左上角。所以方向/淡出由 `home-outro.css` 直接命中 `.hs-card`（那边同时要
          撤掉入场 `animation` 的 `fill`，否则 opacity 改不动）。

          `showHomeStats`（设置·外观）关掉后整块不渲染 —— 用户口径是「只用模型和材质
          两个文件夹的人，右上那三个数字没意义」。条件渲染而不是 `display:none`：
          关掉就该连空间一起消失，别留一块看不见的绝对定位元素在 `pointer-events`
          之外游荡。 */}
      {showHomeStats ? <HomeStats stats={stats} folders={folders} /> : null}

      {/* ④ 底部组：搜索 → 文件夹排 → 一行提示。整组靠底，`justify-end` 吃掉上方余量 */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end px-[92px] pb-[56px]">
        {/* 搜索：收起态是 240×32 的一条，点开后**同一个盒子**被弹簧连续长成
            560×(49+列表高) 的命令面板（skiper-92 那套）。
            ⚠️ 面板靠溢出显示，上沿比收起盒高 8px、向下长约 350px ——
            祖先链上**不能**出现 `overflow:hidden` / `overflow:clip`。
            本组是 flex-col + justify-end，下方余量够，但改布局时要注意。
            退场时整条向下退 28px 并淡出（`hc-exit--down` 挂在下面这层包裹上）。 */}
        {/* T4 引导第 1 步锚点：搜索（纯属性，不改布局） */}
        <div className="hc-exit hc-exit--down mx-auto shrink-0" data-guide="search">
          <HomeSearchCommand
            groups={searchGroups}
            onPick={onPickSearch}
            placeholder="搜索素材、分类或文件名"
            shortcut="K"
          />
        </div>

        {/* 文件夹排：`GlassFolder` 卡片（当前库里 4 个分类有素材 → 4 张；
            空分类不占入口的规则在 `App.tsx` 的 `homeFolders` 里，本组件不判）。
            尺寸由组件自己的 `--gf-scale` 跟窗口走（整排已缩到上一版的 2/3：
            1080 ≈ 104px、1440 ≈ 151px、1520+ 上限 161px），父级**不要**再写死宽高。
            ⚠️ 父级**不能**加 `overflow-hidden` —— 卡片的翻盖/阴影会伸出根部盒子。

            ── 行宽上限 960 → 820（用户 2026-11-09：「变成下方 4 个文件夹」）──────────
            960 是给「5 张卡」定的：缩到 2/3 以后 5×151=753 摊在 ~1256 里太散架
            （4 个间隙各 ~126px），所以收窄到 960 并居中。
            而 5 张变成 4 张后，960 反而太松：4×151 = 604，3 个间隙各 (960−604)/3 ≈ 118px，
            又是"散架"的读数。按 4 张卡反算：
              · 1440 窗口：可用宽 = 100vw − 184 = 1256 > 820 → 行宽取 820，
                4×151 = 604，(820 − 604) / 3 ≈ **72px** 间隙 —— 紧凑但不挤。
              · 1080 窗口（窗口最小宽）：可用宽 = 896 > 820 → 行宽仍是 820，
                4×104 = 416，(820 − 416) / 3 ≈ **135px** 间隙。
                1080 下确实偏松 —— 但这是卡片等比缩放的必然结果（卡变小、带子不变），
                且 1080 是极限窄窗口，**不要**为它加断点特例：宁可偏松也不要让
                常驻窗口（1280~1600）变紧。
              · 1520+：卡封顶 161 → 4×161 = 644，(820 − 644) / 3 ≈ 59px。
            ⚠️ 改了这里的 820，必须同步改 `home-stats.css` 里 `.hs-card` 的 `right`
            （数据卡右边缘要与第 4 张卡的右边缘逐像素对齐，公式里含行宽）。

            `justify-between` 让卡片在这条 820 的带子里均分空白；若将来「其他」分类
            有了素材、第 5 张卡回来，5×151=755 ≤ 820 依然放得下，间隙缩到 ~16px，可接受。
            `[&>*]:shrink-0`：组件根节点已经写了 `flex: none`，这里再兜一道，
            防止将来有人给 `.gf-root` 换 class 名时被 flex 压扁 ——
            内部是按设计稿 340×272 等比缩放的一组卡片，一压就会互相穿模。

            ── `onOpen` 里的两句**顺序不能换**（本轮新增）──────────────────────
            · `setLeavingKey(folder.key)`：整页其余信息在同一帧开始向边缘退开，
              并且这一张立刻消失（它的替身由 `HomeOutro` 从同一矩形接着飞）；
            · `onOpenKind(folder.key, payload)`：交给 `App` 排「600ms 后切视图」。
            反过来的话 `App` 先切视图 → 本组件先卸载，退场动画根本不会播。
            两个 setState 在同一个事件回调里，React 18 会合并成一次渲染。
            另外这一排的 class `hc-folder-row` 是退场规则的选择器锚点（左右半排分开退），
            见 `home-outro.css`。 */}
        {/* T4 引导第 3 步数据卡的锚点由 T4 在 HomeStats.tsx 根节点上加，本文件不包裹它 ——
            包一层会改变 .hs-card 的绝对定位包含块，导致数据卡跳到左上角。

            ── T-05（docs/60 §6.1/§6.2）：同排追加钉选卡 + 悬停自动滚动 ─────────────
            结构升级为「wrap（布局定位，尺寸与旧排逐字一致）→ scroll（overflow-x:auto，
            隐藏滚动条）→ row（卡片）」：
            · 钉选卡**同排追加**在素材大类卡之后（§6.1 拍板形态，不分区不换行）；
            · 排超宽时 `.hc-folder-scroll` 横向滚动（滚轮 / 触控板仍可手动滚），
              左右 48px 热区悬停自动滚（`edgeScrollEnabled` = 非 smooth 档）；
            · `.hc-folder-scroll` 的补偿 padding 与本文件 SCROLL_PAD_* 是一对
              （卡片 hover 翻盖伸出盒子的部分不再被竖向裁掉，布局位置不变）；
            · 右键：卡片 → 钉选/底纹菜单，空白处 → 添加快速访问（卡片内
              `stopPropagation` 抢在 wrap 之前）。 */}
        <div
          className="hc-folder-wrap relative mx-auto mt-10 w-full max-w-[820px]"
          data-guide="folders"
          data-reveal={filterTouchedRef.current ? revealVariant : 'none'}
          data-reveal-motion={quality !== 'smooth' && !reduced ? 'true' : 'false'}
          onMouseMove={handleRowMouseMove}
          onMouseLeave={handleRowMouseLeave}
          onContextMenu={(e) => {
            // 卡片自己的 onContextMenu 会 stopPropagation；走到这里 = 排的空白处
            e.preventDefault()
            openFolderMenu({ type: 'row', x: e.clientX, y: e.clientY })
          }}
        >
          <div ref={scrollRef} className="hc-folder-scroll">
            <div
              ref={rowRef}
              className="hc-folder-row flex w-full items-start justify-between [&>*]:shrink-0"
              data-count={visibleFolders.length + visiblePinned.length + (showNewProject ? 1 : 0)}
              /* 拖动排序（2026-11-25）：事件委托在这一层 —— 卡片不需要认识指针，
                 只有 `data-slot-key` 与 CSS `order` 是它参与排序的全部接口。
                 `onMouseMove/Leave` 还是原来的悬停自动滚动，两套互斥（拖动态里
                 滚动直接短路，见 handleRowMouseMove 首行）。 */
              data-dragging={draggingKey !== null ? 'true' : 'false'}
              onPointerDown={handleRowPointerDown}
              onPointerMove={handleRowPointerMove}
              onPointerUp={handleRowPointerUp}
              onPointerCancel={handleRowPointerCancel}
              onPointerLeave={handleRowPointerLeave}
              onClickCapture={handleRowClickCapture}
              onDoubleClickCapture={handleRowClickCapture}
            >
              {visibleFolders.map((folder, index) => {
                const slotKey = homeKindFolderKey(folder.key)
                const slotIndex = slotIndexByKey.get(slotKey) ?? index
                return (
                  <GlassFolder
                    key={folder.key}
                    label={folder.label}
                    count={folder.count}
                    thumbs={folder.thumbs}
                    index={slotIndex}
                    slotKey={slotKey}
                    order={slotIndex}
                    exitHalf={slotIndex < exitHalfSplit ? 'left' : 'right'}
                    wallpaperUrl={wallpaperUrlOf(folderWallpapers, kindWallpaperKey(folder.key))}
                    /**
                     * `exit` 只给**被双击的那一个**（其余是 null → 走 CSS 的"向两侧退开"）。
                     * 用 `leavingKey` 判等而不是下标：`folders` 顺序将来变了也不影响。
                     */
                    exit={folder.key === leavingKey ? exitGeom : null}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      openFolderMenu({ type: 'kind', x: e.clientX, y: e.clientY, key: folder.key })
                    }}
                    onOpen={(payload) => {
                      /**
                       * 顺序：**先算几何 / 打退场标记，再跳转**。
                       * · `setExitGeom` + `setLeavingKey` 让这一个文件夹本体开始飞、整页其余
                       *   信息向边缘退开；
                       * · `onOpenKind` 只是把"880ms 后切视图"排进 `App` 的定时器。
                       * 反过来的话 `App` 先切视图 → 本组件先卸载，退场动画根本不会播。
                       * 三个 setState 在同一个事件回调里，React 18 合并成一次渲染 ——
                       * 所以文件夹拿到 `exit` 的那一帧，也是整页开始退场的那一帧。
                       *
                       * `reduced`（系统要求减少动效）：什么都不做。`App` 会立刻切视图、
                       * 本组件当场卸载；既不用飞、也不用消隐，连 rAF 都不该起。
                       */
                      if (!reduced) {
                        setExitGeom(computeExitGeom(payload.rect))
                        setLeavingKey(folder.key)
                      }
                      onOpenKind(folder.key, payload)
                    }}
                  />
                )
              })}
              {/* 钉选卡（F-1）：同排追加、右上角角标、无计数（「外部」）、双击打开。
                  入场错峰与视觉次序都取**合并排序后的槽位下标**（钉选现在可以排在
                  素材大类卡前面，两段 map 只决定 DOM 顺序、不决定视觉顺序）。 */}
              {visiblePinned.map((pin, pinIndex) => {
                const slotKey = homePinFolderKey(pin.id)
                const slotIndex = slotIndexByKey.get(slotKey) ?? visibleFolders.length + pinIndex
                return (
                  <GlassFolder
                    key={`home-pin-${pin.id}`}
                    label={pin.name}
                    count={0}
                    thumbs={[null, null, null]}
                    pinned
                    index={slotIndex}
                    slotKey={slotKey}
                    order={slotIndex}
                    exitHalf={slotIndex < exitHalfSplit ? 'left' : 'right'}
                    wallpaperUrl={wallpaperUrlOf(folderWallpapers, pinWallpaperKey(pin.id))}
                    onOpen={() => onOpenPinned(pin.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      openFolderMenu({ type: 'pin', x: e.clientX, y: e.clientY, id: pin.id })
                    }}
                  />
                )
              })}
              {/* 「新建项目」虚卡：只在「项目文件夹」档显示（showNewProject 已按档位判定）。
                  位置恒在该档末尾；「全部」「素材板块」档不渲染。 */}
              {showNewProject ? (
                <NewProjectFolderCard
                  index={
                    slotIndexByKey.get(HOME_NEW_PROJECT_SLOT_KEY) ??
                    visibleFolders.length + visiblePinned.length
                  }
                  order={
                    slotIndexByKey.get(HOME_NEW_PROJECT_SLOT_KEY) ??
                    visibleFolders.length + visiblePinned.length
                  }
                  onClick={onNewProject}
                />
              ) : null}
            </div>
          </div>

          {/* 边缘热区提示（F-2）：箭头微光淡入淡出，零布局位移（absolute + pointer-events:none）。
              smooth 档下 edgeHint 恒为 null（rAF 循环不启动），提示永不出现 —— 降级口径。 */}
          <span
            className="hc-folder-edge"
            data-side="left"
            data-visible={edgeHint === 'left' ? 'true' : 'false'}
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 5.5L8 12l6.5 6.5" />
            </svg>
          </span>
          <span
            className="hc-folder-edge"
            data-side="right"
            data-visible={edgeHint === 'right' ? 'true' : 'false'}
            aria-hidden="true"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 5.5L16 12l-6.5 6.5" />
            </svg>
          </span>
        </div>

        {/* 类别筛选气泡（gallery10 Browse by type）：主页内筛选，不离开主页。
            用户 2026-11-26 拍板放在**文件夹排下方**（原在上方，现下移）：
            视觉顺序 = 搜索 → 文件夹排 → 气泡 → 提示字。mt-7 与提示行的 mt-54 分摊。 */}
        <div className="hc-exit hc-exit--down mx-auto mt-7 w-full max-w-[820px] shrink-0">
          <HomeFolderFilter
            value={folderFilter}
            onChange={handleFilterChange}
            counts={filterCounts}
            motion={quality !== 'smooth' && !reduced}
          />
        </div>

        {/* 提示字：常驻，不做渐隐（首页控件 ≤ 1 图标 + 1 行提示的口径）。
            前半句「双击文件夹进入」是交互改动的必要提示：单击只播翻开动画，
            不给这行字用户会以为单击失灵。
            后半句用「拖入文件」而非「拖入压缩包」（2026-11-11 用户拍板）：
            导入入口不只收压缩包，单张图片、模型文件、CAD 图纸、HDR、D5A 等都能直接拖入，
            写「压缩包」会把其他入口说没了。不要改回旧文案。
            退场时向下退 24px 并淡出（`hc-exit--down-soft`：它离底边更近，少退 4px）。 */}
        <div className={`hc-exit hc-exit--down-soft mt-[54px] text-center text-[12px] ${wallUiClass.hint}`}>
          双击文件夹进入 · 拖入文件即可导入
        </div>
      </div>

      {/* F-1/F-3 右键菜单（钉选 / 底纹 / 添加快速访问）：共用 ContextMenu 外壳
          （定位夹取 / 点外关闭 / Esc 关闭都在外壳里，z-50 与其它菜单同档）。 */}
      {folderMenu !== null ? (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={buildFolderMenuItems()}
          onClose={() => setFolderMenu(null)}
        />
      ) : null}
    </div>
  )
}
