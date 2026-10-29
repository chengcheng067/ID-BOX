/**
 * 整理浮层「`triageMode` 化」的接线守卫（docs/35 · T-09）。
 *
 * 六组（与派单的六条一一对应）：
 * ① `openTriage()` 行为**逐字不变**（空队列 → 不开 + 原文案；非空 → `unclassified`）；
 * ② `openReview()` 不通化成未分类（空 conflict + 有未分类 → 不开 + 新文案）；
 * ③ `closeTriage()` 清 `triageMode` 且 `triageActive === false`；
 * ④ `triageActive` 恒等于 `(triageMode !== null)`（任何时刻，含全量 setState 污染后）；
 * ⑤ 两个队列不串（3 conflict + 2 unclassified → 各自条数对）；
 * ⑥ `useReviewQueue` 与 `useTriageQueue` **同源**（含软删的混合数据，两边都滤掉）。
 *
 * ## 为什么第 ⑥ 条打的是 `triageQueueOf` 而不是 hook
 *
 * `vitest.config.ts` 是 `environment: 'node'`，仓库里没有 jsdom / react-test-renderer；
 * 而 zustand v4 在 SSR（`renderToStaticMarkup`）下走 `getServerSnapshot` → 返回**初始**
 * state，`setState` 之后的 `assets` 读不到（实测：`getState().assets.length === 2`，
 * 而 hook 里 `useVault((s) => s.assets)` 拿到 `[]`）。所以 hook 本体在现有设施下**没法真跑**。
 *
 * 退而求其次的正确做法是：把内核 `triageQueueOf` 导出，断言它的软删口径 —— 两个 hook
 * 都只是它的一行封装（`useTriageQueueOf('unclassified')` / `('conflict')`），
 * 外加一条源码守卫钉住"hook 里不许再出现第二个 `isDeletedAsset` / `sortAssets` 调用点"。
 * 这比"扫字符串说它调了 buildTriageQueue"强得多：真正的回归形态是**有人给某个 hook
 * 补了一句自己的过滤**，而那正是源码守卫里"调用点计数"能抓住的东西。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset } from '../src/shared/types'

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

const { activeTriageQueueOf, triageQueueOf, useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

/** 最小资产：分类 + 软删标记 + 体积（排序用） */
function asset(
  c1: string = UNCLASSIFIED,
  c2: string = UNCLASSIFIED,
  extra: Partial<Asset> = {}
): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `asset-${seq}`,
    kind: 'texture',
    category1: c1,
    category2: c2,
    folder: `E:/lib/材质/未分类/asset-${seq}`,
    relFolder: `材质/未分类/asset-${seq}`,
    files: [],
    size: 100 * seq,
    tags: [],
    colorTags: [],
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    ...extra
  } as Asset
}

/** 一条 `conflict` 资产（`reviewReasonOf` 判 conflict 的最小形态） */
function conflict(id: string, extra: Partial<Asset> = {}): Asset {
  return asset('工装空间', '办公空间', {
    id,
    name: id,
    classifyReview: { confidence: 'conflict', reason: 'conflict' },
    ...extra
  })
}

/** 一条双未分类资产 */
function unclassified(id: string, extra: Partial<Asset> = {}): Asset {
  return asset(UNCLASSIFIED, UNCLASSIFIED, { id, name: id, ...extra })
}

beforeEach(() => {
  seq = 0
  modvault.assignCategory.mockReset()
  useVault.setState({
    assets: [],
    filters: { ...useVault.getState().filters, sort: 'recent' },
    libraryView: 'assets',
    triageMode: null,
    triageActive: false,
    notice: null,
    selectedId: null,
    selectedIds: []
  })
})

// ── ① openTriage() 行为逐字不变 ──────────────────────────────────────

