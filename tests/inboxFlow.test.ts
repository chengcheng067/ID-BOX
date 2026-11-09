/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   `Window.modvault` 的真实声明在 src/renderer/env.d.ts（只对 tsconfig.web 程序生效），
//   这里补一个测试用声明，与 `tests/storeFlow.test.ts` 完全同款。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import type { InboxJob } from '../src/shared/inbox'

/**
 * 收件箱任务在**渲染层**的消费逻辑（`store.ts` 的 `consumeInboxJob`）行为测试。
 *
 * 为什么不只是源码守卫：这里有三条只能靠"真的跑一遍"钉住的契约——
 *
 * 1. **成功和失败都要 ack**：不 ack → 主进程每 3 秒重发同一条任务（无限循环），
 *    或任务目录永远堆在 `incoming\`；
 * 2. **同一 jobId 只处理一次**（重复到达补 ack，不重跑）：重跑 create 会在库里多一份资产；
 * 3. **update 绝不走 `importPaths`**：那条路会把旧目录送进回收站并丢掉
 *    `renderParams` / `renderShape` / 自定义封面（勘察 §Q4-3 / §风险 R5）。
 *
 * 边界桩法与 `tests/storeFlow.test.ts` 一致：`window.modvault` 用 vi.fn 桩、
 * `db.assets` / `db.backups` 用内存假表 —— 驱动的是**真实 store 代码**，不是副本。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/** 主进程派发回调（`ensureInboxSubscribed` 里注册进来的那个） */
let inboxHandler: ((job: InboxJob) => void) | null = null

const modvault = {
  onInboxJob: vi.fn((cb: (job: InboxJob) => void) => {
    inboxHandler = cb
    return () => {
      inboxHandler = null
    }
  }),
  ackInboxJob: vi.fn(),
  applyInboxUpdate: vi.fn(),
  importPaths: vi.fn(),
  rescan: vi.fn(),
  renameAsset: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  // 导入后置任务（`setTimeout(0)` 里 fire-and-forget）可能碰到的通道，一律给空实现
  aiClassify: vi.fn(),
  reportPluginSnapshot: vi.fn(),
  fetchZhimoMeta: vi.fn(),
  fetchZhimoCover: vi.fn(),
  searchZhimo: vi.fn(),
  logStats: vi.fn(),
  /** 渲染层日志出口（收件箱能力探测的 warn 走这里，见「能力探测」用例组） */
  reportLog: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const putCalls: Asset[] = []
const fakeAssetsTable = {
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => putCalls)
}
Object.defineProperty(db, 'assets', { value: fakeAssetsTable, configurable: true })
const fakeBackupsTable = {
  put: vi.fn(async () => 'id'),
  toArray: vi.fn(async () => []),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'backups', { value: fakeBackupsTable, configurable: true })

const { useVault, ensureInboxSubscribed, resetInboxForTests } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

const JOB_ID = '20261109-184000-ab12'
const JOB_DIR = `C:\\Users\\u\\AppData\\Roaming\\idbox_export\\incoming\\${JOB_ID}`

function job(over: Partial<InboxJob> = {}, manifestOver: Partial<InboxJob['manifest']> = {}): InboxJob {
  return {
    jobId: JOB_ID,
    jobDir: JOB_DIR,
    skpPath: `${JOB_DIR}\\休闲椅.skp`,
    coverPath: `${JOB_DIR}\\休闲椅.cover.png`,
    manifest: {
      apiVersion: 1,
      op: 'create',
      name: '休闲椅',
      skp: '休闲椅.skp',
      cover: '休闲椅.cover.png',
      targetRelFolder: null,
      pluginVersion: '1.2.0',
      createdAt: '2026-11-09T18:40:00+08:00',
      ...manifestOver
    },
    ...over
  }
}

function updateJob(): InboxJob {
  return job({}, { op: 'update', targetRelFolder: '模型/家具/椅子/休闲椅' })
}

