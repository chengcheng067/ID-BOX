/**
 * SketchUp 插件 → ID BOX 主程序「收件箱」的**产物契约 + 纯校验规则**。
 *
 * ## 事实底稿
 *
 * - 链路与风险：`docs/probe/su-export-to-idbox.md`（§结论 Q3/Q4、§推荐方案 A、§风险 R4/R5/R6/R7）
 * - 用户口径：`docs/48-V1.0拍板台账-20261109.md` §7
 *   （导出 = 存 skp + 截当前视口当封面 + 自动入库；更新 = 覆盖同名 skp、保留元数据）
 *
 * ## 磁盘契约（主理人钉死，插件侧与本文件必须逐字一致）
 *
 * ```
 * %APPDATA%\idbox_export\                ← 与 %APPDATA%\idbox\ **同级**（不在其内部）
 *   incoming\<jobId>\                    ← 待处理（jobId = YYYYMMDD-HHmmss-<4位随机>）
 *     <baseName>.skp
 *     <baseName>.cover.png               ← 可选
 *     manifest.json                      ← **最后**写，且 `.tmp` → rename（出现即可信）
 *   done\<jobId>\                        ← 处理完成（留档，供用户排查）
 *   failed\<jobId>\ + error.txt          ← 处理失败（error.txt 在 jobId 目录内）
 * ```
 *
 * ## 为什么校验规则放在 shared 而不是 main
 *
 * 本文件**零依赖**（不 import electron / node:*），因此 `tests/inboxManifest.test.ts` 能在
 * `environment: 'node'`（本仓 vitest 的唯一环境，没有 jsdom）里直接跑真值表；而
 * `src/main/inbox.ts`（chokidar + app.getPath）与 `src/main/inboxUpdate.ts`（fs）只做 IO。
 * 与 `shared/vault.ts` / `shared/pluginSnapshot.ts` 同一套分层习惯。
 */

/** 收件箱协议版本（manifest.apiVersion 只认这一个；不认识的整份判废） */
export const INBOX_API_VERSION = 1

/** `%APPDATA%` 下的收件箱根目录名（**不能**落在 `%APPDATA%\idbox\` 之内，见勘察 §Q2） */
export const INBOX_ROOT_DIR_NAME = 'idbox_export'
export const INBOX_INCOMING_DIR_NAME = 'incoming'
export const INBOX_DONE_DIR_NAME = 'done'
export const INBOX_FAILED_DIR_NAME = 'failed'

/** 任务完成标记文件名（插件最后写、`.tmp` → rename） */
export const INBOX_MANIFEST_FILE = 'manifest.json'

/** 插件原子写的临时后缀（本进程一律不认） */
export const INBOX_TMP_SUFFIX = '.tmp'

/**
 * 无 manifest 的残留目录判废年龄：24 小时。
 *
 * 存在的理由：插件正在写 job（`.skp` 可能几百 MB、中文路径更慢）时主程序恰好启动，
 * 扫到一半的目录**不能**判废 —— 那会把一次正在进行的导出搬进 `failed\`，
 * 插件随后写的 manifest 就落在一个已经不在 `incoming\` 的目录里，永远不会被消费。
 */
export const INBOX_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 失败归档时写在 `failed\<jobId>\error.txt` 里的文件上限（防止把超长路径塞进去） */
export const INBOX_MAX_REASON_LEN = 500

/** manifest.json 的读取上限：正常只有几百字节，超过这个数一定是坏文件 */
export const INBOX_MANIFEST_MAX_BYTES = 64 * 1024

/**
 * 合法 `jobId`：`YYYYMMDD-HHmmss-<4位随机>`。
 *
 * 随机段放宽到 `[0-9a-z]{4}`（大小写不敏感）—— 插件侧可能用 `SecureRandom.hex(2)`
 * 也可能用 `rand(36**4).to_s(36)`，两者都落在这个集合里；**不能用更严的正则**，
 * 否则插件换个随机源就会整批判废。
 */
