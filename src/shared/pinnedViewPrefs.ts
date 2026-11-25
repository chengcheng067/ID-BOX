/**
 * 钉选目录浏览器 · 视图 / 排序偏好的**共享类型 + 唯一归一化入口**。
 *
 * 2026-11-25 用户需求①：「一旦选择了图标视图，下一次进入这个文件夹时要保持图标视图」
 * —— 这些偏好从内存级（`logic/pinnedViewPrefs.ts`）升级为 `Settings.pinnedViewPrefs`，
 * 跨重启保留。因此类型与清洗规则必须放 shared：主进程 `SettingsSchema` /
 * `migrateSettings` / `normalizeSettings` 与渲染层读的是同一份数据。
 *
 * 纪律（与 `shared/undoGrace.ts` / `shared/customTaxonomy.ts` 同款）：
 * - **单一键名**：`view` / `sortKey` / `sortDir`，与 `logic/pinnedBrowser` 的既有形状一致，
 *   不另造第二套（`logic/pinnedBrowser.ts` 只负责再导出，勿在此重复定义）；
 * - **单项降级**：未知视图字符串 / 脏排序键 / 非对象值只丢**这一条**，
 *   绝不抛错、绝不让整份 settings.json 回落默认；
 * - 键数封顶 `MAX_PINNED_VIEW_PREFS`(32) —— 与 `normalizeHomePinnedFolders` 的
 *   32 条上限同一口径（pin 的上限本身就是 32，偏好表不可能合理地更大）。
 */

export type PinnedViewMode = 'list' | 'grid'
export type PinnedSortKey = 'name' | 'mtime' | 'size' | 'kind'
export type PinnedSortDir = 'asc' | 'desc'

/** 一个钉选目录的记忆（视图 + 排序），键 = `HomePinnedFolder.id` */
export interface PinnedViewPrefs {
  view: PinnedViewMode
  sortKey: PinnedSortKey
  sortDir: PinnedSortDir
}

/** pinId → 偏好（`Settings.pinnedViewPrefs` 的形状） */
export type PinnedViewPrefsMap = Record<string, PinnedViewPrefs>

/** PRD 批注：默认视图 = 列表，默认排序 = 名称升序（= 没有记忆时的行为） */
export const DEFAULT_PINNED_VIEW_PREFS: Readonly<PinnedViewPrefs> = {
  view: 'list',
  sortKey: 'name',
  sortDir: 'asc'
}

/** 偏好表键数上限（= 钉选 32 条上限，见 `MAX_HOME_PINNED_FOLDERS`） */
export const MAX_PINNED_VIEW_PREFS = 32

/**
 * 单条偏好的防御式解析：脏字段逐个回落默认值（缺视图 = 列表、缺排序 = 名称升序）。
 * 永不抛错 —— 供读档 / 写档 / 渲染层 patch 三处共用。
 */
export function normalizePinnedViewPrefs(raw: unknown): PinnedViewPrefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PinnedViewPrefs>
  return {
    view: r.view === 'grid' ? 'grid' : 'list',
    sortKey:
      r.sortKey === 'mtime' || r.sortKey === 'size' || r.sortKey === 'kind' ? r.sortKey : 'name',
    sortDir: r.sortDir === 'desc' ? 'desc' : 'asc'
  }
}

/**
 * 整张偏好表的防御式解析（`Settings.pinnedViewPrefs` 的唯一归一化入口）。
 *
 * - 非对象 / 数组 → 空表（= 全部走默认视图，行为与没有本功能时一致）；
 * - 空 pinId（trim 后为空）→ 丢弃（永远匹配不到真实钉选）；
 * - 值非对象 → 丢弃（手改档写出 `{"id":"grid"}` 这种脏形状）；
 * - 值对象里字段脏 → 只回落该字段（交给 `normalizePinnedViewPrefs`）；
 * - 超过 `MAX_PINNED_VIEW_PREFS`(32) 条 → 丢弃多余项（保留先出现的，键序稳定）。
 */
export function normalizePinnedViewPrefsMap(value: unknown): PinnedViewPrefsMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: PinnedViewPrefsMap = {}
  for (const [pinId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PINNED_VIEW_PREFS) break
    if (!pinId.trim()) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    out[pinId] = normalizePinnedViewPrefs(raw)
  }
  return out
}
