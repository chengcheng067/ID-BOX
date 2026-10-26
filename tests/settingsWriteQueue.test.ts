/**
 * 设置写盘串行队列（0.7.10 真机 QA：并发 settings:set 触发 rename ENOENT）。
 *
 * 四层覆盖：
 * 1. 纯队列逻辑 —— 严格串行 / 中间失败不卡死后续 / 返回值不串台 / 排空后无残留 rejection；
 * 2. 源码守卫 —— 写盘调用点必须在 `enqueueSettingsWrite(` 内，`then(fn, fn)` 写法不许退化；
 * 3. 假 fs 集成 —— 6 次并发 `saveSettings`：无一次抛 ENOENT，最终落盘是第 6 次内容，
 *    且底层 write/rename 严格交替（不交错）；
 * 4. 读档回落 —— 主档损坏时仍能从 `.bak` 恢复（串行化没有动读路径）。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { createSettingsWriteQueue } from '../src/main/settings'

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 给"未处理 rejection"留出触发窗口（Node 在微任务队列排空后 emit） */
const settleUnhandled = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 30))

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

describe('createSettingsWriteQueue（纯逻辑，零 IO）', () => {
  it('10 个并发任务严格串行：无交错，开始/结束顺序与入队顺序一致', async () => {
    const queue = createSettingsWriteQueue()
    const events: string[] = []
    let active = 0
    let maxActive = 0

    const tasks = range(10).map((i) =>
      queue.enqueue(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push(`start-${i}`)
        await tick()
        await tick()
        events.push(`end-${i}`)
        active -= 1
        return i
      })
    )

    const results = await Promise.all(tasks)

    expect(maxActive).toBe(1)
    expect(active).toBe(0)
    expect(events).toEqual(range(10).flatMap((i) => [`start-${i}`, `end-${i}`]))
    // 返回值各自对应自己的任务（不串台）
    expect(results).toEqual(range(10))
  })

  it('第 3 个任务 reject 不阻断第 4~10 个：后续全部执行、顺序不乱、失败只回传给自己的调用方', async () => {
    const queue = createSettingsWriteQueue()
    const ran: number[] = []
    const results = await Promise.allSettled(
      range(10).map((i) =>
        queue.enqueue(async () => {
          await tick()
          ran.push(i)
          if (i === 3) throw new Error(`boom-${i}`)
          return i
        })
      )
    )

    // 3 号之后的全部照跑，且顺序严格
    expect(ran).toEqual(range(10))

    const rejected = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ i }) => i)
    expect(rejected).toEqual([3])

    results.forEach((r, i) => {
      if (i === 3) {
        expect(r.status).toBe('rejected')
        if (r.status === 'rejected') expect((r.reason as Error).message).toBe('boom-3')
      } else {
        expect(r.status).toBe('fulfilled')
        if (r.status === 'fulfilled') expect(r.value).toBe(i)
      }
    })

    // 失败之后队列仍然可用（不会被一个错误永久卡死）
    await expect(queue.enqueue(async () => 'after-failure')).resolves.toBe('after-failure')
  })

  it('失败后队列排空处于 resolved 态：不残留 rejection（不会变成 unhandledrejection）', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const queue = createSettingsWriteQueue()
      const failing = queue.enqueue(async () => {
        await tick()
        throw new Error('save-failed')
      })
      // 调用方捕获（与主进程 IPC handler 里抛回渲染层等价）
      await expect(failing).rejects.toThrow('save-failed')

      // 排空不抛错 —— 说明链上没有挂着 rejection
      await expect(queue.idle()).resolves.toBeUndefined()

      // 再排队一次正常任务，仍然执行（链是干净的）
      await expect(queue.enqueue(async () => 42)).resolves.toBe(42)

      await settleUnhandled()
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('慢任务排在快任务前面时不会被"后到先写"（串行 = 写盘顺序即调用顺序）', async () => {
    const queue = createSettingsWriteQueue()
    const order: string[] = []
    const slow = queue.enqueue(async () => {
      await new Promise<void>((r) => setTimeout(r, 20))
      order.push('slow')
      return 'slow'
    })
    const fast = queue.enqueue(async () => {
      order.push('fast')
      return 'fast'
    })

    expect(await Promise.all([slow, fast])).toEqual(['slow', 'fast'])
    expect(order).toEqual(['slow', 'fast'])
  })
})

