/**
 * HDR 预览弹窗（0.6.5，2026-10-22 用户口径重做）——「HDR 全景当背景，中间一颗小白球」。
 *
 * ## 用户原话（这一版的唯一判据）
 *
 * > 「红色框里面显示 HDR 里面的贴图，就是 HDR 的展示，然后小圆圈才是我们的白色的小球。
 * >  就意味着白色的小球其实是接受 HDR 预览的 HDR 的光源方向的一个承载体。
 * >  背后的 HDR 下面再增加一个滑块，来 360 度地转我们的 HDR 来预览，然后再增加一个拍照按钮，
 * >  因为一旦按下拍照，那么就可以成为我们软件的预览图，就是放在卡片上的预览图。」
 *
 * 因此本组件的形态是：
 * 1. **主视区 = HDR 全景本身**（`scene.background`，等距柱状），用户能直接看见天空/地面；
 * 2. **中间一颗小白球**（占视区高度 ~20%），只用来"承载光源方向"——HDR 转到哪，球上的
 *    高光/明暗就跟着变；
 * 3. **底部 0–360° 滑块**：拖动同时旋转 `scene.backgroundRotation.y` 与
 *    `scene.environmentRotation.y`（背景与光照必须同步，否则球和背景会"打架"）；
 * 4. **视区内横向拖拽**也能转，且与滑块双向同步；
 * 5. **「拍照」**：按当前角度渲染一帧 → PNG → 走**既有封面链路**（`setCoverFromImage`
 *    → IPC 落盘 `<资产名>.cover.png` → `commitCover` 重生缩略图）设为卡片预览图。
 *
 * ## 为什么解码仍在主进程
 *
 * 源图 16384×8192 / 367MB：`HDRLoader` 在渲染进程解成 Float32 约 1.6GB（直接崩），
 * 16384 也超过很多显卡的 `MAX_TEXTURE_SIZE`。渲染进程只读主进程产出的 ≤4096 宽缓存
 * （`hdr://<key>.hdr`），见 `main/hdrDecode.ts`。
 *
 * ## 主题
 *
 * 视口恒为深色（白球在浅底上会消失，且 HDR 全景本身就是"屏幕"）。面板挂
 * `data-theme="dark"`，于是内部所有 token 都解析成深色档 —— 浅色外壳 / 深色外壳下
 * 预览器内部**像素一致**，且不需要任何写死的色值。
 *
 * ## 惰性加载
 *
 * 本文件静态 import three；由 `App.tsx` 用 `React.lazy` 动态引入（只有真正打开预览
 * 才拉 chunk），不进主 bundle。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  WebGLRenderer
} from 'three'
import type { Texture, WebGLRenderTarget } from 'three'
// `RGBELoader` 在 r180 起只是 `HDRLoader` 的 deprecated 别名（会打 console.warn），
// 两者实现完全相同；这里用新名字，避免每次开预览刷一条弃用告警。
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { isHdrExt } from '../../shared/hdrExts'
import { formatBytes } from '../../shared/format'
import { assetFileAbs } from '../logic/assetPath'
import { coverImageInputOf } from '../logic/coverImage'
import { useVault } from '../store'
import { useEscLayer } from '../logic/escLayer'
import { IconClose, IconImage } from '../icons'
import type { Asset, AssetFile } from '../../shared/types'

/** 预览用的目标宽度（白名单档位：2048 在 1000px 级画布上足够，4K 档留给后续"高画质"入口） */
const PREVIEW_TARGET_WIDTH = 2048

/**
 * 相机垂直视角。
 *
 * `PerspectiveCamera.fov` 是**垂直**方向，水平视角由「垂直 × 窗口比例」推出来：
 * 面板 `max-w-[1240px]` / 视区高约 658px → 比例 ≈ 1.885，水平 `2·atan(1.885·tan31°) ≈ 97°`。
 * 覆盖全景宽 27%、高 34%，约等效 16mm 超广角。
 *
 * 口径依据：等距柱状投影在画面上下边缘的横向拉伸是 `1/cos(fov/2)`，62° 时 = 1.17×，
 * 与真实广角镜头边缘形变同级；到 90° 就是 1.41×，天顶/地面的极点挤压会露馅。
 * 旧值 40° 只有水平 63.5°（≈29mm），对 VR 全景来说"长焦切片"感太重。
 */
