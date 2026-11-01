/**
 * 导入批次取消（2026-10）——数据层单测。
 *
 * ## 为什么这批测试值得存在
 *
 * 取消的**唯一难点不是"停下"**，而是"停在哪"。看错一行就会写成「收到取消就 abort
 * 正在复制的那条」，那会在库里留下 `mkdir` 占位目录 + 拷了一半的文件 —— 半成品
 * 目录比"用户多点一次导入"糟糕得多，而且肉眼看不出来（目录存在、里面文件不全）。
 *
 * 所以本文件把三条不变量钉死：
 * ① 取消只在**领取新条目之前**生效（`mapWithConcurrency` 的检查点早于 `cursor++`）；
 * ② 已经开工的条目**一定跑完**（`finished` 与 `started` 必须一一对应）；
 * ③ 一个条目只会得到**一个**终态 —— 被取消的只能是"一次都没进 worker"的那批，
 *    「跳过 / 失败」不许被误报成 `cancelled`。
 *
 * 后半段是接线 guard（读源码断言）：`cancel` 通道横跨 main / preload / shared 三个
 * 文件，任何一处漏改都不会编译报错（send 通道没有类型回路），只能靠文本断言兜住。
 *
 * `environment: 'node'`（见 vitest.config.ts）：全部是纯函数 + 源码文本断言，不需要 jsdom。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  DEFAULT_CONCURRENCY,
  importPaths,
  mapWithConcurrency,
  type ImportDeps
} from '../src/main/importer'
import type { ImportEvent } from '../src/shared/types'
import {
  autoDismissDelayMs,
  importItemDetail,
  isTerminalStatus,
  statusClass
} from '../src/renderer/logic/importText'

/** 读仓库内源码（guards 用）。`new URL(rel, import.meta.url)` 与既有 wiring 测试同款。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

/** 让出一轮事件循环：把"两个 worker 同时活着"这件事变成可观察的 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// ══════════════════════════════════════════════════════════════════
// A. `mapWithConcurrency` 的取消语义（纯函数，直接测）
// ══════════════════════════════════════════════════════════════════

describe('mapWithConcurrency：取消只停"还没开始的"', () => {
  it('① 第 5 个开始处理后才取消 → 已开始的全部做完，未开始的一个都没碰', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`)
    const started: number[] = []
    const finished: number[] = []

    await mapWithConcurrency(
      items,
      2,
      async (_item, index) => {
        started.push(index)
        // 真正的 await：让两个 worker 交错，才能验证"在途的那条没被打断"
        await tick()
        finished.push(index)
      },
      undefined,
      // 领活前检查：已经有 5 条开工了就不再领新的
      () => started.length >= 5
    )

    // 已开始的一定跑完（不能有"开工了但没收到 finish"的条目）
    expect(finished.slice().sort((a, b) => a - b)).toEqual(started.slice().sort((a, b) => a - b))
    // 开工数：正好 5（并发 2 的余量最多再多 1，这里给 ≤7 的宽松上界）
    expect(started.length).toBeGreaterThanOrEqual(5)
    expect(started.length).toBeLessThanOrEqual(7)
    expect(started.length).toBeLessThan(20)
    // 开工的必须是最前面那几个（worker 按 cursor 顺序领活）
    expect(started.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: started.length }, (_, i) => i)
    )
    // 未开工的一条都没被碰过
    expect(started).not.toContain(19)
  })

  it('② 一上来就取消 → 0 个被处理，Promise 正常 resolve', async () => {
    const started: number[] = []
    await expect(
      mapWithConcurrency(
        Array.from({ length: 20 }, (_, i) => i),
        3,
        async (_item, index) => {
          started.push(index)
        },
        undefined,
        () => true
      )
    ).resolves.toBeUndefined()
    expect(started).toHaveLength(0)
  })

  it('③ 不传 shouldStop（4 参调用）→ 全部 20 个照常处理（回归）', async () => {
    const seen: number[] = []
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (item) => {
      await tick()
      seen.push(item)
    })
    expect(seen).toHaveLength(20)
  })

  it('④ 执行中才变 true（头一次 false、之后 true）→ 至少做 1 个，总数远小于 20', async () => {
    let calls = 0
    const started: number[] = []
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async (_item, index) => {
        await tick()
        started.push(index)
      },
      undefined,
      () => {
        calls += 1
        // 第一次（首个 worker 的第一次领活）放行，之后全停
        return calls > 1
      }
    )
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(started.length).toBeLessThan(20)
  })

  it('⑤ onError 与 shouldStop 同时传：抛错的条目仍走 onError，且没让整批提前结束', async () => {
    const errors: Array<{ index: number; message: string }> = []
    const started: number[] = []
    await mapWithConcurrency(
      [0, 1, 2, 3],
      1,
      async (_item, index) => {
        started.push(index)
        if (index === 0) throw new Error('boom-0')
        if (index === 2) throw new Error('boom-2')
        await tick()
      },
      (err, _item, index) => {
        errors.push({ index, message: err instanceof Error ? err.message : String(err) })
      },
      // 永不取消：验证"传了 shouldStop 也不会把 onError 那条路吃掉"
      () => false
    )
    expect(started).toEqual([0, 1, 2, 3])
    expect(errors).toEqual([
      { index: 0, message: 'boom-0' },
      { index: 2, message: 'boom-2' }
    ])
  })

  it('⑥ importPaths：开跑前就取消 → 每条落 cancelled（而不是 error / 静默消失）', async () => {
    const events: ImportEvent[] = []
    const warns: Array<{ event: string; context?: unknown }> = []
    const deps = makeSilentDeps(events, warns)

    // 三个库外路径（`isInsideLibraryDir` 全 false → 都进 accepted）
    const paths = ['C:\\dl\\a.zip', 'C:\\dl\\b.zip', 'C:\\dl\\c.zip']
    const assets = await importPaths(paths, { ...deps, shouldStop: () => true })

    // 一个都没导进来（连 staging 都没建）
    expect(assets).toHaveLength(0)
    // 三条都有终态、且都是 cancelled（不是 error、也不是没消息）
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.status === 'cancelled')).toBe(true)
    expect(events.map((e) => e.itemName).sort()).toEqual(['a.zip', 'b.zip', 'c.zip'])
    expect(events.every((e) => (e.message ?? '').includes('取消'))).toBe(true)
    // 一条汇总日志（只报条数）
    expect(warns).toHaveLength(1)
    expect(warns[0].event).toBe('import:cancel')
    expect(warns[0].context).toEqual({ remaining: 3 })
  })

  it('⑦ importPaths：不传 shouldStop → 不产生任何 cancelled（零行为变化）', async () => {
    const events: ImportEvent[] = []
    const warns: Array<{ event: string; context?: unknown }> = []
    const deps = makeSilentDeps(events, warns)

    // 三个都在库内 → 走既有的"已在素材库里，已跳过"分支（error 事件），
    // 不会真的碰磁盘（accepted 为空直接 return）。这里只验证不会冒出 cancelled。
    const lib = 'C:\\Library'
    await importPaths(['C:\\Library\\已有\\x.zip'], { ...deps, libraryDir: lib })

    expect(events.some((e) => e.status === 'cancelled')).toBe(false)
    expect(warns).toHaveLength(0)
  })
})

/**
 * 只做事件/日志收集的 deps：**刻意不注入 ensureThumb / disposeArchive**。
 * 上面两个 importPaths 用例都不该走到真实落盘（一个全被取消、一个全被库内守卫挡掉），
 * 真走到了就是测试设计出错 —— 让缺省实现直接抛错反而能立刻暴露这一点。
 */
