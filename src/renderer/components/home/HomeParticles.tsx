/**
 * 首页封面页 · 粒子海面背景（React 壳）。
 *
 * 只干四件事，其余全部交给 `./particleTide.ts`：
 *  1. **尺寸**：canvas 铺满父容器（父级的 `absolute inset-0 pointer-events-none`
 *     由调用方 `HomeCover` 给，本组件不改父布局），`ResizeObserver` → `resize()`；
 *     pixelRatio 上限取 `MOTION_PROFILES[quality].dprCap`（唯一口径，不写死 2/3）。
 *  2. **时钟**：累计**相位增量**（`delta = min(now - last, 64ms) * speed`），不用
 *     绝对时间戳 —— 否则切回窗口/失焦恢复会整段跳帧。失焦与 `document.hidden`
 *     时暂停 RAF，恢复时**接续**累计时间（不重置）。
 *  3. **降级**：三档质量 → 粒子密度乘数 + 帧率；`prefers-reduced-motion: reduce`
 *     → 不开 RAF，只在尺寸变化后画一帧静态海面（time=0）。
 *  4. **指针交互**：`pointermove` / `pointerdown` / `pointerleave` 挂在 **window**
 *     上（本组件的 canvas 是 `pointer-events-none`，改它会吞掉文件夹卡片的 hover），
 *     再用 `getBoundingClientRect()` 换算成画布内 CSS 坐标，rAF 节流后交给
 *     `renderer.setPointer()` / `renderer.ripple()`。
 *
 * 配色走主题（浅色 = 压深的海蓝/沙色 / 深色 = 参考站原色），并用 `MutationObserver` 盯
 * `document.documentElement.dataset.theme`：切换主题后重设 settings 并立即重绘。
 * 画布底色取 `--bg-canvas`（和首页底色同值），配合整块 canvas 的 opacity，
 * 观感就是「透明底 + 起伏海面」，压在上面的字与卡片始终可读。
 *
 * ⛔ 禁令复核：本组件不用 `filter: blur` / `backdrop-filter` / 任何渐变
 * （`src/renderer/styles.css` 头部：装饰性渐变与玻璃拟态全禁）。
 *
 * 纪律：零新增依赖；只依赖 react + 两个本地模块。React 18 StrictMode 会挂载两次，
 * 所以 cleanup 必须把 RAF / observer / 事件监听 / renderer 全部拆干净（幂等）。
 */
import { useEffect, useRef, type ReactElement } from 'react'
import { MOTION_PROFILES } from '../../../shared/motionQuality'
import type { MotionQuality } from '../../../shared/types'
import { createTideRenderer, type TideRenderer, type TideSettings } from './particleTide'

/** 组件 props（由 `HomeCover` 传入；签名定死，勿改）。 */
export interface HomeParticlesProps {
  /** 动效性能档位（决定 DPR 上限 / 粒子密度 / 是否限帧） */
  quality: MotionQuality
}

/** 密度乘数的物理边界（与 `particleTide.ts` 内部夹取范围一致）。 */
const MIN_DENSITY = 0.3
const MAX_DENSITY = 2

/**
 * 与主题无关的基准量：波长 / 速度。两套主题共用一份（物理量不随配色变）。
 *
 * 取值 = 用户在参考站（TuneShape「粒子海浪」）调参面板上定稿的值：
 * 海浪速度 1.6 / 波长 1.1。**不要再在 palette 里各写一份** —— 它们和颜色无关。
 */
const BASE_WAVELENGTH = 1.1
const BASE_SPEED = 1.6

/**
 * 档位 → 粒子密度乘数（**降级口径的唯一来源**）。
 * `smooth` 砍到 45%（省电优先，海面依旧连续），`ultra` 加 15%。
 * 注意这是**在主题基准密度之上**再乘的系数（见 `TidePalette.density`）。
 */
const DENSITY_FACTOR: Record<MotionQuality, number> = {
  smooth: 0.45,
  balanced: 1,
  ultra: 1.15
}

/** `smooth` 档限帧：约 30fps（累计跨过 33.3ms 才画一帧）。 */
const SMOOTH_MIN_FRAME_MS = 1000 / 30

