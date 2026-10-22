/**
 * T-B1 虚拟滚动地基单测（被测对象：`src/renderer/logic/virtualWindow.ts`
 * 与 `src/renderer/logic/gridMetrics.ts`）。
 *
 * 断言纪律：全部是**手算值**（行高取整 100 / 190 这种整数，方便心里过一遍），
 * 不用"再调用一次被测函数"的方式自证。docs/20 §8 T-B1 点名的边界：
 * 0 行 / 1 行 / 末屏不满 / 超大 scrollTop —— 每条都有独立用例。
 */
import { describe, expect, it } from 'vitest'
import {
  COVER_ASPECT_4X3,
  COVER_ASPECT_SQUARE,
  CARD_BORDER_W,
  CARD_META_H,
  GRID_GAP,
  LIST_ROW_H,
  MIN_CARD_W,
  OVERSCAN_ROWS,
  cardHeightFor,
  columnsFor,
  coverAspectOf,
  gridRowHeights,
  listMetrics,
  metricsFor
} from '../src/renderer/logic/gridMetrics'
import {
  computeRowWindow,
  computeWindow,
  type VirtualWindowInput
} from '../src/renderer/logic/virtualWindow'

/** 常用基线：4 列、行高 100、视口 300（正好 3 行）、overscan 3 */
const BASE = { rowH: 100, columns: 4, viewportH: 300, overscan: 3 } as const

function win(over: Partial<VirtualWindowInput>): ReturnType<typeof computeWindow> {
  return computeWindow({ ...BASE, itemCount: 0, scrollTop: 0, ...over })
}

/** 窗口内实际会 slice 出的条数（闭区间 → 半开区间） */
function sliceCount(out: ReturnType<typeof computeWindow>, itemCount: number): number {
  return Math.max(0, Math.min(itemCount, out.endIndex + 1) - out.startIndex)
}

describe('logic/virtualWindow · 空 / 单条 / 恰好整行', () => {
  it('itemCount = 0 → 全 0，totalH = 0（不除零、不出 NaN）', () => {
    expect(win({ itemCount: 0 })).toEqual({
      startRow: 0,
      endRow: 0,
      startIndex: 0,
      endIndex: 0,
      offsetY: 0,
      totalH: 0,
      columns: 4
    })
  })

  it('itemCount = 1 → 一行、totalH = rowH、只取第 0 条', () => {
    const out = win({ itemCount: 1 })
    expect(out).toMatchObject({ startRow: 0, endRow: 0, startIndex: 0, endIndex: 0, offsetY: 0, totalH: 100 })
    expect(sliceCount(out, 1)).toBe(1)
  })

  it('itemCount = columns（恰好一整行）→ rowCount = 1，末条下标 = 3', () => {
    const out = win({ itemCount: 4 })
    expect(out.totalH).toBe(100)
    expect(out.endRow).toBe(0)
    expect(out.startIndex).toBe(0)
    expect(out.endIndex).toBe(3)
    expect(sliceCount(out, 4)).toBe(4)
  })

  it('itemCount 恰好铺满一屏（3 行 × 4 列 = 12）→ 不产生滚动，窗口即全量', () => {
    // viewportH=300、rowH=100 → 正好 3 行；scrollTop 给 150 也会被夹成 0（内容不足一屏）
    const out = win({ itemCount: 12, scrollTop: 150 })
    expect(out.totalH).toBe(300)
    expect(out).toMatchObject({ startRow: 0, endRow: 2, startIndex: 0, endIndex: 11, offsetY: 0 })
    expect(sliceCount(out, 12)).toBe(12)
  })
})

