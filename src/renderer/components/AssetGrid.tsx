import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVault, useVisibleAssets } from '../store'
import { KIND_LABEL } from '../../shared/classify'
import { formatBytes, formatDate, thumbVaultUrl, vaultUrl } from '../../shared/format'
import {
  EMPTY_ALIASES,
  aliasIndexOf,
  resolveAssetDisplayName
} from '../logic/aliasIndex'
import { primaryFileName, primaryFileAbs } from '../logic/assetPath'
import {
  buildFileRows,
  boxOf,
  marqueeHitIds,
  type BoxRect,
  type FileRow
} from '../logic/fileView'
import { categoriesOf, isCrossKind } from '../logic/category'
import {
  duplicateCountMap,
  groupDuplicates,
  groupLabel,
  type DupGroup
} from '../logic/duplicates'
import { ColorDot, FavoriteStar, StarIcon, colorSwatchStyle } from './MarkControls'
import { ASSET_DRAG_MIME, dragIdsOf, serializeDragIds } from '../logic/dragAssign'
import { beginSystemDrag } from '../logic/dragOut'
import { cacheDragCard, cachedDragCard, cancelDragCardPrewarm, dragCardKey, prewarmDragCard as prewarmDragCardBitmap, renderDragCard } from '../logic/dragCard'
import { DEFAULT_FILTERS, activeFilterDimensions, applyFilters } from '../logic/filters'
import { isDeletedAsset, trashBadgeText } from '../logic/trashView'
import { isHdrExt } from '../../shared/hdrExts'
import { dataChannelLabel } from '../logic/materialBall'
import { canStage, stageController } from '../logic/stageController'
import { currentMotionProfile } from '../logic/motionProfile'
import {
  GRID_GAP,
  GRID_PAD_X,
  LIST_ROW_H,
  gridRowHeights,
  metricsFor
} from '../logic/gridMetrics'
import { computeRowWindow } from '../logic/virtualWindow'
import { useScrollViewport, useVirtualWindow } from '../hooks/useVirtualWindow'
import { AssetContextMenu } from './AssetContextMenu'
import { FileContextMenu } from './FileContextMenu'
import { EmptyAreaContextMenu } from './EmptyAreaContextMenu'
import { MENU_TARGET_SELECTOR } from '../logic/contextMenu'
import { PurgeConfirmDialog } from './PurgeConfirmDialog'
import {
  IconBox,
  IconCheck,
  IconEmptyFilter,
  IconEmptyLibrary,
  IconFile,
  IconHdr,
  IconImage,
  IconMaterial,
  IconOther,
  IconRefresh,
  IconTag,
  IconTrash
} from '../icons'
import { COLOR_TAG_LABEL } from '../../shared/types'
import type { Asset, AssetKind, GridDensity } from '../../shared/types'
import type { CSSProperties, DragEvent, MouseEvent, RefObject, SVGProps } from 'react'

/**
 * 密度三档 → 网格 `minmax` 下限（反馈 6b，docs/15 §6b：大 240 / 中 184 / 小 132）。
 *
 * ⚠️ 三个 class **必须写成完整字面量**：Tailwind 3 是构建期正则扫源码，
 * `grid-cols-[repeat(auto-fill,minmax(${px}px,1fr))]` 这种拼接出来的类名扫不到 →
 * 产物里没有对应规则 → 档位切换静默失效。
 */
const GRID_COLS: Record<GridDensity, string> = {
  large: 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]',
  medium: 'grid-cols-[repeat(auto-fill,minmax(184px,1fr))]',
  small: 'grid-cols-[repeat(auto-fill,minmax(132px,1fr))]'
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 中栏文件视图（双击进入）的进出场动画参数
 *
 * 用户口径：「进入和退出…用 Windows 8 那个样子的磁贴进入和飞出的动画」。
 * 实现纪律：
 * - **纯 CSS keyframes + class 切换**（`styles.css`），不引入任何动画库；
 * - 时长/延迟在这里定常量，只有"档位差异"在 CSS 里按 `data-motion` 分档；
 * - `prefers-reduced-motion: reduce` 命中时全部退化成 190ms 纯 opacity，
 *   且**取消递增延迟**（延迟会让"减少动效"的人等更久，与意图相反）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 磁贴入场的递增延迟步长（用户口径 20–30ms） */
const FOLDER_STAGGER_MS = 24
/** 递增只作用于前 N+1 条（再往后时间会太长；用户明确要求"最多前 8 行"） */
const FOLDER_STAGGER_MAX_INDEX = 8
/**
 * 退出（飞出）总时长 = **卸载时刻**。与 `styles.css` 的 `.folder-stage-leave` 逐字对齐。
 *
 * 2026-10-22 由 160 → 260：磁贴出场要"看得见"，就得满足三件事，总时长被它们共同决定：
 * - 舞台前 **120ms 保持不透明**（`folder-stage-out` 的前 46%），磁贴位移才不会被整块淡出吃掉；
 * - 磁贴自身 150ms（`folder-tile-out`）；
 * - 出场错峰 `--folder-stagger × 0.5`（12ms/条，最多 96ms）→ 最后一条在 84~96 + 150 = **246ms** 结束。
 * 260ms 卸载留 14ms 余量；**必须 ≥ 246ms**，否则最后几条会被直接抹掉（旧 160ms 一旦加错峰就会这样）。
 */
const FOLDER_EXIT_MS = 260
/** `prefers-reduced-motion: reduce` 下的统一时长（进入 + 退出都是纯 opacity）。
 * 必须**小于** `FOLDER_EXIT_MS`：减少动效的用户不该比普通用户等更久。 */
const FOLDER_REDUCED_MS = 190

/**
 * 框选起手阈值（px）：位移小于它视为"点击空白"，不进入框选态。
 * 4px 是系统级橡皮筋的常见口径（Explorer / Finder 都在这个量级）：
 * 再小会被手抖误触，再大会让"轻轻一划"没反应。
 */
const MARQUEE_MIN_PX = 4

/**
 * 落在这些元素上时**不**起手框选（它们是自己的手势/点击目标）。
 *
 * 关键一条是 `[data-asset-card]`：卡片本体拖动 = 拖出到建模软件（高频核心动作），
 * 框选绝不能抢。卡片里的复选框（`role=checkbox`）与归类抓手都在卡片内 → 已被它覆盖，
 * 不必单独列（也避免和 `dragOut` 的源码守卫产生误判）。
 *
 * ⚠️ 因此这里**刻意没有** `[data-assign-grip]` 字面量：抓手的命中靠它自身的 `role="button"`
 * 和"是卡片后代"两条，功能上等价。别按"选择器里必须逐项列出"去验收（QA 2026-10-22 提过这条
 * 口径差异），否则会误判成缺陷。
 */
const MARQUEE_IGNORE_SELECTOR = [
  '[data-asset-card]',
  '[role="button"]',
  '[role="checkbox"]',
  'button',
  'a',
  'input',
  'select',
  'textarea'
].join(',')

/**
 * 框选拖动的运行期状态（**全部放 ref**：mousemove 里只改 DOM 样式 + 必要时写 store，
 * 不 setState，所以拖动本身不引起 React 重渲染）。
 */
interface MarqueeDrag {
  /** 起手的滚动容器（网格的 `gridRef` 或列表的 `listRef`） */
  container: HTMLElement
  /** 锚点（容器的**内容坐标**） */
  anchor: { x: number; y: number }
  /** 起手时的视口坐标（只服务 4px 阈值：纯滚动不该被当成拖动） */
  startClient: { x: number; y: number }
  /** 最新一次鼠标的视口坐标（滚动时据此重算内容坐标） */
  lastClient: { x: number; y: number }
  /** 是否已越过阈值（未 armed 时不画矩形、不动选择） */
  armed: boolean
  /** 起手时是否按着 Ctrl/Cmd（`true` = 追加到现有选择） */
  additive: boolean
  /** 起手时的选择快照（Esc 取消恢复；追加模式下作为基底） */
  snapshot: string[]
  /** 卡片矩形快照（内容坐标，assetId → rect） */
  rects: Map<string, BoxRect>
  /** 上一次写入 store 的命中集指纹（命中集不变就不重复写） */
  applied: string
  /** 摘掉 window / container 上的全部监听 */
  detach: () => void
}

/**
 * 磁贴入场的 stagger 延迟（写进 CSS 自定义属性，CSS 侧 `animation-delay: var(...)`）。
 *
 * ⚠️ 必须是字符串（`'48ms'`）：React 对 `CSSProperties` 里的自定义属性不会补单位；
 * 而 TS 的 `CSSProperties` 不含 `--*` 键，所以要显式断言。
 */
function folderStaggerStyle(index: number): CSSProperties {
  const delay = Math.min(index, FOLDER_STAGGER_MAX_INDEX) * FOLDER_STAGGER_MS
  return { '--folder-stagger': `${delay}ms` } as CSSProperties
}

/**
 * `prefers-reduced-motion: reduce` 订阅。
 *
 * 只在组件内部用（不进 store）：它是**系统级**偏好，与 `settings.motionQuality`
 * （用户显式选的性能档）是两件事，命中任一条都该退化。
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
    // 老 Chromium 只有 addListener；Electron 33 两者都有，这里以 addEventListener 为主
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])
  return reduced
}

/** 档位由小到大的固定顺序（Ctrl+滚轮据此算「上一档 / 下一档」） */
const DENSITY_ORDER: readonly GridDensity[] = ['small', 'medium', 'large']

/**
 * Ctrl+滚轮切一档所需的累计 `deltaY`（像素）。
 * 用**累积 + 阈值**而不是单次事件：高精度滚轮 / 触控板一次手势会连发几十个
 * 小 delta 事件，逐事件切档会一滚跳到底。
 */
const WHEEL_STEP_PX = 50

const KIND_ICON: Record<AssetKind, typeof IconBox> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  other: IconOther
}

/**
 * SketchUp 风格应用图标占位（缩略图策略**第二级**，用户拍板）。
 *
 * 自绘 SVG 几何抽象——**不引用任何官方 logo 文件**（规避商标风险）：
 * SketchUp 品牌红 #E62E2E 圆角底 + 白色等距立方体（顶面 95% / 右面 62% /
 * 左面 40% 三档明暗营造立体感）+ 底部白色 "SU" 字样。
 */
function IconSketchUp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" fill="none" {...props}>
      <rect x="0" y="0" width="48" height="48" rx="11" fill="#E62E2E" />
      {/* 等距立方体三面（顶 / 右 / 左，明暗递减） */}
      <path d="M24 8.5 32.9 13.5 24 18.5 15.1 13.5Z" fill="#fff" fillOpacity="0.95" />
      <path d="M32.9 13.5 32.9 23.5 24 28.5 24 18.5Z" fill="#fff" fillOpacity="0.62" />
      <path d="M15.1 13.5 15.1 23.5 24 28.5 24 18.5Z" fill="#fff" fillOpacity="0.4" />
      {/* 外轮廓 + 内部三条棱 */}
      <path
        d="M24 8.5 32.9 13.5 32.9 23.5 24 28.5 15.1 23.5 15.1 13.5Z"
        stroke="#fff"
        strokeOpacity="0.9"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M24 18.5 32.9 13.5M24 18.5 15.1 13.5M24 18.5 24 28.5" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.9" />
      <text
        x="24"
        y="41"
        textAnchor="middle"
        fontSize="10.5"
        fontWeight="800"
        letterSpacing="0.4"
        fill="#fff"
        fontFamily="'Sarasa Gothic SC','Microsoft YaHei',sans-serif"
      >
        SU
      </text>
    </svg>
  )
}

/** 是否 SketchUp 模型（SU 版本标记命中，或文件列表里含 .skp）——决定占位用不用 SU 品牌图标 */
function isSketchUpAsset(asset: Asset): boolean {
  return asset.suVersion !== undefined || asset.files.some((f) => f.ext === 'skp')
}

/**
 * 卡片封面：**只准读缩略图**。
 * `thumbStatus === 'ready'` → `vault://thumb/<缓存文件名>`；
 * 否则按类型走占位：**SU 模型用 SketchUp 风格应用图标**（第二级兜底，用户拍板），
 * 其他类型用各自通用图标 + 主文件名。**绝不回退原图**——
 * GB 级贴图直接塞进网格会卡死渲染进程（架构性能陷阱 C4，明令禁止）。
 *
 * `name` 由调用方传入**解析后的显示名**（别名 > 剥知末 ID > 原名，见
 * `logic/aliasIndex.resolveAssetDisplayName`）：本组件不读设置，保持纯展示。
 */
function Cover({ asset, name }: { asset: Asset; name: string }) {
  if (asset.thumbStatus === 'ready' && asset.thumbPath) {
    return (
      <img
        src={thumbVaultUrl(asset.thumbPath)}
        alt={name}
        loading="lazy"
        // `object-contain`（不是 `object-cover`）：封面框统一 4:3 后，1:1 的球图
        // 若按 cover 会被上下切掉约 1/4；contain 保证「整张图都看得见」，
        // 方图左右剩下的空白由这一层的 `bg-canvas` 呈现（画布色当"卡纸边"）。
        className="h-full w-full bg-canvas object-contain"
      />
    )
  }
  const fileName = primaryFileName(asset)
  // 第二级兜底：SU 模型（kind=model 且确为 SketchUp 文件）无缩略图 → 品牌图标占位
  if (asset.kind === 'model' && isSketchUpAsset(asset)) {
    return (
      <div className="relative h-full w-full bg-canvas">
        <div className="flex h-full w-full items-center justify-center">
          <div className="aspect-square h-[62%] drop-shadow-[0_2px_6px_rgba(230,46,46,.35)]">
            <IconSketchUp className="h-full w-full" />
          </div>
        </div>
        {fileName && (
          <div className="absolute inset-x-0 bottom-0 bg-black/55 px-2 pb-1.5 pt-5 text-center text-[10px] font-medium text-white">
            <span className="block truncate">{fileName}</span>
          </div>
        )}
      </div>
    )
  }
  const Icon = KIND_ICON[asset.kind]
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas text-muted/60">
      <div className="scale-[2.2]">
        <Icon />
      </div>
      {fileName && <div className="max-w-[85%] truncate px-2 text-[10px]">{fileName}</div>}
    </div>
  )
}

/**
 * 卡片右上角标记：收藏星 + 「疑似乱码」。
 *
 * ⚠️ 布局约定（防遮挡，改之前先看这里）：
 * - 右上角是**一个固定竖列**（在 `AssetGrid` 的卡片模板里：
 *   `absolute right-2 top-2 flex flex-col items-end gap-1`）：
 *   ① 圆形多选钮（恒定占位，未选中时透明、hover 淡入）
 *   ② **未选中时**才渲染的本组件内容（收藏星 / 乱码徽标；回收站里换成「还剩 N 天」）；
 * - 选中时其余标记整体让位（卡片进入多选语境，标记不可点）；
 * - **右下角 = 重复徽标 `×N`**（刻意移出右上角：星标也占右上角，两者会撞）；
 * - **SU 版本不显示在卡片上**（2026-10-25 反馈：只留列表视图的 SU 列 / 详情面板 /
 *   文件视图）。所以本组件不带 `absolute` 定位——定位由卡片里的竖列容器负责。
 */
