/**
 * 缩略图的**纯计算**部分（T04）——不 import electron / node:*，可在 vitest 里直接单测。
 *
 * IO 部分（nativeImage / 写文件）在 `src/main/thumb.ts`，这里只负责：
 * 文件名怎么拼、salt 怎么算、缩放到多大、哪些是孤儿缓存。
 */

/** 缩略图最长边默认像素（PRD P0-9：≤480px） */
export const DEFAULT_THUMB_MAX_PX = 480

/**
 * 「预览图」的最长边像素上限（docs/26 方案 C + H：拖拽卡片改用 ≤1024 预生成预览图）。
 *
 * 为什么要单独一档，而不是把 480 调大：
 * - 480 是**网格卡片**的口径（数量多、只读、要求小）；
 * - 拖拽卡片是 176×176 逻辑像素，但要跟随系统缩放 / 高 DPI（`dpr ≤ 2`），
 *   而且用户会把它拖进 DCC 里放大看 —— 480 在 2x 屏上只有 240 逻辑像素，明显糊；
 * - 1024 的 JPEG 大约 100~300KB，解码成本比 8K 原图（几十 MB、8192²）低两个数量级。
 * 因此预览图是**独立的一档缓存**（文件名带 `-p1024`），与 480 缩略图并存、互不覆盖。
 */
export const PREVIEW_MAX_PX = 1024

/**
 * 预览图文件名的后缀（紧跟 salt，插在扩展名之前）：`<id>-<salt>-p1024.jpg`。
 *
 * 为什么用后缀而不是另一个目录：`vault://thumb/<name>` 已经能读 `thumbsDir` 里的
 * 任何文件（见 `main/protocol.ts`），同目录只差文件名 → 零协议改动、零新目录、
 * 清理逻辑（`deleteThumb` / `pruneThumbs` / `clearThumbs`）天然覆盖。
 */
export const PREVIEW_SUFFIX = '-p1024'

/** JPEG 输出质量 */
export const THUMB_JPEG_QUALITY = 82

/** salt 长度（十六进制字符数） */
export const THUMB_SALT_LEN = 8

/** 缩略图可能的扩展名（deleteThumb 通配用） */
export const THUMB_EXTS = ['jpg', 'png'] as const

/** 带透明通道、必须输出 PNG 的源格式（知末贴图素材有透明 PNG，转 JPEG 会糊成黑底） */
const ALPHA_SOURCE_EXTS = new Set(['png', 'webp'])

/** FNV-1a 32bit：短哈希，够用且零依赖（不需要 node:crypto） */
export function thumbSalt(input: string, len: number = THUMB_SALT_LEN): string {
  let h = 0x811c9dc5
  const s = input ?? ''
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, len)
}

/**
 * 源文件的**最小 stat 视图**（只取参与 salt 的两个字段）。
 *
 * 用鸭子类型而不是 `import('node:fs').Stats`：本文件是 shared 层，
 * 不 import `node:*`，vitest 里任何平台都能直接构造。
 */
export interface ThumbSourceStat {
  mtimeMs: number
  size: number
}

/**
 * 源文件的**内容身份串**：`<绝对路径>:<mtime 整数毫秒>:<字节数>`。
 *
 * 为什么不能只用路径（2026-10 用户报的 bug「HDR 预览拍照后主界面不刷新，重启才变」）：
 * 「拍照」每次都写回**同一个** `<资产名>.cover.png`，路径一个字都没变 → 旧实现
 * `thumbSalt(coverAbs)` 算出的 salt 恒定 → 缩略图缓存文件名恒定 → 渲染层的
 * `vault://thumb/<同名>` URL 也恒定 → Chromium 直接命中磁盘缓存里的旧字节。
 * 把 mtime + size 并进 salt 输入后，「内容变了」必然推出「文件名变了」→ URL 变了
 * → 缓存自然失效。`size` 与 `mtime` 一起用是为了防止极端情况下时间戳分辨率不足
 * （例如某些网络盘 / FAT 的 2 秒粒度）导致「内容变了但 mtime 相同」。
 *
 * **确定性**（RA3 的硬要求，`store.ts` 的 `regenThumbSweep()` 依赖它）：
 * 同一路径的同一份文件，任意次 `fs.stat` 得到的 `mtimeMs` / `size` 完全相同，
 * 因此本函数在两次调用之间只要文件没被改写，返回的串**逐字符相同**
 * → `thumbFileName` 得到同一个文件名（第二次调用能补回第一次被通配删掉的缓存）。
 * 只对 `mtimeMs` 取整（`Math.round`）是必要的：`mtimeMs` 可能是浮点数
 * （如 `1699999999999.1234`），取整后仍是同一文件的稳定常量，且能跨平台稳定落到
 * 同一个串上（不影响"变了就不同"的判定，秒级差异远大于 1ms）。
 */
export function thumbSaltSource(coverAbs: string, stat: ThumbSourceStat): string {
  const abs = coverAbs ?? ''
  const mtime = Number.isFinite(stat?.mtimeMs) ? Math.round(stat.mtimeMs) : 0
  const size = Number.isFinite(stat?.size) ? Math.round(stat.size) : 0
  return `${abs}:${mtime}:${size}`
}

/**
 * 源文件 → 缩略图 salt（`thumbSalt` over {@link thumbSaltSource}）。
 *
 * 调用方（`main/thumb.ts` 的 `ensureThumb`）已经 `fs.stat` 过一次，直接复用 `st`，
 * 不额外多一次磁盘 IO。**纯函数**：同一 (路径, mtime, size) 恒得同一 salt。
 */
export function thumbFileSalt(coverAbs: string, stat: ThumbSourceStat): string {
  return thumbSalt(thumbSaltSource(coverAbs, stat))
}

