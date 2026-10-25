/**
 * 重复资产检测的**纯逻辑**（v0.4）。
 *
 * 口径（产品拍板）：
 * - 分组键见 `keyOf()`：**有知末 ID 就按 ID**（`zhimo:<id>`），否则沿用 `dedupeKey`；
 *   **不比较文件内容**（库内可能有 GB 级文件，读内容不现实）；
 * - 组内按 `importedAt` 升序：最早导入的那份视为「原件」，其余为「多余份」；
 * - 组间按 `wastedBytes` 降序：浪费空间最多的排最前，用户先处理收益最大的；
 * - 同一 key 但体积差异 > 30% → `sizeMismatch = true`。仍算一组（名字确实相同），
 *   但 UI 必须提示「可能不是同一套资产，删之前先确认」——误删大体积原件的代价很高。
 *
 * 抽成独立模块（不 import React / DOM / window.modvault）的原因与 `filters.ts` 相同：
 * vitest 跑 node 环境，组件测不了，纯函数才能进 `tests/` 覆盖。
 */
import type { Asset } from '../../shared/types'
import { baseNameOf, dedupeKeyOf, displayName } from '../../shared/naming'
import { formatBytes, formatDate } from '../../shared/format'

/** 体积差异阈值：最大体积比最小体积大 30% 以上视为「可疑同名」（0.3 = 30%） */
export const SIZE_MISMATCH_RATIO = 0.3

/**
 * 参与重复判定的记录 = **还活着**的记录。
 *
 * ⚠️ P0（2026-10 用户报「保留这份」把本体也删了）：回收站里的记录仍然留在
 * `store.assets` 里（软删只写 `deletedAt`，见 store 的删除链路）。若把软删记录也算进
 * 重复组，用户在「最近删除」页打开一条记录时，它会把**唯一还活着的同 key 资产**
 * 当成"重复副本"，点「保留这份」→ `requestDelete(活的那些)` → 把本体推进回收站。
 *
 * 因此所有对外的组/副本/份数计算**必须先过这一层**。`0` 视为活着（时间戳不会是 0）。
 */
function liveOnly(assets: Asset[]): Asset[] {
  return assets.filter((a) => !!a && !a.deletedAt)
}

export interface DupGroup {
  /** 分组键：`zhimo:<知末ID>`（有 ID 时）或资产的 `dedupeKey` */
  key: string
  /** 至少 2 个，按 `importedAt` 升序（第一个是「原件」） */
  assets: Asset[]
  /** 组内全部资产的体积和 */
  totalBytes: number
  /** 除保留份（第一份）之外的体积和 = 删掉多余份能省下的空间 */
  wastedBytes: number
  /** 组内体积差异 > 30%：名字相同但很可能不是同一套资产，UI 必须二次提示 */
  sizeMismatch: boolean
}

/**
 * 单条资产的重复键。
 *
 * ## 0.6.3 起：有知末 ID 就按 ID 分组（用户 2026-10 反馈的误删风险）
 *
 * 旧口径只按名字分组 → 知末的包「外面文件夹同名、ID 后缀不同」会被并成同组
 * 「重复副本」，用户一点「清理多余份」就可能删掉**不同商品**的原件。
 * 新口径：
 *
 * ```
 * 有 zhimoId → `zhimo:<zhimoId>`      // 同 ID 才可能真重复；ID 不同绝不同组
 * 否则       → 现有 dedupeKeyOf(...)  // 一字未改，无 ID 的老资产行为完全不变
 * ```
 *
 * 三种组合的结果（安全优先）：
 * - 两个 ID 不同 → **绝不同组**（即使名字一字不差）；
 * - 两个 ID 相同 → 同组（真重复）；
 * - 一个有一个没有 → **不同组**（不敢判 —— 键前缀 `zhimo:` 与 `<kind>:` 天然不同）。
 *
 * 副作用（预期，不是回归）：「重复资产」的数量会**变少** —— 之前被误并的不同商品
 * 不再算重复。`.zhimoId` 由 importer / rescan 写入，老记录由 store 启动时幂等回填。
 *
 * `dedupeKey` 缺失 / 为空时（极老数据 / 外部导入的裸记录）仍用
 * `baseNameOf(name) + kind` 现场推导，保证分组永远有键可用。
 */
