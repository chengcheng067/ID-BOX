/**
 * 知末封面抓取核心单测（docs/24 §7.1 #1–#28 的落地版）。
 *
 * 两条铁律：
 * 1. **零网络**：所有请求都走注入的 `fetcher` 桩，fixture 来自本地文件；
 * 2. **零 throw**：每个失败用例都用 `await expect(...).resolves` 断言"返回 reason 而不是抛错"
 *    （自动任务失败必须静默，手动按钮靠 reason 给文案，抛错会把 IPC handler 打挂）。
 *
 * 关键回归点（对应 docs/24 里踩过的坑）：
 * - 软 404 是 HTTP **200** → 详情页的 `status` 完全不参与判断，只看能不能解析出图 URL；
 * - JSON-LD 的 `contentUrl` **永不取图**（指向带水印大图）→ 只发一次请求，结果 `no-image`；
 * - 图片 URL **原样使用**（逐字符断言，防有人"顺手"追加 `x-oss-process` 参数）；
 * - PNG 源必须落 `.cover.png`（不能一律 `.jpg`）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ZHIMO_IMAGE_HOSTS,
  fetchZhimoCover,
  isZhimoImageUrl,
  parseZhimoDetail,
  refreshZhimoCoverInto,
  type ZhimoFetcher
} from '../src/main/zhimoCover'

// ── fixture 读取 ────────────────────────────────────────────────────────

/** 读 `tests/fixtures/` 下的文本 fixture（相对本测试文件，跑 vitest 时 cwd 无关） */
const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')

/** 读 `tests/fixtures/` 下的二进制 fixture */
const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

/** 真实 400×300 无水印样本（JPEG） */
const JPEG_400 = (): Buffer => fixtureBytes('zhimo-clean400-1200166260.jpg')

/** 真实 400×300 无水印样本（PNG，301KB） */
const PNG_400 = (): Buffer => fixtureBytes('zhimo-clean400-1193950340.png')

/** 7 个实测真实 ID（页面 fixture 全部来自 `docs/probe/raw-browser/` 的裁剪版） */
const REAL_IDS = [
  '1200166260',
  '1186414883',
  '1193950340',
  '1148779647',
  '1151853396',
  '1166965084',
  '1172815578'
] as const

const detailUrl = (id: string): string => `https://su.znzmo.com/sumoxing/${id}.html`

/** 1200166260 页里的两张图（list = 无水印 400×300 / main = 带水印大图） */
const LIST_URL_1200 = 'https://image6.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/list'
const MAIN_URL_1200 = 'https://image2.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/detail'

// ── 构造工具 ────────────────────────────────────────────────────────────

/**
 * 构造一份详情页 HTML。
 *
 * @param pageProps 直接写进 `__NEXT_DATA__.props.pageProps`
 * @param ld        JSON-LD 块（可多块），`undefined` = 一块都不放
 * @param rawNext   覆盖 `__NEXT_DATA__` 的原始文本（测 JSON 截断用）
 */
function pageHtml(
  pageProps: unknown,
  ld?: unknown[],
  rawNext?: string
): string {
  const next =
    rawNext ?? JSON.stringify({ props: { pageProps }, page: '/sumoxing/[id]' })
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

/** PNG 头（含 IHDR，宽高真实可解析；不是完整图片，但魔数/尺寸校验够了） */
function pngHead(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8) // IHDR 块长度
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.writeUInt8(8, 24) // bit depth
  buf.writeUInt8(2, 25) // color type
  return buf
}

/** 一个 HTTP 桩响应 */
interface Stub {
  status?: number
  body?: string | Buffer
  /** 抛出的异常（测超时 / 连接失败） */
  error?: unknown
}

