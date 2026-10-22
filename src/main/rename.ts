import fs from 'node:fs/promises'
import path from 'node:path'
import { isWithinRoot } from '../shared/vault'
import { isReservedFolderName } from '../shared/renameTemplate'
import { pathExists } from './fsutil'
import type {
  RenameFolderFailure,
  RenameFolderOk,
  RenameFolderPlanItem,
  RenameFoldersResult
} from '../shared/types'

/**
 * 批量重命名资产文件夹（0.6.0，docs/22 §3.4）——**本项目风险最高的磁盘动作**。
 *
 * 四条安全规则（缺一不可）：
 * ① **只改名、不搬家**：目标父目录必须与源父目录完全一致（`to` 只能是单段名）。
 *    否则一次模板写错就能把 50 个资产搬进别的分类目录，而 `relFolder` 只换末段的
 *    渲染层逻辑会立刻和磁盘脱节；
 * ② **先整体预检，再动第一个字节**：越界 / 目标已存在 / 源不是目录 / 保留设备名 /
 *    批内重名 → 全部在预检阶段拒掉，磁盘零改动（`renamed: []`）；
 * ③ **任何一条执行失败 → 反向回滚已成功的**，让磁盘回到调用前的状态，
 *    而不是留下"改了一半"的库（用户看到 20 个改了 30 个没改会彻底没法收拾）；
 * ④ **不覆盖**：`fs.rename` 在 Windows 上遇到已存在的目标目录会失败，但跨盘退化
 *    的 `fs.cp` 默认会**合并进**已有目录并删源 —— 这是本文件必须自定义 `moveWithFallback`
 *    而不是直接复用 `fsutil.moveDir` 的原因（`errorOnExist + force:false`）。
 *
 * ⚠️ 不走 `uniqueName` 自动加序号：批量改名的语义是"用户看过的预览就是最终结果"，
 * 偷偷改成 `名字-2` 会让预览表与实际落盘不一致。冲突一律拒绝，让用户改模板。
 */

/** 依赖注入点（测试用来模拟"第 N 条失败"，生产不传） */
export interface RenameAssetFolderDeps {
  /** 库根目录绝对路径（所有源/目标都必须落在它里面） */
  libraryDir: string
  /**
   * 移动实现，默认 `moveWithFallback`。
   * 测试注入一个在第 N 次调用抛错的实现，即可验证回滚路径。
   */
  move?: (src: string, dest: string) => Promise<void>
}

/**
 * 目录移动：同盘 `fs.rename`（原子、O(1)）；跨盘退化为 cp + rm。
 *
 * cp 必须带 `errorOnExist: true` + `force: false`：目标已存在时**抛错**，
 * 而不是把源合并进目标目录再删源（那等于静默丢结构）。
 */
async function moveWithFallback(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
    return
  } catch (err) {
    // 目标被抢占（并发/外部程序）→ 直接失败，绝不合并
    if (await pathExists(dest)) {
      throw new Error(`目标已存在同名目录：${path.basename(dest)}`)
    }
    // 源不存在 / 无权访问这类错误不必再 cp 一次，直接上报原始原因
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
    await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(src, { recursive: true, force: true })
  }
}

/** 规范化比较键：Windows 大小写不敏感，且末尾分隔符不该影响判定 */
function compareKey(p: string): string {
  const resolved = path.resolve(p)
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved
  return process.platform === 'win32' || process.platform === 'darwin'
    ? trimmed.toLowerCase()
    : trimmed
}

interface ReadyStep {
  id: string
  from: string
  to: string
  name: string
}

/**
 * 执行批量改名。
 *
 * 返回值的三段语义见 `RenameFoldersResult` 的注释；正常失败路径一定是
 * `{ renamed: [], failed: [...], rolledBack: true }`（磁盘零改动）。
 */
