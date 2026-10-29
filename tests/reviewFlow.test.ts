/**
 * 待确认队列（`logic/reviewFlow.ts`）的**纯逻辑**测试（docs/35 · T-08）。
 *
 * `vitest.config.ts` 是 `environment: 'node'`，没有 jsdom → 这里只钉纯函数。
 *
 * 钉住的四件事（错了用户会立刻察觉，但代码里看不出来）：
 * ① `reviewReasonOf` 的五种输入，尤其 `confidence:'none'` **不等于 null**；
 * ② **conflict 优先于 unclassified**（反例：二级恰好是 `未分类` 的 conflict 归 conflict，
 *    不是 unclassified —— 判反了这条会从两个队列同时消失）；
 * ③ `decidedAt` 优先于一切，但 `NaN` / `undefined` 不算定案；
 * ④ `buildReviewQueue(ordered,'unclassified')` 与 `buildTriageQueue(ordered)` **逐 id 相等**
 *    —— 这是防"以后有人改 triageFlow 的判据而 reviewFlow 没跟"的唯一守卫。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildReviewQueue,
  countPendingReview,
  isPendingReview,
  reviewReasonOf
} from '../src/renderer/logic/reviewFlow'
import { buildTriageQueue, isUnclassified } from '../src/renderer/logic/triageFlow'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset, ClassifyReview } from '../src/shared/types'

/**
 * 最小资产夹具（沿用 `tests/triageFlow.test.ts` 的 `asset()` 模式）。
 *
 * 本模块只读 `id` / `category1` / `category2` / `classifyReview` / `deletedAt`，
 * 其余字段给最小占位即可（`Asset` 结构化字段很多，但不参与判定）。
 */
function asset(
  id: string,
  c1: string = UNCLASSIFIED,
  c2: string = UNCLASSIFIED,
  extra: Partial<Asset> = {}
): Asset {
  return { id, name: id, category1: c1, category2: c2, files: [], ...extra } as Asset
}

/** 只关心 `classifyReview` 的便捷构造 */
function withReview(
  id: string,
  review: ClassifyReview | undefined,
  c1: string = UNCLASSIFIED,
  c2: string = UNCLASSIFIED,
  extra: Partial<Asset> = {}
): Asset {
  return asset(id, c1, c2, { classifyReview: review, ...extra })
}

// ── ① reviewReasonOf · 五种输入 ──────────────────────────────────────

describe('reviewReasonOf · 五种输入', () => {
  it('没有 classifyReview + 双未分类 → unclassified', () => {
    expect(reviewReasonOf(withReview('a', undefined))).toBe('unclassified')
  })

  it('★confidence:none + 双未分类 → unclassified（不是 null）', () => {
    // `none` 只表示"两边都空"，不写 reason → 走第 3 条 isUnclassified，
    // 进未分类队列而不是 conflict 队列。判成 null 会让这批资产彻底没人管。
    expect(reviewReasonOf(withReview('a', { confidence: 'none' }))).toBe('unclassified')
    expect(reviewReasonOf(withReview('a', { confidence: 'none' }))).not.toBeNull()
  })

  it('confidence:conflict + reason:conflict + 两级都有值且不同 → conflict', () => {
    expect(
      reviewReasonOf(
        withReview('a', { confidence: 'conflict', reason: 'conflict' }, '工装空间', '办公空间')
      )
    ).toBe('conflict')
  })

  it('confidence:high + 有分类 → null', () => {
    expect(reviewReasonOf(withReview('a', { confidence: 'high' }, '工装空间', '办公空间'))).toBeNull()
  })

  it('confidence:medium-s2 + 有分类 → null（站方单方结论不打扰用户，Q-1）', () => {
    expect(
      reviewReasonOf(withReview('a', { confidence: 'medium-s2' }, '工装空间', '办公空间'))
    ).toBeNull()
  })

  it('null / undefined 入参 → null（不抛）', () => {
    expect(reviewReasonOf(null)).toBeNull()
    expect(reviewReasonOf(undefined)).toBeNull()
  })
})

// ── ② ★ conflict 优先于 unclassified ─────────────────────────────────

