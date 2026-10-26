import { useEffect, useState } from 'react'
import { useVault } from '../store'
import { Modal } from './Modal'
import { formatBytes, formatDate } from '../../shared/format'
import {
  CONFLICT_RESOLUTIONS,
  RESOLUTION_LABEL,
  applyBatchDefault,
  buildConflictAnswer,
  conflictTitle,
  initialConflictState,
  isRowCustom,
  isStrongReason,
  otherCopiesText,
  reasonLabel,
  remainingItemsText,
  resolutionOf,
  setRowChoice,
  sizeDiffPercent,
  type ConflictDialogState
} from '../logic/importConflict'
import type { ImportConflictResolution } from '../../shared/types'

/**
 * 导入重复处置弹窗（docs/27 T-07）。
 *
 * 结构（§2.1）：
 * ```
 * [标题] 发现 N 个可能重复的素材                          [✕]
 * 还有 N 个源文件正在检查，若也有重复将按上方选择处理        ← 「其余」> 0 时
 * ────────────────────────────────────────────────
 * 其余重复项按此处理：  [跳过] [覆盖] [保留两者]            ← 批次默认档（默认「跳过」）
 * ────────────────────────────────────────────────
 * 源文件名                                    [同一件素材(ID)] · 486 MB
 *   库内已有：旧名   分类/子类   2026-09-12   512 MB
 *   ⚠ 体积差 5% · 可能不是同一套资产                        ← sizeMismatch 时
 *   库里还有 2 份同名副本（覆盖只处置上面这一份）            ← otherCopies > 0 时
 *   处置：[跳过] [覆盖] [保留两者]
 * ────────────────────────────────────────────────
 * 跳过/覆盖的语义说明（必读）
 *                                  [全部取消]  [确定]
 * ```
 *
 * 三条关闭口径（0.7.6 T-ESC 统一后）：
 * ① Esc **不关闭、也不等于跳过**（`dismissOnEsc={false}`）—— 本弹窗的「关闭」在这个
 *    上下文里只有一个含义：整批按「跳过」（`cancelled:true`），而「跳过」是用户对每个
 *    重复项做出的**处置决定**，不能由一个顺手的按键代劳。这与它关掉 `dismissOnScrim`
 *    的理由是同一个（docs/27 T-07：遮罩误触 = 静默全跳过），两处口径现在一致。
 *    注意 `false` 的语义是「吃掉但不关」：仍然占一层，按键不会落到 App 的全局 Esc 上去
 *    清空选中 / 关掉底下的视图。
 * ② 点遮罩**不关闭**（`dismissOnScrim={false}`）。
 * ③ ✕ 关闭 = 等同 `cancelled`（显式动作，保留）。
 *
 * 没做焦点陷阱（项目无先例，`ConfirmDialog` 也没有）：靠原生 `<button>` 的 Tab/Enter 可达。
 * 层级（0.7.8 T-ZSTACK）：**不再自己写死一个 60 的层级魔法数**，改由层栈深度算 —— 本弹窗天然是后开的那一层
 * 就是栈顶，`Modal` 会把它放到 60（甚至更高），与「Esc 先答它」同源。写死一个数字的时代，
 * 它和舞台球同为 60，谁在上只取决于 DOM 顺序（碰巧正确）。
 */