export async function renameAssetFolders(
  plan: readonly RenameFolderPlanItem[],
  deps: RenameAssetFolderDeps
): Promise<RenameFoldersResult> {
  const move = deps.move ?? moveWithFallback
  const root = path.resolve(deps.libraryDir)
  const items = Array.isArray(plan) ? plan : []

  const failed: RenameFolderFailure[] = []
  const steps: ReadyStep[] = []
  /** 目标路径 → 首个占用它的 item id（批内重名检测） */
  const takenTargets = new Map<string, string>()
  /** 源路径集合：用于区分"目标被别人占用"与"目标就是本批另一个源"（后者同样拒绝，见下） */
  const sourceKeys = new Set<string>()
  /** 已受理的源（同一资产被重复计划两次 → 第二条会因"源已消失"失败并触发回滚，提前拒掉） */
  const plannedSources = new Set<string>()

  // ── 阶段 0：源路径集合（先收齐，避免顺序依赖） ──────────────────────
  for (const item of items) {
    if (typeof item?.folder === 'string' && item.folder.length > 0) {
      sourceKeys.add(compareKey(item.folder))
    }
  }

  // ── 阶段 1：逐条预检（**零 IO 写入**） ──────────────────────────────
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : ''
    const rawFolder = typeof item?.folder === 'string' ? item.folder : ''
    const rawName = typeof item?.to === 'string' ? item.to.trim() : ''

    if (!id || !rawFolder) {
      failed.push({ id: id || '(空 id)', reason: '入参不完整（缺少 id 或 folder）' })
      continue
    }
    if (!rawName) {
      failed.push({ id, reason: '新名字为空' })
      continue
    }
    // 必须是单段名：模板里残留的 `/`、`..`、盘符一律拒绝（防越界与"改名变搬家"）
    if (/[\\/]/.test(rawName) || rawName === '.' || rawName === '..') {
      failed.push({ id, reason: `新名字含路径分隔符或非法段：${rawName}` })
      continue
    }
    if (isReservedFolderName(rawName)) {
      failed.push({ id, reason: `新名字是 Windows 保留名：${rawName}` })
      continue
    }

    const src = path.resolve(rawFolder)
    if (!isWithinRoot(root, src, path.sep)) {
      failed.push({ id, reason: '源目录不在库目录内（已拒绝）' })
      continue
    }
    const parent = path.dirname(src)
    const dest = path.join(parent, rawName)
    if (!isWithinRoot(root, dest, path.sep)) {
      failed.push({ id, reason: '目标路径越界（已拒绝）' })
      continue
    }
    // ① 只改名，不搬家
    if (path.dirname(dest) !== parent) {
      failed.push({ id, reason: '目标不在同一父目录（本功能只改名，不移动资产）' })
      continue
    }

    // 新旧同名：不报错、不执行（调用方通常已过滤，这里兜底）
    if (path.resolve(src) === path.resolve(dest)) continue

    const srcKey = compareKey(src)
    if (plannedSources.has(srcKey)) {
      failed.push({ id, reason: '同一资产在本批里出现了两次（已拒绝）' })
      continue
    }

    const destKey = compareKey(dest)
    const owner = takenTargets.get(destKey)
    if (owner) {
      failed.push({ id, reason: `与本批另一个资产的改名目标重名：${rawName}` })
      continue
    }
    // 目标恰好是本批另一个资产的源目录：批内换名（A↔B）需要临时名中转，
    // 第一版直接拒绝 —— 比"改坏一半再回滚"安全得多，且极少见。
    if (sourceKeys.has(destKey)) {
      failed.push({ id, reason: `目标名与本批另一个资产的现有目录重名：${rawName}` })
      continue
    }

    // ② 目标已存在 → 拒绝（绝不覆盖、绝不自动加序号：预览表必须等于落盘结果）
    if (await pathExists(dest)) {
      failed.push({ id, reason: `已存在同名目录：${rawName}` })
      continue
    }

    // 源必须是真实目录（被外部删掉/改名的情况在这里暴露，而不是让 rename 抛 ENOENT）
    const st = await fs.stat(src).catch(() => null)
    if (!st) {
      failed.push({ id, reason: '源目录不存在（磁盘可能已被外部改动，请重新扫描）' })
      continue
    }
    if (!st.isDirectory()) {
      failed.push({ id, reason: '源路径不是目录' })
      continue
    }

    takenTargets.set(destKey, id)
    plannedSources.add(srcKey)
    steps.push({ id, from: src, to: dest, name: rawName })
  }

  // 预检有任意失败 → **整批不执行**（磁盘零改动），把全部原因一次性回报。
  // 理由：改名计划是"用户看过预览的一整批"，只做一半比什么都不做更难收拾。
  if (failed.length > 0 || steps.length === 0) {
    return { renamed: [], failed, rolledBack: false }
  }

  // ── 阶段 2：逐条执行；任何失败 → 反向回滚 ────────────────────────────
  const done: ReadyStep[] = []
  for (const step of steps) {
    try {
      await move(step.from, step.to)
      done.push(step)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push({ id: step.id, reason: `改名失败：${reason}` })

      // 反向回滚（**逆序**：A→B、B→C 这种链式改名必须先撤后一条）
      let rolledBack = true
      const stillRenamed: ReadyStep[] = []
      for (const finished of [...done].reverse()) {
        try {
          await move(finished.to, finished.from)
        } catch (rbErr) {
          rolledBack = false
          stillRenamed.unshift(finished)
          failed.push({
            id: finished.id,
            reason: `回滚失败：磁盘仍是新名字「${finished.name}」，请重新扫描库以对齐索引（${
              rbErr instanceof Error ? rbErr.message : String(rbErr)
            }）`
          })
        }
      }
      const renamed: RenameFolderOk[] = stillRenamed.map((s) => ({
        id: s.id,
        folder: s.to,
        name: s.name
      }))
      return { renamed, failed, rolledBack }
    }
  }

  return {
    renamed: done.map((s) => ({ id: s.id, folder: s.to, name: s.name })),
    failed: [],
    rolledBack: false
  }
}
