/**
 * 已解码位图（`ImageBitmap`）的 **LRU 缓存**（性能修复 D · 改造版）。
 *
 * ── 为什么缓 ImageBitmap 而不是 `THREE.Texture` ───────────────────────────
 * `Texture` 绑定在具体 WebGL 上下文上：球卸载时 renderer 会 `dispose()` + `forceContextLoss()`，
 * 缓下来的 Texture 立刻失效（再上传会报 INVALID_OPERATION 或渲黑）。`ImageBitmap` 与上下文
 * 无关，命中后只需重新 `texImage2D` 上传（实测 5 张约 42ms），省掉的是 480ms 级的 CPU 解码。
 *
 * ── 为什么不在这里调用 `close()`（逐出路径）────────────────────────────────
 * 被逐出的 bitmap **可能仍被场上某个仍存活的 Texture 引用**（换资产时旧 Texture 刚被
 * dispose、但同一帧里可能还有一次渲染；多场景共存时更明显）。此时 `close()` 会让
 * `texImage2D` 拿到已释放的源 → 黑块 / 抛异常。
 * 因此：**逐出只丢引用，交给 GC**（引用计数方案要在每条 dispose 路径上配对 -1，
 * 漏一处就是泄漏或提前释放，收益不抵风险）。`clear()` / `reset()` 是唯一会 `close()` 的地方，
 * 它们只在**测试重置**与**进程收尾**时调用。
 *
 * 纯逻辑：不 import three / DOM API（只依赖 `ImageBitmap` 的结构形状），可在 node 里单测。
 */

/** 缓存条目的最小接口（`ImageBitmap` 结构上满足：width / height / close()） */
export interface CacheableBitmap {
  width: number
  height: number
  close(): void
}

/** 缓存统计快照（给 debug 日志与测试用；`stats()` 是 O(1)，不在热路径上遍历） */
export interface BitmapCacheStats {
  /** 命中次数（累计） */
  hits: number
  /** 未命中次数（累计，由调用方在查不到时记一次） */
  misses: number
  /** 当前占用字节数（按 w × h × 4 估算） */
  bytes: number
  /** 当前条目数 */
  entries: number
}

/** 默认字节上限 64MB：1024² RGBA 一张 4MB，够放 3 套材质的常用贴图 */
export const DEFAULT_BITMAP_CACHE_BYTES = 64 * 1024 * 1024
/** 默认条数上限：防止"几千张 64×64 小图"把 Map 撑爆（字节远没到上限但条目爆炸） */
export const DEFAULT_BITMAP_CACHE_ENTRIES = 48

/**
 * 缓存 key：`url|WxH`。
 *
 * **目标尺寸必须进 key**：同一张图在不同的解码上限下（例如将来把 `MAX_TEX_PX` 调成 512）
 * 不能串味；而且尺寸是"这次解码真正产生的像素数"，缓存与解码是同一口径。
 * `imageOrientation: 'flipY'` 是全局常量，不进 key。
 */
export function bitmapCacheKey(url: string, width: number, height: number): string {
  return `${url}|${width}x${height}`
}

interface CacheEntry<V extends CacheableBitmap> {
  bitmap: V
  bytes: number
}

/** 一张位图按 RGBA 8bit 估算的显存/内存占用 */
export function bitmapBytes(bitmap: { width: number; height: number }): number {
  return Math.max(1, Math.floor(bitmap.width)) * Math.max(1, Math.floor(bitmap.height)) * 4
}

/**
 * 位图 LRU 缓存。
 *
 * - 命中：删了再 set，把条目抬到 `Map` 队尾（`Map` 的迭代序 = 插入序，天然 LRU）；
 * - 逐出：从队头（最久未用）开始丢引用，**不 close()**（理由见文件头）；
 * - 两个上限（字节 / 条数）谁先到就按同一顺序逐出。
 */
