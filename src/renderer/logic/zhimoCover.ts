/**
 * 知末封面的**渲染层纯逻辑**（docs/24 §3.6，T-04）。
 *
 * 两件事，都不碰真实网络 / DB（依赖全部注入，可纯单测）：
 * ① `pickZhimoCoverTargets()` —— 谁能抓（kind / ID / 封面优先级 / 开关）；
 * ② `runZhimoCoverQueue()` —— 怎么抓（小并发 + 间隔 + 分块 + 可中止）。
 *
 * 为什么不放进 store：store 里已经有 2000+ 行、且每个 action 都要摸 `window.modvault`
 * 与 Dexie。把"选谁/怎么排队"抽成纯函数，才能用表驱动把 `replacePacked × coverSource`
 * 这类矩阵一次钉死（见 `tests/zhimoCoverStore.test.ts`）。
 *
 * ── 封面优先级的唯一口径（docs/24 §3.5 口径 #9）─────────────────────
 * ```
 * manual > zhimo > embedded > named/root/largest > placeholder
 * ```
 * - `manual` / `zhimo`：已经有"抓来的/指定的"封面 → 自动任务**不再碰**
 *   （手动按钮走 `force`，永远替换）；
 * - `embedded` / `placeholder` / `undefined`：包内图要么是 SKP 内嵌灰图、要么根本没有
 *   → 一律可抓（这正是本功能的主场景）；
 * - `named` / `root` / `largest`：包内自带的**成品图** → 由 `replacePacked` 决定：
 *   默认 `true`（知末的 400×300 无水印渲染图通常比包内杂图更准），
 *   用户关掉后保留包内图（`M10` 验收点）。
 */

import type { Asset, FetchZhimoCoverResult, ZhimoCoverFailReason } from '../../shared/types'
import { zhimoIdOf } from '../../shared/naming'

/** 单批最多抓多少个（docs/24 口径 #7：单批上限 50，超出留给下一批） */
export const ZHIMO_COVER_MAX_BATCH = 50

/** 默认并发（口径 #7：并发 ≤3；取 2 更保守，站点限流时不容易 403） */
export const ZHIMO_COVER_CONCURRENCY = 2

/** 默认请求间隔（口径 #7：间隔 ≥250ms） */
export const ZHIMO_COVER_GAP_MS = 250

/** 默认分块大小 / 块间间隔（大批量导入时给站点一个喘息窗口） */
export const ZHIMO_COVER_CHUNK_SIZE = 50
export const ZHIMO_COVER_CHUNK_GAP_MS = 2000

/** 一个待抓目标：资产 id + 知末 ID（优先 `asset.zhimoId`，为空再按名字解析） */
export interface ZhimoCoverTarget {
  id: string
  zhimoId: string
}

export interface PickZhimoCoverOptions {
  /** `settings.zhimoCoverReplacePacked`：包内已有预览图（named/root/largest）时是否也替换 */
  replacePacked: boolean
  /** 只考虑这些资产 id（自动任务用导入批次收集的清单）；`undefined` = 全库 */
  ids?: string[]
  /** 单批上限，默认 `ZHIMO_COVER_MAX_BATCH` */
  limit?: number
  /**
   * 手动路径：绕过「已有 manual/zhimo 封面」与 `replacePacked` 两道过滤。
   * ⚠️ 只跳过这两道 —— `kind === 'model'` 与「能取到 ID（`asset.zhimoId` 优先，
   * 回退名字解析）」是硬前提，`force` 也不放宽。
   */
  force?: boolean
}

/**
 * 选出本次要抓的资产（**顺序 = 入参顺序**，便于"先导入先抓"）。
 *
 * 五道过滤（顺序无关，都是 AND）：
 * ① `kind === 'model'` —— 材质/贴图不做（本地 `.cover.jpg` 就是 1K 级贴图本体）；
 * ② 能取到知末 ID：**优先 `asset.zhimoId`**（导入时从压缩包名/资产名/包内文件名算好落库），
 *    为空再退回 `zhimoIdOf(asset.name)`；
 * ③ `coverSource ∈ {manual, zhimo}` 跳过（`force` 时跳过本道）；
 * ④ `!replacePacked` 时排除 `coverSource ∈ {named, root, largest}`（`force` 时跳过本道）；
 * ⑤ `ids` 白名单（传了才生效；空数组 = 一个都不选）；
 * 最后按 `limit` 截断。
 */
