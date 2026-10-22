/**
 * P1 缺陷回归：自定义渲染弹窗的**首帧球**必须是滑块值，不是"默认质感"。
 *
 * ── 现场复盘（实测证据，先看这一段再改代码）─────────────────────────────
 * 用户原话：「点自定义渲染的时候，第一下出来的球，它的光泽度是一个默认的显示，
 * 但实际上不是我们滑块的预期」。
 *
 * 两个最初假设都被证伪：
 * - **H2 不成立**：`CustomRenderDialog` 的 `scales` 初值就是 `resolveRenderParams(asset)`，
 *   `params={scales}` 首帧**不是 undefined**（滑块显示的 1.7/1.6/2.5 就是场景该用的值）；
 * - **H1 不成立**：`BallScene.baseRoughness` 是 `readonly 0.5` 常量（见源码守卫用例），
 *   贴图流程从不给它赋值，所以不存在"构造时基准尚未就绪"的时间窗。
 *
 * 真正的根因是**组件时序 + 构造入参缺失**：
 * 1. `MaterialBall` 里 `useEffect(() => ballRef.current?.setParamScales(scales), [scales])`
 *    声明在建场景 effect **之前** → 挂载时它先执行，此刻 `ballRef.current === null`，空转；
 * 2. 建场景 effect 写的是 `new BallScene(canvas, { shape, interactive: true })`
 *    —— **没传 params** → 构造函数只能 `setParamScales(DEFAULT_PARAM_SCALES)`；
 * 3. 于是 `BallScene` 的"当前倍率"永远是 1×，`applyMaps` 落定后的那次重算也用 1×
 *    → 首帧 roughness = 0.5（而滑块 1.7 期望 1.7）、normalScale = 1（期望 1.6）、
 *    repeat = 1（期望 2.5）→ 用户看到的"偏亮/偏反光"就是这个 0.5 vs 1.7；
 * 4. 一拖动滑块 `params` 变 → effect 重跑 → 这时候场景已存在 → 立刻变对。
 *
 * ── 修复的三条收敛点（都在本文件的用例里钉住）───────────────────────────
 * ① 建场景时把当前倍率带进构造函数（`params: scalesRef.current`）；
 * ② `applyMaps` 的**所有**出口统一 `settleParamBasis()` —— 材质就绪必然按当前倍率重算；
 * ③ 状态机 `ParamScaleState` 记 dirty：基准未落定期间收到的调参，落定时一定补算。
 *
 * 修复刻意**没有**用 `setTimeout` / `requestAnimationFrame` 猜时序。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAM_BASIS,
  ParamScaleState,
  applyMaterialParams,
  effectiveRoughness,
  type ParamMaterialTarget
} from '../src/renderer/logic/materialBall'

/** 滑块上的实测值（用户现场：反光 ×1.7 / 凹凸 ×1.6 / UV ×2.5） */
const SLIDER = { roughness: 1.7, bump: 1.6, uv: 2.5 }

/** 材质里该看到的实际值（与 `MeshPhysicalMaterial` 同形的假对象，不需要 three / WebGL） */
interface FakeMaterial {
  target: ParamMaterialTarget
  read(): { roughness: number; normalScale: number; displacementScale: number }
}

function fakeMaterial(): FakeMaterial {
  const ns = {
    x: 1,
    y: 1,
    set(x: number, y: number): void {
      this.x = x
      this.y = y
    }
  }
  const target: ParamMaterialTarget = { roughness: 0.5, normalScale: ns, displacementScale: 0.04 }
  return {
    target,
    read: () => ({
      roughness: target.roughness,
      normalScale: ns.x,
      displacementScale: target.displacementScale
    })
  }
}

