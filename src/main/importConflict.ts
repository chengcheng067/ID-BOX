/**
 * 导入重复判定的**纯逻辑**（docs/27 T-02）。
 *
 * 三段：
 * ① `buildDedupeIndex()` —— 把渲染层传来的判重快照（`ImportDedupeEntry[]`）编成两张表；
 * ② `matchConflict()` —— 给一条新素材判重，返回「库内最早的那一份」+ 依据；
 * ③ `BatchLedger` —— 批内名字台账（修「并发 3 下同名包互踩」的真实缺陷，docs/27 §5.1）。
 *
 * ## 硬约束
 *
 * - **纯函数 / 零 IO**：不 import electron、不 import fs（连 `node:path` 都不引），
 *   单测直接在 node 环境跑（`tests/importConflict.test.ts`）；
 * - 判重口径必须与「重复资产」视图（`renderer/logic/duplicates.ts:keyOf`）**完全一致**，
 *   否则会出现"导入时说没重复、进库后重复视图里冒出两条"的自相矛盾：
 *   `zhimoId` 全等（强）> `dedupeKey` 全等（弱）；**双方都有 ID 但不等 = 不判重**（D02）；
 *   **一方有 ID 一方没有 = 不判重**（D03，不敢判）；
 * - 不做内容哈希（D04）。
 */

import { baseNameOf, dedupeKeyOf, uniqueName } from '../shared/naming'
import { isSizeMismatch } from '../shared/dupRules'
import type {
  AssetKind,
  ImportConflictReason,
  ImportDedupeEntry
} from '../shared/types'

/** 判重索引：两张表 + 有效条数（`size` 只用于日志与测试断言） */
export interface DedupeIndex {
  /** `zhimoId` → 同 ID 的库内条目（强判定） */
  byZhimoId: Map<string, ImportDedupeEntry[]>
  /** `dedupeKey` → 同名同 kind 的库内条目（弱判定） */
  byKey: Map<string, ImportDedupeEntry[]>
  /** 真正进索引的条目数（缺 id 的脏数据被丢弃） */
  size: number
}

/** 判重查询 = 新素材的「键 + 体积」（其余字段只是展示用，不参与判定） */
export interface MatchQuery {
  /** 原始资产名（`uniqueName()` **之前**；可能带知末 ID 尾巴） */
  assetName: string
  kind: AssetKind
  /** 新素材解压后总字节 */
  size: number
  /** 新素材解析出的知末 ID（`zhimoIdFromSources`）；空 = 无 ID */
  zhimoId?: string | null
  /** 已算好的 `dedupeKeyOf(assetName, kind)`；空/缺省 → 现场用 `assetName` 重算 */
  dedupeKey?: string
}

/** 命中结果：库内**最早导入**的那一份（与重复视图「最早 = 原件」一致） */
export interface ConflictMatch {
  reason: ImportConflictReason
  /** 覆盖的替换目标（快照条目，带 folder / meta） */
  existing: ImportDedupeEntry
  /** 同键的其它副本数（>0 = 库里本来就有多份；覆盖只动 `existing` 这一份） */
  otherCopies: number
  /** 新素材与 `existing` 的体积差 > 30%（D05，仅提示，不参与判重） */
  sizeMismatch: boolean
}

/** 空索引（不自造空 Map 反复分配：调用点可能很多） */
export const EMPTY_DEDUPE_INDEX: DedupeIndex = {
  byZhimoId: new Map(),
  byKey: new Map(),
  size: 0
}

function zhimoIdOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 快照条目的弱判定键。
 *
 * `dedupeKey` 缺失 / 为空时（极老数据）用 `baseNameOf(name) + kind` **现场重算**，
 * 与 `duplicates.ts:keyOf` 的兜底分支逐字一致 —— 不这么做，老资产的同名导入会判不出重复。
 */
