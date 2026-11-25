/**
 * SKP 空白（纯白占位）预览兜底（`src/main/pinnedThumb.ts`）。
 *
 * 背景（2026-11-25 用户实测）：SU 会把一张**纯白占位图**写进 .skp 的 CDib 缩略图槽位，
 * 提取链路完全成功 → 缓存里落一张 100% 白的图 → 图标视图里卡片显示一块白底，
 * 视觉上等于没图。修复口径：SKP 路径落盘前解一次像素，判空白则返回 `not-available`，
 * 渲染层回落到自绘 SU 大字徽标。
 *
 * 本文件覆盖：
 *   ① 纯函数 `isBlankPreviewBitmap`：全白 / 纯黑（单色）/ 白底有内容 / 噪点 / 边界；
 *   ② SKP 链路接线：空白 → not-available 且**不写缓存**；有内容 → 照常原样落缓存；
 *      旧版本已写下的同一份白图会被顺手删掉；解码失败不误杀；
 *   ③ 图片路径不受影响（用户自己的白底图是真实内容）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── electron 桩 ───────────────────────────────────────────────────────────────
const env = vi.hoisted(() => ({
  userDataRoot: '',
  /** `nativeImage.createFromBuffer` 的解码结果开关（null = 解码失败） */
  bitmapFor: null as null | ((buf: Buffer) => { data: Uint8Array; width: number; height: number } | null)
}))

vi.mock('electron', () => {
  const emptyImage = {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toBitmap: () => Buffer.alloc(0),
    resize: () => emptyImage,
    toPNG: () => Buffer.alloc(0)
  }
  return {
    nativeImage: {
      // 图片路径：固定给一张 8×8 的假图（用来说明图片路径**不参与**空白判定）
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 8, height: 8 }),
        resize: () => ({
          toPNG: () => Buffer.from('white-jpg-as-png')
        }),
        toPNG: () => Buffer.from('white-jpg-as-png')
      }),
      createFromBuffer: (buf: Buffer) => {
        const bmp = env.bitmapFor ? env.bitmapFor(buf) : null
        if (!bmp) return emptyImage
        return {
          isEmpty: () => false,
          getSize: () => ({ width: bmp.width, height: bmp.height }),
          toBitmap: () => Buffer.from(bmp.data),
          resize: () => emptyImage,
          toPNG: () => Buffer.from(bmp.data)
        }
      }
    },
    app: { getPath: () => env.userDataRoot }
  }
})

const {
  BLANK_FULL_SCAN_MAX_PX,
  BLANK_NEAR_WHITE_MIN,
  BLANK_UNIFORM_STD_MAX,
  BLANK_WHITE_RATIO_MAX,
  BLANK_WHITE_STD_MAX,
  isBlankPreviewBitmap,
  pinnedThumbFileName,
  pinnedThumbsDir,
  resolveThumbForEntry
} = await import('../src/main/pinnedThumb')
import { skpContentWithPreview, TINY_PNG, tinyJpeg } from './fixtures/gbkZip'

// ── 位图构造工具（BGRA，与 nativeImage.toBitmap() 同布局）──────────────────────

type Painter = (x: number, y: number) => [number, number, number]

function bgra(width: number, height: number, paint: Painter): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      const i = (y * width + x) * 4
      data[i] = b
      data[i + 1] = g
      data[i + 2] = r
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}

const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]

/** 确定性伪随机（避免 flaky 的 Math.random 断言） */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const SIZE = 256

