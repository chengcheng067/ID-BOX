/**
 * 尺寸回填通道（`main/probeSizes.ts`）—— 只用 `os.tmpdir()`，**绝不碰真实库**。
 *
 * 钉四件事：
 * ① 一张 PNG + 一个 .hdr 都能返回正确宽高（两条解析分支都通了）；
 * ② 越界相对路径（`..` 穿越）的那一条**不返回**，也不影响同批其它条目、不抛异常；
 * ③ 单次上限 `PROBE_SIZES_MAX`：超出部分直接不处理（调用方负责分片）；
 * ④ **分级读头**：JPEG 的 SOF 落在 64KB 之后时，升到 1MB 重试一次；其它格式不升级。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROBE_SIZES_MAX,
  isJpegExt,
  probeSizes,
  readHeadForSize,
  type HeadReader
} from '../src/main/probeSizes'
import { IMAGE_SIZE_HEAD_BYTES, IMAGE_SIZE_HEAD_BYTES_LARGE, imageSizeOf } from '../src/shared/imageSize'

const tmpRoots: string[] = []

/** 最小 PNG 头（签名 + IHDR + 宽高）；解析器只读头部，不需要像素数据 */
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

const HDR_HEAD = ['#?RADIANCE', '# Made with Adobe Photoshop', 'FORMAT=32-bit_rle_rgbe', '', '-Y 8192 +X 16384', ''].join('\n')

async function makeAssetFolder(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-probesizes-'))
  tmpRoots.push(dir)
  await fs.writeFile(path.join(dir, 'albedo.png'), Buffer.from(pngHeader(2048, 2048)))
  await fs.writeFile(path.join(dir, 'pano.hdr'), Buffer.from(HDR_HEAD, 'latin1'))
  await fs.writeFile(path.join(dir, 'model.skp'), Buffer.from([0x00, 0x01, 0x02]))
  await fs.mkdir(path.join(dir, 'maps'), { recursive: true })
  await fs.writeFile(path.join(dir, 'maps', 'normal.png'), Buffer.from(pngHeader(512, 256)))
  return dir
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {}))
  )
})

describe('probeSizes', () => {
  it('PNG 与 HDR 都返回正确宽高（含子目录 rel）', async () => {
    const folder = await makeAssetFolder()
    const got = await probeSizes(folder, ['albedo.png', 'pano.hdr', 'maps/normal.png'])

    const byRel = new Map(got.map((r) => [r.rel, r]))
    expect(byRel.get('albedo.png')).toEqual({ rel: 'albedo.png', w: 2048, h: 2048 })
    expect(byRel.get('pano.hdr')).toEqual({ rel: 'pano.hdr', w: 16384, h: 8192 })
    expect(byRel.get('maps/normal.png')).toEqual({ rel: 'maps/normal.png', w: 512, h: 256 })
    expect(got).toHaveLength(3)
  })

  it('越界路径（.. 穿越）不返回该条、不影响同批其它条目、不抛异常', async () => {
    const folder = await makeAssetFolder()
    // 在 folder 外放一张图：如果 safeJoin 失效，它就会被读到并出现在结果里
    const outside = path.join(path.dirname(folder), 'outside-idbox-probe.png')
    await fs.writeFile(outside, Buffer.from(pngHeader(999, 999)))
    tmpRoots.push(outside)

    const rels = ['../outside-idbox-probe.png', 'albedo.png', '../../Windows/win.ini']
    await expect(probeSizes(folder, rels)).resolves.toEqual([
      { rel: 'albedo.png', w: 2048, h: 2048 }
    ])
  })

  it('读不出的条目被静默忽略（不存在的文件 / 不认识的后缀 / 坏 HDR）', async () => {
    const folder = await makeAssetFolder()
    await fs.writeFile(path.join(folder, 'broken.hdr'), Buffer.from('#?RADIANCE\nFORMAT=x\n', 'latin1'))

    const got = await probeSizes(folder, ['nope.png', 'model.skp', 'broken.hdr', 'albedo.png'])
    expect(got).toEqual([{ rel: 'albedo.png', w: 2048, h: 2048 }])
  })

  it('单次上限：超出 PROBE_SIZES_MAX 的条目不再处理', async () => {
    const folder = await makeAssetFolder()
    const rels = Array.from({ length: PROBE_SIZES_MAX + 5 }, () => 'albedo.png')
    const got = await probeSizes(folder, rels)
    expect(got).toHaveLength(PROBE_SIZES_MAX)
    expect(got.every((r) => r.w === 2048 && r.h === 2048)).toBe(true)
  })

  it('空入参 / 非法入参 → 空数组（IPC 表面只有一种形状）', async () => {
    const folder = await makeAssetFolder()
    expect(await probeSizes(folder, [])).toEqual([])
    expect(await probeSizes('', ['albedo.png'])).toEqual([])
    expect(await probeSizes(folder, ['', 'albedo.png'])).toEqual([
      { rel: 'albedo.png', w: 2048, h: 2048 }
    ])
  })
})

// ── 分级读头（SOF 落在 64KB 之后的 JPEG） ────────────────────────────────

/**
 * 构造一个 JPEG：SOI → 若干 APP2 填充段 → SOF0 → EOI。
 *
 * `minSofOffset` 用来把 SOF0 推到指定字节之后（复现"ICC 配置太大，64KB 够不着"）。
 * APP2 单段载荷上限 65533（长度字段含自身 2 字节，故 0xFFFF 封顶）。
 */
