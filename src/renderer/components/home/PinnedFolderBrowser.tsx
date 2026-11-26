/**
 * 首页钉选目录 · **应用内文件浏览器 v2**（docs/61 §批注结果 施工口径）。
 *
 * v1（列表 + 面包屑 + 双击）方向已确认，本版按设计稿 fm-shots（F1–F9）补齐
 * 资源管理器交互骨架：
 * - **导航**：面包屑链（末级不可点）+「← 上一级」（根时置灰）+「→ 前进」历史栈
 *   （Backspace / Alt+←→）；「回首页」独立入口，与「上一级」彻底分离（A1 批注）；
 *   2026-11-25 用户要求：回首页移到导航行**最左**（排在「上一级」前），右侧不再有入口；
 * - **视图**：列表（默认）/ 图标两档 + 排序（名称 / 修改时间 / 大小 / 类型 × 方向），
 *   **按 pin 记忆并持久化**（`Settings.pinnedViewPrefs`，跨重启保留；写入桥见
 *   `logic/pinnedViewPrefs.ts`，300ms 防抖 + 卸载强制 flush）；
 * - **选择**：单击选中、Ctrl 切换、Shift 范围、Ctrl+A 全选、点空白清除、
 *   空白处拖拽**框选**（accent 虚线 + 8% tint，照 F6b）；
 * - **右键**：条目 / 空白处两套自绘菜单（`PinnedBrowserMenu`，escLayer 接管 Esc）；
 * - **写操作**：新建文件夹（行内输入态）、行内重命名（冲突红框不弹窗）、
 *   删除（确认层 → `trashPinnedEntries` → 屏幕中下方 5 秒撤销条）、压缩 / 解压、
 *   「打开方式」。本地盘文件进系统回收站（撤销只刷新），网络盘文件由主进程在同盘
 *   隐藏回收区保留 token —— 撤销条可以真实还原到原位置。工具行「回收站」入口打开
 *   回收区面板，逐个还原；全程不做永久删除。写通道未就绪时按钮置灰（`pinnedWriteApi`）；
 * - **边界**：>2000 条截断明示行（F8-1）、读取失败错误卡（F8-2）、空目录空态（F8-3）、
 *   站方推广文件（词表：微信扫码 / 知末）打开前确认层。
 *
 * 纪律：零系统默认控件；颜色全走 token；绝对路径不进渲染层状态（下钻只存相对段数组）；
 * Esc 层栈语义 = 关菜单 / 关确认层 / 关回收站面板 → 清多选 → 关浏览器回首页。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { useEscLayer, getEscLayerDepth } from '../../logic/escLayer'
import { zClassForDepth } from '../../logic/zStack'
import { useVault } from '../../store'
import { boxOf, type BoxRect } from '../../logic/fileView'
import { selectRangeIds } from '../../logic/selection'
import type {
  FsEntry,
  FsRevealEntryInput,
  FsRevealEntryResult,
  FsTrashedItem
} from '../../../shared/ipc'
import {
  formatSize,
  formatTime,
  hitNames,
  historyBack,
  historyForward,
  isAdFileName,
  isArchiveName,
  kindLabelOf,
  nameExists,
  PINNED_SORT_KEY_LABEL,
  pinnedBlankMenuItems,
  pinnedEntryMenuItems,
  pinnedWriteApi,
  pushHistory,
  sortPinnedEntries,
  toggleSelected,
  WRITE_NOT_READY_NOTICE,
  type PinnedHistory,
  type PinnedMenuItem
} from '../../logic/pinnedBrowser'
import { flushPinnedViewPrefs, patchPinnedViewPrefs } from '../../logic/pinnedViewPrefs'
import { DEFAULT_PINNED_VIEW_PREFS } from '../../../shared/pinnedViewPrefs'
import { IconFolder, IconList, IconGrid, IconRefresh, IconPlus, IconTrash } from '../../icons'
import { PinnedBrowserMenu } from './PinnedBrowserMenu'
import { PinnedQuickLook } from './PinnedQuickLook'
import { PinnedTrashPanel } from './PinnedTrashPanel'
import { PinnedThumbVisual } from './PinnedThumb'
import './pinned-browser.css'
import './pinned-enter.css'

export interface PinnedFolderBrowserProps {
  /** 钉选 id（`HomePinnedFolder.id`，主进程按它从自己的 settings 解析路径） */
  pinId: string
  /** 钉选显示名（面包屑根节点；来自 settings，App 打开时一并给出） */
  pinName: string
  /** 关浏览器回首页（App 置 `pinnedBrowser = null`；Esc 也走这里） */
  onClose: () => void
}

/** 删除撤销条时长（秒；docs/61 批注：与库内一致 5 秒） */
const UNDO_BAR_SECONDS = 5

/**
 * 退场动画时长（ms）。⚠️ 唯一时间来源：`pinned-enter.css` 的
 * `.pinned-browser-out` 时长必须与它一致（reduce 兜底那条除外），否则
 * JS 按这里计时卸载，动画会被掐断或白等。
 */
const EXIT_ANIM_MS = 150

/** 框选起手阈值（px，与资产网格同口径） */
const MARQUEE_MIN_PX = 4

/** 框选起手豁免：条目本体 / 任何控件上的按下不算空白（条目点击是选择手势） */
const PIN_MARQUEE_IGNORE_SELECTOR = [
  '[data-pin-entry]',
  '[role="button"]',
  'button',
  'a',
  'input',
  'select',
  'textarea'
].join(',')

/** 框选运行期状态（全放 ref：拖动过程零 React 重渲染，同资产网格） */
interface PinMarqueeDrag {
  container: HTMLElement
  anchor: { x: number; y: number }
  startClient: { x: number; y: number }
  lastClient: { x: number; y: number }
  armed: boolean
  additive: boolean
  snapshot: string[]
  rects: Map<string, BoxRect>
  applied: string
  detach: () => void
}

/** 视口坐标 → 滚动容器内容坐标 */
function toContentPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const r = container.getBoundingClientRect()
  return { x: clientX - r.left + container.scrollLeft, y: clientY - r.top + container.scrollTop }
}

/** 采集已渲染条目的矩形快照（内容坐标；条目 id = 条目名，同层唯一） */
function snapshotEntryBoxes(container: HTMLElement): Map<string, BoxRect> {
  const boxes = new Map<string, BoxRect>()
  const base = container.getBoundingClientRect()
  const sl = container.scrollLeft
  const st = container.scrollTop
  container.querySelectorAll<HTMLElement>('[data-pin-entry][data-name]').forEach((el) => {
    const name = el.dataset.name
    if (!name) return
    const r = el.getBoundingClientRect()
    boxes.set(name, {
      left: r.left - base.left + sl,
      top: r.top - base.top + st,
      right: r.right - base.left + sl,
      bottom: r.bottom - base.top + st
    })
  })
  return boxes
}

/** 判断按键目标是否在输入控件里（Backspace / F2 等全局键必须让路） */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
  )
}

