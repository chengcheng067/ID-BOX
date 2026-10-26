/**
 * GPU 贴图池（性能优化 D，第二批）—— **按 WebGLRenderer 复用的 Texture LRU**。
 *
 * ── 为什么需要它（docs/26 §4-D）──────────────────────────────────────────────
 * `textureBitmapCache`（已落地）缓存的是 `ImageBitmap`：它解决「同一张图不重复**解码**」
 * （8192² 实测 437ms）。但换回一个看过的资产时仍然要付：
 *   ① `fetch` 原图（8192² 那张 13MB 实测 44ms；4K 五槽合计 81ms）；
 *   ② `texImage2D` 上传（5 张约 23.7ms）；
 *   ③ 重新建 Texture 对象并重新绑定。
 * 本池把这些「GPU 侧成本」也缓存掉：命中直接返回**同一个 Texture 实例**，`fetch` 都不做。
 *
 * ── 为什么按 renderer 分组（不进全局单例）────────────────────────────────────
 * `Texture` 绑定具体 WebGL 上下文：`renderer.dispose() + forceContextLoss()` 之后，
 * 同一份 Texture 再上传会 INVALID_OPERATION 或渲黑。所以池的宿主是**一个 renderer**
 * （= 一个 `BallScene`）。舞台那颗球整个会话常驻（`MaterialBall` 的建场景 effect 是
 * `deps: []`），所以「按场景」在这里就等于「按会话」，命中率 = 用户来回切的命中率。
 *
 * ── 引用计数（为什么不能只有 LRU）────────────────────────────────────────────
 * 逐出会 `dispose()` 贴图。若逐出的正好是**当前挂在材质上的**那张，球立刻变黑/变白。
 * 因此每个条目带 `refs`：`take()`（取用）与 `put()`（放入即被使用）+1，`release()` -1；
 * 逐出**只挑 `refs === 0` 的条目**。切换资产时旧贴图 `release` 到位 → 可逐出；
 * 还在材质上的永远跳过（极端情况下会临时超预算，这是安全优先的取舍）。
 *
 * ── 为什么 key 里要带 colorSpace ──────────────────────────────────────────────
 * 0.7.6「按灰度做透明」把 albedo 的**同一个 URL** 又挂了一份到 `alphaMap`，但要求它是
 * **线性**色彩空间（sRGB 会把 0.5 灰变成 0.21 → 用户眼里「一半灰」变「几乎全透」）。
 * 两者必须是**两个 Texture 实例**，所以 key 必须区分 `srgb|linear`，否则串味。
 *
 * 纯逻辑：不 import three / DOM，只依赖 `{ dispose() }` 结构，可在 node 里单测。
 */

/** 池能管理的最小贴图接口（three 的 `Texture` 结构上满足：有 `dispose()`） */
export interface DisposableTexture {
  dispose(): void
}

/** 贴图池统计快照（debug 日志与测试用；`stats()` 是 O(1)） */
export interface TexturePoolStats {
  /** 命中次数（累计） */
  hits: number
  /** 未命中次数（累计，`take()` 查不到时 +1） */
  misses: number
  /** 当前条目数 */
  entries: number
  /** 当前占用的估算字节数（w × h × 4） */
  bytes: number
  /** 其中仍被引用的条目数（不会被逐出） */
  pinned: number
  /** 累计逐出并 dispose 的条目数 */
  evictions: number
}

/**
 * 默认条数上限 12：1024² RGBA 一张 4MB（docs/26 §2.2c 同口径），
 * 12 张 = 48MB —— 与 docs/26 §4-D「12 张 = 48MB，可接受」一致。
 * 两个 5 槽 PBR 预设（+ 灰度透明的 alpha 副本）刚好能同时在池里。
 */
export const DEFAULT_TEXTURE_POOL_ENTRIES = 12
/** 默认字节上限 48MB（与条数上限同一口径，防「一堆小图把 Map 撑爆」的反面：防大图超预算） */
export const DEFAULT_TEXTURE_POOL_BYTES = 48 * 1024 * 1024

/**
 * 池 key：`url|maxPx|srgb|linear`。
 *
 * - `maxPx` 必须进 key：`MAX_TEX_PX` 是**降采样上限**，同一张原图在不同上限下是不同的
 *   像素内容，不能串味（将来按动效档位分档时这条会立刻用上）；
 * - 色彩空间必须进 key：见文件头「为什么 key 里要带 colorSpace」；
 * - `flipY = false` 是常量口径（位图解码时已 `imageOrientation:'flipY'`），不进 key。
 */
export function texturePoolKey(url: string, maxPx: number, linear: boolean): string {
  return `${url}|${Math.max(1, Math.floor(maxPx))}|${linear ? 'linear' : 'srgb'}`
}

interface PoolEntry<T extends DisposableTexture> {
  key: string
  texture: T
  bytes: number
  /** 引用计数：> 0 的条目**绝不被逐出**（它正挂在材质上） */
  refs: number
}

/**
 * 贴图 LRU 池。
 *
 * 顺序语义：`Map` 的迭代序 = 插入序，`take()` 命中时「先删再插」把条目抬到队尾，
 * 于是队头 = 最久未用。逐出从队头开始，跳过 `refs > 0`。
 */
