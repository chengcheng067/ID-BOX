import { useEffect, useMemo, useState } from 'react'
import { SAVED_VIEW_LIMIT, useVault } from '../store'
import {
  KIND_LABEL,
  KIND_NAV_ORDER,
  KIND_GROUP_MEMBERS,
  MATERIAL_GROUP,
  kindFilterLabel,
  type KindGroup
} from '../../shared/classify'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { countLevel1, countLevel2, duplicatedLevel2Names } from '../logic/category'
import { extraCopyCount, groupDuplicates } from '../logic/duplicates'
import { allViewFilterPatch, isAllViewActive, nextExpandKind } from '../logic/filters'
import { countDeletedAssets, isDeletedAsset } from '../logic/trashView'
import { countPendingReview } from '../logic/reviewFlow'
import { StarIcon } from './MarkControls'
import {
  ASSET_DRAG_MIME,
  hasAssetDragPayload,
  parseDragIds,
  planDropAssign
} from '../logic/dragAssign'
import { IconAlert, IconBox, IconCad, IconDownload, IconFile, IconHdr, IconImage, IconMaterial, IconOther, IconSettings, IconTrash } from '../icons'
import type { AssetKind } from '../../shared/types'
import type { DragEvent } from 'react'

const KIND_ICON: Record<AssetKind, typeof IconBox> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  cad: IconCad,
  other: IconOther
}

/** 侧栏节点 key：单个大类，或「材质」分组哨兵（texture + material 共用一个节点） */
type NavNode = AssetKind | KindGroup

/** 节点 → 计数范围（分组 = 成员并集，交给 logic/category 的 KindScope 求和） */
function scopeOf(node: NavNode | null): AssetKind | readonly AssetKind[] {
  if (!node) return []
  if (node === MATERIAL_GROUP) return KIND_GROUP_MEMBERS.materialGroup
  return node
}

/**
 * 「导航收口」的**纯函数内核**（导出仅为可单测，生产只经 `navTo` 使用）。
 *
 * 先离开文件视图，再执行导航动作；**顺序不可颠倒**——反过来会先按旧筛选渲染一帧，
 * 中栏短暂出现"筛选已经变了、却还盖着文件列表"的错帧。
 *
 * 两个依赖都用参数注入（而不是在这里直接摸 store），node 环境就能用调用数组断言顺序。
 */
export function runNavAction(closeFolderView: () => void, action: () => void): void {
  closeFolderView()
  action()
}

/**
 * 左栏库导航（UI 设计规范 v0.2 §3.2，宽 216，底 --bg-sidebar）。
 *
 * 分组：全部 → 分类（模型/贴图/HDRI/材质预设/其他）→ 整理（收藏/色标/重复资产，
 * 受设置开关控制）→ 智能集合 → 标签 →（弹性空白）→ **导入压缩包主 CTA（反馈 2：顶栏那个已删，
 * 全应用唯一）** → 设置 → 库路径 + 版本号小字。
 * 风格筛选整块**不在左栏**：2026-10-22 曾搬回顶栏（`components/Toolbar.tsx`），
 * 壳层改造后定稿在 **`App.tsx` 的中栏头那一排**（与体积 / 时间 / 分辨率 / 色标同一排的
 * 「风格」chip + 浮层）；Toolbar 已不再持有 `filters.styles` 的任何入口。
 * 左栏没有「风格」组，其余分组顺序不变。
 *
 * 2026-10 用户反馈：侧栏移除了「SU 版号」与「素材渠道」两组（筛选状态仍保留在 state 里，
 * 只是没有 UI 入口）；体积 / 导入时间两个控件整体移到中栏头（见 App.tsx）。
 * 行高 32 r9；选中：accent-tint 底 + accent-text 字（深色 tint=#1E2A38 / 字=#6DB2FF，§1 同值）。
 * 行右侧计数 11px muted；底部库路径 + 版本号 10px muted。
 * Logo 已上移顶栏（§3.1），侧栏顶部不再重复。
 */
