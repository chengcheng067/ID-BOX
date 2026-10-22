/**
 * 单张图片直导为独立贴图资产（2026-10 任务 2）单测。
 *
 * 用户原话：「JPG 格式或 PNG 格式的贴图是没有办法拖进来的」。
 * 链路：importOne 按扩展名分路由 → importImageOne（无解压、无 staging）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, IMAGE_IMPORT_EXTS, importPaths, type ImportDeps } from '../src/main/importer'
import type { ArchiveDisposal, Asset, ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-image-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 假图片字节（importer 不做 magic 校验，任意字节即可） */
const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

function makeDeps(libraryDir: string, over: Partial<ImportDeps> = {}): {
  deps: ImportDeps
  events: ImportEvent[]
  thumbs: Array<{ id: string; coverAbs: string | null }>
} {
  const events: ImportEvent[] = []
  const thumbs: Array<{ id: string; coverAbs: string | null }> = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    // ⚠️ 默认档位是 `delete`（不是产品默认的 `recycle`）：
    // 本文件早期用例描述的是「原文件移入库内、源位置不再有文件」这一 move 语义，
    // 缺陷修复后该语义恰好对应 `delete` 档；沿用 `keep` 会让那些**既有断言**反过来
    // 变成在守护旧 bug。三档各自的真实行为由下方「源图处置三档」用例逐档覆盖。
    archiveDisposal: 'delete',
    defaultSource: '本机',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async (id, coverAbs) => {
      thumbs.push({ id, coverAbs })
      return `${id}-stub.jpg`
    },
    emit: (ev) => events.push(ev),
    ...over
  }
  return { deps, events, thumbs }
}

describe('importPaths — 单张图片直导（任务 2）', () => {
  it('单张 png → kind=texture、cover=该文件(named)、四段路径、原文件移入库内', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'MyTexture.png')
    await fs.writeFile(src, FAKE_JPG)

    const { deps, events, thumbs } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('texture')
    expect(a.name).toBe('MyTexture')
    // 四段：<大类>/<一级>/<二级>/<资产名>（MyTexture 无词表命中 → 双哨兵）
    expect(a.relFolder).toBe('材质/未分类/未分类/MyTexture')
    expect(a.folder).toBe(path.join(lib, '材质', '未分类', '未分类', 'MyTexture'))
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    // cover = 该图片本身
    expect(a.cover).toBe('MyTexture.png')
    expect(a.coverSource).toBe('named')
    expect(a.files).toEqual([
      { rel: 'MyTexture.png', name: 'MyTexture.png', ext: 'png', size: FAKE_JPG.length, kind: 'texture' }
    ])
    expect(a.size).toBe(FAKE_JPG.length)
    expect(a.mojibake).toBe(false)
    expect(thumbs.length).toBe(1)
    expect(thumbs[0]!.coverAbs).toBe(path.join(a.folder, 'MyTexture.png'))

    // 事件流：extracting → organizing → done（无解压语义但保持流形一致）
    expect(events.map((e) => e.status)).toEqual(['extracting', 'organizing', 'done'])

    // 原文件已移入库内
    await expect(fs.stat(path.join(a.folder, 'MyTexture.png'))).resolves.toBeTruthy()
    await expect(fs.stat(src)).rejects.toThrow()
  })

  it('autoClassify 同规则：大理石瓷砖.jpg → 材质/瓷砖/大理石瓷砖', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '大理石瓷砖.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets[0]!.relFolder).toBe('材质/瓷砖/大理石瓷砖/大理石瓷砖')
    expect(assets[0]!.category1).toBe('瓷砖')
    expect(assets[0]!.category2).toBe('大理石瓷砖')
  })

  it('同名防重：第二张同名图落 -2', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const s1 = path.join(root, 'a', 'wood.png')
    const s2 = path.join(root, 'b', 'wood.png')
    await fs.mkdir(path.dirname(s1), { recursive: true })
    await fs.mkdir(path.dirname(s2), { recursive: true })
    await fs.writeFile(s1, FAKE_JPG)
    await fs.writeFile(s2, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([s1, s2], deps)
    expect(assets.length).toBe(2)
    const names = assets.map((a) => a.name).sort()
    expect(names).toEqual(['wood', 'wood-2'])
  })

  it('空间不足 → 拒绝、无 .staging、库根无半成品（P0-3 契约）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'big.png')
    await fs.writeFile(src, FAKE_JPG)

    // safetyFactor 拉满 → required 必超任何盘的可用空间
    const { deps, events } = makeDeps(lib, { spaceSafetyFactor: 1e12 })
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(0)
    const err = events.find((e) => e.status === 'error')
    expect(err?.message).toContain('磁盘空间不足')
    await expect(fs.stat(path.join(lib, '.staging'))).rejects.toThrow()
    await expect(fs.readdir(lib)).resolves.toHaveLength(0)
    // 原文件保留
    await expect(fs.stat(src)).resolves.toBeTruthy()
  })

  it('扩展名白名单覆盖 jpg/jpeg/webp/bmp/tif/tiff/gif（大小写不敏感）', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'JPG', 'PNG']) {
      expect(IMAGE_IMPORT_EXTS.has(ext.toLowerCase())).toBe(true)
    }
    // 非白名单（psd 走压缩包/文件夹链路的归档语义，不在单图直导内）
    expect(IMAGE_IMPORT_EXTS.has('psd')).toBe(false)
    expect(IMAGE_IMPORT_EXTS.has('zip')).toBe(false)
  })
})

