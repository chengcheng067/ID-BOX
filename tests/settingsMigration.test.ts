/**
 * 品牌更名设置迁移（modvault → idbox）单测（2026-10 装机反馈 P0）。
 *
 * 覆盖团队要求的三条语义：新目录无设置 + 旧目录有 → 迁过来；新目录已有 →
 * 不覆盖；旧目录没有 → 正常走默认值（plan 判定 + 真实 IO 两层）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LEGACY_APP_DIR_NAME,
  legacySettingsFilePath,
  migrateLegacySettingsFile,
  planSettingsMigration
} from '../src/main/settings'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-setmig-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('planSettingsMigration（纯函数，存在性注入）', () => {
  const NEW = 'C:\\Users\\u\\AppData\\Roaming\\idbox\\settings.json'
  const OLD = 'C:\\Users\\u\\AppData\\Roaming\\modvault\\settings.json'
  const bothExist = () => true
  const noneExist = () => false

  it('新目录没有 + 旧目录有 → copy（老用户的库路径就这么救回来）', () => {
    expect(planSettingsMigration(NEW, OLD, (p) => p === OLD)).toEqual({
      action: 'copy',
      from: OLD,
      to: NEW
    })
  })

  it('新目录已有 → skip-new-exists（不覆盖，以新目录为准）', () => {
    expect(planSettingsMigration(NEW, OLD, bothExist).action).toBe('skip-new-exists')
  })

  it('旧目录没有 → skip-no-legacy（全新用户走默认值）', () => {
    expect(planSettingsMigration(NEW, OLD, noneExist).action).toBe('skip-no-legacy')
  })

  it('两个路径相同 → skip-same-path（防御：同目录重复调用）', () => {
    expect(planSettingsMigration(NEW, NEW, noneExist).action).toBe('skip-same-path')
  })

  it('空路径防御 → skip-same-path', () => {
    expect(planSettingsMigration('', OLD, bothExist).action).toBe('skip-same-path')
    expect(planSettingsMigration(NEW, '', bothExist).action).toBe('skip-same-path')
  })
})

describe('legacySettingsFilePath', () => {
  it('旧设置位于 userData 父目录下的 modvault/', () => {
    expect(legacySettingsFilePath('C:\\Users\\u\\AppData\\Roaming\\idbox')).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', LEGACY_APP_DIR_NAME, 'settings.json')
    )
  })
})

describe('migrateLegacySettingsFile（真实 IO）', () => {
  it('新目录无设置 + 旧目录有 → 复制过来且原文件保留', async () => {
    const root = await tmpDir()
    const legacyDir = path.join(root, LEGACY_APP_DIR_NAME)
    const newDir = path.join(root, 'idbox')
    await fs.mkdir(legacyDir, { recursive: true })
    const legacySettings = { libraryDir: 'E:\\ModVault\\Library', archiveDisposal: 'recycle' }
    await fs.writeFile(
      path.join(legacyDir, 'settings.json'),
      JSON.stringify(legacySettings),
      'utf-8'
    )

    const plan = await migrateLegacySettingsFile(newDir)
    expect(plan.action).toBe('copy')

    // 新目录读到了内容
    const copied = JSON.parse(await fs.readFile(path.join(newDir, 'settings.json'), 'utf-8'))
    expect(copied).toEqual(legacySettings)
    // 原文件**保留不动**（复制不是移动——用户回滚 v0.1.0 数据还在）
    await expect(fs.stat(path.join(legacyDir, 'settings.json'))).resolves.toBeTruthy()
  })

  it('新目录已有设置 → 不覆盖', async () => {
    const root = await tmpDir()
    const legacyDir = path.join(root, LEGACY_APP_DIR_NAME)
    const newDir = path.join(root, 'idbox')
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.mkdir(newDir, { recursive: true })
    await fs.writeFile(path.join(legacyDir, 'settings.json'), '{"libraryDir":"OLD"}', 'utf-8')
    await fs.writeFile(path.join(newDir, 'settings.json'), '{"libraryDir":"NEW"}', 'utf-8')

    const plan = await migrateLegacySettingsFile(newDir)
    expect(plan.action).toBe('skip-new-exists')
    expect(await fs.readFile(path.join(newDir, 'settings.json'), 'utf-8')).toBe('{"libraryDir":"NEW"}')
  })

  it('旧目录没有设置 → 不创建新目录、不动磁盘', async () => {
    const root = await tmpDir()
    const newDir = path.join(root, 'idbox')
    const plan = await migrateLegacySettingsFile(newDir)
    expect(plan.action).toBe('skip-no-legacy')
    await expect(fs.stat(newDir)).rejects.toThrow() // 没有凭空 mkdir
  })
})
