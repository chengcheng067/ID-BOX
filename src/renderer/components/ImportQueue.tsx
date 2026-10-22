import { useEffect, useState } from 'react'
import { useVault } from '../store'
import {
  dismissRemainingMs,
  importItemDetail,
  isTerminalStatus,
  spaceShortageText,
  statusClass
} from '../logic/importText'
import { IconAlert, IconCheck, IconClose, IconDownload } from '../icons'

/**
 * 右下角导入进度队列。
 *
 * 2026-10 用户反馈（截图 6 条堆屏）：「条目永不消失」——旧实现只在 `imports.length === 0`
 * 时整块消失，单条 done 之后一直留着。现在的口径：
 * - `done` / `skipped` → 6 秒后自动移除（`autoDismissDelayMs`）；
 * - `error` → 12 秒（错误要留久一点让人看清）；
 * - pending / extracting / organizing **不消失**（队列此刻唯一的进度反馈）；
 * - 鼠标悬停整个队列 → 暂停倒计时，移开继续（倒计时以 `settledAt` 绝对时间戳重算，
 *   暂停期间流逝的时间会如实扣掉，不会"悬停一下又重新计 6 秒"）；
 * - 手动点 ✕ 仍立即移除；计时器在悬停切换 / 条目变化 / 组件卸载时全部清理。
 *
 * 2026-10 导入重复处置（docs/27 T-08）：
 * - `skipped` 走**中性灰** + ✕ 图标（跳过不是失败，不能学 error 用红色）；
 * - `done` 且带 `conflict` 时明细换成「已覆盖到「…」」/「已保留为「…」」。
 *   配色 / 倒计时 / 文案三处的唯一来源是 `logic/importText.ts`（本组件只管排布）。
 */
export function ImportQueue() {
  const imports = useVault((s) => s.imports)
  const dismiss = useVault((s) => s.dismissImport)
  const saveSettings = useVault((s) => s.saveSettings)
  const setNotice = useVault((s) => s.setNotice)
  const importPaths = useVault((s) => s.importPaths)
  /** 鼠标是否停在队列区域内（悬停 = 暂停自动消失） */
  const [hovered, setHovered] = useState(false)

  /**
   * 终态条目自动消失。
   *
   * 依赖 `imports` + `hovered`：任一变化都**重建** timer 列表（先全清再按剩余时间重排），
   * 这样"悬停暂停 → 移开恢复"和"新事件到达时重新算"共用同一套逻辑。
   * 不用 setInterval 轮询整表：条目最多 6 个，重建定时器比每 250ms 扫一遍更便宜。
   */
  useEffect(() => {
    if (hovered || imports.length === 0) return
    const now = Date.now()
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const it of imports) {
      const delay = dismissRemainingMs(it.status, it.settledAt, now)
      if (delay === null) continue
      timers.push(
        setTimeout(() => {
          // 到点再从最新状态里确认：期间可能已被用户手动 ✕，或同一条目重新开始导入
          useVault.getState().dismissImport(it.item)
        }, delay)
      )
    }
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [imports, hovered])

  if (imports.length === 0) return null

  /**
   * 空间不足 → 「更改库目录」：弹系统目录选择，选完**只刷新设置快照**。
   *
   * ⚠️ 绝不在这里自动 `rescan()`（2026-10 库安全事故）：新目录很可能是空的，
   * 重扫会把索引里全部记录当作"磁盘已删除"清掉，而 tags / note / styles
   * 只存在于索引里 → 永久丢失。重扫留给用户在设置页显式点击。
   */
  const changeLibrary = async () => {
    const next = await window.modvault.chooseLibrary()
    if (!next) return
    // chooseLibrary 已在主进程落盘，这里同步 Zustand 里的设置快照（不重建索引）
    await saveSettings({})
    setNotice(
      '库目录已切换。旧索引仍保留（可恢复）；确认新目录无误后，请到「设置 → 导入 → 重新扫描」重建索引。'
    )
  }

  return (
    <div className="pointer-events-none fixed bottom-14 right-4 z-30 flex w-72 flex-col gap-2">
      {/* 悬停判定放在**内层**（有指针事件的容器）上：
          外层是 pointer-events-none（不挡网格点击），内层只在有卡片时才存在；
          鼠标在卡片之间移动不会触发 enter/leave，倒计时不会来回重置。 */}
      <div
        className="pointer-events-auto flex flex-col gap-2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {imports.slice(0, 6).map((it) => {
          const space = it.status === 'error' ? spaceShortageText(it.needBytes, it.freeBytes) : null
          return (
            <div
              key={it.item}
              className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5 shadow-soft"
            >
              <span className={`mt-0.5 shrink-0 ${statusClass(it.status)}`}>
                {it.status === 'done' ? (
                  <IconCheck />
                ) : it.status === 'error' ? (
                  <IconAlert />
                ) : it.status === 'skipped' ? (
                  // 跳过：中性灰的 ✕（"这次没进来"），不是告警三角
                  <IconClose />
                ) : (
                  <span className="inline-block animate-pulse">
                    <IconDownload />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium" title={it.itemName}>
                  {it.itemName}
                </div>
                <div className="truncate text-[11px] text-muted">{importItemDetail(it)}</div>
                {/* P0-3：空间不足时给可行动出口——改库目录 + 重试 */}
                {space && (
                  <div className="mt-1.5 flex gap-1.5">
                    <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => void changeLibrary()}>
                      更改库目录
                    </button>
                    <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => void importPaths([it.item])}>
                      重试
                    </button>
                  </div>
                )}
              </div>
              {isTerminalStatus(it.status) && (
                <button
                  className="mt-0.5 shrink-0 text-muted hover:text-primary"
                  onClick={() => dismiss(it.item)}
                  title="关闭"
                >
                  <IconClose />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
