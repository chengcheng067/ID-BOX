/**
 * 未分类整理流水线（P2 第一批）的**纯逻辑**。
 *
 * 零 React / 零 DOM / 零 `window.modvault` → 可直接进 vitest（`tests/triageFlow.test.ts`）。
 *
 * ## 它解决的问题
 *
 * 用户库里「未分类」一直是主要残留（历史自动分类漏分率约 62%）。原来的处理方式是
 * 逐条「点开 → 右栏指派 → 关掉 → 点下一张」，资产一多就是纯体力活。整理模式把这一串
 * 压成一次按键：一屏一张、选完分类按确认、自动前进。
 *
 * ## 为什么待办集由调用方传入（本模块不自己过滤软删）
 *
 * 与 `logic/quickLook.ts` 同一条纪律：**软删过滤的唯一实现点是 `matchesFilters`**。
 * 本模块再写一遍 `deletedAt` 判断就是第二套真相，两处迟早漂移（历史上「四处口径不同源」
 * 就是缓存 bug 的根因）。所以调用方传进来的 `ordered` 必须是**已经过 `applyFilters`
 * 的当前视图序列**，本模块只做「从里面挑未分类的」这一件事。
 *
 * 但「未分类」这个判据**必须**在这里定义（不能散在组件里）—— 见 `isUnclassified`。
 */

import type { Asset } from '../../shared/types'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { categoriesOf } from './category'

/**
 * 是否**双未分类**：一级与二级都是「未分类」。
 *
 * ## ⚠️ 与既有两处口径的差别（已报告 lead，不是笔误）
 *
 * 全仓现在有**三种**「未分类」说法：
 * 1. `logic/category.ts::countLevel1` —— 只数 `category1 === 未分类`
 *    （侧栏「未分类」节点上的数字就是它）；
 * 2. `App.tsx:798-801` 的中栏头计数 —— `category1 === 未分类 **||** category2 === 未分类`
 *    （一级选好了、二级还没填的也算"未分类"）；
 * 3. 本函数 —— 两级**都**是未分类。
 *
 * 整理流水线取第 3 种（需求原文就是「`category1 === '未分类' && category2 === '未分类'`」）。
 * 理由：整理模式的动作是「指派一对 (一级, 二级)」。一级已填、二级空着的资产
 * **已经是半归类状态**，把它塞进待办集会让用户以为要重头选一遍；而且确认后写的是
 * 同一对分类 → `assignCategory` 判 `skipped` 不动 → 表现为"按了确认没反应"。
 *
 * 这个差异**只影响整理待办集**，不动侧栏 / 中栏头既有的数字口径（那是另一件事）。
 */
export function isUnclassified(asset: Asset | null | undefined): boolean {
  if (!asset) return false
  const c = categoriesOf(asset)
  return c.category1 === UNCLASSIFIED && c.category2 === UNCLASSIFIED
}

/**
 * 从**当前视图序列**里挑出待办集（保序，不重排）。
 *
 * @param ordered 已经过 `applyFilters` 的资产序列（顺序 = 网格渲染顺序 = 当前排序）
 * @returns 双未分类的那些，顺序与入参完全一致
 *
 * 为什么保序而不是自己再排一遍：用户刚在中栏头切过排序（体积 / 时间 / 名称），
 * 整理模式里「下一张」必须与他在网格里看到的先后一致 —— 另排一遍会让"整理完回到网格，
 * 发现是跳着走的"。
 */
export function buildTriageQueue(ordered: readonly Asset[]): Asset[] {
  if (!Array.isArray(ordered)) return []
  return ordered.filter(isUnclassified)
}

/**
 * 待办集 **减去已跳过**。
 *
 * 跳过语义（需求：「跳过的资产本次不再出现」）：跳过的立刻从待办集消失，所以
 * `n / m` 的 `m` 会跟着变小 —— 这是刻意的，否则用户会觉得"跳过的还赖在队里"。
 * 但**不持久化**：关闭浮层就丢（用户可能只是那次不想定）。
 */
export function remainingQueue(queue: readonly Asset[], skipped: ReadonlySet<string>): Asset[] {
  if (!Array.isArray(queue)) return []
  if (!skipped || skipped.size === 0) return [...queue]
  return queue.filter((a) => !skipped.has(a.id))
}

/** 整理会话的游标状态（不可变；所有转移都是由下面的纯函数产出新对象） */
export interface TriageCursor {
  /** 待办集 id 序列（已扣掉跳过项） */
  readonly ids: readonly string[]
  /** 当前这张的 id；`null` = 没有可整理的（空集 / 已到尽头） */
  readonly currentId: string | null
  /** 本次会话已跳过的 id（只有"跳过"才写，归类成功**不写**） */
  readonly skipped: ReadonlySet<string>
}

/** 空会话 */
export const EMPTY_TRIAGE: TriageCursor = { ids: [], currentId: null, skipped: new Set() }

/**
 * 开一个新会话：待办集 + 落在第一张。
 *
 * @param queue 已排好序的待办集
 * @param skipped 延续下来的跳过集（正常进入时为空集）
 */
