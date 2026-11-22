/**
 * 一键打包 · T2 导出链：主进程流式 zip 写入（docs/58 §2.1 / §3.1 / §7，拍板 docs/57）。
 *
 * ## 分层
 *
 * 本模块**不 import electron**，只读库目录 + 写目标 zip；对话框 / 进度发送由 `main/index.ts`
 * 负责。依赖注入（`diskFree` / `walk` / `zipFactory` / `now` / `appVersion`）让 vitest 无需真库、
 * 无需 electron 就能跑端到端小包。
 *
 * ## 硬约束（用户拍板，勿改）
 *
 * - Q-4：单文件 zip、ZIP64、`store:true` 不二次压缩、流式不整包进内存；不做分卷 / 断点续导。
 * - Q-2：遍历库目录**只跳** `.trash` / `.idbox`；其余文件照常看，但是否入包仍由清单白名单决定。
 * - Q-5：`folder` 绝对路径永不写进 `index.json`（`toPortableAsset` 统一剔除）。
 * - F-2（docs/57 §6，推翻 Q-7）：`opts.includedKinds` 里没有的大类，其记录与其素材**同时**缺席
 *   （先过滤 records，再用过滤后的 `collectExpectedEntries` 生成白名单）。
 * - C-2：`files[]` 逐文件 sha256，跟随文件字节流单遍算出，不二次读盘。
 * - C-3：**不写** `sourceLibraryRoot`。
 * - C-7：默认文件名 `IDBOX-Library-<YYYYMMDD-HHmm>.zip`（`defaultPackageFileName`）。
 * - 零网络：本文件只用 node 文件系统与加密 API，不发起任何网络请求。
 *
 * ## 取消语义（仿 `importCancelGen`）
 *
 * `cancelPackageExport()` 只把模块级代次 +1，**不打断正在写的那一个文件**。正在跑的
 * `writePackage` 在下一个文件开始前发现代次过时 → 正常收尾（关闭 zip 写手 / 释放 fd）→
 * 删掉 `.tmp`，绝不留半包。没有导出任务在跑时代次 +1 也无害。
 */

import fs from 'node:fs/promises'
import { createReadStream, createWriteStream, type Dirent } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { createRequire } from 'node:module'
import {
  PACKAGE_API_VERSION,
  PACKAGE_ASSETS_PREFIX,
  PACKAGE_FORMAT_MAGIC,
  PACKAGE_FORMAT_VERSION,
  collectExpectedEntries,
  isSafeFileRel,
  isSafeRelFolder,
  toPortableAsset,
  type PackageExportProgressEvent,
  type PackageExportResult,
  type PackageManifest,
  type PersonalPatch,
  type PortableAsset,
  type PortableAssetFile
} from '../shared/packageFormat'
import type { Asset, AssetKind } from '../shared/types'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 每完成这么多素材文件发一次进度；最后一批即便不足也会补发一次终值。 */
const PROGRESS_BATCH = 8

/** 库遍历时**唯一**跳过的两个目录名（Q-2；不得扩大成「所有点开头目录」）。 */
const SKIP_DIR_NAMES = new Set<string>(['.trash', '.idbox'])

/** `.tmp` 后缀：先写临时文件，成功后原子 rename 为最终 zip（R-5）。 */
const TMP_SUFFIX = '.tmp'

// ── 代次式取消 ──────────────────────────────────────────────────────────────

/** 每次点「取消」+1；导出开始时快照，后续每领一个新文件前比对。 */
let packageExportCancelGen = 0

/** 取消当前导出：零 I/O、同步、只动代次计数（与 `importCancelGen` 同款）。 */
export function cancelPackageExport(): void {
  packageExportCancelGen += 1
}

/** 测试用只读探针：确认取消确实让代次前进。 */
export function currentPackageExportGen(): number {
  return packageExportCancelGen
}

