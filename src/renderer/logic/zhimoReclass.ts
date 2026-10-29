/**
 * 知末「站方分类」重排的**渲染层纯逻辑**（不碰 DOM / Dexie / IPC，可纯单测）。
 *
 * ── 为什么必须"先导入、后重排"（整条链路的成立前提）──────────────
 * 站方分类**拿不到在导入那一刻**：`fetchZhimoCover`（以及本文件用的 `fetchZhimoMeta`）
 * 都是 `import:batchDone` 之后的后置任务，`src/shared/types.ts` 的契约里写明
 * "不在导入链路里"。所以本功能的真实形态只能是：
 * ```
 * 导入先按既有规则落盘 → 批次结束后抓详情页 → 用 assignCategory 把目录搬过去
 * ```
 * 本文件负责第 2 步的**判定**（谁能进候选 / 站方名落到哪个本地分类对 / 怎么分组），
 * 落库（搬目录 + 写 Dexie + 撤销备份）全部由 `store.runZhimoCategoryReclass()` 走既有
 * `assignCategory`，本文件一行写库代码都没有。
 *
 * ── 三条纪律（改动本文件前先读）──────────────────────────────────
 * 1. **只查表、不猜**：站方名 → 本地分类的唯一权威是 `shared/zhimoTaxonomyMap.ts`。
 *    这里只调用 `mapZhimoCategory(name, kind)`，不做任何包含 / 前缀 / 相似度匹配。
 *    返回候选数组（没给 kind 或筛不出唯一）→ `ambiguous`，跳过不猜。
 * 2. **软删记录不是候选**：库内回收站里的记录仍留在 `assets` 里（目录已进 `.trash/`），
 *    对它们调 `assignCategory` 必然失败。候选筛选必须 `!isDeletedAsset(a)`。
 * 3. **`classifyBaseName === null` 是正常结果**：站方没给分类，不是失败
 *    （`noStation`），绝不能记成 `failed` —— 否则"站方覆盖不全"会被误报成"抓取挂了"。
 *
 * ── 与 `logic/zhimoCover.ts` 的关系 ──────────────────────────────
 * 队列形态（小并发 / 请求间隔 / 分块 / 可中止 / 永不抛错）刻意照抄
 * `runZhimoCoverQueue`，但**不复用**：那个函数是封面专用（`FetchZhimoCoverResult`、
 * 落盘语义、`skipped` 分支），把分类塞进去会让两边都hard to read。
 */

import type { Asset, AssetKind, ClassifyReview, FetchZhimoMetaResult } from '../../shared/types'
import { zhimoIdOf } from '../../shared/naming'
import { isLevel1Only, mapZhimoCategory, type ZhimoLookupTarget } from '../../shared/zhimoTaxonomyMap'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { classifyAssetName } from '../../shared/classifyAsset'
import { decideClassify, type CrossS1, type CrossS2 } from '../../shared/classifyCrossCheck'
import type { ClassifyConfidence } from '../../shared/classifyCrossCheck'
import {
  s2FromBreadcrumb,
  s2FromBreadcrumbGeneric,
  type S2Parsed,
  type StationCrumb
} from '../../shared/classifyCrossSource'
import { categoriesOf } from './category'
import { isDeletedAsset } from './trashView'

// ── 新通道的备份前缀（**必须与老通道分开**） ──────────────────────────
//
// 老「重跑自动分类」用 `reclass-`；本通道用 `zhimo-reclass-`。
// 不换前缀会有两个真实故障：
// ① 两条通道会互相把对方的备份当成"上次重跑"消费掉（撤销撤错东西）；
// ② 两条通道共享 `RECLASS_BACKUP_KEEP = 3` 的上限，一边跑两次就把另一边的凭证挤没。
// 注意 `zhimo-reclass-` **不以** `reclass-` 开头，所以老前缀过滤天然不会误吞。
export const ZHIMO_RECLASS_BACKUP_PREFIX = 'zhimo-reclass-'

/** 抓详情页的默认并发（与封面同口径：取 2 更保守，站点限流时不容易 403） */
export const ZHIMO_RECLASS_CONCURRENCY = 2

/** 默认请求间隔（口径同封面：≥250ms） */
export const ZHIMO_RECLASS_GAP_MS = 250

/** 分块大小 / 块间间隔（大批量导入时给站点喘息窗口） */
export const ZHIMO_RECLASS_CHUNK_SIZE = 50
export const ZHIMO_RECLASS_CHUNK_GAP_MS = 2000

// ── 候选筛选 ────────────────────────────────────────────────────────

/**
 * 取一个资产可用于查知末详情的 ID（**与封面通道同一口径**）。
 *
 * 顺序写死：`asset.zhimoId`（导入时从压缩包名/资产名/包内文件名算好落库）优先，
 * 空串 / 纯空白 / 非字符串才退回 `zhimoIdOf(asset.name)`。
 *
 * 为什么不能只看名字：知末有大量包只在**压缩包名**上带 ID
 * （`现代壁灯ID_1232108421.rar` 解包后资产名零 ID 痕迹），只看 `asset.name`
 * 会让这类资产的站方分类**永远**取不到。
 */
export function zhimoReclassIdOf(
  asset: Pick<Asset, 'name' | 'zhimoId'>
): string | null {
  const storedId = typeof asset.zhimoId === 'string' ? asset.zhimoId.trim() : ''
  return storedId || zhimoIdOf(asset.name)
}

