/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/DOM lib）。
// `Window.modvault` 的真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效），
// 这里补一个测试用的类型声明（与 storeFlow.test.ts / marks.test.ts 同套路）。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { normalizeSettings } from '../src/main/settings'
import { DEFAULT_FILTERS, type Filters } from '../src/renderer/logic/filters'

/**
 * 2026-10 侧栏精简 + 筛选位置调整：
 *
 * ① 侧栏删掉「SU 版本」「来源」两组（筛选状态仍是合法输入，只是没有 UI 入口）；
 * ② 「整理」组（收藏 / 色标 / 重复资产）收进设置，可独立开关；
 * ③ 「快速筛选」（体积 / 导入时间）从中栏移到中栏头（排序胶囊左侧）。
 *
 * 覆盖三层：
 * - 设置层：三个开关默认 true、脏值降级不拖垮整份设置；
 * - store 层：关闭入口时**顺带重置**对应筛选（避免"筛选生效但入口看不到"的死角）；
 * - 源码守卫：侧栏不再出现两组标题与快速筛选块、中栏头确实渲染了体积/时间按钮。
 */

// ── 设置层 ──────────────────────────────────────────────────────

describe('侧栏显示开关（Settings）', () => {
  it('三个开关默认 true（旧档缺键 = 与旧版本行为一致）', () => {
    expect(DEFAULT_SETTINGS.showFavorites).toBe(true)
    expect(DEFAULT_SETTINGS.showColorTags).toBe(true)
    expect(DEFAULT_SETTINGS.showDuplicates).toBe(true)

    const normalized = normalizeSettings({ libraryDir: 'E:\\Lib' })
    expect(normalized.showFavorites).toBe(true)
    expect(normalized.showColorTags).toBe(true)
    expect(normalized.showDuplicates).toBe(true)
  })

  it('显式关闭被保留', () => {
    const s = normalizeSettings({
      libraryDir: 'E:\\Lib',
      showFavorites: false,
      showColorTags: false,
      showDuplicates: false
    })
    expect(s.showFavorites).toBe(false)
    expect(s.showColorTags).toBe(false)
    expect(s.showDuplicates).toBe(false)
  })

  it('脏值（"yes" / 1 / 0）降级为 true，且不拖垮整份设置（libraryDir 仍在）', () => {
    const dirty = {
      libraryDir: 'E:\\Lib',
      showFavorites: 'yes',
      showColorTags: 1,
      showDuplicates: 0
    } as unknown as Partial<Settings>
    const s = normalizeSettings(dirty)
    expect(s.showFavorites).toBe(true)
    expect(s.showColorTags).toBe(true)
    expect(s.showDuplicates).toBe(true)
    expect(s.libraryDir).toBe('E:\\Lib')
  })
})

// ── store 层：关闭入口 → 重置对应筛选 ────────────────────────────

let stored: Settings = { ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib' }

const modvault = {
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0),
  setSettings: vi.fn(async (patch: Partial<Settings>) => {
    stored = { ...stored, ...patch }
    return stored
  })
}

