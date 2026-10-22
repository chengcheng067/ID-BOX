/**
 * 材质大类合并 · **store 真实 action** 的接线验收（T-04，docs/14 §2.3.5）。
 *
 * 与 `storeFlow.test.ts` 同一套做法：不抽逻辑、不改实现，只把两个边界打桩——
 * ① `window.modvault`（IPC 桥）→ vi.fn；② `db`（Dexie）→ 内存假 Table。
 * 于是这里驱动的是**实际发布的 `store.mergeMaterial()`**，能真正验证：
 * - 只把成功项写库、**只 put 不 delete**（主键不变 → tags/note/styles 不丢）
 * - 重名时 `name` + `dedupeKey` 同步改，未重名时保持原值
 * - `needsManual` 时零写库
 * - 顺序：DB 事务在前、布局迁移在后
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, MergeMaterialResult } from '../src/shared/types'
import { baseNameOf, dedupeKeyOf } from '../src/shared/naming'

const modvault = {
  mergeMaterial: vi.fn(),
  detectMaterialMerge: vi.fn(),
  migrateLayout: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn()
}

// node 程序没有 window：桩是**部分实现**，断言处用 mock 的 calls
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

// ── 假 Dexie：记录 put / delete，transaction 直接执行回调 ─────────────
const putCalls: Asset[] = []
const deleteCalls: string[] = []
const transactionCalls: string[] = []
const backupPuts: Array<{ id: string; at: number; json: string }> = []

const fakeAssets = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => {
    deleteCalls.push(...ids)
    return ids.length
  })
}
const fakeBackups = {
  put: vi.fn(async (b: { id: string; at: number; json: string }) => {
    backupPuts.push(b)
    return b.id
  })
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })
Object.defineProperty(db, 'transaction', {
  value: async (mode: string, table: unknown, fn: () => Promise<void>) => {
    transactionCalls.push(mode)
    return fn()
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0
function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'texture',
    source: '知末网',
    folder: `E:\\Lib\\贴图\\未分类\\未分类\\资产${n}`,
    relFolder: `贴图/未分类/未分类/资产${n}`,
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [{ rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' }],
    size: 10,
    tags: ['奶油', '侘寂'],
    note: `第 ${n} 个`,
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `texture:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: ['现代'],
    renderParams: { roughness: 1.4, bump: 0.6, uv: 1.8 },
    ...over
  }
}

function result(over: Partial<MergeMaterialResult> = {}): MergeMaterialResult {
  return {
    moves: [],
    moved: 0,
    skipped: 0,
    renamed: 0,
    failures: [],
    needsManual: false,
    count: 0,
    manifestPath: 'E:\\Lib\\.idbox\\merge-material\\x.json',
    ...over
  }
}

beforeEach(() => {
  putCalls.length = 0
  deleteCalls.length = 0
  transactionCalls.length = 0
  backupPuts.length = 0
  vi.clearAllMocks()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
})

describe('store.mergeMaterial：DB 事务只 put 局部字段（禁止 delete+put）', () => {
  it('两个材质类资产成功搬移：folder/relFolder 更新，tags/note/styles/renderParams 全保留', async () => {
    const tex = fixture({ kind: 'texture', folder: 'E:\\Lib\\贴图\\A\\B\\纹理01', relFolder: '贴图/A/B/纹理01' })
    const mat = fixture({ kind: 'material', folder: 'E:\\Lib\\材质预设\\A\\B\\预设01', relFolder: '材质预设/A/B/预设01' })
    const model = fixture({ kind: 'model', folder: 'E:\\Lib\\模型\\A\\B\\模型01', relFolder: '模型/A/B/模型01' })
    useVault.setState({ assets: [tex, mat, model], materialMergeBusy: false })

    modvault.mergeMaterial.mockResolvedValue(
      result({
        moves: [
          {
            from: tex.folder,
            to: 'E:\\Lib\\材质\\A\\B\\纹理01',
            relFolderFrom: tex.relFolder,
            relFolderTo: '材质/A/B/纹理01',
            kind: 'texture',
            renamed: false,
            assetId: tex.id,
            prevRelFolder: tex.relFolder
          },
          {
            from: mat.folder,
            to: 'E:\\Lib\\材质\\A\\B\\预设01',
            relFolderFrom: mat.relFolder,
            relFolderTo: '材质/A/B/预设01',
            kind: 'material',
            renamed: false,
            assetId: mat.id,
            prevRelFolder: mat.relFolder
          }
        ],
        moved: 2,
        count: 2
      })
    )

    const summary = await useVault.getState().mergeMaterial()

    expect(summary).toMatchObject({ moved: 2, renamed: 0, failed: 0, needsManual: false })
    // 只写成功项；模型不在 moves 里 → 不写
    expect(putCalls).toHaveLength(2)
    expect(deleteCalls).toEqual([])
    expect(transactionCalls).toEqual(['rw'])
    // 快照先落（回滚凭据）
    expect(backupPuts).toHaveLength(1)
    expect(JSON.parse(backupPuts[0]!.json).map((a: Asset) => a.id).sort()).toEqual([tex.id, mat.id].sort())

    const savedTex = putCalls.find((a) => a.id === tex.id)!
    expect(savedTex.folder).toBe('E:\\Lib\\材质\\A\\B\\纹理01')
    expect(savedTex.relFolder).toBe('材质/A/B/纹理01')
    expect(savedTex.name).toBe(tex.name) // 未重名 → 名字不动
    expect(savedTex.dedupeKey).toBe(tex.dedupeKey)
    expect(savedTex.tags).toEqual(['奶油', '侘寂'])
    expect(savedTex.note).toBe(tex.note)
    expect(savedTex.styles).toEqual(['现代'])
    expect(savedTex.renderParams).toEqual({ roughness: 1.4, bump: 0.6, uv: 1.8 })
    expect(savedTex.id).toBe(tex.id) // 主键不变

    // 传给 main 的是**全量**资产引用（main 据此把 assetId 写进 manifest）
    const payload = modvault.mergeMaterial.mock.calls[0]![0] as { assets: Array<{ id: string }>; force?: boolean }
    expect(payload.assets.map((a) => a.id)).toEqual([tex.id, mat.id, model.id])
    expect(payload.force).toBe(false)

    // 内存状态同步更新
    expect(useVault.getState().assets.find((a) => a.id === tex.id)!.relFolder).toBe('材质/A/B/纹理01')
    expect(useVault.getState().materialMergeCount).toBe(0)
    expect(useVault.getState().notice).toContain('成功 2')
  })

  it('重名项：name 换成落盘末段，dedupeKey 保持基础名口径（v0.4）', async () => {
    const a = fixture({ kind: 'material', name: '同名', dedupeKey: 'material:同名' })
    useVault.setState({ assets: [a], materialMergeBusy: false })

    modvault.mergeMaterial.mockResolvedValue(
      result({
        moves: [
          {
            from: a.folder,
            to: 'E:\\Lib\\材质\\未分类\\未分类\\同名-2',
            relFolderFrom: a.relFolder,
            relFolderTo: '材质/未分类/未分类/同名-2',
            kind: 'material',
            renamed: true,
            assetId: a.id,
            prevRelFolder: a.relFolder
          }
        ],
        moved: 1,
        renamed: 1,
        count: 1
      })
    )

    await useVault.getState().mergeMaterial()
    const saved = putCalls[0]!
    expect(saved.name).toBe('同名-2')
    expect(saved.relFolder).toBe('材质/未分类/未分类/同名-2')
    // v0.4：`同名-2` 是 main 的 uniqueName **自动**追加的序号，dedupeKey 必须按
    // 基础名算（baseNameOf 剥掉 `-2`）→ 与原件仍是同一个 key；若按最终名算，
    // 合并一次就把「同一套资产」的重复关系断开了（A0 缺陷的同款问题）。
    expect(saved.dedupeKey).toBe(dedupeKeyOf(baseNameOf('同名-2'), 'material'))
    expect(saved.dedupeKey).toBe('material:同名')
    expect(saved.dedupeKey).toBe(a.dedupeKey)
    expect(saved.dedupeKey).not.toBe(dedupeKeyOf('同名-2', 'material'))
    expect(saved.tags).toEqual(a.tags)
  })

  it('needsManual（>50 未 force）：磁盘零改动 → 不写库、不建快照，只记数字与提示', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], materialMergeBusy: false })
    modvault.mergeMaterial.mockResolvedValue(
      result({ needsManual: true, count: 137, manifestPath: null })
    )

    const summary = await useVault.getState().mergeMaterial()

    expect(summary).toMatchObject({ moved: 0, needsManual: true, count: 137 })
    expect(putCalls).toEqual([])
    expect(backupPuts).toEqual([])
    expect(transactionCalls).toEqual([])
    expect(useVault.getState().materialMergeCount).toBe(137)
    expect(useVault.getState().notice).toContain('设置')
    // 提示文案必须给出可行动入口
    expect(useVault.getState().notice).toContain('材质大类合并')
  })

  it('force=true 由设置页传入（跳过 >50 保护）', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], materialMergeBusy: false })
    modvault.mergeMaterial.mockResolvedValue(result({ moved: 0, count: 0 }))
    await useVault.getState().mergeMaterial({ force: true })
    expect((modvault.mergeMaterial.mock.calls[0]![0] as { force?: boolean }).force).toBe(true)
  })

  it('并发保护：busy 时直接返回，不重复调 IPC', async () => {
    useVault.setState({ assets: [fixture()], materialMergeBusy: true })
    const summary = await useVault.getState().mergeMaterial()
    expect(summary.moved).toBe(0)
    expect(modvault.mergeMaterial).not.toHaveBeenCalled()
  })
})
