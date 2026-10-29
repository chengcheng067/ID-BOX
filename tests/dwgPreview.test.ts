/**
 * DWG 内嵌缩略图提取单测（CAD 封面来源 M2）。
 *
 * **主体用真实 DWG 跑**（`E:/workbuddy/2026-10-13-01-03-46/cad-probe/out/餐厅平面设计方案.dwg`，
 * 1.27MB，AC1015，8 位调色板 DIB 184×87）：位图转换这种"差一个字节就整图花色/倒置"
 * 的代码，造假字节等于没测。样本**只读**，每条用例先复制到 `os.tmpdir()`。
 *
 * 颜色与朝向的**基准真值**是探针落的那张 `docs/probe/cad-probe-1-dwg-embedded-184x87.png`
 * （同一份 DIB 的独立解码结果）——逐像素比对，比"断言几个固定色值"强得多：
 * 通道顺序反了（BGR↔RGB）、行序翻了、调色板错位，这三种错误都会让比对失败。
 *
 * 3 条纯函数用例（24 位 / 32 位 alpha 全 0 / 非图字节）用合成字节，覆盖真实样本
 * 走不到的分支；它们在注释里明确标了"合成"，不会被误当成真实样本证据。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  DWG_EMPTY_SIZE,
  DWG_IMAGE_OFFSET,
  DWG_SEEKER_OFFSET,
  decodeDibToRgba,
  decodeDwgImageBytes,
  encodePngRgba,
  extractDwgPreview,
  writeDwgPreviewInto
} from '../src/main/dwgPreview'
import { imageSizeOf } from '../src/shared/imageSize'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { Asset, ImportEvent } from '../src/shared/types'

/** 真实样本（只读；探针产出的原始下载件） */
const REAL_DWG = 'E:/workbuddy/2026-10-13-01-03-46/cad-probe/out/餐厅平面设计方案.dwg'

/** 基准真值图（同一份 DIB 的独立解码结果，8 位调色板 PNG） */
const REFERENCE_PNG = path.resolve(__dirname, '../docs/probe/cad-probe-1-dwg-embedded-184x87.png')

const hasRealSample = existsSync(REAL_DWG)
const hasReference = existsSync(REFERENCE_PNG)

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-dwgprev-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 把真实样本复制到 tmp（绝不改原文件） */
async function copyRealSample(name = '餐厅平面设计方案.dwg'): Promise<{ dir: string; abs: string }> {
  const dir = await tmpDir()
  const abs = path.join(dir, name)
  await fs.copyFile(REAL_DWG, abs)
  return { dir, abs }
}

/** 读文件前 n 字节 */
async function readHead(abs: string, n: number): Promise<Buffer> {
  const fh = await fs.open(abs, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

// ── 测试侧的 PNG 解码（只为拿基准真值，不引生产代码） ──────────────────

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 反过滤（支持 5 种 filter；`bpp` = 每像素字节数，调色板图 = 1） */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[dst - stride + i] : 0
      const c = y > 0 && i >= bpp ? out[dst - stride + i - bpp] : 0
      let v: number
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        default:
          v = x + paeth(a, b, c)
      }
      out[dst + i] = v & 0xff
    }
  }
  return out
}

/** 解 8 位调色板 PNG → RGBA（基准真值图就是这种；alpha 一律 255） */
function decodePalettePng(buf: Buffer): { width: number; height: number; rgba: Buffer } | null {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (buf[24] !== 8 || buf[25] !== 3) return null // 只处理 8 位调色板
  let plte: Buffer | null = null
  const idat: Buffer[] = []
  let i = 8
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'PLTE') plte = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    i += 12 + len
  }
  if (!plte) return null
  const idx = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, 1)
  const rgba = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p += 1) {
    const e = idx[p] * 3
    rgba[p * 4] = plte[e]
    rgba[p * 4 + 1] = plte[e + 1]
    rgba[p * 4 + 2] = plte[e + 2]
    rgba[p * 4 + 3] = 255
  }
  return { width, height, rgba }
}

