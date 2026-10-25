/**
 * 0.7.0 两条用户反馈的回归（都在材质球这条线上）：
 *
 * ① **透明度滑块首次拖动没反应**（P1）。根因不是"没写 opacity"，而是 three 把
 *    `opaque = transparent === false && blending === NormalBlending && alphaToCoverage === false`
 *    编进 **shader define**（`#define OPAQUE`），而 `opaque_fragment.glsl.js` 在 OPAQUE 下
 *    强制 `diffuseColor.a = 1.0` → `opacity` 写了也被丢弃。素材没变、program 缓存命中，
 *    所以拖动全无变化；"保存后重开又正常"是因为新材质在首次编译前就带上了 transparent=true。
 *    修法：`applyMaterialParams` 只在 `transparent` **翻转**时置 `needsUpdate`
 *    （无条件置会让每次拖动都重编译着色器 → 明显卡）。
 *
 * ② **「保存」与「设为封面」拆成两个按钮**：保存只记参数、绝不动封面。
 *    分流逻辑抽在 `renderActionPlan`，本文件钉死它 + 组件接线顺序。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyMaterialParams,
  renderActionPlan,
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

/** 一份完整的六参数取值（只需改 alpha 时用它铺默认） */
function values(patch: Partial<MaterialParamValues> = {}): MaterialParamValues {
  return {
    roughness: 0.5,
    normalScale: 1,
    displacementScale: 0.04,
    uv: 1,
    metal: 0,
    alpha: 1,
    light: 1,
    // 0.7.6 灰度透明：默认关、无 alphaMap（这些用例只关心 transparent 翻转）
    alphaFromMap: false,
    alphaInvert: false,
    hasAlphaMap: false,
    ...patch
  }
}

describe('applyMaterialParams · transparent 翻转必须重编译（P1 透明度没反应）', () => {
  it('★alpha 1 → 0.5：打开 transparent + 置 needsUpdate（否则 OPAQUE define 还在）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 0.5 }))

    expect(t.transparent).toBe(true)
    expect(t.opacity).toBe(0.5)
    // 这一条就是修复点：不置它 → program 缓存命中 → opacity 被 OPAQUE 丢弃
    expect(t.needsUpdate).toBe(true)
  })

  it('★alpha 0.5 → 0.7（同侧调整）：**不**置 needsUpdate（只改 opacity uniform）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 0.5 }))
    t.needsUpdate = false // 模拟"上一次翻转已经重编译完了"

    applyMaterialParams(t, values({ alpha: 0.7 }))

    expect(t.opacity).toBe(0.7)
    expect(t.transparent).toBe(true)
    // 每次拖滑块都重编译会卡；同侧调整绝不能触发
    expect(t.needsUpdate).toBe(false)
  })

  it('alpha 0.5 → 1（翻回不透明）：transparent 关掉 + 再置一次 needsUpdate', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 0.5 }))
    t.needsUpdate = false

    applyMaterialParams(t, values({ alpha: 1 }))

    expect(t.transparent).toBe(false)
    expect(t.opacity).toBe(1)
    expect(t.needsUpdate).toBe(true)
  })

  it('alpha 1 → 1：transparent 没翻转 → 不重编译', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ alpha: 1 }))
    expect(t.needsUpdate).toBe(false)
    expect(t.transparent).toBe(false)
  })

  it('只改金属度 / 反光 / 凹凸：都不触发重编译（普通 uniform）', () => {
    const t = fakeTarget()
    applyMaterialParams(t, values({ metal: 0.9, roughness: 1.4, normalScale: 1.6, displacementScale: 0.064 }))
    expect(t.metalness).toBe(0.9)
    expect(t.needsUpdate).toBe(false)
  })
})

describe('renderActionPlan · 「保存」与「设为封面」的分流（0.7.0 拆分）', () => {
  it('★保存：不写封面（既有 PBR 材质不该被我们的球顶成封面）', () => {
    const plan = renderActionPlan('params')
    expect(plan.writeCover).toBe(false)
    expect(plan.notice).toBe('已保存渲染参数')
  })

  it('★设为封面：写封面 + 保留原文案', () => {
    const plan = renderActionPlan('cover')
    expect(plan.writeCover).toBe(true)
    expect(plan.notice).toBe('已保存自定义渲染并设为封面')
  })

  it('两条路径的 notice 必须不同（用户要能分清刚才做了什么）', () => {
    expect(renderActionPlan('params').notice).not.toBe(renderActionPlan('cover').notice)
  })
})

describe('源码守卫 · 弹窗接线（防"顺手改回一个按钮"）', () => {
  const DIALOG = fs.readFileSync(
    new URL('../src/renderer/components/CustomRenderDialog.tsx', import.meta.url),
    'utf-8'
  )
  const LOGIC = fs.readFileSync(
    new URL('../src/renderer/logic/materialBall.ts', import.meta.url),
    'utf-8'
  )
  const BALL = fs.readFileSync(
    new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
    'utf-8'
  )

  it('★两个按钮都在，合并按钮的文案已消失', () => {
    expect(DIALOG).toContain("runAction('params')")
    expect(DIALOG).toContain("runAction('cover')")
    expect(DIALOG).toContain('保存中…')
    expect(DIALOG).toContain('渲染中…')
    expect(DIALOG).not.toContain('保存 · 设为封面')
  })

  it('★两条路径都先强制落库参数，再按 plan.writeCover 分流', () => {
    const persist = DIALOG.indexOf('await useVault.getState().persistRenderParams(asset.id, scales)')
    const branch = DIALOG.indexOf('if (plan.writeCover)')
    expect(persist).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(persist) // 顺序不能反：先记参数，再决定渲不渲封面
    expect(DIALOG).toContain('const plan = renderActionPlan(action)')
  })

  it('★"保存"路径里没有任何 cover 相关调用（写封面只在 if 分支内）', () => {
    // 只看 runAction 的函数体：文件头的注释里也提到过 setCoverImage，且上面的 effect 里
    // 有多处 `return () => ...`，所以用"\n  return ("（组件 JSX 的缩进）当结束锚点
    const body = DIALOG.slice(DIALOG.indexOf('const runAction'), DIALOG.indexOf('\n  return ('))
    const branch = body.indexOf('if (plan.writeCover)')
    expect(branch).toBeGreaterThan(-1)
    expect(body.indexOf('setCoverImage')).toBeGreaterThan(branch)
    expect(body.indexOf('setCover(')).toBeGreaterThan(branch)
  })

  it('失败文案分两条（不共用一句）', () => {
    expect(DIALOG).toContain('保存失败：参数未能写入，请重试')
    expect(DIALOG).toContain('封面保存失败：渲染或写盘未成功，请重试')
  })

  it('needsUpdate 只在 transparent 翻转的分支里出现一次（不许顺手加到别处）', () => {
    const writes = LOGIC.match(/needsUpdate\s*=\s*true/g) ?? []
    expect(writes.length).toBe(1)
    const at = LOGIC.indexOf('target.needsUpdate = true')
    const guard = LOGIC.lastIndexOf('if (target.transparent !== nextTransparent)', at)
    expect(guard).toBeGreaterThan(-1)
  })

  it('渲染层没有自己再碰 transparent / opacity（唯一写入口径仍是 applyMaterialParams）', () => {
    expect(BALL).not.toContain('material.transparent =')
    expect(BALL).not.toContain('material.opacity =')
  })
})