function Flags({
  asset,
  onToggleFavorite
}: {
  asset: Asset
  onToggleFavorite: () => void
}) {
  const favorite = asset.favorite === true
  return (
    <div className="flex flex-col items-end gap-1">
      {/* 收藏：已收藏常显；未收藏只在 hover 时淡入（白星需要暗底才看得见） */}
      <span
        className={`rounded-full bg-black/35 ${
          favorite ? '' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
      >
        <FavoriteStar favorite={favorite} onToggle={onToggleFavorite} size={13} />
      </span>
      {/* .badge 已改 tint 底（§3.3），这里仍按拍板保留 danger 实底覆盖；
          文字显式白（tint 底会随主题变深），否则继承 .badge 的 secondary 字色会糊 */}
      {asset.mojibake === true && (
        <span
          className="badge !bg-danger/85 !text-white"
          title="解压出的文件名疑似乱码（GBK 解码失败），建议重新导入或改用 7-Zip"
        >
          疑似乱码
        </span>
      )}
    </div>
  )
}

/** 「大类/一级/二级」短标签（列表列用） */
function CategoryCell({ asset }: { asset: Asset }) {
  const { category1, category2 } = categoriesOf(asset)
  if (category1 === '未分类' && category2 === '未分类') return <span className="text-muted">未分类</span>
  return (
    <span className="truncate" title={`${category1} / ${category2}`}>
      {category1 === '未分类' ? '' : category1}
      {category1 !== '未分类' && category2 !== '未分类' ? ' / ' : ''}
      {category2 === '未分类' ? '' : category2}
    </span>
  )
}

/**
 * 重复组标题行（网格与列表共用）。
 *
 * 点击 = 选中该组全部（走 `selectMany`，随后可直接批量删除 / 批量指派分类）。
 * 标题名取原件名并剥掉自动序号（`椅子-2` → `椅子`），右侧是「份数 + 可清理体积」。
 * `sizeMismatch` 为真时显式提示「体积差异较大」——名字相同但很可能是不同资产。
 */
function DupGroupHeader({ group, onSelect }: { group: DupGroup; onSelect: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-nav px-2 py-1.5 text-left transition hover:bg-elevated/60"
      onClick={onSelect}
      title="点击选中该组全部资产（可批量删除或指派分类）"
    >
      <span className="truncate text-[12px] font-semibold text-primary">{groupLabel(group)}</span>
      <span className="badge shrink-0">×{group.assets.length}</span>
      <span className="shrink-0 text-[11px] text-muted">
        可清理 {formatBytes(group.wastedBytes)}
      </span>
      {group.sizeMismatch && (
        <span className="shrink-0 text-[11px] text-danger" title="同组资产体积差异超过 30%，删之前请先确认是同一套资产">
          体积差异较大
        </span>
      )}
    </button>
  )
}

/**
 * 「归类抓手」（反馈 6d / docs/15 §6d）：卡片上唯一走**应用内 HTML5 拖拽**的元素。
 *
 * 为什么必须与卡片本体分开（技术约束，不能合并成一个手势）：
 * 卡片本体的 `onDragStart` 会调 `window.modvault.startDrag()` —— 这是主进程的系统级拖出，
 * 一旦触发就交给操作系统，渲染层**再也收不到 HTML5 的 `drop`**。因此：
 * - 卡片本体 = 拖出到 SketchUp / D5（高频核心动作，行为不变）；
 * - 本抓手 = 拖到左栏分类节点归类（`application/x-idbox-asset` + `effectAllowed='move'`），
 *   **绝不调 `startDrag`**。
 *
 * 视觉：hover 卡片才淡入（`group-hover`），绝对定位 → 不占位、不引起布局跳动。
 * 位置在封面**左下角**而不是右上角：右上角已被「选中对勾 / SU 版本徽标 / 疑似乱码徽标」
 * 占用，硬塞会互相遮挡；左下角与列表视图的「行首抓手」同侧，肌理一致。
 */
function GripHandle(props: {
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onClick: (e: MouseEvent<HTMLElement>) => void
  onDoubleClick: (e: MouseEvent<HTMLElement>) => void
  className?: string
}) {
  const { className = '', onDragStart, onClick, onDoubleClick } = props
  return (
    <span
      role="button"
      aria-label="拖到左栏分类节点归类"
      title="拖到左栏分类节点归类（拖卡片本体是拖出到建模软件）"
      // 卡片本体的 onDragStart 用这个标记识别「这次拖拽来自抓手」→ 不交给系统
      data-assign-grip
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`flex h-5 w-5 cursor-grab items-center justify-center rounded bg-card/85 text-tertiary shadow-card backdrop-blur-[2px] transition active:cursor-grabbing ${className}`}
    >
      {/* 六点抓手（14px，颜色继承 --text-tertiary；图标规格 A：单色 currentColor） */}
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <circle cx="4" cy="3" r="1.2" />
        <circle cx="10" cy="3" r="1.2" />
        <circle cx="4" cy="7" r="1.2" />
        <circle cx="10" cy="7" r="1.2" />
        <circle cx="4" cy="11" r="1.2" />
        <circle cx="10" cy="11" r="1.2" />
      </svg>
    </span>
  )
}

/**
 * 多选复选框（2026-10 用户反馈「找不到多选删除」——补的是**入口**，不是重新实现删除）。
 *
 * 交互纪律（每一条都不能省）：
 * - `onClick` 必须 `stopPropagation`：否则冒泡到卡片 → 走 `select()` 清空多选，
 *   勾第二个时第一个就掉了（多选永远选不起来）；
 * - `onDoubleClick` 也 stopPropagation：连点两下复选框不能进「软件内文件视图」；
 * - `onDragStart` preventDefault + stopPropagation：卡片是 draggable，从复选框起拖
 *   会被当成系统级拖出（拖出整个资产），这里必须掐掉；
 * - `onMouseDown` stopPropagation：不让卡片抢焦点 / 触发文字选择。
 *
 * 视觉：16×16，选中 accent 实底 + 白勾；未选中半透明白底 + 描边（深色画布上也看得见）。
 * 显隐由调用方给 className（hover 淡入 / 选中常显），**绝对定位 → 不占位、不引起布局跳动**。
 */
/**
 * 多选复选框（唯一入口，两种形态，逻辑共用一套）：
 * - `variant='square'`：列表行首的 16px 小方块（列表没有第二个入口，保持原样）；
 * - `variant='circle'`：网格卡片右上角的 22px 圆钮（2026-10-25 反馈：网格原先
 *   「左侧方块 + 右上圆勾」两个控件重复，只保留这一个；未选中是空心圆，选中是蓝底白勾）。
 *
 * 交互纪律（改之前先看）：所有事件都要 `stopPropagation`，否则冒泡到卡片会走
 * `select()` 清掉多选；`onDragStart` 还要 `preventDefault`（否则勾选会起拖）；
 * `draggable={false}` 防止 span 被当成拖拽源。
 */
function SelectBox({
  checked,
  onToggle,
  variant = 'square',
  className = ''
}: {
  checked: boolean
  onToggle: () => void
  variant?: 'square' | 'circle'
  className?: string
}) {
  const circle = variant === 'circle'
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? '取消选中' : '选中（可多选后批量删除）'}
      title={checked ? '取消选中' : '选中（Ctrl/Cmd 点击多选，Shift 点击范围选）'}
      tabIndex={-1}
      data-select-box
      draggable={false}
      onClick={(e: MouseEvent<HTMLElement>) => {
        e.stopPropagation()
        onToggle()
      }}
      onDoubleClick={(e: MouseEvent<HTMLElement>) => e.stopPropagation()}
      onMouseDown={(e: MouseEvent<HTMLElement>) => e.stopPropagation()}
      onDragStart={(e: DragEvent<HTMLElement>) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      className={`flex shrink-0 cursor-pointer items-center justify-center transition ${
        circle
          ? `h-[22px] w-[22px] rounded-full border-[1.5px] ${
              checked
                ? // 选中：沿用 .check-badge 的白/深底 2px 描边环，与旧的右上角圆勾完全同款
                  'check-badge border-transparent bg-accent text-white'
                : // 未选中：空心圆（半透明白底 + 白描边）。白底缩略图上会看不见，
                  // 所以补一层极淡的投影定边；纯装饰，不影响判色
                  'border-white bg-white/25 text-transparent shadow-[0_1px_4px_rgba(0,0,0,0.3)]'
            }`
          : `h-4 w-4 rounded-[4px] border ${
              checked
                ? 'border-accent bg-accent text-white'
                : 'border-line bg-card/90 text-transparent hover:border-accent'
            }`
      } ${className}`}
    >
      <IconCheck
        width={circle ? 12 : 10}
        height={circle ? 12 : 10}
        strokeWidth={circle ? 2.6 : 3}
      />
    </span>
  )
}

/** 焦点是否落在可输入控件里（Ctrl+A 全选时不能抢走输入框的全选文本） */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

/** 文件行图标：图片 / 模型 / 其它（图标口径见 `logic/fileView.ts` 的 IMAGE_EXTS / MODEL_EXTS） */
const FILE_ROW_ICON: Record<FileRow['kind'], typeof IconBox> = {
  image: IconImage,
  model: IconBox,
  other: IconFile
}

/**
 * 文件网格卡片的封面图源（`view === 'grid'`）。
 *
 * **具体图源（两级，都是既有能力，不新增主进程逻辑）**：
 * ① 这一行正好是资产封面、且封面缩略图缓存已就绪 → 读 `vault://thumb/<缓存名>`
 *    （与资产卡片封面**完全同源**，`thumbVaultUrl`）；
 * ② 其它图片文件 → 读 `vault://asset/<relFolder>/<rel>` **原图**，`loading="lazy"`。
 *
 * 为什么 ② 只能读原图：缩略图缓存是**按资产**生成的（`ensureThumb(assetId, coverAbs)`，
 * 名字是 `id + 封面路径 hash`），管线里没有"按单个文件"的缩略图；给文件列表另建一套
 * 缓存要改主进程（本轮的边界是不动 `src/main/**`，且另一个 worker 正在改 importer）。
 * 风险控制：只有 `IMAGE_EXTS` 的图片会进 `<img>`（`logic/fileView.ts` 已把 tga/exr/hdr
 * 归到「其它」），外加 lazy 加载 + 加载失败回落类型图标（`onError`），
 * 不会把 GB 级贴图一次性塞进渲染进程。
 */
function fileThumbUrl(asset: Asset, row: FileRow): string | null {
  if (!row.isImage) return null
  if (asset.cover && asset.cover === row.rel && asset.thumbStatus === 'ready' && asset.thumbPath) {
    return thumbVaultUrl(asset.thumbPath)
  }
  const rel = asset.relFolder ? `${asset.relFolder}/${row.rel}` : row.rel
  return vaultUrl(rel)
}

/** 文件网格卡片的封面：图片读协议 URL（失败回落类型图标），非图片直接类型图标 + 文件名 */
function FileCover({ asset, row }: { asset: Asset; row: FileRow }) {
  const [broken, setBroken] = useState(false)
  // ── .skp 专属封面（2026-10-22 用户反馈「SKP 文件这个卡片需要强化」）──────────
  // 口径（两个选项合并）：淡蓝 tint 底板 + 居中大号 "SU"（系统蓝）。
  // 只对「模型类 + 扩展名 skp」生效；.max / .rvt / .fbx 等仍走下面的类型图标分支。
  // 实现要点：
  // - 字号写成 **SVG user unit**：viewBox 100×100 里的 38 = 封面高度的 38%
  //   （配色板要求 36–40%），不依赖容器查询 / JS 测量 → 三档密度下比例恒定；
  // - 底板 `bg-accent-tint`、字色 `text-accent`（`fill="currentColor"` 取它）都是 token：
  //   浅色 #E1EFFF / #007AFF，深色 #1E2A38 / #0A84FF —— 不写死 hex，跟随主题；
  // - **不再渲染**灰色立方体图标（大 SU 已承担识别）；文件名在卡片下方元信息区，
  //   这里不重复画，避免把大 SU 挤小；
  // - 不加描边/阴影/斜体，`font-weight:700` + `letter-spacing:-0.02em` 收一下字距。
  if (row.kind === 'model' && row.ext.toLowerCase() === 'skp') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-accent-tint text-accent">
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true" focusable="false">
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="38"
            fontWeight="700"
            letterSpacing="-0.02em"
            fill="currentColor"
          >
            SU
          </text>
        </svg>
      </div>
    )
  }
  const src = fileThumbUrl(asset, row)
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={row.name}
        loading="lazy"
        draggable={false}
        onError={() => setBroken(true)}
        className="absolute inset-0 h-full w-full bg-canvas object-contain"
      />
    )
  }
  const Icon = FILE_ROW_ICON[row.kind]
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas text-muted/60">
      <div className="scale-[2.2]">
        <Icon />
      </div>
      {row.name && <div className="max-w-[85%] truncate px-2 text-[10px]">{row.name}</div>}
    </div>
  )
}

/**
 * 双击一行 → 用系统默认程序打开该文件（`shell.openPath`）。
 * 失败时 main 返回错误文案（空串已归一成 null），这里落一条 notice ——
 * 否则「双击没反应」会被当成 bug（与删除失败的反馈口径一致）。
 */
function openFileRow(row: FileRow): void {
  window.modvault
    .openPath(row.absPath)
    .then((err) => {
      if (err) useVault.getState().setNotice(`打开失败：${err}`)
    })
    .catch(() => {
      useVault.getState().setNotice('打开失败：找不到可打开该文件的程序')
    })
}

/**
 * 「回到顶部」按钮的出现阈值（px）：约一屏多一点。低于它说明"一屏就看完了"，
 * 顶栏/侧栏就在上方，按钮只是遮挡。
 */
const BACK_TO_TOP_THRESHOLD = 600

/**
 * 「快速回到顶部」浮起按钮（用户 2026-10-13："在素材库里面再增加一个快速回顶部的功能"）。
 *
 * ## 为什么不会跟着内容滚走
 * 它**不是**滚动容器的子元素，而是挂在容器**父层**（`position: relative` 的那一层）上的
 * `absolute bottom-5 right-5` 按钮。滚动的是容器内部的 `scrollTop`，按钮的包含块是外层
 * 盒子 → 容器滚多远都不影响它的位置。（也正因为不在容器里，容器 `overflow: auto` 的
 * 裁剪范围不含它。）
 *
 * ## 为什么直接对容器 `scrollTo` 就够（虚拟滚动下也一样）
 * 虚拟滚动改的是"渲染哪一段行"，容器本身始终是那个真实 DOM，`scrollTop` 是浏览器管的。
 * 平滑滚动会**连续发出 scroll 事件** → 既有的 `onScroll`（`scrollMemo` 记录 + rAF 合并的
 * `viewport.onScroll`）会照常跟着跑，虚拟窗口自然一路更新，恢复逻辑也不会抢：
 * 那条 effect 只在"容器重建 / 视口高度变化"时执行，且判据是
 * `|scrollTop - scrollMemo| > 1`，平滑滚动期间两者同步递减 → 差恒为 0。
 *
 * ## 参数口径
 * - 阈值 600px（见 `BACK_TO_TOP_THRESHOLD`）；过渡 180ms，只动 `opacity` + `translateY(4px)`；
 * - 隐藏时 `pointer-events: none`（不可见却可点是最糟的形态）；
 * - 键盘可达：原生 `<button>`，Tab 到 + Enter 即可，不做焦点陷阱。
 */
