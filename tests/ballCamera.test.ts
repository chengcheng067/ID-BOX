/**
 * 取景口径的**纯数学**单测（不碰 GPU / WebGL）。
 *
 * 背景（docs/26 + team-lead 实测）：卡片球图只占画面 79.17%，包内 PBR 预览占 94.4%
 * → 用户看到"我们的球小一圈"、"上方一条黑边"（其实是 10.4% 透明留白透出画布色）。
 * 修法是**把相机沿原方向拉近**（分形态），本文件锁住三件事：
 *
 * ① 解析式与独立实测互校（球：解析 79.04% vs 720² 实拍 79.17%）；
 * ② 三形态在各自配置距离上的 fill 命中目标（sphere 0.944 / 其余 0.90）；
 * ③ **守门**：任何形态都不许超过 `MAX_SAFE_FILL`，球还必须离"贴满画布"有安全余量
 *    （d ≤ 1/sin(21°) = 2.7905 时球正好铺满整个画布，再近就切边）。
 *
 * 数值来源分工（避免"用同一个式子自证"）：
 * - 距离：`BALL_CAMERA_DISTANCE` 常量（sphere 解析反解，plane/box 探针实测微调）；
 * - 预测：sphere 用解析式，plane/box 用**实测表插值**（两个独立输入）。
 */
import { describe, expect, it } from 'vitest'
import {
  BALL_CAMERA_AIM,
  BALL_CAMERA_DISTANCE,
  BALL_FILL_TARGET,
  BALL_REF_DISTANCE,
  BALL_REF_FILL,
  MAX_SAFE_FILL,
  ballCameraDistance,
  ballCameraPosition,
  silhouetteFillAt,
  sphereDistanceForFill,
  sphereFillAt,
  type BallFrameShape
} from '../src/renderer/logic/ballCamera'

const SHAPES: BallFrameShape[] = ['sphere', 'plane', 'roundedBox']
/** fov=42° 时"球正好铺满画布"的临界距离：asin(1/d) = 21° ⇒ d = 1/sin21° */
const SPHERE_TANGENT_DISTANCE = 1 / Math.sin((21 * Math.PI) / 180)

describe('取景口径 · 解析式与独立实测互校', () => {
  it('球：解析式在基准距离给 79.04%，720² 实拍 79.17%（差 0.16%，同一口径）', () => {
    expect(sphereFillAt(BALL_REF_DISTANCE)).toBeCloseTo(0.7904, 4)
    expect(Math.abs(sphereFillAt(BALL_REF_DISTANCE) - BALL_REF_FILL.sphere)).toBeLessThan(0.003)
    expect(BALL_REF_FILL.sphere).toBeCloseTo(0.791667, 5)
  })

  it('球：正解 / 反解互逆（4 个量级各测一次）', () => {
    for (const d of [2.4, 2.7905, 2.935225, 3.444198, 4.52]) {
      expect(sphereDistanceForFill(sphereFillAt(d))).toBeCloseTo(d, 6)
    }
  })

  it('球：距离越近 fill 越大（单调，允许以后换公式但不许换反方向）', () => {
    let prev = 0
    for (const d of [5, 4.52, 3.44, 2.94, 2.8]) {
      const f = sphereFillAt(d)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
  })
})

describe('取景口径 · 三形态的目标 fill（离屏球图与实时球共用）', () => {
  it('sphere：0.944 ± 0.004（对齐包内 PBR 预览 94.44%）', () => {
    expect(ballCameraDistance('sphere')).toBeCloseTo(2.9352, 3)
    expect(silhouetteFillAt('sphere', ballCameraDistance('sphere'))).toBeCloseTo(
      BALL_FILL_TARGET.sphere,
      3
    )
  })

  it('plane：0.90 ± 0.01（距离是探针实测值，不是解析近似 3.3804）', () => {
    // 实测：3.3804 → 0.8958（差 0.47%）；微调到 3.3646 才正好 0.9000
    expect(BALL_CAMERA_DISTANCE.plane).toBeCloseTo(3.3646, 4)
    expect(silhouetteFillAt('plane', ballCameraDistance('plane'))).toBeCloseTo(0.9, 6)
  })

  it('roundedBox：0.90 ± 0.01（近似式 2.6469 实测会到 0.9333，必须收到 2.7216）', () => {
    expect(BALL_CAMERA_DISTANCE.roundedBox).toBeCloseTo(2.7216, 4)
    expect(silhouetteFillAt('roundedBox', ballCameraDistance('roundedBox'))).toBeCloseTo(0.9, 6)
    // 反向证明"近似反比"不够：用那个距离预测会明显超过目标
    expect(silhouetteFillAt('roundedBox', 2.6469)).toBeGreaterThan(0.92)
  })

  it('★修前对照：旧距离 3.4442 下球只有 0.79（这就是"小一圈"的数字）', () => {
    expect(silhouetteFillAt('sphere', BALL_REF_DISTANCE)).toBeLessThan(0.8)
    expect(silhouetteFillAt('plane', BALL_REF_DISTANCE)).toBeCloseTo(424 / 480, 5)
    expect(silhouetteFillAt('roundedBox', BALL_REF_DISTANCE)).toBeCloseTo(332 / 480, 5)
  })
})

describe('取景口径 · 守门（防日后有人把相机再往前推）', () => {
  it('★任何形态的投影宽高都不超过 0.97 画布', () => {
    for (const s of SHAPES) {
      const fill = silhouetteFillAt(s, ballCameraDistance(s))
      expect(fill).toBeLessThanOrEqual(MAX_SAFE_FILL)
      // 目标档本身也要明显低于上限，留出调节余量
      expect(fill).toBeLessThanOrEqual(0.95)
    }
  })

  it('★球必须离"贴满画布"有 ≥2% 的距离余量（d=2.7905 时正好铺满，再近就切边）', () => {
    expect(sphereFillAt(SPHERE_TANGENT_DISTANCE)).toBeCloseTo(1, 2)
    const d = ballCameraDistance('sphere')
    expect(d).toBeGreaterThan(SPHERE_TANGENT_DISTANCE)
    expect(d / SPHERE_TANGENT_DISTANCE).toBeGreaterThan(1.02)
    // 推到临界距离以内 → 必然越过上限（守门这一条要真的会红）
    expect(silhouetteFillAt('sphere', SPHERE_TANGENT_DISTANCE * 0.99)).toBeGreaterThan(
      MAX_SAFE_FILL
    )
  })
})

describe('取景口径 · 机位方向不许改（只改长度）', () => {
  it('三形态都在 (0, 0.55, 3.4) 这条射线上，长度 = 该形态距离', () => {
    for (const s of SHAPES) {
      const p = ballCameraPosition(s)
      const len = Math.hypot(p.x, p.y, p.z)
      expect(p.x).toBe(0)
      // y : z 比例必须与 AIM 一致（方向不变 ⇒ 俯角不变 ⇒ 球不偏心）
      expect(p.y / p.z).toBeCloseTo(BALL_CAMERA_AIM.y / BALL_CAMERA_AIM.z, 10)
      expect(len).toBeCloseTo(ballCameraDistance(s), 9)
    }
  })

  it('球的位置 = 旧向量 × 0.8521（2.935225 / 3.444198），供人工核对', () => {
    const p = ballCameraPosition('sphere')
    const k = ballCameraDistance('sphere') / BALL_REF_DISTANCE
    expect(p.y).toBeCloseTo(0.55 * k, 9)
    expect(p.z).toBeCloseTo(3.4 * k, 9)
    expect(p.z).toBeCloseTo(2.8976, 3)
  })
})
