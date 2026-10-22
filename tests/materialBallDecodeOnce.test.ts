/**
 * 性能修复 A / B 的回归守卫：**同一张贴图只解码一次** + **法线合成不再踩 GPU 回读**。
 *
 * ── A（解码两次）现场 ──────────────────────────────────────────────────
 * 旧 `loadTexture`：先 `createImageBitmap(blob)` 全尺寸解一遍（实测 8192² 原木 482ms）
 * **只为拿宽高**，再带 resize 解一遍（434ms）→ 一次切换 1014ms 全在 CPU 解码。
 * 修复：宽高从**文件头**读（`shared/imageSize.ts` 的 `imageSizeOf`，纯字节解析），
 * 然后只做**一次**带 `resizeWidth/resizeHeight` 的 `createImageBitmap`。
 * 同时保留"最终纹理尺寸语义不变"：最长边超过 `MAX_TEX_PX`(1024) 的等比缩到 1024。
 *
 * 注意两个反直觉事实（诊断结论，不要用"降尺寸"来"优化"）：
 * ① 文件 MB ≠ 解码成本（8.2MB 红砖只有 2048²，13.1MB 原木是 8192²）；
 * ② Chromium 对 JPEG 没走 scaled decode，512 也要 ~410ms —— 渲染进程侧压不下去。
 *
 * ── B（同步 GPU 回读）现场 ──────────────────────────────────────────────
 * 法线合成的画布 `getContext('2d')` 没声明 `willReadFrequently`，`getImageData`
 * 实测 30.7ms 同步阻塞。修复：上下文显式声明 + 采样 384 → 256。
 *
 * 这些用例是纯逻辑（不碰 WebGL / 不真的解码图片）：`decodeTextureBitmap` 把
 * `fetch` 与 `createImageBitmap` 做成可注入依赖，用一个计数器就能钉住"解码次数 = 1"。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  READBACK_CONTEXT_OPTIONS,
  SYNTH_NORMAL_SIZE_PX,
  decodeTextureBitmap,
  planTextureDecode,
  synthNormalSize,
  type DecodedBitmap,
  type TextureDecodeDeps,
  type TextureFetchResponse
} from '../src/renderer/logic/materialBall'
import {
  resetTextureBitmapCache,
  textureBitmapCache
} from '../src/renderer/logic/textureBitmapCache'

/** 最小 PNG 头（签名 + IHDR + 宽高 + 5 字节图像信息），与 tests/imageSize.test.ts 同口径 */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8) // 块长度 13
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  bytes.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
  bytes.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

/** 不认识的格式（webp 之类的头部）：文件头解析必然失败 */
function unknownHeader(): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
}

interface Harness {
  deps: TextureDecodeDeps
  /** 每次 `createImageBitmap` 的入参（长度 = 解码次数） */
  calls: ImageBitmapOptions[]
}

function harness(bytes: Uint8Array, opts: { ok?: boolean } = {}): Harness {
  const calls: ImageBitmapOptions[] = []
  // 复制进独立的 ArrayBuffer：TS 的 BlobPart 只接受 ArrayBuffer（不接受 SharedArrayBuffer 视图）
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf])
  const fakeBitmap = (o: ImageBitmapOptions): DecodedBitmap => ({
    width: o.resizeWidth ?? 8192,
    height: o.resizeHeight ?? 8192,
    close: () => undefined
  })
  const response: TextureFetchResponse = {
    ok: opts.ok !== false,
    status: opts.ok === false ? 404 : 200,
    blob: async () => blob
  }
  return {
    calls,
    deps: {
      fetchImpl: async () => response,
      createBitmap: async (_blob: Blob, o: ImageBitmapOptions) => {
        calls.push(o)
        return fakeBitmap(o)
      }
    }
  }
}

describe('性能修复 A · planTextureDecode（尺寸语义不变）', () => {
  it('最长边超过上限 → 等比缩到上限（与原实现同一口径）', () => {
    expect(planTextureDecode({ w: 8192, h: 8192 }, 1024)).toEqual({
      width: 1024,
      height: 1024,
      scaled: true
    })
    expect(planTextureDecode({ w: 8192, h: 4096 }, 1024)).toEqual({
      width: 1024,
      height: 512,
      scaled: true
    })
    expect(planTextureDecode({ w: 4096, h: 8192 }, 1024)).toEqual({
      width: 512,
      height: 1024,
      scaled: true
    })
  })

  it('不超过上限 → 原样（不缩放）', () => {
    expect(planTextureDecode({ w: 1024, h: 1024 }, 1024)).toEqual({
      width: 1024,
      height: 1024,
      scaled: false
    })
    expect(planTextureDecode({ w: 512, h: 256 }, 1024)).toEqual({
      width: 512,
      height: 256,
      scaled: false
    })
  })

  it('脏输入也不产出 0 尺寸（three 的纹理不接受 0）', () => {
    expect(planTextureDecode({ w: 0, h: 0 }, 1024)).toEqual({ width: 1, height: 1, scaled: false })
    expect(planTextureDecode({ w: 4000, h: 0 }, 1024)).toEqual({
      width: 1024,
      height: 1,
      scaled: true
    })
  })
})

