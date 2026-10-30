import type { AssetFile, AssetKind, CoverSource } from './types'
import {
  findPbrSlotInStem,
  MATERIAL_PACK_REQUIRED_SLOTS,
  type PbrSlot
} from './pbrSlots'

/** 扩展名 → 大类映射表（键为小写、不含点） */
export const EXT_KIND: Record<string, AssetKind> = {
  // ── 模型 ──
  skp: 'model', skb: 'model', '3ds': 'model', '3dm': 'model', max: 'model',
  fbx: 'model', obj: 'model', dae: 'model', blend: 'model',
  rvt: 'model', rfa: 'model', stl: 'model', ply: 'model',
  glb: 'model', gltf: 'model', abc: 'model', usd: 'model', usda: 'model',
  usdc: 'model', mb: 'model', ma: 'model', c4d: 'model', zpr: 'model',
  sldprt: 'model', sldasm: 'model', ipt: 'model', iam: 'model', f3d: 'model',
  x_t: 'model', step: 'model', stp: 'model', igs: 'model', iges: 'model',
  scn: 'model', rho: 'model', lwo: 'model', lws: 'model', xsi: 'model',
  // ── CAD 图纸（2026-10-29 从 model 拆出：独立目录 / 独立侧栏 / 正确图标） ──
  dwg: 'cad', dxf: 'cad',
  // ── HDRI ──
  hdr: 'hdri', exr: 'hdri',
  // ── 贴图 ──
  png: 'texture', jpg: 'texture', jpeg: 'texture', tga: 'texture',
  tif: 'texture', tiff: 'texture', bmp: 'texture', webp: 'texture',
  psd: 'texture', dds: 'texture', gif: 'texture', svg: 'texture', jfif: 'texture',
  // ── 材质预设 ──
  vismat: 'material', mat: 'material', mi: 'material', sbsar: 'material',
  ies: 'material', vismat_preset: 'material', matlib: 'material'
}

// ── 大类显示名 vs 磁盘目录名（2026-10-19 材质大类合并，docs/14 §2.1） ──────────
//
// ⛔ 硬约束（docs/14 §0.1-1）：**`KIND_LABEL` 只用于 UI 显示，永远不能用来拼路径**；
//    拼路径只准用 `kindFolder()`（它查 `KIND_FOLDER`）。任何"两者混用"都是 bug。
//    合并前二者是同一个常量（`kindFolder = KIND_LABEL[kind]`），现已解耦：
//    `texture` 显示「贴图」但落盘「材质」，`material` 显示「材质预设」但落盘「材质」。

/** 大类显示名（**仅 UI 显示**；磁盘目录名见 `KIND_FOLDER`） */
export const KIND_LABEL: Record<AssetKind, string> = {
  model: '模型',
  texture: '贴图',
  hdri: 'HDRI',
  material: '材质预设',
  cad: 'CAD图纸',
  other: '其他'
}

/**
 * 大类文件夹名（落盘用）。与 `KIND_LABEL`（显示用）**解耦**：
 * `texture` 与 `material` **共用「材质」**（两个 kind 落同一个目录，kind 只作属性维度）。
 *
 * 用数据表而非 switch：① 可被测试整体遍历；② `main` 侧的安全门需要"合法目录名集合"这一概念；
 * ③ "哪些 kind 共用一个目录"是可查询的（`kindFolder(a) === kindFolder(b)`）。
 */
export const KIND_FOLDER: Record<AssetKind, string> = {
  model: '模型',
  texture: '材质',
  hdri: 'HDRI',
  material: '材质',
  // CAD 独立大类目录（第 6 个顶层目录）：图纸与模型混放会让「模型」计数失真
  cad: 'CAD',
  other: '其他'
}

/** 历史大类目录名 → kind（**只读兼容**：扫描要认，写入永不用；docs/14 §0.1-2） */
export const LEGACY_KIND_FOLDER: Readonly<Record<string, AssetKind>> = {
  贴图: 'texture',
  材质预设: 'material'
}

