/**
 * 材质大类合并 · 磁盘迁移引擎（T-03，`docs/14-变更设计-材质大类合并.md` §2.3）。
 *
 * 把旧库的两个大类目录 `贴图/`、`材质预设/` **逐资产**搬进 `材质/`，并留下可回滚的 manifest。
 *
 * ── 五条硬约束（改动前必读） ───────────────────────────────────────────
 * 1. **逐资产 `fs.rename`，禁止整目录 rename**：目标 `材质/` 可能已存在（部分迁移过 /
 *    用户手工建过），整目录 rename 在 Windows 上会 `EEXIST/ENOTEMPTY`；逐资产搬天然是
 *    merge——同名一级目录逐层 `mkdir -p` 后自然汇聚，不存在"覆盖目录"这个动作。
 * 2. **永不覆盖**：目标已存在同名资产 → `uniqueName` 追加 `-2/-3`（与导入/改分类同一规则）。
 *    `fs.rename` 在 Windows 上会静默替换目标文件，所以必须先算名再 stat 复核。
 * 3. **先写 manifest 再动盘**：全量计划先落 `status='pending'`，每完成一项原子重写一次
 *    （写 `.tmp` → rename 覆盖）。崩溃最多丢最后一项的状态，重跑只搬剩下的（幂等）。
 * 4. **幂等**：源目录不存在/已空 → 0 move 且**不建任何目录**（连 `.idbox` 都不建）。
 * 5. **源目录只 `rmdir`（非递归）**：只清空目录壳，绝不 `rm -rf`（那会删用户文件）。
 *
 * ⚠️ DB 不在这里改：main 进程拿不到 Dexie。本模块只返回"最终落盘值"，
 * 渲染层在**单个事务**里 `put` 局部字段（`folder` / `relFolder` / 重名时的 `name` 与
 * `dedupeKey`），**禁止 delete+put**（会丢 tags/note/styles/renderParams）。
 * manifest 里内联 `assetId` + `prevRelFolder`，就是给渲染层回滚时恢复 DB 用的凭据。
 */
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { kindFolder } from '../shared/classify'
import { uniqueName } from '../shared/naming'
import type {
  AssetKind,
  MergeMaterialAssetRef,
  MergeMaterialDetectResult,
  MergeMaterialFailure,
  MergeMaterialMove,
  MergeMaterialResult,
  MergeMaterialRollbackResult,
  MergeMaterialSkipped,
  MergeMaterialSource
} from '../shared/types'

/** 超阈值不自动执行（沿用 `store.ts` 的 AUTO_MIGRATE_LIMIT = 50，不新造阈值） */
export const MATERIAL_MERGE_LIMIT = 50

/** manifest 保留份数（成功/失败后 best-effort 清理更早的；最新一份永不删） */
export const MANIFEST_KEEP = 5

/** manifest 目录（相对库根）。`.` 开头 → `rescan` 整目录跳过，不污染索引 */
export const MANIFEST_DIR_REL = path.join('.idbox', 'merge-material')

/**
 * 两个只读历史大类目录（**写入永不再用**，见 docs/14 §0.1-2）。
 * 顺序固定：贴图 先于 材质预设 —— 它决定"同批同名资产谁保留原名"，
 * 顺序变化会让迁移结果不可复现。
 */
const MERGE_SOURCES: ReadonlyArray<{ folderName: string; kind: AssetKind }> = [
  { folderName: '贴图', kind: 'texture' },
  { folderName: '材质预设', kind: 'material' }
]

/** 计划（只读产物，可预演、可深比较做幂等断言） */
export interface MaterialMergePlan {
  /** 库根绝对路径（apply 写 manifest 需要，故显式带上而不是从 moves 反推） */
  libraryDir: string
  moves: MergeMaterialMove[]
  sources: MergeMaterialSource[]
  skipped: MergeMaterialSkipped[]
}

// ── 小工具 ───────────────────────────────────────────────────────────

