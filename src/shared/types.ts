import type { BallParamScales } from './ballParams'
import type { ClassifyConfidence } from './classifyCrossCheck'

/** 7-Zip 官方下载页（未就绪时给用户的可行动入口） */
export const SEVEN_ZIP_DOWNLOAD_URL = 'https://7-zip.org/'

/**
 * 资产大类：模型 / 贴图 / HDRI / 材质预设 / **CAD 图纸** / 其他
 *
 * `'cad'`（2026-10-29 拆出）：CAD（`.dwg` / `.dxf`）此前映射成 `'model'`，代价是
 * 图纸落进 `模型/` 目录、卡片显示立方体图标并写「模型」、文件视图归到「模型」分组。
 * 拆成独立大类的理由：**独立落盘目录**（`CAD/`）、**独立侧栏筛选节点**、
 * **卡片标签与图标语义正确**；顺带让 `AssetGrid` 里那些
 * `kind === 'model' && isSketchUpAsset(...)` 的手工守卫不再需要为图纸兜底。
 *
 * ⚠️ 优先级刻意**低于** `'model'`（见 `classify.ts` 的 `KIND_PRIORITY`）：一个包里
 * 同时有 `.skp` 与 `.dwg` 时，模型是主内容、图纸是附件 → 仍判 `'model'`。
 */
export type AssetKind = 'model' | 'texture' | 'hdri' | 'material' | 'cad' | 'other'

/**
 * 原压缩包处置三档（P0-5，替代旧布尔值 `trashArchiveAfterImport`）：
 * - `recycle`：移入 Windows 回收站（默认，可恢复）
 * - `delete`：彻底删除
 * - `keep`：保留原包
 */
export type ArchiveDisposal = 'recycle' | 'delete' | 'keep'

/** 旧版 settings.json 用的 'trash' 与 'recycle' 等价，读档时按此表归一化 */
export const LEGACY_DISPOSAL_ALIASES: Record<string, ArchiveDisposal> = {
  trash: 'recycle',
  recycle: 'recycle',
  delete: 'delete',
  keep: 'keep'
}

/** 三档处置的中文标签（设置页 / 错误文案复用） */
export const DISPOSAL_LABEL: Record<ArchiveDisposal, string> = {
  recycle: '移入回收站',
  delete: '彻底删除',
  keep: '保留原包'
}

// ── C 线：库内「最近删除」+ 保留期四档（docs/20 §4，用户 2026-10 拍板） ──────
//
// 删除语义从"直接进系统回收站"改成"先移到库内 `.trash/`，到期/超容量/手动清空才进
// 系统回收站"。这是**真实语义变更**（磁盘空间不会立刻释放），UI 必须显式说明。

/**
 * 删除策略四档：
 * - `'5d' | '10d' | '30d'`：移到 `<库根>/.trash/<id>/`，保留对应天数，可随时还原；
 * - `'recycle'`：直接进系统回收站（旧行为不变，5 秒撤销条）。
 *
 * 默认 `'30d'`（对用户最安全）。
 */
export type TrashRetention = '5d' | '10d' | '30d' | 'recycle'

/** 四档合法值（zod / normalize / UI 分段控件共用，避免各处手写数组） */
export const TRASH_RETENTION_VALUES: readonly TrashRetention[] = ['5d', '10d', '30d', 'recycle']

/** 设置页 / 「最近删除」页文案（用户原话可核对） */
export const TRASH_RETENTION_LABEL: Record<TrashRetention, string> = {
  '5d': '保留 5 天',
  '10d': '保留 10 天',
  '30d': '保留 30 天（推荐）',
  recycle: '直接进系统回收站'
}

/** 档位 → 保留天数；`recycle` 不进库内回收区，天数记 0（调用方遇到 0 应跳过保留期判定） */
export const TRASH_RETENTION_DAYS: Record<TrashRetention, number> = {
  '5d': 5,
  '10d': 10,
  '30d': 30,
  recycle: 0
}

/** 解压码页策略：`auto` = 先按 GBK 解，嗅探到乱码再换 UTF-8 重解一次 */
export type Codepage = 'gbk' | 'utf8' | 'auto'

/**
 * UI 主题（UI 设计规范 v0.2 §1）：`light` = Soft UI 浅色 / `dark` = Vibrancy 深色 /
 * `system` = 跟随 Windows 深浅色设置（0.6.0 起为真功能，之前只是设置页的禁用占位）。
 *
 * ⚠️ `dataset.theme` 只接受 `light` / `dark` —— `system` 必须在应用前经
 * `resolveTheme()`（`shared/theme.ts`）解析成实际值，别把 'system' 直接写进 DOM。
 */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * 动效性能档位（设置·外观「动效性能」三档，2026-10 用户反馈「动画不够顺」）。
 *
 * 语义只有三档：`smooth` = 省电优先 / `balanced` = 默认平衡 / `ultra` = 画质优先。
 * 每一档到渲染参数的映射**只写在** `shared/motionQuality.ts`（纯函数、无 three 依赖），
 * 渲染层与设置页都从那里读 —— 这里是持久化用的联合类型，别在别处再写一份阈值。
 */
export type MotionQuality = 'smooth' | 'balanced' | 'ultra'

/** 缩略图状态：`none`=未生成 / `ready`=已生成 / `failed`=生成失败 */
export type ThumbStatus = 'ready' | 'failed' | 'none'

/**
 * 别名映射记录（0.6.0「别名映射表」的持久化形态）。
 *
 * 定义放 shared/types（而不是 `shared/aliasRules`）是为了让 `Settings` 能直接引用它，
 * 且不产生 types ↔ aliasRules 的循环依赖；`aliasRules` 侧原样 re-export，测试不用改。
 */
export interface AliasRecord {
  /** 记录主键 */
  id: string
  /** `key` = 按归一化资产名全局生效；`asset` = 只对某个 assetId 生效 */
  scope: 'key' | 'asset'
  /** `scope='key'` 时是归一化后的资产名（`aliasKeyOf` 的结果）；`scope='asset'` 时是 assetId */
  key: string
  /** 显示名（中文） */
  name: string
  /** 写入时间戳（ms）；同键多条时取最大者，保证结果确定 */
  createdAt: number
}

/**
 * 智能集合 / 保存的筛选视图（0.6.0）。
 *
 * `filters` 用宽松类型：`Filters` 定义在渲染层（`renderer/logic/filters.ts`），
 * shared 不能反向依赖 renderer。渲染层读取时用默认值补齐 + 丢弃非法键。
 */
export interface SavedView {
  id: string
  name: string
  /** 筛选快照（与 `Filters` 同形，读取端负责校验） */
  filters: Record<string, unknown>
  /** 排序方式（随视图一起保存，`SortKey` 取值） */
  sort?: string
  createdAt: number
}

/** 分辨率档（0.6.0「贴图分辨率筛选」）：按贴图长边像素归档 */
export type ResolutionBucket = '2k' | '4k'

/**
 * 卡片色标（v0.4「资产标记」六色）。
 * 只用于视觉分组，不参与筛选索引（全量在内存里过滤，Dexie 不加索引）。
 */
export type ColorTag = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

/** 合法的色标取值集合（DB 迁移 / 外部数据校验共用，避免各处手写字符串数组） */
export const COLOR_TAGS: readonly ColorTag[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple'
]

/** 色标中文名（侧栏筛选 / 详情面板 / 空态维度文案共用，避免各处手写） */
export const COLOR_TAG_LABEL: Record<ColorTag, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫'
}

/**
 * 网格密度三档（反馈 6b，docs/15 §6b）：只改卡片的最小宽度，
 * 不改字号 / 行高 / 缩略图比例。`medium` = 历史默认值（184px）。
 */
export type GridDensity = 'large' | 'medium' | 'small'

/**
 * 封面来源（PRD 附录 3/4，落库用于统计各级命中率 K5）。
 *
 * `'zhimo'`（docs/24）：从知末详情页抓的**无水印**小图（400×300，`image6`）。
 * ⚠️ 只用于 `kind === 'model'`：材质/贴图的本地 `.cover.jpg` 就是 1K 级贴图本体，
 * 比知末图更准（用户 2026-10-22 拍板，不做开关）。优先级见 `coverRankOf()`
 * 之类的读取处：`manual > zhimo > embedded > named/root/largest > placeholder`。
 */
export type CoverSource =
  | 'named'
  | 'root'
  | 'embedded'
  | 'largest'
  | 'manual'
  | 'placeholder'
  | 'zhimo'

/**
 * 导入队列的单条状态（`ImportQueue.tsx` 消费）。
 *
 * `'skipped'`（2026-10 导入重复处置，docs/27）：用户在重复弹窗里选了「跳过」——
 * 该条**完全不落盘、原压缩包/原图绝不处置**，所以它不是错误态（文案用中性色，
 * 不是红色告警）。⚠️ 全仓没有 `Record<ImportStatus, _>` / 穷举 switch，
 * 加这个值**不会触发编译报错**，三处必须手工同步：
 * `components/ImportQueue.tsx`（STATUS_CLS / 图标 / 文案）、
 * `logic/importText.ts`（`autoDismissDelayMs`）、`store.ts`（`settled` 判定）。
 */
