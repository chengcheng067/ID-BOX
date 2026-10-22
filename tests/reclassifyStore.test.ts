/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，renderer 源码依赖 DOM 全局（window）。
// `Window.modvault` 的真实声明在 src/renderer/env.d.ts（只对 tsconfig.web 生效）。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

/**
 * 「重跑自动分类」/「撤销上次重跑」的 store 层验收（v1.0.13）。
 *
 * 做法与 `storeFlow.test.ts` / `materialMergeStore.test.ts` 一致：不抽逻辑、不改实现，
 * 只把两个边界打桩——`window.modvault`（IPC 桥）与 `db`（Dexie），然后驱动**真实 action**。
 * 因此这里验的是发布路径：候选筛选、备份早于移动、按分类对分组、撤销搬回、候选为 0 零写入。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, AssignCategoryPayload, AssignCategoryResult } from '../src/shared/types'

const modvault = {
  assignCategory: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  pruneThumbs: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
import type { IndexBackup } from '../src/renderer/db'

/** 调用顺序记录：'backup'（写备份）/ 'move'（真实移动 IPC） */
const order: string[] = []
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

/** 资产表（只关心 assignCategory 落库用到的 bulkPut） */
const bulkPutCalls: Asset[][] = []
const fakeAssets = {
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list)
    return list.length
  }),
  put: vi.fn(async (a: Asset) => a.id),
  toArray: vi.fn(async () => [])
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
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
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

const baseName = (folder: string): string => folder.split(/[\\/]/).pop() ?? 'x'

/**
 * 分组断言用：包一层 **store 的 `assignCategory`**。
 *
 * ⚠️ 不能拿 `window.modvault.assignCategory` 数分组——那是**单资产**级 IPC，
 * `store.assignCategory(ids,…)` 内部会为每个资产调一次。要验证"3 个资产只调一次
 * `assignCategory`"，必须看 store 层这一层。
 */
let assignSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  order.length = 0
  backupStore.clear()
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.pruneThumbs.mockResolvedValue(0)
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
    notice: null,
    reclassifyBusy: false,
    reclassifyBackupCount: 0
  })
  // store 层分组计数（透传给真实实现，行为不变）
  const realAssign = useVault.getState().assignCategory
  assignSpy = vi.fn((ids: string[], category1: string, category2: string) =>
    realAssign(ids, category1, category2)
  )
  useVault.setState({ assignCategory: assignSpy as unknown as typeof realAssign })
})

const reclassBackups = (): IndexBackup[] =>
  [...backupStore.values()].filter((b) => b.id.startsWith('reclass-'))

describe('reclassifyUnclassified — 候选筛选', () => {
  it('只有「未分类/未分类」进候选；已分类的资产一个都不动', async () => {
    const unclassified = fixture({ name: '北欧沙发' })
    const classified = fixture({ name: '现代沙发', category1: '家具', category2: '沙发' })
    useVault.setState({ assets: [unclassified, classified] })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary).toEqual({ moved: 1, missed: 0, failed: 0 })
    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)
    expect(modvault.assignCategory.mock.calls[0]![0].folder).toBe(unclassified.folder)
    // 已分类资产的原路径没被碰过
    expect(modvault.assignCategory.mock.calls.map((c) => c[0].folder)).not.toContain(
      classified.folder
    )
  })

  it('候选为 0 → 不发任何 IPC、不写备份、不写库，只给一句 notice', async () => {
    useVault.setState({
      assets: [fixture({ category1: '家具', category2: '沙发', name: '北欧沙发' })]
    })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary).toEqual({ moved: 0, missed: 0, failed: 0 })
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(fakeBackups.put).not.toHaveBeenCalled()
    expect(fakeAssets.bulkPut).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBe('没有需要重新分类的资产')
  })
})

