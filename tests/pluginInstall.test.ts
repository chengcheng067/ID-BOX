/**
 * SketchUp 插件安装判定单测（2026-11-23 用户拍板修复）。
 *
 * 两层：
 * 1. 纯函数（`src/shared/pluginInstall.ts`）—— 版本字面量解析 / 版本比较 / 四态 / 汇总；
 * 2. IO 层（`src/main/pluginScan.ts`）—— 在 `os.tmpdir()` 里造假目录结构，验证真扫。
 *
 * 为什么这两条判据必须钉死：1.0.x 用 `%APPDATA%\idbox\plugin\manifest.json`（本体自己写的
 * 索引快照）当"插件已安装"，插件没装也显示已安装、按钮还变灰，用户无法升级。本轮的判据
 * 是**真机 Plugins 目录里的文件**，一个字符都不许退回自证。
 */
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PLUGIN_VERSION_LITERAL_LIMIT,
  compareVersions,
  decidePluginInstallState,
  decideSummaryState,
  parsePluginVersionLiteral,
  summarizeInstallStatus
} from '../src/shared/pluginInstall'
import type { InstalledPluginHit } from '../src/shared/pluginInstall'
import { scanInstalledPlugins, sketchupPluginDirs } from '../src/main/pluginScan'

/** 临时目录清单：每个用例自己建，afterEach 统一清 */
const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-plugin-scan-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** 造一个 SketchUp 插件落点：`<root>/SketchUp/SketchUp <year>/SketchUp/Plugins/...` */
async function writePluginFile(
  root: string,
  year: string,
  rel: string,
  content: string
): Promise<void> {
  const filePath = path.join(root, 'SketchUp', `SketchUp ${year}`, 'SketchUp', 'Plugins', rel)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

describe('parsePluginVersionLiteral · 版本字面量', () => {
  it('单引号 + .freeze（真实写法）', () => {
    expect(parsePluginVersionLiteral("EXT_VERSION = '1.1.0'.freeze\n")).toBe('1.1.0')
  })

  it('双引号', () => {
    expect(parsePluginVersionLiteral('EXT_VERSION = "1.0.5"\n')).toBe('1.0.5')
  })

  it('等号两侧多余空格 / 缩进', () => {
    expect(parsePluginVersionLiteral('    EXT_VERSION    =    \'1.2.3\'   \n')).toBe('1.2.3')
  })

  it('只有 PLUGIN_VERSION 的文件（支持目录 core.rb）', () => {
    expect(parsePluginVersionLiteral("PLUGIN_VERSION = '1.0.5'.freeze\n")).toBe('1.0.5')
  })

  it('EXT_VERSION 优先于 PLUGIN_VERSION', () => {
    const src = "PLUGIN_VERSION = '2.0.0'\nEXT_VERSION = '1.1.0'\n"
    expect(parsePluginVersionLiteral(src)).toBe('1.1.0')
  })

  it('注释行里的假赋值必须被忽略（真实文件注释里就写着「1.1.0 → 1.1.1」）', () => {
    const src = [
      '# EXT_VERSION = 0.0.1',
      '    # PLUGIN_VERSION = 无',
      '    #   ⇒ 按语义化版本升 patch。**与 idbox_panel.rb 的 EXT_VERSION 必须同值**',
      "EXT_VERSION = '1.1.0'.freeze",
      ''
    ].join('\n')
    expect(parsePluginVersionLiteral(src)).toBe('1.1.0')
  })

  it('只有注释、没有真赋值 → null', () => {
    expect(parsePluginVersionLiteral("# EXT_VERSION = '9.9.9'\n")).toBeNull()
  })

  it('都没有 → null', () => {
    expect(parsePluginVersionLiteral('module IDBoxPanel\nend\n')).toBeNull()
  })

  it("非法字面量（'abc' / 空串 / 带 vs 前缀）→ null", () => {
    expect(parsePluginVersionLiteral("EXT_VERSION = 'abc'\n")).toBeNull()
    expect(parsePluginVersionLiteral("EXT_VERSION = ''\n")).toBeNull()
    expect(parsePluginVersionLiteral("EXT_VERSION = 'v1.1.0'\n")).toBeNull()
    expect(parsePluginVersionLiteral("EXT_VERSION = '1.1.0-beta'\n")).toBeNull()
  })

  it('空串 / null / 超长 → null，永不抛', () => {
    expect(parsePluginVersionLiteral('')).toBeNull()
    expect(parsePluginVersionLiteral(null as unknown as string)).toBeNull()
    expect(parsePluginVersionLiteral('x'.repeat(PLUGIN_VERSION_LITERAL_LIMIT + 1))).toBeNull()
  })
})

describe('compareVersions · 逐段比数字', () => {
  it('1.0.5 < 1.1.0', () => {
    expect(compareVersions('1.0.5', '1.1.0')).toBeLessThan(0)
    expect(compareVersions('1.1.0', '1.0.5')).toBeGreaterThan(0)
  })

  it('数值比较而非字典序：1.10.0 > 1.9.9', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('段数不同时缺的当 0：1.1 == 1.1.0', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0)
    expect(compareVersions('1.1.0', '1.1')).toBe(0)
  })

  it('相等返回 0', () => {
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0)
  })

  it('非法段当 0（不制造意外的大小关系）', () => {
    expect(compareVersions('1.x', '1.0')).toBe(0)
  })
})

