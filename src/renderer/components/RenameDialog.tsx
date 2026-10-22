import { useEffect, useMemo, useState } from 'react'
import { useVault } from '../store'
import { UNCLASSIFIED } from '../../shared/taxonomy'
import {
  RENAME_PLACEHOLDERS,
  planRenames,
  type RenamePlanRow
} from '../../shared/renameTemplate'
import type { Asset } from '../../shared/types'
import { Modal } from './Modal'

/** 导入时间戳 → 年份（非法值给 0，`applyRenameTemplate` 会渲染成空串） */
function yearOf(importedAt: number): number {
  if (!Number.isFinite(importedAt) || importedAt <= 0) return 0
  return new Date(importedAt).getFullYear()
}

/** 预览行右侧的状态徽标（`undefined` = 待改名，不显示徽标） */
function rowBadge(row: RenamePlanRow) {
  if (row.reason === 'dup') {
    return (
      <span className="rounded-pill bg-danger-tint px-2 py-0.5 text-[11px] text-danger">重名</span>
    )
  }
  if (row.reason === 'invalid') {
    return (
      <span className="rounded-pill bg-danger-tint px-2 py-0.5 text-[11px] text-danger">
        Windows 保留名
      </span>
    )
  }
  if (row.reason === 'unchanged') {
    return <span className="text-[11px] text-muted">未变化</span>
  }
  return null
}

/**
 * 批量重命名弹窗（0.6.0，docs/22 §3.4）——**风险最高的功能的最后一道闸门**。
 *
 * 交互契约（用户拍板：没有预览、没有回滚的批量写操作一律不做）：
 * ① 模板输入 + 占位符说明（点一下就插入）；
 * ② **预览表**（旧名 → 新名），冲突行标红，且**有冲突时执行按钮禁用**；
 * ③ 文案必须写清「只改文件夹名，不改包里的文件」；
 * ④ 执行后关闭弹窗，结果由 store 的 notice 汇总（重命名 X 条，失败 Y 条）。
 *
 * 模板本身只影响**显示与预览**；落盘由 `store.applyRenames` → `main/rename.ts` 完成，
 * 那里还有一次独立预检（越界 / 目标已存在 / 保留名）与失败回滚。
 */
