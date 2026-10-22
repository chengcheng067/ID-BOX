import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import { formatDate } from '../src/shared/format'
import {
  DEFAULT_FILTERS,
  activeFilterDimensions,
  activeImportedRange,
  activeSizeRange,
  applyFilters,
  compactBytes,
  describeNumericFilters,
  matchesFilters,
  sizePresetLabel,
  sizePresetOf,
  startOfYear,
  timePresetOf,
  timePresetRange,
  type Filters
} from '../src/renderer/logic/filters'

/**
 * v0.4 数值筛选（体积 / 导入时间）的纯逻辑测试。
 *
 * 最重要的一条是「**非法区间不启用**」：min > max 时必须放行全部资产，
 * 绝不能筛成空——那会让用户以为库被清空了。
 */

const MB = 1024 * 1024
const DAY = 86_400_000

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [],
    size: 1 * MB,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
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

// ── 体积 ────────────────────────────────────────────────────────

describe('体积区间（minBytes / maxBytes）', () => {
  const small = asset({ name: '小', size: 5 * MB })
  const mid = asset({ name: '中', size: 50 * MB })
  const big = asset({ name: '大', size: 500 * MB })
  const all = [small, mid, big]

  it('只有 minBytes：只看大于等于下界的资产', () => {
    const out = applyFilters(all, f({ minBytes: 50 * MB }))
    expect(out.map((a) => a.name).sort()).toEqual(['中', '大'])
  })

  it('只有 maxBytes：只看小于等于上界的资产', () => {
    const out = applyFilters(all, f({ maxBytes: 50 * MB }))
    // 用同一套默认 sort 归一（中文按 UTF-16 码元，写死字面量顺序容易踩坑）
    expect(out.map((a) => a.name).sort()).toEqual(['小', '中'].sort())
  })

  it('两端都给：闭区间，边界值被命中', () => {
    const out = applyFilters(all, f({ minBytes: 50 * MB, maxBytes: 500 * MB }))
    expect(out.map((a) => a.name).sort()).toEqual(['中', '大'])
    expect(matchesFilters(mid, f({ minBytes: 50 * MB, maxBytes: 500 * MB }))).toBe(true)
  })

  it('两端都 null → 该维度不启用（全部放行）', () => {
    expect(activeSizeRange(f())).toBeNull()
    expect(applyFilters(all, f()).length).toBe(3)
  })

  it('非法区间（min > max）→ 不启用，**不是**筛成空', () => {
    const bad = f({ minBytes: 500 * MB, maxBytes: 1 * MB })
    expect(activeSizeRange(bad)).toBeNull()
    expect(applyFilters(all, bad).length).toBe(3)
    expect(matchesFilters(small, bad)).toBe(true)
  })

  it('非有限数（NaN）按 null 处理，不参与过滤', () => {
    expect(activeSizeRange(f({ minBytes: Number.NaN, maxBytes: null }))).toBeNull()
  })

  it('sizePresetOf：预设精确命中，自定义下界返回 null', () => {
    expect(sizePresetOf(f({ minBytes: 50 * MB }))).toBe(50 * MB)
    expect(sizePresetOf(f({ minBytes: 42 * MB }))).toBeNull()
    expect(sizePresetOf(f({ minBytes: 50 * MB, maxBytes: 200 * MB }))).toBeNull()
    expect(sizePresetOf(f())).toBeNull()
  })

  it('preset 文案与 compactBytes', () => {
    expect(sizePresetLabel(10 * MB)).toBe('> 10MB')
    expect(sizePresetLabel(200 * MB)).toBe('> 200MB')
    expect(compactBytes(0)).toBe('0B')
    expect(compactBytes(1536)).toBe('1.5KB')
    expect(compactBytes(1.5 * 1024 * MB)).toBe('1.5GB')
    expect(compactBytes(50 * MB)).toBe('50MB')
  })
})

// ── 导入时间 ────────────────────────────────────────────────────

describe('导入时间区间（importedAfter / importedBefore，含等号）', () => {
  const T = 1_700_000_000_000
  const before = asset({ name: '更早', importedAt: T - DAY })
  const exact = asset({ name: '正好', importedAt: T })
  const after = asset({ name: '更新', importedAt: T + DAY })
  const all = [before, exact, after]

  it('importedAfter 含边界：正好等于阈值的资产被命中', () => {
    const out = applyFilters(all, f({ importedAfter: T }))
    expect(out.map((a) => a.name).sort()).toEqual(['正好', '更新'].sort())
  })

  it('importedBefore 含边界：正好等于阈值的资产被命中', () => {
    const out = applyFilters(all, f({ importedBefore: T }))
    expect(out.map((a) => a.name).sort()).toEqual(['更早', '正好'])
  })

  it('两端都给 + 非法区间（after > before）→ 不启用', () => {
    expect(activeImportedRange(f({ importedAfter: T + DAY, importedBefore: T }))).toBeNull()
    expect(applyFilters(all, f({ importedAfter: T + DAY, importedBefore: T })).length).toBe(3)
  })

  it('两端都 null → 不启用', () => {
    expect(activeImportedRange(f())).toBeNull()
    expect(applyFilters(all, f()).length).toBe(3)
  })

  it('timePresetRange / timePresetOf 往返一致（7 天 / 30 天 / 今年）', () => {
    const now = new Date(2026, 9, 20, 12, 0, 0).getTime() // 2026-10-20 12:00 本地
    for (const key of ['7d', '30d', 'year'] as const) {
      const range = timePresetRange(key, now)
      expect(range.importedBefore).toBeNull()
      expect(timePresetOf(f({ importedAfter: range.importedAfter }), now)).toBe(key)
    }
    expect(timePresetRange('year', now).importedAfter).toBe(startOfYear(now))
  })

  it('timePresetOf：只有 before / 自定义边界 → null', () => {
    const now = new Date(2026, 9, 20, 12, 0, 0).getTime()
    expect(timePresetOf(f({ importedBefore: now }), now)).toBeNull()
    expect(timePresetOf(f({ importedAfter: now - 100 * DAY }), now)).toBeNull()
    expect(timePresetOf(f(), now)).toBeNull()
  })
})

