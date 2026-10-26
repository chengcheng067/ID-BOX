import { useEffect, useRef, useState } from 'react'
import { createLogThrottle, type LogThrottle } from './rendererLog'
import type { RendererLogPayload } from '../../shared/types'

/**
 * 弹窗 Esc 的「层栈」（0.7.6 T-ESC）。
 *
 * 为什么需要栈，而不是每个弹窗各挂一个 keydown：
 * - 捕获阶段先于冒泡阶段，`window` 又处在传播路径最前端 —— 谁先注册谁先拿到按键。
 *   两个弹窗同时在场时（导入重复处置压在设置之上）靠注册顺序决定谁吃 Esc 是错的；
 *   Esc 必须归**最后打开的那一层**（栈顶），否则会「关掉底下那个、上面那个还在」。
 * - 分类选择器的一级/二级浮层是**弹窗内部的第二层**：浮层展开时 Esc 只应收起浮层、
 *   不关整个弹窗。它在 `Modal` 之后压栈，天然排在栈顶，正好表达这个语义。
 *
 * 约定：只有栈顶那一层可以 `stopPropagation()` 并消费按键。非栈顶的监听**必须原样放行**
 * （既不 stop 也不 close），否则下面的层永远收不到 Esc。
 *
 * 这个模块只维护「谁在上面」，不关心具体行为；行为由各层自己的 handler 决定
 * （`Modal` = onClose，导入重复处置 = 吃掉但不关，分类浮层 = 收起浮层）。
 */
const layers: number[] = []
let seq = 0

/**
 * 层栈变化的订阅者（0.7.8 T-ZSTACK）。
 *
 * 为什么要有订阅：视觉层级（z-index）必须由**层栈深度**算（见 `logic/zStack.ts`），
 * 而深度会随着「上面又开了一个弹窗 / 上面那个弹窗关了」变化 —— 组件必须被通知重算，
 * 否则第 1 层的设置弹窗会一直停在 50、后开的重复处置弹窗也是 50，谁在上只由 DOM 顺序碰运气。
 *
 * 这里刻意只暴露「变化了」这一件事，不暴露具体深度：订阅方用**自己的 token** 去
 * `getEscLayerRank()` 读位置，于是层级与 Esc 应答永远是同一份数据的两种读法。
 */
const layerSubscribers = new Set<() => void>()

/** 通知所有订阅者「栈变了」（push / pop / 复位三处调用；订阅方自会比对是否真的变了） */
function notifyLayerChange(): void {
  // 先拷一份再遍历：订阅方在回调里可能又触发 push/pop（例如同步卸载一个弹窗）
  for (const listener of [...layerSubscribers]) listener()
}

/** 订阅层栈变化，返回取消订阅函数（StrictMode 双挂载安全：每次 effect 各自订阅/退订） */
export function subscribeEscLayers(listener: () => void): () => void {
  layerSubscribers.add(listener)
  return () => {
    layerSubscribers.delete(listener)
  }
}

/**
 * 本层在栈里的位置：**1 = 最底**，栈顶 = `layers.length`，token 不在栈里 = 0。
 *
 * 与 `isTopEscLayer()` 同源（都读 `layers`）：`isTopEscLayer(token)` ≡ `getEscLayerRank(token) === depth`。
 * 层级换算只在 `logic/zStack.ts` 里做，本模块不引入任何 z-index 概念。
 */
export function getEscLayerRank(token: number): number {
  const at = layers.indexOf(token)
  return at < 0 ? 0 : at + 1
}

