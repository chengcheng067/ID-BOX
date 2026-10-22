/**
 * HDR 解码 / 降采样单测（0.6.5）。
 *
 * 全部用**自造的小 RGBE fixture**（不依赖 E 盘 300MB 真实文件）：
 * - 三种扫描线编码：新式 RLE / 老式 RLE / 裸 RGBE；
 * - 盒式平均的**色彩正确性**（含"指数平均会偏色"的反例断言）；
 * - 非法朝向 / 非法 FORMAT 明确报错；
 * - AbortSignal 中断（预先中止 + 解码中途中止）；
 * - 进度单调递增到 1；
 * - 缓存命中 / 落盘产物可被重新解码。
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  decodeHdrDownsampled,
  encodeHdrFile,
  hdrCacheKey,
  normalizeTargetWidth,
  prepareHdrFile,
  readHdrSize
} from '../src/main/hdrDecode'
import { HDR_EXTS, isHdrExt, panoramaNoteFromName } from '../src/shared/hdrExts'

// ── fixture 工具（独立实现编码，不复用被测模块的编码器） ──────────────

type RGB = [number, number, number]

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-hdr-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 浮点 RGB → RGBE 四字节（经典 rgbe.c `float2rgbe` 口径，测试侧独立实现） */
function rgbeOf(px: RGB): [number, number, number, number] {
  const [r, g, b] = px
  const v = Math.max(r, g, b)
  if (!(v > 1e-32)) return [0, 0, 0, 0]
  const e = Math.floor(Math.log2(v)) + 1
  const scale = 256 / 2 ** e
  const c = (x: number): number => Math.max(0, Math.min(255, Math.round(x * scale)))
  return [c(r), c(g), c(b), e + 128]
}

function pixelsBytes(pixels: RGB[]): Buffer {
  const out = Buffer.alloc(pixels.length * 4)
  pixels.forEach((p, i) => out.set(rgbeOf(p), i * 4))
  return out
}

function headerBytes(w: number, h: number, direction = `-Y ${h} +X ${w}`): Buffer {
  return Buffer.from(
    `#?RADIANCE\n# test fixture\nFORMAT=32-bit_rle_rgbe\n\n${direction}\n`,
    'latin1'
  )
}

/** 裸 RGBE（无 RLE） */
function makeFlat(w: number, h: number, pixels: RGB[], direction?: string): Buffer {
  return Buffer.concat([headerBytes(w, h, direction), pixelsBytes(pixels)])
}

/** 单个通道的 RLE 编码（≥4 个连续同值 → 编码段，其余 → 字面段） */
function rleChannel(bytes: number[], width: number): number[] {
  const out: number[] = []
  let i = 0
  while (i < width) {
    let run = 1
    while (i + run < width && bytes[i + run] === bytes[i] && run < 127) run++
    if (run >= 4) {
      out.push(128 + run, bytes[i]!)
      i += run
      continue
    }
    const start = i
    while (i < width && i - start < 127) {
      let look = 1
      while (i + look < width && bytes[i + look] === bytes[i] && look < 4) look++
      if (look >= 4 && i > start) break
      i++
    }
    const lit = bytes.slice(start, i)
    out.push(lit.length, ...lit)
  }
  return out
}

/** 新式 RLE：每行 `2 2 hi lo` + 四通道分别 RLE */
function makeRle(w: number, h: number, pixels: RGB[]): Buffer {
  const data = pixelsBytes(pixels)
  const parts: Buffer[] = [headerBytes(w, h)]
  for (let y = 0; y < h; y++) {
    const row = data.subarray(y * w * 4, (y + 1) * w * 4)
    parts.push(Buffer.from([2, 2, (w >> 8) & 0xff, w & 0xff]))
    for (let c = 0; c < 4; c++) {
      const channel: number[] = []
      for (let x = 0; x < w; x++) channel.push(row[x * 4 + c] ?? 0)
      parts.push(Buffer.from(rleChannel(channel, w)))
    }
  }
  return Buffer.concat(parts)
}

