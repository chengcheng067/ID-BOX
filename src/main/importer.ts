import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractArchive, type ExtractionError } from './extractor'
import { checkSpaceFor } from './disk'
import {
  cleanStaging,
  createStaging,
  listTopLevel,
  moveDir,
  pathExists,
  readHead,
  safeJoin,
  walkFiles,
  STAGING_DIR
} from './fsutil'
import { kindFolder, kindOfExt, isCoverAssetImage, pickCover, primaryKind } from '../shared/classify'
import { isHdrExt, panoramaNoteFromName } from '../shared/hdrExts'
import {
  composeRelFolder,
  dedupeKeyOf,
  normalizeCategoryPair,
  pickAssetName,
  sanitizeCategorySegment,
  sanitizeName,
  stripNoise,
  uniqueName,
  zhimoIdFromSources
} from '../shared/naming'
import { classifyAssetName } from '../shared/classifyAsset'
import { buildInitialClassifyReview } from '../shared/classifyCrossCheck'
import { parseSkpVersion, SKP_HEAD_BYTES } from '../shared/skpVersion'
import { IMAGE_FILE_EXTS } from '../shared/imageExts'
import { readHeadForSize } from './probeSizes'
import { parseMaterialMetaJsonText } from './materialMeta'
import { writeSkpPreviewInto } from './skpPreview'
import { writeDwgPreviewInto } from './dwgPreview'
import { humanGB } from '../shared/space'
import {
  BatchLedger,
  buildDedupeIndex,
  matchConflict,
  type ConflictMatch,
  type DedupeIndex
} from './importConflict'
// 只借类型（`import type` 编译后完全擦除，不产生运行时依赖）：
// 询问门的 `ConflictQuery` 就是「一条待裁决的冲突」，与 importer 的判重点一一对应。
import type { ConflictQuery } from './conflictGate'
import type {
  ArchiveDisposal,
  Asset,
  AssetFile,
  AssetKind,
  Codepage,
  CoverSource,
  ImportConflictContext,
  ImportConflictExisting,
  ImportConflictResolution,
  ImportDedupeEntry,
  ImportEvent,
  ThumbStatus
} from '../shared/types'

/** 批量导入并发上限（PRD G1 / US-1：20 包分批，并发 ≤3） */
export const DEFAULT_CONCURRENCY = 3

/**
 * 单张图片直导的扩展名白名单（2026-10 装机反馈：用户原话
 * 「JPG 格式或 PNG 格式的贴图是没有办法拖进来的」）。
 * 命中 → 不走解压链路，直接归档为独立 `kind='texture'` 资产。
 *
 * 表本体已上移到 `shared/imageExts.ts`（反馈 4 起 renderer 的材质球兜底也要读它），
 * 这里保留原导出名做**纯别名**，既有调用方（含单测 `importerSingleImage.test.ts`）零改动。
 */
export const IMAGE_IMPORT_EXTS: ReadonlySet<string> = IMAGE_FILE_EXTS

export interface ImportDeps {
  libraryDir: string
  sevenZipPath: string | null
  /** 原压缩包处置三档（P0-5） */
  archiveDisposal: ArchiveDisposal
  defaultSource: string
  codepage: Codepage
  timeoutMs: number
  maxBytesForJsFallback: number
  spaceSafetyFactor: number
  concurrency: number
  /**
   * 缩略图生成（P0-9）——**依赖注入**，保证 importer 不 import electron、可在 vitest 里单测。
   * T04 会把 `main/thumb.ts` 的真实实现注入到这里；返回缓存文件名，失败返回 null。
   */
  ensureThumb?: (assetId: string, coverAbs: string | null) => Promise<string | null>
  /** 原包处置的注入点（测试用 stub 替代真实 trash） */
  disposeArchive?: (src: string, mode: ArchiveDisposal) => Promise<void>
  /**
   * 判重快照（docs/27 D21）。**不传 / `index` 为空 → 完全不判重、不询问**，
   * 行为与 0.6.9 逐字节等价（既有 `tests/importer*.test.ts` 是硬门槛）。
   */
  conflictContext?: ImportConflictContext
  /**
   * 冲突裁决（docs/27 T-03）。由 `runImport` 注入 `conflictGate.ask`；
   * 不注入时冲突项按「同时存在并重命名」处理（= 旧行为，绝不静默丢弃用户的包）。
   */
  askConflict?: (query: ConflictQuery) => Promise<ImportConflictResolution>
  /**
   * 覆盖时旧目录的去处（docs/27 D11）：系统回收站。
   * 主进程注入 `shell.trashItem`；未注入时退回 `trash` 包（与 `disposeArchive` 同款兜底）。
   * ⚠️ 失败时**绝不** `fs.rm` 兜底 —— 那是永久删除用户数据，超出「覆盖」的授权。
   */
  trashFolder?: (abs: string) => Promise<void>
  /**
   * 诊断日志注入点（importer 不 import logger/electron，测试里可注入 spy）。
   * 只有两处用：`import:conflict:folder-outside`（快照脏数据，绝不对库外路径动手）
   * 与 `import:conflict:trash-failed`（旧版本没能进回收站）。
   */
  warn?: (event: string, context?: unknown) => void
  emit: (ev: ImportEvent) => void
}

/** 正在使用的 staging 目录（进程退出 / 异常时强制清理，K2） */
const activeStaging = new Set<string>()

/**
 * 给**图片文件**补 `w` / `h`（0.6.0「贴图分辨率筛选」的采集端）。
 *
 * 口径（docs/22 §3.1 / §5「不改磁盘结构」）：
 * - 只读文件**头部**，不解码整图 —— 大库重扫时逐张 `sharp`/canvas 解码会把主进程卡死；
 * - 读头走 `probeSizes.readHeadForSize`（**与回填同一条口径**）：默认 64KB，
 *   解析失败且是 `jpg/jpeg` 时升到 1MB 重试一次（APP2/ICC 能到几百 KB，
 *   实测有图 SOF0 在 678557 字节处）；PNG / hdr / exr 不升级；
 * - 扩展名分两条分支（2026-10「HDR 分辨率筛选失效」补）：
 *   `hdr` / `exr` → `hdrSizeOf`（Radiance 文本头 / OpenEXR 属性列表），
 *   其余 → `imageSizeOf`（只认 PNG / JPEG）；
 * - 为什么 HDR 不能并进 `IMAGE_FILE_EXTS`：那张表同时是材质球的**兜底取图表**
 *   （`renderer/logic/materialBall.ts`），收进 `exr` 会让 `Displacement.exr`
 *   被当 albedo 贴到球上（球变灰/花）。所以这里按 `isHdrExt` 单独放行，
 *   白名单本身保持原样（详见 `shared/hdrExts.ts` 头注）；
 * - **失败静默**：读不出 / 格式不认识 → 不写 `w/h`（= 未知尺寸）。绝不能因为
 *   「读不出尺寸」让整条导入失败（尺寸只是筛选的辅助信息）。
 *
 * 为什么放在 importer 并对外导出：`rescan.ts` 要**同一份**实现（两处各写一遍必然漂移），
 * 而 `main/fsutil.walkFiles` 只负责 stat，不该反向依赖图片解析。
 *
 * @param folder 资产文件夹绝对路径（`AssetFile.rel` 相对它）
 * @param files  原地修改的 `AssetFile[]`
 */
export async function fillImageSizes(folder: string, files: AssetFile[]): Promise<void> {
  for (const file of files) {
    if (!IMAGE_FILE_EXTS.has(file.ext) && !isHdrExt(file.ext)) continue
    try {
      const size = await readHeadForSize(safeJoin(folder, file.rel), file.ext)
      if (!size) continue
      file.w = size.w
      file.h = size.h
    } catch {
      /* 静默：读不到就是未知尺寸 */
    }
  }
}

export function registerStaging(dir: string): void {
  activeStaging.add(dir)
}

export function unregisterStaging(dir: string): void {
  activeStaging.delete(dir)
}

export function activeStagingDirs(): string[] {
  return [...activeStaging]
}

export function clearActiveStaging(): void {
  activeStaging.clear()
}

/**
 * 并发受限的 map（自实现，不引 p-limit）。
 *
 * **单个任务抛错不会中断整批**：worker 内 try/catch，捕获后交给 `onError`
 * （未传则静默），然后继续取下一个 item。这样「批量单包失败不阻断其余」
 * （PRD US-1 / G1）由工具函数兜底，而不只靠调用方自觉。
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  onError?: (err: unknown, item: T, index: number) => void
): Promise<void> {
  if (items.length === 0) return
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let cursor = 0
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      const item = items[i]
      try {
        await fn(item, i)
      } catch (err) {
        if (onError) onError(err, item, i)
      }
    }
  })
  await Promise.all(workers)
}

/**
 * 大小写不敏感的「路径是否在库目录内」判定（Windows 语义，**纯字符串**）。
 *
 * ## 为什么主进程也要挡一道（v0.5.4 数据事故兜底）
 *
 * 渲染层已经按 `settings.libraryDir` 过滤过一次，但库目录可能刚刚被改、或渲染层被注入，
 * 主进程不能信任入参：一旦库里已有的文件被当成"新导入"，`importOne` 会
 * staging → `uniqueName` 生成 `名字-2/-3…` 副本，且末尾 `disposeArchive` 可能把
 * **库内原文件**按 recycle/delete 档处置掉。
 *
 * ## 为什么不复用 `shared/vault.ts:isWithinRoot`
 *
 * 那个函数是**大小写敏感**的，且被 `vault://` 路由当安全边界用；改它会改变既有行为。
 * 这里按导入链路的需求单独实现：统一 `\`、去尾部 `\`、`toLowerCase()`，
 * 并用 `root + sep` 前缀判定挡住 `…\Library2` 这类"同前缀不同目录"的陷阱。
 */
