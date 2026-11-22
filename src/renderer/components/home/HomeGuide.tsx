/**
 * V1.0 首页分步引导（docs/55 §2.3 / §4-T4，拍板 Q-13/Q-14/Q-15）。
 *
 * ── 职责边界 ─────────────────────────────────────────────────────────────────
 * 本组件只读四件真值：
 *   1. `data-guide` 锚点的实时 `getBoundingClientRect()`（视口坐标，直接喂 fixed 层）；
 *   2. `version`（由 App 从 `window.modvault.getAppVersion()` 取来，非空才挂本组件）；
 *   3. `dontShowAgain`（本组件内的复选框 state，**默认 false**）；
 *   4. `saveSettings`（App 透传的 store 写入口）。
 *
 * 不读 store、不改首页布局、不进 Esc 层栈：它有自己的「跳过 / 下一步 / 完成」按钮，
 * 不是一层需要 Esc 逐层退出的弹窗。z 层只走 `logic/zStack.ts` 的 `Z_HOME_GUIDE`。
 *
 * ── 三个写位分支（严格三选一，绝不互写 D-2 两字段）──────────────────────────
 *   · 跳过（本次）：**一个字段都不写** —— 只本地关闭，下次启动还会来；
 *   · 走完最后一步：`homeGuideFirstRunShown: true` + `homeGuideLastVersion: version`；
 *   · 勾「下次不再显示」+ 任意关闭：**仅** `homeGuideDisabled: true`。
 *
 * ── 为什么没有 CSS 文件 ──────────────────────────────────────────────────────
 * 一次性浮层，全部样式集中在下面的内联 style 对象里：既不动任何既有组件的布局，
 * 也不会给主题样式表新增一条全局规则。颜色只走主题 token（`--accent` 等），
 * 图标全部是内联 SVG + currentColor，零外链、零新增依赖、零紫色。
 */
import { useCallback, useEffect, useId, useState } from 'react'
import { Z_HOME_GUIDE } from '../../logic/zStack'

/** 触发判定所需的最小设置切片（tests/homeGuideWiring.test.ts 直接跑真值表）。 */
export interface HomeGuideSettings {
  homeGuideFirstRunShown: boolean
  homeGuideLastVersion: string | null
  homeGuideDisabled: boolean
}

/**
 * 是否展示首页引导：未永久关闭，且（从未展示过 **或** 上次记录的版本与当前版本不同）。
 *
 * 版本按**字符串不等**判定，不做 semver 排序（架构师定，零依赖）；脏值如空串只由
 * 调用方挡掉（App 取到真实版本后才挂载），这里保持纯函数、不猜当前版本。
 */
export function shouldShowHomeGuide(settings: HomeGuideSettings, currentVersion: string): boolean {
  return (
    !settings.homeGuideDisabled &&
    (!settings.homeGuideFirstRunShown || settings.homeGuideLastVersion !== currentVersion)
  )
}

/** 四步的真实锚点键，顺序即引导顺序（`stats` 可能被条件渲染关掉）。 */
export type GuideStepKey = 'search' | 'folders' | 'stats' | 'settings'

/** 一步的展示文案。 */
export interface GuideStep {
  key: GuideStepKey
  title: string
  body: string
}

/** 视口坐标矩形（`getBoundingClientRect()` 的四个字段，够用就好）。 */
export interface HighlightRect {
  top: number
  left: number
  width: number
  height: number
}

/** 引导只认这四段文案；改文案不需要动坐标逻辑。 */
const GUIDE_STEPS: readonly GuideStep[] = [
  {
    key: 'search',
    title: '搜到任何东西',
    body: '从这里搜模型、材质和 HDRI；敲下关键词，结果直接浮在下方。'
  },
  {
    key: 'folders',
    title: '一键进素材库',
    body: '四个文件夹就是四条捷径，点一下直接进对应类型，不用先翻筛选。'
  },
  {
    key: 'stats',
    title: '看懂库里有什么',
    body: '这张卡汇总本月入库、库总量和待补分类；设置里可以随时把它收起。'
  },
  {
    key: 'settings',
    title: '设置永远在左下',
    body: '主题、库目录、动效和首页自定义都在这里，随时回来调整。'
  }
]

/** 高亮框相对锚点四边外扩的像素数（设计要求 4~6px）。 */
const HIGHLIGHT_PADDING = 5

/** 高亮框 / 镂空的圆角半径。 */
const HIGHLIGHT_RADIUS = 12

/** 提示卡的最大宽度（窄窗口收窄，不溢出屏幕）。 */
const TOOLTIP_WIDTH = 320

