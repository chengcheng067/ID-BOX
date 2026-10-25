/**
 * 0.7.6「渐变贴图按灰度做透明度」回归（用户拍板，docs/25 未来需求第 1 条）。
 *
 * 三条纪律各自钉一组断言：
 *
 * ① **OPAQUE 陷阱**（本单最关键的修复）：three 的 `opaque = transparent === false`
 *    会被编成 `#define OPAQUE`，`opaque_fragment` 在 OPAQUE 下强制
 *    `diffuseColor.a = 1.0` → 整体不透明度仍是 100%（默认）+ 开了灰度图时，
 *    如果 `transparent` 还是 false，**灰度图被整个丢弃**，功能等于没做。
 *    所以 `applyMaterialParams` 的判据必须是 `alpha < 1 || hasAlphaMap`。
 *
 * ② **shader 补丁**：three 原生 alphamap 采样的是 `.g` 绿通道（数据图惯例），
 *    用户要的是"灰度"→ 必须改成亮度；反转走 uniform（拖动不许重编译）。
 *
 * ③ **接线完整性**：两个入口共用 `AlphaMapToggles`；`clearMaps` 必须清 alphaMap
 *    （否则换资产后 USE_ALPHAMAP 指着已 dispose 的纹理 = 黑球）；
 *    受控同步 effect 的 deps 必须带上新字段（否则弹窗勾了球不动）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAM_BASIS,
  ParamScaleState,
  applyMaterialParams,
  type MaterialParamValues,
  type ParamMaterialTarget
} from '../src/renderer/logic/materialBall'

/** 与 `MeshPhysicalMaterial` 同形的假体（不需要 three / WebGL） */
function fakeTarget(): ParamMaterialTarget & { needsUpdate: boolean } {
  const normalScale = {
    x: 1,
    y: 1,
    set(x: number, y: number): void {
      this.x = x
      this.y = y
    }
  }
  return {
    roughness: 0.5,
    normalScale,
    displacementScale: 0.04,
    metalness: 0,
    transparent: false,
    opacity: 1,
    needsUpdate: false
  }
}

/** 一份完整的参数取值（只覆盖关心的字段） */
function values(patch: Partial<MaterialParamValues> = {}): MaterialParamValues {
  return {
    roughness: 0.5,
    normalScale: 1,
    displacementScale: 0.04,
    uv: 1,
    metal: 0,
    alpha: 1,
    light: 1,
    alphaFromMap: true,
    alphaInvert: false,
    hasAlphaMap: false,
    ...patch
  }
}

describe('applyMaterialParams · OPAQUE 陷阱（有 alphaMap 就必须 transparent）', () => {
  it('★alpha = 1（默认不透明度）+ hasAlphaMap → transparent 必须为 true', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: true }))

    expect(t.transparent).toBe(true)
    // 翻转必须重编译（OPAQUE define 消失），否则 alphaMap 采样被 OPAQUE 抹平
    expect(t.needsUpdate).toBe(true)
    // 整体不透明度仍是 1：灰度图负责分布，滑块不额外压暗
    expect(t.opacity).toBe(1)
  })

  it('alpha = 1 + 没有 alphaMap → 仍是不透明快速路径（存量成像不变）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: false }))
    expect(t.transparent).toBe(false)
    expect(t.needsUpdate).toBe(false)
    expect(t.opacity).toBe(1)
  })

  it('alpha = 0.5 + hasAlphaMap：本来就要透明，不额外翻转（不重复重编译）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 0.5, hasAlphaMap: true }))
    expect(t.transparent).toBe(true)
    expect(t.needsUpdate).toBe(true)
  })

  it('同一状态连续写两次：第二次不置 needsUpdate（拖动不许每次重编译）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: true }))
    t.needsUpdate = false
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: true }))
    expect(t.needsUpdate).toBe(false)
  })

  it('关掉灰度图（hasAlphaMap false）且 alpha 1 → 回到 OPAQUE 快速路径', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: true }))
    t.needsUpdate = false
    applyMaterialParams(t, values({ alpha: 1, hasAlphaMap: false }))
    expect(t.transparent).toBe(false)
    expect(t.needsUpdate).toBe(true) // 翻回去也要重编译（把 OPAQUE 装回来）
  })
})