export function ImportConflictDialog() {
  const ask = useVault((s) => s.conflictAsk)
  const answerConflict = useVault((s) => s.answerConflict)
  const [state, setState] = useState<ConflictDialogState>(() => initialConflictState(null))

  const requestId = ask?.requestId ?? null

  // 换一次询问（requestId 变）= 重新开始：默认档回到 `ask.batchDefault`（恒为「跳过」），
  // 行内指定全部清空。只跟 requestId：同一个 ask 被重复推送时不该重置用户已经点过的选择。
  useEffect(() => {
    if (!requestId) return
    setState(initialConflictState(ask))
  }, [requestId])

  const submit = (cancelled: boolean) => {
    if (!ask) return
    // `answerConflict` 内部会清 `conflictAsk`（即使 IPC 失败也清），弹窗随之卸载
    void answerConflict(buildConflictAnswer(ask, state, cancelled))
  }

  if (!ask) return null

  const remaining = remainingItemsText(ask.remainingItems, ask.items.length)

  return (
    <Modal
      title={conflictTitle(ask.items.length)}
      onClose={() => submit(true)}
      width="max-w-2xl"
      dismissOnScrim={false}
      dismissOnEsc={false}
    >
      {remaining && <p className="mb-3 text-[12px] text-muted">{remaining}</p>}

      {/* 顶部 = 批次默认档：点一下等于「下面所有行都按这个来」（§2.1 用户显式动作） */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
        <span className="text-[12px] font-medium text-secondary">其余重复项按此处理：</span>
        <div className="flex gap-1.5">
          {CONFLICT_RESOLUTIONS.map((r) => (
            <ResolutionButton
              key={r}
              resolution={r}
              active={state.batchDefault === r}
              onClick={() => setState(applyBatchDefault(state, r))}
            />
          ))}
        </div>
      </div>

      {/* 明细：超过 8 行时列表区内部滚动（不折叠、不分页——用户需要一眼看全） */}
      <ul className="mt-3 max-h-[46vh] divide-y divide-line overflow-auto rounded-lg border border-line">
        {ask.items.map((it) => {
          const custom = isRowCustom(state, it.seq)
          const other = otherCopiesText(it.existing.otherCopies)
          return (
            <li key={it.seq} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium" title={it.item}>
                    {it.itemName}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className={isStrongReason(it.reason) ? 'chip-accent' : 'chip'}>
                      {reasonLabel(it.reason)}
                    </span>
                    <span>{formatBytes(it.size)}</span>
                  </div>
                </div>
              </div>

              <div className="mt-1.5 text-[12px] leading-relaxed text-secondary">
                <span className="text-muted">库内已有：</span>
                <span className="font-medium text-primary">{it.existing.name}</span>
                <span className="text-muted">
                  {' · '}
                  {it.existing.relFolder}
                  {' · '}
                  {formatDate(it.existing.importedAt).slice(0, 10)}
                  {' · '}
                  {formatBytes(it.existing.size)}
                </span>
              </div>

              {it.existing.sizeMismatch && (
                <p className="mt-1 text-[12px] text-danger">
                  ⚠ 体积差 {sizeDiffPercent(it.size, it.existing.size)}% · 可能不是同一套资产
                </p>
              )}
              {other && <p className="mt-1 text-[11px] text-muted">{other}</p>}

              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-[11px] text-muted">处置：</span>
                {CONFLICT_RESOLUTIONS.map((r) => (
                  <ResolutionButton
                    key={r}
                    resolution={r}
                    active={resolutionOf(state, it.seq) === r}
                    onClick={() => setState(setRowChoice(state, it.seq, r))}
                  />
                ))}
                {custom && <span className="text-[11px] text-accent-text">· 已单独指定</span>}
              </div>
            </li>
          )
        })}
      </ul>

      <div className="mt-3 space-y-0.5 text-[11px] leading-relaxed text-muted">
        <p>跳过 = 不导入，原文件保留在原位。</p>
        <p>覆盖 = 用新内容替换库里那份，旧版本进系统回收站（需清空回收站才真正释放空间）。</p>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={() => submit(true)}>
          全部取消
        </button>
        <button className="btn btn-primary" onClick={() => submit(false)}>
          确定
        </button>
      </div>
    </Modal>
  )
}

/** 三档小按钮（顶部批次档与行内处置共用同一套样式，选中走 accent tint） */
function ResolutionButton({
  resolution,
  active,
  onClick
}: {
  resolution: ImportConflictResolution
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`${active ? 'chip-accent' : 'chip-ghost'} !px-2.5 !py-1`}
      aria-pressed={active}
      onClick={onClick}
    >
      {RESOLUTION_LABEL[resolution]}
    </button>
  )
}