export function startTriage(
  queue: readonly Asset[],
  skipped: ReadonlySet<string> = new Set()
): TriageCursor {
  const ids = remainingQueue(queue, skipped).map((a) => a.id)
  return { ids, currentId: ids[0] ?? null, skipped }
}

/**
 * 当前这张在待办集里的下标（找不到 -1）。
 *
 * 调用方据此显示 `n / m`：`-1` 时显示「? / m」而不是骗人的 `1 / m`
 * （与 Quick Look 的 `quickLookIndexInSequence` 同口径）。
 */
export function triageIndex(cursor: TriageCursor): number {
  if (!cursor.currentId) return -1
  return cursor.ids.indexOf(cursor.currentId)
}

/**
 * 纯移动（**不改分类、不记跳过**）：`←` / `→`。
 *
 * 不 wrap（与 `stepSequence` 同一条理由）：绕回第一张时 `n / m` 会跳变，用户分不清
 * 是"走到尽头"还是"被系统重置"。
 *
 * @returns 新游标；到边界 / 位置未知时**原样返回同一个引用**（调用方可用 `===` 判无变化）
 */
export function stepTriage(cursor: TriageCursor, delta: number): TriageCursor {
  const i = triageIndex(cursor)
  if (i < 0) return cursor
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  if (step === 0) return cursor
  const next = Math.min(cursor.ids.length - 1, Math.max(0, i + step))
  if (next === i) return cursor
  return { ...cursor, currentId: cursor.ids[next] }
}

/**
 * 移除当前项，并把游标落到「**接位**」的那一张。
 *
 * 这是三个转移（跳过 / 归类成功 / 外部重建）共用的底层动作，区别只在于
 * `recordSkip` 要不要把当前 id 记进跳过集：
 * - 跳过 → 记（本次不再出现）；
 * - 归类成功 → **不记**（那张已经移出未分类，不该被当成"用户跳过"）。
 *
 * 落点规则（`direction` 决定"下一张"往哪边找）：
 * | 方向 | 移除后落点 | 场景 |
 * |---|---|---|
 * | `forward` | 原下标位置（= 原来的下一张顶上来） | 归类成功、`→` 跳过 |
 * | `backward` | 原下标 - 1 | `←` 跳过（往回走） |
 * 两者都夹到 `[0, len-1]`；移除后为空 → `currentId = null`（调用方据此关浮层）。
 */
function removeCurrent(
  cursor: TriageCursor,
  opts: { recordSkip: boolean; direction: 'forward' | 'backward' }
): TriageCursor {
  if (!cursor.currentId) return cursor
  const i = triageIndex(cursor)
  if (i < 0) return cursor
  const skipped = opts.recordSkip ? new Set(cursor.skipped).add(cursor.currentId) : cursor.skipped
  const ids = cursor.ids.filter((id) => id !== cursor.currentId)
  if (ids.length === 0) return { ids, currentId: null, skipped }
  const raw = opts.direction === 'forward' ? i : i - 1
  const at = Math.min(ids.length - 1, Math.max(0, raw))
  return { ids, currentId: ids[at], skipped }
}

/**
 * 跳过当前这张（`J` / `K`）：记进跳过集并换一张。**不改分类。**
 *
 * @param direction `forward`（`J`，默认）/ `backward`（`K`）
 */
export function skipCurrent(
  cursor: TriageCursor,
  direction: 'forward' | 'backward' = 'forward'
): TriageCursor {
  return removeCurrent(cursor, { recordSkip: true, direction })
}

/**
 * 归类成功后前进：当前这张**已被成功归类**，从待办集移除再前进。
 *
 * 与 `skipCurrent` 的唯一差别是**不写 `skipped`** —— 那张已经归类走了，不该被记成
 * "用户跳过"，否则重建会话时会莫名少一张。
 */
export function advanceAfterAssign(cursor: TriageCursor): TriageCursor {
  return removeCurrent(cursor, { recordSkip: false, direction: 'forward' })
}

/**
 * 待办集被外部变化（排序变了 / 资产被删 / 归类后不在视图里）重建后，把游标**稳到合法位置**。
 *
 * 三条规则（顺序不能变）：
 * 1. 当前 id 仍在新待办集里 → 原地不动（不因为"前面少了几个"就跳走）；
 * 2. 当前 id 不在了（被删 / 被归类）→ 落到**它原来的下标位置**（新的那张接位），
 *    越界夹到末尾。用户的感觉是"这张没了，下一张顶上来"，而不是"跳到别处"；
 * 3. 新待办集为空 → `currentId = null`（调用方据此关闭浮层，不悬空）。
 *
 * @param cursor 原游标
 * @param queue 重建后的完整待办集（**不含**扣减跳过，本函数内部会扣）
 */
