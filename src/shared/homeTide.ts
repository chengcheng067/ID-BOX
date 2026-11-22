/**
 * 首页自定义（海浪 / 背景 / 引导）共用的**零依赖纯函数**（docs/55 §1.1）。
 *
 * 为什么独立成 shared 模块：
 * - 主进程 `settings.ts` 的 zod schema 与渲染层 `HomeParticles.tsx` /
 *   `SettingsDialog.tsx` 必须共用**同一份** hex 校验正则与数值夹取口径，
 *   否则两处正则漂移会出现「设置页说合法、落盘后被冲成 null」的鬼畜现象；
 * - 这里只放无 IO / 无 DOM / 无 electron 依赖的纯函数，node 环境可直接单测。
 *
 * 纪律：本模块**不 import 任何东西**（包括 `types.ts`），保持零依赖。
 */

/**
 * 六位十六进制颜色（从 `HomeParticles.tsx:274` 迁入）。
 *
 * 与 `particleTide.ts` 的解析口径一致；`i` 标志允许大写；**不含 `g`**，
 * 所以 `.test()` 无 lastIndex 副作用，可重复调用。
 */
export const HEX_PATTERN: RegExp = /^#[0-9a-f]{6}$/i

/** 海浪高度默认值（`HomeParticles.tsx` 定稿值 0.65） */
const DEFAULT_WAVE_HEIGHT = 0.65
/** 海浪高度合法区间（滑块与落盘共用同一对边界） */
const WAVE_HEIGHT_MIN = 0.2
const WAVE_HEIGHT_MAX = 1.5

/** 背景压暗透明度默认值 */
const DEFAULT_DIM_ALPHA = 0.35
/** 压暗透明度合法区间（0 = 不压暗，0.85 = 留一点底不让文字看不清） */
const DIM_ALPHA_MIN = 0
const DIM_ALPHA_MAX = 0.85

/**
 * 夹取首页海浪高度到 `[0.2, 1.5]`。
 *
 * 非 number / NaN / Infinity 一律回落默认 0.65（**不是**夹取到边界 ——
 * 脏值没有「方向」，按默认走才不会把用户配置带跑偏）。
 */
export function clampWaveHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAVE_HEIGHT
  return Math.min(WAVE_HEIGHT_MAX, Math.max(WAVE_HEIGHT_MIN, value))
}

/**
 * 校验六位十六进制颜色；非法（含 `null` / 非字符串 / `#fff` / `#gggggg`）→ `null`。
 *
 * `null` 的语义是「未自定义」：渲染层据此回落 `LIGHT_PALETTE` / `DARK_PALETTE`。
 */
export function validHexOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) return null
  return value
}

/**
 * 夹取背景压暗透明度到 `[0, 0.85]`。
 *
 * 非 number / NaN / Infinity 一律回落默认 0.35（同 `clampWaveHeight` 的口径）。
 */
export function clampDimAlpha(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DIM_ALPHA
  return Math.min(DIM_ALPHA_MAX, Math.max(DIM_ALPHA_MIN, value))
}