/** 解本模块产出的 PNG（颜色类型 6 / 过滤器 0）→ RGBA */
function decodeOurPng(buf: Buffer): { width: number; height: number; rgba: Buffer } | null {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (buf[24] !== 8 || buf[25] !== 6) return null
  const idat: Buffer[] = []
  let i = 8
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len))
    else if (type === 'IEND') break
    i += 12 + len
  }
  return { width, height, rgba: unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, 4) }
}

// ── 用例 ────────────────────────────────────────────────────────────────

describe('writeDwgPreviewInto —— 真实样本（AC1015 / 8 位调色板 DIB）', () => {
  let previewRel: string | null = null
  let outDir = ''
  let pngBytes: Buffer | null = null

  beforeAll(async () => {
    if (!hasRealSample) return
    const { dir, abs } = await copyRealSample()
    outDir = dir
    previewRel = await writeDwgPreviewInto(abs, dir, '餐厅平面设计方案.dwg')
    pngBytes = previewRel ? await fs.readFile(path.join(dir, previewRel)) : null
  })

  it.skipIf(!hasRealSample)('返回 `<主名>.preview.png` 相对路径，且文件真的落盘', () => {
    expect(previewRel).toBe('餐厅平面设计方案.preview.png')
    expect(pngBytes).not.toBeNull()
    // 签名 + 结尾必须是 IEND（编码器没漏块）
    expect(pngBytes!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(pngBytes!.toString('latin1', pngBytes!.length - 8, pngBytes!.length - 4)).toBe('IEND')
  })

  it.skipIf(!hasRealSample)('落盘图能被 imageSizeOf 读出尺寸，且落在探针实测那一档', () => {
    const size = imageSizeOf(pngBytes!)
    expect(size).not.toBeNull()
    // 探针：主流 224×140、最小 184×78（本样本 184×87）—— 用区间断言，换样本也不脆
    expect(size!.w).toBeGreaterThan(100)
    expect(size!.w).toBeLessThan(400)
    expect(size!.h).toBeGreaterThan(50)
    expect(size!.h).toBeLessThan(250)
    // 宽高比正常（不是被行补齐撑宽的斜纹图）
    const ratio = size!.w / size!.h
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(4)
  })

  it.skipIf(!hasRealSample)('extractDwgPreview 报的原始格式/位深与探针一致（dib / 8 位）', async () => {
    const { abs } = await copyRealSample()
    const found = await extractDwgPreview(abs)
    expect(found).not.toBeNull()
    expect(found!.format).toBe('dib')
    expect(found!.bitCount).toBe(8)
    expect(found!.width).toBe(184)
    expect(found!.height).toBe(87)
  })

  it.skipIf(!hasRealSample || !hasReference)(
    '颜色不反转、朝向不颠倒：与探针那张独立解码图逐像素一致',
    async () => {
      const expected = decodePalettePng(await fs.readFile(REFERENCE_PNG))
      const actual = decodeOurPng(pngBytes!)
      expect(expected).not.toBeNull()
      expect(actual).not.toBeNull()
      expect({ w: actual!.width, h: actual!.height }).toEqual({ w: expected!.width, h: expected!.height })
      expect(actual!.rgba.equals(expected!.rgba)).toBe(true)
    }
  )

  it.skipIf(!hasRealSample)('重复调用幂等（同一文件覆盖写，不抛）', async () => {
    const { dir, abs } = await copyRealSample()
    const first = await writeDwgPreviewInto(abs, dir, 'a.dwg')
    const second = await writeDwgPreviewInto(abs, dir, 'a.dwg')
    expect(first).toBe('a.preview.png')
    expect(second).toBe(first)
  })

  afterAll(async () => {
    // outDir 由 afterEach 统一清（tmpRoots 里已记录）
    void outDir
  })
})

describe('extractDwgPreview —— 失败形态一律 null（绝不抛）', () => {
  it('文件不存在 → null', async () => {
    await expect(extractDwgPreview(path.join(os.tmpdir(), 'mv-no-such-file-xyz.dwg'))).resolves.toBeNull()
  })

  it('随机字节（没有 DWG 版本号 / 哨兵）→ null', async () => {
    const dir = await tmpDir()
    const abs = path.join(dir, 'random.dwg')
    const junk = Buffer.alloc(1024)
    for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37 + 11) & 0xff
    await fs.writeFile(abs, junk)
    await expect(extractDwgPreview(abs)).resolves.toBeNull()
  })

  it.skipIf(!hasRealSample)('截断到前 200 字节的副本 → null', async () => {
    const { dir, abs } = await copyRealSample('trunc.dwg')
    const head = await readHead(abs, 200)
    const cut = path.join(dir, 'cut.dwg')
    await fs.writeFile(cut, head)
    await expect(extractDwgPreview(cut)).resolves.toBeNull()
  })

  it.skipIf(!hasRealSample)(`size 改成 ${DWG_EMPTY_SIZE}（= 文件里没有图）→ null`, async () => {
    const { abs } = await copyRealSample('nosize.dwg')
    const head = await readHead(abs, 32)
    const seek = head.readUInt32LE(DWG_SEEKER_OFFSET)
    const fh = await fs.open(abs, 'r+')
    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(DWG_EMPTY_SIZE, 0)
      await fh.write(sizeBuf, 0, 4, seek + 16)
    } finally {
      await fh.close()
    }
    // 直连真值：改完这张图就"不存在"了
    await expect(extractDwgPreview(abs)).resolves.toBeNull()
  })

  it.skipIf(!hasRealSample)('size 声明得比文件还长（越界）→ null，不越界读', async () => {
    const { abs } = await copyRealSample('huge.dwg')
    const head = await readHead(abs, 32)
    const seek = head.readUInt32LE(DWG_SEEKER_OFFSET)
    const fh = await fs.open(abs, 'r+')
    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(0x7fff_ffff, 0)
      await fh.write(sizeBuf, 0, 4, seek + 16)
    } finally {
      await fh.close()
    }
    await expect(extractDwgPreview(abs)).resolves.toBeNull()
  })

  it.skipIf(!hasRealSample)('哨兵位置对但图头不认识（填充 0x00）→ null', async () => {
    const { abs } = await copyRealSample('badfmt.dwg')
    const head = await readHead(abs, 32)
    const seek = head.readUInt32LE(DWG_SEEKER_OFFSET)
    const fh = await fs.open(abs, 'r+')
    try {
      await fh.write(Buffer.alloc(16), 0, 16, seek + DWG_IMAGE_OFFSET)
    } finally {
      await fh.close()
    }
    await expect(extractDwgPreview(abs)).resolves.toBeNull()
  })
})

