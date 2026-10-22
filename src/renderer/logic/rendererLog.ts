/**
 * 渲染进程日志转发（纯逻辑 + 一个轻量安装函数）
 *
 * 为什么放这里而不是直接写进 `main.tsx`：限流是**必须被测试**的行为
 * （渲染层一个 `ResizeObserver loop` 或三方库的循环报错就能一秒刷几千条，
 * 把刚修的崩溃现场冲掉），纯函数才好在 node 环境里跑单测。
 *
 * 规则（团队约定）：
 *   - 同一条消息 10 秒内只记一次（去重）；
 *   - 全部消息合计 **每 10 秒最多 20 条**（限流）；
 *   - 被压掉的条数不逐条上报（那本身就会刷屏），只在允许下一条时带一个 `suppressed` 计数。
 */

import type { LogLevel, RendererLogPayload } from '../../shared/types'

/** 限流窗口（毫秒） */
export const LOG_THROTTLE_WINDOW_MS = 10_000

/** 每个窗口内允许通过的条数 */
export const LOG_THROTTLE_MAX_PER_WINDOW = 20

export interface LogThrottleOptions {
  windowMs?: number
  maxPerWindow?: number
}

export interface LogThrottle {
  /** 该 key 是否允许通过（now 可注入，便于单测） */
  allow: (key: string, now?: number) => boolean
  /** 被压掉的条数（诊断用，不参与上报） */
  suppressed: () => number
  /** 清空状态（测试 / 重新安装 hook 时用） */
  reset: () => void
}

/**
 * 滑动窗口限流 + 同消息去重。
 *
 * 两个条件任一不满足就拒绝：
 *   ① 距离**同一条消息**上次通过 < windowMs；
 *   ② 窗口内已通过条数 ≥ maxPerWindow。
 */
export function createLogThrottle(options: LogThrottleOptions = {}): LogThrottle {
  const windowMs = options.windowMs ?? LOG_THROTTLE_WINDOW_MS
  const maxPerWindow = options.maxPerWindow ?? LOG_THROTTLE_MAX_PER_WINDOW

  let stamps: number[] = []
  const lastSeen = new Map<string, number>()
  let suppressed = 0

  const prune = (now: number): void => {
    stamps = stamps.filter((t) => now - t < windowMs)
    for (const [k, t] of lastSeen) {
      if (now - t >= windowMs) lastSeen.delete(k)
    }
  }

  return {
    allow(key: string, now?: number): boolean {
      const at = typeof now === 'number' ? now : Date.now()
      prune(at)
      const previous = lastSeen.get(key)
      if (previous !== undefined && at - previous < windowMs) {
        suppressed++
        return false
      }
      if (stamps.length >= maxPerWindow) {
        suppressed++
        return false
      }
      stamps.push(at)
      lastSeen.set(key, at)
      return true
    },
    suppressed(): number {
      return suppressed
    },
    reset(): void {
      stamps = []
      lastSeen.clear()
      suppressed = 0
    }
  }
}

/** 任意抛出物 → 一行消息（绝不抛错） */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 任意抛出物 → stack（没有就是 null） */
export function stackOf(value: unknown): string | null {
  if (value instanceof Error) return value.stack ?? null
  return null
}

/** hook 需要的最小事件源（`window` 满足；单测可传假对象） */
export interface RendererLogHookTarget {
  addEventListener: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

/** `window.onerror` 事件里我们关心的字段（DOM 的 ErrorEvent 结构类型兼容） */
export interface ErrorEventLike {
  message?: unknown
  filename?: unknown
  lineno?: unknown
  colno?: unknown
  error?: unknown
}

/** `unhandledrejection` 事件里我们关心的字段（PromiseRejectionEvent 兼容） */
export interface RejectionEventLike {
  reason?: unknown
}

export interface InstallRendererLogHooksOptions {
  /** 事件源，默认 `window` */
  target?: RendererLogHookTarget
  /** 限流器，默认每个窗口 20 条 / 10 秒 */
  throttle?: LogThrottle
}

/**
 * 挂 `window.error` / `window.unhandledrejection` → 转发到主进程落 `[renderer]` 日志。
 * 返回卸载函数（React StrictMode 双挂载时不会重复上报）。
 */
export function installRendererLogHooks(
  send: (payload: RendererLogPayload) => void,
  options: InstallRendererLogHooksOptions = {}
): () => void {
  const target = options.target ?? (window as unknown as RendererLogHookTarget)
  const throttle = options.throttle ?? createLogThrottle()

  const emit = (level: LogLevel, message: string, context: Record<string, unknown>): void => {
    if (!throttle.allow(`${level}|${message}|${String(context['detail'] ?? '')}`)) return
    const suppressed = throttle.suppressed()
    send({
      level,
      message,
      context: suppressed > 0 ? { ...context, suppressed } : context
    })
  }

  const onError = (event: unknown): void => {
    const ev = (event ?? {}) as ErrorEventLike
    const detail = typeof ev.message === 'string' ? ev.message : messageOf(ev.error)
    emit('error', 'window:error', {
      detail,
      filename: typeof ev.filename === 'string' ? ev.filename : null,
      lineno: typeof ev.lineno === 'number' ? ev.lineno : null,
      colno: typeof ev.colno === 'number' ? ev.colno : null,
      stack: stackOf(ev.error)
    })
  }

  const onRejection = (event: unknown): void => {
    const ev = (event ?? {}) as RejectionEventLike
    const detail = messageOf(ev.reason)
    emit('error', 'window:unhandledrejection', { detail, stack: stackOf(ev.reason) })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  return () => {
    target.removeEventListener?.('error', onError)
    target.removeEventListener?.('unhandledrejection', onRejection)
  }
}
