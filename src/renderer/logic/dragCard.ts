/**
 * 拖动时的「浮动卡片」位图渲染（纯渲染层，可单测的部分尽量纯）。
 *
 * ## 为什么是位图
 *
 * 这是 Windows 原生 OLE 拖拽（`webContents.startDrag`），**只能给一张静态图**：
 * 没有 HTML overlay、没有动画、没有实时的"跟手动效"。所以要"看起来像卡片"，
 * 只能预先画好一张 PNG（圆角底 + 缩略图 cover 裁切 + 底部资产名）。
 *
 * ## 卡片上的图：≤1024 预览图（docs/26 方案 C + H）
 *
 * 预热时**先用 IPC 请求一张预生成的 ≤1024 预览图**（`thumb:preview`），拿到 URL 才画；
 * 拿不到（源文件读不了 / 解码失败 / IPC 异常）就退回调用方给的 `thumbUrl`
 * （通常是 480 缩略图）。这样"拖一次 8K 贴图要解码几十 MB"的路径就不存在了，
 * 并且**回退语义不变**：卡片的图永远是"便宜的"，绝不会为了预览把拖拽拖死。
 *
 * ## 为什么必须预热而不是在 dragstart 里现画
 *
 * `startDrag` 必须在 `dragstart` 的**同步段**里发起（invoke 的 Promise 往返会丢手势，
 * 见 `main/index.ts` 的 IPC.dragStart 注释）。而 `canvas.toBlob` 是异步回调，
 * 等它回来时手势已经结束 → 拖不起来。因此：**hover 时预热**（120ms 防抖）写进缓存，
 * `dragstart` 同步读缓存；未命中就退回原来的缩略图图标，绝不能因为没预热而拖不动。
 *
 * ## 失败语义
 *
 * 一律返回 `null`，由调用方回退到 `resolveDragIcon(thumbName)`：
 * - 没有 DOM（vitest node 环境）；
 * - 缩略图 / 预览图加载失败、不是图片；
 * - **canvas 被 taint**（跨源图片没有 CORS）→ `toBlob` 抛 `SecurityError`；
 * - `toBlob` 返回 null（内存不足 / 尺寸为 0）。
 *
 * ## 0.8.3 竞态钉死：「写完才发」的契约（P0 崩溃修复）
 *
 * 外部用户实锤崩溃（v0.8.2）：主进程 `startDrag` 内部对 Temp 临时图路径
 * `createFromPath` 读成空图直接 throw（杀软对刚落盘文件的瞬时独占扫描锁）。
 * 渲染层这边的职责是把「**交给主进程的字节永远是完整的**」钉死：
 *
 * 1. **完整才入缓存**：`cacheDragCard` 只在预热链路的最后一步被调用 ——
 *    `canvas.toBlob` 完整回调出全部 PNG 字节之后；编码半途失败返回 null、不入缓存。
 *    所以缓存里**不存在半张卡**。
 * 2. **dragstart 同步读缓存，绝不等待**：命中 = 拿到的一定是完整 PNG；未命中 =
 *    立刻传 `null` 走主进程的缩略图 / 内嵌降级。dragstart 是同步事件，这里
 *    **绝不 await、绝不现画**（等待会把拖拽手势丢掉）——「写图慢于拖拽」的场景
 *    永远以无图降级收场，拖拽可用性优先于卡片观感，0ms 阻塞预算。
 * 3. **Temp 临时文件由主进程写**：渲染层只经一次 IPC（结构化克隆，原子）发完整
 *    字节；落盘发生在主进程 dragStart 处理器内部、`startDrag` 之前 —— 渲染层
 *    不存在「写了一半的临时文件」可以被发出去，主进程侧的路径加载失败由
 *    `dragIconGuard` 的 isEmpty 降级兜底（不 throw）。
 *
 * ⚠️ 不要用 `setDragImage`：这条拖拽已被 `beginSystemDrag` 的 `preventDefault()` 取消，
 * 渲染进程根本没有 HTML5 拖拽会话可挂 drag image。
 */

import { ensurePreviewUrl } from './previewThumb'

/** 主题（跟随 `document.documentElement.dataset.theme`） */
export type DragCardTheme = 'light' | 'dark'

/** 卡片配色（与 `styles.css` 的设计 token 同值，作为 CSS 变量读不到时的兜底） */
export interface DragCardPalette {
  /** 卡片底（浅色白卡 / 深色比应用底**亮一档**，否则在深色底上看不出这是张卡） */
  surface: string
  /** 1px 描边 */
  border: string
  /** 内圈高光（贴边的那道亮线，深色主题下靠它把卡片轮廓"抠"出来） */
  ring: string
  /** 资产名 */
  text: string
  /** 无缩略图时的占位底 */
  thumbBg: string
}

