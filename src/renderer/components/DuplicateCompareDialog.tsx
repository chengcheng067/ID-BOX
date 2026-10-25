/**
 * 重复副本「并排对比」弹窗（2026-10 用户反馈）。
 *
 * 背景：原来详情面板只列一行 `相对路径 + 体积`，用户原话是「不够直观」——
 * 正因为看不出两份差在哪，才敢点「保留这份，其余移入回收站」。这个弹窗把
 * 当前这份与每个副本**并排列**，逐字段对比，值不同的字段用强调色标出来。
 *
 * 设计约束：
 * - **不新造视觉语言**：外壳直接用 `Modal`（与 ConfirmDialog / 其它弹窗同源），
 *   按钮走 `.btn` / `.btn-outline-danger`，卡片走 `rounded-slotgroup` / `border-soft-line`；
 * - **不改删除链路**：每列底部「保留这份」只是回调 `onKeep(id)`，真正的
 *   二次确认 + 5 秒撤销仍在 store 的 `requestDelete`；
 * - 差异判定是纯函数 `compareFields()`（logic/duplicates.ts），组件只负责摆位置。
 */
import { useEffect } from 'react'
import { KIND_LABEL } from '../../shared/classify'
import { thumbVaultUrl } from '../../shared/format'
import { compareFields } from '../logic/duplicates'
import { Modal } from './Modal'
import { IconHdr, IconImage, IconMaterial, IconOther, IconTrash, IconBox } from '../icons'
import type { Asset, AssetKind } from '../../shared/types'

const KIND_ICON: Record<AssetKind, typeof IconBox> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  other: IconOther
}

/** 单列缩略图：只读缩略图缓存（`vault://thumb`），没有就给占位，绝不读原图 */
function CompareCover({ asset }: { asset: Asset }) {
  const ready = asset.thumbStatus === 'ready' && !!asset.thumbPath
  if (ready) {
    return (
      <img
        src={thumbVaultUrl(asset.thumbPath!)}
        alt={asset.name}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    )
  }
  const Icon = KIND_ICON[asset.kind]
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
      <Icon width={22} height={22} />
      <span className="text-[10px]">无缩略图</span>
      <span className="max-w-[85%] truncate text-[10px]">{KIND_LABEL[asset.kind]}</span>
    </div>
  )
}

export function DuplicateCompareDialog({
  asset,
  copies,
  sizeMismatch,
  onKeep,
  onClose
}: {
  /** 当前详情面板里的这份 */
  asset: Asset
  /** 其它副本（调用方已排除自己；理论上不含软删记录） */
  copies: Asset[]
  /** 组内体积差异 > 30%（沿用详情面板那条红字警示） */
  sizeMismatch: boolean
  /** 保留某一列（id），其余移入回收站 */
  onKeep: (keepId: string) => void
  onClose: () => void
}) {
  // 防御：即使调用方传了软删记录进来，也不在对比里展示（它们不该被"保留/删除"）
  const columns = [asset, ...copies].filter((a) => a && !a.deletedAt)
  // 「有才显示」的字段（SU 版本）全空时整行不渲染
  const fields = compareFields(columns).filter((f) => f.values.some((v) => v !== ''))

  /**
   * Esc 关闭。
   *
   * `Modal` 外壳**不带** Esc（它只有遮罩点击关闭），App 的全局 Esc 又只认
   * `pendingDelete` / 文件视图这些 store 状态，不知道本地弹窗 → 不自己接一手的话，
   * 按 Esc 会「弹窗不动、底下的选中被清掉」。
   * 捕获阶段 + `stopPropagation`：与 App 里浮层同一套写法，避免一次按键关两层。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <Modal title={`重复副本对比（${columns.length} 份）`} onClose={onClose} width="max-w-5xl">
      <p className="text-[12px] text-muted">
        同一套资产的多个副本。字段值不同的会
        <span className="mx-0.5 font-medium text-accent-text">用蓝色标出</span>
        ，确认是同一套之后再决定保留哪一份。
      </p>

      {sizeMismatch && (
        <p className="mt-2 rounded-lg border border-danger/40 bg-danger-tint px-3 py-2 text-[12px] leading-relaxed text-danger">
          同组资产体积差异超过 30%，可能不是同一套资产——删除前请先确认。
        </p>
      )}

      {/* 列数多时横向滚动（>= 4 列起就需要滚动，避免每列被挤到看不清） */}
      <div className="mt-3 overflow-x-auto pb-1">
        <div className="flex min-w-max items-stretch gap-3">
          {columns.map((a, i) => (
            <div
              key={a.id}
              className="flex w-[190px] shrink-0 flex-col overflow-hidden rounded-slotgroup border border-soft-line bg-card"
            >
              <div className="relative h-[104px] w-full shrink-0 bg-canvas">
                <CompareCover asset={a} />
                <span className="badge absolute left-1.5 top-1.5">{KIND_LABEL[a.kind]}</span>
                <span className="badge absolute right-1.5 top-1.5">
                  {i === 0 ? '当前' : `副本 ${i}`}
                </span>
              </div>

              <div className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
                <div className="truncate text-[12px] font-semibold text-primary" title={a.name}>
                  {a.name}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-muted" title={a.relFolder}>
                  {a.relFolder}
                </div>

                <div className="mt-2 space-y-1">
                  {fields.map((f) => (
                    <div key={f.key}>
                      <div className="text-[10px] text-muted">{f.label}</div>
                      {/* 差异字段：强调色 + 加粗（复用 accent-text token，不新造颜色） */}
                      <div
                        className={`truncate text-[11px] ${
                          f.differs ? 'font-medium text-accent-text' : 'text-secondary'
                        }`}
                        title={`${f.label}：${f.values[i] || '—'}${
                          f.differs ? '（与其它副本不同）' : ''
                        }`}
                      >
                        {f.values[i] || '—'}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-auto pt-2">
                  <button
                    className="btn btn-outline-danger w-full !bg-transparent !py-1 text-[11px]"
                    onClick={() => onKeep(a.id)}
                    title="保留这一份，其余副本移入回收站（二次确认，5 秒内可撤销）"
                  >
                    <IconTrash width={12} height={12} />
                    保留这份
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        「保留这份」只处理同组副本，素材文件不会立刻消失（先进入 5 秒撤销期，到期后移入
        Windows 回收站）。
      </p>

      <div className="mt-4 flex justify-end">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  )
}