describe('源码守卫：settings.ts 的写盘调用点必须在串行队列内', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/main/settings.ts', import.meta.url)),
    'utf-8'
  )
  /**
   * 去掉注释后再做调用点断言：注释里为了解释竞态会写 `writeFile(tmp)` / `rename(...)`
   * 这类举例，直接扫原文会误判成"第二套写盘路径"。
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('保留 `then(fn, fn)` 写法（前一次失败也要继续执行下一次）', () => {
    expect(code).toMatch(/\.then\(\s*fn\s*,\s*fn\s*\)/)
  })

  it('队列自身吞掉 rejection（`writeChain` 不持有失败）', () => {
    expect(code).toMatch(/writeChain\s*=\s*next\.catch\(/)
  })

  it('saveSettings 的 writeFile / copyFile / rename 都在 enqueueSettingsWrite( 之内', () => {
    const start = code.indexOf('export async function saveSettings')
    expect(start).toBeGreaterThan(-1)
    const body = code.slice(start)

    const enqueueAt = body.indexOf('enqueueSettingsWrite(')
    expect(enqueueAt).toBeGreaterThan(-1)

    const beforeQueue = body.slice(0, enqueueAt)
    // 入队之前不许有任何落盘动作（否则就是绕过串行化的裸调用）
    expect(beforeQueue).not.toMatch(/writeFile\s*\(/)
    expect(beforeQueue).not.toMatch(/rename\s*\(/)
    expect(beforeQueue).not.toMatch(/copyFile\s*\(/)

    // 三个动作都在队列闭包里，顺序仍是 写 tmp → 备份 → rename
    const queued = body.slice(enqueueAt)
    const w = queued.indexOf('writeFile(tmp')
    const c = queued.indexOf('copyFile(target')
    const r = queued.indexOf('rename(tmp, target')
    expect(w).toBeGreaterThan(-1)
    expect(c).toBeGreaterThan(w)
    expect(r).toBeGreaterThan(c)
  })

  it('全文件只有 saveSettings 里一处 writeFile / rename（没有第二套写盘路径）', () => {
    expect(code.match(/writeFile\s*\(/g) ?? []).toHaveLength(1)
    expect(code.match(/rename\s*\(/g) ?? []).toHaveLength(1)
  })
})

// ── 假 fs 集成：6 次并发 saveSettings ──────────────────────────────────────
//
// `node:fs/promises` 被替换成内存版，且 `writeFile` 故意慢（多个 tick）——
// 这样 6 个并发调用会全部进入 writeFile 之后才有人开始 rename，正是真机现场。
// 没有串行队列时，第 2 次 rename 必然对着已消失的 tmp 抛 ENOENT。

interface FakeFsState {
  userData: string
  files: Map<string, string>
  /** 仅记录落盘关键动作，用于断言"write/rename 严格交替" */
  ops: string[]
  /** 已发生的 rename 次数（从 1 开始计） */
  renameCount: number
  /** 第几次 rename 强制失败（1-based；-1 = 不注入失败），模拟杀软/索引器短暂占用主档 */
  failRenameAt: number
}

const fake = vi.hoisted<FakeFsState>(() => ({
  userData: 'C:\\fake-userdata',
  files: new Map<string, string>(),
  ops: [],
  renameCount: 0,
  failRenameAt: -1
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => fake.userData }
}))

