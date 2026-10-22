/// <reference lib="dom" />
/**
 * 球图**惰性升级**与「形态进入球图身份」的回归测试（2026-10 缓存策略）。
 *
 * 要锁死的用户问题（原话）：
 * 「你的设计意思是以后每一次更新软件都会全部重新渲染一次我的材质吗？…而且你没有办法
 *   保证用户调好了的结果还能够被保存上。」
 *
 * 五组断言（对应设计稿 A/B/C 三段）：
 * ① **启动不再全量重渲**：`ensureMissingBallThumbs` 只补"屏幕上根本没图"的资产，
 *    「名字过期但文件还在」的一律不入队；
 * ② **看到才升**：`noteVisibleAssets` 只入队可见且过期的，每次 ≤ `VISIBLE_UPGRADE_MAX`；
 * ③ **兜底涓流**：3s 一条、每会话最多 `STALE_TRICKLE_SESSION_MAX` 条（假定时器）；
 * ④ **形态身份**：`'sphere'` / 缺省与存量 golden **逐字符相等**，`'plane'` 必须不同；
 * ⑤ **升级期间旧图不被清掉**：渲染失败路径不写 `thumbPath`、不删旧文件。
 *
 * 环境约束与 `tests/ballCache.test.ts` 同源（那里有更详细的解释）：
 * - `electron` 是 CJS，node ESM 下必须整体 `vi.mock`，`app.getPath` 指 tmp；
 * - `environment: 'node'` 没有 `FileReader`，补一个最小 shim 给 `blobToBase64`；
 * - `window.modvault` / `db.assets` 都是**部分实现**的桩，断言只用到被桩的那几条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Asset, BallSlots, SaveBallThumbPayload } from '../src/shared/types'
import type { ModVaultApi } from '../src/preload/index'
import { ballHash, ballThumbName, type BallParamScales } from '../src/shared/ballParams'

// ── electron 桩（必须在任何 main/* import 之前就位；vi.mock 会被提升） ──
const env = vi.hoisted(() => ({ userDataRoot: '', thumbsRoot: '' }))
vi.mock('electron', () => ({
  nativeImage: { createFromPath: () => null },
  app: { getPath: () => env.userDataRoot }
}))

// ── three.js 材质球桩：无头环境跑不了 WebGL，只桩"渲染产出 Blob"这一步 ──
const renderMock = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/components/MaterialBall', () => ({ renderBallToPng: renderMock }))

// ── node 环境缺 FileReader（Blob 有）：最小 shim，仅供 store 的 blobToBase64 ──
class FileReaderShim {
  result: string | null = null
  error: unknown = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void Promise.resolve()
      .then(async () => {
        const buf = new Uint8Array(await blob.arrayBuffer())
        this.result = 'data:image/png;base64,' + Buffer.from(buf).toString('base64')
        this.onload?.()
      })
      .catch((e: unknown) => {
        this.error = e
        this.onerror?.()
      })
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = FileReaderShim

// ── IPC 边界桩 ────────────────────────────────────────────────
const modvault = {
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async () => true),
  saveBallThumb: vi.fn(async (payload: SaveBallThumbPayload) => {
    // 与主进程同一口径：shape 参与名字（非球面才换名）
    return ballThumbName(payload.assetId, payload.slots ?? {}, payload.params, payload.shape)
  })
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

// ── Dexie 桩（只在 action 执行期访问 db.assets） ────────────────
const { db } = await import('../src/renderer/db')
const fakeTable = { put: vi.fn(async (a: Asset) => a.id) }
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const {
  useVault,
  ensureMissingBallThumbs,
  noteVisibleAssets,
  resetBallLazyUpgradeForTests,
  ballQueueSnapshotForTests,
  STALE_TRICKLE_INTERVAL_MS,
  STALE_TRICKLE_SESSION_MAX,
  VISIBLE_UPGRADE_MAX
} = await import('../src/renderer/store')

// ── 夹具 ─────────────────────────────────────────────────────
const SLOTS: BallSlots = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
const DEFAULTS: BallParamScales = { roughness: 1, bump: 1, uv: 1, light: 1, metal: 0, alpha: 1 }
/** 调过参的一组（现有 golden：2e1ac17a） */
const TUNED: BallParamScales = { roughness: 1.5, bump: 1, uv: 0.5, light: 1, metal: 0, alpha: 1 }

