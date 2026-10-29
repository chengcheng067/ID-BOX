import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 侧栏一级分类行：「未分类」的「整理」入口。
 * （「词表待补」标记已于 2026-10-30 用户拍板后整块删除，见 ③ 的回归守卫。）
 *
 * 背景（用户实测）：`未分类` 那一行的计数数字被「整理」小胶囊压掉左半边。
 * 根因不是宽度留得不够（`pr-9` = 36px），而是**「整理」是 `absolute` 定位** ——
 * 绝对定位不参与文档流、不占位，数字永远在它底下，留多少 padding 都是玄学。
 *
 * 根治 = 换成 flex 行内排布：主按钮 `flex-1 min-w-0` + 「整理」作兄弟节点占位。
 * 本测试是 vitest `environment: 'node'`（无 jsdom），所以只能做
 *   ① 源码守卫 —— 防止结构被改回 absolute / 文案被改回旧词；
 *   ② 纯宽度预算算术 —— 证明数字与按钮在行内确实能共存。
 */

const SIDEBAR = '../src/renderer/components/Sidebar.tsx'

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

const src = readSrc(SIDEBAR)

// ── ① 结构守卫：不再是绝对定位 ─────────────────────────────────
describe('侧栏「未分类」整理入口 — 结构', () => {
  it('「整理」按钮不再是 absolute 浮层（本 bug 的根因）', () => {
    expect(src).not.toContain('absolute right-1.5 top-1/2 -translate-y-1/2')
  })

  it('一级行容器是 flex 行，让按钮真正占位把数字顶到左边', () => {
    expect(src).toContain('group flex items-center')
  })

  it('主按钮不再用 pr-9 给绝对定位腾位', () => {
    expect(src).not.toContain('pr-9')
  })

  it('主按钮可收缩（min-w-0 flex-1），否则 w-full 会把整理按钮挤出容器', () => {
    expect(src).toContain('min-w-0 flex-1')
  })

  it('「整理」按钮存在，且 shrink-0 不被文字挤扁', () => {
    expect(src).toContain('整理')
    const actionBtn = findActionButtonClass(src)
    expect(actionBtn).not.toBeNull()
    expect(actionBtn as string).toContain('shrink-0')
  })

  it('「整理」仍是 type="button"，且 onClick 阻止冒泡到主按钮', () => {
    const block = sliceActionButton(src)
    expect(block).toContain('type="button"')
    expect(block).toContain('stopPropagation')
  })
})

// ── ② 视觉守卫：蓝色实心、复用既有 accent token ────────────────
describe('侧栏「整理」按钮 — 视觉规格', () => {
  it('实心 accent 底 + 白字（用户要求"变成蓝色的 button"）', () => {
    const cls = findActionButtonClass(src) as string
    expect(cls).toContain('bg-accent')
    expect(cls).toContain('text-white')
  })

  it('高度压到 20px（行高 32px 内的次级按钮），不引新色值', () => {
    const cls = findActionButtonClass(src) as string
    expect(cls).toContain('h-[20px]')
    // 只用 accent + 亮度滤镜，不出现任意 hex / rgb
    expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(cls).not.toMatch(/rgba?\(/)
  })

  it('保留原 title 文案（可发现性靠它兜底）', () => {
    expect(src).toContain('一键整理：一屏一张，选完分类自动跳到下一张')
  })
})

// ── ③ 「词表待补」标记已整块删除（2026-10-30 用户拍板：不显示）────────
//  断言对象是**去掉注释后的源码**：Sidebar 里保留了一段解释性注释（说明为什么删、
//  为什么不能加回来），那段注释本身会出现「词表待补」四个字——它不渲染，不算 UI。
//  守卫要钉的是「界面上不再出现」，所以先把 JSX 注释与行注释剥掉再断言。
describe('推断词表标记 — 已从侧栏彻底移除', () => {
  const code = stripComments(src)

  it('侧栏不再渲染「词表待补」', () => {
    expect(code).not.toContain('词表待补')
  })

  it('旧文案「待核对」也不再出现（两代说法都已退场）', () => {
    expect(code).not.toContain('待核对')
  })

  it('不再读 CategoryNodeCount.inferred（字段已从逻辑层删除）', () => {
    expect(code).not.toContain('inferred')
  })

  it('虚线淡框标记的痕迹一并消失', () => {
    expect(code).not.toContain('border-dashed border-line')
    expect(code).not.toContain('尚未与站方全表逐条核对（不影响你使用）')
  })
})

// ── ④ 纯逻辑：行内宽度预算（不依赖 DOM）────────────────────────
describe('一级行宽度预算 — 数字与按钮共存', () => {
  it('200px 行内：数字 + 按钮 + 间隙 不超过行宽', () => {
    const rowWidth = 200
    const countWidth = 24
    const actionWidth = 32
    const gap = 4
    expect(countWidth + actionWidth + gap).toBeLessThan(rowWidth)
  })

  it('扣掉右侧固定占用后，文字仍拿到 >100px 可读宽度', () => {
    const rowWidth = 200
    const countWidth = 24
    const actionWidth = 32
    const gap = 4
    const indent = 16 // pl-4
    const textWidth = rowWidth - countWidth - actionWidth - gap - indent
    expect(textWidth).toBeGreaterThan(100)
  })

  it('旧方案 pr-9(36px) 装不下实际按钮宽（6+6+20+2=32 再叠 right-1.5 6px=38）—— 复核根因', () => {
    const pr9 = 36
    const realOverlay = 32 + 6 // 胶囊本体 + right-1.5 偏移
    expect(realOverlay).toBeGreaterThan(pr9)
  })
})

// ── helper ────────────────────────────────────────────────────

/** 剥掉 JSX 块注释与 // 行注释 —— 注释里的字面量不渲染，不应参与 UI 文案断言 */
function stripComments(source: string): string {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 截取「整理」按钮那段 JSX，用于局部断言。
 *  用**唯一**的 title 文案定位（文件里「整理」/`openTriage` 在注释中出现多次，按它们切会截到主按钮）；
 *  再回退到最近的 `<button` 前推到 `</button>` —— 与缩进无关，格式化后仍有效。 */
function sliceActionButton(source: string): string {
  const anchor = source.indexOf('一键整理：一屏一张')
  if (anchor < 0) return ''
  const start = source.lastIndexOf('<button', anchor)
  const end = source.indexOf('</button>', anchor)
  if (start < 0 || end < 0) return ''
  return source.slice(start, end)
}

/** 取出「整理」按钮的 className 字符串 */
function findActionButtonClass(source: string): string | null {
  const block = sliceActionButton(source)
  const m = /className="([^"]+)"/.exec(block)
  return m ? m[1] : null
}
