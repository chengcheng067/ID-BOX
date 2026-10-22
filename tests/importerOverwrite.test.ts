import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importPaths, DEFAULT_CONCURRENCY, type ImportDeps } from '../src/main/importer'
import { dedupeKeyOf } from '../src/shared/naming'
import type { Asset, ImportConflictResolution, ImportDedupeEntry, ImportEvent } from '../src/shared/types'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'

/**
 * docs/27 T-04：覆盖执行器 + 三档接线的**真实文件系统**测试。
 *
 * ⚠️ 一律 `os.tmpdir()`：绝不碰用户真实库（`E:/ModVault/Library`）。
 * 覆盖的三条判据（§6.1 T-04）：
 * ① 判定早于 `mkdir(cat2Dir)` —— 跳过时连分类目录都不该产生；
 * ② 跳过：`disposeArchive` 调用次数 = 0，staging 已清；
 * ③ 覆盖：同路径替换成功 → 旧目录进回收站 / id、name 不变 / 元数据继承；
 * ④ 旧目录不存在 / kind 变化 → 退化分支（done + 明确文案 + 沿用旧 id）；
 * ⑤ 保留两者：得到 `X` 与 `X-2`。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-ow-'))
  tmpRoots.push(d)
  return d
}

function archive(entries: string[]): Buffer {
  const specs = entries.map((rel) =>
    rel.endsWith('/')
      ? zipDir(rel.slice(0, -1))
      : zipEntry(rel, rel.endsWith('.skp') ? skpContent() : Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  )
  return buildZip(specs)
}

/** 一个「库内已有」的判重条目（模拟渲染层快照） */
function entryOf(asset: Asset, over: Partial<ImportDedupeEntry> = {}): ImportDedupeEntry {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    dedupeKey: asset.dedupeKey,
    zhimoId: asset.zhimoId ?? undefined,
    folder: asset.folder,
    relFolder: asset.relFolder,
    size: asset.size,
    importedAt: asset.importedAt,
    meta: {
      favorite: false,
      rating: 0,
      colorTag: null,
      tags: [],
      styles: [],
      note: '',
      category1: asset.category1 ?? '未分类',
      category2: asset.category2 ?? '未分类'
    },
    ...over
  }
}

interface Harness {
  deps: ImportDeps
  events: ImportEvent[]
  disposeCalls: string[]
  trashed: Array<{ dir: string; entries: string[] }>
}

function makeDeps(
  libraryDir: string,
  opts: {
    conflictContext?: ImportDeps['conflictContext']
    resolution?: ImportConflictResolution
    trashFails?: boolean
  } = {}
): Harness {
  const events: ImportEvent[] = []
  const disposeCalls: string[] = []
  const trashed: Array<{ dir: string; entries: string[] }> = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'delete', // 故意用最激进的档：跳过分支必须**视同 keep**（原包不动）
    defaultSource: '知末网',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async () => null,
    disposeArchive: async (src) => {
      disposeCalls.push(src)
    },
    conflictContext: opts.conflictContext,
    askConflict: opts.resolution ? async () => opts.resolution! : undefined,
    // 假的「系统回收站」：记录被回收的目录内容后真的删掉（真机上由 shell.trashItem 完成）
    trashFolder: async (dir) => {
      const entries = await fs.readdir(dir).catch(() => [] as string[])
      if (opts.trashFails) throw new Error('EBUSY: 文件被占用')
      trashed.push({ dir, entries })
      await fs.rm(dir, { recursive: true, force: true })
    },
    emit: (ev) => {
      events.push(ev)
    }
  }
  return { deps, events, disposeCalls, trashed }
}

/** 写一个「单顶层目录 + 一个 skp」的压缩包，返回源路径 */
async function writeZip(root: string, name: string, dirName: string, skpName: string): Promise<string> {
  const src = path.join(root, name)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(src, archive([`${dirName}/`, `${dirName}/${skpName}`]))
  return src
}

