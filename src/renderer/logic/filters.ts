/**
 * 渲染层的**纯逻辑**：过滤 / 排序 / 搜索 haystack / SU 版本计数。
 *
 * 抽成独立模块（不 import React / DOM / window.modvault）的原因：
 * vitest 跑在 node 环境（tsconfig.node.json 不带 DOM lib），组件本身测不了，
 * 纯函数抽出来才能进 `tests/` 覆盖（与 `src/shared/**` 同样的思路，只是归属渲染层）。
 */
import type {
  Asset,
  AssetKind,
  ColorTag,
  ResolutionBucket as SharedResolutionBucket,
  SavedView
} from '../../shared/types'
import { COLOR_TAGS, COLOR_TAG_LABEL } from '../../shared/types'
import { formatDate } from '../../shared/format'
import { getModelFormat, MODEL_FORMAT_BADGE_LABEL, type ModelFormat } from '../../shared/modelFormat'
import {
  KIND_FOLDER,
  KIND_LABEL,
  MATERIAL_GROUP,
  capsOfFilter,
  kindFilterLabel,
  kindsOfFilter,
  type KindFilter,
  type KindGroup
} from '../../shared/classify'
import { categoriesOf } from './category'
import { isDeletedAsset } from './trashView'

/**
 * 中栏当前视图（C 线「最近删除」）：
 * - `'assets'`：正常资产视图，**排除**软删记录（`deletedAt` 有值）；
 * - `'trash'`：最近删除视图，**只含**软删记录。
 *
 * ⚠️ 软删过滤的**唯一**落点是 `matchesFilters` —— 组件里不要再手写一遍
 * `assets.filter(a => !a.deletedAt)`，否则「网格排除了、计数没排除」这类错位必然出现。
 */
export type LibraryView = 'assets' | 'trash'

/**
 * 大类筛选维度：**唯一定义在 `shared/classify`**（`AssetKind | 'materialGroup' | 'all'`）。
 * 这里只转发类型，**不要**再写一份 `AssetKind | 'all'`——
 * 那会让 `kind: 'materialGroup'` 在渲染层被当成非法值（docs/14 §2.4 / §11-9）。
 */
export type { KindFilter } from '../../shared/classify'
export type SortKey = 'recent' | 'name' | 'size' | 'su'

/**
 * 分辨率档位（**渲染层口径**，4 档）。
 *
 * 为什么不直接改 `shared/types.ts` 的 `ResolutionBucket`：本文件的改动边界不含 shared
 * （另一端在并发修改），所以在这里做**向上扩展**——`'2k' | '4k'` 仍是合法子集，
 * 类型上完全兼容；`Filters.minResolution` 用本类型。
 *
 * 4 档的由来：HDR 全景按**宽度**归档，用户库里 33 个 HDR 有 26 个是 16384×8192，
 * 只给 2K/4K 永远分不开（全都命中 4K），必须补 8K / 16K。
 */
export type ResolutionBucket = SharedResolutionBucket | '8k' | '16k'

/** 排序选项（走查 v0.2.2：排序控件从顶栏移到中栏头，见画布 `2:83` / 深 `2:361`）。
 * 放在纯逻辑层：中栏头与测试共用，避免组件里重复定义。 */
export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: '按导入时间' },
  { value: 'name', label: '按名称' },
  { value: 'size', label: '按大小' },
  { value: 'su', label: '按 SU 版本' }
]

export interface Filters {
  kind: KindFilter
  tag: string | null
  source: string | null
  /** P0-15：按 SU 版本筛选（值为 `suVersion` 原文，如 'SU 2024'）；null = 不筛 */
  suVersion: string | null
  /** T07：一级 / 二级分类筛选（值为目录名原文；null = 不筛） */
  category1: string | null
  category2: string | null
  /** T07：风格多选（受控词表）。语义：风格维度内 OR、与其他维度 AND（06 §4.4-②） */
  styles: string[]
  /**
   * v0.4 收藏筛选：true = 只看 `favorite === true` 的资产。
   * 这是**属性筛选**（不是视图切换），切大类 / 点「全部」的语义见 Sidebar 注释。
   */
  favoriteOnly: boolean
  /**
   * v0.4 色标筛选：空数组 = 不限；非空 = 命中其中任一色标即出（维度内 OR）。
   * `colorTag === null`（未标记）**不会**被任何色标命中。
   */
  colorTags: ColorTag[]
  /**
   * v0.4 体积区间（字节）：`null` = 该端不限。
   * 两端都 null = 不启用；**min > max 的非法区间也视为不启用**（不能把库筛成空，
   * 见 `activeSizeRange` —— 这是最容易踩的坑）。
   */
  minBytes: number | null
  maxBytes: number | null
  /**
   * v0.4 导入时间区间（毫秒时间戳，**含等号**）：`null` = 该端不限。
   * 非法区间（after > before）同样视为不启用。
   */
  importedAfter: number | null
  importedBefore: number | null
  /**
   * 0.6.0 分辨率档：`null` = 不限；`'2k'` = 长边 ≥ 2048；`'4k'` = 4096；
   * `'8k'` = 8192；`'16k'` = 16384（后两档只给 HDR 视图，见 `resolutionOptionsFor`）。
   *
   * 判定口径是「该资产**任一图片文件**的长边达标」，且**未知尺寸的资产不进这些档**
   * （旧索引没有 `AssetFile.w/h` → 需要一次重扫才补齐，见 `assetLongEdge`）。
   *
   * ⚠️ 这个值**并非在所有视图里都合法**：模型 / 其他视图没有分辨率维度 →
   * 切过去必须被 `sanitizeFiltersForKind` 清掉，否则网格空着而用户找不到原因。
   */
  minResolution: ResolutionBucket | null
  /**
   * 模型格式（2026-10「3DMAX 支持」）：`null` = 不限；`'skp'` / `'max'` 单选。
   *
   * 判定是**纯函数派生**（`shared/modelFormat.getModelFormat`，按资产文件扩展名），
   * 不落库、不迁移。语义是「只对 kind=model 的资产生效」：非模型资产不受此条件约束
   * （在「全部」视图筛 3DMAX，贴图 / HDR 照常显示）。
   *
   * ⚠️ 只在模型视图开放（能力表 `KIND_FILTER_CAPS.modelFormat`）→
   * 切到材质 / HDR / 其他视图时被 `sanitizeFiltersForKind` 清掉。
   */
  modelFormat: ModelFormat | null
  query: string
  sort: SortKey
}

