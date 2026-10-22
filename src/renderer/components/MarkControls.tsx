/**
 * v0.4 资产标记控件（收藏 / 评分 / 色标）——侧栏、卡片、详情面板共用。
 *
 * 为什么单独抽一个组件文件：三个入口（Sidebar 色标筛选、AssetGrid 卡片角标、
 * DetailPanel 标记区）必须**同一套视觉与同一套色标映射**；复制三份迟早漂移
 * （色标少一个 / 星标点击语义不一致）。这里只放纯展示控件，状态由调用方持有。
 *
 * 色标取色的取舍（重要，见交付报告）：
 * 设计 token 只有 `--accent`（蓝）/ `--danger`（红）/ `--success`（绿）三种语义色，
 * 规范正文还明确「禁用橙色、紫色高亮」，而产品要 6 个色标。因此这里**不新增任何
 * 十六进制**：统一用 `--accent` 作基底，仅用 CSS `hue-rotate` 派生 6 个色相
 * （蓝 0° / 紫 50° / 红 150° / 橙 175° / 黄 200° / 绿 270°）。
 * 好处：① 零硬编码色值；② 深浅主题自动跟随（--accent 两套值只差明度）。
 * 代价：色相是派生值，不是设计稿里的品牌色——若后续规范补 6 个色标 token，
 * 只需改 `HUE` 这一张表即可整体切换。
 */
import { COLOR_TAGS, COLOR_TAG_LABEL, type ColorTag } from '../../shared/types'

/** `--accent` 的色相偏移（基底 #007AFF ≈ 211°，见上方注释） */
const HUE_ROTATE: Record<ColorTag, number> = {
  blue: 0,
  purple: 50,
  red: 150,
  orange: 175,
  yellow: 200,
  green: 270
}

/** 单个色标的行内样式（调用方直接铺在色点/竖条上） */
export function colorSwatchStyle(tag: ColorTag): { backgroundColor: string; filter: string } {
  return {
    backgroundColor: 'var(--accent)',
    filter: `hue-rotate(${HUE_ROTATE[tag]}deg)`
  }
}

/**
 * 色点（默认 10px）。
 * `active` 用「卡片底色描边 + accent 外圈」表示选中，不依赖文字色继承。
 */
export function ColorDot({
  tag,
  size = 10,
  active = false,
  title
}: {
  tag: ColorTag
  size?: number
  active?: boolean
  title?: string
}) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title ?? COLOR_TAG_LABEL[tag]}
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        ...colorSwatchStyle(tag),
        ...(active
          ? { boxShadow: '0 0 0 2px var(--surface-card), 0 0 0 3.5px var(--accent)' }
          : {})
      }}
    />
  )
}

/**
 * 色标选择器：6 个色点，可多选（侧栏筛选）也可当单选开关（详情面板：点已选中的再点一次取消）。
 * `onClear` 存在时显示「清除」（仅多选筛选场景需要）。
 *
 * 2026-10-21 走查 P2⑨：中栏头浮层里的色点只有 12px，肉眼要凑近才点得准。
 * 非紧凑档（浮层 / 详情面板）点击区从 20px 提到 22px、默认色点从 12 提到 13，
 * 浮层里再显式传 `size={16}`；容器加 `flex-wrap` —— 放宽后 6 个点 + 「清除」在
 * 窄面板里宁可折行，也不要挤成一条看不清的点线。紧凑档（侧栏）不变。
 */
export function ColorTagPicker({
  selected,
  onToggle,
  onClear,
  size = 13,
  compact = false,
  className = ''
}: {
  selected: readonly ColorTag[]
  onToggle: (tag: ColorTag) => void
  onClear?: () => void
  size?: number
  /** 紧凑档：16px 点击区 + `gap-1`（侧栏 216px 宽内放 6 个色点不换行） */
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={`flex items-center ${compact ? 'gap-1' : 'flex-wrap gap-1.5'} ${className}`}
    >
      {COLOR_TAGS.map((tag) => {
        const active = selected.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            className={`flex shrink-0 items-center justify-center rounded-full transition hover:bg-elevated/60 ${
              compact ? 'h-4 w-4' : 'h-[22px] w-[22px]'
            }`}
            aria-pressed={active}
            title={`${COLOR_TAG_LABEL[tag]}色${active ? '（再点取消）' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(tag)
            }}
          >
            <ColorDot tag={tag} size={compact ? Math.min(size, 9) : size} active={active} />
          </button>
        )
      })}
      {onClear && (
        <button
          type="button"
          className="ml-0.5 rounded px-1 text-[11px] text-muted transition hover:text-primary"
          title="清除色标筛选"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
        >
          清除
        </button>
      )}
    </div>
  )
}

/** 单颗星（filled = 实心）。尺寸由 width/height 控制，颜色继承 currentColor */
export function StarIcon({
  filled,
  size = 14
}: {
  filled: boolean
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.44 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95z" />
    </svg>
  )
}

/**
 * 5 星评分：点第 N 颗 → rating = N；**再点同一颗 → 0**（清除）。
 * `value` 直接用资产上的 rating（0–5），这里不再夹紧（store 侧 normalizeRating 兜底）。
 */
export function StarRating({
  value,
  onChange,
  size = 16
}: {
  value: number
  onChange: (next: number) => void
  size?: number
}) {
  const current = Math.min(5, Math.max(0, Math.round(value)))
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= current
        return (
          <button
            key={n}
            type="button"
            className={`rounded p-0.5 transition hover:bg-elevated/60 ${
              filled ? 'text-accent' : 'text-tertiary'
            }`}
            title={current === n ? `取消评分（当前 ${n} 星）` : `评 ${n} 星`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(current === n ? 0 : n)
            }}
          >
            <StarIcon filled={filled} size={size} />
          </button>
        )
      })}
      <span className="ml-1 text-[11px] text-muted">{current > 0 ? `${current} 星` : '未评分'}</span>
    </div>
  )
}

/** 收藏星（卡片右上角 / 详情面板共用）。已收藏常显，未收藏由调用方控制 hover 显隐 */
export function FavoriteStar({
  favorite,
  onToggle,
  size = 14,
  className = ''
}: {
  favorite: boolean
  onToggle: () => void
  size?: number
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={favorite}
      title={favorite ? '取消收藏' : '收藏'}
      className={`rounded-full p-0.5 transition ${
        favorite ? 'text-accent' : 'text-white/90 hover:text-white'
      } ${className}`}
      onClick={(e) => {
        // 卡片本体点击 = 选中，星标不能顺带选中
        e.stopPropagation()
        onToggle()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <StarIcon filled={favorite} size={size} />
    </button>
  )
}
