/**
 * SKP 内嵌预览图提取（P1-2，用户装机反馈拍板的首选缩略图方案）。
 *
 * **实测结论（2026-10，本机两个真实 .skp 样本，SU 头均为 `{8.0.1}`）**：
 * SU 二进制布局：版本头 → VersionMap 骨架（`CThumbnail` section → … →
 * `End-Of-Version-Map`）→ **`CDib` 属性段**（通用前缀 `FF FF 03 00 04 00`
 * + ASCII 名 `CDib` + flags(4) + len(4) + **图片字节**）。
 * - 样本 A（侘寂挂画，1.36MB）：CDib@1973 → 256×256 **PNG**（54836 B），
 *   视觉确认真实模型预览；
 * - 样本 B（中古侘寂屏风，108MB）：CDib@9383 → 512×512 **JPEG**（176025 B），
 *   SU 把一张木纹材质图写进了缩略图槽（该包没有可用的模型渲染预览，
 *   提取结果即 SU 自己声明的"缩略图"）。
 *
 * 策略：**CDib 锚定**优先（精准命中缩略图槽位）；找不到 CDib 时退回
 * 「头部第一个结构完整的图片」启发式；都没有 → null，封面走 `pickCover`
 * 四级回退，再不行由渲染层出 SU 图标占位。
 *
 * **纯 IO 层、零 electron 依赖**：只用 node:fs/promises + Buffer 扫描，
 * 可在 vitest 里用合成 fixture 直接单测（见 `tests/skpPreview.test.ts`）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readHead } from './fsutil'
import { sanitizeName } from '../shared/naming'

/**
 * 预览图扫描的头部窗口大小。
 * 实测样本的预览图在 2KB 偏移处、材质贴图在 9KB/188KB 处；512KB 足以覆盖
 * 头部所有图片签名，又不必为超大 .skp（上百 MB）付出全文件扫描。
 */
export const SKP_PREVIEW_HEAD_BYTES = 512 * 1024

/** PNG 签名（8 字节魔数）；终止走 IEND 块结构校验（见 pngEndOffset） */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** JPEG SOI+marker 签名（FF D8 FF）；终止走 EOI marker 段校验（见 jpegEndOffset） */
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff])

/**
 * SU 缩略图属性段签名（2026-10 两个真实样本实测）：
 * 属性段通用前缀 `FF FF 03 00 04 00` + ASCII 属性名 `CDib`。
 * 布局：VersionMap 骨架（CThumbnail → … → End-Of-Version-Map）之后，
 * `FFFF 0300 0400 "CDib" <flags:4> <len:4> <图片字节>`。
 * ⚠️ 别与材质贴图属性 `CDid`（…69 64）混为一谈——一字之差。
 */
const CDIB_ATTR = Buffer.from([0xff, 0xff, 0x03, 0x00, 0x04, 0x00, 0x43, 0x44, 0x69, 0x62])

/** CDib 属性名之后到图片签名的最大距离（实测 18 字节：flags(4) + len(4)） */
const CDIB_TO_IMAGE_MAX = 64

/** 一次签名扫描的上限（防畸形文件里成千上万次命中拖慢导入） */
const MAX_SIGNATURE_HITS = 64

export interface EmbeddedImage {
  /** 完整图片字节（含签名与终止块），可直接写盘 */
  buffer: Buffer
  /** 图片格式（落盘扩展名） */
  ext: 'png' | 'jpg'
  /** 在头部缓冲中的起始偏移（测试/日志用） */
  offset: number
}

/** 收集 buf 中某个签名的全部命中偏移（封顶 MAX_SIGNATURE_HITS） */
function findSignatureHits(buf: Buffer, sig: Buffer): number[] {
  const hits: number[] = []
  let i = 0
  while (hits.length < MAX_SIGNATURE_HITS) {
    const j = buf.indexOf(sig, i)
    if (j === -1) break
    hits.push(j)
    i = j + 1
  }
  return hits
}

/**
 * 从 PNG 签名起点按**块结构**走到 IEND，返回图片结束偏移（不含）；
 * 结构不合法（块长越界 / 块类型非 4 字母 / 走不到 IEND）返回 null。
 *
 * 为什么不能只找 IEND 签名：二进制数据里偶然的 PNG 签名会把后面**真正的**
 * IEND 吸过来，截出一段四不像。块结构校验能识别这种噪声签名。
 */
function pngEndOffset(head: Buffer, start: number): number | null {
  let i = start + PNG_SIG.length
  while (i + 8 <= head.length) {
    const len = head.readUInt32BE(i)
    const type = head.toString('latin1', i + 4, i + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    const chunkEnd = i + 8 + len + 4 // length(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > head.length) return null
    if (type === 'IEND') return chunkEnd
    i = chunkEnd
  }
  return null
}

/** JPEG 无长度段的独立 marker（TEM / RSTn） */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)
}

/**
 * 从 JPEG 签名起点按 **marker 段结构**走到 EOI（FF D9），返回结束偏移（不含）；
 * 结构不合法返回 null。SOS（FF DA）之后是熵数据，FF 都被转义（FF 00）或作
 * restart marker，直接向后找 FFD9 即是真 EOI。
 */
