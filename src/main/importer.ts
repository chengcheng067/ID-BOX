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
import { kindFolder, kindOfExt, pickCover, primaryKind } from '../shared/classify'
import { isHdrExt, panoramaNoteFromName } from '../shared/hdrExts'
import { composeRelFolder, dedupeKeyOf, pickAssetName, sanitizeName, stripNoise, uniqueName, zhimoIdFromSources } from '../shared/naming'
import { classifyAssetName } from '../shared/classifyAsset'
import { parseSkpVersion, SKP_HEAD_BYTES } from '../shared/skpVersion'
import { IMAGE_FILE_EXTS } from '../shared/imageExts'
import { IMAGE_SIZE_HEAD_BYTES, imageSizeOf } from '../shared/imageSize'
import { parseMaterialMetaJsonText } from './materialMeta'
import { writeSkpPreviewInto } from './skpPreview'
import { humanGB } from '../shared/space'
import type {
  ArchiveDisposal,
  Asset,
  AssetFile,
  AssetKind,
  Codepage,
  CoverSource,
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
  emit: (ev: ImportEvent) => void
}

/** 正在使用的 staging 目录（进程退出 / 异常时强制清理，K2） */
const activeStaging = new Set<string>()

/**
 * 给**图片文件**补 `w` / `h`（0.6.0「贴图分辨率筛选」的采集端）。
 *
 * 口径（docs/22 §3.1 / §5「不改磁盘结构」）：
 * - 只读文件**头部**（`IMAGE_SIZE_HEAD_BYTES` = 64KB），不解码整图 —— 大库重扫时
 *   逐张 `sharp`/canvas 解码会把主进程卡死；
 * - 只处理 `IMAGE_FILE_EXTS` 里的扩展名，且只认 PNG / JPEG（`imageSizeOf` 的判定）；
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
    if (!IMAGE_FILE_EXTS.has(file.ext)) continue
    try {
      const head = await readHead(safeJoin(folder, file.rel), IMAGE_SIZE_HEAD_BYTES)
      const size = imageSizeOf(head)
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

  await mapWithConcurrency(
    accepted,
    deps.concurrency || DEFAULT_CONCURRENCY,
    async (p) => {
      // 双保险：mapWithConcurrency 已兜底，这里再包一层以保留原有错误语义
      try {
        const asset = await importOne(p, deps)
        if (asset) assets.push(asset)
      } catch (err) {
        emitFailure(deps, p, err)
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

async function importOne(src: string, deps: ImportDeps): Promise<Asset | null> {
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
    if (IMAGE_IMPORT_EXTS.has(ext)) return importMediaOne(src, st, deps, 'texture')
    if (isHdrExt(ext)) {
      // kind 复用 `shared/classify.ts` 的 ext→kind 唯一映射（hdr/exr → 'hdri'），
      // 不在这里再写一张表（两处表必然漂移）。
      return importMediaOne(src, st, deps, kindOfExt(ext))
    }
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

    // ── T06 固定四层：<大类>/<一级>/<二级>/<资产名>（06 §11.1） ────────
    // ⚠️ 空间预检已在本函数更早处完成（P0-3），此处才允许第一次 mkdir。
    //    预检必须严格早于任何 mkdir（含分类目录），否则"空间不足不产生半成品"契约（:163 断言）会红。
    const cat2Dir = path.join(deps.libraryDir, folderName, category1, category2)
    await fs.mkdir(cat2Dir, { recursive: true }) // 一次建齐两级

    let existing: string[] = []
    try {
      existing = await fs.readdir(cat2Dir)
    } catch {
      /* 目录刚建 */
    }
    const finalName = uniqueName(assetName, new Set(existing))
    const target = path.join(cat2Dir, finalName)
    await moveDir(contentRoot, target)

    // 0.6.0 分辨率筛选：文件已在最终位置 → 给图片补宽高（只读文件头，失败静默）。
    // 必须**在推送 skp 预览图之前**做：那张图是程序生成的封面，不是用户的贴图，
    // 让它参与「±2K 贴图」判定会把模型资产误算进高清档。
    await fillImageSizes(target, files)

    // ── P0-7：稳定主键，永不变更 ────────────────────────────────
    const id = randomUUID()
    const relFolder = composeRelFolder(folderName, category1, category2, finalName)

    // ── 封面优先级（P0-8 + P1-2 升级）─────────────────────────
    // ① skp 内嵌预览图（提取落盘成资产内文件，coverSource='embedded'）
    // ② 包内预览图（pickCover 四级回退：named → root → embedded → largest）
    // ③ 都没有 → placeholder（渲染层出类型占位图标；用户可随后手动贴封面）
    let cover: string | undefined
    let coverSource: CoverSource = 'placeholder'
    const skp = files.find((f) => f.ext === 'skp')
    if (skp) {
      const previewRel = await writeSkpPreviewInto(safeJoin(target, skp.rel), target, skp.rel)
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

    // ── 知末商品 ID（0.6.3，用户反馈）：三来源按可信度取**第一个非空** ────────
    // ① 源压缩包 / 源文件夹文件名 —— 最高优先：实测「现代壁灯ID_1232108421.rar」
    //    解包后是 `attachment_1786942463670\现代壁灯\现代壁灯.skp`，包内**零 ID 痕迹**，
    //    而压缩包稍后就会被按设置处置掉 → 必须在导入这一刻算出来落库；
    // ② 最终资产名（`uniqueName` 之后的 finalName）；
    // ③ 包内文件相对路径 —— `znzmo-1180221079-1.skp` 这类资产名里没有 ID 的包。
    const zhimoId = zhimoIdFromSources(
      itemName,
      finalName,
      files.map((f) => f.rel)
    )

    const now = Date.now()
    const asset: Asset = {
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
      category1,
      category2,
      styles: [],
      materialMeta,
      tags: [],
      note: '',
      favorite: false,
      rating: 0,
      colorTag: null,
      // 知末商品 ID：压缩包名 / 最终资产名 / 包内文件路径三来源（见函数上方注释）
      zhimoId,
      // ⚠️ v0.4 缺陷修复：必须用 `uniqueName()` **之前**的 `assetName`。
      // 用 `finalName` 时第二个同名包叫「椅子-2」→ key 是 `model:椅子-2`，与
      // `model:椅子` 不相等 → 同一套模型导入两次永远检测不出重复。
      dedupeKey: dedupeKeyOf(assetName, kind),
      importedAt: now,
      updatedAt: now
    }

    // ── P0-5 原压缩包处置（失败不阻断） ───────────────────────────
    if (!isDir) {
      try {
        await disposeArchive(src, deps.archiveDisposal, deps.disposeArchive)
      } catch {
        /* 保留原包 */
      }
    }

    deps.emit({ item: src, itemName, status: 'done', asset })
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
  kind: AssetKind
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

  deps.emit({ item: src, itemName, status: 'organizing', message: '正在分类归档…' })

  const cat2Dir = path.join(deps.libraryDir, folderName, category1, category2)
  await fs.mkdir(cat2Dir, { recursive: true })

  // 防重名 + 并发安全：mkdir（非 recursive）当作"占位锁"——EEXIST 说明
  // 同名资产刚被并发导入占用，把该名字拉黑重取，直到占位成功。
  // （fs.copyFile 会静默覆盖同名目标文件，绝不能让两个导入拿到同一目标。）
  const taken = new Set<string>()
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
  const destFile = path.join(target, itemName)
  try {
    await fs.copyFile(src, destFile)
  } catch (err) {
    // 复制失败 = 该条导入失败：撤掉刚才的 `mkdir` 占位目录，不留空资产壳。
    // 此刻源文件**一次都没被写过/删过**，因此必然完好（验收点 5）。
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const id = randomUUID()
  const relFolder = composeRelFolder(folderName, category1, category2, finalName)
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

  // 知末商品 ID（0.6.3）：单文件路径同压缩包路径 —— 源文件名优先，其次最终资产名
  const zhimoId = zhimoIdFromSources(itemName, finalName, [itemName])

  // 全景对齐参数（0.6.5）：只对 HDR 生效。名字里写的「偏移U/V、平铺N」是用户
  // 在 DCC 里的对齐设定，丢了就得回原站查 —— 顺手抄一行到 note（不结构化）。
  const note = isHdr ? panoramaNoteFromName(itemName) : ''

  const now = Date.now()
  const asset: Asset = {
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
    category1,
    category2,
    styles: [],
    materialMeta: undefined,
    tags: [],
    note,
    favorite: false,
    rating: 0,
    colorTag: null,
    // 同压缩包路径：三来源（源文件名 → 最终资产名 → 包内文件名）
    zhimoId,
    // 同压缩包路径：用 `uniqueName()` 之前的 `assetName`（见上方注释）
    dedupeKey: dedupeKeyOf(assetName, kind),
    importedAt: now,
    updatedAt: now
  }

  // ── 源文件处置（与压缩包 P0-5 **同一个** helper，三档语义因此天然一致）──
  //   keep    → 直接 return，源文件原地不动（缺陷修复的核心验收点）
  //   recycle → trashOne / shell.trashItem 进回收站
  //   delete  → fs.rm 彻底删除
  // 处置失败只吞掉（源文件保留），绝不回滚已经完成的入库——与压缩包路径同策略。
  try {
    await disposeArchive(src, deps.archiveDisposal, deps.disposeArchive)
  } catch {
    /* 处置失败 → 保留源图，不阻断导入 */
  }

  deps.emit({ item: src, itemName, status: 'done', asset })
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
