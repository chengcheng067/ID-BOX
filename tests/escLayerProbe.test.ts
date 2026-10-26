/// <reference lib="dom" />
/**
 * 层栈深度探针（0.7.7 · 用户点名要修的理论风险：**孤儿 token**）。
 *
 * 第 1 轮真机出现过「连按两次 Esc 没反应、第三次才关」，干净起点跑 3 轮无法复现，
 * 所以这一批**不改语义**，只加观测。可区分的两条成因（判据不同 → 数据上能分开）：
 *   ① 孤儿 token：栈里有 token（`depth > 0`）但背后已经没有活的 keydown 监听
 *      （`depth > liveListeners`）→ 没人消费这次按键，App 的全局 Esc 又因
 *      `hasEscLayer()` 为真而让路 → 表现就是「按 Esc 没反应」；
 *   ② 事件根本没到达监听：`depth === liveListeners`（每层都有活监听），但**探针**
 *      （挂在冒泡阶段）单独看到了这次按键 —— 按键到达 window 时没有任何活监听见过它。
 *
 * 仓库 vitest 是 `node` 环境、无 jsdom，React 组件渲染不了，所以分四层钉：
 *   A. 纯状态 / 纯函数直接测（push、pop、depth、snapshot、diagnose）；
 *   B. 探针用假事件源测（与 `rendererLog` 的 hook target 同形态），不依赖真实 DOM；
 *   C. 调试开关的落盘行为（只在按键时落、不刷屏）；
 *   D. `useEscLayer` 的**语义纪律**走源码守卫（只放行、绝不 stop、`escOwnedByControl`
 *      命中必须直接 `return`、handler 存 ref、依赖只写 `active`、`active=false` 不入栈）。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RendererLogPayload } from '../src/shared/types'
import {
  diagnoseEscMiss,
  disableEscProbe,
  escLayerSnapshot,
  getEscLayerDepth,
  installEscProbe,
  isEscProbeEnabled,
  noteEscLayerListener,
  popEscLayer,
  pushEscLayer,
  recordEscPress,
  resetEscLayers,
  resetEscProbe
} from '../src/renderer/logic/escLayer'

const read = (rel: string): string =>
  fs.readFileSync(new URL(`../src/renderer/${rel}`, import.meta.url), 'utf-8')

const ESC = { key: 'Escape' }
const OTHER = { key: 'Enter' }

/**
 * 假事件源：记录探针注册时用的阶段（第三个参），并允许测试手动派发一次按键。
 * 探针必须落在**冒泡阶段** —— 只有没人 `stopPropagation` 时它才会被叫到，
 * 这正是「事件有没有到达监听」那条判据的前提。
 */
interface FakeTarget {
  addEventListener: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener: (type: string, listener: (ev: unknown) => void) => void
  phase: 'capture' | 'bubble' | 'none'
  dispatch: (ev: unknown) => void
}

function fakeTarget(): FakeTarget {
  const listeners: Array<(ev: unknown) => void> = []
  const state: FakeTarget = {
    // `EscProbeTarget` 的签名只有两个参数：探针调用时不传第三个参 → 只能是冒泡阶段。
    // （捕获阶段那条判据由 D 组的源码守卫钉：源码里不许出现 `, true)`）
    addEventListener: (type, listener) => {
      if (type !== 'keydown') return
      state.phase = 'bubble'
      listeners.push(listener)
    },
    removeEventListener: (type, listener) => {
      if (type !== 'keydown') return
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
      state.phase = 'none'
    },
    phase: 'none',
    dispatch: (ev) => {
      for (const l of [...listeners]) l(ev)
    }
  }
  return state
}

beforeEach(() => {
  resetEscLayers()
  resetEscProbe()
  disableEscProbe()
})

