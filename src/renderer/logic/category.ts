/**
 * 分类 UI 的**纯逻辑**（T07）——不 import React / DOM / window.modvault，可在 vitest 直接单测。
 *
 * 覆盖：三级树的计数与排序（未分类哨兵恒排最后且不隐藏）、重名二级节点识别、
 * 级联选项来源、风格筛选选项、遗留布局迁移的渲染层计划（与 `main/layout.ts`
 * `planLayoutMigration` 同规则镜像——main 侧不可 import，规则必须保持一致）。
 */
import type { Asset, AssetKind, LayoutMove } from '../../shared/types'
import {
  UNCLASSIFIED,
  CHANNEL_LEVEL1,
  CAD_LEVEL2_MAP,
  MERGED_MATERIAL_LEVEL1,
  level2Of,
  styleListOf,
  styleListAll
} from '../../shared/taxonomy'
import { composeRelFolder } from '../../shared/naming'
import { kindFolder } from '../../shared/classify'
import { isModelKind } from '../../shared/modelFormat'
import { pathSepFor } from './assetPath'

/** 资产的两级分类（v3 之前的老数据可能缺字段 → 哨兵兜底，全链路不读 undefined） */
export function categoriesOf(a: Asset): { category1: string; category2: string } {
  return { category1: a.category1 || UNCLASSIFIED, category2: a.category2 || UNCLASSIFIED }
}

/**
 * 是否「待补分类」：一级**或**二级仍为未分类（半归类资产也算）。
 *
 * ## 这是中栏头「· 待补 N」的唯一判据源（docs/25「未分类三口径」② 号，已按语义统一）
 *
 * 与 `triageFlow.ts::isUnclassified`（`&&` 双未分类、全库、不套筛选）**刻意不同**：
 * 产品意图是「当前这批里还有多少要补分类」，半归类资产（`'椅子' / '未分类'`）当然要算，
 * 所以 `docs/25:2088-2089` 明确写了「不该改判据，只该改文案」。本函数就是那个不改的判据，
 * 抽成纯函数只为可单测 + 让 `App.tsx` 不再内联写一套。
 *
 * **入参范围由调用方决定**：`App.tsx` 传 `useVisibleAssets()` 的结果（套当前筛选：
 * 搜索词 / 大类 / 分类 / 体积 / 时间 / 分辨率 / 色标…），所以它量的集合与左栏分类树
 * `countLevel1`（`activeAssets`，只滤软删）**本就没有可比性**，见 docs/25:2068-2072。
 *
 * 零 React / 零 DOM，可直接进 vitest。
 *
 * @param asset 单条资产；`null` / `undefined` 视为「不用补」（防御老数据 / 空槽）
 */
export function isCategoryIncomplete(asset: Asset | null | undefined): boolean {
  if (!asset) return false
  const c = categoriesOf(asset)
  return c.category1 === UNCLASSIFIED || c.category2 === UNCLASSIFIED
}

/** relFolder 的段数（posix 分隔） */
export function relSegmentCount(relFolder: string | undefined): number {
  return (relFolder ?? '').split('/').filter((s) => s.length > 0).length
}

/** 规范布局 = 恰好 4 段 `<大类>/<一级>/<二级>/<资产名>` */
export function isNormalLayout(a: Pick<Asset, 'relFolder'>): boolean {
  return relSegmentCount(a.relFolder) === 4
}

/**
 * 遗留布局判定（**与 `main/layout.ts:planLayoutMigration` 同规则**）：
 * `relFolder` 段数 ≠ 4 即遗留；folder/name 缺失的记录无法搬运，同样不算可迁移（skip）。
 */
export function isLegacyLayout(a: Pick<Asset, 'id' | 'folder' | 'relFolder' | 'kind' | 'name'>): boolean {
  if (!a.folder || !a.name) return false
  if (!kindFolder(a.kind)) return false
  return relSegmentCount(a.relFolder) !== 4
}

/**
 * 渲染层迁移计划（镜像 main 的纯计算，用于「显示 plan → 确认 → apply」与启动自动迁移）。
 * main 侧会用自己的 planLayoutMigration 重新计算——两边规则一致，结果必然相同。
 */
export function planLegacyMoves(assets: Asset[], libraryDir: string): LayoutMove[] {
  const sep = pathSepFor(libraryDir)
  const moves: LayoutMove[] = []
  for (const a of assets) {
    if (!isLegacyLayout(a)) continue
    const kindName = kindFolder(a.kind)
    moves.push({
      id: a.id,
      from: a.folder,
      to: `${libraryDir}${sep}${kindName}${sep}${UNCLASSIFIED}${sep}${UNCLASSIFIED}${sep}${a.name}`,
      relFolder: composeRelFolder(kindName, UNCLASSIFIED, UNCLASSIFIED, a.name)
    })
  }
  return moves
}

