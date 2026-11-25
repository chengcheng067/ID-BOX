/**
 * 一键打包与素材同步 —— 包格式契约 + 清单校验器（docs/58 §2.1 / §2.6，唯一真源 docs/57）。
 *
 * ## 定位
 *
 * 本模块是 **T1 地基**：定义「库包」三件套（manifest.json / index.json / assets/）的类型契约，
 * 以及 11 个**纯函数**校验器。主进程导出器（T2）/ 导入器（T3）/ 测试共用同一份契约，
 * 避免三处各写一套 JSON 解析与路径守卫而漂移。
 *
 * ## 硬约束（docs/58 §2.6 ④）
 *
 * 1. **零 IO / 零 `node:` import**：本文件不读盘、不写盘、不 import 任何 `node:` 模块
 *    （`folder` 现算用段拼接实现，语义与 `path.join` 对齐，见 `joinLibraryPath`），
 *    因此可在 node 环境 vitest 直接单测，也能被 preload / renderer 安全引用。
 * 2. **`folder` 绝对路径永不带**（Q-5）：`PortableAsset` 由 `Asset` 剔除 `folder` 派生，
 *    `toPortableAsset` 落下时删字段，`fromPortableAsset` 用目标机库根现算补回。
 * 3. **缓存字段不进包**（docs/58 §4.2）：`thumbPath` / `thumbStatus` 由 `toPortableAsset`
 *    剔除，由 `fromPortableAsset` 补 `undefined` / `'none'`，目标机惰性重建。
 * 4. **个人设置白名单**（Q-8 / C-5 + docs/60 §5.3）：只带 `aliases` + `customTaxonomy` +
 *    `projectTemplates` + 9 个 `home*` 键（12 键）；`mergePersonalSettings` 只覆盖白名单键，
 *    其余（尤其 `libraryDir` / `homePinnedFolders` / `homeFolderWallpaper`）逐字保留。
 * 5. ** aliases 合并复用** `renderer/logic/aliasIndex.mergeAliasRecords`（docs/58 §4.3）
 *    —— 该模块只 import `shared/**`、零 node / 零 React 依赖，故本文件引用它不构成 IO，
 *    也不产生循环依赖（aliasIndex → shared/{aliasRules,aliasSuggest,naming}，均不回流本文件）。
 */

import type { Asset, AssetFile, AssetKind, Settings } from './types'
import { mergeAliasRecords } from '../renderer/logic/aliasIndex'

// ── 常量：包格式魔数 / 版本 / 白名单 ────────────────────────────────────────

/** manifest.json 的固定魔数：防止把普通压缩包误当库包。 */
export const PACKAGE_FORMAT_MAGIC = 'idbox-library-package' as const

/** 本版本支持的包格式版本（大于此值 → 拒绝导入）。 */
export const PACKAGE_FORMAT_VERSION = 1 as const

/** 包内 apiVersion，`docs/39 §3.2` 的「只增不删」口径；不等于此值 → 拒绝导入。 */
export const PACKAGE_API_VERSION = '1' as const

/** zip 内素材根目录前缀（`assets/<relFolder>/<file.rel>`）。 */
export const PACKAGE_ASSETS_PREFIX = 'assets/' as const

/**
 * 导出大类的固定顺序（F-2 / docs/57 §6）：UI 勾选项与 manifest 回执都按此排列。
 *
 * 单一真源：UI 排序、`parseManifest` 的合法值收口都用它，避免两处各写一份 7 元数组而漂移。
 * 顺序为用户可读顺序，与分类导航序（`KIND_NAV_ORDER`）无关，别互相复用。
 */
export const PACKAGE_KIND_ORDER: readonly AssetKind[] = [
  'model',
  'texture',
  'material',
  'hdri',
  'cad',
  'd5a',
  'other'
]

/**
 * 从 `Asset` 剔除的字段（绝对路径 + 软删 + 缓存 + 派生）。
 *
 * 类型与运行时共用这一个数组，杜绝「类型剔了、运行时忘删」的漂移。
 * `mainFile` / `displayMetric` 等派生值不在 `Asset` 类型上（在 pluginSnapshot 侧计算），
 * 故无需列入 —— 它们天然不会进包。
 */
