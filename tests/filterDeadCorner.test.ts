/**
 * 0.9.0「全部」视图**筛选死角**的回归守卫（2026-10-30 用户实测报的 bug）：
 *
 * > 「如果我在模型的地方选择了模型的格式，但没有取消勾选的话，到"全部"这里来，
 * >  是看不到 SU 模型的。」
 *
 * 实测：左栏「全部」徽标 135，点进去中栏 75 项 —— 60 个 SU 模型被隐形筛掉。
 * 根因是 `hideInAllView`（体积 / 分辨率 / 格式在「全部」视图不渲染 chip）之后，
 * 三处**手写**的字段清单各漏了几个字段：
 * ① 侧栏「全部」的高亮判定（13 个 `&&`）漏 `minResolution` / `modelFormat`
 *    → 筛选生效、左栏却显示"无筛选"；
 * ② 侧栏「全部」的清理列表（13 个字段）漏同上两个 → 点「全部」也回不到整库；
 * ③ 「重复资产」的清理列表（9 个字段）漏 6 个；
 * ④ 标签组 top12 截断会吃掉当前筛中的标签（同类：入口消失、筛选取消不掉）。
 *
 * 本文件的 ⑤ 是**源码守卫**：Sidebar 里不许再出现手写的清空列表 / `&&` 链 ——
 * 那正是本次 bug 的形态，只要允许手写就一定会再漏。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Asset } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  allViewFilterPatch,
  hiddenActiveFilterLabels,
  isAllViewActive,
  matchesFilters,
  type Filters
} from '../src/renderer/logic/filters'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

let seq = 0

function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `dead-${n}`,
    name: `资产${n}`,
    kind: 'texture',
    source: '知末网',
    folder: `E:\\Lib\\材质\\未分类\\未分类\\资产${n}`,
    relFolder: `材质/未分类/未分类/资产${n}`,
    files: [],
    size: 1024,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `texture:资产${n}`,
    importedAt: 0,
    updatedAt: 0,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...patch
  }
}

function f(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

// ── ① isAllViewActive ────────────────────────────────────────────────

describe('isAllViewActive —— 「全部」高亮判定（唯一定义处）', () => {
  it('DEFAULT_FILTERS → true（什么都没筛）', () => {
    expect(isAllViewActive(DEFAULT_FILTERS)).toBe(true)
  })

  it('kind: model → true（kind 是视图不是筛选）', () => {
    // 与 `hasClearableFilters` 的口径一致：切大类不算"筛过"，真正清的只有属性维度。
    // 注意实际上进模型视图时 kind 一定不是 'all'，这个断言守的是函数定义本身。
    expect(isAllViewActive(f({ kind: 'model' }))).toBe(true)
  })

  // ── 本 bug 的核心：两个隐形维度 ──
  it('modelFormat: skp → false（本 bug 的核心断言）', () => {
    expect(isAllViewActive(f({ modelFormat: 'skp' }))).toBe(false)
  })

  it('minResolution: 4k → false', () => {
    expect(isAllViewActive(f({ minResolution: '4k' }))).toBe(false)
  })

  it('minBytes: 50MB → false', () => {
    expect(isAllViewActive(f({ minBytes: 50 * 1024 * 1024 }))).toBe(false)
  })

  it('query: abc → true（搜索框自显，不参与判定）', () => {
    expect(isAllViewActive(f({ query: 'abc' }))).toBe(true)
  })

  it.each([
    ['colorTags', { colorTags: ['red'] as Filters['colorTags'] }],
    ['favoriteOnly', { favoriteOnly: true }],
    ['styles', { styles: ['简约'] }],
    ['tag', { tag: '木纹' }],
    ['source', { source: '知末网' }],
    ['suVersion', { suVersion: 'SU 2024' }],
    ['category1', { category1: '家具' }]
  ])('%s 生效 → false', (_name, patch) => {
    expect(isAllViewActive(f(patch as Partial<Filters>))).toBe(false)
  })
})

// ── ② allViewFilterPatch ────────────────────────────────────────────

describe('allViewFilterPatch —— 「全部」/「重复资产」共用重置 patch', () => {
  /** 所有筛选维度都填满（含非法边界值都无所谓的"满"状态） */
  const full = f({
    kind: 'model',
    tag: '木纹',
    source: '知末网',
    suVersion: 'SU 2024',
    category1: '家具',
    category2: '椅子',
    styles: ['简约', '奶油风'],
    favoriteOnly: true,
    colorTags: ['red', 'blue'],
    minBytes: 100,
    maxBytes: 200,
    importedAfter: 1000,
    importedBefore: 2000,
    minResolution: '4k',
    modelFormat: 'skp',
    query: '木纹',
    sort: 'size'
  })
  const patched: Filters = { ...full, ...allViewFilterPatch() }

  it('所有属性维度被清空', () => {
    expect(patched.minResolution).toBeNull()
    expect(patched.modelFormat).toBeNull()
    expect(patched.minBytes).toBeNull()
    expect(patched.maxBytes).toBeNull()
    expect(patched.importedAfter).toBeNull()
    expect(patched.importedBefore).toBeNull()
    expect(patched.tag).toBeNull()
    expect(patched.source).toBeNull()
    expect(patched.suVersion).toBeNull()
    expect(patched.category1).toBeNull()
    expect(patched.category2).toBeNull()
  })

  it('多选 / 布尔维度回到空态', () => {
    expect(patched.styles).toEqual([])
    expect(patched.colorTags).toEqual([])
    expect(patched.favoriteOnly).toBe(false)
  })

  it('kind 强制 all（两个入口都是"回到全库"）', () => {
    expect(patched.kind).toBe('all')
  })

  it('query 原样保留（点「全部」不清空搜索框）', () => {
    expect(patched.query).toBe('木纹')
  })

  it('sort 原样保留（排序不是筛选）', () => {
    expect(patched.sort).toBe('size')
  })

  it('套完 patch 后 isAllViewActive 为 true（两个入口的语义闭环）', () => {
    // query 仍在，但 query 不参与判定 → 高亮应当亮起来
    expect(isAllViewActive(patched)).toBe(true)
  })
})