/**
 * 这个资产是不是本通道的候选（三条 AND，缺一不可）：
 *
 * ① **不是软删记录** —— 回收站里的记录目录已在 `.trash/`，`assignCategory` 必然失败；
 * ② 当前分类是 `未分类 / 未分类` —— 已分类的一个都不碰（避免把人工归类冲掉）；
 * ③ 能取到知末 ID —— 取不到就发不出请求，也没有可查的站方分类。
 *
 * 纯函数：只读入参，不做 IO。
 */
export function isZhimoReclassCandidate(asset: Asset): boolean {
  if (isDeletedAsset(asset)) return false
  const cur = categoriesOf(asset)
  if (cur.category1 !== UNCLASSIFIED || cur.category2 !== UNCLASSIFIED) return false
  return zhimoReclassIdOf(asset) !== null
}

/**
 * 交叉验证通道（T1，`docs/35 §5`）的候选筛选。
 *
 * **就是一个别名，指向 `isZhimoReclassCandidate()`，刻意不多收任何一类。**
 *
 * ## 为什么是别名而不是"放宽一档"（这条是数据安全底线，别改）
 *
 * 直觉上会想："已分类但 `confidence === 'medium-s1'` 的资产也该复验一下，
 * 因为它的分类是 S1 猜的。" **这个直觉会毁数据。**
 *
 * 用户手工拖拽归类走的是 `assignCategoryWithUndo` → `assignCategory`（`store.ts:3116`），
 * 它**只搬目录、不动 `classifyReview`**。所以一条被用户手工拖到 `家具/沙发` 的资产，
 * 其 `classifyReview` 仍然是 T0 写的 `{ confidence: 'medium-s1' }` —— **与"从没被碰过"
 * 在库上完全无法区分**。若把它放进候选，T1 一旦判出 `high` 且落点不同，就会
 * **把用户刚手工分的类自动搬回去**。这不是"多抓一次"的成本问题，是改用户的结论。
 *
 * 区分"用户定的"与"T0 猜的"需要一个 T0 快照字段（例如把当时的 `category1/2` 一起落库），
 * 那是数据层变更、不在本卡范围。**在那之前，正确做法是"看不见就不碰"**：
 * 只处理双未分类（`isZhimoReclassCandidate` 的既有口径），已分类的一个都不动 ——
 * 这也正好与 `docs/35 §5.2` 原文"候选筛选必须复用现有 `isZhimoReclassCandidate`"一致。
 *
 * ## 那么门槛②（落点 ≠ 当前磁盘分类）怎么会被触发
 *
 * 在"候选恒为双未分类"的前提下，门槛② 是**防御性代码**：`high` 的落点不可能是
 * `未分类/未分类`（`decideClassify` 在两边都空时给 `none`），所以当前分类恒不等于落点。
 * 它留在 `planZhimoVerify()` 里,是为了**将来若放宽候选**（补了 T0 快照之后）不必再改判定，
 * 而不是现在能走到。`tests/zhimoCrossVerify.test.ts` 的门槛② 用例因此打在纯函数层。
 *
 * 另外**已定案的一律不抓**（门槛③ 的第一道闸）：`decidedAt` 有值 = 用户或上一轮已经
 * 裁定过，重抓一次只为得到 `untouched` 是纯浪费站方配额。理论上「`decidedAt` 有值 +
 * 双未分类」不该出现（T2 定案一定伴随搬目录），但数据里什么都可能有，多这一句零成本。
 */
export function isZhimoVerifyCandidate(asset: Asset): boolean {
  if (!isZhimoReclassCandidate(asset)) return false
  return typeof asset.classifyReview?.decidedAt !== 'number'
}

// ── 站方名 → 本地分类对（纯判定） ───────────────────────────────────

/** 判定跳过原因（与 store 的三个计数器一一对应，别合并） */
export type ZhimoReclassSkipReason =
  /** 站方没给分类（`classifyBaseName` 为 null/空）—— **正常结果**，不是失败 */
  | 'no-station'
  /** 站方给了名字，但映射表里没有（本地词表缺口 / 未抄录） */
  | 'unmapped'
  /** 映射表返回候选数组（没给 kind 或筛不出唯一）—— 不猜 */
  | 'ambiguous'

/** 一个可落库的落点（store 据此进备份 + 分组 + `assignCategory`） */
export interface ZhimoReclassPlan {
  category1: string
  /** `level1 === true` 时恒为哨兵「未分类」（站方只给了一级） */
  category2: string
  /** true = 就近归并（**必须单独计数并写日志**，这是"有多少条是猜的"的唯一锚点） */
  approx: boolean
  /** true = 只有一级确定，二级写未分类 */
  level1: boolean
  /** 站方原话（`classifyBaseName`）；近似条目就是 `stationName` */
  stationName: string
  /** 映射表里的出处（文档章节 / 实测 ID），日志与回溯用 */
  source: string
}

/** 判定结果：要么给落点，要么给跳过原因（不抛错、不返回 null） */
export type ZhimoReclassDecision = ZhimoReclassPlan | { skip: ZhimoReclassSkipReason }

/**
 * 交叉验证通道（T1）里「判定成功但不搬」的桶（`docs/35 §5.3`）。
 *
 * ⚠️ 2026-10-29 之后 `medium-s2` **不再属于这个类型** —— 它改成搬目录了（门槛① 放宽）。
 * 现在只剩 `conflict` 一种"判定成功、交用户裁定、不搬"的形态，`unverified` 则变成
 * **`moved` 的子集**（单源搬的计数，属于 `plan` 分支）。本类型保留是为了不与
 * `ZhimoReclassSkipReason` 混用：`skip` 的语义是**判定失败**（站方没给 / 表里没有 /
 * 筛不出唯一），而 `conflict` 是**判定成功**只是不许自动定案（R-05）。
 * 混进 `skip` 会让设置页那三行「多候选 / 未映射 / 站方未给」把成功判定的结果报成失败。
 */
