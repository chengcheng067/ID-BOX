/**
 * 一键打包 · T3 导入链单测（docs/58 §2.4 / §3.2 / §3.3 / T3 卡，拍板 docs/57）。
 *
 * 全部用 `buildRawZip()` 在 `os.tmpdir()` 下造小包：能写入 adm-zip 会净化的恶意条目名
 * （`../evil` / 绝对路径 / 盘符）与加密标志位。磁盘断言只碰 tmp 目录，
 * **绝不碰真实库 E:/ModVault/Library**。
 *
 * 覆盖验收 1-8：验包只读、清单外 0 落盘、zip-slip 计数、folder 现算、坏包中文 reason、
 * 三档 resolution、逐文件 sha256、进度与源码守卫。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PACKAGE_API_VERSION,
  PACKAGE_ASSETS_PREFIX,
  PACKAGE_FORMAT_MAGIC,
  PACKAGE_FORMAT_VERSION,
  collectExpectedEntries,
  fromPortableAsset,
  toPortableAsset,
  type PackageManifest,
  type PersonalPatch,
  type PortableAsset
} from '../src/shared/packageFormat'
import type { Asset } from '../src/shared/types'
import {
  applyPackage,
  inspectPackage,
  type PackageExtractStats,
  type PackageImportDeps
} from '../src/main/packageImport'
import {
  createArchiverZipWriter,
  walkLibraryFiles,
  writePackage
} from '../src/main/packageExport'

// ── 夹具常量 ────────────────────────────────────────────────────────────────

const REL = '贴图/木纹/橡木/橡木地板-01'
const FILE = 'wood_4k.png'
const EXTRA = 'notes.txt'
const BYTES: Record<string, Buffer> = {
  [FILE]: Buffer.from('texture-bytes-0123456789', 'utf8'),
  [EXTRA]: Buffer.from('plain note\n', 'utf8')
}

let root = ''
let libDir = ''

function sha(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

// ── 原始 ZIP 写入器（可写任意条目名 / 任意 flag）────────────────────────────

interface RawEntry {
  name: string
  data: Buffer
  /** general purpose bit flag；默认 0x800（UTF-8 文件名）。 */
  flags?: number
  /** 仅加密测试用：手动指定压缩 / 未压缩尺寸以绕过 yauzl 的 stored-size 校验。 */
  compressedSize?: number
  uncompressedSize?: number
}

/**
 * 构造一个 store（method 0）的合法 zip 字节缓冲。
 * 之所以不用 adm-zip：它会把 `../evil.txt` 净化成 `evil.txt`，无法测 zip-slip。
 */
function buildRawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const flags = e.flags ?? 0x800
    const crc = crc32(e.data) >>> 0
    const compSize = e.compressedSize ?? e.data.length
    const uncompSize = e.uncompressedSize ?? e.data.length

    const local = Buffer.alloc(30 + nameBuf.length + e.data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compSize, 18)
    local.writeUInt32LE(uncompSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    e.data.copy(local, 30 + nameBuf.length)
    locals.push(local)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compSize, 20)
    central.writeUInt32LE(uncompSize, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

async function writeZip(fileName: string, entries: RawEntry[]): Promise<string> {
  const abs = path.join(root, fileName)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, buildRawZip(entries))
  return abs
}

// ── 合法包构造 ──────────────────────────────────────────────────────────────

function makeAsset(): Asset {
  return {
    id: 'asset-1',
    name: '橡木地板-01',
    kind: 'texture',
    source: '测试',
    folder: `E:\\NotARealLibrary\\${REL.split('/').join('\\')}`,
    relFolder: REL,
    files: [
      { rel: FILE, name: FILE, ext: 'png', size: BYTES[FILE].length, kind: 'texture' },
      { rel: EXTRA, name: EXTRA, ext: 'txt', size: BYTES[EXTRA].length, kind: 'texture' }
    ],
    size: BYTES[FILE].length + BYTES[EXTRA].length,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'texture:asset-1',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  }
}

function makeRecord(): PortableAsset {
  const rec = toPortableAsset(makeAsset())
  rec.files = rec.files.map((f) => ({ ...f, sha256: sha(BYTES[f.rel]) }))
  return rec
}

