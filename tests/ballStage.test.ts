/**
 * 舞台状态机（docs/19 裁定②，A 线）纯逻辑单测。
 *
 * 覆盖五条硬要求：
 * ① 全链路 idle → opening → active → closing → idle；
 * ② 连点另一张卡：runId 递增，旧 runId 的回调被丢弃（不能二次 settle）；
 * ③ closing 后 assetId 为 null，但 originRect 仍在（否则网格会在第一帧回归、球还在飞）；
 * ④ 资产被删 → 直接 idle，不经 closing；
 * ⑤ 状态机不碰 DOM：`originRect` 只被原样搬运，从不被读取/改写。
 */
import { describe, expect, it } from 'vitest'
import {
  STAGE_IDLE,
  abort,
  beginClose,
  beginHandback,
  beginHandoff,
  beginOpen,
  isStageBusy,
  settleActive,
  settleHandback,
  settleHandoff,
  shouldRun,
  sweep,
  type StageState
} from '../src/renderer/logic/ballStage'

/** 最小 DOMRect 替身（只需要四个数字，状态机不读别的） */
function rect(x: number, y: number, w = 200, h = 150): DOMRect {
  return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h } as DOMRect
}

describe('全链路', () => {
  it('idle → opening → active → closing → idle', () => {
    const a = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(10, 20) })
    expect(a.phase).toBe('opening')
    expect(a.assetId).toBe('a1')
    expect(a.runId).toBe(1)

    const b = settleActive(a, a.runId)
    expect(b.phase).toBe('active')

    const c = beginClose(b)
    expect(c.phase).toBe('closing')
    // 开门 +1（0→1），settle 不换号（同一次开门），关门再 +1（1→2）
    expect(c.runId).toBe(2)

    const d = sweep(c, c.runId)
    expect(d.phase).toBe('idle')
    expect(d.assetId).toBeNull()
    expect(d.originRect).toBeNull()
  })

  it('非法转换原样返回（settle 只在 opening、close 只在 opening/active）', () => {
    expect(settleActive(STAGE_IDLE, 0)).toBe(STAGE_IDLE)
    expect(beginClose(STAGE_IDLE)).toBe(STAGE_IDLE)
    expect(sweep(STAGE_IDLE, 0)).toBe(STAGE_IDLE)
  })
})

describe('连点另一张卡：runId 递增 + 旧回调丢弃', () => {
  it('第二次 beginOpen 递增 runId，第一次的 settle 被丢弃', () => {
    const first = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) })
    const second = beginOpen(first, { assetId: 'a2', rect: rect(400, 0) })
    expect(second.runId).toBe(first.runId + 1)
    expect(second.assetId).toBe('a2')

    // 旧一轮的 transitionend 迟到：不能把 phase 推到 active，也不能改回 a2 以外的资产
    const stale = settleActive(second, first.runId)
    expect(stale).toBe(second)
    expect(stale.phase).toBe('opening')
    expect(stale.assetId).toBe('a2')

    // 本轮回调正常落定
    expect(settleActive(second, second.runId).phase).toBe('active')
  })

  it('closing 时迟到的旧 sweep 被丢弃（不会把新一轮关掉）', () => {
    const a = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) })
    const active = settleActive(a, a.runId)
    const closing = beginClose(active)
    const reopened = beginOpen(closing, { assetId: 'a2', rect: rect(50, 50) })
    // 上一轮返回动画的 onDone 迟到
    const stale = sweep(reopened, closing.runId)
    expect(stale).toBe(reopened)
    expect(stale.phase).toBe('opening')
    expect(stale.assetId).toBe('a2')
  })
})

describe('closing 的快照纪律', () => {
  it('assetId 立刻置 null，但 originRect 保留到 idle', () => {
    const a = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(10, 20, 180, 120) })
    const active = settleActive(a, a.runId)
    const closing = beginClose(active)
    expect(closing.assetId).toBeNull()
    expect(closing.originRect).not.toBeNull()
    expect(closing.originRect?.top).toBe(20)
    // 只有 sweep 才清掉快照
    expect(sweep(closing, closing.runId).originRect).toBeNull()
  })

  it('originRect 被原样搬运（状态机不读也不算）', () => {
    const r = rect(1, 2, 3, 4) as DOMRect & { touched?: boolean }
    const s = beginOpen(STAGE_IDLE, { assetId: 'x', rect: r })
    expect(s.originRect).toBe(r)
    expect(r.touched).toBeUndefined()
  })
})

describe('资产被删：直接 idle，不播动画', () => {
  it('active 下被删 → idle（不经 closing）', () => {
    const a = settleActive(beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) }), 1)
    const gone = abort(a)
    expect(gone.phase).toBe('idle')
    expect(gone.assetId).toBeNull()
    expect(gone.originRect).toBeNull()
    expect(gone.runId).toBe(a.runId + 1) // 递增，旧回调全部作废
  })

  it('opening 下被删同样直接 idle', () => {
    const a = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) })
    expect(abort(a).phase).toBe('idle')
  })

  it('已经 idle 时 abort 返回同一对象（不制造无意义的 runId 抖动）', () => {
    expect(abort(STAGE_IDLE)).toBe(STAGE_IDLE)
  })
})