/** 内部信号：走统一的 catch 清理通道，同时把 `canceled` 标记带回渲染层。 */
class PackageExportCanceledError extends Error {
  constructor() {
    super('已取消导出')
    this.name = 'PackageExportCanceledError'
  }
}

// ── 可注入的写手接口 ────────────────────────────────────────────────────────

/**
 * zip 写手的窄接口：真实实现用 archiver（ZIP64 + STORE + 流式），测试可注入假写手。
 *
 * `appendFile` 的 `onChunk` 在字节流过时逐块回调，导出器用它**单遍**算 sha256；
 * 假写手可借此制造取消 / 失败时序，无需真盘大文件。
 */
export interface PackageZipWriter {
  /** 流式追加一个磁盘文件为 zip 条目；`onChunk` 收到的是即将入包的原始字节。 */
  appendFile(absPath: string, entryName: string, onChunk: (chunk: Buffer) => void): Promise<void>
  /** 追加一个字符串条目（三件套里的 JSON 文本）。 */
  appendText(entryName: string, text: string): void
  /** 正常收尾：finalize + 等待输出流 close。 */
  finish(): Promise<void>
  /** 异常 / 取消收尾：中止归档并释放 fd，让调用方能安全 unlink `.tmp`。 */
  abort(): void
}

/** 默认文件名（C-7）：本地时区 YYYYMMDD-HHmm。 */
export function defaultPackageFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `IDBOX-Library-${stamp}.zip`
}

/** `writePackage` 的全部外部依赖；测试逐项注入，主进程一项不缺地传。 */
export interface PackageExportDeps {
  /** 素材库根目录（records 的 relFolder 相对于它）。 */
  libraryDir: string
  /** 目标盘可用字节数（取不到返回 null → 跳过预检，不误拦）。 */
  diskFree: (dir: string) => Promise<number | null> | number | null
  /** 流式遍历库目录，yield **posix 相对路径**（不含前导 `/`）。 */
  walk: (root: string) => AsyncIterable<string> | Iterable<string>
  /** 按 `.tmp` 路径建一个 zip 写手。 */
  zipFactory: (tmpPath: string) => PackageZipWriter
  /** 落盘时刻（manifest.generatedAt）。 */
  now: () => Date
  /** `app.getVersion()` 回执。 */
  appVersion: string
  /** `includePersonalSettings=true` 时的设置补丁；不传则 personal.json 不落盘。 */
  personalSettings?: PersonalPatch
  /** 进度回调；永不让它抛出的异常污染导出流程。 */
  onProgress?: (ev: PackageExportProgressEvent) => void
}

/** `writePackage` 的导出选项（来自渲染层勾选）。 */
export interface PackageExportOptions {
  /** 本次要导出哪些大类（F-2）：不在集合内的记录与素材都不进包。 */
  includedKinds: AssetKind[]
  includePersonalSettings: boolean
}

// ── 默认库遍历（Q-2：只跳 .trash / .idbox）─────────────────────────────────

/**
 * 递归遍历 `root`，yield posix 相对路径。
 *
 * - 只跳过 `.trash` / `.idbox` 两个目录（含任意层级），**不**跳过别的文件；
 * - 符号链接一律跳过，避免把库外文件读进包；
 * - 读不到的目录静默跳过（与 rescan 的容错口径一致），缺失的目标文件会在
 *   `writePackage` 的「白名单全部命中」检查里报出来，不会静默少打。
 */
export async function* walkLibraryFiles(root: string): AsyncGenerator<string> {
  async function* recurse(dir: string): AsyncGenerator<string> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        yield* recurse(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        yield path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/')
      }
    }
  }
  yield* recurse(root)
}

// ── 默认 archiver 写手 ──────────────────────────────────────────────────────

/** archiver 的最小结构签名（7.x 无随包 d.ts；用 `createRequire` 避免引入 @types 依赖）。 */
interface ArchiverLike {
  pipe(destination: NodeJS.WritableStream): unknown
  on(event: string, listener: (err: Error) => void): unknown
  off(event: string, listener: (err: Error) => void): unknown
  append(source: unknown, data: { name: string; store: boolean }): void
  finalize(): unknown
  abort(): void
}

