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
import type { Asset } from '../src/shared/types'
import {
  dedupeIds,
  isAllSelected,
  pruneToVisible,
  selectRangeIds
} from '../src/renderer/logic/selection'

/**
 * 2026-10 用户反馈「找不到多选删除」——批量条与删除链路本来就有，缺的是**入口**。
 * 本轮补齐：复选框 / Shift 范围选 / Ctrl+A 全选 / 中栏头「全选」。
 *
 * 本文件覆盖三层：
 * ① 纯逻辑（`logic/selection.ts`）：区间顺序、锚点丢失退化、可见集裁剪；
 * ② 真实 store action：`selectAll` / `selectRange` / `pruneSelection` 的落状态语义；
 * ③ 源码守卫：复选框带 stopPropagation、文件视图有 grid/list 两态分支、
 *    中栏头有「全选」入口（组件无法在 node 环境渲染，守契约防回退）。
 */

// ── 可见顺序：区间选择的三条不变量 ────────────────────────────────

describe('selectRangeIds —— 区间顺序 = 可见顺序（含两端）', () => {
  const ORDER = ['a', 'b', 'c', 'd', 'e']

  it('正向区间：锚点在前 → 从锚点到目标', () => {
    expect(selectRangeIds('b', 'd', ORDER)).toEqual(['b', 'c', 'd'])
  })

  it('反向区间：锚点在后 → 结果顺序仍是可见顺序（不反转）', () => {
    expect(selectRangeIds('d', 'b', ORDER)).toEqual(['b', 'c', 'd'])
  })

  it('单点：锚点 = 目标 → 只选中它自己', () => {
    expect(selectRangeIds('c', 'c', ORDER)).toEqual(['c'])
  })

  it('锚点不在可见集（被筛掉 / 被删）→ 退化为单点，不当成"什么都没选"', () => {
    expect(selectRangeIds('zzz', 'c', ORDER)).toEqual(['c'])
  })

  it('没有锚点（null）→ 退化为单点', () => {
    expect(selectRangeIds(null, 'c', ORDER)).toEqual(['c'])
  })

  it('目标不在可见集 → 空数组（不可见的东西不能被范围选进来）', () => {
    expect(selectRangeIds('b', 'zzz', ORDER)).toEqual([])
  })

  it('visibleIds 乱序时以给定顺序为准（不是字典序、不是 assets 原序）', () => {
    // 渲染顺序是 c → a → b（例如按体积倒序）；a 到 c 的区间应是 [c, a]
    expect(selectRangeIds('a', 'c', ['c', 'a', 'b'])).toEqual(['c', 'a'])
    // 反向同理
    expect(selectRangeIds('c', 'a', ['c', 'a', 'b'])).toEqual(['c', 'a'])
  })

  it('visibleIds 含重复 id 时不重复选中（去重但保序）', () => {
    expect(dedupeIds(['a', 'b', 'a', ''])).toEqual(['a', 'b'])
    expect(selectRangeIds('a', 'c', ['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('空可见集 → 空结果（不抛错）', () => {
    expect(selectRangeIds('a', 'b', [])).toEqual([])
  })
})

describe('pruneToVisible / isAllSelected —— 只允许选中看得见的东西', () => {
  it('剔除不在可见集里的 id', () => {
    expect(pruneToVisible(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c'])
  })

  it('保留时**按可见顺序重排**（selectedIds[0] 被当成 selectedId，详情面板不能指向被筛掉的资产）', () => {
    expect(pruneToVisible(['c', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'c'])
  })

  it('可见集为空 → 选择清空', () => {
    expect(pruneToVisible(['a', 'b'], [])).toEqual([])
  })

  it('isAllSelected：可见结果全选中才 true；空可见集恒 false', () => {
    expect(isAllSelected(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(isAllSelected(['a'], ['a', 'b'])).toBe(false)
    expect(isAllSelected(['a', 'b', 'c'], ['a', 'b'])).toBe(true)
    expect(isAllSelected(['a'], [])).toBe(false)
  })
})

// ── store 行为（真实 action，只 stub 两个边界）────────────────────

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
    put: vi.fn(async (a: Asset) => a.id),
    bulkPut: vi.fn(async () => 0),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

beforeEach(() => {
  useVault.setState({
    assets: [],
    selectedId: null,
    selectedIds: [],
    lastClickedId: null
  })
})

describe('store：selectAll / selectRange / pruneSelection', () => {
  it('selectAll 只选中传入的可见集（不是全库）', () => {
    useVault.setState({
      assets: [
        { id: 'hidden', name: 'H', kind: 'model', files: [] },
        { id: 'v1', name: 'V1', kind: 'model', files: [] }
      ] as unknown as Asset[]
    })
    useVault.getState().selectAll(['v1'])
    const s = useVault.getState()
    expect(s.selectedIds).toEqual(['v1'])
    expect(s.selectedId).toBe('v1')
    expect(s.lastClickedId).toBe('v1')
    // 全库里的另一个资产没有被选中
    expect(s.selectedIds).not.toContain('hidden')
  })

  it('切换可见集后再全选 → 替换旧选择（不是累加）', () => {
    useVault.getState().selectAll(['a', 'b'])
    useVault.getState().selectAll(['c', 'd'])
    expect(useVault.getState().selectedIds).toEqual(['c', 'd'])
    expect(useVault.getState().selectedId).toBe('c')
  })

  it('selectAll([]) = 取消全选', () => {
    useVault.getState().selectAll(['a', 'b'])
    useVault.getState().selectAll([])
    const s = useVault.getState()
    expect(s.selectedIds).toEqual([])
    expect(s.selectedId).toBeNull()
    expect(s.lastClickedId).toBeNull()
  })

  it('selectRange：以 lastClickedId 为锚点选中区间，并把锚点移到本次点击', () => {
    useVault.getState().select('b')
    expect(useVault.getState().lastClickedId).toBe('b')
    useVault
      .getState()
      .selectRange(useVault.getState().lastClickedId, 'd', ['a', 'b', 'c', 'd', 'e'])
    const s = useVault.getState()
    expect(s.selectedIds).toEqual(['b', 'c', 'd'])
    expect(s.selectedId).toBe('d')
    expect(s.lastClickedId).toBe('d')
  })

  it('selectRange 的目标不可见 → 选择与详情同时清空（不留"选中了看不见的东西"的错觉）', () => {
    useVault.getState().selectAll(['a', 'b'])
    useVault.getState().selectRange('a', 'zzz', ['a', 'b'])
    expect(useVault.getState().selectedIds).toEqual([])
    expect(useVault.getState().selectedId).toBeNull()
  })

  it('pruneSelection：剔除切筛选后不可见的选中项，并同步 selectedId / 锚点', () => {
    useVault.getState().selectAll(['a', 'b', 'c'])
    useVault.getState().pruneSelection(['a', 'c'])
    const s = useVault.getState()
    expect(s.selectedIds).toEqual(['a', 'c'])
    expect(s.selectedId).toBe('a')
    expect(s.lastClickedId).toBe('a')
  })

  it('pruneSelection：锚点被筛掉 → lastClickedId 置 null（下次 Shift 退化为单点）', () => {
    useVault.getState().selectAll(['a', 'b'])
    // 锚点是 a；新可见集里没有 a
    useVault.setState({ lastClickedId: 'a' })
    useVault.getState().pruneSelection(['b'])
    expect(useVault.getState().selectedIds).toEqual(['b'])
    expect(useVault.getState().lastClickedId).toBeNull()
  })

  it('toggleSelect 会更新 Shift 锚点（Ctrl+点击也是一次"点击"）', () => {
    useVault.getState().selectAll(['a'])
    useVault.getState().toggleSelect('b')
    expect(useVault.getState().selectedIds).toEqual(['a', 'b'])
    expect(useVault.getState().lastClickedId).toBe('b')
  })
})

// ── 源码守卫（组件在 node 环境渲染不了，守契约防回退）─────────────

describe('源码守卫：多选入口 / 文件夹视图跟随顶栏', () => {
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
  const grid = read('../src/renderer/components/AssetGrid.tsx')
  const app = read('../src/renderer/App.tsx')

  it('卡片/行上的复选框存在，且点击时先 stopPropagation 再切换（否则多选选不起来）', () => {
    const start = grid.indexOf('function SelectBox')
    const end = grid.indexOf('/** 焦点是否落在可输入控件里')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const box = grid.slice(start, end)
    expect(box).toContain('data-select-box')
    expect(box).toContain('stopPropagation')
    // 顺序关键：不先 stopPropagation，冒泡到卡片就会走 select() 清掉多选
    expect(box.indexOf('e.stopPropagation()')).toBeLessThan(box.indexOf('onToggle()'))
  })

  it('复选框同时挂到卡片与列表行（两处都能多选）', () => {
    const uses = grid.split('<SelectBox').length - 1
    expect(uses).toBeGreaterThanOrEqual(2) // 定义处 1 次 + 卡片 1 次 + 行 1 次 = 3
    expect(grid).toContain('onToggle={() => toggleSelect(')
  })

  it('Shift+点击走 selectRange（当前渲染顺序），Ctrl/Cmd+点击仍走 toggleSelect', () => {
    expect(grid).toContain('selectRange(lastClickedId, a.id, visibleOrder)')
    expect(grid).toContain('if (e.ctrlKey || e.metaKey) toggleSelect(a.id)')
  })

  it('Ctrl/Cmd+A 全选当前可见结果，且输入框聚焦时不抢', () => {
    expect(grid).toContain("(e.key ?? '').toLowerCase() !== 'a'")
    expect(grid).toContain('isTypingTarget(e.target)')
    expect(grid).toContain('selectAll(ids)')
  })

  it('可见集变化会裁剪选择（selectedIds 只保留看得见的 id）', () => {
    expect(grid).toContain('pruneSelection')
    expect(grid).toContain('visibleOrderRef.current')
    expect(grid).toContain('pruneKey')
    // 文件视图下网格没渲染 → 改用当前筛选结果裁剪（否则返回网格后仍留着看不见的选中项）
    expect(grid).toContain('applyFilters(st.assets, st.filters, st.libraryView)')
  })

  it('文件夹视图按 view 分两支渲染（grid 卡片 / list 行表格），且顶栏 view 直接传进去', () => {
    expect(grid).toContain('<FolderFileList asset={folderAsset} view={view} />')
    expect(grid).toContain("view === 'grid' ?")
    expect(grid).toContain("view === 'list'")
    // 网格形态必须保留双击打开 + 拖出 + 扩展名徽标 + 大小
    expect(grid).toContain('data-file-card')
    expect(grid).toContain('fileDragProps')
    expect(grid).toContain('row.extLabel')
    expect(grid).toContain('row.sizeText')
  })

  it('中栏头有「全选 / 取消全选」入口（12px 文字按钮，作用于当前可见结果）', () => {
    expect(app).toContain("'取消全选' : '全选'")
    expect(app).toContain('selectAll(allSelected ? [] : assets.map((a) => a.id))')
    expect(app).toContain('text-[12px]')
  })
})