/** 造一个可记录调用序列的 fetcher 桩 */
function makeFetcher(handler: (url: string) => Stub): { fetcher: ZhimoFetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: ZhimoFetcher = async (url) => {
    calls.push(url)
    const stub = handler(url)
    if (stub.error !== undefined) throw stub.error
    const body = typeof stub.body === 'string' ? Buffer.from(stub.body) : (stub.body ?? Buffer.alloc(0))
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

/** 造一个 `name` 正确的超时异常（Node 的 AbortSignal.timeout 抛 TimeoutError） */
function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

/** 一个"详情页正常 + 图片正常"的标准路由（可覆盖任意一侧） */
function standardRoute(overrides: { detail?: Stub; image?: Stub; imageUrl?: string } = {}) {
  const imageUrl = overrides.imageUrl ?? LIST_URL_1200
  return (url: string): Stub => {
    if (url === detailUrl('1200166260') || url.startsWith('https://su.znzmo.com/sumoxing/')) {
      return overrides.detail ?? { status: 200, body: fixtureText('zhimo-detail-1200166260.html') }
    }
    if (url === imageUrl) return overrides.image ?? { status: 200, body: JPEG_400() }
    return { status: 500, body: 'unexpected url' }
  }
}

// ── 面包屑：把层级推导单独摊开（防"按下标猜"回归） ──────────────────────

describe('parseZhimoDetail：路径① __NEXT_DATA__（取图的唯一来源）', () => {
  it('真实模型详情页：listImageUrl 指向 image6、mainImageUrl 指向 image2，title/version/skuId 齐全', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1200166260.html'))
    expect(info).not.toBeNull()
    expect(info?.listImageUrl).toBe(LIST_URL_1200)
    expect(new URL(info?.listImageUrl ?? '').hostname).toBe('image6.znzmo.com')
    expect(info?.mainImageUrl).toBe(MAIN_URL_1200)
    expect(new URL(info?.mainImageUrl ?? '').hostname).toBe('image2.znzmo.com')
    expect(info?.title).toContain('中古侘寂壁灯')
    expect(info?.version).toBe('sketchup 2014')
    expect(info?.skuId).toBe('1200166260')
  })

  it('7 个真实 ID 的页面全部解析出 listImageUrl，且 host 都是 image6（无水印来源）', () => {
    expect(REAL_IDS).toHaveLength(7)
    for (const id of REAL_IDS) {
      // fixture 文件名不都等于 ID，用固定的映射表读
      const file = `zhimo-detail-${id}.html`
      const info = parseZhimoDetail(fixtureText(file))
      expect(info, `ID ${id} 应当解析成功`).not.toBeNull()
      expect(info?.listImageUrl, `ID ${id} 必须有 listImageUrl`).toBeTruthy()
      expect(new URL(info?.listImageUrl ?? '').hostname).toBe('image6.znzmo.com')
    }
  })

  it('真实 PNG 详情页（1193950340）的 listImageUrl 后缀是 .png', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1193950340.html'))
    expect(info?.listImageUrl).toContain('.png')
  })

  it('title / version 缺失时为 null（不是空串）', () => {
    const html = pageHtml({
      res: { listImageUrl: LIST_URL_1200, title: '   ', version: '' }
    })
    const info = parseZhimoDetail(html)
    expect(info?.title).toBeNull()
    expect(info?.version).toBeNull()
    expect(info?.skuId).toBeNull()
  })

  it('只有 mainImageUrl（listImageUrl 字段缺失）→ list 为 null、main 有值（兜底信号）', () => {
    const html = pageHtml({ res: { mainImageUrl: MAIN_URL_1200 } })
    const info = parseZhimoDetail(html)
    expect(info).not.toBeNull()
    expect(info?.listImageUrl).toBeNull()
    expect(info?.mainImageUrl).toBe(MAIN_URL_1200)
  })
})

