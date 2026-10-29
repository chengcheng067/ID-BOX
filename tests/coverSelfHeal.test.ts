/// <reference lib="dom" />
/**
 * 封面死锁自愈（0.8.3）—— 纯逻辑 + init 接线回归。
 *
 * ## 背景（外部用户 v0.8.2 实测，根因链定案）
 *
 * 0.8.1 重扫入库的资产：盘上根层有 `<x>.cover.jpg`，但当时 `pickCover` 不认
 * cover 文件 → 索引 `cover` 没指向它；0.8.2 补抓候选规则④见到"已有 cover 文件"
 * 又一律不重抓 → **补抓永远跳过**，一键重扫看起来就是坏的。
 *
 * ## 钉住的四件事
 *
 * ① `logic/coverSelfHeal.planCoverSelfHeal` 的重指口径：manual/zhimo 绝不动、
 *    只认根层 cover 文件、幂等（已指向就不出计划）、软删不参与；
 * ② folder 脱同步（重排/去重改名后 folder 未同步）→ 按 `relFolder` 重建的纯计划；
 * ③ init 接线：重指后 cover/coverSource/thumbStatus 的真实落库形状；
 * ④ init 接线：folder 重建前的 `probeSizes` 磁盘核实 —— 探得到才写，探不到
 *    WARN（带 folder）跳过，绝不把 folder 改写成盘上不存在的路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type AssetFile } from '../src/shared/types'
import {
  expectedAssetFolder,
  normalizeFolderPath,
  pickRootCoverRel,
  planCoverSelfHeal
} from '../src/renderer/logic/coverSelfHeal'

// ── 夹具 ──────────────────────────────────────────────────────────────

const MODEL_EXTS = new Set(['skp', 'max', 'fbx', 'obj', '3ds'])

function f(rel: string, ext: string, size = 1): AssetFile {
  return {
    rel,
    name: rel.slice(rel.lastIndexOf('/') + 1),
    ext,
    size,
    kind: MODEL_EXTS.has(ext) ? 'model' : 'texture'
  }
}

function asset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    name: '北欧布艺沙发ID_1232108421',
    kind: 'model',
    source: '',
    folder: 'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发',
    relFolder: '模型/家具/沙发/北欧布艺沙发',
    cover: '北欧布艺沙发.preview.jpg',
    coverSource: 'root',
    files: [
      f('北欧布艺沙发.skp', 'skp'),
      f('北欧布艺沙发.preview.jpg', 'jpg', 2)
    ],
    size: 3,
    category1: '家具',
    category2: '沙发',
    styles: [],
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    zhimoId: '1232108421',
    dedupeKey: 'model:北欧布艺沙发',
    importedAt: 1,
    updatedAt: 2,
    ...over
  }
}

/** 死锁主角：盘上有 cover 文件（已在 files 索引里），cover 字段却指着 preview 图 */
function deadlockAsset(over: Partial<Asset> = {}): Asset {
  return asset({
    files: [
      f('北欧布艺沙发.skp', 'skp'),
      f('北欧布艺沙发.preview.jpg', 'jpg', 2),
      f('北欧布艺沙发.cover.jpg', 'jpg', 400 * 300)
    ],
    ...over
  })
}

// ── ① pickRootCoverRel / planCoverSelfHeal：重指口径 ─────────────────

describe('pickRootCoverRel（与 pickCover ① 同口径）', () => {
  it('根层 cover 文件 → rel；多候选按字典序（pickCover 的裁定，不吃顺序）', () => {
    expect(pickRootCoverRel([f('a.cover.jpg', 'jpg'), f('b.cover.png', 'png')])).toBe('a.cover.jpg')
    expect(pickRootCoverRel([f('b.cover.png', 'png'), f('a.cover.jpg', 'jpg')])).toBe('a.cover.jpg')
  })

  it('预览词 / 普通图 / 子目录里的 cover 文件 → null', () => {
    expect(pickRootCoverRel([f('x.preview.jpg', 'jpg')])).toBeNull()
    expect(pickRootCoverRel([f('x.jpg', 'jpg')])).toBeNull()
    expect(pickRootCoverRel([f('Textures/x.cover.jpg', 'jpg')])).toBeNull()
    expect(pickRootCoverRel([])).toBeNull()
  })
})

