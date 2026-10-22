/** 资产命名规则：清洗非法字符、剥离下载站水印、防重名、分类段校验（T06） */

import { UNCLASSIFIED } from './taxonomy'

const ILLEGAL_RE = /[<>:"/\\|?*\u0000-\u001f]/g

/** 只有下划线/空白/点组成的名字视为"清洗后为空"（如 '///' → '___'） */
const ONLY_PLACEHOLDER_RE = /^[_\s.]+$/

/** Windows 合法文件夹名 */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_RE, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  // 替换后可能只剩 '_'（D1 回归守卫：'///' 必须得到 '未命名' 而不是 '___'）
  if (!cleaned || ONLY_PLACEHOLDER_RE.test(cleaned)) return '未命名'
  return cleaned
}

/** 下载站常见水印/噪音后缀 */
const NOISE_PATTERNS: Array<[RegExp, string]> = [
  [/\((?:www\.[^)]*|知末[^)]*|znmo[^)]*|3d66[^)]*)\)/gi, ''],
  [/\[(?:www\.[^\]]*|知末[^\]]*)\]\]?/gi, ''],
  [/(?:^|[\s_\-(\[])(?:znmo|知末网?|3d66)(?:$|[\s_\-)\]])/gi, ' '],
  [/\(\s*\d+\s*\)$/, ''],
  [/[-_\s]*(?:copy|副本)$/i, '']
]

/** 剥离水印噪音；若清洗后为空则返回原值 */
export function stripNoise(name: string): string {
  let n = name
  for (const [re, rep] of NOISE_PATTERNS) n = n.replace(re, rep)
  n = n.replace(/[\s_\-]+$/, '').trim()
  return n || name
}

// ── 显示名（2026-10-21 用户拍板：**只改界面显示，磁盘名一个字符都不动**） ──

/**
 * 知末商品 ID 段：`…深色仿古砖ID_1172815578`、`…挂画组合ID-1186414883`、`… 椅子 id_1234567`。
 *
 * 位数门槛 6 位是**故意的**：知末商品 ID 实测都是 9–10 位，4 位数字常常是年份/型号
 * （「型号ID2024」），6 位门槛既覆盖真实 ID，又不会把年份当 ID 剥掉。
 *
 * 两条规则要分开，因为真实库里两种都有：
 * - `TAIL`：ID 在名字末尾（绝大多数）；
 * - `MID`：ID 在中间、后面还跟着 `_resize` / `_2K` / `.jpg` 这类后缀
 *   （实测样本 `中古木纹_无缝中古樱桃木_樱桃木木纹ID_1166965084_resize`）。
 *   `MID` 用 lookahead 保留 ID 后面那个分隔符，所以结果是 `…木纹_resize` 而不是 `…木纹resize`。
 */
const ZHIMO_ID_TAIL_RE = /[\s_\-]*ID[\s_\-]?\d{6,}$/i
const ZHIMO_ID_MID_RE = /[\s_\-]?ID[\s_\-]?\d{6,}(?=[\s_\-.])/gi

/**
 * `znzmo` 前缀标记（2026-10 用户反馈：`「中古侘寂屏风…」` 这类资产，包内文件名是
 * `znzmo-1180221079-1.skp`，资产名里**一个 ID 字都没有** → 旧实现取不到 ID）。
 *
 * - 只取**第一段**数字：`znzmo-<ID>-1` 的 `-1` 是站方图片/模型序号，**不是** ID 的一部分；
 *   `(\d{6,})` 贪婪吃到 `-` 前为止，`(?!\d)` 再钉死"数字串已结束"；
 * - 左侧 `(?<![A-Za-z])` 防 `myznzmo-…` / `znzmoish-…` 这类噪音词误命中；
 * - 位数门槛仍是 6 位（与 `ID` 标记同口径，4 位年份/型号不许命中）。
 */