/** 等 `cond()` 成立（默认 2 秒；`consumeInboxJob` 是 void 派发的异步任务） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetInboxForTests()
  inboxHandler = null
  putCalls.length = 0
  useVault.setState({ assets: [], imports: [], notice: null })

  modvault.ackInboxJob.mockResolvedValue({ ok: true, archivedTo: 'done' })
  modvault.importPaths.mockResolvedValue([])
  modvault.rescan.mockResolvedValue({ assets: [], ignored: [] })
  modvault.renameAsset.mockImplementation(async (folder: string, name: string) =>
    folder.replace(/[^\\/]+$/, name)
  )
  modvault.applyInboxUpdate.mockResolvedValue({
    ok: true,
    targetAbs: 'E:\\lib\\模型\\家具\\椅子\\休闲椅\\休闲椅.skp',
    targetName: '休闲椅.skp',
    bytes: 123,
    selection: 'exact'
  })
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.reportPluginSnapshot.mockResolvedValue(true)
  modvault.aiClassify.mockResolvedValue({ items: [], failedNames: [], error: null })

  ensureInboxSubscribed()
})

/** 派发一次任务并等它 ack 完 */
async function dispatchOnce(j: InboxJob): Promise<void> {
  const before = modvault.ackInboxJob.mock.calls.length
  expect(inboxHandler).not.toBeNull()
  inboxHandler!(j)
  await waitFor(() => modvault.ackInboxJob.mock.calls.length > before)
}

describe('op=create：走既有导入通道', () => {
  it('importPaths([jobDir]) → 按 jobId 找回资产并改名 → ack(ok)', async () => {
    // 导入后库里会出现这样一条记录（文件夹名就是 jobId）
    useVault.setState({
      assets: [
        {
          id: 'a1',
          name: JOB_ID,
          kind: 'model',
          source: '',
          folder: `E:\\lib\\模型\\未分类\\未分类\\${JOB_ID}`,
          relFolder: `模型/未分类/未分类/${JOB_ID}`,
          files: [],
          size: 0,
          tags: [],
          note: '',
          favorite: false,
          rating: 0,
          colorTag: null,
          dedupeKey: '',
          importedAt: 0,
          updatedAt: 0
        } satisfies Asset
      ]
    })

    await dispatchOnce(job())

    expect(modvault.importPaths).toHaveBeenCalledTimes(1)
    expect(modvault.importPaths.mock.calls[0]![0]).toEqual([JOB_DIR])
    // 判重快照由渲染层算（第二个参数），不能是 undefined
    expect(modvault.importPaths.mock.calls[0]![1]).toBeTruthy()
    // 入库后名字要被改回 manifest.name（否则资产名叫 20261109-184000-ab12）
    expect(modvault.renameAsset).toHaveBeenCalledWith(
      `E:\\lib\\模型\\未分类\\未分类\\${JOB_ID}`,
      '休闲椅'
    )
    expect(modvault.ackInboxJob).toHaveBeenCalledWith({ jobId: JOB_ID, ok: true, reason: undefined })
    expect(useVault.getState().notice).toContain('休闲椅')
  })

  it('⭐ 同一 jobId 重复到达：不重跑导入，但补一次 ack（主进程靠它停止重发）', async () => {
    // 让改名能立即命中（否则 `waitForInboxAsset` 会轮询 3 秒，与去重无关）
    useVault.setState({
      assets: [
        {
          id: 'a1',
          name: JOB_ID,
          kind: 'model',
          source: '',
          folder: `E:\\lib\\模型\\未分类\\未分类\\${JOB_ID}`,
          relFolder: `模型/未分类/未分类/${JOB_ID}`,
          files: [],
          size: 0,
          tags: [],
          note: '',
          favorite: false,
          rating: 0,
          colorTag: null,
          dedupeKey: '',
          importedAt: 0,
          updatedAt: 0
        } satisfies Asset
      ]
    })
    await dispatchOnce(job())
    await dispatchOnce(job())

    expect(modvault.importPaths).toHaveBeenCalledTimes(1)
    expect(modvault.ackInboxJob).toHaveBeenCalledTimes(2)
  })

  it('importPaths 抛错 → ack(ok:false) 带原因（任务目录会进 failed/ 而不是卡在 incoming）', async () => {
    modvault.importPaths.mockRejectedValueOnce(new Error('磁盘空间不足'))
    await dispatchOnce(job())

    const arg = modvault.ackInboxJob.mock.calls[0]![0] as { ok: boolean; reason: string }
    expect(arg.ok).toBe(false)
    expect(arg.reason).toContain('磁盘空间不足')
    expect(useVault.getState().notice).toContain('磁盘空间不足')
  })
})

