/**
 * 球面 UV 等距补偿（0.6.9 用户反馈：「我的贴图是方砖，但在舞台球上显示的就是一个长砖」）。
 *
 * ── 事实（three 0.186 实测，先看这一段再改代码）───────────────────────────
 * `SphereGeometry` 是等距圆柱投影：`u` 走满一圈 → 赤道弧长 `2πr`，`v` 走满半圈
 * （南极→北极）→ 弧长 `πr`。**u:v 的弧长比恰好 2.000**，所以一张正方的砖纹贴图
 * 贴在赤道上会被横向拉伸 2 倍 → 方砖变长砖。
 *
 * 唯一正确解：**u 方向的 repeat 是 v 的 2 倍**（不是改球的分段数，也不是改相机）。
 * 平面 / 圆角盒的 u:v 是 1:1，不做补偿（否则会把方块贴图压成竖长条）。
 *
 * 本文件同时钉住三条源码守卫（防"顺手改回去"）：不再出现 `repeat.set(r, r)`、
 * 色调映射是 Neutral 不是 ACES、光强落在 `scene.environmentIntensity`。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  UV_ASPECT_SPHERE,
  applyUvRepeat,
  effectiveUvRepeat,
  uvAspectOf
} from '../src/renderer/logic/materialBall'

/** 最小贴图桩：只要 `repeat.set()`，与 three 的 Texture 结构兼容（不需要 WebGL） */
function fakeTexture(): { repeat: { x: number; y: number; set(x: number, y: number): void } } {
  return {
    repeat: {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x
        this.y = y
      }
    }
  }
}

describe('logic/materialBall · applyUvRepeat（球面 u 方向 ×2 弧长补偿）', () => {
  it('★applyUvRepeat(2.6) → repeat (5.2, 2.6)：比值恰好 2（方砖不变长砖）', () => {
    const tex = fakeTexture()
    applyUvRepeat(tex, 2.6)
    expect(tex.repeat.x).toBeCloseTo(5.2, 10)
    expect(tex.repeat.y).toBeCloseTo(2.6, 10)
    // 严格 2 倍：不是 1.98 / 2.02 这类近似值
    expect(tex.repeat.x / tex.repeat.y).toBeCloseTo(2, 12)
  })

  it('uv = 1 → (2, 1)：默认平铺下赤道横向重复两次，纵向一次', () => {
    const tex = fakeTexture()
    applyUvRepeat(tex, 1)
    expect(tex.repeat.x).toBe(2)
    expect(tex.repeat.y).toBe(1)
    expect(tex.repeat.x / tex.repeat.y).toBe(UV_ASPECT_SPHERE)
  })

  it('与 UV 滑块叠加：0.5 / 3 倍都保持 2:1', () => {
    for (const scale of [0.1, 0.5, 1, 2.5, 4]) {
      const tex = fakeTexture()
      applyUvRepeat(tex, effectiveUvRepeat(1, scale))
      expect(tex.repeat.x / tex.repeat.y).toBeCloseTo(2, 10)
    }
  })

  it('平面 / 圆角盒不做补偿（aspect 1）：u:v = 1:1，接缝检查才准', () => {
    expect(uvAspectOf('sphere')).toBe(2)
    expect(uvAspectOf('plane')).toBe(1)
    expect(uvAspectOf('roundedBox')).toBe(1)
    const plane = fakeTexture()
    applyUvRepeat(plane, 2, uvAspectOf('plane'))
    expect(plane.repeat.x).toBe(2)
    expect(plane.repeat.y).toBe(2)
  })

  it('真实 three.Texture 也吃同一份写入（不建 WebGL 上下文，只在 node 里构造对象）', async () => {
    const { Texture } = await import('three')
    const tex = new Texture()
    applyUvRepeat(tex, 1.5)
    expect(tex.repeat.x).toBe(3)
    expect(tex.repeat.y).toBe(1.5)
    tex.dispose()
  })
})

describe('源码守卫 · 球面渲染的成像口径（防顺手改回去）', () => {
  const SRC = fs.readFileSync(
    new URL('../src/renderer/components/MaterialBall.tsx', import.meta.url),
    'utf-8'
  )
  const DIALOG = fs.readFileSync(
    new URL('../src/renderer/components/CustomRenderDialog.tsx', import.meta.url),
    'utf-8'
  )

  it('★不再有 repeat.set(r, r)（旧写法会把球面方块贴图横向拉伸 2 倍）', () => {
    expect(/repeat\.set\(\s*r\s*,\s*r\s*\)/.test(SRC)).toBe(false)
  })

  it('三处贴图重复全部走同一个写入口径 repeatTexture / applyUvRepeat', () => {
    // applyRepeat 的循环 + loadMap + synthesizeNormalIfMissing
    const calls = SRC.match(/this\.repeatTexture\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(SRC).toContain('applyUvRepeat(tex, effectiveUvRepeat(base, this.uvMult), uvAspectOf(this.currentShape))')
  })

  it('★色调映射是 Neutral（Khronos PBR Neutral），不是 ACES Filmic', () => {
    expect(SRC).toContain('NeutralToneMapping')
    expect(SRC).not.toContain('ACESFilmicToneMapping')
    // 曝光保持 1.0：曝光交给光线强度滑块，别用它顶替
    expect(SRC).toContain('this.renderer.toneMappingExposure = 1.0')
    expect(SRC).not.toContain('toneMappingExposure = values')
  })

  it('★光线强度写在 scene.environmentIntensity（只影响照度，不改贴图采样）', () => {
    expect(SRC).toContain('this.scene.environmentIntensity = values.light')
  })

  it('★金属度 / 透明度写在材质上，且 alpha=1 时关掉 transparent（不留半透明排序开销）', () => {
    expect(SRC).toContain('applyMaterialParams(this.material, values)')
    const LOGIC = fs.readFileSync(
      new URL('../src/renderer/logic/materialBall.ts', import.meta.url),
      'utf-8'
    )
    expect(LOGIC).toContain('target.metalness = values.metal')
    expect(LOGIC).toContain('target.transparent = values.alpha < 1')
    expect(LOGIC).toContain('target.opacity = values.alpha')
  })

  it('★对话框六个滑块齐全（光线 / 反光 / 凹凸 / 金属 / 透明 / UV）', () => {
    expect(DIALOG).toContain('光线强度')
    expect(DIALOG).toContain('反光强度')
    expect(DIALOG).toContain('凹凸强度')
    expect(DIALOG).toContain('金属度')
    expect(DIALOG).toContain('透明度')
    expect(DIALOG).toContain('UV 大小')
    const sliders = DIALOG.match(/type="range"/g) ?? []
    expect(sliders.length).toBe(6)
  })
})
