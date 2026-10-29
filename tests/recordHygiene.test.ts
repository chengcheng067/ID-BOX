/// <reference lib="dom" />
/**
 * T-PRUNE（0.7.7）—— 索引记录卫生的纯逻辑 + 接线回归。
 *
 * 真机事实（`docs/25-待办-用户反馈.md` T-PRUNE）：HDR 库 **69 条索引 / 33 个文件夹**
 * （3 组 × 13 条同 folder 重复），69 条都写 `thumbStatus='ready'`，盘上只剩 33 张图
 * —— 36 张被 `pruneThumbs` 按"孤儿"删掉了（白名单用了本次 rescan 的合并结果）。
 * 每次刷新还会 +3 条（软删记录的 folder 把活记录的 Map 键一起删了）。
 *
 * 本文件分两层：
 * ① 纯函数（`logic/recordHygiene.ts`）：清理计划 / 存在性修复计划；
 * ② 真实 `store.rescan()` 的两个回归：软删同名 folder 不产生新 UUID、同 folder
 *    活记录重复时显式合并（不悬空、不新增）。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type ThumbFileEntry } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { IndexBackup } from '../src/renderer/db'
import {
  compareSurvivor,
  mergeDuplicateGroup,
  planDuplicateCleanup,
  planThumbPresenceRepair
} from '../src/renderer/logic/recordHygiene'

/** 最小可辨识记录：所有用户字段为空，测试按需覆盖 */
function asset(over: Partial<Asset> = {}): Asset {
  const id = over.id ?? 'asset-1'
  return {
    id,
    name: '资产',
    kind: 'texture',
    source: '',
    folder: 'E:\\Lib\\材质\\未分类\\未分类\\资产',
    relFolder: '材质/未分类/未分类/资产',
    files: [{ rel: 'a.jpg', name: 'a.jpg', ext: 'jpg', size: 1, kind: 'texture' }],
    size: 1,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'texture:资产',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    ...over
  }
}

// ── ① 3 组 × 13 条：真机形状 ───────────────────────────────────────────

describe('planDuplicateCleanup —— 真机形状（3 组 × 13 条）', () => {
  const FOLDERS = [
    'E:\\ModVault\\Library\\HDRI\\未分类\\未分类\\森林',
    'E:\\ModVault\\Library\\HDRI\\未分类\\未分类\\海边',
    'E:\\ModVault\\Library\\HDRI\\未分类\\未分类\\室内'
  ]

  /** 每组 13 条，其中**第 8 条**是唯一有 ready 缩略图的（真机：每组 1 张图 / 13 条记录） */
  function realWorldRecords(): Asset[] {
    const out: Asset[] = []
    FOLDERS.forEach((folder, gi) => {
      for (let i = 0; i < 13; i += 1) {
        const id = `g${gi}-${String(i).padStart(2, '0')}`
        const hasThumb = i === 7
        out.push(
          asset({
            id,
            folder,
            name: `HDRI-${gi}`,
            dedupeKey: `hdri:HDRI-${gi}`,
            thumbStatus: hasThumb ? 'ready' : 'none',
            thumbPath: hasThumb ? `${id}-e94039c0.jpg` : undefined,
            // 第 3 条带一条用户标签：合并后必须出现在幸存者身上
            tags: i === 3 ? ['森林'] : []
          })
        )
      }
    })
    return out
  }

  it('3 组计划、每组 drop 12 条、keep 的是"有 ready 缩略图"那条', () => {
    const plan = planDuplicateCleanup(realWorldRecords())

    expect(plan).toHaveLength(3)
    expect(plan.map((g) => g.folder).sort()).toEqual([...FOLDERS].sort())
    for (const group of plan) {
      const gi = FOLDERS.indexOf(group.folder)
      expect(gi).toBeGreaterThanOrEqual(0)
      expect(group.dropIds).toHaveLength(12)
      expect(group.keepId).toBe(`g${gi}-07`)
      expect(group.merged.id).toBe(group.keepId)
      expect(group.merged.folder).toBe(group.folder)
      expect(group.merged.thumbStatus).toBe('ready')
      expect(group.merged.thumbPath).toBe(`${group.keepId}-e94039c0.jpg`)
      // 别条的用户标签不能随记录一起消失
      expect(group.merged.tags).toEqual(['森林'])
    }
    // 36 条被丢弃 = 真机上被 prune 误删的 36 张图
    expect(plan.flatMap((g) => g.dropIds)).toHaveLength(36)
  })

  it('幂等：把计划应用一遍后再算 → 空计划', () => {
    const records = realWorldRecords()
    const plan = planDuplicateCleanup(records)
    const dropSet = new Set(plan.flatMap((g) => g.dropIds))
    const mergedById = new Map(plan.map((g) => [g.keepId, g.merged]))
    const after = records
      .filter((a) => !dropSet.has(a.id))
      .map((a) => mergedById.get(a.id) ?? a)

    expect(after).toHaveLength(3)
    expect(planDuplicateCleanup(after)).toEqual([])
  })
})

