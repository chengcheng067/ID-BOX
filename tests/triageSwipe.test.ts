/**
 * 整理浮层的**探探式左右飞出**（2026-10-30 用户需求）。
 *
 * 用户原话：
 * 「关于"确认"或者"跳过"的操作，可以参考探探的动画效果，即"跳过"就向左滑，
 *   卡片往左边飞出去；"确认"就向右滑，卡片往右边飞出去。」
 *
 * ## 环境约束：vitest 是 `environment: 'node'`（无 jsdom）
 *
 * 渲不出组件、也没有 `AnimationEvent`，所以分三层证明：
 * ① **纯逻辑**（`logic/triageSwipe.ts`）：方向映射与三档时长 —— 这是可执行的真判据；
 * ② **源码守卫**（`TriageOverlay.tsx`）：证明纯逻辑真的接到了 DOM 上
 *    （`out-confirm` / `out-skip` 两个 phase 真的存在、`onAnimationEnd` 真的推进、
 *    外卡的 `overflow-hidden` 真的摘掉了）；
 * ③ **样式守卫**（`styles.css`）：证明 `@keyframes` 存在，且**时长与 ① 一致**
 *    —— 两边各写一份时长是最容易漂移的地方，让测试替我们盯住。
 *
 * ④ 端到端纯逻辑：拿真实的 `triageFlow` 游标跑一遍"跳过 / 确认"两条腾挪路径，
 *    证明"推进一次"这件事在纯逻辑层面是对的（DOM 那层由 `onAnimationEnd` 幂等保证）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  swipeClassOf,
  swipeDirClass,
  swipeDirOf,
  swipeTimingOf,
  type SwipeTiming
} from '../src/renderer/logic/triageSwipe'
import {
  advanceAfterAssign,
  skipCurrent,
  startTriage,
  triageIndex,
  type TriageCursor
} from '../src/renderer/logic/triageFlow'

const RAW = fs.readFileSync(
  new URL('../src/renderer/components/TriageOverlay.tsx', import.meta.url),
  'utf-8'
)

/** 剥掉注释后的源码：注释里本来就会提到 `setTimeout`、`overflow-hidden` 这些反例（解释为什么禁） */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const CSS = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf-8')

/**
 * 剥掉注释的 CSS。取规则块时按字符窗口切片，注释会顶掉窗口里的正文
 * （`ultra` 那块前面正好有一段说明，窗口 200 字符只剩注释）。
 */
const CSS_BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 取某个选择器出现过的**所有**规则块（拼成一份正文）。
 *
 * ⚠️ 为什么不是"找到第一个就返回"：
 * ① 三档共享一条组合规则
 *    `.triage-swipe-out-smooth,\n.triage-swipe-out-balanced,\n.triage-swipe-out-ultra {`
 *    —— 它最后一行**恰好**以 `.triage-swipe-out-ultra {` 开头，看着像该档自己的规则，
 *    但里面只有公共声明（没有 `animation-duration`）；
 * ② 文件末尾的 reduced 兜底块里又写了一次 `.triage-swipe-in {`。
 *
 * 所以把所有命中的块拼起来，断言"其中某处写对了时长" —— 不依赖出现顺序。
 */
function ruleBlocksOf(selector: string): string {
  const needle = `${selector} {`
  const parts: string[] = []
  let from = 0
  for (;;) {
    const at = CSS_BARE.indexOf(needle, from)
    if (at < 0) break
    const end = CSS_BARE.indexOf('}', at)
    parts.push(CSS_BARE.slice(at, end + 1))
    from = at + needle.length
  }
  if (parts.length === 0) throw new Error(`selector not found: ${selector}`)
  return parts.join('\n')
}

