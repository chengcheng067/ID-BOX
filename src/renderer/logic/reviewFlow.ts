/**
 * 待确认队列的**纯逻辑**（docs/35 · T-08）。
 *
 * 零 React / 零 DOM / 零 `window` 桥（`modvault` IPC）→ 可直接进 vitest（`environment: 'node'`，
 * 测试见 `tests/reviewFlow.test.ts`）。
 *
 * ## 与 triageFlow 的关系（这是本文件存在的理由）
 *
 * `triageFlow` 的队列只认「双未分类」；本文件把「有分类但来源冲突」也纳进来，
 * 两种原因共用同一套浮层（`TriageOverlay` 后续按 `mode` 切换，见 `docs/35 §4.2`）。
 *
 * ⚠️ **`unclassified` 的行为一个字节都不能变**：`buildReviewQueue(ordered, 'unclassified')`
 *    必须与 `buildTriageQueue(ordered)` **逐 id 相等**（`tests/reviewFlow.test.ts` 有等价性
 *    断言钉住）。所以本文件**不重新实现**「未分类」判据，只 `import { isUnclassified }`
 *    —— 「双未分类」的唯一实现点仍然是 `triageFlow.ts:57`，这里写第二份就是第二套真相。
 *
 * ## 为什么要有 `reviewReasonOf` 这一层
 *
 * 判据必须集中在一处：侧栏「待确认」计数（`docs/35 §4.3 入口①`）、浮层队列、卡片角
 * 「存疑」徽标（入口③）三处都要问同一个问题「这条要不要用户裁定、为什么」。散在组件里
 * 必然漂移（`docs/25`「未分类有三种口径」就是这个教训）。**组件里不许再写判据。**
 *
 * ## 纪律（与 `triageFlow` 同源）
 *
 * - **不排序**：调用方给的是已按当前排序规则排好的列表；
 * - **不套筛选**：待确认队列回答「整个库里还有多少要裁定」，套上搜索词会缩成几条；
 * - **不过滤软删**：软删过滤的唯一实现点是调用方的 `matchesFilters` / `isDeletedAsset`
 *   （`store.useTriageQueue()` 的既有形态），本模块再写一遍 `deletedAt` 判断就是第二套真相。
 */

import type { Asset } from '../../shared/types'
import { isUnclassified } from './triageFlow'

/** 待确认原因。`unclassified` = 现状语义（双未分类）；`conflict` = 两源冲突（新，R-10） */
export type ReviewReason = 'unclassified' | 'conflict'

/**
 * 该资产是否需要用户裁定，以及为什么；`null` = 不需要。
 *
 * ## 判定顺序（**逐字实现 docs/35 §4.1，顺序不可交换**）
 *
 * ```
 * 1. 已定案      → null          （classifyReview.decidedAt 是有限数字）
 * 2. 两源冲突    → 'conflict'    （classifyReview.reason === 'conflict'）
 * 3. 双未分类    → 'unclassified'（isUnclassified(a)，语义一个字节不改）
 * 4. 其余        → null
 * ```
 *
 * ### 为什么「已定案」最先判
 *
 * 用户/自动定过案的资产不再打扰。若放在 conflict 之后，**定案过的 conflict 会永远留在
 * 队列里** —— 用户处理完一张，队列长度不变，会以为按钮没生效。
 *
 * ### 为什么 conflict 必须在 unclassified 之前（本卡最容易写错的一处）
 *
 * 反例：`{ reason: 'conflict', category1: '工装空间', category2: '未分类' }`。
 * S2 只解析到一级、S1 有二级且二级不同 → 判 `conflict`（R-06 只在「一级同 + 只有一边有二级」
 * 时补二级，二级冲突时仍然 conflict），而最终 `category2` 可能被写成 `未分类`。
 *
 * - 若先判 `isUnclassified`：这条**不是**双未分类（`category1` 有值）→ 返回 false →
 *   落到第 4 条 `null`，**这条资产从两个队列里同时消失**（既不在未分类队列，也不在
 *   待确认队列）。这是真的丢数据。
 * - 即使它恰好两级都是 `未分类`，先判 unclassified 也会把它归成 `unclassified`，
 *   于是 UI 里「站方说是 X」那一块（只在 `conflict` 模式渲染）就丢了。
 *
 * 所以顺序是硬约束，`tests/reviewFlow.test.ts` 有单独的 `it` 钉住这个反例。
 *
 * ### `confidence === 'none'` 不产生 `reason`
 *
 * `classifyCrossCheck` 只在 `conflict` 时写 `reason`；`none`（两边都空）的资产
 * `classifyReview.reason === undefined`，于是落到第 3 条 → 进 **`unclassified`** 队列，
 * 不是 conflict 队列。别因为「没人给它分类」就以为它该进待确认。
 *
 * ### 等价性承诺的边界（与 `buildTriageQueue` 逐 id 相等的前提）
 *
 * 第 1 条「已定案 → null」优先于第 3 条，所以**「双未分类 + `decidedAt` 有值」这种非法状态**
 * 两组会给出不同答案（这里 null，`buildTriageQueue` 收下）。这不算 bug：定案必然已把分类
 * 写进去，两级都空还带 `decidedAt` 只可能是数据损坏。不改这一点 —— 让定案过的资产留在
 * 未分类队列里才是真问题（用户处理完不复位）。
 *
 * **真发生时用户看到的形态**：该资产**从两个队列里都消失** —— 不进 conflict 队列（它是
 * `unclassified`，`reason` 为空），也不进 unclassified 队列（第 1 条已判 null），
 * 侧栏两个计数也都不含它。它不是"被隐藏"，而是"两边都不认领"，除非用户主动在网格里
 * 搜到这张，否则它不会再被任何入口提示。**看到这个现象请先怀疑数据损坏，别先怀疑队列过滤。**
 *
 * 数据损坏的兜底**不在本模块做**（这里只判"要不要打扰用户"，不修数据）：`rescan` 的
 * 存在性修复（`store.ts` 的缩略图 / 记录自愈那条链路）是同类问题的既有归属地。
 * `tests/reviewFlow.test.ts` 的等价性夹具因此不构造该状态，并在注释里写明原因。
 */
