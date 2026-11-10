/**
 * 居中临时气泡 · notice 生命周期单测（2026-11-10「从底层规避提示不消失」）。
 *
 * ## 为什么是纯逻辑 / 源码守卫，而不是渲染测试
 * `vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL。所以：
 * ① 生命周期用 `createNoticeRuntime()` + **注入的假时钟 / 假计时器**确定性推进；
 * ② 「组件有没有接上」用 `readSrc()` 读源码文本守卫（与 `classifyUiWiring.test.ts` 同款）。
 *
 * ## 覆盖的 6 条验收判据
 * | # | 判据 | 用例 |
 * |---|------|------|
 * | 1 | 超时按 id 校验 | `shouldClearOnTimeout` 参数化 + stale `fireTimeout(旧id)` |
 * | 2 | 旧 timer 不误清新提示 | 「A → B → 触发 A 的旧 timer → B 仍在」 |
 * | 3 | 手动关闭 | `dismiss()` / `dismissNotice()` 清当前 + 队列续排 |
 * | 4 | 队列最后一条会被清 | 三条依次展示，最后一次到点 → state null |
 * | 5 | 组件卸载后状态层仍会清理 | `unmountAllViews()` + 重挂，计时器照常触发 |
 * | 6 | 三类内容同时存在的渲染条件 | `shouldRenderBubble` / `resolveUndoTarget` 全组合 |
 *
 * 另外覆盖用户原话那条链路：删除（裸写 `set({ notice })`）→ notice 出现 → 到期状态层清空；
 * 以及「同一文案重复写入不会让 timer 丢失」。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  NOTICE_SHOW_MS,
  createNoticeRuntime,
  isNoticeExpired,
  makeNotice,
  nextNoticeId,
  resolveUndoTarget,
  shiftQueue,
  shouldClearOnDismiss,
  shouldClearOnTimeout,
  shouldRenderBubble,
  splitNotice,
  toNoticeState,
  type NoticeMeta,
  type NoticeRuntime,
  type NoticeState
} from '../src/renderer/logic/noticeLifecycle'
import { Z_MODAL_BASE, Z_NOTICE_BUBBLE, Z_STAGE_BALL } from '../src/renderer/logic/zStack'

/** 与 `tests/classifyUiWiring.test.ts` 同款：相对仓库根读源码，CRLF → LF 归一化。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/**
 * 剥掉注释只留代码，供**反向断言**使用。
 *
 * 本批的文件头注释里逐字引用了旧写法（`setTimeout(() => setNotice(null), 4500)` /
 * `h-11 shrink-0` 等）解释「为什么要改」。若拿含注释的全文做 `not.toContain`，
 * 会被这些历史说明自己误伤 —— 与 `tests/classifyUiWiring.test.ts` 的
 * 「剥注释后再断言」同一条纪律。
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 假环境：精确复刻 `store.ts` 的状态层接线（emit → setState → 订阅 → absorb）
//
// 关键：`viewListeners` 是**模拟 React 组件**的订阅，状态层的 `subscribe` 是另一套、
// 永不卸载。`unmountAllViews()` 清空视图订阅，但绝不影响状态层计时器 —— 这正是
// 「组件卸载后状态层仍会清理」要证明的结构。
// ─────────────────────────────────────────────────────────────────────────────
interface FakeState {
  notice: string | null
  noticeMeta: NoticeMeta | null
}

interface FakeEnv {
  runtime: NoticeRuntime
  emitted: NoticeState[]
  getState: () => FakeState
  /** 裸写：模拟 ~90 处 `set({ notice })` / `useVault.setState({ notice })` */
  rawWrite: (text: string | null) => void
  /** 新统一入口 */
  showNotice: (text: string) => void
  /** 存量入口 */
  setNotice: (n: string | null) => void
  /** 气泡 ✕ */
  dismissNotice: () => void
  /** 导入批次汇总队列 */
  enqueueNotice: (text: string) => void
  /** 推进假时钟（按到期时间升序触发到期 timer） */
  advance: (ms: number) => void
  pendingTimers: () => number
  unmountAllViews: () => void
  mountView: () => void
  viewCount: () => number
}

