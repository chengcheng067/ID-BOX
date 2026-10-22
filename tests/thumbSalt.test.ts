/**
 * 缩略图 salt 的**内容身份**回归测试（2026-10 用户反馈：
 * 「HDR 预览以后拍照以后，主界面不会立刻刷新，只有重启软件才会刷新」）。
 *
 * 缺陷链（旧实现）：
 * `<资产名>.cover.png` 被原地覆盖 → 路径不变 → `thumbSalt(coverAbs)` 不变 →
 * 缩略图缓存文件名不变 → `vault://thumb/<同名>` 不变 → Chromium 命中磁盘缓存里的旧字节。
 *
 * 修法：salt 输入从「路径」扩成「路径 + mtime + 字节数」（`thumbSaltSource`）。
 * 本文件锁死四件事：
 * ① **确定性**：同一文件连续两次 `ensureThumb` → 同一文件名（`regenThumbSweep()` 的
 *    「先生成 → 通配删 → 再生成补回」依赖它，否则第二次会算出另一个名字，磁盘上留空）；
 * ② **敏感性**：mtime 变了（内容/体积都不变）→ 文件名必须变（这正是本次修复的核心）；
 * ③ **优先级**：显式 `opts.salt` 仍然最高，不被 mtime/size 覆盖（材质球等自有命名空间）；
 * ④ **不积垃圾**：`deleteThumb(id)` 的通配删除能同时清掉新旧两种 salt 的文件。
 *
 * 环境说明（与 `tests/ballCache.test.ts` 同一套路）：`electron` 是 CJS，
 * 纯 node ESM 下 `import { nativeImage } from 'electron'` 会直接抛
 * `SyntaxError: Named export 'nativeImage' not found` → 必须整体 `vi.mock('electron')`，
 * 且 `app.getPath('userData')` 指向 tmp 目录（`main/thumb.ts` 的 `thumbsDir()` 靠它）。
 * 这里的 `nativeImage` 只是"能返回一张 100×100 图"的桩：被测的是**文件名计算**，
 * 不是像素内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { thumbFileSalt, thumbSaltSource } from '../src/shared/thumb'
import { vaultUrl } from '../src/shared/format'

// ── electron 桩（vi.mock 会被提升，桩里的 env 必须用 vi.hoisted 一起提升） ──
// ⚠️ 返回的是 **userData 根**，不是 thumbs 目录：`main/paths.ts` 的
// `thumbsDir()` = `path.join(userDataDir(), 'thumbs')`。
const env = vi.hoisted(() => ({ userDataRoot: '' }))
vi.mock('electron', () => {
  /** 一张"永远读得出来"的 100×100 假图（只有文件名计算会被断言） */
  const fakeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => fakeImage,
    toPNG: () => Buffer.from('fake-png'),
    toJPEG: () => Buffer.from('fake-jpeg')
  }
  return {
    nativeImage: { createFromPath: () => fakeImage },
    app: { getPath: () => env.userDataRoot }
  }
})

// 必须在 vi.mock 之后 import：`main/thumb.ts` 顶层就 import 了 electron
const { ensureThumb, deleteThumb, thumbsDir } = await import('../src/main/thumb')

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const OTHER_ID = 'ffffffff-0000-4000-8000-000000000000'

/** HDR 预览「拍照」写回的正是 `<资产名>.cover.png`（每次同一个路径） */
const COVER_NAME = '现代壁灯.cover.png'

let libDir = ''
let coverAbs = ''

/** 文件是否存在 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** 把 mtime 打到一个确定值（模拟「同一路径被重新写了一次」） */
async function setMtime(abs: string, ms: number): Promise<void> {
  const t = new Date(ms)
  await fs.utimes(abs, t, t)
}

beforeEach(async () => {
  env.userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-thumbsalt-'))
  libDir = path.join(env.userDataRoot, 'library', '模型', '现代壁灯')
  await fs.mkdir(libDir, { recursive: true })
  coverAbs = path.join(libDir, COVER_NAME)
  await fs.writeFile(coverAbs, Buffer.from('png-bytes-of-the-first-shot'))
})