// ── A. 深度与快照（纯函数） ─────────────────────────────────────────────
describe('A1 getEscLayerDepth / escLayerSnapshot', () => {
  it('空栈时 depth = 0、tokens 为空（不是层栈问题：App 的全局 Esc 接手）', () => {
    expect(getEscLayerDepth()).toBe(0)
    const snap = escLayerSnapshot()
    expect(snap.depth).toBe(0)
    expect(snap.tokens).toEqual([])
    expect(snap.seq).toBe(0)
    expect(snap.liveListeners).toBe(0)
    expect(snap.lastPress).toBeNull()
  })

  it('孤儿场景证得出来：push 三层、pop 中间一层 → depth 与 tokens 反映真实栈', () => {
    const lower = pushEscLayer()
    const middle = pushEscLayer()
    const upper = pushEscLayer()
    for (const token of [lower, middle, upper]) noteEscLayerListener(token, true)

    expect(getEscLayerDepth()).toBe(3)
    expect(escLayerSnapshot().tokens).toEqual([lower, middle, upper])
    // 三层都有活监听 → 不报孤儿（判据是 depth 与 liveListeners 的差，不是 depth 本身）
    expect(escLayerSnapshot().liveListeners).toBe(3)

    popEscLayer(middle) // 出栈不依赖压/弹顺序
    const snap = escLayerSnapshot()
    expect(snap.depth).toBe(2)
    expect(snap.tokens).toEqual([lower, upper])
    expect(snap.liveListeners).toBe(2)
    expect(diagnoseEscMiss(snap)).toBe('probe-off') // 探针未开时不许瞎下结论
  })

  it('「handler 未注册但栈里有 token」这种孤儿可被 snapshot 看出', () => {
    const orphan = pushEscLayer() // 只压栈、没挂监听（真机形态：层已卸载 / 清理没跑完）
    noteEscLayerListener(orphan, false)
    const liveTop = pushEscLayer()
    noteEscLayerListener(liveTop, true)

    const snap = escLayerSnapshot()
    expect(snap.depth).toBe(2)
    expect(snap.liveListeners).toBe(1)
    expect(snap.tokens).toEqual([orphan, liveTop])
    expect(diagnoseEscMiss(snap)).toBe('orphan-token')
  })

  it('snapshot 是纯函数：返回拷贝，改它不动真实栈（诊断不许有副作用）', () => {
    const token = pushEscLayer()
    const snap = escLayerSnapshot()
    snap.tokens.push(9999)
    snap.depth = 0
    expect(escLayerSnapshot().tokens).toEqual([token])
    expect(getEscLayerDepth()).toBe(1)
    expect(escLayerSnapshot().lastPress).toBeNull()
  })

  it('出栈时活监听一起清（否则 liveListeners 虚高、孤儿判据反向失灵）', () => {
    const token = pushEscLayer()
    noteEscLayerListener(token, true)
    popEscLayer(token)
    popEscLayer(token) // 重复出栈静默忽略（StrictMode 双挂载下清理会跑两次）
    const snap = escLayerSnapshot()
    expect(snap.depth).toBe(0)
    expect(snap.liveListeners).toBe(0)
    expect(diagnoseEscMiss(snap)).toBe('probe-off')
  })
})