function createEnv(): FakeEnv {
  let clock = 1000
  let seq = 0
  const timers = new Map<number, { cb: () => void; at: number }>()
  const viewListeners: Array<() => void> = []
  let state: FakeState = { notice: null, noticeMeta: null }
  const stateListeners: Array<(s: FakeState, prev: FakeState) => void> = []
  const emitted: NoticeState[] = []

  const setState = (patch: Partial<FakeState>): void => {
    const prev = state
    state = { ...state, ...patch }
    for (const fn of stateListeners) fn(state, prev)
  }

  const runtime = createNoticeRuntime({
    now: () => clock,
    schedule: (cb, ms) => {
      const handle = ++seq
      timers.set(handle, { cb, at: clock + ms })
      return handle
    },
    cancel: (handle) => {
      timers.delete(handle as number)
    },
    emit: (next) => {
      emitted.push(next)
      const { text, meta } = splitNotice(next)
      setState({ notice: text, noticeMeta: meta })
    },
    durationMs: NOTICE_SHOW_MS
  })

  // `store.ts` 的订阅收口：捕获所有没走 action 的裸写（模块作用域，永不卸载）。
  stateListeners.push((s, prev) => {
    if (s.notice === prev.notice) return
    runtime.absorb(s.notice)
  })

  const advance = (ms: number): void => {
    clock += ms
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= clock)
      .sort((a, b) => a[1].at - b[1].at)
    for (const [handle, t] of due) {
      if (!timers.has(handle)) continue
      timers.delete(handle)
      t.cb()
    }
  }

  return {
    runtime,
    emitted,
    getState: () => state,
    rawWrite: (text) => setState({ notice: text }),
    showNotice: (text) => {
      runtime.show(text)
    },
    setNotice: (n) => {
      if (n === null) runtime.dismiss()
      else runtime.show(n)
    },
    dismissNotice: () => {
      if (toNoticeState(state.notice, state.noticeMeta) !== null) runtime.dismiss()
    },
    enqueueNotice: (text) => {
      runtime.enqueue(text)
    },
    advance,
    pendingTimers: () => timers.size,
    unmountAllViews: () => {
      viewListeners.length = 0
    },
    mountView: () => {
      viewListeners.push(() => undefined)
    },
    viewCount: () => viewListeners.length
  }
}

// ── 纯函数判据 ──────────────────────────────────────────────────────────────

