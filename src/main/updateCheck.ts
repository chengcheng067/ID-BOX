/**
 * 自动检查更新（GitHub Releases）——**纯函数 + 一次 fetch**，零第三方依赖。
 *
 * 设计约束（用户需求 + 工程质量）：
 * 1. **绝不影响启动**：任何失败都折进 `UpdateInfo.error`，本模块**从不抛异常**；
 *    调用方（主进程 IPC handler）直接返回结果即可，不需要 try/catch。
 * 2. **绝不真联网做单测**：`fetchLatestRelease` 接受注入的 `fetcher`，测试传桩。
 * 3. **不在本模块 import electron**：`app.getVersion()` 由调用方传进来，
 *    这样 `tests/*.test.ts`（node 环境）可以直接 import 本文件而不需要 electron 运行时。
 * 4. 未认证请求（不带 Authorization）：GitHub 限流 60 次/小时/IP，
 *    每次启动 1 次 + 手动点击少量，足够；带 token 反而会把用户凭据写进源码。
 */
import type { UpdateInfo } from '../shared/types'

export type { UpdateInfo }

/** 公开仓库的「最新正式版」端点（`/releases/latest` 本身已排除 draft / prerelease） */
export const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/chengcheng067/ID-BOX/releases/latest'

/** 请求超时：8 秒。断网 / DNS 挂掉时不能让 UI 的「正在检查…」无限转。 */
export const UPDATE_CHECK_TIMEOUT_MS = 8_000

/** 安装包资产名规则：`IDBOX-Setup-<version>.exe`（见 package.json 的 artifactName） */
const ASSET_PREFIX = 'IDBOX-Setup-'
const ASSET_SUFFIX = '.exe'

/**
 * 最小化的 fetch 形参类型：真实 `fetch` 可直接赋值（参数/返回值双向兼容），
 * 测试里手写的桩也不必构造完整的 `Response`。
 */
export interface UpdateFetchInit {
  headers: Record<string, string>
  signal?: AbortSignal
}

/** 只用到 `ok` / `status` / `json()` —— 不依赖 DOM 的完整 Response 类型 */
export interface UpdateFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type UpdateFetcher = (
  url: string,
  init: UpdateFetchInit
) => Promise<UpdateFetchResponse>

/** `fetchLatestRelease` 的可选入参（全部为可注入项，便于单测） */
export interface FetchLatestReleaseOptions {
  /** 当前版本（无 v 前缀）。生产传 `app.getVersion()`；缺省按 `0.0.0` 处理 */
  current?: string
  /**
   * 允许测试注入的 fetcher。生产不传 → 用 `globalThis.fetch`（Electron 33 / Node 20+ 自带）。
   * 传 `null` 表示「刻意没有网络能力」，直接返回 network 错误。
   */
  fetcher?: UpdateFetcher | null
  /** 超时毫秒（缺省 8s） */
  timeoutMs?: number
  /** 结果里的 `checkedAt`（缺省 Date.now()；测试注入固定值） */
  now?: number
}

/** 解析后的版本：数字段 + 预发布后缀（`1.0.0-beta.2` 的 `beta.2`） */
interface ParsedVersion {
  parts: number[]
  /** 空串 = 正式版（正式版 **大于** 同号预发布版） */
  prerelease: string
}

/**
 * 解析版本号：'v0.6.8' / 'V0.7.0' / '0.7' / '1.2.3+build.7' / '1.0.0-beta.2'。
 *
 * 返回 `null` 表示不是可比较的版本（例如 'latest'、'abc'）——
 * 调用方应当把它当作解析失败，而不是猜一个数字。
 */
function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s) return null
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1)
  // 构建元数据（+build.7）不参与比较
  const plus = s.indexOf('+')
  if (plus >= 0) s = s.slice(0, plus)
  // 预发布后缀（-beta.2）：只做「有/无」比较，避免实现一套多余的 semver 规则
  let prerelease = ''
  const dash = s.indexOf('-')
  if (dash >= 0) {
    prerelease = s.slice(dash + 1)
    s = s.slice(0, dash)
  }
  if (!s) return null
  const parts: number[] = []
  for (const seg of s.split('.')) {
    // 只接受纯数字段：'0.6.x' 不是版本号，不能静默当 0 处理（会误判成 0.6.0）
    if (!/^\d+$/.test(seg)) return null
    parts.push(Number.parseInt(seg, 10))
  }
  if (parts.length === 0) return null
  return { parts, prerelease }
}

/** 去掉 `v` 前缀的展示用版本（解析失败时原样返回，仅裁剪空白） */
export function normalizeVersion(input: string): string {
  if (typeof input !== 'string') return ''
  let s = input.trim()
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1)
  return s
}

