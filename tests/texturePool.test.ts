/**
 * 贴图池（性能优化 D，第二批）单测。
 *
 * 池是纯逻辑（不 import three / DOM），所以这里能精确验证：
 * ① LRU 顺序（命中抬到队尾、逐出从队头）；② **引用计数 > 0 的条目绝不被逐出**
 * （正在材质上的贴图被 dispose = 球变黑）；③ 两个上限；④ disposeAll 的语义。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEXTURE_POOL_BYTES,
  DEFAULT_TEXTURE_POOL_ENTRIES,
  TexturePool,
  formatTexturePoolStats,
  texturePoolKey
} from '../src/renderer/logic/texturePool'

/** 可观察 dispose 次数的假贴图 */
class FakeTexture {
  disposed = 0
  dispose(): void {
    this.disposed += 1
  }
}

function makePool(opts: { maxEntries?: number; maxBytes?: number } = {}): TexturePool<FakeTexture> {
  return new TexturePool<FakeTexture>(opts)
}

/** 造一张并放进池（`bytes` 默认 1，避免字节上限干扰条数上限的用例） */
function put(pool: TexturePool<FakeTexture>, key: string, bytes = 1): FakeTexture {
  const tex = new FakeTexture()
  pool.put(key, tex, bytes)
  return tex
}

describe('texturePoolKey：url + 上限 + 色彩空间', () => {
  it('同一张图、同一上限、同一色彩空间 → 同 key（这是命中的前提）', () => {
    expect(texturePoolKey('vault://a.jpg', 1024, false)).toBe(
      texturePoolKey('vault://a.jpg', 1024, false)
    )
  })

  it('色彩空间进 key：albedo(sRGB) 与 alpha(线性) 用同一个 URL 也不许串味', () => {
    expect(texturePoolKey('vault://a.jpg', 1024, false)).not.toBe(
      texturePoolKey('vault://a.jpg', 1024, true)
    )
  })

  it('降采样上限进 key：同图不同 maxPx 是两份像素内容', () => {
    expect(texturePoolKey('vault://a.jpg', 1024, false)).not.toBe(
      texturePoolKey('vault://a.jpg', 512, false)
    )
  })

  it('maxPx 归一化（小数/非法值不产生第二份 key）', () => {
    expect(texturePoolKey('u', 1024.7, false)).toBe(texturePoolKey('u', 1024, false))
    expect(texturePoolKey('u', 0, false)).toBe(texturePoolKey('u', 1, false))
  })
})

