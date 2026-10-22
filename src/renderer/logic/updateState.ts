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
