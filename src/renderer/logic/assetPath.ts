/**
 * 资产路径 / 主模型文件的**纯逻辑**（P0-14 / PRD Q3）。
 *
 * 主文件优先级复用 `shared/classify.pickPrimaryFile`（skp > max > fbx > obj > 3ds > 首个模型 > files[0]），
 * 这里只负责把「资产文件夹 + 相对路径」拼成绝对路径，以及拖出 / 双击 reveal 的目标选择。
 */
import type { Asset, AssetFile } from '../../shared/types'
import { pickPrimaryFile } from '../../shared/classify'

/** 根据资产文件夹的路径形态推断分隔符（Windows 库目录用 `\`，测试夹具可用 `/`） */
export function pathSepFor(folder: string): string {
  return folder.includes('\\') ? '\\' : '/'
}

/** `E:\Lib\模型\某沙发` + `贴图/木纹.jpg` → `E:\Lib\模型\某沙发\贴图\木纹.jpg` */
export function assetFileAbs(folder: string, rel: string): string {
  const sep = pathSepFor(folder)
  return `${folder}${sep}${rel.split('/').join(sep)}`
}

/** 主模型文件（可能为 null：files 为空时） */
export function primaryFileOf(asset: Asset): AssetFile | null {
  return pickPrimaryFile(asset.files) ?? null
}

/** 主模型文件绝对路径；没有可识别文件返回 null */
export function primaryFileAbs(asset: Asset): string | null {
  const f = primaryFileOf(asset)
  return f ? assetFileAbs(asset.folder, f.rel) : null
}

/** 主模型文件名（占位图上展示用）；没有返回 null */
export function primaryFileName(asset: Asset): string | null {
  return primaryFileOf(asset)?.name ?? null
}

/**
 * 双击 reveal 的目标（Q3 已拍板：资源管理器打开并**选中主模型文件**）；
 * 没有可识别主文件时回退到资产文件夹本身。
 */
export function revealTargetFor(asset: Asset): string {
  return primaryFileAbs(asset) ?? asset.folder
}

/** 卡片是否可拖出（只要有一个文件就能拖；files 为空的资产不可拖） */
export function isDraggableAsset(asset: Asset): boolean {
  return asset.files.length > 0
}
