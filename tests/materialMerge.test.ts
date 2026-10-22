/**
 * 材质大类合并 · 迁移引擎单测（T-03，docs/14 §2.3 / §8）。
 *
 * 全部在 `os.tmpdir()` 造库，**绝不触碰 `E:/ModVault/Library`**。
 * 覆盖：搬移 + DB 字段凭据 / 重名 -2 / 幂等 / manifest 先写后动 / 回滚 /
 * 只动两个源目录 / manifest 保留 5 份 / 空库 / >50 阈值 / 3 段结构跳过。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MANIFEST_DIR_REL,
  MANIFEST_KEEP,
  MATERIAL_MERGE_LIMIT,
  applyMaterialMerge,
  detectMaterialMerge,
  manifestDirOf,
  mergeMaterial,
  planMaterialMerge,
  rollbackMaterialMerge
} from '../src/main/materialMerge'
import { rescanLibrary } from '../src/main/rescan'
import type { MergeMaterialAssetRef } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-merge-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

/** 造文件（自动建父链） */
async function putFile(root: string, rel: string, content = 'x'): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  return abs
}

/** 路径是否存在（测试断言用，避免到处 try/catch） */
async function has(root: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

/**
 * 目录树快照：相对 posix 路径数组（目录带尾 `/`），排序后可直接深比较。
 *
 * `skipDot`：跳过 `.` 开头的顶层目录（`.idbox` 迁移记录）——回滚后 manifest 必须留，
 * 但资产目录树要与迁移前逐项一致，所以比对资产树时必须排除记录目录。
 */
async function tree(root: string, opts?: { skipDot?: boolean }): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (depth === 0 && opts?.skipDot && e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (e.isDirectory()) {
        out.push(`${rel}/`)
        await walk(abs, depth + 1)
      } else {
        out.push(rel)
      }
    }
  }
  await walk(root, 0)
  return out.sort()
}