export const PORTABLE_OMIT_KEYS = [
  'folder',
  'thumbPath',
  'thumbStatus',
  'deletedAt',
  'trashRel'
] as const

/**
 * `personal.json` 的精确白名单（docs/58 §4.3 表 + C-5 批注 + docs/60 §5.3 Q-7）：12 键。
 *
 * `projectTemplates`（docs/60 §5.3）**加入**：模板是自包含实体，导入语义 = 整数组替换
 * （`mergePersonalSettings` 白名单键整键覆盖，零额外代码）。
 *
 * 明确**不含**：`libraryDir` / `watchDir` / `sevenZipPath`（机器路径）、
 * `homePinnedFolders`（`absPath` 机器相关路径，换机即失效，docs/60 §5.3 与
 * `libraryDir` 同理由）、`homeFolderWallpaper`（值是 userData 缓存文件名引用，
 * 图本体不随包走，docs/58 C-5 对 `homeBackground` 的既有裁定同款）、
 * `homeGuide*` 三键（引导记位）、`sidebar*Collapsed`（侧栏折叠）、
 * `plugin*` / `autoCheckUpdate` / `zhimo*`（插件与网络偏好）、
 * `savedViews` / `renameTemplate` / `theme` / `motionLevel` 等其余 `Settings` 键。
 */
export const PERSONAL_SETTINGS_KEYS = [
  'aliases',
  'customTaxonomy',
  'homeWaveColors',
  'homeWaveHeight',
  'homeWaveSpeed',
  'homeWaveLength',
  'homeParticleSize',
  'homeParticleDensity',
  'homeWaveInteractive',
  'homeWaveClickRipples',
  'homeBackground',
  'projectTemplates'
] as const

export type PersonalSettingsKey = (typeof PERSONAL_SETTINGS_KEYS)[number]

// ── 包格式契约类型 ──────────────────────────────────────────────────────────

/** manifest.json —— 自描述信封；`indexSha256` 对 index.json **落盘文本**计算。 */
export interface PackageManifest {
  /** 固定魔数，防普通压缩包误入。 */
  format: typeof PACKAGE_FORMAT_MAGIC
  /** 包格式版本；大于支持值拒绝。 */
  formatVersion: typeof PACKAGE_FORMAT_VERSION
  /** 对齐 docs/39 §3.2；不等于 '1' 拒绝。 */
  apiVersion: typeof PACKAGE_API_VERSION
  /** 导出端 `app.getVersion()`，仅记录不校验。 */
  appVersion: string
  /** ISO8601 UTC 落盘时刻。 */
  generatedAt: string
  /** index.json 记录数；与实读条数不符 → 坏包。 */
  count: number
  /** 素材总字节，导出前磁盘余量预检用。 */
  assetsBytes: number
  /**
   * 导出选项回执：本次实际导出了哪些大类（F-2 / docs/57 §6）。
   *
   * 新包必写本字段；旧包只有 `includeHdri` 布尔，`parseManifest` 会把它收口成等价集合。
   */
  includedKinds: AssetKind[]
  /**
   * 旧包回执（**只读兼容**，新包不再写）：F-2 前用布尔表示「是否带 HDRI」。
   * 保留仅为能读懂历史素材包，任何新逻辑都不得读它。
   */
  includeHdri?: boolean
  /** 导出选项回执：是否含 personal.json。 */
  includePersonalSettings: boolean
  /** index.json 落盘文本的 sha256（小写 64 hex）。 */
  indexSha256: string
  /** personal.json 存在时必填（其落盘文本的 sha256）。 */
  personalSha256?: string
  /** C-3 拍板：默认**不带**。类型保留仅为兼容未来版本，导出端不写此键。 */
  sourceLibraryRoot?: string
}

/** index.json 里的单个文件条目 = `AssetFile` + 可选逐文件 sha256（C-2 拍板）。 */
export interface PortableAssetFile extends AssetFile {
  /** 单遍流式计算的 sha256（小写 64 hex）；导入可定位具体坏文件。 */
  sha256?: string
}

/**
 * index.json 里的一条资产快照。
 *
 * = `Asset` 剔除 `folder` / 软删 / 缓存字段，并把 `files[]` 升级为带 sha256 的版本。
 * **没有 `folder`** —— 目标机一律用 `fromPortableAsset(record, libraryDir)` 现算（Q-5）。
 */
