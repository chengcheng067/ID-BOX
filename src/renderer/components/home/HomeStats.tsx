import './home-stats.css'

/**
 * 首页右上「素材库概览」—— **一张** 1:1 方形圆角磨砂玻璃卡，内含**竖向三行**数字。
 *
 * ── 用户原话（V1.0 收敛轮，逐字）──────────────────────────────────────────────
 *   「先把下方的这个看板去掉，V1.0 版本不上这个东西，需要再打磨一下细节再上。」
 *   「上面的三个数据，我认为应该在一个圆角矩形里面。现在是一个偏矩形的比例，
 *     所以我们要改成 1:1 的。」
 *
 * 本轮据此做两件事，且**只**做这两件：
 *   ① **删掉下面那张卡**（分类占比环 + 图例）—— V1.0 不发布，细节打磨后再上。
 *      环形图 SVG、dash 计算、5 段配色表、图例与其全部 CSS 一并删除；
 *      V1.0 组件里**不留**任何"已弃用"的注释块（它们描述的是已不存在的实现，
 *      留在代码里只会误导下一个读代码的人）。
 *   ② 剩下的三个数字卡从「316 × 70 的横条」改成 **176 × 176 的正方形**，
 *      内部改为**竖向三行**：数值在左、标签在右，行间用 1px 分隔线。
 *      ⚠️ 不是把横条硬拉成 316×316 —— 那样三行数字会挤在顶上、中间空一大片；
 *      改成收窄到 176 的方卡，三行正好把 140px 的内容高度吃满（算式见 CSS）。
 *
 * ── 契约：纯展示组件 ──────────────────────────────────────────────────────────
 * 不读 store、不发 IPC、不请求网络、不引第三方图表库。数据全部由 `HomeCover` 透传。
 *
 * ── 为什么 props 里用的是内联结构类型，而不是 `import type { HomeFolderItem }`
 * `HomeCover` 会 import 本组件；若本组件再 import `HomeCover` 的类型，
 * 两个文件就成模图上的双向边。这里用**结构等价**的 inline 类型：
 * `HomeFolderItem` / `HomeStatsData` 天然满足它（TS 结构化子类型），
 * 调用方一行不用改。
 */

/**
 * 本卡的 props。
 *
 * ⚠️ `folders` **保留在契约里**，但 V1.0 不再使用它：
 * 它原本只服务于「分类占比环」，而占比环这一轮按产品要求下架了。
 * 为什么不直接从签名里删掉 —— 父级 `HomeCover` 现在仍在传 `folders={folders}`，
 * 删字段会要求父级同步改动；而占比环只是"V1.1 打磨后再上"，
 * 到时候恢复时父级又要改回来。**保持签名不动**是这轮成本最低、回退最干净的做法。
 */
export interface HomeStatsProps {
  /** 三个总量：本月入库 / 库总量 / 待补分类 */
  stats: { monthImports: number; totalAssets: number; pendingCategory: number }
  /** 首页 5 个文件夹（V1.0 未使用；保留在契约里，见上面的说明） */
  folders: Array<{ key: string; label: string; count: number }>
}

/**
 * 看板数值的简写口径：≤ 9999 原样，超过则折成「1.2万」，≥ 100 万取整。
 *
 * 这个函数是从 `HomeCover.tsx` 整体搬过来的（原处已删除），口径一个字没改：
 *   · 不放进 `shared/format.ts` —— 那个文件是跨组件共用的展示层工具，
 *     而"超过一万折万"目前只有首页看板这一处口径，放进去会诱导别处误用
 *     （例如资产计数 `12 项` 不该被折成 `12`）；
 *   · `tabular-nums`（见 CSS）保证三个数字纵向对齐，不随 `0`/`1` 的宽度抖动。
 */
function formatStatValue(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  const v = Math.floor(n)
  if (v <= 9999) return String(v)
  const wan = v / 10000
  // ≥ 100 万时小数位没有意义（100.4万 → 100万），避免把卡片撑宽
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)}万`
}

/**
 * 三个数字：顺序是产品口径固定的（本月入库 / 库总量 / 待补分类），不要在 JSX 里重排。
 * 行序 = 这个数组的顺序；分隔线由 CSS 的 `.hs-stat + .hs-stat` 自动生成，
 * 因此**不要**在 JSX 里插 `divider` 元素（那会让"三块"变成"六个盒子"，
 * 也让 flex 的 `space-between` 把空隙算到分隔线两侧）。
 */
const STAT_ITEMS: ReadonlyArray<{ label: string; valueKey: keyof HomeStatsProps['stats'] }> = [
  { label: '本月入库', valueKey: 'monthImports' },
  { label: '库总量', valueKey: 'totalAssets' },
  { label: '待补分类', valueKey: 'pendingCategory' }
]

/**
 * 素材库概览（纯展示，V1.0）。
 *
 * @param props 见 `HomeStatsProps`（本组件只消费 `props.stats`）
 * @returns 一张绝对定位的 1:1 方卡：竖向三行「数值 + 标签」，行间 1px 分隔线
 */
export function HomeStats({ stats }: HomeStatsProps): JSX.Element {
  return (
    /* 根节点即卡片本身：「绝对定位 + 右边缘对齐」与「1:1 尺寸 + 三行布局」
       都落在这一张卡上，不再有外层容器。
       `role="group"` + aria-label 让读屏软件把这三行念成"素材库概览"一组数据，
       而不是念成三段互不相干的文字。 */
    <section className="hs-card hs-card--stats" role="group" aria-label="素材库概览">
      {STAT_ITEMS.map((item) => (
        <div key={item.label} className="hs-stat">
          <span className="hs-stat-value">{formatStatValue(stats[item.valueKey])}</span>
          <span className="hs-stat-label">{item.label}</span>
        </div>
      ))}
    </section>
  )
}
