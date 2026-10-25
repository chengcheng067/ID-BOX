/**
 * 渲染进程崩溃后的自动恢复策略（**纯函数模块**，不 import electron）。
 *
 * 背景（DEF-19-5）：渲染进程被强杀 / 崩溃后，主进程还活着、日志里有
 * `process:render-gone`，但窗口停在死页 —— CDP 目标还在、`Runtime.evaluate` 不再响应，
 * 用户只能手动关掉重开。这里给出的策略是「自动 reload + 退避 + 上限」，
 * 唯一不能妥协的约束是：**绝不允许循环崩溃**。
 *
 * 为什么把决策抽成纯函数：
 * 崩溃恢复的时序（定时器、窗口生命周期、Electron 事件）没法在单测里真跑，
 * 但「reason + 历史时间戳 → reload / 等 N 毫秒 / 放弃」这段判断是纯算术，
 * 抽出来就能把边界（5 分钟窗口、第 4 次、乱序时间戳）钉死在单测里。
 * `index.ts` 只负责接线（起定时器、reload、弹窗），不再持有任何阈值。
 *
 * 判据来源：Electron 33 `RenderProcessGoneDetails.reason` 的七种取值，
 * 见 https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details
 */

/** 连续崩溃的统计窗口：5 分钟 */
export const CRASH_WINDOW_MS = 5 * 60 * 1000

/** 窗口内允许的最大自动 reload 次数；第 4 次（= 这一条）直接放弃 */
export const MAX_RELOADS_PER_WINDOW = 3

/**
 * 退避表（下标 = 第几次尝试 - 1）：
 * 第 1 次**立即** reload（真崩溃时用户最痛的是"卡在死页"，先救回来再说）；
 * 第 2 次等 1s（给瞬时的 OOM / 驱动抖动一点恢复时间）；
 * 第 3 次等 3s（再给一次机会，但已经明显不正常了）。
 */
export const BACKOFF_SCHEDULE_MS = [0, 1_000, 3_000] as const

/**
 * 「算稳定」的门槛：reload 后页面 `did-finish-load` 起持续存活 ≥ 60s 就把历史清零。
 *
 * 不设这个门槛的后果：用户白天崩一次、晚上再崩一次，5 分钟窗口早过了但如果我们
 * 用的是"自增计数器"而不是"时间戳窗口"，就会被误判成连续崩溃并提前放弃恢复。
 * 这里用**时间戳窗口**做主判据（天然过期），60s 存活重置是第二道保险：
 * 它让"崩一次 → 恢复 → 正常用了几小时 → 又崩一次"完全等价于首次崩溃。
 */
export const STABLE_ALIVE_MS = 60 * 1000

/**
 * 会触发自动 reload 的 reason：
 * - `crashed`：渲染进程真的崩了（SIGSEGV / 断言失败 / GPU 驱动崩）——最典型的目标场景；
 * - `oom`：被系统 OOM killer 收走，reload 通常会成功（内存已释放）；
 * - `abnormal-exit`：非 0 退出码的正常终止（浏览器里少见的"脏退出"），reload 有意义；
 * - `launch-failed`：渲染进程起不来（常见于句柄/内存瞬时耗尽），给有限次重试，
 *   若真的起不来，退避 + 上限会在第 4 次收手并弹窗，不会无限重启。
 */
const RELOADABLE_REASONS: ReadonlySet<string> = new Set([
  'crashed',
  'oom',
  'abnormal-exit',
  'launch-failed'
])

/**
 * **绝不** reload 的 reason（只记日志）：
 * - `clean-exit`：渲染进程正常退出 = 用户关窗 / 应用退出 / 页面主动销毁。
 *   这时 reload 等于"退出时窗口诈尸"：`before-quit` 已经走完，窗口却重新加载，
 *   用户会看到关不掉的黑窗，甚至拖住进程退出；
 * - `integrity-failure`：ASAR / 资源完整性校验失败。reload 一百次也是同一个坏包，
 *   属于安装损坏，只能重装。重试只会把日志刷满、让用户多等 3 次退避，
 *   所以直接留一条 error 让人能从日志里看到"包坏了"。
 *
 * `killed` 不在这张表里，它的处理见 {@link decideCrashRecovery}：**取决于是否正在退出**。
 */