/** 读目录，分成子目录/文件两类（跳过 `.` 开头项）；目录不存在 → 两个空数组 */
async function listDir(dir: string): Promise<{ dirs: string[]; files: string[] }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { dirs: [], files: [] }
  }
  const dirs: string[] = []
  const files: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) dirs.push(e.name)
    else if (e.isFile()) files.push(e.name)
  }
  // 稳定排序：盘上顺序不同不应改变计划（幂等断言依赖它）
  dirs.sort()
  files.sort()
  return { dirs, files }
}

/** 读目录下的条目名（含文件与目录，跳过 `.` 开头）；不存在 → [] */
async function namesIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

/** 路径比较键（Windows 大小写不敏感；POSIX 保持原样） */
function pathKey(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 路径是否存在 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** 是否是目录 */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 替换 posix relFolder 的末段（重名追加序号后同步 relFolder） */
function replaceLastSegment(relFolder: string, segment: string): string {
  const segs = relFolder.split('/')
  segs[segs.length - 1] = segment
  return segs.join('/')
}

// ── plan（只读） ─────────────────────────────────────────────────────

/**
 * 生成迁移计划：**只读磁盘，零写入**；连跑两次结果逐项相同（幂等依据）。
 *
 * 三层下钻 `<源>/<一级>/<二级>/<资产名>`（与 rescan 的固定四层契约一致），第 4 层是目录即资产。
 * 重名判定在**计划期就模拟**：既算目标盘上已有的同名项，也算本批已占位的名字
 * ——否则两个源里同分类同名的资产会算出同一个 `to`（apply 时才 -2，计划就骗人了）。
 */
export async function planMaterialMerge(libraryDir: string): Promise<MaterialMergePlan> {
  const base = path.resolve(libraryDir)
  const moves: MergeMaterialMove[] = []
  const sources: MergeMaterialSource[] = []
  const skipped: MergeMaterialSkipped[] = []
  /** 目标父目录 → 已占用的名字（跨两个源共享，保证同批也去重） */
  const reserved = new Map<string, Set<string>>()

  for (const src of MERGE_SOURCES) {
    const srcDir = path.join(base, src.folderName)
    const srcExists = await isDir(srcDir)
    let assetCount = 0

    if (srcExists) {
      const lvl1 = await listDir(srcDir)
      for (const f of lvl1.files) skipped.push({ relPath: `${src.folderName}/${f}`, reason: 'not-dir' })
      if (lvl1.dirs.length === 0) {
        skipped.push({ relPath: src.folderName, reason: lvl1.files.length > 0 ? 'not-dir' : 'empty' })
      }

      for (const cat1 of lvl1.dirs) {
        const cat1Dir = path.join(srcDir, cat1)
        const lvl2 = await listDir(cat1Dir)
        for (const f of lvl2.files) {
          skipped.push({ relPath: `${src.folderName}/${cat1}/${f}`, reason: 'not-dir' })
        }
        if (lvl2.dirs.length === 0) {
          // 三段草稿 `<源>/<一级>/<资产名>/…`：一级其实是资产名，不能当分类搬（搬了就丢层级）
          skipped.push({
            relPath: `${src.folderName}/${cat1}`,
            reason: lvl2.files.length > 0 ? 'depth' : 'empty'
          })
          continue
        }

        for (const cat2 of lvl2.dirs) {
          const cat2Dir = path.join(cat1Dir, cat2)
          const lvl3 = await listDir(cat2Dir)
          if (lvl3.dirs.length === 0) {
            // 同上：`<源>/<一级>/<二级>/<散落文件>` → 二级其实是资产名
            if (lvl3.files.length > 0) {
              skipped.push({ relPath: `${src.folderName}/${cat1}/${cat2}`, reason: 'depth' })
            }
            continue
          }
          for (const f of lvl3.files) {
            skipped.push({ relPath: `${src.folderName}/${cat1}/${cat2}/${f}`, reason: 'not-dir' })
          }

          const targetParent = path.join(base, kindFolder(src.kind), cat1, cat2)
          const parentKey = pathKey(targetParent)
          let taken = reserved.get(parentKey)
          if (!taken) {
            taken = new Set(await namesIn(targetParent))
            reserved.set(parentKey, taken)
          }

          for (const assetName of lvl3.dirs) {
            assetCount++
            const finalName = uniqueName(assetName, taken)
            taken.add(finalName)
            const renamed = finalName !== assetName
            moves.push({
              from: path.join(cat2Dir, assetName),
              to: path.join(targetParent, finalName),
              relFolderFrom: `${src.folderName}/${cat1}/${cat2}/${assetName}`,
              relFolderTo: `${kindFolder(src.kind)}/${cat1}/${cat2}/${finalName}`,
              kind: src.kind,
              renamed,
              assetId: null,
              prevRelFolder: null
            })
          }
        }
      }
    }

    sources.push({ name: src.folderName, dir: srcDir, exists: srcExists, assetCount })
  }

  return { libraryDir: base, moves, sources, skipped }
}

/** 只读探测（启动时用）：**不做任何写入**，连 `.idbox` 都不建 */
export async function detectMaterialMerge(libraryDir: string): Promise<MergeMaterialDetectResult> {
  const plan = await planMaterialMerge(libraryDir)
  return {
    needMerge: plan.moves.length > 0,
    count: plan.moves.length,
    sources: plan.sources
  }
}

// ── manifest ─────────────────────────────────────────────────────────

type ManifestItemStatus = 'pending' | 'moved' | 'failed' | 'rolledBack'

interface ManifestItem {
  from: string
  to: string
  relFolderFrom: string
  relFolderTo: string
  kind: AssetKind
  renamed: boolean
  status: ManifestItemStatus
  error: string | null
  /** 渲染层资产 id（调用方传了 assets 白名单才有）——回滚恢复 DB 的钥匙 */
  assetId: string | null
  /** 迁移前 relFolder（回滚写回 DB 用） */
  prevRelFolder: string | null
}

interface Manifest {
  version: 1
  at: string
  libraryDir: string
  status: 'running' | 'completed' | 'partial' | 'rolledBack'
  summary: { total: number; moved: number; failed: number; renamed: number }
  items: ManifestItem[]
}

/** manifest 目录绝对路径（不创建） */
export function manifestDirOf(libraryDir: string): string {
  return path.join(path.resolve(libraryDir), MANIFEST_DIR_REL)
}

/** ISO 文件名：Windows 不允许 `:`，先替换掉（仍是可排序的时间戳） */
function manifestStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/** 原子重写 manifest（写 `.tmp` → rename 覆盖；崩溃最多丢最后一项状态） */
async function writeManifest(file: string, data: Manifest): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/** 建 manifest 目录 + 首份全量计划（status=running，全部 pending），返回路径 */
async function createManifest(libraryDir: string, items: ManifestItem[]): Promise<string> {
  const dir = manifestDirOf(libraryDir)
  await fs.mkdir(dir, { recursive: true })
  const base = manifestStamp(new Date())
  let file = path.join(dir, `${base}.json`)
  // 同一毫秒内连开两次 → 追加 -2，绝不覆盖上一份（回滚凭据不可丢）
  for (let i = 2; await exists(file); i++) {
    file = path.join(dir, `${base}-${i}.json`)
  }
  const data: Manifest = {
    version: 1,
    at: new Date().toISOString(),
    libraryDir: path.resolve(libraryDir),
    status: 'running',
    summary: { total: items.length, moved: 0, failed: 0, renamed: 0 },
    items
  }
  await writeManifest(file, data)
  return file
}

/** 刷新 summary（每次写盘前调用，保证 summary 与 items 一致） */
function refreshSummary(data: Manifest): void {
  let moved = 0
  let failed = 0
  let renamed = 0
  for (const it of data.items) {
    if (it.status === 'moved') {
      moved++
      if (it.renamed) renamed++
    } else if (it.status === 'failed') failed++
  }
  data.summary = { total: data.items.length, moved, failed, renamed }
}

/** 只保留最近 N 份 manifest（按文件名时间戳降序；最新一份永不删） */
async function pruneManifests(libraryDir: string, keep: number): Promise<void> {
  const dir = manifestDirOf(libraryDir)
  let names: string[] = []
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return
  }
  const stale = names.slice(0, Math.max(0, names.length - keep))
  for (const n of stale) {
    await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)
  }
}

