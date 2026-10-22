/**
 * 回收站策略（P0-16 删除链路 / P0-5 原包处置共用，main 进程专用）。
 *
 * ⚠️ 历史缺陷（2026-10 用户装机反馈「删除模型功能失效」）：
 * 原先直接调用 `trash` npm 包（v10，纯 ESM）。打包后 `trash` 从 **app.asar 内部**
 * 加载，其 `lib/windows.js` 用 `new URL('windows-trash.exe', import.meta.url)`
 * 拼出 **asar 内部路径**，再经 ESM 导入的 `execFile` spawn ——
 * 可执行文件无法从 asar 归档内直接启动（实测报
 * `spawn …app.asar\node_modules\trash\lib\windows-trash.exe ENOENT`），
 * `trash()` 静默 reject → 删除/回收整条链路变成 no-op。
 *
 * 现行策略：
 * ① **首选 `shell.trashItem`**（Electron 内置，无外部可执行文件，asar 内可用，
 *    Windows 上即 SHFileOperation 回收站语义，目录/中文名/含文件均已实测）；
 * ② **兜底 `trash` npm 包**（`shell.trashItem` 不可用的平台，如部分 Linux 桌面；
 *    在开发态（未打包）它本来就工作正常）；
 * ③ 两者都失败才抛出**首选策略的错误**（信息更具体，如"文件被占用"）。
 *
 * 本文件**不 import electron**——策略由调用方（`main/index.ts`）注入，
 * 因此可在 vitest 里直接单测（见 `tests/trashStrategy.test.ts`）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isWithinRoot } from '../shared/vault'
import { uniqueName } from '../shared/naming'

/** 回收站策略的注入点（测试替换；主进程注入 shell.trashItem + trash 包） */
export interface TrashStrategy {
  /** 首选：Electron `shell.trashItem`（打包态唯一可靠路径） */
  trashItem: (fullPath: string) => Promise<void>
  /** 兜底：`trash` npm 包（shell.trashItem 不可用的平台） */
  packageTrash: (fullPath: string) => Promise<void>
}

/**
 * 把单个路径移入回收站：先 `trashItem`，失败再 `packageTrash`；
 * 两者都失败时抛出 **trashItem 的错误**（它是主路径，错误信息更具体）。
 */
export async function trashOne(fullPath: string, strategy: TrashStrategy): Promise<void> {
  let primaryErr: unknown = null
  try {
    await strategy.trashItem(fullPath)
    return
  } catch (err) {
    primaryErr = err
  }
  try {
    await strategy.packageTrash(fullPath)
  } catch {
    // 兜底也失败 → 抛主路径错误（调用方记录的是用户实际该看到的失败原因）
    throw primaryErr
  }
}

/**
 * 批量移入回收站，**返回失败清单**（调用方据此保留索引，而不是静默吞掉）。
 *
 * 单个失败不阻断其余路径（与导入并发语义一致：批量操作尽量部分成功）。
 */
export async function trashPaths(
  paths: readonly string[],
  strategy: TrashStrategy
): Promise<string[]> {
  const failed: string[] = []
  for (const p of paths) {
    try {
      await trashOne(p, strategy)
    } catch {
      failed.push(p)
    }
  }
  return failed
}

// ══════════════════════════════════════════════════════════════════════
// 库内「最近删除」（C 线，docs/20 §4）
//
// 语义：删除 = `rename` 到 `<库根>/.trash/<trashName>/`（同盘 O(1)，不复制），
// 到期 / 超容量 / 手动清空时才 `trashOne` 进系统回收站（双保险）。
//
// 目录约定：
//   <库根>/.trash/<trashName>/            资产目录本体（原样保留，还原即 rename 回去）
//   <库根>/.trash/.meta/<trashName>.json  软删元数据（deletedAt / 原 relFolder / 尺寸）
//
// 为什么元数据放**目录外**：还原时资产目录要原封不动搬回去；meta 在目录内会污染资产。
// 为什么 main 自己记 deletedAt：启动清理发生在渲染进程/Dexie 就绪之前，main 读不到 DB。
// ══════════════════════════════════════════════════════════════════════

/** 库内回收区目录名（`.staging` 同级；**rescan / watcher 必须跳过**） */
export const LIBRARY_TRASH_DIR = '.trash'