describe('parseZhimoDetail：失效判据（两条解析路径都无图 URL → null）', () => {
  it('软 404 形态 A（真实样本：res={}，status 是 200）→ null', () => {
    expect(parseZhimoDetail(fixtureText('zhimo-soft404-empty.html'))).toBeNull()
  })

  it('软 404 形态 B（真实样本：res={"0":"F","1":"o",…} 字符键对象）→ null', () => {
    expect(parseZhimoDetail(fixtureText('zhimo-soft404-chars.html'))).toBeNull()
  })

  it('构造软 404 A：res = {} → null', () => {
    expect(parseZhimoDetail(pageHtml({ res: {} }))).toBeNull()
  })

  it('构造软 404 B：res 是按字符展开的对象 → null（不能把字符当图 URL）', () => {
    const charRes = Object.fromEntries(
      Array.from('For input string "9999999999"').map((ch, i) => [String(i), ch])
    )
    expect(parseZhimoDetail(pageHtml({ res: charRes }))).toBeNull()
  })

  it('res = null → null', () => {
    expect(parseZhimoDetail(pageHtml({ res: null }))).toBeNull()
  })

  it('裸 Next.js 404（真实样本 err404 / err404b，status 是 404）→ null', () => {
    expect(parseZhimoDetail(fixtureText('zhimo-err404.html'))).toBeNull()
    expect(parseZhimoDetail(fixtureText('zhimo-err404b.html'))).toBeNull()
  })

  it('__NEXT_DATA__ 缺失 + 无 ld+json → null', () => {
    expect(parseZhimoDetail('<html><body><h1>404</h1></body></html>')).toBeNull()
  })

  it('__NEXT_DATA__ 的 JSON 截断 → null', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"res":{"listImage</script>'
    expect(parseZhimoDetail(html)).toBeNull()
  })

  it('props 缺失 → null', () => {
    expect(parseZhimoDetail(pageHtml(undefined, undefined, JSON.stringify({ page: '/' })))).toBeNull()
  })

  it('非字符串入参不炸（防御历史脏数据）', () => {
    expect(parseZhimoDetail(undefined as unknown as string)).toBeNull()
    expect(parseZhimoDetail(null as unknown as string)).toBeNull()
  })
})

describe('parseZhimoDetail：JSON-LD 只做有效性判据，永不取图', () => {
  it('投毒样本（__NEXT_DATA__ 无图 URL + JSON-LD 有 contentUrl）→ 不是 null，但 list/main 都是 null', () => {
    const html = pageHtml({ res: { title: '只有带水印大图' } }, [
      { '@type': 'ImageObject', contentUrl: MAIN_URL_1200 }
    ])
    const info = parseZhimoDetail(html)
    expect(info).not.toBeNull()
    // ⚠️ 关键：contentUrl **不得**被当成图 URL 返回（它是带水印的 image2 大图）
    expect(info?.listImageUrl).toBeNull()
    expect(info?.mainImageUrl).toBeNull()
    expect(info?.title).toBe('只有带水印大图')
  })

  it('__NEXT_DATA__ 坏掉但 JSON-LD 有图 URL → 页面仍判"有效"（不是 not-found）', () => {
    const html = [
      '<script type="application/ld+json">',
      JSON.stringify({ '@type': 'ImageObject', contentUrl: MAIN_URL_1200 }),
      '</script>',
      '<script id="__NEXT_DATA__" type="application/json">{ broken</script>'
    ].join('')
    const info = parseZhimoDetail(html)
    expect(info).not.toBeNull()
    expect(info?.listImageUrl).toBeNull()
    expect(info?.mainImageUrl).toBeNull()
  })

  it('JSON-LD 坏块被跳过，不影响另一块（@graph 里也能找到 ImageObject）', () => {
    const html = [
      '<script type="application/ld+json">*** not json ***</script>',
      '<script type="application/ld+json">',
      JSON.stringify({ '@graph': [{ '@type': ['ImageObject'], contentUrl: MAIN_URL_1200 }] }),
      '</script>'
    ].join('')
    expect(parseZhimoDetail(html)).not.toBeNull()
  })
})

