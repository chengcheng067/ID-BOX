/**
 * 「删除撤销期」的**文案**（纯函数，可单测）。
 *
 * 为什么要抽出来：`5 秒内可撤销` 这句话原先在 6 处硬编码（右键菜单、详情面板 ×3、
 * 确认弹窗、重复对比弹窗）。设置里新增三档后，任何一处没跟着改都会出现
 * 「设置写 3 秒、弹窗说 5 秒」这类自相矛盾的提示 —— 所以文案只在这里生成。
 *
 * 口径（与 `shared/undoGrace.ts` 的三档一致）：
 * - `5000` → 「5 秒内可撤销」
 * - `3000` → 「3 秒内可撤销」
 * - `0`    → 「没有撤销期」（注意：**二次确认仍然在**，只是没有倒计时/撤销条）
 *
 * 脏值走 `normalizeUndoGraceMs` 回落 5000，因此文案永远不会出现 `undefined 秒`。
 */
import {
  normalizeUndoGraceMs,
  type UndoGraceMs
} from '../../shared/undoGrace'

/** 设置页三档分段控件的一项（值 / 主标签 / 副说明） */
export interface UndoGraceOption {
  value: UndoGraceMs
  label: string
  hint: string
}

/**
 * 三档选项（**升序**：不等待 → 3 秒 → 5 秒）。
 *
 * 顺序与"等待时长"同向，用户扫一眼就知道越靠右等得越久；5 秒带「默认」标记，
 * 与 `RETENTION_OPTIONS`（删除保留期）的标注方式一致。
 */
export const UNDO_GRACE_OPTIONS: UndoGraceOption[] = [
  {
    value: 0,
    label: '不等待',
    hint: '确认后立即移入回收站，没有撤销倒计时；二次确认仍在'
  },
  {
    value: 3000,
    label: '3 秒',
    hint: '确认后有 3 秒反悔时间'
  },
  {
    value: 5000,
    label: '5 秒',
    hint: '默认。确认后有 5 秒反悔时间'
  }
]

/** 档位对应的秒数（0 → 0；用于倒计时/文案，永不返回 NaN） */
export function undoGraceSeconds(ms: number): number {
  return normalizeUndoGraceMs(ms) / 1000
}

/**
 * 句子片段：`5 秒内可撤销` / `3 秒内可撤销` / `没有撤销期`。
 * 用在括号里（`（二次确认，5 秒内可撤销）`），不带句首标点。
 */
export function undoGraceSuffix(ms: number): string {
  const seconds = undoGraceSeconds(ms)
  return seconds > 0 ? `${seconds} 秒内可撤销` : '没有撤销期'
}

/**
 * 轻提示整句：`已移入回收站，5 秒内可撤销` / `已移入回收站，没有撤销期`。
 * 供 `requestDelete(ids, { notice })` 的场景化提示用（重复资产那两条链路）。
 */
export function undoGraceHint(ms: number): string {
  return `已移入回收站，${undoGraceSuffix(ms)}`
}