type ArchiverFactory = (format: 'zip', options: Record<string, unknown>) => ArchiverLike

function loadArchiverFactory(): ArchiverFactory {
  // 打包后主进程是 CJS（__filename 存在）；vitest 下退到 cwd 解析仓库 node_modules。
  const base = typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'index.cjs')
  const mod = createRequire(base)('archiver') as ArchiverFactory & { create?: ArchiverFactory }
  return mod.create ?? mod
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * 真实 zip 写手：archiver(`zip`, `store:true` + `forceZip64:true` + `zlib.level:0`)。
 *
 * `store:true` 同时加在归档级与每条 append 上（双守卫，防未来版本改默认值）；
 * `forceZip64` 让中心目录带 ZIP64 扩展头，14 GB 包不会被 32 位字段截断。
 * 全程 `createReadStream` → Transform（算 sha）→ archiver → `createWriteStream(.tmp)`，
 * 内存中永远只有当前 chunk。
 */
export function createArchiverZipWriter(tmpPath: string): PackageZipWriter {
  const archive = loadArchiverFactory()('zip', {
    store: true,
    forceZip64: true,
    zlib: { level: 0 }
  })
  const output = createWriteStream(tmpPath)
  // 关键：必须先把归档流接到输出流，否则 append 的字节无处可去、finalize 永不结束。
  archive.pipe(output)

  let firstError: Error | null = null
  const noteError = (err: Error): void => {
    if (firstError === null) firstError = asError(err)
  }
  // 先挂常驻监听器：append 阶段就发生的错误也要留住，不能变成 unhandled error。
  archive.on('error', noteError)
  output.on('error', noteError)

  return {
    async appendFile(absPath, entryName, onChunk): Promise<void> {
      if (firstError !== null) throw firstError
      const input = createReadStream(absPath)
      const digestStream = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          onChunk(Buffer.from(chunk))
          callback(null, chunk)
        }
      })

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const onArchiveError = (err: Error): void => done(asError(err))
        const done = (err?: Error): void => {
          if (settled) return
          settled = true
          archive.off('error', onArchiveError)
          if (err !== undefined) {
            input.destroy()
            digestStream.destroy()
            reject(err)
          } else {
            resolve()
          }
        }
        input.on('error', (err: Error) => done(asError(err)))
        digestStream.on('error', (err: Error) => done(asError(err)))
        digestStream.on('end', () => done())
        archive.on('error', onArchiveError)
        archive.append(digestStream, { name: entryName, store: true })
        // append 只接管 digestStream 的读端；源文件 → 哈希 Transform 的管子必须自己接。
        input.pipe(digestStream)
      })
    },

    appendText(entryName, text): void {
      archive.append(text, { name: entryName, store: true })
    },

    finish(): Promise<void> {
      if (firstError !== null) return Promise.reject(firstError)
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const done = (err?: Error): void => {
          if (settled) return
          settled = true
          if (err !== undefined) reject(err)
          else resolve()
        }
        output.on('close', () => done())
        output.on('error', (err: Error) => done(asError(err)))
        archive.on('error', (err: Error) => done(asError(err)))
        try {
          void Promise.resolve(archive.finalize()).catch((err: unknown) => done(asError(err)))
        } catch (err) {
          done(asError(err))
        }
      })
    },

    abort(): void {
      try {
        archive.abort()
      } catch {
        /* 归档已结束：无需再 abort */
      }
      try {
        output.destroy()
      } catch {
        /* fd 已释放 */
      }
    }
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function emitProgress(deps: PackageExportDeps, ev: PackageExportProgressEvent): void {
  if (typeof deps.onProgress !== 'function') return
  try {
    deps.onProgress(ev)
  } catch {
    /* 进度回调是观测通道：它自己炸了不能把导出带崩 */
  }
}

