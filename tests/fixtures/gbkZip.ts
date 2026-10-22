import zlib from 'node:zlib'
import iconv from 'iconv-lite'

/**
 * 合成 GBK 中文名 zip 的测试 fixture（K1 / R1）
 *
 * **为什么不能用 adm-zip 生成**：adm-zip 的 `addFile` 用 `Utils.decoder.encode`
 * （默认 UTF-8）并置 `efs` flag，**无法产出"GBK 字节 + 不置 UTF-8 flag"这一真实场景**，
 * 而这正是知末网 / WinRAR 打包的典型形态。手工拼装是唯一可靠路径。
 *
 * 采用 STORED（method=0），CRC32 用 `zlib.crc32`（Node 22 已实测可用）。
 */

export interface ZipEntrySpec {
  /** 文件名的原始字节（用 `gbkBytes()` / `utf8Bytes()` 生成） */
  nameBytes: Buffer
  /** 是否置 UTF-8 flag（bit 11）。知末 / WinRAR 打的包通常为 false */
  utf8Flag: boolean
  /** 文件内容；目录项传空 Buffer */
  content: Buffer
}

/** UTF-8 字符串 → GBK 字节（TextEncoder 不支持 GBK，必须 iconv-lite） */
export const gbkBytes = (s: string): Buffer => iconv.encode(s, 'gbk')

/** UTF-8 字符串 → UTF-8 字节 */
export const utf8Bytes = (s: string): Buffer => Buffer.from(s, 'utf8')

/** 便捷构造：文件名用文本指定，内部按需编码 */
export function zipEntry(
  name: string,
  content: Buffer | string = Buffer.alloc(0),
  opts?: { encoding?: 'gbk' | 'utf8'; utf8Flag?: boolean }
): ZipEntrySpec {
  const encoding = opts?.encoding ?? 'gbk'
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return {
    nameBytes: encoding === 'gbk' ? gbkBytes(name) : utf8Bytes(name),
    utf8Flag: opts?.utf8Flag ?? encoding === 'utf8',
    content: body
  }
}

/** 目录项：名字以 `/` 结尾、内容为空、externalAttr 置 0x10 */
export function zipDir(
  name: string,
  opts?: { encoding?: 'gbk' | 'utf8'; utf8Flag?: boolean }
): ZipEntrySpec {
  return zipEntry(name.endsWith('/') ? name : `${name}/`, Buffer.alloc(0), opts)
}

const DOS_DATE = 0x21 // 1980-01-01
const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** 手工拼装 ZIP：local header × N + central directory × N + EOCD */
export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const crc = zlib.crc32(e.content) >>> 0
    const flags = e.utf8Flag ? 0x0800 : 0x0000
    const name = e.nameBytes
    const isDir = name.length > 0 && name[name.length - 1] === 0x2f

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(flags, 6) // general purpose flag
    local.writeUInt16LE(0, 8) // method: STORED
    local.writeUInt16LE(0, 10) // modTime
    local.writeUInt16LE(DOS_DATE, 12) // modDate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.content.length, 18) // compressed size
    local.writeUInt32LE(e.content.length, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, name, e.content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10) // method
    central.writeUInt16LE(0, 12) // modTime
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.content.length, 20)
    central.writeUInt32LE(e.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(isDir ? 0x10 : 0x20, 38) // external attrs（0x10 = 目录）
    central.writeUInt32LE(offset, 42) // relative offset of local header
    centrals.push(central, name)

    offset += local.length + name.length + e.content.length
  }

  const cdSize = centrals.reduce((s, b) => s + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, ...centrals, eocd])
}

/** 合成一个带 SU 版本头的 .skp 内容（前 128 字节可解析出版本） */
export function skpContent(versionText = 'SketchUp Model {24.0.594}'): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
    Buffer.from(versionText, 'utf16le')
  ])
}

/** 1×1 透明 PNG（最小合法 PNG，用于合成 skp 内嵌预览图 fixture） */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 最小 JPEG（SOI + APP0 + SOF0 + SOS + 熵数据 + EOI，marker 段结构合法） */
export function tinyJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    // APP0/JFIF，段长 16（含 2 长度字节，数据 14：JFIF\0 + 版本2 + 单位1 + 密度4 + 缩略图2）
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    // SOF0 1×1，段长 11
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]),
    // SOS，段长 8
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x3f, 0x00, 0x00]),
    Buffer.from('skp-preview-jpeg-fixture', 'ascii'), // 熵数据（无 0xFF 字节）
    Buffer.from([0xff, 0xd9]) // EOI
  ])
}

/**
 * 合成带**内嵌预览图**的 .skp 内容：SU 版本头 + 填充段 + 图片字节。
 * 模拟真实样本的布局（预览图紧跟头部若干 section 之后）。
 */
export function skpContentWithPreview(
  image: Buffer,
  opts?: { versionText?: string; gapBytes?: number }
): Buffer {
  const gap = opts?.gapBytes ?? 1931 // 真实样本中预览图位于偏移 1991（头约 60B）
  return Buffer.concat([
    Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
    Buffer.from(opts?.versionText ?? 'SketchUp Model {24.0.594}', 'utf16le'),
    Buffer.alloc(gap, 0x5a), // 填充段（非图片字节）
    image
  ])
}

/**
 * SU `CDib` 属性段（缩略图槽位）字节：通用前缀 + ASCII 属性名 + flags(4) + len(4)。
 * 2026-10 真实样本实测布局；材质贴图属性名为 `CDid`（末字节 0x64），一字之差。
 */
export const SKP_CDIB_ATTR = Buffer.from([
  0xff, 0xff, 0x03, 0x00, 0x04, 0x00, 0x43, 0x44, 0x69, 0x62, // FFFF 0300 0400 "CDib"
  0x04, 0x00, 0x00, 0x00 // flags
])

/** 材质贴图 `CDid` 属性段前缀（flags=1，与 CDib 的 flags=4 不同） */
export const SKP_CDID_ATTR = Buffer.from([
  0xff, 0xff, 0x03, 0x00, 0x04, 0x00, 0x43, 0x44, 0x69, 0x64, // FFFF 0300 0400 "CDid"
  0x01, 0x00, 0x00, 0x00 // flags
])

/**
 * 合成带 **CDib 锚点**内嵌预览图的 .skp：SU 头 + VersionMap 填充 +
 * CDib 属性段（flags + len + 图片字节）。复刻真实样本 A/B 的布局。
 */
export function skpContentWithCdibPreview(image: Buffer, opts?: { versionText?: string }): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(image.length, 0)
  return Buffer.concat([
    Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
    Buffer.from(opts?.versionText ?? 'SketchUp Model {8.0.1}', 'utf16le'),
    Buffer.alloc(1900, 0x5a), // VersionMap 骨架填充
    SKP_CDIB_ATTR,
    len,
    image
  ])
}
