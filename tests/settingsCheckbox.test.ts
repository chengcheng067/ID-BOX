/// <reference lib="dom" />
/**
 * 设置页复选框必须是自绘控件（用户 2026-10 拍板：「不要系统的默认控件」）。
 *
 * 渲染层没有 jsdom（vitest `environment: 'node'`），所以只能扫源码钉住这件事。
 * 守卫分三层：
 * ① **硬红线**：`SettingsDialog.tsx` 里不许出现 `type="checkbox"` —— 出现即失败；
 *    全仓库唯一允许写原生 checkbox 的地方是 `AlphaMapToggles.tsx`（本轮不在改动范围），
 *    所以扫描时把它单独排除，红线仍然只针对设置页；
 * ② **视觉语言**：自绘标记必须复用既有 token（`border-accent` / `bg-accent` / `border-line`），
 *    不许写死色值、不许再挂 `accent-color`（那是滑块 `.slider-accent` 专用的）；
 * ③ **可访问性 + 语义不变**：`role="checkbox"` + `aria-checked` + 可聚焦；
 *    5 个调用点的 setter 必须原样存在（`setPicked` / `setForceAck` / 三个 apply 勾选），
 *    换控件不许顺手改业务逻辑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_DIR = path.join(process.cwd(), 'src', 'renderer', 'components')

const read = (rel: string): string =>
  fs.readFileSync(new URL(`../src/renderer/${rel}`, import.meta.url), 'utf-8')

/** 去掉块注释与行注释：守卫只针对真实代码，注释里提到 checkbox 不算违规 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const settingsCode = (): string => codeOnly(read('components/SettingsDialog.tsx'))

/**
 * 按「函数名 → 下一个顶层 function」切出一段**去注释后的组件源码**。
 *
 * 为什么不能先 `codeOnly` 再 `indexOf('设置页的一行')` 找边界：那个字面量本身就在
 * 文档注释里，去注释后就不存在了 → `indexOf` 返 -1 → `slice(x, -1)` 几乎等于整份文件，
 * 守卫会拿别处的十六进制色当控件实现判红（假红），也可能反过来放过真问题。
 */
function componentSource(name: string): string {
  const src = read('components/SettingsDialog.tsx')
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const nextAt = src.indexOf('\nfunction ', at + 1)
  return codeOnly(src.slice(at, nextAt > at ? nextAt : src.length))
}

