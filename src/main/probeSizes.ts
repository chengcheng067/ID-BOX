/**
 * 尺寸**回填**通道（2026-10「分辨率筛选在材质与 HDR 都失效」）。
 *
 * 背景：`w/h` 自 0.6.0 才在**导入时**采集，之前入库的资产一个尺寸都没有；
 * 而筛选只在有 `w/h` 的资产上生效 → 老库看着像"筛选坏了"。本模块提供一条
 * **只读探测**：给定资产文件夹 + 一批相对路径，回一批 `{rel, w, h}`，
 * 由渲染层自己决定怎么落库（本模块与调度无关，也不写任何东西）。
 *
 * 口径（与 `importer.fillImageSizes` 完全一致，共用 `readHeadForSize`）：
 * - 只读文件**头部**，绝不解码整图：默认 `IMAGE_SIZE_HEAD_BYTES`（64KB）；
 *   **仅当**解析失败**且**扩展名是 `jpg/jpeg` 时，才升到 `IMAGE_SIZE_HEAD_BYTES_LARGE`
 *   （1MB）重试**一次**（实测有图的 SOF0 在 678557 字节处，64KB 永远够不着）；
 *   PNG / hdr / exr 不升级 —— 它们的尺寸在固定偏移或头部首个属性里；
 * - `hdr` / `exr` 走 `hdrSizeOf`（Radiance 文本头 / OpenEXR 属性列表），其余走 `imageSizeOf`；
 * - 读不出 / 不认识 / 路径越界 → **静默跳过**（不报错、不占位），返回的条数可能少于入参；
 * - 单次调用有条数上限（`PROBE_SIZES_MAX`），超出的直接不处理 —— 调用方负责分片，
 *   免得渲染层一次传几千条把主进程的 IO 队列堵住。
 */

import path from 'node:path'
import { IMAGE_FILE_EXTS } from '../shared/imageExts'
import { isHdrExt } from '../shared/hdrExts'
import {
  IMAGE_SIZE_HEAD_BYTES,
  IMAGE_SIZE_HEAD_BYTES_LARGE,
  imageSizeOfExt,
  type ImageSize,
  type ProbedImageSize
} from '../shared/imageSize'
import { readHead, safeJoin } from './fsutil'

/** 单次调用的探测条数上限（调用方按此分片） */
export const PROBE_SIZES_MAX = 200

/** 读头函数形状（可注入：单测用它精确断言"读了几次"） */
export type HeadReader = (absPath: string, bytes: number) => Promise<Uint8Array>

/** 是否 JPEG（升级读头只对它开放） */
export function isJpegExt(ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, '')
  return e === 'jpg' || e === 'jpeg'
}

/**
 * **分级读头**解析图片尺寸（probeSizes 与 importer.fillImageSizes 的唯一入口）。
 *
 * 两级策略：
 * 1. 读 64KB → 解析；成功就返回（绝大多数文件走这里，读完即止）；
 * 2. 失败 **且** 是 `jpg/jpeg` → 再读 1MB 重试**一次**；仍失败就是"未知尺寸"。
 *
 * 为什么只对 JPEG 升级：PNG 的 IHDR 在字节 16..24、HDR 的分辨率行 / EXR 的
 * `dataWindow` 属性都在头部极前处，64KB 早已覆盖；而 JPEG 允许在 SOF 前塞任意多
 * APPn 段（ICC 配置可以几百 KB），实测确有一张的 SOF0 在 678557 字节。
 *
 * 每个文件最多读两次 —— 不做 2MB / 4MB 的循环试探（读放大会压垮整库回填）。
 *
 * @param ext 扩展名（可带前导点、大小写不限）
 * @param read 读头实现（默认 `fsutil.readHead`；单测注入计数版）
 * @throws 读文件失败时原样抛出 —— 调用方（probeSizes / fillImageSizes）负责静默
 */
export async function readHeadForSize(
  absPath: string,
  ext: string,
  read: HeadReader = readHead
): Promise<ImageSize | null> {
  const small = await read(absPath, IMAGE_SIZE_HEAD_BYTES)
  const quick = imageSizeOfExt(ext, small)
  if (quick) return quick
  if (!isJpegExt(ext)) return null
  const large = await read(absPath, IMAGE_SIZE_HEAD_BYTES_LARGE)
  return imageSizeOfExt(ext, large)
}

/**
 * 探测一批文件的宽高。
 *
 * @param folder 资产文件夹**绝对路径**（`rels` 相对它；可为库根，用于跨资产批量探测）
 * @param rels   posix 相对路径列表（如 `pbugp_2K_Albedo.jpg` / `maps/ao.png`）
 * @returns 读得出尺寸的条目（`rel` 原样回传）；顺序不保证，调用方按 `rel` 落位
 */
export async function probeSizes(folder: string, rels: string[]): Promise<ProbedImageSize[]> {
  if (typeof folder !== 'string' || folder.length === 0) return []
  if (!Array.isArray(rels) || rels.length === 0) return []

  const out: ProbedImageSize[] = []
  for (const rel of rels.slice(0, PROBE_SIZES_MAX)) {
    if (typeof rel !== 'string' || rel.length === 0) continue
    const ext = path.extname(rel).slice(1).toLowerCase()
    // 不认识的后缀连 IO 都不做（600+ 条资产里大量 .skp / .zip）
    if (!IMAGE_FILE_EXTS.has(ext) && !isHdrExt(ext)) continue
    try {
      // safeJoin 负责目录穿越防护：越界会抛错，被下面的 catch 静默丢掉
      const size = await readHeadForSize(safeJoin(folder, rel), ext)
      if (!size) continue
      out.push({ rel, w: size.w, h: size.h })
    } catch {
      /* 静默：读不到 / 越界 = 这一条不回填 */
    }
  }
  return out
}
