/**
 * 「双击进入软件内文件夹浏览器」的**纯逻辑**（docs/15 §6c，用户 v0.2.2 反馈）。
 *
 * 用户原话：「双击之后我希望我们是作为一个文件夹浏览器来展示内容，所有的 UI 由我们这边来控」。
 * 因此双击不再调系统资源管理器（`window.modvault.reveal`），而是把中栏切换成该资产的
 * 文件行列表（图标 / 文件名 / 扩展名徽标 / 大小），双击某一行才用系统默认程序打开该文件。
 *
 * 本模块不 import React / DOM / electron，可进 vitest（见 `tests/fileView.test.ts`）。
 * 文件末尾还收了中栏**框选**的几何纯函数（`boxOf` / `boxesIntersect` / `marqueeHitIds`），
 * 同样零 DOM 依赖，见 `tests/marqueeSelection.test.ts`。
 */
import type { Asset, AssetFile } from '../../shared/types'
import { formatBytes } from '../../shared/format'
import { assetFileAbs } from './assetPath'

/** 文件行分类：决定行首图标与排序分组 */
export type FileRowKind = 'image' | 'model' | 'other'

/** 文件行模型（`Asset.files` 的展示投影） */
export interface FileRow {
  /** 相对资产文件夹的路径（posix 分隔，唯一键） */
  rel: string
  /** 文件名（含扩展名） */
  name: string
  /** 小写扩展名，不含点；无扩展名时为空串 */
  ext: string
  /** 扩展名徽标文案（大写）；无扩展名时为空串（UI 不渲染徽标） */
  extLabel: string
  /** 字节数 */
  size: number
  /** 已格式化的体积文案（`formatBytes` 的结果，UI 直接显示） */
  sizeText: string
  kind: FileRowKind
  /** 中文分类文案（行内 tooltip / 无图标兜底用） */
  kindLabel: string
  /** 绝对路径（双击 `openPath` / 拖出 `startDrag` 用） */
  absPath: string
  /** 是否图片（`kind === 'image'` 的便捷别名） */
  isImage: boolean
}

/**
 * 图片扩展名（**小写**）。
 *
 * 只收「双击后系统看图工具能打开、且用户会当作图片看」的位图/矢量图格式；
 * `.tga` / `.exr` / `.hdr` 不收——它们属于 DCC 中间产物，双击通常打不开，
 * 归到「文件」组比标成图片更符合直觉。
 */
export const IMAGE_EXTS: readonly string[] = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'ico',
  'svg'
]

/**
 * 模型扩展名（**小写**）。
 *
 * 与 `shared/classify.ts` 的模型词表口径一致，另外补上常见 DCC 原生格式，
 * 让 `kind` 判定不准的历史记录（老库 rescan 前）也能拿到立方体图标。
 */
export const MODEL_EXTS: readonly string[] = [
  'skp',
  'skb',
  'max',
  'fbx',
  'obj',
  '3ds',
  'dae',
  'blend',
  'c4d',
  'ma',
  'mb',
  'rvt',
  'ifc',
  'stl',
  'gltf',
  'glb',
  '3dm',
  'usd',
  'usda',
  'usdz',
  'abc'
]

/** 行分类的中文文案（tooltip） */
export const FILE_ROW_KIND_LABEL: Record<FileRowKind, string> = {
  image: '图片',
  model: '模型文件',
  other: '文件'
}

/**
 * 行分组顺序：**模型 → 图片 → 其他**（2026-10 用户反馈改口径）。
 *
 * 用户原话：「模型的界面，就是点进来的这个文件夹，SKP 后缀的这一个文件应该排在第一位，
 * 而不是 JPG 这些材质排在第一位」。
 *
 * 理由（用户实际使用路径）：进文件夹的第一诉求是**把主模型拖进 SketchUp**，
 * 预览图 / 贴图是"看这个包值不值得用"的次要信息，`.json` / `.txt` / 说明文件是杂项。
 * 组内再按文件名**自然序**（`img2` 排在 `img10` 前面），比纯字节序符合文件管理器习惯。
 *
 * ⚠️ 只改这里的权重，**不要动 `fileRowKindOf` 的判定口径**（图标 / 其它模块依赖它）。
 * 另有第二条次级键：模型组内 `.skp` 优先（见 `buildFileRows` 的排序链，用户 2026-10-22 口径）。
 */
const KIND_ORDER: Record<FileRowKind, number> = { model: 0, image: 1, other: 2 }

/** 自然序比较器（数字段按数值比较）；模块级复用以避免每行新建 collator */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 单个文件的分类（导出仅供测试与其它纯逻辑复用） */
export function fileRowKindOf(file: Pick<AssetFile, 'ext' | 'kind'>): FileRowKind {
  const ext = (file.ext ?? '').toLowerCase()
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (MODEL_EXTS.includes(ext) || file.kind === 'model') return 'model'
  return 'other'
}

/** 扩展名 → 徽标文案：大写；无扩展名返回空串（UI 据此不渲染徽标） */
export function extLabelOf(ext: string): string {
  const e = (ext ?? '').trim()
  if (e.length === 0) return ''
  // 超长「扩展名」多半是文件名里带点（`v1.2.final`），截断避免撑破行
  return e.toUpperCase().slice(0, 6)
}

