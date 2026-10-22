import { z } from 'zod'
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  LEGACY_DISPOSAL_ALIASES,
  type AiClassifySettings,
  type ArchiveDisposal,
  type Settings,
  type ThemeMode,
  type TrashRetention
} from '../shared/types'
import { DEFAULT_LIBRARY_DIR } from './paths'
import { freeBytesOf } from './disk'

/** 首次运行选盘时的最低可用空间门槛（U3） */
export const MIN_FREE_BYTES_FOR_LIBRARY = 20 * 1024 * 1024 * 1024

/**
 * 旧品牌的应用目录名（v0.1.0 时 package.json 的 `name` 为 `modvault`，
 * Electron 的 userData 目录名取自它 → 老用户配置在 `%APPDATA%/modvault/`）。
 * 更名 idbox 后 userData 变成 `%APPDATA%/idbox/`，必须把旧设置搬过来。
 */
export const LEGACY_APP_DIR_NAME = 'modvault'

/** 候选盘根目录，按"大文件优先"排序；E 盘命中则沿用 `DEFAULT_LIBRARY_DIR` */
const CANDIDATE_ROOTS = ['E:\\', 'D:\\', 'C:\\']

const DisposalSchema = z
  .enum(['recycle', 'delete', 'keep', 'trash'])
  .transform((v): ArchiveDisposal => (v === 'trash' ? 'recycle' : v))

/**
 * AI 辅助分类子对象（docs/15 §7）。**逐字段 `.catch` + 整个对象 `.catch`**：
 * - 字段级：`enabled: "yes"` 这类脏值只让该字段回落默认，其余字段（尤其 apiKey）不丢；
 * - 对象级：`aiClassify: "garbage"` 这类整块脏值也不让 `safeParse` 整体失败
 *   （否则 loadSettings 会丢掉 libraryDir 等全部配置 —— 本项目在 `gridDensity` 上踩过这个坑）。
 */
const AiClassifySchema = z
  .object({
    enabled: z.boolean().optional().catch(false),
    baseUrl: z.string().optional().catch(''),
    apiKey: z.string().optional().catch(''),
    model: z.string().optional().catch('')
  })
  .catch({ enabled: false, baseUrl: '', apiKey: '', model: '' })
  .optional()

