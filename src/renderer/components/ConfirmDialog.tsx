import { useVault } from '../store'
import { describeDelete, DELETE_SUMMARY_MAX_NAMES } from '../logic/deleteFlow'
import { retentionDaysOf } from '../logic/trashView'
import { Modal } from './Modal'
import { IconAlert, IconTrash } from '../icons'

/**
 * 删除二次确认弹窗（P0-16 第一步）。
 *
 * - 单选：显示名称 + 大小 + 文件数；
 * - 多选：显示「N 个资产 · 合计 X GB」+ 名称预览（封顶 6 条）。
 *
 * 点「确认删除」后的行为由设置 `undoGraceMs`（三档 0 / 3000 / 5000）决定：
 * - `> 0`：进入撤销宽限期（`confirmDelete()`），**此处不删任何东西**，真正删除由
 *   底部撤销条到期后的 `commitDelete()` 完成；
 * - `= 0`：不进宽限期，`confirmDelete()` 直接 `commitDelete()`（立即移入回收站）。
 *   二次确认弹窗**永远在**——"不等待"只取消倒计时，不取消确认。
 */
export function ConfirmDialog() {
  const pending = useVault((s) => s.pendingDelete)
  const confirmDelete = useVault((s) => s.confirmDelete)
  const undoDelete = useVault((s) => s.undoDelete)
  // C 线：文案必须跟着删除策略走——30d 档说的是「最近删除」，recycle 档才是 Windows 回收站
  const retention = useVault((s) => s.settings?.trashRetention ?? '30d')

  if (!pending || pending.stage !== 'confirming') return null

  const { title, detail, count } = describeDelete(pending.targets)
  const names = pending.targets.map((t) => t.name)
  // 撤销期取自本次删除的快照（`requestDelete` 时写入），不是全局常量：
  // 用户在确认框里停留期间去改设置，不会改变这一次的等待时长。
  const graceMs = pending.graceMs
  const graceSeconds = graceMs > 0 ? graceMs / 1000 : 0

  return (
    <Modal title="确认删除" onClose={undoDelete} width="max-w-md">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-danger">
          <IconAlert />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" title={title}>
            {title}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{detail}</div>
        </div>
      </div>

      {count > 1 && (
        <ul className="mt-3 max-h-40 overflow-auto rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-secondary">
          {names.slice(0, DELETE_SUMMARY_MAX_NAMES).map((n, i) => (
            <li key={`${i}-${n}`} className="truncate" title={n}>
              · {n}
            </li>
          ))}
          {names.length > DELETE_SUMMARY_MAX_NAMES && (
            <li className="text-muted">…等共 {names.length} 个资产</li>
          )}
        </ul>
      )}

      {/* 场景化警示（v0.4 重复资产：体积差异 > 30% 时提示先确认是不是同一套） */}
      {pending.warning && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] leading-relaxed text-danger">
          {pending.warning}
        </p>
      )}

      {/* 撤销期说明随设置变（设置·数据与备份「删除撤销期」）：
          - 3 / 5 秒：说清"撤销期内文件仍在磁盘上"，到期才移入回收站；
          - 0（不等待）：明确说"立即移入、没有撤销期"，绝不能让用户以为还有反悔机会。 */}
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        {graceSeconds > 0 ? (
          <>
            确认后还有 <span className="font-medium text-primary">{graceSeconds} 秒</span>
            撤销期，撤销期内文件仍在磁盘上；
            {retention === 'recycle' ? (
              <>到期后移入 Windows 回收站（可从回收站找回）。</>
            ) : (
              <>
                到期后移入<span className="font-medium text-primary">「最近删除」</span>
                （左侧栏可还原），保留 {retentionDaysOf(retention) ?? 30} 天后自动彻底删除。
              </>
            )}
          </>
        ) : retention === 'recycle' ? (
          <>
            确认后<span className="font-medium text-primary">立即</span>移入 Windows 回收站（可从回收站找回），没有撤销期；撤销期可在设置 · 数据与备份里调整。
          </>
        ) : (
          <>
            确认后<span className="font-medium text-primary">立即</span>移入<span className="font-medium text-primary">「最近删除」</span>（左侧栏可还原），保留 {retentionDaysOf(retention) ?? 30} 天后自动彻底删除，没有撤销期。
          </>
        )}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={undoDelete}>
          取消
        </button>
        <button className="btn btn-outline-danger" onClick={confirmDelete}>
          <IconTrash />
          确认删除{count > 1 ? `（${count} 个）` : ''}
        </button>
      </div>
    </Modal>
  )
}