/**
 * 被多个 kind 共用的大类目录名（当前只有「材质」）——反解时无法确定唯一 kind。
 * 由 `KIND_FOLDER` 派生，将来再合并大类时自动生效（不需要手改这个集合）。
 */
const AMBIGUOUS_KIND_FOLDERS: ReadonlySet<string> = (() => {
  const counts = new Map<string, number>()
  for (const folder of Object.values(KIND_FOLDER)) {
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [folder, n] of counts) if (n > 1) out.add(folder)
  return out
})()

/** 分组哨兵：`{texture, material}` 两类在侧栏/筛选里是一个「材质」节点。
 *  ⚠️ **必须**叫 `'materialGroup'`，**不能**叫 `'material'`（后者与 `AssetKind.material` 同名，
 *  `filters.kind === 'material'` 会同时命中"只看材质预设"与"看整个材质大类"——静默 bug）。 */
export const MATERIAL_GROUP = 'materialGroup' as const

/** 分组标识（当前只有材质分组） */
export type KindGroup = typeof MATERIAL_GROUP

/** 筛选器的大类维度：单个 kind / 分组哨兵 / 全部 */
export type KindFilter = AssetKind | KindGroup | 'all'

/** 分组 → 成员的**唯一定义处**（不要在组件里再写 `['texture','material']`） */
export const KIND_GROUP_MEMBERS: Readonly<Record<KindGroup, readonly AssetKind[]>> = {
  materialGroup: ['texture', 'material']
}

/** 过滤语义的唯一入口：`null` = 不筛；`Set` = 命中任一即出 */
export function kindsOfFilter(f: KindFilter): ReadonlySet<AssetKind> | null {
  if (f === 'all') return null
  const members = (KIND_GROUP_MEMBERS as Readonly<Record<string, readonly AssetKind[]>>)[f]
  return new Set(members ?? [f as AssetKind])
}

/** 筛选维度显示名：`'all'`→「全部」；`AssetKind`→`KIND_LABEL`；`materialGroup`→「材质」 */
export function kindFilterLabel(f: KindFilter): string {
  if (f === 'all') return '全部'
  if (f === MATERIAL_GROUP) return KIND_FOLDER.texture
  return KIND_LABEL[f]
}

/**
 * 某个大类视图里「这个筛选维度有没有意义」——**唯一能力表**。
 *
 * 背景（2026-10 用户反馈）：「分辨率这个功能在材质和 HDR 的界面都会失效」「材质面板的顶栏
 * 不需要出现风格的选项，HDR 也不需要」「模型界面的顶栏也不需要显示分辨率」。
 * 这些都不是"入口藏起来就行"的 UI 问题——入口隐藏了但筛选值仍生效时，网格会空着且
 * 用户找不到原因（见 `sanitizeFiltersForKind`）。
 *
 * 口径（照抄，不要在组件里另判）：
 * - `model`：封面是 720px 渲染图，按它筛"分辨率"没有意义 → 不给分辨率；风格主战场 → 给风格；
 * - `texture` / `material`：贴图长边就是真实规格 → 给分辨率；材质不挂风格（`DetailPanel` 已如此）→ 不给；
 * - `hdri`：全景宽度是硬规格 → 给分辨率；用户明确"不需要风格" → 不给；
 * - `cad`：图纸不是位图 → 没有分辨率；站方无风格轴 → 不给风格；模型格式只认 skp/max → 不给；
 * - `other`：兜底不给任何入口。
 */
export interface KindFilterCaps {
  resolution: boolean
  style: boolean
  /**
   * 模型格式维度（2026-10「3DMAX 支持」）：只有 `model` 视图开放
   * （全部 / SU / 3DMAX 单选）。材质 / HDR / 其他视图入口不渲染，
   * 且 `sanitizeFiltersForKind` 会把残留值清掉（与分辨率同一套机制）。
   * 「全部」视图取并集 → true：格式条件只对 kind=model 的资产生效，
   * 在「全部」里筛 3DMAX 仍能看到其它大类资产。
   */
  modelFormat: boolean
}

