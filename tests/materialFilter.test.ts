/**
 * 材质大类合并 · 筛选模型纯逻辑（T-04，docs/14 §2.4 / §8）。
 *
 * 三件事必须钉住：
 * ① `kind: 'materialGroup'` 是一个**分组**，同时命中 texture 与 material；
 * ② 单值筛选语义与合并前逐字节一致（`'material'` 仍只筛材质预设，不与分组混淆）；
 * ③ 侧栏「材质」节点的计数/分类树 = 两类之和（`KindScope` 收集合）。
 *
 * 全部纯函数，无 React / DOM / window，可直接在 node 环境跑。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  KIND_GROUP_MEMBERS,
  KIND_LABEL,
  MATERIAL_GROUP,
  kindFilterLabel,
  kindsOfFilter
} from '../src/shared/classify'
import {
  DEFAULT_FILTERS,
  activeFilterDimensions,
  applyFilters,
  matchesFilters,
  nextExpandKind,
  searchHaystack
} from '../src/renderer/logic/filters'
import { countLevel1, countLevel2, duplicatedLevel2Names } from '../src/renderer/logic/category'
import type { Asset, AssetKind } from '../src/shared/types'

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const kind: AssetKind = patch.kind ?? 'model'
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind,
    source: '知末网',
    folder: `E:\\Lib\\材质\\资产${seq}`,
    relFolder: `材质/未分类/未分类/资产${seq}`,
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

describe('① 分组筛选：kind=materialGroup 同时命中 texture 与 material', () => {
  it('命中两个材质类，不命中 model / hdri / other', () => {
    const f = { ...DEFAULT_FILTERS, kind: MATERIAL_GROUP }
    expect(matchesFilters(asset({ kind: 'texture' }), f)).toBe(true)
    expect(matchesFilters(asset({ kind: 'material' }), f)).toBe(true)
    expect(matchesFilters(asset({ kind: 'model' }), f)).toBe(false)
    expect(matchesFilters(asset({ kind: 'hdri' }), f)).toBe(false)
    expect(matchesFilters(asset({ kind: 'other' }), f)).toBe(false)
  })

  it('applyFilters 端到端：侧栏点「材质」= 两类之和（不含模型）', () => {
    const list = [
      asset({ kind: 'model' }),
      asset({ kind: 'texture' }),
      asset({ kind: 'material' }),
      asset({ kind: 'hdri' })
    ]
    const out = applyFilters(list, { ...DEFAULT_FILTERS, kind: MATERIAL_GROUP })
    expect(out.map((a) => a.kind).sort()).toEqual(['material', 'texture'])
  })

  it('单值 kind 语义不变：texture 只出贴图、material 只出材质预设（不与分组混淆）', () => {
    const list = [asset({ kind: 'texture' }), asset({ kind: 'material' })]
    expect(applyFilters(list, { ...DEFAULT_FILTERS, kind: 'texture' })).toHaveLength(1)
    expect(applyFilters(list, { ...DEFAULT_FILTERS, kind: 'material' })).toHaveLength(1)
    expect(applyFilters(list, { ...DEFAULT_FILTERS, kind: 'material' })[0]!.kind).toBe('material')
  })
})

describe('② / ③ kindsOfFilter：唯一过滤语义入口', () => {
  it("'all' → null（不筛）", () => {
    expect(kindsOfFilter('all')).toBeNull()
  })

  it("'texture' → 只含 texture", () => {
    const set = kindsOfFilter('texture')
    expect(set).toEqual(new Set(['texture']))
    expect(set!.has('material')).toBe(false)
  })

  it("'material' → 只含 material（单值不被分组吞掉）", () => {
    expect(kindsOfFilter('material')).toEqual(new Set(['material']))
  })

  it('materialGroup → {texture, material}，且与 KIND_GROUP_MEMBERS 同源', () => {
    expect(kindsOfFilter(MATERIAL_GROUP)).toEqual(new Set(['texture', 'material']))
    expect([...kindsOfFilter(MATERIAL_GROUP)!]).toEqual([...KIND_GROUP_MEMBERS.materialGroup])
  })

  it('对 5 个 AssetKind 逐一等价于旧语义（a.kind === f.kind）', () => {
    const kinds: AssetKind[] = ['model', 'texture', 'hdri', 'material', 'other']
    for (const f of kinds) {
      for (const k of kinds) {
        expect(kindsOfFilter(f)!.has(k)).toBe(k === f)
      }
    }
  })
})

describe('④ 显示名：kindFilterLabel / 生效维度 / 搜索haystack', () => {
  it("kindFilterLabel('materialGroup') = 「材质」；单值仍是显示名", () => {
    expect(kindFilterLabel(MATERIAL_GROUP)).toBe('材质')
    expect(kindFilterLabel('texture')).toBe(KIND_LABEL.texture)
    expect(kindFilterLabel('material')).toBe(KIND_LABEL.material)
    expect(kindFilterLabel('all')).toBe('全部')
  })

  it('空结果提示的「当前筛选维度」：分组显示「材质」，不显示 undefined', () => {
    const dims = activeFilterDimensions({ ...DEFAULT_FILTERS, kind: MATERIAL_GROUP })
    expect(dims).toEqual([{ key: 'kind', label: '大类', value: '材质' }])
  })

  it('搜索「材质」能同时命中两类（haystack 追加了 KIND_FOLDER）', () => {
    expect(searchHaystack(asset({ kind: 'texture' }))).toContain('材质')
    expect(searchHaystack(asset({ kind: 'material' }))).toContain('材质')
    // 显示名也仍在（贴图 / 材质预设 都能搜）
    expect(searchHaystack(asset({ kind: 'texture' }))).toContain('贴图')
    const list = [asset({ kind: 'texture' }), asset({ kind: 'material' }), asset({ kind: 'model' })]
    expect(applyFilters(list, { ...DEFAULT_FILTERS, query: '材质' })).toHaveLength(2)
  })
})

describe('⑤ 计数函数收「一组 kind」：材质节点 = 两类之和', () => {
  const list = [
    asset({ kind: 'texture', category1: '石材', category2: '水磨石' }),
    asset({ kind: 'texture', category1: '石材', category2: '岩板' }),
    asset({ kind: 'material', category1: '石材', category2: '水磨石' }),
    asset({ kind: 'material', category1: '布料', category2: '棉布' }),
    asset({ kind: 'model', category1: '家具', category2: '沙发' })
  ]

  it('countLevel1([texture,material]) 求和，且不含模型', () => {
    const nodes = countLevel1(list, KIND_GROUP_MEMBERS.materialGroup)
    const byValue = new Map(nodes.map((n) => [n.value, n.count]))
    expect(byValue.get('石材')).toBe(3)
    expect(byValue.get('布料')).toBe(1)
    expect(byValue.has('家具')).toBe(false)
  })

  it('countLevel2([texture,material], 石材) 跨两类求和', () => {
    const nodes = countLevel2(list, KIND_GROUP_MEMBERS.materialGroup, '石材')
    const byValue = new Map(nodes.map((n) => [n.value, n.count]))
    expect(byValue.get('水磨石')).toBe(2) // 1 texture + 1 material
    expect(byValue.get('岩板')).toBe(1)
  })

  it('单值调用语义不变（既有 22 条用例的契约）', () => {
    expect(countLevel1(list, 'texture').find((n) => n.value === '石材')!.count).toBe(2)
    expect(countLevel1(list, 'material').find((n) => n.value === '石材')!.count).toBe(1)
    expect(countLevel1(list, 'hdri')).toEqual([])
  })

  it('duplicatedLevel2Names 也接受一组 kind（跨两类重名照样合并判定）', () => {
    const dupList = [
      asset({ kind: 'texture', category1: 'A', category2: '同名' }),
      asset({ kind: 'material', category1: 'B', category2: '同名' })
    ]
    expect(duplicatedLevel2Names(dupList, KIND_GROUP_MEMBERS.materialGroup)).toEqual(new Set(['同名']))
    expect(duplicatedLevel2Names(dupList, 'texture')).toEqual(new Set())
  })
})

describe('侧栏展开语义：分组哨兵同样支持「首次点击即展开」', () => {
  it('分组 key 与单值 key 行为一致', () => {
    expect(nextExpandKind(false, MATERIAL_GROUP)).toBe(MATERIAL_GROUP)
    expect(nextExpandKind(true, MATERIAL_GROUP)).toBeNull()
    expect(nextExpandKind(false, 'model')).toBe('model')
    expect(nextExpandKind(true, 'model')).toBeNull()
  })
})

describe('⑥ 接线守卫（组件测不了，守源码契约；防回退成"两行大类"）', () => {
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

  it('Sidebar：遍历 KIND_NAV_ORDER、点击写分组哨兵、不再引用已删除的 KIND_ORDER', () => {
    const src = read('../src/renderer/components/Sidebar.tsx')
    expect(src).toContain('KIND_NAV_ORDER')
    expect(src).not.toContain('KIND_ORDER')
    expect(src).toContain('MATERIAL_GROUP')
    // 点击大类的 setFilter 必须写 `kind: node`（node 可能是分组哨兵），不能写死某个 kind
    expect(src).toMatch(/setFilter\(\{\s*kind:\s*node/)
    // 两个 kind chip 的精确筛选入口
    expect(src).toMatch(/kind:\s*on\s*\?\s*MATERIAL_GROUP\s*:\s*member/)
  })

  it('store：合并走单个 Dexie 事务 put，且无 delete（禁止 delete+put 丢 tags）', () => {
    const src = read('../src/renderer/store.ts')
    expect(src).toContain('materialMergeBusy')
    // 事务形态：db.transaction('rw', db.assets, ...) + db.assets.put
    expect(src).toMatch(/db\.transaction\('rw',\s*db\.assets/)
    expect(src).toContain('db.assets.put(u)')
    // 合并路径里不能出现 delete（主键不变，只能 put 原地覆盖）
    const start = src.indexOf('async mergeMaterial(opts)')
    const mergeBlock = src.slice(start, src.indexOf('openCategoryPicker(ids) {', start))
    expect(mergeBlock).not.toContain('db.assets.delete')
    expect(mergeBlock).not.toContain('bulkDelete')
    // 顺序：先合并，再布局迁移
    expect(mergeBlock.indexOf('maybeAutoMigrate')).toBeGreaterThan(mergeBlock.indexOf('db.transaction'))
  })
})
