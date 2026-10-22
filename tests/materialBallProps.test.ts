/**
 * `MaterialBall` 的三个可选 prop（docs/19 裁定①，T-02）单测。
 *
 * 拆成「纯逻辑 + 源码守卫」两层，因为 node 里跑不了 WebGL：
 * - 纯逻辑：`applyPose` / `applyAutoRotate` / `FrameLoop` 都是可注入、可桩的，
 *   直接验证「只写 z」「不自转」「停了不再排帧」；
 * - 源码守卫：`chrome` 的默认值与两条渲染分支只能从源码断言（没有 jsdom 渲染器）。
 *
 * 硬要求（逐条对应）：
 * ① `setPose` 只写 scale.z，不碰 x/y（`applyPose` 是 `setPose` 的唯一实现路径）；
 * ② `chrome` 默认 'full'，且 bare 分支不渲染调参面板/保存按钮；
 * ③ `autoRotate:false` 时不驱动自转；
 * ④ `setRunning(false)` 只停 rAF，**绝不** dispose（上下文要留给下次进入）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FrameLoop,
  POSE_MAX_Z,
  POSE_MIN_Z,
  applyAutoRotate,
  applyPose
} from '../src/renderer/components/MaterialBall'

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/MaterialBall.tsx'),
  'utf-8'
)

describe('setPose：只写 mesh.scale.z', () => {
  it('x / y 一个字节都不动，只有 z 变', () => {
    const mesh = { scale: { x: 1, y: 1, z: 1 } }
    applyPose(mesh, 0.42)
    expect(mesh.scale.z).toBe(0.42)
    expect(mesh.scale.x).toBe(1)
    expect(mesh.scale.y).toBe(1)
  })

  it('夹到 [POSE_MIN_Z, POSE_MAX_Z]，脏值回 1（防法线退化）', () => {
    const mesh = { scale: { x: 1, y: 1, z: 1 } }
    applyPose(mesh, 0)
    expect(mesh.scale.z).toBe(POSE_MIN_Z)
    applyPose(mesh, 99)
    expect(mesh.scale.z).toBe(POSE_MAX_Z)
    applyPose(mesh, Number.NaN)
    expect(mesh.scale.z).toBe(1)
    // 最小值必须 > 0：为 0 时法线退化，会出现黑边/闪烁
    expect(POSE_MIN_Z).toBeGreaterThan(0)
  })

  it('setPose 的实现只走 applyPose（不重建几何/材质）', () => {
    const body = SOURCE.slice(SOURCE.indexOf('setPose(z: number): void'))
    const head = body.slice(0, body.indexOf('\n  }'))
    // 断言意图而不是变量名：2026-10-21 起 setPose 会先把压扁轴朝向相机
    // （否则相机绕轨道转到侧面时，扁球的投影是椭圆），内部形参也从 z 改名为 v。
    expect(head).toContain('applyPose(this.mesh,')
    expect(head).not.toMatch(/new\s+(SphereGeometry|MeshPhysicalMaterial|TextureLoader)/)
    expect(head).not.toContain('needsUpdate')
  })
})

describe('autoRotate：关掉就不自转', () => {
  it('applyAutoRotate(false) 把 controls.autoRotate 置 false，true 复位', () => {
    const controls = { autoRotate: true }
    applyAutoRotate(controls, false)
    expect(controls.autoRotate).toBe(false)
    applyAutoRotate(controls, true)
    expect(controls.autoRotate).toBe(true)
    expect(() => applyAutoRotate(null, false)).not.toThrow()
  })

  it('构造与同步都走 autoRotate，而不是硬编码 true；默认值仍是 true', () => {
    // 弹窗不传 autoRotate → 默认 true（等价于改造前硬编码的 true）
    expect(SOURCE).toContain('autoRotate = true')
    expect(SOURCE).toContain('this.autoRotate = opts.autoRotate !== false')
    expect(SOURCE).toContain('this.controls.autoRotate = this.autoRotate')
    // 旧写法（硬编码 true）必须已经消失
    expect(SOURCE).not.toContain('this.controls.autoRotate = true')
    // 受控同步：prop 变化只改 controls，不重建场景
    expect(SOURCE).toContain('ballRef.current?.setAutoRotate(autoRotate)')
  })
})

describe('setRunning(false)：停 rAF 但不 dispose', () => {
  it('start 排帧、stop 取消，之后旧回调不再排帧', () => {
    let scheduled = 0
    let cancelled = 0
    let pending: (() => void) | null = null
    const loop = new FrameLoop(
      (cb) => {
        scheduled += 1
        pending = cb
        return scheduled
      },
      () => {
        cancelled += 1
      }
    )

    let ticks = 0
    loop.start(() => {
      ticks += 1
    })
    expect(loop.running).toBe(true)
    expect(scheduled).toBe(1)

    // 跑一帧：会再排下一帧
    // （TS 的控制流分析看不到闭包里的赋值，这里显式松一下类型）
    ;(pending as unknown as (() => void) | null)?.()
    expect(ticks).toBe(1)
    expect(scheduled).toBe(2)

    loop.stop()
    expect(loop.running).toBe(false)
    expect(cancelled).toBe(1)

    // 在途回调：不应再排帧，也不应再 tick
    ;(pending as unknown as (() => void) | null)?.()
    expect(scheduled).toBe(2)
    expect(ticks).toBe(1)
  })

  it('stop 幂等，重复 stop 不再 cancel', () => {
    let cancelled = 0
    const loop = new FrameLoop(
      () => 7,
      () => {
        cancelled += 1
      }
    )
    loop.stop()
    loop.stop()
    expect(cancelled).toBe(0)
  })

  it('setRunning 只 startLoop/stopLoop，源码里没有 dispose / forceContextLoss', () => {
    const body = SOURCE.slice(SOURCE.indexOf('setRunning(on: boolean): void'))
    const head = body.slice(0, body.indexOf('\n  }'))
    expect(head).toContain('this.startLoop()')
    expect(head).toContain('this.stopLoop()')
    // 只禁真正的释放调用（`this.disposed` 这个标志位不算）
    expect(head).not.toMatch(/\.dispose\(/)
    expect(head).not.toContain('forceContextLoss')
  })
})

describe("chrome：默认 'full'，bare 不渲染 chrome", () => {
  it("默认值是 'full'", () => {
    expect(SOURCE).toContain("chrome = 'full'")
    expect(SOURCE).toContain("chrome === 'bare'")
  })

  it('bare 分支去掉调参面板、保存按钮、抓取光标与底色', () => {
    // 两条面板分支都被 !bare 短路
    expect(SOURCE).toContain('{!bare && showShapeSwitch && (')
    expect(SOURCE).toContain('{!bare && enableParamPanel && (')
    // 抓取光标与背景色只在 full 下出现
    expect(SOURCE).toContain("className={bare ? 'h-full w-full' : 'h-full w-full cursor-grab active:cursor-grabbing'}")
    expect(SOURCE).toContain(
      'className={bare ? `relative overflow-hidden ${className ?? \'\'}` : `relative overflow-hidden bg-canvas ${className ?? \'\'}`}'
    )
  })

  it('apiRef 是可选 ref：不传就不建 API，卸载时置 null', () => {
    expect(SOURCE).toContain('apiRef?: MutableRefObject<MaterialBallApi | null>')
    expect(SOURCE).toContain('if (apiRefRef.current) {')
    expect(SOURCE).toContain('apiRefRef.current.current = null')
  })
})