export type ImportStatus = 'extracting' | 'organizing' | 'done' | 'error' | 'skipped'

// ── 2026-10-19 用户自接模型 API 辅助分类（docs/15 §7） ────────────────────
//
// 口径（用户拍板）：**词表优先 + 模型兜底，不内置任何模型**。
// 用户自己填接口地址 / 密钥 / 模型名，默认关闭 → 安装包体积零增长。
// 只在 `autoClassify()` 完全命中不了（落 `未分类/未分类`）时才调用，且**绝不覆盖**已有分类。

/**
 * AI 辅助分类设置（OpenAI 兼容的 `/chat/completions` 接口）。
 *
 * 默认值 = 全部关闭 + 空串：**未配置时不会发出任何网络请求**。
 * 开启前设置页会明确告知「会把资产名发送到你配置的服务」。
 */
export interface AiClassifySettings {
  /** 总开关，默认 false */
  enabled: boolean
  /** 接口地址，形如 `https://api.xxx.com/v1`（末尾可带 `/chat/completions`），默认 '' */
  baseUrl: string
  /** API Key（Bearer），默认 ''（本地服务如 Ollama 可留空） */
  apiKey: string
  /** 模型名，如 `gpt-4o-mini` / `qwen2.5:7b`，默认 '' */
  model: string
}

/** `ai:classify` 入参：一批待分类的资产名（渲染层按 20 个一批调用） */
export interface AiClassifyPayload {
  names: string[]
}

/** 模型给出的单条分类结论（已通过词表校验） */
export interface AiClassifyItem {
  name: string
  category1: string
  category2: string
}

/**
 * `ai:classify` 返回值。
 *
 * `items` 与入参 `names` **等长同序**（缺失 / 校验不过 / 模型输出 null → 该位为 null）。
 * `failedNames` 只装「请求整体失败」的名字（网络 / HTTP / 解析 / 超时），
 * 渲染层据此把「未识别」与「失败」分开计数（notice 文案：成功 X / 未识别 Y / 失败 Z）。
 */
export interface AiClassifyBatchResult {
  items: Array<AiClassifyItem | null>
  failedNames: string[]
  /** 最近一次失败原因（仅日志 / 测试连接展示，**不弹错误对话框**） */
  error: string | null
}

/** `ai:test` 返回值：「测试连接」按钮的即时反馈 */
export interface AiClassifyTestResult {
  ok: boolean
  message: string
}

/** 主进程 → 渲染进程：一个导入批次已结束（渲染层据此后台补分类，**不阻塞导入**） */
export interface ImportBatchDoneEvent {
  /** 本批次成功返回的资产数 */
  count: number
}

/** 资产内的单个文件（路径相对资产文件夹） */
export interface AssetFile {
  /** 相对资产文件夹的路径，统一用 / 分隔 */
  rel: string
  name: string
  /** 小写扩展名，不含点 */
  ext: string
  size: number
  kind: AssetKind
  /**
   * 图片宽度 / 高度（像素，0.6.0「贴图分辨率筛选」）。
   *
   * 只在**图片文件**上由主进程解析文件头写入（PNG / JPEG，见 `shared/imageSize.ts`）；
   * 可选是刻意的：旧索引里的记录没有这两个字段 = **未知尺寸**，
   * 缺字段不做迁移、不补 0（补 0 会让所有旧资产落进「未知」以外的错误档位）。
   */
  w?: number
  h?: number
}

/** 一条资产记录 = 库内的一个文件夹 */
export interface Asset {
  /** 稳定主键：导入时生成的 UUID，**永不因改名 / 改库目录 / 改大类而变**（P0-7 / D1） */
  id: string
  name: string
  kind: AssetKind
  /** 来源，如 知末网 / 3d66 / 手动导入 */
  source: string
  /** 绝对路径（普通属性，不是主键） */
  folder: string
  /** 相对库根目录路径（posix 分隔），vault://asset/ 用 */
  relFolder: string
  /** 封面图相对资产文件夹的路径；无封面时 undefined（UI 走类型占位） */
  cover?: string
  /** 封面命中级别，落库用于统计四级回退命中率（P0-8） */
  coverSource?: CoverSource
  /** 缩略图缓存文件名（相对 thumbs 目录），如 'a1b2c3-9f3c.jpg' */
  thumbPath?: string
  /** 缩略图状态（P0-9） */
  thumbStatus?: ThumbStatus
  files: AssetFile[]
  size: number
  /** 'SU 2024'；解析失败静默降级为 undefined（P0-15） */
  suVersion?: string
  /** SketchUp major 版本号，用于按版本筛选与排序 */
  suMajor?: number
  /** 解压后文件名疑似乱码（GBK 嗅探命中，K1） */
  mojibake?: boolean
  /** 一级分类（单段目录名），默认 '未分类'（T06，06 §10.1）。本期可选，全链路走 normalizeCategoryPair */
  category1?: string
  /** 二级分类（单段目录名），级联于 category1，默认 '未分类' */
  category2?: string
  /** 风格（受控多选，`*styles` 索引），与 tags（自由）分离；筛选语义：风格内 OR、跨维度 AND */
  styles?: string[]
  /**
   * 材质包元数据（AmbientCG/Crystal 的 `*.json` 解析结果，2026-10 任务 4）。
   * 检测到 json 且解析成功才写入；Dexie 不需要新索引（不参与筛选）。
   */
  materialMeta?: { name?: string; tags?: string[] }
  /**
   * 该材质的调参倍率（2026-10 调参持久化，docs/12 §1.2）。
   * 可选：undefined = 未调参 = DEFAULT_PARAM_SCALES（不强制回填，见 §2.3）。
   * 存的是**已规范化**的值（clamp + 2 位小数），保证 DB 值与 hash 输入一致。
   * 非索引字段（不参与筛选）—— 与 materialMeta 同处理，不需要 version(4)。
   */
  renderParams?: BallParamScales
  /**
   * 材质球**几何形态**（2026-10 缓存策略）：用户在「自定义渲染」里切过 plane /
   * roundedBox 后必须记住，否则下次启动又渲回球面 —— 而卡片上写的就是"材质球"，
   * 形态一旦不入库，切换就只是一次性的视觉烟花。
   *
   * **缺省 = `'sphere'`**，与本次改动前的所有存量记录完全兼容（渲染结果、缓存名
   * 都不变：`ballThumbName` 只在非球面时才把形态拼进 hash 输入，见
   * `shared/ballParams.ts: ballThumbName`）。
   *
   * 非索引字段（不参与筛选）——与 `renderParams` 同处理，不需要升 Dexie 版本。
   */
  renderShape?: BallRenderShape
  /**
   * 软删时间戳（C 线「最近删除」）。`undefined` = 未删除。
   *
   * **Dexie v5 建索引**（`deletedAt`）；迁移老记录时**不要补 0 / null**——
   * 只有 `undefined` 在索引里才表现为"不存在"，补 0 会让所有老资产落进索引。
   */
  deletedAt?: number
  /**
   * 软删后在 `<库根>/.trash/` 下的相对路径（posix，形如 `.trash/<id>`）。
   * 还原 / 彻底删除时据此定位；未删除时为 undefined。
   */
  trashRel?: string
  /**
   * 单资产别名覆盖（D 线别名映射专用）。
   * C 线只保证字段存在（避免两线各改一次 schema），**不写任何逻辑**。
   */
  aliasOverride?: string
  tags: string[]
  note: string
  /** 收藏（v0.4）：默认 false。不建索引——全量内存过滤，`.where()` 在项目里 0 处使用 */
  favorite: boolean
  /** 评分 0–5（v0.4），0 = 未评分。不建索引 */
  rating: number
  /** 色标（v0.4），null = 未标记。不建索引 */
  colorTag: ColorTag | null
  /**
   * 知末商品 ID（纯数字串，0.6.3 新增，用户 2026-10 反馈）。
   *
   * **导入时**从三处按可信度提取（实现见 `main/importer.ts` 调用
   * `shared/naming.zhimoIdFromSources`）：
   * ① 源压缩包 / 源图片文件名（`现代壁灯ID_1232108421.rar` —— 包内零 ID 痕迹的场景）；
   * ② 最终资产名；
   * ③ 包内文件相对路径（`znzmo-1180221079-1.skp` —— 资产名里一个 ID 字都没有的场景）。
   *
   * 用途：
   * - 「从知末取封面」按钮的可用性与抓取目标（ID 只存在压缩包名上时也能抓）；
   * - 重复资产判定（ID 不同 = 不同资产，绝不并成"重复副本"）。
   *
   * `null` / 缺省 = 未识别（老索引记录在 store 加载后有一次幂等回填）。
   * **非索引字段**：只加内存字段，不加 Dexie 索引，不需要升 schema 版本。
   */
  zhimoId?: string | null
  /**
   * 分类可信度与待确认原因（2026-10 三源交叉验证，`docs/35`）。
   *
   * 为什么是**一个嵌套对象**而不是 4 个平铺字段：本项目的字段保全有**三处**必须同步
   * （rescan 白名单 / `applyOverwriteInherit` / `mergeDuplicateGroup`），每多一个字段
   * 就多三个漏点。2026-10 的 rescan 事故（143 条里 127 条的 `renderParams` 被抹）
   * 就是"新字段忘了归类"的直接后果。
   *
   * `undefined` = 尚未经交叉验证（老记录 / 未抓过详情页）→ 行为与改造前完全一致。
   *
   * **非索引字段**：不参与筛选、不进 `.where()` → 不需要升 Dexie 版本
   * （同 `materialMeta` / `renderParams` / `renderShape` / `zhimoId` 先例）。
   */
  classifyReview?: ClassifyReview
  /**
   * 重复检测键 = `<kind>:<归一化后的**基础**资产名>`。
   *
   * ⚠️ 必须用 `uniqueName()` **之前**的原始资产名计算：第二次导入同名包会被
   * `uniqueName` 命名成 `椅子-2`，若用最终名算 key 就永远和 `椅子` 不相等 →
   * 重复检测整体失效（2026-10 v0.4 修）。历史数据由 Dexie v4 的 upgrade 重算。
   */
  dedupeKey: string
  importedAt: number
  updatedAt: number
}

