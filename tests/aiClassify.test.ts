/**
 * AI 辅助分类（docs/15 §7，2026-10-19）纯逻辑单测。
 *
 * 覆盖口径里的六条硬要求：
 * ① prompt 注入完整一级 + 级联二级词表，并要求只输出 JSON 数组；
 * ② 解析裸 JSON 数组；③ 解析 ```json 围栏；
 * ④ 编造的一级被丢弃（防模型瞎编的关键闸门）；
 * ⑤ category2 不属于该 category1 时丢弃；
 * ⑥ 模型返回条数与入参不匹配时按名字对齐、缺失算 null。
 *
 * **不做真实网络调用**：所有请求都经注入的 `fetchImpl` 桩（不发一个字节出去）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AI_CLASSIFY_BATCH_SIZE,
  aiClassifyDetailed,
  aiClassifyNames,
  alignDecisions,
  buildAiClassifyPrompt,
  chatCompletionsUrl,
  parseAiClassifyContent,
  testAiConnection,
  validateDecision
} from '../src/main/aiClassify'
import { DEFAULT_SETTINGS, type AiClassifySettings } from '../src/shared/types'
import { normalizeAiClassify, normalizeSettings } from '../src/main/settings'
import { LEVEL2_MAP } from '../src/shared/taxonomy'

// ── 桩工具 ────────────────────────────────────────────────────────────

const SETTINGS: AiClassifySettings = {
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model'
}

/** OpenAI 兼容的成功响应 */
function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** 取请求体里 user 消息（= 本批名字数组） */
function namesOfBody(init: RequestInit): string[] {
  const body = JSON.parse(String(init.body)) as {
    messages: Array<{ role: string; content: string }>
  }
  const user = body.messages.find((m) => m.role === 'user')
  return JSON.parse(user?.content ?? '[]') as string[]
}

/** 断言用：抓到的一次请求 */
interface Call {
  url: string
  auth: string | undefined
  names: string[]
  system: string
}

function makeFetch(handler: (names: string[]) => Response): {
  impl: (url: string, init: RequestInit) => Promise<Response>
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>
    }
    const names = namesOfBody(init)
    calls.push({
      url,
      auth: (init.headers as Record<string, string> | undefined)?.['Authorization'],
      names,
      system: body.messages.find((m) => m.role === 'system')?.content ?? ''
    })
    return handler(names)
  }
  return { impl, calls }
}

// ── ① prompt ─────────────────────────────────────────────────────────

describe('prompt 构造（词表必须来自 LEVEL2_MAP，不许手写副本）', () => {
  const prompt = buildAiClassifyPrompt()

  it('注入一级分类与其级联二级词条', () => {
    // 一级：模型频道 + 贴图频道各取若干
    expect(prompt).toContain('家装')
    expect(prompt).toContain('石材')
    expect(prompt).toContain('商业元素')
    // 二级（级联于对应一级）
    expect(prompt).toContain('客厅')
    expect(prompt).toContain('椅子/凳子')
    expect(prompt).toContain('水磨石')
    // 40 组一级全部出现（键空间即 LEVEL2_MAP）
    for (const level1 of Object.keys(LEVEL2_MAP)) {
      expect(prompt).toContain(`- ${level1}：`)
    }
  })

  it('明确要求只输出 JSON 数组 + 无法判断输出 null + 禁止编造类目', () => {
    expect(prompt).toContain('JSON 数组')
    expect(prompt).toContain('null')
    expect(prompt).toContain('严禁编造')
    expect(prompt).toContain('"category1"')
    expect(prompt).toContain('"category2"')
    // 要求顺序/长度与输入一一对应（对齐语义写进 prompt）
    expect(prompt).toContain('一一对应')
  })

  it('词表更新自动生效（注入替身词表时只出现替身词条）', () => {
    const custom = buildAiClassifyPrompt({ 测试一级: ['测试二级甲', '测试二级乙'] })
    expect(custom).toContain('- 测试一级：测试二级甲、测试二级乙')
    expect(custom).not.toContain('- 家装：')
  })
})

