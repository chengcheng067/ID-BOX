/**
 * 一键打包 · 导入冲突比对与裁决状态机（docs/58 §5，纯函数；vitest node 可直接单测）。
 *
 * ## 定位
 *
 * 主进程 `package:importInspect` 只做「验包 + 还原记录」，**不改库**；渲染层拿
 * `records / personal` 后要回答两个问题：
 * ① 目标库是不是空库（空库直导、非空库必须显式确认）；
 * ② 每条可能撞车的记录选「跳过 / 覆盖 / 保留两份」中的哪一档。
 * 本文件把这两件事做成零 IO / 零 DOM 的纯函数，组件与 store 只消费结果。
 *
 * ## 判重口径（与 docs/27 / `main/importConflict.ts` 同源）
 *
 * `id` 全等（同库旧快照再次导入）> 知末 ID 全等（强）> 归一化同名同类型（弱）。
 * 双方都有 ID 但不等 = 不判重；一方有 ID 一方没有 = 不判重（D02/D03 不敢判）。
 * 同 id 但分类不同额外标注 `category-moved`，让用户知道这是一次分类改派。
 *
 * ## 状态机（docs/58 §5 的 mermaid）
 *
 * ```
 * idle → inspecting → confirm(非空库) / resolving(空库)
 * confirm → resolving → ready(全部裁决完) → importing → done
 * 任意阶段出错 → error；reset 回 idle
 * ```
 *
 * 「放行导入」的**唯一**判据是 `canApplyPackage()`：阶段 ready + 非空库已确认 +
 * 每条冲突都有 resolution。少一条就返回 false，绝不做静默默认值补全。
 */
import type { Asset } from '../../shared/types'
import type {
  PackageResolution,
  PackageResolutions,
  PortableAsset
} from '../../shared/packageFormat'
import { baseNameOf, dedupeKeyOf, zhimoIdOf } from '../../shared/naming'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { isDeletedAsset } from './trashView'

// ── ① 比对：一条冲突 ───────────────────────────────────────────────────────

/** 冲突依据（文案在 `PACKAGE_CONFLICT_LABEL`，UI 不显示内部词） */
export type PackageConflictReason = 'same-id' | 'category-moved' | 'zhimo-id' | 'same-name'

/** 冲突依据的白话标签（单行中文，弹窗 chip 直接渲染） */
export const PACKAGE_CONFLICT_LABEL: Record<PackageConflictReason, string> = {
  'same-id': '库里已有',
  'category-moved': '分类有调整',
  'zhimo-id': '同一件素材',
  'same-name': '同名素材'
}

/** 一条「包内记录 vs 库内记录」的撞车（软删记录不参与比对） */
export interface PackageConflict {
  /** 包内资产 id，也是裁决表 `PackageResolutions` 的键 */
  id: string
  /** 包内资产名（展示用） */
  name: string
  kind: Asset['kind']
  reason: PackageConflictReason
  /** 包内体积（字节，展示用） */
  size: number
  /** 库内那一条的 id（覆盖只动这一份） */
  localId: string
  /** 库内那一条的名字（展示用） */
  localName: string
  /** 库内那一条的分类摘要（展示用，单行） */
  localCategory: string
  /** 库内体积（字节，展示用） */
  localSize: number
  /** 分类是否改派（reason='category-moved' 时恒 true） */
  categoryChanged: boolean
  /** 用户裁决；undefined = 还没裁，导入必须等 */
  resolution?: PackageResolution
}

/** 判重快照里的最小形状：本地 Asset 与包内 PortableAsset 都满足 */
interface ComparableRecord {
  id?: string | null
  name?: string | null
  kind?: string | null
  dedupeKey?: string | null
  zhimoId?: string | null
  category1?: string | null
  category2?: string | null
}