// ─────────────────────────────────────────────────────────────────────────────
// ① 纯函数判据
// ─────────────────────────────────────────────────────────────────────────────
describe('isBlankPreviewBitmap · 纯函数判据', () => {
  it('全白 256×256 → 空白（实测的两个纯白占位 skp 就是这张图）', () => {
    expect(isBlankPreviewBitmap(bgra(SIZE, SIZE, () => WHITE))).toBe(true)
  })

  it('纯黑 → 空白（整图单色，用户看不到任何内容）', () => {
    expect(isBlankPreviewBitmap(bgra(SIZE, SIZE, () => BLACK))).toBe(true)
  })

  it('纯中灰（单色）→ 空白', () => {
    expect(isBlankPreviewBitmap(bgra(SIZE, SIZE, () => [128, 128, 128]))).toBe(true)
  })

  it('白底 + 中间黑块 → 非空白（有内容的白底图必须保留）', () => {
    const bmp = bgra(SIZE, SIZE, (x, y) =>
      x >= 90 && x < 166 && y >= 90 && y < 166 ? BLACK : WHITE
    )
    expect(isBlankPreviewBitmap(bmp)).toBe(false)
  })

  it('白底 + 一条贯穿竖线（黑白线稿）→ 非空白', () => {
    const bmp = bgra(SIZE, SIZE, (x) => (x >= 120 && x < 124 ? [40, 40, 40] : WHITE))
    expect(isBlankPreviewBitmap(bmp)).toBe(false)
  })

  it('噪点图（每像素随机灰阶）→ 非空白', () => {
    const rnd = lcg(20261125)
    const bmp = bgra(SIZE, SIZE, () => {
      const v = Math.floor(rnd() * 256)
      return [v, v, v]
    })
    expect(isBlankPreviewBitmap(bmp)).toBe(false)
  })

  it('白底 + 极淡的一点点灰（占比 < 0.5%）→ 仍判空白（视觉上就是纯白占位）', () => {
    // 只在左上角 4×4 采样点画 250 灰：whiteRatio ≈ 99.99%、σ 极小
    const bmp = bgra(SIZE, SIZE, (x, y) => (x < 8 && y < 8 ? [250, 250, 250] : WHITE))
    expect(isBlankPreviewBitmap(bmp)).toBe(true)
  })

  it('边界：255/240 棋盘格 → 非空白（判据是方差，不是平均亮度）', () => {
    // 棋盘格均值 ≈ 247.5（看起来"很白"），但方差远大于阈值 → 有内容
    const bmp = bgra(SIZE, SIZE, (x, y) => ((x + y) % 2 === 0 ? WHITE : [240, 240, 240]))
    expect(isBlankPreviewBitmap(bmp)).toBe(false)
  })

  it('常量口径自洽：全扫上限 / 阈值都在预期值', () => {
    expect(BLANK_FULL_SCAN_MAX_PX).toBe(1 << 20)
    expect(BLANK_NEAR_WHITE_MIN).toBe(245)
    expect(BLANK_WHITE_RATIO_MAX).toBe(0.995)
    expect(BLANK_WHITE_STD_MAX).toBe(4)
    expect(BLANK_UNIFORM_STD_MAX).toBe(1.5)
  })

  it('超过全扫上限（>1M 像素）走稀疏取样，判定仍成立', () => {
    expect(isBlankPreviewBitmap(bgra(2048, 2048, () => WHITE))).toBe(true)
    const withContent = bgra(2048, 2048, (x, y) =>
      x > 500 && x < 1500 && y > 500 && y < 1500 ? BLACK : WHITE
    )
    expect(isBlankPreviewBitmap(withContent)).toBe(false)
  })

  it('布局不明（data 长度不足 / 尺寸非法 / null）→ 一律非空白（绝不误杀）', () => {
    expect(isBlankPreviewBitmap(null)).toBe(false)
    expect(isBlankPreviewBitmap(undefined)).toBe(false)
    expect(isBlankPreviewBitmap({ data: new Uint8Array(16), width: 256, height: 256 })).toBe(false)
    expect(isBlankPreviewBitmap({ data: new Uint8Array(0), width: 0, height: 0 })).toBe(false)
    expect(isBlankPreviewBitmap({ data: new Uint8Array(64), width: Number.NaN, height: 4 })).toBe(false)
  })

  it('非正方形 / 小尺寸（SU 老版本 128px 缩略图）同样能判', () => {
    expect(isBlankPreviewBitmap(bgra(128, 96, () => WHITE))).toBe(true)
    expect(isBlankPreviewBitmap(bgra(128, 96, (x) => (x < 20 ? BLACK : WHITE)))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② SKP 链路接线
// ─────────────────────────────────────────────────────────────────────────────
const tmpRoots: string[] = []
let pinRoot = ''

async function tmpDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

async function writeSource(rel: string, bytes: Buffer, ms = 1_700_000_000_000): Promise<string> {
  const abs = path.join(pinRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, bytes)
  const t = new Date(ms)
  await fs.utimes(abs, t, t)
  return abs
}

async function exists(abs: string): Promise<boolean> {
  return await fs.stat(abs).then(
    () => true,
    () => false
  )
}

beforeEach(async () => {
  env.userDataRoot = await tmpDir('mv-ballthumb-u-')
  pinRoot = await tmpDir('mv-ballthumb-pin-')
  env.bitmapFor = null
})

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('SKP 链路 · 空白预览回落类型图标', () => {
  it('纯白内嵌预览 → not-available，且**不写**缓存文件', async () => {
    env.bitmapFor = () => bgra(256, 256, () => WHITE)
    const abs = await writeSource('白模.skp', skpContentWithPreview(TINY_PNG))
    const r = await resolveThumbForEntry(pinRoot, '', '白模.skp')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
    const stale = path.join(pinnedThumbsDir(), pinnedThumbFileName(abs, 1_700_000_000_000, 'png'))
    expect(await exists(stale)).toBe(false)
    const dirFiles = await fs.readdir(pinnedThumbsDir()).catch(() => [] as string[])
    expect(dirFiles).toEqual([])
  })

  it('旧版本已写下的白图会被删掉（不留垃圾）', async () => {
    env.bitmapFor = () => bgra(256, 256, () => WHITE)
    const abs = await writeSource('白模.skp', skpContentWithPreview(TINY_PNG))
    await fs.mkdir(pinnedThumbsDir(), { recursive: true })
    const legacy = path.join(pinnedThumbsDir(), pinnedThumbFileName(abs, 1_700_000_000_000, 'png'))
    await fs.writeFile(legacy, Buffer.from('legacy-white-png'))
    expect(await exists(legacy)).toBe(true)

    const r = await resolveThumbForEntry(pinRoot, '', '白模.skp')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
    expect(await exists(legacy)).toBe(false)
  })

  it('白底 + 有内容的内嵌预览 → 照常原样落缓存（不误杀线稿）', async () => {
    env.bitmapFor = () => bgra(256, 256, (x, y) => (x >= 100 && x < 156 && y >= 60 && y < 200 ? BLACK : WHITE))
    await writeSource('线稿.skp', skpContentWithPreview(TINY_PNG))
    const r = await resolveThumbForEntry(pinRoot, '', '线稿.skp')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const written = await fs.readFile(path.join(pinnedThumbsDir(), r.url.slice('pinned-thumb://'.length)))
    expect(written.equals(TINY_PNG)).toBe(true)
  })

  it('JPEG 内嵌预览的白底有内容 → 仍 .jpg 落缓存', async () => {
    env.bitmapFor = () => bgra(256, 256, (x) => (x < 60 ? [200, 40, 40] : WHITE))
    await writeSource('彩模.skp', skpContentWithPreview(tinyJpeg()))
    const r = await resolveThumbForEntry(pinRoot, '', '彩模.skp')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toMatch(/\.jpg$/)
  })

  it('像素解码失败（nativeImage 空图）→ 保持旧行为：照常落缓存', async () => {
    env.bitmapFor = null
    await writeSource('解不开.skp', skpContentWithPreview(TINY_PNG))
    const r = await resolveThumbForEntry(pinRoot, '', '解不开.skp')
    expect(r.ok).toBe(true)
  })

  it('图片条目不做空白判定（用户自己的白底图是真实内容）', async () => {
    await writeSource('白底图.jpg', Buffer.from('white-jpeg-bytes'))
    const r = await resolveThumbForEntry(pinRoot, '', '白底图.jpg')
    expect(r.ok).toBe(true)
  })
})
