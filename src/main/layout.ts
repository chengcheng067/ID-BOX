import fs from 'node:fs/promises'
import path from 'node:path'
import { composeRelFolder, uniqueName } from '../shared/naming'
import { UNCLASSIFIED } from '../shared/taxonomy'
import { kindFolder } from '../shared/classify'
import type { Asset, LayoutApplyResult, LayoutMove } from '../shared/types'

/**
 * 磁盘侧遗留布局迁移（T06，06 §10.2 末尾 / 03 §4.4，目标路径改为 **4 段双哨兵**）。
 *
 * **DB 驱动，不用磁盘启发式**：Dexie 里 `relFolder` 段数 ≠ 4 的记录就是遗留记录，不需要猜。
 * 精确、可枚举、可预演、可跳过失败。
 *
 * 目标：`<大类>/未分类/未分类/<资产名>`。
 * 计划/执行/幂等规格沿袭 03 §4.4（DB 驱动、>50 条改手动触发、失败跳过汇总），仅目标路径变。
 */

export interface LayoutPlan {
  moves: LayoutMove[]
  /** 无需迁移的记录 id（已是 4 段，或数据不足以算出目标） */
  skipped: string[]
}

/**
 * 生成迁移计划（**纯函数，零 IO**）。
 *
 * - `relFolder` 恰为 4 段 → 已是规范布局，skip（**跑两次计划结果相同 = 幂等**）
 * - 其余（两段遗留、三段草稿）→ 目标 `<kindFolder(kind)>/未分类/未分类/<name>`
 *   材质大类合并后 `kindFolder` 对 `texture` / `material` 都返回「材质」
 *   （两种 kind 可能落同一个目录，这是设计而非 bug，见 docs/14 §2.1）
 * - `folder` 缺失 / `kind` 无法映射到大类目录 → skip（无 IO，无法核实磁盘，交给 apply 上报）
 *
 * 注意：目标是**计划值**；若目标已存在同名目录，由 `applyLayoutMigration` 用 `uniqueName` 追加序号，永不覆盖。
 */
export function planLayoutMigration(
  assets: Array<Pick<Asset, 'id' | 'folder' | 'relFolder' | 'kind' | 'name'>>,
  libraryDir: string
): LayoutPlan {
  const moves: LayoutMove[] = []
  const skipped: string[] = []
  for (const a of assets) {
    const segs = (a.relFolder ?? '').split('/').filter((s) => s.length > 0)
    if (segs.length === 4) {
      skipped.push(a.id)
      continue
    }
    const kindName = kindFolder(a.kind)
    if (!a.folder || !kindName || !a.name) {
      skipped.push(a.id)
      continue
    }
    const relFolder = composeRelFolder(kindName, UNCLASSIFIED, UNCLASSIFIED, a.name)
    moves.push({
      id: a.id,
      from: a.folder,
      to: path.join(libraryDir, kindName, UNCLASSIFIED, UNCLASSIFIED, a.name),
      relFolder
    })
  }
  return { moves, skipped }
}

/**
 * 执行迁移：同盘 `fs.rename` 原子操作（源与目标都在 libraryDir 下）。
 * **永不覆盖**：目标已存在 → `uniqueName` 追加 `-2/-3`（与导入一致）。
 *
 * ⚠️ 不退化成 cp+rm（`fsutil.moveDir` 会）：库内必然同盘，跨盘报错意味着路径算错了，应当暴露。
 */
