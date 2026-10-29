/**
 * 未分类整理流水线浮层（P2 第一批）。
 *
 * ## 它是什么（一句话）
 *
 * 键盘驱动的**串行整理**：一屏一张未分类资产，右侧常驻「一级 + 二级」级联选择，
 * `Enter` 确认归类后**自动跳下一张**。解决用户"逐条点开 → 右栏指派 → 关掉 → 点下一张"
 * 的体力活（库里未分类曾是主要残留，历史漏分率约 62%）。
 *
 * ## 与 `QuickLookOverlay` 的关系
 *
 * 复用它的**视觉基底与层级做法**，不复用它的代码：
 * - 自绘 `dialog-scrim` + `quicklook-scrim`（同一套底色与模糊浓度）；
 * - `useEscLayer(onClose, true)` 占一层 Esc，`zClassForDepth(escDepth)` 算 z-index
 *   —— 视觉层级与 Esc 应答读同一个栈，不存在两套来源对不上的可能；
 * - 取图**直接调** `quickLookImageUrl(asset)`（三级回退 + `vault://` 编码全在那一处），
 *   ⛔ 绝不在这里自己拼 `vault://`。
 *
 * 不复用的部分：Quick Look 是「纯预览、不放任何编辑控件」（docs/32 §4 拍板的职责边界），
 * 本浮层恰恰是**编辑**（指派分类）—— 在那边加分类控件会破坏它的边界，所以另起一个组件。
 *
 * ## 状态归属：游标在组件里，待办集在 store 派生
 *
 * - 游标（第几张 / 跳过集）是**会话内**状态 → 组件 `useState`，关掉就丢（需求 6 明确
 *   "不做持久化"）。不放 store 的理由见 `store.ts` 的 `triageActive` 注释；
 * - 待办集每帧由 `useActiveTriageQueue()` 现算（**按 store 的 `triageMode` 自动选**：
 *   `unclassified` = 全库双未分类、`conflict` = 全库分类存疑，两者都只滤软删、都跟随当前排序），
 *   资产被删 / 被归类 / 排序变化都自动反映 —— 不需要在每个删除路径补清理点，
 *   也不会出现"整理中的那张已经不在库里，浮层还在显示它"。
 *
 * ## 两种模式（docs/35 §4.2 · R-10）
 *
 * 同一个浮层承载两种待办队列，只有 4 处与模式耦合：**队列来源**（`useActiveTriageQueue`）、
 * **标题文案**、**收尾文案**、**右栏「来源对比」块**（只有 `conflict` 有）。
 * 其余 30+ 条纪律（Esc 栈、`reconcileTriage` 接位、`busy` 防连按、`panelOpen` 让路、
 * 选中态跟随）**两种模式共用一份**，所以复用一个组件而不是另起一个 —— 另起必然漂移。
 *
 * ⚠️ `unclassified` 的文案**一个字节都不能变**（既有测试与用户肌肉记忆都靠它）。
 *
 * ## 键位
 *
 * 全部判据在 `logic/triageFlow.ts::decideTriageKey`（纯函数、可单测），这里只 dispatch：
 * `←/→` 纯移动、`K/J` 跳过、`Enter` 确认、`Esc` 关闭（走 `useEscLayer`，**不在本文件
 * 手写 Esc 捕获**）。`isTypingTarget` 让路：分类面板里可能有自由输入框。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useActiveTriageQueue, useVault, type TriageMode } from '../store'
import { useEscLayer } from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'
import { quickLookImageUrl } from '../logic/quickLook'
import { level1OptionsFor, level2OptionsFor } from '../logic/category'
import {
  advanceAfterAssign,
  decideTriageKey,
  reconcileTriage,
  skipCurrent,
  startTriage,
  stepTriage,
  triageCloseNotice,
  triageIndex,
  type TriageCursor
} from '../logic/triageFlow'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { customLevel1Of, customLevel2Of, mergeVocab } from '../../shared/customTaxonomy'
import { KIND_LABEL } from '../../shared/classify'
import { formatBytes } from '../../shared/format'
import { categoriesOf } from '../logic/category'
import { IconClose } from '../icons'
import {
  swipeClassOf,
  swipeDirOf,
  swipeTimingOf,
  type SwipeDir,
  type SwipeTiming
} from '../logic/triageSwipe'
import type { Asset } from '../../shared/types'

/**
 * 焦点是否落在可输入控件里（与 `AssetGrid` / `QuickLookOverlay` 同判据，
 * 但**本文件独立一份**而不是从那边 import）：
 * ① 那两个是组件内部函数、没导出；② 为一个 8 行判据去改别人的导出面，比重复更贵。
 *
 * 为什么必须守：分类面板在「无级联词表」的大类下会退化成自由输入框，
 * 用户在框里打字时 `J`/`K`/`Enter` 都属于输入框，不该被浮层抢走。
 */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

/**
 * `prefers-reduced-motion: reduce` 订阅。
 *
 * **照抄** `AssetGrid.tsx:187` 的同名 hook，而不是去那边导出：它为组件内部函数、
 * 没进公共面；为一个 20 行判据去改别人文件的导出面，比重复更贵（与本文件
 * `isTypingTarget` 的处理同一取舍）。
 *
 * 为什么不进 store：它是**系统级**偏好，与 `settings.motionQuality`（用户显式选的
 * 性能档）是两件事，命中任一条都该退化成纯淡出。
 */
function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (): void => setReduced(mq.matches)
    // 老 Chromium 只有 addListener；Electron 33 两者都有，这里以 addEventListener 为主
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])
  return reduced
}

/** 一级 + 二级选择里的一行（`value` 写回分类，`label` 只展示，`custom` 画角标） */
interface CatOption {
  value: string
  custom: boolean
}

/**
 * 飞出方向（**交互契约**，只在这里取一次）。
 *
 * 用户 2026-10-30 原话：「跳过就向左滑，卡片往左边飞出去；确认就向右滑，卡片往右边飞出去」。
 * 判据本体在 `logic/triageSwipe.ts::swipeDirOf`，这里只是把结果钉成常量 ——
 * 组件里所有触发点（确认按钮 / 跳过按钮 / Enter / J / K）都引用这两个常量，
 * 不在任何一处重写三元表达式，改方向只改 `triageSwipe.ts` 一行。
 */
