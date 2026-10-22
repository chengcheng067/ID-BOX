/**
 * 中栏头「排序胶囊」自绘浮层（2026-10 用户反馈）—— 源码守卫。
 *
 * 背景（改这块之前必读）：
 *   原来排序用的是原生 `<select>`，`appearance-none` 只能去掉**控件外观**，
 *   点开后弹出的仍是 Chromium / 操作系统的下拉层（灰底、系统字体、系统高亮），
 *   与产品 UI 完全两个风格。用户原话：
 *   「包括这里按导入时间展开的地方，都是需要我们 UI 原生重绘的，不要系统的默认的东西出现。」
 *
 * 结论：排序入口必须是 `button` + 自绘面板，且与同一排「体积 / 时间 / 分辨率」浮层同构。
 * 本文件只钉契约（本仓库组件一律走源码守卫，node 环境渲染不了 React 组件）：
 *   ① App.tsx 里排序不再有 `<select>` / `appearance-none`；
 *   ② 浮层有无障碍语义（`role="listbox"` / `role="option"` / `aria-selected`）；
 *   ③ 关闭三条路径都在：点外部、Esc（捕获 + stopPropagation）、窗口 resize；
 *   ④ 选中即写回 `filters.sort` 并收起，取值域与 `SortKey` 不变；
 *   ⑤ 胶囊外观（28 高 / pill 底 / ▾）与当前排序名保持；
 *   ⑥ 进入软件内文件视图时一并收起（那视图没有这些按钮）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SORT_OPTIONS } from '../src/renderer/logic/filters'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const APP = 'src/renderer/App.tsx'

/**
 * 去掉注释后再断言「不该存在的东西」。
 * 守卫要防的是**代码**回退，不是注释里提到过 `<select>` 或 `appearance-none`
 * （本次修复的注释必须写清「为什么不用原生控件」，否则下一个人会改回去）。
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 + JSX 的 {/* … */}
    .replace(/^\s*\/\/.*$/gm, '') // 整行 // 注释
}

/**
 * 排序浮层的「关闭路径」effect 源码段。
 * 起点是它自己的注释头，终点是紧跟其后的主题 effect（文件里下一段带 `// ── 主题` 的注释）。
 */