/** 单帧最大相位增量（ms）：卡顿/切窗口回来时最多补 64ms，避免整段跳跃。 */
const MAX_FRAME_DELTA_MS = 64

/**
 * 单主题的完整配色 + 颗粒参数 + 交互参数。
 *
 * 两套主题**共用同一组海面物理量**（速度 / 波长 / 密度 / 浪高 / 颗粒直径，取值见
 * `LIGHT_PALETTE` 上方那张表），只在**颜色与对比度**上分档：这个引擎的 alpha 模型是
 * 给深底设计的（0.035 地板），浅底上必须靠配色 + `alphaScale` 单独把颗粒"压"出来，
 * 否则整层等于不存在。所以这里既留颜色旋钮也留 `alphaScale` / `opacity` 旋钮。
 *
 * 颜色是**主要**的调色旋钮：想换海面观感只改下面两个常量，别去动 `particleTide.ts`
 * （引擎只管"把 #RRGGBB 解析成 RGB"，不理解语义）。
 */
interface TidePalette {
  /** 画布底色的兜底值（读不到 `--bg-canvas` 时用它） */
  backgroundColor: string
  /** 水体色（crest≈0 的粒子，占绝大多数） */
  waterColor: string
  /** 浪峰色（crest→1 的粒子，稀疏） */
  crestColor: string
  /** 整块 canvas 的不透明度（只影响颗粒对比，压不到上层文字） */
  opacity: number
  /** 传给渲染器的 alpha 系数（1 = 参考实现原样） */
  alphaScale: number
  /** 该主题的基准粒子密度（档位乘数再乘它） */
  density: number
  /** 浪高乘数（越大起伏越明显） */
  waveHeight: number
  /** 粒子直径乘数（越大颗粒越"沙"、越不像抖动的噪点） */
  particleSize: number
  /** 是否启用指针交互（涌浪 + 视差）。首页背景要"活的"，两套主题都开 */
  interactive: boolean
  /** 涌浪强度倍率（1 = 参考实现原样） */
  swell: number
  /** 涌浪半径（世界单位，0.9 = 参考实现原样） */
  swellRadius: number
  /** 视差强度倍率（1 = 参考实现原样） */
  parallax: number
  /** 是否启用点击涟漪 */
  clickRipples: boolean
}

/**
 * ── 海面参数（density / waveHeight / particleSize / speed / wavelength）的来历 ──
 * 2026-10 第三轮：用户在自己浏览器里打开参考站 TuneShape「粒子海浪」，在调参面板上
 * 把这组值调到了满意的效果，并要求"海浪速度等各方面的参数按调好的来做"。面板定稿值：
 *
 *   | 面板项   | 值     | 落点                                  |
 *   |----------|--------|---------------------------------------|
 *   | 海浪速度 | 1.6    | `BASE_SPEED`                          |
 *   | 海浪高度 | 0.65   | `TidePalette.waveHeight`              |
 *   | 粒子大小 | 2 ← 3  | `TidePalette.particleSize`（见 §1.5） |
 *   | 粒子密度 | 1.5    | `TidePalette.density`（再乘档位系数） |
 *   | 波长     | 1.1    | `BASE_WAVELENGTH`                     |
 *   | 指针交互 | 开     | `interactive` / `swell` / `parallax`  |
 *   | 点击涟漪 | 开     | `clickRipples`                        |
 *
 * ── §1.5 · 为什么 `particleSize` 从参考站的 3 改成 2 ─────────────────────────
 * 2026-11-09 用户反馈：「粒子大小在我们的软件里面目前实现出来有点偏大，变成了 1.5 倍」。
 * 参考站面板上的值确实是 **3**，但**同一个 3 在两边的最终像素直径不一样**，因为顶点
 * 着色器里的直径公式多了一项分辨率系数：
 *
 *   footprint = particleSize * (.12 + .3/depth) * (.75 + jitter*.5) * resolution.x/320
 *                                                                    ^^^^^^^^^^^^^^^^
 * 在 1080 CSS 宽 / dpr=1 时这一项 = **3.375**，于是近岸（depth≈1）一颗 size=3 的粒子
 * 直径约 4.3 设备像素。**÷1.5 是"对齐观感"，不是改物理**：3 ÷ 1.5 = 2，正好对上用户
 * 量出来的 1.5 倍，所以这里取 **2**，公式与其它参数一个都不动。
 *
 * 顺带记两笔（免得后来人再怀疑）：
 *  · `particleSize` 同时进 `min(1., footprint*footprint)` 这个"覆盖率"项，但 3→2 之后
 *    footprint² 仍远大于 1（近岸 8.0 / 远岸 3.7）→ 该项恒为 1 → **每颗粒子的 alpha
 *    完全不变**，改的只有直径/覆盖面（那正是用户要的）。整套 alpha 分布（含 0.98 上限
 *    的触发比例 0.06%）两档逐项相同。
 *  · `density 1.5 / waveHeight 0.65 / speed 1.6 / wavelength 1.1` 一律**未动**。
 *
 * 两套主题共用同一组数值：这些都是"物理量"，换配色不该换手感。历史上浅色单独用过
 * `waveHeight 1.5 / density 0.95 / particleSize 1.15`（当时是为了让浅底上看得见海面），
 * 那套参数**已作废**。
 */
