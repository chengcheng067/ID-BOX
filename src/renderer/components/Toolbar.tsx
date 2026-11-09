import { useEffect, useRef, useState } from 'react'
import { useVault } from '../store'
import { IconGrid, IconList } from '../icons'
import brandMark from '../assets/brand/mark.png'
import { WindowControls } from './WindowControls'
import { HomeSearchCommand } from './home/HomeSearchCommand'
import type { HomeSearchGroup, HomeSearchItem } from './home/HomeSearchCommand'
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
 *
 * ⚠️ 搜索框的**宽度**不再由本文件声明：v0.10.x 换成「变形搜索框」之后，宽度是
 * `HomeSearchCommand` 的 `COLLAPSED_W`（240，与旧的 `SEARCH_FIELD_WIDTH` 相等）。
 * 改那个常量要顺手复核这里的推导 —— 左边缘 236 只由左段宽度决定，不受它影响。
 */
const TOPBAR_PADDING_X = 16 // 顶栏 `px-4`
const TOPBAR_GAP = 12 // 顶栏 `gap-3`
const SIDEBAR_WIDTH = 216 // 左栏 `w-[216px]`
const COLUMN_HEADER_PADDING_X = 20 // 中栏头 `px-5`
/** 搜索框左边缘（窗口坐标）= 236 */
const SEARCH_START_X = SIDEBAR_WIDTH + COLUMN_HEADER_PADDING_X
/** 顶栏左段（Logo + 标题）的固定占位宽度 = 208 */
const LEAD_SLOT_WIDTH = SEARCH_START_X - TOPBAR_PADDING_X - TOPBAR_GAP

/**
 * 顶栏（UI 设计规范 v0.2 §3.1，高 56，全窗宽，无边框窗口的拖动区）。
 *
 * 从左到右（2026-10 布局调整后的最终形态）：
 *   左段 208px（Logo 22×22 + "ID BOX"）→ 搜索 240（左边缘 = 侧栏宽 + 中栏头内边距）
 *   →（弹性空白）→ 视图切换 68×32 → 密度三档 → 窗口控制。
 *
 * 为什么左段是**固定宽度**而不是 `flex-1`：搜索要和中栏「全部 18 项…」那一行**像素级**
 * 左对齐，而标题区宽度并不等于侧栏宽度；把左段钉成 208（= 侧栏 216 + 中栏内边距 20
 * - 顶栏内边距 16 - 间距 12）后，搜索的起点就被布局本身推到 236，不依赖任何运行时测量。
 *
 * 搜索框（v0.10.x 换件，用户原话：「进了库以后的搜索框仍然要有这个动画，只不过这个
 * 动画就是从左上角往右下角展开这个样子的搜索框」）：
 *   - 已经不是原生 `<input>`，而是与首页**同一个组件** `HomeSearchCommand`
 *     （`variant="toolbar"`）：收起态 240×32 的玻璃条，点一下 / Ctrl+F 就从**左上角
 *     向右下**长成 560×(49+列表高) 的命令面板，结果行带 36×36 缩略图；
 *   - 查询词**受控**：`value={filters.query}` + `onQueryChange` → 直接写回筛选条件，
 *     所以在面板里打一个字，中栏网格就实时过滤一条（这是换件前就有的闭环，不能丢）；
 *   - Esc 只**收起面板**，不清词（旧行为一致：Esc 收框不清词）；
 *   - 收起态标签：查询词非空时显示词本身（原来靠"图标钮留在激活色 + title"表达
 *     "正在筛选"，变形条没有图标钮，表达搬到标签上）；
 *   - 有意**取消「失焦即收起」**：常驻形态，且失焦收起会让面板里的点击先失焦。
 *
 * styles 筛选入口**不在顶栏**（2026-10 用户反馈：它属于「体积 / 时间 / 分辨率 / 色标」
 * 那一排，也就是中栏头）。该入口的展开态、浮层、计数与关闭路径全部在 `App.tsx`；
 * 本组件不再持有任何与之相关的 state / ref / 事件监听。
 *
 * 拖拽纪律（§4-2）：根节点 `app-drag`，所有交互元素一律 `app-no-drag`。
 * 深色主题下顶栏有 1px `--border` 底线（浅色无线，见 styles.css `.topbar`）。
 * `.topbar` 与 `<header>` 上**没有** `overflow`（已核对 styles.css:444 与本文件），
 * 所以搜索面板可以向下溢出这一行 56px 的盒子——这一条是面板能看见的前提，别加。
 *
 * 首页态（`homeMode`，v0.9.4）：**只保留**左段 Logo + 标题、弹性空白、窗口控制。
 * 搜索框 / 视图切换 / 密度三档一律条件渲染掉 —— 首页的搜索框已经移到屏幕中央靠下
 * （`HomeCover`），顶栏若再留一个就会出现**两个搜索框**；而视图切换与密度对一块
 * 没有网格的封面页也没有意义。这不违反"控件不该无故消失"：首页的控件预算是
 * 「≤ 1 个图标（设置齿轮）+ 1 行提示」，顶栏只剩品牌与窗口控制正好符合该口径。
 */
