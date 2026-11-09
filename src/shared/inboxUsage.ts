/**
 * SketchUp 插件 → ID BOX 主程序「**使用记录**」回传的**产物契约 + 纯校验规则**。
 *
 * ## 这条通道是干什么的
 *
 * 用户在 SketchUp 插件里**插入一次模型** = 这个模型被用过一次，主程序要累加计数
 * （"我最常用哪几个模型"这类统计的基础数据）。导出 / 更新通道（`shared/inbox.ts`）
 * 负责"文件换手"，本文件只负责"事件回传"，两者**互不影响**。
 *
 * ## 磁盘契约（主理人钉死，插件侧与本文件必须逐字一致）
 *
 * ```
 * %APPDATA%\idbox_export\            ← 与 %APPDATA%\idbox\ **同级**（不在其内部）
 *   usage\<jobId>.json                ← 插件写，一个文件 = 一条记录
 * ```
 *
 * - `<jobId>` 与收件箱的任务目录**同形态**（`YYYYMMDD-HHmmss-<4位随机>`），
 *   但**语义不同**：这里它只是"一条记录的唯一文件名"，不对应任何目录。
 * - 原子写：插件写 `usage\<jobId>.json.tmp` 再 `rename` ⇒ 主程序看到 `.json` 即可信，
 *   所以本进程**只认 `.json`**，`.tmp` 一律忽略（见 {@link isInboxUsageFileName}）。
 * - 主程序消费完（渲染层落库）就**删掉**这一个文件；没删掉就代表"还没消费"，
 *   下次启动会再扫到 —— 这就是本通道的 at-least-once 兜底，不需要重发定时器。
 *
 * ## 为什么单独一个文件，而不是往 `incoming\` 塞一条 manifest
 *
 * - `incoming\` 的任务目录会被渲染层走**文件夹导入**（`importPaths`），多一种 `op` 就得
 *   在每个消费分支加一次判断，回归面太大；
 * - 使用记录可能一条几百字节、一天几十条，用目录承载纯属浪费；
 * - 更重要的是：`shared/inbox.ts:isInboxManifestJson()` 是**删除判据**
 *   （`apiVersion===1 && op∈{create,update}`）。使用记录如果放进素材库会被它判成
 *   "不是我们的协议文件"从而留在用户库里 —— 这就是为什么 usage 文件**永远不进库**、
 *   也永远不该被那个函数命中。
 *
 * ## 为什么校验规则放在 shared 而不是 main
 *
 * 本文件**零依赖**（不 import electron / node:*），所以 `tests/inboxUsage.test.ts`
 * 能在 `environment: 'node'` 里直接跑真值表；而 `src/main/inboxUsage.ts`（fs + chokidar）
 * 只做 IO、路径由调用方注入。与 `shared/inbox.ts` / `shared/vault.ts` 同一套分层习惯。
 */

/** `%APPDATA%\idbox_export\` 下的使用记录目录名（与 `incoming\` 平级，不是它的子目录） */
export const INBOX_USAGE_DIR_NAME = 'usage'

/** 落盘后缀。**只有**这个后缀的文件会被认成一条记录（`.tmp` 是插件原子写的中间态） */
export const INBOX_USAGE_FILE_SUFFIX = '.json'

/**
 * 单文件读取上限：`INBOX_USAGE_MAX_BYTES = 4096`（4 KB）。
 *
 * 一条正常记录只有几十字节（`{"apiVersion":1,"op":"usage","assetId":"<36位UUID>",...}`）。
 * 超过 4 KB 一定是坏文件（写坏了 / 被人塞了别的东西 / 磁盘块错乱），直接判废比
 * 读进内存再解析更安全 —— 这个目录是**外部进程可写**的，不能假设文件大小。
 */
export const INBOX_USAGE_MAX_BYTES = 4096

/** 使用记录协议版本（只认这一个；不认识的整份判废，理由与 `INBOX_API_VERSION` 同） */
export const INBOX_USAGE_API_VERSION = 1

/** 唯一的 `op` 值。与 `InboxOp`（create / update）**刻意不同**：两者永不同源 */
export const INBOX_USAGE_OP = 'usage'

/**
 * `assetId` 长度上限（64）：`Asset.id` 是 36 字符的 UUID
 * （`shared/types.ts:303`，`crypto.randomUUID()` 形态）。留一倍余量给未来换 ID 方案，
 * 但绝不允许无上限 —— 那等于允许插件往库里灌一个 10 MB 的字符串。
 */
export const INBOX_USAGE_ASSET_ID_MAX_LEN = 64