export function reconcileTriage(cursor: TriageCursor, queue: readonly Asset[]): TriageCursor {
  const ids = remainingQueue(queue, cursor.skipped).map((a) => a.id)
  if (ids.length === 0) return { ids, currentId: null, skipped: cursor.skipped }
  if (cursor.currentId && ids.includes(cursor.currentId)) {
    // 规则 1：还在就原地不动。序列完全一致时连对象都复用，避免无意义重渲染。
    const same = ids.length === cursor.ids.length && ids.every((id, k) => id === cursor.ids[k])
    return same ? cursor : { ids, currentId: cursor.currentId, skipped: cursor.skipped }
  }
  // 规则 2：接位到原下标（原下标未知 → 回到第一张）
  const oldIndex = cursor.currentId ? cursor.ids.indexOf(cursor.currentId) : -1
  const at = oldIndex >= 0 ? Math.min(oldIndex, ids.length - 1) : 0
  return { ids, currentId: ids[at], skipped: cursor.skipped }
}

/**
 * 关闭整理模式的收尾提示（需求：「未分类已清空」/「还剩 N 张」）。
 *
 * @param remainingTotal 本次会话结束后**库里**仍未分类的总数。由调用方现算，
 *   不用 `cursor.ids.length` —— 那个扣掉了本次跳过项，而跳过项下次进来还在待办集里。
 */
export function triageCloseNotice(remainingTotal: number): string {
  const n = Number.isFinite(remainingTotal) ? Math.max(0, Math.trunc(remainingTotal)) : 0
  if (n === 0) return '未分类已清空'
  return `还剩 ${n} 张未分类`
}

/**
 * 整理模式的键位判定结果。
 *
 * | 结果 | 含义 |
 * |---|---|
 * | `prev` / `next` | **纯移动**（`←`/`→`）：不改分类、不记跳过 |
 * | `skipPrev` / `skipNext` | **跳过**（`K`/`J`）：不改分类，但本次不再出现 |
 * | `confirm` | 确认归类（`Enter`） |
 * | `close` | 关闭 —— **永远不会被返回**（Esc 走 `useEscLayer`），只为把语义写全 |
 * | `none` | 不管 |
 */
export type TriageKeyAction = 'prev' | 'next' | 'skipPrev' | 'skipNext' | 'confirm' | 'close' | 'none'

export interface TriageKeyInput {
  /** `KeyboardEvent.key` */
  key: string
  /** 焦点是否在可输入控件里（分类面板可能有自由输入框） */
  typing?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** 按住不放产生的重复事件 */
  repeat?: boolean
  /** 分类面板是否正展开（展开时 Enter / ↑↓ 归面板自己的高亮与选中） */
  panelOpen?: boolean
  /** 是否正在提交（防连按 Enter 重复归类） */
  busy?: boolean
}

/**
 * 整理模式的键位（**全部判据集中在这里**，组件只做 dispatch）。
 *
 * 键位表：
 * - `←` / `→` → `prev` / `next`：**纯移动**，什么都不改（先扫一遍看看有什么）；
 * - `K` / `J` → `skipPrev` / `skipNext`：**跳过**，本次不再出现；
 * - `Enter` → `confirm`：确认归类（面板展开时不抢）；
 * - `Esc` → 本函数返回 `none`，交给 `useEscLayer`（见下）。
 *
 * ## 为什么 Esc 必须让路
 *
 * `useEscLayer` 的监听挂在 `window` **捕获**阶段、只让栈顶消费。本函数若也认 Esc，
 * 一次按键就会关两层（真机踩过这个形态）。所以这里显式 `return 'none'`，
 * 并把 `close` 保留在联合类型里只为把语义写全 —— 实际永不返回。
 *
 * ## 为什么 J/K 与 ←/→ 分开
 *
 * 需求里 J/K 归在「跳过」下（跳过 = 不改分类 + 本次不再出现），而 ←/→ 是「切换」。
 * 两者若合并成同一个动作，用户就没法"先翻两张看看这批有多难"而不把它们标记成跳过。
 *
 * ## 三条让路纪律（与 `decideQuickLookKey` 同源）
 *
 * ① `typing` 让路；② 修饰键让路；③ `repeat` 让路（按住 J 不放不该连跳半个库）。
 * 另加：`busy`（提交中）时除 Esc 外全部让路，防连按 Enter 重复归类。
 */
export function decideTriageKey(input: TriageKeyInput): TriageKeyAction {
  if (!input) return 'none'
  if (input.typing) return 'none'
  if (input.ctrlKey || input.metaKey || input.altKey) return 'none'
  if (input.repeat) return 'none'
  const key = input.key ?? ''
  // Esc 交给 `useEscLayer`（见函数头注释）
  if (key === 'Escape') return 'none'
  // 提交中：不给第二次确认（关闭仍走 Esc，不在这里）
  if (input.busy) return 'none'
  // 分类面板展开时，Enter / ↑↓ 归面板
  if (input.panelOpen) return 'none'

  if (key === 'ArrowRight') return 'next'
  if (key === 'ArrowLeft') return 'prev'
  if (key === 'j' || key === 'J') return 'skipNext'
  if (key === 'k' || key === 'K') return 'skipPrev'
  if (key === 'Enter') return 'confirm'
  return 'none'
}
