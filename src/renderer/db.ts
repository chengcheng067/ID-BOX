import Dexie, { type Table } from 'dexie'
import type { Asset, ColorTag, ThumbStatus } from '../shared/types'
import { COLOR_TAGS } from '../shared/types'
import { UNCLASSIFIED } from '../shared/taxonomy'
import { baseNameOf, dedupeKeyOf } from '../shared/naming'

/** 迁移快照：v1 全量索引的 JSON 备份（永不自动清理） */
export interface IndexBackup {
  id: string
  at: number
  json: string
}

/**
 * 别名条目（Dexie v5 新表 `aliases`， docs/20 §5）。
 *
 * **形状由 C 线先落死**（「最小接口」），D 线直接复用，避免两线各建一份：
 * - `scope: 'key'` = 词典型（key = 归一化后的名字，影响全部同名资产）
 * - `scope: 'asset'` = 单资产型（id 即资产 id，只覆盖那一个）
 * C 线**不写任何别名逻辑**，只保证表与索引存在、迁移幂等。
 */
export interface AliasEntry {
  id: string
  scope: 'key' | 'asset'
  key: string
  name: string
  createdAt: number
}

/** v5 的 `aliases` 索引串（导出供测试钉住形状；D 线按这个用 `.where('key')`） */
export const ALIASES_STORE_SCHEMA = 'id, key, scope'

/** v5 的 `assets` 索引串（新增 `deletedAt`；其余保持 v4 原样） */
export const ASSETS_V5_STORE_SCHEMA =
  'id, kind, category1, category2, *styles, source, importedAt, updatedAt, *tags, dedupeKey, suVersion, suMajor, folder, coverSource, deletedAt'

/**
 * v5 升级的单条记录迁移（**纯函数 + 幂等**，Dexie upgrade 与单测共用）。
 *
 * 规则：老记录**没有** `deletedAt` → 保持 `undefined`（= 未删除）。
 * 只有历史上被写成 `0` / `null` 的脏值才删掉——补 0 会让全部老资产落进
 * `deletedAt` 索引（"未删除"与"1970 年删除"混为一谈），补 null 同理。
 *
 * 不做 IO、不取当前时间 → 连跑两次结果完全一致。
 */
