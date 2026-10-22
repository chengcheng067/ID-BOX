import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readHead, safeJoin, walkFiles } from './fsutil'
import { kindFromFolderName, pickCover, primaryKind } from '../shared/classify'
import { baseNameOf, composeRelFolder, dedupeKeyOf, zhimoIdFromSources } from '../shared/naming'
import { parseSkpVersion, SKP_HEAD_BYTES } from '../shared/skpVersion'
import { parseMaterialMetaJsonText } from './materialMeta'
import { isLibraryTrashName } from './trash'
// 图片宽高采集与导入侧**共用一份实现**（只读文件头、失败静默，见 importer.fillImageSizes）
import { fillImageSizes } from './importer'
import type {
  Asset,
  AssetFile,
  AssetKind,
  IgnoredEntry,
  IgnoredReason,
  RescanResult
} from '../shared/types'

/** 忽略上报的原因 —— 类型定义在 `shared/types.ts`（IPC 载荷需要），此处转发保持既有导入路径可用 */
export type { IgnoredReason }

/**
 * 大类目录名 → kind 的**兜底值**（仅在 `primaryKind(files) === 'other'` 时使用）。
 *
 * - 反查逻辑已统一到 `shared/classify.kindFromFolderName`（与 importer/指派侧同源，防漂移）；
 * - 「材质」被 `texture` 与 `material` 共用 → 该函数返回 `null`，此处兜底 `texture`
 *   （docs/14 §2.1 裁定：该分支只在内容完全判不出大类时触发，真实材质资产由扩展名/
 *   PBR 材质包判定，几乎走不到这里；选 `texture` 使散装包行为与升级前一致）；
 * - 历史目录名 `贴图/`、`材质预设/` 仍能被反解（旧库未迁移时不炸）。
 */
function fallbackKindOf(kindFolderName: string): AssetKind {
  return kindFromFolderName(kindFolderName) ?? 'texture'
}

export interface RescanOptions {
  /**
   * 结构符合性上报：不符合固定四层布局的目录/文件会被跳过，必须上报否则用户会当成 bug。
   * - `depth`：目录深度不符合 `<大类>/<一级>/<二级>/<资产名>`（如遗留的两段布局、用户手工拖进来的散装文件夹）
   * - `not-dir`：期望是目录的位置上出现了文件
   * `relPath` 为相对库根的 posix 路径。
   */
  onIgnored?: (relPath: string, reason: IgnoredReason) => void
}

/**
 * 扫描时统一跳过的目录名判定（C 线硬约束）。
 *
 * `.trash` 是库内回收区：软删资产的目录就躺在里面，**绝不能被重新索引回来**
 * （否则「最近删除」里的资产会同时出现在网格里，删除等于没删）。
 * 规则集中在这里，`hasSubDirs` / `dirIsEmpty` / `listDirs` 三处共用，不散落。
 */
function isSkippedDirName(name: string): boolean {
  return name.startsWith('.') || isLibraryTrashName(name)
}

/** 目录里是否还有下一级子目录（用于判定"该层级不可能是分类层"） */
async function hasSubDirs(dir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (isSkippedDirName(name)) continue
    try {
      if ((await fs.stat(path.join(dir, name))).isDirectory()) return true
    } catch {
      /* 忽略 */
    }
  }
  return false
}

/** 目录是否完全为空（只有 `.` 开头项 / `.trash` 也算空） */
async function dirIsEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir)
    return entries.every((n) => isSkippedDirName(n))
  } catch {
    return true
  }
}

/** 列出某目录下的子目录名（跳过 `.` 开头与 `.staging`）；isDir 为 false 的项回调 not-dir */
async function listDirs(
  dir: string,
  base: string,
  onIgnored: (relPath: string, reason: IgnoredReason) => void,
  level: number
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of entries) {
    if (isSkippedDirName(name)) continue
    const abs = path.join(dir, name)
    const rel = path.relative(base, abs).split(path.sep).join('/')
    let st: Awaited<ReturnType<typeof fs.stat>>
    try {
      st = await fs.stat(abs)
    } catch {
      continue
    }
    if (!st.isDirectory()) {
      // 期望目录的位置上出现了文件（第 1 层的散落文件常见，静默跳过；第 2/3 层上报）
      if (level > 1) onIgnored(rel, 'not-dir')
      continue
    }
    dirs.push(name)
  }
  return dirs
}

