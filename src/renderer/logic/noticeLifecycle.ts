/**
 * 屏幕居中临时气泡的「notice 生命周期」纯逻辑（2026-11-10 用户裁定 + 从底层修不消失的 bug）。
 *
 * ## 要修的根因（不是补一个 timer）
 * 旧实现把 notice 的消失计时器放在 `NoticeToast.tsx` 的 `useEffect` 里：一个 4.5 秒的
 * `setTimeout`（回调把 `setNotice` 置回 `null`）+ cleanup 里 `clearTimeout`。一旦组件在计时器
 * 触发前卸载（`<React.StrictMode>` 双挂载、ErrorBoundary「重新加载窗口」重建整棵树），
 * 计时器被 cleanup 清掉、再没人重新排期 → `notice` 永久残留在 store 里，而底部通栏
 * **没有任何关闭出口**，于是「已移入「最近删除」」这类提示永远不消失。
 *
 * ## 本模块的四条口径
 * 1. **责任上移**：到期清理归**状态层**（模块作用域单例 `NoticeRuntime`），不属于任何组件。
 *    组件退化成纯渲染（state → UI），卸载 / 重挂 / 重载都不影响状态层计时器。
 * 2. **绝对到期时间 + 来源 id**：每条 notice 带 `expiresAt`（`Date.now()` 绝对值）和单调
 *    递增 `id`。超时回调 `shouldClearOnTimeout()` 必须「id 对得上 **且** 确实到期」才清，
 *    旧 timer 绝不误清后来写入的新提示。
 * 3. **统一收口**：`show()` / `enqueue()` / `dismiss()` / `absorb()` 是仅有的四个入口，
 *    共用同一份状态与同一个计时器。`notice` 的 ~90 处裸写（`set({ notice })` /
 *    `useVault.setState({ notice })` / `set((s) => ({ ..., notice }))`）由 `store.ts`
 *    的订阅调用 `absorb()` 汇到同一个 runtime，无需逐处改业务文案。
 * 4. **队列语义保留**：`enqueue()` 依次展示、互不吞并，每条独立 `NOTICE_SHOW_MS`（2026-11-13 起 3s）；**最后一条到点也会
 *    清空**（旧 `drainNoticeQueue()` 在 `shift()` 返回 undefined 时直接 return、从不清
 *    最后一条 —— 那是「两套消失机制互不感知」的另一半根因，本模块一并修掉）。
 *
 * ## 为什么全部做成纯函数 / 依赖注入
 * 本项目 vitest 是 `environment: 'node'`、**没有 jsdom**，组件生命周期测不了。所以时钟 /
 * 计时器 / 状态写回全部注入，运行时可在 node 里用假时钟确定性地推进；
 * `tests/noticeLifecycle.test.ts` 覆盖 6 条验收判据（含组件卸载后状态层仍会清理）。
 */

/**
 * 一条 notice 的展示时长（毫秒）—— **全应用唯一时长口径**。
 * 2026-11-13 用户拍板统一改成 3000（原话：「它也就 3 秒钟就消失啊」）。
 * 改这一处即全应用生效：所有裸写 `set({ notice })` 都经 `useVault.subscribe` 的
 * `absorb()` 汇入同一个 runtime，用的就是这个常量。
 * ⚠️ 撤销条（删除 / 归类）走各自的 `graceMs`（3000 / 5000ms），与 notice 时长无关，
 *    不受本常量影响 —— 不要误以为改这里会缩短撤销宽限期。
 */
export const NOTICE_SHOW_MS = 3000

/**
 * notice 的到期元数据（存进 store 的 `noticeMeta`）。
 * 视图**不读**它 —— 存在它只为把「到期清理」责任从组件搬到状态层。
 */
export interface NoticeMeta {
  /** 单调递增的来源 id：每次写入都换新值，超时回调按它校验 */
  readonly id: number
  /** 绝对到期时间（Date.now() 毫秒）；到点必须清，不怕定时器漂移 / 时钟回拨 */
  readonly expiresAt: number
}

/** 一条正在展示的 notice（结构化） */
export interface NoticeRecord {
  readonly text: string
  readonly id: number
  readonly expiresAt: number
}

/** 状态层只认这一种结构：null = 当前没有 notice */
export type NoticeState = NoticeRecord | null

/**
 * 下一个来源 id（单调递增；脏值 / 负数兜底成 1）。
 *
 * 为什么每次 `show` 都必须换 id：若 id 不变，A 的旧 timer 与 B 的新 timer 无法区分，
 * 旧 timer 到点就会把刚写入的 B 清掉 —— 正是「提示莫名提前消失」的经典竞态。
 */
