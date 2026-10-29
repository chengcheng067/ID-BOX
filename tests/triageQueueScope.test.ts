/**
 * 整理队列「按当前大类收窄」的守卫（2026-10-30 用户实测 bug）。
 *
 * ## 被修的 bug（原话）
 *
 * > 「HDR 的这个"未分类"，点了整理以后，弹出来的是材质的整理，不是 HDR 的整理」
 *
 * 侧栏 `HDRI → 未分类 33` 旁边的「整理」按钮进去，浮层里全是材质资产。根因是三套
 * 「未分类」口径错配（`docs/25-待办-用户反馈.md`「待统一 · 「未分类」有三种口径」）：
 * 侧栏数字按 `openScope`（当前大类）算，而整理队列当时是**全库**口径。
 *
 * 修法（用户拍板）：**整理只处理当前大类**。在哪一类里点整理，就只整理那一类。
 *
 * ## 为什么这个文件是纯逻辑 + 源码守卫
 *
 * `vitest.config.ts` 是 `environment: 'node'`，没有 jsdom / react-test-renderer，而
 * zustand v4 在 SSR 下走 `getServerSnapshot` → 读不到 `setState` 之后的值（详见
 * `tests/storeTriageMode.test.ts` 文件头）。所以 hook 本体跑不了，改成打内核
 * `triageQueueOf`（`openTriage` 与三个 hook 同源的那一份），外加源码守卫钉住
 * "入口真的把 `filters.kind` 传下去了"——真正的回归形态是**有人把第 4 个参数删掉**，
 * 那种改动类型上合法（参数变可选就会静默走全库），只有守卫能抓住。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset, AssetKind } from '../src/shared/types'

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

const modvault = {
  getSettings: vi.fn(async () => null),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async () => 0),
  saveBallThumb: vi.fn(async () => null),
  assignCategory: vi.fn(),
  onSettingsChanged: vi.fn(() => () => undefined)
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const fakeTable = {
  toArray: vi.fn(async (): Promise<Asset[]> => []),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  where: vi.fn(() => fakeTable),
  equals: vi.fn(() => fakeTable),
  modify: vi.fn(async () => 0),
  update: vi.fn(async () => 0),
  get: vi.fn(async () => undefined),
  count: vi.fn(async () => 0),
  delete: vi.fn(async () => undefined)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { triageQueueOf, useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

/**
 * 一条**双未分类**的资产（`buildTriageQueue` 唯一认的形态：两级都恰好是「未分类」）。
 *
 * `kind` 是刻意提成参数的：本文件所有的断言都在问"某大类下有多少条"，夹具若与断言
 * 共用同一个推导就是自证。所以这里只按调用方给的字面值写进去。
 */
function uc(id: string, kind: AssetKind, extra: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id,
    name: id,
    kind,
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    folder: `E:/lib/${kind}/未分类/${id}`,
    relFolder: `${kind}/未分类/${id}`,
    files: [],
    size: 100 + seq,
    tags: [],
    colorTags: [],
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    importedAt: 1_700_000_000_000 + seq,
    ...extra
  } as Asset
}

/** 一条**已分类**的资产（对照组：任何大类的队列里都不该出现） */
function done(id: string, kind: AssetKind, extra: Partial<Asset> = {}): Asset {
  return uc(id, kind, { category1: '椅子', category2: '餐椅', ...extra })
}

/**
 * 一条 `conflict` 资产（`reviewReasonOf` 判 conflict 的最小形态）。
 *
 * 分类**必须填上非「未分类」的值**：`buildTriageQueue` 只认 `isUnclassified`（双未分类），
 * 若 conflict 夹具也写成双未分类，它会同时落进 unclassified 队列 —— 那是既有语义
 * （两个 build 函数靠 `reviewReasonOf` 的判定顺序互斥，而不是靠 `buildTriageQueue` 自己排他），
 * 与本文件要钉的 kind 收窄无关，写错会污染断言。
 */
function conflict(id: string, kind: AssetKind, extra: Partial<Asset> = {}): Asset {
  return uc(id, kind, {
    category1: '工装空间',
    category2: '办公空间',
    classifyReview: { confidence: 'conflict', reason: 'conflict' },
    ...extra
  })
}

