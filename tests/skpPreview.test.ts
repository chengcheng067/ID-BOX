import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SKP_PREVIEW_HEAD_BYTES,
  extractEmbeddedImage,
  extractSkpPreview,
  writeSkpPreviewInto
} from '../src/main/skpPreview'
import {
  SKP_CDIB_ATTR,
  SKP_CDID_ATTR,
  TINY_PNG,
  skpContent,
  skpContentWithCdibPreview,
  skpContentWithPreview,
  tinyJpeg
} from './fixtures/gbkZip'

/**
 * SKP 内嵌预览图提取单测（P1-2 / 2026-10 装机反馈首选缩略图方案）。
 *
 * 真实样本实测结论（本机，2026-10）：
 * - 样本 A（侘寂挂画，1.36MB，SU 头 `{8.0.1}`）：偏移 **1991** 处 256×256 PNG，
 *   IEND 终止，视觉确认真实模型预览；
 * - 样本 B（中古侘寂屏风，108MB，SU 头 `{8.0.1}`）：头部为两张 512×512 JPEG
 *   材质贴图（偏移 9401 / 188614），全文件扫描无预览图 —— 该包未内嵌预览，
 *   提取走「第一个完整图片」启发式会拿到材质贴图（已知局限，见报告）。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-skpprev-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('extractEmbeddedImage — 签名扫描（纯函数）', () => {
  it('PNG 签名 + IEND → 完整提取', () => {
    const head = Buffer.concat([Buffer.alloc(100, 0x11), TINY_PNG, Buffer.alloc(50, 0x22)])
    const found = extractEmbeddedImage(head)
    expect(found).not.toBeNull()
    expect(found!.ext).toBe('png')
    expect(found!.offset).toBe(100)
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('JPEG 签名 + FFD9 → 完整提取', () => {
    const jpg = tinyJpeg()
    const head = Buffer.concat([Buffer.alloc(64, 0x33), jpg, Buffer.alloc(10, 0x44)])
    const found = extractEmbeddedImage(head)
    expect(found).not.toBeNull()
    expect(found!.ext).toBe('jpg')
    expect(found!.offset).toBe(64)
    expect(found!.buffer.equals(jpg)).toBe(true)
  })

  it('按偏移优先：PNG 在前取 PNG（真实样本 A 的形态）', () => {
    const head = Buffer.concat([skpContent(), Buffer.alloc(1900, 0x5a), TINY_PNG, Buffer.alloc(64, 0), tinyJpeg()])
    const found = extractEmbeddedImage(head)
    expect(found!.ext).toBe('png')
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('只有签名没有终止块 → 视为噪声返回 null', () => {
    const head = Buffer.concat([Buffer.alloc(10), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0x55)])
    expect(extractEmbeddedImage(head)).toBeNull()
  })

  it('第一个签名不完整、第二个完整 → 跳过噪声取第二个', () => {
    const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const head = Buffer.concat([truncatedPng, Buffer.alloc(32, 0x66), TINY_PNG])
    const found = extractEmbeddedImage(head)
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('无任何图片签名 → null（样本 B 的降级路径）', () => {
    expect(extractEmbeddedImage(skpContent())).toBeNull()
    expect(extractEmbeddedImage(Buffer.alloc(0))).toBeNull()
  })
})

describe('extractEmbeddedImage — CDib 锚定（真实样本结构）', () => {
  it('CDib 属性段里的 PNG → 精准提取（复刻样本 A：CDib@1973 → PNG@1991）', () => {
    const head = skpContentWithCdibPreview(TINY_PNG)
    const found = extractEmbeddedImage(head)
    expect(found).not.toBeNull()
    expect(found!.ext).toBe('png')
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('CDib 属性段里的 JPEG → 提取（复刻样本 B：CDib@9383 → JPEG@9401）', () => {
    const head = skpContentWithCdibPreview(tinyJpeg())
    const found = extractEmbeddedImage(head)
    expect(found).not.toBeNull()
    expect(found!.ext).toBe('jpg')
  })

  it('CDib 段里只有噪声图片签名 → 跳过该锚点，而不是把噪声当预览', () => {
    // CDib 后 64 字节内放一段只有签名没有结构的假 PNG
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const head = Buffer.concat([skpContent(), Buffer.alloc(1900, 0x5a), SKP_CDIB_ATTR, Buffer.alloc(4), fakePng, TINY_PNG])
    const found = extractEmbeddedImage(head)
    // CDib 窗口内无完整图 → 落到兜底扫描 → 取到后面真正的 TINY_PNG
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('CDib 锚点优先于裸扫描：即使更早处有完整图片也先认 CDib 槽位', () => {
    // 更早处（偏移 300）放一张完整 PNG，CDib 里放 JPEG
    const head = Buffer.concat([
      skpContent(),
      Buffer.alloc(240, 0x5a),
      TINY_PNG, // 偏移约 300 的完整 PNG（非缩略图槽位）
      Buffer.alloc(1500, 0x5a),
      SKP_CDIB_ATTR,
      Buffer.alloc(4),
      tinyJpeg()
    ])
    const found = extractEmbeddedImage(head)
    expect(found!.ext).toBe('jpg') // CDib 槽位里的 JPEG 胜出
  })

  it('只有 CDid（材质贴图属性）没有 CDib → 走兜底裸扫描', () => {
    const head = Buffer.concat([skpContent(), Buffer.alloc(1900, 0x5a), SKP_CDID_ATTR, Buffer.alloc(4), TINY_PNG])
    const found = extractEmbeddedImage(head)
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })
})

describe('extractSkpPreview — 文件 IO', () => {
  it('合成 skp（SU 头 + 内嵌 PNG）→ 提取成功', async () => {
    const root = await tmpDir()
    const skp = path.join(root, 'model.skp')
    await fs.writeFile(skp, skpContentWithPreview(TINY_PNG))
    const found = await extractSkpPreview(skp)
    expect(found).not.toBeNull()
    expect(found!.buffer.equals(TINY_PNG)).toBe(true)
  })

  it('无内嵌图的 skp → null', async () => {
    const root = await tmpDir()
    const skp = path.join(root, 'plain.skp')
    await fs.writeFile(skp, skpContent())
    expect(await extractSkpPreview(skp)).toBeNull()
  })

  it('文件不存在 → null（不抛）', async () => {
    const root = await tmpDir()
    expect(await extractSkpPreview(path.join(root, 'nope.skp'))).toBeNull()
  })

  it('headBytes 窗口可显式收窄（窗口内无完整图 → null）', async () => {
    const root = await tmpDir()
    const skp = path.join(root, 'model.skp')
    await fs.writeFile(skp, skpContentWithPreview(TINY_PNG, { gapBytes: 4096 }))
    // 窗口只有 512 字节，够不到 4096+60 处的 PNG
    expect(await extractSkpPreview(skp, 512)).toBeNull()
    // 默认窗口（512KB）够得到
    expect(await extractSkpPreview(skp, SKP_PREVIEW_HEAD_BYTES)).not.toBeNull()
  })
})

describe('writeSkpPreviewInto — 落盘到资产文件夹', () => {
  it('写入 `<skp 主名>.preview.png` 并返回 rel；内容与内嵌图一致', async () => {
    const root = await tmpDir()
    const assetDir = path.join(root, '资产')
    await fs.mkdir(assetDir, { recursive: true })
    const skp = path.join(assetDir, 'znzmo-1186414883-1.skp')
    await fs.writeFile(skp, skpContentWithPreview(TINY_PNG))

    const rel = await writeSkpPreviewInto(skp, assetDir, 'znzmo-1186414883-1.skp')
    expect(rel).toBe('znzmo-1186414883-1.preview.png')
    const written = await fs.readFile(path.join(assetDir, rel!))
    expect(written.equals(TINY_PNG)).toBe(true)
  })

  it('无内嵌图 → null 且不写任何文件', async () => {
    const root = await tmpDir()
    const assetDir = path.join(root, '资产')
    await fs.mkdir(assetDir, { recursive: true })
    const skp = path.join(assetDir, 'model.skp')
    await fs.writeFile(skp, skpContent())

    expect(await writeSkpPreviewInto(skp, assetDir, 'model.skp')).toBeNull()
    expect(await fs.readdir(assetDir)).toEqual(['model.skp'])
  })

  it('JPEG 内嵌图 → 落成 .preview.jpg', async () => {
    const root = await tmpDir()
    const assetDir = path.join(root, '资产')
    await fs.mkdir(assetDir, { recursive: true })
    const skp = path.join(assetDir, 'model.skp')
    await fs.writeFile(skp, skpContentWithPreview(tinyJpeg()))

    const rel = await writeSkpPreviewInto(skp, assetDir, 'model.skp')
    expect(rel).toBe('model.preview.jpg')
    await expect(fs.stat(path.join(assetDir, rel!))).resolves.toBeTruthy()
  })

  it('幂等：重复调用覆盖同一文件（预览确定可复现）', async () => {
    const root = await tmpDir()
    const assetDir = path.join(root, '资产')
    await fs.mkdir(assetDir, { recursive: true })
    const skp = path.join(assetDir, 'model.skp')
    await fs.writeFile(skp, skpContentWithPreview(TINY_PNG))

    const r1 = await writeSkpPreviewInto(skp, assetDir, 'model.skp')
    const r2 = await writeSkpPreviewInto(skp, assetDir, 'model.skp')
    expect(r1).toBe(r2)
    expect(await fs.readdir(assetDir)).toEqual(['model.preview.png', 'model.skp'])
  })
})
