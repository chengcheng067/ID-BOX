/**
 * 存量大类迁移（P0）· `src/main/kindMigrate.ts` 单测。
 *
 * 背景：`cad` 是 0.9.0 新增大类，0.8.x 时代 `EXT_KIND` 把 `dwg → model`，所以那批图纸
 * 落盘在 `模型/<一级>/<二级>/<资产名>`、`files[].kind === 'model'`。用户升级后首页仍把
 * 它们显示在「模型」里。本文件钉住迁移的**判据边界**与**原子性**。
 *
 * ⚠️ 全部文件系统实验都在 `os.tmpdir()` 里造库，**绝不触碰**
 * `E:/ModVault/Library`、`D:/ModVault/Library`、`%APPDATA%/idbox`。
 * 每个用例结束 `fs.rm(recursive)` 清干净。
 *
 * 判据（`shouldMigrateKind`）是本次最高危的一段代码 —— 用户库是真数据，
 * 多迁一条就是"把正确的模型搬进 CAD"，少迁一条就是"图纸还在模型里"。所以
 * 计划阶段的用例比 apply 阶段多。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SNAPSHOT_KEEP,
  SNAPSHOT_PREFIX,
  applyKindMigration,
  detectKindMigration,
  planKindMigration,
  shouldMigrateKind
} from '../src/main/kindMigrate'
import { kindFolder } from '../src/shared/classify'
import type { Asset, AssetFile, AssetKind, KindMovePlan } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-kindmig-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

// ── 夹具 ─────────────────────────────────────────────────────────────

let seq = 0

/** 造一个文件记录（`kind` 由调用方给：存量记录里 dwg 的 kind 是 `'model'`） */
function file(rel: string, ext: string, kind: AssetKind, size = 10): AssetFile {
  return { rel, name: rel, ext, size, kind }
}