export function entryKeyOf(entry: ImportDedupeEntry): string {
  const key = typeof entry.dedupeKey === 'string' ? entry.dedupeKey.trim() : ''
  if (key) return key
  return dedupeKeyOf(baseNameOf(entry.name ?? ''), String(entry.kind ?? 'other'))
}

/** 查询侧的弱判定键（`dedupeKey` 缺省时同样现场重算，且先剥自动序号） */
function queryKeyOf(q: MatchQuery): string {
  const key = typeof q.dedupeKey === 'string' ? q.dedupeKey.trim() : ''
  if (key) return key
  return dedupeKeyOf(baseNameOf(q.assetName ?? ''), String(q.kind ?? 'other'))
}

/**
 * 把判重快照编成索引。
 *
 * 同一份快照里允许出现**同键多条**（库里本来就有 2 份以上），所以值是数组；
 * 顺序不保证，取「最早」由 `matchConflict()` 排序决定。
 * 脏数据（无 id）直接丢弃：判重结果要能被覆盖执行器当替换目标用，没有 id 就不合法。
 */
export function buildDedupeIndex(
  entries: readonly ImportDedupeEntry[] | null | undefined
): DedupeIndex {
  if (!entries || entries.length === 0) return EMPTY_DEDUPE_INDEX

  const byZhimoId = new Map<string, ImportDedupeEntry[]>()
  const byKey = new Map<string, ImportDedupeEntry[]>()
  let size = 0

  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    size += 1

    const key = entryKeyOf(entry)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(entry)
    else byKey.set(key, [entry])

    const zid = zhimoIdOf(entry.zhimoId)
    if (!zid) continue
    const idBucket = byZhimoId.get(zid)
    if (idBucket) idBucket.push(entry)
    else byZhimoId.set(zid, [entry])
  }

  return { byZhimoId, byKey, size }
}

/** 组内取最早（同毫秒按 id 兜底，保证结果稳定 —— 与 `duplicates.ts` 同款） */
function earliest(list: readonly ImportDedupeEntry[]): ImportDedupeEntry[] {
  return [...list].sort(
    (a, b) => (a.importedAt ?? 0) - (b.importedAt ?? 0) || String(a.id).localeCompare(String(b.id))
  )
}

function pick(
  reason: ImportConflictReason,
  candidates: readonly ImportDedupeEntry[],
  newSize: number
): ConflictMatch {
  const sorted = earliest(candidates)
  const existing = sorted[0]!
  return {
    reason,
    existing,
    otherCopies: Math.max(0, sorted.length - 1),
    sizeMismatch: isSizeMismatch(newSize, Number(existing.size) || 0)
  }
}

/**
 * 判重（docs/27 §1.2）：
 *
 * ```
 * ① 新素材有 zhimoId 且索引里有同 ID 的          → 冲突 reason='zhimo-id'
 * ② 否则，双方都**没有** zhimoId 且 dedupeKey 命中 → 冲突 reason='same-name'
 * ③ 新素材有 ID 但库里没有同 ID                  → 不冲突（D02/D03：不敢判）
 * ④ 都不命中                                      → 不冲突
 * ```
 *
 * 第 ② 步的「双方都没有 ID」是硬约束：库里那一份带 ID、新包没 ID（或反之）时
 * 名字再像也不判重 —— 0.6.3 误删修复的口径（D02/D03）。
 *
 * 同一键命中多份 → 只取 `importedAt` 最早的一份作为替换目标，其余计入 `otherCopies`；
 * **覆盖只处置这一份**，绝不碰历史副本（docs/27 §1.2）。
 */