export function isInsideLibraryDir(libraryDir: string, target: string): boolean {
  if (!libraryDir || !target) return false
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+/g, path.sep)
    return resolved.replace(/[\\/]+$/, '').toLowerCase()
  }
  const root = norm(libraryDir)
  const p = norm(target)
  if (!root || !p) return false
  return p === root || p.startsWith(root + path.sep)
}

/**
 * DEF-14（0.7.8）：把「预分类给出的 category1/category2」变成**可落盘的目录段**。
 *
 * ## 缺陷（DEF-14，`docs/08` §7.1）
 *
 * 词表里有含 `/` 的并列词条（`椅子/凳子`、`酒店/民宿`、`筒灯/射灯`、`金箔/银箔`、
 * `灯膜/灯罩`…）。旧实现把**原始值**直接喂给 `path.join(lib, kind, cat1, cat2)`
 * —— `path.join` 把 `/` 当目录分隔符 → 磁盘变**五段**；而 `relFolder` 走
 * `composeRelFolder`（内部已把 `/` 换成 `_`）→ 记录是**四段**，
 * 于是 `asset.folder !== path.join(lib, asset.relFolder)`。下一次 `rescan`
 * （固定三层下钻，`src/renderer/store.ts` 注释：磁盘目录名才是权威）把它读成
 * `category2='椅子'` / `name='凳子'` —— **分类和资产名同时损坏**。
 *
 * ## 修法（只改导入侧，不动 `composeRelFolder` / `sanitizeCategorySegment` / rescan）
 *
 * 在**算目录之前**一次算出 `cat1`/`cat2`，并让三处共用同一对字符串：
 * ① `cat2Dir` 的分段；② `composeRelFolder` 的分段；③ `Asset.category1/2`。
 * 记录必须存**净化后**的值（不是词表原貌）：rescan 以磁盘为权威，存原始值只会
 * 造成"记录先假一致、用户点一次重新扫描就被推翻"。
 *
 * 两道清洗，顺序有意义：
 * 1. `normalizeCategoryPair` —— 与用户「指派分类」IPC（`main/index.ts:assignCategory`）
 *    **同一口径**（`cleanSegment` / `ILLEGAL_RE`）：Windows 非法字符 `<>:"/\|?*` 与控制
 *    字符 → `_`，收拢空白、去尾部 `.`/空格、超长按码点截断。这样「导入落盘」与
 *    「事后指派」不会给出两个不同的目录名。
 * 2. `sanitizeCategorySegment` —— 就是 `composeRelFolder` 内部用的那个函数（幂等）。
 *    保留这一步是为了让「磁盘段 = relFolder 段」由**同一个函数**保证，
 *    不依赖第 1 步的实现细节（将来任一侧改规则，这里仍然是同一条）。
 *
 * ⚠️ 不在这里做任何 IO，纯函数；两个导入路径（压缩包 `importOne` / 单图 `importMediaOne`）
 * 都必须在 `mkdir` 之前调用。
 */
function resolveCategorySegments(
  category1: string,
  category2: string
): { cat1Seg: string; cat2Seg: string } {
  const pair = normalizeCategoryPair(category1, category2)
  return {
    cat1Seg: sanitizeCategorySegment(pair.category1),
    cat2Seg: sanitizeCategorySegment(pair.category2)
  }
}

/**
 * 一个导入批次的共享上下文（docs/27 T-04）。
 *
 * - `index`：判重快照编成的两张表（**整批共用**，不逐条重编）；
 * - `ledger`：批内名字台账（§5.1 修「并发 3 下同名包互踩」）；
 * - `total` / `settled`：算 `ImportConflictAsk.remainingItems`（弹窗提示「还有 N 个在检查」）。
 */
interface ImportBatch {
  index: DedupeIndex
  ledger: BatchLedger
  total: number
  settled: number
}

/** 批量导入（并发 ≤3，单个失败不阻断其余） */
export async function importPaths(paths: string[], deps: ImportDeps): Promise<Asset[]> {
  const assets: Asset[] = []

  // ── 库内回灌守卫（v0.5.4）──────────────────────────────────────
  // 在进并发链路**之前**剔除：库内路径连 staging 都不该建（建了就是一次真实写盘）。
  // 每条都发一个 error 事件，让 UI 明确告诉用户"已跳过"，而不是静默少导了几个。
  const accepted: string[] = []
  for (const p of paths) {
    if (isInsideLibraryDir(deps.libraryDir, p)) {
      deps.emit({
        item: p,
        itemName: path.basename(p),
        status: 'error',
        message: '这个文件已经在素材库里，已跳过（不会重复导入）'
      })
      continue
    }
    accepted.push(p)
  }
  if (accepted.length === 0) return assets

  // 判重快照为空 / 未传 → 索引为空 → `matchConflict` 恒 null → 行为与 0.6.9 完全一致（D21）
  const batch: ImportBatch = {
    index: buildDedupeIndex(deps.conflictContext?.index),
    ledger: new BatchLedger(),
    total: accepted.length,
    settled: 0
  }

  await mapWithConcurrency(
    accepted,
    deps.concurrency || DEFAULT_CONCURRENCY,
    async (p) => {
      // 双保险：mapWithConcurrency 已兜底，这里再包一层以保留原有错误语义
      try {
        const asset = await importOne(p, deps, batch)
        if (asset) assets.push(asset)
      } catch (err) {
        emitFailure(deps, p, err)
      } finally {
        // 无论成功/跳过/失败，该条都"出结果了" → remainingItems 减一
        batch.settled += 1
      }
    },
    (err, p) => emitFailure(deps, p, err)
  )
  return assets
}

function emitFailure(deps: ImportDeps, p: string, err: unknown): void {
  deps.emit({
    item: p,
    itemName: path.basename(p),
    status: 'error',
    message: failureMessage(err)
  })
}

