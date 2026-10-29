/**
 * 知末封面的**渲染层**单测（docs/24 §7.1 #29–#33 + §7.2 #34–#41，T-04）。
 *
 * 三块：
 * ① `pickZhimoCoverTargets` —— 候选矩阵（`replacePacked` × `coverSource` × kind × ID）；
 * ② `runZhimoCoverQueue` —— 并发 / 间隔 / 分块 / 中停 / 回调抛错不中断；
 * ③ store 真实 action（`runZhimoCovers` / `refreshZhimoCover` / `commitCover` / rescan 保活）。
 *
 * 全部**零网络**：`window.modvault.fetchZhimoCover` 是 `vi.fn` 桩，Dexie 用内存版假表。
 * 测的是真要发布的代码路径（不抽副本），与 `storeFlow.test.ts` 同一套做法。
 */
/// <reference lib="dom" />
// ↑ tests/** 走 tsconfig.node 编译，renderer 源码依赖 DOM 全局；与 storeFlow.test.ts 同理。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, FetchZhimoCoverResult, Settings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { withAssetCoverLock } from '../src/renderer/logic/coverLock'
import {
  ZHIMO_COVER_MAX_BATCH,
  pickZhimoCoverTargets,
  runZhimoCoverQueue,
  zhimoCoverFailText,
  type ZhimoCoverTarget
} from '../src/renderer/logic/zhimoCover'

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/** `onImportEvent` / `onImportBatchDone` 的回调由 init() 注册，这里捕获后手动触发 */
type ImportEventCb = (ev: {
  item: string
  itemName: string
  status: 'done' | 'error'
  asset?: Asset
}) => void
let importEventCb: ImportEventCb | null = null
let batchDoneCb: (() => void) | null = null