/**
 * 浅色 = **同一组色相（海蓝 206° / 暖沙 35°）按明度压深**，不是照抄深色的色值。
 *
 * 为什么不能照抄：用户给的参考站色值是给深底（#111113）调的。`#efdabd`（暖沙，
 * L* 88.0）压在 `#f8fafc`（L* 98.0）上对比只有 **1.30:1**，肉眼等于没有；`#0091ff`
 * 在近白底上又太亮、整层会糊成一片浅蓝（它自己的对比也只有 3.09:1，而这层颗粒是
 * 半透明叠上去的，等效对比还要再折掉一大半）。所以浅色取"**色相与饱和度不变，只压
 * 明度**"，这是把参考站那一对颜色搬到白底上最不失真的做法（H/S 逐位照抄参考色）：
 *
 *   | 角色 | 参考站（深底用）        | 浅色（白底用）          | 手法 / 依据 |
 *   |------|------------------------|------------------------|-------------|
 *   | 水体 | `#0091ff` hsl(205.9,1.00,0.50) L* 59.4 c 3.09 | `#007ad6` hsl(205.9,1.00,**0.42**) L* 50.4 **c 4.22:1** | 只压 L，S 保持 1.00 |
 *   | 浪峰 | `#efdabd` hsl( 34.8,0.61,0.84) L* 88.0 c 1.30 | `#d9a863` hsl( 34.8,0.61,**0.62**) L* 72.0 **c 2.06:1** | 只压 L，S 保持 0.61（保住"沙"不变成"棕/橙"） |
 *
 *   （c = 与 `--bg-canvas` #f8fafc 的 WCAG 对比度；目标：水体 ≥ 3:1 且不深过
 *    `--text-primary` #1f2937 的 L* 16.3 —— 50.4 远在安全侧；浪峰 ≥ 1.8:1。）
 *
 * 合成到画面上（整帧按 GPU 点精灵混合逐像素复刻，见报告）实测：
 *   水体区 `#f1f5f8`（只在底噪上薄薄一层蓝，不会变成一块蓝板）；
 *   浪峰核区 `#deb57d`（ΔRGB 相对 #d9a863 仅 **+5/+13/+26**，**沙色真的出来了**；
 *   改之前同一处是 `#8492a5`，R−B 为 −33 的蓝灰）；
 *   该区与白底对比 1.82:1 —— 白底上泡沫只能"比水更暖、比底更深"，这是物理上限。
 *
 * ⚠️ **这是全站唯一获准的暖色例外**：用户 2026-11-09 明确要求用参考站的水体/浪峰色
 * （`#0091ff` / `#efdabd`），与 `styles.css:9` 的「全局禁用橙色/棕色高亮」冲突，
 * **以此注为准** —— 例外范围仅限本文件的 `crestColor`（首页粒子海面的浪峰像素），
 * 不得外溢到任何 UI 语义色（accent / badge / 文字 / 描边）。
 *
 * 参考实现的 alpha 公式是 `(.035 + crest*1.5) * exp(-z*.026) * (.7+jitter*.65)`，
 * 那个 **0.035 地板是为 #242426 深底设计的**。搬到 #F8FAFC 上实测：crest≈0 的粒子
 * 只有 3.5% 不透明度、颜色还被 `ink` 往白里推，叠在近白底上等于不存在 —— 整层只能
 * 看到一条极淡的横带（团队实测结论）。所以浅色必须 `alphaScale: 2` 把颗粒压到底色上
 * （上限 0.98 仍在），配色也取「比底暗」方向：浅底上没有"更亮的白"，浪峰只能更深。
 */
