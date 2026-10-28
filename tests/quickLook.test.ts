/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   必须把 DOM lib 挂进本程序，否则 typecheck:node 会在 store.ts/db.ts 报 "Cannot find name 'window'"。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset } from '../src/shared/types'
import { DEFAULT_FILTERS } from '../src/renderer/logic/filters'
import {
  decideQuickLookKey,
  quickLookImageFile,
  quickLookImageUrl,
  quickLookIndexInSequence,
  quickLookSequence,
  resolveQuickLookTarget,
  stepSequence,
  type QuickLookContext
} from '../src/renderer/logic/quickLook'
import { decideEsc } from '../src/renderer/logic/escPriority'
import { vaultUrl } from '../src/shared/format'

/**
 * 0.8.3 Quick Look（空格全屏快览，docs/32 §4 + docs/33「比素材」的快路径）。
 *
 * 这里钉的是**判据本身**，不是组件渲染：
 * ① `logic/quickLook.ts` 的纯函数 —— 按空格开哪一张（target 优先级）、←/→ 在哪个序列里走、
 *    到边界不 wrap；
 * ② store 的 `quickLookAssetId` —— 陈旧 id 守卫 + 5 个清理站点（硬删 / 软删 / 彻底删除 /
 *    rescan / 进回收站）必须逐字同 `folderViewAssetId` 模式置 null；
 * ③ `decideEsc` 的 `close-quick-look` 优先级（含"**关浮层不清选中**"）。
 *
 * 为什么必须在 store 层测清理站点：组件里读的是 `assets.find(id)`，如果 action 忘了置 null，
 * 浮层会显示一条已经不在当前视图序列里的资产 —— `n / m` 停在 `-1`、箭头按不动，且用户
 * 以为"还在库里"。这类漂移在组件测试里看不见，只有在 action 层能钉住。
 *
 * 桩：`window.modvault` + 内存版假 Dexie Table（与 `deleteFlowFix.test.ts` / `rescanSafety.test.ts`
 * 同款），驱动**真实的 store action**。
 */

const modvault = {
  rescan: vi.fn(),
  trashPaths: vi.fn(),
  softDeleteAssets: vi.fn(),
  purgeAssets: vi.fn(),
  deleteThumb: vi.fn().mockResolvedValue(0),
  pruneThumbs: vi.fn().mockResolvedValue(0),
  ensureThumb: vi.fn().mockResolvedValue(null),
  migrateLayout: vi.fn().mockResolvedValue({ ok: [], failed: [] })
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const fakeAssets = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  toArray: vi.fn(async () => [])
}
const fakeBackups = {
  put: vi.fn(async (b: unknown) => 'backup'),
  toArray: vi.fn(async () => []),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
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
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [
      { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: '资产.skp', name: '资产.skp', ext: 'skp', size: 20, kind: 'model' }
    ],
    size: 30,
    tags: [],
    note: '',
    styles: [],
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    ...over
  }
}

/** 判据输入（默认：无文件视图、无焦点、无选中、可见序 = 传入 id 原序） */
function ctxOf(over: Partial<QuickLookContext> = {}): QuickLookContext {
  return { focusId: null, selectedIds: [], folderViewAssetId: null, visibleOrder: [], ...over }
}

/** Esc 判据输入（默认：没有任何可关的东西） */
const IDLE = {
  modalOpen: false,
  hdrPreviewOpen: false,
  pendingDelete: false,
  renameOpen: false,
  categoryPickerOpen: false,
  settingsOpen: false,
  folderViewOpen: false,
  quickLookOpen: false,
  hasSelection: false
}

beforeEach(() => {
  vi.clearAllMocks()
  modvault.pruneThumbs.mockResolvedValue(0)
  modvault.ensureThumb.mockResolvedValue(null)
  modvault.deleteThumb.mockResolvedValue(0)
  modvault.migrateLayout.mockResolvedValue({ ok: [], failed: [] })
  useVault.setState({
    assets: [],
    settings: { ...DEFAULT_SETTINGS },
    filters: { ...DEFAULT_FILTERS },
    libraryView: 'assets',
    selectedId: null,
    selectedIds: [],
    quickLookAssetId: null,
    folderViewAssetId: null,
    notice: null,
    pendingDelete: null
  })
})