/**
 * 深度探针（0.7.7，用户点名要修的理论风险：**孤儿 token**）。
 *
 * 第 1 轮真机出现过「连按两次 Esc 没反应、第三次才关」，干净起点跑 3 轮复现不了，
 * 所以这一批**不改语义**，只加观测：下次再出现时能靠数据分清两种成因。
 *
 *   ① 孤儿 token：栈里有 token，但背后已经没有活的 keydown 监听
 *      （`layers.length > liveListeners.size`）→ 按键谁都不会消费，App 的全局 Esc
 *      又因为 `hasEscLayer()` 为真而让路 → 表现就是「按 Esc 没反应」。
 *   ② 事件根本没到达监听：栈里有 token、且这些 token 都有活监听（数量相等），
 *      但按键在到达 `window` 之前就被别的捕获阶段处理器截走（焦点在输入框/iframe/
 *      第三方组件里），于是活监听一次都没看到它。
 *
 * 两者在数据上是两条不同的判据：①看 `depth` 与 `liveListeners` 的差，
 * ②看探针（挂在**冒泡阶段**，只有没人 `stopPropagation` 才会跑到它）有没有观察到这次按键。
 * 探针本身只读、只记账：绝不 `stopPropagation` / `preventDefault`，也不参与「谁吃按键」。
 */

/** 栈里哪些 token 背后还挂着活的 keydown 监听（孤儿判据的分母） */
const liveListeners = new Set<number>()

/** 已经被「活监听」看到过的按键事件（探针靠它判断事件有没有到达监听） */
let observedEvents = new WeakSet<object>()

/** 探针/调试开关：默认关；打开后只在按键时落 debug 级记录 */
let probeEnabled = false
let debugSink: EscProbeSink | null = null
let debugThrottle: LogThrottle = createLogThrottle()

let pressCount = 0
let consumedPresses = 0
let passedToControlPresses = 0
let probePresses = 0
let lastPress: EscPressRecord | null = null

/** 压入一层，返回本层 token（卸载时用它出栈，不依赖压/弹顺序） */
export function pushEscLayer(): number {
  seq += 1
  layers.push(seq)
  notifyLayerChange()
  return seq
}

/** 弹出指定层（token 已不在栈里时静默忽略：StrictMode 双挂载下清理可能重复跑） */
export function popEscLayer(token: number): void {
  const index = layers.indexOf(token)
  if (index >= 0) {
    layers.splice(index, 1)
    // 只在本层真的在栈里时才通知：重复弹（StrictMode 清理重复执行）不该引发一轮无意义的重算
    notifyLayerChange()
  }
  // 出栈的层不可能再有活监听：一起清掉，避免 `liveListeners` 与栈不一致
  liveListeners.delete(token)
}

/** 本层是否是栈顶（只有栈顶能消费 Esc） */
export function isTopEscLayer(token: number): boolean {
  return layers[layers.length - 1] === token
}

/** 当前是否有任何一层在吃 Esc（App 的全局 Esc 据此让路，双保险见 `escPriority.ts`） */
export function hasEscLayer(): boolean {
  return layers.length > 0
}

/** 层栈深度（= `layers.length`）：「按 Esc 没反应」时第一个要看的数 */
export function getEscLayerDepth(): number {
  return layers.length
}

/** 单次按键的观察记录（探针与消费方共用同一份结构，便于两边对照） */
export interface EscPressRecord {
  /** 第几次按键（全局递增，从 1 开始） */
  index: number
  /** 按键瞬间的栈深度 */
  depth: number
  /** 按键瞬间「背后还有活监听」的 token 数（孤儿判据：depth > liveListeners） */
  liveListeners: number
  /** 按键瞬间栈里的 token 快照（顺序 = 从底到顶） */
  tokens: number[]
  /** 按键瞬间的栈顶 token（栈空为 null） */
  topToken: number | null
  /** 观察方：`layer` = 某个层的活监听看到；`probe` = 只有探针看到（说明事件到了 window） */
  observedBy: 'layer' | 'probe'
  /** 这一层是否消费了按键（stopPropagation + 回调） */
  consumed: boolean
  /** 是否因 `data-esc-own` 放行给控件 */
  passedToControl: boolean
  /** 是否「非栈顶所以原样放行」 */
  notTop: boolean
}

/** 诊断快照（纯函数：只读状态、返回拷贝，不产生任何副作用） */
export interface EscLayerSnapshot {
  depth: number
  tokens: number[]
  seq: number
  liveListeners: number
  probeEnabled: boolean
  presses: number
  consumedPresses: number
  passedToControlPresses: number
  probePresses: number
  lastPress: EscPressRecord | null
}

