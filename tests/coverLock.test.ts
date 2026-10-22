/**
 * 按资产封面写入锁单测（DEF-Z8）。
 *
 * 这里只测**锁本身的语义**（串行 / 隔离 / 失败隔离 / 排队提示 / 清理），
 * "竞态真的没了"的端到端复现在 `zhimoCoverStore.test.ts`（需要 store + 假 IPC）。
 */
import { describe, expect, it } from 'vitest'
import {
  COVER_LOCK_NOTICE_MS,
  pendingCoverLocks,
  withAssetCoverLock
} from '../src/renderer/logic/coverLock'

/** 可手动放行的闸门（避免用魔法延时） */
function gate(): { promise: Promise<void>; open: () => void } {
  const box: { open?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    box.open = () => resolve()
  })
  return { promise, open: () => box.open?.() }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('withAssetCoverLock：同资产串行 / 不同资产并行', () => {
  it('同一 id 的 3 次写入严格串行（峰值并发 = 1）', async () => {
    let running = 0
    let peak = 0
    const order: number[] = []
    const job = (n: number) => async () => {
      running += 1
      peak = Math.max(peak, running)
      order.push(n)
      await tick(5)
      running -= 1
      return n
    }

    const results = await Promise.all([
      withAssetCoverLock('asset-a', job(1)),
      withAssetCoverLock('asset-a', job(2)),
      withAssetCoverLock('asset-a', job(3))
    ])

    expect(peak).toBe(1)
    expect(order).toEqual([1, 2, 3])
    expect(results).toEqual([1, 2, 3])
    expect(pendingCoverLocks()).toBe(0)
  })

  it('不同 id 互不阻塞（峰值并发 = 2，证明没有退化成全局串行）', async () => {
    let running = 0
    let peak = 0
    const job = async () => {
      running += 1
      peak = Math.max(peak, running)
      await tick(10)
      running -= 1
    }

    await Promise.all([
      withAssetCoverLock('asset-a', job),
      withAssetCoverLock('asset-b', job)
    ])

    expect(peak).toBe(2)
    expect(pendingCoverLocks()).toBe(0)
  })

  it('前一个失败**不会**让后一个卡死（失败隔离）', async () => {
    const first = withAssetCoverLock('asset-a', async () => {
      throw new Error('写盘炸了')
    })
    await expect(first).rejects.toThrow('写盘炸了')

    // 后续同 id 写入必须照常完成
    await expect(withAssetCoverLock('asset-a', async () => 'ok')).resolves.toBe('ok')
    expect(pendingCoverLocks()).toBe(0)
  })

  it('失败后返回值不被污染：调用方拿到的是自己的结果', async () => {
    const results: Array<string | Error> = []
    await Promise.all([
      withAssetCoverLock('a', async () => 'one').then(
        (v) => results.push(v),
        () => results.push(new Error('unexpected'))
      ),
      withAssetCoverLock('a', async () => {
        throw new Error('boom')
      }).catch(() => results.push('two-failed')),
      withAssetCoverLock('a', async () => 'three').then((v) => results.push(v))
    ])
    expect(results).toEqual(['one', 'two-failed', 'three'])
  })

  it('空 id / 非字符串 key 不会互相串（按 String 归一）', async () => {
    const order: string[] = []
    await Promise.all([
      withAssetCoverLock('', async () => {
        await tick(5)
        order.push('empty')
      }),
      withAssetCoverLock('x', async () => {
        order.push('x')
      })
    ])
    // 不同 key → 可并行；这里只断言都跑完、锁表清空
    expect(order.sort()).toEqual(['empty', 'x'])
    expect(pendingCoverLocks()).toBe(0)
  })
})

describe('withAssetCoverLock：排队提示（只提示一次、只在真的排队时提示）', () => {
  it('排队超过阈值 → 提示一次', async () => {
    const g = gate()
    const first = withAssetCoverLock('asset-a', () => g.promise)
    let notices = 0
    const second = withAssetCoverLock('asset-a', async () => 'done', {
      notifyAfterMs: 10,
      onWaitNotice: () => {
        notices += 1
      }
    })

    await tick(30)
    expect(notices).toBe(1)

    g.open()
    await Promise.all([first, second])
    // 后续不会再补一次
    await tick(20)
    expect(notices).toBe(1)
    expect(pendingCoverLocks()).toBe(0)
  })

  it('锁空闲时即使写盘很慢也**不**提示（不是"排队"）', async () => {
    let notices = 0
    await withAssetCoverLock(
      'asset-a',
      async () => {
        await tick(30)
      },
      {
        notifyAfterMs: 5,
        onWaitNotice: () => {
          notices += 1
        }
      }
    )
    expect(notices).toBe(0)
  })

  it('默认阈值是 3000ms（常量导出，便于文档/测试引用）', () => {
    expect(COVER_LOCK_NOTICE_MS).toBe(3000)
  })
})
