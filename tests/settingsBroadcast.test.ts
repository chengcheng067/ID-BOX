/// <reference lib="dom" />
// ↑ 本文件经 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅 tsconfig.web 程序生效） */
    modvault: ModVaultApi
  }
}
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type Settings } from '../src/shared/types'
import { IPC } from '../src/shared/ipc'

/**
 * DEF-22-1：**主进程改设置不通知渲染层**（0.8.3 真机取证）。
 *
 * 现象：`window.modvault.setSettings({theme:'dark'})` 之后 `settings.json` 已是 dark，
 * 但活实例的 `document.documentElement.dataset.theme` 仍是 light —— 界面不变、必须重启。
 * 根因：`settings:set` 的 handler 只写主进程内存 + 磁盘，渲染层收不到任何事件；
 * `App.tsx` 的主题 effect 订阅的是 **store 里的 `settings.theme`**，两者不是同一事件源。
 *
 * 这里钉的是**回路本身**（订阅 → store 更新 / 退订 / 幂等），不渲染 React：
 * vitest 是 `environment:'node'`，没有 jsdom，组件测试会得到"看起来过了但什么都没验"。
 *
 * 单测只替换两个边界：`window.modvault`（IPC）与 Dexie `db.assets`（init 要读全库）。
 * 其余全部走真实 store。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

/**
 * 「主进程推来一条设置」的模拟入口。
 *
 * 刻意**不用**"记住最后一个 handler"的写法，而是维护一个 handler 列表：
 * `ipcRenderer.on` / `off` 的真实语义就是"同一通道可以挂多份、退订只摘自己那一份"，
 * 而这个缺陷的表现正是"挂了两份" —— 桩必须能如实暴露它（列表长度 = 订阅次数）。
 */
const handlers: Array<(s: Settings) => void> = []

/** 每次订阅对应的退订函数（按注册顺序，与 `handlers` 一一对应） */
const offs: Array<() => void> = []

/** 模拟主进程 `webContents.send(IPC.settingsChanged, settings)`：推给所有在场 handler */
function push(s: Settings): void {
  for (const h of [...handlers]) h(s)
}

/** 当前挂了几个 handler（幂等断言用：必须是 1） */
function handlerCount(): number {
  return handlers.length
}

const modvault = {
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  /**
   * 照抄 preload 的 `onSettingsChanged` 形状：注册 handler + 返回退订函数。
   */
  onSettingsChanged: vi.fn((cb: (s: Settings) => void) => {
    const handler = (s: Settings): void => cb(s)
    handlers.push(handler)
    const off = (): void => {
      const at = handlers.indexOf(handler)
      if (at >= 0) handlers.splice(at, 1)
    }
    offs.push(off)
    return off
  })
}

/**
 * `init()` 会调用十几个通道（pruneThumbs / onImportEvent / onMissingThumb …），
 * 本文件关心的只有设置那条。除显式桩之外一律由 Proxy 兜底成「什么都不做的异步函数」，
 * 这样 init 能完整跑完，而新增的通道也不会让这个测试莫名其妙变红。
 */
const modvaultProxy = new Proxy(modvault as Record<string, unknown>, {
  get(target, key: string) {
    if (key in target) return target[key]
    const stub = vi.fn(async () => null)
    target[key] = stub
    return stub
  }
})

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvaultProxy as unknown as ModVaultApi
}

// ── Dexie 桩：init 会遍历 / 修补全库，全部兜底成空实现 ──
const { db } = await import('../src/renderer/db')
const fakeTable = {
  toArray: vi.fn(async (): Promise<Asset[]> => []),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  where: vi.fn(() => fakeTable),
  equals: vi.fn(() => fakeTable),
  modify: vi.fn(async () => 0),
  update: vi.fn(async () => 0),
  get: vi.fn(async () => undefined),
  count: vi.fn(async () => 0),
  filter: vi.fn(() => fakeTable),
  toCollection: vi.fn(() => fakeTable),
  each: vi.fn(async () => undefined),
  first: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault, resetSettingsBroadcastForTests } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────

const DARK: Settings = { ...DEFAULT_SETTINGS, theme: 'dark' }
const LIGHT: Settings = { ...DEFAULT_SETTINGS, theme: 'light' }

beforeEach(() => {
  handlers.length = 0
  offs.length = 0
  modvault.onSettingsChanged.mockClear()
  // 模块级幂等守卫会跨用例存活 → 每条用例前复位（与 `resetInitGuardForTests` 同性质）。
  // 不复位的话第二条用例看到「已订阅」直接 return，handler 永远挂不上。
  resetSettingsBroadcastForTests()
  useVault.setState({ settings: { ...DEFAULT_SETTINGS } })
})