const modvault = {
  fetchZhimoCover: vi.fn(),
  setCoverImage: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  pruneThumbs: vi.fn(),
  rescan: vi.fn(),
  detectMaterialMerge: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  /** TODO-3：风格落库的 debug 日志（断言"站方词不在词表"用） */
  reportLog: vi.fn(),
  onMaterialMergeNotice: vi.fn(() => () => {}),
  // docs/27：init() 会订阅「导入发现重复，请裁决」+「询问已作废」（幂等），桩必须返回退订函数
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

const putCalls: Asset[] = []
const bulkPutCalls: Asset[][] = []
const fakeAssetsTable = {
  toArray: vi.fn(async () => [] as Asset[]),
  put: vi.fn(async (a: Asset) => {
    putCalls.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list)
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeAssetsTable, configurable: true })

const backupStore = new Map<string, IndexBackup>()
const fakeBackupsTable = {
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
Object.defineProperty(db, 'backups', { value: fakeBackupsTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    name: `侘寂壁灯ID_12001662${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\ModVault\\Library\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    cover: '预览图.jpg',
    coverSource: 'embedded',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [
      { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
    ],
    size: 30,
    suVersion: 'SU 2024',
    suMajor: 24,
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

/** 一个 `kind` 各异、封面来源各异的资产（带知末 ID） */
function named(folder: Asset['coverSource'], over: Partial<Asset> = {}): Asset {
  return fixture({ coverSource: folder, ...over })
}

function settingsOf(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

beforeEach(async () => {
  // 清掉上一轮遗留的 pending（模块级数组，不随 state 重置）：
  // 此时 assets 会先置空，所以这一跑不会发出任何请求，只是把数组消费掉。
  useVault.setState({ assets: [], settings: settingsOf() })
  await useVault.getState().runZhimoCovers()

  putCalls.length = 0
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  // clearAllMocks 只清调用记录，不清实现 -> 这两个按用例各自设的桩要显式复位
  modvault.fetchZhimoCover.mockReset()
  modvault.setCoverImage.mockReset()
  modvault.ensureThumb.mockResolvedValue('thumb-new.jpg')
  modvault.deleteThumb.mockResolvedValue(1)
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.detectMaterialMerge.mockResolvedValue({ needMerge: false, count: 0, sources: [] })
  modvault.getSettings.mockResolvedValue(settingsOf())
  importEventCb = null
  batchDoneCb = null
  useVault.setState({
    assets: [],
    settings: settingsOf(),
    notice: null,
    zhimoCoverBusyId: null
  })
})

// ══════════════════════════════════════════════════════════════════
// ① pickZhimoCoverTargets —— 候选矩阵
// ══════════════════════════════════════════════════════════════════

describe('pickZhimoCoverTargets：replacePacked × coverSource 矩阵', () => {
  it('replacePacked=true：包内三种来源（named/root/largest）也入选', () => {
    const assets = [
      named('named'),
      named('root'),
      named('largest'),
      named('embedded'),
      named('placeholder'),
      fixture({ coverSource: undefined })
    ]
    expect(pickZhimoCoverTargets(assets, { replacePacked: true })).toHaveLength(6)
  })

  it('replacePacked=false：只排除 named/root/largest，embedded/placeholder/undefined 仍入选', () => {
    const assets = [
      named('named'),
      named('root'),
      named('largest'),
      named('embedded'),
      named('placeholder'),
      fixture({ coverSource: undefined })
    ]
    const picked = pickZhimoCoverTargets(assets, { replacePacked: false })
    expect(picked).toHaveLength(3)
    expect(picked.map((p) => p.id)).toEqual([
      assets[3]!.id,
      assets[4]!.id,
      assets[5]!.id
    ])
  })

  it('manual / zhimo 一律跳过（两种 replacePacked 取值都跳过）', () => {
    const assets = [named('manual'), named('zhimo')]
    expect(pickZhimoCoverTargets(assets, { replacePacked: true })).toHaveLength(0)
    expect(pickZhimoCoverTargets(assets, { replacePacked: false })).toHaveLength(0)
  })

  it('force=true 绕过「已有封面」与 replacePacked 两道过滤（manual/zhimo/named 全选）', () => {
    const assets = [named('manual'), named('zhimo'), named('named'), named('root')]
    expect(pickZhimoCoverTargets(assets, { replacePacked: false, force: true })).toHaveLength(4)
  })

  it('force 也不放宽 kind 与「名字里必须有 ID」两个硬前提', () => {
    const assets = [
      named('manual', { kind: 'texture' }),
      named('manual', { kind: 'material' }),
      named('manual', { name: '没有 ID 的模型' }),
      named('manual')
    ]
    const picked = pickZhimoCoverTargets(assets, { replacePacked: false, force: true })
    expect(picked).toHaveLength(1)
    expect(picked[0]!.id).toBe(assets[3]!.id)
  })

  it('非 model 大类零入选：texture / material / hdri / other', () => {
    const assets = (['texture', 'material', 'hdri', 'other'] as const).map((kind) =>
      named('embedded', { kind })
    )
    expect(pickZhimoCoverTargets(assets, { replacePacked: true })).toHaveLength(0)
  })

  it('名字里没有知末 ID → 零入选（不发请求，不猜）', () => {
    const assets = ['北欧椅子', 'grid123', 'ID卡'].map((name) => named('embedded', { name }))
    expect(pickZhimoCoverTargets(assets, { replacePacked: true })).toHaveLength(0)
  })

  it('ids 白名单：空数组 = 一个都不选（不能退化成全库）', () => {
    const assets = [named('embedded'), named('embedded')]
    expect(pickZhimoCoverTargets(assets, { replacePacked: true, ids: [] })).toHaveLength(0)
    expect(
      pickZhimoCoverTargets(assets, { replacePacked: true, ids: [assets[1]!.id] }).map((p) => p.id)
    ).toEqual([assets[1]!.id])
  })

  it('limit 截断，且默认上限是 50', () => {
    const many = Array.from({ length: 80 }, () => named('embedded'))
    expect(pickZhimoCoverTargets(many, { replacePacked: true })).toHaveLength(
      ZHIMO_COVER_MAX_BATCH
    )
    expect(pickZhimoCoverTargets(many, { replacePacked: true, limit: 3 })).toHaveLength(3)
    expect(pickZhimoCoverTargets(many, { replacePacked: true, limit: 0 })).toHaveLength(0)
  })

  it('返回的 zhimoId 是从名字里取出的数字串（不是资产 id）', () => {
    const a = named('embedded', { name: '传薇佳画_挂画组合ID_1186414883' })
    const [target] = pickZhimoCoverTargets([a], { replacePacked: true })
    expect(target).toEqual({ id: a.id, zhimoId: '1186414883' })
  })
})

// ══════════════════════════════════════════════════════════════════
// ①-b 知末 ID 的来源：asset.zhimoId 优先，为空才按名字解析（0.6.3）
// ══════════════════════════════════════════════════════════════════
//
// 用户场景（附件样本）：`现代壁灯ID_1232108421.rar` → 解包后
// `attachment_1786942463670\现代壁灯\现代壁灯.skp`，资产名与包内文件名**零 ID 痕迹**。
// 只按名字解析 → 这类资产永远抓不到封面（自动任务对用户一半资产失效）。
describe('pickZhimoCoverTargets：asset.zhimoId 优先（0.6.3）', () => {
  it('zhimoId 有值 + 名字无 ID → **能选中**，且用的是落库的 ID', () => {
    const a = named('embedded', {
      name: '现代壁灯',
      folder: 'E:\\ModVault\\Library\\模型\\未分类\\未分类\\现代壁灯',
      zhimoId: '1232108421'
    })
    const picked = pickZhimoCoverTargets([a], { replacePacked: true })
    expect(picked).toEqual([{ id: a.id, zhimoId: '1232108421' }])
  })

  it('zhimoId 前后带空白 → trim 后使用', () => {
    const a = named('embedded', { name: '现代壁灯', zhimoId: '  1232108421  ' })
    expect(pickZhimoCoverTargets([a], { replacePacked: true })[0]!.zhimoId).toBe('1232108421')
  })

  it('zhimoId 为空串 / null / 缺省，但名字有 ID → 仍能选中（回退名字解析）', () => {
    const empties: Array<string | null | undefined> = ['', '   ', null, undefined]
    for (const zhimoId of empties) {
      const a = named('embedded', { name: '侘寂壁灯ID_1200166260', zhimoId })
      const picked = pickZhimoCoverTargets([a], { replacePacked: true })
      expect(picked, `zhimoId=${String(zhimoId)} 应当回退名字解析`).toEqual([
        { id: a.id, zhimoId: '1200166260' }
      ])
    }
  })

  it('zhimoId 与名字都取不到 ID → 不选（不发请求，不猜）', () => {
    const a = named('embedded', { name: '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风', zhimoId: null })
    expect(pickZhimoCoverTargets([a], { replacePacked: true })).toHaveLength(0)
  })

  it('zhimoId 有值但仍受 kind 硬前提约束（texture 不选）', () => {
    const a = named('embedded', { kind: 'texture', name: '木纹贴图', zhimoId: '1232108421' })
    expect(pickZhimoCoverTargets([a], { replacePacked: true })).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════════════════
// ② runZhimoCoverQueue —— 并发 / 间隔 / 分块 / 中停
// ══════════════════════════════════════════════════════════════════

function targets(n: number): ZhimoCoverTarget[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, zhimoId: `12001662${i}` }))
}

const okResult: FetchZhimoCoverResult = {
  ok: true,
  rel: '资产.cover.jpg',
  size: 1234,
  width: 400,
  height: 300,
  sourceHost: 'image6.znzmo.com',
  watermarked: false,
  title: null
}

describe('runZhimoCoverQueue：并发 / 间隔 / 分块', () => {
  it('8 个目标、并发 2 → 最大同时在跑 = 2', async () => {
    let running = 0
    let maxRunning = 0
    const res = await runZhimoCoverQueue(targets(8), {
      fetchOne: async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 3))
        running -= 1
        return okResult
      },
      sleep: async () => {},
      concurrency: 2,
      gapMs: 250
    })
    expect(res).toEqual({ ok: 8, failed: 0, skipped: 0, stopped: false })
    expect(maxRunning).toBe(2)
  })

  it('每发一次请求前都要等 gapMs（间隔 ≥250ms 的落点）', async () => {
    const sleeps: number[] = []
    const calls: string[] = []
    await runZhimoCoverQueue(targets(3), {
      fetchOne: async (t) => {
        calls.push(t.id)
        return okResult
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      gapMs: 250,
      concurrency: 1
    })
    expect(calls).toEqual(['id-0', 'id-1', 'id-2'])
    // 第一发不等，后两发各等 250
    expect(sleeps).toEqual([250, 250])
  })

  it('120 个目标 / chunkSize 50 → 分 3 块（50/50/20），块间 sleep 2000 两次', async () => {
    const items = targets(120)
    const counts: number[] = []
    let batch = 0
    const sleeps: number[] = []
    const res = await runZhimoCoverQueue(items, {
      fetchOne: async () => {
        batch += 1
        return okResult
      },
      sleep: async (ms) => {
        sleeps.push(ms)
        if (ms === 2000) {
          counts.push(batch)
          batch = 0
        }
      },
      gapMs: 0,
      chunkSize: 50,
      chunkGapMs: 2000,
      concurrency: 1
    })
    expect(res.ok).toBe(120)
    // 两次块间间隔 → 前两块各 50 条已跑完
    expect(counts).toEqual([50, 50])
    expect(sleeps.filter((ms) => ms === 2000)).toHaveLength(2)
  })

  it('shouldStop 一开始就为真 → stopped=true，零请求', async () => {
    const fetchOne = vi.fn(async () => okResult)
    const res = await runZhimoCoverQueue(targets(5), {
      fetchOne,
      sleep: async () => {},
      shouldStop: () => true
    })
    expect(res).toEqual({ ok: 0, failed: 0, skipped: 0, stopped: true })
    expect(fetchOne).not.toHaveBeenCalled()
  })

  it('跑到一半被叫停 → stopped=true，剩余条目既不算 ok 也不算 failed', async () => {
    let n = 0
    const res = await runZhimoCoverQueue(targets(6), {
      fetchOne: async () => {
        n += 1
        return okResult
      },
      sleep: async () => {},
      concurrency: 1,
      shouldStop: () => n >= 2
    })
    expect(res.stopped).toBe(true)
    expect(res.ok).toBe(2)
    expect(res.failed).toBe(0)
  })

  it('fetchOne 抛错 → 记 failed 并继续（绝不中断整批）', async () => {
    const res = await runZhimoCoverQueue(targets(4), {
      fetchOne: async (t) => {
        if (t.id === 'id-1') throw new Error('IPC 炸了')
        return okResult
      },
      sleep: async () => {},
      concurrency: 1
    })
    expect(res).toEqual({ ok: 3, failed: 1, skipped: 0, stopped: false })
  })

  it('onEach 抛错 → 不影响后续条目，也不改计数', async () => {
    const seen: string[] = []
    const res = await runZhimoCoverQueue(targets(3), {
      fetchOne: async () => okResult,
      onEach: (t) => {
        seen.push(t.id)
        if (t.id === 'id-0') throw new Error('写库失败')
      },
      sleep: async () => {},
      concurrency: 1
    })
    expect(res).toEqual({ ok: 3, failed: 0, skipped: 0, stopped: false })
    expect(seen).toEqual(['id-0', 'id-1', 'id-2'])
  })

  it('失败结果也回调 onEach（上层可据此决定是否提示）', async () => {
    const failures: Array<string | undefined> = []
    await runZhimoCoverQueue(targets(2), {
      fetchOne: async () => ({ ok: false, reason: 'not-found' }),
      onEach: (_t, res) => {
        failures.push(res.reason)
      },
      sleep: async () => {}
    })
    expect(failures).toEqual(['not-found', 'not-found'])
  })

  it('空清单 → 零调用、零 sleep', async () => {
    const fetchOne = vi.fn(async () => okResult)
    const sleep = vi.fn(async () => {})
    const res = await runZhimoCoverQueue([], { fetchOne, sleep })
    expect(res).toEqual({ ok: 0, failed: 0, skipped: 0, stopped: false })
    expect(fetchOne).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('zhimoCoverFailText：失败文案必须可区分', () => {
  it('not-found / no-image / 网络 / 无 ID 各自不同（手动按钮靠它给反馈）', () => {
    const texts = [
      zhimoCoverFailText('no-id'),
      zhimoCoverFailText('not-found'),
      zhimoCoverFailText('no-image'),
      zhimoCoverFailText('timeout'),
      zhimoCoverFailText('network'),
      zhimoCoverFailText('bad-url'),
      zhimoCoverFailText('bad-image'),
      zhimoCoverFailText('too-small'),
      zhimoCoverFailText('write-failed')
    ]
    expect(new Set(texts).size).toBe(texts.length)
    expect(zhimoCoverFailText('not-found')).toContain('知末上没有这个 ID')
    expect(zhimoCoverFailText('no-image')).toContain('无水印')
    expect(zhimoCoverFailText('timeout')).toContain('超时')
    expect(zhimoCoverFailText('network')).toContain('网络')
    // 未知 / undefined 走兜底，不抛
    expect(zhimoCoverFailText(undefined)).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════
// ③ store：自动任务 / 手动 / commitCover / rescan 保活
// ══════════════════════════════════════════════════════════════════

describe('store.runZhimoCovers：自动任务（逐个落库 / 失败静默 / 开关）', () => {
  it('成功 → cover 指向新 rel、coverSource=zhimo、files 含新封面、size 重算、缩略图更新', async () => {
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    const res = await useVault.getState().runZhimoCovers({ ids: [a.id] })

    expect(res).toEqual({ ok: 1, failed: 0, skipped: 0, stopped: false })
    const saved = putCalls.at(-1)!
    expect(saved.cover).toBe(okResult.rel)
    expect(saved.coverSource).toBe('zhimo')
    expect(saved.thumbPath).toBe('thumb-new.jpg')
    expect(saved.thumbStatus).toBe('ready')
    // 新封面进 files，体积 = 10 + 20 + 1234
    expect(saved.files.map((f) => f.rel)).toContain(okResult.rel)
    expect(saved.size).toBe(10 + 20 + 1234)
    // 内存同步
    const inMem = useVault.getState().assets[0]!
    expect(inMem.coverSource).toBe('zhimo')
    expect(inMem.cover).toBe(okResult.rel)
  })

  it('换扩展名（旧 .cover.jpg → 新 .cover.png）时，旧同族 file 条目必须被剔掉', async () => {
    const a = fixture({
      coverSource: 'zhimo',
      cover: '资产.cover.jpg',
      files: [
        { rel: '资产.cover.jpg', name: '资产.cover.jpg', ext: 'jpg', size: 999, kind: 'texture' },
        { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
      ],
      size: 1019
    })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({
      ...okResult,
      rel: '资产.cover.png',
      size: 301803
    })

    await useVault.getState().refreshZhimoCover(a.id)

    const saved = putCalls.at(-1)!
    const rels = saved.files.map((f) => f.rel)
    expect(rels).toContain('资产.cover.png')
    expect(rels).not.toContain('资产.cover.jpg')
    // 体积按剩下的条目重算（不是把旧 999 一起加起来）
    expect(saved.size).toBe(20 + 301803)
  })

  it('失败静默：不写 notice、不动 cover / coverSource / files', async () => {
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a], notice: null })
    modvault.fetchZhimoCover.mockResolvedValue({ ok: false, reason: 'not-found' })

    const res = await useVault.getState().runZhimoCovers({ ids: [a.id] })

    expect(res.failed).toBe(1)
    expect(useVault.getState().notice).toBeNull()
    expect(putCalls).toHaveLength(0)
    const inMem = useVault.getState().assets[0]!
    expect(inMem.cover).toBe('预览图.jpg')
    expect(inMem.coverSource).toBe('embedded')
  })

  it('settings.zhimoCover=false → 零 IPC 调用', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a], settings: settingsOf({ zhimoCover: false }) })

    const res = await useVault.getState().runZhimoCovers({ ids: [a.id] })

    expect(res.ok + res.failed).toBe(0)
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
  })

  it('coverSource=manual 的资产：自动任务不碰（手动 refresh 仍会替换）', async () => {
    const manual = fixture({ coverSource: 'manual', cover: '我自己设的.jpg' })
    useVault.setState({ assets: [manual] })

    await useVault.getState().runZhimoCovers({ ids: [manual.id] })
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()

    modvault.fetchZhimoCover.mockResolvedValue(okResult)
    await useVault.getState().refreshZhimoCover(manual.id)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
    expect(useVault.getState().assets[0]!.coverSource).toBe('zhimo')
  })

  it('replacePacked=false → 包内 named 封面不被自动替换；true → 被替换', async () => {
    const namedAsset = fixture({ coverSource: 'named', cover: '包内官方预览.png' })
    useVault.setState({
      assets: [namedAsset],
      settings: settingsOf({ zhimoCover: true, zhimoCoverReplacePacked: false })
    })
    await useVault.getState().runZhimoCovers({ ids: [namedAsset.id] })
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()

    useVault.setState({
      settings: settingsOf({ zhimoCover: true, zhimoCoverReplacePacked: true })
    })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)
    await useVault.getState().runZhimoCovers({ ids: [namedAsset.id] })
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
  })

  it('busy 按资产记：自动批次全程 busyId=null，手动时 busyId=该 id、结束回 null', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })

    // ① 自动任务：**不点亮任何 loading**（全程静默是硬要求）
    const autoSeen: Array<string | null> = []
    modvault.fetchZhimoCover.mockImplementation(async () => {
      autoSeen.push(useVault.getState().zhimoCoverBusyId)
      return okResult
    })
    await useVault.getState().runZhimoCovers({ ids: [a.id] })
    expect(autoSeen).toEqual([null])
    expect(useVault.getState().zhimoCoverBusyId).toBeNull()

    // ② 手动：请求进行中 busyId 必须是这个资产，结束后必须清回 null
    const manualSeen: Array<string | null> = []
    modvault.fetchZhimoCover.mockImplementation(async () => {
      manualSeen.push(useVault.getState().zhimoCoverBusyId)
      return okResult
    })
    await useVault.getState().refreshZhimoCover(a.id)
    expect(manualSeen).toEqual([a.id])
    expect(useVault.getState().zhimoCoverBusyId).toBeNull()
  })

  it('busyId 只影响当前资产：别的资产在手动抓取时不受影响（不再有全局 loading）', async () => {
    const a = fixture({ coverSource: 'embedded' })
    const b = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a, b] })
    let during: string | null = 'unset'
    modvault.fetchZhimoCover.mockImplementation(async () => {
      during = useVault.getState().zhimoCoverBusyId
      return okResult
    })

    await useVault.getState().refreshZhimoCover(a.id)
    expect(during).toBe(a.id)
    expect(during).not.toBe(b.id)
  })

  it('重入保护：跑着的时候再调一次 → stopped=true，且不重复发请求', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })
    // 用对象持有 resolver：直接 `let release: (() => void) | null` 会被 TS 收窄成 never
    const gate: { release?: () => void } = {}
    modvault.fetchZhimoCover.mockImplementation(
      () =>
        new Promise<FetchZhimoCoverResult>((resolve) => {
          gate.release = () => resolve(okResult)
        })
    )

    const first = useVault.getState().runZhimoCovers({ ids: [a.id] })
    const second = await useVault.getState().runZhimoCovers({ ids: [a.id] })
    expect(second.stopped).toBe(true)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)

    gate.release?.()
    await first
  })

  // ── DEF-Z2 回归点：一批 >50 个模型，第 51 个起不能丢 ────────────────
  it('一批 60 个合法模型 → 60 个目标全部被抓（enqueue 不设上限 + pick 不按 50 截断）', async () => {
    await useVault.getState().init()
    const many = Array.from({ length: 60 }, (_, i) =>
      // 名字里必须带 6 位以上知末 ID；用 8 位前缀 + 两位序号保证唯一
      fixture({ name: `侘寂壁灯ID_1200166${String(100 + i)}`, coverSource: 'embedded' })
    )
    // 走真实事件路径：60 条 import:done 进 pending（验证 enqueue 不再在 50 处 return）
    for (const a of many) {
      importEventCb!({ item: a.id, itemName: a.name, status: 'done', asset: a })
    }
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    // sleep 注入即时桩（生产不传，走真实 250ms/2000ms 节流）
    const res = await useVault.getState().runZhimoCovers({ sleep: async () => {} })

    expect(res.ok).toBe(60)
    expect(res.failed).toBe(0)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(60)
    // 不是"只处理了前 50"：每一个都落库了
    expect(useVault.getState().assets).toHaveLength(60)
    expect(useVault.getState().assets.every((a) => a.coverSource === 'zhimo')).toBe(true)
  })

  it('60 个目标仍按 chunkSize=50 分块（节流不丢条目，块间 2000ms 只出现一次）', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      fixture({ name: `侘寂壁灯ID_1200166${String(200 + i)}`, coverSource: 'embedded' })
    )
    useVault.setState({ assets: many })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    const sleeps: number[] = []
    await useVault.getState().runZhimoCovers({
      ids: many.map((a) => a.id),
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })

    // 250 是请求间隔（59 次），2000 是 50→51 之间那一次块间间隔
    expect(sleeps.filter((ms) => ms === 2000)).toHaveLength(1)
    expect(sleeps.filter((ms) => ms === 250)).toHaveLength(59)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(60)
  })
})

describe('store.commitCover：三处共用（setCover / setCoverFromImage / zhimo）', () => {
  it('setCover（资产内挑图）→ 不产生重复 file 条目、体积不变、coverSource=manual', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })

    await useVault.getState().setCover(a.id, '资产.skp')

    const saved = putCalls.at(-1)!
    expect(saved.cover).toBe('资产.skp')
    expect(saved.coverSource).toBe('manual')
    // 同 rel 的旧条目被替换而不是追加
    expect(saved.files.filter((f) => f.rel === '资产.skp')).toHaveLength(1)
    expect(saved.files.find((f) => f.rel === '资产.skp')!.size).toBe(20)
    expect(saved.size).toBe(30)
  })

  it('setCoverFromImage → 新封面进 files、体积重算、coverSource=manual', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })
    modvault.setCoverImage.mockResolvedValue({ rel: '资产.cover.jpg', size: 500 })

    const ok = await useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'x' })
    expect(ok).toBe(true)

    const saved = putCalls.at(-1)!
    expect(saved.cover).toBe('资产.cover.jpg')
    expect(saved.coverSource).toBe('manual')
    expect(saved.files.map((f) => f.rel)).toContain('资产.cover.jpg')
    expect(saved.size).toBe(30 + 500)
  })
})

describe('store.refreshZhimoCover：手动路径（force + 可区分文案）', () => {
  it('成功 → notice 带分辨率「已从知末更新封面（400×300）」', async () => {
    const a = fixture({ coverSource: 'zhimo', cover: '旧.cover.jpg' })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    await useVault.getState().refreshZhimoCover(a.id)
    expect(useVault.getState().notice).toBe('已从知末更新封面（400×300）')
  })

  it('not-found → 文案能说明"知末上没有这个 ID 的页面"', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ok: false, reason: 'not-found' })

    await useVault.getState().refreshZhimoCover(a.id)
    expect(useVault.getState().notice).toContain('知末上没有这个 ID')
    expect(useVault.getState().notice).not.toContain('网络')
  })

  it('网络失败 → 文案提示稍后重试（与 not-found 不同）', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ok: false, reason: 'timeout' })

    await useVault.getState().refreshZhimoCover(a.id)
    expect(useVault.getState().notice).toContain('超时')
  })

  it('名字里没有 ID → 不发请求，直接给 no-id 文案', async () => {
    const a = fixture({ name: '北欧椅子' })
    useVault.setState({ assets: [a] })

    const res = await useVault.getState().refreshZhimoCover(a.id)
    expect(res).toEqual({ ok: false, reason: 'no-id' })
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toContain('没有知末 ID')
  })

  // ── DEF-Z8 第 4 条：自动占用该资产的锁时，手动**排队**而不是被拒绝 ───────
  it('自动批次占用该资产锁时，手动排队等待（不拒绝、不死锁）', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a], notice: null })

    const gate: { release?: () => void } = {}
    let calls = 0
    modvault.fetchZhimoCover.mockImplementation(() => {
      calls += 1
      // 只挡住第一发（自动），后面的手动立刻返回，避免测试自己把自己吊死
      if (calls === 1) {
        return new Promise<FetchZhimoCoverResult>((resolve) => {
          gate.release = () => resolve(okResult)
        })
      }
      return Promise.resolve(okResult)
    })
    const auto = useVault.getState().runZhimoCovers({ ids: [a.id] })
    expect(useVault.getState().zhimoCoverBusyId).toBeNull()

    // 手动点击：会排在该资产的锁后面（此时还没发请求）
    let manualDone = false
    const manual = useVault
      .getState()
      .refreshZhimoCover(a.id)
      .then((r) => {
        manualDone = true
        return r
      })
    await new Promise((r) => setTimeout(r, 5))
    expect(manualDone).toBe(false)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1) // 只有自动那一发

    gate.release?.()
    await auto
    const res = await manual
    expect(manualDone).toBe(true)
    // 锁释放后手动照常执行（force=true → 不被"已有 zhimo 封面"跳过）
    expect(res.ok).toBe(true)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(2)
  })

  it('手动与自动串行：两次写盘不会重叠（锁释放后手动才真正发起）', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })
    let inFlight = 0
    let maxInFlight = 0
    modvault.fetchZhimoCover.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return okResult
    })

    const auto = useVault.getState().runZhimoCovers({ ids: [a.id] })
    await new Promise((r) => setTimeout(r, 1))
    // 被锁挡住 → 排队（不是拒绝），auto 结束后才真正发起
    await useVault.getState().refreshZhimoCover(a.id)
    await auto
    // 再一次手动（此时锁空闲）
    await useVault.getState().refreshZhimoCover(a.id)

    // 三次写入（自动 1 + 手动 2）全程峰值并发 = 1：同一个资产永不双写
    expect(maxInFlight).toBe(1)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(3)
    expect(useVault.getState().notice).toBe('已从知末更新封面（400×300）')
  })

  it('手动不受开关约束：zhimoCover=false 时照样发请求', async () => {
    const a = fixture()
    useVault.setState({
      assets: [a],
      settings: settingsOf({ zhimoCover: false, zhimoCoverReplacePacked: false })
    })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    await useVault.getState().refreshZhimoCover(a.id)
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
    expect(useVault.getState().assets[0]!.coverSource).toBe('zhimo')
  })
})

// ══════════════════════════════════════════════════════════════════
// ④ DEF-Z8：同一资产的「写文件 + 写索引」是一个原子段（竞态复现）
// ══════════════════════════════════════════════════════════════════

describe('store.coverLock：DEF-Z8 竞态复现（方向 1 / 方向 2 / 峰值并发）', () => {
  /** 索引里的 cover 必须真实存在于 files —— 这是方向 1 的判据（不是看字段值） */
  function coverFileExists(asset: Asset): boolean {
    return !!asset.cover && asset.files.some((f) => f.rel === asset.cover)
  }

  it('方向 1：自动抓取进行中用户设封面 → 最终 cover 指向的文件必须在 files 里存在', async () => {
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a] })
    // 自动：100ms 才返回（模拟主进程抓取 + 落盘）
    modvault.fetchZhimoCover.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100))
      return { ...okResult, rel: '资产.cover.jpg', size: 1234 }
    })
    // 用户：20ms 后在自动的写事务中间插进来
    modvault.setCoverImage.mockResolvedValue({ rel: '我的.cover.jpg', size: 777 })

    const auto = useVault.getState().runZhimoCovers({ ids: [a.id] })
    await new Promise((r) => setTimeout(r, 20))
    const userOk = await useVault.getState().setCoverFromImage(a.id, {
      source: 'clipboard',
      data: 'x'
    })
    await auto

    expect(userOk).toBe(true)
    const after = useVault.getState().assets[0]!
    // 用户最后写 -> 用户赢（排队在自动之后，不是被拒绝）
    expect(after.coverSource).toBe('manual')
    expect(after.cover).toBe('我的.cover.jpg')
    // 判据：索引指向的文件必须存在（方向 1 的故障就是指向已被删的 F_zhimo）
    expect(coverFileExists(after)).toBe(true)
    // 自动那张已随「同族清理」被删，不能再作为 files 条目留着
    expect(after.files.some((f) => f.rel === '资产.cover.jpg')).toBe(false)
  })

  it('方向 2：排队期间用户事务已完成 -> 自动项进锁后重查发现 manual，直接放弃（零请求）', async () => {
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a] })

    // ① 先占住该资产的写锁（模拟另一个正在进行的写事务）
    const box: { open?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      box.open = () => resolve()
    })
    const holder = withAssetCoverLock(a.id, () => gate)

    // ② 此时 pick 已经把 a 选中（coverSource 仍是 embedded），fetchOne 在锁上排队
    const auto = useVault.getState().runZhimoCovers({ ids: [a.id] })

    // ③ 用户事务在 auto 拿到锁之前完成（等价于 setCoverFromImage 已跑完：
    //    cover=F_user、coverSource=manual、新文件已进 files）
    const userCover = '我的.cover.jpg'
    useVault.setState({
      assets: [
        {
          ...a,
          cover: userCover,
          coverSource: 'manual',
          files: [
            ...a.files,
            { rel: userCover, name: userCover, ext: 'jpg', size: 777, kind: 'texture' }
          ]
        }
      ]
    })

    box.open?.()
    await holder
    const res = await auto

    // 进锁后重查 -> 不抓、不写盘，计数落在 skipped（不是 failed）
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: 0, failed: 0, skipped: 1, stopped: false })

    const after = useVault.getState().assets[0]!
    expect(after.cover).toBe(userCover)
    expect(after.coverSource).toBe('manual')
    expect(coverFileExists(after)).toBe(true)
  })

  it('同一 id 同时发起 3 次写入（自动 + 2 次用户）-> 写事务峰值并发恒为 1', async () => {
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a] })
    let inFlight = 0
    let peak = 0
    const enter = () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
    }
    const leave = () => {
      inFlight -= 1
    }
    modvault.fetchZhimoCover.mockImplementation(async () => {
      enter()
      await new Promise((r) => setTimeout(r, 10))
      leave()
      return { ...okResult, rel: '资产.cover.jpg', size: 1234 }
    })
    let n = 0
    modvault.setCoverImage.mockImplementation(async () => {
      enter()
      await new Promise((r) => setTimeout(r, 10))
      leave()
      n += 1
      return { rel: `我的${n}.cover.jpg`, size: 700 + n }
    })

    await Promise.all([
      useVault.getState().runZhimoCovers({ ids: [a.id] }),
      useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'a' }),
      useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'b' })
    ])

    expect(peak).toBe(1)
    const after = useVault.getState().assets[0]!
    // 最后一次用户写入胜出，且文件真实存在
    expect(after.coverSource).toBe('manual')
    expect(coverFileExists(after)).toBe(true)
    expect(after.files.filter((f) => /\.cover\.[^./]+$/i.test(f.rel))).toHaveLength(1)
  })

  it('不死锁：setCoverFromImage / setCover 在锁内完成（超时即失败）', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })
    modvault.setCoverImage.mockResolvedValue({ rel: '我的.cover.jpg', size: 777 })

    const timeout = (label: string) =>
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} 死锁：超过 800ms 未返回`)), 800)
      })

    await expect(
      Promise.race([
        useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'x' }),
        timeout('setCoverFromImage')
      ])
    ).resolves.toBe(true)

    await expect(
      Promise.race([useVault.getState().setCover(a.id, '资产.skp'), timeout('setCover')])
    ).resolves.toBeUndefined()
  })

  it('一次写失败不会卡死后续同 id 写入', async () => {
    const a = fixture({ coverSource: 'embedded' })
    useVault.setState({ assets: [a] })
    modvault.setCoverImage
      .mockImplementationOnce(async () => {
        throw new Error('IPC 炸了')
      })
      .mockResolvedValue({ rel: '我的.cover.jpg', size: 777 })

    await expect(
      useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'x' })
    ).resolves.toBe(false) // 失败返回 false（不抛）
    await expect(
      useVault.getState().setCoverFromImage(a.id, { source: 'clipboard', data: 'y' })
    ).resolves.toBe(true) // 链没断

    expect(useVault.getState().assets[0]!.cover).toBe('我的.cover.jpg')
  })

  it('自动项被跳过时不发请求，也不点亮手动 loading（zhimo 来源，非 force）', async () => {
    // pick 阶段就会过滤掉 zhimo 来源，所以这里同样用"锁内重查"的路径来钉：
    // 排队期间资产变成 zhimo（等价于另一个批次刚抓完）。
    const a = fixture({ coverSource: 'embedded', cover: '预览图.jpg' })
    useVault.setState({ assets: [a] })

    const box: { open?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      box.open = () => resolve()
    })
    const holder = withAssetCoverLock(a.id, () => gate)
    const auto = useVault.getState().runZhimoCovers({ ids: [a.id] })

    useVault.setState({
      assets: [
        {
          ...a,
          cover: '别人抓的.cover.jpg',
          coverSource: 'zhimo',
          files: [
            ...a.files,
            { rel: '别人抓的.cover.jpg', name: '别人抓的.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
          ]
        }
      ],
      zhimoCoverBusyId: null
    })

    box.open?.()
    await holder
    const res = await auto

    expect(res.skipped).toBe(1)
    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
    expect(useVault.getState().zhimoCoverBusyId).toBeNull()
    expect(useVault.getState().notice).toBeNull() // 自动任务静默：跳过不出声
  })
})

