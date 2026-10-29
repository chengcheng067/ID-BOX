/**
 * 「全部」视图下隐藏 `体积` / `分辨率` / `格式` 三个筛选入口（2026-10-29 用户要求）。
 *
 * 用户原话：
 * > 「在本地素材库**全部的界面下**不显示这几个选项」
 *
 * 三张配图逐像素确认的红箭头指向中栏头那排 chip：`体积`、`分辨率`、`格式`。
 * 同一排的 `时间` / `色标` / `风格` / `按导入时间` / `存为集合` **不在**本次范围（必须保留）。
 *
 * 关键设计（本次要钉死的三件事）：
 * ① 只在 App.tsx **入口可见性**上加一层 `hideInAllView` 排除，
 *    **不改** `shared/classify.ts` 的 `capsOfFilter` —— 它的 `'all' = 并集` 是全局语义，
 *    被 `tests/filterCaps.test.ts`、`sanitizeFiltersForKind`、其它维度共用；
 * ② 筛选**状态不能被清掉**：切到「全部」时 `minBytes` / `minResolution` / `modelFormat` 原值保留
 *    （入口消失 ≠ 条件失效，这正是 0.6.0 修过的"网格空着找不到原因"那类问题；
 *    但这里反过来：值保留、只是不给入口，进具体大类就能看到并调整）；
 * ③ 浮层要跟着收起：`体积` 走 `quickPanel === 'size'`，不在原来那个
 *    `showResolutionEntry / showModelFormatEntry` 的 effect 里，必须补一句。
 *
 * UI 测试环境是 `environment: 'node'`（无 jsdom），组件渲染不了 ——
 * 因此源码守卫 + 纯函数两条路（本仓库惯例见 `tests/filterCaps.test.ts` /
 * `tests/sidebarSlim.test.ts` / `tests/toolbarStyleFilter.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { capsOfFilter } from '../src/shared/classify'
import {
  DEFAULT_FILTERS,
  sanitizeFiltersForKind,
  type Filters
} from '../src/renderer/logic/filters'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const app = read('src/renderer/App.tsx')
const classifySrc = read('src/shared/classify.ts')
const filtersSrc = read('src/renderer/logic/filters.ts')

function f(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

// ── ① 源码守卫：`hideInAllView` 存在，且体积 chip 被它门控 ──────────

describe('App.tsx 源码守卫：「全部」视图门控', () => {
  it('存在 `const hideInAllView = filters.kind === \'all\'` 这个唯一判据', () => {
    expect(app).toMatch(/const hideInAllView\s*=\s*filters\.kind\s*===\s*'all'/)
  })

  it('`体积` chip 由 `{showSizeEntry && (` 条件包住（不再是无条件渲染）', () => {
    // 门控必须在「体积」按钮之前，且「体积」按钮在它后面（顺序断言，防止写反）
    const gate = app.indexOf('{showSizeEntry && (')
    expect(gate).toBeGreaterThan(-1)
    const sizeButton = app.indexOf("onClick={toggleQuickPanel('size')}")
    expect(sizeButton).toBeGreaterThan(gate)
    // 两个门控之间要能读到按钮的文案（确认包住的确实是「体积」那颗）
    expect(app.slice(gate, sizeButton)).toContain('体积')
  })

  it('`体积` 的门控值来自 `hideInAllView`（而不是别的条件）', () => {
    expect(app).toMatch(/const showSizeEntry\s*=\s*!hideInAllView\b/)
  })
})

// ── ② 源码守卫：分辨率 / 格式的定义里都带 `!hideInAllView` ──────────

describe('App.tsx 源码守卫：分辨率 / 格式也排除「全部」', () => {
  it('`showResolutionEntry` = capsOfFilter(...) && !hideInAllView', () => {
    expect(app).toMatch(
      /const showResolutionEntry\s*=\s*capsOfFilter\(filters\.kind,\s*'resolution'\)\s*&&\s*!hideInAllView/
    )
  })

  it('`showModelFormatEntry` = capsOfFilter(...) && !hideInAllView', () => {
    expect(app).toMatch(
      /const showModelFormatEntry\s*=\s*capsOfFilter\(filters\.kind,\s*'modelFormat'\)\s*&&\s*!hideInAllView/
    )
  })

  it('两个 chip 仍分别包在各自门控里（门控没被顺手删掉）', () => {
    expect(app.indexOf('{showResolutionEntry && (')).toBeGreaterThan(-1)
    expect(app.indexOf("onClick={toggleExtraPanel('resolution')}")).toBeGreaterThan(
      app.indexOf('{showResolutionEntry && (')
    )
    expect(app.indexOf('{showModelFormatEntry && (')).toBeGreaterThan(-1)
    expect(app.indexOf("onClick={toggleExtraPanel('format')}")).toBeGreaterThan(
      app.indexOf('{showModelFormatEntry && (')
    )
  })
})

// ── ③ 源码守卫：体积浮层跟着收起 ──────────────────────────────────

describe('App.tsx 源码守卫：入口消失时浮层必须一起收', () => {
  it('`!showSizeEntry` 分支里收 `quickPanel === \'size\'`', () => {
    const idx = app.indexOf("if (!showSizeEntry) setQuickPanel((p) => (p === 'size' ? null : p))")
    expect(idx).toBeGreaterThan(-1)
    // 必须落在那个 effect 里（前面紧邻 `useEffect(() => {`，说明不是挂在别处）
    const before = app.slice(0, idx)
    const lastEffect = before.lastIndexOf('useEffect(() => {')
    expect(lastEffect).toBeGreaterThan(-1)
    expect(before.slice(lastEffect)).not.toContain('}, [')
  })

  it('`showSizeEntry` 在那个 effect 的依赖数组里（否则值变了 effect 不重跑）', () => {
    expect(app).toMatch(
      /\}, \[showResolutionEntry, showModelFormatEntry, showSizeEntry\]\)/
    )
  })
})

// ── ④ 反向断言：能力表**未被改** ──────────────────────────────────

describe('反向断言：`capsOfFilter` 的「全部 = 并集」语义原样保留', () => {
  it('shared/classify.ts 里那句并集实现仍在原样', () => {
    expect(classifySrc).toContain(
      "if (f === 'all') return ALL_ASSET_KINDS.some((k) => KIND_FILTER_CAPS[k][cap])"
    )
    // 语义说明那句也还在（改语义时必须改这里，施工者才会看见这段注释）
    expect(classifySrc).toContain("`'all'` = 所有真实 kind 的**并集**")
  })

  it('行为面：`all` 的 resolution / modelFormat 仍为 true（别人依赖这条）', () => {
    expect(capsOfFilter('all', 'resolution')).toBe(true)
    expect(capsOfFilter('all', 'modelFormat')).toBe(true)
  })

  it('App.tsx 里没有把 `all` 塞进 capsOfFilter 的判定（排除只发生在入口层）', () => {
    // 排除必须是 `!hideInAllView` 这种独立门控，不能靠改能力表
    expect(app).not.toContain('KIND_FILTER_CAPS')
  })
})

// ── ⑤ 纯函数层：切到「全部」不清筛选状态 ───────────────────────────

describe('sanitizeFiltersForKind · 切到「全部」三个筛选值原样保留', () => {
  it('minBytes / minResolution / modelFormat 全都在（入口消失 ≠ 条件失效）', () => {
    const before = f({
      kind: 'all',
      minBytes: 10_000_000,
      minResolution: '2k',
      modelFormat: 'max'
    })
    const after = sanitizeFiltersForKind(before)
    expect(after.minBytes).toBe(10_000_000)
    expect(after.minResolution).toBe('2k')
    expect(after.modelFormat).toBe('max')
  })

  it('从模型视图切进「全部」（kind: model → all）也不清这三个值', () => {
    const fromModel = f({
      kind: 'model',
      minBytes: 50_000_000,
      minResolution: null,
      modelFormat: 'skp'
    })
    const after = sanitizeFiltersForKind({ ...fromModel, kind: 'all' })
    expect(after.minBytes).toBe(50_000_000)
    expect(after.modelFormat).toBe('skp')
  })

  it('门控只在入口层：capability 仍报 true，sanitize 因此不会清', () => {
    // 这条把 ① 和 ⑤ 连起来：如果哪天有人"顺手"把 capsOfFilter('all') 改成 false，
    // sanitize 会把值清掉 → 上面两条断言先红，这条是根因说明。
    expect(capsOfFilter('all', 'resolution')).toBe(true)
    expect(capsOfFilter('all', 'modelFormat')).toBe(true)
    // filters.ts 的 sanitize 保持原样（本次没动它）
    expect(filtersSrc).toContain("if (!capsOfFilter(f.kind, 'resolution')) {")
    expect(filtersSrc).toContain("if (!capsOfFilter(f.kind, 'modelFormat')) next.modelFormat = null")
  })
})

// ── ⑥ 保留项：时间 / 色标 / 风格 / 存为集合 未被本次门控波及 ────────

describe('未在范围内的入口必须保持原样', () => {
  it('`时间` chip 仍是无条件渲染（不在任何 show*Entry 门控里）', () => {
    const timeButton = app.indexOf("onClick={toggleQuickPanel('time')}")
    expect(timeButton).toBeGreaterThan(-1)
    // 往前找最近的 JSX 表达式门控 / 注释块，确认不是 `{showXxxEntry && (`
    const before = app.slice(Math.max(0, timeButton - 400), timeButton)
    expect(before).not.toContain('{showSizeEntry && (')
    expect(before).not.toContain('{showTimeEntry && (')
  })

  it('`色标` / `风格` 的门控没被塞入 `hideInAllView`', () => {
    expect(app).toMatch(/const showStyleEntry\s*=\s*\n?\s*capsOfFilter\(filters\.kind,\s*'style'\)/)
    expect(app).not.toMatch(/showStyleEntry\s*=[\s\S]{0,120}hideInAllView/)
    // 色标的门控是设置项，与视图无关
    expect(app).toContain('showColorTagsEntry')
    expect(app).not.toMatch(/showColorTagsEntry\s*=[\s\S]{0,120}hideInAllView/)
  })

  it('「存为集合」入口未受影响（`saveViewDisabled` 只看回收站与上限）', () => {
    expect(app).toContain('const saveViewDisabled = trashMode || savedViewCount >= SAVED_VIEW_LIMIT')
    expect(app).not.toMatch(/saveViewDisabled[\s\S]{0,80}hideInAllView/)
  })
})
