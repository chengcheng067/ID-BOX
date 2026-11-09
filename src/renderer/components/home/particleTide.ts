/**
 * 首页封面页 · 粒子海面底图（Particle Tide renderer）。
 *
 * ── 来源 ─────────────────────────────────────────────────────────────────────
 * 移植自 TuneShape `src-particle-tide.ts`（MIT，原创实现，非逆向；我们照抄机制而
 * 不是照抄 API）。原作者把「粒子海面」拆成四步，本文件逐个保留：
 *   1. `planPoints()`：420×300 的粒子网格（按 density 缩放），每点带种子抖动 +
 *      透视深度 z（`1/(1-u*0.975)`，越远越密，一直铺到地平线）；
 *   2. `sampleWave()`：解析波场 —— 四路正弦/余弦叠加（primary / secondary /
 *      cross / detail）+ 一个二次项做浪尖锐化，返回 {height, crest, displacement}；
 *   3. 投影：把世界坐标 (x, z) 按深度投影回 320×230 的逻辑画布，得到屏幕点、
 *      点半径、墨水浓度 ink 与 alpha；
 *   4. 绘制：WebGL1 点精灵主路径（顶点着色器里做同一套波场计算），
 *      Canvas 2D 分桶批量绘制作为降级。
 *
 * ── 我们改了什么（相对参考实现的 diff）───────────────────────────────────────
 *  a. **指针 / 涟漪：先删后恢复**（2026-10 第二轮视觉返工）。首版把参考实现的
 *     pointer 涌浪 / 视差 / 点击涟漪整条链路删掉了（当时的理由是"首页背景不需要
 *     交互"），但参考站点本身把这套交互写得很完整，用户明确要求"要有鼠标交互"，
 *     故**已恢复**，并补了三处参考实现没有的工程细节：
 *       a1. **缺省关闭**：`interactive` / `clickRipples` 缺省 false，不传时行为
 *           等同首版（纯波场），任何旧调用点不会突然多出一块被鼠标拖着跑的水面；
 *       a2. **强度平滑**：指针离开时 `strength` 按指数衰减到 0（时间常数见
 *           `POINTER_DECAY_TAU`），不是硬切 —— 硬切会看到一块水面"啪"地塌下去；
 *       a3. **两条路径都实现**：涟漪与涌浪在 WebGL 顶点着色器与 Canvas 2D 降级
 *           路径里是同一套公式（`sampleWave()` / `VERTEX_SHADER_SOURCE`），
 *           降级时交互不会突然消失。
 *     机制本身照抄参考：`pointer()` 的屏幕射线与**被波场扰动过的水面**求交
 *     （128 步粗扫 + 12 次二分）、`sample()` 里
 *     `strength*swell*.32*exp(-d²/(swellRadius²*2))` 的高斯涌浪、投影里
 *     `viewX*parallax*strength*6/depth` 的视差、以及最多 12 条 / 6 秒过期的
 *     环形涟漪（`front = distance - age*3.3`）。
 *  b. **删掉参数校验 / 预设表 / 公开导出**：`validateTide`、`tideRanges`、
 *     `tidePresets`、`defaultTide`、`tideEngineCode` 等都不需要（本文件只被
 *     `HomeParticles.tsx` 使用，入参由组件自己构造），保留会让主题配色与
 *     `defaultTide` 的 Graphite 硬编码打架。
 *  c. **配色改走主题变量**：参考实现把颜色写死在 settings 里；这里由组件按
 *     `data-theme` 传入（浅色 slate 系 / 深色 #111113 系），本文件只负责把
 *     `#RRGGBB` 解析成 RGB。非法颜色不再抛错，退到内置兜底色（渲染层不该白屏）。
 *  d. **`resize()` 多一个可选的 `dprCap` 参数**：参考实现把 pixelRatio 上限写死
 *     1.5；这里由调用方按 `MOTION_PROFILES[quality].dprCap` 传入（流畅 1.5 /
 *     均衡 2 / 极致 3）。省略时退回参考实现的 1.5，保持向后兼容。
 *  e. **不再自建 `<canvas>` 的强制路径**：host 本身就是 canvas 时直接复用（React
 *     渲染的那个），否则才自建并 append —— StrictMode 二次挂载不会叠出两块画布。
 *  f. **`dispose()` 不调 `WEBGL_lose_context.loseContext()`**：React 18 StrictMode
 *     会「挂载 → 卸载 → 再挂载」同一块 canvas，`getContext('webgl')` 对同一 canvas
 *     返回**同一个**上下文对象；主动 lose 之后拿回来的还是那个已丢的上下文 →
 *     dev 下必现"画面全黑"。所以这里只释放 program/buffer，让 GC 回收上下文。
 *  g. **`ink`（water→crest 的插值权重）重标定**（2026-11-09，见下）。
 *
 * ── 为什么动 `ink`：把「浪峰色」真正画出来 ───────────────────────────────────
 * 参考实现的插值权重是 `ink = .18 + sqrt(crest) * .82`。crest 来自
 * `pow(ridge, 4.2)`（四次方），实测分布极度偏斜（density 1.5 / waveHeight 0.65，
 * 一帧 188638 颗粒子）：
 *
 *   crest  p50 0.011 · p90 0.138 · p95 0.205 · p99 0.392 · p99.9 0.757 · 最大 0.90
 *   ink_旧 p50 0.265 · p90 0.485 · p95 0.551 · p99 0.694 · 最大 0.958
 *
 * 也就是说**旧曲线几乎永远到不了 1**：全帧只有 154 / 188638 颗（0.08%）能到 ink ≥ .90。
 * 那套曲线配「接近白的浪峰色」没问题（中间灰调看着就是浪花），但用户要求浪峰色是
 * **暖沙 #efdabd**、水体色是**纯蓝 #0091ff** —— 这两个色在 sRGB 里做线性插值，中间点
 * 会穿过无彩色：
 *
 *   ink .18 → #2b9ef3 (R−B −200)   ink .60 → #8fbdd7 (R−B −72)
 *   ink .50 → #78b6de (R−B −103)   ink .80 → #bfcbca (R−B −11)  ← 已经是灰
 *   ink 1.0 → #efdabd (R−B  +50)   ← 只有一个点才有沙子的色相
 *
 * 所以旧曲线下浪峰像素的合成色实测是 `#8b9697`（R−B = **−13**，蓝灰），用户说的
 * 「浪花颜色没做出来」在数值上是成立的。**注意：不是 alpha 饱和把颜色洗白了** ——
 * 单颗粒子在 alpha 0.98 下压深底实测合成 `#ebd6ba`（R−B +49，ΔRGB 相对 #efdabd
 * 只有 −4/−4/−3），色相完全保真；把 alphaScale 调**低**反而让 R−B 从 35 掉到 30。
 *
 * 修法只动一条曲线（两条渲染路径共用同一份常数，见 `INK_FLOOR` / `INK_GAIN`）：
 *
 *   ink = min(1, INK_FLOOR + INK_GAIN * crest^0.75)     (.16 + 1.62 * crest^.75)
 *
 * 标定目标（实测 crest 分布反推）：中位 0.011 → ink 0.22（水色，海面整体保持蓝）、
 * p95 0.205 → 0.65、p99 0.392 → 0.96（约 1% 的颗粒子吃到浪峰色）、p99.9 以上 → 1.0。
 * `crest^0.75` 故意写成 `sqrt(crest * sqrt(crest))`：GLSL ES 1.00 的 `pow(0., y)`
 * 在部分驱动上未定义，sqrt 链在 0 处安全，且顶点着色器与 2D 降级路径逐位一致。
 *
 * 副作用（已量化，可接受）：中位 ink 从 0.265 降到 0.22 → 海面整体**更蓝、更少灰**，
 * 正好对冲「水体颜色不对」；浪峰区（top 1%）合成色在深色底从 #8b9697(R−B −13)
 * 变成 #b0a18d(R−B +35)，沙色真的出来了。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 * 零新增依赖、零 `require`、零运行时 import（本文件不 import 任何模块）。
 * 内部默认值（windAngle / horizon / fog / glow / foam / choppiness / seed）照抄
 * 参考实现的 `settings()`，不暴露成 UI 参数 —— 首页背景不该有旋钮。
 */