// ── ① target 优先级（文件视图 > 焦点卡所在选中项 > 选中集第一 > 可见第一 > null）──

describe('Quick Look · target 解析优先级', () => {
  it('文件视图资产优先：即使有选中集，按空格要的是"正在看的那个文件夹"', () => {
    const order = ['a', 'b', 'c']
    expect(
      resolveQuickLookTarget(ctxOf({ focusId: 'b', selectedIds: ['b'], folderViewAssetId: 'a', visibleOrder: order }))
    ).toBe('a')
  })

  it('文件视图资产不在当前可见集（被筛掉）→ 退到下一级，不能选一个看不见的目标', () => {
    const order = ['b', 'c']
    expect(
      resolveQuickLookTarget(ctxOf({ focusId: 'b', selectedIds: ['b'], folderViewAssetId: 'a', visibleOrder: order }))
    ).toBe('b')
  })

  it('焦点卡属于选中集 → 开焦点卡这一张（单选的常态）', () => {
    const order = ['a', 'b', 'c']
    expect(resolveQuickLookTarget(ctxOf({ focusId: 'b', selectedIds: ['b'], visibleOrder: order }))).toBe('b')
  })

  it('焦点卡不在选中集（框选了别的卡）→ 退到"选中集按可见顺序第一个"，不把没选中的卡当目标', () => {
    const order = ['a', 'b', 'c']
    expect(resolveQuickLookTarget(ctxOf({ focusId: 'a', selectedIds: ['c', 'b'], visibleOrder: order }))).toBe('b')
  })

  it('焦点卡不可见（选中集里的卡被筛掉）→ 退到可见的那个', () => {
    const order = ['b', 'c']
    expect(resolveQuickLookTarget(ctxOf({ focusId: 'a', selectedIds: ['a', 'c'], visibleOrder: order }))).toBe('c')
  })

  it('没有任何选中 → 可见序列第一张（至少给一个可看的目标）', () => {
    expect(resolveQuickLookTarget(ctxOf({ visibleOrder: ['x', 'y', 'z'] }))).toBe('x')
  })

  it('可见集为空 → null（调用方不该开浮层）', () => {
    expect(resolveQuickLookTarget(ctxOf({ focusId: 'a', selectedIds: ['a'], visibleOrder: [] }))).toBeNull()
  })

  it('选中集传入顺序与可见顺序不一致时按可见顺序重排（区间顺序 = 当前可见顺序）', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(quickLookSequence(ctxOf({ selectedIds: ['d', 'a'], visibleOrder: order }))).toEqual(['a', 'd'])
  })

  it('去重 + 剔除空 id（同一 id 传两次不会让序列变长）', () => {
    const order = ['a', 'b']
    expect(quickLookSequence(ctxOf({ selectedIds: ['b', 'b', 'a', ''], visibleOrder: order }))).toEqual(['a', 'b'])
  })
})

// ── ② 序列口径：选中集 ≥2 = 选中集；否则整个可见序列 ─────────────

describe('Quick Look · ←/→ 的序列', () => {
  it('选中集 ≥2 → 序列就是选中集（"这几张比一比"的范围）', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(quickLookSequence(ctxOf({ selectedIds: ['b', 'd'], visibleOrder: order }))).toEqual(['b', 'd'])
  })

  it('单选（选中集只有 1 项）→ 走整个可见序列（单卡按箭头就是往下扫库）', () => {
    const order = ['a', 'b', 'c']
    expect(quickLookSequence(ctxOf({ selectedIds: ['b'], visibleOrder: order }))).toEqual(['a', 'b', 'c'])
  })

  it('选中集里不可见的 id 被剔除（改筛选后箭头不能跳到已经不可见的资产）', () => {
    const order = ['b', 'c']
    // 可见的选中只剩 1 项 → 达不到"≥2 才按选中集"的门槛，回退到整个可见序列；
    // 关键是不含已被筛掉的 'a'
    const seq = quickLookSequence(ctxOf({ selectedIds: ['a', 'c'], visibleOrder: order }))
    expect(seq).toEqual(['b', 'c'])
    expect(seq).not.toContain('a')
  })

  it('选中集 ≥2 但其中一项被筛掉 → 序列只保留可见的那几项（按可见顺序）', () => {
    const order = ['b', 'c', 'd']
    expect(quickLookSequence(ctxOf({ selectedIds: ['a', 'd', 'c'], visibleOrder: order }))).toEqual(['c', 'd'])
  })

  it('空可见集 → 空序列（没有可走的目标）', () => {
    expect(quickLookSequence(ctxOf({ selectedIds: ['a'], visibleOrder: [] }))).toEqual([])
  })

  it('序列里的位置：命中给下标，找不到给 -1（显示 ? / m 而不是骗人的 1/m）', () => {
    const seq = ['a', 'b', 'c']
    expect(quickLookIndexInSequence(seq, 'b')).toBe(1)
    expect(quickLookIndexInSequence(seq, 'z')).toBe(-1)
  })
})

