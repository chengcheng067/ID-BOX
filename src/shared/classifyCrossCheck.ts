/**
 * 分类三源交叉验证的**唯一判定实现**（docs/35 · T-03）。
 *
 * 三源是什么（`docs/35 §2.1`）：
 * - **S1 标题语义**：`classifyAssetName(name, files, kind)` 的结论 —— 主要判据；
 * - **S2 站方面包屑**：详情页 `breadcrumb_data` 还原出的 (一级, 二级) —— 校验源；
 * - **S3 站方末级名**：`classifyBaseName`（只有名字、没有路径）—— **旁证，不参与判定**。
 *
 * 判定顺序（`docs/35 §2.2` 的状态机，逐字实现）：
 * ```
 * 两边都空                        → none        （双未分类 + 站方什么都没给）
 * 只有 S1                         → medium-s1   （我方单方结论，**必须标记未验证**）
 * 只有 S2                         → medium-s2   （站方单方结论）
 * 一级不同                        → conflict    （硬冲突，绝不消歧，R-05）
 * 一级同 + 二级都有值但不等        → conflict
 * 一级同 + 只有一边有二级          → high        （R-06：一致即补二级）
 * 一级同 + 二级都相同              → high
 * ```
 *
 * ⚠️ 三个必须钉住的语义，写在这里防止后来人"顺手优化"：
 *
 * 1. **"空"的定义是 `category1 === '未分类'`，不是 `''`。** 容器词表里的哨兵值是
 *    `taxonomy.UNCLASSIFIED`（`'未分类'`）。用空串判空会让所有导入记录都算"有分类"。
 * 2. **`medium-s2` 自动采用、不进待确认队列。** 实测 1091 条 CAD 真值里 460 条（42.2%）
 *    属于这一类 —— 它们是 S1 双未分类、只有站方给了落点。让它们进队列意味着
 *    "每 1000 条资产约 600 条待确认"，用户会直接放弃这个队列，队列也就失去意义。
 *    它至少有站方一个来源，比 `none`（什么都没有）强；用户想看时可在设置页汇总
 *    看到 `unverified N` 这个数字，**按需主动进入**而不是被动打扰（`docs/35 §10 Q-1`）。
 * 3. **`conflict` 绝不自动定案。** 禁止"选更长的一级"、"选站方的"、"选 S1 的"三种隐式消歧。
 *    硬证据（`docs/35 §1.5(b)`，1091 条真值实测）：157 条 conflict 里 **70 条（44.6%）**
 *    是 S1 落进图种三册（`平立面系统图` / `节点详图` / `CAD图库`）的误吸，而真值只有
 *    21 条在这三册。**任何"按 S1 优先自动定案"的规则都会把这 70 条里的大部分写错 ——
 *    自动定案等于把不确定性藏起来。**
 *
 * 本模块**只做判定**（`docs/35 §2.4` 的"不做的事"）：不读 `Asset`、不调 `assignCategory`、
 * 不查映射表（S2/S3 由调用方映射好再传进来）、不写日志。**纯函数、零 IO、零 electron、零 Dexie。**
 */

import type { ClassifyOutcome } from './classifyAsset'
import { UNCLASSIFIED } from './taxonomy'

/**
 * 哨兵：判不出分类时的两个字段值。**从 `taxonomy` 转出，不写死字符串** ——
 * 全仓有且只有一个真相（`docs/25 §待统一`「未分类有三种口径」的教训）。
 */
export const UNCLASSIFIED_CAT = UNCLASSIFIED

/** 语义源（S1）的结论 */
export interface CrossS1 {
  category1: string
  category2: string
  /** autoClassify 的命中词，仅用于 UI 展示"为什么这么判" */
  matchedTerm?: string | null
  matchedLevel?: string | null
}

/** 站方面包屑（S2）经映射后的结论 */
export interface CrossS2 {
  level1: string
  level2: string
  /** 原始面包屑名字数组，UI 展示用 */
  raw: string[]
  /** 走了一级别名（如 室内空间 → 工装空间）时给出实际别名 */
  viaAlias?: string
}

/**
 * 置信度五值枚举（R-04：不是布尔）。
 * - `high`       S1 与 S2 完全一致（含 R-06 的"一边只到一级"补齐）
 * - `medium-s1`  只有 S1（未被任何站方源校验）
 * - `medium-s2`  只有 S2（站方单方结论，自动采用、不进队列）
 * - `conflict`   两者都有但至少一项不一致 → 交用户裁定
 * - `none`       都没有
 */