/** 见 `Asset.classifyReview`。字段全部可选：任一缺失都不影响既有功能。 */
export interface ClassifyReview {
  /** 上一次判定的置信度（`docs/35 §2.3`）。`undefined` = 没有判定过 */
  confidence?: ClassifyConfidence
  /**
   * **只有 `conflict` 才写**。
   *
   * ⚠️ `unclassified` 是**派生值**（走 `logic/triageFlow.ts` 的 `isUnclassified`），
   * **不落库** —— 同一语义只能有一个存储点（`docs/25`「未分类有三种口径」的教训）。
   */
  reason?: 'conflict'
  /**
   * 判定依据。**只存不可重算的部分**：
   * - `s1` 不存（`classifyAssetName` 纯函数可重算，且随词表升级会腐坏）；
   * - `s2` / `s3` 存（站方随时会改，重抓拿到的是"今天的站方"）。
   */
  sources?: {
    /**
     * 精简版 `CrossS2`（`classifyCrossCheck.CrossS2`）：
     * 去掉 `viaAlias`（判定当时的内部细节，事后无解释价值），
     * 加上 `fromBaseName`（这条 S2 是面包屑解析来的还是末级名兜底来的 —— 两者可信度不同，
     * 用户看队列时需要知道）。
     */
    s2?: { level1: string; level2: string; raw: string[]; fromBaseName: boolean }
    s3?: string
  }
  /** 用户/自动**定案**的时间戳；有值 = 已定案 → `reviewReasonOf` 返回 null */
  decidedAt?: number
}

/** 导入过程的进度事件（主进程 → 渲染进程） */
export interface ImportEvent {
  item: string
  itemName: string
  status: ImportStatus
  message?: string
  asset?: Asset
  /** 空间不足时给出可行动数字（UI 显示"可用 X GB / 需要 Y GB" + 改库目录入口，P0-3） */
  needBytes?: number
  freeBytes?: number
  /**
   * 重复处置结果（docs/27）：
   * - `status='skipped'` 必有；
   * - `status='done'` 且 `resolution='overwrite'|'keep-both'` 时也有（用于 toast 文案）。
   */
  conflict?: {
    reason: ImportConflictReason
    resolution: ImportConflictResolution
    /** 被跳过 / 被覆盖的那一份在库里的名字（toast 文案用） */
    existingName: string
    /**
     * `resolution='overwrite'` 且走了**退化路径**时为 true（docs/27 §3.2）：
     * - 旧目录已不存在 / kind 变了 / 快照 folder 在库外 → 按新素材落盘；
     * - 旧版本未能移入系统回收站（被 DCC 占用）→ 暂存为 `.idbox-old-*`。
     *
     * 这两种情况下**旧版并没有进回收站**，所以批次汇总文案必须能区分，
     * 否则会告诉用户"旧版在系统回收站"——那是假话，而且用户不会再去清回收站。
     *
     * ⚠️ 用**布尔字段**而不是让渲染层去嗅探 `message` 的中文子串：文案随时可改，
     * 嗅探一断就会静默退化成"谎称已进回收站"。`message` 仍然保留（展示用）。
     */
    degraded?: boolean
  }
  /**
   * 本次导入**物理删除**的杂质文件名（2026-10-30 用户要求"进库后自动删掉"）。
   * 只在真删掉时出现（空数组不写），供 UI 提示「已清理 N 个杂质文件」。
   * 判定见 `shared/junkCleanup.ts`（**不是** `isJunkFileName`，两套规则）。
   */
  cleanedJunk?: string[]
}

// ── 2026-10 导入重复处置（docs/27） ──────────────────────────────────────
//
// 口径（用户原话）：「拖入的文件包内如果有内容和已经存在本地库的文件有重复，
// 弹窗告知用户素材可能重复，让用户选择跳过、覆盖，或者二者同时存在并重命名。」
//
// 判重是**两级**：`zhimoId` 全等（同一件知末素材，强）> `dedupeKey` 全等（同名，弱）。
// 不做内容哈希（D04）：改名的同款素材仍带 ID，全库哈希的成本与收益不匹配。

/** 覆盖时要继承的用户元数据（渲染层出快照时带上，主进程直接写进替换后的记录） */
export interface ImportConflictInherit {
  favorite: boolean
  rating: number
  colorTag: ColorTag | null
  tags: string[]
  styles: string[]
  note: string
  /** 旧分类；双哨兵（未分类/未分类）= 用户从未指派 → 覆盖时改用新包预分类 */
  category1: string
  category2: string
  /**
   * 分类判定依据（`docs/35 §6.4`）：旧记录有就继承（同 `zhimoId` 的"本地优先"口径 ——
   * 抓过一次的站方结论 / 用户定案时间戳，新包解不出同样的东西，丢了就得重抓）。
   *
   * 放在 `ImportConflictInherit` 而不只在 `ImportDedupeEntry` 上：这份快照是
   * **主进程与渲染层共用的瘦投影**，字段必须在同一处声明，两端才能同时看到。
   */
  classifyReview?: ClassifyReview
}

/**
 * 判重快照的一条 = 当前库视图的**极简投影**。
 *
 * 刻意不带 `files` / `cover` / `thumbPath`：950 条带 files 的 Asset 走结构化克隆是 MB 级，
 * 而判重只需要「键 + 定位 + 展示 + 继承元数据」。
 */
export interface ImportDedupeEntry {
  id: string
  /** 最终资产名（可能带 -2/-3 后缀）；判重不用它，展示与覆盖定位用 */
  name: string
  kind: AssetKind
  /** 为空时主进程用 `baseNameOf(name)` + kind 兜底重算 */
  dedupeKey?: string
  zhimoId?: string
  /** 资产目录绝对路径；主进程执行覆盖前必须再过一次库内校验 */
  folder: string
  relFolder: string
  size: number
  importedAt: number
  meta: ImportConflictInherit
}

/**
 * 导入开始时的判重上下文。
 * `index` 为空数组 = 不做重复检测（等价旧行为：静默保留两者）。
 */
export interface ImportConflictContext {
  index: ImportDedupeEntry[]
}

/** 判重依据：`zhimo-id` = 同一件知末素材（强）；`same-name` = 归一化同名（弱） */
export type ImportConflictReason = 'zhimo-id' | 'same-name'

/** 三档处置（与用户需求原话一一对应） */
export type ImportConflictResolution = 'skip' | 'overwrite' | 'keep-both'

/** 库里已有的那一份（覆盖的替换目标） */
export interface ImportConflictExisting {
  id: string
  name: string
  kind: AssetKind
  relFolder: string
  size: number
  importedAt: number
  /** 同键的其它副本数（>0 = 库里本来就有多份；覆盖只动 `shown` 这一份） */
  otherCopies: number
  /** 体积差 > 30%（`duplicates.ts` 的 `SIZE_MISMATCH_RATIO` 同口径）→ 弹窗提示「可能不是同一套」 */
  sizeMismatch: boolean
}

/** 弹窗里的一行 */
export interface ImportConflictItem {
  /** 本批次内的稳定序号（1 起），答复用它回填 */
  seq: number
  /** 源文件绝对路径 */
  item: string
  /** 源文件名（展示） */
  itemName: string
  /** 将落库的资产名（原始名，未加 -2） */
  assetName: string
  kind: AssetKind
  /** 新包解压后的总字节 */
  size: number
  reason: ImportConflictReason
  zhimoId?: string
  existing: ImportConflictExisting
}

/** 主进程 → 渲染进程：一次询问（整批聚合，一次导入只问一次） */
export interface ImportConflictAsk {
  requestId: string
  /** 默认档（主进程超时兜底用 `'skip'`；弹窗据此预选） */
  batchDefault: ImportConflictResolution
  items: ImportConflictItem[]
  /** 本批还没出结果的源文件数（>0 → 弹窗提示「其余按上方处理」） */
  remainingItems: number
}