/** 外部只需要这 8 个字段（其余走内部默认值）。 */
export interface TideSettings {
  /** 画布底色（同时是 WebGL 的 clearColor；不透明，和页面底色一致） */
  backgroundColor: string
  /** 水体色（深海/低谷处的粒子色） */
  waterColor: string
  /** 浪峰色（crest 越高的粒子越接近它） */
  crestColor: string
  /** 粒子密度乘数（参考实现在 0.3–2 之间取） */
  density: number
  /** 粒子直径乘数 */
  particleSize: number
  /** 浪高乘数（0 = 死水平面） */
  waveHeight: number
  /** 波长乘数（越大浪越宽越缓） */
  wavelength: number
  /** 相位推进速度乘数（0 = 定格，但仍按传入时间绘一帧） */
  speed: number
  /**
   * 额外 alpha 系数（**可选**，省略 = 1 = 参考实现原样）。
   *
   * 为什么需要它：参考实现的 alpha 是
   * `(.035 + crest*foam*1.5) * exp(-z*.026) * (.7 + jitter*.65)`，那个 **0.035 地板
   * 是为深色底（#242426）设计的** —— 在浅色底（#F8FAFC）上，一个 crest≈0 的粒子
   * 实际只有 3.5% 不透明度，叠在近白的底上等于不存在（实测：整层几乎看不见）。
   * 浅色主题把这个系数抬到 2–3 量级让颗粒"落地"，深色主题保持 1 不动。
   * 上限仍由 0.98 卡住，不会因为放大而糊成实心色块。
   */
  alphaScale?: number
  /**
   * 是否启用指针交互（涌浪 + 视差）。**可选**，缺省 `false` = 纯波场（首版行为）。
   *
   * 只有为 `true` 时 `setPointer()` 的输入才会进入波场计算；为 `false` 时渲染器
   * 完全不消耗指针状态，也不会因为鼠标移动而多算一次射线求交。
   */
  interactive?: boolean
  /** 涌浪强度倍率（**可选**，缺省 1 = 参考实现原样；0 = 只有视差没有涌浪） */
  swell?: number
  /** 涌浪半径（世界单位，**可选**，缺省 0.9 = 参考实现原样） */
  swellRadius?: number
  /** 视差强度倍率（**可选**，缺省 1 = 参考实现原样；0 = 关掉视差） */
  parallax?: number
  /**
   * 是否启用点击涟漪。**可选**，缺省 `false`。
   *
   * 与 `interactive` 独立：想要"鼠标经过有涌浪、点击没有涟漪"就把这里置 false。
   */
  clickRipples?: boolean
}

/** 对外唯一入口的返回值。 */
export interface TideRenderer {
  /**
   * 设定 CSS 尺寸。
   * @param cssWidth  CSS 像素宽（父容器实测宽）
   * @param cssHeight CSS 像素高（父容器实测高）
   * @param dprCap    pixelRatio 上限，默认 1.5（参考实现口径）
   */
  resize(cssWidth: number, cssHeight: number, dprCap?: number): void
  /** 画一帧。`timeSeconds` 是**累计相位秒数**（不是绝对时间戳）。 */
  render(timeSeconds: number, settings: TideSettings): void
  /**
   * 设置指针位置（**可选能力**，只有 `settings.interactive === true` 时生效）。
   *
   * @param x 指针相对**画布左上角**的 CSS 像素横坐标；传 `null` 表示指针离开
   * @param y 指针相对**画布左上角**的 CSS 像素纵坐标；传 `null` 表示指针离开
   *
   * 传 `null` 不会立刻抹掉水面 —— `strength` 会按指数衰减到 0（约 0.4 秒平静），
   * 否则会看到涌浪中心"啪"地塌掉。调用频率不限：内部只在 `render()` 时换算一次。
   */
  setPointer(x: number | null, y: number | null): void
  /**
   * 在指定位置激起一圈涟漪（**可选能力**，需要 `settings.clickRipples === true`）。
   *
   * @param x 相对画布左上角的 CSS 像素横坐标
   * @param y 相对画布左上角的 CSS 像素纵坐标
   *
   * 内部最多保留 12 条、每条 6 秒过期（与参考实现一致）；超出即丢最旧的一条。
   */
  ripple(x: number, y: number): void
  /** 释放资源；幂等，重复调用安全。 */
  dispose(): void
}

/** 引擎内部默认值（照抄参考实现 `settings()` 的固定项）。 */
const ENGINE_DEFAULTS = {
  /** 浪尖锐化强度（二次项系数） */
  choppiness: 0.8,
  /** 风向（度）。0 = 沿 +z 推进 */
  windAngle: 0,
  /** 地平线位置（逻辑画布 230 高的比例） */
  horizon: 0.1,
  /** 雾化强度：远处粒子衰减更快 */
  fog: 1,
  /** 光晕强度（Canvas 2D 降级路径下给每个点画一圈柔光） */
  glow: 0.35,
  /** 浪峰发白强度 */
  foam: 1,
  /** 粒子随机种子（0 = 参考实现的默认排布） */
  seed: 0
} as const

/**
 * `ink`（水体色 → 浪峰色 的插值权重）的最小值：crest≈0 时的"纯水色"底噪。
 *
 * 取 0.16 而非 0：远处颗粒 alpha 已经很低，若 ink 同时贴 0，整片远海会只剩底噪、
 * 完全读不出水体色。0.16 让最淡的颗粒仍然是水色本身而不是底色的稀释版。
 *
 * ⚠️ 与 `INK_GAIN` 一起被**顶点着色器**直接内联（见 `VERTEX_SHADER_SOURCE` 的
 * `${...}` 插值）—— 改这两个数会同时改两条渲染路径，这是刻意的：一旦两条路径的
 * 曲线不同，WebGL 与 Canvas 2D 降级出来的海面色调就会不一样。
 */
const INK_FLOOR = 0.16

/**
 * 浪峰端的增益：`ink = min(1, INK_FLOOR + INK_GAIN * crest^0.75)`。
 *
 * 为什么要"过冲"（`INK_FLOOR + INK_GAIN > 1`）：crest 的分布极度偏斜（p99 才 0.392，
 * 见文件头 diff 说明 g），只有让曲线在 crest≈0.42 处就压到 1，最高那 ~1% 的颗粒子
 * 才真的画成浪峰色；否则 `mix()` 永远停在蓝灰中间调上，"浪花颜色"根本不会出现。
 */
const INK_GAIN = 1.62

/** `ink` 的 crest 指数：`crest^0.75`（写成 sqrt 链，见 `crestInk`）。 */
const INK_EXPONENT_GLSL = 'sqrt(crest*sqrt(crest))'

/**
 * 浪峰强度 → 墨水浓度（`waterColor` → `crestColor` 的插值权重）。
 *
 * 与顶点着色器里 `ink=min(1.,.16+sqrt(crest*sqrt(crest))*1.62)` 逐项对应。
 * 为什么用 `sqrt(c * sqrt(c))` 而不是 `Math.pow(c, 0.75)`：顶点着色器里 `pow(0., y)`
 * 在 GLSL ES 1.00 下未定义（部分驱动出 NaN）；sqrt 链在 c=0 处结果为 0，安全，
 * 而且两条路径用的是同一个数学式子。
 *
 * @param crest 浪峰强度（已含 foam 系数），0…1；越界值按 0 处理
 * @returns 0…1 的插值权重
 */
