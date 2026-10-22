/// <reference lib="dom" />
/**
 * `store.rescan()` 的合并**方向**契约（2026-10 真机丢数据事故的回归锁）。
 *
 * ## 事故
 *
 * 0.7.2 上用户点击右键「刷新」→ `rescan()`。旧实现是"以磁盘扫描记录 `s` 为底、
 * 挑几个本地字段补"：`{...s, id, tags, note, source, importedAt, cover, ...}`。
 * 而 `main/rescan.ts` 产出的 `s` 里，用户字段全是占位默认值（`favorite:false` /
 * `rating:0` / `colorTag:null` / `styles:[]` / `note:''` / `source:''`）并且
 * **完全没有** `renderParams` / `renderShape`。于是：
 *
 * - 143 条里 127 条的 `renderParams` 消失（用户调了 5 次的 UV 全没了）；
 * - `favorite / rating / colorTag / styles` 被打回默认；
 * - `updatedAt` 被顶成"现在"（"最近修改"排序整库乱掉）；
 * - 37 条 `thumbPath` 被写成 `undefined` + `thumbStatus:'none'`（图文件还在盘上）。
 *
 * ## 修复后的契约（本文件逐键钉死）
 *
 * `Asset` 的**每一个**字段都必须显式归类为下面两类之一：
 * - `DISK_AUTHORITATIVE`：重扫真正该更新的（磁盘才是事实来源）；
 * - `LOCAL_PRESERVED`：重扫不是用户编辑，必须原样保留本地值。
 *
 * 归类是**编译期**强制的：`Asset` 新增字段而忘了归类 → 下面 `Record<Unclassified, true>`
 * 直接 typecheck 报错（`npm run typecheck:node` 会红），不依赖"记得改测试"。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset } from '../src/shared/types'
import type { IndexBackup } from '../src/renderer/db'

// ── ① 字段归类（两份名单，唯一事实来源） ────────────────────────────────

/**
 * 磁盘权威：重扫时会用扫描值覆盖本地值的字段。
 *
 * 其中 5 个（cover / coverSource / thumbPath / thumbStatus / zhimoId）带
 * **本地优先守卫**（手动/知末封面、已生成的缩略图、已有的知末 ID），
 * 只在守卫不成立时用磁盘值 —— 守卫行为在下面单独断言。
 */
const DISK_AUTHORITATIVE = [
  'kind',
  'name',
  'folder',
  'relFolder',
  'files',
  'size',
  'suVersion',
  'suMajor',
  'category1',
  'category2',
  'dedupeKey',
  'materialMeta',
  'cover',
  'coverSource',
  'thumbPath',
  'thumbStatus',
  'zhimoId'
] as const

/**
 * 本地保留：重扫**绝不**改动的字段。
 *
 * - `id`：合并键是 `folder`（主进程每次都生成新 UUID），主键必须沿用本地；
 * - `source / tags / note / favorite / rating / colorTag / styles / aliasOverride`：
 *   纯用户数据，磁盘上没有对应物；
 * - `renderParams / renderShape`：材质球调参，**主进程 rescan 根本不产出这两个字段**
 *   （本次事故的核心）；
 * - `mojibake`：乱码标记是**解压时**嗅探出来的，rescan 不采集 → 只能保留；
 * - `deletedAt / trashRel`：软删状态，重扫无权替用户还原/删除；
 * - `importedAt`：导入时间，磁盘上没有可比对的值；
 * - `updatedAt`：重扫不是用户编辑，改它会把「最近修改」排序整库顶到当下。
 */
const LOCAL_PRESERVED = [
  'id',
  'source',
  'mojibake',
  'styles',
  'renderParams',
  'renderShape',
  'deletedAt',
  'trashRel',
  'aliasOverride',
  'tags',
  'note',
  'favorite',
  'rating',
  'colorTag',
  'importedAt',
  'updatedAt'
] as const

/**
 * 编译期穷举：`Asset` 里任何一个键若没被上面两份名单覆盖，`Unclassified` 就不是
 * `never`，`Record<Unclassified, true>` 要求提供该键 → 这一行报错。
 *
 * （`Record<never, true>` 就是 `{}`，所以归类完整时 `{}` 恰好合法。）
 */
type ClassifiedKey = (typeof DISK_AUTHORITATIVE)[number] | (typeof LOCAL_PRESERVED)[number]
type UnclassifiedKey = Exclude<keyof Asset, ClassifiedKey>
const UNCLASSIFIED_KEYS_ARE_NONE: Record<UnclassifiedKey, true> = {}
void UNCLASSIFIED_KEYS_ARE_NONE

