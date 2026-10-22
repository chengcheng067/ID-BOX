/**
 * 右键菜单的**纯逻辑**（菜单项构成 / 可用性判定 / 出屏夹取）。
 *
 * 为什么抽出来：三层菜单（资产卡片 / 文件行 / 空白处）里真正需要推敲的是
 * 「某项该不该出现、该不该灰、点了做什么」，组件只该负责"画出来 + 调回调"。
 * 放到这里还有一个硬收益：**能在 node 环境单测**（`tests/contextMenu.test.ts`），
 * 组件本身测不了（vitest 跑 node，没有 DOM）。
 *
 * ⚠️ 纪律：本模块**不 import store / React / DOM / electron**。
 * 所有副作用一律以回调参数（`AssetMenuActions` 等）注入 ——
 * 这样同一份菜单逻辑可以被单测、也可以被将来的其它入口复用。
 */
import type { Asset } from '../../shared/types'
import { duplicatesOf } from './duplicates'
import { activeFilterDimensions, type Filters } from './filters'
import { effectiveMaterialSlots } from './materialBall'

/* ────────────────────────────────────────────────────────────────────────────
 * 菜单项的数据结构
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 菜单项：
 * - 对象 = 一个可点的条目；
 * - `'separator'` = 分隔线（分组用）。
 *
 * `icon` 是 **SVG path 的 d 属性**（单个或多个），不是组件：
 * 纯逻辑里不能出现 JSX。渲染时由 `ContextMenu` 统一套 14×14 / 1.8 描边那一层
 * （与侧栏、卡片星标同一套线性风格），所以这里只给几何、不给颜色。
 */
export type ContextMenuItem =
  | {
      label: string
      icon?: string | readonly string[]
      danger?: boolean
      disabled?: boolean
      onClick: () => void
    }
  | 'separator'

/** 语义别名：菜单就是一组 item（含分隔线） */
export type ContextMenuEntry = ContextMenuItem

/** 判定"是不是条目"（不是分隔线） */
export function isMenuItem(entry: ContextMenuItem): entry is Exclude<ContextMenuItem, 'separator'> {
  return entry !== 'separator'
}

/* ────────────────────────────────────────────────────────────────────────────
 * 图标几何（24×24 网格；MenuIcon 负责 14px / 1.8 描边 / text-tertiary）
 * ──────────────────────────────────────────────────────────────────────────── */

export const MENU_ICON = {
  folder:
    'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z',
  eye: [
    'M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12z',
    'M12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z'
  ],
  image: [
    'M4.5 5.2h15a1.3 1.3 0 011.3 1.3v11a1.3 1.3 0 01-1.3 1.3h-15a1.3 1.3 0 01-1.3-1.3v-11A1.3 1.3 0 014.5 5.2z',
    'M8.4 10.2h.01',
    'M20.4 16.2l-4.4-4.4-7.4 7.4'
  ],
  sliders: ['M3.6 8h9.2M17.4 8h3M3.6 16h3.4M11.6 16h8.8', 'M15.6 5.6v4.8M9.8 13.6v4.8'],
  tag: 'M20.6 13.4 12.4 5.2a1.6 1.6 0 0 0-1.1-.5H5.8A1.6 1.6 0 0 0 4.2 6.3v5.5c0 .4.2.8.5 1.1l8.2 8.2a1.6 1.6 0 0 0 2.3 0l5.4-5.4a1.6 1.6 0 0 0 0-2.3zM7.6 8.6h.01',
  star: 'M12 3.4l2.7 5.5 6 .88-4.35 4.24 1.03 5.98L12 17.2l-5.38 2.82 1.03-5.98L3.3 9.78l6-.88z',
  copy: 'M9 9h9.5v9.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V10.5A1.5 1.5 0 0 1 9 9zM6.5 15H5a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V6',
  file: [
    'M14 3.5H7A1.5 1.5 0 005.5 5v14A1.5 1.5 0 007 20.5h10a1.5 1.5 0 001.5-1.5V8z',
    'M13.8 3.5V8h4.5'
  ],
  stack: ['M12 3.6l8 4.2-8 4.2-8-4.2z', 'M4 12.4l8 4.2 8-4.2', 'M4 16.6l8 4.2 8-4.2'],
  trash:
    'M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12.1A1.6 1.6 0 0 0 8.9 20.6h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7',
  refresh: [
    'M20.6 4.6v5h-5',
    'M3.4 19.4v-5h5',
    'M4.2 9.6a8 8 0 0 1 13.2-3l3.2 3M19.8 14.4a8 8 0 0 1-13.2 3l-3.2-3'
  ],
  filterOff: ['M4 5.5h16l-6.4 7.6v5.4l-3.2 2v-7.4z', 'M3.4 3.4l17.2 17.2'],
  external: ['M14 4.5h5.5V10', 'M19.5 4.5L11 13', 'M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10']
} as const

