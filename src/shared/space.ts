/**
 * 磁盘空间预检的计算部分（纯函数，零 IO，P0-3 / D3）
 *
 * 公式（PRD D3）：`required = uncompressedBytes × safetyFactor + archiveBytes`
 * 主进程 `main/disk.ts` 负责取 freeBytes 与 uncompressed，本模块只做判定与文案。
 */

export const DEFAULT_SAFETY_FACTOR = 1.2

export interface SpaceCheck {
  ok: boolean
  freeBytes: number
  requiredBytes: number
  uncompressedBytes: number
  archiveBytes: number
  message: string
}

export interface SpaceInput {
  uncompressedBytes: number
  archiveBytes: number
  safetyFactor?: number
}

const GB = 1024 * 1024 * 1024

/** 需要的字节数 = 解压后体积 × 安全系数 + 原包大小 */
export function requiredBytesFor(o: SpaceInput): number {
  const factor = o.safetyFactor && o.safetyFactor > 0 ? o.safetyFactor : DEFAULT_SAFETY_FACTOR
  const uncompressed = Number.isFinite(o.uncompressedBytes) && o.uncompressedBytes > 0 ? o.uncompressedBytes : 0
  const archive = Number.isFinite(o.archiveBytes) && o.archiveBytes > 0 ? o.archiveBytes : 0
  return Math.ceil(uncompressed * factor) + archive
}

/** 字节 → '12.4 GB'（用于"可用 X GB / 需要 Y GB"文案） */
export function humanGB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0.0 GB'
  return `${(bytes / GB).toFixed(1)} GB`
}

/** 判定目标盘空间是否足够，并给出可行动文案 */
export function evaluateSpace(freeBytes: number, o: SpaceInput): SpaceCheck {
  const requiredBytes = requiredBytesFor(o)
  const free = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes : 0
  const ok = free >= requiredBytes
  return {
    ok,
    freeBytes: free,
    requiredBytes,
    uncompressedBytes: Number.isFinite(o.uncompressedBytes) ? o.uncompressedBytes : 0,
    archiveBytes: Number.isFinite(o.archiveBytes) ? o.archiveBytes : 0,
    message: ok
      ? `空间充足：可用 ${humanGB(free)} / 需要 ${humanGB(requiredBytes)}`
      : `磁盘空间不足：可用 ${humanGB(free)} / 需要 ${humanGB(requiredBytes)}，请在设置里更改库目录或清理磁盘`
  }
}
