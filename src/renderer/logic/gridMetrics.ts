/**
 * 网格 / 列表的**度量常量**（docs/20 §3.2，T-B1 虚拟滚动地基）。
 *
 * ⚠️ 单一事实源纪律：
 * 这里的三档最小卡宽必须与 `components/AssetGrid.tsx` 的 `GRID_COLS`
 * （`grid-cols-[repeat(auto-fill,minmax(240px|184px|132px,1fr))]`）**逐字一致**；
 * `GRID_GAP` 必须等于 `styles.css` 的 `--gap-card: 14px`
 * （`tailwind.config.js` 的 `extend.spacing.card` 把它映射成 `gap-card`）；
 * 卡片元信息区高度必须等于卡片模板 `px-2.5 py-2` + **两行标题**（2×`leading-[15px]`）
 * + `mt-0.5` + 11px 副行，即 `CARD_META_H`（见下）。
 *
 * **改一处必须同步另一处**（CSS 与这里没有编译期约束，只能靠纪律 + 单测钉住）。
 * 这也是 docs/20 §3.2「抽成共享常量避免两处漂移」的落点：B2 接线后
 * `AssetGrid` 的网格模板与虚拟窗口计算都读本文件，不再各写一份。
 */
import type { AssetKind, GridDensity } from '../../shared/types'

/** 网格卡片间距（= `--gap-card`，反馈 B5#16 画布实测 14） */
export const GRID_GAP = 14

/**
 * 网格滚动容器的左右内边距合计（`px-5` = 20 + 20）。
 * `clientWidth` 含 padding，算列宽前必须扣掉它。
 */
export const GRID_PAD_X = 40

/** 列表滚动容器的左右内边距合计（`px-4` = 16 + 16） */
export const LIST_PAD_X = 32

/** 列表视图行高（现有表格 `px-3 py-2` + `text-sm` 的既定值；docs/20 §3.2：列表 = columns 1 / rowH 44） */
export const LIST_ROW_H = 44

/** 虚拟窗口两端各多渲染几行（滚动时不露白；同时限制 DOM 卡片数） */
export const OVERSCAN_ROWS = 3

/**
 * 卡片边框宽度（`.card-surface { border: 1px solid transparent }`，两主题都是 1px）。
 *
 * 为什么单独列出来：卡片 `box-sizing: border-box`（Tailwind preflight），
 * 封面 `aspect-*` 的宽度是**内容宽** = 卡宽 − 2×border，差这 1–2px 会让行高
 * 每行偏 0.5px，滚到第 100 行就偏 50px（虚拟窗口会露白）。
 */
export const CARD_BORDER_W = 1

/**
 * 卡片封面下方元信息区的固定高度：`px-2.5 py-2`（上下各 8 = 16）
 * + **标题两行**（2 × 12px 字号 / `leading-[15px]` = 30）+ `mt-0.5`（2）
 * + 11px 副行（`leading-[15px]` = 15）= 16 + 30 + 2 + 15 = **63**。
 *
 * ⚠️ 2026-10-22（TODO-5 方案 A）：标题从「单行截断」改成「`line-clamp-2` +
 * `min-h-[30px]` 恒定两行」——只有一行的名字也占满两行，同一网格里所有卡片的
 * 标题基线才恒等。元信息区因此由 48 → 63，本常量必须同步，否则
 * `gridTemplateRows` 会按 48 钉死行高、**标题第二行被裁掉**。
 *
 * ⚠️ 两行文字的 line-height 必须在 JSX 里写死（见 `AssetGrid` 的卡片模板）：
 * 用默认 `line-height: normal` 时高度随字体（Sarasa / 微软雅黑 / 回退字体）浮动 2–4px，
 * 累积到几十行就是几百像素的偏移 —— 虚拟化会露白或叠行。
 */
export const CARD_META_H = 63

/**
 * 方形封面比例（`aspect-square` = 1）。
 *
 * ⚠️ 2026-10-22 起**行高计算不再使用**：封面框已统一 4:3（`COVER_ASPECT_4X3`），
 * 材质球那张 1:1 方图改由图片层 `object-contain` 完整装进 4:3 框（两侧留 `bg-canvas`）。
 * 常量保留给仍有 1:1 预览区的调用方（详情面板 / 文件视图磁贴）与对照测试用。
 */