function keyOf(a: Asset): string {
  const zhimoId = typeof a.zhimoId === 'string' ? a.zhimoId.trim() : ''
  if (zhimoId) return `zhimo:${zhimoId}`
  const key = typeof a.dedupeKey === 'string' ? a.dedupeKey.trim() : ''
  if (key) return key
  return dedupeKeyOf(baseNameOf(a.name ?? ''), String(a.kind ?? 'other'))
}

/** 组内体积是否差异过大（相对较小的一份） */
function hasSizeMismatch(list: Asset[]): boolean {
  if (list.length < 2) return false
  const sizes = list.map((a) => (Number.isFinite(a.size) ? Math.max(0, a.size) : 0))
  const min = Math.min(...sizes)
  const max = Math.max(...sizes)
  if (max === 0) return false
  // 最小为 0（空壳资产）但有非 0 的 → 视为差异巨大
  if (min === 0) return true
  return (max - min) / min > SIZE_MISMATCH_RATIO
}

/**
 * 把资产按 `dedupeKey` 分组，只返回**重复组**（成员 > 1）。
 *
 * 输出顺序：`wastedBytes` 降序；相等时按 key 字典序（结果稳定，便于测试与 UI 不跳动）。
 * 不修改入参（内部复制数组后排序）。
 */
export function groupDuplicates(assets: Asset[]): DupGroup[] {
  const byKey = new Map<string, Asset[]>()
  // P0：软删（回收站）里的记录不参与分组
  for (const a of liveOnly(assets)) {
    if (typeof a.id !== 'string') continue
    const key = keyOf(a)
    const list = byKey.get(key)
    if (list) list.push(a)
    else byKey.set(key, [a])
  }

  const groups: DupGroup[] = []
  for (const [key, list] of byKey) {
    if (list.length < 2) continue
    // 组内：最早导入的是原件；同一毫秒导入时按 id 兜底，保证顺序稳定
    const sorted = [...list].sort(
      (a, b) => (a.importedAt ?? 0) - (b.importedAt ?? 0) || a.id.localeCompare(b.id)
    )
    const sizes = sorted.map((a) => (Number.isFinite(a.size) ? Math.max(0, a.size) : 0))
    const totalBytes = sizes.reduce((s, n) => s + n, 0)
    const wastedBytes = sizes.slice(1).reduce((s, n) => s + n, 0)
    groups.push({
      key,
      assets: sorted,
      totalBytes,
      wastedBytes,
      sizeMismatch: hasSizeMismatch(sorted)
    })
  }

  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || a.key.localeCompare(b.key))
  return groups
}

/**
 * 某资产的**其它副本**（不含自己）。空数组 = 该资产没有重复。
 * 用于卡片角标（`×N` 里 N = 返回值长度 + 1）与详情面板的「重复副本」区。
 *
 * P0：只在**活着**的记录之间成立。自己已软删 → 直接返回 `[]`（回收站里的记录
 * 绝不能反向把活着的资产认成"副本"）。
 */
export function duplicatesOf(assets: Asset[], id: string): Asset[] {
  const live = liveOnly(assets)
  const self = live.find((a) => a.id === id)
  if (!self) return []
  const key = keyOf(self)
  return live.filter((a) => a.id !== id && keyOf(a) === key)
}

/** 某资产所属的重复组；不在重复组里返回 null（详情面板取 `sizeMismatch` 用） */
export function groupOf(assets: Asset[], id: string): DupGroup | null {
  const live = liveOnly(assets)
  const self = live.find((a) => a.id === id)
  if (!self) return null
  const key = keyOf(self)
  const group = groupDuplicates(live).find((g) => g.key === key)
  return group ?? null
}

