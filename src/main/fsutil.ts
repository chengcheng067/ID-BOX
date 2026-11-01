import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AssetFile } from '../shared/types'
import { IGNORED_NAMES, isJunkFileName, kindOfExt } from '../shared/classify'

/** 库内暂存目录名（与库根同盘，保证 moveDir 是同盘 rename O(1)） */
export const STAGING_DIR = '.staging'

/**
 * 文件级过滤器：系统垃圾（IGNORED_NAMES） + 下载站杂质（isJunkFileName）。
 * 目录不过滤——杂质判定只针对文件（知末的垃圾都是文件）。
 */
function isSkippedFile(name: string): boolean {
  return IGNORED_NAMES.has(name.toLowerCase()) || isJunkFileName(name)
}

/** 递归收集文件（相对 base 的 posix 路径），跳过系统垃圾与下载站杂质 */
export async function walkFiles(dir: string, base: string, out: AssetFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory() && isSkippedFile(e.name)) continue
    const abs = path.join(dir, e.name)
    const rel = path.relative(base, abs).split(path.sep).join('/')
    if (e.isDirectory()) {
      await walkFiles(abs, base, out)
    } else if (e.isFile()) {
      const st = await fs.stat(abs)
      // 注意：kindOfExt 只剥开头的点，必须传**扩展名**而不是完整文件名，
      // 否则 '现代衣柜.skp' 查不到 EXT_KIND → 全部落 'other'（分类彻底失效）
      const ext = path.extname(e.name).slice(1).toLowerCase()
      out.push({
        rel,
        name: e.name,
        ext,
        size: st.size,
        kind: kindOfExt(ext)
      })
    }
  }
}

export interface TopLevelEntry {
  name: string
  isDir: boolean
}

/** 列出目录顶层项（过滤系统垃圾与下载站杂质文件） */
export async function listTopLevel(dir: string): Promise<TopLevelEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() || !isSkippedFile(e.name))
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
}

/**
 * 移动目录；**只对跨卷（EXDEV）退化为复制+删除**。
 *
 * ## 为什么 catch 必须有条件（2026-11 自查，静默丢数据）
 *
 * `fs.rename` 失败的原因**不止**跨盘：
 * - Windows 上「目标目录已存在且非空」→ `EPERM` / `EEXIST` / `ENOTEMPTY`；
 * - 「文件正被 DCC / 3ds Max 占用」→ `EBUSY` / `EACCES`。
 *
 * 这些情况下若无条件走 `fs.cp`，而 `fs.cp` 默认 `force: true` 会**把源合并进已有目标目录**，
 * 随后 `rm(src, { recursive: true })` 把源删掉 —— 本该报错的场景变成
 * 「两个目录被悄悄合并、其中一个消失了」。
 *
 * ## 调用点与目标唯一性
 *
 * 调用点：`src/main/importer.ts:947`（覆盖档 `replaceAssetFolder` 的回调）、
 * `src/main/importer.ts:975`（常规落盘）、`src/main/trash.ts`（软删 `moveToLibraryTrash`
 * 与还原 `restoreFromLibraryTrash`）。导入侧目标名由 `uniqueName` / 批内台账
 * （`batch.ledger.reserve`）保证唯一，跨卷复制时目标**理论上不存在**。
 *
 * ## 跨卷分支的三重保险（目标必须**不存在**）
 *
 * `fs.cp` 的默认语义是**合并**：`force: true`（默认）时目标里同名文件被覆盖、目录直接往里写
 * —— 这正是静默丢数据的入口（回退验证：d93af1d 的无条件 catch 版本在本场景"成功"了）。
 *
 * 三道都要，覆盖面从大到小：
 *
 * 1. `pathExists(dest)` 显式探一次 —— 存在就抛，错误信息**中文 + 带路径**，可直接给用户看；
 *    且行为不随 Node 版本漂移（`errorOnExist` 在旧版本 Node 上对**目录级**已存在不保证抛）；
 * 2. `force: false` —— 不覆盖已有文件（兜第 1 道探完到 cp 之间被别处创建的窗口）；
 * 3. `errorOnExist: true` —— 同一窗口内的文件级冲突（Node 22 实测目录级也）仍会抛。
 *
 * 且 `rm(src)` 排在 `cp` 之后：任何一道抛错都不会删源（复制失败时源目录原样保留）。
 *
 * @throws rename 的原始错误（非 EXDEV 时原样抛出，不再吞掉/退化成合并）
 * @throws 跨卷时「目标已存在」或 cp 的错误（此时源目录保持不变）
 */
export async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
    return
  } catch (err) {
    // 只对「跨卷」退化。其它原因（EEXIST/EPERM/EBUSY/EACCES…）必须原样抛出：
    // fs.cp 默认 force:true 会把源**合并**进已有目标，再 rm(src) 就是静默丢数据。
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
  }
  // 跨卷：目标必须**不存在**才允许复制。
  // ⚠️ `errorOnExist` 只挡文件级冲突；目标**目录**已存在时 fs.cp 会往里合并写入。
  // 跨卷移动的语义是"搬过去"，目标必须不存在 —— 显式探一次，存在就直接抛。
  if (await pathExists(dest)) {
    throw new Error(`跨卷移动失败：目标已存在（${dest}）`)
  }
  await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true })
  // 只有 cp 成功才会执行到这一行：复制失败时源目录原样保留（绝不删源）。
  await fs.rm(src, { recursive: true, force: true })
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 建一个本次导入专用的 staging 目录：`<库根>/.staging/<uuid>` */
export async function createStaging(libraryDir: string): Promise<string> {
  const dir = path.join(libraryDir, STAGING_DIR, randomUUID())
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 清空并删除整个 `.staging`（启动 / 退出 / 异常三重清理钩子调用） */
export async function cleanStaging(libraryDir: string): Promise<void> {
  await fs.rm(path.join(libraryDir, STAGING_DIR), { recursive: true, force: true })
}

/** 清空目录内容但保留目录本身（换码页重解时用） */
export async function clearDirContents(dir: string): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true })
  }
}

/** 读文件头部 n 字节（.skp 版本解析用，P0-15） */
export async function readHead(abs: string, n: number): Promise<Buffer> {
  const fh = await fs.open(abs, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * 把 posix 相对路径安全拼到根目录上，并做目录穿越防护（vault:// 协议与拖出共用）。
 * 越界时抛错。
 */
export function safeJoin(root: string, rel: string): string {
  const relNative = rel.split('/').filter((s) => s.length > 0 && s !== '.').join(path.sep)
  const base = path.resolve(root)
  const abs = path.resolve(base, relNative)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('路径越界：不在库目录内')
  }
  return abs
}