function crestInk(crest: number): number {
  const c = Number.isFinite(crest) ? Math.max(0, crest) : 0
  return Math.min(1, INK_FLOOR + INK_GAIN * Math.sqrt(c * Math.sqrt(c)))
}

/** 解析后的完整渲染设置 = 外部 8 项（+ 可选 alphaScale / 交互项）+ 内部默认值。 */
interface ResolvedSettings extends TideSettings {
  choppiness: number
  windAngle: number
  horizon: number
  fog: number
  glow: number
  foam: number
  seed: number
  /** 与 `TideSettings.alphaScale` 同义，但解析后一定存在（缺省 1） */
  alphaScale: number
  /** 与 `TideSettings.interactive` 同义，解析后一定存在（缺省 false） */
  interactive: boolean
  /** 与 `TideSettings.swell` 同义，解析后一定存在（缺省 1） */
  swell: number
  /** 与 `TideSettings.swellRadius` 同义，解析后一定存在（缺省 0.9，且已夹下限） */
  swellRadius: number
  /** 与 `TideSettings.parallax` 同义，解析后一定存在（缺省 1） */
  parallax: number
  /** 与 `TideSettings.clickRipples` 同义，解析后一定存在（缺省 false） */
  clickRipples: boolean
}

/** 逻辑画布尺寸（参考实现的坐标系，绘制时拉伸铺满实际画布，不裁地平线）。 */
const LOGICAL_WIDTH = 320
const LOGICAL_HEIGHT = 230

/** 海面最近处的深度（参考实现里的 `near`），射线粗扫的起点。 */
const NEAR_Z = -0.7

/** 指针射线求交的粗扫步数（参考实现 128 步 + 12 次二分；只在有指针时才算）。 */
const POINTER_MARCH_STEPS = 128

/** 射线求交二分细化次数。 */
const POINTER_BISECT_STEPS = 12

/** 涌浪高斯项系数（参考实现里写死的 `.32`）。 */
const SWELL_AMPLITUDE = 0.32

/** `swellRadius` 的物理下限：0 会让高斯项除以 0（= NaN 顶点，整片海面消失）。 */
const MIN_SWELL_RADIUS = 0.05

/** 环形涟漪容量（与参考实现的 `uniform vec3 ripples[12]` 对齐）。 */
const RIPPLE_CAPACITY = 12

/** 单条涟漪的寿命（秒）。 */
const RIPPLE_LIFETIME = 6

/** 涟漪波前扩散速度（世界单位/秒，参考实现的 `age*3.3`）。 */
const RIPPLE_SPEED = 3.3

/**
 * 指针 `strength` 的指数衰减 / 上升时间常数（秒）。
 *
 * 为什么需要：`setPointer(null, null)` 如果把 `strength` 直接置 0，涌浪高斯项会
 * 在一帧内消失 —— 视觉上是一块水面"啪"地塌下去。0.16s 的时间常数让进出都像
 * 水面自己在回弹（约 0.4s 基本平静）。
 */
const POINTER_DECAY_TAU = 0.16

/** `strength` 的收敛阈值：小于它就吸附到 0，避免永远拖着 1e-9 的无意义重绘。 */
const POINTER_STRENGTH_EPSILON = 0.004

/** 单帧允许计入的指针平滑最大间隔（秒），防止切窗口回来一口气补完衰减。 */
const MAX_POINTER_DELTA_SECONDS = 0.1

/** Canvas 2D 降级路径的最大绘制点数（超出按种子抽样丢弃，保帧率）。 */
const FALLBACK_DOT_BUDGET = 32000

/** Canvas 2D 降级路径的最小重绘间隔（ms）：约 20fps，够看，不烧 CPU。 */
const FALLBACK_MIN_PAINT_MS = 50

/** 色调分桶数（ink 0–7 × alpha 0–11 = 96 桶）。 */
const TONE_BUCKETS = 8
const ALPHA_BUCKETS = 12

/** 粒子（世界坐标） */
interface TidePoint {
  /** 世界 x（海面横轴，约 -4.8…4.8） */
  x: number
  /** 深度：near(-0.7) → 远处(~+3.3) */
  z: number
  /** 逐点抖动 [0,1)，用来打破网格感 */
  jitter: number
}

/**
 * 指针在**海面上的命中点**（世界坐标）+ 视角参数。
 *
 * 与参考实现的 `TidePointer` 同构：`x/z` 是射线与波面求交的结果，`viewX/viewY`
 * 是指针相对画布中心的归一化偏移（-1…1，用于视差），`strength` 是 0…1 的
 * 平滑权重（0 = 涌浪完全消失）。
 */
interface TidePointer {
  /** 命中的世界 x */
  x: number
  /** 命中的世界 z（深度） */
  z: number
  /** 归一化横向偏移 -1…1（视差用） */
  viewX: number
  /** 归一化纵向偏移 -1…1（视差用） */
  viewY: number
  /** 涌浪/视差权重 0…1（指针离开时指数衰减到 0） */
  strength: number
}

/** 一条点击涟漪：世界坐标 + 出生时的相位秒数。 */
interface TideRipple {
  /** 世界 x */
  x: number
  /** 世界 z */
  z: number
  /** 出生时刻（累计相位秒数，与 `render(time)` 同一时间轴） */
  time: number
}

/** 复用的空涟漪表：没有涟漪时不必每帧新建数组。 */
const NO_RIPPLES: readonly TideRipple[] = []

/** 波场采样结果 */
interface WaveSample {
  /** 浪高（有符号，正 = 高过静止水面） */
  height: number
  /** 浪峰强度 [0,1]，决定该点偏 water 还是 crest 色 */
  crest: number
  /** 水平位移（洋流把粒子往浪前进方向推一点，避免"竖直上下"的死板感） */
  displacement: number
}

/** 投影后的一个屏幕点 */
interface TideDot {
  x: number
  y: number
  size: number
  ink: number
  alpha: number
}

/** 六位十六进制颜色 */
const HEX_PATTERN = /^#[0-9a-f]{6}$/i

/**
 * `#RRGGBB` → [r, g, b]（0–255）。非法输入返回兜底色而不是抛错。
 *
 * @param hex      待解析颜色
 * @param fallback 兜底色（0–255 三元组）
 */
function toRgb(hex: string, fallback: readonly [number, number, number]): [number, number, number] {
  if (!HEX_PATTERN.test(hex)) return [fallback[0], fallback[1], fallback[2]]
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

/** `#RRGGBB` → [r, g, b]（0–1），供 WebGL uniform 使用。 */
function toUnitRgb(hex: string, fallback: readonly [number, number, number]): [number, number, number] {
  const rgb = toRgb(hex, fallback)
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]
}

/** 哈希式伪随机（与参考实现同款整数混洗，保证同一 index/seed 永远同一值）。 */
function random(index: number, seed: number): number {
  let n = Math.imul(index + 1, 1597334677) ^ Math.imul(seed + 1, 3812015801)
  n = Math.imul(n ^ (n >>> 16), 2246822519)
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296
}