describe('noticeLifecycle · 纯函数', () => {
  it('nextNoticeId 单调递增，脏值 / 负数兜底成 1', () => {
    expect(nextNoticeId(0)).toBe(1)
    expect(nextNoticeId(7)).toBe(8)
    expect(nextNoticeId(Number.NaN)).toBe(1)
    expect(nextNoticeId(-99)).toBe(1)
    expect(nextNoticeId(3.9)).toBe(4)
  })

  it('makeNotice 用绝对到期时间（now + durationMs），脏值不产生 NaN', () => {
    const a = makeNotice('已移入「最近删除」（左侧栏可还原）', 3, 10_000)
    expect(a).toEqual({ text: '已移入「最近删除」（左侧栏可还原）', id: 3, expiresAt: 10_000 + NOTICE_SHOW_MS })
    expect(makeNotice('x', 1, Number.NaN, -5).expiresAt).toBe(0)
    expect(makeNotice('x', 1, 100, Number.NaN).expiresAt).toBe(100 + NOTICE_SHOW_MS)
    expect(NOTICE_SHOW_MS).toBe(4500)
  })

  it('shouldClearOnTimeout 必须「id 对得上 + 确实到期」才允许清', () => {
    const rec = makeNotice('A', 7, 1000)
    expect(shouldClearOnTimeout(rec, 7, 1000 + NOTICE_SHOW_MS)).toBe(true)
    // id 不匹配：旧 timer 绝不能清当前这条
    expect(shouldClearOnTimeout(rec, 6, 1000 + NOTICE_SHOW_MS)).toBe(false)
    // 未到期：时钟回拨 / timer 提前触发也不清
    expect(shouldClearOnTimeout(rec, 7, 1000 + NOTICE_SHOW_MS - 1)).toBe(false)
    expect(shouldClearOnTimeout(rec, 7, Number.NaN)).toBe(false)
    // 空状态
    expect(shouldClearOnTimeout(null, 7, 1000 + NOTICE_SHOW_MS)).toBe(false)
    expect(isNoticeExpired(rec, 1000 + NOTICE_SHOW_MS)).toBe(true)
    expect(isNoticeExpired(rec, 1000)).toBe(false)
  })

  it('shouldClearOnDismiss 只认当前 id；toNoticeState / splitNotice 可往返', () => {
    const rec = makeNotice('A', 5, 1000)
    expect(shouldClearOnDismiss(rec, 5)).toBe(true)
    expect(shouldClearOnDismiss(rec, 4)).toBe(false)
    expect(shouldClearOnDismiss(null, 5)).toBe(false)
    expect(shouldClearOnDismiss(rec, Number.NaN)).toBe(false)

    const { text, meta } = splitNotice(rec)
    expect(text).toBe('A')
    expect(meta).toEqual({ id: 5, expiresAt: 1000 + NOTICE_SHOW_MS })
    expect(toNoticeState(text, meta)).toEqual(rec)
    expect(splitNotice(null)).toEqual({ text: null, meta: null })
    expect(toNoticeState('A', null)).toBeNull()
    expect(toNoticeState(null, meta)).toBeNull()
  })

  it('shiftQueue 空队列返回 null；非空返回首条与剩余（不改原数组）', () => {
    expect(shiftQueue([])).toBeNull()
    const q = ['跳过', '覆盖', '杂质']
    expect(shiftQueue(q)).toEqual({ text: '跳过', rest: ['覆盖', '杂质'] })
    expect(q).toEqual(['跳过', '覆盖', '杂质'])
  })

  it('验收⑥：三类内容任一在即渲染；三者同时在也只渲一个气泡', () => {
    expect(shouldRenderBubble(false, false, false)).toBe(false)
    expect(shouldRenderBubble(true, false, false)).toBe(true)
    expect(shouldRenderBubble(false, true, false)).toBe(true)
    expect(shouldRenderBubble(false, false, true)).toBe(true)
    // 三类同时存在（notice + 删除撤销 + 归类撤销）→ 仍只渲一个气泡
    expect(shouldRenderBubble(true, true, true)).toBe(true)
  })

  it('验收⑥：撤销条删除优先（两个同时在时归类让位），口径与旧通栏逐字一致', () => {
    expect(resolveUndoTarget(false, false)).toBeNull()
    expect(resolveUndoTarget(true, false)).toBe('delete')
    expect(resolveUndoTarget(false, true)).toBe('assign')
    expect(resolveUndoTarget(true, true)).toBe('delete')
  })
})

// ── 状态层生命周期（验收②）────────────────────────────────────────────────