export const DEFAULT_FILTERS: Filters = {
  kind: 'all',
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
  modelFormat: null,
  query: '',
  sort: 'recent'
}

/**
 * 评分规范化（v0.4）：**四舍五入取整 + 夹紧到 0–5**。
 *
 * - `-1 → 0`（越界下沿）
 * - `7 → 5`（越界上沿）
 * - `3.6 → 4`（四舍五入；`Math.round(3.5) = 4`）
 * - `NaN / Infinity / 非数字 → 0`
 *
 * 0 的语义是「未评分」，所以清空评分就是传 0。
 */
export function normalizeRating(value: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(5, Math.max(0, Math.round(n)))
}

/** 色标多选切换（纯函数，不修改入参）：已在集合里 → 移除，否则追加 */
export function toggleColorTag(list: readonly ColorTag[], tag: ColorTag): ColorTag[] {
  return list.includes(tag) ? list.filter((x) => x !== tag) : [...list, tag]
}

// ── v0.4 数值筛选（体积 / 导入时间） ────────────────────────────────
//
// 设计要点：**非法区间一律视为「不启用」，绝不筛成空**。
// 用户拖滑块 / 手改数据都可能造出 min > max 的瞬间状态，此时把整个库清空是
// 最糟的反馈（看起来像"资产全没了"）。两端 null、或区间非法 → 该维度不参与过滤。

const MB = 1024 * 1024
const DAY_MS = 86_400_000

/** 体积预设（侧栏三个 chip +「不限」）：只设下界，上界恒为 null */
export const SIZE_PRESET_BYTES: readonly number[] = [10 * MB, 50 * MB, 200 * MB]

/** 把字节数压成短标签（`50MB` / `1.5GB`），供 chip 与条件摘要共用 */
export function compactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')
  return `${text}${units[i]}`
}

/** 预设 chip 文案：`> 10MB` / `> 50MB` / `> 200MB` */
export function sizePresetLabel(bytes: number): string {
  return `> ${compactBytes(bytes)}`
}

/** 当前体积条件命中的预设（字节数）；未命中 / 自定义区间 → null */
export function sizePresetOf(f: Filters): number | null {
  if (f.maxBytes !== null || f.minBytes === null) return null
  return SIZE_PRESET_BYTES.includes(f.minBytes) ? f.minBytes : null
}

/** 命中的体积区间（含端点）；null = 该维度不启用（两端都空 / 非法 / 非有限数） */
export function activeSizeRange(f: Filters): { min: number; max: number } | null {
  const min = typeof f.minBytes === 'number' && Number.isFinite(f.minBytes) ? f.minBytes : null
  const max = typeof f.maxBytes === 'number' && Number.isFinite(f.maxBytes) ? f.maxBytes : null
  if (min === null && max === null) return null
  // 非法区间 → 不启用（关键：不是筛成空）
  if (min !== null && max !== null && min > max) return null
  return {
    min: min === null ? 0 : Math.max(0, min),
    max: max === null ? Number.POSITIVE_INFINITY : Math.max(0, max)
  }
}

/** 命中的导入时间区间（含端点）；null = 不启用 */
export function activeImportedRange(f: Filters): { after: number; before: number } | null {
  const after =
    typeof f.importedAfter === 'number' && Number.isFinite(f.importedAfter) ? f.importedAfter : null
  const before =
    typeof f.importedBefore === 'number' && Number.isFinite(f.importedBefore)
      ? f.importedBefore
      : null
  if (after === null && before === null) return null
  if (after !== null && before !== null && after > before) return null
  return {
    after: after === null ? Number.NEGATIVE_INFINITY : after,
    before: before === null ? Number.POSITIVE_INFINITY : before
  }
}

/** 时间预设键（侧栏四个 chip 里除「不限」外三个） */
export type TimePresetKey = '7d' | '30d' | 'year'

export const TIME_PRESET_LABEL: Record<TimePresetKey, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  year: '今年'
}

/** 本地时区的「今年 1 月 1 日 00:00」（"今年" 预设的边界，与日历一致而非 365 天） */
export function startOfYear(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0).getTime()
}

/**
 * 时间预设 → 过滤值（点击那一刻的快照）。
 * 只设 `importedAfter`；`importedBefore` 恒为 null（"从现在往前 N 天"）。
 */
export function timePresetRange(
  key: TimePresetKey,
  now: number = Date.now()
): { importedAfter: number; importedBefore: null } {
  if (key === 'year') return { importedAfter: startOfYear(now), importedBefore: null }
  const days = key === '7d' ? 7 : 30
  return { importedAfter: now - days * DAY_MS, importedBefore: null }
}

