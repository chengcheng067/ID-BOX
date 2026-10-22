/**
 * 材质球的**取景口径**（纯数学/查表，不 import three / React，可在 node 里单测）。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────
 * 卡片球图之前只占画面 **79.17%**（720 画布上 bbox 570²），而包内 PBR 预览占 **94.4%**
 * （bbox 680²）→ 同一张卡片里我们的球看起来"小一圈"，且上方 10.42% 的透明留白在
 * 深色卡面上透出画布色，被用户读成"上方有一条黑边"。
 *
 * 黑边与 UV / wrapT / 极点**无关**（四组对照实测 bbox 完全一致：repeat(2,1)、(1,1)、
 * ClampToEdge、极点收缩都是 388² / 46px 留白）——就是取景太远留下的透明像素。
 * 所以唯一的解法是**把相机拉近**，不要再去动贴图采样。
 *
 * ── 口径（team-lead 拍板，别再改）──────────────────────────────────────
 * `fill = 投影外接框边长 ÷ 画布边长`（正方形画布；球宽高同一个数）。
 * 与 `MaterialStage` 的 `SPHERE_OCCUPANCY` 是同一个意思，可直接互算。
 *
 * 球心在原点、相机看向原点、fov=42° ⇒ 球（半径 1）在距离 d 处的投影占比：
 *   fill(d) = tan(asin(1/d)) / tan(21°)          （解析式；实测 79.17% vs 解析 79.04%）
 * 反解：
 *   d(fill) = 1 / sin(atan(fill · tan 21°))
 *
 * ── 为什么分形态 ───────────────────────────────────────────────────────
 * 平面（2.2²）与圆角盒（1.5³）不是球：投影尺寸对距离**不是严格反比**（透视 + 圆角轮廓
 * 随距离变化），所以它们的距离由**探针实测**定，不是解析反解。三档数值见
 * `BALL_CAMERA_DISTANCE`，出处与实测值见 `MEASURED_FILL_TABLE` 的注释。
 *
 * ⚠️ 方向不能改：相机仍在 (0, 0.55, 3.4) 这条射线上（`lookAt(0,0,0)` 一起保留），
 * 只改长度。换方向会让俯角变化 → 球偏心。
 */

/** 取景用到的形态（与 `BallShape` / `BallRenderShape` 逐字同形，互赋值无摩擦） */
export type BallFrameShape = 'sphere' | 'plane' | 'roundedBox'

/** 相机垂直视场角（必须与 `new PerspectiveCamera(42, …)` 一致） */
export const BALL_FOV_DEG = 42

/**
 * 机位方向 `(0, 0.55, 3.4)` —— **只用来定方向**，长度由形态决定。
 * 保留它是因为这条射线上标定过舞台的 `STAGE_CAMERA_D`（正前方 4.52，单独覆盖）。
 */
export const BALL_CAMERA_AIM = { x: 0, y: 0.55, z: 3.4 } as const

/** 旧默认距离 `|(0,0.55,3.4)|` = 3.444198，是所有实测的基准点 */
export const BALL_REF_DISTANCE = Math.hypot(BALL_CAMERA_AIM.y, BALL_CAMERA_AIM.z)

/**
 * 基准距离下的**实测**投影占比（480² 透明 PNG，`_probe_db/pngbbox.cjs`，alpha>8 求 bbox）。
 * 只用于"解析式可信度"的交叉校验与文档，不参与距离计算。
 */
export const BALL_REF_FILL = {
  sphere: 570 / 720, // 720² 实拍 bbox 570（= 0.791667）；解析式给 0.790420，差 0.16%
  plane: 424 / 480,
  roundedBox: 332 / 480
} as const

/**
 * 目标占比（team-lead 拍板）：
 * - **sphere 0.944** 是硬指标：对齐包内 PBR 预览（680²/720² = 94.44%，留 20px 安全边）；
 * - plane / roundedBox 没有参考图，取"不贴边"的最大值 0.90。
 */
export const BALL_FILL_TARGET: Record<BallFrameShape, number> = {
  sphere: 0.944,
  plane: 0.9,
  roundedBox: 0.9
}

/**
 * 形态 → 相机距离（**唯一真源**，组件与测试都从这里取，不许各自写常量）。
 *
 * 出处：
 * - sphere **2.935225** = `sphereDistanceForFill(0.944)`（解析反解；探针实测 0.9458，
 *   +0.19% —— bbox 阈值把抗锯齿边缘算进去的系统性偏差，与基准点的 +0.16% 一致）；
 * - plane **3.3646**：探针实测微调（解析近似 3.3804 时实测只有 0.8958，−0.47%）；
 * - roundedBox **2.7216**：探针实测微调（近似式给的 2.6469 实测到 0.9333，**+3.7% 会超目标**，
 *   所以 team-lead 说的"roundedBox 建议再量一遍"是必要的）。
 *
 * 探针实测（480²，灰球、无贴图，`_camprobe/`）：
 * | shape | bbox | fillW |
 * |---|---|---|
 * | sphere | 454² | 0.9458 |
 * | plane | 432×405 | 0.9000 |
 * | roundedBox | 432×414 | 0.9000 |
 */