/** 回收区元数据子目录（`.` 开头 → 既不被当作回收项，也被 rescan/watcher 跳过） */
const TRASH_META_DIR = '.meta'

/** 回收区总容量上限：5 GB（先到者先清，从最旧的开始） */
export const TRASH_MAX_BYTES = 5 * 1024 * 1024 * 1024

/** 后台清理周期：6 小时（启动时另跑一次） */
export const TRASH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 资产 id 白名单：UUID / 单段安全名（防 `../` 拼出越界目录） */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** 回收区根目录 */
export function trashRootOf(libraryDir: string): string {
  return path.join(libraryDir, LIBRARY_TRASH_DIR)
}

/** `.trash/<trashName>`（posix，与 Asset.trashRel 同口径） */
export function trashRelOfName(trashName: string): string {
  return `${LIBRARY_TRASH_DIR}/${trashName}`
}

/** 名字是否是库内回收区目录（rescan / watcher 的统一排除判定） */
export function isLibraryTrashName(name: string): boolean {
  return name === LIBRARY_TRASH_DIR
}

/** 判断绝对路径是否落在回收区里（含 `.meta`）——watcher 用 */
export function isInsideLibraryTrash(p: string): boolean {
  return p.split(/[\\/]/).includes(LIBRARY_TRASH_DIR)
}

/** 软删元数据（写在 `.trash/.meta/<trashName>.json`） */
export interface TrashMeta {
  id: string
  deletedAt: number
  /** 原始 4 段相对路径（posix），还原时直接用 */
  relFolder: string
  /** 原始资产名（还原重名时据此追加序号） */
  name: string
  /** 估算字节数（容量清理用；rename 前算好，避免移动后再遍历） */
  size: number
}

/** 回收区里的一个条目 */
export interface TrashEntry extends TrashMeta {
  /** `.trash/` 下的目录名（通常 = id；极端重复软删会带时间戳后缀） */
  trashName: string
  abs: string
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 递归统计目录字节数（失败返回 0，不阻断软删） */
export async function dirSizeBytes(root: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const abs = path.join(root, e.name)
    if (e.isDirectory()) {
      total += await dirSizeBytes(abs)
    } else if (e.isFile()) {
      const st = await fs.stat(abs).catch(() => null)
      if (st) total += st.size
    }
  }
  return total
}

function metaPathOf(root: string, trashName: string): string {
  return path.join(root, TRASH_META_DIR, `${trashName}.json`)
}

async function writeMeta(root: string, trashName: string, meta: TrashMeta): Promise<void> {
  await fs.mkdir(path.join(root, TRASH_META_DIR), { recursive: true })
  await fs.writeFile(metaPathOf(root, trashName), JSON.stringify(meta, null, 2), 'utf-8')
}

async function readMeta(root: string, trashName: string): Promise<TrashMeta | null> {
  try {
    const raw = await fs.readFile(metaPathOf(root, trashName), 'utf-8')
    const v = JSON.parse(raw) as Partial<TrashMeta>
    if (typeof v.deletedAt !== 'number' || !Number.isFinite(v.deletedAt)) return null
    return {
      id: typeof v.id === 'string' ? v.id : trashName,
      deletedAt: v.deletedAt,
      relFolder: typeof v.relFolder === 'string' ? v.relFolder : '',
      name: typeof v.name === 'string' ? v.name : trashName,
      size: typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 ? v.size : 0
    }
  } catch {
    return null
  }
}

async function removeMeta(root: string, trashName: string): Promise<void> {
  await fs.rm(metaPathOf(root, trashName), { force: true }).catch(() => {})
}

/** 跨盘退化复制 + 删除（与 `fsutil.moveDir` 同语义，此处内联避免 main 内循环依赖） */
async function moveDirFallback(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
  } catch {
    await fs.cp(src, dest, { recursive: true })
    await fs.rm(src, { recursive: true, force: true })
  }
}

/**
 * 软删：把资产目录**移动**到 `<库根>/.trash/<trashName>/`。
 *
 * 顺序：**先写 meta、再 rename**——
 * - 崩溃在 rename 前：只剩一条无目录的 meta（`listTrashEntries` 会跳过，无害）；
 * - 崩溃在 rename 后：meta 已就位，`deletedAt` 正确。
 * （反过来先 rename 再写 meta，崩溃会留下"无删除时间的孤儿目录"，只能按 mtime 猜。）
 *
 * 同盘即 `rename`（O(1)）；跨盘退化为 `cp + rm`（与导入移动同语义）。
 *
 * @throws 资产 id 非法 / 源目录不存在 / 移动失败（调用方按失败项上报）
 */