function failureMessage(err: unknown): string {
  if (err instanceof Error && typeof (err as ExtractionError).kind === 'string') {
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

// ══════════════════════════════════════════════════════════════════
// 导入重复处置（docs/27 T-04）
//
// 三段职责：
// ① `resolveConflict()` —— 判定 + 询问（**必须早于任何 mkdir**，见 §6.1 判据 ①）；
// ② `replaceAssetFolder()` —— 覆盖的三步执行（挪旧 → 落新 → 销毁旧，D13）；
// ③ `applyOverwriteInherit()` —— 覆盖后的元数据继承（D12）。
// ══════════════════════════════════════════════════════════════════

/** 判重结果 + 用户裁决 */
interface ConflictDecision {
  match: ConflictMatch
  resolution: ImportConflictResolution
}

/** 判重条目 → 弹窗用的瘦投影（不带 folder / meta：UI 看不到也不该看到库外路径） */
function conflictExistingOf(match: ConflictMatch): ImportConflictExisting {
  const e = match.existing
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    relFolder: e.relFolder,
    size: e.size,
    importedAt: e.importedAt,
    otherCopies: match.otherCopies,
    sizeMismatch: match.sizeMismatch
  }
}

/**
 * 判重 + 询问（docs/27 §1.2 / §4.5）。
 *
 * 返回 `null` = 不判重，调用方走**完全原有**的落盘链路（D01 的「都不命中」分支）。
 * 判定全部是纯函数（`matchConflict`），**不产生任何磁盘副作用**：这条保证是
 * 「跳过时连空分类目录都不产生」的前提（§3.1）。
 *
 * `askConflict` 未注入时按 `keep-both` 处理：宁可多一份 `-2` 副本，也绝不静默丢弃用户的包。
 */
async function resolveConflict(
  batch: ImportBatch,
  deps: ImportDeps,
  info: {
    item: string
    itemName: string
    assetName: string
    kind: AssetKind
    size: number
    zhimoId?: string | null
  }
): Promise<ConflictDecision | null> {
  if (!deps.conflictContext || batch.index.size === 0) return null

  const match = matchConflict(batch.index, {
    assetName: info.assetName,
    kind: info.kind,
    size: info.size,
    zhimoId: info.zhimoId,
    dedupeKey: dedupeKeyOf(info.assetName, info.kind)
  })
  if (!match) return null

  let resolution: ImportConflictResolution = 'keep-both'
  if (deps.askConflict) {
    // 等待期间的状态复用既有 `organizing` + `message`（§2.3）：不新增"等待中"状态，
    // `ImportQueue.tsx` 直接渲染 message，用户能看到这条在等他的决定。
    deps.emit({
      item: info.item,
      itemName: info.itemName,
      status: 'organizing',
      message: '检测到重复素材，等待你的选择…'
    })
    resolution = await deps.askConflict({
      item: info.item,
      itemName: info.itemName,
      assetName: info.assetName,
      kind: info.kind,
      size: info.size,
      reason: match.reason,
      zhimoId: info.zhimoId ?? undefined,
      existing: conflictExistingOf(match),
      // 本批还没出结果的源文件数（含当前这条）：弹窗顶部「还有 N 个包正在检查」
      remainingItems: Math.max(0, batch.total - batch.settled)
    })
  }
  return { match, resolution }
}

/** 跳过的上报（D09/D20：走 `status:'skipped'` + `conflict`，不复用 rescan 的 `IgnoredReason`） */
function emitSkipped(
  deps: ImportDeps,
  info: { item: string; itemName: string },
  decision: ConflictDecision
): void {
  deps.emit({
    item: info.item,
    itemName: info.itemName,
    status: 'skipped',
    message: '已跳过重复素材（原文件保留在原位）',
    conflict: {
      reason: decision.match.reason,
      resolution: 'skip',
      existingName: decision.match.existing.name
    }
  })
}

/**
 * `done` 事件上的处置标记（keep-both / overwrite 才有）。
 *
 * `degraded=true` 只表示「覆盖了，但旧版**没进**回收站」（见 `isDegradedOverwrite`）。
 * 正常情况下**连字段都不带**（不是 `false`）：这样没走退化的事件与 0.6.9 逐字节一致，
 * 渲染层也只需判 `=== true`。
 */
function conflictNote(
  decision: ConflictDecision,
  resolution: ImportConflictResolution,
  degraded = false
): NonNullable<ImportEvent['conflict']> {
  return {
    reason: decision.match.reason,
    resolution,
    existingName: decision.match.existing.name,
    ...(degraded ? { degraded: true } : {})
  }
}

/**
 * `done` 事件的补充文案（§3.2.4）：覆盖档有两种情形必须**显式告诉用户**，不能静默 ——
 * ① 旧版本没能进回收站（被 DCC 占用等）→ 已暂存为 `.idbox-old-*`；
 * ② 走了退化分支（旧目录已不存在 / 不在库内 / kind 变了）→ 按新素材落盘。
 */
function doneMessage(
  decision: ConflictDecision | null,
  replace: ReplaceResult | null
): string | undefined {
  if (!decision || decision.resolution !== 'overwrite') return undefined
  if (!replace) return '已覆盖（原目录已不存在，按新素材落盘）'
  if (!replace.oldDirTrashed) return '已覆盖；旧版本未能移入回收站，已暂存为 .idbox-old-*'
  return undefined
}

/**
 * 覆盖是否走了「旧版没进回收站」的退化路径 —— `ImportEvent.conflict.degraded` 的唯一判据。
 *
 * 刻意复用 `doneMessage()`：**有解释文案 ⇔ 旧版没进回收站**，两者必须永远同步。
 * 渲染层据此决定「旧版在系统回收站」这句话能不能说（说错了用户不会去清回收站）。
 *
 * 三种命中：`replace===null`（旧目录不存在 / kind 变 / 库外，按新素材落盘）、
 * `!oldDirTrashed`（暂存 `.idbox-old-*`）；正常原位替换 → false。
 */
function isDegradedOverwrite(
  decision: ConflictDecision | null,
  replace: ReplaceResult | null
): boolean {
  return doneMessage(decision, replace) !== undefined
}

/** 覆盖目标是否满足「原位替换」的前提（§3.2.4 退化分支的判据） */
type OverwriteVerdict = 'ok' | 'kind-changed' | 'outside-library' | 'missing-folder'

async function checkOverwriteTarget(
  deps: ImportDeps,
  existing: ImportDedupeEntry,
  kind: AssetKind
): Promise<OverwriteVerdict> {
  // kind 变了 → 四层路径的顶层大类目录必然变，原位替换无从谈起
  if (kind !== existing.kind) return 'kind-changed'
  // 快照脏数据 / 用户刚换过库目录：绝不对库外路径动手
  if (!isInsideLibraryDir(deps.libraryDir, existing.folder)) {
    deps.warn?.('import:conflict:folder-outside', { id: existing.id, folder: existing.folder })
    return 'outside-library'
  }
  // 用户手工删了 / 移走了那条资产
  if (!(await pathExists(existing.folder))) return 'missing-folder'
  return 'ok'
}

/**
 * 旧目录 → 系统回收站（D11：**不进**库内 `.trash`，理由见 docs/27 §3.2.2）。
 *
 * 未注入 `trashFolder` 时退回 `trash` npm 包（与 `disposeArchive` 的兜底同款，
 * 只为单测/开发态保底）。**任何情况下都不 `fs.rm`**：那是永久删除，超出「覆盖」授权。
 */
async function trashAssetFolder(abs: string, deps: ImportDeps): Promise<void> {
  if (deps.trashFolder) return deps.trashFolder(abs)
  const { default: trash } = await import('trash')
  await trash(abs)
}

/** 覆盖三步的结果 */
interface ReplaceResult {
  /** 旧内容是否成功进回收站 */
  oldDirTrashed: boolean
  /** 没进回收站时留在盘上的 `.idbox-old-*` 目录（要写进 done 事件文案） */
  leftover: string | null
}

/**
 * 覆盖执行器（docs/27 §3.2.4 / D13）：**挪旧 → 落新 → 销毁旧**。
 *
 * 为什么必须是这个顺序：目标路径被旧目录占着，`fs.rename` 无法覆盖非空目录；
 * 而「先删旧再落新」会在落新失败时把用户的原件弄丢。
 *
 * 三条失败语义：
 * - 第 1 步（挪旧）失败 → 直接抛：磁盘零改动，本条导入失败，staging 照常清理；
 * - 第 2 步（落新）失败 → rename 回滚（旧目录回原位）后抛：**绝不出现「记录指向不存在的目录」**；
 * - 第 3 步（销毁旧）失败 → **不回滚**（新内容已就位、数据正确），保留 `.idbox-old-*`
 *   + 由调用方把「旧版本未能移入回收站」写进 done 事件；**绝不 `fs.rm` 兜底**。
 *
 * 临时名用 `.` 开头（`.idbox-old-<id>`）：`rescan` / `watcher` 天然跳过（`rescan.ts:54`、
 * `watcher.shouldIgnoreWatchPath`），也不会出现在任何视图里。
 */
async function replaceAssetFolder(
  target: string,
  id: string,
  deps: ImportDeps,
  place: (target: string) => Promise<void>
): Promise<ReplaceResult> {
  const parent = path.dirname(target)
  let temp = path.join(parent, `.idbox-old-${id}`)
  // 崩溃残留兜底：同名临时目录已存在 → 加时间戳（§5.7）
  if (await pathExists(temp)) temp = `${temp}-${Date.now()}`

  // ① 挪旧（同父目录 = 同盘 O(1)）
  await fs.rename(target, temp)

  // ② 落新
  try {
    await place(target)
  } catch (err) {
    // 回滚：新内容没落成，旧目录必须回到原位，否则记录会指向不存在的目录（D13）。
    // 先把**新内容的残骸**清掉（旧内容此时安全地躺在 temp 里，target 上只可能是本次新写的），
    // 否则 `rename` 到非空目录在 Windows 上会失败，回滚就变成了空动作。
    if (await pathExists(target)) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
    }
    await fs.rename(temp, target).catch(() => {})
    throw err
  }

  // ③ 销毁旧（失败只降级，不回滚）
  try {
    await trashAssetFolder(temp, deps)
    return { oldDirTrashed: true, leftover: null }
  } catch (err) {
    deps.warn?.('import:conflict:trash-failed', {
      dir: temp,
      error: err instanceof Error ? err.message : String(err)
    })
    return { oldDirTrashed: false, leftover: temp }
  }
}

/**
 * 覆盖后的记录（docs/27 §3.2.3 / D10 / D12）：**同位替换 + 元数据 100% 继承**。
 *
 * | 字段 | 取值 |
 * |---|---|
 * | `id` / `name` / `folder` / `relFolder` | 旧值（`fresh` 里已按旧路径构造） |
 * | `category1/2` | 旧值 —— 见下方说明 |
 * | 收藏 / 评分 / 色标 / 标签 / 风格 / 备注 | 旧值；`note` 用 `旧 || 新`（空串不算覆盖） |
 * | `files` / `size` / `cover` / `thumb*` / `suVersion` / `materialMeta` / `mojibake` | 新值（跟着内容走） |
 * | `zhimoId` | `新 ?? 旧`（只增不减，封面抓取依赖它） |
 * | `importedAt` / `updatedAt` | 新时间（覆盖后这份就是"当前的"） |
 * | `dedupeKey` | 用**旧名**重算（name 不变 → 与旧值一致，重算只为自洽） |
 *
 * ⚠️ 分类为什么无条件取旧值（含「双哨兵」情形）：目标路径恒等于 `existing.folder`，
 * 分类段就是那条路径的 `<一级>/<二级>`。若旧值是 `未分类/未分类` 而改用新包预分类，
 * 记录会声称自己在 `家具/椅子` 上、磁盘却在 `未分类/未分类/…` —— `relFolder`、
 * `category`、磁盘三者不一致，下一次 `rescan` 就会把分类改回去，等于白改。
 * 「双哨兵才用新结论」的前提是允许换路径，而 D10 已裁定沿用旧路径，故此处取旧值。
 */
function applyOverwriteInherit(fresh: Asset, existing: ImportDedupeEntry): Asset {
  const meta = existing.meta
  return {
    ...fresh,
    id: existing.id,
    name: existing.name,
    favorite: meta.favorite,
    rating: meta.rating,
    colorTag: meta.colorTag,
    tags: [...meta.tags],
    styles: [...meta.styles],
    // 空串不覆盖：HDR 的全景对齐参数写在 note 里，新包没写就必须留住旧值
    note: meta.note || fresh.note,
    category1: meta.category1,
    category2: meta.category2,
    // 分类判定依据（docs/35 §6.4）：旧记录有就继承 —— 同 `zhimoId` 的"本地优先"口径。
    // 覆盖导入时新包只拿到磁盘上的目录名，拿不回"当时是谁判的 / 用户定过案没有"；
    // 丢了它，T1 交叉验证会把用户已定案的记录重新当成"S1 猜的"并可能搬走目录。
    //
    // ⚠️ 顺序是 `旧 ?? 新` 而**不是** `新 ?? 旧`：T0 会给**每一条**新记录写初值
    //    （`medium-s1` / `none`），`fresh` 永远非空 → 若让 `fresh` 优先，这条路就等于
    //    "覆盖导入无条件把 `decidedAt` / `high` 重置成不用一分钟前刚猜的结论"，
    //    继承整段失效。这与 §6.4 的"旧记录有就继承"原意一致（那里的 `fresh.classifyReview`
    //    是 T0 写入之前写的形状）。
    classifyReview: meta.classifyReview ?? fresh.classifyReview,
    zhimoId: fresh.zhimoId ?? existing.zhimoId,
    dedupeKey: dedupeKeyOf(existing.name, fresh.kind)
  }
}

