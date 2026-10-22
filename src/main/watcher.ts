import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'
import { isInsideLibraryTrash } from './trash'

/** 只收敛到 Windows 下载场景真正会出现的格式（C2：移除 .tar/.gz/.tgz） */
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z'])

/** 浏览器 / 下载工具的临时文件扩展名（C5：不导入半成品） */
const TEMP_EXTS = new Set(['.crdownload', '.part', '.tmp', '.!ut', '.download', '.opdownload'])

/**
 * watcher 的统一忽略判定（**纯函数**，可单测）。
 *
 * 三条：① `.` 开头（含 `.trash` / `.staging`）② 浏览器临时文件 ③ 路径里带
 * `.trash` 段（C 线硬约束：用户把监控目录指向库根时，回收区里的压缩包**绝不能**
 * 被当成新下载导入——那等于把刚删的资产又导回来）。
 */
export function shouldIgnoreWatchPath(p: string): boolean {
  // 任一路径段以 `.` 开头即忽略：覆盖隐藏文件本身 **以及隐藏目录内部**
  // （`.trash` / `.staging` 里的文件曾被旧实现放行——旧判定只看 basename）。
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.some((s) => s.startsWith('.'))) return true
  if (TEMP_EXTS.has(path.extname(p).toLowerCase())) return true
  return isInsideLibraryTrash(p)
}

/**
 * 下载目录监控：新出现的压缩包等写入稳定后回调导入。
 * （浏览器边下边写，awaitWriteFinish 等 3 秒稳定期；P1 功能，默认关闭）
 */
export class ArchiveWatcher {
  private w: FSWatcher | null = null
  private inflight = new Set<string>()

  start(dir: string, onArchive: (p: string) => void): void {
    this.stop()
    this.w = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
      ignored: (p: string) => shouldIgnoreWatchPath(p)
    })
    this.w.on('add', (p: string) => {
      if (!ARCHIVE_EXTS.has(path.extname(p).toLowerCase())) return
      const key = path.resolve(p)
      if (this.inflight.has(key)) return
      this.inflight.add(key)
      onArchive(p)
    })
    this.w.on('error', () => {
      /* 监控失败不致命，静默 */
    })
  }

  /** 导入结束（成功或失败都释放，避免同文件卡死） */
  markDone(p: string): void {
    this.inflight.delete(path.resolve(p))
  }

  stop(): void {
    void this.w?.close()
    this.w = null
    this.inflight.clear()
  }
}