export function pickZhimoCoverTargets(
  assets: Asset[],
  opts: PickZhimoCoverOptions
): ZhimoCoverTarget[] {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit as number)) : ZHIMO_COVER_MAX_BATCH
  if (limit === 0) return []

  // 传了 ids 才做白名单：空数组必须等价于"没有候选"，不能退化成"全库"
  const wanted = opts.ids === undefined ? null : new Set(opts.ids)
  if (wanted && wanted.size === 0) return []

  const out: ZhimoCoverTarget[] = []
  for (const asset of assets) {
    if (out.length >= limit) break
    if (asset.kind !== 'model') continue
    if (wanted && !wanted.has(asset.id)) continue

    // 知末 ID（0.6.3）：优先用**落库时算好的** `asset.zhimoId` —— 知末有大量包只在
    // **压缩包名**上带 ID（`现代壁灯ID_1232108421.rar` 解包后是
    // `attachment_1786942463670\现代壁灯\现代壁灯.skp`，资产名与包内文件名零 ID 痕迹），
    // 只看 `asset.name` 会让这类资产**永远**抓不到封面。空串/缺省时退回名字解析。
    const storedId = typeof asset.zhimoId === 'string' ? asset.zhimoId.trim() : ''
    const zhimoId = storedId || zhimoIdOf(asset.name)
    if (!zhimoId) continue

    const source = asset.coverSource
    if (!opts.force) {
      // ③ 已经是"抓来的/指定的"封面：自动任务不覆盖
      if (source === 'manual' || source === 'zhimo') continue
      // ④ 包内自带成品图：由子开关决定是否替换
      if (!opts.replacePacked && (source === 'named' || source === 'root' || source === 'largest')) {
        continue
      }
    }

    out.push({ id: asset.id, zhimoId })
  }
  return out
}

// ── 队列 ────────────────────────────────────────────────────────────────

export interface ZhimoCoverQueueResult {
  /** 抓取成功（落盘成功）的条数 */
  ok: number
  /** 失败条数（任何 reason） */
  failed: number
  /**
   * 进锁后重查发现「该资产已被用户接管」而**主动跳过**的条数（DEF-Z8）。
   *
   * 与 `failed` 分开：跳过不是失败（没有任何请求发出，也不该出现在错误统计里），
   * 但必须可观测 —— 否则"自动任务为什么少抓了几个"永远查不清。
   */
  skipped: number
  /** true = 被 `shouldStop()` 叫停，剩余条目**没有抓**（既不记 ok 也不记 failed） */
  stopped: boolean
}

/**
 * 单项的"跳过"结果（不是失败）。
 *
 * `fetchOne` 在**拿到锁之后、写盘之前**重查资产状态：用户可能在这段时间里
 * 手动设了封面 —— 那就不能再写盘（`writeCoverImageInto` 会删掉同族文件，
 * 正是 DEF-Z8 方向 2 的成因）。
 */
export interface ZhimoCoverSkip {
  skipped: true
  /** `manual` = 用户手工封面；`zhimo` = 别人刚抓过（非 force 时） */
  reason: 'manual' | 'zhimo'
}

/** `fetchOne` 的返回：正常结果，或"主动跳过" */
export type ZhimoCoverItemOutcome = FetchZhimoCoverResult | ZhimoCoverSkip

export interface ZhimoCoverQueueDeps {
  /**
   * 抓一个（已注入：`runZhimoCoverQueue` 自己不做任何 IPC / 网络）。
   *
   * ⚠️ 调用方要保证「写文件 + 写索引」在**同一个**资产锁内完成（`withAssetCoverLock`）；
   * 队列只负责"什么时候调"，不负责并发安全（那是 store 的写入事务粒度问题）。
   */
  fetchOne: (item: ZhimoCoverTarget) => Promise<ZhimoCoverItemOutcome>
  /** 每抓完一个的回调（用于**逐个**写库，卡片逐张变化）；抛错不会中断队列 */
  onEach?: (item: ZhimoCoverTarget, res: FetchZhimoCoverResult) => Promise<void> | void
  /** 间隔用；测试注入即时桩（默认真实 `setTimeout`） */
  sleep?: (ms: number) => Promise<void>
  /** 每轮开始前检查（窗口关闭 / 用户关开关时立刻停） */
  shouldStop?: () => boolean
  concurrency?: number
  gapMs?: number
  chunkSize?: number
  chunkGapMs?: number
}

/** 默认 sleep（不能用 `requestIdleCallback`：这是节流，不是让路） */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 跑一批抓取：**小并发 + 请求间隔 + 分块**，可随时叫停。
 *
 * 三条纪律（docs/24 §4.3）：
 * ① 请求间隔 ≥ `gapMs`（全局闸门，跨 worker 共享）——站点对连续请求敏感；
 * ② 每 `chunkSize` 条之间停 `chunkGapMs`——大批量导入时不至于让站点判定为爬虫；
 * ③ `shouldStop()` 在**取任务前**与**发请求前**各查一次（间隔等待期间被叫停也能立刻生效）。
 *
 * 失败语义：`fetchOne` 抛错按 `failed` 计（不让一个异常打断整批），
 * `onEach` 抛错**只影响该条**（计数已按抓取结果算过），队列继续。
 * 本函数**永不抛错**。
 */