describe('planCoverSelfHeal —— A 重指', () => {
  const LIB = 'E:\\Lib'

  it('死锁主场景：coverSource=root + 根层有 cover 文件 + cover 未指向 → 改指并标 named', () => {
    const plan = planCoverSelfHeal([deadlockAsset()], { libraryDir: LIB })
    expect(plan.repoints).toEqual([
      { id: 'asset-1', rel: '北欧布艺沙发.cover.jpg', source: 'named' }
    ])
  })

  it('manual / zhimo 绝不动（用户亲手设的 / 知末刚抓的）', () => {
    expect(
      planCoverSelfHeal([deadlockAsset({ coverSource: 'manual', cover: '自拍.png' })], { libraryDir: LIB })
        .repoints
    ).toEqual([])
    expect(
      planCoverSelfHeal([deadlockAsset({ coverSource: 'zhimo' })], { libraryDir: LIB }).repoints
    ).toEqual([])
  })

  it('幂等：cover 已指向 cover 文件 → 不出计划（embedded 等来源同样只看指向）', () => {
    expect(
      planCoverSelfHeal(
        [deadlockAsset({ cover: '北欧布艺沙发.cover.jpg', coverSource: 'named' })],
        { libraryDir: LIB }
      ).repoints
    ).toEqual([])
  })

  it('根层没有 cover 文件 → 不出计划（那是补抓通道的事，互不越界）', () => {
    expect(planCoverSelfHeal([asset()], { libraryDir: LIB }).repoints).toEqual([])
  })

  it('软删记录不参与（回收站目录已进 .trash/，重指只会对失效路径生成缩略图）', () => {
    const plan = planCoverSelfHeal([deadlockAsset({ deletedAt: 123 })], { libraryDir: LIB })
    expect(plan.repoints).toEqual([])
    expect(plan.folderResyncs).toEqual([])
  })
})

// ── ② folder 脱同步重建（C） ─────────────────────────────────────────

describe('normalizeFolderPath / expectedAssetFolder', () => {
  it('分隔符 / 大小写 / 尾分隔符归一（Windows 盘大小写不敏感，纯大小写差异不算脱同步）', () => {
    expect(normalizeFolderPath('E:\\Lib\\模型\\')).toBe('e:/lib/模型')
    expect(normalizeFolderPath('e:/lib/模型')).toBe('e:/lib/模型')
  })

  it('expectedAssetFolder = libraryDir + relFolder（posix 转本地分隔符，尾分隔符剥掉）', () => {
    expect(expectedAssetFolder('E:\\Lib\\', '模型/家具/沙发/北欧布艺沙发')).toBe(
      'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发'
    )
  })
})

describe('planCoverSelfHeal —— C folder 重建', () => {
  const LIB = 'E:\\Lib'

  it('folder 与 libraryDir+relFolder 不一致（改名后未同步）→ 重建 + 带探测用图片 rel', () => {
    const stale = asset({
      id: 'stale-1',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车-2',
      relFolder: '模型/家具/沙发/法拉利_款_跑车',
      files: [f('model.skp', 'skp'), f('tex.jpg', 'jpg')]
    })
    const plan = planCoverSelfHeal([stale], { libraryDir: LIB })
    expect(plan.folderResyncs).toEqual([
      { id: 'stale-1', folder: 'E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车', probeRel: 'tex.jpg' }
    ])
  })

  it('folder 一致（含大小写/分隔符差异）→ 不出计划；索引无图 → probeRel 为 null', () => {
    expect(
      planCoverSelfHeal([asset({ id: 'ok-1' })], { libraryDir: LIB }).folderResyncs
    ).toEqual([])
    expect(
      planCoverSelfHeal([asset({ id: 'ok-2', folder: 'e:/lib/模型/家具/沙发/北欧布艺沙发' })], {
        libraryDir: 'E:\\Lib\\'
      }).folderResyncs
    ).toEqual([])
    const noImage = asset({
      id: 'noimg',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\旧名',
      relFolder: '模型/家具/沙发/北欧布艺沙发',
      files: [f('model.skp', 'skp')]
    })
    expect(planCoverSelfHeal([noImage], { libraryDir: LIB }).folderResyncs).toEqual([
      { id: 'noimg', folder: 'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发', probeRel: null }
    ])
  })

  it('libraryDir 缺失（未选库）→ C 整段跳过（A 不受影响）', () => {
    const stale = asset({
      id: 'stale-2',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\旧名',
      relFolder: '模型/家具/沙发/北欧布艺沙发'
    })
    for (const libraryDir of [null, undefined, '', '   ']) {
      const plan = planCoverSelfHeal([stale, deadlockAsset()], { libraryDir })
      expect(plan.folderResyncs).toEqual([])
      expect(plan.repoints).toHaveLength(1)
    }
  })

  it('幂等：按计划重建后再算 → 空 folderResyncs', () => {
    const stale = asset({
      id: 'stale-3',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\旧名',
      relFolder: '模型/家具/沙发/北欧布艺沙发',
      files: []
    })
    const plan = planCoverSelfHeal([stale], { libraryDir: LIB })
    const after = stale.folder === plan.folderResyncs[0]!.folder ? stale : asset({ ...stale, folder: plan.folderResyncs[0]!.folder })
    expect(planCoverSelfHeal([after], { libraryDir: LIB }).folderResyncs).toEqual([])
  })
})