// ── 契约层断言（纯源码守卫：DPC 三处必须同时改） ────────────────────

describe('settings:changed 通道契约', () => {
  it('通道名是 settings:changed，且与 setSettings 相邻定义', () => {
    expect(IPC.settingsChanged).toBe('settings:changed')
    // 不能与既有通道撞名（撞名会让 set/get 收到别人的事件）
    const values = Object.values(IPC)
    expect(values.filter((v) => v === 'settings:changed')).toHaveLength(1)
  })

  it('ModVaultApi 暴露 onSettingsChanged，返回退订函数', async () => {
    const api = window.modvault as unknown as ModVaultApi
    expect(typeof api.onSettingsChanged).toBe('function')
    const off = api.onSettingsChanged(() => undefined)
    expect(typeof off).toBe('function')
    off()
  })
})

/**
 * 主进程侧两个广播点的**源码守卫**。
 *
 * 为什么不起真 handler：`src/main/index.ts` 顶层就 `app.requestSingleInstanceLock()`
 * / `app.whenReady()` / 建窗口，导入它必然在 node 里炸；而为了这条去 mock 整个 electron
 * 主进程环境，成本远高于收益、且测到的多半是 mock 的形状。这里改为钉住**调用结构**：
 * 两条写盘路径都必须走同一个出口、且都必须在 `await saveSettings` 之后。
 */
describe('主进程广播点 · 源码守卫', () => {
  const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')

  /** 取某个 `ipcMain.handle(<通道>` 起的 handler 体（到下一个 `ipcMain.handle` 为止） */
  function handlerBody(channelConst: string): string {
    const start = MAIN.indexOf(`ipcMain.handle(${channelConst}`)
    expect(start).toBeGreaterThan(-1)
    const next = MAIN.indexOf('ipcMain.handle(', start + 10)
    return MAIN.slice(start, next > 0 ? next : undefined)
  }

  it('★广播出口接受 settings 参数（不读模块级变量，保证发的是刚写盘那份）', () => {
    expect(MAIN).toContain('function broadcastSettingsChanged(next: Settings): void')
    // 发给窗口的必须是入参，不是模块级 `settings`
    const at = MAIN.indexOf('function broadcastSettingsChanged(')
    const body = MAIN.slice(at, at + 700)
    expect(body).toContain('webContents.send(IPC.settingsChanged, next)')
    expect(body).not.toContain('webContents.send(IPC.settingsChanged, settings)')
    // 遍历所有窗口（不是只发主窗口 `win`）
    expect(body).toContain('BrowserWindow.getAllWindows()')
  })

  it('★settings:set 写盘成功后广播，且广播在 saveSettings 之后', () => {
    const body = handlerBody('IPC.setSettings')
    const saveAt = body.indexOf('await saveSettings(settings)')
    const castAt = body.indexOf('broadcastSettingsChanged(settings)')
    expect(saveAt).toBeGreaterThan(-1)
    expect(castAt).toBeGreaterThan(saveAt)
  })

  it('★chooseLibrary 写盘成功后也广播（同一个出口，不另抄一遍循环）', () => {
    const body = handlerBody('IPC.chooseLibrary')
    const saveAt = body.indexOf('await saveSettings(settings)')
    const castAt = body.indexOf('broadcastSettingsChanged(settings)')
    expect(saveAt).toBeGreaterThan(-1)
    expect(castAt).toBeGreaterThan(saveAt)
    // 不再自己写一份遍历窗口的循环（只有出口里那一处）
    expect(body).not.toContain('getAllWindows()')
    // 取消 / 没选目录 → 早退在写盘与广播之前（不能"取消了还广播"）
    const cancelAt = body.indexOf('if (r.canceled || !r.filePaths[0]) return null')
    expect(cancelAt).toBeGreaterThan(-1)
    expect(cancelAt).toBeLessThan(saveAt)
  })

  it('★写盘抛错时不会广播（两条路径都不能 catch 掉 saveSettings 的 reject）', () => {
    for (const channel of ['IPC.setSettings', 'IPC.chooseLibrary']) {
      const body = handlerBody(channel)
      const saveAt = body.indexOf('await saveSettings(settings)')
      expect(saveAt).toBeGreaterThan(-1)
      // 两条 handler 都不能把 saveSettings 包进 try/catch：一旦吞掉 reject，
      // 后面那句 broadcast 仍会执行 → 渲染层收到一份"根本没落盘"的 settings，
      // 表现正是 DEF-22-1 的反面（界面改了、重启又变回去）。
      // 判据：saveSettings 所在行到 broadcast 之间不得出现 `catch`。
      const castAt = body.indexOf('broadcastSettingsChanged(settings)')
      const between = body.slice(saveAt, castAt)
      expect(between).not.toContain('catch')
      expect(between).not.toContain('try')
    }
  })

  it('★全文件只有一处遍历窗口发送 settings:changed（防止第三条路径又抄一份）', () => {
    const sends = MAIN.split('IPC.settingsChanged').length - 1
    // 1 处 send；通道常量本身定义在 `shared/ipc.ts`，本文件不再引用第二次
    expect(sends).toBe(1)
    // `BrowserWindow.getAllWindows()` 全文件恰好 2 处：广播出口 + `app.on('activate')`
    // 的「没有窗口就重建」。写死数字而不是 `<=` —— 一旦有人再抄一份循环，
    // 这条会立刻红；而 `<=` 会静默放过。
    const loops = MAIN.split('BrowserWindow.getAllWindows()').length - 1
    expect(loops).toBe(2)
  })
})