export const BALL_CAMERA_DISTANCE: Record<BallFrameShape, number> = {
  sphere: 2.935225,
  plane: 3.3646,
  roundedBox: 2.7216
}

/**
 * 实测占比表 `[距离, fill]`（升序按距离），用于**回归守门**：
 * 「任何人把相机往前推，投影会变大」这件事必须有数字拦着。
 *
 * 这些点全部来自探针实测（同一套 three 设置、480² 透明 PNG、灰色材质）。表和距离互为
 * 独立输入：距离是常量，表是测量结果 —— 所以测试里"fill ≤ 0.97"不是自证。
 */
const MEASURED_FILL_TABLE: Record<'plane' | 'roundedBox', ReadonlyArray<readonly [number, number]>> = {
  plane: [
    [3.3646, 0.9], // 目标档
    [3.380417, 0.8958],
    [3.444198, 424 / 480]
  ],
  roundedBox: [
    [2.64693, 0.9333],
    [2.7216, 0.9], // 目标档
    [2.7449, 0.8896],
    [3.444198, 332 / 480]
  ]
}

/** 安全上限：任何形态的投影宽/高都不许超过画布的 97%（防日后有人把相机再往前推） */
export const MAX_SAFE_FILL = 0.97

function tanHalfFov(fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360)
}

/** 球在距离 `distance` 处的投影占比（解析式，仅对半径 1 的球成立） */
export function sphereFillAt(distance: number, fovDeg: number = BALL_FOV_DEG): number {
  if (!Number.isFinite(distance) || distance <= 1) return 1
  return Math.tan(Math.asin(1 / distance)) / tanHalfFov(fovDeg)
}

/** 反解：想让球占 `fill`，相机距离该是多少 */
export function sphereDistanceForFill(fill: number, fovDeg: number = BALL_FOV_DEG): number {
  const f = Number.isFinite(fill) && fill > 0 ? fill : BALL_FILL_TARGET.sphere
  return 1 / Math.sin(Math.atan(f * tanHalfFov(fovDeg)))
}

/**
 * 任意形态在距离 `distance` 处的**投影占比预测**。
 *
 * - sphere：解析式（可信到 0.13%，与 720² 实拍交叉校验过）；
 * - plane / roundedBox：**实测表分段线性插值**（超出表格两端就是外推，只当粗守门用）。
 */
export function silhouetteFillAt(
  shape: BallFrameShape,
  distance: number,
  fovDeg: number = BALL_FOV_DEG
): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1
  if (shape === 'sphere') return sphereFillAt(distance, fovDeg)

  const table = MEASURED_FILL_TABLE[shape]
  const first = table[0]!
  const last = table[table.length - 1]!
  if (distance <= first[0]) {
    // 外推：用最近一段的斜率（只用于"有人把相机推得太近"这条守门）
    const second = table[1]!
    return extrapolate(first, second, distance)
  }
  if (distance >= last[0]) {
    const prev = table[table.length - 2]!
    return extrapolate(prev, last, distance)
  }
  for (let i = 0; i < table.length - 1; i += 1) {
    const a = table[i]!
    const b = table[i + 1]!
    if (distance >= a[0] && distance <= b[0]) {
      const t = (distance - a[0]) / (b[0] - a[0])
      return a[1] + (b[1] - a[1]) * t
    }
  }
  return last[1]
}

function extrapolate(
  a: readonly [number, number],
  b: readonly [number, number],
  distance: number
): number {
  const t = (distance - a[0]) / (b[0] - a[0])
  return Math.max(0, a[1] + (b[1] - a[1]) * t)
}

/** 形态 → 相机距离（浮点值，单位与世界坐标一致） */
export function ballCameraDistance(shape: BallFrameShape): number {
  return BALL_CAMERA_DISTANCE[shape]
}

/** 形态 → 相机位置（沿原方向、按形态取长度；`lookAt(0,0,0)` 保持不变） */
export function ballCameraPosition(shape: BallFrameShape): { x: number; y: number; z: number } {
  const unitLen = Math.hypot(BALL_CAMERA_AIM.x, BALL_CAMERA_AIM.y, BALL_CAMERA_AIM.z)
  const k = ballCameraDistance(shape) / unitLen
  return {
    x: BALL_CAMERA_AIM.x * k,
    y: BALL_CAMERA_AIM.y * k,
    z: BALL_CAMERA_AIM.z * k
  }
}