describe('noticeLifecycle · 状态层到期清理', () => {
  it('用户报的那条：删除裸写 notice → 出现 → 到期后状态层清空（组件全程不存在）', () => {
    const env = createEnv()
    // `commitDelete()` 软删成功分支是裸 `set((s) => ({..., notice }))`，绕过了 action。
    env.rawWrite('已移入「最近删除」（左侧栏可还原）')

    expect(env.getState().notice).toBe('已移入「最近删除」（左侧栏可还原）')
    expect(env.getState().noticeMeta?.id).toBe(1)
    expect(env.getState().noticeMeta?.expiresAt).toBe(1000 + NOTICE_SHOW_MS)
    expect(env.pendingTimers()).toBe(1)

    // 只推进假时钟，不触碰任何「组件」
    env.advance(NOTICE_SHOW_MS)

    expect(env.getState().notice).toBeNull()
    expect(env.getState().noticeMeta).toBeNull()
    expect(env.runtime.getState()).toBeNull()
    expect(env.pendingTimers()).toBe(0)
    expect(env.emitted.at(-1)).toBeNull()
  })

  it('验收⑤：组件卸载 / 重挂（StrictMode、ErrorBoundary 重载）后状态层仍会清理', () => {
    const env = createEnv()
    env.mountView()
    env.mountView()
    expect(env.viewCount()).toBe(2)

    env.rawWrite('已移入「最近删除」（左侧栏可还原）')
    expect(env.getState().notice).not.toBeNull()

    // 模拟 React 树被卸载（StrictMode 双调用 / ErrorBoundary 重新加载窗口）
    env.unmountAllViews()
    expect(env.viewCount()).toBe(0)
    // 重挂：状态层计时器**不受影响**，notice 既不残留也不提前消失
    env.mountView()
    expect(env.viewCount()).toBe(1)
    expect(env.getState().notice).toBe('已移入「最近删除」（左侧栏可还原）')
    expect(env.pendingTimers()).toBe(1)

    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBeNull()
    expect(env.pendingTimers()).toBe(0)
  })

  it('验收②：期间新 notice 写入不被旧 timer 误清（超时按 id 校验）', () => {
    const env = createEnv()
    env.showNotice('A')
    const firstId = env.runtime.getState()!.id
    expect(firstId).toBe(1)

    env.advance(2000) // 时钟走到 3000，A 的原到期是 5500

    // 写入一条新提示：换新 id、重新排期
    env.showNotice('B')
    const secondId = env.runtime.getState()!.id
    expect(secondId).toBe(2)
    expect(env.getState().notice).toBe('B')

    // 模拟 A 的旧 timer 因竞态仍触发：id 对不上 → 放弃清理，B 不受影响
    env.runtime.fireTimeout(firstId)
    expect(env.getState().notice).toBe('B')
    expect(env.runtime.getState()?.id).toBe(secondId)

    // 走到 A 的**原到期时间**：旧 timer 若被误用就会在这里把 B 清掉
    env.advance(2500) // clock = 5500
    expect(env.getState().notice).toBe('B')
    expect(env.runtime.getState()?.id).toBe(secondId)

    // B 自己的到期时间才清
    env.advance(2000) // clock = 7500
    expect(env.getState().notice).toBeNull()
    expect(env.pendingTimers()).toBe(0)
  })

  it('同一文案重复写入不会让 timer 丢失（每次都换新 id + 重新排期）', () => {
    const env = createEnv()
    const same = '已保存智能集合「客厅」'
    env.showNotice(same)
    const first = env.runtime.getState()!
    env.advance(2000)
    env.showNotice(same) // 完全相同的文案，再写一次
    const second = env.runtime.getState()!

    expect(second.text).toBe(same)
    expect(second.id).toBe(first.id + 1)
    expect(second.expiresAt).toBe(3000 + NOTICE_SHOW_MS)
    // 旧 timer 已被取消，只剩一个待触发（不会丢、也不会攒两个互相打架）
    expect(env.pendingTimers()).toBe(1)

    // 触发旧 id 不影响；走到新到期时间才清
    env.runtime.fireTimeout(first.id)
    expect(env.getState().notice).toBe(same)
    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBeNull()
  })

  it('验收③：手动关闭按 id 校验；存量 setNotice(null) 与气泡 ✕ 都能立即清', () => {
    const env = createEnv()
    env.showNotice('A')
    expect(env.getState().notice).toBe('A')
    env.dismissNotice()
    expect(env.getState().notice).toBeNull()
    expect(env.pendingTimers()).toBe(0)

    env.setNotice('B')
    expect(env.getState().notice).toBe('B')
    env.setNotice(null)
    expect(env.getState().notice).toBeNull()
    expect(env.pendingTimers()).toBe(0)

    // 空状态重复关闭是幂等的，不会抛错 / 不会复活
    env.dismissNotice()
    env.dismissNotice()
    expect(env.runtime.getState()).toBeNull()
  })

  it('验收④：队列多条依次展示、互不吞并，最后一条到点也会被清', () => {
    const env = createEnv()
    // 模拟导入批次同时到达的三条汇总（跳过 / 覆盖 / 杂质）
    env.enqueueNotice('已跳过 2 个重复素材，原文件保留在原位')
    env.enqueueNotice('已覆盖 3 个重复素材（旧版在系统回收站）')
    env.enqueueNotice('已清理 1 个推广/说明文件')

    expect(env.getState().notice).toBe('已跳过 2 个重复素材，原文件保留在原位')
    expect(env.runtime.pendingCount()).toBe(2)

    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBe('已覆盖 3 个重复素材（旧版在系统回收站）')
    expect(env.runtime.pendingCount()).toBe(1)

    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBe('已清理 1 个推广/说明文件')
    expect(env.runtime.pendingCount()).toBe(0)

    // 旧 `drainNoticeQueue()` 在队列空时直接 return、从不清最后一条 —— 这里必须清
    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBeNull()
    expect(env.getState().noticeMeta).toBeNull()
    expect(env.runtime.getState()).toBeNull()
    expect(env.pendingTimers()).toBe(0)
  })

  it('队列中手动关闭某条 → 立即续排下一条，队列不会被卡死', () => {
    const env = createEnv()
    env.enqueueNotice('第一条')
    env.enqueueNotice('第二条')
    expect(env.runtime.pendingCount()).toBe(1)
    env.dismissNotice()
    expect(env.getState().notice).toBe('第二条')
    expect(env.runtime.pendingCount()).toBe(0)
    env.advance(NOTICE_SHOW_MS)
    expect(env.getState().notice).toBeNull()
  })

  it('reset() 清状态 / 计时器 / 队列；外部显式清空 notice 不会回环递归', () => {
    const env = createEnv()
    env.enqueueNotice('A')
    env.enqueueNotice('B')
    expect(env.pendingTimers()).toBe(1)
    env.runtime.reset()
    expect(env.getState().notice).toBeNull()
    expect(env.runtime.getState()).toBeNull()
    expect(env.runtime.pendingCount()).toBe(0)
    expect(env.pendingTimers()).toBe(0)

    // 外部把 notice 直接清成 null（测试 beforeEach 的常见写法）→ absorb(null) 只收当前，
    // 不续排队列、不产生 emit 回环
    env.showNotice('C')
    const emitCountBefore = env.emitted.length
    env.rawWrite(null)
    expect(env.emitted.length).toBe(emitCountBefore + 1) // 仅一次 emit(null)
    expect(env.getState().notice).toBeNull()
    expect(env.pendingTimers()).toBe(0)
  })
})