export function RenameDialog() {
  const renameIds = useVault((s) => s.renameIds)
  const assets = useVault((s) => s.assets)
  const settings = useVault((s) => s.settings)
  const close = useVault((s) => s.closeRenameDialog)
  const applyRenames = useVault((s) => s.applyRenames)
  const saveSettings = useVault((s) => s.saveSettings)

  const [tpl, setTpl] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开都以 `settings.renameTemplate` 为草稿起点。
  // 依赖只写 `renameIds`：**不能**依赖 settings，否则用户在这里输入时（若别处保存了
  // settings）草稿会被重置；也不能依赖 assets，否则改名完成后草稿闪一下。
  useEffect(() => {
    if (!renameIds) return
    const current = useVault.getState().settings?.renameTemplate ?? '{name}'
    setTpl(current)
    setBusy(false)
  }, [renameIds])

  const targets = useMemo<Asset[]>(() => {
    if (!renameIds) return []
    const byId = new Map(assets.map((a) => [a.id, a]))
    return renameIds.map((id) => byId.get(id)).filter((a): a is Asset => a !== undefined)
  }, [renameIds, assets])

  const plan = useMemo(
    () =>
      planRenames(
        targets.map((a) => ({
          id: a.id,
          name: a.name,
          c1: a.category1 ?? UNCLASSIFIED,
          c2: a.category2 ?? UNCLASSIFIED,
          year: yearOf(a.importedAt)
        })),
        tpl
      ),
    [targets, tpl]
  )

  // 只有 `reason === undefined` 的行会真的发 IPC（unchanged 由 store 再过滤一次）
  const toChange = plan.rows.filter((r) => r.reason === undefined)
  const conflicts = plan.rows.filter((r) => r.reason === 'dup' || r.reason === 'invalid')
  const canExec = !busy && plan.ok && toChange.length > 0

  if (!renameIds) return null

  const exec = async () => {
    if (!canExec) return
    setBusy(true)
    try {
      // 记住模板（下次打开弹窗 / 设置页都以它为准）；空模板不覆盖默认值
      const next = tpl.trim()
      if (next && next !== settings?.renameTemplate) void saveSettings({ renameTemplate: next })
      await applyRenames(toChange.map((r) => ({ id: r.id, to: r.to }))).catch(() => undefined)
    } finally {
      setBusy(false)
      close()
    }
  }

  return (
    <Modal
      title={`批量重命名（${targets.length} 个资产）`}
      onClose={close}
      width="max-w-2xl"
    >
      <p className="mb-3 rounded-lg border border-line bg-elevated px-3 py-2 text-[12px] leading-relaxed text-secondary">
        <span className="font-medium text-primary">只改文件夹名，不改包里的文件。</span>
        资产的内容、封面、标签、备注都不会变；分类目录（大类 / 一级 / 二级）也不会移动。
        任何一条失败会整批回滚，磁盘保持原样。
      </p>

      <div className="mb-1 text-[12px] font-medium">命名模板</div>
      <input
        className="input font-mono text-[13px]"
        value={tpl}
        placeholder="{c1}-{c2}-{name}"
        onChange={(e) => setTpl(e.target.value)}
        spellCheck={false}
        disabled={busy}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {RENAME_PLACEHOLDERS.map((p) => (
          <button
            key={p.token}
            type="button"
            className="rounded-pill border border-line bg-card px-2 py-0.5 text-[11px] font-mono text-secondary transition hover:text-primary disabled:opacity-40"
            title={`${p.hint}\n例：${p.example}`}
            onClick={() => setTpl((t) => t + p.token)}
            disabled={busy}
          >
            {p.token}
          </button>
        ))}
        <span className="ml-1 text-[11px] text-muted">
          点一下插入；<span className="font-mono">{'{n:2}'}</span> 补零成 01
        </span>
      </div>

      {plan.unknownTokens.length > 0 && (
        <p className="mt-2 rounded-lg border border-line bg-elevated px-3 py-2 text-[11px] leading-relaxed text-secondary">
          模板里有无法识别的占位符：
          <span className="font-mono text-primary">{plan.unknownTokens.join('、')}</span>
          。它们会<span className="font-medium text-primary">原样</span>出现在文件夹名里，
          请检查拼写（可用：{RENAME_PLACEHOLDERS.map((p) => p.token).join(' ')}）。
        </p>
      )}

      {conflicts.length > 0 && (
        <p className="mt-2 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[11px] leading-relaxed text-danger">
          有 {conflicts.length} 行改名后会冲突（重名 / Windows 保留名），执行已禁用。
          请调整模板（例如加上 <span className="font-mono">{'{n}'}</span> 让每行唯一）。
          本功能不会自动追加 <span className="font-mono">-2</span> 序号 ——
          预览表里的名字就是最终落盘的名字。
        </p>
      )}

      <div className="mb-1 mt-4 flex items-center justify-between">
        <div className="text-[12px] font-medium">预览</div>
        <div className="text-[11px] text-muted">
          共 {plan.rows.length} 条，将改名 <span className="font-medium text-primary">{toChange.length}</span> 条
        </div>
      </div>

      <div className="max-h-[46vh] overflow-auto rounded-lg border border-line">
        <div className="sticky top-0 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2 border-b border-line bg-elevated px-3 py-2 text-[11px] font-medium text-muted">
          <span>旧文件夹名</span>
          <span aria-hidden>→</span>
          <span>新文件夹名</span>
          <span className="w-16 text-right">状态</span>
        </div>
        {plan.rows.map((row) => {
          const bad = row.reason === 'dup' || row.reason === 'invalid'
          const muted = row.reason === 'unchanged'
          return (
            <div
              key={row.id}
              className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[12px] last:border-0"
            >
              <span className={`truncate ${muted ? 'text-muted' : 'text-secondary'}`} title={row.from}>
                {row.from}
              </span>
              <span className="text-muted" aria-hidden>
                →
              </span>
              <span
                className={`truncate font-medium ${bad ? 'text-danger' : muted ? 'text-muted' : 'text-primary'}`}
                title={row.to}
              >
                {row.to}
              </span>
              <span className="w-16 text-right">{rowBadge(row)}</span>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-[11px] leading-relaxed text-muted">
          目标位置已有同名目录时会失败并整批回滚，不会覆盖任何现有资产。
        </span>
        <div className="flex shrink-0 gap-2">
          <button className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void exec()}
            disabled={!canExec}
            title={
              conflicts.length > 0
                ? '存在冲突行，先调整模板'
                : toChange.length === 0
                  ? '没有需要改名的资产'
                  : undefined
            }
          >
            {busy ? '重命名中…' : `执行（${toChange.length} 条）`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
