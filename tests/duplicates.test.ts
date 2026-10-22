import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { baseNameOf, dedupeKeyOf } from '../src/shared/naming'
import { importPaths, DEFAULT_CONCURRENCY, type ImportDeps } from '../src/main/importer'
import { rescanLibrary } from '../src/main/rescan'
import { db, applyAssetV4 } from '../src/renderer/db'
import {
  duplicateCountMap,
  duplicatesOf,
  extraCopyCount,
  groupDuplicates,
  groupOf,
  groupLabel,
  SIZE_MISMATCH_RATIO
} from '../src/renderer/logic/duplicates'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'
import type { Asset, ImportEvent } from '../src/shared/types'

/**
 * v0.4 重复资产检测（含底层 dedupeKey 缺陷修复）的单测。
 *
 * 覆盖四层：
 * ① 命名纯函数：`baseNameOf` 剥自动序号 + `dedupeKeyOf` 归一化；
 * ② **真实导入**导入两次同名包 → 两条记录 dedupeKey 相等（A0 缺陷的证明）；
 * ③ rescan 从带 `-2` 的磁盘目录名反推 dedupeKey；
 * ④ 分组纯逻辑 + Dexie v4 迁移纯函数（默认值 / 重算 / 幂等）。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-dup-'))
  tmpRoots.push(d)
  return d
}

// ── ① baseNameOf / dedupeKeyOf ────────────────────────────────────

describe('baseNameOf —— 剥掉 uniqueName 自动追加的 -<n> 序号', () => {
  it('椅子-2 / 椅子-17 / 椅子-108 都剥回“椅子”', () => {
    expect(baseNameOf('椅子-2')).toBe('椅子')
    expect(baseNameOf('椅子-17')).toBe('椅子')
    expect(baseNameOf('椅子-108')).toBe('椅子')
  })

  it('不含序号的名字原样返回，且幂等', () => {
    expect(baseNameOf('椅子')).toBe('椅子')
    expect(baseNameOf(baseNameOf('椅子-2'))).toBe('椅子')
  })

  it('-1 与 4 位数字是真实名字，不剥（uniqueName 从 2 起编号）', () => {
    expect(baseNameOf('椅子-1')).toBe('椅子-1')
    expect(baseNameOf('椅子-2024')).toBe('椅子-2024')
  })

  it('退化输入不产生空名', () => {
    expect(baseNameOf('-2')).toBe('-2')
    expect(baseNameOf('')).toBe('')
  })
})

describe('dedupeKeyOf —— 用原始名算 key（A0 的核心口径）', () => {
  it('椅子-2 与 椅子 得到同一个 key', () => {
    expect(dedupeKeyOf(baseNameOf('椅子-2'), 'model')).toBe('model:椅子')
    expect(dedupeKeyOf('椅子', 'model')).toBe('model:椅子')
  })

  it('不同大类同名 → 不同 key（不跨类判重）', () => {
    expect(dedupeKeyOf('椅子', 'model')).not.toBe(dedupeKeyOf('椅子', 'texture'))
  })

  it('空格 / 下划线 / 连字符 / 全半角括号统一归一化', () => {
    const a = dedupeKeyOf('现代 沙发_01', 'model')
    const b = dedupeKeyOf('现代-沙发 （01）', 'model')
    expect(a).toBe(b)
    expect(a).toBe('model:现代沙发01')
  })

  it('大小写不敏感', () => {
    expect(dedupeKeyOf('Modern Sofa', 'model')).toBe(dedupeKeyOf('modern-sofa', 'model'))
  })
})

// ── ② 真实导入两次同名包 ──────────────────────────────────────────

/** 单个顶层目录 + 一个 .skp（与 importer.test 的构造方式一致） */
function chairArchive(dirName: string): Buffer {
  return buildZip([
    zipDir(dirName),
    zipEntry(`${dirName}/预览图.jpg`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
    zipEntry(`${dirName}/${dirName}.skp`, skpContent('SketchUp Model {24.0.594}'))
  ])
}

function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
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
    emit: (ev) => {
      events.push(ev)
    }
  }
  return { deps, events }
}

