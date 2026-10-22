/**
 * 诊断日志（主进程）
 *
 * 设计目标（按重要性排序）：
 *   ① **崩溃后能留下现场**：拖出闪退这类进程级崩溃没有日志就无法定位，所以写入必须
 *      在业务调用之前/之后各留一条（见 `index.ts` 的 `drag:start` 埋点）；
 *   ② 用户能自己导出日志发给我们（`exportLogsTo` 打成 zip）；
 *   ③ **绝不因为日志本身让业务失败**：写入异步、串行、失败只吞掉（console 打一次 banner），
 *      主流程里没有任何 `await 写日志`。
 *
 * 落盘：`<userData>/logs/app-YYYY-MM-DD.log`，一行一条 UTF-8，按天分文件，
 * 保留最近 {@link LOG_RETENTION_DAYS} 天（启动时清理更早的）。
 *
 * 行格式：`<ISO时间> [main|renderer] [LEVEL] <消息> <可选 JSON 上下文>`
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { app } from 'electron'
import type { LogStats, RendererLogPayload } from '../shared/types'

/** 日志级别（`error` 最严重；与 shared/types.ts 的 LogLevel 同构） */
export type LogLevel = RendererLogPayload['level']
export type LogSource = 'main' | 'renderer'

/** 单文件超过此体积后**继续写**，但记一条 warn（不做切片，避免半夜把磁盘写满两个文件） */
export const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024

/** 保留天数（含今天）：7 = 今天 + 前 6 天 */
export const LOG_RETENTION_DAYS = 7

/** 落盘前的脱敏占位符 */
export const REDACTED = '***'

/** 上下文 JSON 截断长度（防一条日志写几十 KB） */
const MAX_CONTEXT_CHARS = 4000

/** 内存队列上限：爆了就丢最老的（宁可丢日志，也不让主进程 OOM） */
const MAX_QUEUED_LINES = 2000

/** 级别权重：数字越小越严重 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `app-YYYY-MM-DD.log` */
const LOG_NAME_RE = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/

// ── 可调状态 ────────────────────────────────────────────────────────────

/** 详细日志（debug）开关；由设置 `verboseLogging` 驱动 */
let verboseLogging = false

/** 写失败 banner 只打一次（避免一次崩溃刷满控制台） */
let writeFailureReported = false

/** 内存队列 + 串行链：**唯一**的写入通道 */
const queue: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let chain: Promise<void> = Promise.resolve()

/** 每个文件已写字节数（首次写入时 stat 一次，之后累加） */
const fileSizes = new Map<string, number>()
/** 已提示过「超 8MB」的文件（每个文件只提示一次） */
const oversizeWarned = new Set<string>()
/** 已 mkdir 过的目录 */
const readyDirs = new Set<string>()

// ── 路径 ────────────────────────────────────────────────────────────────

/** 日志目录：`<userData>/logs`（%APPDATA%/idbox/logs） */
export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

/** 某一天对应的日志文件名（**本地时间**，用户看文件名就能对上日期） */
export function logFileNameFor(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `app-${y}-${m}-${d}.log`
}

/** 当前应写入的日志文件绝对路径 */
export function currentLogFile(date: Date = new Date()): string {
  return path.join(logDir(), logFileNameFor(date))
}

/** 导出 zip 的默认文件名：`idbox-logs-YYYYMMDD-HHmm.zip`（本地时间） */
export function logExportFileName(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `idbox-logs-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.zip`
}

/**
 * 从文件名解析日期（**纯函数**）。解析不了（不是本模块写的文件）→ null，
 * 调用方据此**绝不删除**陌生文件。
 */
export function parseLogFileDate(name: string): Date | null {
  const m = LOG_NAME_RE.exec(name)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const date = new Date(y, mo, d)
  if (Number.isNaN(date.getTime())) return null
  // 回读校验：`2026-02-31` 会被 Date 规范化成 3 月 3 日，这类名字一律当陌生文件
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null
  return date
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// ── 级别 ────────────────────────────────────────────────────────────────

/** 详细日志开关（设置页「记录详细日志」） */
export function setVerboseLogging(v: boolean): void {
  verboseLogging = v === true
}

export function isVerboseLogging(): boolean {
  return verboseLogging
}

/** 当前生效的最低级别：verbose → debug，否则 info */
export function activeLevel(): LogLevel {
  return verboseLogging ? 'debug' : 'info'
}

/** 该级别当前是否会被写出（debug 受 verbose 控制） */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] <= LEVEL_WEIGHT[activeLevel()]
}

// ── 脱敏 ────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set(['apikey', 'authorization', 'token'])

