/**
 * 跨版本更新说明合并单测 —— 2026-11。
 *
 * 用户需求（逐字）：从很早的版本（例如第一个能收到推送更新的版本）跳到最新版时，
 * 推送内容应当**包含中间跳过的每个版本的具体更新内容**，而不是只显示最新那一条。
 *
 * 覆盖五块：
 * ① 列表端点 / 头 / 超时信号（注入 fetcher，**绝不真联网**）；
 * ② 过滤：draft / prerelease / 非版本号 tag 一律不参与；
 * ③ 区间与顺序：`current < v <= latest`，按版本降序；
 * ④ 条数上限（10）与总预算（20000）；
 * ⑤ 清洗：引用 / 表格 / 图片 / HTML 被清掉，小标题降一级，产出能被
 *    `logic/releaseNotes.ts` 的受限解析器完整吃下（这是本任务的核心验收口径）。
 */
import { describe, expect, it } from 'vitest'
import {
  GITHUB_RELEASES_LIST_URL,
  MAX_NOTES_CHARS,
  fetchMergedRelease,
  type UpdateFetchInit,
  type UpdateFetchResponse
} from '../src/main/updateCheck'
import { parseReleaseNotes } from '../src/renderer/logic/releaseNotes'

/** 构造假 Response（只实现模块用到的 ok / status / json） */
function fakeResponse(body: unknown, ok = true, status = 200): UpdateFetchResponse {
  return { ok, status, json: async () => body }
}

/** 记录请求，便于断言 URL / 头 / 信号 */
function recordingFetcher(body: unknown) {
  const calls: Array<{ url: string; init: UpdateFetchInit }> = []
  const fetcher = async (url: string, init: UpdateFetchInit): Promise<UpdateFetchResponse> => {
    calls.push({ url, init })
    return fakeResponse(body)
  }
  return { calls, fetcher }
}

/**
 * 一条 release JSON（tag / 说明 / 其余字段可覆盖）。
 *
 * `published_at` 缺省按 tag 直接拼成合法 ISO 时间（`v1.2.0` → `2026-01-02T10:00:00Z`），
 * 让版头日期断言可读；需要无日期时显式传 `published_at: null`。
 */
function rel(tag: string, body?: unknown, over: Record<string, unknown> = {}) {
  const version = tag.replace(/^v/, '')
  const digits = version.split('.')
  const major = (digits[0] ?? '1').padStart(2, '0')
  const minor = (digits[1] ?? '0').padStart(2, '0')
  return {
    tag_name: tag,
    html_url: `https://github.com/chengcheng067/ID-BOX/releases/tag/${tag}`,
    published_at: `2026-${major}-${minor}T10:00:00Z`,
    prerelease: false,
    draft: false,
    assets: [
      {
        name: `IDBOX-Setup-${version}.exe`,
        browser_download_url: `https://x/IDBOX-Setup-${version}.exe`
      }
    ],
    ...(body === undefined ? {} : { body }),
    ...over
  }
}

