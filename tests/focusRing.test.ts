/**
 * 键盘焦点环（2026-10-30 用户实测：点任何按钮都冒一个橙色框）。
 *
 * 根因不是某处写错了颜色，而是**全仓几乎没定义 focus 样式** ——
 * 只有 1 处按钮自定义过，其余全部退回 Chromium 默认轮廓，而 Chromium 在
 * Windows 上取系统强调色（用户机器上是橙/金），于是每个按钮都冒橙框。
 *
 * 修复是 `styles.css` 的 `@layer base` 里一段全局规则。vitest 是
 * `environment: 'node'`，没有真实渲染引擎，所以这里守的是**源码形状**：
 * 那段规则必须在、颜色必须走 `--accent`、必须用 `focus-visible` 而不是 `focus`
 * 单独生效（否则鼠标点击也会出环）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const CSS = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf-8')

/** 剥掉注释：说明文字里必然会写「橙色」「outline: none」这些反例，不剥会误判 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('全局键盘焦点环：统一 accent 蓝，不自造色值', () => {
  const code = stripComments(CSS)

  it('定义了两个主题的 --accent（焦点环的颜色来源）', () => {
    const hits = code.match(/--accent:\s*#[0-9a-fA-F]{6}/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
    // 系统蓝：浅色 #007aff / 深色 #0a84ff
    expect(code).toMatch(/--accent:\s*#007aff/i)
    expect(code).toMatch(/--accent:\s*#0a84ff/i)
  })

  it(':focus-visible 用 --accent 画 2px 环，且正偏移（不被自身 border 吃掉）', () => {
    expect(code).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/)
    expect(code).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/)
  })

  it('基础 :focus 被掐掉默认轮廓（橙框的真正来源是 Chromium 默认 outline）', () => {
    // `:focus { outline: none }` —— 注意要排除 `:focus-visible` 那条
    expect(code).toMatch(/(^|[\s,}])\)?:focus\s*\{[^}]*outline:\s*none/)
  })

  it('鼠标点击态被精确排除（button:focus:not(:focus-visible)）', () => {
    expect(code).toContain('button:focus:not(:focus-visible)')
  })

  it('输入框只走自己那套（不与 .input 的 focus:ring 叠加成双边框）', () => {
    expect(code).toMatch(/input:focus-visible[\s\S]{0,120}outline:\s*none/)
  })

  it('焦点环没有引入任何硬编码的橙色系色值', () => {
    // 橙色典型区间：#f59e0b / #ea580c / orange 等；焦点环段落里一个都不许有
    const focusBlock = code.slice(
      code.indexOf(':focus'),
      code.indexOf(':focus') + 2000
    )
    expect(focusBlock).not.toMatch(/#(f59e0b|ea580c|fb923c|fdba74|ff8c00|ffa500)/i)
    expect(focusBlock).not.toMatch(/\borange\b/i)
  })
})
