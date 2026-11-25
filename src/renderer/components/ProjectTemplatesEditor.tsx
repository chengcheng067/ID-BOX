/**
 * 设置 · 项目文件夹模板编辑器（docs/60 §3，T-02）。
 *
 * ## 交互分层
 *
 * - **模板级**：chip 列表（内置排首位带「内置」角标）+ 新建（空白）/ 复制（含内置）/
 *   删除（builtin 禁删，灰置 + 单行提示）/ 改名（40 码点）/ 恢复出厂（只重置 builtin）。
 * - **节点级**：选中一棵树后 4 级树编辑 —— 增子级（深度 4 / 节点 256 到限时按钮灰置 +
 *   原因提示，不静默丢数据）、删节点（连带子树，二次确认）、改名（兄弟重名自动去重并反馈）。
 * - **草稿态**：所有编辑先落本地草稿（`draft !== null` = 有未保存改动），点「保存」时
 *   整表过 `finalizeTemplates`（→ `normalizeProjectTemplate` 收口）再走**既有**
 *   `saveSettings({ projectTemplates })` 链路，不新增 IPC。
 * - **拖入识别**（v1.2 反馈批 C）：把资源管理器里的文件夹拖到本卡 →
 *   `template:scanFromDir` **只读**扫描 → 弹预览确认层（树预览 + 丢弃统计 +
 *   模板名输入）→ 用户点「生成模板」才写入草稿；取消 / Esc 整体丢弃，绝不静默写入。
 *   drop 处 `stopPropagation` 拦住窗口级导入 drop（设置页拖入文件夹 ≠ 导入素材）。
 *
 * ## 项目红线对照
 *
 * - 零系统默认控件：只用项目自有 `btn` / `input` / `badge` 与 `Modal` 外壳；
 * - Esc：确认弹窗走 `Modal`（内部占 `useEscLayer` 层栈），行内改名输入框走
 *   `data-esc-own`（AliasRow 同款：Esc 只回滚草稿，不关弹窗）；
 * - 用户可见文案单行、不暴露内部词（`normalizeProjectTemplate` / id 等一律不出现在 UI）；
 * - 删除必确认：删模板 / 删节点（连带子树）/ 恢复出厂都弹确认层。
 */
import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { useVault } from '../store'
import { Modal } from './Modal'
import { hasAssetDragPayload } from '../logic/dragAssign'
import {
  BUILTIN_TEMPLATE_ID,
  BUILTIN_TEMPLATE_NAME,
  CODE_PLACEHOLDER,
  MAX_TEMPLATE_COUNT,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES,
  NAME_PLACEHOLDER,
  countTemplateNodes,
  templateDepth
} from '../../shared/projectTemplate'
import type { ProjectTemplate, ProjectTemplateNode } from '../../shared/types'
import {
  addChildNodeAt,
  addBlankTemplate,
  canAddChildAt,
  copyTemplateInList,
  finalizeTemplates,
  findNodeAt,
  removeNodeAtPath,
  removeTemplateById,
  renameNodeAtPath,
  renameTemplateInList,
  restoreBuiltinTemplate,
  sortTemplatesBuiltinFirst
} from '../logic/projectTemplatesEditor'

/** 二次确认的种类（三种都走同一张 Modal 外壳） */
type ConfirmState =
  | { kind: 'delete-template'; id: string; name: string; nodes: number }
  | { kind: 'delete-node'; path: number[]; name: string; subCount: number }
  | { kind: 'restore-builtin'; name: string }

/** 拖入扫描的预览确认态（用户点「生成模板」才写入草稿；取消 / Esc 整体丢弃） */
interface ScanPreview {
  root: ProjectTemplateNode
  truncated: { depth: number; nodes: number }
  scannedDirs: number
  /** 模板名输入框草稿（默认 = 扫描出的根目录名，已清洗） */
  nameDraft: string
}

/** 行内改名草稿（模板 chip 与树节点共用一个"同一时刻只编辑一处"的状态） */
interface RenameEdit {
  draft: string
}

/** 限额判定的回传形状（`logic/projectTemplatesEditor.canAddChildAt`） */
interface CanAdd {
  ok: boolean
  reason?: 'depth' | 'nodes' | 'missing' | 'root'
}

