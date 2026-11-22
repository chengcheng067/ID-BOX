/**
 * SketchUp 插件安装扫描（2026-11-23 用户拍板修复）—— **IO 层**。
 *
 * ## 为什么扫盘而不是读 manifest
 *
 * 「已安装」的旧判据是 `%APPDATA%\idbox\plugin\manifest.json` 存在 —— 那个文件是**本体自己**
 * 写的索引快照（`main/pluginExport.ts`），等于"我写过索引 = 插件装了"，假的。插件真身是
 * SketchUp Plugins 目录里的 `idbox_panel.rb` + `idbox_panel/`，所以只能真去扫。
 *
 * ## 落点（用户本机实测的两套根）
 *
 * - `%APPDATA%\SketchUp\SketchUp <年份>\SketchUp\Plugins\`（按用户安装，最常见）；
 * - `%PROGRAMDATA%\SketchUp\SketchUp <年份>\SketchUp\Plugins\`（装给所有用户时）。
 *
 * 每个 plugins 目录先读 `idbox_panel.rb`（根注册文件，带 `EXT_VERSION`），没有这个文件
 * 再读 `idbox_panel/lib/core.rb`（支持目录里的 `PLUGIN_VERSION`）；两者都没有 → 这个
 * SketchUp 就是没装，不产出 hit。
 *
 * ## 硬约束
 *
 * **永不抛异常**：每一次 readdir / open / read 都 try/catch，ENOENT / EPERM 一律当
 * "没这个目录 / 没这个文件"。扫描失败只是"少几行状态"，绝不能把设置页搞成报错源。
 * 纯读、零网络、不写盘。
 */
import { readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parsePluginVersionLiteral, type InstalledPluginHit } from '../shared/pluginInstall'

/** 根目录名（`%APPDATA%\<这个名字>\`） */
export const SKETCHUP_ROOT_DIR_NAME = 'SketchUp'
/** 年份目录里的子目录名（`SketchUp 2025\SketchUp\Plugins`） */
export const SKETCHUP_APP_DIR_NAME = 'SketchUp'
/** 插件目录名 */
export const SKETCHUP_PLUGINS_DIR_NAME = 'Plugins'
/** 根注册文件名（带 `Registrar::EXT_VERSION`） */
export const PLUGIN_ROOT_FILE_NAME = 'idbox_panel.rb'
/** 支持目录里的版本文件（相对 plugins 目录） */
export const PLUGIN_CORE_FILE_REL = path.join('idbox_panel', 'lib', 'core.rb')
/** 每个候选文件只读前 64KB（解析版本常量够用，别把一个 20MB 的文件读进内存） */
export const PLUGIN_HEAD_BYTES = 64 * 1024

/** 年份目录形态：`SketchUp 2024` / `SketchUp 2025`（大小写宽容，数字必须） */
const VERSION_DIR_RE = /^SketchUp\s+\d+$/i

/** 一个候选 plugins 目录（`sketchup` 是年份目录名，给 UI 直接显示） */
export interface SketchUpPluginsDir {
  sketchup: string
  pluginsDir: string
}

/**
 * 枚举所有候选 `<...>\SketchUp\SketchUp <年份>\SketchUp\Plugins`。
 *
 * `appData` / `programData` 由调用方给（main 侧用 `app.getPath('appData')` 与
 * `process.env.ProgramData`；测试给 tmpdir）。两个都拿不到 → `[]`。
 * 按**绝对路径**去重（两套根偶尔会指向同一处），保持枚举顺序。
 * 永不抛异常。
 */
export function sketchupPluginDirs(deps: {
  appData?: string
  programData?: string
}): SketchUpPluginsDir[] {
  const bases = [deps?.appData, deps?.programData].filter(
    (base): base is string => typeof base === 'string' && base.trim().length > 0
  )
  const result: SketchUpPluginsDir[] = []
  const seen = new Set<string>()
  for (const base of bases) {
    const root = path.join(base, SKETCHUP_ROOT_DIR_NAME)
    let entries: Dirent[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      // 没有这套根（或没权限）：跳过，不当错误
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !VERSION_DIR_RE.test(entry.name)) continue
      const pluginsDir = path.join(
        root,
        entry.name,
        SKETCHUP_APP_DIR_NAME,
        SKETCHUP_PLUGINS_DIR_NAME
      )
      let key = pluginsDir
      try {
        key = path.resolve(pluginsDir).toLowerCase()
      } catch {
        // path.resolve 理论上不抛；真抛了就用原始串去重
      }
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ sketchup: entry.name, pluginsDir })
    }
  }
  return result
}

/** 读文件头（最多 `maxBytes`）；打不开 / 读失败一律 null，永不抛 */
async function readHead(filePath: string, maxBytes: number = PLUGIN_HEAD_BYTES): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.subarray(0, bytesRead).toString('utf-8')
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return null
  }
}

/**
 * 扫出真机上装了哪些 SketchUp 插件、各自什么版本。
 *
 * - 命中按枚举顺序返回（排序 / 四态在 `shared/pluginInstall.ts` 的
 *   `summarizeInstallStatus` 里做，这里不掺展示逻辑）；
 * - 文件在但解析不出版本 → 仍然产出一条 hit，`version: null`；
 * - 两个候选文件都没有 → 跳过该 SketchUp（那是"没装"）；
 * - 永不抛异常（含 deps 缺失）。
 */
export async function scanInstalledPlugins(deps: {
  appData?: string
  programData?: string
}): Promise<InstalledPluginHit[]> {
  const hits: InstalledPluginHit[] = []
  let dirs: SketchUpPluginsDir[] = []
  try {
    dirs = sketchupPluginDirs(deps)
  } catch {
    return hits
  }
  for (const dir of dirs) {
    try {
      const rootText = await readHead(path.join(dir.pluginsDir, PLUGIN_ROOT_FILE_NAME))
      if (rootText !== null) {
        hits.push({ sketchup: dir.sketchup, version: parsePluginVersionLiteral(rootText) })
        continue
      }
      const coreText = await readHead(path.join(dir.pluginsDir, PLUGIN_CORE_FILE_REL))
      if (coreText !== null) {
        hits.push({ sketchup: dir.sketchup, version: parsePluginVersionLiteral(coreText) })
        continue
      }
      // 两个文件都没有：这台 SketchUp 没装 ID BOX 插件，不算命中
    } catch {
      // 单个目录出意外（权限 / 竞态删除）：跳过它，不影响其它年份
      continue
    }
  }
  return hits
}
