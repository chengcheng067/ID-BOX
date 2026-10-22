import type { ReactNode } from 'react'
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
   * 遮罩层的 z-index 类（默认 `z-50`）。
   *
   * 为什么需要可调：导入重复处置弹窗必须在**其它弹窗之上**（docs/27 §5.4）——
   * 第一批在等用户答复（最长 120s）时第二批在排队，若被设置/详情弹窗盖住，
   * 用户看不见它会以为导入卡死。仅该弹窗传 `z-[60]`。
   */
  zClass?: string
}

/** 通用弹窗（规范 §2：r14 + --shadow-modal，1px --border 描边） */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
  dismissOnScrim = true,
  zClass = 'z-50'
}: ModalProps) {
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