/** 外部设置 + 内部默认值 → 完整设置。 */
function resolveSettings(settings: TideSettings): ResolvedSettings {
  // alphaScale 单独夹取：非法/缺失一律回 1（参考实现原样），负值同理
  const raw = settings.alphaScale
  const alphaScale = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
  // 交互项逐个夹取：非有限数一律回参考实现缺省，绝不把 NaN 传进着色器
  const rawSwell = settings.swell
  const swell = typeof rawSwell === 'number' && Number.isFinite(rawSwell) ? Math.max(0, rawSwell) : 1
  const rawRadius = settings.swellRadius
  const swellRadius =
    typeof rawRadius === 'number' && Number.isFinite(rawRadius)
      ? Math.max(MIN_SWELL_RADIUS, rawRadius)
      : 0.9
  const rawParallax = settings.parallax
  const parallax =
    typeof rawParallax === 'number' && Number.isFinite(rawParallax) ? Math.max(0, rawParallax) : 1
  return {
    ...ENGINE_DEFAULTS,
    ...settings,
    alphaScale,
    swell,
    swellRadius,
    parallax,
    interactive: settings.interactive === true,
    clickRipples: settings.clickRipples === true
  }
}

/**
 * 生成粒子网格（与参考实现同算法）。
 *
 * 排序是**从远到近**（row 由 rows-1 递减），Canvas 2D 降级路径依赖这个顺序让近处
 * 粒子压住远处粒子；WebGL 点精灵没有顺序依赖，但保持同一顺序便于两条路径观感一致。
 *
 * @param s 完整设置
 * @returns 粒子数组（长度 ≈ 420×300×density）
 */
function planPoints(s: ResolvedSettings): TidePoint[] {
  // density 夹在参考实现的合法区间内，防止误传导致 0 点或千万点。
  const density = Math.min(2, Math.max(0.3, s.density))
  const columns = Math.round(420 * Math.sqrt(density))
  const rows = Math.round(300 * Math.sqrt(density))
  const points: TidePoint[] = []
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = 0; col < columns; col++) {
      const id = row * columns + col
      const jitter = random(id, s.seed)
      const u = (row + random(id + 31, s.seed)) / rows
      // 透视：u=0 时 z=near，u→1 时 z 迅速拉远（1/(1-0.975) 制造地平线挤压）
      const z = -0.7 + 4 * (1 / (1 - u * 0.975) - 1)
      const depth = 1 + z * 0.25
      const x = ((col + random(id + 17, s.seed)) / columns * 2 - 1) * 4.8 * depth
      points.push({ x, z, jitter })
    }
  }
  return points
}

/**
 * 解析波场采样（四路正弦叠加 + 浪尖锐化 + 指针涌浪 + 点击涟漪），纯函数、无状态。
 *
 * 与顶点着色器里的同名计算逐项对应：**两条渲染路径必须给出同一个高度场**，
 * 否则降级到 Canvas 2D 时水面会"变形"。
 *
 * @param x       世界 x
 * @param z       深度
 * @param time    累计相位秒数
 * @param s       完整设置
 * @param pointer 指针命中的海面点（null = 无指针，不叠加涌浪）
 * @param ripples 活跃涟漪表（只读；已由调用方按寿命过滤）
 */
function sampleWave(
  x: number,
  z: number,
  time: number,
  s: ResolvedSettings,
  pointer: TidePointer | null = null,
  ripples: readonly TideRipple[] = NO_RIPPLES
): WaveSample {
  const angle = (s.windAngle * Math.PI) / 180
  const dx = Math.sin(angle)
  const dz = Math.cos(angle)
  const seed = s.seed * 0.817
  // 沿风向的坐标 u 与横向坐标 v：四路波各自在这两个轴上跑不同速度/相位
  const u = (x * dx + z * dz) / s.wavelength
  const v = (x * dz - z * dx) / s.wavelength
  const a = u * 1.15 + Math.sin(v * 0.55 + u * 0.12) * 0.55 - time * 0.75 + seed
  const b = u * 0.62 + v * 0.12 - time * 0.48 - seed * 0.7
  const c = v * 0.48 + u * 0.23 + time * 0.27 + seed * 1.9
  const primary = Math.sin(a)
  const secondary = Math.sin(b)
  const cross = Math.cos(c)
  const detail = Math.sin(u * 2.8 + Math.sin(v * 0.8) * 0.3 - time * 0.85)
  let height =
    s.waveHeight *
    (primary * 0.57 +
      secondary * 0.28 +
      cross * 0.18 +
      detail * 0.06 +
      s.choppiness * 0.18 * (primary * primary - 0.5))

  // ── 指针涌浪：以命中点为中心的高斯隆起（参考实现同一行公式） ──────────────
  if (s.interactive && pointer) {
    const radius = Math.max(MIN_SWELL_RADIUS, s.swellRadius)
    const offsetX = x - pointer.x
    const offsetZ = z - pointer.z
    const falloff = Math.exp(-(offsetX * offsetX + offsetZ * offsetZ) / (radius * radius * 2))
    height += pointer.strength * s.swell * SWELL_AMPLITUDE * falloff
  }

  // ── 点击涟漪：波前随 age 外扩，波后留下一条衰减的尾迹 ──────────────────────
  let rippleLight = 0
  let rippleDisplacement = 0
  if (s.clickRipples && ripples.length > 0) {
    for (let index = 0; index < ripples.length; index++) {
      const ripple = ripples[index]
      const age = time - ripple.time
      if (age < 0 || age >= RIPPLE_LIFETIME) continue
      const offsetX = x - ripple.x
      const offsetZ = z - ripple.z
      const distance = Math.hypot(offsetX, offsetZ)
      // front > 0 = 波前之外（还没到），front < 0 = 已经过去的尾迹
      const front = distance - age * RIPPLE_SPEED
      const attack = 1 - Math.exp(-age * 16)
      const envelope = Math.exp((-front * front) / 1.4 - age * 0.6) * attack
      const phase = front * 4.2
      const cosine = Math.cos(phase)
      height +=
        cosine * envelope * 1.05 -
        1.3 * Math.exp((-distance * distance) / 0.5 - age * 3) * attack
      // 波前把浪峰"点亮"一点，涟漪才有可见的亮边
      if (cosine > 0) rippleLight += cosine * cosine * envelope
      if (distance > 0.001) {
        rippleDisplacement += (offsetX / distance) * Math.sin(phase) * envelope * 0.16
      }
    }
  }

  // ridge：主浪脊（抬到 0 以上），四次方后只剩脊线附近发白
  const ridge = Math.max(0, (primary * 0.65 + secondary * 0.25 + cross * 0.1 - 0.08) / 0.92)
  // slope：波面坡度，脊线迎面时更亮（模拟折射高光）
  const slope = Math.abs(Math.cos(a) * 0.6555 + Math.cos(b) * 0.1736 - Math.sin(c) * 0.0414)
  const fold = Math.min(
    1,
    (Math.pow(ridge, 4.2) * 2 * (0.6 + 0.4 * slope) +
      Math.pow(Math.max(0, secondary), 8) * 0.15 +
      Math.pow(Math.max(0, detail), 12) * 0.04) *
      Math.min(1, s.waveHeight)
  )
  return {
    height,
    crest: Math.min(1, fold + rippleLight * 0.95),
    displacement: s.waveHeight * s.choppiness * Math.cos(a) * 0.35 + rippleDisplacement
  }
}

/**
 * 世界坐标 → 屏幕点（逻辑 320×230 坐标系）。
 *
 * @param point   粒子
 * @param time    累计相位秒数
 * @param s       完整设置
 * @param pointer 指针命中点（null = 无视差、无涌浪）
 * @param ripples 活跃涟漪表
 */
