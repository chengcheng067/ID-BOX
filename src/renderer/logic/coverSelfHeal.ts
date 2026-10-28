/**
 * 封面死锁自愈（0.8.3，外部用户 v0.8.2 实测反馈）——**纯逻辑**，零 electron /
 * 零 Dexie / 零网络，可在 vitest node 环境直测。
 *
 * ## 根因链（诊断定案，证据链见 docs/25）
 *
 * 1. 用户在 0.8.1 重扫入库：当时 `pickCover` 还不认 `<x>.cover.jpg` → 索引
 *    `cover` 字段没指向盘上真实存在的封面文件 → 卡片缺图；
 * 2. 0.8.2 补抓候选规则④（`isZhimoCoverBackfillCandidate`）= `files` 根层已有
 *    `<x>.cover.(jpg|png)` 就**一律不重抓** → 这类资产被补抓永远跳过 → 死锁；
 * 3. 手动单个取封面走 `force` 所以能成 —— 这正是用户"按钮坏了"误解的来源。
 *
 * ## 本模块只做"算"，不负责"写"（与 `logic/recordHygiene.ts` 同一分工）
 *
 * ① `planCoverSelfHeal().repoints` —— A：`cover` 字段没指向根层封面文件的活记录
 *    → 计划改指该文件、`coverSource` 置 `'named'`（**与 `pickCover` ① 对 cover 文件
 *    的 source 值逐字同口径**），并把缩略图交给既有补齐队列重生（store 侧置
 *    `thumbStatus='none'`，不新造队列）；
 * ② `planCoverSelfHeal().folderResyncs` —— C：`folder` 与 `libraryDir + relFolder`
 *    脱同步的活记录（重排/去重改名后 folder 字段未同步的存量）→ 计划按 `relFolder`
 *    重建绝对路径。
 *
 * ## 为什么 folder 脱同步的**判定**用字符串比对、而不是逐条 stat 磁盘
 *
 * - 渲染层没有通用的"路径是否存在"IPC（加通道要动 `main/index.ts`，本批冻结）；
 * - 字符串比对对健康库是 **O(1) / 条、零 IO**：正常库一个探测都不发；
 * - ENOENT 场景（改名后 folder 未同步）必然表现为 `folder ≠ libraryDir + relFolder`
 *   —— 字符串比对恰好覆盖它；整棵目录真没了的属于"库目录漂移"（DEF-19-3 有
 *   专门的可见性通道），不是本层的目标场景。
 * 重建路径**落库前**的磁盘核实（`probeSizes` 探一张索引内图片）留在 store 侧
 * 异步做：纯层算出 `probeRel`，store 拿它问主进程，探不到就 WARN 跳过。
 *
 * ## 硬纪律（与 recordHygiene 四条同源）
 *
 * - **软删记录绝不参与**：回收站里的目录已搬进 `.trash/`，`folder` 与磁盘不一致
 *   是**设计内状态**，拿 `relFolder` 重建等于把还原流程的凭据改坏；
 * - **确定性**：同输入同输出；多个候选封面文件时沿用 `pickCover` 的字典序裁定；
 * - **幂等**：重指后条件 ③ 不再成立、重建后字符串相等 → 下次启动计划为空。
 */

import type { Asset, AssetFile, CoverSource } from '../../shared/types'
import { isCoverAssetImage, pickCover } from '../../shared/classify'
import { hasCoverAssetFile } from './zhimoCover'
import { assetFileAbs } from './assetPath'
import { isDeletedAsset } from './trashView'

/** A 的一条重指计划：把 `cover` 改指 `rel`，`source` 与 `pickCover` ① 同口径 */
export interface CoverRepointPlanItem {
  id: string
  /** 资产根层 `<x>.cover.(jpg|png)` 的 posix rel */
  rel: string
  /** 恒为 `'named'`（`pickCover` 对 cover 文件的 source 值，不改 schema 口径） */
  source: CoverSource
}

/** C 的一条 folder 重建计划：把 `folder` 改写为按 `relFolder` 重建的绝对路径 */
export interface FolderResyncPlanItem {
  id: string
  /** 重建出的绝对路径（`libraryDir + relFolder`） */
  folder: string
  /**
   * 磁盘核实用的图片 rel（该资产索引里第一张 texture/hdri）。
   * `null` = 索引里没有图片可探 → store 侧免探测直接重建（写失败会再报 WARN，自限）。
   */
  probeRel: string | null
}

export interface CoverSelfHealPlan {
  repoints: CoverRepointPlanItem[]
  folderResyncs: FolderResyncPlanItem[]
}

export interface CoverSelfHealOptions {
  /** `settings.libraryDir`；为空（未选库）时 C 整段跳过（A 不依赖它） */
  libraryDir?: string | null
}

