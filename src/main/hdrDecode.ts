/**
 * RADIANCE HDR（RGBE）**流式解码 + 盒式降采样**（0.6.5）。
 *
 * ## 为什么必须有这一层（不是"优化"，是"能不能跑"）
 *
 * 用户真实样本：`16384 × 8192`、367MB 的 Photoshop 导出 HDR。两条硬墙：
 * 1. `16384` 正好是大量显卡的 `MAX_TEXTURE_SIZE` 上限；
 * 2. three 的 `HDRLoader` 会把它解成 Float32 RGBA ≈ **1.6GB**，渲染进程必崩。
 *
 * 所以渲染进程**只允许**拿到 ≤ 4096 宽的产物，解码与降采样必须在主进程按块做。
 *
 * ## 设计要点
 *
 * - **流式**：`fs.createReadStream` + 自写缓冲读取器，一次只有一条源扫描线在内存里
 *   （16384 宽 = 64KB）；常驻内存 ≈ 输出缓冲 + 一条扫描线。
 * - **盒式平均在浮点空间做**：`f = 2^(e-136)` 反算成浮点后逐通道加权求和，
 *   绝不直接平均 `e` 字节（指数平均会让高光区塌成灰色，是明显的色偏）。
 * - **零新依赖**：不引 sharp / hdr 解析库。
 * - 输出是**标准 RGBE 像素流**（不带头），调用方用 `encodeHdrFile()` 补头落盘，
 *   产物能被 three 的 `HDRLoader` 直接吃（纯 flat 扫描线，见 `encodeHdrFile` 注释）。
 *
 * ## 支持边界（明确写死，不做猜测）
 *
 * - 头：`#?RADIANCE` / `#?RGBE` 起始，`FORMAT=32-bit_rle_rgbe`（其他 FORMAT 明确报错，
 *   不做 XYZE / 16-bit 兼容）；
 * - 方向行：**只支持** `-Y <h> +X <w>`（标准朝向）。其他朝向（`+Y` / `-X`）明确报错
 *   ——猜错就是上下/左右翻图，比报错更糟；
 * - 扫描线：新式 RLE（`2 2 hi lo` + 四通道分别 RLE）、老式 RLE（`1 1 1 count` + 重复像素）、
 *   裸 RGBE（无 RLE）。编码方式按**第一条扫描线**判定一次（判定规则与 three
 *   `HDRLoader` 的 `RGBE_ReadPixels_RLE` 对齐），之后整幅图按同一模式解；
 * - `exr` 不走这里（RGBE 解码器读不了 OpenEXR，调用方会拿到明确报错）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

// ── 公开常量 / 类型 ────────────────────────────────────────────────────

/** 预览目标宽度白名单（IPC 只认这三档，其他值夹到最近的） */
export const HDR_TARGET_WIDTHS = [512, 2048, 4096] as const

export type HdrTargetWidth = (typeof HDR_TARGET_WIDTHS)[number]

export interface HdrDecodeOptions {
  /** 目标宽度（按比例算高），默认 2048；预览建议 2048，缩略图 512 */
  targetWidth: number
  /** 进度回调：0..1，按"已读字节 / 总字节"算（单调不减） */
  onProgress?: (ratio: number) => void
  /** 可中断 */
  signal?: AbortSignal
}

export interface HdrDecodeResult {
  width: number
  height: number
  /** 降采样后的 RGBE 像素流（`width * height * 4` 字节，不含头） */
  rgbe: Buffer
}

/** HDR 解码/准备过程中的**可读错误**（message 直接给用户看） */
export class HdrDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HdrDecodeError'
  }
}

/** 目标宽度归一到白名单（`512 | 2048 | 4096`，取最近的一档；非法 → 2048） */
export function normalizeTargetWidth(value: unknown): HdrTargetWidth {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 2048
  let best: HdrTargetWidth = 2048
  let bestDiff = Number.POSITIVE_INFINITY
  for (const w of HDR_TARGET_WIDTHS) {
    const d = Math.abs(w - n)
    if (d < bestDiff) {
      bestDiff = d
      best = w
    }
  }
  return best
}

/** 单个输出像素上限（4K×4K）。防止误传超大 targetWidth 把主进程内存打爆 */
const MAX_OUTPUT_PIXELS = 4096 * 4096

