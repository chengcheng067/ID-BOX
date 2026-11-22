/**
 * SketchUp 插件联通判定（2026-11-22 用户需求「同步插件 · 联通绿点」）——**纯逻辑层**。
 *
 * ## 为什么单独一个文件
 *
 * 判据必须可单测（`tests/pluginLinkStatus.test.ts`），而 `main/index.ts` 是 electron
 * 入口、import 即拉起 app —— 判定函数抽到这里，**零 electron、零 IO**，测试直接
 * 喂字符串。IO（读 `manifest.json`）在 `main/index.ts` 的 handler 里，只有几行。
 *
 * ## 判据（用户口径）
 *
 * `%APPDATA%\idbox\plugin\manifest.json`：
 * 1. 文件**存在**且**JSON 可解析**（顶层必须是对象，`null` / 数组 / 标量都算坏）；
 * 2. 若 manifest 有 enabled 类字段（真实字段表见 `shared/pluginSnapshot.ts` 的
 *    `PluginManifest`，字段名 `pluginIndexEnabled`）——被显式置 `false` 时**不联通**
 *    （导出开关关着，插件侧只会显示「未开导出」，亮绿点是骗人）；
 * 3. 其余一切成立 ⇒ `connected: true`，`generatedAt` 取信封级字段（非字符串 → null）。
 *
 * 任何一步不满足都收敛为 `{ connected: false, generatedAt: null }`，**永不抛异常** ——
 * 绿点只是状态提示，读不到文件不能变成界面的报错源。
 *
 * ⚠️ 2026-11-23 修复：本判据 **只是"本体写过索引快照"**，`manifest.json` 是 ID BOX 自己
 * 写的（`main/pluginExport.ts`），插件装没装它都会在。**不要**再拿 `connected` 当"插件已安装"
 * 用（1.0.x 的 bug 就在这：没装也显示已安装、按钮还变灰，用户无法升级）。
 * 安装态一律看 `PluginLinkStatus.install`（真扫 SketchUp Plugins 目录，见 `pluginScan.ts`）。
 */
import type { PluginLinkStatus } from '../shared/ipc'

/** 统一的「不联通」答案形状（与 `PluginLinkStatus` 的失败形态逐字一致） */
function notConnected(): PluginLinkStatus {
  return { connected: false, generatedAt: null }
}

/**
 * 从 manifest.json 的**原文**解析联通状态。
 *
 * @param raw 文件内容（调用方读盘；读不到传 null / 空串都行）
 * @returns `PluginLinkStatus`，永不抛异常；每次返回**全新对象**（调用方改写不串味）
 */
export function parsePluginLinkStatus(raw: string | null | undefined): PluginLinkStatus {
  if (typeof raw !== 'string' || raw.length === 0) return notConnected()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 半写 / 截断的 manifest：当没连上（下一轮快照落盘后自愈）
    return notConnected()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return notConnected()
  }
  const manifest = parsed as Record<string, unknown>
  // enabled 类字段：显式 false 才判负（缺失 / 非布尔不扣分 —— 旧快照可能没有该字段）
  if (manifest.pluginIndexEnabled === false) return notConnected()
  const generatedAt =
    typeof manifest.generatedAt === 'string' && manifest.generatedAt.length > 0
      ? manifest.generatedAt
      : null
  return { connected: true, generatedAt }
}
