/**
 * 钉选根**内部隐藏回收区**（v1.2 网络盘删除兜底）。
 *
 * ## 为什么不能复用 `main/trash.ts` 的库内回收区
 *
 * 用户库在 `E:\ModVault\Library`（本地盘），钉选根在 `Y:\...`（`\\192.168.5.3`
 * 网络映射盘，DriveType 4）。Windows **系统回收站对网络盘无效**：实测本地盘
 * `shell.trashItem` 成功，网络盘目录/文件一律 `Failed to perform delete operation`。
 * 而库内 `.trash` 在 E:，把 Y: 的条目挪过去必然 EXDEV → `fsutil.moveDir` 退化成
 * `cp + rm`（非原子、大文件夹慢、中途崩溃会丢数据）。
 *
 * 所以回收区必须建在**钉选根内部同盘**：`<pinRoot>/.idbox-trash/<token>/`，
 * 删除就是一次 `fs.rename`（O(1) 原子），撤销就是反向 rename。
 *
 * ## 目录约定
 *
 * ```
 * <pinRoot>/.idbox-trash/<token>/              条目本体（文件 / 目录原样保留）
 * <pinRoot>/.idbox-trash/.meta/<token>.json    元数据（点开头，防浏览器/扫描器枚举）
 * ```
 *
 * `token` 用 `randomUUID()`，**绝不**用原始中文名当路径段；白名单
 * `/^[0-9a-f-]{36}$/` 挡 `..` / 绝对路径 / 盘符切换。`.idbox-trash` 自身也以 `.`
 * 开头，`pinnedDirGuard#readDirEntries`、`rescan.ts`、`watcher.ts` 都会跳过它，
 * 用户正常浏览看不到回收区（长期入口走 `fs:listPinnedTrash`）。
 *
 * ## 铁律
 *
 * **绝不永久删除**：本文件没有任何 `fs.rm` / `unlink` 用户条目的路径；
 * 只清理自己写的 meta 文件（`fs.unlink`），且仅在移动成功之后。
 * 跨根（不同盘符）一律抛中文错，绝不静默退化成跨卷 cp + rm。
 *
 * 纯 Node + shared 模块，**不 import electron** —— vitest 可直测。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PinnedTrashEntry } from '../shared/ipc'
import { isWithinRoot } from '../shared/vault'
import { validateEntryName } from './archiveOps'
import { moveDir } from './fsutil'
import { resolveWithinPinRoot } from './pinnedDirGuard'
import { dirSizeBytes } from './trash'

/** 隐藏回收区目录名（钉选根内部，与钉选根同盘） */
export const PINNED_TRASH_DIR = '.idbox-trash'

/** 元数据子目录（点开头 → 浏览器 / rescan / watcher 都跳过） */
const META_DIR = '.meta'

/** token 白名单：只放行 UUID 形式，防穿越与非法路径段 */
const TOKEN_RE = /^[0-9a-f-]{36}$/

/** 回收区根目录（绝对路径） */
function trashRootOf(pinRoot: string): string {
  return path.join(path.resolve(pinRoot), PINNED_TRASH_DIR)
}

