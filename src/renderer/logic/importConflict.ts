/**
 * 导入重复处置的**纯逻辑**（docs/27，T-06 / T-07 共用）。
 *
 * 三块内容，全部零 IO、不 import React / DOM / window：
 * ① `buildDedupeSnapshot()`：把当前库投影成判重快照（Dexie 里的 `Asset[]` → `ImportDedupeEntry[]`，
 *    排除软删资产、只带判重 / 展示 / 元数据继承需要的字段）；
 * ② 弹窗的**状态机**（批次默认档 + 行内单独指定）：组件只负责渲染，改哪一行算哪一行由这里算；
 * ③ 弹窗里的派生文案（体积差百分比、来源标签、其余项提示）。
 *
 * 抽成独立模块的理由与 `duplicates.ts` / `filters.ts` 相同：本项目没有 RTL，
 * vitest 跑 node 环境，组件测不了 —— 只有纯函数能进 `tests/` 覆盖。
 */
import type {
  Asset,
  ImportConflictAnswer,
  ImportConflictAsk,
  ImportConflictReason,
  ImportConflictResolution,
  ImportDedupeEntry
} from '../../shared/types'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { isDeletedAsset } from './trashView'

// ── ① 判重快照 ──────────────────────────────────────────────────────

/**
 * 当前库 → 判重快照。
 *
 * 口径（docs/27 D17）：`deletedAt` 非空的资产**不算「已存在」**，直接剔除 ——
 * 否则「回收站里有一份同名」会让新导入莫名其妙地弹窗（而它其实可以正常落盘）。
 *
 * 刻意不带 `files` / `cover` / `thumbPath`：950 条带 files 的 Asset 走结构化克隆是 MB 级，
 * 而判重只需要「键 + 定位 + 展示 + 继承元数据」（`types.ts:413` 的注释）。
 *
 * `dedupeKey` 为空（极老数据）时**留空**，由主进程用 `baseNameOf(name) + kind` 兜底重算
 * —— 口径只实现一次，不在两侧各写一遍。
 */
export function buildDedupeSnapshot(assets: readonly Asset[]): ImportDedupeEntry[] {
  const out: ImportDedupeEntry[] = []
  for (const a of assets) {
    if (!a || typeof a.id !== 'string' || a.id.length === 0) continue
    if (isDeletedAsset(a)) continue
    const dedupeKey = typeof a.dedupeKey === 'string' ? a.dedupeKey.trim() : ''
    const zhimoId = typeof a.zhimoId === 'string' ? a.zhimoId.trim() : ''
    out.push({
      id: a.id,
      name: typeof a.name === 'string' ? a.name : '',
      kind: a.kind,
      // 空串 = 缺键（主进程兜底重算），不要传 '' 让它当成有效键
      dedupeKey: dedupeKey || undefined,
      zhimoId: zhimoId || undefined,
      folder: typeof a.folder === 'string' ? a.folder : '',
      relFolder: typeof a.relFolder === 'string' ? a.relFolder : '',
      size: bytesOf(a.size),
      importedAt: Number.isFinite(a.importedAt) ? a.importedAt : 0,
      // 覆盖时 100% 继承的用户元数据（docs/27 D12 / §3.2.3）
      meta: {
        favorite: a.favorite === true,
        rating: Number.isFinite(a.rating) ? a.rating : 0,
        colorTag: a.colorTag ?? null,
        tags: Array.isArray(a.tags) ? [...a.tags] : [],
        styles: Array.isArray(a.styles) ? [...a.styles] : [],
        note: typeof a.note === 'string' ? a.note : '',
        // 缺省 = 双哨兵 = 用户从未指派过分类 → 覆盖时改用新包预分类
        category1: typeof a.category1 === 'string' && a.category1 ? a.category1 : UNCLASSIFIED,
        category2: typeof a.category2 === 'string' && a.category2 ? a.category2 : UNCLASSIFIED
      }
    })
  }
  return out
}

function bytesOf(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0
}

// ── ② 弹窗状态机 ────────────────────────────────────────────────────

