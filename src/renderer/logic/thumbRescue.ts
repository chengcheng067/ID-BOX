/**
 * 缩略图**数据救援**（2026-10-23 rescan 事故的通用修复）——纯逻辑 + 一个可注入的
 * 执行器，**零 electron / 零 Dexie / 零 DOM**，可在 vitest node 环境直测。
 *
 * ## 事故与目标
 *
 * 一次 rescan 把 143 条记录里的 38 条 `thumbPath` 抹成了空（图片文件其实还在
 * `<userData>/thumbs/` 里），并把用户调好的 `renderParams`（UV=3.10）打回默认。
 * 硬编码 id 对照表只能救这一台机器；所以这里做成**通用规则**：
 *
 * > 磁盘上存在 `<id>-<8hex>.(jpg|png)`，而记录里 `thumbPath` 为空 → 挂回去。
 *
 * 任何一次同类损伤都能自愈，不需要迁移标记（谓词在修复完成后自然为假 = 天然幂等）。
 *
 * ## 四条硬纪律（改这里之前先读）
 *
 * ① **有图的绝不碰**：只处理 `!thumbPath || thumbStatus !== 'ready'` 的记录。
 *    已经能显示的记录一旦被改写，就是拿"能看"换"可能更好"，毫无必要。
 * ② **绝不覆盖用户的参数**：`RENDER_PARAMS_RESTORE` 只在记录当前没有任何
 *    `renderParams` 时才写（用户事后重调过的值优先级最高）。
 * ③ **只写两个字段**：`thumbPath` / `thumbStatus`。用 `.modify()` 定向更新，
 *    不要整对象 `put`——那会把并发期间别人（尺寸回填 / 分类 / 封面）写入的字段
 *    用旧快照覆盖回去（与 `sizeBackfill` 同一条纪律）。
 * ④ **改动前先快照**：原记录整条塞进 `db.backups`（id `rescue-<ts>`），与
 *    `backupRescanDeletions` 同构，天然可回退。
 *
 * ## 为什么"最新那个候选"就够
 *
 * 同一 id 的多个缓存文件只可能来自"同一资产的不同 cover salt / 不同参数"。
 * 取 `mtimeMs` 最大 = 用户最后看到的那一张。真要让"球图/封面图"语义更精确，
 * 需要 `effectiveMaterialSlots`（会随 albedo 修复而变），不属于这一层的职责——
 * 这里保证的是"挂一张属于本资产的、最新的、没坏的文件"。
 */

import { parseThumbFileName } from '../../shared/thumb'
import {
  DEFAULT_PARAM_SCALES,
  normalizeParams,
  type BallParamScales,
  type NormalizedBallParams
} from '../../shared/ballParams'
import type { ThumbFileEntry, ThumbStatus } from '../../shared/types'

/** 单次救援的上限（防病态库一次改几千条把启动拖住；正常事故只会是个位数~几十条） */
export const THUMB_RESCUE_LIMIT = 200

/** `db.backups` 里救援快照的 id 前缀（与 `rescan-*` / `reclass-*` 并列） */
export const THUMB_RESCUE_SNAPSHOT_PREFIX = 'rescue-'

/** 救援只看这几个字段——刻意不要求完整 `Asset`，测试与调用方都不用造大对象 */
export interface ThumbRescueAsset {
  id: string
  thumbPath?: string
  thumbStatus?: ThumbStatus
  /** 软删记录不救援：它们在 `.trash/` 里，恢复后反而会让回收站条目"有图"而误导用户 */
  deletedAt?: number
}

/** 一条救援计划：把 `assetId` 的缩略图指向 `thumbPath` */
export interface ThumbRescuePlanItem {
  assetId: string
  /** 纯文件名（`<id>-<8hex>.(jpg|png)`，来自 `thumb:list`） */
  thumbPath: string
  /** 该文件最后修改时间（多候选取最新的判据，也便于日志核对） */
  mtimeMs: number
  /** 该 id 在盘上一共有几个候选（>1 说明发生过 cover salt / 参数变化） */
  candidates: number
}

export interface PlanThumbRescueOptions {
  /** 覆盖上限（默认 {@link THUMB_RESCUE_LIMIT}） */
  limit?: number
}

