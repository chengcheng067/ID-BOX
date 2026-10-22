import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONCURRENCY,
  importPaths,
  mapWithConcurrency,
  type ImportDeps
} from '../src/main/importer'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'
import { autoClassify } from '../src/shared/autoClassify'
import type { ArchiveDisposal, Asset, ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-import-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GBK 中文名 + 单个顶层目录 + 根目录层预览图 + .skp（带 SU 版本头） */
function assetArchive(dirName: string): Buffer {
  return buildZip([
    zipDir(dirName),
    zipEntry(`${dirName}/预览图.jpg`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])),
    zipEntry(`${dirName}/${dirName}.skp`, skpContent('SketchUp Model {24.0.594}')),
    zipEntry(`${dirName}/贴图/木纹 01.jpg`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]))
  ])
}

function makeDeps(libraryDir: string, over: Partial<ImportDeps> = {}): {
  deps: ImportDeps
  events: ImportEvent[]
  thumbs: Array<{ id: string; coverAbs: string | null }>
  disposed: Array<{ src: string; mode: ArchiveDisposal }>
} {
  const events: ImportEvent[] = []
  const thumbs: Array<{ id: string; coverAbs: string | null }> = []
  const disposed: Array<{ src: string; mode: ArchiveDisposal }> = []
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
    ensureThumb: async (id, coverAbs) => {
      thumbs.push({ id, coverAbs })
      return `${id}-stub.jpg`
    },
    disposeArchive: async (src, mode) => {
      disposed.push({ src, mode })
    },
    emit: (ev) => {
      events.push(ev)
    },
    ...over
  }
  return { deps, events, thumbs, disposed }
}

describe('importPaths — 正常导入（P0-1 / P0-4 / P0-7 / P0-15）', () => {
  it('UUID 主键 + relFolder + 封面 + SU 版本 + 缩略图注入', async () => {
    // fixture 自检：这个名字必须真的不可分类，否则本用例会因词表演进静默失效
    // （`现代衣柜` 就是前车之鉴：2026-10 尾字族词根上线后它命中 家具/柜子，
    //  本用例才从"绿"变"红"——不是逻辑坏了，是 fixture 过期了）
    expect(autoClassify('示例资产包')).toBeNull()

    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '示例资产包.zip')
    await fs.writeFile(src, assetArchive('示例资产包'))

    const { deps, events, thumbs } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.id).toMatch(UUID_RE)
    expect(a.name).toBe('示例资产包')
    expect(a.kind).toBe('model')
    // T06 固定四层：<大类>/<一级>/<二级>/<资产名>，新资产落双哨兵
    expect(a.relFolder).toBe('模型/未分类/未分类/示例资产包')
    expect(a.folder).toBe(path.join(lib, '模型', '未分类', '未分类', '示例资产包'))
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.styles).toEqual([])
    expect(a.cover).toBe('预览图.jpg')
    expect(a.coverSource).toBe('named')
    expect(a.suVersion).toBe('SU 2024')
    expect(a.suMajor).toBe(24)
    expect(a.thumbPath).toBe(`${a.id}-stub.jpg`)
    expect(a.thumbStatus).toBe('ready')
    expect(a.mojibake).toBe(false)
    // JS 默认按 UTF-16 码元排序：示 U+793A < 贴 U+8D34 < 预 U+9884
    expect(a.files.map((f) => f.rel).sort()).toEqual([
      '示例资产包.skp',
      '贴图/木纹 01.jpg',
      '预览图.jpg'
    ])

    // ensureThumb 注入点：拿到的是稳定 id 与封面绝对路径
    expect(thumbs.length).toBe(1)
    expect(thumbs[0]!.id).toBe(a.id)
    expect(thumbs[0]!.coverAbs).toBe(path.join(a.folder, '预览图.jpg'))

    // 事件流：extracting → organizing → done
    expect(events.map((e) => e.status)).toEqual(['extracting', 'organizing', 'done'])

    // 磁盘上确实落到了 库根/模型/未分类/未分类/示例资产包
    await expect(
      fs.stat(path.join(lib, '模型', '未分类', '未分类', '示例资产包', '预览图.jpg'))
    ).resolves.toBeTruthy()
  })

  it('导入结束后 .staging 已清空（K2 / G4）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'a.zip')
    await fs.writeFile(src, assetArchive('沙发'))
    await importPaths([src], makeDeps(lib).deps)
    await expect(fs.stat(path.join(lib, '.staging'))).rejects.toThrow()
  })

  it('单个失败后 .staging 也已清空', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'broken.zip')
    await fs.writeFile(src, Buffer.from('PK\x03\x04not a zip at all'))
    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(0)
    expect(events.some((e) => e.status === 'error')).toBe(true)
    await expect(fs.stat(path.join(lib, '.staging'))).rejects.toThrow()
  })
})