export type PortableAsset = Omit<Asset, (typeof PORTABLE_OMIT_KEYS)[number]> & {
  files: PortableAssetFile[]
}

/**
 * personal.json 的内容 = `Settings` 白名单子集（全部可选 = 真「补丁」语义）。
 *
 * 由 `PERSONAL_SETTINGS_KEYS` 映射生成，`Settings` 侧新增/改名键时这里自动对齐。
 */
export type PersonalPatch = { [K in PersonalSettingsKey]?: Settings[K] }

/** `validateManifest` 的第二个参数：当前程序支持的版本口径。 */
export interface ValidateManifestOptions {
  supportedFormatVersion: number
  apiVersion: string
}

// ── IPC 结果 / 载荷类型（沿用 HomeBackgroundSaveResult 的 ok/error 风格）────

/** `package:export` 返回：永不 reject，失败原因在 `error`。 */
export type PackageExportResult =
  | { ok: true; path: string; count: number; bytes: number }
  | { ok: false; error: string; canceled?: boolean }

/** `package:importInspect` 返回：**只读**，不改库；坏包原因在 `reason`。 */
export type PackageInspectResult =
  | { ok: true; manifest: PackageManifest; records: PortableAsset[]; personal?: PersonalPatch }
  | { ok: false; reason: string }

/** 记录级冲突裁决三档（Q-6，复用 `types.ts:553` 的同名语义）。 */
export type PackageResolution = 'skip' | 'overwrite' | 'keep-both'

/** 冲突裁决表：`key = Asset.id`。T4 可在不改 IPC 形状的前提下细化 value。 */
export type PackageResolutions = Record<string, PackageResolution>

/** `package:importApply` 返回：恢复出的 `Asset[]` 由渲染层写库。 */
export type PackageImportResult =
  | { ok: true; restored: Asset[]; personal?: PersonalPatch }
  | { ok: false; error: string }

/** `package:export` 入参；`destPath` 来自 `package:exportPick`。 */
export interface PackageExportInput {
  destPath: string
  records: PortableAsset[]
  /** 要导出哪些大类（F-2）：不在集合内的记录与其素材同时缺席。 */
  includedKinds: AssetKind[]
  includePersonalSettings: boolean
}

/** `package:importApply` 入参。 */
export interface PackageImportApplyInput {
  path: string
  resolutions: PackageResolutions
}

/** 主进程 → 渲染进程 `package:exportProgress` 的 payload。 */
export interface PackageExportProgressEvent {
  phase: 'assets' | 'finalize'
  done: number
  total: number
}

/** 主进程 → 渲染进程 `package:importProgress` 的 payload。 */
export interface PackageImportProgressEvent {
  done: number
  total: number
}

// ── 内部工具（不导出：不属于 §2.6 的 11 个函数）─────────────────────────────

/** 只认普通对象（排除 null / 数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深拷贝白名单值（只处理 Settings 里的数组 / 普通对象叶子），保证纯函数不改入参。 */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneValue(v)
    }
    return out as T
  }
  return value
}

/** 裸段检查：非空、无 `..` / `.`、无反斜杠、无控制字符。 */
function isSafeSegment(seg: string): boolean {
  if (typeof seg !== 'string' || seg.length === 0) return false
  if (seg === '.' || seg === '..') return false
  if (seg.includes('\\')) return false
  if (/[\u0000-\u001f\u007f]/.test(seg)) return false
  return true
}

/**
 * 目标机 `folder` 现算：`path.join(libraryDir, relFolder)` 的零依赖等价实现。
 *
 * - 库根含 `\`（Windows）→ 用 `\` 连接并把 rel 的 `/` 换成 `\`；
 * - 库根是 posix → 用 `/` 连接；
 * - 去掉库根尾部分隔符、rel 头部 `/`，避免多出分隔符。
 *
 * 单测用 `path.win32.join` / `path.posix.join` 双向比对，确保语义一致（Q-5 / T3 判据④）。
 */