/**
 * 混合库：**每个大类都有未分类资产**，另加已分类对照组。
 *
 * 关键点是「每个大类都有」——只放一个未分类的 hdri 就断言 `kind='hdri'` 只剩它，
 * 那条测试即使 `kind` 完全没生效也可能意外通过（若其余大类恰好没未分类）。
 */
function mixedLibrary(): Asset[] {
  return [
    uc('hdr-1', 'hdri'),
    uc('hdr-2', 'hdri'),
    uc('mdl-1', 'model'),
    uc('mdl-2', 'model'),
    uc('cad-1', 'cad'),
    uc('cad-2', 'cad'),
    uc('tex-1', 'texture'),
    uc('tex-2', 'texture'),
    uc('mat-1', 'material'),
    uc('mat-2', 'material'),
    uc('oth-1', 'other'),
    uc('oth-2', 'other'),
    // 对照组：已分类，任何队列都不该出现
    done('hdr-done', 'hdri'),
    done('mdl-done', 'model'),
    done('tex-done', 'texture')
  ]
}

const ids = (list: readonly Asset[]): string[] => list.map((a) => a.id)

beforeEach(() => {
  seq = 0
  useVault.setState({
    assets: [],
    filters: { ...useVault.getState().filters, sort: 'recent', kind: 'all' },
    triageMode: null,
    triageActive: false,
    notice: null
  })
})

// ── A · 按大类收窄 ─────────────────────────────────────────────────

describe('A · `triageQueueOf` 的 `kind` 收窄（unclassified 模式）', () => {
  const lib = mixedLibrary()

  it('★hdri → 只含 hdri 的未分类（用户报的那个入口）', () => {
    const q = triageQueueOf(lib, 'recent', 'unclassified', 'hdri')
    // 'recent' = importedAt 倒序，夹具里 importedAt 随序号递增 → 后建的在前
    expect(ids(q)).toEqual(['hdr-2', 'hdr-1'])
    expect(q.every((a) => a.kind === 'hdri')).toBe(true)
  })

  it.each([
    ['model', ['mdl-2', 'mdl-1']],
    ['cad', ['cad-2', 'cad-1']],
    ['texture', ['tex-2', 'tex-1']],
    ['material', ['mat-2', 'mat-1']],
    ['other', ['oth-2', 'oth-1']]
  ] as const)('★单个大类 %s → 只含该类', (kind, expected) => {
    expect(ids(triageQueueOf(lib, 'recent', 'unclassified', kind))).toEqual(expected)
  })

  it('★materialGroup → 含 texture 与 material **两类**（kindsOfFilter 复用的关键验证）', () => {
    const q = triageQueueOf(lib, 'recent', 'unclassified', 'materialGroup')
    // 手写 `a.kind === kind` 会一条都拿不到（'materialGroup' 不是 AssetKind）；
    // 只看 `material` 会漏掉 texture。两个错误在这条断言下都会红。
    expect(ids(q)).toEqual(['mat-2', 'mat-1', 'tex-2', 'tex-1'])
    expect(q.filter((a) => a.kind === 'texture')).toHaveLength(2)
    expect(q.filter((a) => a.kind === 'material')).toHaveLength(2)
  })

  it("★'all' → 全部大类的未分类都进来（不收窄，等价于修复前的全库口径）", () => {
    const q = triageQueueOf(lib, 'recent', 'unclassified', 'all')
    expect(q).toHaveLength(12)
    expect(new Set(q.map((a) => a.kind))).toEqual(
      new Set(['hdri', 'model', 'cad', 'texture', 'material', 'other'])
    )
    // 对照组一条都不能混进来
    expect(ids(q)).not.toContain('hdr-done')
    expect(ids(q)).not.toContain('mdl-done')
    expect(ids(q)).not.toContain('tex-done')
  })

  it('★每个大类的条数之和 = 全库未分类条数（收窄只是切分，不丢不重）', () => {
    const kinds: AssetKind[] = ['hdri', 'model', 'cad', 'texture', 'material', 'other']
    const sum = kinds.reduce(
      (n, k) => n + triageQueueOf(lib, 'recent', 'unclassified', k).length,
      0
    )
    expect(sum).toBe(triageQueueOf(lib, 'recent', 'unclassified', 'all').length)
  })
})

