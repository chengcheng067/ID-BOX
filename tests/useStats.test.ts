/// <reference lib="dom" />
// ↑ 与 savedViewStore.test.ts / hdrPreviewStore.test.ts 同因：tests/** 走 tsconfig.node，
//   而 store 用到 `window`（下面还要用 `reportLog` 断言"失败只 warn 一次"）。
/**
 * 使用统计（`recordAssetUse`）的数据层守卫（2026-10）。
 *
 * 排序键「最常使用 / 最近使用」的**唯一**数据来源就是这两个字段
 * （`Asset.useCount` / `Asset.lastUsedAt`，口径见 `src/shared/types.ts`），
 * 所以这里钉的是"计数对不对、写得对不对"，不是 UI：
 *
 * ① 累加语义（首次 1 → 再开 2）与 `lastUsedAt` 单调前进；
 * ② 2 秒防抖（Quick Look 来回比图不许把计数刷爆），超过阈值要能继续累加；
 * ③ 不存在的 id：不造记录、不抛、不写库；
 * ④ **持久化只写这两个字段**：必须是 `db.assets.update`（MERGE），绝不能是 `put`
 *    （整条覆盖会把并发的 `thumbPath` / `thumbStatus` 打回旧值）；
 * ⑤ 写库失败绝不影响主流程（不抛、内存照样 +1、只 warn 一次）。
 *
 * ## 为什么用 spy 而不是每条都走真 IndexedDB
 *
 * 仓库里没有 fake-indexeddb（`dbV5Migration.test.ts` 头注同一事实）。本文件因此把
 * `db.assets` 换成一张**带 spy 的假表**：`update` / `put` 的调用形状就是被测契约本身，
 * 而"哪个方法被调用"恰恰是第 ④ 条要断言的东西 —— 用真库反而看不到。
 */

import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  getSettings: vi.fn(async () => null),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async () => 0),
  saveBallThumb: vi.fn(async () => null),
  assignCategory: vi.fn(),
  onSettingsChanged: vi.fn(() => () => undefined),
  reportLog: vi.fn()
}
;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

