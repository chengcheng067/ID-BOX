/**
 * 插件写盘节流（`docs/39 §6 A1` 已拍板，2026-11-04）：
 *
 * - **debounce quiet 1.5 s**：一连串变更只在"安静 1.5 秒"后落盘一次（纯 trailing debounce，
 *   不在第一次触发时抢跑 —— 拍板口径的字面就是"安静后落盘一次"）；
 * - **max-wait 5 s**：连续变更流下（quiet 窗口被不断续期）最迟 5 s 仍必须落盘一次；
 * - **不设定时兜底**（§6 A1 推荐已被用户接受）：没有"每 N 秒写一次"的定时器，
 *   剩余风险由 PRD D1 的 10 秒新鲜度提示条 + 手动刷新承担。
 *
 * ## 为什么把节流单独做成纯逻辑
 *
 * 节流是这条链上唯一有时间语义的部分，而时间恰恰是最难在集成测试里验证的东西。
 * 把它做成"时钟注入 + 回调注入"的纯逻辑后，测试可以用假时钟逐毫秒推进，钉住三件事：
 *   ① quiet 窗口内多次触发只写一次；
 *   ② 被不断续期的流下，到 max-wait 必须强制落盘；
 *   ③ **没有**任何"周期性兜底"计时器（这是拍板项，不许后人顺手加回来）。
 * 落盘动作本身由 `pluginExport.ts` 注入进来，节流不认识 IO。
 *
 * 端到端延迟核算（§2.3）：quiet 1.5 s + 插件 3 s 轮询 ⇒ 最坏约 6–8 s，仍在 PRD D1 的
 * 10 秒提示线内 —— 这条是"接受非即时"的全部依据，也是不许把 quiet 窗口调大的理由。
 */
import { DEBOUNCE_QUIET_MS, MAX_WAIT_MS } from '../shared/pluginSnapshot'

/** 可注入时钟：测试传假时钟，生产传系统时钟 */
export interface ThrottleClock {
  /** 当前毫秒时间戳 */
  now(): number
  /** 排一个定时器，返回取消函数 */
  schedule(cb: () => void, ms: number): () => void
}

