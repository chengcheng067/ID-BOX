import { z } from 'zod'
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  HOME_PARTICLE_DENSITY_RANGE,
  HOME_PARTICLE_SIZE_RANGE,
  HOME_WAVE_LENGTH_RANGE,
  HOME_WAVE_SPEED_RANGE,
  LEGACY_DISPOSAL_ALIASES,
  clampHomeTideNumber,
  type ArchiveDisposal,
  type CloseBehavior,
  type Settings,
  type ThemeMode,
  type TrashRetention
} from '../shared/types'
import { DEFAULT_LIBRARY_DIR } from './paths'
import { freeBytesOf } from './disk'
import { DEFAULT_UNDO_GRACE_MS, normalizeUndoGraceMs } from '../shared/undoGrace'
import { normalizeCustomTaxonomy } from '../shared/customTaxonomy'
import { normalizeProjectTemplates } from '../shared/projectTemplate'
import { normalizePinnedViewPrefsMap } from '../shared/pinnedViewPrefs'
import { normalizeHomeFolderOrder } from '../shared/homeFolderOrder'
import { HEX_PATTERN, clampDimAlpha, clampWaveHeight, validHexOrNull } from '../shared/homeTide'
import type { HomePinnedFolder } from '../shared/types'

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
 * 首页海浪配色叶子（docs/55 §1.1）：非法 hex / 脏值 → `null`（= 走原 palette 兜底）。
 *
 * 正则直接复用 `shared/homeTide` 的 `HEX_PATTERN`，与渲染层共用同一份校验口径，
 * 避免两处正则漂移。`.nullable().optional().catch(null)` = 每个叶子单独降级。
 */
const WaveColorLeafSchema = z.string().regex(HEX_PATTERN).nullable().optional().catch(null)

/** 单主题海浪配色；整块脏掉也只回落这一块，不拖垮整份 settings.json。 */
const ThemeWaveColorsSchema = z
  .object({ waterColor: WaveColorLeafSchema, crestColor: WaveColorLeafSchema })
  .optional()
  .catch({ waterColor: null, crestColor: null })

/** 全默认海浪配色（`null` = 未自定义，旧档缺键落到这个形状 = 今天的行为）。 */
const DEFAULT_WAVE_COLORS = {
  light: { waterColor: null, crestColor: null },
  dark: { waterColor: null, crestColor: null }
}