/** 导出仅供测试：验证单项降级语义（脏值不拖垮整份设置）。 */
export const SettingsSchema = z.object({
  libraryDir: z.string().min(1),
  archiveDisposal: DisposalSchema.optional(),
  defaultSource: z.string().optional(),
  watchDir: z.string().nullable().optional(),
  watchEnabled: z.boolean().optional(),
  sevenZipPath: z.string().nullable().optional(),
  extractTimeoutMs: z.number().int().positive().optional(),
  maxBytesForJsFallback: z.number().int().positive().optional(),
  codepage: z.enum(['gbk', 'utf8', 'auto']).optional(),
  thumbMaxPx: z.number().int().positive().optional(),
  /** 网格密度三档（反馈 6b）；旧档缺此键 → DEFAULT_SETTINGS 兜底 medium。
   *  `.catch('medium')`：**脏值不能让整份设置回退默认**（zod enum 默认行为是
   *  safeParse 整体失败 → loadSettings 丢掉库路径等全部配置），这里单项降级。 */
  gridDensity: z.enum(['large', 'medium', 'small']).optional().catch('medium'),
  /**
   * 材质球舞台开关（docs/19 裁定①，默认 **false**）。
   * 与 showFavorites 那三个**方向相反**：只有严格 true 才开，缺键 / 脏值一律关
   * （`"yes"`、`1` 都不算开），且只让这一项回落，不拖垮整份 settings.json。
   */
  materialStage: z.boolean().optional().catch(false),
  /**
   * 删除策略四档（C 线，默认 `'30d'`）。
   * `.catch('30d')`：**单项降级**——一个脏值（如 `'7d'`、`true`）只让这一项回落，
   * 绝不能拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   */
  trashRetention: z.enum(['5d', '10d', '30d', 'recycle']).optional().catch('30d'),
  spaceSafetyFactor: z.number().positive().optional(),
  /** UI 主题（规范 §1；0.6.0 起支持 `system` = 跟随 Windows 深浅色） */
  theme: z.enum(['light', 'dark', 'system']).optional(),
  /**
   * 动效性能三档（默认 `balanced`，设置·外观「动效性能」）。
   *
   * `.optional().catch('balanced')`：**单项降级** —— 手改档 / 旧版本写坏的值
   * （`'high'`、`3`、`null`）只让这一项回落均衡，不拖垮整份 settings.json
   * （zod enum 的默认行为是 safeParse 整体失败 → loadSettings 丢掉 libraryDir，
   * 本项目在 gridDensity / trashRetention 上都踩过这个坑，策略与它们保持一致）。
   * 缺键时 `.optional()` 产出 `undefined`，再由 `normalizeSettings` 收口成 'balanced'。
   */
  motionQuality: z.enum(['smooth', 'balanced', 'ultra']).optional().catch('balanced'),
  /** 同时解压任务数（1-8） */
  extractConcurrency: z.number().int().min(1).max(8).optional(),
  /**
   * 诊断日志详细级别（默认 false）。`.catch(false)`：旧档缺键 / 脏值
   * （`"yes"`、`1`）都只让这一项回落，**不能拖垮整份 settings.json**。
   */
  verboseLogging: z.boolean().optional().catch(false),
  /**
   * 侧栏「整理」组三个入口开关（默认 true）。
   * `.catch(true)`：旧档缺键 / 脏值（`"yes"`、`1`）都降级为「显示」，
   * 且**只让该项回落**，不拖垮整份 settings.json（与 showHelpHint 同策略）。
   */
  showFavorites: z.boolean().optional().catch(true),
  showColorTags: z.boolean().optional().catch(true),
  showDuplicates: z.boolean().optional().catch(true),
  /**
   * 知末封面抓取总开关（docs/24 §3.5，默认 **true**）。
   *
   * `.catch(true)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落默认，
   * 不拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   * 方向与 `materialStage` / `verboseLogging` **相反**：那两个默认关，这个默认开。
   */
  zhimoCover: z.boolean().optional().catch(true),
  /**
   * 包内已有预览图时是否仍用知末图替换（默认 **true**）。
   * 同上：单项降级 + 默认开；与总开关**互不牵连**（见 normalizeSettings）。
   */
  zhimoCoverReplacePacked: z.boolean().optional().catch(true),
  /**
   * 启动时自动检查更新（默认 **true**）。
   *
   * `.catch(true)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落默认，
   * 不拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   * 方向与 `zhimoCover` 一致：默认开，只有严格 `false` 才关。
   */
  autoCheckUpdate: z.boolean().optional().catch(true),
  /** AI 辅助分类（默认关闭；逐字段降级，见 AiClassifySchema 注释） */
  aiClassify: AiClassifySchema,
  /**
   * 别名映射表（0.6.0）。单项脏值只丢该项，整表坏掉就回落空数组
   * （空数组 = 显示名走 `displayName()` 的老规则，绝不因为别名表坏掉而没名字）。
   */
  aliases: z
    .array(
      z.object({
        id: z.string().min(1),
        scope: z.enum(['key', 'asset']),
        key: z.string(),
        name: z.string(),
        createdAt: z.number()
      })
    )
    .optional()
    .catch([]),
  /** 智能集合（0.6.0）。同上：坏项丢弃，整表坏掉回落空。 */
  savedViews: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        filters: z.record(z.unknown()),
        sort: z.string().optional(),
        createdAt: z.number()
      })
    )
    .optional()
    .catch([]),
  /** 批量重命名默认模板（0.6.0）；缺键 / 脏值回落 `{name}`（= 不改名） */
  renameTemplate: z.string().optional().catch('{name}'),
  /** @deprecated 旧档迁移用 */
  trashArchiveAfterImport: z.boolean().optional()
})