export const COVER_ASPECT_SQUARE = 1

/** 卡片封面比例：`aspect-[4/3]` = 0.75（2026-10-22 起**全网格唯一比例**） */
export const COVER_ASPECT_4X3 = 0.75

/**
 * 计算行高时采用的封面比例 —— **恒为 4:3**（`COVER_ASPECT_4X3`）。
 *
 * 沿革：2026-10-21 材质/贴图卡曾改成 1:1（1:1 球图塞进 4:3 框会被 `object-cover`
 * 裁掉上下），那时这里取 1（最坏情况）才能让行高不矮于卡片。2026-10-22 用户拍板
 * 反转成「统一 4:3 + `object-contain`」——裁切问题由 object-fit 解决，不再需要
 * 按 kind 分化比例；`AssetGrid` 的卡片模板也只有 `aspect-[4/3]` 一种。
 * 于是这里与卡片模板重新**逐字一致**，`AssetGrid` 不必再硬传比例覆盖默认值。
 */
export const DEFAULT_COVER_ASPECT = COVER_ASPECT_4X3

/**
 * 单个大类卡片的封面比例（必须与 `AssetGrid` 卡片模板里的 `aspect-*` 类**逐字对应**）。
 *
 * ⚠️ 2026-10-22 起恒返回 `COVER_ASPECT_4X3`：所有大类同一个 4:3 框，封面图一律
 * `object-contain`，因此**不存在**「行高按 4:3 算、卡片按 1:1 画」那种错配。
 *
 * `_kind` 参数保留（不从签名里删）：`gridRowHeights` 仍按 kind 逐个取比例、
 * 测试也按 kind 断言；将来若某个大类需要特殊比例，改这里一处就能恢复分化，
 * 而不用改一圈调用方。
 */
export function coverAspectOf(_kind: AssetKind): number {
  return COVER_ASPECT_4X3
}

/**
 * 一张卡片的**精确高度**（border-box）：
 * 封面内容宽 × 比例 + 元信息区 + 上下描边。
 *
 * 封面 `<div class="aspect-*">` 的宽度 = 卡宽 − 2×`CARD_BORDER_W`（border-box），
 * 所以是 `(cardW - 2b) * aspect + CARD_META_H + 2b`，不是 `cardW * aspect + meta`。
 * 不取整：虚拟窗口的偏移要做浮点累加，取整会让每行偏 0.5px、几十行后露白。
 */
export function cardHeightFor(cardW: number, aspect: number): number {
  const w = Number.isFinite(cardW) && cardW > 0 ? cardW : MIN_CARD_W.medium
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_COVER_ASPECT
  const inner = Math.max(0, w - 2 * CARD_BORDER_W)
  return inner * a + CARD_META_H + 2 * CARD_BORDER_W
}

/**
 * 网格的**逐行高度**（不含 gap）—— 虚拟滚动真实使用的行高序列。
 *
 * 为什么仍是「逐行算」而不是「一个固定值」：签名与调用方保持稳定（`AssetGrid` 传
 * 可见集的 kind 序列），而行数本来就由条目数 + 列数决定。
 * 2026-10-22 起所有大类比例都是 4:3（`coverAspectOf` 恒等），所以每行高度**数值相同**；
 * 这里保留 `Math.max(...)` 的写法，是为了将来某个大类恢复特殊比例时不必改结构。
 *
 * @param kinds 按渲染顺序排列的资产大类（只用于按列切行）
 * @param columns 列数（来自 `metricsFor(...).columns`）
 * @param cardW 卡宽（来自 `metricsFor(...).cardW`）
 */
export function gridRowHeights(
  kinds: readonly AssetKind[],
  columns: number,
  cardW: number
): number[] {
  const cols = Math.max(1, Math.trunc(Number.isFinite(columns) ? columns : 1))
  const out: number[] = []
  for (let i = 0; i < kinds.length; i += cols) {
    let aspect = COVER_ASPECT_4X3
    for (let j = i; j < Math.min(i + cols, kinds.length); j++) {
      aspect = Math.max(aspect, coverAspectOf(kinds[j]!))
    }
    out.push(cardHeightFor(cardW, aspect))
  }
  return out
}

