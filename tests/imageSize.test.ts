import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IMAGE_SIZE_HEAD_BYTES, imageSizeOf } from '../src/shared/imageSize'
import { fillImageSizes } from '../src/main/importer'
import type { AssetFile } from '../src/shared/types'

/**
 * 0.6.0「贴图分辨率筛选」的采集端：**只解析文件头**（PNG IHDR / JPEG SOFn）。
 *
 * 三条底线：
 * ① PNG 的宽高在字节 16..24（大端），不能解错位；
 * ② JPEG 必须按段长度跳过 APP1 等载荷（EXIF 缩略图里也有 SOF，跳段才不会读错）；
 * ③ 不认识 / 字节不够 → `null`（未知就是未知，绝不猜）。
 */

/** 最小 PNG 头：签名 + IHDR(13 字节) + 5 字节图像信息 + 4 字节 CRC 占位 */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // 块长度 13（大端）
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  // 'IHDR'
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  // width / height（大端）
  bytes.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
  bytes.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
  // bitDepth=8, colorType=6, compression=0, filter=0, interlace=0
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

/** 最小 JPEG：SOI + APP0(JFIF) + SOF0 + EOI */
function jpegHeader(w: number, h: number): Uint8Array {
  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10 // APP0，长度 16（含长度字段 2 字节）
  ]
  for (let i = 0; i < 14; i += 1) bytes.push(0x00) // 'JFIF\0' + 版本 / 密度 / 缩略图占位
  bytes.push(0xff, 0xc0, 0x00, 0x11) // SOF0，长度 17
  bytes.push(0x08) // precision
  bytes.push((h >> 8) & 0xff, h & 0xff) // height
  bytes.push((w >> 8) & 0xff, w & 0xff) // width
  bytes.push(0x03) // 分量数
  for (let i = 0; i < 9; i += 1) bytes.push(0x00) // 3 个分量各 3 字节
  bytes.push(0xff, 0xd9) // EOI
  return new Uint8Array(bytes)
}

// ── WEBP / TIFF 的真实字节构造器 ─────────────────────────────────────
//
// 刻意不用 `new TextEncoder().encode('RIFF....WEBPVP8 ')` 这类假串：它连子块长度
// 字段都不是合法值（`....` 是 0x2e），解析器只能靠"整段乱码"碰巧返回 null，
// 根本验不到"读对了偏移"这件事。

const ASCII = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** 小端 16 位 */
function le16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff]
}

/** 小端 24 位 */
function le24(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]
}

/** 小端 32 位 */
function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

/** 大端 16 位 */
function be16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff]
}

/** 大端 32 位 */
function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

/** 组一个 RIFF/WEBP 容器：`RIFF` + 文件长度 + `WEBP` + 子块 FourCC + 子块长度 + 载荷 */
function riff(fourcc: string, payload: number[], declaredChunkSize?: number): Uint8Array {
  const chunkSize = declaredChunkSize ?? payload.length
  const body = [...ASCII('WEBP'), ...ASCII(fourcc), ...le32(chunkSize), ...payload]
  return new Uint8Array([...ASCII('RIFF'), ...le32(body.length), ...body])
}

/** VP8（有损）：3 字节帧标签 + `9d 01 2a` + 14 位宽 + 14 位高（各占 2 字节，取低 14 位） */
function webpVP8(w: number, h: number): Uint8Array {
  const payload = [
    0x00,
    0x00,
    0x00, // 帧标签（keyframe / version / show_frame / 首分区长度 的低位）
    0x9d,
    0x01,
    0x2a, // 固定关键帧起始码
    ...le16(w),
    ...le16(h)
  ]
  return riff('VP8 ', payload)
}

/** VP8L（无损）：签名 0x2f + 32 位位域（宽-1 占低 14 位、高-1 占接下来 14 位） */
function webpVP8L(w: number, h: number): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return riff('VP8L', [0x2f, ...le32(bits)])
}