/**
 * `Asset.files` → 文件行列表（**已排序**，纯函数、零 IO）。
 *
 * - 绝对路径一律走 `assetFileAbs`（按 `asset.folder` 的路径形态选分隔符，
 *   **不手拼反斜杠**——测试夹具用 posix 路径时也能正确拼接）；
 * - 体积文案在这里就格式化好，组件不再重复调用 `formatBytes`；
 * - `files` 为空 / 非数组时返回 `[]`（空态由组件渲染）。
 */
export function buildFileRows(asset: Pick<Asset, 'folder' | 'files'>): FileRow[] {
  const files = Array.isArray(asset.files) ? asset.files : []
  const rows = files.map((f) => {
    const kind = fileRowKindOf(f)
    const ext = (f.ext ?? '').toLowerCase()
    return {
      rel: f.rel,
      name: f.name,
      ext,
      extLabel: extLabelOf(ext),
      size: f.size,
      sizeText: formatBytes(f.size),
      kind,
      kindLabel: FILE_ROW_KIND_LABEL[kind],
      absPath: assetFileAbs(asset.folder, f.rel),
      isImage: kind === 'image'
    }
  })
  // Array.prototype.sort 自 ES2019 起稳定：完全相等的行保持 `files` 原序
  return rows.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    if (byKind !== 0) return byKind
    /**
     * 同属模型组：`.skp` 优先。
     *
     * 用户原话（2026-10-22 追加口径）：「**SKP 后缀的这一个文件应该排在第一位**」——
     * 字面就是 skp 最前，不是"模型组最前"。一个包里同时有 `.max` / `.skp` 时，
     * 把 `.max` 排第一会被用户当成"没改"。
     *
     * ⚠️ 只对 `model` 组加这一档次级键，**image / other 组保持原有自然序**；
     * 也**不要**推广成"所有模型扩展名的优先级表"（`.skp > .max > .obj …` ——
     * 用户只点名了 SKP，多排一档等于替他做决定）。
     * `ext` 在映射阶段已小写化，这里直接比 `'skp'`。
     */
    if (a.kind === 'model') {
      const bySkp = Number(b.ext === 'skp') - Number(a.ext === 'skp')
      if (bySkp !== 0) return bySkp
    }
    const byName = NAME_COLLATOR.compare(a.name, b.name)
    if (byName !== 0) return byName
    return NAME_COLLATOR.compare(a.rel, b.rel)
  })
}

/** 文件列表摘要（中栏头「N 个文件 · 合计大小」） */
export interface FileViewSummary {
  count: number
  totalBytes: number
  /** 已拼好的展示文案，如 `12 个文件 · 34.5 MB` */
  text: string
}

/**
 * 统计文件数与合计大小。
 *
 * 合计**由 files 累加**而不是读 `asset.size`：`asset.size` 是索引快照，
 * 手动封面写盘后可能与 files 短暂漂移（见 store.setCoverFromImage 的注释）。
 */
export function summarizeFiles(files: readonly AssetFile[] | undefined): FileViewSummary {
  const list = Array.isArray(files) ? files : []
  const totalBytes = list.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0)
  return {
    count: list.length,
    totalBytes,
    text: `${list.length} 个文件 · ${formatBytes(totalBytes)}`
  }
}

/** 资产版摘要（组件少写一行 `.files`） */
export function summarizeAsset(asset: Pick<Asset, 'files'>): FileViewSummary {
  return summarizeFiles(asset.files)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 中栏**框选**（marquee / 橡皮筋）的几何纯逻辑
 *
 * 为什么放在这个模块：中栏的交互几何（矩形归一化 / 相交判定 / 命中排序）是纯数学，
 * 必须能在 node 环境单测（`tests/marqueeSelection.test.ts`）——组件里只剩 DOM 采样与
 * 事件状态机。坐标系统一是**滚动容器的内容坐标**（px，左上角为原点，已加 scrollTop /
 * scrollLeft），因此滚动时矩形与卡片一起走，不需要每次 mousemove 再查 DOM。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 轴对齐矩形（内容坐标系，px） */
export interface BoxRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 两点 → 归一化矩形（支持向左上拖：宽高恒为正） */
export function boxOf(ax: number, ay: number, bx: number, by: number): BoxRect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by)
  }
}

/**
 * 两矩形是否**相交**（用户口径：手指拖框 1px 擦到卡片就算选中，不要求完全包含）。
 *
 * 用严格不等号：仅边界相切（`a.right === b.left`）不算命中 —— 否则卡片之间 14px 的
 * 缝隙里拖过一条 0.5px 的线会把两侧的卡全选中，手感发飘。
 * 任一矩形是**零面积**（宽或高为 0，例如按下未过阈值的点）也一律不命中。
 */
export function boxesIntersect(a: BoxRect, b: BoxRect): boolean {
  if (a.left >= a.right || a.top >= a.bottom) return false
  if (b.left >= b.right || b.top >= b.bottom) return false
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/**
 * 框选命中：返回 `order`（= 渲染顺序）中与 `box` 相交的 id。
 *
 * - 只遍历**渲染顺序**而不是矩形表，保证 `selectMany` 拿到的顺序与视觉一致
 *   （决定 `selectedId` / Shift 锚点，顺序错会让详情面板显示"另一张卡"）；
 * - 未采集到矩形（虚拟滚动未渲染）的 id 直接跳过 —— 看不见的卡片不该被选中。
 */
export function marqueeHitIds(
  rects: ReadonlyMap<string, BoxRect>,
  order: readonly string[],
  box: BoxRect
): string[] {
  const hits: string[] = []
  for (const id of order) {
    const r = rects.get(id)
    if (!r) continue
    if (boxesIntersect(r, box)) hits.push(id)
  }
  return hits
}