/**
 * 键名归一化后比对：`apiKey` / `api_key` / `API-KEY` / `Authorization` / `token`
 * 全部命中（用户自接模型的密钥绝不能进日志）。
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[\s_-]/g, '').toLowerCase())
}

/** Error → 可序列化结构（保持 stack，崩溃现场就靠它） */
export function describeError(err: unknown): { name: string; message: string; stack: string | null } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack ?? null }
  }
  return { name: 'NonError', message: String(err), stack: null }
}

/** 递归脱敏（数组/对象/嵌套；深度与数组长度都设上限，绝不抛错） */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]'
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return describeError(value)
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1)
  }
  return out
}

/** 上下文 → 单行 JSON（脱敏 + 截断 + 绝不抛错） */
export function serializeContext(context: unknown): string {
  if (context === undefined || context === null) return ''
  try {
    const json = JSON.stringify(redactValue(context))
    if (json === undefined) return ''
    return json.length > MAX_CONTEXT_CHARS ? `${json.slice(0, MAX_CONTEXT_CHARS)}…(truncated)` : json
  } catch {
    return '"[unserializable]"'
  }
}

/** 组一行日志（**纯函数**，单测直接验格式） */
export function formatLogLine(
  level: LogLevel,
  message: string,
  context?: unknown,
  source: LogSource = 'main',
  at: Date = new Date()
): string {
  const ts = at.toISOString()
  const text = String(message ?? '').replace(/[\r\n]+/g, ' ')
  const ctx = serializeContext(context)
  return `${ts} [${source}] [${level.toUpperCase()}] ${text}${ctx ? ` ${ctx}` : ''}`
}

// ── 写入（异步 + 串行 + 不阻塞主流程） ────────────────────────────────────

function enqueue(line: string): void {
  if (queue.length >= MAX_QUEUED_LINES) queue.shift()
  queue.push(line)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushLogs()
  }, 0)
  // 短命进程 / 单测不应被这个定时器吊住（Node 才有 unref）
  const t = flushTimer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}

async function ensureDir(dir: string): Promise<void> {
  if (readyDirs.has(dir)) return
  await mkdir(dir, { recursive: true })
  readyDirs.add(dir)
}

async function sizeOf(file: string): Promise<number> {
  const cached = fileSizes.get(file)
  if (cached !== undefined) return cached
  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    size = 0
  }
  fileSizes.set(file, size)
  return size
}

function reportWriteFailure(err: unknown): void {
  if (writeFailureReported) return
  writeFailureReported = true
  // banner 只打一次：写日志失败不该连带刷屏，更不该影响业务
  console.error('[idbox] 日志写入失败（已忽略，功能不受影响）：', err)
}

/** 把队列里的行一次性写盘（失败只吞掉） */
async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length)
    const file = currentLogFile()
    const text = `${batch.join('\n')}\n`
    try {
      await ensureDir(path.dirname(file))
      const before = await sizeOf(file)
      await appendFile(file, text, 'utf-8')
      const after = before + Buffer.byteLength(text, 'utf-8')
      fileSizes.set(file, after)
      if (after > MAX_LOG_FILE_BYTES && !oversizeWarned.has(file)) {
        oversizeWarned.add(file)
        // 继续写，只留一条 warn 作为现场说明（不做复杂切片）
        queue.push(
          formatLogLine('warn', 'log:file-oversize', {
            file,
            bytes: after,
            limit: MAX_LOG_FILE_BYTES
          })
        )
      }
    } catch (err) {
      reportWriteFailure(err)
      return
    }
  }
}

/**
 * 冲刷队列（**测试与导出前**用；业务代码禁止 `await` 它）。
 * 返回的 Promise 在队列写完后 resolve，永不 reject。
 */
export function flushLogs(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const run = (): Promise<void> => drainQueue()
  chain = chain.then(run, run)
  return chain
}

/**
 * 崩溃现场**同步**冲刷：`uncaughtException` 之后进程随时可能被系统收走，
 * 异步 append 可能来不及。只在崩溃处理器里用。
 */
