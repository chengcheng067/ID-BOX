/**
 * 更新检查的**渲染层状态**（2026-10，关于页「自动检查更新」）。
 *
 * 为什么不放进 `src/renderer/store.ts`：
 * 那个文件是全局 store 的单点，多人并发改动时冲突面极大；更新检查只是**一个只读结论
 * + 一个进行中标志**，没有任何跨模块联动。这里用最小实现（模块级 state +
 * `useSyncExternalStore`）达到同样的响应式效果，零新增依赖、零对 store 的侵入。
 *
 * 设计要点：
 * 1. **自动检查静默失败**：不弹 notice、不写 warn 级日志（最多 console.debug），
 *    绝不让网络问题变成用户的启动噪音。
 * 2. **手动检查失败要可见**：不弹 toast（打扰），由关于页在按钮旁显示一行
 *    「检查失败，可稍后重试」——UI 直接读 `error` 字段，本模块不做额外通知。
 * 3. **幂等**：`startAutoCheck()` 整个进程只生效一次（重复调用直接返回），
 *    避免模块被多次 import / 组件重挂载时重复打 GitHub（未认证 60 次/小时）。
 * 4. 桥接层（`window.modvault`）缺失时**安静降级**：老 preload / 非 Electron 环境下
 *    渲染层不应该崩，只是「没有更新信息」。
 * 5. **「发现新版本」弹窗也挂在这里**（2026-11，文件末尾）：它只是"同一份结论 + 两条
 *    用户选择"的派生物，放进 store 会把冲突面和生命周期一起放大。判定抽成纯函数
 *    `shouldShowUpdateDialog()`，7 条规则逐条可单测。
 */
import { useSyncExternalStore } from 'react'
import type { UpdateInfo } from '../../shared/types'

/** 渲染层只依赖这三个桥接方法（全部可选，方便老版本 preload 降级） */
interface UpdateBridge {
  checkUpdate?: (force?: boolean) => Promise<UpdateInfo>
  getSettings?: () => Promise<{ autoCheckUpdate?: boolean }>
}

/** `checkForUpdate` 的选项 */
export interface CheckForUpdateOptions {
  /** true = 绕过主进程 10 分钟缓存（「立即检查」按钮） */
  force?: boolean
  /**
   * true = 启动自动检查：失败完全静默（只落 debug 日志）。
   * 手动检查（silent=false）失败时同样不弹窗，由 UI 的 `error` 分支告知用户。
   */
  silent?: boolean
}

// ── 模块级状态（唯一数据源） ────────────────────────────────────────────
let state: UpdateInfo | null = null
let checking = false
const listeners = new Set<() => void>()

function emit(): void {
  // 复制一份再遍历：监听器里退订（组件卸载）不会打乱本次通知
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 读桥接层（防御 `window` 不存在 / 非 Electron 环境） */
function bridge(): UpdateBridge | null {
  if (typeof globalThis === 'undefined') return null
  const raw = (globalThis as { modvault?: unknown }).modvault
  if (raw === null || typeof raw !== 'object') return null
  return raw as UpdateBridge
}

/** 订阅更新结论。返回 `null` = 本次进程内还没检查过（UI 显示空状态） */
export function useUpdateState(): UpdateInfo | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    // SSR 快照：本项目是纯客户端渲染，给同一个值即可（保持签名完整）
    () => state
  )
}

/** 订阅「检查中」标志（按钮转圈 / 禁用 + 状态行「正在检查…」） */
export function useUpdateChecking(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => checking,
    () => checking
  )
}

/**
 * 发起一次检查。
 *
 * **永不 reject**：IPC 侧已约定不抛错，这里再兜一层（preload 缺失 / 通道被移除 /
 * 主进程异常），异常一律折成 `error:'network'` 的结论，调用方不需要 try/catch。
 *
 * 并发保护：已在检查中时直接返回（不排队）——两次点击合并成一次请求即可。
 */
export async function checkForUpdate(opts: CheckForUpdateOptions = {}): Promise<void> {
  const { force = false, silent = false } = opts
  if (checking) return
  const api = bridge()
  if (!api || typeof api.checkUpdate !== 'function') return

  checking = true
  emit()
  try {
    const info = await api.checkUpdate(force)
    // 防御：理论上主进程一定返回完整对象；若拿到脏值就当成失败，避免 UI 读到半个对象
    state =
      info !== null && typeof info === 'object' && typeof info.hasUpdate === 'boolean'
        ? info
        : {
            current: '',
            latest: null,
            hasUpdate: false,
            url: null,
            assetUrl: null,
            publishedAt: null,
            notes: null,
            checkedAt: Date.now(),
            error: 'parse'
          }
  } catch (err) {
    state = {
      current: '',
      latest: null,
      hasUpdate: false,
      url: null,
      assetUrl: null,
      publishedAt: null,
      notes: null,
      checkedAt: Date.now(),
      error: 'network'
    }
    // 自动检查不制造日志噪音：debug 级（默认不落盘，见 verboseLogging）
    console.debug('[idbox] 检查更新失败（已按无更新处理）：', err)
  } finally {
    checking = false
    emit()
  }
  // 手动路径的"告知用户"由关于页读 state.error 渲染一行小字完成（不打扰，不弹窗）
  if (state?.error && !silent) {
    console.debug('[idbox] 手动检查更新失败：', state.error)
  }
}

