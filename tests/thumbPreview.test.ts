/**
 * ≤1024 **预览图**（docs/26 方案 C + H）—— 命名 / 解析 / 缓存清理口径 / 生成器。
 *
 * 这个文件钉住三件事（改 `shared/thumb.ts` 或 `main/thumb.ts` 之前先读）：
 *
 * ① **旧格式解析一字不变**：`<id>-<salt>.<ext>` 的解析结果必须仍然只有
 *    `{id, salt, ext}` 三个键（没有 `preview` 键、没有 `preview: false`）。
 *    守卫方式：把**改造前的正则原样冻结**在测试里当 oracle，对同一批文件名
 *    `toStrictEqual` 逐个字段比对。
 * ② **新语法不与旧文件冲突**：带 `-p1024` 的名字在**旧解析器里必然是 null**
 *    （`p` 不是十六进制，不可能被当成 salt）→ 不存在"盘上的旧文件被重新解释"。
 * ③ **清理口径覆盖预览图**：`isThumbOf` / `matchThumbNames` / `findOrphanThumbs`
 *    必须认预览图，否则 `pruneThumbs` 会把它们当垃圾清掉（或反过来清不掉）。
 *
 * 生成器部分（`ensurePreview`）按 `tests/thumbSalt.test.ts` 同一套路 mock `electron`：
 * `nativeImage` 只是"一张固定尺寸的假图"，被测的是**文件名 / 幂等性 / 尺寸计算 / 落盘**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PREVIEW_MAX_PX,
  PREVIEW_SUFFIX,
  findOrphanThumbs,
  isPreviewThumbName,
  isThumbOf,
  matchThumbNames,
  parseThumbFileName,
  previewFileName,
  resizeToMaxPx,
  thumbFileName
} from '../src/shared/thumb'

// ── electron 桩（vi.mock 提升：env 也必须用 vi.hoisted 一起提升） ─────────────
const env = vi.hoisted(() => ({
  /** `app.getPath('userData')` 的落点（`thumbsDir()` = 它 + '/thumbs'） */
  userDataRoot: '',
  /** `nativeImage.createFromPath` 被调用次数（= 原图解码次数，幂等性断言用） */
  decodeCalls: 0,
  /** `img.resize` 被调用次数 + 最近一次目标尺寸 */
  resizeCalls: 0,
  lastResize: null as null | { width: number; height: number },
  /** 假图的"原始尺寸"（默认 4000×3000，用来验 ≤1024 的等比计算） */
  width: 4000,
  height: 3000
}))

