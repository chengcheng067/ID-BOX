/**
 * Quick Look（空格全屏快览浮层，0.8.3，docs/32 §4 + docs/33「比素材」的快路径）。
 *
 * 职责边界（这是本组件唯一的设计约束）：**纯预览，不放任何编辑控件**。
 * 详情面板管"编辑与补全"，Quick Look 只管"看清楚这一张"——两者职责分开是 docs/32 §4
 * 拍板的原话。所以这里没有色标、没有收藏、没有重命名，连"设为封面"都没有。
 *
 * ## 层级与 Esc
 *
 * 自绘 scrim（不走 `Modal`），但同样占一层：`useEscLayer(onClose, true)` 挂在 window
 * **捕获阶段**，只有栈顶才消费按键。视觉层级由返回的深度经 `logic/zStack.ts` 换算
 * （`zClassForDepth`）—— 与 Esc 应答读的是同一个栈，不存在两套来源对不上的可能。
 * ⛔ 不许在这里写死 `z-50` 或某个大数：那会让"新点出来的浮层在上"这条规则失效。
 *
 * `decideEsc` 里 `quickLookOpen` 排在 `pendingDelete` 之前（见 `logic/escPriority.ts` 的
 * 注释）：浮层是视觉上最上的可交互层，且**关闭浮层不能顺手清掉选中** —— 第二次 Esc
 * 才走原有 `clear-selection`。本浮层进栈后 App 那条全局 Esc 会因 `hasEscLayer()` 让路，
 * 所以 `decideEsc` 是双保险，真正的关闭发生在这里。
 *
 * ## ←/→
 *
 * 序列**不缓存**：每次按键按 store 现算（`applyFilters`），因为筛选会变 —— 缓存一份
 * 序列会让"改筛选后箭头还跳到已经不可见的资产上"。序列口径（选中集 ≥2 = 选中集，
 * 否则整个可见序列）全部在 `logic/quickLook.ts`，这里只消费。
 *
 * ## 主题
 *
 * 键位（用户 2026-10-28 口径）：空格打开；**空格或 Esc 关闭**；←/→ 换图。
 * 关浮层不清选中（第二次 Esc 才清选中），判据见 `logic/quickLook.ts::decideQuickLookKey`。
 *
 * 浮层跟随应用主题（不强制深色）：浅色主题浅底深字、深色主题暗底浅字。深色底必须是
 * **中性黑灰**（UI 规范 §1：全局禁用橙/棕/紫），强调色只用系统蓝。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useVault, useVisibleAssets } from '../store'
import { getEscLayerDepth, useEscLayer } from '../logic/escLayer'
import { zClassForDepth } from '../logic/zStack'
import {
  decideQuickLookKey,
  quickLookImageUrl,
  quickLookIndexInSequence,
  quickLookSequence,
  stepSequence
} from '../logic/quickLook'
import { categoriesOf } from '../logic/category'
import { formatBytes } from '../../shared/format'
import { KIND_LABEL } from '../../shared/classify'
import { IconCad, IconClose, IconHdr, IconImage, IconMaterial, IconOther, IconBox } from '../icons'
import type { Asset, AssetKind } from '../../shared/types'

/** kind 占位图标（与 AssetGrid / DetailPanel / Sidebar 同一张映射表） */
const KIND_ICON: Record<AssetKind, typeof IconBox> = {
  model: IconBox,
  texture: IconImage,
  hdri: IconHdr,
  material: IconMaterial,
  cad: IconCad,
  other: IconOther
}

/**
 * 焦点是否落在可输入控件里（与 `AssetGrid.isTypingTarget` 同判据）。
 *
 * 为什么必须守：←/→ 是全局监听，用户在搜索框里打字时按方向键应该移动光标，
 * 不该被浮层抢走。（Esc 由 `useEscLayer` 的 `data-esc-own` 分支处理，两者不冲突。）
 */
function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

export interface QuickLookOverlayProps {
  asset: Asset
  onClose: () => void
}