describe('设置页不许有系统默认复选框（硬红线）', () => {
  it('SettingsDialog.tsx 里 `type="checkbox"` 出现次数为 0', () => {
    const src = read('components/SettingsDialog.tsx')
    expect(codeOnly(src)).not.toContain('type="checkbox"')
    // 自绘控件靠 `role="checkbox"` 撑语义（那是必须的），红线只针对**原生控件**
    expect(codeOnly(src).match(/<input/gi)?.length ?? 0).toBeGreaterThanOrEqual(0)
    expect(codeOnly(src).match(/type="checkbox"/g) ?? []).toEqual([])
  })

  it('设置页一个原生 checkbox input 都没有（复选框曾经靠它白拿系统样式）', () => {
    const code = settingsCode()
    expect(code).not.toMatch(/<input\b[^>]*type=["']checkbox/)
    // 原生 input 不是禁止的（搜索框 / 别名输入框 / 数值框 / 文件框还在用），
    // 禁的是「复选框那种用法」：`checked=` 是 checkbox / radio 专属属性。
    const withChecked = [...code.matchAll(/<input\b[\s\S]{0,240}?\/>/g)]
      .map((m) => m[0])
      .filter((tag) => /\bchecked=|defaultChecked/.test(tag))
    expect(withChecked).toEqual([])
  })

  it('全仓库扫一遍：原生复选框只剩 AlphaMapToggles（本轮明确不改）', () => {
    const offenders = fs
      .readdirSync(COMPONENT_DIR)
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => codeOnly(fs.readFileSync(path.join(COMPONENT_DIR, f), 'utf-8')).includes('type="checkbox"'))

    expect(offenders).toEqual(['AlphaMapToggles.tsx'])
    expect(offenders).not.toContain('SettingsDialog.tsx')
  })
})

describe('自绘复选框必须复用既有视觉语言', () => {
  const code = settingsCode()

  it('有自绘组件，且形状/配色沿用既有 token（不写死颜色、不再挂 accent-color）', () => {
    expect(code).toContain('function CheckMark')
    expect(code).toContain('function CheckRow')
    // 既有语言：§3.6 RadioDot 的描边档 + §3.3 选中徽章的 accent 底白勾
    expect(code).toContain('border-accent bg-accent text-white')
    expect(code).toContain('border-line')
    // 只看这两个组件本体：文件里别处本来就有画布预览用的十六进制色（主题缩略图 mock），
    // 那不属于控件实现，全文件扫会对既有代码误判。
    const cmp = componentSource('CheckMark') + componentSource('CheckRow')
    expect(cmp).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // `accent-color` 是滑块专用（`.slider-accent`），自绘控件不许借用系统强调色机制
    expect(code).not.toContain('accent-color')
  })

  it('5 个调用点全部换成自绘 CheckRow（换一半 = 用户还会看到系统控件）', () => {
    expect(code.match(/<CheckRow/g)?.length).toBe(5)
    expect(code).not.toMatch(/<label\b[\s\S]{0,120}type="checkbox"/)
  })

  it('行内尺寸 16×16（不是 22×22 的卡片徽章），配设置页 12px 行密度', () => {
    const mark = code.slice(code.indexOf('function CheckMark'), code.indexOf('function CheckRow'))
    expect(mark).toContain('h-4 w-4')
    expect(mark).not.toContain('h-[22px]')
    expect(code).toContain('text-[12px]')
    expect(code).toContain('gap-2')
  })

  it('白勾走 icons.tsx 的共享 IconCheck（不为这颗勾另画一份 svg）', () => {
    const src = read('components/SettingsDialog.tsx')
    expect(src).toContain("from '../icons'")
    expect(settingsCode()).toMatch(/<IconCheck width=\{10\} height=\{10\}/)
  })
})

describe('可访问性：可聚焦、可键盘操作、语义是 checkbox', () => {
  const code = settingsCode()

  it('每个调用点都是 role="checkbox" + aria-checked', () => {
    expect(code).toContain('role="checkbox"')
    expect(code).toContain('aria-checked={checked}')
  })

  it('用原生 <button> 拿到键盘能力（Enter/Space），不靠 span + 手写按键', () => {
    const row = componentSource('CheckRow')
    expect(row).toContain('<button')
    expect(row).toContain('type="button"')
    // 置灰仍用 aria-disabled：原生 disabled 的 button 不可聚焦，键盘用户会整行失踪
    expect(row).toContain('aria-disabled={disabled}')
    expect(row).not.toMatch(/^\s*disabled=\{disabled\}/m)
    expect(row).toContain('focus-visible:ring-2 focus-visible:ring-accent/20')
  })
})

describe('5 个调用点的业务语义一字未改', () => {
  const code = settingsCode()

  it('① 别名建议勾选列表：仍是 setPicked（勾选 → 显式按钮才写库）', () => {
    expect(code).toMatch(/checked=\{picked\.includes\(s\.key\)\}/)
    expect(code).toMatch(/setPicked\(\(prev\) =>\s*next \? \[\.\.\.prev, s\.key\] : prev\.filter\(\(k\) => k !== s\.key\)/)
    expect(code).toContain('加入选中项（')
    expect(code).toContain('只在你勾选并点「加入选中项」后才写入')
  })

  it('② 强制重扫「我已了解」确认：仍是 setForceAck，确认按钮仍被它禁用', () => {
    expect(code).toContain('checked={forceAck}')
    expect(code).toContain('onChange={setForceAck}')
    expect(code).toContain('disabled={!forceAck}')
    expect(code).toContain('我已了解标签 / 备注 / 风格会丢失，仍要强制重扫')
  })

  it('③④⑤ 一致性报告三个 apply 勾选：setter 与置灰条件原样', () => {
    const three = [
      ['pickMissing', 'setPickMissing', "report.counts['missing-on-disk'] === 0"],
      ['pickNotIndexed', 'setPickNotIndexed', "report.counts['not-in-index'] === 0"],
      ['pickMismatch', 'setPickMismatch', "report.counts['category-mismatch'] === 0"]
    ]
    for (const [state, setter, gate] of three) {
      expect(code).toContain(`checked={${state}}`)
      expect(code).toContain(`onChange={${setter}}`)
      expect(code).toContain(`disabled={${gate}}`)
    }
    // 默认全 false（不能因为换控件顺手改成默认勾选）
    for (const state of ['pickMissing', 'pickNotIndexed', 'pickMismatch']) {
      expect(code).toMatch(new RegExp(`const \\[${state}, set[A-Za-z]+\\] = useState\\(false\\)`))
    }
    expect(code).toContain('勾选后才会修改（默认全部不勾）')
  })
})
