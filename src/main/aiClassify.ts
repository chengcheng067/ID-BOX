/**
 * 用户自接模型 API 辅助分类（2026-10-19，docs/15 §7 用户拍板口径）。
 *
 * ── 口径（照做，不做扩展）──────────────────────────────────────────────
 * 1. **词表优先 + 模型兜底**：只在 `autoClassify()` 完全命中不了
 *    （资产落 `未分类/未分类`）时才调用；**不内置任何模型**，地址/密钥/模型名由用户填写，
 *    默认关闭 → 安装包体积零增长。
 * 2. **只在主进程发请求**：渲染进程受 CORS / CSP 限制，这里用 Node 侧 `fetch`
 *    （测试通过 `fetchImpl` 注入桩，**不做真实网络调用**）。
 * 3. **绝不覆盖已有分类**：本模块只产出建议，调用方（渲染层 store）只对
 *    `未分类/未分类` 的资产调用既有 `assignCategory`。
 * 4. **失败静默降级**：任何网络 / HTTP / 解析 / 超时失败 → 该批全部 null，
 *    只在返回值里报 `failedNames` + `error`，**不抛错、不弹错误对话框**。
 * 5. **结果强校验**（防模型瞎编的关键闸门）：`category1` 必须是词表一级键，
 *    `category2` 必须是该一级下的词条（或哨兵 `未分类`），**校验不过一律丢弃**。
 *
 * 词表纪律：`LEVEL2_MAP` 是**唯一权威**，本模块只读不写、不复制词表副本
 * （prompt 里的级联词表由 `LEVEL2_MAP` 现算，词表更新自动生效）。
 */

import { LEVEL2_MAP, UNCLASSIFIED } from '../shared/taxonomy'
import type {
  AiClassifyBatchResult,
  AiClassifyItem,
  AiClassifySettings,
  AiClassifyTestResult
} from '../shared/types'

/** 每次请求最多携带的资产名个数（prompt 里要注入完整词表，批量过大会挤压上下文） */
export const AI_CLASSIFY_BATCH_SIZE = 20

/** 整批总超时：超过即放弃剩余批次（用户等待感知上限 60s） */
export const AI_CLASSIFY_TOTAL_TIMEOUT_MS = 60_000

/** 单次 HTTP 请求超时（不超过总预算） */
export const AI_CLASSIFY_REQUEST_TIMEOUT_MS = 30_000

/** 单个 IPC 调用最多接受的名字数（防御性上限，渲染层按 20 个一批调用） */
export const AI_CLASSIFY_MAX_NAMES = 200

/** 词表形状（`LEVEL2_MAP` 的只读视图；测试可注入替身验证「按注入词表校验」） */
export type AiTaxonomy = Readonly<Record<string, readonly string[]>>

/** `fetch` 的最小签名（注入桩用，避免依赖具体实现） */
export type AiClassifyFetch = (url: string, init: RequestInit) => Promise<Response>

/** 一条已通过校验的分类结论 */
export type AiClassifyDecision = AiClassifyItem

export interface AiClassifyInput {
  names: readonly string[]
  settings: AiClassifySettings
  /** 词表；默认 `LEVEL2_MAP`（生产路径不传） */
  taxonomy?: AiTaxonomy
  /** fetch 实现；默认全局 `fetch`（测试注入桩） */
  fetchImpl?: AiClassifyFetch
  batchSize?: number
  totalTimeoutMs?: number
  requestTimeoutMs?: number
}

/** 富信息返回值（IPC 用）：`items` 之外还带「整批失败」的名字，供 notice 区分未识别/失败 */
export interface AiClassifyRunResult extends AiClassifyBatchResult {
  /** 实际发出的 HTTP 请求次数（诊断/测试用） */
  requestCount: number
}

// ── Prompt（内置常量）────────────────────────────────────────────────

/**
 * 构造分类 prompt：**完整注入**一级 40 组 + 其级联二级词表（从 `LEVEL2_MAP` 现算）。
 *
 * 四条硬要求（docs/15 §7）：
 * ① 任务是「把资产名归到给定分类体系中的某一个二级分类」；
 * ② 明确要求**只输出 JSON 数组**，元素形如 `{"name":"...","category1":"...","category2":"..."}`，
 *    无法判断的位置输出 `null`；
 * ③ 明确**禁止编造**词表里没有的类目名（编造的结果在解析侧也会被丢弃，双保险）；
 * ④ 强调「词表优先」语义：宁可返回 null，也不要猜。
 */