/**
 * 资产根层的封面文件 rel（**与 `pickCover` ① 同一份裁定**）。
 *
 * 直接复用 `pickCover` 而不是自己再写一遍筛选：cover 文件在它的候选序里最优先，
 * 多候选时按 rel 字典序取第一个 —— 自愈重指的 rel 必须与"下次 rescan 会算出的
 * cover"完全一致，否则自愈和重扫互相打架。
 *
 * 返回 `null` 的情形：没有图片 / 图片不在根层 / 根层没有 `<x>.cover.(jpg|png)`
 * （`isCoverAssetImage` 兜底：`pickCover` 的候选按 kind 过滤，这里再按名字复核一次，
 * 防 files 索引里 kind 字段脏掉的记录把非图片顶成封面）。
 */
export function pickRootCoverRel(files: readonly Pick<AssetFile, 'rel'>[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return null
  const pick = pickCover(files as AssetFile[])
  if (!pick) return null
  if (pick.rel.includes('/')) return null
  return isCoverAssetImage(pick.rel) ? pick.rel : null
}

/**
 * 路径归一（只用于**比较**，不用于落库）：分隔符统一成 `/`、小写、去尾分隔符。
 * Windows 库是大小写不敏感的盘，`E:\Lib` 与 `e:\lib\` 指向同一目录，
 * 拿原串比对会为纯大小写差异空跑一轮重建。
 */
export function normalizeFolderPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 按 `relFolder`（posix，相对库根）重建资产文件夹绝对路径。
 *
 * 复用 `assetFileAbs`（分隔符探测 + posix → 本地分隔符），只是先剥掉
 * `libraryDir` 的尾分隔符，避免拼出 `E:\Lib\/模型\...` 这种混合串。
 */
export function expectedAssetFolder(libraryDir: string, relFolder: string): string {
  const lib = libraryDir.replace(/[\\/]+$/, '')
  return assetFileAbs(lib, relFolder)
}

/**
 * 算出封面自愈计划（A 重指 + C folder 重建），**只读入参，不做 IO**。
 *
 * A（repoint）四道条件（AND，全部满足才产出）：
 * ① 活记录（软删跳过）；
 * ② `coverSource` 不是 `manual` / `zhimo`（用户亲手设的 / 知末刚抓的绝不被顶掉）；
 * ③ `files` 根层存在 `<x>.cover.(jpg|png)`（`hasCoverAssetFile`，与补抓候选规则④
 *    同一份判定 —— 它拦住了补抓，就必须由本自愈接手，两头用同一个函数才不会
 *    再出现"一边不做、一边不让做"的死锁）；
 * ④ `asset.cover` 尚未指向该文件（幂等闸）。
 *
 * C（folderResync）条件：活记录 + `libraryDir` / `relFolder` / `folder` 都非空 +
 * `folder` 与 `libraryDir + relFolder` 归一后不相等。`probeRel` 取索引里第一张
 * texture/hdri（顺序即 files 顺序，探测只图"有图可探"，不参与裁定）。
 */
export function planCoverSelfHeal(
  assets: readonly Asset[],
  opts: CoverSelfHealOptions
): CoverSelfHealPlan {
  const plan: CoverSelfHealPlan = { repoints: [], folderResyncs: [] }
  if (!Array.isArray(assets)) return plan

  const libraryDir = typeof opts.libraryDir === 'string' ? opts.libraryDir.trim() : ''
  const canResyncFolder = libraryDir !== ''

  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue
    if (isDeletedAsset(asset)) continue

    // ── A：cover 重指 ────────────────────────────────────────────────
    const source = asset.coverSource
    if (source !== 'manual' && source !== 'zhimo') {
      if (hasCoverAssetFile(asset.files ?? [])) {
        const rel = pickRootCoverRel(asset.files ?? [])
        // rel 为 null = files 索引 kind 脏到 pickCover 认不出（极端边角）：
        // 不重指（宁缺勿错），留给 rescan 修正
        if (rel && rel !== asset.cover) {
          plan.repoints.push({ id: asset.id, rel, source: 'named' })
        }
      }
    }

    // ── C：folder 脱同步重建 ─────────────────────────────────────────
    if (
      canResyncFolder &&
      typeof asset.folder === 'string' &&
      asset.folder.trim() !== '' &&
      typeof asset.relFolder === 'string' &&
      asset.relFolder.trim() !== '' &&
      normalizeFolderPath(asset.folder) !== normalizeFolderPath(expectedAssetFolder(libraryDir, asset.relFolder))
    ) {
      const files: AssetFile[] = Array.isArray(asset.files) ? asset.files : []
      const image = files.find((f: AssetFile) => f.kind === 'texture' || f.kind === 'hdri')
      plan.folderResyncs.push({
        id: asset.id,
        folder: expectedAssetFolder(libraryDir, asset.relFolder),
        probeRel: image && typeof image.rel === 'string' ? image.rel : null
      })
    }
  }

  return plan
}