/** 流式读取块大小（1MB：367MB 文件约 367 次系统调用，足够摊薄） */
const READ_CHUNK_BYTES = 1 << 20

/** 头部单行上限（标准 RADIANCE 头每行都远小于此；防被坏文件拖死） */
const MAX_HEADER_LINE = 4096

/**
 * `2^(e-136)` 查表（e = RGBE 指数字节 0..255）。
 *
 * 等价于 three `HDRLoader` 的 `Math.pow(2, e - 128) / 255`（1/255 = 2^-7.994，
 * 这里按经典 rgbe.c 的 2^-136 近似，误差 < 0.1%，肉眼不可见）。
 * 做成表是因为 1.3 亿像素逐点 `Math.pow` 要十几秒 —— 这是本模块唯一的热点。
 */
const EXP2: Float64Array = (() => {
  const t = new Float64Array(256)
  for (let e = 0; e < 256; e++) t[e] = Math.pow(2, e - 136)
  return t
})()

// ── 流式字节读取器 ────────────────────────────────────────────────────

type ScanMode = 'rle' | 'old' | 'flat'

/**
 * 按需拉取的字节读取器：把流式 chunk 排成队列，按游标顺序消费。
 *
 * - `ensure(n)`：保证从当前游标起至少 n 字节可读（不够就继续拉 chunk）；
 * - `peek(i)` / `consume(n)` / `bytes(n)`：只在 `ensure` 之后调用；
 * - `bytes(n)` **优先返回零拷贝视图**（数据落在同一个 chunk 内时）；只有跨 chunk
 *   边界才拷贝 n 字节（n 通常是单条扫描线的一部分，≤64KB）。
 *
 * 为什么不做"每次 pull 就 concat 成一个连续缓冲"：那是 O(文件大小) 的额外拷贝，
 * 367MB 的源文件会在 V8 里堆出几百 MB 的外部内存垃圾（实测 RSS 从 160MB 飙到 290MB）。
 * 队列方式把拷贝量压到"每个 chunk 边界最多一条扫描线"，RSS 峰值回到输出缓冲量级。
 */
class ChunkReader {
  private chunks: Buffer[] = []
  /** 队首 chunk 的已消费偏移 */
  private offset = 0
  /** 队列中可读总字节 */
  private avail = 0
  private bytesRead = 0
  private readonly iterator: AsyncIterator<Buffer>
  private readonly totalBytes: number
  private readonly onBytes?: (bytesRead: number, totalBytes: number) => void

