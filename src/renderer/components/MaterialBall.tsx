/**
 * T09 材质球组件（three.js）——用户拍板的实时可拖拽材质预览。
 *
 * 形态（docs/10 §1.4，用户拍板）：
 * - **网格**用离屏渲染存的**透明 PNG** 当缩略图（`renderBallToPng` 产出，走既有
 *   thumbs 管线；透明背景 → 卡片 `bg-canvas` 透出来，深浅主题同一个缓存都正确）；
 * - **详情面板**保留本组件（实时球，OrbitControls 可拖拽）——绕开 Chromium
 *   WebGL 上下文 8-16 上限：网格不开 WebGL，只有详情区开。
 *
 * ⚠️ 本组件**未接线**到任何现有界面（DetailPanel 由另一名工程师改造中）。
 * 接入方式见文件末尾注释与 docs/04 §T09。
 *
 * 2026-10 用户反馈第 3 条（需求书 §3.3）：内置**调参渲染**——
 * 「自定义渲染」面板（默认收起）提供反光强度 / 凹凸强度两个滑块实时预览，
 * 可「保存为封面」（离屏渲一帧带参 JPG → 既有 `asset:setCoverImage` IPC 落盘）。
 * 保存按钮需调用方传 `onSaveAsCover`（落盘胶水见文件末尾注释）；不传只隐藏保存按钮。
 *
 * ✅ 贴图加载的 CORS 阻塞点**已修复**（2026-10，任务 #19）：
 * 主进程 `serveVault`（src/main/protocol.ts）现在带 `corsEnabled: true` +
 * `Access-Control-Allow-Origin` 响应头，vault:// 贴图可正常上传（TextureLoader
 * 仍走 crossOrigin=anonymous）。以下为**历史记录**，保留说明踩坑过程：
 *   早期 serveVault 直接 net.fetch(file://…) 返回响应、不带 ACAO 头，vault:// 对渲染
 *   进程是跨源协议 → WebGL 上传跨源贴图被 CORS 拦。当时的兜底：单张贴图加载失败只
 *   console.warn 并保持该槽位默认灰（不白屏），并可用 props.textureUrls 覆盖 URL 绕过。
 *   这条兜底**仍然保留**（网络/磁盘异常同样会失败），只是不再是必经路径。
 *
 * 导入纪律：three 主包用**命名导入**（package.json sideEffects 只标记了
 * src/nodes，命名导入可让 rollup 摇掉 WebGPU/TSL 等用不到的代码，
 * 实测比 `import * as THREE` 少进 bundle 约 500KB）。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import {
  Color,
  Mesh,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Texture,
  TextureLoader,
  WebGLRenderer
} from 'three'
import type { BufferGeometry, Object3D } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

/**
 * 参数落库防抖窗口（docs/12 §5.1 第 3 条）：滑块 `onChange` 每帧触发，
 * 不防抖 → 每帧一次 `db.assets.put` + 一次 WebGL 重渲。400ms 静默窗口足够。
 * 与 `CustomRenderDialog.tsx` 同口径（两处滑块必须同一个窗口）。
 */
const PARAM_PERSIST_DEBOUNCE_MS = 400
import {
  DEFAULT_PARAM_SCALES,
  READBACK_CONTEXT_OPTIONS,
  SLOT_ORDER,
  ParamScaleState,
  applyMaterialParams,
  applyUvRepeat,
  decodeTextureBitmap,
  effectiveUvRepeat,
  normalizeParams,
  planTextureDecode,
  slotUrls,
  synthNormalSize,
  uvAspectOf,
  type BallParamScales,
  type MaterialParamValues,
  type MaterialSlotKey,
  type MaterialSlots,
  type MaterialSlotUrls,
  type ParamBasisPatch
} from '../logic/materialBall'
import { ballCameraPosition } from '../logic/ballCamera'
import type { NormalizedBallParams } from '../../shared/ballParams'
import { AlphaMapToggles } from './AlphaMapToggles'
import {
  bitmapBytes,
  formatBitmapCacheStats,
  textureBitmapCache
} from '../logic/textureBitmapCache'
import { TexturePool, formatTexturePoolStats, texturePoolKey } from '../logic/texturePool'
import { currentMotionProfile, subscribeMotionProfile } from '../logic/motionProfile'
import type { MotionProfile } from '../../shared/motionQuality'

/** 预览形态：球（默认）/ 平面（平铺接缝检查）/ 圆角盒 */
export type BallShape = 'sphere' | 'plane' | 'roundedBox'

const SHAPE_ORDER: readonly BallShape[] = ['sphere', 'plane', 'roundedBox']

const SHAPE_LABEL: Record<BallShape, string> = {
  sphere: '球',
  plane: '平面',
  roundedBox: '盒'
}

/** 平面形态的平铺重复倍数（设计师验材质要看接缝，docs/10 §1.4） */
const PLANE_REPEAT = 2

/**
 * 离屏 JPG 背景色（v0.2.1 增补 1，覆盖 §3.7）：**主题化**，读 `--render-canvas-bg`
 * ——浅色 `#FFFFFF` / 深色 `#1C1C1E`。
 *
 * ⚠️ 2026-10-23 起**封面不再走 JPEG**（用户拍板：封面一律透明 PNG）。这个色现在只服务
 * `renderBallToJpeg`（带底输出的遗留能力）。**球图缩略图与封面都不走这里**——
 * 它们都是透明 PNG（`renderBallToPng`），背景由卡片 `bg-canvas` 提供。
 */
export function paperColor(): string {
  if (typeof document === 'undefined') return '#ffffff'
  const v = getComputedStyle(document.documentElement).getPropertyValue('--render-canvas-bg').trim()
  return v.length > 0 ? v : '#ffffff'
}

/**
 * 离屏渲染的**背景决策**（纯函数，可单测）——把「格式 → 要不要背景」这条规则
 * 从 `renderBallBlob` 里抽出来，避免它再被误改成硬编码黑。
 *
 * - `'png'` → **恒为 `undefined`**（不是空串！`BallScene` 靠 `undefined` 判定
 *   `alpha:true` + 清屏色 0 → 透明画布）。球图缩略图只认这条；
 * - `'jpeg'` → 调用方显式给的色，否则 `paperColor()`（读 `--render-canvas-bg`：
 *   浅色 `#FFFFFF` / 深色 `#1C1C1E`）。**绝不回落成 `#000000`**——纯黑在浅色主题下
 *   是一块突兀的黑方块，也不是设计口径（v0.2.1 增补 1）。
 *
 * 空白串 / 非字符串同样按"没传"处理（`trim()` 后判空），免得把 `'   '` 交给
 * `THREE.Color` 解析出黑。
 */
export function resolveBallBackground(
  format: 'jpeg' | 'png',
  background?: string
): string | undefined {
  if (format === 'png') return undefined
  const explicit = typeof background === 'string' ? background.trim() : ''
  return explicit.length > 0 ? explicit : paperColor()
}

/** 槽位 → MeshPhysicalMaterial 贴图属性（显式 switch，类型安全） */
function assignMap(
  material: MeshPhysicalMaterial,
  slot: MaterialSlotKey | 'alpha',
  tex: Texture
): void {
  switch (slot) {
    case 'albedo':
      material.map = tex
      break
    case 'normal':
      material.normalMap = tex
      break
    case 'roughness':
      material.roughnessMap = tex
      break
    case 'ao':
      material.aoMap = tex
      break
    case 'displacement':
      material.displacementMap = tex
      break
    // 0.7.6：灰度透明的 alphaMap。**它不是 PBR 槽位**（PbrSlot 一个字都不动），
    // 只是把 albedo 同一张图再挂一份到材质上（见 applyMaps 的 entries 收集）。
    case 'alpha':
      material.alphaMap = tex
      break
  }
}

/** 清空材质上的全部槽位贴图（换贴图 / dispose 前调用） */
function clearMaps(material: MeshPhysicalMaterial): void {
  material.map = null
  material.normalMap = null
  material.roughnessMap = null
  material.aoMap = null
  material.displacementMap = null
  // ⚠️ 漏这行 = 换资产后 USE_ALPHAMAP 这个 define 还指着上一批已 dispose 的纹理
  // → 采样到空纹理，球直接变黑（而且是"有时黑、有时正常"的偶发 bug）。
  material.alphaMap = null
}

/**
 * 0.7.6「按贴图灰度做透明」的 shader 补丁 —— 替换掉 three 原生的
 * `#include <alphamap_fragment>`（原生实现见
 * `ShaderChunk/alphamap_fragment.glsl.js`：`diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).g`）。
 *
 * 两处刻意的偏离：
 * 1. **取亮度而不是绿通道**：three 取 `.g` 是从"alphaMap 是数据图"的惯例来的；
 *    用户要的是"识别灰度"，彩色贴图（砖红、木纹）按亮度算才符合直觉。
 *    Rec.709 权重（0.2126/0.7152/0.0722）是 sRGB 下公认的感知亮度口径。
 * 2. **反转由 uniform 切换**，不做成两套 shader / 不写死 `#define`：
 *    `setAlphaInvert()` 在已编译时**只写 uniform**，拖动/勾选不会触发重编译
 *    （重编译是几百毫秒级的卡顿，交互路径上绝对不能有）。
 *
 * 整个块包在 `#ifdef USE_ALPHAMAP` 里 —— 没开灰度图 / 没有 albedo 的资产，
 * 这段代码连同 define 一起不存在，成像**一个像素都不变**（RENDER_REV 不 +1 的依据）。
 *
 * ⚠️ 这段字符串**只能写 ASCII**（连注释都不要写中文）：它是直接拼进 GLSL 源码的，
 * 部分 ANGLE/驱动对源码里的非 ASCII 字节不宽容。解释写在 TypeScript 注释里。
 */
const ALPHA_MAP_FRAGMENT_PATCH = `#ifdef USE_ALPHAMAP
	float alphaLum = dot( texture2D( alphaMap, vAlphaMapUv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	diffuseColor.a *= mix( alphaLum, 1.0 - alphaLum, uAlphaInvert );
#endif`

/** 形态 → 几何体 */
function createGeometry(shape: BallShape): BufferGeometry {
  switch (shape) {
    case 'sphere':
      return new SphereGeometry(1, 128, 64)
    case 'plane':
      return new PlaneGeometry(2.2, 2.2, 1, 1)
    case 'roundedBox':
      return new RoundedBoxGeometry(1.5, 1.5, 1.5, 6, 0.32)
  }
}

/** 递归释放场景图里的 geometry / material（RoomEnvironment 用后即弃） */
function disposeObjectTree(root: Object3D): void {
  root.traverse((obj) => {
    const node = obj as Mesh
    node.geometry?.dispose()
    const mat = node.material
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else mat?.dispose()
  })
}

/**
 * rAF 循环控制器（可注入调度函数，因此能在 node 里单测）。
 *
 * 为什么单独抽出来：舞台要求「隐藏时暂停 rAF，但**绝不 dispose 上下文**」——
 * 这两件事必须能分别验证。stop() 只 cancelAnimationFrame，不碰 renderer。
 */
export class FrameLoop {
  private id = 0

  constructor(
    private readonly schedule: (cb: () => void) => number = (cb) =>
      window.requestAnimationFrame(() => cb()),
    private readonly cancel: (id: number) => void = (id) => window.cancelAnimationFrame(id)
  ) {}

  get running(): boolean {
    return this.id !== 0
  }

  start(tick: () => void): void {
    if (this.id !== 0) return
    const step = (): void => {
      // stop() 之后可能还有一次在途回调：这里再判一次，避免「停了又自己转起来」
      if (this.id === 0) return
      this.id = this.schedule(step)
      tick()
    }
    this.id = this.schedule(step)
  }

  stop(): void {
    if (this.id !== 0) this.cancel(this.id)
    this.id = 0
  }
}

/** 姿势目标：只写 z 轴缩放（压扁 ↔ 鼓满），纯函数便于单测 */
export interface PoseTarget {
  scale: { z: number }
}

export const POSE_MIN_Z = 0.04
export const POSE_MAX_Z = 1.6

export function applyPose(target: PoseTarget, z: number): number {
  const next = Number.isFinite(z) ? Math.min(POSE_MAX_Z, Math.max(POSE_MIN_Z, z)) : 1
  target.scale.z = next
  return next
}

/** 自转开关：只改 controls.autoRotate（不重建场景，桩测即可验证） */
export function applyAutoRotate(controls: { autoRotate: boolean } | null, on: boolean): void {
  if (controls) controls.autoRotate = on
}