afterEach(async () => {
  if (env.userDataRoot) await fs.rm(env.userDataRoot, { recursive: true, force: true }).catch(() => {})
  env.userDataRoot = ''
  libDir = ''
  coverAbs = ''
})

// ── ① 纯函数层：salt 输入串的构成 ────────────────────────────────
describe('thumbSaltSource / thumbFileSalt（纯函数）', () => {
  it('同一 (路径, mtime, size) → 逐字符相同的 salt 输入串', () => {
    const st = { mtimeMs: 1_700_000_000_123, size: 4096 }
    expect(thumbSaltSource('/lib/a.png', st)).toBe(thumbSaltSource('/lib/a.png', st))
    expect(thumbFileSalt('/lib/a.png', st)).toBe(thumbFileSalt('/lib/a.png', st))
  })

  it('mtime 变 → salt 变（内容与体积可以完全不变）', () => {
    const base = { mtimeMs: 1_700_000_000_123, size: 4096 }
    expect(thumbFileSalt('/lib/a.png', base)).not.toBe(
      thumbFileSalt('/lib/a.png', { ...base, mtimeMs: base.mtimeMs + 1 })
    )
  })

  it('size 变 → salt 变（兜住 mtime 分辨率不足的文件系统）', () => {
    const base = { mtimeMs: 1_700_000_000_123, size: 4096 }
    expect(thumbFileSalt('/lib/a.png', base)).not.toBe(
      thumbFileSalt('/lib/a.png', { ...base, size: 4097 })
    )
  })

  it('路径变 → salt 变（换封面的老行为不能退化）', () => {
    const st = { mtimeMs: 1_700_000_000_123, size: 4096 }
    expect(thumbFileSalt('/lib/a.png', st)).not.toBe(thumbFileSalt('/lib/b.png', st))
  })

  it('小数 mtime 取整后稳定（stat 的 mtimeMs 可能是浮点）', () => {
    const a = thumbSaltSource('/lib/a.png', { mtimeMs: 1_700_000_000_123.2, size: 10 })
    const b = thumbSaltSource('/lib/a.png', { mtimeMs: 1_700_000_000_123.4, size: 10 })
    expect(a).toBe(b)
    expect(a).toBe('/lib/a.png:1700000000123:10')
  })

  it('非法 stat 字段不产出 NaN', () => {
    const s = thumbSaltSource('/lib/a.png', { mtimeMs: Number.NaN, size: Number.NaN })
    expect(s).toBe('/lib/a.png:0:0')
  })
})

