/**
 * 材质球舞台的**纯状态机**（docs/19 裁定②，A 线）。
 *
 * 为什么单独抽一个零 React / 零 DOM 的模块：
 * - 舞台的生命周期有 5 个相位，且**动画回调可能过期**（连点另一张卡、Esc 抢退、
 *   资产被删、弹窗交接中途关闭），把这些判定写在组件里就会出现「球还在飞、下面已经
 *   变回网格」的穿帮；
 * - 纯函数可以在 node 里逐条覆盖（见 tests/ballStage.test.ts），不需要渲染器。
 *
 * 纪律（硬）：
 * - 本模块**不碰 DOM、不读 store、不 import React**；
 * - `originRect` 是 dblclick 时**同步拍下**的快照，动画全程只读它——不能每帧
 *   `getBoundingClientRect()`（网格在退场时会 transform，读出来是错的）；
 * - `runId` 单调递增，所有异步回调必须带上发起时的 runId，不等就丢弃。
 *
 * 2026-10（0.6.2）：新增 `handoff` 相位 —— 舞台球飞进「自定义渲染」弹窗的那颗球，
 * 到位后**同一颗球继续用**（弹窗球显形、舞台球隐身）。
 *
 * 2026-10（0.6.3）：新增 `handback` 相位 —— 关弹窗/保存时球从弹窗位置飞回**顶栏槽位**
 * （结束后仍是 `active`，球留在顶部可见）。它与 `closing` 是**两个方向、两个终点**：
 * - `closing`：退出文件视图 → 飞回**网格卡片**（originRect）→ `idle`；
 * - `handback`：关弹窗 → 飞回**顶栏槽位**（readTarget）→ `active`。
 * 曾经的 bug：关弹窗误用 `closing`，球飞向早已不在屏幕上的卡片坐标然后消失。
 */
export type StagePhase = 'idle' | 'opening' | 'active' | 'closing' | 'handoff' | 'handback'

export interface StageState {
  phase: StagePhase
  /** opening / active 的资产；**closing 必须为 null**（网格已经回来接管了） */
  assetId: string | null
  /** dblclick 时的卡片矩形快照；closing 期间仍保留，供返回动画使用 */
  originRect: DOMRect | null
  /**
   * 弹窗里那颗球的外接框：`handoff` 的落点，也是随后的 closing 起点。
   * 只在 active/handoff/closing 有意义，sweep / abort 清空。
   */
  handoffRect: DOMRect | null
  /**
   * 球已交给弹窗：此时 `phase` 仍是 `active`（舞台仍占着界面），
   * 但**舞台那颗球必须隐身**（否则屏幕上同时有两颗）。
   */
  handedOff: boolean
  /** 单调递增：每次开门/关门/交接都 +1，用来丢弃过期回调 */
  runId: number
}

export const STAGE_IDLE: StageState = {
  phase: 'idle',
  assetId: null,
  originRect: null,
  handoffRect: null,
  handedOff: false,
  runId: 0
}

/** 开门参数：assetId + 同步快照 */
export interface StageTarget {
  assetId: string
  rect: DOMRect
}

/**
 * idle → opening（也允许 active/opening 直接切到另一张卡：连点）。
 * 每次开门 runId + 1，上一轮还活着的 transitionend 会因此被丢弃。
 * 新一轮开门必须把交接状态清干净 —— 否则上一轮的 `handedOff` 会让新球一开门就隐身。
 */
export function beginOpen(prev: StageState, target: StageTarget): StageState {
  return {
    phase: 'opening',
    assetId: target.assetId,
    originRect: target.rect,
    handoffRect: null,
    handedOff: false,
    runId: prev.runId + 1
  }
}

/** opening → active（只有本轮的 runId 能落定） */
export function settleActive(prev: StageState, runId: number): StageState {
  if (runId !== prev.runId) return prev
  if (prev.phase !== 'opening') return prev
  return { ...prev, phase: 'active' }
}

/**
 * active → handoff（把球飞进「自定义渲染」弹窗）。
 *
 * 只允许 `active 且尚未交接`：opening 期间球还在半路、closing 期间网格已经回来，
 * 这两种时机交接都会让"同一颗球"的真值对不上，所以原样返回（幂等、可重复调用）。
 */
