/**
 * `vault://` 协议的**纯路由判定**（T04）——不 import electron / node:*，可单测。
 *
 * 两种 host：
 * - `vault://asset/<相对库根路径>`  → 库目录（原图）
 * - `vault://thumb/<缓存文件名>`    → 缩略图缓存目录（网格只读这个）
 */

export type VaultHost = 'asset' | 'thumb'

/** host → 路由；未知 host 返回 null（由调用方回 404） */
export function routeVaultHost(host: string): VaultHost | null {
  const h = (host ?? '').toLowerCase()
  if (h === 'asset') return 'asset'
  if (h === 'thumb') return 'thumb'
  return null
}

/**
 * 目录穿越防护：abs 必须等于 root，或位于 root 之下。
 * 调用方负责先用 `path.resolve` 归一化，本函数只做**包含判定**（纯字符串，可单测）。
 *
 * @param root 已 resolve 的绝对路径根目录
 * @param abs  已 resolve 的绝对路径目标
 * @param sep  平台路径分隔符（`path.sep`）
 */
export function isWithinRoot(root: string, abs: string, sep: string): boolean {
  if (!root || !abs) return false
  if (abs === root) return true
  const base = root.endsWith(sep) ? root : root + sep
  return abs.startsWith(base)
}

/** 拼出 vault URL（渲染层与协议层共用同一套编码规则） */
export function vaultHostUrl(host: VaultHost, relPath: string): string {
  const encoded = relPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `vault://${host}/${encoded}`
}

// ── CORS 响应头（2026-10 材质球阻塞修复） ──────────────────────────────
//
// 背景：vault:// 对渲染进程是**跨源**协议，材质球用 three.js TextureLoader
// （`crossOrigin='anonymous'`）加载 `vault://asset/...` 贴图时会被 CORS 拦掉
// ——表现为"球是灰的"，且失败只 warn 不崩（用户只觉得没贴图）。
// `registerSchemesAsPrivileged` 的 `bypassCSP` **不涉 CORS**，必须靠响应头放行。
//
// 抽成纯函数（零 electron / 零 DOM）以便单测；成功响应与 403/404 都加，
// 避免调试时把"CORS 失败"和"文件不存在"混成同一种现象。

/** vault:// 协议的成功/错误响应统一加的 CORS 头 */
export function vaultResponseHeaders(status = 200): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    // 允许跨源把 vault:// 资源当子资源用（WebGL 贴图 / <img>）
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // 带 status 便于调用方按状态码决定是否复用缓存（不影响 CORS 语义）
    'X-Vault-Status': String(status)
  }
}

/**
 * 给已有响应头补上 CORS 放行头。
 * 入参/出参都只要求 `get/set` 鸭子类型（**不写死 DOM 的 Headers**，
 * 这样本文件在 node 环境零依赖，单测直接可用）。
 */
export function applyVaultCorsHeaders<T extends { set(k: string, v: string): void }>(
  headers: T,
  status = 200
): T {
  for (const [k, v] of Object.entries(vaultResponseHeaders(status))) headers.set(k, v)
  return headers
}
