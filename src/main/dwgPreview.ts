/**
 * DWG 内嵌缩略图提取（CAD 封面来源 M2，2026-10）。
 *
 * **实测结论（`docs/probe/cad-probe.md` §1，178 个真实 DWG，零反例）**：
 * ```
 * 0x0D 处 u32       = image seeker（指向缩略图记录起点，178/178 一次没指错）
 * seek + 0..16      = 哨兵 `1F 25 6D 07 D4 36 28 28 9D 57 CA 3F 9D 44 10 2B`
 *                     ⚠️ **不是** `CF 7B 1F 66 …`（那颗是 DC50/AC1018+ 的另一路写法，
 *                     178 个样本里一次没出现过）
 * seek + 16, u32    = size；`size <= 99` ⇒ 文件里没有图（39 个样本全是 90）
 * seek + 20, u8     = startat（R2000 实测 = 2，不是字节长度）
 * seek + 21, u8     = codes（实测 = 1）
 * seek + 119        = 图像数据起点（139 个有图样本，**全部**是 119）
 * 图像字节数        = size - 99（139/139 精确闭合）
 * END 哨兵          = seek + 20 + size
 * ```
 * 两种图格式：**裸 DIB**（`BITMAPINFOHEADER`，头 4 字节 `28 00 00 00`，无 `BM`
 * 文件头）与 **PNG**（AC1032/R2018 全用 PNG）。
 *
 * **分辨率很小**（主流 224×140、最小 184×78）—— 只能当"这是什么图"的占位封面，
 * 当不了图纸预览；要看清图纸得走真渲染（本批不做）。
 *
 * 两条硬纪律：
 * ① **绝不读整个文件**（178 个文件全量扫描 29ms，最大需求 114,623 B）：
 *    头部 32B → seeker 附近 256B → 只读图像那一段，三段定长读；
 * ② **一律转成 PNG 落盘**（与既有缩略图管线、透明背景纪律对齐），
 *    DIB 不做调色板外挂、不落 `.bmp`：BMP 不在 `IMAGE_FILE_EXTS` 里，
 *    落成 bmp 意味着 rescan 后 `pickCover` / `imageSizeOf` 都认不出它。
 *
 * **纯 IO 层、零 electron 依赖**（与 `skpPreview.ts` 同风格）：DIB → RGBA 与
 * PNG 编码都是本文件内的纯函数，vitest 可以直接用真实 DWG 的字节跑，
 * 不需要起 Electron、也不需要 mock `nativeImage`。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import type { FileHandle } from 'node:fs/promises'
import { sanitizeName } from '../shared/naming'

/** DWG 版本号长度：`AC1015` / `AC1032` …（探针里先验它，不是 DWG 直接放弃） */
const DWG_VERSION_LEN = 6

/** 版本号格式：`AC10\d\d`（R13–R2018 全覆盖；不认识的版本仍然按同一结构尝试） */
const DWG_VERSION_RE = /^AC10\d\d$/

/** image seeker 的固定位置（实测就是 0x0D，不是 0x0B/0x0C/0x0E） */
export const DWG_SEEKER_OFFSET = 0x0d

/**
 * 缩略图记录起始哨兵（16 字节）。
 * R13–R2000 用这一颗；`CF 7B 1F 66 …` 是 LibreDWG 里的**另一路**写法，
 * 178 个真实样本里零命中，别拿它当判据（探针 §1.1 的反面教材）。
 */
export const DWG_THUMBNAIL_BEGIN = Buffer.from('1f256d07d43628289d57ca3f9d44102b', 'hex')

/**
 * 缩略图记录结束哨兵（16 字节，位于 `seek + 20 + size`）。
 * 本实现里只用于文档与自校验公式，不作为判据（size 已经足够定边界）。
 */
export const DWG_THUMBNAIL_END = Buffer.from('e0da92f82bc9d7d762a835c062bbefd4', 'hex')

/** 图像数据起点相对哨兵起点的偏移（139/139 实测恒定） */
export const DWG_IMAGE_OFFSET = 119

/**
 * "有没有图"的阈值：`size <= 99` ⇒ 没有图（39 个无图样本 size 恒为 90 = 20 头 + 70 填充）。
 * 判据用 `size > 99` 而不是 `size > 0`：90 这类小值会把 `size - 99` 算成负数。
 */
export const DWG_EMPTY_SIZE = 99

