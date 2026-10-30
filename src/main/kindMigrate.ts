/**
 * 存量资产「大类迁移」引擎：把**升级前**被判成 `model` 的 CAD 图纸资产搬进 `CAD/`（P0）。
 *
 * ── 现象与根因（已由主理人核实，勿重新调研） ──────────────────────────────
 * 用户 0.8.4 时代拖入的 `.dwg` 现在还在「模型」视图里。日志时间线：10-30 01:29 是 0.8.4、
 * 01:33 升到 0.9.0；全部日志里最后一次 `import` 是 10-28 —— 这批图纸是**升级前的存量**。
 *
 * 根因不是"导入判错了"，而是**历史语义变了**：`cad` 是 0.9.0 新增大类，之前
 * `EXT_KIND` 把 `dwg` 映射成 `model`（v0.7.4 `classify.ts:12` 可查），所以那批资产
 * 落盘在 `模型/<一级>/<二级>/<资产名>`、`files[].kind === 'model'`。升级**没有回溯迁移**。
 *
 * ⚠️ **为什么「强制重扫」救不了**（`rescan.ts:210-213`）：
 * ```ts
 * const kind = detected !== 'other' ? detected : fallbackKindOf(kindFolderName)
 * const relFolder = composeRelFolder(kindFolderName, cat1, cat2, name)
 * ```
 * `kindFolderName` 取自**磁盘实际目录名**，所以重扫只会把 DB 的 `kind` 改成 `cad`，
 * `relFolder` 仍是 `模型/…` —— 结果反而更不一致（kind 说 cad、目录在模型下）。
 * 唯一的正解就是本模块：**主动搬目录**。
 *
 * ── 判据（**宁可不迁，不可迁错**；本模块唯一的裁定口径） ──────────────────
 * ```
 * asset.kind === 'model' && hasCad && !hasModel
 * ```
 * - `hasCad`：包内出现 `dwg` / `dxf` 扩展名。**刻意硬编码这两个字符串**，不用
 *   `EXT_KIND[f.ext] === 'cad'` 反查 —— 那读的是**当前代码**的表，而我们要对齐的是
 *   0.8.x 的历史语义（那时 `dwg → model`）。跟着 `EXT_KIND` 漂移会让判据某天悄悄失效。
 * - `hasModel`：包内还有**非 CAD 的模型文件**（`.skp` / `.max` …）→ **不迁**。
 *   这是既有的「模型优先」裁定（`classify.ts:199` 的 `KIND_PRIORITY` 注释：同时含
 *   `.skp` 与 `.dwg` 的包算模型，图纸是附件）。用户库里真有这种包，它们是**正确**的 model。
 *
 * ⚠️ 判据**不能**写成 `primaryKind(asset.files) === 'cad'`：`primaryKind` 读的是**已落库**
 * 的 `files[].kind`，而存量记录的 `files[].kind` 停在 `'model'` → 那个条件**永远命中 0 条**。
 *
 * ── 五条硬约束 ────────────────────────────────────────────────────────
 * 1. **只搬、不删**：复用 `layout.ts#moveAssetCategory`（自带 self-target 守卫 +
 *    `uniqueName` 重名保护 + 同盘 `fs.rename`），**不自己写 `fs.rename`**。
 * 2. **永不覆盖**：目标已有同名资产 → `uniqueName` 追加 `-2/-3`，结果里 `renamed:true`。
 * 3. **单条失败不中断整批**：per-item `try/catch`，失败项写 `error` 继续下一条。
 *    源目录不存在时**在动盘之前**就报错（`moveAssetCategory` 会先 `mkdir` 父目录，
 *    不预检的话失败一次就留下一个空的 `CAD/一级/二级/` 壳）。
 * 4. **幂等**：判据读 `asset.kind`，迁移成功后渲染层把它写回 `'cad'` → 第二次跑
 *    `items.length === 0`（见 `shouldMigrateKind` 的第一个条件）。
 * 5. **快照先落盘**：迁移前把计划写成 `kind-migrate-<ISO>.json`（便于回溯/人工核对），
 *    写失败**不阻断**迁移，只走 `onWarn`。只保留最近 {@link SNAPSHOT_KEEP} 份。
 *
 * ── 分工（与 `materialMerge.ts` 同构）──────────────────────────────────
 * 主进程只负责**磁盘**；Dexie 在渲染层。本模块返回「最终落盘值」
 * （`folder` / `name` / `relFolder` / `renamed`），渲染层在单个事务里 put 局部字段。
 * ⚠️ 渲染层还必须把 `files[]` 里 `ext ∈ {dwg,dxf}` 的 `kind` 从 `'model'` 改成 `'cad'`
 * —— 主进程**不改 `files`**（那是索引内容，不是磁盘动作），但必须提醒：不改的话
 * 文件视图的 `.dwg` 卡片图标仍按 `f.kind` 渲染成模型图标，且下次 `primaryKind` 重算仍是
 * `'model'`，迁移就成了「目录对了、语义没对」。
 *
 * ── 为什么执行上下文不进 `KindMovePlan` ────────────────────────────────
 * `KindMovePlan`（`shared/types.ts`）是 **IPC 返回值**，必须能过 structured clone，
 * 所以它**只能含纯数据**。库根 / 快照目录 / 告警回调拆到本模块的
 * {@link KindMigrateContext}，由 `applyKindMigration(plan, ctx)` 显式接收 ——
 * 只由 main 内部持有，永不过 IPC。
 *
 * 库根「只有一处来源」这点没被削弱：`ctx.libraryDir` 由调用方在**执行那一刻**给出，
 * 与 plan 由同一次 `planKindMigration(assets, libraryDir)` 生成，两者不来自渲染层。
 * 若中途换库，plan 里的路径与新库根对不上 → 源目录预检就会失败（`error` 里写清），
 * 不会出现"跨库乱搬"。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isLegacyCadExt, kindFolder } from '../shared/classify'
import { composeRelFolder } from '../shared/naming'
import { UNCLASSIFIED } from '../shared/taxonomy'
import { isWithinRoot } from '../shared/vault'
import { moveAssetCategory } from './layout'
import type {
  Asset,
  AssetKind,
  KindMigrateDetectResult,
  KindMoveItem,
  KindMovePlan,
  KindMoveResult
} from '../shared/types'

/** 快照保留份数（与 `materialMerge.ts: MANIFEST_KEEP` 同口径；最新一份永不删） */
export const SNAPSHOT_KEEP = 5

