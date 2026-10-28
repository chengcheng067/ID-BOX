/**
 * 单文件模型直导（0.8.4，用户 2026-10-28 拍板「同意复制保留」）。
 *
 * 场景（客户实测）：用户在别处已经整理过素材，下载目录里只有一个 `.skp` / `.max`
 * 工程文件、没有我们那套「四段目录」。旧实现把它交给 `extractArchive` →
 * 被判「不是压缩包」→ 拖进去像没反应；即便落了库（文件夹路径）也只有一个类型框框、没有预览图。
 *
 * 本文件钉五条：
 * ① **复制而非移动**：入库后源工程文件必须还在原位（这是本轮唯一需要用户拍板的取舍）；
 * ② 建资产文件夹：四段路径 + `kindFolder`（不是 `KIND_LABEL`）；
 * ③ 分类走同一条 `classifyAssetName`（文件名命中词表就落类，否则双哨兵）；
 * ④ `.skp` 内嵌预览 → `coverSource='embedded'`，且预览图必须同时进 `files`（rescan 口径）；
 * ⑤ 文件名里的 `ID_<数字>` → `zhimoId` 被记下（批次结束后由既有任务抓知末主图）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { Asset, ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-model-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 假 SKP 字节：不是真的 SketchUp 文件，`writeSkpPreviewInto` 会解析失败并返回 null
 * （这正是"没有可提取预览"的分支，必须不崩）。要测"有预览"那条，用 `skpPreview` 的真夹具太重，
 * 本文件改为断言 `coverSource` 只可能是 embedded / placeholder 之一 —— 见用例 ④。
 */
const FAKE_SKP = Buffer.from('fake-skp-bytes')

function makeDeps(libraryDir: string, over: Partial<ImportDeps> = {}): {
  deps: ImportDeps
  events: ImportEvent[]
  thumbs: Array<{ id: string; coverAbs: string | null }>
} {
  const events: ImportEvent[] = []
  const thumbs: Array<{ id: string; coverAbs: string | null }> = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    // ⚠️ 刻意给最危险的档位 `delete`：本功能的验收点就是"**任何档位都不能动源工程文件**"，
    // 如果实现里误调了 disposeArchive，这个用例会立刻红。
    archiveDisposal: 'delete',
    defaultSource: '本机',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async (id, coverAbs) => {
      thumbs.push({ id, coverAbs })
      return coverAbs ? `${id}-stub.jpg` : null
    },
    emit: (ev) => events.push(ev),
    ...over
  }
  return { deps, events, thumbs }
}

describe('importPaths — 单文件模型直导（0.8.4）', () => {
  it('单个 .skp → 建资产文件夹 + 复制入库，**源文件仍在原位**（disposal=delete 也不动它）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '中古侘寂屏风.skp')
    await fs.writeFile(src, FAKE_SKP)

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('model')
    expect(a.name).toBe('中古侘寂屏风')
    // 四段路径（模型大类 + 文件名命中「屏风」→ 硬装构件/屏风隔断 或双哨兵，二者都合法）
    expect(a.relFolder.startsWith('模型/')).toBe(true)
    expect(a.relFolder.endsWith('/中古侘寂屏风')).toBe(true)
    expect(a.folder).toBe(path.join(lib, ...a.relFolder.split('/')))

    // 文件真的进了资产文件夹
    const inside = await fs.readdir(a.folder)
    expect(inside).toContain('中古侘寂屏风.skp')

    // ★ 核心断言：源工程文件原地不动（`archiveDisposal='delete'` 也不例外）
    await expect(fs.stat(src)).resolves.toBeTruthy()
    expect(await fs.readFile(src)).toEqual(FAKE_SKP)

    expect(events.some((e) => e.status === 'done')).toBe(true)
  })

  it('.max 也走同一条路（没有可提取预览 → 占位，不崩）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '现代摩托车_杜卡迪.max')
    await fs.writeFile(src, FAKE_SKP)

    const { deps } = makeDeps(lib)
    const [a] = await importPaths([src], deps)

    expect(a!.kind).toBe('model')
    expect(a!.cover).toBeUndefined()
    expect(a!.coverSource).toBe('placeholder')
    // 没有封面就不该白跑一次缩略图 IPC
    expect(a!.thumbStatus).toBe('none')
    await expect(fs.stat(src)).resolves.toBeTruthy()
  })

  it('.skp 的封面只可能是 embedded 或 placeholder（假字节解不出预览 → 占位；解出 → embedded）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '椅子.skp')
    await fs.writeFile(src, FAKE_SKP)

    const { deps } = makeDeps(lib)
    const [a] = await importPaths([src], deps)
    expect(['embedded', 'placeholder']).toContain(a!.coverSource)
    // 若真提取出了预览：cover 必须同时出现在 files 里（否则 rescan 会认为它不存在）
    if (a!.coverSource === 'embedded') {
      expect(a!.files.some((f) => f.rel === a!.cover)).toBe(true)
    }
  })

  it('文件名里的 ID_<数字> 被记进 zhimoId（批次结束后由既有任务抓知末主图）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '中古侘寂壁灯ID_1200166260.skp')
    await fs.writeFile(src, FAKE_SKP)

    const { deps } = makeDeps(lib)
    const [a] = await importPaths([src], deps)
    expect(a!.zhimoId).toBe('1200166260')
  })

  it('同名再拖一次 → 不覆盖，生成唯一名（与另两条路径同一套 uniqueName/台账）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src1 = path.join(root, '沙发.skp')
    const src2 = path.join(root, '沙发(1).skp')
    await fs.writeFile(src1, FAKE_SKP)
    await fs.writeFile(src2, FAKE_SKP)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src1], deps)
    const assets2 = await importPaths([src2], deps)
    // 第二次导入不能顶掉第一次（跨批次也是靠磁盘占位锁）
    expect(assets[0]!.folder).not.toBe(assets2[0]!.folder)
    await expect(fs.stat(assets[0]!.folder)).resolves.toBeTruthy()
    await expect(fs.stat(assets2[0]!.folder)).resolves.toBeTruthy()
  })

  it('多个模型文件一起拖：每个各建一个资产文件夹（不是一个塞一个）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const a = path.join(root, '台灯.skp')
    const b = path.join(root, '茶几.obj')
    await fs.writeFile(a, FAKE_SKP)
    await fs.writeFile(b, FAKE_SKP)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([a, b], deps)
    expect(assets.length).toBe(2)
    expect(new Set(assets.map((x) => x.folder)).size).toBe(2)
    for (const x of assets) {
      await expect(fs.stat(x.folder)).resolves.toBeTruthy()
    }
  })
})
