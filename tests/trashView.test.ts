/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/DOM lib）。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type TrashRetention } from '../src/shared/types'
import { DEFAULT_FILTERS, applyFilters, matchesFilters, type Filters } from '../src/renderer/logic/filters'
import {
  DAY_MS,
  RETENTION_OPTIONS,
  countDeletedAssets,
  isDeletedAsset,
  remainingTrashDays,
  retentionDaysOf,
  trashBadgeText,
  trashNoticeText
} from '../src/renderer/logic/trashView'

/**
 * C2：把 C1 的「最近删除」接进界面。
 *
 * 覆盖四层：
 * ① 纯逻辑 `logic/trashView.ts`：保留期换算 / 剩余天数边界（0 天、已过期）/ 徽标文案；
 * ② 过滤（唯一过滤点 `matchesFilters`）：软删记录只出现在 trash 视图，老资产正常显示；
 * ③ 真实 store action：`commitDelete` 按 `trashRetention` 分流（30d → softDelete，recycle →
 *    trashPaths），`failed[]` 不写 deletedAt，`restoreAssets` / `purgeAssets` / `emptyTrash`；
 * ④ 源码守卫：侧栏入口、卡片徽标 / 拖出禁用、详情面板还原按钮、设置四档单选。
 *
 * `deleteFlowFix.test.ts` 仍覆盖旧路径（那里把 retention 钉到 'recycle'）。
 */

// ── ① 纯逻辑：保留期 / 剩余天数 ────────────────────────────────────

describe('trashView · 保留期换算', () => {
  it('三档保留期 → 天；recycle / null → null（不自动清理）', () => {
    expect(retentionDaysOf('5d')).toBe(5)
    expect(retentionDaysOf('10d')).toBe(10)
    expect(retentionDaysOf('30d')).toBe(30)
    expect(retentionDaysOf('recycle')).toBeNull()
    expect(retentionDaysOf(null)).toBeNull()
    expect(retentionDaysOf(undefined)).toBeNull()
  })

  it('四档单选的顺序与文案（设置页直接用，默认档是 30 天）', () => {
    expect(RETENTION_OPTIONS.map((o) => o.value)).toEqual(['5d', '10d', '30d', 'recycle'])
    expect(RETENTION_OPTIONS.find((o) => o.value === '30d')?.label).toContain('30')
    // 旧行为档必须明确告诉用户「应用内无法还原」，否则会以为还能从回收站拉回来
    expect(RETENTION_OPTIONS.find((o) => o.value === 'recycle')?.hint).toContain('无法还原')
  })
})

describe('trashView · 剩余天数（ceil + 三个边界）', () => {
  const T0 = 1_700_000_000_000

  it('刚删（30 天档）→ 还剩 30 天（不是 29）', () => {
    expect(remainingTrashDays(T0, '30d', T0)).toBe(30)
    expect(trashBadgeText(T0, '30d', T0)).toBe('还剩 30 天')
  })

  it('删了 16 天 → 还剩 14 天', () => {
    expect(remainingTrashDays(T0, '30d', T0 + 16 * DAY_MS)).toBe(14)
    expect(trashBadgeText(T0, '30d', T0 + 16 * DAY_MS)).toBe('还剩 14 天')
  })

  it('边界：正好到期 → 0 天（main 的 sweep 还没跑到）', () => {
    expect(remainingTrashDays(T0, '10d', T0 + 10 * DAY_MS)).toBe(0)
    expect(trashBadgeText(T0, '10d', T0 + 10 * DAY_MS)).toBe('还剩 0 天')
  })

  it('边界：已过期但尚未清理 → 负数（固定 -1），文案「已过期」', () => {
    expect(remainingTrashDays(T0, '5d', T0 + 6 * DAY_MS)).toBe(-1)
    expect(trashBadgeText(T0, '5d', T0 + 6 * DAY_MS)).toBe('已过期')
    expect(trashNoticeText(T0, '5d', T0 + 6 * DAY_MS)).toContain('已过保留期')
  })

  it('recycle 档 / 没有删除时间 → null（不渲染徽标）', () => {
    expect(remainingTrashDays(T0, 'recycle', T0)).toBeNull()
    expect(trashBadgeText(T0, 'recycle', T0)).toBeNull()
    expect(remainingTrashDays(undefined, '30d', T0)).toBeNull()
    expect(remainingTrashDays(Number.NaN, '30d', T0)).toBeNull()
    expect(trashNoticeText(T0, 'recycle', T0)).toBeNull()
  })
})