describe('importPaths — 磁盘空间预检（P0-3 / D3）', () => {
  it('空间不足时拒绝导入、不建 staging、给可用/需要字节数', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'a.zip')
    await fs.writeFile(src, assetArchive('衣柜'))

    // fixture 是 STORED 小包（uncompressed ≈ 70B），要让 required 必然超过任何盘的可用空间，
    // safetyFactor 必须够大：1e12 → required ≈ 70 TB，任何盘都必挂
    const { deps, events } = makeDeps(lib, { spaceSafetyFactor: 1e12 })
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(0)
    const err = events.find((e) => e.status === 'error')
    expect(err).toBeTruthy()
    expect(err!.message).toContain('磁盘空间不足')
    expect(err!.needBytes).toBeGreaterThan(0)
    expect(typeof err!.freeBytes).toBe('number')
    // **不产生半成品**：连 .staging 目录都没建过
    await expect(fs.stat(path.join(lib, '.staging'))).rejects.toThrow()
    // ⚠️ 隐含契约（06 §12.2）：此断言锁住「空间预检必须严格早于任何 mkdir」。
    //    若有人把分类目录（<大类>/未分类/未分类）的 mkdir 提到 checkSpaceFor 之前，这里就会红。
    await expect(fs.readdir(lib)).resolves.toHaveLength(0)
  })
})

describe('importPaths — 原包处置三档（P0-5）', () => {
  it('recycle / delete / keep 分别传给处置实现', async () => {
    const root = await tmpDir()
    for (const mode of ['recycle', 'delete', 'keep'] as ArchiveDisposal[]) {
      const lib = path.join(root, `lib-${mode}`)
      await fs.mkdir(lib, { recursive: true })
      const src = path.join(root, `p-${mode}.zip`)
      await fs.writeFile(src, assetArchive('椅子'))
      const { deps, disposed } = makeDeps(lib, { archiveDisposal: mode })
      await importPaths([src], deps)
      expect(disposed).toEqual([{ src, mode }])
    }
  })
})

describe('importPaths — 批量：并发 ≤3 且单包失败不阻断（US-1 / G1）', () => {
  it('20 个包其中 3 个损坏 → 17 个成功', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const srcs: string[] = []
    for (let i = 0; i < 20; i++) {
      const p = path.join(root, `pack-${i}.zip`)
      if (i % 7 === 3) {
        await fs.writeFile(p, Buffer.from('PK\x03\x04corrupted-corrupted-corrupted'))
      } else {
        await fs.writeFile(p, assetArchive(`资产${i}`))
      }
      srcs.push(p)
    }

    let running = 0
    let peak = 0
    const rawDeps = makeDeps(lib)
    const deps: ImportDeps = {
      ...rawDeps.deps,
      emit: (ev) => {
        rawDeps.events.push(ev)
        if (ev.status === 'extracting') {
          running++
          peak = Math.max(peak, running)
        }
        if (ev.status === 'done' || ev.status === 'error') running--
      }
    }

    const assets = await importPaths(srcs, deps)
    expect(assets.length).toBe(17)
    expect(peak).toBeLessThanOrEqual(DEFAULT_CONCURRENCY)
    expect(new Set(assets.map((a) => a.id)).size).toBe(17)
    await expect(fs.stat(path.join(lib, '.staging'))).rejects.toThrow()
  })

  it('并发池本身严格受限（20 个任务 / limit 3）', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (i) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 2))
        done.push(i)
        running--
      }
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('并发池中单个任务抛错不影响其余', async () => {
    const seen: number[] = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (i) => {
      if (i === 3) throw new Error('boom')
      seen.push(i)
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 4, 5])
  })
})

describe('importPaths — 文件夹直接导入', () => {
  it('拖入已解压的文件夹也能归档', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const dir = path.join(root, '已解压')
    await fs.mkdir(path.join(dir, '贴图'), { recursive: true })
    await fs.writeFile(path.join(dir, '预览图.jpg'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    await fs.writeFile(path.join(dir, '贴图/木纹.jpg'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([dir], deps)
    expect(assets.length).toBe(1)
    expect(assets[0]!.kind).toBe('texture')
    // 材质大类合并（docs/14）：贴图与材质预设共用「材质」大类目录
    expect(assets[0]!.relFolder).toBe('材质/未分类/未分类/已解压')
    expect(assets[0]!.coverSource).toBe('named')
  })
})
