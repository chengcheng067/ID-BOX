/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，renderer 源码依赖 DOM 全局（window）。
// 真实声明在 src/renderer/env.d.ts（只对 tsconfig.web 生效），这里补一份供测试用。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

/**
 * 「知末站方分类重排」的验收（渲染层）。
 *
 * 三块：
 * ① 纯逻辑：候选筛选 / `planZhimoReclass` 判定矩阵 / 分类对分组；
 * ② 队列：节流、计数口径、取消（不再发请求但已抓到的照常返回）；
 * ③ store 真实 action：备份前缀隔离、分组落库、取消后仍落库、单组失败不中断、链式触发。
 *
 * 全部**零网络 / 零真实磁盘**：`window.modvault` 是桩，Dexie 用内存版假表，
 * 测的是要发布的代码路径（不抽副本），做法同 `tests/reclassifyStore.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type {
  Asset,
  AssignCategoryPayload,
  AssignCategoryResult,
  FetchZhimoMetaResult,
  Settings
} from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import {
  ZHIMO_RECLASS_BACKUP_PREFIX,
  categoryPairKey,
  groupByCategoryPair,
  isZhimoReclassCandidate,
  isZhimoReclassSkip,
  parseCategoryPairKey,
  planZhimoReclass,
  runZhimoReclassQueue,
  zhimoReclassIdOf,
  zhimoReclassSummaryText,
  type ZhimoReclassHit,
  type ZhimoReclassTarget
} from '../src/renderer/logic/zhimoReclass'

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/** 调用顺序记录：'meta'（重排抓详情页）/ 'cover'（抓封面）/ 'move'（搬目录） */
const order: string[] = []

type ImportEventCb = (ev: {
  item: string
  itemName: string
  status: 'done' | 'error'
  asset?: Asset
}) => void
let importEventCb: ImportEventCb | null = null
let batchDoneCb: (() => void) | null = null

const modvault = {
  fetchZhimoMeta: vi.fn(),
  fetchZhimoCover: vi.fn(),
  assignCategory: vi.fn(),
  reportLog: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  pruneThumbs: vi.fn(),
  rescan: vi.fn(),
  detectMaterialMerge: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  onMaterialMergeNotice: vi.fn(() => () => {}),
  onImportConflictAsk: vi.fn(() => () => {}),
  onImportConflictExpired: vi.fn(() => () => {}),
  onImportEvent: vi.fn((cb: ImportEventCb) => {
    importEventCb = cb
    return () => {}
  }),
  onImportBatchDone: vi.fn((cb: () => void) => {
    batchDoneCb = cb
    return () => {}
  })
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
import type { IndexBackup } from '../src/renderer/db'

/** 资产表（只关心 assignCategory 落库用到的 bulkPut） */
const bulkPutCalls: Asset[][] = []
const fakeAssets = {
  toArray: vi.fn(async () => [] as Asset[]),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })

/** 备份表（内存版 Dexie） */
const backupStore = new Map<string, IndexBackup>()
const fakeBackups = {
  put: vi.fn(async (b: IndexBackup) => {
    backupStore.set(b.id, b)
    order.push('backup')
    return b.id
  }),
  toArray: vi.fn(async () => [...backupStore.values()]),
  bulkDelete: vi.fn(async (ids: string[]) => {
    for (const id of ids) backupStore.delete(id)
    return ids.length
  })
}
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    coverSource: 'placeholder',
    thumbStatus: 'none',
    files: [{ rel: '模型.skp', name: '模型.skp', ext: 'skp', size: 10, kind: 'model' }],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    styles: [],
    ...over
  }
}

const baseName = (folder: string): string => folder.split(/[\\/]/).pop() ?? 'x'

/** 一次 `fetchZhimoMeta` 的成功返回（四个字段恒在，null = 站方没给） */
function metaOf(classifyBaseName: string | null): FetchZhimoMetaResult {
  return { ok: true, classifyBaseName, style: null, version: null, title: null }
}

const settingsOf = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch })

/**
 * 设置页还没加 `zhimoAutoCategory` 字段：测试里按"可选扩展"塞进去，
 * 与 store 的读取口径（`as Settings & { zhimoAutoCategory?: boolean }`）一致。
 */
