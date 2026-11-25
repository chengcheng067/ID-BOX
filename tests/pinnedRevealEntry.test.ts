/**
 * `fs:revealEntry` —— 钉选目录内「按条目在资源管理器中揭示」（2026-11-25 缺陷修复）。
 *
 * 缺陷原话：「右键选择『在资源管理器显示』时，弹开的并不是现在我右键点击的这个文件
 * 所在的文件夹。」根因是渲染层复用 `home:pinnedOpen`（只打开钉选根、不带子路径）。
 *
 * 本文件覆盖两块，缺一不可：
 * | # | 覆盖 | 防的退化 |
 * |---|------|----------|
 * | 1 | 子路径（文件 / 目录）解析成钉选根内**正确绝对路径**并交给 shell | 揭示退回钉选根 / 路径拼错 |
 * | 2 | `relPath: '../..'` 越界 → `reason:'guard'` 且**不调** shell | 前缀守卫被摘掉 / 允许穿出钉选根 |
 * | 3 | 条目已不存在 → `reason:'io'`（「这个文件已经不在了」） | 竞态删除变成未捕获异常 |
 * | 4 | 契约 / preload / 主进程三处同改（ipc.ts:3 铁律）+ handler 位置与守卫来源 | 通道只接了一半 |
 * | 5 | `main/pinnedReveal.ts` 不拼路径（解析唯一入口 = `pinnedDirGuard`） | 出现第二套路径拼接 |
 *
 * 测试范式 = `tests/pinnedThumb.test.ts`：mock electron 的 `shell`（只收集
 * `showItemInFolder` 的实参），其余全部走**真实临时目录**（`os.tmpdir()`）。
 */
import fs from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// ── electron 桩（vi.mock 提升：收集 showItemInFolder 的实参） ────────────────
const env = vi.hoisted(() => ({
  calls: [] as string[]
}))

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: (p: string) => {
      env.calls.push(p)
    }
  }
}))

// 必须在 vi.mock 之后 import：`pinnedReveal.ts` 顶层就 import 了 electron
const { resolveWithinPinRoot } = await import('../src/main/pinnedDirGuard')
const { revealEntryInExplorer } = await import('../src/main/pinnedReveal')
import type { FsRevealEntryResult } from '../src/shared/ipc'

/**
 * 与 `main/index.ts` 的 `fs:revealEntry` handler **同序**的三步（id 解析在 handler 内，
 * 需要主进程 settings，这里从「已解析的钉选根」开始）：
 * `resolveWithinPinRoot` → 越界即 guard → `revealEntryInExplorer`。
 * 保持逐行同构，handler 改动时这里必须同步（源码守卫另见第 4 组）。
 */
function reveal(rootAbs: string, relPath: string): FsRevealEntryResult {
  const guard = resolveWithinPinRoot(rootAbs, relPath)
  if (!guard.ok) return { ok: false, reason: 'guard', error: guard.error }
  return revealEntryInExplorer(guard.absPath)
}

let pinRoot = ''
const SUB_DIR_REL = '2-工作文件/2.4-模型文件'
const FILE_NAME = '椅子.skp'
let fileRel = ''

beforeAll(() => {
  pinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-reveal-pin-'))
  fs.mkdirSync(path.join(pinRoot, '2-工作文件', '2.4-模型文件'), { recursive: true })
  fileRel = `${SUB_DIR_REL}/${FILE_NAME}`
  fs.writeFileSync(path.join(pinRoot, ...fileRel.split('/')), 'fake-skp')
})

afterAll(() => {
  fs.rmSync(pinRoot, { recursive: true, force: true })
})

beforeEach(() => {
  env.calls.length = 0
})

// ════════════════════════════════════════════════════════════════════════════
// ① 子路径 → 正确绝对路径（缺陷本体）
// ════════════════════════════════════════════════════════════════════════════