describe('ParamScaleState · 灰度透明字段的传导', () => {
  it('默认：alphaFromMap false / alphaInvert false / hasAlphaMap 取基准（默认 false）', () => {
    const state = new ParamScaleState()
    const v = state.currentValues
    expect(v.alphaFromMap).toBe(false)
    expect(v.alphaInvert).toBe(false)
    expect(v.hasAlphaMap).toBe(DEFAULT_PARAM_BASIS.hasAlphaMap)
    expect(v.hasAlphaMap).toBe(false)
  })

  it('scales 开启 → compute 立刻反映；invert 只在 alphaFromMap 为真时成立', () => {
    const state = new ParamScaleState()
    const on = state.setScales({ roughness: 1, bump: 1, uv: 1, alphaFromMap: true })
    expect(on.alphaFromMap).toBe(true)
    expect(on.alphaInvert).toBe(false)

    const inverted = state.setScales({
      roughness: 1,
      bump: 1,
      uv: 1,
      alphaFromMap: true,
      invertAlpha: true
    })
    expect(inverted.alphaInvert).toBe(true)

    // 关掉主开关时，残留的 invertAlpha 不许生效（与 normalizeParams 同口径）
    const off = state.setScales({
      roughness: 1,
      bump: 1,
      uv: 1,
      alphaFromMap: false,
      invertAlpha: true
    })
    expect(off.alphaFromMap).toBe(false)
    expect(off.alphaInvert).toBe(false)
  })

  it('hasAlphaMap 由贴图批次落定（markSettled）注入 → 同一次重算就带出 transparent', () => {
    const state = new ParamScaleState()
    state.setScales({ roughness: 1, bump: 1, uv: 1, alphaFromMap: true })
    const settled = state.markSettled({ hasAlphaMap: true })
    expect(settled.hasAlphaMap).toBe(true)

    const t = fakeTarget()
    applyMaterialParams(t, settled)
    expect(t.transparent).toBe(true)
  })

  it('markPending 把 hasAlphaMap 复位成 false（换资产时旧 alphaMap 已经不在了）', () => {
    const state = new ParamScaleState({ hasAlphaMap: true })
    const pending = state.markPending({ hasRoughnessMap: false, hasAlphaMap: false })
    expect(pending.hasAlphaMap).toBe(false)
  })
})

