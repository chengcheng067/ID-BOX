/**
 * 壁纸亮度 → 首页控件用色档位（2026-11-23 用户需求）。
 *
 * 用户原话：「左下方的设置按钮，如果一旦检测到图片会导致对比度有所下降，那这个按钮
 * 以及下方的文字，根据情况显示为纯白、纯黑，或者是偏白的灰、偏深的灰。」
 *
 * 做法：渲染层把壁纸画进一张 32×32 的离屏 canvas（drawImage 自带缩放，大图也只需
 * 读 1024 个像素），算加权平均亮度（Rec.601 luma：0.299R + 0.587G + 0.114B），
 * 高于阈值判「亮壁纸」→ 控件用深色；否则「暗壁纸」→ 控件用白色。
 * 判定失败（图片加载失败 / canvas 被 taint 无法读像素）一律返回 null，调用方
 * 回退到主题 token 原色 —— 绝不能因为取色失败把首页搞挂。
 *
 * 为什么在渲染层做而不是主进程读图：换壁纸即时生效（HMR + 状态自然驱动），
 * 不新增 IPC，且 32×32 采样开销可以忽略。
 */

/** 采样画布边长：32×32 = 1024 个像素，足以代表整张图的明暗分布 */
export const WALLPAPER_TONE_SAMPLE = 32

/** 平均亮度 ≥ 该值判「亮壁纸」（0~1，Rec.601 luma）。0.56 兜住中灰以上的大部分壁纸 */
export const WALLPAPER_TONE_BRIGHT_THRESHOLD = 0.56

export type WallpaperTone = 'bright' | 'dark'

/**
 * 从 getImageData 的像素缓冲算壁纸档位。
 * `data` 是 RGBA 四通道、长度 = w*h*4 的字节数组；透明像素（a=0）不计入均值。
 */
export function wallpaperToneFromImageData(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): WallpaperTone | null {
  const total = width * height
  if (!data || data.length < total * 4) return null
  let sum = 0
  let count = 0
  for (let i = 0; i < total; i++) {
    const a = data[i * 4 + 3]
    if (a === 0) continue
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255
    count++
  }
  if (count === 0) return null
  return sum / count >= WALLPAPER_TONE_BRIGHT_THRESHOLD ? 'bright' : 'dark'
}