describe('decodeDibToRgba —— 真实样本走 8 位调色板分支', () => {
  it.skipIf(!hasRealSample)('解真实 DIB：184×87、全不透明、调色板颜色按 BGR 还原', async () => {
    const { abs } = await copyRealSample()
    const head = await readHead(abs, 32)
    const seek = head.readUInt32LE(DWG_SEEKER_OFFSET)
    const fh = await fs.open(abs, 'r')
    let dib: Buffer
    try {
      const sizeBuf = Buffer.alloc(4)
      await fh.read(sizeBuf, 0, 4, seek + 16)
      const size = sizeBuf.readUInt32LE(0)
      dib = Buffer.alloc(size - DWG_EMPTY_SIZE)
      await fh.read(dib, 0, dib.length, seek + DWG_IMAGE_OFFSET)
    } finally {
      await fh.close()
    }

    const bmp = decodeDibToRgba(dib)
    expect(bmp).not.toBeNull()
    expect({ w: bmp!.width, h: bmp!.height }).toEqual({ w: 184, h: 87 })

    // 每个像素都必须不透明（调色板第 4 字节是保留位，不能当 alpha）
    let opaque = 0
    for (let p = 3; p < bmp!.rgba.length; p += 4) if (bmp!.rgba[p] === 255) opaque += 1
    expect(opaque).toBe(184 * 87)

    // 调色板第 0 项是 `30 28 21`（BGR）→ RGBA 必须是 `21 28 30`
    // 用"图上出现次数最多"的颜色反查不现实，这里直接核一个确定性关系：
    // 每个像素的 RGB 必须等于 DIB 调色板里某一项（没有越项、没有错位）
    const palette = dib.subarray(40, 40 + 4 * 256)
    const known = new Set<string>()
    for (let i = 0; i < 256; i += 1) {
      const p = i * 4
      known.add(`${palette[p + 2]},${palette[p + 1]},${palette[p]}`)
    }
    let matched = 0
    for (let p = 0; p < bmp!.rgba.length; p += 4) {
      if (known.has(`${bmp!.rgba[p]},${bmp!.rgba[p + 1]},${bmp!.rgba[p + 2]}`)) matched += 1
    }
    expect(matched).toBe(184 * 87)
  })
})