/**
 * 两套配色（**不是写死一种颜色**：深浅主题各一套，运行时优先读 CSS 变量）。
 *
 * 2026-10-21 用户反馈「拖出来像一截长图、很难接受」：根因之一是**卡片底和应用底色
 * 几乎同一个值**（#1C1C1E vs #161618），系统又按半透明合成 → 只能看到中间那块图，
 * 卡片的形状完全读不出来。所以深色底改用比应用底明显亮一档的 #2B2B2F，
 * 再加一道 16% 白的内圈高光，保证"圆角矩形"这个形状在半透明下依然成立。
 */
export function dragCardPalette(theme: DragCardTheme): DragCardPalette {
  if (theme === 'dark') {
    return {
      surface: '#2b2b2f',
      border: '#3d3d42',
      ring: 'rgba(255,255,255,0.16)',
      text: '#f2f2f4',
      thumbBg: '#232326'
    }
  }
  return {
    surface: '#ffffff',
    border: '#e8edf2',
    ring: 'rgba(15,23,42,0.10)',
    text: '#1f2937',
    thumbBg: '#f1f5f9'
  }
}

/**
 * 卡片尺寸（px）：**正方形 176×176**。
 *
 * 2026-10-21：原来是 168×210 的竖版。用户对竖版的观感是"一截长图"—— 系统再叠一层
 * 半透明后，剩下的就只有中间那块竖长图。改正方形 + 图片 `contain`（完整不裁）
 * 之后，"圆角卡片里装着一张图"这件事才看得出来。
 */
export const DRAG_CARD_WIDTH = 176
export const DRAG_CARD_HEIGHT = 176

export interface RenderDragCardOptions {
  /** 缩略图 URL（通常 `thumbVaultUrl(asset.thumbPath)`）；null/空 = 无缩略图，画占位 */
  thumbUrl: string | null
  /** 资产名（底部单行，超长截断加省略号） */
  name: string
  /** 逻辑宽（默认 168） */
  width?: number
  /** 逻辑高（默认 210） */
  height?: number
  /** 设备像素比（默认取 window.devicePixelRatio；内部按 `Math.min(2, dpr)` 封顶） */
  dpr?: number
  /** 主题；缺省读 `document.documentElement.dataset.theme` */
  theme?: DragCardTheme
  /** 卡片底色覆盖（默认取调色板；一般不用传） */
  surface?: string
}

/**
 * hover 预热的入参：在卡片渲染参数之上，多一个**预览图来源**。
 *
 * `preview` 非空时，预热会**先** `await ensurePreviewUrl(...)`（主进程生成 / 复用
 * ≤1024 预览图），成功才把 `thumbUrl` 换成预览 URL 去画；失败就用原来的 `thumbUrl`。
 * 绝不能因为"预览没生成好"而少画一张卡 —— 拖拽可用性优先于观感。
 */
export interface PrewarmDragCardOptions extends RenderDragCardOptions {
  /** 预览图来源（资产 id + 源文件绝对路径）；`null` / 省略 = 不请求预览 */
  preview?: { id: string; absPath: string | null } | null
}

/** 运行环境是否具备 canvas（vitest node 环境没有 → 调用方直接回退） */
function canRenderCanvas(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

function currentTheme(): DragCardTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light'
}

/** 读主题 CSS 变量（读不到就用 palette 兜底） */
function themeColor(cssVar: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

/** 加载图片；`crossOrigin='anonymous'` 让 `vault://` 的 CORS 头生效（否则 canvas 会被 taint） */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`drag card: 缩略图加载失败 ${url}`))
    img.src = url
  })
}

/** 圆角矩形路径（不用 ctx.roundRect：Electron 33 的 Chromium 虽支持，但显式路径更好控） */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