function jpegWithSofAfter(w: number, h: number, minSofOffset: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8] // SOI
  while (minSofOffset - parts.length > 4) {
    const payload = Math.min(65_533, minSofOffset - parts.length - 4)
    const segLen = payload + 2
    parts.push(0xff, 0xe2, (segLen >> 8) & 0xff, segLen & 0xff)
    for (let i = 0; i < payload; i += 1) parts.push(0x00)
  }
  // SOF0：len=17, precision=8, height, width, 3 分量
  parts.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1
  )
  parts.push(0xff, 0xd9) // EOI
  return new Uint8Array(parts)
}

/** 计数版读头：把预置的完整字节按请求长度切片，并记录每次请求的字节数 */
function countingReader(bytes: Uint8Array): { read: HeadReader; calls: number[] } {
  const calls: number[] = []
  const read: HeadReader = async (_absPath, n) => {
    calls.push(n)
    return bytes.subarray(0, Math.min(n, bytes.length))
  }
  return { read, calls }
}

describe('readHeadForSize —— 分级读头', () => {
  it('SOF0 在 678557 字节处：64KB 解析不到（null），升级到 1MB 后拿到正确宽高', async () => {
    const jpeg = jpegWithSofAfter(4096, 2048, 678_557)
    // ① 先证明这个 fixture 真的能复现缺陷：只给 64KB 一定是 null
    expect(jpeg.length).toBeGreaterThan(IMAGE_SIZE_HEAD_BYTES_LARGE / 2)
    expect(imageSizeOf(jpeg.subarray(0, IMAGE_SIZE_HEAD_BYTES))).toBeNull()

    // ② 分级读头：第一次 64KB → null，第二次 1MB → 命中
    const { read, calls } = countingReader(jpeg)
    const size = await readHeadForSize('E:/fake/icc.jpeg', 'jpeg', read)
    expect(size).toEqual({ w: 4096, h: 2048 })
    expect(calls).toEqual([IMAGE_SIZE_HEAD_BYTES, IMAGE_SIZE_HEAD_BYTES_LARGE])
  })

  it('普通小 JPEG / PNG / HDR 只读一次 64KB（不升级）', async () => {
    const smallJpeg = jpegWithSofAfter(2048, 2048, 2)
    const j1 = countingReader(smallJpeg)
    expect(await readHeadForSize('a.jpg', 'jpg', j1.read)).toEqual({ w: 2048, h: 2048 })
    expect(j1.calls).toEqual([IMAGE_SIZE_HEAD_BYTES])

    const png = countingReader(pngHeader(720, 720))
    expect(await readHeadForSize('b.PNG', '.PNG', png.read)).toEqual({ w: 720, h: 720 })
    expect(png.calls).toEqual([IMAGE_SIZE_HEAD_BYTES])

    const hdr = countingReader(Buffer.from(HDR_HEAD, 'latin1'))
    expect(await readHeadForSize('c.hdr', 'hdr', hdr.read)).toEqual({ w: 16384, h: 8192 })
    expect(hdr.calls).toEqual([IMAGE_SIZE_HEAD_BYTES])
  })

  it('PNG / EXR 即使解析失败也不升级（只有 jpeg 才升）', async () => {
    // 只有签名的坏 PNG：imageSizeOf 返回 null，但 ext 不是 jpeg → 不读第二遍
    const badPng = countingReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(await readHeadForSize('bad.png', 'png', badPng.read)).toBeNull()
    expect(badPng.calls).toEqual([IMAGE_SIZE_HEAD_BYTES])

    const badExr = countingReader(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
    expect(await readHeadForSize('bad.exr', 'exr', badExr.read)).toBeNull()
    expect(badExr.calls).toEqual([IMAGE_SIZE_HEAD_BYTES])
  })

  it('升级后仍解析失败（假 jpeg 头）→ null、不抛，且恰好读 2 次', async () => {
    const fake = new Uint8Array(IMAGE_SIZE_HEAD_BYTES_LARGE)
    fake.set([0xff, 0xd8]) // 只有 SOI，后面全是 0x00（没有合法段）
    const { read, calls } = countingReader(fake)
    await expect(readHeadForSize('fake.jpg', 'jpg', read)).resolves.toBeNull()
    expect(calls).toEqual([IMAGE_SIZE_HEAD_BYTES, IMAGE_SIZE_HEAD_BYTES_LARGE])
  })

  it('isJpegExt：只认 jpg / jpeg（大小写、前导点都不敏感）', () => {
    expect(isJpegExt('jpg')).toBe(true)
    expect(isJpegExt('.JPEG')).toBe(true)
    expect(isJpegExt('jpe')).toBe(false)
    expect(isJpegExt('png')).toBe(false)
  })
})

describe('probeSizes —— 端到端走分级读头', () => {
  it('临时目录里放一张 SOF 在 64KB 之后的 jpg，probeSizes 也能读到尺寸', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-probesizes-big-'))
    tmpRoots.push(dir)
    await fs.writeFile(path.join(dir, 'icc.jpg'), jpegWithSofAfter(3000, 1500, 678_557))

    expect(await probeSizes(dir, ['icc.jpg'])).toEqual([{ rel: 'icc.jpg', w: 3000, h: 1500 }])
  })
})