export function Toolbar({
  view,
  onView,
  homeMode = false,
  searchGroups,
  onPickSearch
}: {
  view: 'grid' | 'list'
  onView: (v: 'grid' | 'list') => void
  /** 首页态：不渲染搜索 / 视图切换 / 密度三档（见上方 doc） */
  homeMode?: boolean
  /** 搜索面板取结果的纯函数（与首页共用同一个；`App` 里已 `useCallback` 固定引用） */
  searchGroups: (query: string) => HomeSearchGroup[]
  /** 搜索面板选中某一项（`kind:` → 进分类，`asset:` → 打开该素材的文件夹视图） */
  onPickSearch: (item: HomeSearchItem) => void
}) {
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  const gridDensity = useVault((s) => s.settings?.gridDensity ?? 'medium')
  const saveSettings = useVault((s) => s.saveSettings)
  /**
   * 打开信号：自增一次 = 「请打开并聚焦搜索面板」。
   * 组件只在**值变化**时响应，所以这里从 0 起步不会在挂载时弹出面板。
   */
  const [searchOpenSignal, setSearchOpenSignal] = useState(0)

  /**
   * 首页 → 网格的**焦点交接**（v0.9.4，换件后语义不变）。
   *
   * 首页那块搜索框长在 `HomeCover` 里。用户打进第一个字，`App` 的 `isHome` 立刻变成 false、
   * 中栏被换成搜索结果网格，于是**那个 `<input>` 随首页一起卸载 → 焦点掉到 body**，
   * 后续输入全部丢失（表现为"只能输入一个字"）。这里在"离开首页"的那一刻把焦点交给
   * 顶栏的搜索面板，并把光标放到末尾，连续输入就不被打断。
   *
   * 只在**离开首页且已有搜索词**时接管：从首页点文件夹进分类（query 为空）不抢焦点，
   * 否则用户会莫名其妙地在一个空的搜索框里开始打字。
   *
   * 为什么是「自增一个信号」而不是直接调组件的方法：组件是函数组件，没有 ref 句柄；
   * 而 `openSignal` 走的是常规 props 通路，不依赖任何 imperative handle 或时序假设。
   * 时序上：本 effect 在子组件的挂载 effect **之后**执行，子组件先以旧值挂载、
   * 再收到新值 → 正常触发一次「打开 + 聚焦 + 光标到末尾」。
   */
  const prevHomeMode = useRef(homeMode)
  useEffect(() => {
    const leftHome = prevHomeMode.current && !homeMode
    prevHomeMode.current = homeMode
    if (!leftHome) return
    if (useVault.getState().filters.query.trim().length === 0) return
    setSearchOpenSignal((n) => n + 1)
  }, [homeMode])

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

      {/* 变形搜索框（v0.10.x）：左边缘 = 侧栏宽度 + 中栏头左内边距（236），
          与中栏「全部」文字左对齐 —— 这一步没有变，因为组件收起态就是 240×32，
          与旧的原生 input 同宽同位。
          `app-no-drag` 包一层：`.hsc-root` 自己不带 app-region 声明（首页那边不需要），
          而顶栏是整块窗口拖动区，不摘出来就会「点搜索框变成拖窗口」。包在这里而不是
          加进组件，是为了不动首页的 DOM。
          ⚠️ 这一层**绝不能**加 `overflow:hidden` —— 面板从这条 32px 的盒子往下
          溢出约 300px，裁掉就整个看不见了（`.topbar` 上也已经核对过没有 overflow）。
          首页态（`homeMode`）整段不渲染：搜索框已经移到屏幕中央靠下（`HomeCover`），
          顶栏再留一个就是两个搜索框（口径见组件 doc）。 */}
      {homeMode ? null : (
        <div className="app-no-drag shrink-0">
          <HomeSearchCommand
            variant="toolbar"
            value={filters.query}
            onQueryChange={(q) => setFilter({ query: q })}
            groups={searchGroups}
            onPick={onPickSearch}
            placeholder="搜索名称 / 标签 / 分类"
            shortcut="F"
            openSignal={searchOpenSignal}
          />
        </div>
      )}

      {/* 弹性空白：吸收窗口变宽时的余量，也吸收搜索框展开/收起的宽度差
          → 右侧视图 / 密度分段控件与窗口控制的位置恒定。 */}
      <div className="min-w-4 flex-1" />

      {/* 视图切换：68×32 分段控件（画布 2:16 pad4 r10 / 深 2:294 r8），选中段 h24 r6（B5#18）。
          首页态不渲染：封面页没有网格，grid/list 切换在那儿既无对象也无效果。 */}
      {!homeMode && (
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
      )}

      {/* 密度三档（反馈 6b）：外观复用视图切换的 `rounded-seg-group bg-pill p-1` +
          `rounded-seg`，三个按钮用 11px 文字「大 / 中 / 小」，不新造图标。
          选中段 `bg-seg-active text-accent`（与视图切换同一档视觉），落 Settings.gridDensity。
          首页态不渲染：密度只描述网格卡片尺寸（同一个理由，见上）。 */}
      {!homeMode && (
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
      )}

      {/* 窗口控制（自绘，§3.1/§4-2） */}
      <WindowControls />
    </header>
  )
}
