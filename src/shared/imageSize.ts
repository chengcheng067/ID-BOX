/**
 * 图片宽高**文件头解析**（0.6.0「贴图分辨率筛选」的采集端，纯函数、可单测）。
 *
 * 设计口径（docs/22 §3.1）：
 * - **只解析文件头**，绝不解码整图（大库重扫时逐张解码会直接卡死主进程）；
 * - `imageSizeOf` 按魔数依次探测 **PNG → JPEG → WEBP → TIFF**，认得出就返回；
 *   其余格式（bmp / tga / gif …）一律返回 `null`。
 *   「未知就是未知」：调用方据此把该资产排除在 2K / 4K 档之外，
 *   而不是按扩展名猜一个体积估值（猜错会让筛选结果不可信）。
 *   **每种探测都先验魔数再解析**，魔数不匹配就当没这个格式、继续往下探（绝不猜）。
 * - WEBP / TIFF 是 2026-10 补的（此前 webp / tif / tiff 在 `IMAGE_FILE_EXTS` 里可导入，
 *   但尺寸永远探测不出 → 它们的「按分辨率筛选」恒为假，与 0.7.x 修过的
 *   「材质/HDR 分辨率失效」是同一类缺陷，只是格式没覆盖）。
 * - HDR / EXR 走**另一个**入口 `hdrSizeOf`（2026-10「HDR 分辨率筛选」新增）。
 *   它们没并进 `imageSizeOf` / `IMAGE_FILE_EXTS`：那张白名单同时是材质球的兜底取图表，
 *   收进 `exr` 会让 `Displacement.exr` 被当 albedo 贴到球上（见 `shared/hdrExts.ts` 头注）。
 *
 * 放在 `shared/` 的原因：主进程（importer / rescan / probeSizes）负责读字节，
 * 渲染层与单测也需要同一份语义；这里不 import 任何 node/electron API。
 */

import { isHdrExt } from './hdrExts'

/** 读文件头时建议截取的字节数（JPEG 的 SOF 段几乎总在 64KB 内） */
export const IMAGE_SIZE_HEAD_BYTES = 65_536

/**
 * **升级档**读头字节数（1MB）：只给"小头解析失败且确实是 JPEG"的极少数文件用。
 *
 * 为什么需要：实测用户库里有一张图的 `SOF0` 落在 **678557 字节**处（前面是一大段
 * APP2 / ICC 配置），64KB 永远解析不到 → 该文件 `w/h` 永久为空 → 2K/4K 筛选对它永久为假。
 *
 * 为什么不能把主常量直接提到 1MB：9500 个文件 × 1MB = 10GB 读放大（现在只读 600MB）。
 * 所以读头是**先 64KB、失败且是 jpeg 才升一次**（见 `main/probeSizes.readHeadForSize`），
 * 每个文件最多升级一次，不再往上试探 2MB / 4MB。
 *
 * PNG / hdr / exr **不用**这一档：它们的尺寸在固定偏移或首个属性里，64KB 足够。
 */
export const IMAGE_SIZE_HEAD_BYTES_LARGE = 1_048_576

/** 图片宽高（像素，均为正整数） */
export interface ImageSize {
  w: number
  h: number
}

/**
 * 尺寸回填通道（`IPC.probeSizes`）的返回项：`rel` 相对调用方给的资产文件夹。
 * `rel` 原样回传（调用方按它落位），不是绝对路径。
 */
export interface ProbedImageSize extends ImageSize {
  rel: string
}

/** PNG 固定 8 字节签名 */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

/** 大端读 16 位 */
function u16be(buf: Uint8Array, at: number): number {
  return (buf[at] << 8) | buf[at + 1]
}

/** 大端读 32 位（无符号；PNG 宽高不会超过 2^31，用 `>>> 0` 归一） */
function u32be(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0
}

/**
 * PNG：`89 50 4E 47 0D 0A 1A 0A` + 第一个块必须是 IHDR
 * （块头 8 字节：4 字节长度 + `IHDR`），其后紧跟 `width(4) height(4)`，大端。
 * 即宽高位于字节 **16..24**。
 */
function pngSize(buf: Uint8Array): ImageSize | null {
  // 24 = 8 签名 + 8 块头 + 4 宽 + 4 高
  if (buf.length < 24) return null
  if (!startsWith(buf, PNG_SIGNATURE)) return null
  // 第一个块必须是 IHDR（个别工具会插 CgBI 之类的私有块，那种一律视为未知）
  const isIhdr =
    buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52 // 'IHDR'
  if (!isIhdr) return null
  const w = u32be(buf, 16)
  const h = u32be(buf, 20)
  if (w === 0 || h === 0) return null
  return { w, h }
}

