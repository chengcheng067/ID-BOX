/// <reference lib="dom" />
// 本文件经由 tsconfig.node（tests/**）编译；`Window.modvault` 的真实声明在
// `src/renderer/env.d.ts`（只对 tsconfig.web 程序生效），这里补测试用声明。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import type { InboxUsageEvent } from '../src/shared/inboxUsage'

/**
 * 插件「使用记录」回传在**渲染层**的消费逻辑（`store.ts` 的 `consumeInboxUsage`）行为测试。
 *
 * 为什么不能只写源码守卫：这里有四条只能靠"真的跑一遍"钉住的契约——
 *
 * 1. **不 ack 就不删文件**（主进程侧语义）⇒ 落库失败必须 `ok:false`，否则"用户真的
 *    用过"这件事就被悄悄吞掉，`useCount` 永远少算；
 * 2. **资产不存在要 ack 成功**：用户可能插完就把模型删了，那条记录永远配不上号，
 *    `ok:false` 会让它在盘上无限重试；
 * 3. **能力缺失不得炸 init**：旧 preload 没有 `onInboxUsage`，直接调会让界面停在
 *    "正在加载…"（0.9.x 的真实故障形态）；
 * 4. **拖出到建模软件要打点**：这是用户口径里"拿去用"的主要形态，漏了统计就废了一半。
 *
 * 桩法与 `tests/inboxFlow.test.ts` 一致：`window.modvault` 用 vi.fn 桩、
 * `db.assets` 用内存假表 —— 驱动的是**真实 store 代码**，不是副本。
 */

/** 主进程派发回调（`ensureInboxUsageSubscribed` 里注册进来的那个） */
let usageHandler: ((ev: InboxUsageEvent) => void) | null = null

const modvault = {
  onInboxUsage: vi.fn((cb: (ev: InboxUsageEvent) => void) => {
    usageHandler = cb
    return () => {
      usageHandler = null
    }
  }),
  ackInboxUsage: vi.fn(),
  reportLog: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const updated: Array<{ id: string; patch: Partial<Asset> }> = []
let updateThrows = false
const fakeAssetsTable = {
  update: vi.fn(async (id: string, patch: Partial<Asset>) => {
    if (updateThrows) throw new Error('IndexedDB 已关闭')
    updated.push({ id, patch })
    return 1
  }),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => [])
}
Object.defineProperty(db, 'assets', { value: fakeAssetsTable, configurable: true })

const { useVault, ensureInboxUsageSubscribed, resetInboxForTests } = await import(
  '../src/renderer/store'
)

// ── 夹具 ───────────────────────────────────────────────────────

function asset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    name: `资产-${id}`,
    kind: 'model',
    source: '测试',
    folder: `E:\\lib\\模型\\${id}`,
    relFolder: `模型/${id}`,
    files: [],
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${id}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '未分类',
    category2: '未分类',
    size: 1024,
    ...over
  }
}

function usageEvent(assetId: string, over: Partial<InboxUsageEvent> = {}): InboxUsageEvent {
  return {
    fileName: '20261109-220000-aa11.json',
    record: {
      apiVersion: 1,
      op: 'usage',
      assetId,
      at: '2026-11-09T22:00:00+08:00',
      pluginVersion: '1.3.0'
    },
    ...over
  }
}

