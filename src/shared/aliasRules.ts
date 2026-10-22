/**
 * 别名（显示名）纯函数 —— docs/20 §5 · T-D1。
 *
 * 需求：用户在 Crystal / AmbientCG 下载的材质包多为英文名，界面要显示中文，
 * 但**磁盘文件名一个字母都不能改**。故别名是**显示层的投影**：
 *
 * | 维度 | 是否受别名影响 |
 * | --- | --- |
 * | 落盘 `name` / `relFolder` / `folder` | 否（本模块只读不写） |
 * | `dedupeKey` | 否（去重仍按真实名，否则同一包两份会被别名伪装成不同资产） |
 * | 显示 / 搜索 / 按名称排序 | **是** |
 *
 * 结构（docs/20 §5.1 裁定）：**独立词典表（按归一化 key） + 单资产覆盖**。
 * 只加 `Asset.alias` 会让同名 50 份资产改 50 次（Crystal 包正是同名重灾区）；
 * 只加独立表又没有例外位。故两者并存，优先级见 `resolveDisplayName`。
 *
 * **零 IO、零 electron / node 依赖**：`index` 一律由调用方传入，
 * 本模块不读 Dexie、不读全局状态、不写任何东西 —— 可直接单测。
 */

/** 一条别名词典记录（与 Dexie `aliases` 表同形，见 docs/20 §5.1） */
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

/** 由 `buildAliasIndex` 产出的只读索引；调用方持有，函数不缓存 */
export interface AliasIndex {
  byKey: Map<string, string>
  byAssetId: Map<string, string>
}

/**
 * 已知的文件/资产扩展名（**有界白名单**，不是万能 `\.[a-z0-9]+$`）。
 *
 * 为什么要剥：用户可能拿文件名（而不是文件夹名）喂进来，`石材.skp` 与 `石材`
 * 必须归一到同一个 key，否则词典命中率凭空下降。
 * 为什么不用万能正则：`Material.v2`、`V-Ray 3.6` 这类名字的 `.v2` / `.6`
 * 不是扩展名，剥掉会把不同资产并成一个 key。
 */
const EXT_RE = /\.(?:skp|max|fbx|obj|blend|mtl|jpg|jpeg|png|webp|tif|tiff|exr|hdr|psd|zip|rar|7z)$/i

/**
 * 知末式尾巴 `ID_<数字>` —— 两种写法，必须分开处理，**不能**写成一个
 * `/[_\-\s]*id[_\-\s]*\d+$/i`：
 *
 * 1. `CJK 紧贴 ID`：`无堺黑色木纹ID_1151853396`（`_` 在分词器里是分隔符，
 *    但资产名本身是连写的）。用 `$1` 回填那个 CJK 字符。
 * 2. `分隔符 + ID`：`Brick_Rough_ID_1151853396` / `stone wall id 42`。
 *
 * ⚠️ 刻意**不匹配** `grid123` / `rapid42` / `invalid7`：前者要求 `id` 前是 CJK，
 * 后者要求 `id` 前有分隔符。这一条与 `autoClassify.ts` 的规则 B-2
 * （`stripCjkTrailingId`，见该文件 171-206 行）**触发条件同源**：都是
 * "CJK 前置 + 必须剩 ≥2 字符"，但目标不同 —— 那边的输入已被分词器切掉了 `_`，
 * 只需切掉 `ID` 两个字母；这里要连同 `_<数字>` 整段切掉（词典 key 不能残留站点 id，
 * 否则同一资产的 id 变了就匹配不上）。故两处不能合并成一个函数，但
 * `tests/aliasRules.test.ts` 用同一批样例（`grid123` 不剥）把两条规则钉在一起，
 * 防止将来只改一边。
 */
const ID_TAIL_AFTER_CJK_RE = /([\u4e00-\u9fff])id[_\-\s]*\d+$/i
const ID_TAIL_AFTER_SEP_RE = /[_\-\s]+id[_\-\s]*\d+$/i

/** 下载站重复下载产生的数字括号尾巴：`石材(1)` → `石材`（content 一起丢掉，不是只丢括号字符） */
const NUMERIC_BRACKET_TAIL_RE = /[（(]\s*\d+\s*[）)]$/

/** 分辨率尾巴：`Marble_4K` / `石材 2K` —— docs/20 §5.1 明确要求归一 */
const RESOLUTION_TAIL_RE = /[_\-\s]*(?:1k|2k|4k|8k)$/i

/**
 * 归一化时要抹掉的分隔符与括号字符（只抹**字符本身**，不抹括号里的内容：
 * `Concrete (Polished)` 与 `Concrete (Rough)` 必须是两个 key）。
 */
const SEPARATOR_RE = /[\s_\-–—()（）[\]【】{}·]+/g

/**
 * 资产名 → 别名词典 key。
 *
 * 规则（docs/20 §5.1 + 本次任务口径）：小写、去扩展名、去 `ID_<数字>` 尾巴、
 * 去分辨率尾巴、去空格/下划线/连字符/括号。
 *
 * **幂等**：`aliasKeyOf(aliasKeyOf(x)) === aliasKeyOf(x)`（单测钉住），
 * 所以索引构建时可以对调用方传进来的 key 再做一次归一化而不改变语义。
 *
 * @param rawName 资产名（可为空串；非法输入返回空串，绝不抛）
 */
export function aliasKeyOf(rawName: string): string {
  if (typeof rawName !== 'string') return ''
  let s = rawName.trim()
  if (!s) return ''
  s = s.replace(EXT_RE, '')
  s = s.replace(ID_TAIL_AFTER_CJK_RE, '$1')
  s = s.replace(ID_TAIL_AFTER_SEP_RE, '')
  s = s.replace(NUMERIC_BRACKET_TAIL_RE, '')
  s = s.replace(RESOLUTION_TAIL_RE, '')
  s = s.replace(SEPARATOR_RE, '')
  return s.toLowerCase()
}