/**
 * JPEG：`FF D8` 之后按段遍历，跳过 APPn / DQT / DHT / COM 等载荷，
 * 命中 SOF0/SOF1/SOF2（以及其它 SOFn）时读 `[len][precision][height][width]`。
 *
 * 注意：EXIF 缩略图藏在 APP1 的载荷里，这里按**段长度跳过**整段，
 * 绝不会把缩略图的 SOF 当成主图（那会把尺寸判错一个数量级）。
 */
function jpegSize(buf: Uint8Array): ImageSize | null {
  if (buf.length < 4) return null
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null

  let i = 2
  while (i + 1 < buf.length) {
    // 段起始标记；段间允许填充字节，所以逐字节找 0xFF 而不是硬跳
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    let p = i + 1
    while (p < buf.length && buf[p] === 0xff) p += 1
    if (p >= buf.length) return null
    const marker = buf[p]

    // 无载荷标记：TEM(01) / RSTn(D0-D7) / SOI(D8) —— 直接跳过
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = p + 1
      continue
    }
    // EOI 或 SOS 之前还没见到 SOF → 没有可用的尺寸信息
    if (marker === 0xd9 || marker === 0xda) return null

    // 其余标记都带 2 字节长度（含自身），长度非法即视为坏文件
    if (p + 2 >= buf.length) return null
    const len = u16be(buf, p + 1)
    if (len < 2) return null

    // SOFn：C0-CF 去掉 C4(DHT) / C8(JPG 保留) / CC(DAC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      // 载荷：precision(p+3) height(p+4..5) width(p+6..7)
      if (p + 7 >= buf.length) return null
      const h = u16be(buf, p + 4)
      const w = u16be(buf, p + 6)
      if (w === 0 || h === 0) return null
      return { w, h }
    }

    // 跳到下一个段（p 是标记字节，p+1 起是长度字段）
    i = p + 1 + len
  }
  return null
}

/** 小端读 16 位 */
function u16le(buf: Uint8Array, at: number): number {
  return buf[at] | (buf[at + 1] << 8)
}

/** 小端读 24 位（WEBP VP8X 的画布宽高各 3 字节） */
function u24le(buf: Uint8Array, at: number): number {
  return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16)
}

/** 小端读 32 位（无符号） */
function u32le(buf: Uint8Array, at: number): number {
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0
}

/** WEBP 的 RIFF 容器头：`RIFF` + size(4, 不变) + `WEBP` = 12 字节，其后是第一个子块 */
const WEBP_RIFF = 'RIFF'
const WEBP_FORM = 'WEBP'

/** VP8（有损）帧头里固定的关键帧起始码 */
const VP8_START_CODE: readonly number[] = [0x9d, 0x01, 0x2a]

/** VP8L（无损）载荷首字节的签名 */
const VP8L_SIGNATURE = 0x2f

/**
 * WEBP —— RIFF 容器 + 三种编码子块（**三种都要覆盖**，只做一种是最常见的坑）。
 *
 * 容器结构（全部小端）：
 * ```
 * 0..3   'RIFF'      4..7  文件长度-8
 * 8..11  'WEBP'     12..15 子块 FourCC   16..19 子块长度（含 1 字节填充对齐）
 * 20..   子块载荷
 * ```
 *
 * - `VP8 `（有损）：载荷 = 3 字节帧标签 + `9d 01 2a` 起始码 + 14 位宽 + 14 位高（各取低 14 位）；
 * - `VP8L`（无损）：载荷首字节 `0x2f`，其后 32 位小端里装 **宽-1（14 位）+ 高-1（14 位）**——
 *   两个都要 +1，忘了 +1 会让整库的 1K/2K 判定差 1 像素、4K 恰好落档外；
 * - `VP8X`（扩展，可带 alpha / 动画 / ICC）：载荷 1 字节 flags + 3 字节保留 +
 *   24 位宽-1 + 24 位高-1（同样都要 +1）。
 *
 * 其余子块（`ALPH` / `ANIM` / `ICCP` …）不是画布描述，直接判未知 ——
 * 扩展格式的画布尺寸一律以 `VP8X` 为准，绝不去拼 `ALPH` + `VP8 ` 的尺寸（会漏掉偏移）。
 */