async function importOnce(src: string, deps: ImportDeps): Promise<Asset[]> {
  return importPaths([src], deps)
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe('T-04 ③ 覆盖：同路径替换 + 元数据继承 + 旧目录进回收站', () => {
  it('替换成功后 id/name/路径不变，元数据 100% 继承，旧内容被回收', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    // 第一次导入（无 ctx = 旧行为）
    const src1 = await writeZip(path.join(root, 'a'), '椅子.zip', '椅子', '椅子.skp')
    const first = await importOnce(src1, makeDeps(lib).deps)
    expect(first).toHaveLength(1)
    const old = first[0]!

    // 用户先给它加了一堆元数据（收藏 / 评分 / 色标 / 标签 / 风格 / 备注）
    const entry = entryOf(old, {
      meta: {
        favorite: true,
        rating: 5,
        colorTag: 'red',
        tags: ['心水', '待整理'],
        styles: ['北欧'],
        note: '这套是客户指定的',
        category1: old.category1 ?? '未分类',
        category2: old.category2 ?? '未分类'
      }
    })

    // 第二次导入同名包，但内容换了一个文件（证明「只换内容」确实生效）
    const src2 = await writeZip(path.join(root, 'b'), '椅子.zip', '椅子', '椅子-新版.skp')
    const h = makeDeps(lib, { conflictContext: { index: [entry] }, resolution: 'overwrite' })
    const second = await importOnce(src2, h.deps)

    expect(second).toHaveLength(1)
    const next = second[0]!

    // ── 身份与位置：原位替换（D10）──
    expect(next.id).toBe(old.id)
    expect(next.name).toBe(old.name)
    expect(next.folder).toBe(old.folder)
    expect(next.relFolder).toBe(old.relFolder)
    expect(next.kind).toBe(old.kind)

    // ── 元数据 100% 继承（D12）──
    expect(next.favorite).toBe(true)
    expect(next.rating).toBe(5)
    expect(next.colorTag).toBe('red')
    expect(next.tags).toEqual(['心水', '待整理'])
    expect(next.styles).toEqual(['北欧'])
    expect(next.note).toBe('这套是客户指定的')
    expect(next.category1).toBe(entry.meta.category1)
    expect(next.category2).toBe(entry.meta.category2)

    // ── 内容派生字段跟着新内容走 ──
    expect(next.files.map((f) => f.name)).toContain('椅子-新版.skp')
    expect(next.files.map((f) => f.name)).not.toContain('椅子.skp')
    // 时间戳：覆盖后这份就是"当前的"（不沿用旧值）
    expect(next.importedAt).toBeGreaterThanOrEqual(old.importedAt)
    expect(next.updatedAt).toBeGreaterThanOrEqual(next.importedAt)
    expect(next.dedupeKey).toBe(dedupeKeyOf(entry.name, next.kind))

    // ── 旧内容真的进了回收站，且回收时里面还是旧文件 ──
    expect(h.trashed).toHaveLength(1)
    expect(path.basename(h.trashed[0]!.dir).startsWith('.idbox-old-')).toBe(true)
    expect(h.trashed[0]!.entries).toContain('椅子.skp')
    expect(existsSync(h.trashed[0]!.dir)).toBe(false)

    // ── 新内容在原位，磁盘上不留 .idbox-old-* 残留 ──
    const onDisk = await fs.readdir(old.folder)
    expect(onDisk).toContain('椅子-新版.skp')
    expect(onDisk).not.toContain('椅子.skp')
    const siblings = await fs.readdir(path.dirname(old.folder))
    expect(siblings.filter((n) => n.startsWith('.idbox-old-'))).toEqual([])

    // ── 事件：done + conflict.resolution='overwrite' ──
    const done = h.events.filter((e) => e.status === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]!.conflict).toEqual({
      reason: 'same-name',
      resolution: 'overwrite',
      existingName: old.name
    })
    // 正常原位替换（旧版确实进了回收站）→ **不带** degraded（渲染层据此才敢说"旧版在回收站"）
    expect(done[0]!.conflict?.degraded).toBeUndefined()
    // 原包按 archiveDisposal 正常处置（覆盖是"导入成功"，与跳过相反）
    expect(h.disposeCalls).toEqual([src2])
  })

  it('旧版本无法进回收站 → 不回滚、不 fs.rm，保留 .idbox-old-* 并如实上报', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '柜子.zip', '柜子', '柜子.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!
    const entry = entryOf(old)

    const src2 = await writeZip(path.join(root, 'b'), '柜子.zip', '柜子', '柜子-v2.skp')
    const h = makeDeps(lib, {
      conflictContext: { index: [entry] },
      resolution: 'overwrite',
      trashFails: true
    })
    const next = (await importOnce(src2, h.deps))[0]!

    // 数据正确：新内容已就位，记录仍指向存在的目录（D13 的硬不变量）
    expect(next.folder).toBe(old.folder)
    expect(await fs.readdir(next.folder)).toContain('柜子-v2.skp')

    // 旧目录没被删掉（绝不 fs.rm 兜底），而是作为 .idbox-old-* 留在同目录
    const siblings = await fs.readdir(path.dirname(old.folder))
    const leftovers = siblings.filter((n) => n.startsWith('.idbox-old-'))
    expect(leftovers).toHaveLength(1)
    expect(await fs.readdir(path.join(path.dirname(old.folder), leftovers[0]!))).toContain('柜子.skp')

    // 必须显式告诉用户，不能静默
    const done = h.events.filter((e) => e.status === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]!.message).toContain('未能移入回收站')
    expect(done[0]!.message).toContain('.idbox-old-')
    // 结构化标记：旧版**没进**回收站，渲染层绝不能对用户说"旧版在回收站"
    expect(done[0]!.conflict?.degraded).toBe(true)
  })
})