function joinLibraryPath(libraryDir: string, relFolder: string): string {
  const root = typeof libraryDir === 'string' ? libraryDir : ''
  const rel = typeof relFolder === 'string' ? relFolder : ''
  const sep = root.includes('\\') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const relBody = rel.replace(/^\/+/, '')
  const normalizedRel = sep === '\\' ? relBody.replace(/\//g, '\\') : relBody
  if (trimmedRoot === '') {
    // 空库根：path.join('', 'a/b') === 'a/b'；根为 '/' 或 'C:\' 时仍需保留一根分隔符。
    return root.endsWith('/') || root.endsWith('\\') ? `${sep}${normalizedRel}` : normalizedRel
  }
  return `${trimmedRoot}${sep}${normalizedRel}`
}

// ════════════════════════════════════════════════════════════════════════════
// 11 个纯函数（docs/58 §2.6 全表）
// ════════════════════════════════════════════════════════════════════════════

/**
 * ① `parseManifest`：JSON 解析 + 必填字段类型收口；任何形态错误返回 `null`。
 *
 * 魔数 / 版本 / apiVersion 的**值**校验交给 `validateManifest`（好给出具体中文原因），
 * 这里只保证「拿到手的是一个字段类型齐全的对象」。
 */
export function parseManifest(text: string): PackageManifest | null {
  if (typeof text !== 'string' || text.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (typeof raw.format !== 'string') return null
  if (typeof raw.formatVersion !== 'number' || !Number.isFinite(raw.formatVersion)) return null
  if (typeof raw.apiVersion !== 'string') return null
  if (typeof raw.appVersion !== 'string') return null
  if (typeof raw.generatedAt !== 'string') return null
  if (typeof raw.count !== 'number' || !Number.isFinite(raw.count)) return null
  if (typeof raw.assetsBytes !== 'number' || !Number.isFinite(raw.assetsBytes)) return null
  if (typeof raw.includePersonalSettings !== 'boolean') return null
  if (typeof raw.indexSha256 !== 'string') return null

  /**
   * F-2 兼容收口：新包读 `includedKinds: AssetKind[]`（去重 + 按固定顺序排），
   * 旧包读 `includeHdri:boolean` 并还原成「除 hdri 外全开 / 全部大类」的等价集合。
   * 两字段都没有 → 不是合法包；两字段都在 → 以新字段为准。
   */
  let includedKinds: AssetKind[]
  if (Array.isArray(raw.includedKinds)) {
    const rawKinds = raw.includedKinds as unknown[]
    const valid = new Set<string>(PACKAGE_KIND_ORDER)
    if (!rawKinds.every((k) => typeof k === 'string' && valid.has(k))) return null
    includedKinds = PACKAGE_KIND_ORDER.filter((k) => (rawKinds as string[]).includes(k))
  } else if (typeof raw.includeHdri === 'boolean') {
    const legacyIncludeHdri = raw.includeHdri
    includedKinds = PACKAGE_KIND_ORDER.filter((k) => legacyIncludeHdri || k !== 'hdri')
  } else {
    return null
  }

  const manifest: PackageManifest = {
    format: raw.format as PackageManifest['format'],
    formatVersion: raw.formatVersion as PackageManifest['formatVersion'],
    apiVersion: raw.apiVersion as PackageManifest['apiVersion'],
    appVersion: raw.appVersion,
    generatedAt: raw.generatedAt,
    count: raw.count,
    assetsBytes: raw.assetsBytes,
    includedKinds,
    includePersonalSettings: raw.includePersonalSettings,
    indexSha256: raw.indexSha256
  }
  // 旧包原值只在对象里留档（不参与任何新逻辑）；新包不写此键。
  if (typeof raw.includeHdri === 'boolean') manifest.includeHdri = raw.includeHdri
  if (typeof raw.personalSha256 === 'string') manifest.personalSha256 = raw.personalSha256
  if (typeof raw.sourceLibraryRoot === 'string') manifest.sourceLibraryRoot = raw.sourceLibraryRoot
  return manifest
}

/**
 * ② `validateManifest`：格式魔数 / 版本 / apiVersion / count ≥ 0。
 *
 * 返回人类可读中文错误或 `null`（= 通过）。opts 省略时用本版本支持的口径。
 */
export function validateManifest(
  manifest: PackageManifest,
  opts: ValidateManifestOptions = {
    supportedFormatVersion: PACKAGE_FORMAT_VERSION,
    apiVersion: PACKAGE_API_VERSION
  }
): string | null {
  if (!manifest || typeof manifest !== 'object') return '素材包已损坏或不完整'
  if (manifest.format !== PACKAGE_FORMAT_MAGIC) return '这不是 ID BOX 素材包（格式标识不符）'
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    return '素材包格式版本号无效'
  }
  if (manifest.formatVersion > opts.supportedFormatVersion) {
    return '素材包版本更新，请升级 ID BOX 后再导入'
  }
  if (manifest.apiVersion !== opts.apiVersion) return '素材包格式不兼容'
  if (!Number.isInteger(manifest.count) || manifest.count < 0) return '素材包记录数无效'
  return null
}

/**
 * ③ `parseIndex`：index.json 解析；顶层必须是数组且基本形状齐全，否则 `null`。
 *
 * 只做「形状收口」，路径安全 / 重复 id / 条数 / sha256 由 `validateIndex` 负责。
 */
export function parseIndex(text: string): PortableAsset[] | null {
  if (typeof text !== 'string' || text.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  for (const item of raw) {
    if (!isRecord(item)) return null
    if (typeof item.id !== 'string' || typeof item.relFolder !== 'string') return null
    if (typeof item.name !== 'string' || typeof item.kind !== 'string') return null
    if (typeof item.size !== 'number' || !Number.isFinite(item.size)) return null
    if (!Array.isArray(item.files)) return null
    for (const file of item.files) {
      if (!isRecord(file) || typeof file.rel !== 'string') return null
    }
  }
  return raw as PortableAsset[]
}

/**
 * ④ `validateIndex`：条数 / sha256 / 路径安全 / id 唯一。返回中文错误或 `null`。
 *
 * `actualIndexSha256` 由调用方（主进程 T3）对 **index.json 落盘文本**用 `node:crypto`
 * 计算后传入 —— 本模块保持零 node import。省略时跳过包级校验（仅做结构校验），
 * 完整验包必须传；C-2 逐文件 sha256 的比对在提取阶段（T3）做。
 */
export function validateIndex(
  records: PortableAsset[],
  manifest: PackageManifest,
  actualIndexSha256?: string
): string | null {
  if (!Array.isArray(records)) return '素材包索引格式错误'
  if (!manifest || typeof manifest !== 'object') return '素材包已损坏或不完整'
  if (records.length !== manifest.count) {
    return `素材包索引记录数与清单不符（清单 ${manifest.count} 条，实际 ${records.length} 条）`
  }
  if (typeof actualIndexSha256 === 'string' && actualIndexSha256 !== manifest.indexSha256) {
    return '素材包索引校验和不符，文件可能已损坏'
  }

  const seen = new Set<string>()
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!isRecord(record)) return `素材包索引第 ${i + 1} 条记录格式错误`
    if (typeof record.id !== 'string' || record.id.length === 0) {
      return `素材包索引第 ${i + 1} 条记录缺少有效 id`
    }
    if (seen.has(record.id)) return '素材包索引存在重复记录 id'
    seen.add(record.id)
    if (typeof record.relFolder !== 'string' || !isSafeRelFolder(record.relFolder)) {
      return `素材包索引第 ${i + 1} 条记录路径不合法`
    }
    if (!Array.isArray(record.files)) return `素材包索引第 ${i + 1} 条记录文件清单格式错误`
    for (const file of record.files) {
      if (!isRecord(file) || typeof file.rel !== 'string' || !isSafeFileRel(file.rel)) {
        return `素材包索引第 ${i + 1} 条记录含有不合法的文件路径`
      }
    }
  }
  return null
}