function webpSize(buf: Uint8Array): ImageSize | null {
  // 20 = 8 RIFF 头 + 4 'WEBP' + 8 子块头（子块载荷从 20 开始）
  if (buf.length < 20) return null
  if (latin1(buf, 0, 4) !== WEBP_RIFF) return null
  if (latin1(buf, 8, 12) !== WEBP_FORM) return null

  const fourcc = latin1(buf, 12, 16)
  // 子块声明长度（用于判"头部是否够本子块用"，不足即视为被截断）
  const chunkSize = u32le(buf, 16)
  const payload = 20
  if (chunkSize < 4) return null // 任何合法子块都不少于 4 字节

  if (fourcc === 'VP8 ') {
    // 载荷 = 3 字节帧标签 + 3 字节起始码 + 4 字节宽高 = 最少 10 字节
    if (chunkSize < 10) return null
    if (buf.length < payload + 10) return null
    // 载荷 = 3 字节帧标签，紧接 3 字节固定起始码
    const sig = payload + 3
    if (buf[sig] !== VP8_START_CODE[0] || buf[sig + 1] !== VP8_START_CODE[1] || buf[sig + 2] !== VP8_START_CODE[2]) {
      return null
    }
    const w = u16le(buf, sig + 3) & 0x3fff
    const h = u16le(buf, sig + 5) & 0x3fff
    if (w === 0 || h === 0) return null
    return { w, h }
  }

  if (fourcc === 'VP8L') {
    // 载荷 = 1 字节签名 + 4 字节位域 = 最少 5 字节
    if (chunkSize < 5) return null
    if (buf.length < payload + 5) return null
    if (buf[payload] !== VP8L_SIGNATURE) return null
    const bits = u32le(buf, payload + 1)
    const w = (bits & 0x3fff) + 1
    const h = ((bits >>> 14) & 0x3fff) + 1
    if (w === 0 || h === 0) return null
    return { w, h }
  }

  if (fourcc === 'VP8X') {
    // 载荷 = 1 flags + 3 保留 + 3 宽 + 3 高 = 最少 10 字节
    if (chunkSize < 10) return null
    if (buf.length < payload + 10) return null
    const w = u24le(buf, payload + 4) + 1
    const h = u24le(buf, payload + 7) + 1
    if (w === 0 || h === 0) return null
    return { w, h }
  }

  return null
}

/** TIFF 字节序标记：`II` = 小端（Intel），`MM` = 大端（Motorola） */
const TIFF_LE = 'II'
const TIFF_BE = 'MM'

/** TIFF 版本魔数（BigTIFF 的 43 不支持 —— 那是另一套 IFD 结构，不猜） */
const TIFF_MAGIC = 42

/** TIFF 字段类型：3 = SHORT（2 字节），4 = LONG（4 字节） */
const TIFF_TYPE_SHORT = 3
const TIFF_TYPE_LONG = 4

/** IFD entry 的固定长度 */
const TIFF_ENTRY_SIZE = 12

/**
 * TIFF / TIF —— 读 IFD0 里的 `ImageWidth(0x0100)` 与 `ImageLength(0x0101)`。
 *
 * 结构：
 * ```
 * 0..1   'II' | 'MM'     2..3  42（按上面的字节序）
 * 4..7   IFD0 偏移（按字节序）   8..  IFD0: 2 字节 entry 数 + N × 12 字节 entry
 * entry: tag(2) type(2) count(4) value|offset(4)
 * ```
 * SHORT 且 count=1 时，值放在 value 字段的**前 2 字节**（不是后 2 字节，大端也一样）。
 *
 * 越界一律 `null`：IFD 偏移越界 / entry 越过缓冲区 / 宽高缺失 / 值为 0。
 * `w/h` 缺失时不回落到 `StripOffsets` 之类的间接信息 —— 那是猜。
 */
