/**
 * 别名（显示名）在渲染层的接线 —— 0.6.0「别名映射表」· docs/22 §3.3。
 *
 * 定位：`shared/aliasRules.ts` 是**纯规则**（怎么归一化、怎么定优先级），
 * `shared/aliasSuggest.ts` 是**纯建议**（词表命中什么就建议什么）。本模块负责
 * ① 把 `Settings.aliases` 变成可复用的索引（**按数组引用 memo**，settings 变了才重建）；
 * ② 把索引接到「给用户看的名字」上（`resolveAssetDisplayName`）；
 * ③ 设置页要用的三件纯事：合并（上限 / 同键覆盖）、导入解析、导出序列化、建议生成。
 *
 * 三条纪律（与 docs/22 §3.3 一致）：
 * 1. **只影响显示**：本模块不写磁盘、不改 `Asset.name`、不碰 `dedupeKey`。
 * 2. **零 React / 零 store 依赖**：本模块只 import `shared/**`，可直接在 node 下单测
 *    （渲染层组件自己决定何时调用 `aliasIndexOf`）。
 * 3. **别名优先于 `displayName()`**：`别名(asset/key) > displayName(name)`，
 *    用户显式写下的名字永远压过"剥知末 ID"这类字符串规整。
 */

import {
  aliasKeyOf,
  buildAliasIndex,
  resolveDisplayName,
  type AliasIndex,
  type AliasRecord,
  type AliasTarget
} from '../../shared/aliasRules'
import { suggestAlias } from '../../shared/aliasSuggest'
import { displayName } from '../../shared/naming'

/**
 * 稳定的空数组常量。
 *
 * 为什么需要它：`useVault((s) => s.settings?.aliases ?? [])` 里的 `?? []` **每次求值都新建
 * 一个数组字面量**，引用永远不同 → 索引的 memo 永远失效（等于每帧重建一遍 Map）。
 * 调用方统一写成 `useVault((s) => s.settings?.aliases) ?? EMPTY_ALIASES`。
 *
 * ⚠️ 只读：任何调用方都不得 push / splice 它（需要改就造新数组，走 `mergeAliasRecords`）。
 */
export const EMPTY_ALIASES: AliasRecord[] = []

/** 别名表上限（与设置页的「超出禁用新增」提示同一常量，避免两处写死不同数字） */
export const MAX_ALIASES = 500

/**
 * 索引 + 它对应的**原始数组引用**。
 *
 * 保存引用是 memo 的全部秘密：`records === prev.records` ⇔ 这份索引仍然有效。
 * 不用深比较（500 条的深比较比重建一次 Map 还贵），也不看内容（settings 每次落库
 * 都会返回全新对象，内容相同也该重建 —— 重建成本可忽略，误复用才是 bug）。
 */
export interface AliasIndexMemo {
  records: AliasRecord[]
  index: AliasIndex
}

/**
 * 带 memo 的索引构建（纯函数，可直接单测）。
 *
 * @param records 本次的别名表（通常来自 `settings.aliases`）
 * @param prev    上一次的 memo 结果；传 `null` 表示没有缓存
 * @returns 引用相等时**原样返回 prev**（同一个对象），否则重建
 */
export function buildAliasIndexCached(
  records: AliasRecord[],
  prev: AliasIndexMemo | null
): AliasIndexMemo {
  if (prev !== null && prev.records === records) return prev
  return { records, index: buildAliasIndex(records) }
}

/** 模块级共享 memo：全应用只保留"最后一份"索引（网格 / 详情面板共用同一个 Map） */
let sharedMemo: AliasIndexMemo | null = null

/**
 * 取当前别名表的索引（模块级 memo）。
 *
 * 语义等价于 `useMemo(() => buildAliasIndex(records), [records])`，但：
 * - 不依赖 React，纯函数调用；
 * - 多个组件同时用同一份 `settings.aliases` → 只建一次 Map（不是每个组件各建一份）。
 */
export function aliasIndexOf(records: AliasRecord[]): AliasIndex {
  sharedMemo = buildAliasIndexCached(records, sharedMemo)
  return sharedMemo.index
}

/** 仅供单测：清掉模块级 memo（避免用例之间的缓存串味） */
export function resetAliasIndexCache(): void {
  sharedMemo = null
}