/**
 * 「保留这一份，其余移入回收站」的**删除目标 id**（P0 修复的核心）。
 *
 * 安全口径（每条都对应一次真实事故/回归）：
 * - `keepId` 自己**不在**结果里（不能删掉要保留的那份）；
 * - 只取 `keyOf` 相同的活着的记录（不误伤别的资产）；
 * - 软删记录全部排除（不重复入回收站、也不把回收站条目当副本）；
 * - `keepId` 已软删 / 不存在 → **返回空数组**：回收站视图里调用它什么也不会发生。
 */
export function keepOnlyTargets(assets: Asset[], keepId: string): string[] {
  const live = liveOnly(assets)
  const keep = live.find((a) => a.id === keepId)
  if (!keep) return []
  const key = keyOf(keep)
  return live.filter((a) => a.id !== keepId && keyOf(a) === key).map((a) => a.id)
}

/**
 * `assetId → 该组份数（含自己）`。份数 1 的资产不放进 Map（卡片不显示角标）。
 * 网格一次算好复用，避免每张卡片各扫一遍全库。
 * 软删记录不参与（`groupDuplicates` 已过滤）→ 回收站条目不会带 `×N` 角标。
 */
export function duplicateCountMap(assets: Asset[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const g of groupDuplicates(assets)) {
    for (const a of g.assets) map.set(a.id, g.assets.length)
  }
  return map
}

/**
 * 「多余份数」总数 = Σ(组内份数 − 1)。侧栏「重复资产」徽标用这个数，
 * **不是组数**（用户关心的是「有多少份可以清掉」）。
 */
export function extraCopyCount(groups: DupGroup[]): number {
  return groups.reduce((sum, g) => sum + Math.max(0, g.assets.length - 1), 0)
}

/** 组的展示名：取原件名剥掉自动序号（`椅子-2` → `椅子`），空则退回原件名 */
export function groupLabel(group: DupGroup): string {
  const first = group.assets[0]
  if (!first) return group.key
  // 显示名：先剥自动序号（`椅子-2` → `椅子`），再剥知末 ID 尾巴（只影响显示）
  return displayName(baseNameOf(first.name)) || first.name || group.key
}

// ── 并排对比（用户 2026-10 反馈：「只列一行路径不够直观，看不出差异就敢点删」）──

/** 对比表的一行：一个字段在每列上的展示值 + 是否存在差异 */
export interface CompareField {
  key: string
  label: string
  /** 与传入列一一对应的展示值（空串 = 该列没有这个值） */
  values: string[]
  /** 各列值不完全相同 → UI 用强调色标出来 */
  differs: boolean
}

/** 分类展示成 `一级 / 二级`（缺省按「未分类」，与 UI 口径一致） */
function categoryText(a: Asset): string {
  const c1 = a.category1 ?? '未分类'
  const c2 = a.category2 ?? '未分类'
  return `${c1} / ${c2}`
}

/**
 * 逐字段并排对比（纯函数，供 `DuplicateCompareDialog` 渲染）。
 *
 * 字段顺序固定：显示名 / 相对路径 / 体积 / 文件数 / 导入时间 / 分类 / SU 版本。
 * `differs` 用**原始展示值集合**判断（`['SU 2024', '']` 也算不同 —— 一份有版本一份没有
 * 正是用户需要看见的差异）。"有才显示"的字段（SU 版本）由调用方按 `values` 是否全空过滤。
 */
export function compareFields(assets: Asset[]): CompareField[] {
  const defs: { key: string; label: string; get: (a: Asset) => string }[] = [
    { key: 'name', label: '显示名', get: (a) => displayName(a.name) || a.name },
    { key: 'relFolder', label: '相对路径', get: (a) => a.relFolder },
    { key: 'size', label: '体积', get: (a) => formatBytes(a.size) },
    { key: 'files', label: '文件数', get: (a) => `${a.files.length}` },
    { key: 'importedAt', label: '导入时间', get: (a) => formatDate(a.importedAt) },
    { key: 'category', label: '分类', get: categoryText },
    { key: 'suVersion', label: 'SU 版本', get: (a) => a.suVersion?.trim() ?? '' }
  ]
  return defs.map((d) => {
    const values = assets.map(d.get)
    return {
      key: d.key,
      label: d.label,
      values,
      differs: new Set(values).size > 1
    }
  })
}
