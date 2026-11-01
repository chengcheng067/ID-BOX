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
 * ## 大小写（2026-11 自查）：Windows 语义下不敏感
 *
 * Windows 文件系统大小写不敏感：`D:\ModVault\Library` 与 `d:\modvault\library` 是**同一个目录**。
 * 而本函数的两个入参来自不同地方——`settings.libraryDir`（用户可在设置里手改、库目录也可能被
 * 整体复制过）与 `asset.folder`（rescan 写的磁盘真名）——大小写一旦不一致，纯字符串比较会
 * 把合法路径判成越界，表现为一串 **fail-closed 的功能故障**（安全，但用户完全看不懂）：
 * - `main/trash.ts:234` 软删报「资产路径不在库内」→「最近删除」偶发失效；
 * - `main/index.ts:1380` 换封面被拒；
 * - `main/index.ts:1561` 拖不出文件。
 *
 * 所以：**只在 `sep === '\\'` 时**（= 调用方传的就是 Windows 的 `path.sep`）按小写比较；
 * POSIX 保持原样（Linux 是大小写敏感的，不能连坐）。这个判断在所有调用点都成立——它们
 * 传的就是 `path.sep`；也不需要 import `node:path`（本文件被渲染层共用，不能依赖 node 内置模块）。
 *
 * ⚠️ 签名固定三参，不许加第四参（7 个调用点 + 渲染层都按三参调用）。
 *
 * @param root 已 resolve 的绝对路径根目录
 * @param abs  已 resolve 的绝对路径目标
 * @param sep  平台路径分隔符（`path.sep`）
 */
export function isWithinRoot(root: string, abs: string, sep: string): boolean {
  if (!root || !abs) return false
  // Windows 语义下路径大小写不敏感：`D:\ModVault\Library` 与 `d:\modvault\library` 是同一目录。
  // 只在 sep 为反斜杠（= 调用方传的是 path.sep 且运行在 Windows）时启用，
  // POSIX 保持原样 —— 这个判断在所有调用点都成立（它们传的就是 `path.sep`），
  // 且不需要 import node:path（本文件被渲染层共用，不能依赖 node 内置模块）。
  if (sep === '\\') {
    const r = root.toLowerCase()
    const a = abs.toLowerCase()
    if (a === r) return true
    const base = r.endsWith(sep) ? r : r + sep
    return a.startsWith(base)
  }
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