describe('reclassifyUnclassified — 分组与未命中', () => {
  it('3 个资产落到同一分类对 → assignCategory 只调一次，参数是 3 个 id', async () => {
    const a = fixture({ name: '北欧沙发' })
    const b = fixture({ name: '现代沙发' })
    const c = fixture({ name: '简约沙发' })
    useVault.setState({ assets: [a, b, c] })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary.moved).toBe(3)
    // 分组生效：store 层 assignCategory 只被调一次，一条 payload 带 3 个 id
    expect(assignSpy).toHaveBeenCalledTimes(1)
    const [ids, c1, c2] = assignSpy.mock.calls[0] as [string[], string, string]
    expect(c1).toBe('家具')
    expect(c2).toBe('沙发')
    expect([...ids].sort()).toEqual([a.id, b.id, c.id].sort())
    // 落库条数与三个 id 一致
    const saved = bulkPutCalls.flat()
    expect(saved.map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort())
  })

  it('判不出来的计入 missed，且不产生任何移动/备份', async () => {
    const hit = fixture({ name: '北欧沙发' })
    const miss = fixture({ name: '完全无关节西' })
    useVault.setState({ assets: [hit, miss] })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary).toEqual({ moved: 1, missed: 1, failed: 0 })
    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)
    // 备份里只出现被判中的那个（missed 不备份、不移动）
    const records = JSON.parse(reclassBackups()[0]!.json) as Array<{ id: string }>
    expect(records.map((r) => r.id)).toEqual([hit.id])
  })

  it('一级回退命中（材质真实名）也算 moved：木纹/未分类 会真实搬目录', async () => {
    const a = fixture({
      name: '无堺黑色木纹ID_1151853396',
      kind: 'material',
      folder: 'E:\\Lib\\材质\\未分类\\未分类\\无堺黑色木纹ID_1151853396',
      relFolder: '材质/未分类/未分类/无堺黑色木纹ID_1151853396'
    })
    useVault.setState({ assets: [a] })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary).toEqual({ moved: 1, missed: 0, failed: 0 })
    const payload = modvault.assignCategory.mock.calls[0]![0]
    expect(payload.category1).toBe('木纹')
    expect(payload.category2).toBe('未分类')
    expect(payload.kindFolderName).toBe('材质')
  })
})

describe('reclassifyUnclassified — 备份（移动前写、只留 3 条）', () => {
  it('备份写入**早于**任何 assignCategory，且内容是完整还原凭证', async () => {
    const a = fixture({ name: '北欧沙发' })
    useVault.setState({ assets: [a] })

    await useVault.getState().reclassifyUnclassified()

    expect(order).toEqual(['backup', 'move'])
    const backup = reclassBackups()[0]!
    expect(backup.id.startsWith('reclass-')).toBe(true)
    expect(typeof backup.at).toBe('number')
    const records = JSON.parse(backup.json) as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: a.id,
      name: '北欧沙发',
      folder: a.folder,
      relFolder: a.relFolder,
      category1: '未分类',
      category2: '未分类'
    })
  })

  it('只保留最近 3 条 reclass-*（更早的被清掉，rescan-* 不受影响）', async () => {
    // 让每次备份拿到不同的 id（同毫秒会互相覆盖）
    let now = 1_800_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1))
    backupStore.set('rescan-1', { id: 'rescan-1', at: 1, json: '[]' })

    const createdIds: string[] = []
    try {
      for (let i = 0; i < 4; i += 1) {
        useVault.setState({ assets: [fixture({ name: '北欧沙发' })] })
        await useVault.getState().reclassifyUnclassified()
        const latest = reclassBackups()
          .map((b) => b.id)
          .filter((id) => !createdIds.includes(id))
        createdIds.push(...latest)
      }
    } finally {
      nowSpy.mockRestore()
    }

    const ids = reclassBackups().map((b) => b.id)
    expect(createdIds).toHaveLength(4) // 4 次 run 各写了一条
    expect(ids).toHaveLength(3) // 只留最近 3 条
    expect(ids).not.toContain(createdIds[0]) // 最早那条被清掉
    expect(backupStore.has('rescan-1')).toBe(true) // 别把重扫备份一起清了
  })
})

