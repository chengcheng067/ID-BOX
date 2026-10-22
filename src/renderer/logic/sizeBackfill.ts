/**
 * 贴图尺寸**回填调度**（2026-10「分辨率筛选在材质与 HDR 都失效」的第三棒）。
 *
 * ## 要解决的问题
 *
 * `w/h` 自 0.6.0 才在**导入时**采集，用户库里 950 条老资产一条尺寸都没有 →
 * 分辨率筛选看着像"坏了"。主进程已经给了只读探测通道 `asset:probeSizes`
 * （`main/probeSizes.ts`，读 64KB 头、不解码整图），本模块负责**把它跑起来**：
 * 启动后低优先级补采、**同会话内自续多轮**直到补完（或撞会话上限）、
 * 可中断、可续跑、幂等、失败静默、**不阻塞首帧**。
 *
 * ## 为什么单独一个文件、不进 store.ts
 *
 * store 是全局单点，多人并发改动冲突面极大；回填是"后台只读补采 + 定点写回"，
 * 与 UI 状态没有联动（写库后只做一次**按 id 窄替换**的内存刷新）。放这里还能把
 * 全部依赖做成可注入的，单测零 electron / 零 Dexie / 零真实库。
 *
 * ## 七条硬约束
 *
 * 1. **候选**只认 `jpg/jpeg/png/hdr/exr`：webp/bmp/tif/gif 我们的解析器本来就不认，
 *    放进来会每轮都失败、永久占住队列头；
 * 2. **只补"分辨率有意义"的大类**：`KIND_FILTER_CAPS[kind].resolution === true`
 *    （texture / material / hdri）。model / other 的入场筛选里**没有分辨率入口**，
 *    给它们逐文件读头是纯浪费 —— 模型目录里每个都有 SKP 内嵌预览 + 多张 jpg。
 *    **直接读能力表**，不在这里另写一份 kind 白名单（两套口径迟早漂移）；
 * 3. **轮转**：起点取 `now % 候选总数`（环形），坏资产不会永远堵在前面；
 * 4. **预算**：单轮最多 60 个资产 / 3 秒 / 每个资产最多 200 条 rel（主进程上限）；
 *    一轮补不完就在同会话内**每 4 秒接着跑**（最多 25 轮），不必等用户重启；
 * 5. **写库只动 `files[i].w/h`**：整对象 `put`，其余字段（尤其 `updatedAt`）原样保留
 *    —— 动 `updatedAt` 会牵动排序与缩略图判定；
 * 6. **刷新只刷内存态**：按 id 窄替换 `assets`，不重置筛选 / 选中 / 滚动位置，
 *    失败也不影响已落库的尺寸（Dexie 才是事实）；
 * 7. **single-flight**：同一时刻只跑一轮；会话驱动也只有一条。
 */

import type { Asset, AssetFile } from '../../shared/types'
import type { ProbedImageSize } from '../../shared/imageSize'
import { KIND_FILTER_CAPS } from '../../shared/classify'

/**
 * 允许回填的扩展名（**刻意收窄**，写死五条）。
 *
 * 只收"我们的解析器真能读"的格式：`imageSizeOf` 认 PNG/JPEG，`hdrSizeOf` 认
 * Radiance/EXR。`IMAGE_FILE_EXTS` 里的 webp/bmp/tif/gif 解析器不认 —— 收进来
 * 只会让它们每轮都进候选、每次都探测失败，白白占掉 60 个名额里的位置。
 */
export const SIZE_BACKFILL_EXTS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'hdr', 'exr'])

/** 单轮最多处理的资产数（每个资产一次 IPC） */
export const BACKFILL_MAX_ASSETS = 60

/** 单轮时间预算（毫秒）：到点就停，剩余留给同会话的下一轮 */
export const BACKFILL_BUDGET_MS = 3000

/** 同会话最多自续多少轮（防病态：库异常增长 / probe 永远返回空导致 remaining 不降） */
export const BACKFILL_MAX_ROUNDS = 25