export function nextNoticeId(prevId: number): number {
  const base = Number.isFinite(prevId) ? Math.floor(prevId) : 0
  return (base < 0 ? 0 : base) + 1
}

/** 构造一条 notice（绝对到期时间）。durationMs 传 0 = 立刻到期，脏值兜底成默认时长。 */
export function makeNotice(
  text: string,
  id: number,
  now: number,
  durationMs: number = NOTICE_SHOW_MS
): NoticeRecord {
  const t = Number.isFinite(now) ? now : 0
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : NOTICE_SHOW_MS
  return { text, id, expiresAt: t + ms }
}

/** 是否已经到绝对到期时间（渲染兜底 / 超时回调共用同一判据）。 */
export function isNoticeExpired(state: NoticeState, now: number): boolean {
  if (state === null) return false
  if (!Number.isFinite(now)) return false
  return now >= state.expiresAt
}

/**
 * 超时回调的纯判定：**只有「id 对得上 + 确实到期」才允许清**。
 *
 * 这是「旧 timer 不误清新提示」的底层保证。即使某个旧 timer 因为竞态真的触发了，
 * 只要当前 notice 已换成新 id，这里就返回 false，回调直接放弃清理。
 */
export function shouldClearOnTimeout(state: NoticeState, firedId: number, now: number): boolean {
  if (state === null) return false
  if (!Number.isFinite(firedId) || state.id !== firedId) return false
  return isNoticeExpired(state, now)
}

/** 手动关闭的纯判定：按 id 校验，防止一个过期的关闭动作清掉后来的新提示。 */
export function shouldClearOnDismiss(state: NoticeState, id: number): boolean {
  if (state === null) return false
  if (!Number.isFinite(id)) return false
  return state.id === id
}

/** store 的「文案 + 元数据」→ 结构化 state（缺任一段都视作没有 notice）。 */
export function toNoticeState(text: string | null, meta: NoticeMeta | null): NoticeState {
  if (text === null || meta === null) return null
  return { text, id: meta.id, expiresAt: meta.expiresAt }
}

/** 结构化 state → store 的「文案 + 元数据」（状态层写回 store 的唯一出口）。 */
export function splitNotice(state: NoticeState): { text: string | null; meta: NoticeMeta | null } {
  if (state === null) return { text: null, meta: null }
  return { text: state.text, meta: { id: state.id, expiresAt: state.expiresAt } }
}

/** 队列：取出下一条（纯函数，不改原数组）。空队列返回 null。 */
export function shiftQueue(queue: readonly string[]): { text: string; rest: string[] } | null {
  const first = queue[0]
  if (first === undefined) return null
  return { text: first, rest: queue.slice(1) }
}

/**
 * 居中气泡的渲染条件：三类内容任一在即渲染。
 * 抽成纯函数，让「三类内容同时存在」的判据可在无 jsdom 的 node 环境单测。
 */
export function shouldRenderBubble(
  hasNotice: boolean,
  hasDeleteGrace: boolean,
  hasAssignGrace: boolean
): boolean {
  return hasNotice || hasDeleteGrace || hasAssignGrace
}

/**
 * 撤销条优先级：**删除优先**（「文件将消失」的不可逆动作，注意力先给它）。
 * 与旧底部通栏 `deleteGrace ? null : assignGrace` 的口径逐字一致，只是搬到纯函数里。
 */
export function resolveUndoTarget(
  hasDeleteGrace: boolean,
  hasAssignGrace: boolean
): 'delete' | 'assign' | null {
  if (hasDeleteGrace) return 'delete'
  if (hasAssignGrace) return 'assign'
  return null
}

/**
 * 计时器句柄：`unknown`。由注入的 scheduler 自己解释
 * （浏览器 = number / Node = Timeout / 测试 = 任意假 id）。
 * 这样本模块不依赖 `window`，在 `environment: 'node'` 下也能编译 + 单测。
 */
export type NoticeTimerHandle = unknown

/** 状态层运行时的依赖（全部注入，便于确定性单测）。 */
export interface NoticeRuntimeDeps {
  now: () => number
  schedule: (cb: () => void, delayMs: number) => NoticeTimerHandle
  cancel: (handle: NoticeTimerHandle) => void
  /** 状态变化写回 store：把结构化 notice 拆成 `{ notice, noticeMeta }` */
  emit: (state: NoticeState) => void
  durationMs?: number
}