describe('undoLastReclassify — 按原分类搬回', () => {
  it('重跑后撤销：恢复原分类对，备份被消费掉', async () => {
    const a = fixture({ name: '北欧沙发' })
    const b = fixture({ name: '现代沙发' })
    useVault.setState({ assets: [a, b] })

    await useVault.getState().reclassifyUnclassified()
    expect(reclassBackups()).toHaveLength(1)
    modvault.assignCategory.mockClear()
    assignSpy.mockClear()
    order.length = 0

    const undo = await useVault.getState().undoLastReclassify()

    expect(undo).toEqual({ restored: 2, failed: 0 })
    // 两个资产原分类相同 → 一次 store 层 assignCategory（IPC 内部各调一次）
    expect(assignSpy).toHaveBeenCalledTimes(1)
    const [ids, c1, c2] = assignSpy.mock.calls[0] as [string[], string, string]
    expect(c1).toBe('未分类')
    expect(c2).toBe('未分类')
    expect(ids).toHaveLength(2)
    // 备份被消费
    expect(reclassBackups()).toHaveLength(0)
    expect(useVault.getState().reclassifyBackupCount).toBe(0)
  })

  it('索引里已不存在的资产 → 计入 failed，不阻断其它资产还原', async () => {
    const a = fixture({ name: '北欧沙发' })
    const b = fixture({ name: '现代沙发' })
    useVault.setState({ assets: [a, b] })
    await useVault.getState().reclassifyUnclassified()

    // 模拟用户删掉了 b
    useVault.setState({ assets: useVault.getState().assets.filter((x) => x.id !== b.id) })
    modvault.assignCategory.mockClear()

    const undo = await useVault.getState().undoLastReclassify()

    expect(undo).toEqual({ restored: 1, failed: 1 })
    expect(modvault.assignCategory).toHaveBeenCalledTimes(1)
  })

  it('没有备份 → { restored: 0, failed: 0 }，不报错、不发 IPC', async () => {
    const undo = await useVault.getState().undoLastReclassify()
    expect(undo).toEqual({ restored: 0, failed: 0 })
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBe('没有可撤销的重跑记录')
  })
})

describe('reclassifyUnclassified — 并发与状态', () => {
  it('跑完复位 reclassifyBusy，并刷新可撤销备份条数', async () => {
    useVault.setState({ assets: [fixture({ name: '北欧沙发' })] })
    await useVault.getState().reclassifyUnclassified()

    expect(useVault.getState().reclassifyBusy).toBe(false)
    expect(useVault.getState().reclassifyBackupCount).toBe(1)
  })

  it('notice 汇总三个数字（移动 / 未识别 / 失败）', async () => {
    useVault.setState({
      assets: [fixture({ name: '北欧沙发' }), fixture({ name: '完全无关节西' })]
    })
    await useVault.getState().reclassifyUnclassified()
    expect(useVault.getState().notice).toBe('重跑分类：移动 1 / 未识别 1 / 失败 0')
  })
})

/**
 * 用户库当前 `未分类/未分类` 的**真实资产名**（2026-10-20 现场清点 8 个）。
 *
 * 这条用例把"用户点了重跑之后会发生什么"钉成可回归的事实：
 * - 2 个能判出来（模型 挂画 / 材质 木纹），会真实移动；
 * - 6 个仍判不出（英文名、拼音、`砖/混凝土/纹理` 无词条）→ 保持未分类，计入 `missed`。
 * 调 `docs/06` v1.0.13「未修清单」：这不是匹配规则的问题，是词表覆盖。
 */
describe('reclassifyUnclassified — 用户库 8 个未分类资产的真实结果', () => {
  it('移动 2 / 未识别 6 / 失败 0', async () => {
    const names: Array<[string, string]> = [
      ['侘寂挂画_挂画组合ID_1186414883', 'model'],
      ['无缝黑色木纹ID_1151853396', 'material'],
      ['现代红砖_外墙_墙砖ID_1193950340', 'material'],
      ['原木色原木清晰纹理贴图ID_1148779647', 'material'],
      ['Brick_Rough_vh1sbjl_2K_surface_ms', 'material'],
      ['dizhuan', 'material'],
      ['混凝土地面', 'material'],
      ['混凝土屋面', 'material']
    ]
    useVault.setState({
      assets: names.map(([name, kind]) =>
        fixture({
          name,
          kind: kind as Asset['kind'],
          folder: `E:\\Lib\\${kind === 'model' ? '模型' : '材质'}\\未分类\\未分类\\${name}`,
          relFolder: `${kind === 'model' ? '模型' : '材质'}/未分类/未分类/${name}`
        })
      )
    })

    const summary = await useVault.getState().reclassifyUnclassified()

    expect(summary).toEqual({ moved: 2, missed: 6, failed: 0 })
    // 命中的两个分别落到 模型/软装陈设/挂画 与 材质/木纹/未分类（一级回退，二级仍是哨兵）
    const payloads = modvault.assignCategory.mock.calls.map((c) => c[0] as AssignCategoryPayload)
    const pairs = payloads.map((p) => `${p.kindFolderName}/${p.category1}/${p.category2}`).sort()
    expect(pairs).toEqual(['模型/软装陈设/挂画', '材质/木纹/未分类'].sort())
  })
})
