/**
 * 「发现新版本」弹窗的状态机单测（2026-11）。
 *
 * 三块：
 * ① `shouldShowUpdateDialog` 的 **7 条规则逐条**（产品契约，纯函数，不 mock 任何东西）；
 * ② `localStorage` 不可用 / 读写抛异常时**不崩**（隐私模式、配额满、老 preload）；
 * ③ 源码守卫：弹窗真的按约定的 a11y 属性 / 按钮 / Esc 层 / 懒加载接线写着。
 *
 * 注意这里是 `environment: 'node'`：不渲染 React，所以不测"长什么样"，
 * 只测"什么条件下该出现"和"接线的形状"。视觉与交互（点击、Esc）由 `escLayer` /
 * `updateState` 各自的既有测试与真机走查覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SKIPPED_VERSION_KEY,
  checkForUpdate,
  dismissUpdateDialog,
  getSkippedVersion,
  resetUpdateDialogStateForTest,
  shouldShowUpdateDialog,
  skipUpdateVersion
} from '../src/renderer/logic/updateState'
import type { UpdateInfo } from '../src/shared/types'

const read = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

/** 一份"检查成功、有新版本"的结论（其余用例按需覆盖字段） */
function makeInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '1.0.3',
    latest: '1.0.4',
    hasUpdate: true,
    url: 'https://github.com/chengcheng067/ID-BOX/releases/tag/v1.0.4',
    assetUrl: 'https://example.com/IDBOX-Setup-1.0.4.exe',
    publishedAt: '2026-11-09T10:00:00Z',
    notes: '## 新功能\n- 弹窗展示更新内容',
    checkedAt: 1_760_000_000_000,
    error: null,
    ...over
  }
}

/** 内存版 localStorage（不碰真实存储：node 环境的 `localStorage` 行为随版本变化） */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    }
  } as Storage
}

/** 装上/卸下一份假 localStorage（`configurable: true` 才能删掉还原） */
function installStorage(storage: Storage | null): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true
  })
}

beforeEach(() => {
  resetUpdateDialogStateForTest()
})

afterEach(() => {
  resetUpdateDialogStateForTest()
  // 别把假存储留给其它测试文件（vitest 同一 worker 里模块是共享的）
  Reflect.deleteProperty(globalThis, 'localStorage')
  Reflect.deleteProperty(globalThis, 'modvault')
})

describe('shouldShowUpdateDialog：7 条规则逐条', () => {
  it('规则 1：没检查过（info = null）→ 不弹', () => {
    expect(shouldShowUpdateDialog(null, null, false)).toBe(false)
  })

  it('规则 2：检查失败（error 非 null）→ 不弹（失败不是"有更新"）', () => {
    for (const error of ['network', 'http', 'parse'] as const) {
      expect(shouldShowUpdateDialog(makeInfo({ error, hasUpdate: false }), null, false)).toBe(false)
      // 即使脏数据里 hasUpdate 还为 true，也不弹
      expect(shouldShowUpdateDialog(makeInfo({ error }), null, false)).toBe(false)
    }
  })

  it('规则 3：已是最新（hasUpdate = false）→ 不弹', () => {
    expect(shouldShowUpdateDialog(makeInfo({ hasUpdate: false }), null, false)).toBe(false)
  })

  it('规则 4：latest 为 null（数据不完整）→ 不弹', () => {
    expect(shouldShowUpdateDialog(makeInfo({ latest: null }), null, false)).toBe(false)
  })

  it('规则 5：latest === 已跳过的版本 → 不弹（次次启动都不弹）', () => {
    expect(shouldShowUpdateDialog(makeInfo({ latest: '1.0.4' }), '1.0.4', false)).toBe(false)
  })

  it('规则 5 的反面：跳过的是**旧版本** → 新版本照常弹', () => {
    expect(shouldShowUpdateDialog(makeInfo({ latest: '1.0.5' }), '1.0.4', false)).toBe(true)
  })

  it('规则 6：本次启动已点「稍后」→ 不弹', () => {
    expect(shouldShowUpdateDialog(makeInfo(), null, true)).toBe(false)
  })

  it('规则 7：其余情况（有更新 + 没跳过 + 没稍后）→ 弹', () => {
    expect(shouldShowUpdateDialog(makeInfo(), null, false)).toBe(true)
    expect(shouldShowUpdateDialog(makeInfo(), '1.0.0', false)).toBe(true)
  })
})

