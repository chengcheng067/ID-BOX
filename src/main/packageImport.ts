/**
 * 一键打包 · T3 导入链：验包 + 按清单精确提取（docs/58 §2.1 / §2.4 / §3.2 / §3.3，拍板 docs/57）。
 *
 * ## 分层
 *
 * 本模块**不 import electron**：验包 / 解包 / 落盘 / 进度全部由依赖注入驱动，
 * 对话框与 `webContents.send` 由 `main/index.ts` 负责。vitest 用 `os.tmpdir()` 小包
 * 端到端验证，无需真库、无需 electron。
 *
 * ## 硬约束（用户拍板，勿改）
 *
 * - Q-2：`collectExpectedEntries(records)` 是白名单**唯一依据**；清单外条目（含缓存 /
 *   隐藏目录 / 伪造文件）一律跳过、不落盘、不误删；跳过项计数上报。
 * - Q-5：`folder` 用 `fromPortableAsset(record, libraryDir)` 现算（`path.join` 语义），
 *   绝不信任包内绝对路径；落盘路径由清单的 `relFolder` + `files[].rel` 重建，
 *   再经 `isWithinRoot` 二次守卫，双重防 zip-slip。
 * - Q-6：不做自动合并。按 `resolutions[Asset.id]` 执行 skip / overwrite / keep-both；
 *   keep-both 用 `uniqueName()` 对 relFolder 末段加 `-2` 并换新 UUID（docs/58 §8 C-6），
 *   原件不被覆盖。
 * - C-2：逐文件 sha256 在**提取阶段**做（包级 indexSha256 由 `inspect` 做）；
 *   先写 `.part` 临时文件 + 流式哈希，校验通过才 rename，绝不留坏文件。
 * - 坏包 / 版本错 / 加密包 / 条数不符 / sha256 不符：全部在 `inspect` 阶段拦下，不进提取。
 * - 零网络：本文件只用 node 文件系统 / 加密 API 与 yauzl，不发起任何网络请求。
 */

import fsp from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import yauzl, { type Entry, type ZipFile } from 'yauzl'

import {
  PERSONAL_SETTINGS_KEYS,
  PACKAGE_ASSETS_PREFIX,
  collectExpectedEntries,
  fromPortableAsset,
  parseIndex,
  parseManifest,
  validateIndex,
  validateManifest,
  type PackageImportProgressEvent,
  type PackageImportResult,
  type PackageInspectResult,
  type PackageManifest,
  type PackageResolution,
  type PackageResolutions,
  type PersonalPatch,
  type PortableAsset
} from '../shared/packageFormat'
import { uniqueName } from '../shared/naming'
import { isWithinRoot } from '../shared/vault'
import type { Asset } from '../shared/types'

// ── 公共类型 ────────────────────────────────────────────────────────────────

/** 打开 zip 的窄接口：默认 yauzl.open(lazyEntries)，测试可注入。 */
export type PackageZipOpener = (
  zipPath: string,
  callback: (err: Error | null, zip: ZipFile | null) => void
) => void

/**
 * 默认开包器：lazyEntries + 自动 close + 条目尺寸校验。
 *
 * 关键：`decodeStrings:false` —— yauzl 在 `decodeStrings:true` 时会用 `validateFileName`
 * 直接把含 `../` / 绝对路径 / 盘符的条目判为坏包并 emit error，导致**整包**在 inspect 阶段
 * 被拒，zip-slip 条目就没有机会走「跳过 + 计数」通道（docs/57:25 / 验收③）。设为 false
 * 后 yauzl 把条目名原样交给本模块，由 `isZipSlip` / 白名单统一裁决；文件名在 `entryNameOf`
 * 里自行按 utf8 解码（导出端用 UTF-8 写中文路径，字节即 utf8）。
 */
export const defaultZipOpener: PackageZipOpener = (zipPath, callback) => {
  yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: false }, callback)
}

