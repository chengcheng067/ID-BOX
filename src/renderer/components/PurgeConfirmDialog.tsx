import { useState } from 'react'
import { useVault } from '../store'
import { Modal } from './Modal'
import { formatBytes } from '../../shared/format'
import { IconAlert, IconTrash } from '../icons'

/**
 * 「彻底删除」二次确认（C 线「最近删除」）。
 *
 * 与 `ConfirmDialog`（软删 / 旧回收站路径）分成两个组件的原因：
 * - `ConfirmDialog` 绑定的是 store 里的 `pendingDelete`（一次性全局状态，含 5 秒撤销）；
 * - 彻底删除**没有撤销**，也就不该复用"确认后还有 5 秒"的那套文案与状态机。
 *
 * 用法：调用方持有 `ids`（null = 关闭），确认后自己 onClose；失败提示由 store 的 notice 给出。
 */
export function PurgeConfirmDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const assets = useVault((s) => s.assets)
  const purgeAssets = useVault((s) => s.purgeAssets)
  const [busy, setBusy] = useState(false)

  const targets = assets.filter((a) => ids.includes(a.id))
  const totalBytes = targets.reduce((n, a) => n + (Number.isFinite(a.size) ? a.size : 0), 0)

  const confirm = async () => {
    if (busy || targets.length === 0) return
    setBusy(true)
    try {
      await purgeAssets(targets.map((a) => a.id))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="彻底删除" onClose={busy ? () => undefined : onClose} width="max-w-md">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-danger">
          <IconAlert />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">
            {targets.length === 1 ? targets[0]!.name : `${targets.length} 个资产`}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {targets.length === 1
              ? `${targets[0]!.files.length} 个文件 · ${formatBytes(targets[0]!.size)}`
              : `合计 ${formatBytes(totalBytes)}`}
          </div>
        </div>
      </div>

      <p className="mt-3 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] leading-relaxed text-danger">
        彻底删除后<span className="font-semibold">无法在应用内还原</span>。文件会被移入 Windows
        回收站，需要时只能到系统回收站里找。
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="btn btn-outline-danger" onClick={() => void confirm()} disabled={busy}>
          <IconTrash />
          {busy ? '删除中…' : '彻底删除'}
        </button>
      </div>
    </Modal>
  )
}