// ── ③ prev / next：到边界不 wrap ──────────────────────────────────

describe('Quick Look · 步进不 wrap', () => {
  const seq = ['a', 'b', 'c']

  it('中间位置 ±1 正常前进 / 后退', () => {
    expect(stepSequence(seq, 1, 1)).toBe('c')
    expect(stepSequence(seq, 1, -1)).toBe('a')
  })

  it('首位按 ←：夹在原地（返回原 id），不绕到末尾', () => {
    expect(stepSequence(seq, 0, -1)).toBe('a')
  })

  it('末位按 →：夹在原地，不绕到第一张', () => {
    expect(stepSequence(seq, 2, 1)).toBe('c')
  })

  it('位置未知（-1 / 越界）→ null：宁可不动，也不要猜一个', () => {
    expect(stepSequence(seq, -1, 1)).toBeNull()
    expect(stepSequence(seq, 5, -1)).toBeNull()
    expect(stepSequence([], 0, 1)).toBeNull()
  })

  it('delta 非法（NaN / 0）→ 停在当前位置', () => {
    expect(stepSequence(seq, 1, Number.NaN)).toBe('b')
    expect(stepSequence(seq, 1, 0)).toBe('b')
  })
})

// ── ④ 取图口径：原图优先，缺失回退，不手拼 vault:// ──────────────

