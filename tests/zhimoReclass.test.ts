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

/**
 * `onSettingsChanged`（DEF-22-1）：`store.init()` 会订阅设置广播，缺了它会直接抛错。
 * 本文件不验这条回路（`tests/settingsBroadcast.test.ts` 专门验），只补个空实现。
 * **必须挂在 `modvault` 对象本身上**，不能用 `{...modvault}` 展开：
 * 下面几条用例会替换 `modvault.reportLog` 之类的属性，浅拷贝不会跟随。
 */
;(modvault as unknown as { onSettingsChanged: () => () => void }).onSettingsChanged = () =>
  () => undefined
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

/**
 * 带**面包屑**的 meta（`docs/35` T-10 之后的搬目录前提）。
 *
 * 为什么要单独一个 helper：T1 改成三源交叉验证后，「搬目录」的门槛是
 * `confidence === 'high'`，而 `high` 必须 S1（标题语义）与 S2（面包屑）**两边都有值且一致**。
 * 只有 `classifyBaseName` 的 meta（`metaOf('沙发')`）在新通道里是 `none`/`medium-s2`，
 * **一个字节都不会搬** —— 那些用例本来验的是"搬目录的机械流程"（分组/备份/取消），
 * 用这个 helper 把前置条件补足即可，断言本身不用改。
 */
function metaWithCrumb(level1: string, level2: string, classifyBaseName: string | null = null): FetchZhimoMetaResult {
  return {
    ok: true,
    classifyBaseName,
    style: null,
    version: null,
    title: null,
    breadcrumb: [
      { termId: 1, name: level1, href: 'f1', level: 1 },
      { termId: 2, name: level2, href: 'f1s2', level: 2 }
    ]
  }
}

