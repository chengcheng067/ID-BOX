/**
 * 知末「只取详情页」轻量入口单测（`fetchZhimoMeta` / `parseZhimoMeta`）。
 *
 * 这个入口存在的**唯一理由**：封面通道必须"下到图且 ≥200px"才算成功，
 * 图片 404 / 太小会让"详情页其实已经拿到站方分类"一起丢。所以本文件守三件事：
 *
 * 1. **只发一次详情页请求**：注入的 fetcher 桩记录调用序列，断言长度为 1 且 URL 是详情页；
 *    另外用**源码切片**再守一道 —— 元信息那一段代码里不许出现任何图片下载/图片 host。
 * 2. **绝不抛错**：404 / 超时都用 `await expect(...).resolves` 断言"返回 reason"。
 * 3. **`classifyBaseName` 为 `null` 不是错误**：`ok:true` + `null`（站方没给 ≠ 请求失败）。
 *
 * 全部零网络：fetcher 桩不许透传到 `globalThis.fetch`。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { fetchZhimoMeta, parseZhimoMeta, type ZhimoFetcher } from '../src/main/zhimoCover'

// ── fixture / 常量 ──────────────────────────────────────────────────────

/** 读 `tests/fixtures/` 下的文本 fixture（相对本测试文件，cwd 无关） */
const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')

/** 真实详情页 fixture（站方 `classifyBaseName = 壁灯`，见下方断言） */
const REAL_PAGE = 'zhimo-detail-1200166260.html'

const ID = '1200166260'

const detailUrl = (id: string): string => `https://su.znzmo.com/sumoxing/${id}.html`

/** 一张真实的站方图 URL（只为让 `parseZhimoDetail` 认可"这是有效详情页"） */
const LIST_URL = 'https://image6.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/list'

// ── 构造工具 ────────────────────────────────────────────────────────────

/**
 * 构造一份详情页 HTML（结构照抄站方：`__NEXT_DATA__` + 可选 JSON-LD）。
 *
 * @param pageProps 直接写进 `__NEXT_DATA__.props.pageProps`
 * @param ld        JSON-LD 块，`undefined` = 一块都不放
 */
function pageHtml(pageProps: unknown, ld?: unknown[]): string {
  const next = JSON.stringify({ props: { pageProps }, page: '/sumoxing/[id]' })
  const ldTags = (ld ?? [])
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
    .join('')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    ldTags,
    '</head><body>',
    `<script id="__NEXT_DATA__" type="application/json">${next}</script>`,
    '</body></html>'
  ].join('')
}

/** 一个 HTTP 桩响应 */
interface Stub {
  status?: number
  body?: string | Buffer
  /** 抛出的异常（测超时 / 连接失败） */
  error?: unknown
}

/**
 * 造一个可记录调用序列的 fetcher 桩。
 *
 * ⚠️ `arrayBuffer()` 故意**抛错**：本入口一个图片字节都不该读，
 * 万一将来有人在这里接上取图逻辑，测试会立刻炸而不是"悄悄多下一次图"。
 */
function makeFetcher(handler: (url: string) => Stub): { fetcher: ZhimoFetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: ZhimoFetcher = async (url) => {
    calls.push(url)
    const stub = handler(url)
    if (stub.error !== undefined) throw stub.error
    const body =
      typeof stub.body === 'string' ? Buffer.from(stub.body) : (stub.body ?? Buffer.alloc(0))
    const status = stub.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body.toString('utf-8'),
      arrayBuffer: async () => {
        throw new Error('知末元信息入口不该读取图片字节（arrayBuffer 被调用）')
      }
    }
  }
  return { fetcher, calls }
}

/** 详情页桩：无论什么 URL 都回同一份 HTML（status 可覆盖） */
function pageFetcher(html: string, status = 200): { fetcher: ZhimoFetcher; calls: string[] } {
  return makeFetcher(() => ({ status, body: html }))
}

// ── 1. `classifyBaseName` 的四种取值形态 ────────────────────────────────

