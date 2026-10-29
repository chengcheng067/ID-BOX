/**
 * `store.decideReview` —— 待确认浮层里的**定案**（T2，`docs/35 §5.1`）。
 *
 * ## 为什么这个用例必须真跑（不能只做源码守卫）
 *
 * 它守的是三个**语义判断**，源码扫字一个都证明不了：
 * ① `reason` 要**真删**（`'reason' in review === false`），不是置 `undefined`；
 * ② skipped（分类本来就对）**也要写** `decidedAt` —— 否则用户点了「用站方的」而 S2
 *    恰好等于当前分类时，队列长度纹丝不动，他会以为按钮坏了；
 * ③ failed **绝不写** —— 移动失败还标记已定案 = 这条永远停在待确认且不再重试。
 *
 * ## 桩的口径（与 `tests/triageWiring.test.ts` 同套路）
 *
 * store 依赖 Dexie 与 `window.modvault`，只桩那两个边界，其余全走真实代码。
 * `assignCategory` 的 IPC 返回值按用例注入：`null` = main 搬失败，对象 = 搬成功。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset } from '../src/shared/types'

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

const { useVault } = await import('../src/renderer/store')
const { reviewReasonOf, countPendingReview } = await import('../src/renderer/logic/reviewFlow')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

/** 一条 conflict 资产：有分类 + `classifyReview.reason='conflict'` + 两个站方源 */
function conflictAsset(extra: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `asset-${seq}`,
    kind: 'texture',
    category1: '工装空间',
    category2: '办公空间',
    folder: `E:/lib/材质/工装空间/办公空间/asset-${seq}`,
    relFolder: `材质/工装空间/办公空间/asset-${seq}`,
    files: [],
    size: 100 * seq,
    tags: [],
    colorTags: [],
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    classifyReview: {
      confidence: 'conflict',
      reason: 'conflict',
      sources: {
        s2: { level1: '建筑设计', level2: '规划设计', raw: ['建筑设计', '规划设计'], fromBaseName: false },
        s3: '办公室'
      }
    },
    ...extra
  } as Asset
}

/** main 侧搬成功的返回（形状见 preload 的 `assignCategory`） */
function moveOk(name: string, c1: string, c2: string) {
  return {
    folder: `E:/lib/材质/${c1}/${c2}/${name}`,
    relFolder: `材质/${c1}/${c2}/${name}`,
    name,
    category1: c1,
    category2: c2,
    renamed: false
  }
}

beforeEach(() => {
  seq = 0
  modvault.assignCategory.mockReset()
  fakeTable.put.mockClear()
  fakeTable.bulkPut.mockClear()
  useVault.setState({ assets: [], notice: null })
})

const live = (id: string): Asset => useVault.getState().assets.find((a) => a.id === id)!

// ── ① 真删 reason + 保留 sources ─────────────────────────────────────

describe('① 定案写入的形状', () => {
  it('★reason 字段**不存在**（不是 === undefined）；confidence=high、decidedAt 是数字', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '建筑设计', '规划设计'))

    const summary = await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(summary.moved).toBe(1)
    expect(summary.failed).toBe(0)

    const after = live(a.id)
    const review = after.classifyReview!
    // ① 真删：`in` 判据必须为 false。置 undefined 在本仓也能跑，但会进 Dexie / 日志 JSON，
    //    让"字段存在与否"这类判据得出反直觉答案。
    expect('reason' in review).toBe(false)
    expect(review.reason).toBeUndefined()
    expect(review.confidence).toBe('high')
    expect(typeof review.decidedAt).toBe('number')
    expect(Number.isFinite(review.decidedAt)).toBe(true)
  })

  it('★sources 原样保留（用户之后还能看"当初为什么存疑"）', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '建筑设计', '规划设计'))

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')

    const review = live(a.id).classifyReview!
    expect(review.sources?.s2).toEqual({
      level1: '建筑设计',
      level2: '规划设计',
      raw: ['建筑设计', '规划设计'],
      fromBaseName: false
    })
    expect(review.sources?.s3).toBe('办公室')
  })

  it('★真的出队：reviewReasonOf → null，countPendingReview.conflict 归零', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    expect(reviewReasonOf(a)).toBe('conflict')
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '建筑设计', '规划设计'))

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')

    const after = live(a.id)
    expect(reviewReasonOf(after)).toBeNull()
    expect(countPendingReview([after])).toEqual({ unclassified: 0, conflict: 0 })
  })

  it('★写库 + 同步内存各一次（不另造第二套落库路径）', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '建筑设计', '规划设计'))

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')

    // assignCategory 用 bulkPut（搬成功那条），decideReview 用 put（只改一行）
    expect(fakeTable.bulkPut).toHaveBeenCalledTimes(1)
    expect(fakeTable.put).toHaveBeenCalledTimes(1)
    const written = fakeTable.put.mock.calls[0][0] as unknown as Asset
    expect(written.id).toBe(a.id)
    expect('reason' in (written.classifyReview ?? {})).toBe(false)
  })
})

// ── ② skipped 也写（本卡最容易写错的一条） ──────────────────────────