// ── ② 幸存者优先级 ────────────────────────────────────────────────────

describe('幸存者优先级（① 缩略图 > ② 用户字段数 > ③ updatedAt > ④ id）', () => {
  it('有 ready 缩略图 胜过 无缩略图（哪怕对方用户字段更多）', () => {
    const rich = asset({
      id: 'aaa-rich',
      folder: 'F',
      tags: ['a', 'b'],
      note: '备注',
      favorite: true,
      rating: 5,
      colorTag: 'red',
      styles: ['现代']
    })
    const withThumb = asset({
      id: 'zzz-thumb',
      folder: 'F',
      thumbStatus: 'ready',
      thumbPath: 'zzz.jpg'
    })

    const plan = planDuplicateCleanup([rich, withThumb])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.keepId).toBe('zzz-thumb')
  })

  it('都没有缩略图 → 用户字段更多的胜出', () => {
    const few = asset({ id: 'aaa-few', folder: 'F' })
    const many = asset({ id: 'zzz-many', folder: 'F', note: '我的备注', tags: ['奶油'], rating: 3 })

    expect(planDuplicateCleanup([few, many])[0]!.keepId).toBe('zzz-many')
  })

  it('用户字段数相同 → updatedAt 更新的胜出', () => {
    const oldOne = asset({ id: 'aaa-old', folder: 'F', note: '备注', updatedAt: 1000 })
    const newOne = asset({ id: 'zzz-new', folder: 'F', note: '备注', updatedAt: 2000 })

    expect(planDuplicateCleanup([oldOne, newOne])[0]!.keepId).toBe('zzz-new')
  })

  it('全部平手 → id 字典序最小（确定性：换输入顺序结果不变）', () => {
    const a = asset({ id: 'aaa', folder: 'F' })
    const b = asset({ id: 'bbb', folder: 'F' })

    expect(planDuplicateCleanup([a, b])[0]!.keepId).toBe('aaa')
    expect(planDuplicateCleanup([b, a])[0]!.keepId).toBe('aaa')
    expect(compareSurvivor(a, b)).toBeLessThan(0)
  })
})

// ── ③ 字段合并：只补空、绝不覆盖 ──────────────────────────────────────

