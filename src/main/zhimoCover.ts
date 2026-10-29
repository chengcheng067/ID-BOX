/**
 * 知末封面抓取核心（docs/24 §3.3，T-02）——**零 electron 依赖、零 logger import**。
 *
 * 为什么零依赖：本模块必须能被 vitest 直接 `import` 做纯单测（注入 `fetcher` 即可，
 * 不启动 Electron、不碰真实网络、不写真实日志）。主进程侧的 IPC handler（T-03）
 * 负责库内路径校验与日志，本模块只做「抓字节 → 校验 → 落盘」。
 *
 * ── 已实测钉死的口径（**不要"优化"，每一条都是踩过的坑**）────────────
 * 1. 详情页固定 `https://su.znzmo.com/sumoxing/{ID}.html`，`redirect: 'follow'`。
 *    站点 301 会把材质 ID 送到 `tietu`——所以**不需要**判断模型/材质。
 * 2. 取图**唯一来源** = `__NEXT_DATA__.props.pageProps.res.listImageUrl`
 *    （`image6.znzmo.com`，400×300，**无水印**）；
 *    `mainImageUrl`（`image2`，1600px，**带水印**）**只在 `listImageUrl` 字段缺失时**兜底。
 * 3. JSON-LD 的 `ImageObject.contentUrl` **永不参与取图**，连 `fetch` 都不许发起 ——
 *    它指向的正是带水印的 `image2` 大图。JSON-LD 只回答"这一页是不是有效详情页"。
 * 4. **必须原样使用返回的 URL 字符串**：禁止替换 host、禁止追加或替换任何
 *    `x-oss-process` 参数（`/format,jpg` 会 **400**；`image2` + `style/list` 会返回
 *    **带水印**的 400×300，且状态码/尺寸/体积全都看不出错）。
 * 5. 软 404 = **HTTP 200**（约 18KB 空壳）。三种失效形态（软 404 / 裸 Next 404 /
 *    WAF 404）状态码分别是 200 / 404 / 404 → **HTML 页面不看状态码**，
 *    判据只能是"能不能解析出图 URL"。
 *    ⚠️ 但**图片请求按 2xx 判**是安全的：OSS 对象 404 就是真没了。
 * 6. 格式不定（小图 jpg / png 都有）→ 落盘必须按**实际字节魔数**决定扩展名
 *    （由 `writeCoverImageInto()` 内部再嗅一次实现，PNG 就落 `.cover.png`）。
 * 7. 干净版分辨率封顶 400×300，加任何 OSS 参数都出不来更大。
 *
 * ── 成功判据（写死在代码里，没有第三种）────────────────────────────
 * ```
 * 成功 ⇔ 拿到一张 可嗅出 PNG/JPEG 魔数 且 宽度 ≥ minWidth(默认 200px) 的图片字节
 * 失效 ⇔ __NEXT_DATA__ 与 JSON-LD 两条路径都解析不出图 URL
 * ```
 *
 * ── 瞬时失败的有界重试（2026-10 用户日志：一次抖动 = 用户看到"获取失败"）──────
 * 事故现场（`app-2026-10-22.log`）：
 * ```
 * 11:12:48.027Z [WARN] zhimo:cover-failed {"id":"1168792999","reason":"timeout"}
 * 11:13:03.040Z [WARN] zhimo:cover-failed {"id":"1168792999","reason":"timeout"}
 * ```
 * 两条间隔恰好 15s（= 当时的 `pageTimeoutMs`），而同一 ID 在 Electron 33 运行时里
 * 详情页只用 709ms —— 说明是**瞬时的网络/边缘节点抖动**，而当时的实现"一次失败即放弃"。
 *
 * 所以：**只对 `timeout` / `network` 重试**，`初次 + 1 次`，退避 800ms（可注入）。
 * `no-id` / `not-found` / `no-image` / `bad-url` / `bad-image` / `too-small` /
 * `write-failed` **一次都不重试**：它们不是"抖了一下"，重试只会把用户的等待翻倍。
 * 重试同样受各自超时约束（每次尝试都新建 `AbortSignal.timeout`）。
 *
 * ⚠️ 本模块**任何路径都不 throw**：所有失败都转成 `{ ok: false, reason }`。
 * 自动任务是静默的（失败不提示），手动按钮需要区分文案，所以 reason 必须可辨别。
 * 诊断字段（step / attempt / elapsedMs / totalMs）**不进返回值**（返回值形状一字不变），
 * 而是走 `onAttemptFailed` 回调交给 IPC handler 记日志。
 *
 * ── 扩展属性（风格，2026-10 TODO-3）──────────────────────────────────
 * 详情页同一次 GET 里还带 `res.detailParamsExtract`（`style` / `renderer` / `polys` …）
 * 与 `res.classifyBaseName`。本模块**只解析**（`ZhimoDetailExtras`），
 * 其中 `style` / `classifyBaseName` 原样放进成功结果（**仍是附加字段，不影响封面成败**）；
 * **是否落库由渲染层判定**：
 * - `style`：`renderer/logic/zhimoStyle.ts`（只补空、只认词表、只对 model）；
 * - `classifyBaseName`：必须查 `shared/zhimoTaxonomyMap.ts` 的 `mapZhimoCategory()`，
 *   **不准**直接写 `category1/2`（站方三级轴与本地两级不是一一对应）。
 * `renderer` / `polys` 仍只解析不落库。
 *
 * ── 只取详情页的轻量入口（2026-10，站方分类）──────────────────────────
 * 见文件末尾的 `fetchZhimoMeta()`：**只 GET 详情页、解析元信息、绝不下图片**。
 * 存在理由：封面路径必须"下到图且 ≥200px"才算成功，图挂了会把已经拿到的
 * 站方分类一起丢掉；本入口把"取分类"与"取封面"解耦（同样零 throw / 同一套重试口径）。
 */

import { validateCoverImage, writeCoverImageInto, type CoverImageFormat } from './coverImage'
import { imageSizeOf } from '../shared/imageSize'
import type { FetchZhimoCoverResult, ZhimoCoverFailReason } from '../shared/types'

/** 失败原因从 `shared/types` 复用（main / preload / renderer 共用同一份枚举） */
export type { ZhimoCoverFailReason }

// ── 常量 ────────────────────────────────────────────────────────────────

/** 详情页 URL 前缀（实测：固定路径 + `redirect: 'follow'`，站点自己 301 到 tietu） */
const ZHIMO_DETAIL_BASE = 'https://su.znzmo.com/sumoxing/'

/** 详情页与图片请求共用的固定 UA（零 cookie / 零签名 / **零 Referer**，见 docs/24 口径 #3） */
const ZHIMO_USER_AGENT = 'Mozilla/5.0 (IDBOX cover fetcher)'

/**
 * 详情页请求超时（毫秒）。
 *
 * 2026-10 事故后从 15s 收到 10s：实测详情页 709ms 就能拿全（43KB HTML），
 * 15s 已经远远超出"正常慢"的范围；收短才能让"初次 + 1 次重试"的最坏耗时可控（≈21s）。
 */
export const DEFAULT_PAGE_TIMEOUT_MS = 10_000