const ZNZMO_ID_RE = /(?<![A-Za-z])znzmo[\s_\-]*(\d{6,})(?!\d)/gi

/**
 * 裸数字兜底（2026-10 用户反馈：「有一些文件是不含 ID 的前缀的，但是它有后面的一串数字」）。
 *
 * ⚠️ **只认 9–10 位、且左右都不是数字**，这是本规则唯一的安全边界：
 * - 9–10 位 = 知末商品 ID 的真实位数区间；
 * - `(?<!\d)` / `(?!\d)` 保证**绝不被更长的数字串包住**：
 *   解压目录 `attachment_1786942463670`（13 位）内部的 10 位片段不会命中；
 * - 4 位年份/型号（`型号ID2024`）天然不命中。
 *
 * **宁可返回 null，也不能返回错的 ID** —— 错一个 ID 就会抓到别人家的封面。
 */
const BARE_ZHIMO_ID_RE = /(?<!\d)\d{9,10}(?!\d)/g

/** 在文本里取**最右**一个匹配（`group` 默认为 1，传 0 表示整段） */
function rightmostMatch(re: RegExp, s: string, group = 1): string | null {
  re.lastIndex = 0
  let out: string | null = null
  for (const m of s.matchAll(re)) {
    const v = m[group]
    if (v) out = v
  }
  re.lastIndex = 0
  return out
}

/** 名字里是否存在知末 ID 段（`MID` 是带 `g` 的正则，用前用后都要复位 `lastIndex`） */
function hasZhimoId(s: string): boolean {
  ZHIMO_ID_MID_RE.lastIndex = 0
  const mid = ZHIMO_ID_MID_RE.test(s)
  ZHIMO_ID_MID_RE.lastIndex = 0
  return mid || ZHIMO_ID_TAIL_RE.test(s)
}

/**
 * 界面显示用的资产名：去掉知末 `ID_<数字>` 段。
 *
 * ⚠️ **只用于渲染**（卡片标题 / 列表名 / 文件视图标题 / 重复组标题 / 画布对话框 / img alt /
 * 拖拽卡片上的名字）。绝不用于落盘、重命名、`dedupeKey`、搜索或排序——磁盘文件夹名与索引里的
 * `name` 必须保持原样：
 * - 落盘名参与四层路径，改了要迁移；`dedupeKey` 由原名算出，改了会让历史记录判不出重复；
 * - 搜索走原名（显示名是原名的子串，两种写法都还能搜到）。
 *
 * 边界：没命中 ID 段 → 原样返回（连末尾的 `_`/`-` 也不动，那是名字的一部分）；
 * 剥完变空（名字本身就叫 `ID_1234567`）→ 保留原值，宁可露出 ID 也不给空名。
 *
 * 幂等：`displayName(displayName(x)) === displayName(x)`。
 */
export function displayName(name: string): string {
  const s = String(name ?? '').trim()
  if (!s) return s
  if (!hasZhimoId(s)) return s
  const stripped = s
    .replace(ZHIMO_ID_MID_RE, '')
    .replace(ZHIMO_ID_TAIL_RE, '')
    // 名字以 ID 开头时（`ID_1234567_拷贝`）会留下一个前导分隔符，一并收掉
    .replace(/^[\s_\-]+/, '')
    .replace(/[\s_\-]+$/, '')
    .trim()
  return stripped || s
}