  constructor(
    stream: Readable,
    totalBytes: number,
    onBytes?: (bytesRead: number, totalBytes: number) => void
  ) {
    this.totalBytes = totalBytes
    this.onBytes = onBytes
    this.iterator = (stream as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  }

  /** 当前可读字节数 */
  get available(): number {
    return this.avail
  }

  /** 拉一个 chunk 入队（EOF 视为文件被截断 —— 像素数据不可能"正好够"） */
  private async pull(): Promise<void> {
    const next = await this.iterator.next()
    if (next.done) {
      throw new HdrDecodeError('HDR 文件在读取过程中结束（可能已损坏或被截断）')
    }
    const chunk = next.value
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.avail += chunk.length
    this.bytesRead += chunk.length
    this.onBytes?.(this.bytesRead, this.totalBytes)
  }

  async ensure(n: number): Promise<void> {
    while (this.avail < n) await this.pull()
  }

  peek(index = 0): number {
    const head = this.chunks[0]
    if (head && this.offset + index < head.length) return head[this.offset + index] ?? 0
    let remain = this.offset + index
    for (const chunk of this.chunks) {
      if (remain < chunk.length) return chunk[remain] ?? 0
      remain -= chunk.length
    }
    return 0
  }

  consume(n: number): void {
    let left = n
    while (left > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const take = Math.min(head.length - this.offset, left)
      this.offset += take
      left -= take
      this.avail -= take
      if (this.offset >= head.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
  }

  /**
   * 取 n 字节视图。同 chunk 内 → 零拷贝 subarray；
   * 跨 chunk → 拷贝到新缓冲（调用方要立刻用掉，不能跨 `consume` 持有）。
   */
  bytes(n: number): Buffer {
    const head = this.chunks[0]
    if (head && head.length - this.offset >= n) {
      return head.subarray(this.offset, this.offset + n)
    }
    const out = Buffer.allocUnsafe(n)
    let written = 0
    let chunkIndex = 0
    let chunkOffset = this.offset
    while (written < n && chunkIndex < this.chunks.length) {
      const chunk = this.chunks[chunkIndex]!
      const take = Math.min(chunk.length - chunkOffset, n - written)
      chunk.copy(out, written, chunkOffset, chunkOffset + take)
      written += take
      chunkIndex++
      chunkOffset = 0
    }
    return out
  }

  /** 队列中（相对当前游标）第一个 `\n` 的位置；没有返回 -1 */
  private indexOfNewline(): number {
    let base = 0
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!
      const start = i === 0 ? this.offset : 0
      const found = chunk.indexOf(0x0a, start)
      if (found >= 0) return base + (found - start)
      base += chunk.length - start
    }
    return -1
  }

  /** 读一行（latin1；头部是 ASCII；去掉 `\r`） */
  async readLine(): Promise<string> {
    for (;;) {
      const idx = this.indexOfNewline()
      if (idx >= 0) {
        const raw = this.bytes(idx).toString('latin1')
        this.consume(idx + 1)
        return raw.endsWith('\r') ? raw.slice(0, -1) : raw
      }
      if (this.avail > MAX_HEADER_LINE) {
        throw new HdrDecodeError('HDR 头部行过长，文件可能不是 RADIANCE 格式')
      }
      await this.pull()
    }
  }
}

// ── 头部解析 ──────────────────────────────────────────────────────────

interface HdrHeader {
  programType: string
  /** 已确认是 `32-bit_rle_rgbe` */
  format: string
  width: number
  height: number
}

const DIRECTION_RE = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/

/**
 * 读 RADIANCE 头。
 *
 * 顺序：magic 行 → 若干 `KEY=VALUE` / 注释行 → 空行 → 方向行。
 * 部分导出器会省略空行，因此这里对"方向行直接跟在头部后面"也兼容；
 * 但**朝向不对一定报错**（只认 `-Y H +X W`）。
 */
async function readHdrHeader(reader: ChunkReader): Promise<HdrHeader> {
  const magic = await reader.readLine()
  const magicMatch = /^#\?(\S+)/.exec(magic)
  if (!magicMatch) {
    throw new HdrDecodeError('不是 RADIANCE HDR 文件（缺少 #?RADIANCE / #?RGBE 起始行）')
  }
  const programType = magicMatch[1] ?? 'RGBE'

  let format = ''
  let directionLine = ''
  for (let i = 0; i < 256; i++) {
    const line = await reader.readLine()
    if (line === '') break // 空行 = 头部结束
    if (DIRECTION_RE.test(line)) {
      directionLine = line
      break
    }
    if (line.startsWith('#')) continue // 注释
    const formatMatch = /^\s*FORMAT\s*=\s*(\S+)\s*$/.exec(line)
    // GAMMA / EXPOSURE / 厂商自定义键一律忽略：本模块只做降采样，不做色彩换算
    if (formatMatch) format = formatMatch[1] ?? ''
  }

  if (format === '') {
    throw new HdrDecodeError('HDR 头部缺少 FORMAT 字段，无法确定像素格式')
  }
  if (format !== '32-bit_rle_rgbe') {
    throw new HdrDecodeError(`不支持的 HDR 像素格式：${format}（预览只支持 32-bit_rle_rgbe）`)
  }

  if (directionLine === '') directionLine = await reader.readLine()
  const dim = DIRECTION_RE.exec(directionLine)
  if (!dim) {
    const shown = directionLine.trim() === '' ? '(空)' : directionLine.trim()
    throw new HdrDecodeError(`不支持的 HDR 朝向：${shown}（预览只支持标准朝向 -Y H +X W）`)
  }
  const height = Number.parseInt(dim[1] ?? '0', 10)
  const width = Number.parseInt(dim[2] ?? '0', 10)
  if (!(width > 0) || !(height > 0)) {
    throw new HdrDecodeError(`HDR 尺寸非法：${width} × ${height}`)
  }
  return { programType, format, width, height }
}

// ── 扫描线解码 ────────────────────────────────────────────────────────

/**
 * 判定整幅图的扫描线编码（只看第一条扫描线，与 three `HDRLoader` 一致）。
 *
 * three 的判定：`w < 8 || w > 0x7fff || 2 !== b0 || 2 !== b1 || (b2 & 0x80)` → 整幅按
 * 裸 RGBE 处理。这里在其之上多认一档**老式 RLE**（`1 1 1 count`），因为 rgbec 老文件
 * 仍在流通，而 three 会把它们当裸数据读成花屏。
 */
async function detectScanMode(reader: ChunkReader, width: number): Promise<ScanMode> {
  await reader.ensure(4)
  const b0 = reader.peek(0)
  const b1 = reader.peek(1)
  const b2 = reader.peek(2)
  const b3 = reader.peek(3)
  if (width >= 8 && width <= 0x7fff && b0 === 2 && b1 === 2 && (b2 & 0x80) === 0) {
    if (((b2 << 8) | b3) !== width) {
      throw new HdrDecodeError('HDR 扫描线宽度与头部尺寸不一致（文件可能已损坏）')
    }
    return 'rle'
  }
  if (b0 === 1 && b1 === 1 && b2 === 1) return 'old'
  return 'flat'
}

/**
 * 解一条扫描线到 `out`（`width * 4` 字节，**RGBE 交错**）。
 *
 * ⚠️ 新式 RLE 的四个通道是**平面排列**（R 全行 → G 全行 → B 全行 → E 全行），
 * 解完必须再交错成 RGBE —— 直接把平面缓冲当交错用，颜色会整幅错位（指数落到红通道上）。
 * 这是本模块唯一"看起来能跑、颜色全错"的坑，`plane` 就是给这条路径用的暂存。
 */
async function readScanline(
  reader: ChunkReader,
  width: number,
  out: Uint8Array,
  mode: ScanMode,
  plane: Uint8Array
): Promise<void> {
  const total = width * 4

  if (mode === 'flat') {
    await reader.ensure(total)
    out.set(reader.bytes(total))
    reader.consume(total)
    return
  }

  await reader.ensure(4)
  const b0 = reader.peek(0)
  const b1 = reader.peek(1)
  const b2 = reader.peek(2)
  const b3 = reader.peek(3)

  if (mode === 'rle') {
    if (b0 !== 2 || b1 !== 2 || ((b2 << 8) | b3) !== width) {
      throw new HdrDecodeError('HDR 扫描线头非法（不是 2 2 <width>），文件可能已损坏')
    }
    reader.consume(4)
    // 四个通道分别 RLE：R 全行 → G 全行 → B 全行 → E 全行
    let ptr = 0
    while (ptr < total) {
      await reader.ensure(1)
      let count = reader.peek(0)
      reader.consume(1)
      const encodedRun = count > 128
      if (encodedRun) count -= 128
      if (count === 0 || ptr + count > total) {
        throw new HdrDecodeError('HDR 扫描线数据非法（RLE 计数越界）')
      }
      if (encodedRun) {
        await reader.ensure(1)
        const value = reader.peek(0)
        reader.consume(1)
        plane.fill(value, ptr, ptr + count)
        ptr += count
      } else {
        await reader.ensure(count)
        plane.set(reader.bytes(count), ptr)
        reader.consume(count)
        ptr += count
      }
    }
    // 平面 → 交错
    for (let i = 0; i < width; i++) {
      const o = i * 4
      out[o] = plane[i] ?? 0
      out[o + 1] = plane[i + width] ?? 0
      out[o + 2] = plane[i + width * 2] ?? 0
      out[o + 3] = plane[i + width * 3] ?? 0
    }
    return
  }

  // ── 老式 RLE：`1 1 1 count` + 一个 RGBE 像素，重复 count 次 ──────────
  if (b0 !== 1 || b1 !== 1 || b2 !== 1) {
    throw new HdrDecodeError('HDR 老式 RLE 扫描线头非法，文件可能已损坏')
  }
  reader.consume(4)
  let runLeft = b3
  let written = 0
  while (written < width) {
    if (runLeft > 0) {
      await reader.ensure(4)
      const r = reader.peek(0)
      const g = reader.peek(1)
      const b = reader.peek(2)
      const e = reader.peek(3)
      const n = Math.min(runLeft, width - written)
      for (let k = 0; k < n; k++) {
        const o = (written + k) * 4
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
        out[o + 3] = e
      }
      written += n
      reader.consume(4)
      runLeft = 0
      continue
    }
    await reader.ensure(4)
    const h0 = reader.peek(0)
    const h1 = reader.peek(1)
    const h2 = reader.peek(2)
    const h3 = reader.peek(3)
    reader.consume(4)
    if (h0 === 1 && h1 === 1 && h2 === 1) {
      runLeft = h3
      continue
    }
    const o = written * 4
    out[o] = h0
    out[o + 1] = h1
    out[o + 2] = h2
    out[o + 3] = h3
    written++
  }
}

// ── 浮点 → RGBE（编码回写用） ─────────────────────────────────────────

/**
 * 一个浮点 RGB 像素 → RGBE 四字节（经典 rgbe.c 的 `float2rgbe` 口径）。
 *
 * `frexp(v) = m * 2^e`（0.5 ≤ m < 1）⇒ `multiplier = m*256/v = 256/2^e`，
 * 于是 `e = floor(log2(v)) + 1`、`byte = clamp(round(c * 256 / 2^e), 0, 255)`。
 */
export function encodeRgbePixel(
  r: number,
  g: number,
  b: number,
  out: Uint8Array,
  offset: number
): void {
  const v = Math.max(r, g, b)
  if (!(v > 1e-32)) {
    out[offset] = 0
    out[offset + 1] = 0
    out[offset + 2] = 0
    out[offset + 3] = 0
    return
  }
  const e = Math.floor(Math.log2(v)) + 1
  const scale = 256 / Math.pow(2, e)
  out[offset] = Math.min(255, Math.round(r * scale))
  out[offset + 1] = Math.min(255, Math.round(g * scale))
  out[offset + 2] = Math.min(255, Math.round(b * scale))
  out[offset + 3] = Math.max(0, Math.min(255, e + 128))
}

// ── 主解码入口 ────────────────────────────────────────────────────────

function abortError(): HdrDecodeError {
  return new HdrDecodeError('HDR 预览准备已取消')
}

/**
 * 流式解码 RADIANCE HDR 并按**盒式平均**降采样到 `targetWidth`。
 *
 * 输出高度按源宽高比换算并取偶数（16:8 的图正好 2:1）；源图比目标还窄时**不放大**
 * （宽度取源宽，避免插值糊化）。
 *
 * @param filePath 源 .hdr 绝对路径（**只读**，绝不修改源文件）
 * @param opts     目标宽度 / 进度回调 / 中断信号
 */
export async function decodeHdrDownsampled(
  filePath: string,
  opts: HdrDecodeOptions
): Promise<HdrDecodeResult> {
  const signal = opts.signal
  if (signal?.aborted) throw abortError()

  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new HdrDecodeError('不是一个文件')
  const totalBytes = stat.size

  const requested = Number.isFinite(opts.targetWidth) ? Math.floor(opts.targetWidth) : 2048
  const targetWidth = requested > 0 ? requested : 2048

  // 进度：按已读字节 / 总字节；只前进不后退，且过滤 < 0.1% 的抖动（IPC 别被刷爆）
  let lastRatio = -1
  const emit = (ratio: number, force = false): void => {
    const cb = opts.onProgress
    if (!cb) return
    const clamped = Math.max(0, Math.min(1, ratio))
    if (!force && clamped <= lastRatio + 0.001) return
    if (clamped < lastRatio) return
    lastRatio = clamped
    cb(clamped)
  }

  const stream = createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES })
  const onAbort = (): void => {
    // destroy 会让挂起的 iterator.next() 抛错 → 解码立即退出（见下面 try/catch）
    stream.destroy(abortError())
  }
  signal?.addEventListener('abort', onAbort)

