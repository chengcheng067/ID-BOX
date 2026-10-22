/**
 * 图片扩展名白名单 —— **唯一权威表**（2026-10-19 反馈 4）。
 *
 * 两个调用方必须读同一份，不许各写一遍（否则「能导入」与「能渲球」两套口径漂移）：
 * 1. `main/importer.ts` 的单张图片直导（`kind='texture'`，不经解压链路）；
 * 2. `renderer/logic/materialBall.ts` 的 `effectiveMaterialSlots` —— 槽位识别不出时，
 *    把资产里第一张图片兜底当 `albedo`（基础色）渲球。
 *
 * 放在 `shared/` 是因为 main 与 renderer 都要用，而 main 的实现不能被 renderer 直接 import
 * （renderer 的 tsconfig 只包含 shared / renderer / preload）。
 *
 * 口径说明：只收 Chromium 的 `<img>` / three 的 `TextureLoader` 能解码的格式。
 * `tga` / `exr` / `hdr` **不在**此表（渲染可用但导入白名单从未收过，且 exr/hdr 需要
 * 额外的 loader），它们在 `materialBall.ts` 里只参与槽位识别，不参与兜底。
 */
export const IMAGE_FILE_EXTS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'gif'
])

/** 扩展名（可带前导点、大小写不限）是否为可导入 / 可兜底渲球的图片 */
export function isImageFileExt(ext: string): boolean {
  return IMAGE_FILE_EXTS.has(ext.toLowerCase().replace(/^\./, ''))
}
