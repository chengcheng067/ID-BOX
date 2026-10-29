/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，renderer 源码依赖 DOM 全局（window）。
// 真实声明在 src/renderer/env.d.ts（只对 tsconfig.web 生效），这里补一份供测试用。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

/**
 * 「分类三源交叉验证 T1 编排」的验收（`docs/35` T-10 / §5）。
 *
 * 只测**编排层**（`store.runZhimoCategoryReclass` + `logic/zhimoReclass.planZhimoVerify`）：
 * 判定本身（`decideClassify`）与 S2 解析（`s2FromBreadcrumb*`）在上游卡里已有独立用例，
 * 这里不重复，只验「判完之后该不该搬、写什么、什么顺序」。
 *
 * 八条（卡片原文的顺序）：
 * 1. `high` 且落点不同 → 搬；
 * 2. `high` 且落点相同 → 不搬、不报错、仍写回；
 * 3. `conflict` → 不搬 + 进队列（写回必须带 `sources.s2`）；
 * 4. `medium-s2` → 不搬 + 只标记；
 * 5. 已定案 → 门槛③ 生效，零搬且**不改 `classifyReview`**；
 * 6. 备份早于移动（fake `db.backups.put` 与第一次 `assignCategory` 的调用序）；
 * 7. 取消后已抓到的仍落库；
 * 8. `hdri` / `other` 没有站方源 → `s2` 恒 null、不崩。
 *
 * 全部**零网络 / 零真实磁盘**：`window.modvault` 是桩，Dexie 用内存版假表，
 * 做法照抄 `tests/zhimoReclass.test.ts`。
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
  isZhimoReclassCandidate,
  isZhimoVerifyCandidate,
  planZhimoVerify,
  s2OfMeta
} from '../src/renderer/logic/zhimoReclass'

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/** 调用顺序记录：'backup'（写还原凭证）/ 'move'（搬目录） */
const order: string[] = []

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
  onImportEvent: vi.fn(() => () => {}),
  onImportBatchDone: vi.fn(() => () => {}),
  onSettingsChanged: vi.fn(() => () => {})
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
import type { IndexBackup } from '../src/renderer/db'

/** 资产表：只关心 `assignCategory` / 写回用到的 `bulkPut` */
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

/** 备份表：**记录调用序**，用来断言"备份早于移动" */
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
    id: `11111111-0000-4000-8000-${n.padStart(12, '0')}`,
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

/** 一条面包屑（`termId` 与 `href` 与主进程解析结果同形：`f{一级}s{二级}`） */
const crumb = (name: string, level: number, href: string) => ({
  termId: Number(href.replace(/[^0-9s]/g, '').split('s').pop()),
  name,
  href,
  level
})

/** 一次 `fetchZhimoMeta` 的成功返回（`breadcrumb` 可缺省 = 站方这一页没给） */
function metaOf(
  classifyBaseName: string | null,
  breadcrumb?: FetchZhimoMetaResult['breadcrumb']
): FetchZhimoMetaResult {
  return {
    ok: true,
    classifyBaseName,
    style: null,
    version: null,
    title: null,
    ...(breadcrumb ? { breadcrumb } : {})
  }
}

/** 工装空间/办公空间 的面包屑（CAD 恒等命中） */
const CRUMB_OFFICE = [crumb('工装空间', 1, 'f100'), crumb('办公空间', 2, 'f100s200')]
/** 家具/沙发 的面包屑（model 走映射表） */
const CRUMB_SOFA = [crumb('家具', 1, 'f10'), crumb('沙发', 2, 'f10s20')]
/** 灯具/吊灯 的面包屑 */
const CRUMB_LAMP = [crumb('灯具', 1, 'f20'), crumb('吊灯', 2, 'f20s30')]
/** 工装空间 > 居住区规划（二级不在 CAD 词表 → S2 只到一级） */
const CRUMB_GUIHUA = [crumb('工装空间', 1, 'f100'), crumb('居住区规划', 2, 'f100s999')]
/** 园林景观/办公工业景观 */
const CRUMB_GARDEN = [crumb('园林景观', 1, 'f30'), crumb('办公工业景观', 2, 'f30s40')]