/**
 * 三件套契约文件：验包阶段已读，提取阶段必须跳过，且**不计入**「清单外内容」计数
 * （它们是包自身的元数据，不是用户口中的「非清单内容」）。
 */
const PACKAGE_META_ENTRIES = new Set<string>(['manifest.json', 'index.json', 'personal.json'])

/** 提取阶段的跳过统计（docs/57:25「N 个非清单内容已跳过」口径）。 */
export interface PackageExtractStats {
  /** 成功落盘（sha256 校验通过）的白名单文件数。 */
  extracted: number
  /** 清单外 / 缓存 / 隐藏目录条目数（伪造条目计入这里）。 */
  skippedOutsideWhitelist: number
  /** zip-slip 条目数（`../` / 绝对路径 / 盘符 / 反斜杠）。 */
  skippedZipSlip: number
  /** 加密条目数（正常包为 0；inspect 已先拦截）。 */
  skippedEncrypted: number
  /** 被 resolution='skip' 明确跳过的白名单文件数。 */
  skippedByResolution: number
  /** 逐文件 sha256 不符而拒绝落盘的文件数。 */
  shaMismatch: number
  /** 清单声明但 zip 内缺失的白名单条目名。 */
  missing: string[]
}

/** `applyPackage` 的全部外部依赖；主进程一项不缺地传，测试逐项注入。 */
export interface PackageImportDeps {
  /** 素材库根目录（records 的 relFolder 相对于它；`libraryDir` 永不从包内读取）。 */
  libraryDir: string
  /** 开 zip 工厂；默认 `defaultZipOpener`。 */
  zipOpener?: PackageZipOpener
  /** 递归建目录；默认 `fsp.mkdir({recursive:true})`。 */
  mkdir?: (dir: string) => Promise<void>
  /** 建写流（流式落盘 + 便于测试观测）；默认 `createWriteStream`。 */
  createWrite?: (file: string) => Writable
  /** 路径是否已存在（keep-both 判重用）；默认 `existsSync`。 */
  exists?: (p: string) => boolean
  /** 删文件（清 `.part`）；默认 `fsp.unlink`。 */
  unlink?: (file: string) => Promise<void>
  /** 原子改名（`.part` → 目标）；默认 `fsp.rename`。 */
  rename?: (from: string, to: string) => Promise<void>
  /** keep-both 新资产 id；默认 `crypto.randomUUID`。 */
  newId?: () => string
  /** 落盘时刻（保留注入位，未来日志用）；默认 `new Date`。 */
  now?: () => Date
  /** 每成功落盘一个白名单条目回调一次。 */
  onProgress?: (ev: PackageImportProgressEvent) => void
  /** 提取结束回调一次跳过统计。 */
  onStats?: (stats: PackageExtractStats) => void
}