/** 全默认首页背景（`source='none'` → 不渲染图片层与压暗层）。 */
const DEFAULT_HOME_BACKGROUND = {
  source: 'none' as const,
  fileName: null,
  sourceUrl: null,
  dimAlpha: 0.35
}

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
  /**
   * 删除撤销宽限期三档（毫秒：0 / 3000 / 5000，默认 5000）。
   *
   * `.optional().catch(5000)` = **单项降级**：`'abc'` / `null` / `true` 这类脏值只让
   * 这一项回落默认，绝不拖垮整份 settings.json（否则 `libraryDir` 一起丢、库会"消失"）。
   *
   * ⚠️ 这里只校验"是个数字"：`9999` 这类**越界但类型正确**的值由
   * `normalizeSettings` 里的 `normalizeUndoGraceMs` clamp 到三档（`0` 必须原样保留 ——
   * `0` 是合法档位「不等待」，任何 `|| 5000` 写法都会把它吃掉）。
   */
  undoGraceMs: z.number().optional().catch(DEFAULT_UNDO_GRACE_MS),
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
   * 首页右上数据卡开关（默认 true）。同上的降级策略：缺键 / 脏值都按「显示」，
   * 只让这一项回落，不拖垮整份 settings.json。
   */
  showHomeStats: z.boolean().optional().catch(true),
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
   * 导入批次结束后是否自动「按站方分类重排」（默认 **true**）。
   *
   * `.catch(true)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落默认，
   * 不拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   * 方向与 `zhimoCover` 一致：默认开，只有严格 `false` 才关。
   */
  zhimoAutoCategory: z.boolean().optional().catch(true),
  /**
   * 启动时自动检查更新（默认 **true**）。
   *
   * `.catch(true)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落默认，
   * 不拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   * 方向与 `zhimoCover` 一致：默认开，只有严格 `false` 才关。
   */
  autoCheckUpdate: z.boolean().optional().catch(true),
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
  /**
   * 用户自定义分类词表（2026-10）。schema 层放行任意形状（`z.unknown()`），
   * 逐条清洗 / 去重 / 剔除与预设撞名统一交给 `normalizeCustomTaxonomy`
   * （在 migrateSettings / normalizeSettings 两处收口）——脏词条只丢词条，
   * 绝不让整份 settings.json 回落默认。
   */
  customTaxonomy: z.unknown().optional(),
  /**
   * 左右侧边栏折叠（0.8.3，默认 **false** = 展开态）。
   * `.catch(false)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落展开，
   * 不拖垮整份 settings.json（否则 libraryDir 一起丢，库会"消失"）。
   * 方向与 `materialStage` 一致：只有严格 `true` 才折叠，缺键 / 脏值一律展开。
   */
  sidebarLeftCollapsed: z.boolean().optional().catch(false),
  sidebarRightCollapsed: z.boolean().optional().catch(false),
  /**
   * 插件索引导出开关（docs/39 §2.2 新发现第 4 条：原 schema 没有任何插件键，默认关）。
   *
   * `.optional().catch(false)`：**单项降级** —— 脏值（`'yes'` / `1` / `null`）只让这一项回落
   * 关闭，不拖垮整份 settings.json（否则 `libraryDir` 一起丢、库会"消失"；与 `gridDensity` /
   * `trashRetention` / `undoGraceMs` 同一纪律）。方向与 `materialStage` 一致：只有严格 `true`
   * 才开，缺键 / 脏值一律关。
   */
  pluginIndexEnabled: z.boolean().optional().catch(false),
  /**
   * 「插件写盘需要你主动开启」这条引导**是否已露过一次脸**（V1.0 D-2，docs/46 §1.7）。
   *
   * `.optional().catch(false)`：同样**单项降级** —— 脏值（`'true'` / `0` / `null`）只让这一项
   * 回落 `false`，不拖垮整份 settings.json。
   * ⚠️ 回落方向与上面 `pluginIndexEnabled` **故意相反**：这里到 `false` = 引导还要再显示一次。
   * 宁可多提示一次，也不要因为一个脏值把引导永久吞掉（用户就永远不知道插件为什么是空的）。
   * 与写盘开关是两个独立字段，**互不反写**。
   */
  pluginIndexGuideShown: z.boolean().optional().catch(false),
  // ── V1.0 首页自定义与引导（docs/55 §1.1）：每项叶子单项降级 ──────────────
  /**
   * 首页海浪配色。对象层 + 每片颜色叶子都带 `.catch`：
   * 非法 hex（`'#ggg'` / `'red'` / 数字）只让那片叶子回落 `null`，
   * 整块写坏（写成字符串 / 数组）才整块回落全 null —— **绝不拖垮整份 settings.json**
   * （否则 `libraryDir` 一起丢、库会"消失"）。
   */
  homeWaveColors: z
    .object({ light: ThemeWaveColorsSchema, dark: ThemeWaveColorsSchema })
    .optional()
    .catch(DEFAULT_WAVE_COLORS),
  /**
   * 首页海浪高度。这里只校验"是个数字"；
   * 越界值（`'large'` 被 catch 成 0.65，`99` / `-3` 这类类型正确但越界的）由
   * `normalizeSettings` / `migrateSettings` 里的 `clampWaveHeight()` 收口到 `[0.2, 1.5]`。
   */
  homeWaveHeight: z.number().optional().catch(0.65),
  /**
   * 海浪速度（2026-11-22 设置重排）。这里只校验"是个数字"；越界值由
   * `normalizeSettings` / `migrateSettings` 的 `clampHomeTideNumber(…, HOME_WAVE_SPEED_RANGE)`
   * 收口到 `[0.2, 4]`，脏类型回落 1.6（= 改动前 BASE_SPEED 定稿值）。
   */
  homeWaveSpeed: z.number().optional().catch(HOME_WAVE_SPEED_RANGE.default),
  /** 海浪波长（2026-11-22 设置重排）：同上，收口到 `[0.4, 3]`，脏类型回落 1.1。 */
  homeWaveLength: z.number().optional().catch(HOME_WAVE_LENGTH_RANGE.default),
  /** 粒子大小（2026-11-22 设置重排）：同上，收口到 `[1, 4]`，脏类型回落 2。 */
  homeParticleSize: z.number().optional().catch(HOME_PARTICLE_SIZE_RANGE.default),
  /** 粒子密度（2026-11-22 设置重排）：同上，收口到 `[0.3, 2]`，脏类型回落 1.5。 */
  homeParticleDensity: z.number().optional().catch(HOME_PARTICLE_DENSITY_RANGE.default),
  /**
   * 指针交互总闸（2026-11-22 设置重排，默认 **true** = 改动前行为）。
   * `.catch(true)` 单项降级；normalize / migrate 再收口「只认严格 false」。
   */
  homeWaveInteractive: z.boolean().optional().catch(true),
  /** 点击涟漪开关（2026-11-22 设置重排，默认 **true** = 改动前行为）。同上。 */
  homeWaveClickRipples: z.boolean().optional().catch(true),
  /**
   * 首页自定义背景图。`source` 用 enum 单项 catch；`fileName`/`sourceUrl` 叶子各自降级；
   * `dimAlpha` 越界由 `clampDimAlpha()` 收口到 `[0, 0.85]`。
   */
  homeBackground: z
    .object({
      source: z.enum(['none', 'local', 'url']).catch('none'),
      fileName: z.string().nullable().optional().catch(null),
      sourceUrl: z.string().nullable().optional().catch(null),
      dimAlpha: z.number().catch(0.35)
    })
    .optional()
    .catch(DEFAULT_HOME_BACKGROUND),
  /**
   * 项目文件夹模板（docs/60 §2，多模板 · Q-2 用户批注）。
   *
   * schema 层放行任意形状（`z.unknown()`），逐项清洗 / 剪枝 / id 去重 / 条数封顶 /
   * 整表坏回落默认统一交给 `normalizeProjectTemplates`（在 migrateSettings /
   * normalizeSettings 两处收口）—— `customTaxonomy` 同款分工：脏模板只丢模板，
   * 绝不让整份 settings.json 回落默认。
   */
  projectTemplates: z.unknown().optional(),
  /**
   * 首页快速访问钉选（F-1，docs/60 §6.1）。同上：schema 放行任意形状，
   * 归一化在 `normalizeHomePinnedFolders` 收口（脏类型丢弃 / absPath 非绝对丢弃 /
   * 同 absPath 去重 / 条数封顶），单项降级不拖垮整份 settings.json。
   */
  homePinnedFolders: z.unknown().optional(),
  /**
   * 钉选目录浏览器的视图 / 排序记忆（2026-11-25 用户需求①）。同上：schema 放行任意形状，
   * 归一化在 `normalizePinnedViewPrefsMap` 收口（脏条目丢弃 / 未知视图回落列表 / 32 键封顶），
   * 单项降级不拖垮整份 settings.json。
   */
  pinnedViewPrefs: z.unknown().optional(),
  /**
   * 文件夹底纹映射（F-3，docs/60 §6.3）。同上：归一化在 `normalizeHomeFolderWallpaper`
   * 收口（未知命名空间键丢弃 / 空 fileName 丢弃 / 键数封顶）。
   */
  homeFolderWallpaper: z.unknown().optional(),
  /**
   * 首页文件夹排拖动排序（2026-11-25 用户需求）。同上：schema 放行任意形状，
   * 归一化在 `normalizeHomeFolderOrder` 收口（脏项丢弃 / 去重保序 / 64 封顶 / 未知键保留），
   * 单项降级不拖垮整份 settings.json。
   */
  homeFolderOrder: z.unknown().optional(),
  /** 首页引导首启是否已展示：脏值回落 `false` = 再显示一次（宁可多提示）。 */
  homeGuideFirstRunShown: z.boolean().optional().catch(false),
  /** 上次展示引导的版本号：脏值回落 `null`。 */
  homeGuideLastVersion: z.string().nullable().optional().catch(null),
  /** 首页引导是否被永久关闭：脏值回落 `false`。 */
  homeGuideDisabled: z.boolean().optional().catch(false),
  /**
   * 关闭主窗口的行为三档（默认 `'ask'` = 点 ✕ 弹窗询问，用户选了才执行）。
   *
   * `.optional().catch('ask')` = **单项降级**：手改档写坏的值（`'minimize'`、`1`、`null`）
   * 只让这一项回落「每次询问」，绝不拖垮整份 settings.json（zod 裸 enum 的默认行为是
   * `safeParse` 整体失败 → `loadSettings` 丢掉 `libraryDir`，本仓库在 gridDensity /
   * trashRetention / motionQuality 上都踩过这个坑，策略与它们保持一致）。
   * 缺键时 `.optional()` 产出 `undefined`，再由 `normalizeSettings` / `migrateSettings`
   * 用 `normalizeCloseBehavior` 收口成 `'ask'`。
   */
  closeBehavior: z.enum(['ask', 'quit', 'tray']).optional().catch('ask'),
  /**
   * 「关闭窗口时」一次性迁移标记（升级水位线，2026-11-27 装机反馈 v1.2.1）。
   *
   * 缺键 = 1.2.1 之前写出的档 → `loadSettings` 会强制落 `'ask'` 并写回标记。
   * `.optional().catch(false)`：脏值只丢这一项（回落 false = 视为"未迁移"，
   * 宁可多迁移一次也不漏掉残留档），绝不拖垮整份 settings.json —— 与 gridDensity /
   * trashRetention / motionQuality 的单项降级策略一致。
   */
  closeBehaviorMigrated: z.boolean().optional().catch(false),
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

