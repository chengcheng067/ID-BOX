/**
 * 知末「风格」→ 本地受控风格的**唯一判定**（TODO-3，docs/25）。
 *
 * 纯函数、零依赖（不碰 window / db / store），所以能被 node 单测直接 import。
 *
 * ── 为什么要这么保守（三条 AND，任何一条不满足都不写）──────────────────
 * ① **只认受控词表**：站方给的是自由词（`现代` / `侘寂` / `赛博朋克` / `--` …），
 *    而 `asset.styles` 是**受控多选维度**（参与筛选、落索引）。把自由词塞进去
 *    会让筛选器出现词表之外的值 → 用户点「现代」却筛不到自己刚抓的那条。
 *    未命中就不写，只记一条 debug 日志（可观测但不打扰用户）。
 * ② **只补空**：`asset.styles` 已有值 = 用户（或上一轮导入）已经表过态。
 *    自动任务不能追加也不能覆盖 —— 风格是"用户的判断"，不是"站方的判断"。
 * ③ **只对 model**：材质频道的 `styles` 与模型是两册词表（`简欧` vs `简洁`），
 *    而且材质资产本来就不会进封面抓取队列。双保险，避免语义串册。
 *
 * ⚠️ 本模块**不写库**：store 拿到 `{ write: true, style }` 后走 `db.assets.put`，
 * 这样"判定"与"持久化"的边界清晰、判定可被表驱动全覆盖。
 */

import { STYLE_LIST_BY_KIND } from '../../shared/taxonomy'
import type { Asset } from '../../shared/types'

/** 不写库的原因（`not-in-list` 是唯一需要记日志的一种） */
export type ZhimoStyleSkipReason =
  /** 非模型大类（材质/贴图/HDR…）—— 风格词表不同册，语义不通用 */
  | 'not-model'
  /** 资产已有风格 —— 用户判断优先，不追加、不覆盖 */
  | 'kept-existing'
  /** 站方没给风格（缺字段 / 空串 / 占位 `--`） */
  | 'empty'
  /** 站方给了，但不在本地受控词表里（如 `赛博朋克`） */
  | 'not-in-list'

/** 判定结果：可写（带最终落库值）或不可写（带原因） */
export type ZhimoStyleDecision =
  | { write: true; style: string }
  | { write: false; reason: ZhimoStyleSkipReason }

/**
 * 判定"这次抓来的站方风格能不能写进这个资产"。
 *
 * @param asset        只需 `kind` 与 `styles`（便于单测直接传最小对象）
 * @param stationStyle 站方原始词（`FetchZhimoCoverResult.style`；可能是 null/undefined/脏值）
 *
 * 判定顺序固定：`not-model` → `kept-existing` → `empty` → `not-in-list`。
 * 顺序影响"原因"的取值，但不影响"写不写"：前三条任一命中都直接不写。
 */
export function resolveZhimoStyle(
  asset: Pick<Asset, 'kind' | 'styles'>,
  stationStyle: unknown
): ZhimoStyleDecision {
  // ③ 只对 model：材质频道是另一册词表，且不进封面队列
  if (asset.kind !== 'model') return { write: false, reason: 'not-model' }

  // ② 只补空：已有风格 = 用户已表态（`undefined` / `[]` 都算空）
  const existing = Array.isArray(asset.styles)
    ? asset.styles.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : []
  if (existing.length > 0) return { write: false, reason: 'kept-existing' }

  // ① 空值 / 占位符：站方没给
  const raw = typeof stationStyle === 'string' ? stationStyle.trim() : ''
  if (!raw || raw === '--' || raw === '-') return { write: false, reason: 'empty' }

  // ① 白名单（**精确匹配**，不做同义词/模糊归并：归并属于词表侧的工作，不在这里做）
  if (!STYLE_LIST_BY_KIND.model.includes(raw)) return { write: false, reason: 'not-in-list' }

  return { write: true, style: raw }
}