// ── 交集 ────────────────────────────────────────────────────────

describe('数值条件与其它维度取交集', () => {
  const hit = asset({
    name: '命中',
    size: 80 * MB,
    favorite: true,
    category1: '家具'
  })
  const notFav = asset({ name: '未收藏', size: 80 * MB, category1: '家具' })
  const tooSmall = asset({ name: '太小', size: 1 * MB, favorite: true, category1: '家具' })
  const otherCat = asset({ name: '别类', size: 80 * MB, favorite: true, category1: '灯具' })

  it('体积 + 收藏 + 分类 三条件同时生效', () => {
    const out = applyFilters(
      [hit, notFav, tooSmall, otherCat],
      f({ minBytes: 50 * MB, favoriteOnly: true, category1: '家具' })
    )
    expect(out.map((a) => a.name)).toEqual(['命中'])
  })

  it('体积 + 导入时间 同时生效', () => {
    const T = 1_700_000_000_000
    const a = asset({ name: 'A', size: 80 * MB, importedAt: T })
    const b = asset({ name: 'B', size: 80 * MB, importedAt: T - 40 * DAY })
    const out = applyFilters([a, b], f({ minBytes: 50 * MB, importedAfter: T - 7 * DAY }))
    expect(out.map((x) => x.name)).toEqual(['A'])
  })
})

// ── 摘要文案 / 维度文案 / 重置 ───────────────────────────────────

describe('describeNumericFilters —— 中栏头条件摘要', () => {
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime()

  it('无筛选 → 空串（调用方据此不渲染）', () => {
    expect(describeNumericFilters(f(), now)).toBe('')
  })

  it('只有体积 → `> 50MB`', () => {
    expect(describeNumericFilters(f({ minBytes: 50 * MB }), now)).toBe('> 50MB')
    expect(describeNumericFilters(f({ maxBytes: 50 * MB }), now)).toBe('< 50MB')
    expect(describeNumericFilters(f({ minBytes: 10 * MB, maxBytes: 50 * MB }), now)).toBe(
      '10MB–50MB'
    )
  })

  it('只有时间 → 近 7 天 / 近 30 天 / 今年', () => {
    for (const key of ['7d', '30d', 'year'] as const) {
      const after = timePresetRange(key, now).importedAfter
      const text = describeNumericFilters(f({ importedAfter: after }), now)
      expect(['近 7 天', '近 30 天', '今年']).toContain(text)
    }
    expect(
      describeNumericFilters(f({ importedAfter: timePresetRange('30d', now).importedAfter }), now)
    ).toBe('近 30 天')
    expect(
      describeNumericFilters(f({ importedAfter: timePresetRange('year', now).importedAfter }), now)
    ).toBe('今年')
  })

  it('两个都有 → 体积在前、时间在后，用 ` · ` 分隔', () => {
    const text = describeNumericFilters(
      f({ minBytes: 50 * MB, importedAfter: timePresetRange('30d', now).importedAfter }),
      now
    )
    expect(text).toBe('> 50MB · 近 30 天')
    expect(text.split(' · ').length).toBe(2)
  })

  it('自定义时间区间 → 落到具体日期文案', () => {
    const after = new Date(2026, 0, 2, 3, 4).getTime()
    const before = new Date(2026, 2, 4, 5, 6).getTime()
    expect(describeNumericFilters(f({ importedAfter: after, importedBefore: before }), now)).toBe(
      `${formatDate(after)} ~ ${formatDate(before)}`
    )
    expect(describeNumericFilters(f({ importedBefore: before }), now)).toBe(
      `${formatDate(before)} 之前`
    )
  })

  it('非法区间不产生摘要（与匹配逻辑同口径）', () => {
    expect(describeNumericFilters(f({ minBytes: 100 * MB, maxBytes: 1 * MB }), now)).toBe('')
  })
})

describe('activeFilterDimensions 与重置', () => {
  const now = Date.now()

  it('生效时列出「体积 / 导入时间」两个维度', () => {
    const dims = activeFilterDimensions(
      f({
        minBytes: 50 * MB,
        importedAfter: timePresetRange('7d', now).importedAfter
      })
    )
    const map = new Map(dims.map((d) => [d.key, d.value]))
    expect(map.get('size')).toBe('> 50MB')
    expect(map.get('importedAt')).toBe('近 7 天')
  })

  it('DEFAULT_FILTERS 能清掉这四项', () => {
    expect(DEFAULT_FILTERS.minBytes).toBeNull()
    expect(DEFAULT_FILTERS.maxBytes).toBeNull()
    expect(DEFAULT_FILTERS.importedAfter).toBeNull()
    expect(DEFAULT_FILTERS.importedBefore).toBeNull()

    const dirty = f({
      minBytes: 50 * MB,
      maxBytes: 500 * MB,
      importedAfter: 1,
      importedBefore: 2
    })
    const cleared = { ...dirty, ...DEFAULT_FILTERS }
    expect(cleared.minBytes).toBeNull()
    expect(cleared.maxBytes).toBeNull()
    expect(cleared.importedAfter).toBeNull()
    expect(cleared.importedBefore).toBeNull()
  })
})