/** 状态层 notice 生命周期运行时（模块作用域单例，不属于任何组件）。 */
export interface NoticeRuntime {
  /** 统一入口：立即显示一条提示（覆盖当前、保留队列） */
  show(text: string): NoticeState
  /** 队列链路：依次展示、互不吞并（每条 durationMs） */
  enqueue(text: string): NoticeState
  /** 手动关闭当前提示（气泡 ✕）；按 id 校验，随后续排队列 */
  dismiss(): NoticeState
  /**
   * 订阅收口：把 store 里被**裸写**的 notice 文案对齐到 runtime。
   * 与 runtime 自己 emit 的文案一致时直接跳过（防回环）。
   */
  absorb(text: string | null): NoticeState
  /** 当前结构化状态 */
  getState(): NoticeState
  /** 触发一次「某 id 的到期回调」——真实 timer 与测试都走这里 */
  fireTimeout(id: number): NoticeState
  /** 当前排队条数（测试断言队列最后一条会被清） */
  pendingCount(): number
  /** 仅供测试 / 复位：清空状态、队列与计时器 */
  reset(): void
}

/**
 * 创建状态层 notice 运行时。
 *
 * 关键不变量：**只要 `state !== null`，就一定有一个待触发的 timer**；每个 timer 都带
 * 自己的 id，触发时再经 `shouldClearOnTimeout` 校验。组件卸载不会调用这里的任何方法，
 * 因此计时器不会像旧 `useEffect` 那样被 cleanup 掉。
 */
export function createNoticeRuntime(deps: NoticeRuntimeDeps): NoticeRuntime {
  const duration = deps.durationMs ?? NOTICE_SHOW_MS
  let state: NoticeState = null
  let lastId = 0
  let queue: readonly string[] = []
  let timer: NoticeTimerHandle | null = null

  const cancelTimer = (): void => {
    if (timer !== null) {
      deps.cancel(timer)
      timer = null
    }
  }

  const publish = (next: NoticeState): void => {
    state = next
    deps.emit(next)
  }

  /** 用绝对到期时间排期（不怕定时器漂移）；回调按 id 校验后再清。 */
  const arm = (record: NoticeRecord): void => {
    cancelTimer()
    const firedId = record.id
    const delay = Math.max(0, record.expiresAt - deps.now())
    timer = deps.schedule(() => {
      timer = null
      api.fireTimeout(firedId)
    }, delay)
  }

  const showInternal = (text: string): NoticeState => {
    lastId = nextNoticeId(lastId)
    const record = makeNotice(text, lastId, deps.now(), duration)
    publish(record)
    arm(record)
    return state
  }

  /** 队列里有下一条且当前空闲 → 展示它。空队列时什么都不做（state 保持 null）。 */
  const drainQueue = (): void => {
    if (state !== null) return
    const next = shiftQueue(queue)
    if (next === null) return
    queue = next.rest
    showInternal(next.text)
  }

  const clearCurrent = (): void => {
    cancelTimer()
    publish(null)
  }

  const api: NoticeRuntime = {
    show(text) {
      return showInternal(text)
    },
    enqueue(text) {
      queue = [...queue, text]
      drainQueue()
      return state
    },
    dismiss() {
      if (state === null) return state
      if (!shouldClearOnDismiss(state, state.id)) return state
      clearCurrent()
      drainQueue()
      return state
    },
    absorb(text) {
      if (text === null) {
        // 外部把 notice 清成 null：只收掉当前这条 + 计时器，**不续排队列**
        // （外部显式清空不该马上又冒出一条；队列留给下一次 enqueue / dismiss 消费）。
        if (state !== null) {
          cancelTimer()
          publish(null)
        }
        return state
      }
      // 与 runtime 自己 emit 的文案一致 → 这次变化来自内部，跳过（防回环）
      if (state !== null && state.text === text) return state
      // 裸 set({ notice }) / useVault.setState({ notice })：当作一次全新的 show，
      // 换新 id + 新 timer；**保留队列**，让批次汇总仍能依次展示、互不吞并。
      return showInternal(text)
    },
    fireTimeout(id) {
      if (!shouldClearOnTimeout(state, id, deps.now())) return state
      clearCurrent()
      drainQueue()
      return state
    },
    getState() {
      return state
    },
    pendingCount() {
      return queue.length
    },
    reset() {
      cancelTimer()
      queue = []
      state = null
      deps.emit(null)
    }
  }

  return api
}