export const INBOX_JOB_ID_RE = /^\d{8}-\d{6}-[0-9a-z]{4}$/i

/** `jobId` 类型闸门（入参一律是 `unknown`：IPC / 目录名都可能是任何东西） */
export function isInboxJobId(raw: unknown): raw is string {
  return typeof raw === 'string' && INBOX_JOB_ID_RE.test(raw)
}

/** 是不是收件箱的任务标记文件（chokidar 的 add 事件靠它过滤） */
export function isInboxManifestFileName(name: string): boolean {
  return name === INBOX_MANIFEST_FILE
}

/**
 * chokidar 的忽略判定（**纯函数**，可单测）。
 *
 * 只忽略两类：`.tmp`（插件原子写的中间产物）与以 `.` 开头的段（隐藏文件 / 保留目录）。
 * ⚠️ 不能像 `watcher.ts:shouldIgnoreWatchPath` 那样把「路径里带 `.trash` 段」也忽略：
 * 收件箱不在库内，与库的回收区没有任何关系。
 */
export function isIgnoredInboxPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return true
  if (p.toLowerCase().endsWith(INBOX_TMP_SUFFIX)) return true
  const segs = p.split(/[\\/]+/).filter((s) => s.length > 0)
  return segs.some((s) => s.startsWith('.'))
}

// ── 载荷 / 事件类型（main ↔ preload ↔ renderer 共用）──────────────────────

/** 插件导出动作两档（与 `docs/48 §7` 一一对应） */
export type InboxOp = 'create' | 'update'

/**
 * `manifest.json` 的形状（**解析后**的规范形态）。
 *
 * 逐字段的合法性判定见 {@link parseInboxManifest}：缺字段 / 类型不对 / 版本不认
 * 一律**整份判废**（不做"缺什么补默认值"的容错 —— 那会把插件侧的契约漂移藏起来）。
 */
export interface InboxJobManifest {
  /** 只认 1 */
  apiVersion: number
  op: InboxOp
  /** 资产名（create 时的展示名 / update 时的日志名字，不参与路径拼接） */
  name: string
  /** 交付的 `.skp` 文件名（单段，不含目录） */
  skp: string
  /** 视口截图文件名（单段）；缺省 / null = 插件没截到（回落 skp 内嵌预览） */
  cover: string | null
  /**
   * `op: 'create'` → 恒为 `null`；
   * `op: 'update'` → **必填**，相对库根的资产目录（形如 `模型/家具/椅子/休闲椅`）。
   */
  targetRelFolder: string | null
  /** 插件版本（只落日志，不参与判定） */
  pluginVersion: string
  /** 插件侧导出时刻（ISO 8601 带时区），只落日志 */
  createdAt: string
}

/**
 * 主进程 → 渲染进程的任务载荷（`IPC.inboxJob`）。
 *
 * `jobDir` / `skpPath` / `coverPath` 三处绝对路径都由**主进程**算好并校验过：
 * 渲染层没有任何 Node 能力，让它自己拼 `jobDir + '\\' + manifest.skp` 会在
 * 分隔符 / 中文 / 大小写上各踩一次坑。
 */
export interface InboxJob {
  jobId: string
  /** 任务目录绝对路径（= `<incoming>\<jobId>`，create 时直接喂给 `importPaths`） */
  jobDir: string
  /** `<jobDir>\<manifest.skp>` 绝对路径（已 stat 过：存在且非空） */
  skpPath: string
  /** `<jobDir>\<manifest.cover>` 绝对路径；manifest 没给封面时为 null */
  coverPath: string | null
  manifest: InboxJobManifest
}

/** 渲染进程 → 主进程：一个任务处理完了（成功 / 失败都要 ack，否则目录会堆在 incoming） */
export interface InboxAckPayload {
  jobId: string
  /** true = 成功（搬 `done\`）；false = 失败（搬 `failed\` 并写 error.txt） */
  ok: boolean
  /** 失败原因（人类可读中文，写进 error.txt；成功时忽略） */
  reason?: string
}