export async function applyLayoutMigration(moves: LayoutMove[]): Promise<LayoutApplyResult> {
  // T08：`ok` 回传**最终落盘值**的 LayoutMove（目标重名被追加序号后与计划值不同），
  // 渲染层按下轮 rescan 前就能把索引写对。
  const ok: LayoutMove[] = []
  const failed: Array<{ id: string; reason: string }> = []

  for (const move of moves) {
    try {
      // self-target 守卫：源与目标是同一路径 → 幂等 no-op（不需要动，也不算失败）
      if (path.resolve(move.from) === path.resolve(move.to)) {
        ok.push({ ...move })
        continue
      }
      let st
      try {
        st = await fs.stat(move.from)
      } catch {
        failed.push({ id: move.id, reason: '源目录不存在（磁盘已变动，请重新扫描）' })
        continue
      }
      if (!st.isDirectory()) {
        failed.push({ id: move.id, reason: '源路径不是目录' })
        continue
      }

      let dest = move.to
      const parent = path.dirname(dest)
      await fs.mkdir(parent, { recursive: true })
      let siblings: string[] = []
      try {
        siblings = await fs.readdir(parent)
      } catch {
        siblings = []
      }
      const base = path.basename(dest)
      const final = uniqueName(base, new Set(siblings))
      // relFolder 只有**末段**（资产名）会因追加序号而变，父链（大类/未分类/未分类）不变
      let finalRel = move.relFolder
      if (final !== base) {
        dest = path.join(parent, final)
        const relSegs = move.relFolder.split('/')
        relSegs[relSegs.length - 1] = final
        finalRel = relSegs.join('/')
      }

      await fs.rename(move.from, dest)
      ok.push({ ...move, to: dest, relFolder: finalRel })
    } catch (err) {
      failed.push({
        id: move.id,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { ok, failed }
}

export interface MoveCategoryResult {
  /** 移动后的资产绝对路径（可能因重名冲突追加了序号）；self-target 时原样返回 */
  folder: string
  /** 移动后的资产名 */
  name: string
  /** true = 实际执行了移动；false = 资产已在目标分类下（self-target no-op，T08 守卫） */
  moved: boolean
  /** true = 目标已存在同名目录，按 uniqueName 追加了序号（调用方据此提示用户） */
  renamed: boolean
}

/**
 * 指派分类时的目录移动（03 §5.1，`asset:assignCategory` 的落盘动作）。
 *
 * **父目录永远由 `asset.kind` 算**（main 不信任渲染层传来的完整路径），
 * 保证不变量 `folder === libraryDir/kindFolder(kind)/category1/category2/name` 永远成立。
 * 材质大类合并后 `kindFolder(texture) === kindFolder(material) === '材质'`——「两种 kind 同目录」
 * 是本次设计的结果（kind 降级为属性），不变量本身不变。
 * 同盘 `fs.rename` 原子操作，失败原路返回；目标已存在 → `uniqueName` 追加序号，**永不覆盖**。
 *
 * ⚠️ 缩略图重生（RA3）由调用方负责：缩略图 salt 由**封面路径 + mtime + 尺寸**算出
 * （`thumbFileSalt`，2026-10-22 起不再只是路径哈希），移动后 coverAbs 变 → salt 必变，必须
 * `ensureThumb(新 coverAbs)` + `matchThumbNames` 通配删旧，**先生成后删除**。
 */
export async function moveAssetCategory(
  folder: string,
  parentDir: string
): Promise<MoveCategoryResult> {
  const name = path.basename(folder)
  // ── T08 self-target 守卫（真 bug） ─────────────────────────────
  // 对「已在目标分类」的资产再指派同分类时，readdir(parentDir) 会读到资产自己的目录名，
  // uniqueName 误判重名 → 资产被无谓改名成「名字-2」。
  // 渲染层 UI 侧已跳过这种情况，但 main 侧必须自己防（不能依赖调用方自觉）。
  if (path.resolve(path.dirname(folder)) === path.resolve(parentDir)) {
    return { folder, name, moved: false, renamed: false }
  }
  await fs.mkdir(parentDir, { recursive: true })
  let siblings: string[] = []
  try {
    siblings = await fs.readdir(parentDir)
  } catch {
    siblings = []
  }
  const final = uniqueName(name, new Set(siblings))
  const dest = path.join(parentDir, final)
  // 不退化成 cp+rm：库内必然同盘，跨盘报错意味着路径算错了，应当暴露
  await fs.rename(folder, dest)
  return { folder: dest, name: final, moved: true, renamed: final !== name }
}
