/**
 * 站方面包屑 → 本地 (一级, 二级) 的**解析实现**（`docs/35 §3` · T-04 / T-05）。
 *
 * 这是「分类三源交叉验证」里的 **S2 源**：详情页 `breadcrumb_data` 还原出的两级路径。
 * 它只回答一个问题 ——「站方说这条资产属于哪个本地分类」，**不判定**哪个源对
 * （判定在 `shared/classifyCrossCheck.ts` 的 `decideClassify()`，本模块不介入）。
 *
 * ── 两条完全不同的路径，为什么必须分开 ─────────────────────────────
 * | kind | 走哪条 | 为什么 |
 * |---|---|---|
 * | `cad` | `s2FromBreadcrumb()` —— **恒等优先 + 别名表** | CAD 词表是照抄站方的，站方名基本等于本地名；**不能**走 `mapZhimoCategory`，见下 |
 * | `model` / `texture` / `material` | `s2FromBreadcrumbGeneric()` —— 走 `mapZhimoCategory()` | 这三个频道本地词表是**重排过的**，站方三级轴与本地两级不是一一对应，只能查表 |
 *
 * ⚠️ **CAD 为什么不能走 `mapZhimoCategory`（实测，不是推测）**：
 * `mapZhimoCategory('办公空间', 'cad')` 返回 `[{ category1: '工装', category2: '办公空间',
 * source: 'docs/05 §5（L111）' }]` —— 它落到的是 **SU 频道的「工装」**，而 CAD 的一级是
 * **「工装空间」**。直接拿来用会造出 `CAD图纸/工装/办公空间` 这种"夹着 SU 一级"的错位目录，
 * 而且会让一个纯属映射表串台的错误变成 S1/S2 的**假 conflict**（`docs/35 §3.5`）。
 * 所以 CAD 自己解析：`CAD_LEVEL1_LIST` / `CAD_LEVEL2_MAP` 精确全等 + `cadStationAliasL1` 别名。
 *
 * ── 为什么「逐条试映射」而不是「取最深一条再映射」──────────────────
 * `1186414883` 的面包屑是 `软装陈设 > 墙饰墙绘 > 挂画`，`level` 是 `[1, 2, 2]` ——
 * **两个并列的二级**（`挂画` 的父是第 1 条 `软装陈设`，不是第 2 条 `墙饰墙绘`，
 * 见 `tests/zhimoCover.test.ts` 的 `f765s1035` 用例）。"取最深一条"在并列时会拿到
 * `墙饰墙绘`（`docs/28 §0` 明确不映射的 5 条之一）→ 整条 S2 直接丢掉；逐条试才能
 * 从 `挂画` 拿到 `软装陈设/挂画`（`docs/28` 的核准表第 47 行就是这个 ID）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────
 * 1. **零 IO、零 electron、零 Dexie**（纯函数，`environment: 'node'` 直测）；
 * 2. **不猜**：映射表给多个候选 → `null`（与 `zhimoReclass.ts:168-171` 的 `ambiguous` 同口径）；
 * 3. **不改任何词表**：`taxonomy.ts` / `zhimoTaxonomyMap.ts` 一个字不动（R-09）。
 */

import { cadStationAliasL1 } from './classifyCadStationAlias'
import {
  CAD_LEVEL1_LIST,
  CAD_LEVEL2_CANONICAL_PARENT,
  CAD_LEVEL2_MAP,
  UNCLASSIFIED,
  isLevel1AllowedForKind
} from './taxonomy'
import { isLevel1Only, mapZhimoCategory } from './zhimoTaxonomyMap'
import type { ZhimoLookupTarget } from './zhimoTaxonomyMap'

/**
 * 一条面包屑（**与 `ZhimoBreadcrumbItem` 结构兼容**，但不 import 主进程类型 ——
 * 渲染层不许 import `src/main/**`，且本模块只用到这四个字段里的一部分）。
 *
 * `href` / `level` 都可缺省：调用方可能只喂 `[{ name: '木材' }, { name: '板材' }]`
 * 这种手写数组（单测与将来的离线分析都要能这么用）。
 */
export interface StationCrumb {
  termId?: number
  /** 站方节点名（原话，未映射） */
  name: string
  /** 站方层级真值 `f{termId}` / `f{父}s{子}` / `f{祖}s{父}s{子}`；缺省时按数组顺序推 */
  href?: string
  /** 层级（1 = 一级）；缺省时由 `href` 里 `s` 的个数推导 */
  level?: number
}