/* ────────────────────────────────────────────────────────────────────────────
 * 通用工具
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 去掉**首 / 尾 / 连续**的分隔线。
 *
 * 为什么必须有：菜单是"按条件往数组里 push"拼出来的（比如「自定义渲染…」只在
 * 材质族出现、「保留这份…」只在真有副本时出现），条件不成立时很容易留下
 * 连续两条或挂在末尾的分隔线 —— 视觉上就是一条莫名其妙的空行。
 * 所有三个 `*MenuItems` 的返回值都过一遍这里，调用方不必自己防。
 */
export function normalizeMenuItems(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = []
  for (const entry of items) {
    if (entry === 'separator') {
      if (out.length === 0) continue // 开头不画
      if (out[out.length - 1] === 'separator') continue // 连续只留一条
      out.push(entry)
      continue
    }
    out.push(entry)
  }
  while (out.length > 0 && out[out.length - 1] === 'separator') out.pop()
  return out
}

/**
 * 菜单在视口内的落点（**按真实宽高夹取**）。
 *
 * 之前的实现把高度写死成 224（"5 项 + 分隔线约 210px"），菜单项变多之后
 * 底部几项会被窗口下沿切掉 —— 用户点不到「删除」。现在由调用方传入**量到的**
 * 实际高度，这里只做夹取，且四周留 `margin`（默认 8），保证贴边时也有呼吸。
 */
export function menuPlacement(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  margin = 8
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportW - width - margin)
  const maxTop = Math.max(margin, viewportH - height - margin)
  return {
    left: Math.max(margin, Math.min(x, maxLeft)),
    top: Math.max(margin, Math.min(y, maxTop))
  }
}

/**
 * 空白处右键的**命中豁免**选择器：落在卡片 / 文件行内 → 不算空白。
 *
 * 放在这里而不是组件里：属性名（`data-asset-card` / `data-file-row`）与选择器
 * 是同一条约定的两半，分散到两个文件必然漂移（改了一边另一边静默失效）。
 */
export const ASSET_CARD_SELECTOR = '[data-asset-card="1"]'
export const FILE_ROW_SELECTOR = '[data-file-row="1"]'
export const MENU_TARGET_SELECTOR = `${ASSET_CARD_SELECTOR},${FILE_ROW_SELECTOR}`

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 资产卡片右键
 * ──────────────────────────────────────────────────────────────────────────── */

export interface AssetMenuActions {
  /** 「进入文件夹」：model / texture / material（应绑 openFolderView） */
  onEnterFolder: () => void
  /** 「预览 HDR」：hdri（应绑 openHdrPreview） */
  onPreviewHdr: () => void
  /** 「打开文件位置」：other 的第一项 **与** 第 8 项共用（应绑 reveal） */
  onReveal: () => void
  /** 「更换封面…」（应打开既有 CoverPicker） */
  onChangeCover: () => void
  /** 「自定义渲染…」（应打开既有 CustomRenderDialog） */
  onCustomRender: () => void
  onAssignCategory: () => void
  /** 传 `true` = 收藏，`false` = 取消收藏（多选时按"还有没收藏的就全收藏"） */
  onToggleFavorite: (next: boolean) => void
  onCopyName: () => void
  onCopyFolderPath: () => void
  /** 「保留这份，其余移入回收站」 */
  onKeepThis: () => void
  onDelete: () => void
}

