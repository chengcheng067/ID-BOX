/**
 * 乱码嗅探（纯函数，零依赖，P0-2 / K1）
 *
 * 背景：ZIP 不强制编码，知末网 / WinRAR 打的包多为 GBK 文件名。
 * 7-Zip 与 adm-zip 默认按 UTF-8 解 → 产生 U+FFFD（替代符）或拉丁扩展垃圾串 →
 * `.skp` / `.max` 的相对贴图引用断裂 → 模型变白模，且不可逆。
 *
 * 两条判据：
 * ① 含 U+FFFD（UTF-8 解 GBK 字节的典型产物）—— 最强信号
 * ② 高比例"可疑字符"（拉丁扩展 / 上下标 / 引号类符号）
 *    —— 要求 **≥2 连缀** 或 **整串 ≥3 个**，避免误伤 `Café` 这类合法外文名（R8）
 */

export const MOJIBAKE_RATIO_THRESHOLD = 0.2

/** U+FFFD 替代符 */
export const REPLACEMENT_CHAR = '\uFFFD'

/** 单个名字里可疑字符数达到该值即判为乱码 */
export const MOJIBAKE_SUSPECT_MIN_CHARS = 3

/**
 * 可疑字符集。两块，第二块是 2026-10-29 真机实测补的（DEF-01 兜底链从未触发的根因）：
 *
 * ① 拉丁扩展 + 上下标/度数/版权 + 音标 + 弯引号/省略号/千分比 + 欧元/商标
 *    （UTF-8 字节被当单字节编码解出的经典产物，如 `Ã©tÃ©`）；
 * ② **PUA `U+E000–U+F8FF`** —— 7-Zip 遇到「Unix 制作的 zip（中央目录 madeBy os=3）
 *    + 无 UTF-8 flag」时按 UTF-8 解 GBK 字节失败，把解不出的字节写进私用区（实测真包
 *    `生态主题餐厅…ID_1152305168.zip` 解出 `U+EFB2 U+EFCD U+EFCC …`）。
 *    正常文件名里**不可能**出现私用区字符，加它零误报。
 *
 * ⚠️ **不要**把 `U+FF01–U+FF5E`（全角 ASCII / 全角标点）加进来：`（修订版）：平面图.dwg`、
 * `Ａ号立面.png` 这类中文名极常见，加进去会让**每个正常包都被重解两遍**。
 * ⚠️ 也不要加希腊/西里尔/希伯来/阿拉伯区：俄语等真实文件名会被误判；
 * 这一批乱码里出现的零散西里尔/希腊字符（U+037C / U+0461 …）只是 PUA 主旋律的伴生，
 * 靠 ② 就足以命中整串（可疑字符 ≥3 或 ≥2 连缀）。
 *
 * 口径：**只收有真实样本支撑的区间**。区间每加一段，正常包被误判重解的概率就多一分。
 */
const SUSPECT_CLASS =
  '\\u00A0-\\u00BF\\u00C0-\\u024F\\u02B0-\\u02FF\\u2018\\u2019\\u201A\\u201C\\u201D\\u201E\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122' +
  '\\uE000-\\uF8FF'

const CONSECUTIVE_SUSPECT_RE = new RegExp(`[${SUSPECT_CLASS}]{2,}`)
const SUSPECT_COUNT_RE = new RegExp(`[${SUSPECT_CLASS}]`, 'g')

/** 名字中是否含 U+FFFD 替代符 */
export function hasReplacementChar(s: string): boolean {
  return typeof s === 'string' && s.includes(REPLACEMENT_CHAR)
}

/** 单个名字是否疑似乱码（不误伤 `Café Munir.skp` 这类单重音外文名） */
export function isMojibakeSuspect(s: string): boolean {
  if (!s) return false
  if (hasReplacementChar(s)) return true
  if (CONSECUTIVE_SUSPECT_RE.test(s)) return true
  const matched = s.match(SUSPECT_COUNT_RE)
  return (matched?.length ?? 0) >= MOJIBAKE_SUSPECT_MIN_CHARS
}

export interface NameScan {
  total: number
  suspicious: number
  ratio: number
  /** 任一名字含 U+FFFD */
  hasReplacement: boolean
  /** 最多 5 条样本，供日志与 UI 提示 */
  samples: string[]
}

/** 扫描一批名字（通常是解压后全部文件的相对路径） */
export function scanNames(names: string[], opts?: { ratioThreshold?: number; maxSamples?: number }): NameScan {
  const maxSamples = opts?.maxSamples ?? 5
  const samples: string[] = []
  let suspicious = 0
  let hasReplacement = false
  for (const n of names) {
    if (hasReplacementChar(n)) hasReplacement = true
    if (isMojibakeSuspect(n)) {
      suspicious++
      if (samples.length < maxSamples) samples.push(n)
    }
  }
  const total = names.length
  return {
    total,
    suspicious,
    ratio: total === 0 ? 0 : suspicious / total,
    hasReplacement,
    samples
  }
}

/** 一次扫描是否判定为"整包疑似乱码"：有 U+FFFD，或可疑比例达到阈值 */
export function isScanMojibake(scan: NameScan, opts?: { ratioThreshold?: number }): boolean {
  const threshold = opts?.ratioThreshold ?? MOJIBAKE_RATIO_THRESHOLD
  return scan.hasReplacement || scan.ratio >= threshold
}