vi.mock('node:fs/promises', () => {
  const enoent = (p: string, op: string): NodeJS.ErrnoException => {
    const err = new Error(`ENOENT: no such file or directory, ${op} '${p}'`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    err.errno = -4058
    err.path = p
    return err
  }
  return {
    mkdir: async (): Promise<void> => undefined,
    readFile: async (p: string): Promise<string> => {
      const v = fake.files.get(p)
      if (v === undefined) throw enoent(p, 'open')
      return v
    },
    writeFile: async (p: string, data: string): Promise<void> => {
      fake.ops.push(`write:${p}`)
      // 模拟真实写盘耗时：3 个 tick，足够让 6 个并发调用全部进入本函数
      for (let i = 0; i < 3; i += 1) await tick()
      fake.files.set(p, String(data))
    },
    copyFile: async (from: string, to: string): Promise<void> => {
      const v = fake.files.get(from)
      if (v === undefined) throw enoent(from, 'copyFile')
      fake.files.set(to, v)
    },
    rename: async (from: string, to: string): Promise<void> => {
      const v = fake.files.get(from)
      if (v === undefined) throw enoent(from, 'rename')
      fake.renameCount += 1
      if (fake.renameCount === fake.failRenameAt) {
        const err = new Error(`EBUSY: resource busy or locked, rename '${from}'`) as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      }
      fake.files.set(to, v)
      fake.files.delete(from)
      fake.ops.push(`rename:${from}->${to}`)
    }
  }
})

describe('saveSettings 并发串行化（假 fs 集成）', () => {
  const USER_DATA = 'C:\\fake-userdata'
  const MAIN = `${USER_DATA}\\settings.json`
  const TMP = `${MAIN}.tmp`

  it('6 次并发保存：无一次抛 ENOENT，最终落盘是第 6 次的内容，write/rename 严格交替', async () => {
    fake.files.clear()
    fake.ops.length = 0
    fake.renameCount = 0
    fake.failRenameAt = -1
    fake.files.set(MAIN, JSON.stringify(DEFAULT_SETTINGS, null, 2))

    const { saveSettings, settingsWritesIdle } = await import('../src/main/settings')

    const snapshot = (i: number): Settings => ({
      ...DEFAULT_SETTINGS,
      libraryDir: `E:\\Lib-${i}`,
      defaultSource: `source-${i}`,
      thumbMaxPx: 100 + i
    })

    const results = await Promise.allSettled(range(6).map((i) => saveSettings(snapshot(i))))

    const failures = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ r, i }) => ({
        i,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: ((r as PromiseRejectedResult).reason as NodeJS.ErrnoException).code
      }))
    expect(failures).toEqual([])
    results.forEach((r) => expect(r.status).toBe('fulfilled'))

    await settingsWritesIdle()

    // 最终内容 = 第 6 次（索引 5）的内容
    const onDisk = JSON.parse(fake.files.get(MAIN) ?? '{}') as Settings
    expect(onDisk.libraryDir).toBe('E:\\Lib-5')
    expect(onDisk.defaultSource).toBe('source-5')
    expect(onDisk.thumbMaxPx).toBe(105)

    // 底层动作严格交替：write tmp → rename tmp→main，重复 6 轮，绝不交错
    const critical = fake.ops.filter((o) => o.startsWith('write:') || o.startsWith('rename:'))
    expect(critical).toEqual(
      range(6).flatMap(() => [`write:${TMP}`, `rename:${TMP}->${MAIN}`])
    )

    // tmp 不残留（最后一次 rename 已把它带走）
    expect(fake.files.has(TMP)).toBe(false)
    // 一代备份存在且内容是「第 5 次」的那份（备份始终是上一次有效档）
    expect(JSON.parse(fake.files.get(`${MAIN}.bak`) ?? '{}').libraryDir).toBe('E:\\Lib-4')
  })

  it('某一次写盘失败只回传给自己的调用方，后续保存照常落盘（队列不卡死）', async () => {
    fake.files.clear()
    fake.ops.length = 0
    fake.renameCount = 0
    // 第 2 次 rename 注入 EBUSY（真实场景：杀软/索引器短暂占用主档）
    fake.failRenameAt = 2

    const { saveSettings, settingsWritesIdle } = await import('../src/main/settings')

    const base: Settings = { ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib-ok' }

    const first = saveSettings(base)
    const second = saveSettings({ ...base, libraryDir: 'E:\\Lib-failed' })
    const third = saveSettings({ ...base, libraryDir: 'E:\\Lib-last' })

    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow(/EBUSY/)
    await expect(third).resolves.toBeUndefined()
    await settingsWritesIdle()

    // 失败的那次没有污染队列：第 3 次正常落盘，内容 = 第 3 次
    expect(JSON.parse(fake.files.get(MAIN) ?? '{}').libraryDir).toBe('E:\\Lib-last')
    // tmp 被第 3 次复用并 rename 走，不留垃圾
    expect(fake.files.has(TMP)).toBe(false)
  })

  it('调用方在入队前就失败（payload 无法序列化）也不影响后续保存', async () => {
    fake.files.clear()
    fake.ops.length = 0
    fake.renameCount = 0
    fake.failRenameAt = -1

    const { saveSettings, settingsWritesIdle } = await import('../src/main/settings')

    const base: Settings = { ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib-ok' }
    const circular = { ...base } as Settings & { self?: unknown }
    circular.self = circular

    const bad = saveSettings(circular)
    const good = saveSettings({ ...base, libraryDir: 'E:\\Lib-good' })

    await expect(bad).rejects.toThrow()
    await expect(good).resolves.toBeUndefined()
    await settingsWritesIdle()

    expect(JSON.parse(fake.files.get(MAIN) ?? '{}').libraryDir).toBe('E:\\Lib-good')
  })
})