/** 第一项「打开」的形态（按 kind 变标签与动作） */
export type AssetOpenMode = 'folder' | 'hdr' | 'reveal' | 'multi'

/**
 * 第一项该做什么。
 *
 * - `model` / `texture` / `material` → 进入软件内文件夹视图；
 * - `hdri` → 直接进 HDR 预览（与双击一致：HDR 没有"文件夹里翻文件"的诉求）；
 * - `other` / 未知 → 只能落到系统资源管理器；
 * - 多选 → 没法定"进哪个文件夹"，退回"打开第一个所在文件夹"。
 */
export function assetOpenModeOf(targets: readonly Asset[]): AssetOpenMode {
  if (targets.length !== 1) return 'multi'
  const kind = targets[0]?.kind
  if (kind === 'hdri') return 'hdr'
  if (kind === 'model' || kind === 'texture' || kind === 'material') return 'folder'
  return 'reveal'
}

/**
 * 「自定义渲染…」的可见性：**且** 三个条件
 * ① 单选（弹窗一次只服务一个资产）；
 * ② 材质族（texture / material）—— 模型 / HDRI 没有 PBR 槽位，渲球无意义；
 * ③ 有 baseColor 槽位 —— 与详情面板 `canCustomRender` 同一判据
 *    （`effectiveMaterialSlots(...).albedo`）。没有 albedo 时渲出来是白球，
 *    详情面板也是**不显示**这个按钮的，菜单不能比面板更宽松。
 */
export function canCustomRender(asset: Asset | null | undefined): boolean {
  if (!asset) return false
  if (asset.kind !== 'material' && asset.kind !== 'texture') return false
  return Boolean(effectiveMaterialSlots(asset.files ?? []).albedo)
}

/** 菜单里的「N 项」后缀（多选才带） */
function countSuffix(count: number): string {
  return count > 1 ? `（${count} 项）` : ''
}

/**
 * 资产卡片右键菜单（顺序即产品口径，改顺序前先看清每一段的分隔线归属）。
 *
 * `assets` 是**全库**（判重需要组内其它成员），`ids` 是本次作用集合
 * （命中项已多选 → 整个多选集；否则只有该项，与 `AssetGrid.contextMenuIds` 一致）。
 */