/** ack 结果。`archivedTo: null` = 目录已不在 incoming（幂等重放），**不是错误** */
export interface InboxAckResult {
  ok: boolean
  archivedTo: 'done' | 'failed' | null
  reason?: string
}

/**
 * 渲染进程 → 主进程：把任务里的 `.skp` **就地覆盖**库内同名 `.skp`（「更新」通道）。
 *
 * ⛔ 严禁改走 `IPC.importPaths` 的覆盖档（`importer.ts:replaceAssetFolder` 会把旧目录整个
 * 送进回收站，`applyOverwriteInherit` 只继承 12 个字段）—— 那会丢 `renderParams` /
 * `renderShape` / 自定义封面，直接违反用户口径（见勘察 §Q4-3、§风险 R5）。
 */
export interface InboxApplyUpdatePayload {
  /** 相对库根的资产目录（`模型/家具/椅子/休闲椅`） */
  targetRelFolder: string
  /** 插件交付的 `.skp` 绝对路径（必须是 `<incoming>\<jobId>\` 里的文件） */
  skpSourcePath: string
  /** 任务编号（用于把源文件钉在 `incoming\<jobId>\` 里，防渲染层被注入后乱指路径） */
  jobId: string
}

/** 「就地覆盖」的结果（**不抛错**：失败原因写在 reason 里，可直接给用户看） */
export type InboxApplyUpdateResult =
  | {
      ok: true
      /** 被覆盖的文件绝对路径 */
      targetAbs: string
      /** 被覆盖的文件名（磁盘原名，可能与交付名只在大小写上不同） */
      targetName: string
      /** 写入字节数（= 源 skp 大小） */
      bytes: number
      /**
       * `exact` = 目标目录里有与交付名完全同名的 `.skp`（正常路径）；
       * `sole-skp` = 交付名不存在，但目标目录里**只有唯一一个** `.skp` → 覆盖它
       * （库里那个文件被用户改过名，不覆盖它就会留下两个 `.skp`，主文件漂移，见 R6）。
       */
      selection: 'exact' | 'sole-skp'
    }
  | { ok: false; reason: string }

// ── 校验规则（纯函数，无 IO）────────────────────────────────────────────

/** 解析结果（失败必带**人类可读中文**原因，直接进 `error.txt` / notice） */
export type InboxManifestParseResult =
  | { ok: true; manifest: InboxJobManifest }
  | { ok: false; reason: string }

/** `targetRelFolder` 规范化结果：`segments` 是逐段校验过的目录名（不含空段） */
export type InboxRelFolderResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: string }

/** 资产名长度上限（只影响展示 / 日志，不落盘） */
const MAX_NAME_LEN = 120

/** 单段文件名里的 Windows 非法字符（`: * ? " < > |` 与路径分隔符） */
const ILLEGAL_NAME_CHARS_RE = /[\\/:*?"<>|]/

/** `C:\…` / `C:/…` 盘符前缀 */
const DRIVE_PREFIX_RE = /^[a-zA-Z]:/

/** 运行期 `unknown` → 普通对象（数组 / null / Date 都不算） */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

/**
 * 单段文件名校验（`manifest.skp` / `manifest.cover` 共用）。
 *
 * 五条：非空 → 单段（不含 `\` / `/`）→ 不是 `.` / `..` → 不含 Windows 非法字符 →
 * 扩展名在 `exts` 白名单内且**文件名部分非空**（`.skp` 这种只有扩展名的也拒）。
 */
function validateDeliverableName(
  raw: unknown,
  exts: readonly string[],
  label: string
): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: `${label} 缺失或不是字符串` }
  const name = raw.trim()
  if (name.length === 0) return { ok: false, reason: `${label} 为空` }
  if (name === '.' || name === '..') return { ok: false, reason: `${label} 不能是「${name}」` }
  if (/[\\/]/.test(name)) {
    return { ok: false, reason: `${label} 只能是文件名，不能包含路径分隔符（收到「${name}」）` }
  }
  if (ILLEGAL_NAME_CHARS_RE.test(name)) {
    return { ok: false, reason: `${label} 含 Windows 非法字符（收到「${name}」）` }
  }
  const lower = name.toLowerCase()
  const matched = exts.find((e) => lower.endsWith(e))
  if (!matched) {
    return {
      ok: false,
      reason: `${label} 扩展名不合法（需要 ${exts.join(' / ')}，收到「${name}」）`
    }
  }
  if (lower.length === matched.length) {
    return { ok: false, reason: `${label} 只有扩展名没有名字（收到「${name}」）` }
  }
  return { ok: true, name }
}