/** `startAutoCheck` 是否已经跑过（幂等的唯一开关） */
let autoCheckStarted = false

/**
 * 启动时自动检查更新（**幂等**，整个进程只发起一次）。
 *
 * 调用点：`SettingsDialog.tsx` 的模块级（该组件被 App.tsx 静态 import，
 * 因此模块求值时机 = 渲染进程启动）。不放进 App.tsx 是为了避开并发改动面。
 *
 * 关掉「启动时自动检查更新」后**一个请求都不发**：先读设置再决定，避免
 * "先请求再取消"式的无意义流量。读设置失败按默认开处理（与 DEFAULT_SETTINGS 一致）。
 */
export function startAutoCheck(): void {
  if (autoCheckStarted) return
  autoCheckStarted = true

  const api = bridge()
  if (!api || typeof api.checkUpdate !== 'function') return

  void (async () => {
    let enabled = true
    try {
      const settings = await api.getSettings?.()
      if (settings !== null && typeof settings === 'object' && settings.autoCheckUpdate === false) {
        enabled = false
      }
    } catch {
      // 读设置失败不阻断：按默认（开）继续，检查本身是只读且静默的
      enabled = true
    }
    if (!enabled) return
    await checkForUpdate({ silent: true })
  })()
}

// ── 「发现新版本」弹窗（2026-11） ───────────────────────────────────────────
//
// 用户需求原话：「idbox 现在不是有检测新版本的能力嘛，它能自己去 GitHub 的 releases note
// 上把更新内容扒下来，然后在我们的软件里弹窗给用户显示更新内容」。
//
// 已拍板的交互（按版本记，不按次数记）：
// - **启动时弹**（自动检查完成、且真有更新时），不做"每天最多一次"之类的限频；
// - 点「稍后」→ **本次启动**不再弹（`dialogDismissedThisSession`，进程内变量，重启即忘）；
// - 点「跳过这个版本」→ 该版本**永不再弹**（写 localStorage，直到出现更高的版本号）。
//
// 为什么判定逻辑要抽成纯函数 `shouldShowUpdateDialog`：这 7 条规则是产品契约，
// 每条都能单独被单测钉住；散在 JSX 里就只能靠人肉 review。

/**
 * 「跳过这个版本」持久化的 localStorage 键。**只存版本号字符串**（如 `0.6.9`），
 * 不是 JSON —— 越简单的形状越不会在升级后读坏。
 */
export const SKIPPED_VERSION_KEY = 'idbox.update.skippedVersion'

/**
 * 取 localStorage（每次现取，不缓存）。
 *
 * 之所以 `try` 包住连**取属性**这一步：某些环境（隐私模式 / 第三方 cookie 被禁 /
 * 配额满）访问 `localStorage` 本身就会同步抛 `SecurityError`，不是只有读写才抛。
 */
function safeStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage
    if (!ls || typeof ls.getItem !== 'function') return null
    return ls
  } catch {
    return null
  }
}

/**
 * 读「已跳过的版本」。
 *
 * 每次调用都真读存储（不做模块级缓存）：
 * - 存储只有一次 hash 查找，代价可以忽略；
 * - 缓存一旦存在，"点了跳过但没生效"这类 bug 就只能靠重启复现，排查成本高得多。
 *
 * **永不抛错**：存储不可用 / 读失败 / 值不是字符串 → 一律 `null`（= 没跳过任何版本）。
 */