export function assetMenuItems(
  assets: readonly Asset[],
  ids: readonly string[],
  actions: AssetMenuActions
): ContextMenuItem[] {
  const idSet = new Set(ids)
  const targets = assets.filter((a) => idSet.has(a.id))
  if (targets.length === 0) return []

  const count = targets.length
  const single = count === 1 ? targets[0] : null
  const allFavorite = targets.every((a) => a.favorite === true)
  // 单选专属动作：多选时「更换封面 / 自定义渲染 / 保留这份 / 复制资产名」都要收窄
  const mode = assetOpenModeOf(targets)
  // 单份资产在重复组里还有别的副本 → 才提供"保留这份"
  const dupCopies = single ? duplicatesOf([...assets], single.id) : []

  const items: ContextMenuItem[] = []

  /* ① 打开（按 kind 变形态） */
  if (mode === 'folder') {
    items.push({ label: '进入文件夹', icon: MENU_ICON.folder, onClick: actions.onEnterFolder })
  } else if (mode === 'hdr') {
    items.push({ label: '预览 HDR', icon: MENU_ICON.eye, onClick: actions.onPreviewHdr })
  } else {
    // `other` 与多选都只能走资源管理器（多选时是"第一个所在文件夹"，沿用旧文案）
    items.push({
      label: mode === 'multi' ? '打开第一个所在文件夹' : '打开文件位置',
      icon: MENU_ICON.folder,
      onClick: actions.onReveal
    })
  }
  /**
   * 第一项已经是「打开文件位置」时，第 8 项不再重复出现。
   * （`other` 单选的 mode 就是 `reveal`、多选也是 reveal —— 同一个动作摆两遍
   * 只会让菜单变长并让人以为有什么不同。）
   */
  const firstIsReveal = mode === 'reveal' || mode === 'multi'

  /* ② 更换封面（单选；多选时灰掉 —— CoverPicker 一次只服务一个资产） */
  items.push({
    label: '更换封面…',
    icon: MENU_ICON.image,
    disabled: single === null,
    onClick: actions.onChangeCover
  })

  /* ③ 自定义渲染（仅材质族且有 baseColor；单选专属） */
  if (canCustomRender(single)) {
    items.push({ label: '自定义渲染…', icon: MENU_ICON.sliders, onClick: actions.onCustomRender })
  }

  items.push('separator')

  /* ④⑤ 分类 / 收藏 */
  items.push({ label: '指派分类…', icon: MENU_ICON.tag, onClick: actions.onAssignCategory })
  items.push({
    label: `${allFavorite ? '取消收藏' : '收藏'}${countSuffix(count)}`,
    icon: MENU_ICON.star,
    onClick: () => actions.onToggleFavorite(!allFavorite)
  })

  items.push('separator')

  /* ⑥⑦⑧ 复制 / 定位 */
  items.push({
    label: '复制资产名',
    icon: MENU_ICON.file,
    // 多选时"复制哪个名字"没有唯一答案 —— 灰掉而不是显示一个会拷错东西的按钮
    disabled: single === null,
    onClick: actions.onCopyName
  })
  items.push({
    label: '复制文件夹路径',
    icon: MENU_ICON.copy,
    onClick: actions.onCopyFolderPath
  })
  if (!firstIsReveal) {
    items.push({ label: '打开文件位置', icon: MENU_ICON.folder, onClick: actions.onReveal })
  }

  /* ⑨ 保留这份（单选 + 真有副本） */
  if (single !== null && dupCopies.length > 0) {
    items.push('separator')
    items.push({
      label: '保留这份，其余移入回收站',
      icon: MENU_ICON.stack,
      onClick: actions.onKeepThis
    })
  }

  /* ⑩ 删除（危险项永远最后，且前面一定有分隔线） */
  items.push('separator')
  items.push({
    label: `删除${countSuffix(count)}…`,
    icon: MENU_ICON.trash,
    danger: true,
    onClick: actions.onDelete
  })

  return normalizeMenuItems(items)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 文件行右键（软件内文件夹视图）
 * ──────────────────────────────────────────────────────────────────────────── */

export interface FileMenuActions {
  /** 用系统默认程序打开该文件 */
  onOpen: () => void
  /** 在资源管理器中显示（选中该文件） */
  onReveal: () => void
  /** 设为资产封面 */
  onSetCover: () => void
  onCopyName: () => void
  onCopyPath: () => void
}

/**
 * 「设为封面」允许的扩展名（**白名单，不用 `row.isImage`**）。
 *
 * `IMAGE_EXTS` 里有 gif / svg / heic / avif / ico —— 它们都能"看"，但缩略图管线
 * 只吃 PNG/JPEG 一类的位图（`setCoverImage` 也只认 PNG/JPEG 的 magic bytes）。
 * 让用户在 gif 上点「设为封面」然后拿到一张失败提示，不如一开始就不给这个入口。
 */
export const COVER_SOURCE_EXTS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'tif',
  'tiff'
]

/** 这个扩展名能不能当封面来源（大小写不敏感） */
export function isCoverSourceExt(ext: string): boolean {
  return COVER_SOURCE_EXTS.includes((ext ?? '').toLowerCase())
}

/**
 * 文件行右键菜单。
 *
 * `row` 只取 `ext` 一个字段 —— 这样测试不用造完整的 `FileRow`，调用方传整个
 * `FileRow` 也能结构化匹配（`fileMenuItems(row, actions)`）。
 */
