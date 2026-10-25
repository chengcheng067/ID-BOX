/**
 * 索引记录卫生（T-PRUNE，0.7.7）——**纯逻辑**，零 electron / 零 Dexie / 零 DOM，
 * 可在 vitest node 环境直测。
 *
 * ## 这一层要解决什么
 *
 * 0.7.6 真机事故（详见 `docs/25-待办-用户反馈.md` 的 T-PRUNE）：
 * 用户的 HDR 库有 **69 条索引记录 / 33 个真实文件夹**（3 组 × 13 条同 `folder` 重复），
 * 69 条都写着 `thumbStatus='ready'`，而盘上只剩 **33 张**缩略图 —— 另外 36 张被
 * `pruneThumbs` 当孤儿删掉了（白名单用的是本次 rescan 的合并结果，悬空记录不在里面）。
 *
 * 本模块只做两件"算"，不负责"写"：
 *
 * ① `planDuplicateCleanup`：同 `folder` 的多条**活**记录 → 留一条、丢其余，并把
 *    别条的用户字段**只补空、不覆盖**地并进幸存者；
 * ② `planThumbPresenceRepair`：`thumbStatus='ready'` 但盘上**没有**对应文件的记录
 *    → 计划重置为 `none`，交给既有补齐队列重生。
 *
 * 写库（快照 / put / 定向 modify / bulkDelete）全部留在 `store.ts`，这里保持可测试。
 *
 * ## 四条硬纪律（改这里之前先读）
 *
 * ① **软删记录绝不参与、绝不被删**。`deletedAt` 有值的记录住 `<库根>/.trash/`，
 *    用户还能还原；把它们卷进"重复清理"等于替用户永久删除。同一个 folder 上
 *    "一条软删 + 一条活"是**正常状态**（软删记录的 `folder` 字段不变，目录已搬进
 *    `.trash/`），不是重复。
 * ② **合并只补空、绝不覆盖**。这是仓库既有纪律（`sizeBackfill` / `thumbRescue` /
 *    `rescan` 的合并方向都是"用户数据优先"）。拿"别条的默认值"覆盖幸存者的
 *    用户备注，是比重复记录更严重的数据事故。
 * ③ **确定性**：同样的输入必须得到同样的输出（含 `keepId` 的选择）。最后一级比较是
 *    `id` 的 code-unit 字典序 —— 不用 `localeCompare`，它依赖 ICU 数据，
 *    跨机器/跨 Node 版本可能给出不同顺序。
 * ④ **空名单不动作**：`listThumbs()` 失败返回 `[]`。若把"空名单"当成"盘上一张图都
 *    没有"，一次读盘失败就会把全库标成缺图 → 全量重渲。这条有单独的单测钉住。
 */

import type { Asset } from '../../shared/types'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { isDeletedAsset } from './trashView'

/** 同 folder 的一组重复记录（**只含活记录**）及其处理计划 */
export interface DuplicateGroup {
  /** 分组键（资产文件夹绝对路径） */
  folder: string
  /** 幸存记录 id（调用方保留这一条） */
  keepId: string
  /** 被丢弃的记录 id（调用方 `bulkDelete` 这些行，**只删索引行**） */
  dropIds: string[]
  /**
   * 只"补空、不覆盖"合并后的幸存记录（调用方直接 `put` 它）。
   *
   * `id` / `folder` / `kind` 与幸存者原记录完全一致 —— 主键与合并键都不动。
   */
  merged: Asset
}

/** 「缩略图索引指向的文件不在盘上」的一条修复计划 */
export interface ThumbPresenceRepair {
  id: string
}

/**
 * 用户字段"有内容"的判定表 —— 幸存者优先级第 ② 级用它算分。
 *
 * 口径：**用户能看见 / 能编辑的字段**有多少个是有值的。缩略图状态不在这里
 * （那是第 ① 级，单独判）；`importedAt` / `dedupeKey` / `relFolder` 这类派生或
 * 系统字段也不在（它们不表达"这条记录被用户调教过多少"）。
 */
