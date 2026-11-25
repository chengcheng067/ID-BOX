/**
 * 应用内文件浏览器 v2 · **纯逻辑**（docs/61 §批注结果施工口径）。
 *
 * 为什么抽出来：浏览器要做的排序 / 类型判断 / 历史栈 / 框选命中 / 冲突预检全部是
 * 纯数学与纯数据运算，放组件里既测不了也必然和两套视图（列表 / 图标）漂移。
 * 本模块不 import React / DOM / electron / store → 可直接进 vitest
 * （`tests/pinnedBrowser.test.ts`）。唯一的例外是 `pinnedWriteApi()`：它是
 * 「主进程写通道是否就绪」的运行期探针，只在调用时才碰 `window`，单测不会执行它。
 *
 * ⚠️ 与主进程契约的关系：写通道（新建 / 重命名 / 删除 / 解压 / 压缩 / 打开方式）
 * 的 IPC 常量由主进程工程师并行落地（shared/ipc.ts 的通道常量段），渲染层一律
 * 通过 {@link pinnedWriteApi} 存在判断后调用 —— 未就绪时按钮置灰 + toast「功能就绪中」，
 * 主进程落地后自然接通，渲染层零改动。
 */
import type {
  FsEntry,
  FsCompressEntriesInput,
  FsCompressEntriesResult,
  FsExtractArchiveInput,
  FsExtractArchiveResult,
  FsMkdirInput,
  FsMkdirResult,
  FsOpenWithInput,
  FsOpenWithResult,
  FsRenameEntryInput,
  FsRenameEntryResult,
  FsTrashEntriesInput,
  FsTrashEntriesResult,
  FsWriteFailureReason
} from '../../shared/ipc'
import { marqueeHitIds, type BoxRect } from './fileView'

/* ────────────────────────────────────────────────────────────────────────────
 * 视图 / 排序偏好（按 pin 记忆；2026-11-25 起**持久化**到 Settings.pinnedViewPrefs）
 *
 * 类型 / 默认值 / 归一化的唯一实现在 `shared/pinnedViewPrefs.ts`（主进程 settings
 * 与渲染层共用）；这里只做再导出，保持既有 import 路径不变。
 * ──────────────────────────────────────────────────────────────────────────── */

import type { PinnedSortDir, PinnedSortKey, PinnedViewPrefs } from '../../shared/pinnedViewPrefs'

export type {
  PinnedViewMode,
  PinnedSortKey,
  PinnedSortDir,
  PinnedViewPrefs,
  PinnedViewPrefsMap
} from '../../shared/pinnedViewPrefs'
export { DEFAULT_PINNED_VIEW_PREFS, normalizePinnedViewPrefs } from '../../shared/pinnedViewPrefs'

/** 排序键的中文标签（工具行排序按钮与菜单共用，改文案只改这里） */
export const PINNED_SORT_KEY_LABEL: Record<PinnedSortKey, string> = {
  name: '名称',
  mtime: '修改时间',
  size: '大小',
  kind: '类型'
}

/* ────────────────────────────────────────────────────────────────────────────
 * 排序（目录恒在前 + 四键 × 双向）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 扩展名（小写；无扩展名 / 点开头的隐藏名返回空串） */
export function extOf(name: string): string {
  const at = name.lastIndexOf('.')
  if (at <= 0) return ''
  return name.slice(at + 1).toLowerCase()
}

/** 类型列文案：目录 =「文件夹」，文件 = 扩展名大写，无扩展名 =「文件」 */
export function kindLabelOf(entry: Pick<FsEntry, 'name' | 'isDir'>): string {
  if (entry.isDir) return '文件夹'
  const ext = extOf(entry.name)
  return ext === '' ? '文件' : ext.toUpperCase()
}

/** 名称比较：中文按拼音段 + 数字按值（与主进程 pinnedDirGuard 的排序口径一致） */
function compareName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

