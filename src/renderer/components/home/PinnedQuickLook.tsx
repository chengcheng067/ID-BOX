/**
 * 应用内文件浏览器的**空格 Quick Look**（大图快览浮层）。
 *
 * 交互口径照 `QuickLookOverlay`（0.8.3 资产快览，用户原话「QuickLook 的功能」）：
 * - 选中单文件按**空格**开（浏览器侧接线）；**空格或 Esc 关**，且**不清选中**；
 * - **←/→** 在当前列表序列（排序后的文件序列）里移动，**到边界不绕回**，
 *   移动后按新条目重取缩略图；
 * - **纯预览不放编辑控件**（没有重命名 / 删除 / 打开方式 —— 那是右键菜单的事）；
 * - 浮层背景：**真高斯模糊**（`.ql-scrim`，backdrop-filter blur 24px + 淡色压暗；
 *   2026-11-25 用户原话「背景应该是全部都高斯模糊掉，而不是单纯压黑」）+
 *   点外关闭；Esc 层栈接入（`useEscLayer`，与 Modal / 菜单同路径）。
 * - 信息行 / 键盘提示压在模糊背景上，统一放进 `.ql-caption` 局部托底保证对比度。
 *
 * 层级：自绘 scrim，视觉层级由 `useEscLayer` 返回的深度经 `zClassForDepth` 换算，
 * ⛔ 不写死 z-index（与 QuickLookOverlay 同一条纪律）。
 *
 * 键位判定复用 `logic/quickLook.ts#decideQuickLookKey`（纯函数，已有单测）。
 * ⚠️ **不传 layerDepth**：那是资产网格的口径（网格不压 Esc 层）。浏览器本体常驻
 * 一层，浮层开着时总深度恒为 2 —— 若照传会被自己的底座层挡掉空格关闭。
 * 浮层是栈顶（`useEscLayer` 保证），scrim 铺满视口期间不可能再叠更高层，
 * 所以「空格 / Esc 只归浮层」在这里天然成立。
 */
import { useCallback, useEffect, useMemo, type ReactElement } from 'react'
import { useEscLayer } from '../../logic/escLayer'
import { zClassForDepth } from '../../logic/zStack'
import { decideQuickLookKey } from '../../logic/quickLook'
import {
  formatSize,
  formatTime,
  quickLookFileNames,
  stepQuickLookFile
} from '../../logic/pinnedBrowser'
import type { FsEntry } from '../../../shared/ipc'
import { IconClose } from '../../icons'
import { PinnedThumbVisual } from './PinnedThumb'

/** 焦点是否落在可输入控件里（与 QuickLookOverlay 同判据；重命名输入框的保险） */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

export interface PinnedQuickLookProps {
  pinId: string
  /** 当前层相对路径（缩略图请求用） */
  dirRel: string
  /** 当前层全部条目（**排序后**的渲染顺序）；可预览序列 = 其中文件 */
  entries: readonly FsEntry[]
  /** 当前快览的文件名（父级 state 持有；←/→ 由父级 onNavigate 改） */
  currentName: string
  /** ←/→ 移动后通知父级：父级同步选中集与浮层目标（选中跟着走，关浮层即留在该项） */
  onNavigate: (name: string) => void
  onClose: () => void
}