// ── ② 打桩：window.modvault + 内存版 Dexie（必须在 import store 之前） ──

const modvault = {
  rescan: vi.fn(),
  setSettings: vi.fn(),
  chooseLibrary: vi.fn(),
  pruneThumbs: vi.fn(),
  ensureThumb: vi.fn(),
  deleteThumb: vi.fn(),
  migrateLayout: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const bulkPutCalls: Asset[][] = []
const backupStore = new Map<string, IndexBackup>()

const fakeAssets = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list.map((a) => ({ ...a })))
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => [])
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

// ── ③ 夹具：一条"被用户调教过"的本地记录 + 同一位置的磁盘扫描记录 ────────

const FOLDER = 'E:\\Lib\\模型\\家具\\沙发\\北欧布艺沙发'
const LOCAL_UPDATED_AT = 1_650_000_000_000
const SCAN_UPDATED_AT = 1_700_000_999_000

/** 本地记录：每个本地保留字段都有"可辨识"的值，任何被磁盘值覆盖都会被抓到 */
function localAsset(): Asset {
  return {
    id: 'local-uuid',
    name: '本地名',
    kind: 'model',
    source: '知末网',
    folder: FOLDER,
    relFolder: '模型/家具/沙发/本地名',
    cover: '本地封面.jpg',
    coverSource: 'embedded', // 非 manual/zhimo → 不触发 sticky 守卫
    thumbPath: undefined, // 不触发缩略图守卫（守卫另有单独用例）
    thumbStatus: 'failed',
    files: [{ rel: '本地.skp', name: '本地.skp', ext: 'skp', size: 1, kind: 'model' }],
    size: 111,
    suVersion: 'SU 2022',
    suMajor: 2022,
    mojibake: true,
    category1: '家具',
    category2: '沙发',
    styles: ['现代', '侘寂'],
    materialMeta: undefined, // 磁盘有值 → 用磁盘
    renderParams: { roughness: 1.4, bump: 0.7, uv: 3.1, light: 1, metal: 0, alpha: 1 },
    renderShape: 'plane',
    deletedAt: undefined,
    trashRel: undefined,
    aliasOverride: '我的别名',
    tags: ['奶油', '侘寂'],
    note: '这是用户的备注',
    favorite: true,
    rating: 5,
    colorTag: 'red',
    zhimoId: null, // 空 → 允许磁盘兜底
    dedupeKey: 'model:本地名',
    importedAt: 1_600_000_000_000,
    updatedAt: LOCAL_UPDATED_AT
  }
}

/**
 * 主进程 rescan 的产出形状（与 `src/main/rescan.ts` 一致）：新 UUID、
 * 用户字段全是占位默认值、**没有** `renderParams` / `renderShape`。
 */
function scannedAsset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'scanned-uuid',
    name: '磁盘名',
    kind: 'texture',
    source: '',
    folder: FOLDER,
    relFolder: '材质/石材/水磨石/磁盘名',
    cover: '预览图.jpg',
    coverSource: 'largest',
    thumbPath: undefined,
    thumbStatus: 'none',
    files: [{ rel: '磁盘.jpg', name: '磁盘.jpg', ext: 'jpg', size: 2, kind: 'texture' }],
    size: 222,
    suVersion: 'SU 2024',
    suMajor: 2024,
    mojibake: undefined,
    category1: '石材',
    category2: '水磨石',
    styles: [],
    materialMeta: { name: '木纹', tags: ['wood'] },
    deletedAt: 999, // 极端值：证明重扫绝不把"删除态"从磁盘带进来
    trashRel: '.trash/scanned-uuid',
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    zhimoId: '1234567890',
    dedupeKey: 'texture:磁盘名',
    importedAt: 1,
    updatedAt: SCAN_UPDATED_AT,
    ...over
  }
}

beforeEach(() => {
  bulkPutCalls.length = 0
  backupStore.clear()
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  useVault.setState({ assets: [], notice: null, rescanBackupCount: 0 })
})

/** 跑一次真实的 `store.rescan()`，返回合并后的那一条记录 */
async function mergeOnce(local: Asset, scanned: Asset): Promise<Asset> {
  useVault.setState({ assets: [local] })
  modvault.rescan.mockResolvedValue({ assets: [scanned], ignored: [] })
  await useVault.getState().rescan()
  const merged = useVault.getState().assets
  expect(merged).toHaveLength(1)
  return merged[0]!
}

