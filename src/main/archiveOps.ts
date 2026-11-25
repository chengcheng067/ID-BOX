/**
 * 应用内文件浏览器 v2 · 压缩包 / 归档操作（docs/61 §批注结果 · 方案二写操作批）。
 *
 * 职责（`fs:extractArchive` / `fs:compressEntries` 的实现体 + 各写通道共用的守卫拼装）：
 * - **纯逻辑**（单独可测）：压缩包扩展名识别、解压目标目录名推导、压缩目标 zip 名推导、
 *   条目名校验（拒绝 `\\/:*?"<>|` 与控制字符、保留中文名）、7z / PowerShell 命令拼装；
 * - **IO**：7z 解压（复用 importer 同一条 7z 通路：`main/paths.ts#findSevenZip` 探测）、
 *   解压后防穿越校验（恶意压缩包 `../` 逃逸兜底）、7z 压缩、PowerShell `Compress-Archive`
 *   降级（7-Zip 缺失时）。
 *
 * 引用链（零重复造轮子）：
 * - 7z 探测：`findSevenZip()`（`IDBOX_7Z` / `MODVAULT_7Z` 环境变量 > %LOCALAPPDATA% > 常见路径 > PATH）；
 * - 路径守卫：`resolveWithinPinRoot`（`main/pinnedDirGuard.ts`，`..` / 绝对路径 / 盘符切换全拒）；
 * - 与 `main/extractor.ts`（导入解压）**并存不混用**：那条链带码页嗅探 / 乱码重解 / adm-zip
 *   兜底，是「导入资产」的专用管线；浏览器内的解压走本文件的直通 7z（支持 tar/gz/bz2 等
 *   importer 不认的格式），失败如实报错。
 *
 * 纯 Node API，无 React / electron 依赖 —— 单测见 `tests/archiveOps.test.ts`。
 */
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { resolveWithinPinRoot } from './pinnedDirGuard'

// ── 纯逻辑：扩展名识别 ──────────────────────────────────────────

/**
 * 压缩包扩展名集合（不含点，小写）。
 *
 * 比 importer 的识别面宽（extractor 只认 zip/rar/7z，因为导入还要建资产目录；
 * 浏览器内解压是「打开」语义，7z 本身支持的常规格式都放行）：
 * zip / rar / 7z / tar / tgz / gz / bz2 / xz。
 */
export const ARCHIVE_EXTS: ReadonlySet<string> = new Set([
  'zip', 'rar', '7z', 'tar', 'tgz', 'gz', 'bz2', 'xz'
])

/** 复合扩展名（长名在前，剥一次剥干净：`foo.tar.gz` → 主名 `foo`） */
const COMPOUND_ARCHIVE_EXTS = ['.tar.gz', '.tar.bz2', '.tar.xz']

/** 该名字是否是压缩包（按扩展名，大小写不敏感） */
export function isArchiveName(name: unknown): boolean {
  if (typeof name !== 'string') return false
  const ext = path.extname(name).toLowerCase().replace(/^\./, '')
  return ext.length > 0 && ARCHIVE_EXTS.has(ext)
}

/**
 * 压缩包主名（去掉扩展名；复合扩展名一次剥净）。
 * 输入不校验 —— 只做字符串推导，调用方负责名字本身已过 {@link validateEntryName}。
 */
export function archiveBaseName(name: string): string {
  const lower = name.toLowerCase()
  for (const compound of COMPOUND_ARCHIVE_EXTS) {
    if (lower.endsWith(compound) && name.length > compound.length) {
      return name.slice(0, name.length - compound.length)
    }
  }
  const ext = path.extname(name)
  return ext.length > 0 ? name.slice(0, name.length - ext.length) : name
}

// ── 纯逻辑：条目名（单段）校验 ──────────────────────────────────