/**
 * 反向识别当前时间条件命中的预设（侧栏 chip 高亮用）。
 *
 * ⚠️ 过滤里存的是**点击时的绝对时间戳**，而预设是相对的 → 用「相差几天」反推：
 * 先判是否恰为「今年 1 月 1 日」，再按 ±1 天容差归到最近的 7 天 / 30 天档。
 * 容差存在的理由：应用开着跨过午夜时，7 天前的那条边界会变成 7.4 天，
 * 不该因此让 chip 失去高亮。识别不出来（自定义区间 / 只设 before）→ null。
 */
export function timePresetOf(
  f: Filters,
  now: number = Date.now()
): TimePresetKey | null {
  const after = f.importedAfter
  if (after === null || f.importedBefore !== null) return null
  if (after === startOfYear(now)) return 'year'
  const days = (now - after) / DAY_MS
  if (Math.abs(days - 7) <= 1) return '7d'
  if (Math.abs(days - 30) <= 1) return '30d'
  return null
}

// ── 0.6.0 分辨率筛选（按图片长边归档；HDR 按全景宽度） ──────────────
//
// 口径：**该资产任一图片文件的长边**达标即命中；未知尺寸（旧索引 / 非 PNG-JPEG）
// 一律不进这些档 —— 宁可漏掉，也不让「猜出来的分辨率」污染筛选结果。
//
// 档位**按视图分表**（用户反馈：材质与 HDR 界面的分辨率都失效）：
// - 材质族 / 全部：2K / 4K —— 贴图长边就是它的真实规格，2K/4K 是行业惯例；
// - HDR：4K / 8K / 16K —— 全景按**宽度**归档，用户库里绝大多数是 16384×8192，
//   用 2K/4K 永远分不开（33 个里 26 个都落 4K 档），必须换档。

/** 档位 → 长边阈值（像素）。4 档全表；具体视图开放哪几档见 `resolutionBucketValuesFor` */
export const RESOLUTION_LONG_EDGE: Record<ResolutionBucket, number> = {
  '2k': 2048,
  '4k': 4096,
  '8k': 8192,
  '16k': 16384
}

/** 档位文案（中栏头 chip 浮层 / 空态维度摘要共用同一份，避免两套字） */
export const RESOLUTION_LABEL: Record<ResolutionBucket, string> = {
  '2k': '2K 以上',
  '4k': '4K 以上',
  '8k': '8K 以上',
  '16k': '16K 以上'
}

/**
 * 该视图**开放**哪些档位（不含「不限」）。
 *
 * - HDR：4K / 8K / 16K（全景宽度）；
 * - 其余（材质族 / 全部 / 模型 / 其他）：2K / 4K（保持 0.6.0 现状）。
 *   模型 / 其他视图根本不会渲染入口（`capsOfFilter` 为 false），这里返回材质那套
 *   只是为了让函数**全值域可用**，不给调用方留 `undefined` 分支。
 */
export function resolutionBucketValuesFor(kind: KindFilter): readonly ResolutionBucket[] {
  if (kind === 'hdri') return ['4k', '8k', '16k']
  return ['2k', '4k']
}

/**
 * 中栏头「分辨率」浮层的选项表（与 `SIZE_QUICK_OPTIONS` 完全同构：单选 + 「不限」）。
 * **按视图分表**——材质族给 2K/4K，HDR 给 4K/8K/16K。
 * 放在纯逻辑层：组件只做渲染，测试直接断言取值。
 */
export function resolutionOptionsFor(
  kind: KindFilter
): { label: string; value: ResolutionBucket | null }[] {
  return [
    { label: '不限', value: null },
    ...resolutionBucketValuesFor(kind).map((value) => ({ label: RESOLUTION_LABEL[value], value }))
  ]
}

/**
 * 兼容别名：历史上组件直接用这张表（全局一份）。
 * 现在**委托**给 `resolutionOptionsFor('all')`，避免两套字 / 两处漂移。
 */
export const RESOLUTION_QUICK_OPTIONS: { label: string; value: ResolutionBucket | null }[] =
  resolutionOptionsFor('all')

/**
 * 浮层标题 / chip 文案按视图分口径：
 * 材质族看「贴图长边」，HDR 看「全景宽度」——写错会误导用户以为筛的是同一件事。
 */
export function resolutionPanelTitle(kind: KindFilter): string {
  return kind === 'hdri' ? '分辨率（全景宽度）' : '分辨率（贴图长边）'
}

/** 分辨率 chip 的 `title`（悬停说明）。 */
export function resolutionChipTitle(kind: KindFilter): string {
  return kind === 'hdri'
    ? '按全景宽度筛选（≥ 4096 / ≥ 8192 / ≥ 16384；尺寸未知的资产不进这些档）'
    : '按贴图分辨率筛选（长边 ≥ 2048 / ≥ 4096；尺寸未知的资产不进这两档）'
}

/** 档位 → 阈值；`null`（不限）/ 非法值 → null（= 该维度不参与过滤） */
export function resolutionMinEdge(bucket: ResolutionBucket | null | undefined): number | null {
  if (!bucket) return null
  const edge = RESOLUTION_LONG_EDGE[bucket]
  return typeof edge === 'number' ? edge : null
}

/**
 * 资产的**长边**像素（取所有已知尺寸图片文件的最大值）；无任何已知尺寸 → `null`。
 *
 * `AssetFile.w/h` 是 0.6.0 才有的可选字段：旧索引的资产这里恒为 `null`，
 * 因此「2K / 4K」两档对旧资产**不生效**，需要一次重扫（`rescan` 会补采）后才正确。
 */
