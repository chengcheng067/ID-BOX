/**
 * T07 分类 UI 纯逻辑单测（被测对象：`src/renderer/logic/category.ts` +
 * `logic/filters.ts` 新增的分类 / 风格筛选维度）。
 */
import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import {
  categoriesOf,
  countLevel1,
  countLevel2,
  duplicatedLevel2Names,
  isCrossKind,
  isLegacyLayout,
  isNormalLayout,
  level1OptionsFor,
  level2OptionsFor,
  planLegacyMoves,
  relSegmentCount,
  styleOptionsFor
} from '../src/renderer/logic/category'
import { applyFilters, matchesFilters, searchHaystack, DEFAULT_FILTERS } from '../src/renderer/logic/filters'

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\资产${seq}`,
    relFolder: `模型/未分类/未分类/资产${seq}`,
    files: [],
    size: 0,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `dk-${seq}`,
    importedAt: seq * 1000,
    updatedAt: seq * 1000,
    ...patch
  }
}

describe('logic/category · categoriesOf', () => {
  it('缺字段的老数据兜底为未分类哨兵', () => {
    expect(categoriesOf(asset({ category1: undefined, category2: undefined }))).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })

  it('正常值原样透传', () => {
    expect(categoriesOf(asset({ category1: '家具', category2: '沙发' }))).toEqual({
      category1: '家具',
      category2: '沙发'
    })
  })
})

describe('logic/category · 遗留布局判定与迁移计划', () => {
  it('relSegmentCount：4 段为规范布局，2/3 段为遗留', () => {
    expect(relSegmentCount('模型/未分类/未分类/某沙发')).toBe(4)
    expect(relSegmentCount('模型/某沙发')).toBe(2)
    expect(relSegmentCount(undefined)).toBe(0)
  })

  it('isNormalLayout / isLegacyLayout', () => {
    expect(isNormalLayout(asset())).toBe(true)
    const legacy = asset({ relFolder: '模型/某沙发', folder: 'E:\\Lib\\模型\\某沙发' })
    expect(isNormalLayout(legacy)).toBe(false)
    expect(isLegacyLayout(legacy)).toBe(true)
  })

  it('folder / name 缺失的记录不可迁移（skip 语义）', () => {
    expect(isLegacyLayout(asset({ relFolder: '模型/某沙发', folder: '' }))).toBe(false)
  })

  it('planLegacyMoves：目标 = <库根>/<大类>/未分类/未分类/<名>，relFolder 四段', () => {
    const a = asset({ name: '某沙发', relFolder: '模型/某沙发', folder: 'E:\\Lib\\模型\\某沙发' })
    const moves = planLegacyMoves([a], 'E:\\Lib')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toEqual({
      id: a.id,
      from: 'E:\\Lib\\模型\\某沙发',
      to: 'E:\\Lib\\模型\\未分类\\未分类\\某沙发',
      relFolder: '模型/未分类/未分类/某沙发'
    })
  })

  it('planLegacyMoves：已规范布局的资产不进计划（幂等前提）', () => {
    const moves = planLegacyMoves([asset()], 'E:\\Lib')
    expect(moves).toHaveLength(0)
  })

  it('planLegacyMoves：贴图资产用「材质」目录（材质大类合并后）', () => {
    const a = asset({ kind: 'texture', name: '木纹贴图', relFolder: '贴图/木纹贴图', folder: 'E:\\Lib\\贴图\\木纹贴图' })
    const moves = planLegacyMoves([a], 'E:\\Lib')
    expect(moves[0]!.relFolder).toBe('材质/未分类/未分类/木纹贴图')
    expect(moves[0]!.to).toContain('\\材质\\未分类\\未分类\\木纹贴图')
  })
})

describe('logic/category · 三级树计数', () => {
  const list = [
    asset({ category1: '家具', category2: '沙发' }),
    asset({ category1: '家具', category2: '沙发' }),
    asset({ category1: '家具', category2: '床具' }),
    asset({ category1: '灯具', category2: '吊灯' }),
    asset({ category1: '灯具', category2: '吊灯' }),
    asset({ category1: '灯具', category2: '吊灯' }),
    asset({ kind: 'texture', category1: '木纹', category2: '胡桃木' }),
    asset({ category1: undefined, category2: undefined }) // 未分类
  ]

  it('countLevel1：count 降序、未分类（有资产时）恒排最后', () => {
    const nodes = countLevel1(list, 'model')
    expect(nodes.map((n) => n.value)).toEqual(['灯具', '家具', UNCLASSIFIED])
    expect(nodes[nodes.length - 1]!.count).toBe(1)
  })

  it('v1.0.3 规则：计数为 0 的分类不显示节点（含「未分类」哨兵）', () => {
    // 空大类：连未分类都不显示
    expect(countLevel1(list, 'hdri')).toEqual([])
    // 灯具组下的未分类计数为 0 → 不显示；吊灯计数正确
    const l2 = countLevel2(list, 'model', '灯具')
    expect(l2.map((n) => n.value)).toEqual(['吊灯'])
    expect(l2[0]!.count).toBe(3)
    // 未分类有资产时仍显示且恒排最后
    expect(countLevel1(list, 'model').at(-1)!.value).toBe(UNCLASSIFIED)
  })

  it('inferred 标记：CONFIDENCE 为推断的一级组带「待核对」，事实组不带', () => {
    const nodes = countLevel1(
      [asset({ category1: '软装陈设', category2: '摆件' }), asset({ category1: '家具', category2: '沙发' })],
      'model'
    )
    const byName = new Map(nodes.map((n) => [n.value, n]))
    expect(byName.get('软装陈设')!.inferred).toBe(true)
    expect(byName.get('家具')!.inferred).toBe(false)
  })

  it('duplicatedLevel2Names：同大类内多个一级下重名的二级（06 §15-④）', () => {
    const list2 = [
      asset({ category1: '软装陈设', category2: '装饰画' }),
      asset({ category1: '挂画', category2: '装饰画' }), // 跨频道词表重名
      asset({ category1: '软装陈设', category2: '摆件' }),
      asset({ kind: 'texture', category1: '挂画', category2: '装饰画' }) // 别的大类不算
    ]
    expect(duplicatedLevel2Names(list2, 'model')).toEqual(new Set(['装饰画']))
    expect(duplicatedLevel2Names(list2, 'texture')).toEqual(new Set())
  })
})

describe('logic/category · 级联选项', () => {
  it('level1OptionsFor：model 用 SU 分册；texture/material 共用并集 33 项；其余大类无词表', () => {
    expect(level1OptionsFor('model')).toContain('家装')
    expect(level1OptionsFor('model')).not.toContain('石材')
    expect(level1OptionsFor('texture')).toContain('石材')
    expect(level1OptionsFor('texture')).not.toContain('推荐')
    // v1.0.8（docs/14 §2.2）：两类落同一个「材质」目录 → 一级下拉必须同源（并集 33 项）
    expect(level1OptionsFor('material')).toHaveLength(33)
    expect(level1OptionsFor('material')).toContain('皮肤器官')
    expect(level1OptionsFor('material')).toContain('布料')
    expect(level1OptionsFor('material')).not.toContain('全部')
    // 钉住"两 kind 同表"：贴图也能看到材质独有的 12 项，且顺序/内容完全一致
    expect(level1OptionsFor('texture')).toContain('布料')
    expect(level1OptionsFor('texture')).toEqual(level1OptionsFor('material'))
    expect(level1OptionsFor('hdri')).toEqual([])
    expect(level1OptionsFor('other')).toEqual([])
  })

  it('level2OptionsFor：未分类 → []（锁定）；有词表 → 枚举；无级联（材质预设）→ null（自由输入）', () => {
    expect(level2OptionsFor(UNCLASSIFIED)).toEqual([])
    expect(level2OptionsFor('家具')).toContain('沙发')
    expect(level2OptionsFor('材质预设')).toBeNull()
    expect(level2OptionsFor('未知一级')).toBeNull()
  })
})

describe('logic/category · 风格选项与跨大类判定', () => {
  it('styleOptionsFor：按大类分册；kind=all 用并集；hdri 等无词表', () => {
    expect(styleOptionsFor('model')).toContain('简洁')
    expect(styleOptionsFor('model')).not.toContain('简欧')
    expect(styleOptionsFor('texture')).toContain('简欧')
    expect(styleOptionsFor('texture')).not.toContain('简洁')
    const all = styleOptionsFor('all')
    expect(all).toContain('简洁')
    expect(all).toContain('简欧')
    expect(styleOptionsFor('hdri')).toEqual([])
  })

  it('isCrossKind：跨大类 true，同大类 / 单个 false', () => {
    const list3 = [asset({ kind: 'model' }), asset({ kind: 'texture' }), asset({ kind: 'model' })]
    expect(isCrossKind(list3, [list3[0]!.id, list3[1]!.id])).toBe(true)
    expect(isCrossKind(list3, [list3[0]!.id, list3[2]!.id])).toBe(false)
    expect(isCrossKind(list3, [list3[0]!.id])).toBe(false)
    expect(isCrossKind(list3, [])).toBe(false)
  })
})

describe('logic/filters · 分类与风格筛选（T07 新增维度）', () => {
  it('category1 / category2 等值筛选（缺字段的老数据按未分类参与匹配）', () => {
    const legacy = asset({ category1: undefined, category2: undefined })
    expect(matchesFilters(legacy, { ...DEFAULT_FILTERS, category1: UNCLASSIFIED })).toBe(true)
    expect(matchesFilters(legacy, { ...DEFAULT_FILTERS, category1: '家具' })).toBe(false)
    expect(
      matchesFilters(asset({ category1: '家具', category2: '沙发' }), {
        ...DEFAULT_FILTERS,
        category1: '家具',
        category2: '沙发'
      })
    ).toBe(true)
  })

  it('风格维度内 OR：命中任一选中风格即出', () => {
    const a = asset({ styles: ['现代'] })
    const b = asset({ styles: ['北欧'] })
    const c = asset({ styles: ['工业', '复古'] })
    const f = { ...DEFAULT_FILTERS, styles: ['现代', '北欧'] }
    expect(matchesFilters(a, f)).toBe(true)
    expect(matchesFilters(b, f)).toBe(true)
    expect(matchesFilters(c, f)).toBe(false)
  })

  it('风格与其他维度 AND：大类不符直接排除', () => {
    const a = asset({ kind: 'texture', styles: ['现代'] })
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, kind: 'model', styles: ['现代'] })).toBe(false)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, kind: 'texture', styles: ['现代'] })).toBe(true)
  })

  it('styles 为空的资产不命中任何风格筛选', () => {
    expect(matchesFilters(asset(), { ...DEFAULT_FILTERS, styles: ['现代'] })).toBe(false)
  })

  it('haystack 纳入 styles.join（搜「侘寂」能命中）', () => {
    const a = asset({ styles: ['侘寂', '原木'] })
    expect(searchHaystack(a)).toContain('侘寂')
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, query: '侘寂' })).toBe(true)
  })

  it('applyFilters：分类 + 风格 + 排序组合', () => {
    const list = [
      asset({ name: 'A', category1: '家具', category2: '沙发', styles: ['北欧'] }),
      asset({ name: 'B', category1: '家具', category2: '床具', styles: ['北欧'] }),
      asset({ name: 'C', category1: '家具', category2: '沙发', styles: ['工业'] })
    ]
    const out = applyFilters(list, {
      ...DEFAULT_FILTERS,
      category1: '家具',
      category2: '沙发',
      styles: ['北欧']
    })
    expect(out.map((a) => a.name)).toEqual(['A'])
  })
})