/**
 * 一行树节点的可点行（递归渲染）。
 *
 * 缩进用 `paddingLeft = depth * 14` 的平铺行（不嵌套容器）：树 ≤256 节点，
 * 平铺让"增删节点只改一处 state"这件事与 DOM 结构零耦合。
 * 限额（深度 4 / 节点 256）由 `canAddAt(path)` 按本行路径**逐行**判定。
 */
function TemplateNodeRow(props: {
  node: ProjectTemplateNode
  path: number[]
  isRoot: boolean
  /** 行内改名草稿；`path` 命中本行 = 本行在编辑 */
  edit: (RenameEdit & { path: number[] }) | null
  canAddAt: (path: number[]) => CanAdd
  onStartEdit: (path: number[]) => void
  onEditChange: (draft: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onAdd: (path: number[]) => void
  onRemove: (path: number[]) => void
}): ReactElement {
  const {
    node,
    path,
    isRoot,
    edit,
    canAddAt,
    onStartEdit,
    onEditChange,
    onCommitEdit,
    onCancelEdit,
    onAdd,
    onRemove
  } = props
  const canAdd = canAddAt(path)
  const editing = edit !== null && edit.path.length === path.length && edit.path.every((v, i) => v === path[i])
  const depth = path.length + 1
  const addTitle = !canAdd.ok
    ? canAdd.reason === 'depth'
      ? `已到 ${MAX_TEMPLATE_DEPTH} 级深度上限，不能再加子级`
      : canAdd.reason === 'nodes'
        ? `已到 ${MAX_TEMPLATE_NODES} 个节点上限，不能再新增`
        : undefined
    : `在这条下面加一个子级（第 ${depth + 1} 级）`
  return (
    <>
      <div
        className="flex items-center gap-1 py-0.5"
        style={{ paddingLeft: isRoot ? 0 : depth * 14 }}
      >
        {/* 名字：点击进入行内改名；根名可含占位符字面量，原样展示 */}
        {editing && edit ? (
          <input
            className="input h-6 min-w-0 max-w-[240px] flex-1 !py-0 text-xs"
            value={edit.draft}
            autoFocus
            spellCheck={false}
            title={isRoot ? '根目录名：可用 {编号} {名称} 占位符，新建项目时自动替换' : '目录名：40 字以内，非法字符自动替换'}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              // Esc 只回滚本行草稿、不关弹窗（AliasRow 同款：data-esc-own + 按死在本地）
              if (e.key === 'Escape') {
                e.stopPropagation()
                onCancelEdit()
              }
            }}
            data-esc-own
            onBlur={onCommitEdit}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 max-w-[320px] truncate rounded px-1 py-0.5 text-left text-[12px] text-primary transition hover:bg-elevated"
            title={`${node.name}（点击改名）`}
            onClick={() => onStartEdit(path)}
          >
            {isRoot && <span className="mr-1 text-[10.5px] text-muted">根</span>}
            {node.name}
          </button>
        )}
        <span className="shrink-0 text-[10px] text-muted">
          {node.children ? `${node.children.length} 子级` : ''}
        </span>
        <button
          type="button"
          className="h-5 w-5 shrink-0 rounded text-[13px] leading-none text-muted transition hover:bg-elevated hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
          disabled={!canAdd.ok}
          title={addTitle}
          aria-label={`在 ${node.name} 下新增子级`}
          onClick={() => onAdd(path)}
        >
          ＋
        </button>
        {!isRoot && (
          <button
            type="button"
            className="h-5 w-5 shrink-0 rounded text-[13px] leading-none text-muted transition hover:bg-elevated hover:text-danger"
            title={`删除 ${node.name}${node.children ? `（连同 ${countTemplateNodes(node) - 1} 个子级）` : ''}`}
            aria-label={`删除 ${node.name}`}
            onClick={() => onRemove(path)}
          >
            ×
          </button>
        )}
      </div>
      {(node.children ?? []).map((child, i) => (
        <TemplateNodeRow
          key={`${path.join('-')}-${i}`}
          node={child}
          path={[...path, i]}
          isRoot={false}
          edit={edit}
          canAddAt={canAddAt}
          onStartEdit={onStartEdit}
          onEditChange={onEditChange}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      ))}
    </>
  )
}

/**
 * 预览确认层里的只读树行（与编辑器同款平铺缩进，但零交互 —— 只展示扫描结果）。
 */