function samePixel(data: Buffer, a: number, b: number): boolean {
  const oa = a * 4
  const ob = b * 4
  return (
    data[oa] === data[ob] &&
    data[oa + 1] === data[ob + 1] &&
    data[oa + 2] === data[ob + 2] &&
    data[oa + 3] === data[ob + 3]
  )
}

/** 老式 RLE：`1 1 1 count` + 一个像素重复 count 次；不重复的像素按裸 4 字节写 */
function makeOldRle(w: number, h: number, pixels: RGB[]): Buffer {
  const data = pixelsBytes(pixels)
  const parts: Buffer[] = [headerBytes(w, h)]
  for (let y = 0; y < h; y++) {
    const row = data.subarray(y * w * 4, (y + 1) * w * 4)
    let x = 0
    while (x < w) {
      let run = 1
      while (x + run < w && samePixel(row, x, x + run) && run < 255) run++
      if (run >= 2) {
        parts.push(Buffer.from([1, 1, 1, run]))
        parts.push(Buffer.from(row.subarray(x * 4, x * 4 + 4)))
        x += run
      } else {
        parts.push(Buffer.from(row.subarray(x * 4, x * 4 + 4)))
        x++
      }
    }
  }
  return Buffer.concat(parts)
}

/** 取第 index 个输出像素的浮点 RGB */
function pixelAt(rgbe: Buffer, index: number): RGB {
  const o = index * 4
  const e = rgbe[o + 3] ?? 0
  const f = 2 ** (e - 136)
  return [(rgbe[o] ?? 0) * f, (rgbe[o + 1] ?? 0) * f, (rgbe[o + 2] ?? 0) * f]
}

/** 生成 w×h 的全同色像素数组 */
function uniform(w: number, h: number, color: RGB): RGB[] {
  return Array.from({ length: w * h }, () => [color[0], color[1], color[2]] as RGB)
}

/** 生成 w×h 的 2×2 分块色块（每块一个颜色，按行优先取色） */
function blocks(w: number, h: number, colors: RGB[]): RGB[] {
  const out: RGB[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bi = Math.floor(y / 2) * Math.floor(w / 2) + Math.floor(x / 2)
      const c = colors[bi % colors.length] ?? [1, 1, 1]
      out.push([c[0], c[1], c[2]] as RGB)
    }
  }
  return out
}

async function writeTmp(dir: string, name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name)
  await fs.writeFile(p, bytes)
  return p
}

// ── 基础表 ────────────────────────────────────────────────────────────

describe('hdrExts', () => {
  it('只认 hdr / exr，大小写与前导点都兼容', () => {
    expect([...HDR_EXTS].sort()).toEqual(['exr', 'hdr'])
    expect(isHdrExt('hdr')).toBe(true)
    expect(isHdrExt('.HDR')).toBe(true)
    expect(isHdrExt('Exr')).toBe(true)
    expect(isHdrExt('jpg')).toBe(false)
    expect(isHdrExt('')).toBe(false)
  })

  it('从文件名提取全景参数（含用户真实样本写法）', () => {
    expect(panoramaNoteFromName('21.古月视觉HDR-偏移 V：-0.01平铺：2.hdr')).toBe(
      '全景参数：偏移V -0.01 / 平铺 2'
    )
    expect(panoramaNoteFromName('22.古月视觉HDR-偏移U：0.33 V：-0.01平铺：2.hdr')).toBe(
      '全景参数：偏移U 0.33 / 偏移V -0.01 / 平铺 2'
    )
    expect(panoramaNoteFromName('offsetU: 0.5 tile 4.hdr')).toBe('全景参数：偏移U 0.5 / 平铺 4')
    expect(panoramaNoteFromName('客厅 HDR.hdr')).toBe('')
  })
})

