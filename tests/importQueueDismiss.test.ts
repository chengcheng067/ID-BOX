/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type ImportEvent } from '../src/shared/types'
import {
  IMPORT_DONE_DISMISS_MS,
  IMPORT_ERROR_DISMISS_MS,
  autoDismissDelayMs,
  dismissRemainingMs
} from '../src/renderer/logic/importText'

/**
 * 导入队列条目自动消失（2026-10 用户反馈：单条完成后不消失，连导多个包堆一屏 6 条）。
 *
 * 口径：done = 6 秒 / error = 12 秒 / 进行中永不自动消失；悬停暂停；✕ 立即移除。
 * 这里测三层：
 * ① 纯函数 `autoDismissDelayMs` / `dismissRemainingMs`（绝对时间戳算剩余，悬停恢复不重计时）；
 * ② 真实 store：导入事件的 `settledAt` 只在终态写入、`dismissImport` 立即移除；
 * ③ 源码守卫：ImportQueue 真的用了这两个函数与悬停状态（组件在 node 环境渲染不了）。
 */

describe('autoDismissDelayMs —— 只有终态才有倒计时', () => {
  it('done = 6 秒', () => {
    expect(autoDismissDelayMs('done')).toBe(IMPORT_DONE_DISMISS_MS)
    expect(autoDismissDelayMs('done')).toBe(6000)
  })

  it('error = 12 秒（错误要留久一点让人看清）', () => {
    expect(autoDismissDelayMs('error')).toBe(IMPORT_ERROR_DISMISS_MS)
    expect(autoDismissDelayMs('error')).toBe(12000)
  })

  it('进行中（pending / extracting / organizing）= null，不自动消失', () => {
    expect(autoDismissDelayMs('pending')).toBeNull()
    expect(autoDismissDelayMs('extracting')).toBeNull()
    expect(autoDismissDelayMs('organizing')).toBeNull()
  })

  it('error 的停留时间是 done 的两倍', () => {
    expect(IMPORT_ERROR_DISMISS_MS).toBe(IMPORT_DONE_DISMISS_MS * 2)
  })
})

describe('dismissRemainingMs —— 绝对时间戳算剩余（悬停暂停/恢复不重新计时）', () => {
  const T0 = 1_000_000

  it('刚进入终态 → 完整时长', () => {
    expect(dismissRemainingMs('done', T0, T0)).toBe(6000)
    expect(dismissRemainingMs('error', T0, T0)).toBe(12000)
  })

  it('已经过了 3 秒 → 只剩 3 秒（不是重新计 6 秒）', () => {
    expect(dismissRemainingMs('done', T0, T0 + 3000)).toBe(3000)
  })

  it('已超时 → 0（立即移除）', () => {
    expect(dismissRemainingMs('done', T0, T0 + 60_000)).toBe(0)
    expect(dismissRemainingMs('error', T0, T0 + 13_000)).toBe(0)
  })

  it('缺 settledAt（老数据 / 刚挂载）→ 视作刚刚进入终态，返回完整时长', () => {
    expect(dismissRemainingMs('done', undefined, T0)).toBe(6000)
    expect(dismissRemainingMs('done', null, T0)).toBe(6000)
  })

  it('进行中 → null（无论有没有 settledAt）', () => {
    expect(dismissRemainingMs('extracting', T0, T0 + 100)).toBeNull()
    expect(dismissRemainingMs('pending', undefined, T0)).toBeNull()
  })
})

// ── store：settledAt 的写入时机 + dismissImport ────────────────────

let importHandler: ((ev: ImportEvent) => void) | null = null

