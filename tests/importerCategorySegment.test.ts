/**
 * DEF-14（0.7.8）回归测试：导入侧「磁盘目录段 = relFolder 段 = Asset.category1/2」。
 *
 * ## 缺陷回顾（`docs/08-测试报告.md` §7.1 DEF-14）
 *
 * 词表里有含 `/` 的并列词条（`椅子/凳子`、`酒店/民宿`、`筒灯/射灯`、`金箔/银箔`、
 * `灯膜/灯罩`…）。旧实现把**原始分类值**直接喂给 `path.join(lib, kind, cat1, cat2)`：
 *   - 磁盘：`/` 被 `path.join` 当目录分隔符 → **五段** `模型/家具/椅子/凳子/北欧椅子`
 *   - 记录：`relFolder` 走 `composeRelFolder`（内部把 `/` 换成 `_`）→ **四段**
 *   - 于是 `asset.folder !== path.join(libraryDir, asset.relFolder)`
 *   - 下一次 rescan（固定三层下钻、磁盘为权威）读成 `category2='椅子'`、`name='凳子'`
 *     → 分类与资产名同时损坏
 *
 * ## 本文件守护的不变式（三条，任一破了就是 DEF-14 复发）
 *
 * 1. `asset.relFolder` 按 `/` 切出来**恰好 4 段**；
 * 2. `asset.folder === path.join(libraryDir, ...relFolder 的 4 段)`；
 * 3. `asset.category1/2` 与磁盘上真实的目录名**逐字相等**（不是"等价"，是相等）。
 *
 * ## 关于 `vi.mock`
 *
 * 真实词表当前只有 `/` 这一类非法字符（`:` `*` `?` `"` `<` `>` `|` 在
 * `docs/05`/`docs/07` 词条里一个都没有），但「词表将来加了这类词条」必须同一条修法兜住。
 * 故这里把 `classifyAssetName` 做**可控透传**：默认走真实实现，只有用例显式
 * `forced.value = {...}` 时才返回构造值。模块级 mock 仅作用于本文件。
 *
 * 全部用例只用 `os.tmpdir()` 下的临时库，**绝不触碰真实素材库**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 受控覆盖（`vi.hoisted` 才能在 `vi.mock` 工厂里安全引用） */
const forced = vi.hoisted(() => ({
  value: null as null | { category1: string; category2: string }
}))

vi.mock('../src/shared/classifyAsset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/classifyAsset')>()
  return {
    ...actual,
    // 默认透传真实判定；只有用例设了 forced 才用构造值
    classifyAssetName: (
      assetName: string,
      fileNames: string[] | undefined,
      kind: string
    ) => forced.value ?? actual.classifyAssetName(assetName, fileNames, kind)
  }
})

// ⚠️ 必须在 vi.mock 之后 import（vi.mock 已被提升，这里只是可读性排列）
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'
import type { Asset, ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-seg-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  forced.value = null
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 假图片字节（importer 不做 magic 校验） */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

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
    emit: (ev) => events.push(ev)
  }
  return { deps, events }
}

/** 单顶层目录 + 该目录下唯一 .skp —— 走压缩包路径（`importOne`） */
function modelArchive(dirName: string): Buffer {
  return buildZip([
    zipDir(dirName),
    zipEntry(`${dirName}/${dirName}.skp`, skpContent('SketchUp Model {24.0.594}'))
  ])
}

/** 一次性解压"列表项名"的公共部分：建临时库 + 落 src */
async function makeLibrary(): Promise<{ root: string; lib: string }> {
  const root = await tmpDir()
  const lib = path.join(root, 'Library')
  await fs.mkdir(lib, { recursive: true })
  return { root, lib }
}

/**
 * DEF-14 的**核心断言**（三条不变式一次查完，含真实磁盘回读）。
 *
 * @param expected 期望的 4 段，顺序：`<大类>/<一级>/<二级>/<资产名>`
 */
