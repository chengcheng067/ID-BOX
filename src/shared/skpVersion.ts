/**
 * SketchUp 版本解析（纯函数，零 IO，P0-15 / N1）
 *
 * `.skp` 文件头：magic `FF FE FF 0E`，其后是 UTF-16LE 文本，形如
 * `SketchUp Model {24.0.594}`（部分版本无花括号，故做双保险）。
 * 只读前 128 字节，解析失败静默返回 null —— 不弹错、不阻断导入。
 */

export interface SkpVersionInfo {
  major: number
  minor: number
  build: number
  raw: string
  label: string
}

/** 读取文件头的最小字节数（P0-15 约定读 128 字节） */
export const SKP_HEAD_BYTES = 128

/** magic：FF FE FF 0E */
const MAGIC: readonly number[] = [0xff, 0xfe, 0xff, 0x0e]

/** 带花括号：`{24.0.594}` / `{17.1}` */
const BRACED_RE = /\{(\d+)\.(\d+)(?:\.(\d+))?\}/
/** 无花括号兜底（需同时命中 SketchUp 字样才采信） */
const PLAIN_RE = /(\d{1,2})\.(\d{1,2})(?:\.(\d{1,5}))?/
const SKP_MARK_RE = /sketchup/i

/**
 * major → 展示标签：major ≥ 17 → `SU ${2000+major}`（17→2017 … 24→2024）；
 * major ≤ 16 → `SU ${major}`（SU 8 / 13 / 15 / 16 旧版）
 */
export function suLabel(major: number): string {
  if (!Number.isFinite(major) || major <= 0) return 'SU ?'
  return major >= 17 ? `SU ${2000 + major}` : `SU ${major}`
}

/** 解析 .skp 头部；失败返回 null（静默降级） */
export function parseSkpVersion(head: Uint8Array | ArrayLike<number> | null | undefined): SkpVersionInfo | null {
  if (!head || typeof (head as Uint8Array).length !== 'number') return null
  const bytes = head instanceof Uint8Array ? head : Uint8Array.from(head as ArrayLike<number>)
  if (bytes.length < MAGIC.length + 4) return null
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null
  }
  // 跳过 FF FE（UTF-16LE BOM），从 FF 0E 之后开始是 ASCII/UTF-16LE 文本
  let text = ''
  try {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2))
  } catch {
    return null
  }
  if (!text) return null

  const braced = BRACED_RE.exec(text)
  if (braced) return buildInfo(braced[1], braced[2], braced[3], braced[0])

  // 无花括号时要求出现 SketchUp 字样，避免把随机数字当版本号
  if (SKP_MARK_RE.test(text)) {
    const plain = PLAIN_RE.exec(text)
    if (plain) return buildInfo(plain[1], plain[2], plain[3], plain[0])
  }
  return null
}

function buildInfo(major: string, minor: string, build: string | undefined, raw: string): SkpVersionInfo | null {
  const mj = Number(major)
  const mn = Number(minor ?? '0')
  const bd = Number(build ?? '0')
  if (!Number.isFinite(mj) || mj <= 0) return null
  return {
    major: mj,
    minor: Number.isFinite(mn) ? mn : 0,
    build: Number.isFinite(bd) ? bd : 0,
    raw,
    label: suLabel(mj)
  }
}