export function QuickLookOverlay({ asset, onClose }: QuickLookOverlayProps) {
  const openQuickLook = useVault((s) => s.openQuickLook)
  const selectedIds = useVault((s) => s.selectedIds)
  const folderViewAssetId = useVault((s) => s.folderViewAssetId)

  /**
   * 序列：按 store 现算，不缓存。
   *
   * `useVisibleAssets()` 已经是 memo 化的 `applyFilters`（唯一软删过滤点在
   * `matchesFilters`），这里直接复用它 —— 与网格渲染顺序必然一致。
   */
  const visible = useVisibleAssets()
  const sequence = useMemo(
    () =>
      quickLookSequence({
        focusId: asset.id,
        selectedIds,
        folderViewAssetId,
        visibleOrder: visible.map((a) => a.id)
      }),
    [asset.id, selectedIds, folderViewAssetId, visible]
  )
  const position = quickLookIndexInSequence(sequence, asset.id)

  const escDepth = useEscLayer(onClose, true)

  /** 图片加载失败（按 src 记录，与 AssetGrid 的 `Cover` 同手法：src 一变自然复位） */
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const url = quickLookImageUrl(asset)

  /** ←/→：到边界不 wrap（`stepSequence` 夹在原地），目标必须还在索引里 */
  const step = useCallback(
    (delta: number) => {
      const i = quickLookIndexInSequence(sequence, asset.id)
      if (i < 0) return
      const next = stepSequence(sequence, i, delta)
      if (!next || next === asset.id) return
      openQuickLook(next)
    },
    [sequence, asset.id, openQuickLook]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 键位判据全部在 `logic/quickLook.ts::decideQuickLookKey`（纯函数、可单测）：
      // 空格 / `Spacebar` = 关闭（用户 2026-10-28 口径：开也空格、关也空格/Esc），
      // ←/→ = 换图；`repeat` / 修饰键 / 非栈顶一律让路。这里只做 dispatch。
      const action = decideQuickLookKey({
        key: e.key,
        typing: isTypingTarget(e.target),
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat,
        layerDepth: getEscLayerDepth()
      })
      if (action === 'none') return
      // 三个动作都要吃掉浏览器默认行为：空格会滚动画布、方向键会滚容器
      e.preventDefault()
      if (action === 'close') {
        // 关浮层**不清选中**（与 Esc 同一语义，第二次 Esc 才清选中）
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

  const category = categoriesOf(asset)
  const Icon = KIND_ICON[asset.kind] ?? IconOther

  return (
    <div
      className={`dialog-scrim quicklook-scrim fixed inset-0 ${zClassForDepth(escDepth)} flex flex-col items-center justify-center p-6`}
      role="dialog"
      aria-modal="true"
      aria-label={`快览：${asset.name}`}
      onPointerDown={(e) => {
        // 点遮罩关闭（浮层本体 stopPropagation）
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button
        className="btn btn-ghost absolute right-5 top-5 p-1.5 text-secondary transition hover:text-primary"
        onClick={onClose}
        title="关闭（Esc）"
        aria-label="关闭快览"
      >
        <IconClose />
      </button>

      {/* 主视图：**固定画框**（尺寸不随图片大小变化），细节见下面那段注释。 */}
      <div
        className="flex min-h-0 w-full max-w-[min(92vw,1100px)] flex-col items-center justify-center"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 主视图：**固定画框**（用户 2026-10-28 反馈：「不清晰的图片显示的小一些，清晰的图片显示的
            大一些，在 UI 上看着很不统一」）。

            做法：画框尺寸**恒定**（父级已限宽 min(92vw,1100px)，这里钉高 min(76vh,720px)），
            图片 `h-full w-full object-contain` —— 小于画框的等比放大、大于画框的等比缩小，
            **框永远是同一个**。信息行与底部提示因此也永远落在同一高度，这才是"统一"的实感，
            不只是图大小一致。

            ⛔ 不要退回 `max-h-[80vh] max-w-full` + 自然尺寸那种写法：那样每张图各占各的大小，
            小图和 4K 主图在屏幕上差几十倍，按 ←/→ 翻页时整块版面跟着跳。
            放大换来的模糊是可接受代价（真实资产 ≥256px，720 高最多约 2.8×）；
            **版面跳动**才是不可接受的。 */}
        <div
          data-quicklook-stage="1"
          className="flex h-[min(76vh,720px)] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-panel"
        >
          {url && brokenSrc !== url ? (
            <img
              data-quicklook-image="1"
              src={url}
              alt={asset.name}
              onError={() => setBrokenSrc(url)}
              className="h-full w-full object-contain"
            />
          ) : (
            // 无图 / 加载失败：占位**也吃同一个画框** —— 否则「有图 / 无图」两种资产尺寸不同，
            // 翻到无封面那条时版面又会跳一下。图标居中，色取 tertiary。
            <div className="flex h-full w-full items-center justify-center text-tertiary">
              <Icon width={64} height={64} />
            </div>
          )}
        </div>

        {/* 信息行：名称 / 分类路径 / 大小 / 文件数。不放编辑控件。 */}
        <div className="mt-4 w-full max-w-[min(92vw,1100px)] text-center">
          <div className="truncate text-[14px] font-semibold text-primary" title={asset.name}>
            {asset.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-secondary">
            <span className="text-accent-text">{KIND_LABEL[asset.kind]}</span>
            <span className="text-muted">·</span>
            <span>
              {category.category1} / {category.category2}
            </span>
            <span className="text-muted">·</span>
            <span className="tabular-nums">{formatBytes(asset.size)}</span>
            <span className="text-muted">·</span>
            <span className="tabular-nums">{asset.files.length} 个文件</span>
          </div>
        </div>

        {/* 底部提示行：n / m 只在"序列来自选中集（≥2）"时出现 */}
        <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-tertiary">
          <span>← → 切换 · 空格 / Esc 退出</span>
          {sequence.length >= 2 && position >= 0 && (
            <span className="tabular-nums">
              {position + 1} / {sequence.length}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
