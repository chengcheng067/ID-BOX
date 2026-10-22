/**
 * 主题解析（0.6.0）：把设置里的 `ThemeMode`（可能是 `system`）解析成**实际生效**的
 * `light | dark`。
 *
 * 为什么单独抽一个纯函数：
 * - `document.documentElement.dataset.theme` 只接受 light/dark，写进 'system' 会让
 *   整套 CSS 变量全部落空（styles.css 里没有 `[data-theme='system']`）；
 * - 解析规则要能被单测盯住（`system` + 系统深色 → dark 等四条组合）。
 */
import type { ThemeMode } from './types'

/** 实际生效的主题（CSS 侧只认这两个值） */
export type ResolvedTheme = 'light' | 'dark'

/**
 * @param mode       设置里的主题（可含 `system`）
 * @param prefersDark 系统当前是否深色（渲染进程传 `matchMedia('(prefers-color-scheme: dark)').matches`）
 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode === 'dark' ? 'dark' : 'light'
}