function PreviewNodeRow(props: { node: ProjectTemplateNode; depth: number }): ReactElement {
  const { node, depth } = props
  return (
    <>
      <div className="flex items-center py-0.5" style={{ paddingLeft: depth === 1 ? 0 : depth * 14 }}>
        <span className="truncate text-[12px] text-primary" title={node.name}>
          {depth === 1 && <span className="mr-1 text-[10.5px] text-muted">根</span>}
          {node.name}
        </span>
        {node.children && (
          <span className="ml-1.5 shrink-0 text-[10px] text-muted">{node.children.length} 子级</span>
        )}
      </div>
      {(node.children ?? []).map((child, i) => (
        <PreviewNodeRow key={`${depth}-${i}`} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

/**
 * 模板管理编辑器主体（挂在设置 · 库 tab 的「项目文件夹模板」卡里）。
 *
 * 自带 store 订阅与保存（AliasTab 同款自包含写法），SettingsDialog 只挂载不传 props。
 */
export function ProjectTemplatesEditor() {
  const templates = useVault((s) => s.settings?.projectTemplates)
  const saveSettings = useVault((s) => s.saveSettings)

  /** 本地草稿；`null` = 无改动（展示 store 里的已保存值） */
  const [draft, setDraft] = useState<ProjectTemplate[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>(BUILTIN_TEMPLATE_ID)
  const [hint, setHint] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [saving, setSaving] = useState(false)
  /** 模板 chip 行内改名（`null` = 未在改名） */
  const [tplRename, setTplRename] = useState<(RenameEdit & { id: string }) | null>(null)
  /** 树节点行内改名（同一时刻只编辑一处） */
  const [nodeEdit, setNodeEdit] = useState<(RenameEdit & { path: number[] }) | null>(null)
  /** 模板改名输入框的焦点回写标记（Esc 回滚后不触发 commit，AliasRow 同款） */
  const revertTplRef = useRef(false)
  // ── 拖入文件夹自动识别（v1.2 反馈批 C） ────────────────────────────────
  /** 外部文件夹悬停在本卡上（显示「松开以生成模板」遮罩） */
  const [dropActive, setDropActive] = useState(false)
  /** dragenter/leave 配对计数（跨子元素抖动不闪烁） */
  const dragDepthRef = useRef(0)
  /** 正在扫描（防重复 drop + 扫描中不给确认入口） */
  const [scanning, setScanning] = useState(false)
  /** 扫描失败的单行错误（就地展示，不打断编辑器其余操作） */
  const [scanError, setScanError] = useState<string | null>(null)
  /** 扫描结果的预览确认态；`null` = 无预览（取消 / Esc / 已生成） */
  const [preview, setPreview] = useState<ScanPreview | null>(null)

  const savedList = sortTemplatesBuiltinFirst(templates ?? [])
  const list = draft ?? savedList
  const selected = list.find((t) => t.id === selectedId) ?? list[0]
  const dirty = draft !== null

  /**
   * store 里的模板内容一变（保存成功回写 / 打包导入覆盖），草稿作废回到已保存值。
   * 只盯 `projectTemplates` 的内容（JSON 序列化做键），别的设置键写入不会误清草稿。
   */
  const savedKey = JSON.stringify(templates ?? [])
  useEffect(() => {
    setDraft(null)
  }, [savedKey])

  if (!selected) {
    // 理论不可达（归一化兜底至少 1 个模板），防御一下避免 .root 解引用崩
    return <div className="py-2 text-[12px] text-muted">暂无模板。</div>
  }

  const root = selected.root
  const depth = templateDepth(root)
  const nodes = countTemplateNodes(root)
  const atCountLimit = list.length >= MAX_TEMPLATE_COUNT
  const fullBase = (): ProjectTemplate[] => draft ?? savedList

  /** 用新树替换选中模板的根（自动进入草稿态） */
  const applyRoot = (nextRoot: ProjectTemplateNode): void => {
    const base = fullBase()
    setDraft(base.map((t) => (t.id === selected.id ? { ...t, root: nextRoot } : t)))
  }

  // ── 模板级操作 ────────────────────────────────────────────────────────────

  const handleAddBlank = (): void => {
    const r = addBlankTemplate(fullBase())
    if (!r.ok || !r.list || !r.newId) {
      setHint(r.error ?? null)
      return
    }
    setDraft(r.list)
    setSelectedId(r.newId)
    setHint('已新建空白模板，记得点「保存」写入')
  }

  const handleCopy = (): void => {
    const r = copyTemplateInList(fullBase(), selected.id)
    if (!r.ok || !r.list || !r.newId) {
      setHint(r.error ?? null)
      return
    }
    setDraft(r.list)
    setSelectedId(r.newId)
    setHint(`已复制为「${r.list.find((t) => t.id === r.newId)?.name ?? ''}」，记得点「保存」写入`)
  }

  const confirmDeleteTemplate = (): void => {
    setConfirm({
      kind: 'delete-template',
      id: selected.id,
      name: selected.name,
      nodes
    })
  }

  const confirmRestoreBuiltin = (): void => {
    setConfirm({ kind: 'restore-builtin', name: selected.name })
  }

  const startTplRename = (): void => {
    revertTplRef.current = false
    setTplRename({ id: selected.id, draft: selected.name })
  }

  const commitTplRename = (): void => {
    if (revertTplRef.current) {
      revertTplRef.current = false
      setTplRename(null)
      return
    }
    if (!tplRename) return
    const { id, draft: raw } = tplRename
    setTplRename(null)
    const current = fullBase().find((t) => t.id === id)
    if (!current || raw === current.name) return
    const r = renameTemplateInList(fullBase(), id, raw)
    if (!r.ok || !r.list) {
      setHint(r.error ?? null)
      return
    }
    setDraft(r.list)
    if (r.applied && r.applied !== raw) setHint(`模板名已按规则调整为「${r.applied}」`)
  }

  // ── 节点级操作 ────────────────────────────────────────────────────────────

  const handleAddChild = (path: number[]): void => {
    const r = addChildNodeAt(root, path)
    if (!r.ok || !r.root) {
      if (r.reason === 'depth') setHint(`已到 ${MAX_TEMPLATE_DEPTH} 级深度上限，不能再加子级`)
      else if (r.reason === 'nodes') setHint(`已到 ${MAX_TEMPLATE_NODES} 个节点上限，请先删减`)
      return
    }
    applyRoot(r.root)
    setNodeEdit(null)
    if (r.applied && r.applied !== '新建文件夹') {
      setHint(`与同级重名，已自动改为「${r.applied}」`)
    } else {
      setHint(null)
    }
  }

  const handleRemoveNode = (path: number[]): void => {
    const target = findNodeAt(root, path)
    if (!target || path.length === 0) return
    setConfirm({
      kind: 'delete-node',
      path,
      name: target.name,
      subCount: countTemplateNodes(target) - 1
    })
  }

  const commitNodeRename = (): void => {
    if (!nodeEdit) return
    const { path, draft: raw } = nodeEdit
    setNodeEdit(null)
    const current = findNodeAt(root, path)
    if (!current || raw === current.name) return
    const r = renameNodeAtPath(root, path, raw)
    if (!r.ok || !r.root) return
    applyRoot(r.root)
    if (r.applied && r.applied !== raw) {
      setHint(`重名或非法字符已自动调整为「${r.applied}」`)
    } else {
      setHint(null)
    }
  }

  // ── 保存 / 放弃 ───────────────────────────────────────────────────────────

  const handleSave = async (): Promise<void> => {
    if (!draft || saving) return
    setSaving(true)
    try {
      const next = finalizeTemplates(draft)
      await saveSettings({ projectTemplates: next })
      setDraft(null)
      setNodeEdit(null)
      setTplRename(null)
      setHint(`已保存 ${next.length} 个模板`)
    } catch (err) {
      setHint(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = (): void => {
    setDraft(null)
    setNodeEdit(null)
    setTplRename(null)
    setHint(null)
  }

  // ── 拖入文件夹自动识别（扫描 → 预览确认 → 生成草稿；绝不静默写入） ────────

  /** 应用内归类拖拽（抓手）不接管：那是资产归类手势，与拖入文件夹无关 */
  const isAssignDrag = (e: DragEvent<HTMLDivElement>): boolean =>
    hasAssetDragPayload(e.dataTransfer?.types)

  const handleDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (isAssignDrag(e)) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDropActive(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (isAssignDrag(e)) return
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setDropActive(false)
    }
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (isAssignDrag(e)) return
    // 必须 preventDefault，drop 事件才会落到本卡（App 的窗口级 dragover 也会兜）
    e.preventDefault()
    setDropActive(true)
  }

  /**
   * drop：取首个文件 → `getPathForFile` 拿绝对路径 → 主进程只读扫描 → 弹预览确认层。
   * `stopPropagation` 拦住冒泡到 window 的导入 drop（设置页拖入文件夹 ≠ 导入素材）。
   */
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setDropActive(false)
    if (isAssignDrag(e)) return
    if (scanning || preview) return
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    void startScan(file)
  }

  const startScan = async (file: File): Promise<void> => {
    setScanError(null)
    setScanning(true)
    try {
      const dirPath = window.modvault.getPathForFile(file)
      if (!dirPath) {
        setScanError('拿不到文件夹路径，请重新拖入')
        return
      }
      const r = await window.modvault.templateScanFromDir({ dirPath })
      if (!r.ok) {
        setScanError(r.error)
        return
      }
      setPreview({
        root: r.root,
        truncated: r.truncated,
        scannedDirs: r.scannedDirs,
        nameDraft: r.root.name
      })
    } catch {
      setScanError('扫描文件夹失败，请重试')
    } finally {
      setScanning(false)
    }
  }

  /** 「生成模板」：追加到草稿列表（模板名清洗与新建同口径），绝不动磁盘 */
  const confirmPreview = (): void => {
    if (!preview) return
    const { root, nameDraft } = preview
    const r = addBlankTemplate(fullBase())
    if (!r.ok || !r.list || !r.newId) {
      setHint(r.error ?? '模板已达上限，请先删除不用的模板')
      setPreview(null)
      return
    }
    // 先落根树再改名（renameTemplateInList 走 sanitizeName + 40 码点，与手动改名同口径）
    const withRoot = r.list.map((t) => (t.id === r.newId ? { ...t, root } : t))
    const rr = renameTemplateInList(withRoot, r.newId, nameDraft)
    const finalList = rr.ok && rr.list ? rr.list : withRoot
    setDraft(finalList)
    setSelectedId(r.newId)
    setNodeEdit(null)
    setPreview(null)
    const appliedName = finalList.find((t) => t.id === r.newId)?.name ?? ''
    setHint(`已从「${root.name}」生成模板「${appliedName}」，记得点「保存」写入`)
  }

  // ── 确认弹窗的执行分支 ─────────────────────────────────────────────────────

  const runConfirmed = (): void => {
    if (!confirm) return
    if (confirm.kind === 'delete-template') {
      const r = removeTemplateById(fullBase(), confirm.id)
      if (!r.ok || !r.list) {
        setHint(r.error ?? null)
      } else {
        setDraft(r.list)
        setHint(`已删除「${confirm.name}」，记得点「保存」写入`)
      }
    } else if (confirm.kind === 'delete-node') {
      const r = removeNodeAtPath(root, confirm.path)
      if (r.ok && r.root) {
        applyRoot(r.root)
        setNodeEdit(null)
        setHint(
          confirm.subCount > 0
            ? `已删除「${confirm.name}」及其 ${confirm.subCount} 个子级，记得点「保存」写入`
            : `已删除「${confirm.name}」，记得点「保存」写入`
        )
      }
    } else {
      const r = restoreBuiltinTemplate(fullBase())
      if (r.ok && r.list) {
        setDraft(r.list)
        setHint(`「${BUILTIN_TEMPLATE_NAME}」已恢复为出厂内容，记得点「保存」写入`)
      }
    }
    setConfirm(null)
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="relative py-2"
      data-template-drop-zone
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 拖入悬停遮罩（pointer-events-none：不挡 drop 落点） */}
      {dropActive && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-btn border-2 border-dashed border-accent bg-accent-tint/60"
          data-drop-overlay
        >
          <span className="text-[12px] font-medium text-accent-text">
            {scanning ? '正在识别文件夹…' : '松开以从该文件夹生成模板'}
          </span>
        </div>
      )}

      {/* 反馈行：单行、可截断、悬停看全文（不暴露内部词） */}
      {hint && (
        <div className="mb-2 truncate text-[11px] text-secondary" title={hint}>
          {hint}
        </div>
      )}
      {/* 拖入扫描失败的单行错误（不打断编辑器其余操作） */}
      {scanError && (
        <div className="mb-2 truncate text-[11px] text-danger" role="alert" title={scanError}>
          {scanError}
        </div>
      )}

      {/* ── 模板 chip 列表 ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {list.map((t) => {
          const active = t.id === selected.id
          const renaming = tplRename?.id === t.id
          if (renaming && tplRename) {
            return (
              <input
                key={t.id}
                className="input h-7 w-40 !py-0.5 text-xs"
                value={tplRename.draft}
                autoFocus
                spellCheck={false}
                title="模板名：40 字以内，非法字符自动替换"
                onChange={(e) => setTplRename({ ...tplRename, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    revertTplRef.current = true
                    e.stopPropagation()
                    e.currentTarget.blur()
                  }
                }}
                data-esc-own
                onBlur={commitTplRename}
              />
            )
          }
          return (
            <button
              key={t.id}
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition ${
                active
                  ? 'border-accent bg-accent-tint font-medium text-accent-text'
                  : 'border-panel-line bg-card text-secondary hover:border-line hover:text-primary'
              }`}
              title={`${t.name}（${countTemplateNodes(t.root)} 个节点）`}
              onClick={() => {
                setSelectedId(t.id)
                setNodeEdit(null)
              }}
              onDoubleClick={startTplRename}
            >
              <span className="max-w-[140px] truncate">{t.name}</span>
              {t.id === BUILTIN_TEMPLATE_ID && (
                <span className="badge shrink-0" title="随软件自带的出厂模板">
                  内置
                </span>
              )}
            </button>
          )
        })}
        <button
          type="button"
          className="btn !px-2.5 !py-1 text-xs"
          disabled={atCountLimit}
          title={atCountLimit ? `模板已达上限 ${MAX_TEMPLATE_COUNT} 个，请先删除不用的模板` : '新建一个空白模板'}
          onClick={handleAddBlank}
        >
          ＋ 新建模板
        </button>
      </div>

      {/* builtin 禁删的单行提示（灰置按钮的 title 同口径） */}
      {selected.id === BUILTIN_TEMPLATE_ID && (
        <p className="mt-1.5 text-[11px] text-muted">
          内置模板不可删除，可直接修改内容；想保留原版可先「复制」一份再改。
        </p>
      )}

      {/* ── 选中模板的操作行 ───────────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn !py-1 text-xs"
          disabled={atCountLimit}
          title={atCountLimit ? `模板已达上限 ${MAX_TEMPLATE_COUNT} 个` : `复制「${selected.name}」为新模板`}
          onClick={handleCopy}
        >
          复制
        </button>
        <button
          type="button"
          className="btn !py-1 text-xs"
          title={`改名「${selected.name}」（40 字以内）`}
          onClick={startTplRename}
        >
          改名
        </button>
        <button
          type="button"
          className="btn !py-1 text-xs"
          disabled={selected.id === BUILTIN_TEMPLATE_ID || list.length <= 1}
          title={
            selected.id === BUILTIN_TEMPLATE_ID
              ? '内置模板不能删除'
              : list.length <= 1
                ? '至少保留一个模板'
                : `删除「${selected.name}」`
          }
          onClick={confirmDeleteTemplate}
        >
          删除
        </button>
        {selected.id === BUILTIN_TEMPLATE_ID && (
          <button
            type="button"
            className="btn !py-1 text-xs"
            title={`把「${BUILTIN_TEMPLATE_NAME}」恢复为出厂内容（不影响其他模板）`}
            onClick={confirmRestoreBuiltin}
          >
            恢复出厂内容
          </button>
        )}
        {dirty && (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-secondary">有未保存的改动</span>
            <button
              type="button"
              className="btn btn-primary !px-3 !py-1 text-xs"
              disabled={saving}
              onClick={() => void handleSave()}
              title="保存所有模板改动（非法字符与重名会自动调整）"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn !py-1 text-xs"
              disabled={saving}
              onClick={handleDiscard}
              title="放弃本次未保存的改动"
            >
              放弃
            </button>
          </span>
        )}
      </div>

      {/* ── 树编辑器 ───────────────────────────────────────────────────── */}
      <div className="mt-3 rounded-btn border border-line bg-canvas/40 p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[11px] text-muted">
            编辑「{selected.name}」的目录结构
          </span>
          <span className="shrink-0 text-[10.5px] text-muted" title="深度按根 + 子级层数计，4 级封顶；节点含根，256 封顶">
            深度 {depth} / {MAX_TEMPLATE_DEPTH} · 节点 {nodes} / {MAX_TEMPLATE_NODES}
          </span>
        </div>
        <div className="overflow-x-auto">
          <TemplateNodeRow
            node={root}
            path={[]}
            isRoot
            edit={nodeEdit}
            canAddAt={(p) => canAddChildAt(root, p)}
            onStartEdit={(path) => {
              const target = findNodeAt(root, path)
              if (target) setNodeEdit({ path, draft: target.name })
            }}
            onEditChange={(value) => setNodeEdit((prev) => (prev ? { ...prev, draft: value } : prev))}
            onCommitEdit={commitNodeRename}
            onCancelEdit={() => setNodeEdit(null)}
            onAdd={handleAddChild}
            onRemove={handleRemoveNode}
          />
        </div>
        <p className="mt-1 px-1 text-[10.5px] leading-relaxed text-muted">
          根目录名可用 <code className="font-mono">{CODE_PLACEHOLDER}</code> 与{' '}
          <code className="font-mono">{NAME_PLACEHOLDER}</code>{' '}
          占位符，新建项目时自动替换为项目编号和名称；子目录名按原样创建。同名子目录会自动加序号。
          也可以把资源管理器里的模板文件夹直接拖进本卡，自动识别目录结构后确认生成。
        </p>
      </div>

      {/* ── 二次确认弹窗（Modal 外壳自带层栈 Esc） ─────────────────────── */}
      {confirm && (
        <Modal
          title={
            confirm.kind === 'delete-template'
              ? '确认删除模板'
              : confirm.kind === 'delete-node'
                ? '确认删除目录'
                : '确认恢复出厂内容'
          }
          onClose={() => setConfirm(null)}
          width="max-w-md"
        >
          {confirm.kind === 'delete-template' ? (
            <p className="text-[13px] leading-relaxed text-secondary">
              将删除模板「{confirm.name}」（{confirm.nodes} 个目录）。只影响模板本身，
              已用模板建好的项目文件夹不受影响。
            </p>
          ) : confirm.kind === 'delete-node' ? (
            <p className="text-[13px] leading-relaxed text-secondary">
              将删除目录「{confirm.name}」
              {confirm.subCount > 0 ? `，连同其下面 ${confirm.subCount} 个子目录` : ''}。
              此操作未保存前可点「放弃」撤回。
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed text-secondary">
              将把「{confirm.name}」的内容恢复为出厂模板，你自己改过的目录会被覆盖；
              其他模板不受影响。
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              className={
                confirm.kind === 'restore-builtin' ? 'btn btn-primary' : 'btn btn-outline-danger'
              }
              onClick={runConfirmed}
            >
              {confirm.kind === 'restore-builtin' ? '确认恢复' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── 拖入扫描的预览确认层（「让用户选」：必须确认才写入草稿） ──── */}
      {preview && (
        <Modal
          title="从文件夹生成模板"
          onClose={() => setPreview(null)}
          width="max-w-md"
        >
          <p className="text-[12px] leading-relaxed text-secondary">
            已识别文件夹「{preview.root.name}」（共 {preview.scannedDirs} 个目录），
            下面是把它的目录结构转成的模板草稿：
          </p>
          <div className="mt-2 max-h-52 overflow-auto rounded-btn border border-line bg-canvas/40 p-2">
            <PreviewNodeRow node={preview.root} depth={1} />
          </div>
          {(preview.truncated.depth > 0 || preview.truncated.nodes > 0) && (
            <p className="mt-2 text-[11px] leading-relaxed text-secondary" role="alert">
              该文件夹超出模板上限，已丢弃：超过 {MAX_TEMPLATE_DEPTH} 级深度的{' '}
              {preview.truncated.depth} 个目录、超过 {MAX_TEMPLATE_NODES} 个目录上限的{' '}
              {preview.truncated.nodes} 个目录。生成后仍可在编辑器里手动补。
            </p>
          )}
          <label className="mt-3 flex items-center gap-2">
            <span className="shrink-0 text-[12px] text-secondary">模板名</span>
            <input
              className="input h-8 min-w-0 flex-1 !py-0.5 text-xs"
              value={preview.nameDraft}
              spellCheck={false}
              autoFocus
              title="模板名：40 字以内，非法字符自动替换"
              onChange={(e) => setPreview({ ...preview, nameDraft: e.target.value })}
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" onClick={() => setPreview(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={atCountLimit}
              title={
                atCountLimit
                  ? `模板已达上限 ${MAX_TEMPLATE_COUNT} 个，请先删除不用的模板`
                  : '确认后模板进入下方编辑器草稿，仍需点「保存」写入'
              }
              onClick={confirmPreview}
            >
              生成模板
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
