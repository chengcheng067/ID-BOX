import { describe, expect, it } from 'vitest'
import type { SavedView } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  filtersFromSavedView,
  snapshotFilters,
  type Filters
} from '../src/renderer/logic/filters'

/**
 * 0.6.0「智能集合」的数据契约：
 * - 写入是**纯数据快照**（不含函数 / 派生字段）；
 * - 读取以 `DEFAULT_FILTERS` 为底：缺失键补默认、非法值丢弃；
 * - **套用不残留**：先套 A 再套 B，A 独有的条件必须消失（这是本组最关键的断言）。
 */

function current(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

function view(filters: Record<string, unknown>, sort?: string): SavedView {
  return { id: 'v1', name: '集合', filters, sort, createdAt: 0 }
}

describe('snapshotFilters', () => {
  it('逐键保存纯数据，且是深拷贝（后续改动不污染快照）', () => {
    const f = current({
      kind: 'texture',
      category1: '沙发',
      category2: '布艺',
      styles: ['奶油风'],
      favoriteOnly: true,
      colorTags: ['red', 'blue'],
      minBytes: 50,
      maxBytes: null,
      importedAfter: 1700000000000,
      importedBefore: null,
      minResolution: '4k',
      query: '椅子',
      sort: 'size'
    })
    const snap = snapshotFilters(f)
    expect(snap).toEqual({
      kind: 'texture',
      tag: null,
      source: null,
      suVersion: null,
      category1: '沙发',
      category2: '布艺',
      styles: ['奶油风'],
      favoriteOnly: true,
      colorTags: ['red', 'blue'],
      minBytes: 50,
      maxBytes: null,
      importedAfter: 1700000000000,
      importedBefore: null,
      minResolution: '4k',
      query: '椅子',
      sort: 'size'
    })
    f.styles.push('侘寂风')
    expect(snap.styles).toEqual(['奶油风'])
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })

  it('不含函数：全部值都是 JSON 可序列化类型', () => {
    const snap = snapshotFilters(current())
    for (const v of Object.values(snap)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof v)
      expect(typeof v).not.toBe('function')
    }
  })
})

describe('filtersFromSavedView · 补齐与校验', () => {
  it('空 / 缺键 → 全部回落默认值', () => {
    expect(filtersFromSavedView(view({}))).toEqual(DEFAULT_FILTERS)
  })

  it('非法值一律丢弃（不报错、不半生效）', () => {
    const out = filtersFromSavedView(
      view({
        kind: 'bogus',
        tag: 123,
        styles: 'not-an-array',
        favoriteOnly: 'yes',
        colorTags: ['pink', 5],
        minBytes: Number.NaN,
        importedAfter: Number.POSITIVE_INFINITY,
        minResolution: '8k',
        query: 42,
        sort: 'unknown'
      })
    )
    expect(out).toEqual(DEFAULT_FILTERS)
  })

  it('数组维度逐项过滤：合法项保留、非法项丢弃（不是整表丢弃）', () => {
    const out = filtersFromSavedView(view({ colorTags: ['red', 'pink', 5], styles: [' 奶油风 ', 7] }))
    expect(out.colorTags).toEqual(['red'])
    expect(out.styles).toEqual(['奶油风'])
  })

  it('合法值原样还原（含排序、分辨率、色标白名单）', () => {
    const out = filtersFromSavedView(
      view(
        {
          kind: 'materialGroup',
          tag: '布艺',
          source: '知末网',
          suVersion: 'SU 2024',
          category1: '沙发',
          category2: '单人沙发',
          styles: ['奶油风', '奶油风'],
          favoriteOnly: true,
          colorTags: ['red', 'purple'],
          minBytes: 10,
          maxBytes: 100,
          importedAfter: 1,
          importedBefore: 2,
          minResolution: '2k',
          query: 'chair'
        },
        'su'
      )
    )
    expect(out.kind).toBe('materialGroup')
    expect(out.styles).toEqual(['奶油风'])
    expect(out.colorTags).toEqual(['red', 'purple'])
    expect(out.minResolution).toBe('2k')
    expect(out.sort).toBe('su')
  })

  it('sort：视图字段优先；非法时退回快照里的 sort', () => {
    expect(filtersFromSavedView(view({ sort: 'name' }, 'size')).sort).toBe('size')
    expect(filtersFromSavedView(view({ sort: 'name' }, 'bogus')).sort).toBe('name')
    expect(filtersFromSavedView(view({}, undefined)).sort).toBe('recent')
  })

  it('未知键不会泄漏到 Filters（向前兼容旧档 / 手改 json）', () => {
    const out = filtersFromSavedView(view({ kind: 'model', somethingNew: 'x' }))
    expect(out).not.toHaveProperty('somethingNew')
  })
})

describe('套用视图：不残留上一条视图的条件', () => {
  it('先 A（分类+标签+搜索+4K）再 B（只看模型）→ A 的条件全部清掉', () => {
    const a = view(
      {
        kind: 'texture',
        category1: '沙发',
        category2: '布艺',
        tag: '奶油',
        query: '椅子',
        minResolution: '4k',
        minBytes: 50,
        favoriteOnly: true,
        styles: ['侘寂风']
      },
      'size'
    )
    const b = view({ kind: 'model' })

    const afterA = filtersFromSavedView(a)
    expect(afterA.category1).toBe('沙发')
    expect(afterA.tag).toBe('奶油')

    // 关键：B 是**整组替换**（以 DEFAULT_FILTERS 为底），不是在当前状态上 merge
    const afterB = filtersFromSavedView(b)
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

  it('同一条视图重复套用是幂等的', () => {
    const v = view({ kind: 'hdri', minResolution: '2k' }, 'name')
    expect(filtersFromSavedView(v)).toEqual(filtersFromSavedView(v))
  })
})