/** `<root>/.meta/<token>.json` */
function metaPathOf(root: string, token: string): string {
  return path.join(root, META_DIR, `${token}.json`)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 只删**自己写的 meta**，绝不碰用户条目（故用 unlink，不用 rm） */
async function removeMeta(root: string, token: string): Promise<void> {
  try {
    await fs.unlink(metaPathOf(root, token))
  } catch {
    // meta 本来就不存在 / 已被清掉：幂等收口
  }
}

/**
 * 源与目标必须同根（同盘）。不同根直接抛 —— 否则 `moveDir` 会走 EXDEV 的
 * `cp + rm` 退化，既非原子又违背「回收区必须与钉选根同盘」的设计。
 */
function assertSameDrive(src: string, dest: string): void {
  const srcRoot = path.parse(src).root
  const destRoot = path.parse(dest).root
  if (srcRoot.toLowerCase() !== destRoot.toLowerCase()) {
    throw new Error(`不能跨盘移动回收条目（${srcRoot} → ${destRoot}）`)
  }
}

/**
 * 还原遇到同名占用时的**本地**防重名逻辑：序号插在**扩展名之前**。
 *
 * 为什么不用全局 `uniqueName`（库内资产恢复仍用它）：那是给**目录名**设计的，
 * 末尾追加会得到 `材质贴图.png-2` —— Windows 按最后的扩展名识别类型，
 * 用户还原出来的 PNG 变成不认识的 `-2` 文件、直接打不开。
 * 本 helper 只对**文件**拆最后一段扩展名（`path.extname` 语义），
 * 目录 / 无扩展名 / 点文件（`.gitignore`）维持末尾追加，行为与原来一致。
 * 多段后缀（`.tar.gz`）只处理最后一段，够用。
 *
 * @param base 原始单段名（已过 `validateEntryName`）
 * @param taken 目标目录现有名字集合
 * @param isDirectory 目录不拆扩展名，保持原来的末尾追加语义
 */
function uniqueRestoreName(base: string, taken: Set<string>, isDirectory: boolean): string {
  const ext = isDirectory ? '' : path.extname(base)
  const stem = ext.length > 0 ? path.basename(base, ext) : base
  const candidateAt = (i: number): string => `${stem}-${i}${ext}`
  let i = 2
  let candidate = candidateAt(i)
  // 占用可能连号（-2/-3 都被用户手动放过），继续递增直到空位
  while (taken.has(candidate)) {
    i += 1
    candidate = candidateAt(i)
  }
  return candidate
}

/**
 * 读 meta；坏 meta（缺字段 / 类型不符 / token 不匹配）返回 null，绝不抛。
 */
async function readMeta(root: string, token: string): Promise<PinnedTrashEntry | null> {
  try {
    const raw = await fs.readFile(metaPathOf(root, token), 'utf-8')
    const v = JSON.parse(raw) as Partial<PinnedTrashEntry>
    if (typeof v.deletedAt !== 'number' || !Number.isFinite(v.deletedAt)) return null
    if (typeof v.name !== 'string' || v.name.length === 0) return null
    if (typeof v.relFolder !== 'string') return null
    if (typeof v.size !== 'number' || !Number.isFinite(v.size) || v.size < 0) return null
    if (typeof v.isDirectory !== 'boolean') return null
    return {
      token,
      name: v.name,
      relFolder: v.relFolder,
      deletedAt: v.deletedAt,
      size: v.size,
      isDirectory: v.isDirectory
    }
  } catch {
    return null
  }
}

/**
 * 把钉选根 `dirRel` 下一个单段条目**原子移动**到同盘隐藏回收区。
 *
 * 顺序：**先写 meta、后 rename**（与 `trash.ts#moveToLibraryTrash` 同理由）：
 * - 崩在 rename 前：只剩一条无本体的 meta，`listPinnedTrash` 不会因此损坏；
 * - 崩在 rename 后：meta 已就位，`deletedAt` 准确。
 * rename 失败会回滚刚写的 meta，不留孤儿 meta。
 *
 * @throws 条目名非法 / 回收区名 / 越界 / 源不存在 / 跨盘 / 移动失败
 */
export async function moveToPinnedTrash(
  pinRoot: string,
  dirRel: string,
  name: string
): Promise<PinnedTrashEntry> {
  const bad = validateEntryName(name)
  if (bad !== null) throw new Error(bad)
  // 回收区自己不能被删掉（连根端掉 = 所有可恢复条目永久丢失）
  if (name === PINNED_TRASH_DIR) throw new Error('不能删除回收站本身')

  const guard = resolveWithinPinRoot(pinRoot, dirRel)
  if (!guard.ok) throw new Error(guard.error)

  const src = path.join(guard.absPath, name)
  const st = await fs.lstat(src).catch(() => null)
  if (st === null) throw new Error('文件或文件夹不存在，可能已被移动')
  // 符号链接可能指向钉选根之外；浏览器本来就不列出软链，这里同样拒收
  if (st.isSymbolicLink()) throw new Error('不支持删除快捷方式或链接')

  const root = trashRootOf(pinRoot)
  // relFolder 用「从钉选根算起的真实相对路径」，避免 dirRel 里的 . / .. / 反斜杠污染 meta
  const relFolder = path.relative(path.resolve(pinRoot), guard.absPath).split(path.sep).join('/')
  const isDirectory = st.isDirectory()
  const size = isDirectory ? await dirSizeBytes(src) : st.size

  // token 冲突（极低概率 / 上次崩溃残留）时再生成一次，绝不覆盖已有条目
  let token = randomUUID()
  let dest = path.join(root, token)
  while (await pathExists(dest)) {
    token = randomUUID()
    dest = path.join(root, token)
  }
  // 跨盘断言必须在写 meta 之前：抛错时磁盘上什么都不该留下
  assertSameDrive(src, dest)

  const entry: PinnedTrashEntry = {
    token,
    name,
    relFolder,
    deletedAt: Date.now(),
    size,
    isDirectory
  }

  await fs.mkdir(path.join(root, META_DIR), { recursive: true })
  await fs.writeFile(metaPathOf(root, token), JSON.stringify(entry, null, 2), 'utf-8')
  try {
    await moveDir(src, dest)
  } catch (err) {
    await removeMeta(root, token)
    throw err
  }
  return entry
}

/**
 * 列出隐藏回收区的全部可恢复条目，按 `deletedAt` **倒序**（最新在前）。
 *
 * 只读 `.meta/*.json`：单个坏 meta（截断 / 旧版本 / 手改）跳过不抛，
 * 不影响其余条目展示。回收区不存在（还没有网络盘删除）返回空数组。
 *
 * 还会跳过**幽灵 meta**：还原成功后本体已 rename 回原位置，但网络盘上
 * `fs.unlink` 因占用 / SMB 抖动失败，meta 残留下来。只跳过展示、**不删 meta**
 * （网络盘删除不可靠，且铁律是绝不永久删除用户数据；孤儿 meta 留着无害）。
 */
export async function listPinnedTrash(pinRoot: string): Promise<PinnedTrashEntry[]> {
  const root = trashRootOf(pinRoot)
  let files: string[]
  try {
    files = await fs.readdir(path.join(root, META_DIR))
  } catch {
    return []
  }
  const out: PinnedTrashEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const token = file.slice(0, -'.json'.length)
    if (!TOKEN_RE.test(token)) continue
    const meta = await readMeta(root, token)
    if (meta === null) continue
    // 幽灵 meta：本体已不在回收区（多为还原成功后 unlink meta 失败），
    // 点了也还原不了，不能展示给用户；但**不删 meta 文件**，留给以后可靠时清理。
    if (!(await pathExists(path.join(root, token)))) continue
    out.push(meta)
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt)
  return out
}

