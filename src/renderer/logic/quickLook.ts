/**
 * Quick Look（空格全屏快览浮层，0.8.3，docs/32 §4 + docs/33）的**纯逻辑**。
 *
 * 产品口径（已拍板，不许在组件里另立判断）：Quick Look 是「比素材」的快路径 ——
 * 纯预览、无编辑。它回答的是两个问题：
 *   ① 按空格时**开哪一张**（target）；
 *   ② ←/→ 在**哪个序列**里走（sequence）。
 *
 * 本模块不 import React / DOM / `window.modvault` → 可进 vitest（`tests/quickLook.test.ts`）。
 *
 * ## 序列口径（为什么是"当前视图序列"而不是 `assets` 原序）
 *
 * `logic/selection.ts` 的第一条不变量就是「区间顺序 = 当前可见顺序」。Quick Look 的
 * ←/→ 必须与网格渲染顺序一致，否则用户按三下箭头看到的顺序和屏幕上不一样。所以
 * `visibleOrder` 由调用方传入（`applyFilters` 的结果），本模块不自己过滤 ——
 * 软删过滤的唯一实现点在 `matchesFilters`，在这里再写一遍就是第二套真相。
 *
 * ## target 优先级（docs/32 §4 的"比素材"语义）
 *
 *   文件视图资产 > 焦点卡所在选中项 > 选中集按可见顺序第一个 > 可见序列第一张 > null
 *
 * 理由：Quick Look 是"看眼前这一张"，不是"看库里第一个"。用户在文件视图里按空格，
 * 他要的是正在看的那个文件夹；没有选中集时退到"屏幕上第一张"，至少给一个可看的目标。
 * 每一级都要求该 id **在当前可见集里**（不在就落到下一级）—— 否则会出现
 * "target 是资产 A、序列里没有 A"（`n / m` 显示 -1，箭头按不动）。
 */
import type { Asset, AssetFile } from '../../shared/types'
import { vaultUrl, thumbVaultUrl } from '../../shared/format'
import { assetFileAbs } from './assetPath'
import { IMAGE_EXTS } from './fileView'
import { peekPreviewUrl } from './previewThumb'

/** 判据输入：全部由调用方从 store 现取，函数本身不读任何全局状态 */
export interface QuickLookContext {
  /** 焦点资产（右栏详情当前显示的 / 最后点击的卡，即 store 的 `selectedId`） */
  focusId: string | null
  /** 当前选中集（store 的 `selectedIds`，可能为空） */
  selectedIds: readonly string[]
  /** 软件内文件视图的资产（store 的 `folderViewAssetId`），未打开时 null */
  folderViewAssetId: string | null
  /** 当前视图序列（`applyFilters` 的 id 顺序 = 网格渲染顺序） */
  visibleOrder: readonly string[]
}

