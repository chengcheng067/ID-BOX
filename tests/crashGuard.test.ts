/**
 * 渲染进程崩溃自动恢复策略（DEF-19-5）单测。
 *
 * 只测 `crashGuard.ts` 这个**纯函数**模块：把所有"什么时候救、等多久、什么时候放弃"
 * 的阈值钉死在这里；Electron 事件接线（定时器 / reload / 弹窗）由主进程负责，
 * 不在 node 测试环境里跑。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKOFF_SCHEDULE_MS,
  CRASH_WINDOW_MS,
  MAX_RELOADS_PER_WINDOW,
  STABLE_ALIVE_MS,
  backoffFor,
  crashesInWindow,
  decideCrashRecovery,
  isStableAlive,
  pruneCrashHistory,
  type CrashRecoveryDecision
} from '../src/main/crashGuard'

/** 固定"现在"，避免单测依赖真实时钟 */
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)

/** 把决策窄化成 reload，断言时直接拿字段（失败信息更清楚） */
function expectReload(d: CrashRecoveryDecision): Extract<CrashRecoveryDecision, { action: 'reload' }> {
  expect(d.action).toBe('reload')
  if (d.action !== 'reload') throw new Error(`expected reload, got ${d.action}`)
  return d
}

describe('crashGuard 常量', () => {
  it('5 分钟窗口 / 窗口内最多 3 次 / 稳定期 60s / 退避表 0-1s-3s', () => {
    expect(CRASH_WINDOW_MS).toBe(300_000)
    expect(MAX_RELOADS_PER_WINDOW).toBe(3)
    expect(STABLE_ALIVE_MS).toBe(60_000)
    expect([...BACKOFF_SCHEDULE_MS]).toEqual([0, 1_000, 3_000])
  })
})

describe('pruneCrashHistory', () => {
  it('窗口是左开右闭：恰好 5 分钟前的那次不算', () => {
    const boundary = NOW - CRASH_WINDOW_MS
    expect(pruneCrashHistory([boundary], NOW)).toEqual([])
    expect(pruneCrashHistory([boundary + 1], NOW)).toEqual([boundary + 1])
  })

  it('乱序输入 → 升序输出', () => {
    const a = NOW - 30_000
    const b = NOW - 90_000
    const c = NOW - 1_000
    expect(pruneCrashHistory([a, b, c], NOW)).toEqual([b, a, c])
  })

  it('丢弃未来时间戳（时钟回拨会把窗口永久占满）、NaN、Infinity', () => {
    const recent = NOW - 1_000
    expect(
      pruneCrashHistory([recent, NOW + 60_000, Number.NaN, Number.POSITIVE_INFINITY], NOW)
    ).toEqual([recent])
  })

  it('不改入参（纯函数）', () => {
    const input = [NOW - 2_000, NOW - 1_000]
    const copy = [...input]
    pruneCrashHistory(input, NOW)
    expect(input).toEqual(copy)
  })

  it('crashesInWindow = 窗口内条数', () => {
    expect(crashesInWindow([NOW - 1_000, NOW - CRASH_WINDOW_MS], NOW)).toBe(1)
  })
})

describe('isStableAlive / backoffFor', () => {
  it('存活满 60s 才算稳定（59_999 不算）', () => {
    expect(isStableAlive(STABLE_ALIVE_MS - 1)).toBe(false)
    expect(isStableAlive(STABLE_ALIVE_MS)).toBe(true)
    expect(isStableAlive(Number.NaN)).toBe(false)
  })

  it('退避：第 1 次立即、第 2 次 1s、第 3 次 3s，越界不崩', () => {
    expect(backoffFor(0)).toBe(0)
    expect(backoffFor(1)).toBe(1_000)
    expect(backoffFor(2)).toBe(3_000)
    // 正常流程走不到（>=3 就放弃了），但函数本身必须防御
    expect(backoffFor(9)).toBe(3_000)
    expect(backoffFor(-1)).toBe(0)
  })
})

describe('decideCrashRecovery：不恢复的 reason', () => {
  it('clean-exit 不 reload（关窗/退出时不能让窗口诈尸）', () => {
    const d = decideCrashRecovery({ reason: 'clean-exit', now: NOW, history: [] })
    expect(d.action).toBe('ignore')
    expect(d.attempt).toBe(0)
  })

  it('clean-exit 即使历史已满也不 reload', () => {
    const history = [NOW - 1_000, NOW - 2_000, NOW - 3_000]
    expect(decideCrashRecovery({ reason: 'clean-exit', now: NOW, history }).action).toBe('ignore')
  })

  it('integrity-failure 不 reload（坏包重试无意义）', () => {
    const d = decideCrashRecovery({ reason: 'integrity-failure', now: NOW, history: [] })
    expect(d.action).toBe('ignore')
  })

  it('未知 reason 保守不 reload', () => {
    expect(decideCrashRecovery({ reason: 'something-new', now: NOW, history: [] }).action).toBe(
      'ignore'
    )
    expect(decideCrashRecovery({ reason: null, now: NOW, history: [] }).action).toBe('ignore')
    expect(decideCrashRecovery({ reason: '', now: NOW, history: [] }).action).toBe('ignore')
  })

  it('正在退出时任何 reason 都不 reload（含 crashed / killed）', () => {
    expect(
      decideCrashRecovery({ reason: 'crashed', now: NOW, history: [], quitting: true }).action
    ).toBe('ignore')
    expect(
      decideCrashRecovery({ reason: 'killed', now: NOW, history: [], quitting: true }).action
    ).toBe('ignore')
  })
})