/** manifest 目录下的 json 文件名（升序 = 时间序） */
async function manifestNames(lib: string): Promise<string[]> {
  try {
    return (await fs.readdir(manifestDirOf(lib))).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** 造一个标准四层资产（`<源>/<一级>/<二级>/<资产名>/<文件>`） */
async function makeAsset(lib: string, source: string, cat1: string, cat2: string, name: string): Promise<void> {
  await putFile(lib, `${source}/${cat1}/${cat2}/${name}/payload.png`, `${source}-${name}`)
}

describe('materialMerge —— plan（只读）', () => {
  it('① 基本搬移：两个源 → 材质/，kind 各归其位，回传 assetId/旧 relFolder', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', '石材', '水磨石', '木纹01')
    await makeAsset(lib, '材质预设', '未分类', '未分类', '某材质')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves).toHaveLength(2)
    expect(plan.moves.map((m) => m.relFolderTo)).toEqual([
      '材质/石材/水磨石/木纹01',
      '材质/未分类/未分类/某材质'
    ])
    expect(plan.moves.map((m) => m.kind)).toEqual(['texture', 'material'])
    expect(plan.moves.every((m) => m.renamed === false)).toBe(true)
    expect(plan.skipped).toEqual([])

    const refs: MergeMaterialAssetRef[] = plan.moves.map((m, i) => ({
      id: `asset-${i}`,
      folder: m.from,
      relFolder: m.relFolderFrom
    }))
    const result = await applyMaterialMerge(plan, { assetRefs: refs })

    expect(result.moved).toBe(2)
    expect(result.count).toBe(2)
    expect(result.needsManual).toBe(false)
    expect(result.manifestPath).toBeTruthy()

    // DB 侧凭据：渲染层按 assetId put，prevRelFolder 供回滚写回
    expect(result.moves.map((m) => m.assetId)).toEqual(['asset-0', 'asset-1'])
    expect(result.moves.map((m) => m.prevRelFolder)).toEqual([
      '贴图/石材/水磨石/木纹01',
      '材质预设/未分类/未分类/某材质'
    ])

    // 磁盘：目标在、源空壳已消失
    expect(await has(lib, '材质/石材/水磨石/木纹01/payload.png')).toBe(true)
    expect(await has(lib, '材质/未分类/未分类/某材质/payload.png')).toBe(true)
    expect(await has(lib, '贴图')).toBe(false)
    expect(await has(lib, '材质预设')).toBe(false)

    // manifest 落在 .idbox/merge-material/，内容可回滚
    expect(path.relative(path.resolve(lib), result.manifestPath!).split(path.sep).join('/')).toMatch(
      new RegExp(`^${MANIFEST_DIR_REL.split(path.sep).join('/')}/.+\\.json$`)
    )
    const manifest = JSON.parse(await fs.readFile(result.manifestPath!, 'utf-8'))
    expect(manifest.version).toBe(1)
    expect(manifest.status).toBe('completed')
    expect(manifest.summary).toEqual({ total: 2, moved: 2, failed: 0, renamed: 0 })
    expect(manifest.items.map((i: { status: string }) => i.status)).toEqual(['moved', 'moved'])
  })

  it('② 目标已存在同名资产 → -2 后缀，原目标文件不丢（绝不覆盖）', async () => {
    const lib = await tmpDir()
    await putFile(lib, '材质/未分类/未分类/同名/keep.txt', 'KEEP')
    await makeAsset(lib, '贴图', '未分类', '未分类', '同名')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]!.renamed).toBe(true)
    expect(path.basename(plan.moves[0]!.to)).toBe('同名-2')
    expect(plan.moves[0]!.relFolderTo).toBe('材质/未分类/未分类/同名-2')

    const result = await applyMaterialMerge(plan)
    expect(result.moved).toBe(1)
    expect(result.renamed).toBe(1)

    // 原有资产原封不动
    expect(await fs.readFile(path.join(lib, '材质/未分类/未分类/同名/keep.txt'), 'utf-8')).toBe('KEEP')
    // 搬来的资产进 -2
    expect(await has(lib, '材质/未分类/未分类/同名-2/payload.png')).toBe(true)
    expect(await has(lib, '贴图/未分类/未分类/同名')).toBe(false)
  })

  it('②-b 同批两个源各有一个同名同分类资产 → 第二个 -2（计划期就模拟占位）', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', '未分类', '未分类', '同名')
    await makeAsset(lib, '材质预设', '未分类', '未分类', '同名')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves.map((m) => path.basename(m.to))).toEqual(['同名', '同名-2'])
    expect(plan.moves.map((m) => m.renamed)).toEqual([false, true])

    const result = await mergeMaterial(lib)
    expect(result.moved).toBe(2)
    expect(await has(lib, '材质/未分类/未分类/同名/payload.png')).toBe(true)
    expect(await has(lib, '材质/未分类/未分类/同名-2/payload.png')).toBe(true)
  })

  it('③ 幂等：连跑两次计划深相等；搬完再跑 moves=0 且不再造 -3/-4', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', '石材', '水磨石', '木纹01')
    await makeAsset(lib, '材质预设', '未分类', '未分类', '某材质')

    const p1 = await planMaterialMerge(lib)
    const p2 = await planMaterialMerge(lib)
    expect(p2).toEqual(p1)

    await mergeMaterial(lib)

    const p3 = await planMaterialMerge(lib)
    expect(p3.moves).toEqual([])
    expect(p3.sources.map((s) => s.exists)).toEqual([false, false])

    const again = await mergeMaterial(lib)
    expect(again.moved).toBe(0)
    expect(again.manifestPath).toBeNull()

    const names = await fs.readdir(path.join(lib, '材质/未分类/未分类'))
    expect(names.filter((n) => /同名-\d|某材质-\d/.test(n))).toEqual([])
  })

  it('⑧ 空库 / 无待迁移目录 → 0 move，且不建任何目录（连 .idbox 都不建）', async () => {
    const lib = await tmpDir()
    const plan = await planMaterialMerge(lib)
    expect(plan.moves).toEqual([])
    expect(plan.sources.every((s) => s.exists === false)).toBe(true)

    const detect = await detectMaterialMerge(lib)
    expect(detect).toEqual({
      needMerge: false,
      count: 0,
      sources: plan.sources
    })

    const result = await mergeMaterial(lib)
    expect(result).toMatchObject({ moved: 0, count: 0, manifestPath: null, needsManual: false })
    expect(await has(lib, '.idbox')).toBe(false)
  })

  it('⑩ 3 段草稿布局（<源>/<一级>/<资产名>/…）→ 跳过并上报 depth，不误搬', async () => {
    const lib = await tmpDir()
    await putFile(lib, '贴图/布纹/某贴图包/f.jpg', 'F')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves).toEqual([])
    expect(plan.skipped).toContainEqual({ relPath: '贴图/布纹/某贴图包', reason: 'depth' })

    const detect = await detectMaterialMerge(lib)
    expect(detect.needMerge).toBe(false)

    // 没有可搬项 → 不动盘、不写 manifest
    const result = await mergeMaterial(lib)
    expect(result.moved).toBe(0)
    expect(result.manifestPath).toBeNull()
    expect(await has(lib, '贴图/布纹/某贴图包/f.jpg')).toBe(true)
  })
})

