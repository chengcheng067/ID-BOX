import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

/**
 * 图标统一容器（UI 规范 · 图标规格 A「线性单色」）。
 *
 * - 全部画在 24×24 viewBox 网格上，图形实际占位 20×20（四周留 2）；
 * - round cap / round join；
 * - **描边基准钉在 16px 渲染尺寸 = 视觉 1.5** → path 坐标系里必须写 `2.25`
 *   （2.25 × 16/24 = 1.5），这样任意渲染尺寸等比缩放（13px→1.2、14px→1.3、40px→3.75）；
 * - 颜色一律继承文字色 `currentColor`，不自带彩色、不画底框。
 */
function Base({ children, ...props }: P & { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export const IconBox = (p: P) => (
  <Base {...p}>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
    <path d="M3 8l9 5 9-5" />
    <path d="M12 13v8" />
  </Base>
)

export const IconImage = (p: P) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </Base>
)

export const IconHdr = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Base>
)

export const IconMaterial = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 000 18" />
    <circle cx="9" cy="10" r="1" fill="currentColor" />
    <circle cx="15" cy="10" r="1" fill="currentColor" />
    <circle cx="12" cy="15" r="1" fill="currentColor" />
  </Base>
)

export const IconOther = (p: P) => (
  <Base {...p}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
  </Base>
)

/**
 * 大类占位 · CAD 图纸（2026-10-29 新增大类 `'cad'`）。
 *
 * 语义是**平面图**：外框 = 图纸/房间边界，两条内墙把图分成几个开间。
 * 不画「蓝底白线」的蓝图配色（图标一律单色继承 `currentColor`，规范 §图标规格 A），
 * 也不复用 `IconImage`（那是位图语义，图纸不是位图）。
 *
 * 刻意只留两条内墙：卡片占位会放大到 ~35px，再细的线在 `strokeWidth=2.25` 下会糊成一块。
 */
export const IconCad = (p: P) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 11h9V3" />
    <path d="M21 14h-6v7" />
  </Base>
)

export const IconFolder = (p: P) => (
  <Base {...p}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </Base>
)

export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Base>
)

export const IconSettings = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.08a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.08a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.08a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </Base>
)

export const IconTrash = (p: P) => (
  <Base {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
    <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </Base>
)

export const IconRefresh = (p: P) => (
  <Base {...p}>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </Base>
)

export const IconGrid = (p: P) => (
  <Base {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Base>
)

export const IconList = (p: P) => (
  <Base {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Base>
)

export const IconPlus = (p: P) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
)

export const IconClose = (p: P) => (
  <Base {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Base>
)

export const IconTag = (p: P) => (
  <Base {...p}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
  </Base>
)

export const IconExternal = (p: P) => (
  <Base {...p}>
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <path d="M15 3h6v6M10 14L21 3" />
  </Base>
)

export const IconDownload = (p: P) => (
  <Base {...p}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </Base>
)

export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Base>
)

export const IconAlert = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </Base>
)

export const IconEye = (p: P) => (
  <Base {...p}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
)

export const IconFile = (p: P) => (
  <Base {...p}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
  </Base>
)

// ── 空态图形（规范：24 网格 path 坐标、20×20 占位、单色 currentColor、渲染 40px）──
// 说明：与常规图标共用同一 Base 描边口径（path 坐标 2.25），随渲染尺寸等比缩放；
// 目前一律单色继承文字色，画布上「收纳」的蓝色向上箭头属未拍板项，暂不跟随。

/** 空态 · 收纳：开口箱体 + 向上箭头（全局空态「把压缩包拖进来」） */
export const IconEmptyLibrary = (p: P) => (
  <Base width="40" height="40" {...p}>
    {/* 箱体（上沿留出箭头穿过的开口，两侧各留一段沿口） */}
    <path d="M3 12v7a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M3 12h4M17 12h4" />
    {/* 向上箭头：箭杆从箱口内穿出，箭头位于顶部 */}
    <path d="M12 11V2" />
    <path d="M8.5 5.5L12 2l3.5 3.5" />
  </Base>
)

/** 空态 · 筛选：漏斗（筛选结果为 0） */
export const IconEmptyFilter = (p: P) => (
  <Base width="40" height="40" {...p}>
    <path d="M21 4H3l7 8.5V19l4 2v-8.5L21 4z" />
  </Base>
)

/** 空态 · 指针：鼠标指针箭头（右栏「选中一个资产查看详情」） */
export const IconEmptyPointer = (p: P) => (
  <Base width="40" height="40" {...p}>
    <path d="M3.5 2.5l7.6 17.8 2.7-7.5 7.5-2.7L3.5 2.5z" />
  </Base>
)

// ── 窗口控制图形（自绘标题栏用，16px 渲染、同一描边口径、currentColor）──
// 颜色由按钮的 CSS 决定（.win-btn = --text-tertiary / .win-btn-close = --danger）。

/** 窗口控制 · 最小化 */
export const IconWinMinimize = (p: P) => (
  <Base {...p}>
    <path d="M3 12h18" />
  </Base>
)

/** 窗口控制 · 最大化 */
export const IconWinMaximize = (p: P) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </Base>
)

/** 窗口控制 · 还原（前后两个叠加方框） */
export const IconWinRestore = (p: P) => (
  <Base {...p}>
    <rect x="3" y="9" width="12" height="12" rx="2" />
    <path d="M9 3h9a3 3 0 013 3v9" />
  </Base>
)

/** 窗口控制 · 关闭 */
export const IconWinClose = (p: P) => (
  <Base {...p}>
    <path d="M4.5 4.5l15 15M19.5 4.5l-15 15" />
  </Base>
)
