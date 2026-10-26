/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   与 tests/deleteFlowFix.test.ts 同手法：必须先挂 DOM lib 再 import store。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset } from '../src/shared/types'
import {
  DEFAULT_UNDO_GRACE_MS,
  isUndoGraceMs,
  normalizeUndoGraceMs
} from '../src/shared/undoGrace'
import { migrateSettings, normalizeSettings } from '../src/main/settings'
import {
  UNDO_GRACE_OPTIONS,
  undoGraceHint,
  undoGraceSeconds,
  undoGraceSuffix
} from '../src/renderer/logic/graceText'

/**
 * 「删除撤销期」三档（0 / 3000 / 5000）单测（2026-10 用户需求）。
 *
 * 用户原话：「删除是否要等 5 秒在设置里面给用户权限，因为不是所有用户都需要等 5 秒撤销的。」
 * 用户已裁定三档：不等待 / 3 秒 / 5 秒（默认）；选「不等待」时**二阶确认仍然保留**，
 * 只是没有倒计时条（撤销只能靠「最近删除」/ 回收站）。
 *
 * 覆盖四层：
 * ① `normalizeUndoGraceMs` 纯函数（脏值 9999 / 'abc' / null / 缺键 → 5000，**0 必须保留**）；
 * ② 主进程读档 `migrateSettings` / 写档 `normalizeSettings` 的单项降级（铁律：不能吃掉 0，
 *    也不能拖垮整份设置）；
 * ③ 文案 `undoGraceHint` / `undoGraceSuffix`（0 → 没有撤销期，5 秒 / 3 秒 → 对应秒数）；
 * ④ store 删除链路：`graceMs === 0` 时 `confirmDelete()` **不进 grace**、直接落盘
 *    （= `NoticeToast` 的撤销条渲染条件永远不成立 → 天然没有倒计时条）。
 */

// ── ① 纯函数归一化 ────────────────────────────────────────────────

describe('normalizeUndoGraceMs：只认三档，脏值回落默认 5000', () => {
  it('三个合法值原样保留（含 0 = 不等待）', () => {
    expect(normalizeUndoGraceMs(0)).toBe(0) // ⚠️ 0 是合法档位，不能被 falsy 兜底吃掉
    expect(normalizeUndoGraceMs(3000)).toBe(3000)
    expect(normalizeUndoGraceMs(5000)).toBe(5000)
    expect(DEFAULT_UNDO_GRACE_MS).toBe(5000)
  })

  it('越界 / 非数字 / 空值 / 缺键 一律回落 5000', () => {
    const dirty: unknown[] = [9999, -1, 3001, '5000', 'abc', null, undefined, NaN, {}, [], true]
    for (const v of dirty) {
      expect(normalizeUndoGraceMs(v)).toBe(5000)
    }
  })

  it('类型守卫只放行三档', () => {
    expect(isUndoGraceMs(0)).toBe(true)
    expect(isUndoGraceMs(3000)).toBe(true)
    expect(isUndoGraceMs(5000)).toBe(true)
    expect(isUndoGraceMs(5001)).toBe(false)
    expect(isUndoGraceMs('5000')).toBe(false)
  })
})

// ── ② 主进程读档 / 写档 ──────────────────────────────────────────

describe('settings 归一化：0 不被吃掉 + 脏值单项降级', () => {
  it('写档（normalizeSettings）：0 / 3000 / 5000 原样保留', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, undoGraceMs: 0 }).undoGraceMs).toBe(0)
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, undoGraceMs: 3000 }).undoGraceMs).toBe(3000)
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, undoGraceMs: 5000 }).undoGraceMs).toBe(5000)
  })

  it('写档（normalizeSettings）：9999 / 字符串脏值 → 5000，且其他字段（libraryDir）不丢', () => {
    const out = normalizeSettings({
      ...DEFAULT_SETTINGS,
      libraryDir: 'D:\\MyLibrary',
      undoGraceMs: 9999
    })
    expect(out.undoGraceMs).toBe(5000)
    expect(out.libraryDir).toBe('D:\\MyLibrary')

    const dirty = normalizeSettings({
      ...DEFAULT_SETTINGS,
      libraryDir: 'D:\\MyLibrary',
      undoGraceMs: 'abc' as unknown as number
    })
    expect(dirty.undoGraceMs).toBe(5000)
    expect(dirty.libraryDir).toBe('D:\\MyLibrary')
  })

  it('读档（migrateSettings）：旧档缺键 → 5000；存档里显式 0 → 0', () => {
    // 旧版本 settings.json 没有 undoGraceMs 这个键 = 升级用户
    expect(migrateSettings({ libraryDir: 'E:\\ModVault\\Library' }).undoGraceMs).toBe(5000)
    // 用户选过「不等待」→ 读回来必须还是 0（否则重启一次设置就失效）
    expect(migrateSettings({ libraryDir: 'E:\\ModVault\\Library', undoGraceMs: 0 }).undoGraceMs).toBe(0)
    expect(
      migrateSettings({ libraryDir: 'E:\\ModVault\\Library', undoGraceMs: 3000 }).undoGraceMs
    ).toBe(3000)
  })
})

