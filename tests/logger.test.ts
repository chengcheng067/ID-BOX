/**
 * 诊断日志单测（2026-10 拖出闪退取证 + 用户自助导出）。
 *
 * 覆盖团队验收要求的 6 条：
 *   ① 日志行格式；② apiKey 脱敏；③ 7 天清理；④ 导出 zip 含日志文件；
 *   ⑤ verbose 开关改变级别；⑥ 渲染进程错误限流。
 * 另加：渲染侧转发走 `[renderer]` 来源、陌生文件名不被误删。
 *
 * Electron 不可用：mock 掉 `app.getPath`，其余全是真实文件 IO（os.tmpdir）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import {
  createLogThrottle,
  installRendererLogHooks,
  LOG_THROTTLE_MAX_PER_WINDOW,
  LOG_THROTTLE_WINDOW_MS
} from '../src/renderer/logic/rendererLog'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    getAppPath: () => state.userData,
    getVersion: () => '0.0.0-test'
  }
}))

const {
  cleanupOldLogs,
  exportLogsTo,
  flushLogs,
  formatLogLine,
  log,
  logDebug,
  logExportFileName,
  logFileNameFor,
  logFromRenderer,
  logInfo,
  logStats,
  logDir,
  listLogFiles,
  parseLogFileDate,
  serializeContext,
  setVerboseLogging
} = await import('../src/main/logger')

const tmpRoots: string[] = []

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-logs-'))
  tmpRoots.push(root)
  state.userData = path.join(root, 'userData')
  await fs.mkdir(state.userData, { recursive: true })
  setVerboseLogging(false)
})

afterEach(async () => {
  await flushLogs().catch(() => undefined)
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function readToday(): Promise<string> {
  const file = path.join(logDir(), logFileNameFor())
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return ''
  }
}

describe('① 日志行格式', () => {
  it('单行格式为 `<ISO> [来源] [LEVEL] <消息> <JSON 上下文>`', () => {
    const at = new Date('2026-10-20T01:02:03.456Z')
    const line = formatLogLine('info', 'drag:start', { abs: 'E:\\Lib\\a.skp', iconKind: 'thumb' }, 'main', at)

    const head = '2026-10-20T01:02:03.456Z [main] [INFO] drag:start '
    expect(line.startsWith(head)).toBe(true)
    // 上下文是合法 JSON（脱敏后）
    expect(JSON.parse(line.slice(head.length))).toEqual({ abs: 'E:\\Lib\\a.skp', iconKind: 'thumb' })
    // 一行一条：不含换行
    expect(line).not.toContain('\n')
  })

  it('消息里的换行被压成空格（保证"一行一条"）', () => {
    const line = formatLogLine('error', 'line1\nline2\r\nline3', undefined, 'renderer')
    expect(line).toContain('[renderer] [ERROR] line1 line2 line3')
    expect(line.split('\n').length).toBe(1)
  })

  it('落盘内容可被逐行解析（时间 + 来源 + 级别）', async () => {
    logInfo('drag:start', { abs: 'E:\\Lib\\a.skp' })
    log('error', 'drag:start:returned', undefined)
    await flushLogs()

    const text = await readToday()
    const lines = text.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[main\] \[INFO\] drag:start \{/)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[main\] \[ERROR\] drag:start:returned$/)
  })
})

describe('② 密钥脱敏', () => {
  it('apiKey / Authorization / token 的值替换成 ***（含嵌套与数组）', () => {
    const json = serializeContext({
      apiKey: 'sk-secret',
      nested: { Authorization: 'Bearer abc', token: 'tk-1', keep: 'visible' },
      list: [{ api_key: 'sk-2' }]
    })
    const parsed = JSON.parse(json) as Record<string, unknown>

    expect(parsed['apiKey']).toBe('***')
    expect(parsed['nested']).toEqual({ Authorization: '***', token: '***', keep: 'visible' })
    expect(parsed['list']).toEqual([{ api_key: '***' }])
    expect(json).not.toContain('sk-secret')
    expect(json).not.toContain('Bearer abc')
    expect(json).not.toContain('tk-1')
  })

  it('落盘文件里也查不到明文密钥（脱敏在写入前完成）', async () => {
    logInfo('ai:test', { apiKey: 'sk-live-1234567890', model: 'gpt-4o-mini' })
    await flushLogs()

    const text = await readToday()
    expect(text).toContain('***')
    expect(text).toContain('gpt-4o-mini')
    expect(text).not.toContain('sk-live-1234567890')
  })
})

describe('③ 保留最近 7 天', () => {
  const names = (offsets: number[], now: Date): string[] =>
    offsets.map((d) => logFileNameFor(new Date(now.getTime() - d * 24 * 60 * 60 * 1000)))

  it('删除 7 天以前的 app-*.log，保留 7 天内与陌生文件', async () => {
    const dir = logDir()
    await fs.mkdir(dir, { recursive: true })
    const now = new Date(2026, 9, 20, 12, 0, 0) // 2026-10-20
    const offsets = [0, 3, 6, 8, 10]
    const created = names(offsets, now)
    for (const n of created) await fs.writeFile(path.join(dir, n), 'x\n', 'utf-8')
    await fs.writeFile(path.join(dir, 'notes.txt'), 'keep me', 'utf-8')

    const removed = await cleanupOldLogs(dir, 7, now)

    expect(removed).toBe(2) // -8 / -10
    const left = (await fs.readdir(dir)).sort()
    expect(left).toContain(created[0])
    expect(left).toContain(created[1])
    expect(left).toContain(created[2])
    expect(left).not.toContain(created[3])
    expect(left).not.toContain(created[4])
    expect(left).toContain('notes.txt') // 陌生文件绝不删
  })

  it('非法日期文件名不被当成日志（不列、不删）', () => {
    expect(parseLogFileDate('app-2026-02-31.log')).toBeNull() // Date 会规范化成 3 月 → 拒绝
    expect(parseLogFileDate('app-2026-10-20.log')?.getDate()).toBe(20)
    expect(parseLogFileDate('other-2026-10-20.log')).toBeNull()
  })

  it('logStats 只统计 app-*.log 的数量与总大小', async () => {
    const dir = logDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'app-2026-10-20.log'), 'abc\n', 'utf-8')
    await fs.writeFile(path.join(dir, 'app-2026-10-19.log'), 'de\n', 'utf-8')
    await fs.writeFile(path.join(dir, 'readme.txt'), 'ignored', 'utf-8')

    const stats = await logStats(dir)
    expect(stats.dir).toBe(dir)
    expect(stats.count).toBe(2)
    expect(stats.bytes).toBe(4 + 3)
    expect((await listLogFiles(dir)).map((f) => f.name)).toEqual([
      'app-2026-10-19.log',
      'app-2026-10-20.log'
    ])
  })
})

describe('④ 导出 zip', () => {
  it('zip 里含当前日志文件，内容与落盘一致', async () => {
    logInfo('drag:start', { abs: 'E:\\Lib\\a.skp', iconKind: 'thumb' })
    await flushLogs()

    const zipPath = path.join(state.userData, 'out', logExportFileName())
    const count = await exportLogsTo(zipPath)

    expect(count).toBe(1)
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map((e) => e.entryName)
    expect(entries).toEqual([logFileNameFor()])
    expect(zip.readAsText(logFileNameFor())).toContain('drag:start')
  })

  it('默认文件名形如 idbox-logs-YYYYMMDD-HHmm.zip', () => {
    const name = logExportFileName(new Date(2026, 9, 20, 3, 7))
    expect(name).toBe('idbox-logs-20261020-0307.zip')
  })
})

describe('⑤ verbose 开关改变级别', () => {
  it('关闭时丢弃 debug；打开后落盘', async () => {
    setVerboseLogging(false)
    logDebug('debug:off', { n: 1 })
    await flushLogs()
    expect(await readToday()).toBe('')

    setVerboseLogging(true)
    logDebug('debug:on', { n: 2 })
    await flushLogs()
    const text = await readToday()
    expect(text).toContain('[DEBUG] debug:on')
    expect(text).not.toContain('debug:off')
  })

  it('info 及以上始终落盘（verbose 不影响 error/warn/info）', async () => {
    setVerboseLogging(false)
    log('warn', 'w1')
    logInfo('i1')
    log('error', 'e1')
    await flushLogs()

    const text = await readToday()
    expect(text).toContain('[WARN] w1')
    expect(text).toContain('[INFO] i1')
    expect(text).toContain('[ERROR] e1')
  })
})

describe('⑥ 渲染进程错误限流', () => {
  it('每 10 秒最多 20 条；同一条消息 10 秒内只过一次', () => {
    const t = createLogThrottle()
    const start = 1_000_000

    for (let i = 0; i < LOG_THROTTLE_MAX_PER_WINDOW; i++) {
      expect(t.allow(`msg-${i}`, start + i)).toBe(true)
    }
    // 第 21 条（不同消息）被总量卡住
    expect(t.allow('msg-overflow', start + 50)).toBe(false)
    // 同一消息重复（即便窗口还有余量）也被去重 —— 用新窗口验证
    const t2 = createLogThrottle()
    expect(t2.allow('same', start)).toBe(true)
    expect(t2.allow('same', start + 1)).toBe(false)
    expect(t2.allow('same', start + LOG_THROTTLE_WINDOW_MS)).toBe(true)
    expect(t2.suppressed()).toBe(1)
  })

  it('窗口滑过后恢复；被压掉的计数会带在后续日志里', () => {
    const t = createLogThrottle()
    expect(t.allow('x', 0)).toBe(true)
    expect(t.allow('x', 5_000)).toBe(false)
    expect(t.allow('x', 10_001)).toBe(true)
    expect(t.suppressed()).toBe(1)
  })

  it('installRendererLogHooks 把 window 错误按限流转发（含上下文与 stack）', () => {
    const listeners = new Map<string, (ev: unknown) => void>()
    const target = {
      addEventListener: (type: string, cb: (ev: unknown) => void) => {
        listeners.set(type, cb)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      }
    }
    const sent: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
    const uninstall = installRendererLogHooks((p) => sent.push(p), {
      target,
      throttle: createLogThrottle()
    })

    const err = new Error('boom')
    listeners.get('error')?.({ message: 'boom', filename: 'app.js', lineno: 12, colno: 3, error: err })
    // 同一条消息（同一 detail）10 秒内只报一次
    listeners.get('error')?.({ message: 'boom', filename: 'app.js', lineno: 12, colno: 3, error: err })
    listeners.get('unhandledrejection')?.({ reason: new Error('promise-boom') })

    expect(sent.length).toBe(2)
    expect(sent[0]?.message).toBe('window:error')
    expect(sent[0]?.level).toBe('error')
    expect(sent[0]?.context?.['detail']).toBe('boom')
    expect(String(sent[0]?.context?.['stack'])).toContain('boom')
    expect(sent[1]?.message).toBe('window:unhandledrejection')
    expect(sent[1]?.context?.['detail']).toBe('promise-boom')

    uninstall()
    expect(listeners.size).toBe(0)
  })
})

describe('渲染侧日志落到 [renderer] 来源', () => {
  it('合法载荷落盘为 [renderer]；非法级别 / 空消息被丢弃', async () => {
    logFromRenderer({ level: 'error', message: 'window:error', context: { detail: 'boom' } })
    logFromRenderer({ level: 'verbose' as never, message: 'nope' })
    logFromRenderer({ level: 'warn', message: '' })
    logFromRenderer(undefined)
    await flushLogs()

    const text = await readToday()
    expect(text).toContain('[renderer] [ERROR] window:error')
    expect(text).not.toContain('nope')
    expect(text.trim().split('\n').length).toBe(1)
  })
})

// ── ⑦ 崩溃取证接线（源码守卫） ────────────────────────────────────────
//
// 这套日志存在的唯一理由是"崩在 native drag 里也能留下现场"，所以接线本身
// 必须有测试锁住——否则后来人把 flushLogsSync 挪走 / 换成异步，日志会静默失效，
// 而且平时完全看不出来（只有崩溃那天才会发现没有现场）。

describe('⑦ 拖出闪退取证接线（源码守卫）', () => {
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')
  // 用"代码行"做锚点（注释里也提到过 startDrag，模糊匹配会命中注释）
  const callAnchor = '  event.sender.startDrag({ file: abs, icon: icon.icon })'

  it('startDrag 前记 drag:start、后记 drag:start:returned', () => {
    const before = src.indexOf("logInfo('drag:start',")
    const call = src.indexOf(callAnchor)
    const after = src.indexOf("logInfo('drag:start:returned'")

    expect(before).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(call)
  })

  it('drag:start 在 startDrag **之前**同步冲刷（否则崩在 native 里这行永远写不进磁盘）', () => {
    const before = src.indexOf("logInfo('drag:start',")
    const call = src.indexOf(callAnchor)
    const segment = src.slice(before, call)
    expect(segment).toContain('flushLogsSync()')
  })

  it('崩在 native 内与崩在 handler 之前可由日志区分（有 before 无 returned）', () => {
    // 文档性断言：两行日志的 message 必须不同，才能做"缺行"判定
    expect(src).toContain("'drag:start'")
    expect(src).toContain("'drag:start:returned'")
  })

  it('挂上了 uncaughtException / unhandledRejection / render-process-gone / child-process-gone，且不再 process.exit', () => {
    const start = src.indexOf('function installCrashHandlers')
    const end = src.indexOf('function createWindow')
    const block = src.slice(start, end)

    expect(block).toContain("process.on('uncaughtException'")
    expect(block).toContain("process.on('unhandledRejection'")
    expect(block).toContain("app.on('render-process-gone'")
    expect(block).toContain("app.on('child-process-gone'")
    // Electron 33 已移除 gpu-process-crashed（由 child-process-gone 覆盖），不得硬加
    expect(block).not.toContain("'gpu-process-crashed'")
    // 桌面应用吞掉异常，不立刻退出（用户还能保存工作 / 导出日志）
    expect(block).not.toContain('process.exit')
    // 崩溃必须标记 fatal，且同步冲刷
    expect(block).toContain('fatal: true')
    expect(block).toContain('flushLogsSync()')
  })

  it('启动时记录版本 / 平台 / 库目录（且不含 apiKey 键）', () => {
    const start = src.indexOf("logInfo('app:ready'")
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, start + 1200)
    expect(block).toContain('appVersion')
    expect(block).toContain('electron')
    expect(block).toContain('platform')
    expect(block).toContain('libraryDir')
    expect(block).toContain('userData')
    expect(block).not.toContain('apiKey:')
  })
})
