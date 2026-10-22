import { nativeImage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { thumbsDir } from './paths'
import {
  resizeToMaxPx,
  thumbFileName,
  thumbOutputExt,
  thumbFileSalt,
  matchThumbNames,
  findOrphanThumbs,
  parseThumbFileName,
  DEFAULT_THUMB_MAX_PX,
  THUMB_JPEG_QUALITY
} from '../shared/thumb'
import { extOf } from '../shared/format'
import { isWithinRoot } from '../shared/vault'

export { thumbsDir }

export interface EnsureThumbOptions {
  /**
   * 覆盖默认的 salt。默认 salt 由**封面路径 + mtime + 字节数**算出（见
   * `shared/thumb.ts:thumbSaltSource`），所以「同一路径写回新内容」也会换新文件名。
   * 显式传 salt 的调用方（材质球等自有命名空间）**优先级最高，绝不被覆盖**。
   */
  salt?: string
  /** 最长边像素上限，默认 480 */
  maxPx?: number
}

/** 建好并返回 thumbs 目录（不存在时 recursive mkdir） */
export async function ensureThumbsDir(): Promise<string> {
  const dir = thumbsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * 生成缩略图，返回**缓存文件名**（相对 thumbs 目录）；任何失败返回 `null`。
 *
 * 契约（架构 §T04 已定）：
 * - 返回文件名 → 调用方置 `thumbStatus='ready'`
 * - 返回 `null` → `'none'`（无封面 / 图读不出来，**不是错误**）
 * - 抛异常 → importer 捕获后置 `'failed'`
 *
 * 因此这里**全程 try/catch 且绝不向上抛**：缩略图失败只降级，绝不阻断入库。
 */
export async function ensureThumb(
  id: string,
  coverAbs: string | null,
  opts?: EnsureThumbOptions
): Promise<string | null> {
  try {
    if (!id || !coverAbs) return null
    const st = await fs.stat(coverAbs).catch(() => null)
    if (!st || !st.isFile()) return null

    const img = nativeImage.createFromPath(coverAbs)
    if (!img || img.isEmpty()) return null

    const maxPx = opts?.maxPx && opts.maxPx > 0 ? opts.maxPx : DEFAULT_THUMB_MAX_PX
    const size = img.getSize()
    const target = resizeToMaxPx(size.width, size.height, maxPx)
    const scaled =
      target.width === size.width && target.height === size.height
        ? img
        : img.resize({ width: target.width, height: target.height, quality: 'good' })

    const ext = thumbOutputExt(extOf(coverAbs))
    // salt 必须反映**内容身份**，不能只反映路径：HDR 预览「拍照」每次都写回同一个
    // `<资产名>.cover.png`，只看路径 → 文件名恒定 → `vault://thumb/<同名>` 命中
    // Chromium 磁盘缓存 → 卡片一直是旧图、重启才刷新（2026-10 用户反馈）。
    // `st` 就是上面那次 stat 的结果，复用不额外 IO；同一文件未改写时 st 稳定，
    // 因此该 salt 对同一份文件是**确定性**的（`regenThumbSweep()` 两次调用同名）。
    const salt = opts?.salt ?? thumbFileSalt(coverAbs, st)
    const name = thumbFileName(id, salt, ext)
    const dir = await ensureThumbsDir()
    const buffer = ext === 'png' ? scaled.toPNG() : scaled.toJPEG(THUMB_JPEG_QUALITY)
    await fs.writeFile(path.join(dir, name), buffer)
    return name
  } catch {
    return null
  }
}

/** 缩略图缓存文件的绝对路径；不存在返回 null */
export function thumbAbsPath(name: string | null | undefined): string | null {
  if (!name) return null
  return path.join(thumbsDir(), name)
}

/** 删掉某个 id 的全部缩略图（salt 会变，必须通配 `<id>-*.{jpg,png}`），返回删掉的数量 */
export async function deleteThumb(id: string): Promise<number> {
  try {
    const dir = await ensureThumbsDir()
    const names = await fs.readdir(dir)
    const hits = matchThumbNames(names, id)
    await Promise.all(hits.map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => {})))
    return hits.length
  } catch {
    return 0
  }
}