describe('normalizeTargetWidth', () => {
  it('夹到最近的 512 / 2048 / 4096', () => {
    expect(normalizeTargetWidth(undefined)).toBe(2048)
    expect(normalizeTargetWidth('2048')).toBe(2048)
    expect(normalizeTargetWidth(Number.NaN)).toBe(2048)
    expect(normalizeTargetWidth(1)).toBe(512)
    expect(normalizeTargetWidth(600)).toBe(512)
    expect(normalizeTargetWidth(1600)).toBe(2048)
    expect(normalizeTargetWidth(3000)).toBe(2048)
    expect(normalizeTargetWidth(99999)).toBe(4096)
  })
})

// ── 三种扫描线编码 ────────────────────────────────────────────────────

describe('decodeHdrDownsampled：扫描线编码', () => {
  it('裸 RGBE（宽度 < 8 时按 three 的规则必走 flat 分支）', async () => {
    const dir = await tmpDir()
    const px: RGB[] = [
      [1, 1, 1], [0.5, 0.5, 0.5], [0.25, 0.25, 0.25], [0, 0, 0],
      [2, 1, 0.5], [0.125, 0.25, 0.5], [1, 0.5, 0.25], [0, 0, 1]
    ]
    const file = await writeTmp(dir, 'flat.hdr', makeFlat(4, 2, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 4 })
    expect(res.width).toBe(4)
    expect(res.height).toBe(2)
    expect(res.rgbe.length).toBe(4 * 2 * 4)
    px.forEach((c, i) => {
      const got = pixelAt(res.rgbe, i)
      expect(got[0]).toBeCloseTo(c[0], 4)
      expect(got[1]).toBeCloseTo(c[1], 4)
      expect(got[2]).toBeCloseTo(c[2], 4)
    })
  })

  it('裸 RGBE（宽 8，首像素不是 RLE 头 → 仍然 flat）', async () => {
    const dir = await tmpDir()
    const px = uniform(8, 2, [0.5, 0.5, 0.5])
    const file = await writeTmp(dir, 'flat8.hdr', makeFlat(8, 2, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 8 })
    expect(res.width).toBe(8)
    expect(res.height).toBe(2)
    for (let i = 0; i < 16; i++) expect(pixelAt(res.rgbe, i)[0]).toBeCloseTo(0.5, 5)
  })

  it('新式 RLE（编码段 + 字面段混合）', async () => {
    const dir = await tmpDir()
    const row0: RGB[] = [
      ...uniform(8, 1, [1, 1, 1]),
      [0.5, 0.25, 0.125], [0.5, 0.25, 0.125], [2, 1, 4], [0.125, 0.25, 0.5],
      [0.5, 1, 2], [0.25, 0.5, 1], [1, 0.5, 0.25], [0.125, 0.125, 0.125]
    ]
    const row1: RGB[] = [
      ...uniform(8, 1, [0.25, 0.25, 0.25]),
      [0.125, 0.25, 0.5], [2, 1, 4], [0.5, 1, 2],
      ...uniform(5, 1, [1, 0.5, 0.25])
    ]
    const px = [...row0, ...row1]
    const file = await writeTmp(dir, 'rle.hdr', makeRle(16, 2, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 16 })
    expect(res.width).toBe(16)
    expect(res.height).toBe(2)
    px.forEach((c, i) => {
      const got = pixelAt(res.rgbe, i)
      expect(got[0]).toBeCloseTo(c[0], 4)
      expect(got[1]).toBeCloseTo(c[1], 4)
      expect(got[2]).toBeCloseTo(c[2], 4)
    })
  })

  it('老式 RLE（1 1 1 count）', async () => {
    const dir = await tmpDir()
    // 首两个像素必须同色，否则首 4 字节不是 1 1 1 count，detectScanMode 会判成 flat
    const row0: RGB[] = [
      ...uniform(4, 1, [1, 0.5, 0.25]),
      [2, 1, 0.5], [0.125, 0.25, 0.5], ...uniform(2, 1, [0.5, 0.5, 0.5])
    ]
    const row1: RGB[] = [...uniform(6, 1, [0.25, 0.5, 1]), [1, 1, 1], [0.5, 0.5, 0.5]]
    const px = [...row0, ...row1]
    const file = await writeTmp(dir, 'oldrle.hdr', makeOldRle(8, 2, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 8 })
    expect(res.width).toBe(8)
    expect(res.height).toBe(2)
    px.forEach((c, i) => {
      const got = pixelAt(res.rgbe, i)
      expect(got[0]).toBeCloseTo(c[0], 4)
      expect(got[1]).toBeCloseTo(c[1], 4)
      expect(got[2]).toBeCloseTo(c[2], 4)
    })
  })
})

