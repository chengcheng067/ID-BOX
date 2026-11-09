/// <reference lib="dom" />
// ↑ 与 savedViewStore.test.ts 同因：tests/** 走 tsconfig.node，而 store 用到 `window`。
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

/**
 * HDR 预览的**打开入口**（0.6.5 用户口径：双击直接进预览）。
 *
 * 三处入口（网格双击 HDR 卡 / 文件视图双击 `.hdr` / 详情面板按钮）都必须走
 * store 的同一个 `openHdrPreview`，所以"能不能打开、打开的是哪一个"只需要在这里
 * 钉死一次；组件里再复制一份 state 就是 bug（会出现两个弹窗 / 关不掉的幽灵窗）。
 *
 * 边界桩：本组 action 不碰 IPC；Dexie 只碰 `db.assets.update`（`openHdrPreview` 会顺带
 * 打一次使用统计，见 `recordAssetUse`），所以只需要一个空 `window.modvault` + 一张
 * 只有 `update` 的假表。打点本身的形状与失败隔离在 `tests/useStats.test.ts` 里钉死。
 */
;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault: {} as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
Object.defineProperty(db, 'assets', {
  value: { update: vi.fn(async () => 1) },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

/** 最小资产（只用到 id / kind；其余字段与本组逻辑无关） */
function assetOf(id: string, kind: Asset['kind']): Asset {
  return { id, kind, name: id } as Asset
}

beforeEach(() => {
  useVault.setState({
    assets: [assetOf('hdr-1', 'hdri'), assetOf('model-1', 'model')],
    settings: { ...DEFAULT_SETTINGS },
    filters: { ...DEFAULT_FILTERS },
    hdrPreviewAssetId: null,
    notice: null
  })
})

describe('store · HDR 预览入口', () => {
  it('打开 / 关闭 hdri 资产', () => {
    useVault.getState().openHdrPreview('hdr-1')
    expect(useVault.getState().hdrPreviewAssetId).toBe('hdr-1')

    useVault.getState().closeHdrPreview()
    expect(useVault.getState().hdrPreviewAssetId).toBeNull()
  })

  it('非 hdri 资产不打开（避免弹一个必然失败的窗）', () => {
    useVault.getState().openHdrPreview('model-1')
    expect(useVault.getState().hdrPreviewAssetId).toBeNull()
  })

  it('不存在的 id 不打开（双击可能命中刚被 rescan 丢弃的陈旧 DOM 节点）', () => {
    useVault.getState().openHdrPreview('ghost')
    expect(useVault.getState().hdrPreviewAssetId).toBeNull()
  })

  it('重复打开是幂等的；关闭后不会残留', () => {
    useVault.getState().openHdrPreview('hdr-1')
    useVault.getState().openHdrPreview('hdr-1')
    expect(useVault.getState().hdrPreviewAssetId).toBe('hdr-1')
    useVault.getState().closeHdrPreview()
    useVault.getState().closeHdrPreview()
    expect(useVault.getState().hdrPreviewAssetId).toBeNull()
  })
})
