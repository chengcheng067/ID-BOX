/**
 * 插件快照的**数据形状**（`docs/39-插件架构-索引快照与包规范.md` §3.1 / §3.2）。
 *
 * ## 为什么放在 shared 而不是 main
 *
 * `docs/39 §2.1` 定案：「**渲染层生成内容 + 主进程执行落盘**」——渲染层没有 Node 能力
 * （`README.md:285`、preload 全文无 `node:fs`），它只能把内容交出去；真正落盘的是主进程。
 * 两侧必须共用**同一份字段表**，否则"渲染层渲出的字段"与"主进程写进文件的字段"迟早漂移。
 *
 * 因此本文件是**纯函数层**：零 IO、零 Node 能力、零 electron、零 Dexie。
 * IO（目录、原子写、串行队列、SHA256、半写判定）在 `src/main/pluginExport.ts`。
 *
 * 三条通用格式口径（§3 段首，写死在这里）：
 * - UTF-8、**无 BOM**（Node `writeFile(..., 'utf-8')` 从不加 BOM）；
 * - **紧凑 JSON**，不做 pretty-print（插件解析更快）；
 * - 路径统一 posix `/`，时间一律 ISO8601 UTC（沿用 `logger.ts:199` / `kindMigrate.ts:248`）。
 */
import { pickPrimaryFile } from './classify'
import { UNCLASSIFIED } from './taxonomy'
import type { Asset, AssetFile, AssetKind } from './types'

// ── 写死的常量（docs/39 §3.3 / §3.5 / §6 A1：判据必须写死，不许运行时商量） ────

/** `apiVersion`：`"1"`，**只增不删**（docs/36 Q10） */
export const PLUGIN_API_VERSION = '1'

/** 落盘子目录名：`<userData>/plugin/`（§2.2，与 `thumbs/`、`logs/` 同级同风格） */
export const PLUGIN_DIR_NAME = 'plugin'

/** userData 目录名 —— 取自 package.json 的 `name`（改名会让插件找错根） */
export const PLUGIN_APP_DIR_NAME = 'idbox'

/** 两个固定文件名（§2.2 硬要求：插件不能猜路径，带时间戳的文件名在这里不适用） */
export const PLUGIN_INDEX_FILE_NAME = 'index.json'
export const PLUGIN_MANIFEST_FILE_NAME = 'manifest.json'

/** 新鲜度提示线（PRD D1，`docs/38:166`）；插件读它做提示条，不硬编码 */
export const FRESHNESS_HINT_SECONDS = 10

/** 规模判据（§3.3 写死）：记录数 ≤ 2000 **且** 文件 ≤ 2 MB ⇒ 全量单文件 */
export const MAX_RECORDS = 2000
export const MAX_INDEX_BYTES = 2 * 1024 * 1024

/** 节流（§6 A1 已拍板）：debounce quiet 1.5 s + max-wait 5 s，**不设定时兜底** */
export const DEBOUNCE_QUIET_MS = 1500
export const MAX_WAIT_MS = 5000

/** 半写判定（§3.4 第 4 条）：一次不一致先当"正在写"，连续 3 轮才报 IDBOX-102 */
export const HALF_WRITE_MAX_ROUNDS = 3

/**
 * 触发集（§6 A1 已拍板）。
 *
 * ⚠️ **缩略图涓流不入触发集**（`store.ts:593` 的 `ENSURE_THUMB_BATCH` 单轮补图会形成
 * 持续小流）。这里刻意把"被排除的触发"也写成常量，是为了让守卫测试能钉住"它不在集里"，
 * 而不是靠注释提醒后人——注释会被删，常量与测试不会。
 */
export const PLUGIN_TRIGGER_SET = [
  'startup',
  'importBatchDone',
  'rescan',
  'assignCategory',
  'trashRestore',
  'manualRefresh'
] as const

export type PluginTrigger = (typeof PLUGIN_TRIGGER_SET)[number]

/** 明确**不**触发写盘的事件（§2.3「不入触发集」那一行） */
export const EXCLUDED_PLUGIN_TRIGGERS = ['thumbDrip'] as const

// ── 错误码（§5：共用一张 ≤10 的表，不另立） ──────────────────────────────────

/** PRD §6.2 的六条原文语义，逐条照抄、不改一个定义 */
export const IDBOX_ERROR_CODES: Record<string, string> = {
  '101': '发现文件缺失（含未开导出）',
  '102': 'JSON 解析/校验失败（含半写）',
  '103': '路径失效（快照与盘不符，等价 410 GONE）',
  '104': '.skp 版本高于当前 SketchUp',
  '105': '路径越界被拒',
  '106': 'SketchUp 版本低于门槛'
}

/** 预留编号：107–110 **不定义**（真机核实前把【推断】当契约是禁止的） */
export const RESERVED_ERROR_CODES: readonly string[] = ['107', '108', '109', '110']

/** 码表上限（§5：总数不超 10） */
export const MAX_ERROR_CODES = 10

