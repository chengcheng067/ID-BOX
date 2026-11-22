/**
 * 一键打包弹窗（docs/58 §5 · T4 渲染层）。
 *
 * 一个自绘浮层串起整条状态机：导出选项 → 选包验包 → 非空库显式确认 → 逐项三档裁决
 * → 进度 → 完成。数据全在 store 的 `packageConflict` 状态机里，本组件只负责渲染与转发动作。
 *
 * ## 三条交互红线（与既有一致，不要在这里另起炉灶）
 *
 * 1. **Esc 走 `useEscLayer`**（`logic/escLayer.ts` 的层栈）：本文件不自己注册按键监听；
 *    层栈决定谁吃 Esc，视觉层级由同一个 token 的深度经 `logic/zStack.ts` 换算。
 * 2. **零系统默认控件**：勾选项、三档裁决全是自绘按钮 + `aria-pressed`，没有原生复选框/
 *    下拉框；文案是单行白话中文，不露机器字段名（F-3 的磁盘数字是可行动信息，允许原样单行显示）。
 * 3. **一次一层**：逐项裁决就在本弹窗内部展开，不叠第二个 Modal，避免 Esc 连关两层。
 */
import { useEffect, useMemo, useState } from 'react'
import { useVault } from '../store'
import { useEscLayer } from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'
import { isDeletedAsset } from '../logic/trashView'
import { CONFLICT_RESOLUTIONS, RESOLUTION_LABEL } from '../logic/importConflict'
import { canApplyPackage, unresolvedIds, PACKAGE_CONFLICT_LABEL } from '../logic/packageRestore'
import type { PackageResolution } from '../../shared/packageFormat'
import { PACKAGE_KIND_ORDER } from '../../shared/packageFormat'
import { KIND_LABEL } from '../../shared/classify'
import type { AssetKind } from '../../shared/types'
import { formatBytes } from '../../shared/format'
import { IconAlert, IconClose, IconBox } from '../icons'
import { ResolutionButton } from './ImportConflictDialog'

/**
 * 把坏包/导出失败原因收敛成几句固定中文（F-3 / docs/57 §6）。
 *
 * 关键纪律：**不再按「空间 / 磁盘」关键词硬翻译** —— V1.1.0 实测就是这样把真因吞成
 * 「磁盘空间不足」。带可行动数字（「需要约 X MB，可用 Y MB」）的主进程 reason 原样返回；
 * 版本 / 校验两类仍收敛成固定句；其余中性展示，真实原因由调用方放进 `title` 里保留。
 */
function safeErrorText(message: string | null): string | null {
  if (!message) return null
  if (message.includes('版本')) return '素材包版本更新，请升级后再试'
  if (message.includes('校验') || message.includes('损坏') || message.includes('不完整')) {
    return '素材包不完整，请重新导出后再试'
  }
  if (/需要约|可用/.test(message)) return message
  return '操作未完成，请稍后重试'
}

/**
 * F-2：用户口径「HDR 就叫 HDR」，不再叫 HDRI；其它大类沿用共享显示名 `KIND_LABEL`。
 * 只在弹窗内做这一处轻量映射，不动全局 `KIND_LABEL`（其它界面仍显示 HDRI）。
 */
const PACKAGE_KIND_LABEL: Partial<Record<AssetKind, string>> = { hdri: 'HDR' }
function packageKindLabel(kind: AssetKind): string {
  return PACKAGE_KIND_LABEL[kind] ?? KIND_LABEL[kind]
}