describe('mergeDuplicateGroup —— 只补空、绝不覆盖', () => {
  it('note / cover 不覆盖；分类的 `未分类` 允许被真实分类补上', () => {
    const keeper = asset({
      id: 'keep',
      thumbStatus: 'ready',
      thumbPath: 'keep.jpg',
      note: '我的备注',
      cover: '我的封面.jpg',
      coverSource: 'manual',
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED,
      size: 0
    })
    const other = asset({
      id: 'other',
      note: '别的',
      cover: '别的封面.jpg',
      coverSource: 'largest',
      category1: '软装陈设',
      category2: '灯具',
      favorite: true,
      rating: 4,
      tags: ['奶油'],
      size: 500,
      importedAt: 1_600_000_000_000
    })

    const merged = mergeDuplicateGroup(keeper, [other])

    // 用户的备注 / 手动封面：一个字都不许动
    expect(merged.note).toBe('我的备注')
    expect(merged.cover).toBe('我的封面.jpg')
    expect(merged.coverSource).toBe('manual')
    // `未分类` = 没填过 → 允许继承真实分类
    expect(merged.category1).toBe('软装陈设')
    expect(merged.category2).toBe('灯具')
    // 布尔 / 数值 / 列表取"更靠用户意图"的一端
    expect(merged.favorite).toBe(true)
    expect(merged.rating).toBe(4)
    expect(merged.tags).toEqual(['奶油'])
    expect(merged.size).toBe(500)
    // 主键 / 合并键 / 大类不动
    expect(merged.id).toBe('keep')
    expect(merged.folder).toBe(keeper.folder)
    expect(merged.kind).toBe(keeper.kind)
    // importedAt 取最早（本仓库没有 createdAt，它就是创建时间）
    expect(merged.importedAt).toBe(1_600_000_000_000)
  })

  it('幸存者封面为空 → 继承别条封面，且 coverSource 跟着同一条走', () => {
    const keeper = asset({ id: 'keep', thumbStatus: 'ready', thumbPath: 'k.jpg' })
    const other = asset({ id: 'other', cover: 'b.jpg', coverSource: 'zhimo' })

    const merged = mergeDuplicateGroup(keeper, [other])
    expect(merged.cover).toBe('b.jpg')
    expect(merged.coverSource).toBe('zhimo')
  })

  it('renderParams / renderShape 只在 undefined 时继承；已有值不覆盖', () => {
    const keeper = asset({ id: 'keep', thumbStatus: 'ready', thumbPath: 'k.jpg' })
    const withParams = asset({
      id: 'p',
      renderParams: { roughness: 1.4, bump: 0.7, uv: 3.1, light: 1, metal: 0, alpha: 1 },
      renderShape: 'plane'
    })

    const filled = mergeDuplicateGroup(keeper, [withParams])
    expect(filled.renderParams?.uv).toBe(3.1)
    expect(filled.renderShape).toBe('plane')

    const keepOwn = asset({
      id: 'keep2',
      thumbStatus: 'ready',
      thumbPath: 'k2.jpg',
      renderParams: { roughness: 1, bump: 1, uv: 2, light: 1, metal: 0, alpha: 1 },
      renderShape: 'roundedBox'
    })
    const mergedOwn = mergeDuplicateGroup(keepOwn, [withParams])
    expect(mergedOwn.renderParams?.uv).toBe(2)
    expect(mergedOwn.renderShape).toBe('roundedBox')
  })

  it('tags 取并集并去重（保持出现顺序）', () => {
    const keeper = asset({ id: 'keep', thumbStatus: 'ready', thumbPath: 'k.jpg', tags: ['a', 'b'] })
    const other = asset({ id: 'o', tags: ['b', 'c'] })
    expect(mergeDuplicateGroup(keeper, [other]).tags).toEqual(['a', 'b', 'c'])
  })

  it('files 只在幸存者没有文件时取条数最多的那条', () => {
    const keeper = asset({ id: 'keep', thumbStatus: 'ready', thumbPath: 'k.jpg', files: [] })
    const few = asset({
      id: 'few',
      files: [{ rel: 'x.jpg', name: 'x.jpg', ext: 'jpg', size: 1, kind: 'texture' }]
    })
    const many = asset({
      id: 'many',
      files: [
        { rel: 'y1.jpg', name: 'y1.jpg', ext: 'jpg', size: 1, kind: 'texture' },
        { rel: 'y2.jpg', name: 'y2.jpg', ext: 'jpg', size: 1, kind: 'texture' }
      ]
    })

    expect(mergeDuplicateGroup(keeper, [few, many]).files).toHaveLength(2)

    const withFiles = asset({
      id: 'own',
      thumbStatus: 'ready',
      thumbPath: 'own.jpg',
      files: [{ rel: 'own.jpg', name: 'own.jpg', ext: 'jpg', size: 9, kind: 'texture' }]
    })
    expect(mergeDuplicateGroup(withFiles, [many]).files.map((f) => f.rel)).toEqual(['own.jpg'])
  })
})

// ── ④ 软删记录：不参与、不被删 ────────────────────────────────────────