describe('parseZhimoMeta：classifyBaseName 取值口径（正常 / 空串 / 缺失 / 非字符串）', () => {
  const metaOf = (classifyBaseName: unknown): ReturnType<typeof parseZhimoMeta> =>
    parseZhimoMeta(
      pageHtml({
        res: { title: '现代壁灯', listImageUrl: LIST_URL, classifyBaseName }
      })
    )

  it('正常字符串 → 原样返回（只 trim，不做任何映射）', () => {
    const meta = metaOf('卡座沙发')
    expect(meta).not.toBeNull()
    expect(meta?.classifyBaseName).toBe('卡座沙发')
  })

  it('两端空白 → trim 后返回', () => {
    expect(metaOf('  壁灯  ')?.classifyBaseName).toBe('壁灯')
  })

  it('空串 / 纯空白 → null（"没有" 不返回空串）', () => {
    expect(metaOf('')?.classifyBaseName).toBeNull()
    expect(metaOf('   ')?.classifyBaseName).toBeNull()
  })

  it('缺失（undefined / null）→ null', () => {
    expect(metaOf(undefined)?.classifyBaseName).toBeNull()
    expect(metaOf(null)?.classifyBaseName).toBeNull()
  })

  it('非字符串（number / object / array / boolean）→ null，且不抛错', () => {
    for (const bad of [123, 0, { name: '壁灯' }, ['壁灯'], true]) {
      const meta = metaOf(bad)
      expect(meta).not.toBeNull()
      expect(meta?.classifyBaseName).toBeNull()
    }
  })

  it('站方占位符 `--` / `-` → null（素材频道大量字段这么表示"不适用"）', () => {
    expect(metaOf('--')?.classifyBaseName).toBeNull()
    expect(metaOf('-')?.classifyBaseName).toBeNull()
  })
})

// ── 2. 有效性判据：软 404 要判死，"图挂了但分类在"要判活 ─────────────────

describe('parseZhimoMeta：页面有效性判据', () => {
  it('软 404 空壳（`res` 为 `{}`）→ null（与封面路径同一口径）', () => {
    expect(parseZhimoMeta(pageHtml({ res: {} }))).toBeNull()
  })

  it('软 404（错误文案按字符展开成 `{"0":"F",…}`）→ null', () => {
    expect(parseZhimoMeta(pageHtml({ res: { 0: 'F', 1: 'o', 2: 'r' } }))).toBeNull()
  })

  it('没有 `__NEXT_DATA__`、也没有 JSON-LD → null', () => {
    expect(parseZhimoMeta('<!doctype html><html><body>404</body></html>')).toBeNull()
  })

  it('非字符串入参（防御性）→ null，不抛错', () => {
    expect(parseZhimoMeta(undefined as unknown as string)).toBeNull()
    expect(parseZhimoMeta(null as unknown as string)).toBeNull()
  })

  it('页面**没有图 URL**、但有 `classifyBaseName` → 仍然有效（"图挂了不该丢分类"）', () => {
    const meta = parseZhimoMeta(
      pageHtml({ res: { title: '卡座沙发组合', classifyBaseName: '卡座沙发' } })
    )
    expect(meta).not.toBeNull()
    expect(meta?.classifyBaseName).toBe('卡座沙发')
    expect(meta?.title).toBe('卡座沙发组合')
  })

  it('页面没有 `classifyBaseName`、但有 `detailParamsExtract` → 有效（style 等仍可取）', () => {
    const meta = parseZhimoMeta(
      pageHtml({ res: { listImageUrl: LIST_URL, detailParamsExtract: { style: '中古' } } })
    )
    expect(meta).not.toBeNull()
    expect(meta?.style).toBe('中古')
    expect(meta?.classifyBaseName).toBeNull()
  })

  it('真实详情页 fixture：四个字段都取到真实值', () => {
    const meta = parseZhimoMeta(fixtureText(REAL_PAGE))
    expect(meta).not.toBeNull()
    expect(meta?.classifyBaseName).toBe('壁灯')
    expect(meta?.style).toBe('中古')
    expect(meta?.version).toBe('sketchup 2014')
    expect(meta?.title).toContain('壁灯')
  })
})

