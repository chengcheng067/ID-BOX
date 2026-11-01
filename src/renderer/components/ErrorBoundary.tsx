import { Component, Fragment } from 'react'
import type { CSSProperties, ErrorInfo, ReactNode } from 'react'
import { clip, describeError, formatErrorReport } from '../logic/errorReport'

/**
 * 顶层错误边界（白屏兜底 + 诊断上报）
 *
 * ## 为什么必须存在
 *
 * `src/renderer/main.tsx` 里的 `installRendererLogHooks` 只能**取证**：React 渲染期
 * 抛错时它确实会把堆栈转发到主进程日志，但**整棵组件树照样被卸载** ——
 * 用户看到的是一页纯白、没有任何可操作入口、也不知道数据有没有事的界面。
 * 错误边界是唯一能把"渲染期异常"变成"一页可读、可操作、不丢数据的兜底界面"的机制
 * （React 18 没有 hook 版本，只能是类组件 + `getDerivedStateFromError` / `componentDidCatch`）。
 *
 * ## 铁律（改动前务必读）
 *
 * 1. **兜底界面里不许用任何 hook、不许 import store** —— 此刻 store / 上下文很可能就是
 *    崩溃源本身，再摸一次等于二次崩溃。所以本文件只 import `react` 与纯逻辑。
 * 2. **所有颜色写成 `var(--token, 兜底色)`** —— 崩溃可能发生在 `styles.css` 生效之前/之中，
 *    内联样式 + 兜底色保证「CSS 挂了也能读」。深色主题靠 CSS 变量自动生效
 *    （`[data-theme='dark']` 已经把同一批变量换成深色档），这里不需要判断主题。
 * 3. **日志上报必须整体包 `try/catch`** —— preload 可能缺失、窗口可能正在销毁，
 *    日志失败绝不能反过来影响兜底渲染。
 * 4. **兜底界面只读 state，不做任何磁盘/库操作** —— 这里唯一的承诺是
 *    「素材库和磁盘文件都没有被改动」，代码也必须兑现这句话。
 * 5. **三条逃生口必须始终可用**（重新加载窗口 / 关窗 × / 打开日志文件夹）—— 本窗口是
 *    `frame: false` 的无边框窗口，自绘标题栏（`WindowControls`）在 `Toolbar` → `App` 内部，
 *    边界一接管就随之被卸载了。所以「不依赖 React 树能否重挂载」的出口不能跟着
 *    重试次数一起禁用，否则确定性渲染错误时用户会被关在一个既打不开也关不掉的窗口里。
 */

/** 重试按钮（重新挂载 React 子树）的最多次数；超了只能走「重新加载窗口」那条逃生口 */
const MAX_RETRIES = 2

/** 日志消息常量（主进程日志里一条就是一条，便于 grep） */
const LOG_MESSAGE = 'react:error-boundary'

/** 复制按钮的反馈持续时长（毫秒） */
const COPY_FEEDBACK_MS = 2000

/**
 * 应用版本号缓存。
 *
 * 为什么是模块级变量而不是 state：`formatErrorReport(...)` 在 `render` 里**同步**调用，
 * 而版本号只能异步拿（`window.modvault.getAppVersion()` 是 `invoke`）。边界挂载成功时
 * （此时 App 是健康的）顺手缓存一次，之后真崩了就能同步读到；
 * 首帧就崩（缓存为空）时报告里写 `unknown`，可以接受 —— 不值得为此让兜底界面等异步。
 */
let appVersionHint = ''

/**
 * 最近一次捕获到错误的时间戳（毫秒）。
 *
 * 只用于 `<pre>` 里的报告文本：如果用 `Date.now()` 现取，每次重渲染时间都会跳一下
 * （`info` 落地会触发一次重渲染），看起来像界面在抽风。写入点是
 * `getDerivedStateFromError` —— 只是记一个时间戳，**不碰**任何 React 状态。
 */
let caughtAt = 0

/** 拉取并缓存版本号（失败静默：`unknown` 就够了，不值得为此承担任何风险） */
function refreshAppVersion(): void {
  if (appVersionHint.length > 0) return
  try {
    void window.modvault
      .getAppVersion()
      .then((version) => {
        appVersionHint = typeof version === 'string' ? version : ''
      })
      .catch(() => {
        /* 主进程还没就绪 / 窗口正在销毁 → 保持 unknown */
      })
  } catch {
    /* preload 缺失（`window.modvault` undefined）→ 保持 unknown */
  }
}

export interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  /** 捕获到的抛出物（`null` = 健康，正常渲染 children） */
  error: unknown | null
  /** `componentDidCatch` 拿到的组件栈（`string | null`，`<pre>` 里展示） */
  info: string | null
  /** 已重试次数（`>= MAX_RETRIES` 时禁用重试按钮） */
  retries: number
  /**
   * 「复制诊断信息」按钮的 2 秒反馈态。
   *
   * 规格里的 State 只有 `error / info / retries`；这里是**唯一新增**的字段，
   * 纯粹为了「已复制」文案（不改文案就要额外一轮 forceUpdate，更脏）。
   * 它不参与任何兜底判定。
   */
  copied: boolean
}

// ── 内联样式（全部走 CSS 变量 + 兜底色，理由见文件头「铁律 2」） ──────────────

const styles: Record<
  | 'scrim'
  | 'card'
  | 'close'
  | 'title'
  | 'hint'
  | 'summary'
  | 'pre'
  | 'actions'
  | 'primary'
  | 'primaryOff'
  | 'secondary'
  | 'retryNote',
  CSSProperties
> = {
  scrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    overflow: 'auto',
    background: 'var(--bg-canvas, #f8fafc)'
  },
  card: {
    // `relative` 只为右上角那颗 × 定位用（绝对定位的包含块）
    position: 'relative',
    width: '100%',
    maxWidth: 640,
    boxSizing: 'border-box',
    background: 'var(--surface-card, #ffffff)',
    border: '1px solid var(--border, #e2e8f0)',
    borderRadius: 12,
    padding: 28,
    boxShadow: 'var(--shadow-modal, 0 16px 48px rgba(38, 48, 64, 0.18))',
    color: 'var(--text-primary, #1f2937)'
  },
  /**
   * 卡片右上角的关闭钮（×）。
   *
   * **不做 hover 态**：兜底页的第一原则是"极简且一定能显示"，为一个悬停效果多挂两个
   * React 事件处理器（还要内联改样式）不值当 —— 这里少一行 JS 就少一个出错点。
   */
  close: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--text-tertiary, #6b7280)',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer'
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    color: 'var(--text-primary, #1f2937)'
  },
  hint: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 1.7,
    color: 'var(--text-secondary, #4b5563)'
  },
  summary: {
    marginTop: 18,
    fontSize: 13,
    color: 'var(--text-secondary, #4b5563)',
    cursor: 'pointer'
  },
  pre: {
    margin: '10px 0 0',
    maxHeight: 240,
    overflow: 'auto',
    padding: 12,
    background: 'var(--bg-sidebar, #f1f5f9)',
    border: '1px solid var(--border, #e2e8f0)',
    borderRadius: 8,
    color: 'var(--text-tertiary, #6b7280)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
    fontSize: 11,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all'
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 20
  },
  primary: {
    border: '1px solid transparent',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    background: 'var(--accent, #007aff)',
    color: '#ffffff'
  },
  primaryOff: {
    border: '1px solid transparent',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'not-allowed',
    background: 'var(--accent, #007aff)',
    color: '#ffffff',
    opacity: 0.5
  },
  secondary: {
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 13,
    cursor: 'pointer',
    background: 'var(--surface-card, #ffffff)',
    border: '1px solid var(--border, #e2e8f0)',
    color: 'var(--text-secondary, #4b5563)'
  },
  retryNote: {
    marginTop: 8,
    fontSize: 12,
    color: 'var(--text-tertiary, #6b7280)'
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null, retries: 0, copied: false }

  /** 「已复制」2 秒后复原的定时器（卸载时清掉，避免对已卸载实例 setState） */
  private copiedTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 渲染阶段被调用：**只**把错误记进 state 切成兜底界面。
   *
   * 这里**不许**做日志上报 / 网络 / 磁盘 —— 它在渲染阶段执行，副作用会让 React 再抛一次，
   * 那就成了「兜底界面自己崩」的死循环。上报统一放 `componentDidCatch`。
   */
  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    caughtAt = Date.now()
    return { error, copied: false }
  }

  componentDidMount(): void {
    // 挂载成功说明 App 此刻是健康的 → 趁机把版本号缓存下来，供将来崩溃报告使用
    refreshAppVersion()
  }

  componentWillUnmount(): void {
    this.clearCopiedTimer()
  }

  /**
   * 提交阶段被调用：控制台 + 主进程日志各记一次（**取证**），并落地组件栈给 `<pre>`。
   *
   * 每一步都单独包 `try/catch`：控制台可能不可用、preload 可能缺失、窗口可能正在销毁 ——
   * 任何一步失败都不能阻止兜底界面显示（用户能看见界面才是第一位）。
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const componentStack =
      typeof errorInfo?.componentStack === 'string' ? errorInfo.componentStack : null

    try {
      console.error(LOG_MESSAGE, error, componentStack)
    } catch {
      /* 控制台不可用（窗口正在销毁）→ 静默 */
    }

    try {
      // 组件栈落在 state 上：`getDerivedStateFromError` 只能拿到 error，拿不到 info
      this.setState({ info: componentStack })
    } catch {
      /* 卸载中 / 冻结 → 忽略；兜底界面没有组件栈也是可用的 */
    }

    // 版本号可能还没缓存（首帧就崩）→ 再试一次；失败了也不影响本次上报
    refreshAppVersion()

    try {
      const descriptor = describeError(error)
      window.modvault?.reportLog?.({
        level: 'error',
        message: LOG_MESSAGE,
        context: {
          message: clip(`${descriptor.name}: ${descriptor.message}`, 4000),
          stack: descriptor.stack === null ? null : clip(descriptor.stack, 4000),
          componentStack: componentStack === null ? null : clip(componentStack, 4000),
          retries: this.state.retries
        }
      })
    } catch {
      /* preload 缺失 / 窗口已销毁：日志失败绝不能反过来影响兜底渲染 */
    }
  }

  /** 报告文本（render 与「复制诊断信息」共用同一份，避免两处口径漂移） */
  private reportText(): string {
    return formatErrorReport({
      error: this.state.error,
      componentStack: this.state.info,
      appVersion: appVersionHint,
      at: caughtAt > 0 ? caughtAt : undefined
    })
  }

  private clearCopiedTimer(): void {
    if (this.copiedTimer !== null) {
      clearTimeout(this.copiedTimer)
      this.copiedTimer = null
    }
  }

  /**
   * 「重新加载界面」：清掉错误让子树重新挂载。
   *
   * 注意 `render()` 里 children 外面挂了 `key={retries}` —— 崩溃时 React 已经把子树
   * 卸载了，但为了确保「重试 = 拿到一棵全新的树」（而不是复用带脏状态的 fiber），
   * 这里靠 key 变化硬重挂载。
   */
  private handleRetry = (): void => {
    if (this.state.retries >= MAX_RETRIES) return
    this.clearCopiedTimer()
    this.setState((prev) => ({
      error: null,
      info: null,
      retries: prev.retries + 1,
      copied: false
    }))
  }

  /** 「复制诊断信息」：成功给 2 秒「已复制」，失败**完全静默**（此刻弹 alert 是二次风险） */
  private handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.reportText())
    } catch {
      /* 剪贴板不可用（无权限 / 非安全上下文 / 焦点不在窗口）→ 静默 */
      return
    }
    this.showCopied()
  }

  private showCopied(): void {
    this.clearCopiedTimer()
    this.setState({ copied: true })
    this.copiedTimer = setTimeout(() => {
      this.copiedTimer = null
      this.setState({ copied: false })
    }, COPY_FEEDBACK_MS)
  }

  /** 「打开日志文件夹」：先问日志目录，再交给系统文件管理器打开；整条链路失败静默 */
  private handleOpenLogs = async (): Promise<void> => {
    try {
      const stats = await window.modvault.logStats()
      await window.modvault.openPath(stats.dir)
    } catch {
      /* 这条链路本身可能已坏（主进程忙 / 窗口销毁 / preload 缺失）→ 静默 */
    }
  }

  /**
   * 「重新加载窗口」：整页重载渲染进程（**逃生口 2**）。
   *
   * 为什么 `location.reload()` 不能替代「重新加载界面」，也不能被它替代：
   *   - 重试（`handleRetry`）只是**重新挂载 React 子树**，主进程状态、渲染进程里
   *     已经跑歪的模块级状态（词表缓存、Dexie 连接池、three.js 上下文）都还在，
   *     "被污染的模块级状态导致的崩溃"重试一百次也修不好；
   *   - 整页重载把这些全部重置，是比"重挂载"更彻底的一档。
   * 数据安全：库的真相在磁盘 + Dexie，重载只是重新读一遍，不会丢东西。
   */
  private handleReloadWindow = (): void => {
    try {
      window.location.reload()
    } catch {
      /* 极端情况（location 被冻结）→ 静默：绝不能让兜底界面自己抛错 */
    }
  }

  /**
   * 「关闭 ID BOX」（卡片右上角 ×）：**逃生口 3**，走主进程既有的关窗流程。
   *
   * ⚠️ 不要改成 `window.close()`：`winClose` 是 `send` 到主进程的 `win:close`
   * （`main/index.ts` 的 `ipcMain.on` 里有 `closable` 判断与 `window-all-closed` 退出逻辑），
   * 而 `window.close()` 会绕过那一层 —— 关窗时该做的事（比如 `closable` 守卫）就全跳过了。
   *
   * 这条通道用的是可选链：preload 缺失时只是**关不掉**，绝不能反过来把兜底界面炸掉。
   */
  private handleCloseWindow = (): void => {
    try {
      window.modvault?.winClose?.()
    } catch {
      /* preload 缺失 / 窗口正在销毁 → 静默 */
    }
  }

  render(): ReactNode {
    const { error, retries, copied } = this.state

    if (error === null) {
      // `key={retries}`：重试时整棵子树**重新挂载**（理由见 handleRetry）
      return <Fragment key={retries}>{this.props.children}</Fragment>
    }

    /**
     * 只有「重新加载界面」受重试次数约束（它依赖 React 树能重新挂载来"治好"），
     * 其余三个按钮 + 右上角 × 是**逃生口**：整页重载 / 复制诊断 / 开日志目录 / 关窗，
     * 都不依赖 React 树能否重挂载，所以**必须始终可用** —— 否则确定性渲染错误时
     * 用户会被关在一个既打不开也关不掉的窗口里（本窗口 `frame: false`，
     * 自绘标题栏随 App 一起被卸载了）。
     */
    const retryDisabled = retries >= MAX_RETRIES

    return (
      <div style={styles.scrim}>
        <div style={styles.card} role="alert" aria-live="assertive">
          <button
            type="button"
            onClick={this.handleCloseWindow}
            style={styles.close}
            aria-label="关闭 ID BOX"
            title="关闭 ID BOX"
          >
            ×
          </button>
          <div style={styles.title}>界面出错了</div>
          <div style={styles.hint}>你的素材库和磁盘文件都没有被改动，这里只是界面渲染失败。</div>
          <details>
            <summary style={styles.summary}>查看技术细节</summary>
            <pre style={styles.pre}>{this.reportText()}</pre>
          </details>
          <div style={styles.actions}>
            <button
              type="button"
              onClick={this.handleRetry}
              disabled={retryDisabled}
              style={retryDisabled ? styles.primaryOff : styles.primary}
            >
              重新加载界面
            </button>
            <button type="button" onClick={this.handleReloadWindow} style={styles.secondary}>
              重新加载窗口
            </button>
            <button
              type="button"
              onClick={() => void this.handleCopy()}
              style={styles.secondary}
            >
              {copied ? '已复制' : '复制诊断信息'}
            </button>
            <button
              type="button"
              onClick={() => void this.handleOpenLogs()}
              style={styles.secondary}
            >
              打开日志文件夹
            </button>
          </div>
          {retryDisabled && (
            // 不写方位词：按钮行是 `flex-wrap: wrap`，窄窗口下「重新加载窗口」可能换行到别处
            <div style={styles.retryNote}>多次重试仍失败，请点「重新加载窗口」</div>
          )}
        </div>
      </div>
    )
  }
}