/** 渲染进程 → 主进程：一次答复 */
export interface ImportConflictAnswer {
  requestId: string
  /** 用户选的批次默认档；未列出的条目 + 之后才发现的冲突都用它 */
  batchDefault: ImportConflictResolution
  /** 逐条指定（可缺省；缺省项用 `batchDefault`） */
  overrides?: Array<{ seq: number; resolution: ImportConflictResolution }>
  /** true = 用户按 Esc / 点「全部取消」；主进程等同超时（全跳过） */
  cancelled?: boolean
}

/**
 * 主进程 → 渲染进程：**这次询问已作废**（只有 `requestId`）。
 *
 * 为什么必须有这条下行：120s 超时是主进程**单方面**结束的——它自己 `resolve(null)` 走「全跳过」，
 * 但渲染层的 `conflictAsk` 仍然非 null，弹窗继续挂在屏幕上。用户此时再点任何按钮，
 * `requestId` 已经不在 `pendingAsks` 里 → 主进程按「过期答复」幂等丢弃（这是对的，不能影响下一批），
 * 于是表现为：**弹窗关不掉、点了也没任何反馈**（QA 实测 DEF-19-1）。
 *
 * 所以超时必须显式告诉渲染层「这条作废、把它关掉」，而不是让渲染层去猜。
 */
export interface ImportConflictExpired {
  requestId: string
}

/**
 * 用户自定义分类词表（2026-10 用户需求：「无论模型还是材质还是 HDR，
 * 文件的一级分类和二级分类都允许用户增加自定义」）。
 *
 * 两层词表的**用户层**：预设词表（`shared/taxonomy.ts`）只读不动，
 * 自定义词条存这里（settings.json）。结构：
 * - `level1`：自定义一级分类，全局一册（各大类的选择器里并列展示）；
 * - `level2`：自定义二级分类，键 = 所属一级分类名。
 *
 * ⚠️ 自定义词条**不参与**任何自动分类匹配（`autoClassify` / 知末映射只认预设词表），
 * 它们只出现在选择器与侧栏（跟随资产落盘出现）里。
 */
export interface CustomTaxonomy {
  level1: string[]
  level2: Record<string, string[]>
}

export interface Settings {
  /** 库根目录 */
  libraryDir: string
  /** 导入成功后原压缩包的处置方式（P0-5） */
  archiveDisposal: ArchiveDisposal
  /**
   * 资产删除策略四档（C 线「最近删除」，默认 `'30d'`）。
   * `'recycle'` = 旧行为（直接进系统回收站），其余三档 = 库内 `.trash/` 保留期。
   */
  trashRetention: TrashRetention
  /**
   * 删除撤销宽限期（毫秒，2026-10 用户需求：「删除是否要等 5 秒在设置里面给用户权限」）。
   *
   * 只允许三档（由 `shared/undoGrace.ts` 的 `normalizeUndoGraceMs` 收口）：
   * - `0`    = 不等待：**仍然二次确认**，但确认后立即移入回收站 /「最近删除」，
   *            不进入 `grace` 阶段 —— 底部撤销条（`NoticeToast`）也就不会出现；
   * - `3000` = 3 秒反悔时间；
   * - `5000` = 5 秒（默认，与新增本设置之前的行为一致）。
   *
   * 只影响渲染层「确认后等多久才真正落盘」，不改任何落盘路径与保留期。
   */
  undoGraceMs: number
  /** 默认来源标签 */
  defaultSource: string
  /** 监控目录（自动导入新下载的压缩包） */
  watchDir: string | null
  watchEnabled: boolean
  /** 7z.exe 路径；null = 自动探测 */
  sevenZipPath: string | null
  /** 单次解压超时（毫秒） */
  extractTimeoutMs: number
  /** 纯 JS（adm-zip）兜底解压的 zip 体积上限（字节） */
  maxBytesForJsFallback: number
  /** 解压码页策略 */
  codepage: Codepage
  /** 缩略图最长边像素 */
  thumbMaxPx: number
  /**
   * 网格密度三档（反馈 6b）：大 240 / 中 184 / 小 132（卡片 `minmax` 下限）。
   * 顶栏三档分段控件与 Ctrl+滚轮都写这里，落 settings.json。
   */
  gridDensity: GridDensity
  /**
   * 材质球舞台（docs/19 裁定①）：默认关闭。
   * 关闭时双击材质卡完全沿用既有行为（FolderFileList），不接舞台。
   * 只有读取处全部走 `stageEligible(asset, settings)`，所以这个字段是**唯一**总闸。
   */
  materialStage: boolean
  /** 磁盘空间预检安全系数：required = uncompressed × factor + archive */
  spaceSafetyFactor: number
  /** UI 主题（规范 §1；默认浅色 Soft UI，切换即设 document.documentElement.dataset.theme） */
  theme: ThemeMode
  /**
   * 动效性能档位（设置·外观「动效性能」，默认 `balanced`）：
   * 流畅 / 均衡 / 极致三档，映射到渲染 DPR 上限、贴图各向异性、hover 预热激进度。
   * 只影响 three.js 舞台的**渲染上限**，不改任何业务数据。
   */
  motionQuality: MotionQuality
  /** 同时解压任务数（1-8，默认 2；设置·导入 tab 的 stepper，规范 §3.6） */
  extractConcurrency: number
  /** 中栏头下方帮助文本（走查 v0.2.2 C#19 拍板 2026-10-15：保留但可关闭，默认开）。
   *  画布无样本 → 控件沿用既有开关样式，放在设置·外观 tab。 */
  showHelpHint: boolean
  /**
   * 侧栏「整理」组的三个入口开关（2026-10 用户反馈：让用户决定是否显示）。
   * 关闭某入口时，对应的筛选状态会在 store 里一并重置（避免"筛选生效但看不到入口"）。
   * 默认全开 = 与旧版本行为一致。
   */
  showFavorites: boolean
  showColorTags: boolean
  showDuplicates: boolean
  /**
   * 记录详细日志（诊断日志的 debug 级开关，默认 false）。
   * 关闭时只落 info/warn/error；开启后额外落 debug（更啰嗦，仅排查问题时开）。
   */
  verboseLogging: boolean
  /**
   * 用户自接模型 API 辅助分类（docs/15 §7，默认关闭）。
   * **不内置模型**：用户自己填地址/密钥/模型名，未配置时代码路径完全不发请求。
   */
  aiClassify: AiClassifySettings
  /**
   * 导入后自动从知末抓模型封面（总开关，默认 true）。
   *
   * 失败**全程静默**（不弹错、不 notice、不阻塞导入）；只对 `kind === 'model'` 生效。
   * 抓取是后置任务（`import:batchDone` 之后由渲染层驱动），**不在导入链路里**。
   */
  zhimoCover: boolean
  /**
   * 包内已有预览图时，是否仍用知末图替换（默认 true = 替换）。
   *
   * ⚠️ 只约束**自动任务**：详情面板的手动「从知末取封面」永远替换。
   * 与总开关**互不牵连**：`zhimoCover === false` 时本项的值仍原样保留
   * （用户关一次总开关不能丢子偏好）。
   */
  zhimoCoverReplacePacked: boolean
  /**
   * 导入批次结束后是否**自动按站方分类重排**（默认 true）。
   *
   * 语义：批次收尾后用知末详情页的 `classifyBaseName`，把仍然是「未分类/未分类」
   * 且带知末 ID 的资产搬到对应分类目录（真实搬目录，移动前自动备份）。
   *
   * ⚠️ 只约束**自动任务**：设置页那段「按站方分类重排」的手动按钮**不受**本开关影响
   * （用户点了就是要跑）。归一化方向与 `zhimoCover` 一致：只认严格 `false`。
   */
  zhimoAutoCategory: boolean
  /**
   * 启动时自动检查更新（GitHub Releases，默认 **true**）。
   *
   * 关闭后 `startAutoCheck()` 一次请求都不发（手动点「立即检查」仍然可用）。
   * 检查本身是**纯网络只读**：失败静默、不阻塞启动、不改任何数据。
   * 归一化方向与 `zhimoCover` 一致：只认严格 `false`，缺键 / 脏值一律按开。
   */
  autoCheckUpdate: boolean
  /**
   * 别名映射表（0.6.0）：用户自定义的「文件名 → 显示名」。只影响显示，不改磁盘。
   * 默认空数组 = 行为与 0.5.x 完全一致（显示名仍走 `displayName()` 的剥 ID 规则）。
   */
  aliases: AliasRecord[]
  /**
   * 智能集合 / 保存的筛选视图（0.6.0）。侧栏常驻，点一下套用整组筛选 + 排序。
   * 默认空数组。
   */
  savedViews: SavedView[]
  /**
   * 批量重命名的默认模板（0.6.0）。占位符见 `shared/renameTemplate.ts`：
   * `{name}` 原名 / `{c1}` 一级分类 / `{c2}` 二级分类 / `{n}` 序号 / `{ext}` 扩展名。
   */
  renameTemplate: string
  /**
   * 用户自定义分类词表（2026-10）。默认全空 = 行为与没有该功能时完全一致。
   * 归一化入口在 `shared/customTaxonomy.ts`（清洗规则与落盘目录段同源）。
   */
  customTaxonomy: CustomTaxonomy
  /**
   * 左右侧边栏折叠（0.8.3，用户 2026-10-28 反馈「左右侧边栏都需要能够被折叠」）。
   *
   * `true` = 该侧边栏完全隐藏（不是收成窄条），中栏对应边缘出现竖向唤出按钮。
   * 默认 `false` = 展开态，老用户升级后无感知。归一化方向与 `materialStage` 一致：
   * 只认严格 `true`（缺键 / 脏值一律展开），且单项降级不拖垮整份 settings.json。
   */
  sidebarLeftCollapsed: boolean
  sidebarRightCollapsed: boolean
  /** @deprecated 仅用于读取旧 settings.json，读到后映射为 archiveDisposal */
  trashArchiveAfterImport?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  libraryDir: 'E:\\ModVault\\Library',
  archiveDisposal: 'recycle',
  // C 线：默认保留 30 天（对用户最安全；真实语义变更，UI 必须显式说明）
  trashRetention: '30d',
  // 删除撤销期默认 5 秒 = 新增本设置之前的旧行为（老用户升级后不感知变化）
  undoGraceMs: 5000,
  defaultSource: '知末网',
  watchDir: null,
  watchEnabled: false,
  sevenZipPath: null,
  extractTimeoutMs: 600_000,
  maxBytesForJsFallback: 200 * 1024 * 1024,
  codepage: 'auto',
  thumbMaxPx: 480,
  gridDensity: 'medium',
  // 材质球舞台默认关闭（docs/19）：没有这个开关时双击=进文件视图，是既有行为
  materialStage: false,
  spaceSafetyFactor: 1.2,
  theme: 'light',
  // 动效性能默认「均衡」= 画质与 GPU 占用平衡（smooth 更省电、ultra 高分屏最清晰）
  motionQuality: 'balanced',
  extractConcurrency: 2,
  showHelpHint: true,
  // 侧栏「整理」组默认全显（收藏 / 色标 / 重复资产），用户可在设置·外观里关掉
  showFavorites: true,
  showColorTags: true,
  showDuplicates: true,
  // 诊断日志：默认只记 info 及以上（debug 需用户显式开启，见设置·数据与备份）
  verboseLogging: false,
  // AI 辅助分类默认关闭：未配置 = 零网络请求（词表命不中时保持「未分类」，与旧行为一致）
  aiClassify: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: ''
  },
  // 知末封面（docs/24）：两项默认都开 = 装上就有效果；失败静默，不影响导入
  zhimoCover: true,
  // 子开关默认开 = 用无水印小图替换包内预览图（只约束自动任务，手动永远替换）
  zhimoCoverReplacePacked: true,
  // 导入后按站方分类自动落库：默认开 = 装上就有效果（只处理未分类，已分类不动）
  zhimoAutoCategory: true,
  // 启动时自动检查更新默认开（装上就有效果）；失败静默，绝不影响启动
  autoCheckUpdate: true,
  // 0.6.0：别名表 / 智能集合默认空（= 行为与 0.5.x 一致），模板给一个保守默认
  aliases: [],
  savedViews: [],
  renameTemplate: '{name}',
  // 自定义分类词表默认全空（= 与没有该功能时行为一致；词条由用户在分类选择器里新增）
  customTaxonomy: { level1: [], level2: {} },
  // 左右侧边栏默认展开（0.8.3 折叠功能；false = 展开态，升级无感）
  sidebarLeftCollapsed: false,
  sidebarRightCollapsed: false
}