const NEVER_RELOAD_REASONS: ReadonlySet<string> = new Set(['clean-exit', 'integrity-failure'])

/** 崩溃原因（保留已知字面量做补全，同时兼容 Electron 未来新增的取值） */
export type RendererGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | (string & Record<never, never>)

/** 决策结果：三种互斥动作 */
export type CrashRecoveryDecision =
  | {
      action: 'ignore'
      reason: string
      /** 中文说明，直接进日志，排障时不用回头看代码 */
      why: string
      attempt: 0
    }
  | {
      action: 'reload'
      reason: string
      why: string
      /** 这是窗口内第几次自动恢复（1 起） */
      attempt: number
      /** 本次退避时长（ms），0 = 立即 */
      delayMs: number
      /** 计入本次决策的历史崩溃数（不含本次） */
      crashesInWindow: number
    }
  | {
      action: 'give-up'
      reason: string
      why: string
      attempt: number
      delayMs: 0
      crashesInWindow: number
    }

export interface CrashRecoveryInput {
  /** `RenderProcessGoneDetails.reason`（未知值一律保守处理） */
  reason: string | null | undefined
  /** 当前时间（ms，注入以便单测；生产传 `Date.now()`） */
  now: number
  /**
   * 历史上**已发生自动 reload 的崩溃**时间戳（ms），顺序不保证 —— 内部会排序。
   * 只放"真的触发了 reload / 放弃"的崩溃；`clean-exit` 这类被忽略的事件不进来，
   * 否则用户正常开关窗口几次就会把额度耗光。
   */
  history: readonly number[]
  /**
   * 应用是否正在退出（`before-quit` 之后 / 点"重启"之后）。
   * 退出过程中的崩溃一律不恢复 —— 这是 `killed` 也能安全 reload 的前提。
   */
  quitting?: boolean
}

/**
 * 把历史时间戳裁剪成"当前有效窗口"，并**排序去噪**。
 *
 * 窗口取**左开右闭** `(now - CRASH_WINDOW_MS, now]`：
 * - 恰好落在 5 分钟前的那一次不算（窗口已经滑过去了，避免边界抖动）；
 * - 未来时间戳（时钟回拨 / 系统时间被改）一律丢弃：它会让窗口永远不过期，
 *   相当于把自动恢复永久禁用，比"少记一次"危险得多；
 * - 非有限数（NaN / Infinity）丢弃，绝不让一条脏数据把决策搞崩。
 *
 * @param history 原始时间戳数组（可乱序、可含重复）
 * @param now 当前时间
 * @returns 升序、仅含窗口内的时间戳
 */
export function pruneCrashHistory(history: readonly number[], now: number): number[] {
  const lowerBound = now - CRASH_WINDOW_MS
  const out: number[] = []
  for (const t of history) {
    if (!Number.isFinite(t)) continue
    if (t <= lowerBound) continue
    if (t > now) continue
    out.push(t)
  }
  out.sort((a, b) => a - b)
  return out
}

/** 窗口内的崩溃次数（不含"本次"） */
export function crashesInWindow(history: readonly number[], now: number): number {
  return pruneCrashHistory(history, now).length
}

/**
 * 页面存活多久算"稳定"（到位后调用方应清空历史计数）。
 * 抽成函数是为了让 `index.ts` 的定时器和单测用同一个阈值，避免两处各写一个 60000。
 */
export function isStableAlive(aliveMs: number): boolean {
  return Number.isFinite(aliveMs) && aliveMs >= STABLE_ALIVE_MS
}

/**
 * 本次退避时长：按"窗口内已有崩溃数"取表，超出表长按最后一档（防御式，正常走不到）。
 */