/** 弱判定键：显式 dedupeKey 优先，缺失时按原始名 + kind 现场重算（老数据兜底） */
function keyOf(record: ComparableRecord): string {
  const explicit = typeof record.dedupeKey === 'string' ? record.dedupeKey.trim() : ''
  if (explicit) return explicit
  return dedupeKeyOf(baseNameOf(String(record.name ?? '')), String(record.kind ?? 'other'))
}

/** 强判定键：显式 zhimoId 优先，缺失时从名字里解析（与 naming 的口径同源） */
function strongIdOf(record: ComparableRecord): string {
  const explicit = typeof record.zhimoId === 'string' ? record.zhimoId.trim() : ''
  if (explicit) return explicit
  return zhimoIdOf(String(record.name ?? '')) ?? ''
}

/** 分类对（缺省 = 未分类），用于比较是否改派 */
function categoryPairOf(record: ComparableRecord): [string, string] {
  const c1 = typeof record.category1 === 'string' && record.category1.trim() ? record.category1.trim() : UNCLASSIFIED
  const c2 = typeof record.category2 === 'string' && record.category2.trim() ? record.category2.trim() : UNCLASSIFIED
  return [c1, c2]
}

/** 分类摘要（用 ' · ' 分隔，不展示任何机器字段） */
function categoryTextOf(record: ComparableRecord): string {
  const [c1, c2] = categoryPairOf(record)
  if (c1 === UNCLASSIFIED) return c1
  if (c2 === UNCLASSIFIED) return c1
  return `${c1} · ${c2}`
}

function sizeOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** 库内索引：id / 强 ID / 弱键三张表；软删与缺 id 的脏数据不进表 */
interface LocalIndex {
  byId: Map<string, Asset>
  byStrongId: Map<string, Asset[]>
  byKey: Map<string, Asset[]>
}

function buildLocalIndex(localAssets: readonly Asset[] | null | undefined): LocalIndex {
  const byId = new Map<string, Asset>()
  const byStrongId = new Map<string, Asset[]>()
  const byKey = new Map<string, Asset[]>()
  if (!Array.isArray(localAssets)) return { byId, byStrongId, byKey }

  for (const asset of localAssets) {
    if (!asset || typeof asset.id !== 'string' || asset.id.length === 0) continue
    if (isDeletedAsset(asset)) continue
    byId.set(asset.id, asset)

    const key = keyOf(asset)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(asset)
    else byKey.set(key, [asset])

    const sid = strongIdOf(asset)
    if (!sid) continue
    const strongBucket = byStrongId.get(sid)
    if (strongBucket) strongBucket.push(asset)
    else byStrongId.set(sid, [asset])
  }
  return { byId, byStrongId, byKey }
}

/** 组内取最早（同毫秒按 id 兜底），与「最早 = 原件」口径一致 */
function earliest(list: readonly Asset[] | undefined): Asset | null {
  if (!list || list.length === 0) return null
  return [...list].sort(
    (a, b) => (a.importedAt ?? 0) - (b.importedAt ?? 0) || String(a.id).localeCompare(String(b.id))
  )[0]!
}

/**
 * ① `buildPackageConflicts`：包内快照 × 当前库 → 冲突清单。
 *
 * 纯函数：不改入参、不取当前时间、不产生副作用。顺序跟随 `snapshot`（主进程清单顺序），
 * 一条包内记录最多产出一条冲突（按 id → 强 ID → 弱键的优先级择一）。
 */