/**
 * 从文本里取出知末商品 ID（纯数字串）；取不到返回 `null`。
 *
 * 识别规则按**可信度降序**，命中即返回（多个候选时取**最右**那个 —— 下载器把站点
 * ID 追加在尾巴上，最右那个才是真正的 sku）：
 *
 * ① **`ID` 标记**（最高可信）：`ID` + 可选分隔符 + 6 位以上数字。
 *    沿用 `displayName()` 的**同两条正则**（`ZHIMO_ID_TAIL_RE` / `ZHIMO_ID_MID_RE`），
 *    保证"显示名剥掉了 ID、却抓不到 ID"这种自相矛盾的库不会出现：
 *    `ID_1166965084` / `ID-1186414883` / `id 1234567` / `…ID_1166965084_resize` 全部成立。
 * ② **`znzmo` 前缀**：`znzmo-1180221079-1.skp`、`znzmo-1191034576-1.preview.jpg`
 *    （知末包内文件的真实形态）。只取第一段数字，`-1` 是站方序号，不属于 ID。
 * ③ **裸数字兜底**：仅 9–10 位且左右都不是数字（`(?<!\d)\d{9,10}(?!\d)`）。
 *    兜住"名字里就是一串数字"的情况；`attachment_1786942463670`（13 位）不会误中。
 *
 * ⚠️ `ZHIMO_ID_MID_RE` 带 `g`：调用前 `lastIndex = 0`，用完再复位 0
 * （与 `hasZhimoId()` 同款习惯，避免上一处 `matchAll` / `exec` 的残留影响下一次）。
 *
 * 纯函数，绝不抛错：非字符串入参（历史脏索引）按空串处理。
 */
export function zhimoIdFromText(text: string): string | null {
  const s = String(text ?? '').trim()
  if (!s) return null

  // ① 显式 `ID` 标记（与 displayName 同一份正则，口径不会漂移）
  const explicit = idMarkerIdOf(s)
  if (explicit) return explicit

  // ② `znzmo` 前缀（包内文件名 `znzmo-<ID>-<序号>.skp`）
  const znzmo = rightmostMatch(ZNZMO_ID_RE, s)
  if (znzmo) return znzmo

  // ③ 裸 9–10 位数字兜底（宁可 null，不可返回错的 ID）
  return rightmostMatch(BARE_ZHIMO_ID_RE, s, 0)
}

/**
 * 兼容旧名（= `zhimoIdFromText`），语义不变。
 *
 * 保留这个名字是因为它被多处调用（`store` 的封面队列、`DetailPanel` 的按钮可用性、
 * `logic/zhimoCover.ts` 的目标筛选），改名会制造无谓的跨文件 diff。
 */
export function zhimoIdOf(name: string): string | null {
  return zhimoIdFromText(name)
}

/**
 * 只认 ① `ID` 标记的旧口径（`zhimoIdFromText` 的第一档）。
 *
 * 三条规则（v0.6.3 之前 `zhimoIdOf` 的全部实现，原样保留）：
 * - 位数门槛 6 位（真实 ID 是 9–10 位；4 位常是年份/型号，如 `型号ID2024`）；
 * - 名字里有多个 ID 段时取**最右**一个；
 * - 候选来自两条正则：MID（`…ID_1166965084_resize` 这类 ID 后面还有后缀的，
 *   只有 MID 能穿透）与 TAIL（ID 顶在末尾的绝大多数），最终取**起始位置更右**的那个。
 */
function idMarkerIdOf(s: string): string | null {
  /** 从匹配片段里抠出纯数字 ID（片段形如 `_ID_1166965084`） */
  const digitsOf = (fragment: string): string | null => /\d{6,}/.exec(fragment)?.[0] ?? null

  // ① MID：`matchAll` 取最后一个（`…ID_1166965084_resize` 只有 MID 能命中）
  let mid: { digits: string; at: number } | null = null
  ZHIMO_ID_MID_RE.lastIndex = 0
  for (const m of s.matchAll(ZHIMO_ID_MID_RE)) {
    const digits = digitsOf(m[0])
    if (digits) mid = { digits, at: m.index ?? 0 }
  }
  ZHIMO_ID_MID_RE.lastIndex = 0

  // ② TAIL：ID 顶在名字末尾（绝大多数）
  const tailMatch = ZHIMO_ID_TAIL_RE.exec(s)
  const tailDigits = tailMatch ? digitsOf(tailMatch[0]) : null
  const tail: { digits: string; at: number } | null =
    tailMatch && tailDigits ? { digits: tailDigits, at: tailMatch.index } : null

  // ③ 两个候选里取**最右**的那个：`椅子ID_1111111_版本ID_2222222` 的 TAIL 在更右边
  //    （tail 的 ID 在末尾，没有 lookahead 字符，MID 永远匹配不到它），
  //    只按"先 MID 后 TAIL"返回会错拿左边那个 ID。
  if (mid && tail) return tail.at >= mid.at ? tail.digits : mid.digits
  return mid?.digits ?? tail?.digits ?? null
}