// ── 设置写盘串行队列（0.7.10 / 真机 QA 抓到的并发写 ENOENT） ────────────────
//
// 现场（qa-settings-tmp/evidence-settings-write-race.log）：连续调 6 个开关时，
// 130ms 内触发 6 次 `settings:set` → 6 个 `saveSettings` 同时在跑，其中一次的
// `rename(settings.json.tmp → settings.json)` 抛 ENOENT，冒到渲染层变成
// unhandledrejection（用户看到"保存失败"的红色报错，但最终内容又是对的）。
//
// 根因：原子写本身是对的（写 tmp → 备份 → rename），但**临时文件名是固定的**
// `${settings.json}.tmp`（固定名是刻意保留的：保证 rename 与主档同目录同卷、
// 崩溃后残留文件可预测、清理逻辑只需认一个名字）。固定名 + 无串行 = 多次并发
// 共用同一个 tmp：
//   A.writeFile(tmp) → B.writeFile(tmp) → A.rename 成功 → B.rename 时 tmp 已不在 → ENOENT
//
// 比 ENOENT 更隐蔽的是**内容互相覆盖**：A、B 在同一个 tmp 上先后写入，谁 rename
// 得晚谁的旧内容覆盖新内容 → 中间某次设置被静默丢弃（"改了没生效"）。
// 注意：**换成随机 tmp 名只能消掉 ENOENT，治不了覆盖/乱序**，所以修法是串行化。
//
// 串行后语义：写盘顺序 === `saveSettings` 调用顺序，最后调用的那次内容即最终落盘
// 内容；每次写仍是完整的「写 tmp → 备份 → rename」，崩溃安全性不变。

/** 串行写队列（纯逻辑、零 IO，可单测） */
export interface SettingsWriteQueue {
  /** 把一次写盘动作排到链尾；返回的 Promise 兑现这一次任务自己的结果/错误 */
  enqueue<T>(fn: () => Promise<T>): Promise<T>
  /** 队列**排空**后 resolve（失败也算排空）；永不 reject，方便测试收尾 */
  idle(): Promise<void>
}

