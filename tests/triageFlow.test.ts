/**
 * 未分类整理流水线（P2 第一批）的**纯逻辑**测试。
 *
 * `vitest.config.ts` 是 `environment: 'node'`，没有 jsdom → 组件渲染会得到"看起来过了
 * 但什么都没验"的假绿。所以这里只钉 `logic/triageFlow.ts` 的转移规则 + 一条
 * store 清理口径 + 组件源码守卫。
 *
 * 钉住的六条底盘（错了用户会立刻察觉，但代码里看不出来）：
 * ① 待办集只含**双未分类**且非软删；
 * ② 顺序 = 传入序列的顺序（不自己重排）；
 * ③ 前进到边界**不 wrap**；
 * ④ 跳过项**本次不再出现**，但"归类成功"**不算跳过**（否则重建会话会莫名少一张）；
 * ⑤ `n / m` 位置正确（找不到时是 -1，不是骗人的 0）；
 * ⑥ 空集返回空、`currentId = null`（调用方据此关浮层）。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TRIAGE,
  advanceAfterAssign,
  buildTriageQueue,
  decideTriageKey,
  isUnclassified,
  reconcileTriage,
  remainingQueue,
  skipCurrent,
  startTriage,
  stepTriage,
  triageCloseNotice,
  triageIndex
} from '../src/renderer/logic/triageFlow'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset } from '../src/shared/types'

/** 最小资产夹具：`triageFlow` 只读 id / category1 / category2 */
function asset(id: string, c1 = UNCLASSIFIED, c2 = UNCLASSIFIED, extra: Partial<Asset> = {}): Asset {
  return { id, name: id, category1: c1, category2: c2, files: [], ...extra } as Asset
}

// ── ① 待办集 ─────────────────────────────────────────────────────────

describe('isUnclassified · 双未分类判据', () => {
  it('两级都是未分类 → true', () => {
    expect(isUnclassified(asset('a'))).toBe(true)
  })

  it('一级已填、二级未填 → **false**（半归类状态不进待办集）', () => {
    // 这是与侧栏计数（只数 category1）和中栏头计数（|| 口径）的差异点，
    // 理由写在 isUnclassified 的注释里：确认后 assignCategory 会判 skipped 不动，
    // 整理模式下表现成"按了确认没反应"。
    expect(isUnclassified(asset('a', '椅子'))).toBe(false)
  })

  it('二级已填、一级未分类 → false（这种数据本身非法，但也不能当待办）', () => {
    expect(isUnclassified(asset('a', UNCLASSIFIED, '餐椅'))).toBe(false)
  })

  it('两级都填了 → false', () => {
    expect(isUnclassified(asset('a', '椅子', '餐椅'))).toBe(false)
  })

  it('缺字段 / null / undefined 一律按未分类兜底（与 categoriesOf 同口径）', () => {
    expect(isUnclassified({ id: 'a' } as Asset)).toBe(true)
    expect(isUnclassified({ id: 'a', category1: '', category2: '' } as Asset)).toBe(true)
    expect(isUnclassified(null)).toBe(false)
    expect(isUnclassified(undefined)).toBe(false)
  })
})

describe('buildTriageQueue · 挑谁 / 什么顺序', () => {
  it('只挑双未分类的', () => {
    const list = [
      asset('u1'),
      asset('c1', '椅子', '餐椅'),
      asset('u2'),
      asset('half', '椅子') // 二级未填 → 不进
    ]
    expect(buildTriageQueue(list).map((a) => a.id)).toEqual(['u1', 'u2'])
  })

  it('★顺序严格跟随入参（不自己重排）', () => {
    // 传入的是「按体积降序」的结果 → 待办集也必须按体积降序
    const list = [asset('big'), asset('mid'), asset('small')]
    expect(buildTriageQueue(list).map((a) => a.id)).toEqual(['big', 'mid', 'small'])
    // 反过来传入也要反着来（证明真的没排序）
    expect(buildTriageQueue([...list].reverse()).map((a) => a.id)).toEqual(['small', 'mid', 'big'])
  })

  it('空输入 / 非数组 → 空数组（不抛）', () => {
    expect(buildTriageQueue([])).toEqual([])
    expect(buildTriageQueue(null as unknown as Asset[])).toEqual([])
  })

  it('全部已分类 → 空数组', () => {
    expect(buildTriageQueue([asset('a', '椅子', '餐椅'), asset('b', '沙发', '三人')])).toEqual([])
  })
})