const LIGHT_PALETTE: TidePalette = {
  // = --bg-canvas（#f8fafc）。画布底色必须与页面底色**同值**，否则 opacity 混合后
  // 会看到一条色差接缝。
  backgroundColor: '#f8fafc',
  // 水体色 #007ad6 = hsl(205.9, 1.00, 0.42)：**色相/饱和度与参考站 #0091ff 完全一致，
  // 只把明度 0.50 压到 0.42**。与 #f8fafc 的对比度 4.22:1（参考站原值只有 3.09:1，
  // 而颗粒是半透明叠出来的，等效对比还要再折），L* 50.4 —— 远浅于 --text-primary
  // #1f2937 的 L* 16.3，不会和标题抢重量。
  waterColor: '#007ad6',
  // 浪峰色 #d9a863 = hsl(34.8, 0.61, 0.62)：**同样只压明度**（参考站 #efdabd 是
  // hsl(34.8,0.61,0.84)）。饱和度刻意保持 0.61 不动，所以它是"压深的沙"而不是
  // "橙/棕"；与 #f8fafc 的对比度 2.06:1（参考站原值 1.30:1，白底上等于看不见）。
  crestColor: '#d9a863',
  opacity: 1,
  // 浅色必须靠它把颗粒从近白底上"压"出来（0.035 地板是给深底设计的），上限 0.98 卡住。
  // 为什么不跟着深色往下调：实测反而更糊 —— alphaScale 越低，浪峰色被底色稀释越多
  // （见 DARK_PALETTE 的注释里那组实测数），与"让浪花颜色出来"的目标相反。
  alphaScale: 2,
  // 以下三项 = 参考站面板定稿值（浅色下 alphaScale 2 已把颗粒压住，不需要再单独调）。
  density: 1.5,
  waveHeight: 0.65,
  // 3 → 2：÷1.5 对齐观感，理由见上方 §1.5。
  particleSize: 2,
  // 交互：浅色下涌浪/涟漪靠"颗粒被推挤"表现出来，不需要额外加强，直接取参考原值。
  interactive: true,
  swell: 1,
  swellRadius: 0.9,
  parallax: 1,
  clickRipples: true
}

/**
 * 深色 = **参考站原色**：水体 `#0091ff` + 浪峰 `#efdabd`（用户 2026-11-09 指定）。
 *
 * 这是 ID BOX 第一次在深色主题里引入带色相的面 —— 旧的 `#6e6e73 / #c7c7cc` 是
 * "中性灰尘埃"，和深色主题那套无彩 token 一致，但用户明确要求用参考站的水体蓝
 * 与暖沙浪峰，故整块换掉（`--bg-canvas #111113` 不动）。
 *
 * 为什么敢直接照抄（这两条以前被否过）：
 *  · 浪峰**不是 #ffffff**。用户否掉的是纯白（近黑底上单像素过曝成噪点），
 *    `#efdabd`（L* 88.0）过曝程度低一档、还自带沙的暖调 —— 合成到 #111113 上
 *    实测 `#ebd6ba`（R−B +49），够亮成浪尖但不刺眼。
 *  · 水体带蓝在近黑底上不会读成"另一块蓝雾"：0.035 的 alpha 地板只把底色往
 *    #131519 推一点点（R−B 仅 −6），整层仍然是背景而不是内容。
 *
 * ── 为什么 `alphaScale` 保持 1.25（没有按"降 alpha 让颜色出来"的思路往下调）──
 * 现场探针（复刻顶点着色器 + 逐像素合成，深底 #111113，particleSize 2，一帧
 * 188638 颗粒子，取 crest 最高的 1% 所在像素的平均合成色）：
 *
 *   alphaScale | 浪峰区平均色 | R−B | L*   | 结论
 *   -----------|--------------|-----|------|---------------------------
 *   1.25       | `#b0a18d`    | +35 | 67.0 | ← 采用
 *   1.00       | `#a29582`    | +32 | 62.2 | 整体变淡，暖度反而下降
 *   0.85       | `#9b8e7d`    | +30 | 59.8 | 用户说的"颜色"更出不来
 *
 * 即 **alpha 越大暖度越高**：alpha 0.98 时单颗浪峰颗粒合成 `#ebd6ba`，相对参考色
 * `#efdabd` 的 ΔRGB 只有 (−4,−4,−3) —— 色相根本没有被"洗白"，所以这不是 alpha
 * 的问题（真正的原因是 `ink` 曲线，已在 `particleTide.ts` 头部 diff 说明 g 修好：
 * 同一场景下浪峰区 R−B 从 −13 变成 +35）。把 alphaScale 往下调只会让海面更淡，
 * 因此这里保持原值；`opacity: 0.85` 也未动。
 */
