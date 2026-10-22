import type { ReactNode } from 'react'
import { IconClose } from '../icons'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}

/** 通用弹窗（规范 §2：r14 + --shadow-modal，1px --border 描边） */
export function Modal({ title, onClose, children, width = 'max-w-lg' }: ModalProps) {
  return (
    <div className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
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
