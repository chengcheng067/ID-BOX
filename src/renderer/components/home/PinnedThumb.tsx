/**
 * 浏览器条目缩略图（图片与 SKP）的**请求 + 展示**一体小组件。
 *
 * 策略（docs/61 预览图批注口径）：
 * - **按需请求**：只有扩展名白名单内的文件（jpg/jpeg/png/webp/bmp/gif/skp）在
 *   渲染条目时向主进程请求一次（`pinnedFileThumb`，主进程侧有串行队列）；
 * - **缓存**：URL 存进组件级 `ThumbUrlLru`（上限 500，见 `pinnedBrowser.ts`），
 *   切目录回来不重新请求；组件挂载时先查缓存再发 IPC；
 * - **请求中显示现有图标占位**（不闪空白）；失败 / 通道未就绪 / 不支持 →
 *   `PinnedTypeVisual` 类型兜底（SU/max/CAD/D5A 大字卡或类型图标）；
 * - **主进程未就绪**：`pinnedThumbApi()` 探针返回 null 时直接判失败走兜底，
 *   不发请求（探针模式，与 `pinnedWriteApi` 同款）——主进程落地后自动接通。
 *
 * ⚠️ 两种视图共用本组件：调用方负责容器尺寸（列表 28px 方块 / 图标视图 56px 磁贴 /
 * Quick Look 大画框），`<img>` 一律 `h-full w-full object-contain` 撑满容器。
 */
import { useEffect, useState, type ReactElement } from 'react'
import {
  isThumbCapableName,
  pinnedThumbApi,
  thumbCacheKey,
  ThumbUrlLru
} from '../../logic/pinnedBrowser'
import type { FsEntry } from '../../../shared/ipc'
import { PinnedTypeVisual } from './fileTypeBadge'

/** 组件级缓存（模块单例：跨目录切换存活；上限 500 条 LRU） */
const thumbCache = new ThumbUrlLru(500)

/** 单个条目缩略图的请求状态（idle = 不需要缩略图，直接走兜底） */
export type PinnedThumbStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface PinnedThumbState {
  status: PinnedThumbStatus
  /** status === 'ready' 时的协议 URL（pinned-thumb://…），可直接当 img src */
  url: string | null
}

/**
 * 请求一个条目的缩略图（先查 LRU，未命中再走 IPC；通道未就绪直接 failed）。
 * 依赖里用 key（含 dirRel+name+mtime）而非裸 name：换目录同名文件重新判；
 * 带上 mtime 与主进程缓存键口径一致（主进程缓存键含 mtime，文件外部修改后
 * 会产出新 URL）—— 渲染层 LRU 同步带上，旧 URL 不会被误命中。
 */
export function usePinnedThumb(pinId: string, dirRel: string, entry: FsEntry): PinnedThumbState {
  const capable = isThumbCapableName(entry)
  const key = capable
    ? `${thumbCacheKey(dirRel, entry.name)}\u0001${entry.mtimeMs ?? 'na'}`
    : ''
  const [state, setState] = useState<PinnedThumbState>(() => {
    const cached = capable ? thumbCache.get(key) : null
    return cached !== null ? { status: 'ready', url: cached } : { status: 'idle', url: null }
  })

  useEffect(() => {
    if (!capable) {
      setState({ status: 'idle', url: null })
      return
    }
    const cached = thumbCache.get(key)
    if (cached !== null) {
      setState({ status: 'ready', url: cached })
      return
    }
    setState({ status: 'loading', url: null })
    const api = pinnedThumbApi()
    if (api === null) {
      // 主进程通道未就绪（探针模式）：直接兜底，不发起请求
      setState({ status: 'failed', url: null })
      return
    }
    let cancelled = false
    void api
      .pinnedFileThumb({ pinId, dirRel, name: entry.name })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          thumbCache.put(key, result.url)
          setState({ status: 'ready', url: result.url })
        } else {
          setState({ status: 'failed', url: null })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed', url: null })
      })
    return () => {
      cancelled = true
    }
  }, [pinId, dirRel, key, capable, entry.name])

  return state
}

export interface PinnedThumbVisualProps {
  pinId: string
  dirRel: string
  entry: FsEntry
  /** 兜底图标 / 徽标的尺寸（Quick Look 传大值，如 160） */
  iconSize?: number
  /** 追加的 img 类（一般不用；img 恒 h-full w-full object-contain） */
  className?: string
}

export function PinnedThumbVisual({
  pinId,
  dirRel,
  entry,
  iconSize = 16,
  className = ''
}: PinnedThumbVisualProps): ReactElement {
  const state = usePinnedThumb(pinId, dirRel, entry)
  /** 记录**哪一个 src** 加载失败（不是布尔值）：url 一变自然复位自动重试，
   *  与 `AssetGrid.Cover` 的 brokenSrc 同手法（缓存文件可能被外部清掉） */
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)

  if (state.status === 'ready' && state.url !== null && brokenSrc !== state.url) {
    return (
      <img
        src={state.url}
        alt={entry.name}
        draggable={false}
        loading="lazy"
        onError={() => setBrokenSrc(state.url)}
        className={`h-full w-full bg-canvas object-contain ${className}`}
      />
    )
  }
  // idle（不支持）/ loading（请求中，占位不闪空白）/ failed / img 加载失败 → 类型兜底
  return <PinnedTypeVisual name={entry.name} isDir={entry.isDir} size={iconSize} className={className} />
}

export default PinnedThumbVisual