/** S2 的解析结果（本地化后的两级 + 站方原文路径，供 UI 展示"站方原话"） */
export interface S2Parsed {
  /** 本地一级（已过 `isLevel1AllowedForKind` 闸门） */
  level1: string
  /** 本地二级；解析不出二级时 = `未分类`（**不是空串**） */
  level2: string
  /** 面包屑原文（按 `level` 升序），UI 展示用 */
  raw: string[]
  /**
   * 走了一级别名时给出实际映射（如 `室内空间→工装空间`）。
   * 没走别名时为 `undefined` —— UI 据此显示"站方用的是旧叫法"。
   */
  viaAlias?: string
  /** 命中「就近归并」（`ZHIMO_APPROX`）时为 `true`（照用，但必须能回溯） */
  approx?: boolean
}

// ── 公共小工具 ──────────────────────────────────────────────────────────

/** 由 `href` 推层级（`f706`→1、`f765s1035`→2）；`href` 非法 → `null` */
function levelOfHref(href: string): number | null {
  if (!/^f\d+(s\d+)*$/.test(href)) return null
  return href.split('s').length
}

/** 条目的有效层级：显式 `level` 优先，其次 `href`，最后按数组顺序（从 1 开始） */
function effectiveLevel(crumb: StationCrumb, index: number): number {
  if (typeof crumb.level === 'number' && Number.isFinite(crumb.level) && crumb.level >= 1) {
    return Math.floor(crumb.level)
  }
  const href = typeof crumb.href === 'string' ? crumb.href.trim() : ''
  if (href) {
    const fromHref = levelOfHref(href)
    if (fromHref !== null) return fromHref
  }
  return index + 1
}

/** 清洗入参：丢掉无名条目，并补上有效层级（`level` 与 `href` 矛盾时以显式 `level` 为准） */
interface ResolvedCrumb {
  name: string
  href: string
  level: number
}

function normalizeCrumbs(crumbs: readonly StationCrumb[] | null | undefined): ResolvedCrumb[] {
  if (!Array.isArray(crumbs)) return []
  const out: ResolvedCrumb[] = []
  for (let i = 0; i < crumbs.length; i += 1) {
    const crumb = crumbs[i]
    if (!crumb || typeof crumb.name !== 'string') continue
    const name = crumb.name.trim()
    if (!name) continue
    const href = typeof crumb.href === 'string' ? crumb.href.trim() : ''
    out.push({ name, href, level: effectiveLevel(crumb, i) })
  }
  return out
}

/**
 * 按 `level` **降序**稳定排序（最深的先试）。
 *
 * 同层条目保持原数组顺序 —— 这个顺序是站方给的，**不要**改（并列二级的先后
 * 决定了 1186414883 这类样本先试 `墙饰墙绘` 还是 `挂画`，见文件头注释）。
 */
function deepestFirst(crumbs: readonly ResolvedCrumb[]): ResolvedCrumb[] {
  return crumbs
    .map((crumb, index) => ({ crumb, index }))
    .sort((a, b) => (b.crumb.level - a.crumb.level) || (a.index - b.index))
    .map((item) => item.crumb)
}

/** 面包屑原文（按 `level` 升序；同层保持原序） */
function rawNames(crumbs: readonly ResolvedCrumb[]): string[] {
  return crumbs
    .map((crumb, index) => ({ crumb, index }))
    .sort((a, b) => (a.crumb.level - b.crumb.level) || (a.index - b.index))
    .map((item) => item.crumb.name)
}

// ── CAD：恒等优先 + 一级别名（T-04）────────────────────────────────────

/** `f765s1035` → `f765`；`f783`（一级）→ `null` */
function parentHrefOf(href: string): string | null {
  const at = href.lastIndexOf('s')
  return at > 0 ? href.slice(0, at) : null
}

/** 按 `href` 找父条目（**不用数组下标** —— 并列二级的父是祖先，不是前一条） */
function parentOf(child: ResolvedCrumb, crumbs: readonly ResolvedCrumb[]): ResolvedCrumb | null {
  if (!child.href) return null
  const parentHref = parentHrefOf(child.href)
  if (!parentHref) return null
  return crumbs.find((c) => c.href === parentHref) ?? null
}

/** 面包屑的根（唯一的 `level === 1` 条目）；手写数组（无 `href`）时当父级用 */
function rootOf(crumbs: readonly ResolvedCrumb[]): ResolvedCrumb | null {
  return crumbs.find((c) => c.level === 1) ?? null
}

/** 一级归一：当前一级直接采用；否则查站方旧一级别名表；都没有 → `null` */
function resolveCadLevel1(raw: string): { level1: string; viaAlias?: string } | null {
  if (CAD_LEVEL1_LIST.includes(raw)) return { level1: raw }
  const aliased = cadStationAliasL1(raw)
  return aliased === null ? null : { level1: aliased, viaAlias: `${raw}→${aliased}` }
}

