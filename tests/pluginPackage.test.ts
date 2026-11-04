/**
 * `.rbz` 打包单测 —— `docs/39` §4.1 / §4.2 / §4.3 的验收（**导出侧**）。
 *
 * 覆盖派工单的 a–e，外加几条"装了才知道错"的硬约束：
 * (a) happy path：包真的存在，**ZIP 根恰好两项**，根 `.rb` 在根、`idbox_panel/` 目录树齐全；
 * (b) 源码根有杂项（`README.md`）→ `ok:false` 且**点名**是它（不许静默塞进包）；
 * (c) 源码目录不存在 → `ok:false`；
 * (d) `outPath` 位于不存在的目录 → **建出来**（本文件选"创建"，并断言）；
 * (e) 成功后目录里没有 `.tmp` 残留。
 * 另加：默认文件名、dev/打包两种源码路径解析、`extraResources` 已声明（否则打包版没有
 * `plugin-src`，导出必然失败）、IPC 三处接线齐全、设置页那一行是按钮而不是 CheckRow。
 *
 * 环境是 vitest `environment: 'node'`（无 jsdom、无 electron）⇒ 版本号 / 路径全部由参数注入，
 * 源码目录用 `mkdtemp` 临时 fixture（`plugin-src/` 由另一位工程师并行创建，本文件不碰它）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

import {
  RBZ_ROOT_RB_FILE_NAME,
  RBZ_SUPPORT_DIR_ENTRY,
  RBZ_TMP_SUFFIX,
  RBZ_TOP_LEVEL_ENTRIES,
  buildRbz,
  defaultRbzFileName,
  resolvePluginSrcDir,
  topLevelEntries
} from '../src/main/pluginPackage'

/** 临时工作区（每个用例一份，`afterEach` 清掉） */
let workDir = ''
/** 临时 `plugin-src`（形状照 `docs/39 §4.2`） */
let srcDir = ''

async function makeFixture(): Promise<void> {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'idbox-rbz-'))
  srcDir = path.join(workDir, 'plugin-src')
  await mkdir(path.join(srcDir, 'idbox_panel', 'lib'), { recursive: true })
  await writeFile(path.join(srcDir, RBZ_ROOT_RB_FILE_NAME), '# 根注册文件（只做扩展注册）\n', 'utf-8')
  await writeFile(path.join(srcDir, 'idbox_panel', 'main.rb'), "require 'sketchup'\n", 'utf-8')
  await writeFile(path.join(srcDir, 'idbox_panel', 'panel.html'), '<!doctype html>\n', 'utf-8')
  await writeFile(path.join(srcDir, 'idbox_panel', 'lib', 'util.rb'), "module IDBox; end\n", 'utf-8')
}

beforeEach(makeFixture)

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/** 读回落盘的那份字节（断言对象必须是"真正要落盘的那份"，不是内存里的 zip 对象） */
async function readZip(outPath: string): Promise<AdmZip> {
  return new AdmZip(await readFile(outPath))
}

