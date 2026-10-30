import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useVault } from '../store'
import { KIND_LABEL, kindFolder } from '../../shared/classify'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import { customLevel1Of, customLevel2Of, mergeVocab, sanitizeCustomTerm } from '../../shared/customTaxonomy'
import { level1OptionsFor, level2OptionsFor } from '../logic/category'
import { useEscLayer } from '../logic/escLayer'
import { Modal } from './Modal'

/**
 * 分类级联选择器（T07）：大类 → 一级 → 二级。
 *
 * - 一级选项：model / texture·material / cad / hdri 都有词表册（`level1OptionsFor`），
 *   只有 `other` 退回自由输入；
 * - 二级级联：`level2OptionsFor(一级)` —— 有枚举出下拉、空数组（一级=未分类）锁定为未分类、
 *   null（如材质预设）渲染为「可自由输入」（06 §3.3-②）；
 * - 批量目标跨大类时禁用确认（父目录永远由 asset.kind 算，03 §5.3）；
 * - 确认后调 `store.assignCategory`（RA3 缩略图顺序在 store 内保证），renamed/failed 走全局轻提示。
 *
 * 2026-10（用户反馈「不要系统的默认的东西出现」）：一级 / 二级两处**不再用原生 `<select>`**。
 * 原生控件的选项弹层是 Chromium / 操作系统绘制的（灰底、系统字体与系统高亮），
 * 加 `appearance-none` 只改得到控件外观、改不到弹层 → 与产品 UI 两个风格。
 * 所以触发件仍是 `.input` 盒子，但展开层改成**自绘浮层**，与中栏头「排序」浮层同构：
 *   - 容器 `fixed z-40 w-[176px] rounded-btn border border-line bg-card p-1 shadow-modal`；
 *   - 小标题 `px-2 pb-1 pt-1 text-[10px] text-tertiary`；
 *   - 选项行 `flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition`；
 *   - 选中态只用 `bg-accent-tint font-medium text-accent-text` 一个指示（不再叠勾号）。
 * 定位取触发按钮的 `getBoundingClientRect()` 算 `fixed` 坐标并**右对齐夹取**：
 * 本组件挂在可滚动弹窗里，`absolute top-full` 会被祖先的 overflow 裁掉。
 */

/** 浮层宽度：与中栏头「排序」浮层同宽（`App.tsx` 的 `SORT_PANEL_WIDTH`），保证同一控件家族 */
const CATEGORY_PANEL_WIDTH = 176
/** 浮层顶边与触发按钮底边的间距：与排序浮层同值（`rect.bottom + 6`） */
const CATEGORY_PANEL_GAP = 6
/** 选项列表最高高度：一级词表有 33 项，不封顶会把浮层顶出窗口（超出则列表内滚动） */
const CATEGORY_LIST_MAX_HEIGHT = 280
/** 浮层自身除列表以外的固定高度：p-1 上下各 4px + 小标题行约 22px */
const CATEGORY_PANEL_CHROME = 34
/** 浮层与窗口边缘的最小留白（与排序浮层的 `Math.max(8, …)` 一致） */
const CATEGORY_PANEL_MARGIN = 8

/** 浮层里的一行：`value` 写回分类字段，`label` 只用于展示；`custom` = 用户自定义词条（尾部画角标） */
interface CategoryOption {
  value: string
  label: string
  custom: boolean
}

/** 浮层坐标（`fixed`）：`left/top` 是面板左上角，`listMaxHeight` 给选项列表封顶 */
interface CategoryPanelPos {
  left: number
  top: number
  listMaxHeight: number
}

/**
 * 按**触发按钮**矩形算浮层坐标。
 *
 * `left` 右对齐并夹取到窗口内（面板比按钮宽时不会顶出右缘）；
 * `top` 贴着按钮下方 6px；
 * `listMaxHeight` 按剩余可视高度封顶，保证面板整体不出窗口。
 */
function panelPositionFor(anchor: HTMLElement | null): CategoryPanelPos | null {
  if (!anchor) return null
  const rect = anchor.getBoundingClientRect()
  const left = Math.max(CATEGORY_PANEL_MARGIN, Math.round(rect.right - CATEGORY_PANEL_WIDTH))
  const top = Math.round(rect.bottom + CATEGORY_PANEL_GAP)
  const available = window.innerHeight - top - CATEGORY_PANEL_CHROME - CATEGORY_PANEL_MARGIN
  return { left, top, listMaxHeight: Math.max(84, Math.min(CATEGORY_LIST_MAX_HEIGHT, available)) }
}

