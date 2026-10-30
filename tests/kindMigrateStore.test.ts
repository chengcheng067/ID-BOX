/**
 * `store.migrateLegacyKind` · **真实 store action** 的接线验收（2026-10-30 P0）。
 *
 * 与 `materialMergeStore.test.ts` / `storeFlow.test.ts` 同一套做法：不抽逻辑、不改实现，
 * 只把两个边界打桩 —— ① `window.modvault`（IPC 桥）→ vi.fn；② `db`（Dexie）→ 内存假 Table。
 * 于是这里驱动的是**实际发布的 `store.migrateLegacyKind()`**。
 *
 * 本文件钉住的是 `kindMigrate.test.ts`（主进程侧）**覆盖不到**的一半：
 * - 静默出口：`items.length === 0` 时**不弹 notice、不写库**（启动每次都会跑，不能吵）；
 * - `files[].kind` 真的从 `'model'` 改成 `'cad'`（主进程不改 files，这是渲染层的责任）；
 * - `kind` / `dedupeKey` 跟着变（不然后续重复检测整个失效）；
 * - `error` 项**不写库**（磁盘没动，索引也不能动）；
 * - 主键不变（禁止 delete+put，会丢 tags/note/styles）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type {
  Asset,
  KindMigrateDetectResult,
  KindMovePlan,
  KindMoveResult
} from '../src/shared/types'
import { dedupeKeyOf, baseNameOf } from '../src/shared/naming'

const modvault = {
  detectKindMigration: vi.fn(),
  applyKindMigration: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  deleteOneThumb: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const putCalls: Asset[] = []
const deleteCalls: string[] = []

const fakeAssets = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    putCalls.push(...list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => {
    deleteCalls.push(...ids)
    return ids.length
  })
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ─────────────────────────────────────────────────────────────

let seq = 0
function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const name = over.name ?? `图纸${n}`
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\装修图\\平面图\\${name}`,
    relFolder: `模型/装修图/平面图/${name}`,
    files: [{ rel: `${name}.dwg`, name: `${name}.dwg`, ext: 'dwg', size: 10, kind: 'model' }],
    size: 10,
    tags: ['客厅', '施工图'],
    note: '别删我',
    favorite: true,
    rating: 4,
    colorTag: 'red',
    dedupeKey: `model:${name}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '装修图',
    category2: '平面图',
    styles: ['现代'],
    ...over
  }
}

/** 造一份 **detect 的返回值**（精简结构，不含任何路径 —— 见 `KindMigrateDetectResult`） */
function probe(items: KindMovePlan['items'], scanned = items.length): KindMigrateDetectResult {
  return { count: items.length, scanned, names: items.map((i) => i.name) }
}

function moved(a: Asset, over: Partial<KindMoveResult> = {}): KindMoveResult {
  return {
    assetId: a.id,
    folder: `E:\\Lib\\CAD\\装修图\\平面图\\${a.name}`,
    name: a.name,
    relFolder: `CAD/装修图/平面图/${a.name}`,
    moved: true,
    renamed: false,
    ...over
  }
}

beforeEach(() => {
  putCalls.length = 0
  deleteCalls.length = 0
  vi.clearAllMocks()
  modvault.ensureThumb.mockResolvedValue('thumb.jpg')
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.deleteOneThumb.mockResolvedValue(true)
  useVault.setState({ notice: null })
})

// ── ① 静默出口 ────────────────────────────────────────────────────────

describe('静默出口：没有待迁移项时零副作用、零提示', () => {
  it('★detect 返回空计划 → 不 apply、不写库、不弹 notice', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], notice: null })
    modvault.detectKindMigration.mockResolvedValue(probe([]))

    const r = await useVault.getState().migrateLegacyKind()

    expect(r).toEqual({ moved: 0, failed: 0, scanned: 0 })
    expect(modvault.applyKindMigration).not.toHaveBeenCalled()
    expect(putCalls).toEqual([])
    // 关键：启动时每次都会跑到这里，**不能**弹一条"已迁移 0 个"
    expect(useVault.getState().notice).toBeNull()
  })

  it('库为空 → 连 IPC 都不发（启动早期 assets 还没读出来时也一样）', async () => {
    useVault.setState({ assets: [], notice: null })
    await useVault.getState().migrateLegacyKind()
    expect(modvault.detectKindMigration).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBeNull()
  })

  it('detect 抛错（IPC 挂了）→ 静默返回，不弹提示', async () => {
    useVault.setState({ assets: [fixture()], notice: null })
    modvault.detectKindMigration.mockRejectedValue(new Error('ipc dead'))
    const r = await useVault.getState().migrateLegacyKind()
    expect(r).toEqual({ moved: 0, failed: 0, scanned: 0 })
    expect(useVault.getState().notice).toBeNull()
  })
})