export function buildPackageConflicts(
  localAssets: readonly Asset[] | null | undefined,
  snapshot: readonly PortableAsset[] | null | undefined
): PackageConflict[] {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return []
  const index = buildLocalIndex(localAssets)
  const conflicts: PackageConflict[] = []

  for (const incoming of snapshot) {
    if (!incoming || typeof incoming.id !== 'string' || incoming.id.length === 0) continue

    const incomingSid = strongIdOf(incoming)
    const [incomingC1, incomingC2] = categoryPairOf(incoming)
    let local: Asset | undefined
    let reason: PackageConflictReason

    // ① id 全等（同一份库的旧快照再次导入）
    const byId = index.byId.get(incoming.id)
    if (byId) {
      local = byId
      const [localC1, localC2] = categoryPairOf(local)
      reason = localC1 === incomingC1 && localC2 === incomingC2 ? 'same-id' : 'category-moved'
    } else if (incomingSid) {
      // ② 强判定：同一件素材
      local = earliest(index.byStrongId.get(incomingSid)) ?? undefined
      reason = 'zhimo-id'
    } else {
      // ③ 弱判定：双方都没有强 ID 时，同名同类型才算撞车
      const candidates = (index.byKey.get(keyOf(incoming)) ?? []).filter((a) => !strongIdOf(a))
      local = earliest(candidates) ?? undefined
      reason = 'same-name'
    }

    if (!local) continue

    const [localC1, localC2] = categoryPairOf(local)
    conflicts.push({
      id: incoming.id,
      name: String(incoming.name ?? ''),
      kind: incoming.kind,
      reason,
      size: sizeOf(incoming.size),
      localId: local.id,
      localName: String(local.name ?? ''),
      localCategory: categoryTextOf(local),
      localSize: sizeOf(local.size),
      categoryChanged: localC1 !== incomingC1 || localC2 !== incomingC2
    })
  }
  return conflicts
}

// ── ② 空库直导真值表 ───────────────────────────────────────────────────────

/**
 * `shouldSkipConfirm`：空库 → true（不弹整库确认）；非空库 → false（必须显式确认）。
 *
 * 回收站里的软删资产**不算库里已有**（与 `importConflict.ts::buildDedupeSnapshot`
 * 同一口径）：否则用户清空过库仍被要求确认一次，是纯粹的骚扰。
 * 脏数据（null 元素）也不计数。
 */
export function shouldSkipConfirm(localAssets: readonly Asset[] | null | undefined): boolean {
  if (!Array.isArray(localAssets) || localAssets.length === 0) return true
  return localAssets.every((asset) => !asset || isDeletedAsset(asset))
}

// ── ③ 逐项裁决状态机 ───────────────────────────────────────────────────────

/** 弹窗阶段（与 docs/58 §5 的 mermaid 一一对应） */
export type PackagePhase =
  | 'idle'
  | 'inspecting'
  | 'confirm'
  | 'resolving'
  | 'ready'
  | 'importing'
  | 'done'
  | 'error'

/** reducer 持有的全部状态（store 只存这一份，组件只读） */
export interface PackageConflictState {
  phase: PackagePhase
  /** 已比出的冲突清单（含每项的 resolution） */
  conflicts: PackageConflict[]
  /** 包内总条数（进度与汇总文案用） */
  total: number
  /** 非空库 = 必须先显式确认 */
  needsConfirm: boolean
  /** 用户是否已点过「确认继续」；空库视为已满足 */
  confirmed: boolean
  /** 单行中文错误；phase='error' 时展示 */
  error: string | null
}

/** 初始状态 */
export const INITIAL_PACKAGE_CONFLICT_STATE: PackageConflictState = {
  phase: 'idle',
  conflicts: [],
  total: 0,
  needsConfirm: false,
  confirmed: false,
  error: null
}

/** 触发状态机的动作（全部同步、可序列化） */
export type PackageConflictAction =
  | { type: 'inspecting' }
  | { type: 'inspect'; conflicts: PackageConflict[]; total: number; needsConfirm: boolean }
  | { type: 'confirm' }
  | { type: 'choose'; id: string; resolution: PackageResolution }
  | { type: 'choose-all'; resolution: PackageResolution }
  | { type: 'importing' }
  | { type: 'done' }
  | { type: 'fail'; message: string }
  | { type: 'reset' }

function isResolution(value: unknown): value is PackageResolution {
  return value === 'skip' || value === 'overwrite' || value === 'keep-both'
}

/** 裁决是否覆盖每条冲突（空清单 = 已完成，空库可直接导） */
export function isResolutionComplete(state: Pick<PackageConflictState, 'conflicts'>): boolean {
  return state.conflicts.every((c) => isResolution(c.resolution))
}

