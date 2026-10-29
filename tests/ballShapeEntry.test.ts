/**
 * 「材质球形态入口」的**纯逻辑 + 源码守卫**（2026-10，P1-3）。
 *
 * 为什么不做组件测试：`vitest.config.ts` 是 `environment: 'node'`，没有 jsdom ——
 * 渲染 React 会得到"看起来过了、其实什么都没验"的假绿。所以这里只钉两件能在 node 里
 * 钉死的东西：
 *
 * ① **纯逻辑口径**：`resolveRenderShape` 的三值/脏值回落，以及 `ballHash` 的缓存分叉
 *    （plane / roundedBox 必须换名，`'sphere'` 必须与 `undefined` 逐字符相同）。
 *    后三条是**缓存正确性底线**：算错会让同一材质的两张球图互相顶掉，或者让
 *    "切回球面"永远命中不到历史缓存、被迫全量重渲。
 *
 * ② **源码守卫**：UI 入口真的存在、真的调用了写库 action、真的只对材质类显示。
 *    这类守卫在 `tests/duplicates.test.ts` / `tests/materialBallShapeWiring.test.ts`
 *    里是既有做法（`fs.readFileSync` + 包含断言）。
 *
 * store 写入口的**行为**（写库字段、旧图先留后删、幂等门）已由
 * `tests/ballLazyUpgrade.test.ts` 的「⑥ 形态写入口契约」覆盖，这里不重复跑一遍
 * （那组需要 Dexie / FileReader 全套桩，跟本文件的纯逻辑目的不同）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAM_SCALES,
  ballHash,
  ballThumbName,
  resolveRenderShape
} from '../src/shared/ballParams'
import type { Asset, BallRenderShape, BallSlots } from '../src/shared/types'

function readSource(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

const DIALOG = readSource('../src/renderer/components/CustomRenderDialog.tsx')
const BALL = readSource('../src/renderer/components/MaterialBall.tsx')

/** 只带 id / renderShape 的最小资产（`resolveRenderShape` 只读这两个字段） */
function shapeAsset(shape?: unknown): Asset {
  return { id: 'a', renderShape: shape as BallRenderShape | undefined } as Asset
}

const SLOTS: BallSlots = {
  albedo: 'vh1sbjl_2K_Albedo.jpg',
  normal: 'vh1sbjl_2K_Normal.jpg'
}

// ── ① 纯逻辑：resolveRenderShape ──────────────────────────────────────

describe('resolveRenderShape · 三值原样 / 脏值回落球面', () => {
  it('三种合法值原样返回（不能把 plane 误判成 sphere）', () => {
    expect(resolveRenderShape(shapeAsset('sphere'))).toBe('sphere')
    expect(resolveRenderShape(shapeAsset('plane'))).toBe('plane')
    expect(resolveRenderShape(shapeAsset('roundedBox'))).toBe('roundedBox')
  })

  it('缺省 → sphere（存量记录没有该字段，等同球面）', () => {
    expect(resolveRenderShape(shapeAsset(undefined))).toBe('sphere')
    expect(resolveRenderShape({ id: 'b' } as Asset)).toBe('sphere')
  })

  it('非法值一律回落 sphere（不把脏值带进 hash）', () => {
    for (const bad of ['box', 'cylinder', '', 'SPHERE', 0, 1, null, {}, []]) {
      expect(resolveRenderShape(shapeAsset(bad))).toBe('sphere')
    }
  })
})

// ── ② 纯逻辑：ballHash 的缓存分叉（这三条是缓存正确性底线） ──────────

describe('ballHash · 形态参与缓存名', () => {
  const sphere = ballHash(SLOTS, DEFAULT_PARAM_SCALES, 'sphere')
  const implicit = ballHash(SLOTS, DEFAULT_PARAM_SCALES)
  const plane = ballHash(SLOTS, DEFAULT_PARAM_SCALES, 'plane')
  const box = ballHash(SLOTS, DEFAULT_PARAM_SCALES, 'roundedBox')

  it('★plane / roundedBox 与 sphere 产出**不同**的名字（否则换形态会命中旧图）', () => {
    expect(plane).not.toBe(sphere)
    expect(box).not.toBe(sphere)
    expect(plane).not.toBe(box)
  })

  it('★sphere 与「不传形态」**逐字符相同**（历史球图缓存不能失效）', () => {
    expect(sphere).toBe(implicit)
  })

  it('★切回球面 = 回到历史缓存名（不是"又一张新图"）', () => {
    // 模拟用户：球（有缓存）→ 平面 → 切回球
    const first = ballThumbName('id1', SLOTS)
    const asPlane = ballThumbName('id1', SLOTS, undefined, 'plane')
    const backToSphere = ballThumbName('id1', SLOTS, undefined, 'sphere')
    expect(asPlane).not.toBe(first)
    // 回到历史默认名 → `ballThumbIsFresh` 会直接命中，不重渲
    expect(backToSphere).toBe(first)
  })

  it('形态与参数正交：调过参的资产换形态同样换名，且球面仍与不传形态一致', () => {
    const tuned = { roughness: 1.5, bump: 1, uv: 0.5, light: 1, metal: 0, alpha: 1 }
    const base = ballHash(SLOTS, tuned)
    expect(ballHash(SLOTS, tuned, 'sphere')).toBe(base)
    expect(ballHash(SLOTS, tuned, 'plane')).not.toBe(base)
    expect(ballHash(SLOTS, tuned, 'roundedBox')).not.toBe(base)
  })

  it('golden 锁：球面 hash 与既有 golden 一致（本批没动 RENDER_REV / hash 输入）', () => {
    // RENDER_REV=5 的 golden：`ballParams.test.ts:168` / `ballLazyUpgrade.test.ts:309`
    // 已各有一份**相同**断言。这里第三份的用意不是"再锁一遍数字"，而是锁住
    // 「本批改形态 UI **没有**顺手把 hash 输入改掉」——一旦有人往 hash 里加字段，
    // 三处会一起红，而全库球图名字也同时作废。
    expect(ballHash(SLOTS, DEFAULT_PARAM_SCALES)).toBe('a68d8ee7')
  })
})

