/**
 * 重复判定的**共享口径**（体积差异阈值，docs/27）。
 *
 * ## 为什么单独一个文件
 *
 * 「体积差 > 30% → 可能不是同一套」这条口径已经存在两处消费者：
 * ① 渲染层「重复资产」视图（`renderer/logic/duplicates.ts` 的 `hasSizeMismatch`）；
 * ② 主进程导入时的判重（`main/importConflict.ts`，docs/27 T-02）。
 *
 * 主进程**绝不能 import 渲染层**（打包边界 + 分层），所以常量落在这里；
 * duplicates.ts 因本轮禁止改动仍写着字面量 0.3，两者的一致性由
 * `tests/importConflict.test.ts` 里的一条断言锁住 —— 任何一处改动都会让测试变红，
 * 不存在"悄悄漂移"的可能。
 *
 * 为什么不把这里做成 `duplicates.ts` 的唯一来源：那是渲染层文件，属于另一位工程师
 * 的并发改动范围（docs/27 §6.2 共享文件表），本轮只被授权读它。
 */

/** 体积差异阈值：最大比最小大 30% 以上视为「可疑同名」（0.3 = 30%） */
export const SIZE_MISMATCH_RATIO = 0.3

/**
 * 两份体积是否差异过大（相对**较小**的一份算，与 `duplicates.ts` 同口径）。
 *
 * - 两边都是 0 → `false`（没有信息，不冤枉用户）；
 * - 一边 0 一边非 0 → `true`（空壳 vs 有内容，差异巨大）；
 * - 严格大于阈值才算（正好 30% → `false`，边界留给测试钉住）。
 */
export function isSizeMismatch(a: number, b: number): boolean {
  const x = Number.isFinite(a) ? Math.max(0, a) : 0
  const y = Number.isFinite(b) ? Math.max(0, b) : 0
  const min = Math.min(x, y)
  const max = Math.max(x, y)
  if (max === 0) return false
  if (min === 0) return true
  return (max - min) / min > SIZE_MISMATCH_RATIO
}