// ── T06 分类体系 IPC 载荷（shared 定义，main 与 preload 共用，避免 preload 反向 import main） ──

/** 遗留布局迁移的单次移动计划（main/layout.ts） */
export interface LayoutMove {
  id: string
  from: string
  to: string
  relFolder: string
}

export interface LayoutApplyResult {
  /**
   * 成功迁移的记录，**`to` / `relFolder` 是最终落盘值**（T08）：
   * 目标重名被 `uniqueName` 追加 `-2/-3` 后与计划值不同，渲染层写索引必须用这里的值，
   * 否则改过名的记录 folder 与磁盘不一致（下轮 rescan 才能自愈）。
   */
  ok: LayoutMove[]
  failed: Array<{ id: string; reason: string }>
}

// ── 存量「大类迁移」：升级前被判成 model 的 CAD 图纸搬进 CAD/（P0，0.9.0 补） ─────
//
// 背景：`cad` 是 0.9.0 新增大类，0.8.x 时代 `EXT_KIND` 把 `dwg → model`，所以那批图纸
// 落盘在 `模型/…`、`files[].kind === 'model'`。升级不回溯 → 首页把图纸显示在「模型」里。
// 实现与判据见 `main/kindMigrate.ts` 文件头。

/**
 * 一项待迁移的资产（**计划产物**，零 IO 可预演）。
 *
 * 字段与 `MergeMaterialMove` 同构的只有必要部分：这里不需要 `prevRelFolder` /
 * `assetId: null` 那套"回滚凭据"（迁移方向单一且可逆——把目录搬回 `模型/` 即可）。
 */
export interface KindMoveItem {
  assetId: string
  name: string
  /** 迁移前 relFolder（如 `模型/装修图/平面图/xxx`） */
  fromRelFolder: string
  /** 迁移后 relFolder（如 `CAD/装修图/平面图/xxx`，首段来自 `kindFolder('cad')`） */
  toRelFolder: string
  fromKind: AssetKind
  toKind: AssetKind
  /** 当前绝对路径（= `Asset.folder`） */
  folder: string
}

/**
 * 迁移计划（**纯数据，必须能过 structured clone**）。
 *
 * 这张形状是 `library:detectKindMigration` 的 IPC 返回值，所以它**只能含可序列化的值**。
 *
 * ⛔ **绝对不要往这里加函数**（`onWarn` 之类的回调）：Electron 的 `ipcMain.handle`
 * 返回值走 structured clone，函数过不去 —— 轻则字段被静默丢弃（类型在骗人），
 * 重则整个调用抛 `An object could not be cloned`。后者更糟：渲染层的
 * `.catch(() => null)` 会把错误吞掉，功能表现为「永远已是最新」，**完全不生效**。
 * 执行上下文（库根 / 快照目录 / 告警回调）因此拆到 `main/kindMigrate.ts` 的
 * `KindMigrateContext`，只由 main 内部持有、永不过 IPC。
 * `tests/kindMigrate.test.ts` 有一条「plan 可 JSON 往返」的回归守卫钉住这点。
 */
export interface KindMovePlan {
  items: KindMoveItem[]
  /** 本模块看过的资产数（= 入参长度），用于区分"没待迁移项"与"库里没数据" */
  scanned: number
}

/**
 * `library:detectKindMigration` 的**精简返回值**（渲染层只需要"有没有"）。
 *
 * 为什么不直接回 `KindMovePlan`：渲染层判断只需要 `count > 0`，
 * 把 `items` 里的 `folder` / `toRelFolder` 绝对路径发到渲染进程是**无必要的信息暴露**
 * （渲染层拿到也只会去 `items.length`）。`names` 只给资产名（不含路径），
 * 用于排查时在日志/设置页显示"是哪几条"。
 */
export interface KindMigrateDetectResult {
  /** 待迁移条数（0 = 无需迁移，渲染层静默跳过） */
  count: number
  /** 看过的资产总数 */
  scanned: number
  /** 待迁移的资产名（**不含路径**；仅用于排查展示，参与决策的只有 count） */
  names: string[]
}

/**
 * 单项迁移结果。`folder` / `name` / `relFolder` 是**最终落盘值**
 * （目标重名被 `uniqueName` 追加 `-2` 后与计划值不同），渲染层写索引必须用它。
 *
 * 失败项：`moved === false` 且 `error` 有值，`folder` / `relFolder` 保持迁移前的值
 * （渲染层据此跳过该条，磁盘与索引都不会被半改）。
 */
export interface KindMoveResult {
  assetId: string
  folder: string
  name: string
  relFolder: string
  /** true = 实际执行了移动；false = 已是目标位置（self-target no-op）或失败 */
  moved: boolean
  /** true = 目标已有同名资产，按 `uniqueName` 追加了序号 */
  renamed: boolean
  /** 失败原因（有值即失败；渲染层不写这条的 DB） */
  error?: string
}

// ── 0.6.0：批量重命名（docs/22 §3.4，命名模板 + 预览 + 失败回滚） ─────────────
//
// 语义（用户 2026-10 拍板，第一版）：**只改资产文件夹名，不改包里的文件名**。
// 磁盘动作全在主进程；Dexie 更新在渲染层（main 拿不到 Dexie）。
// 返回值携带**最终落盘值**（folder / name），渲染层照抄写库，不自己拼路径。

/** `asset:renameFolders` 入参项 */
export interface RenameFolderPlanItem {
  /** 资产 id（渲染层用来把结果对回记录；main 不用它做路径决策） */
  id: string
  /** 资产当前绝对路径（必须在库内，且与目标同父目录） */
  folder: string
  /** 新文件夹名（**单段**，不含分隔符；渲染层已清洗，main 侧再校验一次） */
  to: string
}

/** 单条改名成功（`folder` / `name` 是**最终落盘值**） */
export interface RenameFolderOk {
  id: string
  /** 改名后的绝对路径 */
  folder: string
  /** 改名后的文件夹名 */
  name: string
}

