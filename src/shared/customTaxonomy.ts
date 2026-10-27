/**
 * 用户自定义分类词表（2026-10 需求）——纯逻辑，零 IO、零 electron / node 依赖。
 *
 * 两层词表里的**用户层**：预设词表（`shared/taxonomy.ts`）只读不动，
 * 自定义词条存 `Settings.customTaxonomy`（settings.json）。本文件收口三件事：
 *
 * 1. **归一化**（`normalizeCustomTaxonomy`）：读档 / 写档 / 单条新增共用；
 *    清洗规则与落盘目录段**同源**（`sanitizeCategorySegment` + `cleanSegment` 的
 *    去空白 / 掐尾 / 截断），保证「词表里的词条」与「指派后落盘的分类段」是同一个字符串。
 * 2. **合并展示**（`mergeVocab`）：预设在前、自定义在后并列展示，`custom` 标记
 *    供 UI 画「自定义」角标——可区分是硬要求（用户得认得出哪些是自己加的）。
 * 3. **删除保护**（`countCustomUsage`）：已被资产使用的自定义词条不许删。
 *
 * ⚠️ **硬约束**：自动分类（`autoClassify.ts` / 知末映射）**完全不读本文件**——
 * 自定义词条只进 UI（选择器 / 侧栏树跟随资产出现），绝不混进任何匹配函数。
 */
import type { Asset, CustomTaxonomy } from './types'
import {
  UNCLASSIFIED,
  LEVEL1_LIST,
  TEXTURE_LEVEL1_LIST,
  MATERIAL_LEVEL1_LIST,
  LEVEL2_MAP,
  MATERIAL_LEVEL2_MAP
} from './taxonomy'
import { MAX_SEGMENT_LEN, sanitizeCategorySegment } from './naming'

/** 空词表（默认值语义：与没有该功能时行为完全一致） */
export const EMPTY_CUSTOM_TAXONOMY: CustomTaxonomy = { level1: [], level2: {} }

/** 每层词条数量上限（防御 settings.json 被病态撑爆；正常使用远达不到） */
export const MAX_CUSTOM_TERMS = 200

/**
 * 单条自定义词条的**唯一清洗入口**（读档 / 写档 / UI 新增共用）。
 *
 * 与落盘管线对齐的规则（缺一条就会出现"词表里的词 ≠ 落盘的目录名"）：
 * - `\` 与 `/` → `_`（`sanitizeCategorySegment`，与 `composeRelFolder` 同函数）；
 * - 其余 Windows 非法字符 → `_`（与 `naming.cleanSegment` 的 ILLEGAL_RE 同集）；
 * - 连续空白折叠为单空格、掐掉首尾空白与尾部 `[. ]`（Windows 目录段不允许以点空格结尾）;
 * - 空串 / 哨兵「未分类」→ 丢弃（返回 ''，调用方按"没加成"处理）；
 * - 超长按**码点**截断（与 cleanSegment 同为 40，不能 slice 割开代理对）。
 */
export function sanitizeCustomTerm(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = sanitizeCategorySegment(raw)
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (!s || s === UNCLASSIFIED || /^[_\s.]+$/.test(s)) return ''
  const chars = Array.from(s)
  return chars.length > MAX_SEGMENT_LEN ? chars.slice(0, MAX_SEGMENT_LEN).join('') : s
}

/**
 * 预设一级词表的**净化形态**集合（防撞）：自定义词条与预设词条同名（含
 * 「电器/器材」vs 用户输入被净化成「电器_器材」这种形态等价）时不收，
 * 否则选择器会出现两个指同一目录的重复项。
 */
const PRESET_LEVEL1_SANITIZED: ReadonlySet<string> = new Set(
  [...LEVEL1_LIST, ...TEXTURE_LEVEL1_LIST, ...MATERIAL_LEVEL1_LIST].map(sanitizeCategorySegment)
)

/** 某一级下的预设二级词表（净化形态）。LEVEL2_MAP 与 MATERIAL_LEVEL2_MAP 并集——两个频道的二级都可能挂在同一级名下 */
function presetLevel2Sanitized(parent: string): ReadonlySet<string> {
  const raw = [...(LEVEL2_MAP[parent] ?? []), ...(MATERIAL_LEVEL2_MAP[parent] ?? [])]
  return new Set(raw.map(sanitizeCategorySegment))
}

