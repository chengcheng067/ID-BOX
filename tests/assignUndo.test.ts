/// <reference lib="dom" />
// ↑ 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, AssignCategoryPayload } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import { ASSIGN_GRACE_MS } from '../src/renderer/logic/dragAssign'

/**
 * 反馈 6d「拖拽归类 + 5 秒撤销」的 **store 行为**单测。
 *
 * 测的是真实 store action（`assignCategoryWithUndo` / `undoAssign` / `commitAssign`），
 * 只 stub 两个边界（`window.modvault` IPC 与 Dexie `db.assets`），与 `storeFlow.test.ts` 同套路。
 *
 * 关键验收点：
 * ① 全部已在目标分类 → **不发 IPC、不弹撤销条**；
 * ② 撤销按**原分类对**分组搬回（不是一股脑搬到一个分类）；
 * ③ 撤销失败必须给提示（不能静默）；
 * ④ 归类失败（IPC 全 null）不弹撤销条。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  assignCategory: vi.fn(),
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0)
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const bulkPutCalls: Asset[][] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

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
    relFolder: `模型/未分类/未分类/资产${n}`,
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [{ rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }],
    size: 20,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    ...over
  }
}

/** IPC 成功回包：按 payload 算出「落盘后」的 folder / relFolder（模拟 main 的 moveAssetCategory） */
function assignOk(p: AssignCategoryPayload): {
  folder: string
  name: string
  relFolder: string
  category1: string
  category2: string
  moved: boolean
  renamed: boolean
  changed: boolean
} {
  const name = p.folder.split('\\').pop() ?? '资产'
  return {
    folder: `${p.folder}__moved`,
    name,
    relFolder: `${p.kindFolderName}/${p.category1}/${p.category2}/${name}`,
    category1: p.category1,
    category2: p.category2,
    moved: true,
    renamed: false,
    changed: false
  }
}

beforeEach(() => {
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  modvault.assignCategory.mockReset()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  useVault.setState({
    assets: [],
    pendingDelete: null,
    pendingAssign: null,
    notice: null,
    selectedId: null,
    selectedIds: []
  })
})

describe('assignCategoryWithUndo · 拖拽归类', () => {
  it('归类成功 → 真实调 IPC，并登记 5 秒撤销（快照原分类）', async () => {
    const a = fixture({ category1: '家具', category2: '沙发' })
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))

    const summary = await useVault.getState().assignCategoryWithUndo([a.id, b.id], '家具', '椅子')

    expect(summary.moved).toBe(2)
    expect(modvault.assignCategory).toHaveBeenCalledTimes(2)
    // 目标分类必须落到 IPC 载荷里（父目录由 kind 算，这里只断言分类段）
    for (const call of modvault.assignCategory.mock.calls) {
      expect(call[0]).toMatchObject({ category1: '家具', category2: '椅子', kindFolderName: '模型' })
    }

    const pending = useVault.getState().pendingAssign
    expect(pending).not.toBeNull()
    expect(pending!.graceMs).toBe(ASSIGN_GRACE_MS)
    expect(pending!.moved).toBe(2)
    expect(pending!.label).toBe('家具 / 椅子')
    // 快照是归类**之前**的值
    expect(pending!.records).toEqual([
      { id: a.id, category1: '家具', category2: '沙发' },
      { id: b.id, category1: UNCLASSIFIED, category2: UNCLASSIFIED }
    ])
  })

  it('全部资产已在目标分类 → 不发 IPC、不弹撤销条（口径：静默）', async () => {
    const a = fixture({ category1: '家具', category2: '沙发' })
    const b = fixture({ category1: '家具', category2: '沙发' })
    useVault.setState({ assets: [a, b], notice: null })

    const summary = await useVault.getState().assignCategoryWithUndo([a.id, b.id], '家具', '沙发')

    expect(summary.moved).toBe(0)
    expect(summary.skipped).toBe(2)
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(useVault.getState().pendingAssign).toBeNull()
    expect(useVault.getState().notice).toBeNull()
  })

  it('归类全部失败（IPC 返回 null）→ 不弹撤销条，但必须有失败提示', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(null)

    const summary = await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')

    expect(summary.moved).toBe(0)
    expect(summary.failed).toBe(1)
    expect(useVault.getState().pendingAssign).toBeNull()
    expect(useVault.getState().notice ?? '').toContain('失败')
  })
})

describe('undoAssign · 5 秒内撤销', () => {
  it('按原分类对分组搬回（两个资产来自不同分类 → 两次 IPC，各回各家）', async () => {
    const a = fixture({ category1: '家具', category2: '沙发' })
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))

    await useVault.getState().assignCategoryWithUndo([a.id, b.id], '家具', '椅子')
    modvault.assignCategory.mockClear()

    await useVault.getState().undoAssign()

    expect(modvault.assignCategory).toHaveBeenCalledTimes(2)
    const pairs = modvault.assignCategory.mock.calls.map((c) => {
      const p = c[0] as AssignCategoryPayload
      return `${p.category1}/${p.category2}`
    })
    expect(pairs.sort()).toEqual([`${UNCLASSIFIED}/${UNCLASSIFIED}`, '家具/沙发'].sort())
    // 撤销条已关闭，且有明确成功提示
    expect(useVault.getState().pendingAssign).toBeNull()
    expect(useVault.getState().notice ?? '').toContain('已撤销归类')
  })

  it('撤销失败必须提示（不能静默）', async () => {
    const a = fixture({ category1: '家具', category2: '沙发' })
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))
    await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')

    modvault.assignCategory.mockResolvedValue(null)
    await useVault.getState().undoAssign()

    expect(useVault.getState().notice ?? '').toMatch(/撤销归类失败/)
    expect(useVault.getState().pendingAssign).toBeNull()
  })

  it('重复点撤销 / 到期后再点：只执行一次（状态已清即早退）', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))
    await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')

    modvault.assignCategory.mockClear()
    await useVault.getState().undoAssign()
    await useVault.getState().undoAssign()

    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)
  })

  it('commitAssign（倒计时归零）只清状态，不做任何磁盘动作', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))
    await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')

    modvault.assignCategory.mockClear()
    useVault.getState().commitAssign()

    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(useVault.getState().pendingAssign).toBeNull()
  })

  it('到期回调必须比对 startedAt：旧批次的时间戳不能清新一批的撤销条', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))
    await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')

    const startedAt = useVault.getState().pendingAssign!.startedAt
    // 上一批倒计时的闭包拿着旧时间戳 → 必须被忽略
    useVault.getState().commitAssign(startedAt - 1)
    expect(useVault.getState().pendingAssign).not.toBeNull()
    // 同一批才允许清
    useVault.getState().commitAssign(startedAt)
    expect(useVault.getState().pendingAssign).toBeNull()
  })

  it('连续两次归类：后一批覆盖前一批的撤销记录（只有最近一次可撤销）', async () => {
    const a = fixture()
    const b = fixture()
    useVault.setState({ assets: [a, b] })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => assignOk(p))

    await useVault.getState().assignCategoryWithUndo([a.id], '家具', '椅子')
    await useVault.getState().assignCategoryWithUndo([b.id], '家具', '沙发')

    const pending = useVault.getState().pendingAssign!
    expect(pending.records.map((r) => r.id)).toEqual([b.id])
    expect(pending.label).toBe('家具 / 沙发')
  })
})