/** 已解析（默认值补齐）的依赖；内部使用。 */
type ResolvedDeps = PackageImportDeps & {
  zipOpener: PackageZipOpener
  mkdir: (dir: string) => Promise<void>
  createWrite: (file: string) => Writable
  exists: (p: string) => boolean
  unlink: (file: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  newId: () => string
  now: () => Date
}

/** 提取计划里的一条：说明「zip 里哪个条目 → 库里哪个路径 + 用什么裁决」。 */
export interface PackageExtractEntry {
  /** zip 内条目名（`assets/<relFolder>/<file.rel>`）。 */
  entryName: string
  /** 所属记录 id（用于取 resolution）。 */
  recordId: string
  /** 清单里的原始 relFolder（zip 条目名的一部分，绝不作为落盘路径）。 */
  relFolder: string
  /** 实际落盘用的 relFolder（keep-both 时为加后缀的新目录）。 */
  targetRelFolder: string
  /** 相对资产文件夹的文件路径。 */
  fileRel: string
  /** 该记录的裁决档。 */
  resolution: PackageResolution
  /** C-2 期望的逐文件 sha256（缺失则跳过该文件的哈希比对）。 */
  sha256?: string
}

/** 完整提取计划：条目表 + 记录级 relFolder / id 改写表。 */
export interface PackageExtractPlan {
  entries: Map<string, PackageExtractEntry>
  /** 记录 id → 实际落盘 relFolder（keep-both 被改写）。 */
  folderByRecordId: Map<string, string>
  /** 记录 id → 新 id（keep-both 才写入，避免 bulkPut 覆盖原件）。 */
  idByRecordId: Map<string, string>
  /** 非 skip 的可提取条目总数（进度 total）。 */
  extractableTotal: number
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * 条目名归一：`decodeStrings:false` 下 yauzl 把 `fileName` 原样留成 Buffer（utf8 字节），
 * 这里统一解码成字符串；同时兼容 `decodeStrings:true`（已是 string）与注入的假 zip。
 */
function entryNameOf(entry: Entry): string {
  const raw = entry.fileName as unknown
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  return String(raw ?? '')
}

/** 判断 yauzl 抛出的错误是否属于「加密包」；给 inspect 一个中文专属原因。 */
function isEncryptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /encrypt|password|口令|密码/i.test(msg)
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function resolveDeps(deps: PackageImportDeps): ResolvedDeps {
  return {
    ...deps,
    zipOpener: deps.zipOpener ?? defaultZipOpener,
    mkdir: deps.mkdir ?? (async (dir) => {
      await fsp.mkdir(dir, { recursive: true })
    }),
    createWrite: deps.createWrite ?? ((file) => createWriteStream(file)),
    exists: deps.exists ?? existsSync,
    unlink: deps.unlink ?? ((file) => fsp.unlink(file)),
    rename: deps.rename ?? ((from, to) => fsp.rename(from, to)),
    newId: deps.newId ?? (() => randomUUID()),
    now: deps.now ?? (() => new Date())
  }
}

function emitProgress(deps: ResolvedDeps, ev: PackageImportProgressEvent): void {
  if (typeof deps.onProgress !== 'function') return
  try {
    deps.onProgress(ev)
  } catch {
    /* 进度回调是观测通道：它自己炸了不能把导入带崩 */
  }
}

function emitStats(deps: ResolvedDeps, stats: PackageExtractStats): void {
  if (typeof deps.onStats !== 'function') return
  try {
    deps.onStats(stats)
  } catch {
    /* 同上 */
  }
}

/** 打开 zip 并等 central directory 就绪（lazyEntries 的 open 回调）。 */
function openZip(deps: ResolvedDeps, zipPath: string): Promise<ZipFile> {
  return new Promise<ZipFile>((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, zip: ZipFile | null): void => {
      if (settled) return
      settled = true
      if (err !== null || zip === null) reject(err ?? new Error('无法打开素材包'))
      else resolve(zip)
    }
    try {
      deps.zipOpener(zipPath, done)
    } catch (err) {
      done(asError(err), null)
    }
  })
}

/** 关闭 zip（重复关闭 / 已自动关闭都吞掉）。 */
function closeZip(zip: ZipFile): void {
  try {
    zip.close()
  } catch {
    /* 已随 'end' 自动关闭 */
  }
}

/**
 * lazyEntries 顺序遍历器：一次只发一个 'entry'，等 `onEntry` 完成才 `readEntry()`，
 * 避免并发开流导致句柄失控；'end' / 'error' / 提前失败都收敛到同一个 settle。
 */
function forEachZipEntry(zip: ZipFile, onEntry: (entry: Entry) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let detach = (): void => {
      /* 初始化前不会被调用 */
    }
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      detach()
      if (err !== undefined) {
        closeZip(zip)
        reject(err)
      } else {
        resolve()
      }
    }
    const onEntryEvent = (entry: Entry): void => {
      void Promise.resolve()
        .then(() => onEntry(entry))
        .then(() => {
          if (!settled) zip.readEntry()
        })
        .catch((err: unknown) => finish(asError(err)))
    }
    const onEndEvent = (): void => finish()
    const onErrorEvent = (err: Error): void => finish(asError(err))
    detach = (): void => {
      zip.removeListener('entry', onEntryEvent)
      zip.removeListener('end', onEndEvent)
      zip.removeListener('error', onErrorEvent)
    }
    zip.on('entry', onEntryEvent)
    zip.on('end', onEndEvent)
    zip.on('error', onErrorEvent)
    zip.readEntry()
  })
}

