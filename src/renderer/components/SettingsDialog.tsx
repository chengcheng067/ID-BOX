import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVault } from '../store'
import { DISPOSAL_LABEL, SEVEN_ZIP_DOWNLOAD_URL } from '../../shared/types'
import type { AiClassifySettings, AliasRecord, ArchiveDisposal, MotionQuality } from '../../shared/types'
import { MOTION_PROFILES, MOTION_QUALITY_ORDER } from '../../shared/motionQuality'
import { aliasKeyOf } from '../../shared/aliasRules'
import { formatBytes } from '../../shared/format'
import { DIFF_LABEL, isReconcileClean, type DiffItem, type ReconcileReport } from '../logic/reconcile'
import {
  EMPTY_ALIASES,
  MAX_ALIASES,
  aliasIndexOf,
  mergeAliasRecords,
  newAliasId,
  parseAliasImport,
  serializeAliases,
  suggestAliasRecords,
  type AliasSuggestion
} from '../logic/aliasIndex'
import { RETENTION_OPTIONS } from '../logic/trashView'
// DEF-19-3：库目录被改过 / 搬过之后，老资产的 folder 不在新根下 → 主进程的
// probeSizes 守卫会一律拒绝（这是对的），但"整库尺寸补不上"必须在界面上有解释。
// 判据是纯函数，和分辨率浮层的就近提示**共用同一份**（两套判据必然漂移）。
import { planLibraryDrift, libraryDriftWarning } from '../logic/libraryDrift'
// 自动检查更新（2026-10 用户需求）：状态机单独一个模块 —— `store.ts` 正被并发改动，
// 更新检查只是「一个只读结论 + 一个进行中标志」，放进全局 store 只会扩大冲突面。
import {
  checkForUpdate,
  useUpdateChecking,
  useUpdateState
} from '../logic/updateState'
import { Modal } from './Modal'
import { useEscLayer } from '../logic/escLayer'
import { IconCheck, IconRefresh } from '../icons'
import { UNCLASSIFIED } from '../../shared/taxonomy'
// 品牌资源（2026-10 用户要求「图标 logo 换一下」「关于页做上打赏和反馈」）：
// 三张图都由 `scripts/build-app-icon.cjs` 从 `resources/brand/` 的原图生成，
// 走 Vite 的 import（产物是哈希 URL），不放 public/ 也不内联 base64。
// 二维码是**裁好的 512×512**（码面已占 ~86%，四周自带 8% 白边）：
// 微信导出的原图里码面只占一半宽度，直接缩到 168px 会扫不出来。
import donateQr from '../assets/brand/donate-qr.png'
import contactQr from '../assets/brand/contact-qr.png'
import brandMark from '../assets/brand/mark.png'

// 自动检查在渲染进程入口 `main.tsx` 触发（不要依赖本文件的 import 时机：
// 设置弹窗一旦改成 `lazy()`，放在这里的模块副作用会静默失效）。

/**
 * 设置弹窗 tab（§3.6）：外观/导入/库与分类/别名/数据与备份/高级/关于。
 * 「别名」紧跟「库与分类」——两者都是"资产长什么样 / 叫什么"的语汇，放一起用户找得到。
 */
type SettingsTab = 'appearance' | 'import' | 'library' | 'alias' | 'data' | 'advanced' | 'about'

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'import', label: '导入' },
  { key: 'library', label: '库与分类' },
  { key: 'alias', label: '别名' },
  { key: 'data', label: '数据与备份' },
  { key: 'advanced', label: '高级' },
  { key: 'about', label: '关于' }
]

/** 三档处置的展示顺序：回收站（默认）→ 彻底删除 → 保留（§3.6 单选卡顺序） */
const DISPOSAL_ORDER: ArchiveDisposal[] = ['recycle', 'delete', 'keep']

/**
 * 动效性能三档的展示顺序：流畅 → 均衡 → 极致（代价从左到右递增）。
 * 取值 / 文案 / 渲染参数全部来自 `shared/motionQuality.ts`，这里只决定横排顺序。
 */
const MOTION_ORDER: MotionQuality[] = [...MOTION_QUALITY_ORDER]

/** 三档单选卡的副文案（§3.6 截图口径） */
const DISPOSAL_HINT: Record<ArchiveDisposal, string> = {
  recycle: '定期清理回收站即可',
  delete: '立即释放磁盘空间，不可恢复',
  keep: '占双份空间，适合尚未整理定的素材'
}

