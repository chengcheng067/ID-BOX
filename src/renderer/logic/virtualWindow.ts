/**
 * 固定行高虚拟窗口的**纯计算**（docs/20 §3 / T-B1）。
 *
 * 设计约束（照 docs/20 §3.1 的裁定）：
 * - **不引外部库**：行高由 `gridDensity` 完全确定，外部库 80% 的价值（动态行高测量）用不上；
 * - **纯函数、零 React / 零 DOM**：不 import react、不读 `window`，可在 node 环境直测
 *   （`vitest` 的 environment 就是 node）；
 * - **网格与列表共用**：列表 = `columns: 1` + `rowH: 44`（`gridMetrics.listMetrics()`），
 *   不写第二份实现。
 *
 * 坐标模型：把 `itemCount` 个条目按 `columns` 列切成 `rowCount = ceil(itemCount / columns)` 行，
 * 每行固定 `rowH` 高，总高 `totalH = rowCount * rowH`。调用方用 `offsetY` 做上垫片、
 * `totalH - offsetY - 已渲染高度` 做下垫片（docs/20 §3.2：用 spacer 撑高，不用 absolute 定位）。
 */
import { OVERSCAN_ROWS } from './gridMetrics'

/** 计算一次窗口所需的输入（`columns` 由调用方补上，见 `VirtualWindowInput`） */
export interface WindowInput {
  /** 滚动容器的 `scrollTop`（可含负值 / 超尾脏值，内部会 clamp） */
  scrollTop: number
  /** 滚动容器的可视高度（`clientHeight`） */
  viewportH: number
  /** 条目总数（资产数 / 文件数） */
  itemCount: number
  /** 固定行高（网格 = `metricsFor(...).rowH`；列表 = `LIST_ROW_H`） */
  rowH: number
  /** 两端额外渲染的行数，缺省 `OVERSCAN_ROWS`（3） */
  overscan?: number
  /**
   * 必须保持挂载的行号（源卡 pin，docs/20 §6）。
   * 命中行会被**并进**可见区间（区间仍是连续的），并已夹到 `[0, rowCount-1]`。
   * ⚠️ 只加能力、B2 不接线；长距离 pin 会把整段区间拉长（DOM 代价见调用方）。
   */
  pinnedRows?: ReadonlySet<number>
}

/** `WindowInput` + 必填的列数（网格由容器宽度算，列表恒为 1） */
export type VirtualWindowInput = WindowInput & {
  /** 列数；≤1 / 非有限值一律按 1 列处理 */
  columns: number
}

/** 一次窗口计算的结果，全部是**闭区间** */
export interface WindowOutput {
  /** 首个渲染行（已含 overscan，≥0） */
  startRow: number
  /** 末个渲染行（已含 overscan，≤ rowCount-1） */
  endRow: number
  /** 首个渲染条目下标（= startRow * columns），供 slice 用 */
  startIndex: number
  /** 末个渲染条目下标（闭区间，≤ itemCount-1），供 slice 用 */
  endIndex: number
  /** 上垫片高度 = startRow * rowH */
  offsetY: number
  /** 总高 = ceil(itemCount / columns) * rowH */
  totalH: number
  /** 规范化后的列数（≥1） */
  columns: number
}

/** `Number.isFinite` 过滤 + 兜底（NaN / Infinity 全部当 fallback） */
function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback
}

/** 非负整数（NaN → 0，小数截断，负数 → 0） */
function nonNegativeInt(v: number): number {
  const n = Math.trunc(finite(v, 0))
  return n > 0 ? n : 0
}

/**
 * 计算可见窗口（闭区间）。
 *
 * 边界行为（全部有单测钉住）：
 * - `itemCount = 0` → 所有字段 0、`totalH = 0`（`startIndex/endIndex` 也是 0，调用方
 *   `slice(0, 1)` 在空数组上仍返回空，不会抛错；需要「窗口内条数」时请用
 *   `Math.max(0, Math.min(itemCount, endIndex + 1) - startIndex)`）；
 * - `rowH` / `columns` 非法（0 / 负 / NaN）→ 分别按 1 行高、1 列处理（不让计算发散）；
 * - `scrollTop` 负值 → 0；超过尾部 → 夹到 `totalH - viewportH`（内容不足一屏时为 0）；
 * - `overscan` 只扩窗口，`startRow/endRow` 与 `startIndex/endIndex` 都**不越界**。
 */