// ── ③ 文案 ───────────────────────────────────────────────────────

describe('撤销期文案（6 处硬编码「5 秒」的统一替代）', () => {
  it('undoGraceHint：轻提示整句随档位变', () => {
    expect(undoGraceHint(5000)).toBe('已移入回收站，5 秒内可撤销')
    expect(undoGraceHint(3000)).toBe('已移入回收站，3 秒内可撤销')
    expect(undoGraceHint(0)).toBe('已移入回收站，没有撤销期')
  })

  it('undoGraceSuffix：标题/提示片段随档位变', () => {
    expect(undoGraceSuffix(5000)).toBe('5 秒内可撤销')
    expect(undoGraceSuffix(3000)).toBe('3 秒内可撤销')
    expect(undoGraceSuffix(0)).toBe('没有撤销期')
  })

  it('脏值走归一化 → 永远按 5 秒渲染（不出现 undefined 秒）', () => {
    expect(undoGraceSuffix(9999)).toBe('5 秒内可撤销')
    expect(undoGraceHint(Number.NaN)).toBe('已移入回收站，5 秒内可撤销')
    expect(undoGraceSeconds(9999)).toBe(5)
  })

  it('设置页三档顺序与文案齐全（不等待 → 3 秒 → 5 秒）', () => {
    expect(UNDO_GRACE_OPTIONS.map((o) => o.value)).toEqual([0, 3000, 5000])
    expect(UNDO_GRACE_OPTIONS.map((o) => o.label)).toEqual(['不等待', '3 秒', '5 秒'])
  })
})

// ── ④ store 删除链路（桩写法同 tests/deleteFlowFix.test.ts）──────────

const modvault = {
  renameAsset: vi.fn(),
  rescan: vi.fn(),
  pruneThumbs: vi.fn().mockResolvedValue(0),
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0),
  migrateLayout: vi.fn().mockResolvedValue({ ok: [], failed: [] }),
  trashPaths: vi.fn()
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const bulkDeleteCalls: string[][] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => {
    bulkDeleteCalls.push([...ids])
    return ids.length
  })
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

const tmpDirs: string[] = []
let seq = 0