/** 还没裁决的 id（UI 据此禁用「开始导入」并高亮未完成的行） */
export function unresolvedIds(state: Pick<PackageConflictState, 'conflicts'>): string[] {
  return state.conflicts.filter((c) => !isResolution(c.resolution)).map((c) => c.id)
}

/** 裁决表：只包含已裁决的冲突，键 = 包内资产 id（与 IPC 的 `PackageResolutions` 同形） */
export function resolutionTable(state: Pick<PackageConflictState, 'conflicts'>): PackageResolutions {
  const out: PackageResolutions = {}
  for (const c of state.conflicts) {
    if (isResolution(c.resolution)) out[c.id] = c.resolution
  }
  return out
}

/** 是否可以放行导入：阶段 ready + 已确认 + 每条冲突都裁过 */
export function canApplyPackage(state: PackageConflictState): boolean {
  return (
    state.phase === 'ready' &&
    (!state.needsConfirm || state.confirmed) &&
    isResolutionComplete(state)
  )
}

/** 冲突裁决完 → ready，否则停在 resolving（无冲突时直接 ready = 空库直导） */
function readyPhase(conflicts: readonly PackageConflict[]): PackagePhase {
  return isResolutionComplete({ conflicts: [...conflicts] }) ? 'ready' : 'resolving'
}

/**
 * ③ `conflictStateReducer`：逐项三档裁决的状态机。
 *
 * 非法动作（阶段不对 / id 不存在 / 档位值非法）一律原样返回，不抛错 —— 弹窗里
 * 一次迟到的点击不该把整个界面炸掉。
 */
export function conflictStateReducer(
  state: PackageConflictState,
  action: PackageConflictAction
): PackageConflictState {
  switch (action.type) {
    case 'inspecting':
      return { ...INITIAL_PACKAGE_CONFLICT_STATE, phase: 'inspecting' }

    case 'inspect': {
      const conflicts = Array.isArray(action.conflicts) ? [...action.conflicts] : []
      const needsConfirm = action.needsConfirm === true
      return {
        phase: needsConfirm ? 'confirm' : readyPhase(conflicts),
        conflicts,
        total: Number.isFinite(action.total) ? Math.max(0, Math.floor(action.total)) : conflicts.length,
        needsConfirm,
        // 空库无需用户确认；非空库保持 false 直到 confirm 动作到达
        confirmed: !needsConfirm,
        error: null
      }
    }

    case 'confirm':
      if (state.phase !== 'confirm') return state
      return { ...state, confirmed: true, phase: readyPhase(state.conflicts) }

    case 'choose': {
      if (state.phase !== 'resolving' && state.phase !== 'ready') return state
      if (!isResolution(action.resolution)) return state
      if (!state.conflicts.some((c) => c.id === action.id)) return state
      const conflicts = state.conflicts.map((c) =>
        c.id === action.id ? { ...c, resolution: action.resolution } : c
      )
      return { ...state, conflicts, phase: readyPhase(conflicts) }
    }

    case 'choose-all': {
      if (state.phase !== 'resolving' && state.phase !== 'ready') return state
      if (!isResolution(action.resolution)) return state
      const conflicts = state.conflicts.map((c) => ({ ...c, resolution: action.resolution }))
      return { ...state, conflicts, phase: readyPhase(conflicts) }
    }

    case 'importing':
      if (!canApplyPackage(state)) return state
      return { ...state, phase: 'importing' }

    case 'done':
      if (state.phase !== 'importing') return state
      return { ...state, phase: 'done' }

    case 'fail':
      return {
        ...state,
        phase: 'error',
        error: typeof action.message === 'string' && action.message ? action.message : '导入失败，请稍后重试'
      }

    case 'reset':
      return { ...INITIAL_PACKAGE_CONFLICT_STATE }

    default:
      return state
  }
}