// ── ② 会话开局 ───────────────────────────────────────────────────────

describe('startTriage · 开局落在第一张', () => {
  it('落在第一张，m = 待办集长度', () => {
    const c = startTriage([asset('a'), asset('b'), asset('c')])
    expect(c.currentId).toBe('a')
    expect(c.ids).toEqual(['a', 'b', 'c'])
    expect(triageIndex(c)).toBe(0)
  })

  it('★空集 → currentId = null（调用方据此不开浮层）', () => {
    const c = startTriage([])
    expect(c.currentId).toBeNull()
    expect(c.ids).toEqual([])
    expect(triageIndex(c)).toBe(-1)
  })

  it('可延续跳过集（重建会话时用）', () => {
    const c = startTriage([asset('a'), asset('b')], new Set(['a']))
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['b'])
  })
})

// ── ③ 前进 / 后退：不 wrap ────────────────────────────────────────────

describe('stepTriage · 纯移动，边界不 wrap', () => {
  const base = startTriage([asset('a'), asset('b'), asset('c')])

  it('前进一格', () => {
    expect(stepTriage(base, 1).currentId).toBe('b')
    expect(triageIndex(stepTriage(base, 1))).toBe(1)
  })

  it('后退一格', () => {
    const at2 = stepTriage(stepTriage(base, 1), 1) // c
    expect(at2.currentId).toBe('c')
    expect(stepTriage(at2, -1).currentId).toBe('b')
  })

  it('★在最后一张继续前进 → 原地不动（不绕回第一张）', () => {
    const last = stepTriage(stepTriage(base, 1), 1)
    expect(last.currentId).toBe('c')
    const same = stepTriage(last, 1)
    // 引用相等：调用方可用 `===` 判"没变化"，避免无意义重渲染
    expect(same).toBe(last)
  })

  it('★在第一张继续后退 → 原地不动', () => {
    expect(stepTriage(base, -1)).toBe(base)
  })

  it('delta = 0 / 非数字 → 原样返回', () => {
    expect(stepTriage(base, 0)).toBe(base)
    expect(stepTriage(base, Number.NaN)).toBe(base)
  })

  it('大跨度被夹到边界（不会越界读 undefined）', () => {
    expect(stepTriage(base, 99).currentId).toBe('c')
    expect(stepTriage(base, -99).currentId).toBe('a')
  })

  it('空会话上移动 → 原样返回', () => {
    expect(stepTriage(EMPTY_TRIAGE, 1)).toBe(EMPTY_TRIAGE)
  })

  it('★纯移动**不改分类语义**：跳过集不变', () => {
    const moved = stepTriage(base, 1)
    expect(moved.skipped.size).toBe(0)
  })
})

// ── ④ 跳过 ───────────────────────────────────────────────────────────

describe('skipCurrent · 跳过项本次不再出现', () => {
  const base = startTriage([asset('a'), asset('b'), asset('c')])

  it('跳过第一张 → 前进到第二张，且第一张从 ids 里消失（m 减 1）', () => {
    const c = skipCurrent(base)
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['b', 'c'])
    expect(c.skipped.has('a')).toBe(true)
  })

  it('★跳过中间那张 → 下一张「接位」到同一位置', () => {
    const at2 = stepTriage(base, 1) // b
    const c = skipCurrent(at2)
    expect(c.currentId).toBe('c')
    expect(c.ids).toEqual(['a', 'c'])
  })

  it('★跳过最后一张 → 退到新的末尾（上一张），不变成 null', () => {
    const last = stepTriage(stepTriage(base, 1), 1) // c
    const c = skipCurrent(last)
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['a', 'b'])
  })

  it('★跳过唯一一张 → null（待办集清空）', () => {
    const one = startTriage([asset('a')])
    const c = skipCurrent(one)
    expect(c.currentId).toBeNull()
    expect(c.ids).toEqual([])
    expect(c.skipped.has('a')).toBe(true)
  })

  it('反向跳过（K）→ 落到上一张的位置', () => {
    const at2 = stepTriage(base, 1) // b（下标 1）
    const c = skipCurrent(at2, 'backward')
    // 移除 b 后 ids = [a, c]，原下标 1 → 落到 ids[0] = a（往回走）
    expect(c.currentId).toBe('a')
    expect(c.ids).toEqual(['a', 'c'])
  })

  it('跳过集累加：连跳两张都记着', () => {
    let c = skipCurrent(base) // 跳 a → b
    c = skipCurrent(c) // 跳 b → c
    expect([...c.skipped].sort()).toEqual(['a', 'b'])
    expect(c.ids).toEqual(['c'])
  })

  it('remainingQueue 会扣掉跳过项', () => {
    const queue = [asset('a'), asset('b'), asset('c')]
    const c = skipCurrent(startTriage(queue))
    expect(remainingQueue(queue, c.skipped).map((a) => a.id)).toEqual(['b', 'c'])
  })

  it('空会话上跳过 → 原样返回', () => {
    expect(skipCurrent(EMPTY_TRIAGE)).toBe(EMPTY_TRIAGE)
  })
})