function settingsWithAuto(auto: boolean): Settings {
  return { ...DEFAULT_SETTINGS, zhimoAutoCategory: auto } as unknown as Settings
}

const zhimoBackups = (): IndexBackup[] =>
  [...backupStore.values()].filter((b) => b.id.startsWith('zhimo-reclass-'))

beforeEach(() => {
  order.length = 0
  backupStore.clear()
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  modvault.fetchZhimoMeta.mockReset()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.detectMaterialMerge.mockResolvedValue({ needMerge: false, count: 0, sources: [] })
  modvault.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS })
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
  useVault.setState({
    assets: [],
    settings: settingsWithAuto(true),
    notice: null,
    zhimoReclass: { running: false, done: 0, total: 0, cancelRequested: false }
  })
})

/** 跑一轮（每次注入即时 sleep，不等真实节流） */
const runOnce = (over: { shouldStop?: () => boolean } = {}) =>
  useVault.getState().runZhimoCategoryReclass({
    manual: true,
    sleep: async () => {},
    ...over
  })

const assetById = (id: string): Asset =>
  useVault.getState().assets.find((a) => a.id === id)!

// ══════════════════════════════════════════════════════════════════
// ① high 且落点不同 → 搬
// ══════════════════════════════════════════════════════════════════

describe('① high + 落点 ≠ 当前分类 → 搬目录 + 写回 high', () => {
  it('CAD：S1 = 工装空间/办公空间，面包屑也是 → moved +1、写回 confidence:high 且带 decidedAt', async () => {
    const a = fixture({
      name: '工装办公室 施工图',
      kind: 'cad',
      zhimoId: '9001',
      files: [{ rel: 'a.dwg', name: 'a.dwg', ext: 'dwg', size: 1, kind: 'model' }],
      classifyReview: { confidence: 'none' }
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('办公室', CRUMB_OFFICE))

    const summary = await runOnce()

    expect(summary.moved).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.conflicts).toBe(0)
    expect(summary.unverified).toBe(0)
    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)

    const after = assetById(a.id)
    expect(after.category1).toBe('工装空间')
    expect(after.category2).toBe('办公空间')
    expect(after.classifyReview?.confidence).toBe('high')
    expect(typeof after.classifyReview?.decidedAt).toBe('number')
    // high 不写 reason → reviewReasonOf 返回 null → 不进待确认队列
    expect(after.classifyReview?.reason).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// ② high 且落点相同 → 不搬但不报错
// ══════════════════════════════════════════════════════════════════

describe('② high + 落点 = 当前分类 → 零搬、零失败，但仍写回 high', () => {
  it('纯函数层：落点与当前分类相同 → kind = mark（不搬），review 仍是 high + decidedAt', () => {
    const out = planZhimoVerify({
      asset: {
        name: '工装办公室 施工图',
        files: [],
        kind: 'cad',
        // 已经在这个分类里（门槛②）
        category1: '工装空间',
        category2: '办公空间',
        classifyReview: { confidence: 'medium-s1' }
      },
      meta: metaOf('办公室', CRUMB_OFFICE),
      now: 999
    })
    expect(out.kind).toBe('mark')
    if (out.kind !== 'mark') return
    expect(out.review.confidence).toBe('high')
    expect(out.review.decidedAt).toBe(999)
    // 不搬 → 不产生 plan（store 侧因此不会进备份 / 不会调 assignCategory）
  })

  it('store 层：候选恒为双未分类，所以这类资产压根不在候选里（零请求、零搬）', async () => {
    const a = fixture({
      name: '工装办公室 施工图',
      kind: 'cad',
      zhimoId: '9002',
      category1: '工装空间',
      category2: '办公空间',
      classifyReview: { confidence: 'medium-s1' }
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('办公室', CRUMB_OFFICE))

    const summary = await runOnce()

    // ⚠️ 这条断言是**数据安全底线**，不是性能优化：
    // 用户手工拖拽归类不清 `classifyReview`，所以"已分类 + medium-s1"里混着用户的手工结论。
    // 收进候选 = 可能把用户刚分的类自动搬回去。判据见 isZhimoVerifyCandidate 的注释。
    expect(modvault.fetchZhimoMeta).not.toHaveBeenCalled()
    expect(modvault.assignCategory).not.toHaveBeenCalled()
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
    expect(assetById(a.id).classifyReview?.confidence).toBe('medium-s1')
  })
})

// ══════════════════════════════════════════════════════════════════
// ③ conflict → 不搬 + 进队列
// ══════════════════════════════════════════════════════════════════

describe('③ conflict → 零搬 + conflicts +1 + 写回带 sources.s2', () => {
  it('S1 = 建筑设计/规划设计，面包屑 = 工装空间>居住区规划 → 一级不同 → conflict', async () => {
    const a = fixture({
      name: '规划设计 施工图',
      kind: 'cad',
      zhimoId: '9003',
      classifyReview: { confidence: 'medium-s1' }
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf(null, CRUMB_GUIHUA))

    const summary = await runOnce()

    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(summary.moved).toBe(0)
    expect(summary.conflicts).toBe(1)
    expect(summary.unverified).toBe(0)

    const review = assetById(a.id).classifyReview
    expect(review?.confidence).toBe('conflict')
    expect(review?.reason).toBe('conflict')
    // **必须持久化 sources.s2** —— 否则下次启动浮层里"为什么存疑"就没了（§5.3）
    expect(review?.sources?.s2).toEqual({
      level1: '工装空间',
      level2: '未分类',
      raw: ['工装空间', '居住区规划'],
      fromBaseName: false
    })
    // conflict 不是"已定案"：绝不能写 decidedAt（写了就永远退出队列了）
    expect(review?.decidedAt).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// ④ medium-s2 → **也搬**（2026-10-29 裁定：门槛改为 high 或 medium-s2）
// ══════════════════════════════════════════════════════════════════

describe('④ medium-s2（站方单方结论）→ **搬目录** + unverified 计入 moved 的子集', () => {
  it('S1 双未分类、面包屑 = 园林景观>办公工业景观 → moved+1、unverified+1、写回 medium-s2', async () => {
    const a = fixture({
      name: '一个语义判不出来的名字',
      kind: 'cad',
      zhimoId: '9004',
      classifyReview: { confidence: 'none' }
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf(null, CRUMB_GARDEN))

    const summary = await runOnce()

    // 裁定理由：导入链路现状按文件名匹配直接落盘（CAD 二级命中 42.5%），
    // 站方单源 55%+ 不比它差 —— 不搬反而比现状更保守。
    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)
    expect(summary.moved).toBe(1)
    expect(summary.unverified).toBe(1)
    expect(summary.conflicts).toBe(0)

    const after = assetById(a.id)
    expect(after.category1).toBe('园林景观')
    expect(after.category2).toBe('办公工业景观')
    const review = after.classifyReview
    expect(review?.confidence).toBe('medium-s2')
    // 只标记 → 不进 queue（reason 不写）；但搬了 → 要写 decidedAt（否则下批会再搬一次）
    expect(review?.reason).toBeUndefined()
    expect(review?.sources?.s2?.level1).toBe('园林景观')
    expect(typeof review?.decidedAt).toBe('number')
  })

  it('medium-s1 **不搬**（只有我们自己猜的，拿 S1 重写 S1 是零信息增量）', async () => {
    // S1 判得出（北欧布艺三人沙发 → 家具/沙发），但站方什么都没给（无面包屑、无末级名）
    const a = fixture({ name: '北欧布艺三人沙发', zhimoId: '9004b' })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf(null))

    const summary = await runOnce()

    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(summary.moved).toBe(0)
    expect(summary.unverified).toBe(0)
    // 与 T0 初值同形 → 不改库
    expect(assetById(a.id).classifyReview).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// ⑤ 已定案的不动（门槛③）
// ══════════════════════════════════════════════════════════════════

describe('⑤ 已定案（decidedAt 有值）→ 门槛③生效：零搬，且 classifyReview 一个字节不改', () => {
  it('旧结论 conflict+decidedAt=123，这次能判出 high 且落点不同 → 仍然零搬、零 write-back', async () => {
    const decided = { confidence: 'conflict' as const, decidedAt: 123 }
    const a = fixture({
      name: '工装办公室 施工图',
      kind: 'cad',
      zhimoId: '9005',
      classifyReview: decided
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('办公室', CRUMB_OFFICE))

    const summary = await runOnce()

    // ① 门槛③ 在**抓取之前**就把它筛掉了（省一次请求）
    expect(modvault.fetchZhimoMeta).not.toHaveBeenCalled()
    expect(summary.scanned).toBe(0)
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(summary.moved).toBe(0)
    // ② 用户定过的结论不该被自动流程覆盖
    expect(assetById(a.id).classifyReview).toEqual(decided)
  })

  it('同一判定的纯函数层：planZhimoVerify 对已定案直接返回 untouched/decided', () => {
    const out = planZhimoVerify({
      asset: {
        name: '工装办公室 施工图',
        files: [],
        kind: 'cad',
        category1: UNCLASSIFIED,
        category2: UNCLASSIFIED,
        classifyReview: { confidence: 'conflict', decidedAt: 123 }
      },
      meta: metaOf('办公室', CRUMB_OFFICE),
      now: 999
    })
    expect(out).toEqual({ kind: 'untouched', reason: 'decided' })
  })
})

// ══════════════════════════════════════════════════════════════════
// ⑥ 备份早于移动
// ══════════════════════════════════════════════════════════════════

describe('⑥c unverified / approx 都是 moved 的**真子集**（移动失败不虚报）', () => {
  it('high 那条搬成功、medium-s2 那条的整组失败 → moved 1、unverified 0', async () => {
    const hi = fixture({ name: '北欧布艺三人沙发', zhimoId: '9301' })
    const single = fixture({ name: '一个语义判不出来的名字', zhimoId: '9302' })
    useVault.setState({ assets: [hi, single] })
    modvault.fetchZhimoMeta.mockImplementation(async (p: { id: string }) =>
      // high 那条 → 家具/沙发（S1 与面包屑一致）
      p.id === '9301' ? metaOf('沙发', CRUMB_SOFA) : metaOf('吊灯', CRUMB_LAMP)
    )
    // 让 medium-s2 那条的落点（灯具/吊灯）整组抛错
    const original = useVault.getState().assignCategory
    useVault.setState({
      assignCategory: (async (ids: string[], c1: string, c2: string) => {
        if (c1 === '灯具' && c2 === '吊灯') throw new Error('IPC 炸了')
        return original(ids, c1, c2)
      }) as unknown as typeof original
    })

    const summary = await runOnce()

    expect(summary.moved).toBe(1) // 只有 high 那条搬成功
    expect(summary.failed).toBe(1) // 单源那条整组失败
    // ⚠️ 不变式：**没搬成功的既不算"单源搬的"也不算"猜的"**
    // （否则结果弹窗会说"移动 1（其中单源 1）"—— 明明一条单源都没搬成）
    expect(summary.unverified).toBe(0)
    expect(summary.unverified).toBeLessThanOrEqual(summary.moved)
    expect(summary.approx).toBeLessThanOrEqual(summary.moved)
  })
})

describe('⑥b high 写回的时机：decidedAt 只在**移动成功之后**写', () => {
  it('移动失败（assignCategory 返回 null）→ 分类没变、classifyReview 保持原样（下一批还会重试）', async () => {
    const a = fixture({
      name: '北欧布艺三人沙发',
      zhimoId: '9201',
      classifyReview: { confidence: 'none' }
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('沙发', CRUMB_SOFA))
    // 所有移动都失败（目录不存在 / 路径非法）
    modvault.assignCategory.mockImplementation(async () => {
      order.push('move')
      return null
    })

    const summary = await runOnce()

    expect(summary.moved).toBe(0)
    expect(summary.failed).toBe(1)
    // ⚠️ 关键：写 `decidedAt` 就等于"这条已定案、以后别再动它"。
    // 移动都没成功就写，会让这条资产**永远停在未分类**且再不进候选 —— 静默丢数据。
    expect(assetById(a.id).classifyReview?.confidence).toBe('none')
    expect(assetById(a.id).classifyReview?.decidedAt).toBeUndefined()
    expect(assetById(a.id).category1).toBe(UNCLASSIFIED)
  })
})

describe('⑥ 备份必须早于第一次移动（顺序 = backup → move）', () => {
  it('两条 high 资产（两个分类对）→ backups.put 在第一次 assignCategory 之前', async () => {
    const a = fixture({
      name: '工装办公室 施工图',
      kind: 'cad',
      zhimoId: '9006',
      files: [{ rel: 'a.dwg', name: 'a.dwg', ext: 'dwg', size: 1, kind: 'model' }]
    })
    const b = fixture({ name: '北欧布艺三人沙发', kind: 'model', zhimoId: '9007' })
    useVault.setState({ assets: [a, b] })
    modvault.fetchZhimoMeta.mockImplementation(async (p: { id: string }) =>
      p.id === '9006' ? metaOf('办公室', CRUMB_OFFICE) : metaOf('沙发', CRUMB_SOFA)
    )

    const summary = await runOnce()

    expect(summary.moved).toBe(2)
    const backupAt = order.indexOf('backup')
    const moveAt = order.indexOf('move')
    expect(backupAt).toBeGreaterThanOrEqual(0)
    expect(moveAt).toBeGreaterThan(backupAt)
    // 一次备份覆盖整批（不是每组一份）
    expect(zhimoBackups()).toHaveLength(1)
  })
})

// ══════════════════════════════════════════════════════════════════
// ⑦ 取消后已抓到的仍落库
// ══════════════════════════════════════════════════════════════════

describe('⑦ 取消语义：只停"发新请求"，已抓到的照样写回/搬', () => {
  it('shouldStop 在抓到 2 条后变真 → 第 3 条起不再 fetch，前两条已落库', async () => {
    const ids = ['9101', '9102', '9103']
    const assets = ids.map((id, i) =>
      fixture({ name: `工装办公室 施工图 ${i}`, kind: 'cad', zhimoId: id })
    )
    useVault.setState({ assets })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('办公室', CRUMB_OFFICE))

    const summary = await runOnce({
      shouldStop: () => modvault.fetchZhimoMeta.mock.calls.length >= 2
    })

    // 队列的闸门在"发请求前"再查一次，所以第 3 条不会被发出
    expect(modvault.fetchZhimoMeta.mock.calls.length).toBe(2)
    expect(summary.scanned).toBe(2)
    // 已抓到的**必须**落库（用户点取消是"别再打站了"，不是"把已拿到的结果丢掉"）
    expect(summary.moved).toBe(2)
    const high = useVault.getState().assets.filter((x) => x.classifyReview?.confidence === 'high')
    expect(high).toHaveLength(2)
    // 第 3 条完全没被碰
    expect(assetById(assets[2]!.id).category1).toBe(UNCLASSIFIED)
    expect(assetById(assets[2]!.id).classifyReview).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// ⑧ hdri / other 没有站方源
// ══════════════════════════════════════════════════════════════════

describe('⑧ hdri / other 没有站方源 → s2 恒 null、判 medium-s1 或 none、不崩', () => {
  it('s2OfMeta 对 hdri/other 恒 null（哪怕站方给了面包屑）', () => {
    expect(s2OfMeta(metaOf('客厅', CRUMB_OFFICE), 'hdri')).toBeNull()
    expect(s2OfMeta(metaOf('客厅', CRUMB_OFFICE), 'other')).toBeNull()
    // 反向对照：同样的面包屑对 cad 是能解析出来的（证明上面不是"函数整体坏了"）
    expect(s2OfMeta(metaOf('办公室', CRUMB_OFFICE), 'cad')?.level1).toBe('工装空间')
  })

  it('hdri 资产跑一遍：S1 双未分类 + 无 S2 → none，不搬、不崩、不写库', async () => {
    const a = fixture({ name: '某个 HDRI 环境光', kind: 'hdri', zhimoId: '9008' })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoMeta.mockResolvedValue(metaOf('客厅', CRUMB_OFFICE))

    const summary = await runOnce()

    expect(summary.scanned).toBe(1)
    expect(summary.moved).toBe(0)
    expect(summary.conflicts).toBe(0)
    expect(summary.unverified).toBe(0)
    expect(summary.failed).toBe(0)
    // none 与 T0 初值同形 → 不改库（§5.3 末条）
    expect(assetById(a.id).classifyReview).toBeUndefined()
  })

  it('other 资产：S1 判不出一级、S2 恒 null → none，且计入 unmapped（站方给了名字但还原不出路径）', async () => {
    const out = planZhimoVerify({
      asset: {
        name: '工装办公室 施工图',
        files: [],
        kind: 'other',
        category1: UNCLASSIFIED,
        category2: UNCLASSIFIED
      },
      meta: metaOf('办公室', CRUMB_OFFICE),
      now: 999
    })
    // other 的 S1 恒双未分类、S2 恒 null → none。
    // `unmapped: true` = 站方确实说了「办公室」这个名字，但我们（对 other 这类）没有站方源
    // 可以还原出路径 —— 这与"站方什么都没给"（noStation）必须分开计数。
    expect(out).toEqual({
      kind: 'untouched',
      reason: 'same-as-initial',
      confidence: 'none',
      unmapped: true
    })
  })

  it('other 资产 + 站方连名字都没给 → none 且**不**计 unmapped（真·站方未给）', async () => {
    const out = planZhimoVerify({
      asset: {
        name: '某个 other 资产',
        files: [],
        kind: 'other',
        category1: UNCLASSIFIED,
        category2: UNCLASSIFIED
      },
      meta: metaOf(null),
      now: 999
    })
    expect(out).toEqual({
      kind: 'untouched',
      reason: 'same-as-initial',
      confidence: 'none'
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// 附：候选筛选（数据安全底线）
// ══════════════════════════════════════════════════════════════════

describe('isZhimoVerifyCandidate：恒等于 isZhimoReclassCandidate（不复验"已分类"的）', () => {
  it('双未分类 + 有 ID → 收', () => {
    expect(isZhimoVerifyCandidate(fixture({ zhimoId: '1' }))).toBe(true)
  })

  it('已分类且 medium-s1 → **不收**（用户手工拖拽不会清 classifyReview，收进来会改用户的结论）', () => {
    expect(
      isZhimoVerifyCandidate(
        fixture({
          zhimoId: '2',
          category1: '家具',
          category2: '沙发',
          classifyReview: { confidence: 'medium-s1' }
        })
      )
    ).toBe(false)
  })

  it('已分类且已定案 → 不收', () => {
    expect(
      isZhimoVerifyCandidate(
        fixture({
          zhimoId: '3',
          category1: '家具',
          category2: '沙发',
          classifyReview: { confidence: 'high', decidedAt: 1 }
        })
      )
    ).toBe(false)
  })

  it('老记录（无 classifyReview）且已分类 → 不收（行为与改造前完全一致）', () => {
    expect(
      isZhimoVerifyCandidate(fixture({ zhimoId: '4', category1: '家具', category2: '沙发' }))
    ).toBe(false)
  })

  it('软删 / 无知末 ID → 不收', () => {
    expect(isZhimoVerifyCandidate(fixture({ zhimoId: '5', deletedAt: 1 }))).toBe(false)
    expect(isZhimoVerifyCandidate(fixture({ zhimoId: null }))).toBe(false)
  })

  it('与 isZhimoReclassCandidate 逐例同值（别名不改语义）', () => {
    const cases: Asset[] = [
      fixture({ zhimoId: '6' }),
      fixture({ zhimoId: '7', category1: '家具', category2: '沙发' }),
      fixture({ zhimoId: '8', category1: '家具', category2: UNCLASSIFIED }),
      fixture({ zhimoId: '9', deletedAt: 1 }),
      fixture({ zhimoId: null }),
      fixture({ zhimoId: '10', category1: '家具', category2: '沙发', classifyReview: { confidence: 'medium-s1' } })
    ]
    for (const a of cases) {
      expect(isZhimoVerifyCandidate(a)).toBe(isZhimoReclassCandidate(a))
    }
  })
})
