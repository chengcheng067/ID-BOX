/**
 * 首页文件夹排三项增强（docs/60 §6，T-05）的**纯逻辑**：
 *
 *   · F-1 快速访问钉选：归一化口径的增删移（数组顺序即 order）、查重、路径取名；
 *   · F-2 悬停自动横向滚动：边缘热区方向判定 + 匀速步长；
 *   · F-3 文件夹底纹：key 命名空间（kind: / pin:）与 `bg://` URL 派生；
 *   · 子项 5：静态图片背景时海浪设置面板的显隐判定（与 `HomeCover` 的
 *     `hasWallpaper` 是**同一个口径的正反两面**，改一处必须看另一处）。
 *
 * 为什么抽出来：这些判定全部要在 node 环境单测（`tests/homePinned.test.ts`），
 * 组件里写就测不了；且方向判定 / 增删移是纯数据运算，不该和 React / DOM 混居。
 *
 * ⚠️ 纪律：本模块不 import store / React / DOM / electron。
 */

import type { HomePinnedFolder, HomeBackgroundSource } from '../../shared/types'

/* ────────────────────────────────────────────────────────────────────────────
 * F-1 · 钉选：增 / 删 / 移（数组顺序即显示顺序）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 钉选条数上限（与主进程 `normalizeHomePinnedFolders` 的 32 封顶同一口径） */
export const HOME_PINNED_LIMIT = 32

/**
 * 添加一条钉选。
 *
 * - **查重按 `absPath`**（docs/60 §6.1：同一路径已钉 → 不重复追加）；
 * - 超上限 → 拒绝（返回 `'limit'`，调用方给单行提示）；
 * - 返回 `added` 时数组是新引用（zustand / React 都按引用比较）。
 */
export function addPinnedFolder(
  list: readonly HomePinnedFolder[],
  item: { id: string; name: string; absPath: string }
): { list: HomePinnedFolder[]; outcome: 'added' | 'duplicate' | 'limit' } {
  if (list.length >= HOME_PINNED_LIMIT) return { list: [...list], outcome: 'limit' }
  if (list.some((p) => p.absPath === item.absPath)) {
    return { list: [...list], outcome: 'duplicate' }
  }
  return { list: [...list, { ...item }], outcome: 'added' }
}

/** 按 id 移除（只删 Settings 键，绝不碰磁盘 —— 红线）。id 不存在时原样返回。 */
export function removePinnedFolderById(
  list: readonly HomePinnedFolder[],
  id: string
): HomePinnedFolder[] {
  const next = list.filter((p) => p.id !== id)
  return next.length === list.length ? [...list] : next
}

/**
 * 左右移动（delta = -1 左移 / +1 右移），**只在钉选之间交换相邻元素**：
 * 素材大类卡固定在排首（产品口径候选序），不参与排序（docs/60 §6.1）。
 *
 * 渲染层里钉选卡整体排在素材大类卡之后，所以这里的下标就是"钉选子序列"的下标，
 * 交换相邻两个钉选 = 交换数组相邻元素，O(1)，无重排。
 */
export function movePinnedFolder(
  list: readonly HomePinnedFolder[],
  id: string,
  delta: -1 | 1
): HomePinnedFolder[] {
  const index = list.findIndex((p) => p.id === id)
  if (index < 0) return [...list]
  const target = index + delta
  if (target < 0 || target >= list.length) return [...list]
  const next = [...list]
  const tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

/**
 * 钉选卡之间的**可移方向**真值表（供菜单禁用态 / 单测）。
 * 与素材大类卡的边界无关：这里只看钉选子序列的端点。
 */
export function pinnedMoveBounds(
  list: readonly HomePinnedFolder[],
  id: string
): { canLeft: boolean; canRight: boolean } {
  const index = list.findIndex((p) => p.id === id)
  if (index < 0) return { canLeft: false, canRight: false }
  return { canLeft: index > 0, canRight: index < list.length - 1 }
}

/**
 * 从绝对路径取显示名（末段）。Windows（`E:\a\b`）与 POSIX（`/a/b`）都收；
 * 去掉尾部分隔符；取不到末段（空串 / 纯盘符）时原样返回。
 */
export function folderNameOfPath(absPath: string): string {
  const trimmed = (absPath ?? '').replace(/[\\/]+$/, '')
  if (trimmed.length === 0) return absPath ?? ''
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  const last = idx >= 0 ? trimmed.slice(idx + 1) : trimmed
  return last.length > 0 ? last : trimmed
}

/* ────────────────────────────────────────────────────────────────────────────
 * F-2 · 悬停自动横向滚动（边缘热区）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 左右边缘热区宽度（px，docs/60 §6.2 写死 48） */
export const EDGE_HOT_ZONE_PX = 48
/** 匀速滚动速度（CSS px / 秒，docs/60 §6.2 ≈320） */
export const EDGE_SCROLL_SPEED_PX_PER_S = 320

/** 传入方向判定的矩形（只需要用到的字段；DOM Rect 天然满足） */
export interface EdgeScrollRect {
  left: number
  right: number
  top: number
  bottom: number
}

/** 传入方向判定的纵向安全带（热区只算卡片实际占的那一段，见 HomeCover 的 padding 补偿） */
export interface EdgeScrollBand {
  /** 矩形顶部向下收掉的高度（滚动容器的补偿 padding-top） */
  topInset: number
  /** 矩形底部向上收掉的高度（补偿 padding-bottom） */
  bottomInset: number
}

/**
 * 边缘热区方向判定：鼠标在左热区 → -1（向左滚）、右热区 → +1、其余 / 纵向带外 → 0。
 *
 * 真值表设计（docs/60 §6.2 判据①）：
 * - 横向：`clientX - left < 48` → -1；`right - clientX < 48` → +1；中间 → 0；
 * - 纵向：y 在 `[top + topInset, bottom - bottomInset]` 之外 → 0
 *   （滚动容器为了不裁卡片 hover 形态带 compensated padding，热区不能跟着扩大，
 *    否则用户悬停在搜索框 adjacent 区域也会触发滚动 —— R-6 的变体）。
 */
export function edgeScrollDirection(
  clientX: number,
  clientY: number,
  rect: EdgeScrollRect,
  band: EdgeScrollBand,
  edgeWidth: number = EDGE_HOT_ZONE_PX
): -1 | 0 | 1 {
  if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return 0
  const bandTop = rect.top + Math.max(0, band.topInset)
  const bandBottom = rect.bottom - Math.max(0, band.bottomInset)
  if (bandBottom <= bandTop) return 0
  if (clientY < bandTop || clientY > bandBottom) return 0
  if (clientX - rect.left < edgeWidth) return -1
  if (rect.right - clientX < edgeWidth) return 1
  return 0
}

/**
 * 一帧的滚动增量：`speed × dt`（dt 毫秒 → 秒）。非有限 / 负 dt 一律按 0 处理 ——
 * rAF 回来的时间戳理论上单调，但页面挂起恢复后可能出现回拨，不能让海浪式的
 * "补一大段"发生在滚动上（与 HomeParticles 的 delta 封顶同一防御思路）。
 */
export function edgeScrollStep(
  dtMs: number,
  speedPxPerS: number = EDGE_SCROLL_SPEED_PX_PER_S
): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 0
  return (speedPxPerS * dtMs) / 1000
}

