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

describe('imageSizeOf · 未知格式与垃圾字节', () => {
  it('纯文本 / 随机字节 → null', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull()
    expect(imageSizeOf(new TextEncoder().encode('this is not an image at all'))).toBeNull()
  })

  it('空 buffer → null', () => {
    expect(imageSizeOf(new Uint8Array(0))).toBeNull()
  })

  it('webp / bmp / tga 一律 null（不认识就不猜）', () => {
    const webp = new TextEncoder().encode('RIFF....WEBPVP8 ')
    const bmp = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0])
    expect(imageSizeOf(webp)).toBeNull()
    expect(imageSizeOf(bmp)).toBeNull()
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

  it('头部读取上限是 64KB（够 JPEG 的 SOF，语义与文档一致）', () => {
    expect(IMAGE_SIZE_HEAD_BYTES).toBe(65_536)
  })
})
