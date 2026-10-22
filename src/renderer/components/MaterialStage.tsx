/**
 * 材质球舞台的**根级单例壳**（docs/19 裁定① / docs/20 §A，A 线）。
 *
 * 职责只有三件：
 * 1. 把 `MaterialBall`（three.js，chrome='bare'）挂在一个 fixed 容器里，
 *    位置/尺寸**全部走命令式 style.transform**，不通过 React 逐帧渲染；
 * 2. 按 `phase` 跑三段过场（P0 浮出 → P1 放大到外接圆×1.05 → P2 收进顶栏）+ 返回；
 * 3. WebGL 上下文纪律：只在挂载时创建，**关闭舞台不 dispose**（只 `setRunning(false)`），
 *    重新进入复用同一 renderer / 同一批贴图。
 *
 * 本组件**不读 settings、不读 store、不订阅任何全局状态**：
 * `asset / phase / originRect` 三个 prop 由调用方给，`onDone` 是"这一段动画演完了"的回执。
 * 因此它现在**没有被任何地方挂载**（接线是下一批），可以先独立测。
 *
 * 性能红线（docs/19 实测）：
 * - P1 期间**不碰任何 `.card`**：不要逐卡写 style/class（2000 张 = 95ms 长任务）；
 * - 落点用 CSS 变量 `--stage-target-x/y`，**绝不去改顶栏 height**（每帧重排整页）；
 * - z-index 60：落定的球住在顶栏槽位里，顶栏（50）有不透明底色，低于它会被盖住。
 */
import { useEffect, useRef } from 'react'
import type { Asset } from '../../shared/types'
import { resolveRenderParams, resolveRenderShape } from '../../shared/ballParams'
import { effectiveMaterialSlots, type MaterialSlots } from '../logic/materialBall'
import { currentMotionProfile } from '../logic/motionProfile'
import type { StagePhase } from '../logic/ballStage'
import { MaterialBall, type MaterialBallApi } from './MaterialBall'

/** 组件内在画布边长（与 MaterialBall 内 SIZE 对齐的取景框；与真实渲染分辨率无关） */
const LOCAL = 320

/**
 * 球在画布里的**实际占比**（实测，2026-10-21 21:0x）。
 *
 * `host` 边长 = `dia / SPHERE_OCCUPANCY`，所以这个值必须是真的占比，不能拍脑袋：
 * 在 `STAGE_CAMERA_D = 4.52`、fov 42° 下，球只占画布 **59.1%**（量法：同一帧读
 * canvas 尺寸与球体投影直径，90 / 152 ≈ 0.59；此前的 0.85 让 host 偏小 → 落定球径
 * 只有设计值的 ~0.7 倍，用户看到的就是「舞台那颗球比设计的小一圈」）。
 *
 * ⚠️ 别用「相机距离/画布尺寸」反推，那些反推出来的 0.79/0.9166 都是错口径，
 * 实测才是唯一依据；改机位必须重测这个数。
 */
const SPHERE_OCCUPANCY = 0.591

/** 兼容旧名（本文件内只此一处使用） */
const SPHERE_FILL = SPHERE_OCCUPANCY

/**
 * 舞台专用机位（正前方，整球可见）。
 * 产品默认机位 (0, 0.55, 3.4) 下球会溢出画布四边，顶栏那格只有 72px，必须拉远。
 * ⚠️ 这个距离是用户验收过的观感，**不要为了凑占比去改它**（改了透视会变）。
 */
const STAGE_CAMERA_D = 4.52

/** 过场时长（2026-10-21 原型定稿：双击后 340ms 落定，用户要"马上"） */
const OPEN_MS = 340
const CLOSE_MS = 420

/**
 * 舞台球 → 弹窗球的交接时长与缓动（2026-10，0.6.2）。
 *
 * 这段**不用 linear**：交接要"收得稳"，末尾必须减速贴合弹窗里那颗球，
 * 线性会在到位瞬间读作"啪一下停住"。cubic-bezier(.215,.61,.355,1) = easeOutCubic。
 */
const HANDOFF_MS = 300
const HANDOFF_EASING = 'cubic-bezier(0.215, 0.61, 0.355, 1)'