  const reader = new ChunkReader(stream, totalBytes, (read, total) => {
    if (total > 0) emit(read / total)
  })

  try {
    const header = await readHdrHeader(reader)
    const srcW = header.width
    const srcH = header.height

    // ── 目标几何 ─────────────────────────────────────────────────────
    const scale = Math.min(1, targetWidth / srcW)
    const outW = Math.max(1, Math.round(srcW * scale))
    let outH = Math.max(1, Math.round(srcH * (outW / srcW)))
    if (outH > 2 && outH % 2 !== 0) outH -= 1 // 偶数高（2:1 的图正好 1/2）
    outH = Math.max(1, outH)
    if (outW * outH > MAX_OUTPUT_PIXELS) {
      throw new HdrDecodeError(
        `目标尺寸过大：${outW} × ${outH}（上限 ${MAX_OUTPUT_PIXELS} 像素）`
      )
    }

    // ── 列/行映射与每格样本数（非整数倍率也成立：按 floor 划分盒边界） ──
    const colMap = new Uint32Array(srcW)
    const countsX = new Uint32Array(outW)
    for (let x = 0; x < srcW; x++) {
      const i = Math.min(outW - 1, Math.floor((x * outW) / srcW))
      colMap[x] = i
      countsX[i] = (countsX[i] ?? 0) + 1
    }
    const countsY = new Uint32Array(outH)
    for (let y = 0; y < srcH; y++) {
      const j = Math.min(outH - 1, Math.floor((y * outH) / srcH))
      countsY[j] = (countsY[j] ?? 0) + 1
    }

    const out = Buffer.alloc(outW * outH * 4)
    const acc = new Float64Array(outW * 3)
    const scan = new Uint8Array(srcW * 4)
    const plane = new Uint8Array(srcW * 4)

    const mode = await detectScanMode(reader, srcW)

    /** 一行输出落定：÷ 样本数 → 浮点均值 → RGBE 写进 out */
    const flushRow = (row: number): void => {
      // `|| 1` 而不是 `?? 1`：样本数 0 会让除法变成 Infinity/NaN，写出整行垃圾
      // （正常情况下不会发生——不放大 + floor 划分保证每行每列至少 1 个样本）
      const rowSamples = countsY[row] || 1
      let o = row * outW * 4
      for (let i = 0; i < outW; i++) {
        const n = (countsX[i] || 1) * rowSamples
        encodeRgbePixel(acc[i * 3] / n, acc[i * 3 + 1] / n, acc[i * 3 + 2] / n, out, o)
        o += 4
      }
      acc.fill(0)
    }

    let currentRow = -1
    for (let y = 0; y < srcH; y++) {
      if (signal?.aborted) throw abortError()
      await readScanline(reader, srcW, scan, mode, plane)

      const j = Math.min(outH - 1, Math.floor((y * outH) / srcH))
      if (j !== currentRow) {
        if (currentRow >= 0) flushRow(currentRow)
        currentRow = j
      }

      // 浮点空间加权：f = 2^(e-136)；指数为 0 的像素值恒为 0，直接跳过省算力
      // （但样本数照算 —— countsX/countsY 与像素值无关）
      let o = 0
      for (let x = 0; x < srcW; x++, o += 4) {
        const e = scan[o + 3] ?? 0
        if (e === 0) continue
        const f = EXP2[e] ?? 0
        const target = (colMap[x] ?? 0) * 3
        acc[target] = (acc[target] ?? 0) + (scan[o] ?? 0) * f
        acc[target + 1] = (acc[target + 1] ?? 0) + (scan[o + 1] ?? 0) * f
        acc[target + 2] = (acc[target + 2] ?? 0) + (scan[o + 2] ?? 0) * f
      }
    }
    if (currentRow >= 0) flushRow(currentRow)

    emit(1, true)
    return { width: outW, height: outH, rgbe: out }
  } catch (err) {
    // destroy 时抛出的是我们自己塞进去的 abort 错误：统一成可读文案
    if (signal?.aborted) throw abortError()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!stream.destroyed) stream.destroy()
  }
}