describe('logic/virtualWindow · scrollTop 边界 clamp', () => {
  it('负 scrollTop（橡皮筋 / 合成事件脏值）→ 按 0 处理', () => {
    const out = win({ itemCount: 40, scrollTop: -5000 })
    expect(out).toMatchObject({ startRow: 0, endRow: 5, offsetY: 0 })
    // 0 号行可见 + 3 行 overscan
    expect(out.endRow).toBe(0 + 3 - 1 + 3)
  })

  it('scrollTop 超尾 → 夹到 totalH - viewportH，末行不越界', () => {
    // 40 条 / 4 列 = 10 行 → totalH 1000；视口 300 → maxScrollTop 700
    const out = win({ itemCount: 40, scrollTop: 99_999 })
    expect(out.totalH).toBe(1000)
    // maxScrollTop=700 → 首可见行 7；可见 3 行 + overscan 3 → 4..9，末行夹到 9
    expect(out).toMatchObject({ startRow: 4, endRow: 9, offsetY: 400 })
    expect(out.endIndex).toBe(39)
    expect(out.startIndex).toBe(16)
  })

  it('小数 scrollTop（125% 缩放下 Chromium 会给小数）→ floor 到所在行', () => {
    expect(win({ itemCount: 40, scrollTop: 99.9 }).startRow).toBe(0)
    expect(win({ itemCount: 40, scrollTop: 100.1 }).startRow).toBe(0) // 100.1/100=1.001 → 首行 1，减 overscan 3 → 0
    expect(win({ itemCount: 80, scrollTop: 700 }).startRow).toBe(4) // 700/100=7 → 7-3=4
  })

  it('viewportH = 0（首帧尚未量到尺寸）→ 仍返回合法窗口，不出现空区间', () => {
    const out = win({ itemCount: 40, viewportH: 0, scrollTop: 0 })
    expect(out.startRow).toBe(0)
    expect(out.endRow).toBeGreaterThanOrEqual(out.startRow)
    expect(sliceCount(out, 40)).toBeGreaterThan(0)
  })
})

describe('logic/virtualWindow · overscan 与末行不满列', () => {
  it('overscan 再大也不越界：10 行末尾 + overscan 10 → endRow 夹到 rowCount-1', () => {
    // 5 条 / 2 列 = 3 行；overscan 10
    const out = win({ itemCount: 5, columns: 2, overscan: 10 })
    expect(out).toMatchObject({ startRow: 0, endRow: 2, startIndex: 0, endIndex: 4, totalH: 300 })
  })

  it('overscan = 0 → 窗口严格等于可见行（不多渲染）', () => {
    const out = win({ itemCount: 40, scrollTop: 500, overscan: 0 })
    // 500/100 = 首可见行 5；可见 3 行 → 5..7
    expect(out).toMatchObject({ startRow: 5, endRow: 7, offsetY: 500 })
  })

  it('末行不满列：10 条 / 4 列 → 渲染 3 行×4 列 = 12 个槽位，但只 slice 出 10 条', () => {
    const out = win({ itemCount: 10, viewportH: 400, overscan: 0 })
    expect(out).toMatchObject({ startRow: 0, endRow: 2, startIndex: 0, endIndex: 9 })
    expect(sliceCount(out, 10)).toBe(10)
    // 行数 × 列数 与切片条数的差额 = 最后一行空槽位数（12 - 10 = 2）
    expect((out.endRow - out.startRow + 1) * out.columns - sliceCount(out, 10)).toBe(2)
  })

  it('endIndex - startIndex + 1 在中间行也等于「行数 × 列数」', () => {
    // 400 条 / 4 列 = 100 行 → totalH 10000；视口 300 → maxScrollTop 9700（5000 不触发 clamp）
    const out = win({ itemCount: 400, columns: 4, rowH: 100, viewportH: 300, overscan: 2, scrollTop: 5000 })
    // 5000/100 = 首可见 50，末可见 52；overscan 2 → 48..54（7 行 × 4 列 = 28 条）
    expect(out.startRow).toBe(48)
    expect(out.endRow).toBe(54)
    expect(out.endIndex - out.startIndex + 1).toBe((54 - 48 + 1) * 4)
    expect(sliceCount(out, 400)).toBe(28)
  })
})

