/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window / Crypto）。
// `Window.modvault` 的真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效）→ 这里补一份。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type ImportEvent } from '../src/shared/types'

/**
 * 2026-10 UI 修复小批（三件互不相关的小修）：
 *
 * ① **导入后仍停在回收站**：导入把资产落进库，但视图没切回来 → 用户以为"导入没生效"。
 *    口径：本批第一条 `status==='done' && asset` 时切回资产视图，**一批只切一次**；
 *    只有 skipped / error 的批次不切；用户中途手动切回回收站后本批不再抢。
 *
 * ② **`categoryPickerIds` 脏状态**：选中被别处清空 / 资产被删 / 重扫换记录后，
 *    store 里仍挂着旧 id 数组 → 弹窗按 ids 过滤得到空集，看起来"自己卸载了"，
 *    但字段悬着，下次打开会带着上一批 id。这里测存储侧（select / setLibraryView /
 *    删除链路 / rescan 都会收口）+ 组件侧兜底（源码守卫，node 环境渲染不了 React）。
 *
 * ③ **hover 离开撤回舞台球预热**（docs/29 §5 第 1 条）：`onPointerLeave` 只取消定时器
 *    不够，已排队的预览解码还在跑。测源码守卫（该块补了 `preview(null)` 且**仍**保留
 *    两个 `cancelPrewarm`，顺序在取消之后）。
 *
 * store 依赖 `window.modvault`（IPC 桥）与 Dexie（IndexedDB），vitest node 环境两者都不可用 →
 * 沿用 `tests/importQueueDismiss.test.ts` / `tests/storeFlow.test.ts` 同款桩，直接驱动真实 action。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

let importHandler: ((ev: ImportEvent) => void) | null = null
let batchDoneHandler: (() => void) | null = null

const modvault = {
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  setSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  detectMaterialMerge: vi.fn(async () => ({ needMerge: false, count: 0, sources: [] })),
  onMaterialMergeNotice: vi.fn(),
  onImportBatchDone: vi.fn((cb: () => void) => {
    batchDoneHandler = cb
    return () => undefined
  }),
  // docs/27：init() 会订阅「导入发现重复，请裁决」+「询问已作废」（幂等），桩必须返回退订函数
  onImportConflictAsk: vi.fn(() => () => undefined),
  onImportConflictExpired: vi.fn(() => () => undefined),
  onImportEvent: vi.fn((cb: (ev: ImportEvent) => void) => {
    importHandler = cb
    return () => undefined
  }),
  // 彻底删除：主进程返回失败清单（空 = 全部成功）
  purgeAssets: vi.fn(async () => ({ failures: [] as Array<{ id: string; reason: string }> })),
  // UI 导入入口：只记录调用（`importPaths` action 会在调用前后维护 imports 队列）
  importPaths: vi.fn(async () => [])
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
Object.defineProperty(db, 'assets', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => 0),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})
Object.defineProperty(db, 'backups', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

let seq = 0

function fixture(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `00000000-0000-4000-9000-${n.padStart(12, '0')}`,
    name: `测试资产${n}`,
    kind: 'texture',
    source: '知末网',
    folder: `E:\\ModVault\\Library\\贴图\\未分类\\未分类\\测试资产${n}`,
    relFolder: `贴图/未分类/未分类/测试资产${n}`,
    cover: '预览图.jpg',
    coverSource: 'named',
    thumbPath: `thumb-${n}.jpg`,
    thumbStatus: 'ready',
    files: [
      { rel: '预览图.jpg', name: '预览图.jpg', ext: 'jpg', size: 10, kind: 'texture' },
      { rel: '贴图.png', name: '贴图.png', ext: 'png', size: 20, kind: 'texture' }
    ],
    size: 30,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `texture:测试资产${n}`,
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...over
  }
}

/** 软删（回收站）记录：purgeAssets 只认 `deletedAt` + `trashRel` 的资产 */
function trashedFixture(over: Partial<Asset> = {}): Asset {
  return fixture({ deletedAt: Date.now(), trashRel: '.trash/测试资产', ...over })
}

function event(over: Partial<ImportEvent>): ImportEvent {
  return { item: 'E:\\inbox\\a.zip', itemName: 'a.zip', status: 'done', ...over }
}