/** 头部最小长度（0x0D + 4 字节 seeker = 17，取 32 与探针一致） */
const HEADER_MIN_BYTES = 32

/** seeker 附近一次读多少字节（哨兵 16 + size 4 + startat 1 + codes 1 = 22，留足余量） */
const SEEKER_WINDOW_BYTES = 256

/** 像素数量上限（防畸形文件把内存打爆；真实样本最大 512×215） */
const MAX_PIXELS = 4096 * 4096

/** 单边上限 */
const MAX_SIDE = 8192

/** PNG 编码里用的分块类型（CRC 覆盖 类型 + 数据，与签名/长度无关） */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 提取结果：**已经是可直接落盘的 PNG**（调用方不必再管原始格式） */
export interface DwgThumbnail {
  /** 完整 PNG 字节（含 IEND） */
  png: Buffer
  width: number
  height: number
  /** 原始格式（日志/测试用；落盘一律 png） */
  format: 'png' | 'dib'
  /** DIB 的位深（PNG 源没有这个概念，为 0） */
  bitCount: number
}

// ── PNG 编码（零依赖、只用 node:zlib） ──────────────────────────────────

/** CRC32 查表（PNG 每个 chunk 末尾要它，标准多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 拼一个 PNG chunk：`len(4,BE) + type(4) + data + crc(4)` */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * RGBA 像素 → PNG（8 位 / 颜色类型 6 / 无需交错）。
 *
 * 行过滤**全部用 0（None）**：图很小（224×140 级别），`zlib` 的压缩率已经够，
 * 换来的是编码器 10 行、绝不可能出花色。带 alpha 通道是刻意的
 * （与缩略图管线口径一致；DIB 本身不透明，alpha 一律 255）。
 */
export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** 解出的位图（RGBA，行序已翻正，逐像素 4 字节） */
export interface RgbaBitmap {
  width: number
  height: number
  rgba: Buffer
}

/** DIB 的 `BITMAPINFOHEADER` 固定长度（`biSize` 的正常值） */
const DIB_HEADER_BYTES = 40

/** BI_RGB（唯一支持的压缩方式；BI_BITFIELDS=3 的掩码/通道顺序另说，直接放弃） */
const BI_RGB = 0

/**
 * 裸 `BITMAPINFOHEADER`（DIB，**没有** `BM` 文件头）→ RGBA。
 *
 * 支持的位深：**8（调色板）/ 24 / 32**。
 * - 1 / 4 位调色板：不做（真实样本 0 例，实现成本不值）；
 * - 16 / 32 位 BI_BITFIELDS：掩码顺序不确定，放弃（宁缺勿错）。
 *
 * ⚠️ **8 位是主战场，不是边角**：178 个样本里 119 个 DIB **全是 8 位调色板**
 * （探针 §1.6 的直方图整列 `/8bpp`）。只认 24/32 的话命中率是 0 —— 这一条与
 * "只用 24/32"的初版口径相反，按实测数据改的口径。
 *
 * 三条容易翻车的细节：
 * ① **行尾补齐**：每行字节数 = `floor((w*bpp+31)/32)*4`，不是 `w*bpp/8`；
 *    184×8bpp 刚好等于 184（4 的倍数），换个宽度就会错位成斜纹；
 * ② **行序**：`biHeight > 0` = bottom-up（DIB 默认），要**倒着读**；
 *    `biHeight < 0` = top-down，正着读。高度一律取绝对值；
 * ③ **24 位补 alpha**：DIB 没有 alpha 通道（第 4 字节不存在），一律补 **255**；
 *    32 位的 alpha 字节在 BI_RGB 下常被写成全 0（老 CAD 导出习惯），
 *    **全 0 时视为不透明**补 255 —— 否则整张图会透明成空白封面。
 */