// ── ②③ 解析 ──────────────────────────────────────────────────────────

describe('宽容解析模型输出', () => {
  const expected = [{ name: '北欧餐椅', category1: '家具', category2: '椅子/凳子' }]

  it('裸 JSON 数组', () => {
    expect(parseAiClassifyContent(JSON.stringify(expected))).toEqual(expected)
  })

  it('```json 围栏包裹', () => {
    const content = '好的，结果如下：\n```json\n' + JSON.stringify(expected) + '\n```\n以上。'
    expect(parseAiClassifyContent(content)).toEqual(expected)
  })

  it('前后带解释文字 + 解释里有方括号也能找到真正的数组', () => {
    const content = `分析：这些名字属于家具类 [注意：仅供参考]\n${JSON.stringify(expected)}\n以上。`
    expect(parseAiClassifyContent(content)).toEqual(expected)
  })

  it('含 null 元素与多余逗号外的正常数组', () => {
    expect(parseAiClassifyContent('[null,{"name":"a","category1":"家具","category2":"沙发"}]')).toEqual([
      null,
      { name: 'a', category1: '家具', category2: '沙发' }
    ])
  })

  it('彻底不是 JSON → null（该批判失败，不抛错）', () => {
    expect(parseAiClassifyContent('抱歉，我无法完成该任务。')).toBeNull()
    expect(parseAiClassifyContent('')).toBeNull()
  })
})

// ── ④⑤⑥ 校验与对齐 ──────────────────────────────────────────────────

describe('结果强校验（防模型瞎编的关键闸门）', () => {
  it('④ 编造的一级分类被丢弃 → null', () => {
    expect(
      validateDecision({ name: 'x', category1: '不存在的一级', category2: '沙发' })
    ).toBeNull()
    expect(
      alignDecisions(
        ['x'],
        [{ name: 'x', category1: '不存在的一级', category2: '沙发' }]
      )
    ).toEqual([null])
  })

  it('⑤ category2 不属于该 category1 时丢弃（跨类组合非法）', () => {
    // 「水磨石」是 石材 下的二级，不是 家具 下的
    expect(validateDecision({ name: 'x', category1: '家具', category2: '水磨石' })).toBeNull()
    expect(validateDecision({ name: 'x', category1: '石材', category2: '水磨石' })).toEqual({
      name: 'x',
      category1: '石材',
      category2: '水磨石'
    })
  })

  it('词表外的二级、空字段、非对象元素一律丢弃；哨兵「未分类」放行', () => {
    expect(validateDecision({ name: 'x', category1: '家具', category2: '编造的二级' })).toBeNull()
    expect(validateDecision({ name: '', category1: '家具', category2: '沙发' })).toBeNull()
    expect(validateDecision(null)).toBeNull()
    expect(validateDecision('nope')).toBeNull()
    expect(validateDecision({ name: 'x', category1: '家具', category2: '未分类' })).toEqual({
      name: 'x',
      category1: '家具',
      category2: '未分类'
    })
  })

  it('⑥ 条数不匹配 → 按名字对齐，缺失的算 null，多余的忽略', () => {
    const parsed = [
      { name: 'B', category1: '家具', category2: '沙发' },
      { name: '不存在的名字', category1: '家具', category2: '床具' }
    ]
    const aligned = alignDecisions(['A', 'B', 'C'], parsed)
    expect(aligned).toEqual([null, { name: 'B', category1: '家具', category2: '沙发' }, null])
  })

  it('⑥ 同名重复（不同大类的同名资产）按顺序消费，不重复给同一条', () => {
    const parsed = [
      { name: '台灯', category1: '灯具', category2: '台灯' },
      { name: '台灯', category1: '软装陈设', category2: '花艺' }
    ]
    expect(alignDecisions(['台灯', '台灯'], parsed)).toEqual([
      { name: '台灯', category1: '灯具', category2: '台灯' },
      { name: '台灯', category1: '软装陈设', category2: '花艺' }
    ])
  })
})