export type ZhimoVerifyBucket = 'conflict'

/**
 * 队列判定钩子的输出（`docs/35 §5.2` 三条门槛的落点）。
 *
 * 与 `ZhimoReclassDecision` **并存不替换**：老的 `planZhimoReclass()` 仍是缺省实现，
 * 这里只是给它加了一层"判完之后还有哪些处置"的表达能力。
 *
 * - `plan`      搬目录（`high` / `medium-s2`，且落点 ≠ 当前分类）；
 * - `skip`      判定失败，沿用老的三个桶；
 * - `conflict`  进待确认队列 + 写回（不搬）；
 * - `mark`      只写回、不搬、不计数 —— 落点已等于当前分类（门槛②）。
 *   `high` 与 `medium-s2` 都会走到这里。
 * - `untouched` 什么都不做（见类型内的三条 reason）。
 *
 * ⚠️ **`medium-s2` 也搬**（2026-10-29 team-lead 裁定，`docs/35 §5.2` 修订）：
 * 站方单源 55%+ 的准确率**高于**导入链路现状（文件名匹配，CAD 实测二级命中 42.5%），
 * 不搬反而比现状更保守。条件是不可逆风险已被三层兜住：`zhimo-reclass-` 备份 +
 * 5 秒撤销 + 最近删除。搬错的代价是"在错的分类目录里"（搜得到、拖一下就改），
 * 不搬的代价是"每次打开都占着整理队列"。
 * `medium-s1` **绝不搬** —— 那只有我们自己的猜测，拿 S1 重写 S1 没有信息增量。
 */
export type ZhimoVerifyOutcome =
  | {
      kind: 'plan'
      plan: ZhimoReclassPlan
      review?: ClassifyReview
      /**
       * 这一条的置信度。`medium-s2` = 单源搬运，store 侧要计入 `unverified`
       * （`docs/35 §5.3`：`unverified` 是 `moved` 的子集，语义 = "没被第二源验证过就搬了"）。
       */
      confidence?: ClassifyConfidence
    }
  | { kind: 'skip'; skip: ZhimoReclassSkipReason }
  | { kind: 'conflict'; review: ClassifyReview }
  | { kind: 'mark'; review: ClassifyReview }
  /**
   * 什么都不做（既不搬、也不写库）：
   * - `reason: 'decided'`：已定案（门槛③）—— 连判定都没跑；
   * - `reason: 'gone'`：抓取期间资产被删 / 被 rescan 换掉 → 没有可判的对象；
   * - `reason: 'same-as-initial'`：判定出来了（`medium-s1` / `none`），但**与 T0 写下的初值
   *   完全同形**，写回等于白写一次 `bulkPut`（`docs/35 §5.3` 末条）。
   *   `confidence` 带出来是为了让调用方/测试能断言"这条被判成了什么"。
   */
  | {
      kind: 'untouched'
      reason: 'decided' | 'gone' | 'same-as-initial'
      confidence?: ClassifyConfidence
      /**
       * true = 站方给了末级名（`classifyBaseName`）但面包屑还原不出路径 → 计入 `unmapped`。
       *
       * 2026-10-29 修订：`unmapped` 不再是"老通道才有的桶"。交叉验证通道里这一类
       * **真实存在**（实测约 20% 的详情页没有面包屑，站方只给了末级名），必须计数 ——
       * 否则"站方覆盖不全"与"我们的路径还原有缺口"就永远分不清。
       */
      unmapped?: true
    }

/** `planZhimoReclass()` 的入参（拆成对象便于表驱动单测） */
export interface ZhimoReclassPlanInput {
  /** `window.modvault.fetchZhimoMeta` 的返回（`ok:false` 也会进来，按 no-station 处理） */
  meta: FetchZhimoMetaResult
  /** 资产大类：一对多映射靠它分流（`窗帘` / `绿植` / `小区景观` 等） */
  kind: AssetKind
  /**
   * 资产名（仅用于日志/回溯，**不参与匹配**）。
   * 显式收下是为了将来"按名字补证"时有位置可放，而不是偷偷用名字猜分类。
   */
  name?: string
}

/** 类型守卫：判定结果是「跳过」而不是「落点」 */
export function isZhimoReclassSkip(
  decision: ZhimoReclassDecision
): decision is { skip: ZhimoReclassSkipReason } {
  return 'skip' in decision
}

/**
 * 站方分类名 → 本地分类对（**纯函数，零 IO**）。
 *
 * 优先级完全交给 `mapZhimoCategory(name, kind)`：
 * 1. 两级映射命中且 kind 能唯一筛出 → 单对象 → 落两级；
 * 2. 一级-only（`level: 1`）→ `category2` 写 `UNCLASSIFIED`；
 * 3. 就近归并（`approx: true`）→ 原样落点，但 `approx` 标记必须透传；
 * 4. 候选数组 → `ambiguous`（不猜）；`null` → `unmapped`。
 *
 * 边界：
 * - `meta.ok !== true`（网络/超时/ID 不存在）→ `no-station`（store 侧会先按 `failed` 计，
 *   这里的返回值只是防御性兜底，保证本函数永不返回 undefined）；
 * - `classifyBaseName` 为 null / 空串 / 纯空白 → `no-station`；
 * - 落点为空串或双哨兵 → `unmapped`（绝不让"未分类→未分类"的空移动进备份）。
 */