// ── 落盘产物（标准 RGBE 文件） ────────────────────────────────────────

/**
 * 标准 RADIANCE 文件头 + 方向行。
 *
 * 产物用**纯 flat 扫描线**（不写 RLE）：three 的 `HDRLoader` 在首扫描线不是
 * `2 2 <w>` 时按裸 RGBE 整幅读（`RGBE_ReadPixels_RLE` 的早退分支），因此 flat
 * 文件天然可读；而写 RLE 只是省磁盘（这里是 4K 级缓存，省不了多少），却多一份
 * 编码器要维护。
 */
export function hdrHeaderText(width: number, height: number): string {
  return (
    '#?RADIANCE\n' +
    '# Preview generated by ID BOX (downsampled RGBE, flat scanlines)\n' +
    'FORMAT=32-bit_rle_rgbe\n' +
    '\n' +
    `-Y ${height} +X ${width}\n`
  )
}

/** 把 `{width,height,rgbe}` 组装成可被 HDRLoader 直接读取的文件字节 */
export function encodeHdrFile(width: number, height: number, rgbe: Buffer): Buffer {
  return Buffer.concat([Buffer.from(hdrHeaderText(width, height), 'latin1'), rgbe])
}

/**
 * 只读文件头拿尺寸（≤512 字节）。用于：① 缓存命中的宽高；② 预览标题里的源分辨率。
 * 解析失败返回 null（调用方降级，不 throw）。
 */