const DARK_PALETTE: TidePalette = {
  // = --bg-canvas 深色档（#111113）。同上：必须与页面底色同值。
  backgroundColor: '#111113',
  // 水体色 = 参考站原值（用户逐字给出：RGB 0/145/255）。低 alpha 下只把近黑底
  // 推成极淡的海蓝（合成 #131519），整层仍然"读成背景"。
  waterColor: '#0091ff',
  // 浪峰色 = 参考站原值（用户逐字给出：RGB 239/218/189，暖沙）。**明确不用 #ffffff**。
  crestColor: '#efdabd',
  // 深色下颗粒本来就比底亮，不需要整层压太多；0.85 让海面读成"背景"而不是"内容"。
  opacity: 0.85,
  // 保持 1.25：实测这一档的浪峰暖度最高（见上方表格），往下调会与用户诉求相反。
  alphaScale: 1.25,
  // 以下三项 = 参考站面板定稿值，与浅色**同一组数字**（见上方参数表）。
  density: 1.5,
  waveHeight: 0.65,
  // 3 → 2：÷1.5 对齐观感，理由见上方 §1.5（两套主题同一口径）。
  particleSize: 2,
  // 交互：深色下涌浪更明显（亮颗粒被推挤的位移更容易看到），参数与浅色保持一致，
  // 避免切换主题时"手感的物理量"突然变了。
  interactive: true,
  swell: 1,
  swellRadius: 0.9,
  parallax: 1,
  clickRipples: true
}

const PALETTES: Record<'light' | 'dark', TidePalette> = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE
}

/** 六位十六进制颜色（与 `particleTide.ts` 的解析口径一致）。 */
const HEX_PATTERN = /^#[0-9a-f]{6}$/i

/** 读当前主题名：只有明确写了 `dark` 才算深色（缺省 = 浅色）。 */
function resolveThemeName(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * 画布底色：优先读 `--bg-canvas`（与首页底色**必须**同值，否则 opacity 混合后
 * 会看到一条色差接缝），读不到或不是六位十六进制时退回调色板的兜底值。
 *
 * @param fallback 兜底颜色（`#RRGGBB`）
 */
function readCanvasBackground(fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()
  return HEX_PATTERN.test(value) ? value : fallback
}

/**
 * 组装一帧的渲染设置。
 *
 * @param palette 当前主题配色（含该主题的基准密度 / 浪高 / 颗粒直径 / alpha 系数）
 * @param quality 当前动效档位（只在基准密度上再乘一次系数）
 */
function buildSettings(palette: TidePalette, quality: MotionQuality): TideSettings {
  const density = Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, palette.density * DENSITY_FACTOR[quality]))
  return {
    backgroundColor: readCanvasBackground(palette.backgroundColor),
    waterColor: palette.waterColor,
    crestColor: palette.crestColor,
    density,
    particleSize: palette.particleSize,
    waveHeight: palette.waveHeight,
    wavelength: BASE_WAVELENGTH,
    speed: BASE_SPEED,
    alphaScale: palette.alphaScale,
    interactive: palette.interactive,
    swell: palette.swell,
    swellRadius: palette.swellRadius,
    parallax: palette.parallax,
    clickRipples: palette.clickRipples
  }
}