/** 带 spy 的假表：`update` / `put` 的调用形状就是本文件要断言的契约 */
const fakeTable = {
  toArray: vi.fn(async (): Promise<Asset[]> => []),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkGet: vi.fn(async (): Promise<(Asset | undefined)[]> => []),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  where: vi.fn(() => fakeTable),
  equals: vi.fn(() => fakeTable),
  toCollection: vi.fn(() => fakeTable),
  modify: vi.fn(async () => 0),
  update: vi.fn(async (_id: string, _changes: Partial<Asset>) => 1),
  get: vi.fn(async (): Promise<Asset | undefined> => undefined),
  count: vi.fn(async () => 0),
  delete: vi.fn(async () => undefined)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { ASSET_USE_DEBOUNCE_MS, useVault } = await import('../src/renderer/store')

/** 最小资产（只补 `Asset` 的必填字段；使用统计相关字段一律缺省 = 从未使用） */
function assetOf(id: string, patch: Partial<Asset> = {}): Asset {
  return {
    id,
    name: id,
    kind: 'model',
    source: '知末网',
    folder: `E:\\ModVault\\Library\\模型\\未分类\\未分类\\${id}`,
    relFolder: `模型/未分类/未分类/${id}`,
    files: [],
    size: 0,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${id}`,
    importedAt: 1,
    updatedAt: 1,
    ...patch
  }
}

/**
 * 时钟：`Date.now` 由本文件完全控制（不引 fake timers，避免顺手冻住 promise 调度）。
 *
 * 每个用例的起点都**往前推 1 分钟**：防抖用的 `lastUseRecordedAt` 是 store 的
 * 模块级 Map（不持久化、不清理，设计如此），用例之间共用同一份 —— 若每个用例都从
 * 同一时刻起算，上一个用例留下的时间戳会把本用例第一次打点直接防抖掉。
 */
const CLOCK_EPOCH = 1_700_000_000_000
let t0 = CLOCK_EPOCH
let now = CLOCK_EPOCH
let nowSpy: { mockRestore: () => void }

beforeEach(() => {
  t0 += 60_000
  now = t0
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
  fakeTable.update.mockClear()
  fakeTable.put.mockClear()
  modvault.reportLog.mockClear()
  useVault.setState({
    assets: [assetOf('use-1'), assetOf('use-2')],
    quickLookAssetId: null,
    folderViewAssetId: null,
    hdrPreviewAssetId: null
  })
})

afterEach(() => {
  nowSpy.mockRestore()
})

/** 取当前内存里的某条资产（不存在则 undefined） */
function stored(id: string): Asset | undefined {
  return useVault.getState().assets.find((a) => a.id === id)
}

describe('recordAssetUse · 累加与时间戳', () => {
  it('首次打点：useCount = 1，lastUsedAt = 当前时间', () => {
    useVault.getState().recordAssetUse('use-1')
    expect(stored('use-1')?.useCount).toBe(1)
    expect(stored('use-1')?.lastUsedAt).toBe(t0)
    // 另一条资产不受影响（按 id 就地替换，不是整体刷）
    expect(stored('use-2')?.useCount).toBeUndefined()
    expect(stored('use-2')?.lastUsedAt).toBeUndefined()
  })

  it('超过防抖窗口再开一次：累加为 2，lastUsedAt 前进', () => {
    useVault.getState().recordAssetUse('use-1')
    expect(stored('use-1')?.useCount).toBe(1)

    now = t0 + ASSET_USE_DEBOUNCE_MS + 1
    useVault.getState().recordAssetUse('use-1')
    expect(stored('use-1')?.useCount).toBe(2)
    expect(stored('use-1')?.lastUsedAt).toBe(t0 + ASSET_USE_DEBOUNCE_MS + 1)
    expect(stored('use-1')!.lastUsedAt!).toBeGreaterThan(t0)
  })

  it('其他字段原样保留（封面 / 缩略图 / 分类都不动）', () => {
    useVault.setState({
      assets: [
        assetOf('keep-1', {
          cover: 'preview.png',
          coverSource: 'embedded',
          thumbPath: 'keep-1-abc.jpg',
          thumbStatus: 'ready',
          category1: '模型',
          category2: '椅子'
        })
      ]
    })
    useVault.getState().recordAssetUse('keep-1')
    const a = stored('keep-1')!
    expect(a.useCount).toBe(1)
    expect(a.cover).toBe('preview.png')
    expect(a.coverSource).toBe('embedded')
    expect(a.thumbPath).toBe('keep-1-abc.jpg')
    expect(a.thumbStatus).toBe('ready')
    expect(a.category1).toBe('模型')
    expect(a.category2).toBe('椅子')
  })
})

describe('recordAssetUse · 2 秒防抖', () => {
  it('同一 id 在防抖窗口内重复调用只记一次', () => {
    useVault.getState().recordAssetUse('use-1')
    now = t0 + 300
    useVault.getState().recordAssetUse('use-1')
    now = t0 + 1999
    useVault.getState().recordAssetUse('use-1')
    expect(stored('use-1')?.useCount).toBe(1)
    // 被防抖吃掉的调用也不许写库（否则写库次数会跟按键次数成正比）
    expect(fakeTable.update).toHaveBeenCalledTimes(1)
  })

  it('刚好越界（+2000ms）就算第二次使用', () => {
    useVault.getState().recordAssetUse('use-1')
    now = t0 + ASSET_USE_DEBOUNCE_MS
    useVault.getState().recordAssetUse('use-1')
    expect(stored('use-1')?.useCount).toBe(2)
  })

  it('防抖按 id 独立：同时打开两条资产各记一次', () => {
    useVault.getState().recordAssetUse('use-1')
    useVault.getState().recordAssetUse('use-2')
    expect(stored('use-1')?.useCount).toBe(1)
    expect(stored('use-2')?.useCount).toBe(1)
    expect(fakeTable.update).toHaveBeenCalledTimes(2)
  })
})

describe('recordAssetUse · 不存在的 id', () => {
  it('不产生记录、不抛异常、不写库', () => {
    const before = useVault.getState().assets.length
    expect(() => useVault.getState().recordAssetUse('ghost-id')).not.toThrow()
    expect(useVault.getState().assets.length).toBe(before)
    expect(stored('ghost-id')).toBeUndefined()
    expect(fakeTable.update).not.toHaveBeenCalled()
    expect(fakeTable.put).not.toHaveBeenCalled()
  })
})

describe('recordAssetUse · 持久化形状', () => {
  it('只写 useCount + lastUsedAt 两个字段，且走 update 而不是 put', () => {
    useVault.getState().recordAssetUse('use-1')

    expect(fakeTable.put).not.toHaveBeenCalled()
    expect(fakeTable.update).toHaveBeenCalledTimes(1)

    const [id, changes] = fakeTable.update.mock.calls[0] as [string, Partial<Asset>]
    expect(id).toBe('use-1')
    // 键集合逐字钉死：多写任何字段都可能覆盖并发写入（缩略图 / 封面 / 分类）
    expect(Object.keys(changes).sort()).toEqual(['lastUsedAt', 'useCount'])
    expect(changes.useCount).toBe(1)
    expect(changes.lastUsedAt).toBe(t0)
  })

  it('源码守卫：recordAssetUse 的实现里不出现 db.assets.put', () => {
    const src = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf8')
    const block = actionBlock(src, 'recordAssetUse(id) {')
    // 只截到 action 的收尾 `\n  },`（action 内部缩进 ≥ 4 空格，不会误命中；
    // 注释里也没有以两空格缩进的 `},`）
    expect(block).toContain('db.assets')
    expect(block).toContain('.update(')
    expect(block).not.toContain('.put(')
    expect(block).toContain('useCount')
    expect(block).toContain('lastUsedAt')
  })
})

describe('recordAssetUse · 写库失败不影响主流程', () => {
  it('update reject 时：不抛、内存照样 +1、只 warn 一条', async () => {
    fakeTable.update.mockRejectedValueOnce(new Error('IndexedDB quota exceeded'))

    expect(() => useVault.getState().recordAssetUse('use-1')).not.toThrow()
    // 内存态是同步更新的，失败也不会回滚（下一次打点继续累加，不会"丢一次"）
    expect(stored('use-1')?.useCount).toBe(1)

    // 让 catch 分支跑完（promise 微任务）
    await Promise.resolve()
    await Promise.resolve()

    const warned = modvault.reportLog.mock.calls.filter(
      (call) => (call[0] as { message?: string } | undefined)?.message === 'usestat:write-failed'
    )
    expect(warned.length).toBe(1)
  })
})

/**
 * 从 `src/renderer/store.ts` 里切出一个 action 的实现文本。
 *
 * 起点是**实现签名**（如 `recordAssetUse(id) {`，不是接口里的 `recordAssetUse: (…) => void`），
 * 终点是紧随其后的 `\n  },`（store 里 action 一律以两空格缩进收尾）。
 * 不用正则整文件搜 `db.assets.put`：那会命中注释和别的 action 里合法的 `put`。
 */
function actionBlock(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`store.ts 里找不到 action 实现：${signature}`)
  const end = src.indexOf('\n  },', start)
  if (end < 0) throw new Error(`action 收尾定位失败：${signature}`)
  return src.slice(start, end)
}

describe('三个打点入口都真的记了一次', () => {
  it('openQuickLook 记一次', () => {
    useVault.getState().openQuickLook('use-1')
    expect(useVault.getState().quickLookAssetId).toBe('use-1')
    expect(stored('use-1')?.useCount).toBe(1)
  })

  it('openFolderView 记一次', () => {
    useVault.getState().openFolderView('use-1')
    expect(useVault.getState().folderViewAssetId).toBe('use-1')
    expect(stored('use-1')?.useCount).toBe(1)
  })

  it('openHdrPreview 只对 hdri 资产记一次（非 hdri 不记）', () => {
    useVault.setState({
      assets: [assetOf('hdr-1', { kind: 'hdri' }), assetOf('model-1', { kind: 'model' })]
    })
    useVault.getState().openHdrPreview('model-1')
    expect(stored('model-1')?.useCount).toBeUndefined()

    useVault.getState().openHdrPreview('hdr-1')
    expect(useVault.getState().hdrPreviewAssetId).toBe('hdr-1')
    expect(stored('hdr-1')?.useCount).toBe(1)
  })

  it('陈旧 id（不在索引里）不会通过入口被记一次', () => {
    useVault.getState().openQuickLook('ghost')
    useVault.getState().openFolderView('ghost')
    useVault.getState().openHdrPreview('ghost')
    expect(fakeTable.update).not.toHaveBeenCalled()
    expect(useVault.getState().assets.every((a) => a.useCount === undefined)).toBe(true)
  })

  it('纯选中 / hover 链路不记使用（源码守卫：这三个 action 之外没有打点）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf8')
    // 打点调用点总数 = 3（openQuickLook / openFolderView / openHdrPreview）+
    // 1 处接口声明口径无法命中（声明写的是 `recordAssetUse: (id: string) => void`）
    const calls = src.match(/get\(\)\.recordAssetUse\(/g) ?? []
    expect(calls.length).toBe(3)
  })
})
