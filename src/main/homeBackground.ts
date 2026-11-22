/**
 * 首页自定义背景图：本地文件复制 / URL 下载 + sha256 单槽位缓存 + 清理（docs/55 §2.1.4）。
 *
 * 设计要点（逐条对应 Q-5 / Q-6 / R-11 / S-6）：
 * - **运行期零网络**：渲染层只读 `bg://<fileName>`（缓存文件）；本模块只在新「设置
 *   背景」/「刷新 URL」时由用户主动触发一次下载，断网时缓存文件仍在 → 图片照常显示；
 * - **只存文件名不存绝对路径**：路径是非稳定契约（换机器 / 换库目录即失效），
 *   Settings 里只落 `<sha256>.<ext>`，字节落在 `<userData>/home-bg/`；
 * - **失败不写 settings**：任何校验 / 下载 / 落盘失败都返回 `{ ok:false, error }`，
 *   渲染层据此保留旧图并给用户可读中文原因，绝不把坏 `fileName` 写进设置；
 * - **单槽位**：`clearHomeBackground()` 在替换 / 移除时删旧文件，缓存目录不随时间膨胀。
 *
 * 纪律：零新增依赖；`net.fetch` 是 Electron 内置（protocol.ts 已在用）；纯 fs 操作全部
 * 可失败且有兜底，绝不让一次坏图把主进程带崩。
 */
import { app, net } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { HomeBackgroundSaveInput, HomeBackgroundSaveResult } from '../shared/ipc'

/** URL 图片大小上限（docs/55 §3-G：≤20 MB，防止大图拖垮启动 / 包体）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 缓存目录名（挂在 `userData` 下，绝不进用户库目录）。 */
const CACHE_DIR_NAME = 'home-bg'

/** 允许落盘的扩展名白名单（防 content-type 伪造 + 保证 `bg://` 能被 Chromium 解码）。 */
const ALLOWED_EXTS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'ico'
])

/** content-type → 扩展名（下载响应是权威；嗅探失败时用它兜底）。 */
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
}

/**
 * 缓存目录 `<userData>/home-bg/`（懒创建，调用时 `app.getPath` 已可用）。
 *
 * 与 `hdrCacheDir()` 同构：缓存可随时整体删掉（下次设置背景重新下载 / 复制）。
 */
export function backgroundCacheDir(): string {
  return path.join(app.getPath('userData'), CACHE_DIR_NAME)
}

/** 统一的失败返回构造（中文原因，渲染层可直接展示）。 */
function fail(error: string): HomeBackgroundSaveResult {
  return { ok: false, error }
}

/**
 * 魔数嗅探图片真实格式。
 *
 * 为什么需要它：`bg://` 通过 file:// 透传，Chromium 按**扩展名**推断 MIME。若把 JPEG
 * 字节存成 `.png`，CSS 背景会静默失败（首页白屏一块）。content-type 是服务器声明、
 * 可能是 `application/octet-stream`，所以以字节魔数为第一权威。
 */
function sniffImageExt(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return null
}

/** 从 content-type 取扩展名（去掉 `; charset=...` 之类参数）。 */
function extFromContentType(contentType: string): string | null {
  const main = contentType.split(';')[0].trim().toLowerCase()
  return MIME_TO_EXT[main] ?? null
}

/** 从文件名取扩展名（仅在白名单内才认）。 */
function extFromFileName(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase()
  return ALLOWED_EXTS.has(ext) ? ext : null
}

/**
 * 有上限地读完响应体：先信 `content-length`，再按实际字节数兜底（服务端谎报也要挡住）。
 *
 * @throws 内容为空 / 超限 / 流异常，统一由调用方转成中文 error
 */
async function readLimitedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 20 MB 上限')
  }
  if (!response.body) throw new Error('下载响应没有内容')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('图片超过 20 MB 上限')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new Error('图片内容为空')
  return Buffer.concat(chunks, total)
}

/**
 * 把一张图片的字节写进缓存，返回稳定文件名 `<sha256>.<ext>`。
 *
 * `overwrite = true`：同一 URL 的「刷新」允许覆盖旧字节；本地复制则遇同名即复用
 * （内容 hash 相同 = 字节相同，无需重写）。
 */
