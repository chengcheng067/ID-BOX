import { useEffect, useState } from 'react'
import { IconWinClose, IconWinMaximize, IconWinMinimize, IconWinRestore } from '../icons'

/**
 * 自绘窗口控制（UI 设计规范 v0.2 §3.1 / §4-2）。
 *
 * - 最小化(–) / 最大化(□) 28×28 方钮 r7，`--text-tertiary`；
 * - 关闭 ✕ 用 danger 红区分；hover：浅 `rgba(0,0,0,0.06)` / 深 `rgba(255,255,255,0.08)`，
 *   关闭 hover 红底白叉（样式在 styles.css 的 `.win-btn` / `.win-btn-close`）；
 * - 最大化图标随状态切 □ / ❐（主进程 win:maximizedChanged 广播）；
 * - 所有按钮必须 `app-no-drag`（顶栏是 drag 区，不标 no-drag 点按钮会误拖窗口）。
 *
 * 图形口径（图标规格 A）：全部走 `icons.tsx` 的 Base —— 24 viewBox、16px 渲染、
 * path 坐标描边 2.25（= 视觉 1.5）、颜色 `currentColor`（由按钮 CSS 的 color 决定，
 * 关闭钮因此直接继承 `.win-btn-close` 的 danger 红）。
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.modvault.onMaximizeChange(setMaximized), [])

  const btn =
    'app-no-drag flex h-7 w-7 items-center justify-center rounded-winbtn transition-colors win-btn'

  return (
    <div className="ml-1 flex items-center gap-0.5">
      <button className={btn} onClick={() => window.modvault.winMinimize()} title="最小化" aria-label="最小化">
        <IconWinMinimize />
      </button>
      <button
        className={btn}
        onClick={() => window.modvault.winMaximizeToggle()}
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
      >
        {maximized ? <IconWinRestore /> : <IconWinMaximize />}
      </button>
      <button
        className={`${btn} win-btn-close`}
        onClick={() => window.modvault.winClose()}
        title="关闭"
        aria-label="关闭"
      >
        <IconWinClose />
      </button>
    </div>
  )
}
