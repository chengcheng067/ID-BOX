/// <reference lib="dom" />
/**
 * 飞行中的舞台球层级（0.7.10 回归修复）。
 *
 * 用户 0.7.9 真机原话：
 * > 「可是你把我点自定义渲染球从底下飞到自定义渲染的窗口的这个动画给做没有了呀。」
 *
 * 根因：这段"球飞进弹窗"不是弹窗内部做的，是**舞台那颗球自己**从顶栏槽位插值到弹窗球的
 * 外接框（`MaterialStage` 的 handoff 分支），关弹窗时再从弹窗位置飞回顶栏槽位（handback），
 * 退出文件视图时飞回网格卡片（closing）。`7edd3ec`（0.7.9）的 T-ZSTACK 把舞台球压到 45，
 * 弹窗遮罩是 50 起 —— 整段飞行被遮罩盖住，看起来就是"动画没了"。
 *
 * 修法（口径已定，别改）：新增 `Z_STAGE_FLYING = 90`，**只**在**在飞的三个阶段**使用 ——
 * `handoff`（飞进弹窗）/ `handback`（从弹窗飞回顶栏槽位）/ `closing`（飞回网格卡片）；
 * 静止（idle / active）与 opening 仍是 `Z_STAGE_BALL = 45`。
 * ⚠️ `handback` 与 `closing` 是两个方向、两个终点，**删掉任何一个都会精确复现回归**：
 * 关「自定义渲染」弹窗走的是 `handback`，而弹窗球淡出 120ms 后才卸载、飞行是 300ms ——
 * 那 120ms 里球要是 45，回程开头 40% 行程就被遮罩吞掉，球在半空"凭空出现"。
 *
 * 本文件钉四件事：
 * ① 常量值：90，且严格高于层栈封顶（80）；
 * ② 按相位取值：zIndex 那一行同时出现两个常量，条件**恰好**含 handoff / handback / closing，
 *    **不含** opening / idle / active（六相位全覆盖用例：新增相位会让它红）；
 * ③ 静止口径没被带回去：`Z_STAGE_BALL` 仍是 45 且低于 `Z_MODAL_BASE`；
 * ④ 90 只是视觉层级：容器仍是 `pointerEvents: 'none'`，飞行时不抢指针。
 *
 * 仓库 vitest 是 `environment: 'node'`、无 jsdom，组件渲染不了 → 组件侧只能靠源码守卫。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  Z_MODAL_BASE,
  Z_MODAL_MAX_LAYERS,
  Z_MODAL_STEP,
  Z_STAGE_BALL,
  Z_STAGE_FLYING
} from '../src/renderer/logic/zStack'

const read = (rel: string): string =>
  fs.readFileSync(new URL(`../src/renderer/${rel}`, import.meta.url), 'utf-8')

/** 取源码里第一条包含 needle 的行（守卫按行断言；找不到直接失败，避免"空串也算通过"） */
function lineWith(src: string, needle: string): string {
  const line = src.split('\n').find((l) => l.includes(needle))
  expect(line, `源码里找不到含「${needle}」的行`).toBeDefined()
  return line ?? ''
}

/** 层栈的封顶高度：第 Z_MODAL_MAX_LAYERS 层及以后都停在这里 */
const MODAL_Z_CEILING = Z_MODAL_BASE + (Z_MODAL_MAX_LAYERS - 1) * Z_MODAL_STEP