type RawSettings = z.infer<typeof SettingsSchema>

export function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/**
 * 一代备份路径（`settings.json.bak`）。
 *
 * 只保留**一代**：设置文件很小，多代备份的收益远低于"多一份就需要清理策略"的成本；
 * 目的只有一个——主档被写坏时还能捞回上一次有效值（尤其 `libraryDir`）。
 */
export function settingsBackupPath(): string {
  return `${settingsFilePath()}.bak`
}

/** 原子写的临时文件（与主档同目录同卷，`rename` 才是原子的） */
export function settingsTmpPath(): string {
  return `${settingsFilePath()}.tmp`
}

// ── 品牌更名设置迁移（modvault → idbox，2026-10 装机反馈 P0） ──────────────
//
// 背景：userData 目录名取自 package.json 的 `name`。name 从 `modvault` 改成 `idbox`
// 后，v0.1.0 用户存在 `%APPDATA%/modvault/settings.json` 里的配置（库路径
// `E:\ModVault\Library`、原包处置三档、监控目录…）在新目录 `%APPDATA%/idbox/`
// 下读不到 → 用户升级后"库消失了"（退化成默认值，资产全部从 UI 消失）。
//
// 迁移规则（用户数据零损失优先）：
//   ① 新目录没有 settings.json 且旧目录有 → **复制**过来（保留原文件不动，不移动）；
//   ② 新目录已有 → 不覆盖（以新目录为准，可能是用户已重新配置过）；
//   ③ 旧目录没有 → 正常走默认值（全新用户）。
// 任何 IO 失败都静默吞掉：迁移只是体验优化，绝不能阻断启动。

/** 迁移动作（纯函数 `planSettingsMigration` 的判定结果） */
export type SettingsMigrationAction = 'copy' | 'skip-new-exists' | 'skip-no-legacy' | 'skip-same-path'

export interface SettingsMigrationPlan {
  action: SettingsMigrationAction
  /** 源文件（旧目录 settings.json） */
  from: string
  /** 目标文件（新目录 settings.json） */
  to: string
}

/** 旧版 settings.json 路径：`<userData 父目录>/modvault/settings.json` */
export function legacySettingsFilePath(userDataDir: string): string {
  return path.join(path.dirname(userDataDir), LEGACY_APP_DIR_NAME, 'settings.json')
}

/**
 * 迁移判定的**纯函数**（零 IO，可单测）：两个存在性标志由调用方注入
 * （生产传 `existsSync`，测试传桩），路径全部由参数给出。
 */
export function planSettingsMigration(
  newSettingsPath: string,
  legacySettingsPath: string,
  exists: (p: string) => boolean = existsSync
): SettingsMigrationPlan {
  const from = legacySettingsPath
  const to = newSettingsPath
  if (!to || !from || to === from) return { action: 'skip-same-path', from, to }
  if (exists(to)) return { action: 'skip-new-exists', from, to }
  if (!exists(from)) return { action: 'skip-no-legacy', from, to }
  return { action: 'copy', from, to }
}

/**
 * 执行迁移（best-effort，**绝不抛错**）：按 `planSettingsMigration` 的判定，
 * 仅 `copy` 动作真正做 IO——`mkdir` 新 userData 目录 + `copyFile`（**不移动**，
 * 旧文件保留原位，用户回滚 v0.1.0 时数据还在）。
 */