/** 等 `cond()` 成立（`consumeInboxUsage` 是 void 派发的异步任务） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInboxForTests()
  usageHandler = null
  updated.length = 0
  updateThrows = false
  // `recordAssetUse` 有 2 秒防抖（模块级 Map），用例之间必须换 id 才互不影响；
  // 这里直接复位 assets 与选中，防抖表本身不清（真实运行也不会清）。
  useVault.setState({ assets: [], imports: [], notice: null })
  modvault.ackInboxUsage.mockResolvedValue({ ok: true, removed: true })
})

// ── 用例 ───────────────────────────────────────────────────────

describe('订阅（能力探测）', () => {
  it('缺少 onInboxUsage 时不抛，且只记一条 warn', () => {
    const bare = { ...modvault, onInboxUsage: undefined } as unknown as ModVaultApi
    ;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
      modvault: bare
    }
    expect(() => ensureInboxUsageSubscribed()).not.toThrow()
    expect(() => ensureInboxUsageSubscribed()).not.toThrow()
    // 探测失败要能从日志里查到，但只打一次
    expect(modvault.reportLog).toHaveBeenCalledTimes(1)
    expect(modvault.reportLog.mock.calls[0]![0]).toMatchObject({
      level: 'warn',
      message: 'inbox:usage-subscribe-skipped'
    })
    // 还原，避免污染后续用例
    ;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
      modvault: modvault as unknown as ModVaultApi
    }
  })

  it('订阅成功后再调不会重复注册（幂等）', () => {
    ensureInboxUsageSubscribed()
    ensureInboxUsageSubscribed()
    expect(modvault.onInboxUsage).toHaveBeenCalledTimes(1)
  })
})

describe('消费一条使用记录', () => {
  it('资产存在 → useCount +1、写 lastUsedAt、ack 成功', async () => {
    useVault.setState({ assets: [asset('a-1')] })
    ensureInboxUsageSubscribed()
    usageHandler!(usageEvent('a-1'))

    await waitFor(() => modvault.ackInboxUsage.mock.calls.length > 0)
    const live = useVault.getState().assets.find((a) => a.id === 'a-1')!
    expect(live.useCount).toBe(1)
    expect(typeof live.lastUsedAt).toBe('number')
    expect(modvault.ackInboxUsage).toHaveBeenCalledWith({
      fileName: '20261109-220000-aa11.json',
      ok: true
    })
  })

  it('资产不存在（已删）→ 不写库，但仍然 ack 成功（否则无限重试）', async () => {
    useVault.setState({ assets: [] })
    ensureInboxUsageSubscribed()
    usageHandler!(usageEvent('已删除的 id'))

    await waitFor(() => modvault.ackInboxUsage.mock.calls.length > 0)
    expect(updated).toHaveLength(0)
    expect(modvault.ackInboxUsage).toHaveBeenCalledWith({
      fileName: '20261109-220000-aa11.json',
      ok: true
    })
  })

  it('落库失败 → ack ok:false（文件保留，下次启动重试）', async () => {
    useVault.setState({ assets: [asset('a-2')] })
    updateThrows = true
    ensureInboxUsageSubscribed()
    usageHandler!(usageEvent('a-2'))

    await waitFor(() => modvault.ackInboxUsage.mock.calls.length > 0)
    expect(modvault.ackInboxUsage).toHaveBeenCalledWith({
      fileName: '20261109-220000-aa11.json',
      ok: false
    })
  })

  it('ack 通道自己失败也不抛（旧 preload 形态）', async () => {
    useVault.setState({ assets: [asset('a-3')] })
    modvault.ackInboxUsage.mockRejectedValueOnce(new Error('通道不存在'))
    ensureInboxUsageSubscribed()
    expect(() => usageHandler!(usageEvent('a-3'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
  })
})

describe('源码守卫：拖出到建模软件要打点', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')

  it('AssetGrid 的两个拖出点都在 startDrag 回调里记一次使用', () => {
    const src = read('src/renderer/components/AssetGrid.tsx')
    // 每个 beginSystemDrag 调用块内都必须出现一次 recordAssetUse
    const blocks = src.split('beginSystemDrag(').slice(1)
    const dragBlocks = blocks.filter((b) => b.includes('window.modvault.startDrag'))
    expect(dragBlocks.length).toBeGreaterThanOrEqual(2)
    for (const block of dragBlocks) {
      // 只看该调用块的前 600 字符（回调就在其中）
      expect(block.slice(0, 600)).toContain('recordAssetUse')
    }
  })

  it('DetailPanel 的拖出点同样打点', () => {
    const src = read('src/renderer/components/DetailPanel.tsx')
    const idx = src.indexOf('beginSystemDrag(')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(idx, idx + 600)).toContain('recordAssetUse')
  })

  it('打点位于 startDrag 之后（拖拽被守卫拦掉时不该计数）', () => {
    const src = read('src/renderer/components/AssetGrid.tsx')
    const idx = src.indexOf('window.modvault.startDrag')
    expect(idx).toBeGreaterThan(-1)
    const useIdx = src.indexOf('recordAssetUse', idx)
    expect(useIdx).toBeGreaterThan(idx)
  })
})