export function reviewReasonOf(asset: Asset | null | undefined): ReviewReason | null {
  if (!asset) return null

  // 1. 已定案：`decidedAt` 是有限数字即视为定案（`0` 也算 —— 那是合法的 epoch 值；
  //    `NaN` / `undefined` / 非数字不算，否则一次写坏的时间戳会把整批钉成"已定案"）
  const decidedAt = asset.classifyReview?.decidedAt
  if (typeof decidedAt === 'number' && Number.isFinite(decidedAt)) return null

  // 2. 两源冲突（⚠️ 必须在 3 之前，理由见函数头「为什么 conflict 必须在 unclassified 之前」）
  if (asset.classifyReview?.reason === 'conflict') return 'conflict'

  // 3. 双未分类：判据**只有** triageFlow 那一份
  if (isUnclassified(asset)) return 'unclassified'

  // 4. 其余（high / medium-s1 / medium-s2 / 没有 classifyReview）
  return null
}

/**
 * 这条资产是否在待确认队列里（不分原因）。
 *
 * 就是 `reviewReasonOf(a) !== null`，**不要加别的条件**（例如"有 classifyReview 才算"）：
 * 那会让 `classifyReview === undefined` 的历史资产整批掉出未分类队列，
 * 与 `buildTriageQueue` 的既有行为冲突。
 */
export function isPendingReview(asset: Asset | null | undefined): boolean {
  return reviewReasonOf(asset) !== null
}

/**
 * 从**调用方给的序列**里挑出某个原因的待确认项（保序，不重排）。
 *
 * @param assets 已排好序的资产序列。**不套筛选、不过滤软删**（理由见文件头纪律）；
 *   调用方给什么顺序就按什么顺序。
 * @param reason 要挑哪种原因
 * @returns 符合该原因的那些，顺序与入参完全一致
 *
 * 与 `buildTriageQueue(ordered)` 的关系：`buildReviewQueue(ordered, 'unclassified')`
 * **必须**与它逐 id 相等（等价性断言在测试里）。这里不合并实现，只按 `reviewReasonOf`
 * 过滤 —— 合并会让 `triageFlow.ts` 的注释体系失焦（`docs/35 §4.2` 的裁定）。
 */
export function buildReviewQueue(
  assets: readonly Asset[],
  reason: ReviewReason
): Asset[] {
  if (!Array.isArray(assets)) return []
  return assets.filter((a) => reviewReasonOf(a) === reason)
}

/**
 * 两种原因的待确认数量（侧栏「待确认」徽标 / 设置页汇总用）。
 *
 * ## 调用约定（**这两个数字是"传进来这批"的数字，不是"全库"**）
 *
 * 本函数**不套筛选、不过滤软删**。侧栏要的是**全库**口径（`docs/35 §4.3 入口①`），
 * 所以调用方必须先自己滤掉软删记录再传进来 —— 软删过滤的唯一实现点仍是
 * `matchesFilters` / `isDeletedAsset`，与 `useTriageQueue` 同一条纪律。
 * 传 `activeAssets` 进来就得到"当前视图里的数量"，那是另一个问题，别在这里修。
 *
 * 顺带说明「只数 conflict 不数 unclassified」属于调用方的展示决策（侧栏那个节点只显示
 * conflict），这里两个数都返回，让调用方自己取。
 */
export function countPendingReview(assets: readonly Asset[]): {
  unclassified: number
  conflict: number
} {
  const out = { unclassified: 0, conflict: 0 }
  if (!Array.isArray(assets)) return out
  for (const a of assets) {
    const reason = reviewReasonOf(a)
    if (reason === 'unclassified') out.unclassified += 1
    else if (reason === 'conflict') out.conflict += 1
  }
  return out
}