// ── 3. 轻量入口：只发一次详情页请求，绝不下图片 ──────────────────────────

describe('fetchZhimoMeta：只取详情页（零图片请求）', () => {
  it('恰好 1 次请求，URL 就是详情页；图片 URL 一次都没被请求', async () => {
    // 页面里**故意**带正常图 URL：如果是封面路径，这里会再发一次 `image6` 请求
    const html = pageHtml({
      res: {
        title: '现代壁灯',
        listImageUrl: LIST_URL,
        mainImageUrl: 'https://image2.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/detail',
        classifyBaseName: '壁灯',
        detailParamsExtract: { style: '中古', version: 'sketchup 2014' }
      }
    })
    const { fetcher, calls } = pageFetcher(html)

    const out = await fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })

    expect(out).toEqual({
      ok: true,
      classifyBaseName: '壁灯',
      style: '中古',
      version: 'sketchup 2014',
      title: '现代壁灯'
    })
    // 「只调用了一次且 URL 是详情页」—— 本入口的核心契约
    expect(calls).toEqual([detailUrl(ID)])
    expect(calls).toHaveLength(1)
    expect(calls.some((u) => u.includes('image6.znzmo.com'))).toBe(false)
    expect(calls.some((u) => u.includes('image2.znzmo.com'))).toBe(false)
  })

  it('真实 fixture 走桩：返回真实分类，且仍然只有 1 次请求', async () => {
    const { fetcher, calls } = pageFetcher(fixtureText(REAL_PAGE))

    const out = await fetchZhimoMeta({ id: ID, fetcher })

    expect(out.ok).toBe(true)
    expect(out).toMatchObject({ classifyBaseName: '壁灯', style: '中古', version: 'sketchup 2014' })
    expect(calls).toEqual([detailUrl(ID)])
  })

  it('内部超时配置生效：传入 pageTimeoutMs 时详情页请求带 AbortSignal（不抛错）', async () => {
    const { fetcher } = pageFetcher(
      pageHtml({ res: { listImageUrl: LIST_URL, classifyBaseName: '壁灯' } })
    )
    const out = await fetchZhimoMeta({ id: ID, fetcher, pageTimeoutMs: 1_000 })
    expect(out.ok).toBe(true)
  })
})

// ── 4. 失败路径：返回 reason，绝不抛错 ──────────────────────────────────

describe('fetchZhimoMeta：404 / 超时 / 非法 ID，一律返回 reason 不抛错', () => {
  it('详情页 404（页面壳也是 404 体）→ not-found', async () => {
    const { fetcher, calls } = pageFetcher(fixtureText('zhimo-soft404-empty.html'), 404)

    const out = await fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })

    expect(out).toEqual({ ok: false, reason: 'not-found' })
    // not-found 不可重试 → 只发 1 次
    expect(calls).toHaveLength(1)
  })

  it('详情页 404 裸错误页（无 __NEXT_DATA__）→ not-found', async () => {
    const { fetcher } = makeFetcher(() => ({
      status: 404,
      body: '<!doctype html><html><body>404 Not Found</body></html>'
    }))
    await expect(fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('超时（TimeoutError）→ timeout，且默认重试一次（共 2 次请求）', async () => {
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { fetcher, calls } = makeFetcher(() => ({ error: timeoutErr }))

    const out = await fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })

    expect(out).toEqual({ ok: false, reason: 'timeout' })
    expect(calls).toEqual([detailUrl(ID), detailUrl(ID)])
  })

  it('连接失败（非超时异常）→ network', async () => {
    const { fetcher } = makeFetcher(() => ({ error: new Error('ECONNRESET') }))
    await expect(fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
  })

  it('maxAttempts=1 时关掉重试（超时只发 1 次）', async () => {
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { fetcher, calls } = makeFetcher(() => ({ error: timeoutErr }))

    const out = await fetchZhimoMeta({ id: ID, fetcher, maxAttempts: 1 })

    expect(out).toEqual({ ok: false, reason: 'timeout' })
    expect(calls).toHaveLength(1)
  })

  it('非法 ID（非 6 位以上纯数字）→ no-id，且**一个请求都不发**', async () => {
    const { fetcher, calls } = pageFetcher(pageHtml({ res: {} }))

    for (const bad of ['', '  ', '12345', '12ab34', 'ID_1200166260', '12345678901234567890x']) {
      await expect(fetchZhimoMeta({ id: bad, fetcher })).resolves.toEqual({
        ok: false,
        reason: 'no-id'
      })
    }
    expect(calls).toHaveLength(0)
  })

  it('text() 抛异常（连接中途断开）→ network，不抛错', async () => {
    const calls: string[] = []
    const fetcher: ZhimoFetcher = async (url) => {
      calls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('stream aborted')
        },
        arrayBuffer: async () => {
          throw new Error('不该读字节')
        }
      }
    }
    await expect(fetchZhimoMeta({ id: ID, fetcher, retryBackoffMs: 0 })).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
    expect(calls).toHaveLength(2) // network 可重试
  })
})