describe('decidePluginInstallState · 四态', () => {
  it('没装 → missing', () => {
    expect(decidePluginInstallState('1.1.0', null)).toBe('missing')
  })

  it('同版本 → installed', () => {
    expect(decidePluginInstallState('1.1.0', '1.1.0')).toBe('installed')
  })

  it('真机旧 → outdated', () => {
    expect(decidePluginInstallState('1.1.0', '1.0.5')).toBe('outdated')
  })

  it('真机新 → ahead', () => {
    expect(decidePluginInstallState('1.1.0', '1.2.0')).toBe('ahead')
  })
})

describe('decideSummaryState · 按全部命中判整体状态（2026-11-23 回归靶心）', () => {
  it('空数组 → missing', () => {
    expect(decideSummaryState('1.1.0', [])).toBe('missing')
  })

  it('全是 null 版本 → installed（装了但认不出版本，不许误报未安装）', () => {
    expect(decideSummaryState('1.1.0', [{ sketchup: 'SketchUp 2026', version: null }])).toBe(
      'installed'
    )
  })

  it('用户本机实况 [2024:1.0.5, 2025:1.1.0] + shipped 1.1.0 → outdated（任一台旧就算旧）', () => {
    // ⚠️ 这条是回归靶心：只看最高版本会得到 installed ⇒ 「更新到 1.1.0」入口消失，
    // 用户 2024 那份 1.0.5 永远修不掉（这就是用户这一轮报的原始痛点）。
    expect(
      decideSummaryState('1.1.0', [
        { sketchup: 'SketchUp 2025', version: '1.1.0' },
        { sketchup: 'SketchUp 2024', version: '1.0.5' }
      ])
    ).toBe('outdated')
  })

  it('[1.1.0, 1.1.0] → installed（全部同版本）', () => {
    expect(
      decideSummaryState('1.1.0', [
        { sketchup: 'SketchUp 2025', version: '1.1.0' },
        { sketchup: 'SketchUp 2024', version: '1.1.0' }
      ])
    ).toBe('installed')
  })

  it('[1.2.0] → ahead（真机比本体新）', () => {
    expect(decideSummaryState('1.1.0', [{ sketchup: 'SketchUp 2025', version: '1.2.0' }])).toBe(
      'ahead'
    )
  })

  it('[1.1.0, 1.2.0] → installed（有等于有高于，没有旧的）', () => {
    expect(
      decideSummaryState('1.1.0', [
        { sketchup: 'SketchUp 2025', version: '1.2.0' },
        { sketchup: 'SketchUp 2024', version: '1.1.0' }
      ])
    ).toBe('installed')
  })
})

describe('summarizeInstallStatus · 排序 / 取最高 / 四态', () => {
  const hits: InstalledPluginHit[] = [
    { sketchup: 'SketchUp 2024', version: '1.0.5' },
    { sketchup: 'SketchUp 2025', version: '1.1.0' },
    { sketchup: 'SketchUp 2026', version: null }
  ]

  it('版本降序、null 垫底；installedVersion 取最高有效版本；任一台旧 ⇒ outdated', () => {
    const status = summarizeInstallStatus('1.1.0', hits)
    expect(status.hits.map((h) => h.sketchup)).toEqual([
      'SketchUp 2025',
      'SketchUp 2024',
      'SketchUp 2026'
    ])
    expect(status.installedVersion).toBe('1.1.0')
    // 2024 是 1.0.5 < 1.1.0 ⇒ 整体 outdated（"用户本机实况"：必须给更新入口）
    expect(status.state).toBe('outdated')
    expect(status.shippedVersion).toBe('1.1.0')
  })

  it('本体升到 1.2.0 → outdated', () => {
    expect(summarizeInstallStatus('1.2.0', hits).state).toBe('outdated')
  })

  it('只有未知版本命中 → installedVersion:null，state=installed（不误报未安装）', () => {
    const status = summarizeInstallStatus('1.1.0', [{ sketchup: 'SketchUp 2026', version: null }])
    expect(status.installedVersion).toBeNull()
    expect(status.state).toBe('installed')
  })

  it('无命中 → missing，且不改入参数组', () => {
    expect(summarizeInstallStatus('1.1.0', []).state).toBe('missing')
    const input: InstalledPluginHit[] = [
      { sketchup: 'SketchUp 2024', version: '1.0.5' },
      { sketchup: 'SketchUp 2025', version: '1.1.0' }
    ]
    const copy = [...input]
    summarizeInstallStatus('1.1.0', input)
    expect(input).toEqual(copy)
  })
})