function settingsWithAuto(auto: boolean): Settings {
  return { ...DEFAULT_SETTINGS, zhimoAutoCategory: auto } as unknown as Settings
}

// ── store 层 `assignCategory` 的 spy（数"分组"，不是数 IPC） ─────────

/**
 * ⚠️ 不能拿 `window.modvault.assignCategory` 数分组——那是**单资产**级 IPC，
 * `store.assignCategory(ids,…)` 内部会为每个资产调一次。要验证"同落点只调一次"，
 * 必须看 store 这一层。
 */
const originalAssign = useVault.getState().assignCategory
let assignSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  order.length = 0
  backupStore.clear()
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  modvault.fetchZhimoMeta.mockReset()
  modvault.fetchZhimoCover.mockReset()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.detectMaterialMerge.mockResolvedValue({ needMerge: false, count: 0, sources: [] })
  modvault.getSettings.mockResolvedValue(settingsOf())
  // 真实 IPC 的语义：把目录搬到 <库>/<大类>/<一级>/<二级>/<原名>，回填最终路径
  modvault.assignCategory.mockImplementation(
    async (p: AssignCategoryPayload): Promise<AssignCategoryResult> => {
      order.push('move')
      const name = baseName(p.folder)
      return {
        folder: `E:\\Lib\\${p.kindFolderName}\\${p.category1}\\${p.category2}\\${name}`,
        name,
        relFolder: `${p.kindFolderName}/${p.category1}/${p.category2}/${name}`,
        category1: p.category1,
        category2: p.category2,
        moved: true,
        renamed: false,
        changed: false
      }
    }
  )
  importEventCb = null
  batchDoneCb = null
  useVault.setState({
    assets: [],
    settings: settingsOf(),
    notice: null,
    reclassifyBusy: false,
    reclassifyBackupCount: 0,
    zhimoReclass: { running: false, done: 0, total: 0, cancelRequested: false }
  })
  // 上一轮用例可能替换过 assignCategory（失败路径）→ 每轮先复位到真实实现
  assignSpy = vi.fn((ids: string[], category1: string, category2: string) =>
    originalAssign(ids, category1, category2)
  )
  useVault.setState({ assignCategory: assignSpy as unknown as typeof originalAssign })
})

const zhimoBackups = (): IndexBackup[] =>
  [...backupStore.values()].filter((b) => b.id.startsWith(ZHIMO_RECLASS_BACKUP_PREFIX))

// ══════════════════════════════════════════════════════════════════
// ① 候选筛选
// ══════════════════════════════════════════════════════════════════