function makeManifest(indexText: string, count: number, personalText?: string): PackageManifest {
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT_MAGIC,
    formatVersion: PACKAGE_FORMAT_VERSION,
    apiVersion: PACKAGE_API_VERSION,
    appVersion: '1.1.0-test',
    generatedAt: '2026-11-23T08:30:00.000Z',
    count,
    assetsBytes: BYTES[FILE].length + BYTES[EXTRA].length,
    includedKinds: ['texture'],
    includePersonalSettings: personalText !== undefined,
    indexSha256: sha(indexText)
  }
  if (personalText !== undefined) manifest.personalSha256 = sha(personalText)
  return manifest
}

interface PackageParts {
  entries: RawEntry[]
  manifest: PackageManifest
  indexText: string
  record: PortableAsset
}

/** 造一个合法包的三件套 + 白名单素材条目（不附加任何伪造 / 恶意条目）。 */
function makePackage(overrides: {
  personal?: PersonalPatch
  manifestPatch?: (m: PackageManifest) => void
  indexPatch?: (records: PortableAsset[]) => PortableAsset[]
  includeAssets?: boolean
} = {}): PackageParts {
  const base = makeRecord()
  const records = overrides.indexPatch ? overrides.indexPatch([base]) : [base]
  const indexText = JSON.stringify(records)
  const personalText = overrides.personal === undefined ? undefined : JSON.stringify(overrides.personal)
  const manifest = makeManifest(indexText, records.length, personalText)
  overrides.manifestPatch?.(manifest)

  const entries: RawEntry[] = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'index.json', data: Buffer.from(indexText, 'utf8') }
  ]
  if (personalText !== undefined) entries.push({ name: 'personal.json', data: Buffer.from(personalText, 'utf8') })
  if (overrides.includeAssets !== false) {
    for (const rec of records) {
      for (const f of rec.files) {
        entries.push({ name: `${PACKAGE_ASSETS_PREFIX}${rec.relFolder}/${f.rel}`, data: BYTES[f.rel] })
      }
    }
  }
  return { entries, manifest, indexText, record: base }
}

function makeDeps(overrides: Partial<PackageImportDeps> = {}): PackageImportDeps {
  return {
    libraryDir: libDir,
    newId: (() => {
      let n = 0
      return () => `new-id-${++n}`
    })(),
    ...overrides
  }
}