function closeEffect(src: string): string {
  const start = src.indexOf('排序浮层的关闭路径')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('// ── 主题', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/**
 * 排序胶囊 + 浮层的 JSX 段。
 * 起点是包裹它们的 `sortRef` 容器，终点是紧随其后的「＋ 存为集合」注释块。
 */
function sortPillJsx(src: string): string {
  const start = src.indexOf('<div ref={sortRef}')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('0.6.0 智能集合', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('排序入口：不再出现原生 <select>', () => {
  it('App.tsx 里没有 select / option 标签，也没有 appearance-none 这种「只改控件外观」的补丁', () => {
    const src = codeOf(read(APP))
    expect(src).not.toContain('<select')
    expect(src).not.toContain('</select>')
    expect(src).not.toContain('<option')
    // 这行 class 是「原生控件 + 去外观」的标志，留着就说明弹层还是系统控件
    expect(src).not.toContain('appearance-none')
  })

  it('触发的是 button（不再是 label 包 select）', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('<button')
    expect(pill).toContain('type="button"')
    expect(pill).not.toContain('<label')
  })
})

describe('排序浮层：无障碍语义', () => {
  it('胶囊有 aria-haspopup="listbox" / aria-expanded / title="排序"', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('aria-haspopup="listbox"')
    expect(pill).toContain('aria-expanded={sortPanel}')
    expect(pill).toContain('title="排序"')
  })

  it('选项容器 role="listbox"，选项 role="option" + aria-selected', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('role="listbox"')
    expect(pill).toContain('role="option"')
    expect(pill).toContain('aria-selected={active}')
    // 列表要有可读名字，否则读屏只会念「列表」
    expect(pill).toContain('aria-label="排序方式"')
  })
})

describe('排序浮层：三条关闭路径', () => {
  it('点浮层外部关闭（mousedown + 容器 contains 判定）', () => {
    const src = read(APP)
    const block = closeEffect(src)
    expect(block).toContain("window.addEventListener('mousedown', onPointerDown)")
    expect(block).toContain('sortRef.current')
    expect(block).toContain('root.contains(e.target)')
    expect(block).toContain("window.removeEventListener('mousedown', onPointerDown)")
  })

  it('Esc 关闭用捕获阶段 + stopPropagation（不让同一次 Esc 又被全局快捷键消费）', () => {
    const block = closeEffect(read(APP))
    expect(block).toContain("if (e.key !== 'Escape') return")
    expect(block).toContain('e.stopPropagation()')
    expect(block).toContain("window.addEventListener('keydown', onKeyDown, true)")
    expect(block).toContain("window.removeEventListener('keydown', onKeyDown, true)")
  })

  it('窗口 resize 关闭（fixed 坐标在打开时写死，尺寸一变必错位）', () => {
    const block = closeEffect(read(APP))
    expect(block).toContain("window.addEventListener('resize', onResize)")
    expect(block).toContain("window.removeEventListener('resize', onResize)")
    expect(block).toContain('setSortPanel(false)')
  })

  it('收起前先判断「是否展开」，未展开时不挂监听', () => {
    const block = closeEffect(read(APP))
    expect(block).toContain('if (!sortPanel) return')
    expect(block).toContain('}, [sortPanel])')
  })
})

describe('排序浮层：交互与行为不变', () => {
  it('点选项 → 写回 filters.sort 并立即收起', () => {
    const src = read(APP)
    expect(src).toContain('const applySort = (value: SortKey): void => {')
    expect(src).toContain('setFilter({ sort: value })')
    expect(src).toContain('onClick={() => applySort(opt.value)}')
    // applySort 里必须收起；否则点完面板还挂着
    const start = src.indexOf('const applySort')
    const end = src.indexOf('const onSortKeyDown', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain('setSortPanel(false)')
  })

  it('取值域与 SORT_OPTIONS 完全不变（顺序 / 值 / 文案都钉住）', () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(['recent', 'name', 'size', 'su'])
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual(['按导入时间', '按名称', '按大小', '按 SU 版本'])
  })

  it('胶囊仍显示当前排序名，且不再是写死的「按导入时间」', () => {
    const src = read(APP)
    expect(src).toContain('SORT_OPTIONS.find((o) => o.value === filters.sort)?.label')
    expect(sortPillJsx(src)).toContain('{sortLabel}')
  })

  it('与同排浮层同构：fixed + 卡片描边阴影 + h-7 行高 + rounded-nav', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('fixed z-40')
    expect(pill).toContain('rounded-btn border border-line bg-card p-1 shadow-modal')
    expect(pill).toContain('flex h-7 w-full items-center rounded-nav px-2')
    expect(pill).toContain('hover:bg-elevated/60')
  })

  it('选中态只用一个指示（accent-tint，不叠勾号）', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('bg-accent-tint font-medium text-accent-text')
    expect(pill).not.toContain('✓')
  })

  it('胶囊外观保留原 token：28 高 pill 底 + 12px 文字 + ▾', () => {
    const pill = sortPillJsx(read(APP))
    expect(pill).toContain('h-7')
    expect(pill).toContain('rounded-pill-header bg-pill px-2.5')
    expect(pill).toContain('text-[12px] text-secondary')
    expect(pill).toContain('▾')
  })

  it('键盘：↑/↓ 移动高亮、Enter 应用（并阻断 button 的默认 click）', () => {
    const src = read(APP)
    const start = src.indexOf('const onSortKeyDown')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('// ── 主题', start)
    const block = src.slice(start, end)
    expect(block).toContain("e.key === 'ArrowDown'")
    expect(block).toContain("e.key === 'ArrowUp'")
    expect(block).toContain("e.key === 'Enter'")
    expect(block).toContain('e.preventDefault()')
    expect(block).toContain('applySort(opt.value)')
  })

  it('打开另一族浮层 / 进入文件视图时排序面板一起收起（互斥，不叠两个面板）', () => {
    const src = read(APP)
    // 体积 / 时间 / 色标 与 分辨率 / 存为集合 两族的 toggle 里都要顺手关排序
    const quickToggle = src.slice(src.indexOf('const toggleQuickPanel'), src.indexOf('const toggleExtraPanel'))
    expect(quickToggle).toContain('setSortPanel(false)')
    const extraToggle = src.slice(src.indexOf('const toggleExtraPanel'), src.indexOf('const [saveName'))
    expect(extraToggle).toContain('setSortPanel(false)')
    // 进入软件内文件视图的 effect
    const folderEffect = src.slice(
      src.indexOf('进入软件内文件视图时收起'),
      src.indexOf('[folderViewAssetId]')
    )
    expect(folderEffect).toContain('setSortPanel(false)')
  })
})
