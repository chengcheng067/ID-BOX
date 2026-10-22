/**
 * 拖拽归类（反馈 6d / docs/15 §6d）的**纯逻辑**——不 import React / DOM / window.modvault，
 * 可在 vitest 里直测。
 *
 * ## 为什么需要独立的拖拽通道
 *
 * 卡片本体上已经有一个拖拽手势：`AssetGrid` 的 `dragProps.onDragStart` 会调
 * `window.modvault.startDrag()` → 主进程 `webContents.startDrag()`。这是**系统级**拖出，
 * 一旦触发就交给操作系统，渲染层**再也收不到 HTML5 的 `drop`** —— 所以同一个手势
 * 不可能既「拖出到 SketchUp / D5」又「拖到左栏归类」。
 *
 * 两条通道的分工（不可合并）：
 * - **卡片本体** = 系统级拖出到建模软件（高频核心动作，保持原样）；
 * - **卡片上的归类抓手** = 应用内 HTML5 拖拽，载荷用自定义 MIME
 *   `application/x-idbox-asset`，`effectAllowed = 'move'`，**绝不调 `startDrag`**。
 *
 * 本文件覆盖：载荷序列化/解析、拖拽 id 集合决策（多选语义）、投放目标判定
 * （大类范围 + 是否已在目标分类）、撤销记录生成与分组、文案标签。
 */
import type { Asset, AssetKind } from '../../shared/types'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { normalizeCategoryPair } from '../../shared/naming'
import { categoriesOf, type KindScope } from './category'

/**
 * 应用内归类的拖拽 MIME。
 *
 * **不要**改成 `text/plain` / `text/uri-list`：那两个是系统拖出的常用类型，
 * 无法区分「系统级拖出」与「应用内归类」，左栏会把拖出去建模软件的卡片也当成投放。
 */
export const ASSET_DRAG_MIME = 'application/x-idbox-asset'

/**
 * 单次拖拽载荷的 id 上限（防御性封顶）。
 *
 * 拖拽载荷来自 DOM（`dataTransfer`），理论上可被外部脚本伪造；这里封顶是为了
 * 就算载荷异常也不会一次性放大成几千次 IPC + 磁盘移动。
 */
export const MAX_DRAG_IDS = 500

/** 归类撤销宽限期（毫秒）——与删除撤销同为 5 秒（docs/15 §6d 拍板） */
export const ASSIGN_GRACE_MS = 5_000

/** 去重 + 去空白 + 丢弃非字符串项（保序） */
function dedupeIds(ids: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 是否携带「应用内归类」载荷（App 的全窗导入逻辑、左栏节点都用它过滤） */
export function hasAssetDragPayload(types: readonly string[] | null | undefined): boolean {
  if (!types) return false
  return types.includes(ASSET_DRAG_MIME)
}

/**
 * 序列化拖拽载荷：JSON 数组（只放资产 id，不放路径）。
 *
 * 只传 id 的理由：路径可能含 `\` / 非 ASCII，跨进程编码容易出岔子；id 是 UUID，
 * 渲染层随时能从 store 查到当前 folder（磁盘真相由 store 侧 IPC 计算）。
 */
export function serializeDragIds(ids: readonly string[]): string {
  return JSON.stringify(dedupeIds(ids).slice(0, MAX_DRAG_IDS))
}

/**
 * 解析拖拽载荷。**任何非法输入都返回 `[]`**（不抛）——
 * 拖拽载荷可能被外部程序写入（如从浏览器拖进一段 JSON 文本），
 * 解析失败只应静默忽略，绝不能让 UI 崩掉。
 */
export function parseDragIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const strings = parsed.filter((v): v is string => typeof v === 'string')
  return dedupeIds(strings).slice(0, MAX_DRAG_IDS)
}

/**
 * 抓手拖动时应该带走哪些资产：
 * - 该卡片**已在多选集合里** → 拖全部选中项（批量归类，与批量删除/批量指派的语义一致）；
 * - 否则只拖这一张。
 *
 * 注意 `selectedIds` 为单元素时两条分支结果相同，无需特判。
 */
export function dragIdsOf(assetId: string, selectedIds: readonly string[]): string[] {
  const inSelection = selectedIds.includes(assetId)
  return dedupeIds(inSelection ? selectedIds : [assetId]).slice(0, MAX_DRAG_IDS)
}

/** 节点的大类范围是否覆盖该资产的 kind（「材质」分组 = texture + material） */
function scopeHas(scope: KindScope, kind: AssetKind): boolean {
  return typeof scope === 'string' ? scope === kind : scope.includes(kind)
}

/** 分类对展示文案：一级 / 二级；二级为哨兵时只显示一级 */
export function categoryPairLabel(category1: string, category2: string): string {
  const c1 = (category1 ?? '').trim() || UNCLASSIFIED
  const c2 = (category2 ?? '').trim() || UNCLASSIFIED
  return c2 === UNCLASSIFIED ? c1 : `${c1} / ${c2}`
}