export function planZhimoReclass(input: ZhimoReclassPlanInput): ZhimoReclassDecision {
  const meta = input.meta
  if (!meta || meta.ok !== true) return { skip: 'no-station' }

  const stationName =
    typeof meta.classifyBaseName === 'string' ? meta.classifyBaseName.trim() : ''
  if (!stationName) return { skip: 'no-station' }

  const mapped = mapZhimoCategory(stationName, input.kind)
  // `null` = 表里没有（含 kind 与近似条目不匹配的情况）→ 不猜
  if (mapped === null) return { skip: 'unmapped' }
  // 候选数组 = 筛不出唯一 → 不猜（哪怕长度为 1：数组分支的语义就是"没给 kind"）
  if (Array.isArray(mapped)) return { skip: 'ambiguous' }

  const target = mapped as ZhimoLookupTarget
  const level1 = isLevel1Only(target)
  const category1 = typeof target.category1 === 'string' ? target.category1.trim() : ''
  const category2 = level1
    ? UNCLASSIFIED
    : typeof target.category2 === 'string'
      ? target.category2.trim()
      : ''
  // 落点残缺 / 双哨兵 = 没有可移动的信息 → 按"表里没有"处理（不进备份，不产生空移动）
  if (!category1 || !category2) return { skip: 'unmapped' }
  if (category1 === UNCLASSIFIED && category2 === UNCLASSIFIED) return { skip: 'unmapped' }

  const approx = 'approx' in target && target.approx === true
  const approxTarget = approx ? (target as { stationName?: string }) : null

  return {
    category1,
    category2,
    approx,
    level1,
    stationName:
      approxTarget && typeof approxTarget.stationName === 'string'
        ? approxTarget.stationName
        : stationName,
    source: typeof target.source === 'string' ? target.source : ''
  }
}

// ── 交叉验证（T1，docs/35 §5）───────────────────────────────────────

/**
 * 把 `FetchZhimoMetaResult.breadcrumb` 解析成 S2（`docs/35 §3`）。
 *
 * `hdri` / `other` **没有站方源**（§3.4）：`isLevel1AllowedForKind` 对这两册恒 false、
 * `CHANNEL_LEVEL1` 里也没有它们，所以这里**直接返回 null**，不做任何尝试 ——
 * 也不要"强转 kind 绕过类型"去凑一个 S2（那等于编造站方结论）。
 */
export function s2OfMeta(
  meta: FetchZhimoMetaResult,
  kind: AssetKind
): S2Parsed | null {
  const crumbs: StationCrumb[] = meta.breadcrumb ?? []
  if (crumbs.length === 0) return null
  if (kind === 'hdri' || kind === 'other') return null
  if (kind === 'cad') return s2FromBreadcrumb(crumbs, 'cad')
  return s2FromBreadcrumbGeneric(crumbs, kind)
}

/** `S2Parsed` → `ClassifyReview.sources.s2`（**显式挑字段**，不用 `as` 强转） */
function reviewS2Of(parsed: S2Parsed): {
  level1: string
  level2: string
  raw: string[]
  fromBaseName: boolean
} {
  return {
    level1: parsed.level1,
    level2: parsed.level2,
    raw: [...parsed.raw],
    // 恒 false：本批 S3（classifyBaseName）**不参与判定**（§3.1 / R-03），
    // 所以 S2 永远来自面包屑。字段留着是为了将来若接"末级名兜底"能标记来源。
    fromBaseName: false
  }
}

/**
 * 判定一条资产在 T1 该做什么（`docs/35 §5.2` 三条门槛 + §5.3 四种写回形态）。
 *
 * **纯函数**：入参是"资产当前状态 + 刚抓到的 meta"，出参是"搬不搬 / 写什么"，
 * 不做 IO、不调 `assignCategory`、不写日志。
 *
 * 三条门槛（AND，缺一不搬）——**2026-10-29 team-lead 裁定修订**：
 * 1. `confidence === 'high'` **或** `'medium-s2'`；
 * 2. 落点 ≠ 当前磁盘分类；
 * 3. `classifyReview.decidedAt` 不存在（没定过案）。
 *
 * 为什么 `medium-s2` 也搬（裁定原话要点）：导入链路现状按文件名匹配直接落盘
 * （CAD 实测二级命中 42.5%），站方单源 55%+ 不比它差，**不搬才是倒退**；
 * 且 `medium-s2` 不搬等于"自动采用"变成空话，42% 的收益全丢，用户仍面对 600 条整理队列。
 * 可逆性由 `zhimo-reclass-` 备份 + 5 秒撤销 + 最近删除三层兜住。
 *
 * 为什么不搬 `medium-s1`：那只有我们自己的猜测，拿 S1 重写 S1 是零信息增量的自我循环，
 * 而且它正是"导入时已经这样做了"的现状行为，不该由「站方重排」这个动作再搬一次。
 *
 * ⚠️ 门槛 ③ 的语义按代码事实（不是设计文档的绕表述）：`decidedAt` 有值 = 已定案
 * （用户手工归类 / 上一轮自动搬完）→ **不再搬**。因为门槛 ① 已经筛过置信度，
 * 所以 ③ 只需判 `decidedAt`，**不要**写成"`confidence !== 'high'` 且 `decidedAt` 不存在"
 * 这种复合条件 —— 那与 ① 重复，且会漏掉 `medium-s2`。
 */
