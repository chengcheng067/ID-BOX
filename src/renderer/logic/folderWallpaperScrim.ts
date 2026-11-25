/**
 * 首页文件夹「自定义底纹」的前翻盖 tint 计算（v1.2 反馈批 A；2026-11 玻璃质感返工）。
 *
 * 用户原话：「我希望文件夹如果自定义了底纹的话，对比度可以强一些。现在咱们的自定义
 * 底纹，只有最底下的那一层是能自定义的，那肯定跟我想达到的效果是有差别的。」
 * 2026-11 用户裁定：「我们的这个动态文件夹完全可以照搬这个源代码来做」——玻璃视觉
 * **逐值照搬**权威参考稿
 * （E:/workbuddy/2026-08-04-22-21-44/glass-folder-cards-clone.html），不再自行调参。
 *
 * 形态：底纹图铺满整张文件夹卡（背板本就按 BACK_PATH 一体成形、含标签页背后区域）；
 * 磨砂前翻盖 blur(22px) saturate(1.5) 与常态**共用同一套玻璃**（CSS 侧不再为底纹
 * 减档模糊），tint 渐变按底纹明暗取参考稿对应档的逐值。名字直接坐在 front 玻璃上
 * —— 参考稿没有额外罩层，文字可读性由 tint 底部 0.93/0.94 的近实心保证
 * （原 `wallScrimGradient` 文字区罩层已随裁定删除）。
 *
 * 本模块只做**纯计算**（不 import React / DOM / electron，vitest node 环境可测）：
 *   · `scrimToneForWallpaper`  壁纸明暗档 → 玻璃/文字档位（判定失败按亮图处理）；
 *   · `wallFrontTint`          前翻盖 tint 渐变（参考稿逐值，按底纹明暗取档）。
 *
 * 渐变字符串直接内联到 `GlassFolder` 的 style 上（CSS 没法消费 JS 常量，内联才让
 * 这份计算真正生效、也才可被这里断言）；glass-folder.css 只按 `data-wtone` 切文字色。
 */

import type { WallpaperTone } from './wallpaperTone'

/** 玻璃/文字档位：与 `WallpaperTone` 同构（bright = 浅玻璃深字 / dark = 深玻璃浅字） */
export type FolderWallTone = 'bright' | 'dark'

/**
 * 壁纸明暗档 → 玻璃/文字档位。
 *
 * `null`（取样失败 / 图挂了 / canvas taint）一律按「亮图」处理：浅玻璃 + 深字，
 * 与未设底纹时浅色主题的玻璃读感一致 —— 取色失败绝不能让文字变得读不清。
 */
export function scrimToneForWallpaper(tone: WallpaperTone | null): FolderWallTone {
  return tone === 'dark' ? 'dark' : 'bright'
}

/**
 * 前翻盖 tint（磨砂面的底色渐变），底纹模式**专属**。
 *
 * 逐值照搬参考稿 `.gf-tint`（2026-11 用户裁定「照搬这个源代码来做」）：
 *   · 亮图档 = 参考稿浅色卡：rgba(255,255,255,.16) → .5@42% → rgba(252,252,252,.93)
 *     （收尾是 252 不是 255，照搬不改）；
 *   · 暗图档 = 参考稿深色卡（data-tone="dark"）：rgba(18,18,20,.18) → .62@46% →
 *     rgba(8,8,10,.94)。
 *
 * **上透下实** —— 顶部近乎全透（底纹在口袋区 + 卡片上半区清晰透出，这是用户要的
 * 「对比度强」），往下渐实，底部收到 .93/.94 的近实心（名字/计数区坐在真正的磨砂
 * 面上，可读性由它保证，不再依赖任何额外罩层）。
 */
export function wallFrontTint(tone: FolderWallTone): string {
  return tone === 'dark'
    ? 'linear-gradient(180deg, rgba(18, 18, 20, 0.18) 0%, rgba(14, 14, 16, 0.62) 46%, rgba(8, 8, 10, 0.94) 100%)'
    : 'linear-gradient(180deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.5) 42%, rgba(252, 252, 252, 0.93) 100%)'
}
