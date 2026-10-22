/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import { isReconcileClean, reconcile } from '../src/renderer/logic/reconcile'

/**
 * v0.4 库一致性对账的测试。
 *
 * ① 纯函数 `reconcile()`：三类判定、**以 folder 为键**、排序与计数、空输入；
 * ② store `applyReconcile()`：备份早于删除、批量写条数、分类修正、幂等；
 * ③ 源码守卫：对账面板三个复选框默认 false；`checkLibraryConsistency` 体内不写库。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/** 磁盘侧「当前真相」：rescan 每次都返回它（apply 前会重新扫） */
let diskAssets: Asset[] = []

const modvault = {
  rescan: vi.fn(async () => ({ assets: diskAssets, ignored: [] })),
  pruneThumbs: vi.fn().mockResolvedValue(0),
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0)
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
import type { IndexBackup } from '../src/renderer/db'

/** 调用顺序（验证「先备份再删」） */
const calls: string[] = []
const bulkPutCalls: Asset[][] = []
const bulkDeleteCalls: string[][] = []

const fakeAssetsTable = {
  put: vi.fn(async (a: Asset) => {
    calls.push('put')
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    calls.push('bulkPut')
    bulkPutCalls.push(list.map((a) => ({ ...a })))
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => {
    calls.push('bulkDelete')
    bulkDeleteCalls.push([...ids])
    return ids.length
  }),
  toArray: vi.fn(async () => [])
}
Object.defineProperty(db, 'assets', { value: fakeAssetsTable, configurable: true })

const backupStore = new Map<string, IndexBackup>()
const fakeBackupsTable = {
  put: vi.fn(async (b: IndexBackup) => {
    calls.push('backup.put')
    backupStore.set(b.id, b)
    return b.id
  }),
  toArray: vi.fn(async () => [...backupStore.values()]),
  bulkDelete: vi.fn(async (ids: string[]) => {
    calls.push('backup.bulkDelete')
    for (const id of ids) backupStore.delete(id)
    return ids.length
  })
}
Object.defineProperty(db, 'backups', { value: fakeBackupsTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const cat1 = patch.category1 ?? '家具'
  const cat2 = patch.category2 ?? '沙发'
  const name = patch.name ?? `资产${n}`
  return {
    id: patch.id ?? `id-${n}`,
    name,
    kind: 'model',
    source: '知末网',
    folder: patch.folder ?? `E:\\Lib\\模型\\${cat1}\\${cat2}\\${name}`,
    relFolder: patch.relFolder ?? `模型/${cat1}/${cat2}/${name}`,
    files: [{ rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 10, kind: 'model' }],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${name}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: cat1,
    category2: cat2,
    styles: [],
    ...patch
  }
}

beforeEach(() => {
  calls.length = 0
  bulkPutCalls.length = 0
  bulkDeleteCalls.length = 0
  backupStore.clear()
  diskAssets = []
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.rescan.mockImplementation(async () => ({ assets: diskAssets, ignored: [] }))
  useVault.setState({ assets: [], notice: null })
})

// ── ① 纯函数 reconcile ──────────────────────────────────────────

describe('reconcile —— 三类差异判定', () => {
  it('missing-on-disk / not-in-index / category-mismatch 各一组', () => {
    const onDisk = asset({ name: '一致' })
    const gone = asset({ name: '已删' })
    const moved = asset({ name: '改类', category1: '灯具', category2: '吊灯' })

    const index = [onDisk, gone, moved]
    const scanned = [
      onDisk,
      { ...moved, category1: '家具', category2: '椅子' } // 磁盘上被改成家具/椅子
    ]

    const report = reconcile(index, scanned)
    expect(report.counts['missing-on-disk']).toBe(1)
    expect(report.counts['not-in-index']).toBe(0)
    expect(report.counts['category-mismatch']).toBe(1)

    const mismatch = report.items.find((i) => i.kind === 'category-mismatch')!
    expect(mismatch.name).toBe('改类')
    expect(mismatch.indexCategory).toEqual(['灯具', '吊灯'])
    expect(mismatch.diskCategory).toEqual(['家具', '椅子'])
    expect(mismatch.id).toBe(moved.id)

    const missing = report.items.find((i) => i.kind === 'missing-on-disk')!
    expect(missing.id).toBe(gone.id)
    expect(missing.folder).toBe(gone.folder)

    // 完全一致的资产不出现
    expect(report.items.some((i) => i.name === '一致')).toBe(false)
    expect(report.scannedCount).toBe(2)
    expect(report.indexCount).toBe(3)
  })

  it('not-in-index 携带 scanned 完整对象', () => {
    const manual = asset({ name: '手动放进来' })
    const report = reconcile([], [manual])
    expect(report.counts['not-in-index']).toBe(1)
    expect(report.items[0]!.scanned).toBe(manual)
    expect(report.items[0]!.id).toBeUndefined()
  })

  it('**以 folder 为键**：folder 相同但 id 不同 → 不算任何变更', () => {
    const idx = asset({ id: 'uuid-old', name: '同一个' })
    const scanned = { ...idx, id: 'uuid-new' } // main 的 rescan 每次生成新 UUID
    const report = reconcile([idx], [scanned])
    expect(report.items).toEqual([])
    expect(isReconcileClean(report)).toBe(true)
  })

  it('分类相同则不产生 mismatch；缺省分类按「未分类」比较', () => {
    const a = asset({ name: 'A', category1: '家具', category2: '沙发' })
    expect(reconcile([a], [{ ...a }]).items).toEqual([])

    const legacy = { ...asset({ name: 'B' }), category1: undefined, category2: undefined }
    const legacyScan = { ...asset({ name: 'B' }), category1: UNCLASSIFIED, category2: UNCLASSIFIED }
    expect(reconcile([legacy as Asset], [legacyScan]).items).toEqual([])
  })

  it('counts 与 items 一致，排序 missing → notInIndex → mismatch（组内按 name）', () => {
    const m2 = asset({ name: 'm2' })
    const m1 = asset({ name: 'm1' })
    const n2 = asset({ name: 'n2' })
    const n1 = asset({ name: 'n1' })
    const c2 = asset({ name: 'c2', category1: '灯具', category2: '吊灯' })
    const c1 = asset({ name: 'c1', category1: '灯具', category2: '吊灯' })

    const report = reconcile(
      [m2, m1, c2, c1],
      [n2, n1, { ...c2, category1: '家具' }, { ...c1, category1: '家具' }]
    )
    const kinds = report.items.map((i) => i.kind)
    expect(kinds).toEqual([
      'missing-on-disk',
      'missing-on-disk',
      'not-in-index',
      'not-in-index',
      'category-mismatch',
      'category-mismatch'
    ])
    expect(report.items.slice(0, 2).map((i) => i.name)).toEqual(['m1', 'm2'])
    expect(report.items.slice(2, 4).map((i) => i.name)).toEqual(['n1', 'n2'])
    expect(report.items.slice(4).map((i) => i.name)).toEqual(['c1', 'c2'])

    const total = report.counts['missing-on-disk'] + report.counts['not-in-index'] + report.counts['category-mismatch']
    expect(total).toBe(report.items.length)
  })

  it('空索引 / 空扫描 / 两者都空都不崩', () => {
    expect(reconcile([], []).items).toEqual([])
    expect(reconcile([], [asset()]).counts['not-in-index']).toBe(1)
    expect(reconcile([asset()], []).counts['missing-on-disk']).toBe(1)
  })

  it('不修改入参', () => {
    const a = asset({ name: 'a' })
    const b = asset({ name: 'b' })
    const index = [b, a]
    const scanned = [a]
    reconcile(index, scanned)
    expect(index.map((x) => x.name)).toEqual(['b', 'a'])
    expect(scanned.map((x) => x.name)).toEqual(['a'])
  })
})

// ── ② store.applyReconcile ─────────────────────────────────────

describe('applyReconcile —— 修复执行', () => {
  it('removeIndex：**backs up before delete**（顺序断言），并更新内存', async () => {
    const keep = asset({ name: '保留' })
    const gone = asset({ name: '移除我' })
    useVault.setState({ assets: [keep, gone] })
    diskAssets = [keep]

    const res = await useVault.getState().applyReconcile({
      removeIndex: [gone.id],
      addIndex: [],
      fixCategory: []
    })

    expect(res.removed).toBe(1)
    expect(res.failed).toBe(0)
    const backupAt = calls.indexOf('backup.put')
    const deleteAt = calls.indexOf('bulkDelete')
    expect(backupAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(backupAt) // 备份必须早于删除

    // 备份里是**完整记录**（含 tags/note），不是只有 id
    const saved = [...backupStore.values()][0]!
    expect(JSON.parse(saved.json)[0].note).toBe('')
    expect(saved.id.startsWith('rescan-')).toBe(true)

    expect(bulkDeleteCalls[0]).toEqual([gone.id])
    expect(useVault.getState().assets.map((a) => a.name)).toEqual(['保留'])
  })

  it('addIndex：bulkPut 条数与入参一致，且跳过已在索引里的 folder', async () => {
    const existing = asset({ name: '已有' })
    const fresh = asset({ name: '新来的' })
    useVault.setState({ assets: [existing] })
    diskAssets = [existing, fresh]

    const res = await useVault.getState().applyReconcile({
      removeIndex: [],
      addIndex: [fresh, existing], // existing 已在索引 → 应被过滤
      fixCategory: []
    })

    expect(res.added).toBe(1)
    expect(bulkPutCalls.length).toBe(1)
    expect(bulkPutCalls[0]!.map((a) => a.name)).toEqual(['新来的'])
    expect(useVault.getState().assets.some((a) => a.name === '新来的')).toBe(true)
    expect(useVault.getState().assets.length).toBe(2)
  })

  it('fixCategory：category1/2 与 folder/relFolder 都取磁盘值', async () => {
    const disk = asset({ name: '改类资产', category1: '家具', category2: '椅子' })
    const stale = {
      ...asset({ name: '改类资产', folder: disk.folder }),
      category1: '灯具',
      category2: '吊灯',
      relFolder: '模型/灯具/吊灯/改类资产'
    }
    useVault.setState({ assets: [stale] })
    diskAssets = [disk]

    const res = await useVault.getState().applyReconcile({
      removeIndex: [],
      addIndex: [],
      fixCategory: [stale.id]
    })

    expect(res.fixed).toBe(1)
    const saved = bulkPutCalls[0]![0]!
    expect(saved.category1).toBe('家具')
    expect(saved.category2).toBe('椅子')
    expect(saved.folder).toBe(disk.folder)
    expect(saved.relFolder).toBe(disk.relFolder)
    expect(saved.updatedAt).toBeGreaterThan(stale.updatedAt)

    const inMemory = useVault.getState().assets[0]!
    expect(inMemory.category2).toBe('椅子')
    expect(inMemory.relFolder).toBe(disk.relFolder)
  })

  it('幂等：同一份磁盘结果连续 apply 两次 → 第二次 0/0/0', async () => {
    const keep = asset({ name: '保留' })
    const gone = asset({ name: '移除我' })
    const fresh = asset({ name: '新来的' })
    const diskMoved = asset({ name: '改类资产', category1: '家具', category2: '椅子' })
    const staleMoved = {
      ...asset({ name: '改类资产', folder: diskMoved.folder }),
      category1: '灯具',
      category2: '吊灯'
    }

    useVault.setState({ assets: [keep, gone, staleMoved] })
    diskAssets = [keep, fresh, diskMoved]

    const actions = {
      removeIndex: [gone.id],
      addIndex: [fresh],
      fixCategory: [staleMoved.id]
    }

    const first = await useVault.getState().applyReconcile(actions)
    expect(first).toEqual({ removed: 1, added: 1, fixed: 1, failed: 0 })

    const second = await useVault.getState().applyReconcile(actions)
    expect(second).toEqual({ removed: 0, added: 0, fixed: 0, failed: 0 })
  })

  it('空动作 → 三个计数 0，且不碰数据库', async () => {
    useVault.setState({ assets: [asset()] })
    const res = await useVault.getState().applyReconcile({
      removeIndex: [],
      addIndex: [],
      fixCategory: []
    })
    expect(res).toEqual({ removed: 0, added: 0, fixed: 0, failed: 0 })
    expect(calls).toEqual([])
  })

  it('扫描失败 → 取消修复并落 notice，不写库', async () => {
    const a = asset({ name: 'A' })
    useVault.setState({ assets: [a], notice: null })
    modvault.rescan.mockRejectedValueOnce(new Error('EACCES'))

    const res = await useVault.getState().applyReconcile({
      removeIndex: [a.id],
      addIndex: [],
      fixCategory: []
    })
    expect(res.removed).toBe(0)
    expect(res.failed).toBe(1)
    expect(calls).toEqual([])
    expect(useVault.getState().notice).toContain('库一致性修复已取消')
  })

  it('checkLibraryConsistency 是**纯只读**：零 db 写入、零状态变更、只扫一次', async () => {
    const a = asset({ name: '不变' })
    useVault.setState({ assets: [a], notice: '原有提示' })
    diskAssets = [a]
    const beforeAssets = useVault.getState().assets

    const report = await useVault.getState().checkLibraryConsistency()

    expect(report.items).toEqual([])
    expect(isReconcileClean(report)).toBe(true)
    // 没有任何 put / bulkPut / bulkDelete / 备份写入
    expect(calls).toEqual([])
    // 内存资产数组**同一个引用** = 完全没被替换/改写
    expect(useVault.getState().assets).toBe(beforeAssets)
    expect(useVault.getState().assets[0]).toBe(a)
    // notice 也没被改（检查不产生任何提示）
    expect(useVault.getState().notice).toBe('原有提示')
    // 只调用了一次只读扫描
    expect(modvault.rescan).toHaveBeenCalledTimes(1)
  })
})

// ── ③ 源码守卫 ─────────────────────────────────────────────────

describe('源码守卫', () => {
  it('对账面板三个复选框默认都是 false（默认不改）', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'SettingsDialog.tsx'),
      'utf8'
    )
    expect(src).toMatch(/const \[pickMissing, setPickMissing\] = useState\(false\)/)
    expect(src).toMatch(/const \[pickNotIndexed, setPickNotIndexed\] = useState\(false\)/)
    expect(src).toMatch(/const \[pickMismatch, setPickMismatch\] = useState\(false\)/)
    // 「勾选后才会修改」的提示必须在，避免有人把默认值改成 true 还悄悄合并
    expect(src).toContain('勾选后才会修改')
  })

  it('checkLibraryConsistency 体内不写库、不改 store（只读检查的证据）', async () => {
    const src = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'store.ts'), 'utf8')
    const start = src.indexOf('async checkLibraryConsistency()')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('async applyReconcile(', start)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)

    // 只能有：读内存索引 + 一次只读 rescan + 纯函数对比
    expect(body).toContain('window.modvault.rescan()')
    expect(body).toContain('reconcile(')
    expect(body).not.toContain('db.')
    expect(body).not.toMatch(/\bset\(/)
    expect(body).not.toContain('bulkPut')
    expect(body).not.toContain('bulkDelete')
    expect(body).not.toContain('notice')
  })
})
