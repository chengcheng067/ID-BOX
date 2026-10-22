/**
 * 导入队列的**纯逻辑**：
 * ① 失败文案（P0-3 空间不足的「可用 X GB / 需要 Y GB」）；
 * ② 终态条目的**自动消失时机**（2026-10 用户反馈：条目完成后不消失，连导多个包堆一屏）。
 */
import { humanGB } from '../../shared/space'
import type { ImportStatus } from '../../shared/types'

export function spaceShortageText(
  needBytes?: number | null,
  freeBytes?: number | null
): string | null {
  if (typeof needBytes !== 'number' || !Number.isFinite(needBytes) || needBytes <= 0) return null
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) return null
  return `可用 ${humanGB(freeBytes)} / 需要 ${humanGB(needBytes)}`
}

/** 队列条目的状态（`pending` 是渲染层自己加的，main 不会推） */
export type ImportQueueStatus = ImportStatus | 'pending'

/** 成功条目在队列里停留的时长（够看清「已归档到…」，又不至于堆屏） */
export const IMPORT_DONE_DISMISS_MS = 6000

/** 失败条目停留时长：错误信息需要更长时间读完（是成功态的两倍） */
export const IMPORT_ERROR_DISMISS_MS = 12000

/**
 * 该状态的条目应在「进入终态后」多久自动消失；`null` = **永不自动消失**。
 *
 * 只有 done / error 有倒计时：pending / extracting / organizing 是进行中，
 * 提前消失会让用户以为任务丢了（队列此刻正是唯一的进度反馈）。
 */
export function autoDismissDelayMs(status: ImportQueueStatus): number | null {
  if (status === 'done') return IMPORT_DONE_DISMISS_MS
  if (status === 'error') return IMPORT_ERROR_DISMISS_MS
  return null
}

/**
 * 从**绝对时间戳**算剩余停留时间（毫秒，≥0）；`null` = 不自动消失。
 *
 * 为什么需要它：队列支持「鼠标悬停暂停倒计时」。暂停/恢复不能靠 `setTimeout`
 * 的剩余量记忆（组件一重渲染就丢），而是每次都用 `settledAt + 延迟 - now` 重算：
 * - `settledAt` 缺失（老数据 / 进行中）→ 视作"刚刚进入终态"，返回完整时长；
 * - 已超时 → 0（立即移除）。
 */
export function dismissRemainingMs(
  status: ImportQueueStatus,
  settledAt: number | null | undefined,
  now: number
): number | null {
  const delay = autoDismissDelayMs(status)
  if (delay === null) return null
  if (typeof settledAt !== 'number' || !Number.isFinite(settledAt)) return delay
  const elapsed = Number.isFinite(now) ? now - settledAt : 0
  return Math.max(0, delay - elapsed)
}