/**
 * ⑤ `isSafeRelFolder`：四段、无 `..`、无盘符 / 绝对 / 反斜杠（rescan.ts:127-143 约束）。
 *
 * 合法样例：`贴图/木纹/橡木/橡木地板-01`。
 */
export function isSafeRelFolder(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (rel.includes('\\')) return false
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  const segments = rel.split('/')
  if (segments.length !== 4) return false
  return segments.every(isSafeSegment)
}

/**
 * ⑥ `isSafeFileRel`：相对资产文件夹的 posix 路径，无 `..` / 绝对 / 盘符（types.ts:235）。
 *
 * 合法样例：`wood.png` / `textures/wood_4k.exr`。
 */
export function isSafeFileRel(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (rel.includes('\\')) return false
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  const segments = rel.split('/')
  if (segments.length === 0) return false
  return segments.every(isSafeSegment)
}

/**
 * ⑦ `collectExpectedEntries`：生成 `assets/<relFolder>/<file.rel>` 提取白名单。
 *
 * 只有同时通过 `isSafeRelFolder` + `isSafeFileRel` 的条目才进集合 —— 这是导入侧
 * 「清单外条目零落盘 / zip-slip 跳过」的唯一依据（docs/57:25）。
 */
export function collectExpectedEntries(records: PortableAsset[]): Set<string> {
  const entries = new Set<string>()
  if (!Array.isArray(records)) return entries
  for (const record of records) {
    if (!isRecord(record) || typeof record.relFolder !== 'string') continue
    if (!isSafeRelFolder(record.relFolder)) continue
    if (!Array.isArray(record.files)) continue
    for (const file of record.files) {
      if (!isRecord(file) || typeof file.rel !== 'string') continue
      if (!isSafeFileRel(file.rel)) continue
      entries.add(`${PACKAGE_ASSETS_PREFIX}${record.relFolder}/${file.rel}`)
    }
  }
  return entries
}