const CAMERA_FOV = 62

/** 相机固定：正对原点、距离 3.4。球不随拖动移动（用户要转的是 HDR，不是球）。 */
const CAMERA_DISTANCE = 3.4

/** 垂直半视角（弧度）。下面所有"屏幕占比 → 世界尺寸"的换算都用它。 */
const HALF_FOV_RAD = (CAMERA_FOV / 2) * (Math.PI / 180)

/**
 * 每颗球的**直径**占视区高度的比例。
 *
 * 单球时代是 20%，但因为公式把"半径占半屏高"当成了"直径占全屏高"，
 * 实际渲染出来直径是视高的 **40%**。两颗并排不能再沿用这个尺寸，收到 24%：
 * 每颗约 158px、并排总宽约 367px（画面宽度的 30%），全景仍是主体。
 *
 * 半径用**球体轮廓的精确关系**反算（近似式 `r = 占比 · d · tan(fov/2)` 当前只差 ~1%，
 * 但以后把 FOV 调大就会悄悄偏大，所以用精确式）：
 * 球半径在屏幕上的半高（半屏高单位）= `tan(θ)/tan(fov/2)`，球的轮廓角 `θ = asin(r/d)`
 * ⇒ `r = d · sin(atan(占比 × tan(fov/2)))`。
 */
const BALL_SCREEN_DIAMETER_RATIO = 0.24

/** 球半径：24% 直径 → 3.4 × sin(atan(0.24 × tan31°)) ≈ 0.485 */
const BALL_RADIUS =
  CAMERA_DISTANCE *
  Math.sin(Math.atan(BALL_SCREEN_DIAMETER_RATIO * Math.tan(HALF_FOV_RAD)))

/** 两球间隙 = 0.35 × 球直径（约 55px），视觉上"一组"但不粘连。 */
const BALL_GAP_RATIO = 0.35

/** 球心横向偏移：两球对称于画面中心，`±r·(1 + 间隙比例)`。 */
const BALL_OFFSET_X = BALL_RADIUS * (1 + BALL_GAP_RATIO)

/**
 * 两颗参考球的材质参数。
 *
 * - **白球**（哑光 rough 0.35）：读光源的**分布与柔和度**，接近白模/石膏的判读方式；
 * - **银球**（纯镜面 metal 1 / rough 0.05，basecolor 略暗于纯白，贴合真实银的反射率）：
 *   读环境的**锐利反射**——太阳位置、地平线、窗格一眼可见。
 *
 * 两者合起来才是"这张 HDR 能不能用"的完整判据，也是产品渲染的标准检查组合。
 */
const WHITE_BALL = { color: 0xffffff, roughness: 0.35, metalness: 0 }
const SILVER_BALL = { color: 0xf2f2f2, roughness: 0.05, metalness: 1 }

/** 视区拖拽灵敏度：每像素多少度。广角下同样 1px 扫过更多内容，收到 0.35 手感更稳。 */
const DRAG_DEG_PER_PX = 0.35

/** 阶段：读源 + 降采样 / 烘焙环境 / 就绪 / 失败 */
type Phase = 'preparing' | 'baking' | 'ready' | 'error'

/** 从资产文件里挑一张可预览的 HDR（优先 .hdr；只有 .exr 时也选，主进程会给出明确"不支持"） */
function pickHdrFile(files: AssetFile[]): AssetFile | null {
  const candidates = files.filter((f) => isHdrExt(f.ext))
  if (candidates.length === 0) return null
  return candidates.find((f) => f.ext.toLowerCase() === 'hdr') ?? candidates[0] ?? null
}

/** 缓存文件绝对路径 → `hdr://<文件名>`（protocol.ts 的 hdr scheme，host 即文件名） */
function hdrVaultUrl(cachedPath: string): string {
  const name = cachedPath.split(/[\\/]/).pop() ?? ''
  return `hdr://${encodeURIComponent(name)}`
}