async function expectDiskEqualsRecord(lib: string, a: Asset, expected: string[]): Promise<void> {
  // ① relFolder 恰好 4 段（旧实现在磁盘上是 5 段，但 relFolder 一直 4 段 —— 只看它查不出病）
  const relSegs = a.relFolder.split('/')
  expect(relSegs).toHaveLength(4)
  expect(relSegs).toEqual(expected)

  // ② folder == 库根 + relFolder（按平台分隔符）—— 旧实现这条会红
  expect(a.folder).toBe(path.join(lib, ...relSegs))
  // ③ 反方向也成立：从库根到 folder 的相对路径只有 4 段（= 磁盘上没被多切一层）
  expect(path.relative(lib, a.folder).split(path.sep)).toHaveLength(4)

  // ④ 磁盘上真实存在的目录名 == 记录里的段名（rescan 以磁盘为权威，必须逐字相等）
  const dirNamesIn = async (dir: string): Promise<string[]> => {
    const ents = await fs.readdir(dir, { withFileTypes: true })
    return ents
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  }
  const kindDir = path.join(lib, relSegs[0]!)
  const cat1Dir = path.join(kindDir, relSegs[1]!)
  const cat2Dir = path.join(cat1Dir, relSegs[2]!)
  expect(await dirNamesIn(kindDir)).toEqual([relSegs[1]!])
  expect(await dirNamesIn(cat1Dir)).toEqual([relSegs[2]!])
  expect(await dirNamesIn(cat2Dir)).toEqual([relSegs[3]!])

  // ⑤ 记录字段与磁盘段名逐字相等（DEF-14 的正题）
  expect(a.category1).toBe(relSegs[1])
  expect(a.category2).toBe(relSegs[2])
  // 分类值里永不再出现路径分隔符（否则 `path.join` 还会多切一层）
  expect(a.category1).not.toMatch(/[\\/]/)
  expect(a.category2).not.toMatch(/[\\/]/)
  // 资产目录确实在预期位置，且名字里的 `/` 没有变成目录层级
  const st = await fs.stat(a.folder)
  expect(st.isDirectory()).toBe(true)
}

describe('DEF-14 · 压缩包路径（importOne）', () => {
  it('词表级 `家具/椅子/凳子` → 磁盘 4 段、段名 `椅子_凳子`、记录与磁盘逐字相等', async () => {
    const { root, lib } = await makeLibrary()
    const src = path.join(root, '北欧椅子.zip')
    await fs.writeFile(src, modelArchive('北欧椅子'))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets).toHaveLength(1)
    const a = assets[0]!
    // 键：kind=model → 大类目录「模型」；一级「家具」（词表真实值）；二级是**落盘值**
    expect(a.kind).toBe('model')
    await expectDiskEqualsRecord(lib, a, ['模型', '家具', '椅子_凳子', '北欧椅子'])
    // 词表原貌（含 `/`）绝不进记录，也不进磁盘
    expect(a.category2).toBe('椅子_凳子')
  })

  it('正常词条 `灯具/壁灯` 行为不变（改造前的期望值硬写，防回归）', async () => {
    const { root, lib } = await makeLibrary()
    const src = path.join(root, '北欧壁灯.zip')
    await fs.writeFile(src, modelArchive('北欧壁灯'))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets).toHaveLength(1)
    const a = assets[0]!
    // ⚠️ 这两行是**改造前**就成立的期望值，一字未改 —— 防的是"修 DEF-14 顺手改了正常值"
    expect(a.relFolder).toBe('模型/灯具/壁灯/北欧壁灯')
    expect(a.folder).toBe(path.join(lib, '模型', '灯具', '壁灯', '北欧壁灯'))
    await expectDiskEqualsRecord(lib, a, ['模型', '灯具', '壁灯', '北欧壁灯'])
  })

  it('其它非法字符（\\ : * ? " < > |）与首尾空格/点 → 同样 disk == record', async () => {
    const cases: Array<{ label: string; category2: string; expectedSeg: string }> = [
      // Windows 上 `\` 也是分隔符（最容易漏的一类）
      { label: '反斜杠', category2: '椅子\\凳子', expectedSeg: '椅子_凳子' },
      // Windows 禁用字符：`mkdir` 会直接 ENOENT —— 清洗后才有目录
      { label: '冒号', category2: '椅子:凳子', expectedSeg: '椅子_凳子' },
      { label: '星号', category2: '椅子*凳子', expectedSeg: '椅子_凳子' },
      { label: '问号', category2: '椅子?凳子', expectedSeg: '椅子_凳子' },
      { label: '双引号', category2: '椅子"凳子', expectedSeg: '椅子_凳子' },
      { label: '小于号', category2: '椅子<凳子', expectedSeg: '椅子_凳子' },
      { label: '大于号', category2: '椅子>凳子', expectedSeg: '椅子_凳子' },
      { label: '竖线', category2: '椅子|凳子', expectedSeg: '椅子_凳子' },
      // 首尾空格 / 尾随点：Windows 会在部分 API 下静默吃掉，必须自己先清掉
      { label: '首尾空格', category2: '  椅子凳子  ', expectedSeg: '椅子凳子' },
      { label: '尾随点', category2: '椅子凳子.', expectedSeg: '椅子凳子' },
      { label: '点加空格', category2: '椅子凳子. ', expectedSeg: '椅子凳子' }
    ]

    for (const c of cases) {
      // 每条一个独立库：`toEqual([...])` 的磁盘断言要求目录里只有这一条
      const { root, lib } = await makeLibrary()
      const src = path.join(root, '北欧椅子.zip')
      await fs.writeFile(src, modelArchive('北欧椅子'))

      forced.value = { category1: '家具', category2: c.category2 }
      const { deps, events } = makeDeps(lib)
      const assets = await importPaths([src], deps)

      expect(events.filter((e) => e.status === 'error')).toEqual([])
      expect(assets, `用例「${c.label}」应成功导入`).toHaveLength(1)
      await expectDiskEqualsRecord(lib, assets[0]!, ['模型', '家具', c.expectedSeg, '北欧椅子'])
    }
  })
})