/** 三档处置的固定顺序（与需求原话一致：跳过 / 覆盖 / 同时存在并重命名） */
export const CONFLICT_RESOLUTIONS: readonly ImportConflictResolution[] = [
  'skip',
  'overwrite',
  'keep-both'
] as const

/** 三档的中文名（弹窗按钮文案的唯一来源，主/行两处共用） */
export const RESOLUTION_LABEL: Record<ImportConflictResolution, string> = {
  skip: '跳过',
  overwrite: '覆盖',
  'keep-both': '保留两者'
}

export function isResolution(v: unknown): v is ImportConflictResolution {
  return v === 'skip' || v === 'overwrite' || v === 'keep-both'
}

/**
 * 弹窗的本地状态。
 *
 * 只有两份信息：**批次默认档**（顶部三档）+ **行内单独指定**。
 * 行内没指定过的行始终跟随批次默认档 —— 这样顶部点一下就等于「全部按这个来」，
 * 不需要逐行写值，也就不会出现「顶部改了但某些行还停在旧值」的不一致。
 */
export interface ConflictDialogState {
  batchDefault: ImportConflictResolution
  /** `seq → 该行单独指定的档`；只存**与批次默认档不同**的行（与默认档相同 = 跟随） */
  rowChoices: Record<number, ImportConflictResolution>
}

/**
 * 初始状态：**默认选中「跳过」**（最安全，docs/27 §4.4）。
 *
 * `ask.batchDefault` 是主进程给的预选档（超时兜底恒为 'skip'）；非法值 / 缺失一律归 'skip'，
 * 绝不让一个脏值把默认档变成「覆盖」。
 */
export function initialConflictState(ask: ImportConflictAsk | null | undefined): ConflictDialogState {
  const d = isResolution(ask?.batchDefault) ? ask!.batchDefault : 'skip'
  return { batchDefault: d, rowChoices: {} }
}

/**
 * 点顶部三档 = **覆盖所有行**（docs/27 §2.1：这是用户显式动作，不存在误伤）。
 *
 * 实现上不是逐行写值，而是「清空行内指定」——所有行重新跟随新的默认档。
 */
export function applyBatchDefault(
  state: ConflictDialogState,
  resolution: ImportConflictResolution
): ConflictDialogState {
  return { batchDefault: resolution, rowChoices: {} }
}

/** 行内改档：只改这一行。选到与默认档相同的值时退化为「跟随」（从 rowChoices 摘掉） */
export function setRowChoice(
  state: ConflictDialogState,
  seq: number,
  resolution: ImportConflictResolution
): ConflictDialogState {
  const rowChoices = { ...state.rowChoices }
  if (resolution === state.batchDefault) delete rowChoices[seq]
  else rowChoices[seq] = resolution
  return { ...state, rowChoices }
}

/** 某一行**实际生效**的档（行内指定优先，否则跟随批次默认） */
export function resolutionOf(
  state: ConflictDialogState,
  seq: number
): ImportConflictResolution {
  return state.rowChoices[seq] ?? state.batchDefault
}

/** 该行是否被单独指定过（≠ 默认档）——弹窗据此做行内高亮 */
export function isRowCustom(state: ConflictDialogState, seq: number): boolean {
  return resolutionOf(state, seq) !== state.batchDefault
}

/**
 * 状态 → 答复载荷。
 *
 * - `cancelled`（Esc / 「全部取消」/ ✕）→ 只带 `cancelled:true` + `batchDefault:'skip'`：
 *   主进程按「等同超时 = 全跳过」处理（docs/27 §2.1 / §4.4），**不携带任何行内指定**；
 * - 正常提交 → 只把**与默认档不同**的行放进 `overrides`（缺省项由主进程用 `batchDefault` 补齐），
 *   `seq` 升序，载荷小且与主进程的「可缺省」契约一致。
 */
export function buildConflictAnswer(
  ask: ImportConflictAsk,
  state: ConflictDialogState,
  cancelled = false
): ImportConflictAnswer {
  if (cancelled) {
    return { requestId: ask.requestId, batchDefault: 'skip', cancelled: true }
  }
  const overrides = Object.entries(state.rowChoices)
    .map(([seq, resolution]) => ({ seq: Number(seq), resolution }))
    .filter((o) => Number.isFinite(o.seq) && o.resolution !== state.batchDefault)
    .sort((a, b) => a.seq - b.seq)

  const answer: ImportConflictAnswer = {
    requestId: ask.requestId,
    batchDefault: state.batchDefault
  }
  if (overrides.length > 0) answer.overrides = overrides
  return answer
}