// 必须在动态 import store 之前把 window 桩装好（store 的 action 执行期才访问它）
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
Object.defineProperty(db, 'assets', {
  value: {
    put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => 0),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

function filters(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

beforeEach(() => {
  stored = { ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib' }
  vi.clearAllMocks()
  useVault.setState({
    filters: { ...DEFAULT_FILTERS },
    dupOnly: false,
    settings: { ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib' }
  })
})

describe('store：关闭侧栏入口时重置对应筛选维度', () => {
  it('关闭「收藏」→ favoriteOnly 重置为 false，其余维度原样保留', async () => {
    useVault.setState({
      filters: filters({ favoriteOnly: true, kind: 'model', category1: '家具', styles: ['现代'] })
    })
    await useVault.getState().saveSettings({ showFavorites: false })

    const f = useVault.getState().filters
    expect(f.favoriteOnly).toBe(false)
    // 只清被隐藏的那一个维度，不要顺手清掉分类 / 风格
    expect(f.kind).toBe('model')
    expect(f.category1).toBe('家具')
    expect(f.styles).toEqual(['现代'])
  })

  it('关闭「色标」→ colorTags 清空', async () => {
    useVault.setState({ filters: filters({ colorTags: ['red', 'blue'] }) })
    await useVault.getState().saveSettings({ showColorTags: false })
    expect(useVault.getState().filters.colorTags).toEqual([])
  })

  it('关闭「重复资产」→ dupOnly 重置为 false', async () => {
    useVault.setState({ dupOnly: true })
    await useVault.getState().saveSettings({ showDuplicates: false })
    expect(useVault.getState().dupOnly).toBe(false)
  })

  it('开关仍为 true 时不动筛选（收藏保持生效）', async () => {
    useVault.setState({ filters: filters({ favoriteOnly: true }) })
    await useVault.getState().saveSettings({ showFavorites: true })
    expect(useVault.getState().filters.favoriteOnly).toBe(true)
  })

  it('只关一个入口不会误清另一个入口的筛选', async () => {
    useVault.setState({
      filters: filters({ favoriteOnly: true, colorTags: ['red'] }),
      dupOnly: true
    })
    await useVault.getState().saveSettings({ showDuplicates: false })
    const f = useVault.getState().filters
    expect(f.favoriteOnly).toBe(true)
    expect(f.colorTags).toEqual(['red'])
    expect(useVault.getState().dupOnly).toBe(false)
  })
})

// ── 源码守卫（组件本身测不了，守契约防回退）─────────────────────

describe('源码守卫：侧栏精简 / 中栏头新增快速筛选', () => {
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

  it('Sidebar 不再包含「SU 版本」「来源」两组标题字面量', () => {
    const src = read('../src/renderer/components/Sidebar.tsx')
    expect(src).not.toContain('SU 版本')
    expect(src).not.toContain('来源')
    // 筛选能力本身保留（Filter 状态与「全部」重置里仍有这两个键）
    expect(src).toContain('suVersion')
    expect(src).toContain('source')
  })

  it('Sidebar 不再包含「快速筛选」整块', () => {
    const src = read('../src/renderer/components/Sidebar.tsx')
    expect(src).not.toContain('快速筛选')
    expect(src).not.toContain('SIZE_PRESET_BYTES')
    expect(src).not.toContain('TIME_PRESET_LABEL')
  })

  it('App 中栏头渲染体积 / 时间按钮，并复用 describeNumericFilters 做摘要', () => {
    const src = read('../src/renderer/App.tsx')
    expect(src).toContain('SIZE_QUICK_OPTIONS')
    expect(src).toContain('TIME_QUICK_OPTIONS')
    expect(src).toContain('toggleQuickPanel')
    expect(src).toContain('体积')
    expect(src).toContain('时间')
    expect(src).toContain('describeNumericFilters')
    // 浮层用 fixed 定位，避免被中栏滚动区裁切。
    // 2026-10-21：色标面板要按 tab 换宽度（P2⑨ 色点放大），className 从字符串字面量
    // 改成了模板字符串，所以断言不再钉在 `className="` 上——只钉「fixed z-40 同时出现」，
    // 这才是这条守卫真正要防的东西（浮层退化成 absolute 会被裁）。
    expect(src).toMatch(/fixed z-40/)
  })

  it('体积 / 时间按钮只出现在非文件视图分支（与排序胶囊同口径隐藏）', () => {
    const src = read('../src/renderer/App.tsx')
    const folderBranch = src.indexOf('folderAsset ? (')
    const quickGroup = src.indexOf('ref={quickRef}')
    const sortPill = src.indexOf('rounded-pill-header')
    expect(folderBranch).toBeGreaterThan(-1)
    expect(quickGroup).toBeGreaterThan(folderBranch)
    expect(sortPill).toBeGreaterThan(quickGroup)
  })
})