export class TexturePool<T extends DisposableTexture = DisposableTexture> {
  private readonly byKey = new Map<string, PoolEntry<T>>()
  private readonly byTexture = new Map<T, PoolEntry<T>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private bytesInUse = 0
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(opts: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = Math.max(0, Math.floor(opts.maxEntries ?? DEFAULT_TEXTURE_POOL_ENTRIES))
    this.maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? DEFAULT_TEXTURE_POOL_BYTES))
  }

  /**
   * 取一张（命中会抬到队尾、引用 +1 并记一次 hit）。
   *
   * ⚠️ 取到的贴图在用完之后**必须** `release()`，否则它永远不可逐出（显存只增不减）。
   * 典型用法：`applyMaps` 挂上去时算「在用」，换资产时 `release`。
   */
  take(key: string): T | null {
    const hit = this.byKey.get(key)
    if (hit === undefined) {
      this.misses += 1
      return null
    }
    this.byKey.delete(key)
    this.byKey.set(key, hit)
    hit.refs += 1
    this.hits += 1
    return hit.texture
  }

  /**
   * 放入一张（引用 +1，视为「刚被调用方拿去用」）。
   *
   * 同 key 覆盖：旧条目从两张索引里摘掉、**不 dispose**（它可能正被材质引用，
   * 交给 `release` + 逐出处理；这条与 `textureBitmapCache` 的销毁纪律同源）。
   */
  put(key: string, texture: T, bytes: number): void {
    const prev = this.byKey.get(key)
    if (prev !== undefined) {
      this.byKey.delete(key)
      this.byTexture.delete(prev.texture)
      this.bytesInUse -= prev.bytes
    }
    const entry: PoolEntry<T> = {
      key,
      texture,
      bytes: Math.max(1, Math.floor(bytes)),
      refs: 1
    }
    this.byKey.set(key, entry)
    this.byTexture.set(texture, entry)
    this.bytesInUse += entry.bytes
    this.evictIfNeeded()
  }

  /** 归还引用（-1）。返回 false = 这张贴图不在池里（调用方应自行 `dispose()`） */
  release(texture: T): boolean {
    const entry = this.byTexture.get(texture)
    if (entry === undefined) return false
    if (entry.refs > 0) entry.refs -= 1
    this.evictIfNeeded()
    return true
  }

  /** 这张贴图是不是由本池管理 */
  owns(texture: T): boolean {
    return this.byTexture.has(texture)
  }

  /** 池里是否已有这个 key（**不**改引用计数、不计命中率；查探 / 测试用） */
  has(key: string): boolean {
    return this.byKey.has(key)
  }

  /** 当前条目数 */
  get size(): number {
    return this.byKey.size
  }

  /** O(1) 统计快照 */
  stats(): TexturePoolStats {
    let pinned = 0
    for (const entry of this.byKey.values()) {
      if (entry.refs > 0) pinned += 1
    }
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.byKey.size,
      bytes: this.bytesInUse,
      pinned,
      evictions: this.evictions
    }
  }

  /**
   * 全部释放并清空（**唯一会 dispose 引用计数 > 0 的条目的路径**）。
   *
   * 只在 `BallScene.dispose()`（renderer 即将销毁）与测试重置时调用 ——
   * 那时贴图已经没有任何合法用途了，必须连同 GPU 资源一起归还。
   */
  disposeAll(): void {
    for (const entry of this.byKey.values()) {
      try {
        entry.texture.dispose()
      } catch {
        // dispose 失败不影响清空：引用一丢，GC 照样能回收
      }
      this.evictions += 1
    }
    this.byKey.clear()
    this.byTexture.clear()
    this.bytesInUse = 0
  }

  /** 清空 + 统计归零（单测专用；与 `disposeAll` 同语义） */
  reset(): void {
    this.disposeAll()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /** 逐出队头直到两个上限都满足；**跳过仍在使用的条目**（安全优先，允许临时超预算） */
  private evictIfNeeded(): void {
    if (this.byKey.size === 0) return
    let guard = 0
    while (
      (this.bytesInUse > this.maxBytes || this.byKey.size > this.maxEntries) &&
      guard < this.byKey.size * 2
    ) {
      guard += 1
      let victim: PoolEntry<T> | null = null
      for (const entry of this.byKey.values()) {
        if (entry.refs > 0) continue
        victim = entry
        break
      }
      if (victim === null) return // 全都在用 → 本轮到不了上限，等下批 release 再逐出
      this.byKey.delete(victim.key)
      this.byTexture.delete(victim.texture)
      this.bytesInUse -= victim.bytes
      this.evictions += 1
      try {
        victim.texture.dispose()
      } catch {
        // 同 disposeAll：单个 dispose 失败不该打断逐出
      }
    }
  }
}

/** 一行 debug 日志用的统计文案：`贴图池 12 张 / 46.9MB（在用 5）` */
export function formatTexturePoolStats(stats: TexturePoolStats): string {
  const mb = stats.bytes / (1024 * 1024)
  return `贴图池 ${stats.entries} 张 / ${mb.toFixed(1)}MB（在用 ${stats.pinned}）`
}