describe('A0 回归：同一套模型导入两次 → dedupeKey 相等', () => {
  it('第二次被 uniqueName 命名成「椅子-2」，但 key 仍是 model:椅子', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '椅子.zip')
    await fs.writeFile(src, chairArchive('椅子'))

    const { deps } = makeDeps(lib)
    // 同一个源包连导两次（archiveDisposal='keep' → 源文件一直在）
    const first = await importPaths([src], deps)
    const second = await importPaths([src], deps)
    expect(first.length).toBe(1)
    expect(second.length).toBe(1)

    const a = first[0]!
    const b = second[0]!
    // 磁盘名确实被防重名逻辑改过（证明这条用例真的走到 uniqueName 分支）
    expect(a.name).toBe('椅子')
    expect(b.name).toBe('椅子-2')
    expect(b.folder.endsWith('椅子-2')).toBe(true)
    // ⭐ 关键断言：两条记录的重复键相等
    expect(a.dedupeKey).toBe('model:椅子')
    expect(b.dedupeKey).toBe(a.dedupeKey)
    // 反向守卫：绝不能是「最终名」算出来的键
    expect(b.dedupeKey).not.toBe('model:椅子-2')

    // 端到端：分组逻辑能把它们认成一组（原件 = 先导入的那份）
    const groups = groupDuplicates([a, b])
    expect(groups.length).toBe(1)
    expect(groups[0]!.assets.map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('单图路径同样用原始名（assetName）算 key', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '木纹 01.jpg')
    await fs.writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]))

    const { deps } = makeDeps(lib)
    const first = await importPaths([src], deps)
    const second = await importPaths([src], deps)
    expect(first[0]!.name).toBe('木纹 01')
    expect(second[0]!.name).toBe('木纹 01-2')
    expect(second[0]!.dedupeKey).toBe(first[0]!.dedupeKey)
    expect(second[0]!.dedupeKey).toBe(dedupeKeyOf('木纹 01', 'texture'))
  })
})

// ── ③ rescan 从磁盘目录名反推 ─────────────────────────────────────

const SKP = Buffer.concat([
  Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
  Buffer.from('SketchUp Model {24.0.594}', 'utf16le')
])

