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
 * 导入进度队列（0.7.9 起**居中**浮层；2026-10-26 用户：「把右侧那个小弹窗移到中间来」）。
 *
 * 位置/朝向的三条硬约束（改之前先读）：
 * - 水平：`left-1/2 -translate-x-1/2`。宽度不能用 `w-72`（288px）——居中后既窄又悬空，
 *   改 `w-[min(420px,calc(100vw_-_48px))]`（窄窗口时留 24px 边距，不会贴到窗口边上）。
 * - 垂直：保持 `bottom-14`（= 44px 底栏 NoticeToast + 12px 间隙）。**刻意不做动态 bottom**：
 *   底栏出现/消失时若跟着改 bottom，整个队列会上下抖一下；多出的 12px 空隙无害。
 * - 堆叠：`flex-col-reverse`。容器底边锚定在 `bottom-14`，反向列让**第 0 条钉在底部**，
 *   新条目从下往上长 → 已在场的卡片 y 坐标不变；正序列则每次增删都整摞上跳一个卡高。
 *   ⚠️ 真正的卡片栈在**内层** wrapper 上，内外两层都要 `flex-col-reverse`，只改外层不会有效果
 *   （外层只有一个子节点）。
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
    <div className="pointer-events-none fixed bottom-14 left-1/2 z-30 flex w-[min(420px,calc(100vw_-_48px))] -translate-x-1/2 flex-col-reverse gap-2">
      {/* 悬停判定放在**内层**（有指针事件的容器）上：
          外层是 pointer-events-none（不挡网格点击），内层只在有卡片时才存在；
          鼠标在卡片之间移动不会触发 enter/leave，倒计时不会来回重置。
          卡片栈方向在这里定义（`flex-col-reverse`）：底边锚定 → 第 0 条固定在底部，
          新条目向上长，已在场的卡片不会跟着跳。 */}
      <div
        className="pointer-events-auto flex flex-col-reverse gap-2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/*
         * 排列口径（2026-10-26，用户要求居中后同步修掉的两处真问题）：
         * 1) `slice(-6)` 取**最新** 6 条。旧写法 `slice(0, 6)` 取的是最老的 6 条 ——
         *    一次拖 10 个包时最后 4 个的进度根本看不见（可见性 bug）。
         * 2) `.reverse()` 让 DOM[0] = 最新一条。内层是 `flex-col-reverse`，DOM[0] 落在**底部**
         *    （最靠近 `bottom-14` 锚点）→「最新在底部，旧的往上顶」，与改动前右下角那版
         *    的观感一致，只是锚点从右边搬到了中间。**两个都要有**：只 `slice(-6)` 不
         *    `reverse` 就变成"最新在顶部"，方向反了。
         * 3) 契约：`store` 里的 `imports` 顺序 = 首次出现顺序（稳定，不随状态变化重排）；
         *    所以同一条 `pending → done` 原地更新时不会换位置，不会再"跳到栈顶"。
         *    ⚠️ 顺序的稳定性由 store 保证，本组件只负责呈现，别在这里按 status 再排一次。
         * 4) `slice` 本身已返回新数组，`reverse()` 只翻转这个副本，不碰 store 里的原数组。
         */}
        {imports.slice(-6).reverse().map((it) => {
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
