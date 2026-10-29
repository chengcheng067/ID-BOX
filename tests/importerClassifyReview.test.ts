import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { importPaths, DEFAULT_CONCURRENCY, type ImportDeps } from '../src/main/importer'
import { buildInitialClassifyReview, UNCLASSIFIED_CAT } from '../src/shared/classifyCrossCheck'
import { buildDedupeSnapshot } from '../src/renderer/logic/importConflict'
import type {
  Asset,
  ImportConflictResolution,
  ImportDedupeEntry,
  ImportEvent
} from '../src/shared/types'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'

/**
 * docs/35 T-06 + T-07：`Asset.classifyReview` 的**导入落库**与**覆盖继承**。
 *
 * T0（导入落盘）只有 S1 可用，站方信息要等批次结束（T1）才拿得到。所以这里只断言
 * 「留下痕迹」这一件事：
 * - S1 有值 → `{ confidence: 'medium-s1' }`
 * - S1 双未分类 → `{ confidence: 'none' }`，且**不写 `reason`**（`unclassified` 是派生值）
 *
 * ⚠️ 一律 `os.tmpdir()`：绝不碰用户真实库（`E:/ModVault/Library`）。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-cr-'))
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

interface Harness {
  deps: ImportDeps
  events: ImportEvent[]
}

function makeDeps(
  libraryDir: string,
  opts: { conflictContext?: ImportDeps['conflictContext']; resolution?: ImportConflictResolution } = {}
): Harness {
  const events: ImportEvent[] = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep',
    defaultSource: '知末网',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async () => null,
    disposeArchive: async () => {},
    conflictContext: opts.conflictContext,
    askConflict: opts.resolution ? async () => opts.resolution! : undefined,
    trashFolder: async (dir) => {
      await fs.rm(dir, { recursive: true, force: true })
    },
    emit: (ev) => {
      events.push(ev)
    }
  }
  return { deps, events }
}

/** 写一个「单顶层目录 + 一个 skp」的压缩包，返回源路径 */
async function writeZip(root: string, name: string, dirName: string, skpName: string): Promise<string> {
  const src = path.join(root, name)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(src, archive([`${dirName}/`, `${dirName}/${skpName}`]))
  return src
}

/** 判重快照条目（模拟渲染层 `buildDedupeSnapshot` 的产物） */
function entryOf(asset: Asset, metaOver: Partial<ImportDedupeEntry['meta']> = {}): ImportDedupeEntry {
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
      category1: asset.category1 ?? UNCLASSIFIED_CAT,
      category2: asset.category2 ?? UNCLASSIFIED_CAT,
      ...metaOver
    }
  }
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

// ── T-07 ① S1 有值 → medium-s1 ──────────────────────────────────────────

describe('T-07 ①：S1 命中词表 → classifyReview.confidence = medium-s1', () => {
  it('压缩包路径（资产名「椅子」→ 家具/椅子_凳子）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = await writeZip(root, '椅子.zip', '椅子', '椅子.skp')

    const assets = await importPaths([src], makeDeps(lib).deps)
    expect(assets).toHaveLength(1)
    const a = assets[0]!

    // 前提：S1 真的判出了分类（否则这条用例断言的是 none 分支）
    expect(a.category1).not.toBe(UNCLASSIFIED_CAT)
    // 落库的是**净化后的段**，与磁盘目录段逐字一致
    expect(a.classifyReview).toEqual({ confidence: 'medium-s1' })
    // 不存 sources.s1（可重算，会随词表升级腐坏）
    expect(a.classifyReview?.sources).toBeUndefined()
    // 不写 reason（T0 阶段没有 conflict）
    expect(a.classifyReview?.reason).toBeUndefined()
  })
})

// ── T-07 ② S1 双未分类 → none（且无 reason） ────────────────────────────

describe('T-07 ②：S1 命中不了 → classifyReview.confidence = none', () => {
  it('完全命中不了的资产名', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = await writeZip(root, 'zzz-unknown-asset.zip', 'zzz-unknown-asset', 'zzz-unknown-asset.skp')

    const assets = await importPaths([src], makeDeps(lib).deps)
    expect(assets).toHaveLength(1)
    const a = assets[0]!

    expect(a.category1).toBe(UNCLASSIFIED_CAT)
    expect(a.category2).toBe(UNCLASSIFIED_CAT)
    expect(a.classifyReview).toEqual({ confidence: 'none' })
    // ⚠️ `unclassified` 是派生值（走 `isUnclassified`），**不落库** ——
    // 一旦这里写入 reason，就成了"两处真相"，与 docs/25 的教训同型。
    expect(a.classifyReview && 'reason' in a.classifyReview).toBe(false)
    expect(Object.keys(a.classifyReview!)).toEqual(['confidence'])
  })
})

// ── T-07 ③ 覆盖导入继承 ────────────────────────────────────────────────