const STATE_DEFAULTS = {
  assets: [] as Asset[],
  imports: [],
  notice: null,
  libraryView: 'assets' as const,
  selectedId: null,
  selectedIds: [] as string[],
  lastClickedId: null,
  categoryPickerIds: null,
  folderViewAssetId: null,
  dupOnly: false
}

beforeEach(async () => {
  vi.clearAllMocks()
  importHandler = null
  batchDoneHandler = null
  useVault.setState({ ...STATE_DEFAULTS })
  // init 会重新订阅（幂等），并把 settings / assets 灌进 store
  await useVault.getState().init()
  useVault.setState({ ...STATE_DEFAULTS })
})

afterEach(() => {
  useVault.setState({ ...STATE_DEFAULTS })
})

// ── ① 导入切回资产视图 ─────────────────────────────────────────

describe('① 导入把视图从「最近删除」切回资产视图', () => {
  it('回收站里来一条 done（带资产）→ 切回 assets，并给一条如实提示', () => {
    expect(importHandler).not.toBeNull()
    useVault.setState({ libraryView: 'trash' })

    importHandler!(event({ asset: fixture() }))

    expect(useVault.getState().libraryView).toBe('assets')
    const notice = useVault.getState().notice
    expect(notice).toContain('已切回资产视图')
    // 文案如实：指向新素材在哪，而不是空话"导入成功"
    expect(notice).toContain('全部')
  })

  it('一批只切一次：中途用户手动切回回收站后，本批剩余 done 不再抢', async () => {
    // 开一批（`importPaths([])` 是空批次，只负责复位闩锁，不会打 IPC）
    await useVault.getState().importPaths([])
    useVault.setState({ libraryView: 'trash' })

    importHandler!(event({ asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('assets')

    // 用户手动切回回收站 → 本批后续 done 必须尊重用户
    useVault.getState().setLibraryView('trash')
    importHandler!(event({ item: 'b.zip', itemName: 'b.zip', asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('trash')
    importHandler!(event({ item: 'c.zip', itemName: 'c.zip', asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('trash')
  })

  it('批次边界复位：新一批导入重新获得一次切换机会（main 的 batchDone 也算边界）', async () => {
    await useVault.getState().importPaths([])
    useVault.setState({ libraryView: 'trash' })
    importHandler!(event({ asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('assets')

    // 用户切回回收站，本批不再抢
    useVault.getState().setLibraryView('trash')
    importHandler!(event({ item: 'b.zip', itemName: 'b.zip', asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('trash')

    // main 的批次结束事件 → 复位；下一批（监控目录导入也走这条）重新可以切
    expect(batchDoneHandler).not.toBeNull()
    batchDoneHandler!()
    importHandler!(event({ item: 'c.zip', itemName: 'c.zip', asset: fixture() }))
    expect(useVault.getState().libraryView).toBe('assets')
  })

  it('只有 skipped / error 的批次不切（没有新资产可看）', async () => {
    await useVault.getState().importPaths([])
    useVault.setState({ libraryView: 'trash' })

    importHandler!(event({ status: 'skipped', asset: undefined }))
    importHandler!(event({ item: 'b.zip', itemName: 'b.zip', status: 'error', message: '解压失败' }))
    importHandler!(event({ item: 'c.zip', itemName: 'c.zip', status: 'skipped' }))

    expect(useVault.getState().libraryView).toBe('trash')
    expect(useVault.getState().notice).toBeNull()
  })

  it('本来就在资产视图时不切也不弹提示（用户无感知变化）', async () => {
    await useVault.getState().importPaths([])
    useVault.setState({ libraryView: 'assets', notice: null })

    importHandler!(event({ asset: fixture() }))

    expect(useVault.getState().libraryView).toBe('assets')
    expect(useVault.getState().notice).toBeNull()
  })
})

// ── ①-b imports 队列：就地更新、保持首次出现顺序 ────────────────

describe('④ imports 队列就地更新（顺序稳定，不下标跳动）', () => {
  const A = 'E:\\inbox\\a.zip'
  const B = 'E:\\inbox\\b.zip'

  it('同一条目连续 extracting → organizing → done：长度恒为 1，且已有条目的下标不变', () => {
    // 先放 A、B 两条（`ImportStatus` 无 'pending'：进行中是 extracting / organizing），A 在下标 0
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'extracting' }))
    importHandler!(event({ item: B, itemName: 'b.zip', status: 'extracting' }))
    expect(useVault.getState().imports.map((i) => i.item)).toEqual([A, B])

    for (const status of ['organizing', 'done'] as const) {
      importHandler!(event({ item: A, itemName: 'a.zip', status }))
      const imports = useVault.getState().imports
      // 长度不变（原地更新，不是"删旧 + 追加新"）
      expect(imports).toHaveLength(2)
      // A 仍在首次出现的下标 0，B 仍在 1
      expect(imports.map((i) => i.item)).toEqual([A, B])
      expect(imports[0]!.status).toBe(status)
    }
  })

  it('两个条目交错更新 → 顺序仍是首次出现顺序（A 先到就一直在 B 前面）', () => {
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'extracting' }))
    importHandler!(event({ item: B, itemName: 'b.zip', status: 'extracting' }))
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'organizing' }))
    importHandler!(event({ item: B, itemName: 'b.zip', status: 'done' }))
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))

    const imports = useVault.getState().imports
    expect(imports.map((i) => i.item)).toEqual([A, B])
    expect(imports.map((i) => i.status)).toEqual(['done', 'done'])
  })

  it('新条目仍然追加到队尾（不插队、不前置）', () => {
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))
    importHandler!(event({ item: B, itemName: 'b.zip', status: 'extracting' }))
    expect(useVault.getState().imports.map((i) => i.item)).toEqual([A, B])
  })

  it('真实链路 pending → extracting → done：importPaths 入队的条目原地推进，下标不变', async () => {
    // `ImportStatus` 没有 'pending'（那是 store 本地初始态），真实来源是 importPaths 的预置条目
    await useVault.getState().importPaths([A])
    expect(useVault.getState().imports).toHaveLength(1)
    expect(useVault.getState().imports[0]!.status).toBe('pending')
    expect(useVault.getState().imports[0]!.settledAt).toBeUndefined()

    importHandler!(event({ item: A, itemName: 'a.zip', status: 'extracting' }))
    expect(useVault.getState().imports).toHaveLength(1)
    expect(useVault.getState().imports[0]!.status).toBe('extracting')
    expect(useVault.getState().imports[0]!.settledAt).toBeUndefined()

    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))
    expect(useVault.getState().imports).toHaveLength(1)
    expect(useVault.getState().imports[0]!.status).toBe('done')
    expect(typeof useVault.getState().imports[0]!.settledAt).toBe('number')
  })

  it('新一批的 pending 条目追加到队尾（前置会让 slice(-6) 把最新一批挡在窗口外）', async () => {
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))
    await useVault.getState().importPaths([B])

    const imports = useVault.getState().imports
    expect(imports.map((i) => i.item)).toEqual([A, B])
    expect(imports[1]!.status).toBe('pending')
  })

  it('settledAt：终态写入；随后非终态（就地更新）必须清成 undefined，不带旧值', () => {
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))
    expect(typeof useVault.getState().imports[0]!.settledAt).toBe('number')

    // 同一条目重新开始（重新导入同一路径 / 事件重放）→ 非终态必须把旧时间戳清掉，
    // 否则 ImportQueue 会给"进行中"的条目起倒计时。
    importHandler!(event({ item: A, itemName: 'a.zip', status: 'extracting' }))
    expect(useVault.getState().imports[0]!.status).toBe('extracting')
    expect(useVault.getState().imports[0]!.settledAt).toBeUndefined()

    importHandler!(event({ item: A, itemName: 'a.zip', status: 'done' }))
    expect(typeof useVault.getState().imports[0]!.settledAt).toBe('number')
  })
})