function tiffSize(buf: Uint8Array): ImageSize | null {
  if (buf.length < 8) return null
  const order = latin1(buf, 0, 2)
  if (order !== TIFF_LE && order !== TIFF_BE) return null
  const le = order === TIFF_LE
  const magic = le ? u16le(buf, 2) : u16be(buf, 2)
  if (magic !== TIFF_MAGIC) return null

  const ifd = le ? u32le(buf, 4) : u32be(buf, 4)
  // IFD 至少要有 2 字节 entry 数
  if (ifd < 8 || ifd + 2 > buf.length) return null

  const count = le ? u16le(buf, ifd) : u16be(buf, ifd)
  if (count === 0) return null
  const first = ifd + 2
  // 整张 entry 表必须在缓冲区里（截断的头部 → 不知道有没有宽高 → 未知）
  if (first + count * TIFF_ENTRY_SIZE > buf.length) return null

  let w: number | null = null
  let h: number | null = null
  for (let i = 0; i < count; i += 1) {
    const at = first + i * TIFF_ENTRY_SIZE
    const tag = le ? u16le(buf, at) : u16be(buf, at)
    if (tag !== 0x0100 && tag !== 0x0101) continue
    const type = le ? u16le(buf, at + 2) : u16be(buf, at + 2)
    const valueAt = at + 8
    let value: number | null = null
    if (type === TIFF_TYPE_SHORT) {
      // SHORT 的值占 value 字段的前 2 字节（两种字节序都是"值在高位端"）
      value = le ? u16le(buf, valueAt) : u16be(buf, valueAt)
    } else if (type === TIFF_TYPE_LONG) {
      value = le ? u32le(buf, valueAt) : u32be(buf, valueAt)
    }
    if (value === null) continue
    if (tag === 0x0100) w = value
    else h = value
  }

  if (w === null || h === null) return null
  if (!(w > 0) || !(h > 0)) return null
  return { w, h }
}

/**
 * 从文件头字节里解析图片宽高。
 *
 * @param buf 文件**开头**的字节（建议 `IMAGE_SIZE_HEAD_BYTES`，少给也能解析小图）
 * @returns `{w,h}`；非 PNG/JPEG/WEBP/TIFF、头部不完整、尺寸为 0 或格式损坏 → `null`
 */
export function imageSizeOf(buf: Uint8Array): ImageSize | null {
  if (!(buf instanceof Uint8Array) || buf.length < 4) return null
  const png = pngSize(buf)
  if (png) return png
  const jpeg = jpegSize(buf)
  if (jpeg) return jpeg
  const webp = webpSize(buf)
  if (webp) return webp
  return tiffSize(buf)
}

// ── HDR / EXR（2026-10「分辨率筛选在材质与 HDR 都失效」的补采端） ──────────

/** Radiance 允许的两种魔法行前缀（`#?RGBE` 是少数旧工具的输出） */
const RADIANCE_MAGICS: readonly string[] = ['#?RADIANCE', '#?RGBE']

/** OpenEXR 魔数 `76 2f 31 01`（小端写死的 20000630） */
const EXR_MAGIC: readonly number[] = [0x76, 0x2f, 0x31, 0x01]

/**
 * 按 latin1（字节 -> 同码位字符）解码一段字节。
 * 头部的注释 / 属性名都是 ASCII，latin1 就够了；不用 TextDecoder 是为了保持零依赖。
 */
function latin1(buf: Uint8Array, start: number, end: number): string {
  const stop = Math.min(end, buf.length)
  let out = ''
  for (let i = start; i < stop; i += 1) out += String.fromCharCode(buf[i])
  return out
}

/**
 * 读一行（`\n` 分隔，容忍行尾 `\r`）。
 * @returns 行文本与下一行起点；缓冲区里没有换行符（= 行被截断）→ `null`
 */
function readLine(buf: Uint8Array, from: number): { text: string; next: number } | null {
  if (from >= buf.length) return null
  const nl = buf.indexOf(0x0a, from)
  if (nl < 0) return null
  const end = nl > from && buf[nl - 1] === 0x0d ? nl - 1 : nl
  return { text: latin1(buf, from, end), next: nl + 1 }
}

/** Radiance 分辨率行：`-Y 8192 +X 16384`（两个轴的**顺序与符号都不保证**） */
const RADIANCE_RES_RE = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/

function parseRadianceResolution(text: string): ImageSize | null {
  const m = RADIANCE_RES_RE.exec(text.trim())
  if (!m) return null
  const axis1 = m[2]
  const axis2 = m[5]
  // 两个轴必须一个是 X、一个是 Y（`-Y 10 -Y 20` 这种坏头直接判废）
  if (axis1 === axis2) return null
  const v1 = Number.parseInt(m[3], 10)
  const v2 = Number.parseInt(m[6], 10)
  if (!Number.isSafeInteger(v1) || !Number.isSafeInteger(v2)) return null
  const w = axis1 === 'X' ? v1 : v2
  const h = axis1 === 'Y' ? v1 : v2
  if (!(w > 0) || !(h > 0)) return null
  return { w, h }
}