/**
 * 量一个锚点：找不到、或不可见（宽高为 0）都返回 `null`。
 *
 * `showHomeStats=false` 时 `stats` 元素压根不存在，这里自然返回 `null` → 过滤该步；
 * 四步全缺时组件渲染 `null`（兜底，不会留下一层点不掉的遮罩）。
 */
export function measureStep(key: GuideStepKey): HighlightRect | null {
  if (typeof document === 'undefined') return null
  const element = document.querySelector(`[data-guide="${key}"]`)
  if (!element) return null
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

/** 运行时可用的步骤：按真实 DOM 过滤，顺序仍以 `GUIDE_STEPS` 为准。 */
function availableStepKeys(): GuideStepKey[] {
  return GUIDE_STEPS.filter((step) => measureStep(step.key) !== null).map((step) => step.key)
}

function sameKeys(a: readonly GuideStepKey[], b: readonly GuideStepKey[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

function sameRect(a: HighlightRect | null, b: HighlightRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

/** HomeGuide 允许写入的设置字段 —— 类型层面就把 D-2 两个字段挡在门外。 */
export interface HomeGuideSettingsPatch {
  homeGuideFirstRunShown?: boolean
  homeGuideLastVersion?: string | null
  homeGuideDisabled?: boolean
}

/** 由 App 注入（store 的 `saveSettings` 天然满足这个签名）。 */
export interface HomeGuideProps {
  version: string
  saveSettings: (patch: HomeGuideSettingsPatch) => Promise<void>
  onDismissed: () => void
}

interface GuideView {
  available: GuideStepKey[]
  current: GuideStepKey | null
  rect: HighlightRect | null
}

/** 初次渲染就量一次，避免首帧出现「遮罩在、高亮框还没到」的闪动。 */
function initialView(): GuideView {
  const available = availableStepKeys()
  const current = available[0] ?? null
  return { available, current, rect: current ? measureStep(current) : null }
}

/** 单色线性图标（24 格，currentColor 跟随主题）。 */
function StepIcon({ stepKey }: { stepKey: GuideStepKey }): JSX.Element {
  const svg = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (stepKey === 'search') {
    return (
      <svg {...svg}>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="M16 16l4.5 4.5" />
      </svg>
    )
  }
  if (stepKey === 'folders') {
    return (
      <svg {...svg}>
        <path d="M3.5 7.5h6l2 2.2h9v9a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-10a1.5 1.5 0 0 1 1-1.2z" />
        <path d="M3.5 10h17" />
      </svg>
    )
  }
  if (stepKey === 'stats') {
    return (
      <svg {...svg}>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M7.5 9.5h9M7.5 13h5" />
      </svg>
    )
  }
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" />
    </svg>
  )
}

/**
 * 首页引导浮层。
 *
 * StrictMode 双挂载安全：`resize` 监听与 `ResizeObserver` 在 effect cleanup 里全部拆掉；
 * `recalc()` 用函数式 setState + 值相等短路，避免 observer 触发自身重渲染死循环。
 */
export function HomeGuide({ version, saveSettings, onDismissed }: HomeGuideProps): JSX.Element | null {
  const [view, setView] = useState<GuideView>(initialView)
  // 默认不勾：任何"进入即 true"的路径都会让用户被永久关掉引导。
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [closed, setClosed] = useState(false)
  const maskId = `home-guide-mask-${useId().replace(/:/g, '')}`

  /** 重算可用步骤 + 当前步矩形；尺寸没变时返回原 state，不触发渲染。 */
  const recalc = useCallback(() => {
    setView((prev) => {
      const available = availableStepKeys()
      const current =
        prev.current !== null && available.includes(prev.current) ? prev.current : (available[0] ?? null)
      const rect = current ? measureStep(current) : null
      if (sameKeys(prev.available, available) && prev.current === current && sameRect(prev.rect, rect)) {
        return prev
      }
      return { available, current, rect }
    })
  }, [])

  useEffect(() => {
    if (closed) return undefined
    recalc()
    window.addEventListener('resize', recalc)
    const observer = new ResizeObserver(recalc)
    for (const step of GUIDE_STEPS) {
      const element = document.querySelector(`[data-guide="${step.key}"]`)
      if (element) observer.observe(element)
      if (element && element.parentElement) observer.observe(element.parentElement)
    }
    return () => {
      window.removeEventListener('resize', recalc)
      observer.disconnect()
    }
  }, [closed, recalc])

  /** 唯一的关闭出口：completed=false 且未勾选时一个字段都不写。 */
  const closeGuide = (completed: boolean): void => {
    if (dontShowAgain) {
      void saveSettings({ homeGuideDisabled: true }).catch(() => undefined)
    } else if (completed) {
      void saveSettings({
        homeGuideFirstRunShown: true,
        homeGuideLastVersion: version
      }).catch(() => undefined)
    }
    setClosed(true)
    onDismissed()
  }

  const skipGuide = (): void => closeGuide(false)
  const finishGuide = (): void => closeGuide(true)

  const goToStep = (delta: number): void => {
    setView((prev) => {
      if (prev.current === null) return prev
      const index = prev.available.indexOf(prev.current)
      const next = prev.available[index + delta]
      if (!next) return prev
      return { ...prev, current: next, rect: measureStep(next) }
    })
  }

  if (closed || view.current === null || view.rect === null || view.available.length === 0) return null

  const step = GUIDE_STEPS.find((candidate) => candidate.key === view.current)
  if (!step) return null

  const rect = view.rect
  const index = Math.max(0, view.available.indexOf(view.current))
  const isLast = index === view.available.length - 1
  const highlight = {
    left: rect.left - HIGHLIGHT_PADDING,
    top: rect.top - HIGHLIGHT_PADDING,
    width: rect.width + HIGHLIGHT_PADDING * 2,
    height: rect.height + HIGHLIGHT_PADDING * 2
  }

  // 提示卡优先放在锚点下方；下方空间不够则翻到上方。两处都夹在视口内。
  const cardWidth = Math.min(TOOLTIP_WIDTH, Math.max(200, window.innerWidth - 24))
  const cardHeight = 196
  const gap = HIGHLIGHT_PADDING + 12
  const roomBelow = window.innerHeight - (rect.top + rect.height + gap)
  const cardTop =
    roomBelow >= cardHeight + 12
      ? rect.top + rect.height + gap
      : Math.max(12, rect.top - cardHeight - gap)
  const cardLeft = Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12))

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: Z_HOME_GUIDE }}>
      {/* 点遮罩等同「跳过（本次）」：勾选了「下次不再显示」时仍走 disabled 分支。 */}
      <div
        aria-hidden="true"
        onClick={skipGuide}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)' }}
      />

      {/* 真镂空：SVG mask 把锚点那块从半透明遮罩里挖掉，底下的首页元素保持原亮度。 */}
      <svg
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />
            <rect
              x={highlight.left}
              y={highlight.top}
              width={highlight.width}
              height={highlight.height}
              rx={HIGHLIGHT_RADIUS}
              fill="#000000"
            />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.42)"
          mask={`url(#${maskId})`}
        />
      </svg>

      {/* 2px 系统蓝描边 + 5px 外扩，坐标取视口坐标（与 fixed 同坐标系）。 */}
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: highlight.left,
          top: highlight.top,
          width: highlight.width,
          height: highlight.height,
          border: '2px solid var(--accent)',
          borderRadius: HIGHLIGHT_RADIUS,
          boxShadow: '0 0 0 3px rgba(0,122,255,0.18)',
          pointerEvents: 'none'
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${maskId}-title`}
        onClick={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          top: cardTop,
          left: cardLeft,
          width: cardWidth,
          boxSizing: 'border-box',
          padding: '18px 20px 16px',
          background: 'var(--surface-card)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-panel)',
          borderRadius: 14,
          boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
          fontFamily: 'inherit'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>
            <StepIcon stepKey={step.key} />
          </span>
          <h2 id={`${maskId}-title`} style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {step.title}
          </h2>
          <button
            type="button"
            aria-label="关闭引导"
            title="关闭引导"
            onClick={skipGuide}
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              border: 0,
              borderRadius: 7,
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer'
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <p
          style={{
            margin: '10px 0 0',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--text-secondary)'
          }}
        >
          {step.body}
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14
          }}
        >
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-secondary)',
              cursor: 'pointer'
            }}
          >
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => setDontShowAgain(event.target.checked)}
              style={{ width: 14, height: 14, margin: 0, accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            下次不再显示
          </label>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {index + 1} / {view.available.length}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={skipGuide}
            style={{
              padding: '6px 10px',
              fontSize: 12,
              border: 0,
              borderRadius: 7,
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer'
            }}
          >
            跳过（本次）
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            {index > 0 ? (
              <button
                type="button"
                onClick={() => goToStep(-1)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  padding: '6px 10px',
                  fontSize: 12,
                  border: 0,
                  borderRadius: 7,
                  background: 'var(--tint-neutral)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer'
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14.5 5 7.5 12l7 7" />
                </svg>
                上一步
              </button>
            ) : null}
            <button
              type="button"
              onClick={isLast ? finishGuide : () => goToStep(1)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 500,
                border: 0,
                borderRadius: 7,
                background: 'var(--accent)',
                color: '#ffffff',
                cursor: 'pointer'
              }}
            >
              {isLast ? '完成' : '下一步'}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9.5 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
