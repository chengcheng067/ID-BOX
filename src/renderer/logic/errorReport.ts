/**
 * 崩溃兜底 · 错误报告文本化（**纯函数，绝不抛错**）
 *
 * ## 为什么单独抽一个文件
 *
 * 错误边界捕获到异常时，界面已经是「不可信状态」—— 此时任何一次抛错都会把兜底界面
 * 自己也炸掉，用户看到的就是**纯白屏 + 无法恢复**。所以「把任意抛出物变成一段可读文本」
 * 这件事必须是一个能被单测逐条钉死的纯函数：
 *   - `tests/errorBoundary.test.ts` 用 `environment: 'node'`（没有 jsdom）直接跑它；
 *   - 抛出物是**完全不可控**的：`Error` / 字符串 / `null` / `undefined` / 数字 /
 *     `{}` / `Object.create(null)` / 循环引用 / getter 里再抛 —— 全部要退化成可读文本。
 *
 * ## 「绝不抛错」的实现纪律
 *
 * 1. 只读 `error.name / message / stack` 且每个读取点都在 `try` 内（getter 可能再抛）；
 * 2. `String(x)` / `JSON.stringify(x)` 都可能抛（`toJSON` 抛、`toString` 抛、循环引用），
 *    一律先 `JSON` 后 `String`，都失败给常量占位；
 * 3. `navigator` 在 `environment: 'node'` 的测试进程里可能**不存在** →
 *    必须先 `typeof navigator !== 'undefined'` 守卫，取不到值给 `'unknown'`；
 * 4. 整个 `formatErrorReport` 外面还有一层兜底 `try/catch`，最坏情况返回一段仍可读的文本。
 */

/** 单个字段（`message` / `stack` / `componentStack`）的最大字符数（与主进程日志口径一致）。 */
export const ERROR_REPORT_MAX_FIELD = 4000

export interface ErrorReportInput {
  /** 抛出来的任何东西（`Error` / 字符串 / `null` / 循环引用对象都可能进来） */
  error: unknown
  /** React 的组件栈（`componentDidCatch(error, info)` 里的 `info.componentStack`） */
  componentStack?: string | null
  /** 应用版本号（取不到时报告里写 `unknown`） */
  appVersion?: string
  /** 错误发生时间（毫秒时间戳）；缺省用 `Date.now()` */
  at?: number
}

/** 任意抛出物 → 三元组（报告与日志共用同一套口径） */
export interface ErrorDescriptor {
  /** 错误类型名：`TypeError` / `string` / `null` / `object` … */
  name: string
  /** 错误消息（永远是非空字符串） */
  message: string
  /** `error.stack`（没有就是 `null`，**不**用空串冒充） */
  stack: string | null
}

/** 环境信息取不到时的占位（**不要**用空串：报告里空值看着像"没写"） */
const UNKNOWN = 'unknown'
/** 错误对象自带空 message 时的占位 */
const NO_MESSAGE = '(无错误消息)'
/** `String()` / `JSON.stringify()` 双双失败时的占位 */
const UNPRINTABLE = '[不可打印的值]'

/**
 * `String(value)` 的安全版本。
 *
 * 单独包一层是因为 `String(Object.create({ toString() { throw x } }))` 真的会抛 ——
 * 兜底界面绝不能因为"打印错误"而二次崩溃。
 */
function tryString(value: unknown): string {
  try {
    const text = String(value)
    return text.length > 0 ? text : UNPRINTABLE
  } catch {
    return UNPRINTABLE
  }
}

/**
 * 任意值 → 一行文本。
 *
 * 顺序：字符串原样 → `null` / `undefined` 字面量 → `JSON.stringify` → `String()`。
 * 普通对象走 `JSON` 才有信息量（`{}` 而不是 `[object Object]`）；
 * 循环引用 / `toJSON` 抛错时退化到 `String()`。
 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string' && json.length > 0) return json
  } catch {
    /* 循环引用 / `toJSON` 抛错 → 退化到 String() */
  }
  return tryString(value)
}

/**
 * 任意抛出物 → `{ name, message, stack }`（**绝不抛错**）。
 *
 * `name` 缺失时按类型给可读值（`string` / `number` / `object` / `null` …），
 * 这样"非 Error 抛出物"在报告里也一眼能看出是什么东西抛的。
 */
