/**
 * 知末封面抓取：**瞬时失败的有界重试**（2026-10 事故回归，`app-2026-10-22.log`）。
 *
 * 事故现场：同一 ID 连点两次，两条 `zhimo:cover-failed {"reason":"timeout"}` 恰好
 * 间隔 15s（= 当时的详情页超时），而同 ID 在 Electron 运行时里详情页只要 709ms。
 * 结论不是"ID 没了 / UA 被拦"，而是**一次边缘节点抖动**——而当时的实现一次失败即放弃。
 *
 * 本文件钉死的四件事（**任何一条被改坏，用户就会再次看到"一次抖动 = 获取失败"**）：
 * 1. `timeout` / `network` → **初次 + 1 次**重试（不是无限，也不是 0 次）；
 * 2. 其余 7 种失败 → **一次都不重试**（重试改变不了结果，只会把等待翻倍）；
 * 3. 日志字段 `step` / `attempt` / `elapsedMs` / `totalMs` 真的带上了
 *    （`step` 必须能区分 page 与 image —— 否则下次还是要靠时长反推）；
 * 4. 退避时长可注入，单测**不会真的 sleep 800ms**。
 *
 * 零网络：所有请求走注入的 `fetcher`；零真实等待：`retryBackoffMs: 0` + 即时 `sleep` 桩。
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PAGE_TIMEOUT_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  ZHIMO_RETRYABLE_REASONS,
  fetchZhimoCover,
  isRetryableZhimoReason,
  refreshZhimoCoverInto,
  zhimoCoverFailLogContext,
  type ZhimoAttemptFailure,
  type ZhimoFetcher
} from '../src/main/zhimoCover'
import type { ZhimoCoverFailReason } from '../src/shared/types'

// ── fixture ─────────────────────────────────────────────────────────────

/** 临时目录（只在 write-failed 用例里用） */
const tmpRoots: string[] = []

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')

const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

/** 真实 400×300 无水印 JPEG */
const JPEG_400 = (): Buffer => fixtureBytes('zhimo-clean400-1200166260.jpg')

const DETAIL_PAGE = fixtureText('zhimo-detail-1200166260.html')

const ID = '1200166260'
const DETAIL_URL = `https://su.znzmo.com/sumoxing/${ID}.html`
const LIST_URL = 'https://image6.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/list'

/** 软 404 形态 A（真实样本）→ 解析不出图 URL → not-found */
const SOFT_404 = fixtureText('zhimo-soft404-empty.html')

// ── 桩 ──────────────────────────────────────────────────────────────────

interface Stub {
  status?: number
  body?: string | Buffer
  /** 抛出的异常（测超时 / 连接失败） */
  error?: unknown
}

function isDetail(url: string): boolean {
  return url.startsWith('https://su.znzmo.com/sumoxing/')
}

/**
 * 造一个 fetcher 桩：`handler` 拿到 url 与**本次是第几次调用**（1-based）。
 *
 * 用"调用序号"而不是内部计数器，是为了让"第 1 次超时、第 2 次成功"这类
 * 表驱动写法和真实调用次数断言共用同一份事实。
 */
function makeFetcher(handler: (url: string, callIndex: number) => Stub): {
  fetcher: ZhimoFetcher
  calls: string[]
} {
  const calls: string[] = []
  const fetcher: ZhimoFetcher = async (url) => {
    calls.push(url)
    const stub = handler(url, calls.length)
    if (stub.error !== undefined) throw stub.error
    const body =
      typeof stub.body === 'string' ? Buffer.from(stub.body) : (stub.body ?? Buffer.alloc(0))
    const status = stub.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body.toString('utf-8'),
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(body.byteLength)
        new Uint8Array(ab).set(body)
        return ab
      }
    }
  }
  return { fetcher, calls }
}

/** Node 的 `AbortSignal.timeout()` 抛的错（name 必须是 TimeoutError） */
function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