/**
 * 创建一个串行写队列。
 *
 * 关键点（两条都不能少）：
 * 1. `writeChain.then(fn, fn)`：**前一次失败时仍要执行这一次**。只写 `then(fn)`
 *    的话，一个 ENOENT/EACCES 会把队列永久卡死——之后所有设置都存不下去，而且
 *    用户不会看到任何报错（链上挂着一个已 reject 的 Promise）。
 * 2. `writeChain = next.catch(() => undefined)`：链自己**不持有 rejection**。
 *    若把 `next` 直接赋给链，无人 await 的那次失败就是一个 unhandledrejection
 *    （正是本次 bug 冒到渲染层的形态）。失败只回传给该次的调用方。
 */
export function createSettingsWriteQueue(): SettingsWriteQueue {
  let writeChain: Promise<unknown> = Promise.resolve()
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const next = writeChain.then(fn, fn)
      writeChain = next.catch(() => undefined)
      return next
    },
    idle(): Promise<void> {
      return writeChain.then(
        () => undefined,
        () => undefined
      )
    }
  }
}

/** 全进程唯一的设置写队列：`saveSettings` 的每次调用都排在这条链上 */
const settingsWriteQueue = createSettingsWriteQueue()

/**
 * 把一次写盘动作排进串行队列（导出仅供测试与诊断；生产只有 `saveSettings` 走它）。
 *
 * 任何新增的"写 settings.json"路径都**必须**经过这里，否则又会绕过串行化。
 */
export function enqueueSettingsWrite<T>(fn: () => Promise<T>): Promise<T> {
  return settingsWriteQueue.enqueue(fn)
}

/** 等待当前写队列排空（测试/退出前用；永不 reject） */
export function settingsWritesIdle(): Promise<void> {
  return settingsWriteQueue.idle()
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
 * 首页海浪配色的**唯一归一化入口**（读档 / 写档共用）。
 *
 * 每片颜色单独过 `validHexOrNull`：非法 hex 只丢那一片（→ null = 走原 palette），
 * 绝不因为一片脏色就把整个 `homeWaveColors`（更别说整份 settings.json）打回默认。
 */
function normalizeHomeWaveColors(value: unknown): Settings['homeWaveColors'] {
  const obj = (value && typeof value === 'object' ? value : {}) as {
    light?: { waterColor?: unknown; crestColor?: unknown }
    dark?: { waterColor?: unknown; crestColor?: unknown }
  }
  return {
    light: {
      waterColor: validHexOrNull(obj.light?.waterColor),
      crestColor: validHexOrNull(obj.light?.crestColor)
    },
    dark: {
      waterColor: validHexOrNull(obj.dark?.waterColor),
      crestColor: validHexOrNull(obj.dark?.crestColor)
    }
  }
}

/**
 * 首页背景图的**唯一归一化入口**（读档 / 写档共用）。
 * `source` 只认三个合法枚举值；两个字符串叶子脏了各自回落 null；`dimAlpha` 由
 * `clampDimAlpha` 收口到 `[0, 0.85]`。整块非法时回到 `source='none'` = 不渲染。
 */
function normalizeHomeBackground(value: unknown): Settings['homeBackground'] {
  const obj = (value && typeof value === 'object' ? value : {}) as {
    source?: unknown
    fileName?: unknown
    sourceUrl?: unknown
    dimAlpha?: unknown
  }
  return {
    source:
      obj.source === 'none' || obj.source === 'local' || obj.source === 'url'
        ? obj.source
        : 'none',
    fileName: typeof obj.fileName === 'string' ? obj.fileName : null,
    sourceUrl: typeof obj.sourceUrl === 'string' ? obj.sourceUrl : null,
    dimAlpha: clampDimAlpha(obj.dimAlpha)
  }
}

// ── 首页快速访问钉选 / 文件夹底纹（docs/60 §6.1 / §6.3，T-01） ────────────────
//
// 两条数据都是 docs/60 新增的 Settings 键：读档 / 写档共用同一归一化入口
// （normalizeHomeWaveColors 同款纪律），**永不抛错**、单项降级不拖垮整份 settings.json。
// ⚠️ 两者都**不入**打包白名单 `PERSONAL_SETTINGS_KEYS`（§5.3 写死：机器路径 / 缓存引用）。

/** 宽松对象判定（数组不算对象入参；settings.ts 内部小工具，勿与 shared 版混用） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 钉选条数上限（docs/60 §6.1 ④ 判据：「上限 32 条封顶防排爆」） */
export const MAX_HOME_PINNED_FOLDERS = 32

/** 底纹映射键数上限（docs/60 §6.3 ④ 判据：「上限 64 键封顶」） */
export const MAX_HOME_FOLDER_WALLPAPER_KEYS = 64

/** 底纹 key 的两个合法命名空间：`kind:<AssetKind|KindGroup>` / `pin:<钉选 id>` */
const WALLPAPER_KEY_RE = /^(kind|pin):.+$/

/**
 * 首页快速访问钉选的**唯一归一化入口**（读档 / 写档共用，docs/60 §6.1 ④）。
 *
 * - 非数组 → 空数组（= 没有钉选，回落默认行为）；
 * - 脏项（非对象 / `id`·`name`·`absPath` 缺失或非字符串）逐条丢弃；
 * - `absPath` 必须是**绝对路径**（`path.isAbsolute`）—— 相对路径无法在主进程
 *   `home:pinnedOpen` 里定位，带进 Settings 只会产出永远打不开的死卡；
 * - 同 `absPath` 去重（保留先出现的那条 —— §6.1 添加入口已查重，这里是手改档兜底）；
 * - 条数 > `MAX_HOME_PINNED_FOLDERS`(32) 截断（保序：数组顺序即显示顺序）。
 */
export function normalizeHomePinnedFolders(value: unknown): HomePinnedFolder[] {
  if (!Array.isArray(value)) return []
  const out: HomePinnedFolder[] = []
  const seenAbs = new Set<string>()
  for (const raw of value) {
    if (out.length >= MAX_HOME_PINNED_FOLDERS) break
    if (!isPlainObject(raw)) continue
    const { id, name, absPath } = raw as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim()) continue
    if (typeof name !== 'string' || !name.trim()) continue
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) continue
    if (seenAbs.has(absPath)) continue
    seenAbs.add(absPath)
    out.push({ id, name, absPath })
  }
  return out
}