/**
 * 按**文件名精确删**单张缩略图（2026-10 调参持久化，docs/12 §4.1）。
 *
 * 为什么不能复用 `deleteThumb(id)`：它是按 id **通配全删**，而材质球需要
 * 「只删旧的那一张球图」。三个不能照抄的场景：
 * ① `coverSource === 'named'` 的材质，其 `thumbPath` 是官方渲染图的封面缩略图；
 * ② 同一材质既有封面缩略图又有球图（手动换封面后 regenThumbSweep 产出封面 salt）；
 * ③ 参数变化产生的旧 JPG 属于 live id，`findOrphanThumbs` 永远不会判它孤儿。
 *
 * 四道校验缺一不可（与 `ballThumb.ts:67` 同一道防线，口径一致）：
 * ① `parseThumbFileName` —— 必须是缩略图文件（防非缩略图名）；
 * ② `p.id === id` —— 必须是该 id 的缩略图（防跨资产误删）；
 * ③ `path.basename(name) === name` —— **必须是纯文件名**（2026-10-15 QA 实测补）；
 * ④ `isWithinRoot` —— 落点必须在 thumbs 目录内（防渲染层被注入后写任意路径）。
 * 返回 false = 校验不过（调用方应静默降级，不阻断）。
 *
 * 为什么 ③ 不能省（QA 探针实测）：`parseThumbFileName` 的 `(.+)` 会吃掉 `/` 与 `\`，
 * 所以 `../evil-811c9dc5.jpg` 能解析出 `id = '../evil'`、salt 合法；经
 * `path.join(dir, name)` 后 `path.resolve` 落到 thumbs 目录**之外**，但
 * `isWithinRoot` 只看字符串前缀 → 判 true → 第三道拦不住，`fs.rm(force:true)` 会真删。
 * 因此必须在拼路径之前先要求 name 本身不含分隔符。
 */
export async function deleteOneThumb(id: string, name: string): Promise<boolean> {
  try {
    const p = parseThumbFileName(name)
    if (!p || p.id !== id) return false
    if (path.basename(name) !== name) return false
    const dir = await ensureThumbsDir()
    const abs = path.resolve(path.join(dir, name))
    if (!isWithinRoot(dir, abs, path.sep)) return false
    await fs.rm(abs, { force: true }).catch(() => {})
    return true
  } catch {
    return false
  }
}

/** 清理孤儿缓存（库里已经没有对应资产的），返回删掉的数量 */
export async function pruneThumbs(liveIds: string[]): Promise<number> {
  try {
    const dir = await ensureThumbsDir()
    const names = await fs.readdir(dir)
    const live = new Set(liveIds ?? [])
    const orphans = findOrphanThumbs(names, live)
    await Promise.all(orphans.map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => {})))
    return orphans.length
  } catch {
    return 0
  }
}

/** 清空整个 thumbs 目录，返回清掉的数量 */
export async function clearThumbs(): Promise<number> {
  try {
    const dir = await ensureThumbsDir()
    const names = await fs.readdir(dir)
    let n = 0
    for (const name of names) {
      if (!parseThumbFileName(name)) continue
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
      n++
    }
    return n
  } catch {
    return 0
  }
}

export interface ThumbStats {
  count: number
  bytes: number
}

/** 设置面板显示「当前缓存数量 / 占用」用 */
export async function thumbStats(): Promise<ThumbStats> {
  try {
    const dir = await ensureThumbsDir()
    const names = await fs.readdir(dir)
    let count = 0
    let bytes = 0
    for (const name of names) {
      if (!parseThumbFileName(name)) continue
      const st = await fs.stat(path.join(dir, name)).catch(() => null)
      if (!st || !st.isFile()) continue
      count++
      bytes += st.size
    }
    return { count, bytes }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

/** 缓存数量（便捷包装） */
export async function thumbCount(): Promise<number> {
  return (await thumbStats()).count
}

/** 缓存占用字节数（便捷包装） */
export async function thumbsBytes(): Promise<number> {
  return (await thumbStats()).bytes
}