/**
 * 图片请求超时（毫秒）：图片比 HTML 大一个量级，给更宽裕的预算。
 *
 * 20s → 15s 同理（实测 400×300 干净图 65ms）。
 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 15_000

/**
 * 最多尝试次数：`2` = 初次 + **1 次**重试。
 *
 * ⚠️ 不要调大：站点对连续请求敏感（见渲染层队列的 250ms 间隔纪律），
 * 而且每次重试都要再吃一个完整超时预算，用户不会等第三发。
 */
export const DEFAULT_MAX_ATTEMPTS = 2

/** 重试前的退避（毫秒）：800ms 足够躲过单次边缘节点抖动，用户几乎无感 */
export const DEFAULT_RETRY_BACKOFF_MS = 800

/**
 * 可接受的封面最小宽度（像素）。
 *
 * 干净版实测是 400×300，200px 门槛只用来拦住"站方给的占位小图 / 畸形缩略图"，
 * 不会误杀真实封面（也留出站方未来下调分辨率的余量）。
 */
const DEFAULT_MIN_WIDTH = 200

/** 6 位以上纯数字才是知末商品 ID（4 位常是年份/型号） */
const ZHIMO_ID_RE = /^\d{6,}$/

// ── 数据结构 ────────────────────────────────────────────────────────────

/** 站方面包屑条目（**只解析、不接线**，见 docs/24 §4.12 / §11） */
export interface ZhimoBreadcrumbItem {
  termId: number
  name: string
  /** 站方层级真值：`f{termId}` / `f{父}s{子}` / `f{祖}s{父}s{子}` */
  href: string
  /** 由 `href` 里 `s` 的个数推导（`f706`→1、`f17032s706`→2）；**不用数组下标** */
  level: number
}

/**
 * 站方详情页里的**扩展属性**（`res.detailParamsExtract` + `res.classifyBaseName`）。
 *
 * 全部来自**同一次 GET**（零额外请求）。
 *
 * ⚠️ 这批字段的处理口径：
 * - `style` / `classifyBaseName` **随成功结果带出去**（附加字段，不影响成败），
 *   写不写库由渲染层判定（`style` 过词表；`classifyBaseName` 必须查映射表）；
 * - `version` / `renderer` / `polys` **只解析、不落库**：
 * - `classifyBaseName` 是站方三级轴的名字，与本地重排过的两级分类不是一一对应
 *   （本地没有「墙饰墙绘」、`木材`/`木纹` 层级也不同）→ 不写 `category1/2`；
 * - `version` 是"上传时用的版本"，`.skp` 内嵌的才是真实版本 → **不写 `asset.suVersion`**；
 * - `renderer` / `polys` 是新增维度，本批没有对应的受控字段 → 只留给日志/后续排期。
 */
export interface ZhimoDetailExtras {
  /** 站方风格自由词；`--`（占位）/ 空 / 缺失 → `null`。**未经本地词表过滤** */
  style: string | null
  /** 站方三级分类名（如 `卡座沙发`）；缺失 → `null` */
  classifyBaseName: string | null
  /** 站方上传版本（如 `sketchup 2014`）；缺失 → `null` */
  version: string | null
  /** 渲染器（如 `Enscape`）；缺失 / 占位 → `null` */
  renderer: string | null
  /** 面数；非有限数字 → `null` */
  polys: number | null
}

export interface ZhimoDetailInfo {
  /**
   * 详情页 `res` 里的主图（**带水印**，`image2`）。
   * 用途只有两个：`listImageUrl` **字段缺失**时的取图兜底、"这一页是不是真详情页"的判据。
   */
  mainImageUrl: string | null
  /** **取图唯一首选**：无水印 400×300（`image6`）；字段缺失时为 `null` */
  listImageUrl: string | null
  title: string | null
  version: string | null
  skuId: string | null
  /** 站方面包屑；解析不出有效条目时**不写该字段**（`undefined`，不写空数组） */
  breadcrumb?: ZhimoBreadcrumbItem[]
  /** 站方扩展属性；`detailParamsExtract` 与 `classifyBaseName` 都没有时**不写该字段** */
  detail?: ZhimoDetailExtras
}

/** 图片来源主机白名单（防 `__NEXT_DATA__` 被投毒后让主进程去请求任意地址） */
export const ZHIMO_IMAGE_HOSTS: readonly string[] = ['image6.znzmo.com', 'image2.znzmo.com']

/** 最小 HTTP 抽象：与 `globalThis.fetch` 结构兼容，测试可注入桩 */
export interface ZhimoHttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type ZhimoFetcher = (
  url: string,
  init: { signal?: AbortSignal; redirect?: 'follow'; headers?: Record<string, string> }
) => Promise<ZhimoHttpResponse>

/** 抓取成功的结果（**形状与历史完全一致**，重试改造没有动它） */
export interface ZhimoCoverSuccess {
  ok: true
  buffer: Buffer
  format: CoverImageFormat
  width: number
  height: number
  /** 实际请求的图片 URL（**原样取自详情页**，禁止任何改写） */
  sourceUrl: string
  /** 实际取图的 host：`image6.znzmo.com`（无水印）| `image2.znzmo.com`（兜底，带水印） */
  sourceHost: string
  /** `true` = 走了 `mainImageUrl` 兜底（即带水印）。主路径成功时必须为 `false` */
  watermarked: boolean
  title: string | null
  version: string | null
  /**
   * 站方三级分类名（如 `卡座沙发` / `壁灯`）；站方没给 → `null`。
   *
   * 与 `style` 一样是**附加信息**：解析不到绝不影响封面成败。
   *
   * ⚠️ 这是**站方原话**（`res.classifyBaseName`），与本地两级分类不是一一对应 ——
   * 落库前必须查 `shared/zhimoTaxonomyMap.ts` 的 `mapZhimoCategory()`，
   * **不要**直接写进 `asset.category1/2`（理由见 `ZhimoDetailExtras` 注释）。
   */
  classifyBaseName: string | null
  /**
   * 站方风格自由词（**原样，未经本地词表过滤**）；解析不到 / 占位 `--` 时为 `null`。
   *
   * 为什么不在主进程过滤：词表是**渲染层与共享层的受控维度**（`STYLE_LIST_BY_KIND`），
   * 主进程刻意零依赖、可纯单测。过滤 + "只在 styles 为空时写"的判定在
   * `renderer/logic/zhimoStyle.ts` + store 里做。
   *
   * 这个字段**不影响封面成败**：解析不到时封面照常成功，只是这里为 `null`。
   */
  style: string | null
}

/**
 * 抓取失败：**只有** `ok` + `reason`（与历史形状一字不差）。
 *
 * 为什么诊断字段（step / attempt / elapsedMs）不塞进这里：
 * ① 这个对象会原样跨 IPC 到渲染层，多带字段等于改协议（渲染层不需要也不该依赖）；
 * ② 诊断只服务日志，走 {@link ZhimoAttemptFailure} 回调即可，不需要污染返回值。
 */
export type ZhimoCoverFailure = { ok: false; reason: ZhimoCoverFailReason }

export type ZhimoCoverOutcome = ZhimoCoverSuccess | ZhimoCoverFailure

// ── 重试诊断（只服务日志，不进返回值） ──────────────────────────────────

/**
 * 失败发生在哪一步。
 *
 * - `page`：详情页请求失败，或"页面拿到了但选不出可用图 URL"
 *   （`not-found` / `no-image` / `bad-url` 都归这一步 —— 问题出在页面侧）；
 * - `image`：图片请求失败，或图片字节没通过校验（`bad-image` / `too-small`）。
 *
 * ⚠️ 日志**必须**带这个字段：2026-10 的事故日志里只有 `reason: 'timeout'`，
 * 只能靠"时长落在 15s 而不是 20s"反推是详情页超时 —— 猜出来的定位不算定位。
 */