describe('logic/virtualWindow · 列表模式与网格共用同一函数', () => {
  it('columns = 1（列表：rowH 44）→ 与网格同样的行数学，一条一行', () => {
    const out = computeWindow({ itemCount: 100, columns: 1, rowH: LIST_ROW_H, viewportH: 440, scrollTop: 440, overscan: 3 })
    // 视口 440 / 行高 44 = 10 行可见；首可见行 10 → 7..22
    expect(out).toMatchObject({ startRow: 7, endRow: 22, startIndex: 7, endIndex: 22, offsetY: 308, totalH: 4400 })
    expect(sliceCount(out, 100)).toBe(16)
  })

  it('columns ≤ 0 / 非有限值 → 按 1 列处理（不产生 Infinity 行数）', () => {
    expect(win({ itemCount: 5, columns: 0 }).columns).toBe(1)
    expect(win({ itemCount: 5, columns: Number.NaN }).columns).toBe(1)
    expect(win({ itemCount: 5, columns: 0 }).totalH).toBe(500)
  })
})

describe('logic/virtualWindow · 加和关系与非法输入', () => {
  it('offsetY + 已渲染高度 ≤ totalH（逐点扫一遍）', () => {
    for (const scrollTop of [0, 1, 250, 999, 5000, 99_999]) {
      const out = win({ itemCount: 200, scrollTop })
      const renderedH = (out.endRow - out.startRow + 1) * 100
      expect(out.offsetY + renderedH).toBeLessThanOrEqual(out.totalH)
      expect(out.offsetY).toBe(out.startRow * 100)
    }
  })

  it('rowH / itemCount / viewportH 非法（0 / 负 / NaN）→ 输出全为有限数，不崩', () => {
    const out = win({ itemCount: Number.NaN, rowH: 0, viewportH: Number.NaN, scrollTop: Number.NaN })
    expect(out.totalH).toBe(0)
    for (const v of Object.values(out)) expect(Number.isFinite(v)).toBe(true)
    // 行高非法 → 兜底 1（1 条 = 1 行 = 高 1），不会算出 totalH 0 或 Infinity
    expect(win({ itemCount: 1, rowH: -5, viewportH: -1 }).totalH).toBe(1)
    expect(win({ itemCount: 1, rowH: Number.POSITIVE_INFINITY }).totalH).toBe(1)
  })

  it('2000 项、视口 800、行高 190、4 列：滚到尾部不溢出安全整数', () => {
    // 500 行 → totalH 95000；maxScrollTop = 95000-800 = 94200 → 首可见行 495
    const out = computeWindow({ itemCount: 2000, columns: 4, rowH: 190, viewportH: 800, scrollTop: 94200, overscan: 3 })
    expect(out).toMatchObject({ totalH: 95_000, startRow: 492, endRow: 499, offsetY: 93_480 })
    expect(out.startIndex).toBe(1968)
    expect(out.endIndex).toBe(1999)
    expect(Number.isSafeInteger(out.totalH)).toBe(true)
    expect(Number.isSafeInteger(out.endIndex)).toBe(true)
    expect(out.offsetY + (out.endRow - out.startRow + 1) * 190).toBe(95_000)
  })
})

