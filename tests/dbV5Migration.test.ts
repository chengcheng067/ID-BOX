/**
 * Dexie v5 迁移（C 线「最近删除」+ D 线别名词典占位）。
 *
 * 无 fake-indexeddb 依赖 → 不实例化 IndexedDB，而是直测**迁移纯函数**与
 * **索引串常量**（形状钉死，D 线按它写 `.where('key')`）。
 * 幂等性是本文件的核心断言：连跑两次结果必须完全一致。
 */
import { describe, expect, it } from 'vitest'
import {
  ALIASES_STORE_SCHEMA,
  applyAssetV5,
  ASSETS_V5_STORE_SCHEMA
} from '../src/renderer/db'
import type { Asset } from '../src/shared/types'

function asset(patch: Partial<Asset> = {}): Asset {
  return {
    id: 'a1b2c3d4-1111-4222-8333-444455556666',
    name: '沙发',
    kind: 'model',
    source: '知末网',
    folder: 'E:\\ModVault\\Library\\模型\\未分类\\未分类\\沙发',
    relFolder: '模型/未分类/未分类/沙发',
    files: [],
    size: 0,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'model:沙发',
    importedAt: 1,
    updatedAt: 1,
    ...patch
  }
}

describe('applyAssetV5（v4→v5 单条迁移）', () => {
  it('老记录没有 deletedAt → 保持 undefined（不补 0、不补 null）', () => {
    const out = applyAssetV5(asset())
    expect('deletedAt' in out).toBe(false)
    expect(out.deletedAt).toBeUndefined()
  })

  it('历史脏值 0 / null → 删掉（否则全部老资产会落进 deletedAt 索引）', () => {
    const zero = applyAssetV5(asset({ deletedAt: 0 }))
    const nul = applyAssetV5(asset({ deletedAt: null as unknown as number }))
    expect('deletedAt' in zero).toBe(false)
    expect('deletedAt' in nul).toBe(false)
  })

  it('真实软删时间戳保留（幂等）', () => {
    const out = applyAssetV5(asset({ deletedAt: 1700000000000, trashRel: '.trash/a1' }))
    expect(out.deletedAt).toBe(1700000000000)
    expect(out.trashRel).toBe('.trash/a1')
  })

  it('连跑两次结果完全一致（迁移必须幂等）', () => {
    const input = asset()
    const once = applyAssetV5(input)
    const twice = applyAssetV5(once)
    expect(twice).toEqual(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('幂等：带脏值的记录连跑两次同样收敛到同一结果', () => {
    const input = asset({ deletedAt: 0 })
    const once = applyAssetV5(input)
    const twice = applyAssetV5(once)
    expect('deletedAt' in twice).toBe(false)
    expect(twice).toEqual(once)
  })

  it('不触碰其它字段（tags/note/favorite 等原样保留）', () => {
    const input = asset({ tags: ['木'], note: '备注', favorite: true, rating: 4 })
    const out = applyAssetV5(input)
    expect(out.tags).toEqual(['木'])
    expect(out.note).toBe('备注')
    expect(out.favorite).toBe(true)
    expect(out.rating).toBe(4)
  })
})

describe('v5 索引串（形状契约）', () => {
  it('assets 新增 deletedAt 索引，且保留 v4 的全部索引', () => {
    const indexes = ASSETS_V5_STORE_SCHEMA.split(',').map((s) => s.trim())
    expect(indexes).toContain('deletedAt')
    for (const k of ['id', 'kind', 'category1', 'category2', '*styles', 'dedupeKey', 'folder']) {
      expect(indexes).toContain(k)
    }
  })

  it('aliases 表：keyPath id + 索引 key / scope（D 线按此使用）', () => {
    const indexes = ALIASES_STORE_SCHEMA.split(',').map((s) => s.trim())
    expect(indexes).toEqual(['id', 'key', 'scope'])
  })
})