function treeOf(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name)
      if (fs.statSync(abs).isDirectory()) walk(abs)
      else out.push(path.relative(dir, abs).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

function relFile(relFolder: string, fileRel: string): string {
  return path.join(libDir, ...relFolder.split('/'), ...fileRel.split('/'))
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'idbox-pack-import-'))
  libDir = path.join(root, 'library')
  await fsp.mkdir(libDir, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('T3 · inspectPackage 验包（只读）', () => {
  it('① 合法包：ok 带 manifest/records/personal；records 不含 folder；不写库、不解压素材', async () => {
    const personal: PersonalPatch = {
      homeWaveColors: {
        light: { waterColor: '#fff', crestColor: '#000' },
        dark: { waterColor: '#111', crestColor: '#222' }
      },
      customTaxonomy: { level1: [], level2: {} }
    }
    const parts = makePackage({ personal })
    const zipPath = await writeZip('valid.zip', parts.entries)
    const before = treeOf(libDir)

    const result = await inspectPackage(zipPath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.format).toBe(PACKAGE_FORMAT_MAGIC)
    expect(result.manifest.count).toBe(1)
    expect(result.records).toHaveLength(1)
    expect((result.records[0] as Record<string, unknown>).folder).toBeUndefined()
    expect(result.personal).toEqual(personal)
    // 只读：库目录没有任何新增文件，素材没被解压
    expect(treeOf(libDir)).toEqual(before)
    expect(fs.existsSync(relFile(REL, FILE))).toBe(false)
  })

  it('② 坏包 / 版本错 / apiVersion 错 / count 不符 / sha256 不符 / personal sha 不符 → 中文 reason', async () => {
    const badZip = path.join(root, 'bad.zip')
    await fsp.writeFile(badZip, Buffer.from('not a zip at all'))
    expect(await inspectPackage(badZip)).toEqual({ ok: false, reason: '素材包已损坏或不完整' })

    const badJson = await writeZip('badjson.zip', [
      { name: 'manifest.json', data: Buffer.from('{not json') },
      { name: 'index.json', data: Buffer.from('[]') }
    ])
    expect(await inspectPackage(badJson)).toEqual({ ok: false, reason: '素材包已损坏或不完整' })

    const version = makePackage({ manifestPatch: (m) => { (m as { formatVersion: number }).formatVersion = 99 } })
    const versionReason = await inspectPackage(await writeZip('version.zip', version.entries))
    expect(versionReason.ok).toBe(false)
    if (!versionReason.ok) expect(versionReason.reason).toContain('版本更新')

    const api = makePackage({ manifestPatch: (m) => { (m as { apiVersion: string }).apiVersion = '2' } })
    const apiReason = await inspectPackage(await writeZip('api.zip', api.entries))
    expect(apiReason.ok).toBe(false)
    if (!apiReason.ok) expect(apiReason.reason).toContain('格式不兼容')

    const count = makePackage({ manifestPatch: (m) => { m.count = 7 } })
    const countReason = await inspectPackage(await writeZip('count.zip', count.entries))
    expect(countReason.ok).toBe(false)
    if (!countReason.ok) expect(countReason.reason).toContain('不符')

    const sha = makePackage({ manifestPatch: (m) => { m.indexSha256 = '0'.repeat(64) } })
    const shaReason = await inspectPackage(await writeZip('sha.zip', sha.entries))
    expect(shaReason.ok).toBe(false)
    if (!shaReason.ok) expect(shaReason.reason).toContain('校验和')

    const personal = makePackage({
      personal: {
        homeWaveColors: {
          light: { waterColor: '#fff', crestColor: null },
          dark: { waterColor: null, crestColor: null }
        }
      },
      manifestPatch: (m) => { m.personalSha256 = 'f'.repeat(64) }
    })
    const personalReason = await inspectPackage(await writeZip('personal.zip', personal.entries))
    expect(personalReason.ok).toBe(false)
    if (!personalReason.ok) expect(personalReason.reason).toContain('个人设置校验和')
  })

  it('③ 加密包：强加密标志（bit 6）与传统加密标志（bit 0）都在 inspect 拦下', async () => {
    const parts = makePackage()
    // 强加密：yauzl 解析 central directory 时报 "strong encryption is not supported"
    const strong = parts.entries.map((e) =>
      e.name === 'manifest.json' ? { ...e, flags: (e.flags ?? 0x800) | 0x40 } : e
    )
    const strongResult = await inspectPackage(await writeZip('strong.zip', strong))
    expect(strongResult.ok).toBe(false)
    if (!strongResult.ok) expect(strongResult.reason).toContain('加密压缩包')

    // 传统加密：bit 0 + stored 条目尺寸 = 未压缩 + 12（yauzl 校验通过后才 emit entry）
    const traditional = parts.entries.map((e) => {
      if (e.name !== 'index.json') return e
      const data = Buffer.concat([Buffer.alloc(12), e.data])
      return {
        ...e,
        flags: (e.flags ?? 0x800) | 0x1,
        data,
        compressedSize: data.length,
        uncompressedSize: e.data.length
      }
    })
    const tradResult = await inspectPackage(await writeZip('traditional.zip', traditional))
    expect(tradResult.ok).toBe(false)
    if (!tradResult.ok) expect(tradResult.reason).toContain('加密压缩包')
  })

  it('④ 清单外记录路径 / 重复 id / 非法 relFolder 在 validateIndex 阶段拦下', async () => {
    const dup = makePackage({
      indexPatch: (records) => [records[0], { ...records[0] }]
    })
    const dupResult = await inspectPackage(await writeZip('dup.zip', dup.entries))
    expect(dupResult.ok).toBe(false)
    if (!dupResult.ok) expect(dupResult.reason).toContain('重复')

    const slipFolder = makePackage({
      indexPatch: (records) => [{ ...records[0], relFolder: '../../evil/x/y/z' }]
    })
    const slipResult = await inspectPackage(await writeZip('slipfolder.zip', slipFolder.entries))
    expect(slipResult.ok).toBe(false)
    if (!slipResult.ok) expect(slipResult.reason).toContain('路径不合法')
  })
})

describe('T3 · applyPackage 按清单精确提取', () => {
  it('⑤ 清单外伪造条目 0 落盘 + 白名单条目全到；清单外计数上报', async () => {
    const parts = makePackage()
    const forged = [...parts.entries,
      { name: 'assets/.cache/hidden.png', data: Buffer.from('cache') },
      { name: 'assets/贴图/木纹/橡木/橡木地板-01/forged.png', data: Buffer.from('forged') },
      { name: 'extra/readme.txt', data: Buffer.from('junk') },
      { name: 'personal.json.bak', data: Buffer.from('bak') }
    ]
    const zipPath = await writeZip('forged.zip', forged)
    let stats: PackageExtractStats | null = null
    const progresses: Array<{ done: number; total: number }> = []

    const result = await applyPackage(zipPath, {}, makeDeps({
      onStats: (s) => { stats = s },
      onProgress: (ev) => progresses.push({ done: ev.done, total: ev.total })
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.restored).toHaveLength(1)
    // 白名单两条素材全到，伪造的 4 条一个都没落盘
    expect(fs.existsSync(relFile(REL, FILE))).toBe(true)
    expect(fs.existsSync(relFile(REL, EXTRA))).toBe(true)
    expect(fs.readFileSync(relFile(REL, FILE))).toEqual(BYTES[FILE])
    expect(treeOf(libDir)).toEqual([
      `${REL}/${EXTRA}`,
      `${REL}/${FILE}`
    ].sort())
    expect(stats).not.toBeNull()
    const s = stats as unknown as PackageExtractStats
    expect(s.extracted).toBe(2)
    expect(s.skippedOutsideWhitelist).toBe(4)
    expect(s.missing).toEqual([])
    // 进度：首帧 0，末帧 done==total
    expect(progresses[0]).toEqual({ done: 0, total: 2 })
    expect(progresses[progresses.length - 1]).toEqual({ done: 2, total: 2 })
  })

  it('⑥ zip-slip 条目（../ / 绝对 / 盘符）跳过并计数，不写出库外', async () => {
    const parts = makePackage()
    const withSlip = [...parts.entries,
      { name: '../evil.txt', data: Buffer.from('escape') },
      { name: '/absolute/evil.txt', data: Buffer.from('escape') },
      { name: 'C:/windows/evil.txt', data: Buffer.from('escape') },
      { name: 'assets/../../evil.txt', data: Buffer.from('escape') }
    ]
    const zipPath = await writeZip('slip.zip', withSlip)
    let stats: PackageExtractStats | null = null

    const result = await applyPackage(zipPath, {}, makeDeps({ onStats: (s) => { stats = s } }))

    expect(result.ok).toBe(true)
    const s = stats as unknown as PackageExtractStats
    expect(s.skippedZipSlip).toBe(4)
    expect(s.extracted).toBe(2)
    // 库外没有任何逃逸文件
    expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(root), 'evil.txt'))).toBe(false)
    expect(treeOf(libDir)).toEqual([`${REL}/${EXTRA}`, `${REL}/${FILE}`].sort())
  })

  it('⑦ fromPortableAsset 补的 folder == path.join(libDir, relFolder)，缓存字段清空', async () => {
    const parts = makePackage()
    const result = await applyPackage(await writeZip('folder.zip', parts.entries), {}, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const asset = result.restored[0]
    expect(asset.folder).toBe(path.join(libDir, REL))
    expect(asset.thumbPath).toBeUndefined()
    expect(asset.thumbStatus).toBe('none')
  })

  it('⑧ 逐文件 sha256（C-2）不符 → 拒绝对该文件落盘并返回中文 error', async () => {
    const parts = makePackage()
    // 篡改包内素材字节，但 index.json 里的 sha256 不变（包级 indexSha256 仍匹配）
    const tampered = parts.entries.map((e) =>
      e.name === `${PACKAGE_ASSETS_PREFIX}${REL}/${FILE}`
        ? { ...e, data: Buffer.from('TAMPERED-BYTES') }
        : e
    )
    let stats: PackageExtractStats | null = null
    const result = await applyPackage(
      await writeZip('tampered.zip', tampered), {}, makeDeps({ onStats: (s) => { stats = s } })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('校验失败')
    expect((stats as unknown as PackageExtractStats).shaMismatch).toBe(1)
    // 被篡改文件没落盘（notes.txt 可能已落，但 wood_4k.png 绝不落）
    expect(fs.existsSync(relFile(REL, FILE))).toBe(false)
  })

  it('⑨ resolution=skip / overwrite / keep-both 三档落盘行为正确（keep-both 不覆盖原件）', async () => {
    const parts = makePackage()
    const zipPath = await writeZip('res.zip', parts.entries)

    // 预先在库里放一份「原件」，字节不同于包内
    const originalRel = REL
    const originalBytes = Buffer.from('ORIGINAL-ON-DISK')
    await fsp.mkdir(path.dirname(relFile(originalRel, FILE)), { recursive: true })
    await fsp.writeFile(relFile(originalRel, FILE), originalBytes)

    // skip：完全不落盘，restored 不含该记录
    const skipDir = path.join(root, 'skip-lib')
    await fsp.mkdir(skipDir, { recursive: true })
    const skipResult = await applyPackage(zipPath, { [parts.record.id]: 'skip' }, makeDeps({ libraryDir: skipDir }))
    expect(skipResult.ok).toBe(true)
    if (skipResult.ok) expect(skipResult.restored).toHaveLength(0)
    expect(treeOf(skipDir)).toEqual([])

    // overwrite：包内字节覆盖原件，restored 仍 1 条，id 不变
    const owResult = await applyPackage(zipPath, { [parts.record.id]: 'overwrite' }, makeDeps())
    expect(owResult.ok).toBe(true)
    if (owResult.ok) {
      expect(owResult.restored).toHaveLength(1)
      expect(owResult.restored[0].id).toBe(parts.record.id)
    }
    expect(fs.readFileSync(relFile(REL, FILE))).toEqual(BYTES[FILE])

    // keep-both：原件字节不变，新目录 -2 落包内字节，新 id
    await fsp.writeFile(relFile(REL, FILE), originalBytes) // 复位成原件
    const kbResult = await applyPackage(zipPath, { [parts.record.id]: 'keep-both' }, makeDeps())
    expect(kbResult.ok).toBe(true)
    if (!kbResult.ok) return
    expect(kbResult.restored).toHaveLength(1)
    expect(kbResult.restored[0].id).not.toBe(parts.record.id)
    expect(kbResult.restored[0].relFolder).toBe(`${REL}-2`)
    expect(kbResult.restored[0].folder).toBe(path.join(libDir, `${REL}-2`))
    expect(fs.readFileSync(relFile(REL, FILE))).toEqual(originalBytes) // 原件未被覆盖
    expect(fs.readFileSync(relFile(`${REL}-2`, FILE))).toEqual(BYTES[FILE]) // 副本落新目录
  })

  it('⑩ 未给 resolution 的记录按 overwrite 处理（空库直导）', async () => {
    const parts = makePackage()
    const result = await applyPackage(await writeZip('default.zip', parts.entries), {}, makeDeps())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.restored[0].id).toBe(parts.record.id)
    expect(fs.readFileSync(relFile(REL, FILE))).toEqual(BYTES[FILE])
  })

  it('⑪ 清单声明但 zip 内缺素材 → 坏包 error（提取阶段 missing 检查）', async () => {
    const parts = makePackage({ includeAssets: false })
    const result = await applyPackage(
      await writeZip('missing-asset.zip', parts.entries), {}, makeDeps()
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('不完整')
  })
})

describe('T3 · T2→T3 真实往返', () => {
  it('⑮ T2 writePackage 产出的真包 → inspect + apply 全绿（ZIP64/store/逐文件 sha256 端到端）', async () => {
    // 用 T2 的真实 archiver 写手产包：素材按 relFolder 铺在源库，walkLibraryFiles 流式扫。
    const srcLib = path.join(root, 'src-lib')
    for (const [rel, bytes] of Object.entries(BYTES)) {
      const abs = path.join(srcLib, ...REL.split('/'), rel)
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, bytes)
    }
    const dest = path.join(root, 'roundtrip.zip')
    const writeResult = await writePackage(dest, [makeRecord()],
      { includedKinds: ['texture'], includePersonalSettings: false },
      {
        libraryDir: srcLib,
        diskFree: () => 1024 * 1024 * 1024,
        walk: walkLibraryFiles,
        zipFactory: createArchiverZipWriter,
        now: () => new Date('2026-11-23T08:30:00.000Z'),
        appVersion: '1.1.0-test'
      }
    )
    expect(writeResult.ok).toBe(true)

    const inspected = await inspectPackage(dest)
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.records).toHaveLength(1)

    const targetLib = path.join(root, 'target-lib')
    await fsp.mkdir(targetLib, { recursive: true })
    let stats: PackageExtractStats | null = null
    const result = await applyPackage(dest, {}, makeDeps({
      libraryDir: targetLib,
      onStats: (s) => { stats = s }
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.restored[0].folder).toBe(path.join(targetLib, REL))
    expect(fs.readFileSync(relFileFor(targetLib, REL, FILE))).toEqual(BYTES[FILE])
    expect(fs.readFileSync(relFileFor(targetLib, REL, EXTRA))).toEqual(BYTES[EXTRA])
    expect((stats as unknown as PackageExtractStats).skippedOutsideWhitelist).toBe(0)
  })
})

function relFileFor(base: string, relFolder: string, fileRel: string): string {
  return path.join(base, ...relFolder.split('/'), ...fileRel.split('/'))
}

describe('T3 · 源码守卫', () => {
  it('⑫ inspect 源码零写入 / 全模块无批量 clear-delete / IPC 四通道接线', () => {
    const src = readSrc('src/main/packageImport.ts')
    const inspectStart = src.indexOf('export async function inspectPackage')
    const inspectEnd = src.indexOf('export async function extractByWhitelist')
    const inspectBody = src.slice(inspectStart, inspectEnd)
    // 验包路径不写盘、不解压、不 rename
    expect(inspectBody).not.toMatch(/createWrite|writeFile|fsp\.write|\.rename\(|\.unlink\(|mkdir\(/)
    expect(inspectBody).not.toMatch(/=\s*await\s+extractByWhitelist\s*\(/)
    // 全模块不误删：无批量清空 / 删除
    expect(src).not.toMatch(/\.clear\(/)
    expect(src).not.toMatch(/bulkDelete|deleteAll|rmrf/)
    // 复用 T1 纯函数（不重写校验器）
    for (const fn of ['collectExpectedEntries', 'fromPortableAsset', 'validateIndex', 'validateManifest', 'parseIndex', 'parseManifest']) {
      expect(src).toContain(fn)
    }
    // 零网络
    expect((src.match(/fetch\(/g) ?? []).length).toBe(0)

    const main = readSrc('src/main/index.ts')
    for (const channel of ['packageImportPick', 'packageImportInspect', 'packageImportApply', 'packageImportProgress']) {
      expect(main).toContain(`IPC.${channel}`)
    }
    expect(main).toContain('inspectPackage(')
    expect(main).toContain('applyPackage(')
    expect(main).toContain('showOpenDialog')
  })

  it('⑬ validateIndex 第三参（index 落盘文本 sha256）在 inspect 里必传', () => {
    const src = readSrc('src/main/packageImport.ts')
    expect(src).toMatch(/validateIndex\(records,\s*manifest,\s*sha256Of\(indexText\)\)/)
  })
})

// 引用 collectExpectedEntries：确保白名单口径与本测试的文件名约定一致（判据②的白名单基数）
describe('T3 · 白名单口径自检', () => {
  it('⑭ collectExpectedEntries 只收 files[] 声明的两条', () => {
    const expected = collectExpectedEntries([makeRecord()])
    expect([...expected].sort()).toEqual([
      `${PACKAGE_ASSETS_PREFIX}${REL}/${EXTRA}`,
      `${PACKAGE_ASSETS_PREFIX}${REL}/${FILE}`
    ].sort())
    // fromPortableAsset 是纯函数：不改入参
    const rec = makeRecord()
    const before = JSON.stringify(rec)
    fromPortableAsset(rec, libDir)
    expect(JSON.stringify(rec)).toBe(before)
  })
})
