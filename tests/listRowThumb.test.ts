/**
 * 列表视图（表格）行首缩略图列的守卫（2026-11-09 用户反馈）。
 *
 * 用户原话：「idbox 本体表格显示的前方也需要加上缩略图的缩小版」。
 *
 * 为什么用源码守卫而不是渲染测试：本仓库组件测试一律跑 node（无 DOM），
 * `AssetGrid` 是 3000+ 行的大组件、依赖 store / Dexie / vault:// 协议，渲不出来。
 * 而这一列真正容易被人改坏的恰好是**看不见的约束**：
 *
 * ① **行高**：表格行高由内容决定，缩略图单元格若带 `py-2`（8+8），30px 的图会把它顶到
 *    46px → 虚拟滚动用的 `LIST_ROW_H` / 实测 `listRowH` 全部错位。实机量过：
 *    无缩略图列时行高 **36.33px**，注入 40×30 的盒子 + `py-0` 后**仍是 36.33px**（深色主题、dpr 1.5）。
 * ② **数据源不许新解码**：必须是卡片封面同一份缓存（`thumbStatus==='ready' && thumbPath`
 *    → `thumbVaultUrl`），否则每滚一屏就多解码 40 张原图。
 * ③ **降级**：无缩略图 / 加载失败一律 `KIND_ICON[kind]`（`.d5a` 因此天然拿到 `IconD5a`），
 *    不留白、不出现 broken image。
 * ④ **主题**：只能用 token，**不许** `dark:` 变体（本项目是 `[data-theme]` 属性切换，
 *    `tailwind.config.js` 没有 `darkMode:'class'`，`dark:` 会跟系统而不是跟应用）。
 * ⑤ **虚拟化占位行**：上下 spacer 与重复组标题的 `colSpan` 必须等于总列数（7），
 *    漏改会让 spacer 只撑 6 列 → 纵向出现错位的空白条。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const GRID = 'src/renderer/components/AssetGrid.tsx'

/** 取出某个模块级函数的源码块（从 `function X(` 到下一个行首 `}`） */
function functionBlock(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`找不到模块级函数 ${name}`)
  const end = src.indexOf('\n}', at)
  if (end < 0) throw new Error(`${name} 的结尾没找到`)
  return src.slice(at, end + 2)
}

describe('列表视图 · 行首缩略图列', () => {
  const src = read(GRID)

  it('ListThumb 是**模块级**组件（内联函数会让滚动时整行卸载重建）', () => {
    expect(src).toMatch(/^function ListThumb\(/m)
    // 反例守卫：不许写成 renderRow 里的内联组件（`const ListThumb = () =>`）
    expect(src).not.toMatch(/const ListThumb\s*=/)
  })

  it('数据源是卡片封面同一份缓存（不新解码原图、不新增接口）', () => {
    const block = functionBlock(src, 'ListThumb')
    expect(block).toContain("asset.thumbStatus === 'ready'")
    expect(block).toContain('asset.thumbPath')
    expect(block).toContain('thumbVaultUrl(')
  })

  it('无缩略图 / 加载失败都降级到 KIND_ICON（不留白、不出现 broken image）', () => {
    const block = functionBlock(src, 'ListThumb')
    expect(block).toContain('KIND_ICON[asset.kind]')
    expect(block).toContain('onError')
    // `.d5a` 走的就是这条降级（KIND_ICON.d5a === IconD5a），不需要特判
    expect(src).toMatch(/d5a: IconD5a/)
  })

  it('盒子是 40×30（4:3）+ object-contain（与卡片封面同一口径）', () => {
    const block = functionBlock(src, 'ListThumb')
    expect(block).toContain('h-[30px]')
    expect(block).toContain('w-[40px]')
    expect(block).toContain('object-contain')
  })

  it('只用 token：块内没有 dark: 变体、没有写死 hex', () => {
    const block = functionBlock(src, 'ListThumb')
    expect(block).not.toMatch(/\bdark:/)
    // hex（含 3/6/8 位）与 rgb() 都不许出现
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/rgba?\(/)
    // 允许的色调来源：bg-canvas / border-line / text-muted
    expect(block).toContain('bg-canvas')
    expect(block).toContain('text-muted')
  })

  it('行高不变：缩略图单元格是 py-0（带 py-2 会把行顶到 46px）', () => {
    // 行内单元格（含 ListThumb 的那一格）
    expect(src).toMatch(/<td className="w-\[48px\] px-1 py-0 align-middle">\s*<ListThumb asset=\{a\} \/>/)
    // 表头同宽对齐
    expect(src).toMatch(/<th className="w-\[48px\] px-1 py-2" aria-label="缩略图" \/>/)
  })

  it('列序：缩略图在「名称」之前（复选框列之后）', () => {
    const head = src.slice(src.indexOf('<thead>'), src.indexOf('</thead>'))
    const thumb = head.indexOf('aria-label="缩略图"')
    const name = head.indexOf('>名称<')
    const checkbox = head.indexOf('aria-label="选择 / 拖动归类"')
    expect(checkbox).toBeGreaterThan(-1)
    expect(thumb).toBeGreaterThan(checkbox)
    expect(name).toBeGreaterThan(thumb)
  })

  it('虚拟化 spacer / 重复组标题的 colSpan 跟着变成 7（漏改会错位）', () => {
    expect(src).toContain('colSpan={7}')
    expect(src).not.toContain('colSpan={6}')
    // 三处：重复组标题 + 上 spacer + 下 spacer
    expect(src.match(/colSpan=\{7\}/g)?.length).toBe(3)
  })
})
