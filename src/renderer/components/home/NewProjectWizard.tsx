/**
 * 新建项目向导（docs/60 §4，T-03）。
 *
 * ## 四步流程（W1-W10）
 *
 *   ① 选模板（内置排首位带「内置」角标，显示摘要）→ ② 填编号（可选，带建议文案）
 *   与项目名（必填，实时预览根目录名）→ ③ 选位置（`dialog:pickDirectory`，
 *   取消停在本步）→ ④ 确认页（完整树预览 + 根名已替换 + 父目录 + 所选模板名）
 *   → 创建（loading 态防重复点击）→ 成功页（自动钉选 + 打开文件夹）。
 *
 * ## 失败分支
 *
 * - 主进程返回 `{ok:false, error}`：错误**单行**展示在确认页，向导不关 ——
 *   已填内容保留，可改名称 / 换位置后重试，或取消（docs/60 §4.3 安全拒绝分支表）；
 * - 钉选失败不回滚创建结果（W9：钉选只是 Settings 写入，失败静默，不打断成功提示）。
 *
 * ## 项目红线对照
 *
 * - 零系统默认控件：全部走项目自有 `btn` / `input` / `badge` 与 `Modal` 外壳
 *   （Esc 层栈 + z-index 由 Modal 统一处理 —— `useEscLayer` 语义）；
 * - 创建等待中禁 Esc / 遮罩关闭（半程目录已在建，误关向导会丢钉选收尾）；
 * - 用户可见文案单行、不暴露内部词（模板 id / normalize 等一律不出现）；
 * - 成功路径上**没有** `reveal(` / `openPath(` 调用（0.9.2 守卫会拒，判据 §4.4④）：
 *   打开走 `home:pinnedOpen(id)` 的钉选 id 白名单。
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Modal } from '../Modal'
import { useVault } from '../../store'
import { BUILTIN_TEMPLATE_ID, resolveRootName } from '../../../shared/projectTemplate'
import { sortTemplatesBuiltinFirst, templateSummary } from '../../logic/projectTemplatesEditor'
import { folderNameOfPath } from '../../logic/homePinned'
import type { ProjectTemplate, ProjectTemplateNode } from '../../../shared/types'

/** 向导四步 + 成功页（`done` 不是一步，是终态页） */
type WizardStep = 'template' | 'fields' | 'location' | 'confirm' | 'done'

/** 成功页数据（`pinId` 供「打开文件夹」走 `home:pinnedOpen` 的 id 白名单） */
interface DoneInfo {
  rootName: string
  rootPath: string
  pinId: string | null
}

/** 步骤标题（确认页第 4 步；done 单独渲染终态） */
const STEP_LABEL: Record<Exclude<WizardStep, 'done'>, string> = {
  template: '第 1 步 · 选择模板',
  fields: '第 2 步 · 项目信息',
  location: '第 3 步 · 存放位置',
  confirm: '第 4 步 · 确认创建'
}

/** 四个正式步骤的固定顺序（步骤条小圆点的点亮判定用） */
const STEP_ORDER: readonly Exclude<WizardStep, 'done'>[] = ['template', 'fields', 'location', 'confirm']

/**
 * 确认页的只读树预览（递归平铺行，缩进 = 深度 × 14，与 ProjectTemplatesEditor 同一节奏）。
 * `nameOverride` 只给根节点：确认页展示的是**替换占位符后**的真实根名。
 */
function PreviewNode(props: {
  node: ProjectTemplateNode
  nameOverride?: string
  depth: number
}): ReactElement {
  const { node, nameOverride, depth } = props
  return (
    <>
      <div className="flex items-center py-0.5" style={{ paddingLeft: depth * 14 }}>
        <span className={depth === 0 ? 'text-sm font-semibold' : 'text-[13px]'} aria-hidden="true">
          {nameOverride ?? node.name}
        </span>
      </div>
      {Array.isArray(node.children)
        ? node.children.map((child, i) => (
            <PreviewNode key={`${depth}-${i}`} node={child} depth={depth + 1} />
          ))
        : null}
    </>
  )
}

/**
 * 新建项目向导。由 `App.tsx` 挂载（入口：首页文件夹排「新建项目」虚卡 /
 * 文件夹排右键「新建项目…」，双入口同开这一个向导）。
 */
