/// <reference lib="dom" />
// 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, ColorTag } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  activeFilterDimensions,
  applyFilters,
  matchesFilters,
  normalizeRating,
  toggleColorTag,
  type Filters
} from '../src/renderer/logic/filters'

/**
 * v0.4「收藏 / 评分 / 色标」的测试。
 *
 * 分三层：
 * ① 纯逻辑——`normalizeRating` / `toggleColorTag` / `applyFilters` 的三个新维度；
 * ② 真实 store action——批量 `setFavorite` / `setRating` / `setColorTag`（只 stub Dexie 表）；
 * ③ 源码守卫——卡片上「重复徽标在右下角、收藏星在右上角」的布局约定（防撞回来）。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

const modvault = {
  ensureThumb: vi.fn().mockResolvedValue(null),
  deleteThumb: vi.fn().mockResolvedValue(0)
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

const bulkPutCalls: Asset[][] = []
const fakeTable = {
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => {
    bulkPutCalls.push(list.map((a) => ({ ...a })))
    return list.length
  }),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

let seq = 0
const OLD_IMPORT = 1_600_000_000_000
const OLD_UPDATE = 1_600_000_000_000

function fixture(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: OLD_IMPORT,
    updatedAt: OLD_UPDATE,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...patch
  }
}

function filters(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

beforeEach(() => {
  bulkPutCalls.length = 0
  vi.clearAllMocks()
  useVault.setState({
    assets: [],
    filters: { ...DEFAULT_FILTERS },
    selectedId: null,
    selectedIds: [],
    notice: null,
    dupOnly: false
  })
})

// ── ① 纯逻辑：normalizeRating / toggleColorTag ───────────────────

describe('normalizeRating —— 0–5 取整并夹紧', () => {
  it('-1 → 0（下沿）、7 → 5（上沿）', () => {
    expect(normalizeRating(-1)).toBe(0)
    expect(normalizeRating(7)).toBe(5)
  })

  it('3.6 → 4（四舍五入）；2.5 → 3；0.4 → 0', () => {
    expect(normalizeRating(3.6)).toBe(4)
    expect(normalizeRating(2.4)).toBe(2)
    expect(normalizeRating(2.5)).toBe(3)
    expect(normalizeRating(0.4)).toBe(0)
  })

  it('NaN / Infinity / 字符串数字都安全收敛', () => {
    expect(normalizeRating(Number.NaN)).toBe(0)
    expect(normalizeRating(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeRating(Number('4'))).toBe(4)
  })
})

describe('toggleColorTag —— 多选切换（纯函数，不改入参）', () => {
  it('追加 / 移除', () => {
    expect(toggleColorTag([], 'red')).toEqual(['red'])
    expect(toggleColorTag(['red'], 'red')).toEqual([])
    expect(toggleColorTag(['red'], 'blue')).toEqual(['red', 'blue'])
  })

  it('不修改入参数组', () => {
    const input: ColorTag[] = ['red']
    toggleColorTag(input, 'blue')
    expect(input).toEqual(['red'])
  })
})

// ── ② applyFilters 的三个新维度 ──────────────────────────────────

describe('applyFilters：收藏 / 色标 / 与其它维度取交集', () => {
  const fav = fixture({ name: '收藏的椅子', favorite: true, colorTag: 'red', category1: '家具' })
  const redOnly = fixture({ name: '红标沙发', favorite: false, colorTag: 'red', category1: '家具' })
  const blueFav = fixture({
    name: '蓝标收藏',
    favorite: true,
    colorTag: 'blue',
    category1: '灯具'
  })
  const plain = fixture({ name: '无标记', favorite: false, colorTag: null, category1: '家具' })
  const all = [fav, redOnly, blueFav, plain]

  it('favoriteOnly 只留收藏（缺字段的旧记录按 false 处理）', () => {
    const withLegacy = [...all, fixture({ favorite: undefined as unknown as boolean })]
    const out = applyFilters(withLegacy, filters({ favoriteOnly: true }))
    expect(out.map((a) => a.name).sort()).toEqual(['收藏的椅子', '蓝标收藏'])
  })

  it('colorTags=[red] 只留红色；colorTag=null 不被任何色标命中', () => {
    const out = applyFilters(all, filters({ colorTags: ['red'] }))
    expect(out.map((a) => a.name).sort()).toEqual(['收藏的椅子', '红标沙发'])
    // 多选色标 = 维度内 OR
    const two = applyFilters(all, filters({ colorTags: ['red', 'blue'] }))
    expect(two.length).toBe(3)
    expect(two.some((a) => a.name === '无标记')).toBe(false)
  })

  it('收藏 + 色标 + 分类三者取交集', () => {
    const out = applyFilters(
      all,
      filters({ favoriteOnly: true, colorTags: ['red'], category1: '家具' })
    )
    expect(out.map((a) => a.name)).toEqual(['收藏的椅子'])
  })

  it('空筛选不生效（默认值不误伤）', () => {
    expect(matchesFilters(plain, filters())).toBe(true)
    expect(applyFilters(all, filters()).length).toBe(4)
    expect(DEFAULT_FILTERS.favoriteOnly).toBe(false)
    expect(DEFAULT_FILTERS.colorTags).toEqual([])
  })

  it('生效维度文案包含「收藏 / 色标」', () => {
    const dims = activeFilterDimensions(filters({ favoriteOnly: true, colorTags: ['red', 'blue'] }))
    expect(dims.map((d) => `${d.label}：${d.value}`)).toContain('收藏：仅收藏')
    expect(dims.map((d) => `${d.label}：${d.value}`)).toContain('色标：红、蓝')
  })
})

// ── ③ 真实 store action（批量） ─────────────────────────────────

describe('store.setFavorite / setRating / setColorTag —— 批量标记', () => {
  it('setFavorite(3 个 id, true)：三条都变、updatedAt 变了、importedAt 没变、只写一次库', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    const untouched = fixture()
    useVault.setState({ assets: [a, b, c, untouched] })

    await useVault.getState().setFavorite([a.id, b.id, c.id], true)

    const byId = new Map(useVault.getState().assets.map((x) => [x.id, x]))
    expect(byId.get(a.id)!.favorite).toBe(true)
    expect(byId.get(b.id)!.favorite).toBe(true)
    expect(byId.get(c.id)!.favorite).toBe(true)
    expect(byId.get(untouched.id)!.favorite).toBe(false)

    for (const id of [a.id, b.id, c.id]) {
      const x = byId.get(id)!
      expect(x.importedAt).toBe(OLD_IMPORT) // 导入时间不动
      expect(x.updatedAt).toBeGreaterThan(OLD_UPDATE) // 更新时间刷新
    }

    // 批量：一次 bulkPut（不逐条 put）
    expect(bulkPutCalls.length).toBe(1)
    expect(bulkPutCalls[0]!.map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort())
    expect(fakeTable.put).not.toHaveBeenCalled()
  })

  it('setFavorite(false) 可以取消收藏', async () => {
    const a = fixture({ favorite: true })
    useVault.setState({ assets: [a] })
    await useVault.getState().setFavorite([a.id], false)
    expect(useVault.getState().assets[0]!.favorite).toBe(false)
  })

  it('setRating 批量传 -1 / 7 / 3.6 → 0 / 5 / 4', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    const d = fixture()
    useVault.setState({ assets: [a, b, c, d] })

    await useVault.getState().setRating([a.id], -1)
    await useVault.getState().setRating([b.id], 7)
    await useVault.getState().setRating([c.id], 3.6)
    await useVault.getState().setRating([d.id, a.id], 4)

    const byId = new Map(useVault.getState().assets.map((x) => [x.id, x]))
    expect(byId.get(a.id)!.rating).toBe(4)
    expect(byId.get(b.id)!.rating).toBe(5)
    expect(byId.get(c.id)!.rating).toBe(4)
    expect(byId.get(d.id)!.rating).toBe(4)
  })

  it('setRating(0) 清除评分', async () => {
    const a = fixture({ rating: 5 })
    useVault.setState({ assets: [a] })
    await useVault.getState().setRating([a.id], 0)
    expect(useVault.getState().assets[0]!.rating).toBe(0)
  })

  it('setColorTag 设置 + 传 null 清除', async () => {
    const a = fixture()
    useVault.setState({ assets: [a] })
    await useVault.getState().setColorTag([a.id], 'purple')
    expect(useVault.getState().assets[0]!.colorTag).toBe('purple')
    expect(bulkPutCalls[0]![0]!.colorTag).toBe('purple')

    await useVault.getState().setColorTag([a.id], null)
    expect(useVault.getState().assets[0]!.colorTag).toBeNull()
  })

  it('空 ids / 全部 id 失效 → 不写库、不报错', async () => {
    useVault.setState({ assets: [fixture()] })
    await useVault.getState().setFavorite([], true)
    await useVault.getState().setFavorite(['not-exist'], true)
    expect(bulkPutCalls.length).toBe(0)
  })

  it('写库失败 → 落 notice，内存不被改成“成功”假象', async () => {
    const a = fixture()
    useVault.setState({ assets: [a], notice: null })
    fakeTable.bulkPut.mockRejectedValueOnce(new Error('quota exceeded'))

    await useVault.getState().setFavorite([a.id], true)

    expect(useVault.getState().assets[0]!.favorite).toBe(false)
    expect(useVault.getState().notice).toContain('保存标记失败')
    expect(useVault.getState().notice).toContain('quota exceeded')
  })

  it('多选批量：selectedIds 全量传入（3 项）', async () => {
    const a = fixture()
    const b = fixture()
    const c = fixture()
    useVault.setState({ assets: [a, b, c], selectedIds: [a.id, b.id, c.id], selectedId: a.id })
    const ids = useVault.getState().selectedIds
    await useVault.getState().setColorTag(ids, 'green')
    expect(useVault.getState().assets.every((x) => x.colorTag === 'green')).toBe(true)
  })
})

// ── ④ 源码守卫：卡片角标布局不撞车 ──────────────────────────────

describe('源码守卫：收藏星在右上角、重复徽标在右下角', () => {
  it('重复徽标必须是 bottom-2 right-2（不能再回到右上角与星标重叠）', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'AssetGrid.tsx'),
      'utf8'
    )
    expect(src).toContain('badge absolute bottom-2 right-2')

    // 重复徽标那块代码里不得再出现 right-2 top-2
    const block = src.slice(src.indexOf('v0.4 重复角标'), src.indexOf('v0.4 重复角标') + 600)
    expect(block).toContain('bottom-2 right-2')
    expect(block).not.toContain('right-2 top-2')
  })

  it('右上角是「圆钮 + 标记列」的固定竖列：圆钮恒占位，标记只在未选中时渲染', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'AssetGrid.tsx'),
      'utf8'
    )
    // 竖列容器（圆钮 + 标记的唯一定位点）
    expect(src).toContain('absolute right-2 top-2 z-10 flex flex-col items-end gap-1')
    const column = src.slice(
      src.indexOf('absolute right-2 top-2 z-10'),
      src.indexOf('v0.4 重复角标')
    )
    // 2026-10-25 反馈：网格卡片只保留**一个**多选控件（右上角圆钮），左侧方块已删
    expect(column).toContain('<SelectBox')
    expect(column).toContain('variant="circle"')
    expect(column).toContain('{!selected &&')
    expect(src).not.toContain("absolute left-2 top-8")

    const flags = src.slice(src.indexOf('function Flags('), src.indexOf('function CategoryCell'))
    expect(flags).toContain('FavoriteStar')
    expect(flags).toContain('asset.mojibake')
    // SU 版本已从卡片撤掉（列表 SU 列 / 详情面板 / 文件视图仍保留）
    expect(flags).not.toContain('asset.suVersion')
    // 定位交给卡片里的竖列容器：Flags 自己不能再绝对定位（否则与圆钮重叠）
    expect(flags).not.toContain('absolute right-2 top-2')
    // 卡片元信息行也不再拼 SU 版本（列表行的 `a.suVersion ?? '—'` 不受影响）
    // ⚠️ 断言必须精确到「拼接片段」：写成 `not.toContain('a.suVersion ?')` 会被列表列的
    // `a.suVersion ?? '—'` 子串误命中（`??` 的前缀就是 `?`），测试会假红。
    expect(src).not.toContain('· ${a.suVersion}')
  })

  it('色标筛选入口已移到中栏头（侧栏不再有 ColorTagPicker / 整理组只剩两项）', async () => {
    const sidebar = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'Sidebar.tsx'),
      'utf8'
    )
    expect(sidebar).not.toContain('ColorTagPicker')
    expect(sidebar).not.toContain('toggleColorTag')
    expect(sidebar).not.toContain('showColorTagsEntry')
    expect(sidebar).toContain(
      'const showOrganizeGroup = showFavoritesEntry || showDuplicatesEntry'
    )

    const app = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'App.tsx'), 'utf8')
    expect(app).toContain("type QuickPanel = 'size' | 'time' | 'color' | null")
    expect(app).toContain('<ColorTagPicker')
    expect(app).toContain('toggleColorTag(filters.colorTags, tag)')
    // 回收站里与体积 / 时间同规矩：禁用 + 说明
    expect(app).toContain('回收站不支持色标筛选（返回资产视图后可用）')
    // 设置关掉色标入口时整个 chip 不渲染
    expect(app).toContain('settings?.showColorTags !== false')
  })

  it('顶部球尺寸 148 → 140（只改 App 的 STAGE_SLOT，MaterialStage 读 #stage-slot 自动跟随）', async () => {
    const app = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'App.tsx'), 'utf8')
    expect(app).toContain('const STAGE_SLOT = 140')
    const stage = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'MaterialStage.tsx'),
      'utf8'
    )
    expect(stage).toContain("document.getElementById('stage-slot')")
    expect(stage).not.toContain('148')
  })
})
