/**
 * 顶层错误边界守卫（`src/renderer/logic/errorReport.ts` + `components/ErrorBoundary.tsx`）。
 *
 * ## 为什么没有渲染测试
 *
 * `vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL（docs/35 §9.4 明令不引入）。
 * 所以这里沿 `tests/kindFolderWiring.test.ts` / `tests/classifyUiWiring.test.ts` 的范式：
 *   - **A**：`formatErrorReport` / `describeError` 是纯函数 → 真跑，表驱动把「任意抛出物」
 *     的极端形态（`null` / 字符串 / 循环引用 / `Object.create(null)` / getter 抛错）逐个钉住；
 *   - **B**：类组件本身没法在 node 环境里渲，改为**源码 guard**，只守「接线点没被改掉」。
 *
 * ## 每条守卫防的退化形态
 *
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | A1 | `name: message` + stack 首行 | 报告里只剩 `[object Object]`，用户没法描述现象 |
 * | A2 | 非 Error 抛出物不抛错 | 兜底界面因为"打印错误"二次崩溃 → 白屏 |
 * | A3 | `navigator` 缺失不抛 | node / 无 DOM 环境里整段报告失效 |
 * | A4 | 超长 stack 截断 | 一次渲染错误刷出几百 KB 文本，`<pre>` 卡死、复制无响应 |
 * | B1 | `main.tsx` 边界包住 `<App />` 且在 StrictMode 内 | 边界挂错层 → 跟着 App 一起被卸载 |
 * | B2 | `getDerivedStateFromError` + `componentDidCatch` 都在 | 只有其一 → 要么不显示兜底、要么不落日志 |
 * | B3 | `reportLog` 在 `try` 内 | preload 缺失时日志调用把兜底界面一起炸掉 |
 * | B4 | 兜底界面不碰 store / 不用 hook | 崩溃源就是 store 时二次崩溃 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ERROR_REPORT_MAX_FIELD,
  clip,
  describeError,
  formatErrorReport
} from '../src/renderer/logic/errorReport'

/** 固定时间戳，避免报告里出现 `Date.now()` 导致断言不稳（2026-10-13T02:11:35.482Z） */
const FIXED_AT = 1_792_000_295_482

// ── A. 纯函数 ────────────────────────────────────────────────────────

describe('A1 formatErrorReport · 普通 Error', () => {
  it('★含 `name: message`，且含 stack 首行', () => {
    const error = new TypeError('boom is not a function')
    const text = formatErrorReport({ error, appVersion: '0.9.1', at: FIXED_AT })

    expect(text).toContain('TypeError: boom is not a function')
    // stack 首行与 `name: message` 同形，说明整段 stack 真的进来了（不是只抄了 message）
    expect(text).toContain('--- error.stack ---')
    expect(text).toContain(String(error.stack))
    // 版本 / 时间 / 运行环境三段都在（缺数据时也会写 unknown，不会整段消失）
    expect(text).toContain('应用版本: 0.9.1')
    // 时间戳必须**用注入的 at**（不写死字符串：换时区/换年份都不该红）
    expect(text).toContain(new Date(FIXED_AT).toISOString())
    expect(text).toMatch(/运行环境: \S/)
  })

  it('★缺 appVersion 时写 unknown（不写空串）', () => {
    const text = formatErrorReport({ error: new Error('x'), at: FIXED_AT })
    expect(text).toContain('应用版本: unknown')
    expect(text).not.toContain('应用版本: \n')
  })

  it('★缺省 at 用 Date.now()（不抛、也不写 undefined）', () => {
    const text = formatErrorReport({ error: new Error('x') })
    expect(text).not.toContain('undefined')
    expect(text).toMatch(/时间: \d{4}-\d{2}-\d{2}T/)
  })

  it('★message 为空的 Error 也有可读文本', () => {
    const text = formatErrorReport({ error: new Error(''), at: FIXED_AT })
    expect(text).toContain('错误: Error: ')
    expect(text).not.toContain('undefined')
  })
})