export function PinnedFolderBrowser({
  pinId,
  pinName,
  onClose
}: PinnedFolderBrowserProps): ReactElement {
  /* ── 导航：历史栈是唯一状态源，segments = 当前游标快照 ─────────────────── */
  const [history, setHistory] = useState<PinnedHistory>(() => ({ stack: [[]], index: 0 }))
  const segments = useMemo(() => [...(history.stack[history.index] ?? [])], [history])
  const relPath = segments.join('/')

  /* ── 目录内容 ─────────────────────────────────────────────────────────── */
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  /* ── 偏好（按 pin 记忆，持久化到 Settings.pinnedViewPrefs）──────────── */
  const pinnedPrefsMap = useVault((s) => s.settings?.pinnedViewPrefs)
  const prefs = useMemo(
    () => pinnedPrefsMap?.[pinId] ?? DEFAULT_PINNED_VIEW_PREFS,
    [pinnedPrefsMap, pinId]
  )
  const patchPrefs = patchPinnedViewPrefs
  const sortedEntries = useMemo(() => sortPinnedEntries(entries, prefs), [entries, prefs])
  const sortedNames = useMemo(() => sortedEntries.map((e) => e.name), [sortedEntries])

  /* ── 选择 ─────────────────────────────────────────────────────────────── */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  const clearSelection = useCallback((): void => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])

  /* ── 浮层 / 编辑 / 反馈 ───────────────────────────────────────────────── */
  const [menu, setMenu] = useState<
    { kind: 'entry'; x: number; y: number; targets: FsEntry[] } | {
      kind: 'blank'
      x: number
      y: number
    } | null
  >(null)
  const [sortMenuAt, setSortMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<
    { kind: 'delete'; targets: FsEntry[] } | {
      kind: 'ad'
      entry: FsEntry
    } | null
  >(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameConflict, setRenameConflict] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [createConflict, setCreateConflict] = useState<null | 'exists' | 'invalid'>(null)
  /** 删除撤销条：`tokens` = 本批进软件内隐藏回收区、可真实还原的条目 token */
  const [undoBar, setUndoBar] = useState<{
    count: number
    first: string
    startedAt: number
    tokens: string[]
  } | null>(null)
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(UNDO_BAR_SECONDS)
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  /** 工具行「回收站」入口：打开钉选目录回收区面板（面板自己占一层 Esc 栈） */
  const [trashOpen, setTrashOpen] = useState(false)

  /* ── 空格 Quick Look：浮层目标 = 当前层文件名（null = 关闭）──────────── */
  const [quickLookName, setQuickLookName] = useState<string | null>(null)

  const setNotice = useVault((s) => s.setNotice)
  /** 写通道探针（未就绪 → 写操作按钮置灰；主进程落地后自动接通） */
  const writeApi = pinnedWriteApi()

  /* ── 转场（pinned-enter.css）：入场挂载即播；退场先播再卸载 ─────────────── */
  const [exiting, setExiting] = useState(false)
  const exitingRef = useRef(false)
  const closeTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      // 卸载兜底：退场计时器还挂着就清掉（正常路径 onClose 后组件整体卸载，无害）
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    []
  )
  /**
   * 卸载前把待写的视图 / 排序偏好立刻落盘：用户点完「图标视图」就按 Esc 回首页
   * （甚至直接关窗）时，300ms 防抖窗口里的最后一次点击不能丢。
   */
  useEffect(() => () => flushPinnedViewPrefs(), [])
  /**
   * 统一退出函数（转场批）：回首页按钮 / Esc 层栈 / 错误卡「回首页」全部只走这里，
   * 先播 150ms 下移淡出再真正 `onClose()` 卸载——任何路径都不会跳过动画。
   * 幂等：退场进行中再点回首页 / 再按 Esc 直接忽略，不重复计时。
   */
  const requestClose = useCallback((): void => {
    if (exitingRef.current) return
    exitingRef.current = true
    setExiting(true)
    closeTimerRef.current = window.setTimeout(onClose, EXIT_ANIM_MS)
  }, [onClose])

  /** Esc 层栈：本视图占一层。有选中先清选中，其次才关浏览器回首页（A13 批注） */
  const escDepth = useEscLayer(
    useCallback(() => {
      if (selected.size > 0) {
        clearSelection()
        return
      }
      requestClose()
    }, [selected.size, clearSelection, requestClose]),
    true
  )

  /* ── 列目录（下钻 / 回跳 / 刷新共用；cancelled 挡快速连点竞态）────────── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.modvault
      .listPinnedDir({ pinId, relPath })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setEntries(result.entries)
          setTruncated(result.truncated === true)
          setLoading(false)
        } else {
          setEntries([])
          setTruncated(false)
          setError(result.error)
          setLoading(false)
        }
      })
      .catch(() => {
        if (cancelled) return
        setEntries([])
        setTruncated(false)
        setError('读取文件夹失败，请重试')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pinId, relPath, refreshTick])

  /** 换层清选择（不同层之间选择语义不延续，资源管理器同行为） */
  useEffect(() => {
    clearSelection()
  }, [relPath, clearSelection])

  /** 换层 / 刷新时兜底关掉 Quick Look（浮层开着时正常操作不到这里，防竞态） */
  useEffect(() => {
    setQuickLookName(null)
  }, [relPath, refreshTick])

  /** 新建/重命名成功后滚动到新项（block:'nearest' 不打扰当前视野） */
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollTarget === null) return
    const container = listRef.current
    if (!container) return
    const el = [...container.querySelectorAll<HTMLElement>('[data-pin-entry][data-name]')].find(
      (n) => n.dataset.name === scrollTarget
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
    setScrollTarget(null)
  }, [scrollTarget, entries])

  /* ── 导航动作（pushHistory 对同层跳转去重；回跳清前进记录）────────────── */
  const navigate = useCallback((segs: readonly string[]): void => {
    setHistory((h) => pushHistory(h, segs))
  }, [])
  const goUp = useCallback((): void => {
    setHistory((h) => {
      const cur = h.stack[h.index] ?? []
      if (cur.length === 0) return h
      return pushHistory(h, cur.slice(0, -1))
    })
  }, [])
  const goBack = useCallback((): void => {
    setHistory((h) => historyBack(h) ?? h)
  }, [])
  const goForward = useCallback((): void => {
    setHistory((h) => historyForward(h) ?? h)
  }, [])
  const refresh = useCallback((): void => {
    setRefreshTick((t) => t + 1)
  }, [])

  /* ── 打开条目（站方推广文件先弹确认层）───────────────────────────────── */
  const openFileDirect = useCallback(
    (name: string): void => {
      const childRel = [...segments, name].join('/')
      void window.modvault
        .openPinnedEntry({ pinId, relPath: childRel })
        .then((result) => {
          if (!result.ok) setNotice(result.error)
        })
        .catch(() => setNotice('打开文件失败，请重试'))
    },
    [pinId, segments, setNotice]
  )
  const openEntry = useCallback(
    (entry: FsEntry): void => {
      if (entry.isDir) {
        navigate([...segments, entry.name])
        return
      }
      if (isAdFileName(entry.name)) {
        setDialog({ kind: 'ad', entry })
        return
      }
      openFileDirect(entry.name)
    },
    [navigate, segments, openFileDirect]
  )

  /* ── 写操作（全部过 pinnedWriteApi 探针；未就绪置灰 + toast）──────────── */
  const guardWrite = useCallback((): boolean => {
    if (pinnedWriteApi() === null) {
      setNotice(WRITE_NOT_READY_NOTICE)
      return false
    }
    return true
  }, [setNotice])

  const copyEntryPath = useCallback(
    (entry: FsEntry): void => {
      const text = [...segments, entry.name].join('/')
      void navigator.clipboard
        .writeText(text)
        .then(() => setNotice('已复制路径'))
        .catch(() => setNotice('复制失败'))
    },
    [segments, setNotice]
  )

  const startRename = useCallback(
    (name: string): void => {
      if (!guardWrite()) return
      setRenaming(name)
      setRenameDraft(name)
      setRenameConflict(false)
    },
    [guardWrite]
  )

  const startCreate = useCallback((): void => {
    if (!guardWrite()) return
    setCreating(true)
    setCreateDraft('')
    setCreateConflict(null)
  }, [guardWrite])

  /** 新建文件夹确认（Enter；空名取消 / 重名行内红框，不弹窗） */
  const commitCreate = useCallback((): void => {
    const name = createDraft.trim()
    if (name === '') {
      setCreating(false)
      return
    }
    if (nameExists(sortedNames, name)) {
      setCreateConflict('exists')
      return
    }
    const api = pinnedWriteApi()
    if (api === null) return
    void api
      .makePinnedDir({ pinId, dirRel: relPath, name })
      .then((result) => {
        if (result.ok) {
          setCreating(false)
          setCreateConflict(null)
          setNotice(`已新建文件夹「${name}」`)
          setScrollTarget(result.entry.name)
          refresh()
        } else if (result.reason === 'exists') {
          setCreateConflict('exists')
        } else {
          setCreateConflict(result.reason === 'invalid' ? 'invalid' : null)
          setNotice(result.error)
        }
      })
      .catch(() => setNotice('新建文件夹失败，请重试'))
  }, [pinId, createDraft, sortedNames, relPath, refresh, setNotice])

  /** 行内重命名确认（Enter；未改动 / 空名取消；冲突行内红框） */
  const commitRename = useCallback((): void => {
    if (renaming === null) return
    const newName = renameDraft.trim()
    const old = renaming
    setRenaming(null)
    if (newName === '' || newName === old) return
    if (nameExists(sortedNames, newName, old)) {
      setNotice('名称已存在')
      return
    }
    const api = pinnedWriteApi()
    if (api === null) return
    void api
      .renamePinnedEntry({ pinId, dirRel: relPath, oldName: old, newName })
      .then((result) => {
        if (result.ok) {
          setNotice(`已重命名为「${newName}」`)
          setScrollTarget(result.entry.name)
          refresh()
        } else {
          setNotice(result.error)
        }
      })
      .catch(() => setNotice('重命名失败，请重试'))
  }, [pinId, renaming, renameDraft, sortedNames, relPath, refresh, setNotice])

  /** 删除（确认层 → trashPinnedEntries → 撤销条；失败项汇总进 notice） */
  const commitDelete = useCallback(
    (targets: readonly FsEntry[]): void => {
      const api = pinnedWriteApi()
      if (api === null) return
      const names = targets.map((t) => t.name)
      void api
        .trashPinnedEntries({ pinId, dirRel: relPath, names })
        .then((result) => {
          refresh()
          if (result.ok) {
            if (result.failed.length === 0) {
              // `trashed` 逐项标明去向：token = 进软件内隐藏回收区（可撤销还原），
              // token:null = 进系统回收站（本版本只能刷新，不假装修复）。
              // 可选读法兜住「旧包主进程未回传 trashed」的场景，避免 undefined.filter 崩溃。
              const trashed: readonly FsTrashedItem[] =
                (result as Extract<typeof result, { ok: true }> & { trashed?: readonly FsTrashedItem[] })
                  .trashed ?? []
              const tokens = trashed
                .filter((item) => typeof item.token === 'string' && (item.token as string).length > 0)
                .map((item) => item.token as string)
              setUndoBar({
                count: names.length,
                first: names[0] ?? '',
                startedAt: Date.now(),
                tokens
              })
              clearSelection()
            } else {
              const summary = result.failed
                .slice(0, 3)
                .map((f) => `${f.name}：${f.message}`)
                .join('；')
              setNotice(
                result.failed.length === names.length
                  ? `删除失败：${summary}`
                  : `已删除 ${names.length - result.failed.length} 项，${result.failed.length} 项失败：${summary}`
              )
            }
          } else {
            setNotice(result.error)
          }
        })
        .catch(() => setNotice('删除失败，请重试'))
    },
    [pinId, relPath, refresh, setNotice, clearSelection]
  )

  /** 撤销条「撤销」：有 token 则逐个真实还原；否则只刷新（系统回收站不可程序化反悔） */
  const performUndo = useCallback((): void => {
    const bar = undoBar
    setUndoBar(null)
    if (bar === null) return
    if (bar.tokens.length === 0) {
      refresh()
      return
    }
    const api = pinnedWriteApi()
    if (api === null) {
      setNotice(WRITE_NOT_READY_NOTICE)
      refresh()
      return
    }
    // 逐个还原（不并行：主进程同名冲突处理有顺序语义），失败项汇总但不阻断其余
    void (async (): Promise<void> => {
      const failures: string[] = []
      for (const token of bar.tokens) {
        try {
          const res = await api.restorePinnedTrash({ pinId, token })
          if (!res.ok) failures.push(res.error)
        } catch {
          failures.push('还原请求失败')
        }
      }
      refresh()
      if (failures.length > 0) {
        setNotice(`部分项目恢复失败：${failures.slice(0, 3).join('；')}`)
      }
    })()
  }, [undoBar, pinId, refresh, setNotice])

  const compressTargets = useCallback(
    (targets: readonly FsEntry[]): void => {
      const api = pinnedWriteApi()
      if (api === null) return
      void api
        .compressPinnedEntries({ pinId, dirRel: relPath, names: targets.map((t) => t.name) })
        .then((result) => {
          if (result.ok) {
            setNotice(`已压缩为「${result.zipName}」`)
            refresh()
          } else {
            setNotice(result.error)
          }
        })
        .catch(() => setNotice('压缩失败，请重试'))
    },
    [pinId, relPath, refresh, setNotice]
  )

  const extractEntry = useCallback(
    (entry: FsEntry): void => {
      const api = pinnedWriteApi()
      if (api === null) return
      void api
        .extractPinnedArchive({ pinId, dirRel: relPath, name: entry.name })
        .then((result) => {
          if (result.ok) {
            setNotice(`已解压到文件夹「${result.dirName}」`)
            refresh()
          } else {
            setNotice(result.error)
          }
        })
        .catch(() => setNotice('解压失败，请重试'))
    },
    [pinId, relPath, refresh, setNotice]
  )

  const openWith = useCallback(
    (entry: FsEntry): void => {
      const api = pinnedWriteApi()
      if (api === null) return
      void api
        .openPinnedEntryWith({ pinId, dirRel: relPath, name: entry.name })
        .then((result) => {
          if (!result.ok) setNotice(result.error)
        })
        .catch(() => setNotice('打开失败，请重试'))
    },
    [pinId, relPath, setNotice]
  )

  /**
   * 「在资源管理器中显示」。
   *
   * ★ 2026-11-25 修（用户实测：「右键选择"在资源管理器显示"时，弹开的并不是现在我
   *   右键点击的这个文件所在的文件夹」）：原来这里复用 `home:pinnedOpen`，那个通道
   *   只收 pinId、揭示**钉选根**，所以深层子目录里点它永远弹到根目录。
   *   现在走专用通道 `fs:revealEntry`（主进程按 pinId + relPath 解析真实路径、
   *   复用钉选路径守卫夹取越界，再 showItemInFolder 精确选中条目）。
   *
   * 运行期探针：老版本 preload 没这个方法是可能的（dev 态主进程已重启，但预加载
   * 契约可能滞后），缺方法就退回旧的「打开钉选根」，至少不会点了没反应。
   * relPath 用 `/` 拼接（主进程按 `/` 切段解析）；空串 = 钉选根自己。
   */
  const revealEntry = useCallback(
    (entry: FsEntry): void => {
      const api = window.modvault as unknown as {
        revealPinnedEntry?: (input: FsRevealEntryInput) => Promise<FsRevealEntryResult>
        homePinnedOpen?: (id: string) => Promise<string | null>
      }
      const rel = relPath.length > 0 ? `${relPath}/${entry.name}` : entry.name
      if (typeof api.revealPinnedEntry === 'function') {
        void api
          .revealPinnedEntry({ pinId, relPath: rel })
          .then((result) => {
            if (!result.ok) setNotice(result.error)
          })
          .catch(() => setNotice('无法在资源管理器中显示，请重试'))
        return
      }
      // 兜底：旧契约只能揭示钉选根
      void Promise.resolve(api.homePinnedOpen?.(pinId) ?? null)
        .then((err) => {
          if (err) setNotice(err)
        })
        .catch(() => setNotice('打开文件夹失败，请重试'))
    },
    [pinId, relPath, setNotice]
  )

  /* ── 选择动作 ─────────────────────────────────────────────────────────── */
  const clickEntry = useCallback(
    (
      entry: FsEntry,
      event: ReactMouseEvent<HTMLDivElement>
    ): void => {
      if (event.ctrlKey || event.metaKey) {
        anchorRef.current = entry.name
        setSelected((cur) => toggleSelected(cur, entry.name))
        return
      }
      if (event.shiftKey) {
        const range = selectRangeIds(anchorRef.current, entry.name, sortedNames)
        if (range.length > 0) setSelected(new Set(range))
        return
      }
      anchorRef.current = entry.name
      setSelected(new Set([entry.name]))
    },
    [sortedNames]
  )

  /** 全选（Ctrl+A；只选当前层可见条目） */
  const selectAll = useCallback((): void => {
    setSelected(new Set(sortedNames))
  }, [sortedNames])

  /** 空格开 Quick Look：仅文件可快览（目录跳过；调不到时静默不动） */
  const openQuickLookFor = useCallback(
    (name: string): void => {
      const entry = sortedEntries.find((en) => !en.isDir && en.name === name)
      if (entry !== undefined) setQuickLookName(entry.name)
    },
    [sortedEntries]
  )

  /* ── 全局键盘（空格 Quick Look / Backspace / Alt+←→ / Ctrl+A / F2）────── */
  const keyStateRef = useRef({
    goUp,
    goBack,
    goForward,
    selectAll,
    selected,
    startRename,
    openQuickLookFor,
    /** 层栈深度：菜单 / 确认层在栈上时全局键一律让路（一次按键只归一层） */
    escDepth,
    /** Quick Look 浮层开着时，空格归浮层（它的监听负责关闭） */
    quickLookName
  })
  keyStateRef.current = {
    goUp,
    goBack,
    goForward,
    selectAll,
    selected,
    startRename,
    openQuickLookFor,
    escDepth,
    quickLookName
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const st = keyStateRef.current
      if (st.escDepth > 1) return // 右键菜单 / 确认层在场 → 按键归那层
      if (e.key === ' ' || e.key === 'Spacebar') {
        // Quick Look 开着 → 空格归浮层（浮层监听负责关闭，那里已 preventDefault）
        if (st.quickLookName !== null) return
        // 菜单 / 确认层在场 → 本层不是栈顶，让路（escDepth 是本层排名，等于总深度才是顶）
        if (st.escDepth !== getEscLayerDepth()) return
        if (e.ctrlKey || e.metaKey || e.altKey) return // 修饰键组合不归空格键
        e.preventDefault() // 空格不触发页面滚动
        if (st.selected.size !== 1) return // 仅单选文件触发（多选 / 目录不响应）
        const name = [...st.selected][0]
        if (name !== undefined) st.openQuickLookFor(name)
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        st.goUp()
        return
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        st.goBack()
        return
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        st.goForward()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        st.selectAll()
        return
      }
      if (e.key === 'F2' && st.selected.size === 1) {
        const name = [...st.selected][0]
        if (name !== undefined) st.startRename(name)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ── 撤销条倒计时（归零自动收尾；有 token 的条目点击后真实还原到原位置）── */
  useEffect(() => {
    if (undoBar === null) return
    const tick = (): void => {
      const left = Math.max(0, UNDO_BAR_SECONDS - Math.floor((Date.now() - undoBar.startedAt) / 1000))
      setUndoSecondsLeft(left)
      if (left <= 0) setUndoBar(null)
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [undoBar])

  const selectedRef = useRef<Set<string>>(selected)
  selectedRef.current = selected
  /** 框选的渲染顺序快照（命中结果按视觉顺序返回） */
  const sortedNamesRef = useRef<string[]>(sortedNames)
  sortedNamesRef.current = sortedNames

  /* ── 框选（状态机与资产网格同构；选择写本组件本地 state）────────────── */
  const marqueeBoxRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<PinMarqueeDrag | null>(null)
  /** 刚结束框选的时间戳：mouseup 后跟发的 click 不得当成"点空白"清掉选择 */
  const marqueeEndedAtRef = useRef(0)

  const endMarquee = useCallback((cancel: boolean): void => {
    const drag = marqueeRef.current
    if (!drag) return
    marqueeRef.current = null
    drag.detach()
    delete drag.container.dataset.marquee
    const box = marqueeBoxRef.current
    if (box) box.style.display = 'none'
    marqueeEndedAtRef.current = Date.now()
    if (!cancel || !drag.armed) return
    // Esc 取消：恢复起手快照
    setSelected(new Set(drag.snapshot))
  }, [])

  const paintMarquee = useCallback((drag: PinMarqueeDrag): void => {
    if (!drag.armed) {
      const moved = Math.hypot(
        drag.lastClient.x - drag.startClient.x,
        drag.lastClient.y - drag.startClient.y
      )
      if (moved < MARQUEE_MIN_PX) return
      drag.armed = true
      drag.container.dataset.marquee = '1' // 条目交出指针事件：禁 hover、禁误触
    }
    const cur = toContentPoint(drag.container, drag.lastClient.x, drag.lastClient.y)
    const box = boxOf(drag.anchor.x, drag.anchor.y, cur.x, cur.y)
    const el = marqueeBoxRef.current
    if (el) {
      el.style.display = 'block'
      el.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`
      el.style.width = `${box.right - box.left}px`
      el.style.height = `${box.bottom - box.top}px`
    }
    const order = sortedNamesRef.current
    const hits = hitNames(drag.rects, order, box)
    const next = drag.additive
      ? [...new Set([...drag.snapshot, ...hits])]
      : hits
    const key = next.join('\u0000')
    if (key === drag.applied) return
    drag.applied = key
    setSelected(new Set(next))
  }, [])

  const startMarquee = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      if (marqueeRef.current) return
      const container = e.currentTarget
      const target = e.target as Element | null
      if (target?.closest(PIN_MARQUEE_IGNORE_SELECTOR)) return
      const base = container.getBoundingClientRect()
      if (
        e.clientX - base.left >= container.clientWidth ||
        e.clientY - base.top >= container.clientHeight
      ) {
        return
      }
      const drag: PinMarqueeDrag = {
        container,
        anchor: toContentPoint(container, e.clientX, e.clientY),
        startClient: { x: e.clientX, y: e.clientY },
        lastClient: { x: e.clientX, y: e.clientY },
        armed: false,
        additive: e.ctrlKey || e.metaKey,
        // 与资源管理器一致：非追加框选 = 起手先清（plain click 空白也是清选择的实现路径）
        snapshot: [...selectedRef.current],
        rects: snapshotEntryBoxes(container),
        applied: '\u0000init',
        detach: () => undefined
      }
      // 与资源管理器一致：非追加框选 = 起手先清（点空白清除选择的实现路径；
      // 未越过阈值的 plain click 也走这里 → 空白点击即清空）
      if (!drag.additive) setSelected(new Set())
      const onMove = (ev: globalThis.MouseEvent): void => {
        const cur = marqueeRef.current
        if (!cur) return
        if (ev.buttons === 0) {
          endMarquee(false)
          return
        }
        cur.lastClient = { x: ev.clientX, y: ev.clientY }
        paintMarquee(cur)
      }
      const onUp = (): void => endMarquee(false)
      const onBlur = (): void => endMarquee(false)
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        endMarquee(true)
      }
      const onScroll = (): void => {
        const cur = marqueeRef.current
        if (!cur) return
        snapshotEntryBoxes(container).forEach((box, name) => cur.rects.set(name, box))
        paintMarquee(cur)
      }
      window.addEventListener('mousemove', onMove, true)
      window.addEventListener('mouseup', onUp, true)
      window.addEventListener('blur', onBlur)
      window.addEventListener('keydown', onKey, true)
      container.addEventListener('scroll', onScroll, { passive: true })
      drag.detach = (): void => {
        window.removeEventListener('mousemove', onMove, true)
        window.removeEventListener('mouseup', onUp, true)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('keydown', onKey, true)
        container.removeEventListener('scroll', onScroll)
      }
      marqueeRef.current = drag
    },
    [endMarquee, paintMarquee]
  )

  useEffect(
    () => () => {
      const drag = marqueeRef.current
      if (!drag) return
      marqueeRef.current = null
      drag.detach()
      delete drag.container.dataset.marquee
    },
    []
  )

  /** 滚动容器点击（非追加框选的"点空白清选择"已在 startMarquee 起手清掉，
      这里兜住没有起手清的场景：追加框选后松手在空白处 → 保持选择） */
  const onContainerClick = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    if (Date.now() - marqueeEndedAtRef.current < 250) return
    const target = e.target as Element | null
    if (target?.closest('[data-pin-entry],button,input,a')) return
    clearSelection()
  }, [clearSelection])

  /* ── 右键菜单 ─────────────────────────────────────────────────────────── */
  const openEntryMenu = useCallback(
    (entry: FsEntry, e: ReactMouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const targets = selectedRef.current.has(entry.name)
        ? sortedEntries.filter((en) => selectedRef.current.has(en.name))
        : [entry]
      if (!selectedRef.current.has(entry.name)) {
        anchorRef.current = entry.name
        setSelected(new Set([entry.name]))
      }
      setSortMenuAt(null)
      setMenu({ kind: 'entry', x: e.clientX, y: e.clientY, targets })
    },
    [sortedEntries]
  )
  const openBlankMenu = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault()
    setSortMenuAt(null)
    setMenu({ kind: 'blank', x: e.clientX, y: e.clientY })
  }, [])

  /** 条目菜单项（按 targets 单/多选展开；写项受 writeApi 就绪度控制） */
  const menuItems: PinnedMenuItem[] = useMemo(() => {
    if (menu === null) return []
    if (menu.kind === 'blank') {
      return pinnedBlankMenuItems(prefs, writeApi !== null, {
        onNewFolder: startCreate,
        onRefresh: refresh,
        onSortKey: (key) => patchPrefs(pinId, { sortKey: key }),
        onSortDir: (dir) => patchPrefs(pinId, { sortDir: dir })
      })
    }
    const targets = menu.targets
    const single = targets.length === 1 ? targets[0] : null
    return pinnedEntryMenuItems(targets, writeApi !== null, {
      onOpen: () => {
        if (single !== null) openEntry(single)
      },
      onOpenWith: () => {
        if (single !== null) openWith(single)
      },
      onReveal: () => {
        if (single !== null) revealEntry(single)
      },
      onRename: () => {
        if (single !== null) startRename(single.name)
      },
      onCopyPath: () => {
        if (single !== null) copyEntryPath(single)
      },
      onCompress: () => compressTargets(targets),
      onExtract: () => {
        if (single !== null) extractEntry(single)
      },
      onDelete: () => setDialog({ kind: 'delete', targets })
    })
  }, [menu, prefs, writeApi, startCreate, refresh, patchPrefs, pinId, openEntry, openWith, revealEntry, startRename, copyEntryPath, compressTargets, extractEntry])

  /** 工具行排序浮层的菜单项（键 × 方向，对勾标当前值；与排序子菜单同源） */
  const sortMenuItems: PinnedMenuItem[] = useMemo(() => {
    const items: PinnedMenuItem[] = (['name', 'mtime', 'size', 'kind'] as const).map((key) => ({
      label: PINNED_SORT_KEY_LABEL[key],
      checked: prefs.sortKey === key,
      onClick: () => patchPrefs(pinId, { sortKey: key })
    }))
    items.push(
      'separator',
      {
        label: '升序',
        checked: prefs.sortDir === 'asc',
        onClick: () => patchPrefs(pinId, { sortDir: 'asc' })
      },
      {
        label: '降序',
        checked: prefs.sortDir === 'desc',
        onClick: () => patchPrefs(pinId, { sortDir: 'desc' })
      }
    )
    return items
  }, [prefs, patchPrefs, pinId])

  /* ── 工具行排序按钮的锚点 ─────────────────────────────────────────────── */
  const sortBtnRef = useRef<HTMLButtonElement>(null)
  const openSortMenu = useCallback((): void => {
    const rect = sortBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenu(null)
    setSortMenuAt({ x: rect.left, y: rect.bottom + 4 })
  }, [])

  /* ── 列头点击排序（点同键切方向，点新键回升序）────────────────────────── */
  const sortByColumn = useCallback(
    (key: import('../../logic/pinnedBrowser').PinnedSortKey): void => {
      if (prefs.sortKey === key) {
        patchPrefs(pinId, { sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })
      } else {
        patchPrefs(pinId, { sortKey: key, sortDir: 'asc' })
      }
    },
    [prefs.sortKey, prefs.sortDir, patchPrefs, pinId]
  )

  /* ── 渲染 ─────────────────────────────────────────────────────────────── */
  const crumbs = useMemo(
    () => [{ label: pinName, index: -1 }, ...segments.map((label, index) => ({ label, index }))],
    [pinName, segments]
  )
  const canGoUp = segments.length > 0
  const canForward = historyForward(history) !== null

  /** 单选压缩包 → 顶部出现「解压」按钮（用户口径：选中压缩文件后顶部出现解压） */
  const selectedEntries = useMemo(
    () => sortedEntries.filter((e) => selected.has(e.name)),
    [sortedEntries, selected]
  )
  const canExtractSelection = selectedEntries.length === 1 && selectedEntries[0] !== undefined && isArchiveName(selectedEntries[0])

  const footerHint = creating
    ? 'Enter 确认创建 · Esc 取消 · 重名时行内提示「名称已存在」'
    : renaming !== null
      ? 'Enter 确认重命名 · Esc 取消'
      : '双击文件夹进入 · 双击文件用系统默认程序打开 · Esc 返回首页 · Backspace 上一级'

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col ${
        exiting ? 'pinned-browser-exit' : 'pinned-browser-enter'
      }`}
      data-esc-depth={escDepth}
    >
      {/* ── 头部浮岛卡（可读性批 → 浮岛化返工）：导航行 + 工具行装进一块圆角半透明
          卡片（.pinned-browser-head：--bg-canvas 80% + 白 10% 描边 + --radius-modal），
          与下方列表卡（mx-5 rounded-modal border bg-surface）构成「上卡 / 下卡」层次：
          同左右边距（mx-5）、同圆角（14px token），中间 mt 由列表卡自己的 mt-2.5 留出。 */}
      <div className="pinned-browser-head mx-5 mt-4 shrink-0">
        {/* ── 导航行：回首页 · ← 上一级 · → 前进 · 面包屑 ───────────────────
            2026-11-25 用户需求：回首页放在「上一级」**前面**（原文「把文件夹的
            "回到首页"按钮放到"上一级"的前面去」）。右侧不再保留第二颗入口；
            点击仍走 requestClose（150ms 退场动画的唯一退出路径）。 */}
        <div className="flex items-center gap-2 px-4 pt-3">
        <button type="button" className="btn shrink-0 !py-1" onClick={requestClose} title="返回首页（Esc）">
          <IconHome />
          回首页
        </button>
        <button
          type="button"
          className={`btn btn-ghost shrink-0 !px-2 !py-1 ${canGoUp ? '' : 'cursor-not-allowed opacity-40'}`}
          onClick={goUp}
          disabled={!canGoUp}
          title="返回上一级（Backspace）"
        >
          <IconChevronLeft />
          上一级
        </button>
        <button
          type="button"
          className={`btn btn-ghost shrink-0 !px-1.5 !py-1 ${canForward ? '' : 'cursor-not-allowed opacity-40'}`}
          onClick={goForward}
          disabled={!canForward}
          title="前进（Alt+→）"
        >
          <IconChevronRight />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {crumbs.map((crumb, crumbIndex) => {
            const isLast = crumbIndex === crumbs.length - 1
            return (
              <span
                key={crumb.index < 0 ? 'root' : `${crumb.index}-${crumb.label}`}
                className="flex shrink-0 items-center gap-1.5"
              >
                {crumbIndex > 0 ? (
                  <span aria-hidden className="text-[12px] text-tertiary">›</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (isLast) return // 面包屑末级不可点（F1）
                    navigate(crumb.index < 0 ? [] : segments.slice(0, crumb.index + 1))
                  }}
                  className={
                    isLast
                      ? 'min-w-0 max-w-[280px] truncate text-[15px] font-semibold text-primary'
                      : 'min-w-0 max-w-[200px] truncate text-[13px] text-muted transition-colors hover:text-primary'
                  }
                  title={crumb.label}
                >
                  {crumb.label}
                </button>
              </span>
            )
          })}
        </div>
        </div>

        {/* ── 工具行：视图切换 · 排序 · 刷新 · 新建文件夹 ‖ 解压 · 计数 ──────── */}
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-2">
        <div className="flex shrink-0 items-center gap-0.5 rounded-btn bg-pill p-0.5" role="group" aria-label="视图切换">
          <button
            type="button"
            onClick={() => patchPrefs(pinId, { view: 'list' })}
            className={`flex h-6 w-8 items-center justify-center rounded-md transition ${
              prefs.view === 'list'
                ? 'bg-surface text-primary shadow-sm'
                : 'text-muted hover:text-primary'
            }`}
            title="列表视图"
            aria-pressed={prefs.view === 'list'}
          >
            <IconList width={14} height={14} />
          </button>
          <button
            type="button"
            onClick={() => patchPrefs(pinId, { view: 'grid' })}
            className={`flex h-6 w-8 items-center justify-center rounded-md transition ${
              prefs.view === 'grid'
                ? 'bg-surface text-primary shadow-sm'
                : 'text-muted hover:text-primary'
            }`}
            title="图标视图"
            aria-pressed={prefs.view === 'grid'}
          >
            <IconGrid width={14} height={14} />
          </button>
        </div>
        <button
          ref={sortBtnRef}
          type="button"
          className="btn !py-1"
          onClick={openSortMenu}
          title="排序"
        >
          <IconSortArrows />
          {PINNED_SORT_KEY_LABEL[prefs.sortKey]}
          <span aria-hidden className="text-tertiary">{prefs.sortDir === 'asc' ? '↑' : '↓'}</span>
        </button>
        <button
          type="button"
          className={`btn btn-ghost !px-2 !py-1 ${writeApi === null ? 'cursor-not-allowed opacity-40' : ''}`}
          onClick={() => {
            if (writeApi === null) {
              setNotice(WRITE_NOT_READY_NOTICE)
              return
            }
            setTrashOpen(true)
          }}
          title={writeApi === null ? '功能就绪中' : '回收站'}
        >
          <IconTrash width={14} height={14} />
        </button>
        <button type="button" className="btn btn-ghost !px-2 !py-1" onClick={refresh} title="刷新">
          <IconRefresh width={14} height={14} />
        </button>
        <button
          type="button"
          className={`btn !py-1 ${writeApi === null ? 'cursor-not-allowed opacity-40' : ''}`}
          onClick={startCreate}
          disabled={writeApi === null}
          title={writeApi === null ? '功能就绪中' : '新建文件夹'}
        >
          <IconPlus width={14} height={14} />
          新建文件夹
        </button>
        <div className="min-w-0 flex-1" />
        {canExtractSelection && selectedEntries[0] !== undefined ? (
          <button
            type="button"
            className="btn !py-1 text-accent"
            onClick={() => extractEntry(selectedEntries[0])}
            disabled={writeApi === null}
            title={writeApi === null ? '功能就绪中' : `解压「${selectedEntries[0].name}」`}
          >
            <IconExtract width={14} height={14} />
            解压
          </button>
        ) : null}
        {!loading && error === null ? (
          <span className="header-count shrink-0">
            {selected.size > 0 ? (
              <>
                <span className="text-accent">已选 {selected.size} 项</span>
                {` / ${entries.length} 项`}
              </>
            ) : (
              `${entries.length} 项`
            )}
          </span>
        ) : null}
        </div>
      </div>

      {/* ── 内容区 ─────────────────────────────────────────────────────────── */}
      {error !== null ? (
        /* 错误态（F8-2）：目录被删 / 无权限 → 居中错误卡 + 返回上一级 / 回首页 */
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
          <IconFolder className="text-tertiary" width={40} height={40} />
          <p className="text-sm font-medium text-primary">无法打开该目录</p>
          <p className="text-[12px] leading-5 text-muted">
            {error}
            <br />
            目录可能已被移动、重命名或无访问权限
            <br />
            可用「← 上一级」退回到上一个有效层级
          </p>
          <button type="button" className="btn mt-1.5" onClick={goUp} disabled={!canGoUp}>
            返回上一级
          </button>
          <button
            type="button"
            className="text-[12px] text-accent transition-colors hover:underline"
            onClick={requestClose}
          >
            回首页
          </button>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">正在读取…</div>
      ) : (
        <div
          ref={listRef}
          className="relative mx-5 mb-3 mt-2.5 flex-1 overflow-auto rounded-modal border border-line bg-surface"
          onMouseDown={startMarquee}
          onClick={onContainerClick}
          onContextMenu={openBlankMenu}
        >
          {entries.length === 0 && !creating ? (
            /* 空目录（F8-3） */
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
              <IconFolder className="text-tertiary" width={44} height={44} />
              <p className="text-sm font-medium text-primary">此文件夹为空</p>
              <p className="text-[12px]">右键空白处可新建文件夹，或用「← 上一级」返回上层目录</p>
              <button
                type="button"
                className="btn mt-1"
                onClick={startCreate}
                disabled={writeApi === null}
                title={writeApi === null ? '功能就绪中' : '新建文件夹'}
              >
                <IconPlus width={14} height={14} />
                新建文件夹
              </button>
            </div>
          ) : prefs.view === 'list' ? (
            <div className="flex min-h-full flex-col">
              {/* 列头（F1）：四列可点排序；当前键 accent + 方向箭头 */}
              <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b border-line bg-surface px-3 py-2 text-xs">
                <span className="w-7 shrink-0" />
                <ColumnSortButton label="名称" active={prefs.sortKey === 'name'} dir={prefs.sortDir} onClick={() => sortByColumn('name')} className="min-w-0 flex-1 justify-start" />
                <ColumnSortButton label="类型" active={prefs.sortKey === 'kind'} dir={prefs.sortDir} onClick={() => sortByColumn('kind')} className="w-20 shrink-0 justify-start" />
                <ColumnSortButton label="大小" active={prefs.sortKey === 'size'} dir={prefs.sortDir} onClick={() => sortByColumn('size')} className="w-24 shrink-0 justify-end" />
                <ColumnSortButton label="修改时间" active={prefs.sortKey === 'mtime'} dir={prefs.sortDir} onClick={() => sortByColumn('mtime')} className="w-36 shrink-0 justify-end" />
              </div>
              {sortedEntries.map((entry) => {
                const isSelected = selected.has(entry.name)
                return (
                  <div
                    key={`${entry.isDir ? 'd' : 'f'}-${entry.name}`}
                    data-pin-entry="1"
                    data-name={entry.name}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => clickEntry(entry, e)}
                    onDoubleClick={() => openEntry(entry)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        openEntry(entry)
                      }
                    }}
                    onContextMenu={(e) => openEntryMenu(entry, e)}
                    title={
                      entry.isDir
                        ? `${entry.name}\n双击进入文件夹`
                        : `${entry.name}\n双击用系统默认程序打开`
                    }
                    className={`flex cursor-pointer items-center gap-2.5 border-b border-line/60 px-3 py-2 transition last:border-0 ${
                      isSelected ? 'bg-accent-tint' : 'hover:bg-elevated/40'
                    }`}
                  >
                    {/* 首列：目录 = 文件夹图标；文件 = 缩略图（28px 方块，行高内）。
                        请求中显示类型图标占位（不闪空白）；失败/不支持 → 类型兜底 */}
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center ${
                        entry.isDir ? 'text-accent' : 'text-tertiary'
                      }`}
                    >
                      {entry.isDir ? (
                        <IconFolder width={16} height={16} />
                      ) : (
                        <PinnedThumbVisual pinId={pinId} dirRel={relPath} entry={entry} iconSize={16} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      {renaming === entry.name ? (
                        <RenameInput
                          value={renameDraft}
                          conflict={renameConflict}
                          onChange={(v) => {
                            setRenameDraft(v)
                            setRenameConflict(false)
                          }}
                          onCancel={() => setRenaming(null)}
                          onCommit={commitRename}
                        />
                      ) : (
                        <span className="block truncate text-[13px] text-primary">{entry.name}</span>
                      )}
                    </span>
                    <span className="w-20 shrink-0 text-[12px] text-muted">{kindLabelOf(entry)}</span>
                    <span className="w-24 shrink-0 text-right text-[12px] text-muted">
                      {entry.isDir ? '—' : formatSize(entry.size)}
                    </span>
                    <span className="w-36 shrink-0 text-right text-[12px] text-muted">
                      {formatTime(entry.mtimeMs)}
                    </span>
                  </div>
                )
              })}
              {/* 新建文件夹行内输入态（F7-2，列表尾） */}
              {creating ? (
                <div className="flex items-center gap-2.5 border-b border-line/60 px-3 py-2 last:border-0">
                  <span className="w-4 shrink-0 text-accent">
                    <IconFolder width={14} height={14} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      autoFocus
                      data-esc-own="1"
                      className="pinned-name-input"
                      data-conflict={createConflict === null ? undefined : '1'}
                      value={createDraft}
                      placeholder="新建文件夹"
                      onChange={(e) => {
                        setCreateDraft(e.target.value)
                        setCreateConflict(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitCreate()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setCreating(false)
                        }
                      }}
                      onBlur={() => {
                        if (createConflict === null) setCreating(false)
                      }}
                    />
                    {createConflict !== null ? (
                      <span className="shrink-0 text-[12px] text-danger">
                        {createConflict === 'exists' ? '名称已存在' : '名称含有不允许的字符'}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {/* 截断明示行（F8-1） */}
              {truncated ? (
                <div className="flex items-center justify-center gap-1.5 bg-elevated/40 px-3 py-2.5 text-[12px] text-muted">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-tertiary" />
                  已显示前 2000 项，请进入子文件夹查看更多
                </div>
              ) : null}
            </div>
          ) : (
            /* 图标视图（F2）：类型图标磁贴网格 */
            <div className="grid min-h-full grid-cols-[repeat(auto-fill,minmax(112px,1fr))] content-start gap-x-4 gap-y-3 p-4">
              {sortedEntries.map((entry) => {
                const isSelected = selected.has(entry.name)
                return (
                  <div
                    key={`${entry.isDir ? 'd' : 'f'}-${entry.name}`}
                    data-pin-entry="1"
                    data-name={entry.name}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => clickEntry(entry, e)}
                    onDoubleClick={() => openEntry(entry)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        openEntry(entry)
                      }
                    }}
                    onContextMenu={(e) => openEntryMenu(entry, e)}
                    title={entry.name}
                    className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg px-2 py-3 transition ${
                      isSelected ? 'bg-accent-tint' : 'hover:bg-elevated/40'
                    }`}
                  >
                    <span
                      className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg ${
                        entry.isDir ? 'bg-accent-tint text-accent' : 'border border-line bg-surface text-secondary'
                      }`}
                    >
                      {/* 文件 = 缩略图撑满磁贴（object-contain，圆角由容器裁切）；
                          请求中/失败/不支持 → 类型图标或品牌大字卡兜底 */}
                      {entry.isDir ? (
                        <IconFolder width={24} height={24} />
                      ) : (
                        <PinnedThumbVisual pinId={pinId} dirRel={relPath} entry={entry} iconSize={24} />
                      )}
                    </span>
                    {/* 名字区：**固定预留两行高度**（`min-h-[30px]` = 2 × 15px 行高），
                        一行名字时下方留白 → 整排卡片底边对齐；最多两行，超出才省略
                        （2026-11-25 用户需求②：允许文件及图标显示为两排文字）。
                        字号 / 行高与主库卡片标题同一套（12px / leading-[15px]）。 */}
                    {renaming === entry.name ? (
                      <span className="flex min-h-[30px] w-full items-center">
                        <RenameInput
                          value={renameDraft}
                          conflict={renameConflict}
                          onChange={(v) => {
                            setRenameDraft(v)
                            setRenameConflict(false)
                          }}
                          onCancel={() => setRenaming(null)}
                          onCommit={commitRename}
                        />
                      </span>
                    ) : (
                      <div
                        className="line-clamp-2 min-h-[30px] w-full text-center text-[12px] leading-[15px] text-primary"
                        title={entry.name}
                      >
                        {entry.name}
                      </div>
                    )}
                  </div>
                )
              })}
              {creating ? (
                <div className="flex flex-col items-center gap-2 rounded-lg px-2 py-3">
                  <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-accent-tint text-accent">
                    <IconFolder width={24} height={24} />
                  </span>
                  {/* 与正常卡片同高：名字区同样预留两行（输入框 26px 在这 30px 里居中） */}
                  <span className="flex min-h-[30px] w-full items-center">
                    <input
                      autoFocus
                      data-esc-own="1"
                      className="pinned-name-input"
                      data-conflict={createConflict === null ? undefined : '1'}
                      value={createDraft}
                      placeholder="新建文件夹"
                      onChange={(e) => {
                        setCreateDraft(e.target.value)
                        setCreateConflict(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitCreate()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setCreating(false)
                        }
                      }}
                      onBlur={() => {
                        if (createConflict === null) setCreating(false)
                      }}
                    />
                  </span>
                  {createConflict !== null ? (
                    <span className="text-[12px] text-danger">
                      {createConflict === 'exists' ? '名称已存在' : '名称含有不允许的字符'}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {truncated ? (
                <div className="col-span-full flex items-center justify-center gap-1.5 rounded-lg bg-elevated/40 px-3 py-2.5 text-[12px] text-muted">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-tertiary" />
                  已显示前 2000 项，请进入子文件夹查看更多
                </div>
              ) : null}
            </div>
          )}
          {/* 框选矩形（F6b：accent 1px 虚线 + 8% tint；几何由 marquee 状态机直改样式） */}
          <div ref={marqueeBoxRef} className="pinned-marquee-box" aria-hidden="true" />
        </div>
      )}

      {/* 操作提示行（编辑态换成对应提示）：低调胶囊小浮岛（.pinned-browser-foot），
          左缘对齐上下两块卡（ml-5），文字从 muted 提到 secondary——深色主题下
          #636368 压半透明底会被浅壁纸吃掉，#98989e 实测 ≈4:1。 */}
      <div className="pinned-browser-foot mb-2.5 ml-5 mr-auto mt-0 w-fit max-w-full shrink-0 truncate px-3 py-1 text-[11px] text-secondary">
        {footerHint}
      </div>

      {/* ── 右键菜单 / 排序浮层 ───────────────────────────────────────────── */}
      {menu !== null ? (
        <PinnedBrowserMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {sortMenuAt !== null ? (
        <PinnedBrowserMenu
          x={sortMenuAt.x}
          y={sortMenuAt.y}
          items={sortMenuItems}
          onClose={() => setSortMenuAt(null)}
        />
      ) : null}

      {/* ── 多选浮条（F6）：计数 + 压缩 / 删除 / 清除选择 ─────────────────── */}
      {selected.size > 0 && error === null && !loading ? (
        <div className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-2 rounded-modal border border-line bg-surface px-3 py-2 shadow-modal">
            <span className="px-1 text-[13px] text-primary">已选 {selected.size} 项</span>
            <span aria-hidden className="h-4 w-px bg-line" />
            <button
              type="button"
              className="btn !py-1"
              onClick={() => compressTargets(selectedEntries)}
              disabled={writeApi === null}
              title={writeApi === null ? '功能就绪中' : '压缩所选'}
            >
              <IconStack width={14} height={14} />
              压缩
            </button>
            <button
              type="button"
              className={`btn !py-1 text-danger ${writeApi === null ? 'cursor-not-allowed opacity-40' : ''}`}
              onClick={() => setDialog({ kind: 'delete', targets: selectedEntries })}
              disabled={writeApi === null}
              title={writeApi === null ? '功能就绪中' : '移入回收站'}
            >
              删除
            </button>
            <button type="button" className="btn btn-ghost !py-1" onClick={clearSelection}>
              清除选择
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 删除撤销条：屏幕中下方水平居中，5 秒自动收尾 ──────────────────── */}
      {undoBar !== null ? (
        <div className="pointer-events-none fixed bottom-16 left-1/2 z-40 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-modal border border-line bg-surface px-4 py-2.5 shadow-modal">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
            <span className="text-[13px] text-secondary">
              已把 {undoBar.count === 1 ? `「${undoBar.first}」` : `${undoBar.count} 项`}移入回收站
              {undoBar.tokens.length > 0 ? '，可在原位置还原' : ''}
            </span>
            {/* 有 token（软件内隐藏回收区）→ 逐个真实还原；全为系统回收站项 → 只刷新列表。 */}
            <button
              type="button"
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white transition active:scale-[.98]"
              onClick={performUndo}
              title={undoBar.tokens.length > 0 ? '还原到原位置' : '刷新列表'}
            >
              撤销 {undoSecondsLeft}s
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 确认层：删除（F7-3）/ 站方推广文件（共用一个状态位，一次一层）─── */}
      {dialog !== null ? <ConfirmDialogLayer dialog={dialog} onClose={() => setDialog(null)} onDelete={commitDelete} onAdOpen={(entry) => openFileDirect(entry.name)} /> : null}

      {/* ── 回收站面板：列出本钉选目录隐藏回收区条目，逐个还原（无永久删除）── */}
      {trashOpen ? (
        <PinnedTrashPanel pinId={pinId} onClose={() => setTrashOpen(false)} onRestored={refresh} />
      ) : null}

      {/* ── 空格 Quick Look：大图快览浮层（Esc 关且保留选中；←/→ 序列内移动）── */}
      {quickLookName !== null ? (
        <PinnedQuickLook
          pinId={pinId}
          dirRel={relPath}
          entries={sortedEntries}
          currentName={quickLookName}
          onNavigate={(name) => {
            setQuickLookName(name)
            setSelected(new Set([name]))
            anchorRef.current = name
          }}
          onClose={() => setQuickLookName(null)}
        />
      ) : null}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 内部小组件（不导出）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 列头排序按钮（当前键 accent + 方向箭头；其余 muted） */
function ColumnSortButton({
  label,
  active,
  dir,
  onClick,
  className
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
  className: string
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1 text-xs transition ${
        active ? 'text-accent' : 'text-muted hover:text-primary'
      } ${className}`}
    >
      {label}
      <span aria-hidden className="text-[10px] leading-none">
        {active ? (dir === 'asc' ? '↑' : '↓') : '⇅'}
      </span>
    </button>
  )
}

/** 行内重命名输入框（F7-1）：全选文字、Enter 确认、Esc 取消（data-esc-own 让路层栈） */
function RenameInput({
  value,
  conflict,
  onChange,
  onCancel,
  onCommit
}: {
  value: string
  conflict: boolean
  onChange: (v: string) => void
  onCancel: () => void
  onCommit: () => void
}): ReactElement {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <input
        autoFocus
        data-esc-own="1"
        className="pinned-name-input"
        data-conflict={conflict ? '1' : undefined}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        onBlur={() => onCommit()}
      />
      {conflict ? <span className="shrink-0 text-[12px] text-danger">名称已存在</span> : null}
    </span>
  )
}

/** 确认层（删除 F7-3 / 站方推广文件共用外壳；escLayer 接管 Esc，遮罩点击关闭） */
function ConfirmDialogLayer({
  dialog,
  onClose,
  onDelete,
  onAdOpen
}: {
  dialog: { kind: 'delete'; targets: FsEntry[] } | { kind: 'ad'; entry: FsEntry }
  onClose: () => void
  onDelete: (targets: readonly FsEntry[]) => void
  onAdOpen: (entry: FsEntry) => void
}): ReactElement {
  const depth = useEscLayer(onClose, true)
  const isDelete = dialog.kind === 'delete'
  const targets = isDelete ? dialog.targets : []
  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(depth)} flex items-center justify-center p-6`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[400px] rounded-modal border border-line bg-surface p-5 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {isDelete ? (
          <>
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-danger-tint text-danger">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </span>
            <h2 className="text-base font-semibold text-primary">移入回收站</h2>
            <p className="mt-1.5 text-[13px] leading-5 text-secondary">
              {targets.length === 1
                ? `将把「${targets[0]?.name ?? ''}」移入回收站。`
                : `将把以下 ${targets.length} 项移入回收站：`}
            </p>
            {targets.length > 1 ? (
              <ul className="mt-2 max-h-40 overflow-auto rounded-md border border-line px-3 py-2 text-[12px] leading-5 text-muted">
                {targets.slice(0, 8).map((t) => (
                  <li key={t.name} className="truncate">
                    {t.name}
                  </li>
                ))}
                {targets.length > 8 ? <li className="text-tertiary">… 共 {targets.length} 项</li> : null}
              </ul>
            ) : null}
            <p className="mt-2 text-[12px] text-muted">
              本地文件进系统回收站；网络位置的文件进软件内回收区，都可在撤销条或回收站中还原，软件不做永久删除。
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-btn bg-danger px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 active:scale-[.98]"
                onClick={() => {
                  onDelete(targets)
                  onClose()
                }}
              >
                移入回收站
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-tint text-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            </span>
            <h2 className="text-base font-semibold text-primary">该文件疑似站方推广文件</h2>
            <p className="mt-1.5 break-all text-[13px] leading-5 text-secondary">
              「{dialog.entry.name}」仍要打开吗？
            </p>
            <p className="mt-2 text-[12px] text-muted">这类文件通常是平台说明或推广页，不是素材本体。</p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onAdOpen(dialog.entry)
                  onClose()
                }}
              >
                仍要打开
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── 小图标（本组件专用，24 网格线性，与 icons.tsx 同口径）────────────────── */

type IconProps = { width?: number; height?: number }

const IconChevronLeft = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </svg>
)
const IconChevronRight = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </svg>
)
const IconHome = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 10.5L12 3l8.5 7.5" />
    <path d="M5.5 9.5V20h5v-6h3v6h5V9.5" />
  </svg>
)
const IconSortArrows = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.6 4.5v15M4.5 16.5l3.1 3 3.1-3" />
    <path d="M16.4 19.5v-15M13.3 7.5l3.1-3 3.1 3" />
  </svg>
)
const IconStack = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.6l8 4.2-8 4.2-8-4.2z" />
    <path d="M4 12.4l8 4.2 8-4.2" />
    <path d="M4 16.6l8 4.2 8-4.2" />
  </svg>
)
const IconExtract = (_p?: IconProps): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12v7a1.5 1.5 0 001.5 1.5h15A1.5 1.5 0 0021 19v-7" />
    <path d="M3 12h4.5M16.5 12H21" />
    <path d="M12 11V2" />
    <path d="M8.5 5.5L12 2l3.5 3.5" />
  </svg>
)

export default PinnedFolderBrowser