describe('DEF-14 · 单图 / HDR 路径（importMediaOne）', () => {
  it('词表级 `金属/金箔/银箔` → 磁盘 4 段、段名 `金箔_银箔`、记录与磁盘逐字相等', async () => {
    const { root, lib } = await makeLibrary()
    const src = path.join(root, '金箔.png')
    await fs.writeFile(src, FAKE_PNG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets).toHaveLength(1)
    const a = assets[0]!
    expect(a.kind).toBe('texture')
    await expectDiskEqualsRecord(lib, a, ['材质', '金属', '金箔_银箔', '金箔'])
    expect(a.category2).toBe('金箔_银箔')
  })

  it('正常词条 `瓷砖/大理石瓷砖` 行为不变（改造前的期望值硬写，防回归）', async () => {
    const { root, lib } = await makeLibrary()
    const src = path.join(root, '大理石瓷砖.jpg')
    await fs.writeFile(src, FAKE_PNG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets).toHaveLength(1)
    const a = assets[0]!
    // ⚠️ 与 `tests/importerSingleImage.test.ts` 里改造前的断言**完全同一串**，一字未改
    expect(a.relFolder).toBe('材质/瓷砖/大理石瓷砖/大理石瓷砖')
    expect(a.category1).toBe('瓷砖')
    expect(a.category2).toBe('大理石瓷砖')
    await expectDiskEqualsRecord(lib, a, ['材质', '瓷砖', '大理石瓷砖', '大理石瓷砖'])
  })

  it('单图路径同样兜住非法字符（`酒店/民宿` 之外的 `\\ : * ?` 等）', async () => {
    const cases: Array<{ label: string; category2: string; expectedSeg: string }> = [
      { label: '斜杠', category2: '酒店/民宿', expectedSeg: '酒店_民宿' },
      { label: '反斜杠', category2: '酒店\\民宿', expectedSeg: '酒店_民宿' },
      { label: '冒号', category2: '酒店:民宿', expectedSeg: '酒店_民宿' },
      { label: '问号', category2: '酒店?民宿', expectedSeg: '酒店_民宿' },
      { label: '尾随空格', category2: '酒店民宿  ', expectedSeg: '酒店民宿' }
    ]

    for (const c of cases) {
      const { root, lib } = await makeLibrary()
      const src = path.join(root, '现代壁灯.png')
      await fs.writeFile(src, FAKE_PNG)

      forced.value = { category1: '灯具', category2: c.category2 }
      const { deps, events } = makeDeps(lib)
      const assets = await importPaths([src], deps)

      expect(events.filter((e) => e.status === 'error')).toEqual([])
      expect(assets, `用例「${c.label}」应成功导入`).toHaveLength(1)
      await expectDiskEqualsRecord(lib, assets[0]!, ['材质', '灯具', c.expectedSeg, '现代壁灯'])
    }
  })
})