describe('T-04 ② 跳过：零落盘、原包绝不处置', () => {
  it('disposeArchive 调用 0 次、不产生新目录、staging 已清、事件为 skipped', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '凳子.zip', '凳子', '凳子.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!
    const entry = entryOf(old)
    const before = await fs.readdir(old.folder)

    const src2 = await writeZip(path.join(root, 'b'), '凳子.zip', '凳子', '凳子.skp')
    const h = makeDeps(lib, { conflictContext: { index: [entry] }, resolution: 'skip' })
    const result = await importOnce(src2, h.deps)

    expect(result).toEqual([])
    // ① 原包绝不处置：哪怕 archiveDisposal='delete'（D09 硬约束）
    expect(h.disposeCalls).toEqual([])
    expect(existsSync(src2)).toBe(true)
    // ② 不产生 Asset、库内目录内容一字未变
    expect(await fs.readdir(old.folder)).toEqual(before)
    // ③ staging 已清（finally 里的清理）
    expect(existsSync(path.join(lib, '.staging'))).toBe(false)
    // ④ 上报：skipped + conflict
    const skipped = h.events.filter((e) => e.status === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.message).toContain('已跳过重复素材')
    expect(skipped[0]!.conflict).toEqual({
      reason: 'same-name',
      resolution: 'skip',
      existingName: old.name
    })
    expect(skipped[0]!.asset).toBeUndefined()
    // 等待期间的状态：复用 organizing + message（§2.3，不新增"等待中"状态）
    expect(
      h.events.some((e) => e.status === 'organizing' && e.message?.includes('等待你的选择'))
    ).toBe(true)
  })

  it('判定早于任何 mkdir：库里还没这个分类目录时，跳过连空目录都不建（§6.1 ①）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    // 快照里的那条记录在磁盘上并不存在（用户手工删了目录）—— 但只要判重命中就仍然要问
    const phantom: ImportDedupeEntry = {
      id: 'phantom-id',
      name: '椅子',
      kind: 'model',
      dedupeKey: dedupeKeyOf('椅子', 'model'),
      folder: path.join(lib, '模型', '未分类', '未分类', '椅子'),
      relFolder: '模型/未分类/未分类/椅子',
      size: 1000,
      importedAt: 1,
      meta: {
        favorite: false,
        rating: 0,
        colorTag: null,
        tags: [],
        styles: [],
        note: '',
        category1: '未分类',
        category2: '未分类'
      }
    }

    const src = await writeZip(path.join(root, 'a'), '椅子.zip', '椅子', '椅子.skp')
    const h = makeDeps(lib, { conflictContext: { index: [phantom] }, resolution: 'skip' })
    await importOnce(src, h.deps)

    // 库根下连「模型」大类目录都没被建出来
    expect(await fs.readdir(lib)).toEqual([])
  })
})

describe('T-04 ⑤ 保留两者：现状行为（uniqueName 加 -2）', () => {
  it('得到 X 与 X-2 两条，库内目录都在', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '椅子.zip', '椅子', '椅子.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!

    const src2 = await writeZip(path.join(root, 'b'), '椅子.zip', '椅子', '椅子.skp')
    const h = makeDeps(lib, {
      conflictContext: { index: [entryOf(old)] },
      resolution: 'keep-both'
    })
    const second = await importOnce(src2, h.deps)

    expect(second).toHaveLength(1)
    const next = second[0]!
    expect(next.id).not.toBe(old.id)
    expect(next.name).toBe(`${old.name}-2`)
    expect(next.dedupeKey).toBe(old.dedupeKey) // 键仍用 uniqueName 之前的原始名
    expect(existsSync(old.folder)).toBe(true)
    expect(existsSync(next.folder)).toBe(true)
    // 新记录是干净的默认元数据（不继承旧记录）
    expect(next.favorite).toBe(false)
    // 原包按 archiveDisposal 处置
    expect(h.disposeCalls).toEqual([src2])
    expect(h.events.filter((e) => e.status === 'done')[0]!.conflict).toEqual({
      reason: 'same-name',
      resolution: 'keep-both',
      existingName: old.name
    })
    expect(h.events.filter((e) => e.status === 'done')[0]!.conflict?.degraded).toBeUndefined()
  })
})