/**
 * Windows 非法文件名字符（拒绝式校验；中文名不含这些字符，天然放行）。
 * ⚠️ 不带 `/g` 标志 —— 全局标志的 `.test()` 有 `lastIndex` 状态，跨调用串台会让
 * 校验结果依赖调用顺序（真实踩过的坑：`a/b` 命中后 `a\b` 反而放行）。
 */
const ILLEGAL_ENTRY_CHARS = /[/\\:*?"<>|]/
/** 控制字符（NUL 截断注入等） */
const CONTROL_CHARS = /[\u0000-\u001f]/
/** Windows 保留设备名（`CON.txt` 同样保留，须连扩展名一起判） */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 校验一个**单段**条目名（文件 / 子目录名，不含路径分隔符）。
 *
 * 拒绝式校验（与 `shared/naming.sanitizeName` 的「替换式」不同 —— 写通道里
 * 静默替换会让「请求的名字」与「落盘的名字」不一致，宁拒勿替）：
 * - 非字符串 / 空白 / 首尾空白（Windows 会静默剥掉，造成前后不一致）→ 拒；
 * - 含 `\\ / : * ? " < > |` 或控制字符（含 NUL）→ 拒；
 * - `.` / `..` / 保留设备名（CON、COM1…）→ 拒；
 * - 末尾的点或空格（Windows 静默剥）→ 拒；
 * - 中文名照常放行。
 *
 * @returns `null` = 合法；否则中文单行错误（可直接展示）
 */
export function validateEntryName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return '名称不能为空'
  if (name !== name.trim()) return '名称不能以空格开头或结尾'
  if (CONTROL_CHARS.test(name)) return '名称含有不允许的字符'
  if (name === '.' || name === '..') return '名称不能是 . 或 ..'
  if (ILLEGAL_ENTRY_CHARS.test(name)) return '名称不能含有 / \\ : * ? " < > |'
  if (name.endsWith('.') || name.endsWith(' ')) return '名称不能以点或空格结尾'
  if (RESERVED_DEVICE_RE.test(name)) return '名称是 Windows 保留名，请换一个'
  return null
}

// ── 纯逻辑：名字推导 ────────────────────────────────────────────

/**
 * 由压缩包名推导解压目标目录名：主名 → 修剪尾部点 / 空格（防止 Windows 落盘时静默剥掉
 * 造成「请求名 ≠ 实际名」）→ 全空时兜底「解压结果」。
 *
 * @returns 目录名（已过 {@link validateEntryName}；理论不返回空）
 */
export function deriveExtractDirName(archiveName: string): string {
  const base = archiveBaseName(archiveName).replace(/[. ]+$/, '')
  if (base.length === 0 || validateEntryName(base) !== null) return '解压结果'
  return base
}

/**
 * 推导压缩输出 zip 名（**含 `.zip` 后缀的完整文件名**）。
 *
 * 规则（任务书允许自定，注释钉死）：
 * - **单条目**：目录 → 原名；文件 → 去扩展名的主名（压缩物是「这个文件本身」，
 *   zip 里不该再套一层扩展名）；名字非法（如主名剥空）→ 兜底时间名；
 * - **多条目**：`归档 YYYY-MM-DD HHmm`（本地时间，与「这是某次整理动作的产物」语义对齐，
 *   也不用担心同目录下重名 —— 粒度到分钟，重名由 exists 检查兜住）。
 */
export function deriveZipName(names: string[], now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fallback = `归档 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}.zip`
  if (names.length !== 1) return fallback
  const only = names[0] ?? ''
  const base = only.toLowerCase().endsWith('.zip') ? '' : archiveBaseName(only).replace(/[. ]+$/, '')
  if (base.length === 0 || validateEntryName(base) !== null) return fallback
  return `${base}.zip`
}

// ── 纯逻辑：命令拼装 ────────────────────────────────────────────

/** 7z 解压参数（`x -y -o<dest> -- <src>`；`--` 挡住以 `-` 开头的文件名注入） */
export function buildSevenZipExtractArgs(src: string, dest: string): string[] {
  return ['x', '-y', `-o${dest}`, '--', src]
}