// ── 端到端（注入 fetch 桩，零真实网络） ────────────────────────────────

describe('aiClassifyDetailed（分批 + 串行 + 失败降级）', () => {
  it('按 20 个一批切分，请求间串行（不并发打用户的服务）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const calls: number[] = []
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const names = namesOfBody(init)
      calls.push(names.length)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return chatResponse(
        JSON.stringify(names.map((name) => ({ name, category1: '家具', category2: '沙发' })))
      )
    }

    const names = Array.from({ length: AI_CLASSIFY_BATCH_SIZE + 5 }, (_, i) => `资产${i}`)
    const result = await aiClassifyDetailed({ names, settings: SETTINGS, fetchImpl })

    expect(result.requestCount).toBe(2)
    expect(calls).toEqual([AI_CLASSIFY_BATCH_SIZE, 5])
    expect(maxInFlight).toBe(1)
    expect(result.items.every((it) => it?.category1 === '家具')).toBe(true)
    expect(result.failedNames).toEqual([])
  })

  it('请求使用 baseUrl + /chat/completions，并带 Bearer 密钥与 system prompt', async () => {
    const { impl, calls } = makeFetch((names) =>
      chatResponse(JSON.stringify(names.map((name) => ({ name, category1: '家具', category2: '沙发' }))))
    )
    const apiKey = 'sk-test'
    const settings: AiClassifySettings = { ...SETTINGS, apiKey }
    await aiClassifyNames({ names: ['北欧餐椅'], settings, fetchImpl: impl })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0]!.auth).toBe(`Bearer ${apiKey}`)
    expect(calls[0]!.system).toContain('JSON 数组')
    expect(calls[0]!.names).toEqual(['北欧餐椅'])
  })

  it('baseUrl 已带 /chat/completions 时不重复拼接', () => {
    expect(chatCompletionsUrl('https://x.com/v1/chat/completions')).toBe(
      'https://x.com/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://x.com/v1/')).toBe('https://x.com/v1/chat/completions')
    expect(chatCompletionsUrl('')).toBe('')
  })

  it('模型返回编造的类目 → 该条为 null（不会把资产搬进不存在的目录）', async () => {
    const fetchImpl = async (): Promise<Response> =>
      chatResponse(JSON.stringify([{ name: '北欧餐椅', category1: '瞎编大类', category2: '瞎编二级' }]))
    const result = await aiClassifyNames({
      names: ['北欧餐椅'],
      settings: SETTINGS,
      fetchImpl
    })
    expect(result).toEqual([null])
  })

  it('HTTP 失败 → 该批全部 null + failedNames 记录 + 不抛错', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"error":"invalid api key"}', { status: 401 })
    const result = await aiClassifyDetailed({
      names: ['A', 'B'],
      settings: SETTINGS,
      fetchImpl
    })
    expect(result.items).toEqual([null, null])
    expect(result.failedNames).toEqual(['A', 'B'])
    expect(result.error).toContain('401')
    expect(result.error).toContain('invalid api key')
  })

  it('网络异常（fetch reject）→ 静默降级，不冒泡', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('ECONNREFUSED')
    }
    const result = await aiClassifyDetailed({
      names: ['A'],
      settings: SETTINGS,
      fetchImpl
    })
    expect(result.items).toEqual([null])
    expect(result.failedNames).toEqual(['A'])
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('未配置（无 baseUrl / 无模型名）→ 零请求、零失败（算「未识别」）', async () => {
    const spy = vi.fn()
    const result = await aiClassifyDetailed({
      names: ['A'],
      settings: { ...SETTINGS, baseUrl: '', model: '' },
      fetchImpl: spy
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.requestCount).toBe(0)
    expect(result.items).toEqual([null])
    expect(result.failedNames).toEqual([])
  })

  it('空名字不发请求，并保留原始下标对齐', async () => {
    const { impl, calls } = makeFetch((names) =>
      chatResponse(JSON.stringify(names.map((name) => ({ name, category1: '家具', category2: '沙发' }))))
    )
    const result = await aiClassifyDetailed({
      names: ['', '北欧餐椅', '   '],
      settings: SETTINGS,
      fetchImpl: impl
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.names).toEqual(['北欧餐椅'])
    expect(result.items).toEqual([null, { name: '北欧餐椅', category1: '家具', category2: '沙发' }, null])
  })
})