/**
 * `targetRelFolder` 规范化 + 逐段校验（**相对库根**的 posix/反斜杠路径都收）。
 *
 * 判废规则（每一条都对应一种真实的踩坑形态）：
 * - 空 / 非字符串 → 判废（没有落点）；
 * - 带盘符（`C:`）或以分隔符开头 → 判废（那叫绝对路径，不是"相对库根"）；
 * - 任何一段是 `.` / `..` → 判废（目录穿越：`../../Windows` 能从库内走出去）；
 * - 任何一段以 `.` 开头 → 判废（`.trash` / `.staging` 是库的保留目录，
 *   往里写等于把文件藏进回收区 / 与并发导入抢同一份目录）；
 * - 任何一段含 Windows 非法字符 → 判废（拼出来的路径在 Windows 上根本打不开）。
 *
 * 返回的 `segments` 已去掉尾部空段与重复分隔符，调用方**只能用 segments 拼绝对路径**
 * （不要用原始字符串，否则 `a//b/` 之类的形态会拼出双分隔符）。
 */
export function normalizeRelFolder(raw: unknown): InboxRelFolderResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'targetRelFolder 缺失或不是字符串' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'targetRelFolder 为空' }
  if (DRIVE_PREFIX_RE.test(trimmed)) {
    return { ok: false, reason: `targetRelFolder 必须是相对库根的路径，不能带盘符（收到「${trimmed}」）` }
  }
  if (/^[\\/]/.test(trimmed)) {
    return { ok: false, reason: `targetRelFolder 必须是相对路径，不能以分隔符开头（收到「${trimmed}」）` }
  }
  const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0)
  if (segments.length === 0) return { ok: false, reason: 'targetRelFolder 里没有任何目录段' }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      return { ok: false, reason: `targetRelFolder 含非法路径段「${seg}」（禁止目录穿越）` }
    }
    if (seg.startsWith('.')) {
      return {
        ok: false,
        reason: `targetRelFolder 不能落在库的保留目录「${seg}」里（.trash / .staging 一律禁写）`
      }
    }
    if (ILLEGAL_NAME_CHARS_RE.test(seg)) {
      return { ok: false, reason: `targetRelFolder 的目录名「${seg}」含 Windows 非法字符` }
    }
  }
  return { ok: true, segments }
}