export function CategoryPicker() {
  const pickerIds = useVault((s) => s.categoryPickerIds)
  const assets = useVault((s) => s.assets)
  const close = useVault((s) => s.closeCategoryPicker)
  const assignCategory = useVault((s) => s.assignCategory)
  const settings = useVault((s) => s.settings)
  const addCustomCategory = useVault((s) => s.addCustomCategory)
  const removeCustomCategory = useVault((s) => s.removeCustomCategory)
  const setNotice = useVault((s) => s.setNotice)
  /** 用户自定义词表（settings 未加载时按空表——预设词条照常可用） */
  const customTax = settings?.customTaxonomy

  const targets = pickerIds ? assets.filter((a) => pickerIds.includes(a.id)) : []
  const kind = targets[0]?.kind
  const crossKind = targets.length > 1 && new Set(targets.map((t) => t.kind)).size > 1

  const [level1, setLevel1] = useState<string>(UNCLASSIFIED)
  const [level2, setLevel2] = useState<string>(UNCLASSIFIED)
  const [busy, setBusy] = useState(false)

  /** 当前展开的是哪一处浮层；`null` = 都收起（两处互斥，不会同时挂两个面板） */
  const [openField, setOpenField] = useState<'level1' | 'level2' | null>(null)
  /** 浮层坐标：打开那一刻按触发按钮矩形写死（`fixed`，不随布局重排漂移） */
  const [panelPos, setPanelPos] = useState<CategoryPanelPos | null>(null)
  /** 键盘高亮下标（↑/↓ 移动，Enter 选中），与「排序」浮层同一套交互 */
  const [l1Cursor, setL1Cursor] = useState(0)
  const [l2Cursor, setL2Cursor] = useState(0)

  /** 「＋ 新增自定义」行展开状态与草稿（一级 / 二级各一套，两处浮层互斥所以不同时出现） */
  const [addingFor, setAddingFor] = useState<'level1' | 'level2' | null>(null)
  const [draft, setDraft] = useState('')

  const l1Ref = useRef<HTMLDivElement | null>(null)
  const l1ButtonRef = useRef<HTMLButtonElement | null>(null)
  const l2Ref = useRef<HTMLDivElement | null>(null)
  const l2ButtonRef = useRef<HTMLButtonElement | null>(null)

  // 目标集合变化（打开/切换）时重置为当前值（批量取第一个目标的现状）
  useEffect(() => {
    if (pickerIds && targets.length > 0) {
      setLevel1(targets[0].category1 || UNCLASSIFIED)
      setLevel2(targets[0].category2 || UNCLASSIFIED)
    }
    setOpenField(null) // 换了目标集合 → 任何展开中的浮层都要收起（坐标已失效）
    setAddingFor(null)
    setDraft('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerIds])

  /**
   * 分类浮层的关闭路径：点浮层外 / Esc / 窗口 resize。
   *
   * - Esc 交给 `useEscLayer`（`logic/escLayer.ts`）：浮层是弹窗里的**第二层**，
   *   展开期间压在 `Modal` 之上 —— Esc 先收起浮层，再按一次才关整个弹窗。
   *   0.7.6 T-ESC 之前这里手写了一份捕获阶段监听，与另外三个组件重复；现在统一走栈。
   * - resize 必须关：浮层是 `fixed`、坐标在打开那一刻按按钮矩形写死 → 尺寸一变就错位。
   */
  useEffect(() => {
    if (!openField) return
    const root = openField === 'level1' ? l1Ref.current : l2Ref.current
    const onPointerDown = (e: MouseEvent): void => {
      if (root && e.target instanceof Node && root.contains(e.target)) return
      setOpenField(null)
    }
    const onResize = (): void => setOpenField(null)
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', onResize)
    }
  }, [openField])

  /** Esc：只在浮层展开期间占一层，收起浮层（不关弹窗） */
  useEscLayer(() => setOpenField(null), openField !== null)

  /**
   * 兜底自愈：`categoryPickerIds` 非空，但按 id 过滤后**一个目标都不剩**时收口。
   *
   * 什么时候会这样：资产被彻底删除 / 被 rescan 换成新记录 / 选中被别处清空
   * （正常路径下 store 里会同步清 `categoryPickerIds`；这里是第二道保险，
   * 防的是"某条新加的链路忘了清"）。不收口的话 render 返回 null 只是看起来像
   * 弹窗自己卸载了，store 里的旧 id 仍悬着，下次打开会带着上一批 id。
   *
   * 必须放在 `useEffect`（不能在 render 里 setState）：render 期间改 store 会触发
   * React 的 "Cannot update a component while rendering" 警告并可能死循环。
   * 依赖只取长度：`targets` 每次 render 都是新数组，取引用会每帧重跑。
   */
  useEffect(() => {
    if (pickerIds && targets.length === 0) close()
  }, [pickerIds, targets.length, close])

  if (!pickerIds || targets.length === 0 || !kind) return null

  const l1Options = level1OptionsFor(kind)
  const l2Options = level2OptionsFor(level1, kind) // null = 自由输入；[] = 锁定为未分类
  const multi = targets.length > 1

  // ── 自定义词表（2026-10）：与预设词条并列展示，`custom: true` 的行尾部画「自定义」角标 ──
  const l1Custom = customLevel1Of(customTax)
  const l2Custom = customLevel2Of(customTax, level1)

  /** 一级：词表 + 自定义 + 「未分类」哨兵（哨兵恒在首行，与原下拉顺序一致） */
  const l1Items: readonly CategoryOption[] = [
    { value: UNCLASSIFIED, label: UNCLASSIFIED, custom: false },
    ...mergeVocab(l1Options.filter((v) => v !== UNCLASSIFIED), l1Custom).map((it) => ({
      value: it.value,
      label: it.value,
      custom: it.custom
    }))
  ]
  /** 一级浮层是否可用（预设词表为空的大类有自定义词条时也走浮层，否则保留自由输入） */
  const l1HasPanel = l1Options.length > 0 || l1Custom.length > 0
  /** 一级当前值不在任何词表里：只在触发件上标注「词表外」，**不新增可选行**（原值不会被改写） */
  const l1OutOfVocab =
    l1HasPanel && level1 !== UNCLASSIFIED && !l1Items.some((it) => it.value === level1)
  const l1Display = l1OutOfVocab ? `${level1}（词表外）` : level1

  /**
   * 二级：`level2OptionsFor` 已保证「一级/二级」成对显示（不同一级下会有同名二级，
   * 只写二级名容易选错）；一级是「未分类」时该分支根本不渲染。
   * 自定义二级挂在所属一级名下，与预设二级并列展示。
   */
  const l2Merged = mergeVocab((l2Options ?? []).filter((v) => v !== UNCLASSIFIED), l2Custom)
  const l2Items: readonly CategoryOption[] = [
    { value: UNCLASSIFIED, label: UNCLASSIFIED, custom: false },
    ...l2Merged.map((it) => ({ value: it.value, label: `${level1}/${it.value}`, custom: it.custom }))
  ]
  /** 二级浮层是否可用：预设或自定义任一有词条就走浮层；都没有 → 自由输入（原分支保留） */
  const l2HasPanel = l2Merged.length > 0
  /** 二级当前值不在任何词表里：同样只在触发件上标注，不改写原值（自由输入分支不标注） */
  const l2OutOfVocab = l2HasPanel && level2 !== UNCLASSIFIED && !l2Merged.some((it) => it.value === level2)
  const l2Display =
    level2 === UNCLASSIFIED ? UNCLASSIFIED : `${level1}/${level2}${l2OutOfVocab ? '（词表外）' : ''}`

  /** 打开一级浮层：定位 + 高亮落到当前值（当前值不在词表里时落到首行「未分类」） */
  const openLevel1Panel = (cursor?: number): void => {
    const pos = panelPositionFor(l1ButtonRef.current)
    if (!pos) return
    setPanelPos(pos)
    setL1Cursor(cursor ?? Math.max(0, l1Items.findIndex((it) => it.value === level1)))
    setAddingFor(null)
    setOpenField('level1')
  }

  /** 点一级触发件：展开中则收起；否则展开 */
  const toggleLevel1Panel = (): void => {
    if (openField === 'level1') {
      setOpenField(null)
      return
    }
    openLevel1Panel()
  }

  /**
   * 选中一级：写回一级 + **二级重置为「未分类」**（与原 `<select>` 的 onChange 同语义，
   * 级联规则一字未改：改了一级，旧的二级可能已不在新词表里，必须先清掉）。
   */
  const applyLevel1 = (value: string): void => {
    setLevel1(value)
    setLevel2(UNCLASSIFIED)
    setOpenField(null)
  }

  /** 打开二级浮层（选项已由 `level2OptionsFor(level1)` 按一级过滤过） */
  const openLevel2Panel = (cursor?: number): void => {
    const pos = panelPositionFor(l2ButtonRef.current)
    if (!pos) return
    setPanelPos(pos)
    setL2Cursor(cursor ?? Math.max(0, l2Items.findIndex((it) => it.value === level2)))
    setAddingFor(null)
    setOpenField('level2')
  }

  /** 点二级触发件：展开中则收起；否则展开 */
  const toggleLevel2Panel = (): void => {
    if (openField === 'level2') {
      setOpenField(null)
      return
    }
    openLevel2Panel()
  }

  /** 选中二级：只写回二级并收起（一级不变 → 不触级联重置） */
  const applyLevel2 = (value: string): void => {
    setLevel2(value)
    setOpenField(null)
  }

  /**
   * 一级浮层的键盘操作（挂在触发件 + 浮层共同的容器上，事件从当前焦点元素冒泡上来）：
   * ↑/↓ 移动高亮（循环，未展开时展开），Enter 选中高亮项。
   * Esc 由 `useEscLayer` 统一处理（这里不重复，避免一次按键关两层）。
   */
  const onLevel1KeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (openField !== 'level1') {
        openLevel1Panel(Math.max(0, l1Items.findIndex((it) => it.value === level1)))
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setL1Cursor((i) => (i + step + l1Items.length) % l1Items.length)
      return
    }
    if (e.key === 'Enter' && openField === 'level1') {
      // preventDefault：触发件是 button，Enter 的默认行为会再触发一次 click（把刚关掉的面板又打开）
      e.preventDefault()
      const item = l1Items[l1Cursor]
      if (item) applyLevel1(item.value)
    }
  }

  /** 二级浮层的键盘操作：规则与一级完全一致 */
  const onLevel2KeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (openField !== 'level2') {
        openLevel2Panel(Math.max(0, l2Items.findIndex((it) => it.value === level2)))
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setL2Cursor((i) => (i + step + l2Items.length) % l2Items.length)
      return
    }
    if (e.key === 'Enter' && openField === 'level2') {
      e.preventDefault()
      const item = l2Items[l2Cursor]
      if (item) applyLevel2(item.value)
    }
  }

  /**
   * 提交「＋ 新增自定义」：清洗后写入词表并选中该词条。
   * 输入与预设同名 → `addCustomCategory` 幂等返回 false，照常选中（那是预设项，不是自定义）。
   */
  const commitAdd = async (field: 'level1' | 'level2'): Promise<void> => {
    const term = sanitizeCustomTerm(draft)
    setAddingFor(null)
    setDraft('')
    if (!term) return
    if (field === 'level1') {
      await addCustomCategory('level1', null, term)
      setLevel1(term)
      setLevel2(UNCLASSIFIED)
    } else {
      await addCustomCategory('level2', level1, term)
      setLevel2(term)
    }
    setOpenField(null)
  }

  /**
   * 删除自定义词条（删除保护在 store 层）：已被任何资产使用 → 拒绝并提示数量；
   * 删除的是当前选中值时把选择落回「未分类」（词表里已经没有这一行了）。
   */
  const deleteCustom = async (field: 'level1' | 'level2', name: string): Promise<void> => {
    const res = await removeCustomCategory(field, field === 'level2' ? level1 : null, name)
    if (!res.ok && res.used > 0) {
      setNotice(`「${name}」已被 ${res.used} 个资产使用，无法删除`)
      return
    }
    if (field === 'level1' && level1 === name) {
      setLevel1(UNCLASSIFIED)
      setLevel2(UNCLASSIFIED)
    } else if (field === 'level2' && level2 === name) {
      setLevel2(UNCLASSIFIED)
    }
  }

  const confirm = async () => {
    if (busy || crossKind) return
    setBusy(true)
    const c1 = level1.trim() || UNCLASSIFIED
    const c2 = c1 === UNCLASSIFIED ? UNCLASSIFIED : level2.trim() || UNCLASSIFIED
    // 自定义词条落档（2026-10）：输入值不在预设也不在自定义词表 → 记为自定义词条。
    // 自由输入分支（无词表大类 / 无级联词表的一级）打上来的值由此进词表，下次直接可选；
    // 枚举浮层里的既有词条不重复登记（addCustomCategory 内部再兜一道幂等）。
    if (c1 !== UNCLASSIFIED && !l1Options.includes(c1) && !l1Custom.includes(c1)) {
      await addCustomCategory('level1', null, c1)
    }
    if (
      c1 !== UNCLASSIFIED &&
      c2 !== UNCLASSIFIED &&
      !(l2Options ?? []).includes(c2) &&
      !l2Custom.includes(c2)
    ) {
      await addCustomCategory('level2', c1, c2)
    }
    await assignCategory(targets.map((t) => t.id), c1, c2).catch(() => undefined)
    setBusy(false)
    close()
  }

  return (
    <Modal title={multi ? `指派分类（${targets.length} 个资产）` : '指派分类'} onClose={close} width="max-w-md">
      <div className="mb-3 text-[12px] text-muted">
        大类：<span className="font-medium text-primary">{kindFolder(kind)}（{KIND_LABEL[kind]}）</span>
        {multi && '（父目录由各大类自身决定，因此跨大类不能批量指派）'}
      </div>

      {crossKind && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] text-danger">
          选中项跨多个大类，无法批量指派。请先取消多余的大类（Ctrl+点击可切换多选）。
        </div>
      )}

      {/* 一级分类（预设词表为空的大类有自定义词条时也走浮层，否则保留自由输入） */}
      <div className="mb-1 text-[12px] font-medium">一级分类</div>
      {l1HasPanel ? (
        <div ref={l1Ref} onKeyDown={onLevel1KeyDown}>
          <button
            ref={l1ButtonRef}
            type="button"
            className="input flex items-center justify-between gap-2 text-left"
            aria-haspopup="listbox"
            aria-expanded={openField === 'level1'}
            aria-label={`一级分类：${l1Display}`}
            onClick={toggleLevel1Panel}
          >
            <span className="min-w-0 truncate">{l1Display}</span>
            <span aria-hidden className="pointer-events-none shrink-0 text-[9px] text-tertiary">
              ▾
            </span>
          </button>

          {openField === 'level1' && panelPos && (
            <div
              className="fixed z-40 w-[176px] rounded-btn border border-line bg-card p-1 shadow-modal"
              style={{ left: panelPos.left, top: panelPos.top }}
            >
              {/* 小标题放在 listbox **外面**：listbox 的直接子节点只能是 option / group */}
              <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">一级分类</div>
              <div
                role="listbox"
                aria-label="一级分类"
                className="overflow-y-auto"
                style={{ maxHeight: panelPos.listMaxHeight }}
              >
                {l1Items.map((opt, i) => {
                  const active = opt.value === level1
                  return (
                    <div key={opt.value} className="group relative">
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        title={opt.label}
                        // 选中态**只用一个指示**（与排序浮层同款 accent-tint），不再叠勾号
                        className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                          active
                            ? 'bg-accent-tint font-medium text-accent-text'
                            : i === l1Cursor
                              ? 'bg-elevated/60 text-secondary'
                              : 'text-secondary hover:bg-elevated/60'
                        }`}
                        onClick={() => applyLevel1(opt.value)}
                      >
                        <span className="min-w-0 truncate">{opt.label}</span>
                        {opt.custom && (
                          <span className="ml-auto shrink-0 pl-1 text-[9px] text-tertiary group-hover:hidden">
                            自定义
                          </span>
                        )}
                      </button>
                      {opt.custom && (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`删除自定义一级分类 ${opt.value}`}
                          title="删除该自定义分类（已被资产使用时无法删除）"
                          className="absolute right-1 top-1/2 hidden -translate-y-1/2 cursor-pointer px-1 text-[10px] leading-none text-tertiary hover:text-danger group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteCustom('level1', opt.value)
                          }}
                        >
                          ×
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* ＋ 新增自定义一级分类（浮层底部固定一行；Enter 提交并选中，Esc 收回输入行） */}
              {addingFor === 'level1' ? (
                <input
                  autoFocus
                  className="input mt-0.5 h-7 text-[12px]"
                  placeholder="新的一级分类名，Enter 添加"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // 不冒泡进浮层键盘导航：↑↓ 会移动高亮、Enter 会误选高亮项。
                    // Esc 不在这里拦：交给 useEscLayer 统一收起浮层（输入行随浮层一起消失）。
                    e.stopPropagation()
                    if (e.key === 'Enter') void commitAdd('level1')
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="mt-0.5 flex h-7 w-full items-center gap-1 rounded-nav px-2 text-left text-[11px] text-tertiary transition hover:bg-elevated"
                  onClick={() => {
                    setDraft('')
                    setAddingFor('level1')
                  }}
                >
                  ＋ 新增自定义一级分类
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <input
          className="input"
          value={level1 === UNCLASSIFIED ? '' : level1}
          placeholder="可自由输入，留空则归入「未分类」"
          onChange={(e) => {
            setLevel1(e.target.value)
            setLevel2(UNCLASSIFIED)
          }}
        />
      )}

      {/* 二级分类（级联） */}
      <div className="mb-1 mt-3 text-[12px] font-medium">二级分类</div>
      {level1 === UNCLASSIFIED ? (
        <input className="input opacity-50" value="未分类" disabled title="未指派一级分类时，二级强制为「未分类」" />
      ) : !l2HasPanel ? (
        <input
          className="input"
          value={level2 === UNCLASSIFIED ? '' : level2}
          placeholder="该一级分类无级联词表，可自由输入，留空则归入「未分类」"
          onChange={(e) => setLevel2(e.target.value)}
        />
      ) : (
        <div ref={l2Ref} onKeyDown={onLevel2KeyDown}>
          <button
            ref={l2ButtonRef}
            type="button"
            className="input flex items-center justify-between gap-2 text-left"
            aria-haspopup="listbox"
            aria-expanded={openField === 'level2'}
            aria-label={`二级分类：${l2Display}`}
            title="按「一级/二级」成对显示：不同一级分类下会有同名的二级分类，只写二级名容易选错"
            onClick={toggleLevel2Panel}
          >
            <span className="min-w-0 truncate">{l2Display}</span>
            <span aria-hidden className="pointer-events-none shrink-0 text-[9px] text-tertiary">
              ▾
            </span>
          </button>

          {openField === 'level2' && panelPos && (
            <div
              className="fixed z-40 w-[176px] rounded-btn border border-line bg-card p-1 shadow-modal"
              style={{ left: panelPos.left, top: panelPos.top }}
            >
              <div className="px-2 pb-1 pt-1 text-[10px] text-tertiary">二级分类</div>
              <div
                role="listbox"
                aria-label="二级分类"
                className="overflow-y-auto"
                style={{ maxHeight: panelPos.listMaxHeight }}
              >
                {l2Items.map((opt, i) => {
                  const active = opt.value === level2
                  return (
                    <div key={opt.value} className="group relative">
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        title={opt.label}
                        className={`flex h-7 w-full items-center rounded-nav px-2 text-left text-[12px] transition ${
                          active
                            ? 'bg-accent-tint font-medium text-accent-text'
                            : i === l2Cursor
                              ? 'bg-elevated/60 text-secondary'
                              : 'text-secondary hover:bg-elevated/60'
                        }`}
                        onClick={() => applyLevel2(opt.value)}
                      >
                        <span className="min-w-0 truncate">{opt.label}</span>
                        {opt.custom && (
                          <span className="ml-auto shrink-0 pl-1 text-[9px] text-tertiary group-hover:hidden">
                            自定义
                          </span>
                        )}
                      </button>
                      {opt.custom && (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`删除自定义二级分类 ${opt.value}`}
                          title="删除该自定义分类（已被资产使用时无法删除）"
                          className="absolute right-1 top-1/2 hidden -translate-y-1/2 cursor-pointer px-1 text-[10px] leading-none text-tertiary hover:text-danger group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteCustom('level2', opt.value)
                          }}
                        >
                          ×
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* ＋ 新增自定义二级分类（挂在当前一级名下） */}
              {addingFor === 'level2' ? (
                <input
                  autoFocus
                  className="input mt-0.5 h-7 text-[12px]"
                  placeholder={`「${level1}」下新的二级分类名，Enter 添加`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void commitAdd('level2')
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="mt-0.5 flex h-7 w-full items-center gap-1 rounded-nav px-2 text-left text-[11px] text-tertiary transition hover:bg-elevated"
                  onClick={() => {
                    setDraft('')
                    setAddingFor('level2')
                  }}
                >
                  ＋ 新增自定义二级分类
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        确认后会把资产目录移动到「{kindFolder(kind)} / 一级 / 二级 /」下；目标位置已有同名目录时自动追加序号，永不覆盖。
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={close}>
          取消
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void confirm()}
          disabled={busy || crossKind}
          title={crossKind ? '选中项跨大类，不能批量指派' : undefined}
        >
          {busy ? '移动中…' : multi ? `指派 ${targets.length} 个` : '指派'}
        </button>
      </div>
    </Modal>
  )
}
