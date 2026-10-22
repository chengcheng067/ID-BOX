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
  MERGED_MATERIAL_LEVEL1,
  CONFIDENCE,
  level2Of,
  styleListOf,
  styleListAll
} from '../../shared/taxonomy'
import { composeRelFolder } from '../../shared/naming'
import { kindFolder } from '../../shared/classify'
import { pathSepFor } from './assetPath'

/** 资产的两级分类（v3 之前的老数据可能缺字段 → 哨兵兜底，全链路不读 undefined） */
export function categoriesOf(a: Asset): { category1: string; category2: string } {
  return { category1: a.category1 || UNCLASSIFIED, category2: a.category2 || UNCLASSIFIED }
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
  /** 词表可信度为 inferred 的组 → 侧栏灰标「待核对」（06 §7.1 / §9.2-3） */
  inferred: boolean
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

/** 某（组）大类下的一级分类计数（count 降序、未分类恒最后） */
export function countLevel1(assets: Asset[], kind: KindScope): CategoryNodeCount[] {
  const kinds = kindSetOf(kind)
  const m = new Map<string, number>()
  for (const a of assets) {
    if (!kinds.has(a.kind)) continue
    const { category1 } = categoriesOf(a)
    m.set(category1, (m.get(category1) ?? 0) + 1)
  }
  return sortNodes([...m.entries()].map(([value, count]) => ({ value, count, inferred: CONFIDENCE[value] === 'inferred' })))
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
  return sortNodes([...m.entries()].map(([value, count]) => ({ value, count, inferred: false })))
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
 * hdri/other 无词表 → [] → UI 自由输入。 */
export function level1OptionsFor(kind: AssetKind): readonly string[] {
  if (kind === 'texture' || kind === 'material') return MERGED_MATERIAL_LEVEL1
  if (kind === 'model') return CHANNEL_LEVEL1.model
  return []
}

/**
 * 选定一级后二级的可选项：
 * - `[]` → 一级是「未分类」，二级强制未分类（禁用输入）；
 * - `null` → 无级联词表（如材质预设），UI 渲染为「可自由输入」（06 §3.3-②）；
 * - 其余 → 受控枚举（仍允许不在表内的值吗？——选择器只出枚举，自由值走自由输入路径）。
 */
export function level2OptionsFor(category1: string): readonly string[] | null {
  if (!category1 || category1 === UNCLASSIFIED) return []
  const list = level2Of(category1)
  return list.length > 0 ? list : null
}

/** 风格筛选选项：model/texture 用各自的册，kind=all 用并集；其余大类无词表 → [] */
export function styleOptionsFor(kind: AssetKind | 'all'): readonly string[] {
  if (kind === 'model' || kind === 'texture') return styleListOf(kind)
  if (kind === 'all') return styleListAll()
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