export async function runZhimoCoverQueue(
  items: ZhimoCoverTarget[],
  deps: ZhimoCoverQueueDeps
): Promise<ZhimoCoverQueueResult> {
  const sleep = deps.sleep ?? realSleep
  const concurrency = Math.max(1, deps.concurrency ?? ZHIMO_COVER_CONCURRENCY)
  const gapMs = Math.max(0, deps.gapMs ?? ZHIMO_COVER_GAP_MS)
  const chunkSize = Math.max(1, deps.chunkSize ?? ZHIMO_COVER_CHUNK_SIZE)
  const chunkGapMs = Math.max(0, deps.chunkGapMs ?? ZHIMO_COVER_CHUNK_GAP_MS)

  const result: ZhimoCoverQueueResult = { ok: 0, failed: 0, skipped: 0, stopped: false }
  if (items.length === 0) return result

  /**
   * 全局节流闸门：保证**任意两次请求的起始**之间至少间隔 `gapMs`。
   *
   * 用"已发请求数"而不是真实时钟差来判定：注入的 `sleep` 桩可能瞬时返回，
   * 真实时钟几乎不动 —— 用时钟差会让第二发算出 250ms 的等待（等到的还是桩），
   * 语义正确但难断言；用计数则"每发一次就等一次"，`sleep` 的调用序列即节流证据。
   */
  let started = 0
  const passGate = async (): Promise<void> => {
    if (started > 0 && gapMs > 0) await sleep(gapMs)
    started += 1
  }

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    if (result.stopped || deps.shouldStop?.()) {
      result.stopped = true
      break
    }
    const chunk = items.slice(offset, offset + chunkSize)

    // 块内游标 + N 个 worker（并发度受 chunk 长度限制，避免空转 worker）
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
        const item = chunk[index]

        await passGate()
        // 间隔等待期间可能被叫停（关窗口 / 用户关开关）→ 不再发这一发
        if (deps.shouldStop?.()) {
          result.stopped = true
          return
        }

        let out: ZhimoCoverItemOutcome
        try {
          out = await deps.fetchOne(item)
        } catch {
          // 注入的 fetchOne 抛错（IPC 异常）：按失败计，绝不中断队列
          out = { ok: false, reason: 'network' }
        }
        // 进锁后重查判出的"跳过"：没有发请求、也没写盘，单列计数（DEF-Z8）
        if ('skipped' in out) {
          result.skipped += 1
          continue
        }
        const res = out
        if (res.ok) result.ok += 1
        else result.failed += 1

        if (deps.onEach) {
          try {
            await deps.onEach(item, res)
          } catch {
            // 写库失败不能让后面的资产不再抓（封面是锦上添花，不是关键路径）
          }
        }
      }
    })
    await Promise.all(workers)

    if (result.stopped) break
    const hasMore = offset + chunkSize < items.length
    if (hasMore) await sleep(chunkGapMs)
  }

  return result
}

// ── 文案（主进程 reason → 用户可读的一句话） ─────────────────────────

/**
 * 失败原因 → 用户可读文案（**手动按钮**才用；自动任务全程静默，不弹任何东西）。
 *
 * 必须能区分"这个 ID 没了"与"网络抖了"——否则用户只会得到一句"失败"，
 * 既不知道要不要重试，也不知道是不是自己 ID 抄错了。
 */
export function zhimoCoverFailText(reason: ZhimoCoverFailReason | undefined): string {
  switch (reason) {
    case 'no-id':
      return '资产名里没有知末 ID，无法从知末取封面'
    case 'not-found':
      return '知末上没有这个 ID 的页面（可能已下架）'
    case 'no-image':
      return '知末页面在，但取不到无水印主图'
    case 'timeout':
      // 主进程已经对瞬时失败做过「初次 + 1 次重试」（见 main/zhimoCover.ts），
      // 走到这里的 timeout = **重试后仍超时** → 文案直接告诉用户"可稍后重试"，
      // 与 not-found（ID 不存在，再点也没用）区分开。
      return '网络超时，可稍后重试（已自动重试 1 次）'
    case 'network':
      return '网络连接失败，可稍后重试（已自动重试 1 次）'
    case 'bad-url':
      return '知末返回的图片地址异常，已拒绝下载'
    case 'bad-image':
      return '知末返回的不是有效图片'
    case 'too-small':
      return '知末返回的图片太小，已跳过'
    case 'write-failed':
      return '封面写入失败（资产目录不可写）'
    default:
      return '从知末取封面失败'
  }
}