describe('fs:revealEntry — 子路径解析到钉选根内的正确绝对路径', () => {
  it('文件：relPath 指向的文件被原样交给 shell（不是钉选根）', () => {
    const r = reveal(pinRoot, fileRel)
    expect(r).toEqual({ ok: true })
    expect(env.calls).toHaveLength(1)
    expect(env.calls[0]).toBe(path.join(pinRoot, '2-工作文件', '2.4-模型文件', FILE_NAME))
    // 缺陷复现点：绝不能退化成钉选根本身
    expect(env.calls[0]).not.toBe(path.resolve(pinRoot))
  })

  it('目录：relPath 指向的子目录同样交给 shell（Windows 在父目录里选中它）', () => {
    const r = reveal(pinRoot, SUB_DIR_REL)
    expect(r).toEqual({ ok: true })
    expect(env.calls[0]).toBe(path.join(pinRoot, '2-工作文件', '2.4-模型文件'))
  })

  it('relPath 空串 = 钉选根自己（保留「揭示根」的兜底语义）', () => {
    const r = reveal(pinRoot, '')
    expect(r).toEqual({ ok: true })
    expect(env.calls[0]).toBe(path.resolve(pinRoot))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② 越界拒绝（守卫零放宽）
// ════════════════════════════════════════════════════════════════════════════

describe('fs:revealEntry — 越界一律 guard 且不碰 shell', () => {
  it("relPath: '../..' → reason:'guard'，shell 未被调用", () => {
    const r = reveal(pinRoot, '../..')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('guard')
    expect(r.error.length).toBeGreaterThan(0)
    expect(env.calls).toHaveLength(0)
  })

  it('relPath 塞绝对路径 → guard（resolve 后跳出钉选根）', () => {
    const outside = path.join(os.tmpdir(), 'mv-reveal-outside')
    const r = reveal(pinRoot, outside)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('guard')
    expect(env.calls).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 条目消失 → io（永不抛错）
// ════════════════════════════════════════════════════════════════════════════

describe('fs:revealEntry — 条目已不存在', () => {
  it("不存在 → reason:'io' + 「这个文件已经不在了」，不调 shell", () => {
    const r = reveal(pinRoot, `${SUB_DIR_REL}/早就删了.skp`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('io')
    expect(r.error).toBe('这个文件已经不在了')
    expect(env.calls).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 契约 / preload / main 三处同改 + handler 位置与守卫来源
// ════════════════════════════════════════════════════════════════════════════

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

describe('IPC · fs:revealEntry 三处同改（ipc.ts:3 铁律）', () => {
  it('shared/ipc.ts 有通道 + 入参 / 返回契约（guard | invalid | io 三分支）', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("fsRevealEntry: 'fs:revealEntry'")
    expect(src).toContain('export interface FsRevealEntryInput')
    expect(src).toContain('export type FsRevealEntryResult')
    expect(src).toContain("{ ok: false; reason: 'guard' | 'invalid' | 'io'; error: string }")
  })

  it('preload 暴露 revealPinnedEntry → IPC.fsRevealEntry', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('IPC.fsRevealEntry')
    expect(src).toContain('revealPinnedEntry: (input: FsRevealEntryInput)')
  })

  it('main 有 handler：pinId 白名单 + resolveWithinPinRoot + 收口永不 reject', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    const start = src.indexOf('IPC.fsRevealEntry')
    expect(start).toBeGreaterThanOrEqual(0)
    // 尾界 = 下一个 ipcMain.handle(（既有约定，避免把邻居 handler 圈进来）
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 10))
    expect(body, '按 id 从主进程 settings 解析钉选根').toContain('resolvePinnedRootById(')
    expect(body, '必须复用 pinnedDirGuard 的解析函数').toContain('resolveWithinPinRoot(')
    expect(body, "未知 pinId / 越界 → reason:'guard'").toContain("reason: 'guard'")
    expect(body, '交给 pinnedReveal 做 stat + shell').toContain('revealEntryInExplorer(')
    expect(body).toContain('try {')
    expect(body, '不得借 0.9.2 的 openPath 通道').not.toContain('shell.openPath(')
    expect(body, '不得把钉选路径塞进 shell:reveal').not.toContain('shell.showItemInFolder(')
  })

  it('handler 位于 fs:listDir 之后（不进既有 handler 的切片区间）', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    const revealAt = src.indexOf('IPC.fsRevealEntry')
    expect(revealAt).toBeGreaterThan(src.indexOf('IPC.fsListDir'))
    expect(revealAt).toBeGreaterThan(src.indexOf('IPC.fsEntryThumb'))
  })

  it('0.9.2 allowedOpenRoots 未被本通道放宽', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    const start = src.indexOf('function allowedOpenRoots()')
    const body = src.slice(start, src.indexOf('const OPEN_PATH_DENIED', start))
    expect(body).not.toContain('homePinnedFolders')
  })
})

describe('main/pinnedReveal.ts — 不拼路径、只做 stat + shell', () => {
  const src = stripComments(readSrc('src/main/pinnedReveal.ts'))

  it('路径解析唯一入口仍是 pinnedDirGuard（本模块无 path 拼接 / 无 relPath 概念）', () => {
    expect(src).not.toContain("from 'node:path'")
    expect(src).not.toMatch(/path\.(join|resolve|normalize)/)
    expect(src).not.toContain('relPath')
  })

  it('文件与目录都走 shell.showItemInFolder（目录 = 在父目录里选中）', () => {
    expect(src).toContain('shell.showItemInFolder(absPath)')
    expect(src).toContain('statSync(absPath)')
    expect(src).toContain('这个文件已经不在了')
  })
})
