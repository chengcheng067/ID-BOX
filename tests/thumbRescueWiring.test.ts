/// <reference lib="dom" />
/**
 * 救援**接线**测试（`store.init` 的真实代码路径）。
 *
 * 这一层只测三件靠纯函数测不出来的事：
 * ① `init` 里救援**先于**三个补齐队列完成（证据：被救援的资产不再被
 *    `ensureMissingThumbs` 抓去生成封面缩略图）；
 * ② `listThumbs` 失败时 `init` **照常完成**（救援静默，绝不能让"修数据的版本"打不开）；
 * ③ 事故参数的恢复走真实写库路径（只写 `renderParams` / 两个缩略图字段，
 *    且 `preferThumb` 能把"最新但错误"的那张换回正确的那张）。
 *
 * 环境：与 `tests/importQueueDismiss.test.ts` / `tests/storeFlow.test.ts` 同一套桩
 * （node 没有 window / IndexedDB），断言只看真实 action 的效果。
 */
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type ImportEvent, type ThumbFileEntry } from '../src/shared/types'

const ID = '5e4c3050-e057-4681-a70a-cb277890c309'
const GOOD = `${ID}-e94039c0.png` // UV 3.10（正确）
const NEWER = `${ID}-7933daa4.png` // 默认 UV（更晚，通用规则会挑到它）

/** 磁盘上的两个候选：注意 `NEWER` 的 mtime 更晚 */
const disk: ThumbFileEntry[] = [
  { name: GOOD, size: 367321, mtimeMs: 1000 },
  { name: NEWER, size: 480673, mtimeMs: 5000 }
]

// ── 边界桩（必须在 import store 之前就位） ─────────────────────────
const modvault = {
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async () => true),
  listThumbs: vi.fn(async (): Promise<ThumbFileEntry[]> => disk),
  detectMaterialMerge: vi.fn(async () => ({ needMerge: false, count: 0, sources: [] })),
  onMaterialMergeNotice: vi.fn(() => () => undefined),
  onImportBatchDone: vi.fn(() => () => undefined),
  onImportConflictAsk: vi.fn(() => () => undefined),
  onImportConflictExpired: vi.fn(() => () => undefined),
  onImportEvent: vi.fn((_cb: (ev: ImportEvent) => void) => () => undefined)
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const { useVault, resetBallLazyUpgradeForTests } = await import('../src/renderer/store')

/**
 * 内存版 assets 表：支持 toArray / bulkGet / put / bulkPut / where().equals().modify()。
 *
 * `modifyCalls` 记录**改动了哪些字段**：init 里还有别的任务（知末 ID 回填等）也会
 * 走 `.modify()`，只按调用次数断言会把它们的写入算到救援头上。
 */
let rows: Asset[] = []
const modifyCalls: Array<{ id: string; changed: string[] }> = []
/** 浅比较两条记录的键差异（够用：救援只改标量字段） */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}
const fakeAssets = {
  toArray: vi.fn(async () => rows.map((r) => ({ ...r }))),
  bulkGet: vi.fn(async (ids: readonly string[]) => ids.map((id) => rows.find((r) => r.id === id))),
  put: vi.fn(async (a: Asset) => {
    const i = rows.findIndex((r) => r.id === a.id)
    if (i >= 0) rows[i] = a
    else rows.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    for (const a of list) {
      const i = rows.findIndex((r) => r.id === a.id)
      if (i >= 0) rows[i] = a
      else rows.push(a)
    }
    return list.length
  }),
  bulkDelete: vi.fn(async () => 0),
  where: vi.fn((key: string) => ({
    equals: (id: string) => ({
      modify: vi.fn(async (fn: (a: Asset) => void) => {
        expect(key).toBe('id')
        const rec = rows.find((r) => r.id === id)
        if (!rec) return 0
        const before = { ...rec } as Record<string, unknown>
        fn(rec)
        modifyCalls.push({ id, changed: changedKeys(before, rec as unknown as Record<string, unknown>) })
        return 1
      })
    })
  }))
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })

const backups = new Map<string, { id: string; at: number; json: string }>()
Object.defineProperty(db, 'backups', {
  value: {
    put: vi.fn(async (b: { id: string; at: number; json: string }) => {
      backups.set(b.id, b)
      return b.id
    }),
    toArray: vi.fn(async () => [...backups.values()]),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

/** 一个"材质资产"最小形态：有 albedo（会进球队列），封面非 named/manual */
function asset(over: Partial<Asset> = {}): Asset {
  return {
    id: ID,
    name: '仿古砖',
    kind: 'material',
    source: 'AmbientCG',
    folder: 'E:\\ModVault\\Library\\材质\\未分类\\未分类\\仿古砖',
    relFolder: '材质/未分类/未分类/仿古砖',
    cover: '仿古砖.cover.jpg',
    coverSource: 'root',
    files: [
      { rel: '仿古砖.cover.jpg', name: '仿古砖.cover.jpg', ext: 'jpg', size: 10, kind: 'texture' }
    ],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'material:仿古砖',
    importedAt: 1,
    updatedAt: 1,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

beforeEach(() => {
  rows = []
  backups.clear()
  modifyCalls.length = 0
  resetBallLazyUpgradeForTests()
  useVault.setState({ assets: [], selectedId: null, ready: false })
  for (const fn of Object.values(modvault)) fn.mockReset()
  modvault.getSettings.mockImplementation(async () => ({ ...DEFAULT_SETTINGS }))
  modvault.pruneThumbs.mockImplementation(async () => 0)
  modvault.ensureThumb.mockImplementation(async () => null)
  modvault.deleteThumb.mockImplementation(async () => 0)
  modvault.deleteOneThumb.mockImplementation(async () => true)
  modvault.listThumbs.mockImplementation(async () => disk)
  modvault.detectMaterialMerge.mockImplementation(async () => ({ needMerge: false, count: 0, sources: [] }))
  modvault.onMaterialMergeNotice.mockImplementation(() => () => undefined)
  modvault.onImportBatchDone.mockImplementation(() => () => undefined)
  modvault.onImportConflictAsk.mockImplementation(() => () => undefined)
  modvault.onImportConflictExpired.mockImplementation(() => () => undefined)
  modvault.onImportEvent.mockImplementation(() => () => undefined)
})

afterEach(() => {
  resetBallLazyUpgradeForTests()
})

describe('init · 救援接线', () => {
  it('被抹掉 thumbPath 的资产：init 后挂回，且**先于** ensureMissingThumbs（不再被封面缩略图抢走）', async () => {
    // 用非目标 id：目标 id 会命中 prefer 例外，测不出"按 mtime 通用规则挂回"
    const OTHER = '99999999-8888-4777-8666-555544443333'
    rows = [
      asset({
        id: OTHER,
        name: '混凝土',
        folder: 'E:\\ModVault\\Library\\材质\\未分类\\未分类\\混凝土',
        relFolder: '材质/未分类/未分类/混凝土',
        cover: '混凝土.cover.jpg',
        files: [{ rel: '混凝土.cover.jpg', name: '混凝土.cover.jpg', ext: 'jpg', size: 10, kind: 'texture' }],
        dedupeKey: 'material:混凝土',
        thumbStatus: 'none',
        thumbPath: undefined
      })
    ]
    modvault.listThumbs.mockImplementation(async () => [
      { name: `${OTHER}-11111111.png`, size: 100, mtimeMs: 1000 },
      { name: `${OTHER}-22222222.jpg`, size: 100, mtimeMs: 5000 } // 最新
    ])

    await useVault.getState().init()

    const after = useVault.getState().assets[0]!
    expect(after.thumbPath).toBe(`${OTHER}-22222222.jpg`) // 通用规则：取 mtime 最大（不认 rev）
    expect(after.thumbStatus).toBe('ready')
    // 写库走的是定向 modify（不是整对象 put），且只碰这两个字段
    const rescueWrite = modifyCalls.find((c) => c.changed.includes('thumbPath'))
    expect(rescueWrite).toBeTruthy()
    expect(rescueWrite!.id).toBe(OTHER)
    expect(rescueWrite!.changed.sort()).toEqual(['thumbPath', 'thumbStatus'])
    // 快照：rescue-<ts>，json 是原记录
    const snapshot = [...backups.values()].find((b) => b.id.startsWith('rescue-'))
    expect(snapshot).toBeTruthy()
    expect((JSON.parse(snapshot!.json) as Array<{ id: string }>)[0]!.id).toBe(OTHER)
    // 顺序证据：救援把它变成 ready 之后，封面缩略图分支就不会再看它
    expect(modvault.ensureThumb).not.toHaveBeenCalled()
    modvault.listThumbs.mockImplementation(async () => disk)
  })

  it('事故参数：renderParams 补齐六字段；目标资产经 prefer 从 `…-7933daa4` 换回 `…-e94039c0`', async () => {
    // 真实记录：manual 封面 + `…-7933daa4.png`（默认 UV，mtime 更晚）。
    // manual 本应跳过救援，但它在静态表里被点名 → prefer 例外生效。
    rows = [asset({ coverSource: 'manual', thumbPath: NEWER, thumbStatus: 'ready' })]

    await useVault.getState().init()

    const after = useVault.getState().assets[0]!
    expect(after.thumbPath).toBe(GOOD)
    expect(after.renderParams).toEqual({
      roughness: 1,
      bump: 1,
      uv: 3.1,
      light: 1,
      metal: 0,
      alpha: 1,
      // 0.7.6：灰度透明开关默认关（补齐成完整结构的一部分）
      alphaFromMap: false,
      invertAlpha: false
    })
  })

  it('`manual` / `named`（不在静态表里）不进救援：不写库、不写快照', async () => {
    // ⚠️ 必须用**另一个 id**：用目标 id 会命中 prefer 例外，测不出"跳过"
    const OTHER = '99999999-8888-4777-8666-555544443333'
    for (const coverSource of ['manual', 'named'] as const) {
      rows = [
        asset({
          id: OTHER,
          name: '混凝土',
          folder: 'E:\\ModVault\\Library\\材质\\未分类\\未分类\\混凝土',
          relFolder: '材质/未分类/未分类/混凝土',
          cover: '混凝土.cover.jpg',
          files: [{ rel: '混凝土.cover.jpg', name: '混凝土.cover.jpg', ext: 'jpg', size: 10, kind: 'texture' }],
          dedupeKey: 'material:混凝土',
          coverSource,
          thumbStatus: 'none',
          thumbPath: undefined
        })
      ]
      backups.clear()
      modifyCalls.length = 0
      modvault.listThumbs.mockImplementation(async () => [
        { name: `${OTHER}-00ff00ff.png`, size: 4096, mtimeMs: 9000 } // 盘上有球图候选也不碰
      ])

      await useVault.getState().init()

      const after = useVault.getState().assets[0]!
      expect(after.thumbPath).toBeUndefined()
      expect(backups.size).toBe(0)
    }
    modvault.listThumbs.mockImplementation(async () => disk)
  })

  it('用户已经调过参数 → 一个字节都不覆盖（救援只填空）', async () => {
    rows = [
      asset({
        thumbPath: GOOD,
        thumbStatus: 'ready',
        renderParams: { roughness: 1, bump: 1, uv: 2.2, light: 1, metal: 0, alpha: 1 }
      })
    ]

    await useVault.getState().init()

    expect(useVault.getState().assets[0]!.renderParams?.uv).toBe(2.2)
  })

  it('`listThumbs` 直接 reject → init 照常完成，记录不被改动（失败静默）', async () => {
    rows = [asset({ thumbStatus: 'none', thumbPath: undefined })]
    modvault.listThumbs.mockImplementation(async () => {
      throw new Error('IPC 断了 / 主进程未就绪')
    })

    await expect(useVault.getState().init()).resolves.toBeUndefined()

    expect(useVault.getState().ready).toBe(true)
    const after = useVault.getState().assets[0]!
    expect(after.thumbPath).toBeUndefined()
    expect(backups.size).toBe(0) // 空跑：不写快照
  })

  it('盘上没有任何缩略图 → 不写快照、不碰 thumbPath，但事故参数仍会恢复（两件事互不依赖）', async () => {
    rows = [asset({ thumbStatus: 'none' })]
    modvault.listThumbs.mockImplementation(async () => [])

    await useVault.getState().init()

    const after = useVault.getState().assets[0]!
    expect(after.thumbPath).toBeUndefined() // 没图可挂，不许凭空造名字
    expect(backups.size).toBe(0) // 没有缩略图改动 → 无需快照
    expect(after.renderParams?.uv).toBe(3.1) // 参数恢复不依赖 thumb:list
    const touchedThumb = modifyCalls.filter((c) =>
      c.changed.some((k) => k === 'thumbPath' || k === 'thumbStatus')
    )
    expect(touchedThumb).toEqual([])
  })

  it('完全没病（参数已在 + 盘上无候选）→ 零写入、零快照（每次启动的常态路径）', async () => {
    rows = [
      asset({
        thumbPath: GOOD,
        thumbStatus: 'ready',
        renderParams: { roughness: 1, bump: 1, uv: 3.1, light: 1, metal: 0, alpha: 1 }
      })
    ]
    modvault.listThumbs.mockImplementation(async () => [])

    await useVault.getState().init()

    expect(backups.size).toBe(0)
    const touched = modifyCalls.filter((c) =>
      c.changed.some((k) => k === 'thumbPath' || k === 'thumbStatus' || k === 'renderParams')
    )
    expect(touched).toEqual([])
  })
})