/** 内部：同键多条时"新的赢"，`>=` 保证数组顺序也是确定性的（后者胜出） */
function putNewest(
  map: Map<string, { name: string; createdAt: number }>,
  key: string,
  name: string,
  createdAt: number
): void {
  const prev = map.get(key)
  if (prev === undefined || createdAt >= prev.createdAt) {
    map.set(key, { name, createdAt })
  }
}

/**
 * 构建别名索引（纯函数，不缓存、不读全局）。
 *
 * 丢弃规则（都是"宁可不生效，也不显示错名字"）：
 * - `name` 为空/全空白 → 丢弃（空别名不许把原名盖成空白）；
 * - `key` 为空/全空白 → 丢弃；
 * - `scope` 不是 `'asset'` 的一律按 `'key'` 处理（脏数据兜底，不抛）。
 *
 * 同键多条：**`createdAt` 最大的胜出**（相等时数组中靠后的胜出），
 * 保证同一份数据无论怎么重排都得到同一个索引。
 */
export function buildAliasIndex(records: AliasRecord[]): AliasIndex {
  const keyMap = new Map<string, { name: string; createdAt: number }>()
  const assetMap = new Map<string, { name: string; createdAt: number }>()
  for (const r of records ?? []) {
    if (r === null || typeof r !== 'object') continue
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    const rawKey = typeof r.key === 'string' ? r.key.trim() : ''
    if (!rawKey) continue
    const createdAt = Number.isFinite(r.createdAt) ? r.createdAt : 0
    if (r.scope === 'asset') {
      putNewest(assetMap, rawKey, name, createdAt)
    } else {
      const key = aliasKeyOf(rawKey)
      if (!key) continue
      putNewest(keyMap, key, name, createdAt)
    }
  }
  const byKey = new Map<string, string>()
  for (const [k, v] of keyMap) byKey.set(k, v.name)
  const byAssetId = new Map<string, string>()
  for (const [k, v] of assetMap) byAssetId.set(k, v.name)
  return { byKey, byAssetId }
}

/** 资产的最小结构（**不依赖 `Asset` 完整类型**，避免与 types.ts 的改动互相耦合） */
export interface AliasTarget {
  id: string
  name: string
  /** 单资产例外（详情面板写的就是它）；空串/全空白视为未设置 */
  aliasOverride?: string
}

/** 取字符串的"有效值"：非字符串或全空白 → undefined */
function meaningful(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/**
 * 解析显示名。**四级优先级，逐级回落**：
 *
 * 1. `asset.aliasOverride`（单资产例外，最具体）
 * 2. `index.byAssetId[asset.id]`（`scope:'asset'` 的记录）
 * 3. `index.byKey[aliasKeyOf(asset.name)]`（`scope:'key'` 的词典记录，一改影响 N 个同名资产）
 * 4. `asset.name`（原名，永远兜底）
 *
 * 每一级都做**空值守卫**：空串/全空白不当成有效别名，继续往下回落 ——
 * 否则一条误存的空别名会让界面上出现空白标题。
 */
export function resolveDisplayName(asset: AliasTarget, index: AliasIndex): string {
  const own = meaningful(asset.aliasOverride)
  if (own !== undefined) return own
  const byAsset = meaningful(index.byAssetId.get(asset.id))
  if (byAsset !== undefined) return byAsset
  const byKey = meaningful(index.byKey.get(aliasKeyOf(asset.name)))
  if (byKey !== undefined) return byKey
  return asset.name
}

/**
 * 搜索命中判定：**原名与显示名都能命中**（docs/20 §5.2「中英文都能命中」）。
 *
 * 归一化口径：query 也走 `aliasKeyOf`（`Stone Wall` / `stone-wall` / `StoneWall`
 * 搜同一批资产）；同时保留一次**原始小写子串**匹配，兜住"带空格但词序不同"的
 * 输入（`wall stone` 这种 `aliasKeyOf` 归一后仍不等于 key 的情形）。
 *
 * @param query 空串/全空白 **返回 `true`**（= 不筛，与 `filters.ts` 的
 *              "空 query 不参与过滤"语义一致；调用方若自己判空也可）
 */
export function matchesQuery(asset: AliasTarget, query: string, index: AliasIndex): boolean {
  const qRaw = typeof query === 'string' ? query.trim() : ''
  if (!qRaw) return true
  const qLower = qRaw.toLowerCase()
  const qKey = aliasKeyOf(qRaw)
  const display = resolveDisplayName(asset, index)
  const nameLower = (asset.name ?? '').toLowerCase()
  const displayLower = display.toLowerCase()

  // 1) 原始小写子串：保住 "以词序/空格原样搜" 的直觉行为
  if (nameLower.includes(qLower) || displayLower.includes(qLower)) return true
  // 2) 归一化 key 子串：`Stone Wall` 能命中 `stonewall_01`，中文不受影响
  if (!qKey) return false
  return aliasKeyOf(asset.name).includes(qKey) || aliasKeyOf(display).includes(qKey)
}

/**
 * 按**显示名**排序（中文用户按拼音找位置，用原名排会乱）。
 *
 * `localeCompare('zh-Hans-CN', { numeric: true })`：
 * - 中文按拼音序（`沙发` < `书柜` < `桌椅`）；
 * - `numeric` 让 `石材 2` 排在 `石材 10` **前面**（默认字典序会反过来）。
 *
 * 纯函数、无全局状态，可直接传给 `Array.prototype.sort`。
 */
export function compareByDisplayName(a: string, b: string): number {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true })
}