describe('rescan：带 -2 后缀的目录名 → key 与原件一致', () => {
  it('模型/未分类/未分类/椅子 与 椅子-2 得到同一个 dedupeKey', async () => {
    const lib = await tmpDir()
    for (const name of ['椅子', '椅子-2']) {
      const dir = path.join(lib, '模型', '未分类', '未分类', name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${name}.skp`), SKP)
    }

    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(2)
    const keys = new Set(assets.map((a) => a.dedupeKey))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe('model:椅子')
  })
})

// ── ④ groupDuplicates 纯逻辑 ──────────────────────────────────────

let seq = 0

/** 测试夹具：默认构造一条资产，可局部覆盖 */
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [{ rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 10, kind: 'model' }],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...patch
  }
}

describe('groupDuplicates', () => {
  it('3 份同 key → 1 组；原件是最早导入的；wastedBytes = 除保留份之外的体积和', () => {
    const a = asset({ dedupeKey: 'model:椅子', importedAt: 300, size: 100 })
    const b = asset({ dedupeKey: 'model:椅子', importedAt: 100, size: 200 })
    const c = asset({ dedupeKey: 'model:椅子', importedAt: 200, size: 300 })
    const groups = groupDuplicates([a, b, c])
    expect(groups.length).toBe(1)
    const g = groups[0]!
    expect(g.key).toBe('model:椅子')
    expect(g.assets.map((x) => x.id)).toEqual([b.id, c.id, a.id]) // importedAt 升序
    expect(g.totalBytes).toBe(600)
    expect(g.wastedBytes).toBe(400) // 600 - 最早那份 200
    expect(g.sizeMismatch).toBe(true) // 200 vs 300 差 50%
  })

  it('单份资产不进组', () => {
    expect(groupDuplicates([asset({ dedupeKey: 'model:沙发' })])).toEqual([])
  })

  it('不同 key 各自成组，组间按 wastedBytes 降序', () => {
    const g1a = asset({ dedupeKey: 'model:A', importedAt: 1, size: 10 })
    const g1b = asset({ dedupeKey: 'model:A', importedAt: 2, size: 10 })
    const g2a = asset({ dedupeKey: 'model:B', importedAt: 1, size: 100 })
    const g2b = asset({ dedupeKey: 'model:B', importedAt: 2, size: 100 })
    const g2c = asset({ dedupeKey: 'model:B', importedAt: 3, size: 100 })
    const groups = groupDuplicates([g1a, g1b, g2a, g2b, g2c])
    expect(groups.map((g) => g.key)).toEqual(['model:B', 'model:A'])
    expect(groups[0]!.wastedBytes).toBe(200)
    expect(groups[1]!.wastedBytes).toBe(10)
  })

  it('体积差异 ≤ 30% 不报警；> 30% 才 sizeMismatch', () => {
    const near = [
      asset({ dedupeKey: 'model:X', size: 100 }),
      asset({ dedupeKey: 'model:X', size: 130 })
    ]
    expect(groupDuplicates(near)[0]!.sizeMismatch).toBe(false)
    const far = [
      asset({ dedupeKey: 'model:Y', size: 100 }),
      asset({ dedupeKey: 'model:Y', size: 131 })
    ]
    expect(SIZE_MISMATCH_RATIO).toBe(0.3)
    expect(groupDuplicates(far)[0]!.sizeMismatch).toBe(true)
  })

  it('不修改入参顺序', () => {
    const a = asset({ dedupeKey: 'model:Z', importedAt: 9 })
    const b = asset({ dedupeKey: 'model:Z', importedAt: 1 })
    const input = [a, b]
    groupDuplicates(input)
    expect(input.map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('按 importedAt 升序确定“原件”，同毫秒时按 id 稳定排序', () => {
    const a = asset({ id: 'id-b', dedupeKey: 'model:T', importedAt: 5 })
    const b = asset({ id: 'id-a', dedupeKey: 'model:T', importedAt: 5 })
    const g = groupDuplicates([a, b])[0]!
    expect(g.assets.map((x) => x.id)).toEqual(['id-a', 'id-b'])
  })

  it('duplicatesOf / duplicateCountMap / extraCopyCount / groupOf / groupLabel', () => {
    const a = asset({ id: 'id-1', name: '椅子-2', dedupeKey: 'model:椅子', importedAt: 1 })
    const b = asset({ id: 'id-2', name: '椅子-3', dedupeKey: 'model:椅子', importedAt: 2 })
    const solo = asset({ id: 'id-3', name: '孤品', dedupeKey: 'model:孤品' })
    const all = [a, b, solo]

    expect(duplicatesOf(all, 'id-1').map((x) => x.id)).toEqual(['id-2'])
    expect(duplicatesOf(all, 'id-3')).toEqual([])
    expect(duplicatesOf(all, 'missing')).toEqual([])

    const counts = duplicateCountMap(all)
    expect(counts.get('id-1')).toBe(2)
    expect(counts.get('id-2')).toBe(2)
    expect(counts.has('id-3')).toBe(false)

    const groups = groupDuplicates(all)
    expect(extraCopyCount(groups)).toBe(1)
    expect(extraCopyCount([])).toBe(0)

    expect(groupOf(all, 'id-1')?.key).toBe('model:椅子')
    expect(groupOf(all, 'id-3')).toBeNull()
    expect(groupLabel(groups[0]!)).toBe('椅子')
  })

  it('dedupeKey 缺失的老记录 → 用 baseNameOf(name)+kind 现场兜底', () => {
    const a = asset({ dedupeKey: '', name: '椅子-2', importedAt: 1 })
    const b = asset({ dedupeKey: '', name: '椅子', importedAt: 2 })
    const groups = groupDuplicates([a, b])
    expect(groups.length).toBe(1)
    expect(groups[0]!.key).toBe('model:椅子')
  })
})

// ── ④-b 知末 ID 参与重复判定（0.6.3，修用户"误删不同商品"的风险）────────────
//
// 用户原话：「知末下载下来的压缩包可能在外面，它的文件夹是有相同名字的，不过它后面的
// ID 后缀是不同的。所以在你现在这个样子来提示我重复副本的时候，就很有可能会导致用户
// 也误删除」。
//
// 口径（三档，安全优先）：
// - ID 不同 → **绝不同组**（哪怕名字一字不差）；
// - ID 相同 → 同组（真重复）；
// - 一个有一个没有 → **不同组**（不敢判）。
describe('groupDuplicates × 知末 ID（0.6.3 新口径）', () => {
  it('ID 不同 + 名字相同 → 不重复（旧口径会把它们并成一组）', () => {
    const a = asset({
      name: '现代壁灯',
      dedupeKey: 'model:现代壁灯',
      zhimoId: '1232108421',
      importedAt: 1
    })
    const b = asset({
      name: '现代壁灯-2',
      dedupeKey: 'model:现代壁灯',
      zhimoId: '1232108999',
      importedAt: 2
    })
    // 反向守卫：旧的 dedupeKey 确实相同 —— 证明这条用例真的只在 ID 口径下才成立
    expect(a.dedupeKey).toBe(b.dedupeKey)
    expect(groupDuplicates([a, b])).toEqual([])
    expect(duplicatesOf([a, b], a.id)).toEqual([])
    expect(groupOf([a, b], a.id)).toBeNull()
    expect(duplicateCountMap([a, b]).size).toBe(0)
    expect(extraCopyCount(groupDuplicates([a, b]))).toBe(0)
  })

  it('ID 相同 → 同组（真重复），键前缀是 zhimo:', () => {
    const a = asset({ name: '现代壁灯', zhimoId: '1232108421', importedAt: 1, size: 100 })
    const b = asset({ name: '现代壁灯-2', zhimoId: '1232108421', importedAt: 2, size: 100 })
    const groups = groupDuplicates([a, b])
    expect(groups.length).toBe(1)
    expect(groups[0]!.key).toBe('zhimo:1232108421')
    expect(groups[0]!.assets.map((x) => x.id)).toEqual([a.id, b.id])
    expect(extraCopyCount(groups)).toBe(1)
    expect(duplicatesOf([a, b], a.id).map((x) => x.id)).toEqual([b.id])
  })

  it('一个有 ID 一个没有 → 不同组（不敢判，安全优先）', () => {
    const a = asset({ name: '椅子', dedupeKey: 'model:椅子', zhimoId: '1232108421' })
    const b = asset({ name: '椅子-2', dedupeKey: 'model:椅子', zhimoId: null })
    expect(groupDuplicates([a, b])).toEqual([])
    // 空白字符串视同"没有 ID"，同样不与 zhimo 组混
    const c = asset({ name: '椅子-3', dedupeKey: 'model:椅子', zhimoId: '   ' })
    expect(groupDuplicates([a, c])).toEqual([])
  })

  it('zhimoId 缺省（老记录、未回填）→ 沿用旧 dedupeKey 口径，行为一字不变', () => {
    const a = asset({ name: '椅子', dedupeKey: 'model:椅子', importedAt: 1 })
    const b = asset({ name: '椅子-2', dedupeKey: 'model:椅子', importedAt: 2 })
    const groups = groupDuplicates([a, b])
    expect(groups.length).toBe(1)
    expect(groups[0]!.key).toBe('model:椅子')
  })

  it('ID 相同但大类不同 → 仍然同组（ID 是商品级主键，比 kind 更权威）', () => {
    const a = asset({ kind: 'model', zhimoId: '1232108421' })
    const b = asset({ kind: 'texture', zhimoId: '1232108421' })
    expect(groupDuplicates([a, b]).length).toBe(1)
  })
})

// ── ⑤ Dexie v4 迁移（纯函数部分） ─────────────────────────────────

/** 老记录：没有 favorite/rating/colorTag，dedupeKey 用最终名算错 */
function legacyRecord(patch: Record<string, unknown> = {}): Asset {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: '椅子-2',
    kind: 'model',
    source: '知末网',
    folder: 'E:\\Lib\\模型\\未分类\\未分类\\椅子-2',
    relFolder: '模型/未分类/未分类/椅子-2',
    files: [],
    size: 0,
    tags: ['奶油'],
    note: '老记录',
    dedupeKey: 'model:椅子-2',
    importedAt: 1_600_000_000_000,
    updatedAt: 1_600_000_000_000,
    ...patch
  } as unknown as Asset
}

describe('Dexie v4：applyAssetV4（缺字段补齐 + dedupeKey 重算 + 幂等）', () => {
  it('缺三个新字段 → 补 false / 0 / null，其它字段原样保留', () => {
    const fixed = applyAssetV4(legacyRecord())
    expect(fixed.favorite).toBe(false)
    expect(fixed.rating).toBe(0)
    expect(fixed.colorTag).toBeNull()
    expect(fixed.tags).toEqual(['奶油'])
    expect(fixed.note).toBe('老记录')
    expect(fixed.id).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('带 -2 的 dedupeKey 被重算成基础名', () => {
    const fixed = applyAssetV4(legacyRecord())
    expect(fixed.dedupeKey).toBe('model:椅子')
  })

  it('已有合法值不覆盖（favorite=true / rating=4 / colorTag=red）', () => {
    const fixed = applyAssetV4(
      legacyRecord({ favorite: true, rating: 4, colorTag: 'red' })
    )
    expect(fixed.favorite).toBe(true)
    expect(fixed.rating).toBe(4)
    expect(fixed.colorTag).toBe('red')
  })

  it('脏数据收敛：rating 越界/非数字 → 0–5 取整，非法 colorTag → null', () => {
    expect(applyAssetV4(legacyRecord({ rating: 9 })).rating).toBe(5)
    expect(applyAssetV4(legacyRecord({ rating: -3 })).rating).toBe(0)
    expect(applyAssetV4(legacyRecord({ rating: Number.NaN })).rating).toBe(0)
    expect(applyAssetV4(legacyRecord({ rating: 3.6 })).rating).toBe(4)
    expect(applyAssetV4(legacyRecord({ colorTag: 'pink' })).colorTag).toBeNull()
  })

  it('幂等：连续迁移两次结果完全相同', () => {
    const once = applyAssetV4(legacyRecord())
    const twice = applyAssetV4(once)
    expect(twice).toEqual(once)
  })

  it('DB 版本号为 4（v4 迁移已注册）', () => {
    expect(db.verno).toBeGreaterThanOrEqual(4)
  })
})

// ── ⑥ 源码守卫：写入点不得再用最终名 ──────────────────────────────

describe('源码守卫：dedupeKey 的写入点', () => {
  it('importer 两处都用 assetName，不得再出现 dedupeKeyOf(finalName', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'main', 'importer.ts'),
      'utf8'
    )
    expect(src).not.toContain('dedupeKeyOf(finalName')
    const hits = src.match(/dedupeKey: dedupeKeyOf\(assetName, kind\)/g) ?? []
    expect(hits.length).toBe(2)
  })

  it('rescan 用 baseNameOf 剥自动序号后再算 key', async () => {
    const src = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'rescan.ts'), 'utf8')
    expect(src).toContain('dedupeKeyOf(baseNameOf(name), kind)')
  })
})

// 清理临时目录（import / rescan 用例）
afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})
