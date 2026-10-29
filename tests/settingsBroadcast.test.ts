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
import { applyLibraryChoice, broadcastSettingsToWindows } from '../src/main/settingsBroadcast'

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

// ── 主进程广播内核：**真桩验证**（不是源码扫字） ──────────────────────
//
// `src/main/settingsBroadcast.ts` 是零 electron 依赖的纯逻辑内核，所以这里的
// `chooseLibrary` 路径可以真的跑起来、真的数广播次数。
// `main/index.ts` 只留一层薄封装（把 `BrowserWindow.getAllWindows()` / `IPC.settingsChanged` /
// `logWarn` 注进去），那层由下面的「接线守卫」组钉。

describe('broadcastSettingsToWindows · 遍历 / 容错', () => {
  function fakeWindow(
    opts: { destroyed?: boolean; wcDestroyed?: boolean; throws?: boolean } = {}
  ) {
    const send = vi.fn(() => {
      if (opts.throws) throw new Error('send failed')
    })
    return {
      isDestroyed: () => opts.destroyed === true,
      webContents: { isDestroyed: () => opts.wcDestroyed === true, send }
    }
  }

  it('向所有活窗口各发一次，参数就是传入的 settings', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    const settings = { theme: 'dark' } as unknown as Settings
    const r = broadcastSettingsToWindows(settings, {
      allWindows: () => [a, b],
      channel: IPC.settingsChanged
    })
    expect(r).toEqual({ sent: 2, skipped: 0, failed: 0 })
    expect(a.webContents.send).toHaveBeenCalledWith('settings:changed', settings)
    expect(b.webContents.send).toHaveBeenCalledWith('settings:changed', settings)
  })

  it('已销毁的窗口（自身或 webContents）跳过，不发', () => {
    const alive = fakeWindow()
    const dead1 = fakeWindow({ destroyed: true })
    const dead2 = fakeWindow({ wcDestroyed: true })
    const r = broadcastSettingsToWindows({} as Settings, {
      allWindows: () => [alive, dead1, dead2],
      channel: IPC.settingsChanged
    })
    expect(r).toEqual({ sent: 1, skipped: 2, failed: 0 })
    expect(dead1.webContents.send).not.toHaveBeenCalled()
    expect(dead2.webContents.send).not.toHaveBeenCalled()
  })

  it('某个窗口 send 抛错 → 不中断其余窗口，且不向调用方冒泡', () => {
    const bad = fakeWindow({ throws: true })
    const good = fakeWindow()
    const onError = vi.fn()
    const r = broadcastSettingsToWindows({} as Settings, {
      allWindows: () => [bad, good],
      channel: IPC.settingsChanged,
      onError
    })
    expect(r).toEqual({ sent: 1, skipped: 0, failed: 1 })
    expect(good.webContents.send).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('send failed')
  })

  it('allWindows 自身抛错 → 静默返回全 0（广播是尽力而为的副作用）', () => {
    const onError = vi.fn()
    const r = broadcastSettingsToWindows({} as Settings, {
      allWindows: () => {
        throw new Error('no window module')
      },
      channel: IPC.settingsChanged,
      onError
    })
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(onError).toHaveBeenCalledWith('no window module')
  })
})