/** 「按 Esc 无反应」的判定结果 */
export type EscMissDiagnosis =
  | 'probe-off'
  | 'no-layer'
  | 'orphan-token'
  | 'event-not-reached'
  | 'answered-not-top'
  | 'passed-to-control'
  | 'consumed'

/** 诊断快照：`{ depth, tokens, seq }` + 探针计数（纯函数，可随时调，不写任何东西） */
export function escLayerSnapshot(): EscLayerSnapshot {
  return {
    depth: layers.length,
    tokens: [...layers],
    seq,
    liveListeners: liveListeners.size,
    probeEnabled,
    presses: pressCount,
    consumedPresses,
    passedToControlPresses,
    probePresses,
    lastPress: lastPress ? { ...lastPress, tokens: [...lastPress.tokens] } : null
  }
}

/**
 * 把快照读成结论。判据顺序（不能换）：
 *   ① `depth > liveListeners` → **孤儿 token**（栈里有 token 却没有活监听）。
 *      这条是**纯状态算术**，不依赖探针，所以排在探针开关之前 —— 它是我们最想抓的
 *      那个形态（按 Esc 谁都不应答），不能因为"没开调试开关"就不给结论；
 *   ② 探针没开 → 之后的判据（事件有没有到达监听）需要按键现场，数据不足，不下结论；
 *   ③ 栈空 → 不是层栈问题（App 全局 Esc 接手，走 `decideEsc`）；
 *   ④ 探针单独看到这次按键（没有任何活监听看到）→ **事件没到达监听**；
 *   ⑤ 其余按当次按键的实际落点分类。
 */
export function diagnoseEscMiss(snapshot: EscLayerSnapshot): EscMissDiagnosis {
  if (snapshot.depth > snapshot.liveListeners) return 'orphan-token'
  if (!snapshot.probeEnabled) return 'probe-off'
  if (snapshot.depth === 0) return 'no-layer'
  const press = snapshot.lastPress
  if (!press) return 'event-not-reached'
  if (press.passedToControl) return 'passed-to-control'
  if (press.consumed) return 'consumed'
  if (press.observedBy === 'probe') return 'event-not-reached'
  return 'answered-not-top'
}

/**
 * 谁挂了 keydown 必须上报（`Modal` 与 `useEscLayer` 两条路径都要）。
 *
 * 不上报的层会被探针当成「栈里有 token 但没有活监听」→ 误报孤儿。这不是可选装饰：
 * `depth > liveListeners` 这条判据的成立完全依赖每个消费方都老实上报。
 */
export function noteEscLayerListener(token: number, live: boolean): void {
  if (live) liveListeners.add(token)
  else liveListeners.delete(token)
}

/** 按键记账（只在按键时调用）：写快照、必要时落 debug。绝不参与事件传播决策。 */
export function recordEscPress(
  event: object,
  observedBy: 'layer' | 'probe',
  token: number | null,
  flags: { consumed?: boolean; passedToControl?: boolean; notTop?: boolean } = {}
): EscPressRecord {
  pressCount += 1
  const record: EscPressRecord = {
    index: pressCount,
    depth: layers.length,
    liveListeners: liveListeners.size,
    tokens: [...layers],
    topToken: layers.length > 0 ? layers[layers.length - 1] : null,
    observedBy,
    consumed: flags.consumed === true,
    passedToControl: flags.passedToControl === true,
    notTop: flags.notTop === true
  }
  if (record.consumed) consumedPresses += 1
  if (record.passedToControl) passedToControlPresses += 1
  if (observedBy === 'probe') probePresses += 1
  if (observedBy === 'layer') observedEvents.add(event)
  lastPress = record

  // 只在按键时落盘；主进程侧 debug 级仅在设置「记录详细日志」打开时才写，所以这条天然是可选开关。
  // key 用按键序号（每条唯一）→ 不去重：连按两次 Esc 这种**正是我们要取证**的形态不能被去重掉，
  // 刷屏风险只由「每窗口 20 条」的总量上限兜。
  if (debugSink && record.depth > 0 && (record.passedToControl || record.observedBy === 'probe')) {
    emitDebug(record)
  }
  return record
}