describe('① openTriage() · P2 既有行为一个字节不改', () => {
  it('★空队列：不开浮层 + 原文案「没有未分类的资产」', () => {
    useVault.setState({ assets: [asset('椅子', '餐椅')] })
    expect(useVault.getState().openTriage()).toBe(false)
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
    // 文案逐个字符钉住：用户已经熟悉这句，改一个字都算回归
    expect(useVault.getState().notice).toBe('没有未分类的资产')
  })

  it('★有未分类：开浮层 → triageMode === unclassified + 焦点落第一张', () => {
    const a = unclassified('u1')
    useVault.setState({ assets: [a] })
    expect(useVault.getState().openTriage()).toBe(true)
    expect(useVault.getState().triageMode).toBe('unclassified')
    expect(useVault.getState().triageActive).toBe(true)
    expect(useVault.getState().selectedId).toBe(a.id)
    expect(useVault.getState().selectedIds).toEqual([a.id])
  })

  it('★软删资产不进队列（全软删 = 空集 = 不开 + 原文案）', () => {
    useVault.setState({ assets: [unclassified('u1', { deletedAt: 1_700_000_000_000 })] })
    expect(useVault.getState().openTriage()).toBe(false)
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().notice).toBe('没有未分类的资产')
  })

  it('★同一模式已开着 → 不重开会话（不重置选中、不换模式）', () => {
    useVault.setState({
      assets: [unclassified('u1')],
      ...{ triageMode: 'unclassified' as const, triageActive: true },
      selectedId: 'keep-me'
    })
    expect(useVault.getState().openTriage()).toBe(true)
    expect(useVault.getState().selectedId).toBe('keep-me')
    expect(useVault.getState().triageMode).toBe('unclassified')
  })

  it('★不改 libraryView / filters（用户还在原视图里）', () => {
    const before = useVault.getState().filters
    useVault.setState({ assets: [unclassified('u1')], libraryView: 'trash' })
    useVault.getState().openTriage()
    expect(useVault.getState().libraryView).toBe('trash')
    expect(useVault.getState().filters).toBe(before)
  })

  it('显式传 mode 时与默认值等价（openTriage() === openTriage("unclassified")）', () => {
    useVault.setState({ assets: [unclassified('u1')] })
    expect(useVault.getState().openTriage('unclassified')).toBe(true)
    expect(useVault.getState().triageMode).toBe('unclassified')
  })
})

// ── ② openReview() 绝不退化成未分类 ──────────────────────────────────

describe('② openReview() · 空 conflict 时不通化', () => {
  it('★conflict 队列非空 → triageMode === conflict', () => {
    const c = conflict('c1')
    useVault.setState({ assets: [c] })
    expect(useVault.getState().openReview()).toBe(true)
    expect(useVault.getState().triageMode).toBe('conflict')
    expect(useVault.getState().triageActive).toBe(true)
    expect(useVault.getState().selectedId).toBe(c.id)
  })

  it('★conflict 队列空但 unclassified 非空 → **不开浮层** + 待确认文案', () => {
    // 这是本卡最容易写错的一条：如果 openReview 空集时退化成"有别的可处理就开"
    // 或干脆调 openTriage()，用户点"待确认"会看到一批从没分过类的资产，
    // 会以为"存疑"指的是没分类，而库里其实一条 conflict 都没有。
    useVault.setState({ assets: [unclassified('u1'), unclassified('u2')] })
    expect(useVault.getState().openReview()).toBe(false)
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
    expect(useVault.getState().notice).toBe('目前没有待确认的素材')
  })

  it('★两种文案不同（不能复用未分类那句）', () => {
    useVault.setState({ assets: [] })
    useVault.getState().openTriage()
    const triageNotice = useVault.getState().notice
    useVault.setState({ notice: null })
    useVault.getState().openReview()
    const reviewNotice = useVault.getState().notice
    expect(triageNotice).toBe('没有未分类的资产')
    expect(reviewNotice).toBe('目前没有待确认的素材')
    expect(reviewNotice).not.toBe(triageNotice)
  })

  it('★已定案的 conflict 不进队列（空集 → 不开）', () => {
    useVault.setState({
      assets: [
        asset('工装空间', '办公空间', {
          classifyReview: {
            confidence: 'conflict',
            reason: 'conflict',
            decidedAt: 1_712_000_000_000
          }
        })
      ]
    })
    expect(useVault.getState().openReview()).toBe(false)
    expect(useVault.getState().notice).toBe('目前没有待确认的素材')
  })

  it('已开着未分类时点待确认（conflict 为空）→ 不动原浮层，只给文案', () => {
    // 用户正在整理未分类，顺手点了侧栏「待确认」：不能把他踢出当前会话。
    useVault.setState({
      assets: [unclassified('u1')],
      ...{ triageMode: 'unclassified' as const, triageActive: true },
      selectedId: 'u1'
    })
    expect(useVault.getState().openReview()).toBe(false)
    expect(useVault.getState().triageMode).toBe('unclassified')
    expect(useVault.getState().triageActive).toBe(true)
    expect(useVault.getState().selectedId).toBe('u1')
    expect(useVault.getState().notice).toBe('目前没有待确认的素材')
  })
})