describe('parseZhimoDetail：面包屑（层级由 href 推导，绝不看数组下标）', () => {
  it('2 级：灯具 f783 / 壁灯 f783s1338 → level 1 / 2', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1200166260.html'))
    expect(info?.breadcrumb).toEqual([
      { termId: 783, name: '灯具', href: 'f783', level: 1 },
      { termId: 1338, name: '壁灯', href: 'f783s1338', level: 2 }
    ])
  })

  it('1 级：砖材 f17130 → 只有 1 条、level = 1', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1193950340.html'))
    expect(info?.breadcrumb).toHaveLength(1)
    expect(info?.breadcrumb?.[0]).toEqual({
      termId: 17130,
      name: '砖材',
      href: 'f17130',
      level: 1
    })
  })

  it('3 条但第 3 条的父指向第 1 条（不是中间那条）→ level 1/2/2', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1186414883.html'))
    const crumb = info?.breadcrumb ?? []
    expect(crumb).toHaveLength(3)
    expect(crumb.map((c) => c.level)).toEqual([1, 2, 2])
    expect(crumb[2]).toMatchObject({ termId: 1035, name: '挂画', href: 'f765s1035', level: 2 })
    // 父级从 href 推 = 765（第 1 条），不是数组里的第 2 条 806
    expect(crumb[2].href.startsWith(`f${crumb[0].termId}s`)).toBe(true)
    expect(crumb[2].href.startsWith(`f${crumb[1].termId}s`)).toBe(false)
  })

  it('脏数据（termId 与 href 不一致 / showName 空 / termId 非正整数）→ 全部丢弃，字段为 undefined', () => {
    const html = pageHtml({
      res: { listImageUrl: LIST_URL_1200 },
      breadcrumb_data: [
        { termId: 783, showName: '灯具', href: 'f783s999' }, // href 末段与 termId 不一致
        { termId: 784, showName: '   ', href: 'f784' }, // showName 空
        { termId: '785', showName: '假数字', href: 'f785' }, // termId 非 number
        { termId: -1, showName: '负数', href: 'fx' }, // 非法
        { termId: 786, showName: '奇怪 href', href: 'nope' } // href 不合法
      ]
    })
    const info = parseZhimoDetail(html)
    expect(info).not.toBeNull()
    // ⚠️ 必须"不写该字段"（undefined），不是空数组
    expect(info?.breadcrumb).toBeUndefined()
  })

  it('breadcrumb_data 缺失 → 字段不写（undefined）', () => {
    const info = parseZhimoDetail(pageHtml({ res: { listImageUrl: LIST_URL_1200 } }))
    expect(info?.breadcrumb).toBeUndefined()
  })
})

describe('isZhimoImageUrl：图片 host 白名单（防 JSON 投毒 SSRF）', () => {
  it('白名单正好是 image6 / image2', () => {
    expect(ZHIMO_IMAGE_HOSTS).toEqual(['image6.znzmo.com', 'image2.znzmo.com'])
  })

  it('接受 https 的 image6 / image2（含 query）', () => {
    expect(isZhimoImageUrl(LIST_URL_1200)).toBe(true)
    expect(isZhimoImageUrl(MAIN_URL_1200)).toBe(true)
    expect(isZhimoImageUrl('https://image6.znzmo.com/a/b.png?x-oss-process=style/list')).toBe(true)
  })

  it('拒绝外站 / http / 协议相对 / 子域伪造 / 非字符串', () => {
    expect(isZhimoImageUrl('https://evil.example.com/a.jpg')).toBe(false)
    expect(isZhimoImageUrl('http://image6.znzmo.com/a.jpg')).toBe(false)
    expect(isZhimoImageUrl('//image6.znzmo.com/a.jpg')).toBe(false)
    expect(isZhimoImageUrl('https://image6.znzmo.com.evil.com/a.jpg')).toBe(false)
    expect(isZhimoImageUrl('https://evil.com/?u=image6.znzmo.com')).toBe(false)
    expect(isZhimoImageUrl('   ')).toBe(false)
    expect(isZhimoImageUrl('')).toBe(false)
    expect(isZhimoImageUrl(null)).toBe(false)
    expect(isZhimoImageUrl(123)).toBe(false)
    expect(isZhimoImageUrl('not a url')).toBe(false)
  })
})