/** VP8X（扩展）：1 字节 flags + 3 字节保留 + 24 位宽-1 + 24 位高-1 */
function webpVP8X(w: number, h: number): Uint8Array {
  return riff('VP8X', [0x10, 0x00, 0x00, 0x00, ...le24(w - 1), ...le24(h - 1)])
}

/** 组一个 TIFF：`II|MM` + 42 + IFD0 偏移(8) + entry 数(2) + 2 条 entry（宽 / 高） */
function tiffHeader(w: number, h: number, order: 'le' | 'be'): Uint8Array {
  const le = order === 'le'
  const u16 = le ? le16 : be16
  const u32 = le ? le32 : be32
  // SHORT 值占 value 字段的前 2 字节（两种字节序都是"值先出现"）
  const shortEntry = (tag: number, value: number): number[] => [
    ...u16(tag),
    ...u16(3), // type SHORT
    ...u32(1), // count
    ...u16(value),
    ...u16(0) // value 字段剩余 2 字节填充
  ]
  return new Uint8Array([
    ...ASCII(le ? 'II' : 'MM'),
    ...u16(42),
    ...u32(8), // IFD0 紧跟文件头
    ...u16(2), // entry 数
    ...shortEntry(0x0100, w),
    ...shortEntry(0x0101, h),
    ...u32(0) // 下一个 IFD = 0（只有一个）
  ])
}

const tmpDirs: string[] = []

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-imgsize-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('imageSizeOf · PNG', () => {
  it('从 IHDR 读出宽高', () => {
    expect(imageSizeOf(pngHeader(2048, 1024))).toEqual({ w: 2048, h: 1024 })
  })

  it('窄高图不被交换（宽高各归各位）', () => {
    expect(imageSizeOf(pngHeader(512, 4096))).toEqual({ w: 512, h: 4096 })
  })

  it('字节不足 24 → null（不抛错）', () => {
    expect(imageSizeOf(pngHeader(2048, 1024).subarray(0, 20))).toBeNull()
  })

  it('宽或高为 0 → null（坏文件不产出 0 尺寸）', () => {
    expect(imageSizeOf(pngHeader(0, 1024))).toBeNull()
  })
})

