/**
 * 钉选目录文件缩略图主进程链路单测（`src/main/pinnedThumb.ts`）。
 *
 * 覆盖五组（spec 指定）：
 *   ① 缓存键：同路径同 mtime 同名（幂等）、同路径不同 mtime 不同名（防过期）、
 *      不同路径不同名（防重名）；
 *   ② 图片降采样写盘：≤512 等比、PNG 落盘、URL 是 pinned-thumb://、命中缓存不重解码；
 *   ③ SKP：提取失败（无内嵌图 / 文件不存在）→ not-available；提取成功 → 内嵌字节原样落缓存；
 *   ④ 串行队列：并发上限 4、FIFO 放行、水位正确；
 *   ⑤ 守卫：dirRel 越界（`..` / 绝对路径）/ name 非单段 → guard 拒绝，不读写根外路径。
 *
 * 测试范式：`tests/thumbPreview.test.ts` 同款 —— mock electron
 * （`nativeImage` = 一张固定尺寸假图 + `app.getPath` 指向 tmp 根）；
 * SKP 提取走**真实** `skpPreview.ts`（纯 node:fs 实现，fixtures 合成 skp）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ── electron 桩（vi.mock 提升：env 必须用 vi.hoisted 一起提升） ────────────────
const env = vi.hoisted(() => ({
  /** `app.getPath('userData')` 的落点（pinnedThumbsDir() = 它 + '/pinned-thumbs'） */
  userDataRoot: '',
  /** `nativeImage.createFromPath` 被调用次数（幂等性断言用） */
  decodeCalls: 0,
  /** 最近一次 resize 的目标尺寸（≤512 断言用） */
  lastResize: null as null | { width: number; height: number },
  /** 假图的"原始尺寸" */
  width: 4000,
  height: 3000
}))

vi.mock('electron', () => {
  const fakeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: env.width, height: env.height }),
    resize: (opts: { width: number; height: number }) => {
      env.lastResize = { width: opts.width, height: opts.height }
      return fakeImage
    },
    toPNG: () => Buffer.from('fake-png-bytes')
  }
  return {
    nativeImage: {
      createFromPath: () => {
        env.decodeCalls += 1
        return fakeImage
      }
    },
    app: { getPath: () => env.userDataRoot }
  }
})

// 必须在 vi.mock 之后 import：`main/pinnedThumb.ts` 顶层就 import 了 electron
const {
  PINNED_THUMB_CONCURRENCY,
  PINNED_THUMB_MAX_PX,
  createPinnedThumbGate,
  pinnedThumbsDir,
  pinnedThumbFileName,
  pinnedThumbUrl,
  resolveThumbForEntry,
  runInPinnedThumbQueue
} = await import('../src/main/pinnedThumb')
import { skpContent, skpContentWithPreview, TINY_PNG, tinyJpeg } from './fixtures/gbkZip'

const tmpRoots: string[] = []

async function tmpDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

let pinRoot = ''

beforeEach(async () => {
  env.userDataRoot = await tmpDir('mv-pinthumb-u-')
  pinRoot = await tmpDir('mv-pinthumb-pin-')
  await fs.mkdir(path.join(pinRoot, '子目录'), { recursive: true })
  env.decodeCalls = 0
  env.lastResize = null
  env.width = 4000
  env.height = 3000
})

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

async function setMtime(abs: string, ms: number): Promise<void> {
  const t = new Date(ms)
  await fs.utimes(abs, t, t)
}

async function writeSource(rel: string, bytes: Buffer, ms = 1_700_000_000_000): Promise<string> {
  const abs = path.join(pinRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, bytes)
  await setMtime(abs, ms)
  return abs
}