// ── ② files[].kind 改写（本段最高价值的断言）──────────────────────────

describe('★写库：files[].kind 从 model 改成 cad，kind / dedupeKey 跟着变', () => {
  it('成功项：kind=cad、files[].kind=cad、dedupeKey 前缀改 cad、主键与用户字段全保留', async () => {
    const a = fixture({ name: '客厅平面图' })
    useVault.setState({ assets: [a], notice: null })

    modvault.detectKindMigration.mockResolvedValue(
      probe([
        {
          assetId: a.id,
          name: a.name,
          fromRelFolder: a.relFolder,
          toRelFolder: `CAD/装修图/平面图/${a.name}`,
          fromKind: 'model',
          toKind: 'cad',
          folder: a.folder
        }
      ])
    )
    modvault.applyKindMigration.mockResolvedValue([moved(a)])

    const r = await useVault.getState().migrateLegacyKind()
    expect(r).toMatchObject({ moved: 1, failed: 0 })

    const saved = putCalls.find((x) => x.id === a.id)!
    expect(saved.kind).toBe('cad')
    // ★ 文件记录的 kind 必须一起改：不改则文件视图图标 + 后续 primaryKind 都还是 model
    expect(saved.files).toHaveLength(1)
    expect(saved.files[0]!.kind).toBe('cad')
    // rel / name / size 等文件自身字段一个不能丢
    expect(saved.files[0]!.rel).toBe('客厅平面图.dwg')
    expect(saved.files[0]!.ext).toBe('dwg')
    expect(saved.files[0]!.size).toBe(10)

    expect(saved.relFolder).toBe('CAD/装修图/平面图/客厅平面图')
    expect(saved.folder).toBe('E:\\Lib\\CAD\\装修图\\平面图\\客厅平面图')
    // dedupeKey 前缀必须跟着 kind 走，否则同名 cad 资产永远匹配不到（重复检测失效）
    expect(saved.dedupeKey).toBe(dedupeKeyOf(baseNameOf('客厅平面图'), 'cad'))
    expect(saved.dedupeKey.startsWith('cad:')).toBe(true)

    // 主键不变 + 用户数据一个不丢（禁止 delete+put）
    expect(saved.id).toBe(a.id)
    expect(saved.tags).toEqual(['客厅', '施工图'])
    expect(saved.note).toBe('别删我')
    expect(saved.favorite).toBe(true)
    expect(saved.rating).toBe(4)
    expect(saved.colorTag).toBe('red')
    expect(saved.styles).toEqual(['现代'])
    expect(deleteCalls).toEqual([])

    expect(useVault.getState().notice).toContain('已把 1 个图纸资产归到「CAD图纸」')
  })

  it('混合包里的贴图文件不被误改（只改 ext∈{dwg,dxf} 且 kind=model 的条目）', async () => {
    const a = fixture({
      name: '带预览图',
      files: [
        { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 5, kind: 'texture' },
        { rel: '平面.dwg', name: '平面.dwg', ext: 'dwg', size: 10, kind: 'model' }
      ]
    })
    useVault.setState({ assets: [a], notice: null })
    modvault.detectKindMigration.mockResolvedValue(
      probe([
        {
          assetId: a.id,
          name: a.name,
          fromRelFolder: a.relFolder,
          toRelFolder: `CAD/装修图/平面图/${a.name}`,
          fromKind: 'model',
          toKind: 'cad',
          folder: a.folder
        }
      ])
    )
    modvault.applyKindMigration.mockResolvedValue([moved(a)])

    await useVault.getState().migrateLegacyKind()
    const saved = putCalls.find((x) => x.id === a.id)!
    expect(saved.files.find((f) => f.ext === 'dwg')!.kind).toBe('cad')
    // 贴图仍是 texture（它的 kind 本来就不该动）
    expect(saved.files.find((f) => f.ext === 'jpg')!.kind).toBe('texture')
  })

  it('重名改名时：name 与 dedupeKey 用基础名重算（-2 不进 key）', async () => {
    const a = fixture({ name: '同名图' })
    useVault.setState({ assets: [a], notice: null })
    modvault.detectKindMigration.mockResolvedValue(
      probe([
        {
          assetId: a.id,
          name: a.name,
          fromRelFolder: a.relFolder,
          toRelFolder: 'CAD/装修图/平面图/同名图',
          fromKind: 'model',
          toKind: 'cad',
          folder: a.folder
        }
      ])
    )
    modvault.applyKindMigration.mockResolvedValue([
      moved(a, {
        name: '同名图-2',
        folder: 'E:\\Lib\\CAD\\装修图\\平面图\\同名图-2',
        relFolder: 'CAD/装修图/平面图/同名图-2',
        renamed: true
      })
    ])

    await useVault.getState().migrateLegacyKind()
    const saved = putCalls.find((x) => x.id === a.id)!
    expect(saved.name).toBe('同名图-2')
    expect(saved.relFolder).toBe('CAD/装修图/平面图/同名图-2')
    // `-2` 是 uniqueName 追加的，不是用户命名的 → key 用基础名（与 assignCategory 同口径）
    expect(saved.dedupeKey).toBe(dedupeKeyOf('同名图', 'cad'))
    expect(useVault.getState().notice).toContain('因目标重名自动改名')
  })
})