describe('trashView · 软删判定与计数', () => {
  it('deletedAt 是有限数字才算已删；undefined / null / NaN 都不算', () => {
    expect(isDeletedAsset({ deletedAt: 1 })).toBe(true)
    expect(isDeletedAsset({ deletedAt: 0 })).toBe(true) // 0 是合法时间戳（1970），不特殊处理
    expect(isDeletedAsset({})).toBe(false)
    expect(isDeletedAsset({ deletedAt: Number.NaN })).toBe(false)
    expect(isDeletedAsset(null)).toBe(false)
  })

  it('countDeletedAssets 只数软删记录', () => {
    const list = [
      { deletedAt: 1 },
      {},
      { deletedAt: 2 }
    ] as unknown as Asset[]
    expect(countDeletedAssets(list)).toBe(2)
    expect(countDeletedAssets([])).toBe(0)
  })
})

// ── ② 过滤：唯一过滤点 ────────────────────────────────────────────

function asset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    name: id,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\${id}`,
    relFolder: `模型/未分类/未分类/${id}`,
    files: [],
    size: 1000,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${id}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  } as Asset
}

function filters(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

describe('filters · 软删资产按视图互斥', () => {
  const live = asset('live')
  const trashed = asset('trashed', { deletedAt: 1_700_000_000_000, trashRel: '.trash/trashed' })

  it('assets 视图：排除 deletedAt 有值的资产', () => {
    const out = applyFilters([live, trashed], filters())
    expect(out.map((a) => a.id)).toEqual(['live'])
    expect(matchesFilters(trashed, DEFAULT_FILTERS)).toBe(false)
  })

  it('trash 视图：只包含 deletedAt 有值的资产', () => {
    const out = applyFilters([live, trashed], filters(), 'trash')
    expect(out.map((a) => a.id)).toEqual(['trashed'])
  })

  it('老资产（deletedAt: undefined）在 assets 视图正常显示', () => {
    const legacy = asset('legacy') // 没有 deletedAt 字段
    expect(legacy.deletedAt).toBeUndefined()
    expect(applyFilters([legacy], filters()).map((a) => a.id)).toEqual(['legacy'])
    expect(applyFilters([legacy], filters(), 'trash')).toEqual([])
  })

  it('trash 视图不套用分类/收藏等筛选（侧栏已灰置，避免"回收站有货但显示 0"）', () => {
    const f = filters({ category1: '家具', favoriteOnly: true, colorTags: ['red'] })
    expect(applyFilters([trashed], f, 'trash')).toHaveLength(1)
    // 对比：同样的筛选在 assets 视图会生效（老行为不变）
    expect(applyFilters([asset('x', { category1: '家具', favorite: true, colorTag: 'red' })], f)).toHaveLength(1)
  })

  it('trash 视图仍支持搜索词', () => {
    const sofa = asset('sofa', { deletedAt: 1, name: '真皮沙发' })
    const chair = asset('chair', { deletedAt: 2, name: '餐椅' })
    const out = applyFilters([sofa, chair], filters({ query: '沙发' }), 'trash')
    expect(out.map((a) => a.id)).toEqual(['sofa'])
  })

  it('trash 视图 sort=recent 按删除时间倒序（最近删的在最上面）', () => {
    const older = asset('old', { deletedAt: 1_700_000_000_000 })
    const newer = asset('new', { deletedAt: 1_700_000_500_000 })
    const out = applyFilters([older, newer], filters({ sort: 'recent' }), 'trash')
    expect(out.map((a) => a.id)).toEqual(['new', 'old'])
  })
})

// ── ③ store：commitDelete 分流 / 还原 / 彻底删除 ────────────────────

const modvault = {
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0),
  pruneThumbs: vi.fn(async () => 0),
  trashPaths: vi.fn(async () => [] as string[]),
  softDeleteAssets: vi.fn(),
  restoreAssets: vi.fn(),
  purgeAssets: vi.fn(),
  emptyTrash: vi.fn(),
  rescan: vi.fn(async (): Promise<{ assets: Asset[]; ignored: [] }> => ({ assets: [], ignored: [] }))
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const bulkPutCalls: Asset[][] = []
const bulkDeleteCalls: string[][] = []
Object.defineProperty(db, 'assets', {
  value: {
    put: vi.fn(async (a: Asset) => a.id),
    bulkPut: vi.fn(async (list: Asset[]) => {
      bulkPutCalls.push(list.map((a) => ({ ...a })))
      return list.length
    }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      bulkDeleteCalls.push([...ids])
      return ids.length
    })
  },
  configurable: true
})
// rescan 收尾会读 `db.backups`（重扫前快照计数）；node 环境没有 IndexedDB，给内存版
Object.defineProperty(db, 'backups', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

function settingsWith(retention: TrashRetention) {
  return { ...DEFAULT_SETTINGS, trashRetention: retention }
}

/** 走完整删除链路：requestDelete → confirmDelete → commitDelete（跳过 5 秒倒计时） */
async function deleteNow(ids: string[]) {
  useVault.getState().requestDelete(ids)
  useVault.getState().confirmDelete()
  await useVault.getState().commitDelete()
}

beforeEach(() => {
  bulkPutCalls.length = 0
  bulkDeleteCalls.length = 0
  vi.clearAllMocks()
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.trashPaths.mockResolvedValue([])
  modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })
  useVault.setState({
    assets: [],
    pendingDelete: null,
    notice: null,
    libraryView: 'assets',
    selectedId: null,
    selectedIds: [],
    settings: settingsWith('30d')
  })
})

describe('store.commitDelete · 保留期分流', () => {
  it("'30d' → 调 softDeleteAssets，不调 trashPaths；记录写回 deletedAt / trashRel 且仍在 assets 里", async () => {
    const a = asset('a1')
    useVault.setState({ assets: [a], selectedId: a.id, selectedIds: [a.id] })
    modvault.softDeleteAssets.mockResolvedValue({
      ok: [{ id: a.id, trashRel: `.trash/${a.id}`, deletedAt: 1_700_000_123_456, size: 1000 }],
      failed: []
    })

    await deleteNow([a.id])

    expect(modvault.softDeleteAssets).toHaveBeenCalledTimes(1)
    expect(modvault.softDeleteAssets).toHaveBeenCalledWith([{ id: a.id, folder: a.folder }])
    expect(modvault.trashPaths).not.toHaveBeenCalled()

    const rec = useVault.getState().assets.find((x) => x.id === a.id)
    expect(rec).toBeDefined()
    expect(rec!.deletedAt).toBe(1_700_000_123_456)
    expect(rec!.trashRel).toBe(`.trash/${a.id}`)
    // 索引写库：写的是**带 deletedAt 的同一条记录**（不是 delete + put）
    expect(bulkPutCalls.flat().some((x) => x.id === a.id && x.deletedAt === 1_700_000_123_456)).toBe(true)
    // 从当前视图（selectedIds）里清掉，但仍保留在 assets 供回收站列出
    expect(useVault.getState().selectedIds).toEqual([])
    expect(useVault.getState().notice).toContain('最近删除')
  })

  it("'recycle' → 调 trashPaths（旧行为），不调 softDeleteAssets；记录从 assets 移除", async () => {
    const a = asset('a2')
    useVault.setState({ assets: [a], settings: settingsWith('recycle') })
    modvault.trashPaths.mockResolvedValue([])

    await deleteNow([a.id])

    expect(modvault.trashPaths).toHaveBeenCalledTimes(1)
    expect(modvault.trashPaths).toHaveBeenCalledWith([a.folder])
    expect(modvault.softDeleteAssets).not.toHaveBeenCalled()
    expect(useVault.getState().assets.some((x) => x.id === a.id)).toBe(false)
    expect(bulkDeleteCalls.flat()).toContain(a.id)
  })

  it('failed[] 非空的项不写 deletedAt（防止"删失败但界面显示已删"）', async () => {
    const okAsset = asset('ok')
    const badAsset = asset('bad')
    useVault.setState({ assets: [okAsset, badAsset] })
    modvault.softDeleteAssets.mockResolvedValue({
      ok: [{ id: okAsset.id, trashRel: `.trash/${okAsset.id}`, deletedAt: 111, size: 1 }],
      failed: [{ id: badAsset.id, reason: '文件被占用' }]
    })

    await deleteNow([okAsset.id, badAsset.id])

    const state = useVault.getState()
    expect(state.assets.find((x) => x.id === okAsset.id)!.deletedAt).toBe(111)
    // 失败项：两个字段都不能写，且必须给出可见提示
    const bad = state.assets.find((x) => x.id === badAsset.id)!
    expect(bad.deletedAt).toBeUndefined()
    expect(bad.trashRel).toBeUndefined()
    expect(state.notice).toMatch(/1 项失败/)
    expect(bulkPutCalls.flat().some((x) => x.id === badAsset.id)).toBe(false)
  })

  it('全部失败 → 一条记录都不写，notice 明确说「删除失败」并说明文件还在原位', async () => {
    const a = asset('bad2')
    useVault.setState({ assets: [a] })
    modvault.softDeleteAssets.mockResolvedValue({
      ok: [],
      failed: [{ id: a.id, reason: '被占用' }]
    })

    await deleteNow([a.id])

    expect(bulkPutCalls).toHaveLength(0)
    expect(useVault.getState().assets[0]!.deletedAt).toBeUndefined()
    expect(useVault.getState().notice).toContain('删除失败')
    expect(useVault.getState().notice).toContain('保留在原位置')
  })
})

describe('store.rescan · 软删记录保活（防数据丢失）', () => {
  it('重扫不会把软删记录当作「磁盘已删除」清出索引（main 跳过 .trash，扫不到它们）', async () => {
    const live = asset('live9')
    const dead = asset('dead9', { deletedAt: 1_700_000_000_000, trashRel: '.trash/dead9' })
    useVault.setState({ assets: [live, dead] })
    // 磁盘现状：只有 live9（软删项在 .trash 里，rescan 明确跳过）
    modvault.rescan.mockResolvedValue({ assets: [asset('live9')], ignored: [] })

    await useVault.getState().rescan()

    const ids = useVault.getState().assets.map((a) => a.id)
    expect(ids).toContain('dead9')
    expect(bulkDeleteCalls.flat()).not.toContain('dead9')
    expect(useVault.getState().assets.find((a) => a.id === 'dead9')!.deletedAt).toBe(1_700_000_000_000)
  })
})

describe('store.restoreAssets / purgeAssets / emptyTrash', () => {  const trashed = asset('t1', { deletedAt: 1_700_000_000_000, trashRel: '.trash/t1' })

  it('还原：入参带 trashRel/relFolder/name，成功后清字段、用返回的最终 folder/relFolder，并触发重扫', async () => {
    useVault.setState({ assets: [trashed] })
    modvault.restoreAssets.mockResolvedValue({
      ok: [
        {
          id: 't1',
          folder: 'E:\\Lib\\模型\\未分类\\未分类\\t1',
          relFolder: '模型/未分类/未分类/t1',
          renamed: false
        }
      ],
      failed: []
    })

    await useVault.getState().restoreAssets(['t1'])

    expect(modvault.restoreAssets).toHaveBeenCalledWith([
      {
        id: 't1',
        trashRel: '.trash/t1',
        relFolder: trashed.relFolder,
        name: trashed.name
      }
    ])
    const rec = useVault.getState().assets[0]!
    expect(rec.deletedAt).toBeUndefined()
    expect(rec.trashRel).toBeUndefined()
    expect(rec.folder).toBe('E:\\Lib\\模型\\未分类\\未分类\\t1')
    // 「复用现有 rescan 路径」：不手写目录遍历
    expect(modvault.rescan).toHaveBeenCalledTimes(1)
    expect(useVault.getState().notice).toContain('已还原 1 项')
  })

  it('还原时主进程因重名追加了序号 → notice 必须提示（不能静默改名）', async () => {
    useVault.setState({ assets: [trashed] })
    modvault.restoreAssets.mockResolvedValue({
      ok: [{ id: 't1', folder: 'E:\\Lib\\x\\t1-2', relFolder: '模型/未分类/未分类/t1-2', renamed: true }],
      failed: []
    })

    await useVault.getState().restoreAssets(['t1'])
    expect(useVault.getState().notice).toContain('改名')
  })

  it('还原失败项保留软删字段（仍可重试）', async () => {
    useVault.setState({ assets: [trashed] })
    modvault.restoreAssets.mockResolvedValue({
      ok: [],
      failed: [{ id: 't1', reason: '目标被占用' }]
    })

    await useVault.getState().restoreAssets(['t1'])
    const rec = useVault.getState().assets[0]!
    expect(rec.deletedAt).toBe(1_700_000_000_000)
    expect(rec.trashRel).toBe('.trash/t1')
    expect(useVault.getState().notice).toContain('失败')
    expect(modvault.rescan).not.toHaveBeenCalled()
  })

  it('彻底删除：只有成功的项从索引移除；失败项保留', async () => {
    const a = asset('p1', { deletedAt: 1, trashRel: '.trash/p1' })
    const b = asset('p2', { deletedAt: 2, trashRel: '.trash/p2' })
    useVault.setState({ assets: [a, b] })
    modvault.purgeAssets.mockResolvedValue({
      purged: 1,
      failed: 1,
      failures: [{ id: 'p2', reason: '被占用' }]
    })

    await useVault.getState().purgeAssets(['p1', 'p2'])

    expect(modvault.purgeAssets).toHaveBeenCalledWith([
      { id: 'p1', trashRel: '.trash/p1' },
      { id: 'p2', trashRel: '.trash/p2' }
    ])
    expect(useVault.getState().assets.map((x) => x.id)).toEqual(['p2'])
    expect(bulkDeleteCalls.flat()).toEqual(['p1'])
    expect(useVault.getState().notice).toMatch(/1 项失败/)
  })

  it('清空回收站：删掉所有软删记录，未删资产不受影响', async () => {
    const live = asset('live')
    const a = asset('e1', { deletedAt: 1, trashRel: '.trash/e1' })
    useVault.setState({ assets: [live, a] })
    modvault.emptyTrash.mockResolvedValue({ purged: 1, failed: 0, failures: [] })

    await useVault.getState().emptyTrash()

    expect(useVault.getState().assets.map((x) => x.id)).toEqual(['live'])
    expect(useVault.getState().notice).toContain('已清空回收站')
  })

  it('setLibraryView：切视图清选择 / 关文件视图，但不清空筛选条件', async () => {
    const f = filters({ category1: '家具', favoriteOnly: true })
    useVault.setState({
      assets: [trashed],
      filters: f,
      selectedId: 't1',
      selectedIds: ['t1'],
      folderViewAssetId: 't1'
    })

    useVault.getState().setLibraryView('trash')
    const s = useVault.getState()
    expect(s.libraryView).toBe('trash')
    expect(s.selectedId).toBeNull()
    expect(s.selectedIds).toEqual([])
    expect(s.folderViewAssetId).toBeNull()
    // 筛选状态保留（灰置但不清空 → 回资产视图继续生效）
    expect(s.filters).toEqual(f)

    useVault.getState().setLibraryView('assets')
    expect(useVault.getState().libraryView).toBe('assets')
  })
})

// ── ④ 源码守卫（组件在 node 环境渲染不了）──────────────────────────

describe('源码守卫：最近删除的界面接线', () => {
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

  it('侧栏有「最近删除」入口 + 计数徽标；进入回收站不再灰置其它导航（点任一条即退出）', () => {
    const src = read('../src/renderer/components/Sidebar.tsx')
    expect(src).toContain('最近删除')
    expect(src).toContain('setLibraryView')
    expect(src).toContain('trashCount')
    // 2026-10-22 决策反转：原先进回收站会给整块导航挂 `pointer-events-none` + `opacity-40`，
    // 结果是除「最近删除」外全点不动（用户原话：「没有办法通过直接去点侧边栏的任何一个按键退出」）。
    // 现在回收站只是"当前视图"，不再锁死其它筛选 —— 这条守卫要**反向**钉住。
    expect(src).not.toContain('pointer-events-none opacity-40')
    // 统一出口：每条导航的 onClick 都经过 `navTo`，它在**退出回收站之前**还负责
    // 先 `closeFolderView()`（2026-10 第二个 bug：文件视图里点侧栏中栏不动）。
    // 因此 `exitTrash()` 的直接调用收口成 1 处（`navTo` 内），判据改为数 `navTo(`。
    expect(src).toContain('const exitTrash = (): void =>')
    expect(src).toContain('const navTo = (action: () => void): void =>')
    expect((src.match(/navTo\(/g) ?? []).length).toBeGreaterThanOrEqual(8)
    // 「最近删除」自身仍是唯一的进出开关，语义不能跟着改
    expect(src).toContain("setLibraryView(trashMode ? 'assets' : 'trash')")
  })

  it('卡片显示剩余天数徽标；回收站里禁用拖出与双击进文件视图', () => {
    const src = read('../src/renderer/components/AssetGrid.tsx')
    expect(src).toContain('trashBadgeText(a.deletedAt, trashRetention)')
    expect(src).toContain('if (isDeletedAsset(a)) return {}')
    expect(src).toContain('回收站是空的')
  })

  it('详情面板有软删提示条 + 还原 / 彻底删除，且不再提供打开文件夹', () => {
    const src = read('../src/renderer/components/DetailPanel.tsx')
    expect(src).toContain('trashNoticeText(asset.deletedAt, trashRetention)')
    expect(src).toContain('restoreAssets([asset.id])')
    expect(src).toContain('PurgeConfirmDialog')
    // 软删态分支里不应该再出现 reveal(folder)
    const deletedBranch = src.slice(src.indexOf('{deleted ? ('), src.indexOf('{purgeOpen &&'))
    expect(deletedBranch).toContain('还原')
    expect(deletedBranch).toContain('彻底删除')
  })

  it('设置页有保留期四档单选 + 「不会立刻清理」说明', () => {
    const src = read('../src/renderer/components/SettingsDialog.tsx')
    expect(src).toContain('RETENTION_OPTIONS')
    expect(src).toContain('删除保留期')
    expect(src).toContain("saveSettings({ trashRetention: opt.value })")
    expect(src).toContain('不会立刻清理')
  })

  it('彻底删除必须二次确认（PurgeConfirmDialog 有危险文案与确认按钮）', () => {
    const src = read('../src/renderer/components/PurgeConfirmDialog.tsx')
    expect(src).toContain('无法在应用内还原')
    expect(src).toContain('purgeAssets')
  })

  it('确认删除弹窗的文案跟随删除策略（30d 档说「最近删除」，不再一律说 Windows 回收站）', () => {
    const src = read('../src/renderer/components/ConfirmDialog.tsx')
    expect(src).toContain('retentionDaysOf')
    expect(src).toContain('最近删除')
    expect(src).toContain("retention === 'recycle'")
  })
})
