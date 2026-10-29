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

import { useCallback, useEffect, useMemo, useState } from 'react'
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

/** 一级 + 二级选择里的一行（`value` 写回分类，`label` 只展示，`custom` 画角标） */
interface CatOption {
  value: string
  custom: boolean
}

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
   * ⚠️ 空集时**不在这里**关闭浮层：要在关闭前发收尾提示，而提示需要知道"库里还剩
   * 多少未分类"。下面那个 effect 负责这件事（它同时覆盖"用户整理完最后一张"和
   * "外部把最后一张删了"两条路径）。
   */
  useEffect(() => {
    setCursor((c) => reconcileTriage(c, queue))
  }, [queue])

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
   */
  useEffect(() => {
    if (queue.length === 0) {
      closeTriage()
      setNotice(closeNoticeOf(triageMode, 0))
    }
  }, [queue.length, closeTriage, setNotice, triageMode])

  /**
   * 归类确认（**两种模式、三条路径共用这一份**）。
   *
   * 顺序（不可调换）：
   * ① 校验收敛：一级未分类时二级强制未分类（与 `normalizeCategoryPair` 同规则，
   *    避免把非法组合发下去再被改写）；
   * ② `decideReview`（内部先 `assignCategory` 搬目录，成功后清 `classifyReview.reason`
   *    并写 `decidedAt` —— 否则这条资产仍留在待确认队列里，见 store 的 action 注释）；
   * ③ **只有真的移动成功**（`moved > 0`）才前进 —— 需求 4 明确「成功才跳下一张
   *    （失败停在这张、给出错误提示，不要吞）」；
   * ④ 前进用 `advanceAfterAssign`（不写 skipped：那张已经归类走了，不该被记成跳过）。
   *
   * 特别注意 `moved === 0 && failed === 0` 的情形：那是 `skipped`（已在目标分类）。
   * 此时**也前进** —— 用户确认了"这张就该是这个分类"，而库里它已经在这了，
   * 停在这张只会让用户反复按确认（`assignCategory` 每次都判 skipped，永远不会动）。
   * 但这不是"成功移动"，所以给一条更准确的提示。
   *
   * ## 为什么带可选参数 `explicit`
   *
   * `conflict` 模式下的两个候选按钮（「用语义的」/「用站方的」）要落到**候选给的那对**，
   * 而 `level1` / `level2` 是 setState —— 同一 tick 里 `setLevel1(...)` 之后 `confirm()`
   * 读到的还是旧值。所以候选走 `confirm({ c1, c2 })` 直接传参，**不复制一份归类逻辑**
   * （复制就会漏掉 moved/failed/skipped 三分支里的任何一处）。
   * 不传参 = 用面板当前选择（Enter / 底部主按钮走这条，与 P2 行为逐字一致）。
   */
  const confirm = useCallback(async (explicit?: { c1: string; c2: string }) => {
    if (!current || busy) return
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
        // ④ 成功：前进（`assignCategory` 已经改了 store 的 assets → `queue` 会变，
        //     但这里立刻推进游标，避免"等 effect 追上"的那一帧停顿）
        setCursor((c) => advanceAfterAssign(c))
      } else if (summary.failed > 0) {
        // 失败：**停在这张**，把 main 侧的失败原因说清楚（不吞）
        setNotice('归类失败：目录移动未成功，请检查后再试')
      } else {
        // skipped（已在目标分类）：前进，但提示口径要准 —— 不谎称"已移动"
        setCursor((c) => advanceAfterAssign(c))
        setNotice('该资产已在此分类，未移动')
      }
    } catch (err) {
      // IPC reject（main 抛错）：与 failed 同口径，停在这张
      console.warn('[TriageOverlay] 归类失败：', err)
      setNotice('归类失败：请求未完成，请重试')
    } finally {
      setBusy(false)
    }
  }, [current, busy, level1, level2, decideReview, setNotice])

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
        busy
      })
      if (action === 'none') return
      // 这些键都有浏览器默认行为（方向键滚容器、Enter 提交表单、J/K 在输入框里打字）
      e.preventDefault()
      if (action === 'next') setCursor((c) => stepTriage(c, 1))
      else if (action === 'prev') setCursor((c) => stepTriage(c, -1))
      else if (action === 'skipNext') setCursor((c) => skipCurrent(c, 'forward'))
      else if (action === 'skipPrev') setCursor((c) => skipCurrent(c, 'backward'))
      else if (action === 'confirm') void confirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, busy, confirm])

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

  const url = current ? quickLookImageUrl(current) : null

  // 没有当前项（正常路径下上面那个空集 effect 已经把浮层关掉了；这里是兜底不崩）
  if (!current) return null

  const position = triageIndex(cursor)
  const total = cursor.ids.length
  const cat = categoriesOf(current)

  return (
    <div
      className={`dialog-scrim quicklook-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-label={`${isConflict ? '确认分类（有争议）' : '整理未分类'}：${current.name}`}
      onPointerDown={(e) => {
        // 点遮罩关闭（本体 stopPropagation）
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        className="flex max-h-[min(86vh,760px)] w-full max-w-[min(94vw,1080px)] gap-5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* ── 左：封面大图（画框尺寸恒定，与 Quick Look 同一条纪律：翻页时版面不跳） */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[min(62vh,560px)] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-panel">
            {url && brokenSrc !== url ? (
              <img
                src={url}
                alt={current.name}
                onError={() => setBrokenSrc(url)}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="text-[12px] text-tertiary">该资产没有可预览的图片</div>
            )}
          </div>

          {/* 信息行：名称 / 大类 / 分类 / 大小 / 文件数 */}
          <div className="mt-3">
            <div className="truncate text-[14px] font-semibold text-primary" title={current.name}>
              {current.name}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-secondary">
              <span className="text-accent-text">{KIND_LABEL[current.kind]}</span>
              <span className="text-muted">·</span>
              <span>
                {cat.category1} / {cat.category2}
              </span>
              <span className="text-muted">·</span>
              <span className="tabular-nums">{formatBytes(current.size)}</span>
              <span className="text-muted">·</span>
              <span className="tabular-nums">{current.files.length} 个文件</span>
            </div>
          </div>
        </div>

        {/* ── 右：常驻分类面板 + 操作 */}
        {/* `min-h-0 overflow-y-auto`：`conflict` 模式多出「来源对比」那一块（约 110px），
            矮屏 / 低分屏下右栏会超出父容器的 `max-h` 被裁掉下半截（确认按钮消失）。
            `min-h-0` 是 flex 子项能真正收缩的前提（默认 `min-height: auto` 会撑开）；
            `unclassified` 模式内容本就不超，不出现滚动条，视觉零变化。 */}
        <div className="flex min-h-0 w-[240px] shrink-0 flex-col overflow-y-auto">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-primary">
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
              asset={current}
              busy={busy}
              onPick={(c1, c2) => void confirm({ c1, c2 })}
            />
          )}

          <CategoryCascade
            kind={current.kind}
            level1={level1}
            level2={level2}
            onChange={(next) => {
              setLevel1(next.level1)
              setLevel2(next.level2)
            }}
            onPanelToggle={setPanelOpen}
          />

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              className="btn-solid !h-9 !text-[13px] disabled:opacity-40"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? '归类中…' : '确认并下一张'}
            </button>
            <button
              type="button"
              className="btn !h-9 !text-[13px] disabled:opacity-40"
              disabled={busy}
              onClick={() => setCursor((c) => skipCurrent(c, 'forward'))}
            >
              跳过
            </button>
          </div>

          <div className="mt-auto pt-4 text-[11px] leading-relaxed text-tertiary">
            <div>← → 切换 · J K 跳过</div>
            <div>Enter 确认 · Esc 退出</div>
          </div>
        </div>

        {/* 右上关闭 */}
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