// ── ③ hiddenActiveFilterLabels ──────────────────────────────────────

describe('hiddenActiveFilterLabels —— 「全部」视图的隐形维度名', () => {
  it('三个维度都不生效 → []', () => {
    expect(hiddenActiveFilterLabels(DEFAULT_FILTERS)).toEqual([])
  })

  it('只 modelFormat → [格式]（与中栏头 chip 文案一致）', () => {
    expect(hiddenActiveFilterLabels(f({ modelFormat: 'skp' }))).toEqual(['格式'])
  })

  it('体积 + 格式 → 长度为 2 且两个名字都在', () => {
    const labels = hiddenActiveFilterLabels(f({ minBytes: 50 * 1024 * 1024, modelFormat: 'max' }))
    expect(labels).toHaveLength(2)
    expect(labels).toContain('体积')
    expect(labels).toContain('格式')
  })

  it('三个都在 → 顺序 = 中栏头 chip 排列顺序（体积 → 分辨率 → 格式）', () => {
    const labels = hiddenActiveFilterLabels(
      f({ minBytes: 1, minResolution: '8k', modelFormat: 'skp' })
    )
    expect(labels).toEqual(['体积', '分辨率', '格式'])
  })

  it('非法体积区间（min > max）不算生效（与 activeSizeRange 口径一致）', () => {
    expect(hiddenActiveFilterLabels(f({ minBytes: 200, maxBytes: 100 }))).toEqual([])
  })

  it('非 all 视图下也正常返回（函数本身不判 kind，判 kind 是调用方的事）', () => {
    expect(hiddenActiveFilterLabels(f({ kind: 'model', modelFormat: 'skp' }))).toEqual(['格式'])
  })

  it('不在隐藏清单里的维度（标签 / 风格）不出现', () => {
    expect(hiddenActiveFilterLabels(f({ tag: '木纹', styles: ['简约'] }))).toEqual([])
  })
})

