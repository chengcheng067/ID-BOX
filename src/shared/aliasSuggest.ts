/**
 * 别名自动建议 —— docs/20 §5.3 · T-D1（只建议，**绝不自动写库**）。
 *
 * 定位：用户拖进来一堆 Crystal / AmbientCG 的英文材质包，界面上要能看懂。
 * 本模块把资产名丢给 `autoClassify` 的词表匹配，命中就把**词表里的中文词条**
 * 作为候选显示名返回；命中不了就返回 `null` —— **宁可不建议，也不瞎猜**。
 *
 * 三条纪律（与 docs/20 §10 不做清单一致）：
 * 1. **不自创词条**：返回值只可能来自 `taxonomy.ts`（含 `LEVEL3_ALIAS` 归并表），
 *    不做音译、不做机翻、不做同义词扩展。词表唯一权威，加词要走 06 §12.2 流程。
 * 2. **只建议不落库**：本函数是纯函数，返回字符串就结束；写不写由 D3 的 UI 决定。
 *    材料名是用户资产，写错比不写更糟。
 * 3. **零 IO**：不读 Dexie、不读设置、不碰 electron。
 */

import { autoClassify } from './autoClassify'
import { aliasKeyOf } from './aliasRules'
import { UNCLASSIFIED } from './taxonomy'

/**
 * 从资产名推断一个中文显示名候选。
 *
 * 数据来源：`autoClassify(rawName)` 的 `matchedTerm` —— 它是**实际命中的词表词条**，
 * 比 `category2` 更具体：
 * - 二级原文命中 → 就是二级词条本身（`玄关柜` → `柜子`）；
 * - 三级归并命中（`LEVEL3_ALIAS`）→ 是那个**三级词**（`隔断屏风` → `屏风`），
 *   比它归并到的二级更贴近用户看到的品类名。
 *
 * 含 `/` 的并列词条取**第一个子词**（`椅子/凳子` → `椅子`）：目录名保留完整词条是
 * 落盘纪律，但显示名带斜杠不像人话。
 *
 * @param rawName 资产名（导入时的文件夹名 / 压缩包名，可含 `ID_<数字>` 尾巴）
 * @returns 中文候选名；无命中、无有效词条、或候选与原名完全相同 → `null`
 */
export function suggestAlias(rawName: string): string | null {
  if (typeof rawName !== 'string') return null
  const name = rawName.trim()
  if (!name) return null

  const hit = autoClassify(name)
  if (hit === null) return null

  // `椅子/凳子` → `椅子`；三级归并时 matchedTerm 是三级词，直接用
  const first = (hit.matchedTerm ?? '').split('/')[0]
  const term = typeof first === 'string' ? first.trim() : ''
  if (!term || term === UNCLASSIFIED) return null

  // 候选与原名一字不差 → 建议没有信息量，返回 null（避免 UI 显示"建议：沙发 → 沙发"）
  if (term === name) return null

  // 【降级守卫，2026-10 主理人裁定】**名字里已经含这个中文词 → 不建议**。
  //
  // 例：`无堺黑色木纹ID_1151853396` 命中一级「木纹」，但用户自己看得懂
  // 「无堺黑色木纹」——建议成「木纹」是把他的名字**改短**，不是帮忙，是损毁。
  // 建议的价值只在"用户看不懂原名"时才成立，故必须要求候选**带来新信息**。
  //
  // 反例不受影响：`现代简约玄关柜` 的命中词是「柜子」，名字里没有「柜子」二字
  // （只有「柜」），仍会建议「柜子」。
  //
  // ⚠️ 位置纪律：放在"命中之后、返回之前"。不要塞进 `autoClassify` 的命中判断里 ——
  // 那是分类统计口径（`matchedTerm` 命中率），与"要不要建议"是两件事。
  const termKey = aliasKeyOf(term)
  if (termKey && aliasKeyOf(name).includes(termKey)) return null

  return term
}