describe('reviewReasonOf · 顺序纪律', () => {
  it('★conflict 且二级未分类时仍归 conflict（顺序 2 必须在 3 之前）', () => {
    // 反例原型：S2 只解析到一级、S1 有二级且不同 → conflict，但最终 category2 被写成未分类。
    // 若先判 isUnclassified（这里不是双未分类，会返回 false）→ 落到 null →
    // **这条资产从两个队列里同时消失**。
    const a = withReview('a', { confidence: 'conflict', reason: 'conflict' }, '工装空间')
    expect(isUnclassified(a)).toBe(false) // 前提：它确实不是双未分类
    expect(reviewReasonOf(a)).toBe('conflict')
    expect(reviewReasonOf(a)).not.toBe('unclassified')
  })

  it('★conflict 且两级都是未分类时也归 conflict（信息不丢）', () => {
    // 这种数据在 conflict 模式下会显示「站方说是 X」，判成 unclassified 就丢了那块 UI。
    const a = withReview('a', { confidence: 'conflict', reason: 'conflict' })
    expect(reviewReasonOf(a)).toBe('conflict')
  })
})

// ── ③ decidedAt 优先于一切 ───────────────────────────────────────────

describe('reviewReasonOf · decidedAt（已定案不再打扰）', () => {
  it('★conflict + 有 decidedAt → null', () => {
    expect(
      reviewReasonOf(
        withReview('a', { confidence: 'conflict', reason: 'conflict', decidedAt: 1712000000000 })
      )
    ).toBeNull()
  })

  it('decidedAt:0 也是有限数字 → 定案 → null', () => {
    expect(
      reviewReasonOf(withReview('a', { confidence: 'conflict', reason: 'conflict', decidedAt: 0 }))
    ).toBeNull()
  })

  it('已定案的未分类也不再进队列', () => {
    expect(reviewReasonOf(withReview('a', { decidedAt: 1712000000000 }))).toBeNull()
  })

  it('★decidedAt:NaN / undefined 不算定案 → 仍返回 conflict', () => {
    expect(
      reviewReasonOf(withReview('a', { confidence: 'conflict', reason: 'conflict', decidedAt: NaN }))
    ).toBe('conflict')
    expect(
      reviewReasonOf(
        withReview('a', { confidence: 'conflict', reason: 'conflict', decidedAt: undefined })
      )
    ).toBe('conflict')
  })
})

// ── ④ 等价性：buildReviewQueue(...,'unclassified') ≡ buildTriageQueue ─