export async function readHdrSize(
  filePath: string
): Promise<{ width: number; height: number } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const text = buf.toString('latin1', 0, bytesRead)
    const m = /-Y\s+(\d+)\s+\+X\s+(\d+)/.exec(text)
    if (!m) return null
    const height = Number.parseInt(m[1] ?? '0', 10)
    const width = Number.parseInt(m[2] ?? '0', 10)
    if (!(width > 0) || !(height > 0)) return null
    return { width, height }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

// ── 缓存 + 一键准备（主进程 IPC 的实现体） ────────────────────────────

export interface HdrPrepareOptions {
  /** 源 .hdr 绝对路径 */
  filePath: string
  /** 缓存目录（`<userData>/hdr-cache`） */
  cacheDir: string
  targetWidth?: number
  onProgress?: (ratio: number) => void
  signal?: AbortSignal
}

export interface HdrPrepareOutcome {
  cachedPath: string
  width: number
  height: number
  fromCache: boolean
  /** 源图分辨率（仅用于标题展示；读头失败为 null） */
  sourceWidth: number | null
  sourceHeight: number | null
}

/**
 * 缓存键 = `sha1(源绝对路径 + 文件 size + mtimeMs + targetWidth)`。
 *
 * 带上 size/mtime 的理由：用户可能用同名文件覆盖源图（重新下载），
 * 只按路径做键会命中旧缓存，看到的是上一张图。
 */
