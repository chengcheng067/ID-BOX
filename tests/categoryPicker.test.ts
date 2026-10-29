/**
 * 分类选择器（`CategoryPicker`）的**自绘浮层**——源码守卫。
 *
 * 背景（改这块之前必读）：
 *   一级 / 二级分类原来是原生 `<select>`，`appearance-none` 只去掉**控件外观**，
 *   点开后弹出的仍是 Chromium / 操作系统的下拉层（灰底、系统字体、系统高亮），
 *   与产品 UI 完全两个风格。用户原话：
 *   「包括这里按导入时间展开的地方，都是需要我们 UI 原生重绘的，不要系统的默认的东西出现。」
 *   排序胶囊已经按这套改完（见 `tests/sortMenu.test.ts`），本轮把分类选择器这两处补齐。
 *
 * 本文件只钉契约（本仓库组件一律走源码守卫，node 环境渲染不了 React 组件）：
 *   ① 文件里不再有 `<select>` / `<option>` / `appearance-none`；
 *   ② 两处触发件 + 两个 listbox 的无障碍语义齐全；
 *   ③ 三条关闭路径都在：点外部、Esc（捕获 + stopPropagation）、窗口 resize；
 *   ④ 二级联动逻辑的关键调用仍在（换 UI 承载不能把级联规则弄丢）；
 *   ⑤ 浮层容器 / 小标题 / 选项行三处 class 与排序浮层**逐字相同**（同一控件家族）。
 *
 * 注意：断言「不该存在的东西」之前必须**剥掉注释**——本次修复的注释里写满了
 * `<select>` / `appearance-none` 这些词（解释为什么不许用），不剥会把注释钉死。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const PICKER = 'src/renderer/components/CategoryPicker.tsx'
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

/** 出现次数（用来证明「两处」都改了，而不是只改了一处） */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

/** 排序浮层与分类浮层共用的三段 class（逐字对照，任何一处走样都会红） */
const PANEL_CONTAINER = 'fixed z-40 w-[176px] rounded-btn border border-line bg-card p-1 shadow-modal'
const PANEL_HEADING = 'px-2 pb-1 pt-1 text-[10px] text-tertiary'
const PANEL_ROW = 'flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition'
const PANEL_ROW_ACTIVE = 'bg-accent-tint font-medium text-accent-text'

describe('分类选择器：不再出现原生 <select>', () => {
  it('代码里没有 select / option 标签，也没有 appearance-none 这种「只改控件外观」的补丁', () => {
    const src = codeOf(read(PICKER))
    expect(src).not.toContain('<select')
    expect(src).not.toContain('</select>')
    expect(src).not.toContain('<option')
    expect(src).not.toContain('appearance-none')
  })

  it('触发件是 button（不再是 select 本体），且保留 .input 外观', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, 'type="button"')).toBeGreaterThanOrEqual(2)
    // 外观与尺寸沿用原来的输入框 token（只换展开层，不动列宽/字号）
    expect(count(src, 'className="input flex items-center justify-between gap-2 text-left"')).toBe(2)
    // 原生 select 的系统小箭头被自绘的 ▾ 取代
    expect(count(src, '▾')).toBe(2)
  })
})

describe('分类浮层：无障碍语义（一级 / 二级各一套）', () => {
  it('两个触发件都有 aria-haspopup="listbox" / aria-expanded', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, 'aria-haspopup="listbox"')).toBe(2)
    expect(count(src, 'aria-expanded={openField === ')).toBe(2)
    expect(src).toContain("aria-expanded={openField === 'level1'}")
    expect(src).toContain("aria-expanded={openField === 'level2'}")
  })

  it('两个选项容器都是 role="listbox" + 各自的 aria-label', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, 'role="listbox"')).toBe(2)
    expect(src).toContain('aria-label="一级分类"')
    expect(src).toContain('aria-label="二级分类"')
  })

  it('选项是 role="option" + aria-selected', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, 'role="option"')).toBe(2)
    expect(count(src, 'aria-selected={active}')).toBe(2)
  })

  it('触发件有可读名字（读屏念得出「一级分类：家具」）', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, 'aria-label={`一级分类：${l1Display}`}')).toBe(1)
    expect(count(src, 'aria-label={`二级分类：${l2Display}`}')).toBe(1)
  })
})