async function importOne(src: string, deps: ImportDeps, batch: ImportBatch): Promise<Asset | null> {
  const st = await fs.stat(src)
  const isDir = st.isDirectory()
  const itemName = path.basename(src)

  // ── 单文件直导（2026-10 任务 2 / 0.6.5 HDR）：不进解压/staging 链路 ──────
  //
  // 图片 → `kind='texture'`；HDR/EXR → `kind='hdri'`（落 `HDRI/未分类/未分类`）。
  // ⚠️ HDR **不能**塞进 `IMAGE_IMPORT_EXTS`：那张表同时是材质球兜底取图的白名单，
  //    加进去会让 `Displacement.exr` 被当成 albedo 贴上球（见 `shared/hdrExts.ts` 头注）。
  if (!isDir) {
    const ext = path.extname(itemName).slice(1).toLowerCase()
    if (IMAGE_IMPORT_EXTS.has(ext)) return importMediaOne(src, st, deps, 'texture', batch)
    if (isHdrExt(ext)) {
      // kind 复用 `shared/classify.ts` 的 ext→kind 唯一映射（hdr/exr → 'hdri'），
      // 不在这里再写一张表（两处表必然漂移）。
      return importMediaOne(src, st, deps, kindOfExt(ext), batch)
    }
    // 单文件模型（0.8.4）：孤零零一个 .skp / .max / .obj / .fbx …
    // 旧实现会掉进下面的 extractArchive 被判「不是压缩包」→ 用户拖进去像没反应。
    // 现在走 `importModelOne`：建资产文件夹 + **复制**（源工程文件原地不动）+ 补封面。
    // kind 判定用同一张 EXT_KIND（含 40+ 模型扩展名），别在这里列白名单。
    //
    // ⚠️ 必须**同时**接受 `'cad'`（2026-10-29 CAD 大类拆出）：`.dwg` / `.dxf` 的单文件
    // 与模型单文件同构（独占文件夹、要拖进 CAD 软件），但要落 `CAD/` 而不是 `模型/`。
    // 漏掉这一项 → 单个 `.dwg` 会掉进下面的 `extractArchive` → 报「不是压缩包」。
    // `importModelOne` 内部自己用 `kindOfExt(ext)` 算 kind，不写死 `'model'`。
    const extKind = kindOfExt(ext)
    if (extKind === 'model' || extKind === 'cad') return importModelOne(src, st, deps, batch)
  }

  // ── P0-3 磁盘空间预检：不足直接拒绝，**不建 staging、不产生半成品** ──
  if (!isDir) {
    const space = await checkSpaceFor(src, deps.libraryDir, {
      sevenZipPath: deps.sevenZipPath,
      maxBytesForJsFallback: deps.maxBytesForJsFallback,
      safetyFactor: deps.spaceSafetyFactor
    })
    if (!space.ok) {
      deps.emit({
        item: src,
        itemName,
        status: 'error',
        message: `磁盘空间不足：可用 ${humanGB(space.freeBytes)} / 需要 ${humanGB(space.requiredBytes)}。请在设置里「更改库目录」或清理磁盘后重试`,
        needBytes: space.requiredBytes,
        freeBytes: space.freeBytes
      })
      return null
    }
  }

  deps.emit({
    item: src,
    itemName,
    status: 'extracting',
    message: isDir ? '正在读取文件夹…' : '正在解压…'
  })

  const staging = await createStaging(deps.libraryDir)
  registerStaging(staging)
  let extractMojibake = false
  try {
    if (isDir) {
      await fs.cp(src, staging, { recursive: true })
    } else {
      const res = await extractArchive(src, staging, {
        sevenZipPath: deps.sevenZipPath,
        codepage: deps.codepage,
        timeoutMs: deps.timeoutMs,
        maxBytesForJsFallback: deps.maxBytesForJsFallback
      })
      extractMojibake = res.mojibake
    }

    deps.emit({ item: src, itemName, status: 'organizing', message: '正在分类归档…' })

    // contentRoot **递归下钻**（2026-10 用户样本 A 证实知末包是双层嵌套：
    // `attachment_<id>/模型文件夹/模型.skp` + 3 个 junk 文件）。
    // 规则：`listTopLevel` 已剔除 junk；若当前层直接子项**只剩 1 个文件夹**
    // → 继续下钻，直到剩多个项 / 含文件 / 到底。资产名取最终层文件夹名
    // （样本 A → `中古侘寂屏风_木屏风_藤编屏风_可折叠屏风`，junk 天然出局）。
    let contentRoot = staging
    let top = await listTopLevel(staging)
    if (top.length === 0) throw new Error('压缩包内没有文件')
    let drilledFolderName: string | null = null
    while (top.length === 1 && top[0]!.isDir) {
      drilledFolderName = top[0]!.name
      contentRoot = path.join(contentRoot, drilledFolderName)
      top = await listTopLevel(contentRoot)
    }

    const files: AssetFile[] = []
    await walkFiles(contentRoot, contentRoot, files)
    if (files.length === 0) throw new Error('没有可归档的文件')

    // 资产名：下钻过 → 最终层文件夹名（走清洗/水印剥离）；否则维持既有规则
    // （顶层唯一文件夹名 / zip 名，`pickAssetName` 幂等）
    const assetName = drilledFolderName
      ? sanitizeName(stripNoise(drilledFolderName))
      : pickAssetName(path.basename(src, path.extname(src)), top)
    const kind = primaryKind(files)
    // 落盘大类目录名一律走 `kindFolder(kind)`（⚠️ 不是 KIND_LABEL 显示名）。
    // 材质大类合并后 texture 与 material 都落「材质」（docs/14 §2.1）。
    const folderName = kindFolder(kind)

    // ── 文件名智能预分类（2026-10 任务 1，用户拍板方案 A）────────
    // 命中词表 → 落 <大类>/<一级>/<二级>/<资产名>；未命中 → 双哨兵。
    // 词表只是"建议"（06 §9.1 规则 1），用户随时可在 UI 改派。
    //
    // 【v1.0.10】kind ↔ 一级频道一致性闸门：一级必须属于**本 kind 的容器词表**，
    // 否则会造出 `材质/硬装构件/…` 这类"大类下出现别的频道一级"的错位目录
    // （例：贴图名叫「屏风贴图」→ 命中模型频道的一级 硬装构件）。
    // 【v1.0.12】闸门拒绝时**再试一级回退**，保住正确的一级。
    // 【v1.0.13】判定实现已上移到 `shared/classifyAsset.ts`（`classifyAssetName`）——
    // 渲染层的「重跑自动分类」（设置页）用的是**同一份**判定，两处不会漂移。
    const { category1, category2 } = classifyAssetName(
      assetName,
      files.map((f) => f.name),
      kind
    )

    // ── DEF-14（0.7.8）：落盘段必须在**算目录之前**净化，且只算一次 ────────────
    // 词表里有含 `/` 的并列词条（「椅子/凳子」「酒店/民宿」「筒灯/射灯」「金箔/银箔」…）。
    // 旧实现把原始值直接喂给 `path.join`，而 `relFolder` 走 `composeRelFolder`（内部已把
    // `/` 换成 `_`）→ 磁盘变五段、记录四段、`folder ≠ libraryDir + relFolder`；
    // rescan 固定三层下钻回读后 `category2='椅子'`、`name='凳子'`（分类 + 资产名双损）。
    //
    // 修法见 `resolveCategorySegments`：`cat1Seg/cat2Seg` 同时用于 `cat2Dir` 分段、
    // `relFolder` 分段、`Asset.category1/2` —— 三者必须逐字相等。
    const { cat1Seg, cat2Seg } = resolveCategorySegments(category1, category2)

    // ── 判重点（docs/27 §2.3）：解压之后、**任何 mkdir 之前** ────────────────
    // 位置是硬约束：判定早于 `mkdir(cat2Dir)` 才能保证「跳过」连空分类目录都不产生
    // （§3.1 / §6.1 判据 ①）。空间预检（P0-3）仍然严格更早，故不破坏
    // 「空间不足不产生半成品」的既有契约。
    const totalSize = files.reduce((s, f) => s + f.size, 0)
    // 知末 ID 必须在**落盘前**算（§1.3），且用**原始资产名**（不是 finalName）：
    // finalName 可能带 `-2` 后缀，用痕迹更干净的名字更稳，也消除「第二条同 ID 素材
    // 因 finalName 变形而取不到 ID」的历史隐患。
    const zhimoId = zhimoIdFromSources(
      itemName,
      assetName,
      files.map((f) => f.rel)
    )

    const decision = await resolveConflict(batch, deps, {
      item: src,
      itemName,
      assetName,
      kind,
      size: totalSize,
      zhimoId
    })
    if (decision?.resolution === 'skip') {
      // 跳过 = 这次导入**没发生过**：不 mkdir、不落盘、不产生 Asset，
      // 原压缩包/原图**绝不处置**（`disposeArchive` 一次都不调用，D09/§3.1）
      emitSkipped(deps, { item: src, itemName }, decision)
      return null
    }

    // ── 落盘（三档在此分叉）─────────────────────────────────────────
    interface Placement {
      id: string
      finalName: string
      target: string
      relFolder: string
      /** 覆盖三步的执行结果（仅覆盖档非 null） */
      replace: ReplaceResult | null
      /** 覆盖档要继承元数据的那条旧记录（仅覆盖档非 null） */
      inheritFrom: ImportDedupeEntry | null
    }

    let placement: Placement

    // 覆盖：先验前提（§3.2.4）—— 旧目录在、在库内、kind 没变，才谈得上「原位替换」
    const overwriteMatch = decision?.resolution === 'overwrite' ? decision.match.existing : null
    const overwriteOk =
      overwriteMatch !== null && (await checkOverwriteTarget(deps, overwriteMatch, kind)) === 'ok'

    if (overwriteOk && overwriteMatch) {
      // D10：id / 名称 / 分类 / 磁盘路径全是旧的，只换内容与派生字段
      const target = overwriteMatch.folder
      const relFolder =
        overwriteMatch.relFolder || composeRelFolder(folderName, cat1Seg, cat2Seg, overwriteMatch.name)
      const replace = await replaceAssetFolder(target, overwriteMatch.id, deps, (t) =>
        moveDir(contentRoot, t)
      )
      placement = {
        id: overwriteMatch.id,
        finalName: overwriteMatch.name,
        target,
        relFolder,
        replace,
        inheritFrom: overwriteMatch
      }
    } else {
      // ── T06 固定四层：<大类>/<一级>/<二级>/<资产名>（06 §11.1） ────────
      // ⚠️ 空间预检已在本函数更早处完成（P0-3），此处才允许第一次 mkdir。
      //    预检必须严格早于任何 mkdir（含分类目录），否则"空间不足不产生半成品"契约（:163 断言）会红。
      const cat2Dir = path.join(deps.libraryDir, folderName, cat1Seg, cat2Seg)
      await fs.mkdir(cat2Dir, { recursive: true }) // 一次建齐两级

      let diskNames: string[] = []
      try {
        diskNames = await fs.readdir(cat2Dir)
      } catch {
        /* 目录刚建 */
      }
      // 批内台账（§5.1）：`diskNames` 只反映**此刻**的磁盘，并发 3 下必须再叠上
      // 本批已保留的名字，否则 A、B 会同时算出 `X`，第二个 moveDir 撞上非空目录直接 error。
      const finalName = batch.ledger.reserve(cat2Dir, assetName, diskNames)
      const target = path.join(cat2Dir, finalName)
      try {
        await moveDir(contentRoot, target)
      } catch (err) {
        batch.ledger.release(cat2Dir, finalName) // 名字归还，避免白占
        throw err
      }
      placement = {
        // 退化覆盖（§3.2.4）：旧目录不可用 → 按新素材落盘，但**沿用旧 id** 覆盖那条陈旧记录
        id: overwriteMatch ? overwriteMatch.id : randomUUID(),
        finalName,
        target,
        relFolder: composeRelFolder(folderName, cat1Seg, cat2Seg, finalName),
        replace: null,
        inheritFrom: null
      }
    }

    const { id, finalName, target, relFolder } = placement

    // 0.6.0 分辨率筛选：文件已在最终位置 → 给图片补宽高（只读文件头，失败静默）。
    // 必须**在推送 skp 预览图之前**做：那张图是程序生成的封面，不是用户的贴图，
    // 让它参与「±2K 贴图」判定会把模型资产误算进高清档。
    await fillImageSizes(target, files)

    // ── 封面优先级（P0-8 + P1-2 升级 + 2026-10 裁定 cover > preview）──
    // ① skp 内嵌预览图（提取落盘成资产内文件，coverSource='embedded'）
    // ①′ 包内已带 `<资产名>.cover.jpg/png`（知末主图 / 用户拍照）→ 顶掉内嵌预览。
    //     与 pickCover 的候选排序同口径（cover > preview）：重装重扫走 rescan→pickCover
    //     会选中封面文件，导入路径必须一致，否则同一套资产"导入时"与"重扫后"封面翻面。
    // ② 包内预览图（pickCover 排序：cover → named → root → embedded → largest）
    // ③ 都没有 → placeholder（渲染层出类型占位图标；用户可随后手动贴封面）
    let cover: string | undefined
    let coverSource: CoverSource = 'placeholder'
    // 封面主文件：skp 优先。顺序靠 `??` 链写死 —— 两种扩展名**不要塞进同一个
    // find 的合取条件**：skp+dwg 混合包的主类型按 `pickPrimaryFile` 的
    // KIND_PRIORITY 判 model，封面必须跟主类型走；用合取条件的话遍历顺序一旦是
    // dwg 在前就会抢封面。
    // `.dwg`（CAD 封面来源 M2）：与单文件路径同一套 `<主名>.preview.png` 落盘规则。
    const skp = files.find((f) => f.ext === 'skp')
    const master = skp ?? files.find((f) => f.ext === 'dwg')
    if (master) {
      const previewRel =
        master.ext === 'skp'
          ? await writeSkpPreviewInto(safeJoin(target, master.rel), target, master.rel)
          : await writeDwgPreviewInto(safeJoin(target, master.rel), target, master.rel)
      if (previewRel) {
        cover = previewRel
        coverSource = 'embedded'
        // 预览图已落成真实文件 → 进 files（与 rescan 的 walkFiles 视图保持一致：
        // 不进 files 的话 rescan 后 cover 会指向一个 files 里不存在的文件）
        const pst = await fs.stat(path.join(target, previewRel)).catch(() => null)
        if (pst) {
          files.push({
            rel: previewRel,
            name: path.basename(previewRel),
            ext: previewRel.slice(previewRel.lastIndexOf('.') + 1),
            size: pst.size,
            kind: 'texture'
          })
        }
      }
    }
    if (cover) {
      // 只有包内真的带封面文件时才让 pickCover 顶掉内嵌预览：
      // 其余情况保持 coverSource='embedded'（材质球通道对 named/embedded 的处理不同，
      // 无谓改源会改变既有导入结果的语义）。
      const hasCoverFile = files.some((f) => !f.rel.includes('/') && isCoverAssetImage(f.name))
      if (hasCoverFile) {
        const coverPick = pickCover(files)
        // 封面文件在根目录层 → pickCover 必然命中它（①级）；防御性判空而已
        if (coverPick) {
          cover = coverPick.rel
          coverSource = coverPick.source
        }
      }
    }
    if (!cover) {
      const coverPick = pickCover(files)
      cover = coverPick?.rel
      coverSource = coverPick?.source ?? 'placeholder'
    }
    const coverAbs = cover ? safeJoin(target, cover) : null

    // ── 材质包元数据（2026-10 任务 4）：AmbientCG/Crystal 的 *.json ─────
    // 与 PBR 贴图同包发布；解析失败/没有 json 都静默跳过（不阻断导入）。
    // 读的是**落盘后**的 target 内文件，staging 已清、contentRoot 已移动。
    let materialMeta: Asset['materialMeta']
    const metaJson = files.find((f) => f.ext === 'json')
    if (metaJson) {
      try {
        const text = await fs.readFile(safeJoin(target, metaJson.rel), 'utf-8')
        const parsed = parseMaterialMetaJsonText(text)
        if (parsed) materialMeta = { name: parsed.name, tags: parsed.tags }
      } catch {
        /* 读不到/解析失败 → 没有元数据 */
      }
    }

    // ── P0-15 SU 版本（只读前 128 字节，失败静默降级） ────────────
    let suVersion: string | undefined
    let suMajor: number | undefined
    if (skp) {
      try {
        const head = await readHead(safeJoin(target, skp.rel), SKP_HEAD_BYTES)
        const info = parseSkpVersion(head)
        if (info) {
          suVersion = info.label
          suMajor = info.major
        }
      } catch {
        /* 解析失败静默降级 */
      }
    }

    // ── P0-9 缩略图（注入，失败只告警不阻断） ──────────────────────
    let thumbPath: string | undefined
    let thumbStatus: ThumbStatus = 'none'
    if (deps.ensureThumb) {
      try {
        const cached = await deps.ensureThumb(id, coverAbs)
        if (cached) {
          thumbPath = cached
          thumbStatus = 'ready'
        }
      } catch {
        thumbStatus = 'failed'
      }
    }

    const now = Date.now()
    const fresh: Asset = {
      id,
      name: finalName,
      kind,
      source: deps.defaultSource,
      folder: target,
      relFolder,
      cover,
      coverSource,
      thumbPath,
      thumbStatus,
      files,
      size: files.reduce((s, f) => s + f.size, 0),
      suVersion,
      suMajor,
      mojibake: extractMojibake,
      // T06：预分类命中词表 → 落词表类目；未命中落双哨兵。
      // 真实分类仍可由用户在 UI 指派（assignCategory）后迁移
      // DEF-14（0.7.8）：**存净化后的段**（= 磁盘目录段 = relFolder 段），不是词表原貌。
      // 词表原貌仍留在 `zhimoId` / 归类命中的 matchedTerm 侧，UI 展示不需要它。
      category1: cat1Seg,
      category2: cat2Seg,
      styles: [],
      materialMeta,
      tags: [],
      note: '',
      favorite: false,
      rating: 0,
      colorTag: null,
      // 知末商品 ID（落盘**之前**就按原始资产名算好，见判重点的注释）
      zhimoId,
      // T0（docs/35 §5.1）：此刻只有 S1，站方信息要等批次结束才拿得到。
      // **必须用落盘的净化段**（`cat1Seg/cat2Seg`，= 磁盘目录段），不是词表原貌 ——
      // 判空比的是 `UNCLASSIFIED`，词表原貌里含 `/` 的词条净化后仍是同一个非未分类值，
      // 但用原貌会让"库里存的分类"与"判定依据"指向两个不同的字符串（第二套真相）。
      classifyReview: buildInitialClassifyReview(cat1Seg, cat2Seg),
      // ⚠️ v0.4 缺陷修复：必须用 `uniqueName()` **之前**的 `assetName`。
      // 用 `finalName` 时第二个同名包叫「椅子-2」→ key 是 `model:椅子-2`，与
      // `model:椅子` 不相等 → 同一套模型导入两次永远检测不出重复。
      dedupeKey: dedupeKeyOf(assetName, kind),
      importedAt: now,
      updatedAt: now
    }

    // 覆盖档：同位替换 + 元数据 100% 继承（D10/D12）
    const asset = placement.inheritFrom
      ? applyOverwriteInherit(fresh, placement.inheritFrom)
      : fresh

    // ── P0-5 原压缩包处置（失败不阻断） ───────────────────────────
    // ⚠️ 只有走到这里（真的落盘成功）才允许处置原包；「跳过」档在上面的判定点就 return 了，
    //    一次都不会调到这里（D09 硬约束：跳过必须原包原封不动）。
    if (!isDir) {
      try {
        await disposeArchive(src, deps.archiveDisposal, deps.disposeArchive)
      } catch {
        /* 保留原包 */
      }
    }

    const message = doneMessage(decision, placement.replace)
    const conflict = decision
      ? conflictNote(decision, decision.resolution, isDegradedOverwrite(decision, placement.replace))
      : undefined
    deps.emit({
      item: src,
      itemName,
      status: 'done',
      asset,
      ...(conflict ? { conflict } : {}),
      ...(message ? { message } : {})
    })
    return asset
  } finally {
    unregisterStaging(staging)
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    // 再 best-effort 删掉 `<库根>/.staging` 空壳（非递归！）。
    // 并发中可能有兄弟导入还在用它的 staging，故 rmdir 失败（ENOTEMPTY/EBUSY/ENOENT）一律吞掉，
    // 绝不能用 recursive:true 强删——会把别人的半成品一起端掉。
    await fs.rmdir(path.join(deps.libraryDir, STAGING_DIR)).catch(() => {})
  }
}