/**
 * Radiance `.hdr`（RGBE）：魔法行 → 若干 `KEY=VALUE` 注释 → **空行** → 分辨率行。
 * 分辨率行的符号只表示扫描方向（`-Y` = 自上而下、`-X` = 从右到左），宽高取绝对值。
 * 只读文本头，像素数据一个字节都不碰。
 */
function radianceSize(buf: Uint8Array): ImageSize | null {
  const first = readLine(buf, 0)
  if (!first) return null
  if (!RADIANCE_MAGICS.some((magic) => first.text.startsWith(magic))) return null

  // 跳到第一个空行（头部结束标志）
  let pos = first.next
  for (;;) {
    const line = readLine(buf, pos)
    if (!line) return null
    pos = line.next
    if (line.text.length === 0) break
  }
  // 空行之后的第一条非空行就是分辨率行
  for (;;) {
    const line = readLine(buf, pos)
    if (!line) return null
    pos = line.next
    if (line.text.length > 0) return parseRadianceResolution(line.text)
  }
}

/** 小端读 32 位有符号（EXR 全小端；`box2i` 的坐标可以是负数） */
function i32le(buf: Uint8Array, at: number): number {
  return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)
}

/** 读一个 NUL 结尾的字符串；没找到终止符（= 被截断）→ `null` */
function readCString(buf: Uint8Array, at: number): { text: string; next: number } | null {
  if (at >= buf.length) return null
  const end = buf.indexOf(0x00, at)
  if (end < 0) return null
  return { text: latin1(buf, at, end), next: end + 1 }
}

/**
 * OpenEXR `.exr`：魔数 + version(4B) 之后是**属性列表**，
 * 每项 = `name\0` + `type\0` + `size(int32 LE)` + value(size 字节)，空 name 结束。
 *
 * 属性**顺序任意**、前面可能塞着任意多别的属性，所以只能逐项按 `size` 跳过，
 * 绝不能假设 `dataWindow` 在固定偏移。`dataWindow`（`box2i`，16 字节）给的是
 * `xMin, yMin, xMax, yMax`，宽高 = max - min + 1。
 *
 * 头部缓冲区只有 64KB：任何一处越界（属性名无终止符 / size 越过缓冲区结尾 /
 * 数字非法）都返回 `null` —— **绝不抛异常**，未知就是未知。
 */
function exrSize(buf: Uint8Array): ImageSize | null {
  if (buf.length < 8) return null
  if (!startsWith(buf, EXR_MAGIC)) return null

  let pos = 8 // 魔数 4 + version 4
  for (;;) {
    const name = readCString(buf, pos)
    if (!name) return null
    pos = name.next
    if (name.text.length === 0) return null // 属性列表结束仍未见到 dataWindow

    const type = readCString(buf, pos)
    if (!type) return null
    pos = type.next

    if (pos + 4 > buf.length) return null
    const size = i32le(buf, pos)
    pos += 4
    if (size < 0 || pos + size > buf.length) return null

    if (name.text === 'dataWindow') {
      if (type.text !== 'box2i' || size !== 16) return null
      const w = i32le(buf, pos + 8) - i32le(buf, pos) + 1
      const h = i32le(buf, pos + 12) - i32le(buf, pos + 4) + 1
      if (!(w > 0) || !(h > 0)) return null
      return { w, h }
    }

    pos += size
  }
}

/**
 * 解析 HDR / EXR 文件的宽高（**纯函数、零 IO、不解码像素**）。
 *
 * @param head 文件**开头**的字节（建议 `IMAGE_SIZE_HEAD_BYTES`）
 * @returns `{w,h}`；非 Radiance/OpenEXR、头部不完整、尺寸非法 → `null`
 */
export function hdrSizeOf(head: Uint8Array): ImageSize | null {
  if (!(head instanceof Uint8Array) || head.length < 4) return null
  const radiance = radianceSize(head)
  if (radiance) return radiance
  return exrSize(head)
}

/**
 * 按扩展名选解析器：`hdr` / `exr` → `hdrSizeOf`，其余 → `imageSizeOf`。
 *
 * 两个调用方共用（`main/importer.fillImageSizes` 与 `main/probeSizes`），
 * 免得"导入时能读、回填时读不到"这种口径漂移。
 *
 * @param ext 扩展名（可带前导点、大小写不限）
 */
export function imageSizeOfExt(ext: string, head: Uint8Array): ImageSize | null {
  return isHdrExt(ext) ? hdrSizeOf(head) : imageSizeOf(head)
}