describe('logic/virtualWindow · computeRowWindow（变行高，网格用）', () => {
  it('空行数组 → 全 0，totalH = 0', () => {
    expect(computeRowWindow({ rowHeights: [], scrollTop: 0, viewportH: 800, gap: 14 })).toEqual({
      startRow: 0,
      endRow: 0,
      offsetY: 0,
      totalH: 0,
      rowCount: 0
    })
  })

  it('单行 → totalH = 该行高（没有尾部 gap）', () => {
    const out = computeRowWindow({ rowHeights: [100], scrollTop: 0, viewportH: 300, gap: 14 })
    expect(out).toMatchObject({ startRow: 0, endRow: 0, offsetY: 0, totalH: 100, rowCount: 1 })
  })

  it('恰好一屏：4 行 × 100 + 3×gap14 = 442，视口 442 → 不滚动', () => {
    const out = computeRowWindow({
      rowHeights: [100, 100, 100, 100],
      scrollTop: 500, // 内容不足一屏 → 夹到 0
      viewportH: 442,
      gap: 14
    })
    expect(out).toMatchObject({ startRow: 0, endRow: 3, offsetY: 0, totalH: 442 })
  })

  it('滚到中间：10 行 ×100 + gap14，scrollTop 500 / 视口 300 → 行 1..9', () => {
    // starts = [0,114,228,342,456,570,684,798,912,1026]，totalH = 1140-14 = 1126
    const out = computeRowWindow({
      rowHeights: Array.from({ length: 10 }, () => 100),
      scrollTop: 500,
      viewportH: 300,
      gap: 14,
      overscan: 3
    })
    // 首可见行：starts[5]=570 > 500 → 4；末可见：starts[8]=912 ≥ 800 → 7；overscan 3 → 1..9
    expect(out).toMatchObject({ startRow: 1, endRow: 9, offsetY: 114, totalH: 1126, rowCount: 10 })
  })

  it('变行高混排：高 100/200/100 → 第 2 行顶部 = 100+14 = 114', () => {
    const out = computeRowWindow({
      rowHeights: [100, 200, 100],
      scrollTop: 114,
      viewportH: 150,
      gap: 14,
      overscan: 0
    })
    expect(out).toMatchObject({ startRow: 1, endRow: 1, offsetY: 114, totalH: 428 })
  })

  it('overscan 越界不溢出：3 行 + overscan 10 → endRow 夹到 2', () => {
    const out = computeRowWindow({
      rowHeights: [100, 100, 100],
      scrollTop: 0,
      viewportH: 100,
      gap: 0,
      overscan: 10
    })
    expect(out).toMatchObject({ startRow: 0, endRow: 2 })
  })

  it('scrollTop 超尾 → 夹到 totalH - viewportH（末行仍可见）', () => {
    const out = computeRowWindow({
      rowHeights: Array.from({ length: 20 }, () => 100),
      scrollTop: 99_999,
      viewportH: 250,
      gap: 0,
      overscan: 0
    })
    // totalH 2000 → maxScroll 1750 → 首行 17，末行 19
    expect(out).toMatchObject({ startRow: 17, endRow: 19, totalH: 2000 })
  })

  it('pinnedRows 把目标行并入区间（区间仍连续：这里 3..51）', () => {
    // 100 行 × 100、gap 0、视口 200、scrollTop 5000 → 可见 50..51
    const heights = Array.from({ length: 100 }, () => 100)
    const withoutPin = computeRowWindow({ rowHeights: heights, scrollTop: 5000, viewportH: 200, gap: 0, overscan: 0 })
    expect(withoutPin).toMatchObject({ startRow: 50, endRow: 51 })
    const pinned = computeRowWindow({
      rowHeights: heights,
      scrollTop: 5000,
      viewportH: 200,
      gap: 0,
      overscan: 0,
      pinnedRows: new Set([3])
    })
    expect(pinned).toMatchObject({ startRow: 3, endRow: 51, offsetY: 300 })
  })

  it('viewportH = 0（首帧）→ 仍至少给一行，不出现 startRow > endRow', () => {
    const out = computeRowWindow({ rowHeights: [100, 120, 90], scrollTop: 0, viewportH: 0, gap: 14 })
    expect(out.startRow).toBe(0)
    expect(out.endRow).toBeGreaterThanOrEqual(out.startRow)
    expect(out.totalH).toBe(310 + 28)
  })
})

describe('logic/virtualWindow · computeWindow 的 pinnedRows（T-B2 只加能力）', () => {
  it('窗口在尾部时，pin 首行会把 startRow 拉到 0（DOM 代价见函数注释）', () => {
    const base = { itemCount: 400, columns: 4, rowH: 100, viewportH: 300, scrollTop: 5000, overscan: 2 }
    expect(computeWindow(base)).toMatchObject({ startRow: 48, endRow: 54 })
    expect(computeWindow({ ...base, pinnedRows: new Set([0]) })).toMatchObject({
      startRow: 0,
      startIndex: 0,
      endRow: 54,
      endIndex: 219
    })
  })

  it('越界 / 非有限的 pin 被忽略或夹住', () => {
    const out = computeWindow({
      itemCount: 8,
      columns: 4,
      rowH: 100,
      viewportH: 100,
      scrollTop: 0,
      overscan: 0,
      pinnedRows: new Set([999, -5, Number.NaN])
    })
    // 999 → 夹到 1（末行）；-5 → 夹到 0；NaN 忽略
    expect(out).toMatchObject({ startRow: 0, endRow: 1 })
  })
})