/**
 * 单个媒体文件直导为独立资产（2026-10 任务 2 图片 / 0.6.5 HDR）。
 *
 * 链路：空间预检 → autoClassify 预分类 → mkdir → **复制**入文件 → 建资产记录 →
 * 按 `deps.archiveDisposal` 处置源文件（keep / recycle / delete）。
 * - 资产名 = 文件名去扩展名（清洗/水印剥离与压缩包同规则）
 * - `kind` 由调用方给：图片 `texture` / HDR 类 `hdri`（`kindFolder()` 决定落盘大类）
 * - 图片：cover = 该图片本身（`coverSource='named'`）
 *   HDR：**不给封面**（`cover=undefined` + `coverSource='placeholder'`）——
 *   `.hdr/.exr` 不是 `<img>` / `createImageBitmap` 能解码的格式，塞进 cover 只会让
 *   网格和详情面板出现一张碎图；UI 走 `IconHdr` 类型占位。
 * - HDR：文件名里的**全景对齐参数**提取成一行写进 `note`（见 `panoramaNoteFromName`）
 * - 文件夹 = `<大类>/<一级>/<二级>/<资产名>`，与压缩包走同一 autoClassify 规则
 *   （`hdri` 没有一级词表 → 闸门必然拒绝 → 落 `未分类/未分类`，这是**预期**，不报错）
 * - **源文件处置三档与压缩包完全一致**（复用同一个 `disposeArchive`）：
 *   `keep` 原地保留、`recycle` 进回收站、`delete` 删除。
 *   历史缺陷：本函数曾无条件 rename 源文件（见下方复制段的注释）。
 *
 * ⚠️ 与压缩包路径同契约（P0-3）：`checkSpaceFor` 严格早于任何 mkdir，
 * 空间不足时不产生任何半成品。
 */