export type ZhimoFetchStep = 'page' | 'image'

/**
 * 一次尝试的失败现场（`zhimo:cover-failed` / `zhimo:cover-retry` 日志字段的来源）。
 *
 * 时间口径（**不要含糊**）：
 * - `elapsedMs` = **本次尝试**的耗时，不含退避、不含之前的尝试；
 * - `totalMs`   = 从入口到**本次失败**的累计耗时，含退避与之前所有尝试。
 */
export interface ZhimoAttemptFailure {
  reason: ZhimoCoverFailReason
  step: ZhimoFetchStep
  /** 第几次尝试（1-based；本模块最多到 {@link DEFAULT_MAX_ATTEMPTS}） */
  attempt: number
  /** 本次尝试耗时（毫秒） */
  elapsedMs: number
  /** 从入口到本次失败的累计耗时（毫秒，含退避） */
  totalMs: number
  /** `true` = 这一发失败后还会再试一次；`false` = 已是最后一发（不会再有请求） */
  willRetry: boolean
}

/**
 * 可重试的失败原因（**只有这两个**，新增任何一项都要先问"重试能改变结果吗"）。
 *
 * 刻意**不包含**的（重试无意义，只会把等待翻倍）：
 * `no-id`（ID 自己就不合法）/ `not-found`（页面真的没了）/
 * `no-image`（页面在但站方没给干净图）/ `bad-url`（URL 不合规）/
 * `bad-image`（返回的不是图）/ `too-small`（分辨率硬门槛）/ `write-failed`（磁盘问题）。
 */
export const ZHIMO_RETRYABLE_REASONS: readonly ZhimoCoverFailReason[] = ['timeout', 'network']

/** 该 reason 是否值得重试一次 */
export function isRetryableZhimoReason(reason: ZhimoCoverFailReason): boolean {
  return ZHIMO_RETRYABLE_REASONS.includes(reason)
}

/**
 * 组装 `zhimo:cover-failed` 的日志载荷（**纯函数**，handler 直接把它交给 `logWarn`）。
 *
 * 五个字段**恒在**（方便日志分析按 key 取值，不用处理"有时缺字段"）：
 * - `step: null` + `attempt: 0` + `elapsedMs: 0` + `totalMs: 0` ⇔
 *   **一次请求都没发或没有"某一步失败"**（`no-id` / `write-failed`）；
 * - 其余情况正常带值（`attempt` 为 2 就说明"重试过了还是不行"）。
 */
export function zhimoCoverFailLogContext(
  id: string,
  reason: ZhimoCoverFailReason,
  lastFailure: ZhimoAttemptFailure | null
): {
  id: string
  reason: ZhimoCoverFailReason
  step: ZhimoFetchStep | null
  attempt: number
  elapsedMs: number
  totalMs: number
} {
  return {
    id,
    reason,
    step: lastFailure?.step ?? null,
    attempt: lastFailure?.attempt ?? 0,
    elapsedMs: lastFailure?.elapsedMs ?? 0,
    totalMs: lastFailure?.totalMs ?? 0
  }
}


// ── 小工具（纯函数） ────────────────────────────────────────────────────

/** 非空字符串才算有值（`''` / 纯空白 / 非字符串 → `null`） */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}

/** 是不是普通对象（数组、null 都不算） */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 站方"没有值"的占位符（实测：`detailParamsExtract.style === "--"`）。
 *
 * ⚠️ 只认这两个字面量，**不要**把「未知 / 无 / 其他」也当占位——
 * 那些是站方真给的值，误判成 null 只会让信息白丢。
 */
const ZHIMO_PLACEHOLDERS: readonly string[] = ['--', '-']

/**
 * 站方文本字段 → 干净值（`null` 表示"没有"，**绝不返回空串**）。
 *
 * 与 {@link nonEmptyString} 的区别：额外把占位符 `--` / `-` 当没有
 * （素材/贴图频道大量字段用 `--` 表示"不适用"）。
 */
function stationText(v: unknown): string | null {
  const s = nonEmptyString(v)
  if (!s) return null
  return ZHIMO_PLACEHOLDERS.includes(s) ? null : s
}

/**
 * 站方面数 → `number | null`（只接受有限非负数字；`null` / 字符串一律当没有）。
 *
 * 站方给的是 JSON number，不存在"数字字符串"这种形态，所以不做 `Number()` 兜底
 * ——宽进会把 `"--"` 这种占位符变成 `NaN`，反而更难查。
 */
function stationCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v
}

/**
 * 判定"这次失败是不是超时"。
 *
 * Node 的 `AbortSignal.timeout()` 抛 `TimeoutError`；被 `AbortController.abort()`
 * 打断的场景抛 `AbortError`。两者都归 `timeout`（其余一律 `network`）。
 */
function isTimeoutError(err: unknown): boolean {
  if (!isRecord(err)) return false
  const name = err.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * 取图片 URL 的主机名；解析不出返回 `null`。
 *
 * 只接受 **https + 精确白名单 host**：`//image6.znzmo.com/x.jpg`（协议相对 URL）
 * 与 `http://` 一律拒绝 —— 主进程不做任何"猜协议"的兜底。
 */
function hostOfImageUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  return ZHIMO_IMAGE_HOSTS.includes(host) ? host : null
}

// ── 详情页解析 ──────────────────────────────────────────────────────────

/** `__NEXT_DATA__` 的 script 内容（取图**唯一**来源） */
const NEXT_DATA_RE =
  /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i

/** 任意 `<script type="application/ld+json">` 块（**只做有效性判据**） */
const JSON_LD_RE = /<script[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/**
 * 逐个解析 JSON-LD 块（坏块**跳过**，不影响其它块）。
 *
 * 真实详情页有 2 块：`BreadcrumbList`（带频道名）与 `ImageObject`
 * （`contentUrl` 指向 `image2` 带水印大图，**永远不拿来取图**）。
 */
function parseJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = []
  // `matchAll` 要求 `g`；每次调用新建迭代器，不会污染全局 lastIndex
  for (const m of html.matchAll(JSON_LD_RE)) {
    try {
      blocks.push(JSON.parse(m[1]))
    } catch {
      /* 截断 / 非法 JSON 的块跳过：坏一块不能影响"页面有效"的判定 */
    }
  }
  return blocks
}

/** `@type` 是否命中（站方可能写成 `'ImageObject'` 或 `['ImageObject']`） */
function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const t = node['@type']
  if (typeof t === 'string') return t === wanted
  if (Array.isArray(t)) return t.some((x) => x === wanted)
  return false
}

/**
 * 从 JSON-LD 块里找 `ImageObject.contentUrl`（**只用于判有效性，绝不返回给取图用**）。
 *
 * 递归处理数组与 `@graph`：站方结构改版时对象可能被包一层，找深一点更稳。
 */
