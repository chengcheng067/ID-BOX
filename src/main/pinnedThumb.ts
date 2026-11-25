/**
 * 应用内文件浏览器（`PinnedFolderBrowser` 图标视图）的**文件缩略图主进程链路**。
 *
 * 需求：图标视图里 JPG/PNG 等图片文件显示预览图；SKP 读取内嵌预览图；
 * 其他扩展名（max / dwg / rar …）不做系统级缩略图（IExtractImage 成本高且不稳定，
 * 明确不做）—— 返回 `not-available`，渲染层走自绘类型图标兜底。
 *
 * 契约（`shared/ipc.ts` 的 `fsEntryThumb` / `PinnedEntryThumbResult`）：
 * - `{ ok:true, url }` —— url 走 **专用协议** `pinned-thumb://<缓存文件名>`
 *   （`protocol.ts` 注册，读缓存目录 + 越界夹取；禁止 `file://` 直连）；
 * - `{ ok:false, reason }` —— `not-available`（提取不了 / 不是图片）/ `io`（读盘失败）
 *   / `guard`（dirRel 越界或条目名非法）。
 *
 * 缓存：`<userData>/pinned-thumbs/`，文件名 `<fnv1a(绝对路径)>-<mtimeMs>.png`
 * （路径进哈希防重名，mtime 进文件名防过期 —— 源文件被改写后文件名必然变化，
 * 渲染层拼出的 `pinned-thumb://` URL 也随之变化，Chromium 不会命中旧字节）。
 * 命中缓存直接返回、**不重解码**（大文件夹图标视图会反复滚动，必须幂等）。
 *
 * 节流：渲染层一次会请求几十个文件，入口统一过模块级 promise 池
 * （并发上限 {@link PINNED_THUMB_CONCURRENCY}），避免一次性解码几十张图卡死主进程。
 *
 * SKP 内嵌预览提取**复用** `main/skpPreview.ts#extractSkpPreview`（CDib 锚定，
 * 与导入链路同一份实现，零复制粘贴）；提取失败返回 `not-available`。
 *
 * SKP 空白预览兜底（2026-11-25 用户实测：一批 .skp 卡片显示"白底 + 灰色文档小图标"）：
 * SU 会把**纯白占位图**写进 CDib 槽位（模型没存过缩略图 / 模型是空场景），提取链路
 * 完全成功，于是缓存里落了一张 100% 白的图 —— 视觉上等于没图。因此 SKP 路径在落盘前
 * 解一次像素做 {@link isBlankPreviewBitmap} 判定：判为空白 → 不写缓存、返回
 * `not-available`，渲染层回落到自绘 SU 大字徽标。图片路径**不做**该判定
 * （用户自己的白底图是真实内容，误杀代价远大于收益）。
 */
import { app, nativeImage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveWithinPinRoot } from './pinnedDirGuard'
import { validateEntryName } from './archiveOps'
import { extractSkpPreview } from './skpPreview'
import { thumbSalt, resizeToMaxPx } from '../shared/thumb'
import { extOf } from '../shared/format'
import type { PinnedEntryThumbResult } from '../shared/ipc'

/** 缓存目录（`bg://` / `hdr://` 同款生命周期：可随时整体删掉，下次请求重算） */
export function pinnedThumbsDir(): string {
  return path.join(app.getPath('userData'), 'pinned-thumbs')
}