/**
 * 语义化版本比较（**数字逐段比较，绝不字符串比较**）。
 *
 * @returns `-1` = a < b；`0` = 相等；`1` = a > b
 *
 * 边界：
 * - `'0.6.10' > '0.6.9'`（字符串比较会得出相反结论）
 * - `'v0.7.0' > '0.6.8'`（v 前缀不影响）
 * - `'0.6.8' == 'v0.6.8'`（版本相同视为相等）
 * - `'0.7' > '0.6.9'`（位数不齐按缺位 0 补齐）
 * - `'1.0.0' > '1.0.0-beta'`（正式版大于预发布版）
 * - 任一侧无法解析时退化为**字符串比较**（保证「有返回值、不抛错」）
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) {
    const sa = normalizeVersion(a)
    const sb = normalizeVersion(b)
    if (sa === sb) return 0
    return sa < sb ? -1 : 1
  }
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i += 1) {
    // 缺位按 0 补齐：'0.7' 等价于 '0.7.0'
    const na = pa.parts[i] ?? 0
    const nb = pb.parts[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  // 数字部分相同：正式版 > 预发布版；两个预发布版之间按字典序（够用且稳定）
  const preA = pa.prerelease
  const preB = pb.prerelease
  if (preA === preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return preA < preB ? -1 : 1
}

/** 从 release JSON 里挑安装包直链（`IDBOX-Setup-*.exe`），挑不到返回 null */
function pickAssetUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const asset = item as Record<string, unknown>
    const name = typeof asset.name === 'string' ? asset.name.trim() : ''
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!name || !url) continue
    const lower = name.toLowerCase()
    if (lower.startsWith(ASSET_PREFIX.toLowerCase()) && lower.endsWith(ASSET_SUFFIX)) {
      return url
    }
  }
  return null
}

/** 读一个可选字符串字段（非字符串 → null），空串也归 null */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s ? s : null
}

/** 空结果（`error` 由调用方补） */
function emptyInfo(current: string, checkedAt: number, error: UpdateInfo['error']): UpdateInfo {
  return {
    current,
    latest: null,
    hasUpdate: false,
    url: null,
    assetUrl: null,
    publishedAt: null,
    checkedAt,
    error
  }
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较。
 *
 * **永不抛错**：网络异常 / 超时 → `error:'network'`；非 2xx → `error:'http'`；
 * JSON 结构不符（缺 `tag_name`、tag 不是版本号）→ `error:'parse'`。
 *
 * `prerelease === true` / `draft === true` 一律视为「无更新」（`hasUpdate:false`，
 * `error:null`）—— 即使将来端点行为变化，用户也不会被推到测试版上。
 */
export async function fetchLatestRelease(
  opts: FetchLatestReleaseOptions = {}
): Promise<UpdateInfo> {
  const current = normalizeVersion(opts.current ?? '0.0.0') || '0.0.0'
  const checkedAt = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : UPDATE_CHECK_TIMEOUT_MS

  const fetcher: UpdateFetcher | null =
    opts.fetcher === null
      ? null
      : (opts.fetcher ??
        (typeof globalThis.fetch === 'function'
          ? (globalThis.fetch as unknown as UpdateFetcher)
          : null))

  if (!fetcher) return emptyInfo(current, checkedAt, 'network')

  // AbortSignal.timeout 在 Electron 33 (Node 20+) / 现代浏览器都有；
  // 旧运行时没有就退化成「无超时」，功能仍可用（只是断网时要等系统超时）。
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined

  let res: UpdateFetchResponse
  try {
    res = await fetcher(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `IDBOX/${current}`
      },
      signal
    })
  } catch {
    // DNS 失败 / 断网 / TLS 错误 / 超时（AbortError）全部落在这里
    return emptyInfo(current, checkedAt, 'network')
  }

  if (!res || typeof res.ok !== 'boolean') return emptyInfo(current, checkedAt, 'network')
  if (!res.ok) return emptyInfo(current, checkedAt, 'http')

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return emptyInfo(current, checkedAt, 'parse')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return emptyInfo(current, checkedAt, 'parse')
  }

  const release = body as Record<string, unknown>
  const rawTag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const latest = normalizeVersion(rawTag)
  const parsed = parseVersion(rawTag)
  // tag 缺失 / 不是版本号（'latest'、'nightly'）→ parse 失败，不当成"有更新"
  if (!latest || !parsed) return emptyInfo(current, checkedAt, 'parse')

  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate: false,
    url: optionalString(release.html_url),
    assetUrl: pickAssetUrl(release.assets),
    publishedAt: optionalString(release.published_at),
    checkedAt,
    error: null
  }

  // draft / prerelease：明确当作「无更新」（`/releases/latest` 正常不会返回它们，
  // 这里是对未来端点行为变化 + 手工错误标记的防御）
  if (release.prerelease === true || release.draft === true) return info

  info.hasUpdate = compareVersions(latest, current) > 0
  return info
}
