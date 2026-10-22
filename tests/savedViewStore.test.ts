/// <reference lib="dom" />
// ↑ 本文件走 tsconfig.node（tests/**）：renderer 源码用到 `window`，所以要把 DOM lib 挂进来。
//   `Window.modvault` 的真实声明在 src/renderer/env.d.ts（只对 tsconfig.web 生效），
//   这里按 storeFlow.test.ts 的同样做法补一份（否则 typecheck:node 在 store.ts 报错）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type SavedView, type Settings } from '../src/shared/types'
import { DEFAULT_FILTERS } from '../src/renderer/logic/filters'

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

/**
 * 智能集合的 **store 级** 验收（0.6.0）：
 * - `saveCurrentView` 的三条拒绝规则（空名 / 重名 / 上限）与成功写入；
 * - `applySavedView` **整组替换** filters（不残留上一条视图的条件）；
 * - `deleteSavedView` 只改 settings.savedViews，不碰任何资产。
 *
 * 边界桩：只有 `window.modvault.setSettings`（写 settings 的唯一出口）。
 * 这些 action 完全不碰 Dexie，所以不需要 db 桩。
 */
const setSettings = vi.fn()

;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault: { setSettings } as unknown as ModVaultApi
}

const { useVault, SAVED_VIEW_LIMIT } = await import('../src/renderer/store')

/** 与 main/settings.ts 的语义一致：合并补丁后返回**完整** Settings */
function merged(patch: Partial<Settings>): Settings {
  const cur = useVault.getState().settings ?? DEFAULT_SETTINGS
  return { ...cur, ...patch }
}

function viewAt(index: number): SavedView {
  return {
    id: `seed-${index}`,
    name: `集合${index}`,
    filters: { kind: 'model' },
    sort: 'recent',
    createdAt: index
  }
}

beforeEach(() => {
  setSettings.mockReset()
  setSettings.mockImplementation(async (patch: Partial<Settings>) => merged(patch))
  useVault.setState({
    settings: { ...DEFAULT_SETTINGS, savedViews: [] },
    filters: { ...DEFAULT_FILTERS },
    dupOnly: false,
    assets: [],
    notice: null
  })
})

describe('saveCurrentView', () => {
  it('保存当前 filters + sort（纯数据快照）', async () => {
    useVault.setState({
      filters: {
        ...DEFAULT_FILTERS,
        kind: 'texture',
        category1: '沙发',
        minResolution: '4k',
        sort: 'size'
      }
    })

    const res = await useVault.getState().saveCurrentView('  4K 沙发贴图  ')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const saved = useVault.getState().settings?.savedViews ?? []
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('4K 沙发贴图') // 首尾空白被去掉
    expect(saved[0].sort).toBe('size')
    expect(saved[0].filters).toMatchObject({
      kind: 'texture',
      category1: '沙发',
      minResolution: '4k',
      sort: 'size'
    })
    expect(typeof saved[0].id).toBe('string')
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(useVault.getState().notice).toContain('4K 沙发贴图')
  })

  it('空名字 → 拒绝（empty-name）', async () => {
    const res = await useVault.getState().saveCurrentView('   ')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('empty-name')
    expect(setSettings).not.toHaveBeenCalled()
    expect(useVault.getState().settings?.savedViews).toHaveLength(0)
  })

  it('重名 → 拒绝（duplicate），比较前先去掉首尾空白', async () => {
    useVault.setState({
      settings: { ...DEFAULT_SETTINGS, savedViews: [{ ...viewAt(1), name: '常用' }] }
    })

    const res = await useVault.getState().saveCurrentView(' 常用 ')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('duplicate')
    expect(setSettings).not.toHaveBeenCalled()
  })

  it(`上限 ${SAVED_VIEW_LIMIT} 条：再多一条被拒绝（limit）`, async () => {
    const full = Array.from({ length: SAVED_VIEW_LIMIT }, (_, i) => viewAt(i))
    useVault.setState({ settings: { ...DEFAULT_SETTINGS, savedViews: full } })

    const res = await useVault.getState().saveCurrentView('再来一个')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('limit')
    expect(setSettings).not.toHaveBeenCalled()
  })
})

describe('applySavedView', () => {
  it('整组替换 filters：上一条视图的条件不残留', async () => {
    // 先套一条「贴图 + 沙发 + 4K + 收藏 + 搜索词 + 按大小」
    useVault.getState().applySavedView({
      id: 'a',
      name: 'A',
      createdAt: 0,
      sort: 'size',
      filters: {
        kind: 'texture',
        category1: '沙发',
        category2: '布艺',
        tag: '奶油',
        query: '椅子',
        minResolution: '4k',
        minBytes: 50,
        favoriteOnly: true,
        styles: ['侘寂风']
      }
    })
    const afterA = useVault.getState().filters
    expect(afterA.category1).toBe('沙发')
    expect(afterA.minResolution).toBe('4k')
    expect(afterA.sort).toBe('size')

    // 再套一条只筛「模型」的视图
    useVault.getState().applySavedView({
      id: 'b',
      name: 'B',
      createdAt: 1,
      filters: { kind: 'model' }
    })
    const afterB = useVault.getState().filters
    expect(afterB).toEqual({ ...DEFAULT_FILTERS, kind: 'model' })
    expect(afterB.category1).toBeNull()
    expect(afterB.category2).toBeNull()
    expect(afterB.tag).toBeNull()
    expect(afterB.query).toBe('')
    expect(afterB.minResolution).toBeNull()
    expect(afterB.minBytes).toBeNull()
    expect(afterB.favoriteOnly).toBe(false)
    expect(afterB.styles).toEqual([])
    expect(afterB.sort).toBe('recent')
  })

  it('套用视图会退出「重复资产」视图（视图模式不属于筛选快照）', () => {
    useVault.setState({ dupOnly: true })
    useVault.getState().applySavedView({
      id: 'c',
      name: 'C',
      createdAt: 0,
      filters: { minResolution: '2k' }
    })
    expect(useVault.getState().dupOnly).toBe(false)
    expect(useVault.getState().filters.minResolution).toBe('2k')
  })
})

describe('deleteSavedView', () => {
  it('按 id 删除，只改 settings.savedViews', async () => {
    const list = [viewAt(1), viewAt(2), viewAt(3)]
    useVault.setState({ settings: { ...DEFAULT_SETTINGS, savedViews: list }, assets: [] })

    const ok = await useVault.getState().deleteSavedView('seed-2')
    expect(ok).toBe(true)
    const left = useVault.getState().settings?.savedViews ?? []
    expect(left.map((v) => v.id)).toEqual(['seed-1', 'seed-3'])
    // 资产完全没被触碰（删的是视图，不是资产）
    expect(useVault.getState().assets).toEqual([])
    expect(useVault.getState().filters).toEqual(DEFAULT_FILTERS)
  })

  it('id 不存在 → 返回 false 且不写 settings', async () => {
    expect(await useVault.getState().deleteSavedView('nope')).toBe(false)
    expect(setSettings).not.toHaveBeenCalled()
  })
})