/** 7z 压缩参数（`a -tzip -y <destZip> -- <srcs...>`；输出固定 zip，资源管理器原生可开） */
export function buildSevenZipCompressArgs(srcs: string[], destZip: string): string[] {
  return ['a', '-tzip', '-y', '--', destZip, ...srcs]
}

/**
 * PowerShell `Compress-Archive` 命令串（7-Zip 缺失时的系统降级）。
 *
 * 引号口径：整个命令作为一个 `-Command` 参数传入（execFile 数组传参，不经 shell 二次解析）；
 * 路径用 PowerShell **单引号字面量**包裹（内嵌 `'` 翻倍转义），并走 `-LiteralPath`
 * （普通 `-Path` 会把 `[]` 当通配符展开）。只产 zip（Compress-Archive 只认 zip）；
 * 超 260 字符路径 / >2GB 条目等已知限制失败时如实报 `system-fallback-failed`。
 */
export function buildPowerShellCompressCommand(srcs: string[], destZip: string): string {
  const quote = (p: string): string => `'${p.replace(/'/g, "''")}'`
  const list = srcs.map(quote).join(', ')
  return `Compress-Archive -LiteralPath ${list} -DestinationPath ${quote(destZip)}`
}

// ── 守卫拼装（写通道共用的路径边界）────────────────────────────

/** 守卫拼装结果：`ok:false` 时 `error` 是中文单行（reason 由调用方按场景归档） */
export type EntryPathResult =
  | { ok: true; absPath: string }
  | { ok: false; error: string }

/**
 * 「pin 根 + dirRel + 单段条目名」三步守卫拼装（所有写通道的第一步）：
 * 1. `dirRel` 过 `resolveWithinPinRoot`（`..` 穿越 / 绝对路径 / 盘符切换全拒）；
 * 2. `name` 过 {@link validateEntryName}（单段 —— **名字里带路径分隔符即拒绝**，
 *    这是写通道唯一新增的注入面：`name` 拼进绝对路径前必须保证不带分隔符）；
 * 3. 拼绝对路径返回（不 stat —— 存在性由调用方按语义处理）。
 */
export function resolveEntryPath(rootAbs: string, dirRel: string, name: string): EntryPathResult {
  const guard = resolveWithinPinRoot(rootAbs, dirRel)
  if (!guard.ok) return guard
  const bad = validateEntryName(name)
  if (bad !== null) return { ok: false, error: bad }
  return { ok: true, absPath: path.join(guard.absPath, name) }
}

// ── IO：7z 执行 ────────────────────────────────────────────────

/** 单次压缩 / 解压的超时（与 importer 的解压默认值同档：GB 级包留足时间） */
export const OPS_TIMEOUT_MS = 600_000
const MAX_BUFFER = 32 * 1024 * 1024