/** yauzl 开流 → Promise（加密 / 不支持压缩方法的条目会在此报错）。 */
function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise<Readable>((resolve, reject) => {
    try {
      zip.openReadStream(entry, (err: Error | null, stream: Readable | null) => {
        if (err !== null || stream === null) reject(err ?? new Error('读取素材包内容失败'))
        else resolve(stream)
      })
    } catch (err) {
      reject(asError(err))
    }
  })
}

/** 读流全部字节（只用于三件套 JSON 文本，素材字节永不整包进内存）。 */
function readStreamBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', (err: Error) => reject(err))
  })
}

/** zip-slip 守卫：父目录穿越 / 绝对路径 / 盘符 / 反斜杠分隔一律拒绝。 */
function isZipSlip(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return true
  if (name.includes('\\')) return true
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').some((seg) => seg === '..')
}

/** 读 central directory 需要的三个 JSON 文本；同时检测任意条目的加密标志。 */
async function readPackageTexts(
  zip: ZipFile
): Promise<{ texts: Map<string, string>; encrypted: boolean }> {
  const texts = new Map<string, string>()
  let encrypted = false
  const wanted = new Set<string>(['manifest.json', 'index.json', 'personal.json'])
  await forEachZipEntry(zip, async (entry) => {
    if (entry.isEncrypted()) {
      encrypted = true
      return
    }
    const name = entryNameOf(entry)
    if (!wanted.has(name)) return
    const buffer = await readStreamBuffer(await openEntryStream(zip, entry))
    texts.set(name, buffer.toString('utf8'))
  })
  return { texts, encrypted }
}

/** personal.json → PersonalPatch（只保留 11 键白名单，机器路径键永不进内存结果）。 */
function parsePersonalPatch(text: string): PersonalPatch | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const patch: PersonalPatch = {}
  const source = raw as Record<string, unknown>
  const target = patch as Record<string, unknown>
  for (const key of PERSONAL_SETTINGS_KEYS) {
    const value = source[key]
    if (value !== undefined) target[key] = value
  }
  return patch
}

/**
 * keep-both 的新 relFolder：末段走 `uniqueName()` 加 -2/-3…，同时避开磁盘已有目录
 * 与本批次已分配目录（docs/58 §8 C-6）。
 */
function uniqueRelFolder(
  relFolder: string,
  libraryDir: string,
  taken: Set<string>,
  exists: (p: string) => boolean
): string {
  const parts = relFolder.split('/')
  const base = parts[parts.length - 1] || 'asset'
  const parent = parts.slice(0, -1)
  const candidates = new Set<string>(taken)
  let pick = uniqueName(base, candidates)
  while (candidates.has(pick) || exists(path.join(libraryDir, ...parent, pick))) {
    candidates.add(pick)
    pick = uniqueName(base, candidates)
  }
  candidates.add(pick)
  for (const c of candidates) taken.add(c)
  return [...parent, pick].join('/')
}

/**
 * 由 manifest 校验后的 records 生成提取计划。
 *
 * `collectExpectedEntries` 是白名单唯一依据（Q-2）：plan 里只放它承认的条目；
 * 记录级 resolution 决定 skip / 落原目录 / keep-both 改目录 + 换 id。
 */