/**
 * 计数/去重可作用的大类范围：单个 kind，或一组 kind。
 *
 * 2026-10 材质大类合并后，侧栏「材质」节点下 `texture` 与 `material` 共用一棵一级/二级树，
 * 计数必须是**两类之和**（docs/14 §2.4 / QA Q5）。把范围收成一个参数，
 * 避免在组件里写两遍 `countLevel1(a) + countLevel1(b)` 再手工合并节点。
 */
export type KindScope = AssetKind | readonly AssetKind[]

/** 范围归一化（单值 → 单元素集） */
function kindSetOf(scope: KindScope): ReadonlySet<AssetKind> {
  return typeof scope === 'string' ? new Set([scope]) : new Set(scope)
}

export interface CategoryNodeCount {
  value: string
  count: number
}

function sortNodes(nodes: CategoryNodeCount[]): CategoryNodeCount[] {
  // v1.0.3 正式规则（06 §11.2）：侧栏对**计数为 0 的分类不显示节点**——含「未分类」哨兵
  //（有资产时它仍恒排最后）。CategoryPicker 不走这里，不受影响。
  const shown = nodes.filter((n) => n.count > 0)
  const classified = shown
    .filter((n) => n.value !== UNCLASSIFIED)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))
  const un = shown.find((n) => n.value === UNCLASSIFIED)
  return un ? [...classified, un] : classified
}

/**
 * 某（组）大类下的一级分类计数（count 降序、未分类恒最后）。
 *
 * ## 口径注释（docs/25「未分类三口径」① 号，已按语义统一后保留判据）
 *
 * - **「未分类」节点 = 一级未分类**：本函数按 `category1` **分组计数**（半归类资产
 *   `'椅子' / '未分类'` 计入「椅子」节点，不进「未分类」节点）。它**不是**「双未分类总量」
 *   （那是 `triageFlow.ts::isUnclassified` 的判据）；改成双未分类会破坏整棵分类树——
 *   各一级节点之和不再等于总数，也没法解释「一个资产同时出现在两个一级节点下」。
 * - 与 `isUnclassified` 的差异**只发生在「一级未分类、二级有值」这种非法数据上**：
 *   本函数按 `category1` 把它计入「未分类」节点，而 `&&` 不算它。
 *   `normalizeCategoryPair` 的级联降级（06 §9.2 规则 3：一级未指派 ⇒ 二级强制降为未分类）
 *   已保证这种数据不产生，所以合法数据下两者集合一致。
 * - **侧栏点击该节点用的筛选条件同为 `category1 = 未分类`，两者同源**（判据层面）：
 *   `Sidebar.tsx` 的 `setFilter({ category1: 未分类, category2: null, ... })` 经
 *   `matchesFilters` 落到同一条 `category1 !== f.category1 → return false`，
 *   `category2: null` 不参与约束，所以不会有「数字按 `&&`、点进去按 `category1`」的
 *   口径错配（docs/25:2086-2087 那条担心的「数字 100、点进去 180 条」）。
 *   ⚠️ 范围上不严格相等：数字取 `activeAssets`（只滤软删、不套筛选），点进去的网格
 *   取 `useVisibleAssets()`（套当前全部筛选，且 `setFilter` 是 patch merge 不清其它维度）；
 *   带其它筛选时条数可能更少 —— 这是所有一级节点共有的既有产品行为，非本函数判据所致，
 *   详见 docs/25 本条目的「本批落地记录」第 4 点。
 * - 与中栏头「· 待补 N」（`isCategoryIncomplete`，`||` 且套当前筛选）**不同源**，
 *   但已改名不再共用一个词，见本文件 `isCategoryIncomplete` 与 docs/25 三口径条目。
 */
export function countLevel1(assets: Asset[], kind: KindScope): CategoryNodeCount[] {
  const kinds = kindSetOf(kind)
  const m = new Map<string, number>()
  for (const a of assets) {
    if (!kinds.has(a.kind)) continue
    const { category1 } = categoriesOf(a)
    m.set(category1, (m.get(category1) ?? 0) + 1)
  }
  return sortNodes([...m.entries()].map(([value, count]) => ({ value, count })))
}

/** 某（组）大类某一级下的二级分类计数（count 降序、未分类恒最后） */
export function countLevel2(assets: Asset[], kind: KindScope, category1: string): CategoryNodeCount[] {
  const kinds = kindSetOf(kind)
  const m = new Map<string, number>()
  for (const a of assets) {
    if (!kinds.has(a.kind)) continue
    const { category1: c1, category2 } = categoriesOf(a)
    if (c1 !== category1) continue
    m.set(category2, (m.get(category2) ?? 0) + 1)
  }
  return sortNodes([...m.entries()].map(([value, count]) => ({ value, count })))
}

/**
 * 同一（组）大类内出现于多个一级分类下的重名二级集合（06 v1.0.2 §15-④ 实测 8 组重名）。
 * 侧栏对这些节点按「一级/二级」完整路径展示，避免用户混淆——两个同名节点不会互相覆盖。
 */
