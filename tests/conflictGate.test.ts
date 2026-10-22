import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createConflictGate,
  CONFLICT_AGGREGATE_MAX_MS,
  type ConflictGate,
  type ConflictQuery
} from '../src/main/conflictGate'
import type { ImportConflictAnswer, ImportConflictAsk } from '../src/shared/types'

/**
 * docs/27 T-03：询问门（聚合 / 复用 / 锁定）。
 *
 * 五条验收判据（§6.1）逐条对应下面的 describe：
 * ① 800ms 窗口内 3 条冲突合并成 **1 次** `sendAsk`；
 * ② 答复后同键复用、不同键用 `batchDefault` 且**不再问**；
 * ③ `sendAsk` 返回 `null`（超时/窗口没了）→ 全 `skip` 并**锁定**批次策略；
 * ④ 未知 `requestId` 幂等丢弃；
 * ⑤ `cancelAll()` 兑现所有挂起 Promise，**不得残留 pending**。
 */

function query(over: Partial<ConflictQuery> = {}, existingId = 'lib-1'): ConflictQuery {
  return {
    item: 'C:/dl/椅子.zip',
    itemName: '椅子.zip',
    assetName: '椅子',
    kind: 'model',
    size: 1000,
    reason: 'same-name',
    existing: {
      id: existingId,
      name: '椅子',
      kind: 'model',
      relFolder: '模型/家具/椅子/椅子',
      size: 1000,
      importedAt: 1_700_000_000_000,
      otherCopies: 0,
      sizeMismatch: false
    },
    ...over
  }
}