async function writeToCache(
  bytes: Buffer,
  hash: string,
  ext: string,
  overwrite: boolean
): Promise<string> {
  const dir = backgroundCacheDir()
  await fs.mkdir(dir, { recursive: true })
  const fileName = `${hash}.${ext}`
  const abs = path.join(dir, fileName)
  if (!overwrite) {
    try {
      await fs.access(abs)
      return fileName
    } catch {
      // 不存在 → 下面正常写
    }
  }
  await fs.writeFile(abs, bytes)
  return fileName
}

/** 保存背景图：本地文件复制或 URL 下载，成功返回缓存文件名，失败返回中文原因。 */
export async function saveHomeBackground(
  input: HomeBackgroundSaveInput
): Promise<HomeBackgroundSaveResult> {
  if (!input || (input.kind !== 'local' && input.kind !== 'url')) {
    return fail('背景图参数不合法')
  }

  if (input.kind === 'local') {
    const filePath = input.filePath
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return fail('没有选择图片文件')
    }
    let bytes: Buffer
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return fail('选择的不是图片文件')
      if (stat.size > MAX_IMAGE_BYTES) return fail('图片超过 20 MB 上限')
      if (stat.size === 0) return fail('图片文件是空的')
      bytes = await fs.readFile(filePath)
    } catch {
      return fail('读取图片失败，请确认文件仍存在')
    }
    if (bytes.length > MAX_IMAGE_BYTES) return fail('图片超过 20 MB 上限')
    const ext = sniffImageExt(bytes) ?? extFromFileName(filePath)
    if (!ext || !ALLOWED_EXTS.has(ext)) return fail('不支持的图片格式（请选 JPG / PNG / WebP / GIF / BMP 等常见格式）')
    const hash = createHash('sha256').update(bytes).digest('hex')
    try {
      const fileName = await writeToCache(bytes, hash, ext, false)
      return { ok: true, fileName }
    } catch {
      return fail('保存背景图失败，请稍后重试')
    }
  }

  const url = input.url
  if (typeof url !== 'string' || url.trim().length === 0) return fail('请输入图片地址')
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return fail('图片地址不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('只支持 http / https 图片地址')
  }
  let bytes: Buffer
  let contentType = ''
  try {
    const response = await net.fetch(parsed.href, { headers: { Accept: 'image/*' } })
    if (!response.ok) return fail(`下载图片失败（HTTP ${response.status}）`)
    contentType = response.headers.get('content-type') ?? ''
    const mainType = contentType.split(';')[0].trim().toLowerCase()
    if (!mainType.startsWith('image/')) {
      return fail('该链接返回的不是图片，请换一个图片地址')
    }
    bytes = await readLimitedBody(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return fail(message || '下载图片失败，请检查网络或图片地址')
  }
  const ext =
    sniffImageExt(bytes) ?? extFromContentType(contentType) ?? extFromFileName(parsed.pathname)
  if (!ext || !ALLOWED_EXTS.has(ext)) return fail('不支持的图片格式')
  // URL 的 hash 取 URL 本身：同一地址稳定命中同一槽位，重复设置免重新下载命名漂移。
  const hash = createHash('sha256').update(parsed.href).digest('hex')
  try {
    const fileName = await writeToCache(bytes, hash, ext, true)
    return { ok: true, fileName }
  } catch {
    return fail('保存背景图失败，请稍后重试')
  }
}

/**
 * 清理一张缓存背景图（单槽位替换 / 移除时调用）。
 *
 * **越界守卫**：文件名必须是本模块产出的 `<64位sha256>.<ext>`，先 `path.basename` 再
 * 全等校验，杜绝恶意 `fileName` 借 IPC 删掉缓存目录外的文件。幂等：文件不存在也成功。
 * 永不抛错（清缓存失败不该影响「移除背景」的主流程）。
 */
export async function clearHomeBackground(fileName: string | null): Promise<void> {
  if (typeof fileName !== 'string' || fileName.length === 0) return
  if (path.basename(fileName) !== fileName) return
  if (!/^[0-9a-f]{64}\.[a-z0-9]{2,5}$/i.test(fileName)) return
  try {
    await fs.unlink(path.join(backgroundCacheDir(), fileName))
  } catch {
    // 幂等：文件不存在 / 正被占用都当成功，下次启动可整体清缓存兜底
  }
}