/** 数值夹取 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 角度归一到 [0, 360) */
function normalizeDeg(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/**
 * 剩余时间文案（纯展示）。
 *
 * 口径：`已耗时 / 已读比例` 线性外推 → 剩余 = 总时长 - 已耗时。
 * - `< 1 秒` → 「马上好」（不给 "剩余 0 秒" 这种别扭文案）
 * - `1~59 秒` → 「剩余约 N 秒」
 * - `≥ 60 秒` → 「剩余约 N 分」
 *
 * 比例太小 / 首帧未到时**不调用**（调用方显示「估算中…」）——宁可不说，也不给假数字。
 */
function formatEta(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs < 1000) return '马上好'
  if (remainingMs < 60_000) return `剩余约 ${Math.max(1, Math.round(remainingMs / 1000))} 秒`
  return `剩余约 ${Math.ceil(remainingMs / 60_000)} 分`
}

interface DeterminateBarProps {
  /** 0..1（主进程"已读字节 / 总字节"） */
  ratio: number
  /** 已读字节（= ratio × 源文件字节） */
  readBytes: number
  /** 源文件字节（asset.files[].size，未知时为 0） */
  totalBytes: number
  /** 剩余时间文案（「估算中…」/「剩余约 2 秒」/「马上好」） */
  eta: string
}

/**
 * 确定性进度：百分比 + 已读/总量 + 剩余时间。
 *
 * 视觉：轨道 `bg-elevated`、填充 `bg-accent`、高 6px、radius-full（对齐产品控件体系）。
 * 百分比 `tabular-nums` 定宽数字，避免 37% → 38% 时整行左右跳。
 */
function DeterminateBar({ ratio, readBytes, totalBytes, eta }: DeterminateBarProps) {
  const pct = Math.min(100, Math.floor(clamp(ratio, 0, 1) * 100))
  return (
    <div className="w-full">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-secondary">正在读取 HDR…</span>
        <span className="shrink-0 text-[12px] font-semibold tabular-nums text-primary">{pct}%</span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="HDR 读取进度"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: `${clamp(ratio, 0, 1) * 100}%` }}
        />
      </div>
      <div className="mt-2 text-[11px] tabular-nums text-tertiary">
        {totalBytes > 0
          ? `已读 ${formatBytes(readBytes)} / ${formatBytes(totalBytes)} · ${eta}`
          : eta}
      </div>
    </div>
  )
}

/**
 * 不确定进度（PMREM 烘焙没有可测进度）。
 *
 * 同一条轨道换成**低对比扫描条**（`styles.css` 末尾追加的 `.hdr-indeterminate-bar`），
 * 靠"在动"表达"还在忙"，**不给百分比**——给了就是骗人。
 */
function IndeterminateBar({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="w-full">
      <div className="mb-2 text-[12px] text-secondary">{label}</div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-elevated"
        role="progressbar"
        aria-label={label}
      >
        <div className="hdr-indeterminate-bar" />
      </div>
      {hint && <div className="mt-2 text-[11px] text-tertiary">{hint}</div>}
    </div>
  )
}

/** 拍照能力（由场景在就绪时交给弹窗；调用方只拿到 capture，拿不到 renderer） */
export interface HdrSceneApi {
  /** 按**当前角度**渲染一帧并返回 PNG（尺寸 = CSS 尺寸 × devicePixelRatio） */
  capture: () => Promise<Blob | null>
  /** 外部（滑块 / 键盘）驱动角度：只落画面，不回传 —— 避免"外部改 → 回传外部"的回环 */
  setAngle: (deg: number) => void
}

interface HdrSceneProps {
  /** `hdr://<key>.hdr` */
  url: string
  /** 视区横向拖拽 → 回传新角度（滑块与画面共用这一个状态） */
  onAngleChange: (deg: number) => void
  /** 环境贴图烘焙完成、第一帧已渲染，交出拍照 / 角度能力 */
  onReady: (api: HdrSceneApi) => void
  onError: (message: string) => void
}

/**
 * HDR 全景背景 + 小白球。
 *
 * 三件事：把 HDR 同时挂到 `scene.background`（看得见）与 `scene.environment`
 * （照得着，经 PMREM 烘焙）、渲染一颗白球、把角度应用到
 * `backgroundRotation` / `environmentRotation`。
 *
 * 场景生命周期严格绑定到挂载（`useEffect(..., [url])`），卸载即全量 dispose。
 */