/** 把 records 收窄成安全白名单 + 逐条目字节数（assetsBytes）。 */
function expectedEntrySizes(records: PortableAsset[]): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const record of records) {
    if (!isSafeRelFolder(record.relFolder)) continue
    if (!Array.isArray(record.files)) continue
    for (const file of record.files) {
      if (!isSafeFileRel(file.rel)) continue
      const entry = `${PACKAGE_ASSETS_PREFIX}${record.relFolder}/${file.rel}`
      sizes.set(entry, Number(file.size) || 0)
    }
  }
  return sizes
}

/** 带 `folder` 等路径字段兜底剔除 + 逐文件 sha256 回填的快照条目。 */
function snapshotRecord(record: PortableAsset, shaByEntry: Map<string, string>): PortableAsset {
  const out = toPortableAsset(record as unknown as Asset)
  const files: PortableAssetFile[] = out.files.map((file) => {
    const entry = `${PACKAGE_ASSETS_PREFIX}${record.relFolder}/${file.rel}`
    const sha256 = shaByEntry.get(entry)
    return sha256 === undefined ? { ...file } : { ...file, sha256 }
  })
  out.files = files
  return out
}

/**
 * 导出一份库包：预检 → 流式写素材 → 生成并校验三件套 → `.tmp` 原子 rename。
 *
 * **永不抛错**：所有失败（含取消）都走 `PackageExportResult` 的 `ok:false` 分支，
 * 与 `PackageExportResult` 契约一致；异常路径一定 unlink `.tmp`，不留半包。
 *
 * @param destPath 最终 zip 路径（由 `packageExportPick` 给出）
 * @param records 渲染层传来的 `PortableAsset[]`（已去 folder / 软删）
 * @param opts 导出勾选
 * @param deps 依赖注入（库根、磁盘余量、遍历、写手、时钟、版本）
 */