export function decodeDibToRgba(dib: Buffer): RgbaBitmap | null {
  if (dib.length < DIB_HEADER_BYTES) return null
  const headerSize = dib.readUInt32LE(0)
  // 正常是 40；108/124 的新头也接受（尺寸与位深在同样偏移），异常值直接放弃
  if (headerSize < DIB_HEADER_BYTES || headerSize > dib.length) return null

  const width = dib.readInt32LE(4)
  const heightRaw = dib.readInt32LE(8)
  const planes = dib.readUInt16LE(12)
  const bitCount = dib.readUInt16LE(14)
  const compression = dib.readUInt32LE(16)
  const clrUsed = dib.readUInt32LE(32)

  if (planes !== 1) return null
  if (width <= 0 || width > MAX_SIDE) return null
  const height = Math.abs(heightRaw)
  if (height <= 0 || height > MAX_SIDE) return null
  if (width * height > MAX_PIXELS) return null
  if (compression !== BI_RGB) return null
  if (bitCount !== 8 && bitCount !== 24 && bitCount !== 32) return null

  // 调色板：8 位默认 256 项（`biClrUsed` 为 0 表示"用满 2^bpp"），每项 BGRA 4 字节
  const paletteEntries = bitCount === 8 ? (clrUsed === 0 ? 256 : clrUsed) : 0
  if (bitCount === 8 && (paletteEntries < 1 || paletteEntries > 256)) return null
  const paletteOffset = headerSize
  const pixelOffset = paletteOffset + paletteEntries * 4
  const rowStride = Math.floor((width * bitCount + 31) / 32) * 4

  // 截断判定：像素数据必须完整（钳位读只是不该发生，发生了就是坏文件）
  if (pixelOffset + rowStride * height > dib.length) return null

  const rgba = Buffer.alloc(width * height * 4)
  const bottomUp = heightRaw > 0
  // 32 位 alpha 全 0 时按不透明处理（先扫一遍，避免整图透明）
  let alphaAllZero = false
  if (bitCount === 32) {
    let anyAlpha = false
    for (let y = 0; y < height && !anyAlpha; y += 1) {
      const row = pixelOffset + y * rowStride
      for (let x = 0; x < width; x += 1) {
        if (dib[row + x * 4 + 3] !== 0) {
          anyAlpha = true
          break
        }
      }
    }
    alphaAllZero = !anyAlpha
  }

  for (let y = 0; y < height; y += 1) {
    const srcRow = pixelOffset + (bottomUp ? height - 1 - y : y) * rowStride
    const dstRow = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const d = dstRow + x * 4
      if (bitCount === 8) {
        const idx = dib[srcRow + x]
        if (idx >= paletteEntries) return null // 索引越界 = 调色板项数声明错了
        const p = paletteOffset + idx * 4
        rgba[d] = dib[p + 2]
        rgba[d + 1] = dib[p + 1]
        rgba[d + 2] = dib[p]
        rgba[d + 3] = 255 // 调色板第 4 字节是保留位（实测非 0），不可当 alpha
      } else if (bitCount === 24) {
        const s = srcRow + x * 3
        rgba[d] = dib[s + 2]
        rgba[d + 1] = dib[s + 1]
        rgba[d + 2] = dib[s]
        rgba[d + 3] = 255 // DIB 24 位没有 alpha 通道
      } else {
        const s = srcRow + x * 4
        rgba[d] = dib[s + 2]
        rgba[d + 1] = dib[s + 1]
        rgba[d + 2] = dib[s]
        rgba[d + 3] = alphaAllZero ? 255 : dib[s + 3]
      }
    }
  }
  return { width, height, rgba }
}

/**
 * 按图头嗅探那段"图像字节"，统一产出 PNG。
 *
 * - `89 50 4E 47` → PNG：**直接写字节**（不重编码；AC1032 全是这条路）。
 *   按 chunk 结构走到 IEND 截断，尾部多出来的填充字节丢掉。
 * - `28 00 00 00` → DIB：解成 RGBA 再编码成 PNG（8 位调色板 / 24 / 32 位）。
 * - 其它 → null（哨兵对但图头不认识：保守放弃，走占位图标）。
 */
export function decodeDwgImageBytes(bytes: Buffer): DwgThumbnail | null {
  if (bytes.length < 8) return null

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return slicePng(bytes)
  }

  if (bytes[0] === 0x28 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    const bitmap = decodeDibToRgba(bytes)
    if (!bitmap) return null
    return {
      png: encodePngRgba(bitmap.width, bitmap.height, bitmap.rgba),
      width: bitmap.width,
      height: bitmap.height,
      format: 'dib',
      bitCount: bytes.readUInt16LE(14)
    }
  }

  return null
}

/**
 * 校验 PNG 结构并截到 IEND 结尾（`bytes` 来自 `size - 99`，尾部可能带填充）。
 * 结构不合法（块长越界 / 类型非 4 字母 / 走不到 IEND）→ null。
 */