describe('logic/gridMetrics · 逐行高度（封面统一 4:3，2026-10-22 起不再按 kind 分化）', () => {
  it('coverAspectOf：所有大类恒为 4:3（1:1 已废弃）', () => {
    // 2026-10-22 用户拍板（TODO-5 方案 A）：封面框统一 `aspect-[4/3]`，
    // 1:1 球图改由图片层 `object-contain` 装进 4:3 框（两侧留 `bg-canvas`）。
    // → 这里必须与 `AssetGrid` 卡片模板的唯一 aspect 类同步；若有人把比例按 kind
    //   分化回来，行高会比卡片内容矮，名称/元信息行会被虚拟行高裁掉（2026-10-21 实测过）。
    expect(coverAspectOf('material')).toBe(COVER_ASPECT_4X3)
    expect(coverAspectOf('texture')).toBe(COVER_ASPECT_4X3)
    expect(coverAspectOf('model')).toBe(COVER_ASPECT_4X3)
    expect(coverAspectOf('hdri')).toBe(COVER_ASPECT_4X3)
    // 反向守卫：没有任何大类还在走 1:1（否则标题又会高低不齐）
    expect(coverAspectOf('material')).not.toBe(COVER_ASPECT_SQUARE)
    expect(coverAspectOf('texture')).not.toBe(COVER_ASPECT_SQUARE)
  })

  it('cardHeightFor 含 1px 描边：(204.5-2)×1+63+2 = 267.5；4:3 → 216.875', () => {
    expect(CARD_BORDER_W).toBe(1)
    expect(cardHeightFor(204.5, 1)).toBeCloseTo(267.5, 6)
    expect(cardHeightFor(204.5, 0.75)).toBeCloseTo(216.875, 6)
    // 不取整：浮点累加才不漂
    expect(Number.isInteger(cardHeightFor(204.5, 0.75))).toBe(false)
  })

  it('gridRowHeights 按列切块；统一 4:3 后每行等高（与 kind 混排无关）', () => {
    // 2026-10-22 起所有大类都是 4:3 → 材质卡不再把整行顶高 25%
    const kinds = ['model', 'texture', 'model', 'material', 'material', 'model'] as const
    const rows = gridRowHeights([...kinds], 4, 204.5)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBeCloseTo(216.875, 6)
    expect(rows[1]).toBeCloseTo(216.875, 6)
    expect(gridRowHeights(['model', 'hdri', 'other'], 3, 204.5)[0]).toBeCloseTo(216.875, 6)
    // 回归守卫：含 texture / material 的行也必须是 4:3 的行高（1:1 会把行高顶到 267.5）
    expect(gridRowHeights(['texture', 'model', 'model'], 3, 204.5)[0]).toBeCloseTo(216.875, 6)
    expect(gridRowHeights(['material', 'material'], 2, 204.5)[0]).toBeCloseTo(216.875, 6)
  })

  it('gridRowHeights：末行不满列也照算（入口条数不对齐时不会多出一行）', () => {
    expect(gridRowHeights(['model', 'model', 'model'], 4, 204.5)).toHaveLength(1)
    expect(gridRowHeights([], 4, 204.5)).toEqual([])
  })

  it('rowPitch = rowH + gap（列表 gap 0 → pitch = 44）', () => {
    expect(metricsFor('medium', 860).rowPitch).toBe(metricsFor('medium', 860).rowH + GRID_GAP)
    expect(listMetrics(860).rowPitch).toBe(LIST_ROW_H)
  })
})

