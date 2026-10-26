/**
 * 删除安全流程（P0-16）的**纯逻辑**部分。
 *
 * 流程四步（store.ts 持有状态，这里只放可单测的计算）：
 *   requestDelete(ids)  → pendingDelete(stage='confirming')  弹 ConfirmDialog（二次确认）
 *   confirmDelete()     → pendingDelete(stage='grace')       弹撤销条，**倒计时开始**
 *                         （时长 = `pendingDelete.graceMs`，来自设置 `undoGraceMs`；
 *                          为 0「不等待」时**跳过本阶段**直接 commitDelete）
 *   undoDelete()        → 清空 pendingDelete                 什么都不删
 *   commitDelete()      → trashPaths + 删索引 + 删缩略图      到期自动触发，此时才真正删
 *
 * 铁律：宽限期内（confirming + grace 两个阶段）文件都必须还在磁盘上。
 */
import type { Asset } from '../../shared/types'
import { formatBytes } from '../../shared/format'

/** 撤销宽限期时长（毫秒） */
export const DELETE_GRACE_MS = 5_000

/** 确认弹窗里最多列出的资产名条数（多选时防止弹窗无限长） */
export const DELETE_SUMMARY_MAX_NAMES = 6

export interface DeleteTarget {
  id: string
  name: string
  size: number
  files: number
}

/** 从资产列表构造删除摘要目标（快照，宽限期内 assets 变化也不影响展示） */
export function toDeleteTargets(assets: Asset[]): DeleteTarget[] {
  return assets.map((a) => ({ id: a.id, name: a.name, size: a.size, files: a.files.length }))
}

export interface DeleteSummary {
  /** 主标题：单个=资产名；多个=`N 个资产` */
  title: string
  /** 副行：单个=`文件数 · 大小`；多个=`合计 X GB` */
  detail: string
  count: number
  totalBytes: number
}

/** 确认弹窗文案（P0-16：单个显示名称 + 大小 + 文件数；多选显示「N 个资产 · 合计 X GB」） */
export function describeDelete(targets: DeleteTarget[]): DeleteSummary {
  const count = targets.length
  const totalBytes = targets.reduce((s, t) => s + t.size, 0)
  if (count === 1) {
    const t = targets[0]!
    return {
      title: t.name,
      detail: `${t.files} 个文件 · ${formatBytes(t.size)}`,
      count,
      totalBytes
    }
  }
  return {
    title: `${count} 个资产`,
    detail: `合计 ${formatBytes(totalBytes)}`,
    count,
    totalBytes
  }
}

/** 宽限期剩余毫秒数（≥0，不因时钟回拨产生负数） */
export function remainingGraceMs(startedAt: number, now: number, graceMs: number = DELETE_GRACE_MS): number {
  return Math.max(0, startedAt + graceMs - now)
}

/** 宽限期剩余秒数（向上取整，倒计时展示用；3999ms → 4） */
export function graceSecondsLeft(startedAt: number, now: number, graceMs: number = DELETE_GRACE_MS): number {
  return Math.ceil(remainingGraceMs(startedAt, now, graceMs) / 1000)
}