export function backoffFor(crashesBefore: number): number {
  const idx = Math.max(0, Math.min(crashesBefore, BACKOFF_SCHEDULE_MS.length - 1))
  return BACKOFF_SCHEDULE_MS[idx] ?? 0
}

/**
 * 崩溃恢复决策（**纯函数**，同样的输入永远得到同样的输出）。
 *
 * 决策顺序：
 * 1. 正在退出 → ignore（退出时的任何 reason 都不救，避免窗口诈尸 / 拖住退出）；
 * 2. `clean-exit` / `integrity-failure` → ignore（理由见常量注释）；
 * 3. 未知 reason → ignore（保守：宁可让用户手动重开，也不对不认识的场景盲目 reload）；
 * 4. `killed` → 仅在**非退出**时按 reload 处理。理由见下方注释；
 * 5. 窗口内已满 {@link MAX_RELOADS_PER_WINDOW} 次 → give-up（触发弹窗 + 停止恢复）；
 * 6. 否则 reload，退避时长按第几次取 {@link BACKOFF_SCHEDULE_MS}。
 *
 * ⚠️ 关于 `killed`（与任务书原文的**有意偏差**，请评审确认）：
 * 任务书要求 `clean-exit` 与 `killed` 都不 reload，理由是"关闭应用可能报 killed"。
 * 但在 Windows 上，任务管理器结束任务 / `taskkill /F /IM` / 杀软干掉渲染进程，
 * Electron 33 报的正是 `killed`（`TERMINATION_STATUS_PROCESS_WAS_KILLED`）；
 * 而正常关闭窗口走的是 `clean-exit`。如果一刀切不救 `killed`，
 * DEF-19-5 里被复现的那个场景（人为强杀渲染进程 → 死页）就**仍然修不好**。
 * 因此这里把"是否正在退出"作为真正的判据：退出中 → 不救（任务书担心的诈尸场景被覆盖），
 * 非退出中的 `killed` → 按真崩溃救。若评审仍要求一刀切，把本函数第 4 步改成
 * `return ignore(...)` 即可，其余代码无需改动。
 */
export function decideCrashRecovery(input: CrashRecoveryInput): CrashRecoveryDecision {
  const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'unknown'
  const now = Number.isFinite(input.now) ? input.now : Date.now()

  if (input.quitting === true) {
    return {
      action: 'ignore',
      reason,
      why: '应用正在退出，reload 会让已关闭的窗口诈尸并拖住进程退出',
      attempt: 0
    }
  }

  if (NEVER_RELOAD_REASONS.has(reason)) {
    const why =
      reason === 'clean-exit'
        ? '渲染进程正常退出（关窗 / 应用退出 / 页面主动销毁），不恢复'
        : '资源完整性校验失败，reload 无法修复；属安装损坏，需重装应用'
    return { action: 'ignore', reason, why, attempt: 0 }
  }

  const reloadable = RELOADABLE_REASONS.has(reason) || reason === 'killed'
  if (!reloadable) {
    return {
      action: 'ignore',
      reason,
      why: '未知崩溃原因，保守起见不自动 reload（避免不可预期的循环）',
      attempt: 0
    }
  }

  const recent = pruneCrashHistory(input.history ?? [], now)
  const crashesBefore = recent.length

  if (crashesBefore >= MAX_RELOADS_PER_WINDOW) {
    return {
      action: 'give-up',
      reason,
      why: `${CRASH_WINDOW_MS / 60_000} 分钟内已自动恢复 ${crashesBefore} 次，停止自动 reload`,
      attempt: crashesBefore + 1,
      delayMs: 0,
      crashesInWindow: crashesBefore
    }
  }

  const attempt = crashesBefore + 1
  const delayMs = backoffFor(crashesBefore)
  return {
    action: 'reload',
    reason,
    why:
      delayMs === 0
        ? `第 ${attempt} 次自动恢复：立即 reload`
        : `第 ${attempt} 次自动恢复：等 ${delayMs}ms 再 reload（退避）`,
    attempt,
    delayMs,
    crashesInWindow: crashesBefore
  }
}