// ── 盒式平均 ──────────────────────────────────────────────────────────

describe('decodeHdrDownsampled：盒式平均', () => {
  it('2×2 同色块降采样后不偏色（RGBE 空间平均会偏）', async () => {
    const dir = await tmpDir()
    // 四块：亮白 / 中灰 / 暗灰 / 纯红 —— 指数字节差异极大
    const colors: RGB[] = [
      [1, 1, 1],
      [0.5, 0.5, 0.5],
      [0.125, 0.125, 0.125],
      [1, 0.125, 0.125]
    ]
    const px = blocks(4, 4, colors)
    const file = await writeTmp(dir, 'blocks.hdr', makeFlat(4, 4, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 2 })
    expect(res.width).toBe(2)
    expect(res.height).toBe(2)
    colors.forEach((c, i) => {
      const got = pixelAt(res.rgbe, i)
      expect(got[0]).toBeCloseTo(c[0], 4)
      expect(got[1]).toBeCloseTo(c[1], 4)
      expect(got[2]).toBeCloseTo(c[2], 4)
    })
  })

  it('同块内 4 个不同亮度 → 浮点平均（1 / 0.5 / 0.5 / 0 的平均是 0.5）', async () => {
    const dir = await tmpDir()
    const px: RGB[] = [
      [1, 1, 1], [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5], [0, 0, 0]
    ]
    const file = await writeTmp(dir, 'avg.hdr', makeFlat(2, 2, px))
    const res = await decodeHdrDownsampled(file, { targetWidth: 1 })
    expect(res.width).toBe(1)
    expect(res.height).toBe(1)
    const got = pixelAt(res.rgbe, 0)
    // 若错误地平均 e 字节（129/128/128/0 → ≈128）会得到 2^-8 量级，而不是 0.5
    expect(got[0]).toBeCloseTo(0.5, 5)
    expect(got[1]).toBeCloseTo(0.5, 5)
    expect(got[2]).toBeCloseTo(0.5, 5)
  })

  it('高按比例取偶数（2:1 的 16384×8192 → 2048×1024）', async () => {
    const dir = await tmpDir()
    const file = await writeTmp(dir, 'ratio.hdr', makeFlat(16, 8, uniform(16, 8, [0.5, 0.5, 0.5])))
    const res = await decodeHdrDownsampled(file, { targetWidth: 2048 })
    // 源比目标窄 → 不放大，保持源尺寸
    expect(res.width).toBe(16)
    expect(res.height).toBe(8)

    const odd = await writeTmp(dir, 'odd.hdr', makeFlat(12, 9, uniform(12, 9, [0.5, 0.5, 0.5])))
    const oddRes = await decodeHdrDownsampled(odd, { targetWidth: 6 })
    expect(oddRes.width).toBe(6)
    expect(oddRes.height % 2).toBe(0) // 5 → 4
  })
})

// ── 错误边界 ──────────────────────────────────────────────────────────