/**
 * 造一条资产。
 *
 * 默认形态 = **用户真实库里那批存量图纸**：`kind='model'`、落在 `模型/…`、
 * 包内只有一个 `.dwg` 且它的 `files[].kind` 也是 `'model'`（0.8.x 写进去的历史快照）。
 *
 * ⚠️ `folder` 默认用假路径 `E:\\Lib\\…`（纯计划用例不需要真实目录）。凡是要**真搬盘**的
 * 用例必须先调 `inLib(a, lib)` 把 `folder` 改到 tmp 库里 —— 否则 apply 的源目录预检必失败。
 */
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const name = patch.name ?? `图纸资产${n}`
  const kind = patch.kind ?? 'model'
  const folderName = kindFolder(kind) || '模型'
  return {
    id: `asset-${n}`,
    name,
    kind,
    source: '知末网',
    folder: `E:\\Lib\\${folderName}\\装修图\\平面图\\${name}`,
    relFolder: `${folderName}/装修图/平面图/${name}`,
    files: [file(`${name}.dwg`, 'dwg', 'model')],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `${kind}:${name}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '装修图',
    category2: '平面图',
    styles: [],
    ...patch
  }
}

/** 把资产的 `folder` 指到真实 tmp 库里（apply 用例必须先过这一步） */
function inLib(a: Asset, lib: string): Asset {
  return { ...a, folder: path.join(lib, ...a.relFolder.split('/')) }
}

/** 在 tmp 库里按资产记录建出真实目录（+ 一个文件，免得空目录被当壳） */
async function materialize(lib: string, a: Asset): Promise<void> {
  const abs = path.join(lib, ...a.relFolder.split('/'))
  await fs.mkdir(abs, { recursive: true })
  await fs.writeFile(path.join(abs, '1F平面图.dwg'), 'x')
}

async function has(lib: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(lib, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

// ── ① 判据：进不进计划 ────────────────────────────────────────────────

describe('★判据边界：只迁「纯图纸包」，模型优先的混合包一律不动', () => {
  const planOf = (a: Asset): KindMovePlan => planKindMigration([a], 'E:\\Lib')

  it('① 纯 dwg 包（存量形态：files 全 kind=model、ext=dwg）→ **进计划**', () => {
    const a = asset()
    expect(shouldMigrateKind(a)).toBe(true)
    const plan = planOf(a)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({
      assetId: a.id,
      fromKind: 'model',
      toKind: 'cad'
    })
  })

  it('② `.skp` + `.dwg` 混合包 → **不进计划**（模型优先的既有裁定，`KIND_PRIORITY`）', () => {
    // 这是用户库里真实存在的形态：模型是主内容、图纸是附件，它们是**正确**的 model
    const a = asset({
      files: [file('模型.skp', 'skp', 'model'), file('平面图.dwg', 'dwg', 'model')]
    })
    expect(shouldMigrateKind(a)).toBe(false)
    expect(planOf(a).items).toHaveLength(0)
  })

  it('②b `.max` + `.dwg` 同理不进（不是只对 skp 特判）', () => {
    const a = asset({ files: [file('a.max', 'max', 'model'), file('b.dwg', 'dwg', 'model')] })
    expect(planOf(a).items).toHaveLength(0)
  })

  it('③ 纯 `.skp` 包 → 不进（没有图纸）', () => {
    const a = asset({ files: [file('a.skp', 'skp', 'model')] })
    expect(planOf(a).items).toHaveLength(0)
  })

  it('④ 纯贴图 / 纯材质 / 纯 HDR 包 → 都不进', () => {
    const texture = asset({
      kind: 'texture',
      files: [file('a.jpg', 'jpg', 'texture'), file('b.png', 'png', 'texture')]
    })
    const material = asset({ kind: 'material', files: [file('a.vismat', 'vismat', 'material')] })
    const hdri = asset({ kind: 'hdri', files: [file('a.hdr', 'hdr', 'hdri')] })
    for (const a of [texture, material, hdri]) {
      expect(shouldMigrateKind(a), a.kind).toBe(false)
      expect(planOf(a).items, a.kind).toHaveLength(0)
    }
  })

  it('④b 贴图包 + dwg（kind=texture）→ 不进（只处理 kind==="model"）', () => {
    // 这条防的是「看到 dwg 就想迁」的写法：kind 不是 model 时一律不动，
    // 因为 `targetRelFolderOf` 会把「贴图」目录下的资产搬进 CAD —— 那不是本任务的范围
    const a = asset({ kind: 'texture', files: [file('a.jpg', 'jpg', 'texture'), file('b.dwg', 'dwg', 'cad')] })
    expect(shouldMigrateKind(a)).toBe(false)
    expect(planOf(a).items).toHaveLength(0)
  })

  it("⑤ 已迁移过（kind==='cad'）→ **不进计划**（幂等的唯一挡板）", () => {
    const a = asset({ kind: 'cad', files: [file('a.dwg', 'dwg', 'cad')] })
    expect(shouldMigrateKind(a)).toBe(false)
    expect(planOf(a).items).toHaveLength(0)
  })

  it('⑤b 目标与现状逐字相同（手改数据造出的 "kind=model 但已在 CAD 下"）→ 不进', () => {
    const name = '错位资产'
    const a = asset({
      name,
      kind: 'model',
      folder: `E:\\Lib\\CAD\\装修图\\平面图\\${name}`,
      relFolder: `CAD/装修图/平面图/${name}`,
      files: [file('a.dwg', 'dwg', 'model')]
    })
    // 判据本身为真（kind=model 且有图纸无其它模型），但计划期 self-target 守卫拦住
    expect(shouldMigrateKind(a)).toBe(true)
    expect(planOf(a).items).toHaveLength(0)
  })

  it('扩展名大小写不敏感（`.DWG` 也算）', () => {
    const a = asset({ files: [file('A.DWG', 'DWG', 'model')] })
    expect(shouldMigrateKind(a)).toBe(true)
  })

  it('dxf 同样算图纸（与 dwg 同一条历史语义）', () => {
    const a = asset({ files: [file('a.dxf', 'dxf', 'model')] })
    expect(shouldMigrateKind(a)).toBe(true)
  })

  it('空 files 数组 → 不进（判不出就当没有）', () => {
    expect(shouldMigrateKind(asset({ files: [] }))).toBe(false)
  })
})

// ── ② 目标路径 ────────────────────────────────────────────────────────

describe('★toRelFolder：首段用 kindFolder("cad")、四层深度正确', () => {
  it('规范布局（4 段）→ 只换首段，一级/二级/资产名原样保留', () => {
    const a = asset({
      name: '现代客厅平面图',
      relFolder: '模型/装修图/平面图/现代客厅平面图'
    })
    const plan = planKindMigration([a], 'E:\\Lib')
    expect(plan.items[0]!.toRelFolder).toBe(
      `CAD/装修图/平面图/现代客厅平面图`
    )
    // 首段必须来自 `kindFolder('cad')`，且**不是**字面量巧合
    expect(plan.items[0]!.toRelFolder.split('/')[0]).toBe(kindFolder('cad'))
    // 四层
    expect(plan.items[0]!.toRelFolder.split('/')).toHaveLength(4)
  })

  it('遗留两段布局（模型/<资产名>）→ 用 DB 分类字段重组成 4 段', () => {
    const a = asset({
      name: '旧版资产',
      relFolder: '模型/旧版资产',
      category1: '家装空间',
      category2: '未分类'
    })
    const plan = planKindMigration([a], 'E:\\Lib')
    expect(plan.items[0]!.toRelFolder).toBe(`CAD/家装空间/未分类/旧版资产`)
    expect(plan.items[0]!.toRelFolder.split('/')).toHaveLength(4)
  })

  it('遗留布局但分类字段缺失 → 双哨兵兜底，仍是 4 段', () => {
    const a = asset({
      name: '无分类',
      relFolder: '模型/无分类',
      category1: undefined,
      category2: undefined
    })
    const plan = planKindMigration([a], 'E:\\Lib')
    expect(plan.items[0]!.toRelFolder).toBe('CAD/未分类/未分类/无分类')
  })

  it('scanned = 入参长度（区分"没待迁移项"与"库里没数据"）', () => {
    const a = asset()
    const b = asset({ files: [file('x.skp', 'skp', 'model')] })
    const plan = planKindMigration([a, b], 'E:\\Lib')
    expect(plan.scanned).toBe(2)
    expect(plan.items).toHaveLength(1)
  })
})

// ── ③ apply：真实搬目录 ───────────────────────────────────────────────

describe('★applyKindMigration：真实搬盘 + 重名 + 单条失败隔离', () => {
  it('搬到 <库根>/CAD/<一级>/<二级>/<资产名>，原目录消失', async () => {
    const lib = await tmpDir()
    const a = inLib(asset({ name: '客厅平面图', relFolder: '模型/装修图/平面图/客厅平面图' }), lib)
    await materialize(lib, a)
    expect(await has(lib, '模型/装修图/平面图/客厅平面图')).toBe(true)

    const plan = planKindMigration([a], lib)
    const results = await applyKindMigration(plan, { libraryDir: lib })

    expect(results).toHaveLength(1)
    const r = results[0]!
    expect(r.error).toBeUndefined()
    expect(r.moved).toBe(true)
    expect(r.renamed).toBe(false)
    expect(r.relFolder).toBe('CAD/装修图/平面图/客厅平面图')
    // 磁盘真相
    expect(await has(lib, 'CAD/装修图/平面图/客厅平面图')).toBe(true)
    expect(await has(lib, '模型/装修图/平面图/客厅平面图')).toBe(false)
    // `folder` 是最终绝对路径，且与 `relFolder` 一致
    expect(r.folder).toBe(path.join(lib, 'CAD', '装修图', '平面图', '客厅平面图'))
  })

  it('★目标已有同名 → `renamed === true`，原名资产**不被覆盖**', async () => {
    const lib = await tmpDir()
    const a = inLib(asset({ name: '同名图', relFolder: '模型/装修图/平面图/同名图' }), lib)
    await materialize(lib, a)
    // 先占住目标名
    const taken = path.join(lib, 'CAD', '装修图', '平面图', '同名图')
    await fs.mkdir(taken, { recursive: true })
    await fs.writeFile(path.join(taken, 'already.dwg'), 'keep-me')

    const results = await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib })
    const r = results[0]!
    expect(r.renamed).toBe(true)
    expect(r.name).toBe('同名图-2')
    expect(r.relFolder).toBe('CAD/装修图/平面图/同名图-2')
    // 已占位的那份文件一个字节没动（永不覆盖）
    expect(await fs.readFile(path.join(taken, 'already.dwg'), 'utf-8')).toBe('keep-me')
    // 新搬来的在 -2
    expect(await has(lib, 'CAD/装修图/平面图/同名图-2')).toBe(true)
  })

  it('★单条失败（源目录不存在）→ 其它项仍成功，该项有 error', async () => {
    const lib = await tmpDir()
    const ghost = inLib(asset({ name: '幽灵', relFolder: '模型/装修图/平面图/幽灵' }), lib)
    const real = inLib(asset({ name: '真实', relFolder: '模型/装修图/平面图/真实' }), lib)
    // 只落地第二个（第一个的目录故意不存在）
    await materialize(lib, real)

    const results = await applyKindMigration(planKindMigration([ghost, real], lib), {
      libraryDir: lib
    })
    expect(results).toHaveLength(2)
    const ghostResult = results.find((r) => r.assetId === ghost.id)!
    const realResult = results.find((r) => r.assetId === real.id)!

    expect(ghostResult.error).toBeTruthy()
    expect(ghostResult.moved).toBe(false)
    // 失败项回传的是**迁移前**的值（渲染层据此跳过，不会写坏索引）
    expect(ghostResult.folder).toBe(ghost.folder)
    expect(ghostResult.relFolder).toBe(ghost.relFolder)

    expect(realResult.error).toBeUndefined()
    expect(realResult.moved).toBe(true)
    expect(await has(lib, 'CAD/装修图/平面图/真实')).toBe(true)
  })

  it('失败项**不留下**空的 CAD/一级/二级 壳（源预检早于 mkdir）', async () => {
    const lib = await tmpDir()
    const ghost = inLib(asset({ name: '幽灵', relFolder: '模型/装修图/平面图/幽灵' }), lib)
    await applyKindMigration(planKindMigration([ghost], lib), { libraryDir: lib })
    // 全失败 → CAD 目录连一层都不该建出来
    expect(await has(lib, 'CAD')).toBe(false)
  })

  it('空计划 → 零结果，且不建任何目录', async () => {
    const lib = await tmpDir()
    const results = await applyKindMigration(planKindMigration([], lib), { libraryDir: lib })
    expect(results).toEqual([])
    expect(await has(lib, 'CAD')).toBe(false)
  })

  it('幂等：连跑两次，第二次计划为空（kind 由渲染层写回 cad 后）', async () => {
    const lib = await tmpDir()
    const a = inLib(asset({ name: '幂等图', relFolder: '模型/装修图/平面图/幂等图' }), lib)
    await materialize(lib, a)

    const first = await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib })
    expect(first[0]!.moved).toBe(true)

    // 模拟渲染层写库：kind → cad，folder/relFolder 用**最终落盘值**
    const after: Asset = {
      ...a,
      kind: 'cad',
      folder: first[0]!.folder,
      relFolder: first[0]!.relFolder,
      files: a.files.map((f) => ({ ...f, kind: 'cad' as AssetKind }))
    }
    const secondPlan = planKindMigration([after], lib)
    expect(secondPlan.items).toHaveLength(0)
    expect(secondPlan.scanned).toBe(1)
  })
})

// ── ④ 快照 ────────────────────────────────────────────────────────────

describe('快照：迁移前落 JSON，写失败不阻断', () => {
  it('写了 kind-migrate-<ISO>.json，内容含 items', async () => {
    const lib = await tmpDir()
    const snapDir = await tmpDir()
    const a = inLib(asset({ name: '快照图', relFolder: '模型/装修图/平面图/快照图' }), lib)
    await materialize(lib, a)

    await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib, snapshotDir: snapDir })
    const names = await fs.readdir(snapDir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^kind-migrate-.*\.json$/)
    const payload = JSON.parse(await fs.readFile(path.join(snapDir, names[0]!), 'utf-8'))
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].assetId).toBe(a.id)
    expect(payload.libraryDir).toBe(path.resolve(lib))
  })

  it('★快照写失败（目录不可建）→ 迁移照常完成，只走 onWarn', async () => {
    const lib = await tmpDir()
    const a = inLib(asset({ name: '无快照图', relFolder: '模型/装修图/平面图/无快照图' }), lib)
    await materialize(lib, a)

    // 拿一个**文件**当快照目录 → mkdir 必失败（ENOTDIR / EEXIST）
    const blocker = path.join(lib, 'not-a-dir')
    await fs.writeFile(blocker, 'x')
    const warns: Array<{ m: string; ctx?: unknown }> = []

    const results = await applyKindMigration(planKindMigration([a], lib), {
      libraryDir: lib,
      snapshotDir: path.join(blocker, 'sub'),
      onWarn: (m: string, ctx?: unknown) => warns.push({ m, ctx })
    })
    expect(results[0]!.error).toBeUndefined()
    expect(results[0]!.moved).toBe(true)
    expect(await has(lib, 'CAD/装修图/平面图/无快照图')).toBe(true)
    expect(warns.map((w) => w.m)).toContain('kind-migrate:snapshot-failed')
  })

  it('无 snapshotDir（单测默认）→ 不写任何文件', async () => {
    const lib = await tmpDir()
    const a = inLib(asset({ name: 'x', relFolder: '模型/装修图/平面图/x' }), lib)
    await materialize(lib, a)
    await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib })
    const entries = await fs.readdir(lib)
    expect(entries.filter((e) => e.startsWith('kind-migrate-'))).toHaveLength(0)
  })
})

// ── ⑤ structured clone 守卫（**防回归的关键一条**）────────────────────────
//
// 背景（2026-10-30 主理人裁决，真 bug）：`KindMovePlan` 曾带 `snapshotDir` 与
// `onWarn` 函数，而它是 `library:detectKindMigration` 的 IPC 返回值。
// Electron 的 `ipcMain.handle` 返回值走 **structured clone** —— 函数过不去：
// 轻则字段被静默丢弃（类型在骗人），重则整个调用抛 `An object could not be cloned`。
// 后者更致命：渲染层的 `.catch(() => null)` 会吞掉错误 → 功能表现为「永远已是最新」，
// **完全不生效**，而且不报错、不弹提示，排查时会怀疑到完全无关的地方去。
//
// 修法是把执行上下文拆到 `KindMigrateContext`（只在 main 内部用），并把 detect 的
// 返回值收窄成 `KindMigrateDetectResult`。下面几条钉住"别再长回去"。

describe('★structured clone 守卫：plan / detect 的返回值必须能过 IPC', () => {
  it('KindMovePlan 可 JSON 往返，且不含任何函数字段', () => {
    const plan = planKindMigration(
      [asset({ name: '守卫图', relFolder: '模型/装修图/平面图/守卫图' })],
      'E:\\Lib'
    )
    // JSON 往返 = structured clone 的最强代理断言（函数在这里会直接抛 / 或丢字段）
    const round = JSON.parse(JSON.stringify(plan)) as KindMovePlan
    expect(round).toEqual(plan)
    // 显式钉住历史回归点
    expect(plan).not.toHaveProperty('onWarn')
    expect(plan).not.toHaveProperty('snapshotDir')
    expect(plan).not.toHaveProperty('libraryDir')
    // 只有约定的两个字段（多一个都要重新审一遍"它能不能过 clone"）
    expect(Object.keys(plan).sort()).toEqual(['items', 'scanned'])
  })

  it('每一条 item 也是纯数据（没有函数 / 没有多余字段）', () => {
    const plan = planKindMigration([asset()], 'E:\\Lib')
    expect(plan.items.length).toBeGreaterThan(0)
    for (const item of plan.items) {
      expect(Object.keys(item).sort()).toEqual([
        'assetId',
        'folder',
        'fromKind',
        'fromRelFolder',
        'name',
        'toKind',
        'toRelFolder'
      ])
    }
    expect(JSON.parse(JSON.stringify(plan.items))).toEqual(plan.items)
  })

  it('★detectKindMigration 返回精简结构：只有 count / scanned / names，不含任何路径', () => {
    const a = asset({ name: '暴露面图', relFolder: '模型/装修图/平面图/暴露面图' })
    const result = detectKindMigration([a], 'E:\\Lib')
    expect(Object.keys(result).sort()).toEqual(['count', 'names', 'scanned'])
    expect(result.count).toBe(1)
    expect(result.scanned).toBe(1)
    expect(result.names).toEqual(['暴露面图'])
    // 绝对路径 / 一级分类名绝不能出现在发往渲染进程的载荷里
    const wire = JSON.stringify(result)
    expect(wire).not.toContain(String.raw`E:\\Lib`)
    expect(wire).not.toContain('装修图')
    expect(result).not.toHaveProperty('items')
    // 同样要能过 clone
    expect(JSON.parse(wire)).toEqual(result)
  })

  it('detect 在无待迁移项时 count=0 且 names 为空（渲染层据此静默）', () => {
    const r = detectKindMigration([asset({ kind: 'cad' })], 'E:\\Lib')
    expect(r).toEqual({ count: 0, scanned: 1, names: [] })
  })
})

// ── ⑥ 库界校验（plan 的第二道闸，与 main 的 trustedAssetsOf 互为双保险）──────

describe('planKindMigration 的库界校验：库外记录一律不碰', () => {
  it('folder 在库根之外 → 不进计划（即使判据为真）', () => {
    const a = asset({
      name: '库外资产',
      // 判据需要的一切都成立，唯独路径不在库里
      folder: 'C:\\Windows\\System32\\drivers',
      relFolder: '模型/装修图/平面图/库外资产'
    })
    expect(shouldMigrateKind(a)).toBe(true) // 判据本身为真
    expect(planKindMigration([a], 'E:\\Lib').items).toHaveLength(0)
  })

  it('folder 恰为库根本身 → 仍能被计划（边界语义没写反；搬移会在 apply 失败）', () => {
    // 库根自身不可能是资产目录，这条只确认 `isWithinRoot` 把 root 视为"在库内"，
    // 计划阶段不因边界语义误杀（真正的失败会落在 apply 的源目录预检上）。
    const a = asset({ name: '边界', folder: 'E:\\Lib', relFolder: '模型/装修图/平面图/边界' })
    expect(planKindMigration([a], 'E:\\Lib').items).toHaveLength(1)
  })
})

// ── ⑦ 快照保留份数 ────────────────────────────────────────────────────

describe(`快照保留：只留最近 ${SNAPSHOT_KEEP} 份（用户会反复点按钮）`, () => {
  it('不足 5 份时不删任何东西', async () => {
    const lib = await tmpDir()
    const snapDir = await tmpDir()
    const a = inLib(asset({ name: '少量图', relFolder: '模型/装修图/平面图/少量图' }), lib)
    await materialize(lib, a)
    await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib, snapshotDir: snapDir })
    expect((await fs.readdir(snapDir)).filter((n) => n.startsWith(SNAPSHOT_PREFIX))).toHaveLength(1)
  })

  it('★只删自己前缀的文件，绝不碰 userData 里的其它东西', async () => {
    const lib = await tmpDir()
    const snapDir = await tmpDir()
    // 造 5 个**无关**文件 + 6 个旧快照，跑一次迁移后无关文件必须一个不少
    const strangers = ['settings.json', 'logs.txt', 'thumbs', 'hdr-cache', 'index.json']
    for (const s of strangers) await fs.writeFile(path.join(snapDir, s), 'keep')
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(
        path.join(snapDir, `${SNAPSHOT_PREFIX}2020-01-0${i + 1}T00-00-00-000Z.json`),
        '{}'
      )
    }
    const a = inLib(asset({ name: '前缀图', relFolder: '模型/装修图/平面图/前缀图' }), lib)
    await materialize(lib, a)
    await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib, snapshotDir: snapDir })

    const left = await fs.readdir(snapDir)
    for (const s of strangers) expect(left, s).toContain(s)
    expect(left.filter((n) => n.startsWith(SNAPSHOT_PREFIX))).toHaveLength(SNAPSHOT_KEEP)
  })

  it('★保留的是**最新**的 5 份（按文件名 ISO 时间戳字典序）', async () => {
    const lib = await tmpDir()
    const snapDir = await tmpDir()
    // 先造 6 份 2020 年的旧快照，再跑一次真实迁移（生成 1 份"现在"的）
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(
        path.join(snapDir, `${SNAPSHOT_PREFIX}2020-01-0${i + 1}T00-00-00-000Z.json`),
        '{}'
      )
    }
    const a = inLib(asset({ name: '新旧图', relFolder: '模型/装修图/平面图/新旧图' }), lib)
    await materialize(lib, a)
    await applyKindMigration(planKindMigration([a], lib), { libraryDir: lib, snapshotDir: snapDir })

    const left = (await fs.readdir(snapDir))
      .filter((n) => n.startsWith(SNAPSHOT_PREFIX))
      .sort()
    expect(left).toHaveLength(SNAPSHOT_KEEP)
    // 6 份旧 + 1 份新的 = 7，保留最新 5 份 → 最旧的两份（01-01 / 01-02）被删
    expect(left).not.toContain(`${SNAPSHOT_PREFIX}2020-01-01T00-00-00-000Z.json`)
    expect(left).not.toContain(`${SNAPSHOT_PREFIX}2020-01-02T00-00-00-000Z.json`)
    // 第三旧的开始留下
    expect(left).toContain(`${SNAPSHOT_PREFIX}2020-01-03T00-00-00-000Z.json`)
    expect(left).toContain(`${SNAPSHOT_PREFIX}2020-01-06T00-00-00-000Z.json`)
    // 最新一份（今天的）在末尾
    expect(left[left.length - 1]).not.toContain('2020-')
  })
})

// ── ⑧ 判据的非对称性（主理人 2026-10-30 指出的报告描述错误）─────────────────

describe('★判据非对称：hasCad 只看扩展名、hasModel 才看 f.kind', () => {
  it('dwg 但 f.kind 是 other → 仍进计划（扩展名是事实，f.kind 只是历史快照）', () => {
    // 这条钉住注释里写的"两者不对称"。若有人把 hasCad 改成也看 f.kind，
    // 老版本解析失败落成 `other` 的图纸就会漏迁 —— 正是本条要防的。
    const a = asset({ files: [file('a.dwg', 'dwg', 'other')] })
    expect(shouldMigrateKind(a)).toBe(true)
    expect(planKindMigration([a], 'E:\\Lib').items).toHaveLength(1)
  })

  it('dwg 但 f.kind 是 texture → 同样仍进计划（只看扩展名）', () => {
    const a = asset({ files: [file('a.dwg', 'dwg', 'texture')] })
    expect(shouldMigrateKind(a)).toBe(true)
  })

  it('反方向：非 CAD 扩展名但 f.kind 是 model → 算 hasModel，整包不迁', () => {
    // 与上面两条一起说明"不对称"是真的、且方向正确
    const a = asset({
      files: [file('a.dwg', 'dwg', 'model'), file('奇怪格式.zzz', 'zzz', 'model')]
    })
    expect(shouldMigrateKind(a)).toBe(false)
  })

  it('非 CAD 扩展名且 f.kind 是 other → 不算 hasModel（不阻止迁移）', () => {
    const a = asset({
      files: [file('a.dwg', 'dwg', 'model'), file('readme.md', 'md', 'other')]
    })
    expect(shouldMigrateKind(a)).toBe(true)
  })
})