/**
 * `object-fit: contain` 的等价绘制（等比缩放到完整放得下，居中，四周留底色）。
 *
 * 2026-10-21：拖拽卡片改用它。`cover` 会把长图 / 宽图裁掉一截，用户看到的
 * 就是"一截长图"；`contain` 保证整张图都在这张卡里。
 */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) return
  const scale = Math.min(w / iw, h / ih)
  const dw = iw * scale
  const dh = ih * scale
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/** 单行截断（按码点，避免把 emoji / 代理对切一半），超长结尾加省略号 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  const chars = Array.from(text)
  let cut = chars.length
  while (cut > 0) {
    cut -= 1
    const candidate = `${chars.slice(0, cut).join('')}…`
    if (ctx.measureText(candidate).width <= maxWidth) return candidate
  }
  return '…'
}

/** canvas → PNG 字节；taint / 编码失败都返回 null（**不抛**） */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(null)
          return
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(() => resolve(null))
      }, 'image/png')
    } catch {
      // 跨源图片没带 CORS → canvas 被 taint → toBlob 抛 SecurityError
      resolve(null)
    }
  })
}

/**
 * 渲染一张「拖拽卡片」PNG。
 *
 * @returns PNG 字节；任何失败返回 `null`（调用方回退到缩略图图标）
 */
export async function renderDragCard(options: RenderDragCardOptions): Promise<Uint8Array | null> {
  if (!canRenderCanvas()) return null

  const width = Math.max(32, Math.round(options.width ?? DRAG_CARD_WIDTH))
  const height = Math.max(32, Math.round(options.height ?? DRAG_CARD_HEIGHT))
  const theme = options.theme ?? currentTheme()
  const palette = dragCardPalette(theme)
  // ⚠️ 卡片底 / 描边 / 高光**必须用调色板**，不能读 `--surface-card`：
  // 那个值就是应用卡片的底色（深色 #1C1C1E），拖拽影像在深色底上会彻底隐形
  // （用户看到的就是"一截图"，读不出卡片形状 —— 2026-10-21 反馈）。
  const surface = options.surface ?? palette.surface
  const border = palette.border
  const ring = palette.ring
  const textColor = themeColor('--text-primary', palette.text)
  const thumbBg = palette.thumbBg

  const rawDpr = options.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1
  // 封顶 2：再高只是浪费内存与 IPC 体积，OLE 图标本身还会被系统缩放
  const dpr = Math.min(2, Math.max(1, Number.isFinite(rawDpr) ? rawDpr : 1))

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(dpr, dpr)

  // ── 布局（正方形卡：图片区 + 底部名字条） ───────────────
  const pad = 8
  const footerH = 30
  const thumbW = width - pad * 2
  const thumbH = height - pad * 2 - footerH
  const radius = 14

  // ── 卡片底 + 柔和阴影 ─────────────────────────────────
  ctx.save()
  ctx.shadowColor = theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(100,116,139,0.3)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 5
  roundRectPath(ctx, 0.5, 0.5, width - 1, height - 1, radius)
  ctx.fillStyle = surface
  ctx.fill()
  ctx.restore()

  // ── 内圈高光（深色主题下靠它把卡片轮廓抠出来；系统再叠半透明也还看得见）──
  roundRectPath(ctx, 1, 1, width - 2, height - 2, radius - 1)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = ring
  ctx.stroke()

  // ── 1px 描边（内缩 0.5 保证像素对齐） ──────────────────
  roundRectPath(ctx, 0.5, 0.5, width - 1, height - 1, radius)
  ctx.lineWidth = 1
  ctx.strokeStyle = border
  ctx.stroke()

  // ── 图片（contain：完整不裁 + 圆角裁剪） ──────────────
  ctx.save()
  roundRectPath(ctx, pad, pad, thumbW, thumbH, 10)
  ctx.clip()
  ctx.fillStyle = thumbBg
  ctx.fillRect(pad, pad, thumbW, thumbH)
  if (options.thumbUrl) {
    try {
      const img = await loadImage(options.thumbUrl)
      drawContain(ctx, img, pad, pad, thumbW, thumbH)
    } catch {
      // 图片加载失败：保留占位底，继续画名称（卡片仍然可用）
    }
  }
  ctx.restore()

  // ── 底部名字（单行，居中） ─────────────────────────────
  const fontSize = 12
  const textPadX = 10
  ctx.fillStyle = textColor
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = `600 ${fontSize}px "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`
  const name = ellipsize(
    ctx,
    (options.name ?? '').trim(),
    width - textPadX * 2
  )
  ctx.fillText(name, textPadX, height - pad - footerH / 2 + 1)

  return canvasToPng(canvas)
}

// ── 预热缓存（AssetGrid hover 写入，dragstart 同步读取） ─────────────

/** 缓存上限（LRU）：一次扫过一屏最多 20 张，再多就是浪费内存 */
export const DRAG_CARD_CACHE_LIMIT = 20

const cardCache = new Map<string, Uint8Array>()

