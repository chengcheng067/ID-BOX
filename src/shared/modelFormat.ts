/**
 * 模型格式（2026-10 用户需求「支持 3DMAX（.max）格式」的**格式区分纯函数**）。
 *
 * 设计取舍（为什么是纯函数而不是 `Asset.modelFormat` 落库字段）：
 * - 格式**完全由资产文件列表的扩展名推导**（`AssetFile.ext` 已在导入/重扫时小写化落库），
 *   纯函数派生意味着旧索引记录**零迁移、零回填**就立即生效；
 * - 落库字段则要动 Dexie schema / 导入器 / rescan 三处，且手工导入目录变更（rescan）
 *   后字段还可能漂移 —— 派生值不可能漂移；
 * - `.max` 与 `.skp` 的判存量级（全量内存过滤）没有性能问题。
 *
 * 优先级与 `shared/classify.ts` 的 `PRIMARY_MODEL_EXTS`（skp > max）一致：
 * 一个包里同时有 `.skp` 与 `.max` 时按 SketchUp 资产对待（封面、版本解析、徽标都跟 skp）。
 *
 * ── 2026-11-09 用户回签：`.d5a` 是**模型的一种格式**，不是独立大类 ──────────────
 *
 * 用户原话：「你侧栏里面的分类没有 D5a，D5a 本身属于模型格式，但在模型的格式里面又
 * 找不到 D5a 的选择，然后你却在首页给我做了一个 d5a 的单独文件夹」。
 *
 * 之前三处三种说法（侧栏没有 / 格式筛选选不到 / 首页却有独立卡）的根源是：
 * `kind='d5a'` 是**独立大类**，而格式维度只认 skp/max。现在把格式维度补成三元组，
 * 并用 `isModelKind()` 把「模型域 = model + d5a」收敛成**一个判定**：
 *   · `kindsOfFilter('model')` → `{model, d5a}`（模型视图 = 模型的全部格式）；
 *   · `matchesFilters` 的格式条件按 `isModelKind` 生效（而不是裸 `kind === 'model'`）；
 *   · 侧栏「所有模型」的计数与一级分类树也走同一入口。
 *
 * ⚠️ **不迁库**：`kind` 与落盘目录（`D5A/未分类/未分类/<名>/`）都不动 ——
 * 已入库的 d5a 资产不能搬家；"属于模型格式"是**筛选与呈现口径**，不是存储口径。
 */

import type { AssetKind } from './types'

/**
 * 模型格式：`skp` = SketchUp；`max` = 3ds Max；`d5a` = D5 Render 资产包
 * （整包存档，`.d5a` 内容是 ZIP，但用户拍板「不解包」，见 `shared/classify.ts` 的 `EXT_KIND`）。
 */
export type ModelFormat = 'skp' | 'max' | 'd5a'

/**
 * 「模型域」的 kind 成员 —— **唯一判定源**。
 *
 * `d5a` 在存储上是独立 kind（独立落盘目录 `D5A/`），在**筛选与导航**上属于模型：
 * 用户口径「D5A 本身属于模型格式」。所有"这是不是模型"的判断都必须走
 * `isModelKind()` / 本数组，**不要**在组件或逻辑里再写一遍 `kind === 'model'`。
 */
export const MODEL_KIND_MEMBERS: readonly AssetKind[] = ['model', 'd5a']

/** 这个 kind 属于「模型域」吗（= 格式维度对它有意义）。**只查上面那张表**，不另立名单 */
export function isModelKind(kind: AssetKind): boolean {
  return MODEL_KIND_MEMBERS.includes(kind)
}

/** 兜底输入形状：只需要扩展名（`AssetFile` 的极小投影，测试与调用方都好造） */
export interface ModelFileLike {
  ext: string
}

/**
 * 从资产文件列表推导模型格式；不是模型 / 没有可识别格式 → `null`。
 *
 * 优先级 **skp > max > d5a**（用户 2026-11-09 回签时确认沿用"立即返回 skp"的写法）：
 * - 任一 `.skp` → `'skp'`（**立即返回**，优先级最高，见模块注释）；
 * - 否则有 `.max` → `'max'`；
 * - 否则有 `.d5a` → `'d5a'`（`d5a` 资产里恰有 1 个文件，就是那个 `.d5a` 自己，
 *   所以实际是"没有 skp/max 时的兜底"，与压缩包路径的语义一致）；
 * - 扩展名大小写不敏感（历史数据可能没规范化）。
 *
 * 纯函数、零 IO；单测见 `tests/modelFormat.test.ts`。
 */
export function getModelFormat(files: ReadonlyArray<ModelFileLike> | undefined | null): ModelFormat | null {
  if (!Array.isArray(files)) return null
  let rest: ModelFormat | null = null
  for (const f of files) {
    const ext = (f?.ext ?? '').toLowerCase()
    if (ext === 'skp') return 'skp'
    // `max` 先于 `d5a` 占位（两个都只是"候补"，最终按 max > d5a 的顺序定）
    if (ext === 'max' && rest !== 'max') rest = 'max'
    if (ext === 'd5a' && rest === null) rest = 'd5a'
  }
  return rest
}

/**
 * 格式 → 卡片徽标文案。
 *
 * 2026-10-29 用户改口：原文案是旧的三字母缩写（大写的 3D + S），现在要**小写 `max`**
 * （原话「3D Max 的字样换成 max」）。徽标文案同时被筛选摘要复用
 * （`logic/filters.ts:686`），所以摘要也跟着显示 `max` —— 这是用户要的口径。
 * ⚠️ `MODEL_FORMAT_OPTIONS` 里的 `'3DMAX'` 是筛选下拉的中文口径，**不跟着改**。
 */
export const MODEL_FORMAT_BADGE_LABEL: Record<ModelFormat, string> = {
  skp: 'SU',
  max: 'max',
  /**
   * D5A：展示名与落盘大类名**恰好同名**（都是 `D5A`），但仍然分两张表
   * （落盘永远走 `kindFolder()`，别因为"两个值一样"就图省事）。
   * 为什么徽标用大写：`D5A` 是品牌缩写（与 SU / CAD 同类），用户实拍图也是大写。
   */
  d5a: 'D5A'
}

/** 筛选器「模型格式」维度的选项表（含「全部」档；中栏头浮层与测试共用） */
export const MODEL_FORMAT_OPTIONS: ReadonlyArray<{ label: string; value: ModelFormat | null }> = [
  { label: '全部', value: null },
  { label: 'SU', value: 'skp' },
  { label: '3DMAX', value: 'max' },
  // 2026-11-09 用户：D5A 属于模型格式 ⇒ 格式筛选里必须有这一档（放在 3DMAX 之后）
  { label: 'D5A', value: 'd5a' }
]

/** 格式 → 中文显示名（空态维度摘要 / 详情面板复用，避免各处手写） */
export const MODEL_FORMAT_NAME: Record<ModelFormat, string> = {
  skp: 'SketchUp',
  max: '3DMAX',
  d5a: 'D5A'
}
