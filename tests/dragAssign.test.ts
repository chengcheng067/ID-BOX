/**
 * 反馈 6d「拖拽归类」纯逻辑单测（被测对象：`src/renderer/logic/dragAssign.ts`）。
 *
 * 覆盖四块：
 * ① 拖拽载荷序列化/解析（含非法输入、去重、封顶）；
 * ② 抓手拖哪些资产（多选语义）；
 * ③ 投放判定（大类范围 / 已在目标分类 / 未知 id / 目标分类规范化）；
 * ④ 撤销记录快照与按原分类对分组。
 */
import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import {
  ASSET_DRAG_MIME,
  ASSIGN_GRACE_MS,
  MAX_DRAG_IDS,
  buildAssignUndo,
  categoryPairLabel,
  dragIdsOf,
  groupAssignUndo,
  hasAssetDragPayload,
  parseDragIds,
  planDropAssign,
  serializeDragIds
} from '../src/renderer/logic/dragAssign'

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${seq}`,
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
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    ...patch
  }
}

describe('dragAssign · 载荷序列化 / 解析', () => {
  it('roundtrip 保序、去重、去空白；空字符串项被丢弃', () => {
    const raw = serializeDragIds([' a ', 'b', 'a', '', '  '])
    expect(raw).toBe(JSON.stringify(['a', 'b']))
    expect(parseDragIds(raw)).toEqual(['a', 'b'])
  })

  it('非法载荷一律返回空数组（不抛）', () => {
    expect(parseDragIds(null)).toEqual([])
    expect(parseDragIds(undefined)).toEqual([])
    expect(parseDragIds('')).toEqual([])
    expect(parseDragIds('not json')).toEqual([])
    expect(parseDragIds('{"id":"a"}')).toEqual([])
    expect(parseDragIds('[1,2,3]')).toEqual([])
    // 混型数组：只收字符串
    expect(parseDragIds('["a",1,null,["b"],"c"]')).toEqual(['a', 'c'])
  })

  it(`单次载荷封顶 ${MAX_DRAG_IDS} 个 id（防御异常载荷放大成 N 次 IPC）`, () => {
    const many = Array.from({ length: MAX_DRAG_IDS + 20 }, (_, i) => `id-${i}`)
    expect(parseDragIds(serializeDragIds(many)).length).toBe(MAX_DRAG_IDS)
    expect(JSON.parse(serializeDragIds(many)).length).toBe(MAX_DRAG_IDS)
  })

  it('hasAssetDragPayload 只认自定义 MIME（系统级拖出没有它）', () => {
    expect(hasAssetDragPayload([ASSET_DRAG_MIME])).toBe(true)
    expect(hasAssetDragPayload(['text/plain', ASSET_DRAG_MIME])).toBe(true)
    expect(hasAssetDragPayload(['text/plain', 'Files'])).toBe(false)
    expect(hasAssetDragPayload([])).toBe(false)
    expect(hasAssetDragPayload(null)).toBe(false)
    expect(hasAssetDragPayload(undefined)).toBe(false)
  })

  it('撤销宽限期固定 5 秒（docs/15 §6d）', () => {
    expect(ASSIGN_GRACE_MS).toBe(5000)
  })
})

describe('dragAssign · 抓手带走哪些资产（多选语义）', () => {
  it('卡片不在多选集合里 → 只拖这一张', () => {
    expect(dragIdsOf('a', ['b', 'c'])).toEqual(['a'])
    expect(dragIdsOf('a', [])).toEqual(['a'])
  })

  it('卡片已在多选集合里 → 拖全部选中项', () => {
    expect(dragIdsOf('a', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('单选集合与未选中等价（不会因为长度 1 而丢 id）', () => {
    expect(dragIdsOf('a', ['a'])).toEqual(['a'])
  })
})

describe('dragAssign · 投放判定 planDropAssign', () => {
  it('混合投放：已在目标分类的计入 already、不进入 ids；需移动的进入 ids', () => {
    const a = asset({ category1: '家具', category2: '沙发' }) // 已在目标
    const b = asset({ category1: '家具', category2: '椅子' }) // 需移动
    const c = asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED }) // 需移动

    const plan = planDropAssign([a, b, c], [a.id, b.id, c.id], {
      scope: 'model',
      category1: '家具',
      category2: '沙发'
    })

    expect(plan.ids).toEqual([b.id, c.id])
    expect(plan.already).toBe(1)
    expect(plan.outOfScope).toBe(0)
    expect(plan.unknown).toBe(0)
    expect(plan.total).toBe(3)
    expect(plan.label).toBe('家具 / 沙发')
  })

  it('跨大类：节点范围不含该 kind → 计入 outOfScope（组件据此整批取消）', () => {
    const model = asset({ kind: 'model' })
    const texture = asset({ kind: 'texture' })

    const plan = planDropAssign([model, texture], [model.id, texture.id], {
      scope: 'model',
      category1: '家具',
      category2: UNCLASSIFIED
    })

    expect(plan.outOfScope).toBe(1)
    expect(plan.ids).toEqual([model.id])
  })

  it('「材质」分组节点同时覆盖 texture 与 material（两个成员都不算跨大类）', () => {
    const tex = asset({ kind: 'texture' })
    const mat = asset({ kind: 'material' })

    const plan = planDropAssign([tex, mat], [tex.id, mat.id], {
      scope: ['texture', 'material'],
      category1: '石材',
      category2: '大理石'
    })

    expect(plan.outOfScope).toBe(0)
    expect(plan.ids).toEqual([tex.id, mat.id])
  })

  it('目标分类与 store 同源规范化：(未分类, 有值) → (未分类, 未分类)，已在未分类的不会白搬', () => {
    const a = asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED })
    const plan = planDropAssign([a], [a.id], {
      scope: 'model',
      category1: UNCLASSIFIED,
      category2: '沙发'
    })
    expect(plan.category2).toBe(UNCLASSIFIED)
    expect(plan.already).toBe(1)
    expect(plan.ids).toEqual([])
  })

  it('索引里不存在的 id 计入 unknown 并丢弃（陈旧 DOM / 刚被删除）', () => {
    const a = asset()
    const plan = planDropAssign([a], [a.id, 'ghost'], {
      scope: 'model',
      category1: '家具',
      category2: UNCLASSIFIED
    })
    expect(plan.unknown).toBe(1)
    expect(plan.total).toBe(2)
    expect(plan.ids).toEqual([a.id])
  })

  it('空载荷 / 全部未知 → ids 为空、total 为 0（组件必须静默 return）', () => {
    expect(planDropAssign([], [], { scope: 'model', category1: '家具', category2: UNCLASSIFIED })).toEqual({
      ids: [],
      total: 0,
      already: 0,
      outOfScope: 0,
      unknown: 0,
      category1: '家具',
      category2: UNCLASSIFIED,
      label: '家具'
    })
  })
})

describe('dragAssign · 撤销记录（快照 + 分组）', () => {
  it('buildAssignUndo 只收录指定 id，按资产顺序快照原分类', () => {
    const a = asset({ category1: '家具', category2: '沙发' })
    const b = asset({ category1: '灯具', category2: '吊灯' })
    const c = asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED })

    expect(buildAssignUndo([a, b, c], [c.id, a.id, 'ghost'])).toEqual([
      { id: a.id, category1: '家具', category2: '沙发' },
      { id: c.id, category1: UNCLASSIFIED, category2: UNCLASSIFIED }
    ])
  })

  it('groupAssignUndo 按原分类对分组（assignCategory 一次只吃一个分类对）', () => {
    const groups = groupAssignUndo([
      { id: 'a', category1: '家具', category2: '沙发' },
      { id: 'b', category1: '灯具', category2: '吊灯' },
      { id: 'c', category1: '家具', category2: '沙发' }
    ])
    expect(groups).toEqual([
      { category1: '家具', category2: '沙发', ids: ['a', 'c'] },
      { category1: '灯具', category2: '吊灯', ids: ['b'] }
    ])
  })

  it('分隔符碰撞不会串组（不同分类对永远是不同组）', () => {
    // 「A / B\u0000C」与「A\u0000B / C」这类构造不能靠裸拼接混成一组
    const groups = groupAssignUndo([
      { id: 'a', category1: 'A', category2: 'B\u0000C' },
      { id: 'b', category1: 'A\u0000B', category2: 'C' }
    ])
    expect(groups.length).toBe(2)
  })

  it('空记录 → 空分组（撤销时不应发任何请求）', () => {
    expect(groupAssignUndo([])).toEqual([])
  })

  it('categoryPairLabel：二级为未分类时只显示一级', () => {
    expect(categoryPairLabel('家具', UNCLASSIFIED)).toBe('家具')
    expect(categoryPairLabel('家具', '沙发')).toBe('家具 / 沙发')
    expect(categoryPairLabel('', '')).toBe(UNCLASSIFIED)
  })
})