function jsonLdImageUrl(blocks: readonly unknown[]): string | null {
  const seen = new Set<unknown>()
  const walk = (node: unknown): string | null => {
    if (node === null || typeof node !== 'object') return null
    if (seen.has(node)) return null
    seen.add(node)
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child)
        if (hit) return hit
      }
      return null
    }
    const rec = node as Record<string, unknown>
    if (typeIncludes(rec, 'ImageObject')) {
      const contentUrl = nonEmptyString(rec.contentUrl)
      if (contentUrl) return contentUrl
    }
    return walk(rec['@graph'])
  }
  for (const block of blocks) {
    const hit = walk(block)
    if (hit) return hit
  }
  return null
}

/**
 * 面包屑 href → 层级（**由 href 推导，绝不看数组下标**）。
 *
 * 真实反例（`1186414883`）：`f765` → `f765s806` → `f765s1035`，
 * 第 3 条"挂画"的父是**第 1 条**（765），中间那条 `806` 只是同级展示项。
 * 按下标猜会把它算成第 3 级 —— 所以 `level = 1 + href 里 's' 的个数`。
 *
 * href 必须形如 `f<digits>` / `f<digits>s<digits>…`；不合法返回 `null`（整条丢弃）。
 */
function levelOfHref(href: string): number | null {
  if (!/^f\d+(?:s\d+)*$/.test(href)) return null
  const separators = href.split('s').length - 1
  return 1 + separators
}

/** href 的最后一段 termId（用于"termId 与 href 是否自洽"的校验） */
function lastTermIdOfHref(href: string): number | null {
  const tail = /(\d+)$/.exec(href)
  if (!tail) return null
  const n = Number(tail[1])
  return Number.isFinite(n) ? n : null
}

/**
 * `pageProps.breadcrumb_data` → 面包屑数组；一条有效条目都没有 → `undefined`。
 *
 * 丢弃规则（站方数据脏过就别信）：
 * - `termId` 不是正整数；
 * - `showName` 为空 / 非字符串；
 * - `href` 不是合法层级串；
 * - `termId` 与 `href` 末段不一致。
 */
function parseBreadcrumb(raw: unknown): ZhimoBreadcrumbItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ZhimoBreadcrumbItem[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const termId = item.termId
    const name = nonEmptyString(item.showName)
    const href = nonEmptyString(item.href)
    if (typeof termId !== 'number' || !Number.isInteger(termId) || termId <= 0) continue
    if (!name || !href) continue
    const level = levelOfHref(href)
    if (level === null) continue
    if (lastTermIdOfHref(href) !== termId) continue
    out.push({ termId, name, href, level })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 从详情页 HTML 取 `__NEXT_DATA__.props.pageProps`（**纯函数，绝不抛错**）。
 *
 * 抽成独立函数的理由：`parseZhimoDetail`（取图）与 `parseZhimoMeta`（分类/风格）
 * 必须用**同一套**取值逻辑 —— 两份实现迟早会在"JSON 截断怎么办"这种边界上分叉。
 *
 * 解析不出（没有该 script / JSON 截断 / 结构不对）→ `null`（当没有，不抛错）。
 */
function pagePropsOf(html: string): Record<string, unknown> | null {
  const source = typeof html === 'string' ? html : ''
  const nextMatch = NEXT_DATA_RE.exec(source)
  if (!nextMatch) return null
  try {
    const json: unknown = JSON.parse(nextMatch[1])
    const props = isRecord(json) ? json.props : undefined
    const rawProps = isRecord(props) ? props.pageProps : undefined
    return isRecord(rawProps) ? rawProps : null
  } catch {
    return null // JSON 截断 / 非 JSON → 当没有
  }
}

/**
 * `pageProps` → 详情页数据根 `res`；不是普通对象 → `null`。
 *
 * ⚠️ 取值一律经过「类型 + 非空」双重判定：软 404 的 `res` 可能是 `{}`、
 * 可能是 `{"0":"F","1":"o",…}`（错误文案按字符展开）、也可能是 `null`。
 * JS 里对 null/字符串取属性只会得到 undefined，所以不必先判 `res` 是不是对象。
 */
function detailResOf(pageProps: Record<string, unknown> | null): Record<string, unknown> | null {
  const raw = pageProps?.res
  return isRecord(raw) ? raw : null
}

/**
 * 给定详情页 HTML → 解析结果（**纯函数，绝不抛错**）。
 *
 * 返回 `null` 的**唯一**条件：`__NEXT_DATA__` 与 JSON-LD **两条路径都解析不出图 URL**
 * （= 资产失效，覆盖软 404 / 裸 404 / WAF 404）。
 *
 * 注意一处**看起来矛盾、其实是刻意如此**的行为：只要 JSON-LD 有 `contentUrl`
 * 就返回对象（哪怕 `listImageUrl` / `mainImageUrl` 都为 `null`），
 * 由调用方按 `no-image` 处理 —— "这个 ID 没了"（`not-found`）与
 * "页面在但取不到干净图"（`no-image`）对用户是两件不同的事，必须能区分。
 */
export function parseZhimoDetail(html: string): ZhimoDetailInfo | null {
  const source = typeof html === 'string' ? html : ''

  // ── 路径 ①：__NEXT_DATA__（**取图的唯一来源**）──────────────────────
  const pageProps = pagePropsOf(source)
  const res = detailResOf(pageProps)

  // 图 URL 只从这里来：listImageUrl（无水印 400×300）→ mainImageUrl（带水印，仅兜底）
  const listImageUrl = nonEmptyString(res?.listImageUrl)
  const mainImageUrl = nonEmptyString(res?.mainImageUrl)

  // ── 路径 ②：JSON-LD（**只做有效性判据，永不取图**）──────────────────
  const ldImageUrl = jsonLdImageUrl(parseJsonLdBlocks(source))

  // ── 有效性判据：两条路径都拿不到图 URL ⇒ 资产失效 ────────────────────
  if (!listImageUrl && !mainImageUrl && !ldImageUrl) return null

  const skuIdRaw = res?.skuId
  const skuId =
    skuIdRaw === null || skuIdRaw === undefined ? null : nonEmptyString(String(skuIdRaw))

  const detail: ZhimoDetailInfo = {
    mainImageUrl,
    listImageUrl,
    title: nonEmptyString(res?.title),
    version: nonEmptyString(res?.version),
    skuId
  }
  const breadcrumb = parseBreadcrumb(pageProps?.breadcrumb_data)
  // 无有效条目时**不写该字段**（`undefined` 而不是 `[]`：'没有' 与 '空' 语义不同）
  if (breadcrumb) detail.breadcrumb = breadcrumb

  const extras = parseDetailExtras(res)
  // `detailParamsExtract` 与 `classifyBaseName` 都没有 → 不写该字段（不造空对象）
  if (extras) detail.detail = extras
  return detail
}

/**
 * 解析站方扩展属性（`res.detailParamsExtract.*` + `res.classifyBaseName`）。
 *
 * 返回 `null` 的**唯一**条件：两个来源都不是对象/都没值 —— 即"这一页压根没给扩展属性"。
 * 只要 `detailParamsExtract` 是对象（哪怕全是 `--`），就返回对象、字段为 `null`：
 * "站方给了但没值" 与 "站方根本没这个字段" 对上层等价（都写不进去），
 * 但对日志/排查有用，所以保留对象。
 *
 * ⚠️ 本函数**绝不抛错**（`parseZhimoDetail` 的整体契约），且**零额外请求**。
 */
function parseDetailExtras(res: Record<string, unknown> | null): ZhimoDetailExtras | null {
  const raw = res?.detailParamsExtract
  const dpe = isRecord(raw) ? raw : null
  const classifyBaseName = stationText(res?.classifyBaseName)

  if (!dpe && !classifyBaseName) return null

  return {
    style: stationText(dpe?.style),
    classifyBaseName,
    // `version` 在 `res` 根上也有一份（实测两处一致）；`detailParamsExtract` 缺失时用它兜底
    version: stationText(dpe?.version) ?? stationText(res?.version),
    renderer: stationText(dpe?.renderer),
    polys: stationCount(dpe?.polys)
  }
}

// ── URL 白名单 ──────────────────────────────────────────────────────────

/**
 * 图片 URL 是否可抓（**类型谓词**，便于调用处直接收窄成 `string`）。
 *
 * 规则：非空字符串 + 可解析 + `https:` + host 精确命中 `ZHIMO_IMAGE_HOSTS`。
 * 这一步是"JSON 被投毒 / 站方结构改版塞进外链"的唯一防线（SSRF 面）。
 */
export function isZhimoImageUrl(url: unknown): url is string {
  const s = nonEmptyString(url)
  if (!s) return false
  return hostOfImageUrl(s) !== null
}

// ── 抓取 ────────────────────────────────────────────────────────────────

/** 默认 fetcher：直接用运行时 `fetch`（注入桩可在单测里完全离线） */
const defaultFetcher: ZhimoFetcher = (url, init) => globalThis.fetch(url, init)

/** 默认 sleep（退避用）。⚠️ 单测请注入即时桩，不要让测试真的等 800ms */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// ── 单步网络请求（每次调用都拿**新的**超时信号） ────────────────────────

/** 构造详情页 URL（ID 已在入口校验过是纯数字，此处只做拼接） */
function detailUrlOf(id: string): string {
  return `${ZHIMO_DETAIL_BASE}${id}.html`
}

/**
 * 抓详情页 HTML 文本。
 *
 * 网络层**只判"拿到字节了没有"**：超时 → `timeout`；连接失败 / `text()` 抛错 → `network`。
 * **`status` 不参与任何判断**（软 404 是 200、裸 404 是 404，判据全在解析那一步）。
 */
async function fetchDetailHtml(
  fetcher: ZhimoFetcher,
  id: string,
  timeoutMs: number
): Promise<{ ok: true; html: string } | { ok: false; reason: ZhimoCoverFailReason }> {
  let response: ZhimoHttpResponse
  try {
    response = await fetcher(detailUrlOf(id), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'User-Agent': ZHIMO_USER_AGENT }
    })
  } catch (err) {
    return { ok: false, reason: isTimeoutError(err) ? 'timeout' : 'network' }
  }
  try {
    const html = await response.text()
    return { ok: true, html }
  } catch (err) {
    // 连接中途断开 / 读流失败：状态码可能还是 200，所以统一按网络问题
    return { ok: false, reason: isTimeoutError(err) ? 'timeout' : 'network' }
  }
}