export function applyAssetV5(record: Asset): Asset {
  const next: Asset = { ...record }
  if (next.deletedAt === null || next.deletedAt === 0) {
    delete next.deletedAt
  }
  return next
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 旧 id 是 relFolder（如 "模型/某沙发"），新 id 是 UUID */
export function looksLikeUuid(id: string): boolean {
  return typeof id === 'string' && UUID_RE.test(id)
}

/** 合法色标集合（O(1) 判定，避免把外部脏数据写进 DB） */
const COLOR_TAG_SET: ReadonlySet<string> = new Set(COLOR_TAGS)

/**
 * v4 升级的单条记录迁移（**幂等纯函数**，Dexie upgrade 与单测共用）。
 *
 * 三件事：
 * ① 补 `favorite` / `rating` / `colorTag` 默认值——**已有合法值不覆盖**；
 * ② 重算 `dedupeKey`：用 `baseNameOf(asset.name)` 剥掉历史 `uniqueName` 追加的
 *    `-2` 后缀后再生成，修正老数据里「同一套资产 key 不相等」的错值；
 * ③ 不做任何 IO、不使用当前时间 → 重复执行结果完全相同。
 *
 * 为什么重算无害：`dedupeKey` 是**派生字段**（只由 name + kind 决定），
 * 用户可编辑的元数据（tags/note/styles/favorite…）一个都不动。
 */
export function applyAssetV4(record: Asset): Asset {
  const favorite = record.favorite === true
  const rawRating = typeof record.rating === 'number' && Number.isFinite(record.rating) ? record.rating : 0
  const rating = Math.min(5, Math.max(0, Math.round(rawRating)))
  const colorTag: ColorTag | null =
    typeof record.colorTag === 'string' && COLOR_TAG_SET.has(record.colorTag)
      ? (record.colorTag as ColorTag)
      : null
  const name = typeof record.name === 'string' ? record.name : ''
  const dedupeKey = dedupeKeyOf(baseNameOf(name), String(record.kind ?? 'other'))
  return { ...record, favorite, rating, colorTag, dedupeKey }
}

/** 生成 v4 形态的 UUID；极老 WebView 下退化为自实现 */
export function newAssetId(): string {
  const g: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (g && typeof g.randomUUID === 'function') return g.randomUUID()
  const bytes = new Uint8Array(16)
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 本地索引库（IndexedDB）：只存元数据，文件永远在库目录里。
 *
 * v2 迁移（P0-7 / D1 / K4）：
 * ① 先把 v1 全量快照写进 `backups` store（零 IO、可回滚）
 * ② Dexie 不允许 modify 改主键 → 读出 + clear + 用新 UUID bulkAdd 写回
 *    旧 id 就是 relFolder，迁移时把它搬进新的 `relFolder` 字段，tags/note 原样保留
 */
export class VaultDB extends Dexie {
  assets!: Table<Asset, string>
  backups!: Table<IndexBackup, string>
  aliases!: Table<AliasEntry, string>

  constructor() {
    super('modvault')
    this.version(1).stores({
      assets: 'id, kind, source, importedAt, updatedAt, *tags, dedupeKey'
    })
    this.version(2)
      .stores({
        assets: 'id, kind, source, importedAt, updatedAt, *tags, dedupeKey, suVersion, suMajor, folder, coverSource',
        backups: 'id, at'
      })
      .upgrade(async (tx) => {
        const old = (await tx.table('assets').toArray()) as Asset[]
        if (old.length > 0) {
          await tx.table('backups').put({
            id: `v1-${Date.now()}`,
            at: Date.now(),
            json: JSON.stringify(old)
          })
        }
        const migrated: Asset[] = old.map((a) => ({
          ...a,
          id: looksLikeUuid(a.id) ? a.id : newAssetId(),
          relFolder: a.relFolder ?? a.id,
          coverSource: a.cover ? 'root' : 'placeholder',
          thumbStatus: 'none' as ThumbStatus,
          tags: a.tags ?? [],
          note: a.note ?? ''
        }))
        await tx.table('assets').clear()
        await tx.table('assets').bulkAdd(migrated)
      })
    // ── T06 v3：分类体系（06 v1.0.2 §10.2） ─────────────────────────
    // 不回改 v2：已处于 v2 的库不会重跑 upgrade（RA4）。v3 不改主键 → modify 即可，
    // 不需要 v2 那种 clear + bulkAdd。
    this.version(3)
      .stores({
        assets:
          'id, kind, category1, category2, *styles, source, importedAt, updatedAt, *tags, dedupeKey, suVersion, suMajor, folder, coverSource',
        backups: 'id, at'
      })
      .upgrade(async (tx) => {
        const old = (await tx.table('assets').toArray()) as Asset[]
        if (old.length > 0) {
          await tx.table('backups').put({
            id: `v2-${Date.now()}`,
            at: Date.now(),
            json: JSON.stringify(old)
          })
        }
        // 老数据补默认值：无三字段的记录 → 未分类 / 未分类 / []
        await tx.table('assets').toCollection().modify((a: Asset) => {
          a.category1 = a.category1 ?? UNCLASSIFIED
          a.category2 = a.category2 ?? UNCLASSIFIED
          a.styles = a.styles ?? []
        })
      })
    // ── v0.4 资产标记 + 重复检测键修正 ───────────────────────────────
    //
    // 1) 新增 favorite / rating / colorTag（默认 false / 0 / null），已有合法值不覆盖；
    // 2) **重算 dedupeKey**：历史写入点用的是 `uniqueName()` 之后的最终名，第二个
    //    同名包叫「椅子-2」→ key = `model:椅子-2`，与 `model:椅子` 不相等 → 老库里
    //    的重复关系全是断的。这里用 `baseNameOf()` 剥掉自动序号后重算。
    //
    // 索引**不变**：dedupeKey 早就建了索引，favorite 不建（项目里 0 处 `.where()`，
    // 标记筛选全量在内存过滤，加索引只会白占空间）。幂等：applyAssetV4 是纯函数，
    // 重复执行结果完全一致，不产生额外 IO。
    this.version(4)
      .stores({
        assets:
          'id, kind, category1, category2, *styles, source, importedAt, updatedAt, *tags, dedupeKey, suVersion, suMajor, folder, coverSource',
        backups: 'id, at'
      })
      .upgrade(async (tx) => {
        await tx.table('assets').toCollection().modify((a: Asset) => {
          const fixed = applyAssetV4(a)
          a.favorite = fixed.favorite
          a.rating = fixed.rating
          a.colorTag = fixed.colorTag
          a.dedupeKey = fixed.dedupeKey
        })
      })
    // ── v5：库内「最近删除」（C 线）+ 别名词典表（D 线占位） ─────────────
    //
    // ① `assets` 加 `deletedAt` 索引（软删筛选；老记录**不补值**，undefined = 未删除）；
    // ② 新增 `aliases` 表（`AliasEntry`，D 线直接复用；C 线只建表不写逻辑）。
    // 索引串从常量取，测试可直接钉住形状。迁移用纯函数 applyAssetV5 → 幂等。
    this.version(5)
      .stores({
        assets: ASSETS_V5_STORE_SCHEMA,
        backups: 'id, at',
        aliases: ALIASES_STORE_SCHEMA
      })
      .upgrade(async (tx) => {
        await tx.table('assets').toCollection().modify((a: Asset) => {
          const fixed = applyAssetV5(a)
          if (fixed.deletedAt === undefined) delete a.deletedAt
          else a.deletedAt = fixed.deletedAt
          // trashRel / aliasOverride 不主动补值：undefined 即"没有"，避免无意义写放大
        })
      })
  }
}

export const db = new VaultDB()