describe('logic/gridMetrics · 与 AssetGrid 的 CSS 同源', () => {
  it('三档最小卡宽与 AssetGrid.tsx 的 GRID_COLS minmax 下限一致（240 / 184 / 132）', () => {
    expect(MIN_CARD_W).toEqual({ large: 240, medium: 184, small: 132 })
    expect(GRID_GAP).toBe(14) // = styles.css `--gap-card`
    expect(OVERSCAN_ROWS).toBe(3)
    expect(LIST_ROW_H).toBe(44)
    // 2026-10-22（TODO-5 方案 A）：标题固定两行 → 元信息区 48 → 63
    // （16 padding + 2×15 标题 + 2 gap + 15 副行）。AssetGrid 卡片模板同步写 `h-[63px]`。
    expect(CARD_META_H).toBe(63)
  })

  it('columnsFor 复刻 CSS auto-fill：max(1, floor((W+gap)/(minW+gap)))', () => {
    // 内容宽 860（900 中栏扣掉 px-5 的左右 20+20）
    expect(columnsFor(860, 184)).toBe(4) // floor(874/198) = 4
    expect(columnsFor(860, 240)).toBe(3) // floor(874/254) = 3
    expect(columnsFor(860, 132)).toBe(5) // floor(874/146) = 5
    expect(columnsFor(100, 240)).toBe(1) // 放不下一列也要给 1 列
    expect(columnsFor(0, 184)).toBe(1)
    expect(columnsFor(Number.NaN, 184)).toBe(1)
  })

  it('metricsFor：列宽摊平 + 行高取整（medium / 860 → 4 列、204.5、217）', () => {
    const m = metricsFor('medium', 860)
    expect(m.columns).toBe(4)
    expect(m.cardW).toBeCloseTo(204.5, 5) // (860 - 3*14) / 4
    // (204.5-2)×0.75 + 63 + 2 = 216.875 → ceil 217（默认比例已是 4:3）
    expect(m.rowH).toBe(217)
    expect(m.gap).toBe(14)
    expect(m.coverAspect).toBe(COVER_ASPECT_4X3)
  })

  it('metricsFor：大 / 小两档（860 宽 → 大 3 列、小 5 列）', () => {
    const large = metricsFor('large', 860)
    expect(large.columns).toBe(3)
    expect(large.cardW).toBeCloseTo((860 - 2 * 14) / 3, 5)
    // (277.33-2)×0.75 + 65 = 271.5 → ceil 272
    expect(large.rowH).toBe(272)

    const small = metricsFor('small', 860)
    expect(small.columns).toBe(5)
    expect(small.cardW).toBeCloseTo((860 - 4 * 14) / 5, 5)
    // (160.8-2)×0.75 + 65 = 184.1 → ceil 185
    expect(small.rowH).toBe(185)
  })

  it('metricsFor：未知容器宽度 → 单列、cardW = 该档最小宽（保守值，不会算成 0）', () => {
    // 184 宽：(184-2)×0.75 + 65 = 201.5 → 202；240 宽：(240-2)×0.75 + 65 = 243.5 → 244
    expect(metricsFor('medium')).toMatchObject({ columns: 1, cardW: 184, rowH: 202 })
    expect(metricsFor('large')).toMatchObject({ columns: 1, cardW: 240, rowH: 244 })
  })

  it('metricsFor：显式传 4:3 与默认值等价（默认就是这个比例，不必再硬传）', () => {
    const m = metricsFor('medium', 860, COVER_ASPECT_4X3)
    expect(m.coverAspect).toBe(COVER_ASPECT_4X3)
    expect(m.rowH).toBe(217)
    expect(m.rowH).toBe(metricsFor('medium', 860).rowH)
  })

  it('listMetrics：columns 1 / rowH 44 / gap 0（与网格共用同一窗口函数）', () => {
    expect(listMetrics(860)).toMatchObject({ columns: 1, rowH: 44, gap: 0, cardW: 860 })
    expect(listMetrics(860).rowH).toBe(LIST_ROW_H)
  })
})