function HdrScene({ url, onAngleChange, onReady, onError }: HdrSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 回调走 ref：它们变化不该重建 WebGL 上下文（重建 = 闪一下 + 重新解码） */
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const onAngleRef = useRef(onAngleChange)
  onReadyRef.current = onReady
  onErrorRef.current = onError
  onAngleRef.current = onAngleChange

  /** 已经应用到场景的角度（用于识别"外部（滑块）改了角度"） */
  const appliedRef = useRef(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.cursor = 'grab'
    canvas.style.touchAction = 'none'
    host.appendChild(canvas)

    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
    } catch (err) {
      console.warn('[HdrPreview] WebGL 上下文创建失败：', err)
      canvas.remove()
      onErrorRef.current('WebGL 不可用，无法预览（请检查显卡驱动）')
      return
    }
    // `preserveDrawingBuffer: true` 是**拍照**的硬要求：`toBlob()` 必须在绘制缓冲还在时
    // 读取，否则可能拍到一张全黑（这是"拍了但封面是黑的"最常见的原因）。预览器是按需
    // 渲染（静止不跑 rAF），这点开销可以接受。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1

    const scene = new Scene()
    const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100)
    camera.position.set(0, 0, CAMERA_DISTANCE)
    camera.lookAt(0, 0, 0)

    // ── 两颗参考球：左白（哑光，看光分布）/ 右银（镜面，看环境反射） ──
    // 96×64 分段（高光边缘不出多边形），几何体两球共享，material 各自独立
    const geometry = new SphereGeometry(BALL_RADIUS, 96, 64)
    const whiteMaterial = new MeshStandardMaterial(WHITE_BALL)
    const silverMaterial = new MeshStandardMaterial(SILVER_BALL)
    const whiteBall = new Mesh(geometry, whiteMaterial)
    whiteBall.position.set(-BALL_OFFSET_X, 0, 0)
    const silverBall = new Mesh(geometry, silverMaterial)
    silverBall.position.set(BALL_OFFSET_X, 0, 0)
    scene.add(whiteBall)
    scene.add(silverBall)

    let disposed = false
    let pmrem: PMREMGenerator | null = null
    let envRT: WebGLRenderTarget | null = null
    /** 源 HDR（背景直接用它，不能像以前那样烘完就 dispose） */
    let sourceTexture: Texture | null = null
    let frame = 0

    /** 按需渲染：静止时不烧 GPU；角度变化 / 首帧 / resize 才画 */
    const requestRender = (): void => {
      if (disposed || frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (disposed) return
        renderer.render(scene, camera)
      })
    }

    /**
     * 应用角度：**背景与光照必须同一个角度**。
     *
     * - `scene.backgroundRotation` 让全景图绕 Y 轴转（用户看到 HDR 在动）；
     * - `scene.environmentRotation` 让 IBL 光照同向转（球上的高光跟着动）。
     * 两者不同步的话，球的高光和背后的太阳会对不上，用户一眼能看出来。
     */
    const applyAngle = (deg: number): void => {
      const rad = (normalizeDeg(deg) * Math.PI) / 180
      appliedRef.current = normalizeDeg(deg)
      scene.backgroundRotation.set(0, rad, 0)
      scene.environmentRotation.set(0, rad, 0)
      requestRender()
    }

    // ── 视区横向拖拽 = 旋转 HDR（与滑块双向同步） ────────────────────
    let dragging = false
    let lastX = 0
    let activePointer: number | null = null

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      dragging = true
      activePointer = e.pointerId
      lastX = e.clientX
      canvas.style.cursor = 'grabbing'
      canvas.setPointerCapture(e.pointerId)
    }
    const onPointerMove = (e: PointerEvent): void => {
      if (!dragging || activePointer !== e.pointerId) return
      const dx = e.clientX - lastX
      lastX = e.clientX
      if (dx === 0) return
      // 先落到画面上（不等 React 状态回环 → 拖起来不糊），再回传父组件同步滑块
      const next = normalizeDeg(appliedRef.current + dx * DRAG_DEG_PER_PX)
      applyAngle(next)
      onAngleRef.current(next)
    }
    const endDrag = (e: PointerEvent): void => {
      if (activePointer !== null && e.pointerId !== activePointer) return
      dragging = false
      activePointer = null
      canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)

    // ── 尺寸（拍照分辨率 = CSS 尺寸 × dpr，不是 CSS 像素——否则拍出来是糊的） ──
    const fit = (): void => {
      const rect = host.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      requestRender()
    }
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()

    // ── HDR：背景（看得见）+ PMREM（照得着） ─────────────────────────
    const loader = new HDRLoader()
    loader.load(
      url,
      (texture) => {
        if (disposed) {
          texture.dispose()
          return
        }
        sourceTexture = texture
        texture.mapping = EquirectangularReflectionMapping
        // 全景直接当背景：用户要"看见 HDR 的图"，不是只看球上的反射
        scene.background = texture
        try {
          pmrem = new PMREMGenerator(renderer)
          envRT = pmrem.fromEquirectangular(texture)
          scene.environment = envRT.texture
        } catch (err) {
          console.warn('[HdrPreview] PMREM 烘焙失败：', err)
          onErrorRef.current('环境贴图烘焙失败（显存不足？）')
          return
        } finally {
          pmrem?.dispose()
          pmrem = null
        }
        applyAngle(appliedRef.current)
        renderer.render(scene, camera)
        onReadyRef.current({
          // 外部（滑块）驱动：只改画面，不回传 —— 回传会与父组件的 state 形成回环
          setAngle: applyAngle,
          capture: async () => {
            if (disposed) return null
            // ⚠️ 必须先按当前角度渲染一帧：否则可能拍到上一帧（用户转完马上点拍照）
            applyAngle(appliedRef.current)
            renderer.render(scene, camera)
            return await new Promise<Blob | null>((resolve) => {
              canvas.toBlob((blob) => resolve(blob), 'image/png')
            })
          }
        })
      },
      undefined,
      (err) => {
        if (disposed) return
        console.warn('[HdrPreview] HDR 缓存加载失败：', url, err)
        onErrorRef.current('HDR 缓存读取失败（缓存可能已被清理，请重试）')
      }
    )

    return () => {
      disposed = true
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endDrag)
      canvas.removeEventListener('pointercancel', endDrag)
      // 全量 dispose：背景纹理 / 环境 RT / 几何 / 材质 / 渲染器 / 上下文
      scene.environment = null
      scene.background = null
      sourceTexture?.dispose()
      envRT?.dispose()
      pmrem?.dispose()
      scene.remove(whiteBall, silverBall)
      // 几何体由两球共享：只能 dispose 一次；材质各自独立，逐个释放
      geometry.dispose()
      whiteMaterial.dispose()
      silverMaterial.dispose()
      renderer.dispose()
      // Chromium 活跃 WebGL 上下文约 8-16 个：只 dispose 不 loseContext 回收滞后
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [url])

  return <div ref={hostRef} className="h-full w-full" />
}