describe('Quick Look · 封面取图（原图 → peek → 缩略图 → 占位）', () => {
  it('有封面 → 用原图 URL（拼 relFolder + ?v=updatedAt 破缓存），不是缩略图', () => {
    const a = fixture()
    // 口径对齐 `DetailPanel.tsx:381-382`：cover 相对资产目录，vault://asset 相对库根
    expect(quickLookImageUrl(a)).toBe(vaultUrl(`${a.relFolder}/${a.cover}`, a.updatedAt))
    expect(quickLookImageUrl(a)).toContain('vault://asset/')
    expect(quickLookImageUrl(a)).not.toContain('vault://thumb/')
  })

  it('封面必须拼上 relFolder（vault://asset 相对库根，不是资产目录）—— 与 DetailPanel.tsx:381-382 同口径', () => {
    // 0.8.3 真机验收的原始缺陷：只编 cover、丢掉 relFolder → vault://asset/ball.cover.png
    // 在库根找不到这个文件 → 404 → 浮层退占位图标（"开着但什么都没显示"）。
    const a = fixture({ cover: 'ball.cover.png', relFolder: '材质/未分类/未分类/资产X' })
    const url = quickLookImageUrl(a) as string
    expect(url.startsWith(`vault://asset/${a.relFolder.split('/').map(encodeURIComponent).join('/')}/`)).toBe(true)
    // 反向断言：旧 bug 形态（丢掉 relFolder）不许再出现，谁改回去这条会红
    expect(url).not.toBe(vaultUrl(a.cover as string, a.updatedAt))
  })

  it('relFolder 为空（老数据 / 手写夹具）→ 不拼出以 / 开头的路径（协议会把首段当 host 路径）', () => {
    const a = fixture({ cover: '预览图.jpg', relFolder: '' })
    expect(quickLookImageUrl(a)).toBe(vaultUrl('预览图.jpg', a.updatedAt))
    // 反向：绝不能出现 `vault://asset//预览图.jpg` 这种双斜杠
    expect(quickLookImageUrl(a)).not.toContain('vault://asset//')
  })

  it('中文与空格路径必须逐段编码（拼错会破坏协议解析）', () => {
    const a = fixture({ cover: '预览 图/木纹.jpg', relFolder: '材质/石材/大理石/资产Y' })
    expect(quickLookImageUrl(a)).toBe(vaultUrl(`${a.relFolder}/${a.cover}`, a.updatedAt))
    // relFolder 与 cover 两段都必须编码（中文段 + 含空格段）
    expect(quickLookImageUrl(a)).toContain('%E6%9D%90%E8%B4%A8/%E7%9F%B3%E6%9D%90')
    expect(quickLookImageUrl(a)).toContain('%E9%A2%84%E8%A7%88%20%E5%9B%BE')
  })

  it('封面扩展名是 .tga / .exr（`<img>` 解不了）→ 跳过封面，回退缩略图而不是给破图 URL', () => {
    const a = fixture({ cover: '封面.tga' })
    const url = quickLookImageUrl(a) as string
    expect(url).not.toContain('.tga')
    expect(url).toBe(`vault://thumb/${encodeURIComponent(a.thumbPath as string)}`)
  })

  it('无封面但文件清单里有图片 → 缓存未命中时回退缩略图（白拿，不再 IPC）', () => {
    const a = fixture({ cover: undefined, coverSource: undefined })
    expect(quickLookImageFile(a)?.ext).toBe('jpg')
    // fixture 的序号是全局递增的，所以这里按 a.thumbPath 现算期望值（不硬编 thumb-001）
    expect(a.thumbPath).toBeTruthy()
    expect(quickLookImageUrl(a)).toBe(`vault://thumb/${encodeURIComponent(a.thumbPath as string)}`)
  })

  it('.tga / .exr 不当大图源（`<img>` 解不了，必然 onerror）→ 无封面时走类型占位', () => {
    const a = fixture({
      cover: undefined,
      coverSource: undefined,
      files: [{ rel: 'a.tga', name: 'a.tga', ext: 'tga', size: 10, kind: 'texture' }],
      thumbPath: undefined,
      thumbStatus: 'none'
    })
    expect(quickLookImageFile(a)).toBeNull()
    expect(quickLookImageUrl(a)).toBeNull()
  })

  it('缩略图未就绪 + 无封面 → null（组件必须显示占位，不崩不抛）', () => {
    const a = fixture({ cover: undefined, coverSource: undefined, files: [], thumbPath: undefined, thumbStatus: 'none' })
    expect(quickLookImageUrl(a)).toBeNull()
  })
})

// ── ④b 键位：空格开、空格或 Esc 关；←/→ 换图（用户 2026-10-28 口径） ──────

describe('Quick Look · 浮层键位（decideQuickLookKey）', () => {
  it('空格 = 关闭（同一颗键，开也它关也它）', () => {
    expect(decideQuickLookKey({ key: ' ' })).toBe('close')
    // 老浏览器 / 部分 IME 的别名
    expect(decideQuickLookKey({ key: 'Spacebar' })).toBe('close')
  })

  it('← / → = 换图，不受 repeat 影响（按住连翻是合意行为）', () => {
    expect(decideQuickLookKey({ key: 'ArrowLeft' })).toBe('prev')
    expect(decideQuickLookKey({ key: 'ArrowRight' })).toBe('next')
    expect(decideQuickLookKey({ key: 'ArrowRight', repeat: true })).toBe('next')
  })

  it('按住空格产生的重复事件不能关浮层（否则"刚打开就没了"）', () => {
    expect(decideQuickLookKey({ key: ' ', repeat: true })).toBe('none')
  })

  it('带修饰键让路：Ctrl/Cmd/Alt + 空格留给别的层（卡片多选 / 系统菜单）', () => {
    expect(decideQuickLookKey({ key: ' ', ctrlKey: true })).toBe('none')
    expect(decideQuickLookKey({ key: ' ', metaKey: true })).toBe('none')
    expect(decideQuickLookKey({ key: ' ', altKey: true })).toBe('none')
  })

  it('输入框里不抢按键（搜索框里空格就是空格）', () => {
    expect(decideQuickLookKey({ key: ' ', typing: true })).toBe('none')
    expect(decideQuickLookKey({ key: 'ArrowLeft', typing: true })).toBe('none')
  })

  it('非栈顶让路：上面还有弹窗时，空格不能越过它关掉底下那层预览', () => {
    expect(decideQuickLookKey({ key: ' ', layerDepth: 2 })).toBe('none')
    // 只有自己一层时才是栈顶
    expect(decideQuickLookKey({ key: ' ', layerDepth: 1 })).toBe('close')
  })

  it('其它键一律不管（Esc 走 useEscLayer，不在这里重复处理）', () => {
    expect(decideQuickLookKey({ key: 'Escape' })).toBe('none')
    expect(decideQuickLookKey({ key: 'a' })).toBe('none')
    expect(decideQuickLookKey({ key: 'Enter' })).toBe('none')
  })
})