// ── ② categoryPickerIds 收口 ───────────────────────────────────

describe('② 选择被清空 / 资产被删 → categoryPickerIds 同步置 null', () => {
  /** 打开分类弹窗（模拟用户已选中 a 并点了「指派分类」） */
  function openPickerOn(a: Asset): void {
    useVault.setState({
      assets: [a],
      selectedId: a.id,
      selectedIds: [a.id],
      lastClickedId: a.id
    })
    useVault.getState().openCategoryPicker([a.id])
    expect(useVault.getState().categoryPickerIds).toEqual([a.id])
  }

  it('select(null) → null', () => {
    const a = fixture()
    openPickerOn(a)
    useVault.getState().select(null)
    expect(useVault.getState().categoryPickerIds).toBeNull()
    expect(useVault.getState().selectedIds).toEqual([])
  })

  it('setLibraryView(\'trash\') → null', () => {
    const a = fixture()
    openPickerOn(a)
    useVault.getState().setLibraryView('trash')
    expect(useVault.getState().categoryPickerIds).toBeNull()
  })

  it('删除链路（彻底删除）→ null', async () => {
    const a = trashedFixture()
    openPickerOn(a)
    await useVault.getState().purgeAssets([a.id])
    expect(useVault.getState().categoryPickerIds).toBeNull()
    expect(useVault.getState().assets).toHaveLength(0)
  })

  it('toggleSelect 取消最后一个选中 → null', () => {
    const a = fixture()
    openPickerOn(a)
    useVault.getState().toggleSelect(a.id)
    expect(useVault.getState().selectedIds).toEqual([])
    expect(useVault.getState().categoryPickerIds).toBeNull()
  })

  it('selectAll([])（取消全选）→ null', () => {
    const a = fixture()
    openPickerOn(a)
    useVault.getState().selectAll([])
    expect(useVault.getState().categoryPickerIds).toBeNull()
  })

  it('pruneSelection 把选中裁空 → null', () => {
    const a = fixture()
    openPickerOn(a)
    useVault.getState().pruneSelection([])
    expect(useVault.getState().selectedIds).toEqual([])
    expect(useVault.getState().categoryPickerIds).toBeNull()
  })
})

