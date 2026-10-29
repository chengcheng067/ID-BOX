/**
 * styles（风格）筛选入口的落点守卫。
 *
 * 沿革（改这个功能前必读）：最初在顶栏 → 2026-10 用户反馈第 1 条挪进左栏（需求书 §1.2）
 * → 2026-10-22 用户要求「侧栏的风格选项也移到顶栏上面去」→ 搬回顶栏
 * → **2026-10 用户反馈：「风格的这个按钮应该是在体积、时间分辨率、色标的这个部分的顶栏，
 *   而不是在搜索旁边」→ 落点改为中栏头那一排**（本次）。
 *
 * 组件在 node 环境渲染不了（本仓库组件测试一律走源码守卫），因此本文件只钉**契约**：
 * ① 左栏彻底不再渲染风格 chip（含标题 / 计数 / 清空），且其余分组顺序不变；
 * ② 入口现在在**中栏头**（`App.tsx`）：chip 夹在色标与条件摘要之间，写库仍是 `filters.styles`
 *    （多选语义不变：整组替换，不 push / 不 sort 原地改）；
 * ③ 顶栏（`Toolbar.tsx`）**不再承载**风格筛选 —— 相关 state / ref / 监听 / 常量必须搬空；
 * ④ 浮层复用中栏头那套「按钮矩形定位 + fixed + 点外部 / Esc / resize 关闭」，且是**单独**的
 *    展开态（`QuickPanel` 的四值字面量是 `marks.test.ts` 钉住的契约，不许塞 'style' 进去）；
 * ⑤ 配色口径：只有分类组走蓝 tint → 风格 chip 不得使用 chip-accent，选中走 neutral。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const SIDEBAR = 'src/renderer/components/Sidebar.tsx'
const TOOLBAR = 'src/renderer/components/Toolbar.tsx'
const APP = 'src/renderer/App.tsx'
const FILTERS = 'src/renderer/logic/filters.ts'

// ── ① 左栏：风格整块已移除，分组顺序不变 ────────────────────────

describe('Sidebar：不再承载风格筛选', () => {
  it('不再有 styleCounts 派生值 / 风格 chip 的多选逻辑', () => {
    const src = read(SIDEBAR)
    expect(src).not.toContain('styleCounts')
    // chip 的两处「特征代码」：标题属性 + 选中判定
    expect(src).not.toMatch(/按风格「/)
    expect(src).not.toMatch(/filters\.styles\.(?:includes|filter)\(/)
    expect(src).not.toContain('清空风格筛选')
  })

  it('「风格」不再作为分组标题渲染（注释里的沿革可以留，但不能有标题节点）', () => {
    const src = read(SIDEBAR)
    expect(src).not.toMatch(/>\s*风格\{/)
    // 组头模板：`mb-1 mt-4 ... text-[11px] font-medium` + 文本；风格组不能再用它
    expect(src).not.toMatch(/font-medium tracking-wide text-muted">\s*<span>\s*风格/)
  })

  it('分组顺序保持：分类 → 整理 → 智能集合 → 库（风格移除后不留空位）', () => {
    const src = read(SIDEBAR)
    const categories = src.indexOf('>分类</div>')
    const organize = src.indexOf('>整理</div>')
    const saved = src.indexOf('<span>智能集合</span>')
    const library = src.indexOf('>库</div>')
    expect(categories).toBeGreaterThan(-1)
    expect(organize).toBeGreaterThan(categories)
    expect(saved).toBeGreaterThan(organize)
    expect(library).toBeGreaterThan(saved)
  })

  it('筛选状态仍保留：「全部」与「重复资产」重置里依旧清 styles（逻辑没被删掉）', () => {
    // 2026-10-30：清理列表从组件**收敛到** `logic/filters.ts` 的 `allViewFilterPatch`
    // （两处手写清单各漏字段就是「格式=SU 看不到 SU 模型」那个 bug 的成因）。
    // 守的原意不变：styles 维度仍被重置、两个入口都走它。
    const src = read(SIDEBAR)
    expect(src.match(/allViewFilterPatch\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    const logic = read(FILTERS)
    expect(logic).toMatch(/export function allViewFilterPatch\(\)[\s\S]*?styles: \[\]/)
  })
})

// ── ② 顶栏：风格筛选已搬空（只剩注释里的沿革说明） ───────────────

describe('Toolbar：风格筛选已整体搬走（顶栏不再有入口 / 面板 / 状态）', () => {
  it('入口与展开态都不在顶栏：没有 风格 / toggleStylePanel / stylePanel', () => {
    const src = read(TOOLBAR)
    // 连"风格"两个字都不该再出现（文案、注释一视同仁，避免被 grep 误读成还有入口）
    expect(src).not.toContain('风格')
    expect(src).not.toContain('toggleStylePanel')
    expect(src).not.toContain('stylePanel')
  })

  it('筛选语义与浮层机制也一并搬空：不再读 filters.styles，没有面板宽度 / 容器 ref / 计数', () => {
    const src = read(TOOLBAR)
    expect(src).not.toContain('filters.styles')
    expect(src).not.toContain('STYLE_PANEL_WIDTH')
    expect(src).not.toContain('styleRef')
    expect(src).not.toContain('styleCounts')
    expect(src).not.toContain('stylePanelOpen')
  })

  it('顶栏仍是 56 高的单行（搬走入口后没有被撑高 / 改成自动高度）', () => {
    const src = read(TOOLBAR)
    expect(src).toContain('flex h-14 shrink-0 items-center')
    expect(src).not.toMatch(/h-auto/)
    expect(src).not.toMatch(/min-h-/)
    // 排序仍旧不在顶栏（2026-10-15 拍板）
    expect(src).not.toContain('SORT_OPTIONS')
  })
})

// ── ③ 中栏头：入口存在，读写仍是 filters.styles ────────────────────

describe('App 中栏头：风格入口与筛选语义', () => {
  it('有「风格」入口与独立展开态（不并进 QuickPanel）', () => {
    const app = read(APP)
    expect(app).toContain('const toggleStylePanel')
    expect(app).toContain('const [stylePanel, setStylePanel] = useState(false)')
    // QuickPanel 的四值字面量是 marks.test 钉住的契约：形状不变、不许加 'style'
    expect(app).toContain("type QuickPanel = 'size' | 'time' | 'color' | null")
    expect(app).not.toMatch(/type QuickPanel = [^\n]*'style'/)
  })

  it('patch 的键仍是 filters.styles（多选整组替换）', () => {
    const app = read(APP)
    // 读：已选判定
    expect(app).toMatch(/filters\.styles\.includes\(style\)/)
    // 写：切换 = 过滤掉 or 追加（整组新数组），清空 = []
    expect(app).toContain('styles: active')
    expect(app).toMatch(/filters\.styles\.filter\(\(x\) => x !== style\)/)
    expect(app).toMatch(/\[\.\.\.filters\.styles,\s*style\]/)
    expect(app).toMatch(/setFilter\(\{\s*styles:\s*\[\]\s*\}\)/)
  })

  it('不原地改数组（push / splice / sort 会绕过 setFilter 的引用更新）', () => {
    const app = read(APP)
    expect(app).not.toMatch(/filters\.styles\.(?:push|splice|sort|pop|shift|unshift)\(/)
  })

  it('计数口径与左栏原实现一致：只算在库资产（软删记录不计）', () => {
    const app = read(APP)
    // 2026-10「筛选域收敛」：计数循环搬进纯逻辑 `filters.styleCountsFor`（可单测），
    // App 只做 useMemo 接线，且统计范围收窄到**当前大类视图**（否则材质视图会冒出风格 chip）
    expect(app).toContain('styleCountsFor(scoped)')
    expect(app).toContain('kindsOfFilter(filters.kind)')
    const filtersSrc = read(FILTERS)
    expect(filtersSrc).toContain('for (const s of a.styles ?? [])')
    expect(filtersSrc).toContain('isDeletedAsset')
    // 入口渲染条件：能力表支持风格 **且**（有风格可选 或 已有筛选在生效）
    expect(app).toMatch(
      /const showStyleEntry =\s*capsOfFilter\(filters\.kind, 'style'\) && \(styleCounts\.length > 0 \|\| filters\.styles\.length > 0\)/
    )
  })

  it('已选数量显示在 chip 上（与色标同规矩）', () => {
    const app = read(APP)
    const start = app.indexOf('{showStyleEntry && (')
    const end = app.indexOf('{!trashMode && numericSummary && (')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const chip = app.slice(start, end)
    expect(chip).toContain('styleFilterActive')
    expect(chip).toContain('filters.styles.length')
    expect(chip).toContain('tabular-nums')
  })
})

// ── ④ 位置：在色标之后、条件摘要之前（同一条中栏头 chip 排） ────────

describe('App 中栏头：入口落点', () => {
  it('在 quickRef 容器内，排在色标之后、条件摘要之前', () => {
    const app = read(APP)
    const quickRow = app.indexOf('ref={quickRef}')
    const color = app.indexOf("onClick={toggleQuickPanel('color')}")
    const style = app.indexOf('onClick={toggleStylePanel}')
    const summary = app.indexOf('{!trashMode && numericSummary && (')
    expect(quickRow).toBeGreaterThan(-1)
    expect(color).toBeGreaterThan(quickRow)
    expect(style).toBeGreaterThan(color)
    expect(summary).toBeGreaterThan(style)
  })
})

// ── ⑤ 浮层：复用中栏头那套定位 + 三种关闭路径 ──────────────────────

describe('App 中栏头：风格浮层复用既有机制', () => {
  it('按钮矩形定位 + fixed + 右边界夹紧 + 面板宽度常量', () => {
    const app = read(APP)
    expect(app).toContain('const STYLE_PANEL_WIDTH')
    expect(app).toContain('rect.bottom + 6')
    expect(app).toContain('window.innerWidth - STYLE_PANEL_WIDTH')
    expect(app).toMatch(/fixed z-40/)
    expect(app).toContain('width: STYLE_PANEL_WIDTH')
    expect(app).toContain('aria-label="按风格筛选"')
  })

  it('关闭路径共用同一个 effect：点外部 / Esc（捕获 + stopPropagation）/ resize', () => {
    const app = read(APP)
    expect(app).toContain('if (!quickPanel && !extraPanel && !stylePanel) return')
    expect(app).toContain('root.contains(e.target)')
    expect(app).toContain("if (e.key !== 'Escape') return")
    expect(app).toContain('e.stopPropagation()')
    expect(app).toContain("window.addEventListener('keydown', onKeyDown, true)")
    expect(app).toContain("window.addEventListener('mousedown', onPointerDown)")
    expect(app).toContain("window.addEventListener('resize', onResize)")
  })

  it('回收站视图禁用入口（该视图只吃搜索词，与体积 / 时间 / 色标同规矩）', () => {
    const app = read(APP)
    expect(app).toContain('disabled={trashMode}')
    expect(app).toContain('回收站不支持风格筛选（返回资产视图后可用）')
  })

  it('不再写着「顶栏承载」的旧文案（注释也不许把入口指回 Toolbar）', () => {
    const app = read(APP)
    expect(app).not.toContain('Toolbar.tsx 的「风格」chip')
    expect(app).not.toContain('风格 chip + 下拉面板')
  })
})

// ── ⑥ 配色口径：风格一律 neutral ─────────────────────────────────

describe('App 中栏头：风格 chip 走 neutral（只有分类组能蓝）', () => {
  it('选中态复用 --bg-elevated + --text-primary，未选中 hover 同档；chip 内无蓝 tint', () => {
    const app = read(APP)
    const start = app.indexOf('{showStyleEntry && (')
    const end = app.indexOf('{!trashMode && numericSummary && (')
    const chip = app.slice(start, end)
    expect(chip).toContain('bg-elevated font-medium text-primary')
    expect(chip).toContain('text-secondary hover:bg-elevated/60')
    // ⚠️ 断言范围必须收在这颗 chip 内：`chip-accent` 在中栏头给色标用，全局断言会假红。
    expect(chip).not.toContain('chip-accent')
    expect(chip).not.toContain('bg-accent-tint')
  })

  it('多选时点 chip 不收起浮层（否则选第二个风格要重新点开）', () => {
    const app = read(APP)
    const start = app.indexOf('aria-pressed={active}')
    const end = app.indexOf('title={`按风格')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const chipClick = app.slice(start, end)
    expect(chipClick).toContain('setFilter')
    expect(chipClick).not.toContain('setStylePanel(false)')
  })

  it('清空风格筛选只在有选中时出现', () => {
    const app = read(APP)
    expect(app).toContain('title="清空风格筛选"')
    expect(app).toContain('{styleFilterActive && (')
  })
})

// ── ⑦ 搬家不得连累被钉住的其它中栏头契约 ─────────────────────────

describe('搬家副作用守卫：marks / 色标 / 舞台的既有契约原样保留', () => {
  it('色标四条字面量还在（marks.test.ts 的钉点未被触碰）', () => {
    const app = read(APP)
    expect(app).toContain("type QuickPanel = 'size' | 'time' | 'color' | null")
    expect(app).toContain('<ColorTagPicker')
    expect(app).toContain('toggleColorTag(filters.colorTags, tag)')
    expect(app).toContain('回收站不支持色标筛选（返回资产视图后可用）')
    expect(app).toContain('settings?.showColorTags !== false')
    // 舞台落点尺寸也在这条链上，顺手钉一下（改风格不该动它）
    expect(app).toContain('const STAGE_SLOT = 140')
  })
})