export function buildAiClassifyPrompt(taxonomy: AiTaxonomy = LEVEL2_MAP): string {
  const lines: string[] = []
  for (const [level1, level2List] of Object.entries(taxonomy)) {
    lines.push(`- ${level1}：${level2List.join('、')}`)
  }
  return [
    '你是 3D 素材库的分类助手。任务：把每个资产名（3D 模型 / 贴图 / 材质的文件名或文件夹名）',
    '归入下面给定分类体系中的**某一个二级分类**。',
    '',
    '【分类体系】一级分类：其级联的二级分类（完整词表）',
    lines.join('\n'),
    '',
    '【硬性规则】',
    '1. category1 必须是上面列出的某个一级分类名；category2 必须是该一级分类下**确实列出**的某个二级分类名。',
    '2. 严禁编造词表中不存在的类目名（不要自创、不要翻译、不要改写同义词、不要添加「其他」以外的未列出项）。',
    '3. 如果资产名信息不足、或无法确定地归入某个二级分类，该条必须输出 null —— 宁可不判，也不要猜。',
    '4. 只输出一个 JSON 数组，不要输出任何解释文字，不要使用 Markdown 代码围栏。',
    '5. 数组元素格式：{"name":"<输入中的资产名原文>","category1":"<一级>","category2":"<二级>"}；无法判断的元素写 null。',
    '6. 输出数组的长度与顺序必须与输入资产名数组**一一对应**（每个输入名占一个位置）。',
    '',
    '【输出示例】',
    '[{"name":"北欧白蜡木餐椅3d模型","category1":"家具","category2":"椅子/凳子"},null]'
  ].join('\n')
}

// ── HTTP 细节 ────────────────────────────────────────────────────────

/**
 * 拼 chat completions 地址：
 * - `https://api.xxx.com/v1` → `https://api.xxx.com/v1/chat/completions`
 * - 已带 `/chat/completions` → 原样使用（兼容用户直接粘贴完整地址）
 * - 空串 → 空串（调用方据此跳过请求）
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (!base) return ''
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/** 把异常压成一句人话（不泄漏密钥；超时单独识别） */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return '请求超时'
    return err.message || err.name
  }
  return String(err)
}

/** 读取响应体里的错误片段（截断，避免把整页 HTML 塞进 notice） */
async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text()
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
  } catch {
    return ''
  }
}

/** 从 OpenAI 兼容响应里取文本内容（`message.content` 字符串或分段数组 / `choice.text`） */
export function readChatContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return null
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = (choice as { message?: unknown }).message
    if (message && typeof message === 'object') {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string' && content.trim()) return content
      if (Array.isArray(content)) {
        const joined = content
          .map((part) => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object') {
              const text = (part as { text?: unknown }).text
              if (typeof text === 'string') return text
            }
            return ''
          })
          .join('')
        if (joined.trim()) return joined
      }
    }
    const text = (choice as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text
  }
  return null
}

// ── 解析（宽容）──────────────────────────────────────────────────────

/**
 * 从（可能很脏的）模型输出里截取**第一个括号配平的 JSON 数组字面量**。
 *
 * 不能用「首个 `[` 到末个 `]`」：模型可能在数组后面再补一段解释（`[..]` 之后又有 `[注]`），
 * 那样切片会跨段。这里做最小扫描：从首个 `[` 起跟踪深度，正确处理字符串与转义。
 */
