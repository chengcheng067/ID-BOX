/**
 * 性能修复 D（改造版）· 已解码 `ImageBitmap` 的 LRU 缓存。
 *
 * ── 为什么缓位图而不是 `THREE.Texture`（结论已由 team-lead 拍板）────────────
 * Texture 绑在具体 WebGL 上下文上，球卸载 → renderer dispose + forceContextLoss 后即失效；
 * ImageBitmap 与上下文无关，命中后只需重新上传。缓存命中路径省掉的是 480ms 级 CPU 解码，
 * 只付上传（5 张约 42ms）。
 *
 * ── 本文件钉住的契约 ────────────────────────────────────────────────────
 * ① 同 url + 同目标尺寸 → 第二次**零解码**（`createImageBitmap` 仍只被调 1 次）；
 * ② 同 url 不同目标尺寸 → 不串味（key 里带 `WxH`）；
 * ③ 字节上限 / 条数上限谁先到就逐出**最久未用**的（真 LRU，不是 FIFO）；
 * ④ **逐出绝不 `close()`**（被逐出的 bitmap 可能仍被场上存活的 Texture 引用）；
 * 只有 `clear()` / `reset()` 会 close —— 这是本模块最容易被"顺手优化坏"的一条；
 * ⑤ `reset()` 后统计归零、所有 close 都被调用过。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BITMAP_CACHE_BYTES,
  DEFAULT_BITMAP_CACHE_ENTRIES,
  TextureBitmapCache,
  bitmapBytes,
  bitmapCacheKey,
  formatBitmapCacheStats,
  type CacheableBitmap
} from '../src/renderer/logic/textureBitmapCache'
import {
  decodeTextureBitmap,
  type DecodedBitmap,
  type TextureDecodeDeps,
  type TextureFetchResponse
} from '../src/renderer/logic/materialBall'

/** 假位图：记录 close 是否被调用（用来证明"逐出不 close、clear 才 close"） */
function fakeBitmap(w = 10, h = 10): { bitmap: CacheableBitmap; isClosed: () => boolean } {
  let closed = false
  return {
    bitmap: {
      width: w,
      height: h,
      close: () => {
        closed = true
      }
    },
    isClosed: () => closed
  }
}

/** 最小 PNG 头（与 tests/materialBallDecodeOnce.test.ts 同口径） */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
  bytes.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

/** 解码依赖 + 计数器（`createBitmapCalls` = 真正发生解码的次数） */
function decodeHarness(bytes: Uint8Array, cache: TextureBitmapCache): {
  deps: TextureDecodeDeps
  calls: ImageBitmapOptions[]
} {
  const calls: ImageBitmapOptions[] = []
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf])
  const response: TextureFetchResponse = { ok: true, status: 200, blob: async () => blob }
  return {
    calls,
    deps: {
      fetchImpl: async () => response,
      createBitmap: async (_b: Blob, o: ImageBitmapOptions): Promise<DecodedBitmap> => {
        calls.push(o)
        return { width: o.resizeWidth ?? 8192, height: o.resizeHeight ?? 8192, close: () => undefined }
      },
      cache
    }
  }
}

describe('D · 缓存命中（不解码）', () => {
  it('★同一 url 调两次：第二次零解码，createImageBitmap 全程只调 1 次', async () => {
    const cache = new TextureBitmapCache()
    const h = decodeHarness(pngHeader(8192, 8192), cache)
    const url = 'vault://asset/wood/wood.jpg'

    const first = await decodeTextureBitmap(url, 1024, h.deps)
    const second = await decodeTextureBitmap(url, 1024, h.deps)

    expect(h.calls.length).toBe(1) // ← 命中路径不该再解码
    expect(first!.decodes).toBe(1)
    expect(first!.cached).toBe(false)
    expect(second!.decodes).toBe(0)
    expect(second!.cached).toBe(true)
    // 第二次拿到的就是缓存里那张（同一对象引用）
    expect(second!.bitmap).toBe(first!.bitmap)
    const s = cache.stats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.entries).toBe(1)
    expect(s.bytes).toBe(1024 * 1024 * 4) // 目标尺寸 1024² × RGBA
  })

  it('★同一 url 不同目标尺寸不命中（key 带 WxH，不串味）', async () => {
    const cache = new TextureBitmapCache()
    const h = decodeHarness(pngHeader(8192, 8192), cache)
    const url = 'vault://asset/wood/wood.jpg'

    const big = await decodeTextureBitmap(url, 1024, h.deps)
    const small = await decodeTextureBitmap(url, 512, h.deps)

    expect(h.calls.length).toBe(2) // 两个目标尺寸 = 两次解码
    expect(small!.cached).toBe(false)
    expect(small!.bitmap).not.toBe(big!.bitmap)
    expect(big!.bitmap.width).toBe(1024)
    expect(small!.bitmap.width).toBe(512)
    expect(cache.stats().entries).toBe(2)
  })

  it('尺寸未知的格式（webp…）不进缓存：每次都要解（没有稳定的 key 可用）', async () => {
    const cache = new TextureBitmapCache()
    const h = decodeHarness(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6]), cache)
    const url = 'vault://asset/x/a.webp'

    await decodeTextureBitmap(url, 1024, h.deps)
    await decodeTextureBitmap(url, 1024, h.deps)

    expect(h.calls.length).toBe(2)
    expect(cache.stats().entries).toBe(0)
    expect(cache.stats().hits).toBe(0)
  })

  it('不传 cache 时行为与修复前一致（单测默认不缓存）', async () => {
    const h = decodeHarness(pngHeader(2048, 2048), new TextureBitmapCache())
    delete (h.deps as { cache?: unknown }).cache
    const url = 'vault://asset/brick/brick.jpg'
    const a = await decodeTextureBitmap(url, 1024, h.deps)
    const b = await decodeTextureBitmap(url, 1024, h.deps)
    expect(h.calls.length).toBe(2)
    expect(a!.cached).toBe(false)
    expect(b!.cached).toBe(false)
  })
})