/** 探针事件里我们关心的字段（KeyboardEvent 结构类型兼容，单测可传假对象） */
export interface EscProbeEvent {
  key?: unknown
}

/** 探针需要的最小事件源（`window` 满足；单测可传假对象） */
export interface EscProbeTarget {
  addEventListener: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

export type EscProbeSink = (payload: RendererLogPayload) => void

export interface InstallEscProbeOptions {
  /** 事件源，默认 `window` */
  target?: EscProbeTarget
  /** 落盘出口（通常接 preload 的 `reportLog`） */
  sink?: EscProbeSink
  /** 限流器，默认沿用渲染层日志的 20 条 / 10 秒 */
  throttle?: LogThrottle
}

/**
 * 打开调试开关（可选）。返回卸载函数。
 *
 * 探针挂在 `keydown` 的**冒泡阶段**：只有没有任何层 `stopPropagation` 时才会跑到它。
 * 于是「探针看到了」= 事件走到了 window 而没有任何活监听消费 → 与「孤儿 token」
 * 那条判据配合，就能把两种成因分开。StrictMode 双挂载时靠返回值卸载，不重复挂。
 */
export function installEscProbe(options: InstallEscProbeOptions = {}): () => void {
  debugSink = options.sink ?? null
  debugThrottle = options.throttle ?? createLogThrottle()
  probeEnabled = true

  const target: EscProbeTarget | null =
    options.target ?? (typeof window === 'undefined' ? null : (window as unknown as EscProbeTarget))
  if (!target) return () => disableEscProbe()

  const onProbeKey = (event: unknown): void => {
    if (!probeEnabled) return
    const ev = (event ?? {}) as EscProbeEvent
    if (ev.key !== 'Escape') return
    // 某个层的活监听已经看到过这次按键 → 不属于「事件没到达监听」，别重复记账
    if (typeof event === 'object' && event !== null && observedEvents.has(event as object)) return
    recordEscPress(event as object, 'probe', null, {})
  }

  target.addEventListener('keydown', onProbeKey)
  return () => {
    target.removeEventListener?.('keydown', onProbeKey)
    disableEscProbe()
  }
}

/** 关掉开关（不清历史计数：历史正是取证现场） */
export function disableEscProbe(): void {
  probeEnabled = false
  debugSink = null
}

/** 探针开关是否打开 */
export function isEscProbeEnabled(): boolean {
  return probeEnabled
}

/** 仅供测试：清空栈（避免用例之间互相污染） */
export function resetEscLayers(): void {
  layers.length = 0
  liveListeners.clear()
  // 订阅方（已挂载的弹窗）据此把深度归零，避免测试之间残留上一轮的层级
  notifyLayerChange()
}

/** 仅供测试：清空探针计数与开关 */
export function resetEscProbe(): void {
  pressCount = 0
  consumedPresses = 0
  passedToControlPresses = 0
  probePresses = 0
  lastPress = null
  debugSink = null
  debugThrottle = createLogThrottle()
  // ⚠️ 必须换一个新的 WeakSet：单测里复用同一个事件对象派发时，上一轮的「已被活监听
  // 看到」会把下一轮的探针记录整段吃掉（表现为 presses/sent 全是 0，看起来像探针坏了）。
  // 运行时没有这个问题（一个真实事件只派发一次），但复位不彻底会让守卫测试变成假绿/假红。
  observedEvents = new WeakSet<object>()
}

/** 落一条 debug（仅按键时；栈为空时什么都不落） */
function emitDebug(record: EscPressRecord): void {
  if (!debugSink) return
  const message = record.passedToControl ? 'esc:passed-to-control' : 'esc:unanswered'
  if (!debugThrottle.allow(`${message}|${record.index}`)) return
  debugSink({
    level: 'debug',
    message,
    context: {
      depth: record.depth,
      tokens: record.tokens,
      seq,
      liveListeners: record.liveListeners,
      topToken: record.topToken,
      observedBy: record.observedBy,
      diagnosis: diagnoseEscMiss(escLayerSnapshot()),
      pressIndex: record.index,
      suppressed: debugThrottle.suppressed()
    }
  })
}

/**
 * 事件目标是否声明了「Esc 归我」（`data-esc-own`）。
 *
 * 为什么需要：Esc 监听挂在 `window` **捕获**阶段，早于任何输入框自己的 `onKeyDown`
 * （React 的合成事件在冒泡阶段才跑）。设置 · 别名表格里的输入框要把 Esc 解释成
 * 「回滚这条草稿」而不是「关掉整个弹窗」——用属性把它标出来，消费方见到就让路
 * （不 stop、不关），按键继续传给控件自己的处理函数。
 *
 * 两个消费方**都必须**调它：`Modal`（含 `Modal` 外壳的弹窗）与 `useEscLayer`
 * （自绘 `dialog-scrim` 的弹窗）。少一处就会出现 0.7.6 真机那条缺陷：
 * 设置页是自绘外壳，只有 `Modal` 认这个标记 → 输入框回滚了、弹窗同时被 App 关掉。
 */
export function escOwnedByControl(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('[data-esc-own]') !== null
}

/**
 * 给「不是 `Modal` 的第二层」用的 Esc 监听（分类浮层 / 自绘弹窗）。
 *
 * 监听挂在 `window` 捕获阶段，与 `Modal` 同阶段；只有自己是栈顶时才 stop + 回调。
 * handler 存 ref（依赖只写 `active`）：否则调用方每次 render 传内联箭头都会重挂监听，
 * 频繁 pop/push 会让本层在栈里的位置漂移。
 *
 * **返回值 = 本层在栈里的位置**（1 = 最底；`active=false` / 未入栈 = 0）。0.7.8 T-ZSTACK：
 * 自绘 `dialog-scrim` 的弹窗用这个数去 `zClassForDepth()` 算遮罩的 z-index —— 视觉层级与
 * Esc 应答因此读的是**同一个 token 在同一个栈里的位置**，不存在两套来源对不上的可能。
 */
export function useEscLayer(handler: () => void, active: boolean): number {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    // `active = false` 不入栈：这一层根本没挂监听，压栈就成了「栈里有 token 却没有活监听」
    // —— 也就是探针要抓的孤儿形态。所以这里必须早退，不能先 push 再判。
    if (!active) return
    const token = pushEscLayer()
    noteEscLayerListener(token, true)
    // 深度是「本层 token 在栈里的位置」：push/pop 后都要重读，本层被新弹窗压下去时深度会变
    const syncDepth = (): void => setDepth(getEscLayerRank(token))
    syncDepth()
    const unsubscribe = subscribeEscLayers(syncDepth)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (!isTopEscLayer(token)) {
        // 非栈顶：原样放行（既不 stop 也不 close），这里只记账，不改控制流
        recordEscPress(e, 'layer', token, { notTop: true })
        return
      }
      // 输入框声明了「Esc 归我」→ 不吃、不关，让控件自己回滚草稿。
      // 这里**不能** stopPropagation：按键要继续传给控件的 React onKeyDown；
      // 之后即使再冒泡到 App 的全局 Esc，也会因 `hasEscLayer()` 为真而不动作。
      // （探针在这里只记账 + 落 debug，控制流与 0.7.6 逐字一致）
      if (escOwnedByControl(e.target)) return void recordEscPress(e, 'layer', token, { passedToControl: true })
      // 吃掉这次按键：否则 App 的全局 Esc（冒泡阶段）会顺手清掉选中 / 关掉下层视图
      recordEscPress(e, 'layer', token, { consumed: true })
      e.stopPropagation()
      handlerRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      // 先退订：pop 会通知所有订阅者，本层此时正在卸载，不该再被叫醒
      unsubscribe()
      window.removeEventListener('keydown', onKey, true)
      noteEscLayerListener(token, false)
      popEscLayer(token)
      // 出栈后本层不再占位置（active 变 false 的场合；卸载时这句是无害的空写）
      setDepth(0)
    }
  }, [active])

  return depth
}
