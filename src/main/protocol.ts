import { protocol, net } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyVaultCorsHeaders, isWithinRoot, routeVaultHost, vaultResponseHeaders } from '../shared/vault'

/**
 * `vault://` 自定义协议（绕开 Electron 对 file:// + CSP 的限制，R7）
 *
 * 三种 host：
 * - `vault://asset/模型/某沙发/preview.jpg` → 库根目录（原图，详情面板用）
 * - `vault://thumb/<id>-<salt>.jpg`        → 缩略图缓存目录（网格只读这个，P0-9）
 * - `hdr://<key>.hdr`                     → HDR 预览缓存目录（0.6.5，`<userData>/hdr-cache`）
 *
 * **三个目录都要做 `path.resolve` + `startsWith(dir + sep)` 越界检查**（不能只给库根做）。
 *
 * `hdr://` 单列一个 scheme 而不是加 vault host：`routeVaultHost`（`shared/vault.ts`）
 * 的 host 白名单被单测锁死，且那边的判据是"库内容 vs 缓存"两类；HDR 缓存是
 * 第三种生命周期（按 `sha1(源路径+size+mtime+宽度)` 生成、可整体清空），
 * 用独立 scheme 语义更清楚，也不动既有安全边界。
 */

/**
 * 注册 vault / hdr 协议。
 *
 * `corsEnabled: true`（2026-10 材质球阻塞修复）：让 Chromium 按 CORS 规则对待
 * vault://，配合下面 `serveVault` 的 `Access-Control-Allow-Origin` 响应头，
 * three.js TextureLoader（`crossOrigin='anonymous'`）才能把库里的贴图上传成
 * WebGL 纹理——否则材质球"贴图全失败、球是灰的"（失败只 warn 不崩，极难排查）。
 * 注意 `bypassCSP` 不涉 CORS，两者必须各配各的。
 *
 * `hdr://` 需要同一套权限：three 的 `HDRLoader` 走 FileLoader（fetch + arraybuffer），
 * 没有 `supportFetchAPI` / `corsEnabled` 会直接读不到缓存文件。
 */
export function registerVaultScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'vault',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    },
    {
      scheme: 'hdr',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

export interface VaultDirs {
  /** 库根目录（asset host） */
  libraryDir: string
  /** 缩略图缓存目录（thumb host） */
  thumbsDir: string
  /** HDR 预览缓存目录（hdr scheme；`<userData>/hdr-cache`） */
  hdrDir: string
}

export function serveVault(getDirs: () => VaultDirs): void {
  protocol.handle('vault', async (request) => serveStatic(request, getDirs, 'vault'))
  // HDR 缓存走独立 scheme，但复用同一份路由/越界校验/CORS 头实现（不复制一遍）
  protocol.handle('hdr', async (request) => serveStatic(request, getDirs, 'hdr'))
}

/**
 * 两个 scheme 共用的静态文件服务：host 判定 → resolve → 越界检查 → 透传 body + CORS 头。
 *
 * `scheme === 'hdr'` 时 host 固定为缓存目录（`hdr://<key>.hdr`，无 host 语义），
 * 因此只认 `hdr` host 自身（Electron 的 URL 解析会把 `hdr://<key>.hdr` 的 host 解析成
 * `<key>.hdr`），路径直接取 pathname。
 */
async function serveStatic(
  request: Request,
  getDirs: () => VaultDirs,
  scheme: 'vault' | 'hdr'
): Promise<Response> {
  // CORS 预检（OPTIONS）直接放行：否则带自定义头的跨源请求会在预检阶段被挡
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: vaultResponseHeaders(204) })
  }
  try {
    const url = new URL(request.url)
    const dirs = getDirs()

    let root: string
    let rel: string
    if (scheme === 'hdr') {
      root = path.resolve(dirs.hdrDir)
      // `hdr://abc.hdr` → host = 'abc.hdr'；也兼容把文件名写在 pathname 的写法
      const fromHost = decodeURIComponent(url.host)
      const fromPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      rel = fromPath.length > 0 ? fromPath : fromHost
    } else {
      const host = routeVaultHost(url.host)
      if (!host) {
        return new Response('unknown vault host', { status: 404, headers: vaultResponseHeaders(404) })
      }
      root = path.resolve(host === 'asset' ? dirs.libraryDir : dirs.thumbsDir)
      rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    }

    const abs = path.resolve(root, rel)

    // 防目录穿越（三个目录一视同仁）
    if (!isWithinRoot(root, abs, path.sep)) {
      return new Response('forbidden', { status: 403, headers: vaultResponseHeaders(403) })
    }
    await fs.access(abs)
    const resp = await net.fetch(pathToFileURL(abs).href)
    // 原样透传 body/status，只补 CORS 头（贴图/缩略图/HDR 跨源加载必需）
    return new Response(resp.body, {
      status: resp.status,
      headers: applyVaultCorsHeaders(new Headers(resp.headers), resp.status)
    })
  } catch {
    return new Response('not found', { status: 404, headers: vaultResponseHeaders(404) })
  }
}