export type ClassifyConfidence = 'high' | 'medium-s1' | 'medium-s2' | 'conflict' | 'none'

/** 最终采用了谁。`conflict` / `none` 恒为 `'none'`（= 未定案，哪怕 `category1` 有值） */
export type ClassifySourceUsed = 's1' | 's2' | 'both' | 'none'

/** `conflict` 时的候选落点（固定 [S1, S2] 顺序：语义优先，不做"更长优先"排序） */
export interface CrossCandidate {
  category1: string
  category2: string
  from: 's1' | 's2'
}

export interface ClassifyDecision {
  category1: string
  category2: string
  confidence: ClassifyConfidence
  /** 最终采用谁。⚠️ `conflict` 时必须是 `'none'`，即使 `category1` 保留了 S1 的值 */
  used: ClassifySourceUsed
  sources: {
    s1?: CrossS1
    s2?: CrossS2
    /** 站方末级名（classifyBaseName），只做旁证，不参与判定 */
    s3?: string | null
  }
  /** 仅 conflict 时给：去重后的候选，固定 2 条（S1 一条 + S2 一条） */
  candidates?: CrossCandidate[]
}

/** 判定用的最小两元组（与 `classifyAsset` 的返回值同形，比较时只关心这两个字段） */
const pairOf = (category1: string, category2: string): ClassifyOutcome => ({ category1, category2 })

/** 一个落点是否算"空"。⚠️ 判据是 `category1 === '未分类'`，**不是** `category1 === ''` */
const isEmpty = (p: ClassifyOutcome): boolean => p.category1 === UNCLASSIFIED

/**
 * S2 归一化：`level1 === 未分类` 的 S2 等价于"站方没给"。
 * 理由：S2 若连一级都判不出，它对交叉验证零信息量；把它当成"有值"会让
 * `(未分类, 未分类)` 与 S1 的任意结论都判成"一级不同 → conflict"，
 * 把本该是 `medium-s1` 的资产全推进队列。
 */
const normS2 = (s2: CrossS2 | null | undefined): CrossS2 | null =>
  s2 === null || s2 === undefined || s2.level1 === UNCLASSIFIED ? null : s2

/** 两个落点去重用的键（与 `zhimoReclass.categoryPairKey` 同构；本模块不引入该文件以免拖依赖） */
const pairKey = (p: ClassifyOutcome): string => `${p.category1}\u0000${p.category2}`

/**
 * 主入口：把 S1 / S2 / S3 判成一个 `ClassifyDecision`。
 *
 * @param input.s1 语义源结论（可为 `null` = 没跑过；`category1 === 未分类` 也算空）
 * @param input.s2 站方面包屑结论（可为 `null` = 面包屑缺失且 S3 也没映射出来）
 * @param input.s3 站方末级名。**永远不影响判定**（R-03：`classifyBaseName` 与面包屑末级
 *   会不一致，实测 `1206625741` 面包屑「办公室」/ `classifyBaseName`「开放办公室」），
 *   只原样放进 `sources.s3` 供 UI 显示"站方另说了一个名字"。
 */