/** `家具/沙发` 的 meta（S1 对「北欧布艺三人沙发」判的正是这一对） */
const metaSofa = (): FetchZhimoMetaResult => metaWithCrumb('家具', '沙发', '沙发')
/** `灯具/吊灯` 的 meta（S1 对「现代简约吊灯」判的正是这一对） */
const metaLamp = (): FetchZhimoMetaResult => metaWithCrumb('灯具', '吊灯', '吊灯')

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
      stopped: true,
      // T-10（docs/35）新增的三个桶：老通道恒 0，但形状必须补齐
      conflicts: 0,
      unverified: 0,
      marked: 0,
      reviews: []
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
    const a = fixture({ name: '北欧布艺三人沙发-1', zhimoId: '1001' })
    const b = fixture({ name: '北欧布艺三人沙发-2', zhimoId: '1002' })
    const c = fixture({ name: '现代简约吊灯', zhimoId: '1003' })
    useVault.setState({ assets: [a, b, c] })
    stubMeta({ '1001': metaSofa(), '1002': metaSofa(), '1003': metaLamp() })

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
    // 落库条数与命中数一致（去重：T1 会先写回 classifyReview、再由 assignCategory 写一次，
    // 同一条资产因此可能出现在两次 bulkPut 里 —— 断言"哪些 id 被写过"而不是"写了几次"）
    expect([...new Set(bulkPutCalls.flat().map((x) => x.id))].sort()).toEqual(
      [a.id, b.id, c.id].sort()
    )
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
      failed: 0,
      conflicts: 0,
      unverified: 0
    })
    expect(modvault.fetchZhimoMeta).not.toHaveBeenCalled()
    expect(fakeBackups.put).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBe('没有需要按知末分类整理的资产')
  })

  it('计数分桶：两源命中 / 单源搬 / 站方未给 / 抓取失败 各归各的桶', async () => {
    const hit = fixture({ name: '北欧布艺三人沙发', zhimoId: '3001' })
    // S1 双未分类 + 面包屑也没有、末级名也没有 → none（既不搬也不标记）
    const noStation = fixture({ name: '一个语义判不出来的名字', zhimoId: '3002' })
    // 站方给了面包屑、S1 双未分类 → medium-s2（**也搬**，2026-10-29 裁定）
    const single = fixture({ name: '另一个语义判不出来的名字', zhimoId: '3003' })
    // 站方给了末级名、但面包屑缺失 → unmapped（站方说了话，我们还原不出路径）
    const unmapped = fixture({ name: '第三个语义判不出来的名字', zhimoId: '3005' })
    const broken = fixture({ zhimoId: '3004' })
    useVault.setState({ assets: [hit, noStation, single, unmapped, broken] })
    stubMeta({
      '3001': metaSofa(),
      '3002': metaOf(null),
      // 名字判不出（S1 空）+ 面包屑能映射出 家具/沙发 → 站方单方结论
      '3003': metaWithCrumb('家具', '沙发'),
      // 站方有末级名，但这一页没有面包屑 → 还原不出路径
      '3005': metaOf('沙发'),
      '3004': { ok: false, reason: 'timeout' }
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    expect(summary).toEqual({
      scanned: 5,
      // high 一条 + medium-s2 一条（裁定：单源也搬）
      moved: 2,
      approx: 0,
      // ⚠️ **唯一允许恒 0 的桶**：`s2FromBreadcrumbGeneric` 遇到 ARR(n>1) 整条放弃（返回 null），
      // 此时若 classifyBaseName 有值就落进 unmapped —— 交叉验证通道不产生 ambiguous
      ambiguous: 0,
      // 站方给了末级名但面包屑缺失 → 真实存在的一类，必须计数
      unmapped: 1,
      // 站方两个源都空（`ok:true` 但无面包屑无末级名）→ 也是真实的一类，必须计数
      noStation: 1,
      failed: 1,
      conflicts: 0,
      unverified: 1
    })
  })

  it('approx 有真实来源（S2 解析透传映射表的近似归并），且恒 ≤ moved', async () => {
    // `茶具` 在映射表里是 `approx: true` 的归并条目（站方父链 厨卫五金>厨房用品>茶具，
    // 本地无对应二级 → 归 软装陈设/摆件）。**必须用三级面包屑**，两级的话最深那条
    // `摆件` 会先精确命中，走不到 `茶具` 这条近似条目。
    const tea = fixture({ name: '茶具', zhimoId: '4001' })
    const exact = fixture({ name: '北欧布艺三人沙发', zhimoId: '4002' })
    useVault.setState({ assets: [tea, exact] })
    stubMeta({
      '4001': {
        ok: true,
        classifyBaseName: '茶具',
        style: null,
        version: null,
        title: null,
        breadcrumb: [
          { termId: 1, name: '厨卫五金', href: 'f1', level: 1 },
          { termId: 2, name: '厨房用品', href: 'f1s2', level: 2 },
          { termId: 3, name: '茶具', href: 'f1s2s3', level: 3 }
        ]
      },
      '4002': metaSofa()
    })

    const summary = await useVault.getState().runZhimoCategoryReclass({
      manual: true,
      sleep: async () => {}
    })

    // 两条都搬了：沙发是 high 两源互证、茶具是 medium-s2 单源
    expect(summary.moved).toBe(2)
    expect(summary.unverified).toBe(1)
    // 不变式（不写死数值）：两者都必须是 moved 的子集
    expect(summary.approx).toBeLessThanOrEqual(summary.moved)
    expect(summary.unverified).toBeLessThanOrEqual(summary.moved)
    // 茶具那条命中近似归并 → approx ≥ 1
    expect(summary.approx).toBeGreaterThanOrEqual(1)
    // 日志里三个数字都必须出现（唯一锚点）
    const log = modvault.reportLog.mock.calls.at(-1)?.[0] as {
      message: string
      context: Record<string, unknown>
    }
    expect(log.message).toBe('zhimo:reclass')
    expect(log.context.approx).toBe(summary.approx)
    expect(log.context.unverified).toBe(summary.unverified)
    expect(String(log.context.text)).toContain('近似归并')
    expect(String(log.context.text)).toContain('单源 1')
  })
})