function userFieldScore(a: Asset): number {
  let n = 0
  if (Array.isArray(a.tags) && a.tags.length > 0) n += 1
  if (nonEmptyText(a.note)) n += 1
  if (a.favorite === true) n += 1
  if (typeof a.rating === 'number' && a.rating > 0) n += 1
  if (a.colorTag !== null && a.colorTag !== undefined) n += 1
  if (Array.isArray(a.styles) && a.styles.length > 0) n += 1
  if (nonEmptyText(a.aliasOverride)) n += 1
  if (nonEmptyText(a.zhimoId)) n += 1
  if (a.renderParams !== undefined && Object.keys(a.renderParams).length > 0) n += 1
  if (a.renderShape !== undefined) n += 1
  if (nonEmptyText(a.cover)) n += 1
  if (a.materialMeta !== undefined) n += 1
  if (!isBlankCategory(a.category1)) n += 1
  if (!isBlankCategory(a.category2)) n += 1
  return n
}

/** 有内容（非 undefined / null / 纯空白）。`zhimoId` 是 `string | null`，这里一并归一 */
function nonEmptyText(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * 分类字段是否"等于没填"。
 *
 * `未分类` 是 `normalizeCategoryPair` 的占位默认值 —— 它出现在记录里不代表用户填过，
 * 所以合并时**允许被别条的真实分类覆盖**（这是"只补空"在分类维度上的具体口径）。
 */
function isBlankCategory(v: string | undefined): boolean {
  return v === undefined || v.trim() === '' || v === UNCLASSIFIED
}

/** 有可用缩略图（第 ① 级优先级） */
function hasReadyThumb(a: Asset): boolean {
  return a.thumbStatus === 'ready' && nonEmptyText(a.thumbPath)
}

/**
 * 幸存者比较器：负数 = `a` 更优先。
 *
 * 依次比较，先分出胜负者胜：
 * ① 有 `ready` 缩略图（用户"能看见图"是最高价值，丢了要重渲）；
 * ② 非空用户字段个数多（调教得越多越不能丢）；
 * ③ `updatedAt` 更新（最近的编辑最可能是用户想要的那份）；
 * ④ `id` code-unit 字典序（**只**为保证确定性，不代表任何偏好）。
 */
export function compareSurvivor(a: Asset, b: Asset): number {
  const thumbDiff = (hasReadyThumb(b) ? 1 : 0) - (hasReadyThumb(a) ? 1 : 0)
  if (thumbDiff !== 0) return thumbDiff

  const scoreDiff = userFieldScore(b) - userFieldScore(a)
  if (scoreDiff !== 0) return scoreDiff

  const aUpdated = Number.isFinite(a.updatedAt) ? a.updatedAt : 0
  const bUpdated = Number.isFinite(b.updatedAt) ? b.updatedAt : 0
  if (aUpdated !== bUpdated) return bUpdated - aUpdated

  if (a.id === b.id) return 0
  // 刻意不用 localeCompare：它受 ICU 影响，跨环境可能给出不同顺序
  return a.id < b.id ? -1 : 1
}

/**
 * 把 `others` 的用户字段**只补空**地并进 `keeper`，返回新对象（不修改入参）。
 *
 * 覆盖范围（施工单逐条）：
 * - `tags` 取并集；`favorite` 取 OR；`rating` 取 max；
 * - `colorTag` / `note` / `category1` / `category2` 仅当幸存者为空或 `未分类`；
 * - `renderParams` / `renderShape` 仅当幸存者为 `undefined`；
 * - `cover` / `coverSource` 仅当幸存者 `cover` 为空（**两个字段取自同一条别记录**，
 *   否则会出现"封面是 A 的、来源标着 B 的"这种错配）；
 * - `size` 为 0 时取别条最大；`files` 为空时取条数最多的那条；
 * - `importedAt` 取最小（= 资产最早的入库时间，本项目没有 `createdAt` 字段，
 *   `importedAt` 就是创建时间；施工单里写的 `createdAt` 在本仓库对应它）；
 * - `updatedAt` 取 `Date.now()`（合并确实改动了记录内容，与"rescan 不是用户编辑"不同）；
 * - `id` / `folder` / `kind` **一律不动**（主键 + 合并键 + 分类大类）。
 */
export function mergeDuplicateGroup(keeper: Asset, others: Asset[]): Asset {
  const all = [keeper, ...others]
  const merged: Asset = { ...keeper }

  // ── tags：并集（保留先出现的顺序，去重；空串 / 非字符串丢弃） ──────────
  const tags: string[] = []
  for (const a of all) {
    for (const t of Array.isArray(a.tags) ? a.tags : []) {
      if (typeof t === 'string' && t.trim() !== '' && !tags.includes(t)) tags.push(t)
    }
  }
  merged.tags = tags

  // ── 布尔 / 数值：取"更靠用户意图"的那一端 ────────────────────────────
  merged.favorite = all.some((a) => a.favorite === true)
  const ratings = all
    .map((a) => a.rating)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  merged.rating = ratings.length > 0 ? Math.max(...ratings) : 0

  // ── 单值字段：幸存者为空才继承（第一个有值者胜，顺序由优先级排序决定） ──
  if (merged.colorTag === null || merged.colorTag === undefined) {
    const withColor = others.find((a) => a.colorTag !== null && a.colorTag !== undefined)
    if (withColor) merged.colorTag = withColor.colorTag
  }

  if (!nonEmptyText(merged.note)) {
    const withNote = others.find((a) => nonEmptyText(a.note))
    if (withNote) merged.note = withNote.note
  }

  if (isBlankCategory(merged.category1)) {
    const withCat = others.find((a) => !isBlankCategory(a.category1))
    if (withCat?.category1 !== undefined) merged.category1 = withCat.category1
  }
  if (isBlankCategory(merged.category2)) {
    const withCat = others.find((a) => !isBlankCategory(a.category2))
    if (withCat?.category2 !== undefined) merged.category2 = withCat.category2
  }

  if (merged.renderParams === undefined) {
    const withParams = others.find((a) => a.renderParams !== undefined)
    if (withParams) merged.renderParams = withParams.renderParams
  }
  if (merged.renderShape === undefined) {
    const withShape = others.find((a) => a.renderShape !== undefined)
    if (withShape) merged.renderShape = withShape.renderShape
  }

  if (!nonEmptyText(merged.cover)) {
    const withCover = others.find((a) => nonEmptyText(a.cover))
    if (withCover) {
      merged.cover = withCover.cover
      // 来源必须跟着封面一起搬，否则「手动封面」的语义会被安到别人的图上
      merged.coverSource = withCover.coverSource
    }
  }

  // ── 数值 / 列表：只为"填空"，不覆盖已有的非空值 ──────────────────────
  const sizeOf = (a: Asset): number => (typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0)
  if (sizeOf(merged) === 0) {
    const maxSize = Math.max(0, ...others.map(sizeOf))
    if (maxSize > 0) merged.size = maxSize
  }

  const filesOf = (a: Asset): Asset['files'] => (Array.isArray(a.files) ? a.files : [])
  if (filesOf(merged).length === 0) {
    const best = [...others].sort((a, b) => filesOf(b).length - filesOf(a).length)[0]
    if (best && filesOf(best).length > 0) merged.files = filesOf(best)
  }

  const importedTimes = all
    .map((a) => a.importedAt)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  if (importedTimes.length > 0) merged.importedAt = Math.min(...importedTimes)

  // 内容真的变了 → 记一次修改时间（排序/筛选都读它）
  merged.updatedAt = Date.now()

  return merged
}

/**
 * 算出「同 folder 多条活记录」的清理计划。
 *
 * - **只处理活记录**：`deletedAt` 有值的一律跳过（既不当幸存者，也不会进 `dropIds`）；
 * - 按 `folder` 分组，组内 > 1 条才产出计划；
 * - `folder` 为空串的组**跳过**：空 folder 是脏数据，拿它当合并键会把互不相关的
 *   记录并成一条（真正的后果是丢记录），宁可留给用户手工处理；
 * - 幂等：清理后每组只剩 1 条 → 再调用返回 `[]`。
 */
export function planDuplicateCleanup(assets: Asset[]): DuplicateGroup[] {
  if (!Array.isArray(assets) || assets.length < 2) return []

  const byFolder = new Map<string, Asset[]>()
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue
    if (isDeletedAsset(a)) continue
    if (typeof a.folder !== 'string' || a.folder.trim() === '') continue
    const list = byFolder.get(a.folder)
    if (list) list.push(a)
    else byFolder.set(a.folder, [a])
  }

  const groups: DuplicateGroup[] = []
  for (const [folder, list] of byFolder) {
    if (list.length < 2) continue
    const sorted = [...list].sort(compareSurvivor)
    const keeper = sorted[0]!
    const others = sorted.slice(1)
    groups.push({
      folder,
      keepId: keeper.id,
      dropIds: others.map((a) => a.id),
      merged: mergeDuplicateGroup(keeper, others)
    })
  }

  // 输出顺序稳定（Map 的插入序依赖输入顺序，这里显式排序，便于测试与日志比对）
  groups.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))
  return groups
}