describe('store：导入批次 → 自动抓取（事件驱动）', () => {
  it('import:done 收到 model + ID → batchDone 后触发一次抓取', async () => {
    const a = fixture({ name: '侘寂壁灯ID_1200166260', coverSource: 'embedded' })
    modvault.fetchZhimoCover.mockResolvedValue(okResult)

    await useVault.getState().init()
    expect(importEventCb).not.toBeNull()
    expect(batchDoneCb).not.toBeNull()

    // 模拟 main 推一条导入完成事件
    importEventCb!({ item: 'a.zip', itemName: 'a.zip', status: 'done', asset: a })
    expect(useVault.getState().assets.map((x) => x.id)).toEqual([a.id])

    batchDoneCb!()
    // scheduleZhimoCovers 是 setTimeout(0)：等一拍
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
    expect(modvault.fetchZhimoCover.mock.calls[0]![0]).toEqual({
      folder: a.folder,
      id: '1200166260'
    })
    expect(useVault.getState().assets[0]!.coverSource).toBe('zhimo')
  })

  it('import:done 收到非 model（贴图）→ 不进候选（batchDone 后零请求）', async () => {
    const t = fixture({ name: '木纹ID_1166965084', kind: 'texture', coverSource: 'embedded' })
    await useVault.getState().init()

    importEventCb!({ item: 't.zip', itemName: 't.zip', status: 'done', asset: t })
    batchDoneCb!()
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
  })

  it('import:done 收到 model 但名字里没有 ID → 不进候选', async () => {
    const a = fixture({ name: '北欧椅子', kind: 'model' })
    await useVault.getState().init()

    importEventCb!({ item: 'b.zip', itemName: 'b.zip', status: 'done', asset: a })
    batchDoneCb!()
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
  })

  it('P1：名字无 ID 但 asset.zhimoId 有值 → **入队并真的抓 1 次**（压缩包名场景）', async () => {
    // 用户样本：`现代壁灯ID_1232108421.rar` → 解包后 `…\现代壁灯\现代壁灯.skp`，
    // 资产名零 ID 痕迹。旧实现只看 asset.name → 永不入队 → 默认开启的自动补封面对它静默失效。
    const a = fixture({
      name: '现代壁灯',
      kind: 'model',
      folder: 'E:\\ModVault\\Library\\模型\\未分类\\未分类\\现代壁灯',
      coverSource: 'embedded',
      zhimoId: '1232108421'
    })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, rel: '现代壁灯.cover.jpg' })

    await useVault.getState().init()
    importEventCb!({
      item: '现代壁灯ID_1232108421.rar',
      itemName: '现代壁灯ID_1232108421.rar',
      status: 'done',
      asset: a
    })
    batchDoneCb!()
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1)
    expect(modvault.fetchZhimoCover.mock.calls[0]![0]).toEqual({
      folder: a.folder,
      id: '1232108421'
    })
  })

  it('P1：asset.zhimoId 为纯空白 → 视同没有 ID，不进候选', async () => {
    const a = fixture({ name: '北欧椅子', kind: 'model', zhimoId: '   ' })
    await useVault.getState().init()

    importEventCb!({ item: 'b2.zip', itemName: 'b2.zip', status: 'done', asset: a })
    batchDoneCb!()
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
  })

  it('开关关闭时导入 → 零请求（自动任务静默不抓）', async () => {
    const a = fixture({ coverSource: 'embedded' })
    modvault.getSettings.mockResolvedValue(settingsOf({ zhimoCover: false }))
    await useVault.getState().init()

    importEventCb!({ item: 'c.zip', itemName: 'c.zip', status: 'done', asset: a })
    batchDoneCb!()
    await new Promise((r) => setTimeout(r, 20))

    expect(modvault.fetchZhimoCover).not.toHaveBeenCalled()
  })
})

