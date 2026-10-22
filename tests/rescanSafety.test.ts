/// <reference lib="dom" />
/**
 * 库安全三件套（2026-10 用户已批准的紧急修复）。
 *
 * 复现的真实丢数据通道：`ImportQueue.changeLibrary()` 选完新库目录 → 自动 `rescan()`
 * → 扫到空数组 → `localByFolder` 全部匹配不到 → `bulkDelete` 全库索引；
 * tags / note / styles 只存在索引里 → **永久丢失**。
 *
 * 这里驱动**真实的 `store.rescan()`**（与 storeFlow.test.ts 同款打桩：window.modvault +
 * 内存版 Dexie Table），逐条验证守卫与备份；另外用源码守卫钉住 ImportQueue 不再自动重扫。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import type { IndexBackup } from '../src/renderer/db'

const modvault = {
  rescan: vi.fn(),
  setSettings: vi.fn(),
  chooseLibrary: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  migrateLayout: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

// ── 内存版 Dexie ───────────────────────────────────────────────────
const bulkPutCalls: Asset[][] = []
const bulkDeleteCalls: string[][] = []
const backupPuts: IndexBackup[] = []
const backupStore = new Map<string, IndexBackup>()

const fakeAssets = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push([...list])
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => {
    bulkDeleteCalls.push([...ids])
    return ids.length
  }),
  toArray: vi.fn(async () => [])
}
const fakeBackups = {
  put: vi.fn(async (b: IndexBackup) => {
    backupPuts.push(b)
    backupStore.set(b.id, b)
    return b.id
  }),
  toArray: vi.fn(async () => [...backupStore.values()]),
  bulkDelete: vi.fn(async (ids: string[]) => {
    for (const id of ids) backupStore.delete(id)
    return ids.length
  })
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────
let seq = 0
function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [],
    size: 0,
    tags: ['奶油', '侘寂'],
    note: `第 ${n} 个`,
    styles: ['现代'],
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    ...over
  }
}

/** 模拟主进程扫到的"同位置"记录（新 UUID、空元数据） */
function scannedOf(a: Asset): Asset {
  return {
    ...a,
    id: `ffffffff-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
    tags: [],
    note: '',
    source: ''
  }
}

beforeEach(() => {
  bulkPutCalls.length = 0
  bulkDeleteCalls.length = 0
  backupPuts.length = 0
  backupStore.clear()
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  useVault.setState({ assets: [], notice: null, rescanBackupCount: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('守卫 ①：扫描结果为空 + 本地有索引 → 一律中止（不删、不写、不裁剪缩略图）', () => {
  it('scanned=[] 时返回 empty-scan，db.assets 零调用，notice 明确提示库目录可能选错', async () => {
    const a = fixture()
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })

    const outcome = await useVault.getState().rescan()

    expect(outcome).toEqual({ aborted: 'empty-scan', scanned: 0, removed: 0 })
    // 三条"不可逆副作用"必须为零
    expect(fakeAssets.bulkDelete).not.toHaveBeenCalled()
    expect(fakeAssets.bulkPut).not.toHaveBeenCalled()
    expect(fakeBackups.put).not.toHaveBeenCalled()
    expect(modvault.pruneThumbs).not.toHaveBeenCalled()
    // 索引原封不动（含 tags/note）
    expect(useVault.getState().assets.map((x) => x.id)).toEqual([a.id, b.id])
    expect(useVault.getState().assets[0]!.tags).toEqual(['奶油', '侘寂'])
    expect(useVault.getState().notice).toContain('重扫已中止')
    expect(useVault.getState().notice).toContain('库目录可能选错了')
  })

  it('库本身就是空索引 + 空扫描 → 不是危险路径，正常走完（不误报）', async () => {
    useVault.setState({ assets: [] })
    modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })

    const outcome = await useVault.getState().rescan()
    expect(outcome).toEqual({ aborted: null, scanned: 0, removed: 0 })
    expect(fakeAssets.bulkDelete).not.toHaveBeenCalled()
  })
})

describe('守卫 ②：一次要删超过一半（且 >10 条）→ 中止', () => {
  it('20 个本地资产、扫描只认出 5 个新目录 → mass-delete，索引与磁盘操作零发生', async () => {
    const locals = Array.from({ length: 20 }, () => fixture())
    useVault.setState({ assets: locals })
    // 新目录里只有 5 个陌生资产（folder 全不匹配）→ gone = 20
    const strangers = Array.from({ length: 5 }, () =>
      fixture({ folder: `E:\\NewLib\\模型\\未分类\\未分类\\新资产${seq}` })
    )
    modvault.rescan.mockResolvedValue({ assets: strangers, ignored: [] })

    const outcome = await useVault.getState().rescan()

    expect(outcome.aborted).toBe('mass-delete')
    expect(outcome.removed).toBe(0)
    expect(fakeAssets.bulkDelete).not.toHaveBeenCalled()
    expect(fakeAssets.bulkPut).not.toHaveBeenCalled()
    expect(fakeBackups.put).not.toHaveBeenCalled()
    expect(modvault.pruneThumbs).not.toHaveBeenCalled()
    expect(useVault.getState().assets).toHaveLength(20)
    expect(useVault.getState().notice).toContain('超过一半')
    expect(useVault.getState().notice).toContain('20/20')
  })

  it('刚好一半（10/20，未超 >10）→ 不触发守卫，正常删除', async () => {
    const locals = Array.from({ length: 20 }, () => fixture())
    useVault.setState({ assets: locals })
    modvault.rescan.mockResolvedValue({ assets: locals.slice(0, 10).map(scannedOf), ignored: [] })

    const outcome = await useVault.getState().rescan()

    expect(outcome.aborted).toBeNull()
    expect(fakeAssets.bulkDelete).toHaveBeenCalledTimes(1)
    expect(outcome.removed).toBe(10)
  })
})

describe('守卫 ③：真删前写完整记录快照，只留 5 份', () => {
  it('正常 rescan（匹配率正常）行为不变：只 bulkPut，不删除；但会写一份**改库前快照**', async () => {
    const locals = [fixture(), fixture(), fixture()]
    useVault.setState({ assets: locals })
    modvault.rescan.mockResolvedValue({ assets: locals.map(scannedOf), ignored: [] })

    const outcome = await useVault.getState().rescan()

    expect(outcome).toEqual({ aborted: null, scanned: 3, removed: 0 })
    expect(bulkPutCalls).toHaveLength(1)
    expect(bulkPutCalls[0]!.map((a) => a.id)).toEqual(locals.map((a) => a.id))
    expect(fakeAssets.bulkDelete).not.toHaveBeenCalled()
    // 安全网 ④：写入前把"将被覆盖的原记录"整份存快照（本次事故的教训）
    expect(backupPuts.map((b) => b.id.startsWith('rescan-pre-'))).toEqual([true])
    // 「恢复上次重扫前索引」只认删除备份，快照不参与计数（否则按钮会失效）
    expect(useVault.getState().rescanBackupCount).toBe(0)
  })

  it('小规模删除（2 个里删 1 个）照常执行，但删除前把**完整 records**写进 backups', async () => {
    const keep = fixture()
    const gone = fixture({ tags: ['重要标签'], note: '别丢我', styles: ['侘寂'] })
    useVault.setState({ assets: [keep, gone] })
    modvault.rescan.mockResolvedValue({ assets: [scannedOf(keep)], ignored: [] })

    const outcome = await useVault.getState().rescan()

    expect(outcome).toEqual({ aborted: null, scanned: 1, removed: 1 })
    // 两份凭证：① 改库前快照（rescan-pre-*，含 keep 的原记录）② 删除备份（rescan-*）
    const deletionBackups = backupPuts.filter((b) => !b.id.startsWith('rescan-pre-'))
    const preSnapshots = backupPuts.filter((b) => b.id.startsWith('rescan-pre-'))
    expect(deletionBackups).toHaveLength(1)
    expect(preSnapshots).toHaveLength(1)

    const saved = deletionBackups[0]!
    expect(saved.id.startsWith('rescan-')).toBe(true)
    expect(typeof saved.at).toBe('number')
    const records = JSON.parse(saved.json) as Asset[]
    expect(records).toHaveLength(1)
    // 完整记录：不是只有 id
    expect(records[0]!.id).toBe(gone.id)
    expect(records[0]!.tags).toEqual(['重要标签'])
    expect(records[0]!.note).toBe('别丢我')
    expect(records[0]!.styles).toEqual(['侘寂'])
    expect(records[0]!.folder).toBe(gone.folder)
    // 快照只含"会被覆盖"的 keep，不含将被删除的 gone
    const pre = JSON.parse(preSnapshots[0]!.json) as Asset[]
    expect(pre.map((r) => r.id)).toEqual([keep.id])
    // 备份发生在删除之前（同一次调用内，且删除只用 id 列表）
    expect(bulkDeleteCalls[0]).toEqual([gone.id])
    // 计数只算删除备份（快照不算「可恢复的删除记录」）
    expect(useVault.getState().rescanBackupCount).toBe(1)
  })

  it('备份只保留最近 5 条（第 6 次删除会把最旧的清掉；两个家族各留 5 条）', async () => {
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)

    for (let i = 0; i < 6; i++) {
      const keep = fixture()
      const gone = fixture()
      useVault.setState({ assets: [keep, gone] })
      modvault.rescan.mockResolvedValue({ assets: [scannedOf(keep)], ignored: [] })
      await useVault.getState().rescan()
    }

    const deletionIds = backupPuts.filter((b) => !b.id.startsWith('rescan-pre-')).map((b) => b.id)
    const preIds = backupPuts.filter((b) => b.id.startsWith('rescan-pre-')).map((b) => b.id)
    expect(deletionIds).toHaveLength(6)
    expect(preIds).toHaveLength(6)
    expect([...backupStore.keys()].filter((id) => !id.startsWith('rescan-pre-'))).toHaveLength(5)
    expect([...backupStore.keys()].filter((id) => id.startsWith('rescan-pre-'))).toHaveLength(5)
    // 最旧的那条被删
    expect(backupStore.has(deletionIds[0]!)).toBe(false)
    expect(backupStore.has(deletionIds[5]!)).toBe(true)
    expect(backupStore.has(preIds[0]!)).toBe(false)
    expect(backupStore.has(preIds[5]!)).toBe(true)
    expect(fakeBackups.bulkDelete).toHaveBeenCalled()
  })
})

describe('restoreLastRescanBackup：把备份 bulkPut 回索引', () => {
  it('恢复最近一条备份的完整记录（含 tags/note/styles）并给出提示', async () => {
    const a = fixture({ tags: ['恢复我'], note: '备注', styles: ['极简'] })
    const b = fixture()
    backupStore.set(`rescan-${Date.now() - 1000}`, {
      id: `rescan-${Date.now() - 1000}`,
      at: Date.now() - 1000,
      json: JSON.stringify([a, b])
    })
    useVault.setState({ assets: [] })

    const restored = await useVault.getState().restoreLastRescanBackup()

    expect(restored).toBe(2)
    expect(bulkPutCalls).toHaveLength(1)
    expect(bulkPutCalls[0]!.map((x) => x.id)).toEqual([a.id, b.id])
    const assets = useVault.getState().assets
    expect(assets).toHaveLength(2)
    expect(assets.find((x) => x.id === a.id)!.tags).toEqual(['恢复我'])
    expect(assets.find((x) => x.id === a.id)!.note).toBe('备注')
    expect(useVault.getState().notice).toContain('已恢复 2 个资产')
    expect(useVault.getState().notice).toContain('磁盘文件')
  })

  it('没有备份 → 返回 0 且明确提示（设置页按钮同时会被禁用）', async () => {
    useVault.setState({ assets: [] })
    const restored = await useVault.getState().restoreLastRescanBackup()
    expect(restored).toBe(0)
    expect(bulkPutCalls).toHaveLength(0)
    expect(useVault.getState().notice).toContain('没有可恢复的重扫备份')
  })

  it('已在索引里的同 id 记录不被备份覆盖（用户之后的手工修改优先）', async () => {
    const existing = fixture({ note: '我改过' })
    backupStore.set('rescan-1', { id: 'rescan-1', at: 1, json: JSON.stringify([existing]) })
    useVault.setState({ assets: [existing] })

    const restored = await useVault.getState().restoreLastRescanBackup()

    expect(restored).toBe(0)
    expect(bulkPutCalls).toHaveLength(0)
    expect(useVault.getState().assets[0]!.note).toBe('我改过')
  })
})

describe('forceRescan：强制路径跳过守卫但仍先备份', () => {
  it('空扫描 + 2 个本地资产 → 确实删除，且 backups.put 先于 bulkDelete（顺序断言）', async () => {
    const a = fixture({ tags: ['会被备份'], note: '备忘录' })
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })

    const outcome = await useVault.getState().forceRescan()

    expect(outcome).toEqual({ aborted: null, scanned: 0, removed: 2 })
    expect(fakeAssets.bulkDelete).toHaveBeenCalledTimes(1)
    expect(bulkDeleteCalls[0]!.sort()).toEqual([a.id, b.id].sort())
    expect(fakeBackups.put).toHaveBeenCalledTimes(1)

    // ★ 顺序：先写备份，再删（强制 ≠ 不救）
    const putOrder = fakeBackups.put.mock.invocationCallOrder[0]!
    const delOrder = fakeAssets.bulkDelete.mock.invocationCallOrder[0]!
    expect(putOrder).toBeLessThan(delOrder)

    // 备份内容含完整记录
    const records = JSON.parse(backupPuts[0]!.json) as Asset[]
    expect(records.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(records.find((r) => r.id === a.id)!.tags).toEqual(['会被备份'])

    expect(useVault.getState().assets).toEqual([])
    expect(useVault.getState().rescanBackupCount).toBe(1)
  })

  it('强制删除后立刻「恢复上次重扫前索引」→ 资产与元数据全部回来', async () => {
    const a = fixture({ tags: ['重要'], note: '别丢', styles: ['侘寂'] })
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })

    await useVault.getState().forceRescan()
    expect(useVault.getState().assets).toEqual([])

    const restored = await useVault.getState().restoreLastRescanBackup()

    expect(restored).toBe(2)
    const byId = new Map(useVault.getState().assets.map((x) => [x.id, x]))
    expect(byId.size).toBe(2)
    expect(byId.get(a.id)!.tags).toEqual(['重要'])
    expect(byId.get(a.id)!.note).toBe('别丢')
    expect(byId.get(a.id)!.styles).toEqual(['侘寂'])
  })
})

describe('设置页入口守卫：强制重扫可用性不依赖备份，恢复依赖备份', () => {
  const codeOnly = (): string =>
    fs
      .readFileSync(new URL('../src/renderer/components/SettingsDialog.tsx', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('强制重扫按钮存在，且**不**受 rescanBackupCount 限制（它是清空路径）', () => {
    const code = codeOnly()
    expect(code).toContain('强制重扫')
    expect(code).toContain('onClick={() => void openForceRescan()}')
    // 只有"恢复"按钮按备份条数禁用；强制重扫只按 busy 禁用
    const gatedByBackup = code.match(/disabled=\{rescanBackupCount === 0/g) ?? []
    expect(gatedByBackup).toHaveLength(1)
    expect(code).toContain('disabled={rescanBackupCount === 0 || restoreBusy}')
    expect(code).toContain('disabled={forceBusy}')
  })

  it('二次确认必须：勾选后才可确认，且写明会丢什么 / 已自动备份', () => {
    const code = codeOnly()
    expect(code).toContain('disabled={!forceAck}')
    expect(code).toContain('标签 / 备注 / 风格会丢失')
    expect(code).toContain('自动备份')
    expect(code).toContain('恢复上次重扫前索引')
    // 确认按钮必须是危险样式（视觉上与普通按钮区分）
    expect(code).toContain('btn-outline-danger')
  })
})

describe('换库不再自动重扫（源码守卫，参照 kindFolderWiring.test.ts）', () => {
  const src = (): string =>
    fs.readFileSync(new URL('../src/renderer/components/ImportQueue.tsx', import.meta.url), 'utf-8')

  /** 去掉注释后再断言（注释里允许出现"不要调 rescan()"这类说明文字） */
  const codeOnly = (): string =>
    src()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('changeLibrary 只刷新设置快照 + 提示，不调用 rescan()', () => {
    const code = codeOnly()
    // 不得再从 store 取 rescan action
    expect(code).not.toMatch(/const rescan = useVault/)
    // 不得调用 rescan（含 void rescan()）
    expect(code).not.toMatch(/\brescan\s*\(/)
    // 必须给用户可行动指引（设置页的重扫入口）
    expect(code).toContain('重新扫描')
    expect(code).toContain('旧索引仍保留')
    expect(code).toContain('saveSettings')
  })
})