/** 三档密度 → 卡片最小宽度（= Tailwind `minmax` 下限，反馈 6b：240 / 184 / 132） */
export const MIN_CARD_W: Readonly<Record<GridDensity, number>> = {
  large: 240,
  medium: 184,
  small: 132
}

/** 一档密度的完整度量（虚拟窗口只要 `rowH` / `rowPitch` / `columns`，卡片渲染要 `cardW` / `gap`） */
export interface GridMetrics {
  /** 该档的 `minmax` 下限 */
  minCardW: number
  /** 实际卡片宽度（按容器宽度摊平后的列宽；未知容器宽度时 = minCardW） */
  cardW: number
  /** 单行卡片高度（取整；含 1px 描边。逐行精确值请用 `gridRowHeights`） */
  rowH: number
  /** 行**间距**（含 gap）= `rowH + gap`，可直接当虚拟窗口的固定行走高用 */
  rowPitch: number
  /** 网格 gap（列表为 0） */
  gap: number
  /** 列数 = max(1, floor((W + gap) / (minCardW + gap)))，未知容器宽度时 1 */
  columns: number
  /** 本度量采用的封面宽高比（信息性字段，便于调用方复核） */
  coverAspect: number
}

/** CSS `auto-fill` 的列数公式：`max(1, floor((W + gap) / (minW + gap)))` */
export function columnsFor(containerW: number, minCardW: number, gap: number = GRID_GAP): number {
  const w = Number.isFinite(containerW) ? containerW : 0
  const minW = Number.isFinite(minCardW) && minCardW > 0 ? minCardW : MIN_CARD_W.medium
  const g = Number.isFinite(gap) && gap >= 0 ? gap : GRID_GAP
  if (!(w > 0)) return 1
  return Math.max(1, Math.floor((w + g) / (minW + g)))
}

/**
 * 取一档密度的度量。
 *
 * @param density 三档之一
 * @param containerW 滚动容器的**内容宽度**（已扣掉容器左右 padding），缺省按单列算
 * @param coverAspect 封面比例，默认 `DEFAULT_COVER_ASPECT`（= 4:3，与卡片模板唯一比例一致）
 */
export function metricsFor(
  density: GridDensity,
  containerW?: number,
  coverAspect: number = DEFAULT_COVER_ASPECT
): GridMetrics {
  const minCardW = MIN_CARD_W[density] ?? MIN_CARD_W.medium
  const aspect = Number.isFinite(coverAspect) && coverAspect > 0 ? coverAspect : DEFAULT_COVER_ASPECT
  const known = typeof containerW === 'number' && Number.isFinite(containerW) && containerW > 0
  const columns = known ? columnsFor(containerW, minCardW, GRID_GAP) : 1
  // 列宽摊平：W 扣掉 (columns-1) 个 gap 后均分（与 CSS 1fr 的行为一致）
  const cardW = known ? Math.max(1, (containerW - (columns - 1) * GRID_GAP) / columns) : minCardW
  const rowH = Math.ceil(cardHeightFor(cardW, aspect))
  return {
    minCardW,
    cardW,
    rowH,
    rowPitch: rowH + GRID_GAP,
    gap: GRID_GAP,
    columns,
    coverAspect: aspect
  }
}

/**
 * 列表视图的度量：**与网格走同一个 `metricsFor` 的数学**，只是 columns 固定 1、行高定死 44。
 * （docs/20 §3.2「列表 = columns:1, rowH:44，同一个 hook、同一个 computeWindow」）
 */
export function listMetrics(containerW?: number): GridMetrics {
  const w = typeof containerW === 'number' && Number.isFinite(containerW) && containerW > 0 ? containerW : 0
  return {
    minCardW: w,
    cardW: w,
    rowH: LIST_ROW_H,
    rowPitch: LIST_ROW_H,
    gap: 0,
    columns: 1,
    coverAspect: 0
  }
}
