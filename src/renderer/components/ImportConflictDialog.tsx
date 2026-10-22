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
 * 三个**必须自己补**的行为（`Modal.tsx` 不提供，docs/27 T-07 验收判据）：
 * ① Esc → `cancelled:true`（`Modal` 不处理 keydown）；
 * ② 点遮罩**不关闭**（`dismissOnScrim={false}`）—— 遮罩误触 = 静默全跳过；
 * ③ ✕ 关闭 = 等同 `cancelled`。
 *
 * 没做焦点陷阱（项目无先例，`ConfirmDialog` 也没有）：靠原生 `<button>` 的 Tab/Enter 可达。
 * 层级用 `z-[60]` 压在其它弹窗之上（§5.4：导入等待答复最长 120s，被盖住会像卡死）。
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

  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 捕获阶段吃掉这次按键：否则 App 的全局 Esc 会顺手关掉底下的设置 / 文件视图 / 清空选择
      e.preventDefault()
      e.stopPropagation()
      submit(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // `submit` 闭包依赖 ask + state，故两者进依赖：任一变化都重新挂（代价可忽略）
  }, [ask, state, answerConflict])

  if (!ask) return null

  const remaining = remainingItemsText(ask.remainingItems, ask.items.length)

  return (
    <Modal
      title={conflictTitle(ask.items.length)}
      onClose={() => submit(true)}
      width="max-w-2xl"
      dismissOnScrim={false}
      zClass="z-[60]"
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
