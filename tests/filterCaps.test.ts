/**
 * 筛选器**作用域**（2026-10 用户反馈）的数据面契约：
 *
 * > 「分辨率这个功能在材质和 HDR 的界面都会失效。然后在材质面板的顶栏不需要出现风格的选项。
 * >   HDR 也不需要。然后在模型界面的顶栏也不需要显示分辨率。至于还有其他我没有发现的
 * >   类似逻辑错误你可以自查一下」
 *
 * 拆成四件事，本文件逐条钉住：
 * ① 能力表 `KIND_FILTER_CAPS` / `capsOfFilter`：哪个视图该有哪个维度（唯一判定入口）；
 * ② 分辨率档位**按视图分表** `resolutionOptionsFor`：材质族 2K/4K，HDR 4K/8K/16K；
 * ③ 切视图必须清掉"新视图不支持 / 新视图没有这个档"的筛选值 `sanitizeFiltersForKind`
 *    （这就是用户说的"类似逻辑错误"：入口消失但条件还在生效 → 网格空着且找不到原因）；
 * ④ 风格计数只看当前大类视图（否则材质视图会出现风格 chip，点进去必然 0 条）。
 *
 * 另含一组**源码守卫**（组件在 node 环境渲染不了，本仓库惯例见
 * `tests/toolbarStyleFilter.test.ts`）：`App.tsx` 的入口可见性必须走 `capsOfFilter`，
 * 禁止硬编码 `filters.kind === 'model'` 这类判断。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Asset, AssetKind } from '../src/shared/types'
import { KIND_FILTER_CAPS, capsOfFilter } from '../src/shared/classify'
import {
  DEFAULT_FILTERS,
  RESOLUTION_QUICK_OPTIONS,
  assetLongEdge,
  matchesResolution,
  resolutionChipTitle,
  resolutionOptionsFor,
  resolutionPanelTitle,
  sanitizeFiltersForKind,
  styleCountsFor,
  type Filters
} from '../src/renderer/logic/filters'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

let seq = 0

function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'texture',
    source: '知末网',
    folder: `E:\\Lib\\材质\\未分类\\未分类\\资产${n}`,
    relFolder: `材质/未分类/未分类/资产${n}`,
    files: [],
    size: 1024,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `texture:资产${n}`,
    importedAt: 0,
    updatedAt: 0,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...patch
  }
}

/** 造一个「已知尺寸」的资产：`w × h` 的单图 */
function sized(kind: AssetKind, w: number, h: number, patch: Partial<Asset> = {}): Asset {
  return asset({
    kind,
    files: [{ rel: 'a.png', name: 'a.png', ext: 'png', size: 1, kind: 'texture', w, h }],
    ...patch
  })
}