/** 读 manifest 并做最小结构校验（只读自己写的文件，仍要防半截 JSON） */
async function readManifest(file: string): Promise<Manifest> {
  const text = await fs.readFile(file, 'utf-8')
  const data = JSON.parse(text) as Manifest
  if (!data || data.version !== 1 || !Array.isArray(data.items)) {
    throw new Error('manifest 格式不可识别')
  }
  return data
}

// ── apply ────────────────────────────────────────────────────────────

/** 模块级互斥：迁移期间禁止第二次迁移（RM9） */
let mergingMaterial = false

/** 迁移是否正在进行（渲染层可据此禁用「重扫」入口） */
export function isMaterialMergeRunning(): boolean {
  return mergingMaterial
}

/** 把渲染层传来的资产引用按 `from` 匹配进 move（写 manifest 的回滚凭据） */
function attachAssetRefs(
  moves: MergeMaterialMove[],
  refs: ReadonlyArray<MergeMaterialAssetRef> | undefined
): MergeMaterialMove[] {
  if (!refs || refs.length === 0) return moves.map((m) => ({ ...m }))
  const byFolder = new Map<string, MergeMaterialAssetRef>()
  for (const r of refs) {
    if (r && typeof r.id === 'string' && r.id && typeof r.folder === 'string' && r.folder) {
      byFolder.set(pathKey(r.folder), r)
    }
  }
  return moves.map((m) => {
    const ref = byFolder.get(pathKey(m.from))
    return {
      ...m,
      assetId: ref ? ref.id : null,
      prevRelFolder: ref ? (ref.relFolder || m.relFolderFrom) : null
    }
  })
}

