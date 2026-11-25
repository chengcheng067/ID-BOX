/**
 * 钉选目录内「在资源管理器中揭示某一项」的实现体（`fs:revealEntry`）。
 *
 * 用户缺陷原话（2026-11-25）：「右键选择『在资源管理器显示』时，弹开的并不是现在我
 * 右键点击的这个文件所在的文件夹。」—— 渲染层原先复用 `home:pinnedOpen`，那条通道
 * 的语义是「打开钉选根」，**没有子路径**；`shell:reveal` 又被 0.9.2 守卫限制在
 * 「库根 ∪ 日志目录」，钉选路径会被拒。因此单开一条通道，把**已通过前缀校验的
 * 绝对路径**交给系统资源管理器。
 *
 * 分工（与 `fs:entryThumb` 同一范式：handler 只做 pinId 解析 + 日志收口）：
 * - 路径解析与越界守卫收口在 handler（`resolvePinnedRootById` + `pinnedDirGuard.resolveWithinPinRoot`）；
 * - 本模块只负责「这个绝对路径现在还在不在 + 交给 shell」，**不拼路径、不信 any relPath**。
 *
 * 为什么文件 / 目录都走 `shell.showItemInFolder`：
 * - 文件 → 打开父目录并选中该文件（用户的原始诉求）；
 * - 目录 → Windows 会在**父目录**里选中该目录 —— 这正是用户右键一个文件夹时的直觉
 *   （进入它 vs 定位它，右键菜单的语义是「定位」）。
 *
 * 失败一律 `{ok:false, reason, error:中文单行}`，**永不抛错**（契约见 `shared/ipc.ts`）。
 */
import { statSync } from 'node:fs'
import { shell } from 'electron'

import type { FsRevealEntryResult } from '../shared/ipc'

/**
 * 在资源管理器里揭示一个**已过守卫**的绝对路径。
 *
 * @param absPath 已由 `resolveWithinPinRoot` 校验过的钉选根内绝对路径
 * @returns `{ok:true}` = 已交给 shell；`{ok:false, reason:'io'}` = 条目已消失 / 系统拒绝
 */
export function revealEntryInExplorer(absPath: string): FsRevealEntryResult {
  try {
    statSync(absPath)
  } catch {
    // 竞态：右键那一刻还在、点菜单时已被删除 / 改名 / 移走
    return { ok: false, reason: 'io', error: '这个文件已经不在了' }
  }
  try {
    shell.showItemInFolder(absPath)
  } catch {
    return { ok: false, reason: 'io', error: '无法在资源管理器中显示这个条目' }
  }
  return { ok: true }
}