/**
 * 取缩略图缓存文件名（`thumbPath` 正常就是纯文件名；防御性处理历史脏值里的路径）。
 *
 * `listThumbs()` 返回的是 `ThumbFileEntry.name`（**纯文件名**），所以带目录的重叠值
 * 必须归一，否则会永远判"不在盘上"→ 好记录被无谓重置（重渲一遍）。
 */
function thumbNameOf(thumbPath: string): string {
  const parts = thumbPath.split(/[\\/]/)
  return parts[parts.length - 1] ?? thumbPath
}

/**
 * 算出「`thumbStatus='ready'` 但盘上没有对应文件」的修复计划。
 *
 * ## 为什么空名单必须整体跳过
 *
 * `window.modvault.listThumbs()` 在目录不存在 / 读盘失败时返回 `[]`（实现刻意如此）。
 * 若把空数组当成"盘上一张图都没有"的权威事实，一次瞬时 IO 失败就会把**全库**
 * 标成缺图 → 全量重渲（CPU 打满 + 缓存被覆盖）。所以 `[]` 一律视为"这次没读到"，
 * 返回 `[]`（幂等：下次启动还会再算）。
 *
 * ## 只处理活记录
 *
 * 软删记录的目录已搬进 `.trash/`，其缩略图由删除/还原流程管理；在这里把它们重置
 * 成 `none` 会让 `ensureMissingThumbs` 拿失效的 `folder + cover` 去生成并失败，
 * 白白污染 `thumbAttempted`。**拖进回收站的卡片是否缺图不归这一层管。**
 *
 * `thumbStatus !== 'ready'` 的一律不管 —— 那是补齐队列（`ensureMissingThumbs`）的活。
 */
export function planThumbPresenceRepair(
  assets: Asset[],
  diskThumbNames: string[]
): ThumbPresenceRepair[] {
  if (!Array.isArray(assets) || assets.length === 0) return []
  if (!Array.isArray(diskThumbNames) || diskThumbNames.length === 0) return []

  const present = new Set<string>()
  for (const n of diskThumbNames) {
    if (typeof n === 'string' && n.trim() !== '') present.add(n)
  }
  // 全是空白串 = 等价于空名单（同上：不动作）
  if (present.size === 0) return []

  const plan: ThumbPresenceRepair[] = []
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue
    if (isDeletedAsset(a)) continue
    if (a.thumbStatus !== 'ready') continue
    // `ready` 但连 thumbPath 都没有 = 记录自身不自洽，同样按缺图处理
    if (nonEmptyText(a.thumbPath) && present.has(thumbNameOf(a.thumbPath!))) continue
    plan.push({ id: a.id })
  }
  return plan
}