export async function migrateLegacySettingsFile(userDataDir: string): Promise<SettingsMigrationPlan> {
  const plan = planSettingsMigration(
    path.join(userDataDir, 'settings.json'),
    legacySettingsFilePath(userDataDir)
  )
  if (plan.action !== 'copy') return plan
  try {
    await mkdir(userDataDir, { recursive: true })
    await copyFile(plan.from, plan.to)
  } catch (err) {
    // 迁移失败不阻断启动：loadSettings 会走默认值（与迁移前的行为一致）
    console.error('[idbox] 旧版设置迁移失败（将使用默认设置）：', plan.from, err)
  }
  return plan
}

/**
 * 旧档迁移（P0-5）：`trashArchiveAfterImport:true → 'recycle'`、`:false → 'keep'`；
 * 迁移后删掉 deprecated 键，写档不再带它。
 */
export function migrateSettings(raw: RawSettings): Settings {
  const disposal: ArchiveDisposal =
    raw.archiveDisposal ??
    (raw.trashArchiveAfterImport === false ? 'keep' : 'recycle')
  const next: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    archiveDisposal: disposal,
    // zod 的 `.optional()` 对缺键会产出 undefined（`.catch` 只管解析失败），
    // 所以缺键/脏值都要在这里再收口一次，保证返回的 Settings 是完整对象
    trashRetention: normalizeTrashRetention(raw.trashRetention),
    // zod 侧字段都是 optional（脏值逐字段降级），这里收口成完整对象，旧档缺键 → 默认关闭
    aiClassify: normalizeAiClassify(raw.aiClassify),
    // 0.6.0：别名表 / 智能集合 / 重命名模板 —— 旧档缺键 → 空数组 / 保守模板
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    savedViews: Array.isArray(raw.savedViews) ? raw.savedViews : [],
    renameTemplate:
      typeof raw.renameTemplate === 'string' && raw.renameTemplate.trim()
        ? raw.renameTemplate
        : DEFAULT_SETTINGS.renameTemplate
  }
  delete next.trashArchiveAfterImport
  return next
}

/**
 * 删除策略四档的**唯一归一化入口**（读档 / 写档 / 测试共用）。
 * 缺键、脏值（`'7d'`、`true`、`null`）一律回落默认 `'30d'`，绝不抛错。
 */
export function normalizeTrashRetention(v: unknown): TrashRetention {
  return v === '5d' || v === '10d' || v === '30d' || v === 'recycle' ? v : '30d'
}

/**
 * AI 辅助分类设置的**唯一归一化入口**（读档、写档、IPC 测试连接三处共用）。
 *
 * 四条规则：`enabled` 只认严格 true（"yes"/1 都不算，避免误开导致静默发网络请求）；
 * 三个字符串字段非字符串一律归 '' 并去首尾空白；**绝不抛错**（设置页任何脏输入都不能阻断保存）。
 */
export function normalizeAiClassify(
  raw: Partial<AiClassifySettings> | null | undefined
): AiClassifySettings {
  const src: Partial<AiClassifySettings> =
    raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: src.enabled === true,
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '',
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim() : '',
    model: typeof src.model === 'string' ? src.model.trim() : ''
  }
}