/**
 * 单对条目比较：**目录恒排文件前面**（资源管理器默认行为，不因排序键 / 方向打乱），
 * 同组内按当前键 × 方向。主进程已按名称排过一遍，这里只是渲染层重排，不修改原数组。
 */
export function comparePinnedEntries(
  a: FsEntry,
  b: FsEntry,
  sortKey: PinnedSortKey,
  sortDir: PinnedSortDir
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const dirMul = sortDir === 'desc' ? -1 : 1
  switch (sortKey) {
    case 'mtime':
      // asc = 旧在前；stat 失败（undefined）按 0（最旧）兜底
      return dirMul * ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0))
    case 'size':
      return dirMul * ((a.size ?? 0) - (b.size ?? 0))
    case 'kind': {
      const byExt = compareName(extOf(a.name), extOf(b.name))
      return dirMul * (byExt !== 0 ? byExt : compareName(a.name, b.name))
    }
    case 'name':
    default:
      return dirMul * compareName(a.name, b.name)
  }
}

/** 排序一份条目（返回新数组，不修改入参 —— 调用方可放心放进 useMemo 依赖） */
export function sortPinnedEntries(entries: readonly FsEntry[], prefs: PinnedViewPrefs): FsEntry[] {
  return [...entries].sort((a, b) => comparePinnedEntries(a, b, prefs.sortKey, prefs.sortDir))
}

/* ────────────────────────────────────────────────────────────────────────────
 * 扩展名判断（解压入口 / 图标映射）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 压缩包扩展名（解压菜单项的可见性判据；主进程侧同口径校验） */
const ARCHIVE_EXTS: readonly string[] = [
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'cab',
  'iso'
]

export function isArchiveName(entry: Pick<FsEntry, 'name' | 'isDir'>): boolean {
  if (entry.isDir) return false
  return ARCHIVE_EXTS.includes(extOf(entry.name))
}

/** 图片扩展名（图标视图的类型图标映射用） */
const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']

export function isImageName(entry: Pick<FsEntry, 'name' | 'isDir'>): boolean {
  if (entry.isDir) return false
  return IMAGE_EXTS.includes(extOf(entry.name))
}

/**
 * 站方推广文件词表（docs/61 任务 11）：文件名含「微信扫码」「知末」即算。
 * 双击 / 菜单打开前弹确认层，只提示不拦截 —— 设置里不放开关。
 */
export function isAdFileName(name: string): boolean {
  return name.includes('微信扫码') || name.includes('知末')
}

/* ────────────────────────────────────────────────────────────────────────────
 * 展示格式（与第一版同一口径，搬家到这里让列表 / 图标两视图共用）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 文件大小的人类可读（无法 stat 的条目返回空串） */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

/** 修改时间的固定格式（本地时区 `YYYY-MM-DD HH:mm`；stat 失败的条目返回空串） */
export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * 历史栈（路径序列快照 + 游标；docs/61 A1 批注：精简历史栈）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 历史栈：`stack` 是 segments 快照序列（`[]` = 根），`index` 是当前游标 */
export interface PinnedHistory {
  readonly stack: ReadonlyArray<readonly string[]>
  readonly index: number
}

const HISTORY_MAX = 100

export function emptyHistory(): PinnedHistory {
  return { stack: [[]], index: 0 }
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i])
}

/**
 * 记一次跳转。语义与资源管理器一致：
 * - 与当前层相同（刷新 / 重复跳转）→ **去重**，返回原对象（引用相等便于 effect 判等）；
 * - 游标之后的前进记录**清掉**（面包屑回跳 = 一次新跳转）；
 * - 上限 100 条，裁掉最旧。
 */
export function pushHistory(h: PinnedHistory, segments: readonly string[]): PinnedHistory {
  if (sameSegments(h.stack[h.index] ?? [], segments)) return h
  const stack = [...h.stack.slice(0, h.index + 1), segments]
  const trimmed = stack.length > HISTORY_MAX ? stack.slice(stack.length - HISTORY_MAX) : stack
  return { stack: trimmed, index: trimmed.length - 1 }
}