/**
 * 扫描库目录，重建资产列表（T06：**纯路径解析，固定四层，零启发式**，06 §11.2）。
 *
 * 三层循环固定下钻：`<大类>/*` → `<一级>/*` → `<二级>/*`，第 4 层的**目录**即资产。
 * `relative(libraryDir, assetDir)` 按 `/` 切开后**段数 !== 4 → 跳过 + onIgnored(rel,'depth')**。
 *
 * - `.staging`、`.` 开头目录照旧跳过
 * - `kind` 仍由 `primaryKind(files)` 决定（**kind 不由目录决定**）
 * - `category1/category2` 直接取**磁盘目录名**，**不清洗** —— 外部手工命名是用户意志，rescan 照抄；
 *   只有导入/指派路径才走 `normalizeCategoryPair`
 * - 返回 `{ assets, ignored }`（T08）：ignored 是结构不符被跳过的清单（RA6），
 *   渲染层据此提示「N 个目录结构异常已跳过」，否则用户会以为 bug
 * - 生成的是**新 UUID**；渲染进程按 folder 命中已有记录时沿用旧 id（主键不漂移）
 *
 * ⚠️ 已知局限（06 §1.3 固定深度的代价）：T06 之前的两段遗留布局若**内部还有子目录**
 * （如 `模型/某沙发/贴图/木纹.jpg`），固定下钻会把它误判成分类层级。这正是
 * `main/layout.ts` 一次性迁移要先跑的原因；未迁移的此类目录会被 `onIgnored('depth')` 上报。
 */
