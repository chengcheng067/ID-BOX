import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 封面图片写入（2026-10 用户装机反馈，任务 3）——**零 electron 依赖，可单测**。
 *
 * 用户原话：「预留接口，让用户截图以后直接扔进软件，就能贴在这个 Su 预览图片上」。
 * 主进程侧职责：
 *   ① 校验确实是图片（magic bytes：JPEG `FFD8FF` / PNG `89504E47`）——
 *      不信任扩展名/ MIME，用户改个后缀塞 .exe 进来的场景必须拦；
 *   ② 限制大小（≤20MB）——防止误拖一张 200MB 的 PSD 预览图把库撑爆；
 *   ③ 路径安全：**目标**资产文件夹必须在库内（由调用方用 isWithinRoot 校验），
 *      本模块只做资产文件夹内的读写，safeJoin 之外不做任何路径拼装；
 *   ④ 命名 `<资产文件夹名>.cover.<ext>`（与 skpPreview 的 `<skp主名>.preview.<ext>`
 *      同族：封面文件落在资产内、进 files、vault://asset/ 可读、rescan 视图一致）。
 *      重复设置时先清掉同族的其它 `*.cover.*` 文件，避免堆积。
 */

/** 封面图片大小上限（20MB） */
export const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024

/** 支持的封面图片格式（magic bytes 命中者） */
export type CoverImageFormat = 'png' | 'jpeg'

export type CoverImageValidation =
  | { ok: true; format: CoverImageFormat }
  | { ok: false; reason: 'too-large' | 'not-image' | 'empty' }

/**
 * 读 buffer 头部魔数判定图片格式（**纯函数**）。
 * PNG：`89 50 4E 47`（`\x89PNG`，完整签名为 8 字节，前 4 字节已足够区分）；
 * JPEG：`FF D8 FF`（SOI + 首个 marker 的 FF）。
 */
export function detectCoverImageFormat(buf: Buffer): CoverImageFormat | null {
  if (!buf || buf.length < 3) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  return null
}

/**
 * 封面图片校验（**纯函数**）：先大小后魔数。
 * 顺序有讲究——超大文件先按体积拒掉，避免对 20MB+ 的垃圾数据白扫魔数。
 */
export function validateCoverImage(buf: Buffer): CoverImageValidation {
  if (!buf || buf.length === 0) return { ok: false, reason: 'empty' }
  if (buf.length > MAX_COVER_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const format = detectCoverImageFormat(buf)
  if (!format) return { ok: false, reason: 'not-image' }
  return { ok: true, format }
}

/** 格式 → 落盘扩展名（与 thumb.ts 的 thumbOutputExt 口径一致：jpeg → jpg） */
export function coverImageExt(format: CoverImageFormat): string {
  return format === 'png' ? 'png' : 'jpg'
}

/** 封面文件名：`<资产文件夹名>.cover.<ext>` */
export function coverFileName(assetFolderName: string, ext: string): string {
  return `${assetFolderName}.cover.${ext}`
}

/** 把文件名里的正则元字符转义（readdir 匹配同族 cover 文件用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 删掉资产文件夹里**除目标文件外**的同族封面文件（`<资产名>.cover.*`）。
 * 只删这一个精确模式、非递归——用户资产里自己放的图一概不碰。
 */
async function removeStaleCovers(folder: string, assetFolderName: string, keepRel: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(folder)
  } catch {
    return
  }
  const re = new RegExp(`^${escapeRegExp(assetFolderName)}\\.cover\\.[^./]+$`, 'i')
  await Promise.all(
    names
      .filter((n) => n !== keepRel && re.test(n))
      .map((n) => fs.rm(path.join(folder, n), { force: true }).catch(() => {}))
  )
}

/**
 * 把校验过的图片 buffer 写进资产文件夹，返回 rel 路径与字节数。
 *
 * ⚠️ 调用方负责：① `folder` 是 resolve 过的绝对路径；② `folder` 在库目录内
 * （isWithinRoot）；③ buffer 已通过 `validateCoverImage`。本函数不再信任任何
 * 外部输入，只做「同族清理 + 落盘」。
 */
export async function writeCoverImageInto(
  folder: string,
  buf: Buffer
): Promise<{ rel: string; size: number }> {
  const v = validateCoverImage(buf)
  if (!v.ok) throw new Error(`封面图片不合法：${v.reason}`)
  const assetFolderName = path.basename(folder)
  const rel = coverFileName(assetFolderName, coverImageExt(v.format))
  await removeStaleCovers(folder, assetFolderName, rel)
  await fs.writeFile(path.join(folder, rel), buf)
  return { rel, size: buf.length }
}
