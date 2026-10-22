/**
 * 「知末 ID 尾巴」剥离的**共享样例**（唯一来源）。
 *
 * 背景：同一类尾巴在两处被处理，但**语义不同、实现故意不共用**（docs/20 §5 + 裁定）：
 * - `src/shared/autoClassify.ts` 的规则 B-2（`stripCjkTrailingId`）：输入已被分词器
 *   按 `_` 切开，只需切掉紧贴 CJK 的 `ID` 两个字母；
 * - `src/shared/aliasRules.ts` 的 `aliasKeyOf`：词典 key 必须把 `ID_<数字>` **整段**
 *   切掉（站点 id 变了不能变成两个 key），且要支持 `Brick_Rough_ID_42` 这种分隔符写法。
 *
 * 强行合并成一个函数会让其中一边失真（匹配规则的 62% 漏分率是调出来的，不能为了
 * 「少一份代码」去动它）。故：**统一判据，不统一实现** ——
 *
 * ⚠️ 改样例必须让两处同时绿：
 * - `tests/aliasRules.test.ts`（`aliasKeyOf` 侧）
 * - `tests/autoClassify.test.ts`（`autoClassify` 侧镜像断言）
 *
 * 任何一边的剥离条件被改坏，另一边的镜像断言立刻红。
 */

/**
 * **必须被剥掉**的 ID 尾巴样例：不剥就会让同一资产因站点 id 不同而分成两个 key /
 * 匹配不到词条。
 */
export const MUST_STRIP: readonly string[] = [
  // CJK 紧贴 ID（`_` 是分隔符，但资产名本身连写）
  '无堺黑色木纹ID_1151853396',
  // 分隔符 + ID 写法
  'Brick_Rough_ID_42',
  // 真实样本：标题 + 下划线 + 品类词 + ID
  '传薇佳画_挂画组合ID_1186414883'
]

/**
 * **必须原样保留**的样例：英文单词恰好以 `id` 结尾，剥掉会变成 `gr` / `rap` / `inval`
 * 这类残词（`grid123` → `gr`），把整词匹配搞坏。这是两处共同的防误伤红线。
 */
export const MUST_KEEP: readonly string[] = ['grid123', 'rapid42', 'invalid7', 'Material.v2']

/** 本来就是干净的中文名：不需要任何剥离，`aliasKeyOf` 应原样返回。 */
export const ALREADY_CLEAN: readonly string[] = ['现代简约玄关柜', '石材']