export async function moveToLibraryTrash(
  libraryDir: string,
  id: string,
  absPath: string
): Promise<{ trashRel: string; abs: string; deletedAt: number; size: number }> {
  if (!SAFE_ID_RE.test(id)) throw new Error('非法的资产 id')
  const src = path.resolve(absPath)
  const lib = path.resolve(libraryDir)
  if (!isWithinRoot(lib, src, path.sep) || src === lib) throw new Error('资产路径不在库内')
  if (!(await pathExists(src))) throw new Error('资产目录不存在')

  const root = trashRootOf(lib)
  await fs.mkdir(root, { recursive: true })

  // 目标名：id；极端情况（同 id 重复软删 / 上次崩溃残留）追加时间戳避免覆盖
  let trashName = id
  let dest = path.join(root, trashName)
  if (await pathExists(dest)) {
    trashName = `${id}-${Date.now()}`
    dest = path.join(root, trashName)
  }

  const size = await dirSizeBytes(src)
  const deletedAt = Date.now()
  const relFolder = path.relative(lib, src).split(path.sep).join('/')
  const meta: TrashMeta = { id, deletedAt, relFolder, name: path.basename(src), size }

  await writeMeta(root, trashName, meta)
  try {
    await moveDirFallback(src, dest)
  } catch (err) {
    await removeMeta(root, trashName)
    throw err
  }
  return { trashRel: trashRelOfName(trashName), abs: dest, deletedAt, size }
}

/** 从 `.trash/<name>` 取出名字（只接受单段，防越界） */
function trashNameOfRel(trashRel: string): string {
  const segs = trashRel.split('/').filter(Boolean)
  if (segs.length !== 2 || segs[0] !== LIBRARY_TRASH_DIR) throw new Error('非法 trashRel')
  const name = segs[1]!
  if (!SAFE_ID_RE.test(name)) throw new Error('非法 trashRel')
  return name
}

/**
 * 还原：把 `.trash/<name>/` 搬回原路径。
 *
 * - 原分类目录不存在 → `mkdir -p` 重建（磁盘是真相，不查词表）；
 * - 目标位置已被同名资产占用 → `uniqueName` 追加 `-2/-3`，**`renamed=true` 必须提示用户**；
 * - 返回的 `folder` / `relFolder` 是**最终落盘值**，调用方照抄写库。
 */
export async function restoreFromLibraryTrash(
  libraryDir: string,
  item: { trashRel: string; relFolder: string; name: string }
): Promise<{ folder: string; relFolder: string; renamed: boolean }> {
  const lib = path.resolve(libraryDir)
  const root = path.resolve(trashRootOf(lib))
  const trashName = trashNameOfRel(item.trashRel)
  const src = path.join(root, trashName)
  if (!isWithinRoot(root, path.resolve(src), path.sep) || path.resolve(src) === root) {
    throw new Error('非法 trashRel')
  }
  const st = await fs.stat(src).catch(() => null)
  if (!st || !st.isDirectory()) throw new Error('回收区里没有该资产')

  const rel = (item.relFolder ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) throw new Error('缺少原始路径')
  const target = path.resolve(lib, rel.split('/').join(path.sep))
  if (!isWithinRoot(lib, target, path.sep) || target === lib) throw new Error('原始路径越界')
  await fs.mkdir(path.dirname(target), { recursive: true })

  let finalFolder = target
  let finalRel = rel
  let renamed = false
  if (await pathExists(target)) {
    const parent = path.dirname(target)
    const taken = await fs.readdir(parent).catch(() => [] as string[])
    const nextName = uniqueName(item.name || path.basename(target), new Set(taken))
    finalFolder = path.join(parent, nextName)
    const segs = rel.split('/')
    segs[segs.length - 1] = nextName
    finalRel = segs.join('/')
    renamed = true
  }

  await moveDirFallback(src, finalFolder)
  await removeMeta(root, trashName)
  return { folder: finalFolder, relFolder: finalRel, renamed }
}