// ── B. 探针：两条成因必须能从数据上分开 ────────────────────────────────
describe('B1 探针判据：孤儿 token vs 事件没到达监听', () => {
  it('探针是可选开关：默认关，打开后返回卸载函数', () => {
    expect(isEscProbeEnabled()).toBe(false)
    const target = fakeTarget()
    const uninstall = installEscProbe({ target })
    expect(isEscProbeEnabled()).toBe(true)
    uninstall()
    expect(isEscProbeEnabled()).toBe(false)
    // 卸载后派发按键不再记账（监听已摘 + 开关已关）
    target.dispatch(ESC)
    expect(escLayerSnapshot().presses).toBe(0)
  })

  it('探针注册在冒泡阶段（不是捕获），且成对移除', () => {
    const target = fakeTarget()
    const uninstall = installEscProbe({ target })
    expect(target.phase).toBe('bubble')
    uninstall()
    expect(target.phase).toBe('none')
  })

  it('成因①：depth > 0 且没有活监听 → orphan-token', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })

    pushEscLayer() // 孤儿：压了栈，没有对应的 keydown 监听
    target.dispatch(ESC)

    const snap = escLayerSnapshot()
    expect(snap.presses).toBe(1)
    expect(snap.depth).toBe(1)
    expect(snap.liveListeners).toBe(0)
    expect(snap.lastPress?.observedBy).toBe('probe')
    expect(diagnoseEscMiss(snap)).toBe('orphan-token')
    // 按键时落了一条 debug（这正是用户要的可观测性）
    expect(sent.length).toBe(1)
    expect(sent[0]?.level).toBe('debug')
    expect(sent[0]?.message).toBe('esc:unanswered')
    expect(sent[0]?.context?.['diagnosis']).toBe('orphan-token')
    expect(sent[0]?.context?.['depth']).toBe(1)
    expect(sent[0]?.context?.['liveListeners']).toBe(0)
  })

  it('成因②：每层都有活监听、但探针单独看到按键 → event-not-reached', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })

    const token = pushEscLayer()
    noteEscLayerListener(token, true) // 与孤儿场景的关键差别：这一层有真实监听
    target.dispatch(ESC)

    const snap = escLayerSnapshot()
    expect(snap.depth).toBe(1)
    expect(snap.liveListeners).toBe(1)
    expect(snap.lastPress?.observedBy).toBe('probe')
    expect(diagnoseEscMiss(snap)).toBe('event-not-reached')
    expect(sent[0]?.context?.['diagnosis']).toBe('event-not-reached')
    // 与前一条的数据差别写在注释里：depth == liveListeners 但探针独自看到按键
    expect(sent[0]?.context?.['liveListeners']).toBe(1)
  })

  it('同一个按键不被重复记账：活监听看到后探针不再记（否则两条判据混浊）', () => {
    const target = fakeTarget()
    installEscProbe({ target, sink: () => undefined })

    const token = pushEscLayer()
    noteEscLayerListener(token, true)
    const event = { key: 'Escape' }
    // 模拟真机：某层的捕获阶段监听先看到（这里非栈顶 → 原样放行，只记账）
    recordEscPress(event, 'layer', token, { notTop: true })
    target.dispatch(event)

    const snap = escLayerSnapshot()
    expect(snap.presses).toBe(1)
    expect(snap.probePresses).toBe(0)
    expect(snap.lastPress?.observedBy).toBe('layer')
    expect(diagnoseEscMiss(snap)).toBe('answered-not-top')
  })

  it('非按键事件不记账；空栈时不落 debug（depth > 0 才落）', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })

    target.dispatch(OTHER)
    target.dispatch(ESC)
    const snap = escLayerSnapshot()
    expect(snap.presses).toBe(1)
    expect(diagnoseEscMiss(snap)).toBe('no-layer')
    expect(sent.length).toBe(0) // 栈空 → 不刷屏，也不误导成层栈问题
  })

  it('消费型按键（栈顶 + 无 data-esc-own）判定 consumed，且不落 debug', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })

    const token = pushEscLayer()
    noteEscLayerListener(token, true)
    recordEscPress(ESC, 'layer', token, { consumed: true })

    const snap = escLayerSnapshot()
    expect(snap.consumedPresses).toBe(1)
    expect(diagnoseEscMiss(snap)).toBe('consumed')
    expect(sent.length).toBe(0) // 正常消费不该落 debug：只有「放行 / 无应答」才落
  })
})

// ── C. 调试开关：只在按键时落，不刷屏 ──────────────────────────────────
describe('C1 调试开关（debug 级，仅按键时）', () => {
  it('escOwnedByControl 命中（depth > 0）时落一条 debug 级记录', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })

    const token = pushEscLayer()
    noteEscLayerListener(token, true)
    recordEscPress(ESC, 'layer', token, { passedToControl: true })

    expect(sent.length).toBe(1)
    expect(sent[0]?.level).toBe('debug')
    expect(sent[0]?.message).toBe('esc:passed-to-control')
    expect(sent[0]?.context?.['diagnosis']).toBe('passed-to-control')
    expect(sent[0]?.context?.['depth']).toBe(1)
    expect(sent[0]?.context?.['tokens']).toEqual([token])
  })

  it('连按不被去重（去重会抹掉我们要取证的那个形态），但受每窗口 20 条总量卡住', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })
    pushEscLayer() // 孤儿层

    for (let i = 0; i < 3; i++) target.dispatch(ESC)
    expect(escLayerSnapshot().presses).toBe(3)
    expect(sent.length).toBe(3) // 「连按两次没反应、第三次才关」那个形态必须留得下来

    for (let i = 0; i < 30; i++) target.dispatch(ESC)
    expect(sent.length).toBe(20) // 总量上限兜底，不刷屏
    expect(escLayerSnapshot().presses).toBe(33)
  })

  it('不刷屏（二）：反复调 snapshot 不落任何日志，只有按键才落', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    installEscProbe({ target, sink: (p) => sent.push(p) })
    pushEscLayer()

    for (let i = 0; i < 100; i++) void escLayerSnapshot()
    expect(sent.length).toBe(0)

    target.dispatch(ESC)
    expect(sent.length).toBe(1)
  })

  it('探针未开时完全不落盘（这就是「可选」开关的意思）', () => {
    const sent: RendererLogPayload[] = []
    const target = fakeTarget()
    // 不调 installEscProbe：开关关
    pushEscLayer()
    recordEscPress(ESC, 'layer', null, { passedToControl: true })
    target.dispatch(ESC)
    expect(sent.length).toBe(0)
    expect(escLayerSnapshot().probeEnabled).toBe(false)
  })
})