describe('源码守卫 · 0.7.6 灰度透明的接线（防"改回去"）', () => {
  const BALL = fs.readFileSync(
    new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
    'utf-8'
  )
  const LOGIC = fs.readFileSync(
    new URL('../src/renderer/logic/materialBall.ts', import.meta.url),
    'utf-8'
  )
  const DIALOG = fs.readFileSync(
    new URL('../src/renderer/components/CustomRenderDialog.tsx', import.meta.url),
    'utf-8'
  )
  const TOGGLES = fs.readFileSync(
    new URL('../src/renderer/components/AlphaMapToggles.tsx', import.meta.url),
    'utf-8'
  )

  it('★shader 补丁换掉了 three 原生的 alphamap_fragment，并取亮度而不是 .g', () => {
    expect(BALL).toContain('#include <alphamap_fragment>')
    expect(BALL).toContain('uAlphaInvert')
    // 亮度（Rec.709 权重）：用户说的是"按灰度"，不是"按绿通道"
    expect(BALL).toContain('0.2126')
    expect(BALL).toContain('0.7152')
    expect(BALL).toContain('0.0722')
    // 反转必须是 mix，而不是两套 shader / 重编译
    expect(BALL).toContain('mix( alphaLum, 1.0 - alphaLum, uAlphaInvert )')
    // 不许退回原生实现（.g 采样）
    expect(BALL).not.toContain('texture2D( alphaMap, vAlphaMapUv ).g')
  })

  it('★shader 补丁源码是纯 ASCII（中文注释会拼进 GLSL，部分驱动不宽容）', () => {
    const at = BALL.indexOf('const ALPHA_MAP_FRAGMENT_PATCH = `')
    expect(at).toBeGreaterThan(-1)
    const open = BALL.indexOf('`', at)
    const close = BALL.indexOf('`', open + 1)
    const shader = BALL.slice(open + 1, close)
    expect(shader.length).toBeGreaterThan(80)
    expect(/^[\t\n\r\x20-\x7e]*$/.test(shader)).toBe(true)
  })

  it('★反转只写 uniform，不触发重编译', () => {
    const at = BALL.indexOf('private setAlphaInvert(')
    expect(at).toBeGreaterThan(-1)
    const body = BALL.slice(at, BALL.indexOf('\n  }', at))
    expect(body).toContain('this.alphaInvertUniform.value')
    expect(body).not.toContain('needsUpdate')
  })

  it('assignMap 有 alpha 分支；clearMaps 清 alphaMap（漏了会黑球）', () => {
    expect(BALL).toContain("case 'alpha':")
    expect(BALL).toContain('material.alphaMap = tex')
    const at = BALL.indexOf('function clearMaps(')
    const body = BALL.slice(at, BALL.indexOf('\n}', at))
    expect(body).toContain('material.alphaMap = null')
  })

  it('applyMaps：markPending / settle / markReady 三处都带上 hasAlphaMap', () => {
    expect(BALL).toContain('markPending({ hasRoughnessMap: false, baseNormalScale: 1, hasAlphaMap: false })')
    expect(BALL).toContain('hasAlphaMap: this.material.alphaMap !== null')
    // entries 追加 alpha 项，源图就是 albedo 的 url（不新增 PBR 槽位）
    expect(BALL).toContain("entries.push(['alpha', albedoUrl])")
    expect(BALL).toContain('this.paramState.currentScales.alphaFromMap === true')
  })

  it('alpha 贴图保持线性（不设 SRGBColorSpace），且只有 albedo 设 sRGB', () => {
    expect(BALL).toContain("if (slot === 'albedo') tex.colorSpace = SRGBColorSpace")
    expect(BALL).not.toContain("slot === 'alpha') tex.colorSpace")
    // 平铺口径必须与 albedo 一致（同一行 repeatTexture 覆盖所有槽位）
    expect(BALL).toContain('this.repeatTexture(tex)')
  })

  it('受控同步 effect 的 deps 必须带两个新字段（否则弹窗勾了球不动）', () => {
    expect(BALL).toContain('params?.alphaFromMap')
    expect(BALL).toContain('params?.invertAlpha')
  })

  it('applyMaps 的触发条件包含灰度开关（否则勾选后不会重新挂 alphaMap）', () => {
    expect(BALL).toContain('const alphaMapEnabled = scales.alphaFromMap === true')
    expect(BALL).toContain('}, [urlsKey, alphaMapEnabled])')
  })

  it('★唯一写 opacity / transparent 的地方仍是 applyMaterialParams', () => {
    expect(LOGIC).toContain('const nextTransparent = values.alpha < 1 || values.hasAlphaMap')
    expect(BALL).not.toContain('material.opacity =')
    expect(BALL).not.toContain('material.transparent =')
  })

  it('★两个入口共用 AlphaMapToggles（避免两份实现漂移）', () => {
    expect(BALL).toContain("from './AlphaMapToggles'")
    expect(BALL).toContain('<AlphaMapToggles')
    expect(DIALOG).toContain("from './AlphaMapToggles'")
    expect(DIALOG).toContain('<AlphaMapToggles')
    // 关掉主开关时必须把反转一起归零（否则留下看不见的真值污染 hash）
    expect(TOGGLES).toContain('invertAlpha: next ? invertAlpha : false')
    // 反转在未勾选主开关时禁用
    expect(TOGGLES).toContain('disabled={!alphaFromMap}')
    // 说明文案（"分布 + 整体缩放"的心智模型）
    expect(TOGGLES).toContain('灰度图决定透明度分布，上面的滑块整体缩放')
  })

  it('弹窗的 Esc 交接路径未被覆盖（0.7.6 T-ESC 的成果必须保留）', () => {
    expect(DIALOG).toContain('useEscLayer(beginClose, renderable)')
    expect(DIALOG).toContain('onClick={beginClose}')
  })
})