describe('两个派生判定', () => {
  it('只有 active 需要每帧跑（其余暂停 rAF 但保留上下文）', () => {
    expect(shouldRun('active')).toBe(true)
    expect(shouldRun('idle')).toBe(false)
    expect(shouldRun('opening')).toBe(false)
    expect(shouldRun('closing')).toBe(false)
    expect(shouldRun('handoff')).toBe(false) // 交接靠 WAAPI，不需要每帧画
    expect(shouldRun('handback')).toBe(false) // 回槽位同理
  })

  it('非 idle 即"占着界面"', () => {
    const phases: StageState['phase'][] = [
      'idle',
      'opening',
      'active',
      'closing',
      'handoff',
      'handback'
    ]
    expect(phases.filter(isStageBusy)).toEqual([
      'opening',
      'active',
      'closing',
      'handoff',
      'handback'
    ])
  })
})

/**
 * 2026-10（0.6.2）：舞台球 ↔「自定义渲染」弹窗球的交接。
 *
 * 三条硬要求：
 * ① `beginHandoff` 只在 `active 且未交接` 时生效（opening 球在半路、closing 网格已回来，
 *    这两种时机交接会让"同一颗球"的真值对不上）；
 * ② `settleHandoff` 有 runId 守卫（交接途中被关闭 / 换卡，迟到的回执必须丢弃）；
 * ③ closing 必须能从 `handoff` 进入，并**保留 handoffRect** 当起飞点；
 *    同时 beginOpen / sweep / abort 必须把交接字段清干净（否则新一轮一开门球就隐身）。
 */
const activeOf = (assetId = 'a1', r = rect(10, 20)): StageState =>
  settleActive(beginOpen(STAGE_IDLE, { assetId, rect: r }), 1)

describe('交接（handoff）：同一颗球飞进弹窗', () => {
  it('active + 未交接才生效；落点与 runId 都记下来', () => {
    const active = activeOf()
    const target = rect(300, 200, 240, 240)
    const h = beginHandoff(active, target)
    expect(h.phase).toBe('handoff')
    expect(h.handoffRect).toBe(target)
    expect(h.handedOff).toBe(false)
    expect(h.assetId).toBe('a1')
    expect(h.originRect).toBe(active.originRect) // 返回卡片仍需要开门快照
    expect(h.runId).toBe(active.runId + 1)
  })

  it('非 active 相位原样返回（idle / opening / closing）', () => {
    const target = rect(0, 0, 100, 100)
    expect(beginHandoff(STAGE_IDLE, target)).toBe(STAGE_IDLE)
    const opening = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) })
    expect(beginHandoff(opening, target)).toBe(opening)
    const closing = beginClose(activeOf())
    expect(beginHandoff(closing, target)).toBe(closing)
  })

  it('已交接（active + handedOff）不能再交接一次（幂等，避免来回飞）', () => {
    const h = beginHandoff(activeOf(), rect(0, 0, 100, 100))
    const done = settleHandoff(h, h.runId)
    expect(done.phase).toBe('active')
    expect(done.handedOff).toBe(true)
    expect(beginHandoff(done, rect(5, 5, 50, 50))).toBe(done)
  })

  it('settleHandoff：runId 不符 / 相位不符都丢弃', () => {
    const h = beginHandoff(activeOf(), rect(0, 0, 100, 100))
    expect(settleHandoff(h, h.runId - 1)).toBe(h) // 旧一轮回执
    expect(settleHandoff(STAGE_IDLE, 0)).toBe(STAGE_IDLE)
    expect(settleHandoff(activeOf(), 1).phase).toBe('active') // active 上调不生效
    const settled = settleHandoff(h, h.runId)
    expect(settled.phase).toBe('active')
    expect(settled.handedOff).toBe(true)
    expect(settled.handoffRect).toBe(h.handoffRect) // 弹窗位置要留着给 closing
  })

  it('closing 可从 handoff 进入，保留 handoffRect 当起飞点，并清 handedOff', () => {
    const h = beginHandoff(activeOf('a1', rect(10, 20, 180, 120)), rect(300, 200, 240, 240))
    const closing = beginClose(h)
    expect(closing.phase).toBe('closing')
    expect(closing.assetId).toBeNull() // 网格已经回来接管
    expect(closing.originRect?.top).toBe(20) // 落点是卡片，仍保留
    expect(closing.handoffRect?.left).toBe(300) // 起点是弹窗位置
    expect(closing.handedOff).toBe(false) // 舞台球必须复活
    expect(closing.runId).toBe(h.runId + 1)
  })

  it('beginOpen 清空交接字段（否则新一轮一开门球就隐身）', () => {
    const h = settleHandoff(beginHandoff(activeOf(), rect(0, 0, 100, 100)), 2)
    const reopened = beginOpen(h, { assetId: 'a2', rect: rect(5, 5) })
    expect(reopened.handoffRect).toBeNull()
    expect(reopened.handedOff).toBe(false)
  })

  it('sweep / abort 回 idle 时三个新字段全部清空', () => {
    const closing = beginClose(beginHandoff(activeOf(), rect(0, 0, 100, 100)))
    const idle = sweep(closing, closing.runId)
    expect(idle.phase).toBe('idle')
    expect(idle.handoffRect).toBeNull()
    expect(idle.handedOff).toBe(false)

    const aborted = abort(beginHandoff(activeOf(), rect(0, 0, 100, 100)))
    expect(aborted.phase).toBe('idle')
    expect(aborted.handoffRect).toBeNull()
    expect(aborted.handedOff).toBe(false)
  })

  it('STAGE_IDLE 的交接字段初值是空（快照稳定，可安全当 getSnapshot）', () => {
    expect(STAGE_IDLE.handoffRect).toBeNull()
    expect(STAGE_IDLE.handedOff).toBe(false)
  })
})