/** 写档前归一化：补齐默认值、丢弃未知键、确保数值为正 */
export function normalizeSettings(s: Partial<Settings>): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...s }
  merged.archiveDisposal = LEGACY_DISPOSAL_ALIASES[merged.archiveDisposal] ?? 'recycle'
  if (!Number.isFinite(merged.extractTimeoutMs) || merged.extractTimeoutMs <= 0) {
    merged.extractTimeoutMs = DEFAULT_SETTINGS.extractTimeoutMs
  }
  if (!Number.isFinite(merged.maxBytesForJsFallback) || merged.maxBytesForJsFallback <= 0) {
    merged.maxBytesForJsFallback = DEFAULT_SETTINGS.maxBytesForJsFallback
  }
  if (!Number.isFinite(merged.thumbMaxPx) || merged.thumbMaxPx <= 0) {
    merged.thumbMaxPx = DEFAULT_SETTINGS.thumbMaxPx
  }
  // 网格密度（反馈 6b）：只接受 large/medium/small，其余（旧档缺省之外的一切脏值）回落 medium
  if (
    merged.gridDensity !== 'large' &&
    merged.gridDensity !== 'medium' &&
    merged.gridDensity !== 'small'
  ) {
    merged.gridDensity = DEFAULT_SETTINGS.gridDensity
  }
  // 材质球舞台：只认严格 true（缺键 / "yes" / 1 一律关）；方向与 showFavorites 相反
  merged.materialStage = merged.materialStage === true ? true : false
  // 删除策略四档（C 线）：缺键 / 脏值一律回落 '30d'，单项降级不拖垮整份设置
  merged.trashRetention = normalizeTrashRetention(merged.trashRetention)
  if (!Number.isFinite(merged.spaceSafetyFactor) || merged.spaceSafetyFactor <= 0) {
    merged.spaceSafetyFactor = DEFAULT_SETTINGS.spaceSafetyFactor
  }
  // 主题：接受 light/dark/system，其余（含旧档脏值）回落默认浅色（规范 §1）。
  // ⚠️ 'system' 是 0.6.0 的**真功能**：落档保留，由渲染层用 matchMedia 解析成实际值。
  const theme: ThemeMode =
    merged.theme === 'dark' ? 'dark' : merged.theme === 'system' ? 'system' : 'light'
  merged.theme = theme
  // 动效性能三档：只接受 smooth/ultra，其余（缺键 / 脏值 / 手改档写成 'high'）回落 balanced。
  // 与 theme 同策略：**只让这一项回落**，绝不拖垮整份 settings.json。
  merged.motionQuality =
    merged.motionQuality === 'ultra' ? 'ultra' : merged.motionQuality === 'smooth' ? 'smooth' : 'balanced'
  // 帮助文本开关（走查 v0.2.2 C#19）：旧档无此键 → 补齐默认 true；脏值归一为布尔
  merged.showHelpHint = Boolean(merged.showHelpHint)
  // 侧栏入口开关：只有严格 false 才关闭，其余（缺键 / 脏值）一律按「显示」处理
  merged.showFavorites = merged.showFavorites === false ? false : true
  merged.showColorTags = merged.showColorTags === false ? false : true
  merged.showDuplicates = merged.showDuplicates === false ? false : true
  // 知末封面（docs/24 §3.5）：只认严格 false（'false' / 0 之类脏值一律按开；缺键 = 默认开）
  merged.zhimoCover = merged.zhimoCover === false ? false : true
  // ⚠️ 子开关**独立归一化**：即使 zhimoCover === false 也原样保留它的值。
  //    绝不能因为"总开关关了"就把它强制写成 false —— 用户关一次总开关会丢掉子偏好
  //    （下次打开总开关时用户设置被静默重置，属数据丢失）。
  merged.zhimoCoverReplacePacked = merged.zhimoCoverReplacePacked === false ? false : true
  // 启动时自动检查更新：只认严格 false（缺键 / 'false' / 0 之类脏值一律按开）
  merged.autoCheckUpdate = merged.autoCheckUpdate === false ? false : true
  // 并发 stepper（§3.6）：默认 2，夹到 [1, 8]
  const cc = merged.extractConcurrency
  if (!Number.isFinite(cc)) {
    merged.extractConcurrency = DEFAULT_SETTINGS.extractConcurrency
  } else {
    merged.extractConcurrency = Math.min(8, Math.max(1, Math.round(cc)))
  }
  // AI 辅助分类（docs/15 §7）：旧档无此键 → 全默认（关闭）；脏子对象逐字段降级不丢整份设置
  merged.aiClassify = normalizeAiClassify(merged.aiClassify)
  // 诊断日志详细级别：只认严格 true（"true"、1 之类脏值一律关闭，避免无意刷盘）
  merged.verboseLogging = merged.verboseLogging === true
  delete merged.trashArchiveAfterImport
  return merged
}