// ── B · 收窄不影响其他判据 ─────────────────────────────────────────

describe('B · 收窄不影响其他判据（软删 / 排序 / conflict 保持全库）', () => {
  it('★软删仍被滤掉（即使 kind 命中）', () => {
    const lib = [
      uc('hdr-live', 'hdri'),
      uc('hdr-deleted', 'hdri', { deletedAt: 1_700_000_000_000 }),
      uc('tex-live', 'texture')
    ]
    expect(ids(triageQueueOf(lib, 'recent', 'unclassified', 'hdri'))).toEqual(['hdr-live'])
    // 软删判据与 kind 无关：'all' 下同样被滤掉（收窄不是唯一过滤点）
    expect(ids(triageQueueOf(lib, 'recent', 'unclassified', 'all'))).toEqual([
      'tex-live',
      'hdr-live'
    ])
  })

  it('★排序仍生效（kind 收窄后仍按传入的 sort 排，不是按原库序）', () => {
    // 名称序与时间序刻意**相反**，否则两种排序给出同一结果，这条测试就证不了什么
    const lib = [
      uc('hdr-z', 'hdri', { name: 'zzz-hdr', importedAt: 3 }),
      uc('hdr-a', 'hdri', { name: 'aaa-hdr', importedAt: 1 }),
      uc('hdr-m', 'hdri', { name: 'mmm-hdr', importedAt: 2 }),
      uc('tex-a', 'texture', { name: 'aaa-tex' })
    ]
    // 'name' → 名称升序
    expect(ids(triageQueueOf(lib, 'name', 'unclassified', 'hdri'))).toEqual([
      'hdr-a',
      'hdr-m',
      'hdr-z'
    ])
    // 'recent' → importedAt 倒序（与名称序相反，证明真的是按 sort 排的）
    expect(ids(triageQueueOf(lib, 'recent', 'unclassified', 'hdri'))).toEqual([
      'hdr-z',
      'hdr-m',
      'hdr-a'
    ])
  })

  it('★conflict 模式**忽略** kind（侧栏「待确认 N」是全库口径，见下方注释）', () => {
    // 侧栏那个数字走 `countPendingReview(Sidebar 的 activeAssets).conflict`，
    // `activeAssets` 只滤软删、不套大类 → 全库。浮层若收窄，数字与条数就会对不上，
    // 等于把 bug 从「未分类」搬到「待确认」。所以 conflict 模式必须保持全库。
    const lib = [
      conflict('c-hdr', 'hdri'),
      conflict('c-tex', 'texture'),
      conflict('c-mdl', 'model'),
      uc('u-hdr', 'hdri'),
      uc('u-tex', 'texture')
    ]
    const expected = ['c-mdl', 'c-tex', 'c-hdr']
    for (const kind of ['hdri', 'texture', 'materialGroup', 'all'] as const) {
      expect(ids(triageQueueOf(lib, 'recent', 'conflict', kind))).toEqual(expected)
    }
    // 反过来：同一份数据下 unclassified 模式确实是收窄的（证明上面不是"什么都没做"）
    expect(ids(triageQueueOf(lib, 'recent', 'unclassified', 'hdri'))).toEqual(['u-hdr'])
  })
})

// ── C · 源码守卫 ───────────────────────────────────────────────────