// ── ③ closeTriage() ─────────────────────────────────────────────────

describe('③ closeTriage() · 只撤标志', () => {
  it('★清 triageMode，且 triageActive === false', () => {
    useVault.setState({ assets: [conflict('c1')] })
    useVault.getState().openReview()
    expect(useVault.getState().triageMode).toBe('conflict')
    useVault.getState().closeTriage()
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
  })

  it('★不清选中（保留"最后整理的那张"）', () => {
    useVault.setState({ assets: [unclassified('u1')] })
    useVault.getState().openTriage()
    const kept = useVault.getState().selectedId
    useVault.getState().closeTriage()
    expect(useVault.getState().selectedId).toBe(kept)
    expect(useVault.getState().selectedIds).toEqual([kept])
  })

  it('★未开启时调 close 也不炸（幂等）', () => {
    useVault.getState().closeTriage()
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
  })

  it('★切视图（唯一显式清理站点）把两个字段一起清', () => {
    useVault.setState({ assets: [conflict('c1')] })
    useVault.getState().openReview()
    useVault.getState().setLibraryView('trash')
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
  })
})

// ── ④ triageActive 是 triageMode 的派生值 ────────────────────────────

describe('④ triageActive === (triageMode !== null)', () => {
  /** 从当前 store 读这一对 */
  const pair = (): { mode: string | null; active: boolean } => {
    const st = useVault.getState()
    return { mode: st.triageMode, active: st.triageActive }
  }

  it('★开 / 关 / 切视图 / 换模式，四种转移后都满足等式', () => {
    useVault.setState({ assets: [unclassified('u1'), conflict('c1')] })
    const check = (): void => {
      const { mode, active } = pair()
      expect(active).toBe(mode !== null)
    }

    check()
    useVault.getState().openTriage()
    check()
    useVault.getState().openReview() // 未分类 → 待确认（换模式）
    check()
    useVault.getState().closeTriage()
    check()
    useVault.getState().openReview()
    check()
    useVault.getState().setLibraryView('trash')
    check()
  })

  it('★两个字段由同一个写入口产出（初始值也满足等式）', () => {
    // 初始 state 是最容易漏的一处：只给 triageActive 不写 triageMode 就会得到
    // `{ triageMode: undefined, triageActive: false }` —— 等式仍成立，但字段缺失，
    // `Record<TriageMode, string>` 查表在运行时会拿到 undefined。
    const st = useVault.getState()
    expect(st.triageMode).toBeNull()
    expect(st.triageActive).toBe(false)
  })

  it('★全量 setState 污染（前端只给 triageActive）后，openTriage 仍能自愈成一致', () => {
    // 模拟"某个外部代码只写了 triageActive"这种脏状态（不该发生，但测试 / 调试会造）：
    // openTriage 以 `triageActive + triageMode` 组合判断当前模式，triageMode 缺失时
    // 按 unclassified 兜底 —— 于是它认为"已开着未分类"，不会重置用户会话。
    useVault.setState({ assets: [unclassified('u1')], triageActive: true, triageMode: null })
    expect(useVault.getState().openTriage()).toBe(true)
    // 兜底不写脏值回来（仍然 triageMode === null 但被视为 unclassified 会话），
    // 只要用户关一次就回到干净状态
    useVault.getState().closeTriage()
    expect(useVault.getState().triageMode).toBeNull()
    expect(useVault.getState().triageActive).toBe(false)
  })
})

// ── ⑤ 两个队列不串 ──────────────────────────────────────────────────

