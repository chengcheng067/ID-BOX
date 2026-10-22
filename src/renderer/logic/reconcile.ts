/**
 * 库一致性对账（v0.4）：把「索引里的资产」与「磁盘上扫描到的资产」逐条对比。
 *
 * 三条铁律：
 * ① **匹配键必须是 `folder`（绝对路径），不是 `id`**。
 *    主进程 `rescanLibrary()` 每次都给扫描结果生成**新 UUID**（main/rescan.ts），
 *    用 id 匹配会把整库判成「全删 + 全增」——项目里踩过这个坑（store.ts 的 rescan
 *    合并逻辑也写着同样的注释）。
 * ② **磁盘是权威**：`category1/category2` 不一致时以扫描值为准（rescan 的既有语义）。
 * ③ **纯函数、零 IO、不改入参**：本模块只做判定，任何写库动作都留在 store 的
 *    `applyReconcile`（用户勾选后才执行）。
 */
import type { Asset } from '../../shared/types'
import { UNCLASSIFIED } from '../../shared/taxonomy'

export type DiffKind = 'missing-on-disk' | 'not-in-index' | 'category-mismatch'

/** 差异种类 → 中文（UI 统计行 / 列表副标题共用） */
export const DIFF_LABEL: Record<DiffKind, string> = {
  'missing-on-disk': '磁盘上找不到',
  'not-in-index': '未索引',
  'category-mismatch': '分类不一致'
}

export interface DiffItem {
  kind: DiffKind
  /** 绝对路径，**匹配键** */
  folder: string
  name: string
  /** 索引里的资产 id（missing / mismatch 才有） */
  id?: string
  /** 扫描出来的完整对象（not-in-index 才有） */
  scanned?: Asset
  /** 索引里的分类对（mismatch 才有） */
  indexCategory?: [string, string]
  /** 磁盘上的分类对（mismatch 才有） */
  diskCategory?: [string, string]
}

export interface ReconcileReport {
  items: DiffItem[]
  counts: Record<DiffKind, number>
  scannedCount: number
  indexCount: number
}

/** 排序权重：先「磁盘上找不到」（最需要关注），再「未索引」，最后「分类不一致」 */
const KIND_ORDER: Record<DiffKind, number> = {
  'missing-on-disk': 0,
  'not-in-index': 1,
  'category-mismatch': 2
}

/** 分类归一：老记录可能没有 category 字段（缺省语义 = 未分类），与 UI 口径一致 */
function catOf(a: Asset): [string, string] {
  return [a.category1 ?? UNCLASSIFIED, a.category2 ?? UNCLASSIFIED]
}

function sameCategory(a: Asset, b: Asset): boolean {
  const [a1, a2] = catOf(a)
  const [b1, b2] = catOf(b)
  return a1 === b1 && a2 === b2
}

/**
 * 对账：返回三类差异（**不含**「完全一致」的资产）。
 *
 * - `missing-on-disk`：索引有、扫描没有 → 磁盘上被删 / 被移走（→ 建议移除索引）
 * - `not-in-index`：扫描有、索引没有 → 用户手动放进库里的（→ 建议补入索引）
 * - `category-mismatch`：folder 相同但分类字段不同（→ 建议按磁盘值修正）
 *
 * 重复 folder（理论上不该出现）只取第一条，保证结果确定。
 */
export function reconcile(indexAssets: Asset[], scanned: Asset[]): ReconcileReport {
  const indexByFolder = new Map<string, Asset>()
  for (const a of indexAssets) {
    if (!a || typeof a.folder !== 'string' || a.folder === '') continue
    if (!indexByFolder.has(a.folder)) indexByFolder.set(a.folder, a)
  }
  const scannedByFolder = new Map<string, Asset>()
  for (const a of scanned) {
    if (!a || typeof a.folder !== 'string' || a.folder === '') continue
    if (!scannedByFolder.has(a.folder)) scannedByFolder.set(a.folder, a)
  }

  const items: DiffItem[] = []

  // ① 索引有、磁盘没有
  for (const [folder, a] of indexByFolder) {
    if (scannedByFolder.has(folder)) continue
    items.push({ kind: 'missing-on-disk', folder, name: a.name, id: a.id })
  }

  // ② 磁盘有、索引没有
  for (const [folder, a] of scannedByFolder) {
    if (indexByFolder.has(folder)) continue
    items.push({ kind: 'not-in-index', folder, name: a.name, scanned: a })
  }

  // ③ 同一个 folder，分类字段不一致
  for (const [folder, idx] of indexByFolder) {
    const disk = scannedByFolder.get(folder)
    if (!disk) continue
    if (sameCategory(idx, disk)) continue
    items.push({
      kind: 'category-mismatch',
      folder,
      name: idx.name,
      id: idx.id,
      indexCategory: catOf(idx),
      diskCategory: catOf(disk)
    })
  }

  items.sort(
    (x, y) =>
      KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.name.localeCompare(y.name, 'zh')
  )

  const counts: Record<DiffKind, number> = {
    'missing-on-disk': 0,
    'not-in-index': 0,
    'category-mismatch': 0
  }
  for (const it of items) counts[it.kind] += 1

  return {
    items,
    counts,
    scannedCount: scanned.length,
    indexCount: indexAssets.length
  }
}

/** 报告是否为空（UI 用来显示「索引与磁盘一致」而不是执行按钮） */
export function isReconcileClean(report: ReconcileReport): boolean {
  return report.items.length === 0
}