export function planZhimoVerify(input: {
  /** 资产当前状态（只用到 name / files / kind / 分类 / classifyReview） */
  asset: Pick<Asset, 'name' | 'files' | 'kind' | 'category1' | 'category2' | 'classifyReview'>
  /** `window.modvault.fetchZhimoMeta` 的返回（`ok:false` 也会进来，按 skip 处理） */
  meta: FetchZhimoMetaResult
  /** 判定时刻（`decidedAt` 用；注入便于单测断言） */
  now: number
}): ZhimoVerifyOutcome {
  const { asset, meta, now } = input

  // 门槛 ③ 先判：已定案的连判断都不做（连 fetch 之前就已筛掉，这里是二道防线）
  if (typeof asset.classifyReview?.decidedAt === 'number') {
    return { kind: 'untouched', reason: 'decided' }
  }

  if (!meta || meta.ok !== true) return { kind: 'skip', skip: 'no-station' }

  // ── S1：标题语义（可重算，不存库）──────────────────────────────
  const s1Raw = classifyAssetName(
    asset.name,
    asset.files?.map((f) => f.name),
    asset.kind
  )
  const s1: CrossS1 = { category1: s1Raw.category1, category2: s1Raw.category2 }

  // ── S2：站方面包屑（hdri / other 恒 null，见 s2OfMeta）──────────
  const parsed = s2OfMeta(meta, asset.kind)
  const s2: CrossS2 | null =
    parsed === null
      ? null
      : {
          level1: parsed.level1,
          level2: parsed.level2,
          raw: [...parsed.raw],
          ...(parsed.viaAlias ? { viaAlias: parsed.viaAlias } : {})
        }

  // ── S3：站方末级名。**只做旁证，绝不参与判定**（§3.1 / R-03）─────
  const baseName =
    typeof meta.classifyBaseName === 'string' && meta.classifyBaseName.trim()
      ? meta.classifyBaseName.trim()
      : null

  const decision = decideClassify({ s1, s2, s3: baseName })
  const sourcesS2 = parsed === null ? undefined : reviewS2Of(parsed)

  /**
   * 「站方给了名字，但我们还原不出路径」——`unmapped` 桶的唯一来源。
   *
   * 这一类**真实存在**且必须计数：`classifyBaseName` 有值说明站方确实说了话，
   * 只是面包屑缺失（实测约 20%）或名字不在本地词表里。如果把它和 `none`
   * （站方什么都没给）混在一起，就分不清"站方覆盖不全"与"我们的词表有缺口"。
   */
  const stationNameOnly = s2 === null && baseName !== null

  const sourcesOfReview = (): ClassifyReview['sources'] | undefined =>
    sourcesS2 || baseName
      ? {
          ...(sourcesS2 ? { s2: sourcesS2 } : {}),
          ...(baseName ? { s3: baseName } : {})
        }
      : undefined

  // ── conflict：两源打架，绝不替用户选（R-05）───────────────────────
  if (decision.confidence === 'conflict') {
    return {
      kind: 'conflict',
      review: {
        confidence: 'conflict',
        reason: 'conflict',
        // **必须持久化 sources.s2** —— 否则下次启动浮层里"为什么存疑"就没了（§5.3）
        ...(sourcesOfReview() ? { sources: sourcesOfReview() } : {})
      }
    }
  }

  // ── medium-s1 / none：不搬、也不写库 ─────────────────────────────
  //
  // 理由（§5.3 末条）：这两种结论与 T0 写下的初值**完全同形**（T0 就是按 S1 写的），
  // 写回等于白写一次 `bulkPut`，还会把"这批抓过详情页了"这个事实表达错。
  if (decision.confidence !== 'high' && decision.confidence !== 'medium-s2') {
    return {
      kind: 'untouched',
      reason: 'same-as-initial',
      confidence: decision.confidence,
      ...(stationNameOnly ? { unmapped: true as const } : {})
    }
  }

  // 到这里 confidence ∈ { high, medium-s2 } —— 两条都可能搬
  const review: ClassifyReview = {
    confidence: decision.confidence,
    ...(sourcesOfReview() ? { sources: sourcesOfReview() } : {}),
    // 定案时刻：`decidedAt` 有值 = 已定案 = 后续自动流程不再翻动（门槛 ③ 靠它生效）。
    // ⚠️ store 侧只在**移动成功后**才落库（移动失败不写，否则这条永远不会被重试）。
    decidedAt: now
  }

  // ── 门槛 ②：落点等于当前磁盘分类 → 不搬（`assignCategory` 会判 skipped，
  //    但仍会走 IPC + regenThumbSweep，纯浪费；§5.2 原文）──────────────
  //
  // 口径与 `categoriesOf` 一致（`''` 兜成未分类），但不用 `categoriesOf(asset)`：
  // 入参是 `Pick<Asset,…>`，调用它要整条 `Asset`（或强转），而这里只需要两个字段。
  const curCategory1 = asset.category1 || UNCLASSIFIED
  const curCategory2 = asset.category2 || UNCLASSIFIED
  if (decision.category1 === curCategory1 && decision.category2 === curCategory2) {
    return { kind: 'mark', review }
  }

  return {
    kind: 'plan',
    confidence: decision.confidence,
    plan: {
      category1: decision.category1,
      category2: decision.category2,
      /**
       * 「站方映射是近似归并」的标记 —— 直接透传 S2 解析结果里的 `approx`。
       *
       * ⚠️ 2026-10-29 修订：这里**不再是恒 `false`**。`s2FromBreadcrumbGeneric` 遇到
       * 映射表的 `approx: true` 条目（`茶具` / `夹胶玻璃` 等）会原样透传，本通道照抄，
       * 于是 `summary.approx` 有了真实来源（"这批里有多少条是按相近类目归并的"）。
       * CAD 通道（`s2FromBreadcrumb`）不做近似归并，恒 `false`。
       */
      approx: parsed?.approx === true,
      level1: decision.category2 === UNCLASSIFIED,
      // 站方原话（回溯用）：末级名优先，其次面包屑最深一条
      stationName: baseName ?? parsed?.raw.at(-1) ?? '',
      source:
        decision.confidence === 'high'
          ? 'docs/35 §5.2（S1 与 S2 交叉验证一致）'
          : 'docs/35 §5.2（站方单源 medium-s2，2026-10-29 裁定自动采用）'
    },
    review
  }
}