/**
 * 抓图片字节。
 *
 * 与 HTML 页不同，**图片请求按 2xx 判**是安全的：OSS 对象 404 就是真的没了
 * （"200 也可能是空壳"只发生在站方的 HTML 页面路由上）。
 * 非 2xx 一律 `network`，**不回落另一张图**（回落就会静默产出带水印封面）。
 */
async function fetchImageBytes(
  fetcher: ZhimoFetcher,
  url: string,
  timeoutMs: number
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: ZhimoCoverFailReason }> {
  let response: ZhimoHttpResponse
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'User-Agent': ZHIMO_USER_AGENT }
    })
  } catch (err) {
    return { ok: false, reason: isTimeoutError(err) ? 'timeout' : 'network' }
  }

  const status = Number(response.status)
  const is2xx = Number.isFinite(status) && status >= 200 && status < 300
  // 严格按 2xx 判：拿不到合法状态码也算失败（真实 `fetch` 一定给 status，
  // 这里不容错以免把"没有状态码"这种异常当成成功）
  if (!is2xx) return { ok: false, reason: 'network' }

  try {
    const ab = await response.arrayBuffer()
    return { ok: true, buffer: Buffer.from(ab) }
  } catch (err) {
    return { ok: false, reason: isTimeoutError(err) ? 'timeout' : 'network' }
  }
}

// ── 重试编排 ────────────────────────────────────────────────────────────

/** 一次尝试的配置（默认值在进入重试循环前解析好，循环里不再关心 undefined） */
interface ZhimoAttemptConfig {
  id: string
  fetcher: ZhimoFetcher
  pageTimeoutMs: number
  imageTimeoutMs: number
  minWidth: number
}

/** 单次尝试的失败：**一定要带 step**（`no-id` 在进循环前就被拦掉了） */
interface ZhimoStepFailure {
  ok: false
  reason: ZhimoCoverFailReason
  step: ZhimoFetchStep
}

/**
 * 单次尝试：详情页 → 解析 → 选图 → 抓图 → 校验（**只返回字节，不碰磁盘**）。
 *
 * 十步顺序是**硬约束**（docs/24 §3.3），不可调换、不许加分支：
 * 1. ID 格式（已在 {@link fetchZhimoCover} 里做掉）→ `no-id`，**不发任何请求**
 * 2. GET 详情页（follow / 固定 UA / 超时信号）
 * 3. 网络层只判"拿到字节没有"，`status` 不参与
 * 4. `parseZhimoDetail()` 为 null → `not-found`（step=page）
 * 5. `listImageUrl` 优先，**仅当为 null** 才用 `mainImageUrl`；都 null → `no-image`（step=page）
 * 6. URL 白名单 → `bad-url`（step=page）
 * 7. GET 图片，非 2xx → `network` / 超时 → `timeout`（step=image），**不回落**
 * 8. `validateCoverImage()`（≤20MB + 魔数）→ `bad-image`（step=image）
 * 9. `imageSizeOf()` 为 null → `bad-image`；宽度 < minWidth → `too-small`（step=image）
 * 10. 返回完整成功对象（含 `sourceUrl` / `sourceHost` / `watermarked` / `style`）
 *
 * `style` 取自 `res.detailParamsExtract.style`（与详情页同一次 GET，零额外请求）。
 * 它是**附加信息**：取不到就是 `null`，不影响前面十步的任何判定。
 *
 * 每个失败都标了 `step`：这是"下次能靠日志定位"与"只能靠时长反推"的分界线。
 */