export const KIND_FILTER_CAPS: Record<AssetKind, KindFilterCaps> = {
  model: { resolution: false, style: true, modelFormat: true },
  texture: { resolution: true, style: false, modelFormat: false },
  material: { resolution: true, style: false, modelFormat: false },
  hdri: { resolution: true, style: false, modelFormat: false },
  // CAD：图纸不是位图 → 没有"分辨率"；站方无风格轴 → 没有风格；
  // 模型格式筛选只认 skp/max（`getModelFormat`）→ CAD 不参与
  cad: { resolution: false, style: false, modelFormat: false },
  other: { resolution: false, style: false, modelFormat: false }
}

const ALL_ASSET_KINDS = Object.keys(KIND_FILTER_CAPS) as AssetKind[]

/**
 * 能力判定的**唯一入口**（组件 / store / 纯逻辑都调它）。
 *
 * ⚠️ 禁止在别处写 `filters.kind !== 'model'` 这类硬编码大类判断：
 * ① 分组哨兵（materialGroup）会被漏掉；② 将来加维度 / 加大类时必然漏改；
 * ③ `tests/filterCaps.test.ts` 有源码守卫盯着 `App.tsx`。
 *
 * `'all'` = 所有真实 kind 的**并集**（任一支持即 true）；`materialGroup` = 看它的成员。
 */
export function capsOfFilter(f: KindFilter, cap: keyof KindFilterCaps): boolean {
  if (f === 'all') return ALL_ASSET_KINDS.some((k) => KIND_FILTER_CAPS[k][cap])
  const kinds = kindsOfFilter(f)
  if (!kinds) return false
  for (const k of kinds) if (KIND_FILTER_CAPS[k]?.[cap] === true) return true
  return false
}

/**
 * 侧栏/导航显示顺序（docs/14 §2.4 / §6.1）：`texture` 与 `material` 合并为一个
 * 「材质」节点（哨兵 `'materialGroup'`），展开后由两个 kind chip 单独筛选。
 *
 * 2026-10-29 加入 `'cad'`（第 2 位，紧跟模型）后：模型 / CAD图纸 / 材质 / HDRI / 其他
 * —— HDRI 从第 3 位挪到第 4 位、其他仍在末位。
 *
 * ⚠️ 这是**导航序的唯一来源**。旧的 5 元 `KIND_ORDER` 已随材质合并删除
 * （它会把两个材质类画成两行，且类型上无法表达分组）。
 */
export const KIND_NAV_ORDER: ReadonlyArray<AssetKind | KindGroup> = [
  'model',
  // CAD 紧跟在模型之后（2026-10-29）：都是"工程文件"，视觉上相邻；但独立成节点，
  // 点它只筛图纸（不再混进模型计数）
  'cad',
  MATERIAL_GROUP,
  'hdri',
  'other'
]

/**
 * 判定"资产主大类"时的优先级：一个包里同时有 skp 和贴图 → 算模型。
 *
 * `'cad'` 刻意排在 `'model'` **之后**：同时含 `.skp` 与 `.dwg` 的包应判 `'model'`
 * （模型是主内容、图纸是附件）；只有图纸、没有模型时才落到 `'cad'`。
 */
const KIND_PRIORITY: AssetKind[] = ['model', 'cad', 'material', 'hdri', 'texture', 'other']