// ── ⑤ store：打开入口与陈旧 id 守卫 ───────────────────────────────

describe('store · Quick Look 入口', () => {
  it('打开 / 关闭', () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    useVault.getState().openQuickLook(a.id)
    expect(useVault.getState().quickLookAssetId).toBe(a.id)
    useVault.getState().closeQuickLook()
    expect(useVault.getState().quickLookAssetId).toBeNull()
  })

  it('不存在的 id 静默忽略（空格可能命中刚被 rescan 丢弃的陈旧 DOM 节点）', () => {
    useVault.setState({ assets: [fixture()] })
    useVault.getState().openQuickLook('ghost')
    expect(useVault.getState().quickLookAssetId).toBeNull()
  })

  it('关闭浮层**不清空选中**（用户口径：退回网格时选中态要留着）', () => {
    const a = fixture()
    const b = fixture()
    useVault.setState({ assets: [a, b], selectedId: a.id, selectedIds: [a.id, b.id] })
    useVault.getState().openQuickLook(a.id)
    useVault.getState().closeQuickLook()
    expect(useVault.getState().quickLookAssetId).toBeNull()
    expect(useVault.getState().selectedId).toBe(a.id)
    expect(useVault.getState().selectedIds).toEqual([a.id, b.id])
  })
})

// ── ⑥ 五个清理站点必须逐字同 folderViewAssetId 模式 ──────────────

describe('store · 清理站点（删除 / 彻底删除 / rescan / 切视图）', () => {
  it('硬删（保留期 recycle）：正在显示的被删 → 置 null', async () => {
    const a = fixture()
    const b = fixture()
    useVault.setState({
      assets: [a, b],
      selectedIds: [a.id],
      quickLookAssetId: a.id,
      folderViewAssetId: a.id,
      settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle' }
    })
    modvault.trashPaths.mockResolvedValue([])

    useVault.getState().requestDelete([a.id])
    await useVault.getState().commitDelete()

    expect(useVault.getState().quickLookAssetId).toBeNull()
    expect(useVault.getState().folderViewAssetId).toBeNull()
  })

  it('硬删：被删的是**别的**资产 → 浮层保留（不能连带关掉正在看的那张）', async () => {
    const a = fixture()
    const b = fixture()
    useVault.setState({
      assets: [a, b],
      quickLookAssetId: a.id,
      settings: { ...DEFAULT_SETTINGS, trashRetention: 'recycle' }
    })
    modvault.trashPaths.mockResolvedValue([])

    useVault.getState().requestDelete([b.id])
    await useVault.getState().commitDelete()

    expect(useVault.getState().quickLookAssetId).toBe(a.id)
  })

  it('软删（默认 30d 档）：目标被移入回收站 → 置 null（记录仍在索引但已不在当前视图序列）', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], quickLookAssetId: a.id })
    modvault.softDeleteAssets.mockResolvedValue({
      ok: [{ id: a.id, trashRel: `.trash/${a.id}`, deletedAt: 1700000001000, size: 30 }],
      failed: []
    })

    useVault.getState().requestDelete([a.id])
    await useVault.getState().commitDelete()

    expect(useVault.getState().quickLookAssetId).toBeNull()
    // 记录确实还在索引里（回收站要能列出来），只是视图序列不含它
    expect(useVault.getState().assets.map((x) => x.id)).toEqual([a.id])
    expect(useVault.getState().assets[0]!.deletedAt).toBeTruthy()
  })

  it('彻底删除（purge）：置 null', async () => {
    const a = fixture({ deletedAt: 1700000001000, trashRel: `.trash/${'x'}` })
    useVault.setState({ assets: [a], quickLookAssetId: a.id, libraryView: 'trash' })
    modvault.purgeAssets.mockResolvedValue({ purged: 1, failed: 0, failures: [] })

    await useVault.getState().purgeAssets([a.id])

    expect(useVault.getState().quickLookAssetId).toBeNull()
  })

  it('rescan 丢弃正在显示的那条记录 → 关闭浮层；幸存者保留', async () => {
    const live = fixture()
    const gone = fixture()
    useVault.setState({ assets: [live, gone], quickLookAssetId: gone.id })
    // 扫描只认出 live 的目录（同 folder → 按 folder 合并，保留本地 id）；gone 在磁盘上消失
    modvault.rescan.mockResolvedValue({
      assets: [{ ...live, id: 'new-uuid-1', tags: [], note: '', source: '' }],
      ignored: []
    })

    const outcome = await useVault.getState().rescan()
    expect(outcome.aborted).toBeNull()
    expect(useVault.getState().quickLookAssetId).toBeNull()
    expect(fakeAssets.bulkDelete).toHaveBeenCalledWith([gone.id])

    // 反向：还在合并结果里的资产不能被关闭（否则用户按一次重扫浮层就凭空消失）
    useVault.setState({ assets: [live, gone], quickLookAssetId: live.id })
    modvault.rescan.mockResolvedValue({
      assets: [{ ...live, id: 'new-uuid-2', tags: [], note: '', source: '' }],
      ignored: []
    })
    await useVault.getState().rescan()
    expect(useVault.getState().quickLookAssetId).toBe(live.id)
  })

  it('进入回收站（setLibraryView）关闭浮层：视图一换序列就变了', () => {
    const a = fixture()
    useVault.setState({ assets: [a], selectedIds: [a.id], quickLookAssetId: a.id })
    useVault.getState().setLibraryView('trash')
    expect(useVault.getState().libraryView).toBe('trash')
    expect(useVault.getState().quickLookAssetId).toBeNull()
  })
})