/** 缓存目录（不存在时 recursive mkdir） */
async function ensurePinnedThumbsDir(): Promise<string> {
  const dir = pinnedThumbsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 缩略图最长边像素上限（图标视图磁贴 56px @2x 高 DPI → 512 已远超所需） */
export const PINNED_THUMB_MAX_PX = 512

/** 参与预览的图片扩展名（spec 口径：jpg/jpeg/png/webp/bmp/gif；tif/tga 等不在此列） */
const IMAGE_THUMB_EXTS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'])

/** `pinned-thumb://` 专用协议（`protocol.ts` 注册；缓存文件名即 URL host） */
export const PINNED_THUMB_SCHEME = 'pinned-thumb'

/** 缓存文件名 → 渲染层可直接挂 `<img src>` 的 URL */
export function pinnedThumbUrl(name: string): string {
  return `${PINNED_THUMB_SCHEME}://${name}`
}

/**
 * 缓存文件名：`<fnv1a(绝对路径) 8hex>-<mtime 整数毫秒>.<png|jpg>`。
 *
 * - 路径进哈希：不同文件（哪怕同名不同目录）不撞名；
 * - mtime 进文件名：源文件被改写 → 缓存名变 → URL 变 → 浏览器缓存自然失效；
 *   mtime 取整（`Math.round`）保证同一文件多次 stat 得到**确定**的名字（幂等）；
 * - ext：图片统一输出 PNG（含 webp/bmp/gif 转码）；SKP 内嵌图保持原格式
 *   （PNG/JPEG 字节直接落盘，扩展名必须与字节一致，协议侧按扩展名给 MIME）。
 */
export function pinnedThumbFileName(absPath: string, mtimeMs: number, ext: 'png' | 'jpg'): string {
  const hash = thumbSalt(absPath ?? '')
  const mtime = Number.isFinite(mtimeMs) ? Math.round(mtimeMs) : 0
  return `${hash}-${mtime}.${ext}`
}

// ── 并发闸门：模块级 promise 池（入口排队，主进程不被一次性解码几十张图卡死）────

export interface PinnedThumbGate {
  /** 提交一个任务；池满时排队，拿到空位才执行 */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** 当前**执行中**的任务数（≤ 并发上限） */
  readonly inFlight: number
  /** 当前**排队中**的任务数 */
  readonly queued: number
}

/**
 * 通用信号量池。`release` 同步唤醒下一个等待者（FIFO），
 * 保证 `run` 的判定 `inFlight < cap` 与排队不会出现插队/饿死。
 */
export function createPinnedThumbGate(limit: number): PinnedThumbGate {
  const cap = Math.max(1, Math.floor(limit))
  let running = 0
  const waiters: Array<() => void> = []
  const release = (): void => {
    running--
    const next = waiters.shift()
    if (next) next()
  }
  const start = <T>(fn: () => Promise<T>): Promise<T> => {
    running++
    return fn().finally(release)
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      if (running < cap) return start(fn)
      return new Promise<T>((resolve, reject) => {
        waiters.push(() => {
          start(fn).then(resolve, reject)
        })
      })
    },
    get inFlight(): number {
      return running
    },
    get queued(): number {
      return waiters.length
    }
  }
}

/** 并发上限（spec 拍板 4）：本地图片解码是 CPU 密集，4 个并行已能喂饱图标视图 */
export const PINNED_THUMB_CONCURRENCY = 4

const gate = createPinnedThumbGate(PINNED_THUMB_CONCURRENCY)

/** 把一个任务排进缩略图池（handler 入口统一走这里；测试用它验证并发上限） */
export function runInPinnedThumbQueue<T>(fn: () => Promise<T>): Promise<T> {
  return gate.run(fn)
}