describe('分类浮层：定位（fixed + 右对齐夹取，不用 absolute）', () => {
  it('打开时取触发按钮的 getBoundingClientRect 算固定坐标', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('anchor.getBoundingClientRect()')
    expect(src).toContain('Math.max(CATEGORY_PANEL_MARGIN, Math.round(rect.right - CATEGORY_PANEL_WIDTH))')
    expect(src).toContain('Math.round(rect.bottom + CATEGORY_PANEL_GAP)')
    // 与排序浮层同值：宽 176 / 间距 6 / 距窗口边缘 8
    expect(src).toContain('const CATEGORY_PANEL_WIDTH = 176')
    expect(src).toContain('const CATEGORY_PANEL_GAP = 6')
    expect(src).toContain('const CATEGORY_PANEL_MARGIN = 8')
    // 分类选择器挂在可滚动弹窗里：absolute 会被祖先 overflow 裁掉
    expect(src).not.toContain('top-full')
    expect(src).toContain('style={{ left: panelPos.left, top: panelPos.top }}')
  })
})

describe('分类浮层：三条关闭路径', () => {
  it('点外部关闭（mousedown + 容器 contains 判定）', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain("window.addEventListener('mousedown', onPointerDown)")
    expect(src).toContain('root.contains(e.target)')
    expect(src).toContain("window.removeEventListener('mousedown', onPointerDown)")
  })

  it('Esc 交给 useEscLayer：只收起浮层（不关弹窗、不让按键落到全局快捷键）', () => {
    const src = codeOf(read(PICKER))
    // 0.7.6 T-ESC：浮层是弹窗里的第二层，压栈后栈顶优先 —— 先收浮层，再按才关弹窗
    expect(src).toContain("import { useEscLayer } from '../logic/escLayer'")
    expect(src).toContain('useEscLayer(() => setOpenField(null), openField !== null)')
    // 不再自己手写 keydown（那四份重复实现已收敛进 Modal / escLayer）
    expect(src).not.toContain("'Escape'")
    expect(src).not.toContain("addEventListener('keydown'")
  })

  it('窗口 resize 关闭（fixed 坐标在打开时写死，尺寸一变必错位）', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain("window.addEventListener('resize', onResize)")
    expect(src).toContain("window.removeEventListener('resize', onResize)")
    expect(src).toContain('const onResize = (): void => setOpenField(null)')
  })

  it('收起前先判断「是否展开」，未展开时不挂监听', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('if (!openField) return')
    expect(src).toContain('}, [openField])')
    // 两处互斥：任何时刻只有一个面板挂着
    expect(src).toContain("if (openField === 'level1') {")
    expect(src).toContain("if (openField === 'level2') {")
  })
})