describe('软删记录绝不参与重复清理', () => {
  it('同 folder 一条软删 + 两条活 → 只处理两条活，dropIds 不含软删那条', () => {
    const trashed = asset({
      id: 'trash-1',
      folder: 'F',
      deletedAt: 1_700_000_000_000,
      trashRel: '.trash/trash-1'
    })
    const liveKeep = asset({ id: 'live-1', folder: 'F', thumbStatus: 'ready', thumbPath: 'l.jpg' })
    const liveDup = asset({ id: 'live-2', folder: 'F' })

    const plan = planDuplicateCleanup([trashed, liveKeep, liveDup])

    expect(plan).toHaveLength(1)
    expect(plan[0]!.keepId).toBe('live-1')
    expect(plan[0]!.dropIds).toEqual(['live-2'])
    expect(plan[0]!.dropIds).not.toContain('trash-1')
    expect(plan[0]!.merged.deletedAt).toBeUndefined()
  })

  it('只有软删记录同 folder（没有活记录）→ 不产出任何计划', () => {
    const a = asset({ id: 't1', folder: 'F', deletedAt: 1 })
    const b = asset({ id: 't2', folder: 'F', deletedAt: 2 })
    expect(planDuplicateCleanup([a, b])).toEqual([])
  })

  it('folder 为空串的脏数据不参与（不能拿空串当合并键）', () => {
    const a = asset({ id: 'a', folder: '' })
    const b = asset({ id: 'b', folder: '' })
    expect(planDuplicateCleanup([a, b])).toEqual([])
  })
})

// ── ⑤ 缩略图存在性修复 ────────────────────────────────────────────────

describe('planThumbPresenceRepair', () => {
  const disk = ['good-1.jpg', 'good-2.jpg']

  it('ready + 盘上没这个文件 → 命中', () => {
    const a = asset({ id: 'a', thumbStatus: 'ready', thumbPath: 'missing.jpg' })
    expect(planThumbPresenceRepair([a], disk)).toEqual([{ id: 'a' }])
  })

  it('ready + 盘上有这个文件 → 不命中', () => {
    const a = asset({ id: 'a', thumbStatus: 'ready', thumbPath: 'good-1.jpg' })
    expect(planThumbPresenceRepair([a], disk)).toEqual([])
  })

  it('thumbStatus !== ready（none / failed）→ 一律不管（补齐队列的活）', () => {
    const none = asset({ id: 'n', thumbStatus: 'none' })
    const failed = asset({ id: 'f', thumbStatus: 'failed', thumbPath: 'missing.jpg' })
    expect(planThumbPresenceRepair([none, failed], disk)).toEqual([])
  })

  it('清单为 null（读盘失败）→ 全部不命中（一次失败绝不能把全库标成缺图）', () => {
    const ready = asset({ id: 'a', thumbStatus: 'ready', thumbPath: 'missing.jpg' })
    expect(planThumbPresenceRepair([ready], null)).toEqual([])
  })

  it('清单是**真空**（重装后 thumbs 目录为空）→ 全部命中，交给补齐队列重生', () => {
    // 2026-10-28 真机实测的根因：旧实现把 `[]` 也当成读盘失败直接跳过，
    // 于是重装（thumbs 缓存被清）后记录永远停在 ready，卡片一直只有图标。
    const ready = asset({ id: 'a', thumbStatus: 'ready', thumbPath: 'missing.jpg' })
    expect(planThumbPresenceRepair([ready], [])).toEqual([{ id: 'a' }])
    // 全是空白串同样是"没有有效文件"
    expect(planThumbPresenceRepair([ready], ['  ', ''])).toEqual([{ id: 'a' }])
  })

  it('软删记录不处理（其缩略图归回收站流程管）', () => {
    const trashed = asset({
      id: 't',
      thumbStatus: 'ready',
      thumbPath: 'missing.jpg',
      deletedAt: 1,
      trashRel: '.trash/t'
    })
    expect(planThumbPresenceRepair([trashed], disk)).toEqual([])
  })

  it('thumbPath 带目录的历史脏值也能匹配上（用文件名比较）', () => {
    const a = asset({ id: 'a', thumbStatus: 'ready', thumbPath: 'thumbs\\good-2.jpg' })
    expect(planThumbPresenceRepair([a], disk)).toEqual([])
  })

  it('ready 但连 thumbPath 都没有 → 视为不自洽，命中', () => {
    const a = asset({ id: 'a', thumbStatus: 'ready' })
    expect(planThumbPresenceRepair([a], disk)).toEqual([{ id: 'a' }])
  })
})

// ── ⑥ 源码守卫：prune 白名单不许再用 merged ──────────────────────────