/**
 * 按 token 把隐藏回收区条目**真实还原**回原目录（同盘 rename，O(1)）。
 *
 * - 原目录不存在 → `mkdir -p` 重建（磁盘是真相）；
 * - 目标已被占用 → `uniqueRestoreName` 在扩展名前追加 `-2/-3`，返回 `renamed:true`；
 * - 文件与目录都支持（不沿用 `restoreFromLibraryTrash` 的目录硬判定）；
 * - **rename 失败不删 meta** —— 数据还在回收区，用户可重试。
 *
 * @throws token 非法 / 记录或本体不存在 / 原始路径越界 / 跨盘 / 移动失败
 */
export async function restorePinnedTrash(
  pinRoot: string,
  token: string
): Promise<{ name: string; relFolder: string; renamed: boolean }> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new Error('无效的回收编号，无法还原')
  }
  const base = path.resolve(pinRoot)
  const root = trashRootOf(base)
  const meta = await readMeta(root, token)
  if (meta === null) throw new Error('回收区里没有这条记录，可能已被清理')

  const src = path.join(root, token)
  if (!(await pathExists(src))) throw new Error('回收区里的文件已不存在，可能已被移动')
  const bad = validateEntryName(meta.name)
  if (bad !== null) throw new Error('回收记录里的原始名称不合法，无法还原')

  // meta 里的 relFolder 完全不可信（可能被手改）：resolve 后必须仍在钉选根内
  const segs = meta.relFolder.split('/').filter(Boolean)
  const targetDir = path.resolve(base, segs.join(path.sep))
  if (!isWithinRoot(base, targetDir, path.sep)) throw new Error('原始路径不在该文件夹内')
  const target = path.join(targetDir, meta.name)
  if (!isWithinRoot(base, target, path.sep)) throw new Error('原始路径不在该文件夹内')
  assertSameDrive(src, target)

  await fs.mkdir(targetDir, { recursive: true })

  // relFolder 是「原所在目录」（契约：'' = 钉选根），**不含条目名**；
  // 重名时只有 name 变，relFolder 保持不变，渲染层按 name 显示新名字。
  const finalRelFolder = segs.join('/')
  let finalTarget = target
  let renamed = false
  if (await pathExists(target)) {
    const taken = await fs.readdir(targetDir).catch(() => [] as string[])
    const nextName = uniqueRestoreName(meta.name, new Set(taken), meta.isDirectory)
    finalTarget = path.join(targetDir, nextName)
    renamed = true
  }

  await moveDir(src, finalTarget)
  // 只在移动成功后清 meta；失败时记录仍在，可原样重试
  await removeMeta(root, token)
  return { name: path.basename(finalTarget), relFolder: finalRelFolder, renamed }
}