// ── 源码守卫（node 环境渲染不了 React 组件） ────────────────────

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

describe('② 组件兜底：CategoryPicker 目标为空时自己收口', () => {
  const src = read('src/renderer/components/CategoryPicker.tsx')

  it('targets 为空且 pickerIds 非空 → 调 closeCategoryPicker（不是留着空壳）', () => {
    expect(src).toContain('if (pickerIds && targets.length === 0) close()')
    expect(src).toContain('const close = useVault((s) => s.closeCategoryPicker)')
  })

  it('收口放在 useEffect 里（不在 render 里 setState）', () => {
    const start = src.indexOf('if (pickerIds && targets.length === 0) close()')
    expect(start).toBeGreaterThan(-1)
    // 往上找最近的 useEffect（中间不能隔着 render 期的 early return）
    const effect = src.lastIndexOf('useEffect(() => {', start)
    const earlyReturn = src.indexOf('if (!pickerIds || targets.length === 0 || !kind) return null')
    expect(effect).toBeGreaterThan(-1)
    expect(effect).toBeLessThan(earlyReturn)
  })
})

describe('③ AssetGrid 的 onPointerLeave 撤回舞台预热', () => {
  const src = read('src/renderer/components/AssetGrid.tsx')

  /** 取 `onPointerLeave` 这一个箭头函数体（到它自己的 `\n    }` 为止） */
  function leaveBlock(): string {
    const start = src.indexOf('onPointerLeave: () => {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('\n    }', start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('块内有 stageController.preview(null)', () => {
    expect(leaveBlock()).toContain('stageController.preview(null)')
  })

  it('仍然保留两个 cancelPrewarm（是"追加"而不是"替换"）', () => {
    expect(count(leaveBlock(), 'cancelPrewarm(')).toBe(2)
  })

  it('preview(null) 在两个取消之后（先撤定时器，再撤已排队的解码）', () => {
    const block = leaveBlock()
    const lastCancel = block.lastIndexOf('cancelPrewarm(')
    const recall = block.indexOf('stageController.preview(null)')
    expect(lastCancel).toBeGreaterThan(-1)
    expect(recall).toBeGreaterThan(lastCancel)
  })

  it('onPointerEnter 仍会为新 hover 排预热（撤回后不会把新预热顶掉的前提）', () => {
    const enter = src.indexOf('onPointerEnter: () => {')
    const leave = src.indexOf('onPointerLeave: () => {')
    const enterBlock = src.slice(enter, leave)
    expect(enterBlock).toContain('stageController.preview(a.id)')
    // 新 id 走定时器（异步），一定晚于 onPointerLeave 的同步 null
    expect(enterBlock).toContain('schedulePrewarmSoon')
  })
})
