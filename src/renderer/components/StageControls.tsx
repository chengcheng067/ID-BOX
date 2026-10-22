/**
 * 舞台浮层控制条（docs/19 裁定① 配套，A 线）。
 *
 * 形态：顶栏球右侧的一张小浮层，只放**三件**——反光强度、凹凸强度、「保存为封面」。
 * 它与 `MaterialBall` 里那套内嵌面板**不共用 DOM**：
 * - `chrome='full'`（CustomRenderDialog）继续用 `MaterialBall` 内部那份（本批没动它）；
 * - `chrome='bare'`（舞台）旁边挂本组件；
 * - 两边共用同一份 `BallParamScales` 类型（来自 `shared/ballParams`），所以参数语义一致。
 *
 * 纪律：
 * - **不读 store、不读 settings**：数据（params / 落盘回调）全部由父层传；
 * - 定位只用 `anchorRect` 算，不写死像素（见 `logic/stageControls.placeBeside`）；
 * - 本组件当前**没有被任何地方 import**（接线是下一批）。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { BallParamScales } from '../../shared/ballParams'
import { anchorUsable, placeBeside } from '../logic/stageControls'

export interface StageControlsProps {
  /** 当前参数（受控；父层持有，通常来自 renderParams） */
  params: BallParamScales
  /** 任一滑块变化 → 抛给父层（父层负责防抖落库，组件不写库） */
  onChange: (next: BallParamScales) => void
  /** 保存为封面；不传 = 不显示按钮（与内嵌面板同语义） */
  onSaveCover?: (() => void) | null
  /** 关闭浮层（Esc / 点 ×），父层把显隐状态收掉 */
  onClose: () => void
  /** 顶栏球的矩形（每帧/每次落定后由父层量好传入）；null = 还没落定 */
  anchorRect: DOMRect | null
  /** 保存按钮是否处于渲染中（父层给） */
  saving?: boolean
}

const PANEL_W = 208
const PANEL_H = 108

export function StageControls({
  params,
  onChange,
  onSaveCover,
  onClose,
  anchorRect,
  saving = false
}: StageControlsProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: PANEL_W, height: PANEL_H })

  // 首帧量一次真实尺寸（内容可能因缩放/字体变化），之后按真实宽高夹视口
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      setSize((prev) =>
        Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5
          ? prev
          : { width: r.width, height: r.height }
      )
    }
  }, [params.roughness, params.bump, !!onSaveCover])

  const viewport =
    typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }

  const anchor = anchorUsable(anchorRect) ? anchorRect : null
  const pos = placeBeside(anchor, size, viewport)

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="材质球快速调参"
      className="fixed z-[61] w-52 rounded-xl border border-line bg-card/95 p-3 text-[11px] shadow-pop"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-primary">快速调参</span>
        <button
          type="button"
          className="text-muted transition hover:text-primary"
          title="收起"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <label className="block">
        <span className="flex items-baseline justify-between text-muted">
          反光强度
          <span className="font-medium text-primary">×{params.roughness.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={params.roughness}
          className="slider-accent mt-1 w-full"
          title="roughness 倍率：越大越哑光（0 = 镜面）"
          onChange={(e) => onChange({ ...params, roughness: Number(e.target.value) })}
        />
      </label>

      <label className="mt-2 block">
        <span className="flex items-baseline justify-between text-muted">
          凹凸强度
          <span className="font-medium text-primary">×{params.bump.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={params.bump}
          className="slider-accent mt-1 w-full"
          title="法线 / 置换倍率：越大凹凸越明显（0 = 拍平）"
          onChange={(e) => onChange({ ...params, bump: Number(e.target.value) })}
        />
      </label>

      {onSaveCover && (
        <button
          type="button"
          className="btn btn-primary mt-3 w-full !py-1 text-[11px]"
          disabled={saving}
          title="按当前参数离屏渲染一帧，存为该资产封面"
          onClick={() => onSaveCover()}
        >
          {saving ? '渲染中…' : '保存为封面'}
        </button>
      )}
    </div>
  )
}