// ── ③ 源码守卫：UI 入口存在且接线正确 ─────────────────────────────────

describe('CustomRenderDialog · 形态控件接线', () => {
  it('★分段控件真的存在（三个选项、各自 onClick 调 changeShape）', () => {
    // 选项表：三个合法形态，一个都不能少
    expect(DIALOG).toContain('const SHAPE_OPTIONS')
    expect(DIALOG).toContain("value: 'sphere'")
    expect(DIALOG).toContain("value: 'plane'")
    expect(DIALOG).toContain("value: 'roundedBox'")
    // 渲染：map 出来、点击即切换
    expect(DIALOG).toContain('SHAPE_OPTIONS.map(')
    expect(DIALOG).toContain('onClick={() => changeShape(opt.value)}')
    // 选中态用既有设计语言（accent-tint + accent-text），不自造色值
    expect(DIALOG).toContain('bg-accent-tint font-medium text-accent-text')
  })

  it('★切换即写库（调 setRenderShape），且预览立刻换（defaultShape 用受控 state）', () => {
    // changeShape 里必须两件事都做：先 setState（预览）、再写库（持久化）
    const at = DIALOG.indexOf('const changeShape = (next: BallRenderShape): void => {')
    expect(at).toBeGreaterThan(-1)
    const body = DIALOG.slice(at, at + 400)
    expect(body).toContain('setShape(next)')
    expect(body).toContain('useVault.getState().setRenderShape(asset.id, next)')
    // 预览走受控 state，不直读 asset（store 写入是 async，直读会滞后一帧）
    expect(DIALOG).toContain('defaultShape={shape}')
    expect(DIALOG).not.toContain('defaultShape={resolveRenderShape(asset)}')
  })

  it('★只对 texture / material 显示（模型 / HDR 不显示这组控件）', () => {
    expect(DIALOG).toContain('function shapeSwitchableKind(')
    const at = DIALOG.indexOf('function shapeSwitchableKind(')
    const body = DIALOG.slice(at, at + 160)
    expect(body).toContain("kind === 'texture'")
    expect(body).toContain("kind === 'material'")
    // 控件渲染被这个判定守着
    expect(DIALOG).toContain('{showShapeSwitch && (')
  })

  it('控件放在滑块滚动区**之外**（换形态不该被滚出视野）', () => {
    const shapeAt = DIALOG.indexOf('{showShapeSwitch && (')
    const scrollAt = DIALOG.indexOf('space-y-3 overflow-y-auto pr-1')
    expect(shapeAt).toBeGreaterThan(-1)
    expect(scrollAt).toBeGreaterThan(-1)
    // 分段控件必须出现在滚动容器**之前**
    expect(shapeAt).toBeLessThan(scrollAt)
  })

  it('不把 three.js 拉回主 chunk（选项表独立，不从 MaterialBall import 运行时值）', () => {
    // 只允许 import **类型**（`import type` 编译期擦除，不会拉运行时依赖）
    expect(DIALOG).toContain("import type { MaterialBallApi } from './MaterialBall'")
    // 不许多出一个运行时 import：把文件里所有 `from './MaterialBall'` 的引入行捞出来，
    // 必须**全部**带 `import type`。写成不拉运行时值的另一种说法，比逐个字符串黑名单稳
    // （黑名单漏一个名字就静默放过）。
    const importLines = DIALOG.split('\n').filter((l) => l.includes("from './MaterialBall'"))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line).toContain('import type')
    }
    // 选项表是本文件自己的常量（不引用 MaterialBall 的 SHAPE_LABEL / SHAPE_ORDER）
    expect(DIALOG).toContain('const SHAPE_OPTIONS')
    expect(DIALOG).not.toContain('SHAPE_LABEL[')
    expect(DIALOG).not.toContain('SHAPE_ORDER')
  })
})

// ── ④ 源码守卫：MaterialBall 的形态能力确实可被外部驱动 ───────────────

describe('MaterialBall · 能被外部受控换形态', () => {
  it('★defaultShape 变化同步到场景（只换几何体，不重建上下文）', () => {
    expect(BALL).toContain('setShape(defaultShape)')
    // 依赖必须是 [defaultShape]；写成 [] 就只有挂载时生效
    const at = BALL.indexOf('setShape(defaultShape)')
    expect(BALL.slice(at, at + 120)).toContain('[defaultShape]')
    // 场景层 setShape 只换 geometry（重建上下文会让每次切形态都掉一次 WebGL）
    expect(BALL).toContain('this.geometry.dispose()')
    expect(BALL).toContain('this.mesh.geometry = next')
  })

  it('★三种形态都有真实几何（不是只留了 sphere 分支）', () => {
    expect(BALL).toContain("case 'sphere':")
    expect(BALL).toContain("case 'plane':")
    expect(BALL).toContain("case 'roundedBox':")
    expect(BALL).toContain('new SphereGeometry(')
    expect(BALL).toContain('new PlaneGeometry(')
    expect(BALL).toContain('new RoundedBoxGeometry(')
  })
})