export function NewProjectWizard({ onClose }: { onClose: () => void }): ReactElement {
  // 模板来自 settings（主进程归一化后的多模板表）；内置排首位（与设置页同一份排序纯函数）
  const rawTemplates = useVault((s) => s.settings?.projectTemplates ?? [])
  const templates = useMemo(() => sortTemplatesBuiltinFirst([...rawTemplates]), [rawTemplates])

  const [step, setStep] = useState<WizardStep>('template')
  const [templateId, setTemplateId] = useState<string>(() =>
    templates.some((t) => t.id === BUILTIN_TEMPLATE_ID) ? BUILTIN_TEMPLATE_ID : (templates[0]?.id ?? '')
  )
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [done, setDone] = useState<DoneInfo | null>(null)

  const selected: ProjectTemplate | null = templates.find((t) => t.id === templateId) ?? templates[0] ?? null
  const nameReady = name.trim().length > 0
  // 实时预览根目录名（docs/60 §2.4 两分支；名称空时占位「—」不预览）
  const rootPreview =
    selected && nameReady ? resolveRootName(selected.root.name, code, name) : null

  /** W3 选位置：取消（null）→ 停在本步，什么都不改 */
  const pickLocation = async (): Promise<void> => {
    const dir = await window.modvault.pickDirectory({
      title: '选择存放位置',
      buttonLabel: '在此新建项目'
    })
    if (dir) {
      setParentDir(dir)
      setError(null)
    }
  }

  const goNext = (): void => {
    setError(null)
    if (step === 'template' && selected) setStep('fields')
    else if (step === 'fields' && nameReady) setStep('location')
    else if (step === 'location' && parentDir) setStep('confirm')
  }

  const goBack = (): void => {
    setError(null)
    if (step === 'fields') setStep('template')
    else if (step === 'location') setStep('fields')
    else if (step === 'confirm') setStep('location')
  }

  /** W5-W10 生成：一次 invoke 交主进程两阶段执行；成功后自动钉选进快速访问 */
  const create = async (): Promise<void> => {
    if (!selected || !nameReady || !parentDir || creating) return
    setCreating(true)
    setError(null)
    try {
      const result = await window.modvault.projectCreate({
        template: selected,
        code,
        name,
        parentDir
      })
      if (!result.ok) {
        // 失败：单行展示、向导不关，已填内容保留可改了重试（docs/60 §4.3）
        setError(result.error)
        return
      }
      // W9 自动钉选：显示名取**磁盘上真实的**根目录名（folderNameOfPath），
      // 与主进程归一化结果零漂移；钉选失败不回滚创建结果（静默，不打断成功页）
      const rootName = folderNameOfPath(result.rootPath)
      let pinId: string | null = null
      try {
        await useVault.getState().addHomePinnedFolder(rootName, result.rootPath)
        const pins = useVault.getState().settings?.homePinnedFolders ?? []
        for (let i = pins.length - 1; i >= 0; i -= 1) {
          if (pins[i].absPath === result.rootPath) {
            pinId = pins[i].id
            break
          }
        }
      } catch {
        // 钉选失败：给一行提示，不阻断成功提示（docs/60 §4.3 W9）
        useVault.getState().setNotice('项目文件夹已创建，但加入快速访问失败')
      }
      setDone({ rootName, rootPath: result.rootPath, pinId })
      setStep('done')
    } catch {
      setError('创建项目文件夹失败，请重试')
    } finally {
      setCreating(false)
    }
  }

  /** 成功页「打开文件夹」：走 `home:pinnedOpen(id)`（钉选 id 白名单，守卫零放宽） */
  const openCreated = (): void => {
    if (!done?.pinId) return
    void window.modvault
      .homePinnedOpen(done.pinId)
      .then((err) => {
        if (err) useVault.getState().setNotice(err)
      })
      .catch(() => useVault.getState().setNotice('打开文件夹失败，请重试'))
  }

  return (
    <Modal
      title="新建项目"
      onClose={onClose}
      width="max-w-xl"
      // 创建等待中禁 Esc / 遮罩误关（目录正在落盘，误关会丢钉选收尾）；其余步骤照常
      dismissOnScrim={!creating}
      dismissOnEsc={!creating}
    >
      {step !== 'done' ? (
        <>
          {/* 步骤条：四个小圆点 + 当前步标题（自绘，零系统控件） */}
          <div className="mb-3 flex items-center gap-2">
            {STEP_ORDER.map((s, i) => (
              <span
                key={s}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  s === step ? 'bg-accent' : i < STEP_ORDER.indexOf(step as Exclude<WizardStep, 'done'>) ? 'bg-accent/40' : 'bg-line'
                }`}
                aria-hidden="true"
              />
            ))}
            <span className="ml-1 text-xs text-muted">{STEP_LABEL[step as Exclude<WizardStep, 'done'>]}</span>
          </div>
        </>
      ) : null}

      {/* ── W1 选模板 ─────────────────────────────────────────────── */}
      {step === 'template' ? (
        <div className="flex flex-col gap-2">
          {templates.map((t) => {
            const sum = templateSummary(t.root)
            const active = selected?.id === t.id
            return (
              <button
                key={t.id}
                type="button"
                className={`btn justify-between !py-2.5 text-left ${active ? 'btn-primary' : ''}`}
                onClick={() => setTemplateId(t.id)}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.id === BUILTIN_TEMPLATE_ID ? <span className="badge">内置</span> : null}
                </span>
                <span className={`text-xs ${active ? 'text-white/80' : 'text-tertiary'}`}>
                  {sum.nodes} 个文件夹 · {sum.depth} 级
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {/* ── W2 填编号（可选）+ 名称（必填）+ 实时根名预览 ─────────── */}
      {step === 'fields' ? (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">项目编号</span>
            <input
              className="input h-9 w-full"
              value={code}
              placeholder="2026-018"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
            />
            <span className="text-xs text-tertiary">建议填写，将用于项目文件夹命名</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">项目名称</span>
            <input
              className="input h-9 w-full"
              value={name}
              placeholder="江畔会所"
              spellCheck={false}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            {!nameReady && name.length > 0 ? (
              <span className="text-xs text-danger">请填写项目名称</span>
            ) : null}
          </label>
          <div className="rounded-lg border border-line px-3 py-2">
            <span className="text-xs text-tertiary">文件夹名预览</span>
            <div className="truncate text-sm font-medium">{rootPreview ?? '—'}</div>
          </div>
        </div>
      ) : null}

      {/* ── W3 选位置 ─────────────────────────────────────────────── */}
      {step === 'location' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-line px-3 py-2.5">
            <span className="text-xs text-tertiary">项目将创建在</span>
            <div className="mt-0.5 break-all text-sm">
              {parentDir ?? <span className="text-tertiary">尚未选择位置</span>}
            </div>
          </div>
          <div>
            <button type="button" className="btn" onClick={() => void pickLocation()}>
              选择位置…
            </button>
            <p className="mt-2 text-xs text-tertiary">取消选择将停留在本步，不影响已填内容</p>
          </div>
        </div>
      ) : null}

      {/* ── W4 确认：完整树预览 + 父目录 + 模板名；失败单行展示不关 ── */}
      {step === 'confirm' && selected ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-tertiary">
            <span>模板</span>
            <span className="font-medium text-primary">{selected.name}</span>
            {selected.id === BUILTIN_TEMPLATE_ID ? <span className="badge">内置</span> : null}
          </div>
          <div className="rounded-lg border border-line px-3 py-2.5">
            <span className="text-xs text-tertiary">位置</span>
            <div className="break-all text-sm">{parentDir}</div>
          </div>
          <div className="max-h-56 overflow-auto rounded-lg border border-line px-3 py-2">
            <PreviewNode node={selected.root} nameOverride={rootPreview ?? undefined} depth={0} />
          </div>
          {error !== null ? (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── 成功页：根名 + 路径 + 已入快速访问 + 打开文件夹 ────────── */}
      {step === 'done' && done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-2xl text-accent" aria-hidden="true">
            ✓
          </div>
          <div className="text-base font-semibold">项目文件夹已创建</div>
          <div className="text-sm">{done.rootName}</div>
          <div className="max-w-full break-all rounded-lg border border-line px-3 py-2 text-xs text-muted">
            {done.rootPath}
          </div>
          <p className="text-xs text-tertiary">
            {done.pinId !== null ? '已自动加入首页快速访问' : '可在首页文件夹排右键手动添加快速访问'}
          </p>
        </div>
      ) : null}

      {/* ── 底部按钮排 ─────────────────────────────────────────────── */}
      <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
        {step === 'template' ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={!selected} onClick={goNext}>
              下一步
            </button>
          </>
        ) : null}
        {step === 'fields' ? (
          <>
            <button type="button" className="btn" onClick={goBack}>
              上一步
            </button>
            <button type="button" className="btn btn-primary" disabled={!nameReady} onClick={goNext}>
              下一步
            </button>
          </>
        ) : null}
        {step === 'location' ? (
          <>
            <button type="button" className="btn" onClick={goBack}>
              上一步
            </button>
            <button type="button" className="btn btn-primary" disabled={!parentDir} onClick={goNext}>
              下一步
            </button>
          </>
        ) : null}
        {step === 'confirm' ? (
          <>
            <button type="button" className="btn" disabled={creating} onClick={goBack}>
              上一步
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={creating}
              onClick={() => void create()}
            >
              {creating ? '正在创建…' : '创建'}
            </button>
          </>
        ) : null}
        {step === 'done' && done ? (
          <>
            {done.pinId !== null ? (
              <button type="button" className="btn" onClick={openCreated}>
                打开文件夹
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