// ── 主行为：收到广播 → store.settings 更新 ──────────────────────────

describe('init() 订阅设置广播', () => {
  it('订阅后收到广播 → store.settings 被整体替换（不是合并）', async () => {
    await useVault.getState().init()

    expect(handlerCount()).toBe(1)

    push(DARK)

    expect(useVault.getState().settings?.theme).toBe('dark')
    // **整体替换**而非 `{...old, ...next}`：主进程广播的是归一化后的完整对象，
    // 合并会让"被 normalize 砍掉的非法字段"留在渲染层，两端口径漂移。
    expect(useVault.getState().settings).toEqual(DARK)
  })

  it('再次广播会把值改回去（主题 effect 能跟着来回切）', async () => {
    await useVault.getState().init()

    push(DARK)
    expect(useVault.getState().settings?.theme).toBe('dark')

    push(LIGHT)
    expect(useVault.getState().settings?.theme).toBe('light')
  })

  it('广播**不触发**第二次 getSettings（广播里已带对象，不再读盘）', async () => {
    await useVault.getState().init()
    const readsAfterInit = modvault.getSettings.mock.calls.length

    push(DARK)
    push(LIGHT)

    expect(modvault.getSettings.mock.calls.length).toBe(readsAfterInit)
  })

  it('退订函数真的断开了订阅（退回给调用方的那一个 off）', async () => {
    await useVault.getState().init()
    expect(handlerCount()).toBe(1)

    // 用**订阅时返回的那个 off** 退订（不是"清空数组"这种作弊写法）——
    // 这条钉的是 preload 的 `ipcRenderer.off` 契约：退订必须摘掉自己的 handler。
    offs[0]()

    useVault.setState({ settings: { ...LIGHT } })
    push(DARK)
    expect(useVault.getState().settings?.theme).toBe('light')
    expect(handlerCount()).toBe(0)
  })

  it('重复调 init 不会重复订阅（StrictMode 双跑 / rescan 重建）', async () => {
    await useVault.getState().init()
    await useVault.getState().init()
    await useVault.getState().init()

    // 关键：三次 init 只挂一个 handler（挂三份 = 同一条广播被处理三次）
    expect(handlerCount()).toBe(1)
    expect(modvault.onSettingsChanged.mock.calls.length).toBe(1)

    // 且一条广播只落一次库：先置 LIGHT，推 DARK，统计 store 的写入次数。
    // 重复订阅时会是 3 次 set（值相同，肉眼看不出来，只能靠订阅计数钉住）。
    const seen: string[] = []
    const unsub = useVault.subscribe((s) => {
      if (s.settings) seen.push(s.settings.theme)
    })
    useVault.setState({ settings: { ...LIGHT } })
    seen.length = 0
    push(DARK)
    unsub()

    expect(seen.filter((t) => t === 'dark')).toHaveLength(1)
  })

  it('订阅发生在 init 的 set 之后：init 读到的新值不会被旧快照盖回去', async () => {
    // 模拟"主进程在这期间被改成了 dark"：getSettings 返回 dark，
    // 而 init 之前 store 里是默认（light）
    modvault.getSettings.mockResolvedValueOnce({ ...DARK })
    useVault.setState({ settings: { ...LIGHT } })

    await useVault.getState().init()

    expect(useVault.getState().settings?.theme).toBe('dark')
    // 订阅已就位，后续广播照常生效
    push(LIGHT)
    expect(useVault.getState().settings?.theme).toBe('light')
  })
})