vi.mock('electron', () => {
  const fakeImage = {
    isEmpty: () => false,
    getSize: () => ({ width: env.width, height: env.height }),
    resize: (opts: { width: number; height: number }) => {
      env.resizeCalls += 1
      env.lastResize = { width: opts.width, height: opts.height }
      return fakeImage
    },
    toPNG: () => Buffer.from('fake-png'),
    toJPEG: () => Buffer.from('fake-jpeg')
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

// 必须在 vi.mock 之后 import：`main/thumb.ts` 顶层就 import 了 electron
const { ensurePreview, ensureThumb, deleteThumb, thumbsDir } = await import('../src/main/thumb')

const ID = '5e4c3050-e057-4681-a70a-cb277890c309'
const OTHER_ID = 'ffffffff-0000-4000-8000-000000000000'

/** 事故复盘里真实存在的文件名（`thumbRescue` 的 pin 用它，不能被新语法改解析） */
const REAL_LEGACY_NAME = '5e4c3050-e057-4681-a70a-cb277890c309-e94039c0.png'

let libDir = ''
let srcAbs = ''

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function setMtime(abs: string, ms: number): Promise<void> {
  const t = new Date(ms)
  await fs.utimes(abs, t, t)
}

beforeEach(async () => {
  env.userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-preview-'))
  env.decodeCalls = 0
  env.resizeCalls = 0
  env.lastResize = null
  env.width = 4000
  env.height = 3000
  libDir = path.join(env.userDataRoot, 'library', '材质', '木纹')
  await fs.mkdir(libDir, { recursive: true })
  srcAbs = path.join(libDir, '木纹 4K.jpg')
  await fs.writeFile(srcAbs, Buffer.from('jpeg-bytes-of-a-4k-texture'))
})

afterEach(async () => {
  if (env.userDataRoot) await fs.rm(env.userDataRoot, { recursive: true, force: true }).catch(() => {})
  env.userDataRoot = ''
  libDir = ''
  srcAbs = ''
})

// ─────────────────────────────────────────────────────────────────────────────
// ① 命名：预览图与 480 缩略图必须区分得开
// ─────────────────────────────────────────────────────────────────────────────
describe('previewFileName · 命名', () => {
  it('PREVIEW_MAX_PX 就是 1024（既不是 480 也不是原图）', () => {
    expect(PREVIEW_MAX_PX).toBe(1024)
    expect(PREVIEW_SUFFIX).toBe('-p1024')
  })

  it('拼出 <id>-<salt>-p1024.<ext>', () => {
    expect(previewFileName(ID, '1a2b3c4d', 'jpg')).toBe(`${ID}-1a2b3c4d-p1024.jpg`)
    expect(previewFileName(ID, '1a2b3c4d', 'png')).toBe(`${ID}-1a2b3c4d-p1024.png`)
  })

  it('与同 salt 的 480 缩略图**不同名**（互不覆盖）', () => {
    expect(previewFileName(ID, '1a2b3c4d', 'jpg')).not.toBe(thumbFileName(ID, '1a2b3c4d', 'jpg'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 解析：新语法能认回来；旧语法**逐字段不变**（守卫级）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **改造前的解析器**，原样冻结（一个字都不许改）。
 *
 * 这是"向后兼容"的唯一可信 oracle：不是"我觉得应该一样"，而是拿真·旧代码的输出
 * 逐字段对比。新实现若给旧格式多加一个键（哪怕值是 false/undefined），这里必红。
 */
const LEGACY_RE = /^(.+)-([0-9a-f]+)\.(jpg|png)$/i
function legacyParse(name: string): { id: string; salt: string; ext: string } | null {
  const m = LEGACY_RE.exec(name)
  if (!m) return null
  return { id: m[1]!, salt: m[2]!.toLowerCase(), ext: m[3]!.toLowerCase() }
}

/** 旧格式语料：真实的 + 边界的 + 本该解析失败的（都必须得到"和以前一样"的结果） */
const LEGACY_CORPUS: readonly string[] = [
  REAL_LEGACY_NAME,
  '5e4c3050-e057-4681-a70a-cb277890c309-7933daa4.png',
  `${ID}-1a2b3c4d.jpg`,
  `${ID}-ABCDEF12.PNG`,
  'a1b2-1a2b3c4d.jpg',
  'preview.jpg',
  'notes.txt',
  `${ID}-zzzz.jpg`,
  `${ID}-.jpg`,
  'a-.png',
  '-abc.png',
  '',
  `${ID}-1a2b3c4d.gif`,
  `${ID}-1a2b3c4d-p1024x.jpg`
]

describe('parseThumbFileName · 旧格式零变化（冻结旧正则做 oracle）', () => {
  it('语料里每个名字都逐字段相等（toStrictEqual：连"有没有 preview 键"都算）', () => {
    for (const name of LEGACY_CORPUS) {
      expect(parseThumbFileName(name), name).toStrictEqual(legacyParse(name))
    }
  })

  it('旧格式的返回值**恰好三个键**（没有 preview / 没有 preview:false）', () => {
    const parsed = parseThumbFileName(REAL_LEGACY_NAME)
    expect(parsed).toStrictEqual({
      id: '5e4c3050-e057-4681-a70a-cb277890c309',
      salt: 'e94039c0',
      ext: 'png'
    })
    expect(Object.keys(parsed!)).toEqual(['id', 'salt', 'ext'])
    expect('preview' in parsed!).toBe(false)
    expect(parsed!.preview).toBeUndefined()
  })

  it('既有调用方常用的平铺断言也仍然成立（toEqual 三字段）', () => {
    expect(parseThumbFileName(`${ID}-1a2b3c4d.jpg`)).toEqual({
      id: ID,
      salt: '1a2b3c4d',
      ext: 'jpg'
    })
  })
})

describe('parseThumbFileName · 预览图新语法', () => {
  it('解析出 preview:true，其余字段与 480 缩略图同构', () => {
    const name = previewFileName(ID, 'deadbeef', 'png')
    expect(parseThumbFileName(name)).toStrictEqual({
      id: ID,
      salt: 'deadbeef',
      ext: 'png',
      preview: true
    })
  })

  it('后缀大小写不敏感（归一化后仍是 preview:true）', () => {
    expect(parseThumbFileName(`${ID}-deadbeef-P1024.JPG`)).toStrictEqual({
      id: ID,
      salt: 'deadbeef',
      ext: 'jpg',
      preview: true
    })
  })

  it('isPreviewThumbName：预览 true / 480 缩略图 false / 非缓存文件 false', () => {
    expect(isPreviewThumbName(previewFileName(ID, 'deadbeef', 'jpg'))).toBe(true)
    expect(isPreviewThumbName(thumbFileName(ID, 'deadbeef', 'jpg'))).toBe(false)
    expect(isPreviewThumbName('junk.txt')).toBe(false)
  })

  it('**新语法在旧解析器里必然 null** → 不存在"旧文件被重新解释"', () => {
    const previewNames = [
      previewFileName(ID, 'deadbeef', 'jpg'),
      previewFileName(ID, 'deadbeef', 'png'),
      `${ID}-deadbeef-P1024.JPG`
    ]
    for (const name of previewNames) {
      expect(legacyParse(name), name).toBeNull()
      expect(parseThumbFileName(name), name).not.toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 尺寸：≤1024 且绝不放大
// ─────────────────────────────────────────────────────────────────────────────
describe('resizeToMaxPx · 1024 档位', () => {
  it('8K / 4K 等比缩到长边 1024', () => {
    expect(resizeToMaxPx(4000, 3000, PREVIEW_MAX_PX)).toEqual({ width: 1024, height: 768 })
    expect(resizeToMaxPx(3000, 4000, PREVIEW_MAX_PX)).toEqual({ width: 768, height: 1024 })
    expect(resizeToMaxPx(8192, 8192, PREVIEW_MAX_PX)).toEqual({ width: 1024, height: 1024 })
  })

  it('比 1024 小的图**不放大**（放大只增加体积，不增加信息）', () => {
    expect(resizeToMaxPx(800, 600, PREVIEW_MAX_PX)).toEqual({ width: 800, height: 600 })
    expect(resizeToMaxPx(1024, 1024, PREVIEW_MAX_PX)).toEqual({ width: 1024, height: 1024 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 清理口径：预览图必须被认成"这个 id 的缓存"
// ─────────────────────────────────────────────────────────────────────────────
describe('缓存清理口径覆盖预览图', () => {
  const oldThumb = thumbFileName(ID, 'aaaaaaaa', 'jpg')
  const preview = previewFileName(ID, 'aaaaaaaa', 'jpg')
  const otherThumb = thumbFileName(OTHER_ID, 'bbbbbbbb', 'jpg')

  it('isThumbOf：预览图属于该资产', () => {
    expect(isThumbOf(preview, ID)).toBe(true)
    expect(isThumbOf(preview, OTHER_ID)).toBe(false)
    expect(isThumbOf(oldThumb, ID)).toBe(true)
  })

  it('matchThumbNames：480 与预览图一起返回（deleteThumb 通配删除覆盖它）', () => {
    expect(matchThumbNames([oldThumb, preview, otherThumb, 'junk.txt'], ID)).toEqual([
      oldThumb,
      preview
    ])
  })

  it('findOrphanThumbs：资产还活着 → 预览图**不是**孤儿（绝不能被 prune 清掉）', () => {
    expect(findOrphanThumbs([oldThumb, preview], [ID])).toEqual([])
  })

  it('findOrphanThumbs：资产没了 → 预览图才是孤儿（缓存随资产回收）', () => {
    expect(findOrphanThumbs([preview], [])).toEqual([preview])
    expect(findOrphanThumbs([preview], [OTHER_ID])).toEqual([preview])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 生成器：幂等（不解码第二次）+ 内容身份 salt + 绝不抛
// ─────────────────────────────────────────────────────────────────────────────
describe('ensurePreview · 生成 / 复用', () => {
  it('生成 ≤1024 预览图并落盘，返回 <id>-<salt>-p1024.jpg', async () => {
    const name = await ensurePreview(ID, srcAbs)

    expect(name).toBeTruthy()
    expect(name).toMatch(new RegExp(`^${ID}-[0-9a-f]+-p1024\\.jpg$`))
    expect(await exists(path.join(thumbsDir(), name!))).toBe(true)
    // 4000×3000 → 1024×768（等比、长边 1024）
    expect(env.lastResize).toEqual({ width: 1024, height: 768 })
  })

  it('幂等 + **不解码第二次**（hover 反复调用不能每次都解 8K 原图）', async () => {
    const first = await ensurePreview(ID, srcAbs)
    expect(env.decodeCalls).toBe(1)

    const second = await ensurePreview(ID, srcAbs)
    expect(second).toBe(first)
    // 关键断言：第二次只 stat，不再 createFromPath
    expect(env.decodeCalls).toBe(1)
    expect(env.resizeCalls).toBe(1)
  })

  it('源文件被原地覆盖（只有 mtime 变）→ 新文件名（浏览器缓存自然失效）', async () => {
    await setMtime(srcAbs, 1_700_000_000_000)
    const before = await ensurePreview(ID, srcAbs)
    await setMtime(srcAbs, 1_700_000_002_000)
    const after = await ensurePreview(ID, srcAbs)

    expect(before).toBeTruthy()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    expect(await exists(path.join(thumbsDir(), after!))).toBe(true)
  })

  it('与同源的 480 缩略图**不同文件名**（两档缓存并存，互不覆盖）', async () => {
    const preview = await ensurePreview(ID, srcAbs)
    const thumb = await ensureThumb(ID, srcAbs)

    expect(preview).toBeTruthy()
    expect(thumb).toBeTruthy()
    expect(preview).not.toBe(thumb)
    expect(isPreviewThumbName(preview!)).toBe(true)
    expect(isPreviewThumbName(thumb!)).toBe(false)
  })

  it('PNG 源输出 PNG（保透明），扩展名跟着 thumbOutputExt 走', async () => {
    const pngAbs = path.join(libDir, '透明贴图.png')
    await fs.writeFile(pngAbs, Buffer.from('png-bytes'))
    const name = await ensurePreview(ID, pngAbs)
    expect(name).toMatch(/-p1024\.png$/)
    expect(isPreviewThumbName(name!)).toBe(true)
  })

  it('小图不放大：800×600 不调 resize（还是原尺寸）', async () => {
    env.width = 800
    env.height = 600
    const name = await ensurePreview(OTHER_ID, srcAbs)
    expect(name).toBeTruthy()
    expect(env.resizeCalls).toBe(0)
  })

  it('源文件不存在 / 入参空 → null（降级契约，绝不抛）', async () => {
    expect(await ensurePreview(ID, path.join(libDir, 'nope.jpg'))).toBeNull()
    expect(await ensurePreview(ID, null)).toBeNull()
    expect(await ensurePreview('', srcAbs)).toBeNull()
    expect(env.decodeCalls).toBe(0)
  })

  it('deleteThumb(id) 把 480 缩略图与预览图一起清掉（同一套通配口径）', async () => {
    const thumb = await ensureThumb(ID, srcAbs)
    const preview = await ensurePreview(ID, srcAbs)
    expect(thumb).not.toBe(preview)

    const removed = await deleteThumb(ID)
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(await exists(path.join(thumbsDir(), thumb!))).toBe(false)
    expect(await exists(path.join(thumbsDir(), preview!))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 接线守卫：三处调用点必须真的把「预览来源」传下去
//    （仓库既有风格：对跨进程接线用源码级断言，因为 node 环境渲染不了 React）
// ─────────────────────────────────────────────────────────────────────────────
describe('接线：拖拽卡片真的请求 ≤1024 预览图', () => {
  const readSrc = (rel: string): string =>
    fsSync.readFileSync(path.join(process.cwd(), rel), 'utf8')

  it('DetailPanel：hover 预热带 preview（资产 id + 文件绝对路径），并同步 peek 已生成的预览', () => {
    const src = readSrc('src/renderer/components/DetailPanel.tsx')
    expect(src).toContain('preview: isImageFile ? { id: asset.id, absPath: abs } : null')
    expect(src).toContain('peekPreviewUrl(asset.id, abs)')
  })

  it('AssetGrid 文件视图：hover 预热带 preview（与详情面板同一口径）', () => {
    const src = readSrc('src/renderer/components/AssetGrid.tsx')
    expect(src).toContain(
      'preview: isImageFileExt(row.ext) ? { id: asset.id, absPath: row.absPath } : null'
    )
  })

  it('dragCard：命中 preview 时**先**解析预览 URL，再 renderDragCard（时序不能反）', () => {
    const src = readSrc('src/renderer/logic/dragCard.ts')
    const previewAt = src.indexOf('const previewUrl = await ensurePreviewUrl(')
    const renderAt = src.indexOf('renderDragCard(previewUrl ?')
    expect(previewAt).toBeGreaterThan(-1)
    expect(renderAt).toBeGreaterThan(previewAt)
  })
})
