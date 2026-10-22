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
 * ## 六条硬纪律（改这里之前先读）
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
 * ⑤ **本模块禁止调用 `ballThumbName` / `ballHash`，禁止把 rev 纳入任何判据**
 *    （team-lead 2026-10 裁定，理由照抄，别改）：
 *    救援要回答的只有一个是非——「这条记录现在没图，盘上有没有一个**属于这个 id**
 *    的缩略图文件？」这只需要 `<id>-<8hex>.(png|jpg)` 的形状校验 + **id 前缀逐字符
 *    相等**，与 rev、slots、params 全都无关。
 *    一旦引入"期望名比对"，救援就变成"渲染器版本的马前卒"：以后每升一次 rev
 *    （`RENDER_REV` 3→4 就是这么一次），救援都会把**健康记录**判成不健康 → 正好
 *    产生它本该避免的反效果。所以从设计上断掉。
 *    挂回来的图是旧 rev 的，`ballThumbIsFresh` 必然 false → **惰性升级**会在它被看见
 *    时重渲一次。**这个"不自洽"是特征，不是缺陷**：先让用户立刻有图，再悄悄换成新观感。
 *    ⇒ 也不要为了"更严格"而新增 `ballHashAtRev` 之类的历史 rev 入口：那种入口迟早
 *    会被某处误用来**回写文件名**。`shared/ballParams.ts` 永远只有一个真源 `RENDER_REV`。
 *
 * ⑥ **`manual` / `named` 封面的资产不进救援**（team-lead 2026-10 裁定）：
 *    `ballThumbTarget()` 已经规定「用户手动指定过封面 / 包内自带官方图 → 该资产
 *    **不该有球图**，卡片显示封面」。救援把球图挂回去 = 绕过这条产品不变量，
 *    等于亲手制造 0.7.2 里 `isStaleBallThumb` / `repairStaleBallThumbs` 花一整轮
 *    修掉的 bug。这类记录交回既有 `ensureMissingThumbs`（它按当前封面 salt 生成，
 *    结果与 `manual` 语义一致），成本一条 IPC/资产。
 *
 *    **唯一例外**：静态救援表 `RENDER_PARAMS_RESTORE.preferThumb` 点名要恢复的那一条
 *    （`prefer` 命中）。它不是"按来源猜"，而是"事故复盘后写死的一个文件名"——
 *    目标资产 `5e4c3050-…` 是 `manual`，球图管线永远轮不到它；事故后补齐流程又把它
 *    渲成了**默认 UV** 的 `…-7933daa4.png`。不 pin 的话，用户刚被恢复的 UV=3.10
 *    与屏幕上的图**不一致**（"我调的又变回去了"）。pin 住是"UV 对、贴图错"，
 *    好过"UV 和贴图都错"；真正的重渲要破例让 manual 资产进球图管线，本版不做。
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
import type { CoverSource, ThumbFileEntry, ThumbStatus } from '../../shared/types'

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
  /**
   * 封面来源。`manual` / `named` 一律**不进救援**（见文件头 ⑥）：
   * 这类资产的卡片按产品不变量显示封面，球图管线永远轮不到它。
   */
  coverSource?: CoverSource
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
  /**
   * **显式偏好**：`assetId → 期望文件名`，命中时**优先于 mtime 规则**，
   * 并且**是"已有图就不碰"与"manual/named 一律跳过"这两道门的唯一例外**。
   *
   * 存在的理由（事故复盘，别删）：目标资产 `5e4c3050-…` 是 `manual` 封面，
   * 球图管线永远轮不到它；事故后补齐流程又把它渲成了**默认 UV** 的
   * `…-7933daa4.png`（mtime 更晚）。不 pin 的话，刚恢复的 UV=3.10 与屏幕上的图
   * 不一致（用户会觉得"我调的又变回去了"）。
   *
   * 两条边界：
   * ① 期望文件**必须真的在该 id 的候选列表里**（以 `thumb:list` 的结果为准），
   *    不在就回落到常规规则——绝不凭空造一个不存在的名字；
   * ② 只能由**静态的一次性表**驱动（`RESCUE_PREFER`），不允许从运行时数据推导。
   */
  prefer?: Readonly<Record<string, string>>
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
 * - 记录侧：`deletedAt` 有值 → 跳过；`coverSource` 为 `manual` / `named` → 跳过
 *   （产品不变量：这类资产显示封面，见文件头 ⑥）；已有可用缩略图 → 跳过。
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
  const prefer = opts.prefer ?? {}
  for (const asset of assets) {
    if (plan.length >= limit) break
    const id = typeof asset?.id === 'string' ? asset.id : ''
    if (id.length === 0) continue
    if (seen.has(id)) continue
    // ① 软删记录不救援（偏好也不能越过这条）
    if (typeof asset.deletedAt === 'number') continue
    const list = byId.get(id)
    if (!list || list.length === 0) continue

    // ② 显式偏好（静态表点名）：优先于 mtime，也是下面两道门的唯一例外
    const preferredName = prefer[id]
    if (preferredName) {
      const hit = list.find((f) => f.name === preferredName)
      if (hit) {
        seen.add(id)
        plan.push({
          assetId: id,
          thumbPath: hit.name,
          mtimeMs: hit.mtimeMs,
          candidates: list.length
        })
        continue
      }
      // 偏好文件不在本次列举结果里（被手动删了 / IPC 只回了部分）→ 回落常规规则
    }

    // ③ `manual` / `named` → 跳过（文件头 ⑥）：按产品不变量，这类资产显示封面
    if (asset.coverSource === 'manual' || asset.coverSource === 'named') continue

    // ④ 已有可用缩略图 → 绝不碰
    if (asset.thumbPath && asset.thumbStatus === 'ready') continue

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
 * 并已用文件名反算验证（**固定槽位 + 硬编码 rev=3 的字符串 fixture**，见测试）：
 * `fnv1a('rev3\n<槽位>\n1.00,1.00,3.10')` **恰好等于**盘上那张 `…-e94039c0.png`。
 *
 * ✅ **同时 pin 缩略图**（`preferThumb`，team-lead 2026-10 最终裁定）：
 * 该资产是 `manual` 封面 → 球图管线永远轮不到它（`ballThumbTarget` 为 null），
 * 而事故后补齐流程按**默认 UV** 渲出了 `…-7933daa4.png`（mtime 更晚）。
 * 只恢复参数不 pin 图的话，屏幕上的球仍是默认 UV —— 用户会觉得"我调的又变回去了"。
 * 三种选择里 pin 是当下最优：UV 对、贴图错（e94039c0 是把 `*.cover.jpg` 当 albedo
 * 渲的）好过 UV 与贴图都错。真正的重渲需要破例让 manual 资产进球图管线，本版不做。
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
  /**
   * 该记录应挂的**确切**缩略图文件名（一次性纠正"最新 ≠ 正确"，也是
   * `manual` / `named` 跳过规则的唯一例外）。
   *
   * 目标资产 id 下有两个球图：`…-e94039c0.png`（UV 3.10）与 `…-7933daa4.png`
   * （默认 UV，mtime 更晚——事故后补齐流程又渲了一张）。纯 mtime 规则会挑到后者，
   * 于是"刚恢复的 UV=3.10"与屏幕上的图不一致。文件不存在时自动回落常规规则。
   */
  preferThumb?: string
}> = [
  // 新中式复古仿古砖（UV=3.10，其余默认）
  {
    id: '5e4c3050-e057-4681-a70a-cb277890c309',
    params: { uv: 3.1 },
    preferThumb: '5e4c3050-e057-4681-a70a-cb277890c309-e94039c0.png'
  }
]

/**
 * `planThumbRescue` 的 `prefer` 入参：由 `RENDER_PARAMS_RESTORE` 的 `preferThumb` 汇总。
 *
 * 只包含**显式偏好**的条目（当前 1 条）。刻意从表里算而不是手写第二份，
 * 避免表与偏好两处漂移。
 */
export const RESCUE_PREFER: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    RENDER_PARAMS_RESTORE.filter(
      (e) => typeof e.preferThumb === 'string' && e.preferThumb.length > 0
    ).map((e) => [e.id, e.preferThumb as string])
  )
)

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