async function attemptFetchZhimoCover(
  config: ZhimoAttemptConfig
): Promise<{ ok: true; outcome: ZhimoCoverSuccess } | ZhimoStepFailure> {
  const { id, fetcher, pageTimeoutMs, imageTimeoutMs, minWidth } = config

  // ── 步骤 2–3：详情页（只看"拿到字节没有"）────────────────────────────
  const page = await fetchDetailHtml(fetcher, id, pageTimeoutMs)
  if (!page.ok) return { ok: false, reason: page.reason, step: 'page' }

  // ── 步骤 4：解析（两条解析路径都没有图 URL ⇒ 资产失效）────────────────
  const detail = parseZhimoDetail(page.html)
  if (!detail) return { ok: false, reason: 'not-found', step: 'page' }

  // ── 步骤 5：选图（listImageUrl 优先；**仅当为 null** 才兜底）───────────
  const sourceUrl = detail.listImageUrl ?? detail.mainImageUrl
  if (!sourceUrl) return { ok: false, reason: 'no-image', step: 'page' }

  // ── 步骤 6：白名单（同时定下 sourceHost / watermarked）───────────────
  const sourceHost = hostOfImageUrl(sourceUrl)
  if (!sourceHost || !isZhimoImageUrl(sourceUrl)) {
    return { ok: false, reason: 'bad-url', step: 'page' }
  }
  const watermarked = sourceHost === 'image2.znzmo.com'

  // ── 步骤 7：抓图片字节（原样 URL，一个字符都不改）─────────────────────
  const image = await fetchImageBytes(fetcher, sourceUrl, imageTimeoutMs)
  if (!image.ok) return { ok: false, reason: image.reason, step: 'image' }

  // ── 步骤 8：魔数 + 体积（≤20MB）──────────────────────────────────────
  const validation = validateCoverImage(image.buffer)
  if (!validation.ok) return { ok: false, reason: 'bad-image', step: 'image' }

  // ── 步骤 9：宽高（宽 < 200 视为占位/畸形图）──────────────────────────
  const size = imageSizeOf(image.buffer)
  if (!size) return { ok: false, reason: 'bad-image', step: 'image' }
  if (size.w < minWidth) return { ok: false, reason: 'too-small', step: 'image' }

  // ── 步骤 10：成功（诊断字段：sourceHost / watermarked 由上层日志与 UI 使用）
  return {
    ok: true,
    outcome: {
      ok: true,
      buffer: image.buffer,
      format: validation.format,
      width: size.w,
      height: size.h,
      sourceUrl,
      sourceHost,
      watermarked,
      title: detail.title,
      version: detail.version,
      // 站方三级分类名：**附加信息**（取不到就是 null）。
      // 只带出去，不在主进程做映射 —— 映射表在 `shared/zhimoTaxonomyMap.ts`。
      classifyBaseName: detail.detail?.classifyBaseName ?? null,
      // 风格只是**附加信息**：解析不到就是 null，绝不影响封面成败
      style: detail.detail?.style ?? null
    }
  }
}

/** {@link fetchZhimoCover} 的入参（默认值全部可覆盖，测试靠它把退避压到 0） */
export interface ZhimoCoverFetchOptions {
  id: string
  fetcher?: ZhimoFetcher
  /** 详情页超时（默认 {@link DEFAULT_PAGE_TIMEOUT_MS} = 10s） */
  pageTimeoutMs?: number
  /** 图片超时（默认 {@link DEFAULT_IMAGE_TIMEOUT_MS} = 15s） */
  imageTimeoutMs?: number
  minWidth?: number
  /** 最多尝试次数（默认 {@link DEFAULT_MAX_ATTEMPTS} = 2；传 1 = 关闭重试） */
  maxAttempts?: number
  /** 重试退避毫秒（默认 {@link DEFAULT_RETRY_BACKOFF_MS} = 800；**测试传 0**） */
  retryBackoffMs?: number
  /** 退避用的 sleep（默认真实 setTimeout；测试注入即时桩并断言入参） */
  sleep?: (ms: number) => Promise<void>
  /**
   * 每次尝试失败的回调（**含最后一次**，`willRetry` 区分"还会再试"与"到此为止"）。
   *
   * 只服务日志：返回值形状一字未改，诊断信息全靠这个回调传出去。
   * 回调抛错会被吞掉（日志不该影响抓取）。
   */
  onAttemptFailed?: (failure: ZhimoAttemptFailure) => void
}

/** 把可选的次数/退避归一成合法值（`NaN` / 负数 / 小数都不许漏进循环） */
function normalizeAttempts(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS
  return Math.max(1, Math.floor(value))
}

function normalizeBackoff(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RETRY_BACKOFF_MS
  return Math.max(0, Math.floor(value))
}

/**
 * 重试策略（`fetchZhimoCover` 与 `fetchZhimoMeta` **共用同一份口径**）。
 *
 * 单独抽出来的目的：两条入口的"哪些 reason 值得重试、最多几发、退避多久"
 * **必须是同一套判定**（`isRetryableZhimoReason`）—— 各写一遍迟早分叉成
 * "封面重试两次、元信息重试三次"这种说不清的行为。
 */
interface ZhimoRetryPolicy {
  maxAttempts: number
  backoffMs: number
  sleep: (ms: number) => Promise<void>
  onAttemptFailed?: (failure: ZhimoAttemptFailure) => void
}

/**
 * 有界重试编排（**只对 `timeout` / `network`**，其余 reason 一次都不重试）。
 *
 * 结构刻意写成"单次尝试由调用方提供，外层一个按 reason 判定是否继续的循环"
 * ——**不是**在每个 catch 里各写一遍重试，那样迟早出现
 * "某个分支漏了判定 → 变成无限重试 / 所有失败都重试"。
 *
 * 每次尝试都重新计时（`elapsedMs` 只算本次，`totalMs` 含退避与之前的尝试），
 * 诊断回调抛错会被吞掉（日志不该影响抓取结果）。
 */
async function runZhimoAttempts<T>(
  policy: ZhimoRetryPolicy,
  attemptOf: () => Promise<{ ok: true; value: T } | ZhimoStepFailure>
): Promise<{ ok: true; value: T } | ZhimoCoverFailure> {
  const startedAt = Date.now()

  let attempt = 1
  for (;;) {
    const attemptStartedAt = Date.now()
    const attemptResult = await attemptOf()
    const elapsedMs = Date.now() - attemptStartedAt
    const totalMs = Date.now() - startedAt

    // 成功：无论第几次尝试成功，行为与返回值都和改造前完全一致
    if (attemptResult.ok) return { ok: true, value: attemptResult.value }

    const willRetry = attempt < policy.maxAttempts && isRetryableZhimoReason(attemptResult.reason)
    const failure: ZhimoAttemptFailure = {
      reason: attemptResult.reason,
      step: attemptResult.step,
      attempt,
      elapsedMs,
      totalMs,
      willRetry
    }
    if (policy.onAttemptFailed) {
      try {
        policy.onAttemptFailed(failure)
      } catch {
        // 诊断回调（写日志）绝不能影响抓取结果
      }
    }

    // 不可重试（no-id 之外的全部业务失败）/ 已经是最后一发 → 到此为止
    if (!willRetry) return { ok: false, reason: attemptResult.reason }

    if (policy.backoffMs > 0) await policy.sleep(policy.backoffMs)
    attempt += 1
  }
}

/**
 * 抓取 + 校验（**有界重试**：只对 `timeout` / `network`，初次 + 1 次，退避 800ms）。
 *
 * 重试的是**整条流程**（而不是单步）：这样最坏耗时口径简单（每次尝试 = 一次
 * page 超时 + 一次 image 超时），也不会出现"页面已过期、却拿旧 HTML 里的 URL 再试一次图"。
 */