describe('decideCrashRecovery：首次与退避', () => {
  it('crashed 首次 → 立即 reload，attempt=1', () => {
    const d = expectReload(decideCrashRecovery({ reason: 'crashed', now: NOW, history: [] }))
    expect(d.attempt).toBe(1)
    expect(d.delayMs).toBe(0)
    expect(d.crashesInWindow).toBe(0)
    expect(d.reason).toBe('crashed')
  })

  it('oom / abnormal-exit / launch-failed 同样可恢复', () => {
    for (const reason of ['oom', 'abnormal-exit', 'launch-failed']) {
      const d = expectReload(decideCrashRecovery({ reason, now: NOW, history: [] }))
      expect(d.attempt).toBe(1)
      expect(d.reason).toBe(reason)
    }
  })

  it('killed 在非退出时也恢复（任务管理器强杀 = 报告里复现的场景）', () => {
    const d = expectReload(
      decideCrashRecovery({ reason: 'killed', now: NOW, history: [], quitting: false })
    )
    expect(d.delayMs).toBe(0)
  })

  it('窗口内第 2 次 → 等 1s；第 3 次 → 等 3s', () => {
    const d2 = expectReload(
      decideCrashRecovery({ reason: 'crashed', now: NOW, history: [NOW - 10_000] })
    )
    expect(d2.attempt).toBe(2)
    expect(d2.delayMs).toBe(1_000)

    const d3 = expectReload(
      decideCrashRecovery({
        reason: 'crashed',
        now: NOW,
        history: [NOW - 20_000, NOW - 10_000]
      })
    )
    expect(d3.attempt).toBe(3)
    expect(d3.delayMs).toBe(3_000)
  })
})

describe('decideCrashRecovery：上限与放弃', () => {
  it('5 分钟内第 4 次崩溃 → 停止自动恢复', () => {
    const history = [NOW - 30_000, NOW - 20_000, NOW - 10_000]
    const d = decideCrashRecovery({ reason: 'crashed', now: NOW, history })
    expect(d.action).toBe('give-up')
    if (d.action !== 'give-up') throw new Error('expected give-up')
    expect(d.attempt).toBe(4)
    expect(d.crashesInWindow).toBe(3)
    expect(d.why).toContain('停止自动 reload')
  })

  it('第 5 次、第 6 次继续 give-up（不会因为放弃后又开始 reload）', () => {
    const history = [NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000]
    expect(decideCrashRecovery({ reason: 'oom', now: NOW, history }).action).toBe('give-up')
    expect(decideCrashRecovery({ reason: 'oom', now: NOW + 1_000, history }).action).toBe('give-up')
  })
})

describe('decideCrashRecovery：时间窗口 / 计数重置 / 乱序', () => {
  it('崩溃发生在 5 分钟之前 → 不算连续，恢复为第 1 次', () => {
    const history = [NOW - CRASH_WINDOW_MS - 1, NOW - CRASH_WINDOW_MS - 60_000]
    const d = expectReload(decideCrashRecovery({ reason: 'crashed', now: NOW, history }))
    expect(d.attempt).toBe(1)
    expect(d.delayMs).toBe(0)
  })

  it('白天崩一次、晚上再崩一次：不误判为连续崩溃', () => {
    const morning = NOW - 8 * 60 * 60 * 1000
    const d = expectReload(
      decideCrashRecovery({ reason: 'crashed', now: NOW, history: [morning] })
    )
    expect(d.attempt).toBe(1)
  })

  it('稳定期（60s）之后可视为已重置：把历史清空后决策等价于首次', () => {
    // 调用方在 did-finish-load 后存活满 60s 会清空 crashHistory；
    // 这里验证"清空"这一动作带来的决策结果（阈值本身见 isStableAlive）
    const cleared: number[] = []
    const d = expectReload(decideCrashRecovery({ reason: 'crashed', now: NOW, history: cleared }))
    expect(d.attempt).toBe(1)
  })

  it('时间戳数组乱序 → 决策与升序输入完全一致', () => {
    const sorted = [NOW - 30_000, NOW - 20_000, NOW - 10_000]
    const shuffled = [NOW - 10_000, NOW - 30_000, NOW - 20_000]
    const a = decideCrashRecovery({ reason: 'crashed', now: NOW, history: sorted })
    const b = decideCrashRecovery({ reason: 'crashed', now: NOW, history: shuffled })
    expect(b).toEqual(a)
    expect(a.action).toBe('give-up')

    const sorted2 = [NOW - 20_000, NOW - 10_000]
    const shuffled2 = [NOW - 10_000, NOW - 20_000]
    expect(
      decideCrashRecovery({ reason: 'crashed', now: NOW, history: shuffled2 })
    ).toEqual(decideCrashRecovery({ reason: 'crashed', now: NOW, history: sorted2 }))
  })

  it('混合新旧时间戳：只数窗口内的', () => {
    const history = [NOW - CRASH_WINDOW_MS - 5_000, NOW - 20_000, NOW - 1_000]
    const d = expectReload(decideCrashRecovery({ reason: 'crashed', now: NOW, history }))
    expect(d.attempt).toBe(3)
    expect(d.delayMs).toBe(3_000)
  })

  it('now 非法时回落到真实时钟（绝不抛异常）', () => {
    const d = decideCrashRecovery({ reason: 'crashed', now: Number.NaN, history: [] })
    expect(['reload', 'give-up', 'ignore']).toContain(d.action)
  })
})