// ── 测试连接 ─────────────────────────────────────────────────────────

describe('testAiConnection（设置页「测试连接」）', () => {
  it('成功时返回 ok + 模型名', async () => {
    const fetchImpl = async (): Promise<Response> => chatResponse('OK')
    const r = await testAiConnection(SETTINGS, { fetchImpl })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('test-model')
  })

  it('缺少地址 / 模型名 → 直接给可行动提示，不发请求', async () => {
    const spy = vi.fn()
    expect((await testAiConnection({ ...SETTINGS, baseUrl: '' }, { fetchImpl: spy })).ok).toBe(false)
    expect((await testAiConnection({ ...SETTINGS, model: '' }, { fetchImpl: spy })).ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('HTTP 401 → ok:false 且带状态码', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('unauthorized', { status: 401 })
    const r = await testAiConnection(SETTINGS, { fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('401')
  })
})

// ── 设置归一化（脏字段不能丢整份设置） ─────────────────────────────────

describe('aiClassify 设置归一化', () => {
  it('默认值：关闭 + 三个空串（安装包不内置任何模型）', () => {
    expect(DEFAULT_SETTINGS.aiClassify).toEqual({
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: ''
    })
  })

  it('旧档缺 aiClassify → 补默认关闭', () => {
    const s = normalizeSettings({ libraryDir: 'E:\\ModVault\\Library' })
    expect(s.aiClassify).toEqual(DEFAULT_SETTINGS.aiClassify)
  })

  it('单个脏字段只降级该字段，其余配置（尤其密钥）保留', () => {
    const s = normalizeSettings({
      libraryDir: 'E:\\ModVault\\Library',
      aiClassify: {
        enabled: 'yes' as unknown as boolean,
        baseUrl: '  https://api.example.com/v1  ',
        apiKey: 'sk-keep-me',
        model: 'gpt-4o-mini'
      }
    })
    expect(s.aiClassify.enabled).toBe(false) // 只认严格 true
    expect(s.aiClassify.baseUrl).toBe('https://api.example.com/v1') // 去空白
    expect(s.aiClassify.apiKey).toBe('sk-keep-me')
    expect(s.aiClassify.model).toBe('gpt-4o-mini')
    expect(s.libraryDir).toBe('E:\\ModVault\\Library') // 整份设置没被丢弃
  })

  it('aiClassify 整块脏值（字符串/null）→ 回落默认，且不拖垮整份设置', () => {
    const s = normalizeSettings({
      libraryDir: 'E:\\ModVault\\Library',
      aiClassify: 'garbage' as unknown as AiClassifySettings
    })
    expect(s.aiClassify).toEqual(DEFAULT_SETTINGS.aiClassify)
    expect(s.libraryDir).toBe('E:\\ModVault\\Library')
  })

  it('normalizeAiClassify 对 null / 非对象输入不抛错', () => {
    expect(normalizeAiClassify(null)).toEqual({
      enabled: false,
      baseUrl: '',
      apiKey: '',
      model: ''
    })
    expect(
      normalizeAiClassify({ baseUrl: 123 as unknown as string, enabled: true })
    ).toEqual({ enabled: true, baseUrl: '', apiKey: '', model: '' })
  })
})