// ── ① 请求形态 ────────────────────────────────────────────────────────
describe('fetchMergedRelease — 请求形态', () => {
  it('走列表端点 + GitHub 头 + 超时信号；不带 Authorization', async () => {
    const { calls, fetcher } = recordingFetcher([rel('v1.2.0', '## 新增\n\n- 甲')])
    await fetchMergedRelease({ current: '1.0.0', fetcher })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(GITHUB_RELEASES_LIST_URL)
    expect(GITHUB_RELEASES_LIST_URL).toContain('per_page=100')
    expect(calls[0].init.headers.Accept).toBe('application/vnd.github+json')
    expect(calls[0].init.headers['User-Agent']).toBe('IDBOX/1.0.0')
    expect(Object.keys(calls[0].init.headers).map((k) => k.toLowerCase())).not.toContain(
      'authorization'
    )
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('current 带 v 前缀会被归一化', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', '- 甲')])
    const info = await fetchMergedRelease({ current: 'v1.0.0', fetcher })
    expect(info.current).toBe('1.0.0')
    expect(info.hasUpdate).toBe(true)
  })
})

// ── ② 过滤 ────────────────────────────────────────────────────────────
describe('fetchMergedRelease — 过滤不合规的 release', () => {
  it('prerelease / draft 被滤掉（不当成最新版，也不进正文）', async () => {
    const { fetcher } = recordingFetcher([
      rel('v2.0.0', '## 测试版内容', { prerelease: true }),
      rel('v1.9.0', '## 草稿内容', { draft: true }),
      rel('v1.5.0', '## 正式版\n\n- 甲的 '),
      rel('v1.2.0', '## 旧版\n\n- 乙')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.latest).toBe('1.5.0')
    expect(info.notes ?? '').not.toContain('测试版内容')
    expect(info.notes ?? '').not.toContain('草稿内容')
    expect(info.notes ?? '').toContain('v1.5.0')
  })

  it('tag 不是版本号（nightly / latest）被丢弃', async () => {
    const { fetcher } = recordingFetcher([
      rel('nightly', '## 每日构建'),
      rel('latest', '## 别名'),
      rel('v1.2.0', '## 正常\n\n- 甲')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.latest).toBe('1.2.0')
    expect(info.notes ?? '').not.toContain('每日构建')
    expect(info.notes ?? '').not.toContain('别名')
  })

  it('带预发布后缀的 tag（v1.3.0-beta.1）即使没打 prerelease 标记也不参与', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.3.0-beta.1', '## beta'),
      rel('v1.2.0', '## 正式\n\n- 甲')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.latest).toBe('1.2.0')
    expect(info.notes ?? '').not.toContain('beta')
  })

  it('重复 tag 只保留一条', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.2.0', '## 甲\n\n- 一'),
      rel('v1.2.0', '## 乙\n\n- 二')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect((info.notes ?? '').match(/v1\.2\.0/g) ?? []).toHaveLength(1)
  })
})

// ── ③ 区间与顺序 ──────────────────────────────────────────────────────
describe('fetchMergedRelease — 版本区间与顺序', () => {
  it('current 在中间：只合并 current 之后的两版，且降序', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.5.0', '## 五\n\n- E'),
      rel('v1.2.0', '## 二\n\n- B'),
      rel('v1.0.0', '## 一\n\n- A')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })

    expect(info.hasUpdate).toBe(true)
    expect(info.latest).toBe('1.5.0')
    const notes = info.notes ?? ''
    // 两个版块都在
    expect(notes).toContain('v1.5.0')
    expect(notes).toContain('v1.2.0')
    // current 自己（1.0.0）不进来
    expect(notes).not.toContain('v1.0.0')
    // 降序：1.5.0 在 1.2.0 前面
    expect(notes.indexOf('v1.5.0')).toBeLessThan(notes.indexOf('v1.2.0'))
    // 版块之间是一整行 `---`
    expect(notes).toMatch(/v1\.5\.0[\s\S]*\n---\n[\s\S]*v1\.2\.0/)
  })

  it('不信数组顺序：API 按 created_at 倒序，补发的老版本排在前面也不影响 latest', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.0.5', '## 补发\n\n- 热修'),
      rel('v1.5.0', '## 五\n\n- E'),
      rel('v1.2.0', '## 二\n\n- B')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.latest).toBe('1.5.0')
    const notes = info.notes ?? ''
    expect(notes.indexOf('v1.5.0')).toBeLessThan(notes.indexOf('v1.2.0'))
    expect(notes.indexOf('v1.2.0')).toBeLessThan(notes.indexOf('v1.0.5'))
  })

  it('current 已是最新：notes=null、hasUpdate=false、error=null', async () => {
    const { fetcher } = recordingFetcher([rel('v1.5.0', '## 五\n\n- E')])
    const info = await fetchMergedRelease({ current: '1.5.0', fetcher })
    expect(info.notes).toBeNull()
    expect(info.hasUpdate).toBe(false)
    expect(info.error).toBeNull()
    expect(info.latest).toBe('1.5.0')
  })

  it('本地版本更新（latest < current）：不降级，notes=null', async () => {
    const { fetcher } = recordingFetcher([rel('v1.0.0', '## 一\n\n- A')])
    const info = await fetchMergedRelease({ current: '1.5.0', fetcher })
    expect(info.hasUpdate).toBe(false)
    expect(info.notes).toBeNull()
  })

  it('url / assetUrl / publishedAt 取最新那一条（下载永远指向最新包）', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.5.0', '## 五', { published_at: '2026-11-25T10:00:00Z' }),
      rel('v1.2.0', '## 二', { published_at: '2026-11-01T10:00:00Z' })
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.url).toBe('https://github.com/chengcheng067/ID-BOX/releases/tag/v1.5.0')
    expect(info.assetUrl).toBe('https://x/IDBOX-Setup-1.5.0.exe')
    expect(info.publishedAt).toBe('2026-11-25T10:00:00Z')
  })

  it('没有任何说明时也给出占位人话，不留空块', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', undefined)])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.notes ?? '').toContain('这个版本没有写更新说明')
  })
})