async function runFetchZhimoCover(opts: ZhimoCoverFetchOptions): Promise<ZhimoCoverOutcome> {
  // ── 步骤 1：ID 格式（不发任何请求，也**不重试**）────────────────────
  const id = String(opts.id ?? '').trim()
  if (!ZHIMO_ID_RE.test(id)) return { ok: false, reason: 'no-id' }

  const config: ZhimoAttemptConfig = {
    id,
    fetcher: opts.fetcher ?? defaultFetcher,
    pageTimeoutMs:
      typeof opts.pageTimeoutMs === 'number' && Number.isFinite(opts.pageTimeoutMs)
        ? Math.max(1, Math.floor(opts.pageTimeoutMs))
        : DEFAULT_PAGE_TIMEOUT_MS,
    imageTimeoutMs:
      typeof opts.imageTimeoutMs === 'number' && Number.isFinite(opts.imageTimeoutMs)
        ? Math.max(1, Math.floor(opts.imageTimeoutMs))
        : DEFAULT_IMAGE_TIMEOUT_MS,
    minWidth:
      typeof opts.minWidth === 'number' && Number.isFinite(opts.minWidth)
        ? opts.minWidth
        : DEFAULT_MIN_WIDTH
  }

  const result = await runZhimoAttempts<ZhimoCoverSuccess>(
    {
      maxAttempts: normalizeAttempts(opts.maxAttempts),
      backoffMs: normalizeBackoff(opts.retryBackoffMs),
      sleep: opts.sleep ?? realSleep,
      onAttemptFailed: opts.onAttemptFailed
    },
    async () => {
      const attempt = await attemptFetchZhimoCover(config)
      // 单次尝试用的是 `outcome` 字段名（历史形状），泛型编排统一用 `value`
      return attempt.ok ? { ok: true, value: attempt.outcome } : attempt
    }
  )
  // 失败对象形状（`{ ok:false, reason }`）与改造前一字不差
  return result.ok ? result.value : result
}

/**
 * 抓取知末封面（**公开入口**，绝不对调用方抛错）。
 *
 * 外层 `try/catch` 只是最后一道保险（例如运行时 `AbortSignal.timeout` 不可用、
 * 注入的桩抛出意外异常）：任何意外都收敛成 `network`，绝不让一个封面把
 * 主进程的 IPC handler 打挂。这类"意外异常"不重试（不是可识别的瞬时失败）。
 */
export async function fetchZhimoCover(opts: ZhimoCoverFetchOptions): Promise<ZhimoCoverOutcome> {
  try {
    return await runFetchZhimoCover(opts)
  } catch {
    return { ok: false, reason: 'network' }
  }
}

/** {@link refreshZhimoCoverInto} 的依赖注入口（全部可选；运行时只有 handler 的日志回调） */
export interface ZhimoCoverIntoDeps {
  fetcher?: ZhimoFetcher
  minWidth?: number
  pageTimeoutMs?: number
  imageTimeoutMs?: number
  maxAttempts?: number
  retryBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
  onAttemptFailed?: (failure: ZhimoAttemptFailure) => void
}

/**
 * 抓 + 校验 + 落盘（写 `<资产名>.cover.<ext>`，清理同族旧文件）；**绝不抛错**。
 *
 * 落盘完全复用 `coverImage.ts`：它内部会**再嗅一次魔数**并按 `coverImageExt(format)`
 * 命名 → PNG 源自然落 `.cover.png`、JPEG 源落 `.cover.jpg`，
 * 同时删掉同族的其它 `*.cover.*`（不会堆积旧格式的残留文件）。
 *
 * `folder` 的**库内越界校验由调用方（IPC handler）负责**：本模块不 import
 * electron / paths，不做任何库根判断（保持可单测）。
 *
 * `write-failed` **不重试**（磁盘/权限问题重试只会再失败一次），也不参与
 * `onAttemptFailed`（它不是"某一步网络失败"）。
 */
export async function refreshZhimoCoverInto(
  folder: string,
  id: string,
  deps?: ZhimoCoverIntoDeps
): Promise<FetchZhimoCoverResult> {
  const outcome = await fetchZhimoCover({
    id,
    fetcher: deps?.fetcher,
    minWidth: deps?.minWidth,
    pageTimeoutMs: deps?.pageTimeoutMs,
    imageTimeoutMs: deps?.imageTimeoutMs,
    maxAttempts: deps?.maxAttempts,
    retryBackoffMs: deps?.retryBackoffMs,
    sleep: deps?.sleep,
    onAttemptFailed: deps?.onAttemptFailed
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason }

  try {
    const written = await writeCoverImageInto(folder, outcome.buffer)
    return {
      ok: true,
      rel: written.rel,
      size: written.size,
      width: outcome.width,
      height: outcome.height,
      sourceHost: outcome.sourceHost,
      watermarked: outcome.watermarked,
      title: outcome.title,
      // 站方三级分类名（**原话，未映射**）：附加字段，落库前必须过 `mapZhimoCategory()`
      classifyBaseName: outcome.classifyBaseName,
      // 风格随封面一起回给渲染层（**未过滤**原始词）；写不写由 `logic/zhimoStyle.ts` 判定
      style: outcome.style
    }
  } catch (err) {
    // 目录不存在 / 权限不足 / 路径非法 —— 一律转成 reason，绝不抛给 IPC 层
    // 0.8.3：补一条带 folder 的 WARN（写盘 ENOENT 的取证通道 —— DB folder 与磁盘
    // 脱同步时，只有这里同时知道 folder 与失败原因；重试无意义，日志必须可定位）
    console.warn(
      '[idbox] zhimo:cover-write-failed',
      folder,
      err instanceof Error ? err.message : err
    )
    return { ok: false, reason: 'write-failed' }
  }
}

// ── 详情页元信息（只取详情页、绝不下图片）──────────────────────────────
//
// 为什么要这条入口：`fetchZhimoCover` 必须走完「详情页 → 下载图片 → 校验 ≥200px」
// 十步才算成功 —— 图片 404 / 太小会让"详情页其实已经拿到站方分类"一起丢掉。
// 这里只发**一次详情页 GET**，解析 `classifyBaseName` / `style` / `version` / `title`，
// **一个图片字节都不下载、不写盘**。
//
// ⚠️ 本节的任何函数**不得**出现图片 URL 拼接 / 图片下载调用：
// `tests/zhimoMeta.test.ts` 有源码守卫（切片断言），加图片逻辑会直接把测试打红。

/**
 * 详情页元信息（**全部来自同一次详情页 GET，零额外请求**）。
 *
 * 字段语义与 `ZhimoDetailExtras` 完全一致（复用同一个解析函数 `parseDetailExtras`）：
 * `null` = 站方没给 / 给了占位符 `--`，**不是错误**。
 */
export interface ZhimoMetaInfo {
  /** 站方三级分类名（如 `卡座沙发`）；未做本地映射，落库前查 `mapZhimoCategory()` */
  classifyBaseName: string | null
  /** 站方风格自由词；未经本地词表过滤 */
  style: string | null
  /** 站方上传版本（如 `sketchup 2014`）；不是 `.skp` 内嵌的真实版本 */
  version: string | null
  /** 站方标题 */
  title: string | null
  /**
   * 站方**完整分类路径**（`breadcrumb_data` 逐条原文，按 `level` 升序）。
   *
   * 【docs/35 T-01】这是「分类三源交叉验证」里的 **S2 源**：`classifyBaseName` 只有末级
   * 名字、给不出路径，而面包屑能还原 (一级, 二级)。**只解析、不落库** —— 判定归
   * `shared/classifyCrossCheck.ts` 的 `decideClassify()`，本模块不掺任何分类逻辑。
   *
   * `undefined` = 站方这一页没给面包屑（实测约 20% 的详情页没有），**不是空数组**：
   * "没有"与"空"是两件事（与 `ZhimoDetailInfo.breadcrumb` 同一口径）。
   */
  breadcrumb?: ZhimoBreadcrumbItem[]
}

/**
 * 详情页 HTML → 元信息（**纯函数，绝不抛错**）。
 *
 * 有效性判据（比取图路径**多一条**，但不冲突）：
 * 1. `parseZhimoDetail()` 认可（= 能解析出图 URL / JSON-LD 有 ImageObject）→ 有效；
 * 2. 或者页面给了扩展属性（`res.classifyBaseName` 或 `res.detailParamsExtract` 是对象）
 *    → 也有效 —— 这正是本入口存在的理由："页面在、只是图挂了"不该把分类一起丢掉。
 *
 * 两条都不满足（软 404 空壳 / 裸 404 / WAF 404）→ `null`，由调用方转 `not-found`。
 *
 * ⚠️ **绝不**因为 `classifyBaseName` 为 `null` 就返回 `null`：
 * "站方没给分类"与"这一页根本不存在"是两件事，前者是 `ok:true` + `null`。
 */
export function parseZhimoMeta(html: string): ZhimoMetaInfo | null {
  const source = typeof html === 'string' ? html : ''
  const res = detailResOf(pagePropsOf(source))
  const extras = parseDetailExtras(res)
  // 复用取图路径的有效性判据（软 404 的 `res` 既没有图也没有扩展属性）
  const detail = parseZhimoDetail(source)

  if (!detail && !extras) return null

  return {
    classifyBaseName: extras?.classifyBaseName ?? null,
    style: extras?.style ?? null,
    // `extras.version` 已经带 `res.version` 兜底；detail 再兜一次只为防 dpe 缺失
    version: extras?.version ?? detail?.version ?? null,
    title: detail?.title ?? nonEmptyString(res?.title),
    // 面包屑在 `parseZhimoDetail` 里已经解析好（同一个 `pageProps`，零额外成本）；
    // 无有效条目时**不带该字段**（`undefined`，不写空数组）
    ...(detail?.breadcrumb ? { breadcrumb: detail.breadcrumb } : {})
  }
}

/** 元信息成功结果（**扁平、可直接跨 IPC**） */
export interface ZhimoMetaSuccess {
  ok: true
  classifyBaseName: string | null
  style: string | null
  version: string | null
  title: string | null
  /** 站方完整分类路径（S2 源）；`undefined` = 这一页没给面包屑 */
  breadcrumb?: ZhimoBreadcrumbItem[]
}

/** 元信息失败：只有 `ok` + `reason`（与封面失败同一套枚举口径） */
export type ZhimoMetaFailure = { ok: false; reason: ZhimoCoverFailReason }

export type ZhimoMetaOutcome = ZhimoMetaSuccess | ZhimoMetaFailure

/** {@link fetchZhimoMeta} 的入参（默认值全部可覆盖，测试靠它把退避压到 0） */
export interface ZhimoMetaFetchOptions {
  id: string
  fetcher?: ZhimoFetcher
  /** 详情页超时（默认 {@link DEFAULT_PAGE_TIMEOUT_MS} = 10s） */
  pageTimeoutMs?: number
  /** 最多尝试次数（默认 {@link DEFAULT_MAX_ATTEMPTS} = 2；传 1 = 关闭重试） */
  maxAttempts?: number
  /** 重试退避毫秒（默认 {@link DEFAULT_RETRY_BACKOFF_MS} = 800；**测试传 0**） */
  retryBackoffMs?: number
  /** 退避用的 sleep（默认真实 setTimeout；测试注入即时桩） */
  sleep?: (ms: number) => Promise<void>
  /** 每次尝试失败的回调（只服务日志，不影响返回值） */
  onAttemptFailed?: (failure: ZhimoAttemptFailure) => void
}

/** 详情页超时归一（`NaN` / 非有限 / 负数一律回默认；与封面路径同一口径） */
function normalizePageTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_PAGE_TIMEOUT_MS
}