describe('buildReviewQueue · 与 buildTriageQueue 的等价性（核心守卫）', () => {
  it('★20 条混合数据上逐 id 完全相等', () => {
    // 混合：双未分类 / 半归类 / 有分类 / conflict / confidence:none / 已定案 / 软删
    //
    // ⚠️ 夹具里**不构造**「双未分类 + decidedAt」：那是非法状态（定案必然已写入分类），
    // 真出现时 `reviewReasonOf` 会判 null 而 `buildTriageQueue` 会收下它，等价性不成立。
    // 等价性只承诺在合法数据上；这条限制写在 reviewFlow.ts 的 `reviewReasonOf` 注释里。
    const list: Asset[] = [
      withReview('u1', undefined),
      withReview('u2', { confidence: 'none' }),
      withReview('u3', { confidence: 'medium-s1' }, UNCLASSIFIED, UNCLASSIFIED), // medium-s1 但两级空 → 仍算未分类
      withReview('u4', undefined, UNCLASSIFIED, UNCLASSIFIED, { deletedAt: 1712000000000 }), // 软删
      withReview('u5', { confidence: 'high', decidedAt: 1712000000001 }, '工装空间', '办公空间'), // 已定案 + 有分类
      withReview('half1', undefined, '工装空间', UNCLASSIFIED),
      withReview('half2', undefined, UNCLASSIFIED, '办公空间'),
      withReview('ok1', { confidence: 'high' }, '工装空间', '办公空间'),
      withReview('ok2', { confidence: 'medium-s2' }, '工装空间', '会议室'),
      withReview('cf1', { confidence: 'conflict', reason: 'conflict' }, '工装空间', '办公空间'),
      withReview('cf2', { confidence: 'conflict', reason: 'conflict' }, '工装空间', UNCLASSIFIED),
      withReview('cf3', { confidence: 'conflict', reason: 'conflict' }, '机电工程', '电气工程节点'),
      withReview(
        'cf4',
        { confidence: 'conflict', reason: 'conflict', decidedAt: 1712000000002 },
        '工装空间',
        '办公空间'
      ),
      withReview('cf5', { confidence: 'conflict', reason: 'conflict' }, '建筑设计', '规划设计', {
        deletedAt: 1712000000003
      }),
      withReview('u6', undefined, UNCLASSIFIED, UNCLASSIFIED, { deletedAt: 1712000000004 }),
      withReview('ok3', { confidence: 'high' }, '椅子', '餐椅'),
      withReview('u7', undefined),
      withReview('ok4', undefined, '沙发', '三人'),
      withReview('u8', { confidence: 'none' }),
      asset('u9')
    ]
    expect(list).toHaveLength(20)

    const reviewed = buildReviewQueue(list, 'unclassified').map((a) => a.id)
    const triaged = buildTriageQueue(list).map((a) => a.id)

    expect(reviewed).toEqual(triaged)
    // 再钉住具体内容，避免两边同时错成同一个空数组也算"相等"
    expect(reviewed).toEqual(['u1', 'u2', 'u3', 'u4', 'u6', 'u7', 'u8', 'u9'])
  })

  it('等价性在空集 / 全部正常时同样成立', () => {
    expect(buildReviewQueue([], 'unclassified').map((a) => a.id)).toEqual(
      buildTriageQueue([]).map((a) => a.id)
    )
    const normal = [asset('a', '椅子', '餐椅'), asset('b', '沙发', '三人')]
    expect(buildReviewQueue(normal, 'unclassified').map((a) => a.id)).toEqual(
      buildTriageQueue(normal).map((a) => a.id)
    )
  })
})

// ── ⑤ buildReviewQueue · 保序 ────────────────────────────────────────

describe('buildReviewQueue · 保序', () => {
  it('★顺序严格跟随入参（按 importedAt 倒序的列表不乱排）', () => {
    const list = [
      withReview('newest', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '办公空间', {
        importedAt: 3000
      }),
      withReview('mid', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '会议室', {
        importedAt: 2000
      }),
      withReview('oldest', { reason: 'conflict', confidence: 'conflict' }, '建筑设计', '规划设计', {
        importedAt: 1000
      })
    ]
    expect(buildReviewQueue(list, 'conflict').map((a) => a.id)).toEqual([
      'newest',
      'mid',
      'oldest'
    ])
    // 反过来传入也要反着来（证明真的没排序）
    expect(buildReviewQueue([...list].reverse(), 'conflict').map((a) => a.id)).toEqual([
      'oldest',
      'mid',
      'newest'
    ])
  })

  it('只挑指定原因（conflict 队列不含 unclassified，反之亦然）', () => {
    const list = [withReview('u1', undefined), withReview('cf1', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '办公空间')]
    expect(buildReviewQueue(list, 'conflict').map((a) => a.id)).toEqual(['cf1'])
    expect(buildReviewQueue(list, 'unclassified').map((a) => a.id)).toEqual(['u1'])
  })

  it('非数组输入 → 空数组（不抛）', () => {
    expect(buildReviewQueue(null as unknown as Asset[], 'conflict')).toEqual([])
  })
})

// ── ⑥ 不自己过滤软删 ─────────────────────────────────────────────────

describe('buildReviewQueue · 软删由调用方过滤', () => {
  it('★软删的 conflict 资产仍在返回结果里（本模块不重复实现 deletedAt 判断）', () => {
    // 纪律：软删过滤的唯一实现点是 matchesFilters / isDeletedAsset（store.useTriageQueue）。
    // 本模块自己滤一遍就是第二套真相。
    const list = [
      withReview('live', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '办公空间'),
      withReview(
        'trashed',
        { reason: 'conflict', confidence: 'conflict' },
        '工装空间',
        '会议室',
        { deletedAt: 1712000000000 }
      )
    ]
    expect(buildReviewQueue(list, 'conflict').map((a) => a.id)).toEqual(['live', 'trashed'])
  })
})