/** 一个可投放的分类节点（一级节点 = category2 为 UNCLASSIFIED） */
export interface DropNode {
  /** 该节点管辖的大类范围（侧栏「材质」分组同时覆盖 texture / material） */
  scope: KindScope
  category1: string
  category2: string
}

/** 投放判定结果（纯数据，供组件决定「移动 / 提示 / 静默」） */
export interface DropPlan {
  /** 可直接交给 `assignCategoryWithUndo` 的 id（在范围内、且不在目标分类） */
  ids: string[]
  /** 载荷里的唯一 id 数 */
  total: number
  /** 已在目标分类、无需移动的个数 */
  already: number
  /** 不属于该节点大类范围、被跳过的个数（>0 时组件应整批取消并提示） */
  outOfScope: number
  /** 载荷里在索引中找不到的 id 数（陈旧 DOM / 刚被删除） */
  unknown: number
  /** 规范化后的目标分类对（与 store 的 assignCategory 完全同源） */
  category1: string
  category2: string
  /** 展示文案「一级 / 二级」 */
  label: string
}

/**
 * 投放判定。
 *
 * 三条规则：
 * ① **范围过滤**：节点所属大类不含该资产 kind → 计入 `outOfScope`（跨大类批量指派
 *    在本应用里一律禁止——`CategoryPicker` 同样禁用，父目录永远由 `asset.kind` 算）；
 * ② **幂等过滤**：已在目标分类 → 计入 `already`，不进入 `ids`（否则 main 的
 *    `uniqueName` 会把它自己误判成重名，no-op 变成「名字-2」）；
 * ③ **未知 id**：索引里没有 → 计入 `unknown` 并丢弃（不猜测）。
 *
 * 目标分类经过 `normalizeCategoryPair`（与 store 同一函数）→ 判定与真实落盘一致。
 */
export function planDropAssign(
  assets: readonly Asset[],
  ids: readonly string[],
  node: DropNode
): DropPlan {
  const pair = normalizeCategoryPair(node.category1, node.category2)
  const wanted = new Set(dedupeIds(ids))
  const found = new Set<string>()
  const movable: string[] = []
  let already = 0
  let outOfScope = 0

  for (const a of assets) {
    if (!wanted.has(a.id)) continue
    found.add(a.id)
    if (!scopeHas(node.scope, a.kind)) {
      outOfScope += 1
      continue
    }
    const cur = categoriesOf(a)
    if (cur.category1 === pair.category1 && cur.category2 === pair.category2) {
      already += 1
      continue
    }
    movable.push(a.id)
  }

  return {
    ids: movable,
    total: wanted.size,
    already,
    outOfScope,
    unknown: wanted.size - found.size,
    category1: pair.category1,
    category2: pair.category2,
    label: categoryPairLabel(pair.category1, pair.category2)
  }
}

/** 撤销记录：某资产归类**之前**的分类对（快照，只在归类成功后登记） */
export interface AssignUndoRecord {
  id: string
  category1: string
  category2: string
}

/**
 * 归类前快照：按 `assets` 顺序取每条的 `category1/category2`（缺字段兜底为未分类）。
 * 只收录 `ids` 里的资产，未知 id 忽略。
 */
export function buildAssignUndo(
  assets: readonly Asset[],
  ids: readonly string[]
): AssignUndoRecord[] {
  const wanted = new Set(dedupeIds(ids))
  const out: AssignUndoRecord[] = []
  for (const a of assets) {
    if (!wanted.has(a.id)) continue
    const cur = categoriesOf(a)
    out.push({ id: a.id, category1: cur.category1, category2: cur.category2 })
  }
  return out
}

/** 撤销分组：同一个原分类的资产合成一批（`assignCategory` 一次只接受一个分类对） */
export interface AssignUndoGroup {
  category1: string
  category2: string
  ids: string[]
}

/**
 * 按「原分类对」分组（首见顺序稳定）。
 *
 * 为什么必须分组：`assignCategory(ids, c1, c2)` 的签名是**一个**分类对，
 * 而一次拖拽里的资产可能来自不同分类（多选跨分类太常见）——不分组就只能
 * 全部搬回某一个分类，撤销会毁数据。
 */
export function groupAssignUndo(records: readonly AssignUndoRecord[]): AssignUndoGroup[] {
  const groups = new Map<string, AssignUndoGroup>()
  for (const r of records) {
    // 用 JSON 数组做 key 而不是 `一级\u0000二级` 裸拼接：分类名理论上可能含分隔符
    // （`cleanSegment` 只清 Windows 非法字符，不保证不含 \u0000 之外的怪字符），
    // 裸拼接会让两个不同分类对撞成同一组 → 撤销搬错目录。JSON 序列化无碰撞。
    const key = JSON.stringify([r.category1, r.category2])
    const existed = groups.get(key)
    if (existed) {
      existed.ids.push(r.id)
      continue
    }
    groups.set(key, { category1: r.category1, category2: r.category2, ids: [r.id] })
  }
  return [...groups.values()]
}
