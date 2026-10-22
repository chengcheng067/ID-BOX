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

/** 移动目录；跨盘时退化为复制+删除 */
export async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
  } catch {
    await fs.cp(src, dest, { recursive: true })
    await fs.rm(src, { recursive: true, force: true })
  }
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
