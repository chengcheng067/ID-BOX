/// <reference lib="dom" />
// ↑ 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type {
  Asset,
  AssignCategoryPayload,
  AssignCategoryResult,
  RendererLogPayload
} from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'

/**
 * `store.assignCategory` 的**事务性**验收（2026-11「崩溃半径压到单条」）。
 *
 * 与 `kindMigrateStore.test.ts` / `assignUndo.test.ts` 同一套做法：不抽逻辑、不改实现，
 * 只把两个边界打桩 —— ① `window.modvault`（IPC 桥）→ vi.fn；② `db`（Dexie）→ 内存假 Table。
 * 于是这里驱动的是**实际发布的 `store.assignCategory()`**。
 *
 * ## 本文件钉的到底是什么
 *
 * 改动前的形状是「磁盘逐条搬（每条一次 `await` IPC）+ 库整批写一次（循环后 `bulkPut`）」，
 * 于是"搬完 5 条、第 6 条炸了"会留下 **磁盘全搬了、库一条没写** → 5 条记录指向已消失的
 * 旧路径（重启后表现为「文件丢失」）。三条断言对应三个不变式：
 *
 * | # | 不变式 |
 * | --- | --- |
 * | ① | 库**逐条**写：N 条成功 = N 次 `put`，`bulkPut` **一次都不能**出现 |
 * | ② | `put` 失败必须补偿：要么磁盘搬回来（记录不动），要么记录跟磁盘走（commit），**没有第三种结局** |
 * | ③ | 内存态只合并一次（循环结束后 `byId`），不是逐条 `set`（否则 200 条批量 = 200 次 re-render） |
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  assignCategory: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  deleteOneThumb: vi.fn(),
  reportLog: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

/**
 * 内存假库。
 * - `records` = **库里真实存在的行**（只有写成功才进去）。断言"库是什么样"就看它，
 *   这样"写失败"与"没写"天然区分开 —— 直接数 `put` 调用次数是看不出来的。
 * - `putSeq` 自己数调用序号：`putFails(序号)` 决定第几次抛错（`mock.calls.length`
 *   在实现内部读到的是"已记录"还是"本次"取决于 vitest 版本，不赌）。
 */
const records = new Map<string, Asset>()
let putSeq = 0
/** 第 N 次 `db.assets.put`（1 起）是否失败 —— 每个用例自己设 */
let putFails: (call: number, asset: Asset) => boolean = () => false