describe('store.ts 源码守卫', () => {
  const STORE = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf-8')

  it('pruneThumbs 的实参不是 `merged.map(...)`（0.7.6 误删 36 张图的根因）', () => {
    const args = [...STORE.matchAll(/pruneThumbs\(([^)]*)/g)].map((m) => m[1] ?? '')
    expect(args.length).toBeGreaterThan(0)
    for (const arg of args) {
      expect(arg, `pruneThumbs 仍在用合并结果当白名单：${arg}`).not.toContain('merged.map(')
    }
  })

  it('rescan 的 prune 用库里真实 id 集合（idsAfter），且读表失败时一次也不 prune', () => {
    expect(STORE).toMatch(/pruneThumbs\(idsAfter\)/)
    expect(STORE).toContain('idsAfter.length > 0')
  })

  it('AssetGrid 的 Cover 有 onError 兜底（404 时回落类型图标，不留黑块）', () => {
    const grid = fs.readFileSync(
      new URL('../src/renderer/components/AssetGrid.tsx', import.meta.url),
      'utf-8'
    )
    expect(grid).toContain('setBrokenSrc(src)')
    expect(grid).toContain('brokenSrc !== src')
  })
})

// ── ⑦ 真实 rescan 回归：软删同名 folder 不产生新 UUID ────────────────
//
// 必须在 import store 之前打桩 window.modvault 与内存版 Dexie（与
// tests/rescanMergePreserve.test.ts 同一套做法）。

const modvault = {
  rescan: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  chooseLibrary: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  deleteOneThumb: vi.fn(async () => true),
  listThumbs: vi.fn(async (): Promise<ThumbFileEntry[]> => []),
  detectMaterialMerge: vi.fn(async () => ({ needMerge: false, count: 0, sources: [] })),
  onMaterialMergeNotice: vi.fn(() => () => undefined),
  onImportBatchDone: vi.fn(() => () => undefined),
  onImportConflictAsk: vi.fn(() => () => undefined),
  onImportConflictExpired: vi.fn(() => () => undefined),
  onImportEvent: vi.fn(() => () => undefined),
  migrateLayout: vi.fn()
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

let rows: Asset[] = []
const bulkDeleteCalls: string[][] = []
const backupStore = new Map<string, IndexBackup>()

function upsert(list: Asset[]): void {
  for (const a of list) {
    const i = rows.findIndex((r) => r.id === a.id)
    if (i >= 0) rows[i] = a
    else rows.push(a)
  }
}

const fakeAssets = {
  toArray: vi.fn(async () => rows.map((r) => ({ ...r }))),
  bulkGet: vi.fn(async (ids: readonly string[]) => ids.map((id) => rows.find((r) => r.id === id))),
  put: vi.fn(async (a: Asset) => {
    upsert([a])
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    upsert(list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => {
    bulkDeleteCalls.push([...ids])
    rows = rows.filter((r) => !ids.includes(r.id))
    return ids.length
  }),
  // init 的「缩略图存在性修复」用 `.where('id').equals(id).modify()` 定向写
  where: vi.fn((key: string) => ({
    equals: (id: string) => ({
      modify: vi.fn(async (fn: (a: Asset) => void) => {
        expect(key).toBe('id')
        const rec = rows.find((r) => r.id === id)
        if (!rec) return 0
        fn(rec)
        return 1
      })
    })
  }))
}
const fakeBackups = {
  put: vi.fn(async (b: IndexBackup) => {
    backupStore.set(b.id, b)
    return b.id
  }),
  toArray: vi.fn(async () => [...backupStore.values()]),
  bulkDelete: vi.fn(async (ids: string[]) => {
    for (const id of ids) backupStore.delete(id)
    return ids.length
  })
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })

const { useVault } = await import('../src/renderer/store')

/** 主进程 rescan 的产出形状：新 UUID、用户字段全是占位默认值 */
function scannedOf(folder: string, name: string): Asset {
  return asset({
    id: `scanned-${name}`,
    folder,
    name,
    relFolder: `材质/未分类/未分类/${name}`,
    dedupeKey: `texture:${name}`,
    tags: [],
    note: '',
    thumbStatus: 'none'
  })
}

beforeEach(() => {
  rows = []
  bulkDeleteCalls.length = 0
  backupStore.clear()
  vi.clearAllMocks()
  modvault.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS })
  modvault.listThumbs.mockResolvedValue([])
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  useVault.setState({ assets: [], notice: null, rescanBackupCount: 0, settings: null })
})