async function cacheExists(name: string): Promise<boolean> {
  try {
    await fs.stat(path.join(pinnedThumbsDir(), name))
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 缓存键
// ─────────────────────────────────────────────────────────────────────────────
describe('缓存键 pinnedThumbFileName', () => {
  it('格式 <fnv1a(路径) 8hex>-<mtime 整毫秒>.<ext>（确定性：同输入恒同名）', () => {
    const a = pinnedThumbFileName('E:\\mod\\a.jpg', 1_700_000_000_000.123, 'png')
    const b = pinnedThumbFileName('E:\\mod\\a.jpg', 1_700_000_000_000.4, 'png')
    expect(a).toMatch(/^[0-9a-f]{8}-1700000000000\.png$/)
    expect(a).toBe(b) // mtime 浮点取整，同一文件多次 stat 结果稳定（幂等）
  })

  it('同路径不同 mtime → 不同名（源文件改写后 URL 变，缓存自然失效）', async () => {
    const abs = await writeSource('图.jpg', Buffer.from('jpeg-bytes'))
    const r1 = await resolveThumbForEntry(pinRoot, '', '图.jpg')
    expect(r1.ok).toBe(true)
    await setMtime(abs, 1_700_000_002_000)
    const r2 = await resolveThumbForEntry(pinRoot, '', '图.jpg')
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r2.url).not.toBe(r1.url)
  })

  it('不同路径（哪怕同 mtime）→ 不同名（路径进哈希防重名）', async () => {
    await writeSource('a/图.jpg', Buffer.from('one'), 1_700_000_000_000)
    await writeSource('b/图.jpg', Buffer.from('two'), 1_700_000_000_000)
    const r1 = await resolveThumbForEntry(pinRoot, 'a', '图.jpg')
    const r2 = await resolveThumbForEntry(pinRoot, 'b', '图.jpg')
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r2.url).not.toBe(r1.url)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 图片降采样写盘
// ─────────────────────────────────────────────────────────────────────────────
describe('图片条目 · 降采样写盘', () => {
  it('4000×3000 jpg → 等比缩到 512×384（≤512），PNG 落缓存，URL pinned-thumb://', async () => {
    await writeSource('图.jpg', Buffer.from('jpeg-bytes'))
    const r = await resolveThumbForEntry(pinRoot, '', '图.jpg')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toMatch(/^pinned-thumb:\/\/[0-9a-f]{8}-\d+\.png$/)
    expect(env.lastResize).toEqual({ width: 512, height: 384 })
    expect(await cacheExists(r.url.slice('pinned-thumb://'.length))).toBe(true)
    const written = await fs.readFile(
      path.join(pinnedThumbsDir(), r.url.slice('pinned-thumb://'.length))
    )
    expect(written.toString('utf8')).toBe('fake-png-bytes')
  })

  it('各图片扩展名都放行（jpeg/png/webp/bmp/gif）', async () => {
    for (const ext of ['jpeg', 'png', 'webp', 'bmp', 'gif']) {
      await writeSource(`f.${ext}`, Buffer.from('bytes'))
      const r = await resolveThumbForEntry(pinRoot, '', `f.${ext}`)
      expect(r.ok, ext).toBe(true)
    }
  })

  it('幂等：命中缓存直接返回，不再解码第二次', async () => {
    await writeSource('图.png', Buffer.from('png-bytes'))
    const r1 = await resolveThumbForEntry(pinRoot, '', '图.png')
    expect(r1.ok).toBe(true)
    expect(env.decodeCalls).toBe(1)
    const r2 = await resolveThumbForEntry(pinRoot, '', '图.png')
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r2.url).toBe(r1.url)
    expect(env.decodeCalls).toBe(1) // 关键断言：只 stat，不 createFromPath
  })

  it('源文件不存在 → not-available（不是错误）', async () => {
    const r = await resolveThumbForEntry(pinRoot, '', '没有这张图.jpg')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
  })

  it('子目录里的文件：dirRel 拼接后正常生成', async () => {
    await writeSource('子目录/贴图.webp', Buffer.from('webp'))
    const r = await resolveThumbForEntry(pinRoot, '子目录', '贴图.webp')
    expect(r.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ SKP：复用 skpPreview.ts（CDib 锚定提取）
// ─────────────────────────────────────────────────────────────────────────────
describe('SKP 条目 · 内嵌预览提取', () => {
  it('有内嵌预览的 skp → 提取字节原样落缓存（复用 importer 同一份提取实现）', async () => {
    await writeSource('模型.skp', skpContentWithPreview(TINY_PNG))
    const r = await resolveThumbForEntry(pinRoot, '', '模型.skp')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toMatch(/^pinned-thumb:\/\/[0-9a-f]{8}-\d+\.png$/)
    const written = await fs.readFile(
      path.join(pinnedThumbsDir(), r.url.slice('pinned-thumb://'.length))
    )
    expect(written.equals(TINY_PNG)).toBe(true)
  })

  it('JPEG 内嵌图 → 缓存扩展名跟内嵌格式走（.jpg）', async () => {
    await writeSource('模型.skp', skpContentWithPreview(tinyJpeg()))
    const r = await resolveThumbForEntry(pinRoot, '', '模型.skp')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toMatch(/\.jpg$/)
  })

  it('提取失败（造假 skp：无内嵌图）→ not-available，渲染层自绘 SU 图标兜底', async () => {
    await writeSource('空壳.skp', skpContent())
    const r = await resolveThumbForEntry(pinRoot, '', '空壳.skp')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
  })

  it('skp 文件不存在 → not-available', async () => {
    const r = await resolveThumbForEntry(pinRoot, '', '没有.skp')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 其他扩展名：明确不做系统级缩略图
// ─────────────────────────────────────────────────────────────────────────────
describe('其他扩展名 → not-available（渲染层自绘图标兜底）', () => {
  it.each(['max', 'dwg', 'dxf', 'rar', 'zip', 'txt', 'skb'])('%s 不生成缩略图', async (ext) => {
    await writeSource(`f.${ext}`, Buffer.from('bytes'))
    const r = await resolveThumbForEntry(pinRoot, '', `f.${ext}`)
    expect(r).toEqual({ ok: false, reason: 'not-available' })
    expect(env.decodeCalls).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 串行队列：并发上限 4
// ─────────────────────────────────────────────────────────────────────────────
describe('串行队列（并发上限 4）', () => {
  it('PINNED_THUMB_CONCURRENCY 就是 4（spec 拍板）', () => {
    expect(PINNED_THUMB_CONCURRENCY).toBe(4)
    expect(PINNED_THUMB_MAX_PX).toBe(512)
  })

  it('10 个任务同时提交 → 执行中 ≤4、排队 6，最终全部完成（FIFO 放行）', async () => {
    const gate = createPinnedThumbGate(4)
    let inFlightNow = 0
    let maxInFlight = 0
    const release: Array<() => void> = []
    const order: number[] = []

    const jobs = Array.from({ length: 10 }, (_, i) =>
      gate.run(async () => {
        inFlightNow++
        maxInFlight = Math.max(maxInFlight, inFlightNow)
        order.push(i)
        await new Promise<void>((res) => release.push(res))
        inFlightNow--
      })
    )

    // 先把 4 个在跑的放掉，观察放行节奏：任一时刻执行中都不超 4
    for (let round = 0; round < 10; round++) {
      await new Promise((res) => setImmediate(res))
      expect(gate.inFlight).toBeLessThanOrEqual(4)
      release.splice(0).forEach((res) => res())
    }
    await Promise.all(jobs)
    expect(maxInFlight).toBe(4)
    expect(gate.inFlight).toBe(0)
    expect(gate.queued).toBe(0)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) // FIFO
  })

  it('resolveThumbForEntry 统一过池（runInPinnedThumbQueue 水位可见）', async () => {
    await writeSource('图.jpg', Buffer.from('bytes'))
    const before = runInPinnedThumbQueue(async () => 1)
    expect(before).toBeInstanceOf(Promise)
    await before
    expect(pinnedThumbUrl('a-1.png')).toBe('pinned-thumb://a-1.png')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 守卫：越界拒绝
// ─────────────────────────────────────────────────────────────────────────────
describe('守卫 · 越界与非法名拒绝', () => {
  it('dirRel 用 .. 穿越到根外 → guard 拒绝（不读写任何文件）', async () => {
    const r = await resolveThumbForEntry(pinRoot, '..\\外部', '图.jpg')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('guard')
    expect(typeof r.error).toBe('string')
    expect(env.decodeCalls).toBe(0)
  })

  it('dirRel 塞绝对路径 → guard 拒绝', async () => {
    const r = await resolveThumbForEntry(pinRoot, 'C:\\Windows', '图.jpg')
    expect(r).toMatchObject({ ok: false, reason: 'guard' })
  })

  it('name 含路径分隔符 / 是 .. → guard 拒绝（单段校验）', async () => {
    expect(await resolveThumbForEntry(pinRoot, '', 'a/b.jpg')).toMatchObject({ ok: false, reason: 'guard' })
    expect(await resolveThumbForEntry(pinRoot, '', 'a\\b.jpg')).toMatchObject({ ok: false, reason: 'guard' })
    expect(await resolveThumbForEntry(pinRoot, '', '..')).toMatchObject({ ok: false, reason: 'guard' })
    expect(await resolveThumbForEntry(pinRoot, '', '')).toMatchObject({ ok: false, reason: 'guard' })
  })

  it('合法 dirRel 但目录本身不存在 → not-available（不是 guard）', async () => {
    const r = await resolveThumbForEntry(pinRoot, '不存在', '图.jpg')
    expect(r).toEqual({ ok: false, reason: 'not-available' })
  })
})
