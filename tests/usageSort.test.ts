/**
 * 「最近使用」/「最常使用」两个排序键（2026-10 使用统计的用户可见一半）。
 *
 * 数据层（`Asset.useCount` / `Asset.lastUsedAt` + `recordAssetUse` 打点）在
 * `tests/useStats.test.ts`；本文件只管**排序语义**：
 *
 * ① `usageScore` 的数值真值表（含时间衰减、时钟回拨、脏值）；
 * ② 「最近使用」：**从未使用的必须排在最后**（最容易写反的一处，两个方向都钉）；
 * ③ 「最常使用」：时间衰减真的能让"昨天用 3 次"压过"90 天前用 20 次"；
 * ④ 两个新键 × `sortDesc` 三态（`null` / `true` / `false`）的完整矩阵；
 * ⑤ 平局：先 `lastUsedAt` 降序、再名称升序，且**次级键不跟方向反**；
 * ⑥ 出厂行为零变化：`DEFAULT_FILTERS.sort` 仍是 `'recent'`，`SORT_OPTIONS` 前两项是新键，
 *    且 `sortAssets(list, 'recent')` 与 `sortAssets(list, 'recent', null)` 逐元素相同。
 *
 * 全部用例都传**固定的 `now`**：`sortAssets` 的第四参默认取 `Date.now()`，
 * 不传会让期望值随日历漂移（今天算 13.9 天、明天算 14.1 天，一个"恒等于 1.5"的断言就红了）。
 */
import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  NATURAL_SORT_DESC,
  SORT_OPTIONS,
  USAGE_HALF_LIFE_DAYS,
  effectiveSortDesc,
  sortAssets,
  usageScore,
  type SortKey
} from '../src/renderer/logic/filters'

/** 一天的毫秒数（与实现里的 `MS_PER_DAY` 独立写一份：测试不该复用被测常量） */
const DAY = 86_400_000

/** 打分基准时间（固定值，用例永不随真实时钟漂移） */
const NOW = 1_760_000_000_000

let seq = 0

