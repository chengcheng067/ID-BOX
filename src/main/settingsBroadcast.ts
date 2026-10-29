/**
 * 设置广播（`settings:changed`，DEF-22-1）的**纯逻辑内核**。
 *
 * ## 为什么单独一个文件、不进 `main/index.ts`
 *
 * `main/index.ts` 顶层就有 `app.requestSingleInstanceLock()` / `app.whenReady()` /
 * 建窗口这些副作用 —— 单测里 `import` 它必然崩，而为了断言"取消时不广播"去 mock
 * 整个 electron 主进程环境，测到的多半是 mock 的形状而不是真实逻辑。
 *
 * 所以把**遍历窗口 + 逐窗口 try/catch** 抽成零依赖（只认一个最小的窗口契约），
 * `index.ts` 里只剩一层薄封装。这样：
 * ① 单测可以直接喂假窗口数组，验证"发了几次、发给谁、参数是什么"；
 * ② 将来加第三条写入路径，仍然只有 `index.ts` 那一个调用点会漏。
 *
 * 放在 `main/` 而不是 `shared/`：这是主进程独有的写侧逻辑，渲染层不需要。
 * 但它**不 import 任何 electron API** —— 依赖全部从参数注入。
 */

/** 广播需要的最小窗口契约（真实的 `BrowserWindow` 满足它；单测用假对象即可） */
export interface BroadcastTarget {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
}

export interface BroadcastSettingsDeps {
  /** 返回当前所有窗口。真实实现是 `BrowserWindow.getAllWindows()` */
  allWindows: () => readonly BroadcastTarget[]
  /** 通道名。真实实现是 `IPC.settingsChanged` */
  channel: string
  /** 发送失败时的告警出口。真实实现是 `logWarn('settings:broadcast-failed', {...})` */
  onError?: (message: string) => void
}

export interface BroadcastSettingsResult {
  /** 成功发出的窗口数 */
  sent: number
  /** 因窗口/通道已销毁而跳过的窗口数 */
  skipped: number
  /** 发送抛错的窗口数 */
  failed: number
}

/**
 * 「选库目录」这条写盘路径的**纯逻辑内核**（`chooseLibrary` handler 的决策部分）。
 *
 * 抽出来的动机与 `broadcastSettingsToWindows` 一样：`main/index.ts` 不可导入，
 * 而"取消时不广播"是个**运行时行为**，源码守卫证明不了它（只能证明早退语句在前）。
 *
 * 三条口径（顺序不能变）：
 * 1. **取消 / 没选目录 → 什么都不做、不广播**。取消 = 什么都没写；此时发广播会让
 *    渲染层收到一份"没变"的 settings 却以为变更已发生（将来一旦广播带副作用，
 *    就变成幽灵触发）；
 * 2. 只有**写盘成功之后**才广播 —— 写盘 reject 必须冒泡给调用方，绝不吞掉；
 * 3. 广播用的是"合并了 libraryDir 的那一份"，不是合并前的。
 *
 * @returns 合并后的新 settings；取消时返回 null（不写盘、不广播）
 */
export async function applyLibraryChoice(
  current: unknown,
  dir: string | undefined,
  deps: {
    saveSettings: (next: unknown) => Promise<void>
    broadcast: (next: unknown) => void
  }
): Promise<unknown | null> {
  if (typeof dir !== 'string' || dir.length === 0) return null
  const next = { ...(current as Record<string, unknown>), libraryDir: dir }
  await deps.saveSettings(next)
  deps.broadcast(next)
  return next
}

/**
 * 把 settings 推给**所有**窗口。
 *
 * 三条硬约束：
 * 1. **遍历全部窗口**而不是只发主窗口：漏发只表现成"某个窗口主题/库路径不跟着变"，
 *    是最难在测试里发现的一类 bug；
 * 2. **已销毁跳过**（窗口 `isDestroyed()` 或 `webContents.isDestroyed()`）：
 *    销毁中的窗口 `send` 会抛，而这个函数被 IPC handler 直接调用 ——
 *    抛出去会让 `settings:set` / `chooseLibrary` 变成 reject，用户看到"保存失败"
 *    但其实已经落盘了；
 * 3. **逐窗口 try/catch 互不影响**：一个窗口炸掉，其余窗口必须照常收到。
 *
 * @returns 发出/跳过/失败三个计数（排障与单测断言用，不抛错）
 */
export function broadcastSettingsToWindows(
  next: unknown,
  deps: BroadcastSettingsDeps
): BroadcastSettingsResult {
  const result: BroadcastSettingsResult = { sent: 0, skipped: 0, failed: 0 }
  // deps.allWindows 自身抛错也不能冒泡：广播是**尽力而为**的副作用，
  // 绝不能让"设置已经写盘了"的调用方因为拿窗口失败而报错。
  let windows: readonly BroadcastTarget[]
  try {
    windows = deps.allWindows()
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : String(err))
    return result
  }

  for (const target of windows) {
    const dead = (() => {
      try {
        return target.isDestroyed() || target.webContents.isDestroyed()
      } catch {
        // 连 isDestroyed 都抛 = 这个窗口已经不是可用对象，按跳过处理
        return true
      }
    })()
    if (dead) {
      result.skipped += 1
      continue
    }
    try {
      target.webContents.send(deps.channel, next)
      result.sent += 1
    } catch (err) {
      result.failed += 1
      deps.onError?.(err instanceof Error ? err.message : String(err))
    }
  }
  return result
}
