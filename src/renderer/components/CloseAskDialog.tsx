import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { CloseAnswer, CloseAskPayload } from '../../shared/types'

/**
 * 「关闭窗口」询问弹窗（2026-11 用户需求）。
 *
 * 用户原话：
 * > 「那我需要有弹窗。如果用户没有在弹窗上默认勾选"记住"的设置，那么以后都会弹窗，
 * >   点关闭的话，然后就是改退至后台」
 *
 * 已拍板口径（逐条对齐）：
 * 1 点主窗口 ✕ 时**弹窗询问**，两个按钮「彻底退出」/「退至后台」，不静默执行；
 * 2 弹窗带「记住我的选择，以后不再询问」复选框，**默认不勾** ——
 *   不勾 → 以后每次关窗都问；勾了 → 记住本次动作，以后不再问；
 * 3 右上角 ✕ 与 Esc **都无效**（`showCloseButton={false}` + `dismissOnEsc={false}`
 *   + `dismissOnScrim={false}`），用户必须明确点两个按钮之一；
 * 4 术语统一为「**退至后台**」，不写「收进托盘」。
 *
 * 结构：
 * ```
 * [标题] 关闭 ID BOX
 * ────────────────────────────────────────────────
 * 要把 ID BOX 退至后台继续运行，还是彻底退出？
 * ☐ 记住我的选择，以后不再询问
 *    随时可在「设置 · 外观 · 窗口与后台」改回来
 *                          [彻底退出]  [退至后台]
 * ```
 *
 * ⚠️ 复选框**自绘**（16×16：勾选 = `--accent` 底 + 白勾 SVG，未勾 = 1px `--border`
 * 描边 + 透明底）—— 用户明确要求「不要系统的默认控件」，原生 `<input type="checkbox">`
 * 是本项目红线（历史上 sortMenu / CategoryPicker / checkbox 三轮都因原生控件返工）。
 *
 * ⚠️ 收到主进程的 `closeAskExpired`（15s 超时，兜底动作「退至后台」）时必须**自己关掉**：
 * 否则弹窗会挂在屏幕上，而用户之后点按钮只会命中主进程的 stale 分支（幂等丢弃），
 * 表现为「点了没反应、弹窗不关」（DEF-19-1 同类问题）。宿主（App）负责清 `closeAsk`，
 * 本组件因此是**受控**的：`ask` 变 null 即卸载。
 */
export function CloseAskDialog({
  ask,
  onResolved
}: {
  /** 主进程发来的询问；null = 不显示（由 App 订阅 `onCloseAsk` 写入） */
  ask: CloseAskPayload | null
  /** 用户点了两个按钮之一、或询问已作废 → 通知宿主清空 `ask` */
  onResolved: () => void
}) {
  /** 复选框状态：**默认不勾**（用户明确要求），且每次新的询问都重新从 false 起 */
  const [remember, setRemember] = useState(false)
  /** 提交中闩锁：防连点把同一条答复 invoke 两次 */
  const [submitting, setSubmitting] = useState(false)
  /** 只处理**当前**这条 requestId：新询问到达时重置上面的本地状态 */
  const lastRequestIdRef = useRef<string | null>(null)

  useEffect(() => {
    const requestId = ask?.requestId ?? null
    if (requestId === lastRequestIdRef.current) return
    lastRequestIdRef.current = requestId
    // 新一条询问（或清空）：复选框回到未勾选、提交闩锁复位
    setRemember(false)
    setSubmitting(false)
  }, [ask])

  /**
   * 回一个答复给主进程。
   *
   * 顺序刻意：**先同步通知宿主清空**（`onResolved`）再发 IPC —— 与 `answerConflict`
   * 同款纪律：主进程可能已经超时、根本不理这条答复（回 `phase:'stale'`），若等返回值
   * 再清，弹窗会卡在屏幕上。任何用户点击都必须立刻让弹窗消失，与 IPC 成败无关。
   */
  const submit = useCallback(
    (action: 'quit' | 'tray') => {
      if (submitting || !ask) return
      setSubmitting(true)
      const answer: CloseAnswer = { requestId: ask.requestId, action, remember }
      onResolved()
      void window.modvault.answerClose(answer).catch(() => {
        // 主进程已不可达：答复必然已被超时兜底接住（退至后台），UI 已经收场
      })
    },
    [ask, onResolved, remember, submitting]
  )

  // 关窗询问**没有"取消"**：`ask` 为 null 时什么也不渲染。
  // 这里不给 Modal 传 onClose 的语义出口（✕ 不渲染、Esc / 遮罩都被吃掉），
  // 传一个空实现只为满足签名 —— 它永远不会被触发。
  if (!ask) return null
  const noop = (): void => undefined

  return (
    <Modal
      title="关闭 ID BOX"
      onClose={noop}
      dismissOnScrim={false}
      dismissOnEsc={false}
      showCloseButton={false}
      width="max-w-md"
    >
      <p className="text-[13px] leading-relaxed text-secondary">
        要把 ID BOX 退至后台继续运行，还是彻底退出？
      </p>

      <div className="mt-4">
        <button
          type="button"
          role="checkbox"
          aria-checked={remember}
          className="flex items-start gap-2 text-left"
          onClick={() => setRemember((v) => !v)}
        >
          {/* 自绘复选框 16×16（禁原生控件）：勾选 = accent 底 + 白勾；未勾 = 描边 + 透明底 */}
          <span
            aria-hidden="true"
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition ${
              remember ? 'border-accent bg-accent text-white' : 'border-line bg-transparent'
            }`}
          >
            {remember && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
          </span>
          <span className="text-[13px] leading-[1.35] text-primary">
            记住我的选择，以后不再询问
          </span>
        </button>
        <p className="mt-1 pl-6 text-[12px] leading-relaxed text-muted">
          随时可在「设置 · 外观 · 窗口与后台」改回来
        </p>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" disabled={submitting} onClick={() => submit('quit')}>
          彻底退出
        </button>
        <button
          className="btn btn-primary"
          disabled={submitting}
          onClick={() => submit('tray')}
        >
          退至后台
        </button>
      </div>
    </Modal>
  )
}