// ── ⑦ Esc 优先级（关浮层不清选中，第二次 Esc 才走 clear-selection）──

describe('decideEsc · close-quick-look 优先级', () => {
  it('浮层是视觉上最上的可交互层：先答浮层', () => {
    expect(decideEsc({ ...IDLE, quickLookOpen: true })).toBe('close-quick-look')
  })

  it('浮层 + 删除宽限期 → 仍先关浮层（用户按 Esc 的直觉是退出眼前这一层）', () => {
    expect(decideEsc({ ...IDLE, quickLookOpen: true, pendingDelete: true, hasSelection: true })).toBe('close-quick-look')
  })

  it('浮层 + 有弹窗层 → App 不动（弹窗层是栈顶，浮层不该被连带关掉）', () => {
    expect(decideEsc({ ...IDLE, quickLookOpen: true, modalOpen: true, hasSelection: true })).toBe('none')
  })

  it('浮层 + 有选中 → 只关浮层，**不清选中**（第二次 Esc 才走 clear-selection）', () => {
    expect(decideEsc({ ...IDLE, quickLookOpen: true, hasSelection: true })).toBe('close-quick-look')
    // 第二次：浮层已关，同一个判据这次才落到清选中
    expect(decideEsc({ ...IDLE, quickLookOpen: false, hasSelection: true })).toBe('clear-selection')
  })

  it('浮层 + 文件视图 → 先关浮层，文件视图留着（两层各自独立）', () => {
    expect(decideEsc({ ...IDLE, quickLookOpen: true, folderViewOpen: true, hasSelection: true })).toBe('close-quick-look')
    expect(decideEsc({ ...IDLE, quickLookOpen: false, folderViewOpen: true, hasSelection: true })).toBe('close-folder-view')
  })

  it('浮层没开时判据完全不变（既有 8 条顺序一字未动）', () => {
    expect(decideEsc(IDLE)).toBe('none')
    expect(decideEsc({ ...IDLE, hasSelection: true })).toBe('clear-selection')
    expect(decideEsc({ ...IDLE, pendingDelete: true, quickLookOpen: true })).toBe('close-quick-look')
  })
})