// ── 分组 / 键 ───────────────────────────────────────────────────────

/**
 * 分类对的 Map 键（与 store 既有写法逐字一致：`${c1}\u0000${c2}`）。
 *
 * 用 `\u0000` 而不是 `/` 或 `|`：分类名是用户可写的受控词表，理论上可能含任意可见字符，
 * 只有 NUL 不会出现在分类名里（`normalizeCategoryPair` 会清洗非法字符）。
 */
export function categoryPairKey(category1: string, category2: string): string {
  return `${category1}\u0000${category2}`
}

/** `categoryPairKey()` 的逆运算（store 拿 key 回查两级名用） */
export function parseCategoryPairKey(key: string): { category1: string; category2: string } {
  const index = key.indexOf('\u0000')
  if (index === -1) return { category1: key, category2: '' }
  return { category1: key.slice(0, index), category2: key.slice(index + 1) }
}

/** `groupByCategoryPair()` 的最小输入（不要求整条 Asset） */
export interface ZhimoReclassGroupEntry {
  id: string
  category1: string
  category2: string
}

/**
 * 按分类对分组：一次 `assignCategory` 只能接受**一个**分类对，分组能把
 * 「同落点 N 个资产」压成一次调用（与 `reclassifyUnclassified` / AI 补分类同一口径）。
 *
 * 顺序 = 入参顺序（`Map` 保插入序），ids 亦然 —— 便于日志与断言稳定。
 */
export function groupByCategoryPair(
  entries: readonly ZhimoReclassGroupEntry[]
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const key = categoryPairKey(entry.category1, entry.category2)
    const ids = groups.get(key)
    if (ids === undefined) {
      groups.set(key, [entry.id])
      continue
    }
    ids.push(entry.id)
  }
  return groups
}

// ── 抓取队列（照 `runZhimoCoverQueue` 的形态，不是 import 它） ────────

/** 一个待抓目标：资产 id + 知末 ID + 判定所需的大类 */
export interface ZhimoReclassTarget {
  id: string
  zhimoId: string
  kind: AssetKind
  /** 仅日志/回溯用（不参与匹配） */
  name: string
  /** 资产内文件名（只给交叉验证的 S1 用；老的 `planZhimoReclass` 不看它） */
  fileNames?: string[]
  /** 当前磁盘分类 + 已落库的判定痕迹（T1 门槛②③ 要读；老通道不看） */
  category1?: string
  category2?: string
  classifyReview?: ClassifyReview
}

/** 一条命中（已抓完、判定完成，等 store 备份 + 落地） */
export interface ZhimoReclassHit {
  id: string
  category1: string
  category2: string
  approx: boolean
  level1: boolean
  /**
   * 该条要写回的 `classifyReview`（`docs/35 §5.3`）。缺省 = 不写库
   * （老通道 `planZhimoReclass` 不产生它 —— 那条通道的落点只来自站方单源，
   * 写 `medium-s2` 会与"按站方重排"的既有语义混淆）。
   */
  review?: ClassifyReview
}

/** 进度（store 写进 `zhimoReclass` 状态，供设置页显示） */
export interface ZhimoReclassProgress {
  /** 已处理条数（含失败 / 跳过），单调递增 */
  done: number
  /** 本次总条数（= 候选数） */
  total: number
}

export interface ZhimoReclassQueueDeps {
  /** 抓一条详情页元信息（已注入：队列自己不做任何 IPC / 网络） */
  fetchMeta: (target: ZhimoReclassTarget) => Promise<FetchZhimoMetaResult>
  /**
   * 判一条已抓到的 meta（缺省 = `planZhimoReclass`，即老通道的行为**逐字不变**）。
   *
   * 加这个钩子而不是在队列里 `if (verify)` 分支：判定规则是"三条门槛 + 四种写回形态"，
   * 放进队列会让队列同时管节流与业务裁定，两边都难读。队列只负责"什么时候抓、
   * 抓到了交给谁、结果怎么计数"。
   */
  decide?: (target: ZhimoReclassTarget, meta: FetchZhimoMetaResult) => ZhimoVerifyOutcome
  /** 每处理完一条的回调（含跳过 / 失败），抛错不影响队列 */
  onProgress?: (progress: ZhimoReclassProgress) => void
  /** 间隔用；测试注入即时桩（默认真实 `setTimeout`） */
  sleep?: (ms: number) => Promise<void>
  /** 每轮开始前 + 发请求前各查一次（取消 / 关窗口立刻生效） */
  shouldStop?: () => boolean
  concurrency?: number
  gapMs?: number
  chunkSize?: number
  chunkGapMs?: number
}