/**
 * opening 前的**就绪门控上限**（2026-10 白球修复）。
 *
 * 贴图没就绪就把球放上屏，渲出来是 0xb9b6b0 + 环境反射的浅灰白球（材质默认色），
 * 用户看到的就是"先一个白球、随后才贴上贴图"。这里用 rAF 轮询等就绪（球在
 * opacity:0 状态下继续渲染 = 白白赚到 shader 编译 + 贴图上传），最多等 400ms：
 * 超时必须放行，否则一个坏资产会让双击看上去"没反应"。
 */
const OPEN_READY_MS = 400

/** 膨胀峰值 = 卡片外接圆 × 1.14：圆形**漫出**卡片四角（用户口径「要覆盖超过这个卡片」） */
const PEAK_RATIO = 1.14
/** 峰值落在时间轴 28%：快速鼓起 → 立刻收，不是"吐泡泡再吸回" */
const PEAK_AT = 0.28
/** 厚度在这之前充完，保证胀大时已经是实心球 */
const PEAK_Z_AT = 0.42
/** 起手直径（×外接圆）：一颗小但完整的球，不是一个点 */
const COLD_R0 = 0.42
/** 起手厚度：低于 0.25 时那一帧是同色平片，读作"卡上一块污渍" */
const COLD_Z0 = 0.3

/** 落定球直径（顶栏槽位） */
const SLOT_DIA = 72

interface Geom {
  /** 圆心 x/y（CSS px） */
  cx: number
  cy: number
  /** 球的直径（CSS px） */
  dia: number
}

export interface MaterialStageProps {
  /** 当前要展示的资产；null = 没有（但会把上一个继续挂载着，保住 WebGL 上下文） */
  asset: Asset | null
  phase: StagePhase
  /** dblclick 时同步拍下的卡片矩形快照（动画全程只读它） */
  originRect: DOMRect | null
  /** 弹窗里那颗球的外接框（handoff 落点 / closing 起点）；无交接时为 null */
  handoffRect?: DOMRect | null
  /** 球已交给弹窗（phase 仍是 active，但舞台球必须隐身） */
  handedOff?: boolean
  /** 本段动画演完的回执（opening / closing / handoff 各一次） */
  onDone?: () => void
}

/** 空白槽位（稳定引用，避免每次渲染换新对象让 `slotUrls` 的 key 抖动） */
const EMPTY_SLOTS: MaterialSlots = {}

/** 三次方缓出：起步快、末段收稳（与 CSS 侧同类缓动，避免「先动后停」的突兀） */
function easeOut(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return 1 - Math.pow(1 - x, 3)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 读落点：优先取 App 在文件视图里留出的 `#stage-slot`（标题下方居中），
 *  退回到 CSS 变量，最后才回退到顶部居中 —— 保证本组件能独立跑。 */
function readTarget(): Geom {
  if (typeof window === 'undefined') return { cx: 0, cy: 0, dia: SLOT_DIA }
  const slot = document.getElementById('stage-slot')
  if (slot) {
    const r = slot.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) {
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dia: Math.min(r.width, r.height) }
    }
  }
  const cs = getComputedStyle(document.documentElement)
  const x = parseFloat(cs.getPropertyValue('--stage-target-x'))
  const y = parseFloat(cs.getPropertyValue('--stage-target-y'))
  const d = parseFloat(cs.getPropertyValue('--stage-size'))
  return {
    cx: Number.isFinite(x) ? x : window.innerWidth / 2,
    cy: Number.isFinite(y) ? y : 40,
    dia: Number.isFinite(d) && d > 0 ? d : SLOT_DIA
  }
}

function rectToGeom(rect: DOMRect): Geom {
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    dia: Math.max(8, Math.min(rect.width, rect.height))
  }
}

/** 几何 → host 的 CSS 姿势（tx/ty 是左上角，s 是相对 LOCAL 的缩放） */
interface Pose {
  tx: number
  ty: number
  s: number
}

/**
 * `Geom` → CSS 姿势（纯函数，`place()` 与 WAAPI keyframes 共用同一份口径）。
 *
 * 去掉了原来的 `toFixed(2)` / `toFixed(4)`：WAAPI 的插值结果是浮点数，
 * 两边保留不同精度反而会在起手帧引入亚像素跳变；直接给数即可。
 */