/** 轮与轮之间的空档（毫秒）：刻意留白，别和启动期的缩略图渲染抢 IO */
export const BACKFILL_ROUND_GAP_MS = 4000

/**
 * 单个资产单次探测的 rel 上限。
 * **必须与 `main/probeSizes.ts` 的 `PROBE_SIZES_MAX` 一致**（渲染层不能 import main）；
 * `tests/sizeBackfill.test.ts` 里有断言钉住这两个值，改动时一处忘了另一处会红。
 */
export const BACKFILL_PROBE_LIMIT = 200

// ── 纯函数（全部可单测，不碰 IO） ───────────────────────────────────────

/** 扩展名（可带前导点、大小写不限）是否在回填白名单里 */
export function isBackfillExt(ext: string): boolean {
  return SIZE_BACKFILL_EXTS.has(ext.toLowerCase().replace(/^\./, ''))
}

/** 该文件是否需要（且能被）补尺寸：扩展名命中，且 `w`/`h` 任一缺失 */
export function needsSizeProbe(file: AssetFile): boolean {
  if (!file || !isBackfillExt(file.ext)) return false
  return file.w === undefined || file.h === undefined
}

/**
 * 是否是需要回填的资产：
 * - **大类必须"分辨率有意义"**（`KIND_FILTER_CAPS[kind].resolution`）：model / other 的
 *   入场筛选里没有分辨率入口，补了也没人用，纯浪费逐文件读头（模型目录里每个都有
 *   SKP 内嵌预览 + 多张 jpg）。用能力表而不是本地 kind 白名单，避免两套口径漂移；
 * - 已软删（`deletedAt` 有值）跳过 —— 回收站里的资产不该占补采预算；
 * - `files` 里至少有一个"扩展名命中且缺 w/h"的条目（全都有尺寸 = 已补完）。
 */
export function isBackfillCandidate(asset: Asset): boolean {
  if (!asset || typeof asset.id !== 'string') return false
  if (asset.deletedAt !== undefined && asset.deletedAt !== null) return false
  if (KIND_FILTER_CAPS[asset.kind]?.resolution !== true) return false
  const files = asset.files
  if (!Array.isArray(files) || files.length === 0) return false
  return files.some(needsSizeProbe)
}

/**
 * 环形起点：`now % 总数`。
 *
 * 用时间做偏移而不是持久化游标：零状态、进程重启自动换位，坏资产最多堵住一轮。
 * `now` 由调用方传入（测试可注入固定值）。
 */
export function rotationOffset(total: number, now: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const t = Number.isFinite(now) ? Math.floor(Math.abs(now)) : 0
  return t % total
}

export interface BackfillPlanOptions {
  /** 时间戳（决定环形起点；测试可注入） */
  now: number
  /** 本轮最多取多少个资产（默认 `BACKFILL_MAX_ASSETS`） */
  maxAssets?: number
}

export interface BackfillPlan {
  /** 本轮要处理的资产（从环形起点起，最多 `maxAssets` 条） */
  queue: Asset[]
  /** 候选总数（**未裁剪**，用于算 remaining 与下一轮的模数） */
  total: number
  /** 本轮起点在候选数组里的下标 */
  offset: number
}

/**
 * 规划一轮：先筛候选，再从 `now % total` 处环形切出 `maxAssets` 条。
 *
 * 纯函数 —— 同样的 `assets + now + maxAssets` 必然得到同样的 queue。
 */
export function planBackfill(assets: Asset[], opts: BackfillPlanOptions): BackfillPlan {
  const candidates = (Array.isArray(assets) ? assets : []).filter(isBackfillCandidate)
  const total = candidates.length
  const offset = rotationOffset(total, opts.now)
  const limit = Math.max(0, Math.floor(opts.maxAssets ?? BACKFILL_MAX_ASSETS))
  const queue: Asset[] = []
  for (let i = 0; i < total && queue.length < limit; i += 1) {
    queue.push(candidates[(offset + i) % total])
  }
  return { queue, total, offset }
}