export function hdrCacheKey(
  sourcePath: string,
  size: number,
  mtimeMs: number,
  targetWidth: number
): string {
  return createHash('sha1')
    .update(`${path.resolve(sourcePath)}|${size}|${Math.round(mtimeMs)}|${targetWidth}`, 'utf8')
    .digest('hex')
}

/**
 * 「点预览」到「渲染进程拿到可读 URL」之间的全部主进程工作：
 * 命中缓存直接返回；未命中则流式解码 → 写临时文件 → 原子 rename。
 *
 * 写入永远是"临时文件 + rename"：中断/崩溃不会留下一个半截 `.hdr`
 * 被下次当成缓存命中（那会让预览永久黑屏且查不出原因）。
 */
export async function prepareHdrFile(opts: HdrPrepareOptions): Promise<HdrPrepareOutcome> {
  const abs = path.resolve(opts.filePath)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw new HdrDecodeError('不是一个文件')
  const targetWidth = normalizeTargetWidth(opts.targetWidth)
  const key = hdrCacheKey(abs, stat.size, stat.mtimeMs, targetWidth)
  const cachedPath = path.join(opts.cacheDir, `${key}.hdr`)

  const sourceSize = await readHdrSize(abs)

  const cachedStat = await fs.stat(cachedPath).catch(() => null)
  if (cachedStat && cachedStat.size > 0) {
    const cachedSize = await readHdrSize(cachedPath)
    if (cachedSize) {
      return {
        cachedPath,
        width: cachedSize.width,
        height: cachedSize.height,
        fromCache: true,
        sourceWidth: sourceSize?.width ?? null,
        sourceHeight: sourceSize?.height ?? null
      }
    }
    // 头部读不出来 = 坏缓存：删掉重算（比让用户手动清缓存靠谱）
    await fs.rm(cachedPath, { force: true }).catch(() => {})
  }

  await fs.mkdir(opts.cacheDir, { recursive: true })
  const decoded = await decodeHdrDownsampled(abs, {
    targetWidth,
    onProgress: opts.onProgress,
    signal: opts.signal
  })

  const tmpPath = path.join(
    opts.cacheDir,
    `${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  )
  try {
    await fs.writeFile(tmpPath, encodeHdrFile(decoded.width, decoded.height, decoded.rgbe))
    await fs.rename(tmpPath, cachedPath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  return {
    cachedPath,
    width: decoded.width,
    height: decoded.height,
    fromCache: false,
    sourceWidth: sourceSize?.width ?? null,
    sourceHeight: sourceSize?.height ?? null
  }
}
