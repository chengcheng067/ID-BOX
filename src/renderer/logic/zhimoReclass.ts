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

import type { Asset, AssetKind, FetchZhimoMetaResult } from '../../shared/types'
import { zhimoIdOf } from '../../shared/naming'
import { isLevel1Only, mapZhimoCategory, type ZhimoLookupTarget } from '../../shared/zhimoTaxonomyMap'
import { UNCLASSIFIED } from '../../shared/taxonomy'
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

// ── 按分类对分组 ────────────────────────────────────────────────────

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
}

/** 一条命中（已抓完、判定完成，等 store 备份 + 落地） */
export interface ZhimoReclassHit {
  id: string
  category1: string
  category2: string
  approx: boolean
  level1: boolean
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
    stopped: false
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

        const decision = planZhimoReclass({ meta, kind: item.kind, name: item.name })
        if (isZhimoReclassSkip(decision)) {
          if (decision.skip === 'ambiguous') result.ambiguous += 1
          else if (decision.skip === 'unmapped') result.unmapped += 1
          else result.noStation += 1
        } else {
          result.hits.push({
            id: item.id,
            category1: decision.category1,
            category2: decision.category2,
            approx: decision.approx,
            level1: decision.level1
          })
        }
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
  ambiguous: number
  unmapped: number
  noStation: number
  failed: number
  /** true = 本轮被取消（已抓到的仍然落库） */
  cancelled: boolean
  /** true = 手动触发（自动任务静默，只在日志里留痕） */
  manual: boolean
}

/**
 * 汇总一句人可读的日志正文（`reportLog` 的 `message` 固定为 `zhimo:reclass`，
 * 计数放 `context`；这里保留一份文本版本供排查时直接看）。
 */
export function zhimoReclassSummaryText(ctx: ZhimoReclassLogContext): string {
  const head = `知末分类重排${ctx.manual ? '（手动）' : ''}${ctx.cancelled ? '（已取消）' : ''}`
  return (
    `${head}：抓取 ${ctx.scanned} / 移动 ${ctx.moved}` +
    `（其中近似归并 ${ctx.approx}）/ 多候选 ${ctx.ambiguous} / 未映射 ${ctx.unmapped}` +
    ` / 站方未给 ${ctx.noStation} / 失败 ${ctx.failed}`
  )
}
