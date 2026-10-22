/**
 * 封面图片写入（main 侧）单测（2026-10 装机反馈，任务 3）。
 *
 * 覆盖：magic bytes 校验（PNG/JPEG/其它）、20MB 大小上限、
 * `<资产名>.cover.<ext>` 命名与同族旧文件清理、非图片拒绝。
 * `coverImage.ts` 零 electron 依赖，全部可在 node 环境直跑。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_COVER_IMAGE_BYTES,
  coverFileName,
  coverImageExt,
  detectCoverImageFormat,
  validateCoverImage,
  writeCoverImageInto
} from '../src/main/coverImage'
import { TINY_PNG, tinyJpeg } from './fixtures/gbkZip'

const tmpRoots: string[] = []

async function tmpAssetFolder(name = '现代衣柜'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-cover-'))
  tmpRoots.push(root)
  const folder = path.join(root, name)
  await fs.mkdir(folder, { recursive: true })
  return folder
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('detectCoverImageFormat', () => {
  it('PNG 魔数 → png', () => {
    expect(detectCoverImageFormat(TINY_PNG)).toBe('png')
  })

  it('JPEG 魔数（FFD8FF）→ jpeg', () => {
    expect(detectCoverImageFormat(tinyJpeg())).toBe('jpeg')
  })

  it('其它内容（文本/zip/exe 改后缀）→ null', () => {
    expect(detectCoverImageFormat(Buffer.from('PK\u0003\u0004fake-zip'))).toBeNull()
    expect(detectCoverImageFormat(Buffer.from('MZ fake exe'))).toBeNull()
  })

  it('过短 buffer → null', () => {
    expect(detectCoverImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(detectCoverImageFormat(Buffer.alloc(0))).toBeNull()
  })
})

describe('validateCoverImage', () => {
  it('合法 PNG/JPEG → ok + format', () => {
    expect(validateCoverImage(TINY_PNG)).toEqual({ ok: true, format: 'png' })
    expect(validateCoverImage(tinyJpeg())).toEqual({ ok: true, format: 'jpeg' })
  })

  it('空 buffer → empty', () => {
    expect(validateCoverImage(Buffer.alloc(0))).toEqual({ ok: false, reason: 'empty' })
  })

  it('超过 20MB → too-large（先查体积再查魔数）', () => {
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(MAX_COVER_IMAGE_BYTES + 1)])
    expect(validateCoverImage(big)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('非图片 → not-image', () => {
    expect(validateCoverImage(Buffer.from('hello world'))).toEqual({ ok: false, reason: 'not-image' })
  })
})

describe('命名辅助', () => {
  it('jpeg → jpg 扩展名（与 thumb.ts 口径一致）', () => {
    expect(coverImageExt('jpeg')).toBe('jpg')
    expect(coverImageExt('png')).toBe('png')
  })

  it('<资产名>.cover.<ext>', () => {
    expect(coverFileName('现代衣柜', 'png')).toBe('现代衣柜.cover.png')
  })
})

describe('writeCoverImageInto', () => {
  it('PNG 落盘为 <资产名>.cover.png，返回 rel + 字节数', async () => {
    const folder = await tmpAssetFolder()
    const r = await writeCoverImageInto(folder, TINY_PNG)
    expect(r.rel).toBe('现代衣柜.cover.png')
    expect(r.size).toBe(TINY_PNG.length)
    const onDisk = await fs.readFile(path.join(folder, r.rel))
    expect(onDisk.equals(TINY_PNG)).toBe(true)
  })

  it('JPEG 落盘为 .cover.jpg', async () => {
    const folder = await tmpAssetFolder('沙发')
    const r = await writeCoverImageInto(folder, tinyJpeg())
    expect(r.rel).toBe('沙发.cover.jpg')
  })

  it('重复设置：换格式时清掉同族旧 cover，不堆积', async () => {
    const folder = await tmpAssetFolder()
    await writeCoverImageInto(folder, TINY_PNG)
    await writeCoverImageInto(folder, tinyJpeg())
    const names = (await fs.readdir(folder)).sort()
    expect(names).toEqual(['现代衣柜.cover.jpg']) // png 版被清掉
  })

  it('同格式重复设置：直接覆盖', async () => {
    const folder = await tmpAssetFolder()
    await writeCoverImageInto(folder, TINY_PNG)
    await writeCoverImageInto(folder, Buffer.concat([TINY_PNG, Buffer.from([1, 2, 3])]))
    const names = await fs.readdir(folder)
    expect(names).toEqual(['现代衣柜.cover.png'])
    expect((await fs.stat(path.join(folder, '现代衣柜.cover.png'))).size).toBe(TINY_PNG.length + 3)
  })

  it('不碰用户自己的文件（只删 <资产名>.cover.* 精确模式）', async () => {
    const folder = await tmpAssetFolder()
    await fs.writeFile(path.join(folder, '预览图.png'), 'keep-me')
    await fs.writeFile(path.join(folder, '现代衣柜.cover.png'), 'old-manual')
    await fs.writeFile(path.join(folder, 'other.cover.png'), 'not-mine')
    await writeCoverImageInto(folder, tinyJpeg())
    const names = (await fs.readdir(folder)).sort()
    // 排序按 UTF-16 码元：'o' < '现'；关键是 other.cover.png 与 预览图.png 原样保留
    expect(names).toEqual(['other.cover.png', '现代衣柜.cover.jpg', '预览图.png'])
  })

  it('非图片 buffer → 抛错且不落盘', async () => {
    const folder = await tmpAssetFolder()
    await expect(writeCoverImageInto(folder, Buffer.from('nope'))).rejects.toThrow(/不合法/)
    expect(await fs.readdir(folder)).toEqual([])
  })
})
