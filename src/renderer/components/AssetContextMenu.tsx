import { useEffect, useRef } from 'react'
import { useVault } from '../store'
import { revealTargetFor } from '../logic/assetPath'

/**
 * 网格/列表右键菜单（T07）：打开位置 / 指派分类 / 收藏 / 复制路径 / 删除。
 * 定位在光标处，点击任意处或 Escape 关闭。
 *
 * 2026-10-21 走查 P2⑧：原先只有 3 项（指派分类 / 在资源管理器中显示 / 删除）且**没有图标**，
 * 一列纯文字难扫读，且「只是想收藏一下」也得绕到卡片右上角去找星标。
 * 现在：① 每项配 14px 图标（与侧栏/卡片同一套线性风格，`text-tertiary` 不抢文字）；
 * ② 补两项高频动作——收藏 / 取消收藏、复制文件夹路径；
 * ③ 危险项（删除）与上面几项之间加分隔线，避免误点到最后一格就删。
 */

/** 菜单项图标：统一 14×14、1.8 描边、线性风格（与 Sidebar 图标同口径） */
function MenuIcon({ d }: { d: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-tertiary"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

const ICON_FOLDER = 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z'
const ICON_TAG = 'M20.6 13.4 12.4 5.2a1.6 1.6 0 0 0-1.1-.5H5.8A1.6 1.6 0 0 0 4.2 6.3v5.5c0 .4.2.8.5 1.1l8.2 8.2a1.6 1.6 0 0 0 2.3 0l5.4-5.4a1.6 1.6 0 0 0 0-2.3zM7.6 8.6h.01'
const ICON_STAR = 'M12 3.4l2.7 5.5 6 .88-4.35 4.24 1.03 5.98L12 17.2l-5.38 2.82 1.03-5.98L3.3 9.78l6-.88z'
const ICON_COPY = 'M9 9h9.5v9.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V10.5A1.5 1.5 0 0 1 9 9zM6.5 15H5a1.5 1.5 0 0 1-1.5-1.5V4.5A1.5 1.5 0 0 1 5 3h9a1.5 1.5 0 0 1 1.5 1.5V6'
const ICON_TRASH = 'M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12.1A1.6 1.6 0 0 0 8.9 20.6h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7'

export function AssetContextMenu({ x, y, ids, onClose }: { x: number; y: number; ids: string[]; onClose: () => void }) {
  const assets = useVault((s) => s.assets)
  const openCategoryPicker = useVault((s) => s.openCategoryPicker)
  const requestDelete = useVault((s) => s.requestDelete)
  const setFavorite = useVault((s) => s.setFavorite)
  const setNotice = useVault((s) => s.setNotice)
  const ref = useRef<HTMLDivElement>(null)

  // 点击别处 / Escape 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  if (ids.length === 0) return null

  const targets = assets.filter((a) => ids.includes(a.id))
  if (targets.length === 0) return null

  const revealTarget = targets.length === 1 ? revealTargetFor(targets[0]) : targets[0].folder
  // 多选时「收藏」的语义：**只要还有没收藏的 → 显示「收藏」**（一批点下去全部变收藏）；
  // 全都收藏了才显示「取消收藏」。与卡片星标用的是同一个 setFavorite，状态口径一致。
  const allFavorite = targets.every((a) => a.favorite === true)
  // 菜单尽量不出屏（视口右/下边缘留余量；5 项 + 分隔线约 210px 高）
  const left = Math.min(x, window.innerWidth - 232)
  const top = Math.min(y, window.innerHeight - 224)

  const item =
    'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[13px] transition hover:bg-accent-tint/60'

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[208px] rounded-modal border border-line bg-card p-1.5 shadow-modal"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className={item}
        onClick={() => {
          void window.modvault.reveal(revealTarget)
          onClose()
        }}
      >
        <MenuIcon d={ICON_FOLDER} />
        <span className="truncate">
          {targets.length === 1 ? '打开文件位置' : '打开第一个所在文件夹'}
        </span>
      </button>
      <button
        className={item}
        onClick={() => {
          openCategoryPicker(ids)
          onClose()
        }}
      >
        <MenuIcon d={ICON_TAG} />
        <span className="truncate">指派分类…</span>
      </button>
      <button
        className={item}
        onClick={() => {
          void setFavorite(ids, !allFavorite)
          onClose()
        }}
      >
        <MenuIcon d={ICON_STAR} />
        <span className="truncate">
          {allFavorite ? '取消收藏' : '收藏'}
          {ids.length > 1 ? `（${ids.length} 项）` : ''}
        </span>
      </button>
      <button
        className={item}
        onClick={() => {
          // 复制的是**绝对文件夹路径**（资源管理器地址栏可直接粘贴）。剪贴板在个别
          // 环境会拒绝（无 secure context / 权限策略），失败必须给反馈，不能静默。
          const folder = targets[0].folder
          void navigator.clipboard
            .writeText(targets.length === 1 ? folder : targets.map((a) => a.folder).join('\r\n'))
            .then(() => setNotice(targets.length === 1 ? '已复制文件夹路径' : `已复制 ${targets.length} 条路径`))
            .catch(() => setNotice('复制失败：系统剪贴板不可用'))
          onClose()
        }}
      >
        <MenuIcon d={ICON_COPY} />
        <span className="truncate">复制文件夹路径</span>
      </button>

      {/* 危险项与上面隔开：防「点最后一格误删」 */}
      <div className="my-1 h-px bg-line" />
      <button
        className={`${item} text-danger hover:bg-danger/10`}
        onClick={() => {
          requestDelete(ids)
          onClose()
        }}
      >
        <MenuIcon d={ICON_TRASH} />
        <span className="truncate">
          删除{ids.length > 1 ? `（${ids.length} 项）` : ''}…
        </span>
      </button>
    </div>
  )
}