describe('op=update：只覆盖那一个 .skp', () => {
  it('applyInboxUpdate → rescan → ack(ok)，且**不碰** importPaths', async () => {
    await dispatchOnce(updateJob())

    expect(modvault.applyInboxUpdate).toHaveBeenCalledTimes(1)
    expect(modvault.applyInboxUpdate.mock.calls[0]![0]).toEqual({
      targetRelFolder: '模型/家具/椅子/休闲椅',
      skpSourcePath: `${JOB_DIR}\\休闲椅.skp`,
      jobId: JOB_ID
    })
    expect(modvault.rescan).toHaveBeenCalledTimes(1)
    expect(modvault.ackInboxJob).toHaveBeenCalledWith({ jobId: JOB_ID, ok: true, reason: undefined })
    // ⭐ 绝不能走导入覆盖档（会丢 renderParams / 自定义封面）
    expect(modvault.importPaths).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toContain('休闲椅')
  })

  it('覆盖失败（文件被占用）→ ack(ok:false) + 文案能指导用户先关 SketchUp + **不重扫**', async () => {
    modvault.applyInboxUpdate.mockResolvedValueOnce({
      ok: false,
      reason:
        '目标文件「休闲椅.skp」正被其他程序占用（很可能正在 SketchUp 里打开），更新已取消。请先在 SketchUp 里关闭该文件后重试'
    })
    await dispatchOnce(updateJob())

    const arg = modvault.ackInboxJob.mock.calls[0]![0] as { ok: boolean; reason: string }
    expect(arg.ok).toBe(false)
    expect(arg.reason).toContain('请先在 SketchUp 里关闭该文件')
    const notice = useVault.getState().notice ?? ''
    expect(notice).toContain('更新')
    expect(notice).toContain('关闭')
    // 失败时磁盘没变 → 不能重扫（重扫会白跑一趟并可能触发缩略图涓流）
    expect(modvault.rescan).not.toHaveBeenCalled()
    expect(modvault.importPaths).not.toHaveBeenCalled()
  })
})

describe('派发载荷容错', () => {
  it('载荷缺 jobId / manifest → 静默忽略（不 ack、不抛）', async () => {
    expect(inboxHandler).not.toBeNull()
    inboxHandler!({} as InboxJob)
    inboxHandler!({ jobId: JOB_ID } as InboxJob)
    // 给事件循环一拍，确认没有意外 ack
    await new Promise((r) => setTimeout(r, 30))
    expect(modvault.ackInboxJob).not.toHaveBeenCalled()
  })
})

/**
 * preload 能力探测（`ensureInboxSubscribed` 的两条分支）。
 *
 * 为什么这几条是**行为**测试而不是源码守卫：探测写宽一格（比如 `!window.modvault?.onInboxJob`）
 * 就会把"函数明明存在"也短路掉 —— 那时全仓测试照样绿（桩里都有 onInboxJob，
 * 但没人真的订阅了），线上表现为"SketchUp 导出了一百次，ID BOX 一次都没反应"。
 * 两个方向都必须钉死：**有就走真实路径，没有就跳过且留痕**。
 */
describe('preload 能力探测（允许缺失，不许静默，也不许短路真实订阅）', () => {
  it('⭐ 桩里有 onInboxJob → 走**真实**订阅路径，且不打印跳过告警', () => {
    resetInboxForTests()
    vi.clearAllMocks()
    inboxHandler = null

    ensureInboxSubscribed()

    expect(modvault.onInboxJob).toHaveBeenCalledTimes(1)
    expect(inboxHandler).not.toBeNull()
    expect(
      modvault.reportLog.mock.calls.filter(
        ([p]) => (p as { message?: string } | undefined)?.message === 'inbox:subscribe-skipped'
      ).length
    ).toBe(0)
  })

  it('preload 缺 onInboxJob（旧版 / 只桩部分方法的测试桩）→ 不抛、跳过订阅、warn **只一次**', () => {
    resetInboxForTests()
    vi.clearAllMocks()
    inboxHandler = null
    const saved = modvault.onInboxJob
    delete (modvault as unknown as Record<string, unknown>)['onInboxJob']
    try {
      // ① 绝不抛：init() 一炸会让整个界面停在"正在加载…"
      expect(() => ensureInboxSubscribed()).not.toThrow()
      // ② 再调一次也不抛、也不再刷日志（StrictMode / 重扫重建会调多次）
      expect(() => ensureInboxSubscribed()).not.toThrow()

      const warns = modvault.reportLog.mock.calls.filter(
        ([p]) => (p as { message?: string } | undefined)?.message === 'inbox:subscribe-skipped'
      )
      expect(warns.length).toBe(1)
      const payload = warns[0]![0] as { level: string; context: { reason: string } }
      expect(payload.level).toBe('warn')
      expect(payload.context.reason).toContain('onInboxJob')
      // 跳过订阅 = 没有 handler 被注册
      expect(inboxHandler).toBeNull()
    } finally {
      ;(modvault as unknown as Record<string, unknown>)['onInboxJob'] = saved
    }
  })
})