function f(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

// ── ① 能力表：哪个视图支持哪个维度 ───────────────────────────────

describe('capsOfFilter · 每个大类视图支持哪些筛选维度', () => {
  it('模型：没有分辨率（封面是 720px 渲染图），有风格（风格主战场）', () => {
    expect(capsOfFilter('model', 'resolution')).toBe(false)
    expect(capsOfFilter('model', 'style')).toBe(true)
  })

  it('材质分组（哨兵 materialGroup）：有分辨率、没有风格', () => {
    expect(capsOfFilter('materialGroup', 'resolution')).toBe(true)
    expect(capsOfFilter('materialGroup', 'style')).toBe(false)
  })

  it('贴图 / 材质预设：都只有分辨率，没有风格（与 DetailPanel 不给材质挂风格一致）', () => {
    for (const kind of ['texture', 'material'] as const) {
      expect(capsOfFilter(kind, 'resolution')).toBe(true)
      expect(capsOfFilter(kind, 'style')).toBe(false)
    }
  })

  it('HDRI：有分辨率（全景宽度是硬规格），没有风格（用户明确「HDR 也不需要」）', () => {
    expect(capsOfFilter('hdri', 'resolution')).toBe(true)
    expect(capsOfFilter('hdri', 'style')).toBe(false)
  })

  it('其他：兜底不给任何入口', () => {
    expect(capsOfFilter('other', 'resolution')).toBe(false)
    expect(capsOfFilter('other', 'style')).toBe(false)
  })

  it('全部：取所有真实 kind 的并集（任一支持即 true）', () => {
    expect(capsOfFilter('all', 'resolution')).toBe(true)
    expect(capsOfFilter('all', 'style')).toBe(true)
  })

  it('能力表覆盖全部 6 个 AssetKind（加新大类时必须补一行，否则这里红）', () => {
    // 2026-10-29 加 `'cad'`（CAD 图纸大类）：五元 → 六元。
    // 这条是"计数守卫"不是"断言值随便改"：个数变了必须回到 KIND_FILTER_CAPS 补一行，
    // 否则新大类在「全部」视图的能力并集里会被静默漏掉。
    expect(Object.keys(KIND_FILTER_CAPS).sort()).toEqual(
      ['cad', 'hdri', 'material', 'model', 'other', 'texture'].sort()
    )
  })
})

// ── ② 分辨率档位按视图分表 ───────────────────────────────────────

describe('resolutionOptionsFor · 档位按视图分表', () => {
  const values = (kind: Parameters<typeof resolutionOptionsFor>[0]) =>
    resolutionOptionsFor(kind).map((o) => o.value)
  const labels = (kind: Parameters<typeof resolutionOptionsFor>[0]) =>
    resolutionOptionsFor(kind).map((o) => o.label)

  it('材质视图（texture / material / materialGroup）：不限 + 2K/4K，**不含** 8K/16K', () => {
    for (const kind of ['texture', 'material', 'materialGroup'] as const) {
      expect(values(kind)).toEqual([null, '2k', '4k'])
      expect(values(kind)).not.toContain('8k')
      expect(values(kind)).not.toContain('16k')
    }
  })

  it('HDR 视图：不限 + 4K/8K/16K —— **不含 2K**（全景宽度分不出 2K 档）', () => {
    expect(values('hdri')).toEqual([null, '4k', '8k', '16k'])
    expect(values('hdri')).not.toContain('2k')
    expect(labels('hdri')).toEqual(['不限', '4K 以上', '8K 以上', '16K 以上'])
  })

  it('「全部」与现状一致（3 项：不限 / 2K / 4K）', () => {
    expect(values('all')).toEqual([null, '2k', '4k'])
    // 兼容别名必须与 all 完全同源（不许两套字）
    expect(RESOLUTION_QUICK_OPTIONS).toEqual(resolutionOptionsFor('all'))
  })

  it('模型 / 其他视图即使被调用也返回材质那套（它们不会渲染入口）', () => {
    expect(values('model')).toEqual([null, '2k', '4k'])
    expect(values('other')).toEqual([null, '2k', '4k'])
  })

  it('面板标题按视图分口径：材质看贴图长边、HDR 看全景宽度', () => {
    expect(resolutionPanelTitle('materialGroup')).toBe('分辨率（贴图长边）')
    expect(resolutionPanelTitle('texture')).toBe('分辨率（贴图长边）')
    expect(resolutionPanelTitle('hdri')).toBe('分辨率（全景宽度）')
    // chip 的 title 同理（写错会误导用户以为筛的是同一件事）
    expect(resolutionChipTitle('hdri')).toContain('全景宽度')
    expect(resolutionChipTitle('texture')).toContain('贴图分辨率')
  })
})

// ── ③ 新档位的匹配行为（含 2K 防回归） ───────────────────────────

describe('matchesResolution · 8K / 16K 档（HDR 用）', () => {
  it('8K：长边 8192 命中，8000 不命中（阈值含等号）', () => {
    expect(assetLongEdge(sized('hdri', 8192, 4096))).toBe(8192)
    expect(matchesResolution(sized('hdri', 8192, 4096), '8k')).toBe(true)
    expect(matchesResolution(sized('hdri', 8000, 4000), '8k')).toBe(false)
  })

  it('16K：长边 16384 命中（用户库里最常见的全景尺寸 16384×8192）', () => {
    expect(matchesResolution(sized('hdri', 16384, 8192), '16k')).toBe(true)
    expect(matchesResolution(sized('hdri', 8192, 4096), '16k')).toBe(false)
    // 4K 档对 16384 也命中（档位是"以上"，不是区间）——这正是"26 个 HDR 全落 4K"的原因
    expect(matchesResolution(sized('hdri', 16384, 8192), '4k')).toBe(true)
  })

  it('2K / 4K 行为不变（防回归）', () => {
    expect(matchesResolution(sized('texture', 2048, 2048), '2k')).toBe(true)
    expect(matchesResolution(sized('texture', 1024, 1024), '2k')).toBe(false)
    expect(matchesResolution(sized('texture', 4096, 4096), '4k')).toBe(true)
    expect(matchesResolution(sized('texture', 2048, 2048), '4k')).toBe(false)
    expect(matchesResolution(sized('texture', 2048, 2048), null)).toBe(true)
  })
})

// ── ④ 切视图归一化（用户说的"类似逻辑错误"） ──────────────────────

describe('sanitizeFiltersForKind · 切视图清掉不该生效的条件', () => {
  it('切到模型视图：清掉 minResolution，但**保留** styles（模型是风格主战场）', () => {
    const before = f({ kind: 'model', minResolution: '4k', styles: ['奶油风'] })
    const after = sanitizeFiltersForKind(before)
    expect(after.minResolution).toBeNull()
    expect(after.styles).toEqual(['奶油风'])
    expect(after.kind).toBe('model')
  })

  it('切到材质族 / HDR：清掉 styles（那些视图都不挂风格）', () => {
    for (const kind of ['texture', 'material', 'materialGroup', 'hdri'] as const) {
      const after = sanitizeFiltersForKind(f({ kind, styles: ['奶油风'] }))
      expect(after.styles).toEqual([])
    }
  })

  it('切到 HDR：2K 归 null（HDR 表里没有这一档），8K 保留', () => {
    const dropped = sanitizeFiltersForKind(f({ kind: 'hdri', minResolution: '2k' }))
    expect(dropped.minResolution).toBeNull()
    const kept = sanitizeFiltersForKind(f({ kind: 'hdri', minResolution: '8k' }))
    expect(kept.minResolution).toBe('8k')
  })

  it('材质视图：minResolution 原样保留（4K 在材质表里合法）', () => {
    for (const kind of ['texture', 'material', 'materialGroup', 'all'] as const) {
      expect(sanitizeFiltersForKind(f({ kind, minResolution: '4k' })).minResolution).toBe('4k')
    }
  })

  it('软件删除之外的条件原样保留（不是"切视图就清空筛选"）', () => {
    const before = f({
      kind: 'texture',
      minResolution: '2k',
      minBytes: 50,
      favoriteOnly: true,
      colorTags: ['red'],
      category1: '沙发',
      query: '椅子',
      sort: 'size'
    })
    expect(sanitizeFiltersForKind(before)).toEqual(before)
  })

  it('不修改入参：返回新对象、原对象字段不变', () => {
    const before = f({ kind: 'model', minResolution: '4k', styles: ['奶油风'] })
    const after = sanitizeFiltersForKind(before)
    expect(after).not.toBe(before)
    // 入参必须一个字段都没被改（纯函数，store 里 reducer 语义）
    expect(before.minResolution).toBe('4k')
    expect(before.styles).toEqual(['奶油风'])
  })
})

// ── ⑤ 风格计数只看当前大类视图 ───────────────────────────────────

describe('styleCountsFor · 风格 → 计数（数据面保证材质视图不出风格 chip）', () => {
  it('全库有模型带风格、材质不带 → 只传材质资产进来时返回空数组', () => {
    const all = [
      asset({ kind: 'model', styles: ['奶油风', '侘寂风'] }),
      asset({ kind: 'material', styles: [] }),
      asset({ kind: 'texture', styles: [] })
    ]
    // 模型资产在 → 两个风格各 1 条（中文排序交给 localeCompare，这里只断言数量面）
    expect(Object.fromEntries(styleCountsFor(all))).toEqual({ 奶油风: 1, 侘寂风: 1 })
    const materials = all.filter((a) => a.kind === 'material' || a.kind === 'texture')
    expect(styleCountsFor(materials)).toEqual([])
  })

  it('多风格分头计数、数量降序', () => {
    const list = [
      asset({ kind: 'model', styles: ['简约', '奶油风'] }),
      asset({ kind: 'model', styles: ['简约'] }),
      asset({ kind: 'model', styles: ['侘寂风'] })
    ]
    const counts = styleCountsFor(list)
    // 第一名按数量（简约 2），后两名同数（顺序由 zh-CN 排序决定，不在这里钉）
    expect(counts[0]).toEqual(['简约', 2])
    expect(new Set(counts.slice(1).map(([s, n]) => `${s}:${n}`))).toEqual(
      new Set(['奶油风:1', '侘寂风:1'])
    )
  })

  it('软删记录不计入', () => {
    const list = [
      asset({ kind: 'model', styles: ['简约'] }),
      asset({ kind: 'model', styles: ['简约'], deletedAt: 1 })
    ]
    expect(styleCountsFor(list)).toEqual([['简约', 1]])
  })
})

// ── ⑥ 源码守卫：入口可见性必须走能力表 ───────────────────────────

describe('App.tsx 源码守卫：筛选入口按能力表渲染', () => {
  const app = read('src/renderer/App.tsx')
  const filtersSrc = read('src/renderer/logic/filters.ts')

  it('两个入口的可见性都由 capsOfFilter 决定', () => {
    expect(app).toMatch(/const showResolutionEntry\s*=\s*capsOfFilter\(filters\.kind,\s*'resolution'\)/)
    expect(app).toMatch(
      /const showStyleEntry\s*=\s*\n?\s*capsOfFilter\(filters\.kind,\s*'style'\)\s*&&/
    )
  })

  it('分辨率 chip 包在 showResolutionEntry 条件里（不是无条件渲染）', () => {
    const gate = app.indexOf('{showResolutionEntry && (')
    const button = app.indexOf("onClick={toggleExtraPanel('resolution')}")
    expect(gate).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(gate)
  })

  it('风格计数先按 kindsOfFilter 收窄到当前大类视图，再由 styleCountsFor 统计', () => {
    expect(app).toContain('kindsOfFilter(filters.kind)')
    expect(app).toContain('styleCountsFor(scoped)')
  })

  it('浮层选项 / 标题都用按视图分表的函数（不许再挂全局表 / 写死文案）', () => {
    expect(app).toContain('resolutionOptionsFor(filters.kind)')
    expect(app).toContain('resolutionPanelTitle(filters.kind)')
    expect(app).toContain('resolutionChipTitle(filters.kind)')
    // 全局表只剩兼容导出，组件不该再直接用它
    expect(app).not.toContain('RESOLUTION_QUICK_OPTIONS')
    expect(app).not.toContain('分辨率（贴图长边）"')
  })

  /**
   * 禁止硬编码大类判断。
   *
   * 为什么必须禁：① 分组哨兵 `materialGroup` 会被 `!== 'model'` 这类写法漏掉；
   * ② 将来加维度 / 加大类时必然漏改（本次 bug 就是这类"各处各写一遍"造成的）；
   * ③ 唯一判定入口是 `capsOfFilter`（`showResolutionEntry` / `showStyleEntry`）。
   * 注意放行 `filters.kind !== 'all'`：那是"是否筛了大类"的标题逻辑，与能力无关。
   */
  it('App.tsx 里没有 filters.kind 与具体大类字面量的比较', () => {
    expect(app).not.toMatch(
      /filters\.kind\s*(?:===|!==|==|!=)\s*'(?:model|texture|material|materialGroup|hdri|other)'/
    )
    expect(app).not.toMatch(
      /'(?:model|texture|material|materialGroup|hdri|other)'\s*(?:===|!==|==|!=)\s*filters\.kind/
    )
    // 能力判定只出现在 shared/classify（唯一定义处），App 里不许自己列一遍
    expect(app).not.toContain('KIND_FILTER_CAPS')
  })

  it('判定的唯一定义处：能力表与 capsOfFilter 在 shared/classify.ts', () => {
    const classify = read('src/shared/classify.ts')
    expect(classify).toContain('export const KIND_FILTER_CAPS: Record<AssetKind, KindFilterCaps>')
    expect(classify).toContain("export function capsOfFilter(f: KindFilter, cap: keyof KindFilterCaps)")
    // filters.ts 也只通过它判定，不自己写 kind 白名单
    expect(filtersSrc).toContain("capsOfFilter(f.kind, 'resolution')")
    expect(filtersSrc).toContain("capsOfFilter(f.kind, 'style')")
  })
})