describe('A2 formatErrorReport · 非 Error 抛出物（表驱动：全都不许抛）', () => {
  const circular: Record<string, unknown> = { kind: 'circular' }
  circular['self'] = circular

  const cases: Array<{ label: string; error: unknown; expectText: string }> = [
    { label: '字符串', error: 'plain string failure', expectText: 'plain string failure' },
    { label: 'null', error: null, expectText: 'null' },
    { label: 'undefined', error: undefined, expectText: 'undefined' },
    { label: '数字', error: 123, expectText: '123' },
    { label: '空对象', error: {}, expectText: '{}' },
    { label: '无原型对象', error: Object.create(null), expectText: '{}' },
    { label: '循环引用对象', error: circular, expectText: 'object' },
    { label: '布尔', error: false, expectText: 'false' }
  ]

  for (const item of cases) {
    it(`★${item.label} → 不抛错且给出可读文本`, () => {
      const text = formatErrorReport({ error: item.error, at: FIXED_AT })
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
      expect(text).toContain('错误: ')
      expect(text).toContain(item.expectText)
      // 空消息占位不该出现在能取到内容的分支里
      expect(text).not.toContain('应用版本: undefined')
    })
  }

  it('★getter 里再抛的对象也不许把报告炸掉', () => {
    const evil: Record<string, unknown> = {}
    Object.defineProperty(evil, 'name', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      }
    })
    Object.defineProperty(evil, 'message', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      }
    })

    expect(() => formatErrorReport({ error: evil, at: FIXED_AT })).not.toThrow()
    expect(formatErrorReport({ error: evil, at: FIXED_AT })).toContain('错误: ')
  })

  it('★describeError 对 symbol / function 也给可读 name', () => {
    expect(describeError(Symbol('tag')).name).toBe('symbol')
    expect(describeError(() => undefined).name).toBe('function')
    expect(describeError(Symbol('tag')).message.length).toBeGreaterThan(0)
  })
})

describe('A3 formatErrorReport · componentStack 有 / 无', () => {
  it('★有 componentStack → 单独一段', () => {
    const text = formatErrorReport({
      error: new Error('x'),
      componentStack: '\n    at AssetGrid\n    at App\n',
      at: FIXED_AT
    })
    expect(text).toContain('--- componentStack ---')
    expect(text).toContain('at AssetGrid')
    expect(text).toContain('at App')
  })

  it('★没有 componentStack → 整段不出现（不是渲染空段）', () => {
    const noField = formatErrorReport({ error: new Error('x'), at: FIXED_AT })
    const nullField = formatErrorReport({ error: new Error('x'), componentStack: null, at: FIXED_AT })
    const blankField = formatErrorReport({ error: new Error('x'), componentStack: '   ', at: FIXED_AT })

    for (const text of [noField, nullField, blankField]) {
      expect(text).not.toContain('--- componentStack ---')
    }
  })
})

describe('A4 截断 · 超长字段不许把报告撑爆', () => {
  it('★clip 短文本原样返回', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('', 10)).toBe('')
  })

  it('★clip 超长文本截断并注明原长', () => {
    const long = 'x'.repeat(ERROR_REPORT_MAX_FIELD + 500)
    const clipped = clip(long)
    expect(clipped.length).toBeLessThan(long.length)
    expect(clipped).toContain('已截断')
    expect(clipped).toContain(String(long.length))
    expect(clipped.startsWith('x')).toBe(true)
  })

  it('★非法 max（0 / NaN / 负数）退回默认上限，不抛', () => {
    const long = 'y'.repeat(ERROR_REPORT_MAX_FIELD + 1)
    for (const max of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => clip(long, max)).not.toThrow()
      expect(clip(long, max)).toContain('已截断')
    }
  })

  it('★超长 stack 在报告里被截断', () => {
    const error = new Error('long stack')
    error.stack = `Error: long stack\n${'    at frame\n'.repeat(5000)}`
    const text = formatErrorReport({ error, at: FIXED_AT })
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(error.stack.length)
  })
})

describe('A5 运行环境 · node 环境（无 jsdom）天然覆盖', () => {
  it('★navigator 存在或不存在都不抛，且一定有「运行环境」一段', () => {
    expect(() => formatErrorReport({ error: new Error('x'), at: FIXED_AT })).not.toThrow()
    const text = formatErrorReport({ error: new Error('x'), at: FIXED_AT })
    expect(text).toMatch(/运行环境: \S+/)
    // 绝不允许把 `undefined` / 空值写进报告（那会让用户以为信息丢了）
    expect(text).not.toContain('运行环境: undefined')
  })

  it('★报告以可粘贴的抬头开头（用户知道这段是干什么的）', () => {
    const text = formatErrorReport({ error: new Error('x'), at: FIXED_AT })
    expect(text.startsWith('[ID BOX 界面错误报告')).toBe(true)
  })
})

// ── B. 源码 guard（组件无法在 node 环境渲，只守接线点） ─────────────────

/**
 * 读源码（换行统一成 `\n`：本仓检出是 CRLF，按 `\n` 切片的断言不归一化会算错位置）。
 * 与 `tests/classifyUiWiring.test.ts` 的 `readSrc` 同款。
 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释后再做反向断言（注释里写着"不要这么写"，不剥会把自己说明文字判成违规） */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const MAIN = readSrc('src/renderer/main.tsx')