export function decideClassify(input: {
  s1?: CrossS1 | null
  s2?: CrossS2 | null
  s3?: string | null
}): ClassifyDecision {
  const s1 = input.s1 ?? null
  const s2 = normS2(input.s2)

  // sources 原样透传（调用方要能把"当时的依据"存进 classifyReview，docs/35 §5.3）
  const sources: ClassifyDecision['sources'] = {}
  if (s1 !== null) sources.s1 = s1
  if (s2 !== null) sources.s2 = s2
  if (input.s3 !== undefined) sources.s3 = input.s3

  const p1 = s1 === null ? null : pairOf(s1.category1, s1.category2)
  const p2 = s2 === null ? null : pairOf(s2.level1, s2.level2)
  const s1Empty = p1 === null || isEmpty(p1)

  // ── 规则 1 · 两边都空 ────────────────────────────────────────────────
  if (s1Empty && p2 === null) {
    return {
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED,
      confidence: 'none',
      used: 'none',
      sources
    }
  }

  // ── 规则 3 · 只有 S2（站方单方结论，自动采用、不进队列） ──────────────
  //
  // ⚠️ S2 只解析到一级（`level2 === '未分类'`）时**仍然是 `medium-s2`**，
  //    落 `{level1, 未分类}`，**不要降级成 `none`**。降级会让 460 条里"只有一级"的
  //    那部分白白丢掉站方给的一级信息（而一级的可靠性远高于二级，docs/35 §1.2）。
  if (s1Empty && p2 !== null) {
    return {
      category1: p2.category1,
      category2: p2.category2,
      confidence: 'medium-s2',
      used: 's2',
      sources
    }
  }

  // 到这里 p1 一定非空（s1 有值）
  if (p1 === null) {
    // 不可达（上面两个分支已覆盖 s1Empty 的全部情形），仅为类型收窄，保持不可变输出
    return {
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED,
      confidence: 'none',
      used: 'none',
      sources
    }
  }

  // ── 规则 2 · 只有 S1（我方单方结论，必须标记未验证） ──────────────────
  if (p2 === null) {
    return {
      category1: p1.category1,
      category2: p1.category2,
      confidence: 'medium-s1',
      used: 's1',
      sources
    }
  }

  // ── 规则 8 · 一级不同 → 硬冲突 ──────────────────────────────────────
  //
  // ⚠️ **这一条必须在一级比较之后立刻返回，不能被下面的 R-06 分支吞掉。**
  //    R-06 的前提是"一级一致"，一级不同时"S2 二级为空"毫无意义 ——
  //    `(建筑设计, 规划设计)` vs `(工装空间, 未分类)` 是真冲突（站方与语义指了
  //    两个不同的大类，docs/35 §7.3 的 2 条 MISS 样本就是它），
  //    不是"S2 只到一级所以让 S1 补"。
  if (p1.category1 !== p2.category1) {
    return conflictDecision(p1, p2, sources)
  }

  // 一级一致 → 只剩二级的三种情形
  const c1 = p1.category1
  const c1Empty2 = p1.category2 === UNCLASSIFIED
  const c2Empty2 = p2.category2 === UNCLASSIFIED

  // ── 规则 4 · 两级都相同（含"两边二级都未分类"） ───────────────────────
  if (p1.category2 === p2.category2) {
    return {
      category1: c1,
      category2: p1.category2,
      confidence: 'high',
      used: 'both',
      sources
    }
  }

  // ── 规则 5 · 一级同、S2 二级空、S1 二级有值（R-06）→ 用 S1 的二级 ──────
  //
  // 实测 1091 条里 10 条命中此情形，**一级全对**。S2 校验通过（一级一致），
  // 只是站方没细到二级，故用 S1 补齐。`used:'s1'` 表示"定案的二级来自 S1"。
  if (c2Empty2) {
    return {
      category1: c1,
      category2: p1.category2,
      confidence: 'high',
      used: 's1',
      sources
    }
  }

  // ── 规则 6 · 一级同、S1 二级空、S2 二级有值（R-06 反向）→ 用 S2 的二级 ──
  //
  // 逻辑对称：一级一致 = 两源互证，二级只有一方给得出，采用之。
  if (c1Empty2) {
    return {
      category1: c1,
      category2: p2.category2,
      confidence: 'high',
      used: 's2',
      sources
    }
  }

  // ── 规则 7 · 一级同、两级都有值但二级不同 → 冲突（交给用户） ────────────
  return conflictDecision(p1, p2, sources)
}

/**
 * 构造 `conflict`：**`used` 必须是 `'none'`** —— 落点取 S1 只是"当前不动时的建议值"
 * （S1 是主判据，只是没被验证），不代表定案。任何编排层看到 `conflict` 都不得搬目录。
 */
function conflictDecision(
  p1: ClassifyOutcome,
  p2: ClassifyOutcome,
  sources: ClassifyDecision['sources']
): ClassifyDecision {
  return {
    category1: p1.category1,
    category2: p1.category2,
    confidence: 'conflict',
    used: 'none',
    sources,
    candidates: buildCandidates(p1, p2)
  }
}

/**
 * 候选落点：顺序固定 `[S1, S2]`。
 *
 * - **不做"更长优先"排序** —— 那就是 R-05 明令禁止的隐式消歧；
 * - 用 `pairKey` 去重（两个落点完全相同时只留一条）。`conflict` 的前提就是
 *   "至少一项不等"，所以实际永远 2 条；上限 3 是给将来"AI 补分类"留的口（docs/35 §2.3）。
 */
function buildCandidates(p1: ClassifyOutcome, p2: ClassifyOutcome): CrossCandidate[] {
  const raw: CrossCandidate[] = [
    { category1: p1.category1, category2: p1.category2, from: 's1' },
    { category1: p2.category1, category2: p2.category2, from: 's2' }
  ]
  const seen = new Set<string>()
  const out: CrossCandidate[] = []
  for (const c of raw) {
    const k = pairKey(c)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out.slice(0, 3)
}