/** 生产时钟（`Date.now` + `setTimeout`，定时器 `unref` 以便不阻止进程退出） */
export const systemClock: ThrottleClock = {
  now: (): number => Date.now(),
  schedule: (cb: () => void, ms: number): (() => void) => {
    const timer = setTimeout(cb, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

/** 一次落盘的执行函数（由 pluginExport 注入；返回值用于测试收尾） */
export type ThrottleFlush = (trigger: string) => Promise<void> | void

/** 当前排期状态（诊断 / 测试用） */
export interface ThrottlePending {
  /** 本轮流的第一次触发时刻（ms） */
  firstAt: number
  /** quiet 窗口预计到期时刻（ms）；已取消排期时为 null */
  quietAt: number | null
  /** max-wait 强制到期时刻（ms）——硬上限，续期不得突破 */
  maxWaitAt: number
}

export interface PluginThrottle {
  /**
   * 记一次触发。
   * @returns `true` = **本轮要立即落盘**（已到 max-wait 硬上限）；
   *          `false` = 已排进 quiet 窗口，等安静后落盘。
   */
  hit(trigger: string): boolean
  /**
   * 面板「手动刷新」：绕过节流，立刻落盘（§6 A1「启动写一次 + 手动刷新」）。
   * PRD §3.5 口径：插件侧的手动刷新**不能**触发主进程写盘（插件无写权限、无 IPC），
   * 这里的"手动刷新"只存在于 ID BOX 面板一侧。
   */
  flushNow(trigger: string): Promise<void>
  /** 当前排期（无排期返回 null） */
  pending(): ThrottlePending | null
  /** 所有排期落定后 resolve（永不 reject，测试收尾用） */
  idle(): Promise<void>
  /** 取消所有排期（测试隔离用） */
  cancel(): void
}

/**
 * 创建节流器。
 *
 * 两条不变量（都不许退化）：
 * 1. quiet 窗口**每次触发都续期**（debounce 的定义就是"安静之后"），但续期不能
 *    无限拖延——`maxWaitAt` 是硬上限，到点必须落盘一次；
 * 2. 落盘回调抛错**不许卡死**后续排期（与 `createSettingsWriteQueue` 同一纪律：
 *    一次 IO 失败不能把整条链永久挂住）。
 */
export function createPluginThrottle(
  flush: ThrottleFlush,
  clock: ThrottleClock = systemClock,
  quietMs: number = DEBOUNCE_QUIET_MS,
  maxWaitMs: number = MAX_WAIT_MS
): PluginThrottle {
  // ⚠️ 「本轮流是否已开始」必须用 `null` 哨兵，不能用 `0`：假时钟从 0 起算时
  // `firstAt === 0` 会和「没有流」混为一谈，max-wait 硬上限就会被每次触发重新起算、
  // 永远打不到 5 s（持续小流下等于 max-wait 失效）。
  let firstAt: number | null = null
  let quietAt: number | null = null
  let maxWaitAt = 0
  let cancelQuiet: (() => void) | null = null
  let lastFlush: Promise<void> = Promise.resolve()
  /**
   * 本轮流的**真实触发名**（quiet 窗口落盘时要用它）。
   *
   * ⚠️ 这里绝不能图省事写死 `'quiet'`：`writePluginSnapshot` 的触发白名单是 deny by default，
   * `'quiet'` 不在 `PLUGIN_TRIGGER_SET` 里 → 每次 quiet 落盘都会被拒（102），节流等于白做。
   * 所以 quiet 窗口必须把"当初是哪一个触发点"带过去，落盘日志里也才能看出到底是哪件事触发的。
   */
  let pendingTrigger = ''

  const doFlush = (trigger: string): Promise<void> => {
    // 回调里抛错也要吞进链：`.catch` 保证 idle() 不会 reject、后续排期照常
    const next = Promise.resolve().then(() => flush(trigger)).catch(() => undefined)
    lastFlush = next
    return next
  }

  /** 续期 quiet 窗口（每次触发都重排，这正是 debounce 的定义） */
  const armQuiet = (trigger: string): void => {
    if (cancelQuiet) cancelQuiet()
    pendingTrigger = trigger
    quietAt = clock.now() + quietMs
    cancelQuiet = clock.schedule(() => {
      quietAt = null
      cancelQuiet = null
      const triggerOfStream = pendingTrigger
      // 落盘后本轮流结束：下一批触发重新计流（firstAt 复位为 null，maxWaitAt 重新起算）
      firstAt = null
      maxWaitAt = 0
      pendingTrigger = ''
      void doFlush(triggerOfStream)
    }, quietMs)
  }

  return {
    hit(trigger: string): boolean {
      const now = clock.now()
      if (firstAt === null) {
        firstAt = now
        maxWaitAt = now + maxWaitMs
      }
      // 已到 max-wait 硬上限：续期不能突破它，到点必须落盘一次
      if (now >= maxWaitAt) {
        if (cancelQuiet) cancelQuiet()
        quietAt = null
        cancelQuiet = null
        firstAt = null
        maxWaitAt = 0
        pendingTrigger = ''
        void doFlush(trigger)
        return true
      }
      armQuiet(trigger)
      return false
    },

    flushNow(trigger: string): Promise<void> {
      if (cancelQuiet) cancelQuiet()
      quietAt = null
      cancelQuiet = null
      firstAt = null
      maxWaitAt = 0
      pendingTrigger = ''
      return doFlush(trigger)
    },

    pending(): ThrottlePending | null {
      if (firstAt === null) return null
      return { firstAt, quietAt, maxWaitAt }
    },

    idle(): Promise<void> {
      return lastFlush.then(
        () => undefined,
        () => undefined
      )
    },

    cancel(): void {
      if (cancelQuiet) cancelQuiet()
      cancelQuiet = null
      quietAt = null
      firstAt = null
      maxWaitAt = 0
    }
  }
}
