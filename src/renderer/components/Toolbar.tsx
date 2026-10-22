import { useEffect, useRef, useState } from 'react'
import { useVault } from '../store'
import { IconClose, IconGrid, IconList, IconSearch } from '../icons'
import brandMark from '../assets/brand/mark.png'
import { WindowControls } from './WindowControls'
import type { GridDensity } from '../../shared/types'

/** 密度三档的分段控件选项（反馈 6b：11px 文字「大 / 中 / 小」，不新造图标） */
const DENSITY_OPTIONS: ReadonlyArray<{ value: GridDensity; label: string; title: string }> = [
  { value: 'large', label: '大', title: '大图密度（Ctrl+滚轮也可切换）' },
  { value: 'medium', label: '中', title: '中图密度（默认）' },
  { value: 'small', label: '小', title: '小图密度（Ctrl+滚轮也可切换）' }
]

/**
 * ── 搜索框的「像素级」落点推导（2026-10 用户反馈：搜索要和中栏「全部」左对齐）──
 *
 * 目标：输入框左边缘 = 中栏头标题（`全部 18 项…`）的左边界。
 * 中栏头标题的左边界的组成为：
 *   ① 左栏宽度 —— `Sidebar.tsx` 的 `<aside className="… w-[216px] …">`
 *   ② 中栏头容器左内边距 —— `App.tsx` 中栏头那排容器的 `px-5`（Tailwind 5 = 20px）
 * 于是「窗口坐标系」里的目标 x = 216 + 20 = 236。
 *
 * 顶栏自身还有左内边距 `px-4`（16）与子项间距 `gap-3`（12），
 * 所以先把 Logo + 标题那一段**固定宽度**占位（而不是 `flex-1` 弹性空白）：
 *   左段宽 = 236 - 16 - 12 = 208
 * 搜索作为它的下一个 flex 子项，左边缘自然落在 16 + 208 + 12 = 236。
 *
 * 这些值全部来自**现有布局常量**（Tailwind 间距刻度 / 侧栏宽度），不是凑出来的魔法数字；
 * 任何一处改动（侧栏宽度 / 中栏头内边距 / 顶栏内边距与间距）只需要改这里对应的一个常量。
 */
const TOPBAR_PADDING_X = 16 // 顶栏 `px-4`
const TOPBAR_GAP = 12 // 顶栏 `gap-3`
const SIDEBAR_WIDTH = 216 // 左栏 `w-[216px]`
const COLUMN_HEADER_PADDING_X = 20 // 中栏头 `px-5`
/** 搜索框左边缘（窗口坐标）= 236 */
const SEARCH_START_X = SIDEBAR_WIDTH + COLUMN_HEADER_PADDING_X
/** 顶栏左段（Logo + 标题）的固定占位宽度 = 208 */
const LEAD_SLOT_WIDTH = SEARCH_START_X - TOPBAR_PADDING_X - TOPBAR_GAP
/** 搜索输入框宽度：用户要求「默认展开成输入框」，宽约 240（左边缘对齐不变，只向右生长） */
const SEARCH_FIELD_WIDTH = 240

/**
 * 顶栏（UI 设计规范 v0.2 §3.1，高 56，全窗宽，无边框窗口的拖动区）。
 *
 * 从左到右（2026-10 布局调整后的最终形态）：
 *   左段 208px（Logo 22×22 + "ID BOX"）→ 搜索框 240（左边缘 = 侧栏宽 + 中栏头内边距）
 *   →（弹性空白）→ 视图切换 68×32 → 密度三档 → 窗口控制。
 *
 * 为什么左段是**固定宽度**而不是 `flex-1`：搜索要和中栏「全部 18 项…」那一行**像素级**
 * 左对齐，而标题区宽度并不等于侧栏宽度；把左段钉成 208（= 侧栏 216 + 中栏内边距 20
 * - 顶栏内边距 16 - 间距 12）后，搜索的起点就被布局本身推到 236，不依赖任何运行时测量。
 *
 * 搜索框（§4-1，2026-10 调整）：
 *   - **默认展开**成输入框（240×32）——放在左上角的 32×32 图标钮会像个孤零零的图标；
 *   - 展开时**向右生长**：宽度固定、左边缘固定，右侧弹性空白吸收，分段控件 / 窗口控制不动；
 *   - Esc 收起为 32×32 图标钮（搜索词非空时该钮留在激活色，不会"看不出在筛什么"）；
 *   - Ctrl+F 展开并聚焦；输入框右侧有「清空」钮（搜索词非空时才出现）；
 *   - 有意**取消「失焦即收起」**：常驻展开是这次的既定形态，且失焦收起会让「清空」钮
 *     在 mousedown 时先失焦卸载、click 永远点不到。收起只走 Esc。
 *
 * styles 筛选入口**不在顶栏**（2026-10 用户反馈：它属于「体积 / 时间 / 分辨率 / 色标」
 * 那一排，也就是中栏头）。该入口的展开态、浮层、计数与关闭路径全部在 `App.tsx`；
 * 本组件不再持有任何与之相关的 state / ref / 事件监听。
 *
 * 拖拽纪律（§4-2）：根节点 `app-drag`，所有交互元素一律 `app-no-drag`。
 * 深色主题下顶栏有 1px `--border` 底线（浅色无线，见 styles.css `.topbar`）。
 */