/** 码是否已定义 —— 预留编号不算定义 */
export function isDefinedErrorCode(code: unknown): boolean {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(IDBOX_ERROR_CODES, code)
}

// ── 字段表（§3.2） ────────────────────────────────────────────────────────────

/** `files` 每项**只两键**（J2「不暴露 schema」）；`name`/`size`/`kind`/`w`/`h` 不进快照 */
export interface PluginFileEntry {
  /** 相对资产文件夹，统一 `/` */
  rel: string
  /** 小写扩展名，不含点 */
  ext: string
}

/** 一条快照记录（字段顺序与 §3.2 的表逐字一致，便于对账） */
export interface PluginSnapshotRecord {
  /** UUID 主键，永不因改名/改库/改大类而变（P0-7）——插件侧唯一锚点 */
  id: string
  /** 原样 `Asset.name`，不在快照里预先折叠 */
  name: string
  /** 六值：model|texture|hdri|material|cad|other（`types.ts:19`） */
  kind: AssetKind
  category1: string | null
  category2: string | null
  source: string | null
  /** 显式可 null：插件要区分「无」与「未提供」 */
  zhimoId: string | null
  /** posix 相对库根 */
  relFolder: string
  /** **派生值，不是 Asset 字段**：`pickPrimaryFile()` 的结果，可 null */
  mainFile: string | null
  files: PluginFileEntry[]
  /** **仅当 `thumbStatus === 'ready'`** 时写；相对 `manifest.thumbsRoot` */
  thumbRel: string | null
  /** 实测缺失率高（76/143）⇒ 必须可空，插件不得假定有值 */
  suMajor: number | null
  /**
   * 逐条时间戳。§3.2 的架构偏差：`generatedAt` 从逐条字段改为**信封级一次**，
   * 逐条改用 P1 可增字段 `updatedAt`（只增不删）。非数字 → null。
   */
  updatedAt: string | null
}

/** `index.json` 信封（顶层是对象，不是数组） */
export interface PluginIndexEnvelope {
  apiVersion: string
  /** 信封级一次 */
  generatedAt: string
  libraryRoot: string
  count: number
  records: PluginSnapshotRecord[]
}

/** `manifest.json` 的 `lastError`（写入侧状态的承载方式之一，§5 第 2 条） */
export interface PluginLastErrorCode {
  /** §5 码表里的码（写入侧失败可归入 101/102 就归入） */
  code: string
  message: string
  /** ISO8601 UTC */
  at: string
}

/** `manifest.json`（发现文件，E1 落点）——字段表照 §3.1 逐条定型 */
export interface PluginManifest {
  apiVersion: string
  appVersion: string
  /** 本次 **manifest** 落盘时刻（不是 index 的，manifest 无法含自身哈希） */
  generatedAt: string
  /** 绝对路径，posix；插件靠它现算绝对路径 */
  libraryRoot: string
  /** false / 读不到文件 → IDBOX-101 */
  pluginIndexEnabled: boolean
  /** 写入侧状态的**唯一**承载方式 */
  state: 'ok' | 'error'
  lastError: PluginLastErrorCode | null
  /** **index.json 落盘字节**的 SHA256（小写 64 hex） */
  indexSha256: string
  indexBytes: number
  indexCount: number
  /** 偏离3：manifest 必须暴露它，插件直接读本地缩略图 */
  thumbsRoot: string
  freshnessHintSeconds: number
}