function makeSilentDeps(
  events: ImportEvent[],
  warns: Array<{ event: string; context?: unknown }>
): ImportDeps {
  return {
    libraryDir: 'C:\\Library',
    sevenZipPath: null,
    archiveDisposal: 'keep',
    defaultSource: '知末网',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async () => {
      throw new Error('本用例不该走到缩略图生成（说明有条目真的开始处理了）')
    },
    disposeArchive: async () => {
      throw new Error('本用例不该走到原包处置（说明有条目真的开始处理了）')
    },
    warn: (event, context) => {
      warns.push({ event, context })
    },
    emit: (ev) => {
      events.push(ev)
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// B. `logic/importText.ts` 的 cancelled（加值不会编译报错，只能测）
// ══════════════════════════════════════════════════════════════════

describe('importText：cancelled 是终态 + 中性色（不许学 error）', () => {
  it('⑧ isTerminalStatus(cancelled) 为 true（否则倒计时与 ✕ 都不会出现）', () => {
    expect(isTerminalStatus('cancelled')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(isTerminalStatus('skipped'))
  })

  it('⑨ statusClass(cancelled) 是中性灰，且不等于 error 的红', () => {
    expect(statusClass('cancelled')).toBe(statusClass('skipped'))
    expect(statusClass('cancelled')).toBe('text-muted')
    expect(statusClass('cancelled')).not.toBe(statusClass('error'))
  })

  it('⑩ importItemDetail：有 message 用 message，无 message 时含「取消」', () => {
    expect(importItemDetail({ status: 'cancelled', message: '已取消：这一项还没开始处理' })).toBe(
      '已取消：这一项还没开始处理'
    )
    // 空白 message 视为没有
    expect(importItemDetail({ status: 'cancelled', message: '   ' })).toContain('取消')
    // 无 message 无 asset 也绝不能掉进 done 分支印出「已归档」
    const fallback = importItemDetail({ status: 'cancelled' })
    expect(fallback).toContain('取消')
    expect(fallback).not.toContain('已归档')
  })

  it('⑪ 自动消失：cancelled 与 skipped 同为 6 秒，且小于 error 的 12 秒', () => {
    expect(autoDismissDelayMs('cancelled')).toBe(autoDismissDelayMs('skipped'))
    expect(autoDismissDelayMs('cancelled')).toBe(autoDismissDelayMs('done'))
    const cancelledDelay = autoDismissDelayMs('cancelled')
    const errorDelay = autoDismissDelayMs('error')
    expect(cancelledDelay).not.toBeNull()
    expect(errorDelay).not.toBeNull()
    expect(cancelledDelay!).toBeLessThan(errorDelay!)
  })

  it('⑫ 进行中的状态不会被误当成终态（对照组）', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('extracting')).toBe(false)
    expect(isTerminalStatus('organizing')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════
// C. 接线 guard（读源码断言）—— send 通道没有类型回路，三处漏一处都不报错
// ══════════════════════════════════════════════════════════════════

describe('取消通道三处接线（ipc / preload / main）', () => {
  it('⑬ main/index.ts：注册了 IPC.cancelImport，并维护代次计数器', () => {
    const src = readSrc('../src/main/index.ts')
    expect(src).toContain('ipcMain.on(IPC.cancelImport')
    expect(src).toContain('importCancelGen')
    // 每次取消 +1
    expect(src).toContain('importCancelGen += 1')
  })

  it('⑭ preload/index.ts：用 send 而不是 invoke（invoke 会造出没人 await 的悬空 promise）', () => {
    const src = readSrc('../src/preload/index.ts')
    expect(src).toContain('ipcRenderer.send(IPC.cancelImport)')
    expect(src).not.toContain('invoke(IPC.cancelImport)')
  })

  it('⑮ shared/ipc.ts：通道名固定为 import:cancel', () => {
    const src = readSrc('../src/shared/ipc.ts')
    expect(src).toContain("cancelImport: 'import:cancel'")
  })

  it('⑯ importer：shouldStop 的检查出现在 cursor++ 之前（这是"不中途 abort"的落点）', () => {
    const src = readSrc('../src/main/importer.ts')
    const start = src.indexOf('export async function mapWithConcurrency')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('export function isInsideLibraryDir', start)
    expect(end).toBeGreaterThan(start)
    const fn = src.slice(start, end)

    const checkAt = fn.indexOf('if (shouldStop?.() === true) return')
    const claimAt = fn.indexOf('const i = cursor++')
    expect(checkAt).toBeGreaterThan(-1)
    expect(claimAt).toBeGreaterThan(-1)
    // 位置比较（不能只用 toContain：顺序写反了照样能"包含"）
    expect(checkAt).toBeLessThan(claimAt)
    // 而且必须是 worker 循环里的第一句（在 const item 之前），否则等于"领了活再判断"
    expect(checkAt).toBeLessThan(fn.indexOf('const item = items[i]'))
  })

  it('⑰ importer：importPaths 把 deps.shouldStop 传给了 mapWithConcurrency', () => {
    const src = readSrc('../src/main/importer.ts')
    const start = src.indexOf('export async function importPaths')
    const end = src.indexOf('function emitFailure', start)
    const fn = src.slice(start, end)
    expect(fn).toContain('deps.shouldStop')
    // 未开始的条目用 cancelled 上报，且 message 里点明"还没开始"
    expect(fn).toContain("status: 'cancelled'")
    expect(fn).toContain('还没开始处理')
  })

  it('⑱ main/index.ts：shouldStop 用代次比较，而不是 boolean 复位', () => {
    const src = readSrc('../src/main/index.ts')
    const start = src.indexOf('async function runImport')
    const end = src.indexOf('function restartWatcher', start)
    const fn = src.slice(start, end)
    expect(fn).toContain('const myGen = importCancelGen')
    expect(fn).toContain('shouldStop: () => importCancelGen !== myGen')

    // 铁律：除了**声明行的一次初值**，绝不出现 `importCancelGen = 0` 这类复位。
    // 一旦有人为了让"下一批不受影响"而复位，就会把并发中的 watcher 批次一起复活
    // （取消状态被抹掉），用户以为停了其实还在导。
    const resetLines = src.split('\n').filter((line) => /importCancelGen\s*=\s*0/.test(line))
    expect(resetLines).toHaveLength(1) // 有且仅有声明行
    expect(resetLines[0]).toContain('let ') // 且必须是声明，不是 mid-file 赋值
    // 也不许退回 boolean 开关的写法
    expect(/let\s+cancelled\s*=/.test(src)).toBe(false)
  })

  it('⑲ main/index.ts：watcher 的 inflight 占位在 cancelled 时也要释放', () => {
    const src = readSrc('../src/main/index.ts')
    const start = src.indexOf('function emitImportEvent')
    const end = src.indexOf('function broadcastSettingsChanged', start)
    const fn = src.slice(start, end)
    expect(fn).toContain('watcher.markDone(ev.item)')
    expect(fn).toContain("ev.status === 'cancelled'")
  })

  it('⑳ ImportStatus 联合里有 cancelled（否则上面所有接线都只对上空气）', () => {
    const src = readSrc('../src/shared/types.ts')
    expect(src).toContain("'skipped' | 'cancelled'")
  })
})