function BackToTop({
  containerRef,
  hidden = false,
  attachKey
}: {
  /** 当前视图的滚动容器（网格 / 列表 / 文件视图各一个） */
  containerRef: RefObject<HTMLDivElement>
  /** 被上层覆盖时（例如文件视图展开）直接不渲染，避免两个按钮叠着 */
  hidden?: boolean
  /**
   * 容器**换节点**的重订阅信号。
   *
   * ⚠️ 不能省：网格容器在「切视图 / 进出文件视图 / 切重复视图」时会被**销毁重建**，
   * 而 `ref` 对象身份不变 → effect 不会重跑 → 监听还挂在已卸载的旧节点上
   * （表现为：按钮点不动，或该出现时不出现）。传一个能代表"挂载点换了"的字符串即可。
   */
  attachKey?: unknown
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (hidden) return
    const el = containerRef.current
    if (!el) return
    const sync = (): void => setVisible(el.scrollTop > BACK_TO_TOP_THRESHOLD)
    // 挂载时先同步一次：从文件视图返回 / 切视图时容器可能已经不在顶部
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [containerRef, hidden, attachKey])

  if (hidden) return null

  return (
    <button
      type="button"
      aria-label="回到顶部"
      title="回到顶部（滚动超过一屏时出现）"
      onClick={() => {
        // 不用 `window.scrollTo`：滚动的是中栏容器，不是文档
        containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }}
      className={`absolute bottom-5 right-5 z-30 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-card/90 text-secondary shadow-modal transition-[opacity,transform] duration-[180ms] ease-out hover:bg-elevated hover:text-primary ${
        visible ? 'opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
      }`}
    >
      {/* chevron-up：16px / 1.8 描边（与菜单、侧栏同一套线性风格） */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 14.5L12 8.5l6 6" />
      </svg>
    </button>
  )
}

/**
 * 中栏「软件内文件夹浏览器」（docs/15 §6c，用户反馈：所有 UI 由我们控）。
 *
 * - 双击行 / 卡片 = 用系统默认程序打开**该文件**（不是打开资源管理器）；
 * - 行 / 卡片可拖出（`startDrag`，与资产卡片拖出同一通道）；
 * - Esc / 顶部「← 返回」退出（App 的中栏头在那里）；
 * - 文件行模型与排序全部在 `logic/fileView.ts`（纯函数，可单测）。
 *
 * 2026-10（用户反馈「文件夹视图不跟顶栏的网格/列表切换」）：形态跟随 `view`——
 * `grid` = 与资产网格同款的卡片（缩略图 / 类型图标 + 文件名 + 扩展名徽标 + 大小），
 * `list` = 原来的行表格。两种形态共用同一份 `FileRow[]`（排序与分组不变：
 * 模型 → 图片 → 其他，组内自然序）。顶栏一换 `view` 立即重渲染（无内部状态缓存）。
 *
 * 2026-10 追加：整块进出场由外层 `.folder-stage` 的 `data-folder-anim` 驱动
 * （Win8 磁贴翻入 / 飞出），本组件只给每条内容挂 `folder-anim-item` + stagger 变量。
 */
function FolderFileList({ asset, view }: { asset: Asset; view: 'grid' | 'list' }) {
  const closeFolderView = useVault((s) => s.closeFolderView)
  /** HDR 预览（0.6.5）：文件行双击 `.hdr` → 与网格/详情面板共用同一个 store 入口 */
  const openHdrPreview = useVault((s) => s.openHdrPreview)
  // 文件网格复用资产网格的密度档位（大 / 中 / 小），两处列宽口径一致
  const gridDensity = useVault((s) => s.settings?.gridDensity ?? 'medium')
  /**
   * 本视图自己的两个右键菜单（**不借用网格那套 state**）：
   * 文件视图是盖在网格之上的独立层，网格的 `menu` 打开时会被退场动画 / inert 影响，
   * 而且文件菜单作用的是"某一行"，与资产菜单的作用集合（`ids`）不是一回事。
   */
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; row: FileRow } | null>(null)
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null)
  /** 当前文件视图的滚动容器（grid / list 二选一，同一时刻只有一个在 DOM 里） */
  const fileScrollRef = useRef<HTMLDivElement>(null)
  const rows = buildFileRows(asset)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 弹窗（删除确认 / 分类选择器 / HDR 预览）在场时让它们先吃掉 Esc，避免一次按键关两层
      const st = useVault.getState()
      if (st.pendingDelete || st.categoryPickerIds || st.hdrPreviewAssetId) return
      closeFolderView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeFolderView])

  if (rows.length === 0) {
    return (
      // 空态也走同一个入场动画（整体一条，不 stagger）——否则"进入后什么都没有"会闪一下
      <div
        // 本轮：**空态容器本身**也要能右键（用户口径"所有界面的空界面右键都要有刷新"）
        onContextMenu={(e) => {
          e.preventDefault()
          setEmptyMenu({ x: e.clientX, y: e.clientY })
        }}
        className="folder-anim-item flex flex-1 flex-col items-center justify-center gap-3 text-muted"
      >
        {/* 图标规格 A：与其它空态同规格（40px、单色 currentColor） */}
        <IconEmptyLibrary className="text-tertiary" />
        <p className="text-sm">这个资产文件夹里没有可列出的文件</p>
        <p className="max-w-md text-center text-[12px] leading-relaxed">
          文件可能已被移走或删除。可先返回列表重新扫描，或右键该资产用「在资源管理器中显示」查看目录。
        </p>
        <button className="btn" onClick={closeFolderView} title="返回资产列表（Esc）">
          返回资产列表
        </button>
        {emptyMenu && (
          <EmptyAreaContextMenu
            x={emptyMenu.x}
            y={emptyMenu.y}
            onClose={() => setEmptyMenu(null)}
          />
        )}
      </div>
    )
  }

  /**
   * 拖出（系统级）：行与卡片共用。
   *
   * 2026-10-21 用户反馈「拖起来是一个虚影、显示也不完整」：文件视图此前只把**原始缩略图
   * 路径**交给 `startDrag`（埋点 `cardBytes: 0 / iconKind: "thumb"`），系统就按那张图随手画
   * —— 会被裁切、也没有卡片外观。现在与网格同源：hover 预热同一张 168×210 卡片位图，
   * dragstart 同步读缓存交给主进程，由系统按位图原样绘制（**唯一可控的方式**）。
   *
   * 为什么不画应用内浮层跟手：实测 OLE 拖拽期间渲染进程收到 `dragover` 的次数是 **0**
   * （真实鼠标拖拽、非 CDP 模拟），渲染层根本不知道光标在哪，浮层无法跟随。
   */
  const fileCardKey = (row: FileRow): string => dragCardKey(asset.id, row.rel)
  const fileCardThumbUrl = (row: FileRow): string | null => {
    // ⚠️ 只在「安全」时才用文件自己的图：`fileThumbUrl` 对非封面图片返回的是**原图**
    // （库里的 4K 贴图常有几十 MB），而网格的铁律是「绝不把原图塞进 canvas」。
    // 只接受 ① 该文件就是资产封面（走缩略图缓存）② 8MB 以内的图片。
    const own = fileThumbUrl(asset, row)
    if (own && (asset.cover === row.rel || row.size <= FILE_DRAG_CARD_MAX_IMAGE_BYTES)) return own
    return dragCardThumbUrl(asset)
  }

  const fileDragProps = (row: FileRow) => ({
    draggable: true,
    onMouseEnter: () => prewarmDragCardBitmap(fileCardKey(row), { thumbUrl: fileCardThumbUrl(row), name: row.name }),
    onMouseLeave: () => cancelDragCardPrewarm(),
    onDragStart: (e: DragEvent) => {
      // 同网格：同步读预热缓存，未命中传 null（主进程回退缩略图，绝不因没预热拖不动）
      const cardPng = cachedDragCard(fileCardKey(row))
      beginSystemDrag(e, row.name, row.absPath, asset.thumbPath ?? null, (path, thumb) =>
        window.modvault.startDrag(path, thumb, cardPng)
      )
    }
  })

  /** 行 / 卡片共用的 tooltip 与双击打开 */
  const fileTitle = (row: FileRow): string =>
    asset.kind === 'hdri' && isHdrExt(row.ext)
      ? `${row.absPath}\n双击进 HDR 预览`
      : `${row.absPath}\n双击用系统默认程序打开`

  /**
   * 文件行 / 文件卡的右键（本轮新增）：弹**文件菜单**（不是资产菜单 —— 文件不是资产，
   * 这里能做的只有打开 / 定位 / 设为封面 / 复制）。
   *
   * `data-file-row="1"` 同时是外层滚动容器判"这是空白处吗"的依据
   * （`MENU_TARGET_SELECTOR` 里逐字引用这个属性名），两者必须一起改。
   * `stopPropagation` 保证只弹一层：否则文件菜单 + 空白处菜单会同时出现。
   */
  const rowMenuProps = (row: FileRow) => ({
    'data-file-row': '1',
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setFileMenu({ x: e.clientX, y: e.clientY, row })
    }
  })

  /**
   * 文件行双击（0.6.5）：
   * - **HDRI 资产里的 `.hdr` 文件** → 进 HDR 预览（与网格双击 / 详情面板按钮同一个
   *   `openHdrPreview` 入口，绝不在这里再开一份弹窗 state）；
   * - 其余文件 → 系统默认程序（既有行为，含模型包里的 .hdr）。
   */
  const openRow = (row: FileRow): void => {
    if (asset.kind === 'hdri' && isHdrExt(row.ext)) {
      openHdrPreview(asset.id)
      return
    }
    openFileRow(row)
  }

  const listBody = (
    <div className="overflow-hidden rounded-modal border border-line bg-card">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2 text-xs text-muted">
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1 font-medium">名称</span>
        <span className="w-14 shrink-0 text-right font-medium">类型</span>
        <span className="w-24 shrink-0 text-right font-medium">大小</span>
      </div>
      {rows.map((row, i) => {
        const Icon = FILE_ROW_ICON[row.kind]
        return (
          <div
            key={row.rel}
            {...fileDragProps(row)}
            {...rowMenuProps(row)}
            onDoubleClick={() => openRow(row)}
            title={fileTitle(row)}
            // Win8 磁贴入场：`folder-anim-item` 由外层 `.folder-stage` 的
            // `data-folder-anim` 驱动（styles.css），stagger 走 CSS 变量。
            style={folderStaggerStyle(i)}
            className="folder-anim-item flex cursor-pointer items-center gap-2.5 border-b border-line/60 px-3 py-2 transition last:border-0 hover:bg-elevated/40"
          >
            <span className="w-4 shrink-0 text-tertiary">
              <Icon width={14} height={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-primary">{row.name}</span>
            <span className="w-14 shrink-0 text-right">
              {row.extLabel ? <span className="badge">{row.extLabel}</span> : <span className="text-[11px] text-muted">—</span>}
            </span>
            <span className="w-24 shrink-0 text-right text-[12px] text-muted">{row.sizeText}</span>
          </div>
        )
      })}
    </div>
  )

  const gridBody = (
    <div className={`grid ${GRID_COLS[gridDensity]} gap-card`}>
      {rows.map((row, i) => (
        <div
          key={row.rel}
          data-file-card
          {...fileDragProps(row)}
          {...rowMenuProps(row)}
          onDoubleClick={() => openRow(row)}
          title={fileTitle(row)}
          style={folderStaggerStyle(i)}
          className="folder-anim-item group flex cursor-pointer flex-col overflow-hidden rounded-card border border-line bg-card text-left shadow-card transition hover:bg-elevated/40"
        >
          {/* 文件预览框：**固定 1:1**（2026-10-21 用户反馈：长图会把整张卡撑成竖条，短图又是另一个高度，
              同屏没有统一视觉）。两个要点，少一个都会失效：
              ① `overflow-hidden` + 图片 `absolute inset-0` —— `aspect-ratio` 不是硬约束，
                 图片留在文档流里会用**固有高度**把盒子顶开（实测 281×564 撑破 4:3）；
              ② `object-contain` —— 贴图要看完整纹理，宁可两侧留画布底色也不裁切。 */}
          <div className="relative aspect-square overflow-hidden">
            <FileCover asset={asset} row={row} />
            {/* 扩展名徽标：左上角（文件卡没有类型角标占用这个位置） */}
            {row.extLabel && <span className="badge absolute left-2 top-2">{row.extLabel}</span>}
            {/* 大小：右下角，深底白字（图片封面可能是浅色，内联 pill 保证可读） */}
            <span className="absolute bottom-2 right-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
              {row.sizeText}
            </span>
          </div>
          <div className="px-2.5 py-2">
            <div className="truncate text-[12px] font-semibold" title={row.name}>
              {row.name}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted">{row.kindLabel}</div>
          </div>
        </div>
      ))}
    </div>
  )

  /**
   * 文件视图的**空白处**右键（容器级）。
   *
   * 判定口径与网格一致：事件目标落在文件行 / 文件卡里 → 是行自己的菜单，这里不接管；
   * 其余（行与行之间的缝隙、下方留白）→ 弹空白处菜单（刷新 / 清除筛选）。
   */
  const emptyAreaProps = {
    onContextMenu: (e: MouseEvent) => {
      const target = e.target as Element | null
      if (target?.closest(MENU_TARGET_SELECTOR)) return
      e.preventDefault()
      setEmptyMenu({ x: e.clientX, y: e.clientY })
    }
  }

  return (
    <div
      // 空白处右键挂在**最外层**：滚动容器、行间缝隙、顶部说明条、下方留白都算"空白"
      // （挂在两个滚动容器上会漏掉说明条；两处都挂又会同一次右键跑两遍）
      {...emptyAreaProps}
      // `relative`：给「回到顶部」按钮当包含块（它在滚动容器**外面**，才不会跟着内容滚走）
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="shrink-0 px-5 pt-1 text-[11px] text-muted">
        双击文件用系统默认程序打开 · 拖拽文件可拖出到建模软件 · Esc 返回
      </div>
      {/* 形态严格跟随顶栏 view：grid = 卡片网格（与资产网格同密度），list = 行表格 */}
      {view === 'grid' ? (
        <div ref={fileScrollRef} className="flex-1 overflow-auto px-5 pb-4 pt-4">
          {gridBody}
        </div>
      ) : (
        <div ref={fileScrollRef} className="flex-1 overflow-auto px-4 py-3">
          {listBody}
        </div>
      )}
      {/* `key={view}`：grid ↔ list 换的是另一个 DOM 节点（ref 对象身份不变），
          必须重挂一次才能重新绑 scroll 监听 */}
      <BackToTop key={view} containerRef={fileScrollRef} />
      {fileMenu && (
        <FileContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          assetId={asset.id}
          row={fileMenu.row}
          onClose={() => setFileMenu(null)}
        />
      )}
      {emptyMenu && (
        <EmptyAreaContextMenu x={emptyMenu.x} y={emptyMenu.y} onClose={() => setEmptyMenu(null)} />
      )}
    </div>
  )
}