function poseOf(g: Geom): Pose {
  const size = g.dia / SPHERE_FILL
  return { tx: g.cx - size / 2, ty: g.cy - size / 2, s: size / LOCAL }
}

/** `Pose` → transform 字符串（与原有 place() 写出的值完全等价） */
function tf(p: Pose): string {
  return `translate3d(${p.tx}px, ${p.ty}px, 0) scale(${p.s})`
}

/** 卡片外接圆 ×1.05：球刚好盖住这一张卡，不铺满屏幕（docs/20 §A 修正后的口径） */
function circumscribed(rect: DOMRect): Geom {
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    dia: Math.hypot(rect.width, rect.height) * 1.05
  }
}

/**
 * 取舞台遮罩（App 里 `id="stage-veil"`，盖住中栏 + 右栏）。
 *
 * **每次现取，不缓存**：文件视图切换 / 空态与应用态互换时这个节点会被 React 重建，
 * 缓存的引用会指到一个已经脱离文档的旧节点（动画照跑但用户看不见）。
 * 取不到就返回 null，调用方全部静默跳过（舞台必须能独立跑）。
 */
function stageVeil(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById('stage-veil')
}

export function MaterialStage({
  asset,
  phase,
  originRect,
  handoffRect = null,
  handedOff = false,
  onDone
}: MaterialStageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<MaterialBallApi | null>(null)
  /** 最后一个个资产：phase 回到 idle 后仍要保留挂载，否则上下文会被销毁 */
  const shownRef = useRef<Asset | null>(null)
  const rafRef = useRef(0)
  /**
   * opening 的轨迹动画（WAAPI）。
   * 它跑在**合成器线程**上：主线程被 React 提交 / 长任务占住时轨迹依然满帧，
   * 只有厚度 z 还得用 rAF 在主线程上喂给 WebGL。
   */
  const animRef = useRef<Animation | null>(null)
  /** 厚度（mesh.scale.z）的 rAF 句柄：WebGL 内部状态，合成器碰不到 */
  const zRafRef = useRef(0)
  /** 遮罩的淡入/淡出动画（同样 WAAPI：`fill:'both'` 压住 React 写的内联 opacity） */
  const veilAnimRef = useRef<Animation | null>(null)
  const seqRef = useRef(0)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  if (asset) shownRef.current = asset
  const shown = shownRef.current
  /**
   * 实际参与渲球的槽位 & "有没有可展示的颜色"。
   *
   * ★ 性能修复 G（2026-10）：没有 albedo 的资产**不能 return null** ——
   * 那会卸载整个 `MaterialBall` → `BallScene.dispose()` → 销毁 WebGL 上下文，
   * 下次进来要重建 renderer + 重烘 PMREM（实测 12.9 + 40.7ms）。
   * 现在改为**渲一颗灰球保持挂载**（传空槽位 = 合法入参，组件文档里就是"纯灰球"），
   * 只把舞台藏起来（见下面的相位 effect）。真正卸载时清理逻辑完全不变。
   */
  const shownSlots = shown ? effectiveMaterialSlots(shown.files) : null
  const renderable = shownSlots !== null && typeof shownSlots.albedo === 'string'
  const ballSlots = renderable && shownSlots !== null ? shownSlots : EMPTY_SLOTS

  /**
   * 清掉遮罩上的动画并返回节点。
   *
   * 必须**先 cancel 再写内联值**：填充模式是 `fill:'both'`，动画在时它会压过内联
   * `opacity`（这正是我们要的 —— App 任意重渲染都打不回去）；一旦 cancel，内联值
   * 立刻生效，所以在 cancel 之后到下一次绘制之前必须把内联值写成目标值，否则闪一帧。
   */
  const resetVeil = (): HTMLElement | null => {
    const veil = stageVeil()
    if (!veil) return null
    veil.getAnimations().forEach((a) => a.cancel())
    veilAnimRef.current = null
    return veil
  }

  /** 把几何写成命令式 transform（不走 React） */
  const place = (g: Geom, z: number): void => {
    const host = hostRef.current
    if (!host) return
    host.style.transform = tf(poseOf(g))
    apiRef.current?.setPose(z)
  }

  /** 起一段动画：每帧只写 host.style.transform + mesh.scale.z（各 1 次） */
  const animate = (
    from: Geom,
    to: Geom,
    ms: number,
    z: (t: number) => number,
    done?: () => void
  ): void => {
    const host = hostRef.current
    if (!host) return
    const mySeq = ++seqRef.current
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const t0 = performance.now()
    const step = (): void => {
      if (mySeq !== seqRef.current) return
      const t = Math.min(1, (performance.now() - t0) / Math.max(1, ms))
      const e = easeOut(t)
      place(
        { cx: lerp(from.cx, to.cx, e), cy: lerp(from.cy, to.cy, e), dia: lerp(from.dia, to.dia, e) },
        z(t)
      )
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
        return
      }
      rafRef.current = 0
      done?.()
    }
    rafRef.current = requestAnimationFrame(step)
  }

  // ── 相位驱动：opening 跑 P0+P1+P2，closing 跑 420ms 返回，active 静止，idle 停 ──
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = apiRef.current
    // 先把机位摆正（整球可见），再走相位：否则第一帧就是溢出画布的球
    api?.setCameraDistance(STAGE_CAMERA_D)

    /**
     * 没有可渲的颜色贴图（性能修复 G）：**保持挂载**（灰球），但舞台必须一直隐藏。
     *
     * 为什么不能 return null：卸载 = dispose 上下文 + 下次重烘 PMREM（实测 12.9+40.7ms）。
     * 为什么不能显示灰球：这颗球在用户语境里是"这个材质的预览"，一颗灰球会被读成
     * 渲染失败（原来干脆什么都不显示，观感上更正确）。
     * 相位必须照常结束：`onDone` 是状态机的回执，不回调会让 App 永远停在 opening。
     */
    if (!renderable) {
      seqRef.current += 1
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      animRef.current?.cancel()
      animRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0
      const veil = resetVeil()
      if (veil) veil.style.opacity = '0'
      host.style.opacity = '0'
      host.style.pointerEvents = 'none'
      // 停帧但仍**不 dispose**：上下文与共享 envMap 留着，下次进入零重建成本
      api?.setRunning(false)
      // 只有这两段动画需要回执（其余相位 App 的回调本来就是 no-op）
      if (phase === 'opening' || phase === 'closing') doneRef.current?.()
      return
    }

    if (phase === 'idle') {
      // 停 rAF 但**不 dispose**：下次进入直接复用上下文与贴图
      seqRef.current += 1
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      // 抢占纪律：opening 可能正挂着 fill:'both' 的 WAAPI 动画，不停掉会留一个终态
      animRef.current?.cancel()
      animRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0
      // 遮罩必须回到全透明：否则回到网格后还盖着一层（cancel 后立刻写内联值，不闪）
      const veil = resetVeil()
      if (veil) veil.style.opacity = '0'
      host.style.opacity = '0'
      host.style.pointerEvents = 'none'
      api?.setRunning(false)
      return
    }

    // 过场必须跑帧，否则 setPose 的 z 变化画不出来（画布会停在上一帧）
    api?.setRunning(true)

    if (phase === 'active') {
      if (handedOff) {
        // 球已经交给弹窗：停在顶栏槽位但**隐身**，等弹窗关闭时从这里复活
        host.style.opacity = '0'
        place(readTarget(), 1)
        return
      }
      // 落定态：已经在顶栏槽位里，直接可见
      host.style.opacity = '1'
      const t = readTarget()
      place(t, 1)
      return
    }

    if (phase === 'handoff') {
      // 舞台球飞进「自定义渲染」弹窗的那颗球：单段 300ms，easeOutCubic 收稳
      host.style.opacity = '1'
      animRef.current?.cancel()
      animRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0

      const mySeq = ++seqRef.current
      const from = readTarget()
      const to = handoffRect ? rectToGeom(handoffRect) : from
      // 交接过程中必须是实心球（弹窗里那颗也是满厚度）
      api?.setPose(1)
      const flight = host.animate(
        [{ transform: tf(poseOf(from)) }, { transform: tf(poseOf(to)) }],
        { duration: HANDOFF_MS, easing: HANDOFF_EASING, fill: 'both' }
      )
      animRef.current = flight
      flight.onfinish = () => {
        if (mySeq !== seqRef.current) return
        // 同 opening：先撤 fill 再把终态落成内联值，最后隐藏自己（弹窗球接管）
        flight.cancel()
        if (animRef.current === flight) animRef.current = null
        place(to, 1)
        host.style.opacity = '0'
        doneRef.current?.()
      }
      return
    }

    if (phase === 'handback') {
      /*
       * 关弹窗 / 保存：球从**弹窗位置**飞回**顶栏槽位**，结束后仍是 active（留在顶部可见）。
       *
       * ⚠️ 与 closing 互斥（closing 的终点是网格卡片 → idle）。0.6.2 的 bug 就是
       * 关弹窗误用了 closing：球朝早已不在屏幕上的卡片坐标飞，然后被收起来 —— 用户看到"球消失"。
       * 往返用同一个 HANDOFF_EASING（easeOutCubic）才对称。
       */
      host.style.opacity = '1'
      animRef.current?.cancel()
      animRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0

      const mySeq = ++seqRef.current
      const to = readTarget()
      const from = handoffRect ? rectToGeom(handoffRect) : to
      // 回程也必须是实心球（弹窗里那颗一直是满厚度）
      api?.setPose(1)
      const flight = host.animate(
        [{ transform: tf(poseOf(from)) }, { transform: tf(poseOf(to)) }],
        { duration: HANDOFF_MS, easing: HANDOFF_EASING, fill: 'both' }
      )
      animRef.current = flight
      flight.onfinish = () => {
        if (mySeq !== seqRef.current) return
        // 先撤 fill 再把终态落成内联值；**必须保持可见**（球留在槽位里）
        flight.cancel()
        if (animRef.current === flight) animRef.current = null
        place(to, 1)
        host.style.opacity = '1'
        doneRef.current?.()
      }
      // 这条路径不碰遮罩：内容和球本来都是可见状态，遮罩在这里没有意义
      return
    }

    if (phase === 'closing') {
      // 返回态必须可见：从「弹窗里那颗球」或顶栏槽位起飞，先复活再飞
      host.style.opacity = '1'
      // 抢占纪律：从 opening / handoff 直接转 closing 时，飞行动画必须先停，否则它会继续
      // 用 fill:'both' 覆盖下面 animate() 每帧写的 transform。
      animRef.current?.cancel()
      animRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0
      if (!originRect) return
      // 交接过的球从**弹窗位置**回家（不是从顶栏槽位飞出）
      const from = handoffRect ? rectToGeom(handoffRect) : readTarget()
      const origin = rectToGeom(originRect)
      // 遮罩反向：内容在球飞回时逐渐隐去（回到网格时再由 idle 复位成透明）
      const veil = resetVeil()
      if (veil) {
        veil.style.opacity = '0' // 从全透明起跑；cancel 之后必须先落内联值，否则闪一帧
        veilAnimRef.current = veil.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: CLOSE_MS,
          easing: 'linear',
          fill: 'both'
        })
      }
      // 返回：420ms 从起点飞回卡片，最后 40% 把厚度压回去（先收尺寸再压扁）
      animate(from, origin, CLOSE_MS, (t) => (t < 0.6 ? 1 : lerp(1, 0.08, (t - 0.6) / 0.4)), () => {
        doneRef.current?.()
      })
      return
    }

    if (phase !== 'opening' || !originRect) return

    // ── opening：就绪门控 + 让一帧，然后才显示 ────────────────────────────
    // 一条时间轴（2026-10-21 原型定稿）：
    // 直径：小而完整的球 → 峰值（外接圆×1.14，漫出卡片）→ 顶栏槽位
    // 厚度：前 42% 就充完，胀大过程中必须是实心球
    // 三段串行（P0/P1/P2）会让"鼓成球"和"飞走"变成两件事，读起来生硬，已废弃。
    const circle = circumscribed(originRect)
    const peak: Geom = { ...circle, dia: circle.dia * PEAK_RATIO }
    const start: Geom = { ...circle, dia: circle.dia * COLD_R0 }
    const slot = readTarget()

    const mySeq = ++seqRef.current
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    // 抢占纪律：重新进入 opening 时上一轮可能还挂着动画 / 厚度 rAF
    animRef.current?.cancel()
    animRef.current = null
    if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
    zRafRef.current = 0

    // 起手位先在不可见状态下摆好（小球 + 压扁），用户第一眼看到的是"从卡片浮出"
    host.style.opacity = '0'
    // 清掉上一轮残留的内联 transform（closing 的 rAF 写的 / 被 cancel 的动画留下的），
    // 否则它会和下面 place() 写的新值打架，动画首帧会跳一下
    host.style.transform = ''
    place(start, COLD_Z0)

    // 遮罩在**上屏之前**就必须已经全不透明：否则会先闪一帧完整内容再被盖住。
    // 此刻球还没显示、内容也才刚开始绘制，同一帧内设到 1 来得及。
    const veilAtStart = resetVeil()
    if (veilAtStart) veilAtStart.style.opacity = '1'

    const gate0 = performance.now()

    /** 门控放行后：先让出一帧，再显示 + 起 340ms 时间轴 */
    const reveal = (): void => {
      if (mySeq !== seqRef.current) return
      // 为什么让一帧：双击这一帧里 AssetGrid 还同步做了 openFolderView(a.id)，
      // 「网格 → 文件视图」的 React 提交 + 整页布局要落屏。动画如果和它在同一帧
      // 抢主线程，头几帧就会掉（用户实测的"双击瞬间掉帧"）。
      rafRef.current = requestAnimationFrame(() => {
        if (mySeq !== seqRef.current) return
        rafRef.current = 0
        host.style.opacity = '1'

        // ── 轨迹：交给合成器（Web Animations API）─────────────────────────
        // 三站与既有时间轴完全对齐：起手小扁球(0) → 峰值漫出卡片(0.28) → 顶栏槽位(1)。
        // 原几何插值本来就是线性（直径/圆心都是 lerp），所以 easing 必须是 'linear'，
        // 加任何缓动都会改变已验收的观感。
        const flight = host.animate(
          [
            { transform: tf(poseOf(start)), offset: 0 },
            { transform: tf(poseOf(peak)), offset: PEAK_AT },
            { transform: tf(poseOf(slot)), offset: 1 }
          ],
          { duration: OPEN_MS, easing: 'linear', fill: 'both' }
        )
        animRef.current = flight
        flight.onfinish = () => {
          if (mySeq !== seqRef.current) return
          // fill:'both' 在结束后仍会**覆盖内联 transform**，不 cancel 的话后续
          // active 的 place() / 窗口 resize 都改不动它。先撤动画，再把终态落成内联值。
          flight.cancel()
          if (animRef.current === flight) animRef.current = null
          place(slot, 1)
          doneRef.current?.()
        }

        // ── 厚度：只能留在主线程（mesh.scale.z 是 WebGL 内部状态）──────────
        // `OPEN_MS * PEAK_Z_AT` = 142.8ms，等价于原来的 `zt = min(1, t / PEAK_Z_AT)`。
        const z0 = performance.now()
        const zStep = (): void => {
          if (mySeq !== seqRef.current) return
          const zt = Math.min(1, (performance.now() - z0) / (OPEN_MS * PEAK_Z_AT))
          api?.setPose(lerp(COLD_Z0, 1, easeOut(zt)))
          if (zt < 1) zRafRef.current = requestAnimationFrame(zStep)
          else zRafRef.current = 0
        }
        zRafRef.current = requestAnimationFrame(zStep)

        // ── 遮罩：与飞行同一处起跑，内容随球落地**逐渐浮现** ─────────────────
        // 同样用 WAAPI：`fill:'both'` 会压过 React 写的内联 opacity，
        // App 任意重渲染都打不回去（这正是"遮罩不许被重渲染打回"的保证）。
        const veilNode = stageVeil()
        if (veilNode) {
          // 极致档才给遮罩加模糊：大区域 backdrop-filter 很贵，默认档加回去等于
          // 把刚治好的掉帧请回来 —— 「清晰起来」的观感只在用户主动选极致时买单。
          const ultra = currentMotionProfile().id === 'ultra'
          veilNode.style.backdropFilter = ultra ? 'blur(12px)' : ''
          veilNode.style.background = ultra
            ? 'color-mix(in srgb, var(--bg-canvas) 72%, transparent)'
            : ''
          const veilAnim = veilNode.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: OPEN_MS,
            easing: 'linear',
            fill: 'both'
          })
          veilAnimRef.current = veilAnim
          veilAnim.onfinish = () => {
            if (mySeq !== seqRef.current) return
            // 结束必须落回内联 0：否则以后任何一次 cancel（新一轮 opening / idle）
            // 都会把整层不透明遮罩亮出来。
            veilAnim.cancel()
            if (veilAnimRef.current === veilAnim) veilAnimRef.current = null
            veilNode.style.opacity = '0'
          }
        }
      })
    }

    /**
     * 为什么等就绪：贴图未就绪时球已经上屏 → 那一帧是材质默认色 0xb9b6b0 的浅灰
     * 白球（还没贴图），随后才贴上贴图并开始飞 —— 就是用户报的"白球"。
     * 门控期间 opacity 仍是 0，但 setRunning(true) 已在跑帧：这几十毫秒顺带完成了
     * shader 编译 + 贴图上传，等于免费预热。api 还没建好时不能空等，直接放行。
     */
    const waitReady = (): void => {
      if (mySeq !== seqRef.current) return
      const ready = !api || api.isReady()
      if (ready || performance.now() - gate0 >= OPEN_READY_MS) {
        reveal()
        return
      }
      rafRef.current = requestAnimationFrame(waitReady)
    }
    rafRef.current = requestAnimationFrame(waitReady)
  }, [phase, originRect, asset?.id, handoffRect, handedOff, renderable])

  /**
   * 卸载清理：`fill: 'both'` 的 WAAPI 动画在 cancel 之前会一直挂在 host 上，
   * 不 cancel 就会留一个终态动画对象（还引用着已脱离文档的节点）。
   * deps 为 [] ⇒ 只在真正卸载时执行，不干扰相位切换。
   */
  useEffect(
    () => () => {
      animRef.current?.cancel()
      animRef.current = null
      // 遮罩也一样：`fill:'both'` 的动画会一直挂在 App 那个节点上（比舞台活得久）
      veilAnimRef.current?.cancel()
      veilAnimRef.current = null
      if (zRafRef.current) cancelAnimationFrame(zRafRef.current)
      zRafRef.current = 0
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    },
    []
  )

  /**
   * idle 预热：hover 把资产交给舞台后，等贴图就绪就渲染一帧（舞台 opacity:0，用户看不见）。
   * 这一帧是必须的 —— three 的贴图首次渲染才上传 GPU，只解码不上传，双击仍要付上传成本。
   * 轮询而不是事件：MaterialBall 没有暴露"加载完成"回调，100ms × 25 次（2.5s）足够覆盖 4K 解码。
   */
  useEffect(() => {
    if (phase !== 'idle' || !asset || !renderable) return
    let cancelled = false
    let tries = 0
    const tick = (): void => {
      if (cancelled) return
      const api = apiRef.current
      if (!api) {
        if (++tries <= 25) window.setTimeout(tick, 100)
        return
      }
      if (api.isReady()) {
        api.warm()
        return
      }
      if (++tries <= 25) window.setTimeout(tick, 100)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [phase, asset?.id, renderable])

  if (!shown) return null

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: LOCAL,
        height: LOCAL,
        transformOrigin: '0 0',
        zIndex: 60,
        opacity: 0,
        pointerEvents: 'none',
        willChange: 'transform, opacity'
      }}
    >
      <MaterialBall
        relFolder={shown.relFolder}
        // 无 albedo：空槽位 = 纯灰球（合法入参），只为**保持 WebGL 上下文活着**；
        // 舞台由上面的相位 effect 保持 opacity:0，用户看不到这颗灰球（性能修复 G）。
        slots={ballSlots}
        apiRef={apiRef}
        chrome="bare"
        // 交接一致性：舞台球与弹窗球必须用**同一套参数**（弹窗读 resolveRenderParams），
        // 否则飞回来的那颗会在半路"换一个样子"。
        params={resolveRenderParams(shown)}
        // 形态同理（2026-10 缓存策略：形态参与球图身份）：卡片上那张球图是按
        // `resolveRenderShape(asset)` 渲的，舞台球不改的话会和卡片图文不一致。
        defaultShape={resolveRenderShape(shown)}
        // 落定后必须转：用户实测「球在上面并不会转」——之前这里写死 false，
        // 舞台又不跑 OrbitControls 的自动旋转，等于把球冻住了。
        autoRotate={phase === 'active'}
        className="h-full w-full"
      />
    </div>
  )
}