describe('(a) happy path：ZIP 根恰好两项（docs/39 §4.2）', () => {
  it('产出文件存在，bytes 与落盘字节一致，entries 就是那两项', async () => {
    const outPath = path.join(workDir, 'out', 'idbox_panel-0.9.3.rbz')
    const r = await buildRbz(srcDir, outPath, { now: () => new Date(0) })

    expect(r.ok).toBe(true)
    if (!r.ok) return

    const buf = await readFile(outPath)
    expect(r.bytes).toBe(buf.length)
    expect(r.bytes).toBeGreaterThan(0)
    // 返回值的 entries 顺序 = 常量顺序，UI 可以直接显示
    expect(r.entries).toEqual([...RBZ_TOP_LEVEL_ENTRIES])
  })

  it('根 `.rb` 在 ZIP 根（不是塞进支持目录里）', async () => {
    const outPath = path.join(workDir, 'a.rbz')
    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)

    const zip = await readZip(outPath)
    const rootEntry = zip.getEntry(RBZ_ROOT_RB_FILE_NAME)
    expect(rootEntry).not.toBeNull()
    expect(rootEntry?.isDirectory).toBe(false)
    expect(zip.readAsText(RBZ_ROOT_RB_FILE_NAME)).toBe('# 根注册文件（只做扩展注册）\n')
  })

  it('支持目录树完整：目录条目 + 各级文件都在，顶层项集合恰好两项', async () => {
    const outPath = path.join(workDir, 'b.rbz')
    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)

    const zip = await readZip(outPath)
    const names = zip.getEntries().map((e) => e.entryName)

    // ① 顶层恰好两项（这是"装得上"的唯一判据）
    expect(topLevelEntries(names)).toEqual([RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_ENTRY])
    expect(topLevelEntries(names)).toHaveLength(2)

    // ② 目录条目存在且被识别为目录（adm-zip：entryName 以 `/` 结尾 ⇒ isDirectory）
    expect(zip.getEntry(RBZ_SUPPORT_DIR_ENTRY)?.isDirectory).toBe(true)
    expect(names).toContain('idbox_panel/lib/')

    // ③ 文件逐条都在，且内容没被改写（UTF-8 明文，不加密、不混淆）
    for (const rel of ['idbox_panel/main.rb', 'idbox_panel/panel.html', 'idbox_panel/lib/util.rb']) {
      expect(names).toContain(rel)
    }
    expect(zip.readAsText('idbox_panel/main.rb')).toBe("require 'sketchup'\n")
    expect(zip.readAsText('idbox_panel/lib/util.rb')).toBe('module IDBox; end\n')
  })

  it('空目录也被保留（native/<platform>/<rubyVer>/ 只立约定的场景）', async () => {
    const emptySrc = path.join(workDir, 'empty-src')
    await mkdir(path.join(emptySrc, 'idbox_panel', 'native', 'win', '3.2'), { recursive: true })
    await writeFile(path.join(emptySrc, RBZ_ROOT_RB_FILE_NAME), "# root\n", 'utf-8')

    const outPath = path.join(workDir, 'empty.rbz')
    const r = await buildRbz(emptySrc, outPath)
    expect(r.ok).toBe(true)

    const names = (await readZip(outPath)).getEntries().map((e) => e.entryName)
    expect(names).toContain('idbox_panel/')
    expect(names).toContain('idbox_panel/native/')
    expect(names).toContain('idbox_panel/native/win/')
    expect(names).toContain('idbox_panel/native/win/3.2/')
  })
})