let seq = 0

/** 材质球资产（必须有 albedo 才会进球队列，`store.ts` 的 `ballSlotsOf`） */
function ballAsset(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `材质${n}`,
    kind: 'material',
    source: 'AmbientCG',
    folder: `E:\\ModVault\\Library\\贴图\\未分类\\未分类\\材质${n}`,
    relFolder: '贴图/未分类/未分类/材质' + n,
    cover: 'vh1sbjl_2K_Albedo.jpg',
    // ⚠️ 不能是 'named'/'manual'：`renderBallThumbFor` 对官方图早退、`ballThumbTarget`
    // 对手动封面返回 null —— 两种都会让"入队"断言假通过。
    coverSource: 'root',
    files: [
      { rel: 'vh1sbjl_2K_Albedo.jpg', name: 'vh1sbjl_2K_Albedo.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: 'vh1sbjl_2K_Normal.jpg', name: 'vh1sbjl_2K_Normal.jpg', ext: 'jpg', size: 10, kind: 'texture' }
    ],
    size: 20,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `material:材质${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

/** 名字过期但**文件还在**的资产（本次策略的惰性升级对象） */
function staleAsset(over: Partial<Asset> = {}): Asset {
  const a = ballAsset(over)
  return {
    ...a,
    thumbPath: ballThumbName(a.id, SLOTS, { roughness: 0.5, bump: 1, uv: 1 }),
    thumbStatus: 'ready'
  }
}

function attemptedIds(): string[] {
  return ballQueueSnapshotForTests()
    .attempted.map(([id]) => id)
    .sort()
}

beforeEach(async () => {
  env.userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-lazy-'))
  env.thumbsRoot = path.join(env.userDataRoot, 'thumbs')
  resetBallLazyUpgradeForTests()
  fakeTable.put.mockClear()
  renderMock.mockReset()
  renderMock.mockImplementation(async () => new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]))
  for (const fn of Object.values(modvault)) fn.mockReset()
  modvault.pruneThumbs.mockImplementation(async () => 0)
  modvault.ensureThumb.mockImplementation(async () => null)
  modvault.deleteThumb.mockImplementation(async () => 0)
  modvault.deleteOneThumb.mockImplementation(async () => true)
  modvault.saveBallThumb.mockImplementation(async (payload: SaveBallThumbPayload) =>
    ballThumbName(payload.assetId, payload.slots ?? {}, payload.params, payload.shape)
  )
})

afterEach(async () => {
  resetBallLazyUpgradeForTests()
  if (env.userDataRoot) {
    await fs.rm(env.userDataRoot, { recursive: true, force: true }).catch(() => {})
  }
  env.userDataRoot = ''
  env.thumbsRoot = ''
  useVault.setState({ assets: [], selectedId: null })
})

// ── ① 启动只补"根本没图"，不为"名字过期"重渲 ───────────────────
describe('ensureMissingBallThumbs · 启动只补缺图', () => {
  it('有 thumbPath 但名字过期的资产**不入队**（启动不再全量重渲）', async () => {
    const stale = staleAsset()
    const missing = ballAsset({ thumbStatus: 'none' })
    const halfBaked = ballAsset({
      thumbPath: ballThumbName('placeholder', SLOTS),
      thumbStatus: 'failed'
    })
    const model = ballAsset({ kind: 'model', thumbStatus: 'none' })
    // 手动封面：真实记录里 `setCover` 会同时写下封面缩略图的 thumbPath + ready，
    // 这里按真实形态造（"有图"那一档），不是"缺图"。
    const manual = ballAsset({ coverSource: 'manual' })
    manual.thumbPath = ballThumbName(manual.id, SLOTS)
    manual.thumbStatus = 'ready'

    useVault.setState({ assets: [stale, missing, halfBaked, model, manual], selectedId: null })
    await ensureMissingBallThumbs()

    // 只有"真的没图"的两条被尝试；过期资产 / 模型 / 手动封面都没有
    expect(attemptedIds()).toEqual([missing.id, halfBaked.id].sort())
    expect(attemptedIds()).not.toContain(stale.id)
  })

  it('过期资产不会因为启动而换 thumbPath（旧图继续显示）', async () => {
    const stale = staleAsset()
    useVault.setState({ assets: [stale], selectedId: null })
    await ensureMissingBallThumbs()
    // 入队都没发生 → 渲染更不会发生
    expect(renderMock).not.toHaveBeenCalled()
    expect(useVault.getState().assets[0]!.thumbPath).toBe(stale.thumbPath)
  })
})

// ── ② 看到才升（≤ 6 条/次，且只挑过期的） ────────────────────
describe('noteVisibleAssets · 只升可见且过期的', () => {
  it('每次最多入队 VISIBLE_UPGRADE_MAX 条，且跳过 fresh / 非可见', () => {
    const staleList = Array.from({ length: 10 }, () => staleAsset())
    const fresh = ballAsset({ thumbPath: undefined, thumbStatus: 'none' })
    fresh.thumbPath = ballThumbName(fresh.id, SLOTS) // 名对 = fresh
    const notVisible = staleAsset()
    const all = [...staleList, fresh, notVisible]
    useVault.setState({ assets: all, selectedId: null })

    noteVisibleAssets(staleList.map((a) => a.id))

    const queued = attemptedIds()
    expect(queued).toHaveLength(VISIBLE_UPGRADE_MAX)
    // 按屏幕顺序（传入顺序）取前 6 条 —— 先升用户正在看的
    expect(queued).toEqual(staleList.slice(0, VISIBLE_UPGRADE_MAX).map((a) => a.id).sort())
    // 未上报的不是候选（fresh 名不对但没被上报；notVisible 同理）
    expect(queued).not.toContain(notVisible.id)
    expect(queued).not.toContain(fresh.id)
  })

  it('重复上报不会重复入队（滚动每帧都报也没关系）', () => {
    const stale = staleAsset()
    useVault.setState({ assets: [stale], selectedId: null })
    noteVisibleAssets([stale.id])
    noteVisibleAssets([stale.id])
    noteVisibleAssets([stale.id])
    // `attempted` 在入队那一刻写入且只写一次 → 就是"只入队一次"的证据。
    // （`queued` 不能用：`runBallQueue` 同步 shift 后再 await，此时可能已被取走。）
    expect(attemptedIds()).toEqual([stale.id])
    expect(ballQueueSnapshotForTests().queued.length).toBeLessThanOrEqual(1)
  })

  it('fresh 的资产完全不进队列（成品不重渲）', () => {
    const fresh = ballAsset()
    fresh.thumbPath = ballThumbName(fresh.id, SLOTS)
    fresh.thumbStatus = 'ready'
    useVault.setState({ assets: [fresh], selectedId: null })
    noteVisibleAssets([fresh.id])
    expect(attemptedIds()).toEqual([])
  })
})

// ── ③ 兜底涓流：3s 一条、每会话 60 条 ──────────────────────────
describe('涓流 · 3s / 60 条上限', () => {
  it('恰好 STALE_TRICKLE_INTERVAL_MS 才产出第一条，且一共产出不超过 60 条', async () => {
    vi.useFakeTimers()
    try {
      // 70 条过期资产：足够把 60 条上限打满
      const assets = Array.from({ length: 70 }, () => staleAsset({ kind: 'material' }))
      useVault.setState({ assets, selectedId: null })
      resetBallLazyUpgradeForTests()

      await ensureMissingBallThumbs() // 只挂涓流：没有缺图资产
      expect(attemptedIds()).toHaveLength(0)

      // 差 1ms：一条都不该产出（钉死间隔，不是"尽快"）
      await vi.advanceTimersByTimeAsync(STALE_TRICKLE_INTERVAL_MS - 1)
      expect(attemptedIds()).toHaveLength(0)

      // 再走 1ms：第一条
      await vi.advanceTimersByTimeAsync(1)
      expect(attemptedIds()).toHaveLength(1)

      // 再给足 3s × 100 的时间：候选 70 条，但会话上限是 60
      await vi.advanceTimersByTimeAsync(STALE_TRICKLE_INTERVAL_MS * 100)
      expect(attemptedIds().length).toBe(STALE_TRICKLE_SESSION_MAX)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有过期资产时涓流让链停掉（不空转）', async () => {
    vi.useFakeTimers()
    try {
      const fresh = ballAsset()
      fresh.thumbPath = ballThumbName(fresh.id, SLOTS)
      fresh.thumbStatus = 'ready'
      useVault.setState({ assets: [fresh], selectedId: null })
      resetBallLazyUpgradeForTests()

      await ensureMissingBallThumbs()
      await vi.advanceTimersByTimeAsync(STALE_TRICKLE_INTERVAL_MS * 5)
      expect(attemptedIds()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── ④ 形态进入球图身份（球面必须与今天完全一致） ────────────────
describe('ballThumbName · 形态身份（golden 锁）', () => {
  it('缺省 / sphere 与存量 golden 逐一相等（绝不给全库改名）', () => {
    // 这三个值是 2026-10 改动之前磁盘上的实际 hash（tests/ballParams.test.ts 同源）
    expect(ballHash(SLOTS, DEFAULTS)).toBe('d9d58630')
    expect(ballHash({ albedo: 'a.jpg', normal: 'b.jpg' }, DEFAULTS)).toBe('c58e4b03')
    expect(ballHash({}, DEFAULTS)).toBe('60fd7dc8')
    expect(ballHash(SLOTS, TUNED)).toBe('2e1ac17a')

    // 显式 sphere 与"不传"必须逐字符一致 —— 否则存量缓存全部失效
    expect(ballHash(SLOTS, DEFAULTS, 'sphere')).toBe('d9d58630')
    expect(ballThumbName('id1', SLOTS)).toBe(ballThumbName('id1', SLOTS, DEFAULTS, 'sphere'))
    expect(ballThumbName('id1', SLOTS, DEFAULTS)).toBe(
      ballThumbName('id1', SLOTS, DEFAULTS, undefined)
    )
  })

  it('plane / roundedBox 给出不同名字（切换形态必须换缓存）', () => {
    expect(ballHash(SLOTS, DEFAULTS, 'plane')).toBe('7c3e03cd')
    expect(ballHash(SLOTS, DEFAULTS, 'roundedBox')).toBe('9bf5510f')
    expect(ballHash(SLOTS, DEFAULTS, 'plane')).not.toBe(ballHash(SLOTS, DEFAULTS))
    expect(ballHash(SLOTS, TUNED, 'plane')).not.toBe(ballHash(SLOTS, TUNED))
  })

  it('渲染层真的把 renderShape 传到落盘载荷（名字与渲染同口径）', async () => {
    const a = ballAsset({ renderShape: 'plane' })
    a.thumbPath = ballThumbName(a.id, SLOTS) // 旧图：球面名
    a.thumbStatus = 'ready'
    useVault.setState({ assets: [a], selectedId: null })

    noteVisibleAssets([a.id])
    // 等到渲染落盘完成
    const t0 = Date.now()
    while (Date.now() - t0 < 3000 && modvault.saveBallThumb.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(renderMock).toHaveBeenCalledTimes(1)
    const renderOpts = (renderMock.mock.calls[0] as unknown[])[2] as { shape?: string }
    expect(renderOpts.shape).toBe('plane')

    const payload = modvault.saveBallThumb.mock.calls[0]![0] as SaveBallThumbPayload
    expect(payload.shape).toBe('plane')
    // 落盘名 = plane 的名字（不是球面名）
    expect(await modvault.saveBallThumb.mock.results[0]!.value).toBe(
      ballThumbName(a.id, SLOTS, undefined, 'plane')
    )
  })
})

// ── ⑤ 升级期间旧图不被清掉（失败路径不写 thumbPath） ─────────────
describe('renderBallThumbFor · 升级失败保留旧图', () => {
  it('渲染抛错 → 不删旧球图、不改 thumbPath / thumbStatus、不动 renderParams', async () => {
    const a = staleAsset({ renderParams: TUNED })
    const before = { thumbPath: a.thumbPath, thumbStatus: a.thumbStatus, renderParams: a.renderParams }
    useVault.setState({ assets: [a], selectedId: null })

    renderMock.mockImplementation(async () => {
      throw new Error('无 GPU / WebGL 上下文创建失败')
    })

    noteVisibleAssets([a.id])
    // 等失败路径走完（catch 里 `thumbStatus === 'ready'` 直接 return）
    await new Promise((r) => setTimeout(r, 200))

    expect(modvault.deleteOneThumb).not.toHaveBeenCalled()
    expect(fakeTable.put).not.toHaveBeenCalled()
    const after = useVault.getState().assets[0]!
    expect(after.thumbPath).toBe(before.thumbPath)
    expect(after.thumbStatus).toBe(before.thumbStatus)
    expect(after.renderParams).toEqual(before.renderParams)
  })
})

// ── ⑥ 形态**写入口**契约（`store.setRenderShape`） ───────────────
//
// 为什么现在就锁：MaterialBall 侧的接缝（`onShapeChange` / `defaultShape` /
// `getShape`）已备好，但 `CustomRenderDialog` 里当前**没有形态 UI**
// （`showShapeSwitch={false}`），所以 `renderShape` 还不会产生用户可见变化。
// 一旦 UI 接线，写入口的行为必须已经是钉死的——否则"切了形态、下次启动又变回球面"
// 会以最低成本回归。这组测试只走 store 的真实代码路径，不依赖任何 UI。
describe('store.setRenderShape · 形态写入口契约', () => {
  /** 轮询等待条件（球图渲染是异步的：动态 import + IPC + yield） */
  async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (cond()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return cond()
  }

  it('切到 plane：写库带 renderShape，旧 thumbPath / thumbStatus / renderParams 一律不动', async () => {
    const a = ballAsset({ renderParams: TUNED })
    a.thumbPath = ballThumbName(a.id, SLOTS, TUNED) // 球面成品
    a.thumbStatus = 'ready'
    useVault.setState({ assets: [a], selectedId: null })

    await useVault.getState().setRenderShape(a.id, 'plane')

    // 写库：只多一个 renderShape
    const written = fakeTable.put.mock.calls.at(-1)![0] as Asset
    expect(written.renderShape).toBe('plane')
    // 升级期间卡片继续显示**旧球面图**（先建新、再删旧），绝不置灰
    expect(written.thumbPath).toBe(a.thumbPath)
    expect(written.thumbStatus).toBe('ready')
    // 用户调好的参数一个字节都不许动
    expect(written.renderParams).toEqual(TUNED)

    // 渲染完成后才换成 plane 名，并删掉旧球面图
    const planeName = ballThumbName(a.id, SLOTS, TUNED, 'plane')
    expect(
      await waitFor(() => useVault.getState().assets[0]!.thumbPath === planeName)
    ).toBe(true)
    expect(modvault.deleteOneThumb).toHaveBeenCalledWith(a.id, a.thumbPath)
  })

  it('相同形态重复调用 → 不写库、不入队（幂等门）', async () => {
    const a = ballAsset()
    a.thumbPath = ballThumbName(a.id, SLOTS)
    a.thumbStatus = 'ready'
    useVault.setState({ assets: [a], selectedId: null })

    await useVault.getState().setRenderShape(a.id, 'sphere') // 缺省 = sphere → 无变化
    await useVault.getState().setRenderShape(a.id, 'plane')
    fakeTable.put.mockClear()
    const attemptedBefore = attemptedIds().length

    await useVault.getState().setRenderShape(a.id, 'plane') // 再切同一个

    expect(fakeTable.put).not.toHaveBeenCalled()
    expect(attemptedIds().length).toBe(attemptedBefore)
  })

  it('非法形态值一律按 sphere 处理（不把脏值写进 hash）', async () => {
    const a = ballAsset({ renderShape: 'plane' })
    a.thumbPath = ballThumbName(a.id, SLOTS, undefined, 'plane')
    a.thumbStatus = 'ready'
    useVault.setState({ assets: [a], selectedId: null })

    // @ts-expect-error 故意传脏值，验证运行时兜底
    await useVault.getState().setRenderShape(a.id, 'cylinder')

    const written = fakeTable.put.mock.calls.at(-1)![0] as Asset
    expect(written.renderShape).toBe('sphere')
  })
})
