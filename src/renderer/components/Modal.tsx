import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { isTopEscLayer, popEscLayer, pushEscLayer } from '../logic/escLayer'
import { IconClose } from '../icons'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  /**
   * 点遮罩是否关闭弹窗（默认 `true`，与旧行为逐字符一致，其它调用点零改动）。
   *
   * 谁需要关掉它：**导入重复处置弹窗**（docs/27 T-07）。点遮罩 = 静默把整批按「跳过」处理，
   * 是本功能最危险的误操作（用户以为只是「点了一下旁边」），所以那里传 `false`。
   */
  dismissOnScrim?: boolean
  /**
   * 按 Esc 是否关闭弹窗（默认 `true`）。与 `dismissOnScrim` 并列，语义也并列。
   *
   * 谁需要关掉它：**导入重复处置弹窗**（docs/27 T-07 / 0.7.6 T-ESC 裁定）。那里的 Esc
   * 曾经等于 `submit(true)` ≡ 整批按「跳过」，与它自己关掉 `dismissOnScrim` 的理由
   * （防误触静默跳过）自相矛盾。本版裁定：Esc 也不许等同于跳过，取消导入只能点界面按钮。
   *
   * `false` 的语义是「**吃掉但不关**」：仍然占一层（否则 Esc 会继续往下传，传给 App 的
   * 全局快捷键去清选中 / 关掉下面那层视图），只是不触发 `onClose`。
   */
  dismissOnEsc?: boolean
  /**
   * 遮罩层的 z-index 类（默认 `z-50`）。
   *
   * 为什么需要可调：导入重复处置弹窗必须在**其它弹窗之上**（docs/27 §5.4）——
   * 第一批在等用户答复（最长 120s）时第二批在排队，若被设置/详情弹窗盖住，
   * 用户看不见它会以为导入卡死。仅该弹窗传 `z-[60]`。
   */
  zClass?: string
}

/**
 * 事件目标是否声明了「Esc 归我」（`data-esc-own`）。
 *
 * 为什么需要：`Modal` 的 Esc 监听挂在 `window` **捕获**阶段，早于任何输入框自己的
 * `onKeyDown`（React 的合成事件在冒泡阶段才跑）。设置 · 别名表格里的输入框要把 Esc
 * 解释成「回滚这条草稿」，而不是「关掉整个设置弹窗」——用属性把它标出来，
 * `Modal` 见到就让路（不 stop、不关），按键继续传给控件自己的处理函数。
 *
 * 用 DOM 属性而不是 prop：标记点在深层输入框上，层层传 prop 会污染组件树；
 * 而且这是「控件级临时语义」，只在获得焦点的那一个控件上成立。
 */
function escOwnedByControl(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('[data-esc-own]') !== null
}

/**
 * 通用弹窗（规范 §2：r14 + --shadow-modal，1px --border 描边）。
 *
 * Esc 由本组件统一处理（0.7.6 T-ESC）——此前 10 个浮层里谁吃 Esc 全靠各自手写，
 * 四份一模一样的 `keydown → Escape → stopPropagation → onClose` 各自维护，
 * 剩下六个干脆没有（按 Esc 会掉到 App 的全局快捷键去清选中）。
 *
 * 捕获阶段 + `stopPropagation`：App 的全局 Esc 挂在冒泡阶段，捕获阶段吃掉后它收不到，
 * 一次按键只关一层。多层弹窗/弹窗内浮层谁先吃，由 `logic/escLayer.ts` 的栈决定（栈顶优先）。
 */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
  dismissOnScrim = true,
  dismissOnEsc = true,
  zClass = 'z-50'
}: ModalProps) {
  // handler 存 ref：调用方普遍传内联箭头（`onClose={() => setX(null)}`），
  // 直接进依赖会让监听每次 render 都重挂，多弹窗在场时本层在栈里的位置会漂移。
  const handlerRef = useRef({ onClose, dismissOnEsc })
  handlerRef.current = { onClose, dismissOnEsc }

  useEffect(() => {
    const token = pushEscLayer()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 不是栈顶就原样放行：上面还有一层（后开的弹窗 / 弹窗内的浮层）要吃这次按键
      if (!isTopEscLayer(token)) return
      // 输入框声明了「Esc 归我」→ 不吃、不关，让控件自己回滚草稿
      if (escOwnedByControl(e.target)) return
      e.stopPropagation()
      if (!handlerRef.current.dismissOnEsc) return
      handlerRef.current.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popEscLayer(token)
    }
  }, [])

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClass} flex items-center justify-center p-6`}
      onClick={dismissOnScrim ? onClose : undefined}
    >
      <div
        className={`w-full ${width} max-h-[86vh] overflow-auto rounded-modal border border-line bg-card shadow-modal`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-card px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn btn-ghost !p-1.5" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
