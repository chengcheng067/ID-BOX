/// <reference lib="dom" />
/**
 * 封面优先级 cover > preview（2026-10 用户裁定）+「一键重扫 · 从知末获取封面」的
 * 候选过滤回归锁。
 *
 * ## 背景
 *
 * 重装 ID BOX 后模型重扫，卡片默认封面选的是 `*.preview.jpg`（SKP 内嵌预览提取图）；
 * 但库内资产还常带 `*.cover.jpg`（知末抓取的真实主图）与 `*.cover.png`（用户拍照保存）。
 * 用户裁定：**有 cover（jpg/png）就用 cover，没有才用 preview**。
 *
 * ## 钉住的三件事
 *
 * ① `shared/classify.pickCover` 的自动候选排序：`.cover.(jpg|png)` > 预览词
 *    （含 `*.preview.*`）> root > embedded > largest；
 * ② 手动封面守卫：重扫合并的 `keepStickyCover` 不得被新排序的扫描值顶掉
 *    （0.7.2 修过的 bug 的变体，绝对不能回归）；
 * ③ 补抓编排的过滤口径：**只补没有 cover 文件的资产**（`isZhimoCoverBackfillCandidate`），
 *    已有 cover 文件 / manual 封面 / 非模型 / 无 ID / 软删的一律不抓。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isCoverAssetImage, pickCover } from '../src/shared/classify'
import type { Asset, AssetFile } from '../src/shared/types'

// ── ① pickCover：cover > preview ────────────────────────────────────────

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

describe('isCoverAssetImage（封面文件判定）', () => {
  it('只认 `<x>.cover.jpg/png` 这个受控后缀（大小写不敏感）', () => {
    expect(isCoverAssetImage('北欧沙发.cover.jpg')).toBe(true)
    expect(isCoverAssetImage('北欧沙发.cover.png')).toBe(true)
    expect(isCoverAssetImage('北欧沙发.cover.jpeg')).toBe(true)
    expect(isCoverAssetImage('北欧沙发.Cover.JPG')).toBe(true)
  })

  it('预览图 / 普通贴图 / 子目录里的同名巧合不算封面文件', () => {
    expect(isCoverAssetImage('北欧沙发.preview.jpg')).toBe(false)
    expect(isCoverAssetImage('my-cover-photo.jpg')).toBe(false)
    expect(isCoverAssetImage('cover.jpg')).toBe(false)
    expect(isCoverAssetImage('北欧沙发.cover')).toBe(false)
    expect(isCoverAssetImage('北欧沙发.cover.gif')).toBe(false)
  })
})

describe('pickCover —— cover > preview（2026-10 裁定）', () => {
  it('有 cover.jpg → 选它（用户报障的主场景：cover 与 preview 并存时不再看 readdir 顺序）', () => {
    const pick = pickCover([
      f('北欧沙发.skp', 'skp'),
      f('北欧沙发.preview.jpg', 'jpg'),
      f('北欧沙发.cover.jpg', 'jpg', 400 * 300)
    ])
    expect(pick).toEqual({ rel: '北欧沙发.cover.jpg', source: 'named' })
  })

  it('入参顺序反过来也一样（旧实现取 find() 的第一个会跟着目录顺序漂移）', () => {
    const pick = pickCover([
      f('北欧沙发.cover.jpg', 'jpg', 400 * 300),
      f('北欧沙发.preview.jpg', 'jpg'),
      f('北欧沙发.skp', 'skp')
    ])
    expect(pick?.rel).toBe('北欧沙发.cover.jpg')
  })

  it('cover.png（用户拍照保存）同样最优先', () => {
    const pick = pickCover([
      f('北欧沙发.preview.jpg', 'jpg'),
      f('北欧沙发.cover.png', 'png'),
      f('北欧沙发.skp', 'skp')
    ])
    expect(pick).toEqual({ rel: '北欧沙发.cover.png', source: 'named' })
  })

  it('只有 preview.jpg → 照旧走预览词（named），没有 cover 时行为不变', () => {
    const pick = pickCover([
      f('北欧沙发.skp', 'skp'),
      f('北欧沙发.preview.jpg', 'jpg')
    ])
    expect(pick).toEqual({ rel: '北欧沙发.preview.jpg', source: 'named' })
  })

  it('只有普通贴图 → 照旧 root 首图；cover 文件比字典序更靠前的 root 图优先', () => {
    expect(pickCover([f('b.jpg', 'jpg'), f('a.png', 'png')])).toEqual({ rel: 'a.png', source: 'root' })
    expect(pickCover([f('zzz.jpg', 'jpg'), f('aaa.cover.jpg', 'jpg')])?.rel).toBe('aaa.cover.jpg')
  })

  it('同时有 .cover.jpg 与 .cover.png → 按字典序确定性取一个（不吃 readdir 顺序）', () => {
    const files = [f('北欧沙发.cover.png', 'png'), f('北欧沙发.cover.jpg', 'jpg')]
    const a = pickCover(files)
    const b = pickCover([...files].reverse())
    expect(a).toEqual(b)
    expect(a?.rel).toBe('北欧沙发.cover.jpg')
  })

  it('子目录里的 cover 文件不参与（封面文件只认资产根目录层，与 named 同一层口径）', () => {
    const pick = pickCover([
      f('Textures/北欧沙发.cover.jpg', 'jpg', 400 * 300),
      f('root.jpg', 'jpg')
    ])
    expect(pick).toEqual({ rel: 'root.jpg', source: 'root' })
  })

  it('cover 文件也压过「最大图」与内嵌缩略图回退', () => {
    expect(
      pickCover([f('Textures/huge.jpg', 'jpg', 999999), f('x.cover.jpg', 'jpg')])?.rel
    ).toBe('x.cover.jpg')
    expect(
      pickCover([f('Textures/only.jpg', 'jpg', 10)], { embeddedThumbRel: 'Textures/only.jpg' })
        ?.source
    ).toBe('embedded')
    expect(
      pickCover([f('Textures/only.jpg', 'jpg', 10), f('x.cover.jpg', 'jpg')], {
        embeddedThumbRel: 'Textures/only.jpg'
      })?.rel
    ).toBe('x.cover.jpg')
  })

  it('纯模型包没有封面 → null（placeholder 口径不变）', () => {
    expect(pickCover([f('model.skp', 'skp')])).toBeNull()
  })
})

// ── ② 手动封面守卫：rescan 合并不被新排序顶掉 ───────────────────────────
//
// 新排序改变了 rescan 扫描值（scanned.cover 会变成 `<资产名>.cover.jpg`），
// 这里钉住：coverSource='manual' 的本地记录照样原样保留（0.7.2 bug 的变体）。

const modvault = {
  rescan: vi.fn(),
  setSettings: vi.fn(),
  chooseLibrary: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  deleteOneThumb: vi.fn(),
  migrateLayout: vi.fn()
}

;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault
}

const { db } = await import('../src/renderer/db')
const fakeAssets = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => [])
}
const fakeBackups = {
  put: vi.fn(async (b: { id: string }) => b.id),
  toArray: vi.fn(async () => []),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeAssets, configurable: true })
Object.defineProperty(db, 'backups', { value: fakeBackups, configurable: true })

const { useVault } = await import('../src/renderer/store')

const FOLDER = 'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发'

function manualAsset(): Asset {
  return {
    id: 'local-uuid',
    name: '北欧布艺沙发',
    kind: 'model',
    source: '',
    folder: FOLDER,
    relFolder: '模型/家具/沙发/北欧布艺沙发',
    cover: '我的拍照封面.png',
    coverSource: 'manual',
    files: [
      { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
      { rel: '北欧布艺沙发.preview.jpg', name: '北欧布艺沙发.preview.jpg', ext: 'jpg', size: 2, kind: 'texture' },
      { rel: '我的拍照封面.png', name: '我的拍照封面.png', ext: 'png', size: 3, kind: 'texture' }
    ],
    size: 6,
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
    updatedAt: 2
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  useVault.setState({ assets: [], notice: null, rescanBackupCount: 0 })
})

describe('手动封面守卫：cover > preview 的新扫描值不得顶掉 manual', () => {
  it('重扫扫描值按新排序选中了 `<资产名>.cover.jpg` → 本地 manual 封面原样保留', async () => {
    const local = manualAsset()
    // 主进程 rescan 走 pickCover：根层同时有 preview 与 cover 文件 → 新排序会给出 cover 文件
    const scanned: Asset = {
      ...local,
      id: 'scanned-uuid',
      cover: '北欧布艺沙发.cover.jpg',
      coverSource: 'named',
      files: [
        ...local.files,
        { rel: '北欧布艺沙发.cover.jpg', name: '北欧布艺沙发.cover.jpg', ext: 'jpg', size: 4, kind: 'texture' }
      ],
      updatedAt: 999
    }
    useVault.setState({ assets: [local] })
    modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })

    await useVault.getState().rescan()

    const merged = useVault.getState().assets[0]!
    expect(merged.cover).toBe('我的拍照封面.png')
    expect(merged.coverSource).toBe('manual')
  })

  it('非 manual（embedded 等）不受守卫保护 → 采用磁盘新排序的值（磁盘权威语义不变）', async () => {
    const local = manualAsset()
    local.coverSource = 'embedded'
    local.cover = '北欧布艺沙发.preview.jpg'
    const scanned: Asset = {
      ...local,
      id: 'scanned-uuid',
      cover: '北欧布艺沙发.cover.jpg',
      coverSource: 'named'
    }
    useVault.setState({ assets: [local] })
    modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })

    await useVault.getState().rescan()

    const merged = useVault.getState().assets[0]!
    expect(merged.cover).toBe('北欧布艺沙发.cover.jpg')
    expect(merged.coverSource).toBe('named')
  })
})

// ── ③ 一键重扫 · 从知末获取封面：只补没有 cover 文件的资产 ───────────────

const { isZhimoCoverBackfillCandidate, hasCoverAssetFile } = await import(
  '../src/renderer/logic/zhimoCover'
)

function modelAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    name: '北欧布艺沙发ID_1232108421',
    kind: 'model',
    source: '',
    folder: 'E:\\Lib\\模型\\未分类\\未分类\\北欧布艺沙发',
    relFolder: '模型/未分类/未分类/北欧布艺沙发',
    cover: '北欧布艺沙发.preview.jpg',
    coverSource: 'embedded',
    files: [
      { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
      { rel: '北欧布艺沙发.preview.jpg', name: '北欧布艺沙发.preview.jpg', ext: 'jpg', size: 2, kind: 'texture' }
    ],
    size: 3,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    zhimoId: null,
    dedupeKey: 'model:北欧布艺沙发',
    importedAt: 1,
    updatedAt: 2,
    ...over
  }
}

describe('hasCoverAssetFile（根层 cover 文件判定）', () => {
  it('根层的 .cover.jpg/png 算"已有"，子目录里的同名巧合不算', () => {
    expect(
      hasCoverAssetFile([
        { rel: '北欧布艺沙发.cover.jpg' },
        { rel: 'Textures/别的.cover.jpg' }
      ])
    ).toBe(true)
    expect(hasCoverAssetFile([{ rel: 'Textures/北欧布艺沙发.cover.jpg' }])).toBe(false)
    expect(hasCoverAssetFile([{ rel: '北欧布艺沙发.preview.jpg' }])).toBe(false)
    expect(hasCoverAssetFile([])).toBe(false)
  })
})

describe('isZhimoCoverBackfillCandidate（无 cover 才抓的编排过滤）', () => {
  it('模型 + 无 cover 文件 + 能取到 ID → 候选（这正是重装重扫后的典型资产）', () => {
    expect(isZhimoCoverBackfillCandidate(modelAsset())).toBe(true)
  })

  it('ID 优先 asset.zhimoId，为空时按资产名解析', () => {
    expect(isZhimoCoverBackfillCandidate(modelAsset({ zhimoId: '1168792999' }))).toBe(true)
    expect(isZhimoCoverBackfillCandidate(modelAsset({ name: '无 ID 的资产' }))).toBe(false)
  })

  it('已有 cover 文件（jpg / png）→ 不是候选（用户裁定：不重抓已有的）', () => {
    expect(
      isZhimoCoverBackfillCandidate(
        modelAsset({
          files: [
            { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
            { rel: '北欧布艺沙发.cover.jpg', name: '北欧布艺沙发.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
          ]
        })
      )
    ).toBe(false)
    expect(
      isZhimoCoverBackfillCandidate(
        modelAsset({
          files: [
            { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
            { rel: '北欧布艺沙发.cover.png', name: '北欧布艺沙发.cover.png', ext: 'png', size: 9, kind: 'texture' }
          ]
        })
      )
    ).toBe(false)
  })

  it('manual 封面 → 永远不是候选（它的 cover 文件可以不是 .cover. 命名，必须单独挡）', () => {
    expect(
      isZhimoCoverBackfillCandidate(modelAsset({ coverSource: 'manual', cover: '自拍.png' }))
    ).toBe(false)
  })

  it('非 model / 软删记录 → 不是候选', () => {
    expect(isZhimoCoverBackfillCandidate(modelAsset({ kind: 'texture' }))).toBe(false)
    expect(isZhimoCoverBackfillCandidate(modelAsset({ deletedAt: 123 }))).toBe(false)
  })

  it('已有 zhimo 封面 → 天然被「已有 cover 文件」过滤（zhimo 封面落盘就是 .cover.jpg）', () => {
    expect(
      isZhimoCoverBackfillCandidate(
        modelAsset({
          coverSource: 'zhimo',
          cover: '北欧布艺沙发.cover.jpg',
          files: [
            { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
            { rel: '北欧布艺沙发.cover.jpg', name: '北欧布艺沙发.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
          ]
        })
      )
    ).toBe(false)
  })
})

// ── ④ 编排层：跑一次真实的 runZhimoCoverBackfill（注入桩，零真实网络） ──

const fetchZhimoCoverMock = vi.fn()
const reportLogMock = vi.fn()

Object.assign(modvault, {
  fetchZhimoCover: fetchZhimoCoverMock,
  reportLog: reportLogMock
})

describe('runZhimoCoverBackfill（编排过滤 + 落库）', () => {
  it('只对没有 cover 文件的资产发请求；已有 cover 文件的资产一个请求都不发', async () => {
    const needFetch = modelAsset({ id: 'need-fetch', name: '沙发AID_1111111111' })
    const alreadyHas = modelAsset({
      id: 'already-has',
      name: '沙发BID_2222222222',
      cover: '沙发BID_2222222222.cover.jpg',
      coverSource: 'zhimo',
      files: [
        { rel: '沙发BID_2222222222.skp', name: '沙发BID_2222222222.skp', ext: 'skp', size: 1, kind: 'model' },
        { rel: '沙发BID_2222222222.cover.jpg', name: '沙发BID_2222222222.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
      ]
    })
    const manual = modelAsset({ id: 'manual-one', name: '沙发CID_3333333333', coverSource: 'manual', cover: '自拍.png' })
    useVault.setState({ assets: [needFetch, alreadyHas, manual] })

    fetchZhimoCoverMock.mockResolvedValue({
      ok: true,
      rel: '沙发AID_1111111111.cover.jpg',
      size: 100,
      width: 400,
      height: 300
    })

    const summary = await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(summary).toMatchObject({ ok: 1, failed: 0, skipped: 0, stopped: false, total: 1 })
    expect(fetchZhimoCoverMock).toHaveBeenCalledTimes(1)
    expect(fetchZhimoCoverMock.mock.calls[0]![0]).toMatchObject({
      folder: needFetch.folder,
      id: '1111111111'
    })

    // 成功后按 zhimo 封面落库（cover / coverSource / files 同步更新）
    const updated = useVault.getState().assets.find((a) => a.id === 'need-fetch')!
    expect(updated.cover).toBe('沙发AID_1111111111.cover.jpg')
    expect(updated.coverSource).toBe('zhimo')
    expect(updated.files.some((x) => x.rel === '沙发AID_1111111111.cover.jpg')).toBe(true)

    // 汇总 notice（成功 X / 失败 Y 口径）
    expect(useVault.getState().notice).toContain('成功 1')
    expect(useVault.getState().notice).toContain('失败 0')
    // 日志留痕
    expect(reportLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'zhimo:cover-backfill' })
    )

    // 状态复位
    expect(useVault.getState().zhimoCoverBackfill).toMatchObject({
      running: false,
      cancelRequested: false
    })
  })

  it('没有候选 → 不发任何请求，只给一句 notice', async () => {
    // 唯一资产已有 cover 文件 → 无候选
    useVault.setState({
      assets: [
        modelAsset({
          cover: '北欧布艺沙发.cover.jpg',
          coverSource: 'zhimo',
          files: [
            { rel: '北欧布艺沙发.skp', name: '北欧布艺沙发.skp', ext: 'skp', size: 1, kind: 'model' },
            { rel: '北欧布艺沙发.cover.jpg', name: '北欧布艺沙发.cover.jpg', ext: 'jpg', size: 9, kind: 'texture' }
          ]
        })
      ]
    })
    fetchZhimoCoverMock.mockClear()

    const summary = await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(summary.total).toBe(0)
    expect(fetchZhimoCoverMock).not.toHaveBeenCalled()
    expect(useVault.getState().notice).toContain('没有需要从知末补封面的资产')
  })

  it('抓取失败计入 failed，不中断整批', async () => {
    const a = modelAsset({ id: 'fail-one', name: '沙发AID_1111111111' })
    const b = modelAsset({ id: 'ok-one', name: '沙发BID_2222222222' })
    useVault.setState({ assets: [a, b] })
    fetchZhimoCoverMock.mockImplementation((payload: { id: string }) =>
      payload.id === '1111111111'
        ? Promise.resolve({ ok: false, reason: 'not-found' })
        : Promise.resolve({ ok: true, rel: '沙发BID_2222222222.cover.jpg', size: 50 })
    )

    const summary = await useVault.getState().runZhimoCoverBackfill({
      sleep: () => Promise.resolve()
    })

    expect(summary).toMatchObject({ ok: 1, failed: 1, total: 2 })
    expect(fetchZhimoCoverMock).toHaveBeenCalledTimes(2)
    expect(useVault.getState().notice).toContain('成功 1')
    expect(useVault.getState().notice).toContain('失败 1')
  })
})
