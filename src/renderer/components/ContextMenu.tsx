import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isMenuItem, menuPlacement, type ContextMenuItem } from '../logic/contextMenu'

/**
 * 右键菜单的**共用外壳**（三层菜单唯一的一份）。
 *
 * 由来：卡片右键菜单原先自带一套定位 / 关闭 / 图标代码（`AssetContextMenu` 内部），
 * 本轮要再加「文件行」与「空白处」两套菜单 —— 三份复制必然漂移
 * （之前就踩过：高度写死 224，项一多底部被窗口下沿切掉，最后一项点不到）。
 *
 * 职责边界（很硬）：
 * - 只做**渲染与交互**：定位夹取、点外部 / Esc 关闭、禁用项不触发、`role="menu"`；
 * - 不认任何业务：菜单项从 `logic/contextMenu` 的纯函数来，动作是 item 上的回调。
 *
 * 关闭为什么必须由外部给 `onClose`：菜单本身不知道"关掉之后调用方要做什么"
 * （三个调用方各自持有一份 open state）。
 */
export type { ContextMenuItem } from '../logic/contextMenu'

/** 菜单项图标：统一 14×14、1.8 描边、线性风格（与 Sidebar / 卡片星标同口径） */
function MenuIcon({ d }: { d: string | readonly string[] }) {
  const paths = typeof d === 'string' ? [d] : d
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
      {paths.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  )
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  minWidth = 208
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** 菜单最小宽度（默认 208，与旧卡片菜单一致） */
  minWidth?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  /**
   * 夹取后的落点。`null` = 还没量到真实尺寸 → 先按光标位置渲染但**不可见**。
   *
   * 为什么不预估高度：菜单项数是动态的（3 项 / 10 项差一倍多），任何常数都会
   * 在某一种组合下算错。`useLayoutEffect` 里量一次 `getBoundingClientRect()`，
   * setState 引发的重渲染在浏览器绘制**之前**完成 → 用户看不到跳位。
   */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next = menuPlacement(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight)
    /**
     * ⚠️ 必须做**等值短路**：`setPos` 每次都传新对象会让 React 认为状态变了 →
     * 重渲染 → 这个 effect 再跑 → 死循环（菜单还在 layout effect 里，表现为直接卡死）。
     * 值没变时返回原引用，React 会 bail out。
     */
    setPos((prev) =>
      prev && prev.left === next.left && prev.top === next.top ? prev : next
    )
    // 依赖用 `items.length` 而不是 `items`：菜单项数组每次渲染都是新引用，
    // 依赖它会让上面的 effect 每帧都跑一遍（强制布局）。高度只随项数变化。
  }, [x, y, items.length])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    /**
     * Esc 用**捕获阶段**并 `stopPropagation`：文件视图 / 其它弹窗也在 window 上
     * 监听 Esc，冒泡阶段会一次按键关两层（菜单 + 视图）。菜单在最上层，先吃。
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const itemClass =
    'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[13px] transition'
  const enabledClass = 'hover:bg-accent-tint/60'
  const disabledClass = 'cursor-not-allowed opacity-40'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="右键菜单"
      className="fixed z-50 rounded-modal border border-line bg-card p-1.5 shadow-modal"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        minWidth,
        // 量尺寸那一帧不能闪：先占位但不可见，layout effect 里定好位再显示
        visibility: pos ? 'visible' : 'hidden'
      }}
      // 菜单自身右键不弹浏览器默认菜单（也不该冒泡成"空白处右键"）
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {items.map((entry, i) => {
        if (!isMenuItem(entry)) {
          // 分隔线：`role="separator"` 让读屏器也念得出分组关系
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-line" />
        }
        const danger = entry.danger === true
        const disabled = entry.disabled === true
        // 悬停底色**二选一**（不要两套 hover 类同时挂：Tailwind 里谁生效取决于
        // 产物顺序而不是 class 顺序，危险项会意外亮成强调色）
        const hoverClass = danger ? 'hover:bg-danger/10' : enabledClass
        return (
          <button
            key={`${entry.label}-${i}`}
            role="menuitem"
            type="button"
            disabled={disabled}
            aria-disabled={disabled || undefined}
            className={`${itemClass} ${disabled ? disabledClass : hoverClass} ${
              danger ? 'text-danger' : ''
            }`}
            onClick={() => {
              // 禁用项：`disabled` 已经拦住 click，这里再守一道（防有人改成 aria-disabled）
              if (disabled) return
              entry.onClick()
              onClose()
            }}
          >
            {entry.icon !== undefined && <MenuIcon d={entry.icon} />}
            <span className="truncate">{entry.label}</span>
          </button>
        )
      })}
    </div>
  )
}
