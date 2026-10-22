/**
 * HDRI 扩展名与「全景参数」提取（0.6.5，HDR 入库 + 预览）。
 *
 * ⚠️ **不要**把 hdr/exr 加进 `shared/imageExts.ts`：
 * 那张表同时是「材质球兜底取图」的白名单（`renderer/logic/materialBall.ts`），
 * 加进去会让 `Displacement.exr` 被兜底当 albedo 贴上球 —— 球直接变灰/花。
 * 本表只服务于「单文件 HDR 直导」与「HDR 预览入口判定」两条路径。
 */

/** HDR 类扩展名（小写、不含点）。`exr` 能入库，但预览解码器只吃 RADIANCE RGBE。 */
export const HDR_EXTS: ReadonlySet<string> = new Set(['hdr', 'exr'])

/** 扩展名（可带前导点、大小写不限）是否属于 HDR 类 */
export function isHdrExt(ext: string): boolean {
  return HDR_EXTS.has(ext.toLowerCase().replace(/^\./, ''))
}

/**
 * 从文件名里提取**全景对齐参数**（写在名字里的那些数字，用户 2026-10 的样本：
 * `22.古月视觉HDR-偏移U：0.33 V：-0.01平铺：2.hdr`）。
 *
 * 这些参数是全景图在 DCC 里的对齐/平铺设定，丢了就得回原站查，所以导入时
 * 顺手抄进 `asset.note`（不结构化、不参与筛选，只是一行可读文本）。
 *
 * 支持写法（大小写不敏感；中英文冒号、空格可有可无；也认 offset / tile 英文）：
 * - `偏移U：0.33` / `偏移 U 0.33` / `offsetU: 0.33`
 * - `偏移V：-0.01` / `偏移 V：-0.01` / `offsetV: -0.01`
 * - `平铺：2` / `平铺 2` / `tile: 2`
 *
 * @returns 形如 `全景参数：偏移U 0.33 / 偏移V -0.01 / 平铺 2`；
 *          一个都没命中时返回空串（调用方此时不要让 note 变成空壳前缀）。
 */
export function panoramaNoteFromName(name: string): string {
  if (!name) return ''
  const u = matchNumber(name, /(?:偏移|offset)\s*U\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i) ??
    matchNumber(name, /(?:^|[\s,_\-])U\s*[:：]\s*(-?\d+(?:\.\d+)?)/i)
  const v = matchNumber(name, /(?:偏移|offset)\s*V\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i) ??
    matchNumber(name, /(?:^|[\s,_\-])V\s*[:：]\s*(-?\d+(?:\.\d+)?)/i)
  const tile = matchNumber(name, /(?:平铺|tile)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i)
  const parts: string[] = []
  if (u !== null) parts.push(`偏移U ${u}`)
  if (v !== null) parts.push(`偏移V ${v}`)
  if (tile !== null) parts.push(`平铺 ${tile}`)
  return parts.length === 0 ? '' : `全景参数：${parts.join(' / ')}`
}

/** 捕获组 1 转成"原样文本"（保留用户写的小数位，不做数值归一化） */
function matchNumber(text: string, re: RegExp): string | null {
  const m = re.exec(text)
  return m && typeof m[1] === 'string' ? m[1] : null
}