/**
 * 二级名的**唯一归属一级**（用于父条目缺失的情况）。
 *
 * 规则（`docs/35 §3.1` ⚠️ 第 2 段）：重名二级优先取 `CAD_LEVEL2_CANONICAL_PARENT`
 * 的覆盖值；没有覆盖值时取 `Object.keys(CAD_LEVEL2_MAP)` 里**先出现**的那个一级
 * （= 站方筛选栏原序，不是字典序）。
 */
function parentKeyOfLevel2(level2: string): string | null {
  const owners = Object.keys(CAD_LEVEL2_MAP).filter((l1) => CAD_LEVEL2_MAP[l1]?.includes(level2))
  if (owners.length === 0) return null
  return CAD_LEVEL2_CANONICAL_PARENT[level2] ?? owners[0]!
}

/** 二级名落盘时的一级：命中覆盖表就用覆盖值，否则用所在键的一级 */
function canonicalCadLevel1(level1: string, level2: string): string {
  return CAD_LEVEL2_CANONICAL_PARENT[level2] ?? level1
}

/**
 * CAD 面包屑 → 本地两级（`docs/35 §3.1` · R-07「恒等优先」）。
 *
 * 算法（**逐条试，不"取最深一条"**）：
 * 1. 按 `level` 降序遍历每条 `level >= 2` 的条目：
 *    - 按 `href` 前缀找父条目（父缺失 → 用二级名的唯一归属一级兜底）；
 *    - 一级：父名 ∈ `CAD_LEVEL1_LIST` → 用它；否则 `cadStationAliasL1()`；都不中 → 跳过；
 *    - 二级：`CAD_LEVEL2_MAP[一级]` 精确含本条名字 → **命中**，一级改取 canonical 覆盖值；
 * 2. 一条都没命中 → 一级兜底：取 `level === 1` 的条目，同上归一并返回 `{一级, 未分类}`；
 * 3. 全落空 → `null`（= 面包屑给了，但本地 CAD 词表里一个都对不上 → 视为"站方没说"）。
 *
 * ⚠️ 不做三级归并（`CAD_LEVEL3_ALIAS`）：`docs/35 §3.1 ②` 的那一步在本任务范围外，
 * 且实践中二级那一层几乎总能先命中（三级条目只有在二级缺失时才会被需要）。
 */
export function s2FromBreadcrumb(
  crumbs: readonly StationCrumb[] | null | undefined,
  kind: string
): S2Parsed | null {
  const list = normalizeCrumbs(crumbs)
  if (list.length === 0) return null
  if (kind !== 'cad') return null // 本函数只管 CAD（其余走 s2FromBreadcrumbGeneric）

  const raw = rawNames(list)
  const root = rootOf(list)

  for (const child of deepestFirst(list)) {
    if (child.level < 2) continue
    // 父条目：优先按 `href` 前缀查（并列二级的父是祖先，不是前一条）；
    // 手写数组（无 `href`）时退回"面包屑的根"（level === 1 那一条）
    const parent = parentOf(child, list) ?? root

    let level1: string
    let viaAlias: string | undefined
    if (parent) {
      const resolved = resolveCadLevel1(parent.name)
      // 父名既不是当前一级、也不在别名表里 → 这条面包屑的父级不是 CAD 一级，跳过本条
      if (!resolved) continue
      level1 = resolved.level1
      viaAlias = resolved.viaAlias
      // 父条目存在但这条二级不在该一级下 → 不是一条可用的 (一级, 二级) 路径，跳过
      if (!CAD_LEVEL2_MAP[level1]?.includes(child.name)) continue
    } else {
      // 一个父级都没有（面包屑里没有 level === 1 的条目）→ 按二级名的唯一归属一级兜底
      const owner = parentKeyOfLevel2(child.name)
      if (owner === null) continue
      level1 = owner
    }

    const level2 = child.name
    const canonical1 = canonicalCadLevel1(level1, level2)
    if (!isLevel1AllowedForKind(kind, canonical1)) return null
    if (canonical1 === UNCLASSIFIED) return null
    return { level1: canonical1, level2, raw, ...(viaAlias ? { viaAlias } : {}) }
  }

  // 一级兜底：面包屑只有一级（或二级一个都对不上）→ 只给一级
  const firstLevel = list.find((c) => c.level === 1) ?? null
  if (!firstLevel) return null
  const resolved = resolveCadLevel1(firstLevel.name)
  if (!resolved) return null
  if (!isLevel1AllowedForKind(kind, resolved.level1)) return null
  if (resolved.level1 === UNCLASSIFIED) return null
  return {
    level1: resolved.level1,
    level2: UNCLASSIFIED,
    raw,
    ...(resolved.viaAlias ? { viaAlias: resolved.viaAlias } : {})
  }
}

// ── model / texture / material：走既有映射表（T-05）─────────────────────