describe('decodeDibToRgba / decodeDwgImageBytes —— 分支口径（合成字节，只测算术）', () => {
  /** 造一个 24 位 bottom-up DIB：2×2，行补齐 2 字节（2*3=6 → 8） */
  function dib24(): Buffer {
    const head = Buffer.alloc(40)
    head.writeUInt32LE(40, 0)
    head.writeInt32LE(2, 4)
    head.writeInt32LE(2, 8) // 正数 = bottom-up
    head.writeUInt16LE(1, 12)
    head.writeUInt16LE(24, 14)
    head.writeUInt32LE(0, 16)
    // 行 0（= 图上最后一行）：蓝、绿；行 1（= 图上第一行）：红、白
    const bottom = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0])
    const top = Buffer.from([0, 0, 255, 255, 255, 255, 0, 0])
    return Buffer.concat([head, bottom, top])
  }

  it('24 位：BGR→RGBA、alpha 补 255、行序翻正、行补齐不影响像素', () => {
    const bmp = decodeDibToRgba(dib24())
    expect(bmp).not.toBeNull()
    expect({ w: bmp!.width, h: bmp!.height }).toEqual({ w: 2, h: 2 })
    // 第一行（top）：红、白；第二行（bottom）：蓝、绿
    expect([...bmp!.rgba]).toEqual([
      255, 0, 0, 255, 255, 255, 255, 255,
      0, 0, 255, 255, 0, 255, 0, 255
    ])
  })

  it('biHeight < 0（top-down）→ 不翻转', () => {
    const dib = Buffer.from(dib24())
    dib.writeInt32LE(-2, 8)
    const bmp = decodeDibToRgba(dib)
    expect([...bmp!.rgba]).toEqual([
      0, 0, 255, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 255, 255, 255, 255
    ])
  })

  it('32 位 alpha 全 0 → 视为不透明（老 CAD 导出习惯）', () => {
    const head = Buffer.alloc(40)
    head.writeUInt32LE(40, 0)
    head.writeInt32LE(1, 4)
    head.writeInt32LE(1, 8)
    head.writeUInt16LE(1, 12)
    head.writeUInt16LE(32, 14)
    const dib = Buffer.concat([head, Buffer.from([30, 40, 50, 0])])
    const bmp = decodeDibToRgba(dib)
    expect([...bmp!.rgba]).toEqual([50, 40, 30, 255])
  })

  it('不支持的位深（1/4/16）→ null', () => {
    for (const bpp of [1, 4, 16]) {
      const head = Buffer.alloc(40)
      head.writeUInt32LE(40, 0)
      head.writeInt32LE(1, 4)
      head.writeInt32LE(1, 8)
      head.writeUInt16LE(1, 12)
      head.writeUInt16LE(bpp, 14)
      expect(decodeDibToRgba(Buffer.concat([head, Buffer.alloc(64)]))).toBeNull()
    }
  })

  it('BI_BITFIELDS(3) → null（通道顺序不确定，宁缺勿错）', () => {
    const head = Buffer.alloc(40)
    head.writeUInt32LE(40, 0)
    head.writeInt32LE(1, 4)
    head.writeInt32LE(1, 8)
    head.writeUInt16LE(1, 12)
    head.writeUInt16LE(32, 14)
    head.writeUInt32LE(3, 16)
    expect(decodeDibToRgba(Buffer.concat([head, Buffer.alloc(64)]))).toBeNull()
  })

  it('像素数据被截断 → null（不读越界）', () => {
    const dib = dib24()
    expect(decodeDibToRgba(dib.subarray(0, dib.length - 4))).toBeNull()
  })

  it('图头既不是 PNG 也不是 DIB → null', () => {
    expect(decodeDwgImageBytes(Buffer.alloc(64, 0x7f))).toBeNull()
  })

  it('encodePngRgba 产出合法 PNG（签名 + IHDR 尺寸 + IEND）', () => {
    const png = encodePngRgba(1, 1, Buffer.from([1, 2, 3, 255]))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(imageSizeOf(png)).toEqual({ w: 1, h: 1 })
    expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND')
  })
})