describe('fetchZhimoCover：主路径（真实字节 → ok）', () => {
  it('真实 JPEG 样本 → ok / jpeg / 400×300 / image6 / watermarked=false', async () => {
    const { fetcher, calls } = makeFetcher(standardRoute())
    const out = await fetchZhimoCover({ id: '1200166260', fetcher })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.format).toBe('jpeg')
    expect(out.width).toBe(400)
    expect(out.height).toBe(300)
    expect(out.sourceUrl).toBe(LIST_URL_1200)
    expect(out.sourceHost).toBe('image6.znzmo.com')
    expect(out.watermarked).toBe(false)
    expect(out.title).toContain('中古侘寂壁灯')
    expect(out.version).toBe('sketchup 2014')
    // 只两次请求：详情页 + 一张图
    expect(calls).toEqual([detailUrl('1200166260'), LIST_URL_1200])
  })

  it('真实 PNG 样本 → format = png（落盘扩展名由魔数决定，不是一律 jpg）', async () => {
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: PNG_400() } }))
    const out = await fetchZhimoCover({ id: '1193950340', fetcher })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.format).toBe('png')
    expect(out.width).toBe(400)
    expect(out.height).toBe(300)
  })

  it('7 个真实 ID 全链路成功，且 watermarked === false（主路径绝不走带水印图）', async () => {
    const { fetcher, calls } = makeFetcher((url) => {
      if (url.startsWith('https://su.znzmo.com/sumoxing/')) {
        const id = /sumoxing\/(\d+)\.html/.exec(url)?.[1] ?? ''
        return { status: 200, body: fixtureText(`zhimo-detail-${id}.html`) }
      }
      return { status: 200, body: JPEG_400() }
    })
    for (const id of REAL_IDS) {
      const out = await fetchZhimoCover({ id, fetcher })
      expect(out.ok, `ID ${id} 应当抓取成功`).toBe(true)
      if (!out.ok) continue
      expect(out.sourceHost).toBe('image6.znzmo.com')
      expect(out.watermarked).toBe(false)
    }
    // 7 个 ID × 2 次请求（详情页 + 图）
    expect(calls).toHaveLength(14)
  })

  it('listImageUrl 缺失 → 走 mainImageUrl 兜底，watermarked === true', async () => {
    const html = pageHtml({ res: { mainImageUrl: MAIN_URL_1200 } })
    const { fetcher, calls } = makeFetcher((url) => {
      if (url === detailUrl('1200166260')) return { status: 200, body: html }
      if (url === MAIN_URL_1200) return { status: 200, body: JPEG_400() }
      return { status: 500, body: 'unexpected' }
    })
    const out = await fetchZhimoCover({ id: '1200166260', fetcher })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sourceUrl).toBe(MAIN_URL_1200)
    expect(out.sourceHost).toBe('image2.znzmo.com')
    expect(out.watermarked).toBe(true)
    expect(calls).toEqual([detailUrl('1200166260'), MAIN_URL_1200])
  })
})

describe('fetchZhimoCover：入参 / URL 护栏（不该发的请求一个都不发）', () => {
  it.each(['abc', '12345', '', '   ', '1234567abc', '12-3456789'])(
    '非法 id %j → no-id，且 fetcher 零调用',
    async (badId) => {
      const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: 'never' }))
      await expect(fetchZhimoCover({ id: badId, fetcher })).resolves.toEqual({
        ok: false,
        reason: 'no-id'
      })
      expect(calls).toHaveLength(0)
    }
  )

  it('图片 host 不在白名单（evil.example.com）→ bad-url，且**不发起图片请求**', async () => {
    const poisoned = pageHtml({ res: { listImageUrl: 'https://evil.example.com/a.jpg' } })
    const { fetcher, calls } = makeFetcher((url) => {
      if (url === detailUrl('1200166260')) return { status: 200, body: poisoned }
      return { status: 200, body: JPEG_400() }
    })
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'bad-url'
    })
    expect(calls).toEqual([detailUrl('1200166260')])
  })

  it('图片 URL 被原样使用（逐字符相等，不接受任何 OSS 参数改写）', async () => {
    const { fetcher, calls } = makeFetcher(standardRoute())
    await fetchZhimoCover({ id: '1200166260', fetcher })
    expect(calls[1]).toBe(LIST_URL_1200)
    expect(calls[1]).toContain('x-oss-process=style/list')
    expect(calls[1]).not.toContain('format,jpg')
  })
})