describe('imageSizeOf · JPEG', () => {
  it('从 SOF0 读出宽高', () => {
    expect(imageSizeOf(jpegHeader(1920, 1080))).toEqual({ w: 1920, h: 1080 })
  })

  it('4K 贴图（4096×4096）读得准', () => {
    expect(imageSizeOf(jpegHeader(4096, 4096))).toEqual({ w: 4096, h: 4096 })
  })

  it('SOF 段被截断 → null', () => {
    expect(imageSizeOf(jpegHeader(1920, 1080).subarray(0, 24))).toBeNull()
  })

  it('只有 SOI / EOI 没有 SOF → null', () => {
    expect(imageSizeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
  })
})

describe('imageSizeOf · WEBP（三种子格式）', () => {
  it('VP8（有损）：起始码之后的 14 位宽高', () => {
    expect(imageSizeOf(webpVP8(1024, 2048))).toEqual({ w: 1024, h: 2048 })
  })

  it('VP8（有损）4K 贴图读得准（不被 14 位掩码切掉）', () => {
    expect(imageSizeOf(webpVP8(4096, 4096))).toEqual({ w: 4096, h: 4096 })
  })

  it('VP8L（无损）：宽高都要 +1', () => {
    // 位域里存的是 w-1 / h-1，1024×512 的图位域是 1023 / 511
    expect(imageSizeOf(webpVP8L(1024, 512))).toEqual({ w: 1024, h: 512 })
    // 边界：1×1 的图位域全 0，忘了 +1 会返回 0 而判 null
    expect(imageSizeOf(webpVP8L(1, 1))).toEqual({ w: 1, h: 1 })
  })

  it('VP8X（扩展）：24 位宽高都要 +1', () => {
    expect(imageSizeOf(webpVP8X(2048, 1024))).toEqual({ w: 2048, h: 1024 })
    expect(imageSizeOf(webpVP8X(1, 1))).toEqual({ w: 1, h: 1 })
  })

  it('只有 RIFF/WEBP 头、没有子块载荷 → null（截断）', () => {
    expect(imageSizeOf(new Uint8Array([...ASCII('RIFF'), ...le32(4), ...ASCII('WEBP')]))).toBeNull()
  })

  it('子块 FourCC 认识但长度字段为 0 → null（坏头不猜）', () => {
    // 声明长度 0：任何合法子块都不可能短于 4 字节
    expect(imageSizeOf(riff('VP8 ', [0x9d, 0x01, 0x2a, ...le16(1024), ...le16(1024)], 0))).toBeNull()
    expect(imageSizeOf(riff('VP8L', [0x2f, ...le32(0)], 0))).toBeNull()
    expect(imageSizeOf(riff('VP8X', [0, 0, 0, 0, ...le24(2047), ...le24(1023)], 0))).toBeNull()
  })

  it('VP8 起始码不对 → null（不是有损帧就不按有损解析）', () => {
    const payload = [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2b, ...le16(1024), ...le16(1024)]
    expect(imageSizeOf(riff('VP8 ', payload))).toBeNull()
  })

  it('VP8L 签名不是 0x2f → null', () => {
    expect(imageSizeOf(riff('VP8L', [0x2e, ...le32(1023 | (511 << 14))]))).toBeNull()
  })

  it('未知子块（ALPH / ANIM 等）→ null（画布尺寸只认 VP8X）', () => {
    expect(imageSizeOf(riff('ALPH', [0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('imageSizeOf · TIFF（大小端都认）', () => {
  it('小端 II*\\0：SHORT 类型的 ImageWidth / ImageLength', () => {
    expect(imageSizeOf(tiffHeader(2048, 1024, 'le'))).toEqual({ w: 2048, h: 1024 })
  })

  it('大端 MM\\0*：同一份数据换字节序也读得出来', () => {
    expect(imageSizeOf(tiffHeader(2048, 1024, 'be'))).toEqual({ w: 2048, h: 1024 })
  })

  it('LONG 类型的宽高（部分导出器写 LONG）也认', () => {
    const le = (tag: number, value: number): number[] => [
      ...le16(tag),
      ...le16(4), // type LONG
      ...le32(1),
      ...le32(value)
    ]
    const bytes = new Uint8Array([
      ...ASCII('II'),
      ...le16(42),
      ...le32(8),
      ...le16(2),
      ...le(0x0100, 4096),
      ...le(0x0101, 4096),
      ...le32(0)
    ])
    expect(imageSizeOf(bytes)).toEqual({ w: 4096, h: 4096 })
  })

  it('IFD 偏移越界 → null', () => {
    const bytes = tiffHeader(1024, 1024, 'le')
    // 把 IFD0 偏移改成远超缓冲区的大数
    bytes.set(le32(0xffff), 4)
    expect(imageSizeOf(bytes)).toBeNull()
  })

  it('entry 表被截断（声明 2 条只给了 1 条）→ null', () => {
    const full = tiffHeader(1024, 1024, 'le')
    expect(imageSizeOf(full.subarray(0, 8 + 2 + 12))).toBeNull()
  })

  it('只有宽没有高 → null（缺一半就是未知）', () => {
    const bytes = new Uint8Array([
      ...ASCII('II'),
      ...le16(42),
      ...le32(8),
      ...le16(1),
      ...le16(0x0100),
      ...le16(3),
      ...le32(1),
      ...le16(1024),
      ...le16(0),
      ...le32(0)
    ])
    expect(imageSizeOf(bytes)).toBeNull()
  })

  it('魔数 42 不对（如 BigTIFF 的 43）→ null，不猜', () => {
    const bytes = tiffHeader(1024, 1024, 'le')
    bytes.set(le16(43), 2)
    expect(imageSizeOf(bytes)).toBeNull()
  })
})

describe('imageSizeOf · 未知格式与垃圾字节', () => {
  it('纯文本 / 随机字节 → null', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull()
    expect(imageSizeOf(new TextEncoder().encode('this is not an image at all'))).toBeNull()
  })

  it('空 buffer → null', () => {
    expect(imageSizeOf(new Uint8Array(0))).toBeNull()
  })

  it('bmp / tga / gif 一律 null（解析器认不出的格式不猜）', () => {
    const bmp = new Uint8Array([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00])
    // TGA 没有魔数，靠文件尾巴的 "TRUEVISION-XFILE" 判定；头部像素随便给
    const tga = new Uint8Array([0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const gif = new Uint8Array([...ASCII('GIF89a'), ...le16(1024), ...le16(1024)])
    expect(imageSizeOf(bmp)).toBeNull()
    expect(imageSizeOf(tga)).toBeNull()
    expect(imageSizeOf(gif)).toBeNull()
  })

  it('截断的 PNG 签名（前 8 字节之外没内容）→ null', () => {
    expect(imageSizeOf(pngHeader(100, 100).subarray(0, 8))).toBeNull()
  })
})

describe('fillImageSizes（导入 / 重扫的落库入口）', () => {
  it('只给图片补 w/h，非图片与坏图保持未知', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'albedo.png'), pngHeader(2048, 2048))
    await fs.writeFile(path.join(dir, 'normal.jpg'), jpegHeader(1024, 4096))
    await fs.writeFile(path.join(dir, 'broken.png'), new TextEncoder().encode('not a png'))
    await fs.writeFile(path.join(dir, 'readme.txt'), 'hello')
    await fs.writeFile(path.join(dir, 'pack.webp'), new TextEncoder().encode('RIFF0000WEBP'))

    const files: AssetFile[] = [
      { rel: 'albedo.png', name: 'albedo.png', ext: 'png', size: 1, kind: 'texture' },
      { rel: 'normal.jpg', name: 'normal.jpg', ext: 'jpg', size: 1, kind: 'texture' },
      { rel: 'broken.png', name: 'broken.png', ext: 'png', size: 1, kind: 'texture' },
      { rel: 'readme.txt', name: 'readme.txt', ext: 'txt', size: 1, kind: 'other' },
      { rel: 'pack.webp', name: 'pack.webp', ext: 'webp', size: 1, kind: 'texture' }
    ]

    await fillImageSizes(dir, files)

    expect(files[0]).toMatchObject({ w: 2048, h: 2048 })
    expect(files[1]).toMatchObject({ w: 1024, h: 4096 })
    expect(files[2].w).toBeUndefined()
    expect(files[2].h).toBeUndefined()
    expect(files[3].w).toBeUndefined()
    expect(files[4].w).toBeUndefined()
  })

  it('文件不存在时静默（不抛错、不写尺寸）→ 导入不会因此失败', async () => {
    const dir = await makeTmpDir()
    const files: AssetFile[] = [
      { rel: 'missing.png', name: 'missing.png', ext: 'png', size: 1, kind: 'texture' }
    ]
    await expect(fillImageSizes(dir, files)).resolves.toBeUndefined()
    expect(files[0].w).toBeUndefined()
  })

  it('webp / tif 落库路径也补得出尺寸（不只是 png/jpg）', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'albedo.webp'), webpVP8X(2048, 2048))
    await fs.writeFile(path.join(dir, 'mask.tif'), tiffHeader(4096, 2048, 'be'))
    await fs.writeFile(path.join(dir, 'bad.webp'), new TextEncoder().encode('RIFF0000WEBP'))

    const files: AssetFile[] = [
      { rel: 'albedo.webp', name: 'albedo.webp', ext: 'webp', size: 1, kind: 'texture' },
      { rel: 'mask.tif', name: 'mask.tif', ext: 'tif', size: 1, kind: 'texture' },
      { rel: 'bad.webp', name: 'bad.webp', ext: 'webp', size: 1, kind: 'texture' }
    ]

    await fillImageSizes(dir, files)

    expect(files[0]).toMatchObject({ w: 2048, h: 2048 })
    expect(files[1]).toMatchObject({ w: 4096, h: 2048 })
    expect(files[2].w).toBeUndefined()
  })

  it('头部读取上限是 64KB（够 JPEG 的 SOF，语义与文档一致）', () => {
    expect(IMAGE_SIZE_HEAD_BYTES).toBe(65_536)
  })
})