/** 队列水位（观测/测试用） */
export function pinnedThumbQueueStats(): { inFlight: number; queued: number } {
  return { inFlight: gate.inFlight, queued: gate.queued }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 解析一个钉选目录条目的缩略图（`fs:entryThumb` 的实现体）。
 *
 * 守卫（与既有 fs:* 通道同一口径，只是收在本模块里以便直测）：
 * - `dirRel` 过 `pinnedDirGuard.resolveWithinPinRoot`（逐段 resolve + 前缀校验，
 *   挡 `..` 穿越 / 绝对路径注入 / 盘符切换）；
 * - `name` 是**单段**条目名，过 `archiveOps.validateEntryName`
 *   （`\/:*?"<>|` / `..` / 控制字符全拒）；
 * - 越界返回 `{ok:false, reason:'guard'}`，绝不读写根外任何路径。
 *
 * 全程 try/catch 收口 `PinnedEntryThumbResult`，**永不 reject**。
 */
export async function resolveThumbForEntry(
  pinnedRoot: string,
  dirRel: string,
  name: string
): Promise<PinnedEntryThumbResult> {
  return runInPinnedThumbQueue(() => resolveThumbForEntryNow(pinnedRoot, dirRel, name))
}

async function resolveThumbForEntryNow(
  pinnedRoot: string,
  dirRel: string,
  name: string
): Promise<PinnedEntryThumbResult> {
  try {
    const guard = resolveWithinPinRoot(pinnedRoot, dirRel)
    if (!guard.ok) return { ok: false, reason: 'guard', error: guard.error }
    const badName = validateEntryName(name)
    if (badName !== null) return { ok: false, reason: 'guard', error: badName }

    const abs = path.join(guard.absPath, name)
    const st = await fs.stat(abs).catch(() => null)
    if (!st || !st.isFile()) return { ok: false, reason: 'not-available' }

    const ext = extOf(name)
    if (IMAGE_THUMB_EXTS.has(ext)) return await imageThumb(abs, st.mtimeMs)
    if (ext === 'skp') return await skpThumb(abs, st.mtimeMs)
    // max / dwg / dxf / rar …：不做系统级缩略图 API，渲染层自绘类型图标兜底
    return { ok: false, reason: 'not-available' }
  } catch {
    return { ok: false, reason: 'io' }
  }
}

/**
 * 图片：`nativeImage` 解码 → 等比缩到最长边 ≤ {@link PINNED_THUMB_MAX_PX} → PNG 落盘。
 * 解码不出（ exotic 位图 / 损坏文件）返回 `not-available`，绝不抛。
 */
async function imageThumb(abs: string, mtimeMs: number): Promise<PinnedEntryThumbResult> {
  const name = pinnedThumbFileName(abs, mtimeMs, 'png')
  const out = path.join(await ensurePinnedThumbsDir(), name)
  // ① 已生成过 → 直接复用（**不 decode**）。尺寸 0 视为上次写盘被打断的残骸，重做。
  const cached = await fs.stat(out).catch(() => null)
  if (cached && cached.isFile() && cached.size > 0) return { ok: true, url: pinnedThumbUrl(name) }

  const img = nativeImage.createFromPath(abs)
  if (!img || img.isEmpty()) return { ok: false, reason: 'not-available' }
  const size = img.getSize()
  const target = resizeToMaxPx(size.width, size.height, PINNED_THUMB_MAX_PX)
  const scaled =
    target.width === size.width && target.height === size.height
      ? img
      : img.resize({ width: target.width, height: target.height, quality: 'good' })
  await fs.writeFile(out, scaled.toPNG())
  return { ok: true, url: pinnedThumbUrl(name) }
}

// ── SKP 空白预览判定（纯计算，便于单测）──────────────────────────────────────

/**
 * 全量扫描的像素上限（1M）。以内逐像素统计（256² 与 1024² 都在内，实测单张 < 3ms），
 * 超过才按 `stride` 稀疏取样。
 *
 * 为什么不固定「64×64 网格采样」：等步长网格会和周期性图案**混叠** ——
 * 实测 256×256 图按 stride=4 取样时，2px 棋盘图案恰好每次都落在同色像素上，
 * 会被误判成单色；1px 细线落在步长之间则完全采不到。缩略图本来就只有
 * 256²~1024²，全扫更准也更快，没必要省这点时间。
 */
export const BLANK_FULL_SCAN_MAX_PX = 1 << 20

/** 「近白」像素通道下限（RGB 三通道都 ≥ 该值才算近白） */
export const BLANK_NEAR_WHITE_MIN = 245

/** 近白像素占比达到该值 + 极低亮度方差 → 判空白（实测纯白占位图 = 100%） */
export const BLANK_WHITE_RATIO_MAX = 0.995

/** 近白图允许的亮度标准差上限（JPEG 压缩噪声也在 1 以内） */
export const BLANK_WHITE_STD_MAX = 4

/** 任意单色（纯黑 / 纯灰 / 纯白）的亮度标准差上限 */
export const BLANK_UNIFORM_STD_MAX = 1.5

/**
 * 一张**原始位图**的最小视图（`nativeImage.toBitmap()` 的产出：8bit BGRA，
 * `data.length === width * height * 4`）。
 *
 * 不 import electron 的类型，纯函数可在 vitest 里直接构造。
 */
export interface PreviewBitmap {
  data: Uint8Array
  width: number
  height: number
}

/**
 * 判断一张 SKP 内嵌预览是否**等于没图**（纯白占位 / 整图单色）。
 *
 * 两个必要条件（同时满足其一才判空白）：
 * ① `σ(L) ≤ {@link BLANK_UNIFORM_STD_MAX}`：整图单色（纯黑、纯灰、纯白都算）；
 * ② 近白像素占比 ≥ {@link BLANK_WHITE_RATIO_MAX} **且** `σ(L) ≤ {@link BLANK_WHITE_STD_MAX}`：
 *    「几乎整图均匀白」（纯白占位图 + 带一点点压缩噪声的同款）。
 *
 * 为什么用「近白占比 + 亮度方差」而不是「平均亮度」：白底线稿的平均亮度同样接近 255，
 * 但 variance 高（线稿像素远离白）；只有**均匀**的白才是占位图。2026-11-25 用用户
 * 真实库 71 个 .skp 的提取结果实测标定（256² 全扫）：
 * - 2 张纯白占位：whitePct=100.0、σ=0.0（71 张里仅这两张被此判据判空白）；
 * - 最近的有内容样本：s34（白底线稿）whitePct=98.21、σ=5.54；s50（角落小摆件）
 *   whitePct=98.67、σ=21.24；s52（低对比实拍风渲染）whitePct=0、σ=2.88。
 * 阈值取 σ=4 / whitePct=99.5% 与 σ=1.5 —— 与非空白样本最近处仍有
 * 「占比 1.3 个百分点 / σ 1.5」的余量。
 *
 * 布局不明（长度不够 / 尺寸非法）时返回 **false**：宁可让一张白图露出来，
 * 也不能因为解码布局变化误杀正常预览。
 */
export function isBlankPreviewBitmap(bitmap: PreviewBitmap | null | undefined): boolean {
  if (!bitmap) return false
  const width = Math.floor(bitmap.width)
  const height = Math.floor(bitmap.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false

  const data = bitmap.data
  if (!data || data.length < width * height * 4) return false

  const total = width * height
  const stride = total <= BLANK_FULL_SCAN_MAX_PX ? 1 : Math.ceil(Math.sqrt(total / BLANK_FULL_SCAN_MAX_PX))
  let samples = 0
  let nearWhite = 0
  let sumL = 0
  let sumL2 = 0

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4
      // toBitmap 在 Windows 上是 BGRA（alpha 不参与：内嵌预览恒不透明，带透明的占位图会落到
      // 「单色」分支）。通道顺序即使用错也不影响结论：近白判据对三通道完全对称，
      // 亮度权重（0.299/0.587/0.114）的差异远小于阈值余量。
      const b = data[i]
      const g = data[i + 1]
      const r = data[i + 2]
      samples++
      if (r >= BLANK_NEAR_WHITE_MIN && g >= BLANK_NEAR_WHITE_MIN && b >= BLANK_NEAR_WHITE_MIN) {
        nearWhite++
      }
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      sumL += l
      sumL2 += l * l
    }
  }

  const mean = sumL / samples
  const variance = Math.max(0, sumL2 / samples - mean * mean)
  const std = Math.sqrt(variance)

  if (std <= BLANK_UNIFORM_STD_MAX) return true
  return nearWhite / samples >= BLANK_WHITE_RATIO_MAX && std <= BLANK_WHITE_STD_MAX
}

