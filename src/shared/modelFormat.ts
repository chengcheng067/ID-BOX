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
 */

/** 模型格式：`skp` = SketchUp；`max` = 3ds Max（其余模型格式本批不区分） */
export type ModelFormat = 'skp' | 'max'

/** 兜底输入形状：只需要扩展名（`AssetFile` 的极小投影，测试与调用方都好造） */
export interface ModelFileLike {
  ext: string
}

/**
 * 从资产文件列表推导模型格式；不是模型 / 没有可识别格式 → `null`。
 *
 * - 任一 `.skp` → `'skp'`（**立即返回**，优先级高于 max，见模块注释）；
 * - 否则有 `.max` → `'max'`；
 * - 扩展名大小写不敏感（历史数据可能没规范化）。
 *
 * 纯函数、零 IO；单测见 `tests/modelFormat.test.ts`。
 */
export function getModelFormat(files: ReadonlyArray<ModelFileLike> | undefined | null): ModelFormat | null {
  if (!Array.isArray(files)) return null
  let max: ModelFormat | null = null
  for (const f of files) {
    const ext = (f?.ext ?? '').toLowerCase()
    if (ext === 'skp') return 'skp'
    if (ext === 'max' && max === null) max = 'max'
  }
  return max
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
  max: 'max'
}

/** 筛选器「模型格式」维度的选项表（含「全部」档；中栏头浮层与测试共用） */
export const MODEL_FORMAT_OPTIONS: ReadonlyArray<{ label: string; value: ModelFormat | null }> = [
  { label: '全部', value: null },
  { label: 'SU', value: 'skp' },
  { label: '3DMAX', value: 'max' }
]

/** 格式 → 中文显示名（空态维度摘要 / 详情面板复用，避免各处手写） */
export const MODEL_FORMAT_NAME: Record<ModelFormat, string> = {
  skp: 'SketchUp',
  max: '3DMAX'
}