function Toggle({
  checked,
  onChange,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  /**
   * 置灰**但不改值**（docs/24 §5.5 子开关：总开关关闭时子偏好必须原样保留，
   * 下次打开总开关时用户设置还在）。`disabled` 的按钮不可聚焦、不响应点击，
   * 但仍渲染 `aria-checked`，读屏仍能读出当前值。
   */
  disabled?: boolean
}) {
  return (
    <button
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${
        checked ? 'bg-accent' : 'bg-elevated'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}

/**
 * 设置页的一行：左侧「标题 + 说明（+ 可选警示条）」，右侧操作区。
 *
 * `notice` 是为 DEF-19-3 加的：库目录那一行需要在说明**下方**插一条可行动的警示
 * （索引路径与当前库目录不一致），而不是塞进 `desc` 里 —— `desc` 是常驻灰字，
 * 警示条要能一眼看出来。其余行不传 = 与原来逐像素一致。
 */
function Row({
  title,
  desc,
  notice,
  children
}: {
  title: string
  desc?: string
  notice?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line/70 py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-[11px] leading-relaxed text-muted">{desc}</div>}
        {notice}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 mt-1 text-[13px] font-semibold text-primary">{children}</div>
}

/**
 * 关于页卡片标题的心形图标（14px 线性，跟卡片标题的 13px 文字等高对齐）。
 * 为什么内联：`icons.tsx` 里没有心形 / 对话气泡，为一个 14px 图标去改公共图标库不划算；
 * 用法与文件里既有的内联 svg（关闭按钮）一致，颜色走 `currentColor`，
 * 由外层 `text-accent` 决定 —— 不写死色值。
 */
function IconHeart() {
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
      aria-hidden="true"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  )
}

/** 关于页卡片标题的对话气泡图标（14px 线性，口径同 IconHeart） */
function IconChat() {
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
      aria-hidden="true"
    >
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.8-.4L4 21l1.5-4.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
    </svg>
  )
}

/**
 * 关于页「赞赏支持 / 反馈建议」卡片。
 *
 * 二维码的可扫性是这个组件唯一的硬要求，所以容器有三层保护：
 * ① 外层**白底**（`bg-white`）——深色主题下黑白码直接贴在 `--surface-card` 上扫不出来；
 * ② `p-2.5`（10px）内边距 + 图片自带的 8% 白边（裁图时补的静区）= 两层留白；
 * ③ `object-contain` + `aspect-square`：只等比缩放，绝不拉伸（拉伸会破坏模块栅格）。
 * 图片显示尺寸 = 188 - 2×10 = 168px，落在设计要求的 160–180px 区间。
 */
function SupportCard({
  icon,
  title,
  qrSrc,
  qrAlt,
  caption
}: {
  icon: React.ReactNode
  title: string
  qrSrc: string
  qrAlt: string
  caption: string
}) {
  return (
    <div className="flex flex-col rounded-theme-card bg-card p-3 ring-1 ring-line">
      <div className="flex items-center gap-1.5">
        <span className="text-accent">{icon}</span>
        <span className="text-[13px] font-semibold text-primary">{title}</span>
      </div>
      <div className="mt-2.5 flex justify-center">
        <div className="w-[188px] max-w-full rounded-theme-card bg-white p-2.5 ring-1 ring-line/60">
          <img src={qrSrc} alt={qrAlt} draggable={false} className="aspect-square w-full object-contain" />
        </div>
      </div>
      {/* mt-auto：两张卡被 grid 拉成等高后，让两段文案都贴底对齐 */}
      <p className="mt-auto pt-2.5 text-center text-[11px] leading-relaxed text-muted">{caption}</p>
    </div>
  )
}

/** 单选圆点（§3.6 单选卡 / 外观主题卡共用） */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition ${
        checked ? 'border-accent' : 'border-line'
      }`}
    >
      {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
    </span>
  )
}

/** 主题卡迷你界面预览（§3.6：各带迷你界面预览；色值 = 规范 §1 token 原值） */
function ThemePreview({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  if (mode === 'light') {
    return (
      <div className="flex h-[104px] w-full overflow-hidden rounded-t-[10px] bg-[#F8FAFC]">
        <div className="h-full w-6 bg-[#F1F5F9]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
          <div className="h-2.5 w-full rounded bg-[#FFFFFF]" />
          <div className="flex flex-1 gap-1.5">
            <div className="h-full w-9 rounded bg-[#E1EFFF]" />
            <div className="h-full flex-1 rounded bg-[#FFFFFF]" />
            <div className="flex h-full flex-1 flex-col justify-end gap-1 rounded bg-[#FFFFFF] p-1">
              <div className="h-3 w-8 rounded bg-[#007AFF]" />
            </div>
          </div>
        </div>
      </div>
    )
  }
  if (mode === 'system') {
    // 跟随系统：左半浅 / 右半深，一眼看出「两套都跟随」
    return (
      <div className="flex h-[104px] w-full overflow-hidden rounded-t-[10px]">
        <div className="flex h-full w-1/2 flex-col gap-1.5 bg-[#F8FAFC] p-2">
          <div className="h-2.5 w-full rounded bg-[#FFFFFF]" />
          <div className="flex-1 rounded bg-[#FFFFFF]" />
        </div>
        <div className="flex h-full w-1/2 flex-col gap-1.5 bg-[#111113] p-2">
          <div className="h-2.5 w-full rounded bg-[#1C1C1E]" />
          <div className="flex-1 rounded bg-[#1C1C1E]" />
        </div>
      </div>
    )
  }
  // 只剩浅色以外的分支 = 深色
  return (
    <div className="flex h-[104px] w-full overflow-hidden rounded-t-[10px] bg-[#111113]">
      <div className="h-full w-6 bg-[#161618]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="h-2.5 w-full rounded bg-[#1C1C1E]" />
        <div className="flex flex-1 gap-1.5">
          <div className="h-full w-9 rounded bg-[#1E2A38]" />
          <div className="h-full flex-1 rounded bg-[#1C1C1E]" />
          <div className="flex h-full flex-1 flex-col justify-end gap-1 rounded bg-[#1C1C1E] p-1">
            <div className="h-3 w-8 rounded bg-[#0A84FF]" />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 一条别名的可编辑行（0.6.0 §3.3）。
 *
 * 交互纪律：
 * - **失焦保存**（不是每次按键）：每敲一个字符写一次 settings.json 会把主进程打满；
 * - 提交时 trim，空串 = 放弃编辑（回填原值）—— 空别名会让标题变成空白，绝不允许；
 * - 值没变就不写库（避免无意义的 settings 落盘导致全应用重建别名索引）。
 */
function AliasRow({
  record,
  onSave,
  onDelete
}: {
  record: AliasRecord
  onSave: (name: string) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(record.name)
  /**
   * Esc 回滚的「别保存」标记。
   *
   * blur 是**同步派发**的：先 `setDraft(record.name)` 再 `blur()` 时，`commit` 这次
   * 仍然闭包着编辑后的 `draft` → 会把用户刚想撤回的值存下去。所以回滚必须靠标记，
   * 而不是靠"改完 state 再失焦"（原始写法实际上把 Esc 变成了保存）。
   */
  const revertingRef = useRef(false)
  // 外部改动（导入 / 采纳建议 / 删除同名项）要跟随；依赖 record.name 而不是整对象，避免无谓刷新
  useEffect(() => {
    setDraft(record.name)
  }, [record.id, record.name])

  const commit = () => {
    if (revertingRef.current) {
      revertingRef.current = false
      setDraft(record.name)
      return
    }
    const next = draft.trim()
    if (!next || next === record.name) {
      setDraft(record.name)
      return
    }
    onSave(next)
  }

  /** 归一化 key（脏数据兜底：归一化后为空就显示原 key，至少别显示空白） */
  const normalizedKey = aliasKeyOf(record.key) || record.key

  return (
    <div className="flex items-center gap-2 border-b border-line/60 px-2 py-1.5 last:border-0">
      <code
        className="min-w-0 flex-1 truncate rounded bg-canvas px-1.5 py-0.5 text-[11px] text-secondary"
        title={`原名：${record.key}\n归一化 key：${normalizedKey}`}
      >
        {normalizedKey}
      </code>
      {record.scope === 'asset' && (
        <span className="badge shrink-0" title="只对这一条资产生效（资产级覆盖）">
          单资产
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted">→</span>
      <input
        className="input !w-40 shrink-0 !py-0.5 text-xs"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // 这里的 Esc 语义是「回滚这条别名的草稿」，**不是**关弹窗：
          // 草稿只在失焦时才保存，按 Esc 走人等于放弃修改 —— 若让 `Modal` 吃掉 Esc，
          // 用户本想撤回一格输入，结果整个设置弹窗被关掉。
          // `data-esc-own` 让 `Modal` 的捕获阶段监听对这一格放行（见 Modal.tsx 同名注释）。
          if (e.key === 'Escape') {
            revertingRef.current = true
            setDraft(record.name)
            e.currentTarget.blur()
          }
        }}
        data-esc-own
        title="显示名：失焦即保存；只改界面显示，磁盘文件名不动"
      />
      <button
        className="shrink-0 rounded p-1 text-muted transition hover:bg-elevated hover:text-danger"
        onClick={onDelete}
        title="删除这条别名（不改任何磁盘文件）"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

/**
 * 设置 · 别名 tab（0.6.0 §3.3）。
 *
 * 五个能力，全部**只写 `settings.aliases`**，一个字都不落到磁盘文件上：
 * ① 表格增删改（失焦保存）；② 新增一条；③ 导入 / 导出 JSON；
 * ④ 「采纳建议」（`shared/aliasSuggest` 的词表建议，勾选后才写）；⑤ 500 条上限。
 *
 * 建议**绝不自动写库**：必须先点「采纳建议」生成、再勾选、再点「加入选中项」。
 * 材料名是用户资产，写错比不写更糟（docs/20 §10）。
 */
function AliasTab() {
  const aliases = useVault((s) => s.settings?.aliases) ?? EMPTY_ALIASES
  const assets = useVault((s) => s.assets)
  const saveSettings = useVault((s) => s.saveSettings)

  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  const [suggestions, setSuggestions] = useState<AliasSuggestion[]>([])
  /** 已勾选的建议 key（用归一化 key 做标识，避免 index 漂移） */
  const [picked, setPicked] = useState<string[]>([])
  /** 一行反馈（导入 N 条 / 跳过 M 条 / 上限提示）——常驻 tab 内，不走全局 notice */
  const [message, setMessage] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const full = aliases.length >= MAX_ALIASES
  const aliasIndex = aliasIndexOf(aliases)
  const persist = (next: AliasRecord[]): void => {
    void saveSettings({ aliases: next })
  }

  /** 新增一条：`key` 归一化后如果已存在 → 覆盖同名条目的显示名（不产生重复行） */
  const addOne = () => {
    const key = aliasKeyOf(newKey)
    const name = newName.trim()
    if (!key) {
      setMessage('请先填写原名（不能只有空格 / 符号）')
      return
    }
    if (!name) {
      setMessage('请填写要显示的名字')
      return
    }
    if (full) {
      setMessage(`别名已达上限 ${MAX_ALIASES} 条，请先删除不用的条目`)
      return
    }
    const merged = mergeAliasRecords(aliases, [
      { id: newAliasId(), scope: 'key', key, name, createdAt: Date.now() }
    ])
    persist(merged.records)
    setNewKey('')
    setNewName('')
    setMessage(merged.replaced > 0 ? '已更新同名别名的显示名' : null)
  }

  /** 改一条 → 只替换该记录（顺带抬高 `createdAt`，同键多条时让这次编辑生效） */
  const renameOne = (record: AliasRecord, name: string) => {
    persist(aliases.map((r) => (r.id === record.id ? { ...r, name, createdAt: Date.now() } : r)))
    setMessage(null)
  }

  const removeOne = (id: string) => {
    persist(aliases.filter((r) => r.id !== id))
    setMessage(null)
  }

  /** 生成建议（最多 10 条）。已有别名的 key 会被跳过，不会把用户自己的名字盖掉 */
  const refreshSuggestions = () => {
    const list = suggestAliasRecords(assets, aliasIndex, 10)
    setSuggestions(list)
    setPicked(list.map((s) => s.key))
    setMessage(
      list.length === 0
        ? '没有可采纳的建议：词表认不出这些资产名，或它们已经有别名了'
        : `按当前资产名生成 ${list.length} 条建议，勾选后才会写入`
    )
  }

  /** 采纳勾选的建议（唯一写入点；按钮在下面，没有任何自动写入路径） */
  const applySuggestions = () => {
    const chosen = suggestions.filter((s) => picked.includes(s.key))
    if (chosen.length === 0) return
    const now = Date.now()
    const merged = mergeAliasRecords(
      aliases,
      chosen.map((s, i) => ({
        id: newAliasId(),
        scope: 'key' as const,
        key: s.key,
        name: s.name,
        createdAt: now + i
      }))
    )
    persist(merged.records)
    setMessage(
      `已加入 ${merged.added + merged.replaced} 条${
        merged.dropped > 0 ? `，${merged.dropped} 条因上限未加入` : ''
      }`
    )
    setSuggestions([])
    setPicked([])
  }

  /** 导出：`[{key,name}]`（与导入格式互逆；不带 id / createdAt） */
  const exportJson = () => {
    const blob = new Blob([serializeAliases(aliases)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'idbox-aliases.json'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setMessage(`已导出 ${aliases.length} 条（idbox-aliases.json）`)
  }

  /** 导入：脏行只跳过，整份文件坏掉才报错 */
  const importJson = async (file: File) => {
    let text = ''
    try {
      text = await file.text()
    } catch {
      setMessage('导入失败：读取文件失败，请重试')
      return
    }
    const parsed = parseAliasImport(text, Date.now())
    if (parsed.error) {
      setMessage(parsed.error)
      return
    }
    const merged = mergeAliasRecords(aliases, parsed.records)
    persist(merged.records)
    setMessage(`导入 ${merged.added + merged.replaced} 条，跳过 ${parsed.skipped + merged.dropped} 条`)
  }

  return (
    <div>
      <SectionTitle>别名映射表</SectionTitle>
      {/* 用户拍板的红线文案，别改措辞（设置页与详情面板 tooltip 同口径） */}
      <p className="text-[12px] leading-relaxed text-secondary">
        别名只改软件里显示的名字，磁盘上的文件名不动。
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted">
        左边是归一化后的原名（大小写 / 空格 / 下划线 / 「4K」尾巴 / 知末 ID 都会被抹平），
        一条词典对所有同名资产生效；右侧「显示名」失焦即保存。共 {aliases.length} / {MAX_ALIASES} 条。
      </p>

      {/* ── 表格：原名 → 显示名（逐行可编辑 / 可删） ───────────────── */}
      <div className="mt-3 overflow-hidden rounded-btn border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-canvas/60 px-2 py-1.5 text-[10px] text-muted">
          <span className="min-w-0 flex-1">原名（归一化后的 key）</span>
          <span className="w-4 shrink-0" />
          <span className="w-40 shrink-0">显示名</span>
          <span className="w-6 shrink-0" />
        </div>
        {aliases.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            还没有别名。下面新增一条，或点「采纳建议」看看词表能不能认出这些资产名。
          </div>
        ) : (
          aliases.map((r) => (
            <AliasRow
              key={r.id}
              record={r}
              onSave={(name) => renameOne(r, name)}
              onDelete={() => removeOne(r.id)}
            />
          ))
        )}
      </div>

      {/* ── 新增一条 ─────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-muted">
          原名
          <input
            className="input !py-1 text-xs"
            value={newKey}
            spellCheck={false}
            placeholder="Polished_Concrete / 石材 4K"
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOne()
            }}
          />
        </label>
        <label className="flex w-40 shrink-0 flex-col gap-1 text-[10px] text-muted">
          显示名
          <input
            className="input !py-1 text-xs"
            value={newName}
            placeholder="抛光混凝土"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOne()
            }}
          />
        </label>
        <button
          className="btn btn-primary !py-1 text-xs"
          disabled={full}
          onClick={addOne}
          title={full ? `已达上限 ${MAX_ALIASES} 条，请先删除不用的条目` : '新增一条别名（只影响显示）'}
        >
          ＋ 新增一条
        </button>
      </div>
      {full && (
        <p className="mt-1 text-[10px] leading-relaxed text-danger">
          别名已达上限 {MAX_ALIASES} 条，新增已禁用；请先删除不用的条目。
        </p>
      )}

      {/* ── 导入 / 导出 / 采纳建议 ───────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="btn !py-1 text-xs"
          disabled={aliases.length === 0}
          onClick={exportJson}
          title="导出当前别名表为 [{key,name}] JSON（可换机导入）"
        >
          导出 JSON
        </button>
        <button
          className="btn !py-1 text-xs"
          onClick={() => fileRef.current?.click()}
          title="导入 [{key,name}] JSON；非法行会被跳过"
        >
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            // 清空 value：否则连着选同一个文件不会再触发 change
            e.currentTarget.value = ''
            if (file) void importJson(file)
          }}
        />
        <button
          className="btn !py-1 text-xs"
          onClick={refreshSuggestions}
          title="按当前资产名用内置分类词表生成建议；只是建议，勾选后才写入"
        >
          采纳建议
        </button>
        {message && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-secondary" title={message}>
            {message}
          </span>
        )}
      </div>

      {/* ── 建议列表（勾选 → 一键加入；绝不自动写库） ──────────────── */}
      {suggestions.length > 0 && (
        <div className="mt-3 rounded-btn border border-line bg-canvas/40 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-medium text-primary">
              建议（{suggestions.length}）
            </span>
            <button
              className="text-[11px] text-muted transition hover:text-primary"
              onClick={() => {
                setSuggestions([])
                setPicked([])
              }}
            >
              收起
            </button>
          </div>
          <p className="mb-1.5 text-[10px] leading-relaxed text-muted">
            建议来自内置分类词表，只在你勾选并点「加入选中项」后才写入。
          </p>
          <div className="max-h-40 overflow-auto">
            {suggestions.map((s) => (
              <label
                key={s.key}
                className="flex items-center gap-2 py-0.5 text-[12px] text-secondary"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(s.key)}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked ? [...prev, s.key] : prev.filter((k) => k !== s.key)
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate text-muted" title={s.sourceName}>
                  {s.sourceName}
                </span>
                <span className="shrink-0 text-[11px] text-muted">→</span>
                <span className="w-24 shrink-0 truncate font-medium text-primary" title={s.name}>
                  {s.name}
                </span>
              </label>
            ))}
          </div>
          <button
            className="btn btn-primary mt-2 !py-1 text-xs"
            disabled={picked.length === 0}
            onClick={applySuggestions}
            title={picked.length === 0 ? '请先勾选要加入的建议' : '把勾选的建议写入别名表'}
          >
            加入选中项（{picked.length}）
          </button>
        </div>
      )}
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useVault((s) => s.settings)
  const saveSettings = useVault((s) => s.saveSettings)
  const rescan = useVault((s) => s.rescan)
  /**
   * DEF-19-3：库目录漂移体检（只读派生数据）。
   *
   * 必须用**全库 assets**（不是 `useVisibleAssets()`）：分辨率浮层那边已经按筛选裁过，
   * 而这里要回答的是"索引里有多少条路径已经不在当前库目录下"，与筛选无关。
   * 纯函数，`assets` / `libraryDir` 不变就不会重算。
   */
  const allAssets = useVault((s) => s.assets)
  const libraryDrift = useMemo(
    () => planLibraryDrift(allAssets, settings?.libraryDir ?? ''),
    [allAssets, settings?.libraryDir]
  )
  /**
   * 警示条内容（`null` = 整块不渲染）。文案与"何时显示"都在纯函数里裁决，
   * 单测能直接证明「folder 旧根 + libraryDir 新根 → 提示出现」。
   */
  const driftWarning = libraryDriftWarning(libraryDrift)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [version, setVersion] = useState('')
  // 自动检查更新（关于页）：结论 + 进行中标志都来自 logic/updateState.ts 的模块级 store。
  // 启动自动检查已在文件顶部触发（模块级），这里只负责渲染与手动重试。
  const updateInfo = useUpdateState()
  const updateChecking = useUpdateChecking()
  /**
   * 内容区底部「还有内容」渐隐条（2026-10-21 走查 P2⑦）。
   *
   * 现象：设置弹窗固定 560px 高，数据/高级 tab 的内容比可视区高，最后一行正好被
   * 下边缘切一半，而右侧滚动条在 Windows 上默认是**悬停才显形**的浮层式 ——
   * 用户看不出「下面还有」。这里在真的滚到底之前，底部压一条从卡片底色到透明的
   * 渐隐，滚动条看不见时也有"内容继续"的视觉信号；滚到底就撤掉（否则会误以为还有）。
   *
   * 量高度必须在内容变化后重算 —— 内容高度变化不会触发 scroll 事件（切 tab、
   * 异步读到的缓存统计都会改高度），所以用 ResizeObserver 盯内容块。
   */
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [tabHasMore, setTabHasMore] = useState(false)

  const syncTabOverflow = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    // 留 2px 容差：亚像素布局会让差值停在 0.5 这种数上，否则滚到底了提示条还挂着
    setTabHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
  }, [])

  useEffect(() => {
    const el = tabScrollRef.current
    if (!el) return
    // 切 tab 必须回到顶部：滚动容器是**同一个 DOM**（只换 children），不重置的话
    // 新 tab 会继承上一个 tab 的 scrollTop（被浏览器夹到自己的最大值）——用户点「库与分类」
    // 直接落在中段，而且底部渐隐条算出来是「已到底」→ 不显示，等于把提示也弄丢了。
    el.scrollTop = 0
    syncTabOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncTabOverflow)
    // 同时盯滚动容器（自身尺寸变化）与内容块（内容高度变化）
    const content = el.firstElementChild
    if (content) ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tab, syncTabOverflow])
  // 重新扫描（§4-7：只放设置·导入 tab，顶栏不占位）
  const [rescanBusy, setRescanBusy] = useState(false)
  // T07：遗留布局迁移（03 §4.4）
  const legacyLayoutCount = useVault((s) => s.legacyLayoutCount)
  const migrateLegacyLayout = useVault((s) => s.migrateLegacyLayout)
  const [migOpen, setMigOpen] = useState(false)
  const [migBusy, setMigBusy] = useState(false)
  const [migResult, setMigResult] = useState<{ moved: number; failed: number } | null>(null)
  const [sevenZip, setSevenZip] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /**
   * 命名模板草稿（0.6.0 批量重命名，docs/22 §3.4）。
   *
   * `null` = 未编辑（显示 `settings.renameTemplate`）。用草稿而不是每次按键都写
   * settings：模板是文本，逐字符落盘会把 settings.json 写成几十次。
   * 失焦 / 回车时才提交；空串表示"清掉草稿"，不覆盖已保存的默认值。
   */
  const [tplDraft, setTplDraft] = useState<string | null>(null)
  // 缩略图缓存统计（数量 / 占用），清除后刷新
  const [thumbStat, setThumbStat] = useState<{ count: number; bytes: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  // 2026-10 诊断日志（崩溃取证）：目录 / 文件数 / 总大小，导出中状态
  const [logStat, setLogStat] = useState<{ dir: string; count: number; bytes: number } | null>(null)
  const [logExporting, setLogExporting] = useState(false)
  // 2026-10 材质大类合并（docs/14 §2.3）：待合并数 / 来源目录 / 上次结果
  const materialMergeCount = useVault((s) => s.materialMergeCount)
  const materialMergeSources = useVault((s) => s.materialMergeSources)
  const materialMergeBusy = useVault((s) => s.materialMergeBusy)
  const mergeMaterial = useVault((s) => s.mergeMaterial)
  const detectMaterialMerge = useVault((s) => s.detectMaterialMerge)
  const [mergeResult, setMergeResult] = useState<{ moved: number; renamed: number; failed: number } | null>(null)
  // 2026-10 库安全：重扫前索引备份（可恢复）
  const rescanBackupCount = useVault((s) => s.rescanBackupCount)
  const restoreLastRescanBackup = useVault((s) => s.restoreLastRescanBackup)
  const refreshRescanBackupCount = useVault((s) => s.refreshRescanBackupCount)
  const [restoreBusy, setRestoreBusy] = useState(false)
  // 强制重扫（允许清空索引）：两步确认 + 明示会丢什么 + 明示已自动备份
  const forceRescanAction = useVault((s) => s.forceRescan)
  const [forceOpen, setForceOpen] = useState(false)
  const [forceBusy, setForceBusy] = useState(false)
  const [forceAck, setForceAck] = useState(false)
  const [forcePreview, setForcePreview] = useState<{ gone: number; total: number; found: number } | null>(null)
  const [forceError, setForceError] = useState<string | null>(null)
  const [forceRemoved, setForceRemoved] = useState<number | null>(null)
  // v0.4 库一致性对账（按需检查，不在启动时跑）。
  // 三个复选框默认全 false = 点「检查」只看不改；只有用户勾选 + 点执行才会写库。
  const checkLibraryConsistency = useVault((s) => s.checkLibraryConsistency)
  const applyReconcile = useVault((s) => s.applyReconcile)
  const [consistencyBusy, setConsistencyBusy] = useState(false)
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const [applyBusy, setApplyBusy] = useState(false)
  const [pickMissing, setPickMissing] = useState(false)
  const [pickNotIndexed, setPickNotIndexed] = useState(false)
  const [pickMismatch, setPickMismatch] = useState(false)
  // v1.0.13 重跑自动分类（词表/匹配规则升级后，旧资产不会自动变好）：
  // 候选数直接由索引算（与 store 的筛选口径同一个哨兵），为 0 时按钮禁用。
  const unclassifiedCount = useVault((s) => {
    const assets = s.assets
    let n = 0
    for (const a of assets) {
      const c1 = a.category1 ?? UNCLASSIFIED
      const c2 = a.category2 ?? UNCLASSIFIED
      if (c1 === UNCLASSIFIED && c2 === UNCLASSIFIED) n += 1
    }
    return n
  })
  const reclassifyBusy = useVault((s) => s.reclassifyBusy)
  const reclassifyBackupCount = useVault((s) => s.reclassifyBackupCount)
  const reclassifyUnclassified = useVault((s) => s.reclassifyUnclassified)
  const undoLastReclassify = useVault((s) => s.undoLastReclassify)
  const refreshReclassBackupCount = useVault((s) => s.refreshReclassBackupCount)
  const [reclassOpen, setReclassOpen] = useState(false)
  const [reclassResult, setReclassResult] = useState<{
    moved: number
    missed: number
    failed: number
  } | null>(null)
  const [undoResult, setUndoResult] = useState<{ restored: number; failed: number } | null>(null)
  // AI 辅助分类（docs/15 §7）：表单先本地编辑，失焦/切换时落库（避免每敲一个字符写一次 settings.json）
  const aiSettings: AiClassifySettings = settings?.aiClassify ?? {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: ''
  }
  const [aiForm, setAiForm] = useState<AiClassifySettings>(aiSettings)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTest, setAiTest] = useState<{ ok: boolean; message: string } | null>(null)

  // 外部设置变化（另一个窗口/入口改了配置）→ 表单跟随（按字段比较，避免对象身份抖动）
  useEffect(() => {
    setAiForm(aiSettings)
  }, [aiSettings.enabled, aiSettings.baseUrl, aiSettings.apiKey, aiSettings.model])

  useEffect(() => {
    void window.modvault.sevenZipPath().then(setSevenZip)
    void window.modvault.thumbStats().then(setThumbStat).catch(() => undefined)
    void window.modvault.getAppVersion().then(setVersion).catch(() => undefined)
    // 诊断日志：打开设置时读一次目录 / 文件数 / 总大小（不 watch 文件系统）
    void window.modvault.logStats().then(setLogStat).catch(() => undefined)
    // 打开设置即刷新一次「待合并数量」（只读探测，不搬任何文件）
    void detectMaterialMerge()
    // 只读刷新「可恢复的重扫备份」条数（决定按钮可用性）
    void refreshRescanBackupCount()
  }, [detectMaterialMerge, refreshRescanBackupCount])

  const refreshThumbStat = () => {
    void window.modvault.thumbStats().then(setThumbStat).catch(() => undefined)
  }

  const refreshLogStat = () => {
    void window.modvault.logStats().then(setLogStat).catch(() => undefined)
  }

  /**
   * Esc 关闭（0.7.6 T-ESC 真机返工）。
   *
   * 本弹窗外壳是**自绘** `dialog-scrim`（见下面 return，不走 `Modal`），所以必须自己占一层。
   * 少了这一步的后果（qa-real076 真机复现）：`hasEscLayer()` 为 false → Esc 落到 App 的
   * 全局 `decideEsc` → `settingsOpen` 命中 `'close-settings'`；而别名输入框的
   * `data-esc-own` 只被 `Modal` 认，自绘外壳这条支路根本没经过它 → 「草稿回滚了、
   * 弹窗也被关掉」。
   *
   * 现在两层保障同时成立：本层在栈里（App 不动作）+ `useEscLayer` 认 `data-esc-own`
   * （输入框那一格按 Esc 只回滚草稿，不关弹窗）。
   */
  useEscLayer(onClose, !!settings)

  if (!settings) return null

  const flash = () => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1200)
  }

  const clearThumbs = async () => {
    setClearing(true)
    try {
      await window.modvault.clearThumbs()
    } finally {
      setClearing(false)
      refreshThumbStat()
    }
  }

  /**
   * 打开「强制重扫」确认框，并先做一次**只读预演**（不删任何东西）：
   * 用当前索引与扫描结果对比，算出"会被删掉多少"，让确认框里说的是真实数字 N 而不是恐吓话术。
   * 确认后 `forceRescan()` 会再扫一次（宁可多扫一遍，也不把预演结果当作删除依据）。
   */
  const openForceRescan = async () => {
    setForceOpen(true)
    setForceAck(false)
    setForceRemoved(null)
    setForcePreview(null)
    setForceError(null)
    setForceBusy(true)
    try {
      const r = await window.modvault.rescan()
      const local = useVault.getState().assets
      const foundFolders = new Set(r.assets.map((a) => a.folder))
      const found = local.filter((a) => foundFolders.has(a.folder)).length
      setForcePreview({ gone: local.length - found, total: local.length, found })
    } catch {
      setForceError('无法完成扫描预览（磁盘或库目录不可读），请检查库目录后重试。')
    } finally {
      setForceBusy(false)
    }
  }

  /** 索引快照导出（P0-6）：Dexie 里的资产 JSON → 主进程保存对话框落盘 */
  const exportIndex = async () => {    const json = JSON.stringify(useVault.getState().assets)
    const p = await window.modvault.exportIndexBackup(json).catch(() => null)
    if (p) {
      useVault.setState({ notice: `索引快照已导出：${p}` })
    } else {
      useVault.setState({ notice: '导出已取消或失败' })
    }
  }

  /**
   * 导出诊断日志：主进程弹保存对话框 → 把 logs 目录打成 zip。
   * 用户取消**不提示失败**（canceled=true），只有真正失败才提示。
   */
  const exportLogs = async () => {
    setLogExporting(true)
    try {
      const r = await window.modvault.exportLogs().catch(() => null)
      if (!r) {
        useVault.setState({ notice: '日志导出失败（主进程无响应）' })
        return
      }
      if (r.canceled) return
      if (r.path) {
        useVault.setState({ notice: `诊断日志已导出（${r.files} 个文件）：${r.path}` })
      } else {
        useVault.setState({ notice: '日志导出失败，请稍后重试' })
      }
    } finally {
      setLogExporting(false)
      refreshLogStat()
    }
  }

  /**
   * v0.4 库一致性检查：**只读**。
   *
   * 这里只做三件事：① 调 `checkLibraryConsistency()`（内部唯一 IO 是一次
   * `window.modvault.rescan()` 纯扫描）② 把报告放进 state ③ 关掉 loading。
   * **没有 db.assets 写入、没有 set({ assets })、没有任何磁盘操作**——
   * 真正的修改全部在每个复选框 + 「执行所选修复」之后（见 runRepair）。
   */
  const runConsistencyCheck = async () => {
    setConsistencyBusy(true)
    try {
      const r = await checkLibraryConsistency()
      setReport(r)
      // 每次打开报告都从「一项都不勾」开始：默认不改任何东西
      setPickMissing(false)
      setPickNotIndexed(false)
      setPickMismatch(false)
    } catch (err) {
      useVault.setState({
        notice: `检查失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      setConsistencyBusy(false)
    }
  }

  /** 绝对路径 → 相对库根目录（展示用；Windows 前缀比较忽略大小写） */
  const relDirOf = (folder: string): string => {
    const root = (settings?.libraryDir ?? '').replace(/[\\/]+$/, '')
    if (!root) return folder
    if (folder.toLowerCase().startsWith(root.toLowerCase())) {
      return folder.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    }
    return folder
  }

  /** 单条差异的人话说明 */
  const reasonOf = (item: DiffItem): string => {
    if (item.kind === 'missing-on-disk') return '索引里有，磁盘上已找不到（可能被删或移走）'
    if (item.kind === 'not-in-index') return '磁盘上有，索引里还没有（手动放进来的）'
    const idx = item.indexCategory?.join(' / ') ?? ''
    const disk = item.diskCategory?.join(' / ') ?? ''
    return `分类不一致：索引「${idx}」→ 磁盘「${disk}」`
  }

  /** 执行用户勾选的修复（唯一会写库的入口） */
  const runRepair = async () => {
    if (!report) return
    const actions = {
      removeIndex: pickMissing
        ? report.items
            .filter((i) => i.kind === 'missing-on-disk')
            .map((i) => i.id)
            .filter((x): x is string => typeof x === 'string')
        : [],
      addIndex: pickNotIndexed
        ? report.items.filter((i) => i.kind === 'not-in-index' && i.scanned).map((i) => i.scanned!)
        : [],
      fixCategory: pickMismatch
        ? report.items
            .filter((i) => i.kind === 'category-mismatch')
            .map((i) => i.id)
            .filter((x): x is string => typeof x === 'string')
        : []
    }
    setApplyBusy(true)
    try {
      await applyReconcile(actions)
      setReport(null)
      // 移除记录会写一份重扫备份 → 刷新「可恢复备份」条数
      void refreshRescanBackupCount()
    } finally {
      setApplyBusy(false)
    }
  }

  /** 当前勾选的类别数（0 → 执行按钮禁用） */
  const pickedCount = (pickMissing ? 1 : 0) + (pickNotIndexed ? 1 : 0) + (pickMismatch ? 1 : 0)

  /** AI 表单落库：`patch` 与本地值合并后整体保存（main 侧还会做一次逐字段归一化） */
  const commitAi = (patch: Partial<AiClassifySettings>) => {
    const next: AiClassifySettings = { ...aiForm, ...patch }
    setAiForm(next)
    void saveSettings({ aiClassify: next })
  }

  /**
   * 「测试连接」：只发一条最小请求（不分类、不注入词表），
   * 失败原因（401 / 404 / 模型名错 / 超时）原样展示，方便用户自查。
   */
  const testAi = async () => {
    setAiTesting(true)
    setAiTest(null)
    try {
      const r = await window.modvault.aiClassifyTest(aiForm)
      setAiTest(r)
    } catch (err) {
      setAiTest({
        ok: false,
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      setAiTesting(false)
    }
  }

  // ── 各 tab 内容 ──────────────────────────────────────────────

  const appearanceTab = (
    <div>
      <SectionTitle>主题</SectionTitle>
      <div className="flex gap-4">
        {(['light', 'dark', 'system'] as const).map((mode) => {
          const active = settings.theme === mode
          return (
            <button
              key={mode}
              className="w-[150px] text-left"
              onClick={() => {
                void saveSettings({ theme: mode })
                flash()
              }}
              title={
                mode === 'light'
                  ? '浅色 Soft UI'
                  : mode === 'dark'
                    ? '深色 Vibrancy'
                    : '跟随 Windows 深浅色设置（系统切换时实时跟随）'
              }
            >
              {/* C#15（已拍板按画布）：主题三卡圆角画布实测 r12（浅 2:507/520/530，
                  深 2:907/915/925 同值）→ 走 --radius-theme-card，不再是硬编码 10。 */}
              <div
                className={`overflow-hidden rounded-theme-card transition ${active ? 'ring-[1.2px] ring-accent' : 'ring-1 ring-line'}`}
              >
                <ThemePreview mode={mode} />
                <div className="flex items-center gap-2 bg-card px-2.5 py-2">
                  <RadioDot checked={active} />
                  <span className={`text-[12px] ${active ? 'font-semibold text-accent-text' : 'text-secondary'}`}>
                    {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      {/* 0.6.0：跟随系统从"留位"变成真功能（settings.theme='system' + matchMedia 实时解析），
          三张卡都可点，不再有禁用态。 */}
      {/* ── 动效性能（2026-10 用户反馈「动画不够顺」）────────────────────────
          三档只映射成一份纯配置（`shared/motionQuality.ts`）：渲染 DPR 上限、
          贴图各向异性过滤上限、hover 预热是否插队。渲染层在**构建场景时读一次**，
          所以改档不重建当前这颗球，下次开球生效（文案里不承诺"立即"，避免误解）。
          卡片样式 / 单选圆点 / saveSettings 调用方式全部对齐上方主题三卡；
          窄栏里用 flex-wrap 折行，不横向溢出。 */}
      <div className="mt-4">
        <SectionTitle>动效性能</SectionTitle>
        <p className="mb-1 text-[11px] leading-relaxed text-muted">
          决定材质球的渲染上限：分辨率倍率、贴图过滤强度，以及悬停预热是否插队。越高越清晰，GPU 占用也越高。
        </p>
        <div className="flex flex-wrap gap-3">
          {MOTION_ORDER.map((q) => {
            const profile = MOTION_PROFILES[q]
            const active = settings.motionQuality === q
            return (
              <button
                key={q}
                className="min-w-[148px] flex-1 text-left"
                onClick={() => {
                  void saveSettings({ motionQuality: q })
                  flash()
                }}
                title={profile.hint}
              >
                <div
                  className={`rounded-theme-card bg-card px-2.5 py-2 transition ${
                    active ? 'ring-[1.2px] ring-accent' : 'ring-1 ring-line'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <RadioDot checked={active} />
                    <span
                      className={`text-[12px] ${active ? 'font-semibold text-accent-text' : 'text-secondary'}`}
                    >
                      {profile.label}
                    </span>
                    {q === 'balanced' && (
                      <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">
                        推荐
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-muted">{profile.hint}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
      {/* C#19（已拍板「保留但可关闭」）：画布无样本，帮助文本保留，
          新增设置项 `showHelpHint`（默认 true），放在设置·外观 tab。 */}
      <Row title="显示操作提示" desc="在中栏顶部显示「双击定位 / 拖拽拖出」的提示文本。关闭后中栏头更干净。">
        <Toggle checked={settings.showHelpHint} onChange={(v) => void saveSettings({ showHelpHint: v })} />
      </Row>

      {/* 2026-10 用户反馈：侧栏「整理」组的三项由用户决定是否显示。
          关闭时 store 会顺带把对应筛选重置（避免"筛选生效但入口看不到"）。 */}
      <div className="mt-4">
        <SectionTitle>侧栏显示</SectionTitle>
        <p className="mb-1 text-[11px] leading-relaxed text-muted">
          决定侧栏「整理」组里显示哪些入口。关掉后侧栏不显示该入口，筛选状态会一并清空。
        </p>
        <Row title="收藏" desc="侧栏显示「收藏」入口（仅看已收藏的资产）。">
          <Toggle
            checked={settings.showFavorites !== false}
            onChange={(v) => {
              void saveSettings({ showFavorites: v })
              flash()
            }}
          />
        </Row>
        <Row title="色标" desc="侧栏显示「色标」筛选的六个色点。">
          <Toggle
            checked={settings.showColorTags !== false}
            onChange={(v) => {
              void saveSettings({ showColorTags: v })
              flash()
            }}
          />
        </Row>
        <Row title="重复资产" desc="侧栏显示「重复资产」入口（按名字分组的重复清单）。">
          <Toggle
            checked={settings.showDuplicates !== false}
            onChange={(v) => {
              void saveSettings({ showDuplicates: v })
              flash()
            }}
          />
        </Row>
      </div>
    </div>
  )

  const importTab = (
    <div>
      <SectionTitle>原压缩包处置</SectionTitle>
      <div className="flex flex-col gap-2">
        {DISPOSAL_ORDER.map((d) => {
          const active = settings.archiveDisposal === d
          return (
            <button
              key={d}
              className="flex items-center gap-3 rounded-btn border px-3 py-2.5 text-left transition"
              style={{
                borderWidth: active ? 1.2 : 1,
                borderColor: active ? 'var(--accent)' : 'var(--border)'
              }}
              onClick={() => {
                void saveSettings({ archiveDisposal: d })
                flash()
              }}
            >
              <RadioDot checked={active} />
              <span className="min-w-0">
                <span className={`block text-[13px] ${active ? 'font-semibold text-primary' : 'text-primary'}`}>
                  {DISPOSAL_LABEL[d]}
                  {d === 'recycle' && <span className="ml-1.5 text-[11px] font-normal text-accent-text">（推荐）</span>}
                </span>
                <span className="block text-[11px] text-muted">{DISPOSAL_HINT[d]}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* ── C 线「最近删除」：删除保留期四档（默认 30 天） ──────────────────
          单选卡复用「原压缩包处置」那套（RadioDot + 描边高亮），不新造控件。
          切换**不立刻清理**已存在的删除项：清理档期由主进程 sweep 决定（启动时 / 每 6 小时），
          下方灰字必须把这一点写清楚，否则用户会以为"改成 5 天 → 旧的马上没了"。 */}
      <div className="mt-5">
        <SectionTitle>删除保留期</SectionTitle>
        <div className="flex flex-col gap-2">
          {RETENTION_OPTIONS.map((opt) => {
            const active = settings.trashRetention === opt.value
            return (
              <button
                key={opt.value}
                className="flex items-center gap-3 rounded-btn border px-3 py-2.5 text-left transition"
                style={{
                  borderWidth: active ? 1.2 : 1,
                  borderColor: active ? 'var(--accent)' : 'var(--border)'
                }}
                onClick={() => {
                  void saveSettings({ trashRetention: opt.value })
                  flash()
                }}
              >
                <RadioDot checked={active} />
                <span className="min-w-0">
                  <span className={`block text-[13px] ${active ? 'font-semibold text-primary' : 'text-primary'}`}>
                    {opt.label}
                    {opt.value === '30d' && (
                      <span className="ml-1.5 text-[11px] font-normal text-accent-text">（默认）</span>
                    )}
                  </span>
                  <span className="block text-[11px] text-muted">{opt.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          切换保留期不会立刻清理已经删除的资产；新的保留期在下一次自动清理时生效
          （应用启动时、每 6 小时，或你再次删除资产时触发）。
        </p>
      </div>

      {/* §3.6：同时解压任务数 stepper（默认 2） */}
      <Row
        title="同时解压任务数"
        desc="批量导入时并行解压的压缩包个数。调大更快，但占用更多 CPU / 磁盘 IO。"
      >
        <div className="flex items-center gap-2 rounded-btn border border-line px-1 py-0.5">
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-secondary transition hover:bg-elevated disabled:opacity-30"
            disabled={settings.extractConcurrency <= 1}
            onClick={() => {
              void saveSettings({ extractConcurrency: Math.max(1, settings.extractConcurrency - 1) })
              flash()
            }}
            title="减少"
          >
            −
          </button>
          <span className="w-6 text-center text-[13px] font-medium">{settings.extractConcurrency}</span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-secondary transition hover:bg-elevated disabled:opacity-30"
            disabled={settings.extractConcurrency >= 8}
            onClick={() => {
              void saveSettings({ extractConcurrency: Math.min(8, settings.extractConcurrency + 1) })
              flash()
            }}
            title="增加"
          >
            +
          </button>
        </div>
      </Row>

      {/* ── 知末封面抓取（docs/24 §5.5）：主开关 + 子开关 ──────────────────
          两项**互不牵连**：关掉总开关只停止自动抓取，子开关的值原样保留
          （子项置灰但值不变，再次打开总开关时用户偏好还在）。
          两者都只约束**导入后的自动任务**；详情面板的手动按钮永远替换。 */}
      <Row
        title="自动从知末获取模型封面"
        desc="导入模型后，按资产名里的知末 ID 自动抓取无水印主图当封面（400×300）。只对模型生效；失败静默，不影响导入。"
      >
        <Toggle
          checked={settings.zhimoCover}
          onChange={(v) => {
            void saveSettings({ zhimoCover: v })
            flash()
          }}
        />
      </Row>
      <div className="border-b border-line/70 py-3 pl-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-secondary">包内已有预览图时也替换</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted">
              关闭后，压缩包里自带的图片会优先保留 —— 注意有些包自带的其实是材质贴图，不是模型预览。
            </div>
          </div>
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={settings.zhimoCoverReplacePacked}
              disabled={settings.zhimoCover === false}
              onChange={(v) => {
                void saveSettings({ zhimoCoverReplacePacked: v })
                flash()
              }}
            />
          </div>
        </div>
      </div>

      {/* ── 0.6.0 批量重命名：默认命名模板（只影响「重命名…」弹窗的初值） ──
          只改**文件夹名**，不改包里的文件；真正落盘前还有预览表 + 冲突拦截 + 失败回滚。 */}
      <Row
        title="命名模板"
        desc="「重命名…」弹窗的默认模板，只改文件夹名、不改包里的文件。占位符：{name} {c1} {c2} {year} {n}（{n:2} 补零成 01）。"
      >
        <input
          className="input w-52 font-mono text-[12px]"
          value={tplDraft ?? settings.renameTemplate}
          placeholder="{c1}-{c2}-{name}"
          spellCheck={false}
          onChange={(e) => setTplDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          onBlur={() => {
            const next = (tplDraft ?? '').trim()
            setTplDraft(null)
            // 空模板不落盘（保留旧的默认值），避免用户清空后弹窗模板变成空串
            if (next && next !== settings.renameTemplate) {
              void saveSettings({ renameTemplate: next })
              flash()
            }
          }}
        />
      </Row>

      {/* §3.6/§4-7：库维护·重新扫描（从顶栏移入此处，顶栏不占位） */}
      <div className="mt-4">
        <SectionTitle>库维护</SectionTitle>
        <div className="flex items-center gap-3">
          <button
            className="btn !py-1.5 text-xs"
            disabled={rescanBusy || materialMergeBusy}
            onClick={async () => {
              setRescanBusy(true)
              try {
                await rescan()
              } finally {
                setRescanBusy(false)
              }
            }}
            title={materialMergeBusy ? '材质大类合并进行中，暂不能重扫' : undefined}
          >
            <IconRefresh />
            {rescanBusy ? '扫描中…' : '重新扫描'}
          </button>
          <span className="text-[11px] text-muted">
            {materialMergeBusy ? '材质合并进行中，重扫已暂时禁用' : '对比磁盘与索引，找回随手移动的资产'}
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          低频操作，已从顶栏移入设置（§4-7）。扫描整个库目录并重建资产索引：库内手动新增的压缩包/文件夹会导入；
          <span className="text-secondary">
            外部改名或移动过的资产会被当作新资产重新索引，原有的标签、备注、风格会丢失
          </span>
          ；删除的资产会从索引移除（可从下方备份恢复）。
        </p>

        {/* 库安全（2026-10）：重扫前会把被删记录的完整元数据写进 backups，这里给一键恢复入口。
            只恢复索引（含 tags/note/styles），磁盘文件仍需用户自己放回原位。 */}
        <div className="mt-3 flex items-center gap-3">
          <button
            className="btn !py-1.5 text-xs"
            disabled={rescanBackupCount === 0 || restoreBusy}
            onClick={async () => {
              setRestoreBusy(true)
              try {
                await restoreLastRescanBackup()
              } finally {
                setRestoreBusy(false)
                void refreshRescanBackupCount()
              }
            }}
            title={
              rescanBackupCount === 0
                ? '还没有重扫备份：每次重扫真正删除记录前会自动备份一份'
                : '把最近一次重扫删掉的资产记录（含标签/备注/风格）恢复到索引'
            }
          >
            <IconRefresh />
            {restoreBusy ? '恢复中…' : '恢复上次重扫前索引'}
          </button>
          <span className="text-[11px] text-muted">
            {rescanBackupCount > 0
              ? `可用备份 ${rescanBackupCount} 份（只保留最近 5 份）`
              : '暂无重扫备份'}
          </span>
        </div>

        {/* 强制重扫（允许清空索引）：给"确认库目录确实变了 / 要清空索引"提供真实入口，
            否则守卫 ① 的中止提示会指向一个不存在的按钮。必须二次确认 + 明示丢什么。 */}
        <div className="mt-2 flex items-center gap-3">
          <button
            className="btn btn-danger !py-1.5 text-xs"
            disabled={forceBusy}
            onClick={() => void openForceRescan()}
            title="跳过安全守卫重建索引（会先自动备份，仍可恢复）"
          >
            <IconRefresh />
            强制重扫
          </button>
          <span className="text-[11px] text-muted">
            {forceRemoved !== null
              ? `上次强制重扫已移除 ${forceRemoved} 个索引记录（已自动备份，可恢复）`
              : '仅用于确认库目录已变空 / 换库后重建；会弹二次确认'}
          </span>
        </div>
      </div>

      {/* v0.4 库一致性检查（按需触发，不在启动时跑）：检查只读，勾选后才修 */}
      <div className="mt-4">
        <SectionTitle>库一致性检查</SectionTitle>
        <div className="flex items-center gap-3">
          <button
            className="btn !py-1.5 text-xs"
            disabled={consistencyBusy || materialMergeBusy}
            onClick={() => void runConsistencyCheck()}
            title="扫描库目录并与索引对比（只读，不会修改任何东西）"
          >
            <IconRefresh />
            {consistencyBusy ? '扫描中…' : '检查索引与磁盘'}
          </button>
          <span className="text-[11px] text-muted">
            扫描库目录并与索引对比，
            <span className="text-secondary">不会自动修改任何东西</span>
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          用于发现三类偏差：磁盘上已被删除的索引记录、手动拖进库里但没索引的资产、目录名改过导致
          分类不一致。大库扫描可能需要几秒。
        </p>
      </div>

      {/* v1.0.13 重跑自动分类：分类只在导入那一刻跑一次，词表/匹配规则升级后旧资产不会自己变好。
          用户库里就躺着若干「材质/未分类」，不给入口他会以为 bug 没修。 */}
      <div className="mt-4">
        <SectionTitle>重跑自动分类</SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn !py-1.5 text-xs"
            disabled={reclassifyBusy || unclassifiedCount === 0 || materialMergeBusy}
            onClick={() => {
              setReclassResult(null)
              setUndoResult(null)
              setReclassOpen(true)
            }}
            title={
              materialMergeBusy
                ? '材质大类合并进行中，暂不能重跑分类'
                : unclassifiedCount === 0
                  ? '当前没有「未分类/未分类」的资产'
                  : '按当前词表重新判定一次；移动前会自动备份，可撤销'
            }
          >
            <IconRefresh />
            {reclassifyBusy ? '处理中…' : '重跑自动分类'}
          </button>
          <button
            className="btn !py-1.5 text-xs"
            disabled={reclassifyBusy || reclassifyBackupCount === 0}
            onClick={async () => {
              setReclassResult(null)
              const r = await undoLastReclassify()
              setUndoResult(r)
              void refreshReclassBackupCount()
            }}
            title={
              reclassifyBackupCount === 0
                ? '还没有重跑备份：每次重跑移动前会自动备份一份'
                : '把上次重跑移动过的资产按原分类搬回去'
            }
          >
            <IconRefresh />
            撤销上次重跑
          </button>
          <span className="text-[11px] text-muted">
            {reclassifyBackupCount > 0
              ? `可撤销备份 ${reclassifyBackupCount} 份（只保留最近 3 份）`
              : '暂无重跑备份'}
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          把落在「未分类」的资产按
          <span className="text-secondary">当前词表</span>
          重新判定一次，命中的会移动目录（移动前自动备份，可撤销）。
          <span className="text-secondary">已分类的资产一个都不会动</span>
          {unclassifiedCount > 0 && (
            <>
              ；当前有 <span className="font-semibold text-primary">{unclassifiedCount}</span> 个未分类资产。
            </>
          )}
          {unclassifiedCount === 0 && '。'}
        </p>
        {reclassResult && (
          <p className="mt-1 text-[11px] text-secondary">
            上次重跑：移动{' '}
            <span className="font-semibold text-primary">{reclassResult.moved}</span> 个，未识别{' '}
            {reclassResult.missed} 个
            {reclassResult.failed > 0 && (
              <>
                ，失败 <span className="font-semibold text-danger">{reclassResult.failed}</span> 个
              </>
            )}
            。
          </p>
        )}
        {undoResult && (
          <p className="mt-1 text-[11px] text-secondary">
            上次撤销：还原 <span className="font-semibold text-primary">{undoResult.restored}</span> 个
            {undoResult.failed > 0 && (
              <>
                ，失败 <span className="font-semibold text-danger">{undoResult.failed}</span> 个
              </>
            )}
            。
          </p>
        )}
      </div>

      <div className="mt-2">
        <Row
          title="监控下载目录"
          desc="开启后，该目录新出现的压缩包会在写入稳定后自动导入（浏览器边下边写会等 2 秒）。建议只监控一个专用下载文件夹。"
        >
          <div className="flex items-center gap-2">
            {settings.watchDir && (
              <code className="max-w-[160px] truncate rounded-md bg-canvas px-2 py-1 text-[11px] text-secondary" title={settings.watchDir}>
                {settings.watchDir}
              </code>
            )}
            <button
              className="btn !py-1 text-xs"
              onClick={async () => {
                const dir = await window.modvault.pickWatchDir()
                if (dir) {
                  await saveSettings({ watchDir: dir, watchEnabled: true })
                  flash()
                }
              }}
            >
              选择目录
            </button>
            <Toggle
              checked={settings.watchEnabled}
              onChange={(v) => {
                void saveSettings({ watchEnabled: v })
                flash()
              }}
            />
          </div>
        </Row>
      </div>
    </div>
  )

  const libraryTab = (
    <div>
      <Row
        title="库目录"
        desc="所有模型/贴图的归档位置。更改后点「导入」页的「重新扫描」即可索引新目录。"
        notice={
          /*
           * DEF-19-3：索引路径与当前库目录不一致时的**可行动**提示。
           *
           * 为什么必须提示：`probeSizes` 的越界守卫会让老资产的尺寸回填全部返回空
           * （`scanned:N, patched:0`），分辨率筛选于是永远筛不到它们，而日志里只有一行
           * WARN —— 用户看不到日志，只会觉得"筛选坏了"。
           *
           * 只给只读入口，**绝不**放一个"点了就重建索引"的按钮：重建会丢标签/备注/风格，
           * 必须先看「检查索引与磁盘」的结果再决定（那也是这里唯一的行动指向）。
           * outsideCount === 0 时 `driftWarning` 为 null → 整块不渲染（零视觉噪音）。
           */
          driftWarning ? (
            <div className="mt-1.5 rounded-lg border border-danger/40 bg-danger-tint px-2.5 py-2 text-[11px] leading-relaxed text-danger">
              <div className="font-medium">{driftWarning.title}</div>
              <div className="mt-1">{driftWarning.body}</div>
            </div>
          ) : null
        }
      >
        <div className="flex items-center gap-2">
          <code className="max-w-[220px] truncate rounded-md bg-canvas px-2 py-1 text-[11px] text-secondary">{settings.libraryDir}</code>
          <button
            className="btn !py-1 text-xs"
            onClick={async () => {
              await window.modvault.chooseLibrary()
              flash()
            }}
          >
            更改…
          </button>
          <button className="btn !py-1 text-xs" onClick={() => window.modvault.openLibrary()}>
            打开
          </button>
        </div>
      </Row>

      <Row title="默认来源标签" desc="导入时给资产打上的来源，之后可在详情里改。">
        <input
          className="input !w-32 !py-1 text-xs"
          value={settings.defaultSource}
          onChange={(e) => void saveSettings({ defaultSource: e.target.value })}
        />
      </Row>

      {/* T07：遗留布局迁移入口（批量搬动真实文件，确认弹窗必须写清数字） */}
      <Row
        title="迁移旧版目录结构"
        desc={
          legacyLayoutCount > 0
            ? `检测到 ${legacyLayoutCount} 个资产仍是旧版两层目录（<大类>/<资产名>），将搬到 <大类>/未分类/未分类/<资产名>。`
            : '未检测到旧版目录结构，所有资产已是 <大类>/<一级>/<二级>/<资产名> 四层布局。'
        }
      >
        <button
          className="btn !py-1 text-xs"
          disabled={legacyLayoutCount === 0 || migBusy}
          onClick={() => {
            setMigResult(null)
            setMigOpen(true)
          }}
        >
          <IconRefresh />
          迁移…
        </button>
      </Row>

      {/* 2026-10 材质大类合并：贴图/ + 材质预设/ → 材质/（docs/14 §2.3.6） */}
      <Row
        title="材质大类合并"
        desc={
          materialMergeBusy
            ? '正在合并…请勿关闭应用或手动改动库目录。'
            : mergeResult
              ? `上次合并：成功 ${mergeResult.moved} 个${mergeResult.renamed > 0 ? `，重名加序号 ${mergeResult.renamed} 个` : ''}${mergeResult.failed > 0 ? `，失败 ${mergeResult.failed} 个（下次启动会重试）` : ''}。`
              : materialMergeCount > 0
                ? `检测到 ${materialMergeCount} 个资产仍在旧目录（${materialMergeSources.map((s) => s.name).join(' / ') || '贴图 / 材质预设'}）下，将逐资产搬入「材质/」，同名一级目录自动合并。重名自动加序号，永不覆盖；标签/备注/封面全部保留。`
                : '未检测到旧版「贴图 / 材质预设」大类目录，所有资产已在「材质/」下。'
        }
      >
        <button
          className="btn !py-1 text-xs"
          disabled={materialMergeCount === 0 || materialMergeBusy}
          onClick={async () => {
            setMergeResult(null)
            // force：用户在设置页显式点击 = 已知情，跳过 >50 的自动保护
            const r = await mergeMaterial({ force: true })
            setMergeResult({ moved: r.moved, renamed: r.renamed, failed: r.failed })
            flash()
          }}
        >
          <IconRefresh />
          {materialMergeBusy ? '合并中…' : `立即合并${materialMergeCount > 0 ? `（${materialMergeCount} 个）` : ''}`}
        </button>
      </Row>

      {/* ── AI 辅助分类（可选，docs/15 §7）────────────────────────────
          用户拍板口径：**词表优先 + 模型兜底，不内置任何模型**。
          这里只提供「接哪个服务」的四个字段，默认关闭；未填写 = 零网络请求。 */}
      <div className="mt-4 rounded-btn border border-line bg-canvas/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-primary">AI 辅助分类（可选）</div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted">
              仅当分类词表无法判断时才调用；会把资产名（不含文件内容）发送到你填写的服务；默认关闭。
            </div>
          </div>
          <Toggle checked={aiForm.enabled} onChange={(v) => commitAi({ enabled: v })} />
        </div>

        <div className="mt-3 grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2">
          <label className="text-[11px] text-secondary" htmlFor="ai-base-url">
            接口地址
          </label>
          <input
            id="ai-base-url"
            className="input !py-1 text-xs"
            value={aiForm.baseUrl}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(e) => setAiForm({ ...aiForm, baseUrl: e.target.value })}
            onBlur={() => commitAi({})}
          />

          <label className="text-[11px] text-secondary" htmlFor="ai-api-key">
            密钥
          </label>
          <input
            id="ai-api-key"
            className="input !py-1 text-xs"
            type="password"
            value={aiForm.apiKey}
            placeholder="sk-…（本地服务可留空）"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })}
            onBlur={() => commitAi({})}
          />

          <label className="text-[11px] text-secondary" htmlFor="ai-model">
            模型名
          </label>
          <input
            id="ai-model"
            className="input !py-1 text-xs"
            value={aiForm.model}
            placeholder="gpt-4o-mini / qwen2.5:7b"
            spellCheck={false}
            onChange={(e) => setAiForm({ ...aiForm, model: e.target.value })}
            onBlur={() => commitAi({})}
          />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            className="btn !py-1 text-xs"
            disabled={aiTesting || !aiForm.baseUrl.trim() || !aiForm.model.trim()}
            onClick={() => void testAi()}
            title="发一条最小请求，验证地址 / 密钥 / 模型名是否可用"
          >
            <IconRefresh />
            {aiTesting ? '测试中…' : '测试连接'}
          </button>
          {aiTest && (
            <span
              className={`max-w-[320px] truncate text-[11px] ${aiTest.ok ? 'text-success' : 'text-danger'}`}
              title={aiTest.message}
            >
              {aiTest.message}
            </span>
          )}
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          兼容 OpenAI 格式的 /chat/completions 接口（OpenAI、DeepSeek、通义、Ollama 等）。
          密钥仅保存在本机 settings.json；识别不了或请求失败时保持「未分类」，不会打断导入，也不会覆盖已分类的资产。
        </p>
      </div>

      <div className="mt-4 flex items-center justify-end">
        {saved && <span className="text-[11px] text-success">已保存</span>}
      </div>
    </div>
  )

  const dataTab = (
    <div>
      {/* 缩略图缓存：显示当前数量 / 占用，一键清空（清空后网格回退占位图，按需重建） */}
      <Row
        title="缩略图缓存"
        desc={
          thumbStat
            ? `当前缓存 ${thumbStat.count} 个文件 · 占用 ${formatBytes(thumbStat.bytes)}。清空后不影响任何素材文件，网格会在需要时自动重建。`
            : '正在统计…'
        }
      >
        <button className="btn !py-1 text-xs" onClick={() => void clearThumbs()} disabled={clearing || !thumbStat}>
          <IconRefresh />
          {clearing ? '清空中…' : '清除缓存'}
        </button>
      </Row>

      <Row
        title="导出索引快照"
        desc="把本地索引（资产名/分类/标签/备注，不含素材文件本体）导出为 JSON，用于备份或迁移。"
      >
        <button className="btn !py-1 text-xs" onClick={() => void exportIndex()}>
          导出…
        </button>
      </Row>

      {/* ── 诊断日志（2026-10）：崩溃取证 + 用户自助导出 ─────────────────
          拖出闪退这类进程级崩溃没有日志无法定位，所以这里把「日志在哪、多大、
          怎么导出」直接摆给用户；样式复用既有 Row / btn / Toggle，不新造颜色。 */}
      <div className="mt-4">
        <SectionTitle>诊断日志</SectionTitle>
        <Row
          title="日志文件"
          desc={
            logStat
              ? `${logStat.dir} · 共 ${logStat.count} 个文件 / ${formatBytes(logStat.bytes)}（自动保留最近 7 天）`
              : '正在读取日志目录…'
          }
        >
          <div className="flex items-center gap-2">
            <button
              className="btn !py-1 text-xs"
              disabled={!logStat}
              title="在文件管理器中打开日志目录"
              onClick={() => {
                if (logStat) void window.modvault.openPath(logStat.dir)
              }}
            >
              打开文件夹
            </button>
            <button
              className="btn !py-1 text-xs"
              disabled={logExporting || !logStat}
              onClick={() => void exportLogs()}
              title="把日志目录打包成 zip，便于发给开发者排查"
            >
              <IconRefresh />
              {logExporting ? '打包中…' : '导出日志…'}
            </button>
          </div>
        </Row>
        <Row
          title="记录详细日志"
          desc="开启后额外记录 debug 级信息（更啰嗦）。遇到问题时可临时打开，复现后关掉即可。"
        >
          <Toggle
            checked={settings.verboseLogging === true}
            onChange={(v) => {
              void saveSettings({ verboseLogging: v })
              flash()
            }}
          />
        </Row>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          日志只记录运行信息（版本、错误与崩溃堆栈、操作记录）和涉及的<b>文件路径</b>，不含素材内容和任何密钥；
          导出前会自动打成一个 zip，可在上面的「日志文件」处看到目录位置。
        </p>
      </div>

      {/* RA2：MAX_PATH 风险提示（只做指引，不改注册表） */}
      <Row
        title="Windows 路径长度提示"
        desc="资产名过长叠加深层分类目录（4 层 + 内部贴图子目录）可能触发 Windows 260 字符路径上限，表现为移动/打开失败。可启用系统长路径支持：组策略 gpedit.msc → 计算机配置 → 管理模板 → 系统 → 文件系统 →「启用 Win32 长路径」，或注册表 LongPathsEnabled=1。"
      />
    </div>
  )

  const advancedTab = (
    <div>
      <Row
        title="7-Zip（rar / 7z 解压）"
        desc={
          sevenZip
            ? '已探测到，rar/7z/zip 全格式支持。'
            : '未探测到。zip 可正常导入；rar/7z 需要安装 7-Zip 或在下方手动指定 7z.exe。'
        }
      >
        <div className="flex items-center gap-2">
          {sevenZip ? (
            <span className="chip-accent">
              <IconCheck />
              已就绪
            </span>
          ) : (
            <a
              className="text-[11px] text-accent-text underline underline-offset-2"
              href={SEVEN_ZIP_DOWNLOAD_URL}
              target="_blank"
              rel="noreferrer"
              title="打开 7-Zip 官方下载页"
            >
              下载 7-Zip ↗
            </a>
          )}
          <button
            className="btn !py-1 text-xs"
            onClick={async () => {
              const dir = await window.modvault.pickWatchDir()
              if (dir) {
                const guess = `${dir}\\7z.exe`
                await saveSettings({ sevenZipPath: guess })
                setSevenZip(guess)
                flash()
              }
            }}
          >
            指定 7z.exe
          </button>
        </div>
      </Row>
      <div className="mt-4 flex items-center justify-end">
        {saved && <span className="text-[11px] text-success">已保存</span>}
      </div>
    </div>
  )

  /**
   * 关于页「检查更新」的状态行文案（唯一来源，避免 JSX 里堆三元）。
   *
   * 优先级：检查中 > 有更新 > 失败 > 已是最新 > 尚未检查。
   * - 失败**不弹窗**，就这一行小字（用户要求"不打扰"；自动检查失败也一样）。
   * - `latest` 为空时退回"已是最新"（理论上不会发生：成功即有 tag_name）。
   */
  const updateStatusText = updateChecking
    ? '正在检查…'
    : updateInfo?.hasUpdate && updateInfo.latest
      ? `发现新版本 v${updateInfo.latest}`
      : updateInfo?.error
        ? '检查失败，可稍后重试'
        : updateInfo
          ? '已是最新版本'
          : ''

  /** 「去下载」：优先安装包直链（一键下载），没有就开 Release 页面 */
  const openUpdateDownload = () => {
    const target = updateInfo?.assetUrl || updateInfo?.url
    if (!target) return
    // 打开失败（系统无默认浏览器等）静默忽略：不下发 notice，用户可再点 Release 链接
    void window.modvault.openExternal(target).catch(() => undefined)
  }

  const aboutTab = (
    <div className="flex flex-col items-center pb-2">
      {/* §3.6：居中 Logo 56×56 r16 + "ID BOX" 22px + 版本号胶囊。
          C#15（已拍板按画布）：画布 `2:955` 实测 r16 → 走独立一档 --radius-logo-lg，
          与顶栏 Logo r6（--radius-logo）不同档，不能共用。
          2026-10 用户要求换图标：原来的内联立方体 svg 换成品牌徽标（与顶栏、应用图标同源）。 */}
      <img
        src={brandMark}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-14 w-14 rounded-logo-lg object-contain"
      />
      <div className="mt-3 text-[22px] font-semibold text-primary">ID BOX</div>
      <div className="mt-2 rounded-full bg-accent-tint px-3 py-1 text-[13px] font-semibold text-accent-text">
        v{version || '…'}
      </div>

      {/* ── 检查更新（2026-10 用户需求：「每一次运行都自动检测 GitHub Releases」）──────
          四态：检查中 / 有更新（→ 去下载）/ 已是最新 / 失败（一行小字，不弹窗）。
          颜色全部走既有 token（text-secondary / text-accent-text / accent 底），
          按钮复用 `.btn` / `.btn-primary` / `.btn-ghost`，开关复用下方 `Toggle`。 */}
      <div className="mt-3 flex min-h-[20px] items-center gap-2">
        <span
          className={`text-[11px] ${
            updateInfo?.hasUpdate && !updateChecking ? 'text-accent-text' : 'text-secondary'
          }`}
        >
          {updateStatusText}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        {updateInfo?.hasUpdate && (
          <button className="btn btn-primary !px-3 !py-1 text-[12px]" onClick={openUpdateDownload}>
            去下载
          </button>
        )}
        <button
          className="btn btn-ghost !px-2.5 !py-1 text-[12px] text-secondary disabled:opacity-50"
          disabled={updateChecking}
          onClick={() => void checkForUpdate({ force: true })}
          title="立即检查 GitHub 上是否有新版本"
        >
          {updateChecking && <IconRefresh className="animate-spin" />}
          {updateChecking ? '检查中…' : '立即检查'}
        </button>
      </div>

      {/* 自动检查开关：复用设置页既有 Toggle（用户明确要求不用原生 checkbox） */}
      <div className="mt-4 w-full max-w-[420px] rounded-theme-card border border-line bg-elevated/40 px-3">
        <Row title="启动时自动检查更新" desc="每次启动时查一次 GitHub Releases；断网或失败不会影响使用">
          <Toggle
            checked={settings.autoCheckUpdate !== false}
            onChange={(v) => void saveSettings({ autoCheckUpdate: v })}
          />
        </Row>
      </div>

      <div className="mt-4 text-[11px] text-muted">MIT License · 本地离线运行 · 数据不出设备</div>

      {/* ── 赞赏与反馈（2026-10 用户要求：「关于界面去把打赏和反馈给做上」）──────────
          布局：grid + auto-fit(224px)，容器够宽就是两列、窄了自动单列堆叠，
          不用视口断点（设置弹窗本身固定 760，断点判断的是窗口而不是容器，会失真）。
          等高：两卡同结构 + grid 默认 stretch，文案用 mt-auto 贴底，两列文字基线对齐。
          样式全部复用现有 token / 既有卡片写法（rounded-theme-card + bg-card + ring-line），
          不新造配色。 */}
      <div className="mt-5 grid w-full gap-3 [grid-template-columns:repeat(auto-fit,minmax(224px,1fr))]">
        <SupportCard
          icon={<IconHeart />}
          title="赞赏支持"
          qrSrc={donateQr}
          qrAlt="微信赞赏码"
          caption="这工具省了你的时间的话，可以请我喝杯咖啡。"
        />
        <SupportCard
          icon={<IconChat />}
          title="反馈建议"
          qrSrc={contactQr}
          qrAlt="微信加好友二维码"
          caption="用得别扭、想要什么功能，扫码直接跟我说。"
        />
      </div>
    </div>
  )

  // 强制重扫弹窗里的数字：未取到预览时用 0 兜底（该分支只在 preview 就绪时渲染）
  const forceGone = forcePreview?.gone ?? 0
  const forceTotal = forcePreview?.total ?? 0
  const forceFound = forcePreview?.found ?? 0

  const tabTitle: Record<SettingsTab, string> = {
    appearance: '外观',
    import: '导入',
    library: '库与分类',
    alias: '别名',
    data: '数据与备份',
    advanced: '高级',
    about: '关于'
  }

  return (
    <div className="dialog-scrim fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
      {/* 走查 v0.2.2 B4 拍板：弹窗圆角分组件 —— 设置弹窗 16（画布 2:479/2:541），
          渲染弹窗 12（画布 2:242）；深色四屏一致 14（2:842/2:879/2:935/2:1024），由 --radius-modal-settings 的深色覆盖承担。 */}
      <div
        className="flex h-[560px] w-[760px] overflow-hidden rounded-modal-settings border border-panel-line bg-card shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左 tab 栏：宽 172，--bg-sidebar 底，左下角小字版本号（§3.6） */}
        <div className="flex w-[172px] shrink-0 flex-col bg-sidebar p-3">
          <div className="px-2 pb-2 text-[16px] font-semibold text-primary">设置</div>
          <nav className="flex flex-col gap-0.5">
            {TABS.map((t) => {
              const active = tab === t.key
              // C#12（已拍板单立一档 8，两主题同值）：tab 项不能复用 --radius-nav
              // （浅 9 / 深 7），走独立 --radius-tab。
              return (
                <button
                  key={t.key}
                  className={`flex h-8 items-center rounded-tab px-2.5 text-[13px] transition ${
                    active ? 'bg-accent-tint font-medium text-accent-text' : 'text-secondary hover:bg-elevated/60'
                  }`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              )
            })}
          </nav>
          <div className="mt-auto px-2 text-[10px] text-muted">{version ? `v${version}` : ''}</div>
        </div>

        {/* 右内容区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
            <h2 className="text-[16px] font-semibold text-primary">{tabTitle[tab]}</h2>
            <button className="btn btn-ghost !p-1.5" onClick={onClose} title="关闭">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* 内容区：外层 relative 只是为了给底部渐隐条做定位锚（见 tabHasMore 的注释） */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={tabScrollRef}
              onScroll={syncTabOverflow}
              className="flex-1 overflow-auto px-5 py-4"
            >
              <div>
                {tab === 'appearance' && appearanceTab}
                {tab === 'import' && importTab}
                {tab === 'library' && libraryTab}
                {tab === 'alias' && <AliasTab />}
                {tab === 'data' && dataTab}
                {tab === 'advanced' && advancedTab}
                {tab === 'about' && aboutTab}
              </div>
            </div>
            {tabHasMore && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-card to-transparent"
              />
            )}
          </div>
        </div>
      </div>

      {/* 强制重扫确认弹窗：数字必须真实、后果必须写清、必须显式勾选 */}
      {forceOpen && (
        <Modal title="强制重扫（允许清空索引）" onClose={() => !forceBusy && setForceOpen(false)} width="max-w-md">
          {forceBusy || (!forcePreview && !forceError) ? (
            <p className="text-[13px] leading-relaxed text-muted">正在检查磁盘与索引的差异…</p>
          ) : forceError ? (
            <>
              <p className="text-[13px] leading-relaxed text-danger">{forceError}</p>
              <div className="mt-4 flex justify-end">
                <button className="btn" onClick={() => setForceOpen(false)}>
                  关闭
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed">
                {forceGone > 0 ? (
                  <>
                    本次将删除索引中{' '}
                    <span className="font-semibold text-danger">{forceGone}</span> 个在磁盘上
                    找不到的资产（当前索引 {forceTotal} 个，磁盘上找到 {forceFound} 个）。
                  </>
                ) : (
                  <>
                    当前索引 {forceTotal} 个资产在磁盘上都能找到，强制重扫<b>不会删除任何记录</b>。
                  </>
                )}
              </p>
              {forceGone > 0 ? (
                <p className="mt-2 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] leading-relaxed text-danger">
                  被删除资产中的<b>标签、备注、风格会丢失</b>——这些数据只存在于索引里，磁盘上没有副本。
                </p>
              ) : (
                <p className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-muted">
                  索引与磁盘当前一致，本次不会删除任何记录（重扫只是重建索引）。
                </p>
              )}
              <p className="mt-2 text-[12px] leading-relaxed text-muted">
                删除前会自动写入一份完整备份；确认后仍可用「恢复上次重扫前索引」救回（磁盘文件需你自己放回原位）。
              </p>
              <label className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={forceAck}
                  onChange={(e) => setForceAck(e.target.checked)}
                />
                <span>
                  {forceGone > 0
                    ? '我已了解标签 / 备注 / 风格会丢失，仍要强制重扫'
                    : '我已了解，确认强制重扫'}
                </span>
              </label>
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn" onClick={() => setForceOpen(false)}>
                  取消
                </button>
                <button
                  className="btn btn-outline-danger"
                  disabled={!forceAck}
                  onClick={async () => {
                    setForceBusy(true)
                    try {
                      const r = await forceRescanAction()
                      setForceRemoved(r.removed)
                      setForceOpen(false)
                    } catch {
                      // 失败不静默：留在弹窗里说明原因（索引可能未被改动）
                      setForceError('强制重扫失败：库目录不可读或写入被拒绝，索引未清空。')
                    } finally {
                      setForceBusy(false)
                      void refreshRescanBackupCount()
                    }
                  }}
                >
                  {forceGone > 0 ? `确认删除 ${forceGone} 个并重扫` : '确认重扫'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* v0.4 一致性报告弹窗：默认全部不勾（只读检查 → 用户显式选择才修） */}
      {report && (
        <Modal
          title="库一致性报告"
          onClose={() => {
            if (!applyBusy) setReport(null)
          }}
          width="max-w-2xl"
        >
          <div className="text-[12px] text-secondary">
            扫描到 <span className="font-semibold text-primary">{report.scannedCount}</span> 项 ·
            索引 <span className="font-semibold text-primary">{report.indexCount}</span> 项
          </div>

          {isReconcileClean(report) ? (
            <p className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-secondary">
              索引与磁盘一致，没有发现问题。
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1 text-[12px] leading-relaxed text-secondary">
                <li>
                  磁盘上找不到{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['missing-on-disk']}
                  </span>{' '}
                  项
                </li>
                <li>
                  未索引{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['not-in-index']}
                  </span>{' '}
                  项
                </li>
                <li>
                  分类不一致{' '}
                  <span className="font-semibold text-primary">
                    {report.counts['category-mismatch']}
                  </span>{' '}
                  项
                </li>
              </ul>

              {/* 明细最多 20 条（超出只报数量，避免弹窗无限长） */}
              <div className="mt-3 max-h-60 overflow-auto rounded-lg border border-line bg-canvas">
                {report.items.slice(0, 20).map((item) => (
                  <div
                    key={`${item.kind}:${item.folder}`}
                    className="border-b border-line/60 px-3 py-2 last:border-0"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className="min-w-0 truncate text-[12px] font-medium text-primary"
                        title={item.folder}
                      >
                        {item.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">{DIFF_LABEL[item.kind]}</span>
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-muted"
                      title={relDirOf(item.folder)}
                    >
                      {relDirOf(item.folder)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-secondary">{reasonOf(item)}</div>
                  </div>
                ))}
                {report.items.length > 20 && (
                  <div className="px-3 py-2 text-[11px] text-muted">
                    还有 {report.items.length - 20} 条…
                  </div>
                )}
              </div>

              {/* 三个复选框默认全 false：勾选后才会修改 */}
              <div className="mt-3 space-y-1.5">
                <p className="text-[11px] text-tertiary">勾选后才会修改（默认全部不勾）：</p>
                <label className="flex items-center gap-2 text-[12px] text-secondary">
                  <input
                    type="checkbox"
                    checked={pickMissing}
                    disabled={report.counts['missing-on-disk'] === 0}
                    onChange={(e) => setPickMissing(e.target.checked)}
                  />
                  移除索引中磁盘已不存在的 {report.counts['missing-on-disk']} 项
                </label>
                <label className="flex items-center gap-2 text-[12px] text-secondary">
                  <input
                    type="checkbox"
                    checked={pickNotIndexed}
                    disabled={report.counts['not-in-index'] === 0}
                    onChange={(e) => setPickNotIndexed(e.target.checked)}
                  />
                  把磁盘上已有的 {report.counts['not-in-index']} 项补入索引
                </label>
                <label className="flex items-center gap-2 text-[12px] text-secondary">
                  <input
                    type="checkbox"
                    checked={pickMismatch}
                    disabled={report.counts['category-mismatch'] === 0}
                    onChange={(e) => setPickMismatch(e.target.checked)}
                  />
                  按磁盘目录名修正 {report.counts['category-mismatch']} 项分类
                </label>
                <p className="text-[10px] leading-relaxed text-muted">
                  移除索引前会自动备份被删记录（可从「恢复上次重扫前索引」找回），素材文件本身不会被删除。
                </p>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button className="btn" disabled={applyBusy} onClick={() => setReport(null)}>
                  取消
                </button>
                <button
                  className="btn btn-primary"
                  disabled={applyBusy || pickedCount === 0}
                  title={pickedCount === 0 ? '请先勾选要执行的修复类别' : '执行所选修复'}
                  onClick={() => void runRepair()}
                >
                  {applyBusy ? '修复中…' : '执行所选修复'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* 迁移确认弹窗：数字必须写清楚 */}
      {migOpen && (
        <Modal title="确认迁移旧版目录" onClose={() => !migBusy && setMigOpen(false)} width="max-w-md">
          <p className="text-[13px] leading-relaxed">
            将把 <span className="font-semibold text-danger">{legacyLayoutCount}</span>{' '}
            个资产目录从「大类/资产名」搬到「大类/未分类/未分类/资产名」。
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            这是批量搬动磁盘真实文件的操作（可能涉及 GB 级素材），过程中请不要关闭应用或手动改动库目录。
            目标位置已有同名目录时自动追加序号，永不覆盖；索引中的标签与备注会保留。
          </p>
          {migResult ? (
            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
              迁移完成：成功 <span className="font-semibold text-success">{migResult.moved}</span> 个
              {migResult.failed > 0 && (
                <>
                  ，失败 <span className="font-semibold text-danger">{migResult.failed}</span> 个
                </>
              )}
              。
            </div>
          ) : (
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setMigOpen(false)} disabled={migBusy}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={migBusy}
                onClick={async () => {
                  setMigBusy(true)
                  const r = await migrateLegacyLayout().catch(() => ({ moved: 0, failed: -1 }))
                  setMigBusy(false)
                  setMigResult(r)
                  flash()
                }}
              >
                {migBusy ? '迁移中…' : `开始迁移（${legacyLayoutCount} 个）`}
              </button>
            </div>
          )}
          {migResult && (
            <div className="mt-3 flex justify-end">
              <button className="btn" onClick={() => setMigOpen(false)}>
                关闭
              </button>
            </div>
          )}
        </Modal>
      )}

      {/* v1.0.13 重跑自动分类确认弹窗：数字写清楚（会真实搬目录） */}
      {reclassOpen && (
        <Modal
          title="确认重跑自动分类"
          onClose={() => {
            if (!reclassifyBusy) setReclassOpen(false)
          }}
          width="max-w-md"
        >
          <p className="text-[13px] leading-relaxed">
            将处理{' '}
            <span className="font-semibold text-danger">{unclassifiedCount}</span> 个
            「未分类/未分类」的资产：
            <span className="text-secondary">
              按当前词表重新判定，命中的会<b>真实移动目录</b>到对应分类（已分类的资产不受影响）。
            </span>
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            移动前会自动写一份备份（只保留最近 3 份），跑完后可在设置页点「撤销上次重跑」按原分类搬回。
            过程中请不要关闭应用或手动改动库目录。
          </p>
          {reclassResult ? (
            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px]">
              重跑完成：移动{' '}
              <span className="font-semibold text-success">{reclassResult.moved}</span> 个，未识别{' '}
              <span className="font-semibold">{reclassResult.missed}</span> 个
              {reclassResult.failed > 0 && (
                <>
                  ，失败 <span className="font-semibold text-danger">{reclassResult.failed}</span> 个
                </>
              )}
              。
            </div>
          ) : (
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setReclassOpen(false)} disabled={reclassifyBusy}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={reclassifyBusy || unclassifiedCount === 0}
                onClick={async () => {
                  const r = await reclassifyUnclassified()
                  setReclassResult(r)
                  void refreshReclassBackupCount()
                  flash()
                }}
              >
                {reclassifyBusy ? '处理中…' : `开始重跑（${unclassifiedCount} 个）`}
              </button>
            </div>
          )}
          {reclassResult && (
            <div className="mt-3 flex justify-end">
              <button className="btn" onClick={() => setReclassOpen(false)}>
                关闭
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