/**
 * 只接受 ① `ID` 标记 / ② `znzmo` 前缀的**强证据**版本（无裸数字兜底）。
 *
 * 只用在「包内文件相对路径」这一来源上：纹理/材质的文件名里本来就常有 9–10 位序号
 * （`marble_123456789.jpg`），把裸数字当 ID 会把两套**不同**的贴图包算成同一个商品，
 * 进而被并进同一组「重复副本」—— 那正是本轮要消灭的误删风险。
 * 压缩包名 / 资产名则允许裸数字（用户明确要求「有一些文件不含 ID 前缀，但后面有一串数字」）。
 */
function strongZhimoIdOf(text: string): string | null {
  const s = String(text ?? '').trim()
  if (!s) return null
  return idMarkerIdOf(s) ?? rightmostMatch(ZNZMO_ID_RE, s)
}

/**
 * 三个来源按**可信度降序**取第一个能解析出的知末 ID（导入 / 重扫 / 老库回填共用）。
 *
 * 为什么压缩包名排第一（用户 2026-10 明确要求）：知末的包**目录名可能完全没有 ID**，
 * 实测解包后是 `attachment_1786942463670\现代壁灯\现代壁灯.skp`，
 * ID `1232108421` 只存在于压缩包名 `现代壁灯ID_1232108421.rar` 上；
 * 而包名一旦被处置（回收站/删除）就永久丢失，所以必须在**导入那一刻**就算出来落库。
 *
 * 顺序：
 * ① `archiveName` —— 源压缩包 / 源图片文件名（含扩展名也可以，内部按文本解析）；
 * ② `assetName` —— 最终资产名（`uniqueName` 之后的 `finalName`）；
 * ③ `fileNames` —— 包内文件相对路径，取**第一个**能解析出的
 *    （`znzmo-1180221079-1.skp` 那类只知道包内文件名的场景）。
 *    ⚠️ 第三档只认 `ID` 标记 / `znzmo` 前缀两种**强证据**（见 `strongZhimoIdOf`），
 *    不认裸数字 —— 贴图文件名里的 9–10 位序号不足以证明是知末商品。
 *
 * 纯函数、绝不抛错；三处都解析不出 → `null`（= 未识别，调用方不要写库）。
 */
export function zhimoIdFromSources(
  archiveName: string | null | undefined,
  assetName: string | null | undefined,
  fileNames: readonly (string | null | undefined)[] | null | undefined
): string | null {
  const fromArchive = zhimoIdFromText(String(archiveName ?? ''))
  if (fromArchive) return fromArchive

  const fromAsset = zhimoIdFromText(String(assetName ?? ''))
  if (fromAsset) return fromAsset

  for (const name of fileNames ?? []) {
    const id = strongZhimoIdOf(String(name ?? ''))
    if (id) return id
  }
  return null
}

export interface TopLevelEntry {
  name: string
  isDir: boolean
}

/** 压缩包扩展名（pickAssetName 防御性去扩展名用，幂等） */
const ARCHIVE_EXT_RE = /\.(zip|rar|7z|tar|gz|tgz)$/i