export function computeWindow(input: VirtualWindowInput): WindowOutput {
  const columns = Math.max(1, Math.trunc(finite(input.columns, 1)))
  const rowH = Math.max(1, finite(input.rowH, 1))
  const itemCount = nonNegativeInt(input.itemCount)
  const overscan = nonNegativeInt(input.overscan ?? OVERSCAN_ROWS)

  if (itemCount === 0) {
    return {
      startRow: 0,
      endRow: 0,
      startIndex: 0,
      endIndex: 0,
      offsetY: 0,
      totalH: 0,
      columns
    }
  }

  const rowCount = Math.ceil(itemCount / columns)
  const totalH = rowCount * rowH
  const maxRow = rowCount - 1
  const viewportH = Math.max(0, finite(input.viewportH, 0))
  // 内容不足一屏时浏览器 scrollTop 恒为 0；这里同样夹住，避免"想象中的滚动"改变窗口
  const maxScrollTop = Math.max(0, totalH - viewportH)
  const scrollTop = Math.min(Math.max(0, finite(input.scrollTop, 0)), maxScrollTop)

  const firstVisibleRow = Math.min(maxRow, Math.floor(scrollTop / rowH))
  const visibleRows = Math.max(1, Math.ceil(viewportH / rowH))
  let startRow = Math.max(0, firstVisibleRow - overscan)
  let endRow = Math.min(maxRow, firstVisibleRow + visibleRows - 1 + overscan)
  // 源卡 pin：把被 pin 的行并进区间（仍连续；夹在 [0, maxRow]）
  if (input.pinnedRows && input.pinnedRows.size > 0) {
    for (const raw of input.pinnedRows) {
      if (!Number.isFinite(raw)) continue
      const r = Math.min(maxRow, Math.max(0, Math.trunc(raw)))
      if (r < startRow) startRow = r
      if (r > endRow) endRow = r
    }
  }
  const startIndex = startRow * columns
  // 末行通常不满列 → endIndex 必须夹到 itemCount-1，否则调用方会多取（slice 虽会截断，
  // 但下游若用 endIndex 算"已渲染条数"就会多算）
  const endIndex = Math.min(itemCount - 1, (endRow + 1) * columns - 1)

  return {
    startRow,
    endRow,
    startIndex,
    endIndex,
    offsetY: startRow * rowH,
    totalH,
    columns
  }
}

// ── 变行高（但**确定性**）的行窗口：网格用 ─────────────────────────────────
//
// 为什么需要它：网格里材质卡是 1:1、其余是 4:3，一行的高度 = 该行最高那张卡
// （CSS Grid 行为）。若强行用一个固定行高（哪怕是 1:1 最坏值），
// 全是 4:3 的行会**比模型矮** → 上垫片比真实内容高 → 滚到下面时窗口算出的行
// 与屏幕上看到的行错位，网格露白。
// 所以网格走「逐行高度」模型：高度由 `gridMetrics.gridRowHeights` 纯几何算出
// （不测量 DOM），本函数只负责「给定行高序列 → 可见行区间 + 上下垫片」。

/** 变行高窗口的输入 */
export interface RowWindowInput {
  /** 每行高度（px，**不含**行间距 gap），顺序 = 渲染顺序 */
  rowHeights: readonly number[]
  /** 滚动容器的 `scrollTop` */
  scrollTop: number
  /** 滚动容器的可视高度 */
  viewportH: number
  /** 行间距（网格 = `GRID_GAP`；列表 = 0） */
  gap: number
  /** 两端额外渲染的行数，缺省 `OVERSCAN_ROWS` */
  overscan?: number
  /** 必须保持挂载的行号（同 `WindowInput.pinnedRows`） */
  pinnedRows?: ReadonlySet<number>
}

/** 变行高窗口的输出（全闭区间；`offsetY` / `totalH` 已含 gap） */
export interface RowWindowOutput {
  startRow: number
  endRow: number
  /** 上垫片高度 = 第 startRow 行的起始偏移（= 前面所有行的 h+gap 之和） */
  offsetY: number
  /** 总高 = 所有行高之和 + (行数-1)×gap（与真实 DOM 高度一致，不含尾部多余 gap） */
  totalH: number
  rowCount: number
}

/**
 * 计算变行高窗口（行高序列由调用方给，**不做任何 DOM 测量**）。
 *
 * 复杂度 O(行数)：先累加一次前缀和再做线性扫描。2000 项 / 4 列 = 500 行，
 * 每帧 500 次浮点加法 ≈ 微秒级，没必要上二分 + 缓存（先简单，B4 若测出热点再换）。
 */
export function computeRowWindow(input: RowWindowInput): RowWindowOutput {
  const heights = input.rowHeights
  const rowCount = heights.length
  if (rowCount === 0) {
    return { startRow: 0, endRow: 0, offsetY: 0, totalH: 0, rowCount: 0 }
  }
  const gap = Math.max(0, finite(input.gap, 0))
  const overscan = nonNegativeInt(input.overscan ?? OVERSCAN_ROWS)
  const viewportH = Math.max(0, finite(input.viewportH, 0))

  // 前缀和：starts[i] = 第 i 行的顶部偏移（含前面所有的 gap）
  const starts = new Array<number>(rowCount + 1)
  starts[0] = 0
  for (let i = 0; i < rowCount; i++) {
    const h = Math.max(0, finite(heights[i]!, 0))
    starts[i + 1] = starts[i]! + h + gap
  }
  // 去掉最后一个多余的 gap：真实内容高度 = 行高之和 + (行数-1)*gap
  const totalH = Math.max(0, starts[rowCount]! - gap)
  const maxScrollTop = Math.max(0, totalH - viewportH)
  const scrollTop = Math.min(Math.max(0, finite(input.scrollTop, 0)), maxScrollTop)

  // 首个可见行：最后一个 top ≤ scrollTop 的行
  let first = 0
  while (first + 1 < rowCount && starts[first + 1]! <= scrollTop) first++
  // 最后一个可见行：下一个行的 top 仍在视口下沿之内的行
  let last = first
  while (last + 1 < rowCount && starts[last + 1]! < scrollTop + viewportH) last++

  let startRow = Math.max(0, first - overscan)
  let endRow = Math.min(rowCount - 1, last + overscan)
  if (input.pinnedRows && input.pinnedRows.size > 0) {
    for (const raw of input.pinnedRows) {
      if (!Number.isFinite(raw)) continue
      const r = Math.min(rowCount - 1, Math.max(0, Math.trunc(raw)))
      if (r < startRow) startRow = r
      if (r > endRow) endRow = r
    }
  }
  return { startRow, endRow, offsetY: starts[startRow]!, totalH, rowCount }
}