/** 元信息单次尝试：**只 GET 详情页** → 解析（不发任何图片请求） */
async function attemptFetchZhimoMeta(config: {
  id: string
  fetcher: ZhimoFetcher
  pageTimeoutMs: number
}): Promise<{ ok: true; value: ZhimoMetaInfo } | ZhimoStepFailure> {
  const page = await fetchDetailHtml(config.fetcher, config.id, config.pageTimeoutMs)
  if (!page.ok) return { ok: false, reason: page.reason, step: 'page' }

  const meta = parseZhimoMeta(page.html)
  // 页面两条有效性判据都不满足（软 404 / 裸 404 / 结构改版）→ 与封面路径同一个 reason
  if (!meta) return { ok: false, reason: 'not-found', step: 'page' }

  return { ok: true, value: meta }
}

/**
 * 只取详情页的轻量入口（**公开入口，绝不对调用方抛错**）。
 *
 * 与 {@link fetchZhimoCover} 的差异（**只有这些**）：
 * - 不发图片请求、不校验图片、不落盘 → 不需要 `folder`，也不会产生 `image` 步骤的失败；
 * - 返回值只带元信息（`classifyBaseName` / `style` / `version` / `title`）。
 *
 * 与它**保持一致**的部分：
 * - ID 校验（6 位以上纯数字，否则 `no-id` 且**一个请求都不发**）；
 * - 详情页抓取（同一 UA / `redirect: 'follow'` / `AbortSignal.timeout`）与解析；
 * - 有界重试（只对 `timeout` / `network`，`DEFAULT_MAX_ATTEMPTS` 次，退避 800ms）；
 * - `classifyBaseName` 为 `null` 时仍然 `ok:true`（"站方没给"不是错误）。
 */
export async function fetchZhimoMeta(opts: ZhimoMetaFetchOptions): Promise<ZhimoMetaOutcome> {
  try {
    // ── 步骤 1：ID 格式（不发任何请求，也**不重试**）──────────────────
    const id = String(opts.id ?? '').trim()
    if (!ZHIMO_ID_RE.test(id)) return { ok: false, reason: 'no-id' }

    const config = {
      id,
      fetcher: opts.fetcher ?? defaultFetcher,
      pageTimeoutMs: normalizePageTimeout(opts.pageTimeoutMs)
    }

    const result = await runZhimoAttempts<ZhimoMetaInfo>(
      {
        maxAttempts: normalizeAttempts(opts.maxAttempts),
        backoffMs: normalizeBackoff(opts.retryBackoffMs),
        sleep: opts.sleep ?? realSleep,
        onAttemptFailed: opts.onAttemptFailed
      },
      () => attemptFetchZhimoMeta(config)
    )

    if (!result.ok) return { ok: false, reason: result.reason }

    // 明确摊平成五个字段：`ZhimoMetaInfo` 将来加字段也不会意外扩大 IPC 契约
    return {
      ok: true,
      classifyBaseName: result.value.classifyBaseName,
      style: result.value.style,
      version: result.value.version,
      title: result.value.title,
      // 【docs/35 T-01】面包屑（S2 源）。没有就不带该字段（`undefined` ≠ 空数组）
      ...(result.value.breadcrumb ? { breadcrumb: result.value.breadcrumb } : {})
    }
  } catch {
    // 最后一道保险（运行时信号不可用 / 注入桩抛意外异常）：收敛成 reason，绝不抛错
    return { ok: false, reason: 'network' }
  }
}