const CONFIRM_DIR: SwipeDir = swipeDirOf('confirm') // 'right'
const SKIP_DIR: SwipeDir = swipeDirOf('skip') // 'left'

/**
 * 常驻面板里的**一级 / 二级按钮 + 自绘下拉**。
 *
 * 不复用 `CategoryPicker` 组件本体：它是 `Modal` 外壳的一次性弹窗（自带 Esc 层、
 * 自带 `pickerIds` 全局状态），塞进本浮层会出现**两层 Esc**与"关掉的是哪一层"的歧义。
 * 复用它的**判据**（`level1OptionsFor` / `level2OptionsFor` / `mergeVocab` / 自定义词表），
 * 那是真正决定"能选什么"的部分；外观按本浮层自己的常驻面板排版。
 */
function CategoryCascade({
  kind,
  level1,
  level2,
  onChange,
  onPanelToggle
}: {
  kind: Asset['kind']
  level1: string
  level2: string
  onChange: (next: { level1: string; level2: string }) => void
  /** 面板开合上报：展开时浮层不抢 Enter / ↑↓（那是面板自己的键） */
  onPanelToggle: (open: boolean) => void
}) {
  const customTax = useVault((s) => s.settings?.customTaxonomy)
  const [open, setOpen] = useState<'l1' | 'l2' | null>(null)

  // 面板开合同步给上层（上层据此让出 Enter / ↑↓）
  useEffect(() => {
    onPanelToggle(open !== null)
  }, [open, onPanelToggle])

  const l1Custom = customLevel1Of(customTax)
  const l2Custom = customLevel2Of(customTax, level1)
  const l1Items: CatOption[] = useMemo(
    () => [
      { value: UNCLASSIFIED, custom: false },
      ...mergeVocab(
        level1OptionsFor(kind).filter((v) => v !== UNCLASSIFIED),
        l1Custom
      ).map((it) => ({ value: it.value, custom: it.custom }))
    ],
    [kind, l1Custom]
  )
  const l2Options = level2OptionsFor(level1, kind)
  const l2Items: CatOption[] = useMemo(
    () => [
      { value: UNCLASSIFIED, custom: false },
      ...mergeVocab(
        (l2Options ?? []).filter((v) => v !== UNCLASSIFIED),
        l2Custom
      ).map((it) => ({ value: it.value, custom: it.custom }))
    ],
    [l2Options, l2Custom]
  )

  /** 一级「未分类」时二级锁定（与 `normalizeCategoryPair` 的级联规则一致，不让选出非法组合） */
  const l2Locked = level1 === UNCLASSIFIED

  const rowCls = (active: boolean): string =>
    `flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
      active ? 'bg-accent-tint font-medium text-accent-text' : 'text-secondary hover:bg-elevated/60'
    }`

  return (
    <div className="flex flex-col gap-2">
      {/* 一级 */}
      <div className="relative">
        <div className="mb-1 text-[11px] text-tertiary">一级分类</div>
        <button
          type="button"
          className="input flex h-8 w-full items-center justify-between text-left text-[12px]"
          onClick={() => setOpen((o) => (o === 'l1' ? null : 'l1'))}
          aria-expanded={open === 'l1'}
        >
          <span className="truncate">{level1}</span>
          <span className="ml-2 shrink-0 text-[10px] text-tertiary">{open === 'l1' ? '▴' : '▾'}</span>
        </button>
        {open === 'l1' && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[240px] overflow-y-auto rounded-btn border border-line bg-card p-1 shadow-modal">
            {l1Items.map((it) => (
              <button
                key={it.value}
                type="button"
                className={rowCls(it.value === level1)}
                onClick={() => {
                  // 改一级 → 二级重置（与 CategoryPicker 的 `applyLevel1` 同规则：
                  // 旧的二级可能不在新词表里，必须先清掉）
                  onChange({ level1: it.value, level2: UNCLASSIFIED })
                  setOpen(null)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{it.value}</span>
                {it.custom && <span className="ml-1 shrink-0 text-[9px] text-tertiary">自定义</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 二级 */}
      <div className="relative">
        <div className="mb-1 text-[11px] text-tertiary">
          二级分类{l2Locked && <span className="ml-1 text-muted">（一级未分类时锁定）</span>}
        </div>
        <button
          type="button"
          className="input flex h-8 w-full items-center justify-between text-left text-[12px] disabled:opacity-40"
          disabled={l2Locked}
          onClick={() => setOpen((o) => (o === 'l2' ? null : 'l2'))}
          aria-expanded={open === 'l2'}
        >
          <span className="truncate">{level2}</span>
          <span className="ml-2 shrink-0 text-[10px] text-tertiary">{open === 'l2' ? '▴' : '▾'}</span>
        </button>
        {open === 'l2' && !l2Locked && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[240px] overflow-y-auto rounded-btn border border-line bg-card p-1 shadow-modal">
            {l2Items.map((it) => (
              <button
                key={it.value}
                type="button"
                className={rowCls(it.value === level2)}
                onClick={() => {
                  onChange({ level1, level2: it.value })
                  setOpen(null)
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {it.value === UNCLASSIFIED ? it.value : `${level1}/${it.value}`}
                </span>
                {it.custom && <span className="ml-1 shrink-0 text-[9px] text-tertiary">自定义</span>}
              </button>
            ))}
            {l2Items.length <= 1 && (
              <div className="px-2 py-2 text-[11px] text-tertiary">该一级下暂无二级词条</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 关闭整理浮层时的收尾提示（**按模式分叉**）。
 *
 * - `unclassified`：**逐字**沿用 `triageCloseNotice`（P2 既有文案，既有测试与用户肌肉记忆
 *   都靠它，一个字节不改）；
 * - `conflict`：同一句式换词 —— 用户点的是「待确认」，退出时听到「未分类」会以为点错了。
 *
 * 为什么不给 `triageCloseNotice` 加参数：`logic/triageFlow.ts` 是 `docs/35 §7.2` 明令
 * **零改动**（R-10）的文件，而那句文案属于它的既有行为。
 */
function closeNoticeOf(mode: TriageMode | null, remaining: number): string {
  if (mode !== 'conflict') return triageCloseNotice(remaining)
  const n = Number.isFinite(remaining) ? Math.max(0, Math.trunc(remaining)) : 0
  return n === 0 ? '待确认已清空' : `还有 ${n} 张待确认`
}

/**
 * `conflict` 模式的右栏「来源对比」块（`docs/35 §4.2` 的三行 + 两个候选按钮）。
 *
 * ## 三行分别从哪来（**S1 不落库，所以不能从 `sources` 拿**）
 *
 * | 行 | 取值 |
 * |---|---|
 * | 语义判成 | `categoriesOf(asset)` —— 这就是 S1 当初给出的落点（当前分类） |
 * | 站方判成 | `classifyReview.sources.s2.level1/level2` |
 * | 站方另说 | `classifyReview.sources.s3`（有才渲染，没有这一行不出现） |
 *
 * `ClassifyReview.sources` 里**没有 `s1`** 是刻意的（R-13：`classifyAssetName` 是纯函数，
 * 存进库只会随词表升级而腐坏）。别为了"三行对称"去补一个 s1 字段。
 *
 * ## `s2` 缺失时（数据被旧版本写坏的兜底）
 *
 * 只给一行「这一条的分类有争议，请手动选择」，**不裸访问** `s2.level1` —— conflict 理论上
 * 必有 S2，但旧数据 / 手改库什么都可能，崩在这里是最没价值的失败方式。下方的分类级联本来
 * 就在（它不依赖 s2），所以用户仍然能选。
 */
function ConflictSources({
  asset,
  busy,
  onPick
}: {
  asset: Asset
  busy: boolean
  /** 选中候选：走**同一条**确认路径（`decideReview` + 前进），不另写一套 */
  onPick: (category1: string, category2: string) => void
}) {
  const cat = categoriesOf(asset)
  const s2 = asset.classifyReview?.sources?.s2
  const s3 = asset.classifyReview?.sources?.s3
  const rowCls = 'flex items-baseline gap-1.5 text-[11px] leading-relaxed'
  const labelCls = 'w-[52px] shrink-0 text-tertiary'
  const valueCls = 'min-w-0 flex-1 truncate text-primary'

  if (!s2) {
    return (
      <div className="mb-3 rounded-btn border border-line bg-elevated/40 px-2 py-1.5 text-[11px] leading-relaxed text-secondary">
        这一条的分类有争议，请手动选择
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-btn border border-line bg-elevated/40 px-2 py-2">
      <div className="mb-1.5 text-[11px] font-medium text-secondary">来源对比</div>
      <div className="flex flex-col gap-1">
        <div className={rowCls}>
          <span className={labelCls}>语义判成</span>
          <span className={valueCls} title={`${cat.category1} / ${cat.category2}`}>
            {cat.category1} / {cat.category2}
          </span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>站方判成</span>
          <span className={valueCls} title={`${s2.level1} / ${s2.level2}`}>
            {s2.level1} / {s2.level2}
          </span>
        </div>
        {s3 && (
          <div className={rowCls}>
            <span className={labelCls}>站方另说</span>
            <span className={valueCls} title={s3}>
              {s3}
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          className="btn !h-7 !px-2 !text-[11px] disabled:opacity-40"
          disabled={busy}
          title={`用语义的结论：${cat.category1} / ${cat.category2}`}
          onClick={() => onPick(cat.category1, cat.category2)}
        >
          用语义的
        </button>
        <button
          type="button"
          className="btn !h-7 !px-2 !text-[11px] disabled:opacity-40"
          disabled={busy}
          title={`用站方的结论：${s2.level1} / ${s2.level2}`}
          onClick={() => onPick(s2.level1, s2.level2)}
        >
          用站方的
        </button>
      </div>
    </div>
  )
}

export function TriageOverlay() {
  /**
   * 队列来源：**按 `store.triageMode` 自动选**（`unclassified` → 双未分类批次，
   * `conflict` → 分类存疑批次）。为什么不在组件里二选一：
   * `triageMode === 'conflict' ? useReviewQueue() : useTriageQueue()` 是**非法**的
   * （hooks 数量必须稳定），而"两个都调用再二选一"会让 `startTriage` 的惰性初始化
   * 拿到错的那一批。选择逻辑下沉在 store（`useActiveTriageQueue`）。
   */
  const queue = useActiveTriageQueue()
  const triageMode = useVault((s) => s.triageMode)
  const closeTriage = useVault((s) => s.closeTriage)
  /**
   * 动效档位（`settings.motionQuality`）+ 系统级无障碍偏好。
   *
   * 两者同时生效：档位决定"多花哨"，`prefers-reduced-motion` 命中就一律压成纯淡出。
   * 取值口径与 `AssetGrid.tsx:1295` 逐字一致（`?? 'balanced'`，旧配置没有该字段时兜底）。
   */
  const motionQuality = useVault((s) => s.settings?.motionQuality ?? 'balanced')
  const reducedMotion = usePrefersReducedMotion()
  /**
   * ⚠️ 本浮层**不调 `assignCategory`**，只调 `decideReview`。
   *
   * 两者都搬目录，但 `decideReview` 额外负责「把 `classifyReview.reason` 清掉 + 写
   * `decidedAt`」。少了这一步，用户确认完这条资产**仍在待确认队列里**（`reviewReasonOf`
   * 第 2 条照样命中），下一轮 `reconcileTriage` 又把它排回来 —— 表现为"按了没反应"。
   * 在 `unclassified` 模式下这是无害的多余动作（那些资产本来就没有 `reason`），
   * 但为了不让两条路径行为分叉，**两种模式共用同一个入口**。
   */
  const decideReview = useVault((s) => s.decideReview)
  const setNotice = useVault((s) => s.setNotice)
  const select = useVault((s) => s.select)

  /** `conflict` 模式：右栏多一块「来源对比」+ 标题/收尾文案分叉 */
  const isConflict = triageMode === 'conflict'

  /**
   * 会话游标。
   *
   * `useState` + 惰性初始化：**首次挂载时按当时的待办集开一个新会话**。
   * 之后每次 `queue` 变化都走 `reconcileTriage`（而不是 reset）—— 那才能做到
   * "当前这张被归类 / 被删 → 下一张接位"，而不是把用户打回第一张。
   */
  const [cursor, setCursor] = useState<TriageCursor>(() => startTriage(queue))
  const [busy, setBusy] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)

  /**
   * 飞出动画的**在途快照**。非 `null` = 正有一张卡在往外飞。
   *
   * ## 为什么要把「正在飞的那张」单独存一份，而不是直接渲染 `current`
   *
   * 确认写库后 `decideReview` 立刻改 store → `queue` 少一张 → `current` 变 `null`
   * （那张已不在待办集里）。如果渲染跟着 `current` 走，飞出去的会是**空白**，
   * 或者更糟：`reconcileTriage` 抢先推游标，用户看到"下一张先出现、飞的是上一张"。
   * 所以飞出期间**冻结**游标与序号，显示靠这份快照。
   *
   * `position` / `total` 一起冻结：否则「1 / 43」会在卡还没飞完时跳到「1 / 42」。
   *
   * ## `phase` 为什么是字符串而不是布尔
   *
   * `'out-confirm'` / `'out-skip'` 直接对应两条交互路径，`onAnimationEnd` 里按它
   * 选推进函数（`advanceAfterAssign` / `skipCurrent`）—— 布尔无法区分两者，
   * 而两者的腾挪语义不同（跳过要记 `skipped`，归类成功不记）。
   */
  const [swipeState, setSwipeState] = useState<{
    phase: 'out-confirm' | 'out-skip'
    /** 飞出方向（确认 right / 跳过 left）。由 `swipeDirOf` 定，不在渲染里判断 */
    dir: SwipeDir
    /** 冻结显示的资产 —— 飞出期间它才是"当前这一张" */
    asset: Asset
    /** 冻结的序号（`triageIndex + 1`，`-1` 表示未知 → 显示 `?`） */
    position: number
    /** 冻结的总数 */
    total: number
    /** 跳过方向（`K` 是 backward）；确认恒为 forward，此字段对它无意义 */
    step: 'forward' | 'backward'
  } | null>(null)
  /**
   * 上一张飞完之后，新卡从哪一侧滑入（`null` = 不播入场；首次挂载不该有动画）。
   *
   * 方向取**与飞出同一个** `dir`：CSS 里入场位移是 `calc(var(--triage-dir) * -24px)`，
   * 于是「右飞（dir=1）→ 新卡从 -24px 处滑入」= 从左边略偏处进来，正是需求要的观感。
   */
  const [enterDir, setEnterDir] = useState<SwipeDir | null>(null)

  /**
   * 单次推进锁（`ref` 而非 `state`）：`onAnimationEnd` 与快速连按可能在同一帧竞争，
   * 用 `state` 判断会读到渲染时的旧值，两次都通过 → 推进两次（连跳过两张）。
   * `ref` 是同步写的，第二次点的瞬间就能读到 `true`。
   */
  const swipeLockRef = useRef(false)
  /** 给 `onAnimationEnd` 用的最新快照（回调不该因为 state 变化而重新绑定） */
  const swipeRef = useRef<typeof swipeState>(null)
  swipeRef.current = swipeState
  /** 给 `onAnimationEnd` / `beginSwipe` 用的最新游标与 queue（回调里不读渲染期的闭包值） */
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const queueRef = useRef(queue)
  queueRef.current = queue

  /** 面板选择的分类（初值 = 当前资产的现值；反正永远是未分类/未分类，但保持口径一致） */
  const [level1, setLevel1] = useState(UNCLASSIFIED)
  const [level2, setLevel2] = useState(UNCLASSIFIED)

  const current: Asset | null = useMemo(
    () => queue.find((a) => a.id === cursor.currentId) ?? null,
    [queue, cursor.currentId]
  )

  /**
   * 关闭（**所有**关闭路径都走它：Esc / ✕ / 点遮罩）：发收尾提示后关闭。
   *
   * 提示里的剩余数用**待办集长度**：`queue` 是"全库里双未分类的"，
   * 而跳过项仍在 `queue` 里（`cursor.ids` 才扣掉跳过）→ 正好是"还剩 N 张"的 `N`。
   *
   * ⚠️ 必须在 `useEscLayer` **之前**定义：那个 hook 首帧就会用这个 handler
   * （虽然它内部存 ref、后续换值不重挂监听，但首帧取值时变量还没初始化会直接崩）。
   */
  const requestClose = useCallback(() => {
    closeTriage()
    setNotice(closeNoticeOf(triageMode, queue.length))
  }, [closeTriage, setNotice, triageMode, queue.length])

  const escDepth = useEscLayer(requestClose, true)

  /**
   * 待办集变化 → 稳游标。
   *
   * 三个来源都会触发：资产被归类（本浮层自己做的）、被外部删除、排序 / 筛选变化。
   * `reconcileTriage` 的三条规则（原地 / 接位 / 清空）都写在纯函数里。
   *
   * ⚠️ **飞出期间不 reconcile**：确认路径在写库成功后立刻 `setSwipeState(...)`，
   * 但 store 的 `assets` 已经变了 → 这个 effect 会先一步把游标推到下一张，
   * 结果是"卡还在飞，底下已经换人了"。推进统一交给 `onAnimationEnd`
   * （`finishSwipe`），它自己会调 `advanceAfterAssign` / `skipCurrent`。
   * 跳过路径同理：`beginSwipe` 不立刻改游标，等动画结束再改。
   *
   * ⚠️ 空集时**不在这里**关闭浮层：要在关闭前发收尾提示，而提示需要知道"库里还剩
   * 多少未分类"。下面那个 effect 负责这件事（它同时覆盖"用户整理完最后一张"和
   * "外部把最后一张删了"两条路径）。
   */
  useEffect(() => {
    if (swipeState !== null) return
    setCursor((c) => reconcileTriage(c, queue))
  }, [queue, swipeState])

  /** 换到新的一张 → 重置图片错误态 + 分类选择 */
  useEffect(() => {
    setBrokenSrc(null)
    setLevel1(UNCLASSIFIED)
    setLevel2(UNCLASSIFIED)
  }, [cursor.currentId])

  /**
   * 待办集空了 → 关闭并提示。
   *
   * `queue.length === 0` 覆盖两条路径：① 用户把最后一张归类完；② 外部删掉了最后一张。
   * 提示文案来自 `triageCloseNotice`（需求 5：「未分类已清空」/「还剩 N 张」）——
   * 这里传 0（待办集空 = 库里没有双未分类的了）。
   *
   * ⚠️ **飞出期间不许关**：确认最后一张时 `decideReview` 一成功 `queue` 立刻变空，
   * 若当场 `closeTriage()`，那张卡还没飞完浮层就没了 —— 用户看不到任何"确认成功"的反馈。
   * 所以等 `finishSwipe` 把 `swipeState` 清空后本 effect 再跑一次（`swipeState` 在依赖里）。
   */
  useEffect(() => {
    if (swipeState !== null) return
    if (queue.length === 0) {
      closeTriage()
      setNotice(closeNoticeOf(triageMode, 0))
    }
  }, [queue.length, swipeState, closeTriage, setNotice, triageMode])

  /**
   * 本档位该用的动画参数（时长 + 类名）。reduced 命中时三档塌成同一组纯淡出。
   *
   * `swipeTimingOf` 里 `TIER_TIMING[motion] ?? balanced` 已经处理了未知档位，
   * 所以这里不需要再兜一层。
   */
  const timing: SwipeTiming = useMemo(
    () => swipeTimingOf(motionQuality, reducedMotion),
    [motionQuality, reducedMotion]
  )

  /**
   * 开始一次飞出（**只改动画状态，不推进游标**）。
   *
   * ## 为什么推进必须等 `onAnimationEnd`
   *
   * 若在这里就 `setCursor`，React 会立刻把 `current` 换成下一张 —— 飞出动画挂在新卡上，
   * 用户看到的是"新卡飞走"，而老卡原地消失。所以游标与动画**解耦**：
   * 这里只冻结快照 + 上锁，推进在 `finishSwipe`。
   *
   * ## 锁是同步的
   *
   * `swipeLockRef.current = true` 写在这里而不是 `finishSwipe`：快速连按两次跳过时，
   * 第二次点击发生在第一次的 320ms 窗口内，必须当场被挡掉 —— 用 state 判断会因为
   * 闭包读到旧值而失效。
   */
  const beginSwipe = useCallback(
    (opts: {
      phase: 'out-confirm' | 'out-skip'
      dir: SwipeDir
      asset: Asset
      step: 'forward' | 'backward'
    }) => {
      if (swipeLockRef.current) return
      swipeLockRef.current = true
      const c = cursorRef.current
      setSwipeState({
        phase: opts.phase,
        dir: opts.dir,
        asset: opts.asset,
        position: triageIndex(c),
        total: c.ids.length,
        step: opts.step
      })
      // 入场动画方向在**这一刻**就清掉：新卡要等这一张飞完才配入场
      setEnterDir(null)
    },
    []
  )

  /**
   * 飞出动画结束 → **真正推进游标**（`onAnimationEnd` 调它）。
   *
   * ## 幂等（连按只推进一次）
   *
   * 三重保险，任一命中就直接返回：
   * ① `swipeRef.current === null` —— 已经推进过了（快照被清空）；
   * ② `e.target !== e.currentTarget` —— 子元素（图片、按钮）的动画结束冒泡上来，
   *    不是卡片主体本身的动画（`onAnimationEnd` 会从子元素冒泡，不挡会提前推进）；
   * ③ `e.animationName` 不含 `triage-swipe` —— 别的动画（如 hover 过渡）收尾。
   *
   * ## 为什么确认与跳过在同一个回调里分叉
   *
   * 两条路径只差"用哪个纯函数腾挪"与"要不要记 skipped"，其余（清快照、解锁、
   * 配下一张入场方向）完全一致。写成两个回调必然漂移成"跳过的入场方向忘了设"。
   */
  const finishSwipe = useCallback(
    (e: React.AnimationEvent<HTMLDivElement>) => {
      const snap = swipeRef.current
      if (!snap) return
      // ② 只认卡片主体自己的动画（子元素的 animationend 会冒泡上来）
      if (e.target !== e.currentTarget) return
      // ③ 只认本功能的 keyframes（`triage-swipe-*` / `triage-fade-*`）
      if (!/triage-(swipe|fade)-/.test(e.animationName)) return

      swipeLockRef.current = false
      swipeRef.current = null
      setSwipeState(null)
      // 下一张从"与飞出相反的一侧"滑入（CSS 用 --triage-dir 取反）
      setEnterDir(snap.dir)

      if (snap.phase === 'out-confirm') {
        setCursor((c) => advanceAfterAssign(c))
        // 写库已成功，动画也放完了 —— 到这里才允许下一次确认（见 `confirm` 头注释）
        setBusy(false)
      } else {
        setCursor((c) => skipCurrent(c, snap.step))
      }
    },
    []
  )

  /**
   * 「跳过」（按钮 / `J` / `K` 三处共用）。
   *
   * 不写库，所以没有"等 IPC"这一步：立刻播飞出，游标在动画结束后推进。
   * `busy` 不参与 —— 跳过不改库，没必要挡住；挡住它的只有 `swipeLockRef`
   * （正在飞的那一张不该被再跳一次）。
   */
  const skip = useCallback(
    (step: 'forward' | 'backward') => {
      if (!current || swipeLockRef.current || busy) return
      beginSwipe({ phase: 'out-skip', dir: SKIP_DIR, asset: current, step })
    },
    [current, busy, beginSwipe]
  )

  /**
   * 归类确认（**两种模式、三条路径共用这一份**）。
   *
   * ## 顺序（不可调换 —— 否则会出现"飞出去了但没归类"或"归了类但没飞"）
   *
   * ① 校验收敛：一级未分类时二级强制未分类（与 `normalizeCategoryPair` 同规则，
   *    避免把非法组合发下去再被改写）；
   * ② `decideReview`（内部先 `assignCategory` 搬目录，成功后清 `classifyReview.reason`
   *    并写 `decidedAt` —— 否则这条资产仍留在待确认队列里，见 store 的 action 注释）；
   * ③ **写库成功之后才播飞出动画**（`beginSwipe`）—— 需求明确"写库失败不播飞出，
   *    保持原位让用户重试"，所以动画不能抢在 IPC 前面放；
   * ④ 真正推进游标在 `finishSwipe`（`onAnimationEnd`），那里用 `advanceAfterAssign`
   *    （不写 skipped：那张已经归类走了，不该被记成跳过）。
   *
   * ## 为什么确认路径的 `busy` 要**一直挂到动画结束**
   *
   * 写库 `await` 完就 `setBusy(false)` 会让用户在 320ms 的飞出期间再按一次 Enter，
   * 而此时 `current` 还是那张（游标还没推进）→ 同一张被写两次、飞两次。
   * 所以 `busy` 的解除放到 `finishSwipe` 里（`prev` 路径的 `finally` 不再碰它）。
   * 代价是按钮在动画期间保持"归类中…"置灰 —— 那恰好是正确的反馈。
   *
   * ## 特别注意 `moved === 0 && failed === 0`
   *
   * 那是 `skipped`（已在目标分类）。此时**也要飞**（用户确认了"这张就该是这个分类"），
   * 只是提示口径要准 —— 不谎称"已移动"。而 `failed > 0` / IPC reject 一律**不飞**。
   *
   * ## 为什么带可选参数 `explicit`
   *
   * `conflict` 模式下的两个候选按钮（「用语义的」/「用站方的」）要落到**候选给的那对**，
   * 而 `level1` / `level2` 是 setState —— 同一 tick 里 `setLevel1(...)` 之后 `confirm()`
   * 读到的还是旧值。所以候选走 `confirm({ c1, c2 })` 直接传参，**不复制一份归类逻辑**
   * （复制就会漏掉 moved/failed/skipped 三分支里的任何一处）。
   * 不传参 = 用面板当前选择（Enter / 底部主按钮走这条，与 P2 行为逐字一致）。
   */
  const confirm = useCallback(
    async (explicit?: { c1: string; c2: string }) => {
      if (!current || busy || swipeLockRef.current) return
      // 一级：候选按钮给的那对优先（它们要落到候选本身的落点，而面板可能压根没被动过）
      const picked1 = explicit ? explicit.c1 : level1
      const c1 = picked1.trim() || UNCLASSIFIED
      const c2 = c1 === UNCLASSIFIED ? UNCLASSIFIED : level2.trim() || UNCLASSIFIED
      // 二级同理：候选路径用候选给的二级（仍过同一套收敛规则，见下）
      const t2 = explicit ? explicit.c2.trim() || UNCLASSIFIED : c2
      if (c1 === UNCLASSIFIED) {
        // 没选一级就确认 = 什么都没改。提示而不是静默（用户会以为键坏了）
        setNotice('请先选择一级分类')
        return
      }
      setBusy(true)
      try {
        const summary = await decideReview(current.id, c1, t2)
        if (summary.moved > 0) {
          // ③ 写库成功 → 播右飞；游标推进交给 onAnimationEnd（`busy` 保持 true）
          beginSwipe({ phase: 'out-confirm', dir: CONFIRM_DIR, asset: current, step: 'forward' })
        } else if (summary.failed > 0) {
          // 失败：**不飞**、停在这张，把 main 侧的失败原因说清楚（不吞）
          setNotice('归类失败：目录移动未成功，请检查后再试')
          setBusy(false)
        } else {
          // skipped（已在目标分类）：仍然飞（用户确认了这张的归属），口径要准
          setNotice('该资产已在此分类，未移动')
          beginSwipe({ phase: 'out-confirm', dir: CONFIRM_DIR, asset: current, step: 'forward' })
        }
      } catch (err) {
        // IPC reject（main 抛错）：与 failed 同口径，**不飞**、停在这张
        console.warn('[TriageOverlay] 归类失败：', err)
        setNotice('归类失败：请求未完成，请重试')
        setBusy(false)
      }
      // 不写 finally：成功分支的 `busy` 由 `finishSwipe` 解除（见函数头注释）
    },
    [current, busy, level1, level2, decideReview, setNotice]
  )

  /**
   * 键盘：判据全在 `decideTriageKey`，这里只 dispatch。
   *
   * ⚠️ Esc **不在**这里处理（`decideTriageKey` 对 Escape 返回 `none`）——
   * 由 `useEscLayer` 的捕获阶段监听负责，否则一次按键关两层。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = decideTriageKey({
        key: e.key,
        typing: isTypingTarget(e.target),
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat,
        panelOpen,
        // 飞出动画在播（250–340ms）也算"忙"：这期间按 ←/→ 会改掉游标，
        // 而 `finishSwipe` 随后从**已经改过**的游标上推进 —— 跳过的会是错的那张。
        // `skip()` 自己有 `swipeLockRef` 兜底，但方向键没有，所以在这里一起挡。
        busy: busy || swipeState !== null
      })
      if (action === 'none') return
      // 这些键都有浏览器默认行为（方向键滚容器、Enter 提交表单、J/K 在输入框里打字）
      e.preventDefault()
      if (action === 'next') setCursor((c) => stepTriage(c, 1))
      else if (action === 'prev') setCursor((c) => stepTriage(c, -1))
      else if (action === 'skipNext') skip('forward')
      else if (action === 'skipPrev') skip('backward')
      else if (action === 'confirm') void confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, busy, swipeState, confirm, skip])

  /**
   * 当前这张变了 → 把选中态跟着切（关闭后要落回"最后整理的那张"，需求 7）。
   *
   * 用 `select` 而不是直接改 selectedIds：`select` 还负责"首次点开时预热球图"。
   * 不放在 `confirm` 里而是跟着 `cursor.currentId` 走：这样 ←/→ 换图、跳过、
   * 归类前进都会同步选中，任何一条路径退出后选中都落在用户最后看到的那张。
   */
  useEffect(() => {
    if (cursor.currentId) select(cursor.currentId)
  }, [cursor.currentId, select])

  // 飞出期间显示**冻结的那张**，而不是 `current` —— 确认写库后 `current` 已变
  // （那张被移出待办集），跟着它走会飞出一张空白卡。见 `swipeState` 的注释。
  const view: Asset | null = swipeState?.asset ?? current
  const url = view ? quickLookImageUrl(view) : null

  // 没有当前项（正常路径下上面那个空集 effect 已经把浮层关掉了；这里是兜底不崩）
  if (!view) return null

  const position = swipeState ? swipeState.position : triageIndex(cursor)
  const total = swipeState ? swipeState.total : cursor.ids.length
  const cat = categoriesOf(view)

  /**
   * 卡片主体这一层要挂的动画。
   *
   * 三态互斥（`idle` / `out` / `in`）：
   * - 有 `swipeState` → 飞出（档位 class + 方向 class）；
   * - 有 `enterDir` → 入场（方向 class 相同，CSS 用 `--triage-dir * -24px` 反向偏移）；
   * - 都没有 → 不加类（首次挂载不该有任何动画）。
   *
   * 方向用 CSS 变量 `--triage-dir`（1 = 右 / -1 = 左）传给 `@keyframes` ——
   * 一份 keyframes 服务两个方向，不写左右两份。
   */
  const dir: SwipeDir | null = swipeState ? swipeState.dir : enterDir
  const bodyClass = swipeState
    ? swipeClassOf(timing, swipeState.dir, true)
    : enterDir
      ? swipeClassOf(timing, enterDir, false)
      : ''
  const bodyStyle = dir ? ({ ['--triage-dir']: dir === 'right' ? 1 : -1 } as CSSProperties) : undefined

  /**
   * 卡片主体的动画收尾（`onAnimationEnd` 唯一入口）。
   *
   * 两种情况都从子元素冒泡上来（图片 `object-contain`、按钮过渡、下拉展开），
   * 所以**必须**先挡 `e.target !== e.currentTarget`：不挡的话图片一加载完
   * 就触发一次 `animationend`，游标会在动画还没开始前就推进。
   */
  const onBodyAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if (swipeRef.current) {
      finishSwipe(e)
      return
    }
    // 入场动画结束 → 摘掉类，避免元素长期挂 `will-change` 白占合成层。
    // ⚠️ 判据用 `^triage-` 而不是 `triage-(swipe-in|fade-in)`：reduced 档的入场
    // keyframes 叫 `triage-swipe-fade-in`，硬编码两个名字会漏掉它 ——
    // 类永久留在元素上，下一次飞出时两个 animation-name 打架（飞出可能不播）。
    if (enterDir && e.animationName.startsWith('triage-')) setEnterDir(null)
  }

  return (
    <div
      className={`dialog-scrim quicklook-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-label={`${isConflict ? '确认分类（有争议）' : '整理未分类'}：${view.name}`}
      onPointerDown={(e) => {
        // 点遮罩关闭（本体 stopPropagation）
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      {/* 承载整块浮层的**实底卡片**（用户 2026-10-30 反馈：右栏原先裸挂在遮罩上，
          底下的材质球能透过面板看到，文字与球糊在一起、读不了，视觉上"接不住"）。
          外壳取 `CustomRenderDialog`（用户点名的「渲染材质球部分」）同一个组合：
          `rounded-modal-render border border-line bg-card shadow-modal` —— 两处必须同源，
          否则一个弹窗白卡、一个灰卡，又是新的不一致。
          ⛔ `bg-card`（`--surface-card`）是**不透明**色值，不许加 `/95` 之类的透明度，
          也不许上 `backdrop-blur`（规范 §1 全局禁玻璃拟态）。
          遮罩 `.quicklook-scrim` 保留：它负责压暗底层网格，与不透明卡片形成两层隔离。

          ⚠️ 2026-10-30 探探式飞出：**外卡不再 `overflow-hidden`**。它会把子元素的
          位移动画裁在圆角矩形里 —— 卡片"飞不出去"，看起来只是原地淡出。
          裁剪职责下移到需要它的两处：左栏画框（裁大图溢出）与右栏（`overflow-y-auto`）。
          外卡保留 `relative`（飞出层定位）与圆角（视觉边界不变）。 */}
      <div
        className="relative flex max-h-[min(86vh,760px)] w-full max-w-[min(94vw,1080px)] gap-5 overflow-visible rounded-modal-render border border-line bg-card p-5 shadow-modal"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* ── 卡片主体：左右两栏的**共同包裹层**，飞出动画挂在这一层 ──
            为什么两栏一起飞而不是只飞左图：它们是一个整体语义「当前这一张」
            （右栏的分类选择也属于这张卡）。只飞左边会让右栏留在原地，
            读起来像"图飞走了、面板换人了"，比不做动画更乱。
            `min-h-0` 让内部右栏的 `overflow-y-auto` 仍能生效（flex 子项默认
            `min-height: auto` 会撑破父级 `max-h`）。 */}
        <div
          className={`flex min-h-0 w-full gap-5 ${bodyClass}`}
          style={bodyStyle}
          onAnimationEnd={onBodyAnimationEnd}
        >
          {/* ── 左：封面大图（画框尺寸恒定，与 Quick Look 同一条纪律：翻页时版面不跳） */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* 画框底取 `bg-canvas` 而不是 `bg-panel`：浅色档 `--panel-bg` 与父级
                `--surface-card` 同为纯白（同值），叠进实底卡片后画框边界会彻底消失，
                大图失去承托面。`--bg-canvas` 两个主题都比卡片深一档（方向一致），
                画框重新读得出来。
                `overflow-hidden` **必须留在这一层**：外卡的裁剪摘掉后，长图 /
                超大图会溢出画框压到信息行上。 */}
            <div className="flex h-[min(62vh,560px)] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-canvas">
              {url && brokenSrc !== url ? (
                <img
                  src={url}
                  alt={view.name}
                  onError={() => setBrokenSrc(url)}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="text-[12px] text-tertiary">该资产没有可预览的图片</div>
              )}
            </div>

            {/* 信息行：名称 / 大类 / 分类 / 大小 / 文件数 */}
            <div className="mt-3">
              <div className="truncate text-[14px] font-semibold text-primary" title={view.name}>
                {view.name}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-secondary">
                <span className="text-accent-text">{KIND_LABEL[view.kind]}</span>
                <span className="text-muted">·</span>
                <span>
                  {cat.category1} / {cat.category2}
                </span>
                <span className="text-muted">·</span>
                <span className="tabular-nums">{formatBytes(view.size)}</span>
                <span className="text-muted">·</span>
                <span className="tabular-nums">{view.files.length} 个文件</span>
              </div>
            </div>
          </div>

          {/* ── 右：常驻分类面板 + 操作 */}
          {/* `min-h-0 overflow-y-auto`：`conflict` 模式多出「来源对比」那一块（约 110px），
              矮屏 / 低分屏下右栏会超出父容器的 `max-h` 被裁掉下半截（确认按钮消失）。
              `min-h-0` 是 flex 子项能真正收缩的前提（默认 `min-height: auto` 会撑开）；
              `unclassified` 模式内容本就不超，不出现滚动条，视觉零变化。 */}
          <div className="flex min-h-0 w-[240px] shrink-0 flex-col overflow-y-auto">
            {/* 标题档位对齐设置页 `PageHeader`：主标题 `text-[13px] font-semibold`（设置页 h2
                是 17px 但那是整页页头，浮层内的区块标题取同一族的 13px 一档，不再出现
                浮层 13px 与设置 14px 混用）；计数走 11px `tabular-nums` 对齐数字列宽。
                `pr-6` 给右上角那颗绝对定位的关闭按钮让位，否则「1 / 43」被压在 ✕ 下面。 */}
            <div className="mb-3 flex items-baseline justify-between pr-6">
              <span className="text-[13px] font-semibold text-primary">
                {isConflict ? '确认分类（有争议）' : '指派分类'}
              </span>
              <span className="text-[11px] tabular-nums text-tertiary">
                {position >= 0 ? position + 1 : '?'} / {total}
              </span>
            </div>

            {/* conflict 模式：先摆「为什么存疑」（三行来源对比 + 两个候选按钮），
                再是常规级联 —— 用户看到争议的**依据**才会做选择，摆在级联后面只会被滚过去。
                `s2` 缺失时该组件自己退化成一行提示（旧数据兜底，不崩、不留空行）。 */}
            {isConflict && (
              <ConflictSources
                asset={view}
                busy={busy}
                onPick={(c1, c2) => void confirm({ c1, c2 })}
              />
            )}

            {/* 分类选择区：包成**实底分区**（用户反馈的核心 —— 原先两个下拉是裸的 `input`，
                压在遮罩与材质球上，文字与背景糊在一起）。分区底 `bg-elevated/40` 只在这里
                安全：父级已是**不透明** `bg-card`，40% 叠在实底上仍不透，不会透出底下的球。
                ⛔ 不许把这个分区挪到卡片外面直接挂遮罩 —— 那样又回到半透明。 */}
            <div className="rounded-btn border border-line bg-elevated/40 p-2.5">
              <CategoryCascade
                kind={view.kind}
                level1={level1}
                level2={level2}
                onChange={(next) => {
                  setLevel1(next.level1)
                  setLevel2(next.level2)
                }}
                onPanelToggle={setPanelOpen}
              />
            </div>

            {/* 底部操作区：与上方内容用 `border-t` 分隔（设置页卡片流同一手法），
                按钮高度对齐 `CustomRenderDialog` 的 `!h-10 !text-[13px]` 一档 —— 两处出口
                视觉同高，不再出现"渲染弹窗 40px、整理浮层 36px"。
                `group` 给按钮内的方向箭头用：hover 时确认按钮右侧浮出 `→`、
                跳过按钮左侧浮出 `←` —— 把"这张会往哪飞"提前告诉用户，
                不用等他按下去才知道方向（CSS 实现，不额外引入状态）。 */}
            <div className="mt-4 flex shrink-0 flex-col gap-2 border-t border-line pt-3">
              <button
                type="button"
                className="btn-solid group !h-10 !text-[13px] disabled:opacity-40"
                disabled={busy}
                onClick={() => void confirm()}
              >
                <span className="inline-flex items-center gap-1">
                  <span>{busy ? '归类中…' : '确认并下一张'}</span>
                  <span
                    aria-hidden="true"
                    className="text-[13px] opacity-0 transition-opacity duration-150 group-hover:opacity-70"
                  >
                    →
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="btn group !h-10 !text-[13px] disabled:opacity-40"
                disabled={busy}
                onClick={() => skip('forward')}
              >
                <span className="inline-flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="text-[13px] opacity-0 transition-opacity duration-150 group-hover:opacity-70"
                  >
                    ←
                  </span>
                  <span>跳过</span>
                </span>
              </button>
            </div>

            <div className="mt-auto pt-3 text-[11px] leading-relaxed text-tertiary">
              <div>← → 切换 · J K 跳过</div>
              <div>Enter 确认 · Esc 退出</div>
            </div>
          </div>
        </div>

        {/* 右上关闭（**在卡片主体之外**：它不参与飞出，否则用户会失去"随时退出"的锚点） */}
        <button
          className="btn btn-ghost absolute right-5 top-5 p-1.5 text-secondary transition hover:text-primary"
          onClick={requestClose}
          title="关闭（Esc）"
          aria-label="关闭整理"
        >
          <IconClose />
        </button>
      </div>
    </div>
  )
}