/**
 * 彻底删除某一项：`.trash/<name>` → **系统回收站**（双保险：清空后仍能从 Windows 捞回）。
 *
 * 只允许操作回收区内的路径（防渲染层传任意路径把库文件删掉）。
 */
export async function purgeToRecycleBin(
  libraryDir: string,
  trashRel: string,
  strategy: TrashStrategy
): Promise<void> {
  const lib = path.resolve(libraryDir)
  const root = path.resolve(trashRootOf(lib))
  const trashName = trashNameOfRel(trashRel)
  const abs = path.resolve(path.join(root, trashName))
  if (!isWithinRoot(root, abs, path.sep) || abs === root) throw new Error('非法 trashRel')
  await trashOne(abs, strategy)
  await removeMeta(root, trashName)
}

/** 列出回收区全部条目（无 meta 的目录按 mtime 兜底，保证不会永久泄漏） */
export async function listTrashEntries(libraryDir: string): Promise<TrashEntry[]> {
  const root = trashRootOf(libraryDir)
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return []
  }
  const out: TrashEntry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue // `.meta`
    const abs = path.join(root, name)
    const st = await fs.stat(abs).catch(() => null)
    if (!st || !st.isDirectory()) continue
    const meta = await readMeta(root, name)
    out.push({
      trashName: name,
      abs,
      id: meta?.id ?? name,
      deletedAt: meta?.deletedAt ?? st.mtimeMs,
      relFolder: meta?.relFolder ?? '',
      name: meta?.name ?? name,
      size: meta?.size ?? (await dirSizeBytes(abs))
    })
  }
  return out
}

/**
 * 清空整个回收区（逐个 `trashOne`，单个失败不阻断其余）。返回成功/失败数。
 */
export async function emptyLibraryTrash(
  libraryDir: string,
  strategy: TrashStrategy
): Promise<{ purged: number; failed: number; bytes: number; failures: Array<{ id: string; reason: string }> }> {
  const entries = await listTrashEntries(libraryDir)
  let purged = 0
  let bytes = 0
  const failures: Array<{ id: string; reason: string }> = []
  for (const e of entries) {
    try {
      await purgeToRecycleBin(libraryDir, trashRelOfName(e.trashName), strategy)
      purged += 1
      bytes += e.size
    } catch (err) {
      failures.push({ id: e.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { purged, failed: failures.length, bytes, failures }
}

/**
 * 到期 / 超容量清理（启动时 + 每 6 小时 + 手动触发共用）。
 *
 * ① 先清**过期**（`deletedAt` 早于保留期）；
 * ② 剩下的按 `deletedAt` **升序**清，直到总量 ≤ `maxBytes`（默认 5GB）。
 *
 * `retentionDays <= 0`（= `'recycle'` 档）跳过①，只做容量兜底——
 * 用户从别的档位切过来时，历史 `.trash` 残留仍会被容量策略收掉，不会永久泄漏。
 *
 * 注意：进的是**系统回收站**，所以磁盘空间要等用户清空回收站才真正释放。
 */
export async function sweepExpired(
  libraryDir: string,
  retentionDays: number,
  maxBytes: number,
  strategy: TrashStrategy
): Promise<{ purged: number; failed: number; bytes: number }> {
  const entries = await listTrashEntries(libraryDir)
  const now = Date.now()
  const ttlMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0

  let purged = 0
  let failed = 0
  let bytes = 0
  const survivors: TrashEntry[] = []

  for (const e of entries) {
    if (ttlMs > 0 && now - e.deletedAt >= ttlMs) {
      try {
        await purgeToRecycleBin(libraryDir, trashRelOfName(e.trashName), strategy)
        purged += 1
        bytes += e.size
      } catch {
        failed += 1
      }
    } else {
      survivors.push(e)
    }
  }

  let total = survivors.reduce((s, e) => s + e.size, 0)
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : TRASH_MAX_BYTES
  for (const e of [...survivors].sort((a, b) => a.deletedAt - b.deletedAt)) {
    if (total <= cap) break
    try {
      await purgeToRecycleBin(libraryDir, trashRelOfName(e.trashName), strategy)
      total -= e.size
      purged += 1
      bytes += e.size
    } catch {
      failed += 1
    }
  }

  return { purged, failed, bytes }
}