function jpegEndOffset(head: Buffer, start: number): number | null {
  let i = start + 2 // 跳过 SOI 的 FF D8，此时 head[i] 应是 FF
  while (i + 4 <= head.length) {
    if (head[i] !== 0xff) return null
    const marker = head[i + 1]
    if (marker === 0xd9) return i + 2 // EOI
    if (isStandaloneJpegMarker(marker)) {
      i += 2
      continue
    }
    const segLen = head.readUInt16BE(i + 2)
    if (segLen < 2) return null
    if (marker === 0xda) {
      // SOS：段头之后是熵数据，向后找真 EOI
      let j = i + 2 + segLen
      while (j + 1 < head.length) {
        if (head[j] === 0xff && head[j + 1] === 0xd9) return j + 2
        j++
      }
      return null
    }
    i += 2 + segLen
  }
  return null
}

/**
 * 在 `head` 的 `[from, to)` 窗口里找**第一个结构完整**的图片（按偏移升序，
 * PNG chunk 校验 / JPEG marker 段校验不过的命中视为噪声跳过）。
 * `from`/`to` 缺省覆盖整个缓冲。找不到返回 null。
 */
function firstCompleteImage(head: Buffer, from = 0, to: number = head.length): EmbeddedImage | null {
  const window = from === 0 && to === head.length ? head : head.subarray(from, to)
  const candidates: Array<{ offset: number; ext: 'png' | 'jpg' }> = []
  for (const rel of findSignatureHits(window, PNG_SIG)) {
    candidates.push({ offset: from + rel, ext: 'png' })
  }
  for (const rel of findSignatureHits(window, JPEG_SIG)) {
    candidates.push({ offset: from + rel, ext: 'jpg' })
  }
  candidates.sort((a, b) => a.offset - b.offset)

  for (const c of candidates) {
    const end = c.ext === 'png' ? pngEndOffset(head, c.offset) : jpegEndOffset(head, c.offset)
    if (end === null || end <= c.offset) continue // 噪声签名：结构不完整
    return {
      buffer: head.subarray(c.offset, end),
      ext: c.ext,
      offset: c.offset
    }
  }
  return null
}

/**
 * 从头部缓冲中提取内嵌预览图。
 *
 * ① **CDib 锚定**（首选，实测真实样本）：SU 把内嵌预览图放在 `CDib` 属性段里，
 *    属性名之后一小段（flags + len）就是图片字节——精准命中缩略图槽位；
 * ② **兜底**：找不到 CDib 属性段（其他 SU 版本/格式变异）→ 退回
 *    「头部第一个结构完整的图片」启发式。
 *
 * 两个都空 → null（调用方走 pickCover / SU 图标占位）。
 */
export function extractEmbeddedImage(head: Buffer): EmbeddedImage | null {
  if (!head || head.length === 0) return null

  for (const off of findSignatureHits(head, CDIB_ATTR)) {
    const from = off + CDIB_ATTR.length
    const found = firstCompleteImage(head, from, Math.min(head.length, from + CDIB_TO_IMAGE_MAX))
    if (found) return found
  }
  return firstCompleteImage(head)
}

/**
 * 读 .skp 头部并提取内嵌预览图；没有内嵌图 / 读取失败一律返回 null（绝不抛）。
 */
export async function extractSkpPreview(
  skpAbs: string,
  headBytes: number = SKP_PREVIEW_HEAD_BYTES
): Promise<EmbeddedImage | null> {
  try {
    const head = await readHead(skpAbs, headBytes)
    return extractEmbeddedImage(head)
  } catch {
    return null
  }
}

/**
 * 提取内嵌预览图并**写入资产文件夹**，返回相对资产文件夹的 rel 路径（posix）；
 * 没有内嵌图 / 写盘失败返回 null。
 *
 * 落点选资产文件夹而非 thumbs 目录的理由：
 * ① 封面统一走 `vault://asset/<relFolder>/<cover>`（详情面板读原图、网格读缩略图），
 *    cover 必须是库内文件，thumbs 目录不在 asset host 服务范围内；
 * ② 与 rescan 的视图保持一致——rescan 用 `walkFiles` 重建 files，若预览图只在
 *    thumbs 里，rescan 后 files 会多出一个 cover 指向不存在的文件；
 * ③ 用户「截图替换封面」（coverSource='manual'）时，CoverPicker 从 files 里选图，
 *    预览图在 files 中即可被再次选中。
 *
 * 文件名：`<skp 主名>.preview.<ext>`（命中 PREVIEW_NAME_RE 的 preview 词，
 * rescan 时 pickCover 会稳定选回它，封面不翻车）。
 */
export async function writeSkpPreviewInto(
  skpAbs: string,
  assetDir: string,
  skpRel: string
): Promise<string | null> {
  try {
    const found = await extractSkpPreview(skpAbs)
    if (!found) return null
    const skpBase = path.basename(skpRel, path.extname(skpRel))
    const fileName = `${sanitizeName(skpBase) || 'preview'}.preview.${found.ext}`
    await fs.writeFile(path.join(assetDir, fileName), found.buffer)
    return fileName
  } catch {
    return null
  }
}
