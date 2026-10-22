/**
 * 知末「风格」抓取（TODO-3 / docs/25）：主进程侧解析 + 渲染层落库判定。
 *
 * 三件事必须钉死（任何一条坏了，用户就会看到"风格没自动填"或"用户选的风被覆盖"）：
 * ① `__NEXT_DATA__.props.pageProps.res.detailParamsExtract.style` 被解析出来，
 *    并**随封面结果一起**返回（同一次 GET，零额外请求）；
 * ② 站方自由词**不直接落库**：只认 `STYLE_LIST_BY_KIND.model`，只补空，只对 model；
 * ③ `detail` 解析不到 / 字段缺失时，**封面照常成功**（`style: null`）——
 *    风格是附加信息，不能把封面拖下水。
 *
 * store 侧的"真写库"路径（Dexie put + 内存同步）在 `zhimoCoverStore.test.ts`
 * 的「知末风格」describe 里（那里有现成的 window/db 桩）。
 *
 * 零网络：所有请求走注入的 `fetcher`。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  fetchZhimoCover,
  parseZhimoDetail,
  type ZhimoFetcher
} from '../src/main/zhimoCover'
import { resolveZhimoStyle } from '../src/renderer/logic/zhimoStyle'

// ── fixture ─────────────────────────────────────────────────────────────

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')

const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

const JPEG_400 = (): Buffer => fixtureBytes('zhimo-clean400-1200166260.jpg')

const ID = '1200166260'
const DETAIL_URL = `https://su.znzmo.com/sumoxing/${ID}.html`
const LIST_URL = 'https://image6.znzmo.com/1750340351242_9325.jpeg?x-oss-process=style/list'

/** 只有 `__NEXT_DATA__` 的最小页面（精确控制"站方给了什么"） */
function pageHtml(pageProps: unknown): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps }
    })}</script>`,
    '</body></html>'
  ].join('')
}

/** 造一个 fetcher：详情页给 `html`，图片给真实 JPEG */
function makeFetcher(html: string): ZhimoFetcher {
  return async (url) => {
    if (url.startsWith('https://su.znzmo.com/sumoxing/')) {
      return {
        ok: true,
        status: 200,
        text: async () => html,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const body = JPEG_400()
    return {
      ok: true,
      status: 200,
      text: async () => body.toString('utf-8'),
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(body.byteLength)
        new Uint8Array(ab).set(body)
        return ab
      }
    }
  }
}

// ── ① 解析（真实字段） ──────────────────────────────────────────────────

describe('parseZhimoDetail：扩展属性（同一次 GET，零额外请求）', () => {
  it('1168792999（docs/25 实测字段）→ style=现代 / classifyBaseName=卡座沙发 / version=sketchup 2014 / renderer=Enscape / polys=204933', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1168792999.html'))
    expect(info).not.toBeNull()
    expect(info?.detail).toEqual({
      style: '现代',
      classifyBaseName: '卡座沙发',
      version: 'sketchup 2014',
      renderer: 'Enscape',
      polys: 204933
    })
    // 主图字段照旧（新字段不得挤掉原有解析结果）
    expect(info?.listImageUrl).toContain('image6.znzmo.com')
    expect(info?.title).toBe('卡座沙发')
    expect(info?.skuId).toBe('1168792999')
  })

  it('真实详情页 1200166260 → style=中古 / classifyBaseName=壁灯（渲染器与面数也解析）', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1200166260.html'))
    expect(info?.detail?.style).toBe('中古')
    expect(info?.detail?.classifyBaseName).toBe('壁灯')
    expect(info?.detail?.version).toBe('sketchup 2014')
    expect(info?.detail?.renderer).toBe('Enscape')
    expect(info?.detail?.polys).toBe(57388)
  })

  it('贴图频道真实页 1148779647：style 是占位符 `--` → null（不是字符串 "--"）', () => {
    const info = parseZhimoDetail(fixtureText('zhimo-detail-1148779647.html'))
    expect(info?.detail?.style).toBeNull()
    expect(info?.detail?.renderer).toBeNull()
    expect(info?.detail?.polys).toBeNull()
    // 但其它字段照常解析（不能因为 style 没值就整块丢弃）
    expect(info?.detail?.classifyBaseName).toBe('海洋板')
    expect(info?.detail?.version).toBe('MAX 9及以下')
  })

  it('detailParamsExtract 与 classifyBaseName 都没有 → `detail` 字段不写（undefined，不造空对象）', () => {
    const info = parseZhimoDetail(
      pageHtml({ res: { listImageUrl: LIST_URL, title: '没有扩展属性的页' } })
    )
    expect(info).not.toBeNull()
    expect(info?.detail).toBeUndefined()
    expect('detail' in (info ?? {})).toBe(false)
  })

  it('空值 / 脏值一律 null，**绝不造空串**：空 style / 空白 / 字符串面数 / 负面数', () => {
    const info = parseZhimoDetail(
      pageHtml({
        res: {
          listImageUrl: LIST_URL,
          classifyBaseName: '   ',
          detailParamsExtract: {
            style: '   ',
            version: '',
            renderer: '--',
            polys: '204933' // 字符串面数：不猜，当没有
          }
        }
      })
    )
    expect(info?.detail).toEqual({
      style: null,
      classifyBaseName: null,
      version: null, // dpe.version 空 → 回落到 res.version（也没有）
      renderer: null,
      polys: null
    })

    const negative = parseZhimoDetail(
      pageHtml({
        res: { listImageUrl: LIST_URL, detailParamsExtract: { style: '现代', polys: -1 } }
      })
    )
    expect(negative?.detail?.style).toBe('现代')
    expect(negative?.detail?.polys).toBeNull()
  })

  it('detailParamsExtract 不是对象（字符串）但 classifyBaseName 有值 → detail 存在、style 为 null', () => {
    const info = parseZhimoDetail(
      pageHtml({ res: { listImageUrl: LIST_URL, detailParamsExtract: 'boom', classifyBaseName: '沙发' } })
    )
    expect(info?.detail).toEqual({
      style: null,
      classifyBaseName: '沙发',
      version: null,
      renderer: null,
      polys: null
    })
  })
})

// ── ② 随封面结果返回；③ 解析失败不影响封面 ──────────────────────────────

describe('fetchZhimoCover：style 随成功结果返回，失败/缺失时不影响封面', () => {
  it('真页 1168792999 → ok:true 且 style === 现代', async () => {
    const out = await fetchZhimoCover({
      id: '1168792999',
      fetcher: makeFetcher(fixtureText('zhimo-detail-1168792999.html')),
      retryBackoffMs: 0
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.style).toBe('现代')
    expect(out.width).toBe(400)
  })

  it('页面没有 detailParamsExtract → 封面**照常成功**，style 为 null', async () => {
    const html = pageHtml({ res: { listImageUrl: LIST_URL, mainImageUrl: LIST_URL } })
    const out = await fetchZhimoCover({
      id: ID,
      fetcher: makeFetcher(html),
      retryBackoffMs: 0
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.style).toBeNull()
    expect(out.sourceHost).toBe('image6.znzmo.com')
  })

  it('真实详情页 1200166260 → style === 中古（与标题/图同一发请求，不额外发请求）', async () => {
    const calls: string[] = []
    const inner = makeFetcher(fixtureText('zhimo-detail-1200166260.html'))
    const fetcher: ZhimoFetcher = async (url, init) => {
      calls.push(url)
      return inner(url, init)
    }
    const out = await fetchZhimoCover({ id: ID, fetcher, retryBackoffMs: 0 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.style).toBe('中古')
    // 详情页 1 发 + 图片 1 发：风格没有多花任何请求
    expect(calls).toEqual([DETAIL_URL, LIST_URL])
  })
})

// ── ④ 落库判定（纯函数） ────────────────────────────────────────────────

describe('resolveZhimoStyle：只补空 / 只认词表 / 只对 model', () => {
  const model = (styles?: string[]): { kind: 'model'; styles?: string[] } => ({ kind: 'model', styles })

  it('命中词表 + styles 空 → 可写（含首尾空白归一）', () => {
    expect(resolveZhimoStyle(model([]), '现代')).toEqual({ write: true, style: '现代' })
    expect(resolveZhimoStyle(model([]), '  中古  ')).toEqual({ write: true, style: '中古' })
    expect(resolveZhimoStyle(model(undefined), '侘寂')).toEqual({ write: true, style: '侘寂' })
    // 词表里 model 册独有的「简洁」也必须认（两册差异点在 docs/07 §5.10）
    expect(resolveZhimoStyle(model([]), '简洁')).toEqual({ write: true, style: '简洁' })
  })

  it('已有风格 → kept-existing（**不追加、不覆盖**）', () => {
    expect(resolveZhimoStyle(model(['侘寂']), '现代')).toEqual({
      write: false,
      reason: 'kept-existing'
    })
    // 连"站方等于用户已选"也不写：写入是无意义的多余落库
    expect(resolveZhimoStyle(model(['现代']), '现代')).toEqual({
      write: false,
      reason: 'kept-existing'
    })
    // 空串/脏值不算"已有"
    expect(resolveZhimoStyle(model(['', '   ']), '现代')).toEqual({ write: true, style: '现代' })
  })

  it('不在词表 → not-in-list（如 赛博朋克 / 贴图册独有 简欧）', () => {
    expect(resolveZhimoStyle(model([]), '赛博朋克')).toEqual({
      write: false,
      reason: 'not-in-list'
    })
    expect(resolveZhimoStyle(model([]), '简欧')).toEqual({ write: false, reason: 'not-in-list' })
    expect(resolveZhimoStyle(model([]), '现代简约')).toEqual({ write: false, reason: 'not-in-list' })
  })

  it('空值 / 占位符 → empty（缺字段、空串、`--`、非字符串）', () => {
    for (const v of [null, undefined, '', '   ', '--', '-', 123, {}, []]) {
      expect(resolveZhimoStyle(model([]), v), `style=${JSON.stringify(v)}`).toEqual({
        write: false,
        reason: 'empty'
      })
    }
  })

  it('非 model（texture / material / hdri）→ not-model（词表不同册，语义不通用）', () => {
    expect(resolveZhimoStyle({ kind: 'texture', styles: [] }, '现代')).toEqual({
      write: false,
      reason: 'not-model'
    })
    expect(resolveZhimoStyle({ kind: 'material', styles: [] }, '现代')).toEqual({
      write: false,
      reason: 'not-model'
    })
    expect(resolveZhimoStyle({ kind: 'hdri', styles: [] }, '现代')).toEqual({
      write: false,
      reason: 'not-model'
    })
  })

  it('判定顺序：非 model 且已有风格 → 报 not-model（先判大类，不误记"保留用户选择"）', () => {
    expect(resolveZhimoStyle({ kind: 'texture', styles: ['现代'] }, '现代')).toEqual({
      write: false,
      reason: 'not-model'
    })
  })
})
