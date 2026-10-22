import fs from 'node:fs/promises'
import path from 'node:path'
import { thumbsDir } from './paths'
import { ballThumbName, normalizeParams, type BallParamScales } from '../shared/ballParams'
import { isWithinRoot } from '../shared/vault'
import type { BallRenderShape, BallSlots } from '../shared/types'

/**
 * 材质球离屏渲染图的落盘（2026-10，任务 6）——**不 import electron，可单测**
 * （唯一触达 electron 的是 `thumbsDir()`，由 `paths.ts` 提供，测试可注入/绕开）。
 *
 * 形态（用户拍板，docs/10 §1.4）：
 * - **网格不开 WebGL**：读 `vault://thumb/<id>-<槽位hash>.png`（渲染进程离屏渲一帧存出来的
 *   **透明 PNG**）；
 * - 详情面板才开实时球（绕开 Chromium WebGL 上下文 8-16 上限）。
 *
 * 为什么是 PNG：球图必须透明（卡片 `bg-canvas` 透出来），JPEG 无 alpha 通道只能把
 * 背景色烤进像素 → 浅色主题渲过的图在深色主题下就是一块亮白方块。透明 PNG 让
 * 缓存与主题彻底解耦（不需要按主题分目录，也不需要切主题时重渲）。
 *
 * 文件名由 `shared/ballParams.ts` 的 `ballThumbName(assetId, slots, params)` 算出
 * （FNV-1a over 槽位 rel 集合 + 非默认参数串），与既有缩略图
 * `<id>-<8位hex>.<ext>` **完全同格式**——因此
 * `parseThumbFileName / isThumbOf / deleteThumb / pruneThumbs / thumbStats`
 * 对球图原样生效，缓存管理零额外成本。
 *
 * 2026-10 调参持久化（docs/12 §1.3）：本文件此前 `import ... from '../renderer/logic'`
 * ——main 反向依赖 renderer，属层向违规。hash 实现移到 shared 后改 import shared，
 * 违规消除，且保证**主进程与渲染进程算出同一个 hash**（这是缓存正确性的前提）。
 */

/** 单张球图（PNG 字节）的大小上限（5MB；480px 透明 PNG 实测远小于此，几千字节量级） */
export const MAX_BALL_IMAGE_BYTES = 5 * 1024 * 1024

/** base64 文本长度上限（字节数 × 4/3，向上取整）——先看字符串长度再 decode，省一次大对象分配 */
export const MAX_BALL_IMAGE_BASE64_LEN = Math.ceil((MAX_BALL_IMAGE_BYTES * 4) / 3)

/**
 * 纯函数：缓存文件名（委托给 `shared/ballParams.ts` 的同名纯函数）。
 *
 * `params` 可选：不传 / 传默认值（1,1,1）→ 参数不贡献 hash（方案 B），
 * 与既有磁盘缓存的名字完全一致；只有真调过参的才会算出不同的名字。
 *
 * `shape` 可选：不传 / `'sphere'` → 形态不贡献 hash（与存量球图同名）；
 * 只有 plane / roundedBox 才换名。**必须与渲染层同口径**，所以这里只是转发，
 * 绝不再拼一遍字符串（主进程复制 hash 逻辑是历史 bug 的来源）。
 */
export function ballThumbFileName(
  assetId: string,
  slots: BallSlots,
  params?: BallParamScales,
  shape?: BallRenderShape
): string {
  return ballThumbName(assetId, slots, params, shape)
}

/** 纯函数：assetId 是否合法（非空、不含路径分隔符，防止被用来拼出越界文件名） */
export function isValidBallAssetId(id: string): boolean {
  if (typeof id !== 'string') return false
  const v = id.trim()
  if (v.length === 0 || v.length > 128) return false
  return !/[/\\:*?"<>|]/.test(v)
}

/** 纯函数：base64 文本预检（空 / 超长直接拒，不 decode） */
export function validateBallImageBase64(b64: string): boolean {
  if (typeof b64 !== 'string') return false
  return b64.length > 0 && b64.length <= MAX_BALL_IMAGE_BASE64_LEN
}

/**
 * 把渲染好的 PNG 写进 thumbs 目录，返回缓存文件名；任何一步不合法/失败返回 null。
 *
 * 安全：文件名由 `ballThumbName` 决定（`assetId` 已校验为单段、无分隔符），
 * 落点强制 `path.resolve` 后再用 `isWithinRoot` 校验在 thumbs 目录内——
 * 防渲染层被注入时写到任意路径。
 */
export async function saveBallThumbBytes(
  assetId: string,
  slots: BallSlots,
  bytes: Buffer,
  /** 落盘根目录，**注入式**（默认 thumb 缓存目录；单测传 tmp 目录即可绕开 electron）。
   *  ⚠️ 位置保持第 4 参不变：既有单测 `saveBallThumbBytes(ID, SLOTS, bytes, dir)`
   *  是 4 参调用，把 params 插在它前面会把目录当参数用（既有断言不得改，docs/12 §6.1）。 */
  thumbsRoot: string = thumbsDir(),
  /** 调参倍率（docs/12 §3.4）；参与 hash 前必须 `normalizeParams` —— 与渲染进程同一口径 */
  params?: BallParamScales,
  /**
   * 几何形态（第 6 参，**只在非球面时**参与 hash）。
   *
   * 加在末尾是为了不动既有 4/5 参调用（`saveBallThumbBytes(ID, SLOTS, bytes, dir)`）。
   * 与 `params` 同理：必须由**渲染层传来实际渲的那一个**，主进程不猜 ——
   * 猜错就是"渲染结果与文件名不符"，下次启动仍判过期、无限重渲。
   */
  shape?: BallRenderShape
): Promise<string | null> {
  if (!isValidBallAssetId(assetId)) return null
  if (!bytes || bytes.length === 0 || bytes.length > MAX_BALL_IMAGE_BYTES) return null

  const dir = path.resolve(thumbsRoot)
  const name = ballThumbFileName(assetId.trim(), slots ?? {}, normalizeParams(params), shape)
  const abs = path.resolve(path.join(dir, name))
  if (!isWithinRoot(dir, abs, path.sep)) return null

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(abs, bytes)
    return name
  } catch {
    return null
  }
}