// ── ④ 归类完整性（运行时那半：互斥 + 不重复 + 覆盖全部 33 键） ──────────

describe('Asset 字段归类表 —— 完整性', () => {
  it('两份名单互不重叠、各无重复，且并集覆盖 Asset 的全部字段', () => {
    const disk = [...DISK_AUTHORITATIVE]
    const local = [...LOCAL_PRESERVED]

    // 无重复
    expect(new Set(disk).size).toBe(disk.length)
    expect(new Set(local).size).toBe(local.length)
    // 互斥：同一字段不能既"磁盘权威"又"本地保留"
    const overlap = disk.filter((k) => (local as string[]).includes(k))
    expect(overlap).toEqual([])
    // 覆盖：编译期已经保证（UnclassifiedKey 必须是 never），这里钉住总数防手滑删行
    expect(disk.length + local.length).toBe(33)
    expect(disk.length).toBe(17)
    expect(local.length).toBe(16)
  })
})

// ── ⑤ 逐字段行为：每个键都真的按归类走 ─────────────────────────────────

describe('store.rescan —— 以 local 为底，逐字段验证', () => {
  it('本地保留字段：磁盘值不同也不被覆盖（renderParams / 收藏 / 评分 / 风格 / updatedAt …）', async () => {
    const local = localAsset()
    const scanned = scannedAsset()
    const merged = await mergeOnce(local, scanned)

    const m = merged as unknown as Record<string, unknown>
    const l = local as unknown as Record<string, unknown>
    for (const key of LOCAL_PRESERVED) {
      expect(m[key], `本地保留字段 ${key} 被磁盘值覆盖了`).toEqual(l[key])
    }

    // 事故核心：调参必须原样在
    expect(merged.renderParams).toEqual({
      roughness: 1.4,
      bump: 0.7,
      uv: 3.1,
      light: 1,
      metal: 0,
      alpha: 1
    })
    expect(merged.renderShape).toBe('plane')
    expect(merged.favorite).toBe(true)
    expect(merged.rating).toBe(5)
    expect(merged.colorTag).toBe('red')
    expect(merged.styles).toEqual(['现代', '侘寂'])
    // 重扫不是用户编辑 → 「最近修改」时间戳不动
    expect(merged.updatedAt).toBe(LOCAL_UPDATED_AT)
    // 软删状态绝不从磁盘带进来（否则一次重扫等于替用户删库）
    expect(merged.deletedAt).toBeUndefined()
    expect(merged.trashRel).toBeUndefined()
    // 主键不漂移
    expect(merged.id).toBe('local-uuid')
  })

  it('磁盘权威字段：取扫描值（kind / name / files / size / 分类 / 去重键 / 元数据）', async () => {
    const local = localAsset()
    const scanned = scannedAsset()
    const merged = await mergeOnce(local, scanned)

    const m = merged as unknown as Record<string, unknown>
    const s = scanned as unknown as Record<string, unknown>
    for (const key of DISK_AUTHORITATIVE) {
      expect(m[key], `磁盘权威字段 ${key} 没用扫描值`).toEqual(s[key])
    }

    expect(merged.kind).toBe('texture')
    expect(merged.name).toBe('磁盘名')
    expect(merged.relFolder).toBe('材质/石材/水磨石/磁盘名')
    expect(merged.category1).toBe('石材')
    expect(merged.category2).toBe('水磨石')
    expect(merged.size).toBe(222)
    expect(merged.files.map((f) => f.rel)).toEqual(['磁盘.jpg'])
    expect(merged.materialMeta).toEqual({ name: '木纹', tags: ['wood'] })
    expect(merged.zhimoId).toBe('1234567890')
  })

  it('materialMeta：扫描侧没有值（json 读失败/被删）→ 保留本地已知值', async () => {
    const local = localAsset()
    local.materialMeta = { name: '本地材质', tags: ['stone'] }
    const scanned = scannedAsset({ materialMeta: undefined })

    const merged = await mergeOnce(local, scanned)
    expect(merged.materialMeta).toEqual({ name: '本地材质', tags: ['stone'] })
  })
})

// ── ⑥ 三个"本地优先守卫"（磁盘值不是无条件胜出） ───────────────────────