export async function writePackage(
  destPath: string,
  records: PortableAsset[],
  opts: PackageExportOptions,
  deps: PackageExportDeps
): Promise<PackageExportResult> {
  const myGen = packageExportCancelGen
  const tmpPath = `${destPath}${TMP_SUFFIX}`
  let writer: PackageZipWriter | null = null

  const cleanupTmp = async (): Promise<void> => {
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* 文件本来就没建出来：无事可做 */
    }
  }

  try {
    if (typeof destPath !== 'string' || destPath.length === 0) {
      throw new Error('导出路径无效')
    }
    if (!Array.isArray(records)) throw new Error('资产记录无效')

    // F-2：先按用户勾选的大类过滤记录，白名单只从过滤后的集合生成 ——
    // 未勾大类的素材不可能漏进 zip（原 Q-7 只对 hdri 开小灶，现统一到所有大类）。
    const selected = records.filter((r) => opts.includedKinds.includes(r.kind))
    const entrySizes = expectedEntrySizes(selected)
    const expected = collectExpectedEntries(selected)
    let assetsBytes = 0
    for (const bytes of entrySizes.values()) assetsBytes += bytes

    // §3.3 磁盘余量预检。取不到 free（null）时不拦，避免误判网络盘 / 老系统。
    // destPath 由保存对话框给出的是绝对路径，path.resolve 仅做规范化，不会换盘；
    // 若真拿到相对路径，按主进程 cwd 解析也是唯一可执行语义（主进程不 share 渲染层 cwd）。
    const destDir = path.dirname(path.resolve(destPath))
    const free = await deps.diskFree(destDir)
    if (typeof free === 'number' && Number.isFinite(free) && free >= 0 && free < assetsBytes) {
      // F-3：把目标盘 + 真实数字写进报错，用户一眼看出是哪块盘不够，而不是笼统的「清理磁盘」。
      const target = path.parse(destPath).root || destDir
      throw new Error(
        `磁盘空间不足（目标盘 ${target}）：需要约 ${Math.ceil(assetsBytes / 1024 / 1024)} MB，可用 ` +
          `${Math.floor(free / 1024 / 1024)} MB。单文件超过 4 GB 时目标盘需为 NTFS/exFAT。`
      )
    }

    writer = deps.zipFactory(tmpPath)
    const total = expected.size
    emitProgress(deps, { phase: 'assets', done: 0, total })

    const shaByEntry = new Map<string, string>()
    const found = new Set<string>()
    let done = 0

    for await (const rawRel of deps.walk(deps.libraryDir)) {
      if (typeof rawRel !== 'string' || rawRel.length === 0) continue
      const rel = rawRel.split('\\').join('/').replace(/^\/+/, '')
      const entryName = `${PACKAGE_ASSETS_PREFIX}${rel}`
      if (!expected.has(entryName) || found.has(entryName)) continue

      // 取消只在这里生效：正在 append 的那个文件已经写了一半，让它自然写完再收尾。
      if (packageExportCancelGen !== myGen) throw new PackageExportCanceledError()

      const absPath = path.join(deps.libraryDir, ...rel.split('/'))
      const hash = createHash('sha256')
      await writer.appendFile(absPath, entryName, (chunk) => hash.update(chunk))
      shaByEntry.set(entryName, hash.digest('hex'))
      found.add(entryName)
      done += 1
      if (done % PROGRESS_BATCH === 0) {
        emitProgress(deps, { phase: 'assets', done, total })
      }
    }

    // 清单里声明但磁盘上没找到 → 坏导出，宁可失败也不产出一个缺素材的包。
    for (const entry of expected) {
      if (!found.has(entry)) throw new Error(`素材文件缺失：${entry}`)
    }
    if (packageExportCancelGen !== myGen) throw new PackageExportCanceledError()
    emitProgress(deps, { phase: 'assets', done, total })
    emitProgress(deps, { phase: 'finalize', done: 0, total: 1 })

    // index.json：同一份文本既写进 zip 又用来算 indexSha256（C-2 / Q-5）。
    const snapshot = selected.map((record) => snapshotRecord(record, shaByEntry))
    const indexText = JSON.stringify(snapshot)
    const indexSha256 = createHash('sha256').update(indexText, 'utf8').digest('hex')
    writer.appendText('index.json', indexText)

    // personal.json：只有勾选且确有补丁时才出现（Q-8 / C-5）。
    let personalSha256: string | undefined
    const patch = deps.personalSettings
    if (opts.includePersonalSettings && patch !== undefined && Object.keys(patch).length > 0) {
      const personalText = JSON.stringify(patch)
      personalSha256 = createHash('sha256').update(personalText, 'utf8').digest('hex')
      writer.appendText('personal.json', personalText)
    }

    const manifest: PackageManifest = {
      format: PACKAGE_FORMAT_MAGIC,
      formatVersion: PACKAGE_FORMAT_VERSION,
      apiVersion: PACKAGE_API_VERSION,
      appVersion: deps.appVersion,
      generatedAt: deps.now().toISOString(),
      count: snapshot.length,
      assetsBytes,
      // F-2：回执记下本次导出的大类集合（拷贝一份，避免后续外部改动 opts 影响已落盘对象）。
      includedKinds: [...opts.includedKinds],
      includePersonalSettings: opts.includePersonalSettings,
      indexSha256
    }
    // C-3：刻意不写 sourceLibraryRoot。
    if (personalSha256 !== undefined) manifest.personalSha256 = personalSha256
    writer.appendText('manifest.json', JSON.stringify(manifest))

    await writer.finish()
    await fs.rename(tmpPath, destPath)
    emitProgress(deps, { phase: 'finalize', done: 1, total: 1 })

    return { ok: true, path: destPath, count: snapshot.length, bytes: assetsBytes }
  } catch (err) {
    const canceled = err instanceof PackageExportCanceledError
    try {
      writer?.abort()
    } catch {
      /* abort 失败也要尝试删 .tmp */
    }
    await cleanupTmp()
    return {
      ok: false,
      error: canceled ? '已取消导出' : asError(err).message,
      canceled: canceled || undefined
    }
  }
}