/** 快照文件名前缀（prune 只认自己的文件，绝不误删 userData 里的其它东西） */
export const SNAPSHOT_PREFIX = 'kind-migrate-'

/**
 * 执行上下文（**只在 main 内部用，永不过 IPC**）。
 *
 * 为什么单独一个类型而不是塞进 `KindMovePlan`：`KindMovePlan` 是 IPC 返回值，
 * 函数过不了 structured clone（详见 `shared/types.ts` 该类型的注释）。这里放
 * `onWarn` 是安全的 —— 它只在 main 进程内被直接调用，不参与任何序列化。
 */
export interface KindMigrateContext {
  /** 库根绝对路径（apply 用它算目标父目录 `<库根>/CAD/<一级>/<二级>`） */
  libraryDir: string
  /** 快照目录（主进程传 `app.getPath('userData')`）；`null`/缺省 = 不写快照（单测专用） */
  snapshotDir?: string | null
  /** 告警回调（快照失败 / 清理失败）。模块不 import electron / logger，由调用方注入 */
  onWarn?: (message: string, context?: unknown) => void
}

/**
 * 该资产是否**应该**从 `model` 迁到 `cad`（纯函数，零 IO）。
 *
 * 三个条件缺一不可，见文件头「判据」段。单独导出是为了让单测能直接钉判据本身
 * （而不只是通过 `planKindMigration` 间接验证）。
 *
 * ## ⚠️ `hasCad` 与 `hasModel` **不是对称的**（容易读错，特意写明）
 *
 * - `hasCad`：**只看扩展名**（`isLegacyCadExt(f.ext)`），**完全不看 `f.kind`**。
 *   理由：扩展名是事实，`f.kind` 是历史快照。存量记录里 `dwg` 的 `f.kind` 可能是
 *   `'model'`、也可能是 `'other'`（老版本解析失败的兜底），两者都该迁。
 * - `hasModel`：**看 `f.kind === 'model'`，且排除 CAD 扩展名**。
 *   理由：它要回答的是"这个包里除了图纸还有没有别的模型文件"，那只能靠已落库的
 *   `f.kind` 判断（扩展名判 model 的范围太宽，`.jpg` 也是 `texture`）。
 *
 * 所以：一条 `ext='dwg'` 但 `f.kind='other'` 的文件 → `hasCad=true`、**不影响**
 * `hasModel` → 该资产仍会进计划。这是**正确**的（扩展名才是事实），不是 bug。
 *
 * 判据的 CAD 扩展名来自 `shared/classify.ts: LEGACY_CAD_EXTS`（`dwg` / `dxf` 硬编码，
 * **刻意不与 `EXT_KIND` 耦合**）—— 渲染层清 `files[].kind` 时用的是**同一个**判据，
 * 两边不可能漂移。理由见该常量注释。
 */
