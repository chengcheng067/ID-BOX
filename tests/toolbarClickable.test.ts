/**
 * 顶栏右侧控件的**可点性**守卫（2026-11-09 用户 P0：「大中小三个预览的选择也是无法
 * 被选中的」＋「本体目前是没有右键重命名的选择的」两条反馈里的前者）。
 *
 * ## 现场取证（第二实例 + CDP，`--user-data-dir` 独立 profile，v1.0.0 装机包）
 *
 * 对照组（搜索面板收起）：`document.elementFromPoint(每个按钮中心)` 命中按钮**自身**，
 * 真实鼠标事件点击有效，卡片宽度随档位变化 138 / 215 / 260 px —— 代码本身没问题。
 *
 * 出问题的状态（**搜索面板展开**，用户找那个"不见了的" `.d5a` 时就是这个状态）：
 *
 *   elementFromPoint(大/中/小)  →  DIV.hsc-shade
 *   elementFromPoint(最小化/最大化/关闭) → DIV.hsc-shade
 *   elementFromPoint(视图切换 grid)      → DIV.hsc-shade
 *
 * 祖先链：`div.hsc-shade` ← `div.hsc-root[data-open=true]`（`position:relative; z-index:30`）
 *        ← `header.topbar.app-drag.relative.z-20`（顶栏）
 *
 * 根因：`.hsc-shade` 是 `position: fixed; inset: 0` 的**全视口透明点击层**（"点门外关面板"），
 * 它挂在 `z-index: 30` 的 `.hsc-root` 里，而顶栏右侧那些**静态定位**的兄弟（视图切换 /
 * 密度三档 / 自绘窗口钮）没有 z-index ⇒ 全部落在它下面。点它们只会关掉面板，控件收不到
 * click。修法：遮罩上边界压到顶栏以下（`--hsc-chrome-h` = `h-14` = 56px）。
 *
 * 为什么这条必须有测试：组件在 node 环境渲染不了（本仓库组件测试一律走源码守卫），
 * 而"把 `inset` 写回 0"不会有任何编译错误 —— 只会让顶栏在这一状态下**再次**整排点不动，
 * 且极难被走查发现（要先打开搜索面板）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const SEARCH_CSS = 'src/renderer/components/home/home-search-command.css'
const TOOLBAR = 'src/renderer/components/Toolbar.tsx'

/** 取某个 CSS 选择器的规则体（`{` 到匹配的 `}`），找不到返回 null */
function ruleOf(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return null
  const start = css.indexOf('{', at)
  const end = css.indexOf('}', start)
  if (start < 0 || end < 0) return null
  return css.slice(start + 1, end)
}

describe('搜索面板的「门外点击层」不许盖住顶栏', () => {
  it('.hsc-shade 的上边界压在顶栏以下（不是全视口 inset: 0）', () => {
    const css = read(SEARCH_CSS)
    const body = ruleOf(css, '.hsc-shade')
    expect(body).not.toBeNull()
    const rule = body as string

    // 顶栏高度常量必须与 Toolbar 的 `h-14`（56px）对齐，并且真的被 inset 用上
    expect(rule).toMatch(/--hsc-chrome-h:\s*56px/)
    expect(rule).toMatch(/inset:\s*var\(--hsc-chrome-h\)\s+0\s+0\s+0/)
    // 反例守卫：`inset: 0` / `top: 0` 会让遮罩重新盖住整排顶栏控件
    expect(rule).not.toMatch(/inset:\s*0\s*;/)
    expect(rule).not.toMatch(/^\s*top:\s*0\s*;/m)
  })

  it('顶栏高度确实是 56px（h-14），常量不会悄悄失真', () => {
    const src = read(TOOLBAR)
    // 顶栏根节点：`<header className="topbar app-drag relative z-20 flex h-14 …">`
    expect(src).toMatch(/<header className="[^"]*\bh-14\b/)
  })

  it('遮罩仍然存在（"点门外关面板"的语义不许被顺手删掉）', () => {
    const css = read(SEARCH_CSS)
    const rule = ruleOf(css, '.hsc-shade') as string
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/background:\s*transparent/)
    // 必须吃点击：写成 pointer-events: none 就等于没有遮罩
    expect(rule).not.toMatch(/pointer-events:\s*none/)
  })
})

describe('密度三档（大 / 中 / 小）本身仍然接在设置上', () => {
  it('三个档位都写 Settings.gridDensity，且带 no-drag / aria-pressed', () => {
    const src = read(TOOLBAR)
    const at = src.indexOf('aria-label="网格密度"')
    expect(at).toBeGreaterThan(0)
    const block = src.slice(at, at + 1200)
    expect(block).toContain('saveSettings({ gridDensity: opt.value })')
    expect(block).toContain('aria-pressed={gridDensity === opt.value}')
    expect(block).toContain('app-no-drag')
    // 三档字面量不许缩水（'large' / 'medium' / 'small'）
    for (const v of ["value: 'large'", "value: 'medium'", "value: 'small'"]) {
      expect(src).toContain(v)
    }
  })
})