describe('T-04 §5.1 批内名字台账：并发同名包不再互踩', () => {
  it('并发 3 个同名包 → X / X-2 / X-3，全部成功、无 error 事件', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const srcs: string[] = []
    for (const tag of ['a', 'b', 'c']) {
      srcs.push(await writeZip(path.join(root, tag), '椅子.zip', '椅子', `${tag}.skp`))
    }
    const h = makeDeps(lib)
    h.deps.concurrency = 3
    const assets = await importPaths(srcs, h.deps)

    // 旧实现：三个 worker 同时读到"目录里没有 椅子"，都算出 椅子 → 两个 moveDir 撞非空目录报错
    expect(h.events.filter((e) => e.status === 'error')).toEqual([])
    expect(assets).toHaveLength(3)
    expect(assets.map((a) => a.name).sort()).toEqual(['椅子', '椅子-2', '椅子-3'])
    for (const a of assets) expect(existsSync(a.folder)).toBe(true)
  })
})

describe('T-04 ④ 退化分支：不满足原位替换的前提', () => {
  it('旧目录已不存在 → 按新素材落盘 + 沿用旧 id + done 带明确文案', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '沙发.zip', '沙发', '沙发.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!
    // 用户手工把目录删了
    await fs.rm(old.folder, { recursive: true, force: true })

    const src2 = await writeZip(path.join(root, 'b'), '沙发.zip', '沙发', '沙发.skp')
    const h = makeDeps(lib, {
      conflictContext: { index: [entryOf(old)] },
      resolution: 'overwrite'
    })
    const next = (await importOnce(src2, h.deps))[0]!

    expect(next.id).toBe(old.id) // 覆盖那条陈旧记录，而不是新增一行
    expect(existsSync(next.folder)).toBe(true)
    expect(await fs.readdir(next.folder)).toContain('沙发.skp')
    const done = h.events.filter((e) => e.status === 'done')
    expect(done[0]!.message).toBe('已覆盖（原目录已不存在，按新素材落盘）')
    expect(done[0]!.conflict?.resolution).toBe('overwrite')
    expect(done[0]!.conflict?.degraded).toBe(true)
  })

  it('快照 folder 在库外（脏数据）→ 退化，绝不对库外路径动手', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '茶几.zip', '茶几', '茶几.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!

    // 库外的同名目录 + 一个「不该被碰」的标记文件
    const outside = path.join(root, 'outside', '茶几')
    await fs.mkdir(outside, { recursive: true })
    const marker = path.join(outside, '别动我.txt')
    await fs.writeFile(marker, 'user data')

    const dirty = entryOf(old, { folder: outside, relFolder: '模型/未分类/未分类/茶几' })
    const src2 = await writeZip(path.join(root, 'b'), '茶几.zip', '茶几', '茶几.skp')
    const warns: string[] = []
    const h = makeDeps(lib, {
      conflictContext: { index: [dirty] },
      resolution: 'overwrite'
    })
    h.deps.warn = (event) => {
      warns.push(event)
    }
    const next = (await importOnce(src2, h.deps))[0]!

    // 库外目录一个字节都没动，也没有被"回收"
    expect(existsSync(marker)).toBe(true)
    expect(await fs.readFile(marker, 'utf-8')).toBe('user data')
    expect(h.trashed).toEqual([])
    // 落盘走新路径，但沿用旧 id
    expect(next.id).toBe(old.id)
    expect(next.folder).not.toBe(outside)
    expect(warns).toContain('import:conflict:folder-outside')
  })

  it('kind 变了 → 退化（四层路径的顶层大类必然变，不能原位替换）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    // 用知末 ID 命中（同名不同 kind 的 dedupeKey 天然不等，只有 zhimoId 能把两者挂上）
    const src1 = await writeZip(path.join(root, 'a'), '木纹ID_1234567890.zip', '木纹', '木纹.skp')
    const old = (await importOnce(src1, makeDeps(lib).deps))[0]!
    expect(old.zhimoId).toBe('1234567890')
    // 人为把快照里的 kind 改成 texture（模拟"库里那条是贴图，新包是模型"）
    const wrongKind = entryOf(old, { kind: 'texture' })

    const src2 = await writeZip(path.join(root, 'b'), '木纹ID_1234567890.zip', '木纹', '木纹.skp')
    const h = makeDeps(lib, {
      conflictContext: { index: [wrongKind] },
      resolution: 'overwrite'
    })
    const next = (await importOnce(src2, h.deps))[0]!

    // kind 变了 → 新目录、但沿用旧 id
    expect(next.kind).toBe('model')
    expect(next.id).toBe(old.id)
    expect(next.folder).not.toBe(old.folder)
    expect(h.events.filter((e) => e.status === 'done')[0]!.message).toBe(
      '已覆盖（原目录已不存在，按新素材落盘）'
    )
  })
})