/** 渲染层 → 主进程的载荷（渲染层生成内容，主进程执行落盘） */
export interface PluginSnapshotPayload {
  trigger: string
  records: PluginSnapshotRecord[]
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

/**
 * 路径统一 posix `/`（§3 段首，照 `AssetFile.rel` 口径）。
 * 顺带消掉开头的 `./` 与结尾分隔符；空串/非字符串 → 空串（**永不抛异常**）。
 */
export function toPosix(value: unknown): string {
  if (typeof value !== 'string') return ''
  const unified = value.replace(/\\/g, '/')
  const noLeading = unified.startsWith('./') ? unified.slice(2) : unified
  return noLeading.replace(/\/+$/g, '')
}

/** 把任意值收口成可空字符串（`zhimoId` / `source` / `category1` 这类"区分无与未提供"的字段） */
function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 软删判定。判据与 `src/renderer/logic/trashView.ts:52` **完全一致**（`deletedAt` 是
 * **有限数字**才算），但这里不能反向依赖渲染层（main/shared ← renderer 是层向违规，
 * `ballThumb.ts:27` 有过先例教训），所以独立实现，并由 `tests/pluginExport.test.ts`
 * 逐条钉住"两份实现必须对同一批样本给出同一答案"。
 */
export function isSoftDeleted(asset: Pick<Asset, 'deletedAt'> | null | undefined): boolean {
  return typeof asset?.deletedAt === 'number' && Number.isFinite(asset.deletedAt)
}

/** `files` 只留 `rel`/`ext` 两键（§3.2） */
export function toPluginFileEntry(file: Pick<AssetFile, 'rel' | 'ext'>): PluginFileEntry {
  return {
    rel: toPosix(file.rel),
    ext: typeof file.ext === 'string' ? file.ext.toLowerCase() : ''
  }
}

/**
 * 生成一条记录。
 *
 * ⚠️ 本函数**不做软删判定**（软删记录由调用方过滤，见 `buildPluginRecords`）：
 * 判据归一处，避免"这里也过滤一遍、那里也过滤一遍"的两套口径。
 */
export function buildPluginRecord(asset: Asset): PluginSnapshotRecord {
  // 脏数据收口：`files` 在 Dexie 里可能是 null（实测有脏行），先收口再派生，
  // 否则 `pickPrimaryFile()` 会在 `files.length` 上抛 TypeError —— 快照是副作用，
  // 绝不能因为一条脏记录把整次上报炸掉。
  const safeFiles = Array.isArray(asset.files) ? asset.files : []
  const primary = pickPrimaryFile(safeFiles)
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    // 未分类哨兵（taxonomy.ts:19）；显式 null 才写 null
    category1: nullableString(asset.category1) ?? UNCLASSIFIED,
    category2: nullableString(asset.category2) ?? UNCLASSIFIED,
    source: nullableString(asset.source),
    zhimoId: nullableString(asset.zhimoId),
    relFolder: toPosix(asset.relFolder),
    // 派生值：files 为空时 pickPrimaryFile 返回 undefined → null
    mainFile: primary ? toPosix(primary.rel) : null,
    files: (Array.isArray(asset.files) ? asset.files : []).map(toPluginFileEntry),
    // 仅 ready 才写（§3.2）：none / failed 一律 null
    thumbRel: asset.thumbStatus === 'ready' ? nullableString(asset.thumbPath) : null,
    suMajor: typeof asset.suMajor === 'number' && Number.isFinite(asset.suMajor) ? asset.suMajor : null,
    updatedAt:
      typeof asset.updatedAt === 'number' && Number.isFinite(asset.updatedAt)
        ? new Date(asset.updatedAt).toISOString()
        : null
  }
}

/** 生成记录数组：**软删记录不入快照**（判据同 `store.ts:556`） */
export function buildPluginRecords(assets: readonly Asset[]): PluginSnapshotRecord[] {
  return (Array.isArray(assets) ? assets : [])
    .filter((a) => a && !isSoftDeleted(a))
    .map((a) => buildPluginRecord(a))
}

/** 生成信封（`generatedAt` 信封级一次） */
export function buildPluginEnvelope(
  records: readonly PluginSnapshotRecord[],
  meta: { generatedAt: string; libraryRoot: string }
): PluginIndexEnvelope {
  return {
    apiVersion: PLUGIN_API_VERSION,
    generatedAt: meta.generatedAt,
    libraryRoot: toPosix(meta.libraryRoot),
    count: records.length,
    records: [...records]
  }
}

/** 紧凑 JSON（无 pretty-print）：这就是落盘字节，SHA256 必须算在**同一份字符串**上 */
export function serializeCompact(value: unknown): string {
  return JSON.stringify(value)
}

/** UTF-8 字节数（不能用 `.length`：中文名字一条就差几十个字节，判据是按字节） */
export function byteLengthUtf8(text: string): number {
  if (typeof text !== 'string') return 0
  return new TextEncoder().encode(text).length
}

/** 规模判据分支（§3.3 写死） */
export type ScaleBranch = 'full' | 'over-limit'

export function scaleBranch(count: number, bytes: number): ScaleBranch {
  return count <= MAX_RECORDS && bytes <= MAX_INDEX_BYTES ? 'full' : 'over-limit'
}

/** `trigger` 白名单（deny by default：不在集里的一律拒） */
export function isPluginTrigger(value: unknown): value is PluginTrigger {
  return typeof value === 'string' && (PLUGIN_TRIGGER_SET as readonly string[]).includes(value)
}

/**
 * 半写判定（§3.4 第 4 条）：一次不一致先当作"正在写"，**连续 3 轮**仍不一致才报 102。
 *
 * 这条把「半写」和「读到两个 rename 之间的窗口」分开——后者下一轮就自愈，误报会让
 * 插件在窗口里显示错误状态。纯逻辑、零 IO、可单测。
 */
export type HalfWriteDecision = 'ok' | 'retry' | 'error'

export interface HalfWriteGuard {
  /** 喂一次校验结果（sha 是否相符），返回本轮处置 */
  observe(ok: boolean): HalfWriteDecision
  /** 当前连续不一致轮数 */
  rounds(): number
  /** 码：只有判定为 error 时才有（102），否则 null */
  code(): string | null
}

export function createHalfWriteGuard(maxRounds: number = HALF_WRITE_MAX_ROUNDS): HalfWriteGuard {
  let mismatch = 0
  return {
    observe(ok: boolean): HalfWriteDecision {
      if (ok) {
        mismatch = 0
        return 'ok'
      }
      mismatch += 1
      return mismatch >= maxRounds ? 'error' : 'retry'
    },
    rounds(): number {
      return mismatch
    },
    code(): string | null {
      return mismatch >= maxRounds ? '102' : null
    }
  }
}