// ── PBR 材质包识别（2026-10 用户装机反馈：Crystal/AmbientCG 样本 B） ──────────
//
// 样本 B 结构（已核实）：`Brick_Rough_vh1sbjl_2K_surface_ms.zip`，8 项扁平：
//   vh1sbjl_2K_{Albedo,AO,Normal,Roughness,Displacement.jpg,Displacement.exr}
//   + vh1sbjl_2K.json + Brick_Rough_vh1sbjl_surface_Preview.png
// 问题：该包含 `.exr`（Displacement.exr → kind=hdri），`primaryKind` 命中 hdri，
// 材质包落进 HDRI 大类——错的，用户在 HDRI 分类里找不到材质。
//
// 裁定规则（主理人）：**同前缀 PBR 槽位齐全**（Albedo/BaseColor + Normal +
// Roughness 三类同前缀同时存在）→ 判定 `material` 大类，优先级高于 hdri/texture
// （但低于 model——带 skp 的包仍然是模型）。

/** PBR 槽位类型与关键词表统一取自 `shared/pbrSlots.ts`（唯一权威表，2026-10 DEF-07） */
export type { PbrSlot } from './pbrSlots'

/**
 * 检测文件列表是否构成 **PBR 材质包**（主理人裁定，2026-10）。
 *
 * 规则：按 `目录 + 文件名前缀` 分组（大小写不敏感），任一组同时集齐
 * Albedo/BaseColor、Normal、Roughness 三个槽位 → 是材质包，返回该组前缀
 * （小写；仅用于日志/测试观测，调用方只关心非 null）；否则返回 null。
 *
 * 只统计图片类文件（texture/hdri）——`.json` 元数据、`Preview.png` 等
 * 不是槽位文件，天然不参与分组。前缀含目录可避免跨目录散装文件被误并组
 * （`Wood/Albedo.png` + `Metal/Normal.png` 不会凑成一组）。
 *
 * 纯函数、零 IO，单测见 `tests/classify.test.ts` 的 detectMaterialPack 组。
 */
export function detectMaterialPack(files: Pick<AssetFile, 'rel' | 'kind'>[]): string | null {
  const groups = new Map<string, Set<PbrSlot>>()
  for (const f of files) {
    if (f.kind !== 'texture' && f.kind !== 'hdri') continue
    const slash = f.rel.lastIndexOf('/')
    const dir = slash > 0 ? f.rel.slice(0, slash).toLowerCase() : ''
    const base = slash > 0 ? f.rel.slice(slash + 1) : f.rel
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    // 槽位与前缀统一由 shared 权威表判定（含 color/diff/NormalGL/nor_gl 等新词）
    const hit = findPbrSlotInStem(stem)
    if (!hit) continue
    const key = dir ? `${dir}/${hit.prefix.toLowerCase()}` : hit.prefix.toLowerCase()
    let slots = groups.get(key)
    if (!slots) {
      slots = new Set()
      groups.set(key, slots)
    }
    slots.add(hit.slot)
  }
  for (const [prefix, slots] of groups) {
    // 必需槽位由 shared 表定义：Albedo/BaseColor + Normal + Roughness
    const complete = MATERIAL_PACK_REQUIRED_SLOTS.every((s) => slots.has(s))
    if (complete) return prefix
  }
  return null
}

/** 解压/导入时忽略的系统垃圾文件 */
export const IGNORED_NAMES = new Set([
  '.ds_store', 'thumbs.db', 'desktop.ini', 'zone.identifier'
])

// ── 下载站杂质判定（2026-10 用户装机反馈：知末包里的二维码/说明/推广页） ──
//
// 知末网压缩包典型结构（用户截图证实）：
//   中古侘寂屏风_木屏风_…/      ← 真正的模型文件夹
//   微信扫码 看案例找灵感….jpg  ← 推广垃圾
//   知末SU-掌握行业前沿….html   ← 推广垃圾
//   知末网说明.txt              ← 推广垃圾
// 判定为 junk 的文件：不进 files 列表、不参与封面挑选、不计入体积。

/** 文件名命中的推广/垃圾词（大小写不敏感） */
const JUNK_NAME_RE = /微信扫码|知末|推广|说明|必用|下载|扫码|二维码|qrcode/i

/** 纯文档/网页/快捷方式扩展名：模型包里出现即杂质 */
const JUNK_EXTS = new Set(['html', 'htm', 'txt', 'url'])