describe('T-04 单图 / HDR 覆盖（§5.2：口径与压缩包完全一致）', () => {
  it('同名图片覆盖：目录不变、文件换成新的、旧图进回收站', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const dir1 = path.join(root, 'p1')
    await fs.mkdir(dir1, { recursive: true })
    const img1 = path.join(dir1, '木纹.jpg')
    await fs.writeFile(img1, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))

    const old = (await importOnce(img1, makeDeps(lib).deps))[0]!
    expect(old.kind).toBe('texture')

    const dir2 = path.join(root, 'p2')
    await fs.mkdir(dir2, { recursive: true })
    const img2 = path.join(dir2, '木纹.jpg')
    const newBytes = Buffer.from([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9])
    await fs.writeFile(img2, newBytes)

    const h = makeDeps(lib, {
      conflictContext: { index: [entryOf(old)] },
      resolution: 'overwrite'
    })
    const next = (await importOnce(img2, h.deps))[0]!

    expect(next.id).toBe(old.id)
    expect(next.name).toBe(old.name)
    expect(next.folder).toBe(old.folder)
    // 内容换成新图（同文件名）
    expect(await fs.readFile(path.join(next.folder, '木纹.jpg'))).toEqual(newBytes)
    expect(next.files.map((f) => f.name)).toEqual(['木纹.jpg'])
    // 旧图确实被回收
    expect(h.trashed).toHaveLength(1)
    expect(h.trashed[0]!.entries).toContain('木纹.jpg')
    expect(h.events.filter((e) => e.status === 'done')[0]!.conflict?.resolution).toBe('overwrite')
    // 源文件按 archiveDisposal 处置（这里注入的 stub 只记录）
    expect(h.disposeCalls).toEqual([img2])
  })

  it('同名图片跳过：源图绝不处置，库内文件字节不变', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const dir1 = path.join(root, 'p1')
    await fs.mkdir(dir1, { recursive: true })
    const img1 = path.join(dir1, '石纹.png')
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])
    await fs.writeFile(img1, original)
    const old = (await importOnce(img1, makeDeps(lib).deps))[0]!

    const dir2 = path.join(root, 'p2')
    await fs.mkdir(dir2, { recursive: true })
    const img2 = path.join(dir2, '石纹.png')
    await fs.writeFile(img2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 2, 2]))

    const h = makeDeps(lib, { conflictContext: { index: [entryOf(old)] }, resolution: 'skip' })
    const result = await importOnce(img2, h.deps)

    expect(result).toEqual([])
    expect(h.disposeCalls).toEqual([])
    expect(existsSync(img2)).toBe(true)
    expect(await fs.readFile(path.join(old.folder, '石纹.png'))).toEqual(original)
    expect(h.events.filter((e) => e.status === 'skipped')).toHaveLength(1)
  })
})

describe('T-04 向后兼容（D21）：不传 ctx 时与 0.6.9 一致', () => {
  it('没 ctx → 不判重、不询问，同名包静默得到 -2', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const ask = vi.fn(async () => 'skip' as ImportConflictResolution)
    const src1 = await writeZip(path.join(root, 'a'), '灯.zip', '灯', '灯.skp')
    const first = await importOnce(src1, makeDeps(lib).deps)
    const src2 = await writeZip(path.join(root, 'b'), '灯.zip', '灯', '灯.skp')
    const h = makeDeps(lib)
    h.deps.askConflict = ask
    const second = await importOnce(src2, h.deps)

    expect(ask).not.toHaveBeenCalled()
    expect(first[0]!.name).toBe('灯')
    expect(second[0]!.name).toBe('灯-2')
    expect(h.events.every((e) => e.status !== 'skipped')).toBe(true)
  })
})