/** 去重并剔除空值（保持首次出现的顺序，与 `logic/selection.dedupeIds` 同规则） */
function clean(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 选中集裁剪到可见集，**按可见顺序**重排（与 `pruneToVisible` 同规则） */
function selectionInVisibleOrder(selectedIds: readonly string[], visibleOrder: readonly string[]): string[] {
  const order = clean(visibleOrder)
  const picked = new Set(clean(selectedIds))
  return order.filter((id) => picked.has(id))
}

/**
 * 按空格时该开哪一张（`null` = 没有任何可看的目标，调用方不该开浮层）。
 *
 * 优先级见模块头。`focusId` 只有在**属于选中集**时才算"焦点卡所在选中项"：
 * 单选时 `selectedIds = [selectedId]`，所以焦点卡天然命中；多选后焦点卡不在选中集
 * （例如框选了别的卡）就退到"选中集按可见顺序第一个"，而不是把没选中的卡当目标。
 */
export function resolveQuickLookTarget(ctx: QuickLookContext): string | null {
  const order = clean(ctx.visibleOrder)
  if (order.length === 0) return null

  // ① 文件视图里正在看的那个资产
  if (ctx.folderViewAssetId && order.includes(ctx.folderViewAssetId)) return ctx.folderViewAssetId

  // ② 焦点卡所在选中项
  if (ctx.focusId && clean(ctx.selectedIds).includes(ctx.focusId) && order.includes(ctx.focusId)) {
    return ctx.focusId
  }

  // ③ 选中集按可见顺序第一个
  const selection = selectionInVisibleOrder(ctx.selectedIds, order)
  if (selection.length > 0) return selection[0]

  // ④ 可见序列第一张
  return order[0]
}

/**
 * ←/→ 走的序列：选中集 ≥2 → 按可见顺序排列的选中集；否则整个可见序列。
 *
 * 为什么是"≥2 才按选中集"：多选是用户主动划出来的比较范围（「这几张比一比」），
 * 箭头必须在这几之间走；单选（只有 1 项）没有"范围"可言，走整个可见序列更符合直觉
 * —— 单卡按空格后继续按箭头，就是往下扫库。
 */
export function quickLookSequence(ctx: QuickLookContext): string[] {
  const order = clean(ctx.visibleOrder)
  const selection = selectionInVisibleOrder(ctx.selectedIds, order)
  if (selection.length >= 2) return selection
  return order
}

/** 序列里的位置（找不到 -1：调用方据此显示「? / m」而不是骗人的 1/m） */
export function quickLookIndexInSequence(seq: readonly string[], id: string): number {
  return seq.indexOf(id)
}

/**
 * 走到下一个（`delta` = +1 / -1），**不 wrap**：首/尾夹在原地。
 *
 * 为什么不 wrap：`n / m` 计数器与"第几张"是强绑定，绕回第一张时计数器会跳变，
 * 用户无法判断自己是走到了尽头还是被系统重置。位置未知（`i < 0` / 越界）时返回 null
 * —— 宁可不动，也不要猜一个。
 */
export function stepSequence(seq: readonly string[], i: number, delta: number): string | null {
  if (seq.length === 0) return null
  if (i < 0 || i >= seq.length) return null
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  const next = Math.min(seq.length - 1, Math.max(0, i + step))
  return seq[next]
}

/**
 * 可作大图展示的源文件：优先封面文件本身，其次资产里第一张图片。
 *
 * 只认 `IMAGE_EXTS`（`logic/fileView.ts` 的口径）：`.tga` / `.exr` / `.hdr` 属于 DCC
 * 中间产物，浏览器 `<img>` 解不了 —— 把它们当大图会必然 `onerror`，于是 Quick Look
 * 出现"黑屏 + 破图"。这类资产走类型占位。
 */
export function quickLookImageFile(asset: Asset): AssetFile | null {
  if (!asset || !Array.isArray(asset.files)) return null
  for (const f of asset.files) {
    if (asset.cover && f.rel === asset.cover) return f
  }
  for (const f of asset.files) {
    if (IMAGE_EXTS.includes((f.ext ?? '').toLowerCase())) return f
  }
  return null
}

/** 取最后一段扩展名（小写、不含点）；没有扩展名返回空串 */
function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 浮层的图片 URL（**原图**，不是缩略图）。
 *
 * 三级回退（顺序是产品口径，不能换）：
 *   ① `asset.cover`（相对**资产目录**的路径）→ `vaultUrl(<relFolder>/<cover>)`：
 *      Quick Look 要"看得清楚"，网格用缩略图是因为同屏 24 张，全屏单图没有这个约束
 *      （性能陷阱 C4 只禁网格读原图）；
 *   ② 已解析过的 ≤1024 预览图（`peekPreviewUrl` 只**同步读缓存**，不发 IPC）：
 *      源文件解不了 / 超大时缓存里可能有可用产物；
 *   ③ 缩略图缓存（`thumbStatus === 'ready'` + `thumbPath`）：网格已经渲过，白拿；
 *   ④ `null` = 没有图，调用方必须显示类型占位（不崩不抛）。
 *
 * ⚠️ **两个相对根不能混**（0.8.3 真机验收踩过的坑，别改回去）：
 *   `asset.cover` 相对**资产目录**（`ball.cover.png`），而 `vault://asset/<rel>` 的 `<rel>`
 *   相对**库根**（见 `src/main/protocol.ts` 头部注释）→ 必须自己拼 `relFolder`。
 *   同口径的唯一权威是 `DetailPanel.tsx:381-382`（详情面板显示封面用的就是它）。
 *   漏拼的后果不是报错，是 `<img>` 404 → 退占位图标，浮层"开了但什么都没显示"。
 *
 * ⚠️ 封面也要过 `IMAGE_EXTS`：`.cover.tga` 这类脏数据（DCC 中间产物）`<img>` 解不了，
 *   直接给它 URL 会先闪一张破图再退占位。只有**能确定**扩展名且不在白名单时才跳过封面
 *   （没有扩展名的不拦，交给 `onError` 兜底）。
 *
 * ⛔ 绝不手拼 `vault://`：逐段 encodeURIComponent 只在 `shared/format.ts` 里做，
 *   拼错的中文路径会破坏协议解析（见 `vaultUrl` 的注释）。
 */
export function quickLookImageUrl(asset: Asset): string | null {
  if (!asset) return null
  if (asset.cover) {
    const coverExt = extOf(asset.cover)
    const coverDisplayable = coverExt === '' || IMAGE_EXTS.includes(coverExt)
    if (coverDisplayable) {
      const rel = asset.relFolder ? `${asset.relFolder}/${asset.cover}` : asset.cover
      return vaultUrl(rel, asset.updatedAt)
    }
  }

  const file = quickLookImageFile(asset)
  if (file && file.rel) {
    const peeked = peekPreviewUrl(asset.id, assetFileAbs(asset.folder, file.rel))
    if (peeked) return peeked
  }

  if (asset.thumbStatus === 'ready' && asset.thumbPath) return thumbVaultUrl(asset.thumbPath)
  return null
}