// ── ④b 归类成功前进：**不算跳过** ─────────────────────────────────────

describe('advanceAfterAssign · 归类成功不写跳过集', () => {
  it('移除当前并前进到下一张', () => {
    const c = advanceAfterAssign(startTriage([asset('a'), asset('b'), asset('c')]))
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['b', 'c'])
  })

  it('★不写 skipped（否则重建会话时会莫名少一张）', () => {
    const c = advanceAfterAssign(startTriage([asset('a'), asset('b')]))
    expect(c.skipped.size).toBe(0)
    expect(c.skipped.has('a')).toBe(false)
  })

  it('最后一张归类完 → null（待办集清空 → 浮层关闭）', () => {
    const c = advanceAfterAssign(startTriage([asset('a')]))
    expect(c.currentId).toBeNull()
    expect(c.ids).toEqual([])
  })

  it('★与 skipCurrent 的差别只在跳过集：两者移除后的落点相同', () => {
    const q = [asset('a'), asset('b'), asset('c')]
    const base = stepTriage(startTriage(q), 1) // b
    expect(advanceAfterAssign(base).currentId).toBe(skipCurrent(base).currentId)
    expect(advanceAfterAssign(base).ids).toEqual(skipCurrent(base).ids)
    // 唯一差别
    expect(advanceAfterAssign(base).skipped.size).toBe(0)
    expect(skipCurrent(base).skipped.size).toBe(1)
  })
})

// ── ⑤⑥ 外部重建：接位 / 清空 ──────────────────────────────────────────

describe('reconcileTriage · 资产被删 / 被归类后稳游标', () => {
  it('当前这张还在 → 原地不动', () => {
    const c = stepTriage(startTriage([asset('a'), asset('b'), asset('c')]), 1) // b
    const r = reconcileTriage(c, [asset('a'), asset('b'), asset('c')])
    expect(r.currentId).toBe('b')
    // 序列完全一致 → 连对象都复用
    expect(r).toBe(c)
  })

  it('★当前这张被删 → 它原来的下标位置「接位」', () => {
    const c = stepTriage(startTriage([asset('a'), asset('b'), asset('c')]), 1) // b（下标 1）
    // b 从库里消失（删了 / 被归类走了）
    const r = reconcileTriage(c, [asset('a'), asset('c')])
    expect(r.currentId).toBe('c') // 原下标 1 = c
    expect(triageIndex(r)).toBe(1)
  })

  it('★删除的是最后一张 → 夹到新的末尾', () => {
    const c = stepTriage(startTriage([asset('a'), asset('b')]), 1) // b（下标 1）
    const r = reconcileTriage(c, [asset('a')])
    expect(r.currentId).toBe('a')
  })

  it('★待办集清空 → currentId = null（调用方据此关浮层，不悬空）', () => {
    const r = reconcileTriage(startTriage([asset('a')]), [])
    expect(r.currentId).toBeNull()
    expect(r.ids).toEqual([])
  })

  it('当前项还在但序列变了（排序 / 新增）→ 位置跟新序列走', () => {
    const c = stepTriage(startTriage([asset('a'), asset('b'), asset('c')]), 1) // b
    const r = reconcileTriage(c, [asset('new'), asset('a'), asset('b'), asset('c')])
    expect(r.currentId).toBe('b')
    expect(triageIndex(r)).toBe(2) // 新序列里 b 在第 3 位
  })

  it('跳过集参与裁剪：被跳过的不因重建而复活', () => {
    const c = skipCurrent(startTriage([asset('a'), asset('b')])) // 跳 a，停在 b
    const r = reconcileTriage(c, [asset('a'), asset('b')])
    expect(r.currentId).toBe('b')
    expect(r.ids).toEqual(['b'])
  })

  it('原 currentId 为 null 但来了新资产 → 落到第一张（不永远停在空态）', () => {
    const r = reconcileTriage({ ids: [], currentId: null, skipped: new Set() }, [asset('a')])
    expect(r.currentId).toBe('a')
  })

  it('★归类成功后的「推进 + 重建」叠加**不会跳过一张**', () => {
    // 真实时序：`confirm` 先 setCursor(advanceAfterAssign) 立刻换预览，
    // 然后 assignCategory 改 store.assets → queue 变化 → effect 里再 reconcile 一次。
    // 若 reconcile 把"已经推进过的游标"再推进一次，用户会漏掉一张。
    const c0 = startTriage([asset('a'), asset('b'), asset('c')])
    const c1 = advanceAfterAssign(c0) // 归类 a → 停在 b
    expect(c1.currentId).toBe('b')
    const c2 = reconcileTriage(c1, [asset('b'), asset('c')]) // a 已从库里消失
    // b 还在 → 原地不动（不变成 c）
    expect(c2.currentId).toBe('b')
  })
})

