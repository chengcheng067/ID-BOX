/// <reference lib="dom" />
/**
 * 导入进度弹窗从右下角移到屏幕中间（用户 2026-10-26 原话：
 * 「如果有素材的拖入，那么这一个小的右侧的弹窗把它移到中间来」，截图指向的是导入完成的小卡，
 * 不是底部通栏 NoticeToast，也不是右侧详情面板）。
 *
 * 渲染层跑在 vitest `environment: 'node'`（无 jsdom），组件渲染不了 → 只能扫源码钉住结构。
 * 守卫四层，都是**已经踩过的坑**：
 * ① 水平居中：`left-1/2` + `-translate-x-1/2` 必须成对出现（只写 left-1/2 = 右边溢出半屏）；
 *    同时 `right-4` 必须彻底消失（留着会与 left 一起把宽度算错）。`w-72` 也要换掉，
 *    288px 居中后既窄又悬空 → 用 `min(420px, calc(100vw - 48px))`。
 * ② 堆叠方向：`flex-col-reverse`。容器底边锚定在 `bottom-14`，反向列让第 0 条钉在底部、
 *    新条目向上长，已在场的卡片 y 不变。**内外两层都要**：外层只有一个子节点，
 *    只改外层等于没改（真正的卡片栈在内层 wrapper 上）。
 * ③ 必须原样保留：`pointer-events-none`（外层，不挡网格点击）+ `pointer-events-auto`（内层）
 *    的两层结构、`bottom-14`（避让 44px 底栏 + 12px 间隙）、`slice(-6).reverse()`
 *    （最新 6 条、最新在底部）、`onMouseEnter/onMouseLeave` 悬停暂停、无条目 `return null`。
 * ④ 位置不许用行内 style 动态算：底栏出现/消失时改 bottom 会让整摞上下抖。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const QUEUE = '../src/renderer/components/ImportQueue.tsx'

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

/** 去掉块注释与行注释：守卫只针对真实代码（本文件的文档注释里就写了 right-4 / w-72） */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const queueCode = (): string => codeOnly(read(QUEUE))

/** 取出定位那一层的 class 串（`fixed ...` 那个 div），断言限定在它上面，避免全文件误判 */
function anchorClassName(): string {
  const code = queueCode()
  const at = code.indexOf('fixed ')
  if (at < 0) return ''
  const start = code.lastIndexOf('className="', at)
  const end = code.indexOf('"', at)
  if (start < 0 || end < 0) return ''
  return code.slice(start + 'className="'.length, end)
}