/** 单条失败（原因直接进 notice / 日志，必须是可读中文） */
export interface RenameFolderFailure {
  id: string
  reason: string
}

/**
 * `asset:renameFolders` 返回值。
 *
 * 契约：
 * - `renamed` = 返回时**磁盘上确实已经改名**的条目（正常情况下失败会全部回滚 → 空数组；
 *   只有回滚本身失败时才会非空，渲染层仍应按它写库以避免索引与磁盘脱节）；
 * - `failed` = 未改名的条目（含预检拒绝与执行失败，回滚失败也在这里多记一条）；
 * - `rolledBack` = true 表示「发生过失败，且已成功的部分全部改回原状」→ 磁盘零改动。
 */
export interface RenameFoldersResult {
  renamed: RenameFolderOk[]
  failed: RenameFolderFailure[]
  rolledBack: boolean
}

/** `asset:assignCategory` 入参 */
export interface AssignCategoryPayload {
  /** 当前资产绝对路径 */
  folder: string
  /** 大类目录名 —— **必须由 asset.kind 算出**（main 不信任渲染层传来的完整路径） */
  kindFolderName: string
  category1: string
  category2: string
}

/** `asset:assignCategory` 返回值 */
export interface AssignCategoryResult {
  folder: string
  name: string
  relFolder: string
  category1: string
  category2: string
  /** true = 实际执行了移动；false = 资产已在目标分类下（self-target，no-op，T08 守卫） */
  moved: boolean
  /** true = 目标已有同名目录，追加了 -2/-3 序号 */
  renamed: boolean
  /** true = 入参被 normalizeCategoryPair 改写（级联降级 / 非法字符 / 截断），UI 应提示 */
  changed: boolean
}

// ── 2026-10 装机反馈：截图/本地图片设为封面（任务 3） ──────────────────────

/** `asset:setCoverImage` 入参（shared 定义，main 与 preload 共用） */
export interface SetCoverImagePayload {
  /** 资产 id（仅作日志/排查用；定位资产靠 folder） */
  assetId?: string
  /** 资产文件夹绝对路径（**必须在库目录内**，main 侧校验） */
  folder: string
  /** 图片来源：剪贴板（base64）或本地文件（绝对路径） */
  source: 'clipboard' | 'file'
  /** source='clipboard'：图片 base64（不含 data: 前缀） */
  data?: string
  /** source='file'：本地图片绝对路径（**允许在库外**——截图常在桌面/下载目录） */
  path?: string
}

/** `asset:setCoverImage` 返回值；null = 校验失败或写盘失败 */
export interface SetCoverImageResult {
  /** 封面相对资产文件夹的路径（posix 分隔），如 '现代衣柜.cover.png' */
  rel: string
  /** 落盘字节数（渲染层更新 files/体积用，省一次 stat） */
  size: number
}

// ── 2026-10：材质球离屏渲染图落盘（任务 6） ──────────────────────────────

/**
 * PBR 槽位（IPC 载荷用）。与 `renderer/logic/materialBall.ts` 的 `MaterialSlots`
 * **同形**（结构类型兼容，互相可直接赋值），放在 shared 是为了让 main 侧
 * 不需要 import renderer 层的类型。
 */
export interface BallSlots {
  albedo?: string
  normal?: string
  roughness?: string
  ao?: string
  displacement?: string
}

/**
 * 材质球几何形态（**shared 里的规范定义**）。
 *
 * 与 `renderer/components/MaterialBall.tsx` 的 `BallShape` 逐字同形（结构类型兼容，
 * 互相可直接赋值）；放 shared 是因为 `Asset.renderShape` 与 IPC 载荷
 * `SaveBallThumbPayload.shape` 都要用它，而 main 层不能 import renderer 的类型。
 *
 * 为什么形态要进球图的**身份**（hash）：同一个材质、同一个参数，球面与平面的成像
 * 完全不同。若形态不参与 hash，用户切换形态后缓存名不变 → 网格永远显示旧形态那张图。
 *
 * ⚠️ 只有**非球面**才贡献 hash（`'sphere'` 与缺省逐字符一致），否则本次改动会让
 * 全库存量球图凭空改名 → 又一次全量重渲（正是本次要消灭的行为）。
 */
export type BallRenderShape = 'sphere' | 'plane' | 'roundedBox'

/** `thumb:saveBall` 入参 */
export interface SaveBallThumbPayload {
  /** 资产稳定 id（缓存文件名 `<id>-<槽位hash>.png` 的一部分） */
  assetId: string
  /** 参与渲染的槽位（决定 hash：换贴图即换缓存名） */
  slots: BallSlots
  /**
   * 调参倍率（docs/12 §3.4）：参与 hash，但**不出现在文件名字面**——
   * 只有非默认参数才贡献 hash（方案 B），所以未调参资产的既有缓存全部保留。
   * 传 undefined = 默认参数（与不传等价，既有调用不受影响）。
   */
  params?: BallParamScales
  /**
   * 几何形态（参与 hash，但同样**只在非球面时**）。传 undefined = `'sphere'`。
   *
   * 主进程必须用**同一个** `ballThumbName` 算文件名（不许在 main 复制一份 hash 逻辑），
   * 因此形态必须随载荷过来：渲染层渲的是 plane，落盘名字就必须带 plane。
   */
  shape?: BallRenderShape
  /**
   * 离屏渲染出的 **PNG base64**（透明背景，不含 `data:` 前缀）。
   * 透明是关键：卡片 `bg-canvas` 透出来 → 深浅主题同一个缓存文件都正确。
   */
  base64: string
}

/**
 * 缩略图缓存目录里的一**个文件**（`thumb:list` 的返回值，2026-10 数据救援）。
 *
 * 只读快照：`name` 是纯文件名（`<id>-<8hex>.(jpg|png)`），不含目录。
 * 提供 `size` / `mtimeMs` 是因为救援要「同一 id 多个候选时取最新」——
 * 主进程已经 stat 过一遍，渲染层不必再为每个文件额外发一次 IPC。
 *
 * ⚠️ 刻意**不**提供路径 / 删除能力：这条通道只用于"盘上有什么"，
 * 清理仍然只能走 `thumbDelete` / `thumbDeleteOne` / `thumbPrune`（各自有校验）。
 */
export interface ThumbFileEntry {
  /** 纯文件名（相对 thumbs 目录） */
  name: string
  /** 字节数 */
  size: number
  /** 最后修改时间（毫秒时间戳） */
  mtimeMs: number
}

// ── T08：rescan 忽略上报（RA6，06 §11.2） ──────────────────────────

/** 结构符合性上报的原因 */
export type IgnoredReason = 'depth' | 'not-dir'

export interface IgnoredEntry {
  /** 相对库根的 posix 路径 */
  relPath: string
  reason: IgnoredReason
}

/** `library:rescan` 返回值（T08：assets + ignored 合并回传，少一条通道） */
export interface RescanResult {
  assets: Asset[]
  /** 结构不符被跳过的目录/文件。UI 只需提示数量（「N 个目录结构异常已跳过」），明细供日志排查 */
  ignored: IgnoredEntry[]
}

// ── 2026-10-19 材质大类合并迁移（docs/14 §2.3，T-03） ─────────────────────
//
// 磁盘动作全在主进程；**Dexie 更新在渲染层**（main 拿不到 Dexie）。所以 IPC 返回值
// 必须携带"最终落盘值"，渲染层按 `assetId`（由调用方传入的 `assets` 白名单匹配）
// 在单个事务里 `put` 局部字段（禁止 delete+put，否则 tags/note/styles 全丢）。

/** 待迁移的源大类目录（只读历史目录，写入永不再用） */
export interface MergeMaterialSource {
  /** 目录名（历史别名）：'贴图' | '材质预设' */
  name: string
  /** 绝对路径 */
  dir: string
  exists: boolean
  /** 该目录下识别出的资产目录数 */
  assetCount: number
}

/** `library:detectMaterialMerge` 返回值（**只读**，启动探测用） */
export interface MergeMaterialDetectResult {
  needMerge: boolean
  /** 可搬移的资产数（= `plan.moves.length`） */
  count: number
  sources: MergeMaterialSource[]
}

/** 渲染层传入的资产引用：只用于把 `assetId` / 旧 `relFolder` 写进 manifest（回滚凭据） */
export interface MergeMaterialAssetRef {
  id: string
  /** 资产当前绝对路径（= `Asset.folder`，main 侧会校验在库内） */
  folder: string
  /** 迁移前的 relFolder（回滚时写回 DB 用的旧值） */
  relFolder: string
}

/**
 * 一项成功的大类搬移。`to` / `relFolderTo` 是**最终落盘值**（重名追加序号后可能
 * 与计划值不同），渲染层写索引必须用它，否则 folder 与磁盘不一致。
 */