// ── ③④ init 接线（真实 store） ──────────────────────────────────────

const modvault = {
  rescan: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  chooseLibrary: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  deleteOneThumb: vi.fn(async () => true),
  // 盘上缩略图清单：按当前 rows 的 thumbPath 回（0.8.3 起 `[]` = "缓存真空"，
  // 会让存在性修复把 ready 记录置 none —— 本文件的用例都假设"缩略图还在"）。
  listThumbs: vi.fn(async () =>
    rows.filter((r) => r.thumbPath).map((r) => ({ name: r.thumbPath as string, size: 4096, mtimeMs: 0 }))
  ),
  probeSizes: vi.fn(),
  saveBallThumb: vi.fn(async () => null),
  fetchZhimoCover: vi.fn(),
  reportLog: vi.fn(),
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

const fakeAssets = {
  toArray: vi.fn(async () => rows.map((r) => ({ ...r }))),
  bulkGet: vi.fn(async (ids: readonly string[]) => ids.map((id) => rows.find((r) => r.id === id))),
  put: vi.fn(async (a: Asset) => {
    const i = rows.findIndex((r) => r.id === a.id)
    if (i >= 0) rows[i] = a
    else rows.push(a)
    return a.id
  }),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => {
    rows = rows.filter((r) => !ids.includes(r.id))
    return ids.length
  }),
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
  put: vi.fn(async (b: { id: string }) => b.id),
  toArray: vi.fn(async () => []),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })

const { useVault } = await import('../src/renderer/store')

const LIB_DIR = 'E:\\Lib'

beforeEach(() => {
  vi.clearAllMocks()
  rows = []
  modvault.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, libraryDir: LIB_DIR })
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  modvault.probeSizes.mockResolvedValue([])
  useVault.setState({ assets: [], notice: null })
})

describe('init 接线 —— 封面死锁自愈（A 重指）', () => {
  it('死锁资产：cover 改指 cover 文件、coverSource=named、缩略图置 none（DB 行 + 内存同步）', async () => {
    const dead = deadlockAsset({
      id: 'dead-1',
      thumbStatus: 'ready',
      thumbPath: 'dead-1-abcdef12.jpg'
    })
    rows = [dead]
    useVault.setState({ assets: [{ ...dead }] })

    await useVault.getState().init()

    const row = rows[0]!
    expect(row.cover).toBe('北欧布艺沙发.cover.jpg')
    expect(row.coverSource).toBe('named')
    expect(row.thumbStatus).toBe('none')
    expect(row.thumbPath).toBeUndefined()

    const mem = useVault.getState().assets[0]!
    expect(mem.cover).toBe('北欧布艺沙发.cover.jpg')
    expect(mem.coverSource).toBe('named')
    expect(mem.thumbStatus).toBe('none')
    expect(mem.thumbPath).toBeUndefined()
  })

  it('manual 封面原样保留；幂等：第二次 init 不再改动', async () => {
    const manual = deadlockAsset({
      id: 'manual-1',
      cover: '我的拍照.png',
      coverSource: 'manual',
      thumbStatus: 'ready',
      thumbPath: 'manual-1-abcdef12.jpg'
    })
    rows = [manual]
    useVault.setState({ assets: [{ ...manual }] })

    await useVault.getState().init()
    await useVault.getState().init()

    const row = rows[0]!
    expect(row.cover).toBe('我的拍照.png')
    expect(row.coverSource).toBe('manual')
    expect(row.thumbStatus).toBe('ready')
    expect(row.thumbPath).toBe('manual-1-abcdef12.jpg')
  })
})

