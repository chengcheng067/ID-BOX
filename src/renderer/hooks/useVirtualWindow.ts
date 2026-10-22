/**
 * 虚拟滚动的 React 适配层（docs/20 §3 / T-B1 + T-B2）。
 *
 * 分工：
 * - 纯计算在 `logic/virtualWindow.ts`（零 React，可 node 直测）；
 * - 本文件只负责"和浏览器/React 有关"的三件事：**量容器尺寸**（ResizeObserver）、
 *   **读滚动位置**（原生 scroll 监听 + rAF 合并）、**把结果交给组件**。
 *
 * 两个导出：
 * - `useScrollViewport(ref)`：只要"容器宽/高/滚动位置"这层状态（网格自己算逐行高度时用）；
 * - `useVirtualWindow({...})`：固定行高（列表 = columns 1 / rowH 44）直接用。
 *
 * 用法（B2 已接线，见 `components/AssetGrid.tsx`）：
 * ```tsx
 * const vp = useScrollViewport(gridRef, mountKey)
 * const metrics = metricsFor(density, vp.viewportW - GRID_PAD_X)
 * const rows = useMemo(() => gridRowHeights(kinds, metrics.columns, metrics.cardW), [...])
 * const win = computeRowWindow({ rowHeights: rows, scrollTop: vp.scrollTop,
 *                                viewportH: vp.viewportH, gap: GRID_GAP })
 * ```
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OVERSCAN_ROWS } from '../logic/gridMetrics'
import { computeWindow, type WindowOutput } from '../logic/virtualWindow'
import type { RefObject } from 'react'

/** 滚动容器观测结果（`useScrollViewport` 的返回） */
export interface ScrollViewport {
  /** 容器可视高度（`clientHeight`，含 padding），首帧量到之前是 0 */
  viewportH: number
  /** 容器可视宽度（`clientWidth`，含 padding 但不含纵向滚动条），首帧量到之前是 0 */
  viewportW: number
  /** 最近一次（rAF 合并后的）滚动位置 */
  scrollTop: number
  /** 要挂到滚动容器上的 ref（= 入参 `containerRef` 或内部 ref） */
  scrollRef: RefObject<HTMLDivElement>
  /**
   * 要挂到滚动容器上的 `onScroll`。
   * ⚠️ hook 内部已经在 ref 上挂了**原生 passive scroll 监听**（rAF 合并），二者幂等：
   * 同一帧内多次触发只会 setState 一次（相同值 React 直接 bail out）。
   * 提供它主要是为了「ref 在 effect 执行时还没挂上」的场景兜底。
   */
  onScroll: () => void
}

export interface UseVirtualWindowOptions {
  /** 条目总数（资产数 / 文件数） */
  itemCount: number
  /** 列数（网格由 `metricsFor(...).columns` 给；列表恒 1） */
  columns: number
  /** 固定行高（列表 = `LIST_ROW_H`；网格请用 `computeRowWindow` + 逐行高度） */
  rowH: number
  /** 两端额外渲染行数，缺省 `OVERSCAN_ROWS` */
  overscan?: number
  /**
   * 复用外部已有的滚动容器 ref（如 `AssetGrid` 的 `gridRef`——它还要给 Ctrl+滚轮用，
   * 不能有两个 ref 抢同一个 DOM）。不传则由 hook 内部创建，从 `scrollRef` 取回。
   */
  containerRef?: RefObject<HTMLDivElement>
  /**
   * 容器**换挂载点**时的重订阅信号。滚动容器在 `AssetGrid` 里是条件渲染的
   * （网格 / 列表 / 文件夹视图 / 空态四选一），ref 指向的元素会在 view、`dupOnly`、
   * `folderViewAssetId` 变化时被替换，而 ref 对象身份不变 → effect 不会自动重跑。
   * 调用方传一个能代表"挂载点是否换了"的字符串即可（见 AssetGrid 的 `scrollMountKey`）。
   */
  attachKey?: unknown
  /** 源卡 pin（docs/20 §6）：命中行并入可见区间；**B2 只加能力，不接线** */
  pinnedRows?: ReadonlySet<number>
}

export interface UseVirtualWindowResult extends WindowOutput, ScrollViewport {}

/** 取 rAF（node / 测试环境下没有 `window` 时退化为同步执行） */
function scheduleFrame(cb: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(cb)
  }
  cb()
  return 0
}

/** 取消 rAF（0 = 没有待执行的帧） */
function cancelFrame(id: number): void {
  if (id !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id)
  }
}

/**
 * 观测滚动容器的尺寸与滚动位置。
 *
 * 尺寸必须走 `ResizeObserver` 而不是只信初始高度：窗口缩放、左栏折叠、右栏展开
 * 都会改中栏宽度 → 列数、行高、行数一起变。
 */
export function useScrollViewport(
  containerRef?: RefObject<HTMLDivElement>,
  attachKey?: unknown
): ScrollViewport {
  const innerRef = useRef<HTMLDivElement>(null)
  const scrollRef = containerRef ?? innerRef

  const [viewportH, setViewportH] = useState(0)
  const [viewportW, setViewportW] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  /** 已排队但还没执行的 rAF id（0 = 空闲）——同一帧多次 scroll 只算一次 */
  const frameRef = useRef(0)

  /** 同步读一次容器状态；值没变就不 setState（避免无意义的重渲染） */
  const readLayout = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const h = el.clientHeight
    const w = el.clientWidth
    setViewportH((prev) => (prev === h ? prev : h))
    setViewportW((prev) => (prev === w ? prev : w))
    const top = el.scrollTop
    // scrollTop 可能是小数（缩放 125% 时 Chromium 会给小数），照样原样保留
    setScrollTop((prev) => (prev === top ? prev : top))
  }, [scrollRef])

  /** rAF 节流：同一帧内多次 scroll 事件只读一次 DOM / 只触发一次 setState */
  const onScroll = useCallback((): void => {
    if (frameRef.current !== 0) return
    frameRef.current = scheduleFrame(() => {
      frameRef.current = 0
      readLayout()
    })
  }, [readLayout])

  // 首帧：挂载后立刻量一次（useLayoutEffect 在浏览器绘制前执行 → 不会先按"1 行"闪一下）
  useLayoutEffect(() => {
    readLayout()
  }, [readLayout, attachKey])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    readLayout()
    const ro = new ResizeObserver(() => {
      readLayout()
    })
    ro.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      cancelFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [scrollRef, readLayout, onScroll, attachKey])

  return { viewportH, viewportW, scrollTop, scrollRef, onScroll }
}

/**
 * 固定行高窗口（列表视图用；网格因为混了 1:1 / 4:3 封面，改用逐行高度 + `computeRowWindow`）。
 */
export function useVirtualWindow(options: UseVirtualWindowOptions): UseVirtualWindowResult {
  const { itemCount, columns, rowH, overscan = OVERSCAN_ROWS, containerRef, attachKey, pinnedRows } = options
  const vp = useScrollViewport(containerRef, attachKey)

  const win = useMemo(
    () =>
      computeWindow({
        scrollTop: vp.scrollTop,
        viewportH: vp.viewportH,
        itemCount,
        columns,
        rowH,
        overscan,
        pinnedRows
      }),
    [vp.scrollTop, vp.viewportH, itemCount, columns, rowH, overscan, pinnedRows]
  )

  return { ...win, ...vp }
}
