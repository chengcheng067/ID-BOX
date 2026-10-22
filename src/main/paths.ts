import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'

/**
 * 默认库目录（大文件放 E 盘；设置里可改）。
 *
 * ⚠️ 值保持 `E:\ModVault\Library` **不是漏改品牌名**：v0.1.0 用户的真实库就在
 * 这个路径下（其 settings.json 的 libraryDir 也指向它）。展示名已更名 ID BOX，
 * 但磁盘路径改不得——改了等于把现有用户的库"弄丢"。settings 迁移见 settings.ts。
 */
export const DEFAULT_LIBRARY_DIR = 'E:\\ModVault\\Library'

/** 缓存与配置根目录（Electron userData：%APPDATA%/idbox；旧版在 %APPDATA%/modvault，启动时自动迁移） */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** 缩略图缓存目录（P0-9：<userData>/thumbs，即 %APPDATA%/idbox/thumbs） */
export function thumbsDir(): string {
  return path.join(userDataDir(), 'thumbs')
}

/** 7-Zip 常见安装位置（rar/7z 格式靠它；zip 有纯 JS 兜底） */
const SEVEN_ZIP_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'D:\\Program Files\\7-Zip\\7z.exe',
  'D:\\Program Files (x86)\\7-Zip\\7z.exe',
  'D:\\APP\\7-Zip\\7z.exe',
  'D:\\app\\7-Zip\\7z.exe',
  'E:\\APP\\7-Zip\\7z.exe',
  'E:\\app\\7-Zip\\7z.exe'
]

import { SEVEN_ZIP_DOWNLOAD_URL } from '../shared/types'

export { SEVEN_ZIP_DOWNLOAD_URL }

/**
 * 探测 7z.exe：环境变量（`IDBOX_7Z` 新名优先，`MODVAULT_7Z` 旧名兼容）>
 * %LOCALAPPDATA% > 常见路径 > PATH。
 *
 * `MODVAULT_7Z` 是 v0.1.0 沿用的环境变量名（CI 脚本 / 团队验证流程都在用），
 * 更名后必须继续认，否则老用户的 7z 探测会静默失效。
 */
export function findSevenZip(): string | null {
  const env = process.env['IDBOX_7Z'] ?? process.env['MODVAULT_7Z']
  if (env && existsSync(env)) return env
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData) {
    const candidate = path.join(localAppData, '7-Zip', '7z.exe')
    if (existsSync(candidate)) return candidate
  }
  for (const c of SEVEN_ZIP_CANDIDATES) {
    if (existsSync(c)) return c
  }
  try {
    const out = execFileSync('where', ['7z'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    /* 不在 PATH */
  }
  return null
}