async function importMediaOne(
  src: string,
  st: Awaited<ReturnType<typeof fs.stat>>,
  deps: ImportDeps,
  kind: AssetKind,
  batch: ImportBatch
): Promise<Asset | null> {
  const itemName = path.basename(src)
  const isHdr = kind === 'hdri'

  // P0-3 空间预检（压缩包路径同款，必须早于 mkdir）
  const space = await checkSpaceFor(src, deps.libraryDir, {
    sevenZipPath: deps.sevenZipPath,
    maxBytesForJsFallback: deps.maxBytesForJsFallback,
    safetyFactor: deps.spaceSafetyFactor
  })
  if (!space.ok) {
    deps.emit({
      item: src,
      itemName,
      status: 'error',
      message: `磁盘空间不足：可用 ${humanGB(space.freeBytes)} / 需要 ${humanGB(space.requiredBytes)}。请在设置里「更改库目录」或清理磁盘后重试`,
      needBytes: space.requiredBytes,
      freeBytes: space.freeBytes
    })
    return null
  }

  deps.emit({
    item: src,
    itemName,
    status: 'extracting',
    message: isHdr ? '正在读取 HDR…' : '正在读取图片…'
  })

  const ext = path.extname(itemName).slice(1).toLowerCase()
  const assetName = sanitizeName(stripNoise(path.basename(itemName, path.extname(itemName))))
  const file: AssetFile = {
    rel: itemName,
    name: itemName,
    ext,
    size: Number(st.size),
    kind
  }
  // 单文件直导：同样只走 `kindFolder`（图片 →「材质」，HDR →「HDRI」；docs/14 §2.1）
  const folderName = kindFolder(kind)

  // 【v1.0.10】kind ↔ 一级容器闸门；【v1.0.12】拒绝后一级回退；
  // 【v1.0.13】与压包路径共用 `shared/classifyAsset.ts` 的唯一实现。
  // `hdri` 在一级容器表里没有条目 → 必然回退到 `未分类/未分类`（预期行为）。
  const { category1, category2 } = classifyAssetName(assetName, [itemName], kind)

  // ── DEF-14（0.7.8）：与压缩包路径同一条修法，必须在此处（**算目录之前**）净化 ──
  // 单图也会命中含 `/` 的词条（例：「金箔.png」→ 金属/金箔/银箔），不净化的后果与
  // 压包完全相同（磁盘五段 / 记录四段 / rescan 回读改名）。实现见 `resolveCategorySegments`。
  const { cat1Seg, cat2Seg } = resolveCategorySegments(category1, category2)

  deps.emit({ item: src, itemName, status: 'organizing', message: '正在分类归档…' })

  // ── 判重点（docs/27 §2.3）：**早于任何 mkdir**（含上面的 cat2Dir 与下面的占位目录）──
  // 单图 / HDR 的判重口径与压缩包**完全一致**（D16）：键 = `dedupeKeyOf(资产名, 各自 kind)`
  // + `zhimoId`，处置语义也一致。同名不同 kind 天然不判重（`dedupeKeyOf` 里 kind 是前缀，
  // 两者的落盘大类目录本来就不同，物理上不冲突）。
  const zhimoId = zhimoIdFromSources(itemName, assetName, [itemName])
  const decision = await resolveConflict(batch, deps, {
    item: src,
    itemName,
    assetName,
    kind,
    size: Number(st.size),
    zhimoId
  })
  if (decision?.resolution === 'skip') {
    // 跳过 = 源文件**绝不处置**（D09）：本函数尾部那次 `disposeArchive` 一次都不会执行
    emitSkipped(deps, { item: src, itemName }, decision)
    return null
  }

  interface MediaPlacement {
    id: string
    finalName: string
    target: string
    relFolder: string
    replace: ReplaceResult | null
    inheritFrom: ImportDedupeEntry | null
  }

  let placement: MediaPlacement
  const overwriteMatch = decision?.resolution === 'overwrite' ? decision.match.existing : null
  const overwriteOk =
    overwriteMatch !== null && (await checkOverwriteTarget(deps, overwriteMatch, kind)) === 'ok'

  if (overwriteOk && overwriteMatch) {
    // 单图覆盖与压缩包同构（§5.2）：不是 `moveDir(contentRoot)` 而是「mkdir 旧路径 + copyFile」；
    // 文件名用**新包的文件名**（可能是 .png 而旧的是 .jpg），`Asset.files` 随之换新，
    // 资产名（= 目录名）保持旧值。
    const target = overwriteMatch.folder
    const relFolder =
      overwriteMatch.relFolder || composeRelFolder(folderName, cat1Seg, cat2Seg, overwriteMatch.name)
    const replace = await replaceAssetFolder(target, overwriteMatch.id, deps, async (t) => {
      await fs.mkdir(t)
      try {
        await fs.copyFile(src, path.join(t, itemName))
      } catch (err) {
        // 复制失败：撤掉刚建的壳，再让 replaceAssetFolder 把旧目录 rename 回原位
        await fs.rm(t, { recursive: true, force: true }).catch(() => {})
        throw err
      }
    })
    placement = {
      id: overwriteMatch.id,
      finalName: overwriteMatch.name,
      target,
      relFolder,
      replace,
      inheritFrom: overwriteMatch
    }
  } else {
    const cat2Dir = path.join(deps.libraryDir, folderName, cat1Seg, cat2Seg)
    await fs.mkdir(cat2Dir, { recursive: true })

    // 防重名 + 并发安全：mkdir（非 recursive）当作"占位锁"——EEXIST 说明
    // 同名资产刚被并发导入占用，把该名字拉黑重取，直到占位成功。
    // （fs.copyFile 会静默覆盖同名目标文件，绝不能让两个导入拿到同一目标。）
    //
    // 台账名并入初始 `taken`（docs/27 §5.1）：`fs.readdir` 只反映此刻磁盘，
    // 并发 3 下必须再叠上本批次已保留的名字，否则 A、B 会算出同一目标。
    const taken = batch.ledger.namesOf(cat2Dir)
    try {
      for (const name of await fs.readdir(cat2Dir)) taken.add(name)
    } catch {
      /* 目录刚建 */
    }
    let finalName = uniqueName(assetName, taken)
    let target = path.join(cat2Dir, finalName)
    for (;;) {
      try {
        await fs.mkdir(target) // 非 recursive：已存在即抛 EEXIST
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        taken.add(finalName)
        finalName = uniqueName(assetName, taken)
        target = path.join(cat2Dir, finalName)
      }
    }
    // 占位成功 → 立刻记进台账，让并发的兄弟任务看得见（中间没有 await，不会漏）
    batch.ledger.claim(cat2Dir, finalName)

    // ── 纳入库内：**一律先复制**，源文件留待下面按用户设置处置 ────────────
    //
    // ⚠️ 缺陷修复（2026-10）：旧实现无条件 `fs.rename`（跨盘退化为 复制+删源），
    // 完全没读 `deps.archiveDisposal` —— 于是「保留原位 / 移入回收站 / 彻底删除」
    // 三档表现完全一样，源图片一律被搬走。`rename` 更不能留作主路径：
    // 它会把源文件直接搬走，'keep' 档的语义天然无法成立。
    //
    // 现在与压缩包路径（`importOne` 尾部）**完全对齐**：先复制入库，再复用同一个
    // `disposeArchive` 处置源文件；不另写一套删除逻辑（两套实现迟早漂移）。
    // 顺序不可颠倒：**复制成功之后**才允许触碰源文件，杜绝「源没了、库里也没有」。
    //
    // 不再为 'delete' 保留同卷 rename 快路径：少一条分支就少一个坑，且 rename
    // 对 'keep'/'recycle' 都是错的，为省一次拷贝去分裂语义不划算。
    const dest = path.join(target, itemName)
    try {
      await fs.copyFile(src, dest)
    } catch (err) {
      // 复制失败 = 该条导入失败：撤掉刚才的 `mkdir` 占位目录，不留空资产壳。
      // 此刻源文件**一次都没被写过/删过**，因此必然完好（验收点 5）。
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      batch.ledger.release(cat2Dir, finalName)
      throw err
    }
    placement = {
      // 退化覆盖：沿用旧 id 覆盖那条陈旧记录（与压缩包路径同口径）
      id: overwriteMatch ? overwriteMatch.id : randomUUID(),
      finalName,
      target,
      relFolder: composeRelFolder(folderName, cat1Seg, cat2Seg, finalName),
      replace: null,
      inheritFrom: null
    }
  }

  const { id, finalName, target } = placement
  const relFolder = placement.relFolder
  const destFile = path.join(target, itemName)
  // HDR 不做缩略图：`.hdr` 不是图片解码器能吃的格式，传给 ensureThumb 只会白跑一次
  // 解码并留下一条 failed 足迹（UI 本来就显示类型占位）。
  const coverAbs = isHdr ? null : destFile

  // 0.6.0 分辨率筛选：单图直导的资产也带宽高（同一份头部解析，失败静默）
  await fillImageSizes(target, [file])

  // P0-9 缩略图（注入，失败只降级不阻断）
  let thumbPath: string | undefined
  let thumbStatus: ThumbStatus = 'none'
  if (deps.ensureThumb) {
    try {
      const cached = await deps.ensureThumb(id, coverAbs)
      if (cached) {
        thumbPath = cached
        thumbStatus = 'ready'
      }
    } catch {
      thumbStatus = 'failed'
    }
  }

  // 知末商品 ID（0.6.3）：单文件路径同压缩包路径 —— 源文件名优先，其次资产名。
  // 已在判重点按 `assetName` 算好（§1.3），这里不再用 finalName 重算。

  // 全景对齐参数（0.6.5）：只对 HDR 生效。名字里写的「偏移U/V、平铺N」是用户
  // 在 DCC 里的对齐设定，丢了就得回原站查 —— 顺手抄一行到 note（不结构化）。
  const note = isHdr ? panoramaNoteFromName(itemName) : ''

  const now = Date.now()
  const fresh: Asset = {
    id,
    name: finalName,
    kind,
    source: deps.defaultSource,
    folder: target,
    relFolder,
    // HDR 不做封面：`.hdr/.exr` 不能当 `<img>` 解码，塞进去只会得到碎图。
    // `pickCover` 也不参与（单文件路径不调它）→ 走 `IconHdr` 类型占位。
    cover: isHdr ? undefined : itemName,
    coverSource: isHdr ? 'placeholder' : 'named',
    thumbPath,
    thumbStatus,
    files: [file],
    size: Number(st.size),
    suVersion: undefined,
    suMajor: undefined,
    mojibake: false,
    // DEF-14（0.7.8）：与压缩包路径同口径 —— 记录存**净化后的段**，
    // 保证 `asset.category1/2` 与磁盘目录段逐字相等（rescan 以磁盘为权威）。
    category1: cat1Seg,
    category2: cat2Seg,
    styles: [],
    materialMeta: undefined,
    tags: [],
    note,
    favorite: false,
    rating: 0,
    colorTag: null,
    // 同压缩包路径：源文件名优先，其次资产名（判重点已算好）
    zhimoId,
    // T0 初始判定（docs/35 §5.1）：用落盘的净化段，与 `category1/2` 逐字一致
    classifyReview: buildInitialClassifyReview(cat1Seg, cat2Seg),
    // 同压缩包路径：用 `uniqueName()` 之前的 `assetName`（见上方注释）
    dedupeKey: dedupeKeyOf(assetName, kind),
    importedAt: now,
    updatedAt: now
  }

  // 覆盖档：同位替换 + 元数据 100% 继承（D10/D12）
  const asset = placement.inheritFrom
    ? applyOverwriteInherit(fresh, placement.inheritFrom)
    : fresh

  // ── 源文件处置（与压缩包 P0-5 **同一个** helper，三档语义因此天然一致）──
  //   keep    → 直接 return，源文件原地不动（缺陷修复的核心验收点）
  //   recycle → trashOne / shell.trashItem 进回收站
  //   delete  → fs.rm 彻底删除
  // 处置失败只吞掉（源文件保留），绝不回滚已经完成的入库——与压缩包路径同策略。
  // ⚠️「跳过」档在上面判重点就 return 了，**一次都走不到这里**（D09 硬约束）。
  try {
    await disposeArchive(src, deps.archiveDisposal, deps.disposeArchive)
  } catch {
    /* 处置失败 → 保留源图，不阻断导入 */
  }

  const message = doneMessage(decision, placement.replace)
  const conflict = decision
    ? conflictNote(decision, decision.resolution, isDegradedOverwrite(decision, placement.replace))
    : undefined
  deps.emit({
    item: src,
    itemName,
    status: 'done',
    asset,
    ...(conflict ? { conflict } : {}),
    ...(message ? { message } : {})
  })
  return asset
}