describe('materialMerge —— apply（manifest / 失败 / 阈值）', () => {
  it('④ manifest 先写后动：中途一项失败，manifest 里已有已完成项的状态', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', 'AAA', '未分类', 'A')
    await makeAsset(lib, '贴图', 'BBB', '未分类', 'B')
    // 让 BBB 的目标父链被一个**文件**挡住：mkdir(材质/BBB/未分类) 必失败（ENOTDIR）
    await putFile(lib, '材质/BBB', 'BLOCKER')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves.map((m) => m.relFolderFrom)).toEqual([
      '贴图/AAA/未分类/A',
      '贴图/BBB/未分类/B'
    ])

    const result = await applyMaterialMerge(plan)
    expect(result.moved).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.from).toContain('BBB')
    expect(result.manifestPath).toBeTruthy()

    const manifest = JSON.parse(await fs.readFile(result.manifestPath!, 'utf-8'))
    expect(manifest.status).toBe('partial')
    expect(manifest.items[0].status).toBe('moved') // 先完成的项已落状态（逐项原子重写）
    expect(manifest.items[1].status).toBe('failed')
    expect(manifest.items[1].error).toBeTruthy()
    expect(manifest.summary).toMatchObject({ total: 2, moved: 1, failed: 1 })

    // 失败项原样留在源里（下次启动重试），挡路的文件不被动
    expect(await has(lib, '贴图/BBB/未分类/B/payload.png')).toBe(true)
    expect(await fs.readFile(path.join(lib, '材质/BBB'), 'utf-8')).toBe('BLOCKER')
  })

  it('⑤ rollback：逆序搬回 + 目录树逐项回到迁移前 + 回传 DB 恢复凭据', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', '石材', '水磨石', '木纹01')
    await makeAsset(lib, '材质预设', '未分类', '未分类', '某材质')
    await putFile(lib, '模型/家具/沙发/沙发.skp', 'SKP')

    const before = await tree(lib, { skipDot: true })

    const plan = await planMaterialMerge(lib)
    const refs = plan.moves.map((m, i) => ({ id: `id-${i}`, folder: m.from, relFolder: m.relFolderFrom }))
    const applied = await applyMaterialMerge(plan, { assetRefs: refs })
    expect(applied.moved).toBe(2)
    expect(await tree(lib, { skipDot: true })).not.toEqual(before)

    const rolled = await rollbackMaterialMerge(applied.manifestPath!)
    expect(rolled.restoredCount).toBe(2)
    expect(rolled.failures).toEqual([])
    // 逆序：最后搬的先回
    expect(rolled.restored.map((m) => m.relFolderFrom)).toEqual([
      '材质预设/未分类/未分类/某材质',
      '贴图/石材/水磨石/木纹01'
    ])
    expect(rolled.restored.map((m) => m.assetId)).toEqual(['id-1', 'id-0'])
    expect(rolled.restored.map((m) => m.prevRelFolder)).toEqual([
      '材质预设/未分类/未分类/某材质',
      '贴图/石材/水磨石/木纹01'
    ])
    expect(await tree(lib, { skipDot: true })).toEqual(before)

    const manifest = JSON.parse(await fs.readFile(applied.manifestPath!, 'utf-8'))
    expect(manifest.status).toBe('rolledBack')
    expect(manifest.items.every((i: { status: string }) => i.status === 'rolledBack')).toBe(true)
  })

  it('⑥ 只搬 贴图/ 与 材质预设/，模型/ 与其它顶层目录完全不受影响', async () => {
    const lib = await tmpDir()
    await putFile(lib, '模型/家具/沙发/沙发.skp', 'SKP')
    await putFile(lib, 'HDRI/未分类/未分类/hdri01/a.hdr', 'HDR')
    await makeAsset(lib, '贴图', '石材', '水磨石', '木纹01')

    const plan = await planMaterialMerge(lib)
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves.every((m) => m.relFolderFrom.startsWith('贴图/') || m.relFolderFrom.startsWith('材质预设/'))).toBe(true)

    const result = await mergeMaterial(lib)
    expect(result.moved).toBe(1)
    expect(await has(lib, '模型/家具/沙发/沙发.skp')).toBe(true)
    expect(await has(lib, 'HDRI/未分类/未分类/hdri01/a.hdr')).toBe(true)
  })

  it('⑦ manifest 只保留最近 5 份（最新一份永不删）', async () => {
    const lib = await tmpDir()
    const paths: string[] = []

    // 每轮造一个新资产再迁移一次 → 每轮产出一份 manifest（幂等后不会产出空 manifest）
    for (let i = 0; i < MANIFEST_KEEP + 1; i++) {
      await putFile(lib, `贴图/未分类/未分类/资产${i}/f.png`, `F${i}`)
      const r = await mergeMaterial(lib)
      expect(r.moved).toBe(1)
      expect(r.manifestPath).toBeTruthy()
      paths.push(r.manifestPath!)
    }

    const names = await manifestNames(lib)
    expect(names).toHaveLength(MANIFEST_KEEP)
    // 最新一份在、最老一份被清掉
    expect(names).toContain(path.basename(paths[paths.length - 1]!))
    expect(names).not.toContain(path.basename(paths[0]!))
    expect(await has(lib, path.relative(path.resolve(lib), paths[0]!).split(path.sep).join('/'))).toBe(false)
  })

  it('⑨ 阈值：>50 条未 force → needsManual 且磁盘零改动；force 后才搬', async () => {
    const lib = await tmpDir()
    const total = MATERIAL_MERGE_LIMIT + 1
    for (let i = 0; i < total; i++) {
      await putFile(lib, `贴图/未分类/未分类/资产${String(i).padStart(2, '0')}/f.png`, `F${i}`)
    }

    const detect = await detectMaterialMerge(lib)
    expect(detect.needMerge).toBe(true)
    expect(detect.count).toBe(total)

    const auto = await mergeMaterial(lib)
    expect(auto.needsManual).toBe(true)
    expect(auto.count).toBe(total)
    expect(auto.moved).toBe(0)
    expect(auto.manifestPath).toBeNull()
    expect(await has(lib, '材质')).toBe(false)
    expect(await has(lib, `贴图/未分类/未分类/资产00/f.png`)).toBe(true)

    const forced = await mergeMaterial(lib, { force: true })
    expect(forced.needsManual).toBe(false)
    expect(forced.moved).toBe(total)
    expect(forced.moved + forced.failures.length).toBe(total)
    expect(await has(lib, '贴图')).toBe(false)
  })

  it('⑪ 迁移后 rescan：`.idbox` 不污染索引，`材质/` 下 kind 仍分别正确', async () => {
    const lib = await tmpDir()
    // 内容决定 kind：.png → texture；.vismat → material（合并目录后两者仍要分得清）
    await putFile(lib, '贴图/石材/水磨石/木纹01/a.png', 'A')
    await putFile(lib, '材质预设/未分类/未分类/某材质/b.vismat', 'B')

    const merged = await mergeMaterial(lib)
    expect(merged.moved).toBe(2)

    const { assets, ignored } = await rescanLibrary(lib)
    expect(ignored).toEqual([])
    expect(assets).toHaveLength(2)
    // kind 由内容决定，不因目录名合并而丢失
    expect(assets.map((a) => a.kind).sort()).toEqual(['material', 'texture'])
    // 迁移记录目录以 `.` 开头 → rescan 整目录跳过
    expect(assets.every((a) => a.relFolder.startsWith('材质/'))).toBe(true)
    expect(assets.some((a) => `${a.relFolder}${a.folder}`.includes('.idbox'))).toBe(false)
  })
})