describe('C · 源码守卫', () => {
  const SRC = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf-8')

  it('★openTriage 调用 triageQueueOf 时**确实传了**第 4 个参数 `st.filters.kind`', () => {
    // 只在 openTriage 里这一种写法：assets/sort/mode/kind 四个实参都在。
    // 少传第 4 个（或改成字面量 'all'）会让 HDR 视图重新串类。
    expect(SRC).toMatch(
      /triageQueueOf\(\s*st\.assets,\s*st\.filters\.sort,\s*mode,\s*st\.filters\.kind\s*\)/
    )
  })

  it('★收窄复用 `kindsOfFilter`，不是手写 kind 比较', () => {
    const at = SRC.indexOf('export function triageQueueOf(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('\n}', at))
    expect(body).toContain('kindsOfFilter')
    // 手写比较会漏掉分组哨兵（'materialGroup' 不是 AssetKind）—— 直接禁止这种写法
    expect(body).not.toMatch(/\.kind\s*===\s*kind\b/)
    expect(body).not.toMatch(/\bkind\s*===\s*'/)
  })

  it('★反向守卫：旧的「两种队列都是全库口径」表述已被推翻，不许再出现', () => {
    // 这句是本次 bug 的病根注释。留着它，后人照着改回去就是同一个 bug 二次发生。
    expect(SRC).not.toContain('两种队列都是全库口径')
  })

  it('★hook 侧也把 `filters.kind` 透传下去（useTriageQueueOf 里能读到 s.filters.kind）', () => {
    const at = SRC.indexOf('function useTriageQueueOf(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('\n}', at))
    expect(body).toContain('s.filters.kind')
    expect(body).toContain('activeTriageQueueOf(assets, sort, mode, kind)')
    // 依赖数组里必须带上 kind，否则静默用旧 kind 渲（改大类不刷新队列）
    expect(body).toMatch(/\[\s*assets,\s*sort,\s*mode,\s*kind\s*\]/)
  })
})

// ── D · 端到端语义（用户截图那个场景） ─────────────────────────────

describe('D · 用户截图场景：HDR 视图点「整理」', () => {
  it('★33 个未分类 HDR + 材质 + 模型 → kind=hdri 时队列恰好 33 条，且全是 hdri', () => {
    const hdrs = Array.from({ length: 33 }, (_, i) => uc(`h${i}`, 'hdri'))
    const mats = Array.from({ length: 7 }, (_, i) => uc(`m${i}`, 'material'))
    const texs = Array.from({ length: 5 }, (_, i) => uc(`t${i}`, 'texture'))
    const models = Array.from({ length: 9 }, (_, i) => uc(`d${i}`, 'model'))
    const lib = [...hdrs, ...mats, ...texs, ...models]

    // 用户在 HDR 层级点「整理」：store 里 filters.kind = 'hdri'（点大类时 setFilter 写入）
    useVault.setState({ assets: lib, filters: { ...useVault.getState().filters, kind: 'hdri' } })
    const kind = useVault.getState().filters.kind
    expect(kind).toBe('hdri')

    // 走 openTriage 的同一个内核（`openTriage` 就是拿 st.assets / st.filters.sort / mode /
    // st.filters.kind 调它，源码守卫 C 已钉住），所以这里等于"入口会给出什么"。
    const queue = triageQueueOf(lib, useVault.getState().filters.sort, 'unclassified', kind)

    expect(queue).toHaveLength(33)
    expect(queue.every((a) => a.kind === 'hdri')).toBe(true)
    // 「有没有混进非 hdri」正面断言：一条都不能有
    expect(queue.filter((a) => a.kind !== 'hdri')).toEqual([])
    // 侧栏那个数字（countLevel1 按 openScope='hdri' 算）与队列条数现在同口径 → 对齐
    expect(queue).toHaveLength(hdrs.length)
  })

  it('★材质视图点整理：只出材质（texture + material 都算「材质」这个节点）', () => {
    const hdrs = Array.from({ length: 33 }, (_, i) => uc(`h${i}`, 'hdri'))
    const mats = Array.from({ length: 7 }, (_, i) => uc(`m${i}`, 'material'))
    const texs = Array.from({ length: 5 }, (_, i) => uc(`t${i}`, 'texture'))
    const lib = [...hdrs, ...mats, ...texs]

    const queue = triageQueueOf(lib, 'recent', 'unclassified', 'materialGroup')
    expect(queue).toHaveLength(12)
    expect(queue.some((a) => a.kind === 'hdri')).toBe(false)
  })

  it('★该大类下没有未分类时队列为空（openTriage 会走"不开浮层 + notice"那条路）', () => {
    const lib = [uc('h0', 'hdri'), uc('m0', 'material')]
    expect(triageQueueOf(lib, 'recent', 'unclassified', 'model')).toEqual([])
  })
})
