/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   必须把 DOM lib 挂进本程序，否则 typecheck:node 会在 store.ts/db.ts 报 "Cannot find name 'window'"。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset } from '../src/shared/types'

/**
 * 删除链路回归测试（2026-10 装机缺陷单：「删除模型功能失效」）。
 *
 * 与 storeFlow.test.ts 同手法：stub `window.modvault` + 内存版假 Dexie Table，
 * 驱动**真实的 store action**。trashPaths 桩**真的删磁盘上的临时目录**，
 * 因此可以断言「确认后资产真的从磁盘消失」。
 *
 * 覆盖四段链路：
 *   DetailPanel/store.requestDelete → ConfirmDialog（confirming，不碰磁盘）
 *   → UndoToast（grace）→ commitDelete → trashPaths + bulkDelete + deleteThumb
 * 外加两条回归：撤销语义、**失败不再静默**。
 */

const modvault = {
  renameAsset: vi.fn(),
  rescan: vi.fn(),
  pruneThumbs: vi.fn().mockResolvedValue(0),
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0),
  migrateLayout: vi.fn().mockResolvedValue({ ok: [], failed: [] }),
  trashPaths: vi.fn()
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const putCalls: Asset[] = []
const bulkPutCalls: Asset[][] = []
const bulkDeleteCalls: string[][] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => {
    bulkDeleteCalls.push([...ids])
    return ids.length
  })
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

let seq = 0
const tmpDirs: string[] = []

async function tmpAssetDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-delete-'))
  tmpDirs.push(d)
  await fs.writeFile(path.join(d, '资产.skp'), 'x'.repeat(64))
  return d
}