// ── ② ensureThumb：确定性 + 敏感性 ───────────────────────────────
describe('ensureThumb · salt 反映内容身份', () => {
  it('同一 coverAbs、文件未改写 → 连续两次调用得到**同一个**文件名（RA3 确定性）', async () => {
    const first = await ensureThumb(ID, coverAbs)
    const second = await ensureThumb(ID, coverAbs)

    expect(first).toBeTruthy()
    expect(second).toBe(first)
    // 第二次调用必须真的把文件补回磁盘（regenThumbSweep 的第 ③ 步）
    expect(await exists(path.join(thumbsDir(), second!))).toBe(true)
  })

  it('同一 coverAbs、只有 mtime 变了 → **不同**文件名（本次缺陷的核心断言）', async () => {
    await setMtime(coverAbs, 1_700_000_000_000)
    const before = await ensureThumb(ID, coverAbs)

    // 内容字节、体积、路径全都不变，只把 mtime 往后推（= 「拍照」原地覆盖的效果）
    await setMtime(coverAbs, 1_700_000_001_000)
    const after = await ensureThumb(ID, coverAbs)

    expect(before).toBeTruthy()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    // 新文件确实落盘，旧文件仍在（等 deleteThumb / pruneThumbs 收）
    expect(await exists(path.join(thumbsDir(), after!))).toBe(true)
    expect(await exists(path.join(thumbsDir(), before!))).toBe(true)
  })

  it('mtime 打回同一个值 → 文件名回到同一个（确定性不止"同一毫秒内"）', async () => {
    await setMtime(coverAbs, 1_700_000_000_000)
    const a = await ensureThumb(ID, coverAbs)
    await setMtime(coverAbs, 1_700_000_005_000)
    const b = await ensureThumb(ID, coverAbs)
    await setMtime(coverAbs, 1_700_000_000_000)
    const c = await ensureThumb(ID, coverAbs)

    expect(b).not.toBe(a)
    expect(c).toBe(a)
  })

  it('显式 opts.salt 优先级最高：不被 mtime/size 覆盖', async () => {
    const named = await ensureThumb(ID, coverAbs, { salt: 'deadbeef' })
    expect(named).toBe(`${ID}-deadbeef.png`)

    await setMtime(coverAbs, 1_700_000_009_000)
    const namedAgain = await ensureThumb(ID, coverAbs, { salt: 'deadbeef' })
    expect(namedAgain).toBe(named)
  })

  it('封面不存在 → null（降级契约不变）', async () => {
    expect(await ensureThumb(ID, path.join(libDir, 'nope.cover.png'))).toBeNull()
    expect(await ensureThumb(ID, null)).toBeNull()
  })
})

// ── ③ 详情面板原图 URL 的破缓存版本参数 ────────────────────────────
describe('vaultUrl · 版本参数（原地覆盖同一路径时的破缓存）', () => {
  it('不传版本 → 与旧行为逐字符一致（不动全局缓存策略）', () => {
    expect(vaultUrl('模型/某 沙发/a.png')).toBe(
      'vault://asset/%E6%A8%A1%E5%9E%8B/%E6%9F%90%20%E6%B2%99%E5%8F%91/a.png'
    )
    expect(vaultUrl('a/b.png', null)).toBe('vault://asset/a/b.png')
    expect(vaultUrl('a/b.png', '')).toBe('vault://asset/a/b.png')
  })

  it('传版本 → 追加 ?v=（同一路径换内容后 URL 必然变化）', () => {
    expect(vaultUrl('a/b.png', 1_700_000_000_000)).toBe('vault://asset/a/b.png?v=1700000000000')
    expect(vaultUrl('a/b.png', 1)).not.toBe(vaultUrl('a/b.png', 2))
  })

  it('版本值被编码（不会破坏协议解析）', () => {
    expect(vaultUrl('a/b.png', 'a b&c')).toBe('vault://asset/a/b.png?v=a%20b%26c')
  })
})

// ── ④ deleteThumb：新旧 salt 一起清，不积垃圾 ─────────────────────
describe('deleteThumb · 通配删除覆盖新旧 salt', () => {
  it('删掉该 id 的旧 salt + 新 salt 两份缓存，且不误删别的 id', async () => {
    await setMtime(coverAbs, 1_700_000_000_000)
    const oldName = await ensureThumb(ID, coverAbs)
    await setMtime(coverAbs, 1_700_000_002_000)
    const newName = await ensureThumb(ID, coverAbs)

    // 另一个资产的缓存（同一次调用链里产生），必须活着
    const otherCover = path.join(libDir, 'other.cover.png')
    await fs.writeFile(otherCover, Buffer.from('other'))
    const otherName = await ensureThumb(OTHER_ID, otherCover)

    expect(oldName).not.toBe(newName)
    expect(otherName).toBeTruthy()

    const removed = await deleteThumb(ID)

    expect(removed).toBeGreaterThanOrEqual(2)
    expect(await exists(path.join(thumbsDir(), oldName!))).toBe(false)
    expect(await exists(path.join(thumbsDir(), newName!))).toBe(false)
    expect(await exists(path.join(thumbsDir(), otherName!))).toBe(true)
  })
})