interface BallSceneOptions {
  shape: BallShape
  /** true = 可拖拽（OrbitControls + 持续 rAF 渲染）；false = 离屏单帧 */
  interactive: boolean
  /** 离屏渲染边长（像素）；交互模式由 resize() 驱动，忽略此项 */
  size?: number
  /**
   * 背景色（CSS 颜色串）。传了 = 不透明背景（离屏 JPG 用，配纸色）；
   * 不传 = 透明画布（实时组件用，透出容器 CSS 背景）。
   */
  background?: string
  /** 离屏渲染必须 true，否则 canvas.toBlob 取不到绘制缓冲区 */
  preserveDrawingBuffer?: boolean
  /** 是否持续自转（默认 true；舞台/单击生成的静止球传 false） */
  autoRotate?: boolean
  /**
   * 调参渲染（2026-10 用户反馈第 3 条，需求书 §3.3）：反光 / 凹凸倍率。
   * 不传 = 默认 1 倍（与未加调参前完全一致）。
   *
   * ⚠️ 组件侧不能只依赖"构造时传参"：建场景 effect 的 deps 是 `[]`，而组件里
   * `[scales]` 的同步 effect 声明在它**之前**（挂载时先跑，那时 ballRef 还是 null）。
   * 所以组件在建完后还会立刻 `ball.setParamScales(scalesRef.current)` ——
   * 详见 `MaterialBall` 的建场景 effect（P1 首帧缺陷修复）。
   */
  params?: BallParamScales
}

/**
 * 环境贴图**全进程共享**（性能修复 A）。
 *
 * RoomEnvironment + PMREM 烘焙与材质无关，却曾被每个 BallScene 各烘一遍：
 * 舞台球、右栏球、离屏缩略图、hover 预热各建一次 —— 一次划卡能烘十几次。
 * 这里按 renderer 缓存：同一张 WebGL 上下文只烘一次，纹理跟着 renderer 的生命周期走。
 *
 * ⚠️ 销毁纪律：**共享 envMap 不随单个 BallScene.dispose() 释放**。它被多个场景引用，
 * 谁先析构谁就可能把别人的球变成白球。真正的释放点是 renderer.dispose() /
 * forceContextLoss()（GPU 资源随上下文一起归还）。**后来者请勿顺手补一个 dispose()**。
 */
const sharedEnvCache = new WeakMap<WebGLRenderer, Texture>()

function sharedEnvironment(renderer: WebGLRenderer): Texture {
  const hit = sharedEnvCache.get(renderer)
  if (hit) return hit
  const pmrem = new PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const rt = pmrem.fromScene(room, 0.04)
  pmrem.dispose()
  disposeObjectTree(room) // PMREM 已烘焙完，房间场景可以扔了
  sharedEnvCache.set(renderer, rt.texture)
  return rt.texture
}

/**
 * 贴图降采样上限（性能修复 B）。
 *
 * 球在界面上最大 459×459（实测 canvas 459、CSS 306），把 4K/8K 原图整个解码再上传
 * 纯属浪费：4K→1024 是 16 倍像素差，显存与首次上传都按这个比例下降。
 * 1024 在 459px 的球上仍有 2 倍余量，近看不会糊。
 */
const MAX_TEX_PX = 1024

/**
 * 合成法线的采样尺寸（性能修复 B：**384 → 256**）。
 *
 * 尺寸与"为什么 256 够用"的完整依据见 `logic/materialBall.ts` 的
 * `SYNTH_NORMAL_SIZE_PX`（低频信息 + uv 放大后仍然过采样）。
 * 这里只保留强度：用户明确说过渲染出来油腻不好，所以保守。
 */
const SYNTH_NORMAL_SCALE = 0.32

/**
 * 材质底色（"陶土球"中性灰）。
 *
 * 有 albedo 时底色会被让成纯白（贴图是乘法着色），所以它必须能**按资产复位**：
 * 复用同一个 BallScene 换资产时，不复位就会把上一个资产的纯白底色带给下一个
 * 没有 albedo 的资产（旧实现每次新建场景，天生就复位了）。
 */
const BASE_COLOR = 0xb9b6b0

/**
 * 用 albedo 的亮度梯度估一张法线图（Sobel）。
 *
 * 为什么有效：贴图本身就是"表面起伏"的照片 —— 砖缝更暗、凹凸处有明暗过渡，
 * 亮度梯度方向≈表面法线的水平分量。对砖 / 木 / 混凝土这类漫反射材质尤其像，
 * 对金属/玻璃会过度解释（所以强度保守，且只在该槽位**缺失**时启用）。
 * 数据图保持线性色彩空间，与 normal/roughness 槽位同纪律。
 */
function normalFromBitmap(bitmap: CanvasImageSource & { width: number; height: number }): Texture | null {
  try {
    // 采样尺寸 384 → 256（性能修复 B）：依据见 logic/materialBall.ts 的 SYNTH_NORMAL_SIZE_PX
    const { w, h } = synthNormalSize(bitmap.width, bitmap.height)
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    // ★ willReadFrequently 必须显式声明：下面要 getImageData 同步回读。
    //   不声明时 Chromium 把画布放 GPU 上，回读要等一次 GPU→CPU 同步拷贝（实测 30.7ms）。
    const ctx = cv.getContext('2d', READBACK_CONTEXT_OPTIONS)
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const src = img.data
    const lum = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      lum[i] = (0.2126 * src[o] + 0.7152 * src[o + 1] + 0.0722 * src[o + 2]) / 255
    }
    const out = ctx.createImageData(w, h)
    const d = out.data
    const at = (x: number, y: number): number => {
      const cx = Math.min(w - 1, Math.max(0, x))
      const cy = Math.min(h - 1, Math.max(0, y))
      return lum[cy * w + cx]
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tl = at(x - 1, y - 1)
        const t = at(x, y - 1)
        const tr = at(x + 1, y - 1)
        const ml = at(x - 1, y)
        const mr = at(x + 1, y)
        const bl = at(x - 1, y + 1)
        const b = at(x, y + 1)
        const br = at(x + 1, y + 1)
        const dx = tr + 2 * mr + br - (tl + 2 * ml + bl)
        const dy = bl + 2 * b + br - (tl + 2 * t + tr)
        const nx = -dx * 2.2
        const ny = -dy * 2.2
        const len = Math.hypot(nx, ny, 1) || 1
        const o = (y * w + x) * 4
        d[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255)
        d[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255)
        d[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
        d[o + 3] = 255
      }
    }
    ctx.putImageData(out, 0, 0)
    const tex = new Texture(cv)
    tex.needsUpdate = true
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    return tex
  } catch (err) {
    console.warn('[MaterialBall] 法线合成失败，退回平法线：', err)
    return null
  }
}

/**
 * 未知尺寸格式（webp / bmp / tga…）的兜底降采样：**用 canvas 缩，不再解一遍**。
 *
 * 为什么不用第二次 `createImageBitmap`：那正是原来 960ms 的来源（全解 + 带 resize 解）。
 * canvas 的 `drawImage` 缩小是 GPU 合成，成本可忽略；画出来的画布可以直接当 three 的
 * 纹理源（`new Texture(canvas)`）。翻转已经在 `imageOrientation:'flipY'` 时做过，
 * 画布继承同一朝向，所以 `tex.flipY` 仍然是 false。
 */
function downscaleToLimit(bitmap: ImageBitmap, maxPx: number): CanvasImageSource {
  const plan = planTextureDecode({ w: bitmap.width, h: bitmap.height }, maxPx)
  if (!plan.scaled) return bitmap
  const from = `${bitmap.width}×${bitmap.height}`
  const cv = document.createElement('canvas')
  cv.width = plan.width
  cv.height = plan.height
  const ctx = cv.getContext('2d')
  if (!ctx) return bitmap
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, plan.width, plan.height)
  bitmap.close()
  console.info(`[MaterialBall] 贴图降采样（兜底 canvas）${from} → ${plan.width}×${plan.height}（上限 ${maxPx}）`)
  return cv
}

/**
 * `loadTexture` 的入参（性能修复 D + E）
 */
interface LoadTextureOptions {
  /**
   * 取消信号（方案 E）：换资产时上一代的**在途**加载立刻退出。
   *
   * `fetch` 可取消；`createImageBitmap` 一旦开始不可中断 —— 但**还没开始**的那些
   * 必须在入口判掉（扫过一排卡时，排队的几十个解码就是靠这一行不再启动）。
   */
  signal: AbortSignal | null
  /**
   * 贴图池（方案 D）：按 renderer 复用 `Texture`。命中时**连 fetch 都不做**，
   * 直接拿回同一个 Texture 实例（GPU 里已经在册 → 上传也省了）。
   */
  pool: TexturePool<Texture> | null
  /** true = 数据图（线性色彩空间）；false = albedo（sRGB）。进池 key，避免串味 */
  linear: boolean
}

/** 加载结果：`pooled` = 由池管理（换资产时只归还，**不许 dispose**） */
interface LoadedTexture {
  texture: Texture
  pooled: boolean
}

/** 造一个 name === 'AbortError' 的错误（不依赖 DOMException，node 里同样可判） */
function abortError(): Error {
  const err = new Error('贴图加载被取消')
  err.name = 'AbortError'
  return err
}

/**
 * 是不是「主动取消」导致的失败。
 *
 * ⚠️ 取消**不是**故障：`loadTexture` / `loadMap` 判到它之后必须**静默**返回，
 * 绝不能走 `console.warn` 刷日志（docs/26 §4-E 明确要求）。
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * 贴图加载（性能修复 A+B+D+E）：优先 `fetch` + `createImageBitmap`，解码在 worker 线程。
 *
 * ★ A（2026-10）：**同一张图只解码一次**（宽高从文件头读，`shared/imageSize.ts`）。
 * ★ B：`willReadFrequently` + 256px 合成法线（落点在 `normalFromBitmap`）。
 * ★ D（第二批）：**先查 Texture 池**——命中直接返回，`fetch`/解码/上传**全部跳过**。
 *   这就是「切回看过的资产 ≈ 0ms」的来源；位图缓存只解决「不重解码」，
 *   池再解决「不重传 + 不重 fetch」（4K 五槽实测 fetch 81ms + 上传 23.7ms，docs/26 §2.2）。
 * ★ E（第二批）：`signal` 一路传到 `fetch`；`createBitmap` 入口再判一次 aborted。
 *
 * `vault://` 是自定义协议：能不能 fetch 取决于是否注册为 `protocol.handle`（Electron 33
 * 的 handle 支持 fetch）。**拿不到就退回 TextureLoader**，绝不假装成功——退回时会在控制台
 * 留一行 warn，方便判断当前构建走的是哪条路。
 * ⚠️ `TextureLoader` **不支持取消**（它的 `load` 没有 signal 参数）：只在进入前判一次
 * aborted，不假装能中断它。
 */
