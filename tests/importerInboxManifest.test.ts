/**
 * 「协议文件不许进用户的库」——**真实文件夹导入**的端到端测试。
 *
 * ## 为什么这条必须有
 *
 * SketchUp 插件把 `<baseName>.skp` / `<baseName>.cover.png` / `manifest.json` 写在同一个
 * job 目录里，而 `create` 通道是**文件夹导入**。不处理的话那个 `manifest.json` 会跟着
 * 素材一起进用户的库 —— 用户点开一个模型文件夹，看到里面躺着一个 manifest.json，
 * 那是**我们的内部协议文件跑进了他的素材库**。
 *
 * 但也不能按名字一刀切删：用户自己的素材包（PBR 材质包的元数据 / 某个导出器的工程
 * 描述）里带的 `manifest.json` 可能正是他要的资产 —— 删掉是不可逆的数据事故。
 * 所以两个方向都要测：**我们写的要被剔掉，用户自带的一律保留**。
 *
 * 走真实的 `importPaths([dir])`（与渲染层 `create` 链路同一条），断言到**磁盘**与
 * `asset.files[]` 两层 —— 只删 files 索引而留盘，用户照样会在资源管理器里看到它。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { ArchiveDisposal, Asset, ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(prefix = 'mv-inbox-import-'): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 与 `tests/importer.test.ts` 同款的最小依赖桩（只注必需项） */
function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep' as ArchiveDisposal,
    defaultSource: '',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async (id: string) => `${id}-stub.jpg`,
    disposeArchive: async () => {},
    emit: (ev) => {
      events.push(ev)
    }
  }
  return { deps, events }
}

/** 写一个「收件箱 job 目录」形态的文件夹（skp + 封面 + manifest） */
async function writeJobFolder(root: string, jobId: string, manifest: unknown): Promise<string> {
  const dir = path.join(root, jobId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, '休闲椅.skp'), Buffer.from('SketchUp Model {24.0.594}'))
  await fs.writeFile(path.join(dir, '休闲椅.cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  if (manifest !== undefined) {
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      'utf-8'
    )
  }
  return dir
}

/** 契约形态的 manifest（插件 `exporter.rb#build_manifest` 的逐字形态） */
const JOB_MANIFEST = {
  apiVersion: 1,
  op: 'create',
  name: '休闲椅',
  skp: '休闲椅.skp',
  cover: '休闲椅.cover.png',
  targetRelFolder: null,
  pluginVersion: '1.2.0',
  createdAt: '2026-11-09T18:40:00+08:00'
}

/** 导入后资产文件夹的绝对路径（`importPaths` 的返回里直接给） */
function onlyAsset(assets: Asset[]): Asset {
  expect(assets.length).toBe(1)
  return assets[0]!
}

describe('收件箱 job 目录 → 协议文件不进库', () => {
  it('⭐ 插件写的 manifest.json 被剔除：磁盘上没有、files[] 里也没有', async () => {
    const libraryDir = await tmpDir()
    const src = await writeJobFolder(await tmpDir(), '20261109-184000-ab12', JOB_MANIFEST)
    const { deps } = makeDeps(libraryDir)

    const assets = await importPaths([src], deps)
    const asset = onlyAsset(assets)

    // ① 磁盘：目标目录里没有 manifest.json
    const onDisk = await fs.readdir(asset.folder)
    expect(onDisk).not.toContain('manifest.json')
    // ② 索引：files[] 里也没有（详情页文件列表不会出现它）
    expect(asset.files.some((f) => f.name === 'manifest.json')).toBe(false)
    // ③ size 不含它（否则详情页显示的体积多算一份）
    const sum = asset.files.reduce((s, f) => s + f.size, 0)
    expect(asset.size).toBe(sum)
    // ④ 素材本体与封面照常入库（剔除协议文件不能伤到正常内容）
    expect(onDisk).toContain('休闲椅.skp')
    expect(onDisk).toContain('休闲椅.cover.png')
    expect(asset.cover).toBe('休闲椅.cover.png')
  })

  it('源 job 目录本身不被改动（导入是复制，manifest 还在收件箱里等 ack）', async () => {
    const libraryDir = await tmpDir()
    const src = await writeJobFolder(await tmpDir(), '20261109-184000-ab12', JOB_MANIFEST)
    const { deps } = makeDeps(libraryDir)

    await importPaths([src], deps)

    const srcNames = await fs.readdir(src)
    expect(srcNames).toContain('manifest.json')
  })

  it('用户自带的 manifest.json（不合协议判据）→ **原样保留**（磁盘 + files[] 都在）', async () => {
    const libraryDir = await tmpDir()
    const userManifest = { name: 'PBR 材质包', version: '2.1', maps: ['albedo.jpg', 'normal.jpg'] }
    const src = await writeJobFolder(await tmpDir(), '我的材质包', userManifest)
    const { deps } = makeDeps(libraryDir)

    const assets = await importPaths([src], deps)
    const asset = onlyAsset(assets)

    const onDisk = await fs.readdir(asset.folder)
    expect(onDisk).toContain('manifest.json')
    expect(asset.files.some((f) => f.name === 'manifest.json')).toBe(true)
    // 内容一个字节都不能变（不是"删了又建"）
    const text = await fs.readFile(path.join(asset.folder, 'manifest.json'), 'utf-8')
    expect(JSON.parse(text)).toEqual(userManifest)
  })

  it('apiVersion 不是 1 的同名协议（别的软件）→ 保留', async () => {
    const libraryDir = await tmpDir()
    const src = await writeJobFolder(await tmpDir(), '别的软件导出', {
      apiVersion: 2,
      op: 'create',
      name: 'x'
    })
    const { deps } = makeDeps(libraryDir)

    const asset = onlyAsset(await importPaths([src], deps))
    expect(await fs.readdir(asset.folder)).toContain('manifest.json')
  })

  it('manifest.json 不是合法 JSON → 保留（读不懂就不删）', async () => {
    const libraryDir = await tmpDir()
    const src = await writeJobFolder(await tmpDir(), '坏的清单', '{ "apiVersion": 1, ')
    const { deps } = makeDeps(libraryDir)

    const asset = onlyAsset(await importPaths([src], deps))
    expect(await fs.readdir(asset.folder)).toContain('manifest.json')
  })

  it('没有 manifest.json 的普通文件夹照常导入（绝大多数导入都不受影响）', async () => {
    const libraryDir = await tmpDir()
    const src = await writeJobFolder(await tmpDir(), '普通素材', undefined)
    const { deps } = makeDeps(libraryDir)

    const asset = onlyAsset(await importPaths([src], deps))
    expect(await fs.readdir(asset.folder)).toContain('休闲椅.skp')
  })
})