export function shouldMigrateKind(asset: Pick<Asset, 'kind' | 'files'>): boolean {
  if (asset.kind !== 'model') return false
  const files = asset.files ?? []
  let hasCad = false
  let hasModel = false
  for (const f of files) {
    // ⚠️ 只看扩展名、不看 f.kind（见上方「不是对称的」）
    if (isLegacyCadExt(f.ext)) {
      hasCad = true
      continue
    }
    // 非 CAD 的模型文件（.skp / .max / …）→ 这个包是**正确的** model，图纸只是附件
    if (f.kind === 'model') hasModel = true
  }
  return hasCad && !hasModel
}

/**
 * 目标 `relFolder`（4 段，首段 = `kindFolder('cad')`）。
 *
 * 优先**沿用磁盘现有层级**（`relFolder` 是盘上真相），只在它不足 4 段（遗留布局：
 * 两段 `模型/<资产名>` 或三段草稿）时才用 DB 分类字段重组 —— 两条路都产出 4 段，
 * 所以「搬完仍是规范布局」这个不变量恒成立。
 *
 * ⚠️ 首段用 `kindFolder('cad')` 而不是字面量 `'CAD'`：项目有源码守卫
 * （`tests/kindFolderWiring.test.ts` / `tests/filterCaps.test.ts`）盯着大类目录名的硬编码，
 * 且将来 CAD 目录若改名，只有 `KIND_FOLDER` 一处要改。
 */
function targetRelFolderOf(asset: Asset): string {
  const kindName = kindFolder('cad')
  const segs = (asset.relFolder ?? '').split('/').filter((s) => s.length > 0)
  // 规范布局：只换大类这一层；一级 / 二级 / 资产名原样保留（用户手工整理过的分类不能丢）
  if (segs.length === 4) return [kindName, segs[1]!, segs[2]!, segs[3]!].join('/')
  // 遗留布局：用 DB 的分类字段兜底（`composeRelFolder` 内部会清洗非法字符）
  return composeRelFolder(
    kindName,
    asset.category1 || UNCLASSIFIED,
    asset.category2 || UNCLASSIFIED,
    asset.name
  )
}