// ── 源码守卫（验收①④⑤）──────────────────────────────────────────────────

describe('noticeLifecycle · 接线守卫', () => {
  it('验收①：NoticeToast 内不再有 setTimeout(() => setNotice(null))，退化为纯渲染', () => {
    const src = readSrc('src/renderer/components/NoticeToast.tsx')
    const code = codeOnly(src)
    // 连**注释里**也不再逐字引用旧写法：整个文件（含注释）对旧表达式零命中
    expect(src).not.toContain('setTimeout(() => setNotice(null)')
    expect(code).not.toContain('setNotice(null)')
    expect(code).not.toContain('setTimeout(() => setNotice')
    expect(code).not.toContain('s.setNotice')
    // 气泡 ✕ 走状态层 dismissNotice
    expect(code).toContain('dismissNotice')
    expect(code).toContain('onClick={dismissNotice}')
    // 屏幕居中 + 容器不挡点击 + 气泡本体可点
    expect(code).toContain('top-1/2')
    expect(code).toContain('left-1/2')
    expect(code).toContain('-translate-x-1/2')
    expect(code).toContain('-translate-y-1/2')
    expect(code).toContain('pointer-events-none')
    expect(code).toContain('pointer-events-auto')
    // 底部通栏整条取消
    expect(code).not.toContain('h-11 shrink-0')
    expect(code).not.toContain('border-t border-panel-line bg-toast')
    // 三类内容都在同一个气泡里
    expect(code).toContain('shouldRenderBubble')
    expect(code).toContain('resolveUndoTarget')
    expect(code).toContain('UndoPill')
    expect(code).toContain('撤销 ${secondsLeft}s')
    expect(code).toContain('撤销 ${assignSecondsLeft}s')
    // 撤销倒计时归零收尾语义保持不变
    expect(code).toContain('if (left <= 0) void commitDelete()')
    expect(code).toContain('if (left <= 0) commitAssign(pendingAssign.startedAt)')
  })

  it('验收①：store 有统一状态层运行时 + dismissNotice + 订阅收口，旧两套 timer 已删', () => {
    const src = readSrc('src/renderer/store.ts')
    const code = codeOnly(src)
    expect(code).toContain('createNoticeRuntime')
    expect(code).toContain('noticeRuntime.absorb(state.notice)')
    expect(code).toContain('dismissNotice: () =>')
    expect(code).toContain('showNotice: (text) => noticeRuntime.show(text)')
    expect(code).toContain('noticeMeta: NoticeMeta | null')
    expect(code).toContain('resetNoticeForTests')
    // 旧的、与视图互不感知的第二套机制必须彻底消失（注释里可以留作历史说明，
    // 但函数声明 / 计时器变量不能再存在）
    expect(code).not.toContain('function drainNoticeQueue')
    expect(code).not.toContain('let noticeTimer')
    expect(code).not.toContain('const noticeQueue: string[]')
    // ~90 处业务文案写入点一处没改
    expect(src).toContain('已移入「最近删除」（左侧栏可还原）')
  })

  it('验收④：新增 z 档位落在 46~49，且高于球 45、低于弹窗 50；tailwind 已同步登记', () => {
    expect(Z_NOTICE_BUBBLE).toBeGreaterThanOrEqual(46)
    expect(Z_NOTICE_BUBBLE).toBeLessThanOrEqual(49)
    expect(Z_NOTICE_BUBBLE).toBeGreaterThan(Z_STAGE_BALL)
    expect(Z_NOTICE_BUBBLE).toBeLessThan(Z_MODAL_BASE)

    const zStack = readSrc('src/renderer/logic/zStack.ts')
    expect(zStack).toContain('Z_NOTICE_BUBBLE = 48')
    expect(zStack).toContain('高于舞台球 45')
    expect(zStack).toContain('低于最底层弹窗 50')

    const tw = readSrc('tailwind.config.js')
    expect(tw).toContain("48: '48'")

    // 扫描式生成约束：组件里必须写 z-48 字面量，不能拼模板串
    const toast = readSrc('src/renderer/components/NoticeToast.tsx')
    expect(toast).toContain('z-48')
    expect(toast).not.toContain('`z-${')
  })

  it('验收⑤：ImportQueue 的 bottom 已按「底栏不存在」重算为 bottom-3', () => {
    const src = readSrc('src/renderer/components/ImportQueue.tsx')
    expect(src).toContain('fixed bottom-3 left-1/2')
    expect(src).not.toContain('fixed bottom-14')
    expect(src).toContain('底栏已不存在')
    // 绝对时间戳自动消失机制不许被动过
    expect(src).toContain('dismissRemainingMs(it.status, it.settledAt, now)')
    expect(src).toContain('flex-col-reverse')
  })

  it('App 根布局不再有底部通栏这一行，NoticeToast 仍无条件挂载', () => {
    const src = readSrc('src/renderer/App.tsx')
    expect(src).toContain('<NoticeToast />')
    expect(src).toContain('不再是根 flex column 的第三行布局行')
    expect(src).toContain('flex h-full flex-col overflow-hidden')
  })
})
