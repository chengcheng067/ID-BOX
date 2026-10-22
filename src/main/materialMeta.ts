/**
 * AmbientCG / Crystal 材质包元数据解析（2026-10 用户装机反馈，任务 4 问题二）。
 *
 * 样本 B（已核实）：`vh1sbjl_2K.json` 与 PBR 贴图同包发布，实测结构：
 * ```json
 * {
 *   "semanticTags": {
 *     "name": "Square Floor Tiles",
 *     "contains": ["Tiles", "Floor Tiles"],
 *     "theme": ["Interior"],
 *     "descriptive": ["Square", "Ceramic"],
 *     "color": ["White", "Beige"],
 *     "country": ["Italy"],
 *     "region": ["Europe"]
 *   }
 * }
 * ```
 *
 * 契约：
 * - 产出结构化结果 `{ name, tags, color }`（tags = contains/theme/descriptive/
 *   country/region 合并去重，保持出现顺序；color 单独出）；
 * - **解析失败一律返回 null，绝不抛错**（json 损坏 / 结构不符 / 字段类型不对
 *   都只是"这个包没有可用元数据"，不能阻断导入）；
 * - 本模块零 IO（纯解析）——读文件由调用方（importer / rescan）负责，
 *   这样解析逻辑可以在 vitest 里直接单测。
 *
 * 落库字段收敛：`Asset.materialMeta` 只存 `{ name, tags }`（shared/types.ts），
 * color 解析出来暂不入库（本期无按颜色筛选的产品需求，避免无用字段）。
 */

/** 解析成功的结果（比落库字段丰富：color 单列，供后续筛选/展示需求使用） */
export interface MaterialMetaParseResult {
  /** 正式名（semanticTags.name），缺失/为空字符串时为 undefined */
  name?: string
  /** 语义标签（contains + theme + descriptive + country + region，去重保序） */
  tags: string[]
  /** 颜色词（semanticTags.color 原样过滤） */
  color: string[]
}

/** semanticTags 里合并进 tags 的数组字段（按此顺序拼接） */
const TAG_ARRAY_KEYS = ['contains', 'theme', 'descriptive', 'country', 'region'] as const

/** 收集字符串数组：过滤非字符串、去空白、丢空值 */
function stringArrayOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const t = item.trim()
    if (t) out.push(t)
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 AmbientCG 元数据 JSON（已 JSON.parse 的值）。
 *
 * @param raw JSON.parse 的产物（任意形态，函数内部全防御）
 * @returns 结构化结果；`semanticTags` 缺失/不是对象、或三大字段全为空时返回 null
 */
export function parseMaterialMetaJson(raw: unknown): MaterialMetaParseResult | null {
  if (!isPlainObject(raw)) return null
  const st = raw['semanticTags']
  if (!isPlainObject(st)) return null

  const nameRaw = st['name']
  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : undefined

  const tags: string[] = []
  const seen = new Set<string>()
  for (const key of TAG_ARRAY_KEYS) {
    for (const t of stringArrayOf(st[key])) {
      if (seen.has(t)) continue
      seen.add(t)
      tags.push(t)
    }
  }

  const color = stringArrayOf(st['color'])

  // 名字、标签、颜色全为空 → 视为没有可用元数据
  if (!name && tags.length === 0 && color.length === 0) return null
  return { name, tags, color }
}

/**
 * 解析 AmbientCG 元数据 JSON **文本**（便捷入口，吞掉 JSON.parse 异常）。
 * 解析失败返回 null，不抛错。
 */
export function parseMaterialMetaJsonText(text: string): MaterialMetaParseResult | null {
  try {
    return parseMaterialMetaJson(JSON.parse(text))
  } catch {
    return null
  }
}