/**
 * 生成迁移计划（**纯计算 + 零 IO + 纯数据**；不读盘、不建目录、不写快照）。
 *
 * ⚠️ 返回值是 `KindMovePlan`（只有 `items` + `scanned`），**可以安全地过 IPC**
 * ——它要作为 `library:detectKindMigration` 的返回值发到渲染进程。
 * 加了任何函数字段都会让 structured clone 失败（见 `shared/types.ts` 的注释与
 * `tests/kindMigrate.test.ts` 的序列化守卫）。
 *
 * `libraryDir` 的用途只有一条：**库界校验**。`folder` 不在库根下的记录一律跳过
 * （那种记录搬过去只会把库外目录搅进来；main 的 IPC handler 已经用
 * `trustedAssetsOf` 过滤过一遍，这里是**第二道**，因为本函数也会被单测/将来的
 * 其它调用方直接喂数据）。
 */
export function planKindMigration(assets: Asset[], libraryDir: string): KindMovePlan {
  const items: KindMoveItem[] = []
  const list = Array.isArray(assets) ? assets : []
  const lib = path.resolve(libraryDir)

  for (const asset of list) {
    if (!asset || typeof asset.id !== 'string' || !asset.id) continue
    // 资产名 / 当前路径缺失 → 算不出目标，跳过（不猜）
    if (!asset.name || !asset.folder) continue
    // 库界校验：库外的记录不碰（第二道，见函数头）
    if (!isWithinRoot(lib, path.resolve(asset.folder), path.sep)) continue
    if (!shouldMigrateKind(asset)) continue

    const toRelFolder = targetRelFolderOf(asset)
    // 计划期 self-target 守卫：目标与现状逐字相同 → 没有可搬的（幂等的第二道保险，
    // 防手改数据造出的"kind=model 但目录已在 CAD 下"记录被反复计入计划）
    if (toRelFolder === asset.relFolder) continue

    items.push({
      assetId: asset.id,
      name: asset.name,
      fromRelFolder: asset.relFolder ?? '',
      toRelFolder,
      fromKind: asset.kind,
      toKind: 'cad' as AssetKind,
      folder: asset.folder
    })
  }

  return { items, scanned: list.length }
}

/** 只读探测（IPC 用）：**精简结构**，只回数量与资产名，不回任何路径 */
export function detectKindMigration(
  assets: Asset[],
  libraryDir: string
): KindMigrateDetectResult {
  const plan = planKindMigration(assets, libraryDir)
  return {
    count: plan.items.length,
    scanned: plan.scanned,
    names: plan.items.map((i) => i.name)
  }
}

/** 快照文件名：`kind-migrate-<ISO>.json`（Windows 不允许 `:`，替换成 `-` 仍是可排序时间戳） */
export function kindMigrateSnapshotName(now: Date = new Date()): string {
  return `${SNAPSHOT_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}.json`
}

/**
 * 迁移前落一份快照（**写失败不阻断**，见文件头约束 5）。
 *
 * 内容刻意朴素（plan 原样 + 生成时间 + 库根）：这份文件的用途是"用户报问题时能让他把
 * 这个 json 发过来"，以及事后人工核对搬了哪些 —— 不是自动回滚凭据
 * （`items[].folder` / `toRelFolder` 已经足够人工搬回去）。
 *
 * @returns 快照绝对路径；未写（无 snapshotDir / 写失败）→ `null`
 */
