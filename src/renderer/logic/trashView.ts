/**
 * 「最近删除」（库内回收区）的**纯逻辑**：软删判定 / 保留期换算 / 剩余天数文案。
 *
 * 为什么单独一个模块：这两件事要同时被 filters（视图互斥）、AssetGrid（剩余天数徽标）、
 * DetailPanel（顶部提示条）、Sidebar（计数徽标）使用；放在组件里就变成四份各自实现，
 * 「还剩几天」迟早出现四种算法。这里只做计算，不 import React / DOM / window。
 *
 * 磁盘语义（main 侧已实现，见 `src/main/trash.ts`）：
 * `<库根>/.trash/<id>/` 存资产目录本体，`<库根>/.trash/.meta/<id>.json` 存 deletedAt。
 * 渲染层只认 `Asset.deletedAt` / `Asset.trashRel` 两个字段（Dexie v5）。
 */
import type { Asset, TrashRetention } from '../../shared/types'

/** 一天的毫秒数（保留期换算） */
export const DAY_MS = 86_400_000

/**
 * 保留期档位 → 天数；`recycle` = 不进库内回收站（旧行为：直接进系统回收站）→ `null`。
 *
 * 与 `Settings.trashRetention` 一一对应，**不要**在这里出现第二套字符串（'5d' / '5'）。
 */
export function retentionDaysOf(retention: TrashRetention | null | undefined): number | null {
  switch (retention) {
    case '5d':
      return 5
    case '10d':
      return 10
    case '30d':
      return 30
    case 'recycle':
    default:
      return null
  }
}

/**
 * 设置页「删除保留期」四档的单选表（顺序固定：短 → 长 → 旧行为）。
 * `hint` 是选项下方的灰字说明，UI 直接渲染（不在组件里写文案，避免两处漂移）。
 */
export const RETENTION_OPTIONS: ReadonlyArray<{
  value: TrashRetention
  label: string
  hint: string
}> = [
  { value: '5d', label: '保留 5 天', hint: '过期后自动彻底删除（进系统回收站）' },
  { value: '10d', label: '保留 10 天', hint: '过期后自动彻底删除（进系统回收站）' },
  { value: '30d', label: '保留 30 天', hint: '默认：一个月内都能还原' },
  { value: 'recycle', label: '直接进系统回收站', hint: '不占用库内空间，但在应用内无法还原' }
]

/** 是否软删记录（`deletedAt` 是**有限数字**才算；undefined / 脏值一律当未删除） */
export function isDeletedAsset(a: Pick<Asset, 'deletedAt'> | null | undefined): boolean {
  return typeof a?.deletedAt === 'number' && Number.isFinite(a.deletedAt)
}

/** 回收站里的资产数（侧栏计数徽标 / 空态判断） */
export function countDeletedAssets(assets: readonly Asset[]): number {
  return assets.reduce((n, a) => n + (isDeletedAsset(a) ? 1 : 0), 0)
}

/**
 * 剩余保留天数（**向上取整**，`null` = 该档不自动清理 / 没有软删时间）。
 *
 * 返回值的三个区间（UI 文案据此分支，别在组件里再算一次）：
 * - `> 0`：还剩 N 天（刚删的 30 天档 → 30，不会显示 29）；
 * - `=== 0`：保留期正好走完（main 的 sweep 还没跑到）→「还剩 0 天」；
 * - `< 0`（固定为 -1）：**已过期但尚未被清理** →「已过期」。
 *
 * 为什么用 ceil 而不是 floor：删完立刻看是「还剩 30 天」比「还剩 29 天」符合直觉；
 * 反过来 floor 会让用户以为少了一天。
 */
export function remainingTrashDays(
  deletedAt: number | null | undefined,
  retention: TrashRetention | null | undefined,
  now: number = Date.now()
): number | null {
  const days = retentionDaysOf(retention)
  if (days === null) return null
  if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt)) return null
  const left = deletedAt + days * DAY_MS - now
  if (left > 0) return Math.ceil(left / DAY_MS)
  return left === 0 ? 0 : -1
}

/**
 * 卡片右上角 / 详情面板提示条的文案：
 * `还剩 14 天` / `还剩 0 天` / `已过期`；`recycle` 档或没有软删时间 → `null`（不渲染徽标）。
 */
export function trashBadgeText(
  deletedAt: number | null | undefined,
  retention: TrashRetention | null | undefined,
  now: number = Date.now()
): string | null {
  const days = remainingTrashDays(deletedAt, retention, now)
  if (days === null) return null
  if (days < 0) return '已过期'
  return `还剩 ${days} 天`
}

/** 详情面板顶部提示条文案（比卡片徽标更完整；`null` = 不该显示提示条） */
export function trashNoticeText(
  deletedAt: number | null | undefined,
  retention: TrashRetention | null | undefined,
  now: number = Date.now()
): string | null {
  const days = remainingTrashDays(deletedAt, retention, now)
  if (days === null) return null
  if (days < 0) return '已删除 · 已过保留期，下次清理时彻底删除'
  return `已删除 · 还剩 ${days} 天（到期后自动彻底删除）`
}