export function assetLongEdge(a: Asset): number | null {
  let best: number | null = null
  for (const file of a.files ?? []) {
    const w = file.w
    const h = file.h
    if (typeof w !== 'number' || typeof h !== 'number') continue
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue
    const edge = Math.max(w, h)
    if (best === null || edge > best) best = edge
  }
  return best
}

/** 分辨率条件是否命中（`null` 档 = 不限 = 恒命中） */
export function matchesResolution(a: Asset, bucket: ResolutionBucket | null): boolean {
  const minEdge = resolutionMinEdge(bucket)
  if (minEdge === null) return true
  const edge = assetLongEdge(a)
  return edge !== null && edge >= minEdge
}

/**
 * 切大类后的**筛选值归一化**（纯函数、不修改入参、总是返回新对象）。
 *
 * 为什么必须有：入口消失 ≠ 条件失效。此前的真实隐患是「材质里选了 4K → 切到模型视图，
 * 分辨率按钮消失但 `minResolution` 仍生效」——网格空着，用户找不到原因（用户所说的
 * "类似逻辑错误"）。同理从材质切 HDR 会残留 `'2k'`，而 HDR 表里没有这一档。
 *
 * 三条规则（全部走能力表 / 档位表，禁止硬编码大类）：
 * ① 该视图不支持分辨率（`capsOfFilter(kind,'resolution') === false`）→ `minResolution = null`；
 * ② 该视图不支持风格 → `styles = []`；
 * ③ 支持分辨率但当前档位不在该视图的档位表里（如 HDR 的 `'2k'`）→ 归 null。
 *
 * 调用点只有两处：`store.setFilter`（且仅在 `patch.kind` 存在时）与
 * `filtersFromSavedView`（存量视图可能存着非法组合）。
 * 注意 `filtersFromSavedView` 之后还叠了一层 `normalizeFiltersForAllView`
 * （「全部」视图独有的三个无入口维度），两者分工见该函数的注释。
 */
export function sanitizeFiltersForKind(f: Filters): Filters {
  const next: Filters = { ...f }
  if (!capsOfFilter(f.kind, 'resolution')) {
    next.minResolution = null
  } else if (
    next.minResolution !== null &&
    !resolutionBucketValuesFor(f.kind).includes(next.minResolution)
  ) {
    next.minResolution = null
  }
  if (!capsOfFilter(f.kind, 'style')) next.styles = []
  // 模型格式维度与分辨率同一套机制：入口消失（材质 / HDR / 其他视图）→ 值清掉，
  // 否则「切到材质视图后网格里模型少了」且用户找不到原因。
  if (!capsOfFilter(f.kind, 'modelFormat')) next.modelFormat = null
  return next
}

/**
 * 「全部」视图专属的归一化：把在该视图**没有入口**的那三个维度清成 null。
 *
 * 与 `sanitizeFiltersForKind` 的区别（**不要合并成一个函数**）：
 * - `sanitizeFiltersForKind` 判据是能力表（`capsOfFilter`），而能力表里 `'all' = 并集`
 *   → 在「全部」视图它一个维度都不清。那是**故意**的：手头这个 filters 在
 *   「模型 → 全部 → 模型」来回切时不能丢格式选择（切走时由模型视图自己保留语义）。
 * - 本函数只服务**「这个状态要落成快照 / 要从快照恢复」**这类"持久化边界"：
 *   快照一旦落盘，就必须是**自洽**的 —— 不能在「全部」里存一个只有模型视图才
 *   看得见入口的筛选条件，否则恢复后用户既看不到、也取消不掉。
 *
 * 三个维度从哪来：`HIDDEN_IN_ALL_VIEW_KEYS`（本文件已有，
 * 内容是 `['size','resolution','modelFormat']`），但它们映射到 `Filters` 的
 * 具体字段是 `minBytes`/`maxBytes`、`minResolution`、`modelFormat`。
 * ⚠️ 不要直接复用 `hiddenActiveFilterLabels` 的返回（那是给 UI 的文案数组）。
 */
export function normalizeFiltersForAllView(f: Filters): Filters {
  if (f.kind !== 'all') return f
  return {
    ...f,
    minBytes: null,
    maxBytes: null,
    minResolution: null,
    modelFormat: null
  }
}

/**
 * 风格 → 资产数（一个资产可挂多个风格，各组分头计）。
 *
 * 口径：只统计**传入的这批资产**（`App` 传当前大类视图内的集合），软删记录不计；
 * 排序为数量降序，同数按名称（zh-CN）升序。
 *
 * ⚠️ 必须是"当前大类视图内"而不是全库：风格入口只在模型/全部视图渲染，
 * 若拿全库统计，材质视图会出现风格 chip、点进去必然 0 条（本次修的就是这个）。
 */