/** 读缓存（命中即刷新 LRU 顺序）；未预热返回 null */
export function cachedDragCard(assetId: string): Uint8Array | null {
  const hit = cardCache.get(assetId)
  if (!hit) return null
  cardCache.delete(assetId)
  cardCache.set(assetId, hit)
  return hit
}

/**
 * 写缓存（0.8.3 契约的入口）：**只有完整渲染出的 PNG 才允许进来**。
 *
 * 调用时机 = 预热链路的最后一步（`renderDragCard` / `renderWithPreview` 的 Promise
 * resolve 之后），所以 dragstart 同步读到的命中值必然是完整字节；空数据 / null
 * （编码失败等）一律拒收，调用方 dragstart 时自然走「未命中 → 传 null」的无图降级。
 * 超上限淘汰最久未使用的一条。
 */
export function cacheDragCard(assetId: string, png: Uint8Array | null): void {
  if (!assetId || !png || png.byteLength === 0) return
  cardCache.delete(assetId)
  cardCache.set(assetId, png)
  while (cardCache.size > DRAG_CARD_CACHE_LIMIT) {
    const oldest = cardCache.keys().next().value
    if (oldest === undefined) break
    cardCache.delete(oldest)
  }
}

/** 当前缓存条数（单测 / 调试用） */
export function dragCardCacheSize(): number {
  return cardCache.size
}

/** 清空缓存（单测用） */
export function clearDragCardCache(): void {
  cardCache.clear()
}

/**
 * 缓存键（2026-10-21）：同一个资产里不同**文件**要各自一张卡，键里必须带 rel；
 * 不带 rel = 资产卡（网格/详情面板顶部的整体预览）。
 */
export function dragCardKey(assetId: string, rel?: string | null): string {
  return rel ? `${assetId}::${rel}` : assetId
}

/** hover 预热防抖（ms）：扫过一排卡片时不逐张渲染 */
const PREWARM_DELAY = 120

/** 模块级单例 timer：任何时刻只会有一张卡在预热（鼠标只有一个） */
let prewarmTimer: ReturnType<typeof setTimeout> | null = null
/** 已排队但还没跑的那张卡的键（用于鼠标移出时快速取消 + 避免重复排队） */
let prewarmKey: string | null = null

/**
 * hover 预热拖拽卡片（**文件视图 / 详情面板**用；网格有自己的 `hoverProps` 预热）。
 *
 * 为什么必须预热：`startDrag` 必须在 `dragstart` 的同步段发起，而 `canvas.toBlob`
 * 是异步的 —— 现画来不及，只能提前画好放缓存（见文件头注释）。
 *
 * 时序（方案 C + H）：`hover` → 120ms 防抖 → **请求 ≤1024 预览图（IPC）** →
 * 用预览 URL 画卡（失败则用 `thumbUrl` 画）→ 写缓存。到 `dragstart` 时再同步读缓存。
 *
 * 命中缓存 / 无 DOM 环境直接返回；同一时刻只保留最后一次 hover 的那张。
 */
export function prewarmDragCard(key: string, options: PrewarmDragCardOptions): void {
  if (!key || !canRenderCanvas()) return
  if (cardCache.has(key)) return
  if (prewarmKey === key && prewarmTimer !== null) return
  cancelDragCardPrewarm()
  prewarmKey = key
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null
    const k = prewarmKey
    prewarmKey = null
    if (!k) return
    void renderWithPreview(options)
      .then((png) => cacheDragCard(k, png))
      .catch(() => undefined)
  }, PREWARM_DELAY)
}

/**
 * 先把「卡片要用的图」定下来，再渲染。
 *
 * 预览解析**永不 reject**（`ensurePreviewUrl` 内部吞掉所有错误），
 * 所以这里的 `await` 不会把拖拽卡片拖成"没图"。
 */
async function renderWithPreview(options: PrewarmDragCardOptions): Promise<Uint8Array | null> {
  if (!options.preview) return renderDragCard(options)
  const previewUrl = await ensurePreviewUrl(options.preview.id, options.preview.absPath)
  // 预览失败 → 原样用 thumbUrl（480 缩略图 / 占位），绝不产出空白卡
  return renderDragCard(previewUrl ? { ...options, thumbUrl: previewUrl } : options)
}

/** 取消尚未开始的预热（鼠标已移开，没必要再画） */
export function cancelDragCardPrewarm(): void {
  if (prewarmTimer !== null) {
    clearTimeout(prewarmTimer)
    prewarmTimer = null
  }
  prewarmKey = null
}
