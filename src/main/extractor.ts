import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import type { AssetFile, Codepage } from '../shared/types'
import { SEVEN_ZIP_DOWNLOAD_URL } from '../shared/types'
import { humanGB } from '../shared/space'
import { isScanMojibake, scanNames, type NameScan } from '../shared/encoding'
import { walkFiles, clearDirContents } from './fsutil'
import { makeAdmZipDecoder } from './gbk'

const execFileP = promisify(execFile)

/** 解压引擎 */
export type Engine = '7z' | 'admzip'

/** 错误分类：决定给用户的可行动文案（禁止裸抛 stderr） */
export type ErrorKind = 'password' | 'corrupt' | 'unsupported' | 'no7z' | 'oversize' | 'timeout' | 'other'

export class ExtractionError extends Error {
  readonly kind: ErrorKind
  constructor(message: string, kind: ErrorKind) {
    super(message)
    this.name = 'ExtractionError'
    this.kind = kind
  }
}

export interface ExtractOptions {
  sevenZipPath: string | null
  codepage: Codepage
  timeoutMs: number
  maxBytesForJsFallback: number
}

export interface ExtractResult {
  engine: Engine
  /**
   * 实际采用的码页：
   * - `acp` = 7z 裸参数（**系统 ANSI 代码页**，中文系统上即 936/GBK；DEF-01 裁定的首选路径）
   * - `gbk` / `utf8` = 显式指定（`-mcp=936` 重解或 adm-zip decoder）
   */
  codepage: 'acp' | 'gbk' | 'utf8'
  /** 解压结果是否疑似乱码（UI 打「疑似乱码」标） */
  mojibake: boolean
  /** 可疑名字占比 */
  suspiciousRatio: number
  /** 最多 5 条可疑样本 */
  samples: string[]
}

export interface UncompressedInfo {
  bytes: number
  /** 是否精确值（7z l -slt 或 adm-zip 求得） */
  exact: boolean
}

/** 只保留 zip / rar / 7z（移除 .tar/.gz/.tgz，Windows 下载场景用不到，C2） */
const SUPPORTED_EXTS = new Set(['.zip', '.rar', '.7z'])
const MAX_BUFFER = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 600_000
const LIST_TIMEOUT_MS = 60_000
/** 取不到 uncompressed 时的保守估算系数 */
const FALLBACK_ESTIMATE_FACTOR = 3

/** zip 内容魔数（local file header 签名 `PK\x03\x04`） */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * 按**内容**（而非后缀）判断是否是 zip（2026-10 用户样本：知末下到的
 * `….rar` 后缀实际是 zip 内容，7z 按内容解压毫无问题；无 7z 的 adm-zip
 * 兜底路径原先按后缀拒绝，这里补内容嗅探，让「rar 后缀的 zip」在
 * 无 7z 环境也能导入）。
 *
 * 读前 4 字节，读取失败/不像 zip 一律 false（由调用方走原后缀逻辑）。
 */