/** 取包含某段锚点的**那一整行**（按源码行切，不跨行） */
function lineWith(text: string, anchor: string): string {
  const line = text.split('\n').find((l) => l.includes(anchor))
  if (line === undefined) throw new Error(`anchor not found: ${anchor}`)
  return line
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 方向映射（交互契约）
// ─────────────────────────────────────────────────────────────────────────────

describe('A. 动作 → 飞出方向（确认右 / 跳过左，探探式）', () => {
  it('confirm → right', () => {
    expect(swipeDirOf('confirm')).toBe('right')
  })

  it('skip → left', () => {
    expect(swipeDirOf('skip')).toBe('left')
  })

  it('两个动作的方向**不同**（否则两条路径会飞同一侧，用户分不清确认还是跳过）', () => {
    expect(swipeDirOf('confirm')).not.toBe(swipeDirOf('skip'))
  })

  it('方向 class 与方向一一对应，且互不相同', () => {
    expect(swipeDirClass('right')).toBe('triage-swipe-right')
    expect(swipeDirClass('left')).toBe('triage-swipe-left')
    expect(swipeDirClass('right')).not.toBe(swipeDirClass('left'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 三档时长 × reduced
// ─────────────────────────────────────────────────────────────────────────────

describe('B. 三档时长（smooth / balanced / ultra）', () => {
  const tiers = ['smooth', 'balanced', 'ultra'] as const

  it('三档 outMs 递增，且都落在 200–400ms 区间', () => {
    const [smooth, balanced, ultra] = tiers.map((t) => swipeTimingOf(t, false).outMs)
    expect(smooth).toBeGreaterThanOrEqual(200)
    expect(ultra).toBeLessThanOrEqual(400)
    expect(smooth).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(ultra)
  })

  it('三档的具体时长（与 styles.css 的 animation-duration 逐字一致）', () => {
    expect(swipeTimingOf('smooth', false).outMs).toBe(250)
    expect(swipeTimingOf('balanced', false).outMs).toBe(320)
    expect(swipeTimingOf('ultra', false).outMs).toBe(340)
  })

  it('三档入场时长都是 200ms（入场合流，不随档位分叉）', () => {
    for (const t of tiers) expect(swipeTimingOf(t, false).inMs).toBe(200)
  })

  it('三档的 className 互不相同（否则挂上去的是同一个动画，档位形同虚设）', () => {
    const names = tiers.map((t) => swipeTimingOf(t, false).className)
    expect(new Set(names).size).toBe(3)
  })

  it('className 非空且不含非法字符（只允许字母 / 数字 / 连字符）', () => {
    for (const t of tiers) {
      const { className, inClassName } = swipeTimingOf(t, false)
      expect(className.length).toBeGreaterThan(0)
      expect(inClassName.length).toBeGreaterThan(0)
      expect(className).toMatch(/^[a-z0-9-]+$/)
      expect(inClassName).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

describe('B2. reduced-motion：三档塌成同一组纯淡出', () => {
  const tiers = ['smooth', 'balanced', 'ultra'] as const
  const reducedOf = (t: (typeof tiers)[number]): SwipeTiming => swipeTimingOf(t, true)

  it('三档返回**完全相同**的一组（系统偏好压过用户选的性能档）', () => {
    const [a, b, c] = tiers.map(reducedOf)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('时长约 160ms（出场与入场同）', () => {
    const r = reducedOf('ultra')
    expect(r.outMs).toBe(160)
    expect(r.inMs).toBe(160)
  })

  it('className 是**纯淡出**：不含 translate / rotate / scale 字样', () => {
    for (const t of tiers) {
      const r = reducedOf(t)
      expect(r.className).not.toMatch(/translate|rotate|scale|slide|swipe-out/i)
      expect(r.inClassName).not.toMatch(/translate|rotate|scale|slide|swipe-in/i)
      // 必须是 fade 语义
      expect(r.className).toMatch(/fade/i)
      expect(r.inClassName).toMatch(/fade/i)
    }
  })

  it('reduced 的时长**短于**任一档正常时长（退化的确是"更少"，不是"更花哨"）', () => {
    const r = reducedOf('smooth').outMs
    for (const t of tiers) expect(r).toBeLessThan(swipeTimingOf(t, false).outMs)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B3. 类名合成
// ─────────────────────────────────────────────────────────────────────────────

describe('B3. swipeClassOf 合成档位 class + 方向 class', () => {
  it('确认（out）拿到 right 方向与对应档位 class', () => {
    const cls = swipeClassOf(swipeTimingOf('balanced', false), 'right', true)
    expect(cls).toContain('triage-swipe-out-balanced')
    expect(cls).toContain('triage-swipe-right')
  })

  it('跳过（out）拿到 left 方向', () => {
    const cls = swipeClassOf(swipeTimingOf('balanced', false), 'left', true)
    expect(cls).toContain('triage-swipe-left')
  })

  it('入场（out=false）用 inClassName', () => {
    const cls = swipeClassOf(swipeTimingOf('ultra', false), 'right', false)
    expect(cls).toContain('triage-swipe-in')
    expect(cls).not.toContain('triage-swipe-out')
  })

  it('reduced 命中时合成出来的是 fade class（不含 out/in 位移类）', () => {
    const cls = swipeClassOf(swipeTimingOf('balanced', true), 'left', true)
    expect(cls).toContain('triage-swipe-fade-out')
    expect(cls).not.toContain('triage-swipe-out-balanced')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 源码守卫：纯逻辑真的接到了 DOM 上
// ─────────────────────────────────────────────────────────────────────────────

describe('C1. 两个 phase 真的存在，且方向映射接对了', () => {
  it("含 'out-confirm' 与 'out-skip'（两个 phase 都在用，不是只写了一个）", () => {
    expect(SRC).toContain("'out-confirm'")
    expect(SRC).toContain("'out-skip'")
  })

  it('confirm 路径用的是**右**方向常量（CONFIRM_DIR = swipeDirOf(\'confirm\')）', () => {
    // 锚点必须带 `beginSwipe({`：裸 `phase: 'out-confirm'` 会先命中 `swipeState` 的类型声明行
    const confirmCall = lineWith(SRC, "beginSwipe({ phase: 'out-confirm'")
    expect(confirmCall).toContain('CONFIRM_DIR')
  })

  it('skip 路径用的是**左**方向常量（SKIP_DIR = swipeDirOf(\'skip\')）', () => {
    const skipCall = lineWith(SRC, "beginSwipe({ phase: 'out-skip'")
    expect(skipCall).toContain('SKIP_DIR')
  })

  it('方向常量由 swipeDirOf 推导，不是手写的字符串（改方向只改 triageSwipe.ts）', () => {
    expect(SRC).toContain("swipeDirOf('confirm')")
    expect(SRC).toContain("swipeDirOf('skip')")
  })

  it('跳过按钮与键盘 J/K 都走同一个 skip()（不是三处各写一遍游标操作）', () => {
    // 按钮
    expect(SRC).toContain("onClick={() => skip('forward')}")
    // 键盘
    expect(SRC).toContain("action === 'skipNext') skip('forward')")
    expect(SRC).toContain("action === 'skipPrev') skip('backward')")
  })
})

describe('C2. 推进靠 onAnimationEnd，不许 setTimeout 串联', () => {
  it('有 onAnimationEnd', () => {
    expect(SRC).toContain('onAnimationEnd')
  })

  it('onAnimationEnd 调用 finishSwipe（推进逻辑真的挂上去了）', () => {
    const line = lineWith(SRC, 'onAnimationEnd={')
    expect(line).toContain('onBodyAnimationEnd')
    expect(SRC).toContain('finishSwipe(e)')
  })

  it('没有用 setTimeout 去串联 swipe / cursor / advance', () => {
    expect(SRC).not.toMatch(/setTimeout\([^)]*(swipe|cursor|advance)/i)
    // 更强的一条：整个文件不该出现 setTimeout（动画全是 CSS，不需要定时器）
    expect(SRC).not.toContain('setTimeout')
  })

  it('finishSwipe 里同时有 advanceAfterAssign 与 skipCurrent（两条路径都推进）', () => {
    const at = SRC.indexOf('const finishSwipe')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 1600)
    expect(body).toContain('advanceAfterAssign')
    expect(body).toContain('skipCurrent')
  })

  it('finishSwipe 有防重（子元素的 animationend 冒泡不该推进游标）', () => {
    const at = SRC.indexOf('const finishSwipe')
    const body = SRC.slice(at, at + 1600)
    expect(body).toContain('e.target !== e.currentTarget')
  })

  it('飞出期间键盘也挡（否则 ←/→ 改游标后 finishSwipe 会推进错的那张）', () => {
    const at = SRC.indexOf('decideTriageKey({')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 400)
    expect(body).toContain('busy || swipeState !== null')
  })

  it('skip() 自己有锁（按钮连点不靠 busy）', () => {
    const at = SRC.indexOf('const skip = useCallback')
    const body = SRC.slice(at, at + 500)
    expect(body).toContain('swipeLockRef.current')
  })
})

describe('C3. 外卡的 overflow-hidden 已摘掉（否则飞出被裁在圆角里）', () => {
  it('外卡那一行（锚定 max-w-[min(94vw,1080px)]）不含 overflow-hidden', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(outer).not.toContain('overflow-hidden')
  })

  it('外卡改成 overflow-visible 且保留 relative（飞出层要定位）', () => {
    const outer = lineWith(SRC, 'max-w-[min(94vw,1080px)]')
    expect(outer).toContain('overflow-visible')
    expect(outer).toContain('relative')
  })
})

describe('C4. 裁剪职责下移：左栏画框仍有 overflow-hidden', () => {
  it('画框那一行（锚定 h-[min(62vh,560px)]）仍有 overflow-hidden', () => {
    const frame = lineWith(SRC, 'h-[min(62vh,560px)]')
    expect(frame).toContain('overflow-hidden')
  })

  it('右栏仍有 overflow-y-auto（长内容要能滚）', () => {
    expect(SRC).toContain('overflow-y-auto')
  })
})

describe('C5. 无障碍：复用 prefers-reduced-motion', () => {
  it("源码含 'prefers-reduced-motion'（订阅系统偏好）", () => {
    expect(SRC).toContain('prefers-reduced-motion')
  })

  it('用 usePrefersReducedMotion() 取，而不是自己瞎判', () => {
    expect(SRC).toContain('usePrefersReducedMotion()')
  })

  it('档位取自 settings.motionQuality（与 AssetGrid 同口径 ?? balanced）', () => {
    expect(SRC).toContain("s.settings?.motionQuality ?? 'balanced'")
  })

  it('swipeTimingOf 拿 reducedMotion 作为第二参（退化真的接上了）', () => {
    expect(SRC).toContain('swipeTimingOf(motionQuality, reducedMotion)')
  })
})

describe('C6. 不破坏上一批成果（反向守卫）', () => {
  it('实底外卡仍在（bg-card）', () => {
    expect(SRC).toContain('bg-card')
  })

  it('右栏分区底仍在（bg-elevated/40 p-2.5）', () => {
    expect(SRC).toContain('bg-elevated/40 p-2.5')
  })

  it('遮罩仍在（quicklook-scrim / dialog-scrim）', () => {
    expect(SRC).toContain('quicklook-scrim')
    expect(SRC).toContain('dialog-scrim')
  })

  it('未被引入玻璃拟态（无 backdrop-blur / 无 bg-card/N）', () => {
    expect(SRC).not.toContain('backdrop-blur')
    expect(SRC).not.toMatch(/bg-card\/\d/)
  })

  it('未引入新色值（无 #hex / rgba()）', () => {
    expect(SRC).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(SRC).not.toMatch(/rgba?\(/)
  })

  it('仍含 useEscLayer + zClassForDepth（Esc 栈未被动画改动带跑）', () => {
    expect(SRC).toContain('useEscLayer(requestClose, true)')
    expect(SRC).toContain('zClassForDepth(escDepth)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C7. 样式守卫：keyframes 存在，且时长与 triageSwipe.ts 一致
// ─────────────────────────────────────────────────────────────────────────────

describe('C7. styles.css 的 keyframes 与时长契约', () => {
  it('三档出场的 @keyframes 都在', () => {
    expect(CSS).toContain('@keyframes triage-swipe-out-smooth')
    expect(CSS).toContain('@keyframes triage-swipe-out-balanced')
    expect(CSS).toContain('@keyframes triage-swipe-out-ultra')
  })

  it('入场与 reduced 的 @keyframes 都在', () => {
    expect(CSS).toContain('@keyframes triage-swipe-in')
    expect(CSS).toContain('@keyframes triage-swipe-fade-out')
    expect(CSS).toContain('@keyframes triage-swipe-fade-in')
  })

  it('CSS 里的 animation-duration 与 swipeTimingOf 逐档一致（防两边各写一份漂移）', () => {
    const exp: Record<string, number> = { smooth: 250, balanced: 320, ultra: 340 }
    for (const [tier, ms] of Object.entries(exp)) {
      // 该档所有规则块拼起来（组合规则那条没有 duration，不影响"某处写对了"的判定）
      const blocks = ruleBlocksOf(`.triage-swipe-out-${tier}`)
      expect(blocks).toContain(`animation-duration: ${ms}ms`)
      expect(ms).toBe(swipeTimingOf(tier as 'smooth' | 'balanced' | 'ultra', false).outMs)
    }
  })

  it('入场 200ms、reduced 160ms 与 TS 侧一致', () => {
    expect(ruleBlocksOf('.triage-swipe-in')).toContain('200ms')
    expect(ruleBlocksOf('.triage-swipe-fade-out')).toContain('160ms')
    expect(swipeTimingOf('balanced', true).outMs).toBe(160)
  })

  it('方向靠 --triage-dir 一份 keyframes 服务两向（不写左右两套）', () => {
    expect(CSS).toContain('var(--triage-dir')
    // 左飞不该有自己的独立 keyframes（那意味着要维护 6 份）
    expect(CSS).not.toContain('@keyframes triage-swipe-out-left')
    expect(CSS).not.toContain('@keyframes triage-swipe-out-right')
  })

  it('三段动画只用 transform / opacity（不引入颜色、不碰 backdrop-filter）', () => {
    const start = CSS.indexOf('@keyframes triage-swipe-out-smooth')
    const end = CSS.indexOf('@keyframes triage-swipe-fade-in')
    const block = CSS.slice(start, end)
    expect(block).not.toMatch(/backdrop-filter/)
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/\bbackground/)
  })

  it('有 prefers-reduced-motion 兜底块，且把三档都压成 fade', () => {
    const at = CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    const block = CSS.slice(at)
    expect(block).toContain('triage-swipe-out-smooth')
    expect(block).toContain('triage-swipe-fade-out')
    expect(block).toContain('transform: none')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 端到端纯逻辑：推进语义（DOM 那层的幂等由 C2 守卫）
// ─────────────────────────────────────────────────────────────────────────────

describe('D. 游标腾挪：跳过记 skipped、确认不记', () => {
  /** 用真实的 `startTriage` 开一个三张的会话（顺序与真实实现一致） */
  const start = (): TriageCursor =>
    startTriage([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never)

  it('初始落在 a', () => {
    const c = start()
    expect(c.currentId).toBe('a')
    expect(c.ids).toEqual(['a', 'b', 'c'])
    expect(triageIndex(c)).toBe(0)
  })

  it('skipCurrent 后从 a 变成 b，且 a 进了 skipped', () => {
    const c = skipCurrent(start(), 'forward')
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['b', 'c'])
    expect(c.skipped.has('a')).toBe(true)
  })

  it('advanceAfterAssign 后同样前进到 b，但 **不写** skipped', () => {
    const c = advanceAfterAssign(start())
    expect(c.currentId).toBe('b')
    expect(c.ids).toEqual(['b', 'c'])
    expect(c.skipped.size).toBe(0)
  })

  it('两条路径的差异只在 skipped（这正是 out-confirm / out-skip 必须分开的原因）', () => {
    const afterSkip = skipCurrent(start(), 'forward')
    const afterAssign = advanceAfterAssign(start())
    // 游标落点一致
    expect(afterSkip.currentId).toBe(afterAssign.currentId)
    expect(afterSkip.ids).toEqual(afterAssign.ids)
    // 跳过集不同
    expect(afterSkip.skipped.size).toBe(1)
    expect(afterAssign.skipped.size).toBe(0)
  })

  it('连续两次跳过（模拟快速连按）会连跳两张 —— 所以 DOM 层必须有幂等锁', () => {
    const once = skipCurrent(start(), 'forward')
    const twice = skipCurrent(once, 'forward')
    expect(once.currentId).toBe('b')
    expect(twice.currentId).toBe('c')
    // 这条断言是**反证**：纯函数本身不幂等（每次都真的推进），
    // 幂等责任在组件（`swipeLockRef` + `swipeRef` 清空判断，见 C2）。
    expect(twice.currentId).not.toBe(once.currentId)
  })

  it('最后一张确认后 currentId 归 null（组件据此关浮层，但要等动画放完）', () => {
    let c = start()
    c = advanceAfterAssign(c) // b
    c = advanceAfterAssign(c) // c
    c = advanceAfterAssign(c) // 空
    expect(c.currentId).toBeNull()
    expect(c.ids).toEqual([])
  })

  it('backward 跳过落到前一张（K 键方向）', () => {
    let c = start()
    c = { ...c, currentId: 'c' } // 先走到 c
    const back = skipCurrent(c, 'backward')
    expect(back.currentId).toBe('b')
    expect(back.skipped.has('c')).toBe(true)
  })
})
