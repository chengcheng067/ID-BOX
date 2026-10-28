/// <reference lib="dom" />
/**
 * 补齐队列**必须接力**（0.8.3，用户 2026-10-28 追问「重装后扫描预览图」时发现的缺口）。
 *
 * 病根：`ENSURE_THUMB_BATCH = 120` 只是单轮上限，而 `ensureMissingThumbs` 跑完一轮就收工。
 * 重装 / 首次扫描后 `thumbStatus` 可能整库被重置成 `none`（实测外部用户就是"部分卡片有图、
 * 其余全是图标"），于是第 121 张之后永远补不上 —— 用户看到的就是"预览图没修好"。
 *
 * 本文件钉两件事：
 * ① **超过 120 条也能一次补完**（接力）；
 * ② **不会无限空转**：`ensureThumb` 一直失败时，`thumbAttempted` 让候选单调收缩 → 一轮零进展就收手。
 *
 * 环境：vitest 是 `environment: 'node'`，所以 `window.modvault` 与 Dexie 表都是桩
 * （与 `tests/ballCache.test.ts` 同款做法）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { Asset } from '../src/shared/types'
import { DEFAULT_FILTERS } from '../src/renderer/logic/filters'

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

/** `ensureThumb` 的返回值由每个用例控制：null = 生成失败 */
const ensureThumb = vi.fn(async (_id: string, _abs: string | null) => 'thumb.png' as string | null)

const modvault = {
  ensureThumb,
  pruneThumbs: vi.fn(async () => 0),
  deleteThumb: vi.fn(async () => 0)
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const fakeAssets = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => [])
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })

const { useVault, ensureMissingThumbs } = await import('../src/renderer/store')

/**
 * 造 n 条"有封面、缩略图未就绪"的模型资产（不触发球图分支）。
 *
 * ⚠️ 每条 id 必须**全局唯一**：`thumbAttempted` 是 store 的模块级 Set（跨用例共享，
 * 本会话内失败过的不再重试），复用同一批 id 会让后面的用例"没有候选"直接空跑。
 */
let idSeq = 0

function missingAssets(n: number): Asset[] {
  return Array.from({ length: n }, () => {
    idSeq += 1
    const i = idSeq
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    return {
      id,
      name: `资产${i + 1}`,
      kind: 'model',
      source: '知末网',
      folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${i + 1}`,
      relFolder: `模型/未分类/未分类/资产${i + 1}`,
      cover: '预览图.jpg',
      coverSource: 'named',
      thumbStatus: 'none',
      files: [{ rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' }],
      size: 10,
      tags: [],
      note: '',
      styles: [],
      favorite: false,
      rating: 0,
      colorTag: null,
      dedupeKey: `model:资产${i + 1}`,
      importedAt: 1700000000000,
      updatedAt: 1700000000000,
      category1: '未分类',
      category2: '未分类'
    } as Asset
  })
}

function seed(assets: Asset[]): void {
  useVault.setState({
    assets,
    settings: { ...DEFAULT_SETTINGS },
    filters: { ...DEFAULT_FILTERS },
    selectedId: null,
    selectedIds: []
  })
}

beforeEach(() => {
  ensureThumb.mockClear()
  ensureThumb.mockImplementation(async () => 'thumb.png')
})

describe('ensureMissingThumbs · 接力（重装后整库缺图不能被 120 卡住）', () => {
  it('300 条同时缺缩略图 → 一次调用全部补完（不是只补前 120 条）', async () => {
    const assets = missingAssets(300)
    seed(assets)
    await ensureMissingThumbs()
    const ready = useVault.getState().assets.filter((a) => a.thumbStatus === 'ready')
    expect(ready).toHaveLength(300)
    // 每张恰好问一次主进程（接力不重复、不空转）
    expect(ensureThumb).toHaveBeenCalledTimes(300)
  })

  it('补完就停（没有候选时不再白跑）：第二次调用一次 IPC 都不发', async () => {
    seed(missingAssets(130))
    await ensureMissingThumbs()
    expect(ensureThumb).toHaveBeenCalledTimes(130)
    ensureThumb.mockClear()
    await ensureMissingThumbs()
    expect(ensureThumb).not.toHaveBeenCalled()
  })

  it('全失败时只跑一轮就收手（不对着坏图/坏路径空转）', async () => {
    ensureThumb.mockImplementation(async () => null)
    seed(missingAssets(200))
    await ensureMissingThumbs()
    // 只剩 120 次：第一轮零进展 → 直接停（不接力），剩下 80 张留到下次启动
    // —— 这是刻意的：缩略图失败通常意味着源图读不了，反复重试只会白烧 CPU。
    expect(ensureThumb).toHaveBeenCalledTimes(120)
    const stillMissing = useVault.getState().assets.filter((a) => a.thumbStatus !== 'ready')
    expect(stillMissing).toHaveLength(200)
  })

  it('部分成功也能收尾（成功的不再入队，失败的留待下次启动）', async () => {
    let n = 0
    ensureThumb.mockImplementation(async () => {
      n += 1
      return n <= 150 ? 'thumb.png' : null // 前 150 张成功，其余失败
    })
    seed(missingAssets(200))
    await ensureMissingThumbs()
    const st = useVault.getState().assets
    expect(st.filter((a) => a.thumbStatus === 'ready')).toHaveLength(150)
    expect(ensureThumb).toHaveBeenCalledTimes(200)
  })
})
