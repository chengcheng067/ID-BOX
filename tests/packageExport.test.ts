/**
 * 一键打包 · T2 导出链端到端单测（docs/58 §2.1 / §3.1 / T2 卡 / §7）。
 *
 * 全部在 `os.tmpdir()` 下的小目录里造树、导包、解包；**绝不碰真实库 E:/ModVault/Library**。
 * 覆盖：单文件 ZIP64 + store、`.trash`/`.idbox` 0 条目、HDRI 同去、逐文件 sha256、
 * 取消 / 失败无半包、index 去 folder 且 sha 对得上、个人设置白名单、源码守卫与 IPC 接线。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PACKAGE_API_VERSION,
  PACKAGE_ASSETS_PREFIX,
  PACKAGE_FORMAT_MAGIC,
  PACKAGE_FORMAT_VERSION,
  PACKAGE_KIND_ORDER,
  collectExpectedEntries,
  toPortableAsset,
  type PortableAsset
} from '../src/shared/packageFormat'
import type { Asset, AssetKind } from '../src/shared/types'
import {
  cancelPackageExport,
  createArchiverZipWriter,
  defaultPackageFileName,
  walkLibraryFiles,
  writePackage,
  type PackageExportDeps,
  type PackageZipWriter
} from '../src/main/packageExport'

// ── 测试夹具 ────────────────────────────────────────────────────────────────

const TEX_REL_FOLDER = '贴图/木纹/橡木/橡木地板-01'
const HDRI_REL_FOLDER = '环境/HDRI/夕阳/夕阳外景'
const TEX_FILE = 'wood_4k.png'
const TEX_EXTRA = 'notes.txt'
const HDRI_FILE = 'sunset_4k.exr'
const TEX_BYTES = Buffer.from('texture-bytes-0123456789', 'utf8')
const EXTRA_BYTES = Buffer.from('plain note\n', 'utf8')
const HDRI_BYTES = Buffer.from('hdri-bytes-abcdefghijklmnop', 'utf8')
const MODEL_REL_FOLDER = '模型/建筑/小屋/小屋-01'
const MODEL_FILE = 'house.skp'
const MODEL_BYTES = Buffer.from('model-bytes-0123456789', 'utf8')

/** F-2：勾选项测试用的大类集合（全部 / 除 HDR 外）。 */
const ALL_KINDS: AssetKind[] = [...PACKAGE_KIND_ORDER]
const NO_HDRI: AssetKind[] = PACKAGE_KIND_ORDER.filter((k) => k !== 'hdri')

