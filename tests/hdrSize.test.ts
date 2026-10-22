/**
 * HDR / EXR 文件头尺寸解析（2026-10「分辨率筛选在材质与 HDR 都失效」的补采端）。
 *
 * 三条底线：
 * ① Radiance 只认**文本头**：魔法行 → 注释 → 空行 → 分辨率行，像素一个字节都不读；
 * ② OpenEXR 的属性**顺序任意**（`dataWindow` 可能排在第 5 个），必须逐项按 `size` 跳过；
 * ③ 不认识 / 被截断 / 数字非法 → `null`，**绝不抛异常**（导入链路靠它"失败静默"）。
 *
 * 另外钉一条回归：PNG 头喂给 `hdrSizeOf` 必须是 `null`
 * （否则 `imageSizeOfExt` 的扩展名分支一旦判错就会读出垃圾宽高）。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hdrSizeOf } from '../src/shared/imageSize'
import { fillImageSizes } from '../src/main/importer'
import type { AssetFile } from '../src/shared/types'

/** 用 latin1 拼出文件头字节（Radiance 头部是纯 ASCII 文本） */
function latin1Bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'))
}

/** 真实样本的头部结构（`-Y 8192 +X 16384`，取自库里的 16384×8192 HDR） */
const REAL_RADIANCE_HEAD = [
  '#?RADIANCE',
  '# Made with Adobe Photoshop',
  'FORMAT=32-bit_rle_rgbe',
  '',
  '-Y 8192 +X 16384',
  ''
].join('\n')

function radiance(lines: string[], eol = '\n'): Uint8Array {
  return latin1Bytes(lines.join(eol) + eol)
}

// ── EXR 构造：属性 = name\0 + type\0 + size(int32 LE) + value ──────────────

function cstr(s: string): number[] {
  return [...Buffer.from(s, 'latin1'), 0]
}

function i32le(n: number): number[] {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, true)
  return [...b]
}

function attr(name: string, type: string, value: number[]): number[] {
  return [...cstr(name), ...cstr(type), ...i32le(value.length), ...value]
}

/** `box2i`：xMin, yMin, xMax, yMax（各 4 字节小端） */
function box2i(xMin: number, yMin: number, xMax: number, yMax: number): number[] {
  return [...i32le(xMin), ...i32le(yMin), ...i32le(xMax), ...i32le(yMax)]
}

/** 魔数 + version + 属性列表 + 空 name 收尾 */
function exr(attrs: number[][]): Uint8Array {
  const bytes: number[] = [0x76, 0x2f, 0x31, 0x01, 0x02, 0x00, 0x00, 0x00]
  for (const a of attrs) bytes.push(...a)
  bytes.push(0)
  return new Uint8Array(bytes)
}

/** 最小 PNG 头（签名 + IHDR + w/h），用来验证"HDR 解析器不许误判普通图片" */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
  bytes.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

const tmpRoots: string[] = []

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-hdrsize-'))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('hdrSizeOf — Radiance .hdr', () => {
  it('真实样本头（-Y 8192 +X 16384）→ 16384×8192（宽是 X、高是 Y）', () => {
    expect(hdrSizeOf(latin1Bytes(REAL_RADIANCE_HEAD))).toEqual({ w: 16384, h: 8192 })
  })

  it('轴顺序与符号都换（+Y 512 -X 1024）→ 1024×512', () => {
    const head = radiance(['#?RADIANCE', 'FORMAT=32-bit_rle_rgbe', '', '+Y 512 -X 1024'])
    expect(hdrSizeOf(head)).toEqual({ w: 1024, h: 512 })
  })

  it('#?RGBE 魔法行同样认', () => {
    const head = radiance(['#?RGBE', 'FORMAT=32-bit_rle_rgbe', '', '-Y 100 +X 200'])
    expect(hdrSizeOf(head)).toEqual({ w: 200, h: 100 })
  })

  it('头部有多行注释 / 额外 KEY=VALUE（EXPOSURE、GAMMA、软件名）仍能定位分辨率行', () => {
    const head = radiance([
      '#?RADIANCE',
      '# Made with Adobe Photoshop',
      '# some other tool',
      'FORMAT=32-bit_rle_rgbe',
      'EXPOSURE=1.0000000000000',
      'GAMMA=1.0',
      'SOFTWARE=photoshop',
      '',
      '-Y 5000 +X 10000',
      ''
    ])
    expect(hdrSizeOf(head)).toEqual({ w: 10000, h: 5000 })
  })

  it('CRLF 行尾（\\r\\n）不影响解析', () => {
    const head = radiance(['#?RADIANCE', 'FORMAT=32-bit_rle_rgbe', '', '-Y 700 +X 1400'], '\r\n')
    expect(hdrSizeOf(head)).toEqual({ w: 1400, h: 700 })
  })

  it('缺分辨率行（空行之后缓冲区就结束）→ null', () => {
    const head = radiance(['#?RADIANCE', 'FORMAT=32-bit_rle_rgbe', ''])
    expect(hdrSizeOf(head)).toBeNull()
  })

  it('完全没有空行（头部被截断）→ null', () => {
    expect(hdrSizeOf(latin1Bytes('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n-Y 10 +X 20'))).toBeNull()
  })

  it('分辨率行缺失 / 形状不对（Y 10 X 20 无符号）→ null', () => {
    expect(hdrSizeOf(radiance(['#?RADIANCE', '', 'Y 10 X 20']))).toBeNull()
    expect(hdrSizeOf(radiance(['#?RADIANCE', '', '-Y abc +X 20']))).toBeNull()
  })

  it('尺寸为 0 → null', () => {
    expect(hdrSizeOf(radiance(['#?RADIANCE', '', '-Y 0 +X 16384']))).toBeNull()
    expect(hdrSizeOf(radiance(['#?RADIANCE', '', '-Y 8192 +X 0']))).toBeNull()
  })

  it('尺寸为负 → null（负号只在轴前，值前出现负号即非法）', () => {
    expect(hdrSizeOf(radiance(['#?RADIANCE', '', '-Y -8192 +X 16384']))).toBeNull()
  })

  it('魔法行不是 Radiance → null', () => {
    expect(hdrSizeOf(latin1Bytes('#?NOTRADIANCE\n\n-Y 10 +X 20\n'))).toBeNull()
  })
})