export function duplicatedLevel2Names(assets: Asset[], kind: KindScope): Set<string> {
  const kinds = kindSetOf(kind)
  const owners = new Map<string, Set<string>>()
  for (const a of assets) {
    if (!kinds.has(a.kind)) continue
    const { category1, category2 } = categoriesOf(a)
    if (category2 === UNCLASSIFIED) continue
    const set = owners.get(category2) ?? new Set<string>()
    set.add(category1)
    owners.set(category2, set)
  }
  const dup = new Set<string>()
  for (const [name, set] of owners) if (set.size > 1) dup.add(name)
  return dup
}

/** CategoryPicker 的一级选项来源：模型用 SU 分册；**贴图与材质预设共用并集 33 项**
 * （两者落同一个「材质」目录，词表必须同源，否则"贴图能选、材质选不到"）。
 * 源数据仍是 `CHANNEL_LEVEL1`（`MERGED_MATERIAL_LEVEL1` 由 `TEXTURE_LEVEL1_LIST` ∪
 * `MATERIAL_LEVEL1_LIST` 派生，见 docs/14 §2.2），禁止从 `LEVEL2_MAP` 的 keys 推导。
 * CAD 同样从 `CHANNEL_LEVEL1.cad` 取册（10 项），**不**从 `CAD_LEVEL2_MAP` 的 keys 推导
 * ——后者是二级表，键的齐全与否受词条抄录进度影响，不能当一级词表用。
 * HDR 从 `CHANNEL_LEVEL1.hdri` 取册（5 项，站方 hdrtietu 频道页照抄）。
 * `other` 无词表 → [] → UI 自由输入。 */
export function level1OptionsFor(kind: AssetKind): readonly string[] {
  if (kind === 'texture' || kind === 'material') return MERGED_MATERIAL_LEVEL1
  // ⚠️ `isModelKind` 而**不是** `kind === 'model'`（2026-11-09 修）：
  // D5A 是「模型的一种格式」（`shared/modelFormat.ts` 的 `MODEL_KIND_MEMBERS`），
  // 它的分类必须跟模型共用同一套一级词表。写成裸 `=== 'model'` 时 `.d5a` 资产
  // 在整理浮层 / 详情面板里一级下拉只剩下「未分类」，用户根本没法给它分类 ——
  // 这是真机上被用户当场抓到的缺陷，不是理论风险。
  if (isModelKind(kind)) return CHANNEL_LEVEL1.model
  if (kind === 'cad') return CHANNEL_LEVEL1.cad
  if (kind === 'hdri') return CHANNEL_LEVEL1.hdri
  return []
}

/**
 * 选定一级后二级的可选项：
 * - `[]` → 一级是「未分类」，二级强制未分类（禁用输入）；
 * - `null` → 无级联词表（如材质预设），UI 渲染为「可自由输入」（06 §3.3-②）；
 * - 其余 → 受控枚举（仍允许不在表内的值吗？——选择器只出枚举，自由值走自由输入路径）。
 *
 * `kind` 可选（老调用点不传 → 行为**逐字节不变**，仍只查 `LEVEL2_MAP`）。
 * CAD 的二级住独立表 `CAD_LEVEL2_MAP`（不进 `LEVEL2_MAP`，理由见 taxonomy.ts 该表注释：
 * 97 个二级里 28 个与 SU 重名，并进去会让 `autoClassify` 跨频道污染），
 * 所以 CAD 必须**按 kind 显式换表**，否则一级（如「平立面系统图」）在 `LEVEL2_MAP` 里查不到
 * → 返回 null → UI 把受控枚举错渲染成「可自由输入」。
 */
export function level2OptionsFor(category1: string, kind?: AssetKind): readonly string[] | null {
  if (!category1 || category1 === UNCLASSIFIED) return []
  const list = kind === 'cad' ? (CAD_LEVEL2_MAP[category1] ?? []) : level2Of(category1)
  return list.length > 0 ? list : null
}

/** 风格筛选选项：model/texture 用各自的册，kind=all 用并集；其余大类无词表 → [] */
export function styleOptionsFor(kind: AssetKind | 'all'): readonly string[] {
  // 顺序要紧：`'all'` 不是 `AssetKind`，必须先挡掉，`isModelKind` 只吃 AssetKind。
  if (kind === 'all') return styleListAll()
  // D5A 归模型域 ⇒ 吃模型那一册风格。裸 `=== 'model'` 会让 .d5a 资产的
  // 「风格」多选区整个消失（不是空的，是连控件都不出）。
  if (isModelKind(kind)) return styleListOf('model')
  if (kind === 'texture') return styleListOf(kind)
  return []
}

/** 批量选中项是否跨大类（跨大类禁用批量指派：父目录永远由 asset.kind 算，03 §5.3） */
export function isCrossKind(assets: Asset[], ids: string[]): boolean {
  const kinds = new Set<AssetKind>()
  for (const a of assets) {
    if (ids.includes(a.id)) kinds.add(a.kind)
    if (kinds.size > 1) return true
  }
  return kinds.size > 1
}
