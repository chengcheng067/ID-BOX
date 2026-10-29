/**
 * 整理浮层的**承载面**守卫（2026-10-30 用户反馈）。
 *
 * 用户原话：
 * 「这几个区域实际上是接不住整个面板的，因为首先透明度等方面导致阅读性不高。
 *   这个部分的 UI 应该做以下调整：页面承载：应该跟渲染材质球部分的 UI 差不多，
 *   所有的分类和按钮都应该由同一个页面去承载，而不是现在这种半透明的设计。」
 *
 * ## 改前的实际形态（像素裁剪确认过，不是推测）
 *
 * `TriageOverlay` 打开后是「左图右栏」，但**只有左侧封面有 `bg-panel` 画框**；
 * 右栏（标题 / 分页 / 两个下拉 / 确认 / 跳过 / 快捷键）整列**没有任何容器底色**，
 * 全靠 `.quicklook-scrim` 的 `rgba(0,0,0,.6)` 压暗。后果是背后网格的材质球直接
 * 透过右栏 —— `跳过` 按钮上能看到一颗球的完整圆弧，下拉框（`input` 类是半透明的）
 * 叠在球体上，文字与背景糊成一片。整块面板没有边界，视觉上"接不住"。
 *
 * ## 所以这里守什么
 *
 * ① **实底外卡**：整块浮层必须由一张不透明卡片承载（`bg-card` / `bg-panel` 二选一），
 *    且这串类名必须出现在**外层容器那一行**上 —— 只断言 `toContain('bg-card')`
 *    会让「把 bg-card 加到某个内层按钮上」也算通过（假绿）；
 * ② **禁止半透明容器**：`bg-card/95`、`backdrop-blur`、`bg-transparent` 一律不许
 *    （规范 §1 全局禁玻璃拟态，styles.css 顶部注释写明）；
 * ③ **遮罩保留**：`.quicklook-scrim` + `.dialog-scrim` 仍在（压暗底层网格，
 *    与不透明卡片构成两层隔离）；
 * ④ **右栏有分区容器**：`bg-elevated/40` 分区底 —— 它 40% 只有在**父级不透明**时才安全，
 *    所以 ① 是 ④ 的前提，两条必须同时成立；
 * ⑤ 圆角与描边来自 token（`rounded-card` / 圆角 token、`border-line`）；
 * ⑥ **无新造色值**：文件里不许出现 `#rrggbb` 或 `rgba(...)`，颜色只能来自 token。
 *
 * 环境约束：vitest 是 `environment: 'node'`（无 jsdom），渲不出组件，
 * 所以是**源码守卫**（与 `tests/triageWiring.test.ts` / `tests/aliasWiring.test.ts` 同范式）
 * + 一组纯函数判据，证明守卫本身不会误判。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const RAW = fs.readFileSync(
  new URL('../src/renderer/components/TriageOverlay.tsx', import.meta.url),
  'utf-8'
)

/**
 * 剥掉注释后的源码。所有「不许出现」的判据都跑在这一份上：
 * 文件头与本文件的注释里**本来就会提到** `bg-card/95`、`backdrop-blur` 这些反例
 * （解释为什么禁），不去注释就会先命中说明文字 → 守卫看着红、其实没收码。
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

/** 取包含某段锚点的**那一整行** className 字符串（按源码行切，不跨行） */
function lineWith(text: string, anchor: string): string {
  const line = text.split('\n').find((l) => l.includes(anchor))
  if (line === undefined) throw new Error(`anchor not found: ${anchor}`)
  return line
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯判据：把「实底 / 半透明」的判定抽成函数，先证明判据本身不误判，
// 再用它守源码。这样 `bg-card/95` 这类半透明写法不会因为"包含 bg-card 子串"而蒙混过关。
// ─────────────────────────────────────────────────────────────────────────────

/** 该 className 串里的底色类是否**实底不透明**（`bg-card` 命中、`bg-card/95` 不命中） */
function isOpaqueSurface(cls: string): boolean {
  // 逐个 token 看，避免 `bg-card` 命中 `bg-card/95`（子串匹配的经典假绿）
  const tokens = cls.split(/\s+/).filter(Boolean)
  return tokens.some((t) => t === 'bg-card' || t === 'bg-panel')
}

/** 该 className 串里是否有**半透明**底色（`bg-x/40` 这类带斜杠的不算实底） */
function hasTranslucentSurface(cls: string): boolean {
  return cls.split(/\s+/).some((t) => /^bg-\S+\/\d+$/.test(t))
}

describe('判据自检（守卫本身不能误判）', () => {
  it('bg-card / bg-panel 判为实底', () => {
    expect(isOpaqueSurface('flex rounded-card border border-line bg-card p-5')).toBe(true)
    expect(isOpaqueSurface('bg-panel')).toBe(true)
  })

  it('bg-card/95 · bg-card/80 判为**非**实底（子串不能蒙混）', () => {
    expect(isOpaqueSurface('bg-card/95')).toBe(false)
    expect(isOpaqueSurface('bg-card/80')).toBe(false)
    expect(isOpaqueSurface('bg-panel/90')).toBe(false)
  })

  it('无底色 / 只有其它类 → 非实底', () => {
    expect(isOpaqueSurface('flex max-h-[86vh] gap-5')).toBe(false)
    expect(isOpaqueSurface('')).toBe(false)
  })

  it('半透明底色的识别：bg-x/N 命中，bg-x 与 bg-x/40 的区别守住', () => {
    expect(hasTranslucentSurface('bg-elevated/40')).toBe(true)
    expect(hasTranslucentSurface('bg-card')).toBe(false)
    expect(hasTranslucentSurface('bg-card/95')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ① 实底外卡
// ─────────────────────────────────────────────────────────────────────────────

describe('① 整块浮层由一张**实底**卡片承载', () => {
  it('外层容器那一行带 bg-card（或 bg-panel），且是**不透明**写法', () => {
    // 锚点用尺寸类定位外卡那一行：这是整块面板唯一同时带 max-w 与 max-h 的容器，
    // 比 `toContain('bg-card')` 精确 —— 后者在内层任意元素上写一次就能骗过。
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(isOpaqueSurface(outer)).toBe(true)
    // 该行必须真的含 token 字面量（isOpaqueSurface 已经把 /opacity 版本排除了）
    expect(outer).toMatch(/\bbg-(card|panel)\b/)
  })

  it('外卡带实底需要的三件套：圆角 + 描边 + 投影', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(outer).toContain('rounded-modal-render')
    expect(outer).toContain('border-line')
    expect(outer).toContain('shadow-modal')
  })

  it('内边距与 CustomRenderDialog 同源（p-5 / gap-5 两栏间距）', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(outer).toContain('p-5')
    expect(outer).toContain('gap-5')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 禁止半透明容器
// ─────────────────────────────────────────────────────────────────────────────

describe('② 不许半透明容器（透明度过高正是用户抱怨的根因）', () => {
  it('没有 bg-card/N · bg-panel/N 这类带透明度的卡片底', () => {
    expect(SRC).not.toMatch(/bg-card\/\d/)
    expect(SRC).not.toMatch(/bg-panel\/\d/)
  })

  it('没有 backdrop-blur（规范 §1 全局禁玻璃拟态）', () => {
    expect(SRC).not.toContain('backdrop-blur')
  })

  it('没有 bg-transparent', () => {
    expect(SRC).not.toContain('bg-transparent')
  })

  it('外卡那一行本身不含任何 bg-x/N（分区底只许出现在内层）', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(hasTranslucentSurface(outer)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 遮罩保留（两层隔离：不透明卡片 + 压暗遮罩）
// ─────────────────────────────────────────────────────────────────────────────

describe('③ 遮罩继续保留', () => {
  it('quicklook-scrim 与 dialog-scrim 都还在', () => {
    expect(SRC).toContain('quicklook-scrim')
    expect(SRC).toContain('dialog-scrim')
  })

  it('遮罩仍然占一层 Esc（useEscLayer + zClassForDepth，未被承载面改动带跑）', () => {
    expect(SRC).toContain('useEscLayer(requestClose, true)')
    expect(SRC).toContain('zClassForDepth(escDepth)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 右栏有分区容器
// ─────────────────────────────────────────────────────────────────────────────

describe('④ 右栏不再是裸元素，分类区与操作区都有分区承托', () => {
  it('分类选择区包在 bg-elevated/40 分区里', () => {
    // 这一条只有在 ① 成立时才安全（40% 叠在不透明父级上）；两条同文件一起守。
    // 锚点必须带 `p-2.5`：`ConflictSources` 里另有两处 `bg-elevated/40`（事件来源块），
    // 只认裸串会先命中那两处，守的就不是右栏分类区了。
    expect(SRC).toContain('bg-elevated/40 p-2.5')
  })

  it('分区是「圆角 + 描边 + 内边距」的完整卡形（不是只加个底色）', () => {
    const section = lineWith(SRC, 'bg-elevated/40 p-2.5')
    expect(section).toContain('rounded-btn')
    expect(section).toContain('border-line')
    expect(section).toContain('p-2.5')
  })

  it('底部操作区与上方用 border-t 分隔', () => {
    expect(SRC).toMatch(/border-t border-line/)
  })

  it('CategoryCascade 落在分区里面（没被挪到分区外）', () => {
    const sectionAt = SRC.indexOf('bg-elevated/40 p-2.5')
    const cascadeAt = SRC.indexOf('<CategoryCascade')
    expect(sectionAt).toBeGreaterThan(-1)
    // 分区 div 的**第一个** `</div>` 就是它自己的闭合标签（分区内只有一个子组件，
    // 组件本体不展开）。所以：分区开启 < CategoryCascade 开启 < 它自闭合 < 分区闭合。
    const sectionEnd = SRC.indexOf('</div>', sectionAt)
    const cascadeEnd = SRC.indexOf('/>', cascadeAt)
    expect(cascadeAt).toBeGreaterThan(sectionAt)
    expect(cascadeEnd).toBeGreaterThan(cascadeAt)
    expect(sectionEnd).toBeGreaterThan(cascadeEnd)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 圆角与描边来自 token
// ─────────────────────────────────────────────────────────────────────────────

describe('⑤ 圆角 / 描边 / 底色全部走 token', () => {
  it('有 rounded-card（封面画框）与 border-line', () => {
    expect(SRC).toContain('rounded-card')
    expect(SRC).toContain('border-line')
  })

  it('封面画框用 bg-canvas 承托（bg-panel 浅色档与 bg-card 同为纯白，边界会消失）', () => {
    // 浅色 `--panel-bg` = `--surface-card` = #ffffff；叠进实底卡片后画框读不出来，
    // 所以画框底改取更深的 `--bg-canvas`（浅 #f8fafc / 深 #111113，两主题都比卡片深）。
    const frame = lineWith(SRC, 'h-[min(62vh,560px)]')
    expect(frame).toContain('rounded-card')
    expect(frame).toContain('border-line')
    expect(frame).toContain('bg-canvas')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 无新造色值
// ─────────────────────────────────────────────────────────────────────────────

describe('⑥ 没有新造色值（颜色必须来自 styles.css 的 token）', () => {
  it('无 #rgb / #rrggbb / #rrggbbaa 字面量', () => {
    expect(SRC).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('无 rgba() / rgb() 字面量', () => {
    expect(SRC).not.toMatch(/rgba?\(/)
  })

  it('无 Tailwind 调色板色（slate-500 / white / black 这类绕过 token 的写法）', () => {
    expect(SRC).not.toMatch(/\b(?:bg|text|border)-(?:white|black)\b/)
    expect(SRC).not.toMatch(/\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone)-\d{2,3}\b/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 与 CustomRenderDialog 同源（用户点名「跟渲染材质球部分的 UI 差不多」）
// ─────────────────────────────────────────────────────────────────────────────

describe('⑦ 与 CustomRenderDialog 的承载面同源（两处观感必须一致）', () => {
  const RENDER = fs.readFileSync(
    new URL('../src/renderer/components/CustomRenderDialog.tsx', import.meta.url),
    'utf-8'
  )

  it('参照组（CustomRenderDialog）确实用 bg-card + rounded-modal-render 打底', () => {
    // 这条守的是「我们照抄的那个模板本身没被改掉」——模板变了，本守卫的期望值要重估。
    expect(RENDER).toContain('rounded-modal-render border border-line bg-card shadow-modal')
  })

  it('整理浮层的外卡与参照组用同一组类（顺序无关，逐类比对）', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    for (const cls of ['rounded-modal-render', 'border-line', 'bg-card', 'shadow-modal']) {
      expect(outer).toContain(cls)
    }
  })

  it('分类区 / 操作区的按钮高度对齐参照组（!h-10 !text-[13px]，不再 36px）', () => {
    expect(RENDER).toContain('!h-10')
    // 两个出口按钮都升到 h-10
    expect(SRC.split('!h-10 !text-[13px]').length - 1).toBe(2)
  })
})