describe('hdrSizeOf — OpenEXR .exr', () => {
  it('属性顺序打乱（chromaticities 前置、compression 夹中间）仍能读到 dataWindow', () => {
    const head = exr([
      // 8 个 float = 32 字节，故意放最前面
      attr('chromaticities', 'chromaticities', new Array<number>(32).fill(0)),
      attr('compression', 'compression', [0]),
      attr('dataWindow', 'box2i', box2i(0, 0, 2047, 1023)),
      attr('displayWindow', 'box2i', box2i(0, 0, 1, 1))
    ])
    expect(hdrSizeOf(head)).toEqual({ w: 2048, h: 1024 })
  })

  it('dataWindow 的坐标非 0（xMin/yMin 偏移）时按 max-min+1 算', () => {
    const head = exr([attr('dataWindow', 'box2i', box2i(-4, -8, 95, 183))])
    expect(hdrSizeOf(head)).toEqual({ w: 100, h: 192 })
  })

  it('被截断（属性 value 越过缓冲区结尾）→ null，且不抛异常', () => {
    const full = exr([attr('dataWindow', 'box2i', box2i(0, 0, 2047, 1023))])
    expect(() => hdrSizeOf(full.subarray(0, full.length - 6))).not.toThrow()
    expect(hdrSizeOf(full.subarray(0, full.length - 6))).toBeNull()
  })

  it('属性名没有 NUL 终止符 → null', () => {
    const bytes = new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0, 0x64, 0x61, 0x74])
    expect(hdrSizeOf(bytes)).toBeNull()
  })

  it('dataWindow 尺寸为 0（xMax < xMin）→ null', () => {
    const head = exr([attr('dataWindow', 'box2i', box2i(10, 10, 5, 5))])
    expect(hdrSizeOf(head)).toBeNull()
  })

  it('dataWindow 的 type 不是 box2i → null', () => {
    const head = exr([attr('dataWindow', 'float', [0, 0, 0, 0])])
    expect(hdrSizeOf(head)).toBeNull()
  })

  it('非 EXR 魔法 → null', () => {
    expect(hdrSizeOf(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0]))).toBeNull()
    expect(hdrSizeOf(new Uint8Array([0x76, 0x2f, 0x31, 0x02, 2, 0, 0, 0]))).toBeNull()
  })
})

describe('hdrSizeOf — 回归：不许误判普通图片', () => {
  it('PNG 头 → null（HDR 解析器不许从 PNG 里读出垃圾宽高）', () => {
    expect(hdrSizeOf(pngHeader(1920, 1080))).toBeNull()
  })

  it('JPEG 头（FF D8 FF）→ null', () => {
    expect(hdrSizeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBeNull()
  })

  it('空 / 过短缓冲区 → null', () => {
    expect(hdrSizeOf(new Uint8Array(0))).toBeNull()
    expect(hdrSizeOf(new Uint8Array([0x23, 0x3f]))).toBeNull()
  })
})

describe('fillImageSizes — 导入链路让 HDR / EXR 走 hdrSizeOf 分支', () => {
  it('.hdr 与 .exr 都写上 w/h，普通 PNG 仍走 imageSizeOf', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'a.hdr'), Buffer.from(REAL_RADIANCE_HEAD, 'latin1'))
    await fs.writeFile(
      path.join(dir, 'b.exr'),
      Buffer.from(exr([attr('dataWindow', 'box2i', box2i(0, 0, 1023, 511))]))
    )
    await fs.writeFile(path.join(dir, 'c.png'), Buffer.from(pngHeader(64, 32)))
    // 读不出的 HDR：不许抛错、不许写 w/h
    await fs.writeFile(path.join(dir, 'broken.hdr'), Buffer.from('#?RADIANCE\nFORMAT=x\n', 'latin1'))

    const files: AssetFile[] = [
      { rel: 'a.hdr', name: 'a.hdr', ext: 'hdr', size: 0, kind: 'texture' },
      { rel: 'b.exr', name: 'b.exr', ext: 'exr', size: 0, kind: 'texture' },
      { rel: 'c.png', name: 'c.png', ext: 'png', size: 0, kind: 'texture' },
      { rel: 'broken.hdr', name: 'broken.hdr', ext: 'hdr', size: 0, kind: 'texture' }
    ]

    await expect(fillImageSizes(dir, files)).resolves.toBeUndefined()

    expect(files[0].w).toBe(16384)
    expect(files[0].h).toBe(8192)
    expect(files[1].w).toBe(1024)
    expect(files[1].h).toBe(512)
    expect(files[2].w).toBe(64)
    expect(files[2].h).toBe(32)
    expect(files[3].w).toBeUndefined()
    expect(files[3].h).toBeUndefined()
  })
})
