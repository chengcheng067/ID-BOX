/**
 * 多选（批量操作）的**纯逻辑**：范围选择 / 全选 / 可见集裁剪。
 *
 * 背景（2026-10 用户反馈「找不到多选删除」）：批量操作条与 `requestDelete` 早已存在，
 * 但入口只有 Ctrl/Cmd+点击 → 用户以为没有这个功能。补齐入口（复选框 / Shift 范围 /
 * Ctrl+A 全选 / 中栏头全选）后，选择语义必须收敛到**一个纯函数模块**，否则
 * 网格（grid）、列表（list）、重复视图（dup）三处渲染顺序各算一套，Shift 区间会错位。
 *
 * 三条不变量（所有调用方共享）：
 * ① 区间顺序 = **当前可见顺序**（`visibleIds` 的给定顺序，即渲染顺序），不是 `assets` 原序；
 * ② `selectedIds` 只允许包含**当前可见集里**的 id（切换筛选 / 视图后由
 *    `pruneToVisible` 裁掉不可见的）；
 * ③ 空数组 = 清空选择（全选 / 整组选中 / 取消全选共用同一入口）。
 *
 * 本模块不 import React / DOM / electron → 可直接进 vitest（`tests/selection.test.ts`）。
 */

/** 去重并剔除空值（保持首次出现的顺序） */
export function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Shift+点击的区间选择结果（**含两端**）。
 *
 * - `targetId` 不在可见集 → 返回 `[]`（不可见的东西不能被"范围选"进来）；
 * - 锚点缺失 / 锚点已不在可见集（被删、被筛掉、换了筛选）→ 退化为单点 `[targetId]`，
 *   不让"锚点丢了"变成"什么都没选中"——用户这一下点击必须有反馈；
 * - 区间按 `visibleIds` 给定顺序切片（**正向、反向区间结果都是可见顺序**，不反转）。
 *
 * @param anchorId 最后一次点击的资产 id（可为 null = 没有锚点）
 * @param targetId 本次 Shift+点击的资产 id
 * @param visibleIds 当前可见顺序（与网格 / 列表渲染顺序一致，可含重复项）
 */
export function selectRangeIds(
  anchorId: string | null | undefined,
  targetId: string,
  visibleIds: readonly string[]
): string[] {
  const order = dedupeIds(visibleIds)
  const target = order.indexOf(targetId)
  if (target === -1) return []
  const anchor = anchorId ? order.indexOf(anchorId) : -1
  if (anchor === -1) return [targetId]
  const from = Math.min(anchor, target)
  const to = Math.max(anchor, target)
  return order.slice(from, to + 1)
}

/**
 * 把选择裁剪到可见集：**保持可见顺序**，剔除已不可见的 id。
 *
 * 为什么要重排而不是单纯 filter：`selectedIds[0]` 被当作 `selectedId`（右栏详情），
 * 裁剪后若保留旧顺序，详情面板显示的可能是一个已经被筛掉的资产。
 */
export function pruneToVisible(ids: readonly string[], visibleIds: readonly string[]): string[] {
  const keep = new Set(ids)
  return dedupeIds(visibleIds).filter((id) => keep.has(id))
}

/** 是否「当前可见结果」已全部选中（中栏头按钮文案据此在「全选 / 取消全选」间切换） */
export function isAllSelected(ids: readonly string[], visibleIds: readonly string[]): boolean {
  const order = dedupeIds(visibleIds)
  if (order.length === 0) return false
  const selected = new Set(ids)
  return order.every((id) => selected.has(id))
}
