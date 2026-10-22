/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   必须把 DOM lib 挂进本程序，否则 typecheck:node 会在 store.ts/db.ts 报 "Cannot find name 'window'"。
//
//   `Window.modvault` 的真实类型声明在 src/renderer/env.d.ts（仅对 tsconfig.web 程序生效，
//   tsconfig.node 不含 src/renderer/env.d.ts），所以这里补一个测试用的宽松声明：
declare global {
  interface Window {
    /**
     * 真实声明在 src/renderer/env.d.ts（仅对 tsconfig.web 程序生效）；
     * node 程序复用同一类型，store.ts 的回调参数才有上下文类型（否则 implicit any 报错）。
     */
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'

/**
 * DEF-02：P0-7 / P0-17 的核心验收点（改名/重扫后 tags/note/source 不丢）此前零自动化测试。
 *
 * store.ts 依赖 `window.modvault`（IPC 桥）与 Dexie（IndexedDB），vitest node 环境两者都不可用。
 * 这里**不抽逻辑、不改实现**，而是 stub 掉两个边界后直接驱动**真实的 store action**：
 * - `window.modvault` → vi.fn 桩（记录调用、回放固定值）
 * - `db.assets` → 内存版假 Table（记录 put/bulkPut/bulkDelete 的实参，可断言"没有 delete"）
 *
 * 这样测到的是 T07 实际发布的代码路径，而不是抽出来的一份副本。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  renameAsset: vi.fn(),
  rescan: vi.fn(),
  pruneThumbs: vi.fn().mockResolvedValue(0),
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0),
  migrateLayout: vi.fn().mockResolvedValue({ ok: [], failed: [] })
}

// node 程序没有 window；桩是**部分实现**，断言处用 vi.mock.calls 而不是真调 electron
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
import type { IndexBackup } from '../src/renderer/db'

// 内存版假 Table：记录实参，供断言"只 put 不 delete"
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
// 覆盖 Dexie 生成的 Table（store 只在 action 执行期访问 db.assets，此时尚未触库）
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

// 2026-10 库安全：rescan 真删前会写 `db.backups`（重扫前快照）→ 这里给内存版 backups，
// 否则会打到真实 Dexie（node 无 IndexedDB）。断言仍只看 assets 的 put/delete，不受影响。
const backupStore = new Map<string, IndexBackup>()
const fakeBackupsTable = {
  put: vi.fn(async (b: IndexBackup) => {
    backupStore.set(b.id, b)
    return b.id
  }),
  toArray: vi.fn(async () => [...backupStore.values()]),
  bulkDelete: vi.fn(async (ids: string[]) => {
    for (const id of ids) backupStore.delete(id)
    return ids.length
  })
}
Object.defineProperty(db, 'backups', { value: fakeBackupsTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

let seq = 0

function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\ModVault\\Library\\模型\\未分类\\未分类\\资产${n}`,
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
    tags: ['奶油', '侘寂'],
    note: `第 ${n} 个测试资产`,
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: ['现代', '极简'],
    ...over
  }
}

beforeEach(() => {
  putCalls.length = 0
  bulkPutCalls.length = 0
  bulkDeleteCalls.length = 0
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
})

describe('DEF-02 ①：renameAsset 改名后元数据不丢（P0-7 / D1）', () => {
  it('主键不变、只 put 不 delete，tags/note/source/styles/缩略图全部原样保留', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], selectedId: a.id })

    modvault.renameAsset.mockResolvedValue(
      'E:\\ModVault\\Library\\模型\\未分类\\未分类\\北欧布艺沙发'
    )

    await useVault.getState().renameAsset(a.id, '北欧布艺沙发')

    // 只 put，**绝不 delete**（delete+put 会丢 tags/note，且主键漂移）
    expect(fakeTable.put).toHaveBeenCalledTimes(1)
    expect((fakeTable as unknown as Record<string, unknown>)['delete']).toBeUndefined()
    expect(bulkDeleteCalls.length).toBe(0)

    const saved = putCalls[0]!
    expect(saved.id).toBe(a.id) // 主键永不变更
    expect(saved.name).toBe('北欧布艺沙发')
    expect(saved.folder).toBe('E:\\ModVault\\Library\\模型\\未分类\\未分类\\北欧布艺沙发')
    // 元数据原样保留
    expect(saved.tags).toEqual(['奶油', '侘寂'])
    expect(saved.note).toBe(`第 ${a.name.slice(-3)} 个测试资产` || a.note)
    expect(saved.note).toBe(a.note)
    expect(saved.source).toBe('知末网')
    expect(saved.styles).toEqual(['现代', '极简'])
    expect(saved.cover).toBe('预览图.jpg')
    expect(saved.coverSource).toBe('named')
    expect(saved.thumbPath).toBe(a.thumbPath)
    expect(saved.importedAt).toBe(a.importedAt)
    // dedupeKey 按新名重算
    expect(saved.dedupeKey).toBe('model:北欧布艺沙发')
    // 内存状态同步
    expect(useVault.getState().assets[0]!.name).toBe('北欧布艺沙发')
  })

  it('4 段资产的 relFolder 改名后必须仍是 4 段（分类层级不丢）', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.renameAsset.mockResolvedValue(
      'E:\\ModVault\\Library\\模型\\未分类\\未分类\\北欧布艺沙发'
    )

    await useVault.getState().renameAsset(a.id, '北欧布艺沙发')

    const saved = putCalls[0]!
    // relFolder 与 folder 必须一致：folder 在 未分类/未分类 下，relFolder 也必须是 4 段
    expect(saved.relFolder).toBe('模型/未分类/未分类/北欧布艺沙发')
    expect(saved.relFolder.split('/').length).toBe(4)
    // cover 的 vault URL 依赖 relFolder —— 若 relFolder 退化成 2 段，封面会 404
    expect(`${saved.relFolder}/${saved.cover}`).toBe('模型/未分类/未分类/北欧布艺沙发/预览图.jpg')
  })
})

describe('DEF-02 ②：rescan 按 folder 合并，不重建（P0-17 / R9）', () => {
  it('folder 命中 → 沿用本地 id/tags/note/source/importedAt，不丢元数据', async () => {
    const local = fixture()
    useVault.setState({ assets: [local] })

    // 主进程 rescan 生成**新 UUID**、空 tags/note、source 为空
    const scanned = {
      ...fixture({
        id: 'ffffffff-0000-4000-8000-000000000001',
        tags: [],
        note: '',
        source: ''
      }),
      folder: local.folder, // 同一个磁盘位置 = 同一个资产
      relFolder: local.relFolder
    }
    modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })

    await useVault.getState().rescan()

    // 合并结果沿用本地 id（主键不漂移）与元数据
    expect(useVault.getState().assets.length).toBe(1)
    const merged = useVault.getState().assets[0]!
    expect(merged.id).toBe(local.id)
    expect(merged.tags).toEqual(['奶油', '侘寂'])
    expect(merged.note).toBe(local.note)
    expect(merged.source).toBe('知末网')
    expect(merged.importedAt).toBe(local.importedAt)
    expect(merged.category1).toBe('未分类')
    // 写库用 bulkPut，不 bulkDelete（资产还在，不该删）
    expect(bulkPutCalls.length).toBe(1)
    expect(bulkDeleteCalls.length).toBe(0)
    expect(bulkPutCalls[0]![0]!.id).toBe(local.id)
  })

  it('磁盘上已消失的资产 → 从索引移除（bulkDelete）', async () => {
    const keep = fixture()
    const gone = fixture({ name: '已删除', relFolder: '模型/未分类/未分类/已删除' })
    useVault.setState({ assets: [keep, gone] })

    // rescan 只发现 keep
    const scanned = { ...fixture({}), folder: keep.folder, relFolder: keep.relFolder }
    modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })

    await useVault.getState().rescan()

    expect(useVault.getState().assets.map((a) => a.id)).toEqual([keep.id])
    expect(bulkDeleteCalls.length).toBe(1)
    expect(bulkDeleteCalls[0]).toEqual([gone.id])
  })

  it('rescan 发现 ignored 目录 → 写入 notice（RA6 上报）', async () => {
    const local = fixture()
    useVault.setState({ assets: [local] })
    const scanned = { ...fixture({}), folder: local.folder, relFolder: local.relFolder }
    modvault.rescan.mockResolvedValue({
      assets: [scanned],
      ignored: [
        { relPath: '模型/散装', reason: 'depth' },
        { relPath: '模型/未分类/说明.txt', reason: 'not-dir' }
      ]
    })

    await useVault.getState().rescan()

    const notice = useVault.getState().notice
    expect(notice).toContain('2 个目录结构异常已跳过')
    expect(notice).toContain('1 个深度不符')
    expect(notice).toContain('1 个位置是文件')
  })

  it('无 ignored → 不写 notice（不制造噪音）', async () => {
    const local = fixture()
    useVault.setState({ assets: [local], notice: null })
    const scanned = { ...fixture({}), folder: local.folder, relFolder: local.relFolder }
    modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })

    await useVault.getState().rescan()

    expect(useVault.getState().notice).toBeNull()
  })
})