// ── ⑦ 收尾提示 ───────────────────────────────────────────────────────

describe('triageCloseNotice · 收尾文案', () => {
  it('剩 0 → 「未分类已清空」', () => {
    expect(triageCloseNotice(0)).toBe('未分类已清空')
  })

  it('剩 N → 「还剩 N 张未分类」', () => {
    expect(triageCloseNotice(3)).toBe('还剩 3 张未分类')
  })

  it('非法值按 0 处理（不显示 NaN）', () => {
    expect(triageCloseNotice(Number.NaN)).toBe('未分类已清空')
    expect(triageCloseNotice(-5)).toBe('未分类已清空')
    expect(triageCloseNotice(2.7)).toBe('还剩 2 张未分类')
  })
})

// ── ⑧ 键位 ───────────────────────────────────────────────────────────

describe('decideTriageKey · 键位判据', () => {
  const base = { key: 'x' }

  it('→ / ← = 纯移动', () => {
    expect(decideTriageKey({ ...base, key: 'ArrowRight' })).toBe('next')
    expect(decideTriageKey({ ...base, key: 'ArrowLeft' })).toBe('prev')
  })

  it('J / K（及小写）= 跳过', () => {
    expect(decideTriageKey({ ...base, key: 'J' })).toBe('skipNext')
    expect(decideTriageKey({ ...base, key: 'j' })).toBe('skipNext')
    expect(decideTriageKey({ ...base, key: 'K' })).toBe('skipPrev')
    expect(decideTriageKey({ ...base, key: 'k' })).toBe('skipPrev')
  })

  it('Enter = 确认', () => {
    expect(decideTriageKey({ ...base, key: 'Enter' })).toBe('confirm')
  })

  it('★Esc 永远返回 none（交给 useEscLayer，否则一次按键关两层）', () => {
    expect(decideTriageKey({ ...base, key: 'Escape' })).toBe('none')
  })

  it('★输入框里全部让路', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'J', 'K', 'Enter']) {
      expect(decideTriageKey({ ...base, key, typing: true })).toBe('none')
    }
  })

  it('★带修饰键让路（Ctrl/Cmd/Alt 是别的功能）', () => {
    expect(decideTriageKey({ ...base, key: 'Enter', ctrlKey: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'J', metaKey: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'K', altKey: true })).toBe('none')
  })

  it('★按住不放（repeat）让路 —— 手一抖不该跳掉半个库', () => {
    expect(decideTriageKey({ ...base, key: 'J', repeat: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'ArrowRight', repeat: true })).toBe('none')
  })

  it('★提交中（busy）让路 —— 防连按 Enter 重复归类', () => {
    expect(decideTriageKey({ ...base, key: 'Enter', busy: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'J', busy: true })).toBe('none')
  })

  it('★分类面板展开时让路（Enter / ↑↓ 归面板自己的高亮与选中）', () => {
    expect(decideTriageKey({ ...base, key: 'Enter', panelOpen: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'ArrowDown', panelOpen: true })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'ArrowRight', panelOpen: true })).toBe('none')
  })

  it('其它键不管（不抢空格：整理模式没有"看大图"第二态）', () => {
    expect(decideTriageKey({ ...base, key: ' ' })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'a' })).toBe('none')
    expect(decideTriageKey({ ...base, key: 'Delete' })).toBe('none')
  })
})