describe('TexturePool：命中 / 引用 / 逐出', () => {
  it('take 命中返回同一实例，并记一次 hit', () => {
    const pool = makePool()
    const tex = put(pool, 'k1')
    expect(pool.take('k1')).toBe(tex)
    expect(pool.stats().hits).toBe(1)
    expect(pool.stats().misses).toBe(0)
  })

  it('take 未命中返回 null 并记一次 miss', () => {
    const pool = makePool()
    expect(pool.take('nope')).toBeNull()
    expect(pool.stats().misses).toBe(1)
  })

  it('超条数上限时逐出**最久未用**的条目，并 dispose 它', () => {
    const pool = makePool({ maxEntries: 2 })
    const a = put(pool, 'a')
    const b = put(pool, 'b')
    // 换资产：两条都归还（refs 归零）→ 之后才允许逐出
    pool.release(a)
    pool.release(b)
    // 用一次 a → a 变成最近使用，队头变 b
    expect(pool.take('a')).toBe(a)
    pool.release(a)
    const c = put(pool, 'c')
    expect(pool.has('b')).toBe(false)
    expect(pool.has('a')).toBe(true)
    expect(pool.has('c')).toBe(true)
    expect(b.disposed).toBe(1)
    expect(a.disposed).toBe(0)
    expect(c.disposed).toBe(0)
    expect(pool.stats().entries).toBe(2)
  })

  it('引用计数 > 0 的条目**绝不被逐出**（正在材质上的贴图不能 dispose）', () => {
    const pool = makePool({ maxEntries: 1 })
    const a = put(pool, 'a') // refs = 1（正在用）
    const b = put(pool, 'b') // 超上限，但两条都在用 → 一条都不能逐出
    expect(a.disposed).toBe(0)
    expect(b.disposed).toBe(0)
    expect(pool.stats().entries).toBe(2)
    expect(pool.stats().pinned).toBe(2)
  })

  it('release 之后才允许逐出（换资产归还 → 下一次 put 才收掉旧的）', () => {
    const pool = makePool({ maxEntries: 1 })
    const a = put(pool, 'a')
    pool.release(a) // refs 1 → 0；此时还没超上限，不会被立刻收掉
    expect(a.disposed).toBe(0)
    put(pool, 'b') // 条数超上限 → 队头 a 被逐出
    expect(a.disposed).toBe(1)
    expect(pool.stats().entries).toBe(1)
  })

  it('release 不在池里的贴图返回 false（调用方据此自行 dispose）', () => {
    const pool = makePool()
    expect(pool.release(new FakeTexture())).toBe(false)
  })

  it('字节上限同样生效（大图先进先出）', () => {
    const pool = makePool({ maxBytes: 10 })
    const big1 = put(pool, 'big1', 8)
    pool.release(big1)
    const big2 = put(pool, 'big2', 8)
    pool.release(big2)
    // 8 + 8 > 10 → 队头 big1 被收掉
    expect(big1.disposed).toBe(1)
    expect(big2.disposed).toBe(0)
    expect(pool.stats().bytes).toBe(8)
  })

  it('同 key 覆盖不泄漏字节（旧条目不再计费）', () => {
    const pool = makePool({ maxEntries: 10, maxBytes: 100 })
    put(pool, 'same', 40)
    const second = put(pool, 'same', 30)
    expect(pool.stats().entries).toBe(1)
    expect(pool.stats().bytes).toBe(30)
    expect(pool.take('same')).toBe(second)
  })

  it('owns() 区分「池里的」与「池外的」', () => {
    const pool = makePool()
    const inside = put(pool, 'in')
    expect(pool.owns(inside)).toBe(true)
    expect(pool.owns(new FakeTexture())).toBe(false)
  })
})

describe('TexturePool：disposeAll / 默认上限', () => {
  it('disposeAll 释放全部条目（含仍在用的）并清空统计垃圾', () => {
    const pool = makePool()
    const a = put(pool, 'a')
    const b = put(pool, 'b')
    pool.disposeAll()
    expect(a.disposed).toBe(1)
    expect(b.disposed).toBe(1)
    expect(pool.stats().entries).toBe(0)
    expect(pool.stats().bytes).toBe(0)
  })

  it('reset 连命中/未命中/逐出计数一起归零', () => {
    const pool = makePool({ maxEntries: 1 })
    put(pool, 'a')
    pool.take('a')
    pool.take('missing')
    pool.reset()
    const stats = pool.stats()
    expect(stats.hits).toBe(0)
    expect(stats.misses).toBe(0)
    expect(stats.evictions).toBe(0)
    expect(stats.entries).toBe(0)
  })

  it('默认上限与 docs/29 的口径一致（12 张 / 48MB）', () => {
    expect(DEFAULT_TEXTURE_POOL_ENTRIES).toBe(12)
    expect(DEFAULT_TEXTURE_POOL_BYTES).toBe(48 * 1024 * 1024)
  })

  it('统计文案包含张数与 MB（排查"还卡"用）', () => {
    const pool = makePool()
    put(pool, 'k', 4 * 1024 * 1024)
    expect(formatTexturePoolStats(pool.stats())).toContain('1 张')
    expect(formatTexturePoolStats(pool.stats())).toContain('4.0MB')
  })
})