/**
 * 严格解析 `manifest.json`（入参是 `JSON.parse` 之后的 `unknown`）。
 *
 * ## 判废真值表
 *
 * | 字段 | 判废条件 |
 * |---|---|
 * | 整体 | 不是普通对象（`null` / 数组 / 字符串 / 数字） |
 * | `apiVersion` | 非整数，或 `!== 1`（旧主程序不认新协议 = 明确报错，别猜） |
 * | `op` | 不是 `'create'` / `'update'` |
 * | `name` | 非字符串 / 去空白后为空 / 超过 120 字 |
 * | `skp` | 非单段文件名 / 含非法字符 / 扩展名不是 `.skp` / 只有扩展名 |
 * | `cover` | **可选**；给了就必须是单段图片名（`.png` / `.jpg` / `.jpeg`）且形如 `*.cover.<ext>` |
 * | `targetRelFolder` | `create` 时必须为 `null`（给了非 null 值 → 判废：create 不许自己挑落点）；`update` 时必填且过 {@link normalizeRelFolder} |
 * | `pluginVersion` | 非字符串 / 去空白后为空 |
 * | `createdAt` | 非字符串 / 去空白后为空 / `Date.parse` 解析不了 |
 *
 * ⚠️ `cover` 额外要求 `*.cover.<ext>` 中缀不是洁癖：`importer.ts:1071` 的
 * `isCoverAssetImage()`（`/\.cover\.(jpe?g|png)$/i`）是**唯一**能把它认成封面的判定，
 * 名字不带 `.cover.` 的图只会变成一张普通贴图 —— 与其静默丢封面，不如当场判废并说清原因。
 *
 * ⚠️ 不校验 `cover` 与 `skp` 的主名是否相同：插件侧的主名来自
 * `ComponentDefinition#path` 的 basename，和导出时的资产名可能合法地不一致；
 * 强制相等只会把合法任务拒掉，而 `isCoverAssetImage` 本身并不要求相等。
 */
export function parseInboxManifest(raw: unknown): InboxManifestParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'manifest.json 不是一个 JSON 对象' }

  // ① apiVersion
  const apiVersion = raw['apiVersion']
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    return { ok: false, reason: 'manifest.apiVersion 缺失或不是整数' }
  }
  if (apiVersion !== INBOX_API_VERSION) {
    return {
      ok: false,
      reason: `不认识的 manifest.apiVersion=${String(apiVersion)}（本机只支持 ${INBOX_API_VERSION}，请升级 ID BOX）`
    }
  }

  // ② op
  const op = raw['op']
  if (op !== 'create' && op !== 'update') {
    return { ok: false, reason: `manifest.op 只能是 create / update（收到「${String(op)}」）` }
  }

  // ③ name
  const rawName = raw['name']
  if (typeof rawName !== 'string') return { ok: false, reason: 'manifest.name 缺失或不是字符串' }
  const name = rawName.trim()
  if (name.length === 0) return { ok: false, reason: 'manifest.name 为空' }
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, reason: `manifest.name 过长（${name.length} > ${MAX_NAME_LEN}）` }
  }

  // ④ skp
  const skp = validateDeliverableName(raw['skp'], ['.skp'], 'manifest.skp')
  if (!skp.ok) return { ok: false, reason: skp.reason }

  // ⑤ cover（可选）
  let cover: string | null = null
  const rawCover = raw['cover']
  if (rawCover !== undefined && rawCover !== null) {
    const c = validateDeliverableName(rawCover, ['.png', '.jpg', '.jpeg'], 'manifest.cover')
    if (!c.ok) return { ok: false, reason: c.reason }
    if (!/\.cover\.(png|jpe?g)$/i.test(c.name)) {
      return {
        ok: false,
        reason: `manifest.cover 必须形如「<名字>.cover.png」（否则导入器不会把它当封面，收到「${c.name}」）`
      }
    }
    cover = c.name
  }

  // ⑥ targetRelFolder
  const rawTarget = raw['targetRelFolder']
  let targetRelFolder: string | null = null
  if (op === 'create') {
    if (rawTarget !== null && rawTarget !== undefined) {
      return { ok: false, reason: 'op=create 时 targetRelFolder 必须为 null（新建不许自己挑落点）' }
    }
  } else {
    if (rawTarget === null || rawTarget === undefined) {
      return { ok: false, reason: 'op=update 时 targetRelFolder 必填（否则不知道该覆盖库里哪个模型）' }
    }
    const rel = normalizeRelFolder(rawTarget)
    if (!rel.ok) return { ok: false, reason: rel.reason }
    targetRelFolder = rel.segments.join('/')
  }

  // ⑦ pluginVersion
  const rawPluginVersion = raw['pluginVersion']
  if (typeof rawPluginVersion !== 'string') {
    return { ok: false, reason: 'manifest.pluginVersion 缺失或不是字符串' }
  }
  const pluginVersion = rawPluginVersion.trim()
  if (pluginVersion.length === 0) return { ok: false, reason: 'manifest.pluginVersion 为空' }

  // ⑧ createdAt
  const rawCreatedAt = raw['createdAt']
  if (typeof rawCreatedAt !== 'string') {
    return { ok: false, reason: 'manifest.createdAt 缺失或不是字符串' }
  }
  const createdAt = rawCreatedAt.trim()
  if (createdAt.length === 0) return { ok: false, reason: 'manifest.createdAt 为空' }
  if (Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: `manifest.createdAt 不是可解析的时间（收到「${createdAt}」）` }
  }

  return {
    ok: true,
    manifest: {
      apiVersion: INBOX_API_VERSION,
      op,
      name,
      skp: skp.name,
      cover,
      targetRelFolder,
      pluginVersion,
      createdAt
    }
  }
}

