/**
 * 材质球离屏渲染图落盘（main 侧）单测（2026-10 装机反馈，任务 6）。
 *
 * `src/main/ballThumb.ts` 的纯函数部分直测；写盘路径通过 `thumbsRoot` 注入 tmp 目录
 * ——**不 import electron、不真跑 WebGL**（离屏渲染本身在无头环境跑不了，见报告）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_BALL_IMAGE_BASE64_LEN,
  MAX_BALL_IMAGE_BYTES,
  ballThumbFileName,
  isValidBallAssetId,
  saveBallThumbBytes,
  validateBallImageBase64
} from '../src/main/ballThumb'
import { parseThumbFileName } from '../src/shared/thumb'
import { ballThumbName as sharedBallThumbName } from '../src/shared/ballParams'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-ball-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

const SLOTS = { albedo: 'vh1sbjl_2K_Albedo.jpg', normal: 'vh1sbjl_2K_Normal.jpg' }
const ID = 'a1b2c3d4-1111-4222-8333-444455556666'

describe('ballThumbFileName', () => {
  it('格式 <id>-<8位hex>.png（透明背景），与既有缩略图管线同构（parseThumbFileName 能解析）', () => {
    const name = ballThumbFileName(ID, SLOTS)
    expect(name).toMatch(/^a1b2c3d4-1111-4222-8333-444455556666-[0-9a-f]{8}\.png$/)
    // 关键契约：球图必须能被既有缓存管理函数识别（delete/prune/stats 自动生效）
    expect(parseThumbFileName(name)).not.toBeNull()
  })

  it('换贴图（槽位路径变）→ hash 变 → 缓存名变', () => {
    const a = ballThumbFileName(ID, SLOTS)
    const b = ballThumbFileName(ID, { ...SLOTS, albedo: 'other_Albedo.jpg' })
    expect(a).not.toBe(b)
  })

  it('槽位顺序无关（集合哈希）', () => {
    expect(ballThumbFileName(ID, SLOTS)).toBe(
      ballThumbFileName(ID, { normal: SLOTS.normal, albedo: SLOTS.albedo })
    )
  })
})

describe('isValidBallAssetId', () => {
  it('UUID 通过', () => {
    expect(isValidBallAssetId(ID)).toBe(true)
  })

  it('空 / 超长 / 含路径分隔符与非法字符 → 拒绝（防拼出越界文件名）', () => {
    expect(isValidBallAssetId('')).toBe(false)
    expect(isValidBallAssetId('   ')).toBe(false)
    expect(isValidBallAssetId('a'.repeat(129))).toBe(false)
    expect(isValidBallAssetId('..\\evil')).toBe(false)
    expect(isValidBallAssetId('a/b')).toBe(false)
    expect(isValidBallAssetId('a:b')).toBe(false)
  })
})

describe('validateBallImageBase64', () => {
  it('正常长度通过', () => {
    expect(validateBallImageBase64('AAAA')).toBe(true)
  })

  it('空串拒绝', () => {
    expect(validateBallImageBase64('')).toBe(false)
  })

  it('超长（解码后 >5MB）拒绝', () => {
    // 5MB 字符的 base64 只 decode 出 ~3.9MB，仍应放行；超过 4/3 上限才拒
    expect(validateBallImageBase64('A'.repeat(MAX_BALL_IMAGE_BYTES))).toBe(true)
    expect(validateBallImageBase64('A'.repeat(MAX_BALL_IMAGE_BASE64_LEN + 1))).toBe(false)
  })
})

describe('saveBallThumbBytes', () => {
  it('写进注入目录、返回文件名、字节原样落盘', async () => {
    const dir = await tmpDir()
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const name = await saveBallThumbBytes(ID, SLOTS, bytes, dir)
    expect(name).toBe(ballThumbFileName(ID, SLOTS))
    const written = await fs.readFile(path.join(dir, name!))
    expect(written.equals(bytes)).toBe(true)
  })

  it('非法 assetId → null 且不落盘', async () => {
    const dir = await tmpDir()
    expect(await saveBallThumbBytes('../evil', SLOTS, Buffer.from([1]), dir)).toBeNull()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('空 / 超大 buffer → null', async () => {
    const dir = await tmpDir()
    expect(await saveBallThumbBytes(ID, SLOTS, Buffer.alloc(0), dir)).toBeNull()
    expect(
      await saveBallThumbBytes(ID, SLOTS, Buffer.alloc(MAX_BALL_IMAGE_BYTES + 1), dir)
    ).toBeNull()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('文件名恒定落在目标目录内（路径穿越防御）', async () => {
    const dir = await tmpDir()
    const name = await saveBallThumbBytes(ID, SLOTS, Buffer.from([1, 2]), dir)
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    const inside = path.resolve(path.join(dir, name!))
    expect(inside.startsWith(path.resolve(dir) + path.sep)).toBe(true)
  })
})

// ── 2026-10 调参持久化（docs/12 §6.2 建议补的用例）───────────────
// 既有 38-57 / 95 的断言一条未改。这里只**追加**。
// ⚠️ `params` 是第 5 参、`thumbsRoot` 仍是第 4 参 —— 既有 4 参调用
//   `saveBallThumbBytes(ID, SLOTS, bytes, dir)` 必须继续合法（§6.1）。

const TUNED = { roughness: 1.5, bump: 1, uv: 0.5 }

describe('ballThumbFileName · 参数进 hash（docs/12 §3.3 方案 B）', () => {
  it('传非默认 params → 名字与不传 params 不同（调过参的材质会重渲）', () => {
    const base = ballThumbFileName(ID, SLOTS)
    const tuned = ballThumbFileName(ID, SLOTS, TUNED)
    expect(tuned).not.toBe(base)
    // golden 锁（§3.3 第一组 + 1.50,1.00,0.50 → 2e1ac17a）
    expect(tuned).toBe(`${ID}-2e1ac17a.png`)
    expect(base).toBe(`${ID}-d9d58630.png`)
  })

  it('显式传默认 params → 与不传完全一致（既有磁盘缓存全部保留，零重渲）', () => {
    expect(ballThumbFileName(ID, SLOTS)).toBe(
      ballThumbFileName(ID, SLOTS, { roughness: 1, bump: 1, uv: 1 })
    )
  })

  it('参数串不出现在文件名字面（格式硬约束 §3.2）', () => {
    const name = ballThumbFileName(ID, SLOTS, TUNED)
    expect(name).toMatch(/^a1b2c3d4-1111-4222-8333-444455556666-[0-9a-f]{8}\.png$/)
    expect(name).not.toContain(',')
    const parsed = parseThumbFileName(name)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(ID)
    expect(parsed!.salt).toBe('2e1ac17a')
  })

  it('main 与 shared 是同一份 hash 实现（跨进程必须算出同一个值）', () => {
    expect(ballThumbFileName(ID, SLOTS, TUNED)).toBe(sharedBallThumbName(ID, SLOTS, TUNED))
    // 非法输入走 clamp（回落 1）而非 NaN —— 否则 hash 里出现非 hex，整条管线失效
    const dirty = ballThumbFileName(ID, SLOTS, {
      roughness: Number.NaN,
      bump: Number.POSITIVE_INFINITY,
      uv: 5
    })
    // ⚠️ 断言值曾写错（2026-10-15 QA 独立复算）：`clampUv` 上界是 **4**（不是 1），
    // 所以 `{NaN, +Inf, 5}` 规范化后是 `{1, 1, 4}` —— 不等于默认参数，**会贡献 hash**。
    // NaN/Infinity 各自回落 1，但 uv=5 被夹到 4 → hash 输入串是 `1.00,1.00,4.00`。
    // 独立复算 golden：slots + `1.00,1.00,4.00` → `a9decefe`（与 `ballParams.test.ts:123`
    // 的 clamp 口径一致；这里改断言，**不改 `clampUv`**）。
    expect(dirty).toBe(`${ID}-a9decefe.png`)
  })
})

describe('saveBallThumbBytes · params 参与落盘文件名（第 5 参）', () => {
  it('params 落盘名 = ballThumbFileName(ID, SLOTS, params)', async () => {
    const dir = await tmpDir()
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const name = await saveBallThumbBytes(ID, SLOTS, bytes, dir, TUNED)
    expect(name).toBe(ballThumbFileName(ID, SLOTS, TUNED))
    expect(name).toBe(`${ID}-2e1ac17a.png`)
    const written = await fs.readFile(path.join(dir, name!))
    expect(written.equals(bytes)).toBe(true)
  })

  it('落库前必须规范化：DB 存 0.30000000000000004、hash 用 0.3 → 同一个文件（§5.2）', async () => {
    const dir = await tmpDir()
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const noisy = await saveBallThumbBytes(
      ID,
      SLOTS,
      bytes,
      dir,
      { roughness: 0.30000000000000004, bump: 1, uv: 1 }
    )
    const clean = await saveBallThumbBytes(ID, SLOTS, bytes, dir, { roughness: 0.3, bump: 1, uv: 1 })
    expect(noisy).toBe(clean)
    expect(await fs.readdir(dir)).toHaveLength(1) // 不会产出两份缓存
  })

  it('不传 params（既有 4 参调用）仍走默认 hash —— 既有断言不受影响（§6.1）', async () => {
    const dir = await tmpDir()
    const name = await saveBallThumbBytes(ID, SLOTS, Buffer.from([1]), dir)
    expect(name).toBe(`${ID}-d9d58630.png`)
  })
})