describe('decodeHdrDownsampled：明确报错', () => {
  it('非标准朝向（+Y / -X）直接报错，不猜', async () => {
    const dir = await tmpDir()
    const file = await writeTmp(
      dir,
      'flip.hdr',
      makeFlat(8, 2, uniform(8, 2, [0.5, 0.5, 0.5]), '+Y 2 +X 8')
    )
    await expect(decodeHdrDownsampled(file, { targetWidth: 8 })).rejects.toThrow(/朝向/)
  })

  it('缺 FORMAT / FORMAT 不认识 → 报错', async () => {
    const dir = await tmpDir()
    const noFormat = Buffer.concat([
      Buffer.from('#?RADIANCE\n\n-Y 2 +X 8\n', 'latin1'),
      pixelsBytes(uniform(8, 2, [1, 1, 1]))
    ])
    const a = await writeTmp(dir, 'noformat.hdr', noFormat)
    await expect(decodeHdrDownsampled(a, { targetWidth: 8 })).rejects.toThrow(/FORMAT/)

    const xyze = Buffer.concat([
      Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 2 +X 8\n', 'latin1'),
      pixelsBytes(uniform(8, 2, [1, 1, 1]))
    ])
    const b = await writeTmp(dir, 'xyze.hdr', xyze)
    await expect(decodeHdrDownsampled(b, { targetWidth: 8 })).rejects.toThrow(/32-bit_rle_rgbe/)
  })

  it('不是 RADIANCE 文件 → 报错', async () => {
    const dir = await tmpDir()
    const file = await writeTmp(dir, 'bogus.hdr', Buffer.from('hello world\n', 'latin1'))
    await expect(decodeHdrDownsampled(file, { targetWidth: 8 })).rejects.toThrow(/RADIANCE/)
  })

  it('文件被截断 → 报错（不会静默返回半张图）', async () => {
    const dir = await tmpDir()
    const full = makeFlat(16, 2, uniform(16, 2, [0.5, 0.5, 0.5]))
    const file = await writeTmp(dir, 'trunc.hdr', full.subarray(0, full.length - 16))
    await expect(decodeHdrDownsampled(file, { targetWidth: 16 })).rejects.toThrow(/截断|结束/)
  })
})

// ── 中断与进度 ────────────────────────────────────────────────────────

describe('decodeHdrDownsampled：中断与进度', () => {
  it('已经 aborted 的 signal → 立刻 reject', async () => {
    const dir = await tmpDir()
    const file = await writeTmp(dir, 'abort.hdr', makeFlat(8, 2, uniform(8, 2, [1, 1, 1])))
    const ac = new AbortController()
    ac.abort()
    await expect(
      decodeHdrDownsampled(file, { targetWidth: 8, signal: ac.signal })
    ).rejects.toThrow(/取消/)
  })

  it('解码中途 abort → reject（进度回调里触发）', async () => {
    const dir = await tmpDir()
    // 1.44MB：跨两个 1MB chunk，保证进度回调在解码途中被调用
    const file = await writeTmp(dir, 'abort-mid.hdr', makeRle(600, 600, uniform(600, 600, [0.5, 0.5, 0.5])))
    const ac = new AbortController()
    await expect(
      decodeHdrDownsampled(file, {
        targetWidth: 600,
        signal: ac.signal,
        onProgress: () => ac.abort()
      })
    ).rejects.toThrow(/取消/)
  })

  it('进度单调不减且最终到 1', async () => {
    const dir = await tmpDir()
    const file = await writeTmp(dir, 'progress.hdr', makeRle(600, 600, uniform(600, 600, [0.25, 0.5, 1])))
    const seen: number[] = []
    const res = await decodeHdrDownsampled(file, {
      targetWidth: 300,
      onProgress: (r) => seen.push(r)
    })
    expect(res.width).toBe(300)
    expect(res.height).toBe(300)
    expect(seen.length).toBeGreaterThan(0)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen[0]!).toBeGreaterThan(0)
  })
})

// ── 落盘产物与缓存 ────────────────────────────────────────────────────