// ── ③ 失败隔离 ────────────────────────────────────────────────────────

describe('失败项：不写库、不静默、汇总里报出来', () => {
  it('★error 项**不写库**（磁盘没动，索引也不能动），成功的照样写', async () => {
    const ok = fixture({ name: '成功图' })
    const bad = fixture({ name: '失败图' })
    useVault.setState({ assets: [ok, bad], notice: null })
    modvault.detectKindMigration.mockResolvedValue(
      probe(
        [ok, bad].map((a) => ({
          assetId: a.id,
          name: a.name,
          fromRelFolder: a.relFolder,
          toRelFolder: `CAD/装修图/平面图/${a.name}`,
          fromKind: 'model' as const,
          toKind: 'cad' as const,
          folder: a.folder
        }))
      )
    )
    modvault.applyKindMigration.mockResolvedValue([
      moved(ok),
      {
        assetId: bad.id,
        folder: bad.folder,
        name: bad.name,
        relFolder: bad.relFolder,
        moved: false,
        renamed: false,
        error: '源目录不存在（磁盘已变动，请重新扫描）'
      }
    ])

    const r = await useVault.getState().migrateLegacyKind()
    expect(r).toEqual({ moved: 1, failed: 1, scanned: 2 })

    // 只有成功项被写库
    expect(putCalls.map((x) => x.id)).toEqual([ok.id])
    expect(putCalls.find((x) => x.id === bad.id)).toBeUndefined()
    // 失败数必须在提示里说清
    expect(useVault.getState().notice).toContain('1 个失败')
  })

  it('apply 整体抛错（IPC 挂了）→ 按全失败返回，不写库、不弹"已迁移"', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], notice: null })
    modvault.detectKindMigration.mockResolvedValue(
      probe([
        {
          assetId: a.id,
          name: a.name,
          fromRelFolder: a.relFolder,
          toRelFolder: `CAD/装修图/平面图/${a.name}`,
          fromKind: 'model',
          toKind: 'cad',
          folder: a.folder
        }
      ])
    )
    modvault.applyKindMigration.mockRejectedValue(new Error('ipc dead'))

    const r = await useVault.getState().migrateLegacyKind()
    expect(r).toEqual({ moved: 0, failed: 1, scanned: 1 })
    expect(putCalls).toEqual([])
    expect(useVault.getState().notice).toBeNull()
  })
})

// ── ④ 幂等 ────────────────────────────────────────────────────────────

describe('幂等：迁移完成后再次调用什么都不做', () => {
  it('第二次 detect 返回空（main 侧按新 kind 重算）→ 零写库、零提示', async () => {
    const a = fixture({ name: '幂等图' })
    useVault.setState({ assets: [a], notice: null })
    const item = {
      assetId: a.id,
      name: a.name,
      fromRelFolder: a.relFolder,
      toRelFolder: `CAD/装修图/平面图/${a.name}`,
      fromKind: 'model' as const,
      toKind: 'cad' as const,
      folder: a.folder
    }
    modvault.detectKindMigration.mockResolvedValueOnce(probe([item]))
    modvault.applyKindMigration.mockResolvedValue([moved(a)])

    await useVault.getState().migrateLegacyKind()
    expect(putCalls).toHaveLength(1)

    // 第二轮：库里那条已是 cad（模拟上一轮写库结果）→ main 的 detect 返回空
    putCalls.length = 0
    useVault.setState({ notice: null })
    modvault.detectKindMigration.mockResolvedValue(probe([]))
    const second = await useVault.getState().migrateLegacyKind()

    expect(second).toEqual({ moved: 0, failed: 0, scanned: 0 })
    expect(putCalls).toEqual([])
    expect(useVault.getState().notice).toBeNull()
  })
})