function buildExtractPlan(
  records: PortableAsset[],
  resolutions: PackageResolutions,
  deps: ResolvedDeps
): PackageExtractPlan {
  const expected = collectExpectedEntries(records)
  const entries = new Map<string, PackageExtractEntry>()
  const folderByRecordId = new Map<string, string>()
  const idByRecordId = new Map<string, string>()
  const takenFolders = new Set<string>()
  let extractableTotal = 0

  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue
    const resolution: PackageResolution = resolutions[record.id] ?? 'overwrite'
    let targetRelFolder = record.relFolder
    if (resolution === 'keep-both') {
      targetRelFolder = uniqueRelFolder(record.relFolder, deps.libraryDir, takenFolders, deps.exists)
      idByRecordId.set(record.id, deps.newId())
    }
    folderByRecordId.set(record.id, targetRelFolder)

    for (const file of record.files ?? []) {
      const entryName = `${PACKAGE_ASSETS_PREFIX}${record.relFolder}/${file.rel}`
      if (!expected.has(entryName)) continue
      entries.set(entryName, {
        entryName,
        recordId: record.id,
        relFolder: record.relFolder,
        targetRelFolder,
        fileRel: file.rel,
        resolution,
        sha256: file.sha256
      })
      if (resolution !== 'skip') extractableTotal += 1
    }
  }
  return { entries, folderByRecordId, idByRecordId, extractableTotal }
}

/**
 * 单个素材条目：开流 → 写 `.part` → 流式 sha256 → 比对通过才 rename。
 * 返回 false 表示 sha 不符（`.part` 已删，目标路径未被污染）。
 */