/** 只有 `__NEXT_DATA__` 的最小页面（用来精确控制"页面在，但图 URL 是啥"） */
function pageHtml(pageProps: unknown): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps }
    })}</script>`,
    '</body></html>'
  ].join('')
}

/** 收集 `onAttemptFailed` 回调用（"日志载荷 spy"：handler 就是把这些字段写进日志） */
function collectAttempts(): {
  failures: ZhimoAttemptFailure[]
  onAttemptFailed: (failure: ZhimoAttemptFailure) => void
} {
  const failures: ZhimoAttemptFailure[] = []
  return { failures, onAttemptFailed: (failure) => failures.push(failure) }
}

// ── 1. 参数（超时预算收敛 + 重试参数写死） ──────────────────────────────

describe('重试参数：超时预算收敛 + 有界次数', () => {
  it('详情页 15s → 10s、图片 20s → 15s（重试后最坏耗时可控）', () => {
    expect(DEFAULT_PAGE_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_IMAGE_TIMEOUT_MS).toBe(15_000)
  })

  it('初次 + **1 次**重试，退避 800ms', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(2)
    expect(DEFAULT_RETRY_BACKOFF_MS).toBe(800)
  })

  it('可重试原因**只有** timeout / network；其余 7 种一个都不行', () => {
    expect(ZHIMO_RETRYABLE_REASONS).toEqual(['timeout', 'network'])

    expect(isRetryableZhimoReason('timeout')).toBe(true)
    expect(isRetryableZhimoReason('network')).toBe(true)

    const never: ZhimoCoverFailReason[] = [
      'no-id',
      'not-found',
      'no-image',
      'bad-url',
      'bad-image',
      'too-small',
      'write-failed'
    ]
    for (const reason of never) {
      expect(isRetryableZhimoReason(reason), `${reason} 绝不能重试`).toBe(false)
    }
    // 可重试 + 不可重试 = 枚举全集（新增 reason 时这里会红，逼你想清楚要不要重试）
    expect(new Set([...ZHIMO_RETRYABLE_REASONS, ...never]).size).toBe(9)
  })
})

// ── 2. 瞬时失败：重试一次就成功 ─────────────────────────────────────────

describe('瞬时失败 → 重试 1 次', () => {
  it('详情页第 1 次 TimeoutError、第 2 次成功 → ok:true；详情页请求正好 2 次', async () => {
    const { fetcher, calls } = makeFetcher((url, callIndex) => {
      if (isDetail(url)) {
        // 只有**详情页**的第 1 发超时；第 2 发给真实页面
        return callIndex === 1 ? { error: timeoutError() } : { status: 200, body: DETAIL_PAGE }
      }
      return { status: 200, body: JPEG_400() }
    })
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      sleep,
      retryBackoffMs: 800,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    // 返回值形状与改造前完全一致
    expect(out.width).toBe(400)
    expect(out.height).toBe(300)
    expect(out.sourceHost).toBe('image6.znzmo.com')
    expect(out.watermarked).toBe(false)

    // 详情页请求 = 2 次（初次 + 重试）；成功那一发还要取 1 次图 → 总共 3 次
    expect(calls.filter(isDetail)).toHaveLength(2)
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBe(LIST_URL)

    // 退避真的按 800ms 走，但被注入的 sleep 接住了（单测不会真等）
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(800)

    // 失败现场：第 1 发、详情页、还会再试
    expect(attempts.failures).toHaveLength(1)
    expect(attempts.failures[0]).toMatchObject({
      reason: 'timeout',
      step: 'page',
      attempt: 1,
      willRetry: true
    })
    expect(typeof attempts.failures[0].elapsedMs).toBe('number')
    expect(attempts.failures[0].elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('详情页连接失败（network）同样重试：第 1 发 ECONNREFUSED、第 2 发成功 → ok:true', async () => {
    let pageCalls = 0
    const { fetcher } = makeFetcher((url) => {
      if (isDetail(url)) {
        pageCalls += 1
        return pageCalls === 1
          ? { error: new Error('ECONNREFUSED') }
          : { status: 200, body: DETAIL_PAGE }
      }
      return { status: 200, body: JPEG_400() }
    })

    const out = await fetchZhimoCover({ id: ID, fetcher, retryBackoffMs: 0 })
    expect(out.ok).toBe(true)
    expect(pageCalls).toBe(2)
  })

  it('图片超时也重试，且 `step` 必须报 image（不是 page）', async () => {
    let imageCalls = 0
    const { fetcher, calls } = makeFetcher((url) => {
      if (isDetail(url)) return { status: 200, body: DETAIL_PAGE }
      imageCalls += 1
      return imageCalls === 1 ? { error: timeoutError() } : { status: 200, body: JPEG_400() }
    })
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(out.ok).toBe(true)
    // 第 1 次尝试：page + image（image 超时）；第 2 次尝试：page + image（成功）
    expect(calls).toHaveLength(4)
    expect(attempts.failures).toHaveLength(1)
    expect(attempts.failures[0]).toMatchObject({
      reason: 'timeout',
      step: 'image',
      attempt: 1,
      willRetry: true
    })
  })
})

// ── 3. 两次都失败：只重试一次，绝不无限 ────────────────────────────────

describe('两次都失败 → 上报 timeout/network，恰好 2 发', () => {
  it('两次都超时 → reason=timeout、attempt=2、详情页只请求 2 次', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ error: timeoutError() }))
    const attempts = collectAttempts()
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      sleep,
      retryBackoffMs: 800,
      onAttemptFailed: attempts.onAttemptFailed
    })

    // `timeout` 的语义**没变**：仍是失败原因之一，只是"重试后仍失败才上报"
    expect(out).toEqual({ ok: false, reason: 'timeout' })

    // 有界：2 发，不是 3 发、也不是无限
    expect(calls).toHaveLength(2)
    expect(calls).toEqual([DETAIL_URL, DETAIL_URL])
    expect(sleep).toHaveBeenCalledTimes(1) // 只在第 1 发与第 2 发之间退避了一次

    expect(attempts.failures.map((f) => [f.attempt, f.willRetry])).toEqual([
      [1, true],
      [2, false]
    ])
  })

  it('日志上下文（handler 交给 logWarn 的载荷）带齐 step / attempt / elapsedMs / totalMs', async () => {
    const { fetcher } = makeFetcher(() => ({ error: timeoutError() }))
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })
    expect(out.ok).toBe(false)
    if (out.ok) return

    const last = attempts.failures[attempts.failures.length - 1] ?? null
    const ctx = zhimoCoverFailLogContext(ID, out.reason, last)

    // 事故复盘要的正是这五个字段：有 step 才不用从"时长是 15s 还是 20s"反推
    expect(ctx).toMatchObject({
      id: ID,
      reason: 'timeout',
      step: 'page',
      attempt: 2
    })
    expect(ctx.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(ctx.totalMs).toBeGreaterThanOrEqual(ctx.elapsedMs)
    // 字段恒在（日志分析不用处理"有时缺 key"）
    expect(Object.keys(ctx).sort()).toEqual(
      ['attempt', 'elapsedMs', 'id', 'reason', 'step', 'totalMs'].sort()
    )
  })
})

// ── 4. 非瞬时失败：一次都不重试 ─────────────────────────────────────────

describe('非瞬时失败 → **只调用 1 次**（证明重试只对瞬时类生效）', () => {
  it('not-found（软 404，HTTP 200）→ 详情页只请求 1 次', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: SOFT_404 }))
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(out).toEqual({ ok: false, reason: 'not-found' })
    expect(calls).toHaveLength(1)
    expect(attempts.failures).toHaveLength(1)
    expect(attempts.failures[0]).toMatchObject({
      reason: 'not-found',
      step: 'page',
      attempt: 1,
      willRetry: false
    })
  })

  it('no-image（页面有效但只有带水印大图的 JSON-LD）→ 只请求 1 次', async () => {
    // 有效性由 JSON-LD 的 ImageObject 撑住，但 `__NEXT_DATA__.res` 里没有图 URL →
    // 页面"在"，只是取不到干净图 → `no-image`（不是 not-found）
    const html = [
      '<script type="application/ld+json">',
      JSON.stringify({
        '@type': 'ImageObject',
        contentUrl: 'https://image2.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/detail'
      }),
      '</script>',
      pageHtml({ res: { title: '只有标题' } })
    ].join('')
    const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: html }))
    const out = await fetchZhimoCover({ id: ID, fetcher, retryBackoffMs: 0 })
    expect(out).toEqual({ ok: false, reason: 'no-image' })
    expect(calls).toHaveLength(1)
  })

  it('bad-url（图 URL 不在白名单）→ 只请求 1 次，且不发图片请求', async () => {
    const { fetcher, calls } = makeFetcher(() => ({
      status: 200,
      body: pageHtml({ res: { listImageUrl: 'https://evil.example.com/a.jpg' } })
    }))
    const out = await fetchZhimoCover({ id: ID, fetcher, retryBackoffMs: 0 })
    expect(out).toEqual({ ok: false, reason: 'bad-url' })
    expect(calls).toEqual([DETAIL_URL])
  })

  it('bad-image（返回 HTML 当图片）→ 详情页 1 次 + 图片 1 次，不重试', async () => {
    const { fetcher, calls } = makeFetcher((url) =>
      isDetail(url)
        ? { status: 200, body: DETAIL_PAGE }
        : { status: 200, body: '<html>not an image</html>' }
    )
    const attempts = collectAttempts()
    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })
    expect(out).toEqual({ ok: false, reason: 'bad-image' })
    expect(calls).toHaveLength(2)
    expect(attempts.failures[0]).toMatchObject({ reason: 'bad-image', step: 'image', willRetry: false })
  })

  it('too-small（宽度 120）→ 不重试', async () => {
    const png120 = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png120, 0)
    png120.writeUInt32BE(13, 8)
    png120.write('IHDR', 12, 'ascii')
    png120.writeUInt32BE(120, 16)
    png120.writeUInt32BE(90, 20)

    const { fetcher, calls } = makeFetcher((url) =>
      isDetail(url) ? { status: 200, body: DETAIL_PAGE } : { status: 200, body: png120 }
    )
    const out = await fetchZhimoCover({ id: ID, fetcher, retryBackoffMs: 0 })
    expect(out).toEqual({ ok: false, reason: 'too-small' })
    expect(calls).toHaveLength(2)
  })

  it('no-id（ID 不合法）→ **零请求**、零尝试、日志上下文降级为 step=null / attempt=0', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: 'never' }))
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: 'abc',
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(out).toEqual({ ok: false, reason: 'no-id' })
    expect(calls).toHaveLength(0)
    expect(attempts.failures).toHaveLength(0)

    const ctx = zhimoCoverFailLogContext('abc', 'no-id', null)
    expect(ctx).toEqual({
      id: 'abc',
      reason: 'no-id',
      step: null,
      attempt: 0,
      elapsedMs: 0,
      totalMs: 0
    })
  })

  it('write-failed（资产目录不存在）→ 抓取成功一次，落盘失败；不重试抓取', async () => {
    const { fetcher, calls } = makeFetcher((url) =>
      isDetail(url) ? { status: 200, body: DETAIL_PAGE } : { status: 200, body: JPEG_400() }
    )
    const attempts = collectAttempts()
    const root = await mkdtemp(path.join(tmpdir(), 'idbox-zhimo-retry-'))
    tmpRoots.push(root)

    const res = await refreshZhimoCoverInto(path.join(root, '不存在的资产'), ID, {
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(res).toEqual({ ok: false, reason: 'write-failed' })
    // 抓取侧一次就成功了（page + image），磁盘问题不该触发网络重试
    expect(calls).toHaveLength(2)
    expect(attempts.failures).toHaveLength(0)
  })
})

// ── 5. 参数边界 ────────────────────────────────────────────────────────

describe('参数边界：成功不重试、可关闭重试、退避可注入、回调抛错不影响结果', () => {
  it('一次就成功 → 不重试、不回调、不 sleep', async () => {
    const { fetcher, calls } = makeFetcher((url) =>
      isDetail(url) ? { status: 200, body: DETAIL_PAGE } : { status: 200, body: JPEG_400() }
    )
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const attempts = collectAttempts()

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      sleep,
      onAttemptFailed: attempts.onAttemptFailed
    })

    expect(out.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(sleep).not.toHaveBeenCalled()
    expect(attempts.failures).toHaveLength(0)
  })

  it('`retryBackoffMs: 0` → 不调用 sleep（单测不会真的等 800ms）', async () => {
    const { fetcher } = makeFetcher(() => ({ error: timeoutError() }))
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})

    await fetchZhimoCover({ id: ID, fetcher, sleep, retryBackoffMs: 0 })

    expect(sleep).not.toHaveBeenCalled()
  })

  it('`maxAttempts: 1` → 重试被关闭（仍只上报 timeout，1 发）', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ error: timeoutError() }))
    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      maxAttempts: 1,
      retryBackoffMs: 0
    })
    expect(out).toEqual({ ok: false, reason: 'timeout' })
    expect(calls).toHaveLength(1)
  })

  it('诊断回调抛错不影响抓取结果（日志坏掉不能把封面拖下水）', async () => {
    const { fetcher } = makeFetcher((url, callIndex) => {
      if (isDetail(url)) {
        return callIndex === 1 ? { error: timeoutError() } : { status: 200, body: DETAIL_PAGE }
      }
      return { status: 200, body: JPEG_400() }
    })

    const out = await fetchZhimoCover({
      id: ID,
      fetcher,
      retryBackoffMs: 0,
      onAttemptFailed: () => {
        throw new Error('log backend down')
      }
    })

    expect(out.ok).toBe(true)
  })
})

// ── 6. 接线：handler 必须真的把这五个字段写进日志 ──────────────────────

describe('main handler 日志接线（source guard）', () => {
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')

  it('`cover-failed` 用 `zhimoCoverFailLogContext(...)` 组装载荷（而不是只写 id + reason）', () => {
    expect(src).toContain(
      "logWarn('zhimo:cover-failed', zhimoCoverFailLogContext(id, reason, diagnostics.last))"
    )
    // 失败现场必须来自"每一次尝试失败"的回调，否则 step/attempt 无从取得
    expect(src).toContain('onAttemptFailed: (failure) => {')
  })

  it('`cover-retry` 只在还会再试时记一条，且带 step / attempt / elapsedMs / totalMs', () => {
    expect(src).toContain("logWarn('zhimo:cover-retry'")
    expect(src).toContain('if (failure.willRetry) {')
    expect(src).toContain('step: failure.step')
    expect(src).toContain('attempt: failure.attempt')
    expect(src).toContain('elapsedMs: failure.elapsedMs')
    expect(src).toContain('totalMs: failure.totalMs')
  })

  it('失败仍是 warn（不是 error）：ID 没了 / 网络抖动都是正常业务结果', () => {
    const start = src.indexOf('IPC.fetchZhimoCover')
    const end = src.indexOf('ipcMain.handle(IPC.rescan', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).not.toContain('logError')
  })
})