describe('localStorage 不可用 / 抛异常时不崩', () => {
  it('getItem / setItem 都同步抛（隐私模式、配额满）→ 读返回 null、动作不抛', async () => {
    const throwing = {
      getItem(): string | null {
        throw new Error('SecurityError: localStorage is disabled')
      },
      setItem(): void {
        throw new Error('QuotaExceededError')
      },
      removeItem(): void {},
      clear(): void {},
      key(): string | null {
        return null
      },
      length: 0
    } as unknown as Storage
    installStorage(throwing)

    expect(() => getSkippedVersion()).not.toThrow()
    expect(getSkippedVersion()).toBeNull()

    // 让 state 里真的有一份"有新版本"的结论，再走 skip（它内部会 setItem）
    Object.defineProperty(globalThis, 'modvault', {
      value: { checkUpdate: async () => makeInfo() },
      configurable: true,
      writable: true
    })
    await checkForUpdate()
    expect(() => skipUpdateVersion()).not.toThrow()
    expect(() => dismissUpdateDialog()).not.toThrow()
    // 写失败不改变读取行为：依然读不回来（内存镜像保证弹窗仍然关掉，见 updateState 注释）
    expect(getSkippedVersion()).toBeNull()
  })

  it('完全没有 localStorage（老 Electron / 非浏览器环境）→ 读 null，不崩', () => {
    installStorage(null)
    expect(getSkippedVersion()).toBeNull()
    expect(() => skipUpdateVersion()).not.toThrow()
  })

  it('存储里是空白串 → 当成"没跳过"，不是"跳过一个空版本"', () => {
    const storage = memoryStorage()
    storage.setItem(SKIPPED_VERSION_KEY, '   ')
    installStorage(storage)
    expect(getSkippedVersion()).toBeNull()
  })
})

describe('「跳过这个版本」的持久化', () => {
  it('把 latest 原样写进 idbox.update.skippedVersion，且同一版本从此不再弹', async () => {
    const storage = memoryStorage()
    installStorage(storage)
    Object.defineProperty(globalThis, 'modvault', {
      value: { checkUpdate: async () => makeInfo({ latest: '1.0.4' }) },
      configurable: true,
      writable: true
    })
    await checkForUpdate()

    skipUpdateVersion()

    expect(storage.getItem(SKIPPED_VERSION_KEY)).toBe('1.0.4')
    expect(getSkippedVersion()).toBe('1.0.4')
    // 判定层验证：同一版本不再弹；下一个版本照常弹
    expect(shouldShowUpdateDialog(makeInfo({ latest: '1.0.4' }), getSkippedVersion(), false)).toBe(
      false
    )
    expect(shouldShowUpdateDialog(makeInfo({ latest: '1.0.5' }), getSkippedVersion(), false)).toBe(
      true
    )
  })
})

describe('源码守卫：弹窗接线与可访问性', () => {
  const dialog = read('renderer/components/UpdateNotesDialog.tsx')
  const app = read('renderer/App.tsx')

  it('弹窗有 role/aria-label 关系（读屏能念出"发现新版本 + 版本号"）', () => {
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toMatch(/aria-labelledby="update-notes-title"/)
    expect(dialog).toMatch(/id="update-notes-title"/)
  })

  it('Esc 走层栈（useEscLayer），不自己手写 keydown', () => {
    expect(dialog).toContain('useEscLayer(dismissUpdateDialog, true)')
    expect(dialog).toContain('zClassForDepth(escDepth)')
    expect(dialog).not.toMatch(/addEventListener\(\s*'keydown'/)
  })

  it('三个按钮齐全，且「稍后」是初始焦点（不让回车顺手下载）', () => {
    expect(dialog).toContain('稍后')
    expect(dialog).toContain('跳过这个版本')
    expect(dialog).toContain('前往下载')
    expect(dialog).toMatch(/laterButtonRef\.current\?\.focus\(\)/)
    // 下载按钮必须有兜底：没有 assetUrl 就用 Release 页面，两者都没有就不渲染
    expect(dialog).toContain('info.assetUrl || info.url')
  })

  it('正文可滚动且有高度上限（不撑破窗口）', () => {
    expect(dialog).toContain('max-h-[min(52vh,420px)]')
    expect(dialog).toContain('overflow-y-auto')
  })

  it('没有更新说明时给一行中文兜底，而不是空白', () => {
    expect(dialog).toContain('这个版本没有写更新说明')
  })

  it('App 里懒加载 + 由 useUpdateDialogOpen() 决定是否挂载，且只挂一处', () => {
    expect(app).toContain('UpdateNotesDialogLazy')
    expect(app).toMatch(/import\('\.\/components\/UpdateNotesDialog'\)/)
    expect(app).toContain('useUpdateDialogOpen')
    // 只允许出现两次：懒加载定义（1）+ JSX 挂载（1）。多一处就是"挂了两个实例"
    expect(app.match(/UpdateNotesDialogLazy/g) ?? []).toHaveLength(2)
  })

  it('主进程侧真的解析了 body，且长度上限是对外可测的常量', () => {
    const main = read('main/updateCheck.ts')
    expect(main).toContain('MAX_NOTES_CHARS')
    expect(main).toContain('normalizeReleaseNotes')
    expect(main).toContain('release.body')
    expect(main).toContain('notes: null')
  })
})