async function loadTexture(
  url: string,
  opts: LoadTextureOptions
): Promise<LoadedTexture | null> {
  const { signal, pool, linear } = opts
  if (signal?.aborted === true) return null

  /**
   * ★ D：池命中 —— 这一行是「切回来 0ms」的**唯一**入口。
   *
   * key 用 `url|maxPx|srgb|linear`：不需要知道解码后的像素尺寸（`maxPx` 已经决定了
   * 解码目标尺寸的口径），所以能在 `fetch` **之前**查，真正做到零 IO。
   */
  const poolKey = texturePoolKey(url, MAX_TEX_PX, linear)
  const cachedTex = pool ? pool.take(poolKey) : null
  if (cachedTex) {
    console.info(`[MaterialBall] 贴图池命中，跳过 fetch/解码/上传：${url}`)
    return { texture: cachedTex, pooled: true }
  }

  // 池未命中：从池里"拿一张再放回去"不算数（take 已记 miss），这里只是把新贴图放进池
  const putIfPooled = (tex: Texture, image: { width: number; height: number }): LoadedTexture => {
    if (pool) {
      pool.put(poolKey, tex, bitmapBytes(image))
      return { texture: tex, pooled: true }
    }
    return { texture: tex, pooled: false }
  }

  if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
    try {
      const decoded = await decodeTextureBitmap(url, MAX_TEX_PX, {
        // 显式包一层：避免把 fetch 当方法调用时丢 this；signal 让换资产能立刻掐断
        fetchImpl: (u) => fetch(u, signal ? { signal } : undefined),
        createBitmap: async (blob, bitmapOpts) => {
          // ★ E：解码不可中断，但「还没开始」的必须判掉 —— 扫卡时排队的解码就死在这一行
          if (signal?.aborted === true) throw abortError()
          return createImageBitmap(blob, bitmapOpts)
        },
        // ★ 位图层缓存：命中就不解码（只付上传）。缓存与 WebGL 上下文无关，球卸载后仍然有效
        cache: textureBitmapCache
      })
      // 解码途中被取消：结果直接丢（已写进位图缓存也没关系，那正是它的用途）
      // ⚠️ 这里不写 `=== true`：TS 会把首行的守卫收窄成 `false | undefined`，
      //    后续再比较 `true` 会被判成 TS2367「无意义比较」。
      if (signal?.aborted) return null
      if (decoded) {
        if (decoded.scaled && decoded.sourceSize && decoded.decodes > 0) {
          const longest = Math.max(decoded.sourceSize.w, decoded.sourceSize.h)
          console.info(
            `[MaterialBall] 贴图降采样 ${longest}px → ${decoded.bitmap.width}×${decoded.bitmap.height}（上限 ${MAX_TEX_PX}，解码 1 次）`
          )
        }
        // 缓存命中率：用户下次说"还卡"时，这一行能立刻区分"没命中"还是"上传/重绘慢"
        console.info(
          `[MaterialBall] ${formatBitmapCacheStats(textureBitmapCache.stats())} · 本次${decoded.cached ? '命中' : '解码'}`
        )
        // 未知尺寸的格式没法在解码时指定 resize → 用 canvas 缩一次（仍然只解码 1 次）
        const image =
          decoded.scaled === true
            ? (decoded.bitmap as unknown as CanvasImageSource)
            : downscaleToLimit(decoded.bitmap as unknown as ImageBitmap, MAX_TEX_PX)
        const tex = new Texture(image)
        tex.flipY = false // 已在 createImageBitmap 里翻转过，three 不能再翻一次
        tex.needsUpdate = true
        return putIfPooled(tex, image as unknown as { width: number; height: number })
      }
      console.warn(`[MaterialBall] fetch 返回非 2xx，退回 TextureLoader：${url}`)
    } catch (err) {
      // ★ E：主动取消是**预期路径**，不是故障 —— 不打 warn（docs/26 §4-E）
      if (isAbortError(err) || signal?.aborted) return null
      console.warn('[MaterialBall] fetch/createImageBitmap 失败，退回 TextureLoader：', err)
    }
  }
  if (signal?.aborted) return null
  // 兜底路径不池化：它没有可控的解码口径，放进池只会占着一条槽（也避免 flipY 口径串味）
  return new Promise((resolve) => {
    new TextureLoader().load(
      url,
      (t) => resolve({ texture: t, pooled: false }),
      undefined,
      () => resolve(null)
    )
  })
}

/**
 * three.js 材质球场景装配（实时组件与离屏渲染共用）。
 *
 * 生命周期纪律（team-lead 明确要求）：**卸载必须全量 dispose**——
 * geometry / material / textures / controls / envRT / renderer 一个不落，
 * 并 `forceContextLoss()` 主动归还 WebGL 上下文。Chromium 活跃上下文
 * 上限约 8-16，只 dispose 不 loseContext 时上下文回收滞后，
 * 切几次资产就再也建不出 renderer。
 */
export class BallScene {
  readonly renderer: WebGLRenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly material: MeshPhysicalMaterial

  private mesh: Mesh
  private controls: OrbitControls | null = null
  private geometry: BufferGeometry
  /**
   * **本场景自建、必须 `dispose()` 的贴图**（合成法线；TextureLoader 兜底贴图）。
   *
   * ⚠️ 0.7.x 之前它是「全部活动贴图」。第二批（性能修复 D）之后，槽位贴图由
   * `slotTextures` + `texPool` 管理（换资产只**归还**，不 dispose —— 那样才有
   * 「切回来 0ms」），这里只剩**池管不到的**那两类。
   * 于是 `applyMaps` 里那句 `for (const t of this.maps) t.dispose()` 依旧逐字正确，
   * 语义从「释放全部」收窄成「释放自建的」（stagePerf 的源码守卫仍然成立）。
   */
  private maps: Texture[] = []
  /**
   * 当前挂到材质上的槽位贴图（键 = PBR 槽位 + `'alpha'`）。
   *
   * 与 `maps` 的区别只有一个：它们可能在 `texPool` 里（`pool.owns(t)`），
   * 换资产时只 `release`（引用计数 -1），由池按 LRU 决定何时真正 dispose。
   */
  private slotTextures = new Map<MaterialSlotKey | 'alpha', Texture>()
  /**
   * 贴图池（性能修复 D）：**按 renderer** 复用 `Texture`。
   *
   * 池的生命周期 = 本 BallScene 的生命周期：renderer 一销毁，池里的贴图全部失效，
   * 所以 `dispose()` 里必须 `disposeAll()`。舞台那颗球整场会话常驻（建场景 effect
   * 是 `deps: []`），因此「按场景」在这里就等于「按会话」。
   */
  private readonly texPool = new TexturePool<Texture>()
  /**
   * 本批贴图的取消句柄（性能修复 E）：换资产时 `abort()` 上一代。
   *
   * `mapsGen` 只能「丢弃迟到的结果」，不能阻止旧一代继续烧 CPU（docs/26 §3③ 原文）；
   * 加上 controller 之后，旧一代的 `fetch` 立刻 reject、还没开始的解码直接判掉。
   */
  private mapsAbort: AbortController | null = null
  /** rAF 循环（可停可起，stop 不 dispose 上下文） */
  private readonly loop = new FrameLoop()
  private disposed = false
  /**
   * 是否可以上屏：**albedo 落定即可**，其余槽位在后台补（见 `applyMaps` 的双语义）。
   * 舞台的 opening 门控读它 —— 这里提前就等于白球窗口更短、门控等待更少。
   */
  private mapsReady = false
  /** applyMaps 代次令牌（见 applyMaps：只认最新一代，旧一代的加载结果直接丢弃） */
  private mapsGen = 0
  private autoRotate = true
  private currentShape: BallShape
  /**
   * 机位是否已被调用方显式覆盖（舞台 `setCameraDistance(4.52)`）。
   * 覆盖后 `setShape` 不许按形态默认取景改回来 —— 舞台的 `SPHERE_OCCUPANCY`
   * 是按 4.52 标定的，被打回 2.935 会让落定球突然变大。
   */
  private cameraOverridden = false

  /** 调参基准值（贴图未加载时 material 属性即基准；换贴图不改变基准） */
  private baseRoughness = 0.5
  /**
   * 位移基准：球是单位半径，`1.0` 意味着亮度 1 处把半径撑到 2 倍 → 锯齿状轮廓
   * （磁盘上那张混凝土球图就是这个）。4% 半径足够看出浮雕，又不会撑破剪影；
   * 用户 `bump` 滑块仍按倍率乘它，语义不变。
   */
  private readonly baseDisplacementScale = 0.04

  /**
   * 调参状态机（纯逻辑见 `logic/materialBall.ts` 的 `ParamScaleState`）。
   *
   * 它持有当前倍率 + 基准是否落定 + dirty 记账，`markSettled()` **必然**返回一份
   * "按当前倍率 + 最终基准"算出的新值 —— 这就是"材质就绪必然触发一次重算"的机械保证，
   * 不依赖调用方（React effect / 贴图 Promise）的时序。
   */
  private readonly paramState: ParamScaleState

  /** 本批贴图落定的通知回调（组件用来驱动"就绪版本号"，见 setMapsSettledListener） */
  private mapsSettledListener: (() => void) | null = null

  /** UV 大小倍率（v0.2.1 增补 2）：贴图 repeat = 形态基准 × 此倍率 */
  private uvMult = 1

  /**
   * 0.7.6 灰度透明的**反转**开关真值。
   *
   * 它必须由场景自己记住：勾选可能发生在材质还没编译之前（构造完立刻 setParamScales），
   * 那时 `onBeforeCompile` 还没跑、uniform 引用还是 null——只写 uniform 会丢值。
   * `onBeforeCompile` 里读这个字段，保证"编译那一刻"的取值一定是最新的。
   */
  private alphaInvert = false

  /**
   * `onBeforeCompile` 里拿到的 `uAlphaInvert` uniform 引用（未编译过为 null）。
   *
   * 有了它，反转开关在**已编译**时只改 uniform，不置 needsUpdate → 不重编译。
   * 注意它是 `materialProperties.uniforms` 里的同一个对象（three 在编译时把
   * `shader.uniforms` 存成材质级 uniform 表），所以这里写进去就是生效值。
   */
  private alphaInvertUniform: { value: number } | null = null

  /**
   * 各向异性上限 = min(档位上限, GPU 上限)。构造时算好、`applyMotionProfile` 时更新，
   * 所有贴图统一取它 —— 不要把 `Math.min(4, …)` 写回贴图加载处（那样切档不生效）。
   */
  private maxAnisotropy: number

  /**
   * 最近一次 resize 的尺寸。`setPixelRatio()` 只记 ratio，**必须再 setSize 一次**
   * 才会按新 ratio 重排 framebuffer（three 的坑），所以这里要留底。
   */
  private lastSize: { w: number; h: number } | null = null