export interface HdrPreviewDialogProps {
  asset: Asset
  onClose: () => void
}

/**
 * HDR 预览弹窗。
 *
 * 阶段：
 * 1. `preparing`：主进程流式解码源 HDR，**确定性**进度条（已读字节/总字节）；
 *    命中缓存时主进程立即返回 → 不显示进度条，直接进 2；
 * 2. `baking`：PMREM 烘焙 + 首帧渲染，**不确定**进度条（不可测，不假装百分比）；
 * 3. `ready`：全景 + 白/银两颗参考球 + 滑块 + 拍照。
 */
export function HdrPreviewDialog({ asset, onClose }: HdrPreviewDialogProps) {
  const setCoverFromImage = useVault((s) => s.setCoverFromImage)
  const setNotice = useVault((s) => s.setNotice)

  const file = useMemo(() => pickHdrFile(asset.files), [asset.files])
  const srcPath = useMemo(
    () => (file ? assetFileAbs(asset.folder, file.rel) : ''),
    [asset.folder, file]
  )
  /** 源文件字节数（进度条的"总量"）：直接取资产索引里的 size，不需要额外 IPC */
  const totalBytes = file?.size ?? 0

  const [phase, setPhase] = useState<Phase>('preparing')
  const [ratio, setRatio] = useState<number | null>(null)
  /** 首个进度事件之前 / 命中缓存：一律不画进度条（避免闪一下 0% 或假进度） */
  const [showProgress, setShowProgress] = useState(false)
  const [readBytes, setReadBytes] = useState(0)
  const [eta, setEta] = useState('估算中…')
  const [reason, setReason] = useState('')
  const [url, setUrl] = useState('')
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [sourceDims, setSourceDims] = useState<{ width: number; height: number } | null>(null)

  /** 当前旋转角（度）。滑块与视区拖拽共用这一份状态 → 天然双向同步。 */
  const [angleDeg, setAngleDeg] = useState(0)
  /** 最近一次角度（`handleReady` 是稳定回调，读 ref 拿最新值） */
  const angleRef = useRef(0)
  angleRef.current = angleDeg
  /** 拍照能力（场景就绪时给） */
  const sceneApiRef = useRef<HdrSceneApi | null>(null)
  const [shooting, setShooting] = useState(false)
  const [shotDone, setShotDone] = useState(false)
  const shotTimerRef = useRef(0)

  /** 计时起点（算剩余时间用）：点开预览这一刻，含 IPC 往返 */
  const startedAtRef = useRef(0)
  /** 进度事件的**渲染层节流**：主进程按 1MB/块推，大文件能到 ~100 次/秒；这里压到 ~10 次/秒 */
  const lastUiRef = useRef({ ratio: -1, at: 0 })
  /** 「200ms 后仍没拿到产物 → 显示进度条」的定时器（命中缓存时不显示） */
  const revealTimerRef = useRef<number | null>(null)

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }
  }, [])

  /**
   * Esc 关闭（0.7.6 T-ESC）。
   *
   * 本弹窗是自绘 `dialog-scrim`、不走 `Modal`，但同样占一层：`useEscLayer` 挂在
   * **捕获阶段**且只在栈顶时消费按键 —— 这样"后开的先吃"对预览也成立
   * （预览开着时导入重复处置弹出来，Esc 先答重复处置；反过来说预览最后才关）。
   * 以前这里是一条冒泡阶段的 window 监听，靠 App 里对 `hdrPreviewAssetId` 让路来避免
   * 一次按键关两层；现在由栈统一表达，App 那一支只作为兜底。
   */
  useEscLayer(onClose, true)

  // ── 准备阶段：订阅进度 → prepareHdr → 拿到 hdr:// URL ───────────────
  useEffect(() => {
    if (!srcPath) {
      setPhase('error')
      setReason('这个资产里没有 .hdr 文件')
      return
    }
    let alive = true
    lastUiRef.current = { ratio: -1, at: 0 }

    // 先订阅再发请求：否则解码前几个 chunk 的进度会丢
    const unsubscribe = window.modvault.onHdrProgress((ev) => {
      // ★ 必须按 path 过滤：并发准备多个 HDR 时，别的资产的进度不能刷到这条进度条上
      if (!alive || ev.path !== srcPath) return
      const r = clamp(ev.ratio, 0, 1)
      const now = Date.now()
      const last = lastUiRef.current
      // 节流：<0.4% 且 <90ms 的更新直接丢（1 除外——必须让用户看到 100%）
      if (r < 1 && r - last.ratio < 0.004 && now - last.at < 90) return
      lastUiRef.current = { ratio: r, at: now }

      setShowProgress(true)
      clearRevealTimer()
      setRatio(r)
      if (totalBytes > 0) setReadBytes(Math.round(r * totalBytes))
      // 剩余时间：比例太小 / 刚起步时不给数字（「估算中…」）
      const elapsed = now - startedAtRef.current
      if (r > 0.02 && elapsed > 350) {
        setEta(formatEta(elapsed / r - elapsed))
      }
    })

    setPhase('preparing')
    setRatio(null)
    setShowProgress(false)
    setReadBytes(0)
    setEta('估算中…')
    setReason('')
    // 换资产（同一实例复用时）回到 0°：否则新图会继承上一张的角度，用户会以为图是歪的
    setAngleDeg(0)
    startedAtRef.current = Date.now()
    // 200ms 兜底：命中缓存时 prepareHdr 会在这之前返回 → 进度条永不出现；
    // 慢盘/首帧前则 200ms 后先给一条 0% 的轨道（有"正在读取"的心理预期，不是黑屏）。
    revealTimerRef.current = window.setTimeout(() => setShowProgress(true), 200)

    void (async () => {
      const res = await window.modvault.prepareHdr(srcPath, PREVIEW_TARGET_WIDTH).catch(
        (err: unknown) => ({
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err)
        })
      )
      if (!alive) return
      if (!res.ok) {
        clearRevealTimer()
        setPhase('error')
        setReason(res.reason)
        return
      }
      clearRevealTimer()
      setDims({ width: res.width, height: res.height })
      if (res.sourceWidth && res.sourceHeight) {
        setSourceDims({ width: res.sourceWidth, height: res.sourceHeight })
      }
      setUrl(hdrVaultUrl(res.cachedPath))
      // 缓存命中：**不显示**进度条（没读过源文件，也就没有"已读字节"可报）
      if (res.fromCache) {
        setRatio(null)
        setShowProgress(false)
      } else {
        setRatio(1)
        setReadBytes(totalBytes)
      }
      setPhase('baking')
    })()

    return () => {
      alive = false
      clearRevealTimer()
      unsubscribe()
    }
  }, [srcPath, totalBytes, clearRevealTimer])

  // 拍照成功的按钮态 2.5s 后复位（定时器要清，避免卸载后 setState）
  useEffect(() => {
    return () => {
      if (shotTimerRef.current) window.clearTimeout(shotTimerRef.current)
    }
  }, [])

  const handleReady = useCallback((api: HdrSceneApi) => {
    sceneApiRef.current = api
    // 烘焙期间用户可能已经拖过画面（角度已进 state）→ 就绪瞬间按当前角度补一次
    api.setAngle(angleRef.current)
    setPhase('ready')
  }, [])
  const handleSceneError = useCallback((message: string) => {
    setPhase('error')
    setReason(message)
  }, [])

  /**
   * 滑块 / 键盘改角度 → 交给场景。
   *
   * 拖拽路径是反过来的（场景先落画面、再回传 state），这里只处理"外部驱动"：
   * 场景的 `setAngle` 不回传，所以不会形成 effect ↔ state 的回环。
   */
  useEffect(() => {
    sceneApiRef.current?.setAngle(angleDeg)
  }, [angleDeg])

  /**
   * 拍照 → 设为封面。
   *
   * 走的是**既有封面链路**（与 CoverPicker / DetailPanel 封面拖入完全同一条）：
   * `canvas.toBlob()` → `File` → `coverImageInputOf()`（拿不到文件路径 → 退化为 base64
   * `source:'clipboard'`）→ `store.setCoverFromImage()` → IPC 写盘 `<资产名>.cover.png`
   * → `commitCover`（coverSource='manual' + 缩略图重生）。
   * **绝不新写落盘路径**：那会把"封面文件名规则 / files 合并 / def-z8 写入锁"复制一份。
   */
  const onShoot = async (): Promise<void> => {
    const api = sceneApiRef.current
    if (!api || shooting) return
    if (phase !== 'ready') {
      setNotice('画面还没准备好，请稍候再拍')
      return
    }
    setShooting(true)
    try {
      const blob = await api.capture()
      if (!blob) {
        setNotice('拍照失败：当前画面不可用，请重试')
        return
      }
      const name = `${asset.name}-预览.png`
      const shot = new File([blob], name, { type: 'image/png' })
      const input = await coverImageInputOf(shot)
      if (!input) {
        setNotice('拍照失败：生成的图片无法读取')
        return
      }
      // 失败时 store 自己会置 notice（"封面设置失败：仅支持 PNG/JPEG 且不超过 20MB…"）
      const ok = await setCoverFromImage(asset.id, input)
      if (!ok) return
      setNotice('已设为封面')
      setShotDone(true)
      if (shotTimerRef.current) window.clearTimeout(shotTimerRef.current)
      shotTimerRef.current = window.setTimeout(() => setShotDone(false), 2500)
    } catch (err) {
      console.warn('[HdrPreview] 拍照失败：', err)
      setNotice(`拍照失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setShooting(false)
    }
  }

  const resolutionText = dims
    ? sourceDims
      ? `源 ${sourceDims.width} × ${sourceDims.height} · 预览 ${dims.width} × ${dims.height}`
      : `预览 ${dims.width} × ${dims.height}`
    : ''
  const ready = phase === 'ready'

  return (
    <div
      className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`HDR 预览：${asset.name}`}
      onPointerDown={(e) => {
        // 点遮罩关闭（弹窗本体 stopPropagation）
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* `data-theme="dark"`：预览器是**恒深色视口**（白球在浅底上会消失，HDR 全景本身
          就是"屏幕"）。把深色 token 的作用域收在这一层 —— 应用外壳是浅色还是深色，
          这里的 `bg-elevated / bg-canvas / text-secondary / text-tertiary / border`
          都解析成深色档，不需要任何写死的 hex。遮罩仍跟随应用主题（`.dialog-scrim`）。 */}
      <div
        data-theme="dark"
        className="flex h-[min(84vh,780px)] w-full max-w-[1240px] flex-col overflow-hidden rounded-modal border border-line bg-canvas shadow-modal"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 顶部：HDR 名 + 分辨率 */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-primary" title={asset.name}>
              {asset.name}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-secondary">
              {resolutionText || (file ? file.name : '')}
            </div>
          </div>
          <button
            className="shrink-0 rounded-lg border border-line bg-elevated p-1.5 text-secondary transition hover:text-primary"
            onClick={onClose}
            title="关闭（Esc）"
          >
            <IconClose />
          </button>
        </div>

        {/* 主视区：HDR 全景背景 + 白/银两颗参考球。深色底只在首帧前可见。 */}
        <div className="relative min-h-0 flex-1 bg-render-canvas">
          {phase === 'ready' || phase === 'baking' ? (
            <HdrScene
              url={url}
              onAngleChange={setAngleDeg}
              onReady={handleReady}
              onError={handleSceneError}
            />
          ) : null}

          {/* 阶段遮罩：准备 / 烘焙 / 错误。内容竖向居中，最大宽 360 */}
          {!ready && (
            <div className="absolute inset-0 flex flex-col items-center justify-center px-8">
              <div className="w-full max-w-[360px]">
                {phase === 'preparing' &&
                  (showProgress && ratio !== null ? (
                    <DeterminateBar
                      ratio={ratio}
                      readBytes={readBytes}
                      totalBytes={totalBytes}
                      eta={eta}
                    />
                  ) : (
                    // 首帧前 / 命中缓存：不画轨道，只给一句话（绝不闪一下 0%）
                    <div className="text-[12px] text-secondary">正在准备 HDR…</div>
                  ))}
                {phase === 'baking' && (
                  <IndeterminateBar
                    label="正在烘焙环境…"
                    hint="首次打开需要几秒；之后会直接进入"
                  />
                )}
                {phase === 'error' && (
                  <div className="text-center">
                    <p className="text-[13px] font-medium text-primary">预览打不开</p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-secondary">
                      {reason || '未知错误'}
                    </p>
                    <button
                      className="mt-4 rounded-btn border border-line bg-elevated px-3 py-1.5 text-[12px] text-secondary transition hover:text-primary"
                      onClick={onClose}
                    >
                      关闭
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部：360° 滑块 + 拍照。控制条常驻（就绪前后同一套布局，避免画面出来时跳一下），
            未就绪时整体降透明度 + 禁用；提示文案只在 ready 后出现。 */}
        <div className="shrink-0 border-t border-line px-5 py-3">
          <div className={`flex items-center gap-3 ${ready ? '' : 'opacity-40'}`}>
            <span className="shrink-0 text-[11px] text-secondary">旋转</span>
            <div className="relative h-6 min-w-0 flex-1">
              {/* 轨道：token 画，不用原生控件裸奔 */}
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-75"
                  style={{ width: `${(angleDeg / 360) * 100}%` }}
                />
              </div>
              {/* 原生 input 只负责交互 / 键盘 / 无障碍，视觉全由上面的轨道承担 */}
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={Math.round(angleDeg)}
                disabled={!ready}
                aria-label="旋转 HDR 全景"
                onChange={(e) => setAngleDeg(normalizeDeg(Number(e.target.value)))}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed
                  [&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent
                  [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent
                  [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:transition-transform
                  [&::-webkit-slider-thumb]:hover:scale-110"
              />
            </div>
            <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-primary">
              {Math.round(angleDeg)}°
            </span>
            <button
              className="btn btn-primary shrink-0 !h-8 !px-3 text-[12px]"
              disabled={!ready || shooting}
              onClick={() => void onShoot()}
              title="把当前画面设为这个 HDR 资产的封面（卡片预览图）"
            >
              <IconImage width={13} height={13} />
              {shooting ? '拍照中…' : shotDone ? '已设为封面' : '拍照'}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-tertiary">
            <span aria-hidden={!ready} className={ready ? 'text-tertiary' : 'invisible'}>
              拖动画面或滑块，360° 旋转 HDR
            </span>
            <span className="tabular-nums">Esc 关闭</span>
          </div>
        </div>
      </div>
    </div>
  )
}