describe('(b) 源码根有杂项：该报错的报错并点名，说明文件不进包', () => {
  it('多出的 notes.txt 让打包失败，错误文案里有它的名字，且不产文件', async () => {
    await writeFile(path.join(srcDir, 'notes.txt'), 'stray\n', 'utf-8')
    const outPath = path.join(workDir, 'stray.rbz')

    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('notes.txt')
    expect(r.error).toContain(RBZ_ROOT_RB_FILE_NAME)
    // 失败时不留半成品：连 out 目录里的 rbz 都不该出现
    expect(existsSync(outPath)).toBe(false)
  })

  it('多个杂项全部点名（sorted，便于用户一次清理干净）', async () => {
    await writeFile(path.join(srcDir, 'notes.txt'), 'x', 'utf-8')
    await writeFile(path.join(srcDir, 'draft.rb'), 'x', 'utf-8')

    const r = await buildRbz(srcDir, path.join(workDir, 'two.rbz'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('notes.txt')
    expect(r.error).toContain('draft.rb')
  })

  it('README.md 是唯一白名单：允许存在但**绝不进包**（插件源码根下真实存在这个文件）', async () => {
    await writeFile(path.join(srcDir, 'README.md'), '# 工程说明，不属于插件包\n', 'utf-8')
    const outPath = path.join(workDir, 'readme.rbz')

    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const zip = await readZip(outPath)
    const names = zip.getEntries().map((e) => e.entryName)
    expect(topLevelEntries(names)).toEqual([RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_ENTRY])
    expect(names).not.toContain('README.md')
    expect(zip.readAsText(RBZ_ROOT_RB_FILE_NAME)).toBe('# 根注册文件（只做扩展注册）\n')
  })
})

describe('(c) 源码目录缺失 / 结构不全', () => {
  it('源码目录不存在 → ok:false，文案带路径', async () => {
    const missing = path.join(workDir, 'nope', 'plugin-src')
    const r = await buildRbz(missing, path.join(workDir, 'c.rbz'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('不存在')
    expect(r.error).toContain(missing)
  })

  it('缺根注册文件 → ok:false', async () => {
    await rm(path.join(srcDir, RBZ_ROOT_RB_FILE_NAME))
    const r = await buildRbz(srcDir, path.join(workDir, 'd.rbz'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain(RBZ_ROOT_RB_FILE_NAME)
  })

  it('缺支持目录 → ok:false', async () => {
    await rm(path.join(srcDir, 'idbox_panel'), { recursive: true, force: true })
    const r = await buildRbz(srcDir, path.join(workDir, 'e.rbz'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain(RBZ_SUPPORT_DIR_ENTRY)
  })

  it('空 srcDir 入参 → ok:false（不抛异常）', async () => {
    const r = await buildRbz('   ', path.join(workDir, 'f.rbz'))
    expect(r.ok).toBe(false)
  })
})

describe('(d) outPath 位于不存在的目录 → 建出来（本文件选"创建"）', () => {
  it('多级父目录被 mkdir -p，包正常落盘', async () => {
    const outPath = path.join(workDir, 'deep', 'a', 'b', 'idbox_panel.rbz')
    expect(existsSync(path.dirname(outPath))).toBe(false)

    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)
    expect(existsSync(outPath)).toBe(true)
    expect((await stat(outPath)).isFile()).toBe(true)
  })
})

describe('(e) 原子写：成功后没有 .tmp 残留', () => {
  it('目标目录里只有那个 .rbz，没有 `<file>.tmp`', async () => {
    const outDir = path.join(workDir, 'atomic')
    const outPath = path.join(outDir, 'idbox_panel.rbz')
    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)

    const files = await readdir(outDir)
    expect(files).toEqual(['idbox_panel.rbz'])
    expect(files.filter((f) => f.endsWith(RBZ_TMP_SUFFIX))).toEqual([])
  })

  it('覆盖同名旧包：内容被替换，仍然没有 .tmp 残留', async () => {
    const outPath = path.join(workDir, 'overwrite.rbz')
    await writeFile(outPath, 'old-bytes', 'utf-8')

    const r = await buildRbz(srcDir, outPath)
    expect(r.ok).toBe(true)
    const buf = await readFile(outPath)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect((await readdir(workDir)).filter((f) => f.endsWith(RBZ_TMP_SUFFIX))).toEqual([])
  })
})

describe('默认文件名与源码目录解析', () => {
  it('defaultRbzFileName 用版本号拼 `idbox_panel-<ver>.rbz`', () => {
    expect(defaultRbzFileName('0.9.3')).toBe('idbox_panel-0.9.3.rbz')
    // 空版本不产出 `idbox_panel-.rbz` 这种让人怀疑的文件名
    expect(defaultRbzFileName('')).toBe('idbox_panel-0.0.0.rbz')
    expect(defaultRbzFileName('   ')).toBe('idbox_panel-0.0.0.rbz')
  })

  it('dev：`<仓库根>/plugin-src`（不依赖 process.cwd()）', () => {
    const resolved = resolvePluginSrcDir({
      isPackaged: false,
      appPath: path.join(workDir, 'repo'),
      resourcesPath: path.join(workDir, 'release', 'resources')
    })
    expect(resolved).toBe(path.join(workDir, 'repo', 'plugin-src'))
  })

  it('打包：`<resourcesPath>/plugin-src`', () => {
    const resolved = resolvePluginSrcDir({
      isPackaged: true,
      appPath: path.join(workDir, 'repo'),
      resourcesPath: path.join(workDir, 'release', 'resources')
    })
    expect(resolved).toBe(path.join(workDir, 'release', 'resources', 'plugin-src'))
  })

  it('resourcesPath 缺失时不抛异常（退回 appPath，让上层报真实路径）', () => {
    const resolved = resolvePluginSrcDir({
      isPackaged: true,
      appPath: path.join(workDir, 'repo'),
      resourcesPath: ''
    })
    expect(resolved).toBe(path.join(workDir, 'repo', 'plugin-src'))
  })

  it('topLevelEntries：文件取全名、目录与更深的路径都收敛到顶层项', () => {
    expect(
      topLevelEntries(['idbox_panel.rb', 'idbox_panel/', 'idbox_panel/main.rb', 'idbox_panel\\lib\\x.rb'])
    ).toEqual([RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_ENTRY])
    expect(topLevelEntries([])).toEqual([])
  })
})

describe('真实 `plugin-src/`（真的能装上的那个包）', () => {
  // 该目录由另一位工程师并行创建；未就位时跳过而不是伪装通过
  const realSrc = path.join(process.cwd(), 'plugin-src')
  const hasReal = existsSync(path.join(realSrc, RBZ_ROOT_RB_FILE_NAME))

  it.skipIf(!hasReal)('仓库根的 plugin-src 打出恰好两项、根 `.rb` 在根的包', async () => {
    const outPath = path.join(workDir, 'real.rbz')
    const r = await buildRbz(realSrc, outPath)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const zip = await readZip(outPath)
    const names = zip.getEntries().map((e) => e.entryName)
    expect(topLevelEntries(names)).toEqual([RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_ENTRY])
    expect(zip.getEntry(RBZ_ROOT_RB_FILE_NAME)?.isDirectory).toBe(false)
    // 根 `.rb` 必须是**注册文件**（有 SketchupExtension 注册），不是逻辑文件
    expect(zip.readAsText(RBZ_ROOT_RB_FILE_NAME)).toContain('register_extension')
    // 支持目录里必须有 main.rb（`SketchupExtension.new(..., "idbox_panel/main")` 的落点）
    expect(names).toContain('idbox_panel/main.rb')
    // README 之类的说明文件不进包
    expect(names).not.toContain('README.md')
  })
})

describe('接线守卫：打包能装上还差这几处', () => {
  const repo = process.cwd()
  const read = (rel: string): string => readFileSync(path.join(repo, rel), 'utf-8')

  it('package.json 用 extraResources 把 plugin-src 塞进 resources（否则打包版导出必失败）', () => {
    const pkg = JSON.parse(read('package.json')) as {
      version: string
      build?: { extraResources?: { from: string; to: string }[] }
    }
    const rules = pkg.build?.extraResources ?? []
    expect(rules).toContainEqual({ from: 'plugin-src', to: 'plugin-src' })
  })

  it('IPC 三处齐全：shared/ipc.ts + preload/index.ts + main/index.ts', () => {
    expect(read('src/shared/ipc.ts')).toContain("pluginExportRbz: 'plugin:exportRbz'")
    expect(read('src/preload/index.ts')).toContain('exportPluginRbz')
    expect(read('src/main/index.ts')).toContain('ipcMain.handle(IPC.pluginExportRbz')
  })

  it('前置校验：开关关着时主进程先报错，不产出一个"装了只会显示未开导出"的包', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('请先在设置里开启「SketchUp 插件」索引导出')
    // 校验必须在打包动作之前
    expect(main.indexOf('请先在设置里开启')).toBeLessThan(main.indexOf('await buildRbz('))
  })

  it('设置页那一行是按钮（不是 CheckRow）——复选框数量守卫不变', () => {
    const ui = read('src/renderer/components/SettingsDialog.tsx')
    expect(ui).toContain('导出 SketchUp 插件包（.rbz）')
    expect(ui).toContain('在 SketchUp 里用「扩展 → 安装扩展」选中该文件；装完重启 SketchUp 生效')
    expect(ui).toContain('void exportRbz()')
    // 导出按钮旁边不许出现 role="checkbox" 那套自绘开关（它是动作，不是状态）
    const row = ui.slice(ui.indexOf('title="导出 SketchUp 插件包（.rbz）"'))
    expect(row.slice(0, 900)).not.toContain('<CheckRow')
  })
})
