/**
 * 拖拽卡片用的 **≤1024 预览图** 解析层（docs/26 方案 C + H）。
 *
 * ## 为什么需要这一层
 *
 * 拖拽卡片原来拿的是**原图 URL**（`vault://asset/.../某贴图.jpg`）。一张 8K 贴图
 * 拖一次要解码几十 MB，hover 预热时直接把主线程按住（`docs/26` 实测）。
 * 改成：hover → `thumb:preview` IPC 让主进程生成 / 复用 ≤1024 的预览图 → 渲染层
 * 只用这个 URL 画卡片。
 *
 * ## 三条纪律
 *
 * ① **绝不抛**：`ensurePreview` 失败（源文件读不了、TGA/EXR 解码不了、越界）一律
 *    返回 `null`，调用方必须回退缩略图 / 原图 —— 拖拽绝不能因为预览失败而失效。
 * ② **不重复请求**：同一 `(id, absPath)` 的并发调用共用同一个 Promise（in-flight 去重）；
 *    成功 / 失败都缓存 {@link PREVIEW_URL_TTL_MS}，扫过一排卡片时不会一次 IPC 一条。
 * ③ **可在 node 环境单测**：不 import React / DOM，`window` 只是**鸭子类型**读取，
 *    `tests/previewThumb.test.ts` 直接注入假 API。
 */

import { thumbVaultUrl } from '../../shared/format'

/**
 * 结果缓存 TTL（ms）。
 *
 * 为什么要 TTL 而不是永久缓存：文件名里带**内容身份 salt**（路径 + mtime + size），
 * 源文件被原地覆盖（例如 HDR「拍照」写回同一个 `.cover.png`）后必须重新问一次主进程
 * 才能拿到新文件名。30s 足够覆盖"在一屏卡片上来回扫"的操作节奏，又不会长期钉死旧图。
 */
export const PREVIEW_URL_TTL_MS = 30_000

/** 主进程能力（`window.modvault.ensurePreview` 的结构子集，便于测试注入） */
export interface PreviewApi {
  ensurePreview: (id: string, absPath: string | null) => Promise<string | null>
}

/** `ensurePreviewUrl` 的依赖（都可省略：省略时读 `window.modvault`） */
export interface PreviewUrlDeps {
  /** 覆盖主进程 API（单测注入；传 `null` = 强制"没有能力"） */
  api?: PreviewApi | null
  /** 时间源（默认 `Date.now`，单测注入以跨过 TTL） */
  now?: () => number
}

interface CacheEntry {
  url: string | null
  at: number
}

/** `(id, absPath) → {url, at}`；失败（url=null）也缓存，避免 hover 风暴把主进程打满 */
const urlCache = new Map<string, CacheEntry>()

/** 同一个键的并发请求去重（hover 抖动 / 两个树同时预热） */
const inflight = new Map<string, Promise<string | null>>()

/** 缓存键：id 与路径都必须参与（同一资产的不同文件各有各的预览） */
export function previewCacheKey(id: string, absPath: string): string {
  return `${id}\u0000${absPath}`
}

/** 从 `window.modvault` 取能力；node 环境 / 未注入 / 旧 preload 一律 null（**不抛**） */
function apiFromWindow(): PreviewApi | null {
  if (typeof window === 'undefined') return null
  try {
    const api = window.modvault as Partial<PreviewApi> | undefined
    if (!api || typeof api.ensurePreview !== 'function') return null
    return api as PreviewApi
  } catch {
    return null
  }
}

/** 清空缓存（单测用；正常运行时不需要） */
export function clearPreviewUrlCache(): void {
  urlCache.clear()
  inflight.clear()
}

/**
 * **同步**读已解析过的预览 URL（命中且未过期才有值）。
 *
 * 用途：第二次 hover 同一张卡片时，`dragstart` 前的预热可以零 IPC 直接用预览图
 * （`DetailPanel` / `AssetGrid` 的文件视图都先 `peek`，再决定底图）。
 * 未命中 / 已过期 → `null`（调用方继续用缩略图或原图，并异步请求）。
 */
export function peekPreviewUrl(
  id: string,
  absPath: string | null | undefined,
  deps?: Pick<PreviewUrlDeps, 'now'>
): string | null {
  if (!id || !absPath) return null
  const key = previewCacheKey(id, absPath)
  const hit = urlCache.get(key)
  if (!hit) return null
  const nowFn = deps?.now ?? Date.now
  if (nowFn() - hit.at > PREVIEW_URL_TTL_MS) {
    urlCache.delete(key)
    return null
  }
  return hit.url
}

/**
 * 请求（或复用）预览图 URL：`vault://thumb/<id>-<salt>-p1024.<ext>`。
 *
 * @param id 资产 id（与主进程文件名里的 id 一致，供 prune/delete 归属）
 * @param absPath 源文件绝对路径；空值直接返回 null（不请求）
 * @param deps 单测注入；省略时读 `window.modvault.ensurePreview`
 * @returns 可直接塞进 `<img>` / canvas 的 URL；任何失败都是 `null`（**绝不抛**）
 */
export async function ensurePreviewUrl(
  id: string,
  absPath: string | null | undefined,
  deps: PreviewUrlDeps = {}
): Promise<string | null> {
  if (!id || !absPath) return null
  const key = previewCacheKey(id, absPath)
  const nowFn = deps.now ?? Date.now

  const hit = urlCache.get(key)
  if (hit && nowFn() - hit.at <= PREVIEW_URL_TTL_MS) return hit.url

  const running = inflight.get(key)
  if (running) return running

  const api = deps.api !== undefined ? deps.api : apiFromWindow()
  if (!api) return null

  const task = (async (): Promise<string | null> => {
    try {
      const name = await api.ensurePreview(id, absPath)
      const url = name ? thumbVaultUrl(name) : null
      urlCache.set(key, { url, at: nowFn() })
      return url
    } catch {
      // preload 抛错（IPC 断了 / 主进程重启中）：按"没有预览"处理，短 TTL 后可重试
      urlCache.set(key, { url: null, at: nowFn() })
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}