// ── ④ 上限 ────────────────────────────────────────────────────────────
describe('fetchMergedRelease — 条数与总预算', () => {
  it('超过 10 个版本：只保留最新 10 个 + 末尾提示', async () => {
    const list: ReturnType<typeof rel>[] = []
    for (let i = 15; i >= 1; i -= 1) {
      list.push(rel(`v1.${i}.0`, `## 版本 ${i}\n\n- 内容 ${i}`))
    }
    const { fetcher } = recordingFetcher(list)
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    const notes = info.notes ?? ''

    expect(notes).toContain('还有更早的更新未展示')
    // 最新 10 个：1.15.0 ... 1.6.0；1.5.0 及更早不应出现为版头
    expect(notes).toContain('## v1.15.0')
    expect(notes).toContain('## v1.6.0')
    expect(notes).not.toContain('## v1.5.0')
    expect(notes).not.toContain('## v1.1.0')
    // 版头数量正好 10
    expect(notes.match(/^## v1\./gm) ?? []).toHaveLength(10)
  })

  it('总字符数不超过 MAX_NOTES_CHARS（这段要过 IPC，不能塞几十万字）', async () => {
    const list: ReturnType<typeof rel>[] = []
    // 10 个版本各 6000 字符 → 直接拼会远超 20000
    for (let i = 10; i >= 1; i -= 1) {
      list.push(rel(`v1.${i}.0`, `## 版本 ${i}\n\n${'正'.repeat(6_000)}`))
    }
    const { fetcher } = recordingFetcher(list)
    const info = await fetchMergedRelease({ current: '0.9.0', fetcher })
    const notes = info.notes ?? ''
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_CHARS)
    expect(notes).toContain('更早的更新说明已省略')
    // 最新那版必须保留（丢的是旧的，不是新的）
    expect(notes).toContain('## v1.10.0')
  })
})

// ── ⑤ 清洗 ────────────────────────────────────────────────────────────
describe('fetchMergedRelease — body 清洗（产出必须能被受限解析器吃下）', () => {
  const messy = [
    '## 新增',
    '',
    '- 支持 **HDR** 环境贴图',
    '',
    '> 这是一段引用，解析器不支持',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 值 1 | 值 2 |',
    '',
    '![截图](https://example.com/a.png)',
    '',
    '<img src="x" onerror="alert(1)">',
    '',
    '### 修复',
    '',
    '1. 第一条',
    '2. 第二条',
    '',
    '---',
    '',
    '结尾段落。'
  ].join('\n')

  it('引用行 / 表格行 / HTML 行被丢弃，图片换成纯文本', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', messy)])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    const notes = info.notes ?? ''

    expect(notes).not.toMatch(/^>/m)
    expect(notes).not.toMatch(/^\|/m)
    expect(notes).not.toContain('列 A')
    expect(notes).not.toContain('<img')
    expect(notes).not.toContain('onerror')
    expect(notes).not.toContain('![截图]')
    expect(notes).toContain('[图片已省略]')
    // 正常内容一个字都不能丢
    expect(notes).toContain('支持 **HDR** 环境贴图')
    expect(notes).toContain('结尾段落。')
  })

  it('小标题降一级：正文 `## 新增` → `### 新增`，与原 `### 修复` 分档', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', messy)])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    const notes = info.notes ?? ''

    expect(notes).toContain('### 新增')
    // 行首断言（不能用 toContain：`### 新增` 里也含 `## 新增` 这段子串）
    expect(notes).not.toMatch(/^## 新增$/m)
    expect(notes).toContain('#### 修复')
    // 原 `### 修复` 也确实被推到 4 级（不能只推 `##`）
    expect(notes).not.toMatch(/^### 修复$/m)
    // 版头仍是二级（`## v1.2.0`），不与正文混淆
    expect(notes).toMatch(/^## v1\.2\.0/m)
  })

  it('产出能被 parseReleaseNotes 完整解析：heading / list / rule 都在', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.5.0', messy),
      rel('v1.2.0', '## 旧版\n\n- 甲\n- 乙')
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    const blocks = parseReleaseNotes(info.notes)

    const headings = blocks.filter((b) => b.type === 'heading')
    // 版头 2 条 + 正文（新增 / 修复 / 旧版）3 条
    expect(headings.length).toBeGreaterThanOrEqual(4)
    expect(headings[0]).toEqual({ type: 'heading', level: 2, text: 'v1.5.0 · 2026-01-05' })
    expect(blocks.some((b) => b.type === 'list')).toBe(true)
    expect(blocks.some((b) => b.type === 'rule')).toBe(true)
    // 不允许把表格/引用当段落漏出来
    const paragraphs = blocks
      .filter((b): b is { type: 'paragraph'; text: string } => b.type === 'paragraph')
      .map((b) => b.text)
    expect(paragraphs.some((t) => t.includes('列 A'))).toBe(false)
    expect(paragraphs.some((t) => t.startsWith('>'))).toBe(false)
  })

  it('没有日期时版头只写版本号', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', '## 甲', { published_at: null })])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.notes ?? '').toMatch(/^## v1\.2\.0$/m)
  })

  it('清洗后什么都不剩的版本 → 占位文案（不留空块）', async () => {
    const { fetcher } = recordingFetcher([rel('v1.2.0', '> 只有引用\n\n| a | b |\n| --- | --- |')])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.notes ?? '').toContain('这个版本没有写更新说明')
  })
})