export interface ZhimoReclassQueueResult {
  /** 判定命中的条目（**取消时已抓到的也会返回**，store 必须照样落库） */
  hits: ZhimoReclassHit[]
  /** 实际发出请求的条数（含失败）—— 用于 notice 与日志 */
  scanned: number
  /** 映射表返回候选数组而跳过 */
  ambiguous: number
  /** 映射表没有该站方名 */
  unmapped: number
  /** 站方没给分类（`classifyBaseName === null`） */
  noStation: number
  /** 详情页请求失败（网络 / 超时 / ID 不存在 / 注入桩抛错） */
  failed: number
  /** true = 被 `shouldStop()` 叫停，剩余条目**没有发请求** */
  stopped: boolean
  /** 交叉验证判为 conflict 的条数（进待确认队列，不搬目录）。老通道恒 0 */
  conflicts: number
  /**
   * ⚠️ **`moved` 的子集**：其中站方单源（`medium-s2`）搬的条数。
   * 老通道恒 0（它的落点只来自 `mapZhimoCategory` 单源，不区分置信度）。
   */
  unverified: number
  /** 只写回 `classifyReview`、不搬不计数（`high` / `medium-s2` 且落点相同）。老通道恒 0 */
  marked: number
  /**
   * 要写回 `classifyReview` 的条目（conflict / marked 两种，**不含** `hits`）。
   *
   * 为什么要单独一个数组而不是塞进 `hits`：`hits` 的语义是"要搬目录的落点"，
   * store 会拿它去 `backupReclassMoves` + `groupByCategoryPair` + `assignCategory`。
   * 把"不搬只标记"的条目混进去，备份里就会出现一堆"原分类 = 目标分类"的空凭证，
   * 撤销时会把它们搬一遍（no-op 变成误改名，`assignCategory` 的注释里有这个坑）。
   */
  reviews: Array<{ id: string; review: ClassifyReview }>
}

/** 老通道（`planZhimoReclass`）的判定结果 → 统一的 `ZhimoVerifyOutcome` 形状（无 `review`） */
function legacyOutcomeOf(decision: ZhimoReclassDecision): ZhimoVerifyOutcome {
  if (isZhimoReclassSkip(decision)) return { kind: 'skip', skip: decision.skip }
  return { kind: 'plan', plan: decision }
}

/** 默认 sleep（节流，不是让路：不能用 `requestIdleCallback`） */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 跑一批详情页抓取 + 判定：**小并发 + 请求间隔 + 分块**，可随时叫停，**永不抛错**。
 *
 * 与 `runZhimoCoverQueue` 的三条纪律一致：
 * ① 全局闸门保证任意两次请求起始之间至少 `gapMs`（用"已发请求数"判定，便于注入桩断言）；
 * ② 每 `chunkSize` 条之间停 `chunkGapMs`（大批量不把站点打成爬虫）；
 * ③ `shouldStop()` 在**取任务前**与**发请求前**各查一次。
 *
 * 计数口径（互斥，加起来 = `scanned`）：
 * `hits.length + ambiguous + unmapped + noStation + failed === scanned`。
 * 取消后 `stopped = true`，剩余条目既不计 scanned 也不计任何结果。
 *
 * **交叉验证通道**（`deps.decide` 注入 `planZhimoVerify`）额外占用两个不进 `hits` 的桶
 * —— `conflicts` / `unverified`，它们也计入上面那个等式（判定成功、只是不搬）。
 * `marked` 是"只写回不搬"的子集计数，**不进等式**（它的条目仍算 hits 里的一条？不：
 * 它连 hits 都不进，因为不搬；它的条数也进等式）。
 */