let root = ''

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function makeRecord(id: string, relFolder: string, kind: Asset['kind'], files: Array<[string, Buffer]>): PortableAsset {
  const asset: Asset = {
    id,
    name: id,
    kind,
    source: '测试',
    folder: `E:\\NotARealLibrary\\${relFolder.split('/').join('\\')}`,
    relFolder,
    files: files.map(([rel, bytes]) => ({
      rel,
      name: path.posix.basename(rel),
      ext: path.posix.extname(rel).slice(1).toLowerCase(),
      size: bytes.length,
      kind
    })),
    size: files.reduce((sum, [, bytes]) => sum + bytes.length, 0),
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    deletedAt: undefined,
    trashRel: undefined,
    dedupeKey: `${kind}:${id}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  }
  return toPortableAsset(asset)
}

/** 造一棵小库：正常素材 + .trash / .idbox 里的同名诱饵文件。 */
async function makeLibrary(): Promise<{ tex: PortableAsset; hdri: PortableAsset }> {
  const write = async (rel: string, bytes: Buffer): Promise<void> => {
    const abs = path.join(root, ...rel.split('/'))
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, bytes)
  }
  await write(`${TEX_REL_FOLDER}/${TEX_FILE}`, TEX_BYTES)
  await write(`${TEX_REL_FOLDER}/${TEX_EXTRA}`, EXTRA_BYTES)
  await write(`${HDRI_REL_FOLDER}/${HDRI_FILE}`, HDRI_BYTES)
  await write(`.trash/${TEX_REL_FOLDER}/trash-only.bin`, Buffer.from('trash'))
  await write(`.idbox/cache/demo/demo/cache-only.bin`, Buffer.from('cache'))

  return {
    tex: makeRecord('tex-1', TEX_REL_FOLDER, 'texture', [
      [TEX_FILE, TEX_BYTES],
      [TEX_EXTRA, EXTRA_BYTES]
    ]),
    hdri: makeRecord('hdri-1', HDRI_REL_FOLDER, 'hdri', [[HDRI_FILE, HDRI_BYTES]])
  }
}

function makeDeps(overrides: Partial<PackageExportDeps> = {}): PackageExportDeps {
  return {
    libraryDir: root,
    diskFree: () => 1024 * 1024 * 1024,
    walk: walkLibraryFiles,
    zipFactory: createArchiverZipWriter,
    now: () => new Date('2026-11-23T08:30:00.000Z'),
    appVersion: '1.1.0-test',
    ...overrides
  }
}

// ── zip 元数据读取（不依赖第三方解析，直接读 central directory）─────────────

interface ZipCentralEntry {
  name: string
  method: number
  extra: Buffer
}

const CD_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02])
const ZIP64_EOCD_SIG = Buffer.from([0x50, 0x4b, 0x06, 0x06])

function centralDirectory(zipPath: string): ZipCentralEntry[] {
  const buf = fs.readFileSync(zipPath)
  const entries: ZipCentralEntry[] = []
  let cursor = 0
  for (;;) {
    const at = buf.indexOf(CD_SIG, cursor)
    if (at < 0) break
    const method = buf.readUInt16LE(at + 10)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    entries.push({
      name: buf.subarray(at + 46, at + 46 + nameLen).toString('utf8'),
      method,
      extra: buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen)
    })
    cursor = at + 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function hasZip64Extra(extra: Buffer): boolean {
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    if (id === 0x0001) return true
    at += 4 + size
  }
  return false
}

function extractText(zipPath: string, name: string): string {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry(name)
  if (entry === null) throw new Error(`zip 缺少条目：${name}`)
  return entry.getData().toString('utf8')
}

function tmpPathFor(dest: string): string {
  return `${dest}.tmp`
}

/** PortableAsset 的 files 是交叉类型，读 sha256 时显式收口一次。 */
function shaOf(record: PortableAsset | undefined, rel: string): string | undefined {
  const files = record?.files as Array<{ rel: string; sha256?: string }> | undefined
  return files?.find((f) => f.rel === rel)?.sha256
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'idbox-pack-export-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('T2 · writePackage 端到端', () => {
  it('① 单文件 / ZIP64 / store 落盘，三件套齐全，逐文件 sha256 单遍算对', async () => {
    const { tex, hdri } = await makeLibrary()
    const dest = path.join(root, 'out', 'library.zip')
    await fsp.mkdir(path.dirname(dest), { recursive: true })

    const result = await writePackage(
      dest,
      [tex, hdri],
      { includedKinds: ALL_KINDS, includePersonalSettings: false },
      makeDeps()
    )

    expect(result).toEqual({
      ok: true,
      path: dest,
      count: 2,
      bytes: TEX_BYTES.length + EXTRA_BYTES.length + HDRI_BYTES.length
    })
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.existsSync(tmpPathFor(dest))).toBe(false)

    const central = centralDirectory(dest)
    const names = central.map((e) => e.name).sort()
    expect(names).toEqual([
      `${PACKAGE_ASSETS_PREFIX}${HDRI_REL_FOLDER}/${HDRI_FILE}`,
      `${PACKAGE_ASSETS_PREFIX}${TEX_REL_FOLDER}/${TEX_EXTRA}`,
      `${PACKAGE_ASSETS_PREFIX}${TEX_REL_FOLDER}/${TEX_FILE}`,
      'index.json',
      'manifest.json'
    ].sort())
    // store：中心目录 compression method === 0；ZIP64：EOCD64 + 定位记录。
    // 注：archiver 的 forceZip64 对小条目不写逐条 0x0001 扩展（只在 >4GB 时才需要），
    // 判据是 ZIP64 EOCD / locator 确实存在，见下方两条断言。
    expect(central.every((e) => e.method === 0)).toBe(true)
    expect(central.every((e) => e.extra.length === 0 || hasZip64Extra(e.extra))).toBe(true)
    const zipBytes = fs.readFileSync(dest)
    expect(zipBytes.includes(ZIP64_EOCD_SIG)).toBe(true)
    expect(zipBytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true)

    const manifest = JSON.parse(extractText(dest, 'manifest.json')) as Record<string, unknown>
    expect(manifest.format).toBe(PACKAGE_FORMAT_MAGIC)
    expect(manifest.formatVersion).toBe(PACKAGE_FORMAT_VERSION)
    expect(manifest.apiVersion).toBe(PACKAGE_API_VERSION)
    expect(manifest.count).toBe(2)
    expect(manifest.includedKinds).toEqual(ALL_KINDS)
    expect(manifest.includePersonalSettings).toBe(false)
    expect('sourceLibraryRoot' in manifest).toBe(false) // C-3

    const indexText = extractText(dest, 'index.json')
    expect(manifest.indexSha256).toBe(sha256(indexText)) // 对落盘的同一份文本
    const index = JSON.parse(indexText) as PortableAsset[]
    const texOut = index.find((r) => r.id === 'tex-1')
    expect(shaOf(texOut, TEX_FILE)).toBe(sha256(TEX_BYTES))
    expect(shaOf(texOut, TEX_EXTRA)).toBe(sha256(EXTRA_BYTES))
    const hdriOut = index.find((r) => r.id === 'hdri-1')
    expect(shaOf(hdriOut, HDRI_FILE)).toBe(sha256(HDRI_BYTES))
  })

  it('② index.json 不含 folder 绝对路径；白名单只从过滤后的 records 生成', async () => {
    const { tex } = await makeLibrary()
    const dest = path.join(root, 'no-folder.zip')
    const result = await writePackage(
      dest,
      [tex],
      { includedKinds: NO_HDRI, includePersonalSettings: false },
      makeDeps()
    )
    expect(result.ok).toBe(true)

    const indexText = extractText(dest, 'index.json')
    expect(indexText.includes('"folder"')).toBe(false)
    expect(indexText.includes('NotARealLibrary')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(indexText)[0], 'folder')).toBe(false)
    // 白名单本身也是 Q-5：只有 assets/<relFolder>/<rel>，没有任何库根片段。
    expect([...collectExpectedEntries([tex])]).toEqual([
      `${PACKAGE_ASSETS_PREFIX}${TEX_REL_FOLDER}/${TEX_FILE}`,
      `${PACKAGE_ASSETS_PREFIX}${TEX_REL_FOLDER}/${TEX_EXTRA}`
    ])
  })

  it('③ 遍历只跳 .trash / .idbox，两目录 0 条目', async () => {
    await makeLibrary()
    const walked: string[] = []
    for await (const rel of walkLibraryFiles(root)) walked.push(rel)
    expect(walked.some((rel) => rel.split('/').includes('.trash'))).toBe(false)
    expect(walked.some((rel) => rel.split('/').includes('.idbox'))).toBe(false)
    expect(walked).toContain(`${TEX_REL_FOLDER}/${TEX_FILE}`)

    const dest = path.join(root, 'skip.zip')
    const { tex } = await makeLibrary()
    expect((await writePackage(dest, [tex], { includedKinds: NO_HDRI, includePersonalSettings: false }, makeDeps())).ok).toBe(true)
    const names = centralDirectory(dest).map((e) => e.name)
    expect(names.filter((n) => n.includes('.trash') || n.includes('.idbox'))).toEqual([])
    expect(names.filter((n) => n.includes('trash-only') || n.includes('cache-only'))).toEqual([])
  })

  it('④ 不勾 HDRI：hdri 记录与其素材同时缺席', async () => {
    const { tex, hdri } = await makeLibrary()
    const dest = path.join(root, 'no-hdri.zip')
    const result = await writePackage(
      dest,
      [tex, hdri],
      { includedKinds: NO_HDRI, includePersonalSettings: false },
      makeDeps()
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.count).toBe(1)

    const names = centralDirectory(dest).map((e) => e.name)
    expect(names.some((n) => n.includes(HDRI_REL_FOLDER))).toBe(false)
    const index = JSON.parse(extractText(dest, 'index.json')) as PortableAsset[]
    expect(index.map((r) => r.id)).toEqual(['tex-1'])
    const manifest = JSON.parse(extractText(dest, 'manifest.json')) as Record<string, unknown>
    expect(manifest.includedKinds).toEqual(NO_HDRI)
  })

  it('④-b F-2：勾「模型 + 贴图」时 HDR 记录与素材同时缺席（动态大类过滤）', async () => {
    const { tex, hdri } = await makeLibrary()
    const modelDir = path.join(root, ...MODEL_REL_FOLDER.split('/'))
    await fsp.mkdir(modelDir, { recursive: true })
    await fsp.writeFile(path.join(modelDir, MODEL_FILE), MODEL_BYTES)
    const model = makeRecord('model-1', MODEL_REL_FOLDER, 'model', [[MODEL_FILE, MODEL_BYTES]])

    const dest = path.join(root, 'model-tex.zip')
    const includedKinds: AssetKind[] = ['model', 'texture']
    const result = await writePackage(
      dest,
      [tex, model, hdri],
      { includedKinds, includePersonalSettings: false },
      makeDeps()
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.count).toBe(2)

    const names = centralDirectory(dest).map((e) => e.name)
    expect(names.some((n) => n.includes(HDRI_REL_FOLDER) || n.includes(HDRI_FILE))).toBe(false)
    expect(names).toContain(`${PACKAGE_ASSETS_PREFIX}${MODEL_REL_FOLDER}/${MODEL_FILE}`)
    const index = JSON.parse(extractText(dest, 'index.json')) as PortableAsset[]
    expect(index.map((r) => r.id).sort()).toEqual(['model-1', 'tex-1'])
    const manifest = JSON.parse(extractText(dest, 'manifest.json')) as Record<string, unknown>
    expect(manifest.includedKinds).toEqual(['model', 'texture'])
  })

  it('⑤ 个人设置补丁：勾选才落 personal.json，sha 对得上落盘文本', async () => {
    const { tex } = await makeLibrary()
    const dest = path.join(root, 'personal.zip')
    const patch = { homeWaveHeight: 0.73 }
    const result = await writePackage(
      dest,
      [tex],
      { includedKinds: NO_HDRI, includePersonalSettings: true },
      makeDeps({ personalSettings: patch })
    )
    expect(result.ok).toBe(true)
    const personalText = extractText(dest, 'personal.json')
    expect(JSON.parse(personalText)).toEqual(patch)
    const manifest = JSON.parse(extractText(dest, 'manifest.json')) as Record<string, unknown>
    expect(manifest.personalSha256).toBe(sha256(personalText))
    expect(manifest.includePersonalSettings).toBe(true)

    const dest2 = path.join(root, 'no-personal.zip')
    expect(
      (await writePackage(dest2, [tex], { includedKinds: NO_HDRI, includePersonalSettings: false }, makeDeps({ personalSettings: patch }))).ok
    ).toBe(true)
    expect(centralDirectory(dest2).some((e) => e.name === 'personal.json')).toBe(false)
  })

  it('⑥ 取消只停在新文件起点：收尾后删 .tmp，返回 canceled，无半包', async () => {
    const { tex, hdri } = await makeLibrary()
    const dest = path.join(root, 'cancel.zip')
    const events: string[] = []
    const deps = makeDeps({
      onProgress: (ev) => events.push(ev.phase),
      zipFactory: (tmpPath): PackageZipWriter => {
        const real = createArchiverZipWriter(tmpPath)
        return {
          ...real,
          appendFile: async (absPath, entryName, onChunk): Promise<void> => {
            await real.appendFile(absPath, entryName, (chunk) => {
              onChunk(chunk)
              if (entryName.endsWith(TEX_FILE)) cancelPackageExport()
            })
          }
        }
      }
    })

    const result = await writePackage(dest, [tex, hdri], { includedKinds: ALL_KINDS, includePersonalSettings: false }, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.canceled).toBe(true)
      expect(result.error).toBe('已取消导出')
    }
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(tmpPathFor(dest))).toBe(false)
    expect(events).toContain('assets')
  })

  it('⑦ 素材缺失 / 磁盘不足：失败即 unlink .tmp，不产半包', async () => {
    const { tex } = await makeLibrary()
    await fsp.unlink(path.join(root, ...`${TEX_REL_FOLDER}/${TEX_FILE}`.split('/')))

    const dest = path.join(root, 'missing.zip')
    const result = await writePackage(dest, [tex], { includedKinds: NO_HDRI, includePersonalSettings: false }, makeDeps())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('素材文件缺失')
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(tmpPathFor(dest))).toBe(false)

    const dest2 = path.join(root, 'no-space.zip')
    const result2 = await writePackage(dest2, [tex], { includedKinds: NO_HDRI, includePersonalSettings: false }, makeDeps({ diskFree: () => 1 }))
    expect(result2.ok).toBe(false)
    if (!result2.ok) {
      // F-3：真实数字与目标盘都要出现在报错里，不能只剩一句「请清理磁盘」。
      expect(result2.error).toContain('磁盘空间不足')
      expect(result2.error).toContain('目标盘')
      expect(result2.error).toContain('需要约')
      expect(result2.error).toContain('可用')
    }
    expect(fs.existsSync(tmpPathFor(dest2))).toBe(false)
  })

  it('⑧ 进度：assets 批次 + finalize 起止；默认文件名 C-7', async () => {
    await makeLibrary()
    const { tex } = await makeLibrary()
    const seen: Array<{ phase: string; done: number; total: number }> = []
    const dest = path.join(root, 'progress.zip')
    const result = await writePackage(
      dest,
      [tex],
      { includedKinds: NO_HDRI, includePersonalSettings: false },
      makeDeps({ onProgress: (ev) => seen.push(ev) })
    )
    expect(result.ok).toBe(true)
    expect(seen[0]).toEqual({ phase: 'assets', done: 0, total: 2 })
    expect(seen[1]).toEqual({ phase: 'assets', done: 2, total: 2 })
    expect(seen.at(-2)).toEqual({ phase: 'finalize', done: 0, total: 1 })
    expect(seen.at(-1)).toEqual({ phase: 'finalize', done: 1, total: 1 })
    expect(seen.some((e) => e.phase === 'finalize' && e.done === 0)).toBe(true)

    expect(defaultPackageFileName(new Date(2026, 10, 23, 8, 5))).toBe('IDBOX-Library-20261123-0805.zip')
  })

  it('⑨ 源码守卫：ZIP64/store/zlib.level=0、零网络、IPC 四通道接线', () => {
    const exporter = readSrc('src/main/packageExport.ts')
    expect(exporter).toContain('forceZip64: true')
    expect(exporter).toContain('store: true')
    expect(exporter).toContain('zlib: { level: 0 }')
    expect((exporter.match(/fetch\(/g) ?? []).length).toBe(0)
    expect((exporter.match(/net\./g) ?? []).length).toBe(0)
    expect(exporter.includes('sourceLibraryRoot:')).toBe(false)

    const main = readSrc('src/main/index.ts')
    for (const channel of ['packageExportPick', 'packageExport', 'packageExportProgress', 'packageExportCancel']) {
      expect(main).toContain(`IPC.${channel}`)
    }
    expect(main).toContain('writePackage(')
    expect(main).toContain('cancelPackageExport()')
  })
})