/** 时钟与假定时器一起推进（判定窗口的 deadline 用注入的 `now()` 算，二者必须同步） */
function makeClock() {
  let clock = 0
  return {
    now: () => clock,
    tick(ms: number): void {
      clock += ms
      vi.advanceTimersByTime(ms)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('T-03 ① 聚合窗口：窗口内多条冲突只发一次 sendAsk', () => {
  it('100ms/200ms 内到达 3 条 → 1 次 sendAsk，items 按到达顺序编号 1..3', async () => {
    const { now, tick } = makeClock()
    const asks: ImportConflictAsk[] = []
    const answers: Array<(a: ImportConflictAnswer | null) => void> = []
    const gate = createConflictGate({
      sendAsk: (ask) => {
        asks.push(ask)
        return new Promise<ImportConflictAnswer | null>((resolve) => answers.push(resolve))
      },
      now,
      newRequestId: () => 'req-1'
    })

    const p1 = gate.ask(query({}, 'lib-1'))
    tick(100)
    const p2 = gate.ask(query({}, 'lib-2'))
    tick(100)
    const p3 = gate.ask(query({}, 'lib-3'))

    // 窗口没到 → 一次都还没发
    expect(asks).toHaveLength(0)
    expect(gate.pendingCount()).toBe(3)

    // 截止时刻 = 首个冲突起 800 + 400×2 = 1600ms
    tick(1600)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.requestId).toBe('req-1')
    expect(asks[0]!.items.map((it) => it.seq)).toEqual([1, 2, 3])
    // 默认档固定「跳过」（弹窗预选 + 主进程超时兜底都用它）
    expect(asks[0]!.batchDefault).toBe('skip')

    answers[0]!({ requestId: 'req-1', batchDefault: 'overwrite', overrides: [{ seq: 2, resolution: 'skip' }] })
    await expect(p1).resolves.toBe('overwrite')
    await expect(p2).resolves.toBe('skip') // 逐条覆盖优先于批次默认档
    await expect(p3).resolves.toBe('overwrite')

    expect(gate.pendingCount()).toBe(0)
    expect(gate.batchDefault()).toBe('overwrite')
  })

  it('窗口自首个冲突起最多 2500ms（连来 10 条也不会无限延长）', async () => {
    const { now, tick } = makeClock()
    const asks: ImportConflictAsk[] = []
    const gate = createConflictGate({
      sendAsk: (ask) => {
        asks.push(ask)
        return new Promise<ImportConflictAnswer | null>(() => {})
      },
      now,
      newRequestId: () => 'req-1'
    })
    for (let i = 0; i < 10; i += 1) {
      void gate.ask(query({}, `lib-${i}`))
      tick(10)
    }
    tick(CONFLICT_AGGREGATE_MAX_MS)
    expect(asks).toHaveLength(1)
    expect(asks[0]!.items).toHaveLength(10)
    expect(gate.pendingCount()).toBe(10)
    gate.cancelAll()
    expect(gate.pendingCount()).toBe(0)
  })

  it('remainingItems 取聚合批里的最大值（弹窗提示「其余按上方处理」）', async () => {
    const { now, tick } = makeClock()
    const asks: ImportConflictAsk[] = []
    const gate = createConflictGate({
      sendAsk: (ask) => {
        asks.push(ask)
        return null
      },
      now,
      newRequestId: () => 'req-1'
    })
    void gate.ask(query({ remainingItems: 7 }, 'lib-1'))
    void gate.ask(query({ remainingItems: 3 }, 'lib-2'))
    tick(800)
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    expect(asks[0]!.remainingItems).toBe(7)
  })
})

describe('T-03 ② 答复后：同键复用 + 不同键套默认档，且不再问', () => {
  it('同 existing.id 复用上次决定；陌生键用 batchDefault；sendAsk 只被调用一次', async () => {
    const { now, tick } = makeClock()
    const asks: ImportConflictAsk[] = []
    const gate = createConflictGate({
      sendAsk: (ask) => {
        asks.push(ask)
        return { requestId: ask.requestId, batchDefault: 'overwrite' }
      },
      now,
      newRequestId: () => 'req-1'
    })

    const first = gate.ask(query({}, 'lib-1'))
    tick(800)
    await expect(first).resolves.toBe('overwrite')
    expect(asks).toHaveLength(1)

    // 同键（同一条库内记录）→ 复用 overwrite；陌生键 → batchDefault=overwrite
    await expect(gate.ask(query({}, 'lib-1'))).resolves.toBe('overwrite')
    await expect(gate.ask(query({}, 'lib-9'))).resolves.toBe('overwrite')
    // 一次导入只问一次：没有任何新的 sendAsk
    expect(asks).toHaveLength(1)
    expect(gate.pendingCount()).toBe(0)
  })

  it('同键复用保留逐条覆盖档（逐条 skip 过的那条，下次同键仍 skip）', async () => {
    const { now, tick } = makeClock()
    const gate = createConflictGate({
      sendAsk: (ask) => ({
        requestId: ask.requestId,
        batchDefault: 'keep-both',
        overrides: [{ seq: 1, resolution: 'skip' }]
      }),
      now,
      newRequestId: () => 'req-1'
    })

    const p = gate.ask(query({}, 'lib-1'))
    tick(800)
    await expect(p).resolves.toBe('skip')
    await expect(gate.ask(query({}, 'lib-1'))).resolves.toBe('skip')
    await expect(gate.ask(query({}, 'lib-2'))).resolves.toBe('keep-both')
  })

  it('等答复期间到达的冲突也套同一答复，不会触发第二次弹窗', async () => {
    const { now, tick } = makeClock()
    const asks: ImportConflictAsk[] = []
    let release: ((a: ImportConflictAnswer | null) => void) | null = null
    const gate = createConflictGate({
      sendAsk: (ask) => {
        asks.push(ask)
        return new Promise<ImportConflictAnswer | null>((resolve) => {
          release = resolve
        })
      },
      now,
      newRequestId: () => `req-${asks.length}`
    })

    const p1 = gate.ask(query({}, 'lib-1'))
    tick(800)
    expect(asks).toHaveLength(1)

    // 弹窗已经发出，用户还没点 —— 此时又来一条冲突
    const p2 = gate.ask(query({}, 'lib-2'))
    tick(4000)
    expect(asks).toHaveLength(1) // 关键：不会再发第二次

    release!({ requestId: 'req-1', batchDefault: 'keep-both' })
    await expect(p1).resolves.toBe('keep-both')
    await expect(p2).resolves.toBe('keep-both')
    expect(asks).toHaveLength(1)
  })
})

describe('T-03 ③ sendAsk 返回 null（超时/窗口没了）→ 全 skip + 锁定', () => {
  it('null → 挂起的全部 skip，之后的新冲突直接 skip 且不再发问', async () => {
    const { now, tick } = makeClock()
    let calls = 0
    const gate = createConflictGate({
      sendAsk: () => {
        calls += 1
        return null
      },
      now,
      newRequestId: () => 'req-1'
    })

    const p1 = gate.ask(query({}, 'lib-1'))
    const p2 = gate.ask(query({}, 'lib-2'))
    // 两条冲突 → 窗口 = 800 + 400 = 1200ms
    tick(1200)
    await expect(p1).resolves.toBe('skip')
    await expect(p2).resolves.toBe('skip')

    expect(gate.locked()).toBe(true)
    expect(calls).toBe(1)

    // 锁定后：直接 skip，绝不再发问（D07：不再重复打扰）
    await expect(gate.ask(query({}, 'lib-3'))).resolves.toBe('skip')
    expect(calls).toBe(1)
    expect(gate.pendingCount()).toBe(0)
  })

  it('sendAsk 抛错 / reject 也按超时处理（异常不许穿过整批导入）', async () => {
    const { now, tick } = makeClock()
    const throwing = createConflictGate({ sendAsk: () => { throw new Error('boom') }, now })
    const p1 = throwing.ask(query())
    tick(800)
    await expect(p1).resolves.toBe('skip')
    expect(throwing.locked()).toBe(true)

    const rejecting = createConflictGate({ sendAsk: async () => Promise.reject(new Error('nope')), now })
    const p2 = rejecting.ask(query())
    tick(800)
    await expect(p2).resolves.toBe('skip')
    expect(rejecting.locked()).toBe(true)
  })

  it('用户按 Esc（cancelled:true）→ 等同超时：全 skip 并锁定', async () => {
    const { now, tick } = makeClock()
    let calls = 0
    const gate = createConflictGate({
      sendAsk: (ask) => {
        calls += 1
        return { requestId: ask.requestId, batchDefault: 'overwrite', cancelled: true }
      },
      now,
      newRequestId: () => 'req-1'
    })
    const p = gate.ask(query())
    tick(800)
    // 即使答复里带 overwrite，cancelled 也必须压过它
    await expect(p).resolves.toBe('skip')
    expect(gate.locked()).toBe(true)
    await expect(gate.ask(query())).resolves.toBe('skip')
    expect(calls).toBe(1)
  })
})

describe('T-03 ④ 未知 requestId 幂等丢弃', () => {
  it('过期 / 陌生 requestId 不影响挂起中的询问', async () => {
    const { now, tick } = makeClock()
    let release: ((a: ImportConflictAnswer | null) => void) | null = null
    const gate = createConflictGate({
      sendAsk: () => new Promise<ImportConflictAnswer | null>((resolve) => { release = resolve }),
      now,
      newRequestId: () => 'req-real'
    })

    const p = gate.ask(query())
    tick(800)
    expect(gate.pendingCount()).toBe(1)

    // 超时后才到的旧答复 / 别的批次的答复 → 静默丢弃
    expect(() => gate.answer({ requestId: 'req-stale', batchDefault: 'overwrite' })).not.toThrow()
    expect(() => gate.answer({ requestId: '', batchDefault: 'overwrite' })).not.toThrow()
    expect(gate.pendingCount()).toBe(1)
    expect(gate.batchDefault()).toBeNull()

    release!({ requestId: 'req-real', batchDefault: 'overwrite' })
    await expect(p).resolves.toBe('overwrite')
  })

  it('answer() 是有效入口（进程内直投），先到先得；重复答复不再改变结果', async () => {
    const { now, tick } = makeClock()
    const gate = createConflictGate({
      // 永不答复：答案只从 answer() 进来
      sendAsk: () => new Promise<ImportConflictAnswer | null>(() => {}),
      now,
      newRequestId: () => 'req-1'
    })
    const p = gate.ask(query())
    tick(800)

    gate.answer({ requestId: 'req-1', batchDefault: 'keep-both' })
    await expect(p).resolves.toBe('keep-both')
    // 同一 requestId 再来一次 → 幂等丢弃（false 的答复不会翻案）
    gate.answer({ requestId: 'req-1', batchDefault: 'skip' })
    await expect(gate.ask(query({}, 'lib-2'))).resolves.toBe('keep-both')
  })
})

describe('T-03 ⑤ cancelAll 兑现所有挂起 Promise，不留 pending', () => {
  it('缓冲中 + 等答复中两类挂起都被兑现为 skip', async () => {
    const { now, tick } = makeClock()
    const gate = createConflictGate({
      // 永不答复：模拟窗口挂着没人点
      sendAsk: () => new Promise<ImportConflictAnswer | null>(() => {}),
      now,
      newRequestId: () => 'req-1'
    })

    const inflight = gate.ask(query({}, 'lib-1'))
    tick(800) // 已发出询问，正在等答复
    const buffered = gate.ask(query({}, 'lib-2')) // 等答复期间新到达 → 进缓冲
    expect(gate.pendingCount()).toBe(2)

    gate.cancelAll()
    expect(gate.pendingCount()).toBe(0)
    await expect(inflight).resolves.toBe('skip')
    await expect(buffered).resolves.toBe('skip')
    expect(gate.locked()).toBe(true)
  })

  it('cancelAll 之后再 ask 也不留 pending（直接 skip）', async () => {
    const { now } = makeClock()
    const gate: ConflictGate = createConflictGate({ sendAsk: () => null, now })
    gate.cancelAll()
    await expect(gate.ask(query())).resolves.toBe('skip')
    expect(gate.pendingCount()).toBe(0)
  })

  it('cancelAll 不会让上一次答复翻案（先答复再清场）', async () => {
    const { now, tick } = makeClock()
    const gate = createConflictGate({
      sendAsk: (ask) => ({ requestId: ask.requestId, batchDefault: 'overwrite' }),
      now,
      newRequestId: () => 'req-1'
    })
    const p = gate.ask(query())
    tick(800)
    await expect(p).resolves.toBe('overwrite')
    gate.cancelAll()
    expect(gate.pendingCount()).toBe(0)
    expect(gate.locked()).toBe(true)
  })
})