describe('D · key 与容量计量', () => {
  it('key = url|WxH；bytes = w × h × 4', () => {
    expect(bitmapCacheKey('vault://a/b.jpg', 1024, 512)).toBe('vault://a/b.jpg|1024x512')
    expect(bitmapBytes({ width: 1024, height: 1024 })).toBe(4 * 1024 * 1024)
    expect(bitmapBytes({ width: 1, height: 1 })).toBe(4)
    // 脏数据不产出 0 或负数（否则容量统计会"越用越多"）
    expect(bitmapBytes({ width: 0, height: 0 })).toBe(4)
  })

  it('默认上限：64MB / 48 条', () => {
    expect(DEFAULT_BITMAP_CACHE_BYTES).toBe(64 * 1024 * 1024)
    expect(DEFAULT_BITMAP_CACHE_ENTRIES).toBe(48)
  })
})

describe('D · LRU 逐出（真 LRU，不是 FIFO）', () => {
  it('★字节上限：命中会抬高优先级，逐出的是"最久未用"而不是"最早插入"', () => {
    // 每张 10×10 = 400 字节；上限 1000 → 最多 2 张
    const cache = new TextureBitmapCache({ maxBytes: 1000, maxEntries: 999 })
    const a = fakeBitmap()
    const b = fakeBitmap()
    const c = fakeBitmap()

    cache.set('A', a.bitmap) // 400
    cache.set('B', b.bitmap) // 800
    expect(cache.get('A')).toBe(a.bitmap) // 命中 → A 抬到队尾（此时最久未用是 B）
    cache.set('C', c.bitmap) // 1200 > 1000 → 逐出 B

    expect(cache.peek('A')).toBe(a.bitmap)
    expect(cache.peek('C')).toBe(c.bitmap)
    expect(cache.peek('B')).toBeNull()
    expect(cache.stats().entries).toBe(2)
    expect(cache.stats().bytes).toBe(800) // 计量必须跟着减
  })

  it('★条数上限生效（字节远没到上限时也不会无限增长）', () => {
    const cache = new TextureBitmapCache({ maxBytes: 10_000_000, maxEntries: 2 })
    cache.set('A', fakeBitmap(1, 1).bitmap)
    cache.set('B', fakeBitmap(1, 1).bitmap)
    cache.set('C', fakeBitmap(1, 1).bitmap)
    expect(cache.stats().entries).toBe(2)
    expect(cache.peek('A')).toBeNull() // 最早插入的被逐出
    expect(cache.peek('C')).not.toBeNull()
    expect(cache.stats().bytes).toBe(8)
  })

  it('同 key 覆盖：不重复计字节，也不 close 旧值', () => {
    const cache = new TextureBitmapCache()
    const oldOne = fakeBitmap(10, 10)
    const newOne = fakeBitmap(10, 10)
    cache.set('A', oldOne.bitmap)
    cache.set('A', newOne.bitmap)
    expect(cache.stats().bytes).toBe(400)
    expect(cache.peek('A')).toBe(newOne.bitmap)
    expect(oldOne.isClosed()).toBe(false) // 旧值可能仍被 Texture 引用
  })

  it('★逐出绝不 close（被逐出的位图可能仍被场上存活的 Texture 引用）', () => {
    const cache = new TextureBitmapCache({ maxBytes: 400, maxEntries: 1 })
    const first = fakeBitmap()
    const second = fakeBitmap()
    cache.set('A', first.bitmap)
    cache.set('B', second.bitmap) // 逐出 A

    expect(cache.peek('A')).toBeNull()
    expect(first.isClosed()).toBe(false) // ← 关键：不能在这里 close
    expect(second.isClosed()).toBe(false)
  })
})

describe('D · 释放与统计', () => {
  it('★clear 释放全部（close 逐个调用）+ 字节归零，但保留命中/未命中累计', () => {
    const cache = new TextureBitmapCache()
    const a = fakeBitmap()
    const b = fakeBitmap()
    cache.set('A', a.bitmap)
    cache.set('B', b.bitmap)
    cache.get('A')
    cache.get('missing')

    cache.clear()

    expect(a.isClosed()).toBe(true)
    expect(b.isClosed()).toBe(true)
    expect(cache.stats().entries).toBe(0)
    expect(cache.stats().bytes).toBe(0)
    expect(cache.stats().hits).toBe(1)
    expect(cache.stats().misses).toBe(1)
  })

  it('★reset 后统计全归零（单测/收尾专用）', () => {
    const cache = new TextureBitmapCache()
    const a = fakeBitmap()
    cache.set('A', a.bitmap)
    cache.get('A')
    cache.get('B')

    cache.reset()

    expect(a.isClosed()).toBe(true)
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, bytes: 0, entries: 0 })
  })

  it('统计文案：`贴图缓存命中 3/5，占 12.4MB`（用户反馈"还卡"时一眼可读）', () => {
    const text = formatBitmapCacheStats({ hits: 3, misses: 2, bytes: 13_000_000, entries: 5 })
    expect(text).toBe('贴图缓存命中 3/5，占 12.4MB（5 张）')
  })
})