describe('store.rescan —— 本地优先守卫', () => {
  it('thumbStatus=ready 且有 thumbPath → 原样保留（**不再要求 cover 相等**）', async () => {
    const local = localAsset()
    local.thumbStatus = 'ready'
    local.thumbPath = 'e94039c0.jpg'
    // 磁盘侧封面变了，旧实现会因此把缩略图整片清空
    const scanned = scannedAsset()

    const merged = await mergeOnce(local, scanned)
    expect(merged.thumbPath).toBe('e94039c0.jpg')
    expect(merged.thumbStatus).toBe('ready')
    // 封面确实按磁盘值更新（封面变了由 regenThumbSweep 惰性升级，不在这里清空）
    expect(merged.cover).toBe('预览图.jpg')
  })

  it('本地没有可用缩略图（failed / 无 thumbPath）→ 如实采用磁盘状态（可被重新生成）', async () => {
    const local = localAsset()
    local.thumbStatus = 'failed'
    local.thumbPath = undefined
    const merged = await mergeOnce(local, scannedAsset())
    expect(merged.thumbPath).toBeUndefined()
    expect(merged.thumbStatus).toBe('none')
  })

  it('manual 封面且文件仍在磁盘文件清单里 → cover / coverSource 都用本地', async () => {
    const local = localAsset()
    local.coverSource = 'manual'
    local.cover = '我自己设的.jpg'
    local.files = [
      { rel: '我自己设的.jpg', name: '我自己设的.jpg', ext: 'jpg', size: 88, kind: 'texture' }
    ]
    const scanned = scannedAsset({ files: [{ ...local.files[0]! }] })

    const merged = await mergeOnce(local, scanned)
    expect(merged.cover).toBe('我自己设的.jpg')
    expect(merged.coverSource).toBe('manual')
  })

  it('zhimo 封面文件已被删（扫描清单里没有）→ 如实回落到磁盘封面', async () => {
    const local = localAsset()
    local.coverSource = 'zhimo'
    local.cover = '资产.cover.jpg'
    local.files = [{ rel: '本地.skp', name: '本地.skp', ext: 'skp', size: 1, kind: 'model' }]
    const scanned = scannedAsset()

    const merged = await mergeOnce(local, scanned)
    expect(merged.cover).toBe('预览图.jpg')
    expect(merged.coverSource).toBe('largest')
  })

  it('本地已有 zhimoId → 原样保留（导入时从压缩包名解析出的值磁盘上再也找不回来）', async () => {
    const local = localAsset()
    local.zhimoId = '9876543210'
    // 磁盘侧解析不出 ID（目录名里没有数字）→ 空
    const scanned = scannedAsset({ zhimoId: null })

    const merged = await mergeOnce(local, scanned)
    expect(merged.zhimoId).toBe('9876543210')
  })
})

// ── ⑦ 事故复现（一条构造数据的完整前后对比） ────────────────────────────

describe('事故复现：一次 rescan 之后用户调好的东西全在', () => {
  it('favorite / renderParams / updatedAt / thumbPath 都不再被冲掉', async () => {
    const local = localAsset()
    local.thumbStatus = 'ready'
    local.thumbPath = 'f1f775d9.jpg'
    local.favorite = true
    local.renderParams = { roughness: 1, bump: 1, uv: 0.3 }
    const scanned = scannedAsset()

    const merged = await mergeOnce(local, scanned)

    expect(merged).toMatchObject({
      id: 'local-uuid',
      favorite: true,
      rating: 5,
      colorTag: 'red',
      renderParams: { roughness: 1, bump: 1, uv: 0.3 },
      updatedAt: LOCAL_UPDATED_AT,
      thumbPath: 'f1f775d9.jpg',
      thumbStatus: 'ready',
      // 磁盘事实照常更新
      kind: 'texture',
      name: '磁盘名'
    })
    // 写库用的也是合并后的对象（不是扫描记录）
    expect(bulkPutCalls).toHaveLength(1)
    expect(bulkPutCalls[0]![0]!.renderParams).toEqual({ roughness: 1, bump: 1, uv: 0.3 })
  })

  it('磁盘上新增的资产（本地没有）→ 照旧整条采用扫描记录', async () => {
    const fresh = scannedAsset({ folder: 'E:\\Lib\\模型\\未分类\\未分类\\新资产', deletedAt: undefined, trashRel: undefined })
    useVault.setState({ assets: [] })
    modvault.rescan.mockResolvedValue({ assets: [fresh], ignored: [] })

    await useVault.getState().rescan()

    const merged = useVault.getState().assets[0]!
    expect(merged.id).toBe('scanned-uuid')
    expect(merged.updatedAt).toBe(SCAN_UPDATED_AT)
    expect(merged.favorite).toBe(false)
  })
})