export function sliceFirstJsonArray(text: string): string | null {
  if (typeof text !== 'string') return null
  const start = text.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[') {
      depth += 1
      continue
    }
    if (ch === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/**
 * 在文本里找出**第一个可以 JSON.parse 成数组**的括号配平片段。
 *
 * 为什么要循环而不是只取首个 `[`：模型常在数组前写一句带方括号的解释
 * （`分析：以下结果 [仅供参考]\n[{...}]`），首个 `[` 落在那句解释里，
 * 只试一次会整批失败。这里逐个 `[` 起点重试，代价可忽略（输出通常 < 4KB）。
 */
function findJsonArray(text: string): unknown[] | null {
  let from = 0
  while (from < text.length) {
    const start = text.indexOf('[', from)
    if (start < 0) return null
    const sliced = sliceFirstJsonArray(text.slice(start))
    if (!sliced) {
      from = start + 1
      continue
    }
    const parsed = tryParseArray(sliced)
    if (parsed) return parsed
    from = start + 1
  }
  return null
}

/**
 * 宽容解析模型输出 → 数组（原始元素，未校验）。
 *
 * 依次尝试：① ```json 围栏内的内容；② 整段文本。任一候选里找出可解析的 JSON 数组。
 * 全部失败返回 `null`（调用方据此判定「该批失败」）。
 */
export function parseAiClassifyContent(content: string): unknown[] | null {
  if (typeof content !== 'string' || !content.trim()) return null
  const candidates: string[] = []
  const fenceRe = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null = fenceRe.exec(content)
  while (match !== null) {
    const inner = match[1]
    if (inner && inner.trim()) candidates.push(inner)
    match = fenceRe.exec(content)
  }
  candidates.push(content)

  for (const candidate of candidates) {
    const parsed = findJsonArray(candidate)
    if (parsed) return parsed
  }
  return null
}

function tryParseArray(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// ── 校验（关键闸门）──────────────────────────────────────────────────

/**
 * 单条校验：**词表之外的一切类目名都丢弃**。
 *
 * - `category1` 必须是 taxonomy 的自有键（`hasOwnProperty`，避免 `toString` 之类原型键）；
 * - `category2` 必须属于该一级的级联列表，或哨兵 `未分类`；
 * - `name` 只用于对齐，最终以**入参名字**为准（模型可能改写大小写/空白）。
 */
export function validateDecision(
  raw: unknown,
  taxonomy: AiTaxonomy = LEVEL2_MAP
): AiClassifyItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  const category1 = typeof rec.category1 === 'string' ? rec.category1.trim() : ''
  const category2 = typeof rec.category2 === 'string' ? rec.category2.trim() : ''
  if (!name || !category1 || !category2) return null
  if (!Object.prototype.hasOwnProperty.call(taxonomy, category1)) return null
  const allowed = taxonomy[category1] ?? []
  if (category2 !== UNCLASSIFIED && !allowed.includes(category2)) return null
  return { name, category1, category2 }
}

/**
 * 按**名字**把模型输出对齐到入参名字序列：等长同序，缺失 → `null`。
 *
 * 同名重复（不同大类下可能有同名资产）按模型输出顺序依次消费，不会把两条结论给同一资产。
 * 模型多返回的、名字对不上的元素一律忽略。
 */
export function alignDecisions(
  names: readonly string[],
  parsed: readonly unknown[],
  taxonomy: AiTaxonomy = LEVEL2_MAP
): Array<AiClassifyItem | null> {
  const queues = new Map<string, AiClassifyItem[]>()
  for (const raw of parsed) {
    const decision = validateDecision(raw, taxonomy)
    if (!decision) continue
    const queue = queues.get(decision.name) ?? []
    queue.push(decision)
    queues.set(decision.name, queue)
  }
  return names.map((name) => {
    const key = typeof name === 'string' ? name.trim() : ''
    const queue = queues.get(key)
    if (!queue || queue.length === 0) return null
    const decision = queue.shift()!
    // 落回**入参原文**（含首尾空白也保留原样返回，调用方按 id 匹配，不依赖名字）
    return { ...decision, name }
  })
}

// ── 请求 ─────────────────────────────────────────────────────────────

interface BatchOutcome {
  decisions: Array<AiClassifyItem | null>
  error: string | null
}

/**
 * 发一批（≤ batchSize 个名字）请求并解析。
 * **本函数永不抛**：任何失败 → 该批全 null + 错误文案。
 */
async function requestOneBatch(
  names: readonly string[],
  settings: AiClassifySettings,
  options: {
    taxonomy: AiTaxonomy
    fetchImpl: AiClassifyFetch
    timeoutMs: number
  }
): Promise<BatchOutcome> {
  const empty: BatchOutcome = {
    decisions: names.map(() => null),
    error: null
  }
  const url = chatCompletionsUrl(settings.baseUrl)
  if (!url) return { ...empty, error: '未配置接口地址' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs))
  try {
    const res = await options.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authorizationHeaders(settings.apiKey)
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: buildAiClassifyPrompt(options.taxonomy) },
          { role: 'user', content: JSON.stringify(names) }
        ]
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const snippet = await readErrorSnippet(res)
      return {
        ...empty,
        error: snippet ? `HTTP ${res.status}：${snippet}` : `HTTP ${res.status}`
      }
    }

    let payload: unknown
    try {
      payload = (await res.json()) as unknown
    } catch {
      return { ...empty, error: '响应不是合法 JSON' }
    }

    const content = readChatContent(payload)
    if (!content) return { ...empty, error: '响应缺少 choices[0].message.content' }

    const parsed = parseAiClassifyContent(content)
    if (!parsed) return { ...empty, error: '模型输出里没有可解析的 JSON 数组' }

    return { decisions: alignDecisions(names, parsed, options.taxonomy), error: null }
  } catch (err) {
    return { ...empty, error: errorMessageOf(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 核心实现：分批 + 串行 + 总超时。返回值带 `failedNames`（区分未识别 vs 请求失败）。
 *
 * 串行（而非并发）的理由：用户自接的服务多为单机 / 限流额度，并发只会放大 429；
 * 且分类不是交互路径，慢一点无感。
 */
export async function aiClassifyDetailed(input: AiClassifyInput): Promise<AiClassifyRunResult> {
  const taxonomy = input.taxonomy ?? LEVEL2_MAP
  const batchSize = Math.max(1, Math.min(input.batchSize ?? AI_CLASSIFY_BATCH_SIZE, AI_CLASSIFY_MAX_NAMES))
  const totalTimeoutMs = Math.max(1, input.totalTimeoutMs ?? AI_CLASSIFY_TOTAL_TIMEOUT_MS)
  const requestTimeoutMs = Math.max(1, input.requestTimeoutMs ?? AI_CLASSIFY_REQUEST_TIMEOUT_MS)
  const fetchImpl: AiClassifyFetch =
    input.fetchImpl ?? ((url, init) => fetch(url, init))

  // 入参顺序/长度原样保留：空名字与超量名字都占位为 null
  const items: Array<AiClassifyItem | null> = input.names.map(() => null)
  const failedNames: string[] = []
  let error: string | null = null
  let requestCount = 0

  const settings = input.settings
  // 未配置 = 不发请求（不算失败，避免把「用户没填」显示成「全部失败」）
  if (!chatCompletionsUrl(settings.baseUrl) || !settings.model.trim()) {
    return { items, failedNames, error: null, requestCount }
  }

  // 只处理非空名字，但保留其原始下标
  const indices: number[] = []
  input.names.forEach((name, index) => {
    if (typeof name === 'string' && name.trim()) indices.push(index)
  })
  if (indices.length === 0) return { items, failedNames, error: null, requestCount }

  const deadline = Date.now() + totalTimeoutMs
  for (let offset = 0; offset < indices.length; offset += batchSize) {
    const chunk = indices.slice(offset, offset + batchSize)
    const names = chunk.map((i) => input.names[i]!)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // 总超时：剩余全部计为失败（用户等待上限已到，不再发请求）
      failedNames.push(...names)
      error = error ?? '总超时（60s）已到，放弃剩余批次'
      continue
    }
    requestCount += 1
    const outcome = await requestOneBatch(names, settings, {
      taxonomy,
      fetchImpl,
      timeoutMs: Math.min(requestTimeoutMs, remaining)
    })
    if (outcome.error !== null) {
      failedNames.push(...names)
      error = outcome.error
      continue
    }
    chunk.forEach((itemIndex, i) => {
      items[itemIndex] = outcome.decisions[i] ?? null
    })
  }

  return { items, failedNames, error, requestCount }
}

/**
 * 规格口径的薄封装：只返回与入参等长同序的结论数组（`null` = 未识别 / 失败）。
 * 需要区分「失败」时用 `aiClassifyDetailed`。
 */
export async function aiClassifyNames(
  input: AiClassifyInput
): Promise<Array<AiClassifyItem | null>> {
  const result = await aiClassifyDetailed(input)
  return result.items
}

// ── 测试连接 ─────────────────────────────────────────────────────────

/**
 * 「测试连接」：发一条**最小**请求（不注入词表、不分类），回报成功 / 失败原因。
 *
 * 用于设置页即时反馈（如 401 密钥错、404 路径错、模型名不存在）。
 * 不要求 `enabled` 为真：用户通常是先测通再打开开关。
 * 任何异常都转成 `{ ok:false, message }`，**不抛错**。
 */
export async function testAiConnection(
  settings: AiClassifySettings,
  options?: { fetchImpl?: AiClassifyFetch; timeoutMs?: number }
): Promise<AiClassifyTestResult> {
  const url = chatCompletionsUrl(settings.baseUrl)
  if (!url) return { ok: false, message: '请先填写接口地址（例如 https://api.openai.com/v1）' }
  if (!settings.model.trim()) return { ok: false, message: '请先填写模型名（例如 gpt-4o-mini）' }

  const fetchImpl: AiClassifyFetch = options?.fetchImpl ?? ((u, init) => fetch(u, init))
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, options?.timeoutMs ?? AI_CLASSIFY_REQUEST_TIMEOUT_MS)
  )
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authorizationHeaders(settings.apiKey)
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: '只回复 OK' }]
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const snippet = await readErrorSnippet(res)
      return {
        ok: false,
        message: snippet ? `HTTP ${res.status}：${snippet}` : `HTTP ${res.status}`
      }
    }
    let payload: unknown
    try {
      payload = (await res.json()) as unknown
    } catch {
      return { ok: false, message: '服务有响应，但返回的不是 JSON（请确认地址是 OpenAI 兼容接口）' }
    }
    const content = readChatContent(payload)
    if (!content) {
      return { ok: false, message: '服务已连通，但响应里没有文本内容（请检查模型名）' }
    }
    return { ok: true, message: `连接成功（模型：${settings.model}）` }
  } catch (err) {
    return { ok: false, message: `请求失败：${errorMessageOf(err)}` }
  } finally {
    clearTimeout(timer)
  }
}