/**
 * 决定资产名：
 * - 压缩包内只有一个顶层文件夹 → 用文件夹名（常见于知末/3d66 的包）
 * - 否则用压缩包文件名（去扩展名）
 *
 * 契约：调用方应传已去扩展名的 base；此处再做一次防御性去扩展名（幂等，不破坏既有用例）。
 */
export function pickAssetName(archiveBase: string, topLevel: TopLevelEntry[]): string {
  const dirs = topLevel.filter((t) => t.isDir)
  if (topLevel.length === 1 && dirs.length === 1) {
    return sanitizeName(stripNoise(dirs[0].name))
  }
  return sanitizeName(stripNoise(archiveBase.replace(ARCHIVE_EXT_RE, '')))
}

/** 防重名：已存在则依次追加 -2、-3… */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/**
 * `uniqueName()` 自动追加的序号后缀：`-2`、`-3`…`-999`。
 *
 * ⚠️ 只认 **2–999** 的数值后缀（`uniqueName` 从 2 起编号）：
 * - `椅子-2` / `椅子-17` / `椅子-108` → 剥成 `椅子`；
 * - `椅子-1`（用户手工命名）/ `型号-2024`（4 位数，真实名字）→ **原样保留**。
 * 这样既能让 rescan 从磁盘目录名反推出原始资产名，又不会误伤真实带数字的名字。
 */
const AUTO_SUFFIX_RE = /-(\d{1,3})$/

/** 自动序号后缀的数值范围（与 `uniqueName` 的编号一致） */
const AUTO_SUFFIX_MIN = 2
const AUTO_SUFFIX_MAX = 999

/**
 * 剥掉 `uniqueName()` 自动追加的尾部 `-<n>` 序号，得到**原始资产名**。
 *
 * 用途（v0.4 重复检测的两处）：① rescan 从磁盘目录名反推 dedupeKey；
 * ② Dexie v4 迁移重算历史记录的 dedupeKey。**只此一份实现**，两处共用，
 * 避免正则漂移（两套规则迟早不一致）。
 *
 * 幂等：`baseNameOf(baseNameOf('椅子-2')) === '椅子'`。
 */
export function baseNameOf(name: string): string {
  const s = String(name ?? '').trim()
  const m = AUTO_SUFFIX_RE.exec(s)
  if (!m) return s
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < AUTO_SUFFIX_MIN || n > AUTO_SUFFIX_MAX) return s
  const base = s.slice(0, m.index).trim()
  // 只剩 '-' 的畸形名字（如 '-2'）不剥，避免产出空名
  return base || s
}

/**
 * 重复检测键：忽略大小写与空格/连字符差异。
 *
 * ⚠️ 调用方传的必须是**原始资产名**（`uniqueName()` 之前），需要从最终名反推时
 * 先过 `baseNameOf()`；传最终名（带 `-2`）会让重复永远检测不出来（v0.4 缺陷）。
 */
export function dedupeKeyOf(name: string, kind: string): string {
  return `${kind}:${name.toLowerCase().replace(/[\s_\-()（）]+/g, '')}`
}

// ── T06 分类段校验（docs/06 v1.0.2 §9.2 / §9.3） ────────────────────

/** 单段目录名上限，防 MAX_PATH（06 §12.3 RA2） */
export const MAX_SEGMENT_LEN = 40

/** 是否"没给值"（null / undefined / 清洗后为空） */
function isEmptyish(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true
  const s = String(v)
  return s.trim() === '' || ONLY_PLACEHOLDER_RE.test(s.trim())
}

/**
 * 单段净化（06 §9.2 规则 1/2/5）：
 * ① trim + Windows 非法字符清洗（`/` → `_`，恰好保证单段）
 * ② 清洗后为空 → 返回 `''`（由调用方落成哨兵）
 * ③ 哨兵幂等（含前后空白差异）
 * ④ 超长按**码点**截断（`Array.from`，不能 `slice`——会割开 emoji 代理对）
 */