export async function detectZipContent(src: string): Promise<boolean> {
  try {
    const fh = await fs.open(src, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await fh.read(buf, 0, 4, 0)
      return bytesRead === 4 && buf.equals(ZIP_MAGIC)
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

interface ExecFailure extends Error {
  stdout?: string
  stderr?: string
  code?: number | string
  killed?: boolean
}

function asExecFailure(err: unknown): ExecFailure {
  return (err instanceof Error ? err : new Error(String(err))) as ExecFailure
}

function classifyError(err: unknown): ErrorKind {
  const e = asExecFailure(err)
  const msg = `${e.message ?? ''} ${e.stderr ?? ''} ${e.stdout ?? ''}`
  if (e.code === 'ETIMEDOUT' || e.killed === true || /timed out|ETIMEDOUT/i.test(msg)) return 'timeout'
  if (/password|encrypt|加密|需要密码/i.test(msg)) return 'password'
  if (/crc|corrupt|unexpected end|data error|损坏|不可预料的压缩文件末端/i.test(msg)) return 'corrupt'
  return 'other'
}

function toExtractionError(err: unknown, fallback: string): ExtractionError {
  if (err instanceof ExtractionError) return err
  const kind = classifyError(err)
  const messages: Record<ErrorKind, string> = {
    password: '压缩包有密码保护，暂不支持（请手动解压后拖入文件夹）',
    corrupt: '压缩包已损坏（CRC 校验失败），请重新下载',
    unsupported: `${fallback}：只支持 zip / rar / 7z`,
    no7z: `需要 7-Zip 才能解压该格式：请安装（${SEVEN_ZIP_DOWNLOAD_URL}）或在设置中指定 7z.exe 路径`,
    oversize: `${fallback}：请安装 7-Zip（${SEVEN_ZIP_DOWNLOAD_URL}）以处理大包`,
    timeout: '解压超时，可在设置里调大「解压超时」后重试',
    other: `${fallback}：${summarize(err)}`
  }
  return new ExtractionError(messages[kind], kind)
}

/** stderr 摘要：只取前 200 字符，避免把 32MB 输出灌进 UI */
function summarize(err: unknown): string {
  const e = asExecFailure(err)
  const raw = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim()
  const text = raw || e.message || String(err)
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

async function runSevenZip(exe: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execFileP(exe, args, {
    windowsHide: true,
    timeout: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  return `${stdout ?? ''}\n${stderr ?? ''}`
}

/**
 * 单次 7z 解压尝试，**永不抛出**（DEF-01 裁定第 3 条：任何失败都要能继续回退，不能向外抛）。
 *
 * @param mcp null = **裸参数**（首选）；`'936'` = 兜底重解时显式指定中文码页。
 *   ⚠️ `-mcp` 对 `x`（解压）命令**是有效**的，但**只认数字码页**：写 `-mcp=GBK`
 *   会被 7-Zip 当成未知值，整体退化成 `Can't open as archive`（7-Zip 23.01 实测）。
 *   中文系统用 `936`（= GBK/CP936）。老注释里「`-mcp` 对解压不受支持」是错的，
 *   2026-10-29 真机复验已纠正。
 */
async function sevenZipTry(
  exe: string,
  src: string,
  dest: string,
  mcp: '936' | null,
  timeoutMs: number
): Promise<{ ok: boolean; err?: unknown }> {
  const cpArgs = mcp ? [`-mcp=${mcp}`] : []
  try {
    await runSevenZip(exe, ['x', '-y', ...cpArgs, `-o${dest}`, '--', src], timeoutMs)
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

/** 换码页重解用的临时子目录名（dest 内，随 staging 一起清理，绝不泄漏到库目录） */
function retryDirName(): string {
  return `__mv_retry_${randomUUID().slice(0, 8)}`
}

/**
 * 换码页重解（DEF-01 裁定第 2 条：**由乱码嗅探驱动重试**，而不是靠错误匹配正则——
 * 后者只能匹配已知错误形态，前者对**任何**码页不匹配都生效，含英文系统 ACP=1252）。
 *
 * 安全性：输出到 `dest` 内的临时子目录，解完嗅探，**更干净才替换**原结果——
 * 原结果再乱也比空目录强，所以重解失败或仍乱码时**绝不破坏**已解出的内容。
 */
async function retryWithCodepage(
  exe: string,
  src: string,
  dest: string,
  mcp: '936',
  timeoutMs: number
): Promise<{ ok: boolean; replaced: boolean }> {
  const workDir = path.join(dest, retryDirName())
  await fs.rm(workDir, { recursive: true, force: true })
  await fs.mkdir(workDir, { recursive: true })
  const attempt = await sevenZipTry(exe, src, workDir, mcp, timeoutMs)
  if (!attempt.ok) {
    await fs.rm(workDir, { recursive: true, force: true })
    return { ok: false, replaced: false }
  }
  const scan = await scanDest(workDir)
  if (isScanMojibake(scan)) {
    // 重解仍乱码（说明包不是这个码页）→ 丢弃重解结果，保留原结果
    await fs.rm(workDir, { recursive: true, force: true })
    return { ok: true, replaced: false }
  }
  // 干净了 → 清掉原（乱码）内容（保留临时目录自身），把干净结果上移
  for (const name of await fs.readdir(dest)) {
    if (name === path.basename(workDir)) continue
    await fs.rm(path.join(dest, name), { recursive: true, force: true })
  }
  for (const name of await fs.readdir(workDir)) {
    await fs.rename(path.join(workDir, name), path.join(dest, name))
  }
  await fs.rm(workDir, { recursive: true, force: true })
  return { ok: true, replaced: true }
}

function extractWithAdmZip(src: string, dest: string, mode: 'gbk' | 'utf8'): void {
  const decoder = makeAdmZipDecoder(mode)
  type AdmZipCtorOptions = ConstructorParameters<typeof AdmZip>[1]
  const zip = new AdmZip(src, { decoder } as unknown as AdmZipCtorOptions)
  zip.extractAllTo(dest, true)
}

/** 读一次 zip 的 central directory，按 UTF-8 flag（bit 11）判断文件名字节用的是哪套编码 */
function detectZipNameEncoding(src: string): 'gbk' | 'utf8' | null {
  try {
    type AdmZipCtorOptions = ConstructorParameters<typeof AdmZip>[1]
    const zip = new AdmZip(src, { decoder: makeAdmZipDecoder('utf8') } as unknown as AdmZipCtorOptions)
    const entries = zip.getEntries()
    if (entries.length === 0) return null
    let flagged = 0
    for (const e of entries) {
      if ((Number(e.header?.flags ?? 0) & 0x800) !== 0) flagged++
    }
    if (flagged === entries.length) return 'utf8'
    if (flagged === 0) return 'gbk'
    return null
  } catch {
    return null
  }
}

/**
 * adm-zip 兜底用哪套码页：
 * 显式 `gbk` / `utf8` 直接采用；`auto` 先看 zip 自己的 UTF-8 flag，看不出则按 GBK（知末/WinRAR 典型形态）。
 */
function resolveAdmZipMode(src: string, codepage: Codepage): 'gbk' | 'utf8' {
  if (codepage === 'gbk') return 'gbk'
  if (codepage === 'utf8') return 'utf8'
  return detectZipNameEncoding(src) ?? 'gbk'
}

async function scanDest(dest: string): Promise<NameScan> {
  const files: AssetFile[] = []
  await walkFiles(dest, dest, files)
  return scanNames(files.map((f) => f.rel))
}

function resultOf(engine: Engine, cp: 'acp' | 'gbk' | 'utf8', scan: NameScan): ExtractResult {
  return {
    engine,
    codepage: cp,
    mojibake: isScanMojibake(scan),
    suspiciousRatio: scan.ratio,
    samples: scan.samples
  }
}

/**
 * 解压压缩包到目标目录（P0-2 / C1 / C2；DEF-01 修复后的策略）
 *
 * ① 有 7z → **首选裸参数**（Windows 版 7z 对「DOS 制作的 zip + 无 UTF-8 flag」按系统
 *    ACP 解 → 中文系统 936 零乱码）。裸参数失败 → 兜底重试 `-mcp=936`，
 *    **该次失败必须被兜住**，绝不向外抛。
 *    ⚠️ 裸参数**并非永远正确**：7-Zip 对「Unix 制作的 zip（madeBy os=3）+ 无 UTF-8 flag」
 *    会假定文件名是 UTF-8，把 GBK 名字解成 PUA 垃圾（U+E000–U+F8FF）。实测真包
 *    `生态主题餐厅工装平面图ID_1152305168.zip` 就是这种，只能靠 ② 嗅探后重解救回来。
 * ② 解压后 `scanNames` 嗅探乱码；命中且码页偏好为 gbk → 换 `-mcp=936` 重解到临时目录，
 *    **更干净才替换**；重解失败或仍乱码 → zip 可走 adm-zip + GBK decoder 兜底，
 *    否则保留结果并标「疑似乱码」。
 * ③ 无 7z 且是 ≤`maxBytesForJsFallback` 的 zip → adm-zip + 码页检测 + GBK decoder 兜底
 * ④ 其余情况抛带 `kind` 的 `ExtractionError`，文案可行动
 */
export async function extractArchive(src: string, dest: string, opts: ExtractOptions): Promise<ExtractResult> {
  const ext = path.extname(src).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new ExtractionError(
      `暂不支持 .${ext.replace(/^\./, '')} 格式：只支持 zip / rar / 7z`,
      'unsupported'
    )
  }
  await fs.mkdir(dest, { recursive: true })
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const first: 'gbk' | 'utf8' = opts.codepage === 'utf8' ? 'utf8' : 'gbk'
  if (opts.sevenZipPath) {
    const exe = opts.sevenZipPath
    // ── ① 首选裸参数（DEF-01）──────────────────────────────────
    let attempt = await sevenZipTry(exe, src, dest, null, timeoutMs)
    if (!attempt.ok) {
      const kind = classifyError(attempt.err)
      // 密码/损坏/超时：换码页重试没有意义，直接抛可行动错误（也避免把 GB 级包解两遍）
      if (kind === 'password' || kind === 'corrupt' || kind === 'timeout') {
        throw toExtractionError(attempt.err, '解压失败')
      }
      // 其余失败（含 "Can't open as archive"）→ 兜底重试 -mcp=936（只认数字码页），失败被兜住
      attempt = await sevenZipTry(exe, src, dest, '936', timeoutMs)
      if (!attempt.ok) throw toExtractionError(attempt.err, '解压失败')
    }
    let scan = await scanDest(dest)
    // ── ② 乱码嗅探驱动重试（DEF-01）────────────────────────────
    // 仅"码页偏好为 gbk"时重试（偏好 utf8 时不再回退 GBK，直接标疑似乱码）
    if (isScanMojibake(scan) && first === 'gbk') {
      const retry = await retryWithCodepage(exe, src, dest, '936', timeoutMs)
      if (retry.replaced) {
        return resultOf('7z', 'gbk', await scanDest(dest))
      }
      // -mcp=936 重解失败或重解仍乱码 → zip 走 adm-zip + GBK decoder 兜底
      // （内容嗅探：.rar 后缀但内容是 zip 的包同样享受 JS 兜底）
      if (ext === '.zip' || (await detectZipContent(src))) {
        let archiveBytes = 0
        try {
          archiveBytes = (await fs.stat(src)).size
        } catch {
          archiveBytes = 0
        }
        if (archiveBytes > 0 && archiveBytes <= opts.maxBytesForJsFallback) {
          await clearDirContents(dest)
          try {
            extractWithAdmZip(src, dest, 'gbk')
          } catch (err) {
            throw toExtractionError(err, 'zip 解压失败')
          }
          return resultOf('7z', 'gbk', await scanDest(dest))
        }
      }
      // rar/7z 无 JS 兜底 → 保留裸参数结果并标「疑似乱码」（UI 打标，用户可手动改）
    }
    return resultOf('7z', 'acp', scan)
  }

  // ── 无 7-Zip：zip（含「.rar/.7z 后缀但内容是 zip」）能走纯 JS 兜底 ────
  // 2026-10 用户样本证实知末的 .rar 后缀实际是 zip 内容：按内容嗅探测法治之
  const zipByContent = ext !== '.zip' && (await detectZipContent(src))
  if (ext !== '.zip' && !zipByContent) {
    throw new ExtractionError(
      `需要 7-Zip 才能解压 .${ext.replace(/^\./, '')}：请安装（${SEVEN_ZIP_DOWNLOAD_URL}）或在设置中指定 7z.exe 路径`,
      'no7z'
    )
  }
  let archiveBytes = 0
  try {
    archiveBytes = (await fs.stat(src)).size
  } catch {
    archiveBytes = 0
  }
  if (archiveBytes > opts.maxBytesForJsFallback) {
    throw new ExtractionError(
      `压缩包 ${humanGB(archiveBytes)} 超过纯 JS 解压上限 ${humanGB(opts.maxBytesForJsFallback)}：请安装 7-Zip（${SEVEN_ZIP_DOWNLOAD_URL}）`,
      'oversize'
    )
  }

  const admMode = resolveAdmZipMode(src, opts.codepage)
  try {
    extractWithAdmZip(src, dest, admMode)
  } catch (err) {
    throw toExtractionError(err, 'zip 解压失败')
  }
  let scan = await scanDest(dest)
  if (isScanMojibake(scan) && admMode === 'gbk') {
    await clearDirContents(dest)
    try {
      extractWithAdmZip(src, dest, 'utf8')
    } catch (err) {
      throw toExtractionError(err, 'zip 解压失败')
    }
    scan = await scanDest(dest)
    return resultOf('admzip', 'utf8', scan)
  }
  return resultOf('admzip', admMode, scan)
}

/**
 * 列出压缩包内文件解压后的总体积（P0-3 预检用）：
 * 7z `l -slt` 求和 → adm-zip 精确值 → `原包 × 3` 保守估算。
 */
export async function listUncompressedBytes(
  src: string,
  opts: Pick<ExtractOptions, 'sevenZipPath' | 'maxBytesForJsFallback'>
): Promise<UncompressedInfo> {
  const ext = path.extname(src).toLowerCase()
  let archiveBytes = 0
  try {
    archiveBytes = (await fs.stat(src)).size
  } catch {
    archiveBytes = 0
  }

  if (opts.sevenZipPath) {
    try {
      const out = await runSevenZip(opts.sevenZipPath, ['l', '-slt', '-y', '--', src], LIST_TIMEOUT_MS)
      let sum = 0
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*Size\s*=\s*(\d+)\s*$/.exec(line)
        if (m) sum += Number(m[1])
      }
      if (sum > 0) return { bytes: sum, exact: true }
    } catch {
      /* 取不到 → 走下面的兜底 */
    }
  }

  // 内容嗅探：.rar/.7z 后缀但内容是 zip 的包同样可用 adm-zip 精确求和
  const zipByContent = ext !== '.zip' && (await detectZipContent(src))
  if ((ext === '.zip' || zipByContent) && archiveBytes > 0 && archiveBytes <= opts.maxBytesForJsFallback) {
    try {
      type AdmZipCtorOptions = ConstructorParameters<typeof AdmZip>[1]
      const zip = new AdmZip(src, { decoder: makeAdmZipDecoder('gbk') } as unknown as AdmZipCtorOptions)
      let sum = 0
      for (const e of zip.getEntries()) {
        if (e.entryName.endsWith('/')) continue
        sum += Number(e.header?.size ?? 0)
      }
      if (sum > 0) return { bytes: sum, exact: true }
    } catch {
      /* 取不到 → 走下面的兜底 */
    }
  }

  return { bytes: archiveBytes * FALLBACK_ESTIMATE_FACTOR, exact: false }
}