describe('store.rescan：zhimo 封面必须保活（docs/24 §4.9）', () => {
  function scanOf(asset: Asset, over: Partial<Asset> = {}): Asset {
    return {
      ...asset,
      // 主进程 rescan 生成新 UUID、thumbPath 空、封面回落到扫描值
      id: 'ffffffff-0000-4000-8000-000000000001',
      cover: '预览图.jpg',
      coverSource: 'embedded',
      thumbPath: undefined,
      thumbStatus: 'none',
      ...over
    }
  }

  it('coverSource=zhimo 且封面文件仍在 files → 重扫后仍是 zhimo、cover 不变', async () => {
    const local = fixture({
      coverSource: 'zhimo',
      cover: '资产.cover.jpg',
      files: [
        { rel: '资产.cover.jpg', name: '资产.cover.jpg', ext: 'jpg', size: 1234, kind: 'texture' },
        { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
      ]
    })
    useVault.setState({ assets: [local] })
    // 扫描侧：同一 folder，files 里仍然能看到那张 cover 文件
    modvault.rescan.mockResolvedValue({
      assets: [scanOf(local, { files: local.files })],
      ignored: []
    })

    await useVault.getState().rescan()

    const merged = useVault.getState().assets[0]!
    expect(merged.id).toBe(local.id)
    expect(merged.coverSource).toBe('zhimo')
    expect(merged.cover).toBe('资产.cover.jpg')
  })

  it('封面文件已被删（扫描的 files 里没有）→ 如实回落到扫描值', async () => {
    const local = fixture({ coverSource: 'zhimo', cover: '资产.cover.jpg' })
    useVault.setState({ assets: [local] })
    modvault.rescan.mockResolvedValue({
      assets: [scanOf(local, { files: [{ rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }] })],
      ignored: []
    })

    await useVault.getState().rescan()

    const merged = useVault.getState().assets[0]!
    expect(merged.coverSource).toBe('embedded')
    expect(merged.cover).toBe('预览图.jpg')
  })

  it('manual 封面语义不变（回归守卫）', async () => {
    const local = fixture({
      coverSource: 'manual',
      cover: '我自己设的.jpg',
      files: [
        { rel: '我自己设的.jpg', name: '我自己设的.jpg', ext: 'jpg', size: 88, kind: 'texture' },
        { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
      ]
    })
    useVault.setState({ assets: [local] })
    modvault.rescan.mockResolvedValue({
      assets: [scanOf(local, { files: local.files })],
      ignored: []
    })

    await useVault.getState().rescan()
    const merged = useVault.getState().assets[0]!
    expect(merged.coverSource).toBe('manual')
    expect(merged.cover).toBe('我自己设的.jpg')
  })
})

// ══════════════════════════════════════════════════════════════════
// ④ TODO-3：知末风格自动补空（落库路径）
// ══════════════════════════════════════════════════════════════════

describe('store：知末风格自动填充（只补空 / 只认词表 / 只对 model）', () => {
  it('styles 为空 + 站方 style 命中词表 → Dexie 落库 styles=[中古]，内存同步、封面不受影响', async () => {
    const a = fixture({ coverSource: 'embedded', styles: [] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, style: '中古' })

    const res = await useVault.getState().refreshZhimoCover(a.id)

    expect(res.ok).toBe(true)
    // commitCover（封面）+ applyZhimoStyle（风格）各一次 put
    expect(putCalls).toHaveLength(2)
    const saved = putCalls.at(-1)!
    expect(saved.id).toBe(a.id)
    expect(saved.styles).toEqual(['中古'])
    // 风格写入不能把封面改动覆盖回去
    expect(saved.cover).toBe(okResult.rel)
    expect(saved.coverSource).toBe('zhimo')
    expect(saved.size).toBe(10 + 20 + 1234)
    // 内存同步（网格/筛选立即生效）
    expect(useVault.getState().assets[0]!.styles).toEqual(['中古'])
  })

  it('资产已有 styles=[侘寂] → **不追加、不覆盖**（只有 commitCover 一次写库）', async () => {
    const a = fixture({ coverSource: 'embedded', styles: ['侘寂'] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, style: '现代' })

    const res = await useVault.getState().refreshZhimoCover(a.id)

    expect(res.ok).toBe(true)
    expect(putCalls).toHaveLength(1) // 只有封面那次
    expect(putCalls[0]!.styles).toEqual(['侘寂'])
    expect(useVault.getState().assets[0]!.styles).toEqual(['侘寂'])
  })

  it('站方词不在词表（赛博朋克）→ 不写 styles，并记一条 debug 日志（词表缺口可观测）', async () => {
    const a = fixture({ coverSource: 'embedded', styles: [] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, style: '赛博朋克' })

    const res = await useVault.getState().refreshZhimoCover(a.id)

    expect(res.ok).toBe(true) // 风格不认识不影响封面
    expect(useVault.getState().assets[0]!.styles).toEqual([])
    expect(putCalls).toHaveLength(1) // 只有封面
    expect(modvault.reportLog).toHaveBeenCalledWith({
      level: 'debug',
      message: 'zhimo:style-not-in-list',
      context: { id: a.id, style: '赛博朋克', kind: 'model' }
    })
  })

  it('素材/贴图（kind=texture）即使被强行塞进队列 → 不写 styles、也不记"词表缺口"', async () => {
    const a = fixture({ kind: 'texture', coverSource: 'embedded', styles: [] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, style: '现代' })

    await useVault.getState().runZhimoCovers({
      items: [{ id: a.id, zhimoId: '1200166260' }],
      force: true
    })

    expect(useVault.getState().assets[0]!.styles).toEqual([])
    expect(modvault.reportLog).not.toHaveBeenCalled()
  })

  it('站方没给风格（style=null）→ 封面照常成功、styles 不动、不打日志', async () => {
    const a = fixture({ coverSource: 'embedded', styles: [] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ...okResult, style: null })

    const res = await useVault.getState().refreshZhimoCover(a.id)

    expect(res.ok).toBe(true)
    expect(useVault.getState().assets[0]!.coverSource).toBe('zhimo')
    expect(useVault.getState().assets[0]!.styles).toEqual([])
    expect(modvault.reportLog).not.toHaveBeenCalled()
  })

  it('封面失败（not-found）→ 不碰 styles，也不写任何库', async () => {
    const a = fixture({ coverSource: 'embedded', styles: [] })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ok: false, reason: 'not-found' })

    const res = await useVault.getState().refreshZhimoCover(a.id)

    expect(res).toEqual({ ok: false, reason: 'not-found' })
    expect(putCalls).toHaveLength(0)
    expect(useVault.getState().assets[0]!.styles).toEqual([])
  })
})