describe('isZhimoReclassCandidate：三条 AND', () => {
  it('双未分类 + 有知末 ID + 未软删 → 入选', () => {
    expect(isZhimoReclassCandidate(fixture({ zhimoId: '1200166260' }))).toBe(true)
  })

  it('软删记录 → 排除（目录已在 .trash/，assignCategory 必然失败）', () => {
    const trashed = fixture({ zhimoId: '1200166260', deletedAt: 1700000000000 })
    expect(isZhimoReclassCandidate(trashed)).toBe(false)
  })

  it('已分类（哪怕只分了一级）→ 排除', () => {
    expect(
      isZhimoReclassCandidate(fixture({ zhimoId: '1200166260', category1: '家具', category2: '沙发' }))
    ).toBe(false)
    expect(
      isZhimoReclassCandidate(fixture({ zhimoId: '1200166260', category1: '家具', category2: UNCLASSIFIED }))
    ).toBe(false)
  })

  it('取不到知末 ID（zhimoId 空 / 名字无 ID）→ 排除', () => {
    expect(isZhimoReclassCandidate(fixture({ name: '北欧椅子', zhimoId: '' }))).toBe(false)
    expect(isZhimoReclassCandidate(fixture({ name: '北欧椅子', zhimoId: '   ' }))).toBe(false)
    expect(isZhimoReclassCandidate(fixture({ name: '北欧椅子', zhimoId: null }))).toBe(false)
  })

  it('ID 口径与封面通道一致：zhimoId 优先，为空回退名字解析', () => {
    expect(zhimoReclassIdOf(fixture({ name: '现代壁灯', zhimoId: '1232108421' }))).toBe('1232108421')
    expect(zhimoReclassIdOf(fixture({ name: '侘寂壁灯ID_1200166260', zhimoId: null }))).toBe(
      '1200166260'
    )
    expect(zhimoReclassIdOf(fixture({ name: '北欧椅子', zhimoId: '' }))).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════
// ② planZhimoReclass —— 判定矩阵（against 真实映射表）
// ══════════════════════════════════════════════════════════════════

describe('planZhimoReclass：精确两级 / 一级-only / 近似 / 候选数组 / 没映射 / 站方没给', () => {
  it('精确两级 → 落两级，approx=false、level1=false', () => {
    const d = planZhimoReclass({ meta: metaOf('沙发'), kind: 'model', name: '沙发' })
    expect(isZhimoReclassSkip(d)).toBe(false)
    if (isZhimoReclassSkip(d)) return
    expect(d).toMatchObject({
      category1: '家具',
      category2: '沙发',
      approx: false,
      level1: false
    })
  })

  it('一对多按 kind 分流：窗帘 + model → 软装陈设/窗帘布艺；+texture → 布纹/窗帘', () => {
    const model = planZhimoReclass({ meta: metaOf('窗帘'), kind: 'model' })
    const texture = planZhimoReclass({ meta: metaOf('窗帘'), kind: 'texture' })
    expect(isZhimoReclassSkip(model)).toBe(false)
    expect(isZhimoReclassSkip(texture)).toBe(false)
    if (isZhimoReclassSkip(model) || isZhimoReclassSkip(texture)) return
    expect([model.category1, model.category2]).toEqual(['软装陈设', '窗帘布艺'])
    expect([texture.category1, texture.category2]).toEqual(['布纹', '窗帘'])
  })

  it('站方只给一级（木纹）→ category2 = 未分类、level1=true', () => {
    const d = planZhimoReclass({ meta: metaOf('木纹'), kind: 'texture' })
    expect(isZhimoReclassSkip(d)).toBe(false)
    if (isZhimoReclassSkip(d)) return
    expect(d.category1).toBe('木纹')
    expect(d.category2).toBe(UNCLASSIFIED)
    expect(d.level1).toBe(true)
    expect(d.approx).toBe(false)
  })

  it('近似归并（茶具）→ approx=true，落点与表一致', () => {
    const d = planZhimoReclass({ meta: metaOf('茶具'), kind: 'model' })
    expect(isZhimoReclassSkip(d)).toBe(false)
    if (isZhimoReclassSkip(d)) return
    expect(d).toMatchObject({
      category1: '软装陈设',
      category2: '摆件',
      approx: true,
      level1: false,
      stationName: '茶具'
    })
    expect(d.source).toContain('站方实测')
  })

  it('一级近似（夹胶玻璃）→ approx=true **且** level1=true，二级是哨兵', () => {
    const d = planZhimoReclass({ meta: metaOf('夹胶玻璃'), kind: 'texture' })
    expect(isZhimoReclassSkip(d)).toBe(false)
    if (isZhimoReclassSkip(d)) return
    expect(d.category1).toBe('玻璃')
    expect(d.category2).toBe(UNCLASSIFIED)
    expect(d.approx).toBe(true)
    expect(d.level1).toBe(true)
  })

  it('候选数组（kind 筛不出唯一）→ ambiguous，绝不猜', () => {
    // `窗帘` 的两个候选只覆盖 model / texture / material；hdri 一个都不匹配 → 退回完整候选数组
    const d = planZhimoReclass({ meta: metaOf('窗帘'), kind: 'hdri' })
    expect(d).toEqual({ skip: 'ambiguous' })
  })

  it('映射表里没有 → unmapped', () => {
    const d = planZhimoReclass({ meta: metaOf('站方某个没抄录的分类'), kind: 'model' })
    expect(d).toEqual({ skip: 'unmapped' })
  })

  it('classifyBaseName=null / 空串 / 纯空白 → no-station（**正常结果**，不是失败）', () => {
    expect(planZhimoReclass({ meta: metaOf(null), kind: 'model' })).toEqual({ skip: 'no-station' })
    expect(planZhimoReclass({ meta: metaOf(''), kind: 'model' })).toEqual({ skip: 'no-station' })
    expect(planZhimoReclass({ meta: metaOf('   '), kind: 'model' })).toEqual({ skip: 'no-station' })
    // 字段缺省（老主进程 / 解析失败）同样按"站方没给"
    expect(planZhimoReclass({ meta: { ok: true }, kind: 'model' })).toEqual({ skip: 'no-station' })
  })

  it('meta.ok=false（网络/超时/ID 不存在）→ no-station 兜底（store 侧先按 failed 计）', () => {
    expect(
      planZhimoReclass({ meta: { ok: false, reason: 'timeout' }, kind: 'model' })
    ).toEqual({ skip: 'no-station' })
  })
})

// ══════════════════════════════════════════════════════════════════
// ③ 分组 / 键
// ══════════════════════════════════════════════════════════════════

describe('groupByCategoryPair / categoryPairKey', () => {
  it('两个分类对 → 两个组，ids 按入参顺序', () => {
    const groups = groupByCategoryPair([
      { id: 'a', category1: '家具', category2: '沙发' },
      { id: 'b', category1: '灯具', category2: '吊灯' },
      { id: 'c', category1: '家具', category2: '沙发' }
    ])
    expect(groups.size).toBe(2)
    expect(groups.get(categoryPairKey('家具', '沙发'))).toEqual(['a', 'c'])
    expect(groups.get(categoryPairKey('灯具', '吊灯'))).toEqual(['b'])
  })

  it('键用 NUL 分隔，可无损解析（分类名可含 / 与 |）', () => {
    const key = categoryPairKey('酒店/民宿', 'a|b')
    expect(key).toBe('酒店/民宿\u0000a|b')
    expect(parseCategoryPairKey(key)).toEqual({ category1: '酒店/民宿', category2: 'a|b' })
  })

  it('空清单 → 空 Map', () => {
    expect(groupByCategoryPair([]).size).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════
// ④ 队列：节流 / 计数 / 取消
// ══════════════════════════════════════════════════════════════════

function target(n: number, over: Partial<ZhimoReclassTarget> = {}): ZhimoReclassTarget {
  return { id: `id-${n}`, zhimoId: `12001662${n}`, kind: 'model', name: `资产${n}`, ...over }
}

describe('runZhimoReclassQueue：节流与计数口径', () => {
  it('每发一次请求前等 gapMs（第一发不等），顺序 = 入参顺序', async () => {
    const sleeps: number[] = []
    const calls: string[] = []
    const res = await runZhimoReclassQueue([target(0), target(1), target(2)], {
      fetchMeta: async (t) => {
        calls.push(t.id)
        return metaOf('沙发')
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      concurrency: 1,
      gapMs: 250
    })
    expect(calls).toEqual(['id-0', 'id-1', 'id-2'])
    expect(sleeps).toEqual([250, 250])
    expect(res.scanned).toBe(3)
    expect(res.hits).toHaveLength(3)
    expect(res.stopped).toBe(false)
  })

  it('计数互斥：hits + ambiguous + unmapped + noStation + failed === scanned', async () => {
    const byName: Record<string, FetchZhimoMetaResult> = {
      'id-0': metaOf('沙发'), // hit
      'id-1': metaOf('窗帘'), // hit（model 可分流）
      'id-2': { ok: false, reason: 'not-found' }, // failed
      'id-3': metaOf(null), // no-station
      'id-4': metaOf('没抄录的名字'), // unmapped
      'id-5': metaOf('窗帘') // hit
    }
    const res = await runZhimoReclassQueue([0, 1, 2, 3, 4, 5].map((n) => target(n)), {
      fetchMeta: async (t) => byName[t.id]!,
      sleep: async () => {},
      concurrency: 1
    })
    // id-5 也是 hit（model 分流到 软装陈设/窗帘布艺）
    expect(res.hits).toHaveLength(3)
    expect(res.failed).toBe(1)
    expect(res.noStation).toBe(1)
    expect(res.unmapped).toBe(1)
    expect(res.ambiguous).toBe(0)
    expect(res.hits.length + res.ambiguous + res.unmapped + res.noStation + res.failed).toBe(
      res.scanned
    )
  })

  it('fetchMeta 抛错 → 记 failed 并继续（绝不中断整批）', async () => {
    const res = await runZhimoReclassQueue([target(0), target(1), target(2)], {
      fetchMeta: async (t) => {
        if (t.id === 'id-1') throw new Error('IPC 炸了')
        return metaOf('沙发')
      },
      sleep: async () => {},
      concurrency: 1
    })
    expect(res.failed).toBe(1)
    expect(res.hits).toHaveLength(2)
    expect(res.stopped).toBe(false)
  })

  it('shouldStop 一开始就为真 → stopped=true、零请求', async () => {
    const fetchMeta = vi.fn(async () => metaOf('沙发'))
    const res = await runZhimoReclassQueue([target(0)], {
      fetchMeta,
      sleep: async () => {},
      shouldStop: () => true
    })
    expect(res).toEqual({
      hits: [],
      scanned: 0,
      ambiguous: 0,
      unmapped: 0,
      noStation: 0,
      failed: 0,
      stopped: true
    })
    expect(fetchMeta).not.toHaveBeenCalled()
  })

  it('跑到一半被叫停 → 剩余不发请求，**已抓到的照常返回**（不能丢结果）', async () => {
    const res = await runZhimoReclassQueue([target(0), target(1), target(2)], {
      fetchMeta: async (t) => {
        order.push(t.id)
        return metaOf('沙发')
      },
      sleep: async () => {},
      concurrency: 1,
      shouldStop: () => order.length >= 1
    })
    expect(res.stopped).toBe(true)
    expect(order).toEqual(['id-0'])
    expect(res.scanned).toBe(1)
    expect(res.hits.map((h: ZhimoReclassHit) => h.id)).toEqual(['id-0'])
  })
})

// ══════════════════════════════════════════════════════════════════
// ⑤ store 真实 action
// ══════════════════════════════════════════════════════════════════

/** 桩：按知末 ID 返回站方分类（未列出的 → not-found，用来模拟"抓不到"） */
function stubMeta(map: Record<string, FetchZhimoMetaResult>): void {
  modvault.fetchZhimoMeta.mockImplementation(async (payload: { id: string }) => {
    order.push('meta')
    return map[payload.id] ?? ({ ok: false, reason: 'not-found' } as FetchZhimoMetaResult)
  })
}

describe('runZhimoCategoryReclass — 候选 / 分组 / 落库', () => {
  it('两个分类对 → store 层 assignCategory 调两次，参数与 ids 正确', async () => {
    const a = fixture({ zhimoId: '1001' })
    const b = fixture({ zhimoId: '1002' })
    const c = fixture({ zhimoId: '1003' })
    useVault.setState({ assets: [a, b, c] })
    stubMeta({
      '1001': metaOf('沙发'),
      '1002': metaOf('沙发'),
      '1003': metaOf('吊灯')
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary.moved).toBe(3)
    expect(summary.failed).toBe(0)
    expect(assignSpy).toHaveBeenCalledTimes(2)
    const calls = assignSpy.mock.calls as Array<[string[], string, string]>
    const byPair = new Map(calls.map(([ids, c1, c2]) => [`${c1}/${c2}`, [...ids].sort()]))
    expect(byPair.get('家具/沙发')).toEqual([a.id, b.id].sort())
    expect(byPair.get('灯具/吊灯')).toEqual([c.id])
    // 落库条数与命中数一致
    expect(bulkPutCalls.flat().map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort())
    // 内存同步：分类已改
    const inMem = new Map(useVault.getState().assets.map((x) => [x.id, x]))
    expect(inMem.get(a.id)!.category1).toBe('家具')
    expect(inMem.get(c.id)!.category1).toBe('灯具')
  })

  it('已分类 / 软删 / 无知末 ID 的资产：一个请求都不发（零网络）', async () => {
    useVault.setState({
      assets: [
        fixture({ zhimoId: '2001', category1: '家具', category2: '沙发' }),
        fixture({ zhimoId: '2002', deletedAt: 1700000000000 }),
        fixture({ name: '没有 ID 的模型', zhimoId: null })
      ]
    })
    stubMeta({})

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary).toEqual({
      scanned: 0,
      moved: 0,
      approx: 0,
      ambiguous: 0,
      unmapped: 0,
      noStation: 0,
      failed: 0
    })
    expect(modvault.fetchZhimoMeta).not.toHaveBeenCalled()
    expect(fakeBackups.put).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBe('没有需要按知末分类整理的资产')
  })

  it('计数分桶：命中 / 站方未给 / 未映射 / 抓取失败 各归各的桶', async () => {
    const hit = fixture({ zhimoId: '3001' })
    const noStation = fixture({ zhimoId: '3002' })
    const unmapped = fixture({ zhimoId: '3003' })
    const broken = fixture({ zhimoId: '3004' })
    useVault.setState({ assets: [hit, noStation, unmapped, broken] })
    stubMeta({
      '3001': metaOf('沙发'),
      '3002': metaOf(null),
      '3003': metaOf('站方某个没抄录的分类'),
      '3004': { ok: false, reason: 'timeout' }
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary).toEqual({
      scanned: 4,
      moved: 1,
      approx: 0,
      ambiguous: 0,
      unmapped: 1,
      noStation: 1,
      failed: 1
    })
  })

  it('approx 是 moved 的子集且单独计数（茶具 → 软装陈设/摆件）', async () => {
    const approx = fixture({ zhimoId: '4001' })
    const exact = fixture({ zhimoId: '4002' })
    useVault.setState({ assets: [approx, exact] })
    stubMeta({ '4001': metaOf('茶具'), '4002': metaOf('沙发') })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary.moved).toBe(2)
    expect(summary.approx).toBe(1)
    expect(summary.approx).toBeLessThanOrEqual(summary.moved)
    // 日志里必须出现 approx（"有多少条是猜的"的唯一锚点）
    const log = modvault.reportLog.mock.calls.at(-1)?.[0] as {
      message: string
      context: Record<string, unknown>
    }
    expect(log.message).toBe('zhimo:reclass')
    expect(log.context.approx).toBe(1)
    expect(String(log.context.text)).toContain('近似归并 1')
  })
})

describe('runZhimoCategoryReclass — 备份（前缀隔离）', () => {
  it('写 `zhimo-reclass-` 前缀，且**不动**老通道那批 `reclass-`', async () => {
    // 老通道的一条备份（模拟「上次重跑自动分类」的凭证）
    backupStore.set('reclass-1', { id: 'reclass-1', at: 1, json: '[]' })
    const a = fixture({ zhimoId: '5001' })
    useVault.setState({ assets: [a] })
    stubMeta({ '5001': metaOf('沙发') })

    await useVault.getState().runZhimoCategoryReclass({ manual: true, sleep: async () => {} })

    const mine = zhimoBackups()
    expect(mine).toHaveLength(1)
    expect(mine[0]!.id.startsWith('zhimo-reclass-')).toBe(true)
    expect(backupStore.has('reclass-1')).toBe(true) // 老通道备份没被消费
    // 备份内容 = 完整还原凭证（原分类双哨兵）
    const records = JSON.parse(mine[0]!.json) as Array<Record<string, unknown>>
    expect(records[0]).toMatchObject({
      id: a.id,
      name: a.name,
      folder: a.folder,
      relFolder: a.relFolder,
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })

  it('备份写入**早于**任何移动（顺序 = backup → move）', async () => {
    const a = fixture({ zhimoId: '5002' })
    useVault.setState({ assets: [a] })
    stubMeta({ '5002': metaOf('沙发') })

    await useVault.getState().runZhimoCategoryReclass({ manual: true, sleep: async () => {} })

    const backupAt = order.indexOf('backup')
    const moveAt = order.indexOf('move')
    expect(backupAt).toBeGreaterThanOrEqual(0)
    expect(moveAt).toBeGreaterThan(backupAt)
  })

  it('老「撤销上次重跑」的条数统计不受新通道影响', async () => {
    backupStore.set('reclass-1', { id: 'reclass-1', at: 1, json: '[]' })
    useVault.setState({ assets: [fixture({ zhimoId: '5003' })] })
    stubMeta({ '5003': metaOf('沙发') })

    await useVault.getState().runZhimoCategoryReclass({ manual: true, sleep: async () => {} })
    await useVault.getState().refreshReclassBackupCount()

    expect(useVault.getState().reclassifyBackupCount).toBe(1) // 只有老通道那一条
  })
})

describe('runZhimoCategoryReclass — 取消语义', () => {
  it('shouldStop 变真后不再发 fetchZhimoMeta，但**已抓到的仍然落库**', async () => {
    const a = fixture({ zhimoId: '6001' })
    const b = fixture({ zhimoId: '6002' })
    const c = fixture({ zhimoId: '6003' })
    useVault.setState({ assets: [a, b, c] })
    stubMeta({
      '6001': metaOf('沙发'),
      '6002': metaOf('沙发'),
      '6003': metaOf('沙发')
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {},
      // 模拟"抓到第一条后用户点了取消"
      shouldStop: () => modvault.fetchZhimoMeta.mock.calls.length >= 1
    })

    expect(modvault.fetchZhimoMeta).toHaveBeenCalledTimes(1)
    expect(summary.scanned).toBe(1)
    expect(summary.moved).toBe(1) // 已抓到的照常搬，不丢结果
    expect(assignSpy).toHaveBeenCalledTimes(1)
    expect(zhimoBackups()).toHaveLength(1)
  })

  it('cancelZhimoCategoryReclass() 在跑动中生效：不再发新请求、已抓到的仍落库', async () => {
    const a = fixture({ zhimoId: '6101' })
    const b = fixture({ zhimoId: '6102' })
    useVault.setState({ assets: [a, b] })
    // 第一条请求进行中，用户点了取消（设置页按钮走的就是 cancelZhimoCategoryReclass）
    modvault.fetchZhimoMeta.mockImplementation(async (payload: { id: string }) => {
      order.push('meta')
      if (payload.id === '6101') useVault.getState().cancelZhimoCategoryReclass()
      return metaOf('沙发')
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(modvault.fetchZhimoMeta).toHaveBeenCalledTimes(1) // 第二发没有发
    expect(summary.scanned).toBe(1)
    expect(summary.moved).toBe(1) // 已抓到的照常搬，不丢结果
    // 收尾复位
    expect(useVault.getState().zhimoReclass.running).toBe(false)
    expect(useVault.getState().zhimoReclass.cancelRequested).toBe(false)
  })

  it('进度写进 store：total = 候选数，done 单调到 total', async () => {
    useVault.setState({
      assets: [fixture({ zhimoId: '6201' }), fixture({ zhimoId: '6202' })]
    })
    stubMeta({ '6201': metaOf('沙发'), '6202': metaOf(null) })

    const seen: Array<{ done: number; total: number }> = []
    await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {},
      onProgress: (p) => seen.push(p)
    })

    expect(seen).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 }
    ])
    expect(useVault.getState().zhimoReclass).toMatchObject({
      running: false,
      done: 2,
      total: 2
    })
  })
})

describe('runZhimoCategoryReclass — 失败不中断', () => {
  it('某组 assignCategory 抛错 → 计 failed，其余组照常搬', async () => {
    const a = fixture({ zhimoId: '7001' }) // 家具/沙发（会抛）
    const b = fixture({ zhimoId: '7002' }) // 灯具/吊灯（正常）
    useVault.setState({ assets: [a, b] })
    stubMeta({ '7001': metaOf('沙发'), '7002': metaOf('吊灯') })

    // 只让 家具/沙发 这一组抛错（模拟单组 IPC 异常）
    useVault.setState({
      assignCategory: (async (ids: string[], c1: string, c2: string) => {
        if (c1 === '家具' && c2 === '沙发') throw new Error('IPC 炸了')
        return originalAssign(ids, c1, c2)
      }) as unknown as typeof originalAssign
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary.failed).toBe(1) // 抛出那一组的 1 个 id
    expect(summary.moved).toBe(1) // 另一组照常搬
    expect(useVault.getState().assets.find((x) => x.id === b.id)!.category1).toBe('灯具')
  })

  it('移动失败（assignCategory 内部计 failed）→ 汇总 failed，不影响其它组', async () => {
    const a = fixture({ zhimoId: '7101' })
    const b = fixture({ zhimoId: '7102' })
    useVault.setState({ assets: [a, b] })
    stubMeta({ '7101': metaOf('沙发'), '7102': metaOf('吊灯') })
    // 单资产 IPC 失败（store.assignCategory 会 catch 成 failed=1）
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => {
      order.push('move')
      if (p.category1 === '家具') return null
      const name = baseName(p.folder)
      return {
        folder: `E:\\Lib\\${p.kindFolderName}\\${p.category1}\\${p.category2}\\${name}`,
        name,
        relFolder: `${p.kindFolderName}/${p.category1}/${p.category2}/${name}`,
        category1: p.category1,
        category2: p.category2,
        moved: true,
        renamed: false,
        changed: false
      }
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary.failed).toBe(1)
    expect(summary.moved).toBe(1)
    expect(summary.approx).toBe(0)
  })
})

describe('runZhimoCategoryReclass — 开关 / 静默 / 链式触发', () => {
  it('自动任务：zhimoAutoCategory=false → 零请求零日志', async () => {
    useVault.setState({
      assets: [fixture({ zhimoId: '8001' })],
      settings: settingsWithAuto(false)
    })
    stubMeta({ '8001': metaOf('沙发') })

    const summary = await useVault.getState().runZhimoCategoryReclass({ sleep: async () => {} })

    expect(summary.scanned).toBe(0)
    expect(modvault.fetchZhimoMeta).not.toHaveBeenCalled()
    expect(modvault.reportLog).not.toHaveBeenCalled()
  })

  it('自动任务：字段缺省（老 settings.json）→ 按开处理', async () => {
    useVault.setState({ assets: [fixture({ zhimoId: '8002' })], settings: settingsOf() })
    stubMeta({ '8002': metaOf('沙发') })

    const summary = await useVault.getState().runZhimoCategoryReclass({ sleep: async () => {} })

    expect(summary.moved).toBe(1)
    expect(modvault.fetchZhimoMeta).toHaveBeenCalledTimes(1)
  })

  it('自动任务不写「重排汇总」notice（静默）；手动写一条汇总', async () => {
    useVault.setState({ assets: [fixture({ zhimoId: '8101' })] })
    stubMeta({ '8101': metaOf('沙发') })
    await useVault.getState().runZhimoCategoryReclass({ sleep: async () => {} })
    // ⚠️ `assignCategory` 自己会给每条 notice（「已移动 N 个资产到…」，与 AI 补分类同一口径）；
    // 本通道的**汇总**在自动路径必须静默 —— 判据是 notice 里没有「知末分类重排」。
    expect(useVault.getState().notice ?? '').not.toContain('知末分类重排')

    useVault.setState({ assets: [fixture({ zhimoId: '8102' })], notice: null })
    stubMeta({ '8102': metaOf('茶具') })
    await useVault.getState().runZhimoCategoryReclass({ manual: true, sleep: async () => {} })
    const notice = useVault.getState().notice ?? ''
    expect(notice).toContain('知末分类重排（手动）')
    expect(notice).toContain('近似归并 1')
  })

  it('import:batchDone → **先重排（meta）后封面（cover）**，串行打同一个站', async () => {
    const a = fixture({
      name: '侘寂壁灯ID_1200166260',
      coverSource: 'embedded',
      zhimoId: '1200166260'
    })
    modvault.fetchZhimoMeta.mockImplementation(async () => {
      order.push('meta')
      return metaOf('吊灯')
    })
    modvault.fetchZhimoCover.mockImplementation(async () => {
      order.push('cover')
      return { ok: false, reason: 'not-found' }
    })

    await useVault.getState().init()
    expect(batchDoneCb).not.toBeNull()

    importEventCb!({ item: 'a.zip', itemName: 'a.zip', status: 'done', asset: a })
    batchDoneCb!()
    // scheduleZhimoPipeline 是 setTimeout(0)，再等流水线跑完两段
    await new Promise((r) => setTimeout(r, 50))

    expect(order.filter((x) => x === 'meta' || x === 'cover')).toEqual(['meta', 'cover'])
    expect(modvault.fetchZhimoMeta).toHaveBeenCalledTimes(1)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
  })
})

describe('zhimoReclassSummaryText：文案含全部桶（日志/notice 共用）', () => {
  it('近似归并单独出现，取消/手动可辨识', () => {
    const text = zhimoReclassSummaryText({
      scanned: 10,
      moved: 4,
      approx: 2,
      ambiguous: 1,
      unmapped: 2,
      noStation: 2,
      failed: 1,
      cancelled: true,
      manual: true
    })
    expect(text).toContain('抓取 10')
    expect(text).toContain('移动 4')
    expect(text).toContain('近似归并 2')
    expect(text).toContain('已取消')
    expect(text).toContain('手动')
  })
})