/**
 * 拖拽卡片位图用的缩略图 URL —— 与网格封面**完全同源**（同样只读缩略图缓存，
 * 绝不回退原图：GB 级贴图塞进 canvas 会卡死渲染进程）。
 * 无缩略图返回 null，卡片自动画占位底。
 */
function dragCardThumbUrl(a: Asset): string | null {
  return a.thumbStatus === 'ready' && a.thumbPath ? thumbVaultUrl(a.thumbPath) : null
}

/**
 * 文件视图里，允许把「文件自己的原图」画进拖拽卡片的上限（8MB）。
 * 超过这个体积的图片一律退回资产缩略图 —— 拖拽卡片是 hover 预热的活，
 * 不能因为一张 4K 贴图把主线程/内存拖垮（与网格「绝不读原图」同一条纪律）。
 */
const FILE_DRAG_CARD_MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function AssetGrid({ view }: { view: 'grid' | 'list' }) {
  const assets = useVisibleAssets()
  const allAssets = useVault((s) => s.assets)
  /**
   * 别名索引（0.6.0 §3.3「别名映射表」）。
   *
   * `aliasIndexOf` 按 **`settings.aliases` 的数组引用** memo（见 `logic/aliasIndex`）：
   * 选中的资产变了 / 切换视图 / 滚动都不会重建 Map，只有设置真的落库后才重建一次。
   * `EMPTY_ALIASES` 是稳定常量 —— 不能写 `?? []`，否则每次渲染都是新数组，memo 永远失效。
   */
  const aliases = useVault((s) => s.settings?.aliases) ?? EMPTY_ALIASES
  const aliasIndex = aliasIndexOf(aliases)
  /**
   * 「给用户看的资产名」的**唯一**入口：别名 > `displayName()`（剥知末 ID）> 原名。
   * ⚠️ 只用于渲染（卡片标题 / 列表名 / img alt / 拖拽卡片名）。
   * 磁盘文件夹名、`dedupeKey`、搜索排序仍走 `a.name` —— 别名只改显示。
   */
  const displayOf = (a: Asset): string => resolveAssetDisplayName(a, aliasIndex)
  const selectedIds = useVault((s) => s.selectedIds)
  const select = useVault((s) => s.select)
  const toggleSelect = useVault((s) => s.toggleSelect)
  // 2026-10 多选入口补齐：Shift 范围选择以「最后一次点击」为锚点
  const lastClickedId = useVault((s) => s.lastClickedId)
  const selectRange = useVault((s) => s.selectRange)
  const openCategoryPicker = useVault((s) => s.openCategoryPicker)
  const requestDelete = useVault((s) => s.requestDelete)
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  // v0.4「重复资产」视图：分组骨架 + 组标题整组选中
  const dupOnly = useVault((s) => s.dupOnly)
  const setDupOnly = useVault((s) => s.setDupOnly)
  const selectMany = useVault((s) => s.selectMany)
  // v0.4 收藏（卡片右上角星标 / 列表行星标）
  const setFavorite = useVault((s) => s.setFavorite)
  // 双击卡片进入的「软件内文件夹浏览器」（docs/15 §6c）——中栏整体切换，不再开系统资源管理器
  const folderViewAssetId = useVault((s) => s.folderViewAssetId)
  const openFolderView = useVault((s) => s.openFolderView)
  /** HDR 预览入口（0.6.5）：网格双击 HDR 卡 → 直接进预览，不再进文件视图 */
  const openHdrPreview = useVault((s) => s.openHdrPreview)
  /** 0.6.0 批量重命名：只做批量（单选走详情面板的单条改名，不在本功能范围） */
  const openRenameDialog = useVault((s) => s.openRenameDialog)
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null)
  /**
   * 空白处右键（刷新 / 清除筛选）。与 `menu`（资产卡片的菜单）**分开存**：
   * 两者互斥且作用对象完全不同（一组 id vs 当前视图），塞进一个 state 只会让
   * 渲染分支互相覆盖。声明位置必须在所有早退之前（下方多处空态要用）。
   */
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null)

  // ── 文件视图（双击进入）的**进出场动画**载体 ────────────────────────────────
  //
  // 为什么退出要用"快照"而不是直接渲染 `folderAsset`：关闭瞬间 `folderViewAssetId`
  // 已经是 null，`folderAsset` 同时变 null —— 如果这时直接卸载文件列表，用户看到的是
  // 硬切（用户投诉的正是这个）。这里在 id 掉成 null 的那一帧把**上一份资产**存进
  // `folderExitAsset`，多渲染 `FOLDER_EXIT_MS`(260ms) 播放"飞出"，随后卸载。
  /** 正在播放退出动画的资产（null = 没有退出动画） */
  const [folderExitAsset, setFolderExitAsset] = useState<Asset | null>(null)
  /** 退出动画的收尾定时器（连点 / 重开时要能打断） */
  const folderExitTimer = useRef(0)
  /** 上一次的 folderViewAssetId（判断"从开着变成关掉"） */
  const prevFolderIdRef = useRef<string | null>(folderViewAssetId)
  /** 最近一次打开的资产（关闭那一帧 id 已置 null，只能靠它拿旧内容） */
  const lastFolderAssetRef = useRef<Asset | null>(null)

  /**
   * 动效档位（`smooth` / `balanced` / `ultra`）+ 系统级「减少动效」偏好。
   * 两者都只影响**动画表现**，不影响功能；差异由 styles.css 的
   * `[data-motion]` / `[data-reduced]` 选择器承担。
   */
  const motionQuality = useVault((s) => s.settings?.motionQuality ?? 'balanced')
  const reducedMotion = usePrefersReducedMotion()

  // ── C 线「最近删除」：视图 / 保留期 / 还原 / 彻底删除 ─────────────────
  const libraryView = useVault((s) => s.libraryView)
  const trashRetention = useVault((s) => s.settings?.trashRetention ?? '30d')
  const restoreAssets = useVault((s) => s.restoreAssets)
  /** 待二次确认的「彻底删除」目标；null = 弹窗关闭 */
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null)
  const trashMode = libraryView === 'trash'

  // ── 反馈 6b：网格密度（档位由 Toolbar 三档控件或 Ctrl+滚轮写入 Settings）──
  const gridDensity = useVault((s) => s.settings?.gridDensity ?? 'medium')
  const gridRef = useRef<HTMLDivElement>(null)
  /** 列表视图的滚动容器（列表与网格是两套 padding / 两套行高，各自一个 ref） */
  const listRef = useRef<HTMLDivElement>(null)
  /**
   * 进出「资产的文件视图」时保留滚动位置（2026-10-21 用户反馈：返回后总是跳回顶部）。
   *
   * 原因：文件视图与网格/列表是**互斥条件渲染**，进文件视图时网格容器被销毁，
   * 返回时重新创建一个 `scrollTop = 0` 的新容器（`scrollMountKey` 会变，可作重挂载信号）。
   * 这里在滚动时记下位置，容器重建且**量到视口高度之后**再写回去 —— 写早了会被
   * "容器高 0 → scrollTop 被 clamp 成 0"吃掉，所以恢复必须等 `viewportH > 0`。
   */
  const scrollMemo = useRef({ grid: 0, list: 0 })
  /** Ctrl+滚轮的方向累计量；切档 / 反向 / 松开 Ctrl 都清零 */
  const wheelAccum = useRef(0)
  /**
   * 舞台（A 线）用的双击快照：`getBoundingClientRect()` 在 `dblclick` 的**同步段**里读一次，
   * 之后动画只读这份快照。放在 ref 里而不是 `dataset`：双击会立刻切到文件视图 / 舞台，
   * 卡片节点随即卸载，写在 DOM 上的数据会跟着消失。
   * ⚠️ B2 只**写**不读，舞台接线是 A2 的活。
   */
  const stageOriginRef = useRef<{
    id: string
    rect: { left: number; top: number; width: number; height: number }
  } | null>(null)
  /**
   * hover 预热的防抖句柄。
   * ⚠️ 必须放在**所有早退之前**（这里），不能跟着 hoverProps 一起写在下面 ——
   * 放在早退之后会让某些渲染路径少调一次 useRef，React 直接抛 #300
   * （2026-10-21 实测：双击进场时舞台被整棵卸载，报错就是 #300）。
   */
  const hoverTimer = useRef(0)
  /**
   * 拖拽卡片位图预热的防抖句柄（与舞台球预热的 `hoverTimer` **独立**）。
   *
   * 为什么独立：一张卡可能既是材质（要预热球）又是可拖出资产（要预热拖拽卡片），
   * 共用一个 timer 会互相 clearTimeout —— 表现为"球有时候不预热 / 拖拽总是没位图"。
   * 同样必须放在所有早退之前（同上：hook 数量必须稳定）。
   */
  const dragCardTimer = useRef(0)
  /**
   * 当前**可见顺序**（与网格 / 列表的真实渲染顺序完全一致）。
   *
   * 为什么用 ref 而不是 state：render 阶段算出的顺序要在 `useEffect`（Ctrl+A）和
   * 事件回调（Shift+点击）里读到最新值，而这些 hook 注册在最前面的早退之前，
   * 拿不到后面的局部变量。ref 在每次 render 时被覆盖，读取时总是当前帧的值。
   */
  const visibleOrderRef = useRef<string[]>([])
  /**
   * 可见集指纹（`dupOnly + 全部可见 id`）：选择裁剪 effect 的依赖。
   *
   * 用字符串而不是数组：`useVisibleAssets()` 每次 render 都返回新数组，
   * 数组当依赖会让 effect 每帧都跑（`pruneSelection` 无变化时虽不改状态，
   * 但会白跑一遍全量比较）。
   */
  const pruneKey = `${libraryView}\u0000${dupOnly ? 'dup' : 'flat'}\u0000${assets.map((a) => a.id).join('\u0000')}`

  /* ── 框选（marquee / 橡皮筋多选）─────────────────────────────────────────────
   *
   * 用户原话：「我们希望再开放用户框选选择的功能，现在我们是没有框选多选的功能的」。
   *
   * 状态机（运行期状态全部放 ref → 拖动过程中**不触发 React 重渲染**）：
   *   空白处 mousedown  → 记锚点（内容坐标）+ 采集一次卡片矩形快照 + 记选择快照
   *   位移 < 4px        → 什么都不做（就是一次"点空白"，避免手抖误触）
   *   位移 ≥ 4px        → armed：画半透明矩形、卡片交指针事件、按 Ctrl/Cmd 决定追加/替换
   *   mousemove         → 只做矩形相交运算；命中集**变了才写 store**（去抖）
   *   mouseup           → 收尾，选择保留
   *   Esc               → 取消：恢复起手时的选择
   *   scroll            → 矩形与命中一起跟随内容（内容坐标系，不用 clientY 硬算）
   *
   * 三条硬约束（改之前先看）：
   * ① **从卡片上起手绝不触发框选** —— 那是"拖出到 SketchUp"的高频手势，一行都不能抢；
   * ② 命中检测用 `getBoundingClientRect()` **一次性快照**，mousemove 里不再查 DOM
   *    （几百张卡时逐帧查 DOM 会直接掉帧）；
   * ③ 框选期间卡片 `pointer-events: none`（`[data-marquee='1']`，见 styles.css）→
   *    不出 hover 高亮、不会误触双击进文件夹、也不会误起拖。
   */
  /** 画在滚动容器里的矩形（位置/尺寸用内联样式直接改，不走 state） */
  const marqueeBoxRef = useRef<HTMLDivElement>(null)
  /** 当前拖动的运行期状态 */
  const marqueeRef = useRef<MarqueeDrag | null>(null)

  /** 视口坐标 → 滚动容器的**内容坐标**（唯一的坐标换算入口） */
  const toContentPoint = (
    container: HTMLElement,
    clientX: number,
    clientY: number
  ): { x: number; y: number } => {
    const r = container.getBoundingClientRect()
    return { x: clientX - r.left + container.scrollLeft, y: clientY - r.top + container.scrollTop }
  }

  /**
   * 采集**已渲染**卡片的矩形（内容坐标）。虚拟滚动下只有视口附近的卡片在 DOM 里，
   * 所以框选天然只可能命中"看得见的卡片"—— 与用户直觉一致。
   */
  const snapshotCardBoxes = (container: HTMLElement): Map<string, BoxRect> => {
    const boxes = new Map<string, BoxRect>()
    const base = container.getBoundingClientRect()
    const sl = container.scrollLeft
    const st = container.scrollTop
    container.querySelectorAll<HTMLElement>('[data-asset-card][data-asset-id]').forEach((el) => {
      const id = el.dataset.assetId
      if (!id) return
      const r = el.getBoundingClientRect()
      boxes.set(id, {
        left: r.left - base.left + sl,
        top: r.top - base.top + st,
        right: r.right - base.left + sl,
        bottom: r.bottom - base.top + st
      })
    })
    return boxes
  }

  /** 结束框选（`cancel = true` 即 Esc：把选择恢复成起手时的快照） */
  const endMarquee = (cancel: boolean): void => {
    const drag = marqueeRef.current
    if (!drag) return
    marqueeRef.current = null
    drag.detach()
    delete drag.container.dataset.marquee
    const box = marqueeBoxRef.current
    if (box) box.style.display = 'none'
    // 没越过阈值 = 一次空白点击，选择从头到尾没动过，不需要恢复
    if (!cancel || !drag.armed) return
    const st = useVault.getState()
    if (drag.snapshot.length === 0) st.select(null)
    else st.selectMany(drag.snapshot)
  }

  /**
   * 按当前锚点 / 光标重绘矩形并刷新命中（mousemove 与 scroll 共用）。
   *
   * 阈值用**视口位移**而不是内容位移：只滚轮滚动而鼠标没动时不应该进入框选态。
   */
  const paintMarquee = (drag: MarqueeDrag): void => {
    if (!drag.armed) {
      const moved = Math.hypot(
        drag.lastClient.x - drag.startClient.x,
        drag.lastClient.y - drag.startClient.y
      )
      if (moved < MARQUEE_MIN_PX) return
      drag.armed = true
      // 卡片立刻交出指针事件（不出 hover、不误触双击、不误起拖）
      drag.container.dataset.marquee = '1'
    }
    const cur = toContentPoint(drag.container, drag.lastClient.x, drag.lastClient.y)
    const box = boxOf(drag.anchor.x, drag.anchor.y, cur.x, cur.y)
    const el = marqueeBoxRef.current
    if (el) {
      el.style.display = 'block'
      el.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`
      el.style.width = `${box.right - box.left}px`
      el.style.height = `${box.bottom - box.top}px`
    }
    const hits = marqueeHitIds(drag.rects, visibleOrderRef.current, box)
    const key = hits.join('\u0000')
    // 命中集没变 → 不写 store（每次 mousemove 都 selectMany 会让整个网格重渲染）
    if (key === drag.applied) return
    drag.applied = key
    // 追加模式 = 起手快照 + 命中集（`selectMany` 内部会去重并保持顺序）
    useVault.getState().selectMany(drag.additive ? [...drag.snapshot, ...hits] : hits)
  }

  /** 在滚动容器**空白处**按下 → 起手框选（卡片 / 复选框 / 抓手 / 任何控件上起手一律不接管） */
  const startMarquee = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    if (useVault.getState().folderViewAssetId) return // 文件视图有独立交互，不在此列
    if (marqueeRef.current) return
    const container = e.currentTarget
    const target = e.target as Element | null
    // ① 卡片本体 = 拖到建模软件的手势，绝不能抢；② 任何控件上的按下同理
    if (target?.closest(MARQUEE_IGNORE_SELECTOR)) return
    const base = container.getBoundingClientRect()
    // 点在滚动条上不算空白（Chromium 的滚动条不计入 clientWidth/Height）
    if (
      e.clientX - base.left >= container.clientWidth ||
      e.clientY - base.top >= container.clientHeight
    ) {
      return
    }
    const drag: MarqueeDrag = {
      container,
      anchor: toContentPoint(container, e.clientX, e.clientY),
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      armed: false,
      // 与系统一致：按住 Ctrl/Cmd 框选 = 追加；不按 = 替换
      additive: e.ctrlKey || e.metaKey,
      snapshot: [...useVault.getState().selectedIds],
      rects: snapshotCardBoxes(container),
      applied: '\u0000init',
      detach: () => undefined
    }
    const onMove = (ev: globalThis.MouseEvent): void => {
      const cur = marqueeRef.current
      if (!cur) return
      // 安全网：在窗口外松手收不到 mouseup（也不一定触发 blur）→ 按键已归零就主动收尾
      if (ev.buttons === 0) {
        endMarquee(false)
        return
      }
      cur.lastClient = { x: ev.clientX, y: ev.clientY }
      paintMarquee(cur)
    }
    const onUp = (): void => endMarquee(false)
    // 窗口失焦（Alt+Tab / 切应用）收不到 mouseup → 必须单独收尾，否则框选卡死
    const onBlur = (): void => endMarquee(false)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      // 捕获阶段吞掉：别让文件视图 / 全局 Esc 再吃一次（一次按键关两层）
      ev.stopPropagation()
      endMarquee(true)
    }
    const onScroll = (): void => {
      const cur = marqueeRef.current
      if (!cur) return
      // 内容坐标不随滚动变化 → 把新进入视口的卡片**并进**快照即可，
      // 已经滚出视口的条目仍然几何有效（虚拟滚动不改变内容布局）。
      snapshotCardBoxes(container).forEach((box, id) => cur.rects.set(id, box))
      paintMarquee(cur)
    }
    // 一律用捕获阶段：卡片 / 复选框上的 stopPropagation 不能把收尾吞掉
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey, true)
    container.addEventListener('scroll', onScroll, { passive: true })
    drag.detach = (): void => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, true)
      container.removeEventListener('scroll', onScroll)
    }
    marqueeRef.current = drag
  }

  // 组件卸载（切库 / 视图整体替换）时把 window 上的监听摘掉，避免泄漏
  useEffect(
    () => () => {
      const drag = marqueeRef.current
      if (!drag) return
      marqueeRef.current = null
      drag.detach()
      delete drag.container.dataset.marquee
    },
    []
  )

  /**
   * 重复份数映射（`assetId → 份数`，含自己）。普通视图据此给卡片右上角加 `×N` 角标。
   * 一次算好复用，不让每张卡片各扫一遍全库。
   */
  const dupCounts = useMemo(() => duplicateCountMap(allAssets), [allAssets])
  /**
   * 重复视图的分组骨架（只在 `dupOnly` 时计算）。组内再与当前筛选结果取交集，
   * 这样「重复资产」里仍可用标签/搜索做二次收窄。
   */
  const dupGroups = useMemo(
    () => (dupOnly ? groupDuplicates(allAssets) : []),
    [dupOnly, allAssets]
  )

  // ── T-B2：虚拟滚动（网格 = 逐行高度；列表 = 固定 44）─────────────────────
  //
  // 滚动容器在网格 / 列表 / 文件夹视图 / 空态之间是**条件渲染**的：ref 指向的元素会换，
  // 但 ref 对象身份不变 → hook 靠这个"挂载点指纹"重订阅（见 useScrollViewport 的 attachKey）。
  const scrollMountKey = `${view}|${folderViewAssetId ?? ''}|${dupOnly ? 'dup' : 'flat'}|${
    assets.length === 0 ? 'empty' : 'full'
  }`
  /** 网格容器的宽 / 高 / 滚动位置（列数与行高都由宽度算，docs/20 §3.2：列数不写死） */
  const gridViewport = useScrollViewport(gridRef, scrollMountKey)  /**
   * 网格度量：内容宽 = `clientWidth` − 左右 padding（`px-5` = 40）。
   * 首帧还没量到宽度时按单列算，量到后立刻重算（一帧的事）。
   * 封面比例不传：`gridMetrics` 的 `DEFAULT_COVER_ASPECT` 已是 4:3（与卡片模板唯一比例一致）。
   */
  const gridMetrics = metricsFor(gridDensity, Math.max(0, gridViewport.viewportW - GRID_PAD_X))
  /**
   * 逐行高度：全部读 `logic/gridMetrics`（封面 4:3 + 元信息 63 都在那里，本文件不补偿、不自算）。
   * 2026-10-22 起 `coverAspectOf` 恒为 4:3，所以每行等高；`gridRowHeights` 保留按列切行，
   * 将来某个大类若恢复特殊比例也不需要改这里。
   *
   * deps 用 `pruneKey`（可见集指纹）而不是 `assets`：`useVisibleAssets()` 每次 render 都返回
   * 新数组，直接当依赖会每帧重算 2000 条。
   */
  const gridRows = useMemo(
    () => gridRowHeights(assets.map((a) => a.kind), gridMetrics.columns, gridMetrics.cardW),
    [pruneKey, gridMetrics.columns, gridMetrics.cardW] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const gridWin = useMemo(
    () =>
      computeRowWindow({
        rowHeights: gridRows,
        scrollTop: gridViewport.scrollTop,
        viewportH: gridViewport.viewportH,
        gap: GRID_GAP
      }),
    [gridRows, gridViewport.scrollTop, gridViewport.viewportH]
  )
  /**
   * 列表行高：`LIST_ROW_H`(44) 只是 Bootstrap 初值 —— 表格行的真实高度由内容决定
   * （`text-sm` 的 20px 行盒 + `py-2` 的 16px + 折叠边框 ≈ 37，且随 DPI 取整浮动）。
   * 这里在**渲染后量一次首行**（只测一种行，不是"每行都测"的动态行高），量到就用实测值：
   * 偏移与真实 DOM 完全一致，也不用把行高强行写大（视觉零变化）。
   */
  const [listRowH, setListRowH] = useState(LIST_ROW_H)
  /** 列表：单列固定行高，与网格共用同一套 hook / 窗口函数家族 */
  const listWin = useVirtualWindow({
    itemCount: assets.length,
    columns: 1,
    rowH: listRowH,
    containerRef: listRef,
    attachKey: scrollMountKey
  })
  useLayoutEffect(() => {
    if (view !== 'list' || dupOnly) return
    const row = listRef.current?.querySelector<HTMLElement>('tbody tr:not([aria-hidden])')
    if (!row) return
    const h = row.getBoundingClientRect().height
    // 容差 0.25px：避免 DPI 取整造成的来回抖动
    if (h > 0 && Math.abs(h - listRowH) > 0.25) setListRowH(h)
    // 行高不随滚动改变，所以不把 startIndex 放进依赖（否则每帧都量一次）
  }, [view, dupOnly, listRowH])

  /**
   * 滚动位置恢复（见 `scrollMemo` 的注释）：容器重建 + 视口高度量到之后，把上次的位置写回去。
   * 条件里带 `Math.abs(...) > 1` 是为了**不跟用户抢滚动**：正常滚动时 memo 就是当前值，差为 0；
   * 只有在「容器刚被重建（scrollTop 从 0 开始）」时才会真的写一次。
   */
  useLayoutEffect(() => {
    const g = gridRef.current
    if (g && gridViewport.viewportH > 0 && Math.abs(g.scrollTop - scrollMemo.current.grid) > 1) {
      g.scrollTop = scrollMemo.current.grid
      gridViewport.onScroll()
    }
    const l = listRef.current
    if (l && listWin.viewportH > 0 && Math.abs(l.scrollTop - scrollMemo.current.list) > 1) {
      l.scrollTop = scrollMemo.current.list
      listWin.onScroll()
    }
  }, [scrollMountKey, gridViewport.viewportH, listWin.viewportH]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 密度变更 → 滚动位置归零（docs/20 §3.2）。
   * 档位一变，列数与行高全变，旧的 scrollTop 会落到完全不同的行上（位置错乱）。
   * 归零后要主动让 hook 重读一次：如果原本就是 0，浏览器不会再发 scroll 事件。
   */
  const prevDensityRef = useRef(gridDensity)
  useEffect(() => {
    if (prevDensityRef.current === gridDensity) return
    prevDensityRef.current = gridDensity
    wheelAccum.current = 0
    if (gridRef.current) gridRef.current.scrollTop = 0
    if (listRef.current) listRef.current.scrollTop = 0
    gridViewport.onScroll()
    listWin.onScroll()
    // 只认密度变化：两个 onScroll 是稳定回调（依赖 scrollRef），不必进依赖表
  }, [gridDensity]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Ctrl+滚轮切档：**必须用原生监听 + `{ passive: false }`**。
   * React 的 `onWheel` 在根容器上是以 passive 方式注册的（React 17+ 复用冒泡到 root），
   * 回调里调用 `preventDefault()` 会被 Chromium 忽略并打出
   * "Unable to preventDefault inside passive event listener" —— Electron 里表现就是
   * 页面跟着缩放 / 滚动。原生监听的第三个参数为对象时 `passive` 默认 false，
   * 这里仍显式写死，避免将来被"顺手统一成自动 passive"改坏。
   *
   * 行为：只在三档之间移动（不做无级缩放）；切档后累计量清零（一次滚动不连跳多档）；
   * 已到顶 / 到底不再写设置。
   */
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) {
        wheelAccum.current = 0
        return
      }
      // 只有按住 Ctrl 时才吞掉默认行为：否则普通滚轮要正常滚动网格
      e.preventDefault()
      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0
      if (dir === 0) return
      // 方向翻转 → 先清零，避免"反向滚要先把上次数值滚回去"的粘滞感
      if (Math.sign(wheelAccum.current) !== dir) wheelAccum.current = 0
      wheelAccum.current += e.deltaY
      if (Math.abs(wheelAccum.current) < WHEEL_STEP_PX) return
      wheelAccum.current = 0
      const cur = useVault.getState().settings?.gridDensity ?? 'medium'
      const idx = DENSITY_ORDER.indexOf(cur)
      // 向下滚（deltaY > 0）= 缩小 → 档位序号 -1；向上滚 = 放大 → +1
      const nextIdx = Math.min(
        DENSITY_ORDER.length - 1,
        Math.max(0, idx === -1 ? DENSITY_ORDER.indexOf('medium') : idx + (dir > 0 ? -1 : 1))
      )
      const next = DENSITY_ORDER[nextIdx] ?? 'medium'
      if (next === cur) return
      void useVault.getState().saveSettings({ gridDensity: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view])

  /**
   * Ctrl/Cmd+A = 全选**当前可见结果**（不是全库）。
   *
   * 为什么挂在 window 上而不是网格容器的 `onKeyDown`：网格容器本身不可聚焦
   * （可聚焦的是每张卡片），用户点过侧栏 / 顶栏之后焦点不在卡片上，容器的
   * keydown 永远收不到 → 快捷键静默失效。监听 window 但用 `isTypingTarget`
   * 守住输入框（搜索框里 Ctrl+A 仍然是"全选文本"），语义与"在网格上按"一致。
   * 组件只在网格 / 列表视图挂载（文件视图是另一个分支，但仍会经过这里）→
   * 文件视图下由 `folderViewAssetId` 守卫提前返回，不抢 Ctrl+A。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if ((e.key ?? '').toLowerCase() !== 'a') return
      if (isTypingTarget(e.target)) return
      if (useVault.getState().folderViewAssetId) return
      const ids = visibleOrderRef.current
      if (ids.length === 0) return
      // 阻止 Chromium 默认的"全选网页文本"（否则整页反白、Ctrl+C 会拷到界面文字）
      e.preventDefault()
      useVault.getState().selectAll(ids)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 选择裁剪：可见集一变（切筛选 / 排序 / 重复视图 / 删除资产）就把不在其中的
   * 选中项剔掉。不变量见 `logic/selection.ts`：批量删除只能作用于"看得见的东西"。
   *
   * 文件视图打开时网格没有渲染（`visibleOrderRef` 停留在进入前的旧值）→ 此时改用
   * 当前筛选结果裁剪，保证"在文件视图里改了筛选、返回网格后"选择里没有已看不见的 id。
   */
  useEffect(() => {
    const st = useVault.getState()
    const ids = st.folderViewAssetId
      ? applyFilters(st.assets, st.filters, st.libraryView).map((a) => a.id)
      : visibleOrderRef.current
    st.pruneSelection(ids)
  }, [pruneKey])

  // 文件视图优先于「没有匹配的资产」空态：它是与筛选无关的独立视图（右栏详情照旧联动）。
  // id 失效（被删 / 重扫丢弃）→ folderAsset 为 null，自然退回网格（store 也会兜底置 null）。
  const folderAsset = folderViewAssetId
    ? (allAssets.find((a) => a.id === folderViewAssetId) ?? null)
    : null
  // 关闭那一刻 `folderViewAssetId` 已是 null → 退出动画只能靠上一份资产快照渲染
  if (folderAsset) lastFolderAssetRef.current = folderAsset

  /**
   * 文件视图「退出动画」的起点：**只在 id 从"有"变成"无"的那一帧**把旧资产接管过来。
   *
   * 用 `useLayoutEffect` 而不是 `useEffect`：layout effect 在浏览器绘制**之前**执行，
   * 这里 setState 引发的重渲染会在同一帧内完成 —— 否则用户会先看到一帧"网格"
   * （列表已卸载、飞出还没开始）= 硬切，正是要修的问题。
   *
   * 内部关闭（Esc / 返回按钮）与外部关闭（App 中栏头的「← 返回」）走同一条路径：
   * 谁调的 `closeFolderView` 都无所谓，只看 id 的变化。
   */
  useLayoutEffect(() => {
    const prevId = prevFolderIdRef.current
    prevFolderIdRef.current = folderViewAssetId
    if (folderViewAssetId) {
      // 重新打开（含"退出动画没播完又点进另一个资产"）→ 打断退场，直接进入
      if (folderExitTimer.current) {
        window.clearTimeout(folderExitTimer.current)
        folderExitTimer.current = 0
      }
      setFolderExitAsset(null)
      return
    }
    if (!prevId) return
    const last = lastFolderAssetRef.current
    if (!last) return
    const duration = reducedMotion ? FOLDER_REDUCED_MS : FOLDER_EXIT_MS
    setFolderExitAsset(last)
    if (folderExitTimer.current) window.clearTimeout(folderExitTimer.current)
    folderExitTimer.current = window.setTimeout(() => {
      folderExitTimer.current = 0
      setFolderExitAsset(null)
    }, duration)
    // reducedMotion 变化时重跑不会有副作用：此时 prevId 与当前值都是 null → 提前 return
  }, [folderViewAssetId, reducedMotion])

  // 卸载时清掉退出动画定时器（否则可能在已卸载组件上 setState）
  useEffect(
    () => () => {
      if (folderExitTimer.current) window.clearTimeout(folderExitTimer.current)
    },
    []
  )

  /** 文件视图是否正占据中栏（含退场动画）——决定下面三个空态要不要让位 */
  const folderStageOn = folderAsset !== null || folderExitAsset !== null

  /**
   * 文件视图打开时把**身后的网格设为 inert**。
   *
   * 为什么需要：网格不再卸载（为了进场不出现空白帧），卡片是 `tabIndex=0` 的可聚焦元素 ——
   * 不处理的话 Tab 会把焦点送到被覆盖层挡住的卡片上，键盘用户会"点不到看不见的东西"；
   * `inert` 同时把整棵子树从无障碍树里摘掉。
   *
   * ⚠️ 只在**真正打开**（`folderAsset`）时置位，**退场动画期间不置位** ——
   * 用户口径「动画期间点击应能立即响应」，退场时点网格里的卡要立刻生效。
   */
  useEffect(() => {
    const el = view === 'list' ? listRef.current : gridRef.current
    if (!el) return
    el.inert = folderAsset !== null
  }, [folderAsset, view])

  /**
   * 重复视图下的实际渲染分组：组内只保留**当前筛选可见**的资产；
   * 剩下的成员少于 2 个 → 这组在当前筛选下不构成重复，整组不渲染。
   */
  const visibleIds = new Set(assets.map((a) => a.id))
  const shownGroups = dupOnly
    ? dupGroups
        .map((g) => {
          const visible = g.assets.filter((a) => visibleIds.has(a.id))
          // 体积按**可见成员**重算：否则筛选后标题上的「可清理 X」会包含看不见的副本
          const sizes = visible.map((a) => (Number.isFinite(a.size) ? Math.max(0, a.size) : 0))
          return {
            ...g,
            assets: visible,
            totalBytes: sizes.reduce((s, n) => s + n, 0),
            wastedBytes: sizes.slice(1).reduce((s, n) => s + n, 0)
          }
        })
        .filter((g) => g.assets.length > 1)
    : []

  /**
   * 当前**渲染顺序**的可见 id（Shift 范围选择、Ctrl+A 全选、选择裁剪都以此为准）。
   *
   * 重复视图的渲染骨架是「按组」，与 `assets` 的原始顺序不同——若这里直接
   * `assets.map(id)`，Shift 区间会跨过组标题、选到视觉上相隔很远的卡片。
   */
  const visibleOrder = dupOnly
    ? shownGroups.flatMap((g) => g.assets.map((x) => x.id))
    : assets.map((a) => a.id)
  visibleOrderRef.current = visibleOrder

  /** 退出重复视图并恢复整个库（空态里的「清空筛选 / 返回全部」共用） */
  const leaveDupView = () => {
    setDupOnly(false)
    setFilter(DEFAULT_FILTERS)
  }

  /**
   * **空白处右键**（本轮需求：「所有界面的空界面右键都增加刷新按钮」）。
   *
   * 判定：事件目标落在卡片 / 文件行内 → 那是它们自己的菜单，这里直接放弃
   * （卡片上的 `onContextMenu` 已经 `preventDefault`，但**不** `stopPropagation` ——
   * 它有拖拽/框选等冒泡依赖，所以豁免必须放在容器这侧做）。
   *
   * 覆盖范围：网格容器、列表容器、三个空态容器、文件视图的滚动容器（各自展开用途）。
   * 滚动条上的右键也算空白（Chromium 里滚动条在容器内，但不在任何卡片上）。
   */
  const onEmptyContextMenu = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (target?.closest(MENU_TARGET_SELECTOR)) return
    e.preventDefault()
    // 与卡片菜单互斥：右键空白处时把上一张卡片的菜单收掉，避免两层浮层叠着
    setMenu(null)
    setEmptyMenu({ x: e.clientX, y: e.clientY })
  }

  /** 空态也要能右键（三处空态共用一个渲染口） */
  const emptyAreaMenu = emptyMenu ? (
    <EmptyAreaContextMenu x={emptyMenu.x} y={emptyMenu.y} onClose={() => setEmptyMenu(null)} />
  ) : null

  // 用户反馈第 5 条：库里仍有资产、只是筛选结果为 0 → 这里必须显示「没有匹配的资产」，
  // 绝不能被 App 的全局空态（拖包 CTA）盖掉。生效维度提取在 filters.ts 的纯函数里，组件只渲染。
  //
  // 2026-10：文件视图（含退场动画）优先级更高 —— 它盖在网格之上，但空态会**替换**
  // 整个中栏，所以这里必须让位（`!folderStageOn`）。
  if (assets.length === 0 && !menu && !folderStageOn) {
    // C 线：回收站空态与「筛选结果为 0」是两件事，文案必须分开（否则用户会去清筛选）
    if (trashMode) {
      return (
        <div
          onContextMenu={onEmptyContextMenu}
          className="flex flex-1 flex-col items-center justify-center gap-3 text-muted"
        >
          <IconTrash width={40} height={40} className="text-tertiary" />
          <p className="text-sm">回收站是空的</p>
          <p className="max-w-md text-center text-[12px] leading-relaxed">
            删除的资产会先放进这里，保留期内随时可以还原；到期后自动彻底删除。
          </p>
          {emptyAreaMenu}
        </div>
      )
    }
    const dims = activeFilterDimensions(filters)
    const hasDupDim = dupOnly
    return (
      <div
        onContextMenu={onEmptyContextMenu}
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted"
      >
        {/* 图标规格 A：筛选结果为 0 的空态图形（40px、单色 currentColor） */}
        <IconEmptyFilter className="text-tertiary" />
        <p className="text-sm">没有匹配的资产</p>
        {(dims.length > 0 || hasDupDim) && (
          <p className="max-w-md text-center text-[12px] leading-relaxed">
            {[...(hasDupDim ? ['视图：重复资产'] : []), ...dims.map((d) => `${d.label}：${d.value}`)].join(' · ')}
          </p>
        )}
        {(dims.length > 0 || hasDupDim) && (
          <button className="btn" onClick={leaveDupView} title="清除全部筛选条件，恢复显示整个库">
            清空筛选
          </button>
        )}
        {emptyAreaMenu}
      </div>
    )
  }

  // 重复视图但当前筛选下没有任何「≥2 份」的组 → 明确告诉用户没有重复，而不是空白网格
  // （同上：文件视图盖在网格之上，不能被这个空态替换掉）
  if (dupOnly && shownGroups.length === 0 && !folderStageOn) {
    return (
      <div
        onContextMenu={onEmptyContextMenu}
        className="flex flex-1 flex-col items-center justify-center gap-3 text-muted"
      >
        <IconEmptyFilter className="text-tertiary" />
        <p className="text-sm">没有发现重复资产</p>
        <p className="max-w-md text-center text-[12px] leading-relaxed">
          同一大类下名字相同的资产才会被归为一组。重复导入同一个压缩包后，这里会显示可清理的多余副本。
        </p>
        <button className="btn" onClick={leaveDupView} title="退出重复视图，恢复显示整个库">
          返回全部资产
        </button>
        {emptyAreaMenu}
      </div>
    )
  }

  const isMulti = selectedIds.length > 1
  const crossKind = isMulti && isCrossKind(allAssets, selectedIds)
  /**
   * 浮出操作条的出现条件：
   * - 资产视图：≥2 项（沿用原口径，1 项走右栏详情）；
   * - 回收站：≥1 项——回收站只有「还原 / 彻底删除」两个动作，勾一个就该能直接操作，
   *   否则单选用户必须跑右栏，和"多选入口已可见"的预期不符。
   */
  const showBar = trashMode ? selectedIds.length > 0 : isMulti

  // 右键：命中项已多选 → 菜单作用于整个多选集；否则只作用于该项
  const contextMenuIds = (a: Asset): string[] =>
    selectedIds.includes(a.id) && selectedIds.length > 1 ? selectedIds : [a.id]
  const onContextMenu = (e: MouseEvent, a: Asset) => {
    e.preventDefault()
    // 回收站里不弹资产菜单：菜单项是「指派分类 / 删除」，对已删资产都是错的
    // （再删一次会拿旧 folder 去软删，主进程只会报失败）。还原 / 彻底删除在详情面板与浮出条上。
    if (trashMode) return
    // 与空白处菜单互斥（同一次右键不该留两层）
    setEmptyMenu(null)
    setMenu({ x: e.clientX, y: e.clientY, ids: contextMenuIds(a) })
  }

  // 拖出手势（P0-14）：拖的是**主模型文件**（skp > max > fbx > obj > 3ds > 首个模型 > files[0]），
  // 拖拽图标用该资产缩略图；没有可识别主文件（files 为空）的资产不可拖。
  const dragProps = (a: Asset) => {
    // C 线：已删资产的文件已经在 `.trash/` 里，`folder` 指向的旧绝对路径已不存在 →
    // 拖出去只会让 SU 报「文件找不到」。回收站里**彻底禁用拖出**（不是灰掉，是根本不挂手势）。
    if (isDeletedAsset(a)) return {}
    const abs = primaryFileAbs(a)
    if (!abs) return {}
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        // ⚠️ 反馈 6d 关键守卫：抓手的 HTML5 归类拖拽会冒泡到卡片（卡片是 draggable 祖先）。
        // 事件源落在抓手上 → 必须直接返回，绝不能调 startDrag：一旦调了，拖拽交给操作系统，
        // 左栏的 drop 永远收不到（应用内归类失效）。
        //
        // 注意**不能**写成 `e.target !== e.currentTarget`：封面 `<img>` 本身是浏览器原生
        // 可拖元素，从缩略图上起拖时 target 是 img（≠ 卡片）——那样会把核心的
        // 「拖出到建模软件」也误杀掉。只按「是否落在抓手内」判断。
        const origin = e.target as Element | null
        if (origin?.closest('[data-assign-grip]')) return
        // ⚠️ 守卫必须在 beginSystemDrag **之前**：它会 preventDefault 掉渲染进程的 HTML5 拖拽，
        // 而抓手正是靠那次 HTML5 拖拽把载荷送进左栏的 drop —— 顺序反了归类就失效。
        //
        // 系统级拖出统一入口：内部第一步 preventDefault（不取消渲染进程自己的拖拽会与
        // 主进程 startDrag 的原生拖拽重入 → Windows 上直接崩，日志只留 drag:start）。
        //
        // 拖拽卡片位图（v0.5.4）：hover 时已预热 → 这里**同步**读缓存；
        // 未命中就传 null，main 回退到缩略图图标 —— 绝不能因为没预热而拖不动。
        const cardPng = cachedDragCard(a.id)
        beginSystemDrag(e, a.name, abs, a.thumbPath ?? null, (path, thumb) =>
          window.modvault.startDrag(path, thumb, cardPng)
        )
      }
    }
  }

  /**
   * 归类抓手的拖拽（**应用内**）：只写 `dataTransfer`，绝不调 `startDrag`。
   *
   * ids 规则：该卡片已在多选集合 → 拖全部选中项；否则只拖这一张（`dragIdsOf` 纯函数）。
   * `stopPropagation` + 卡片 `onDragStart` 的 `[data-assign-grip]` 守卫是**双保险**：
   * 任一失效都不会把应用内归类误升级成系统级拖出。
   */
  const gripProps = (a: Asset) => ({
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.stopPropagation()
      const ids = dragIdsOf(a.id, selectedIds)
      e.dataTransfer.setData(ASSET_DRAG_MIME, serializeDragIds(ids))
      // 部分平台没有 text/plain 时不显示「移动」光标；补一份可读文案（左栏只认自定义 MIME）
      e.dataTransfer.setData('text/plain', `归类 ${ids.length} 个资产`)
      e.dataTransfer.effectAllowed = 'move'
      // 拖拽预览用整张卡片，而不是 14px 的抓手（卡片/行上有 data-asset-card 标记）
      const card = e.currentTarget.closest('[data-asset-card]')
      if (card instanceof HTMLElement) e.dataTransfer.setDragImage(card, 20, 20)
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      // 抓手只负责拖拽：点击不能顺带触发卡片的选中语义
      e.stopPropagation()
    },
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      // 双击抓手也不能进入「软件内文件视图」
      e.stopPropagation()
    }
  })

  // 点击（2026-10 多选入口补齐）：
  // - 普通点击 = 单选（清空多选，语义不变）；
  // - Ctrl/Cmd+点击 = 切换该项的选中状态（老路径，保留）；
  // - Shift+点击 = 以 `lastClickedId` 为锚点、在**当前渲染顺序**上选中区间（含两端）。
  //   锚点丢失（被删 / 被筛掉）时 store 会退化为单点，不会"什么都没选上"。
  const clickProps = (a: Asset) => ({
    onClick: (e: MouseEvent) => {
      if (e.shiftKey) {
        selectRange(lastClickedId, a.id, visibleOrder)
        return
      }
      if (e.ctrlKey || e.metaKey) toggleSelect(a.id)
      else select(a.id)
    }
  })

  // 双击（docs/15 §6c 用户拍板）：**不再开系统资源管理器**，改为把中栏切换成该资产的
  // 软件内文件列表（双击文件行才用系统默认程序打开）。系统资源管理器仍可从右键菜单进入。
  //
  // docs/20 §6 第 1 层防护（rect 快照优先）：虚拟化会回收卡片 DOM，舞台动画若再去读
  // 卡片 rect 就会拿到 null。这里在**同步段**读一次快照存进 ref；卡片随即卸载也不影响。
  const dblProps = (a: Asset) => ({
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      // C 线：回收站里的文件已经不在 `folder` 指向的位置，文件列表会全是打不开的死路径 →
      // 双击不进入文件视图（还原后再进去看）。
      if (isDeletedAsset(a)) return
      // ★ 0.6.5 用户口径：**HDRI 资产双击直接进预览**（不再进文件视图）。
      // 入口统一走 store（`hdrPreviewAssetId`），弹窗本体只在 App 挂一次。
      if (a.kind === 'hdri') {
        openHdrPreview(a.id)
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      stageOriginRef.current = {
        id: a.id,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
      openFolderView(a.id)
      // A 线 T-03（2026-10-21）：**只有材质类**才出球。模型/HDRI/其他没有 PBR 槽位，
      // 出球既没有意义，还会白解码一堆贴图（用户口径：模型面板不需要这个生成）。
      // rect 必须用同步段拍下的那个，虚拟滚动随后回收卡片也不影响。
      if (canStage(a)) stageController.open(a.id, rect)
    }
  })

  /**
   * 拖拽卡片位图**预热**（v0.5.4）：hover 120ms 后把该资产的 168×210 卡片渲染成 PNG 写入
   * 模块级 LRU 缓存（上限 20）。
   *
   * 为什么不能在 dragstart 里现画：`webContents.startDrag` 必须在 `dragstart` 的同步段发起
   * （invoke 往返会丢手势），而 `canvas.toBlob` 是异步的 —— 等它回来手势已经结束。
   * 预热让 dragstart 只需同步查一次 Map。
   *
   * 与 `canStage` 无关：**所有类型**都能拖出，都必须有卡片预览（球预热只服务材质类）。
   */
  /** idle 预热：有空再干，最多等 500ms（用户已经离开也不会永远不做） */
  const scheduleIdlePrewarm = (fn: () => void): number => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    }
    if (typeof w.requestIdleCallback === 'function') {
      return w.requestIdleCallback(() => fn(), { timeout: 500 })
    }
    return window.setTimeout(fn, 120)
  }

  /** 取消 idle 或 timeout 两种 id（两个 id 空间互不相干，各自调用都是安全的 no-op） */
  const cancelPrewarm = (id: number): void => {
    if (!id) return
    const w = window as Window & { cancelIdleCallback?: (id: number) => void }
    if (typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(id)
    window.clearTimeout(id)
  }

  /**
   * 舞台预热的**抢跑**调度（2026-10，双击掉帧修复配套，只给舞台球用）。
   *
   * 为什么不用 idle：`requestIdleCallback` 在主线程持续忙碌时会被推到 `timeout`（500ms）
   * 之后，经常已经晚于用户的双击 —— 等于没预热。而换卡不再重建 renderer（同一批改动）
   * 后，舞台预热成本只剩"解码 + 上传"，几十毫秒后开跑足以覆盖「hover → 双击」（实测通常
   * >150ms），又不会像 0ms 那样打断滚动。
   *
   * 延迟由「动效性能」档位决定（`eagerPrewarm`：极致 = 0ms 立刻排队，流畅/均衡 = 60ms 兜底），
   * 见 hoverProps 里的调用点。
   *
   * ⚠️ **拖拽卡片位图预热仍走 `scheduleIdlePrewarm`**：那个要画 canvas，抢跑会卡滚轮。
   */
  const schedulePrewarmSoon = (fn: () => void, delayMs: number): number => {
    return window.setTimeout(fn, delayMs)
  }

  const prewarmDragCard = (a: Asset): void => {
    if (isDeletedAsset(a)) return // 回收站资产不可拖出，预热没意义
    if (cachedDragCard(a.id)) return // 已预热（命中即刷新 LRU）
    // 拖起来的浮动卡片上写的是**显示名**（别名 > 剥知末 ID > 原名，与卡片标题同源）
    void renderDragCard({ thumbUrl: dragCardThumbUrl(a), name: displayOf(a) })
      .then((png) => cacheDragCard(a.id, png))
      .catch(() => undefined)
  }

  /**
   * hover 预热（2026-10-21）：鼠标停在材质卡上 120ms 后，把该资产交给舞台的球去解码贴图。
   * 实测未预热时双击的 p95 = 99.7ms（4 帧 >50ms），同一材质第二次是 16.8ms 满帧 ——
   * 说明卡顿来自"首次解码 + 上传"，不是动画。预热把这个成本挪到用户看不见的 hover 阶段。
   * 120ms 防抖是为了扫过一排卡时不逐张解码 4K。
   *
   * v0.5.4 追加：同一个 hover 里并行预热「拖拽卡片位图」，用**独立 timer**，
   * 两者互不覆盖（见 `dragCardTimer` 的注释）。
   */
  const hoverProps = (a: Asset) => ({
    onPointerEnter: () => {
      // 性能（docs/12 补丁）：两个预热都从「120ms 定时器」改成 **idle 调度**。
      // 原来扫过一排卡会在 hover 热路径上排满解码任务 —— 用户实测划 4 张卡出现
      // 744ms 长任务。改成空闲再做，且同一时刻只留一个待执行（新的 hover 取消上一个）。
      if (dragCardTimer.current) cancelPrewarm(dragCardTimer.current)
      dragCardTimer.current = scheduleIdlePrewarm(() => prewarmDragCard(a))

      if (!canStage(a)) return
      // 开关（docs/19 ⑤）：`settings.materialStage` 关着就不预热。
      // 舞台本身（双击进入）不受影响 —— 那是核心体验，只是不再"划一下就偷偷解码"。
      if (useVault.getState().settings?.materialStage !== true) return
      if (hoverTimer.current) cancelPrewarm(hoverTimer.current)
      // 舞台球抢跑：**极致档不等（0ms 立刻排队）**，流畅/均衡 60ms 兜底。
      // 换卡不重建 renderer 之后预热只剩解码成本，赶在「hover → 双击」之间做完才算真预热；
      // idle 调度常被拖到双击之后，等于没预热。
      hoverTimer.current = schedulePrewarmSoon(
        () => stageController.preview(a.id),
        currentMotionProfile().eagerPrewarm ? 0 : 60
      )
    },
    onPointerLeave: () => {
      if (dragCardTimer.current) {
        cancelPrewarm(dragCardTimer.current)
        dragCardTimer.current = 0
      }
      if (hoverTimer.current) {
        cancelPrewarm(hoverTimer.current)
        hoverTimer.current = 0
      }
    }
  })

  /** 列表行（普通视图与重复视图共用同一份渲染，避免两套样式漂移） */
  const renderRow = (a: Asset) => {
    const selected = selectedIds.includes(a.id)
    return (
      <tr
        key={a.id}
        // `="1"` 是给"空白处右键"与框选共用的**值**（选择器在 logic/contextMenu.ts，
        // 两边必须逐字一致；只写布尔属性在 HTML 里是空串，选择器要写 `[data-asset-card]` 才对得上）
        data-asset-card="1"
        // 框选命中靠这个属性把 DOM 矩形映射回 assetId（见 snapshotCardBoxes）
        data-asset-id={a.id}
        {...dragProps(a)}
        {...clickProps(a)}
        {...dblProps(a)}
        {...hoverProps(a)}
        onContextMenu={(e) => onContextMenu(e, a)}
        className={`group cursor-pointer border-b border-line/60 last:border-0 transition ${
          selected ? 'bg-accent-tint/60' : 'hover:bg-elevated/40'
        }`}
      >
        {/* 行首：多选复选框 + 归类抓手（2026-10 多选入口补齐）。
            复选框 hover / 选中才显形，但**列宽固定 w-14**（56px = 16 框 + 4 gap +
            20 抓手 + 16 内边距）→ 显隐不引起列宽跳动。
            两个控件都要 stopPropagation（框自身已处理，抓手走 gripProps）：
            点框 = 切换选中；点抓手 = 只拖不选。 */}
        <td className="w-14 px-2 py-2 text-tertiary">
          <span className="flex items-center gap-1">
            <SelectBox
              checked={selected}
              onToggle={() => toggleSelect(a.id)}
              className={
                selected
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
              }
            />
            {!trashMode && (
              <GripHandle {...gripProps(a)} className="opacity-0 group-hover:opacity-100" />
            )}
          </span>
        </td>
        <td className="max-w-[320px] truncate px-3 py-2 font-medium" title={displayOf(a)}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{displayOf(a)}</span>
            {/* v0.4 列表视图标记：星标（未收藏 hover 才出现）+ 色点，均 12px 档 */}
            <button
              type="button"
              className={`shrink-0 rounded transition ${
                a.favorite === true
                  ? 'text-accent'
                  : 'text-tertiary opacity-0 group-hover:opacity-100 hover:text-accent'
              }`}
              title={a.favorite === true ? '取消收藏' : '收藏'}
              aria-pressed={a.favorite === true}
              onClick={(e) => {
                e.stopPropagation()
                void setFavorite([a.id], a.favorite !== true)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <StarIcon filled={a.favorite === true} size={12} />
            </button>
            {a.colorTag && <ColorDot tag={a.colorTag} size={8} />}
          </span>
          {a.mojibake === true && <span className="ml-1.5 text-[10px] text-danger">疑似乱码</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-muted">{KIND_LABEL[a.kind]}</td>
        <td className="max-w-[150px] truncate px-3 py-2 text-muted">
          <CategoryCell asset={a} />
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right text-muted">{formatBytes(a.size)}</td>
        <td className="whitespace-nowrap px-3 py-2 text-muted">
          {formatDate(trashMode && a.deletedAt ? a.deletedAt : a.importedAt)}
        </td>
      </tr>
    )
  }

  /**
   * 列表的可见切片。列表是**单列固定 44**，直接用 `computeWindow` 的条目区间
   * （`startIndex/endIndex` 与行号一一对应）。重复视图不虚拟化，见网格处的说明。
   */
  const listSlice = dupOnly ? [] : assets.slice(listWin.startIndex, listWin.endIndex + 1)
  const listRenderedRows = Math.max(0, listWin.endIndex - listWin.startIndex + 1)
  /** 下垫片 = 总高 − 上垫片 − 已渲染行高（`totalH` 已按行数算好，不会为负） */
  const listBottomPad = Math.max(0, listWin.totalH - listWin.offsetY - listRenderedRows * LIST_ROW_H)

  const list = (
    <div
      ref={listRef}
      onScroll={(e) => {
        scrollMemo.current.list = e.currentTarget.scrollTop
        listWin.onScroll()
      }}
      // 框选只能在**空白处**起手（卡片/控件上的 mousedown 由 startMarquee 内部排除）
      onMouseDown={startMarquee}
      // 空白处右键 = 刷新 / 清除筛选（卡片由自身的 onContextMenu 拦截，见 onEmptyContextMenu）
      onContextMenu={onEmptyContextMenu}
      // `relative`：框选矩形是滚动容器的绝对定位子元素（内容坐标系，随内容滚动 + 被容器裁剪）
      className="relative flex-1 overflow-auto px-4 py-3"
    >
      <div className="overflow-hidden rounded-modal border border-line bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              {/* 行首：多选复选框 + 归类抓手列（2026-10）。宽度与行内单元格一致（w-14），
                  复选框显隐不引起列宽跳动 */}
              <th className="w-14 px-2 py-2" aria-label="选择 / 拖动归类" />
              <th className="px-3 py-2 font-medium">名称</th>
              {/* 2026-10-21 走查修正：这一列显示的是 `KIND_LABEL`（贴图 / 材质预设 / 模型），
                  是**类型**不是分类；真正的分类在下一列「一级 / 二级」。原表头写「分类」会让人
                  以为这里是一级分类。 */}
              <th className="w-24 whitespace-nowrap px-3 py-2 font-medium">类型</th>
              <th className="w-36 px-3 py-2 font-medium">一级 / 二级</th>
              {/* 「SU 版本」列已移除：用户明确不需要这个信息，而 13 行里 13 个破折号只白占 80px，
                  把「导入时间」挤到折行。SU 版本仍可在详情面板看到。 */}
              <th className="w-24 px-3 py-2 text-right font-medium">大小</th>
              <th className="w-40 whitespace-nowrap px-3 py-2 font-medium">
                {trashMode ? '删除时间' : '导入时间'}
              </th>
            </tr>
          </thead>
          <tbody>
            {dupOnly
              ? shownGroups.map((g) => (
                  // 每组一个小节：标题行（可整组选中）+ 组内资产行。多个 tbody 合法。
                  <Fragment key={g.key}>
                    <tr className="border-b border-line/60 bg-elevated/40">
                      <td colSpan={6} className="px-3 py-1.5">
                        <DupGroupHeader
                          group={g}
                          onSelect={() => selectMany(g.assets.map((x) => x.id))}
                        />
                      </td>
                    </tr>
                    {g.assets.map(renderRow)}
                  </Fragment>
                ))
              : (
                  // T-B2 虚拟化：上下各一条 spacer 行撑高，中间只渲染可见窗口的行。
                  // `LIST_ROW_H` 与 renderRow 的 `h-11` 必须一致（否则偏移累积错位）。
                  <>
                    {listWin.offsetY > 0 && (
                      <tr aria-hidden style={{ height: listWin.offsetY }}>
                        <td colSpan={6} />
                      </tr>
                    )}
                    {listSlice.map(renderRow)}
                    {listBottomPad > 0 && (
                      <tr aria-hidden style={{ height: listBottomPad }}>
                        <td colSpan={6} />
                      </tr>
                    )}
                  </>
                )}
          </tbody>
        </table>
      </div>
      {/* 框选矩形：位置/尺寸由 startMarquee 内联写（transform + width/height），
          滚动时随内容走；`overflow` 由本容器裁剪 → 拖出中栏也不会溢出到侧栏/右栏 */}
      <div
        ref={marqueeBoxRef}
        aria-hidden
        style={{ display: 'none' }}
        className="pointer-events-none absolute left-0 top-0 z-30 border border-accent bg-accent/10"
      />
    </div>
  )

  /** 网格卡片（普通视图与重复视图共用） */
  const renderCard = (a: Asset) => {
    const selected = selectedIds.includes(a.id)
    /** 回收站：剩余天数徽标文案（非回收站视图恒 null，不渲染） */
    const daysLeft = trashMode ? trashBadgeText(a.deletedAt, trashRetention) : null
    // B6#31（形态类按画布）：深色卡片有 1px 描边（画布未选 `2:378`/`2:386`/`2:394`
    // = #2A2A2D，选中 `2:370` = #0A84FF）；浅色靠投影无描边。
    // 选中视觉收进 `.card-selected`（浅投影 / 深描边），不再挂 `ring-2`——
    // utilities 层的 ring 会盖掉 components 层的 box-shadow。
    return (
      <div
        key={a.id}
        role="button"
        tabIndex={0}
        data-asset-card="1"
        // 框选命中靠这个属性把 DOM 矩形映射回 assetId（见 snapshotCardBoxes）
        data-asset-id={a.id}
        {...dragProps(a)}
        {...clickProps(a)}
        {...dblProps(a)}
        {...hoverProps(a)}
        onContextMenu={(e) => onContextMenu(e, a)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (e.ctrlKey || e.metaKey) toggleSelect(a.id)
            else select(a.id)
          }
        }}
        // 反馈 6a：`card-hover` 提供上浮 2px + 专属 transition（浅色投影 / 深色提亮底色）。
        // 原来这里的裸 `transition` 已删——两套 transition 会互相覆盖。
        className={`group relative card-surface card-hover cursor-pointer overflow-hidden rounded-card bg-card text-left ${
          selected ? 'card-selected' : 'shadow-card'
        }`}
      >
        {/* 2026-10-22 用户拍板（docs/25 TODO-5 方案 A）：封面框**不再按 kind 分裂**，全部 4:3。
            —— 沿革（别只看半条）：2026-10-21 因「1:1 球图塞进 4:3 框被 `object-cover`
            上下切掉约 1/3」把材质/贴图卡改成了 `aspect-square`；裁切是修好了，代价是
            同一行里方框卡更高、**名字被推下去，标题高低不齐**（用户反馈：比裁切更刺眼）。
            本次反转：框统一 `aspect-[4/3]` + 封面图 `object-contain`（见 `Cover`）——
            球图与模型图都完整可见，且所有卡片的标题落在同一条水平线上；
            方图两侧的留白交给 `bg-canvas`，是"整齐的留白"而不是位置错位。 */}
        <div className="relative aspect-[4/3]">
          <Cover asset={a} name={displayOf(a)} />
          {/* v0.4 色标：封面左缘 3px 竖条。无标签时**不渲染**（不占位 → 无布局跳动） */}
          {a.colorTag && (
            <span
              className="absolute left-0 top-0 z-10 h-full w-[3px]"
              style={colorSwatchStyle(a.colorTag)}
              title={`色标：${COLOR_TAG_LABEL[a.colorTag]}`}
            />
          )}
          {/* §3.3 类型徽标：贴图/材质预设 = accent-tint 底蓝字，模型等 = 中性灰 tint（.badge 默认）
              2026-10-21 走查：单图「数据通道图」（法线 / AO / 粗糙度 / 位移）的封面**本来就该是原图**
              ——它没有 albedo 可上球。为了让这类卡片读起来是「这是一张法线图」而不是「球没渲出来」，
              在类型徽标旁再挂一个通道徽标（中性灰，不抢强调色）。 */}
          <div className="absolute left-2 top-2 flex items-center gap-1">
            <span
              className={`badge ${
                a.kind === 'texture' || a.kind === 'material' ? 'badge-accent' : ''
              }`}
            >
              {KIND_LABEL[a.kind]}
            </span>
            {a.kind === 'texture' && dataChannelLabel(a.files) && (
              <span className="badge" title={`这张图是${dataChannelLabel(a.files)}通道图，不上球预览`}>
                {dataChannelLabel(a.files)}
              </span>
            )}
          </div>
          {/* 右上角**固定竖列**（2026-10-25 反馈：网格卡片原先「左侧方块 + 右上圆勾」两个多选控件重复，
              现在只保留这一个圆钮）：
              ① 圆形多选钮 —— 恒定占位（未选中时只是 `opacity-0`，hover 才现形），
                 避免多选时卡片角标位置左右横跳；
              ② 未选中时才渲染的标记列（收藏星 / 乱码 / 回收站剩余天数）；选中时整体让位。
              用竖列而不是各自绝对定位：否则圆钮 22px 与下方的星标/徽标必然重叠。 */}
          <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
            <SelectBox
              variant="circle"
              checked={selected}
              onToggle={() => toggleSelect(a.id)}
              className={
                selected
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
              }
            />
            {/* C 线「最近删除」：右上角剩余天数徽标（保留期按 Settings.trashRetention 算）。
                在回收站里"还剩几天"比"收没收藏"重要得多。`recycle` 档没有软删记录，不渲染。 */}
            {!selected &&
              (trashMode ? (
                daysLeft ? (
                  <span
                    className="badge"
                    title="保留期到期后会自动彻底删除（进系统回收站）；期间随时可还原"
                  >
                    {daysLeft}
                  </span>
                ) : null
              ) : (
                <Flags asset={a} onToggleFavorite={() => void setFavorite([a.id], a.favorite !== true)} />
              ))}
          </div>
          {/* v0.4 重复角标：**右下角**（右上角已归收藏星；左下角是归类抓手）。
              复用既有 .badge（中性灰 tint），不新造颜色。 */}
          {(dupCounts.get(a.id) ?? 0) > 1 && (
            <span
              className="badge absolute bottom-2 right-2"
              title={`库里有 ${dupCounts.get(a.id)} 份同名同类的副本`}
            >
              ×{dupCounts.get(a.id)}
            </span>
          )}
          {/* 反馈 6d：hover 才淡入的归类抓手（绝对定位，不占位 → 无布局跳动）。
              `pointer-events-none` 保证不可见时不吞掉卡片点击。
              回收站里不渲染：归类拖拽对已删资产没有意义（文件不在原目录）。 */}
          {!trashMode && (
            <GripHandle
              {...gripProps(a)}
              className="absolute bottom-2 left-2 z-10 pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
            />
          )}
        </div>
        {/* 元信息区高度**必须**写死且不随字体浮动（虚拟化要用它算行高）：
            `h-[63px]` = py-2×2(16) + 标题两行(2×15) + mt-0.5(2) + 元信息行 15。
            两行都写死 `leading-[15px]`：若用默认 `line-height: normal`，换字体
            （Sarasa / 雅黑 / 回退）会差 2–4px，几十行后累积成几百像素 → 虚拟窗口露白。
            改这里必须同步 `logic/gridMetrics.ts` 的 `CARD_META_H`（= 63，行高计算读它）——
            这里写 `h-[63px]` 字面量是必须的：Tailwind 只扫静态 class，模板拼接的类名不生成。 */}
        <div className="h-[63px] px-2.5 py-2">
          {/* 标题**固定占两行高度**：`line-clamp-2` 最多显示两行，
              `min-h-[30px]` 让只有一行的名字也占满两行 → 同一行里的标题基线恒等，
              长名字换到第二行时不会把下面的元信息行推下去（卡片高度不随名字长度变）。

              2026-10-21 用户拍板：卡片标题剥掉知末 `ID_<数字>` 尾巴，**只改显示**
              （磁盘文件夹名、dedupeKey、搜索排序全走原来的 `a.name`，零迁移）。
              0.6.0：先查别名表 —— 别名 > 剥 ID > 原名（`displayOf`）。 */}
          <div
            className="line-clamp-2 min-h-[30px] text-[12px] font-semibold leading-[15px]"
            title={displayOf(a)}
          >
            {displayOf(a)}
          </div>
          <div className="mt-0.5 truncate text-[11px] leading-[15px] text-muted">
            {KIND_LABEL[a.kind]} · {formatBytes(a.size)} · {a.files.length} 个文件
            {/* 回收站（2026-10-21 走查）：同一套封面+同名会有多份副本，只靠「还剩 N 天」分不清谁是谁 →
                补一条删除时间。年份省掉（卡片行宽有限），精确到分钟。 */}
            {trashMode && a.deletedAt ? ` · 删除于 ${formatDate(a.deletedAt).slice(5)}` : ''}
          </div>
        </div>
      </div>
    )
  }

  // B5#16（已拍板按画布实测值）：网格容器 padding 上20 / 左右20 / 下16（画布 `2:356`）。
  // gap 14 走 `--gap-card`；`gap-card` 必须在 tailwind.config.js 的 `extend.spacing` 显式声明
  // 才会真正生成——此前 `card` 不在 spacing 中，`.gap-card` 在构建产物里不存在（网格实际无间距）。
  // 反馈 6b：列宽下限按 Settings.gridDensity 取（GRID_COLS 三个完整字面量 class）。
  const gridCols = `grid ${GRID_COLS[gridDensity]} gap-card`

  /**
   * 网格可见切片：行窗口 → 条目区间。
   * `startIndex = startRow * columns` 保证切片从**整行行首**开始，否则 CSS Grid 会
   * 把第 5 张卡排到第一列、整块错位。
   */
  const gridStartIndex = gridWin.startRow * gridMetrics.columns
  const gridEndIndex = Math.min(
    assets.length - 1,
    (gridWin.endRow + 1) * gridMetrics.columns - 1
  )
  const gridSlice = dupOnly ? [] : assets.slice(gridStartIndex, gridEndIndex + 1)
  const renderedRowHeights = dupOnly ? [] : gridRows.slice(gridWin.startRow, gridWin.endRow + 1)
  /** 已渲染块的真实高度（行高之和 + 行间距；`totalH` 已去掉尾部 gap，所以不会为负） */
  const renderedBlockH =
    renderedRowHeights.reduce((sum, h) => sum + h, 0) + GRID_GAP * Math.max(0, renderedRowHeights.length - 1)
  const gridBottomPad = Math.max(0, gridWin.totalH - gridWin.offsetY - renderedBlockH)

  const grid = (
    <div
      ref={gridRef}
      onScroll={(e) => {
        scrollMemo.current.grid = e.currentTarget.scrollTop
        gridViewport.onScroll()
      }}
      // 框选只能在**空白处**起手（卡片/控件上的 mousedown 由 startMarquee 内部排除）
      onMouseDown={startMarquee}
      // 空白处右键 = 刷新 / 清除筛选（同上：卡片自身会先拦截）
      onContextMenu={onEmptyContextMenu}
      // `relative`：框选矩形是本容器的绝对定位子元素（内容坐标系，随内容滚动 + 被容器裁剪）
      className="relative flex-1 overflow-auto px-5 pt-5 pb-4"
    >
      {dupOnly ? (
        // 重复视图：每组一个标题行（组名 + ×N + 可清理体积，点击整组选中）+ 正常卡片
        <div className="flex flex-col gap-5">
          {shownGroups.map((g) => (
            <section key={g.key}>
              <div className="mb-2 px-0.5">
                <DupGroupHeader group={g} onSelect={() => selectMany(g.assets.map((x) => x.id))} />
              </div>
              <div className={gridCols}>{g.assets.map(renderCard)}</div>
            </section>
          ))}
        </div>
      ) : (
        // T-B2 虚拟化：上垫片 + 只渲染窗口内的行 + 下垫片。
        // `gridTemplateRows` 把每行高度**钉死**成模型值：这样 DOM 高度与偏移模型
        // 恒等（即使卡片内容比预估高/矮，也只会在本行内拉伸，不会跨行累积误差）。
        <>
          {gridWin.offsetY > 0 && <div aria-hidden style={{ height: gridWin.offsetY }} />}
          <div
            className={gridCols}
            style={
              renderedRowHeights.length > 0
                ? { gridTemplateRows: renderedRowHeights.map((h) => `${h}px`).join(' ') }
                : undefined
            }
          >
            {gridSlice.map(renderCard)}
          </div>
          {gridBottomPad > 0 && <div aria-hidden style={{ height: gridBottomPad }} />}
        </>
      )}
      {/* 框选矩形：位置/尺寸由 startMarquee 内联写（transform + width/height），
          滚动时随内容走；`overflow` 由本容器裁剪 → 拖出中栏也不会溢出到侧栏/右栏 */}
      <div
        ref={marqueeBoxRef}
        aria-hidden
        style={{ display: 'none' }}
        className="pointer-events-none absolute left-0 top-0 z-30 border border-accent bg-accent/10"
      />
    </div>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {view === 'list' ? list : grid}

      {/* 「回到顶部」：挂在**这一层**（`relative`）而不是滚动容器里 —— 容器滚多远，
          按钮都钉在中栏右下角。`containerRef` 跟着当前视图换（grid ↔ list 是不同的
          DOM 节点，ref 对象身份不变时需要这里的入参变化来触发重绑）。
          文件视图展开时它让位（文件视图自己有一个，见 FolderFileList）。 */}
      <BackToTop
        containerRef={view === 'list' ? listRef : gridRef}
        hidden={folderStageOn}
        attachKey={scrollMountKey}
      />

      {/* ── 文件视图（进入）：盖在网格之上 ──────────────────────────────────
       * 网格**不卸载**，留在下面 → 交叉淡入的 130ms 里用户看到的是"网格 → 文件列表"，
       * 而不是"空白 → 文件列表"（用户口径：动画期间不允许出现空白帧）。
       * 每一条内容（行 / 文件卡）由 `data-folder-anim='enter'` 驱动 Win8 磁贴翻入，
       * stagger 延迟写在各子项的 `--folder-stagger` 上。
       * 动效分档：`data-motion`（smooth 只 opacity / ultra 多一层轻微 blur）；
       * 系统「减少动效」由 styles.css 的 `@media (prefers-reduced-motion: reduce)` 兜住
       * （纯 CSS 对媒体查询的响应比 JS 状态更早、也更可靠）。 */}
      {folderAsset && (
        <div
          className="folder-stage folder-stage-enter absolute inset-0 z-20 flex flex-col"
          data-folder-anim="enter"
          data-motion={motionQuality}
        >
          <FolderFileList asset={folderAsset} view={view} />
        </div>
      )}

      {/* ── 文件视图（退出）：id 已置 null，用**上一份资产快照**渲染旧内容播放"飞出" ──
       * `pointer-events: none`（由 `.folder-stage-leave` 提供）→ 飞出期间点击网格
       * 立刻生效（用户口径：动画不能阻塞点击）；淡出结束由定时器卸载。 */}
      {!folderAsset && folderExitAsset && (
        <div
          className="folder-stage folder-stage-leave absolute inset-0 z-20 flex flex-col"
          data-folder-anim="leave"
          data-motion={motionQuality}
          aria-hidden
        >
          <FolderFileList asset={folderExitAsset} view={view} />
        </div>
      )}

      {/* §3.3/§4-6 多选浮出操作条：相对中栏水平居中、悬浮网格底部；圆角走 --radius-floatbar
          （画布 2:652 浅 r14 / 2:1024 深 r14）+ 投影。
          B6#39（形态类按画布）：画布 `2:652` 是**纯白卡 + 投影、无描边** → 去掉 `border border-line`。
          深色靠明度分层（floatbar #242428 高于 canvas #111113），同样不需要描边。 */}
      {showBar && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-floatbar bg-floatbar px-4 py-2 shadow-floatbar">
            <span className="rounded-pill bg-accent-tint px-2.5 py-1 text-[12px] font-medium text-accent-text">
              已选 {selectedIds.length} 项
            </span>
            {/* C 线：回收站里的批量动作只有「还原 / 彻底删除」——
                指派分类与（再次）删除对已删资产都是错的（文件不在原目录，软删只会失败）。 */}
            {trashMode ? (
              <>
                <button
                  className="btn-solid-lg"
                  title="把选中项搬回原位置（原位置被占时自动追加序号）"
                  onClick={() => void restoreAssets(selectedIds)}
                >
                  <IconRefresh width={13} height={13} />
                  还原
                </button>
                <button
                  className="btn-danger-lg"
                  title="彻底删除（进系统回收站，应用内不可还原）"
                  onClick={() => setPurgeIds([...selectedIds])}
                >
                  <IconTrash width={13} height={13} />
                  彻底删除
                </button>
              </>
            ) : (
              <>
                {/* B6#40（已拍板按画布）：画布 `2:655`「指派分类」h36 pad14 → 走 `.btn-solid-lg`。
                    不改 `.btn-solid`（渲染弹窗「保存·设为封面」等仍按 h32）。
                    用户 2026-10-15 拍板：条内「删除」也升到 h36（画布 `2:660` 只记录圆角 10、
                    未记录高度，按「条内按钮等高」处理）→ 走 `.btn-danger-lg`。 */}
                <button
                  className="btn-solid-lg"
                  disabled={crossKind}
                  title={crossKind ? '选中项跨大类，不能批量指派分类' : '给选中资产指派分类'}
                  onClick={() => openCategoryPicker(selectedIds)}
                >
                  <IconTag width={13} height={13} />
                  指派分类
                </button>
                <button
                  className="btn-solid-lg"
                  title="批量重命名（命名模板 + 预览；只改文件夹名，不改包里的文件）"
                  onClick={() => openRenameDialog(selectedIds)}
                >
                  重命名…
                </button>
                <button className="btn-danger-lg" onClick={() => requestDelete(selectedIds)}>
                  <IconTrash width={13} height={13} />
                  删除
                </button>
              </>
            )}
            <button
              className="px-1 text-[12px] text-secondary transition hover:text-primary"
              onClick={() => select(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {menu && <AssetContextMenu x={menu.x} y={menu.y} ids={menu.ids} onClose={() => setMenu(null)} />}
      {/* 空白处右键（所有视图共用；文件视图内部另有一份，见 FolderFileList） */}
      {emptyAreaMenu}
      {purgeIds && <PurgeConfirmDialog ids={purgeIds} onClose={() => setPurgeIds(null)} />}
    </div>
  )
}
