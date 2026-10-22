import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { importPaths, DEFAULT_CONCURRENCY, type ImportDeps } from '../src/main/importer'
import { rescanLibrary } from '../src/main/rescan'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'
import type { Asset, ImportEvent } from '../src/shared/types'

/**
 * 0.6.3：`Asset.zhimoId` 的**导入落库**与**重扫补算**单测（用户 2026-10 反馈）。
 *
 * 三条真实反例（全部来自用户机器）：
 * ① 资产「中古侘寂屏风_木屏风_藤编屏风_可折叠屏风」→ 包内 `znzmo-1180221079-1.skp`
 *    （资产名无 ID，只能从**包内文件名**解析）；
 * ② 资产「现代中古吊灯…」→ 包内 `znzmo-1191034576-1.skp`（同上）；
 * ③ `现代壁灯ID_1232108421.rar` → 解包后 `attachment_1786942463670\现代壁灯\现代壁灯.skp`
 *    （包内零 ID 痕迹，ID 只在**压缩包名**上，且包随后会被处置 → 必须导入时落库）。
 *
 * 优先级（实现见 `shared/naming.zhimoIdFromSources`）：
 * 压缩包 / 源图文件名 → 最终资产名 → 包内文件相对路径。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-zid-'))
  tmpRoots.push(d)
  return d
}

function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep',
    defaultSource: '知末网',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async () => null,
    disposeArchive: async () => {},
    emit: (ev) => {
      events.push(ev)
    }
  }
  return { deps, events }
}

/** 单层包：一个顶层目录 + 若干文件（`skp` 固定给合法的 SU 头） */
function archive(entries: string[]): Buffer {
  const specs = entries.map((rel) =>
    rel.endsWith('/')
      ? zipDir(rel.slice(0, -1))
      : zipEntry(rel, rel.endsWith('.skp') ? skpContent() : Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  )
  return buildZip(specs)
}

async function importOneArchive(
  root: string,
  lib: string,
  zipName: string,
  entries: string[]
): Promise<Asset> {
  const src = path.join(root, zipName)
  await fs.writeFile(src, archive(entries))
  const { deps } = makeDeps(lib)
  const assets = await importPaths([src], deps)
  expect(assets.length, `${zipName} 应当导入成功`).toBe(1)
  return assets[0]!
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('importer：asset.zhimoId 三来源', () => {
  it('① 压缩包名带 ID（包内零痕迹）→ 取压缩包名（用户样本 ③）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '现代壁灯ID_1232108421.rar', [
      'attachment_1786942463670/',
      'attachment_1786942463670/现代壁灯/',
      'attachment_1786942463670/现代壁灯/现代壁灯.skp'
    ])

    expect(asset.name).toBe('现代壁灯')
    // 13 位 attachment 目录名绝不能误命中
    expect(asset.zhimoId).toBe('1232108421')
  })

  it('③ 资产名与压缩包名都没有 ID → 取包内文件名 `znzmo-<ID>-1.skp`（用户样本 ①）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '中古侘寂屏风.zip', [
      '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风/',
      '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风/预览图.jpg',
      '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风/znzmo-1180221079-1.skp'
    ])

    // 资产名里一个 ID 字都没有（旧实现 → 封面按钮禁用）
    expect(asset.name).toBe('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')
    expect(asset.zhimoId).toBe('1180221079')
  })

  it('③ 包内 `znzmo-1191034576-1.skp`（用户样本 ②）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '现代中古吊灯.zip', [
      '现代中古吊灯/',
      '现代中古吊灯/znzmo-1191034576-1.preview.jpg',
      '现代中古吊灯/znzmo-1191034576-1.skp'
    ])

    expect(asset.zhimoId).toBe('1191034576')
  })

  it('② 压缩包名与包内文件名都有 ID → **压缩包名优先**', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '椅子ID_1111111111.zip', [
      '椅子/',
      '椅子/znzmo-2222222222-1.skp'
    ])

    expect(asset.zhimoId).toBe('1111111111')
  })

  it('② 压缩包名没有 ID、资产名有 → 取资产名', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '随便起的包名.zip', [
      '北欧椅子ID_1186414883/',
      '北欧椅子ID_1186414883/a.skp'
    ])

    expect(asset.name).toBe('北欧椅子ID_1186414883')
    expect(asset.zhimoId).toBe('1186414883')
  })

  it('三处都没有 ID → 不写值（undefined/null，不得凭空编一个）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const asset = await importOneArchive(root, lib, '椅子.zip', ['椅子/', '椅子/椅子.skp'])

    expect(asset.zhimoId ?? null).toBeNull()
  })

  it('单图直导：源图片名带 ID → 写入（源图名优先于清洗后的资产名）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '木纹ID_1186414883.jpg')
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(1)
    expect(assets[0]!.zhimoId).toBe('1186414883')
  })

  it('单图直导：名字里没有 ID → 不写值', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '木纹 01.jpg')
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 8, 8, 8]))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets[0]!.zhimoId ?? null).toBeNull()
  })
})

describe('rescan：从磁盘目录名 / 包内文件补算 zhimoId', () => {
  it('目录名无 ID、包内是 znzmo 文件 → 重扫也能算出', async () => {
    const lib = await tmpDir()
    const dir = path.join(lib, '模型', '未分类', '未分类', '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'znzmo-1180221079-1.skp'), skpContent())

    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(1)
    expect(assets[0]!.zhimoId).toBe('1180221079')
  })

  it('目录名自带 `ID_<数字>` → 直接取目录名', async () => {
    const lib = await tmpDir()
    const dir = path.join(lib, '模型', '未分类', '未分类', '北欧椅子ID_1186414883')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'a.skp'), skpContent())

    const { assets } = await rescanLibrary(lib)
    expect(assets[0]!.zhimoId).toBe('1186414883')
  })

  it('没有任何 ID 痕迹 → 不写值', async () => {
    const lib = await tmpDir()
    const dir = path.join(lib, '模型', '未分类', '未分类', '椅子')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '椅子.skp'), skpContent())

    const { assets } = await rescanLibrary(lib)
    expect(assets[0]!.zhimoId ?? null).toBeNull()
  })
})