function projectDot(
  point: TidePoint,
  time: number,
  s: ResolvedSettings,
  pointer: TidePointer | null = null,
  ripples: readonly TideRipple[] = NO_RIPPLES
): TideDot {
  const wave = sampleWave(point.x, point.z, time, s, pointer, ripples)
  const depth = 1 + point.z * 0.25
  // 视差权重：只有开了交互且真的有指针时才把画面整体推一下
  const camera = s.interactive && pointer ? s.parallax * pointer.strength : 0
  const x =
    LOGICAL_WIDTH / 2 +
    ((point.x + wave.displacement) * 40) / depth -
    ((pointer?.viewX ?? 0) * camera * 6) / depth
  const y =
    s.horizon * LOGICAL_HEIGHT +
    (210 - wave.height * 32) / depth +
    ((pointer?.viewY ?? 0) * camera * 4) / depth
  // 远处 + 低浪峰 → alpha 迅速衰减，海面自然"融"进地平线
  const rawAlpha =
    (0.035 + wave.crest * s.foam * 1.5) * Math.exp(-point.z * s.fog * 0.026) * (0.7 + point.jitter * 0.65)
  const alpha = Math.min(0.98, rawAlpha * s.alphaScale)
  return {
    x,
    y,
    size: s.particleSize * (0.12 + 0.3 / depth) * (0.75 + point.jitter * 0.5),
    // 色调：水色 → 浪峰色的插值权重（**不是**参考实现的 `.18+sqrt(crest)*.82`，
    // 见文件头 diff 说明 g 与 `crestInk()` 的注释）
    ink: crestInk(wave.crest * s.foam),
    alpha
  }
}

/**
 * Canvas 2D 降级绘制（分桶批处理：同色调同透明度的点合成一条 path 再 fill）。
 *
 * 坐标变换把 320×230 的逻辑坐标拉伸到实际画布（与 WebGL 路径的投影完全一致）。
 * **涟漪与指针涌浪也在这条路径上生效** —— 降级时交互不会凭空消失。
 *
 * @param ctx     2D 上下文
 * @param points  粒子
 * @param time    累计相位秒数
 * @param s       完整设置
 * @param pointer 指针命中点（null = 无交互）
 * @param ripples 活跃涟漪表
 */
