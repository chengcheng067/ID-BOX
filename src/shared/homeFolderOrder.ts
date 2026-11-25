/**
 * 首页文件夹排的**拖动排序**（2026-11-25 用户需求：「首页文件夹支持鼠标拖动调整顺序」）
 * —— 共享类型 + 唯一归一化 / 排序 / 移动入口。
 *
 * 为什么放 shared：`Settings.homeFolderOrder` 既要被主进程的 `SettingsSchema` /
 * `migrateSettings` / `normalizeSettings` 洗（读档 / 写档），又要被渲染层的
 * `App.tsx` / `HomeCover.tsx` 消费。两处必须用**同一份**规则，否则手改档或脏值会让
 * 「写进去的顺序」和「读出来的顺序」分叉（与 `shared/pinnedViewPrefs.ts` 同款分工）。
 *
 * 数据口径（已与产品对齐，不要再扩）：
 * - `Settings.homeFolderOrder: string[]`，默认 `[]`；
 * - 元素是**槽位键**：素材大类卡 = `kind:<HomeFolderItem['key']>`，钉选卡 = `pin:<id>`
 *   （与 `logic/homePinned.ts` 的底纹命名空间**同形不同域** —— 那边是 `homeFolderWallpaper`
 *   的键，这边是顺序表的键；两套表各自独立，共用一个字符串形状只是为了好读）；
 * - **数组顺序即显示顺序**；`order` 里没有的卡按默认顺序（大类在前、钉选在后）
 *   追加到末尾 —— 新增钉选 / 某分类从空变为有素材时，卡不会消失，只是排到最后；
 * - **未知键保留**：删掉一个 pin 后 `pin:<旧 id>` 仍留在表里（再钉回来不一定还是同一
 *   id，但保留是零成本的，删了反而会丢掉"这个槽位原来在哪"的信息）；
 * - 「新建项目」虚卡**不入 order**（它不是文件夹，是动作入口），恒排在最后。
 *
 * ⚠️ 纪律：本模块不 import React / DOM / electron / store，纯数据运算，node 环境可测。
 */

/** 顺序表长度上限（= 分类 5 + 钉选 32，取整到 64：留出已删 pin 的残键余量，防排爆） */
export const MAX_HOME_FOLDER_ORDER = 64

/** 素材大类卡的顺序键（与底纹键同形：`kind:<HomeFolderItem['key']>`） */
export function homeKindFolderKey(kind: string): string {
  return `kind:${kind}`
}

/** 钉选卡的顺序键（与底纹键同形：`pin:<HomePinnedFolder.id>`） */
export function homePinFolderKey(pinId: string): string {
  return `pin:${pinId}`
}

/**
 * 「新建项目」虚卡的固定槽位键：**永不写入 order**，只用于渲染树里的 data 标记；
 * 排序时被单独摘出来追加到末尾。
 */
export const HOME_NEW_PROJECT_SLOT_KEY = 'new-project'

/**
 * 文件夹排里的一个槽位（渲染顺序的最小单位）。
 *
 * `type` 决定画哪种卡；`key` 参与排序（`newProject` 的 key 是常量、不参与 order 匹配）。
 */
export type HomeFolderSlot =
  | { type: 'kind'; key: string }
  | { type: 'pin'; key: string }
  | { type: 'newProject'; key: string }

/**
 * 按「大类在前、钉选在后、虚卡末尾」拼出默认槽位表（= 没有 order 时的原始顺序）。
 *
 * @param kindKeys 大类卡的 kind 列表（`App` 的 `HOME_FOLDER_KEYS` 顺序）
 * @param pinIds   钉选 id 列表（`homePinnedFolders` 数组顺序）
 * @param withNewProject 是否包含「新建项目」虚卡（`onNewProject` 是否传入）
 */
export function buildHomeFolderSlots(
  kindKeys: readonly string[],
  pinIds: readonly string[],
  withNewProject: boolean
): HomeFolderSlot[] {
  const slots: HomeFolderSlot[] = []
  for (const kind of kindKeys) slots.push({ type: 'kind', key: homeKindFolderKey(kind) })
  for (const id of pinIds) slots.push({ type: 'pin', key: homePinFolderKey(id) })
  if (withNewProject) slots.push({ type: 'newProject', key: HOME_NEW_PROJECT_SLOT_KEY })
  return slots
}

/**
 * 顺序表的**唯一归一化入口**（读档 / 写档 / 渲染层 patch 共用）。
 *
 * - 非数组 → 空数组（= 默认顺序，行为与没有本功能时逐字一致）；
 * - 非字符串项 / trim 后为空串 → 丢弃（手改档写出 `[null, 3, "  "]` 不会污染渲染）；
 * - 重复键 → 保留先出现的那条（顺序表里同一个槽位出现两次没有意义）；
 * - 超过 `MAX_HOME_FOLDER_ORDER`(64) → 截断（保序：先出现的更可信）；
 * - **不校验命名空间**：未知键原样保留（见文件头「未知键保留」）。
 */