/**
 * 自定义词表的**唯一归一化入口**（读档 / 写档 / 单条新增共用，绝不抛错）。
 *
 * 规则：非法值逐条清洗丢弃（单项降级，绝不拖垮整份设置）；层内去重；
 * 与预设词表同名（净化后等价）的丢弃；空二级组不落档；每层封顶 `MAX_CUSTOM_TERMS`。
 */
export function normalizeCustomTaxonomy(raw: unknown): CustomTaxonomy {
  const src: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  const level1: string[] = []
  const seen1 = new Set<string>()
  if (Array.isArray(src.level1)) {
    for (const item of src.level1) {
      const v = sanitizeCustomTerm(item)
      if (!v || seen1.has(v) || PRESET_LEVEL1_SANITIZED.has(v)) continue
      if (level1.length >= MAX_CUSTOM_TERMS) break
      seen1.add(v)
      level1.push(v)
    }
  }

  const level2: Record<string, string[]> = {}
  const raw2 = src.level2
  if (raw2 !== null && typeof raw2 === 'object') {
    for (const [key, list] of Object.entries(raw2 as Record<string, unknown>)) {
      const parent = sanitizeCustomTerm(key)
      if (!parent) continue
      const preset = presetLevel2Sanitized(parent)
      const items: string[] = []
      const seen = new Set<string>()
      if (Array.isArray(list)) {
        for (const item of list) {
          const v = sanitizeCustomTerm(item)
          if (!v || seen.has(v) || preset.has(v)) continue
          if (items.length >= MAX_CUSTOM_TERMS) break
          seen.add(v)
          items.push(v)
        }
      }
      if (items.length > 0) level2[parent] = items
    }
  }

  return { level1, level2 }
}

/** 自定义一级册（settings 未加载 / 缺键时返回空，调用方无需判空） */
export function customLevel1Of(tax: CustomTaxonomy | null | undefined): readonly string[] {
  return tax?.level1 ?? []
}

/** 某一级下的自定义二级册（同上） */
export function customLevel2Of(
  tax: CustomTaxonomy | null | undefined,
  parent: string
): readonly string[] {
  return tax?.level2[parent] ?? []
}

/** 合并后的选项行：`custom` 标记供选择器画「自定义」角标（预设与自定义并列且可区分） */
export interface VocabItem {
  value: string
  custom: boolean
}

/**
 * 预设在前、自定义在后并列合并；与预设重名的自定义项不重复出现
 * （归一化已拦，这里再兜一道——两份数据可能来自不同写入时机）。
 */
export function mergeVocab(
  preset: readonly string[],
  custom: readonly string[] | null | undefined
): VocabItem[] {
  const out: VocabItem[] = preset.map((value) => ({ value, custom: false }))
  if (custom && custom.length > 0) {
    const presetSet = new Set(preset)
    for (const v of custom) {
      if (presetSet.has(v)) continue
      out.push({ value: v, custom: true })
    }
  }
  return out
}

/** 删除保护的计数维度 */
export interface CustomUsageQuery {
  level: 'level1' | 'level2'
  /** `level: 'level2'` 时必填：所属一级分类名 */
  parent?: string
  name: string
}

/**
 * 某自定义词条正被多少个资产使用（**删除保护的唯一判据**）。
 *
 * 只做字符串相等比较（资产落库的 `category1/category2` 已经过与
 * `sanitizeCustomTerm` 同源的清洗），不扫磁盘——索引即真相。
 * level1 按一级名全局数；level2 按「一级 + 二级」成对数（不同一级下的同名二级互不牵连）。
 */
export function countCustomUsage(
  assets: ReadonlyArray<Pick<Asset, 'category1' | 'category2'>>,
  q: CustomUsageQuery
): number {
  const name = sanitizeCustomTerm(q.name)
  if (!name) return 0
  if (q.level === 'level1') {
    return assets.filter((a) => (a.category1 || '') === name).length
  }
  const parent = sanitizeCustomTerm(q.parent)
  if (!parent) return 0
  return assets.filter((a) => (a.category1 || '') === parent && (a.category2 || '') === name).length
}
