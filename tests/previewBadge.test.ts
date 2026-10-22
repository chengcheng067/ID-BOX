import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 顶栏「Preview」测试版徽标（用户 2026-10-22 要求）。
 *
 * 为什么值得一条源码守卫：这颗胶囊用的是**新加的一对 token**（`--preview` /
 * `--preview-tint`），而 token 体系有三处必须同时对上才能生效 ——
 * ① `styles.css` 的**浅色与深色两个主题块**都要定义；
 * ② `tailwind.config.js` 要把它映射成颜色（否则 `bg-preview-tint` 不生成）；
 * ③ 组件里要用这两个类名而不是写死 hex。
 * 少任何一处，徽标就会「浅色正常、深色看不见」或者「类名不生成、完全没有底」，
 * 而这类问题在真机上很容易被当成"没做"。
 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

describe('Preview 徽标：token 三处对齐', () => {
  it('styles.css 的浅色与深色主题都定义了 --preview / --preview-tint', () => {
    const css = read('../src/renderer/styles.css')
    // 每个 token 至少出现两次（浅色块 + 深色块）
    const preview = css.match(/--preview:/g) ?? []
    const previewTint = css.match(/--preview-tint:/g) ?? []
    expect(preview.length).toBeGreaterThanOrEqual(2)
    expect(previewTint.length).toBeGreaterThanOrEqual(2)
    // 色值必须真是紫的（防有人手滑写成蓝/灰）：浅色 #7a5af8、深色 #b18cff
    expect(css).toContain('--preview: #7a5af8')
    expect(css).toContain('--preview: #b18cff')
  })

  it('tailwind.config.js 把两个 token 映射成颜色类', () => {
    const cfg = read('../tailwind.config.js')
    expect(cfg).toContain("preview: token('--preview')")
    expect(cfg).toContain("'preview-tint': token('--preview-tint')")
  })

  it('顶栏把徽标渲染在 Logo 标题之后，且只用 token 类（不写死色值）', () => {
    const src = read('../src/renderer/components/Toolbar.tsx')
    expect(src).toContain('bg-preview-tint')
    expect(src).toContain('text-preview')
    // JSX 里文字常单独占一行，所以按「文字 + 闭标签」匹配，不按 `>Preview<`
    expect(src).toMatch(/Preview\s*<\/span>/)
    // 文案要说明"测试版"，否则用户看到一个孤零零的英文单词不知道什么意思
    expect(src).toContain('测试版')
    // 位置：ID BOX 标题之后（同一左段），不是顶栏右侧
    const titleAt = src.indexOf('ID BOX</span>')
    const badgeAt = src.indexOf('Preview', titleAt)
    expect(titleAt).toBeGreaterThan(-1)
    expect(badgeAt).toBeGreaterThan(titleAt)
    // 不许写死紫色 hex（会脱离深浅主题）
    expect(src).not.toMatch(/#7a5af8|#efe9fe|#b18cff|#2b2140/i)
  })
})