export function Toolbar({
  view,
  onView
}: {
  view: 'grid' | 'list'
  onView: (v: 'grid' | 'list') => void
}) {
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  const gridDensity = useVault((s) => s.settings?.gridDensity ?? 'medium')
  const saveSettings = useVault((s) => s.saveSettings)
  /** 搜索默认展开（见组件 doc）；Esc 才收起 */
  const [searchOpen, setSearchOpen] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 搜索词非空 → 收起态的图标钮走激活色，避免"看起来没在筛选" */
  const searchActive = filters.query.trim().length > 0

  // Ctrl+F：展开并聚焦搜索（既有行为，一行不改）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        window.setTimeout(() => searchRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 展开后聚焦；Ctrl+F 与点击图标钮共用
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  return (
    <header className="topbar app-drag relative z-20 flex h-14 shrink-0 items-center gap-3 px-4">
      {/* 左段：22×22 真图标 + "ID BOX" 15px Semi Bold（§3.1）。
          2026-10 用户要求换图标：原来这里是内联立方体 svg，现在换成品牌徽标 mark.png。
          为什么用 `src/renderer/assets/brand/mark.png` 而不是 `build/icon.png`：
          ① 必须走 Vite 的 `import` 才能拿到打包后的哈希 URL（内联 base64 会撑大 bundle）；
          ② `build/` 是 electron-builder 的素材目录，若 renderer 反向依赖它，
             两套构建会相互耦合（asar 里也不含 build/）。图标与 mark 由
             `scripts/build-app-icon.cjs` 一次写出、同源同图。
          宽度 `LEAD_SLOT_WIDTH`（208）是**搜索对齐的推导结果**，不是随手加的占位：
          详见文件顶部常量区的推导注释。 */}
      <div className="flex shrink-0 items-center gap-2" style={{ width: LEAD_SLOT_WIDTH }}>
        <img
          src={brandMark}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="h-[22px] w-[22px] shrink-0 rounded-logo object-contain"
        />
        <span className="min-w-0 truncate text-[15px] font-semibold text-primary">ID BOX</span>
        {/* 测试版标识（用户 2026-10-22：「在咱们的 Logo 旁边这个框的位置加一个紫色的
            Preview 字样，表示我们现在还是测试版」）。
            刻意做成「tint 底 + 紫字」而不是实心紫块：它是状态说明，不是操作按钮，
            实心块会和右侧的蓝色主按钮抢视觉。10px + `leading-none` 保证与 15px 标题
            在**光学上**居中对齐（大写字高比行盒小，靠 `translate-y` 微调 0.5px 太脆，
            这里用 `self-center` + 等行高即可）。 */}
        <span
          className="shrink-0 self-center rounded-chip bg-preview-tint px-1.5 py-[2px] text-[10px] font-semibold leading-none tracking-[0.02em] text-preview"
          title="当前是测试版（Preview），功能与界面仍在迭代"
        >
          Preview
        </span>
      </div>

      {/* 搜索框：左边缘 = 侧栏宽度 + 中栏头左内边距（236），与中栏「全部」文字左对齐。
          默认展开 240×32；Esc 收起成 32×32 图标钮；Ctrl+F 展开并聚焦。
          宽度固定 + 左边缘固定 → 展开过程只可能向右占用弹性空白，不向左顶、不挤压右侧控件。 */}
      {searchOpen ? (
        <div
          className="app-no-drag relative h-8 shrink-0"
          style={{ width: SEARCH_FIELD_WIDTH }}
        >
          <IconSearch
            width={14}
            height={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary"
          />
          <input
            ref={searchRef}
            aria-label="搜索名称 / 标签 / 分类"
            className="h-8 w-full rounded-search border border-transparent bg-pill pl-9 pr-8 text-[12px] text-primary outline-none transition focus:border-accent/60"
            placeholder="搜索名称 / 标签 / 分类"
            value={filters.query}
            onChange={(e) => setFilter({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // 捕获阶段之外先阻断：这一下 Esc 只收搜索框，不连累 App 的全窗 Esc
                e.stopPropagation()
                e.currentTarget.blur()
                setSearchOpen(false)
              }
            }}
          />
          {/* 清空（搜索词非空时才出现）。`onMouseDown` 阻止默认焦点转移，
              保证点在按钮上时输入框不会先失焦（本组件已不做失焦收起，
              但阻止默认仍能避免焦点在点击瞬间跳到按钮上导致光标丢失）。 */}
          {searchActive && (
            <button
              type="button"
              className="app-no-drag absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-tertiary transition-colors hover:bg-elevated hover:text-secondary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFilter({ query: '' })
                searchRef.current?.focus()
              }}
              title="清空搜索"
              aria-label="清空搜索"
            >
              <IconClose width={11} height={11} />
            </button>
          )}
        </div>
      ) : (
        <button
          className={`app-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-search transition-colors ${
            searchActive ? 'bg-pill text-accent' : 'bg-pill text-tertiary hover:text-secondary'
          }`}
          onClick={() => setSearchOpen(true)}
          title={searchActive ? `搜索：${filters.query}（Ctrl+F 继续编辑）` : '搜索（Ctrl+F）'}
          aria-label="搜索"
        >
          <IconSearch width={14} height={14} />
        </button>
      )}

      {/* 弹性空白：吸收窗口变宽时的余量，也吸收搜索框展开/收起的宽度差
          → 右侧视图 / 密度分段控件与窗口控制的位置恒定。 */}
      <div className="min-w-4 flex-1" />

      {/* 视图切换：68×32 分段控件（画布 2:16 pad4 r10 / 深 2:294 r8），选中段 h24 r6（B5#18） */}
      <div className="app-no-drag flex h-8 w-[68px] shrink-0 items-center rounded-seg-group bg-pill p-1">
        {(['grid', 'list'] as const).map((v) => (
          <button
            key={v}
            className={`app-no-drag flex h-6 flex-1 items-center justify-center rounded-seg transition-colors ${
              view === v ? 'bg-seg-active text-accent' : 'text-tertiary hover:text-secondary'
            }`}
            onClick={() => onView(v)}
            title={v === 'grid' ? '网格视图' : '列表视图'}
          >
            {v === 'grid' ? <IconGrid width={14} height={14} /> : <IconList width={14} height={14} />}
          </button>
        ))}
      </div>

      {/* 密度三档（反馈 6b）：外观复用视图切换的 `rounded-seg-group bg-pill p-1` +
          `rounded-seg`，三个按钮用 11px 文字「大 / 中 / 小」，不新造图标。
          选中段 `bg-seg-active text-accent`（与视图切换同一档视觉），落 Settings.gridDensity。 */}
      <div
        className="app-no-drag flex h-8 shrink-0 items-center rounded-seg-group bg-pill p-1"
        role="group"
        aria-label="网格密度"
      >
        {DENSITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`app-no-drag flex h-6 w-6 items-center justify-center rounded-seg text-[11px] transition-colors ${
              gridDensity === opt.value
                ? 'bg-seg-active font-medium text-accent'
                : 'text-tertiary hover:text-secondary'
            }`}
            onClick={() => {
              if (gridDensity !== opt.value) void saveSettings({ gridDensity: opt.value })
            }}
            title={opt.title}
            aria-pressed={gridDensity === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 窗口控制（自绘，§3.1/§4-2） */}
      <WindowControls />
    </header>
  )
}