const BOUNDARY = readSrc('src/renderer/components/ErrorBoundary.tsx')
const BOUNDARY_CODE = stripComments(BOUNDARY)

describe('B1 main.tsx · 边界必须包住 <App /> 且在 StrictMode 里面', () => {
  it('★开标签 / 闭标签同时在，且顺序是 StrictMode > ErrorBoundary > App > /ErrorBoundary > /StrictMode', () => {
    const strictOpen = MAIN.indexOf('<React.StrictMode>')
    const boundaryOpen = MAIN.indexOf('<ErrorBoundary>')
    const app = MAIN.indexOf('<App />')
    const boundaryClose = MAIN.indexOf('</ErrorBoundary>')
    const strictClose = MAIN.indexOf('</React.StrictMode>')

    // 五处都必须存在（用 indexOf 比位置，不能只 toContain：位置错了等于没包住）
    for (const pos of [strictOpen, boundaryOpen, app, boundaryClose, strictClose]) {
      expect(pos).toBeGreaterThan(-1)
    }

    expect(strictOpen).toBeLessThan(boundaryOpen)
    expect(boundaryOpen).toBeLessThan(app)
    expect(app).toBeLessThan(boundaryClose) // ← App 在边界**内部**
    expect(boundaryClose).toBeLessThan(strictClose) // ← 边界在 StrictMode**内部**
  })

  it('★import 了 ErrorBoundary（否则 JSX 里的尖括号会编译失败 / 被当成 DOM 标签）', () => {
    expect(MAIN).toContain("import { ErrorBoundary } from './components/ErrorBoundary'")
  })
})

describe('B2 ErrorBoundary.tsx · 两个生命周期都在', () => {
  it('★getDerivedStateFromError + componentDidCatch', () => {
    expect(BOUNDARY_CODE).toContain('static getDerivedStateFromError')
    expect(BOUNDARY_CODE).toContain('componentDidCatch')
    // 类组件（React 18 没有 hook 版边界）
    expect(BOUNDARY_CODE).toContain('extends Component<')
  })

  it('★日志 message 常量是 react:error-boundary（主进程日志里可 grep）', () => {
    expect(BOUNDARY_CODE).toContain("'react:error-boundary'")
  })

  it('★reportLog 在 componentDidCatch 的 try 里（preload 缺失不许连带炸掉兜底界面）', () => {
    expect(BOUNDARY).toMatch(/componentDidCatch[\s\S]*?try[\s\S]*?reportLog/)
  })

  it('★context 里带 retries（重试次数是复现的关键上下文）', () => {
    expect(BOUNDARY_CODE).toMatch(/reportLog[\s\S]{0,400}?retries/)
  })

  it('★诊断文本走 formatErrorReport（与复制按钮同一份口径）', () => {
    expect(BOUNDARY_CODE).toContain("from '../logic/errorReport'")
    expect(BOUNDARY_CODE).toContain('formatErrorReport({')
  })
})

describe('B3 兜底界面 · 不碰 store、不用 hook、可操作', () => {
  it('★不 import store（此时 store 很可能就是崩溃源）', () => {
    expect(BOUNDARY_CODE).not.toContain("from '../store'")
    expect(BOUNDARY_CODE).not.toContain('useVault')
  })

  it('★不用任何 hook（类组件 + 无 hook，才不会在崩溃态里再走一遍订阅）', () => {
    expect(BOUNDARY_CODE).not.toMatch(/\buse(State|Effect|Memo|Ref|Callback|Reducer|Context)\b/)
  })

  it('★四个按钮文案齐全', () => {
    expect(BOUNDARY).toContain('重新加载界面')
    expect(BOUNDARY).toContain('重新加载窗口')
    expect(BOUNDARY).toContain('复制诊断信息')
    expect(BOUNDARY).toContain('打开日志文件夹')
    expect(BOUNDARY).toContain('已复制')
  })

  it('★重试次数封顶（防无限重试死循环）', () => {
    expect(BOUNDARY_CODE).toContain('MAX_RETRIES')
    expect(BOUNDARY_CODE).toContain('retries >= MAX_RETRIES')
    expect(BOUNDARY_CODE).toContain('多次重试仍失败')
    // 文案不许带方位词：按钮行 flex-wrap，窄窗口下「重新加载窗口」可能换行到别处
    expect(BOUNDARY).not.toContain('请点右侧')
    expect(BOUNDARY).toContain('请点「重新加载窗口」')
  })

  it('★「打开日志文件夹」走 logStats().dir → openPath，且整体 try/catch', () => {
    expect(BOUNDARY_CODE).toContain('window.modvault.logStats()')
    expect(BOUNDARY_CODE).toContain('window.modvault.openPath(stats.dir)')
    expect(BOUNDARY_CODE).toMatch(/handleOpenLogs[\s\S]*?try[\s\S]*?logStats/)
  })

  it('★安抚文案逐字不变（这是用户判断"数据有没有事"的唯一依据）', () => {
    expect(BOUNDARY).toContain('你的素材库和磁盘文件都没有被改动，这里只是界面渲染失败。')
    expect(BOUNDARY).toContain('界面出错了')
  })
})