async function fixture(): Promise<Asset> {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-grace-'))
  tmpDirs.push(folder)
  await fs.writeFile(path.join(folder, '资产.skp'), 'x'.repeat(32))
  return {
    id: `ccccccc-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder,
    relFolder: `模型/未分类/未分类/资产${n}`,
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [{ rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 32, kind: 'model' }],
    size: 32,
    suVersion: 'SU 2024',
    suMajor: 24,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: []
  }
}

beforeEach(() => {
  bulkDeleteCalls.length = 0
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  modvault.deleteThumb.mockResolvedValue(0)
  // 钉到 'recycle' = 旧路径（trashPaths + 删索引），本文件只关心"什么时候落盘"，
  // 不测软删路径（那部分在 tests/trashView.test.ts）。
  useVault.setState({
    pendingDelete: null,
    notice: null,
    settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle' }
  })
})

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('requestDelete：graceMs 快照来自设置', () => {
  /** 只给 `requestDelete` 用的最小资产（不落盘、不进库，只过 `isDeletedAsset` 过滤） */
  const stubAsset = (id: string): Asset =>
    ({
      id,
      name: `资产-${id}`,
      folder: `C:\\stub\\${id}`,
      files: [],
      size: 0,
      category1: '未分类',
      category2: '未分类'
    }) as unknown as Asset

  it('设置 0 / 3000 / 5000 → pendingDelete.graceMs 对应三档', () => {
    const run = (ms: number) => {
      useVault.setState({
        assets: [stubAsset('x')],
        pendingDelete: null,
        settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle', undoGraceMs: ms }
      })
      useVault.getState().requestDelete(['x'])
      return useVault.getState().pendingDelete?.graceMs
    }
    expect(run(0)).toBe(0) // ⚠️ 0 必须原样快照，不能回落 5000
    expect(run(3000)).toBe(3000)
    expect(run(5000)).toBe(5000)
  })

  it('settings 为 null（启动早期）→ 回落默认 5000', async () => {
    const a = await fixture()
    useVault.setState({ assets: [a], settings: null })
    useVault.getState().requestDelete([a.id])
    expect(useVault.getState().pendingDelete?.graceMs).toBe(DEFAULT_UNDO_GRACE_MS)
  })
})

describe('confirmDelete：graceMs === 0 不进 grace，直接落盘（= 没有倒计时条）', () => {
  it('确认后 pendingDelete 同步清空、从不出现 stage=grace、文件真的被删', async () => {
    const a = await fixture()
    useVault.setState({
      assets: [a],
      selectedId: a.id,
      selectedIds: [a.id],
      settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle', undoGraceMs: 0 }
    })
    modvault.trashPaths.mockImplementation(async (paths: string[]) => {
      for (const p of paths) await fs.rm(p, { recursive: true, force: true })
      return []
    })

    // ① 二次确认阶段仍在（"不等待"只取消倒计时，不取消确认）
    useVault.getState().requestDelete([a.id])
    expect(useVault.getState().pendingDelete?.stage).toBe('confirming')
    expect(useVault.getState().pendingDelete?.graceMs).toBe(0)

    // ② 确认：**不进入 grace**。commitDelete 先同步 set({pendingDelete:null}) 再 await IPC，
    //    所以这一行返回时状态机已经收场 —— `NoticeToast` 的删除撤销条只在
    //    `pendingDelete.stage === 'grace'` 时渲染（NoticeToast.tsx 的 `const grace = ...`），
    //    这里 `pendingDelete` 直接是 null → 倒计时条天然不存在，无需在 toast 里特判。
    useVault.getState().confirmDelete()
    expect(useVault.getState().pendingDelete).toBeNull()

    // ③ 落盘确实发生了（不是"什么都没做"）
    await vi.waitFor(() => expect(modvault.trashPaths).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(bulkDeleteCalls).toEqual([[a.id]]))
    await expect(fs.stat(a.folder)).rejects.toThrow()
    expect(useVault.getState().assets).toEqual([])
    expect(useVault.getState().selectedId).toBeNull()
  })

  it('源码守卫：NoticeToast 的删除撤销条只在 stage === grace 时渲染（没有 graceMs 0 特判）', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src/renderer/components/NoticeToast.tsx'),
      'utf-8'
    )
    expect(src).toContain("pending.stage === 'grace'")
    // 倒计时长度来自 pending.graceMs（不是全局常量 5 秒）
    expect(src).toContain('pending.graceMs')
    // 不允许为「不等待」加第二套渲染分支（那会让"没有倒计时条"变成两处实现）。
    // 只检查**代码**：注释里解释 `graceMs 为 0` 是允许的，所以先剥掉注释再匹配。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/graceMs\s*[<>=!]==?\s*0/)
  })
})

describe('confirmDelete：graceMs > 0 仍走原宽限期（回归）', () => {
  it('3000 档进 grace、startedAt 有值、磁盘不动；撤销后仍然什么都不删', async () => {
    const a = await fixture()
    useVault.setState({
      assets: [a],
      selectedId: a.id,
      settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle', undoGraceMs: 3000 }
    })

    useVault.getState().requestDelete([a.id])
    useVault.getState().confirmDelete()

    const pending = useVault.getState().pendingDelete
    expect(pending?.stage).toBe('grace')
    expect(pending?.graceMs).toBe(3000)
    expect(pending?.startedAt).toBeGreaterThan(0)
    // 宽限期内文件仍在磁盘上（undo 可行的前提）
    await expect(fs.stat(a.folder)).resolves.toBeTruthy()
    expect(modvault.trashPaths).not.toHaveBeenCalled()

    useVault.getState().undoDelete()
    expect(useVault.getState().pendingDelete).toBeNull()
    await expect(fs.stat(a.folder)).resolves.toBeTruthy()
    expect(bulkDeleteCalls).toEqual([])
  })
})