/**
 * 该资产要发给主进程的 rel 列表：只挑"扩展名命中且缺 w/h"的条目，**保序**，
 * 最多 `BACKFILL_PROBE_LIMIT` 条（超出的下一轮再补）。
 */
export function missingSizeRels(asset: Asset): string[] {
  const files = Array.isArray(asset?.files) ? asset.files : []
  const rels: string[] = []
  for (const file of files) {
    if (!needsSizeProbe(file)) continue
    rels.push(file.rel)
    if (rels.length >= BACKFILL_PROBE_LIMIT) break
  }
  return rels
}

/**
 * 把探测结果**只**写进 `files[i].w/h`（返回新对象，不改入参）。
 *
 * - 其余字段（`name` / `id` / `updatedAt` / `thumbPath` / `files` 里其它属性）逐个原样保留；
 * - 一条都没匹配上 / 值本来就相同 → 返回 `null`（调用方据此**不 put**，避免无意义写放大）。
 */
export function withProbedSizes(asset: Asset, probed: ProbedImageSize[]): Asset | null {
  if (!Array.isArray(probed) || probed.length === 0) return null
  const byRel = new Map<string, ProbedImageSize>()
  for (const p of probed) {
    if (p && typeof p.rel === 'string' && p.w > 0 && p.h > 0) byRel.set(p.rel, p)
  }
  if (byRel.size === 0) return null

  let changed = false
  const files = asset.files.map((file) => {
    const hit = byRel.get(file.rel)
    if (!hit) return file
    if (file.w === hit.w && file.h === hit.h) return file
    changed = true
    return { ...file, w: hit.w, h: hit.h }
  })
  if (!changed) return null
  return { ...asset, files }
}

// ── 执行器（依赖可注入；下面两个 default 实现只在真实运行时才求值） ──────

export interface SizeBackfillSummary {
  /** 本轮实际探测过的资产数（每个 = 一次 IPC） */
  scanned: number
  /** 本轮成功写库的资产数（探测没结果 / 值没变化的不算） */
  patched: number
  /** 候选池里本轮**没轮到**的资产数（下一轮从新偏移继续） */
  remaining: number
  /** 本轮耗时（毫秒） */
  elapsedMs: number
}

/** 一条回填日志（`message` 固定前缀便于 grep，`context` 全是数字，落盘前不会被脱敏） */
export interface SizeBackfillLogEvent {
  message: string
  context: Record<string, number>
}

/** 日志出口（默认写 `window.modvault.reportLog`；测试注入数组收集） */
export type SizeBackfillLogger = (ev: SizeBackfillLogEvent) => void

/** 依赖注入面：单测全部替换成内存实现，因此不加载 Dexie / store / electron */
export interface SizeBackfillDeps {
  listAssets?: () => Promise<Asset[]>
  putAsset?: (asset: Asset) => Promise<void>
  probe?: (folder: string, rels: string[]) => Promise<ProbedImageSize[]>
  /** 写库后刷新内存态（默认按 id 窄替换 `useVault.assets`） */
  refreshAssets?: (updated: Asset[]) => void | Promise<void>
  /** 日志出口（默认 `window.modvault.reportLog`，info 级） */
  log?: SizeBackfillLogger
  /** 当前时间（默认 `Date.now`；测试注入固定值以断开真实时钟） */
  now?: () => number
  /** 轮间等待（默认 `setTimeout`；单测用 fake timer 推进） */
  wait?: (ms: number) => Promise<void>
}

/** single-flight 守卫：模块级，同一时刻只允许一轮 */
let inFlight = false

/**
 * 跑一轮回填。
 *
 * @returns 本轮摘要；**若已有一轮在跑则返回 `null`**（不排队、不等待）
 *
 * 绝不 reject：任何失败（读库 / IPC / 写库 / 刷新）都只影响本轮的效果，
 * 不会把启动链路上的 `setTimeout` 回调变成未捕获异常。
 */