/**
 * 资产 → 界面显示名。**优先级：别名 > `displayName()`（剥知末 ID）> 原名**。
 *
 * 判定手法：`resolveDisplayName` 在四级优先级全落空时**原样返回 `asset.name`**，
 * 所以"返回值 ≠ 原名"就等于"命中了一条别名"（词典 / 单资产 / `aliasOverride` 任一）。
 * - 命中别名 → **原样用用户写的名字**（不再剥 ID：可能是用户故意保留的编号）；
 * - 没命中 → 走 0.5.x 的 `displayName()` 兜底，行为与升级前完全一致。
 *
 * 边界：别名文本与原名一字不差时按"未命中"处理（结果一致，且仍能享受剥 ID）。
 */
export function resolveAssetDisplayName(asset: AliasTarget, index: AliasIndex): string {
  const resolved = resolveDisplayName(asset, index)
  if (resolved !== asset.name) return resolved
  return displayName(asset.name)
}

// ── 设置页用的纯逻辑（合并 / 导入 / 导出 / 建议）────────────────────────

/** 记录主键：优先 `crypto.randomUUID()`，缺失时退化为时间戳 + 随机串（本地唯一即可） */
export function newAliasId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return `al-${c.randomUUID()}`
  return `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `mergeAliasRecords` 的结果：records 是新数组，三个计数用于给用户一句人话 */
export interface AliasMergeResult {
  records: AliasRecord[]
  /** 新增条数 */
  added: number
  /** 覆盖同名 key 的条数 */
  replaced: number
  /** 因非法（空 key / 空 name）或超上限被丢弃的条数 */
  dropped: number
}

/**
 * 把一批 `key` 级记录并入现有别名表。
 *
 * 规则（顺序不能换）：
 * 1. 归一化 `key`（`aliasKeyOf`，幂等）与 `name`（trim）；任一为空 → `dropped++`，不写入；
 * 2. 现有表里已有**同一个归一化 key**（且不是 `scope:'asset'`）→ **原位覆盖**（顺序不变，
 *    避免用户改一个名字导致整表跳动）；
 * 3. 否则追加，但表满 `limit` 就 `dropped++`（上限是硬约束，不静默超）。
 *
 * 纯函数：不读 store、不写设置，返回新数组（`existing` 原样不动）。
 */
export function mergeAliasRecords(
  existing: AliasRecord[],
  incoming: AliasRecord[],
  limit: number = MAX_ALIASES
): AliasMergeResult {
  const out = (existing ?? []).slice()
  let added = 0
  let replaced = 0
  let dropped = 0

  for (const rec of incoming ?? []) {
    if (rec === null || typeof rec !== 'object') {
      dropped += 1
      continue
    }
    const key = aliasKeyOf(rec.key)
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (!key || !name) {
      dropped += 1
      continue
    }
    const clean: AliasRecord = {
      id: typeof rec.id === 'string' && rec.id ? rec.id : newAliasId(),
      scope: rec.scope === 'asset' ? 'asset' : 'key',
      key,
      name,
      createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now()
    }
    // 只在「key 级」记录里找同键：asset 级记录的 key 是 assetId，同名不同语义
    const at = out.findIndex((r) => r.scope !== 'asset' && aliasKeyOf(r.key) === key)
    if (at >= 0) {
      out[at] = clean
      replaced += 1
    } else if (out.length < limit) {
      out.push(clean)
      added += 1
    } else {
      dropped += 1
    }
  }

  return { records: out, added, replaced, dropped }
}

/** 导入解析结果：`error` 非空表示整份文件不可用（不是"部分跳过"） */
export interface AliasImportResult {
  records: AliasRecord[]
  /** 形状非法被跳过的行数（含非对象、缺 key、缺 name、重复归一化 key 的旧行） */
  skipped: number
  /** 整份文件不可用时的原因（JSON 语法错 / 顶层不是数组） */
  error: string | null
}

/**
 * 解析导入的 JSON 文本 → 记录数组（**脏行只跳过，绝不让整份导入失败**）。
 *
 * 接收两种顶层形状（都宽容）：
 * - `[{ key, name }]`（本应用导出的标准格式）；
 * - `{ aliases: [{ key, name }] }`（手写配置 / 旧脚本常见）。
 *
 * 每行要求：对象，且 `key` / `name` 都是**非空字符串**；`scope` 缺省按 `'key'`。
 * `key` 一律归一化（`aliasKeyOf`），因此同一份文件里 `Polished_Concrete` 与
 * `polished concrete` 会算同一个 key —— 后者覆盖前者（`createdAt` 递增）。
 *
 * @param text 文件全文
 * @param now  写入时间戳基准（同一次导入内递增，保证"文件里靠后的胜出"确定）
 */
export function parseAliasImport(text: string, now: number): AliasImportResult {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return { records: [], skipped: 0, error: '文件是空的，没有可导入的别名' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { records: [], skipped: 0, error: '导入失败：不是合法的 JSON 文件' }
  }

  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { aliases?: unknown }).aliases)
      ? ((parsed as { aliases: unknown[] }).aliases)
      : []
  if (list.length === 0) {
    return { records: [], skipped: 0, error: '导入失败：顶层应是 [{ "key": "…", "name": "…" }] 数组' }
  }

  const records: AliasRecord[] = []
  /** 归一化 key → 在 records 里的下标（同 key 后出现者覆盖，保持一次导入内确定） */
  const seen = new Map<string, number>()
  let skipped = 0

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (item === null || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const obj = item as { key?: unknown; name?: unknown; scope?: unknown; createdAt?: unknown }
    const key = typeof obj.key === 'string' ? aliasKeyOf(obj.key) : ''
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (!key || !name) {
      skipped += 1
      continue
    }
    const rec: AliasRecord = {
      id: newAliasId(),
      scope: obj.scope === 'asset' ? 'asset' : 'key',
      key,
      name,
      createdAt: now + i
    }
    const at = seen.get(key)
    if (at !== undefined) {
      // 同 key 在文件里出现两次 = 用户改过主意，后者胜出，前面那条不算"跳过"
      records[at] = rec
    } else {
      seen.set(key, records.length)
      records.push(rec)
    }
  }

  if (records.length === 0 && skipped > 0) {
    return {
      records: [],
      skipped,
      error: `导入失败：${skipped} 行都不是合法别名（需要非空的 key 与 name）`
    }
  }
  return { records, skipped, error: null }
}

/**
 * 导出为 `[{ key, name }]`（与导入格式互逆，**不带 id / createdAt**：
 * 换一台机器导入时不该携带旧主键，`createdAt` 也应由导入方重新生成）。
 */
export function serializeAliases(records: AliasRecord[]): string {
  const rows = (records ?? [])
    .filter((r) => r !== null && typeof r === 'object')
    .map((r) => ({ key: r.key, name: r.name }))
  return JSON.stringify(rows, null, 2)
}

/** 一条"采纳建议"候选 */
export interface AliasSuggestion {
  /** 归一化后的词典 key（勾选状态用它做标识） */
  key: string
  /** 触发建议的资产名（原样，便于用户对照） */
  sourceName: string
  /** 建议的显示名（来自分类词表，绝不臆造） */
  name: string
}

/**
 * 按当前资产名生成建议（**只生成，不写库**）。
 *
 * 逐条过滤（任一条命中就跳过）：
 * - `suggestAlias` 返回 `null`（词表命中不了 / 建议没有新信息）；
 * - 归一化 key 为空；
 * - 该 key **已经配了别名**（`index.byKey` 里已有 → 再建议只会把用户自己的名字盖掉）；
 * - 同一个 key 出现多次（只保留第一条，避免列表里重复）。
 *
 * 截断到 `limit`（默认 10，docs/22 §3.3 口径）。
 */
export function suggestAliasRecords(
  assets: { name: string }[],
  index: AliasIndex,
  limit = 10
): AliasSuggestion[] {
  const out: AliasSuggestion[] = []
  const seen = new Set<string>()
  for (const asset of assets ?? []) {
    if (out.length >= limit) break
    const rawName = typeof asset?.name === 'string' ? asset.name : ''
    if (!rawName) continue
    const key = aliasKeyOf(rawName)
    if (!key || seen.has(key)) continue
    if (index.byKey.has(key)) continue
    const name = suggestAlias(rawName)
    if (!name) continue
    seen.add(key)
    out.push({ key, sourceName: rawName, name })
  }
  return out
}