export async function rescanLibrary(libraryDir: string, opts?: RescanOptions): Promise<RescanResult> {
  const onIgnored = opts?.onIgnored ?? (() => {})
  // T08：忽略清单**同时**进返回值（渲染层拿得到）与 onIgnored 回调（保持既有调用方兼容）
  const ignored: IgnoredEntry[] = []
  const report = (relPath: string, reason: IgnoredReason): void => {
    ignored.push({ relPath, reason })
    onIgnored(relPath, reason)
  }
  const assets: Asset[] = []
  const base = path.resolve(libraryDir)

  // 📌 兼容性设计（docs/14 §2.6）：这里**不校验**顶层目录名是否属于 `KIND_FOLDER`，
  // 任意顶层目录都会被当作大类扫描。这是旧库（`贴图/`、`材质预设/` 两个目录）能被
  // 正常索引的机制——合并迁移完成前，旧目录名必须照常可读。
  const kindFolders = await listDirs(base, base, report, 1)

  for (const kindFolderName of kindFolders) {
    const kindDir = path.join(base, kindFolderName)
    const cat1Dirs = await listDirs(kindDir, base, report, 2)

    for (const cat1 of cat1Dirs) {
      const cat1Dir = path.join(kindDir, cat1)
      // 第 2 层目录若没有任何下级子目录，就不可能是分类层。
      // 有文件 → 遗留两段布局 / 用户手工拖进来的散装文件夹 → 上报 depth；
      // 完全为空 → **空壳目录静默跳过且不计入 onIgnored**（06 v1.0.3 §11.2 正式化）：
      // 空分类目录是合法中间状态（改分类 mkdir 后移动失败的残留、用户预建的空目录），
      // 与"深度不符"的结构违规性质不同，上报只会制造噪音；侧栏对计数为 0 的分类本来就不显示。
      if (!(await hasSubDirs(cat1Dir))) {
        if (!(await dirIsEmpty(cat1Dir))) report(`${kindFolderName}/${cat1}`, 'depth')
        continue
      }
      const cat2Dirs = await listDirs(cat1Dir, base, report, 3)

      for (const cat2 of cat2Dirs) {
        const cat2Dir = path.join(cat1Dir, cat2)
        // 第 3 层同理：三段草稿布局 `模型/家具/沙发` 会被这里拦下并上报（空壳静默跳过）
        if (!(await hasSubDirs(cat2Dir))) {
          if (!(await dirIsEmpty(cat2Dir))) report(`${kindFolderName}/${cat1}/${cat2}`, 'depth')
          continue
        }
        const assetNames = await listDirs(cat2Dir, base, report, 4)

        for (const name of assetNames) {
          const folder = path.join(cat2Dir, name)
          const relSegs = [kindFolderName, cat1, cat2, name]
          // 固定四层下此处恒为 4；保留该校验以钉住 §11.2 契约
          if (relSegs.length !== 4) {
            report(relSegs.join('/'), 'depth')
            continue
          }
          let st: Awaited<ReturnType<typeof fs.stat>>
          try {
            st = await fs.stat(folder)
          } catch {
            continue
          }
          if (!st.isDirectory()) continue

          const files: AssetFile[] = []
          await walkFiles(folder, folder, files)
          if (files.length === 0) continue // 空目录不产出资产
          // 0.6.0 分辨率筛选：重扫是**旧资产补齐 w/h 的唯一通道**（导入时才会采集）。
          // 与 importer 共用同一份 `fillImageSizes`（只读文件头、失败静默）。
          await fillImageSizes(folder, files)

          const detected = primaryKind(files)
          // kind 由**内容**决定；只有内容完全判不出（'other'）时才用目录名反查兜底。
          // 「材质」目录无法反解出唯一 kind → fallbackKindOf 给 'texture'（docs/14 §2.1）。
          const kind = detected !== 'other' ? detected : fallbackKindOf(kindFolderName)
          const relFolder = composeRelFolder(kindFolderName, cat1, cat2, name)

          const coverPick = pickCover(files)

          // 材质包元数据（2026-10 任务 4）：与 importer 同规则——
          // AmbientCG/Crystal 的 *.json 解析入库，失败静默跳过
          let materialMeta: Asset['materialMeta']
          const metaJson = files.find((f) => f.ext === 'json')
          if (metaJson) {
            try {
              const text = await fs.readFile(safeJoin(folder, metaJson.rel), 'utf-8')
              const parsed = parseMaterialMetaJsonText(text)
              if (parsed) materialMeta = { name: parsed.name, tags: parsed.tags }
            } catch {
              /* 没有可用元数据 */
            }
          }

          let suVersion: string | undefined
          let suMajor: number | undefined
          const skp = files.find((f) => f.ext === 'skp')
          if (skp) {
            try {
              const head = await readHead(safeJoin(folder, skp.rel), SKP_HEAD_BYTES)
              const info = parseSkpVersion(head)
              if (info) {
                suVersion = info.label
                suMajor = info.major
              }
            } catch {
              /* 解析失败静默降级 */
            }
          }

          assets.push({
            id: randomUUID(),
            name,
            kind,
            source: '',
            folder,
            relFolder,
            cover: coverPick?.rel,
            coverSource: coverPick?.source ?? 'placeholder',
            thumbPath: undefined,
            thumbStatus: 'none',
            files,
            size: files.reduce((s, f) => s + f.size, 0),
            suVersion,
            suMajor,
            // 知末商品 ID（0.6.3）：重扫时源压缩包名已经不存在（包早被处置），
            // 只能从 **磁盘目录名 + 包内文件相对路径** 两处解析；
            // 渲染层 `store.rescan()` 合并时若本地记录已有 `zhimoId` 会原样保留（磁盘解析是兜底）。
            zhimoId: zhimoIdFromSources(
              null,
              name,
              files.map((f) => f.rel)
            ),
            // 直接取磁盘目录名，不清洗（用户手工命名照抄）；遗留两段布局不会走到这里
            category1: cat1,
            category2: cat2,
            materialMeta,
            styles: [],
            tags: [],
            note: '',
            favorite: false,
            rating: 0,
            colorTag: null,
            // 目录名可能带 `uniqueName` 追加的 `-2` 后缀（历史重复导入）→ 先剥回原始名
            // 再算 key，否则 rescan 后同一套资产的重复关系会再次断开（v0.4）。
            dedupeKey: dedupeKeyOf(baseNameOf(name), kind),
            importedAt: st.birthtimeMs || Date.now(),
            updatedAt: Date.now()
          })
        }
      }
    }
  }
  return { assets, ignored }
}