// ── D. 语义纪律（源码守卫） ────────────────────────────────────────────
describe('D1 加探针不许改变 Esc 语义（只放行、绝不 stop）', () => {
  it('useEscLayer：非栈顶与 data-esc-own 都原样放行，只有栈顶才 stopPropagation', () => {
    const src = read('logic/escLayer.ts')
    const hookAt = src.indexOf('export function useEscLayer')
    expect(hookAt).toBeGreaterThan(-1)
    const block = src.slice(hookAt)

    // 全模块只有一处 stopPropagation **调用**，且属于栈顶那条分支
    // （按调用来数，不按字面量：注释里解释这条纪律时会出现这个词）
    expect(block.match(/\.stopPropagation\(\)/g)?.length).toBe(1)
    // `escOwnedByControl` 命中时必须直接 return（不 stop、不关）
    expect(block).toContain('if (escOwnedByControl(e.target)) return')
    // 非栈顶必须 return（把按键原样放行给上面那层）
    expect(block).toContain('if (!isTopEscLayer(token))')
    // 捕获阶段 + 成对移除
    expect(block).toContain("window.addEventListener('keydown', onKey, true)")
    expect(block).toContain("window.removeEventListener('keydown', onKey, true)")
    // handler 存 ref，依赖只写 active
    expect(block).toContain('const handlerRef = useRef(handler)')
    expect(block).toContain('}, [active])')
    // active=false 不入栈（入栈发生在判定之后）—— 否则它自己就成了孤儿 token
    const guardAt = block.indexOf('if (!active) return')
    const pushAt = block.indexOf('const token = pushEscLayer()')
    expect(guardAt).toBeGreaterThan(-1)
    expect(pushAt).toBeGreaterThan(guardAt)
  })

  it('谁挂 keydown 必须上报活监听（漏一处就把正常层误报成孤儿）', () => {
    const src = read('logic/escLayer.ts')
    expect(src).toContain('export function noteEscLayerListener')
    const hookAt = src.indexOf('export function useEscLayer')
    const block = src.slice(hookAt)
    expect(block).toContain('noteEscLayerListener(token, true)')
    expect(block).toContain('noteEscLayerListener(token, false)')
    // 上报必须在 pop 之前：pop 会连带清 liveListeners
    const reportAt = block.indexOf('noteEscLayerListener(token, false)')
    const popAt = block.indexOf('popEscLayer(token)')
    expect(reportAt).toBeGreaterThan(-1)
    expect(popAt).toBeGreaterThan(reportAt)
  })

  it('探针绝不含 stopPropagation / preventDefault（它是观察者，不是消费方）', () => {
    const src = read('logic/escLayer.ts')
    const probeAt = src.indexOf('export function installEscProbe')
    expect(probeAt).toBeGreaterThan(-1)
    const block = src.slice(probeAt, src.indexOf('export function disableEscProbe'))
    expect(block).not.toContain('stopPropagation')
    expect(block).not.toContain('preventDefault')
    // 探针必须注册在冒泡阶段（第三个参不许是 true）
    expect(block).toContain("target.addEventListener('keydown', onProbeKey)")
    expect(block).not.toContain("addEventListener('keydown', onProbeKey, true)")
  })

  it('App 的全局 Esc 判据没被改写（hasEscLayer 仍是唯一让路条件）', () => {
    const app = read('App.tsx')
    expect(app).toContain('hasEscLayer()')
    expect(read('logic/escPriority.ts')).toContain('if (ctx.modalOpen) return')
  })

  it('探针在渲染层入口显式接线（否则开关永远没人打开，日志里查不到现场）', () => {
    const entry = read('main.tsx')
    expect(entry).toContain('installEscProbe(')
    expect(entry).toContain("from './logic/escLayer'")
    // 落盘出口仍是既有那条 reportLog 通道，不新开 IPC
    expect(entry).toContain('reportLog')
  })
})
