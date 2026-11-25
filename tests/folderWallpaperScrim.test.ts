/**
 * 自定义底纹玻璃纯函数单测（`src/renderer/logic/folderWallpaperScrim.ts`）。
 *
 * 2026-11 用户裁定「动态文件夹完全可以照搬这个源代码来做」——玻璃视觉逐值照搬
 * 权威参考稿（glass-folder-cards-clone.html），本测试把参考稿的 tint 逐值钉死，
 * 防止回归自行调参。
 *
 * 2026-11-25 根治「底纹露底」（用户截图：壁纸图案透过前板清晰可见）：backdrop-filter
 * 在 .gf-stage 的分数缩放变换上下文里采样失效（证据见 glass-folder.css 的 .gf-frost
 * 一节）。修复新增的是 DOM+CSS（GlassFolder 的 .gf-frost 磨砂壁纸层，blur 烤进壁纸
 * 图自身），**不改本测试钉死的 tint 数值**；该 CSS filter 是壁纸自体磨砂，不属于
 * 「全局禁玻璃拟态 backdrop-blur」范围 —— 禁的是 backdrop-filter，glass-folder.css
 * 本就是豁免区。
 *
 * 测试范式：vitest node 环境（纯函数不 import React / DOM / electron）。
 */
import { describe, expect, it } from 'vitest'
import {
  scrimToneForWallpaper,
  wallFrontTint
} from '../src/renderer/logic/folderWallpaperScrim'

describe('scrimToneForWallpaper · 壁纸档 → 玻璃/文字档', () => {
  it('bright → bright（浅玻璃深字）', () => {
    expect(scrimToneForWallpaper('bright')).toBe('bright')
  })

  it('dark → dark（深玻璃浅字）', () => {
    expect(scrimToneForWallpaper('dark')).toBe('dark')
  })

  it('null（取样失败/图挂了/canvas taint）按亮图处理，绝不让文字读不清', () => {
    expect(scrimToneForWallpaper(null)).toBe('bright')
  })
})

describe('wallFrontTint · 前翻盖 tint（参考稿 .gf-tint 逐值，上透下实）', () => {
  it('亮图档 = 参考稿浅色卡：.16 → .5@42% → rgba(252,252,252,.93)', () => {
    const tint = wallFrontTint('bright')
    expect(tint).toBe(
      'linear-gradient(180deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.5) 42%, rgba(252, 252, 252, 0.93) 100%)'
    )
    // 收尾是 252 不是 255 —— 参考稿逐值，不许"顺手改齐"。
    expect(tint).toContain('rgba(252, 252, 252, 0.93) 100%')
    expect(tint).not.toContain('rgba(255, 255, 255, 0.93)')
  })

  it('暗图档 = 参考稿深色卡：.18 → .62@46% → rgba(8,8,10,.94)', () => {
    const tint = wallFrontTint('dark')
    expect(tint).toBe(
      'linear-gradient(180deg, rgba(18, 18, 20, 0.18) 0%, rgba(14, 14, 16, 0.62) 46%, rgba(8, 8, 10, 0.94) 100%)'
    )
    expect(tint).not.toContain('rgba(255, 255, 255')
  })

  it('两档底部都近实心（.93/.94），文字可读性靠 tint 保证，不靠额外罩层', () => {
    expect(wallFrontTint('bright')).toContain('0.93) 100%')
    expect(wallFrontTint('dark')).toContain('0.94) 100%')
  })
})