describe('fetchZhimoCover：失效页（状态码不参与判断，只看有没有图 URL）', () => {
  it('软 404（HTTP **200** + res={}）→ not-found（不是 network，也不是 no-image）', async () => {
    const { fetcher } = makeFetcher(() => ({
      status: 200,
      body: fixtureText('zhimo-soft404-empty.html')
    }))
    await expect(fetchZhimoCover({ id: '9999999999', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('软 404 形态 B（200 + 字符键 res）→ not-found', async () => {
    const { fetcher } = makeFetcher(() => ({
      status: 200,
      body: fixtureText('zhimo-soft404-chars.html')
    }))
    await expect(fetchZhimoCover({ id: '9999999999', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('裸 Next 404（HTTP 404 + 无图 URL）→ not-found（状态码不改变判据）', async () => {
    const { fetcher } = makeFetcher(() => ({
      status: 404,
      body: fixtureText('zhimo-err404.html')
    }))
    await expect(fetchZhimoCover({ id: '1234567890', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('投毒样本（JSON-LD 有 contentUrl、__NEXT_DATA__ 无图）→ no-image，且只发了详情页一次请求', async () => {
    const html = pageHtml({ res: { title: '只有带水印大图' } }, [
      { '@type': 'ImageObject', contentUrl: MAIN_URL_1200 }
    ])
    const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: html }))
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'no-image'
    })
    expect(calls).toHaveLength(1)
    expect(calls).toEqual([detailUrl('1200166260')])
  })
})

describe('fetchZhimoCover：网络层（超时 / 连接失败 / 非 2xx，绝不抛错）', () => {
  // ⚠️ 2026-10 起 `timeout` / `network` 会**重试 1 次**（见 tests/zhimoRetry.test.ts）。
  //    这里统一传 `retryBackoffMs: 0`：断言的是"最终 reason 不变"，不该让单测真等 800ms。
  it('详情页超时（TimeoutError，重试后仍超时）→ timeout', async () => {
    const { fetcher, calls } = makeFetcher(() => ({ error: timeoutError() }))
    await expect(
      fetchZhimoCover({ id: '1200166260', fetcher, retryBackoffMs: 0 })
    ).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
    // 初次 + 1 次重试 = 2 发，**有界**
    expect(calls).toHaveLength(2)
  })

  it('详情页连接失败（普通 Error）→ network', async () => {
    const { fetcher } = makeFetcher(() => ({ error: new Error('ECONNREFUSED') }))
    await expect(
      fetchZhimoCover({ id: '1200166260', fetcher, retryBackoffMs: 0 })
    ).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
  })

  it('详情页 text() 抛错 → network', async () => {
    const fetcher: ZhimoFetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream broken')
      },
      arrayBuffer: async () => new ArrayBuffer(0)
    })
    await expect(
      fetchZhimoCover({ id: '1200166260', fetcher, retryBackoffMs: 0 })
    ).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
  })

  it('图片 500 → network，且**不回落** mainImageUrl（重试请求仍打 listImageUrl）', async () => {
    const { fetcher, calls } = makeFetcher(standardRoute({ image: { status: 500, body: 'boom' } }))
    await expect(
      fetchZhimoCover({ id: '1200166260', fetcher, retryBackoffMs: 0 })
    ).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
    // 2 次尝试 ×（1 页 + 1 图）；第 2 次重试**从详情页重来**，但图仍是 listImageUrl
    expect(calls).toHaveLength(4)
    expect(calls[1]).toBe(LIST_URL_1200)
    expect(calls[3]).toBe(LIST_URL_1200)
  })

  it('图片超时 → timeout，且不回落', async () => {
    const { fetcher, calls } = makeFetcher(standardRoute({ image: { error: timeoutError() } }))
    await expect(
      fetchZhimoCover({ id: '1200166260', fetcher, retryBackoffMs: 0 })
    ).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
    expect(calls).toHaveLength(4)
    expect(calls[1]).toBe(LIST_URL_1200)
    expect(calls[3]).toBe(LIST_URL_1200)
  })
})

describe('fetchZhimoCover：图片内容校验（魔数 + 尺寸）', () => {
  it('HTML 当图片返回 → bad-image', async () => {
    const { fetcher } = makeFetcher(
      standardRoute({ image: { status: 200, body: '<html>not an image</html>' } })
    )
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'bad-image'
    })
  })

  it('宽度 120 → too-small', async () => {
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: pngHead(120, 90) } }))
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'too-small'
    })
  })

  it('宽度正好 200 → 通过门槛（边界值不该被误杀）', async () => {
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: pngHead(200, 150) } }))
    const out = await fetchZhimoCover({ id: '1200166260', fetcher })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.width).toBe(200)
      expect(out.height).toBe(150)
    }
  })

  it('超 20MB → bad-image（走 validateCoverImage 的 too-large 分支）', async () => {
    const huge = Buffer.alloc(20 * 1024 * 1024 + 1)
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(huge, 0)
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: huge } }))
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'bad-image'
    })
  })

  it('空图片体 → bad-image', async () => {
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: Buffer.alloc(0) } }))
    await expect(fetchZhimoCover({ id: '1200166260', fetcher })).resolves.toEqual({
      ok: false,
      reason: 'bad-image'
    })
  })
})