describe('init 接线 —— folder 脱同步重建（C）', () => {
  it('probeSizes 探得到重建路径 → folder 落库为 libraryDir+relFolder（DB 行 + 内存同步）', async () => {
    const stale = asset({
      id: 'stale-1',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车-2',
      relFolder: '模型/家具/沙发/法拉利_款_跑车',
      files: [f('model.skp', 'skp'), f('tex.jpg', 'jpg')]
    })
    rows = [stale]
    useVault.setState({ assets: [{ ...stale }] })
    modvault.probeSizes.mockResolvedValue([{ rel: 'tex.jpg', w: 100, h: 100 }])

    await useVault.getState().init()

    expect(modvault.probeSizes).toHaveBeenCalledWith(
      'E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车',
      ['tex.jpg']
    )
    const row = rows[0]!
    expect(row.folder).toBe('E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车')
    expect(useVault.getState().assets[0]!.folder).toBe('E:\\Lib\\模型\\家具\\沙发\\法拉利_款_跑车')
  })

  it('probeSizes 探不到（子树真没了）→ folder 不动 + WARN 带 folder', async () => {
    const stale = asset({
      id: 'stale-2',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\旧名',
      relFolder: '模型/家具/沙发/北欧布艺沙发',
      files: [f('model.skp', 'skp'), f('tex.jpg', 'jpg')]
    })
    rows = [stale]
    useVault.setState({ assets: [{ ...stale }] })
    modvault.probeSizes.mockResolvedValue([])
    const reportLog = vi.fn()
    ;(modvault as unknown as { reportLog: typeof reportLog }).reportLog = reportLog

    await useVault.getState().init()

    const row = rows[0]!
    expect(row.folder).toBe('E:\\Lib\\模型\\家具\\沙发\\旧名')
    expect(reportLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'cover:folder-resync-missing',
        context: expect.objectContaining({ id: 'stale-2', folder: 'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发' })
      })
    )
  })

  it('索引无图可探 → 免探测直接重建（写失败会再走 WARN，自限）', async () => {
    const stale = asset({
      id: 'stale-3',
      folder: 'E:\\Lib\\模型\\家具\\沙发\\旧名',
      relFolder: '模型/家具/沙发/北欧布艺沙发',
      files: [f('model.skp', 'skp')]
    })
    rows = [stale]
    useVault.setState({ assets: [{ ...stale }] })

    await useVault.getState().init()

    expect(modvault.probeSizes).not.toHaveBeenCalled()
    expect(rows[0]!.folder).toBe('E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发')
  })
})

// ── ⑤ 补抓汇总文案：跳过明细分票（B） ────────────────────────────────

describe('runZhimoCoverBackfill —— 跳过明细分票展示（0.8.3 B）', () => {
  /** A 抓取期间改动 B 的索引（模拟"排队期间另一通道先到"的锁内重查竞态） */
  function patchB(patch: Partial<Asset>): void {
    useVault.setState((s) => ({
      assets: s.assets.map((a) => (a.id === 'b' ? { ...a, ...patch } : a))
    }))
  }

  it('锁内重查发现已有 cover 文件 → notice 单列「跳过 1（已有 cover 文件）」', async () => {
    const a = asset({ id: 'a', name: '沙发AID_1111111111', zhimoId: '1111111111' })
    const b = asset({ id: 'b', name: '沙发BID_2222222222', zhimoId: '2222222222' })
    useVault.setState({ assets: [a, b] })
    modvault.fetchZhimoCover.mockImplementation(async () => {
      patchB({
        files: [...b.files, f('沙发BID_2222222222.cover.jpg', 'jpg', 9)]
      })
      return { ok: true, rel: '沙发AID_1111111111.cover.jpg', size: 100, width: 400, height: 300 }
    })

    const summary = await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(summary).toMatchObject({ ok: 1, failed: 0, skipped: 1, total: 2 })
    expect(modvault.fetchZhimoCover).toHaveBeenCalledTimes(1) // B 一个请求都没发
    expect(useVault.getState().notice).toContain('成功 1 / 失败 0')
    expect(useVault.getState().notice).toContain('跳过 1（已有 cover 文件）')
    expect(useVault.getState().notice).not.toContain('手动封面')
  })

  it('锁内重查发现被用户接管 → notice 单列「跳过 1（手动封面）」', async () => {
    const a = asset({ id: 'a', name: '沙发AID_1111111111', zhimoId: '1111111111' })
    const b = asset({ id: 'b', name: '沙发BID_2222222222', zhimoId: '2222222222' })
    useVault.setState({ assets: [a, b] })
    modvault.fetchZhimoCover.mockImplementation(async () => {
      patchB({ cover: '自拍.png', coverSource: 'manual' })
      return { ok: true, rel: '沙发AID_1111111111.cover.jpg', size: 100, width: 400, height: 300 }
    })

    const summary = await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(summary).toMatchObject({ ok: 1, failed: 0, skipped: 1 })
    expect(useVault.getState().notice).toContain('跳过 1（手动封面）')
    expect(useVault.getState().notice).not.toContain('已有 cover 文件')
  })

  it('补抓写盘失败（write-failed）→ WARN 带 folder', async () => {
    const a = asset({ id: 'a', name: '沙发AID_1111111111', zhimoId: '1111111111' })
    useVault.setState({ assets: [a] })
    modvault.fetchZhimoCover.mockResolvedValue({ ok: false, reason: 'write-failed' })

    await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(modvault.reportLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'zhimo:cover-write-failed',
        context: expect.objectContaining({ id: 'a', folder: a.folder })
      })
    )
  })
})