/** 经典垃圾文件名（与 IGNORED_NAMES 重叠的部分保持双保险，防直接调本函数的调用方漏掉） */
const JUNK_EXACT_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

/**
 * 判定文件名是否为下载站杂质。
 *
 * 三条规则任一命中即 junk：
 * ① 文件名含推广词（微信扫码 / 知末 / 推广 / 说明 / 必用 / 下载 / 扫码 / 二维码…）；
 * ② 扩展名 ∈ {.html, .htm, .txt, .url}；
 * ③ 经典垃圾名（desktop.ini / Thumbs.db / .DS_Store）。
 *
 * 纯函数、零 IO，单测见 `tests/junkClassify.test.ts`。
 */
export function isJunkFileName(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  if (JUNK_EXACT_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  if (JUNK_EXTS.has(ext)) return true
  return JUNK_NAME_RE.test(name)
}

/** 拖出 / 双击定位时的主模型文件优先级（P0-14 / PRD Q3） */
export const PRIMARY_MODEL_EXTS = ['skp', 'max', 'fbx', 'obj', '3ds'] as const

/** 根目录层预览词：必须位于**资产根目录层**，不能是 `Textures/` 子目录里的（C3） */
export const PREVIEW_NAME_RE =
  /预览|效果|主图|封面|展图|晒图|thumbnail|preview|cover|render|poster/i

/**
 * 资产封面文件的文件名判定（**纯函数**）：`<资产名>.cover.jpg/png`。
 *
 * 落盘来源都走 `main/coverImage.ts#coverFileName` 的同族命名：
 * - 知末抓取的主图（`main/zhimoCover.ts` → `<资产名>.cover.jpg`）；
 * - 用户「截图替换封面」拍照保存（`<资产名>.cover.png`）。
 *
 * 只认 `.cover.` 这个受控后缀、不认"名字里带 cover"：后者已经被
 * `PREVIEW_NAME_RE` 的预览词阶段覆盖（cover 也是预览词之一），
 * 两个阶段分开判定才能表达「主图 > 预览词」的优先级。
 */
export function isCoverAssetImage(name: string): boolean {
  return /\.cover\.(jpe?g|png)$/i.test(name)
}

export function kindOfExt(ext: string): AssetKind {
  return EXT_KIND[ext.toLowerCase().replace(/^\./, '')] ?? 'other'
}

/**
 * 「CAD 图纸」扩展名 —— **历史语义对齐用的独立常量，刻意不与 `EXT_KIND` 耦合**。
 *
 * 用途只有一个：识别 **0.8.x 时代导入**的图纸资产（那时 `EXT_KIND` 把 `dwg` 映射成
 * `model`，所以那批记录的 `files[].kind` 停在 `'model'`）。存量大类迁移
 * （`main/kindMigrate.ts` + `store.migrateLegacyKind`）用它判断"这个包里有没有图纸"。
 *
 * ⛔ **不要**改成 `Object.entries(EXT_KIND).filter(([, k]) => k === 'cad')`：
 * 那会让判据随**当前**词表漂移，而这份常量的职责恰恰是记住**过去**的语义。
 * 将来 `EXT_KIND` 若再拆出别的 CAD 扩展名，正解是往这里手工加一项 + 补单测，
 * 而不是让两份语义自动耦合（耦合后某天改 `EXT_KIND` 会静默改变迁移范围）。
 */
export const LEGACY_CAD_EXTS: ReadonlySet<string> = new Set(['dwg', 'dxf'])

/** 是否「存量 CAD 扩展名」（小写比较；落库的 `ext` 已是小写，这里兜一层防手写数据） */
export function isLegacyCadExt(ext: string | undefined): boolean {
  return typeof ext === 'string' && LEGACY_CAD_EXTS.has(ext.toLowerCase())
}

/**
 * 从文件列表推断资产主大类。
 *
 * 优先级（2026-10 材质包裁定后）：model > **PBR 材质包（material）** >
 * material 扩展名 > hdri > texture > other。
 * 材质包判定插在 model 之后、hdri 之前：样本 B（含 .exr 的 AmbientCG 包）
 * 曾被误判进 HDRI；同前缀 Albedo+Normal+Roughness 齐全即材质包。
 */
export function primaryKind(files: Pick<AssetFile, 'rel' | 'kind'>[]): AssetKind {
  if (files.length === 0) return 'other'
  const present = new Set(files.map((f) => f.kind))
  if (!present.has('model') && detectMaterialPack(files) !== null) return 'material'
  for (const k of KIND_PRIORITY) if (present.has(k)) return k
  return 'other'
}

export interface CoverPick {
  /** 封面相对资产文件夹的路径（posix 分隔） */
  rel: string
  /** 命中级别，落库为 asset.coverSource */
  source: CoverSource
}

export interface PickCoverOptions {
  /** 从 .skp / .max 内嵌提取出的缩略图（P1-2 预留，本轮一般不传） */
  embeddedThumbRel?: string
}

/**
 * 封面候选排序（P0-8 / C3 四级回退 + 2026-10 用户裁定：**cover > preview**）：
 * ① `cover` 根目录层 `<资产名>.cover.jpg/png`（知末抓的主图 / 用户拍照保存）
 * ② `named` 根目录层名字命中预览词（含 `*.preview.*` —— SKP 内嵌提取图落的就是这个名）
 * ③ `root` 根目录层首张图片
 * ④ `embedded` 内嵌缩略图（P1-2 预留）
 * ⑤ `largest` 全资产最大图
 * ⑥ `null` → UI 用类型占位图标（`placeholder`）
 *
 * 为什么加 ①：重装 ID BOX 后模型重扫，库里同时躺着 `*.cover.jpg`（知末主图）与
 * `*.preview.jpg`（SKP 内嵌提取图）—— 两者都命中预览词，旧实现取 `find()` 的第一个，
 * 结果跟着 readdir 顺序漂移，经常选中内嵌灰图。裁定：**有 cover 就用 cover，
 * 没有才用 preview**。①② 落库都用既有 `coverSource='named'`，**不改 schema**。
 *
 * ⚠️ 本函数只服务"自动候选"。用户手动设置（`coverSource='manual'`）与知末已抓
 * （`'zhimo'`）的封面由渲染层 rescan 合并的 `keepStickyCover` 守卫，不会被本函数顶掉。
 */
export function pickCover(files: AssetFile[], opts?: PickCoverOptions): CoverPick | null {
  const images = files.filter((f) => f.kind === 'texture' || f.kind === 'hdri')
  if (images.length === 0) return null

  // 根目录层 = rel 中不含 '/'（contentRoot 剥离后，根目录层就是资产自己的一层）
  const rootImages = images.filter((f) => !f.rel.includes('/'))

  // ① 封面文件最优先（cover > preview，2026-10 裁定）。
  //    按 rel 字典序取第一个：同时存在 .cover.jpg 与 .cover.png 时结果确定，
  //    不吃 readdir 顺序（预览词阶段的老毛病不能再犯一遍）。
  const coverFile = rootImages
    .filter((f) => isCoverAssetImage(f.name))
    .sort((a, b) => a.rel.localeCompare(b.rel))[0]
  if (coverFile) return { rel: coverFile.rel, source: 'named' }

  const named = rootImages.find((f) => PREVIEW_NAME_RE.test(f.name))
  if (named) return { rel: named.rel, source: 'named' }

  if (rootImages.length > 0) {
    const sorted = [...rootImages].sort((a, b) => a.rel.localeCompare(b.rel))
    return { rel: sorted[0].rel, source: 'root' }
  }

  if (opts?.embeddedThumbRel) {
    return { rel: opts.embeddedThumbRel, source: 'embedded' }
  }

  const largest = images.reduce((a, b) => (b.size > a.size ? b : a))
  return { rel: largest.rel, source: 'largest' }
}

/**
 * 主文件（P0-14）：`.skp > .max > .fbx > .obj > .3ds > 首个模型文件 > 首个 CAD 文件 > files[0]`
 *
 * ⚠️ **`cad` 必须显式收进来**（2026-10-29，CAD 拆出独立 kind 时补）：
 * 这个函数的返回值不是"显示用"的，它驱动**拖出到 SketchUp/CAD 的文件**与
 * **双击进文件视图后默认选中的文件**。CAD 从 `model` 迁到 `cad` 之后，
 * 纯 CAD 资产里再也找不到 `kind === 'model'` 的文件，若不补这一支就会直接落到
 * `files[0]` —— 而 `files[0]` 是**目录遍历顺序**，不是语义顺序：
 * 包里只要有一张 `预览图.jpg`，拖出就会拖走那张 jpg 而不是 `.dwg`
 * （样本包刚好只剩 dwg 一个文件，所以这个问题在样本上不会暴露，属于"运气"）。
 *
 * 顺序在 `model` **之后**：混合包（skp + dwg）里模型仍是主文件（与 `KIND_PRIORITY`
 * 同口径 —— 模型是主内容，图纸是附件）。
 */
export function pickPrimaryFile(files: AssetFile[]): AssetFile | undefined {
  if (files.length === 0) return undefined
  for (const ext of PRIMARY_MODEL_EXTS) {
    const hit = files.find((f) => f.ext.toLowerCase() === ext)
    if (hit) return hit
  }
  const model = files.find((f) => f.kind === 'model')
  if (model) return model
  const cad = files.find((f) => f.kind === 'cad')
  return cad ?? files[0]
}

/**
 * 库内大类文件夹名（**落盘唯一入口**）。未知 kind 返回空串（保留既有 truthiness 守卫语义）。
 *
 * ⚠️ `texture` 与 `material` 都返回「材质」——两者共用同一个大类目录。
 * 拼路径必须用它，**不要**用 `KIND_LABEL`（那是显示名，docs/14 §0.1-1）。
 */
export function kindFolder(kind: AssetKind): string {
  return KIND_FOLDER[kind] ?? ''
}

/**
 * 目录名 → kind（反解，**只读兼容**语义）。
 *
 * - `模型 / HDRI / 其他` → 对应 kind
 * - `贴图 / 材质预设`（历史别名）→ `texture / material`
 * - **`材质` → `null`**：被 `texture` 与 `material` 共用，无法唯一反解；
 *   调用方（`rescan`）此时按内容判定，内容也判不出时兜底 `texture`（docs/14 §2.1）。
 * - 其它未知名 → `'other'`（保持合并前的反查行为：未知顶层目录即"其他"）
 *
 * ⛔ 不要为 `'材质'` 加任何启发式（按扩展名再猜 / 按资产名猜）——见 docs/14 §2.1 的禁止项。
 */
export function kindFromFolderName(name: string): AssetKind | null {
  if (!name) return 'other'
  if (AMBIGUOUS_KIND_FOLDERS.has(name)) return null
  for (const [kind, folder] of Object.entries(KIND_FOLDER) as Array<[AssetKind, string]>) {
    if (folder === name) return kind
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_KIND_FOLDER, name)) {
    return LEGACY_KIND_FOLDER[name]!
  }
  return 'other'
}

/**
 * 是否是合法的大类目录名（**含历史别名**）。
 *
 * 这是 `asset:assignCategory` 的安全门（`main/index.ts`）：渲染层传来的
 * `kindFolderName` 必须落在这个集合里，否则视为攻击/错误入参并拒绝。
 * 历史别名也放行纯粹是为了兼容旧调用方；新写入只会是 `KIND_FOLDER` 的值。
 */
export function isKindFolderName(name: string): boolean {
  if (!name) return false
  for (const folder of Object.values(KIND_FOLDER)) if (folder === name) return true
  return Object.prototype.hasOwnProperty.call(LEGACY_KIND_FOLDER, name)
}