// ── ③ 派生文案 ──────────────────────────────────────────────────────

/**
 * 两份体积的差异百分比（整数，相对**较小**的一份）—— 与 `duplicates.ts` 的
 * `SIZE_MISMATCH_RATIO` 同口径（`(max - min) / min`），只是换成给人看的百分数。
 *
 * 弹窗里那句「⚠ 体积差 N% · 可能不是同一套资产」的 N 必须是**算出来的**，
 * 不能写死（docs/27 D05：30% 只是"要不要提示"的阈值，不是展示值）。
 * 任一侧为 0 / 非法 → 0（不比）。
 */
export function sizeDiffPercent(newSize: number, existingSize: number): number {
  const a = bytesOf(newSize)
  const b = bytesOf(existingSize)
  const min = Math.min(a, b)
  const max = Math.max(a, b)
  if (min <= 0 || max <= 0) return 0
  return Math.round(((max - min) / min) * 100)
}

/** 判重依据的标签（强 / 弱两档，让用户知道该不该信） */
export function reasonLabel(reason: ImportConflictReason): string {
  return reason === 'zhimo-id' ? '同一件素材(ID)' : '同名素材'
}

/** 判重依据是否属于强判定（`zhimo-id` 用醒目样式，`same-name` 用弱样式） */
export function isStrongReason(reason: ImportConflictReason): boolean {
  return reason === 'zhimo-id'
}

/** 库里还有几份同键副本（`otherCopies > 0` 时才显示；覆盖只处置「已存在」那一条） */
export function otherCopiesText(otherCopies: number): string | null {
  if (!Number.isFinite(otherCopies) || otherCopies <= 0) return null
  return `库里还有 ${otherCopies} 份同名副本（覆盖只处置上面这一份）`
}

/**
 * 「还有 N 个源文件正在检查，若也有重复将按上方选择处理」。
 *
 * ⚠️ 这里**故意不说「其余 N 个重复项」**：`ask.remainingItems` 的语义是
 * 「本批尚未出结果的**源文件**数（含正在问的这一条）」（main 侧口径 = `total - settled`，
 * settled 在每条 finally 才 +1），它既不是"重复项"也不排除已列在弹窗里的行。
 * 所以真正的"其余" = `remainingItems - 已在弹窗里列出的行数`，且只在 > 0 时出现：
 * - 空库单包冲突 → remainingItems=1、items=1 → 0 → 不显示（弹窗只有这一条，没有"其余"）；
 * - 8 个包、3 条已列出且都还没出结果 → 8-3=5 → 「还有 5 个源文件正在检查」。
 *
 * 用减法而不是直接显示 `remainingItems`，是因为后者会把用户眼前这三条再数一遍（多算）。
 *
 * 精度上界（已与 main 侧对齐，不改契约）：`remainingItems` 是每条冲突**进聚合缓冲那一刻**
 * 的快照、聚合时取本批最大值；若窗口内有别的非重复包刚好落盘，`settled` 涨而快照没跟上，
 * 这个数会**偏大 1~2（绝不偏小）**。所以「还有 N 个正在检查」是**保守上界**——多报一两个
 * 不会有"漏说"的风险，可接受；不要为了精确去动 `ImportConflictAsk` 共享类型。
 */
export function remainingItemsText(remainingItems: number, shownItems = 0): string | null {
  if (!Number.isFinite(remainingItems)) return null
  const shown = Number.isFinite(shownItems) ? Math.max(0, shownItems) : 0
  const rest = Math.floor(remainingItems) - shown
  if (rest <= 0) return null
  return `还有 ${rest} 个源文件正在检查，若也有重复将按上方选择处理`
}

/** 弹窗标题：「发现 N 个可能重复的素材」 */
export function conflictTitle(count: number): string {
  return `发现 ${count} 个可能重复的素材`
}