/** 源扩展名 → 输出格式：有透明通道的走 PNG，其余走 JPEG */
export function thumbOutputExt(sourceExt: string): 'jpg' | 'png' {
  return ALPHA_SOURCE_EXTS.has(sourceExt.toLowerCase().replace(/^\./, '')) ? 'png' : 'jpg'
}

/** `<id>-<salt>.<ext>`，如 `a1b2c3d4-…-9f3c-1a2b3c4d.jpg` */
export function thumbFileName(id: string, salt: string, ext: 'jpg' | 'png'): string {
  return `${id}-${salt}.${ext}`
}

/**
 * `<id>-<salt>-p1024.<ext>`，如 `a1b2c3d4-…-9f3c-p1024.jpg`（≤1024 预览图）。
 *
 * 与 {@link thumbFileName} 的差别只有中间那段后缀，好处：
 * ① 同一资产的 480 缩略图与 1024 预览图**文件名不同**，不会互相覆盖；
 * ② 老的 `<id>-<salt>.<ext>` 解析结果**一字不变**（后缀是新增语法，旧名不可能带）；
 * ③ `p` 不是十六进制，所以旧正则不可能把 `-p1024` 吃进 salt —— 新名字只在
 *    「以前解析不了」的输入上生效，不存在旧文件被重新解释。
 */
export function previewFileName(id: string, salt: string, ext: 'jpg' | 'png'): string {
  return `${id}-${salt}${PREVIEW_SUFFIX}.${ext}`
}

export interface ParsedThumbName {
  id: string
  salt: string
  ext: string
  /**
   * 是否是 ≤1024 的**预览图**（文件名带 {@link PREVIEW_SUFFIX}）。
   *
   * ⚠️ **只有为真时才出现这个键**（类型是 `true` 不是 `boolean`）：
   * 旧格式的解析结果必须与改造前**逐字段相同**——多一个 `preview: false`
   * 就会让既有调用方的 `toEqual({id, salt, ext})` 与快照全部失败。
   * 判假统一用 `parsed.preview === true` / `'preview' in parsed`。
   */
  preview?: true
}

/**
 * 解析缩略图文件名（**同时认 480 缩略图与 1024 预览图**）。
 *
 * id 是 UUID（本身含 `-`），所以 salt 取**最后一个** `-` 之后、`.` 之前的十六进制串；
 * 预览图在此基础上多一段 `-p1024`（大小写不敏感，解析后归一化为 `preview: true`）。
 *
 * 兼容性（有守卫级单测，别改）：旧格式 `<id>-<salt>.<ext>` 的返回值**逐字段不变**
 * —— `{id, salt, ext}` 三个键，且**没有** `preview` 键。
 * 另外 `-p1024` 不可能被旧正则当成 salt（`p` 不是十六进制），
 * 所以「以前解析不了的名字」才会被新语法认领，不存在旧文件被重新解释。
 * 解析不了（不是缓存文件）返回 null。
 */
export function parseThumbFileName(name: string): ParsedThumbName | null {
  const m = /^(.+)-([0-9a-f]+)(-p1024)?\.(jpg|png)$/i.exec(name)
  if (!m) return null
  const parsed: ParsedThumbName = {
    id: m[1]!,
    salt: m[2]!.toLowerCase(),
    ext: m[4]!.toLowerCase()
  }
  // 关键：只有真预览才加键（见 ParsedThumbName.preview 的注释）
  if (m[3]) parsed.preview = true
  return parsed
}

/** 是否是 ≤1024 的预览图文件（解析失败 / 旧 480 缩略图都返回 false） */
export function isPreviewThumbName(name: string): boolean {
  return parseThumbFileName(name)?.preview === true
}

/**
 * 等比缩放到长边 ≤ maxPx。
 * 约定：① 不放大（原图更小就原样返回）；② 结果必须 `Math.round` 且 **≥1**
 * （宽度 0 会让 Electron 崩或产出空图）。
 */
export function resizeToMaxPx(
  w: number,
  h: number,
  maxPx: number = DEFAULT_THUMB_MAX_PX
): { width: number; height: number } {
  const max = Number.isFinite(maxPx) && maxPx > 0 ? Math.floor(maxPx) : DEFAULT_THUMB_MAX_PX
  const sw = Number.isFinite(w) && w > 0 ? w : 1
  const sh = Number.isFinite(h) && h > 0 ? h : 1
  const longest = Math.max(sw, sh)
  if (longest <= max) return { width: Math.round(sw), height: Math.round(sh) }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale))
  }
}

/**
 * 文件名是否属于某个 id 的缩略图（salt 会变，必须通配匹配）。
 *
 * **包括 ≤1024 预览图**（`<id>-<salt>-p1024.jpg`）：它们与缩略图同 id，
 * 因此 `deleteThumb(id)` 换封面时的通配删除、`pruneThumbs` 的 live 判定
 * 都会自动算上它们，不需要第二套白名单。
 */
export function isThumbOf(name: string, id: string): boolean {
  const p = parseThumbFileName(name)
  return p !== null && p.id === id
}

/** 从目录列表里挑出某个 id 的全部缓存文件（480 缩略图 + 1024 预览图） */
export function matchThumbNames(names: string[], id: string): string[] {
  return names.filter((n) => isThumbOf(n, id))
}

/**
 * 孤儿判定：目录里存在、但 id 已不在 liveIds 中的缓存文件
 * （480 缩略图与 1024 预览图一视同仁：id 还在 → 不是孤儿，绝不误删）。
 */
export function findOrphanThumbs(names: string[], liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds)
  return names.filter((n) => {
    const p = parseThumbFileName(n)
    return p !== null && !live.has(p.id)
  })
}