export function PinnedQuickLook({
  pinId,
  dirRel,
  entries,
  currentName,
  onNavigate,
  onClose
}: PinnedQuickLookProps): ReactElement | null {
  const current = useMemo(
    () => entries.find((e) => !e.isDir && e.name === currentName) ?? null,
    [entries, currentName]
  )
  /** 文件序列（排序后顺序；每次渲染现算，不缓存 —— 与 QuickLookOverlay 同口径） */
  const sequence = useMemo(() => quickLookFileNames(entries), [entries])
  const position = sequence.indexOf(currentName)

  /** Esc 层栈：浮层占一层，只有栈顶应答 Esc（下层浏览器的 Esc 自然让路） */
  const escDepth = useEscLayer(onClose, true)

  /** ←/→：到边界不绕回（stepQuickLookFile 越界返回 null = 原地不动） */
  const step = useCallback(
    (delta: number) => {
      const next = stepQuickLookFile(sequence, currentName, delta)
      if (next !== null) onNavigate(next)
    },
    [sequence, currentName, onNavigate]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 键位判据全在 decideQuickLookKey（空格/Esc 关、←/→ 换图、repeat/修饰键/输入框让路）
      const action = decideQuickLookKey({
        key: e.key,
        typing: isTypingTarget(e.target),
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat
      })
      if (action === 'none') return
      // 三个动作都要吃掉默认行为：空格会滚内容区、方向键会滚容器
      e.preventDefault()
      if (action === 'close') {
        // 关浮层不清选中（浏览器 Esc 层语义：下一次 Esc 才轮到清选中）
        e.stopPropagation()
        onClose()
      } else if (action === 'next') {
        step(1)
      } else {
        step(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  // 目标不在当前层（导航 / 刷新竞态）：不渲染破浮层，父级 effect 会随即关闭
  if (current === null) return null

  return (
    <div
      className={`ql-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex flex-col items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-label={`快览：${current.name}`}
      onPointerDown={(e) => {
        // 点遮罩关闭（浮层本体 stopPropagation）
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button
        type="button"
        className="btn btn-ghost absolute right-5 top-5 p-1.5 text-secondary transition hover:text-primary"
        onClick={onClose}
        title="关闭（Esc）"
        aria-label="关闭快览"
      >
        <IconClose />
      </button>

      <div
        className="flex min-h-0 w-full max-w-[min(92vw,1100px)] flex-col items-center justify-center"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 主视图：**固定画框**（尺寸不随图片大小变化，与 QuickLookOverlay 同一纪律：
            版面恒定才不会翻页时整块跳）。缩略图成功 = 大图 contain；
            请求中 / 失败 / SKP 提取不出 = 大号类型徽标兜底（不闪空白）。 */}
        <div
          data-pinned-quicklook-stage="1"
          className="flex h-[min(76vh,720px)] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-panel text-secondary"
        >
          <PinnedThumbVisual pinId={pinId} dirRel={dirRel} entry={current} iconSize={160} />
        </div>

        {/* 信息行 + 键盘提示：统一放进 `.ql-caption` 局部托底。
            背景是真模糊（任意壁纸透上来），裸字（尤其原来的 text-tertiary）在浅窗口 /
            亮壁纸上会掉到 3:1 以下；托底 = --bg-canvas 88% + 白 10% 描边，
            深色最坏情况（亮壁纸）下次级字仍 ≥4.5:1（数值见 pinned-browser.css）。
            名称保持 primary、元信息 / 提示提到 secondary（原提示是 tertiary，太淡）。
            只是视觉分组，键盘行为（空格 / Esc / ←→）与固定画框尺寸都不动。 */}
        <div className="mt-4 flex w-full max-w-[min(92vw,1100px)] justify-center">
          <div className="ql-caption max-w-full px-4 py-2.5 text-center">
            <div className="truncate text-[14px] font-semibold text-primary" title={current.name}>
              {current.name}
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 text-[11px] text-secondary">
              <span className="tabular-nums">{formatSize(current.size)}</span>
              {formatTime(current.mtimeMs) !== '' ? (
                <>
                  <span className="text-muted">·</span>
                  <span className="tabular-nums">{formatTime(current.mtimeMs)}</span>
                </>
              ) : null}
            </div>
            {/* 底部提示行：n / m 在文件 ≥2 时出现 */}
            <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-secondary">
              <span>← → 切换 · 空格 / Esc 退出</span>
              {sequence.length >= 2 && position >= 0 ? (
                <span className="tabular-nums">
                  {position + 1} / {sequence.length}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PinnedQuickLook