describe('② skipped（分类本来就对）也要写 decidedAt', () => {
  it('★「用站方的」而资产已在 s2 的分类 → moved 0 / failed 0 → 仍定案出队', async () => {
    // 这正是团队裁定的具体症状：S1 与 S2 二级不同 → conflict，但用户选站方后
    // 发现资产本来就在站方那个分类里 → assignCategory 判 skipped（不发 IPC）。
    const a = conflictAsset({ category1: '建筑设计', category2: '规划设计' })
    useVault.setState({ assets: [a] })

    const summary = await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(summary.moved).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(1)
    // 没发 IPC（assignCategory 对已在目标分类的直接 continue）
    expect(modvault.assignCategory).not.toHaveBeenCalled()

    const after = live(a.id)
    expect(typeof after.classifyReview?.decidedAt).toBe('number')
    expect(reviewReasonOf(after)).toBeNull()
  })

  it('★skipped 时 classification 不变（不能顺手改写用户没动过的分类）', async () => {
    const a = conflictAsset({ category1: '建筑设计', category2: '规划设计' })
    useVault.setState({ assets: [a] })

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')

    const after = live(a.id)
    expect(after.category1).toBe('建筑设计')
    expect(after.category2).toBe('规划设计')
  })
})

// ── ③ failed 绝不写 ────────────────────────────────────────────────

describe('③ failed（移动失败）绝不写 decidedAt', () => {
  it('★main 返回 null → failed 1 → 仍是 conflict，仍在队列里（下一批会重试）', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(null)

    const summary = await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(summary.failed).toBe(1)
    expect(summary.moved).toBe(0)

    const after = live(a.id)
    expect(after.classifyReview?.reason).toBe('conflict')
    expect(after.classifyReview?.decidedAt).toBeUndefined()
    expect(reviewReasonOf(after)).toBe('conflict')
    // 没写库（既没 bulkPut 也没 put）
    expect(fakeTable.put).not.toHaveBeenCalled()
  })

  it('★IPC reject（main 抛错）→ 不写、不抛给 UI 以外的层（assignCategory 自己 catch）', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockRejectedValue(new Error('boom'))

    const summary = await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(summary.failed).toBe(1)

    const after = live(a.id)
    expect(after.classifyReview?.reason).toBe('conflict')
    expect(after.classifyReview?.decidedAt).toBeUndefined()
  })

  it('★原本就有 decidedAt → 失败时保持**原值**（不被清、不被改）', async () => {
    const keep = 1_600_000_000_000
    const a = conflictAsset({
      classifyReview: {
        confidence: 'conflict',
        reason: 'conflict',
        decidedAt: keep
      }
    })
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(null)

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(live(a.id).classifyReview?.decidedAt).toBe(keep)
  })
})

// ── ④ 边界：资产在搬的过程中消失 ────────────────────────────────────

describe('④ 搬的过程中资产没了', () => {
  it('★不写库、不崩（与 runZhimoCategoryReclass 的写回同一纪律）', async () => {
    const a = conflictAsset()
    useVault.setState({ assets: [a] })
    // main 搬成功，但同一时刻 rescan 把这条从库里换掉了
    modvault.assignCategory.mockImplementation(async () => {
      useVault.setState({ assets: [] })
      return moveOk(a.name, '建筑设计', '规划设计')
    })

    const summary = await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')
    expect(summary.moved).toBe(1)
    // 找不到记录 → 早退，不 put（put 会把已消失的记录写回去）
    expect(fakeTable.put).not.toHaveBeenCalled()
  })
})

// ── ⑤ 没有 classifyReview 的历史资产也能定案（不崩） ─────────────────

describe('⑤ 没有 classifyReview 的资产', () => {
  it('★从空对象起步，写出 {confidence,decidedAt}（没有 reason 可删）', async () => {
    const a = conflictAsset({ classifyReview: undefined })
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '建筑设计', '规划设计'))

    await useVault.getState().decideReview(a.id, '建筑设计', '规划设计')

    const review = live(a.id).classifyReview!
    expect('reason' in review).toBe(false)
    expect(review.confidence).toBe('high')
    expect(typeof review.decidedAt).toBe('number')
  })

  it('★未分类资产（unclassified 模式下确认）也会写 decidedAt —— 语义无害', async () => {
    // 团队裁定：两种模式共用同一个入口。unclassified 模式的资产本来没有 reason，
    // 写 `{confidence:'high', decidedAt}` 正是"用户刚给它定了分类"的准确表达。
    const a = conflictAsset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED, classifyReview: undefined })
    useVault.setState({ assets: [a] })
    modvault.assignCategory.mockResolvedValue(moveOk(a.name, '家具', '沙发'))

    await useVault.getState().decideReview(a.id, '家具', '沙发')

    const after = live(a.id)
    expect(after.category1).toBe('家具')
    expect(after.category2).toBe('沙发')
    expect(after.classifyReview?.confidence).toBe('high')
    expect(typeof after.classifyReview?.decidedAt).toBe('number')
    expect(reviewReasonOf(after)).toBeNull()
  })
})
