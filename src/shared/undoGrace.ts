/**
 * 删除撤销宽限期（2026-10 用户需求原话：「删除是否要等 5 秒在设置里面给用户权限，
 * 因为不是所有用户都需要等 5 秒撤销的。」）
 *
 * 三档，**只有这三个合法值**：
 * - `0`      = 不等待：**仍然二次确认**，但确认后立即移入回收站 / 「最近删除」，
 *              不进入 `grace` 阶段（于是底部撤销条不会出现，见 `NoticeToast`）；
 * - `3000`   = 3 秒反悔时间；
 * - `5000`   = 5 秒（默认，与本次改动之前的行为逐毫秒一致）。
 *
 * 为什么放在 `shared/`：主进程写档归一化（`main/settings.ts` 的 zod schema +
 * `normalizeSettings` / `migrateSettings`）、渲染层的设置 UI 与删除链路文案都要用。
 * 两边各写一份 clamp 的必然结果是漂移（设置页显示 3 秒、实际等 5 秒这类 bug），
 * 所以**唯一真源**在这里。
 *
 * ⚠️ 语义边界：这里只决定**渲染层等多久**。落盘路径（`trashPaths` / 软删到
 * `.trash/`）与保留期（`trashRetention`）完全不受影响 —— 宽限期只是"推迟调用"。
 */

/** 合法取值（升序；设置页的三档分段控件按这个顺序渲染） */
export const UNDO_GRACE_VALUES = [0, 3000, 5000] as const

/** 合法取值类型（`0 | 3000 | 5000`） */
export type UndoGraceMs = (typeof UNDO_GRACE_VALUES)[number]

/** 默认档 = 5 秒（旧行为；老用户升级后不感知任何变化） */
export const DEFAULT_UNDO_GRACE_MS: UndoGraceMs = 5000

/** 类型守卫：只有 `0 / 3000 / 5000` 这三个数字算合法 */
export function isUndoGraceMs(v: unknown): v is UndoGraceMs {
  return v === 0 || v === 3000 || v === 5000
}

/**
 * 归一到三档（**绝不抛错**）。
 *
 * 脏值（`9999` / `'abc'` / `null` / `undefined` / `NaN` / 缺键）一律回落默认 5000：
 * 这一项坏掉只丢这一项，绝不能让整份 settings.json 回退（否则 `libraryDir` 一起丢，
 * 用户的库会"消失"）。
 *
 * ⚠️ 不要用 `Number(v) || DEFAULT` 之类的写法：`0` 是**合法值**（不等待），
 * `||` 会把 0 当成 falsy 吃掉，用户设了「不等待」却仍然等 5 秒。
 */
export function normalizeUndoGraceMs(v: unknown): UndoGraceMs {
  return isUndoGraceMs(v) ? v : DEFAULT_UNDO_GRACE_MS
}