// ── 5. `classifyBaseName` 为 null 时仍然 ok（"站方没给"不是错误）──────────

describe('fetchZhimoMeta：站方没给分类时仍然成功', () => {
  it('页面没有 classifyBaseName → ok:true + classifyBaseName:null', async () => {
    const { fetcher } = pageFetcher(
      pageHtml({ res: { title: '无分类素材', listImageUrl: LIST_URL } })
    )

    const out = await fetchZhimoMeta({ id: ID, fetcher })

    expect(out.ok).toBe(true)
    expect(out).toEqual({
      ok: true,
      classifyBaseName: null,
      style: null,
      version: null,
      title: '无分类素材'
    })
  })

  it('classifyBaseName 是空串 → ok:true + null（不被判成失败）', async () => {
    const { fetcher } = pageFetcher(
      pageHtml({ res: { listImageUrl: LIST_URL, classifyBaseName: '' } })
    )
    const out = await fetchZhimoMeta({ id: ID, fetcher })
    expect(out).toEqual({ ok: true, classifyBaseName: null, style: null, version: null, title: null })
  })
})

// ── 6. 源码守卫：元信息那一段代码里没有任何图片下载 ──────────────────────

describe('源码守卫：元信息路径里不存在图片下载', () => {
  /** 元信息段落的起点（`zhimoCover.ts` 里该段是文件最后一节） */
  const SECTION_MARK = '// ── 详情页元信息（只取详情页、绝不下图片）'
  const source = readFileSync(new URL('../src/main/zhimoCover.ts', import.meta.url), 'utf-8')
  const start = source.indexOf(SECTION_MARK)
  const section = start >= 0 ? source.slice(start) : ''

  it('能找到元信息段落（防止切片静默变空、守卫形同虚设）', () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(section).toContain('export async function fetchZhimoMeta')
    expect(section).toContain('export function parseZhimoMeta')
    expect(section.length).toBeGreaterThan(500)
  })

  it('不出现任何图片下载调用 / 图片 host / 落盘调用', () => {
    expect(section).not.toContain('fetchImageBytes')
    expect(section).not.toContain('arrayBuffer')
    expect(section).not.toContain('validateCoverImage')
    expect(section).not.toContain('writeCoverImageInto')
    expect(section).not.toContain('imageSizeOf')
    expect(section).not.toContain('image6.znzmo.com')
    expect(section).not.toContain('image2.znzmo.com')
    expect(section).not.toContain('ZHIMO_IMAGE_HOSTS')
  })

  it('只复用详情页抓取（`fetchDetailHtml`），不另写一套 fetch', () => {
    expect(section).toContain('fetchDetailHtml')
    expect(section).not.toContain('globalThis.fetch(')
  })
})