export interface MergeMaterialMove {
  /** 源资产目录绝对路径 */
  from: string
  /** 目标绝对路径（最终值） */
  to: string
  /** 源 relFolder（4 段，首段 贴图 / 材质预设） */
  relFolderFrom: string
  /** 目标 relFolder（4 段，首段固定「材质」） */
  relFolderTo: string
  /** 源目录对应的大类（诊断用；不写回 schema，schema 的 kind 保持 texture/material） */
  kind: AssetKind
  /** true = 目标已存在同名资产 → 加了 `-2/-3` 序号 */
  renamed: boolean
  /** 匹配到的资产 id（调用方传了 `assets` 白名单才有；纯磁盘计划为 null） */
  assetId: string | null
  /** 迁移前的 relFolder（回滚时写回 DB 的旧值；无 assetId 时为 null） */
  prevRelFolder: string | null
}

/** 单项失败（不阻塞其余项；下次启动重试即可，幂等） */
export interface MergeMaterialFailure {
  from: string
  reason: string
}

/** 计划阶段被跳过的结构（防静默丢资产，必须上报） */
export interface MergeMaterialSkipped {
  /** 相对库根的 posix 路径 */
  relPath: string
  /** depth = 3 段以内的草稿布局；not-dir = 期望目录处是文件；empty = 空壳目录 */
  reason: 'depth' | 'not-dir' | 'empty'
}

/** `library:mergeMaterial` 入参 */
export interface MergeMaterialPayload {
  /** true = 用户手动触发（跳过多 50 条的保护）；启动自动迁移必须不传 */
  force?: boolean
  /** 渲染层全部资产引用（main 侧按 `folder` 匹配 move → 写 assetId/prevRelFolder） */
  assets?: MergeMaterialAssetRef[]
}

/** `library:mergeMaterial` 返回值 */
export interface MergeMaterialResult {
  /** 成功项（最终落盘值）；渲染层据此改 DB + 重缩略图 */
  moves: MergeMaterialMove[]
  /** 成功搬移数（= moves.length，notice 文案直接用） */
  moved: number
  /** 计划阶段跳过的结构数 */
  skipped: number
  /** 因重名追加序号的数量 */
  renamed: number
  /** 失败项（单项失败不整批回滚） */
  failures: MergeMaterialFailure[]
  /** true = 超阈值未执行（`count > 50` 且未 force），渲染层应弹设置页入口 */
  needsManual: boolean
  /** 待迁移资产总数（needsManual 时即超限数量） */
  count: number
  /** manifest 绝对路径（无搬移时为 null） */
  manifestPath: string | null
}

/** `library:rollbackMaterialMerge` 返回值（P2 UI；函数与单测本批必交付） */
export interface MergeMaterialRollbackResult {
  /** 已搬回的项（含 `assetId` / `prevRelFolder`，渲染层据此恢复 DB 字段） */
  restored: MergeMaterialMove[]
  restoredCount: number
  failures: MergeMaterialFailure[]
  manifestPath: string
}

// ── 诊断日志（2026-10 崩溃取证 + 用户自助导出） ───────────────────────────
//
// 落盘位置：`<userData>/logs/app-YYYY-MM-DD.log`（见 `main/logger.ts`）。
// 行格式：`<ISO时间> [main|renderer] [LEVEL] <消息> <可选 JSON 上下文>`。

/** 日志级别：`error` 最严重；`debug` 只在设置「记录详细日志」时落盘 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 渲染进程 → 主进程：转发一条日志（渲染层负责去重 / 限流，主进程只落盘） */
export interface RendererLogPayload {
  level: LogLevel
  message: string
  /** 可选结构化上下文；落盘前会把 apiKey / Authorization / token 的值替换成 `***` */
  context?: Record<string, unknown>
}

/** `log:stats` 返回值（设置·数据与备份 的「诊断日志」区块展示用） */
export interface LogStats {
  /** 日志目录绝对路径（「打开日志文件夹」按钮直接用） */
  dir: string
  /** 日志文件数（只统计 `app-YYYY-MM-DD.log`） */
  count: number
  /** 总字节数 */
  bytes: number
}

/**
 * `log:export` 返回值。
 * `canceled: true` = 用户在保存对话框点了取消（**不是错误**，UI 不提示失败）；
 * `path: null` 且 `canceled: false` = 打包失败（已在主进程日志里记 error）。
 */
export interface LogExportResult {
  canceled: boolean
  path: string | null
  /** 打进 zip 的日志文件数 */
  files: number
}

// ── C 线：「最近删除」IPC 载荷（docs/20 §4，main 与 preload 共用） ──────────
//
// 磁盘动作全在主进程（rename / 回收站），Dexie 更新在渲染层（main 拿不到 Dexie）。
// 所以返回值必须携带**最终落盘值**（folder / relFolder / trashRel），渲染层照抄写库。

/** `trash:softDelete` 入参项 */
export interface TrashSoftDeleteItem {
  id: string
  /** 资产当前绝对路径（必须在库内；main 侧校验） */
  folder: string
}

/** 单项软删成功 */
export interface TrashSoftDeleteOk {
  id: string
  /** `.trash/<id>` 相对库根的 posix 路径 */
  trashRel: string
  /** 软删时间戳（ms） */
  deletedAt: number
  /** 该资产目录的估算字节数（容量条 / 超容量清理用） */
  size: number
}

/** `trash:softDelete` 返回值 */
export interface TrashSoftDeleteResult {
  ok: TrashSoftDeleteOk[]
  failed: Array<{ id: string; reason: string }>
}

/** `trash:restore` 入参项 */
export interface TrashRestoreItem {
  id: string
  /** 软删时记录的 `.trash/<id>` */
  trashRel: string
  /** 原始 4 段相对路径（`<大类>/<一级>/<二级>/<资产名>`） */
  relFolder: string
  /** 原始资产名（目标重名时据此追加 `-2`） */
  name: string
}

/** 单项还原成功（`folder` / `relFolder` 是**最终落盘值**） */
export interface TrashRestoreOk {
  id: string
  folder: string
  relFolder: string
  /** true = 原位置已被占用，还原时追加了 `-2/-3` 序号（UI 必须提示，不能静默） */
  renamed: boolean
}

/** `trash:restore` 返回值 */
export interface TrashRestoreResult {
  ok: TrashRestoreOk[]
  failed: Array<{ id: string; reason: string }>
}

/** `trash:purge` 入参项：把某个软删项**彻底删除**（进系统回收站） */
export interface TrashPurgeItem {
  id: string
  trashRel: string
}

/** `trash:purge` / `trash:emptyAll` 返回值 */
export interface TrashPurgeResult {
  /** 成功送进系统回收站的条目数 */
  purged: number
  /** 失败的条目数（文件被占用等；渲染层保留记录以便重试） */
  failed: number
  /** 失败明细（id + 原因），便于日志与提示 */
  failures: Array<{ id: string; reason: string }>
}

/** `trash:sweep` 返回值（启动 / 6 小时定时 / 手动触发共用） */
export interface TrashSweepResult {
  purged: number
  failed: number
  /** 本次清理释放的字节数（送进回收站，磁盘空间要等用户清空回收站才真正回收） */
  bytes: number
}

// ── 知末封面抓取（docs/24，T-01：shared 契约）────────────────────────────
//
// 口径（已实测钉死，实施时不要重新讨论）：
// - 取图**唯一来源** = 详情页 `__NEXT_DATA__.props.pageProps.res.listImageUrl`
//   （`image6.znzmo.com`，400×300，**无水印**）；
// - `mainImageUrl`（`image2`，带水印）**只在 `listImageUrl` 字段缺失时**兜底，
//   走到兜底时 `watermarked === true`，渲染层/日志据此区分；
// - JSON-LD 的 `ImageObject.contentUrl` **永不参与取图**（它指向的正是带水印大图），
//   只用于「这一页是不是有效详情页」的第二道判据；
// - 失效页的状态码不可信（软 404 是 HTTP 200），所以**页面不看状态码**，
//   判据只能是"能不能解析出图 URL"；图片请求按 2xx 判是安全的（OSS 对象 404 就是真没了）。

/**
 * 知末封面抓取失败原因（`fetchZhimoCover` 的**唯一**失败表达，绝不 `throw`）。
 *
 * - `no-id`        入参不是 6 位以上纯数字（不发任何请求）
 * - `not-found`    两条解析路径都拿不到图 URL（软 404 / 裸 404 / 结构改版）
 * - `no-image`     页面有效（JSON-LD 有 contentUrl），但 `__NEXT_DATA__` 没有可取的图 URL
 * - `timeout`      详情页或图片请求超时
 * - `network`      连接失败 / 图片非 2xx
 * - `bad-url`      图片 URL 主机不在白名单（防 JSON 投毒）
 * - `bad-image`    不是 PNG/JPEG，或超 20MB，或宽高解析不出
 * - `too-small`    宽度 < minWidth（默认 200px）
 * - `write-failed` 落盘失败（目录不存在 / 权限 / 越界）
 */
export type ZhimoCoverFailReason =
  | 'no-id'
  | 'not-found'
  | 'no-image'
  | 'timeout'
  | 'network'
  | 'bad-url'
  | 'bad-image'
  | 'too-small'
  | 'write-failed'

/** `zhimo:fetchCover` 入参（渲染层驱动，逐资产一次 IPC） */
export interface FetchZhimoCoverPayload {
  /** 资产文件夹绝对路径（**必须在库目录内**，main 侧校验） */
  folder: string
  /** 知末商品 ID：渲染层**优先用 `asset.zhimoId`**（导入时从压缩包名/资产名/包内文件名算好），
   *  为空才回退 `zhimoIdOf(asset.name)`；main 侧再校验一次格式 */
  id: string
}