describe('二级联动：换 UI 承载，规则一行未改', () => {
  it('一级选项来源与二级级联来源仍是原来那两个纯函数', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('const l1Options = level1OptionsFor(kind)')
    // 二级必须把 kind 一起传下去：CAD 的二级住独立表 `CAD_LEVEL2_MAP`，
    // 不传 kind 会去查 `LEVEL2_MAP` → CAD 一级查不到 → null → 受控枚举被错渲染成自由输入。
    // 断言钉住「参数传了」而不只是「函数被调用」，否则这条守卫等于白写。
    expect(src).toContain('const l2Options = level2OptionsFor(level1, kind)')
  })

  it('改一级 → 二级重置为「未分类」（原 <select> onChange 的语义）', () => {
    const src = codeOf(read(PICKER))
    const start = src.indexOf('const applyLevel1')
    const end = src.indexOf('const openLevel2Panel', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('setLevel1(value)')
    expect(block).toContain('setLevel2(UNCLASSIFIED)')
    expect(block).toContain('setOpenField(null)')
  })

  it('改二级不动一级（不会误触发级联重置）', () => {
    const src = codeOf(read(PICKER))
    const start = src.indexOf('const applyLevel2')
    const end = src.indexOf('const onLevel1KeyDown', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('setLevel2(value)')
    expect(block).not.toContain('setLevel1')
  })

  it('二级仍在「一级/二级」成对显示（重名二级不会选错）', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('label: `${level1}/${it.value}`')
  })

  it('一级=未分类 时二级锁定、无词表时自由输入 —— 两条老分支都还在', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('{level1 === UNCLASSIFIED ? (')
    expect(src).toContain('className="input opacity-50" value="未分类" disabled')
    // 自定义词表（2026-10）：预设与自定义都没有词条时才走自由输入（l2HasPanel 收口）
    expect(src).toContain(') : !l2HasPanel ? (')
    expect(src).toContain('placeholder="该一级分类无级联词表，可自由输入，留空则归入「未分类」"')
    expect(src).toContain('placeholder="可自由输入，留空则归入「未分类」"')
  })

  it('词表外的既有值只标注不改写（原 __custom__ 语义：绝不静默丢值）', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, '（词表外）')).toBe(2)
    // 2026-10 自定义词表：判定域从"预设"扩成"预设 + 自定义"（自定义词条不得标成词表外）
    expect(src).toContain(
      'l1HasPanel && level1 !== UNCLASSIFIED && !l1Items.some((it) => it.value === level1)'
    )
    expect(src).toContain(
      'l2HasPanel && level2 !== UNCLASSIFIED && !l2Merged.some((it) => it.value === level2)'
    )
  })

  it('「未分类」哨兵仍是首行（一级 / 二级各一次）', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, '{ value: UNCLASSIFIED, label: UNCLASSIFIED, custom: false }')).toBe(2)
  })

  it('提交逻辑（清空兜底 / 跨大类禁用 / assignCategory）原样保留', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('const c1 = level1.trim() || UNCLASSIFIED')
    expect(src).toContain('const c2 = c1 === UNCLASSIFIED ? UNCLASSIFIED : level2.trim() || UNCLASSIFIED')
    expect(src).toContain('await assignCategory(targets.map((t) => t.id), c1, c2)')
    expect(src).toContain('disabled={busy || crossKind}')
  })
})

describe('同一控件家族：与排序浮层 class 逐字一致', () => {
  it('排序浮层里的三段 class 就是本文件用的三段（不是「差不多」）', () => {
    const app = read(APP)
    expect(app).toContain(PANEL_CONTAINER)
    expect(app).toContain(PANEL_HEADING)
    expect(app).toContain(PANEL_ROW)
    expect(app).toContain(PANEL_ROW_ACTIVE)
    expect(app).toContain('const SORT_PANEL_WIDTH = 176')
  })

  it('分类这边三段 class 与排序逐字相同，且一级 / 二级各一份', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, PANEL_CONTAINER)).toBe(2)
    expect(count(src, PANEL_HEADING)).toBe(2)
    expect(count(src, PANEL_ROW)).toBe(2)
    expect(count(src, PANEL_ROW_ACTIVE)).toBe(2)
    expect(count(src, 'hover:bg-elevated/60')).toBe(2)
  })

  it('选中态只用一个指示（accent-tint，不叠勾号）', () => {
    const src = codeOf(read(PICKER))
    expect(src).not.toContain('✓')
    expect(src).not.toContain('aria-checked')
  })

  it('小标题行文案与可见标签同名（一级分类 / 二级分类）', () => {
    const src = codeOf(read(PICKER))
    expect(src).toContain('text-[10px] text-tertiary">一级分类</div>')
    expect(src).toContain('text-[10px] text-tertiary">二级分类</div>')
  })

  it('长选项不撑破 176px：标签走 truncate，完整文本进 title', () => {
    const src = codeOf(read(PICKER))
    expect(count(src, '<span className="min-w-0 truncate">{opt.label}</span>')).toBe(2)
    expect(count(src, 'title={opt.label}')).toBe(2)
  })
})