export function styleCountsFor(assets: readonly Asset[]): [string, number][] {
  const m = new Map<string, number>()
  for (const a of assets) {
    if (isDeletedAsset(a)) continue
    for (const s of a.styles ?? []) m.set(s, (m.get(s) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
}

/** 体积条件的文字描述；不启用返回 null */
function describeSize(f: Filters): string | null {
  const range = activeSizeRange(f)
  if (!range) return null
  const hasMin = typeof f.minBytes === 'number' && Number.isFinite(f.minBytes)
  const hasMax = typeof f.maxBytes === 'number' && Number.isFinite(f.maxBytes)
  if (hasMin && hasMax) return `${compactBytes(range.min)}–${compactBytes(range.max)}`
  if (hasMin) return `> ${compactBytes(range.min)}`
  return `< ${compactBytes(range.max)}`
}

/** 时间条件的文字描述；不启用返回 null */
function describeImported(f: Filters, now: number): string | null {
  const range = activeImportedRange(f)
  if (!range) return null
  const hasAfter = typeof f.importedAfter === 'number' && Number.isFinite(f.importedAfter)
  const hasBefore = typeof f.importedBefore === 'number' && Number.isFinite(f.importedBefore)
  if (hasAfter && hasBefore) return `${formatDate(range.after)} ~ ${formatDate(range.before)}`
  if (hasBefore) return `${formatDate(range.before)} 之前`
  // 只有下界：优先说人话（近 N 天 / 今年），否则落到具体日期
  const preset = timePresetOf(f, now)
  if (preset === 'year') return TIME_PRESET_LABEL.year
  if (preset === '7d' || preset === '30d') return TIME_PRESET_LABEL[preset]
  return `${formatDate(range.after)} 之后`
}

/**
 * 中栏头 / 空态用的数值条件摘要：`> 50MB · 近 30 天`。
 * 返回**不含前导分隔符**的纯文本（调用方自己决定 `· ` 前缀）；无生效条件 → `''`。
 */
export function describeNumericFilters(f: Filters, now: number = Date.now()): string {
  return [describeSize(f), describeImported(f, now)].filter((s): s is string => Boolean(s)).join(' · ')
}

/**
 * 资产的 SU major 版本号（排序 / 计数用）。
 * 优先 `suMajor`（导入时解析落库）；兜底从 `suVersion` 标签尾巴取数字；都没有返回 -1。
 */
export function suMajorOf(a: Asset): number {
  if (typeof a.suMajor === 'number' && Number.isFinite(a.suMajor) && a.suMajor > 0) return a.suMajor
  const m = /(\d{1,4})\s*$/.exec(a.suVersion ?? '')
  return m ? Number(m[1]) : -1
}

/**
 * 搜索 haystack：名称 + 标签 + 备注 + 来源 + **SU 版本**（P0-15）+ 大类显示名 +
 * **大类目录名**（2026-10 材质合并：搜「材质」要同时命中贴图与材质预设）+ 风格。
 * 统一小写，调用方用 `includes` 匹配。
 */
export function searchHaystack(a: Asset): string {
  return [
    a.name,
    a.tags.join(' '),
    a.note,
    a.source,
    a.suVersion ?? '',
    KIND_LABEL[a.kind],
    KIND_FOLDER[a.kind],
    (a.styles ?? []).join(' ')
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * 单条资产是否命中过滤条件（query 需先归一化，见 `applyFilters`）。
 *
 * `view` 决定软删记录的归属，且**在其它所有维度之前判定**：
 * - `'assets'`：`deletedAt` 有值 → 直接 false（正常视图看不到已删资产）；
 * - `'trash'`：`deletedAt` 无值 → 直接 false；其余维度（分类 / 风格 / 收藏 / 体积 / 时间）
 *   **一律忽略**，只保留搜索词。
 *
 * 为什么回收站视图忽略其它筛选维度：侧栏在 trash 模式下把那些入口灰置了
 * （状态不清空，回资产视图继续生效）。若这里仍套用旧的分类筛选，用户会看到
 * 「回收站里有 5 个，但界面一个都不显示」——比"筛选不生效"更迷惑。
 */
export function matchesFilters(
  a: Asset,
  f: Filters,
  normalizedQuery?: string,
  view: LibraryView = 'assets'
): boolean {
  const deleted = isDeletedAsset(a)
  const q = normalizedQuery ?? f.query.trim().toLowerCase()
  if (view === 'trash') {
    if (!deleted) return false
    return q.length === 0 || searchHaystack(a).includes(q)
  }
  if (deleted) return false
  // 大类维度：唯一语义入口是 `kindsOfFilter`（null = 不筛）。
  // ⚠️ 不要写 `if (kind === 'texture' || kind === 'material')`——将来再加合并会漏（docs/14 §2.4）。
  const kinds = kindsOfFilter(f.kind)
  if (kinds && !kinds.has(a.kind)) return false
  if (f.tag && !a.tags.includes(f.tag)) return false
  if (f.source && a.source !== f.source) return false
  if (f.suVersion && a.suVersion !== f.suVersion) return false
  const { category1, category2 } = categoriesOf(a)
  if (f.category1 && category1 !== f.category1) return false
  if (f.category2 && category2 !== f.category2) return false
  // 风格维度内 OR：命中任一选中风格即出（06 §4.4-②）
  if (f.styles.length > 0) {
    const styles = a.styles ?? []
    if (!f.styles.some((s) => styles.includes(s))) return false
  }
  // v0.4 收藏：只留 favorite === true（老记录缺字段时按 false 处理）
  if (f.favoriteOnly && a.favorite !== true) return false
  // v0.4 色标：维度内 OR；未标记（null）不匹配任何色标
  if (f.colorTags.length > 0 && (a.colorTag == null || !f.colorTags.includes(a.colorTag))) {
    return false
  }
  // v0.4 体积区间（两端含等号）。`activeSizeRange` 已把「两端都空 / 非法区间」归一成 null
  // → 这里 null 表示该维度不参与过滤，绝不会把库筛成空。
  const sizeRange = activeSizeRange(f)
  if (sizeRange) {
    const size = Number.isFinite(a.size) ? a.size : 0
    if (size < sizeRange.min || size > sizeRange.max) return false
  }
  // 0.6.0 分辨率：任一图片文件长边达标即出；未知尺寸不进这两档（见 matchesResolution）
  if (!matchesResolution(a, f.minResolution)) return false
  // 模型格式（2026-10）：**只约束 kind=model 的资产**——非模型资产不受影响
  //（「全部」视图筛 3DMAX，贴图 / HDR 照常显示）。格式由文件扩展名纯函数派生。
  if (f.modelFormat && a.kind === 'model' && getModelFormat(a.files) !== f.modelFormat) {
    return false
  }
  // v0.4 导入时间区间（**含等号**：正好等于阈值的资产要被命中）
  const importedRange = activeImportedRange(f)
  if (importedRange) {
    const at = Number.isFinite(a.importedAt) ? a.importedAt : 0
    if (at < importedRange.after || at > importedRange.before) return false
  }
  if (q && !searchHaystack(a).includes(q)) return false
  return true
}

/** 排序（不修改入参）：recent=最近导入 / name=中文名 / size=大小降序 / su=SU 版本新→旧 */
export function sortAssets(list: Asset[], sort: SortKey): Asset[] {
  const out = [...list]
  switch (sort) {
    case 'name':
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      break
    case 'size':
      out.sort((a, b) => b.size - a.size)
      break
    case 'su':
      out.sort(
        (a, b) => suMajorOf(b) - suMajorOf(a) || a.name.localeCompare(b.name, 'zh-CN')
      )
      break
    case 'recent':
    default:
      out.sort((a, b) => b.importedAt - a.importedAt)
      break
  }
  return out
}

/**
 * 过滤 + 排序（`useVisibleAssets` 的纯函数内核）。
 *
 * `view` 默认 `'assets'`（老调用方的行为 = 只排除软删记录，其余完全不变）。
 * 回收站视图的排序特例：`sort: 'recent'` 按**删除时间**倒序（最近删的在最上面），
 * 其余档位仍按用户选的键（名称 / 大小 / SU 版本）——「按导入时间」对回收站没有意义。
 */
export function applyFilters(
  assets: Asset[],
  f: Filters,
  view: LibraryView = 'assets'
): Asset[] {
  const q = f.query.trim().toLowerCase()
  const filtered = assets.filter((a) => matchesFilters(a, f, q, view))
  if (view === 'trash' && f.sort === 'recent') {
    return filtered.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  }
  return sortAssets(filtered, f.sort)
}

/**
 * 当前**真正参与过滤**的筛选维度（2026-10 用户反馈第 5 条：筛选结果为 0 时，
 * 空结果提示要列出「当前生效的筛选维度」）。
 * 纯逻辑、可单测；组件只负责渲染，维度提取规则全部收在这里。
 */
export interface ActiveFilterDimension {
  key:
    | 'kind'
    | 'category1'
    | 'category2'
    | 'styles'
    | 'tag'
    | 'source'
    | 'suVersion'
    | 'favorite'
    | 'colorTags'
    | 'size'
    | 'importedAt'
    | 'resolution'
    | 'modelFormat'
    | 'query'
  /** UI 展示用的中文维度名 */
  label: string
  /** 当前生效值（styles 为多选，用「、」拼接） */
  value: string
}

const DIMENSION_LABEL: Record<ActiveFilterDimension['key'], string> = {
  kind: '大类',
  category1: '一级分类',
  category2: '二级分类',
  styles: '风格',
  tag: '标签',
  source: '来源',
  suVersion: 'SU 版本',
  favorite: '收藏',
  colorTags: '色标',
  size: '体积',
  importedAt: '导入时间',
  resolution: '分辨率',
  modelFormat: '模型格式',
  query: '搜索词'
}

/** 按固定顺序返回生效维度；空维度（null / 空串 / 空数组 / false）不出现 */
export function activeFilterDimensions(f: Filters): ActiveFilterDimension[] {
  const out: ActiveFilterDimension[] = []
  const push = (key: ActiveFilterDimension['key'], value: string) =>
    out.push({ key, label: DIMENSION_LABEL[key], value })
  if (f.kind !== 'all') push('kind', kindFilterLabel(f.kind))
  if (f.category1) push('category1', f.category1)
  if (f.category2) push('category2', f.category2)
  if (f.styles.length > 0) push('styles', f.styles.join('、'))
  if (f.favoriteOnly) push('favorite', '仅收藏')
  if (f.colorTags.length > 0) {
    push('colorTags', f.colorTags.map((t) => COLOR_TAG_LABEL[t]).join('、'))
  }
  // v0.4 数值维度：文案与中栏头摘要**同源**（describeNumericFilters 的两个内部函数），
  // 避免"空态说 > 50MB、头部说 > 50.0 MB"这种两套文案
  const sizeText = describeSize(f)
  if (sizeText) push('size', sizeText)
  const timeText = describeImported(f, Date.now())
  if (timeText) push('importedAt', timeText)
  if (f.minResolution) push('resolution', RESOLUTION_LABEL[f.minResolution])
  if (f.modelFormat) push('modelFormat', MODEL_FORMAT_BADGE_LABEL[f.modelFormat])
  if (f.tag) push('tag', f.tag)
  if (f.source) push('source', f.source)
  if (f.suVersion) push('suVersion', f.suVersion)
  const q = f.query.trim()
  if (q) push('query', q)
  return out
}

/**
 * 「全部」视图的高亮判定：除 `kind`（视图本身）与 `query`（搜索框自显、看得见）外，
 * 没有任何筛选维度生效。
 *
 * 为什么必须收敛成一个函数（而不是组件里手写 `&&` 链）：
 * 2026-10-30 用户实测报「在模型里选了格式=SU，切到「全部」看不到 SU 模型」——
 * 根因是「全部」按钮的清理列表与高亮判定各自手写了 13 个 `&&` / 字段，
 * 0.9.0 加 `hideInAllView`（体积/分辨率/格式在全部视图不渲染入口）后两处**都漏了**
 * `minResolution` 与 `modelFormat`：筛选隐形生效、左栏却显示成"无筛选"。
 * 收敛到 `activeFilterDimensions`（那里已把每个维度都列全、且处理了
 * "非法区间视为不启用"这类边界）→ 将来加维度只需改那一处。
 *
 * `query` 为什么不参与：它是搜索框里**自己看得见**的状态，不需要靠左栏高亮提示。
 */
export function isAllViewActive(f: Filters): boolean {
  return activeFilterDimensions(f).every((d) => d.key === 'kind' || d.key === 'query')
}

/**
 * 「全部」与「重复资产」两个入口共用的筛选重置 patch。
 *
 * 与 `clearFilterPatch` 的两点区别（**故意不合并**）：
 * - **保留 `query`**：点「全部」就清空搜索框会让用户困惑（搜索框自己可见，不需要靠它复位）；
 * - **`kind` 强制 `'all'`**：这两个入口都是"回到全库"。
 *
 * ⚠️ 逐项列全（不是 `{ ...DEFAULT_FILTERS }`）：将来给 `Filters` 加字段时，
 * 这里会**立刻编译报错**，不会静默漏清一个维度。这正是本 bug 的成因。
 */
export function allViewFilterPatch(): Partial<Filters> {
  return {
    kind: 'all',
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
    modelFormat: null
  }
}

/**
 * 「全部」视图下**被隐藏但仍在生效**的筛选维度名（空数组 = 没有隐形筛选）。
 *
 * 供中栏头的兜底提示使用 —— 这三个维度在「全部」视图不渲染入口（`hideInAllView`），
 * 不提示的话用户看不到、也取消不掉（2026-10-30 用户实测报的死角）。
 *
 * 文案与中栏头 chip 的文字保持一致（模型的 `modelFormat` 在 chip 上叫「格式」），
 * 其余维度名复用 `DIMENSION_LABEL`，不另写一套。
 */
const HIDDEN_DIMENSION_LABEL: Partial<Record<ActiveFilterDimension['key'], string>> = {
  modelFormat: '格式'
}

/** 在「全部」视图被隐藏入口的那三个维度（顺序 = 中栏头 chip 的排列顺序） */
const HIDDEN_IN_ALL_VIEW_KEYS: ReadonlyArray<ActiveFilterDimension['key']> = [
  'size',
  'resolution',
  'modelFormat'
]

export function hiddenActiveFilterLabels(f: Filters): string[] {
  const active = new Set(activeFilterDimensions(f).map((d) => d.key))
  return HIDDEN_IN_ALL_VIEW_KEYS.filter((key) => active.has(key)).map(
    (key) => HIDDEN_DIMENSION_LABEL[key] ?? DIMENSION_LABEL[key]
  )
}

/**
 * 侧栏大类点击的展开语义（用户反馈第 5 条 · 缺陷 2）：首次点击即展开，再点该大类 = 折叠。
 * 纯函数放这里（组件只做渲染、可单测）。要点是 `openKind` 只能有一个状态源：此前它从
 * `filters.category1` 反推，于是「显式折叠」与「筛选回退」互相打架——二级筛选在时点大类
 * 会把已展开的树意外收起，用户实测表现为「必须再点一次才展开」。
 *
 * 2026-10 材质合并：`clicked` 现在也接受分组哨兵 `materialGroup`（「材质」节点一个 key，
 * 两个 kind 共用一棵一级/二级树）。
 */
export function nextExpandKind(
  expanded: boolean,
  clicked: AssetKind | KindGroup
): AssetKind | KindGroup | null {
  return expanded ? null : clicked
}

export interface SuVersionCount {
  /** `suVersion` 原文，如 'SU 2024' */
  version: string
  count: number
  /** 该组的代表性 major（排序用） */
  major: number
}

/** 按 `suVersion` 分组计数，降序（侧栏「SU 版本」分组用）；无版本号的资产不参与 */
export function countSuVersions(assets: Asset[]): SuVersionCount[] {
  const m = new Map<string, { count: number; major: number }>()
  for (const a of assets) {
    const v = a.suVersion?.trim()
    if (!v) continue
    const cur = m.get(v)
    if (cur) cur.count += 1
    else m.set(v, { count: 1, major: suMajorOf(a) })
  }
  return [...m.entries()]
    .map(([version, x]) => ({ version, count: x.count, major: x.major }))
    .sort(
      (a, b) =>
        b.count - a.count || b.major - a.major || a.version.localeCompare(b.version, 'zh-CN')
    )
}

// ── 0.6.0 智能集合（保存的筛选视图）：快照 / 还原 ─────────────────────
//
// `SavedView.filters` 在 shared 里是 `Record<string, unknown>`（shared 不能反向依赖
// renderer），所以**校验与补齐只在这一层做**：
// - 写入：`snapshotFilters` 逐键挑纯数据（绝不含函数 / 派生字段）；
// - 读取：`filtersFromSavedView` 以 `DEFAULT_FILTERS` 为底，只接受类型正确的值，
//   未知键与非法值一律丢弃。
//
// 「以 DEFAULT_FILTERS 为底」是套用的关键：直接合并到**当前** filters 上会让上一个
// 视图的条件残留（用户点了 A 再点 B，明明 B 没筛分类却还在分类里）。

/** 合法的大类筛选值（单个 kind / 分组哨兵 / 全部） */
const VALID_KIND_FILTERS: ReadonlySet<string> = new Set<string>([
  'all',
  MATERIAL_GROUP,
  ...Object.keys(KIND_LABEL)
])

/** 合法的排序值（与 `SORT_OPTIONS` 同源，避免两处漂移） */
const VALID_SORTS: ReadonlySet<string> = new Set<string>(SORT_OPTIONS.map((o) => o.value))

/** 合法分辨率档（与阈值表同源：加档只改 `RESOLUTION_LONG_EDGE` 一处） */
const VALID_RESOLUTIONS: ReadonlySet<string> = new Set<string>(
  Object.keys(RESOLUTION_LONG_EDGE)
)

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 非空字符串 → 原值（去首尾空白）；其它 → null */
function nullableText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** 有限数字 → 原值；其它 → null（NaN / Infinity / 字符串一律丢弃） */
function nullableFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 字符串数组 → 去空白 / 去空项 / 去重；非数组 → 空数组 */
function textList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const t = item.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 色标数组 → 只保留合法色标；非数组 → 空数组 */
function colorTagList(v: unknown): ColorTag[] {
  if (!Array.isArray(v)) return []
  const out: ColorTag[] = []
  for (const item of v) {
    if (typeof item === 'string' && (COLOR_TAGS as readonly string[]).includes(item)) {
      const tag = item as ColorTag
      if (!out.includes(tag)) out.push(tag)
    }
  }
  return out
}

/**
 * 当前筛选 → **纯数据快照**（写进 `SavedView.filters`）。
 *
 * 逐键显式挑选，而不是 `{ ...filters }`：将来给 `Filters` 加函数型 / 派生字段时，
 * 这里不会静默把不可序列化的东西写进 settings.json。
 */
export function snapshotFilters(f: Filters): Record<string, unknown> {
  // 「全部」视图下这三个维度没有入口（App.tsx 的 hideInAllView）→ 快照里**不许**存它们的值，
  // 否则套用时恢复出一个"看起来没筛、实际在筛"的状态（2026-10-30 用户实测的同类死角）。
  const n = normalizeFiltersForAllView(f)
  return {
    kind: n.kind,
    tag: n.tag,
    source: n.source,
    suVersion: n.suVersion,
    category1: n.category1,
    category2: n.category2,
    styles: [...n.styles],
    favoriteOnly: n.favoriteOnly,
    colorTags: [...n.colorTags],
    minBytes: n.minBytes,
    maxBytes: n.maxBytes,
    importedAfter: n.importedAfter,
    importedBefore: n.importedBefore,
    minResolution: n.minResolution,
    modelFormat: n.modelFormat,
    query: n.query,
    sort: n.sort
  }
}

/**
 * 保存的视图 → 完整 `Filters`（**以 `DEFAULT_FILTERS` 为底**，缺失键补默认、非法值丢弃）。
 *
 * `view.sort` 优先于快照里的 `sort`（前者是 SavedView 的一等字段，兼容旧档）。
 * 这样「套用视图」= 一次性替换整组筛选条件，不会残留上一个视图的任何维度。
 */
export function filtersFromSavedView(
  view: Pick<SavedView, 'filters'> & { sort?: string }
): Filters {
  const raw: Record<string, unknown> = isPlainRecord(view.filters) ? view.filters : {}
  const next: Filters = { ...DEFAULT_FILTERS }

  if (typeof raw.kind === 'string' && VALID_KIND_FILTERS.has(raw.kind)) {
    next.kind = raw.kind as KindFilter
  }
  next.tag = nullableText(raw.tag)
  next.source = nullableText(raw.source)
  next.suVersion = nullableText(raw.suVersion)
  next.category1 = nullableText(raw.category1)
  next.category2 = nullableText(raw.category2)
  next.styles = textList(raw.styles)
  next.favoriteOnly = raw.favoriteOnly === true
  next.colorTags = colorTagList(raw.colorTags)
  next.minBytes = nullableFiniteNumber(raw.minBytes)
  next.maxBytes = nullableFiniteNumber(raw.maxBytes)
  next.importedAfter = nullableFiniteNumber(raw.importedAfter)
  next.importedBefore = nullableFiniteNumber(raw.importedBefore)
  next.minResolution =
    typeof raw.minResolution === 'string' && VALID_RESOLUTIONS.has(raw.minResolution)
      ? (raw.minResolution as ResolutionBucket)
      : null
  next.modelFormat =
    raw.modelFormat === 'skp' || raw.modelFormat === 'max' ? raw.modelFormat : null
  next.query = typeof raw.query === 'string' ? raw.query : ''
  // 排序：`SavedView.sort` 优先；它非法时退回快照里的 sort；都不合法才用默认
  if (typeof view.sort === 'string' && VALID_SORTS.has(view.sort)) {
    next.sort = view.sort as SortKey
  } else if (typeof raw.sort === 'string' && VALID_SORTS.has(raw.sort)) {
    next.sort = raw.sort as SortKey
  }
  // 存量视图可能存着「大类 + 该大类不支持的维度」这种非法组合
  // （例如 `kind: 'hdri' + minResolution: '2k'`：HDR 表里没有 2K 档）→ 套用即归一化
  // 两道归一化，顺序不能反：
  // ① `sanitizeFiltersForKind`：清掉"该大类不支持该维度"（如 hdri + '2k' 档不存在）；
  // ② `normalizeFiltersForAllView`：清掉"kind='all' 但维度没有入口"的存量脏档
  //    （老版本存下的快照、手工改过的 settings.json 都可能有）。
  return normalizeFiltersForAllView(sanitizeFiltersForKind(next))
}