async function writeSnapshot(plan: KindMovePlan, ctx: KindMigrateContext): Promise<string | null> {
  if (!ctx.snapshotDir) return null
  const dir = path.resolve(ctx.snapshotDir)
  const file = path.join(dir, kindMigrateSnapshotName())
  try {
    await fs.mkdir(dir, { recursive: true })
    const payload = {
      version: 1,
      at: new Date().toISOString(),
      libraryDir: path.resolve(ctx.libraryDir),
      scanned: plan.scanned,
      count: plan.items.length,
      items: plan.items
    }
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8')
    return file
  } catch (err) {
    ctx.onWarn?.('kind-migrate:snapshot-failed', {
      file,
      reason: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/**
 * 只保留最近 `SNAPSHOT_KEEP` 份快照（照抄 `materialMerge.ts: pruneManifests`）。
 *
 * 为什么必须清理：用户会在"我点了没反应"的时候反复点按钮，不清理就是无限增长。
 * 排序依据是文件名里的 ISO 时间戳（`kind-migrate-2026-10-30T07-…` 字典序 = 时间序），
 * 所以**不需要读文件内容**就能定序，也不怕某份 JSON 被改坏。
 *
 * 只 `unlink` 自己前缀的文件；删失败静默（`onWarn`）——清理是 best-effort，
 * 失败不该影响迁移结果。
 */
async function pruneSnapshots(ctx: KindMigrateContext): Promise<void> {
  if (!ctx.snapshotDir) return
  const dir = path.resolve(ctx.snapshotDir)
  let names: string[] = []
  try {
    const entries = await fs.readdir(dir)
    names = entries.filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json')).sort()
  } catch {
    return
  }
  // 升序排列 → 前面的是最旧的；保留末尾 KEEP 份
  const stale = names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))
  for (const n of stale) {
    try {
      await fs.unlink(path.join(dir, n))
    } catch (err) {
      ctx.onWarn?.('kind-migrate:prune-failed', {
        file: n,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

/** 目录是否真实存在（失败即"磁盘已变动"，不猜） */
async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 执行迁移：逐条 `moveAssetCategory`，**单条失败不中断整批**。
 *
 * 顺序（不可调换）：① 先写快照 → ② 清理旧快照 → ③ 逐条搬 → ④ 回传最终落盘值。
 * 每条都要重新核源目录存在性：批量搬 GB 级目录时用户可能同时在资源管理器里动文件，
 * 预检一次能避免「父目录被 `mkdir` 出来、`rename` 才失败」留下空中转目录。
 *
 * @param plan `planKindMigration` 的产物（纯数据）
 * @param ctx 执行上下文（库根 / 快照目录 / 告警回调）；**只在 main 内部构造**
 */
export async function applyKindMigration(
  plan: KindMovePlan,
  ctx: KindMigrateContext
): Promise<KindMoveResult[]> {
  const results: KindMoveResult[] = []
  const items = plan.items ?? []
  // 幂等出口：无搬移项 → 不写快照、不建任何目录
  if (items.length === 0) return results

  const libraryDir = path.resolve(ctx.libraryDir)

  await writeSnapshot(plan, { ...ctx, libraryDir })
  await pruneSnapshots({ ...ctx, libraryDir })

  for (const item of items) {
    const segs = item.toRelFolder.split('/').filter((s) => s.length > 0)
    try {
      // ① 源目录预检（**早于** `moveAssetCategory` 的 mkdir，见函数头）
      if (!(await isDirectory(item.folder))) {
        throw new Error('源目录不存在（磁盘已变动，请重新扫描）')
      }
      if (segs.length !== 4) throw new Error(`目标路径不是四层布局：${item.toRelFolder}`)
      // ② 目标父目录 = <库根>/<CAD>/<一级>/<二级>（只取前 3 段）
      const parentDir = path.join(libraryDir, segs[0]!, segs[1]!, segs[2]!)
      // ③ 复用唯一搬盘入口：self-target 守卫 + uniqueName 防重名都在它里面
      const moved = await moveAssetCategory(item.folder, parentDir)
      // ④ 回传**最终落盘值**：重名时末段被追加 `-2`，relFolder 必须同步（否则 folder 与索引不一致）
      results.push({
        assetId: item.assetId,
        folder: moved.folder,
        name: moved.name,
        relFolder: [...segs.slice(0, 3), moved.name].join('/'),
        // `moved.moved === false` 只出现在 self-target（父目录已相同）——本模块计划期
        // 已把这种记录排除，但 main 侧不依赖调用方自觉，原样透传
        moved: moved.moved,
        renamed: moved.renamed
      })
    } catch (err) {
      // 单条失败不中断：失败项保持 source 值，`error` 里有可行动的原因
      results.push({
        assetId: item.assetId,
        folder: item.folder,
        name: item.name,
        relFolder: item.fromRelFolder,
        moved: false,
        renamed: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}