/**
 * 合法记录文件名：`YYYYMMDD-HHmmss-<4位随机>.json`（大小写不敏感）。
 *
 * ⚠️ **刻意不 import `INBOX_JOB_ID_RE` 再拼后缀**：那会让两处契约在"随机段字符集"
 * 上产生耦合 —— 哪天收件箱放宽到 `[0-9a-zA-Z_-]{4}`，这里会**跟着**放宽（因为拼的是
 * 同一个正则对象），而使用记录侧的插件实现并没有同步改，结果就是"文件写了但主程序不认"。
 * 两份正则各自独立，漂移时**至少有一侧会红**（`tests/inboxUsage.test.ts` 钉着形态）。
 */
const INBOX_USAGE_FILE_NAME_RE = /^\d{8}-\d{6}-[0-9a-z]{4}\.json$/i

/**
 * `assetId` 里禁止出现的字符：Windows 文件名非法字符 + 路径分隔符 + 控制字符。
 *
 * 说明：`assetId` 在本通道里**只用于查库**（`db.assets.get(assetId)`），不拼任何路径，
 * 所以它本身不构成路径注入。但契约必须卡死形态：
 * - 它来自插件（外部进程、可手改的 JSON），不做约束就等于允许任意字符串进库索引；
 * - 一旦将来有人把"usage 记录里的 id"拿去拼路径（比如顺手写个"存到资产目录"），
 *   今天的宽松就是明天的目录穿越。
 */
const INBOX_USAGE_ILLEGAL_ID_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/

// ── 载荷 / 事件类型（main ↔ preload ↔ renderer 共用）──────────────────────

/**
 * 一条使用记录的**规范形态**（解析后）。
 *
 * 逐字段的合法性判定见 {@link parseInboxUsage}：缺字段 / 类型不对 / 版本不认
 * 一律**整份判废**（不做"缺什么补默认值"的容错 —— 那会把插件侧的契约漂移藏起来，
 * 变成"统计数字慢慢偏了但没人知道为什么"）。
 */
export interface InboxUsageRecord {
  /** 只认 1 */
  apiVersion: number
  /** 恒为 `'usage'` */
  op: 'usage'
  /** 被用掉的那个资产的 `Asset.id`（UUID，36 字符） */
  assetId: string
  /** 插件侧插入时刻（ISO 8601 带时区）；只落库当"最近使用时间"，不参与判定新旧 */
  at: string
  /** 插件版本（只落日志，不参与判定） */
  pluginVersion: string
}

/**
 * 一条记录 + 它来自哪个文件。
 *
 * `fileName` 是**渲染层 ack 回来**的唯一凭据：主进程只认这个文件名去删
 * `usage\<fileName>`，绝不接受渲染层传路径（见 `main/index.ts` 的 handle）。
 */
export interface InboxUsageEntry {
  fileName: string
  record: InboxUsageRecord
}

/**
 * 主进程 → 渲染进程的载荷（`IPC.inboxUsage`）。
 *
 * ⚠️ **不做重发定时器**（与 `IPC.inboxJob` 的 at-least-once 派发不同）：文件本身就是
 * 队列 —— 没 ack 就不会被删，下次启动扫描会再发一次。所以本事件是
 * "**进程内至多一次、跨启动至少一次**"：同一 `fileName` 在本次运行里不会重复 send，
 * 但进程重启后会重发未消费的那些。消费方按 `fileName` 去重即可（重复到达补一次 ack）。
 */
export interface InboxUsageEvent {
  fileName: string
  record: InboxUsageRecord
}

/** 渲染进程 → 主进程：这条记录处理完了（`ok:false` = 没落库，主进程会留着文件下次重试） */
export interface InboxUsageAckPayload {
  fileName: string
  ok: boolean
}

/**
 * ack 结果（**永不 reject**）。
 *
 * - `ok`：ack 是否被接受（`fileName` 不合法 / 不是函数形态 → false）；
 * - `removed`：磁盘上那个文件是否已经不在了。`ok:false` 时恒为 false。
 */
export interface InboxUsageAckResult {
  ok: boolean
  removed: boolean
  /** 人类可读中文（进日志，不进用户界面） */
  reason?: string
}

// ── 纯校验（无 IO）────────────────────────────────────────────────────

/** 解析结果（失败必带**人类可读中文**原因，直接进日志） */
export type InboxUsageParseResult =
  | { ok: true; record: InboxUsageRecord }
  | { ok: false; reason: string }

/** 运行期 `unknown` → 普通对象（数组 / null / Date 都不算） */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

