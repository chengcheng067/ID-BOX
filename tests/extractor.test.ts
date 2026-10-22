import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildZip, gbkBytes, zipDir, zipEntry, utf8Bytes } from './fixtures/gbkZip'
import { extractArchive, ExtractionError, listUncompressedBytes } from '../src/main/extractor'
import { walkFiles } from '../src/main/fsutil'
import type { AssetFile } from '../src/shared/types'
import type { Codepage } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-extract-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

const OPTS = (codepage: Codepage, over: Partial<{ maxBytesForJsFallback: number }> = {}) => ({
  sevenZipPath: null,
  codepage,
  timeoutMs: 60_000,
  maxBytesForJsFallback: over.maxBytesForJsFallback ?? 200 * 1024 * 1024
})

/** 知末典型形态：GBK 文件名字节 + **不置** UTF-8 flag */
function gbkArchive(): Buffer {
  return buildZip([
    zipDir('现代衣柜'),
    zipDir('现代衣柜/贴图'),
    zipEntry('现代衣柜/预览图.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    zipEntry('现代衣柜/贴图/木纹 01.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])),
    zipEntry('现代衣柜/现代衣柜.txt', 'model placeholder')
  ])
}

/** 现代打包器形态：UTF-8 文件名字节 + 置 UTF-8 flag */
function utf8Archive(): Buffer {
  return buildZip([
    zipDir('现代衣柜', { encoding: 'utf8' }),
    zipEntry('现代衣柜/预览图.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { encoding: 'utf8' })
  ])
}

async function relsOf(dir: string): Promise<string[]> {
  const files: AssetFile[] = []
  await walkFiles(dir, dir, files)
  return files.map((f) => f.rel).sort()
}

describe('extractArchive — GBK 中文名（K1 / P0-2）', () => {
  it('codepage=gbk → 解出的中文路径零乱码', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(src, gbkArchive())
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, OPTS('gbk'))

    expect(res.engine).toBe('admzip')
    expect(res.mojibake).toBe(false)
    // JS 默认按 UTF-16 码元排序：现 U+73B0 < 贴 U+8D34 < 预 U+9884。
    // `现代衣柜.txt` 不在结果里：2026-10 装机反馈后 `.txt` 归入下载站杂质
    // （isJunkFileName），walkFiles 主动滤除——这是正确行为（见 junkClassify.test.ts）。
    expect(await relsOf(dest)).toEqual([
      '现代衣柜/贴图/木纹 01.jpg',
      '现代衣柜/预览图.jpg'
    ])
  })

  it('同包 codepage=utf8 → mojibake=true（会被 UI 打「疑似乱码」标）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(src, gbkArchive())
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, OPTS('utf8'))

    expect(res.mojibake).toBe(true)
    expect(res.samples.length).toBeGreaterThan(0)
    expect(res.samples.some((s) => s.includes('\ufffd'))).toBe(true)
  })

  it('codepage=auto → 先看 zip 自己的 UTF-8 flag，GBK 包也零乱码', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(src, gbkArchive())
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, OPTS('auto'))

    expect(res.mojibake).toBe(false)
    expect(await relsOf(dest)).toContain('现代衣柜/贴图/木纹 01.jpg')
  })

  it('UTF-8 flag 的包 + auto → 不乱码', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'u8.zip')
    await fs.writeFile(src, utf8Archive())
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, OPTS('auto'))

    expect(res.mojibake).toBe(false)
    expect(res.codepage).toBe('utf8')
    expect(await relsOf(dest)).toEqual(['现代衣柜/预览图.jpg'])
  })
})

describe('extractArchive — 格式白名单与错误分类（C2）', () => {
  it('移除 .tar/.gz/.tgz：不再支持', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'a.tar')
    await fs.writeFile(src, Buffer.from('not really a tar'))
    await expect(extractArchive(src, path.join(root, 'o'), OPTS('auto'))).rejects.toBeInstanceOf(ExtractionError)
    await expect(extractArchive(src, path.join(root, 'o2'), OPTS('auto'))).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('.rar 无 7-Zip → kind=no7z 且文案带下载链接', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'a.rar')
    await fs.writeFile(src, Buffer.from('Rar!'))
    const err = await extractArchive(src, path.join(root, 'o'), OPTS('auto')).catch((e) => e)
    expect(err).toBeInstanceOf(ExtractionError)
    expect(err.kind).toBe('no7z')
    expect(err.message).toContain('https://7-zip.org/')
  })

  it('zip 超过 JS 兜底上限 → kind=oversize', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'big.zip')
    await fs.writeFile(src, gbkArchive())
    const err = await extractArchive(src, path.join(root, 'o'), OPTS('auto', { maxBytesForJsFallback: 10 })).catch((e) => e)
    expect(err).toBeInstanceOf(ExtractionError)
    expect(err.kind).toBe('oversize')
  })

  it('损坏的 zip → ExtractionError（不裸抛）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'broken.zip')
    await fs.writeFile(src, Buffer.from('PK\x03\x04garbage-garbage-garbage'))
    const err = await extractArchive(src, path.join(root, 'o'), OPTS('auto')).catch((e) => e)
    expect(err).toBeInstanceOf(ExtractionError)
    expect(typeof err.message).toBe('string')
    expect(err.message.length).toBeGreaterThan(0)
  })
})

describe('listUncompressedBytes — 空间预检取值（P0-3）', () => {
  it('无 7z 时用 adm-zip 的精确值', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(src, gbkArchive())
    const info = await listUncompressedBytes(src, { sevenZipPath: null, maxBytesForJsFallback: 200 * 1024 * 1024 })
    expect(info.exact).toBe(true)
    expect(info.bytes).toBeGreaterThan(0)
  })

  it('取不到精确值时退化为 原包 × 3', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.rar')
    const body = Buffer.alloc(1000, 0x41)
    await fs.writeFile(src, body)
    const info = await listUncompressedBytes(src, { sevenZipPath: null, maxBytesForJsFallback: 200 * 1024 * 1024 })
    expect(info.exact).toBe(false)
    expect(info.bytes).toBe(3000)
  })
})

describe('fixture 自检', () => {
  it('GBK 字节与 UTF-8 字节确实不同，且未置 UTF-8 flag', () => {
    expect(gbkBytes('现代衣柜').equals(utf8Bytes('现代衣柜'))).toBe(false)
    const zip = buildZip([zipEntry('现代衣柜/a.jpg', 'x')])
    // central directory 的第一条记录：flag 位于 local header 偏移 6（bit11 = 0x0800）
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0)
  })

  it('置 UTF-8 flag 时能被读出来', () => {
    const zip = buildZip([zipEntry('现代衣柜/a.jpg', 'x', { encoding: 'utf8' })])
    expect(zip.readUInt16LE(6) & 0x0800).not.toBe(0)
  })
})