/**
 * 源图处置三档（2026-10 缺陷修复）：单图导入**必须**尊重 `archiveDisposal`。
 *
 * 缺陷现象：无论设置里选「保留原位 / 移入回收站 / 彻底删除」，源图片一律被搬走
 * （旧实现无条件 `fs.rename`）。修复后与压缩包路径复用同一个 `disposeArchive`。
 */
describe('importPaths — 源图处置三档（archiveDisposal）', () => {
  /** 忠实模拟主进程 `disposeArchiveWithStrategy` 的桩：三档行为都真的做出来 */
  function faithfulDispose(trashDir: string | null): {
    dispose: (src: string, mode: ArchiveDisposal) => Promise<void>
    calls: Array<{ src: string; mode: ArchiveDisposal }>
  } {
    const calls: Array<{ src: string; mode: ArchiveDisposal }> = []
    const dispose = async (src: string, mode: ArchiveDisposal): Promise<void> => {
      calls.push({ src, mode })
      if (mode === 'keep') return
      if (mode === 'delete') {
        await fs.rm(src, { force: true })
        return
      }
      // recycle：模拟 shell.trashItem —— 把文件「移交」到别处，而不是抹掉内容
      if (!trashDir) throw new Error('测试桩缺少回收站目录')
      await fs.rename(src, path.join(trashDir, path.basename(src)))
    }
    return { dispose, calls }
  }

  it("archiveDisposal='keep' → 源图原地保留、字节不变；库内有独立副本", async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    const trashDir = path.join(root, 'FakeTrash')
    await fs.mkdir(lib, { recursive: true })
    await fs.mkdir(trashDir, { recursive: true })
    const src = path.join(root, 'keep-me.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { dispose, calls } = faithfulDispose(trashDir)
    const { deps, events } = makeDeps(lib, { archiveDisposal: 'keep', disposeArchive: dispose })
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a = assets[0]!
    expect(a.name).toBe('keep-me')
    expect(events.at(-1)!.status).toBe('done')

    // ★ 缺陷本体：'keep' 档源文件必须还在，且内容一个字节都没变
    await expect(fs.stat(src)).resolves.toBeTruthy()
    await expect(fs.readFile(src)).resolves.toEqual(FAKE_JPG)

    // 库内确实有副本（复制而非剪切）
    const copyAbs = path.join(a.folder, 'keep-me.jpg')
    await expect(fs.readFile(copyAbs)).resolves.toEqual(FAKE_JPG)
    expect(a.files.map((f) => f.rel)).toEqual(['keep-me.jpg'])
    expect(a.cover).toBe('keep-me.jpg')

    // 处置入口被调用且档位透传正确（不是被硬编码成 delete）
    expect(calls).toEqual([{ src, mode: 'keep' }])
    // 没被搬进「回收站」
    await expect(fs.stat(trashDir)).resolves.toBeTruthy()
    await expect(fs.readdir(trashDir)).resolves.toEqual([])
  })

  it("archiveDisposal='delete' → 源图被彻底删除；库内副本完好", async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'delete-me.png')
    await fs.writeFile(src, FAKE_JPG)

    // 不注入 disposeArchive → 走 importer 内置兜底实现（delete 档 = fs.rm）
    const { deps } = makeDeps(lib, { archiveDisposal: 'delete' })
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    // 源位置已无文件
    await expect(fs.stat(src)).rejects.toThrow()
    // 库内副本仍可读且内容一致
    await expect(fs.readFile(path.join(assets[0]!.folder, 'delete-me.png'))).resolves.toEqual(FAKE_JPG)
  })

  it("archiveDisposal='recycle' → 走注入的回收站通道（不是 rm 直删）；源位置不再有文件", async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    const trashDir = path.join(root, 'FakeTrash')
    await fs.mkdir(lib, { recursive: true })
    await fs.mkdir(trashDir, { recursive: true })
    const src = path.join(root, 'recycle-me.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { dispose, calls } = faithfulDispose(trashDir)
    const { deps } = makeDeps(lib, { archiveDisposal: 'recycle', disposeArchive: dispose })
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    // 源位置已无文件
    await expect(fs.stat(src)).rejects.toThrow()
    // 桩被调用，参数就是源路径 + recycle 档
    expect(calls).toEqual([{ src, mode: 'recycle' }])
    // 关键区分：文件「移交」到了回收站（内容完整），证明没走 fs.rm 直删
    await expect(fs.readFile(path.join(trashDir, 'recycle-me.jpg'))).resolves.toEqual(FAKE_JPG)
    // 库内副本同样完好
    await expect(fs.readFile(path.join(assets[0]!.folder, 'recycle-me.jpg'))).resolves.toEqual(FAKE_JPG)
  })

  it("'keep' 档同名冲突 → 第二个仍是 wood-2，两个源文件都原地不动", async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    const trashDir = path.join(root, 'FakeTrash')
    await fs.mkdir(lib, { recursive: true })
    await fs.mkdir(trashDir, { recursive: true })
    const s1 = path.join(root, 'a', 'wood.jpg')
    const s2 = path.join(root, 'b', 'wood.jpg')
    await fs.mkdir(path.dirname(s1), { recursive: true })
    await fs.mkdir(path.dirname(s2), { recursive: true })
    const BYTES_1 = Buffer.from([0xff, 0xd8, 1, 1, 1])
    const BYTES_2 = Buffer.from([0xff, 0xd8, 2, 2, 2])
    await fs.writeFile(s1, BYTES_1)
    await fs.writeFile(s2, BYTES_2)

    const { dispose } = faithfulDispose(trashDir)
    const { deps } = makeDeps(lib, { archiveDisposal: 'keep', disposeArchive: dispose })
    const assets = await importPaths([s1, s2], deps)

    expect(assets.length).toBe(2)
    expect(assets.map((a) => a.name).sort()).toEqual(['wood', 'wood-2'])
    // 去重没有把源文件牵连进去：两个源都还在，且各自内容未串
    await expect(fs.readFile(s1)).resolves.toEqual(BYTES_1)
    await expect(fs.readFile(s2)).resolves.toEqual(BYTES_2)
    // 库内两套副本互不覆盖。⚠️ 并发下「谁拿到 wood、谁拿到 wood-2」不保证顺序
    // （两个占位锁竞争，先占者胜），故只断言「两份内容都在、各一份」。
    const copied = await Promise.all(assets.map((a) => fs.readFile(path.join(a.folder, 'wood.jpg'))))
    expect(copied.map((b) => b.toString('hex')).sort()).toEqual(
      [BYTES_1.toString('hex'), BYTES_2.toString('hex')].sort()
    )
  })
})