export function fileMenuItems(row: { readonly ext: string }, actions: FileMenuActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: '用默认程序打开', icon: MENU_ICON.external, onClick: actions.onOpen },
    { label: '在资源管理器中显示', icon: MENU_ICON.folder, onClick: actions.onReveal },
    'separator'
  ]
  if (isCoverSourceExt(row.ext)) {
    items.push({ label: '设为封面', icon: MENU_ICON.image, onClick: actions.onSetCover })
    items.push('separator')
  }
  items.push({ label: '复制文件名', icon: MENU_ICON.file, onClick: actions.onCopyName })
  items.push({ label: '复制完整路径', icon: MENU_ICON.copy, onClick: actions.onCopyPath })
  return normalizeMenuItems(items)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 空白处右键
 * ──────────────────────────────────────────────────────────────────────────── */

export interface EmptyMenuActions {
  /** 重新扫描本地库（`forceRescan`） */
  onRefresh: () => void
  /** 复位全部筛选维度（保留排序与当前大类视图） */
  onClearFilters: () => void
}

/**
 * 「有没有可清除的筛选」。
 *
 * **`kind`（大类）不算**：它就是当前视图本身，清了等于把用户从「模型」踢回「全部」，
 * 与「清除筛选不应该动视图」直接冲突。其余维度（分类 / 风格 / 标签 / 来源 / SU 版本 /
 * 收藏 / 色标 / 体积 / 时间 / 分辨率 / 搜索词）任一命中即算。
 *
 * 复用 `activeFilterDimensions` 而不是自己再列一遍条件 —— 那边已经把
 * "非法区间视为不启用"（`activeSizeRange` 等）这类边界想清楚了，重写必然漂移。
 */
export function hasClearableFilters(f: Filters): boolean {
  return activeFilterDimensions(f).some((d) => d.key !== 'kind')
}

/**
 * 「清除筛选」要写的 patch（只重置筛选维度）。
 *
 * - **不动 `sort`**：排序不是筛选，清了会被用户当成"我排的顺序丢了"；
 * - **不动 `kind`**：那是视图（见 `hasClearableFilters`）。
 * 其余键逐项列全（而不是 `{...DEFAULT_FILTERS}`），这样将来给 `Filters` 加字段时
 * 这里会立刻编译报错，不会静默漏清一个维度。
 */
export function clearFilterPatch(f: Filters): Partial<Filters> {
  return {
    kind: f.kind,
    tag: null,
    source: null,
    suVersion: null,
    category1: null,
    category2: null,
    styles: [],
    favoriteOnly: false,
    colorTags: [],
    minBytes: null,
    maxBytes: null,
    importedAfter: null,
    importedBefore: null,
    minResolution: null,
    query: ''
  }
}

/**
 * 空白处菜单：**所有视图**都有「刷新」（用户原话："在所有的界面的空界面右键都增加刷新按钮"）；
 * 「清除筛选」只在真有筛选时出现（否则是一个点了什么都不发生的按钮）。
 */
export function emptyMenuItems(f: Filters, actions: EmptyMenuActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: '刷新', icon: MENU_ICON.refresh, onClick: actions.onRefresh }
  ]
  if (hasClearableFilters(f)) {
    items.push({ label: '清除筛选', icon: MENU_ICON.filterOff, onClick: actions.onClearFilters })
  }
  return normalizeMenuItems(items)
}

/**
 * 刷新完成的 notice 文案（成功 / 被拒分开）。
 *
 * 三种结果都必须**如实**告诉用户：`aborted` 不是"刷新成功但没变"，而是
 * 安全守卫主动中止（库目录选错 / 索引骤减），静默会让用户以为库空了是 bug。
 */
export function rescanNoticeOf(outcome: { aborted: string | null; scanned: number }): string {
  if (outcome.aborted === 'empty-scan') {
    return '已取消刷新：库目录里没有扫描到任何资产（索引未改动，请检查设置里的库目录）'
  }
  if (outcome.aborted === 'mass-delete') {
    return '已取消刷新：本次扫描到的资产数量骤减，可能库目录选错了（索引未改动）'
  }
  return `已刷新：${outcome.scanned} 个资产`
}