/**
 * 文件夹底纹映射的**唯一归一化入口**（读档 / 写档共用，docs/60 §6.3 ④）。
 *
 * - 非对象 → 空映射（= 全部回落默认底纹）；
 * - key 不在两个合法命名空间（`kind:` / `pin:`）内 → 丢弃（防手改档把任意键写进来）；
 * - value 非字符串 / trim 后为空 → 丢弃（空引用只会渲染出坏图）；
 * - 键数 > `MAX_HOME_FOLDER_WALLPAPER_KEYS`(64) 截断。
 *
 * ⚠️ 这里**不做** `<sha256>.<ext>` 形态校验：fileName 只是对 home-bg 目录的引用，
 * 文件本体可能尚未落盘（异步时序）或由既有 `homeBackground:save` 机制命名 ——
 * 形态正则断言归 `tests/homePinned.test.ts`（T-05）与真机 QA，归一化只保证"是合法引用"。
 */
export function normalizeHomeFolderWallpaper(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_HOME_FOLDER_WALLPAPER_KEYS) break
    if (!WALLPAPER_KEY_RE.test(key)) continue
    if (typeof val !== 'string') continue
    const fileName = val.trim()
    if (!fileName) continue
    out[key] = fileName
  }
  return out
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
    // 删除撤销期三档：旧档缺键（undefined）/ 脏值都在这里收口成 5000；
    // `0`（不等待）必须原样保留 —— 它是合法档位，不能被"falsy 兜底"吃掉。
    undoGraceMs: normalizeUndoGraceMs(raw.undoGraceMs),
    // 0.6.0：别名表 / 智能集合 / 重命名模板 —— 旧档缺键 → 空数组 / 保守模板
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    savedViews: Array.isArray(raw.savedViews) ? raw.savedViews : [],
    renameTemplate:
      typeof raw.renameTemplate === 'string' && raw.renameTemplate.trim()
        ? raw.renameTemplate
        : DEFAULT_SETTINGS.renameTemplate,
    // 自定义分类词表（2026-10）：旧档缺键 → 空词表；脏词条逐条清洗丢弃
    customTaxonomy: normalizeCustomTaxonomy(raw.customTaxonomy),
    // 左右侧边栏折叠（0.8.3）：旧档缺键 → 展开；只认严格 true（zod 侧脏值已 catch 成 false，
    // 这里再收口一次保证返回的 Settings 是完整布尔对象）
    sidebarLeftCollapsed: raw.sidebarLeftCollapsed === true,
    sidebarRightCollapsed: raw.sidebarRightCollapsed === true,
    // V1.0 首页自定义（docs/55 §1.1）：旧档缺键 → 全 null / 0.65 / none → 行为与今天逐字一致。
    // ⚠️ `.optional()` 对缺键产出 undefined，直接展开会覆盖 DEFAULT_SETTINGS 的默认值，
    //    所以这六项必须在这里逐个收口（与 undoGraceMs / customTaxonomy 同一纪律）。
    homeWaveColors: normalizeHomeWaveColors(raw.homeWaveColors),
    homeWaveHeight: clampWaveHeight(raw.homeWaveHeight),
    // 海浪参数六项（2026-11-22 设置重排）：旧档缺键 → 引擎定稿默认值，默认画面逐帧一致。
    // 数值项 clamp 收口；两个布尔项「只认严格 false 才关」（与改动前"永远开"一致）。
    homeWaveSpeed: clampHomeTideNumber(raw.homeWaveSpeed, HOME_WAVE_SPEED_RANGE),
    homeWaveLength: clampHomeTideNumber(raw.homeWaveLength, HOME_WAVE_LENGTH_RANGE),
    homeParticleSize: clampHomeTideNumber(raw.homeParticleSize, HOME_PARTICLE_SIZE_RANGE),
    homeParticleDensity: clampHomeTideNumber(raw.homeParticleDensity, HOME_PARTICLE_DENSITY_RANGE),
    homeWaveInteractive: raw.homeWaveInteractive !== false,
    homeWaveClickRipples: raw.homeWaveClickRipples !== false,
    homeBackground: normalizeHomeBackground(raw.homeBackground),
    // 项目模板 / 快速访问钉选 / 底纹（docs/60 T-01）：旧档缺键 → 内置 4×15 模板 /
    // 空钉选表 / 空底纹映射 —— 升级零迁移、行为不变。脏表只丢表，绝不拖垮整份 settings。
    projectTemplates: normalizeProjectTemplates(raw.projectTemplates),
    homePinnedFolders: normalizeHomePinnedFolders(raw.homePinnedFolders),
    pinnedViewPrefs: normalizePinnedViewPrefsMap(raw.pinnedViewPrefs),
    homeFolderWallpaper: normalizeHomeFolderWallpaper(raw.homeFolderWallpaper),
    // 拖动排序（2026-11-25）：旧档缺键 → 空表 = 默认排布，升级零迁移。
    homeFolderOrder: normalizeHomeFolderOrder(raw.homeFolderOrder),
    homeGuideFirstRunShown: raw.homeGuideFirstRunShown === true,
    homeGuideLastVersion:
      typeof raw.homeGuideLastVersion === 'string' ? raw.homeGuideLastVersion : null,
    homeGuideDisabled: raw.homeGuideDisabled === true,
    // 关闭窗口行为（默认 'ask' = 每次询问）：旧档缺键 / 脏值都在这里收口成「每次询问」，
    // 保证返回的 Settings 是完整对象（`.optional()` 缺键产出 undefined 会覆盖默认值）
    closeBehavior: normalizeCloseBehavior(raw.closeBehavior),
    // 迁移标记只认严格 true：缺键 / 脏值 = 未迁移（宁多迁一次，不漏残留档）
    closeBehaviorMigrated: raw.closeBehaviorMigrated === true
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
 * 关闭窗口行为三档的**唯一归一化入口**（读档 / 写档 / 测试共用）。
 *
 * 三个合法值（`'ask'` / `'quit'` / `'tray'`）原样保留；缺键、脏值（`'minimize'`、
 * `1`、`null`、`true`）一律回落默认 `'ask'`（= 每次点 ✕ 都问一次），绝不抛错。
 *
 * ⚠️ 默认档从 `'quit'` 改成 `'ask'`（2026-11 用户需求）：老档缺键的升级用户因此落到
 * 「每次询问」。这是**刻意**的 —— 静默退出会掐断正在跑的导入与分类，而多问一次
 * 的成本只是点一下，且用户第一次点 ✕ 就看到了选择机会。
 */