describe('applyLibraryChoice · ★chooseLibrary 的广播行为（桩验证）', () => {
  const CURRENT = { theme: 'dark', libraryDir: 'E:/old' } as unknown as Settings

  it('★选了目录 → 写盘一次 + 广播一次，且广播的是已合并 libraryDir 的那份', async () => {
    const saved: unknown[] = []
    const cast: unknown[] = []
    const next = await applyLibraryChoice(CURRENT, 'E:/new', {
      saveSettings: async (s) => {
        saved.push(s)
      },
      broadcast: (s) => cast.push(s)
    })

    expect(saved).toHaveLength(1)
    expect(cast).toHaveLength(1)
    // 发出去的正是刚写盘的那一份（同一个对象引用，不是各造一份）
    expect(cast[0]).toBe(saved[0])
    expect((cast[0] as Settings).libraryDir).toBe('E:/new')
    // 其余字段原样保留（只合并 libraryDir，不整对象替换）
    expect((cast[0] as Settings).theme).toBe('dark')
    expect((next as Settings).libraryDir).toBe('E:/new')
  })

  it('★取消（dir 为 undefined）→ 不写盘、不广播、返回 null', async () => {
    const saveSettings = vi.fn(async () => undefined)
    const broadcast = vi.fn()
    const next = await applyLibraryChoice(CURRENT, undefined, { saveSettings, broadcast })

    expect(next).toBeNull()
    expect(saveSettings).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('★空串目录也不写不广播（空目录不是有效选择）', async () => {
    const saveSettings = vi.fn(async () => undefined)
    const broadcast = vi.fn()
    await applyLibraryChoice(CURRENT, '', { saveSettings, broadcast })
    expect(saveSettings).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('★写盘 reject → 广播一次都不发，错误原样冒泡给调用方', async () => {
    const broadcast = vi.fn()
    await expect(
      applyLibraryChoice(CURRENT, 'E:/new', {
        saveSettings: async () => {
          throw new Error('disk full')
        },
        broadcast
      })
    ).rejects.toThrow('disk full')
    expect(broadcast).not.toHaveBeenCalled()
  })
})

/**
 * 接线层源码守卫。
 *
 * 内核已用真桩验过行为（上面两组），这里只钉 `main/index.ts` 那层薄封装：
 * 两条写盘路径都走同一个出口、都在写盘之后、`chooseLibrary` 不再自己抄一遍循环。
 * 为什么不导入 `main/index.ts`：它顶层就 `app.requestSingleInstanceLock()` /
 * `app.whenReady()` / 建窗口，导入必然在 node 里炸。
 */
describe('resetSettingsBroadcastForTests · 只许单测用', () => {
  it('★生产代码里没有任何调用点（renderer / main / preload / shared 全扫）', () => {
    // 这个函数复位标志但不退订 handler，运行时调用会让订阅线性泄漏。
    // 「只给单测用」写在注释里不够 —— 注释拦不住人，这条断言能。
    const roots = ['src/renderer', 'src/main', 'src/preload', 'src/shared']
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(new URL('../' + dir, import.meta.url), {
        withFileTypes: true
      })) {
        const rel = dir + '/' + entry.name
        if (entry.isDirectory()) {
          walk(rel)
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          // 定义处自己当然会出现这个名字，跳过
          if (rel === 'src/renderer/store.ts') continue
          const text = fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf-8')
          if (text.includes('resetSettingsBroadcastForTests')) offenders.push(rel)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(offenders).toEqual([])
  })
})

describe('主进程接线 · 源码守卫', () => {
  const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')

  /** 取某个 `ipcMain.handle(<通道>` 起的 handler 体（到下一个 `ipcMain.handle` 为止） */
  function handlerBody(channelConst: string): string {
    const start = MAIN.indexOf('ipcMain.handle(' + channelConst)
    expect(start).toBeGreaterThan(-1)
    const next = MAIN.indexOf('ipcMain.handle(', start + 10)
    return MAIN.slice(start, next > 0 ? next : undefined)
  }

  it('★广播出口接受 settings 参数，且只把真实依赖注进内核', () => {
    expect(MAIN).toContain('function broadcastSettingsChanged(next: Settings): void')
    const at = MAIN.indexOf('function broadcastSettingsChanged(')
    const body = MAIN.slice(at, at + 600)
    expect(body).toContain('broadcastSettingsToWindows(next,')
    expect(body).toContain('allWindows: () => BrowserWindow.getAllWindows()')
    expect(body).toContain('channel: IPC.settingsChanged')
    // 遍历窗口的循环只在核心里，接线层不许再写一份
    expect(body).not.toContain('for (const target of')
  })

  it('★settings:set 写盘成功后广播，且广播在 saveSettings 之后', () => {
    const body = handlerBody('IPC.setSettings')
    const saveAt = body.indexOf('await saveSettings(settings)')
    const castAt = body.indexOf('broadcastSettingsChanged(settings)')
    expect(saveAt).toBeGreaterThan(-1)
    expect(castAt).toBeGreaterThan(saveAt)
  })

  it('★chooseLibrary 走 applyLibraryChoice（决策外置），且自己不含窗口遍历', () => {
    const body = handlerBody('IPC.chooseLibrary')
    expect(body).toContain('applyLibraryChoice(')
    expect(body).not.toContain('getAllWindows()')
    // 取消判断交给内核，handler 里不再有裸 saveSettings
    expect(body).not.toContain('await saveSettings(')
    expect(body).toContain('r.canceled ? undefined : r.filePaths[0]')
  })

  it('★全文件只有一处遍历窗口（防止第三条路径又抄一份）', () => {
    // BrowserWindow.getAllWindows() 全文件恰好 2 处：广播出口注入 + app.on("activate")
    // 的空窗口重建。写死数字而不是 <=，否则第三条路径抄一份会被静默放过。
    expect(MAIN.split('BrowserWindow.getAllWindows()').length - 1).toBe(2)
    // IPC.settingsChanged 在本文件只出现 1 次（注进内核那一处）
    expect(MAIN.split('IPC.settingsChanged').length - 1).toBe(1)
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
