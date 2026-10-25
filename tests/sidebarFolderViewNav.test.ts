/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，renderer 源码依赖 DOM 全局（window），
// 这里补一个测试用的声明（与 storeFlow.test.ts / sidebarSlim.test.ts 同套路）。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import { DEFAULT_FILTERS } from '../src/renderer/logic/filters'

/**
 * 用户反馈（bug 2）：「在任何一个模型 / 材质文件里面，点侧边栏会有反应，
 * 但中心画布没有任何变化」。
 *
 * 根因：`App.tsx` 的中栏只要 `folderAsset` 非空就渲染文件视图（盖住网格），
 * 而侧栏所有导航 onClick 只改 `filters` / `libraryView`，从不 `closeFolderView()`。
 *
 * 本文件钉住三件事：
 * ① `runNavAction` 的**调用顺序**（先离开文件视图、后改筛选）；
 * ② 真实 store 回归：文件视图里点「模型」→ `folderViewAssetId === null` 且 `kind === 'model'`；
 * ③ 源码守卫：`Sidebar.tsx` 导航区**每一个**零参 `onClick` 都经过 `navTo` / `navToView`，
 *    且不存在裸的 `setFilter(...)` / `setLibraryView(...)` 直调。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0)
}

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
// 从组件文件导入纯函数内核（组件本身不在 node 里渲染；模块顶层没有 window 访问）
const { runNavAction } = await import('../src/renderer/components/Sidebar')

function fixture(patch: Partial<Asset> = {}): Asset {
  const id = patch.id ?? 'asset-1'
  return {
    id,
    name: '新中式现代餐桌椅',
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\${id}`,
    relFolder: `模型/未分类/未分类/${id}`,
    files: [],
    size: 10,
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
    ...patch
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useVault.setState({
    assets: [fixture()],
    filters: { ...DEFAULT_FILTERS },
    libraryView: 'assets',
    folderViewAssetId: null,
    dupOnly: false,
    selectedId: null,
    selectedIds: []
  })
})

// ── ① 纯逻辑：顺序契约 ────────────────────────────────────────────

describe('runNavAction —— 先关文件视图、再执行导航动作', () => {
  it('调用顺序是 closeFolderView → action（反了会出现"筛选已变但还盖着文件列表"的错帧）', () => {
    const calls: string[] = []
    runNavAction(
      () => calls.push('closeFolderView'),
      () => calls.push('action')
    )
    expect(calls).toEqual(['closeFolderView', 'action'])
  })

  it('动作抛错也不影响已经完成的"离开文件视图"（先执行的语义不变）', () => {
    const calls: string[] = []
    expect(() =>
      runNavAction(
        () => calls.push('closeFolderView'),
        () => {
          calls.push('action')
          throw new Error('boom')
        }
      )
    ).toThrow('boom')
    expect(calls).toEqual(['closeFolderView', 'action'])
  })
})

// ── ② 真实 store 回归 ──────────────────────────────────────────────

describe('文件视图里的导航：中栏必须离开文件视图', () => {
  it('在文件视图里点「模型」→ folderViewAssetId 清空 + filters.kind 变 model', () => {
    useVault.getState().openFolderView('asset-1')
    expect(useVault.getState().folderViewAssetId).toBe('asset-1')

    // 与 Sidebar 的 navTo 同构：closeFolderView 在前，筛选动作在后
    runNavAction(useVault.getState().closeFolderView, () =>
      useVault.getState().setFilter({ kind: 'model', category1: null, category2: null })
    )

    expect(useVault.getState().folderViewAssetId).toBeNull()
    expect(useVault.getState().filters.kind).toBe('model')
  })

  it('「最近删除」这类视图切换同样先离开文件视图', () => {
    useVault.getState().openFolderView('asset-1')
    runNavAction(useVault.getState().closeFolderView, () =>
      useVault.getState().setLibraryView('trash')
    )
    expect(useVault.getState().folderViewAssetId).toBeNull()
    expect(useVault.getState().libraryView).toBe('trash')
  })

  it('closeFolderView 幂等：未打开文件视图时调用不抛错、状态保持 null', () => {
    expect(() => useVault.getState().closeFolderView()).not.toThrow()
    expect(useVault.getState().folderViewAssetId).toBeNull()
  })
})

// ── ③ 源码守卫：所有导航入口收口到 navTo ──────────────────────────

describe('Sidebar 源码守卫：导航 onClick 必须经过 navTo / navToView', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

  it('导航区每个零参 onClick 的下几行内都出现 navTo/navToView', () => {
    const src = read('src/renderer/components/Sidebar.tsx')
    const start = src.indexOf('<nav')
    const end = src.indexOf('</nav>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const lines = src.slice(start, end).split('\n')

    const offenders: { line: number; text: string }[] = []
    lines.forEach((line, i) => {
      if (!/onClick=\{\(\) =>/.test(line)) return
      // 允许中间隔注释行（本项目每个入口上方都有一段说明）→ 从本行起看 5 行
      const around = lines.slice(i, i + 5).join('\n')
      if (!/navTo(?:View)?\(/.test(around)) offenders.push({ line: i + 1, text: line.trim() })
    })
    expect(offenders).toEqual([])
  })

  it('navTo/navToView 的调用次数与导航区零参 onClick 数一致（没有漏网的入口）', () => {
    const src = read('src/renderer/components/Sidebar.tsx')
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
    const onClickCount = (nav.match(/onClick=\{\(\) =>/g) ?? []).length
    const navToCount = (nav.match(/navTo\(/g) ?? []).length
    const navToViewCount = (nav.match(/navToView\(/g) ?? []).length
    expect(onClickCount).toBeGreaterThanOrEqual(10)
    expect(navToCount + navToViewCount).toBe(onClickCount)
  })

  it('导航区不出现裸的 setFilter / setLibraryView / applySavedView / setDupOnly 直调', () => {
    const src = read('src/renderer/components/Sidebar.tsx')
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'))
    expect(nav).not.toMatch(/onClick=\{\(\) =>\s*(setFilter|setLibraryView|applySavedView|setDupOnly)\(/)
  })

  it('全局搜索入口：App 只在搜索词变化时离开文件视图（不随文件视图打开而触发）', () => {
    const app = read('src/renderer/App.tsx')
    // 依赖数组只有 searchQuery —— 进入文件视图不会触发，避免"搜索后双击进文件列表被弹出"
    expect(app).toMatch(/\}, \[searchQuery\]\)/)
    expect(app).toContain('st.folderViewAssetId')
    expect(app).toContain('st.closeFolderView()')
  })
})