describe('Z_STAGE_FLYING：飞行中的球必须压在所有弹窗之上', () => {
  it('常量是 90（与 Z_MODAL_STEP 同粒度的余量，不取四位数）', () => {
    expect(Z_STAGE_FLYING).toBe(90)
    // 必须是 10 的整数倍：和整套层级的粒度一致，调试时一眼能读出"这是哪一档"
    expect(Z_STAGE_FLYING % Z_MODAL_STEP).toBe(0)
  })

  it('严格高于层栈封顶（80）：第 4 层及以后的弹窗都盖不住飞行中的球', () => {
    expect(MODAL_Z_CEILING).toBe(80) // 50 + 3 × 10，防有人改了封顶却没同步这里
    expect(Z_STAGE_FLYING).toBeGreaterThan(MODAL_Z_CEILING)
    // 余量至少一格，且不要大到失控（≤ 封顶 + 2 格）
    expect(Z_STAGE_FLYING - MODAL_Z_CEILING).toBeGreaterThanOrEqual(Z_MODAL_STEP)
    expect(Z_STAGE_FLYING - MODAL_Z_CEILING).toBeLessThanOrEqual(Z_MODAL_STEP * 2)
  })

  it('静止口径没被带回去：Z_STAGE_BALL 仍是 45，且低于最底层弹窗 50', () => {
    expect(Z_STAGE_BALL).toBe(45)
    expect(Z_STAGE_BALL).toBeLessThan(Z_MODAL_BASE)
    // 飞行档与静止档必须是两个不同的值，否则"按相位取值"等于没取
    expect(Z_STAGE_FLYING).not.toBe(Z_STAGE_BALL)
  })
})

describe('MaterialStage：zIndex 按相位取（静止 45 / 飞行 90）', () => {
  const stage = read('components/MaterialStage.tsx')

  it('zIndex 那一行同时出现 Z_STAGE_FLYING 与 Z_STAGE_BALL', () => {
    const zLine = lineWith(stage, 'zIndex:')
    expect(zLine).toContain('Z_STAGE_FLYING')
    expect(zLine).toContain('Z_STAGE_BALL')
  })

  it('抬层级的条件恰好是 handoff / handback / closing（在飞的三个阶段）', () => {
    const zLine = lineWith(stage, 'zIndex:')
    expect(zLine).toContain("phase === 'handoff'")
    // handback：关「自定义渲染」弹窗时球从弹窗位置飞回顶栏槽位。弹窗球淡出 120ms 后才卸载、
    // 飞行是 300ms —— 漏掉它，回程开头 40% 行程仍被遮罩吞掉（球在中途凭空出现）。
    expect(zLine).toContain("phase === 'handback'")
    expect(zLine).toContain("phase === 'closing'")
    // 三元的取值方向：条件成立 → FLYING，否则 → BALL（写反了就是"静止浮在弹窗上"）
    expect(zLine).toMatch(/\?\s*Z_STAGE_FLYING\s*:\s*Z_STAGE_BALL/)
  })

  it('opening 不许抬层级（那时没有弹窗，抬了可能盖住顶栏浮层）', () => {
    const zLine = lineWith(stage, 'zIndex:')
    expect(zLine).not.toContain('opening')
    // 静态三相位一个都不许出现在条件里：漏进来一个，静止时球就会浮在弹窗之上
    expect(zLine).not.toContain("phase === 'idle'")
    expect(zLine).not.toContain("phase === 'active'")
  })

  it('六相位全覆盖：新增相位时这条会红（逼人回来判断"在飞"还是"静止"）', () => {
    /*
     * `StagePhase` 是**类型**、没有运行时清单，所以从类型别名那一行把值抠出来：
     * 往联合里加第 7 个相位时，下面的 length / 集合断言立刻红 —— 不能让它默默
     * 走三元的 else 分支（= 45、被遮罩盖住），那正是 0.7.9 这次回归的形状。
     *
     * 抠法：类型别名那一行形如
     *   export type StagePhase = 'idle' | 'opening' | …
     * 按单引号切分后取奇数下标 = 引号里的内容（不用 matchAll，避免 lib 依赖）。
     */
    const unionLine = lineWith(read('logic/ballStage.ts'), 'export type StagePhase')
    const allPhases = unionLine.split("'").filter((_, i) => i % 2 === 1)

    // 与实现等价的判定表（两边都升序，便于逐项比对）
    const FLYING = ['closing', 'handback', 'handoff']
    const STATIC = ['active', 'idle', 'opening']

    expect(allPhases.length).toBe(6)
    expect([...allPhases].sort()).toEqual([...FLYING, ...STATIC].sort())
    // 合起来必须无遗漏、无多余：新增相位 → 这里红
    expect([...allPhases].sort()).toEqual(['active', 'closing', 'handback', 'handoff', 'idle', 'opening'])

    // 条件里提到的相位必须**恰好**等于飞行三相位：
    // 多一个 = 某个静止相位被抬高（球又会浮在弹窗上）；少一个 = 有一段飞行被遮罩吞掉
    const zLine = lineWith(stage, 'zIndex:')
    const mentioned = zLine
      .split("phase === '")
      .slice(1)
      .map((s) => s.split("'")[0] ?? '')
    expect(mentioned.sort()).toEqual(FLYING)
    // 其余三个相位（idle / opening / active）走三元的 else 分支 = Z_STAGE_BALL(45)
    expect(zLine).toMatch(/\?\s*Z_STAGE_FLYING\s*:\s*Z_STAGE_BALL/)
    for (const p of STATIC) expect(mentioned).not.toContain(p)
  })

  it('没有退回字面量硬编码（层级只能来自 logic/zStack.ts）', () => {
    const zLine = lineWith(stage, 'zIndex:')
    expect(zLine).not.toMatch(/zIndex:\s*\d/)
    expect(stage).not.toContain('zIndex: 45')
    expect(stage).not.toContain('zIndex: 90')
  })

  it('90 只是视觉层级：容器仍 pointerEvents:none，飞行时不抢弹窗的指针', () => {
    expect(stage).toContain("pointerEvents: 'none'")
    // 命令式那两处也必须是 none（idle 复位与遮罩复位），别被这次改动顺手放开
    expect(stage).toContain("host.style.pointerEvents = 'none'")
  })

  it('常量从 logic/zStack 导入，而不是在组件里另抄一份数字', () => {
    expect(stage).toContain("import { Z_STAGE_BALL, Z_STAGE_FLYING } from '../logic/zStack'")
  })
})