/**
 * 粒子海面背景。
 *
 * @param props 见 `HomeParticlesProps`
 */
export function HomeParticles({ quality }: HomeParticlesProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // 档位参数只在这里读一次；quality 变化会整块重建（罕见事件，省得做热切换状态机）
    const profile = MOTION_PROFILES[quality]
    const minFrameMs = quality === 'smooth' ? SMOOTH_MIN_FRAME_MS : 0
    const renderer: TideRenderer = createTideRenderer(canvas)

    let palette = PALETTES[resolveThemeName()]
    let settings = buildSettings(palette, quality)
    canvas.style.opacity = String(palette.opacity)

    // ── 时钟状态（累计相位秒数；暂停/恢复都不重置） ──────────────────────────
    let elapsed = 0
    let rafId = 0
    let lastFrameAt = 0
    let hasBaseline = false
    let throttleAccum = 0
    let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    /** 画一帧：减少动效时固定 time=0（静态海面）。 */
    const drawFrame = (): void => {
      renderer.render(reduced ? 0 : elapsed, settings)
    }

    /** RAF 主体：只累加相位增量，且增量封顶 64ms。 */
    const frame = (now: number): void => {
      rafId = window.requestAnimationFrame(frame)
      if (!hasBaseline) {
        hasBaseline = true
        lastFrameAt = now
        return
      }
      let deltaMs = now - lastFrameAt
      lastFrameAt = now
      if (!Number.isFinite(deltaMs) || deltaMs < 0) deltaMs = 0
      if (deltaMs > MAX_FRAME_DELTA_MS) deltaMs = MAX_FRAME_DELTA_MS
      if (minFrameMs > 0) {
        // 限帧：累计到 1/30 秒才真正画，省下的帧不推进相位
        throttleAccum += deltaMs
        if (throttleAccum < minFrameMs) return
        deltaMs = throttleAccum
        throttleAccum = 0
      }
      elapsed += (deltaMs / 1000) * settings.speed
      drawFrame()
    }

    /** 启动 RAF（减少动效 / 已启动 / 页面隐藏时不动）。 */
    const start = (): void => {
      if (rafId !== 0 || reduced || document.hidden) return
      hasBaseline = false
      throttleAccum = 0
      rafId = window.requestAnimationFrame(frame)
    }

    /** 暂停 RAF：保留 `elapsed`，只丢掉时间基线（恢复时不会补一大段）。 */
    const stop = (): void => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId)
      rafId = 0
      hasBaseline = false
      throttleAccum = 0
    }

    // ── 尺寸：canvas 由 CSS 铺满父容器，DPR 上限来自动效档位 ─────────────────
    const applySize = (): void => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      renderer.resize(rect.width, rect.height, profile.dprCap)
      // 尺寸变化后立刻补一帧：避免"等第一个 RAF 才有画面"，也让静态/暂停态跟上
      drawFrame()
    }

    const resizeObserver = new ResizeObserver((): void => {
      applySize()
    })
    resizeObserver.observe(canvas)
    applySize()

    // ── 指针交互：事件挂 window，坐标换算到画布内，rAF 节流 ────────────────────
    // 为什么挂 window：本组件的 canvas 是 `pointer-events-none`（否则这块铺满首屏的
    // 画布会吞掉文件夹卡片的 hover），所以它自己收不到事件，只能从 window 上听，
    // 再用 getBoundingClientRect() 判断指针落在画布的哪个位置。
    let pointerListening = false
    let pendingPointer: { x: number; y: number } | null = null
    let pointerFrameId = 0

    /** 事件坐标 → 画布内 CSS 像素坐标（夹在画布矩形内，避免指针在画布外把涌浪拽飞）。 */
    const toCanvasPoint = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      return {
        x: Math.min(Math.max(localX, 0), Math.max(1, rect.width)),
        y: Math.min(Math.max(localY, 0), Math.max(1, rect.height))
      }
    }

    /** 一帧最多把最新坐标推给渲染器一次：pointermove 的频率远高于渲染帧。 */
    const flushPointer = (): void => {
      pointerFrameId = 0
      const pending = pendingPointer
      if (!pending) return
      pendingPointer = null
      renderer.setPointer(pending.x, pending.y)
    }

    const onPointerMove = (event: PointerEvent): void => {
      pendingPointer = toCanvasPoint(event)
      if (pointerFrameId === 0) pointerFrameId = window.requestAnimationFrame(flushPointer)
    }

    const onPointerDown = (event: PointerEvent): void => {
      const point = toCanvasPoint(event)
      // 点击往往落在 pointermove 的节流窗口里，这里先同步一次再激涟漪
      pendingPointer = null
      renderer.setPointer(point.x, point.y)
      renderer.ripple(point.x, point.y)
    }

    /** 指针离开 → 交回 null，让渲染器把 strength 指数衰减到 0（水面平滑回落）。 */
    const onPointerLeave = (): void => {
      pendingPointer = null
      renderer.setPointer(null, null)
    }

    /** `pointerout` 且 relatedTarget 为 null = 指针离开了整个窗口（比 pointerleave 可靠）。 */
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) onPointerLeave()
    }

    /** 挂监听（减少动效 / 页面隐藏 / 关掉交互时不挂）。 */
    const attachPointer = (): void => {
      if (pointerListening) return
      if (reduced || document.hidden || !settings.interactive) return
      pointerListening = true
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('pointerdown', onPointerDown, { passive: true })
      window.addEventListener('pointerleave', onPointerLeave)
      window.addEventListener('pointerout', onPointerOut)
    }

    /** 拆监听并复位指针状态（cleanup / 隐藏 / 减少动效都要走到）。 */
    const detachPointer = (): void => {
      if (!pointerListening) return
      pointerListening = false
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointerout', onPointerOut)
      if (pointerFrameId !== 0) {
        window.cancelAnimationFrame(pointerFrameId)
        pointerFrameId = 0
      }
      pendingPointer = null
      renderer.setPointer(null, null)
    }

    // ── 失焦 / 页面隐藏 → 暂停；恢复 → 接续累计时间 ─────────────────────────
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        stop()
        detachPointer()
      } else {
        start()
        attachPointer()
      }
    }
    const onWindowBlur = (): void => {
      stop()
      // 失焦后指针一定不在画布上：交给衰减，别硬切
      renderer.setPointer(null, null)
    }
    const onWindowFocus = (): void => {
      start()
      attachPointer()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)

    // ── 减少动效：命中就不开 RAF，只留静态一帧 ───────────────────────────────
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onReducedMotionChange = (): void => {
      reduced = motionQuery.matches
      if (reduced) {
        stop()
        detachPointer()
        drawFrame()
      } else {
        start()
        attachPointer()
      }
    }
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onReducedMotionChange)
    } else {
      motionQuery.addListener(onReducedMotionChange) // 老 Chromium 兜底
    }

    // ── 主题切换：重设 settings（配色 + 画布底色）并立即重绘 ────────────────
    const themeObserver = new MutationObserver((): void => {
      const next = PALETTES[resolveThemeName()]
      if (next === palette) return
      palette = next
      settings = buildSettings(palette, quality)
      canvas.style.opacity = String(palette.opacity)
      // 主题可能改了 interactive / clickRipples（两套目前都是 true，但别把口径写死）
      if (settings.interactive) attachPointer()
      else detachPointer()
      drawFrame()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    // 首屏：减少动效 → 已由 applySize 画过静态帧；否则起时钟 + 挂指针监听
    start()
    attachPointer()

    return (): void => {
      stop()
      detachPointer()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      if (typeof motionQuery.removeEventListener === 'function') {
        motionQuery.removeEventListener('change', onReducedMotionChange)
      } else {
        motionQuery.removeListener(onReducedMotionChange)
      }
      renderer.dispose()
      // 交给组件自己的样式，别把 opacity 留在节点上（StrictMode 会复用同一块 canvas）
      canvas.style.removeProperty('opacity')
    }
  }, [quality])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none block h-full w-full" />
}

export default HomeParticles