/** 空结果（幂等出口 / 忙 / 超阈值共用，保证字段齐全） */
function emptyResult(over: Partial<MergeMaterialResult> = {}): MergeMaterialResult {
  return {
    moves: [],
    moved: 0,
    skipped: 0,
    renamed: 0,
    failures: [],
    needsManual: false,
    count: 0,
    manifestPath: null,
    ...over
  }
}

/**
 * 执行迁移：**先写 manifest 再动盘**，逐资产 `fs.rename`；单项失败只记录不中断。
 *
 * `opts.assetRefs` 仅用于把 `{id, relFolder}` 写进 manifest（回滚凭据），不参与路径决策。
 */
export async function applyMaterialMerge(
  plan: MaterialMergePlan,
  opts?: { assetRefs?: ReadonlyArray<MergeMaterialAssetRef> }
): Promise<MergeMaterialResult> {
  if (mergingMaterial) {
    return emptyResult({
      count: plan.moves.length,
      failures: [{ from: '', reason: '已有一次材质迁移正在进行，请稍后重试' }]
    })
  }
  // 幂等出口：无搬移项 → 不建目录、不写 manifest
  if (plan.moves.length === 0) {
    return emptyResult({ skipped: plan.skipped.length, count: 0 })
  }

  const libraryDir = plan.libraryDir
  const moves = attachAssetRefs(plan.moves, opts?.assetRefs)
  mergingMaterial = true
  let manifestFilePath: string | null = null
  // ⚠️ 在 try 外声明：manifest 写到一半失败时，**已搬成功的项必须回传给渲染层**
  // （否则磁盘动了、DB 没动 → 下轮 rescan 合并键 folder 命中不到 → 删旧建新丢 tags，RM2）
  const ok: MergeMaterialMove[] = []
  const failures: MergeMaterialFailure[] = []
  try {
    const items: ManifestItem[] = moves.map((m) => ({
      from: m.from,
      to: m.to,
      relFolderFrom: m.relFolderFrom,
      relFolderTo: m.relFolderTo,
      kind: m.kind,
      renamed: m.renamed,
      status: 'pending',
      error: null,
      assetId: m.assetId ?? null,
      prevRelFolder: m.prevRelFolder ?? null
    }))
    manifestFilePath = await createManifest(libraryDir, items)
    const manifest = await readManifest(manifestFilePath)

    // 逐项处理：与 moves 一一对应（顺序即 MERGE_SOURCES + 词典序，可复现）
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]!
      const item = manifest.items[i]!
      try {
        const st = await fs.stat(move.from)
        if (!st.isDirectory()) throw new Error('源路径不是目录')

        const parent = path.dirname(move.to)
        await fs.mkdir(parent, { recursive: true })
        // 计划期已算过 uniqueName，此处**再算一次**（RM3：apply 前复核，绝不覆盖）
        const taken = new Set(await namesIn(parent))
        const finalName = uniqueName(path.basename(move.to), taken)
        const dest = path.join(parent, finalName)
        const finalRel = replaceLastSegment(move.relFolderTo, finalName)

        await fs.rename(move.from, dest)

        item.status = 'moved'
        item.to = dest
        item.relFolderTo = finalRel
        // 语义：目标名与源资产名不同 = 因重名加了序号（不是"路径变了"）
        item.renamed = finalName !== path.basename(move.from)
        item.error = null
        ok.push({
          ...move,
          to: dest,
          relFolderTo: finalRel,
          renamed: item.renamed
        })
      } catch (err) {
        item.status = 'failed'
        item.error = err instanceof Error ? err.message : String(err)
        failures.push({ from: move.from, reason: item.error })
      }
      // 每完成一项原子重写一次：崩溃最多丢最后一项状态，已完成的项有据可查
      refreshSummary(manifest)
      await writeManifest(manifestFilePath, manifest)
    }

    // 源目录只清空壳（非递归 rmdir）；失败吞掉（非空说明还有没搬完的，下轮重试）
    for (const src of MERGE_SOURCES) {
      await pruneEmptyDirs(path.join(libraryDir, src.folderName))
    }

    manifest.status = failures.length > 0 ? 'partial' : 'completed'
    refreshSummary(manifest)
    await writeManifest(manifestFilePath, manifest)
    await pruneManifests(libraryDir, MANIFEST_KEEP)

    return {
      moves: ok,
      moved: ok.length,
      skipped: plan.skipped.length,
      renamed: ok.filter((m) => m.renamed).length,
      failures,
      needsManual: false,
      count: moves.length,
      manifestPath: manifestFilePath
    }
  } catch (err) {
    // manifest 写不了 / 读不了：带出**已完成**的项，磁盘与 DB 不能失联（RM2）
    return emptyResult({
      moves: ok,
      moved: ok.length,
      renamed: ok.filter((m) => m.renamed).length,
      count: moves.length,
      skipped: plan.skipped.length,
      failures: [
        ...failures,
        { from: '', reason: err instanceof Error ? err.message : String(err) }
      ],
      manifestPath: manifestFilePath
    })
  } finally {
    mergingMaterial = false
  }
}

