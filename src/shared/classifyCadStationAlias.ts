/**
 * 站方 CAD **旧一级名 → 当前一级名** 的别名表（`docs/35 §3.2` · R-08）。
 *
 * ── 为什么需要这张表 ────────────────────────────────────────────────
 * 本地 CAD 词表（`taxonomy.CAD_LEVEL1_LIST` / `CAD_LEVEL2_MAP`）是**逐项照抄站方当前
 * 筛选树**的，所以站方分类名 → 本地分类名基本是**恒等**（`docs/35 §3.1` 实测：
 * 1091 条真值的 55 个 (一级, 二级) 组合 **100%** 都能在本地词表里命中）。
 *
 * 但站方**自己有两套叫法**：详情页 `breadcrumb_data` 用的是**历史词表**，
 * 而列表页筛选用的是**当前词表**。实测（`docs/34 §6.3`，36 个随机 CAD 详情页）：
 * **8 个（22%）** 面包屑里出现当前树里不存在的词；旧一级实测为
 * `室内空间`(termId 14585)、`节点图块`(13773)。
 *
 * 这不是"我们补的派生词"，是**站方的历史包袱**。所以它必须是一张**显式的表** ——
 * 靠模糊匹配（包含 / 前缀 / 相似度）来兜这种东西，等于把"站方改过名"和
 * "两个不同的类目"混为一谈。
 *
 * ── 与 `docs/34 §8` 派生词同性质 ────────────────────────────────────
 * ① 独立常量、独立注释、独立测试（`tests/classifyCadStationAlias.test.ts`）；
 * ② **不进 `CAD_LEVEL2_MAP`，也不进 `CAD_LEVEL3_ALIAS`** —— 那两个是**落盘枚举来源**，
 *    混进别名会让 UI 下拉框出现站方没有的选项（用户能选到 `室内空间`，但落盘结构里
 *    根本没有这个一级，`isLevel1AllowedForKind('cad', '室内空间')` 会把它挡掉）；
 * ③ 本表**没有**「同名不同一级」的能力：`from` 必须**不是**当前一级（否则这条别名是
 *    自指的，说明抄错了），`to` 必须是当前一级。也就是说这张表只能表达
 *    "站方以前管这个叫 A、现在叫 B"，**不能**表达"A 有时是 B、有时是 C"——
 *    后者是多义，应当走 `conflict` 让用户定（与 `docs/34 §8.4` 的"博物馆不入表"同一条理由）。
 *
 * ── 纪律（改动本文件前先读）────────────────────────────────────────
 * 1. **每条必须写 `source`**（docs 章节 + termId，或站方实测的具体 sku ID），禁止凭印象补；
 * 2. **只收「能唯一确定当前一级」的条目** —— 一个旧名对应多个当前一级时**不入表**；
 * 3. 查表**只做 `trim()` 后全等**，没有任何包含 / 前缀 / 模糊匹配；查不到返回 `null`。
 *
 * 零 IO、零 electron、零 Dexie —— 纯数据 + 纯函数，可直接进 vitest（`environment: 'node'`）。
 */

import { CAD_LEVEL1_LIST } from './taxonomy'

/** 一条「站方旧一级名 → 当前一级名」的别名 */
export interface CadStationLevel1Alias {
  /** 站方**旧**一级名（详情页 `breadcrumb_data[].showName` 原文） */
  from: string
  /** 落到哪个**当前**一级（必须是 `CAD_LEVEL1_LIST` 成员） */
  to: string
  /** 证据出处（docs 章节 + termId / 站方实测 sku ID）；单测守卫非空 */
  source: string
}

/**
 * 站方 CAD 旧一级名 → 当前一级名。
 *
 * ⚠️ 顺序无关（查表是全等匹配），但保持"最常命中的在前"，方便人读日志。
 */
export const CAD_STATION_LEVEL1_ALIAS: readonly CadStationLevel1Alias[] = [
  {
    // 实测（2026-10-29，主进程直连详情页）：
    //   sku 1136238891「办公空间 施工图」→ breadcrumb_data =
    //   [室内空间(14585) > 办公空间(12842) > 办公室(14644)]
    //   而同一 sku 在列表页的真值是 工装空间 / 办公空间（`tests/fixtures/cad-taxonomy/labeled-titles.json`）。
    // 旧词清单纯度见 `docs/34 §6.3`（`室内空间` 原 termId 14585，其下还挂着现在的 `家装空间`）。
    from: '室内空间',
    to: '工装空间',
    source:
      'docs/34 §6.3（旧一级 termId 14585）+ 站方实测 sku 1136238891：面包屑「室内空间>办公空间>办公室」vs 列表页真值「工装空间/办公空间」'
  }
]

/**
 * ⚠️ **故意不入表**的旧一级（`docs/34 §6.3` 实测存在，但本地 CAD 词表里没有可靠落点）：
 *
 * - `节点图块`(13773)：语义同时贴 `CAD图库`（图库册）与 `节点详图`（图种册），
 *   实测样本量不足以定归属分布 → **按纪律 2 不入表**，让它走 `conflict` 由用户定。
 * - 旧**二级** `文化教育建筑`(14627) / `庭院`(14587) / `家装图库`(17138) / `其他图库`(14617)
 *   同理：本表只处理**一级**别名（二级名不在本表的职责范围内，且 `庭院` 可能落
 *   `园林景观/庭院景观` 或 `家装空间`，无法唯一确定）。
 *
 * 补录前置：需要更多详情页样本量出**归属分布**，而不是靠名字像不像来猜。
 */

/** 只读索引（模块加载时摊平一次；`from` 唯一，重复会被下面那条守卫钉死） */
const ALIAS_INDEX: ReadonlyMap<string, CadStationLevel1Alias> = (() => {
  const m = new Map<string, CadStationLevel1Alias>()
  for (const entry of CAD_STATION_LEVEL1_ALIAS) m.set(entry.from, entry)
  return m
})()

/**
 * 站方旧一级名 → 当前一级名。**查不到返回 `null`**（绝不猜、绝不模糊匹配）。
 *
 * 语义边界（写死在这里，改动前先读）：
 * - 入参**已经是当前一级**（如 `工装空间`）→ 返回 `null`：本地一级不需要别名，
 *   返回它自己会让调用方分不清"命中了别名"与"本来就是当前一级"；
 * - 入参空串 / 纯空白 / `null` / `undefined` → `null`，**不抛错**；
 * - 只 `trim()` 后**全等**比较。不做大小写折叠（站方名全是中文，折叠没有意义且会
 *   让 `f783` 这种 cname 混进来）。
 */
export function cadStationAliasL1(from: string | null | undefined): string | null {
  if (typeof from !== 'string') return null
  const key = from.trim()
  if (!key) return null
  return ALIAS_INDEX.get(key)?.to ?? null
}

/** 该名字是不是当前 CAD 一级（供调用方判断"要不要去查别名"；纯查询，无副作用） */
export function isCadLevel1(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  const key = name.trim()
  return key !== '' && CAD_LEVEL1_LIST.includes(key)
}