  constructor(canvas: HTMLCanvasElement, opts: BallSceneOptions) {
    this.currentShape = opts.shape
    this.autoRotate = opts.autoRotate !== false
    // 基准在构造时就交给状态机：之后 setRoughnessBase() / markSettled() 都会按它重算
    this.paramState = new ParamScaleState({
      baseRoughness: this.baseRoughness,
      baseDisplacementScale: this.baseDisplacementScale
    })
    // 动效性能档位：DPR 上限与贴图各向异性都在构建时读一次（之后由 applyMotionProfile 热改）
    const profile = currentMotionProfile()
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: opts.background === undefined,
      preserveDrawingBuffer: opts.preserveDrawingBuffer === true
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.dprCap))
    this.maxAnisotropy = Math.min(
      profile.anisotropy,
      this.renderer.capabilities.getMaxAnisotropy()
    )
    this.renderer.outputColorSpace = SRGBColorSpace
    /**
     * 色调映射：**Neutral（Khronos PBR Neutral）**，不是 ACES Filmic。
     *
     * 用户原话：「现在光线有些时候太强了，它和贴图原本的颜色色差是比较大的」。
     * ACES 的设计目标是「电影感」：它把中间调提亮、把高光的饱和度压掉（肩部去饱和），
     * 于是贴图上原本的砖红/混凝土灰会被推亮推灰 —— 这正是"色差大"的来源。
     * Neutral 是 Khronos 为**商品/材质本色还原**定义的曲线：只有超过 0.76 的高光才
     * 做滚降压缩，中间调是线性的，因此贴图颜色能一比一落回屏幕。
     *
     * 曝光保持 1.0（曝光交给「光线强度」滑块的 `scene.environmentIntensity`，
     * 见 `applyParams` —— 改 exposure 会连高光滚降一起推，用户要的只是"光弱一点"）。
     */
    this.renderer.toneMapping = NeutralToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new Scene()
    if (opts.background !== undefined) {
      this.scene.background = new Color(opts.background)
    } else {
      this.renderer.setClearColor(0x000000, 0)
    }

    this.camera = new PerspectiveCamera(42, 1, 0.1, 100)
    // 取景（2026-10 对齐包内预览）：相机仍在同一条射线上，**只改长度**，且分形态——
    // 球 2.935（fill 94.4%，对齐包内 PBR 预览 680²/720²），平面 3.380 / 盒 2.647（fill 90%，
    // 再近就左右切边）。全部数值来自 `logic/ballCamera.ts`，这里不许写死常量。
    const camPos = ballCameraPosition(opts.shape)
    this.camera.position.set(camPos.x, camPos.y, camPos.z)
    // ★ 必须对准原点。交互形态下 OrbitControls.update() 会代劳，但舞台是
    //   `interactive: false`（没有 controls），相机就永远保持这个 y 偏移的机位
    //   → 球在画面里偏下、底部被画布裁掉（用户实测「不是一个完整的球」）。
    this.camera.lookAt(0, 0, 0)

    // 程序化环境光照：RoomEnvironment + PMREM（**全进程按 renderer 共享**，见 sharedEnvironment）
    this.scene.environment = sharedEnvironment(this.renderer)

    this.material = new MeshPhysicalMaterial({
      color: BASE_COLOR,
      roughness: this.baseRoughness,
      metalness: 0.0
      // ⚠️ 这里**故意不设** `envMapIntensity`：环境反射强度由 `scene.environmentIntensity`
      // 统一控制（「光线强度」滑块的唯一作用点，见 applyParams）。three 在
      // `material.envMap === null && scene.environment !== null` 时每帧用 scene 的值
      // 覆盖 material 的同名 uniform（WebGLRenderer 的 refreshMaterialUniforms），
      // 所以写在这里是**死值**——留着只会让人误以为反射默认 1.1，"调"它却毫无反应。
    })
    /**
     * 0.7.6 灰度透明：只给 `alphamap_fragment` 换实现（见模块级常量）。
     *
     * 不改 `customProgramCacheKey`：默认实现取 `onBeforeCompile.toString()`，
     * 本函数源码是常量 → 同 key；本仓库每个 WebGLRenderer 只持有一个材质，
     * 不存在跨材质共享 program 的串味风险。
     * 没有 alphaMap 的材质连 `USE_ALPHAMAP` define 都不会有 → 补丁整段被预处理器丢掉，
     * 成像与改动前逐像素一致（这正是不需要 +RENDER_REV 的理由）。
     */
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uAlphaInvert = { value: this.alphaInvert ? 1 : 0 }
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <alphamap_pars_fragment>',
          '#include <alphamap_pars_fragment>\nuniform float uAlphaInvert;'
        )
        .replace('#include <alphamap_fragment>', ALPHA_MAP_FRAGMENT_PATCH)
      this.alphaInvertUniform = shader.uniforms.uAlphaInvert
    }
    this.geometry = createGeometry(opts.shape)
    this.mesh = new Mesh(this.geometry, this.material)
    this.scene.add(this.mesh)

    // 调参渲染（需求书 §3.3）：反光 / 凹凸倍率在构建时立即生效
    this.setParamScales(opts.params ?? DEFAULT_PARAM_SCALES)

    if (opts.size) this.resize(opts.size, opts.size)

    if (opts.interactive) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement)
      this.controls.enableDamping = true
      this.controls.dampingFactor = 0.08
      this.controls.enablePan = false
      this.controls.minDistance = 1.6
      this.controls.maxDistance = 6
      this.controls.autoRotate = this.autoRotate
      this.controls.autoRotateSpeed = 1.2
      this.controls.target.set(0, 0, 0)
    }
  }

  /**
   * 换形态（只换几何体，不重建 WebGL 上下文）。
   *
   * 取景也要跟着换：三种形态的投影尺寸不同（球半径 1、平面 2.2²、盒 1.5³），
   * 用同一个距离会出现"球刚好、平面左右切边"。距离同样来自 `logic/ballCamera.ts`。
   * **舞台例外**：它用 `setCameraDistance()` 显式覆盖过机位（正前方 4.52），
   * 那种情况下不许被形态默认值打回去。
   */
  setShape(shape: BallShape): void {
    if (this.disposed || shape === this.currentShape) return
    this.currentShape = shape
    const next = createGeometry(shape)
    this.mesh.geometry = next
    this.geometry.dispose()
    this.geometry = next
    this.applyRepeat()
    if (!this.cameraOverridden) {
      const p = ballCameraPosition(shape)
      this.camera.position.set(p.x, p.y, p.z)
      this.camera.lookAt(0, 0, 0)
      this.camera.updateProjectionMatrix()
    }
  }

  /**
   * 当前**活动的全部贴图**：槽位贴图（可能来自池）+ 自建贴图（合成法线 / 兜底），去重。
   *
   * 所有「对每张贴图做点什么」的地方都必须走这里，不能只遍历 `this.maps`
   * （第二批之后它只剩自建的那两张）：平铺、各向异性热改、释放。
   */
  private liveTextures(): Texture[] {
    const out: Texture[] = []
    for (const t of this.slotTextures.values()) out.push(t)
    for (const t of this.maps) if (!out.includes(t)) out.push(t)
    return out
  }

  /**
   * 换资产时归还槽位贴图（性能修复 D）。
   *
   * - 池里的：只 `release`（引用 -1），**绝不 dispose** —— 切回来还要用它，
   *   那正是「hover 预热过再双击 = 0 成本」的全部来源；
   * - 自建的（`release` 返回 false）：留给 `applyMaps` 里那句
   *   `for (const t of this.maps) t.dispose()` 统一释放。
   *
   * ⚠️ 先在槽位上 `release` 再 dispose 自建的：`release` 内部会跑一次逐出，
   * 此时槽位引用已经放开，逐出才可能把上一批资产那几张贴图收掉。
   */
  private releaseSlots(): void {
    for (const t of this.slotTextures.values()) this.texPool.release(t)
    this.slotTextures.clear()
  }

  /**
   * 平铺：形态基准（平面 2×2 检查接缝，球 / 盒 1×1）× UV 大小倍率（v0.2.1 增补 2）。
   * three 支持小数 repeat + RepeatWrapping，倍率 0.1–4 全程有效。
   *
   * 球面还要再乘 UV 弧长比 2（见 `applyUvRepeat` 的说明）——这个倍率**只作用于 u**，
   * 是"方砖不变长砖"的唯一正确解：`SphereGeometry` 的 u 一圈 = 2πr、v 半圈 = πr。
   */
  private applyRepeat(): void {
    for (const t of this.liveTextures()) this.repeatTexture(t)
  }

  /** 单张贴图的重复写入口径（所有贴图共用；缺一处就会出现"弹窗正常、卡片还是长砖"） */
  private repeatTexture(tex: Texture): void {
    const base = this.currentShape === 'plane' ? PLANE_REPEAT : 1
    applyUvRepeat(tex, effectiveUvRepeat(base, this.uvMult), uvAspectOf(this.currentShape))
  }

  /**
   * 应用调参渲染倍率（滑块实时预览与离屏保存共用，需求书 §3.3）。
   *
   * - 反光强度：three 着色器里 `roughness` 是 roughnessMap 的乘数——有 map 时
   *   倍率直接生效（0-2 全程有效）；没有 map 时 roughness 就是基础值本身，
   *   按 `base × mult` 计算并夹到 [0,1]（纯逻辑见 logic/materialBall.ts 的
   *   `effectiveRoughness`，单测覆盖）；
   * - 凹凸强度：normalScale 与 displacementScale 同倍率缩放（0 = 拍平）；
   * - UV 大小（v0.2.1 增补 2）：贴图平铺倍率，变化时重新 applyRepeat()；
   * - 金属度 / 透明度：写 `material.metalness` / `opacity`（透明度 <1 才开 transparent）；
   * - 光线强度：写 `scene.environmentIntensity`。
   *
   * ★ 本批贴图还没落定时调用：值先上去（滑块要即时），但状态机会记 `pending`，
   *   `markSettled()` 时**必然**再算一次（任务 1 的收敛点）。
   */
  setParamScales(scales: BallParamScales): void {
    if (this.disposed) return
    this.applyParams(this.paramState.setScales(scales))
  }

  /**
   * 注册「本批贴图全部落定」的监听（任务 1 收敛点的上层接线）。
   *
   * 组件用它把"就绪版本号"+1，从而让 `[scales, mapsVersion]` 的同步 effect 再跑一次；
   * 传 null 注销（卸载时不必传，`dispose()` 之后不会再回调）。
   * 为什么不用构造参数：`BallScene` 的构造调用形态被既有源码守卫（tests/stagePerf）钉住，
   * 改签名会波及那条守卫，而这里只是一次赋值，语义等价。
   */
  setMapsSettledListener(listener: (() => void) | null): void {
    this.mapsSettledListener = listener
  }

  /**
   * 注入 / 校准基准粗糙度（无 roughnessMap 时 `roughness = base × mult` 的 base）。
   *
   * 当前实现保持常量 0.5（**不是**贴图流程赋的），但任何时刻注入都会立即按最新
   * 倍率重算 —— 状态机的 dirty 记账保证调用方不用关心"贴图加载到哪一步了"。
   */
  setRoughnessBase(value: number): void {
    if (this.disposed || !Number.isFinite(value) || value < 0) return
    this.baseRoughness = Math.min(1, value)
    this.applyParams(this.paramState.setBasis({ baseRoughness: this.baseRoughness }))
  }

  /** 把状态机算出的值写进材质（唯一写入口径：roughness / normalScale / displacement + UV + 金属 + 透明） */
  private applyParams(values: MaterialParamValues): void {
    if (this.disposed) return
    applyMaterialParams(this.material, values)
    // 灰度反转：**只写 uniform**，不碰 needsUpdate（交互路径不许重编译）。
    // alphaMap 的有无由 applyMaps 决定（它是贴图批次的事实，不是参数）。
    this.setAlphaInvert(values.alphaInvert)
    // 光线强度：**只影响照度，不影响贴图采样** —— 调暗就是少给环境光，贴图颜色本身
    // 一点不改（改 exposure 会连高光滚降一起推，不是用户要的"光弱一点"）。
    // three 在 `material.envMap === null && scene.environment !== null` 时会用
    // `scene.environmentIntensity` 覆盖 material.envMapIntensity，所以这里是唯一作用点。
    this.scene.environmentIntensity = values.light
    if (values.uv !== this.uvMult) {
      this.uvMult = values.uv
      this.applyRepeat()
    }
  }

  /**
   * 设置「反转灰度」。
   *
   * - 材质已编译（拿得到 uniform 引用）→ 只写值，零重编译；
   * - 还没编译（刚构造 / 刚换材质）→ 只记字段，等 `onBeforeCompile` 时读。
   *
   * 两条路径都覆盖，才不会出现"第一次勾选无效、重新打开弹窗才对"的时序 bug。
   */
  private setAlphaInvert(invert: boolean): void {
    this.alphaInvert = invert
    if (this.alphaInvertUniform) {
      this.alphaInvertUniform.value = invert ? 1 : 0
    }
  }

  /** 基准变化（合成法线改了 normalScale 基准 / roughnessMap 到位）→ 重算 */
  private setParamBasis(patch: ParamBasisPatch): void {
    this.applyParams(this.paramState.setBasis(patch))
  }

  /**
   * 本批贴图**落定**：写入最终基准（roughnessMap 到底有没有）→ 无条件按当前倍率
   * 重算一次 → 通知上层。
   *
   * ⚠️ 这是任务 1 的收敛点：`applyMaps` 的**所有分支**都必须走到这里，包括
   * "没有任何槽位""只有 albedo""加载失败"的路径。曾经只有"基准复位"那一支重算，
   * 于是首帧停在临时值上（默认质感），拖动滑块才被纠正。
   */
  private settleParamBasis(): void {
    if (this.disposed) return
    this.applyParams(
      this.paramState.markSettled({
        hasRoughnessMap: this.material.roughnessMap !== null,
        // 灰度透明的 OPAQUE 陷阱靠它：有 alphaMap 就必须 transparent（见 applyMaterialParams）
        hasAlphaMap: this.material.alphaMap !== null
      })
    )
    this.mapsSettledListener?.()
  }

  /**
   * 应用贴图（异步加载）。
   *
   * 单张失败只 console.warn 并保持该槽位默认灰——一张贴图加载失败不该
   * 炸掉整个预览（vault:// CORS 修复落地前这是预期路径，见文件头说明）。
   *
   * ★ 双语义（2026-10，白球窗口修复）：
   * - **`mapsReady`（= `isReady()`）只等 albedo**：有 albedo 时，它一落定（成功或
   *   失败都算）就放行，其余 7 个槽位在后台继续补 —— 舞台不必为最慢那张图上屏前等待；
   * - **返回的 Promise 仍等全部槽位**：`renderBallToPng` / `renderBallToJpeg` 是
   *   `await applyMaps()` 之后立刻 `renderOnce()`，Promise 提前 resolve 会渲出缺贴图的
   *   封面/缩略图。两条语义各自独立，谁都别改成对方。
   */
  applyMaps(urls: MaterialSlotUrls): Promise<void> {
    // ★ 先撤销"就绪"：换资产会清空贴图（下面的 dispose/clearMaps），
    //   若不复位 mapsReady，复用同一个 BallScene 时 isReady() 会在贴图还没回来的
    //   窗口期里撒谎 —— 舞台的就绪门控会提前放行，第一帧就是一个白球。
    this.mapsReady = false
    // 代次令牌：换资产复用同一个场景后，上一份资产的慢加载可能晚于新一份返回，
    // 没有令牌就会把旧贴图贴到新球上（hover 快速划卡时必然踩到）。
    const gen = ++this.mapsGen
    /**
     * ★ 性能修复 E（第二批）：**取消上一代的在途加载**。
     *
     * `mapsGen` 只能丢弃迟到的结果，拦不住旧一代继续烧 CPU —— 扫过一排材质卡时，
     * 几十个 `fetch` / 解码会排成队，用户双击的那一张只能排在队尾（docs/26 §3③ 实测
     * 的"排队来源"）。abort 之后：旧一代的 `fetch` 立刻 reject，还没开始的解码
     * 在入口就被判掉（`loadTexture` 的 `createBitmap`）。
     */
    this.mapsAbort?.abort()
    const abort = new AbortController()
    this.mapsAbort = abort
    const signal = abort.signal

    /**
     * ★ 性能修复 D（第二批）：**池化贴图只归还，不 dispose**。
     *
     * 只有 `this.maps`（合成法线 / TextureLoader 兜底）照旧释放；槽位贴图回到
     * `texPool`（引用 -1），下次切回来就能命中 → 不重 fetch、不重解码、不重上传。
     *
     * 顺序纪律：**先 `clearMaps` 摘掉材质引用，再归还/释放**。原因是 `releaseSlots()`
     * 会顺手跑一次 LRU 逐出（`refs` 归零的条目可能被立刻 dispose），
     * 若此时 `material.map` 还指着它，就会留下「材质引用已 dispose 纹理」的窗口。
     */
    clearMaps(this.material)
    this.releaseSlots()
    for (const t of this.maps) t.dispose()
    this.maps = []
    // 复用同一个场景换资产：这两个值原本靠"每次新建 BallScene"天然复位，现在必须显式复位
    this.material.color.setHex(BASE_COLOR) // 上一个资产可能把底色让成了纯白
    // 基准复位 + 标记"未落定"：单图资产会把法线基准压到 SYNTH_NORMAL_SCALE，
    // roughness 的口径也要看这一批到底有没有 roughnessMap —— 未落定前算出的只是临时值。
    this.paramState.markPending({ hasRoughnessMap: false, baseNormalScale: 1, hasAlphaMap: false })
    // 卸 map 同样会改 shader define（USE_MAP 等），必须重编译，否则沿用旧 Program 引用已释放的纹理
    this.material.needsUpdate = true

    const entries: Array<[MaterialSlotKey | 'alpha', string]> = []
    for (const key of SLOT_ORDER) {
      const u = urls[key]
      if (typeof u === 'string' && u.length > 0) entries.push([key, u])
    }
    /**
     * 0.7.6 灰度透明：**源图就是 albedo 本身**（同一张 URL，不做文件选择器、
     * 不新增 PBR 槽位）。`loadMap` 会给它建一个**独立的 Texture 实例**并保持线性
     * 色彩空间（见那里的注释），所以两张纹理互不干扰。
     *
     * 用 `paramState.currentScales` 而不是入参：舞台/弹窗/离屏三条路径都可能是
     * "先 applyMaps 后改参数"，唯一可信的当前值是状态机里那份。
     */
    if (this.paramState.currentScales.alphaFromMap === true) {
      const albedoUrl = urls.albedo
      if (typeof albedoUrl === 'string' && albedoUrl.length > 0) entries.push(['alpha', albedoUrl])
    }
    if (entries.length === 0) {
      // 没有任何槽位（灰球）：基准立刻落定 → 按当前倍率重算（任务 1 收敛点之一）
      this.settleParamBasis()
      if (gen === this.mapsGen) this.mapsReady = true
      return Promise.resolve()
    }

    /**
     * 放行 `isReady()`：调用点必须保证 albedo 的 `assignMap()` 已经发生过，
     * 否则 `synthesizeNormalIfMissing` 读到的还是空 map（合成法线会静默跳过）。
     */
    const markReady = (): void => {
      if (this.disposed || gen !== this.mapsGen) return
      this.synthesizeNormalIfMissing(urls)
      // 贴图到位后重算一遍：roughness 要按"有没有 roughnessMap"取不同口径
      this.setParamBasis({
        hasRoughnessMap: this.material.roughnessMap !== null,
        hasAlphaMap: this.material.alphaMap !== null
      })
      this.mapsReady = true
    }

    const hasAlbedo = entries.some(([slot]) => slot === 'albedo')
    /**
     * alpha 项**不参与这一批并发加载**：它与 albedo 是同一个 URL，
     * 并发会让 `createImageBitmap` 把同一张 8K 图解码两遍（实测 400–800ms，
     * 而 `textureBitmapCache` 只有在第一份解码**完成后**才写入）。
     * 放到 `Promise.all` 之后单发 → 必然命中缓存，只付一次上传。
     */
    const alphaEntry = entries.find(([slot]) => slot === 'alpha')
    const mapEntries = entries.filter(([slot]) => slot !== 'alpha')
    const jobs = mapEntries.map(async ([slot, url]) => {
      await this.loadMap(slot, url, gen, signal)
      // albedo 一落定就上屏（fail 也算：失败槽位保持默认灰，总比永远不亮强）
      if (slot === 'albedo') markReady()
    })

    // Promise 语义不变：等**全部**槽位落定才 resolve（离屏渲染依赖这一点）
    return Promise.all(jobs).then(async () => {
      if (this.disposed || gen !== this.mapsGen) return
      // 无 albedo 的资产没有"提前放行"的锚点 → 全部到齐才算就绪（与原逻辑一致）；
      // 有 albedo 的只是补一次 isReady。
      if (!hasAlbedo) markReady()
      // alpha 单发（见上：同 URL 串行，避免二次解码）；失败也只是少一层灰度透明
      if (alphaEntry) await this.loadMap('alpha', alphaEntry[1], gen, signal)
      if (this.disposed || gen !== this.mapsGen) return
      // ★ 任务 1：**所有分支**在这里按当前倍率重算一次（不含 albedo 的、单图的、
      //   有 roughnessMap 的、加载失败保底灰的，全部覆盖）。这里不读"调用方快照"，
      //   而是由状态机 `markSettled()` 给出按"当前倍率 + 最终基准"算出的值 ——
      //   即使中间隔着几十毫秒的异步加载、期间用户又拖了滑块，也不会算漏。
      //   注意：`hasAlphaMap` 必须在这之后取（alpha 贴图落定才算数）。
      this.settleParamBasis()
      // 一行汇总（每批一次）：排查「还卡」时能直接看出池是满的还是命中率低
      console.info(`[MaterialBall] ${formatTexturePoolStats(this.texPool.stats())}`)
    })
  }

  /**
   * 单图资产（只有 albedo）没有法线/粗糙度图 → 球面是一张平图，看起来像纸。
   * 用 albedo 的亮度梯度合成一张法线，让表面有明暗起伏（性能修复 D）。
   *
   * 三条纪律：
   * - **只在 normal 槽位缺失时**合成，真 PBR 资产一行不受影响；
   * - 强度保守（`SYNTH_NORMAL_SCALE`=0.32），避免用户说的"油腻"；
   * - 合成图进 `this.maps`，随实例 dispose（它不是共享资源）。
   */
  private synthesizeNormalIfMissing(urls: MaterialSlotUrls): void {
    if (this.disposed) return
    if (typeof urls.normal === 'string' && urls.normal.length > 0) return // 有真法线图
    const albedo = this.material.map
    const image = albedo?.image as (CanvasImageSource & { width: number; height: number }) | undefined
    if (!image || !image.width || !image.height) return
    const tex = normalFromBitmap(image)
    if (!tex) return
    tex.anisotropy = this.maxAnisotropy
    this.repeatTexture(tex)
    this.maps.push(tex)
    assignMap(this.material, 'normal', tex)
    this.material.needsUpdate = true
    // 让 normalScale 按新基准重算（基准写进状态机，倍率用当前值，不依赖调用方）
    this.setParamBasis({ baseNormalScale: SYNTH_NORMAL_SCALE })
  }

  private async loadMap(
    slot: MaterialSlotKey | 'alpha',
    url: string,
    gen: number,
    signal: AbortSignal | null
  ): Promise<void> {
    /**
     * 池 key 的 `linear` 口径必须与下面的 `colorSpace` 写入口径**逐字一致**：
     * 只有 albedo 是 sRGB，其余（含 `'alpha'`）都是线性数据图（见下面的长注释）。
     * 两处一旦漂移，池里就会混进「按错的色彩空间建的贴图」→ 颜色/透明度错。
     */
    const loaded = await loadTexture(url, {
      signal,
      pool: this.texPool,
      linear: slot !== 'albedo'
    })
    if (!loaded) {
      /**
       * ★ E：取消 / 过期代次都是**预期路径**，不是加载失败 → 必须静默。
       * 这里的判据顺序很重要：先判取消，再判代次；两者都成立时也不打日志。
       */
      if (signal?.aborted === true || gen !== this.mapsGen) return
      console.warn(`[MaterialBall] 贴图加载失败（${slot}），该槽位保持默认灰：${url}`)
      return
    }
    const tex = loaded.texture
    // 场景已卸载，或这份贴图属于已被取代的那一代资产 → 立刻归还/释放，绝不能贴上去
    if (this.disposed || gen !== this.mapsGen) {
      // ★ D：池里的贴图只**归还**（dispose 会把池里那条变成死纹理）；自建的照旧释放
      if (loaded.pooled) this.texPool.release(tex)
      else tex.dispose()
      return
    }
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    /**
     * 色彩空间纪律：albedo 是 sRGB；normal/roughness/ao/displacement 是数据图，保持线性。
     *
     * ★ `'alpha'`（0.7.6 灰度透明）**必须留在线性**：
     * 它是 albedo 同一张图的第二个 Texture 实例（位图解码有 textureBitmapCache 命中，
     * 不会二次解码），但 sRGB → 线性会把 0.5 灰变成 ≈0.21 → 用户眼里"一半灰"
     * 变成"几乎全透"。按灰度就该按**文件里的原始值**，不做传递函数。
     */
    if (slot === 'albedo') tex.colorSpace = SRGBColorSpace
    /**
     * 各向异性是**采样器状态**，只在贴图上传（`needsUpdate`）时写进 GPU。
     * 池命中的贴图可能已经上传过，所以：
     * - 档位没变 → 什么都不做（**不能无条件 needsUpdate**，否则池命中又要重传一次，
     *   正好抵消 D 的收益）；
     * - 档位变了 → 写值 + `needsUpdate`，让新的采样参数落进显存。
     */
    if (tex.anisotropy !== this.maxAnisotropy) {
      tex.anisotropy = this.maxAnisotropy
      tex.needsUpdate = true
    }
    // 平铺 = 形态基准 × UV 大小倍率（v0.2.1 增补 2）+ 球面 u 方向弧长补偿（见 repeatTexture）。
    // alpha 走同一口径：否则透明分布与颜色贴图对不上（半透明的斑块错位）。
    // ⚠️ 池命中的贴图可能是上一次（另一种形态 / 另一个 UV 倍率）用过的 → **每次都要重写**。
    this.repeatTexture(tex)
    /**
     * 同一槽位已有旧贴图时先摘掉它：池化的归还（引用 -1），自建的 dispose。
     * 正常路径下 `applyMaps` 一开始就清空了 `slotTextures`，这里是防御性分支
     * （同代内重复挂同一槽位 / 灰度开关切换时会出现）。
     */
    const prev = this.slotTextures.get(slot)
    if (prev !== undefined && prev !== tex) {
      if (!this.texPool.release(prev)) {
        const at = this.maps.indexOf(prev)
        if (at >= 0) this.maps.splice(at, 1)
        prev.dispose()
      }
    }
    this.slotTextures.set(slot, tex)
    // 池管不到的（TextureLoader 兜底）必须记进 `this.maps`，卸载/换资产时才有机会释放
    if (!loaded.pooled) this.maps.push(tex)
    assignMap(this.material, slot, tex)
    // albedo 是**乘法**着色：底色 0xb9b6b0 会把所有贴图整体压暗偏灰。
    // 有 albedo 时把底色让给贴图（纯白），没有贴图时才用中性灰当"陶土球"。
    this.material.color.setHex(slot === 'albedo' ? 0xffffff : this.material.color.getHex())
    this.material.needsUpdate = true // 增减 map 会改 shader define，必须重编译
  }

  resize(width: number, height: number): void {
    this.lastSize = { w: width, h: height }
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / Math.max(1, height)
    this.camera.updateProjectionMatrix()
  }

  /** 离屏单帧（交互模式用 startLoop 持续渲染） */
  renderOnce(): void {
    this.renderer.render(this.scene, this.camera)
  }

  startLoop(): void {
    if (this.disposed) return
    this.loop.start(() => {
      this.controls?.update() // damping + autoRotate 需要每帧驱动
      this.renderer.render(this.scene, this.camera)
    })
  }

  private stopLoop(): void {
    this.loop.stop()
  }

  // ── 舞台用的三个命令式入口（docs/19 裁定①） ──────────────────────────

  /**
   * 姿势：只写 `mesh.scale.z`（0.04–1.6，压扁 ↔ 鼓满）。
   * **不重建几何、不重建材质、不重传贴图** —— 这是过场动画的开销底线。
   * three 的 normalMatrix 是非均匀缩放的逆转置，法线自动正确，无需自定义 shader。
   *
   * ★ 压扁轴必须先**朝向相机**：scale 作用在物体自身坐标系，而相机是靠
   *   OrbitControls 绕轨道转的；不校正的话，相机一转到侧面，扁球投影就是**椭圆**
   *   （2026-10-21 原型里同一个坑：看起来像"生成出来不是正圆"）。
   *   鼓满（z≈1）时不需要校正，省掉每帧的四元数计算。
   */
  setPose(z: number): void {
    if (this.disposed) return
    const v = Number.isFinite(z) ? z : 1
    if (v < 0.995) this.mesh.lookAt(this.camera.position)
    applyPose(this.mesh, v)
  }

  /** 舞台取景：正前方 d 处、回正到原点（见 MaterialBallApi.setCameraDistance 的说明） */
  setCameraDistance(d: number): void {
    if (this.disposed) return
    const v = Number.isFinite(d) && d > 1.5 ? d : 3.4
    this.camera.position.set(0, 0, v)
    this.camera.lookAt(0, 0, 0)
    this.camera.updateProjectionMatrix()
    // 显式覆盖过机位 → 此后 setShape 不许再按形态默认值改回来
    // （舞台的 SPHERE_OCCUPANCY 是按 4.52 标定的，被顶掉就会大小跳变）
    this.cameraOverridden = true
  }

  /** 贴图是否**可以上屏**：albedo 落定（成功或单张失败）即为 true，其余槽位后台补。
   * 无 albedo 的资产退回旧口径（全部槽位到齐）。离屏渲染请不要用它，直接 await applyMaps()。
   */
  isReady(): boolean {
    return this.mapsReady
  }

  /**
   * 球的**屏幕投影直径**（CSS px）：弹窗交接时用它算落点外接框。
   *
   * 为什么不让弹窗自己量：弹窗量到的是 canvas 尺寸，而球在 canvas 里只占一部分
   * （见 `SPHERE_OCCUPANCY` 的踩坑记录），两处口径一旦漂移，交接瞬间球会"跳一下"。
   * 这里直接按相机几何算：相机看向原点、球在原点、半径 1 ⇒ 球心投影 = 画布中心，
   * 直径 = 2f / √(d²−1)（f = 画布高的一半 / tan(fov/2)）。
   */
  sphereScreenDiameter(): number {
    if (this.disposed) return 0
    const el = this.renderer.domElement
    const h = el.clientHeight || 1
    const f = h / 2 / Math.tan((this.camera.fov * Math.PI) / 360)
    const d = this.camera.position.length()
    if (d <= 1) return 0
    return (2 * f) / Math.sqrt(d * d - 1)
  }

  /** 暂停/恢复 rAF；**不 dispose**（舞台隐藏时保留上下文，重新进入不用重建） */
  setRunning(on: boolean): void {
    if (this.disposed) return
    if (on) this.startLoop()
    else this.stopLoop()
  }

  /** 是否持续自转（默认 true；弹窗保持现状，舞台的静止球传 false） */
  setAutoRotate(on: boolean): void {
    if (this.disposed) return
    this.autoRotate = on
    if (this.controls) applyAutoRotate(this.controls, on)
  }

  /**
   * 热应用「动效性能」档位（设置·外观三档）：只改 DPR 与贴图各向异性，
   * **不重建上下文、不重载贴图、不重编译 shader**。
   *
   * 为什么需要：换资产不再重建 renderer 之后，一个 BallScene 从挂载活到卸载
   * （舞台那颗球可能整场会话都在），只在构造时读一次档位会让设置滑块"空转"。
   *
   * `setPixelRatio()` 只是记下 ratio，**必须再 `setSize()` 一次** three 才会按新
   * ratio 重排 drawingBuffer（否则要等下一次窗口 resize 才生效）。
   */
  applyMotionProfile(profile: MotionProfile): void {
    if (this.disposed) return
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.dprCap))
    if (this.lastSize) this.resize(this.lastSize.w, this.lastSize.h)
    this.maxAnisotropy = Math.min(profile.anisotropy, this.renderer.capabilities.getMaxAnisotropy())
    // `texture.needsUpdate = true` 才会把新的 anisotropy 送进 GPU（否则采样参数不变）
    // ⚠️ 必须走 liveTextures()：槽位贴图第二批起不在 `this.maps` 里了
    for (const t of this.liveTextures()) {
      t.anisotropy = this.maxAnisotropy
      t.needsUpdate = true
    }
  }

  /** 全量释放（卸载必经之路，详见类注释） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // ★ E：卸载时把在途加载一并掐断（否则关了舞台，旧 fetch / 解码还在烧 CPU）
    this.mapsAbort?.abort()
    this.mapsAbort = null
    this.stopLoop()
    this.controls?.dispose()
    for (const t of this.maps) t.dispose()
    this.maps = []
    this.slotTextures.clear()
    /**
     * ★ D：池里的贴图必须在这里全部释放。
     *
     * renderer 马上要 `dispose() + forceContextLoss()`，池里的 Texture 全部失效；
     * 不 disposeAll 的话它们会一直挂在池里（引用计数也不再有人减），
     * 而且 `sharedEnvCache` 那套 "GPU 资源随上下文归还" 的说法**不适用于 JS 侧的
     * Texture 对象**（它没有被 GC 回收之前，其 WebGLTexture 记录要等上下文销毁才清）。
     */
    this.texPool.disposeAll()
    clearMaps(this.material)
    this.material.dispose()
    this.geometry.dispose()
    this.scene.clear()
    // 注意：**不 dispose scene.environment** —— 它是全进程共享的（sharedEnvironment）。
    // 这里只清引用；GPU 纹理随 renderer.dispose()/forceContextLoss() 一起归还。
    this.scene.environment = null
    this.renderer.dispose()
    // 关键：主动归还 WebGL 上下文（Chromium 活跃上下文上限约 8-16）
    this.renderer.forceContextLoss()
  }
}