/**
 * ⑧a `toPortableAsset`：`Asset` → `PortableAsset`。
 *
 * 删 `folder` + 软删 + 缓存字段，files 逐项浅拷贝（导出端 T2 随后补逐文件 sha256）。
 * 不改入参。
 */
export function toPortableAsset(asset: Asset): PortableAsset {
  const out: Record<string, unknown> = { ...asset }
  for (const key of PORTABLE_OMIT_KEYS) {
    delete out[key]
  }
  out.files = Array.isArray(asset.files) ? asset.files.map((f) => ({ ...f })) : []
  return out as unknown as PortableAsset
}

/**
 * ⑧b `fromPortableAsset`：`PortableAsset` → `Asset`。
 *
 * `folder` 用目标机库根现算（Q-5）；缓存字段置 `undefined` / `'none'`（docs/58 §4.2）；
 * 不改入参。
 */
export function fromPortableAsset(record: PortableAsset, targetLibraryDir: string): Asset {
  const asset: Asset = {
    ...record,
    files: Array.isArray(record.files) ? record.files.map((f) => ({ ...f })) : [],
    folder: joinLibraryPath(targetLibraryDir, record.relFolder),
    thumbPath: undefined,
    thumbStatus: 'none'
  }
  return asset
}

/**
 * ⑨a `pickPersonalSettings`：`Settings` → `PersonalPatch`（白名单 12 键）。
 *
 * 只拷贝白名单里**实际存在**的键（缺键不写进补丁），深拷贝叶子数组 / 对象以免改入参；
 * `libraryDir` 等机器相关键永远不在结果里（C-3 / Q-8）。
 */
export function pickPersonalSettings(settings: Settings): PersonalPatch {
  const patch: PersonalPatch = {}
  if (!isRecord(settings)) return patch
  const source = settings as unknown as Record<string, unknown>
  const target = patch as Record<string, unknown>
  for (const key of PERSONAL_SETTINGS_KEYS) {
    const value = source[key]
    if (value === undefined) continue
    target[key] = cloneValue(value)
  }
  return patch
}

/**
 * ⑨b `mergePersonalSettings`：把 `personal.json` 补丁合进目标机 `Settings`。
 *
 * 语义（docs/58 §4.3）：**只用白名单键覆盖，其余键逐字保留** —— 保证换机导入不会把目标机
 * `libraryDir` 改坏（importer.ts:318-337 同类 bug 防御）。`aliases` 走
 * `mergeAliasRecords`（同键覆盖、不覆盖目标机已有别名，其余键级记录追加），不整份替换。
 */
export function mergePersonalSettings(current: Settings, patch: PersonalPatch): Settings {
  const merged: Settings = { ...current }
  if (!isRecord(patch)) return merged
  const source = patch as Record<string, unknown>
  const target = merged as unknown as Record<string, unknown>
  for (const key of PERSONAL_SETTINGS_KEYS) {
    const value = source[key]
    if (value === undefined) continue
    target[key] = cloneValue(value)
  }
  if (Array.isArray(patch.aliases)) {
    merged.aliases = mergeAliasRecords(Array.isArray(current.aliases) ? current.aliases : [], patch.aliases).records
  }
  return merged
}
