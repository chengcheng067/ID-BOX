/** 展示层格式化工具（纯函数，可测试） */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * 给 URL 追加 `?v=<version>` 版本参数（**只用于破缓存**，不参与协议路由）。
 *
 * 为什么协议侧安全：`main/protocol.ts:serveStatic()` 只取 `url.pathname` 定位文件，
 * query 被忽略；`vault` 已在 `registerSchemesAsPrivileged` 里声明为 `standard`，
 * 因此 `?v=` 是合法 URL 的一部分，同时又是 Chromium HTTP 缓存 key 的一部分
 * ——版本变了必然重新取字节。
 *
 * 空 / `null` / `undefined` → 原样返回：老调用点保持**逐字符不变**（不动全局缓存策略）。
 */
function withVersion(url: string, version?: string | number | null): string {
  if (version === undefined || version === null) return url
  const v = String(version).trim()
  if (v.length === 0) return url
  return `${url}?v=${encodeURIComponent(v)}`
}

/**
 * "模型/某沙发/preview.jpg" → vault://asset/模型/某沙发/preview.jpg
 * 路径必须**逐段** encodeURIComponent：中文与空格若不编码会破坏协议解析，
 * 整体编码则会把 '/' 变成 %2F，同样不可用。
 *
 * @param version 可选的缓存版本（通常是 `asset.updatedAt`）。同一路径被**原地覆盖**
 *   新内容时（例如封面写盘、重新截图），路径与 URL 都没变，Chromium 会直接用旧缓存；
 *   传版本后 URL 变化 → 强制重新解码新字节。不传则与旧行为完全一致。
 */
export function vaultUrl(relPath: string, version?: string | number | null): string {
  const base = 'vault://asset/' + relPath.split('/').map(encodeURIComponent).join('/')
  return withVersion(base, version)
}

/** 缩略图缓存文件名 → vault://thumb/<name>（P0-9，网格只读缩略图） */
export function thumbVaultUrl(cacheName: string): string {
  return `vault://thumb/${encodeURIComponent(cacheName)}`
}