/**
 * 纯函数：算出「哪些记录的 `thumbPath` 可以按盘上文件挂回」。
 *
 * 入参 `files` 就是 `thumb:list` 的返回（`name` / `size` / `mtimeMs`）；
 * 不传 `files` 或为空数组 → 恒返回空计划（调用方的空跑保护之一）。
 *
 * 匹配规则（每一条都有测试钉住）：
 * - 文件名必须能按缩略图格式解析（`^(.+)-([0-9a-f]+)\.(jpg|png)$`，大小写不敏感）；
 * - 解析出的 **id 必须与 `asset.id` 完全相等**（`abc` 不匹配 `abcd-1234abcd.png`
 *   —— 前缀包含是历史 bug 的高发点，截图/临时文件常常带尾巴）；
 * - 同一 id 多个候选：`mtimeMs` 最大者胜；`mtimeMs` 相同则 `.png` 优先
 *   （球图/透明图信息量更高），再相同按文件名降序（保证结果确定、可断言）；
 * - `size <= 0` 的文件一律跳过（0 字节通常是写盘被打断的残骸，挂上去就是灰格）；
 * - 记录侧：`deletedAt` 有值 → 跳过；已有可用缩略图 → 跳过。
 *
 * 输出顺序与 `assets` 顺序一致（可预测，便于日志与断言）。
 */
export function planThumbRescue(
  assets: readonly ThumbRescueAsset[],
  files: readonly ThumbFileEntry[],
  opts: PlanThumbRescueOptions = {}
): ThumbRescuePlanItem[] {
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0
    ? Math.floor(opts.limit as number)
    : THUMB_RESCUE_LIMIT
  if (assets.length === 0 || files.length === 0) return []

  // name → 解析结果只算一次；同 id 的候选聚在一起（按 id 完全相等，不做前缀匹配）
  const byId = new Map<string, Array<{ name: string; ext: string; size: number; mtimeMs: number }>>()
  for (const f of files) {
    const parsed = parseThumbFileName(f?.name ?? '')
    if (!parsed) continue
    if (!Number.isFinite(f?.size) || f.size <= 0) continue
    const mtimeMs = Number.isFinite(f?.mtimeMs) ? f.mtimeMs : 0
    const list = byId.get(parsed.id)
    const entry = { name: f.name, ext: parsed.ext, size: f.size, mtimeMs }
    if (list) list.push(entry)
    else byId.set(parsed.id, [entry])
  }

  const plan: ThumbRescuePlanItem[] = []
  const seen = new Set<string>()
  for (const asset of assets) {
    if (plan.length >= limit) break
    const id = typeof asset?.id === 'string' ? asset.id : ''
    if (id.length === 0) continue
    if (seen.has(id)) continue
    // ① 已有可用缩略图 → 绝不碰
    if (asset.thumbPath && asset.thumbStatus === 'ready') continue
    // ② 软删记录不救援
    if (typeof asset.deletedAt === 'number') continue
    const list = byId.get(id)
    if (!list || list.length === 0) continue
    const best = [...list].sort(compareCandidates)[0]
    if (!best) continue
    seen.add(id)
    plan.push({
      assetId: id,
      thumbPath: best.name,
      mtimeMs: best.mtimeMs,
      candidates: list.length
    })
  }
  return plan
}

/** 候选排序：mtime 降序 → png 优先 → 文件名降序（完全确定，避免同 mtime 抖动） */
function compareCandidates(
  a: { name: string; ext: string; mtimeMs: number },
  b: { name: string; ext: string; mtimeMs: number }
): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  const ap = a.ext === 'png' ? 0 : 1
  const bp = b.ext === 'png' ? 0 : 1
  if (ap !== bp) return ap - bp
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
}

/** 执行器依赖（**注入式**：本文件不 import Dexie，单测可完全离线） */
export interface ThumbRescueDeps {
  /** 读原记录（快照用）。返回条数少于计划条数 = 期间被删，跳过即可 */
  loadAssets: (ids: readonly string[]) => Promise<ThumbRescueAsset[]>
  /** 写一条快照进 `db.backups`（`{ id, at, json }`） */
  saveSnapshot: (snapshot: { id: string; at: number; json: string }) => Promise<void>
  /**
   * 定向更新一条记录，**只允许写 `thumbPath` + `thumbStatus='ready'`**。
   * 实现侧必须用 `where('id').equals(id).modify()`（不要整对象 put），
   * 并在回调里再判一次"当前仍为空"——并发期间别的流程可能已经补上了图。
   * 抛错视为该条失败（不中断整批）。
   */
  updateThumb: (assetId: string, thumbPath: string, at: number) => Promise<void>
  /** 时间源（默认 `Date.now`，测试可注入固定值） */
  now?: () => number
}

export interface ThumbRescueResult {
  /** 写入 `db.backups` 的快照 id；没做任何改动时为 null */
  snapshotId: string | null
  /** 实际写回的条数 */
  applied: number
  /** 单条失败 / 记录已消失而跳过的条数 */
  skipped: number
}