// ── ⑥ 错误收口（枚举值不新增） ────────────────────────────────────────
describe('fetchMergedRelease — 失败路径（永不抛错）', () => {
  it('无 fetch 能力 → network', async () => {
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher: null })
    expect(info.error).toBe('network')
    expect(info.notes).toBeNull()
  })

  it('网络抛错 → network；HTTP 404 → http；非数组 → parse', async () => {
    const throwing = async () => {
      throw new Error('ENOTFOUND api.github.com')
    }
    expect((await fetchMergedRelease({ current: '1.0.0', fetcher: throwing })).error).toBe('network')

    const http404 = async () => fakeResponse({ message: 'Not Found' }, false, 404)
    expect((await fetchMergedRelease({ current: '1.0.0', fetcher: http404 })).error).toBe('http')

    const notArray = async () => fakeResponse({ message: 'whatever' })
    expect((await fetchMergedRelease({ current: '1.0.0', fetcher: notArray })).error).toBe('parse')

    const badJson = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected token')
      }
    })
    expect((await fetchMergedRelease({ current: '1.0.0', fetcher: badJson })).error).toBe('parse')
  })

  it('列表为空（仓库还没发过正式版）→ 无更新，不是错误', async () => {
    const { fetcher } = recordingFetcher([])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.error).toBeNull()
    expect(info.hasUpdate).toBe(false)
    expect(info.notes).toBeNull()
  })

  it('全是 draft / prerelease → 无更新，不是错误', async () => {
    const { fetcher } = recordingFetcher([
      rel('v1.2.0', '## x', { prerelease: true }),
      rel('v1.3.0', '## y', { draft: true })
    ])
    const info = await fetchMergedRelease({ current: '1.0.0', fetcher })
    expect(info.error).toBeNull()
    expect(info.hasUpdate).toBe(false)
  })
})