/**
 * 单文件模型直导（0.8.4，用户 2026-10-28 拍板「同意复制保留」）。
 *
 * ## 解决什么
 *
 * 用户在别处已经整理过的工程文件（很常见：一个目录里孤零零一个 `.skp` / `.max`），
 * 旧实现会掉进 `extractArchive` → 被判「不是压缩包」→ 拖进去没反应；
 * 就算落了库（文件夹路径），也只有「一个 SketchUp 框框 + 没有预览图」。
 *
 * 本函数把「单个模型文件」当成一个**单文件资产包**处理：建 `大类/一级/二级/名`，
 * 把文件复制进去，再按封面优先级补一张图。
 *
 * ## 两条已拍板口径（不要自行改）
 *
 * 1. **源文件一律保留**：只复制，绝不 `rename` / 绝不进回收站 / 绝不删。
 *    `.skp` 是客户的工程文件，不是一次性下载包；设置里的「原包处置」三档是为压缩包
 *    设计的，套到工程文件上风险太大 —— 删掉的可能是他唯一的原件。
 *    所以本函数**不调用** `disposeArchive`。
 * 2. **封面优先级**：知末主图（文件名里有 `ID_<数字>`，由批次结束后的既有抓取任务补，
 *    见 `docs/24`）> `.skp` 内嵌预览（本地立刻可用，`coverSource='embedded'`）> 类型占位。
 *    `.max` / `.obj` 这类没有可提取预览的，先给占位，等知末那张图到了自然覆盖。
 *
 * ## 与其它两条路径的口径一致性（别在这里另立一套）
 *
 * - 资产名：`sanitizeName(stripNoise(文件名去扩展名))`（与单图路径逐字相同）；
 * - 分类：`classifyAssetName` + `resolveCategorySegments`（与压包/单图共用唯一实现，DEF-14）；
 * - 判重：`dedupeKeyOf(assetName, kind)` + `zhimoId`（D16，与单图完全一致）；
 * - 落盘大类：`kindFolder(kind)`（不是 `KIND_LABEL`，docs/14 §0.1-1）；
 * - 覆盖档：沿用 `replaceAssetFolder` 三步（挪旧 → 落新 → 销毁旧），不另写。
 */
