/// <reference lib="dom" />
/**
 * 主进程健壮性（C3）：单实例锁 + 设置原子写 + 测试时序。
 *
 * 两条塌点的真实后果：
 * ① 丢弃 `requestSingleInstanceLock()` 返回值 → 第二个进程照常启动，两个进程共用同一份
 *    userData，IndexedDB 打不开 → `init()` reject → 界面永久卡在「正在加载…」；
 * ② `writeFile(settings.json)` 非原子：进程在写入中途被杀会留下**截断 JSON**，
 *    `loadSettings` 解析失败回落默认值 → `libraryDir` 一起丢 → 用户看到"库空了"。
 *
 * Electron 不可用，这里 mock 掉 `app.getPath`，其余全是**真实文件 IO**（os.tmpdir）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const state = vi.hoisted(() => ({ userData: '' }))

// settings.ts / paths.ts 只在函数内部用 app.getPath，mock 出最小面即可
vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData,
    getAppPath: () => state.userData,
    getVersion: () => '0.0.0-test'
  }
}))

const { loadSettings, saveSettings, settingsBackupPath, settingsFilePath, settingsTmpPath } =
  await import('../src/main/settings')

const tmpRoots: string[] = []

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(p, 'utf-8')) as Record<string, unknown>
}

const A = 'E:\\LibA\\Library'
const B = 'E:\\LibB\\Library'
const C = 'E:\\LibC\\Library'

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-settings-'))
  tmpRoots.push(root)
  // 多一层 userData：旧品牌迁移会去看 `<parent>/modvault/settings.json`，这里 parent 是唯一 tmp
  state.userData = path.join(root, 'userData')
  await fs.mkdir(state.userData, { recursive: true })
})

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('设置原子写（C3）：tmp → bak → rename', () => {
  it('保存后 settings.json.tmp 不存在（已 rename），主档内容正确', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: A })

    expect(settingsTmpPath()).toBe(`${settingsFilePath()}.tmp`)
    expect(await exists(settingsTmpPath())).toBe(false)
    expect(await exists(settingsFilePath())).toBe(true)
    expect((await readJson(settingsFilePath())).libraryDir).toBe(A)
  })

  it('覆写前把**上一版**主档复制成一代 .bak（首存无 bak，不报错）', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: A })
    expect(await exists(settingsBackupPath())).toBe(false) // 首次保存没有"上一份好档"

    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: B })
    expect((await readJson(settingsBackupPath())).libraryDir).toBe(A)

    // 只保留一代：第三次保存后 bak 是 B（不是 A，也不是链式多份）
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: C })
    expect((await readJson(settingsBackupPath())).libraryDir).toBe(B)
    expect((await readJson(settingsFilePath())).libraryDir).toBe(C)
  })

  it('主档被写成截断 JSON（模拟进程中途被杀）→ 从 .bak 恢复出原 libraryDir', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: A })
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: B }) // bak = A
    // 模拟 writeFile 中途被杀：只剩半截
    await fs.writeFile(settingsFilePath(), '{"libraryDir":"E:\\\\LibB', 'utf-8')

    const loaded = await loadSettings()

    expect(loaded.libraryDir).toBe(A) // 不是默认值，也不是坏档里的半截值
  })

  it('主档与 .bak 都坏 → 回落默认值且不抛异常', async () => {
    await fs.writeFile(settingsFilePath(), 'not json at all', 'utf-8')
    await fs.writeFile(settingsBackupPath(), '{"theme":', 'utf-8')

    const loaded = await loadSettings()

    expect(loaded.libraryDir).toBeTruthy() // 探测出的可用库目录（或常量默认）
    expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(loaded.extractConcurrency).toBe(DEFAULT_SETTINGS.extractConcurrency)
  })

  it('正常保存/读取往返不受原子写影响（归一化仍生效）', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, libraryDir: A, theme: 'dark', extractConcurrency: 5 })
    const loaded = await loadSettings()
    expect(loaded.libraryDir).toBe(A)
    expect(loaded.theme).toBe('dark')
    expect(loaded.extractConcurrency).toBe(5)
  })
})

describe('单实例锁（源码守卫：必须接收返回值且用 else 拦住 bootstrap）', () => {
  const src = (): string =>
    readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')

  it('requestSingleInstanceLock 的返回值被接收（不是丢弃返回值的裸调用）', () => {
    const code = src()
    expect(code).toMatch(/const\s+gotSingleInstanceLock\s*=\s*app\.requestSingleInstanceLock\(\)/)
    // 旧写法（返回值丢弃）不得复活
    expect(code).not.toMatch(/^\s*app\.requestSingleInstanceLock\(\)\s*$/m)
  })

  it('第二个实例：app.quit() 在 if 内，bootstrap() 在 else 内（quit 不会中断当前 tick）', () => {
    const code = src()
    expect(code).toMatch(/if\s*\(!gotSingleInstanceLock\)\s*\{[\s\S]{0,400}?app\.quit\(\)/)
    expect(code).toMatch(/\}\s*else\s*\{\s*bootstrap\(\)/)
    // bootstrap 才是注册 whenReady / 建窗口的地方
    const boot = code.slice(code.indexOf('function bootstrap()'), code.indexOf('const gotSingleInstanceLock'))
    expect(boot).toContain('app.whenReady()')
    expect(boot).toContain('createWindow()')
    expect(boot).toContain('registerVaultScheme()')
    // 顶层不得再直接调 whenReady（否则第二个实例也会启动）
    const outside = code.slice(code.indexOf('const gotSingleInstanceLock'))
    expect(outside).not.toContain('app.whenReady()')
  })
})

describe('测试时序加固（ballCache waitFor）', () => {
  it('默认等待阈值 ≥ 8000ms（3 秒在并行跑时会偶发红）', () => {
    const code = readFileSync(new URL('./ballCache.test.ts', import.meta.url), 'utf-8')
    const m = /async function waitFor\(cond: \(\) => boolean, ms = (\d+)\)/.exec(code)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(8000)
    // 轮询间隔保持 10ms 不变（条件满足即返回，不会拖慢）
    expect(code).toContain('setTimeout(r, 10)')
  })
})