/**
 * 首次运行的库目录探测（U3）：按顺序选第一个"存在且可用空间 ≥20GB"的盘；
 * 都不满足时仍返回常量默认值（设置页会提示空间不足）。
 *
 * ⚠️ 非 E 盘的兜底目录名保持 `ModVault`（如 `D:\ModVault\Library`）**不是笔误**：
 * 品牌展示名已更名 ID BOX，但 v0.1.0 用户的库可能就建在这些路径下，
 * 改目录名等于把他们的库"弄丢"。`DEFAULT_LIBRARY_DIR` 同理（见 paths.ts）。
 */
export async function resolveDefaultLibraryDir(): Promise<string> {
  const roots = [...CANDIDATE_ROOTS, app.getPath('home')]
  for (const root of roots) {
    const free = await freeBytesOf(root)
    if (free !== null && free >= MIN_FREE_BYTES_FOR_LIBRARY) {
      return root === 'E:\\' ? DEFAULT_LIBRARY_DIR : path.join(root, 'ModVault', 'Library')
    }
  }
  return DEFAULT_LIBRARY_DIR
}

/**
 * 读一份设置文件并归一化；**文件不存在 / 非法 JSON / 结构不符** 一律返回 null。
 *
 * 抽出来是为了让 `loadSettings()` 能用同一套规则读主档与 `.bak`——
 * 两边规则一旦分叉，"备份能读但主档判定不同"这类 bug 就会悄悄出现。
 */
async function readSettingsFile(file: string): Promise<Settings | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch {
    return null // 首次运行 / 文件不存在
  }
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return migrateSettings(parsed.data)
  } catch {
    /* 截断的 JSON（写入中途被杀）/ 非法内容 → 交给调用方决定回落策略 */
  }
  return null
}

export async function loadSettings(): Promise<Settings> {
  // 品牌更名迁移（modvault → idbox）：先把旧 userData 目录的设置复制过来再读，
  // 否则老用户升级后读不到库路径，资产会全部从 UI 消失（2026-10 装机反馈 P0）。
  await migrateLegacySettingsFile(app.getPath('userData')).catch(() => {})

  const main = await readSettingsFile(settingsFilePath())
  if (main) return main

  // 主档缺失或损坏（典型：进程在 writeFile 中途被杀 → 截断 JSON）→ 先试一代备份。
  // ⚠️ 这一条是"库看起来空了"的最后防线：回落默认值会把 libraryDir 一起丢掉。
  const backup = await readSettingsFile(settingsBackupPath())
  if (backup) {
    console.error('[idbox] settings.json 不可用，已从 settings.json.bak 恢复')
    return backup
  }

  return { ...DEFAULT_SETTINGS, libraryDir: await resolveDefaultLibraryDir() }
}

/**
 * 保存设置（**原子写**）：
 *
 * ① 先写 `settings.json.tmp`（完整内容落盘，主档此刻仍完好）；
 * ② 把**当前有效的** `settings.json` 复制成 `settings.json.bak`（一代，不链式）；
 * ③ `rename(tmp → settings.json)`：同目录同卷，Windows 上允许覆盖，原子生效。
 *
 * 这样任何时刻被杀进程，磁盘上要么是旧档、要么是新档，**不会出现半截 JSON**。
 * 旧实现直接 `writeFile(主档)`：关机/任务管理器结束进程会留下截断文件 →
 * `loadSettings` 解析失败回落默认值 → `libraryDir` 丢失 → 用户看到"库空了"。
 */
export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const target = settingsFilePath()
  const tmp = settingsTmpPath()

  await writeFile(tmp, JSON.stringify(normalizeSettings(s), null, 2), 'utf-8')

  // 首次运行主档还不存在 → copyFile 抛 ENOENT，属正常情况（没有"上一份好档"）
  await copyFile(target, settingsBackupPath()).catch(() => undefined)

  await rename(tmp, target)
}