export function describeError(error: unknown): ErrorDescriptor {
  let name = ''
  let message = ''
  let stack: string | null = null
  let isErrorInstance = false

  // `instanceof` 自身在某些宿主对象上也可能抛（跨 realm / Proxy），一并兜住
  try {
    isErrorInstance = error instanceof Error
  } catch {
    isErrorInstance = false
  }

  try {
    if (typeof error === 'object' && error !== null) {
      const record = error as { name?: unknown; message?: unknown; stack?: unknown }
      // 三个字段**逐个**读、逐个判类型：`name` 有值而 `stack` 是 getter 抛错时仍要拿到 name
      if (typeof record.name === 'string' && record.name.trim().length > 0) name = record.name
      if (typeof record.message === 'string') message = record.message
      if (typeof record.stack === 'string' && record.stack.trim().length > 0) stack = record.stack
    }
  } catch {
    /* getter 里再抛 → 全部走下面的安全兜底 */
  }

  if (name.length === 0) {
    if (error === null) name = 'null'
    else if (error === undefined) name = 'undefined'
    else if (isErrorInstance) name = 'Error'
    else name = typeof error
  }

  if (message.length === 0) {
    // Error 实例的 message 为空 → 给一句人话占位；非 Error → 尽力序列化
    message = isErrorInstance ? NO_MESSAGE : safeStringify(error)
    if (message.length === 0) message = NO_MESSAGE
  }

  return { name, message, stack }
}

/**
 * 超长文本截断（保留头部 + 末尾注明原长）。
 *
 * 为什么保留头部：`stack` 的**首行**是 `Name: message`、其后由内向外排栈，
 * 头部才是定位信息；尾部往往是三方库的长路径，截掉损失最小。
 */
export function clip(text: string, max: number = ERROR_REPORT_MAX_FIELD): string {
  if (typeof text !== 'string') return ''
  const limit =
    typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : ERROR_REPORT_MAX_FIELD
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断，原长 ${text.length} 字符）`
}

/** 毫秒时间戳 → `ISO (本地时间)`；非法时间戳退化成原值 */
function formatTimestamp(at: number): string {
  try {
    const date = new Date(at)
    const iso = date.toISOString()
    return `${iso} (本地 ${date.toLocaleString()})`
  } catch {
    return String(at)
  }
}

/**
 * 运行时标识（`navigator.userAgent`）。
 *
 * ⚠️ `environment: 'node'` 的测试进程里 `navigator` 可能**根本不存在**（Node 21+ 才有），
 * 所以必须 `typeof` 守卫；任何取值失败都给 `'unknown'`，绝不抛。
 */
function describeRuntime(): string {
  try {
    if (typeof navigator === 'undefined') return UNKNOWN
    const userAgent = navigator.userAgent
    return typeof userAgent === 'string' && userAgent.trim().length > 0 ? userAgent : UNKNOWN
  } catch {
    return UNKNOWN
  }
}

/** 版本号归一化（`undefined` / 空串 → `'unknown'`） */
function normalizeVersion(version: string | undefined): string {
  if (typeof version !== 'string') return UNKNOWN
  const trimmed = version.trim()
  return trimmed.length > 0 ? trimmed : UNKNOWN
}

/**
 * 生成一段**可直接粘贴给开发者**的纯文本报告。
 *
 * 结构（每段都在，缺数据时写 `unknown` / 整段省略）：
 * ```
 * [ID BOX 界面错误报告 · 可直接粘贴给开发者]
 * 时间: 2026-10-13T02:11:35.482Z (本地 2026/10/13 10:11:35)
 * 应用版本: 0.9.1
 * 运行环境: Mozilla/5.0 ...
 * 错误: TypeError: xxx is not a function
 * --- error.stack ---
 * ...
 * --- componentStack ---
 * ...
 * ```
 *
 * **本函数绝不抛错**（外层还有一层兜底）—— 它跑在兜底界面的 render 里。
 */
export function formatErrorReport(input: ErrorReportInput): string {
  try {
    const descriptor = describeError(input.error)
    const at =
      typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now()
    const componentStack =
      typeof input.componentStack === 'string' ? input.componentStack.trim() : ''

    const lines: string[] = [
      '[ID BOX 界面错误报告 · 可直接粘贴给开发者]',
      `时间: ${formatTimestamp(at)}`,
      `应用版本: ${normalizeVersion(input.appVersion)}`,
      `运行环境: ${describeRuntime()}`,
      `错误: ${descriptor.name}: ${descriptor.message}`
    ]

    if (descriptor.stack !== null) {
      lines.push('', '--- error.stack ---', clip(descriptor.stack))
    }
    if (componentStack.length > 0) {
      lines.push('', '--- componentStack ---', clip(componentStack))
    }

    return lines.join('\n')
  } catch {
    // 走到这里说明连 describeError 都炸了（理论上不可能）—— 仍要给一段可读文本
    return ['[ID BOX 界面错误报告 · 可直接粘贴给开发者]', `错误: ${UNPRINTABLE}`].join('\n')
  }
}