// ── 「这份 json 是不是我们自己的协议文件」（导入时剔除用）──────────────────

/**
 * 这段文本是不是 **ID BOX 收件箱的协议文件**（插件写的 `manifest.json`）？
 *
 * ## 用途（唯一调用点：`main/fsutil.ts#dropInboxProtocolManifest`）
 *
 * 插件把 job 目录整个留在收件箱里，而 `create` 通道是**文件夹导入** →
 * 那个 `manifest.json` 会被一起拷进用户的素材库，表现为"模型文件夹里躺着一个
 * `manifest.json`"。我们的内部协议文件不该出现在用户的库里，所以导入时把它剔掉。
 *
 * ## 判据为什么只有「apiVersion + op」两条（比 `parseInboxManifest` 宽松）
 *
 * 这是**删除**判据，两端都有代价，所以要卡在中间：
 * - 用严格解析器当判据 → 被我们判废的那部分（比如 name 超长、cover 名字不合规范）
 *   同样是**我们的文件**，却会因为"不合法"被留在用户库里 —— 判据与用途错位；
 * - 只按文件名 `manifest.json` 一刀切 → 用户自己的素材包（PBR 材质包 / 导出器的
 *   工程描述）里带的 `manifest.json` 可能正是他要的资产，删掉是不可逆的数据事故。
 *
 * `apiVersion === 1` 且 `op ∈ {create, update}` 这个组合在真实素材里出现概率≈0，
 * 而在协议里是**恒定**的 ⇒ 既能命中我们全部形态（含被 strict 解析器拒收的），
 * 又几乎不可能误伤用户文件。其余字段一律不看。
 *
 * 纯函数、零 IO；调用方负责"文件名必须是 `manifest.json`"与大小上限。
 */
export function isInboxManifestJson(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  if (text.length > INBOX_MANIFEST_MAX_BYTES) return false
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return false
  }
  if (!isRecord(raw)) return false
  const apiVersion = raw['apiVersion']
  if (typeof apiVersion !== 'number' || apiVersion !== INBOX_API_VERSION) return false
  const op = raw['op']
  return op === 'create' || op === 'update'
}

// ── 「更新」通道的目标路径推导（纯决策，落在哪里由调用方执行）─────────────
/** `planSkpUpdateTarget` 的输入（**全部由调用方算好**，本函数不做任何 IO） */
export interface SkpUpdatePlanInput {
  /** 库根绝对路径（`settings.libraryDir`） */
  libraryDir: string
  /** 相对库根的资产目录（payload 原值，内部会再过一遍 normalizeRelFolder） */
  targetRelFolder: string
  /** 交付的 `.skp` 文件名（`path.basename(skpSourcePath)`） */
  skpFileName: string
  /** 目标目录此刻的文件名清单（`fs.readdir` 的结果，含目录名也无妨） */
  existingNames: readonly string[]
  /** 平台路径分隔符（`path.sep`；调用方传，便于在任意 CI 平台上单测） */
  sep: string
}