/**
 * 命令式入口（docs/19 裁定①）：舞台层要能压扁/鼓满、查就绪、暂停循环，
 * 但**不重建任何 WebGL 资源**。不传 apiRef 时这三个能力根本不会被创建。
 */
export interface MaterialBallApi {
  /** 只写 mesh.scale.z，用于「压扁 → 吹饱满」的过场；不重建几何、不重建材质 */
  setPose(z: number): void
  /** 当前是否可以上屏（albedo 已落定；其余槽位后台补，详见 BallScene.applyMaps） */
  isReady(): boolean
  /**
   * 球的屏幕投影直径（CSS px）。弹窗交接用它算落点外接框，避免两处口径漂移。
   * 未挂载 / 已 dispose 时返回 0（调用方按"拿不到尺寸"处理）。
   */
  sphereScreenDiameter(): number
  /**
   * 当前几何形态（2026-10 缓存策略：形态参与球图身份）。
   *
   * 调用方在「保存 / 设为封面」时把它一起传给 `renderBallToJpeg/Png` 的 `shape`，
   * 否则离线渲出来的图和这一帧看到的形状不一致（球图缓存名也会算错）。
   */
  getShape(): BallShape
  /** 暂停/恢复 rAF（舞台隐藏时用，别 dispose 上下文） */
  setRunning(on: boolean): void
  /**
   * 舞台专用取景：把相机摆到正前方 `d` 处并回正。
   * 产品的默认机位是 (0, 0.55, 3.4)（略偏上、带一点俯视角，给「浮在卡面上」用），
   * 但顶栏那一格只有 72px，那个机位下球会**溢出画布四边**（实测球径 ≈ 画布的 1.15 倍）。
   * 舞台需要的是「整球可见」的正视图，所以单独给一个机位，不动其他调用方。
   */
  setCameraDistance(d: number): void
  /**
   * hover 预热：就绪后渲染一帧。
   * three 的贴图是**首次渲染时才上传 GPU**的，只解码不上传的话，双击那一下仍要付上传成本。
   * 这一帧是隐形的（舞台在 idle 态 opacity:0），把解码+上传都压到用户看不见的时候。
   */
  warm(): void
}

