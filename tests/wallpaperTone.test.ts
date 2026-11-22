import { describe, expect, it } from 'vitest'
import {
  wallpaperToneFromImageData,
  WALLPAPER_TONE_SAMPLE,
  WALLPAPER_TONE_BRIGHT_THRESHOLD
} from '../src/renderer/logic/wallpaperTone'

/** 构造纯色 RGBA 缓冲 */
function solid(r: number, g: number, b: number, a = 255, w = 4, h = 4): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return data
}

describe('wallpaperToneFromImageData', () => {
  it('纯白 → bright；纯黑 → dark', () => {
    expect(wallpaperToneFromImageData(solid(255, 255, 255), 4, 4)).toBe('bright')
    expect(wallpaperToneFromImageData(solid(0, 0, 0), 4, 4)).toBe('dark')
  })

  it('中灰以上亮、中灰以下暗（阈值 0.56 ± 边界）', () => {
    expect(wallpaperToneFromImageData(solid(160, 160, 160), 4, 4)).toBe('bright') // ≈0.63
    expect(wallpaperToneFromImageData(solid(120, 120, 120), 4, 4)).toBe('dark') // ≈0.47
  })

  it('彩色用 Rec.601 加权：亮黄 bright、深蓝 dark', () => {
    expect(wallpaperToneFromImageData(solid(255, 255, 0), 4, 4)).toBe('bright') // luma ≈0.89
    expect(wallpaperToneFromImageData(solid(0, 0, 139), 4, 4)).toBe('dark') // luma ≈0.09
  })

  it('全透明像素不计入：全 a=0 → null（不可判定，调用方回退主题色）', () => {
    expect(wallpaperToneFromImageData(solid(255, 255, 255, 0), 4, 4)).toBeNull()
  })

  it('半透明像素参与均值（a>0 即算）', () => {
    // 白色 alpha 128：luma 加权仍按 rgb 算（1.0）→ bright
    expect(wallpaperToneFromImageData(solid(255, 255, 255, 128), 4, 4)).toBe('bright')
  })

  it('混合：左半白右半黑 → 均值 ≈0.5 → dark', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < 16; i++) {
      const v = i < 8 ? 255 : 0
      data[i * 4] = v
      data[i * 4 + 1] = v
      data[i * 4 + 2] = v
      data[i * 4 + 3] = 255
    }
    expect(wallpaperToneFromImageData(data, 4, 4)).toBe('dark')
  })

  it('缓冲长度不足 / 空 → null', () => {
    expect(wallpaperToneFromImageData(new Uint8ClampedArray(4), 4, 4)).toBeNull()
    expect(wallpaperToneFromImageData(new Uint8ClampedArray(0), 0, 0)).toBeNull()
  })

  it('采样常量与阈值在合理区间（防误改）', () => {
    expect(WALLPAPER_TONE_SAMPLE).toBe(32)
    expect(WALLPAPER_TONE_BRIGHT_THRESHOLD).toBeGreaterThan(0.4)
    expect(WALLPAPER_TONE_BRIGHT_THRESHOLD).toBeLessThan(0.7)
  })
})