/** 后退（没有可退的层返回 null，调用方据此置灰按钮） */
export function historyBack(h: PinnedHistory): PinnedHistory | null {
  if (h.index <= 0) return null
  return { stack: h.stack, index: h.index - 1 }
}

/** 前进（没有可进的层返回 null） */
export function historyForward(h: PinnedHistory): PinnedHistory | null {
  if (h.index >= h.stack.length - 1) return null
  return { stack: h.stack, index: h.index + 1 }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 框选几何命中（复用中栏框选的纯函数，条目 id = 条目名）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 框选命中：`order` = 渲染顺序（排序后的条目名序列），`rects` = 已渲染条目的矩形快照
 * （内容坐标系）。相交即命中（1px 擦到就算，见 `fileView.boxesIntersect`）。
 */
export function hitNames(
  rects: ReadonlyMap<string, BoxRect>,
  order: readonly string[],
  box: BoxRect
): string[] {
  return marqueeHitIds(rects, order, box)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 多选（Ctrl 切换 / Shift 范围复用 selection.ts；这里只补 Ctrl 单点切换）
 * ──────────────────────────────────────────────────────────────────────────── */

/** Ctrl+点击：切换一个条目的选中态（返回新 Set，不修改入参） */
export function toggleSelected(current: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(current)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  return next
}

/* ────────────────────────────────────────────────────────────────────────────
 * 命名冲突预检（行内提示「名称已存在」，不弹窗）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 同层是否已有同名条目。Windows 文件系统大小写不敏感，所以比较前统一小写；
 * `excludeName` 用于重命名（没改名的场合不算冲突）。
 */
export function nameExists(
  siblingNames: readonly string[],
  candidate: string,
  excludeName?: string
): boolean {
  const target = candidate.toLowerCase()
  const excluded = excludeName !== undefined ? excludeName.toLowerCase() : null
  return siblingNames.some((n) => n.toLowerCase() === target && n.toLowerCase() !== excluded)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 右键菜单（三套）的纯逻辑
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 浏览器菜单项。与 `logic/contextMenu.ts` 的 ContextMenuItem 相比多两种：
 * - `checked`：排序菜单的当前键 / 方向对勾（共享外壳不认识它，由浏览器自己的
 *   菜单外壳渲染 —— 浏览器菜单要支持子菜单，不与库内三层菜单混用）；
 * - `children`：一级子菜单（空白处右键的「排序」级联面板，照设计稿 F5）。
 */
export type PinnedMenuItem =
  | {
      label: string
      icon?: string | readonly string[]
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      onClick: () => void
    }
  | { label: string; icon?: string | readonly string[]; children: PinnedMenuItem[] }
  | 'separator'

/** 去掉首 / 尾 / 连续的分隔线（与 contextMenu.normalizeMenuItems 同规则，类型不同故另写） */
export function normalizePinnedMenuItems(items: readonly PinnedMenuItem[]): PinnedMenuItem[] {
  const out: PinnedMenuItem[] = []
  for (const item of items) {
    if (item === 'separator') {
      if (out.length === 0) continue
      if (out[out.length - 1] === 'separator') continue
      out.push(item)
      continue
    }
    out.push(item)
  }
  while (out.length > 0 && out[out.length - 1] === 'separator') out.pop()
  return out
}

/** 条目右键的动作回调（多选时 targets 是整个多选集，单选是一个条目） */
export interface PinnedEntryMenuActions {
  onOpen: () => void
  /** 「打开方式」（走 openPinnedWith；仅单选文件出现） */
  onOpenWith: () => void
  /**
   * 「在资源管理器中显示」（资源管理器兜底出口，用户第一版口径）。
   * 复用 `home:pinnedOpen`（id 白名单 + showItemInFolder）；单选才可用。
   */
  onReveal: () => void
  /** 行内重命名（仅单选出现） */
  onRename: () => void
  onCopyPath: () => void
  onCompress: () => void
  /** 解压（仅单选压缩包出现） */
  onExtract: () => void
  onDelete: () => void
}

/**
 * 条目右键菜单（任务口径 + 设计稿 F4/F5 的兜底出口项）：
 * - 目录：打开 / 在资源管理器中显示 / 重命名 / 复制路径 / 压缩 / 删除
 * - 文件：打开 / 打开方式 / 在资源管理器中显示 / 重命名 / 复制路径 / 压缩 /
 *   解压（压缩包）/ 删除
 * - 多选：打开 / 打开方式 / 重命名 / 复制路径 / 解压 没有意义 → 灰掉或不出现；
 *   压缩 / 删除照常。写通道未就绪（`writeReady=false`）的项置灰。
 */
export function pinnedEntryMenuItems(
  targets: readonly FsEntry[],
  writeReady: boolean,
  actions: PinnedEntryMenuActions
): PinnedMenuItem[] {
  const count = targets.length
  const single = count === 1 ? targets[0] : null
  const items: PinnedMenuItem[] = [
    { label: '打开', icon: MENU_ICON_EXTERNAL, disabled: count !== 1, onClick: actions.onOpen }
  ]
  if (single !== null && !single.isDir) {
    items.push({
      label: '打开方式',
      icon: MENU_ICON_SLIDERS,
      disabled: !writeReady,
      onClick: actions.onOpenWith
    })
  }
  items.push({
    label: '在资源管理器中显示',
    icon: MENU_ICON_FOLDER,
    disabled: count !== 1,
    onClick: actions.onReveal
  })
  items.push('separator')
  if (single !== null) {
    items.push({
      label: '重命名',
      icon: MENU_ICON_PENCIL,
      disabled: !writeReady,
      onClick: actions.onRename
    })
  }
  items.push({
    label: '复制路径',
    icon: MENU_ICON_COPY,
    disabled: count !== 1,
    onClick: actions.onCopyPath
  })
  items.push({
    label: '压缩',
    icon: MENU_ICON_STACK,
    disabled: !writeReady,
    onClick: actions.onCompress
  })
  if (single !== null && isArchiveName(single)) {
    items.push({
      label: '解压',
      icon: MENU_ICON_FOLDER,
      disabled: !writeReady,
      onClick: actions.onExtract
    })
  }
  items.push('separator')
  items.push({
    label: count > 1 ? `删除（${count} 项）` : '删除',
    icon: MENU_ICON_TRASH,
    danger: true,
    disabled: !writeReady,
    onClick: actions.onDelete
  })
  return normalizePinnedMenuItems(items)
}

/** 空白处右键的动作回调 */
export interface PinnedBlankMenuActions {
  onNewFolder: () => void
  onRefresh: () => void
  onSortKey: (key: PinnedSortKey) => void
  onSortDir: (dir: PinnedSortDir) => void
}

/**
 * 空白处右键菜单（任务口径）：新建文件夹 / 刷新 / 排序子菜单。
 * 写通道未就绪时「新建文件夹」置灰；排序是纯渲染层操作，永远可用。
 */
export function pinnedBlankMenuItems(
  prefs: PinnedViewPrefs,
  writeReady: boolean,
  actions: PinnedBlankMenuActions
): PinnedMenuItem[] {
  const sortChildren: PinnedMenuItem[] = (['name', 'mtime', 'size', 'kind'] as const).map(
    (key) => ({
      label: PINNED_SORT_KEY_LABEL[key],
      checked: prefs.sortKey === key,
      onClick: () => actions.onSortKey(key)
    })
  )
  sortChildren.push(
    'separator',
    {
      label: '升序',
      checked: prefs.sortDir === 'asc',
      onClick: () => actions.onSortDir('asc')
    },
    {
      label: '降序',
      checked: prefs.sortDir === 'desc',
      onClick: () => actions.onSortDir('desc')
    }
  )
  return normalizePinnedMenuItems([
    {
      label: '新建文件夹',
      icon: MENU_ICON_PLUS,
      disabled: !writeReady,
      onClick: actions.onNewFolder
    },
    { label: '刷新', icon: MENU_ICON_REFRESH, onClick: actions.onRefresh },
    'separator',
    { label: '排序', icon: MENU_ICON_SORT, children: sortChildren }
  ])
}

/* ────────────────────────────────────────────────────────────────────────────
 * 菜单图标几何（与 contextMenu.MENU_ICON 同一套 24×24 线性网格；这里只挑用得到的）
 * ──────────────────────────────────────────────────────────────────────────── */

const MENU_ICON_EXTERNAL = [
  'M14 4.5h5.5V10',
  'M19.5 4.5L11 13',
  'M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10'
] as const
const MENU_ICON_SLIDERS = ['M3.6 8h9.2M17.4 8h3M3.6 16h3.4M11.6 16h8.8', 'M15.6 5.6v4.8M9.8 13.6v4.8'] as const
const MENU_ICON_PENCIL = [
  'M4.2 19.8h3.5l10-10a2.5 2.5 0 0 0-3.5-3.5l-10 10z',
  'M14.2 7.6l2.4 2.4'
] as const
const MENU_ICON_COPY =
  'M9 9h9.5v9.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V10.5A1.5 1.5 0 0 1 9 9zM6.5 15H5a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V6' as const
const MENU_ICON_STACK = [
  'M12 3.6l8 4.2-8 4.2-8-4.2z',
  'M4 12.4l8 4.2 8-4.2',
  'M4 16.6l8 4.2 8-4.2'
] as const
const MENU_ICON_FOLDER =
  'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z' as const
const MENU_ICON_TRASH =
  'M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12.1A1.6 1.6 0 0 0 8.9 20.6h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7' as const
const MENU_ICON_PLUS = ['M12 5.5v13', 'M5.5 12h13'] as const
const MENU_ICON_REFRESH = [
  'M20.6 4.6v5h-5',
  'M3.4 19.4v-5h5',
  'M4.2 9.6a8 8 0 0 1 13.2-3l3.2 3M19.8 14.4a8 8 0 0 1-13.2 3l-3.2-3'
] as const
const MENU_ICON_SORT = ['M7.6 4.5v15M4.5 16.5l3.1 3 3.1-3', 'M16.4 19.5v-15M13.3 7.5l3.1-3 3.1 3'] as const

/* ────────────────────────────────────────────────────────────────────────────
 * 主进程写通道探针
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 写通道的**运行期探针**：主进程写通道（`fs:mkdir` / `fs:renameEntry` /
 * `fs:trashEntries` / `fs:extractArchive` / `fs:compressEntries` / `fs:openWith`，
 * 契约见 shared/ipc.ts「钉选目录浏览器 v2」段）未暴露前这里返回 `null` ——
 * 调用方据此把写操作按钮置灰 + toast「功能就绪中」。全部落地后无需改任何
 * 渲染层代码，探针自然返回真对象。
 *
 * ⚠️ 只在调用时碰 `window`（单测环境没有 window，但单测也不会调用它）。
 * 方法名与 preload 暴露一字不差（makePinnedDir / renamePinnedEntry /
 * trashPinnedEntries / extractPinnedArchive / compressPinnedEntries / openPinnedEntryWith）。
 */
export interface PinnedWriteApi {
  makePinnedDir(input: FsMkdirInput): Promise<FsMkdirResult>
  renamePinnedEntry(input: FsRenameEntryInput): Promise<FsRenameEntryResult>
  trashPinnedEntries(input: FsTrashEntriesInput): Promise<FsTrashEntriesResult>
  extractPinnedArchive(input: FsExtractArchiveInput): Promise<FsExtractArchiveResult>
  compressPinnedEntries(input: FsCompressEntriesInput): Promise<FsCompressEntriesResult>
  openPinnedEntryWith(input: FsOpenWithInput): Promise<FsOpenWithResult>
}

const WRITE_API_METHODS: readonly string[] = [
  'makePinnedDir',
  'renamePinnedEntry',
  'trashPinnedEntries',
  'extractPinnedArchive',
  'compressPinnedEntries',
  'openPinnedEntryWith'
]

/** 返回写通道 API；任一方法缺失返回 null（调用方置灰 + toast「功能就绪中」） */
export function pinnedWriteApi(): PinnedWriteApi | null {
  if (typeof window === 'undefined') return null
  const api = window.modvault as unknown as Record<string, unknown> | undefined
  if (!api) return null
  const allReady = WRITE_API_METHODS.every((m) => typeof api[m] === 'function')
  return allReady ? (api as unknown as PinnedWriteApi) : null
}

/** 「功能就绪中」的统一文案（主进程写通道未落地时写操作按钮的 toast） */
export const WRITE_NOT_READY_NOTICE = '功能就绪中，请稍候再试'

/**
 * 写通道失败 reason → 中文单行。
 *
 * 主进程契约（`FsWriteFailure`）已带可直接展示的 `error` 中文单行，调用方**优先
 * 展示 `error`**；这里只服务「需要按 reason 分支但拿不到 error」的兜底场景
 * （例如行内红框提示要与输入框并排显示的短文案）。
 */
export function writeReasonText(reason: FsWriteFailureReason): string {
  switch (reason) {
    case 'exists':
      return '名称已存在'
    case 'guard':
      return '路径越界，操作被拒绝'
    case 'invalid':
      return '名称含有不允许的字符'
    case 'io':
      return '磁盘操作失败'
    case 'no-7z':
      return '本机没有可用的解压组件'
    case 'not-archive':
      return '该文件不是压缩包'
    case 'too-many':
      return '一次最多处理 500 项'
    case 'system-fallback-failed':
      return '系统压缩引擎不可用'
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 缩略图与类型徽章（预览图显示 + 空格 Quick Look 增量）
 *
 * 契约（主进程并行落地中，渲染层一律探针后调用）：
 *   window.modvault.pinnedFileThumb({ pinId, dirRel, name }) →
 *     { ok: true; url: string } | { ok: false; reason: 'not-available' | 'io' }
 *   url 是专用协议（pinned-thumb://…），可直接当 <img src>。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 可请求缩略图的扩展名白名单（图片 + SketchUp；目录永远不请求） */
const THUMB_CAPABLE_EXTS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'skp']

/** 该条目是否值得请求缩略图（目录永远 false；其余按扩展名白名单，大小写不敏感） */
export function isThumbCapableName(entry: Pick<FsEntry, 'name' | 'isDir'>): boolean {
  if (entry.isDir) return false
  return THUMB_CAPABLE_EXTS.includes(extOf(entry.name))
}

/** 类型徽标色调（兜底视觉；色值全部走 token，映射见 `fileTypeBadge.tsx`） */
export type PinnedBadgeTone = 'su' | 'max' | 'cad' | 'd5a' | 'image' | 'generic'

export interface PinnedFileBadge {
  tone: PinnedBadgeTone
  /** 大字卡文案（SU / max / CAD / D5A）；图标兜底（image / generic）为空串 */
  label: string
}

/**
 * 文件名 → 兜底类型徽标（缩略图失败 / 不支持时的自绘视觉）。
 * 口径对齐 `AssetGrid.FileCover`：`.skp`→SU（系统蓝）、`.max`→max（3ds Max 青蓝）、
 * `.dwg`/`.dxf`→CAD（AutoCAD 红）、`.d5a`→D5A（品牌紫）；图片类用图片图标，
 * 其余通用文件图标。目录返回 null（调用方画文件夹图标）。
 */
export function fileTypeBadgeOf(entry: Pick<FsEntry, 'name' | 'isDir'>): PinnedFileBadge | null {
  if (entry.isDir) return null
  const ext = extOf(entry.name)
  if (ext === 'skp') return { tone: 'su', label: 'SU' }
  if (ext === 'max') return { tone: 'max', label: 'max' }
  if (ext === 'dwg' || ext === 'dxf') return { tone: 'cad', label: 'CAD' }
  if (ext === 'd5a') return { tone: 'd5a', label: 'D5A' }
  if (isImageName(entry)) return { tone: 'image', label: '' }
  return { tone: 'generic', label: '' }
}

/**
 * 缩略图缓存 key。dirRel 可能为空串（根目录），用 \u0000 分隔而非 `/`：
 * \u0000 在 Windows 文件名里不合法，绝不与「子目录段里恰好出现同名」撞车。
 */
export function thumbCacheKey(dirRel: string, name: string): string {
  return `${dirRel}\u0000${name}`
}

/**
 * 缩略图 URL 的组件级 LRU（上限 500 条）：切目录不清理，超限淘汰最久未用。
 * Map 的插入序 = 使用序：get 命中时把条目搬到末尾（刷新新鲜度），put 满时淘汰首项。
 */
export class ThumbUrlLru {
  private map = new Map<string, string>()

  constructor(private readonly cap: number) {}

  get(key: string): string | null {
    const url = this.map.get(key)
    if (url === undefined) return null
    this.map.delete(key)
    this.map.set(key, url)
    return url
  }

  put(key: string, url: string): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, url)
  }
}

/**
 * 主进程缩略图通道的**运行期探针**（与 `pinnedWriteApi` 同款做法）：
 * preload 未暴露 `pinnedFileThumb` 前返回 null —— 调用方直接走类型图标兜底，
 * 不发请求；主进程落地后自然接通，渲染层零改动。
 * ⚠️ 只在调用时碰 `window`（单测环境没有 window，单测也不会调用它）。
 */
export interface PinnedThumbApi {
  pinnedFileThumb(input: { pinId: string; dirRel: string; name: string }): Promise<
    { ok: true; url: string } | { ok: false; reason: 'guard' | 'not-available' | 'io'; error?: string }
  >
}

/** 返回缩略图通道 API；方法缺失返回 null（调用方走图标兜底） */
export function pinnedThumbApi(): PinnedThumbApi | null {
  if (typeof window === 'undefined') return null
  const api = window.modvault as unknown as Record<string, unknown> | undefined
  if (!api) return null
  return typeof api.pinnedFileThumb === 'function' ? (api as unknown as PinnedThumbApi) : null
}

/** Quick Look 的可预览序列：只含文件（目录不能快览），保持调用方传入的渲染顺序 */
export function quickLookFileNames(entries: readonly FsEntry[]): string[] {
  return entries.filter((e) => !e.isDir).map((e) => e.name)
}

/**
 * ←/→ 在文件序列里移动，**到边界不绕回**：越界返回 null = 原地不动。
 * 与 `logic/quickLook.stepSequence` 的差别：序列是文件名而非资产 id，且越界
 * 不夹取 —— 夹取到边界项会让「再按一下没反应」与「跳到了那一项」难以区分，
 * null 让调用方明确知道这次按键没移动。
 */
export function stepQuickLookFile(
  seq: readonly string[],
  currentName: string,
  delta: number
): string | null {
  const i = seq.indexOf(currentName)
  if (i < 0) return null
  const next = i + (delta >= 0 ? 1 : -1)
  if (next < 0 || next >= seq.length) return null
  return seq[next] ?? null
}