export function matchConflict(
  index: DedupeIndex | null | undefined,
  query: MatchQuery
): ConflictMatch | null {
  if (!index) return null
  const zid = zhimoIdOf(query.zhimoId)

  // ── ① 强判定：同知末 ID ──────────────────────────────────────────
  const idHits = zid ? index.byZhimoId.get(zid) : undefined
  if (idHits && idHits.length > 0) return pick('zhimo-id', idHits, query.size)

  // 新素材带 ID 但库里没有同 ID → 不判重（D02）。走到这里再按名字比，
  // 等于把「两件不同商品、名字恰好相同」判成重复，正是 0.6.3 修掉的误删。
  if (zid) return null

  // ── ② 弱判定：同名同 kind，且库里那份也没有 ID（D03）────────────
  const nameHits = index.byKey.get(queryKeyOf(query))
  if (!nameHits || nameHits.length === 0) return null
  const candidates = nameHits.filter((e) => !zhimoIdOf(e.zhimoId))
  if (candidates.length === 0) return null

  return pick('same-name', candidates, query.size)
}

/**
 * 批内名字台账（docs/27 §5.1 / D15）。
 *
 * ## 修的是什么缺陷
 *
 * 压缩包路径的 `existing` 来自 `fs.readdir(cat2Dir)`（`importer.ts`）：并发 3 时
 * A 与 B 可能同时读到"目录里没有 X"、都算出 `X`，然后第二个 `moveDir` 撞上已存在的
 * 非空目录（Windows 上 `rename` 到非空目录直接失败）→ 该条以 `error` 收场。
 *
 * ## 用法
 *
 * ```ts
 * const name = ledger.reserve(cat2Dir, assetName, await readdir(cat2Dir))
 * await moveDir(contentRoot, path.join(cat2Dir, name))
 * // 失败时 ledger.release(cat2Dir, name) 归还名字，避免白占
 * ```
 *
 * `reserve()` 是**同步**的：拿到名字到真正落盘之间可能有 await，但名字已经在台账里，
 * 兄弟任务一定看得见。单图路径的 `mkdir` 占位锁（防跨进程/外部抢占）仍然保留，
 * 只需把台账名并入初始 `taken`（见 `importer.importMediaOne`）。
 */
export class BatchLedger {
  /** 目录（大小写/分隔符归一）→ 本批次已保留的目录名 */
  private readonly byDir = new Map<string, Set<string>>()

  /**
   * 保留一个名字：`diskNames`（磁盘现状）∪ 本批已保留 → `uniqueName(base, …)`。
   *
   * @param cat2Dir   二级分类目录绝对路径
   * @param base      原始资产名（未加 `-2`）
   * @param diskNames 本次 `readdir(cat2Dir)` 的结果（可为空）
   */
  reserve(cat2Dir: string, base: string, diskNames?: readonly string[]): string {
    const key = dirKeyOf(cat2Dir)
    let taken = this.byDir.get(key)
    if (!taken) {
      taken = new Set<string>()
      this.byDir.set(key, taken)
    }
    for (const name of diskNames ?? []) taken.add(name)
    const name = uniqueName(base, taken)
    taken.add(name)
    return name
  }

  /** 记一个**外部已占**的名字（单图路径自己 mkdir 成功后回填，让兄弟任务看得见） */
  claim(cat2Dir: string, name: string): void {
    const key = dirKeyOf(cat2Dir)
    let taken = this.byDir.get(key)
    if (!taken) {
      taken = new Set<string>()
      this.byDir.set(key, taken)
    }
    taken.add(name)
  }

  /** 归还一个名字（该条导入失败、实际没落盘时调用，避免白占） */
  release(cat2Dir: string, name: string): void {
    this.byDir.get(dirKeyOf(cat2Dir))?.delete(name)
  }

  /** 某目录本批已保留的名字（副本；调用方常并入 `taken` 初始集） */
  namesOf(cat2Dir: string): Set<string> {
    return new Set(this.byDir.get(dirKeyOf(cat2Dir)) ?? [])
  }
}

/** 目录归一：统一分隔符 + 去尾分隔 + 小写（Windows 语义，与 `isInsideLibraryDir` 同款） */
function dirKeyOf(dir: string): string {
  return String(dir ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}
