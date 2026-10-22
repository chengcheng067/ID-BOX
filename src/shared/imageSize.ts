/**
 * 图片宽高**文件头解析**（0.6.0「贴图分辨率筛选」的采集端，纯函数、可单测）。
 *
 * 设计口径（docs/22 §3.1）：
 * - **只解析文件头**，绝不解码整图（大库重扫时逐张解码会直接卡死主进程）；
 * - 只认 PNG 与 JPEG —— 它们覆盖了贴图库的绝对多数，且头部格式固定；
 * - 其余格式（webp / bmp / tga / exr / gif …）一律返回 `null`。
 *   「未知就是未知」：调用方据此把该资产排除在 2K / 4K 档之外，
 *   而不是按扩展名猜一个体积估值（猜错会让筛选结果不可信）。
 *
 * 放在 `shared/` 的原因：主进程（importer / rescan）负责读字节，
 * 渲染层与单测也需要同一份语义；这里不 import 任何 node/electron API。
 */

/** 读文件头时建议截取的字节数（JPEG 的 SOF 段几乎总在 64KB 内） */
export const IMAGE_SIZE_HEAD_BYTES = 65_536

/** 图片宽高（像素，均为正整数） */
export interface ImageSize {
  w: number
  h: number
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

/**
 * 从文件头字节里解析图片宽高。
 *
 * @param buf 文件**开头**的字节（建议 `IMAGE_SIZE_HEAD_BYTES`，少给也能解析小图）
 * @returns `{w,h}`；非 PNG/JPEG、头部不完整、尺寸为 0 或格式损坏 → `null`
 */
export function imageSizeOf(buf: Uint8Array): ImageSize | null {
  if (!(buf instanceof Uint8Array) || buf.length < 4) return null
  const png = pngSize(buf)
  if (png) return png
  return jpegSize(buf)
}