/**
 * 把内嵌预览的图片字节解成原始位图（判空白用）。解不出来返回 null —— 调用方按
 * 「有内容」处理，保持旧行为（照常落缓存），绝不因为多解一次像素而丢预览。
 */
function decodePreviewBitmap(buffer: Buffer): PreviewBitmap | null {
  try {
    const img = nativeImage.createFromBuffer(buffer)
    if (!img || img.isEmpty()) return null
    const size = img.getSize()
    const data = img.toBitmap()
    if (!data || size.width <= 0 || size.height <= 0) return null
    if (data.length < size.width * size.height * 4) return null
    return { data, width: size.width, height: size.height }
  } catch {
    return null
  }
}

/**
 * SKP：复用 `skpPreview.ts#extractSkpPreview`（CDib 锚定 + 启发式兜底，导入链路
 * 同一份实现）。提取到的 PNG/JPEG 字节**原样**落缓存（扩展名跟内嵌格式走，
 * 协议侧按扩展名给 MIME）；没有内嵌图 → `not-available`（渲染层自绘 SU 图标）。
 *
 * 提取成功但像素判定为**空白占位图**（见 {@link isBlankPreviewBitmap}）时同样返回
 * `not-available`：不写缓存文件，并顺手删掉旧版本可能已写下的同一份白图
 * （文件名由「路径 + mtime + 扩展名」确定，同一份字节重算名字不变 → 旧版留下的白图
 * 一定就是这一支算出来的名字，删它不会误伤别的条目）。
 */
async function skpThumb(abs: string, mtimeMs: number): Promise<PinnedEntryThumbResult> {
  const found = await extractSkpPreview(abs)
  if (!found) return { ok: false, reason: 'not-available' }
  const name = pinnedThumbFileName(abs, mtimeMs, found.ext)
  if (isBlankPreviewBitmap(decodePreviewBitmap(found.buffer))) {
    await fs.unlink(path.join(pinnedThumbsDir(), name)).catch(() => {})
    return { ok: false, reason: 'not-available' }
  }
  const out = path.join(await ensurePinnedThumbsDir(), name)
  await fs.writeFile(out, found.buffer)
  return { ok: true, url: pinnedThumbUrl(name) }
}