/**
 * 这份文件名是不是一条使用记录（`main/inboxUsage.ts` 的 `add` 事件靠它过滤）。
 *
 * 反例（都会被拒）：
 * - `20261109-184000-ab12.json.tmp`（插件原子写的中间态）
 * - `20261109-184000-ab12.JSON` → **通过**（大小写不敏感：插件在某些环境会写大写扩展名）
 * - `20261109-184000.json`（缺随机段）
 * - `job-1.json` / `` / `manifest.json`
 * - `incoming/20261109-184000-ab12.json`（含路径，不是单段文件名）
 */
export function isInboxUsageFileName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  return INBOX_USAGE_FILE_NAME_RE.test(name)
}

/**
 * 严格解析一份使用记录（入参是 `JSON.parse` 之后的 `unknown`）。
 *
 * ## 判废真值表（每一条都对应一种真实的坏文件形态）
 *
 * | 字段 | 判废条件 | 为什么会真实发生 |
 * |---|---|---|
 * | 整体 | 不是普通对象（`null` / 数组 / 字符串 / 数字 / 布尔） | 写到一半被截断 / 用户手改 / 别的程序往目录里写 |
 * | `apiVersion` | 缺失、不是整数、或 `!== 1` | 旧主程序装在新插件旁边（或反之）⇒ 明确说"本机只支持 1"，别猜协议 |
 * | `op` | 不是 `'usage'` | 插件把导出用的 manifest 误写进 `usage\`（两边复用了 writer） |
 * | `assetId` | 非字符串 / trim 后为空 / 长度 > 64 / 含 `\ / : * ? " < > \|` 或控制字符 | 外部进程可写 ⇒ 必须卡形态；脏 id 会让统计匹配到一个不存在的资产 |
 * | `at` | 非字符串 / trim 后为空 / `Date.parse` 解析不了 | 插件时钟 API 异常时写出空串或 `'(unknown)'` |
 * | `pluginVersion` | 非字符串 / trim 后为空 | 同上：退回占位字符串时会出现 |
 *
 * 返回的 `record` 里所有字符串字段都已 `trim`（盘上的写法可能是 `" usage "`）。
 */
export function parseInboxUsage(raw: unknown): InboxUsageParseResult {
  if (!isRecord(raw)) return { ok: false, reason: '使用记录不是一个 JSON 对象' }

  // ① apiVersion
  const apiVersion = raw['apiVersion']
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    return { ok: false, reason: 'usage.apiVersion 缺失或不是整数' }
  }
  if (apiVersion !== INBOX_USAGE_API_VERSION) {
    return {
      ok: false,
      reason: `不认识的 usage.apiVersion=${String(apiVersion)}（本机只支持 ${INBOX_USAGE_API_VERSION}，请升级 ID BOX）`
    }
  }

  // ② op
  const op = raw['op']
  if (op !== INBOX_USAGE_OP) {
    return { ok: false, reason: `usage.op 只能是 usage（收到「${String(op)}」）` }
  }

  // ③ assetId
  const rawAssetId = raw['assetId']
  if (typeof rawAssetId !== 'string') {
    return { ok: false, reason: 'usage.assetId 缺失或不是字符串' }
  }
  const assetId = rawAssetId.trim()
  if (assetId.length === 0) return { ok: false, reason: 'usage.assetId 为空' }
  if (assetId.length > INBOX_USAGE_ASSET_ID_MAX_LEN) {
    return {
      ok: false,
      reason: `usage.assetId 过长（${assetId.length} > ${INBOX_USAGE_ASSET_ID_MAX_LEN}）`
    }
  }
  if (INBOX_USAGE_ILLEGAL_ID_RE.test(assetId)) {
    return { ok: false, reason: `usage.assetId 含非法字符（路径分隔符 / Windows 保留字符 / 控制字符）` }
  }

  // ④ at
  const rawAt = raw['at']
  if (typeof rawAt !== 'string') return { ok: false, reason: 'usage.at 缺失或不是字符串' }
  const at = rawAt.trim()
  if (at.length === 0) return { ok: false, reason: 'usage.at 为空' }
  if (Number.isNaN(Date.parse(at))) {
    return { ok: false, reason: `usage.at 不是可解析的时间（收到「${at}」）` }
  }

  // ⑤ pluginVersion
  const rawPluginVersion = raw['pluginVersion']
  if (typeof rawPluginVersion !== 'string') {
    return { ok: false, reason: 'usage.pluginVersion 缺失或不是字符串' }
  }
  const pluginVersion = rawPluginVersion.trim()
  if (pluginVersion.length === 0) return { ok: false, reason: 'usage.pluginVersion 为空' }

  return {
    ok: true,
    record: {
      apiVersion: INBOX_USAGE_API_VERSION,
      op: INBOX_USAGE_OP,
      assetId,
      at,
      pluginVersion
    }
  }
}