describe('性能修复 A · decodeTextureBitmap 只解码一次', () => {
  it('★8192² 原木：只调一次 createImageBitmap，且这次就带 resize（旧实现 2 次）', async () => {
    const h = harness(pngHeader(8192, 8192))

    const r = await decodeTextureBitmap('vault://asset/wood/wood.jpg', 1024, h.deps)

    expect(r).not.toBeNull()
    expect(h.calls.length).toBe(1) // ← 核心断言：482ms + 434ms 里的第一次被省掉了
    expect(r!.decodes).toBe(1)
    expect(r!.scaled).toBe(true)
    expect(r!.sourceSize).toEqual({ w: 8192, h: 8192 })
    expect(h.calls[0]!.resizeWidth).toBe(1024)
    expect(h.calls[0]!.resizeHeight).toBe(1024)
    expect(h.calls[0]!.resizeQuality).toBe('medium')
    // 朝向纪律不变：imageOrientation:'flipY' + texture.flipY = false
    expect(h.calls[0]!.imageOrientation).toBe('flipY')
  })

  it('★2048² 红砖：也只解一次（8.2MB 不大但仍是 4 倍像素差）', async () => {
    const h = harness(pngHeader(2048, 2048))
    const r = await decodeTextureBitmap('vault://asset/brick/brick.jpg', 1024, h.deps)
    expect(h.calls.length).toBe(1)
    expect(r!.scaled).toBe(true)
    expect(h.calls[0]!.resizeWidth).toBe(1024)
  })

  it('小图（≤ 上限）同样只解一次，且**不带** resize（保持原始采样）', async () => {
    const h = harness(pngHeader(512, 512))
    const r = await decodeTextureBitmap('vault://asset/small/a.png', 1024, h.deps)
    expect(h.calls.length).toBe(1)
    expect(r!.scaled).toBe(false)
    expect(h.calls[0]!.resizeWidth).toBeUndefined()
    expect(h.calls[0]!.resizeHeight).toBeUndefined()
  })

  it('文件头解析不出的格式（webp/bmp/tga…）：仍然只解一次（解码时无法 resize，交给 canvas）', async () => {
    const h = harness(unknownHeader())
    const r = await decodeTextureBitmap('vault://asset/x/a.webp', 1024, h.deps)
    expect(h.calls.length).toBe(1) // 绝不"解一次拿尺寸、再解一次缩放"
    expect(r!.sourceSize).toBeNull()
    expect(r!.scaled).toBe(false)
    expect(h.calls[0]!.resizeWidth).toBeUndefined()
  })

  it('fetch 非 2xx → 返回 null（调用方退回 TextureLoader，不假装成功）', async () => {
    const h = harness(pngHeader(1024, 1024), { ok: false })
    const r = await decodeTextureBitmap('vault://asset/x/missing.png', 1024, h.deps)
    expect(r).toBeNull()
    expect(h.calls.length).toBe(0)
  })
})

describe('性能修复 D · 已解码位图缓存接进 loadTexture 链路', () => {
  it('★同一 url 两次（进程单例）→ 解码 1 次，第二次走缓存', async () => {
    resetTextureBitmapCache()
    const h = harness(pngHeader(8192, 8192))
    const deps: TextureDecodeDeps = { ...h.deps, cache: textureBitmapCache }
    const url = 'vault://asset/wood/wood.jpg'

    const first = await decodeTextureBitmap(url, 1024, deps)
    const second = await decodeTextureBitmap(url, 1024, deps)

    expect(h.calls.length).toBe(1) // ← 旧链路（无缓存）这里是 1 次/次，来回切要反复付 480ms
    expect(first!.cached).toBe(false)
    expect(second!.cached).toBe(true)
    expect(second!.decodes).toBe(0)
    expect(textureBitmapCache.stats().entries).toBe(1)
    resetTextureBitmapCache() // 不污染其它用例
  })

  it('★源码守卫：loadTexture 必须把缓存传下去，并打命中率日志', () => {
    const src = fs.readFileSync(
      new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
      'utf-8'
    )
    expect(src).toContain('cache: textureBitmapCache')
    expect(src).toContain('formatBitmapCacheStats(textureBitmapCache.stats())')
    // 命中路径不能被那句"解码 1 次"的日志误报（日志只在真的解码时打）
    expect(src).toContain('decoded.sourceSize && decoded.decodes > 0')
  })
})

describe('性能修复 B · 法线合成', () => {
  it('★采样尺寸 384 → 256（像素数降到 44%）', () => {
    expect(SYNTH_NORMAL_SIZE_PX).toBe(256)
    expect(synthNormalSize(8192, 8192)).toEqual({ w: 256, h: 256 })
    expect(synthNormalSize(4000, 2000)).toEqual({ w: 256, h: 128 })
    // 比 256 小的原图保持原尺寸（不放大，避免无中生有的高频细节）
    expect(synthNormalSize(100, 50)).toEqual({ w: 100, h: 50 })
    expect(synthNormalSize(1, 1)).toEqual({ w: 2, h: 2 })
  })

  it('★同步回读的 2D 上下文必须声明 willReadFrequently', () => {
    expect(READBACK_CONTEXT_OPTIONS.willReadFrequently).toBe(true)
    const src = fs.readFileSync(
      new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
      'utf-8'
    )
    // 源码守卫：法线合成的 getContext 必须把这份选项传下去（否则 30.7ms 的 GPU 回读会回来）
    expect(src).toContain("getContext('2d', READBACK_CONTEXT_OPTIONS)")
    // 只能有一处 READBACK_CONTEXT_OPTIONS 定义（避免有人另抄一份常量漂移）
    expect(src.split('READBACK_CONTEXT_OPTIONS').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('法线合成的采样常量不得再回到 384', () => {
    const src = fs.readFileSync(
      new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
      'utf-8'
    )
    expect(src).not.toContain('NORMAL_FROM_ALBEDO_PX = 384')
  })
})