export interface MaterialBallProps {
  /** 资产文件夹相对库根的路径（默认拼 vault://asset/ 用） */
  relFolder: string
  /** PBR 槽位（rel 路径集合）；空对象 = 纯灰球（仅展示环境光照） */
  slots: MaterialSlots
  /** 初始形态，默认球 */
  defaultShape?: BallShape
  /**
   * 覆盖贴图 URL（默认 `vault://asset/<relFolder>/<rel>`）。
   * vault:// 的 CORS 响应头修复落地前，可传 data URL（未来 IPC）绕过。
   */
  textureUrls?: MaterialSlotUrls
  /** 是否显示内置形态切换（球/平面/盒），默认显示 */
  showShapeSwitch?: boolean
  /**
   * 是否显示「自定义渲染」调参面板（2026-10 用户反馈第 3 条，需求书 §3.3），
   * 默认显示；面板**默认收起**（一个按钮，不占常驻空间）。
   * 规范 §3.7 的独立弹窗（CustomRenderDialog）不走此内嵌面板（传 false），滑块在弹窗右侧。
   */
  enableParamPanel?: boolean
  /**
   * 外部受控调参（规范 §3.7 弹窗用）：弹窗右侧滑块持有状态，经此 prop 实时同步到场景
   * （只改 material 属性，不重建 WebGL 上下文）。不传 = 组件内部自管（既有行为不变）。
   */
  params?: BallParamScales
  /**
   * 「保存为封面」回调：组件用**当前参数**离屏渲一帧 JPEG Blob 交给调用方落盘。
   * 不传 = 面板里不显示保存按钮（调参仍然可用）。
   * 落盘接线（DetailPanel 接入时照抄，见本文件末尾注释）：
   * Blob → base64 → `window.modvault.setCoverImage({ source:'clipboard', data })`
   * → `useVault.getState().setCover(id, res.rel)`（coverSource='manual' + 缩略图重生）。
   */
  onSaveAsCover?: (blob: Blob) => Promise<void> | void
  /**
   * 参数变化回调（2026-10 调参持久化，docs/12 §5.3 方案 A）。
   *
   * 组件本身**不写库**（组件层不该碰 Dexie / store），由调用方接：
   * `onParamsChange={(s) => void useVault.getState().persistRenderParams(asset.id, s)}`。
   * 「恢复默认」也会走这里（方案 A：UI 重置 + 同时落库），所以调用方拿到的是
   * 规范化前的原始值——`persistRenderParams` 内部会 `normalizeParams`。
   * 不传 = 纯 UI 状态（既有行为不变）。
   */
  onParamsChange?: (scales: BallParamScales) => void
  /**
   * 形态变化回调（2026-10 缓存策略：**形态是球图身份的一部分**）。
   *
   * 组件本身**不写库**（与 `onParamsChange` 同一纪律），由调用方接：
   * `onShapeChange={(s) => void useVault.getState().setRenderShape(asset.id, s)}`。
   * 调用方应同时把 `defaultShape` 传成 `resolveRenderShape(asset)`，否则用户切了形状、
   * 下次启动又变回球面（而卡片上的球图是按新形态渲的 → 图文不一致）。
   * 不传 = 纯 UI 状态（既有行为不变）。
   */
  onShapeChange?: (shape: BallShape) => void
  /**
   * 默认 true：落定后持续自转。
   * 舞台的「单击生成的球」传 false（用户嫌球乱动）；不传 = 弹窗现状不变。
   */
  autoRotate?: boolean
  /**
   * 暴露命令式入口给舞台层用。不传 = 现状（不创建 API 对象）。
   * 用 ref 而不是回调，是为了让调用方在任意时刻拿到最新实例而不触发重渲染。
   */
  apiRef?: MutableRefObject<MaterialBallApi | null>
  /**
   * 'full' 保留内嵌调参面板与形态切换；'bare' 只渲染球体本身（舞台用：
   * 不渲染按钮、不留 padding、球撑满容器）。默认 'full' = 弹窗现状一字不变。
   */
  chrome?: 'full' | 'bare'
  /** 容器需要确定高度（如 aspect-[4/3] / h-64），组件自身不定高 */
  className?: string
}

/**
 * Blob → base64（**不含** `data:` 前缀，与 `thumb:saveBall` /
 * `asset:setCoverImage` 的 base64 入参约定一致）。
 * 导出供 DetailPanel 接「保存为封面」时复用，避免再造一份 FileReader 胶水。
 */