describe('store.rescan —— 软删同名 folder 不再造新记录', () => {
  it('同 folder 一条软删 + 一条活 → 沿用活记录的 id，不产生新 UUID、不删回收站', async () => {
    const FOLDER = 'E:\\Lib\\材质\\未分类\\未分类\\沙发'
    const live = asset({ id: 'live-1', folder: FOLDER, name: '沙发', thumbStatus: 'none' })
    const trashed = asset({
      id: 'trash-1',
      folder: FOLDER, // 软删后 folder 字段不变 —— 这正是 0.7.6 的撞键来源
      name: '沙发',
      deletedAt: 1_700_000_000_000,
      trashRel: '.trash/trash-1'
    })
    useVault.setState({ assets: [live, trashed] })
    modvault.rescan.mockResolvedValue({ assets: [scannedOf(FOLDER, '沙发')], ignored: [] })
    rows = [live, trashed]

    // 连刷 3 次：每次都必须是同一条 id，行数不增
    for (let i = 0; i < 3; i += 1) {
      const outcome = await useVault.getState().rescan()
      expect(outcome.aborted).toBeNull()
      const state = useVault.getState()
      expect(state.assets).toHaveLength(2)
      expect(state.assets.filter((a) => a.deletedAt === undefined).map((a) => a.id)).toEqual([
        'live-1'
      ])
      expect(state.assets.some((a) => a.id.startsWith('scanned-'))).toBe(false)
      expect(rows.filter((r) => r.deletedAt === undefined)).toHaveLength(1)
    }
    // 没有任何删除：软删记录也不会被清出索引
    expect(rows.some((r) => r.id === 'trash-1')).toBe(true)
  })

  it('同 folder 多条活记录（rescan 期间产生的冲突）→ 显式合并，不悬空、不新增', async () => {
    const FOLDER = 'E:\\Lib\\材质\\未分类\\未分类\\木纹'
    const keeper = asset({
      id: 'live-keep',
      folder: FOLDER,
      name: '木纹',
      thumbStatus: 'ready',
      thumbPath: 'keep.jpg',
      size: 10
    })
    const dupA = asset({ id: 'live-a', folder: FOLDER, name: '木纹', note: 'A 的备注' })
    const dupB = asset({ id: 'live-b', folder: FOLDER, name: '木纹', tags: ['B'] })
    useVault.setState({ assets: [keeper, dupA, dupB] })
    modvault.rescan.mockResolvedValue({ assets: [scannedOf(FOLDER, '木纹')], ignored: [] })
    rows = [keeper, dupA, dupB]

    const outcome = await useVault.getState().rescan()

    expect(outcome.aborted).toBeNull()
    const state = useVault.getState()
    // 只剩一条活记录，且沿用幸存者 id
    expect(state.assets).toHaveLength(1)
    expect(state.assets[0]!.id).toBe('live-keep')
    // 别条的用户字段并进来（只补空）
    expect(state.assets[0]!.note).toBe('A 的备注')
    expect(state.assets[0]!.tags).toEqual(['B'])
    // 被丢弃的两条真的从表里删了（不是只从内存里消失）
    expect(rows.map((r) => r.id)).toEqual(['live-keep'])
    expect(bulkDeleteCalls.flat().sort()).toEqual(['live-a', 'live-b'])
    // 有备份凭证（rescan-*）
    expect([...backupStore.keys()].some((id) => id.startsWith('rescan-'))).toBe(true)
    // 没有新 UUID 落库
    expect(rows.some((r) => r.id.startsWith('scanned-'))).toBe(false)
  })
})

// ── ⑧ 真实 init 接线：清理 → 备份 → notice；存在性修复 → 定向写、静默 ──