export function flushLogsSync(): void {
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  const file = currentLogFile()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${batch.join('\n')}\n`, 'utf-8')
    // 同步写绕过了 size 累加 → 丢掉缓存，下次异步写重新 stat（保证 8MB 阈值判断准确）
    fileSizes.delete(file)
  } catch (err) {
    reportWriteFailure(err)
  }
}

// ── 写日志 API（同步入队，立即返回） ──────────────────────────────────────

/** 写入一条日志（唯一入口；级别不够时直接丢弃） */
export function log(
  level: LogLevel,
  message: string,
  context?: unknown,
  source: LogSource = 'main'
): void {
  if (!isLevelEnabled(level)) return
  enqueue(formatLogLine(level, message, context, source))
}

export function logDebug(message: string, context?: unknown): void {
  log('debug', message, context)
}

export function logInfo(message: string, context?: unknown): void {
  log('info', message, context)
}

export function logWarn(message: string, context?: unknown): void {
  log('warn', message, context)
}

/**
 * 记一条 error；`err` 会转成 `{ name, message, stack }` 放进上下文的 `error` 键
 * （崩溃现场的关键就是 stack）。
 */
export function logError(message: string, err?: unknown, context?: Record<string, unknown>): void {
  const ctx: Record<string, unknown> = { ...(context ?? {}) }
  if (err !== undefined) ctx['error'] = describeError(err)
  log('error', message, ctx)
}

/** 渲染进程转发的日志（source 固定 `renderer`） */
export function logFromRenderer(payload: RendererLogPayload | undefined): void {
  if (!payload || typeof payload !== 'object') return
  const level = payload.level
  if (level !== 'error' && level !== 'warn' && level !== 'info' && level !== 'debug') return
  const message = typeof payload.message === 'string' ? payload.message.slice(0, 2000) : ''
  if (!message) return
  log(level, message, payload.context, 'renderer')
}

// ── 列表 / 统计 / 清理 / 导出 ─────────────────────────────────────────────

export interface LogFileInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
}

/** 列出日志文件（只认 `app-YYYY-MM-DD.log`，陌生文件不删不列） */
export async function listLogFiles(dir: string = logDir()): Promise<LogFileInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: LogFileInfo[] = []
  for (const name of names) {
    if (!parseLogFileDate(name)) continue
    const full = path.join(dir, name)
    try {
      const st = await stat(full)
      if (!st.isFile()) continue
      out.push({ name, path: full, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 单个文件 stat 失败（被杀软锁住）不影响整体 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 设置页展示用：目录 + 文件数 + 总大小 */
export async function logStats(dir: string = logDir()): Promise<LogStats> {
  // 顺手把目录建出来：设置页「打开日志文件夹」按钮依赖目录存在，
  // 否则用户会看到 shell 报"路径不存在"（应用刚启动、还没写过日志时就会这样）。
  await ensureDir(dir).catch(() => undefined)
  const files = await listLogFiles(dir)
  return {
    dir,
    count: files.length,
    bytes: files.reduce((sum, f) => sum + f.size, 0)
  }
}

/**
 * 清理超过保留期的日志（启动时调一次，fire-and-forget）。
 * 只删 `app-YYYY-MM-DD.log`；解析不出日期的文件一律保留。
 * @returns 删除的文件数
 */
export async function cleanupOldLogs(
  dir: string = logDir(),
  keepDays: number = LOG_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const keep = Math.max(1, Math.floor(keepDays))
  const cutoff = startOfDay(new Date(startOfDay(now) - (keep - 1) * DAY_MS))
  let removed = 0
  for (const name of names) {
    const date = parseLogFileDate(name)
    if (!date) continue
    if (startOfDay(date) >= cutoff) continue
    const full = path.join(dir, name)
    try {
      await unlink(full)
      removed++
      fileSizes.delete(full)
      oversizeWarned.delete(full)
    } catch {
      /* 被占用 / 权限不足：下次启动再试，绝不阻断启动 */
    }
  }
  return removed
}

/**
 * 把 logs 目录打成 zip（导出给开发者排查）。
 *
 * 会先 `flushLogs()`，保证**当前这一次**的日志也在包里。单个文件读取失败不阻断整体。
 * @returns 打进 zip 的文件数
 */
export async function exportLogsTo(
  destZipPath: string,
  dir: string = logDir()
): Promise<number> {
  await flushLogs()
  const files = await listLogFiles(dir)
  const zip = new AdmZip()
  let added = 0
  for (const file of files) {
    try {
      zip.addFile(file.name, await readFile(file.path))
      added++
    } catch {
      /* 单文件失败不影响其他日志 */
    }
  }
  await mkdir(path.dirname(destZipPath), { recursive: true }).catch(() => undefined)
  zip.writeZip(destZipPath)
  return added
}

// ── 启动 ────────────────────────────────────────────────────────────────

export interface InitLoggerOptions {
  /** 详细日志（设置 `verboseLogging`；settings 尚未加载时可省） */
  verbose?: boolean
  /** 覆盖日志目录（单测用；生产不传） */
  dir?: string
}

/**
 * 初始化：设级别 + 清理过期日志。**同步返回**（清理在后台跑），
 * 这样它可以在 `bootstrap()` 最早期调用，先抓住启动阶段的崩溃。
 */
export function initLogger(options: InitLoggerOptions = {}): void {
  setVerboseLogging(options.verbose === true)
  const dir = options.dir ?? logDir()
  void cleanupOldLogs(dir).catch(() => undefined)
}