/** 单行进度条（纯展示，无系统默认控件） */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0
  const pct = safeTotal > 0 ? Math.min(100, Math.max(0, Math.round((done / safeTotal) * 100))) : 0
  return (
    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** 自绘勾选项（不是原生复选框，统一走按钮语义） */
function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-canvas"
      aria-pressed={checked}
      onClick={onChange}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked ? 'border-accent bg-accent text-on-accent' : 'border-line bg-card text-transparent'
        }`}
      >
        ✓
      </span>
      <span className="text-[13px] text-primary">{label}</span>
    </button>
  )
}

export function PackageDialog() {
  const open = useVault((s) => s.packageDialogOpen)
  const close = useVault((s) => s.closePackageDialog)
  const busy = useVault((s) => s.packageBusy)
  const progress = useVault((s) => s.packageProgress)
  const conflict = useVault((s) => s.packageConflict)
  const error = useVault((s) => s.packageError)
  const exportPackage = useVault((s) => s.exportPackage)
  const pickPackageImport = useVault((s) => s.pickPackageImport)
  const confirmPackageImport = useVault((s) => s.confirmPackageImport)
  const setPackageResolution = useVault((s) => s.setPackageResolution)
  const setAllPackageResolutions = useVault((s) => s.setAllPackageResolutions)
  const applyPackageImport = useVault((s) => s.applyPackageImport)
  const assets = useVault((s) => s.assets)

  /**
   * F-2：导出勾选项按库里**实际存在**的大类动态生成（软删记录不算），去重后按固定顺序排。
   * 用户库只有模型 + 贴图 → 只渲染两项；某类没有 → 连勾选项都不出现。
   */
  const availableKinds = useMemo<AssetKind[]>(() => {
    const present = new Set<AssetKind>()
    for (const asset of assets) {
      if (!isDeletedAsset(asset)) present.add(asset.kind)
    }
    return PACKAGE_KIND_ORDER.filter((kind) => present.has(kind))
  }, [assets])

  /** Esc 与 z-index 同源：都由层栈这一层 token 决定（本组件不碰按键监听） */
  const escDepth = useEscLayer(close, open)

  const [includedKinds, setIncludedKinds] = useState<AssetKind[]>([])
  const [includePersonalSettings, setIncludePersonalSettings] = useState(false)

  useEffect(() => {
    if (!open) return
    setIncludedKinds(availableKinds)
    setIncludePersonalSettings(false)
  }, [open, availableKinds])

  /** 切换某类勾选；结果始终按 PACKAGE_KIND_ORDER 排，保证 payload 稳定。 */
  const toggleKind = (kind: AssetKind): void => {
    setIncludedKinds((prev) => {
      const next = prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
      return PACKAGE_KIND_ORDER.filter((k) => next.includes(k))
    })
  }

  if (!open) return null

  const phase = conflict.phase
  const exported = busy === 'export'
  const importing = busy === 'import'
  const rawError = error ?? conflict.error
  const shownError = safeErrorText(rawError)
  const unresolved = unresolvedIds(conflict).length
  const canImport = canApplyPackage(conflict) && !importing

  return (
    <div
      className={`dialog-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-label="一键打包与素材同步"
    >
      <div className="w-full max-w-2xl max-h-[86vh] overflow-auto rounded-modal border border-line bg-card shadow-modal">
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-card px-5 py-3.5">
          <h2 className="text-base font-semibold">一键打包与素材同步</h2>
          <button className="btn btn-ghost !p-1.5" onClick={close} title="关闭" disabled={busy !== null}>
            <IconClose />
          </button>
        </div>

        <div className="px-5 py-4">
          {/* 入口：导出选项 + 导入入口 */}
          {phase === 'idle' && (
            <div className="space-y-4">
              <p className="text-[13px] leading-relaxed text-secondary">
                把当前库打成一个包，拷到另一台电脑后导入即可继续用。
              </p>

              <section className="rounded-lg border border-line bg-canvas px-3 py-2.5">
                <h3 className="mb-1 text-[13px] font-semibold">导出选项</h3>
                <p className="mb-1 text-[11px] text-muted">选择要打包的大类（默认全选）：</p>
                {availableKinds.map((kind) => (
                  <ToggleRow
                    key={kind}
                    label={packageKindLabel(kind)}
                    checked={includedKinds.includes(kind)}
                    onChange={() => toggleKind(kind)}
                  />
                ))}
                <ToggleRow
                  label="带上我的别名和首页布局"
                  checked={includePersonalSettings}
                  onChange={() => setIncludePersonalSettings(!includePersonalSettings)}
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted">
                    {includedKinds.length === 0
                      ? '请至少选择一个大类再导出。'
                      : '只会带上勾选大类的素材，不会带上缓存。'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null || includedKinds.length === 0}
                    onClick={() => void exportPackage({ includedKinds, includePersonalSettings })}
                  >
                    选择位置并导出
                  </button>
                </div>
              </section>

              <section className="rounded-lg border border-line bg-canvas px-3 py-2.5">
                <h3 className="mb-1 text-[13px] font-semibold">导入素材包</h3>
                <p className="text-[11px] text-muted">导入前会先问你相同项怎么处理。</p>
                <div className="mt-2 flex justify-end">
                  <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void pickPackageImport()}>
                    从素材包导入
                  </button>
                </div>
              </section>

              {shownError && (
                <p className="flex items-center gap-2 text-[12px] text-danger">
                  <IconAlert />
                  <span className="truncate" title={rawError ?? undefined}>{shownError}</span>
                </p>
              )}

              {exported && (
                <div>
                  <p className="text-[12px] text-secondary">正在导出，请稍候…</p>
                  <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? 0} />
                </div>
              )}
            </div>
          )}

          {/* 只读验包中 */}
          {phase === 'inspecting' && (
            <div className="py-6 text-center">
              <p className="text-[13px] text-secondary">正在读取素材包，请稍候…</p>
              <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? 0} />
            </div>
          )}

          {/* 坏包：一行中文 + 关闭出口 */}
          {phase === 'error' && (
            <div className="space-y-4 py-2">
              <p className="flex items-center gap-2 text-[13px] text-danger">
                <IconAlert />
                <span className="truncate" title={rawError ?? undefined}>
                  {shownError ?? '操作未完成，请稍后重试'}
                </span>
              </p>
              <div className="flex justify-end">
                <button type="button" className="btn btn-primary" onClick={close}>
                  知道了
                </button>
              </div>
            </div>
          )}

          {/* 非空库：必须显式确认 */}
          {phase === 'confirm' && (
            <div className="space-y-4 py-2">
              <p className="text-[13px] leading-relaxed text-primary">
                素材包里有 {conflict.total} 项，其中 {conflict.conflicts.length} 项与当前库重复。继续后会按你逐项选择的方式处理，不会自动替换。
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={close}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" onClick={confirmPackageImport}>
                  确认继续
                </button>
              </div>
            </div>
          )}

          {/* 逐项裁决 + 导入中 + 完成 */}
          {(phase === 'resolving' || phase === 'ready' || phase === 'importing' || phase === 'done') && (
            <div className="space-y-3">
              {phase !== 'done' && (
                <>
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                    <span className="text-[12px] font-medium text-secondary">其余重复项按此处理：</span>
                    <div className="flex gap-1.5">
                      {CONFLICT_RESOLUTIONS.map((r) => (
                        <ResolutionButton key={r} resolution={r} active={false} onClick={() => setAllPackageResolutions(r)} />
                      ))}
                    </div>
                  </div>

                  <ul className="max-h-[44vh] divide-y divide-line overflow-auto rounded-lg border border-line">
                    {conflict.conflicts.map((row) => (
                      <li key={row.id} className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <IconBox />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={row.name}>
                            {row.name}
                          </span>
                          <span className="chip">{PACKAGE_CONFLICT_LABEL[row.reason]}</span>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted">
                          库里已有：{row.localName} · {row.localCategory} · {formatBytes(row.localSize)}
                        </p>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className="text-[11px] text-muted">处置：</span>
                          {CONFLICT_RESOLUTIONS.map((r: PackageResolution) => (
                            <ResolutionButton
                              key={r}
                              resolution={r}
                              active={row.resolution === r}
                              onClick={() => setPackageResolution(row.id, r)}
                            />
                          ))}
                          {row.resolution === undefined && <span className="text-[11px] text-danger">待选择</span>}
                        </div>
                      </li>
                    ))}
                  </ul>

                  <p className="space-y-0.5 text-[11px] leading-relaxed text-muted">
                    跳过 = 保留库里现有的；覆盖 = 用包里的替换这一项；保留两者 = 两份都在。
                  </p>
                </>
              )}

              {phase === 'importing' && (
                <div>
                  <p className="text-[13px] text-secondary">正在导入，请稍候…</p>
                  <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? 0} />
                </div>
              )}

              {phase === 'done' && (
                <p className="flex items-center gap-2 text-[13px] text-primary">
                  导入完成，共 {conflict.total} 项素材。
                </p>
              )}

              <div className="flex justify-end gap-2">
                {phase === 'done' ? (
                  <button type="button" className="btn btn-primary" onClick={close}>
                    完成
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn" onClick={close} disabled={importing}>
                      取消
                    </button>
                    {unresolved > 0 && <span className="self-center text-[11px] text-muted">还有 {unresolved} 项未选择</span>}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!canImport}
                      onClick={() => void applyPackageImport()}
                    >
                      按所选方式导入
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 三档按钮文案的唯一来源（与导入重复处置弹窗共用同一份标签表） */
export const PACKAGE_RESOLUTION_LABELS = RESOLUTION_LABEL