// ── ④ 源码守卫：Sidebar 不许再手写清单 ──────────────────────────────

describe('Sidebar.tsx 源码守卫：清理列表与高亮判定必须收敛在 filters.ts', () => {
  const sidebar = read('src/renderer/components/Sidebar.tsx')

  it('「全部」与「重复资产」都调 allViewFilterPatch()', () => {
    expect(sidebar).toContain('allViewFilterPatch()')
    const hits = sidebar.split('allViewFilterPatch()').length - 1
    // import 行里出现一次（不带括号），两处调用 → ≥ 2
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('高亮判定走 isAllViewActive(filters)', () => {
    expect(sidebar).toContain('isAllViewActive(filters)')
  })

  it('组件里不许再手写清空列表（favoriteOnly: false 只应存在于 filters.ts）', () => {
    // 这是本 bug 的形态：手写清单 → 加维度时必然漏。只要允许手写就会再漏一次。
    expect(sidebar).not.toContain('favoriteOnly: false')
    // 同族：手写清单必然同时列这两个字段
    expect(sidebar).not.toContain('importedAfter: null')
    expect(sidebar).not.toContain('maxBytes: null')
  })

  it('标签组保底：当前筛中的标签必须补进 top12 列表', () => {
    expect(sidebar).toContain('filters.tag')
    expect(sidebar).toMatch(/\[activeAssets, filters\.tag\]/)
  })
})

// ── ⑤ 端到端语义：用户那条操作链 ─────────────────────────────────────

describe('端到端：模型里选格式=SU → 切到「全部」→ 整库可见', () => {
  // 四条真实形态的资产：SU 模型 / max 模型 / 贴图 / HDR
  const suModel = asset({
    kind: 'model',
    name: 'SU 沙发',
    files: [{ rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 1, kind: 'model' }]
  })
  const maxModel = asset({
    kind: 'model',
    name: 'max 沙发',
    files: [{ rel: 'a.max', name: 'a.max', ext: 'max', size: 1, kind: 'model' }]
  })
  const texture = asset({ kind: 'texture', name: '木纹贴图' })
  const hdri = asset({ kind: 'hdri', name: '海边全景' })
  const all = [suModel, maxModel, texture, hdri]

  it('筛选前（模型视图 + 格式=SU）只命中 1 条', () => {
    const before = f({ kind: 'model', modelFormat: 'skp' })
    expect(all.filter((a) => matchesFilters(a, before))).toHaveLength(1)
  })

  it('套 allViewFilterPatch 后四条**全部命中**（「全部」就是全部）', () => {
    const after: Filters = { ...f({ kind: 'model', modelFormat: 'skp' }), ...allViewFilterPatch() }
    const hit = all.filter((a) => matchesFilters(a, after))
    expect(hit).toHaveLength(4)
    // 逐条钉住，避免"数量对了但错在了别的维度"这种假绿
    expect(hit).toContain(suModel)
    expect(hit).toContain(maxModel)
    expect(hit).toContain(texture)
    expect(hit).toContain(hdri)
  })

  it('同样的隐形状态（不点「全部」直接改 kind=all）仍会漏 —— 这正是用户报的现场', () => {
    // 复刻 bug：只把 kind 改成 all，格式筛选还在 → SU 之外的模型被吃掉
    const broken = f({ kind: 'all', modelFormat: 'skp' })
    const hit = all.filter((a) => matchesFilters(a, broken))
    expect(hit).toHaveLength(3) // SU 模型 + 贴图 + HDR（非模型资产不受格式约束）
    expect(hit).not.toContain(maxModel)
  })
})