export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const assets = useVault((s) => s.assets)
  const filters = useVault((s) => s.filters)
  const setFilter = useVault((s) => s.setFilter)
  const settings = useVault((s) => s.settings)
  const importPaths = useVault((s) => s.importPaths)
  // v0.4「重复资产」视图（不放进 Filters：它是视图模式，不是匹配条件）
  const dupOnly = useVault((s) => s.dupOnly)
  const setDupOnly = useVault((s) => s.setDupOnly)
  // C 线「最近删除」：视图切换 + 软删计数
  const libraryView = useVault((s) => s.libraryView)
  const setLibraryView = useVault((s) => s.setLibraryView)
  // 软件内文件视图（docs/15 §6c）：进入后中栏由 `folderAsset` 分支接管（优先于网格）
  const closeFolderView = useVault((s) => s.closeFolderView)
  // 0.6.0 智能集合：保存的筛选视图（settings.savedViews，纯虚拟层）
  // 选择器只取数组本身（不写 `?? []`，否则每次返回新引用），空值在外面兜底。
  const savedViewsOrNull = useVault((s) => s.settings?.savedViews)
  const savedViews = useMemo(() => savedViewsOrNull ?? [], [savedViewsOrNull])
  const applySavedView = useVault((s) => s.applySavedView)
  const deleteSavedView = useVault((s) => s.deleteSavedView)
  const [version, setVersion] = useState('')

  /**
   * 侧栏所有计数都只统计**在库资产**（`deletedAt` 无值）。
   *
   * 为什么必须在这里先剔一次：软删记录仍留在 `store.assets` 里（回收站要能列出来），
   * 若沿用 `assets` 计数，用户删了 3 个模型后左栏「模型」还是原来的数字——
   * 与网格对不上，是最容易被当成 bug 的那种不一致。
   */
  const activeAssets = useMemo(() => assets.filter((a) => !isDeletedAsset(a)), [assets])
  /** 回收站计数（徽标） */
  const trashCount = useMemo(() => countDeletedAssets(assets), [assets])
  /**
   * 回收站模式：仅用来判断「当前视图是不是最近删除」。
   *
   * 2026-10 TODO-6 用户拍板「位置不动，只修交互」：回收站只是一种**当前视图**，
   * 不是「把左栏其它筛选锁死」。此前这块导航整体挂了 `pointer-events-none` + `opacity-40`，
   * 进回收站后点侧栏任何一处都没反应，只能再点一次「最近删除」才能退出——
   * 现在改为：点任意条目 = 先退出回收站，再应用该条的筛选。
   *
   * 仍然保留的 `trashMode` 用途（逐个都有明确归属，别一刀切删光）：
   * ① 「最近删除」自身的选中态 / `aria-pressed` / 徽标 / toggle 文案（它是唯一切视图的入口）；
   * ② 各筛选条目的**高亮压制**：回收站视图下 `matchesFilters` 只吃搜索词（见 logic/filters.ts），
   *    分类/收藏/标签/色标实际都不生效 → 不能让它们显示成"筛选已生效"，
   *    否则和「最近删除」同时高亮，用户会以为筛选叠在回收站上。
   */
  const trashMode = libraryView === 'trash'

  /**
   * 退出回收站，回到资产视图（左栏**每一个**筛选入口点击时都先走这一步，由 `navTo` 统一调用）。
   *
   * 为什么只在确实是 trash 时才写 store：`setLibraryView` 会顺带清空选择 / 文件视图，
   * 资产视图里无谓地调一次会打断用户正在做的事情。
   * 注意顺序：必须先退视图**再**应用筛选，否则筛选会先落进回收站视图（用户看不到结果）。
   */
  const exitTrash = (): void => {
    if (libraryView !== 'assets') setLibraryView('assets')
  }

  /**
   * 2026-10 用户反馈（第二个 bug）：文件视图打开时，点左栏任何导航项只改了筛选 / 视图，
   * 中栏却仍被 `folderAsset` 分支盖住（`App.tsx` 里文件视图优先于网格）——
   * 用户看到的是「侧栏高亮变了、计数也变了，中心画布纹丝不动」。
   *
   * 收口：**所有**"会把中栏换成另一批资产"的入口统一走 `navTo`：
   * ① 先 `closeFolderView()`（中栏立刻回到网格 / 列表，`folderAsset` 变 null）；
   * ② 再 `exitTrash()`（既有逻辑：回收站是视图不是锁定态）；
   * ③ 最后执行筛选 / 视图变更。
   *
   * `closeFolderView` 本身就是幂等（`set({ folderViewAssetId: null })`），不必先判断是否打开；
   * 顺序由 `runNavAction` 固定（有单测钉住 close 在 action 之前）。
   */
  const navTo = (action: () => void): void => {
    runNavAction(closeFolderView, () => {
      exitTrash()
      action()
    })
  }

  /** 视图切换（「最近删除」）：它自己就是视图入口，**不能**套 `exitTrash`（会先被拉回资产视图） */
  const navToView = (action: () => void): void => {
    runNavAction(closeFolderView, action)
  }

  // ── 反馈 6d：拖拽归类（拖卡片上的「归类抓手」→ 松手在分类节点上） ──
  const assignCategoryWithUndo = useVault((s) => s.assignCategoryWithUndo)
  const setNotice = useVault((s) => s.setNotice)
  /** P2 整理流水线入口（待办集为空时自己给 notice、不开浮层） */
  const openTriage = useVault((s) => s.openTriage)
  /** 待确认队列入口（`docs/35 §4.3 入口①`）：打开浮层的 `conflict` 模式 */
  const openReview = useVault((s) => s.openReview)
  /** 当前高亮的投放节点 key（`l1:<大类>:<一级>` / `l2:<大类>:<一级>/<二级>`）；null = 无 */
  const [dropKey, setDropKey] = useState<string | null>(null)

  useEffect(() => {
    void window.modvault.getAppVersion().then(setVersion).catch(() => undefined)
  }, [])

  // 拖拽在别处结束 / Esc 取消时清掉高亮：`drop` 只在命中节点时触发，
  // 松手在空白处（或按 Esc）只会发 `dragend` → 不监听就会残留高亮。
  useEffect(() => {
    if (!dropKey) return
    const clear = () => setDropKey(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dropKey])

  // 树展开状态：有筛选时默认展开对应层级。
  // 用户反馈第 5 条缺陷 2：首次点击大类必须即展开一级树（此前只有 filters.category1 存在时
  // 才回退到 filters.kind，纯「只筛选」的首次点击不展开）。
  // `nextExpandKind` 是纯函数（logic/filters.ts，可单测）：首次选中 = 展开，
  // 已选中再点 = 折叠（toggle 语义不变）。
  const [expandKind, setExpandKind] = useState<NavNode | null>(null)
  const [expandL1, setExpandL1] = useState<string | null>(null)
  const openKind = expandKind
  const openL1 = expandL1 ?? (filters.category2 ? filters.category1 : null)

  const kindCounts = useMemo(() => {
    const m = new Map<AssetKind, number>()
    for (const a of activeAssets) m.set(a.kind, (m.get(a.kind) ?? 0) + 1)
    return m
  }, [activeAssets])

  /** 「材质」节点的计数 = texture + material（docs/14 §2.4 / QA Q5） */
  const countOf = (n: NavNode): number =>
    n === MATERIAL_GROUP
      ? KIND_GROUP_MEMBERS.materialGroup.reduce((sum, k) => sum + (kindCounts.get(k) ?? 0), 0)
      : (kindCounts.get(n) ?? 0)

  // 展开的树按**计数范围**算：分组节点时两类的分类树合并计数（未分类也是一类之和）
  const openScope = useMemo(() => scopeOf(openKind), [openKind])
  const l1Nodes = useMemo(
    () => (openKind ? countLevel1(activeAssets, openScope) : []),
    [activeAssets, openKind, openScope]
  )
  const l2Nodes = useMemo(
    () => (openKind && openL1 ? countLevel2(activeAssets, openScope, openL1) : []),
    [activeAssets, openKind, openL1, openScope]
  )
  // 同（组）大类内多个一级下重名的二级 → 按「一级/二级」完整路径展示（06 §15-④ 实测 8 组重名）
  const dupL2 = useMemo(
    () => (openKind ? duplicatedLevel2Names(activeAssets, openScope) : new Set<string>()),
    [activeAssets, openKind, openScope]
  )

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of activeAssets) for (const t of a.tags) m.set(t, (m.get(t) ?? 0) + 1)
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    // 当前筛中的标签**必须**在列表里：否则它跌出 top12 后入口消失，筛选生效却取消不掉
    //（与「全部」清理列表漏字段是同一类死角，2026-10-30 一并修）
    const picked = filters.tag
    if (picked && !sorted.some(([t]) => t === picked)) {
      const hit = m.get(picked)
      if (hit !== undefined) sorted.push([picked, hit])
    }
    return sorted
  }, [activeAssets, filters.tag])

  /**
   * v0.4 重复资产：徽标数是「多余份数」（Σ 组内份数−1），不是组数——
   * 用户关心的是「有多少份可以清掉」。为 0 时整行禁用（灰、不可点）。
   */
  const dupGroups = useMemo(() => groupDuplicates(activeAssets), [activeAssets])
  const dupExtra = useMemo(() => extraCopyCount(dupGroups), [dupGroups])

  /**
   * 2026-10 用户反馈：收藏 / 重复资产两个入口由设置决定是否显示。
   * 用 `!== false` 而不是 `=== true`：settings 尚未加载（null）时按默认「显示」处理，
   * 避免首屏闪一下再出现。
   * 2026-10-25 反馈：**色标筛选入口已移到中栏头**（与体积 / 时间同族），侧栏不再有这一行。
   */
  const showFavoritesEntry = settings?.showFavorites !== false
  const showDuplicatesEntry = settings?.showDuplicates !== false
  /**
   * 「待确认」计数（`docs/35 §4.3 入口①`）：**全库口径**，不套筛选。
   *
   * 三个口径细节，缺一个就会与浮层对不上：
   * ① 分母是 `activeAssets`（已滤软删）—— `countPendingReview` 自己**不滤软删**
   *    （软删过滤的唯一实现点仍是 `isDeletedAsset`，见 `logic/reviewFlow.ts` 的调用约定）；
   * ② 只取 `.conflict`，**不把 `.unclassified` 加进来**：后者已有「未分类」节点 +
   *    「整理」按钮，混在一起会让两个数字互相污染（同一个资产只属于其中一个，
   *    `reviewReasonOf` 的判定顺序保证互斥）；
   * ③ 不套 `filters`：与侧栏「未分类」那个数字同源（`docs/25` 口径表 ① 号），
   *    否则用户点进去看到的条数和徽标对不上（浮层队列也是全库口径）。
   */
  const conflictCount = useMemo(() => countPendingReview(activeAssets).conflict, [activeAssets])

  /**
   * 「整理」分组标题只在至少一项可见时渲染（不留空标题）。
   *
   * 「待确认」也参与判断：它没有设置开关（数据状态驱动），但**会占一行** ——
   * 若用户把「收藏」「重复资产」两个开关都关掉而库里还有 conflict，
   * 不把它算进来的话会出现一个**没有标题**的孤立行。
   */
  const showOrganizeGroup = showFavoritesEntry || showDuplicatesEntry || conflictCount > 0

  /** v0.4 收藏计数：空收藏也要能点进去看空态 → 不禁用，只显示 0 */
  const favoriteCount = useMemo(
    () => activeAssets.reduce((n, a) => n + (a.favorite === true ? 1 : 0), 0),
    [activeAssets]
  )
  /**
   * 「收藏」行是否显示为选中态。
   * 回收站视图里收藏筛选并不生效（`matchesFilters` 在 trash 下只吃搜索词）→ 压掉高亮，
   * 点击时也按"未选中 → 打开收藏筛选"处理，避免出现「看着没选中却把筛选关掉」的反向 toggle。
   */
  const favoriteActive = filters.favoriteOnly && !trashMode

  // 风格筛选的**沿革**（改这一块之前先读，别只按半句话改回去）：
  // 最初在顶栏 → 2026-10 用户反馈第 1 条挪进左栏（需求书 §1.2）→
  // 2026-10-22 用户要求「侧栏的风格选项也移到顶栏上面去」→ 搬回顶栏（`components/Toolbar.tsx`）
  // → **壳层改造后定稿：入口在 `App.tsx` 的中栏头那一排**（体积 / 时间 / 分辨率 / 色标
  //   同一排的「风格」chip + 浮层，含计数 / 多选 / 清空），Toolbar 已不再持有该入口。
  // 筛选状态与匹配语义不变：`filters.styles`（维度内 OR、与其他维度 AND，见 logic/filters.ts）。
  // 因此左栏不再有风格分组，也不再有「每个风格各挂多少个资产」那份派生计数。

  /**
   * §3.2：行高 32、r9（rounded-nav）、字号 13 一律不动。
   * 走查 v0.2.2 B3#8 已拍板：选中态按画布分两种 tone。
   *  - tone='neutral'（顶层「全部」行）：画布 2:34 浅 #E2E8F0 + #1F2937 / 深色 2:312 #242428 + #F2F2F4
   *    → 与既有 --bg-elevated / --text-primary 同值，不需要新 token，走中性档。
   *  - tone='accent'（只有「分类」组：大类 / 一级 / 二级）：
   *    画布 2:43 浅 #E1EFFF + #007AFF / 深色 2:321 #1E2A38 + #6DB2FF → 保持蓝 tint 强调档。
   *    拍板口径是「只有分类组走蓝 tint」，所以 SU 版号 / 标签 / 渠道 / 设置 一律走 neutral。
   *    风格筛选（现居中栏头 `App.tsx`）**同样**走 neutral（见那颗 chip 的样式），
   *    搬家不改配色口径。
   * 未选中分支不变。
   */
  const itemCls = (active: boolean, tone: 'neutral' | 'accent', dropping = false) =>
    // dropping 分支必须**整体替换**未选中样式：否则 hover 的 `hover:bg-elevated/60`
    // 伪类优先级更高，拖拽悬停时会盖掉高亮底色（看起来像没高亮）。
    `flex h-8 w-full items-center gap-2 rounded-nav px-2.5 text-[13px] transition ${
      dropping
        ? 'bg-accent-tint font-medium text-accent-text'
        : active
          ? tone === 'neutral'
            ? 'bg-elevated font-medium text-primary'
            : 'bg-accent-tint font-medium text-accent-text'
          : 'text-secondary hover:bg-elevated/60'
    }`

  const countCls = 'text-[11px] text-muted'

  /** 节点范围在提示文案里的说法（「材质」分组同时覆盖贴图与材质预设） */
  const scopeLabel = (node: NavNode): string =>
    node === MATERIAL_GROUP ? '贴图 / 材质预设' : KIND_LABEL[node]

  /**
   * 分类节点的投放目标（反馈 6d）。
   *
   * 只接管**应用内归类**拖拽（载荷带 `application/x-idbox-asset`）：
   * - 卡片本体的系统级拖出（`startDrag`）不产生该 MIME → `dragover` 不 `preventDefault`
   *   → 节点根本不会成为投放目标，也不会误吞「拖出到建模软件」的手势；
   * - 一级节点 → `assignCategory(ids, 一级, 未分类)`；
   * - 二级节点 → `assignCategory(ids, 一级, 二级)`。
   *
   * 三条口径：
   * ① 全部已在目标分类 → 静默 return（不发请求、不弹撤销条）；
   * ② 跨大类（节点范围不含该资产 kind）→ **整批取消 + 提示**（与本应用
   *    「跨大类不能批量指派」一致，父目录永远由 asset.kind 算）；
   * ③ 松手后高亮立即清除；拖到别处由 `dragend` 兜底清。
   */
  const dropProps = (
    key: string,
    node: NavNode,
    category1: string,
    category2: string = UNCLASSIFIED
  ) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasAssetDragPayload(e.dataTransfer?.types)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropKey((k) => (k === key ? k : key))
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      // 指针移到节点内部的 span / svg 也会触发 dragleave → relatedTarget 还在节点内则忽略
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
      setDropKey((k) => (k === key ? null : k))
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasAssetDragPayload(e.dataTransfer?.types)) return
      e.preventDefault()
      // 阻止冒泡到 App 的全窗 drop（导入通道）：同一次松手不能既归类又尝试导入
      e.stopPropagation()
      setDropKey(null)

      const ids = parseDragIds(e.dataTransfer.getData(ASSET_DRAG_MIME))
      if (ids.length === 0) return
      const plan = planDropAssign(activeAssets, ids, {
        scope: scopeOf(node),
        category1,
        category2
      })
      if (plan.total === 0) return

      if (plan.outOfScope > 0) {
        setNotice(
          `「${plan.label}」只接收${scopeLabel(node)}类资产，本次归类已取消（${plan.outOfScope} 个不属于该大类）`
        )
        return
      }
      // 全部已在目标分类 / id 已失效 → 不发请求、不弹撤销条
      if (plan.ids.length === 0) return
      void assignCategoryWithUndo(plan.ids, plan.category1, plan.category2)
    }
  })

  return (
    <aside className="flex w-[216px] shrink-0 flex-col bg-sidebar">
      {/* 走查 v0.2.2 B6#37（灰阶按已拍板 B2#6：#6B7280 归 tertiary）：「本地素材库」小标题画布 2:33 是
          #6B7280 = tertiary，此前用 text-muted（#9CA3AF）→ 归 tertiary。其余组头保持 muted 待定。 */}
      <div className="px-3 pb-1 pt-4 text-[11px] font-medium text-tertiary">本地素材库</div>

      <nav className="mt-1 flex-1 overflow-auto px-2 pb-2">
        {/* 2026-10 TODO-6（用户拍板：位置不动，只修交互）：这块导航**不再**灰置 / 屏蔽指针事件。
            此前这里是 `trashMode ? 'pointer-events-none …'`（并同时加 `opacity-40` 灰置），进回收站后
            左栏除「最近删除」外全部点不动，用户只能靠再点一次「最近删除」退出——
            正是用户反馈的「没有办法通过直接去点侧边栏的任何一个按键退出」。
            现在的口径：回收站 = 当前视图，不是锁定；点任意条目 → 先 `navTo`（退出文件视图
            + 退出回收站）再应用该条筛选（筛选状态本身仍不清空，与既有语义一致）。
            下面这层 div 仅作结构分组保留（拆掉会产生 300 行纯缩进 diff）。 */}
        <div>
        <button
          className={itemCls(
            // 判定收敛在 `logic/filters.ts` 的 `isAllViewActive`：组件里**不要**再手写
            // 「每个维度都没生效」的 `&&` 链 —— 0.9.0 的 bug 就是两处各写一遍、各漏 2 个字段
            // （`minResolution` / `modelFormat`），结果筛选隐形生效、左栏却显示成"无筛选"。
            isAllViewActive(filters) && !dupOnly && libraryView === 'assets',
            'neutral'
          )}
          onClick={() => {
            // 「全部」= 退出文件视图 + 退出回收站 + 清空所有筛选维度（唯一能回到整库的入口）。
            // 清理列表与高亮判定都收敛在 `logic/filters.ts` 的
            // `allViewFilterPatch` / `isAllViewActive`，不要在组件里再手写。
            navTo(() => {
              setDupOnly(false)
              setFilter(allViewFilterPatch())
            })
          }}
        >
          <span className="flex-1 text-left">全部</span>
          <span className={countCls}>{activeAssets.length}</span>
        </button>

        {/* ── 分类：大类 → 一级 → 二级 三级树（T07；2026-10 材质合并后 texture+material 合并为一个节点） ── */}
        <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium tracking-wide text-muted">分类</div>
        {KIND_NAV_ORDER.map((key) => {
          const node: NavNode = key
          const Icon = node === MATERIAL_GROUP ? IconMaterial : KIND_ICON[node]
          const count = countOf(node)
          const expanded = openKind === node
          if (count === 0 && filters.kind !== node && !expanded) return null
          return (
            <div key={node}>
              <button
                className={itemCls(filters.kind === node && !dupOnly && !trashMode, 'accent')}
                onClick={() => {
                  // 点大类：退出文件视图 → 退出回收站 → 筛选到该大类（分组节点 = texture+material）、
                  // 清空分类筛选；首次点击即展开，再点该大类 = 折叠
                  navTo(() => {
                    setDupOnly(false)
                    setFilter({ kind: node, tag: null, source: null, category1: null, category2: null })
                    setExpandKind(nextExpandKind(expanded, node))
                    setExpandL1(null)
                  })
                }}
                title={expanded ? '点击折叠子分类' : '点击筛选并展开子分类'}
              >
                <Icon width={15} height={15} className="shrink-0 text-tertiary" />
                <span className="flex-1 text-left">{kindFilterLabel(node)}</span>
                <span className={countCls}>{count}</span>
              </button>

              {/* 「材质」下有 texture / material 两类，给两个 chip 做精确筛选（docs/14 §2.4）。
                  点中 chip 再点一次 → 回到分组（含两类），不会卡在单类上。
                  2026-10-21 走查 P2⑪：两个 chip 原来只有名字没有数量，和上面的分类行
                  视觉口径不一致（每一行都有计数），也看不出「贴图 12 / 材质预设 3」的分布。 */}
              {expanded && node === MATERIAL_GROUP && (
                <div className="flex flex-wrap gap-1 pb-1 pl-7 pr-2.5 pt-0.5">
                  {KIND_GROUP_MEMBERS.materialGroup.map((member) => {
                    // 回收站里 chips 不算"已选中"（那只是回收站视图，筛选并未生效）
                    // → 点击语义恒为「退出回收站 + 切到该单类」
                    const on = filters.kind === member && !trashMode
                    return (
                      <button
                        key={member}
                        className={on ? 'chip-accent' : 'chip-ghost'}
                        onClick={() => {
                          // 材质分组下的单类 chip：同样是导航（退出文件视图 + 退出回收站）
                          navTo(() => {
                            setFilter({
                              kind: on ? MATERIAL_GROUP : member,
                              tag: null,
                              source: null
                            })
                          })
                        }}
                        title={on ? '再点回到「材质」（两类）' : `只看${KIND_LABEL[member]}`}
                      >
                        {KIND_LABEL[member]}
                        {/* chip 自带 gap-1，这里不再加 margin（否则 4+4=8px，数字飘太远） */}
                        <span className="tabular-nums opacity-60">
                          {kindCounts.get(member) ?? 0}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              {expanded &&
                l1Nodes.map((n) => {
                  // 高亮压制：回收站视图里分类筛选不生效，不能显示成"已选中"
                  const l1Active =
                    !trashMode && filters.kind === node && filters.category1 === n.value && filters.category2 === null
                  const l1Open = openL1 === n.value
                  const l1Key = `l1:${node}:${n.value}`
                  return (
                    <div key={n.value}>
                      {/* 一级节点行：主按钮 + （未分类时的）整理入口。
                          ⚠️ 整理按钮**不能**塞进主按钮内部 —— `<button>` 里套 `<button>`
                          是非法 HTML（浏览器会把它提出去，点击区域错乱）。
                          所以这一行是 `flex` 行容器：主按钮 `flex-1 min-w-0` + 兄弟节点整理按钮。
                          ⚠️ 不要退回 `absolute`：绝对定位不占位，数字永远被按钮压住（这就是
                          「整理」胶囊盖掉计数左半边的原因）。flex 让数字真的让位。 */}
                      <div className="group flex items-center gap-1">
                      <button
                        className={`${itemCls(l1Active, 'accent', dropKey === l1Key)} min-w-0 flex-1`}
                        {...dropProps(l1Key, node, n.value)}
                        onClick={() => {
                          // 一级分类：退出文件视图 → 退出回收站 → 筛选到「大类 + 一级」，再点同一节点折叠
                          navTo(() => {
                            setFilter({ kind: node, category1: n.value, category2: null, tag: null, source: null })
                            setExpandL1(l1Open ? null : n.value)
                          })
                        }}
                        title={
                          n.value === UNCLASSIFIED
                            ? '导入后未指派分类的资产（可把卡片拖到这里）'
                            : `${n.value}（可把卡片拖到这里归类）`
                        }
                      >
                        <span className="flex-1 truncate pl-4 text-left text-[13px]">
                          {n.value}
                          {/* 「词表待补」= 该分类名来自**推断**的词表条目，不是等你处理的待办。
                              旧文案的「核对」二字被误读成"我需要去确认一下"，但界面上没有确认入口
                              （CONFIDENCE 是词表数据的可信度，不属于资产待办）。故改文案 + 虚线淡标，
                              明确它是信息而不是任务。 */}
                          {n.inferred && (
                            <span
                              className="ml-1 shrink-0 rounded-[3px] border border-dashed border-line px-1 text-[9px] leading-[14px] text-tertiary"
                              title="该分类来自推断的词表条目，尚未与站方全表逐条核对（不影响你使用）"
                            >
                              词表待补
                            </span>
                          )}
                        </span>
                        <span className={`${countCls} shrink-0`}>{n.count}</span>
                      </button>
                      {/* 「整理」入口（P2）：只在**未分类且有资产**时出现（需求 1）。
                          常显而不是 hover 才现 —— 它是这一行的**主行动**，用户找不到入口
                          这功能就等于不存在；hover 才现只适合次要操作。
                          走 `openTriage()` —— 待办集为空时它自己给 notice 且不开浮层。
                          视觉：实心 accent 蓝 + 白字（沿用 .btn-solid 的 token，尺寸压到 h20）。
                          它是 flex 兄弟节点 → 占位、把数字顶到左边，两者不可能重叠。 */}
                      {n.value === UNCLASSIFIED && n.count > 0 && (
                        <button
                          type="button"
                          className="h-[20px] shrink-0 rounded-[5px] bg-accent px-1.5 text-[10px] font-medium leading-none text-white transition hover:brightness-110"
                          title="一键整理：一屏一张，选完分类自动跳到下一张"
                          onClick={(e) => {
                            // 不能冒泡到主按钮（那会顺手筛选到「未分类」并折叠树）
                            e.stopPropagation()
                            openTriage()
                          }}
                        >
                          整理
                        </button>
                      )}
                      </div>

                      {l1Open &&
                        openL1 === n.value &&
                        l2Nodes.map((c2) => {
                          const full = dupL2.has(c2.value) ? `${n.value}/${c2.value}` : c2.value
                          const l2Key = `l2:${node}:${n.value}/${c2.value}`
                          // 高亮压制（同 l1）：回收站里不显示成"已选中"，否则点击的 toggle 语义会反
                          const l2Active =
                            !trashMode &&
                            filters.kind === node &&
                            filters.category1 === n.value &&
                            filters.category2 === c2.value
                          return (
                            <button
                              key={`${n.value}/${c2.value}`}
                              className={itemCls(l2Active, 'accent', dropKey === l2Key)}
                              {...dropProps(l2Key, node, n.value, c2.value)}
                              onClick={() => {
                                // 二级分类：退出文件视图 → 退出回收站 → 筛选到「大类 + 一级 + 二级」，
                                // 再点同一条取消二级
                                navTo(() => {
                                  setFilter({
                                    kind: node,
                                    category1: n.value,
                                    category2: l2Active ? null : c2.value,
                                    tag: null,
                                    source: null
                                  })
                                })
                              }}
                              title={full}
                            >
                              <span className="flex-1 truncate pl-7 text-left text-[12px]">{full}</span>
                              <span className={countCls}>{c2.count}</span>
                            </button>
                          )
                        })}
                    </div>
                  )
                })}
            </div>
          )
        })}

        {/* ── v0.4 标记与整理组 ──────────────────────────────────────────
            收藏 / 重复资产两行（色标筛选 2026-10-25 已移到中栏头，与体积 / 时间同族）。
            ⚠️ 与「重复资产」的交互差异（产品取舍，见交付报告）：
            · 收藏是**属性筛选**：点「全部」或切大类时**保留**（用户是在同一批资产上换维度）；
            · 点「重复资产」是**换视图**：会清掉收藏/色标，避免两个视图叠加出「重复里再筛收藏」的困惑。 */}
        {showOrganizeGroup && (
          <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium tracking-wide text-muted">整理</div>
        )}

        {showFavoritesEntry && (
          <button
            className={itemCls(favoriteActive, 'neutral')}
            onClick={() => {
              // 退出文件视图 + 退出回收站 + 只切这一个维度：
              // 收藏是属性筛选，不应顺带清掉分类/搜索
              navTo(() => {
                setDupOnly(false)
                setFilter({ favoriteOnly: !favoriteActive })
              })
            }}
            title={favoriteActive ? '取消「仅看收藏」' : `只看收藏（${favoriteCount} 个）`}
          >
            <span className="flex w-[15px] shrink-0 justify-center text-tertiary">
              <StarIcon filled={favoriteActive} size={14} />
            </span>
            <span className="flex-1 text-left">收藏</span>
            <span className={countCls}>{favoriteCount}</span>
          </button>
        )}

        {showDuplicatesEntry && (
          <button
            // `dupOnly` 在回收站里恒为 false（进入 trash 时 store 会强制关掉，见 setLibraryView）
            // → 这里不需要 `!trashMode` 的额外压制
            className={`${itemCls(dupOnly, 'neutral')} ${
              dupExtra === 0 ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''
            }`}
            disabled={dupExtra === 0}
            onClick={() => {
              // 退出文件视图 + 退出回收站 + 进入重复视图时清掉其它筛选维度：
              // 入口语义是「看全库哪些资产重复了」。清理列表与「全部」按钮**同源**
              // （`allViewFilterPatch`），不要在这里另写一份 —— 0.9.0 这里漏了 6 个字段。
              navTo(() => {
                setFilter(allViewFilterPatch())
                setDupOnly(true)
                setExpandKind(null)
                setExpandL1(null)
              })
            }}
            title={
              dupExtra === 0
                ? '库里没有重复资产'
                : `按名字分组查看重复资产（${dupGroups.length} 组，可清理 ${dupExtra} 份）`
            }
          >
            <IconFile width={15} height={15} className="shrink-0 text-tertiary" />
            <span className="flex-1 text-left">重复资产</span>
            <span className={countCls}>{dupExtra}</span>
          </button>
        )}

        {/* 「待确认」（docs/35 §4.3 入口①）：分类存在两源争议的资产（`reviewReasonOf === 'conflict'`）。
            三条形态纪律，逐条都对得上设计文档：
            · **0 时整行不渲染**（`conflictCount > 0 && (...)`）—— 不是 disabled、不是灰掉。
              与「整理」按钮"只在有资产时出现"同一纪律；也与「重复资产」的 disabled 形态
              刻意不同：那个是**常驻能力的入口**（用户要能知道它在哪），本行是**数据状态
              的提示**（没有存疑数据时它就不该占位，否则是一个"点了没反应"的按钮）。
            · 点击只 `openReview()` —— **不套筛选、不切视图**（与 `openTriage()` 的两条既有
              纪律完全一致，见 `store.ts` 的 `openTriage` 注释）。待确认队列本身是全库口径，
              套上筛选会让用户看到的条数与徽标对不上。
            · **不冒泡**：本行虽然是独立按钮（不像「整理」那样嵌在一级分类行里），仍显式
              `stopPropagation()` —— 侧栏的行级点击有历史包袱（`navTo` / 折叠树），
              不让一次点击顺手触发第二个动作。 */}
        {conflictCount > 0 && (
          <button
            className={itemCls(false, 'neutral')}
            title={`分类存疑、等你裁定（${conflictCount} 个）：一屏一张，选完自动跳到下一张`}
            onClick={(e) => {
              e.stopPropagation()
              openReview()
            }}
          >
            <IconAlert width={15} height={15} className="shrink-0 text-tertiary" />
            <span className="flex-1 text-left">待确认</span>
            <span className={countCls}>{conflictCount}</span>
          </button>
        )}

        {/* ── 0.6.0 智能集合（保存的筛选视图）──────────────────────────
            列 `settings.savedViews`；点击 = 整组套用（filters 以 DEFAULT_FILTERS 为底
            再覆盖，绝不在当前条件上叠加）。悬停出现 ✕ 直接删 —— 删的是**视图**不是资产，
            所以不做二次确认（与删除资产的安全等级不同）。
            零集合时也保留标题 + 一行提示：否则用户永远不知道这个功能在哪。 */}
        <div className="mb-1 mt-4 flex items-center justify-between px-2.5 text-[11px] font-medium tracking-wide text-muted">
          <span>智能集合</span>
          {savedViews.length > 0 && (
            <span className="text-[10px] text-muted">
              {savedViews.length}/{SAVED_VIEW_LIMIT}
            </span>
          )}
        </div>
        {savedViews.length === 0 ? (
          <div className="px-2.5 pb-1 text-[11px] leading-relaxed text-muted">
            在中栏头点「＋ 存为集合」保存当前筛选
          </div>
        ) : (
          savedViews.map((v) => (
            <div key={v.id} className="group relative">
              <button
                className={itemCls(false, 'neutral')}
                onClick={() => {
                  // 套用智能集合也是导航：先离开文件视图，再退出回收站
                  // （集合里的筛选只对资产视图有意义）
                  navTo(() => applySavedView(v))
                }}
                title={`套用「${v.name}」（替换当前全部筛选条件与排序）`}
              >
                <span className="flex-1 truncate pr-4 text-left">{v.name}</span>
              </button>
              <button
                type="button"
                className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1 text-[11px] leading-none text-muted transition hover:text-danger group-hover:block"
                title="删除该智能集合（只删视图，不动资产）"
                aria-label={`删除智能集合 ${v.name}`}
                onClick={(e) => {
                  // 行本身是按钮：不阻断会同时触发「套用」
                  e.stopPropagation()
                  void deleteSavedView(v.id)
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}

        {/* 2026-10 用户反馈：体积 / 导入时间两个控件已整体移到中栏头
            （App.tsx：排序胶囊左侧的「体积 / 时间」两个按钮 + 浮层）。
            侧栏不再保留这一块，避免同一维度出现两处入口。 */}

        {/* 历史沿革：风格筛选整块（标题 / chip 列表 / 已选计数 / 清空）先搬回顶栏，
            壳层改造后**定稿在 `App.tsx` 的中栏头**（与体积 / 时间 / 分辨率 / 色标同一排）。
            总之左栏不再有这一组，避免同一维度出现两处入口；其余分组顺序不变。 */}

        {tagCounts.length > 0 && (
          <>
            <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium tracking-wide text-muted">标签</div>
            {tagCounts.map(([tag, count]) => (
              <button
                key={tag}
                // 高亮压制：回收站视图里标签筛选不生效 → 不显示成已选中，
                // 点击语义相应按"未选中 → 选中该标签"处理（否则会出现反向 toggle）
                className={itemCls(filters.tag === tag && !trashMode, 'neutral')}
                onClick={() => {
                  // 标签筛选同样是导航：先离开文件视图，再退出回收站
                  navTo(() => {
                    setFilter({
                      tag: filters.tag === tag && !trashMode ? null : tag,
                      source: null
                    })
                  })
                }}
              >
                <span className="flex-1 truncate text-left">{tag}</span>
                <span className={countCls}>{count}</span>
              </button>
            ))}
          </>
        )}

        {/* 2026-10 用户反馈：侧栏不再显示素材渠道分组（`filters.source` 仍是合法筛选状态，
            只是没有 UI 入口；其他路径写入的值依旧生效）。 */}
        </div>

        {/* ── 库：最近删除（C 线，2026-10）──────────────────────────────
            放在导航区最底部、与筛选区**隔开**：它是视图切换，不是筛选维度。
            `recycle` 档不会产生软删记录（删除直接进系统回收站），此时徽标恒 0 —— 入口保留，
            让用户知道「这个功能在哪」，点进去是「回收站是空的」空态。 */}
        <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium tracking-wide text-muted">库</div>
        <button
          className={itemCls(trashMode, 'neutral')}
          aria-pressed={trashMode}
          onClick={() => navToView(() => setLibraryView(trashMode ? 'assets' : 'trash'))}
          title={
            trashMode
              ? '返回资产列表（筛选条件会原样恢复）'
              : '查看最近删除的资产：保留期内可还原，到期自动彻底删除'
          }
        >
          <IconTrash width={15} height={15} className="shrink-0 text-tertiary" />
          <span className="flex-1 text-left">最近删除</span>
          {trashCount > 0 ? (
            <span className="badge shrink-0 !px-1.5 !py-0 text-[10px]" title={`${trashCount} 个已删除资产`}>
              {trashCount}
            </span>
          ) : (
            <span className={countCls}>0</span>
          )}
        </button>
      </nav>

      {/* 底部：导入 CTA → 设置 → 库路径 + 版本号小字（§3.2，10px muted）。
          反馈 2（反馈处置 §2）：唯一的导入入口放在设置行**上方**，`w-full` 撑满左栏
          （`.btn-cta` 自带 132px 定宽，utilities 层的 `w-full` 覆盖它），高度仍 32。 */}
      <div className="border-t border-line/60 p-2">
        <button
          className="btn-cta mb-1.5 w-full"
          onClick={async () => {
            const files = await window.modvault.pickArchives()
            if (files.length > 0) void importPaths(files)
          }}
          title="选择压缩包 / 图片导入"
        >
          <IconDownload width={14} height={14} />
          导入压缩包
        </button>
        <button className={itemCls(false, 'neutral')} onClick={onOpenSettings}>
          <IconSettings width={15} height={15} className="shrink-0 text-tertiary" />
          <span className="flex-1 text-left">设置</span>
        </button>
        <button
          className="mt-0.5 flex w-full items-center rounded-nav px-2.5 py-1 text-left text-[10px] text-muted transition hover:text-secondary"
          onClick={() => window.modvault.openLibrary()}
          title="在资源管理器中打开库目录"
        >
          <span className="truncate">{settings?.libraryDir ?? '库目录'}</span>
        </button>
        {version && <div className="px-2.5 pb-1 text-[10px] text-muted">v{version}</div>}
      </div>
    </aside>
  )
}