/**
 * 边缘箭头**点击**滚动的目标值（2026-11-28 新增）：从当前 scrollLeft 出发沿 dir
 * 走一个「卡步进」（一张卡宽 + 行 gap），再收口到 [min, max] —— 滚到头就停在头。
 *
 * 与 `nextScrollLeft`（rAF 逐帧小步）的区别：
 *   · dir 只允许 ±1：点击没有中性方向，点的是哪边箭头就往哪边滚；
 *   · step 非有限 / ≤0 视为无效，原地收口不动（调用方已用真实 DOM 几何兜底，
 *     这里是纯函数层面的双保险，绝不产出 NaN 目标值）。
 */
export function clickScrollTarget(
  current: number,
  dir: -1 | 1,
  step: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(step) || step <= 0) {
    return Math.min(max, Math.max(min, current))
  }
  const next = current + dir * step
  return Math.min(max, Math.max(min, next))
}

/**
 * 把方向与当前 scrollLeft 收口成下一帧的 scrollLeft：
 * 滚到头自动停（docs/60 §6.2「边界：滚到头自动停」）。
 */
export function nextScrollLeft(
  current: number,
  direction: -1 | 0 | 1,
  step: number,
  min: number,
  max: number
): number {
  if (direction === 0 || step <= 0) return current
  const next = current + direction * step
  return Math.min(max, Math.max(min, next))
}

/* ────────────────────────────────────────────────────────────────────────────
 * F-3 · 文件夹底纹（key 命名空间 + bg:// URL）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 底纹映射的 key 命名空间（docs/60 §6.3）：
 *   素材大类卡 = `kind:<HomeFolderItem['key']>`；钉选卡 = `pin:<HomePinnedFolder.id>`。
 * 两个命名空间互不碰撞（`:` 只出现一次且前缀不同）。
 */
export function kindWallpaperKey(kindKey: string): string {
  return `kind:${kindKey}`
}

export function pinWallpaperKey(pinId: string): string {
  return `pin:${pinId}`
}

/**
 * 按映射取底纹 URL：命中 → `bg://<encodeURIComponent(fileName)>`（与 HomeCover
 * 壁纸层同一协议写法）；未命中 / 值为空 → `null`（渲染层回落现状默认底纹）。
 */
export function wallpaperUrlOf(
  map: Record<string, string> | undefined,
  key: string
): string | null {
  const fileName = map?.[key]
  if (typeof fileName !== 'string' || fileName.length === 0) return null
  return `bg://${encodeURIComponent(fileName)}`
}

/** 写一个 key（fileName 为 null = 清除）。空串视为清除，不写垃圾键。 */
export function wallpaperMapPatch(
  map: Record<string, string> | undefined,
  key: string,
  fileName: string | null
): Record<string, string> {
  const next: Record<string, string> = { ...(map ?? {}) }
  if (fileName === null || fileName.length === 0) {
    delete next[key]
    return next
  }
  next[key] = fileName
  return next
}

/* ────────────────────────────────────────────────────────────────────────────
 * 子项 5 · 静态图片背景时隐藏海浪设置面板
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 海浪设置面板（配色预设 / 参数滑块 / 形态与交互 / 自定义配色四区块）是否显示。
 *
 * 既有口径（HomeCover.tsx `hasWallpaper`，逐字对齐）：**壁纸与海浪互斥** ——
 * `source !== 'none'` 且有文件时粒子层整体不渲染；设置面板是同一个口径的另一面，
 * 挂了壁纸（= 静态图片背景）就没有"海浪"可调，面板随之隐藏；
 * 选回「默认背景」（source none）或文件缺失时恢复显示。
 */
export function homeWavePanelVisible(background: {
  source: HomeBackgroundSource
  fileName: string | null
}): boolean {
  return !(background.source !== 'none' && Boolean(background.fileName))
}
