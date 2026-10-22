/**
 * 舞台浮层控制条的**纯几何**（docs/19 裁定① 的配套浮层，A 线）。
 *
 * 为什么单独抽：浮层要「贴着顶栏球往右展开」，但球的位置每帧都在变（P2 收缩阶段），
 * 写死像素必然对不上；把「用 anchorRect 算落点 + 夹进视口」做成纯函数，
 * 组件只负责把它写进 style，单测不用渲染器。
 *
 * 本模块不碰 DOM（只吃数字），不读 store/settings。
 */

export interface AnchorLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface SizeLike {
  width: number
  height: number
}

export interface Point {
  left: number
  top: number
}

export interface PlaceOptions {
  /** 与球之间的水平间距（px） */
  gap?: number
  /** 距离视口边缘的最小留白（px） */
  margin?: number
}

/**
 * 把浮层放在球**右侧**，并与球垂直居中对齐；超出视口时夹回来（先夹右，再夹上）。
 * `anchor` 为空（球还没落定 / 测量失败）时退回右上角，保证浮层不会跑到屏幕外。
 */
export function placeBeside(
  anchor: AnchorLike | null,
  size: SizeLike,
  viewport: SizeLike,
  opts: PlaceOptions = {}
): Point {
  const gap = opts.gap ?? 12
  const margin = opts.margin ?? 8
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)

  if (!anchor) {
    return { left: maxLeft, top: margin }
  }

  const left = anchor.right + gap
  const top = anchor.top + anchor.height / 2 - size.height / 2
  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top))
  }
}

/**
 * 浮层是否应该贴着球（球在视口内且尺寸正常）。
 * P2 收缩最后几帧球的 rect 可能只有几像素，此时浮层应该先别出现。
 */
export function anchorUsable(anchor: AnchorLike | null, minSize = 16): boolean {
  if (!anchor) return false
  return anchor.width >= minSize && anchor.height >= minSize
}