describe('refreshZhimoCoverInto：落盘（扩展名按实际字节，同族清理，绝不抛错）', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const makeAssetFolder = async (name = '中古侘寂壁灯'): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'idbox-zhimo-'))
    tmpDirs.push(root)
    const folder = path.join(root, name)
    await mkdir(folder, { recursive: true })
    return folder
  }

  it('PNG 源 → 落 <资产名>.cover.png，且同族旧 .cover.jpg 被清掉', async () => {
    const folder = await makeAssetFolder()
    const stale = path.join(folder, '中古侘寂壁灯.cover.jpg')
    await writeFile(stale, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const { fetcher } = makeFetcher(standardRoute({ image: { status: 200, body: PNG_400() } }))

    const result = await refreshZhimoCoverInto(folder, '1193950340', { fetcher })
    expect(result.ok).toBe(true)
    expect(result.rel).toBe('中古侘寂壁灯.cover.png')

    const names = await readdir(folder)
    expect(names).toContain('中古侘寂壁灯.cover.png')
    expect(names.some((n) => n.endsWith('.cover.jpg'))).toBe(false)

    const written = await stat(path.join(folder, '中古侘寂壁灯.cover.png'))
    expect(written.size).toBe(PNG_400().length)
  })

  it('JPEG 源 → 落 <资产名>.cover.jpg，返回 size / width / height / sourceHost / watermarked', async () => {
    const folder = await makeAssetFolder('壁灯-2')
    const { fetcher } = makeFetcher(standardRoute())
    const res = await refreshZhimoCoverInto(folder, '1200166260', { fetcher })
    expect(res.ok).toBe(true)
    expect(res.rel).toBe('壁灯-2.cover.jpg')
    expect(res.size).toBe(JPEG_400().length)
    expect(res.width).toBe(400)
    expect(res.height).toBe(300)
    expect(res.sourceHost).toBe('image6.znzmo.com')
    expect(res.watermarked).toBe(false)
    expect(res.title).toContain('中古侘寂壁灯')
    expect(await readdir(folder)).toEqual(['壁灯-2.cover.jpg'])
  })

  it('文件夹不存在 → write-failed（不抛错）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'idbox-zhimo-'))
    tmpDirs.push(root)
    const { fetcher } = makeFetcher(standardRoute())
    await expect(
      refreshZhimoCoverInto(path.join(root, '不存在的资产'), '1200166260', { fetcher })
    ).resolves.toEqual({ ok: false, reason: 'write-failed' })
  })

  it('抓取失败原样透传 reason（no-id），且不产生任何文件', async () => {
    const folder = await makeAssetFolder('空资产')
    const { fetcher, calls } = makeFetcher(() => ({ status: 200, body: 'never' }))
    await expect(refreshZhimoCoverInto(folder, 'abc', { fetcher })).resolves.toEqual({
      ok: false,
      reason: 'no-id'
    })
    expect(calls).toHaveLength(0)
    expect(await readdir(folder)).toEqual([])
  })

  it('图片坏掉（bad-image）时磁盘零改动', async () => {
    const folder = await makeAssetFolder('坏图资产')
    await writeFile(path.join(folder, '坏图资产.cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const { fetcher } = makeFetcher(
      standardRoute({ image: { status: 200, body: '<html>nope</html>' } })
    )
    await expect(refreshZhimoCoverInto(folder, '1200166260', { fetcher })).resolves.toEqual({
      ok: false,
      reason: 'bad-image'
    })
    expect(await readdir(folder)).toEqual(['坏图资产.cover.jpg'])
  })
})
