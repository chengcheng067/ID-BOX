import fs from 'node:fs/promises'
import path from 'node:path'
import type { SpaceCheck } from '../shared/space'
import { evaluateSpace } from '../shared/space'
import { listUncompressedBytes } from './extractor'

/** 7z / adm-zip 都取不到 uncompressed 时的保守估算系数 */
export const FALLBACK_ESTIMATE_FACTOR = 3

/** 目录不存在时向上回溯的最大层数（R7） */
const MAX_ANCESTOR_LOOKUP = 8

/**
 * 目标目录所在盘的可用字节数（`fs.statfs`，Node 19.6+）。
 * 目录不存在时向上回溯到存在的祖先目录；彻底取不到返回 null。
 */
export async function freeBytesOf(dir: string): Promise<number | null> {
  let cur = path.resolve(dir)
  for (let i = 0; i < MAX_ANCESTOR_LOOKUP; i++) {
    try {
      const st = await fs.statfs(cur)
      return Number(st.bavail) * Number(st.bsize)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
  }
  return null
}

export interface SpaceOptions {
  sevenZipPath: string | null
  maxBytesForJsFallback: number
  safetyFactor?: number
}

/**
 * 估算解压后体积：7z `l -slt` 精确求和 → adm-zip 精确值 → `原包 × 3` 保守估算。
 * 任何一步失败都不抛出，退化为保守估算（宁可多估，不可漏判）。
 */
export async function estimateUncompressedBytes(
  src: string,
  opts: Pick<SpaceOptions, 'sevenZipPath' | 'maxBytesForJsFallback'>
): Promise<{ bytes: number; exact: boolean }> {
  try {
    const info = await listUncompressedBytes(src, opts)
    if (info.bytes > 0) return info
  } catch {
    /* 取不到 → 走保守估算 */
  }
  const archiveBytes = await archiveSizeOf(src)
  return { bytes: archiveBytes * FALLBACK_ESTIMATE_FACTOR, exact: false }
}

/** 解压前预检：目标盘可用空间是否 ≥ uncompressed × factor + 原包 */
export async function checkSpaceFor(src: string, libraryDir: string, opts: SpaceOptions): Promise<SpaceCheck> {
  const archiveBytes = await archiveSizeOf(src)
  const { bytes } = await estimateUncompressedBytes(src, opts)
  const free = (await freeBytesOf(libraryDir)) ?? 0
  return evaluateSpace(free, {
    uncompressedBytes: bytes,
    archiveBytes,
    safetyFactor: opts.safetyFactor
  })
}

async function archiveSizeOf(src: string): Promise<number> {
  try {
    return (await fs.stat(src)).size
  } catch {
    return 0
  }
}
