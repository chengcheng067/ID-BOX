/**
 * 浏览器条目的**自绘类型徽标**（缩略图失败 / 不支持时的兜底视觉）。
 *
 * 视觉口径对齐 `AssetGrid.FileCover` 的四张品牌大字卡：`.skp`→SU（系统蓝）、
 * `.max`→max（3ds Max 青蓝）、`.dwg`/`.dxf`→CAD（AutoCAD 红）、`.d5a`→D5A（品牌紫）。
 * 颜色全走 token（`bg-accent-tint`/`text-accent`、`text-max`、`text-cad`、`text-d5`），
 * 深色版由 token 自带 —— 不写死任何 hex。判定纯函数在
 * `logic/pinnedBrowser.ts#fileTypeBadgeOf`（有单测），这里只消费。
 *
 * 字号写 **SVG user unit**（viewBox 100×100，38 = 画幅的 38%）：不依赖容器尺寸，
 * 16px 列表行与全屏 Quick Look 等比缩放、永不溢出。`max` 用 52 + `textLength=96`
 * 是小写 x-height 的补偿（与 FileCover 同一组实测值，理由见那边注释，不重复抄）。
 */
import type { ReactElement } from 'react'
import { IconFile, IconFolder, IconImage } from '../../icons'
import { fileTypeBadgeOf } from '../../logic/pinnedBrowser'

export interface PinnedTypeVisualProps {
  name: string
  isDir: boolean
  /** 徽标 / 图标的渲染尺寸（svg 宽高；fill 容器里传容器内径或更大均可） */
  size?: number
  /** 追加的定位类（调用方需要绝对定位等时用） */
  className?: string
}

export function PinnedTypeVisual({
  name,
  isDir,
  size = 16,
  className = ''
}: PinnedTypeVisualProps): ReactElement {
  // 目录：文件夹图标，accent 色（与现有列表行 / 图标磁贴同色）
  if (isDir) {
    return (
      <span className={`flex items-center justify-center text-accent ${className}`}>
        <IconFolder width={size} height={size} />
      </span>
    )
  }
  const badge = fileTypeBadgeOf({ name, isDir: false })
  if (badge === null) {
    // 不可达（isDir=false 不会返回 null）；保留兜底防未来判定改动
    return (
      <span className={`flex items-center justify-center ${className}`}>
        <IconFile width={size} height={size} />
      </span>
    )
  }
  // 图片 / 通用文件：类型图标，**继承调用方文字色**（列表行 tertiary、磁贴 secondary）
  if (badge.tone === 'image') {
    return (
      <span className={`flex items-center justify-center ${className}`}>
        <IconImage width={size} height={size} />
      </span>
    )
  }
  if (badge.tone === 'generic') {
    return (
      <span className={`flex items-center justify-center ${className}`}>
        <IconFile width={size} height={size} />
      </span>
    )
  }
  // 品牌大字卡：tint 由调用方容器给（图标磁贴已有底），这里只定字色
  const toneClass =
    badge.tone === 'su' ? 'text-accent' : badge.tone === 'max' ? 'text-max' : badge.tone === 'cad' ? 'text-cad' : 'text-d5'
  return (
    <span className={`flex items-center justify-center ${toneClass} ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        aria-hidden="true"
        focusable="false"
      >
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={badge.tone === 'max' ? 52 : 38}
          fontWeight="700"
          letterSpacing="-0.02em"
          fill="currentColor"
          {...(badge.tone === 'max'
            ? { textLength: 96, lengthAdjust: 'spacingAndGlyphs' as const }
            : {})}
        >
          {badge.label}
        </text>
      </svg>
    </span>
  )
}

export default PinnedTypeVisual