export function blobToBase64(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      const idx = s.indexOf(',')
      resolve(idx >= 0 ? s.slice(idx + 1) : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/**
 * 实时材质球。
 *
 * 接入建议（给 DetailPanel owner，2026-10 调参渲染已内置）：
 * ```tsx
 * const slots = useMemo(() => materialSlots(asset.files), [asset.files])
 * {hasMaterialSlots(slots) && (
 *   <div className="aspect-square w-full">   {/* 材质类预览 1:1，需求书 §3.4 *\/}
 *     <MaterialBall
 *       relFolder={asset.relFolder}
 *       slots={slots}
 *       onSaveAsCover={(blob) => saveBallBlobAsCover(asset, blob)}
 *     />
 *   </div>
 * )}
 * ```
 * 其中「保存为封面」的落盘胶水（复用**既有** IPC 与 store 方法，**无需新 IPC**）：
 * ```ts
 * import { blobToBase64 } from './MaterialBall'
 * async function saveBallBlobAsCover(asset: Asset, blob: Blob): Promise<boolean> {
 *   const base64 = await blobToBase64(blob)
 *   if (!base64) return false
 *   const res = await window.modvault
 *     .setCoverImage({ assetId: asset.id, folder: asset.folder, source: 'clipboard', data: base64 })
 *     .catch(() => null)
 *   if (!res) return false
 *   await useVault.getState().setCover(asset.id, res.rel)  // coverSource='manual' + 缩略图重生
 *   return true
 * }
 * ```
 * 选型说明：走 `asset:setCoverImage` 而不是 `thumb:saveBall`——后者只写
 * thumbs 缓存目录（缩略图用途），封面必须落在资产文件夹内并被索引
 * （`<资产名>.cover.jpg` + coverSource='manual'），rescan 才不会把封面洗掉。
 *
 * 网格缩略图侧：选中/导入时 `renderBallToPng(asset.relFolder, slots, { params })` 存
 * `ballThumbName(asset.id, slots, params)`（`.png`，透明背景）到 thumbs 目录
 * （既有 `thumb:saveBall` IPC），之后网格走既有 `vault://thumb/<name>` 通道，不开 WebGL。
 */
export function MaterialBall({
  relFolder,
  slots,
  defaultShape = 'sphere',
  textureUrls,
  showShapeSwitch = true,
  enableParamPanel = true,
  autoRotate = true,
  apiRef,
  chrome = 'full',
  params,
  onSaveAsCover,
  onParamsChange,
  onShapeChange,
  className
}: MaterialBallProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<BallScene | null>(null)
  const bare = chrome === 'bare'
  // apiRef / autoRotate 用 ref 持有最新值：它们变化不该重建场景（重建 = 重传贴图）
  const apiRefRef = useRef(apiRef)
  apiRefRef.current = apiRef
  const autoRotateRef = useRef(autoRotate)
  autoRotateRef.current = autoRotate
  const [shape, setShape] = useState<BallShape>(defaultShape)
  /** 当前形态的最新值（`MaterialBallApi.getShape` 建在 deps:[] 的 effect 里，不能用闭包） */
  const shapeRef = useRef(shape)
  shapeRef.current = shape
  // 调参渲染（需求书 §3.3）：面板默认收起，滑块实时作用于预览；
  // 受控 params（§3.7 弹窗）优先：外部状态 → 内部 state → 场景
  const [paramOpen, setParamOpen] = useState(false)
  // 六参数化后**必须**规范化一次：`params` 里 light/metal/alpha 可选（历史参数只有三个），
  // 直接拿来当状态会让滑块 `value={undefined}` 变成非受控输入。
  const [scales, setScales] = useState<NormalizedBallParams>(() => normalizeParams(params))
  const [saving, setSaving] = useState(false)
  /**
   * 场景里**当前**倍率（任务 1）。
   *
   * 建场景 effect 的 deps 固定为 `[]`（renderer 跟组件同生共死），它在挂载时读到的是
   * **闭包里的旧 scales**。必须经 ref 取最新值，否则「构造时带上 params」也可能带上
   * 一个过期对象（例如弹窗首帧 params 在 mount 之后才变成非默认值）。
   */
  const scalesRef = useRef(scales)
  scalesRef.current = scales
  /**
   * 贴图批次落定的版本号（任务 1 收敛点）。
   *
   * `BallScene` 在 `applyMaps` 全部落定后回调 +1；下面的同步 effect 依赖它，
   * 于是"贴图就绪"这件事**必然**再触发一次按当前 scales 的同步 ——
   * 不是靠 setTimeout/rAF 猜时序，而是状态机给的事件。
   */
  const [mapsVersion, setMapsVersion] = useState(0)

  /**
   * 参数落库（docs/12 §5.1）：组件**不写库**（组件层不该碰 Dexie / store），
   * 只把变化抛给调用方，且**防抖 400ms**——滑块 `onChange` 每帧都触发，
   * 不防抖会每帧一次 `db.assets.put` + 一次 WebGL 重渲。
   */
  const notifyRef = useRef<number | null>(null)
  const notifyParams = (next: BallParamScales): void => {
    if (!onParamsChange) return
    if (notifyRef.current !== null) window.clearTimeout(notifyRef.current)
    notifyRef.current = window.setTimeout(() => {
      notifyRef.current = null
      onParamsChange(next)
    }, PARAM_PERSIST_DEBOUNCE_MS)
  }
  useEffect(
    () => () => {
      if (notifyRef.current !== null) window.clearTimeout(notifyRef.current)
      notifyRef.current = null
    },
    []
  )

  /** 滑块 / 恢复默认的统一入口：改 UI 状态 + 抛给调用方（方案 A：重置即落库） */
  const applyScales = (next: BallParamScales): void => {
    // 规范化后再进 state：新参数可选，`{...scales, roughness}` 里 light/metal/alpha 可能是
    // undefined（历史参数），直接进 state 会让滑块变成非受控输入。
    const normalized = normalizeParams(next)
    setScales(normalized)
    notifyParams(normalized)
  }

  // 受控同步：弹窗滑块拖动 → params 变 → 内部 state 变 → 既有 effect 应用到场景
  useEffect(() => {
    if (params) setScales(normalizeParams(params))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    params?.roughness,
    params?.bump,
    params?.uv,
    params?.light,
    params?.metal,
    params?.alpha,
    // 0.7.6 灰度透明：**必须显式列出**，否则弹窗里勾了开关球不动
    params?.alphaFromMap,
    params?.invertAlpha
  ])

  // 滑块 → 场景（只改 material 属性，不重建 WebGL 上下文）。
  // ★ `mapsVersion` 也进 deps（任务 1）：贴图批次落定后必须再同步一次，
  //   否则「构造时带了 params、但落定前又被基准复位吃掉」的窗口会停在临时值上。
  useEffect(() => {
    ballRef.current?.setParamScales(scales)
  }, [scales, mapsVersion])

  // 贴图 URL：props 覆盖优先，否则按 vault:// 协议拼。
  // 用 ref 持有最新值，供「建场景」effect 首帧读取（不进 deps，避免对象标识抖动重建场景）
  const urls = textureUrls ?? slotUrls(relFolder, slots)
  const urlsRef = useRef<MaterialSlotUrls>(urls)
  urlsRef.current = urls
  const urlsKey = JSON.stringify(urls)
  /**
   * 灰度透明的开关（0.7.6）：`applyMaps` 要不要额外把 albedo 挂成 alphaMap 由它决定。
   *
   * 它必须进 effect B 的 deps：只按 `urlsKey` 触发的话，勾选 / 取消勾选不会重新
   * 收集 entries → 用户会觉得"勾了没反应"（或者只有关掉弹窗重开才生效）。
   * 重新跑一次 applyMaps 会重挂全部贴图，但位图解码走 `textureBitmapCache` 命中，
   * 只付上传成本（~几十毫秒），换正确性值得。
   */
  const alphaMapEnabled = scales.alphaFromMap === true

  // ── effect A：建/卸场景（**只在挂载时创建一次 renderer**） ────────────────
  // 性能纪律（2026-10 舞台掉帧修复）：WebGLRenderer / 上下文 / PMREM 烘焙 / shader
  // program 全部绑在 renderer 上，换资产时重建 = 一次完整重编译 + 重新烘焙。
  // 舞台的资产由 hover 的 preview() 喂进来，鼠标扫过一串卡就是连建十几个 renderer
  // （sharedEnvironment 的按-renderer 缓存也全部失效）——这是双击瞬间掉帧的主因。
  // 因此 deps 固定为 []：renderer 跟组件同生共死，换资产只换贴图（effect B）。
  // 隐藏收益：deps 为 [] 的 cleanup 语义就等于"卸载时清理"，不需要额外的卸载 effect。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    host.appendChild(canvas)

    let ball: BallScene
    try {
      ball = new BallScene(canvas, { shape, interactive: true })
      // ★ 任务 1（P1 缺陷）修复点：**建完立刻**把当前倍率同步进去。
      //   声明顺序上 `[scales]` 的同步 effect 在本 effect 之前执行，那时 ballRef 还是
      //   null → 空转；不同步的话场景永远停在 DEFAULT（首帧"默认质感"，拖滑块才对）。
      //   本行与下一个 effect（换贴图）在同一个提交里先后执行，贴图开始加载前倍率已就位。
      ball.setParamScales(scalesRef.current)
      // 贴图落定 → 版本号 +1 → 上面的同步 effect 再按当前 scales 同步一次。
      // 材质就绪**必然**触发一次重算，不依赖任何定时器猜测。
      ball.setMapsSettledListener(() => setMapsVersion((v) => v + 1))
    } catch (err) {
      // GPU 不可用 / 上下文创建失败：留空画布，不炸掉整个界面
      console.warn('[MaterialBall] WebGL 上下文创建失败：', err)
      canvas.remove()
      return
    }
    ballRef.current = ball
    // 让弹窗保持现状：autoRotate 默认 true，等价于改造前硬编码的 true
    ball.setAutoRotate(autoRotateRef.current)
    // 命令式入口（舞台用）。不传 apiRef 就不建，零成本
    if (apiRefRef.current) {
      const myApi: MaterialBallApi = {
        setPose: (z) => ball.setPose(z),
        isReady: () => ball.isReady(),
        setRunning: (on) => ball.setRunning(on),
        warm: () => ball.renderOnce(),
        setCameraDistance: (d) => ball.setCameraDistance(d),
        sphereScreenDiameter: () => ball.sphereScreenDiameter(),
        // 走 ref：myApi 在 deps:[] 的挂载 effect 里只建一次，闭包里的 shape 会过期
        getShape: () => shapeRef.current
      }
      apiRefRef.current.current = myApi
    }

    const fit = () => {
      const r = host.getBoundingClientRect()
      ball.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)))
    }
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    ball.startLoop()

    return () => {
      // deps 为 []，所以这里等价于"卸载时清理"：把上下文完整归还
      ro.disconnect()
      if (apiRefRef.current) apiRefRef.current.current = null
      ballRef.current = null
      ball.dispose()
      canvas.remove()
    }
    // shape 只取挂载时的值（后续切换走 setShape effect）；build 一次即够
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── effect B：换资产 = 只换贴图（复用同一个 renderer / 同一张上下文） ──────
  // 首帧也会跑一次，与原实现"建场景时立刻 applyMaps"等价；
  // 之后 urlsKey 变化只做 dispose 旧贴图 + 加载新贴图，不碰 renderer。
  useEffect(() => {
    void ballRef.current?.applyMaps(urlsRef.current)
  }, [urlsKey, alphaMapEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * `defaultShape` 变化 → 同步内部形态（2026-10 缓存策略：记住形状）。
   *
   * 为什么需要：舞台/详情复用的是**同一个** MaterialBall（换资产不重建 renderer），
   * `useState(defaultShape)` 只在挂载时读一次 → 换到一个"记住是平面"的资产时球还是上一个
   * 资产的形状，而卡片上的球图是按平面渲的 → 图文不一致。
   * 用户在内嵌面板里手动切形状不会改这个 prop，所以本 effect 不会把用户的选择打回去。
   */
  useEffect(() => {
    setShape(defaultShape)
  }, [defaultShape])

  // 形态切换：只换几何体，不重建 WebGL 上下文
  useEffect(() => {
    ballRef.current?.setShape(shape)
  }, [shape])

  // 自转开关：只改 controls.autoRotate，不重建场景
  useEffect(() => {
    ballRef.current?.setAutoRotate(autoRotate)
  }, [autoRotate])

  /**
   * 动效性能档位（设置·外观三档）→ 热应用到已挂载的场景。
   *
   * 用 `useSyncExternalStore` 而不是从 store 读：本组件被舞台持有整场会话
   * （换资产不重建 renderer），必须能感知"用户刚改了滑块"。`getSnapshot` 是
   * `currentMotionProfile`，它返回配置表里的稳定引用，所以不会自激重渲染。
   * 首帧这个 effect 与构造函数读到的值一致（幂等）。
   */
  const profile = useSyncExternalStore(
    subscribeMotionProfile,
    currentMotionProfile,
    currentMotionProfile
  )
  useEffect(() => {
    ballRef.current?.applyMotionProfile(profile)
  }, [profile])

  /**
   * 「保存为封面」：当前参数离屏渲一帧 → Blob 交给调用方落盘（需求书 §3.3）。
   *
   * 2026-10-23 用户拍板：**封面一律透明 PNG**（"不需要是 JPG"）。
   * 卡片走封面缩略图时会透出 `bg-canvas`，方底/黑边从根上消失；
   * `renderBallToJpeg` 已不再用于封面，别接回来（有源码守卫）。
   */
  const saveCover = async () => {
    if (!onSaveAsCover || saving) return
    setSaving(true)
    try {
      const blob = await renderBallToPng(relFolder, slots, {
        shape,
        size: 480,
        params: scales
      })
      await onSaveAsCover(blob)
    } catch (err) {
      console.warn('[MaterialBall] 保存封面失败：', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={bare ? `relative overflow-hidden ${className ?? ''}` : `relative overflow-hidden bg-canvas ${className ?? ''}`}>
      <div
        ref={hostRef}
        className={bare ? 'h-full w-full' : 'h-full w-full cursor-grab active:cursor-grabbing'}
      />
      {!bare && showShapeSwitch && (
        <div className="absolute right-2 top-2 flex overflow-hidden rounded-lg border border-line bg-card/90 text-[11px] shadow-sm ">
          {SHAPE_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              title={`${SHAPE_LABEL[s]}预览`}
              className={`px-2 py-1 transition ${
                shape === s ? 'bg-accent text-white' : 'text-muted hover:text-primary'
              }`}
              onClick={() => {
                setShape(s)
                // 形态是球图身份的一部分：调用方据此落库（组件不写库）
                onShapeChange?.(s)
              }}
            >
              {SHAPE_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      {/* 调参渲染面板（需求书 §3.3）：默认收起，按钮展开，不占常驻空间。bare 态整块不渲染 */}
      {!bare && enableParamPanel && (
        <>
          <button
            type="button"
            className={`absolute left-2 bottom-2 rounded-lg border px-2 py-1 text-[11px] shadow-sm transition ${
              paramOpen
                ? 'border-accent/50 bg-card text-accent'
                : 'border-line bg-elevated/90 text-muted hover:text-primary'
            }`}
            onClick={() => setParamOpen((o) => !o)}
            title="自定义渲染：光线 / 材质 / UV 调参后可保存为封面"
          >
            自定义渲染{paramOpen ? ' ▾' : ' ▸'}
          </button>
          {paramOpen && (
            <div className="absolute bottom-9 left-2 max-h-[336px] w-52 overflow-y-auto rounded-xl border border-line bg-card/95 p-3 text-[11px] shadow-pop">
              {/* 顺序（0.6.9 用户拍板）：光线强度 → 反光强度 → 凹凸强度 → 金属度 → 透明度 → UV 大小 */}
              <label className="block">
                <span className="flex items-baseline justify-between text-muted">
                  光线强度
                  <span className="font-medium text-primary">×{scales.light.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.05}
                  value={scales.light}
                  onChange={(e) => applyScales({ ...scales, light: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title="环境光照度：跟贴图颜色无关，只把球照亮 / 调暗（0.2–2）"
                />
              </label>
              <label className="mt-2 block">
                <span className="flex items-baseline justify-between text-muted">
                  反光强度
                  <span className="font-medium text-primary">×{scales.roughness.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={scales.roughness}
                  onChange={(e) => applyScales({ ...scales, roughness: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title="roughness 倍率：越大越哑光（0 = 镜面）"
                />
              </label>
              <label className="mt-2 block">
                <span className="flex items-baseline justify-between text-muted">
                  凹凸强度
                  <span className="font-medium text-primary">×{scales.bump.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={scales.bump}
                  onChange={(e) => applyScales({ ...scales, bump: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title="法线 / 置换倍率：越大凹凸越明显（0 = 拍平）"
                />
              </label>
              <label className="mt-2 block">
                <span className="flex items-baseline justify-between text-muted">
                  金属度
                  <span className="font-medium text-primary">{Math.round(scales.metal * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={scales.metal}
                  onChange={(e) => applyScales({ ...scales, metal: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title="金属度：0 = 非金属（现状），1 = 纯金属（金属靠环境反射出质感）"
                />
              </label>
              <label className="mt-2 block">
                <span className="flex items-baseline justify-between text-muted">
                  {scales.alphaFromMap ? '整体不透明度' : '透明度'}
                  <span className="font-medium text-primary">{Math.round(scales.alpha * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={scales.alpha}
                  onChange={(e) => applyScales({ ...scales, alpha: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title={
                    scales.alphaFromMap
                      ? '整体不透明度：逐像素分布由灰度图决定，这个滑块在最外层整体缩放（100% = 不额外压暗）'
                      : '不透明度：100% = 不透明（默认），越小越透'
                  }
                />
              </label>
              {/* 0.7.6：灰度透明开关紧跟在透明度滑块下方（用户要的「分布 + 强度」是同一个心智模型） */}
              <AlphaMapToggles
                className="mt-2"
                alphaFromMap={scales.alphaFromMap}
                invertAlpha={scales.invertAlpha}
                onChange={(next) => applyScales({ ...scales, ...next })}
                compact
              />
              <label className="mt-2 block">
                <span className="flex items-baseline justify-between text-muted">
                  UV 大小
                  <span className="font-medium text-primary">×{scales.uv.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={scales.uv}
                  onChange={(e) => applyScales({ ...scales, uv: Number(e.target.value) })}
                  className="slider-accent mt-1 w-full"
                  title="贴图平铺倍率：越大贴图越小（平铺越密）"
                />
              </label>
              <div className="mt-3 flex items-center justify-between">
                {/* docs/12 §5.3 方案 A：UI 重置 + 同时落库（走 applyScales → onParamsChange）。
                    落库后 hash 仍走 §3.3 的最短表示（默认参数不贡献 hash）→ 缓存命中既有文件、不重渲。
                    文案改为「恢复默认（并保存）」，避免用户以为只是预览。
                    ⚠️ 未接 onParamsChange 时退化为纯 UI 重置（既有行为不变）。 */}
                <button
                  type="button"
                  className="text-muted transition hover:text-primary"
                  onClick={() => applyScales(DEFAULT_PARAM_SCALES)}
                  title="恢复默认（1 倍）并保存"
                >
                  恢复默认（并保存）
                </button>
                {onSaveAsCover && (
                  <button
                    type="button"
                    className="btn btn-primary !px-2 !py-1 text-[11px]"
                    disabled={saving}
                    onClick={() => void saveCover()}
                    title="按当前参数离屏渲染一帧，存为该资产封面（可随时在详情面板换回）"
                  >
                    {saving ? '渲染中…' : '保存为封面'}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export interface RenderBallOptions {
  /** 边长像素，默认 480（与 DEFAULT_THUMB_MAX_PX 对齐） */
  size?: number
  /** 形态，默认球 */
  shape?: BallShape
  /**
   * 背景色（CSS 颜色串）。**只对 `format:'jpeg'` 生效**，默认 `paperColor()`
   * （v0.2.1 增补 1：读 --render-canvas-bg，浅色白 / 深色 #1C1C1E）。
   * `format:'png'` 时忽略此项——PNG 走透明画布（见 `renderBallToPng` 的说明）。
   */
  background?: string
  /** 覆盖贴图 URL（默认 vault://） */
  textureUrls?: MaterialSlotUrls
  /** 调参渲染倍率（需求书 §3.3）；不传 = 默认 1 倍（store 既有调用不受影响） */
  params?: BallParamScales
  /**
   * 输出格式，默认 `'jpeg'`（既有行为一字不变：纸色背景 + 0.85 质量）。
   *
   * - `'jpeg'`：不透明，背景色烤进像素（「保存为封面」走这条，用户在文件管理器里
   *   看到的就是这张带底的图）；
   * - `'png'`：**透明背景**（BallScene 在 `background === undefined` 时用
   *   `alpha:true` + 清屏色 0），球图缩略图走这条。
   */
  format?: 'jpeg' | 'png'
}

/**
 * 离屏渲染一帧材质球 → Blob（内部实现，不导出）。
 *
 * 两种格式的差异只有两处，其余（自建自销 WebGL 上下文、贴图加载、单帧渲染、
 * 全量 dispose）完全共用：
 * - `'jpeg'`：`background = opts.background ?? paperColor()`（不透明画布）+
 *   `image/jpeg` 0.85；
 * - `'png'`：`background = undefined`（BallScene 里即 `alpha:true` +
 *   `setClearColor(0x0000, 0)`）+ `image/png`（无质量参数，PNG 是无损的）。
 *
 * 内部自建自销一个 WebGL 上下文（dispose + forceContextLoss），
 * 与详情面板实时球错峰使用即可，不会叠加上下文占用。
 */
async function renderBallBlob(
  relFolder: string,
  slots: MaterialSlots,
  opts: RenderBallOptions = {}
): Promise<Blob> {
  const format = opts.format ?? 'jpeg'
  const size = opts.size && opts.size > 0 ? Math.floor(opts.size) : 480
  const urls = opts.textureUrls ?? slotUrls(relFolder, slots)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  // PNG：background 必须**不传**（不是传空串），BallScene 靠 `undefined` 判定透明画布。
  // JPEG：显式色 → 否则 `paperColor()`（主题画布色）。规则集中在 `resolveBallBackground`，
  // 单测直接锁这条口径（不许回落成纯黑）。
  const background = resolveBallBackground(format, opts.background)

  const ball = new BallScene(canvas, {
    shape: opts.shape ?? 'sphere',
    interactive: false,
    size,
    background,
    preserveDrawingBuffer: true,
    params: opts.params ?? DEFAULT_PARAM_SCALES
  })
  try {
    await ball.applyMaps(urls)
    ball.renderOnce()
    return await new Promise<Blob>((resolve, reject) => {
      const done = (b: Blob | null): void =>
        b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))
      if (format === 'png') canvas.toBlob(done, 'image/png')
      else canvas.toBlob(done, 'image/jpeg', 0.85)
    })
  } finally {
    ball.dispose()
  }
}

/**
 * 离屏渲染一帧材质球 → **JPEG** Blob（不透明、纸色背景）。
 *
 * ⚠️ **已不再用于封面**（2026-10-23 用户拍板：封面一律透明 PNG，见
 * `renderBallToPng`）。保留导出只因为它是"带底输出"的唯一实现（给外部看图 /
 * 导出场景用）；**别把它接回封面路径**——不透明的底会在卡片上变成一块方色块。
 *
 * 球图缩略图与封面**都不要**用这个，用 `renderBallToPng`（透明背景）。
 */
export async function renderBallToJpeg(
  relFolder: string,
  slots: MaterialSlots,
  opts: RenderBallOptions = {}
): Promise<Blob> {
  return renderBallBlob(relFolder, slots, { ...opts, format: 'jpeg' })
}

/**
 * 离屏渲染一帧材质球 → **透明背景 PNG** Blob。
 *
 * 两个用途：**球图缩略图** + **「保存为封面」**（2026-10-23 用户拍板：封面也走透明 PNG，
 * 这样 `manual` 封面 → 缩略图（`toPNG()` 保 alpha）→ 卡片透出画布色，不会出现方底）。
 *
 * 为什么必须透明：网格卡片的封面容器自带 `bg-canvas`（浅色 #FFFFFF / 深色 #1C1C1E）。
 * 透明像素会透出卡片自身的画布色，于是**同一个缓存文件在深浅两个主题下都正确**
 * ——缓存名（`shared/ballParams.ts: ballThumbName`）不含主题，也不需要按主题分目录
 * 或在切主题时重渲。反过来说：JPEG 无 alpha 通道，只能把当时的背景色烤进像素，
 * 一旦在浅色主题下渲过，切到深色主题就是一块亮白方块（本次修复的缺陷）。
 *
 * 落盘路径与 JPEG 完全相同（`thumb:saveBall` IPC → thumbs 目录），只是文件名以
 * `.png` 结尾；`parseThumbFileName / deleteThumb / pruneThumbs / thumbStats`
 * 本来就同时接受 jpg/png（`THUMB_EXTS`），缓存管理零改动。
 */
export async function renderBallToPng(
  relFolder: string,
  slots: MaterialSlots,
  opts: RenderBallOptions = {}
): Promise<Blob> {
  return renderBallBlob(relFolder, slots, { ...opts, format: 'png' })
}