export function getSkippedVersion(): string | null {
  const ls = safeStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(SKIPPED_VERSION_KEY)
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

/** 写「已跳过的版本」（失败静默：写不进去也要让弹窗关掉，见 `skippedThisSession`） */
function persistSkippedVersion(version: string): void {
  const ls = safeStorage()
  if (!ls) return
  try {
    ls.setItem(SKIPPED_VERSION_KEY, version)
  } catch (err) {
    // 配额满 / 隐私模式：不阻断交互（内存镜像仍然生效），只留一条 debug
    console.debug('[idbox] 记录「跳过该版本」失败：', err)
  }
}

/**
 * 本次进程内跳过的版本（**内存镜像**）。
 *
 * 存在的唯一理由：localStorage 写失败时，判定仍然要能得出"不弹了"——否则用户点了
 * 「跳过这个版本」看起来毫无反应（弹窗不关），是最典型的"点了没反应"缺陷。
 */
let skippedThisSession: string | null = null

/** 本次启动是否已点过「稍后」（进程内变量：重启自然复位，正是需求要的"本次启动不再弹"） */
let dialogDismissedThisSession = false

/** 有效跳过版本 = 持久化的优先，退而取本次进程内的镜像 */
function effectiveSkippedVersion(): string | null {
  return getSkippedVersion() ?? skippedThisSession
}

/**
 * 弹窗该不该出现的**唯一判定**（纯函数，7 条规则按序短路）。
 *
 * | 顺序 | 条件 | 结论 | 理由 |
 * |---|---|---|---|
 * | 1 | `info === null` | 不弹 | 还没检查过（启动那一瞬间/桥缺失） |
 * | 2 | `info.error !== null` | 不弹 | 检查失败不是"有更新"，不打扰用户 |
 * | 3 | `!info.hasUpdate` | 不弹 | 已是最新 / 预发布被当成无更新 |
 * | 4 | `info.latest === null` | 不弹 | 成功必有 tag；拿到 null 说明数据不完整 |
 * | 5 | `info.latest === skippedVersion` | 不弹 | 用户点过「跳过这个版本」 |
 * | 6 | `dismissedThisSession` | 不弹 | 本次启动已点「稍后」 |
 * | 7 | 其余 | **弹** | 有新版本且用户没拒绝过 |
 *
 * @param info 最近一次检查结论（`useUpdateState()` 的值）
 * @param skippedVersion 用户跳过过的版本号（`getSkippedVersion()`）
 * @param dismissedThisSession 本次启动是否已点「稍后」
 */
export function shouldShowUpdateDialog(
  info: UpdateInfo | null,
  skippedVersion: string | null,
  dismissedThisSession: boolean
): boolean {
  if (info === null) return false
  if (info.error !== null) return false
  if (!info.hasUpdate) return false
  if (info.latest === null) return false
  if (info.latest === skippedVersion) return false
  if (dismissedThisSession) return false
  return true
}

/**
 * 订阅「弹窗是否该显示」。
 *
 * 与 `useUpdateState` 共用**同一个订阅源**（`emit()`）—— 于是 `checkForUpdate()` 一落
 * 结论、`emit()` 之后弹窗自然出现，不需要任何"打开弹窗"的命令式调用。
 * 反过来也成立：判定永远不会在 `startAutoCheck()` 刚被调用时就为 true（那时 `state`
 * 还是 null，且判定依赖 `hasUpdate`），所以不会出现"点开软件先看到空弹窗"。
 */
export function useUpdateDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shouldShowUpdateDialog(state, effectiveSkippedVersion(), dialogDismissedThisSession),
    // SSR 快照恒 false：服务端没有 localStorage，也没有"弹窗"这回事
    () => false
  )
}

/**
 * 「稍后」：关闭弹窗，**本次启动**不再弹（重启后同一版本仍会弹一次）。
 *
 * 刻意不写 localStorage —— 这是"稍后"，不是"不要再提醒我"。
 */
export function dismissUpdateDialog(): void {
  if (dialogDismissedThisSession) return
  dialogDismissedThisSession = true
  emit()
}

/**
 * 「跳过这个版本」：写 localStorage + 关弹窗，该版本**永不再弹**（直到下一版）。
 *
 * ⚠️ 这里**不置** `dialogDismissedThisSession`：跳过只针对"这一个版本"，
 * 若用户本次启动内又手动检查出更高版本，弹窗应当照常出现（规则 5 已经保证
 * 当前版本不再弹，无需再加一条会话级封禁）。
 *
 * `latest` 缺失时（理论上不该发生：弹窗只在有 latest 时出现）退化成"本次启动不再弹"，
 * 保证按钮**永远有反馈**。
 */
export function skipUpdateVersion(): void {
  const latest = state?.latest ?? null
  if (!latest) {
    dialogDismissedThisSession = true
    emit()
    return
  }
  skippedThisSession = latest
  persistSkippedVersion(latest)
  emit()
}

/** 仅供测试：复位弹窗相关的进程内状态（localStorage 由测试自己收拾） */
export function resetUpdateDialogStateForTest(): void {
  skippedThisSession = null
  dialogDismissedThisSession = false
  state = null
  checking = false
}