describe('encodeHdrFile / readHdrSize / prepareHdrFile', () => {
  it('encodeHdrFile 产物能被自己重新解码（标准 flat RGBE）', async () => {
    const dir = await tmpDir()
    const px = uniform(4, 2, [0.5, 0.25, 1])
    const src = await writeTmp(dir, 'src.hdr', makeFlat(4, 2, px))
    const res = await decodeHdrDownsampled(src, { targetWidth: 4 })
    const outPath = path.join(dir, 'out.hdr')
    await fs.writeFile(outPath, encodeHdrFile(res.width, res.height, res.rgbe))
    const again = await decodeHdrDownsampled(outPath, { targetWidth: 4 })
    expect(again.width).toBe(4)
    expect(again.height).toBe(2)
    for (let i = 0; i < 8; i++) {
      const got = pixelAt(again.rgbe, i)
      expect(got[0]).toBeCloseTo(0.5, 4)
      expect(got[1]).toBeCloseTo(0.25, 4)
      expect(got[2]).toBeCloseTo(1, 4)
    }
    expect(await readHdrSize(outPath)).toEqual({ width: 4, height: 2 })
  })

  it('缓存键含路径 / size / mtime / 目标宽度', () => {
    const a = hdrCacheKey('E:/hdr/a.hdr', 100, 1700000000000, 2048)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(hdrCacheKey('E:/hdr/a.hdr', 100, 1700000000000, 2048)).toBe(a)
    expect(hdrCacheKey('E:/hdr/a.hdr', 101, 1700000000000, 2048)).not.toBe(a)
    expect(hdrCacheKey('E:/hdr/a.hdr', 100, 1700000000001, 2048)).not.toBe(a)
    expect(hdrCacheKey('E:/hdr/b.hdr', 100, 1700000000000, 2048)).not.toBe(a)
    expect(hdrCacheKey('E:/hdr/a.hdr', 100, 1700000000000, 4096)).not.toBe(a)
  })

  it('prepareHdrFile：首次解码落盘、第二次命中缓存、产物尺寸正确', async () => {
    const dir = await tmpDir()
    const cacheDir = path.join(dir, 'cache')
    const src = await writeTmp(dir, 'pano.hdr', makeRle(32, 16, uniform(32, 16, [0.5, 0.5, 0.5])))

    const notices: number[] = []
    const first = await prepareHdrFile({
      filePath: src,
      cacheDir,
      targetWidth: 512,
      onProgress: (r) => notices.push(r)
    })
    expect(first.fromCache).toBe(false)
    expect(first.width).toBe(32) // 源比目标窄 → 不放大
    expect(first.height).toBe(16)
    expect(first.sourceWidth).toBe(32)
    expect(first.sourceHeight).toBe(16)
    expect(notices[notices.length - 1]).toBe(1)

    const written = await fs.readFile(first.cachedPath)
    const cachedSize = await readHdrSize(first.cachedPath)
    expect(cachedSize).toEqual({ width: 32, height: 16 })
    // flat 产物：头 + w*h*4
    expect(written.length).toBeGreaterThan(32 * 16 * 4)
    expect(written.length).toBeLessThan(32 * 16 * 4 + 400)

    const second = await prepareHdrFile({ filePath: src, cacheDir, targetWidth: 512 })
    expect(second.fromCache).toBe(true)
    expect(second.cachedPath).toBe(first.cachedPath)
    expect(second.width).toBe(32)
    expect(second.height).toBe(16)
  })

  it('缓存文件被写坏 → 不当作命中，重新解码', async () => {
    const dir = await tmpDir()
    const cacheDir = path.join(dir, 'cache')
    const src = await writeTmp(dir, 'pano2.hdr', makeFlat(8, 4, uniform(8, 4, [1, 1, 1])))
    const first = await prepareHdrFile({ filePath: src, cacheDir, targetWidth: 512 })
    await fs.writeFile(first.cachedPath, 'garbage')
    const second = await prepareHdrFile({ filePath: src, cacheDir, targetWidth: 512 })
    expect(second.fromCache).toBe(false)
    expect(second.width).toBe(8)
    expect(second.height).toBe(4)
  })
})