const modvault = {
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  setSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  detectMaterialMerge: vi.fn(async () => ({ needMerge: false, count: 0, sources: [] })),
  onMaterialMergeNotice: vi.fn(),
  onImportBatchDone: vi.fn(),
  // docs/27：init() 会订阅「导入发现重复，请裁决」+「询问已作废」（幂等），桩必须返回退订函数
  onImportConflictAsk: vi.fn(() => () => undefined),
  onImportConflictExpired: vi.fn(() => () => undefined),
  onImportEvent: vi.fn((cb: (ev: ImportEvent) => void) => {
    importHandler = cb
    return () => undefined
  })
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
Object.defineProperty(db, 'assets', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => 0),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})
Object.defineProperty(db, 'backups', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

beforeEach(async () => {
  vi.clearAllMocks()
  importHandler = null
  useVault.setState({ imports: [], assets: [], notice: null })
  await useVault.getState().init()
})

afterEach(() => {
  useVault.setState({ imports: [] })
})

describe('store：导入事件的 settledAt / dismissImport', () => {
  it('done 事件写入 settledAt（绝对时间戳）；进行中不写', () => {
    expect(importHandler).not.toBeNull()
    importHandler!({ item: 'E:\\a.zip', itemName: 'a.zip', status: 'extracting' })
    expect(useVault.getState().imports).toHaveLength(1)
    expect(useVault.getState().imports[0]!.settledAt).toBeUndefined()

    importHandler!({ item: 'E:\\a.zip', itemName: 'a.zip', status: 'done' })
    const done = useVault.getState().imports[0]!
    expect(done.status).toBe('done')
    expect(typeof done.settledAt).toBe('number')
    expect(done.settledAt).toBeGreaterThan(0)
  })

  it('error 事件同样写入 settledAt', () => {
    importHandler!({ item: 'E:\\b.rar', itemName: 'b.rar', status: 'error', message: '解压失败' })
    const item = useVault.getState().imports[0]!
    expect(item.status).toBe('error')
    expect(typeof item.settledAt).toBe('number')
  })

  it('同一 item 的后续事件覆盖旧条目（settledAt 随之刷新，不会沿用旧的倒计时起点）', () => {
    importHandler!({ item: 'E:\\c.7z', itemName: 'c.7z', status: 'done' })
    const first = useVault.getState().imports[0]!.settledAt!
    importHandler!({ item: 'E:\\c.7z', itemName: 'c.7z', status: 'extracting' })
    const imports = useVault.getState().imports
    expect(imports).toHaveLength(1)
    expect(imports[0]!.status).toBe('extracting')
    expect(imports[0]!.settledAt).toBeUndefined()
    expect(first).toBeGreaterThan(0)
  })

  it('dismissImport 立即移除指定条目（手动 ✕ 不受倒计时影响）', () => {
    importHandler!({ item: 'E:\\d.zip', itemName: 'd.zip', status: 'done' })
    importHandler!({ item: 'E:\\e.zip', itemName: 'e.zip', status: 'done' })
    expect(useVault.getState().imports).toHaveLength(2)
    useVault.getState().dismissImport('E:\\d.zip')
    expect(useVault.getState().imports.map((i) => i.item)).toEqual(['E:\\e.zip'])
  })
})

// ── 源码守卫：ImportQueue 的计时/悬停接线 ─────────────────────────

describe('源码守卫：ImportQueue 自动消失实现', () => {
  const src = (): string =>
    fs.readFileSync(new URL('../src/renderer/components/ImportQueue.tsx', import.meta.url), 'utf-8')

  it('用 dismissRemainingMs 按绝对时间算剩余，并在卸载/重建时清理 timer', () => {
    const s = src()
    expect(s).toContain('dismissRemainingMs')
    expect(s).toContain('clearTimeout')
    // 倒计时依赖 hovered：悬停时 effect 提前返回（= 暂停），移开重建
    expect(s).toContain('if (hovered || imports.length === 0) return')
    expect(s).toContain('onMouseEnter')
    expect(s).toContain('onMouseLeave')
  })

  it('不使用 setInterval 轮询整表', () => {
    // 只匹配真正的调用（注释里说明"不用轮询"不算违规）
    expect(src()).not.toMatch(/setInterval\s*\(/)
  })
})
