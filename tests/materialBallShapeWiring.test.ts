/**
 * 「记住形状」的**接线守卫**（2026-10 缓存策略，cache-policy-engineer 的 store 侧已完成）。
 *
 * 背景：`Asset.renderShape` 已进 shared 类型并参与球图身份（`ballThumbName`），store 也有
 * `setRenderShape`。但**形态的 UI 与场景接线**在渲染层，缺了它会出现两种图文不一致：
 * ① 用户切了形状 → 不落库 → 下次启动球图是按平面渲的，弹窗里却是球；
 * ② 舞台/详情复用同一个 `MaterialBall`（换资产不重建 renderer），而 `defaultShape`
 *    只在 `useState` 初始化时读一次 → 换到"记住是平面"的资产时球还是上一个的形状。
 *
 * 本文件钉住三件事（node 里跑不了 WebGL/React，只能扫源码 + 验纯函数）：
 * ① 内嵌形态按钮的点击必须回调 `onShapeChange`（组件**不写库**，落库由调用方接）；
 * ② `defaultShape` 变化必须同步到内部 state（否则复用场景时形态不跟随资产）；
 * ③ `MaterialBallApi.getShape()` 必须走 ref（API 建在 deps:[] 的 effect 里，闭包会过期），
 *    且 MaterialStage 必须把 `resolveRenderShape(asset)` 传下去。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveRenderShape } from '../src/shared/ballParams'
import type { Asset, BallRenderShape } from '../src/shared/types'

function readSource(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

const BALL = readSource('../src/renderer/components/MaterialBall.tsx')
const STAGE = readSource('../src/renderer/components/MaterialStage.tsx')
const DIALOG = readSource('../src/renderer/components/CustomRenderDialog.tsx')

describe('记住形状 · 纯逻辑口径（读时兜底，不回填）', () => {
  it('三种合法值原样返回；缺省 / 脏值一律回落到球面', () => {
    const at = (shape: unknown): Asset =>
      ({ id: 'a', renderShape: shape as BallRenderShape | undefined }) as Asset
    expect(resolveRenderShape(at('sphere'))).toBe('sphere')
    expect(resolveRenderShape(at('plane'))).toBe('plane')
    expect(resolveRenderShape(at('roundedBox'))).toBe('roundedBox')
    expect(resolveRenderShape(at(undefined))).toBe('sphere')
    expect(resolveRenderShape(at('box'))).toBe('sphere')
  })
})

describe('记住形状 · MaterialBall 的接线点', () => {
  it('★形态按钮点击必须回调 onShapeChange（组件不写库）', () => {
    expect(BALL).toContain('onShapeChange?: (shape: BallShape) => void')
    expect(BALL).toContain('onShapeChange?.(s)')
    // 回调必须与 setShape 在同一个点击处理器里（不能挂在别处漏掉某一支）
    const at = BALL.indexOf('onShapeChange?.(s)')
    const handler = BALL.slice(Math.max(0, at - 200), at)
    expect(handler).toContain('setShape(s)')
  })

  it('★defaultShape 变化要同步到内部 state（舞台换资产复用同一个场景）', () => {
    expect(BALL).toContain('setShape(defaultShape)')
    // deps 必须是 [defaultShape]：写成 [] 等于只在挂载时同步一次（= 当前 bug）
    const at = BALL.indexOf('setShape(defaultShape)')
    const tail = BALL.slice(at, at + 120)
    expect(tail).toContain('[defaultShape]')
  })

  it('★getShape() 走 ref（API 在 deps:[] 的 effect 里创建，闭包里的 shape 会过期）', () => {
    expect(BALL).toContain('getShape(): BallShape')
    expect(BALL).toContain('const shapeRef = useRef(shape)')
    expect(BALL).toContain('shapeRef.current = shape')
    expect(BALL).toContain('getShape: () => shapeRef.current')
    // 不许写成 `getShape: () => shape`（挂载时的闭包值，永远返回初始形态）
    expect(BALL).not.toContain('getShape: () => shape\n')
  })
})

describe('记住形状 · MaterialStage 必须跟随资产的形态', () => {
  it('★defaultShape={resolveRenderShape(shown)}（卡片球图按形态渲，舞台不能不一致）', () => {
    expect(STAGE).toContain("import { resolveRenderParams, resolveRenderShape } from '../../shared/ballParams'")
    expect(STAGE).toContain('defaultShape={resolveRenderShape(shown)}')
  })
})

describe('记住形状 · CustomRenderDialog 的契约闭环', () => {
  it('★弹窗球必须带 defaultShape + onShapeChange（落库由弹窗调 store）', () => {
    expect(DIALOG).toContain("import { resolveRenderParams, resolveRenderShape, type NormalizedBallParams } from '../../shared/ballParams'")
    expect(DIALOG).toContain('defaultShape={resolveRenderShape(asset)}')
    expect(DIALOG).toContain(
      'onShapeChange={(s) => void useVault.getState().setRenderShape(asset.id, s)}'
    )
  })

  it('★「设为封面」渲 JPG 必须带场景当前形态（否则封面与预览不一致）', () => {
    const at = DIALOG.indexOf('renderBallToJpeg(asset.relFolder, slots, {')
    expect(at).toBeGreaterThan(-1)
    const body = DIALOG.slice(at, at + 260)
    expect(DIALOG).toContain('ballApiRef.current?.getShape() ?? resolveRenderShape(asset)')
    expect(body).toContain('shape,')
  })

  it('形态按钮对用户仍不可见（本批只让类型闭环，不加 UI）', () => {
    // 弹窗显式关闭内嵌形态面板；舞台走 chrome="bare"（`!bare && showShapeSwitch` 直接挡掉）
    expect(DIALOG).toContain('showShapeSwitch={false}')
    expect(STAGE).toContain('chrome="bare"')
    // 全仓不得出现第三个形态入口（菜单 / 快捷键 / 设置项）
    expect(BALL.split('SHAPE_ORDER.map(').length - 1).toBe(1)
  })
})