// ── 挂到导入链路（M2 的最后一公里：接口对了但没接上 = 没做） ─────────────

/** 最小导入依赖（与 `tests/importerSingleModel.test.ts` 同形，注入桩、零网络） */
function makeImportDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  return {
    events,
    deps: {
      libraryDir,
      sevenZipPath: null,
      archiveDisposal: 'delete',
      defaultSource: '本机',
      codepage: 'auto',
      timeoutMs: 60_000,
      maxBytesForJsFallback: 200 * 1024 * 1024,
      spaceSafetyFactor: 1.2,
      concurrency: DEFAULT_CONCURRENCY,
      emit: (ev) => events.push(ev)
    }
  }
}

describe('挂到导入链路：.dwg 单文件直导', () => {
  it.skipIf(!hasRealSample)(
    '.dwg → kind=cad + coverSource=embedded + cover 是 .preview.png 且同时进 files',
    async () => {
      const root = await tmpDir()
      const lib = path.join(root, 'Library')
      await fs.mkdir(lib, { recursive: true })
      const src = path.join(root, '餐厅平面设计方案ID_1200166260.dwg')
      await fs.copyFile(REAL_DWG, src)

      const { deps, events } = makeImportDeps(lib)
      const assets = await importPaths([src], deps)

      expect(assets.length).toBe(1)
      const a: Asset = assets[0]!
      expect(a.kind).toBe('cad')
      expect(a.coverSource).toBe('embedded')
      expect(a.cover).toBe('餐厅平面设计方案ID_1200166260.preview.png')
      // rescan 口径：预览图必须在 files 里，否则重扫后 cover 指向不存在的文件
      expect(a.files.some((f) => f.rel === a.cover)).toBe(true)
      expect(a.files.find((f) => f.rel === a.cover)!.kind).toBe('texture')
      // 文件真的落在资产文件夹里，且是一张能读出尺寸的 PNG
      const abs = path.join(a.folder, a.cover!)
      const size = imageSizeOf(await fs.readFile(abs))
      expect(size).not.toBeNull()
      expect(size!.w).toBeGreaterThan(100)
      // 源工程文件原地不动（复制入库）
      await expect(fs.stat(src)).resolves.toBeTruthy()
      expect(events.some((e) => e.status === 'done')).toBe(true)
      // 文件名里的 ID → zhimoId（批次结束后 M3 用同一 ID 去 sgt 频道抓 400×300 主图）
      expect(a.zhimoId).toBe('1200166260')
    }
  )

  it.skipIf(!hasRealSample)('没有内嵌图的 dwg（size 改成 90）→ 占位封面，不崩', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '无预览平面图.dwg')
    await fs.copyFile(REAL_DWG, src)
    const head = await readHead(src, 32)
    const seek = head.readUInt32LE(DWG_SEEKER_OFFSET)
    const fh = await fs.open(src, 'r+')
    try {
      const sizeBuf = Buffer.alloc(4)
      sizeBuf.writeUInt32LE(DWG_EMPTY_SIZE, 0)
      await fh.write(sizeBuf, 0, 4, seek + 16)
    } finally {
      await fh.close()
    }

    const { deps } = makeImportDeps(lib)
    const [a] = await importPaths([src], deps)
    expect(a!.kind).toBe('cad')
    expect(a!.coverSource).toBe('placeholder')
    // 没有封面就不该白跑一次缩略图
    expect(a!.thumbStatus).toBe('none')
    expect(await fs.readdir(a!.folder)).toEqual(['无预览平面图.dwg'])
  })
})