export async function runSizeBackfill(
  deps: SizeBackfillDeps = {}
): Promise<SizeBackfillSummary | null> {
  if (inFlight) return null
  inFlight = true

  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  let scanned = 0
  let patched = 0
  let total = 0

  try {
    const assets = await (deps.listAssets ?? defaultListAssets)()
    const plan = planBackfill(assets, { now: startedAt, maxAssets: BACKFILL_MAX_ASSETS })
    total = plan.total

    const probe = deps.probe ?? defaultProbe
    const putAsset = deps.putAsset ?? defaultPutAsset
    const updatedAssets: Asset[] = []

    for (const asset of plan.queue) {
      // 预算按"处理下一个之前"检查：保证至少试一个，不会因为 now() 抖动一个都不跑
      if (now() - startedAt >= BACKFILL_BUDGET_MS) break
      const rels = missingSizeRels(asset)
      if (rels.length === 0) continue
      scanned += 1

      let probed: ProbedImageSize[] = []
      try {
        probed = await probe(asset.folder, rels)
      } catch {
        /* 静默：这一条读不出就跳过，不占预算 */
      }
      const updated = withProbedSizes(asset, probed)
      if (!updated) continue

      try {
        await putAsset(updated)
      } catch {
        continue // 写库失败：不改内存态，下一轮重试
      }
      patched += 1
      updatedAssets.push(updated)
    }

    const summary: SizeBackfillSummary = {
      scanned,
      patched,
      remaining: Math.max(0, total - scanned),
      elapsedMs: Math.max(0, now() - startedAt)
    }

    if (updatedAssets.length > 0) {
      try {
        await (deps.refreshAssets ?? defaultRefreshAssets)(updatedAssets)
      } catch {
        // 这里只是刷新内存态（让界面立刻用上新尺寸）；失败不影响已落库的尺寸，
        // 下次启动 init() 从 Dexie 读到的仍是正确值。
      }
    }

    try {
      ;(deps.log ?? defaultLog)({
        message: '[sizeBackfill] 完成',
        context: {
          scanned: summary.scanned,
          patched: summary.patched,
          remaining: summary.remaining,
          elapsedMs: summary.elapsedMs
        }
      })
    } catch {
      /* 日志失败绝不影响回填 */
    }
    return summary
  } catch {
    // 读库失败等意外情况：静默收场，绝不向启动链路抛异常
    return { scanned, patched, remaining: Math.max(0, total - scanned), elapsedMs: Math.max(0, now() - startedAt) }
  } finally {
    inFlight = false
  }
}

/** 仅供测试：单飞守卫的当前状态（生产代码不需要读它） */
export function sizeBackfillInFlight(): boolean {
  return inFlight
}

// ── 同会话自续驱动（startSizeBackfill） ─────────────────────────────────

/** 一次**会话**（= 一次启动）的累计结果 */
export interface SizeBackfillRunSummary {
  /** 实际跑满的轮数 */
  rounds: number
  /** 累计探测过的资产数 */
  scanned: number
  /** 累计写库的资产数 */
  patched: number
  /** **最后一轮**结束时仍未轮到的候选数（0 = 全补完） */
  remaining: number
  /** 会话总耗时（毫秒，含轮间空档） */
  elapsedMs: number
}

/** 会话级单飞守卫：`main.tsx` 重复触发 / 热重载都不会跑出两条链 */
let sessionInFlight = false

/** 默认轮间等待：真实 `setTimeout`（单测用 `vi.useFakeTimers()` 推进） */
function defaultWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 启动回填会话：**一轮补不完就自己接着跑**。
 *
 * 为什么必须自续：用户库 950 条、每轮 60 条 —— 只跑一轮就要重启 16 次才补完，
 * 而用户不会重启 16 次，等于筛选器长期不可用。
 *
 * - 每轮之间等 `BACKFILL_ROUND_GAP_MS`（4 秒）：不和启动期的缩略图渲染抢 IO；
 * - `remaining === 0` → 打一条 `[sizeBackfill] 全部补完`（含累计 patched 与总耗时）后停；
 * - 跑满 `BACKFILL_MAX_ROUNDS`（25 轮）仍未补完 → 打 `[sizeBackfill] 到达会话上限`
 *   （防病态：库异常增长 / probe 永远返回空导致 remaining 不降），下次启动继续；
 * - 全程不抛错（`void startSizeBackfill()` 在启动链路里，绝不能变成未捕获异常）。
 *
 * @returns 会话摘要；**若已有一条会话在跑则返回 `null`**
 */