function paintCanvas2d(
  ctx: CanvasRenderingContext2D,
  points: TidePoint[],
  time: number,
  s: ResolvedSettings,
  pointer: TidePointer | null = null,
  ripples: readonly TideRipple[] = NO_RIPPLES
): void {
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  ctx.setTransform(width / LOGICAL_WIDTH, 0, 0, height / LOGICAL_HEIGHT, 0, 0)
  ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT)
  ctx.fillStyle = s.backgroundColor
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT)

  const water = toRgb(s.waterColor, [199, 210, 222])
  const crest = toRgb(s.crestColor, [255, 255, 255])
  const buckets: TideDot[][] = Array.from({ length: TONE_BUCKETS * ALPHA_BUCKETS }, () => [])
  const keep = Math.min(1, FALLBACK_DOT_BUDGET / Math.max(1, points.length))
  for (let index = 0; index < points.length; index++) {
    // 点数超额时按种子确定性抽样，保证画面稳定（不会一帧一个样）
    if (random(index + 371, s.seed) > keep) continue
    const dot = projectDot(points[index], time, s, pointer, ripples)
    if (dot.y > LOGICAL_HEIGHT + 2 || dot.y < 0 || dot.x < -3 || dot.x > LOGICAL_WIDTH + 3) continue
    const tone = Math.min(TONE_BUCKETS - 1, Math.floor(dot.ink * TONE_BUCKETS))
    const alpha = Math.min(ALPHA_BUCKETS - 1, Math.floor(dot.alpha * ALPHA_BUCKETS))
    buckets[tone * ALPHA_BUCKETS + alpha].push(dot)
  }

  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]
    if (!bucket.length) continue
    const mix = Math.floor(i / ALPHA_BUCKETS) / (TONE_BUCKETS - 1)
    const opacity = ((i % ALPHA_BUCKETS) + 0.5) / ALPHA_BUCKETS
    const r = Math.round(water[0] + (crest[0] - water[0]) * mix)
    const g = Math.round(water[1] + (crest[1] - water[1]) * mix)
    const b = Math.round(water[2] + (crest[2] - water[2]) * mix)
    ctx.fillStyle = `rgb(${r},${g},${b})`
    if (s.glow > 0) {
      // 柔光层：同桶再画一遍放大点，制造远处粒子叠出来的微光
      ctx.globalAlpha = opacity * s.glow * 0.12
      ctx.beginPath()
      for (const dot of bucket) {
        const radius = dot.size * (1.2 + s.glow)
        ctx.moveTo(dot.x + radius, dot.y)
        ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2)
      }
      ctx.fill()
    }
    ctx.globalAlpha = opacity
    ctx.beginPath()
    for (const dot of bucket) {
      const radius = dot.size * 0.45
      ctx.moveTo(dot.x + radius, dot.y)
      ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/**
 * 把指针的**逻辑画布坐标**换算成它命中的海面世界坐标。
 *
 * 照抄参考实现的 `pointer()`：不是简单地把屏幕点投到一张平面上，而是把屏幕射线
 * 与**被波场（含涌浪/涟漪）扰动过的水面**求交 —— 先沿深度 128 步粗扫找符号变化，
 * 再二分 12 次细化。每步内部先迭代 4 次解出水平位移的不动点（洋流把粒子推歪了，
 * 反解要收敛）。
 *
 * 求交时喂进去的是**上一帧**的指针（`feedback`），与参考实现一致：本帧尚未算出
 * 命中点，用上一帧做涌浪场近似，视觉上完全收敛，也不会产生自激抖动。
 *
 * @param logicalX 指针在逻辑画布里的 x（0…320）
 * @param logicalY 指针在逻辑画布里的 y（0…230）
 * @param time     累计相位秒数
 * @param s        完整设置
 * @param feedback 上一帧的指针命中点（null = 第一次进入，按无涌浪的水面求交）
 * @param ripples  活跃涟漪表
 * @returns 命中的世界坐标 + 归一化视角偏移（-1…1）
 */
function resolveSurfaceHit(
  logicalX: number,
  logicalY: number,
  time: number,
  s: ResolvedSettings,
  feedback: TidePointer | null,
  ripples: readonly TideRipple[]
): { x: number; z: number; viewX: number; viewY: number } {
  const halfWidth = LOGICAL_WIDTH / 2
  const halfHeight = LOGICAL_HEIGHT / 2
  const viewX = (logicalX - halfWidth) / halfWidth
  const viewY = (logicalY - halfHeight) / halfHeight
  // 视差与涌浪共用同一个"相机权重"：没开交互时射线就是在静态水面上求交
  const camera = s.interactive && feedback ? s.parallax : 0
  const viewShift = (feedback?.viewX ?? 0) * camera * 0.15
  const viewLift = (feedback?.viewY ?? 0) * camera * 4
  const rayX = logicalX - halfWidth

  /** 在给定深度 z 上解出"屏幕 x 落在射线上的世界 x"，并返回投影残差。 */
  const at = (z: number): { x: number; z: number; error: number } => {
    const depth = 1 + z * 0.25
    const baseX = (rayX * depth) / 40 + viewShift
    let worldX = baseX
    // 水平位移是不动点：worldX 出现在等式右边，迭代 4 次足够收敛
    for (let i = 0; i < 4; i++) {
      worldX = baseX - sampleWave(worldX, z, time, s, feedback, ripples).displacement
    }
    const wave = sampleWave(worldX, z, time, s, feedback, ripples)
    const error = s.horizon * LOGICAL_HEIGHT + (210 - wave.height * 32 + viewLift) / depth - logicalY
    return { x: worldX, z, error }
  }

  let previous = at(NEAR_Z)
  let best = previous
  for (let step = 1; step <= POINTER_MARCH_STEPS; step++) {
    // 与 planPoints() 完全相同的深度分布，保证粗扫采样点落在真实粒子的深度层上
    const z = NEAR_Z + 4 * (1 / (1 - (step / POINTER_MARCH_STEPS) * 0.975) - 1)
    const current = at(z)
    if (Math.abs(current.error) < Math.abs(best.error)) best = current
    if (previous.error * current.error <= 0) {
      // 残差变号 → 区间内必有交点，二分细化
      let lo = previous
      let hi = current
      for (let i = 0; i < POINTER_BISECT_STEPS; i++) {
        const mid = at((lo.z + hi.z) / 2)
        if (lo.error * mid.error <= 0) hi = mid
        else lo = mid
      }
      best = at((lo.z + hi.z) / 2)
      break
    }
    previous = current
  }
  return { x: best.x, z: best.z, viewX, viewY }
}

/**
 * 顶点着色器：与 `sampleWave()` 逐项对应（同一套波场，GPU 版）。
 *
 * 已恢复参考实现里的 pointer / ripple 分支 —— 见文件头 diff 说明 a。措辞提醒：
 * WebGL1（GLSL ES 1.00）要求循环上界是**常量**，所以涟漪循环写成
 * `for (int i = 0; i < 12; i++) { if (float(i) >= float(rippleCount)) break; ... }`。
 */
const VERTEX_SHADER_SOURCE = `precision highp float;
attribute vec3 point;
uniform vec2 resolution;
uniform float time,waveHeight,wavelength,particleSize,alphaScale;
uniform float interaction,pointerWeight,swell,swellRadius;
uniform vec4 pointer;
uniform vec3 ripples[12];
uniform int rippleCount;
varying float ink,alpha;
void main(){
 float x=point.x,z=point.y,jitter=point.z,depth=1.+z*.25,u=z/wavelength,v=x/wavelength;
 float a=u*1.15+sin(v*.55+u*.12)*.55-time*.75,b=u*.62+v*.12-time*.48,c=v*.48+u*.23+time*.27;
 float primary=sin(a),secondary=sin(b),cross=cos(c),detail=sin(u*2.8+sin(v*.8)*.3-time*.85);
 float h=waveHeight*(primary*.57+secondary*.28+cross*.18+detail*.06+.8*.18*(primary*primary-.5));
 float radius=max(swellRadius,.05);
 vec2 swellDelta=vec2(x,z)-pointer.xy;
 h+=interaction*pointerWeight*swell*.32*exp(-dot(swellDelta,swellDelta)/(radius*radius*2.));
 float light=0.,displacement=waveHeight*.8*cos(a)*.35;
 for(int i=0;i<12;i++){
  if(float(i)>=float(rippleCount))break;
  float age=time-ripples[i].z;
  if(age<0.||age>=6.)continue;
  vec2 diff=vec2(x,z)-ripples[i].xy;
  float distance=length(diff),front=distance-age*3.3,attack=1.-exp(-age*16.);
  float envelope=exp(-front*front/1.4-age*.6)*attack,phase=front*4.2;
  h+=cos(phase)*envelope*1.05-1.3*exp(-distance*distance/.5-age*3.)*attack;
  light+=pow(max(0.,cos(phase)),2.)*envelope;
  if(distance>.001)displacement+=diff.x/distance*sin(phase)*envelope*.16;
 }
 float ridge=max(0.,(primary*.65+secondary*.25+cross*.1-.08)/.92);
 float slope=abs(cos(a)*.6555+cos(b)*.1736-sin(c)*.0414);
 float fold=min(1.,(pow(ridge,4.2)*2.*(.6+.4*slope)+pow(max(0.,secondary),8.)*.15+pow(max(0.,detail),12.)*.04)*min(1.,waveHeight));
 float crest=min(1.,fold+light*.95);
 float camera=interaction*pointerWeight;
 vec2 screen=vec2(160.+(x+displacement)*40./depth-pointer.z*camera*6./depth,
                  23.+(210.-h*32.)/depth+pointer.w*camera*4./depth);
 gl_Position=vec4(screen.x/160.-1.,1.-screen.y/115.,0.,1.);
 float footprint=particleSize*(.12+.3/depth)*(.75+jitter*.5)*resolution.x/320.;
 gl_PointSize=clamp(footprint,1.,12.);
 ink=min(1.,${INK_FLOOR.toFixed(4)}+${INK_EXPONENT_GLSL}*${INK_GAIN.toFixed(4)});
 float rawAlpha=(.035+crest*1.5)*exp(-z*.026)*(.7+jitter*.65);
 alpha=min(.98,rawAlpha*alphaScale)*min(1.,footprint*footprint);
}`

/** 片元着色器：圆点 + 柔边，颜色按 ink 在 water/crest 之间插值。 */
const FRAGMENT_SHADER_SOURCE = `precision mediump float;
uniform vec3 waterColor,crestColor;
varying float ink,alpha;
void main(){
 float radius=length(gl_PointCoord-.5);
 if(radius>.5)discard;
 float edge=1.-smoothstep(.22,.5,radius);
 gl_FragColor=vec4(mix(waterColor,crestColor,ink),alpha*edge);
}`

/** WebGL 主路径持有的资源 */
interface GlResources {
  gl: WebGLRenderingContext
  program: WebGLProgram
  buffer: WebGLBuffer
  locations: Record<string, WebGLUniformLocation | null>
}

/** Canvas 2D 降级路径持有的资源 */
interface Canvas2dResources {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/** uniform 名清单（一次取完，避免每帧 getUniformLocation）。 */
const UNIFORM_NAMES = [
  'resolution',
  'time',
  'waveHeight',
  'wavelength',
  'particleSize',
  'alphaScale',
  'waterColor',
  'crestColor',
  'interaction',
  'pointerWeight',
  'swell',
  'swellRadius',
  'pointer',
  'ripples[0]',
  'rippleCount'
] as const

/**
 * 创建一个粒子海面渲染器。
 *
 * @param host 宿主节点。若本身是 `<canvas>` 就直接复用（React 渲染的那块），
 *             否则新建一块 100%×100% 的 canvas 并 append 进去。
 */
export function createTideRenderer(host: HTMLElement): TideRenderer {
  const providedCanvas = host instanceof HTMLCanvasElement ? host : null
  const canvas: HTMLCanvasElement = providedCanvas ?? document.createElement('canvas')
  if (!providedCanvas) {
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    host.append(canvas)
  }
  canvas.setAttribute('aria-hidden', 'true')

  /** 画布实际像素尺寸（device px） */
  let width = Math.max(1, canvas.width || LOGICAL_WIDTH)
  let height = Math.max(1, canvas.height || LOGICAL_HEIGHT)
  /** 画布 CSS 尺寸：`setPointer()` / `ripple()` 收到的 CSS 像素靠它换算成逻辑坐标 */
  let cssPixelWidth = 0
  let cssPixelHeight = 0
  let disposed = false
  /** 已规划粒子的 density 缓存：只有 density 变了才重排/重传缓冲 */
  let plannedDensity = Number.NaN
  let points: TidePoint[] = []
  let glResources: GlResources | null = null
  let canvas2dResources: Canvas2dResources | null = null
  let lastTime = 0
  let lastSettings: ResolvedSettings | null = null
  let lastFallbackPaintAt = Number.NEGATIVE_INFINITY

  // ── 交互状态（缺省全空，`interactive` 为 false 时永不写入） ────────────────
  /** 最近一次指针位置（CSS 像素，相对画布左上角）；null = 指针不在画布上 */
  let pointerRaw: { cssX: number; cssY: number } | null = null
  /** 指针是否仍在画布内（决定 strength 的目标值 1 还是 0） */
  let pointerInside = false
  /** 平滑后的涌浪/视差权重 0…1 */
  let pointerStrength = 0
  /** 上一帧的指针平滑时刻（`performance.now()`，ms）；0 = 还没开始计时 */
  let lastPointerTickAt = 0
  /** 上一帧求交得到的海面命中点（下一帧求交时当 feedback 用） */
  let pointerWorld: TidePointer | null = null
  /** 存活中的涟漪（最多 RIPPLE_CAPACITY 条，按出生时间升序） */
  let ripples: TideRipple[] = []
  /** 复用给 `uniform3fv` 的缓冲区（36 = 12 条 × vec3），避免每帧分配 */
  const rippleUniformBuffer = new Float32Array(RIPPLE_CAPACITY * 3)

  /**
   * 取当前仍然"活着"的涟漪（0 ≤ age < 6s），最多 12 条。
   *
   * @param time 累计相位秒数
   */
  const collectRipples = (time: number): readonly TideRipple[] => {
    if (ripples.length === 0) return NO_RIPPLES
    const alive: TideRipple[] = []
    for (let index = 0; index < ripples.length; index++) {
      const ripple = ripples[index]
      const age = time - ripple.time
      if (age >= 0 && age < RIPPLE_LIFETIME) alive.push(ripple)
    }
    if (alive.length === 0) return NO_RIPPLES
    return alive.length > RIPPLE_CAPACITY ? alive.slice(alive.length - RIPPLE_CAPACITY) : alive
  }

  /**
   * 推进一步指针平滑 + 重新求交命中点。
   *
   * 时间用 `performance.now()` 的真实增量（而不是渲染相位秒数）：`smooth` 档会
   * 限帧到 30fps，用相位秒数会让衰减速度随档位漂移。
   *
   * @param time    累计相位秒数
   * @param settings 完整设置
   * @param alive    当前活跃涟漪
   */
  const advancePointer = (
    time: number,
    settings: ResolvedSettings,
    alive: readonly TideRipple[]
  ): void => {
    const now = performance.now()
    const deltaSeconds =
      lastPointerTickAt === 0
        ? 0
        : Math.min(
            MAX_POINTER_DELTA_SECONDS,
            Math.max(0, (now - lastPointerTickAt) / 1000)
          )
    lastPointerTickAt = now

    const target = settings.interactive && pointerInside ? 1 : 0
    if (deltaSeconds > 0) {
      // 指数趋近：帧率无关，进出都是同一条曲线
      pointerStrength += (target - pointerStrength) * (1 - Math.exp(-deltaSeconds / POINTER_DECAY_TAU))
    }
    if (target === 0 && pointerStrength < POINTER_STRENGTH_EPSILON) pointerStrength = 0
    if (target === 1 && pointerStrength > 1 - POINTER_STRENGTH_EPSILON) pointerStrength = 1

    if (settings.interactive && pointerRaw) {
      const logicalX = (pointerRaw.cssX / Math.max(1, cssPixelWidth)) * LOGICAL_WIDTH
      const logicalY = (pointerRaw.cssY / Math.max(1, cssPixelHeight)) * LOGICAL_HEIGHT
      const hit = resolveSurfaceHit(logicalX, logicalY, time, settings, pointerWorld, alive)
      pointerWorld = {
        x: hit.x,
        z: hit.z,
        viewX: hit.viewX,
        viewY: hit.viewY,
        strength: pointerStrength
      }
      return
    }
    // 指针已离开：保留上一帧的命中位置，只让权重继续衰减（水面平滑回落）
    if (pointerWorld) pointerWorld = { ...pointerWorld, strength: pointerStrength }
  }

  /** 当前该传给波场的指针（关掉交互 / 权重归零时返回 null，省掉整条高斯分支）。 */
  const activePointer = (settings: ResolvedSettings): TidePointer | null =>
    settings.interactive && pointerWorld && pointerStrength > 0 ? pointerWorld : null

  /** 释放 GL 对象（**不** loseContext，见文件头 diff 说明 f）。 */
  const releaseGl = (): void => {
    const resources = glResources
    if (!resources) return
    const { gl, program, buffer } = resources
    if (buffer) gl.deleteBuffer(buffer)
    if (program) gl.deleteProgram(program)
    glResources = null
  }

  /**
   * 初始化 WebGL 主路径；任何一步失败（含 `getContext('webgl')` 返回 null）都
   * 返回 null，交给 Canvas 2D 降级 —— 绝不抛错白屏。
   */
  const initWebgl = (): GlResources | null => {
    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true
      }) as WebGLRenderingContext | null
    } catch {
      gl = null
    }
    if (!gl) return null

    const shaders: WebGLShader[] = []
    const context = gl
    try {
      const program = context.createProgram()
      if (!program) throw new Error('createProgram failed')
      const sources: ReadonlyArray<readonly [number, string]> = [
        [context.VERTEX_SHADER, VERTEX_SHADER_SOURCE],
        [context.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE]
      ]
      for (const [type, source] of sources) {
        const shader = context.createShader(type)
        if (!shader) throw new Error('createShader failed')
        shaders.push(shader)
        context.shaderSource(shader, source)
        context.compileShader(shader)
        if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
          throw new Error(context.getShaderInfoLog(shader) ?? 'shader compile failed')
        }
        context.attachShader(program, shader)
      }
      context.linkProgram(program)
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        throw new Error('program link failed')
      }
      context.useProgram(program)
      const buffer = context.createBuffer()
      if (!buffer) throw new Error('createBuffer failed')
      context.bindBuffer(context.ARRAY_BUFFER, buffer)
      const attribute = context.getAttribLocation(program, 'point')
      context.enableVertexAttribArray(attribute)
      context.vertexAttribPointer(attribute, 3, context.FLOAT, false, 0, 0)
      const locations: Record<string, WebGLUniformLocation | null> = {}
      for (const name of UNIFORM_NAMES) locations[name] = context.getUniformLocation(program, name)
      context.enable(context.BLEND)
      context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA)
      context.disable(context.DEPTH_TEST)
      return { gl: context, program, buffer, locations }
    } catch (error) {
      // 降级前把失败原因留在控制台（dev 排查用），用户侧只看到 Canvas 2D 结果。
      console.warn('[particleTide] WebGL 初始化失败，降级 Canvas 2D：', error)
      for (const shader of shaders) context.deleteShader(shader)
      return null
    }
  }

  /** 把粒子网格上传成顶点缓冲（只在 density 变化时调用）。 */
  const uploadPoints = (): void => {
    const resources = glResources
    if (!resources) return
    const { gl, buffer } = resources
    const vertices = new Float32Array(points.length * 3)
    for (let index = 0; index < points.length; index++) {
      const point = points[index]
      vertices[index * 3] = point.x
      vertices[index * 3 + 1] = point.z
      vertices[index * 3 + 2] = point.jitter
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  }

  /**
   * 切到 Canvas 2D 降级：新建一块**同静态样式**的画布接在 WebGL 画布后面，
   * 然后把 WebGL 画布 `display:none`。两块画布不共存于视觉上，且不删 React 的节点
   * （删了 React 卸载时会 NotFoundError）。
   */
  const useCanvas2d = (): void => {
    if (canvas2dResources) return
    releaseGl()
    const parent = canvas.parentElement
    if (!parent) return // 没有父节点就无处安放降级画布；保持空白而不是报错
    const fallbackCanvas = document.createElement('canvas')
    fallbackCanvas.setAttribute('aria-hidden', 'true')
    // 先继承 WebGL 画布的全部内联样式（含组件设的 opacity），再强制占满父容器
    fallbackCanvas.style.cssText = canvas.style.cssText
    fallbackCanvas.style.width = '100%'
    fallbackCanvas.style.height = '100%'
    fallbackCanvas.style.display = 'block'
    fallbackCanvas.width = width
    fallbackCanvas.height = height
    const ctx = fallbackCanvas.getContext('2d')
    if (!ctx) return
    canvas.style.display = 'none'
    parent.insertBefore(fallbackCanvas, canvas.nextSibling)
    canvas2dResources = { canvas: fallbackCanvas, ctx }
  }

  /**
   * 按 density 变化（或首次）规划粒子；WebGL 路径顺带上传缓冲。
   *
   * @param settings 完整设置
   */
  const ensurePlan = (settings: ResolvedSettings): void => {
    const density = Math.min(2, Math.max(0.3, settings.density))
    if (density === plannedDensity) return
    plannedDensity = density
    points = planPoints(settings)
    uploadPoints()
  }

  /** 用当前后端画一帧。 */
  const paint = (time: number, settings: ResolvedSettings): void => {
    ensurePlan(settings)
    // 先把交互状态推进一帧，再取"这一帧该用的指针"，两条渲染路径共用同一份状态
    const alive = collectRipples(time)
    advancePointer(time, settings, alive)
    const pointer = activePointer(settings)
    if (glResources) {
      const { gl, program, locations } = glResources
      gl.viewport(0, 0, width, height)
      const background = toUnitRgb(settings.backgroundColor, [0.96, 0.98, 0.99])
      gl.clearColor(background[0], background[1], background[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.uniform2f(locations.resolution, width, height)
      gl.uniform1f(locations.time, time)
      gl.uniform1f(locations.waveHeight, settings.waveHeight)
      gl.uniform1f(locations.wavelength, settings.wavelength)
      gl.uniform1f(locations.particleSize, settings.particleSize)
      gl.uniform1f(locations.alphaScale, settings.alphaScale)
      // 交互 uniform：interaction 是总闸，pointerWeight 是平滑权重（两者都为 1 才满量）
      gl.uniform1f(locations.interaction, pointer ? 1 : 0)
      gl.uniform1f(locations.pointerWeight, pointer ? pointer.strength : 1)
      gl.uniform1f(locations.swell, settings.swell)
      gl.uniform1f(locations.swellRadius, Math.max(MIN_SWELL_RADIUS, settings.swellRadius))
      gl.uniform4f(
        locations.pointer,
        pointer ? pointer.x : 0,
        pointer ? pointer.z : 0,
        pointer ? pointer.viewX : 0,
        pointer ? pointer.viewY : 0
      )
      // ripples 是 vec3[12]：一次 uniform3fv 传满 12 条，未用到的槽留 0（由 rippleCount 截断）
      rippleUniformBuffer.fill(0)
      for (let index = 0; index < alive.length; index++) {
        const ripple = alive[index]
        rippleUniformBuffer[index * 3] = ripple.x
        rippleUniformBuffer[index * 3 + 1] = ripple.z
        rippleUniformBuffer[index * 3 + 2] = ripple.time
      }
      gl.uniform3fv(locations['ripples[0]'], rippleUniformBuffer)
      gl.uniform1i(locations.rippleCount, alive.length)
      const water = toUnitRgb(settings.waterColor, [0.78, 0.82, 0.87])
      const crest = toUnitRgb(settings.crestColor, [1, 1, 1])
      gl.uniform3f(locations.waterColor, water[0], water[1], water[2])
      gl.uniform3f(locations.crestColor, crest[0], crest[1], crest[2])
      gl.drawArrays(gl.POINTS, 0, points.length)
      return
    }
    const fallback = canvas2dResources
    if (!fallback) return
    // 降级路径限速 ~20fps：2D 逐点绘制的开销远高于 GPU 点精灵
    const now = performance.now()
    if (now - lastFallbackPaintAt < FALLBACK_MIN_PAINT_MS) return
    lastFallbackPaintAt = now
    paintCanvas2d(fallback.ctx, points, time, settings, pointer, alive)
  }

  /** WebGL 上下文丢失 → 永久走 Canvas 2D，并把最后一帧补画出来。 */
  const handleContextLost = (event: Event): void => {
    event.preventDefault()
    useCanvas2d()
    if (lastSettings) paint(lastTime, lastSettings)
  }

  // 首次初始化：优先 WebGL，失败即降级（此时 canvas 还没进 DOM 也能建上下文）
  glResources = initWebgl()
  canvas.addEventListener('webglcontextlost', handleContextLost, { once: true })
  if (!glResources) useCanvas2d()

  return {
    resize(cssWidth: number, cssHeight: number, nextDprCap = 1.5): void {
      if (disposed) return
      const cap = Number.isFinite(nextDprCap) && nextDprCap > 0 ? nextDprCap : 1.5
      const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
      const ratio = Math.min(Math.max(1, cap), Math.max(1, devicePixelRatio))
      const nextWidth = Math.max(1, Math.round(Math.max(1, cssWidth) * ratio))
      const nextHeight = Math.max(1, Math.round(Math.max(1, cssHeight) * ratio))
      width = nextWidth
      height = nextHeight
      // CSS 尺寸单独留一份：指针事件给的是 CSS 像素，换算不需要关心 DPR
      cssPixelWidth = Math.max(1, cssWidth)
      cssPixelHeight = Math.max(1, cssHeight)
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      const fallback = canvas2dResources
      if (fallback && (fallback.canvas.width !== nextWidth || fallback.canvas.height !== nextHeight)) {
        fallback.canvas.width = nextWidth
        fallback.canvas.height = nextHeight
      }
    },

    render(timeSeconds: number, settings: TideSettings): void {
      if (disposed) return
      const resolved = resolveSettings(settings)
      lastTime = timeSeconds
      lastSettings = resolved
      paint(timeSeconds, resolved)
    },

    setPointer(x: number | null, y: number | null): void {
      if (disposed) return
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
        // 指针离开：保留命中位置，让 strength 自己衰减（不要硬切，见文件头 a2）
        pointerRaw = null
        pointerInside = false
        return
      }
      pointerRaw = { cssX: x, cssY: y }
      pointerInside = true
    },

    ripple(x: number, y: number): void {
      if (disposed) return
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const settings = lastSettings
      if (!settings || !settings.interactive || !settings.clickRipples) return
      const alive = collectRipples(lastTime)
      const logicalX = (x / Math.max(1, cssPixelWidth)) * LOGICAL_WIDTH
      const logicalY = (y / Math.max(1, cssPixelHeight)) * LOGICAL_HEIGHT
      const hit = resolveSurfaceHit(logicalX, logicalY, lastTime, settings, pointerWorld, alive)
      ripples.push({ x: hit.x, z: hit.z, time: lastTime })
      // 超出容量丢最旧的一条（环形数组语义，用挪动代替取模省一个索引状态）
      if (ripples.length > RIPPLE_CAPACITY) ripples.splice(0, ripples.length - RIPPLE_CAPACITY)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      releaseGl()
      const fallback = canvas2dResources
      if (fallback) {
        fallback.canvas.remove()
        canvas2dResources = null
        // 恢复 WebGL 画布的可见性（它可能被降级逻辑隐藏过）
        canvas.style.removeProperty('display')
      }
      if (!providedCanvas) canvas.remove()
      points = []
      plannedDensity = Number.NaN
      lastSettings = null
      // 交互状态一并清空：StrictMode 复挂时不会带着上一次的指针/涟漪复活
      pointerRaw = null
      pointerInside = false
      pointerStrength = 0
      lastPointerTickAt = 0
      pointerWorld = null
      ripples = []
    }
  }
}