/** 目标路径推导结果 */
export type SkpUpdatePlan =
  | { ok: true; targetDirAbs: string; targetAbs: string; targetName: string; selection: 'exact' | 'sole-skp' }
  | { ok: false; reason: string }

/** 盘符 / UNC / POSIX 根：能当「绝对路径根」用的形态 */
function isAbsoluteLike(p: string): boolean {
  if (p.length === 0) return false
  if (DRIVE_PREFIX_RE.test(p)) return /^[a-zA-Z]:[\\/]/.test(p)
  return /^[\\/]{2}/.test(p) || p.startsWith('/')
}

/** `C:` 这种「只有盘符」的最短绝对形态（`trimTrailingSep` 不许把它再砍成 `C`） */
const DRIVE_ROOT_ONLY_RE = /^[a-zA-Z]:$/

/** 去掉尾部分隔符（保留根自身：`C:\` → `C:\`，`C:\lib\` → `C:\lib`） */
function trimTrailingSep(p: string, sep: string): string {
  let out = p
  while (out.length > 1 && out.endsWith(sep) && !DRIVE_ROOT_ONLY_RE.test(out.slice(0, -1))) {
    out = out.slice(0, -1)
  }
  return out
}

/** 绝对路径 + 已校验的目录段 → 绝对路径（不依赖 `node:path`，任意平台同一结果） */
function joinAbs(root: string, segments: readonly string[], sep: string): string {
  const base = trimTrailingSep(root, sep)
  const needSep = !base.endsWith(sep)
  return needSep ? base + sep + segments.join(sep) : base + segments.join(sep)
}

/** `resolveInboxTargetDir` 的结果 */
export type InboxTargetDirResult =
  | { ok: true; targetDirAbs: string; relSegments: string[] }
  | { ok: false; reason: string }

/**
 * 库根 + `targetRelFolder` → 目标目录的**绝对路径**（纯字符串，不碰磁盘）。
 *
 * 两道校验：库目录必须是绝对路径（相对路径会按主进程 cwd 解析，开发态/打包态完全是
 * 两个地方）；`targetRelFolder` 必须是干净的相对路径（见 `normalizeRelFolder`）。
 * 返回的 `relSegments` 给「没有 .skp」这类文案用（可以回显给人看，但不参与拼路径）。
 */
export function resolveInboxTargetDir(
  libraryDir: unknown,
  targetRelFolder: unknown,
  sep: string
): InboxTargetDirResult {
  const lib = typeof libraryDir === 'string' ? libraryDir.trim() : ''
  if (lib.length === 0) {
    return { ok: false, reason: '库目录尚未设置，无法更新模型。请先在「设置 → 库」里选择库目录' }
  }
  if (!isAbsoluteLike(lib)) {
    return { ok: false, reason: `库目录不是绝对路径（收到「${lib}」），无法定位要更新的模型` }
  }
  const rel = normalizeRelFolder(targetRelFolder)
  if (!rel.ok) return { ok: false, reason: rel.reason }
  const normalizedSep = sep === '/' ? '/' : '\\'
  return {
    ok: true,
    targetDirAbs: joinAbs(lib, rel.segments, normalizedSep),
    relSegments: rel.segments
  }
}