describe('scan 目录枚举与真实读盘（os.tmpdir 造假结构）', () => {
  it('枚举 `<appData>/SketchUp/SketchUp <年份>/SketchUp/Plugins`，非年份目录不算', async () => {
    const root = await makeTempRoot()
    await writePluginFile(root, '2024', 'idbox_panel.rb', "EXT_VERSION = '1.0.5'.freeze\n")
    // 干扰项：名字里没有数字
    await fs.mkdir(path.join(root, 'SketchUp', 'SketchUp Backup', 'SketchUp', 'Plugins'), {
      recursive: true
    })
    const dirs = sketchupPluginDirs({ appData: root })
    expect(dirs).toHaveLength(1)
    expect(dirs[0].sketchup).toBe('SketchUp 2024')
    expect(dirs[0].pluginsDir).toBe(
      path.join(root, 'SketchUp', 'SketchUp 2024', 'SketchUp', 'Plugins')
    )
  })

  it('扫到根注册文件并解析出版本（真实用户本机 2024 = 1.0.5 的形态）', async () => {
    const root = await makeTempRoot()
    await writePluginFile(root, '2024', 'idbox_panel.rb', "EXT_VERSION = '1.0.5'.freeze\n")
    await writePluginFile(root, '2025', 'idbox_panel.rb', "EXT_VERSION = '1.1.0'.freeze\n")
    const hits = await scanInstalledPlugins({ appData: root })
    expect(hits).toEqual([
      { sketchup: 'SketchUp 2024', version: '1.0.5' },
      { sketchup: 'SketchUp 2025', version: '1.1.0' }
    ])
  })

  it('只有支持目录 core.rb 也算命中（根文件缺失时的回退）', async () => {
    const root = await makeTempRoot()
    await writePluginFile(
      root,
      '2023',
      path.join('idbox_panel', 'lib', 'core.rb'),
      "PLUGIN_VERSION = '0.9.0'.freeze\n"
    )
    const hits = await scanInstalledPlugins({ appData: root })
    expect(hits).toEqual([{ sketchup: 'SketchUp 2023', version: '0.9.0' }])
  })

  it('文件在但解析不出版本 → 仍产出一条 hit，version:null（诚实）', async () => {
    const root = await makeTempRoot()
    await writePluginFile(root, '2022', 'idbox_panel.rb', 'module IDBoxPanel\nend\n')
    const hits = await scanInstalledPlugins({ appData: root })
    expect(hits).toEqual([{ sketchup: 'SketchUp 2022', version: null }])
  })

  it('两个文件都没有 → 跳过该年份（没装 = 不产出 hit）', async () => {
    const root = await makeTempRoot()
    await fs.mkdir(path.join(root, 'SketchUp', 'SketchUp 2021', 'SketchUp', 'Plugins'), {
      recursive: true
    })
    expect(await scanInstalledPlugins({ appData: root })).toEqual([])
  })

  it('目录不存在 / 参数缺失 → 返回 [] 且不抛', async () => {
    const missing = path.join(os.tmpdir(), 'idbox-plugin-scan-definitely-missing-xyz')
    expect(await scanInstalledPlugins({ appData: missing })).toEqual([])
    expect(await scanInstalledPlugins({})).toEqual([])
    expect(sketchupPluginDirs({})).toEqual([])
  })

  it('ProgramData 与 appData 双根都会扫（按绝对路径去重）', async () => {
    const userRoot = await makeTempRoot()
    const machineRoot = await makeTempRoot()
    await writePluginFile(userRoot, '2025', 'idbox_panel.rb', "EXT_VERSION = '1.1.0'.freeze\n")
    await writePluginFile(machineRoot, '2024', 'idbox_panel.rb', "EXT_VERSION = '1.0.5'.freeze\n")
    const hits = await scanInstalledPlugins({ appData: userRoot, programData: machineRoot })
    expect(hits.map((h) => h.sketchup).sort()).toEqual(['SketchUp 2024', 'SketchUp 2025'])
    // 同一个根传给两边不应产出重复 hit
    expect(await scanInstalledPlugins({ appData: userRoot, programData: userRoot })).toHaveLength(1)
  })
})

describe('源码守卫：UI 侧不再持有任何版本号 / 自证判据', () => {
  it('SettingsDialog 不含 0.8.0、不含 card.version；IPC 契约带 install 字段', () => {
    const ui = readFileSync(
      new URL('../src/renderer/components/SettingsDialog.tsx', import.meta.url),
      'utf-8'
    ).replace(/\r\n/g, '\n')
    expect(ui).not.toContain('0.8.0')
    expect(ui).not.toContain('card.version')
    const ipc = readFileSync(new URL('../src/shared/ipc.ts', import.meta.url), 'utf-8').replace(
      /\r\n/g,
      '\n'
    )
    expect(ipc).toContain('install?: PluginInstallStatus')
  })
})
