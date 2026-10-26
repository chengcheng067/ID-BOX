/**
 * 拖拽卡片的预览图**解析层**（`renderer/logic/previewThumb.ts`）—— 纯逻辑单测。
 *
 * vitest 环境是 `node`（没有 jsdom），所以这里不碰 DOM：`window` 只被**鸭子类型**读取，
 * 测试通过 `deps.api` 注入假的主进程能力。要钉住的行为：
 *
 * ① 成功 → `vault://thumb/<name>`（**唯一** URL 口径，不在这里自己拼字符串）；
 * ② 失败（返回 null / 抛错 / 没有 API）→ 一律 null，**绝不抛**（调用方必须能回退）；
 * ③ 去重：并发调用共用一次 IPC；已解析的结果在 TTL 内直接命中（扫一屏卡片不打满主进程）；
 * ④ TTL 过期后重新请求（源文件被原地覆盖时能拿到新文件名）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREVIEW_URL_TTL_MS,
  clearPreviewUrlCache,
  ensurePreviewUrl,
  peekPreviewUrl,
  previewCacheKey
} from '../src/renderer/logic/previewThumb'
import { thumbVaultUrl } from '../src/shared/format'

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const ABS = 'E:/ModVault/Library/材质/木纹/木纹 4K.jpg'
const NAME = `${ID}-deadbeef-p1024.jpg`

/** 可控的假主进程 API */
function fakeApi(result: (id: string, absPath: string | null) => Promise<string | null>) {
  return { ensurePreview: vi.fn(result) }
}

beforeEach(() => {
  clearPreviewUrlCache()
})

describe('ensurePreviewUrl · 成功路径', () => {
  it('返回 vault://thumb/<name>（与 thumbVaultUrl 完全一致，不自己拼）', async () => {
    const api = fakeApi(async () => NAME)
    const url = await ensurePreviewUrl(ID, ABS, { api })

    expect(url).toBe(thumbVaultUrl(NAME))
    expect(url).toBe(`vault://thumb/${NAME}`)
    expect(api.ensurePreview).toHaveBeenCalledWith(ID, ABS)
  })

  it('第二次调用命中缓存 → 只发一次 IPC', async () => {
    const api = fakeApi(async () => NAME)
    await ensurePreviewUrl(ID, ABS, { api })
    await ensurePreviewUrl(ID, ABS, { api })

    expect(api.ensurePreview).toHaveBeenCalledTimes(1)
  })

  it('并发调用共用同一个 in-flight Promise（hover 抖动不会打两枪）', async () => {
    let resolveOnce: (v: string | null) => void = () => {}
    const api = fakeApi(
      () =>
        new Promise<string | null>((resolve) => {
          resolveOnce = resolve
        })
    )
    const p1 = ensurePreviewUrl(ID, ABS, { api })
    const p2 = ensurePreviewUrl(ID, ABS, { api })
    resolveOnce(NAME)

    await expect(Promise.all([p1, p2])).resolves.toEqual([thumbVaultUrl(NAME), thumbVaultUrl(NAME)])
    expect(api.ensurePreview).toHaveBeenCalledTimes(1)
  })

  it('不同文件（同一资产）各自独立解析（key 里必须带路径）', async () => {
    const api = fakeApi(async () => NAME)
    await ensurePreviewUrl(ID, ABS, { api })
    await ensurePreviewUrl(ID, `${ABS}.other.jpg`, { api })

    expect(api.ensurePreview).toHaveBeenCalledTimes(2)
    expect(previewCacheKey(ID, ABS)).not.toBe(previewCacheKey(ID, `${ABS}.other.jpg`))
  })
})

describe('ensurePreviewUrl · 失败一律降级（绝不抛）', () => {
  it('主进程返回 null → null（调用方回退缩略图）', async () => {
    const api = fakeApi(async () => null)
    await expect(ensurePreviewUrl(ID, ABS, { api })).resolves.toBeNull()
  })

  it('IPC 抛错 → null，不向上抛', async () => {
    const api = fakeApi(async () => {
      throw new Error('ipc broken')
    })
    await expect(ensurePreviewUrl(ID, ABS, { api })).resolves.toBeNull()
  })

  it('没有 API（node 环境 / 旧 preload）→ null，且不做任何事', async () => {
    await expect(ensurePreviewUrl(ID, ABS, { api: null })).resolves.toBeNull()
    // 不传 deps 时读 window；node 环境没有 window → 也必须安静返回 null
    await expect(ensurePreviewUrl(ID, ABS)).resolves.toBeNull()
  })

  it('入参空 → null，且**不请求** IPC（避免无意义往返）', async () => {
    const api = fakeApi(async () => NAME)
    await expect(ensurePreviewUrl('', ABS, { api })).resolves.toBeNull()
    await expect(ensurePreviewUrl(ID, null, { api })).resolves.toBeNull()
    await expect(ensurePreviewUrl(ID, '', { api })).resolves.toBeNull()
    expect(api.ensurePreview).not.toHaveBeenCalled()
  })
})

describe('peekPreviewUrl · 同步命中 / TTL', () => {
  it('解析前 null；解析后同步可读（第二次 hover 零 IPC 直接用预览图）', async () => {
    const api = fakeApi(async () => NAME)
    expect(peekPreviewUrl(ID, ABS)).toBeNull()

    await ensurePreviewUrl(ID, ABS, { api })
    expect(peekPreviewUrl(ID, ABS)).toBe(thumbVaultUrl(NAME))
  })

  it('TTL 过期 → peek 返回 null，并且下次请求会重新问主进程', async () => {
    const api = fakeApi(async () => NAME)
    let now = 1_000_000
    const deps = { api, now: () => now }

    await ensurePreviewUrl(ID, ABS, deps)
    expect(peekPreviewUrl(ID, ABS, deps)).toBe(thumbVaultUrl(NAME))

    now += PREVIEW_URL_TTL_MS + 1
    expect(peekPreviewUrl(ID, ABS, deps)).toBeNull()

    await ensurePreviewUrl(ID, ABS, deps)
    expect(api.ensurePreview).toHaveBeenCalledTimes(2)
  })

  it('失败结果也按 TTL 缓存：TTL 内不重试，TTL 后自动重试', async () => {
    let now = 2_000_000
    let result: string | null = null
    const api = fakeApi(async () => result)
    const deps = { api, now: () => now }

    await expect(ensurePreviewUrl(ID, ABS, deps)).resolves.toBeNull()
    await expect(ensurePreviewUrl(ID, ABS, deps)).resolves.toBeNull()
    expect(api.ensurePreview).toHaveBeenCalledTimes(1)

    // 源文件修好了（或刚生成完）→ TTL 过后必须能重试成功
    result = NAME
    now += PREVIEW_URL_TTL_MS + 1
    await expect(ensurePreviewUrl(ID, ABS, deps)).resolves.toBe(thumbVaultUrl(NAME))
    expect(api.ensurePreview).toHaveBeenCalledTimes(2)
  })

  it('空入参 peek 也返回 null（不抛）', () => {
    expect(peekPreviewUrl('', ABS)).toBeNull()
    expect(peekPreviewUrl(ID, null)).toBeNull()
    expect(peekPreviewUrl(ID, undefined)).toBeNull()
  })
})