export function normalizeHomeFolderOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (out.length >= MAX_HOME_FOLDER_ORDER) break
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * 按 order 排出渲染顺序：order 里有的按 order 的相对次序，没有的按默认顺序追加到末尾；
 * 「新建项目」虚卡**恒在最后**（与 order 无关）。
 *
 * 稳定性：缺失键之间保持入参（默认）顺序 —— JS 的 `Array#sort` 在 V8 上稳定，
 * 但这里仍显式用「原始下标」兜底比较，避免"换个引擎顺序就变"。
 */
export function sortHomeFolderSlots(
  slots: readonly HomeFolderSlot[],
  order: readonly string[]
): HomeFolderSlot[] {
  const rank = new Map<string, number>()
  order.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index)
  })
  const draggable: HomeFolderSlot[] = []
  const tail: HomeFolderSlot[] = []
  for (const slot of slots) {
    if (slot.type === 'newProject') tail.push(slot)
    else draggable.push(slot)
  }
  const decorated = draggable.map((slot, index) => ({
    slot,
    index,
    rank: rank.get(slot.key) ?? Number.MAX_SAFE_INTEGER
  }))
  decorated.sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
  return [...decorated.map((item) => item.slot), ...tail]
}

/**
 * 把 `key` 移到 `targetIndex`（越界夹到 `[0, len-1]`）。
 *
 * 入参是**当前显示顺序的键列表**（不含虚卡）。`key` 不在表里 → 原样复制返回
 * （例如拖动过程中某张卡被移除，宁可不重排也不插一条幽灵键）。
 */
export function moveHomeFolderKey(
  keys: readonly string[],
  key: string,
  targetIndex: number
): string[] {
  const next = [...keys]
  const from = next.indexOf(key)
  if (from < 0) return next
  if (!Number.isFinite(targetIndex)) return next
  const to = Math.min(next.length - 1, Math.max(0, Math.trunc(targetIndex)))
  if (to === from) return next
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}

/**
 * 把「新的可见顺序」合进既有 order：**只重排可见槽位占的位置，非可见键原地不动**。
 *
 * 为什么需要它：order 里可能留着当前没显示的键（例如 `kind:other` 现在 0 个素材、
 * 或已删除钉选的残键）。直接拿可见顺序覆盖会把这些"看不见但仍有位置信息"的键冲掉；
 * 而"这次拖动"只该改变**看得见的那几张卡**的相对次序。
 *
 * 算法：按 `previous` 逐位走，遇到可见键就依次填入 `nextVisible` 的下一个；
 * 走完后把 `previous` 里没有的可见键（= 第一次排序 / 新加的钉选）追加到末尾；
 * 最后过一遍 `normalizeHomeFolderOrder` 去重 + 封顶。
 */
export function applyHomeFolderOrder(
  previous: readonly string[],
  nextVisible: readonly string[]
): string[] {
  const visible = new Set(nextVisible)
  const merged: string[] = []
  let cursor = 0
  for (const key of previous) {
    if (!visible.has(key)) {
      merged.push(key)
      continue
    }
    if (cursor < nextVisible.length) merged.push(nextVisible[cursor])
    cursor += 1
  }
  while (cursor < nextVisible.length) {
    merged.push(nextVisible[cursor])
    cursor += 1
  }
  return normalizeHomeFolderOrder(merged)
}

/**
 * 落点判定：给定每张卡的中心 x（**视觉顺序**）与指针 x，返回最近的那一格下标。
 * 指针在第一格左侧 → 0；在最后一格右侧 → 末位（「拖到最左 / 最右」自然成立）。
 */
export function nearestSlotIndex(centers: readonly number[], pointerX: number): number {
  if (centers.length === 0) return 0
  let best = 0
  let bestDistance = Math.abs(pointerX - centers[0])
  for (let i = 1; i < centers.length; i += 1) {
    const distance = Math.abs(pointerX - centers[i])
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/**
 * 让位偏移：拖动的卡从 `fromIndex` 移到 `toIndex` 时，视觉下标 `index` 的那张卡
 * 应该平移几个槽位（-1 左 / 0 不动 / +1 右）。
 *
 * 真值表（左拖 = from > to）：[to, from) 区间内的卡右移一格；
 *            右拖 = from < to：(from, to] 区间内的卡左移一格；源卡自己恒 0。
 */
export function dragSlotShift(
  fromIndex: number,
  toIndex: number,
  index: number
): -1 | 0 | 1 {
  if (fromIndex === toIndex) return 0
  if (index === fromIndex) return 0
  if (fromIndex < toIndex) {
    return index > fromIndex && index <= toIndex ? -1 : 0
  }
  return index >= toIndex && index < fromIndex ? 1 : 0
}