describe('导入队列居中：left-1/2 + -translate-x-1/2 成对出现', () => {
  it('定位层同时有 left-1/2 与 -translate-x-1/2（只写 left-1/2 会右边溢出半屏）', () => {
    const cls = anchorClassName()
    expect(cls).not.toBe('')
    expect(cls).toContain('left-1/2')
    expect(cls).toContain('-translate-x-1/2')
    expect(cls).toContain('fixed')
  })

  it('right-4 已彻底移除（与 left 并存会让宽度被两边夹住）', () => {
    expect(queueCode()).not.toMatch(/\bright-4\b/)
  })

  it('不再用 w-72（288px 居中后又窄又悬空）', () => {
    expect(queueCode()).not.toMatch(/\bw-72\b/)
  })

  it('宽度用 min(420px, 100vw-48px)：任意值里的空格写成下划线（Tailwind 3 语法）', () => {
    // 含空格的 `calc(100vw - 48px)` 直接写进 class 会被 Tailwind 截断成非法声明；
    // `_-_` 是官方写法，编译后还原成空格。
    const cls = anchorClassName()
    expect(cls).toContain('w-[min(420px,calc(100vw_-_48px))]')
    // 任意值里不许出现裸空格（`w-[min(420px, calc(...))]` 这种写法编译不出规则）
    const arbitrary = [...cls.matchAll(/\[[^\]]*\]/g)].map((m) => m[0])
    for (const token of arbitrary) expect(token).not.toContain(' ')
  })

  it('位置不靠行内 style 动态算（底栏出现/消失时改 bottom 会抖）', () => {
    const code = queueCode()
    expect(code).not.toMatch(/style=\{\{[^}]*bottom/)
    expect(code).not.toMatch(/style=\{\{[^}]*left/)
    // 定位一律走 class
    expect(anchorClassName()).toContain('left-1/2')
  })
})

describe('堆叠方向：flex-col-reverse（新条目从下往上长）', () => {
  it('出现 flex-col-reverse，且没有残留的正序 flex-col', () => {
    const code = queueCode()
    expect(code).toContain('flex-col-reverse')
    // `/flex-col(?!-reverse)/` 是唯一能区分 `flex-col` 与 `flex-col-reverse` 的写法
    expect(code.match(/flex-col(?!-reverse)/g) ?? []).toEqual([])
  })

  it('内外两层都是 reverse（外层只有一个子节点，只改外层等于没改）', () => {
    const code = queueCode()
    expect(code.match(/flex-col-reverse/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // 真正的卡片栈（内层 wrapper）必须带 pointer-events-auto + reverse + gap-2
    expect(code).toContain('pointer-events-auto flex flex-col-reverse gap-2')
  })

  it('间距仍是 gap-2（反向列不改变 gap 语义）', () => {
    expect(anchorClassName()).toContain('gap-2')
    expect(queueCode()).toContain('pointer-events-auto flex flex-col-reverse gap-2')
  })
})

describe('刻意保留的两层指针结构（外层不挡网格点击）', () => {
  it('外层 pointer-events-none、内层 pointer-events-auto 各至少一次', () => {
    const code = queueCode()
    expect(code).toContain('pointer-events-none')
    expect(code).toContain('pointer-events-auto')
    expect(code.match(/pointer-events-none/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(code.match(/pointer-events-auto/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('pointer-events-none 在定位层上，pointer-events-auto 只在内层/卡片上', () => {
    const code = queueCode()
    const outer = code.indexOf('pointer-events-none')
    const inner = code.indexOf('pointer-events-auto')
    expect(outer).toBeGreaterThanOrEqual(0)
    expect(inner).toBeGreaterThan(outer)
    // 定位层自己不许带 pointer-events-auto（会挡住它整块矩形下的网格点击；卡片是居中浮层，
    // 但两层结构是既定设计，不因位置变化而放弃）
    expect(anchorClassName()).not.toContain('pointer-events-auto')
  })
})

describe('避让底部提示条：bottom-14 原样保留', () => {
  it('仍是 bottom-14（44px 底栏 + 12px 间隙）', () => {
    expect(anchorClassName()).toContain('bottom-14')
  })

  it('没有改成动态 bottom / 计算值（会在底栏出现消失时抖动）', () => {
    const code = queueCode()
    expect(code).not.toMatch(/bottom-\[/)
    expect(code).not.toMatch(/bottom-\$\{/)
    expect(code).not.toContain('bottom:')
  })

  it('z-30 层级不变（不被网格/浮条盖住）', () => {
    expect(anchorClassName()).toContain('z-30')
  })
})

describe('行为语义一字未改（居中不许顺手改业务）', () => {
  it('最多 6 条，且取**最新** 6 条 + 翻转成"最新在底部"（slice(-6).reverse()）', () => {
    const code = queueCode()
    // 为什么不是 slice(0, 6)：那是**最老**的 6 条 —— 一次拖 10 个包时最后 4 个的进度看不见
    // （既有可见性 bug）。为什么必须再 reverse()：内层是 flex-col-reverse，DOM[0] 落在底部，
    // 不翻转就变成"最新在顶部"，方向反了、与改动前右下角那版的观感不一致。
    expect(code).toContain('imports.slice(-6).reverse().map(')
    expect(code).toMatch(/slice\(-6\)/)
    expect(code).toMatch(/\.reverse\(\)/)
    // 老口径不许回来（回归守卫）
    expect(code).not.toMatch(/slice\(\s*0\s*,\s*6\s*\)/)
  })

  it('不就地翻转 store 里的数组（slice 已返回副本，reverse 只作用于副本）', () => {
    const code = queueCode()
    // 禁止先拿引用再原地 reverse：`imports.reverse()` 会原地改 store 状态
    expect(code).not.toMatch(/\bimports\.reverse\(\)/)
    expect(code).not.toMatch(/\bimports\.sort\(/)
  })

  it('悬停暂停仍在：onMouseEnter / onMouseLeave', () => {
    const code = queueCode()
    expect(code).toContain('onMouseEnter')
    expect(code).toContain('onMouseLeave')
    expect(code).toContain('setHovered(true)')
    expect(code).toContain('setHovered(false)')
    // 倒计时依赖 hovered：悬停时提前返回 = 暂停
    expect(code).toContain('if (hovered || imports.length === 0) return')
  })

  it('无条目时整块不渲染（return null），不占一个空浮层', () => {
    expect(queueCode()).toContain('if (imports.length === 0) return null')
  })

  it('终态才自动消失 + 手动 ✕ 仍在 + tooltip / 明细文案仍是 logic 层唯一来源', () => {
    const code = queueCode()
    expect(code).toContain('dismissRemainingMs')
    expect(code).toContain('isTerminalStatus')
    expect(code).toContain('dismiss(it.item)')
    expect(code).toContain('importItemDetail(it)')
    expect(code).toContain('clearTimeout')
  })
})