function cleanSegment(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return ''
  let s = String(raw).replace(ILLEGAL_RE, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  if (!s || ONLY_PLACEHOLDER_RE.test(s)) return ''
  if (s === UNCLASSIFIED) return UNCLASSIFIED // 哨兵幂等：语义 = "清除该级分类"
  const chars = Array.from(s)
  if (chars.length > MAX_SEGMENT_LEN) {
    s = chars.slice(0, MAX_SEGMENT_LEN).join('')
    warnSegmentTruncated(s)
  }
  return s
}

/** 长度截断只告警一次，避免批量导入刷屏 */
let segmentWarned = false
function warnSegmentTruncated(s: string): void {
  if (segmentWarned) return
  segmentWarned = true
  console.warn(`[idbox] 分类段超过 ${MAX_SEGMENT_LEN} 字，已按码点截断：${s}…`)
}

export interface CategoryPair {
  category1: string
  category2: string
  changed: boolean
}

/**
 * 分类对校验与降级（06 §9.2，六条规则）。
 *
 * **级联一致性**：合法状态空间 = (已知一级, 已知二级|未分类) ∪ (未分类, 未分类)；
 * `(未分类, 已知二级)` 是非法态 → 强制降级为 `(未分类, 未分类)`（不抛错）。
 *
 * **词表放行**（规则 4）：未知一级、或二级不在 `LEVEL2_MAP[一级]` 内 —— **放行**。
 * `家具/客厅` 这类"值在词表但属于另一一级"的组合同样**保留**：磁盘是唯一真相，
 * 降级会让用户找不到自己手工建的目录；其"非法性"由 UI 实时计算展示，不做持久化。
 *
 * **changed 标记**（规则 6，v1.0.3 正式化）：`changed = true` ⇔ 存在一级或二级，
 * 其「**非空且非哨兵**的原始输入」与归一化输出不一致。两种情况**不算** changed：
 * ① 空/缺失输入落位为 `未分类`（默认落位，不是改写）
 * ② 输入「未分类」（含前后空白）输出 `未分类`（幂等）
 * 用途：调用方**仅在 changed=true 时**提示用户，避免每次指派都弹提示。
 */
export function normalizeCategoryPair(
  raw1: string | null | undefined,
  raw2: string | null | undefined
): CategoryPair {
  const c1 = cleanSegment(raw1) || UNCLASSIFIED
  let c2 = cleanSegment(raw2) || UNCLASSIFIED
  // 规则 3：级联一致性 —— 未指派一级 ⇒ 二级必须也是未分类
  if (c1 === UNCLASSIFIED && c2 !== UNCLASSIFIED) c2 = UNCLASSIFIED

  const norm1 = raw1 === null || raw1 === undefined ? '' : String(raw1).trim()
  const norm2 = raw2 === null || raw2 === undefined ? '' : String(raw2).trim()
  // 只对"用户显式给了值"的那一级比较改写
  const changed =
    (!isEmptyish(raw1) && c1 !== norm1) || (!isEmptyish(raw2) && c2 !== norm2)

  return { category1: c1, category2: c2, changed }
}

/**
 * 分类段净化（DEF-14）：词表里有含 `/` 的词条（「椅子/凳子」「灯膜/灯罩」等），
 * 原样落盘会变成五段路径、破坏固定四层契约（rescan 回读时资产名/分类错乱）。
 * 分隔符替换为 `_`（「椅子/凳子」→「椅子_凳子」，语义保留、单段合法）。
 */
function sanitizeCategorySegment(seg: string): string {
  return seg.replace(/[\\/]+/g, '_')
}

/** 落盘四段组合（06 §9.3）：`<大类>/<一级分类>/<二级分类>/<资产名>` */
export function composeRelFolder(
  kindFolderName: string,
  category1: string,
  category2: string,
  name: string
): string {
  return `${kindFolderName}/${sanitizeCategorySegment(category1)}/${sanitizeCategorySegment(category2)}/${name}`
}