describe('表述一致性：提到 handoff 的文件必须把三个飞行相位写齐', () => {
  /*
   * 这一条是**事故复盘**，不是洁癖：本轮真实踩过两次 —— 实现与断言已经含 `handback`，
   * 但文件头 / 守卫旁的注释还写着「handoff / closing 抬到 90」。这种"断言新、注释旧"
   * 最危险：下一个人照注释把 `handback` 从三元里删掉，就会精确复现回归
   * （回程开头 40% 被遮罩吞掉、球在半空凭空出现），而所有断言当时都是绿的 ——
   * 因为注释不是断言，没人会因为它红。
   *
   * 判据用**充分条件式**（QA 提过的坑）：只要求「出现 handoff ⇒ 必须同时出现 handback
   * 与 closing」，**不**要求"只准出现这三个相位名"——`Z_STAGE_FLYING` 的注释天然要用
   * idle / active / opening 说明"静止时不是 90"，排他式断言必然误报。
   *
   * 粒度按**文件**而不是按行：注释会换行（"…抬到 90，见\n// tests/xxx"），按行断言会在
   * 合法的换行处误报；而按文件恰好能抓到这个 bug 的形状（整份文件缺 handback）。
   * 覆盖范围只列**本修复涉及**的 6 个文件，不做全仓扫描（`docs/08` 等由各自负责人维护）。
   */
  const GUARDED = [
    'src/renderer/components/MaterialStage.tsx',
    'src/renderer/logic/zStack.ts',
    'tests/stageFlyingZ.test.ts',
    'tests/zStack.test.ts',
    'tests/stagePerf2.test.ts',
    'docs/25-待办-用户反馈.md'
  ] as const

  /** 仓库根相对路径读取（上面的 `read` 只到 `src/renderer`，这里要跨 tests / docs） */
  const readRoot = (rel: string): string =>
    fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8')

  it('六个相关文件：写了 handoff 的地方，handback 与 closing 一个都不能少', () => {
    const missing: string[] = []
    for (const rel of GUARDED) {
      const src = readRoot(rel)
      // 不涉及飞行三相位表述的文件跳过（本修复的 6 个文件目前都会命中，这条是防御性分支）
      if (!src.includes('handoff')) continue
      if (!src.includes('handback')) missing.push(`${rel}：提到 handoff 但没有 handback（回程依据会丢）`)
      if (!src.includes('closing')) missing.push(`${rel}：提到 handoff 但没有 closing（回网格那段会丢）`)
    }
    expect(missing, `以下文件的注释/断言漏了飞行相位，照注释改会把回归装回来：\n${missing.join('\n')}`).toEqual(
      []
    )
  })
})
