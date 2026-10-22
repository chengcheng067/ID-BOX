import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  RESOLUTION_LABEL,
  RESOLUTION_LONG_EDGE,
  RESOLUTION_QUICK_OPTIONS,
  activeFilterDimensions,
  applyFilters,
  assetLongEdge,
  matchesFilters,
  matchesResolution,
  resolutionMinEdge,
  type Filters
} from '../src/renderer/logic/filters'

/**
 * 0.6.0「贴图分辨率筛选」的判定口径：
 * - 命中 = **该资产任一图片文件**的长边 ≥ 2048（2K）/ ≥ 4096（4K）；
 * - 未知尺寸（旧索引没有 `AssetFile.w/h`）**不进**这两档 —— 宁可漏，不可猜；
 * - `null` = 不限（全部放行）。
 */

let seq = 0

function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
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

function file(rel: string, w?: number, h?: number): Asset['files'][number] {
  return {
    rel,
    name: rel,
    ext: rel.slice(rel.lastIndexOf('.') + 1),
    size: 1,
    kind: 'texture',
    ...(typeof w === 'number' ? { w } : {}),
    ...(typeof h === 'number' ? { h } : {})
  }
}

function f(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

describe('常量与选项表', () => {
  it('阈值固定为 2048 / 4096', () => {
    expect(RESOLUTION_LONG_EDGE['2k']).toBe(2048)
    expect(RESOLUTION_LONG_EDGE['4k']).toBe(4096)
  })

  it('浮层选项与体积同构：不限 + 两档', () => {
    expect(RESOLUTION_QUICK_OPTIONS.map((o) => o.value)).toEqual([null, '2k', '4k'])
    expect(RESOLUTION_QUICK_OPTIONS.map((o) => o.label)).toEqual([
      '不限',
      RESOLUTION_LABEL['2k'],
      RESOLUTION_LABEL['4k']
    ])
  })

  it('resolutionMinEdge：未知值不会变成阈值', () => {
    expect(resolutionMinEdge(null)).toBeNull()
    // 运行时脏值（旧 settings / 手改 json）→ 视为不启用
    expect(resolutionMinEdge('8k' as unknown as '2k')).toBeNull()
  })
})

describe('assetLongEdge（取所有已知尺寸图片的最大长边）', () => {
  it('横图 / 竖图都按长边算', () => {
    expect(assetLongEdge(asset({ files: [file('a.png', 2048, 1024)] }))).toBe(2048)
    expect(assetLongEdge(asset({ files: [file('a.png', 1024, 2048)] }))).toBe(2048)
  })

  it('多文件取最大值（一张小图不会把资产拉低）', () => {
    const a = asset({ files: [file('a.png', 256, 256), file('b.jpg', 4096, 1024)] })
    expect(assetLongEdge(a)).toBe(4096)
  })

  it('全是未知尺寸 → null（旧索引的常态）', () => {
    expect(assetLongEdge(asset({ files: [file('a.png'), file('b.skp')] }))).toBeNull()
    expect(assetLongEdge(asset({ files: [] }))).toBeNull()
  })

  it('非法尺寸（0 / NaN）不参与计算', () => {
    const a = asset({ files: [file('a.png', 0, 0), file('b.png', Number.NaN, 10)] })
    expect(assetLongEdge(a)).toBeNull()
  })
})

describe('matchesResolution / matchesFilters', () => {
  it('2K：2048 命中（阈值含等号），1024 不命中', () => {
    expect(matchesResolution(asset({ files: [file('a.png', 2048, 2048)] }), '2k')).toBe(true)
    expect(matchesResolution(asset({ files: [file('a.png', 1024, 1024)] }), '2k')).toBe(false)
  })

  it('4K：4096 命中，2048 不命中（2K 档 ≠ 4K 档）', () => {
    expect(matchesResolution(asset({ files: [file('a.png', 4096, 4096)] }), '4k')).toBe(true)
    expect(matchesResolution(asset({ files: [file('a.png', 2048, 2048)] }), '4k')).toBe(false)
  })

  it('未知尺寸：2K / 4K 都不进，但不限（null）照常放行', () => {
    const unknown = asset({ files: [file('a.png')] })
    expect(matchesResolution(unknown, '2k')).toBe(false)
    expect(matchesResolution(unknown, '4k')).toBe(false)
    expect(matchesResolution(unknown, null)).toBe(true)
  })

  it('matchesFilters 里生效（且与其它维度 AND）', () => {
    const hd = asset({ files: [file('a.png', 2560, 1440)] })
    const sd = asset({ files: [file('a.png', 1024, 1024)] })
    expect(matchesFilters(hd, f({ minResolution: '2k' }))).toBe(true)
    expect(matchesFilters(sd, f({ minResolution: '2k' }))).toBe(false)
    // 不限 → 两条都出
    expect(matchesFilters(sd, f({ minResolution: null }))).toBe(true)
    // 与搜索词 AND：搜索词不命中 → 即便分辨率达标也 false
    expect(matchesFilters(hd, f({ minResolution: '2k', query: '不存在的东西' }))).toBe(false)
  })

  it('applyFilters 端到端：4K 只留 4096 长边的那条', () => {
    const list = [
      asset({ name: '4k贴图', files: [file('a.png', 4096, 2048)] }),
      asset({ name: '2k贴图', files: [file('a.png', 2048, 2048)] }),
      asset({ name: '旧资产', files: [file('a.png')] })
    ]
    const out = applyFilters(list, f({ minResolution: '4k' }))
    expect(out.map((a) => a.name)).toEqual(['4k贴图'])
  })

  it('回收站视图忽略分辨率（只吃搜索词）', () => {
    const deleted = asset({ files: [file('a.png', 1024, 1024)], deletedAt: 1 })
    expect(matchesFilters(deleted, f({ minResolution: '4k' }), undefined, 'trash')).toBe(true)
  })
})

describe('activeFilterDimensions', () => {
  it('分辨率生效时出现在维度摘要里（空态提示用）', () => {
    const dims = activeFilterDimensions(f({ minResolution: '2k' }))
    const res = dims.find((d) => d.key === 'resolution')
    expect(res).toBeDefined()
    expect(res?.label).toBe('分辨率')
    expect(res?.value).toBe(RESOLUTION_LABEL['2k'])
  })

  it('不限时不出现', () => {
    expect(activeFilterDimensions(f()).some((d) => d.key === 'resolution')).toBe(false)
  })
})