// ── ⑦ countPendingReview ─────────────────────────────────────────────

describe('countPendingReview · 两种原因分别计数', () => {
  it('3 conflict + 2 unclassified + 5 正常 → {2,3}', () => {
    const list = [
      withReview('cf1', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '办公空间'),
      withReview('cf2', { reason: 'conflict', confidence: 'conflict' }, '工装空间'),
      withReview('cf3', { reason: 'conflict', confidence: 'conflict' }),
      withReview('u1', undefined),
      withReview('u2', { confidence: 'none' }),
      withReview('ok1', { confidence: 'high' }, '工装空间', '办公空间'),
      withReview('ok2', { confidence: 'medium-s1' }, '工装空间', '会议室'),
      withReview('ok3', { confidence: 'medium-s2' }, '椅子', '餐椅'),
      withReview('ok4', undefined, '沙发', '三人'),
      withReview('ok5', { reason: 'conflict', confidence: 'conflict', decidedAt: 1712000000000 })
    ]
    expect(countPendingReview(list)).toEqual({ unclassified: 2, conflict: 3 })
  })

  it('不套筛选、不过滤软删（软删的也计入，调用方先滤）', () => {
    const list = [
      withReview('cf1', { reason: 'conflict', confidence: 'conflict' }, '工装空间', '办公空间', {
        deletedAt: 1712000000000
      })
    ]
    expect(countPendingReview(list)).toEqual({ unclassified: 0, conflict: 1 })
  })
})

// ── ⑧ 空 / 边界 ──────────────────────────────────────────────────────

describe('空输入与全正常', () => {
  it('空数组', () => {
    expect(buildReviewQueue([], 'conflict')).toEqual([])
    expect(buildReviewQueue([], 'unclassified')).toEqual([])
    expect(countPendingReview([])).toEqual({ unclassified: 0, conflict: 0 })
  })

  it('全部正常 → 队列空、计数全 0', () => {
    const list = [
      withReview('a', { confidence: 'high' }, '工装空间', '办公空间'),
      withReview('b', { confidence: 'medium-s1' }, '工装空间', '会议室'),
      withReview('c', { confidence: 'medium-s2' }, '椅子', '餐椅')
    ]
    expect(buildReviewQueue(list, 'conflict')).toEqual([])
    expect(buildReviewQueue(list, 'unclassified')).toEqual([])
    expect(countPendingReview(list)).toEqual({ unclassified: 0, conflict: 0 })
    expect(list.every((a) => !isPendingReview(a))).toBe(true)
  })

  it('isPendingReview 就是 reviewReasonOf !== null', () => {
    expect(isPendingReview(withReview('u', undefined))).toBe(true)
    expect(isPendingReview(withReview('c', { reason: 'conflict', confidence: 'conflict' }))).toBe(true)
    expect(
      isPendingReview(withReview('h', { confidence: 'high' }, '工装空间', '办公空间'))
    ).toBe(false)
    expect(isPendingReview(null)).toBe(false)
  })
})

// ── 源码守卫：本文件必须零 React / DOM / electron / Dexie ────────────

describe('源码守卫 · reviewFlow 保持纯函数', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'src/renderer/logic/reviewFlow.ts'),
    'utf8'
  )

  it('不 import react / electron / dexie', () => {
    expect(src).not.toContain("from 'react'")
    expect(src).not.toContain('from "react"')
    expect(src).not.toContain("from 'electron'")
    expect(src).not.toContain('from "electron"')
    expect(src).not.toContain('dexie')
  })

  it('不碰 window / document / indexedDB', () => {
    expect(src).not.toContain('window.')
    expect(src).not.toContain('document.')
    expect(src).not.toContain('indexedDB')
  })

  it('不自己实现软删判断 / 未分类判据（只 import isUnclassified）', () => {
    expect(src).not.toContain('deletedAt ===')
    expect(src).not.toContain('from \'./category\'')
    expect(src).toContain("import { isUnclassified } from './triageFlow'")
  })
})