/** 造一条指向真实临时目录的资产（folder 真实存在，可验证"从磁盘消失"） */
async function fixture(over: Partial<Asset> = {}): Promise<Asset> {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const folder = await tmpAssetDir()
  return {
    id: `ddddddd-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder,
    relFolder: '模型/未分类/未分类/资产' + n,
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [
      { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
    ],
    size: 30,
    suVersion: 'SU 2024',
    suMajor: 24,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

beforeEach(async () => {
  putCalls.length = 0
  bulkPutCalls.length = 0
  bulkDeleteCalls.length = 0
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  modvault.deleteThumb.mockResolvedValue(0)
  // C 线「最近删除」落地后，默认保留期是 '30d'（commitDelete 会走软删）。
  // 本文件测的是**旧路径**（trashPaths 直接进系统回收站 + 删索引），所以显式钉到 'recycle'；
  // 软删路径的覆盖在 tests/trashView.test.ts。
  useVault.setState({
    pendingDelete: null,
    notice: null,
    settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle' }
  })
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('P0-16 删除链路：完整四步（requestDelete → confirm → grace → commit）', () => {
  it('确认后资产真的从磁盘消失 + trashPaths 被调用 + 索引删除 + 缩略图清理', async () => {
    const a = await fixture()
    useVault.setState({ assets: [a], selectedId: a.id, selectedIds: [a.id] })

    // trashPaths 桩模拟主进程真实行为：成功移走的路径从磁盘消失
    modvault.trashPaths.mockImplementation(async (paths: string[]) => {
      for (const p of paths) await fs.rm(p, { recursive: true, force: true })
      return []
    })

    const s = useVault.getState()

    // ① requestDelete：只记状态，不碰磁盘
    s.requestDelete([a.id])
    expect(useVault.getState().pendingDelete?.stage).toBe('confirming')
    await expect(fs.stat(a.folder)).resolves.toBeTruthy() // 磁盘还在
    expect(modvault.trashPaths).not.toHaveBeenCalled()

    // ② confirmDelete：进 grace 倒计时，磁盘仍然在
    s.confirmDelete()
    expect(useVault.getState().pendingDelete?.stage).toBe('grace')
    await expect(fs.stat(a.folder)).resolves.toBeTruthy()
    expect(modvault.trashPaths).not.toHaveBeenCalled()

    // ③ commitDelete：真正删除
    await useVault.getState().commitDelete()

    // 磁盘：资产目录真的消失
    await expect(fs.stat(a.folder)).rejects.toThrow()
    // IPC：trashPaths 拿到的是资产文件夹绝对路径
    expect(modvault.trashPaths).toHaveBeenCalledTimes(1)
    expect(modvault.trashPaths).toHaveBeenCalledWith([a.folder])
    // 索引：bulkDelete 掉该 id
    expect(bulkDeleteCalls).toEqual([[a.id]])
    // 缩略图缓存同步清理
    expect(modvault.deleteThumb).toHaveBeenCalledWith(a.id)
    // 内存：资产/选中态清空
    expect(useVault.getState().assets).toEqual([])
    expect(useVault.getState().selectedId).toBeNull()
    expect(useVault.getState().selectedIds).toEqual([])
    expect(useVault.getState().pendingDelete).toBeNull()
  })

  it('多选批量删除：一次 trashPaths 传全部 folder', async () => {
    const a1 = await fixture()
    const a2 = await fixture()
    useVault.setState({ assets: [a1, a2], selectedIds: [a1.id, a2.id] })
    modvault.trashPaths.mockImplementation(async (paths: string[]) => {
      for (const p of paths) await fs.rm(p, { recursive: true, force: true })
      return []
    })

    useVault.getState().requestDelete([a1.id, a2.id])
    expect(useVault.getState().pendingDelete?.targets.length).toBe(2)
    await useVault.getState().commitDelete()

    expect(modvault.trashPaths).toHaveBeenCalledWith([a1.folder, a2.folder])
    await expect(fs.stat(a1.folder)).rejects.toThrow()
    await expect(fs.stat(a2.folder)).rejects.toThrow()
    expect(bulkDeleteCalls).toEqual([[a1.id, a2.id]])
    expect(useVault.getState().assets).toEqual([])
  })
})

describe('P0-16 撤销语义：宽限期内 undo 什么都不删', () => {
  it('undoDelete 后磁盘与索引原样', async () => {
    const a = await fixture()
    useVault.setState({ assets: [a], selectedId: a.id })
    useVault.getState().requestDelete([a.id])
    useVault.getState().confirmDelete()
    useVault.getState().undoDelete()

    expect(useVault.getState().pendingDelete).toBeNull()
    await expect(fs.stat(a.folder)).resolves.toBeTruthy() // 文件还在
    expect(modvault.trashPaths).not.toHaveBeenCalled()
    expect(bulkDeleteCalls).toEqual([])
    expect(useVault.getState().assets.length).toBe(1)
  })
})

describe('回归（装机缺陷单）：删除失败不再静默', () => {
  it('trashPaths 全部失败 → 资产保留在索引与磁盘 + notice 提示用户', async () => {
    const a = await fixture()
    useVault.setState({ assets: [a], selectedId: a.id, notice: null })

    // 复现装机时的主进程行为：每个路径都进 failed 清单（曾因 asar spawn ENOENT）
    modvault.trashPaths.mockResolvedValue([a.folder])

    useVault.getState().requestDelete([a.id])
    await useVault.getState().commitDelete()

    // 索引保留
    expect(bulkDeleteCalls).toEqual([])
    expect(useVault.getState().assets.map((x) => x.id)).toEqual([a.id])
    // 磁盘保留
    await expect(fs.stat(a.folder)).resolves.toBeTruthy()
    // 不再静默：用户看得到失败原因
    expect(useVault.getState().notice).toContain('删除失败')
    expect(useVault.getState().notice).toContain('1 个资产')
  })

  it('部分失败 → 成功的删掉、失败的保留 + notice 分别计数', async () => {
    const a1 = await fixture()
    const a2 = await fixture()
    useVault.setState({ assets: [a1, a2], selectedIds: [a1.id, a2.id], notice: null })
    modvault.trashPaths.mockImplementation(async (paths: string[]) => {
      await fs.rm(paths[0]!, { recursive: true, force: true })
      return [paths[1]!]
    })

    useVault.getState().requestDelete([a1.id, a2.id])
    await useVault.getState().commitDelete()

    await expect(fs.stat(a1.folder)).rejects.toThrow() // 成功的真删了
    await expect(fs.stat(a2.folder)).resolves.toBeTruthy() // 失败的留着
    expect(useVault.getState().assets.map((x) => x.id)).toEqual([a2.id])
    expect(bulkDeleteCalls).toEqual([[a1.id]])
    expect(useVault.getState().notice).toContain('已删除 1 个')
    expect(useVault.getState().notice).toContain('1 个失败')
  })
})
