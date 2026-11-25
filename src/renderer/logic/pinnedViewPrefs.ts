/**
 * 钉选目录浏览器 · **视图 / 排序偏好的读写桥**（2026-11-25 用户需求①）。
 *
 * 用户原话：「用户一旦选择了图标视图，那么下一次进入这个文件夹时，就需要保持为图标视图。」
 * 因此偏好不再放内存级 Zustand store，而是落进 `Settings.pinnedViewPrefs`
 * （key = `HomePinnedFolder.id`），跨重启保留。
 *
 * 三条纪律（改这里之前先读）：
 * 1. **唯一写入口** = `useVault.getState().saveSettings`（主进程 `normalizeSettings`
 *    会再洗一遍）；不另走 IPC、不直接写文件。
 * 2. **乐观更新**：点击后立刻改 store 里的 `settings.pinnedViewPrefs`，界面不等 IPC
 *    往返；真正的落盘 300ms 防抖（连续切视图 / 排序只写最后一次）。
 * 3. **patch 而不是快照**：待写队列按 pin 存 `Partial<PinnedViewPrefs>`，flush 时才
 *    叠加到**最新** settings 上 —— 期间若有别的设置写入 / 广播回来把表替换掉，
 *    也不会丢掉用户刚点的这一下（避免 "改了没生效"）。
 */
import { useVault } from '../store'
import {
  DEFAULT_PINNED_VIEW_PREFS,
  normalizePinnedViewPrefs,
  normalizePinnedViewPrefsMap,
  type PinnedViewPrefs,
  type PinnedViewPrefsMap
} from '../../shared/pinnedViewPrefs'

/** 落盘防抖（ms）：用户连续切换时只写最后一次；单个点击 300ms 后必然落盘 */
export const PINNED_PREFS_WRITE_DEBOUNCE_MS = 300

/** 待落盘的 patch（pinId → 局部字段），flush 时按顺序叠加到最新 settings 上 */
const pendingPatches = new Map<string, Partial<PinnedViewPrefs>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 把待写 patch 叠加到一份基准表上（返回新对象，不修改入参） */
function applyPending(base: PinnedViewPrefsMap): PinnedViewPrefsMap {
  const next: PinnedViewPrefsMap = { ...base }
  pendingPatches.forEach((patch, pinId) => {
    next[pinId] = normalizePinnedViewPrefs({
      ...(next[pinId] ?? DEFAULT_PINNED_VIEW_PREFS),
      ...patch
    })
  })
  return normalizePinnedViewPrefsMap(next)
}

/** 两张偏好表是否逐条相同（用于广播守卫，避免 setState 自激循环） */
function samePrefsMap(a: PinnedViewPrefsMap, b: PinnedViewPrefsMap): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const x = a[key]
    const y = b[key]
    return (
      y !== undefined && x.view === y.view && x.sortKey === y.sortKey && x.sortDir === y.sortDir
    )
  })
}

let broadcastGuardInstalled = false

/**
 * 广播守卫：防抖窗口里若有**别的设置**落盘（`settings:changed` 广播把整份 settings
 * 换掉，其中 `pinnedViewPrefs` 还是旧值），把待写的乐观值贴回去 —— 否则用户会看到
 * 视图闪一下列表再跳回图标。`samePrefsMap` 比较保证不会自激（自己的 setState 不重贴）。
 */
function ensureBroadcastGuard(): void {
  if (broadcastGuardInstalled) return
  broadcastGuardInstalled = true
  useVault.subscribe((state, prev) => {
    if (pendingPatches.size === 0) return
    if (state.settings === null || state.settings === prev.settings) return
    const current = state.settings.pinnedViewPrefs ?? {}
    const desired = applyPending(current)
    if (!samePrefsMap(current, desired)) {
      useVault.setState({ settings: { ...state.settings, pinnedViewPrefs: desired } })
    }
  })
}

/**
 * 立即把待写 patch 落盘（也用于组件卸载 / 关闭浏览器前强制 flush，
 * 保证「点完图标视图马上按 Esc 回首页」也不会丢）。
 */
export function flushPinnedViewPrefs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingPatches.size === 0) return
  const state = useVault.getState()
  const settings = state.settings
  const nextMap = applyPending(settings?.pinnedViewPrefs ?? {})
  pendingPatches.clear()
  if (settings !== null) {
    useVault.setState({ settings: { ...settings, pinnedViewPrefs: nextMap } })
  }
  // 失败静默：与其它设置写入同口径（不是关键数据，不弹错）
  void state.saveSettings({ pinnedViewPrefs: nextMap }).catch(() => undefined)
}

/**
 * 记忆一个 pin 的视图 / 排序（组件里切视图、切排序、点列头都走这里）。
 * patch 合并语义与既有的 `patchPrefs` 一致：只传要改的字段。
 */
export function patchPinnedViewPrefs(pinId: string, patch: Partial<PinnedViewPrefs>): void {
  if (!pinId) return
  ensureBroadcastGuard()
  pendingPatches.set(pinId, { ...(pendingPatches.get(pinId) ?? {}), ...patch })
  // 乐观更新：立刻反映到 store（点击即生效，不等 IPC）。用函数式 setState，
  // 拿到的永远是最新 settings —— 不用 patch 起手时读的旧快照，免得覆盖同时到达的其它字段。
  useVault.setState((state) => {
    if (state.settings === null) return {}
    return {
      settings: {
        ...state.settings,
        pinnedViewPrefs: applyPending(state.settings.pinnedViewPrefs ?? {})
      }
    }
  })
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushPinnedViewPrefs, PINNED_PREFS_WRITE_DEBOUNCE_MS)
}