describe('store.init —— 重复记录清理与缩略图存在性修复的接线', () => {
  const FOLDERS = [
    'E:\ModVault\Library\HDRI\未分类\未分类\森林',
    'E:\ModVault\Library\HDRI\未分类\未分类\海边',
    'E:\ModVault\Library\HDRI\未分类\未分类\室内'
  ]

  it('3 组 × 13 条 → 清理成 3 条、写 dup-clean 备份、一条 notice、prune 白名单是真实 id', async () => {
    const records: Asset[] = []
    FOLDERS.forEach((folder, gi) => {
      for (let i = 0; i < 13; i += 1) {
        const id = `k${gi}-${String(i).padStart(2, '0')}`
        const hasThumb = i === 7
        records.push(
          asset({
            id,
            folder,
            name: `HDRI-${gi}`,
            dedupeKey: `hdri:HDRI-${gi}`,
            files: [], // 避免材质球队列参与（与本用例无关）
            thumbStatus: hasThumb ? 'ready' : 'none',
            thumbPath: hasThumb ? `${id}-aaaaaaaa.jpg` : undefined
          })
        )
      }
    })
    rows = records
    const keepers = [0, 1, 2].map((gi) => `k${gi}-07`)

    await useVault.getState().init()

    // 内存态 + 表里都只剩 3 条，且都是有图的那条
    expect(useVault.getState().assets.map((a) => a.id).sort()).toEqual([...keepers].sort())
    expect(rows.map((r) => r.id).sort()).toEqual([...keepers].sort())

    // 备份：`dup-clean-*`，内容是被丢弃的原记录 + 被改写的幸存者原记录
    const dupBackup = [...backupStore.values()].find((b) => b.id.startsWith('dup-clean-'))
    expect(dupBackup).toBeTruthy()
    const snapshot = JSON.parse(dupBackup!.json) as { dropped: Asset[]; rewritten: Asset[] }
    expect(snapshot.dropped).toHaveLength(36)
    expect(snapshot.rewritten).toHaveLength(3)
    // 原始记录是完整记录（不是只有 id）：用户字段能从这里捞回来
    expect(snapshot.dropped[0]!.folder).toBeTruthy()
    expect(snapshot.dropped[0]!.kind).toBe('texture')

    // 一条 toast（不是弹窗），文案固定
    expect(useVault.getState().notice).toBe('已合并 36 条重复索引记录（原始记录已备份）')

    // prune 白名单 = 清理后的真实 id（3 个），不是 39 个
    expect(modvault.pruneThumbs).toHaveBeenCalledTimes(1)
    expect([...(modvault.pruneThumbs.mock.calls[0]![0] as string[])].sort()).toEqual(
      [...keepers].sort()
    )
    // 这类备份**不进**「可恢复的重扫备份」计数
    expect(useVault.getState().rescanBackupCount).toBe(0)
  })

  it('ready 但盘上没文件 → 置 none（定向写），且不弹 notice', async () => {
    const broken = asset({
      id: 'broken-1',
      files: [],
      cover: 'a.jpg',
      thumbStatus: 'ready',
      thumbPath: 'broken-1-deadbeef.jpg'
    })
    rows = [broken]
    modvault.listThumbs.mockResolvedValue([{ name: 'someone-else-12345678.jpg', size: 1, mtimeMs: 1 }])

    await useVault.getState().init()

    const row = rows[0]!
    expect(row.thumbStatus).toBe('none')
    expect(row.thumbPath).toBeUndefined()
    // 内存态同步（否则补齐队列看不到候选）
    expect(useVault.getState().assets[0]!.thumbStatus).toBe('none')
    expect(useVault.getState().assets[0]!.thumbPath).toBeUndefined()
    // 静默：没有为"修图"弹任何 toast
    expect(useVault.getState().notice).toBeNull()
  })

  it('listThumbs 抛错（列不出来）→ 一条都不改（绝不全库标缺图）', async () => {
    const maybeFine = asset({
      id: 'fine-1',
      files: [],
      cover: 'a.jpg',
      thumbStatus: 'ready',
      thumbPath: 'fine-1-deadbeef.jpg'
    })
    rows = [maybeFine]
    modvault.listThumbs.mockRejectedValue(new Error('ipc down'))

    await useVault.getState().init()

    expect(rows[0]!.thumbStatus).toBe('ready')
    expect(rows[0]!.thumbPath).toBe('fine-1-deadbeef.jpg')
  })

  it('listThumbs 返回空数组（重装后 thumbs 缓存清空）→ 置 none 交给补齐队列', async () => {
    // 0.8.3 真机实测：清空 userData/thumbs 后 4 张卡片全变图标、30 秒不恢复。
    // 旧实现把空名单当成读盘失败跳过 → 记录永远停在 ready，队列不接。
    const lost = asset({
      id: 'lost-1',
      files: [],
      cover: 'a.jpg',
      thumbStatus: 'ready',
      thumbPath: 'lost-1-deadbeef.jpg'
    })
    rows = [lost]
    modvault.listThumbs.mockResolvedValue([])

    await useVault.getState().init()

    expect(rows[0]!.thumbStatus).toBe('none')
    expect(rows[0]!.thumbPath).toBeUndefined()
  })
})