describe('T-07 ③：覆盖导入继承旧记录的 classifyReview（不被重置成 T0 初值）', () => {
  it('旧记录已定案（high + decidedAt）→ 覆盖后仍是 high', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    // 第一次导入（无判重 ctx = 旧行为）
    const src1 = await writeZip(path.join(root, 'a'), '椅子.zip', '椅子', '椅子.skp')
    const first = await importPaths([src1], makeDeps(lib).deps)
    expect(first).toHaveLength(1)
    const old = first[0]!
    // 新导入的记录一定带 T0 初值 —— 这正是"覆盖时必须让旧值优先"的理由
    expect(old.classifyReview).toEqual({ confidence: 'medium-s1' })

    // 模拟用户/自动定案：high + 时间戳（T2 会写成这个形状）
    const decided = { confidence: 'high' as const, decidedAt: 123 }

    // 第二次导入同名包 → 覆盖
    const src2 = await writeZip(path.join(root, 'b'), '椅子.zip', '椅子', '椅子-新版.skp')
    const h = makeDeps(lib, {
      conflictContext: { index: [entryOf(old, { classifyReview: decided })] },
      resolution: 'overwrite'
    })
    const second = await importPaths([src2], h.deps)
    expect(second).toHaveLength(1)
    const next = second[0]!

    // 身份沿用旧记录（证明真的走了覆盖分支，而不是 keep-both）
    expect(next.id).toBe(old.id)
    expect(next.name).toBe(old.name)
    // 内容跟着新包走
    expect(next.files.map((f) => f.name)).toContain('椅子-新版.skp')

    // **继承成功**：不是被 T0 的 medium-s1 覆盖掉
    expect(next.classifyReview).toEqual({ confidence: 'high', decidedAt: 123 })
  })

  it('旧记录没有 classifyReview（老记录）→ 用新包的 T0 初值', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src1 = await writeZip(path.join(root, 'a'), '椅子.zip', '椅子', '椅子.skp')
    const first = await importPaths([src1], makeDeps(lib).deps)
    const old = first[0]!

    const src2 = await writeZip(path.join(root, 'b'), '椅子.zip', '椅子', '椅子-新版.skp')
    const h = makeDeps(lib, {
      // meta.classifyReview 缺省 = 老记录（改造前入库的，字段不存在）
      conflictContext: { index: [entryOf(old)] },
      resolution: 'overwrite'
    })
    const second = await importPaths([src2], h.deps)
    expect(second).toHaveLength(1)

    expect(second[0]!.classifyReview).toEqual({ confidence: 'medium-s1' })
  })
})

// ── T-07 ④ buildInitialClassifyReview 单测 ─────────────────────────────

describe('buildInitialClassifyReview：三种输入', () => {
  it('双未分类 → none', () => {
    expect(buildInitialClassifyReview(UNCLASSIFIED_CAT, UNCLASSIFIED_CAT)).toEqual({
      confidence: 'none'
    })
  })

  it('只有二级未分类（一级有值）→ medium-s1（一级才是主判据）', () => {
    expect(buildInitialClassifyReview('家具', UNCLASSIFIED_CAT)).toEqual({
      confidence: 'medium-s1'
    })
  })

  it('两级都有值 → medium-s1', () => {
    expect(buildInitialClassifyReview('家具', '椅子_凳子')).toEqual({ confidence: 'medium-s1' })
  })

  it('任何情况下都不写 reason（unclassified 是派生值）', () => {
    for (const [c1, c2] of [
      [UNCLASSIFIED_CAT, UNCLASSIFIED_CAT],
      ['家具', UNCLASSIFIED_CAT],
      ['家具', '椅子_凳子']
    ] as const) {
      expect(buildInitialClassifyReview(c1, c2).reason).toBeUndefined()
    }
  })
})

// ── 快照投影：判重快照必须带上 classifyReview（否则继承链路断在渲染层） ──

describe('buildDedupeSnapshot：meta 带上 classifyReview', () => {
  it('有值原样带出', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = await writeZip(root, '椅子.zip', '椅子', '椅子.skp')
    const a = (await importPaths([src], makeDeps(lib).deps))[0]!

    const snap = buildDedupeSnapshot([a])
    expect(snap).toHaveLength(1)
    expect(snap[0]!.meta.classifyReview).toEqual({ confidence: 'medium-s1' })
  })

  it('缺省保持 undefined（不补默认值 = 不替老记录声称"判定过"）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = await writeZip(root, '椅子.zip', '椅子', '椅子.skp')
    const a = (await importPaths([src], makeDeps(lib).deps))[0]!
    const legacy: Asset = { ...a }
    delete legacy.classifyReview

    const snap = buildDedupeSnapshot([legacy])
    expect(snap[0]!.meta.classifyReview).toBeUndefined()
  })
})