/**
 * 递归清空**空目录**（只 `rmdir` 非递归；任何非空目录自然失败 → 保留）。
 * 用于迁移后让 `贴图/`、`材质预设/` 与它们的空分类壳消失（QA Q2）。
 */
async function pruneEmptyDirs(dir: string): Promise<void> {
  const { dirs } = await listDir(dir)
  for (const d of dirs) await pruneEmptyDirs(path.join(dir, d))
  try {
    await fs.rmdir(dir)
  } catch {
    /* 非空 / 不存在 / 被占用：都不是错误 */
  }
}

/**
 * 一键迁移（IPC 入口）：plan → 阈值判定 → apply。
 *
 * `count > MATERIAL_MERGE_LIMIT` 且未 `force` → 只返回 `needsManual:true`，
 * **磁盘零改动**（批量搬 GB 级目录必须让用户知情）。
 */
export async function mergeMaterial(
  libraryDir: string,
  payload?: { force?: boolean; assets?: ReadonlyArray<MergeMaterialAssetRef> }
): Promise<MergeMaterialResult> {
  const plan = await planMaterialMerge(libraryDir)
  const count = plan.moves.length
  if (count === 0) return emptyResult({ skipped: plan.skipped.length })
  if (count > MATERIAL_MERGE_LIMIT && !payload?.force) {
    return emptyResult({ needsManual: true, count, skipped: plan.skipped.length })
  }
  return applyMaterialMerge(plan, { assetRefs: payload?.assets })
}