describe('runZhimoCategoryReclass — 备份（前缀隔离）', () => {
  it('写 `zhimo-reclass-` 前缀，且**不动**老通道那批 `reclass-`', async () => {
    // 老通道的一条备份（模拟「上次重跑自动分类」的凭证）
    backupStore.set('reclass-1', { id: 'reclass-1', at: 1, json: '[]' })
    const a = fixture({ name: '北欧布艺三人沙发', zhimoId: '5001' })
    useVault.setState({ assets: [a] })
    stubMeta({ '5001': metaSofa() })

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
    const a = fixture({ name: '北欧布艺三人沙发', zhimoId: '5002' })
    useVault.setState({ assets: [a] })
    stubMeta({ '5002': metaSofa() })

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
    const a = fixture({ name: '北欧布艺三人沙发-1', zhimoId: '6001' })
    const b = fixture({ name: '北欧布艺三人沙发-2', zhimoId: '6002' })
    const c = fixture({ name: '北欧布艺三人沙发-3', zhimoId: '6003' })
    useVault.setState({ assets: [a, b, c] })
    stubMeta({ '6001': metaSofa(), '6002': metaSofa(), '6003': metaSofa() })

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
    const a = fixture({ name: '北欧布艺三人沙发-1', zhimoId: '6101' })
    const b = fixture({ name: '北欧布艺三人沙发-2', zhimoId: '6102' })
    useVault.setState({ assets: [a, b] })
    // 第一条请求进行中，用户点了取消（设置页按钮走的就是 cancelZhimoCategoryReclass）
    modvault.fetchZhimoMeta.mockImplementation(async (payload: { id: string }) => {
      order.push('meta')
      if (payload.id === '6101') useVault.getState().cancelZhimoCategoryReclass()
      return metaSofa()
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
    const a = fixture({ name: '北欧布艺三人沙发', zhimoId: '7001' }) // 家具/沙发（会抛）
    const b = fixture({ name: '现代简约吊灯', zhimoId: '7002' }) // 灯具/吊灯（正常）
    useVault.setState({ assets: [a, b] })
    stubMeta({ '7001': metaSofa(), '7002': metaLamp() })

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
    const a = fixture({ name: '北欧布艺三人沙发', zhimoId: '7101' })
    const b = fixture({ name: '现代简约吊灯', zhimoId: '7102' })
    useVault.setState({ assets: [a, b] })
    stubMeta({ '7101': metaSofa(), '7102': metaLamp() })
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
    useVault.setState({
      assets: [fixture({ name: '北欧布艺三人沙发', zhimoId: '8002' })],
      settings: settingsOf()
    })
    stubMeta({ '8002': metaSofa() })

    const summary = await useVault.getState().runZhimoCategoryReclass({ sleep: async () => {} })

    expect(summary.moved).toBe(1)
    expect(modvault.fetchZhimoMeta).toHaveBeenCalledTimes(1)
  })

  it('自动任务不写「重排汇总」notice（静默）；手动写一条汇总', async () => {
    useVault.setState({ assets: [fixture({ name: '北欧布艺三人沙发-1', zhimoId: '8101' })] })
    stubMeta({ '8101': metaSofa() })
    await useVault.getState().runZhimoCategoryReclass({ sleep: async () => {} })
    // ⚠️ `assignCategory` 自己会给每条 notice（「已移动 N 个资产到…」，与 AI 补分类同一口径）；
    // 本通道的**汇总**在自动路径必须静默 —— 判据是 notice 里没有「知末分类重排」。
    expect(useVault.getState().notice ?? '').not.toContain('知末分类重排')

    useVault.setState({ assets: [fixture({ name: '现代简约吊灯', zhimoId: '8102' })], notice: null })
    stubMeta({ '8102': metaLamp() })
    await useVault.getState().runZhimoCategoryReclass({ manual: true, sleep: async () => {} })
    const notice = useVault.getState().notice ?? ''
    expect(notice).toContain('知末分类重排（手动）')
    expect(notice).toContain('移动 1')
    // 存疑 / 单源两个新桶必须出现在汇总文案里（哪怕为 0）
    expect(notice).toContain('存疑 0')
    expect(notice).toContain('单源 0')
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
      conflicts: 3,
      unverified: 5,
      cancelled: true,
      manual: true
    })
    expect(text).toContain('抓取 10')
    expect(text).toContain('移动 4')
    expect(text).toContain('近似归并 2')
    // T-10 新增两个桶：存疑（conflict）/ 单源（medium-s2 搬的条数，是 moved 的子集）
    expect(text).toContain('存疑 3')
    expect(text).toContain('单源 5')
    expect(text).toContain('已取消')
    expect(text).toContain('手动')
  })

  it('两个新桶为 0 时也必须出现（同一句话的形态不随批次变化）', () => {
    const text = zhimoReclassSummaryText({
      scanned: 1,
      moved: 1,
      approx: 0,
      ambiguous: 0,
      unmapped: 0,
      noStation: 0,
      failed: 0,
      conflicts: 0,
      unverified: 0,
      cancelled: false,
      manual: false
    })
    expect(text).toContain('存疑 0')
    expect(text).toContain('单源 0')
  })
})