/**
 * `zhimo:fetchCover` 返回值。
 *
 * ⚠️ 形状是**扁平**的（不是可辨别联合）：
 * - `ok === false` **且有 `reason`** = 抓取真的跑过且失败（原因见 `ZhimoCoverFailReason`）；
 * - `ok === false` **且无 `reason`** = **根本没走到抓取这一步**（当前仅 `items` 为空之类的边界，
 *   以及将来可能的提前返回）。**它不代表抓取失败**，渲染层不要写成 `r.reason!` 硬取；
 * - `ok === true` 时带落盘结果与两个诊断字段。理由：IPC 表面只有一种形状，
 *   渲染层不用判空也不用穷举联合，手写 `if (!r.ok)` 即可。
 */
export interface FetchZhimoCoverResult {
  ok: boolean
  reason?: ZhimoCoverFailReason
  /** 落盘后的资产内相对路径（如 `<资产名>.cover.jpg`），成功时才有 */
  rel?: string
  size?: number
  width?: number
  height?: number
  /** 实际取图 host：'image6.znzmo.com'（无水印）| 'image2.znzmo.com'（兜底，带水印） */
  sourceHost?: string
  /** true = 走了 mainImageUrl 兜底（带水印）。主路径成功时必须为 false */
  watermarked?: boolean
  /** 站方标题（可用于日志/调试，不落库） */
  title?: string | null
  /**
   * 站方**三级分类名**（如 `卡座沙发` / `壁灯`；`res.classifyBaseName` **原话**）。
   *
   * 取不到 / 站方占位 → `null`（或字段缺省）。它**不影响封面成败**。
   *
   * ⚠️ 落库前必须查 `shared/zhimoTaxonomyMap.ts` 的 `mapZhimoCategory(name, kind)`：
   * 站方三级轴与本地两级分类不是一一对应，**禁止**直接写 `category1/2`。
   * 只需要分类、不需要封面时，走轻量通道 `zhimo:fetchMeta`（不下图片）。
   */
  classifyBaseName?: string | null
  /**
   * 知末站方的风格**自由词**（如 `现代` / `中古`；原样，**未经本地词表过滤**）。
   *
   * 取不到 / 站方占位 `--` / 解析失败 → `null`（或字段缺省）。它**不影响封面成败**。
   *
   * ⚠️ 渲染层写入前必须过 `STYLE_LIST_BY_KIND[kind]` 白名单
   * （`renderer/logic/zhimoStyle.ts`），并且只在 `asset.styles` 为空时写 ——
   * 站方自由词绝不直接进受控维度。
   */
  style?: string | null
}

// ── 知末详情页元信息（只取详情页、不下图片；2026-10 站方分类） ─────────────
//
// 与封面通道的分工：`zhimo:fetchCover` 要"下到图且 ≥200px"才算成功，
// 图挂了会把**已经拿到**的站方分类一起丢掉。`zhimo:fetchMeta` 只发一次详情页 GET，
// 解析 `classifyBaseName` / `style` / `version` / `title` / `breadcrumb`，**零图片请求、零写盘**。

/** `zhimo:fetchMeta` 入参（**没有 `folder`**：本通道不写盘，不需要库内路径） */
export interface FetchZhimoMetaPayload {
  /** 知末商品 ID：6 位以上纯数字；不合法 → `{ ok:false, reason:'no-id' }` 且不发请求 */
  id: string
}

/**
 * `zhimo:fetchMeta` 返回值。
 *
 * 形状与 `FetchZhimoCoverResult` 同款（**扁平、不是联合**）：渲染层手写 `if (!r.ok)` 即可。
 *
 * - `ok === true`：五个字段恒在，**值为 `null` 是正常结果**（"站方没给"，不是错误）；
 *   `breadcrumb` 例外 —— 站方这一页没有面包屑时**字段缺省**（`undefined`，不是空数组）。
 * - `ok === false` 且带 `reason`：详情页请求/解析失败（reason 沿用封面那套枚举，
 *   本通道**只会**出现 `no-id` / `not-found` / `timeout` / `network`）。
 */
export interface FetchZhimoMetaResult {
  ok: boolean
  reason?: ZhimoCoverFailReason
  /** 站方三级分类名（原话，未映射）；需要时查 `mapZhimoCategory()` */
  classifyBaseName?: string | null
  /** 站方风格自由词（原样，未经词表过滤） */
  style?: string | null
  /** 站方上传版本（如 `sketchup 2014`；不是 `.skp` 内嵌版本） */
  version?: string | null
  /** 站方标题 */
  title?: string | null
  /**
   * 站方**完整分类路径**（详情页 `breadcrumb_data` 原文，按 `level` 升序）—— 分类三源交叉验证的 **S2 源**。
   *
   * 【docs/35 T-01】`classifyBaseName` 只有末级名字、还原不出路径；面包屑能同时给出一级与二级。
   * 缺省（`undefined`）= 站方这一页没给面包屑（实测约 20%），**不是空数组**。
   *
   * ⚠️ 类型是**内联结构体**而不是 import `src/main/zhimoCover.ts` 的 `ZhimoBreadcrumbItem`：
   * 渲染层不允许 import `src/main/**`（`tsconfig.web.json` 根本不 include 主进程）。
   * 字段与主进程 `zhimoCover.ts` 的 `ZhimoBreadcrumbItem` 逐字一致 —— **改一处必须同步另一处**。
   */
  breadcrumb?: {
    termId: number
    /** 站方节点名（原话，未映射；如 `室内空间` / `办公空间`） */
    name: string
    /** 站方层级真值：`f{termId}` / `f{父}s{子}` / `f{祖}s{父}s{子}` */
    href: string
    /** 由 `href` 里 `s` 的个数推导（1 = 一级）；**不用数组下标** */
    level: number
  }[]
}

// ── HDR 预览（0.6.5，HDR 入库 + 降采样预览） ──────────────────────────────

/**
 * `hdr:prepare` 返回值（可辨别联合）。
 *
 * - `ok:true`：`cachedPath` 是**降采样后的标准 RGBE 文件**绝对路径（在
 *   `<userData>/hdr-cache/` 下，不进用户库目录），渲染层用 `hdr://<文件名>` 读；
 *   `width/height` 是产物尺寸；`fromCache` = 命中缓存（UI 据此不显示进度条）。
 * - `ok:false`：`reason` 是**可直接展示**的中文原因（不支持 exr / 朝向不对 / 文件损坏…）。
 *
 * `sourceWidth/sourceHeight` 是附加字段（源图分辨率，读头失败为 null），只用于
 * 预览标题展示"16384 × 8192 → 预览 2048 × 1024"，不参与任何逻辑判断。
 */
export type HdrPrepareResult =
  | {
      ok: true
      cachedPath: string
      width: number
      height: number
      fromCache: boolean
      sourceWidth?: number | null
      sourceHeight?: number | null
    }
  | { ok: false; reason: string }

/**
 * `hdr:progress` 事件载荷（主进程 → 渲染进程，单向）。
 *
 * ⚠️ **必须带 `path`**：多个资产可能同时准备 HDR，渲染层按 `path` 过滤，
 * 否则进度条会串台（A 的 30% 显示到 B 上）。
 * `ratio` ∈ [0,1]，语义是"已读字节 / 总字节"，单调不减。
 */
export interface HdrProgressEvent {
  path: string
  ratio: number
}

// ── 自动检查更新（GitHub Releases） ─────────────────────────────────────
//
// 结论类型放在 shared：主进程产出（`main/updateCheck.ts`）、preload 原样转发、
// 渲染层展示三者共用一份形状。**没有任何字段是"必须成功才有"的** ——
// 失败时 `error` 有值，其余字段保持 null / false，UI 只管分支渲染，不用 try/catch。

/** 检查更新失败的三类原因（都**不是异常**，只是结论） */
export type UpdateCheckError = 'network' | 'http' | 'parse'

/** `app:checkUpdate` 的返回结构（主进程 10 分钟内复用同一份结论） */
export interface UpdateInfo {
  /** 当前版本（已去掉 `v` 前缀），来自 `app.getVersion()` */
  current: string
  /** 最新正式版（已去掉 `v` 前缀）；失败 / 无数据为 null */
  latest: string | null
  /** `latest > current` 时为 true；prerelease / draft 一律 false */
  hasUpdate: boolean
  /** Release 页面地址（`html_url`），「去下载」的兜底目标 */
  url: string | null
  /**
   * 安装包直链（`IDBOX-Setup-*.exe` 的 `browser_download_url`）。
   * 「去下载」**优先**用它（一键下安装包），为空时回退 `url`。
   */
  assetUrl: string | null
  /** Release 发布时间（ISO 字符串，原样透传，仅展示用） */
  publishedAt: string | null
  /** 本次检查的时间戳（毫秒） */
  checkedAt: number
  /** 失败原因；`null` = 检查成功（不代表"有更新"，看 `hasUpdate`） */
  error: UpdateCheckError | null
}