export class TextureBitmapCache<V extends CacheableBitmap = CacheableBitmap> {
  private readonly entries = new Map<string, CacheEntry<V>>()
  private readonly maxBytes: number
  private readonly maxEntries: number
  private bytesInUse = 0
  private hits = 0
  private misses = 0

  constructor(opts: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? DEFAULT_BITMAP_CACHE_BYTES))
    this.maxEntries = Math.max(0, Math.floor(opts.maxEntries ?? DEFAULT_BITMAP_CACHE_ENTRIES))
  }

  /** 查一次（命中会抬到队尾并 +1 hits） */
  get(key: string): V | null {
    const hit = this.entries.get(key)
    if (hit === undefined) {
      this.misses += 1
      return null
    }
    // 抬到队尾：先删再插（值不变，顺序变）
    this.entries.delete(key)
    this.entries.set(key, hit)
    this.hits += 1
    return hit.bitmap
  }

  /**
   * 存一张（同 key 覆盖，不 close 旧值——它可能正被某个 Texture 引用）。
   *
   * @returns 被逐出的条目数（测试用；正常路径不关心）
   */
  set(key: string, bitmap: V): number {
    const prev = this.entries.get(key)
    if (prev !== undefined) {
      this.entries.delete(key)
      this.bytesInUse -= prev.bytes
    }
    const bytes = bitmapBytes(bitmap)
    this.entries.set(key, { bitmap, bytes })
    this.bytesInUse += bytes
    return this.evictIfNeeded()
  }

  /** 只查不记统计（调试 / 测试用） */
  peek(key: string): V | null {
    return this.entries.get(key)?.bitmap ?? null
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** O(1) 统计快照 */
  stats(): BitmapCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      bytes: this.bytesInUse,
      entries: this.entries.size
    }
  }

  /**
   * 全部释放并清空（**唯一会 `close()` 的路径**）。
   *
   * ⚠️ 只给测试重置 / 进程收尾用：场上的 Texture 若仍引用这些 bitmap，
   * close 之后它们再被上传会失败。业务代码不要在换资产时调它
   * （换资产只 dispose 贴图，缓存应该活着 —— 那正是缓存的意义）。
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.bitmap.close()
      } catch {
        // close 失败不影响清空：引用一丢，GC 照样能回收
      }
    }
    this.entries.clear()
    this.bytesInUse = 0
  }

  /** 清空 + 统计归零（单测专用） */
  reset(): void {
    this.clear()
    this.hits = 0
    this.misses = 0
  }

  /** 逐出队头直到两个上限都满足；返回逐出条目数 */
  private evictIfNeeded(): number {
    let evicted = 0
    while (
      this.entries.size > 0 &&
      (this.bytesInUse > this.maxBytes || this.entries.size > this.maxEntries)
    ) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      const entry = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      if (entry !== undefined) this.bytesInUse -= entry.bytes
      evicted += 1
    }
    return evicted
  }
}

/**
 * 进程级单例（组件与离屏渲染共用）。
 *
 * 独立于 `BallScene` 存活：球被 dispose 不影响缓存内容，这正是"来回切不卡"的前提。
 * 尺寸预算见 `DEFAULT_BITMAP_CACHE_BYTES` / `DEFAULT_BITMAP_CACHE_ENTRIES`。
 */
export const textureBitmapCache = new TextureBitmapCache()

/** 测试 / 收尾用：清空缓存并清零统计 */
export function resetTextureBitmapCache(): void {
  textureBitmapCache.reset()
}

/** 一行 debug 日志用的统计文案：`贴图缓存命中 3/5，占 12.4MB` */
export function formatBitmapCacheStats(stats: BitmapCacheStats): string {
  const total = stats.hits + stats.misses
  const mb = stats.bytes / (1024 * 1024)
  return `贴图缓存命中 ${stats.hits}/${total}，占 ${mb.toFixed(1)}MB（${stats.entries} 张）`
}