describe('⑤ 两个队列各管各的', () => {
  it('★3 conflict + 2 unclassified：openTriage 后 2 条，openReview 后 3 条', () => {
    const assets = [
      conflict('c1'),
      unclassified('u1'),
      conflict('c2'),
      unclassified('u2'),
      conflict('c3')
    ]
    useVault.setState({ assets })

    // 从 store 的入口进去（不是直接调 triageQueueOf）：入口与 hook 同源，
    // 所以"入口能开"就等价于"hook 会渲非空"。条数用 triageQueueOf 精确断言。
    useVault.setState({ triageMode: null, triageActive: false })
    expect(useVault.getState().openTriage()).toBe(true)
    expect(useVault.getState().triageMode).toBe('unclassified')
    expect(
      triageQueueOf(assets, useVault.getState().filters.sort, 'unclassified', 'all')
    ).toHaveLength(2)

    useVault.setState({ triageMode: null, triageActive: false })
    expect(useVault.getState().openReview()).toBe(true)
    expect(useVault.getState().triageMode).toBe('conflict')
    expect(triageQueueOf(assets, useVault.getState().filters.sort, 'conflict', 'all')).toHaveLength(3)
  })

  it('★同一条资产不会同时出现在两个队列（互斥）', () => {
    const assets = [conflict('c1'), unclassified('u1'), asset('椅子', '餐椅')]
    const sort = useVault.getState().filters.sort
    const a = triageQueueOf(assets, sort, 'unclassified', 'all').map((x) => x.id)
    const b = triageQueueOf(assets, sort, 'conflict', 'all').map((x) => x.id)
    expect(a).toEqual(['u1'])
    expect(b).toEqual(['c1'])
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })

  it('★浮层已开时切模式：模式跟着换，但队列换成新那批（不重开会话）', () => {
    useVault.setState({ assets: [conflict('c1'), unclassified('u1')] })
    useVault.getState().openTriage()
    expect(useVault.getState().triageMode).toBe('unclassified')
    // 点侧栏「待确认」→ 直接换模式（不先关再开，避免闪一次 + 两条收尾提示）
    expect(useVault.getState().openReview()).toBe(true)
    expect(useVault.getState().triageMode).toBe('conflict')
    expect(useVault.getState().triageActive).toBe(true)
    // 焦点落到**新队列**第一张
    expect(useVault.getState().selectedId).toBe('c1')
  })
})

// ── ⑥ 同源：软删口径一致 ────────────────────────────────────────────

describe('⑥ 两个队列同源（软删 / 排序 / 全库口径）', () => {
  it('★含软删的混合数据：两个模式的队列都滤掉软删记录', () => {
    const assets = [
      conflict('c1'),
      conflict('c-deleted', { deletedAt: 1_700_000_000_000 }),
      unclassified('u1'),
      unclassified('u-deleted', { deletedAt: 1_700_000_000_001 })
    ]
    const sort = 'recent'
    expect(triageQueueOf(assets, sort, 'conflict', 'all').map((a) => a.id)).toEqual(['c1'])
    expect(triageQueueOf(assets, sort, 'unclassified', 'all').map((a) => a.id)).toEqual(['u1'])
  })

  it('★排序跟随传入的 sort（两种模式都不自己另排）', () => {
    // 名字反过来：a-z 升序时 zzz 在最后，size 降序时 zzz（size 最大）在最前
    const assets = [
      unclassified('aaa', { size: 1 }),
      unclassified('zzz', { size: 9 }),
      conflict('ccc', { size: 5, name: 'ccc' }),
      conflict('mmm', { size: 7, name: 'mmm' })
    ]
    expect(triageQueueOf(assets, 'name', 'unclassified', 'all').map((a) => a.id)).toEqual(['aaa', 'zzz'])
    expect(triageQueueOf(assets, 'name', 'conflict', 'all').map((a) => a.id)).toEqual(['ccc', 'mmm'])
    expect(triageQueueOf(assets, 'size', 'unclassified', 'all').map((a) => a.id)).toEqual(['zzz', 'aaa'])
    expect(triageQueueOf(assets, 'size', 'conflict', 'all').map((a) => a.id)).toEqual(['mmm', 'ccc'])
  })

  it('★源码守卫：两个 hook 只是 triageQueueOf 的一行封装（不许各写一遍过滤）', () => {
    const SRC = fs.readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf-8')

    // 只剥行注释与块注释 —— `isDeletedAsset` / `sortAssets` 在注释里被反复提到
    // （说明"唯一实现点"这件事），那是说明文字不是代码。
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    // ① 两个 hook 都存在且都只是一行转调。
    //    用正则而不是 `toContain` 多行字面量：本仓检出的工作区是 CRLF（git autocrlf），
    //    换行符不是契约的一部分，断言不该因为编辑器换行设置而红。
    expect(code).toMatch(
      /export function useTriageQueue\(\): Asset\[\] \{\s*return useTriageQueueOf\('unclassified'\)\s*\}/
    )
    expect(code).toMatch(
      /export function useReviewQueue\(\): Asset\[\] \{\s*return useTriageQueueOf\('conflict'\)\s*\}/
    )
    // `useActiveTriageQueue` 也不许自己写过滤：它只把 state 里的 mode 交给 `useTriageQueueOf`
    expect(code).toMatch(
      /export function useActiveTriageQueue\(\): Asset\[\] \{\s*const mode = useVault\(\(s\) => s\.triageMode\)\s*return useTriageQueueOf\(mode\)\s*\}/
    )

    // ② 软删过滤在**整个文件**里只出现在 triageQueueOf 内（其余是删除/回收站等
    //    不相关的调用点，所以这里数的是"队列口径"那一段）
    const at = code.indexOf('export function triageQueueOf(')
    expect(at).toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('\n}', at))
    expect(body).toContain('isDeletedAsset')
    expect(body).toContain('sortAssets')
    expect(body).toContain('buildTriageQueue')
    expect(body).toContain('buildReviewQueue')
  })
})