describe('B4 兜底界面的颜色 · 一律 var(--token, 兜底色)', () => {
  it('★关键 token 都带兜底色（CSS 还没生效时也要能读）', () => {
    for (const token of [
      'var(--bg-canvas, #f8fafc)',
      'var(--surface-card, #ffffff)',
      'var(--border, #e2e8f0)',
      'var(--text-primary, #1f2937)',
      'var(--text-secondary, #4b5563)',
      'var(--text-tertiary, #6b7280)',
      'var(--bg-sidebar, #f1f5f9)',
      'var(--accent, #007aff)',
      'var(--shadow-modal, '
    ]) {
      expect(BOUNDARY_CODE).toContain(token)
    }
  })

  it('★禁止橙色/棕色（设计纪律：主题底必须中性，强调色只给主按钮）', () => {
    expect(BOUNDARY_CODE).not.toMatch(/#f59e0b|#d97706|#b45309|#92400e|orange|amber/i)
  })

  it('★卡片规格：max-width 640 / radius 12 / padding 28', () => {
    expect(BOUNDARY_CODE).toContain('maxWidth: 640')
    expect(BOUNDARY_CODE).toContain('borderRadius: 12')
    expect(BOUNDARY_CODE).toContain('padding: 28')
  })
})

// ── B5. 无边框窗口的逃生口（`frame: false`，自绘标题栏随 App 一起被卸载） ────
//
// 这一组守的是**最严重的那类退化**：兜底界面出现后，窗口没有最小化/最大化/关闭按钮，
// 用户唯一出路是任务管理器。所以「整页重载」和「关窗」这两条不依赖 React 树的出口
// 必须存在、且不能被重试次数连坐禁用。

describe('B5 Escape hatches · 重新加载窗口 / 关闭窗口', () => {
  it('★「重新加载窗口」执行 location.reload()', () => {
    expect(BOUNDARY_CODE).toContain('window.location.reload()')
  })

  it('★整页重载与关窗都在 try 里（兜底页绝不许自己抛错）', () => {
    expect(BOUNDARY_CODE).toMatch(/handleReloadWindow[\s\S]*?try[\s\S]*?location\.reload\(\)/)
    expect(BOUNDARY_CODE).toMatch(/handleCloseWindow[\s\S]*?try[\s\S]*?winClose/)
  })

  it('★关窗走 preload 的 winClose（可选链），不是 window.close()', () => {
    expect(BOUNDARY_CODE).toContain('winClose?.()')
    expect(BOUNDARY_CODE).toMatch(/winClose\?\..*\(/)
    // 反向守卫：`window.close()` 会绕过主进程 `win:close` 的 closable 判断与退出逻辑
    expect(BOUNDARY_CODE).not.toContain('window.close()')
  })

  it('★右上角 × 有 aria-label / title，且内容是 ×（U+00D7）', () => {
    expect(BOUNDARY).toContain('aria-label="关闭 ID BOX"')
    expect(BOUNDARY).toContain('title="关闭 ID BOX"')
    expect(BOUNDARY).toContain('×')
    // 绝对定位在卡片右上角（卡片必须 relative，否则 × 会跑到视口角上）
    expect(BOUNDARY_CODE).toContain("position: 'absolute'")
    expect(BOUNDARY_CODE).toContain("position: 'relative'")
  })

  it('★只有「重新加载界面」受 retries 约束：源码里 disabled= 只出现一次', () => {
    // 静态能断言到这个程度就够了：一旦有人给别的按钮也加 disabled，
    // 逃生口就会跟着重试次数一起失效（确定性错误时用户被关死）
    expect(BOUNDARY_CODE.split('disabled=').length - 1).toBe(1)
    expect(BOUNDARY_CODE).toContain('disabled={retryDisabled}')
    // retryDisabled 的唯一来源就是 retries（不许出现第二个判据）
    expect(BOUNDARY_CODE.split('const retryDisabled').length - 1).toBe(1)
  })
})