function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\资产${seq}`,
    relFolder: `模型/资产${seq}`,
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

function ids(list: Asset[]): string[] {
  return list.map((a) => a.id)
}

describe('usageScore · 真值表', () => {
  it('从未使用（两个字段都缺）→ 0', () => {
    expect(usageScore(undefined, undefined, NOW)).toBe(0)
  })

  it('有 lastUsedAt 但没计数（useCount 缺失 / 0）→ 0（没使用过就没有分）', () => {
    expect(usageScore(undefined, NOW - DAY, NOW)).toBe(0)
    expect(usageScore(0, NOW - DAY, NOW)).toBe(0)
  })

  it('刚好一个半衰期（14 天）→ 分数减半', () => {
    // 3 * 2^(-14/14) = 3 * 0.5 = 1.5
    expect(usageScore(3, NOW - 14 * DAY, NOW)).toBeCloseTo(1.5, 12)
  })

  it('两个半衰期（28 天）→ 再减半（1/4）', () => {
    // 3 * 2^(-28/14) = 3 * 0.25 = 0.75
    expect(usageScore(3, NOW - 28 * DAY, NOW)).toBeCloseTo(0.75, 12)
  })

  it('半衰期是 14 天且被导出（可调参数，不是定律）', () => {
    expect(USAGE_HALF_LIFE_DAYS).toBe(14)
  })

  it('刚用完（age = 0）→ 分数就是次数本身', () => {
    expect(usageScore(7, NOW, NOW)).toBeCloseTo(7, 12)
  })

  it('lastUsedAt 在未来（时钟回拨）→ 按 ageDays = 0 处理，分数不超过次数', () => {
    // 若不夹紧，负指数会让分数 > 次数（一次系统时钟故障就能把某个资产顶成"最常用"）
    expect(usageScore(3, NOW + 5 * DAY, NOW)).toBeCloseTo(3, 12)
    expect(usageScore(3, NOW + 5 * DAY, NOW)).toBeLessThanOrEqual(3)
  })

  it('脏值（NaN / Infinity / 负数次数）→ 0，不产生 NaN 分数', () => {
    expect(usageScore(Number.NaN, NOW, NOW)).toBe(0)
    expect(usageScore(-4, NOW, NOW)).toBe(0)
    expect(usageScore(3, Number.NaN, NOW)).toBe(0)
    expect(usageScore(3, Number.POSITIVE_INFINITY, NOW)).toBe(0)
  })
})

describe('sortAssets · 最近使用', () => {
  /**
   * 夹具：两个"用过"（不同时间）+ 两个"从没用过"。
   *
   * | id | name | lastUsedAt |
   * |----|------|-----------|
   * | a  | A    | undefined（从未使用） |
   * | b  | B    | NOW - 1 天（最近用过） |
   * | c  | C    | NOW - 30 天（很久以前用过） |
   * | d  | D    | undefined（从未使用） |
   */
  function fixture(): Asset[] {
    return [
      asset({ id: 'a', name: 'A' }),
      asset({ id: 'b', name: 'B', useCount: 2, lastUsedAt: NOW - 1 * DAY }),
      asset({ id: 'c', name: 'C', useCount: 9, lastUsedAt: NOW - 30 * DAY }),
      asset({ id: 'd', name: 'D' })
    ]
  }

  it('降序（默认）：最近用过的最前，**从未使用的排在最后**', () => {
    // 这是本功能最容易写反的一条：若把 undefined 当成 0（1970-01-01），
    // 一旦方向翻成升序，"从没用过"的会冲到全库最前面。
    expect(ids(sortAssets(fixture(), 'lastUsed'))).toEqual(['b', 'c', 'a', 'd'])
    expect(ids(sortAssets(fixture(), 'lastUsed', null, NOW))).toEqual(['b', 'c', 'a', 'd'])
    expect(ids(sortAssets(fixture(), 'lastUsed', true, NOW))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('升序：时间轴反过来，但**从未使用仍然在最后**（不跟着方向翻）', () => {
    // 若实现用 0 当哨兵，这里会变成 ['a','d','c','b'] —— 用户会看到"我没用过的排第一"
    expect(ids(sortAssets(fixture(), 'lastUsed', false, NOW))).toEqual(['c', 'b', 'a', 'd'])
  })

  it('与 useCount 无关（用得少但更近 ⇒ 更靠前）', () => {
    const list = [
      asset({ id: 'many-old', name: 'X', useCount: 100, lastUsedAt: NOW - 60 * DAY }),
      asset({ id: 'once-new', name: 'Y', useCount: 1, lastUsedAt: NOW - 1 * DAY })
    ]
    expect(ids(sortAssets(list, 'lastUsed', null, NOW))).toEqual(['once-new', 'many-old'])
    // 反向：最常使用那边应该反过来（次数确实起作用），见下面的用例
    expect(ids(sortAssets(list, 'mostUsed', null, NOW))).toEqual(['many-old', 'once-new'])
  })
})

describe('sortAssets · 最常使用（时间衰减）', () => {
  function fixture(): Asset[] {
    return [
      // 20 次但 90 天前 → 20 * 2^(-90/14) ≈ 0.232
      asset({ id: 'old-heavy', name: 'A', useCount: 20, lastUsedAt: NOW - 90 * DAY }),
      // 3 次但昨天 → 3 * 2^(-1/14) ≈ 2.856
      asset({ id: 'new-light', name: 'B', useCount: 3, lastUsedAt: NOW - 1 * DAY })
    ]
  }

  it('「用了 3 次但昨天」压过「用了 20 次但 90 天前」', () => {
    const [a, b] = fixture()
    const scoreOld = usageScore(a.useCount, a.lastUsedAt, NOW)
    const scoreNew = usageScore(b.useCount, b.lastUsedAt, NOW)
    // 先把分数的相对关系钉死，再断言排序（避免"排序对了但原因不对"）
    expect(scoreNew).toBeGreaterThan(scoreOld)
    expect(ids(sortAssets(fixture(), 'mostUsed', null, NOW))).toEqual(['new-light', 'old-heavy'])
    expect(ids(sortAssets(fixture(), 'mostUsed', true, NOW))).toEqual(['new-light', 'old-heavy'])
    // 升序 = 最不常用的在前
    expect(ids(sortAssets(fixture(), 'mostUsed', false, NOW))).toEqual(['old-heavy', 'new-light'])
  })

  it('useCount 缺失与 0 **同档**（都是 0 分），不另起一档', () => {
    const list = [
      asset({ id: 'never', name: 'A' }), // 两个字段都缺
      asset({ id: 'zero-with-time', name: 'B', useCount: 0, lastUsedAt: NOW - 5 * DAY }),
      asset({ id: 'used', name: 'C', useCount: 1, lastUsedAt: NOW - 5 * DAY })
    ]
    const sorted = ids(sortAssets(list, 'mostUsed', null, NOW))
    expect(sorted[0]).toBe('used')
    // 剩下两个都是 0 分 → 走平局（lastUsedAt 降序）：有时间的在前，缺时间的在后
    expect(sorted.slice(1)).toEqual(['zero-with-time', 'never'])
  })
})

describe('sortAssets · 两个新键 × sortDesc 三态矩阵', () => {
  /**
   * | id | useCount | lastUsedAt |
   * |----|----------|-----------|
   * | a  | 4        | NOW - 2 天  |  → 4 * 2^(-2/14) ≈ 3.63
   * | b  | 4        | NOW - 20 天 |  → 4 * 2^(-20/14) ≈ 1.49
   * | c  | undefined| undefined   |  → 0（从未使用）
   */
  function fixture(): Asset[] {
    return [
      asset({ id: 'a', name: 'A', useCount: 4, lastUsedAt: NOW - 2 * DAY }),
      asset({ id: 'b', name: 'B', useCount: 4, lastUsedAt: NOW - 20 * DAY }),
      asset({ id: 'c', name: 'C' })
    ]
  }

  const EXPECTED: Record<'lastUsed' | 'mostUsed', { asc: string[]; desc: string[] }> = {
    // lastUsed 与 useCount 无关（a、b 次数相同，纯按时间）
    lastUsed: { asc: ['b', 'a', 'c'], desc: ['a', 'b', 'c'] },
    // mostUsed 的分数顺序与时间顺序在这份夹具里恰好一致
    mostUsed: { asc: ['c', 'b', 'a'], desc: ['a', 'b', 'c'] }
  }

  for (const key of ['lastUsed', 'mostUsed'] as const) {
    it(`${key}：sortDesc=false（升序）/ true（降序）/ null（自然方向）`, () => {
      expect(ids(sortAssets(fixture(), key, false, NOW)), `${key} 升序`).toEqual(
        EXPECTED[key].asc
      )
      expect(ids(sortAssets(fixture(), key, true, NOW)), `${key} 降序`).toEqual(
        EXPECTED[key].desc
      )
      expect(ids(sortAssets(fixture(), key, null, NOW)), `${key} 自然方向`).toEqual(
        EXPECTED[key].desc
      )
      // 自然方向 = 降序（两个键都是"新的 / 高的在上"）
      expect(NATURAL_SORT_DESC[key]).toBe(true)
      expect(effectiveSortDesc(key, null)).toBe(true)
    })
  }
})

describe('sortAssets · 平局与稳定性（次级键不跟方向反）', () => {
  it('mostUsed 同分：更近用过的在前，**两个方向都一样**', () => {
    // 分数精确相等：3 * 2^(-14/14) = 1.5 = 6 * 2^(-28/14)
    const list = [
      asset({ id: 'older', name: 'A', useCount: 6, lastUsedAt: NOW - 28 * DAY }),
      asset({ id: 'newer', name: 'B', useCount: 3, lastUsedAt: NOW - 14 * DAY })
    ]
    const s1 = usageScore(list[0]!.useCount, list[0]!.lastUsedAt, NOW)
    const s2 = usageScore(list[1]!.useCount, list[1]!.lastUsedAt, NOW)
    expect(s1).toBeCloseTo(s2, 12) // 前提：真的同分，否则这条用例测的就不是平局

    expect(ids(sortAssets(list, 'mostUsed', null, NOW))).toEqual(['newer', 'older'])
    expect(ids(sortAssets(list, 'mostUsed', true, NOW))).toEqual(['newer', 'older'])
    // 升序时"最少用"的在前，但**同分内部仍按最近使用降序**（不跟着反）
    expect(ids(sortAssets(list, 'mostUsed', false, NOW))).toEqual(['newer', 'older'])
  })

  it('mostUsed 同分同时间：按名称 A→Z，两个方向都一样', () => {
    const t = NOW - 3 * DAY
    const list = [
      asset({ id: 'z', name: 'Zeta', useCount: 2, lastUsedAt: t }),
      asset({ id: 'b', name: 'Beta', useCount: 2, lastUsedAt: t }),
      asset({ id: 'm', name: 'Mike', useCount: 2, lastUsedAt: t })
    ]
    for (const dir of [null, true, false] as const) {
      expect(ids(sortAssets(list, 'mostUsed', dir, NOW)), `sortDesc=${String(dir)}`).toEqual([
        'b',
        'm',
        'z'
      ])
    }
  })

  it('lastUsed 两个都没用过：按名称 A→Z，两个方向都一样', () => {
    const list = [asset({ id: 'z', name: 'Zeta' }), asset({ id: 'b', name: 'Beta' })]
    expect(ids(sortAssets(list, 'lastUsed', true, NOW))).toEqual(['b', 'z'])
    expect(ids(sortAssets(list, 'lastUsed', false, NOW))).toEqual(['b', 'z'])
  })

  it('不修改入参（纯函数）', () => {
    const list = [
      asset({ id: 'a', name: 'A', useCount: 1, lastUsedAt: NOW - DAY }),
      asset({ id: 'b', name: 'B' })
    ]
    const before = ids(list)
    sortAssets(list, 'lastUsed', null, NOW)
    sortAssets(list, 'mostUsed', false, NOW)
    expect(ids(list)).toEqual(before)
  })
})

describe('出厂行为与选项表守门', () => {
  it('SORT_OPTIONS 前两项恰好是「最近使用」「最常使用」', () => {
    expect(SORT_OPTIONS.slice(0, 2).map((o) => o.value)).toEqual(['lastUsed', 'mostUsed'])
    expect(SORT_OPTIONS.slice(0, 2).map((o) => o.label)).toEqual(['最近使用', '最常使用'])
    // 老四项相对顺序不变
    expect(SORT_OPTIONS.slice(2).map((o) => o.value)).toEqual(['recent', 'name', 'size', 'su'])
  })

  it('DEFAULT_FILTERS.sort 仍是 recent（升级后首次打开顺序一个像素都不变）', () => {
    expect(DEFAULT_FILTERS.sort).toBe<'recent'>('recent')
    expect(DEFAULT_FILTERS.sortDesc).toBeNull()
  })

  it('向后兼容：省略第三/四参 ≡ 显式 null（recent 逐元素相同）', () => {
    const list = [
      asset({ id: 'a', importedAt: 3 }),
      asset({ id: 'b', importedAt: 1 }),
      asset({ id: 'c', importedAt: 2 })
    ]
    expect(ids(sortAssets(list, 'recent'))).toEqual(ids(sortAssets(list, 'recent', null)))
    // 老四键都不该受新参数波及
    const keys: SortKey[] = ['recent', 'name', 'size', 'su']
    for (const key of keys) {
      expect(ids(sortAssets(list, key))).toEqual(ids(sortAssets(list, key, null)))
    }
  })
})