export function normalizeCloseBehavior(v: unknown): CloseBehavior {
  if (v === 'quit' || v === 'tray' || v === 'ask') return v
  return 'ask'
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
  // 删除撤销期三档（0 / 3000 / 5000）：缺键 / 9999 / 'abc' / null 一律回落 5000。
  // ⚠️ 绝不能写成 `merged.undoGraceMs || 5000`：`0` 是合法档位「不等待」，
  //    `||` 会把 0 当 falsy 吃掉 → 用户设了"不等待"却仍然等 5 秒。
  //    `{ ...DEFAULT_SETTINGS, ...s }` 在 s 里显式带 0 时保留 0，这里只需 clamp 类型范围。
  merged.undoGraceMs = normalizeUndoGraceMs(merged.undoGraceMs)
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
  // 首页数据卡：同样只有严格 false 才关闭
  merged.showHomeStats = merged.showHomeStats === false ? false : true
  // 知末封面（docs/24 §3.5）：只认严格 false（'false' / 0 之类脏值一律按开；缺键 = 默认开）
  merged.zhimoCover = merged.zhimoCover === false ? false : true
  // ⚠️ 子开关**独立归一化**：即使 zhimoCover === false 也原样保留它的值。
  //    绝不能因为"总开关关了"就把它强制写成 false —— 用户关一次总开关会丢掉子偏好
  //    （下次打开总开关时用户设置被静默重置，属数据丢失）。
  merged.zhimoCoverReplacePacked = merged.zhimoCoverReplacePacked === false ? false : true
  // 按站方分类自动落库（知末通道）：只认严格 false（缺键 / 'false' / 0 之类脏值一律按开）。
  // 与 `zhimoCover` 同口径：它只约束自动任务，设置页的手动重排按钮不看这个开关。
  merged.zhimoAutoCategory = merged.zhimoAutoCategory === false ? false : true
  // 启动时自动检查更新：只认严格 false（缺键 / 'false' / 0 之类脏值一律按开）
  merged.autoCheckUpdate = merged.autoCheckUpdate === false ? false : true
  // 并发 stepper（§3.6）：默认 2，夹到 [1, 8]
  const cc = merged.extractConcurrency
  if (!Number.isFinite(cc)) {
    merged.extractConcurrency = DEFAULT_SETTINGS.extractConcurrency
  } else {
    merged.extractConcurrency = Math.min(8, Math.max(1, Math.round(cc)))
  }
  // 诊断日志详细级别：只认严格 true（"true"、1 之类脏值一律关闭，避免无意刷盘）
  merged.verboseLogging = merged.verboseLogging === true
  // 自定义分类词表（2026-10）：单条新增也可能带脏值，写档前再统一清洗一遍
  merged.customTaxonomy = normalizeCustomTaxonomy(merged.customTaxonomy)
  // 左右侧边栏折叠（0.8.3）：只认严格 true（缺键 / 'yes' / 1 之类脏值一律展开）
  merged.sidebarLeftCollapsed = merged.sidebarLeftCollapsed === true
  merged.sidebarRightCollapsed = merged.sidebarRightCollapsed === true
  // 插件索引导出（docs/39 §2.2）：只认严格 true（缺键 / 'yes' / 1 一律关）——与 materialStage
  // 同方向。这个值会落进 `manifest.pluginIndexEnabled`，插件靠它区分「未开导出」(IDBOX-101)，
  // 所以归一化必须收口成布尔、不能留 undefined。
  merged.pluginIndexEnabled = merged.pluginIndexEnabled === true
  // D-2 引导「已展示」(docs/46 §1.7)：只认严格 true 才算"看过了"；缺键 / 'true' / 0 / null
  // 一律回落到 false = 下次还显示。**方向与上面一条相反是刻意的**：写盘开关回落成"关"是安全的，
  // 引导回落成"已看过"则会让用户永远看不到提示、也就永远不知道插件为什么是空面板。
  // 这两项各自独立、互不反写（不自动勾选写盘、也不因勾选而反写本项）。
  merged.pluginIndexGuideShown = merged.pluginIndexGuideShown === true
  // V1.0 首页自定义（docs/55 §1.1）：写档前再收口一次。脏值只回落该项，
  // 绝不拖垮整份 settings.json（与 pluginIndexGuideShown 等同一项纪律）。
  merged.homeWaveColors = normalizeHomeWaveColors(merged.homeWaveColors)
  merged.homeWaveHeight = clampWaveHeight(merged.homeWaveHeight)
  // 海浪参数六项（2026-11-22 设置重排）：写档前再收口一次（与读档同一口径）
  merged.homeWaveSpeed = clampHomeTideNumber(merged.homeWaveSpeed, HOME_WAVE_SPEED_RANGE)
  merged.homeWaveLength = clampHomeTideNumber(merged.homeWaveLength, HOME_WAVE_LENGTH_RANGE)
  merged.homeParticleSize = clampHomeTideNumber(merged.homeParticleSize, HOME_PARTICLE_SIZE_RANGE)
  merged.homeParticleDensity = clampHomeTideNumber(merged.homeParticleDensity, HOME_PARTICLE_DENSITY_RANGE)
  merged.homeWaveInteractive = merged.homeWaveInteractive !== false
  merged.homeWaveClickRipples = merged.homeWaveClickRipples !== false
  merged.homeBackground = normalizeHomeBackground(merged.homeBackground)
  // 项目模板 / 快速访问钉选 / 底纹（docs/60 T-01）：写档前再收口一次（与读档同一口径；
  // 设置页单条编辑也可能带脏值进来）。归一化实现在 shared/projectTemplate.ts 与本文件
  // 上方两个函数 —— 唯一实现，别处不得复制。
  merged.projectTemplates = normalizeProjectTemplates(merged.projectTemplates)
  merged.homePinnedFolders = normalizeHomePinnedFolders(merged.homePinnedFolders)
  // 视图 / 排序记忆（2026-11-25）：写档前再收口一次（与读档同一口径；
  // 渲染层 patch 也可能带脏值进来）。脏值只丢那一条，不拖垮整份 settings.json。
  merged.pinnedViewPrefs = normalizePinnedViewPrefsMap(merged.pinnedViewPrefs)
  merged.homeFolderWallpaper = normalizeHomeFolderWallpaper(merged.homeFolderWallpaper)
  // 拖动排序（2026-11-25）：写档前再收口一次（与读档同一口径；渲染层 patch 也可能带脏值）。
  merged.homeFolderOrder = normalizeHomeFolderOrder(merged.homeFolderOrder)
  merged.homeGuideFirstRunShown = merged.homeGuideFirstRunShown === true
  merged.homeGuideLastVersion =
    typeof merged.homeGuideLastVersion === 'string' ? merged.homeGuideLastVersion : null
  merged.homeGuideDisabled = merged.homeGuideDisabled === true
  // 关闭窗口行为（设置·外观「窗口与后台」）：写档前再收口一次（与读档同一口径；
  // 渲染层 patch 也可能带脏值进来）。只认三个合法档位，其余一律「每次询问」。
  merged.closeBehavior = normalizeCloseBehavior(merged.closeBehavior)
  // 迁移标记写档前再收口一次（与读档同一口径）：只认严格 true。
  // ⚠️ 这里**不负责**翻牌 —— 迁移点在 `loadSettings`（读档侧，见
  //    `planCloseBehaviorMigration`），写档侧只做透传收口，否则会把用户升级后
  //    的显式选择也打回 'ask'。
  merged.closeBehaviorMigrated = merged.closeBehaviorMigrated === true
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

/**
 * 「关闭窗口时」一次性迁移的**纯决策函数**（2026-11-27 装机反馈，v1.2.1）。
 *
 * 背景（为什么必须有这条迁移）：v1.2.0 及更早**根本没有** closeBehavior 字段，
 * 外部老用户升级上来走默认 `'ask'` 是对的；但 dev / 测试期间的机器 settings.json
 * 里已经落了残留值（用户杨雯丞的档里是 `"closeBehavior": "tray"`），原样读入 →
 * 第一次点 ✕ 不弹窗。产品口径：**升级到 1.2.1 后第一次必须落在「每次询问」**。
 *
 * 规则：
 * - 标记不是严格 `true`（缺键 / 脏值 / `false`）→ 视为"1.2.1 之前写出的档"，
 *   返回**新对象**：`closeBehavior` 强制 `'ask'` + 标记置 `true`；
 * - 标记已是 `true` → 返回 `null`（什么都不动，用户的显式选择永远不被再碰）。
 *
 * ⚠️ 为什么迁移点在 **读档侧**（`loadSettings`）而不是写档侧
 * （`normalizeSettings` / `migrateSettings`）：写档侧每次保存都会跑，会把用户
 * 升级后的显式选择也打回 `'ask'`；读档侧一个进程只在启动时跑一次（标记落盘后
 * `if (=== true) return null` 短路），语义正是"升级后的第一次"。
 *
 * 纯函数（不做 IO、不碰 electron）：可单测；写盘由 `loadSettings` 拿它的返回值
 * 调 `saveSettings` 完成 —— 写盘失败不阻断启动（内存里标记已是 true，
 * 后续任何一次 saveSettings 都会把它带上）。
 */
export function planCloseBehaviorMigration(s: Settings): Settings | null {
  if (s.closeBehaviorMigrated === true) return null
  return { ...s, closeBehavior: 'ask', closeBehaviorMigrated: true }
}

export async function loadSettings(): Promise<Settings> {
  // 品牌更名迁移（modvault → idbox）：先把旧 userData 目录的设置复制过来再读，
  // 否则老用户升级后读不到库路径，资产会全部从 UI 消失（2026-10 装机反馈 P0）。
  await migrateLegacySettingsFile(app.getPath('userData')).catch(() => {})

  const main = await readSettingsFile(settingsFilePath())
  if (main) return await applyCloseBehaviorMigration(main)

  // 主档缺失或损坏（典型：进程在 writeFile 中途被杀 → 截断 JSON）→ 先试一代备份。
  // ⚠️ 这一条是"库看起来空了"的最后防线：回落默认值会把 libraryDir 一起丢掉。
  const backup = await readSettingsFile(settingsBackupPath())
  if (backup) {
    console.error('[idbox] settings.json 不可用，已从 settings.json.bak 恢复')
    return await applyCloseBehaviorMigration(backup)
  }

  // 全新安装（两键皆无）：走同一条迁移 —— 落 `'ask'` + 标记 `true` 并写盘。
  // 新装档里没有残留值可迁移，但翻牌是为了让"标记已落盘"这条不变量对三种档形态
  // （旧档 / 残留档 / 新装）都成立：否则新装用户第一次在弹窗勾「记住：彻底退出」
  // 落盘的档里标记还是 false，下次启动又被强制回 'ask'（等于他选的档被吃掉）。
  return applyCloseBehaviorMigration({
    ...DEFAULT_SETTINGS,
    libraryDir: await resolveDefaultLibraryDir()
  })
}

/**
 * 应用 {@link planCloseBehaviorMigration} 的决策：需要迁移就**立刻写回**（让标记
 * 粘住），失败只告警不阻断启动。三条读档路径（主档 / 备份 / 全新默认）共用。
 */
async function applyCloseBehaviorMigration(s: Settings): Promise<Settings> {
  const planned = planCloseBehaviorMigration(s)
  if (!planned) return s
  try {
    await saveSettings(planned)
  } catch (err) {
    // 标记没粘住的下一次启动会再迁移一次（幂等、结果都是 'ask'），不是致命问题
    console.warn('[idbox] closeBehavior 迁移标记写盘失败（下次保存会自动带上）', err)
  }
  return planned
}

/**
 * 保存设置（**原子写 + 串行化**）：
 *
 * ① 先写 `settings.json.tmp`（完整内容落盘，主档此刻仍完好）；
 * ② 把**当前有效的** `settings.json` 复制成 `settings.json.bak`（一代，不链式）；
 * ③ `rename(tmp → settings.json)`：同目录同卷，Windows 上允许覆盖，原子生效。
 *
 * 这样任何时刻被杀进程，磁盘上要么是旧档、要么是新档，**不会出现半截 JSON**。
 * 旧实现直接 `writeFile(主档)`：关机/任务管理器结束进程会留下截断文件 →
 * `loadSettings` 解析失败回落默认值 → `libraryDir` 丢失 → 用户看到"库空了"。
 *
 * ⚠️ ①~③ 整体在 `enqueueSettingsWrite` 里串行执行：tmp 名固定，并发会互相覆盖
 * 甚至 rename 到已消失的 tmp 抛 ENOENT（见上面写队列的大段注释）。串行后
 * 「写盘顺序 = saveSettings 调用顺序」，最后一次调用即最终落盘内容。
 */
export async function saveSettings(s: Settings): Promise<void> {
  // 归一化 / 序列化放在**入队之前**：这是调用瞬间的内容快照，
  // 排队期间调用方再改传入对象也不会污染这一次要写的内容（也缩短了占队时间）。
  const payload = JSON.stringify(normalizeSettings(s), null, 2)

  return enqueueSettingsWrite(async () => {
    await mkdir(app.getPath('userData'), { recursive: true })
    const target = settingsFilePath()
    const tmp = settingsTmpPath()

    await writeFile(tmp, payload, 'utf-8')

    // 首次运行主档还不存在 → copyFile 抛 ENOENT，属正常情况（没有"上一份好档"）
    await copyFile(target, settingsBackupPath()).catch(() => undefined)

    await rename(tmp, target)
  })
}