const fakeAssets = {
  put: vi.fn(async (a: Asset) => {
    putSeq += 1
    if (putFails(putSeq, a)) throw new Error(`idb dead #${putSeq}`)
    records.set(a.id, { ...a })
    return a.id
  }),
  // 本次改动的核心断言是"它一次都不会被调用"。实现照写，万一被调用，
  // `records` 会跟着变 → 后面的"库/盘一致"断言会立刻红，不会静默通过。
  bulkPut: vi.fn(async (list: Asset[]) => {
    for (const a of list) records.set(a.id, { ...a })
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ─────────────────────────────────────────────────────────────

let seq = 0

/** 一条"空分类"的模型资产：folder 与 relFolder 严格对应，方便往返断言 */
function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const name = over.name ?? `资产${n}`
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\${name}`,
    relFolder: `模型/未分类/未分类/${name}`,
    files: [{ rel: `${name}.skp`, name: `${name}.skp`, ext: 'skp', size: 20, kind: 'model' }],
    size: 20,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${name}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: UNCLASSIFIED,
    category2: UNCLASSIFIED,
    ...over
  }
}

const TARGET1 = '家具'
const TARGET2 = '椅子'

/** 目标目录的绝对路径（与 fixture 的 `E:\Lib\<大类>\<一级>\<二级>\<名>` 完全同构） */
function targetFolder(a: Asset): string {
  return `E:\\Lib\\模型\\${TARGET1}\\${TARGET2}\\${a.name}`
}

/**
 * 模拟 main 的 `moveAssetCategory` 回包：按 payload 算出落盘后的绝对路径 / relFolder。
 *
 * 因为 fixture 与它同构（`E:\Lib\<大类>\<一级>\<二级>\<名>`），**正向再反向一拍就回到原值**
 * —— 这正是"反向搬回不会撞名"的前提（目标路径刚被腾空）。
 */
function movedTo(p: AssignCategoryPayload): AssignCategoryResult {
  const name = p.folder.split('\\').pop() ?? '资产'
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

/** 预置"库里的存量行"（不动 put 计数） */
function seedDb(list: Asset[]): void {
  for (const a of list) records.set(a.id, { ...a })
}

/** 内存态里某条资产的 folder */
function memFolder(id: string): string | undefined {
  return useVault.getState().assets.find((a) => a.id === id)?.folder
}

/** 内存态里某条资产的分类对 */
function memPair(id: string): { c1: string; c2: string } | undefined {
  const a = useVault.getState().assets.find((x) => x.id === id)
  return a ? { c1: a.category1 ?? '', c2: a.category2 ?? '' } : undefined
}

/** 已落的 error 日志 message 列表 */
function reportMessages(): string[] {
  return modvault.reportLog.mock.calls.map((c) => (c[0] as RendererLogPayload).message)
}

/** IPC 载荷的简写（断言用） */
function payloadOf(callIndex: number): AssignCategoryPayload {
  return modvault.assignCategory.mock.calls[callIndex]![0] as AssignCategoryPayload
}

beforeEach(() => {
  records.clear()
  putSeq = 0
  putFails = () => false
  vi.clearAllMocks()
  modvault.assignCategory.mockReset()
  modvault.ensureThumb.mockResolvedValue('thumb-new.jpg')
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.deleteOneThumb.mockResolvedValue(true)
  useVault.setState({
    assets: [],
    notice: null,
    selectedId: null,
    selectedIds: [],
    pendingAssign: null,
    pendingDelete: null
  })
})

afterEach(() => {
  putFails = () => false
  // 跨全部用例的硬约束：整批 `bulkPut` 不许再出现在这条路径上
  expect(fakeAssets.bulkPut).not.toHaveBeenCalled()
})

// ── ① 正常路径：逐条落库 ──────────────────────────────────────────────

describe('逐条落库：3 条成功 = 3 次 put，bulkPut 一次都没有', () => {
  it('★核心断言：put×3 / bulkPut×0 / moved=3，库与内存全在新路径', async () => {
    const a = fixture({ cover: '预览图.jpg', coverSource: 'named', thumbPath: 'old.jpg', thumbStatus: 'ready' })
    const b = fixture()
    const c = fixture()
    const all = [a, b, c]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => movedTo(p))

    const summary = await useVault.getState().assignCategory([a.id, b.id, c.id], TARGET1, TARGET2)

    expect(summary).toEqual({ moved: 3, renamed: 0, failed: 0, skipped: 0, changed: false })

    // ★ 本段最重要的一条：库是**逐条**写的，不是循环结束后一次 bulkPut
    expect(fakeAssets.put).toHaveBeenCalledTimes(3)
    expect(fakeAssets.bulkPut).not.toHaveBeenCalled()

    // IPC 一次一条，分类与父目录（由 kind 算）都对
    expect(modvault.assignCategory).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 3; i += 1) {
      expect(payloadOf(i)).toEqual({
        folder: all[i]!.folder,
        kindFolderName: '模型',
        category1: TARGET1,
        category2: TARGET2
      })
    }

    // 库：三条全在新路径，用户字段一个不丢
    for (const x of all) {
      const row = records.get(x.id)!
      expect(row.folder).toBe(targetFolder(x))
      expect(row.relFolder).toBe(`模型/${TARGET1}/${TARGET2}/${x.name}`)
      expect(row.category1).toBe(TARGET1)
      expect(row.category2).toBe(TARGET2)
      expect(row.files).toEqual(x.files)
      expect(row.size).toBe(20)
      // 名字没变（没撞名）→ dedupeKey 不变
      expect(row.dedupeKey).toBe(x.dedupeKey)
    }
    // RA3：带封面的那条缩略图重生（先生成新再删旧），没封面的保持原值
    expect(records.get(a.id)!.thumbPath).toBe('thumb-new.jpg')
    expect(records.get(a.id)!.thumbStatus).toBe('ready')
    expect(records.get(b.id)!.thumbPath).toBeUndefined()

    // 内存：三条同样在新路径
    for (const x of all) expect(memFolder(x.id)).toBe(targetFolder(x))

    expect(useVault.getState().notice).toContain(`已移动 3 个资产到「${TARGET1} / ${TARGET2}」`)
  })

  it('内存态只合并**一次**（逐条 set 会让 200 条批量触发 200 次 re-render）', async () => {
    const all = [fixture(), fixture(), fixture(), fixture()]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => movedTo(p))

    let assetsSwaps = 0
    const unsub = useVault.subscribe((s, prev) => {
      if (s.assets !== prev.assets) assetsSwaps += 1
    })
    await useVault.getState().assignCategory(all.map((x) => x.id), TARGET1, TARGET2)
    unsub()

    // 4 条改动只换来 1 次 assets 引用替换（库逐条写、视图一次性刷新）
    expect(assetsSwaps).toBe(1)
    for (const x of all) expect(memFolder(x.id)).toBe(targetFolder(x))
  })
})

// ── ② 写库失败 + 反向搬回成功 → 完全回滚 ─────────────────────────────

describe('put 抛错 · 反向搬回成功', () => {
  it('★该条彻底回滚：库与内存都是旧路径，moved=2 / failed=1，后续条目继续处理', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    const all = [a, b, c]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => movedTo(p))
    // 第 2 次 put（= b 的提交）失败；第 3 次是**回滚记录**的 put，必须让它成功
    putFails = (n) => n === 2

    const summary = await useVault.getState().assignCategory([a.id, b.id, c.id], TARGET1, TARGET2)

    expect(summary).toMatchObject({ moved: 2, failed: 1, skipped: 0 })

    // put：a 成功 → b 失败 → b 回滚记录成功 → c 成功
    expect(fakeAssets.put).toHaveBeenCalledTimes(4)

    // 反向只发 1 次，且**从新位置搬回原分类**（folder 用盘上的现值，分类用原值）
    // 调用序：a 正向(0) → b 正向(1) → b 反向(2) → c 正向(3)
    expect(modvault.assignCategory).toHaveBeenCalledTimes(4)
    expect(payloadOf(2)).toEqual({
      folder: targetFolder(b),
      kindFolderName: '模型',
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })

    // 库：b 仍是旧路径 / 旧分类（回滚记录把库拉回来了）
    const rowB = records.get(b.id)!
    expect(rowB.folder).toBe(b.folder)
    expect(rowB.relFolder).toBe(b.relFolder)
    expect(rowB.category1).toBe(UNCLASSIFIED)
    expect(rowB.category2).toBe(UNCLASSIFIED)
    // 回滚是"恢复原状"：名字没变 → dedupeKey 与缩略图沿用原值
    expect(rowB.dedupeKey).toBe(b.dedupeKey)
    expect(rowB.thumbPath).toBeUndefined()

    // 内存：b 也是旧值（与库、与盘三方一致）
    expect(memFolder(b.id)).toBe(b.folder)
    expect(memPair(b.id)).toEqual({ c1: UNCLASSIFIED, c2: UNCLASSIFIED })

    // 另外两条照常提交（一次写库失败不该拖累别人）
    expect(records.get(a.id)!.folder).toBe(targetFolder(a))
    expect(records.get(c.id)!.folder).toBe(targetFolder(c))
    expect(memFolder(c.id)).toBe(targetFolder(c))
    expect(memFolder(a.id)).toBe(targetFolder(a))

    // 完全回滚 = 没有需要事后取证的残留状态 → 不落 error 日志
    expect(reportMessages()).toEqual([])
  })
})

// ── ③ 写库失败 + 反向搬不回来 → 记录跟着磁盘走 ───────────────────────

describe('put 抛错 · 反向也失败', () => {
  it('★内存态必须反映磁盘（新路径），即使库没写成；moved=2 / failed=1 并落日志', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    const all = [a, b, c]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })
    // 正向成功；反向（把 b 搬回「未分类」）返回 null = 搬不回来
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) =>
      p.category1 === UNCLASSIFIED ? null : movedTo(p)
    )
    putFails = (n) => n === 2

    const summary = await useVault.getState().assignCategory([a.id, b.id, c.id], TARGET1, TARGET2)

    // b 是"记录跟着磁盘走"：计入 moved（内存态已改），同时计入 failed
    expect(summary).toMatchObject({ moved: 2, failed: 1, skipped: 0 })

    // a 正向 + b 正向 + b 反向 = 3 次；c **没被处理**（补偿失败 → 中断整批）
    expect(modvault.assignCategory).toHaveBeenCalledTimes(3)
    expect(fakeAssets.put).toHaveBeenCalledTimes(2)

    // 内存：b 在新路径（点开能找到文件），分类也已是目标分类
    expect(memFolder(b.id)).toBe(targetFolder(b))
    expect(memPair(b.id)).toEqual({ c1: TARGET1, c2: TARGET2 })
    // 库：b 仍是旧行（改不动），这条不一致由 error 日志留痕
    expect(records.get(b.id)!.folder).toBe(b.folder)

    // c 完全没碰：库与内存都还是旧路径
    expect(records.get(c.id)!.folder).toBe(c.folder)
    expect(memFolder(c.id)).toBe(c.folder)

    expect(reportMessages()).toEqual(['assign:rollback-move-failed'])
    const ctx = (modvault.reportLog.mock.calls[0]![0] as RendererLogPayload).context!
    expect(ctx).toMatchObject({ id: b.id, folder: targetFolder(b), fromFolder: b.folder })
    expect((modvault.reportLog.mock.calls[0]![0] as RendererLogPayload).level).toBe('error')
  })
})

// ── ④ 崩溃模拟：库彻底写不进去 ────────────────────────────────────────

describe('崩溃模拟 · put 从第 2 条起全部抛错', () => {
  /**
   * 选 **break**（中断整批）而不是 continue，理由：
   *
   * 一次写库失败 + 回滚成功 = 数据已复原，继续搬后面的完全安全（上一段就是这么做的）。
   * 但"回滚记录也写不进去"说明**库本身**在这一刻不可用（配额满 / 索引损坏 / 事务 blocked）；
   * 此时继续搬后面每一条只会重复"搬盘 → 写库失败 → 再搬回来"的空转，且每次空转都留下
   * 一个窗口 —— 盘在动、库不动。中断让已经处理过的每一条都停在自洽状态，代价只是这一批
   * 少搬几条（用户重试即可）。
   */
  it('★第 3 条不再处理，且库/内存/盘三方逐条自洽：处理过的在新路径、没动的在旧路径', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    const all = [a, b, c]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })
    modvault.assignCategory.mockImplementation(async (p: AssignCategoryPayload) => movedTo(p))
    // 第 1 次（a）成功；第 2 次（b）失败；第 3 次是 b 的回滚记录 put，同样失败
    putFails = (n) => n >= 2

    const summary = await useVault.getState().assignCategory([a.id, b.id, c.id], TARGET1, TARGET2)

    expect(summary).toMatchObject({ moved: 1, failed: 1, skipped: 0 })

    // a 正向 + b 正向 + b 反向 = 3 次；c 一次都没有（已中断）
    expect(modvault.assignCategory).toHaveBeenCalledTimes(3)
    expect(payloadOf(0).folder).toBe(a.folder)
    expect(payloadOf(1).folder).toBe(b.folder)
    expect(payloadOf(2).folder).toBe(targetFolder(b))

    // 逐条自洽（不存在"库在新、内存在旧"或反过来的中间态）
    // a：提交成功 → 库与内存都在新路径
    expect(records.get(a.id)!.folder).toBe(targetFolder(a))
    expect(memFolder(a.id)).toBe(targetFolder(a))
    // b：磁盘搬回原处、库保持旧行、内存没 push → 三方都是旧路径
    expect(records.get(b.id)!.folder).toBe(b.folder)
    expect(memFolder(b.id)).toBe(b.folder)
    // c：压根没处理 → 旧路径
    expect(records.get(c.id)!.folder).toBe(c.folder)
    expect(memFolder(c.id)).toBe(c.folder)

    expect(reportMessages()).toEqual(['assign:rollback-write-failed'])
    const ctx = (modvault.reportLog.mock.calls[0]![0] as RendererLogPayload).context!
    expect(ctx).toMatchObject({ id: b.id, folder: b.folder, movedFrom: targetFolder(b) })
  })
})

// ── ⑤ 静默出口：全部已在目标分类 ──────────────────────────────────────

describe('静默出口', () => {
  it('全部已在目标分类 → 不发 IPC、不写库、不 set、skipped=3', async () => {
    const all = [
      fixture({ category1: TARGET1, category2: TARGET2 }),
      fixture({ category1: TARGET1, category2: TARGET2 }),
      fixture({ category1: TARGET1, category2: TARGET2 })
    ]
    seedDb(all)
    useVault.setState({ assets: all, notice: null })

    const summary = await useVault.getState().assignCategory(
      all.map((x) => x.id),
      TARGET1,
      TARGET2
    )

    expect(summary).toEqual({ moved: 0, renamed: 0, failed: 0, skipped: 3, changed: false })
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(fakeAssets.put).not.toHaveBeenCalled()
    expect(fakeAssets.bulkPut).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBeNull()
    // 内存里的对象一个都没被换掉
    expect(useVault.getState().assets).toEqual(all)
  })

  it('targets 为空（id 全不匹配）→ 零副作用、summary 全 0', async () => {
    const a = fixture()
    seedDb([a])
    useVault.setState({ assets: [a], notice: null })

    const summary = await useVault.getState().assignCategory(['not-there'], TARGET1, TARGET2)

    expect(summary).toEqual({ moved: 0, renamed: 0, failed: 0, skipped: 0, changed: false })
    expect(modvault.assignCategory).not.toHaveBeenCalled()
    expect(fakeAssets.put).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toBeNull()
    expect(useVault.getState().assets).toEqual([a])
  })
})