/**
 * 2026-10（0.6.3）：关弹窗 ≠ 退文件视图。
 *
 * 0.6.2 的真 bug：关弹窗复用了 `closing`（终点是双击时的**卡片坐标**，此刻已不在屏幕上），
 * 球朝错误目标飞然后被收起来 —— 用户看到"球消失、没飞回槽位"。
 * 现在两个方向的契约必须被钉住：
 * - `closing`：opening / active / handoff → 回卡片 → idle（**不接受 handback**）；
 * - `handback`：active+handedOff / handoff → 回顶栏槽位 → active（球留在顶部可见）。
 */
describe('回槽位（handback）：关弹窗 ≠ 退文件视图', () => {
  /** 弹窗打开、球已交接完成的状态 */
  const handedOff = (): StageState => {
    const h = beginHandoff(activeOf('a1', rect(10, 20, 180, 120)), rect(300, 200, 240, 240))
    return settleHandoff(h, h.runId)
  }

  it('active + handedOff → handback，起点仍是弹窗位置、舞台球复活', () => {
    const before = handedOff()
    const back = beginHandback(before)
    expect(back.phase).toBe('handback')
    expect(back.assetId).toBe('a1') // 球还在舞台上，不能像 closing 那样清空
    expect(back.handoffRect?.left).toBe(300) // 从弹窗位置起飞
    expect(back.originRect).toBe(before.originRect) // 不动"回网格"用的快照
    expect(back.handedOff).toBe(false) // 必须复活，否则飞回来那颗不可见
    expect(back.runId).toBe(before.runId + 1)
  })

  it('普通 active（未交接）不生效：球本来就在槽位，没什么可回的', () => {
    const plainActive = activeOf()
    expect(plainActive.handedOff).toBe(false)
    expect(beginHandback(plainActive)).toBe(plainActive)
  })

  it('handoff 中途也能掉头（交接动画没演完就关弹窗）', () => {
    const h = beginHandoff(activeOf(), rect(300, 200, 240, 240))
    const back = beginHandback(h)
    expect(back.phase).toBe('handback')
    expect(back.handoffRect).toBe(h.handoffRect)
  })

  it('其余相位（idle / opening / closing / handback）原样返回', () => {
    expect(beginHandback(STAGE_IDLE)).toBe(STAGE_IDLE)
    const opening = beginOpen(STAGE_IDLE, { assetId: 'a1', rect: rect(0, 0) })
    expect(beginHandback(opening)).toBe(opening)
    const closing = beginClose(activeOf())
    expect(beginHandback(closing)).toBe(closing)
    const back = beginHandback(handedOff())
    expect(beginHandback(back)).toBe(back) // 幂等
  })

  it('settleHandback：回到 active，且 handedOff / handoffRect 都清掉（球留在顶部）', () => {
    const back = beginHandback(handedOff())
    expect(settleHandback(back, back.runId - 1)).toBe(back) // runId 守卫：旧回执丢弃
    expect(settleHandback(STAGE_IDLE, 0)).toBe(STAGE_IDLE) // 相位守卫
    const settled = settleHandback(back, back.runId)
    expect(settled.phase).toBe('active')
    expect(settled.handedOff).toBe(false)
    expect(settled.handoffRect).toBeNull()
    expect(settled.assetId).toBe('a1')
  })

  it('beginClose 不接受 handback 来源（两个方向不能串联）', () => {
    const back = beginHandback(handedOff())
    expect(beginClose(back)).toBe(back)
  })

  it('handback 被打断时由 abort 兜回 idle 并清空字段', () => {
    const back = beginHandback(handedOff())
    const gone = abort(back)
    expect(gone.phase).toBe('idle')
    expect(gone.handoffRect).toBeNull()
    expect(gone.handedOff).toBe(false)
    expect(gone.assetId).toBeNull()
  })
})