function readSource(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

describe('P1 首帧质感 · effectiveRoughness 的两种口径', () => {
  it('无 roughnessMap：roughness = base × 倍率（夹到 1）；有 map：倍率本身就是整体乘数', () => {
    // 首帧"默认质感"就是左边这个 0.85（0.5 × 1.7），而滑块 1.7 的期望值是右边这个 1.7
    expect(effectiveRoughness(false, 0.5, SLIDER.roughness)).toBeCloseTo(0.85)
    expect(effectiveRoughness(true, 0.5, SLIDER.roughness)).toBeCloseTo(1.7)
    // 无 map 时倍率再大也夹到 1（>1 无意义）
    expect(effectiveRoughness(false, 0.5, 4)).toBe(1)
    // 倍率 0 = 镜面
    expect(effectiveRoughness(true, 0.5, 0)).toBe(0)
    expect(effectiveRoughness(false, 0.5, 0)).toBe(0)
  })
})

describe('P1 首帧质感 · ParamScaleState（dirty 记账 → 落定必重算）', () => {
  it('基准未就绪时 setScales 只算临时值并记 pending（旧实现在这里就"定稿"了）', () => {
    const state = new ParamScaleState({ baseRoughness: DEFAULT_PARAM_BASIS.baseRoughness })
    const m = fakeMaterial()

    // 场景构造 / 首帧同步：此刻贴图还没回来（applyMaps 的 Promise 没 resolve）
    applyMaterialParams(m.target, state.setScales(SLIDER))

    expect(state.isSettled).toBe(false)
    expect(state.isPending).toBe(true) // ← dirty：落定时必须再算一次
    // 临时值：无 roughnessMap 口径
    expect(m.read().roughness).toBeCloseTo(0.85)
    expect(m.read().normalScale).toBeCloseTo(1.6) // normalScale 与 map 无关，已经是终值
  })

  it('注入 baseRoughness 后**自动**重算（调用方不需要再补一次 setScales）', () => {
    const state = new ParamScaleState()
    const m = fakeMaterial()
    state.setScales(SLIDER)

    applyMaterialParams(m.target, state.setBasis({ baseRoughness: 0.8 }))

    expect(m.read().roughness).toBeCloseTo(1) // min(1, 0.8 × 1.7)
    expect(state.isPending).toBe(true) // 仍然 dirty（还没落定）
    expect(state.currentScales).toEqual(SLIDER) // 倍率没被基准覆盖
  })

  it('★落定后 material.roughness 必须等于"按滑块值算出的值"，且 pending 清空', () => {
    const state = new ParamScaleState()
    const m = fakeMaterial()
    state.setScales(SLIDER) // 构造时（基准未落定）

    // 贴图全部落定：roughnessMap 到位 → 倍率直接生效
    applyMaterialParams(m.target, state.markSettled({ hasRoughnessMap: true }))

    expect(state.isSettled).toBe(true)
    expect(state.isPending).toBe(false)
    expect(m.read().roughness).toBeCloseTo(SLIDER.roughness) // 1.7，不是 0.85
    expect(m.read().normalScale).toBeCloseTo(SLIDER.bump) // 1.6
    expect(m.read().displacementScale).toBeCloseTo(0.04 * SLIDER.bump)
    expect(state.currentValues.uv).toBeCloseTo(SLIDER.uv)
  })

  it('加载中途又拖了滑块：落定用的是**最新**倍率（不是加载开始时的快照）', () => {
    const state = new ParamScaleState()
    state.markPending({ hasRoughnessMap: false, baseNormalScale: 1 })
    state.setScales({ roughness: 0.4, bump: 0.5, uv: 1 })
    state.setScales(SLIDER) // 用户在解码窗口里又拖了一次

    const settled = state.markSettled({ hasRoughnessMap: false })

    expect(settled.roughness).toBeCloseTo(0.85) // min(1, 0.5 × 1.7)
    expect(settled.normalScale).toBeCloseTo(1.6)
    expect(settled.displacementScale).toBeCloseTo(0.04 * 1.6)
    expect(settled.uv).toBeCloseTo(2.5)
  })

  it('换贴图（markPending）会把基准打回"未落定"，但保留当前倍率', () => {
    const state = new ParamScaleState()
    state.setScales(SLIDER)
    state.markSettled({ hasRoughnessMap: true })

    state.markPending({ hasRoughnessMap: false, baseNormalScale: 1 })

    expect(state.isSettled).toBe(false)
    expect(state.isPending).toBe(true)
    expect(state.currentScales).toEqual(SLIDER)
    expect(state.currentValues.roughness).toBeCloseTo(0.85) // 临时口径
  })

  it('没有 albedo 的灰球（entries 为空）也必须落定：1× 就是 1×', () => {
    const state = new ParamScaleState()
    const v = state.markSettled()
    expect(v.roughness).toBeCloseTo(DEFAULT_PARAM_BASIS.baseRoughness)
    expect(v.normalScale).toBeCloseTo(1)
    expect(v.uv).toBeCloseTo(1)
  })
})

describe('P1 首帧质感 · 接线守卫（源码级，防"顺手改回去"）', () => {
  const SRC = readSource('../src/renderer/components/MaterialBall.tsx')

  it('★建场景必须把当前倍率同步进去（旧实现漏了这一条 → 首帧停在 1×）', () => {
    // 构造函数调用形态被 tests/stagePerf.test.ts 的源码守卫钉住，所以"带参"走的是
    // 建完立刻同步（同一提交内，早于下一个 effect 的 applyMaps）
    expect(SRC).toContain('ball.setParamScales(scalesRef.current)')
    expect(SRC).toContain('const scalesRef = useRef(scales)')
    const ctor = SRC.indexOf('ball = new BallScene(canvas, { shape, interactive: true })')
    // 文档注释里也出现过这行调用，取最后一次（真正的执行点在建场景 effect 里）
    const sync = SRC.lastIndexOf('ball.setParamScales(scalesRef.current)')
    expect(ctor).toBeGreaterThan(-1)
    expect(sync).toBeGreaterThan(ctor)
  })

  it('★贴图落定必须回调 + 同步 effect 的 deps 必须含就绪版本号', () => {
    expect(SRC).toContain('setMapsSettledListener')
    expect(SRC).toContain('setMapsVersion((v) => v + 1)')
    expect(SRC).toContain('[scales, mapsVersion]')
  })

  it('★applyMaps 的所有出口都走 settleParamBasis（不得只重算"基准复位"那一支）', () => {
    const calls = SRC.match(/this\.settleParamBasis\(\)/g) ?? []
    // 至少两处：空槽位分支 + Promise.all 落定分支
    expect(calls.length).toBeGreaterThanOrEqual(2)
    // 旧写法（读调用方快照）必须彻底消失
    expect(SRC).not.toContain('setParamScales(this.lastScales)')
    expect(SRC).not.toContain('lastScales')
  })

  it('H1 证伪证据：baseRoughness 是常量基准，贴图流程从不写它', () => {
    expect(SRC).toContain('private baseRoughness = 0.5')
    // 唯一的写入点是 setRoughnessBase（供未来"从贴图统计真实基准"使用，当前无人调用）
    const writes = SRC.match(/this\.baseRoughness\s*=/g) ?? []
    expect(writes.length).toBe(1)
    expect(SRC).toContain('setRoughnessBase')
  })
})