// ── rollback ─────────────────────────────────────────────────────────

/**
 * 回滚：按 manifest **逆序**把 `status==='moved'` 的项搬回。
 *
 * 三道保护：① 目标不存在 → 记 failed 不猜；② 源路径已被占用 → 记 failed **绝不覆盖**；
 * ③ 只处理 moved（pending/failed 本来就没动）。返回的 `restored` 带
 * `assetId` / `prevRelFolder`，渲染层据此恢复 DB 字段（单事务 put）。
 * 传入 `libraryDir` 时再做一次交叉校验（manifest 记录的库根必须一致，防跨库误回滚）。
 *
 * 裁定：**不自动触发**（docs/14 §2.3.4）——磁盘成功而 DB 更新失败的情况，
 * 自动回滚会把两类事故混成一种处理，风险高于收益。设置页按钮为 P2。
 */
export async function rollbackMaterialMerge(
  manifestPath: string,
  libraryDir?: string
): Promise<MergeMaterialRollbackResult> {
  if (mergingMaterial) {
    return {
      restored: [],
      restoredCount: 0,
      failures: [{ from: '', reason: '已有一次材质迁移正在进行，请稍后重试' }],
      manifestPath
    }
  }
  mergingMaterial = true
  try {
    const manifest = await readManifest(manifestPath)
    // 交叉校验：manifest 里记录的库根必须与当前库一致（防把别的库的记录搬回来）
    if (libraryDir && pathKey(manifest.libraryDir) !== pathKey(libraryDir)) {
      throw new Error('manifest 属于另一个库目录，拒绝回滚')
    }
    const restored: MergeMaterialMove[] = []
    const failures: MergeMaterialFailure[] = []

    for (let i = manifest.items.length - 1; i >= 0; i--) {
      const item = manifest.items[i]!
      if (item.status !== 'moved') continue
      try {
        if (!(await exists(item.to))) throw new Error('目标不存在（可能已被移动或删除）')
        if (await exists(item.from)) throw new Error('源路径已被占用，拒绝覆盖')
        await fs.mkdir(path.dirname(item.from), { recursive: true })
        await fs.rename(item.to, item.from)
        item.status = 'rolledBack'
        item.error = null
        restored.push({
          from: item.from,
          to: item.to,
          relFolderFrom: item.relFolderFrom,
          relFolderTo: item.relFolderTo,
          kind: item.kind,
          renamed: item.renamed,
          assetId: item.assetId,
          prevRelFolder: item.prevRelFolder
        })
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err)
        failures.push({ from: item.to, reason: item.error })
      }
      refreshSummary(manifest)
      await writeManifest(manifestPath, manifest)
    }

    // 回滚后目标侧的空壳目录（材质/…）也顺手清掉；非空会自然失败并保留
    for (const src of MERGE_SOURCES) {
      await pruneEmptyDirs(path.join(manifest.libraryDir, kindFolder(src.kind)))
    }

    manifest.status = failures.length > 0 ? 'partial' : 'rolledBack'
    refreshSummary(manifest)
    await writeManifest(manifestPath, manifest)

    return {
      restored,
      restoredCount: restored.length,
      failures,
      manifestPath
    }
  } catch (err) {
    return {
      restored: [],
      restoredCount: 0,
      failures: [{ from: '', reason: err instanceof Error ? err.message : String(err) }],
      manifestPath
    }
  } finally {
    mergingMaterial = false
  }
}