/**
 * `mapZhimoCategory` 的三种返回形状 → 统一成「采用 / 跳过 / 放弃」。
 *
 * - 单对象（kind 能唯一确定）→ 采用；
 * - `ARR(1)` → **解包唯一元素**采用（`docs/35 §3.3`：`卡座沙发` 就是这情形）；
 * - `ARR(n>1)` → **整条 S2 放弃**（候选不唯一 = 不猜，与 `planZhimoReclass` 的
 *   `ambiguous` 同口径）。**注意这里不"再往上试一层"**：已知更深的名字有歧义时退到
 *   更浅的 crumb 会得到一个更粗、看起来更确定的答案 —— 那是把不确定性藏起来；
 * - `null` / 空数组 → 这条名字表里没有，继续试下一条（更浅的 crumb）。
 */
function adoptLookup(
  mapped: ZhimoLookupTarget | readonly ZhimoLookupTarget[] | null,
  kind: 'model' | 'texture' | 'material'
): { parsed: Omit<S2Parsed, 'raw'> } | 'ambiguous' | null {
  if (mapped === null) return null
  if (Array.isArray(mapped)) {
    if (mapped.length === 0) return null
    if (mapped.length > 1) return 'ambiguous'
    const only = mapped[0]
    if (!only) return null
    return adoptLookup(only, kind)
  }
  const target = mapped as ZhimoLookupTarget
  const category1 = typeof target.category1 === 'string' ? target.category1.trim() : ''
  if (!category1) return null // 表里落点残缺 → 当作没命中
  if (!isLevel1AllowedForKind(kind, category1)) return null // 闸门：一级不在本 kind 的容器词表
  if (category1 === UNCLASSIFIED) return null // 不允许 S2 给出"未分类/未分类"
  // 一级-only / 一级近似 → 二级留 `未分类`（唯一的判据是 `level === 1`，不猜哨兵值）
  const category2 = isLevel1Only(target)
    ? UNCLASSIFIED
    : typeof target.category2 === 'string'
      ? target.category2.trim()
      : ''
  if (!category2) return null
  const approx = 'approx' in target && target.approx === true ? true : undefined
  return { parsed: { level1: category1, level2: category2, ...(approx ? { approx } : {}) } }
}

/**
 * `model` / `texture` / `material` 面包屑 → 本地两级（`docs/35 §3.3` · R-09）。
 *
 * 规则（**从最深往上逐条试**，面包屑末级通常最具体）：
 * 1. `mapZhimoCategory(name, kind)` 返回单对象 → 采用；
 * 2. 返回 `ARR(1)` → 解包采用；
 * 3. 返回 `ARR(n>1)` → **整条 S2 = `null`**（不猜；不退回更浅的 crumb）；
 * 4. 返回 `null` → 试下一条（更浅的 crumb）；
 * 5. 全试完都没有 → 一级兜底（取 `level === 1` 的条目，名字本身是本地一级 → `{一级, 未分类}`）；
 * 6. 还不行 → `null`。
 *
 * 一级兜底为什么必须有：`1193950340` 的面包屑只有一级 `砖材`，`mapZhimoCategory('砖材')`
 * 是 `null`（它不是二级名），但 `砖材` 确实是本地一级 —— 不给兜底就把"站方只到一级"
 * 当成"站方没说"，白白丢掉一个可用的校验源（`docs/35 §3.3` 末条）。
 *
 * ⚠️ 兜底**只在"所有 crumb 都试完"之后**才做，不是逐条做 —— 否则
 * `1151853396`（`木纹 > 木材`）会在 `木材` 那一层就返回 `木材/未分类`，而正确答案是
 * 往上试到 `木纹`（站方一级名，`ZHIMO_LEVEL1_ONLY`）得到 `木纹/未分类`。
 */
export function s2FromBreadcrumbGeneric(
  crumbs: readonly StationCrumb[] | null | undefined,
  kind: 'model' | 'texture' | 'material'
): S2Parsed | null {
  const list = normalizeCrumbs(crumbs)
  if (list.length === 0) return null
  const raw = rawNames(list)

  for (const crumb of deepestFirst(list)) {
    const adopted = adoptLookup(mapZhimoCategory(crumb.name, kind), kind)
    if (adopted === 'ambiguous') return null // 候选不唯一 → 整条放弃（不猜）
    if (adopted === null) continue
    return { level1: adopted.parsed.level1, level2: adopted.parsed.level2, raw, ...(adopted.parsed.approx ? { approx: true } : {}) }
  }

  // 一级兜底：面包屑只给了本地一级名（`砖材`），或所有 crumb 都不在表里
  const firstLevel = list.find((c) => c.level === 1) ?? null
  if (!firstLevel) return null
  if (!isLevel1AllowedForKind(kind, firstLevel.name)) return null
  if (firstLevel.name === UNCLASSIFIED) return null
  return { level1: firstLevel.name, level2: UNCLASSIFIED, raw }
}