async function extractOneFile(
  zip: ZipFile,
  entry: Entry,
  targetEntry: PackageExtractEntry,
  targetDir: string,
  deps: ResolvedDeps
): Promise<boolean> {
  const relParts = targetEntry.targetRelFolder.split('/')
  const fileParts = targetEntry.fileRel.split('/')
  const finalPath = path.resolve(targetDir, ...relParts, ...fileParts)
  // Q-5 二次守卫：即便清单被绕过，解析后的绝对路径也必须仍在库根内。
  if (!isWithinRoot(path.resolve(targetDir), finalPath, path.sep)) return false

  await deps.mkdir(path.dirname(finalPath))
  const partPath = `${finalPath}.part-${randomUUID().slice(0, 8)}`
  const hash = createHash('sha256')
  try {
    const stream = await openEntryStream(zip, entry)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    const output = deps.createWrite(partPath)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err !== undefined) reject(err)
        else resolve()
      }
      // Windows 上必须先等写流 'close'（fd 释放）再 rename，否则 EPERM；
      // 'finish' 只作为注入型 Writable 不发 'close' 时的兜底（延后一拍让 close 先到）。
      output.on('close', () => done())
      output.on('finish', () => {
        setImmediate(() => done())
      })
      output.on('error', (err: Error) => done(err))
      stream.on('error', (err: Error) => done(err))
      stream.pipe(output)
    })
    const actual = hash.digest('hex')
    if (
      typeof targetEntry.sha256 === 'string' &&
      targetEntry.sha256.length > 0 &&
      actual !== targetEntry.sha256
    ) {
      await deps.unlink(partPath).catch(() => undefined)
      return false
    }
    await deps.rename(partPath, finalPath)
    return true
  } catch (err) {
    await deps.unlink(partPath).catch(() => undefined)
    throw err
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 三个 T3 公共函数
// ════════════════════════════════════════════════════════════════════════════

/**
 * `inspectPackage(packagePath, deps?)` —— **只读**验包，不改库、不解压素材。
 *
 * yauzl lazyEntries 只读 central directory + 三件套 JSON 文本，依次过
 * `parseManifest` → `validateManifest` → `parseIndex` → `validateIndex(records, manifest, sha256(indexText))`
 * （第三参**必传**，包级 C-2）。加密 / 坏 zip / 版本错 / 条数不符 / sha256 不符都在此
 * 返回中文 `reason`，绝不进提取阶段。
 *
 * 返回 `ok:false` 永不抛错；进度 / 落盘依赖在验包阶段不会被调用。
 */
export async function inspectPackage(
  packagePath: string,
  deps: Partial<PackageImportDeps> = {}
): Promise<PackageInspectResult> {
  const resolved = resolveDeps({ ...deps, libraryDir: '' })
  try {
    if (typeof packagePath !== 'string' || packagePath.length === 0) {
      return { ok: false, reason: '素材包路径无效' }
    }
    const zip = await openZip(resolved, packagePath)
    let texts: Map<string, string>
    let encrypted: boolean
    try {
      const read = await readPackageTexts(zip)
      texts = read.texts
      encrypted = read.encrypted
    } finally {
      closeZip(zip)
    }

    if (encrypted) {
      return { ok: false, reason: '这是加密压缩包，请在导出时不要设置密码' }
    }
    const manifestText = texts.get('manifest.json')
    const indexText = texts.get('index.json')
    if (manifestText === undefined || indexText === undefined) {
      return { ok: false, reason: '素材包已损坏或不完整' }
    }

    const manifest: PackageManifest | null = parseManifest(manifestText)
    if (manifest === null) return { ok: false, reason: '素材包已损坏或不完整' }
    const manifestError = validateManifest(manifest)
    if (manifestError !== null) return { ok: false, reason: manifestError }

    const records: PortableAsset[] | null = parseIndex(indexText)
    if (records === null) return { ok: false, reason: '素材包索引格式错误' }
    // C-2 包级校验：第三参必传，用 index.json **落盘文本**算 sha256。
    const indexError = validateIndex(records, manifest, sha256Of(indexText))
    if (indexError !== null) return { ok: false, reason: indexError }

    let personal: PersonalPatch | undefined
    const personalText = texts.get('personal.json')
    if (personalText !== undefined) {
      if (
        typeof manifest.personalSha256 !== 'string' ||
        sha256Of(personalText) !== manifest.personalSha256
      ) {
        return { ok: false, reason: '素材包个人设置校验和不符，文件可能已损坏' }
      }
      personal = parsePersonalPatch(personalText)
    }

    return personal === undefined
      ? { ok: true, manifest, records }
      : { ok: true, manifest, records, personal }
  } catch (err) {
    // 强加密（bit 0x40）等 yauzl 在解析期就 emit error 的情况，给专属中文原因；
    // 其余坏 zip / 压缩方法不支持统一中文原因，不暴露路径或内部词。
    if (isEncryptionError(err)) {
      return { ok: false, reason: '这是加密压缩包，请在导出时不要设置密码' }
    }
    return { ok: false, reason: '素材包已损坏或不完整' }
  }
}

/**
 * `extractByWhitelist(zip, entries, targetDir, deps)` —— 流式提取 + 跳过统计。
 *
 * 只处理 `entries`（= `collectExpectedEntries` 收口出的白名单）里的条目：
 * - zip-slip / 加密 / 清单外 / resolution=skip 一律跳过并分别计数；
 * - 落盘路径由清单字段重建 + `isWithinRoot` 二次守卫；
 * - 逐文件 sha256 不符拒绝落盘（写 `.part` 不落最终名）。
 *
 * 注意：调用方负责 `zip` 的生命周期（打开 / 关闭）。
 */
export async function extractByWhitelist(
  zip: ZipFile,
  entries: Map<string, PackageExtractEntry>,
  targetDir: string,
  deps: PackageImportDeps
): Promise<PackageExtractStats> {
  const resolved = resolveDeps({ ...deps, libraryDir: targetDir })
  const stats: PackageExtractStats = {
    extracted: 0,
    skippedOutsideWhitelist: 0,
    skippedZipSlip: 0,
    skippedEncrypted: 0,
    skippedByResolution: 0,
    shaMismatch: 0,
    missing: []
  }
  const found = new Set<string>()
  let total = 0
  for (const target of entries.values()) {
    if (target.resolution !== 'skip') total += 1
  }
  emitProgress(resolved, { done: 0, total })

  await forEachZipEntry(zip, async (entry) => {
    const name = entryNameOf(entry)
    if (isZipSlip(name)) {
      stats.skippedZipSlip += 1
      return
    }
    if (entry.isEncrypted()) {
      stats.skippedEncrypted += 1
      return
    }
    // 三件套是包自身元数据，验包已读；提取阶段跳过但不计入「清单外内容」。
    if (PACKAGE_META_ENTRIES.has(name)) return
    const target = entries.get(name)
    if (target === undefined) {
      stats.skippedOutsideWhitelist += 1
      return
    }
    found.add(name)
    if (target.resolution === 'skip') {
      stats.skippedByResolution += 1
      return
    }
    const ok = await extractOneFile(zip, entry, target, targetDir, resolved)
    if (!ok) {
      // false 可能是「sha 不符」也可能是「越界守卫」；两者都不落盘。
      stats.shaMismatch += 1
      return
    }
    stats.extracted += 1
    emitProgress(resolved, { done: stats.extracted, total })
  })

  for (const name of entries.keys()) {
    if (entries.get(name)?.resolution === 'skip') continue
    if (!found.has(name)) stats.missing.push(name)
  }
  emitStats(resolved, stats)
  return stats
}

/**
 * `applyPackage(packagePath, resolutions, deps)` —— 复验包 → 按清单提取 → 生成 `Asset[]`。
 *
 * **永不抛错**：所有失败走 `ok:false` + 中文 `error`。验包复用 `inspectPackage`，
 * 因此坏包 / 加密 / 版本错在落盘前就被拦下。成功时：
 * - `restored` 用 `fromPortableAsset(record, libraryDir)` 生成（folder 现算 / 缓存清空），
 *   交 T4 渲染层写库；keep-both 记录换目录 + 换 id，原件不动。
 * - `personal` 原样带出补丁，由 T4 `mergePersonalSettings` 白名单合并。
 *
 * 本函数**不做**任何批量 clear/delete（不误删既有资产）；冲突裁决只由 resolutions 决定。
 */
export async function applyPackage(
  packagePath: string,
  resolutions: PackageResolutions,
  deps: PackageImportDeps
): Promise<PackageImportResult> {
  const resolved = resolveDeps(deps)
  try {
    const inspected = await inspectPackage(packagePath, resolved)
    if (!inspected.ok) return { ok: false, error: inspected.reason }

    const { records, personal } = inspected
    const plan = buildExtractPlan(records, resolutions ?? {}, resolved)
    const zip = await openZip(resolved, packagePath)
    let stats: PackageExtractStats
    try {
      stats = await extractByWhitelist(zip, plan.entries, resolved.libraryDir, resolved)
    } finally {
      closeZip(zip)
    }

    if (stats.shaMismatch > 0) {
      return { ok: false, error: '素材包内容校验失败，部分文件可能已损坏' }
    }
    if (stats.missing.length > 0) {
      return { ok: false, error: '素材包内容不完整，部分素材缺失' }
    }

    const restored: Asset[] = []
    for (const record of records) {
      const resolution: PackageResolution = resolutions?.[record.id] ?? 'overwrite'
      if (resolution === 'skip') continue
      const targetFolder = plan.folderByRecordId.get(record.id) ?? record.relFolder
      const source: PortableAsset =
        targetFolder === record.relFolder ? record : { ...record, relFolder: targetFolder }
      const newId = plan.idByRecordId.get(record.id)
      if (newId !== undefined) source.id = newId
      restored.push(fromPortableAsset(source, resolved.libraryDir))
    }

    return personal === undefined
      ? { ok: true, restored }
      : { ok: true, restored, personal }
  } catch (err) {
    return { ok: false, error: asError(err).message }
  }
}
