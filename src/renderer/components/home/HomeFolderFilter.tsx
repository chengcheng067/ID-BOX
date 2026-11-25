/**
 * 主页文件夹区上方的类别筛选气泡（逆向 shadcnblocks gallery10 的 "Browse by type"）。
 *
 * 交互语义（用户 2026-11-26 拍板）：气泡是**主页内的筛选器**，不是跳转按钮 ——
 * 点「素材板块」这排只留素材大类卡，点「项目文件夹」只留钉选磁盘文件夹卡
 * （且该档额外带一张「新建项目」虚卡），点「全部」都显示，**全程不离开主页**。
 *
 * 逆向的动效（照 gallery10）：
 *   ① 深色实心高亮 pill 滑到选中气泡（transform translateX + width 过渡，非瞬切）；
 *   ② 切换类别 → 卡片以错峰淡入上浮重挂载（由 HomeCover 的 key 带筛选值实现，见那边注释）；
 *   ③ 平滑档 / 系统减少动效 → pill 无过渡（卡片侧由 HomeCover 用 reduced 守卫）。
 *
 * 卡片错峰与滑动高亮分开管：本组件只负责 pill 的几何测量与滑动；卡片入场在
 * HomeCover + GlassFolder 自己的入场体系里，避免两套动画互相打架。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './home-folder-filter.css'

export type HomeFolderFilterValue = 'all' | 'kind' | 'pin'

export const HOME_FOLDER_FILTER_ITEMS: ReadonlyArray<{
  value: HomeFolderFilterValue
  label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'kind', label: '素材板块' },
  { value: 'pin', label: '项目文件夹' }
]

interface HomeFolderFilterProps {
  value: HomeFolderFilterValue
  onChange: (value: HomeFolderFilterValue) => void
  /** 各档实际可见卡数，气泡上显示；某档为 0 时气泡禁点（gallery10 类别从数据生成） */
  counts: Record<HomeFolderFilterValue, number>
  /** 平滑档 / 系统减少动效：pill 直接落到目标、无滑动 */
  motion: boolean
}

interface PillGeom {
  left: number
  width: number
}

export function HomeFolderFilter({
  value,
  onChange,
  counts,
  motion
}: HomeFolderFilterProps): JSX.Element | null {
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [pill, setPill] = useState<PillGeom>({ left: 0, width: 0 })
  const [ready, setReady] = useState(false)

  /** 量选中气泡相对容器的位置/宽度（纯 getBoundingClientRect，无布局写入） */
  const measure = useCallback((): void => {
    const wrap = wrapRef.current
    const btn = btnRefs.current[HOME_FOLDER_FILTER_ITEMS.findIndex((i) => i.value === value)]
    if (wrap === null || btn === null || btn === undefined) return
    const w = wrap.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    setPill({ left: b.left - w.left, width: b.width })
  }, [value])

  useLayoutEffect(() => {
    measure()
    setReady(true)
  }, [measure])

  // 窗口缩放 / 字体加载后气泡宽度变了 → 重新量（ResizeObserver 观察容器即可）
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [measure])

  return (
    <div className="hff-root" data-guide="folder-filter">
      <div ref={wrapRef} className="hff-track" role="tablist" aria-label="文件夹类别">
        <span
          className="hff-pill"
          data-ready={ready ? 'true' : 'false'}
          data-motion={motion ? 'true' : 'false'}
          aria-hidden="true"
          style={{ transform: `translateX(${pill.left}px)`, width: `${pill.width}px` }}
        />
        {HOME_FOLDER_FILTER_ITEMS.map((item, index) => {
          const count = counts[item.value]
          return (
            <button
              key={item.value}
              ref={(el) => {
                btnRefs.current[index] = el
              }}
              type="button"
              role="tab"
              aria-selected={value === item.value}
              className="hff-chip"
              data-active={value === item.value ? 'true' : 'false'}
              disabled={count === 0}
              onClick={() => onChange(item.value)}
            >
              {item.label}
              <span className="hff-count">{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