/**
 * 推导「更新」通道要覆盖的**那一个** `.skp` 的绝对路径。
 *
 * ## 目标文件名的取值顺序（R6：不许改名、不许留两个 `.skp`）
 *
 * 1. 交付名（`<baseName>.skp`）在目标目录里**同名存在**（大小写不敏感）→ 覆盖它，
 *    文件名用**磁盘上的原名**（保留用户/系统的大小写，不把 `Chair.SKP` 改成 `chair.skp`）；
 * 2. 交付名不在，但目录里**恰好只有一个** `.skp` → 覆盖它（库里那个文件被用户改过名，
 *    不覆盖它就等于"更新失败还悄悄留了个旧文件"，之后 `pickPrimaryFile` 会按遍历顺序
 *    挑主文件 → 预览 / 拖出可能指向旧的那个，见勘察 §R6）；
 * 3. 一个都没有 → 判废（目标目录里没有可覆盖的 `.skp`，说明 relFolder 指错了地方）；
 * 4. 有多个但都不叫交付名 → 判废（**绝不猜**：猜错 = 把一个模型的内容写进另一个模型）。
 *
 * 所有判废都返回中文原因，调用方原样写进 `error.txt` / notice。
 */
export function planSkpUpdateTarget(input: SkpUpdatePlanInput): SkpUpdatePlan {
  const name = validateDeliverableName(input.skpFileName, ['.skp'], '源文件')
  const sep = input.sep === '/' ? '/' : '\\'
  const dir = resolveInboxTargetDir(input.libraryDir, input.targetRelFolder, sep)
  if (!name.ok) return { ok: false, reason: name.reason }
  if (!dir.ok) return { ok: false, reason: dir.reason }
  const targetDirAbs = dir.targetDirAbs

  const names = Array.isArray(input.existingNames)
    ? input.existingNames.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
  const lower = name.name.toLowerCase()

  const exact = names.find((n) => n.toLowerCase() === lower)
  if (exact && exact.toLowerCase().endsWith('.skp')) {
    return {
      ok: true,
      targetDirAbs,
      targetAbs: joinAbs(targetDirAbs, [exact], sep),
      targetName: exact,
      selection: 'exact'
    }
  }

  const skps = names.filter((n) => n.toLowerCase().endsWith('.skp'))
  if (skps.length === 1) {
    const only = skps[0]!
    return {
      ok: true,
      targetDirAbs,
      targetAbs: joinAbs(targetDirAbs, [only], sep),
      targetName: only,
      selection: 'sole-skp'
    }
  }
  if (skps.length === 0) {
    return {
      ok: false,
      reason: `目标目录里没有 .skp 文件（${dir.relSegments.join('/')}）——可能分类目录被改过，请先在 ID BOX 里重新扫描库`
    }
  }
  return {
    ok: false,
    reason: `目标目录里有 ${skps.length} 个 .skp，且没有一个叫「${name.name}」，无法确定要覆盖哪一个（请先在 ID BOX 里删掉多余版本）`
  }
}

/**
 * 把 `fs` 的错误码翻译成**可指导用户动作**的中文（写 `.skp` 失败时用）。
 *
 * 最容易踩的是 Windows 的独占锁：用户正用 SketchUp 打开库里那个 `.skp` 时，
 * `rename` 到目标名会拿到 `EBUSY` / `EPERM` / `EACCES`（见勘察 §R4）。
 * 这时唯一的解法是"先在 SketchUp 里关掉它"，文案必须说出来，否则用户只会反复点更新。
 */
export function describeInboxWriteError(code: string | undefined, targetName: string): string {
  switch (code) {
    case 'EBUSY':
    case 'EPERM':
    case 'EACCES':
      return `目标文件「${targetName}」正被其他程序占用（很可能正在 SketchUp 里打开），更新已取消。请先在 SketchUp 里关闭该文件后重试`
    case 'ENOSPC':
      return `磁盘空间不足，未能写入「${targetName}」。请清理磁盘后重试`
    case 'ENOENT':
      return `目标文件或目录已不存在（「${targetName}」），可能在 ID BOX 里被移动/删除了，请重新扫描库后重试`
    case 'EROFS':
      return `目标位置是只读的，无法写入「${targetName}」`
    case 'EXDEV':
      return `无法把新文件挪到「${targetName}」所在位置（跨卷），请检查库目录所在磁盘`
    default:
      return `写入「${targetName}」失败${code ? `（${code}）` : ''}，旧文件已保留`
  }
}