export async function startSizeBackfill(
  deps: SizeBackfillDeps = {}
): Promise<SizeBackfillRunSummary | null> {
  if (sessionInFlight) return null
  sessionInFlight = true

  const now = deps.now ?? (() => Date.now())
  const wait = deps.wait ?? defaultWait
  const startedAt = now()
  let rounds = 0
  let scanned = 0
  let patched = 0
  let remaining = 0

  try {
    try {
      while (rounds < BACKFILL_MAX_ROUNDS) {
        const round = await runSizeBackfill(deps)
        // null = 已有别的轮次在跑（或依赖未就绪）：让位，别再排下一轮
        if (!round) break
        rounds += 1
        scanned += round.scanned
        patched += round.patched
        remaining = round.remaining
        if (remaining === 0) break
        await wait(BACKFILL_ROUND_GAP_MS)
      }
    } catch {
      // 轮间等待被拒 / 依赖抛错：带着已有进度收场
    }

    const summary: SizeBackfillRunSummary = {
      rounds,
      scanned,
      patched,
      remaining,
      elapsedMs: Math.max(0, now() - startedAt)
    }

    const log = deps.log ?? defaultLog
    try {
      if (remaining === 0 && rounds > 0) {
        log({
          message: '[sizeBackfill] 全部补完',
          context: { rounds, scanned, patched, elapsedMs: summary.elapsedMs }
        })
      } else if (remaining > 0 && rounds >= BACKFILL_MAX_ROUNDS) {
        log({ message: '[sizeBackfill] 到达会话上限', context: { rounds, remaining } })
      }
    } catch {
      /* 日志失败绝不影响启动链路 */
    }

    return summary
  } finally {
    sessionInFlight = false
  }
}

/** 仅供测试：会话单飞守卫的当前状态 */
export function sizeBackfillSessionInFlight(): boolean {
  return sessionInFlight
}

// ── 默认实现（动态 import：单测注入 deps 后永远不会走到这里） ────────────

async function defaultListAssets(): Promise<Asset[]> {
  const { db } = await import('../db')
  return db.assets.toArray()
}

async function defaultPutAsset(asset: Asset): Promise<void> {
  const { db } = await import('../db')
  await db.assets.put(asset)
}

function defaultProbe(folder: string, rels: string[]): Promise<ProbedImageSize[]> {
  const bridge = (globalThis as { modvault?: { probeSizes?: (f: string, r: string[]) => Promise<ProbedImageSize[]> } })
    .modvault
  if (!bridge?.probeSizes) return Promise.resolve([]) // 老 preload / 非 Electron：静默降级
  return bridge.probeSizes(folder, rels).catch(() => [])
}

/**
 * 默认的内存态刷新：**按 id 窄替换**，不换数组顺序、不碰筛选/选中/滚动。
 *
 * 与 `store.ts:3473`（ensureMissingThumbs 写回缩略图）同一手法：`setState` 只替换
 * `assets` 一个字段，zustand 是浅合并，其余状态原样保留。
 */
async function defaultRefreshAssets(updated: Asset[]): Promise<void> {
  const { useVault } = await import('../store')
  const byId = new Map(updated.map((a) => [a.id, a]))
  const state = useVault.getState()
  useVault.setState({ assets: state.assets.map((a) => byId.get(a.id) ?? a) })
}

function defaultLog(ev: SizeBackfillLogEvent): void {
  const payload = { level: 'info' as const, message: ev.message, context: ev.context }
  const bridge = (globalThis as { modvault?: { reportLog?: (p: typeof payload) => void } }).modvault
  bridge?.reportLog?.(payload)
}