/**
 * 执行救援计划：**先快照、再逐条定向更新**。
 *
 * 空跑保护：`plan` 为空时**不读库、不写快照、不改任何记录**（直接返回）——
 * 每次启动都会调用它，正常情况下必须零成本。
 *
 * 失败策略：单条 `updateThumb` 抛错只计入 `skipped` 并继续下一条。
 * 一条坏记录不应该让另外 36 条继续坏着。
 *
 * 幂等：写入值来自盘上真实文件，重复执行结果完全一致；且调用方每次都用
 * 当前状态重新生成计划，已挂回的记录不会再进计划。
 */
export async function applyThumbRescue(
  plan: readonly ThumbRescuePlanItem[],
  deps: ThumbRescueDeps
): Promise<ThumbRescueResult> {
  if (plan.length === 0) return { snapshotId: null, applied: 0, skipped: 0 }
  const now = deps.now ?? (() => Date.now())
  const at = now()
  const ids = plan.map((p) => p.assetId)

  // ① 快照：只存"将被改动"的原记录（与 backupRescanDeletions 同构）
  const original = await deps.loadAssets(ids)
  if (original.length === 0) return { snapshotId: null, applied: 0, skipped: plan.length }
  const snapshotId = `${THUMB_RESCUE_SNAPSHOT_PREFIX}${at}`
  await deps.saveSnapshot({ id: snapshotId, at, json: JSON.stringify(original) })

  // ② 逐条定向更新
  let applied = 0
  let skipped = 0
  const live = new Set(original.map((a) => a.id))
  for (const item of plan) {
    if (!live.has(item.assetId)) {
      skipped += 1 // 计划生成后记录被删 / 被还原
      continue
    }
    try {
      await deps.updateThumb(item.assetId, item.thumbPath, at)
      applied += 1
    } catch {
      skipped += 1
    }
  }
  return { snapshotId, applied, skipped }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一次性参数恢复（**明确标注的例外**，不是通用机制）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 2026-10-23 事故：rescan 把 `renderParams` 抹成空。
 *
 * 值取自 LevelDB 历史日志（该资产 01:59–02:00 连续 5 次落库，最后一次 `uv = 3.10`），
 * 并已用文件名反算验证：
 * `ballThumbName(id, <固定槽位>, {uv:3.1}, 'sphere')` 的 hash **恰好等于**
 * 盘上那张 `…-e94039c0.png`（`tests/thumbRescue.test.ts` 用固定槽位 fixture 钉死）。
 *
 * ⚠️ 只存**部分字段**：事故时用户只动过 UV，其余全部是默认值。
 * 写入前用 {@link restoreParamsFor} 补齐成完整结构（六个字段全就位），
 * 否则下游读到 `undefined` 会算出另一个 hash。
 *
 * ⚠️ 这张表**只服务于这一次事故**。后续同类损伤请走通用机制（`planThumbRescue`），
 * 不要往里加条目——加条目就等于把"一次性救援"变成永久补丁。
 */
export const RENDER_PARAMS_RESTORE: ReadonlyArray<{
  id: string
  params: Partial<BallParamScales>
}> = [
  // 新中式复古仿古砖（UV=3.10，其余默认）
  { id: '5e4c3050-e057-4681-a70a-cb277890c309', params: { uv: 3.1 } }
]

/** 把"部分参数"补齐成完整结构（缺省项取 `DEFAULT_PARAM_SCALES`，再整体规范化） */
export function restoreParamsFor(entry: { params: Partial<BallParamScales> }): NormalizedBallParams {
  return normalizeParams({ ...DEFAULT_PARAM_SCALES, ...entry.params })
}

export interface RenderParamsRestoreItem {
  assetId: string
  params: NormalizedBallParams
}

/**
 * 纯函数：算出"哪些记录可以恢复参数"。
 *
 * 判据只有一条：**当前 `renderParams` 为空**（`undefined` / `null` / 无键对象）。
 * 用户事后重新调过的值优先级最高，任何情况下都不覆盖——这也是本函数与
 * `applyThumbRescue` 一样天然幂等的原因（写完就不再命中）。
 */
export function planRenderParamsRestore(
  assets: ReadonlyArray<{ id: string; renderParams?: unknown; deletedAt?: number }>
): RenderParamsRestoreItem[] {
  if (assets.length === 0) return []
  const byId = new Map(RENDER_PARAMS_RESTORE.map((e) => [e.id, e]))
  const out: RenderParamsRestoreItem[] = []
  for (const asset of assets) {
    const entry = byId.get(asset?.id ?? '')
    if (!entry) continue
    if (typeof asset.deletedAt === 'number') continue
    if (!isEmptyParams(asset.renderParams)) continue
    out.push({ assetId: asset.id, params: restoreParamsFor(entry) })
  }
  return out
}

/** `undefined` / `null` / `{}` 都算"没有参数"；有任何一个键就算用户设置过 */
function isEmptyParams(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v !== 'object') return true
  return Object.keys(v as Record<string, unknown>).length === 0
}