async function importModelOne(
  src: string,
  st: Awaited<ReturnType<typeof fs.stat>>,
  deps: ImportDeps,
  batch: ImportBatch
): Promise<Asset | null> {
  const itemName = path.basename(src)
  const ext = path.extname(itemName).slice(1).toLowerCase()
  const kind = kindOfExt(ext)
  const folderName = kindFolder(kind)
  const assetName = sanitizeName(stripNoise(path.basename(itemName, path.extname(itemName))))

  // P0-3 空间预检：必须早于任何 mkdir（与另外两条路径同一条纪律）
  const space = await checkSpaceFor(src, deps.libraryDir, {
    sevenZipPath: deps.sevenZipPath,
    maxBytesForJsFallback: deps.maxBytesForJsFallback,
    safetyFactor: deps.spaceSafetyFactor
  })
  if (!space.ok) {
    deps.emit({
      item: src,
      itemName,
      status: 'error',
      message: `磁盘空间不足：可用 ${humanGB(space.freeBytes)} / 需要 ${humanGB(space.requiredBytes)}。请在设置里「更改库目录」或清理磁盘后重试`,
      needBytes: space.requiredBytes,
      freeBytes: space.freeBytes
    })
    return null
  }

  deps.emit({
    item: src,
    itemName,
    status: 'organizing',
    message: '正在为单个工程文件建资产文件夹…'
  })

  const { category1, category2 } = classifyAssetName(assetName, [itemName], kind)
  const { cat1Seg, cat2Seg } = resolveCategorySegments(category1, category2)

  // 判重点与单图/压包同口径（D16）：`dedupeKey` 用**改名前**的 assetName
  const zhimoId = zhimoIdFromSources(itemName, assetName, [itemName])
  const decision = await resolveConflict(batch, deps, {
    item: src,
    itemName,
    assetName,
    kind,
    size: Number(st.size),
    zhimoId
  })
  if (decision?.resolution === 'skip') {
    // 跳过 = 源文件绝不处置（D09）：本函数本来就不处置源文件，这条只是显式表达语义
    emitSkipped(deps, { item: src, itemName }, decision)
    return null
  }

  interface ModelPlacement {
    id: string
    finalName: string
    target: string
    relFolder: string
    replace: ReplaceResult | null
    inheritFrom: ImportDedupeEntry | null
  }

  let placement: ModelPlacement
  const overwriteMatch = decision?.resolution === 'overwrite' ? decision.match.existing : null
  const overwriteOk =
    overwriteMatch !== null && (await checkOverwriteTarget(deps, overwriteMatch, kind)) === 'ok'

  if (overwriteOk && overwriteMatch) {
    // 覆盖：与单图路径同构（不是 moveDir 而是「mkdir 旧路径 + copyFile」）
    const target = overwriteMatch.folder
    const relFolder =
      overwriteMatch.relFolder || composeRelFolder(folderName, cat1Seg, cat2Seg, overwriteMatch.name)
    const replace = await replaceAssetFolder(target, overwriteMatch.id, deps, async (t) => {
      await fs.mkdir(t)
      try {
        await fs.copyFile(src, path.join(t, itemName))
      } catch (err) {
        await fs.rm(t, { recursive: true, force: true }).catch(() => {})
        throw err
      }
    })
    placement = {
      id: overwriteMatch.id,
      finalName: overwriteMatch.name,
      target,
      relFolder,
      replace,
      inheritFrom: overwriteMatch
    }
  } else {
    const cat2Dir = path.join(deps.libraryDir, folderName, cat1Seg, cat2Seg)
    await fs.mkdir(cat2Dir, { recursive: true })

    // 防重名 + 并发安全：mkdir（非 recursive）当占位锁（与单图路径逐字同款）
    const taken = batch.ledger.namesOf(cat2Dir)
    try {
      for (const name of await fs.readdir(cat2Dir)) taken.add(name)
    } catch {
      /* 目录刚建 */
    }
    let finalName = uniqueName(assetName, taken)
    let target = path.join(cat2Dir, finalName)
    for (;;) {
      try {
        await fs.mkdir(target)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        taken.add(finalName)
        finalName = uniqueName(assetName, taken)
        target = path.join(cat2Dir, finalName)
      }
    }
    batch.ledger.claim(cat2Dir, finalName)

    // ⚠️ 复制，不是移动：源工程文件**原地不动**（本函数头注①，用户拍板）
    try {
      await fs.copyFile(src, path.join(target, itemName))
    } catch (err) {
      // 复制失败 = 该条失败：撤掉占位目录，不留空壳（此刻源文件一个字节都没被碰）
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      batch.ledger.release(cat2Dir, finalName)
      throw err
    }
    placement = {
      id: overwriteMatch ? overwriteMatch.id : randomUUID(),
      finalName,
      target,
      relFolder: composeRelFolder(folderName, cat1Seg, cat2Seg, finalName),
      replace: null,
      inheritFrom: null
    }
  }

  const { id, finalName, target, relFolder } = placement
  const destFile = path.join(target, itemName)

  const file: AssetFile = {
    rel: itemName,
    name: itemName,
    ext,
    size: Number(st.size),
    kind
  }
  const files: AssetFile[] = [file]

  // ── 封面：`.skp` / `.dwg` 有内嵌预览就立刻用（本地可用），其它格式先占位 ──
  // 知末那张主图由批次结束后的既有任务补（`fetchZhimoCover`），这条路径不联网。
  //
  // `.dwg`（CAD 封面来源 M2，2026-10）：DWG 头 `0x0D` 处的 image seeker 指向一段
  // 缩略图记录（DIB 裸位图或 PNG），提取后**统一转 PNG** 落成 `<主名>.preview.png`。
  // 实测命中率 78%（178 个真实样本：AC1032 全有 / AC1027 全无 / AC1018 96%），
  // 分辨率很小（184×78 ~ 512×215）——只当"这是什么图"的占位封面，不是图纸预览。
  // 没命中就保持 placeholder，渲染层出 CAD 图标。
  let cover: string | undefined
  let coverSource: CoverSource = 'placeholder'
  let previewRel: string | null = null
  if (ext === 'skp') previewRel = await writeSkpPreviewInto(destFile, target, itemName)
  else if (ext === 'dwg') previewRel = await writeDwgPreviewInto(destFile, target, itemName)
  if (previewRel) {
    cover = previewRel
    coverSource = 'embedded'
    // 预览图是真实文件 → 必须进 files，否则 rescan 的 walkFiles 视图里没有它，
    // 重扫后 `cover` 会指向一个 files 里不存在的文件（与压包路径同一条纪律）
    const pst = await fs.stat(path.join(target, previewRel)).catch(() => null)
    if (pst) {
      files.push({
        rel: previewRel,
        name: path.basename(previewRel),
        ext: previewRel.slice(previewRel.lastIndexOf('.') + 1),
        size: pst.size,
        kind: 'texture'
      })
    }
  }

  // P0-9 缩略图（注入，失败只降级不阻断）
  let thumbPath: string | undefined
  let thumbStatus: ThumbStatus = 'none'
  if (deps.ensureThumb && cover) {
    try {
      const cached = await deps.ensureThumb(id, path.join(target, cover))
      if (cached) {
        thumbPath = cached
        thumbStatus = 'ready'
      }
    } catch {
      thumbStatus = 'failed'
    }
  }

  const now = Date.now()
  const fresh: Asset = {
    id,
    name: finalName,
    kind,
    source: deps.defaultSource,
    folder: target,
    relFolder,
    cover,
    coverSource,
    thumbPath,
    thumbStatus,
    files,
    size: Number(st.size),
    suVersion: undefined,
    suMajor: undefined,
    mojibake: false,
    category1: cat1Seg,
    category2: cat2Seg,
    styles: [],
    materialMeta: undefined,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    zhimoId,
    // T0 初始判定（docs/35 §5.1）：用落盘的净化段，与 `category1/2` 逐字一致
    classifyReview: buildInitialClassifyReview(cat1Seg, cat2Seg),
    dedupeKey: dedupeKeyOf(assetName, kind),
    importedAt: now,
    updatedAt: now
  }

  const asset = placement.inheritFrom ? applyOverwriteInherit(fresh, placement.inheritFrom) : fresh

  const message = doneMessage(decision, placement.replace)
  const conflict = decision
    ? conflictNote(decision, decision.resolution, isDegradedOverwrite(decision, placement.replace))
    : undefined
  deps.emit({
    item: src,
    itemName,
    status: 'done',
    asset,
    ...(conflict ? { conflict } : {}),
    ...(message ? { message } : {})
  })
  return asset
}

/**
 * 原压缩包处置（P0-5）。
 *
 * ⚠️ 默认实现走 `trash` npm 包——**仅在开发态/测试可用**：打包后该包从 asar 内
 * spawn `windows-trash.exe` 会 ENOENT（见 `main/trash.ts` 的缺陷说明）。
 * 主进程 `runImport` 必须注入基于 `shell.trashItem` 的 `disposeArchive`，
 * 默认实现只是 importer 单测（vitest，无 electron）的兜底。
 */
async function disposeArchive(
  src: string,
  mode: ArchiveDisposal,
  injected?: (src: string, mode: ArchiveDisposal) => Promise<void>
): Promise<void> {
  if (injected) {
    await injected(src, mode)
    return
  }
  if (mode === 'keep') return
  if (mode === 'delete') {
    await fs.rm(src, { force: true })
    return
  }
  const { default: trash } = await import('trash')
  await trash(src)
}

/** 重命名资产文件夹（返回新绝对路径） */
export async function renameAssetFolder(folder: string, newName: string): Promise<string> {
  const target = path.join(path.dirname(folder), newName)
  if (await pathExists(target)) throw new Error('已存在同名资产')
  await fs.rename(folder, target)
  return target
}

/** 启动时 / 退出时的 staging 兜底清理：删掉所有登记目录与整个 `.staging` */
export async function cleanupStaging(libraryDir: string): Promise<void> {
  const dirs = activeStagingDirs()
  clearActiveStaging()
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  await cleanStaging(libraryDir).catch(() => {})
}