function slicePng(bytes: Buffer): DwgThumbnail | null {
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIG)) return null
  if (bytes.readUInt32BE(8) !== 13) return null
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) return null

  let i = 8
  while (i + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(i)
    const type = bytes.toString('latin1', i + 4, i + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    const chunkEnd = i + 12 + len
    if (chunkEnd > bytes.length) return null
    if (type === 'IEND') {
      return { png: bytes.subarray(0, chunkEnd), width, height, format: 'png', bitCount: 0 }
    }
    i = chunkEnd
  }
  return null
}

// ── IO：三段定点读（绝不 readFile 整个 DWG） ─────────────────────────────

/** 从已打开的文件句柄定点读 `[pos, pos+len)`；越界时按实际可读长度返回 */
async function readRange(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return buf.subarray(0, bytesRead)
}

/**
 * 从一个 DWG 文件提取内嵌缩略图（PNG 字节 + 尺寸）；没有/读失败 → null（**绝不抛**）。
 *
 * IO 预算：32 字节头 + 至多 256 字节的 seeker 窗口 + 图像本身
 * （178 个真实样本最大 114,623 字节，且全部落在文件前 115KB）。
 */
export async function extractDwgPreview(dwgAbs: string): Promise<DwgThumbnail | null> {
  let fh: FileHandle | null = null
  try {
    const st = await fs.stat(dwgAbs)
    if (!st.isFile() || st.size < HEADER_MIN_BYTES) return null
    const fileSize = Number(st.size)

    fh = await fs.open(dwgAbs, 'r')
    const header = await readRange(fh, 0, HEADER_MIN_BYTES)
    if (header.length < HEADER_MIN_BYTES) return null
    // 不是 DWG（版本号不是 AC10xx）→ 直接放弃，省掉后续两次读
    if (!DWG_VERSION_RE.test(header.toString('latin1', 0, DWG_VERSION_LEN))) return null

    const seek = header.readUInt32LE(DWG_SEEKER_OFFSET)
    if (seek <= 0 || seek + DWG_THUMBNAIL_BEGIN.length > fileSize) return null

    const region = await readRange(fh, seek, Math.min(SEEKER_WINDOW_BYTES, fileSize - seek))
    if (region.length < 22) return null
    if (!region.subarray(0, DWG_THUMBNAIL_BEGIN.length).equals(DWG_THUMBNAIL_BEGIN)) return null

    const size = region.readUInt32LE(16)
    // 没有图（绝大多数"没图"的走这条，读完 288 字节就结束）
    if (size <= DWG_EMPTY_SIZE) return null

    const imageLen = size - DWG_EMPTY_SIZE
    const imageOffset = seek + DWG_IMAGE_OFFSET
    // 越界 = 坏文件（声明比文件还长）：绝不越界读
    if (imageOffset + imageLen > fileSize) return null

    const bytes = await readRange(fh, imageOffset, imageLen)
    if (bytes.length < imageLen) return null
    return decodeDwgImageBytes(bytes)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 提取内嵌缩略图并**写入资产文件夹**，返回相对资产文件夹的 rel 路径（posix）；
 * 没有内嵌图 / 写盘失败返回 null（绝不抛）。
 *
 * 命名与落点**与 `writeSkpPreviewInto` 同一条规则**：`<主名>.preview.png`，
 * 落在资产文件夹根部。理由（那边已写透，这里只记结论）：
 * ① 封面统一走 `vault://asset/<relFolder>/<cover>`，cover 必须是库内文件；
 * ② rescan 用 `walkFiles` 重建 files，预览图必须在 files 里才不会被 rescan 弄丢；
 * ③ 命中 `PREVIEW_NAME_RE` 的 preview 词，rescan 时 `pickCover` 能稳定选回它。
 *
 * 扩展名**恒为 `.png`**：DIB 已在内存里转好 PNG，落盘不再有 bmp 分支。
 */
export async function writeDwgPreviewInto(
  dwgAbs: string,
  targetDir: string,
  dwgRel: string
): Promise<string | null> {
  try {
    const found = await extractDwgPreview(dwgAbs)
    if (!found) return null
    const dwgBase = path.basename(dwgRel, path.extname(dwgRel))
    const fileName = `${sanitizeName(dwgBase) || 'preview'}.preview.png`
    await fs.writeFile(path.join(targetDir, fileName), found.png)
    return fileName
  } catch {
    return null
  }
}