// ── ⑦ useActiveTriageQueue 的内核：按模式自动选队列 ─────────────────

describe('⑦ activeTriageQueueOf · 浮层用一个 hook 按模式取队列', () => {
  const assets = [
    unclassified('u1'),
    conflict('c1'),
    unclassified('u-deleted', { deletedAt: 1_700_000_000_000 }),
    conflict('c2')
  ]

  it('★triageMode === null（浮层没开）→ 空队列', () => {
    // 浮层没开就不该有队列，也不该让 `startTriage` 拿到一批数据去初始化游标。
    expect(activeTriageQueueOf(assets, 'recent', null, 'all')).toEqual([])
  })

  it('★null 时返回**同一个**空数组引用（每次新造 [] 会让 effect 每次重跑）', () => {
    // `TriageOverlay` 的 `reconcileTriage(cursor, queue)` 与若干 useEffect 依赖 queue；
    // 每次 render 换一个新 [] 就是每次重跑，轻则白烧 CPU，重则 setCursor → 重渲 → 死循环。
    const a = activeTriageQueueOf(assets, 'recent', null, 'all')
    const b = activeTriageQueueOf([], 'name', null, 'all')
    expect(a).toBe(b)
  })

  it('★unclassified → 未分类那批（软删已滤）', () => {
    expect(activeTriageQueueOf(assets, 'recent', 'unclassified', 'all').map((x) => x.id)).toEqual([
      'u1'
    ])
  })

  it('★conflict → 待确认那批（软删已滤）', () => {
    expect(activeTriageQueueOf(assets, 'recent', 'conflict', 'all').map((x) => x.id)).toEqual([
      'c1',
      'c2'
    ])
  })

  it('★模式切换时返回对应队列（同一份数据，两种模式互不污染）', () => {
    // 这是 `TriageOverlay` 的实际用法：模式一变，同一个 hook 就该给出另一批。
    const modes = ['unclassified', 'conflict', 'unclassified'] as const
    const seen = modes.map((m) => activeTriageQueueOf(assets, 'recent', m, 'all').map((x) => x.id))
    expect(seen).toEqual([['u1'], ['c1', 'c2'], ['u1']])
  })

  it('与 triageQueueOf 逐字节同源（不是第二份实现）', () => {
    const sort = 'size'
    expect(activeTriageQueueOf(assets, sort, 'conflict', 'all').map((x) => x.id)).toEqual(
      triageQueueOf(assets, sort, 'conflict', 'all').map((x) => x.id)
    )
    expect(activeTriageQueueOf(assets, sort, 'unclassified', 'all').map((x) => x.id)).toEqual(
      triageQueueOf(assets, sort, 'unclassified', 'all').map((x) => x.id)
    )
  })
})
