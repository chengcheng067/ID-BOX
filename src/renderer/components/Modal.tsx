import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  escOwnedByControl,
  getEscLayerRank,
  isTopEscLayer,
  popEscLayer,
  pushEscLayer,
  subscribeEscLayers
} from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'
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
 *
 * **层级（0.7.8 T-ZSTACK）**：遮罩的 z-index 不再写死 `z-50`，而是由本层在层栈里的位置算出
 * （第 1 层 50、第 2 层 60…，见 `logic/zStack.ts`）—— 用户要的「新点出来的弹窗层级更高」。
 * 关键点：`depth` 和「谁吃 Esc」读的是**同一个 token 的同一个栈位置**，所以视觉上在最上的
 * 那个弹窗，一定也是 Esc 的第一个应答者，不会出现「看着在上层、Esc 答下层」的错配。
 * 旧的可调 `zClass` 已删除：谁都不该再手写一个更大的数字去插队（`ImportConflictDialog`
 * 曾经写死 `z-[60]`，与本层栈并存时谁在上只取决于 DOM 顺序）。
 */
export function Modal({ title, onClose, children, width = 'max-w-lg', dismissOnScrim = true, dismissOnEsc = true }: ModalProps) {
  // handler 存 ref：调用方普遍传内联箭头（`onClose={() => setX(null)}`），
  // 直接进依赖会让监听每次 render 都重挂，多弹窗在场时本层在栈里的位置会漂移。
  const handlerRef = useRef({ onClose, dismissOnEsc })
  handlerRef.current = { onClose, dismissOnEsc }

  /** 本层在层栈里的位置（1 = 最底）；首帧还是 0 → `zClassForDepth(0)` 兜底成 `z-50` */
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    const token = pushEscLayer()
    // 深度与 Esc 应答同源：都读这一层 token 在同一个栈里的位置。
    // 订阅是为了「上面又开了一层 / 上面那层关了」时把本层重算一次（否则层级会卡在旧值）。
    const syncDepth = (): void => setDepth(getEscLayerRank(token))
    syncDepth()
    const unsubscribe = subscribeEscLayers(syncDepth)
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
      // 先退订再出栈：pop 会通知所有订阅者，本层正在卸载不该再被叫醒
      unsubscribe()
      window.removeEventListener('keydown', onKey, true)
      popEscLayer(token)
    }
  }, [])

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(depth)} flex items-center justify-center p-6`}
      onClick={dismissOnScrim ? onClose : undefined}
      data-modal-layer={depth}
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
