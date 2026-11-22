/**
 * T4 首页引导（docs/55 §2.3 / §4-T4）接线守卫 + 纯函数单测。
 *
 * ## 为什么主要是源码守卫
 * `vitest.config.ts` 固定 `environment: 'node'`，全仓无 jsdom / RTL（T2 的
 * `tests/homeCustomWiring.test.ts` 同款范式）：读文件文本断言接线点，
 * **行为**由本文件对 `shouldShowHomeGuide()` 的真跑用例兜住，不写 DOM 渲染测试。
 *
 * ## 每条守卫防的具体退化
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | 1 | App 取版本 + 挂载条件 | 版本没接 / 首帧 '' 闪现 / 引导没和 HomeCover 同级 |
 * | 2 | 四步键 + 测量 + 监听 | 锚点丢失仍渲染 / resize 后高亮错位 / StrictMode 泄漏 |
 * | 3 | 三个写位分支 | 跳过写库 / 完成漏记版本 / 勾选项被预填 true |
 * | 4 | D-2 零互写 | 引导顺手写了插件引导两字段（S-2） |
 * | 5 | z 层 + 零外链 + 不复用紫 | 层级失控 / 外链图片 / 紫色扩散（S-5/S-7） |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shouldShowHomeGuide } from '../src/renderer/components/home/HomeGuide'

/** 相对仓库根读源码，换行归一（工作区 CRLF，切片断言不能被换行符干扰）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：本仓注释里就写着要防的东西，不剥会误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 取函数从 `{` 到配对 `}` 的函数体（大括号计数，用于精确看写位分支）。 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `找不到函数签名：${signature}`).toBeGreaterThanOrEqual(0)
  const brace = src.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(brace, i + 1)
    }
  }
  throw new Error(`函数大括号不配对：${signature}`)
}

const APP_CODE = stripComments(readSrc('src/renderer/App.tsx'))
const GUIDE = readSrc('src/renderer/components/home/HomeGuide.tsx')
const GUIDE_CODE = stripComments(GUIDE)
const Z_STACK = readSrc('src/renderer/logic/zStack.ts')
const HOME_STATS = readSrc('src/renderer/components/home/HomeStats.tsx')
const HOME_COVER = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))

describe('T4 · shouldShowHomeGuide 真值表（Q-13 / S-1）', () => {
  type Settings = Parameters<typeof shouldShowHomeGuide>[0]
  const VERSION = '1.2.3'
  const base: Settings = {
    homeGuideFirstRunShown: false,
    homeGuideLastVersion: null,
    homeGuideDisabled: false
  }

  it('首启：从未展示 → 显示', () => {
    expect(shouldShowHomeGuide(base, VERSION)).toBe(true)
  })

  it('新版本：上次展示过但版本字符串不同 → 显示', () => {
    expect(
      shouldShowHomeGuide({ ...base, homeGuideFirstRunShown: true, homeGuideLastVersion: '1.2.2' }, VERSION)
    ).toBe(true)
  })

  it('已禁用：永久关闭位优先，任何版本都不显示', () => {
    expect(shouldShowHomeGuide({ ...base, homeGuideDisabled: true }, VERSION)).toBe(false)
    expect(
      shouldShowHomeGuide(
        { homeGuideDisabled: true, homeGuideFirstRunShown: true, homeGuideLastVersion: '0.0.1' },
        VERSION
      )
    ).toBe(false)
  })

  it('相同版本：首启位与版本位都已就位 → 不显示', () => {
    expect(
      shouldShowHomeGuide({ ...base, homeGuideFirstRunShown: true, homeGuideLastVersion: VERSION }, VERSION)
    ).toBe(false)
  })

  it('脏值回落：首启位为 false 但版本位相同也显示；首启位 true 但版本位缺失同样显示', () => {
    expect(
      shouldShowHomeGuide({ ...base, homeGuideLastVersion: VERSION }, VERSION)
    ).toBe(true)
    expect(
      shouldShowHomeGuide({ ...base, homeGuideFirstRunShown: true }, VERSION)
    ).toBe(true)
  })
})

describe('T4 · App 触发与挂载守卫', () => {
  it('版本来自 getAppVersion，首帧空串不触发，满足 isHome && ready && shouldShow', () => {
    expect(APP_CODE).toContain('getAppVersion()')
    expect(APP_CODE).toContain('shouldShowHomeGuide(')
    expect(APP_CODE).toContain('appVersion !==')
    expect(APP_CODE).toContain('guideDismissedThisSession')
    expect(APP_CODE).toMatch(/isHome\s*&&\s*ready\s*&&/s)
  })

  it('HomeGuide 与 HomeCover 同级挂载，T2 三个 props 一个都不动', () => {
    expect(APP_CODE).toContain('<HomeGuide')
    expect(APP_CODE).toContain('onDismissed={() => setGuideDismissedThisSession(true)}')
    expect(APP_CODE).toContain('waveColors={stableHomeWaveColors}')
    expect(APP_CODE).toContain('waveHeight={safeHomeWaveHeight}')
    expect(APP_CODE).toContain('homeBackground={stableHomeBackground}')
  })
})

describe('T4 · 四步高亮与坐标联动守卫（Q-14）', () => {
  it('四步键齐全，且 stats 锚点是 HomeStats 的根 section（不改包含块）', () => {
    for (const key of ['search', 'folders', 'stats', 'settings']) {
      expect(GUIDE_CODE, `缺少引导步：${key}`).toContain(`key: '${key}'`)
    }
    expect(HOME_STATS).toMatch(/<section[^>]*data-guide="stats"[^>]*>/)
    // T2 预留的三处纯属性锚点仍在，且本任务不改 HomeCover 的布局。
    for (const key of ['search', 'folders', 'settings']) {
      expect(HOME_COVER).toContain(`data-guide="${key}"`)
    }
  })

  it('按 data-guide 量实时矩形，resize + ResizeObserver 双通道重算并完整 cleanup', () => {
    expect(GUIDE_CODE).toContain('[data-guide="')
    expect(GUIDE_CODE).toContain('getBoundingClientRect()')
    expect(GUIDE_CODE).toContain("window.addEventListener('resize', recalc)")
    expect(GUIDE_CODE).toContain('new ResizeObserver(recalc)')
    expect(GUIDE_CODE).toContain("window.removeEventListener('resize', recalc)")
    expect(GUIDE_CODE).toContain('observer.disconnect()')
    expect(GUIDE_CODE).toContain("position: 'fixed'")
    expect(GUIDE_CODE).toContain('2px solid var(--accent)')
  })
})

describe('T4 · 三个写位分支与 D-2 零互写（Q-15 / S-2）', () => {
  it('关闭出口严格三选一：跳过不写库、完成写双位、勾选仅写 disabled', () => {
    const closeBody = functionBody(GUIDE_CODE, 'const closeGuide = (completed: boolean): void =>')
    expect(closeBody).toContain('if (dontShowAgain)')
    expect(closeBody).toContain('saveSettings({ homeGuideDisabled: true })')
    expect(closeBody).toContain('homeGuideFirstRunShown: true')
    expect(closeBody).toContain('homeGuideLastVersion: version')
    expect(closeBody.match(/saveSettings\(/g)).toHaveLength(2)
    // "跳过（本次）"自己不发写请求；未勾选时 closeGuide(false) 两个分支都不命中。
    expect(functionBody(GUIDE_CODE, 'const skipGuide = (): void =>')).not.toContain('saveSettings')
    expect(functionBody(GUIDE_CODE, 'const finishGuide = (): void =>')).not.toContain('saveSettings')
  })

  it('勾选项默认不勾，源码没有 defaultChecked / 预填 true 路径', () => {
    expect(GUIDE_CODE).toContain('useState(false)')
    expect(GUIDE_CODE).toContain('checked={dontShowAgain}')
    expect(GUIDE_CODE).not.toMatch(/defaultChecked/)
    expect(GUIDE_CODE).not.toMatch(/\b(?:checked|dontShowAgain)\s*=\s*\{?\s*true\b/)
  })

  it('引导代码绝不写 D-2 两字段', () => {
    for (const token of ['pluginIndexGuideShown', 'pluginIndexEnabled']) {
      expect(GUIDE_CODE, `HomeGuide 出现 ${token}`).not.toContain(token)
      expect(APP_CODE, `App 出现 ${token}`).not.toContain(token)
    }
  })
})

describe('T4 · z 层 / 内联 SVG / 零外链与紫色守卫（S-5 / S-7）', () => {
  it('zStack.ts 导出 Z_HOME_GUIDE = 100，组件内联取这个常量', () => {
    expect(Z_STACK).toMatch(/export const Z_HOME_GUIDE = 100/)
    expect(GUIDE_CODE).toContain('Z_HOME_GUIDE')
    expect(GUIDE_CODE).toContain('zIndex: Z_HOME_GUIDE')
  })

  it('无外链图片 / 网络请求，图标走 currentColor，新代码不使用紫色', () => {
    expect(GUIDE_CODE).not.toMatch(/<img\b/)
    expect(GUIDE_CODE).not.toMatch(/https?:\/\//)
    expect(GUIDE_CODE).toContain('stroke: \'currentColor\'')
    expect(GUIDE_CODE).not.toContain('--d5-brand')
    expect(GUIDE_CODE).not.toMatch(/purple|violet|紫/i)
    // 连 #ffffff / #000000 这样的中性色之外，新代码不出现任何彩色 hex。
    const hexes = GUIDE_CODE.match(/#[\da-f]{3,8}\b/gi) ?? []
    expect(hexes.map((hex) => hex.toLowerCase()).filter((hex) => hex !== '#ffffff' && hex !== '#000000')).toEqual([])
  })
})