export function beginHandoff(prev: StageState, rect: DOMRect): StageState {
  if (prev.phase !== 'active' || prev.handedOff) return prev
  return {
    phase: 'handoff',
    assetId: prev.assetId,
    originRect: prev.originRect,
    handoffRect: rect,
    handedOff: false,
    runId: prev.runId + 1
  }
}

/** handoff → active（球已到位）；`handedOff` 置真 = 舞台球隐身、弹窗球接管 */
export function settleHandoff(prev: StageState, runId: number): StageState {
  if (runId !== prev.runId) return prev
  if (prev.phase !== 'handoff') return prev
  return { ...prev, phase: 'active', handedOff: true }
}

/**
 * active(已交接) / handoff → handback（关弹窗：球从弹窗位置飞回**顶栏槽位**）。
 *
 * 允许两种来源：
 * - `active && handedOff`：正常"弹窗开着，球在弹窗里"；
 * - `handoff`：交接动画还没演完用户就点了关闭（球正飞向弹窗，直接掉头）。
 * 其余相位一律原样返回 —— 特别是**不允许** `closing`（那是"回网格"方向，
 * 两者不能串联，否则球会在半空改主意）。
 */
export function beginHandback(prev: StageState): StageState {
  const fromHandedOff = prev.phase === 'active' && prev.handedOff
  const fromHandoff = prev.phase === 'handoff'
  if (!fromHandedOff && !fromHandoff) return prev
  return {
    phase: 'handback',
    assetId: prev.assetId,
    originRect: prev.originRect,
    handoffRect: prev.handoffRect, // 起点仍是弹窗位置
    handedOff: false, // 舞台球必须复活（否则飞回来那颗不可见）
    runId: prev.runId + 1
  }
}

/**
 * handback → active（球已回到顶栏槽位）。
 * 终点语义：球**继续留在顶部可见**，所以 handedOff 与 handoffRect 都要清掉。
 */
export function settleHandback(prev: StageState, runId: number): StageState {
  if (prev.phase !== 'handback') return prev
  if (runId !== prev.runId) return prev
  return { ...prev, phase: 'active', handedOff: false, handoffRect: null }
}

/**
 * opening / active / handoff → closing。
 * **先拍快照再清 assetId**：网格在 closing 的第一帧就要回来，
 * 而返回动画仍然需要 originRect —— 这就是「球还在飞、下面已变回网格」的防线。
 *
 * `handoffRect` 必须保留：交接后的返回从**弹窗位置**起飞（球在弹窗里，
 * 不是从顶栏槽位飞出）。`handedOff` 必须清掉，否则 closing 期间舞台球还是隐身的。
 *
 * ⚠️ **不接受 `handback` 来源**：`handback` 是"关弹窗 → 回顶栏槽位"，
 * `closing` 是"退文件视图 → 回网格卡片"，两个方向不能串联（见文件头的相位说明）。
 */
export function beginClose(prev: StageState): StageState {
  if (prev.phase !== 'opening' && prev.phase !== 'active' && prev.phase !== 'handoff') return prev
  return {
    phase: 'closing',
    assetId: null,
    originRect: prev.originRect,
    handoffRect: prev.handoffRect,
    handedOff: false,
    runId: prev.runId + 1
  }
}

/** closing → idle（返回动画结束时调用）；runId 不符说明已被新一轮接管，原样返回 */
export function sweep(prev: StageState, runId: number): StageState {
  if (prev.phase !== 'closing') return prev
  if (runId !== prev.runId) return prev
  return {
    phase: 'idle',
    assetId: null,
    originRect: null,
    handoffRect: null,
    handedOff: false,
    runId: prev.runId
  }
}

/**
 * 资产被删：**任何相位都直接回 idle，不播动画**（docs/19 §1 状态表的收口分支）。
 * 与 sweep 的区别：sweep 要求处于 closing 且 runId 匹配，这里是"外部事件强制收口"。
 */
export function abort(prev: StageState): StageState {
  if (prev.phase === 'idle') return prev
  return {
    phase: 'idle',
    assetId: null,
    originRect: null,
    handoffRect: null,
    handedOff: false,
    runId: prev.runId + 1
  }
}

/** 该相位是否应该让球每帧跑（只有 active 需要；其余暂停 rAF 但不 dispose） */
export function shouldRun(phase: StagePhase): boolean {
  return phase === 'active'
}

/** 舞台当前是否占着界面（供调用方决定是否吞掉 Esc / 滚轮等） */
export function isStageBusy(phase: StagePhase): boolean {
  return phase !== 'idle'
}
