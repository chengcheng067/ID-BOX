import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { menuPlacement } from '../../logic/contextMenu'
import { useEscLayer } from '../../logic/escLayer'
import type { PinnedMenuItem } from '../../logic/pinnedBrowser'

/**
 * 应用内文件浏览器的**自绘右键菜单外壳**（三套菜单 + 工具行排序浮层共用）。
 *
 * 为什么不复用 `components/ContextMenu.tsx`：浏览器菜单要支持**一级子菜单**
 * （空白处右键的「排序」级联面板，设计稿 F5 的级联形态）与 `checked` 对勾
 * （当前排序键 / 方向）。共享外壳的 `ContextMenuItem` 是封闭类型，扩它就是
 * 改库内三层菜单的公共契约，风险大于一份受控复制。定位夹取（`menuPlacement`）、
 * 点外关闭、`role="menu"` 语义、图标口径与它保持一致。
 *
 * ⚠️ **Esc 接入 escLayer 层栈**（与 `Modal` / `useEscLayer` 同一条路径，不是
 * `ContextMenu` 的裸 window 捕获监听）：菜单挂载时压栈，Esc 由栈顶（本菜单）
 * 应答 → 先关菜单，再清多选，最后才轮到关浏览器 —— 一次按键只关一层。
 * 输入框重命名态的 `data-esc-own` 让路语义同样生效（`useEscLayer` 内建）。
 *
 * ⚠️⚠️ **必须 portal 到 `<body>`**（2026-11-25 用户实测：「右键菜单并没有跟随鼠标的
 * 位置生成，而是离鼠标有一段距离」）。浏览器的根节点挂着 `.pinned-browser-enter`
 * （`pinned-enter.css`）—— 只要祖先有非 `none` 的 `transform`，`position: fixed` 的
 * 包含块就**不再是视口**，而是该祖先的 padding box：`left/top = e.clientX/clientY`
 * 会被额外加上浏览器面板自己在窗口里的原点（顶栏 56px / 左栏宽），菜单系统性飘走。
 * 入场 180ms 的动画期（以及万一以后有人把填充模式改回 `both`、或加 `will-change`）
 * 都处在这个上下文里，所以这条不能靠"动画播完就没事"来省。portal 后菜单脱离该
 * transform 上下文，clientX/clientY 才真正等于视口坐标；改回"直接渲染在浏览器
 * 根节点里"必复现（`tests/pinnedBrowseWiring.test.ts` 有守卫）。
 */
export function PinnedBrowserMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: PinnedMenuItem[]
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const handlerRef = useRef({ onClose })
  handlerRef.current = { onClose }
  /** 夹取后的落点（量到真实尺寸前不可见，避免闪跳 —— 同 ContextMenu 的做法） */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  /** 当前展开的子菜单（item 下标）+ 展开方向（右侧空间不够时翻到左侧） */
  const [submenu, setSubmenu] = useState<{ index: number; side: 'left' | 'right' } | null>(null)

  useEscLayer(() => handlerRef.current.onClose(), true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next = menuPlacement(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight)
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next))
  }, [x, y, items.length])

  // 点外关闭（mousedown 而不是 click：按下划出也要关）。
  // Esc 不另挂监听 —— useEscLayer 已在栈顶应答（避免一个按键被两处消费）。
  useLayoutEffect(() => {
    const down = (e: MouseEvent): void => {
      // 子菜单面板渲染在菜单容器内部，contains 天然覆盖
      if (ref.current && !ref.current.contains(e.target as Node)) handlerRef.current.onClose()
    }
    window.addEventListener('mousedown', down, true)
    return () => window.removeEventListener('mousedown', down, true)
  }, [])

  /** 子菜单展开时算方向（菜单右边放不下就往左翻） */
  const openSubmenu = (index: number): void => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const side = rect.right + 208 > window.innerWidth ? 'left' : 'right'
    setSubmenu({ index, side })
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="右键菜单"
      className="fixed z-50 min-w-[200px] rounded-modal border border-line bg-card p-1.5 shadow-modal"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? 'visible' : 'hidden'
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {items.map((item, i) => {
        if (item === 'separator') {
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-line" />
        }
        if ('children' in item) {
          const open = submenu?.index === i
          return (
            <div key={`${item.label}-${i}`} className="relative">
              <button
                type="button"
                role="menuitem"
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[13px] transition ${
                  open ? 'bg-accent-tint/60' : 'hover:bg-accent-tint/60'
                }`}
                onMouseEnter={() => openSubmenu(i)}
                onClick={() => openSubmenu(i)}
              >
                {item.icon !== undefined && <MenuIcon d={item.icon} />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-tertiary"
                  aria-hidden="true"
                >
                  <path d="M9 5.5l6.5 6.5L9 18.5" />
                </svg>
              </button>
              {open ? (
                <div
                  role="menu"
                  aria-label={`${item.label}子菜单`}
                  className={`absolute top-0 min-w-[160px] rounded-modal border border-line bg-card p-1.5 shadow-modal ${
                    submenu?.side === 'left' ? 'right-full mr-1' : 'left-full ml-1'
                  }`}
                  onMouseLeave={() => setSubmenu(null)}
                >
                  {item.children.map((child, j) => (
                    <MenuLeaf key={`${child === 'separator' ? 'sep' : child.label}-${j}`} item={child} onClose={onClose} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        }
        return <MenuLeaf key={`${item.label}-${i}`} item={item} onClose={onClose} />
      })}
    </div>,
    document.body
  )
}

/** 叶子项（含对勾 / 危险红 / 禁用灰）：顶层与子菜单共用同一套画布样式 */
function MenuLeaf({ item, onClose }: { item: PinnedMenuItem; onClose: () => void }): ReactElement | null {
  if (item === 'separator') {
    return <div role="separator" className="my-1 h-px bg-line" />
  }
  if ('children' in item) return null // 子菜单一级封顶，不递归
  const disabled = item.disabled === true
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? '功能就绪中' : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[13px] transition ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : item.danger === true
            ? 'text-danger hover:bg-danger/10'
            : 'hover:bg-accent-tint/60'
      }`}
      onClick={() => {
        if (disabled) return
        item.onClick()
        onClose()
      }}
    >
      {item.icon !== undefined && <MenuIcon d={item.icon} />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.checked === true ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-accent"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  )
}

/** 菜单图标：14×14 / 1.8 描边 / text-tertiary（与库内三层菜单同一口径） */
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