export async function runZhimoReclassQueue(
  items: readonly ZhimoReclassTarget[],
  deps: ZhimoReclassQueueDeps
): Promise<ZhimoReclassQueueResult> {
  const sleep = deps.sleep ?? realSleep
  const concurrency = Math.max(1, deps.concurrency ?? ZHIMO_RECLASS_CONCURRENCY)
  const gapMs = Math.max(0, deps.gapMs ?? ZHIMO_RECLASS_GAP_MS)
  const chunkSize = Math.max(1, deps.chunkSize ?? ZHIMO_RECLASS_CHUNK_SIZE)
  const chunkGapMs = Math.max(0, deps.chunkGapMs ?? ZHIMO_RECLASS_CHUNK_GAP_MS)

  const result: ZhimoReclassQueueResult = {
    hits: [],
    scanned: 0,
    ambiguous: 0,
    unmapped: 0,
    noStation: 0,
    failed: 0,
    stopped: false,
    conflicts: 0,
    unverified: 0,
    marked: 0,
    reviews: []
  }
  const total = items.length
  if (total === 0) return result

  let done = 0
  const tick = (): void => {
    done += 1
    if (deps.onProgress) {
      try {
        deps.onProgress({ done, total })
      } catch {
        // 进度回调是 UI 的事，抛错绝不能中断抓取
      }
    }
  }

  /**
   * 全局节流闸门：保证**任意两次请求的起始**之间至少间隔 `gapMs`。
   *
   * 用"已发请求数"而不是真实时钟差：注入的 `sleep` 桩可能瞬时返回，
   * 用时钟差会让断言不可预期；用计数则 "每发一次就等一次"，`sleep` 序列即节流证据。
   */
  let started = 0
  const passGate = async (): Promise<void> => {
    if (started > 0 && gapMs > 0) await sleep(gapMs)
    started += 1
  }

  for (let offset = 0; offset < total; offset += chunkSize) {
    if (result.stopped || deps.shouldStop?.()) {
      result.stopped = true
      break
    }
    const chunk = items.slice(offset, offset + chunkSize)

    let cursor = 0
    const workerCount = Math.min(concurrency, chunk.length)
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (deps.shouldStop?.()) {
          result.stopped = true
          return
        }
        const index = cursor
        cursor += 1
        if (index >= chunk.length) return
        const item = chunk[index]!

        await passGate()
        // 间隔等待期间可能被叫停（用户点了取消 / 窗口关闭）→ 不再发这一发
        if (deps.shouldStop?.()) {
          result.stopped = true
          return
        }

        result.scanned += 1
        let meta: FetchZhimoMetaResult | null = null
        try {
          meta = await deps.fetchMeta(item)
        } catch {
          // 注入的桩抛错 / IPC 异常：按"本次请求失败"计，绝不中断整批
          meta = null
        }
        if (meta === null || meta.ok !== true) {
          result.failed += 1
          tick()
          continue
        }

        const outcome: ZhimoVerifyOutcome = deps.decide
          ? deps.decide(item, meta)
          : legacyOutcomeOf(planZhimoReclass({ meta, kind: item.kind, name: item.name }))

        if (outcome.kind === 'plan') {
          result.hits.push({
            id: item.id,
            category1: outcome.plan.category1,
            category2: outcome.plan.category2,
            approx: outcome.plan.approx,
            level1: outcome.plan.level1,
            ...(deps.decide ? { review: outcome.review } : {})
          })
          // `unverified` = `moved` 的子集：**站方单源搬的条数**（`docs/35 §5.3` 修订）。
          // 它与 `approx` 是同一个角色 —— "这批里有多少条是没被第二源验证过就搬了"。
          // 只在 `plan` 分支累加，因此天然保证 `unverified ≤ moved`（搬失败的不算）。
          if (deps.decide && outcome.confidence === 'medium-s2') result.unverified += 1
        } else if (outcome.kind === 'skip') {
          if (outcome.skip === 'ambiguous') result.ambiguous += 1
          else if (outcome.skip === 'unmapped') result.unmapped += 1
          else result.noStation += 1
        } else if (outcome.kind === 'conflict') {
          result.conflicts += 1
          result.reviews.push({ id: item.id, review: outcome.review })
        } else if (outcome.kind === 'mark') {
          result.marked += 1
          result.reviews.push({ id: item.id, review: outcome.review })
        } else if (outcome.kind === 'untouched' && outcome.unmapped) {
          // 站方给了末级名、面包屑还原不出路径 —— 这是真实的一类，必须计数
          result.unmapped += 1
        }
        // 其余 `untouched`（已定案 / medium-s1 / none）→ 什么都不做：
        // 判定结果与库中现状等价，写回只会白写一次 bulkPut
        tick()
      }
    })
    await Promise.all(workers)

    if (result.stopped) break
    const hasMore = offset + chunkSize < total
    if (hasMore) await sleep(chunkGapMs)
  }

  return result
}

// ── 日志口径（近似条目必须可统计） ──────────────────────────────────

/** 一条重排日志的载荷（store 直接塞进 `reportLog` 的 `context`） */
export interface ZhimoReclassLogContext {
  scanned: number
  moved: number
  /** ⚠️ `moved` 的**子集**：其中"按相近类目归并"的条数（没有这个数字，"猜了多少"就无从统计） */
  approx: number
  /** ⚠️ **恒 0**（老通道语义；交叉验证通道不产生此桶，详见 `ZhimoReclassSummary`） */
  ambiguous: number
  /** 站方给了末级名但还原不出路径（面包屑缺失 / 映射不出来） */
  unmapped: number
  noStation: number
  failed: number
  /** 交叉验证判为 conflict 的条数（进待确认队列，不搬） */
  conflicts: number
  /** ⚠️ `moved` 的**子集**：其中站方单源（`medium-s2`）搬的条数（2026-10-29 修订） */
  unverified: number
  /** true = 本轮被取消（已抓到的仍然落库） */
  cancelled: boolean
  /** true = 手动触发（自动任务静默，只在日志里留痕） */
  manual: boolean
}

/**
 * 汇总一句人可读的日志正文（`reportLog` 的 `message` 固定为 `zhimo:reclass`，
 * 计数放 `context`；这里保留一份文本版本供排查时直接看）。
 *
 * ⚠️ 2026-10-29 后 `unverified` 的口径变了：从"只标记不搬的条数"变成
 * "**moved 里单源搬的那部分**"。所以文案写「其中单源」而不是「未验证」——
 * 它现在修饰的是"移动"这个动作，不是"没动"。
 */
export function zhimoReclassSummaryText(ctx: ZhimoReclassLogContext): string {
  const head = `知末分类重排${ctx.manual ? '（手动）' : ''}${ctx.cancelled ? '（已取消）' : ''}`
  // 存疑 / 单源两个桶**即使为 0 也要出现**：这两行是用户判断"自动搬得靠不靠谱"的唯一入口，
  // 有时省略、无时消失会让同一句话在不同批次里长度不同，反而更难读。
  return (
    `${head}：抓取 ${ctx.scanned} / 移动 ${ctx.moved}` +
    `（其中近似归并 ${ctx.approx}、单源 ${ctx.unverified}）/ 存疑 ${ctx.conflicts}` +
    ` / 未映射 ${ctx.unmapped} / 站方未给 ${ctx.noStation} / 失败 ${ctx.failed}`
  )
}