async function runExe(exe: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execFile(exe, args, {
    windowsHide: true,
    timeout: timeoutMs > 0 ? timeoutMs : OPS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  return `${stdout ?? ''}\n${stderr ?? ''}`
}

/** 压缩 / 解压失败的分类（口径与 `main/extractor.ts` 的 classifyError 一致的精简版） */
export type ArchiveOpErrorKind = 'password' | 'corrupt' | 'timeout' | 'other'

export function classifyArchiveOpError(err: unknown): ArchiveOpErrorKind {
  const e = err as { message?: string; stderr?: string; stdout?: string; code?: unknown; killed?: boolean }
  const msg = `${e?.message ?? ''} ${e?.stderr ?? ''} ${e?.stdout ?? ''}`
  if (e?.code === 'ETIMEDOUT' || e?.killed === true || /timed out|ETIMEDOUT/i.test(msg)) return 'timeout'
  if (/password|encrypt|加密|需要密码/i.test(msg)) return 'password'
  if (/crc|corrupt|unexpected end|data error|损坏|不可预料的压缩文件末端/i.test(msg)) return 'corrupt'
  return 'other'
}

/** 把执行错误压成中文单行（stderr 只取前 200 字符，防 32MB 输出灌进 UI / 日志） */
export function summarizeArchiveOpError(err: unknown): string {
  const e = err as { message?: string; stderr?: string; stdout?: string }
  const raw = `${e?.stderr ?? ''}${e?.stdout ?? ''}`.trim()
  const text = (raw || e?.message || String(err)).replace(/\s+/g, ' ')
  return text.slice(0, 200)
}

/**
 * 7z 解压 `src` 到已存在的 `dest`。失败抛 Error（message 中文单行可行动），
 * 由调用方决定清理半成品目录。
 */
export async function extractWith7z(
  exe: string,
  src: string,
  dest: string,
  timeoutMs: number = OPS_TIMEOUT_MS
): Promise<void> {
  try {
    await runExe(exe, buildSevenZipExtractArgs(src, dest), timeoutMs)
  } catch (err) {
    const kind = classifyArchiveOpError(err)
    const detail = summarizeArchiveOpError(err)
    const prefix =
      kind === 'password'
        ? '压缩包有密码保护，暂不支持'
        : kind === 'corrupt'
          ? '压缩包已损坏，无法解压'
          : kind === 'timeout'
            ? '解压超时，请稍后重试'
            : '解压失败'
    throw new Error(detail.length > 0 ? `${prefix}（${detail}）` : prefix)
  }
}

/**
 * 解压后防穿越校验：递归走 `root`，任何一个条目的绝对路径不再以 `root` 为前缀
 * （大小写不敏感、整段对齐，与 `resolveWithinPinRoot` 同口径），或出现符号链接
 * （7z 在 Windows 上极少还原 symlink，但恶意包可造）→ 返回违规项的路径；干净 → null。
 */
export async function findPathEscape(root: string): Promise<string | null> {
  const rootNorm = path.normalize(root)
  const rootLow = rootNorm.toLowerCase()
  const stack: string[] = [rootNorm]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true })
    } catch {
      continue // 读不了的子树（权限 / 竞态）不构成穿越证据
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) return path.join(cur, d.name)
      const abs = path.resolve(cur, d.name)
      const absLow = abs.toLowerCase()
      if (absLow !== rootLow && !absLow.startsWith(rootLow + path.sep)) return abs
      if (d.isDirectory()) stack.push(abs)
    }
  }
  return null
}

/**
 * 7z 压缩 `srcs` 到 `destZip`（zip 格式）。失败抛 Error（中文单行）。
 */
export async function compressWith7z(
  exe: string,
  srcs: string[],
  destZip: string,
  timeoutMs: number = OPS_TIMEOUT_MS
): Promise<void> {
  try {
    await runExe(exe, buildSevenZipCompressArgs(srcs, destZip), timeoutMs)
  } catch (err) {
    const kind = classifyArchiveOpError(err)
    const detail = summarizeArchiveOpError(err)
    const prefix = kind === 'timeout' ? '压缩超时，请稍后重试' : '压缩失败'
    throw new Error(detail.length > 0 ? `${prefix}（${detail}）` : prefix)
  }
}

/**
 * PowerShell `Compress-Archive` 降级压缩（7-Zip 缺失时）。
 * 失败抛 Error（中文单行；调用方归档 `system-fallback-failed`）。
 */
export async function compressWithPowerShell(
  srcs: string[],
  destZip: string,
  timeoutMs: number = OPS_TIMEOUT_MS
): Promise<void> {
  const command = buildPowerShellCompressCommand(srcs, destZip)
  try {
    await runExe(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      timeoutMs
    )
  } catch (err) {
    const detail = summarizeArchiveOpError(err)
    throw new Error(detail.length > 0 ? `系统压缩失败（${detail}）` : '系统压缩失败')
  }
}
