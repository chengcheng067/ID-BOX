/**
 * 封面背景色的**口径锁**（2026-10 回归复核）。
 *
 * 用户看到卡片上有「一块方形的深色底」，容易误判成"封面渲染把背景写成了纯黑"。
 * 实测证据（`ffmpeg` 取该封面四角像素）：`28,28,30` = `#1C1C1E`，
 * 正是深色主题的 `--render-canvas-bg` —— 说明 `paperColor()` 是**生效**的，
 * 纯黑并不成立；方形底色的真正来源是"卡片显示了不透明的封面缩略图"
 * （见 `tests/ballCoverThumb.test.ts`）。
 *
 * 即便如此，这条口径必须被锁住，防止以后有人把它改回硬编码黑/白：
 * - **PNG（球图缩略图 + 2026-10-23 起的封面）**：背景恒为 `undefined` → `BallScene`
 *   用 `alpha:true` + 清屏色 0 → 透明，卡片 `bg-canvas` 透得出来，深浅主题共用同一份缓存；
 * - **JPEG（`renderBallToJpeg` 的遗留带底输出）**：背景 = 调用方显式色，否则 `paperColor()`
 *   （读 `--render-canvas-bg`：浅色 `#FFFFFF` / 深色 `#1C1C1E`），**绝不回落成 `#000000`**。
 *   ⚠️ 2026-10-23 用户拍板「封面用 PNG 就可以，不需要 JPG」→ **封面路径不再走 JPEG**，
 *   下面的源码守卫反向钉住这一点（`CustomRenderDialog` / `saveCover` 都不许出现
 *   `renderBallToJpeg(`）；JPEG 只剩"带底输出"这一条遗留能力。
 *
 * 纯函数可直测，另加一条源码守卫（node 里跑不了 WebGL，`renderBallBlob` 本身不可执行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  paperColor,
  resolveBallBackground
} from '../src/renderer/components/MaterialBall'
import {
  MAX_COVER_IMAGE_BYTES,
  coverFileName,
  coverImageExt,
  detectCoverImageFormat,
  validateCoverImage
} from '../src/main/coverImage'
import { thumbOutputExt } from '../src/shared/thumb'

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/MaterialBall.tsx'),
  'utf-8'
)
const DIALOG = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/CustomRenderDialog.tsx'),
  'utf-8'
)

/** 临时替换 DOM 全局（node 环境没有 document / getComputedStyle） */
function withThemeVar(value: string, fn: () => void): void {
  const g = globalThis as unknown as {
    document?: unknown
    getComputedStyle?: (el: unknown) => { getPropertyValue: (k: string) => string }
  }
  const prevDoc = g.document
  const prevStyle = g.getComputedStyle
  g.document = { documentElement: {} }
  g.getComputedStyle = () => ({
    getPropertyValue: (k: string) => (k === '--render-canvas-bg' ? value : '')
  })
  try {
    fn()
  } finally {
    if (prevDoc === undefined) delete g.document
    else g.document = prevDoc
    if (prevStyle === undefined) delete g.getComputedStyle
    else g.getComputedStyle = prevStyle
  }
}

afterEach(() => {
  const g = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown }
  delete g.document
  delete g.getComputedStyle
})

describe('球图缩略图 vs 保存封面：背景是两条独立路径', () => {
  it('PNG（球图）→ 背景恒为 undefined（透明画布，卡片透出画布色）', () => {
    expect(resolveBallBackground('png')).toBeUndefined()
    // 即使调用方误传了背景色也必须忽略——透明是球图的硬要求
    expect(resolveBallBackground('png', '#ffffff')).toBeUndefined()
    expect(resolveBallBackground('png', '#000000')).toBeUndefined()
  })

  it('JPEG（保存为封面）→ 不传背景时取 paperColor()，绝不以纯黑兜底', () => {
    // node 环境没有 document → paperColor() 回落到 #ffffff（不是 #000000）
    const bg = resolveBallBackground('jpeg')
    expect(bg).toBe('#ffffff')
    expect(bg).not.toBe('#000000')
  })

  it('JPEG 显式背景优先；空白串按"没传"处理（不交给 THREE.Color 解析成黑）', () => {
    expect(resolveBallBackground('jpeg', '#1c1c1e')).toBe('#1c1c1e')
    expect(resolveBallBackground('jpeg', ' #FFFFFF ')).toBe('#FFFFFF')
    expect(resolveBallBackground('jpeg', '   ')).toBe('#ffffff')
    expect(resolveBallBackground('jpeg', '')).toBe('#ffffff')
  })

  it('paperColor 真的读 --render-canvas-bg（深色 #1c1c1e / 浅色 #ffffff）', () => {
    withThemeVar(' #1c1c1e ', () => {
      expect(paperColor()).toBe('#1c1c1e')
      expect(resolveBallBackground('jpeg')).toBe('#1c1c1e')
      // 球图仍然是透明的，不受主题影响
      expect(resolveBallBackground('png')).toBeUndefined()
    })
    withThemeVar(' #ffffff ', () => {
      expect(paperColor()).toBe('#ffffff')
      expect(resolveBallBackground('jpeg')).toBe('#ffffff')
    })
    // 变量缺失 → 浅色兜底（不是黑）
    withThemeVar('', () => {
      expect(paperColor()).toBe('#ffffff')
    })
  })
})

describe('源码守卫：口径不许被改回去', () => {
  it('离屏渲染的背景只从 resolveBallBackground 来（不是 format===png ? ... : 硬编码）', () => {
    expect(SOURCE).toContain('const background = resolveBallBackground(format, opts.background)')
    // 两种格式只在 format 上不同，共用同一条渲染/落盘管线
    expect(SOURCE).toContain("return renderBallBlob(relFolder, slots, { ...opts, format: 'jpeg' })")
    expect(SOURCE).toContain("return renderBallBlob(relFolder, slots, { ...opts, format: 'png' })")
  })

  it('「保存 · 设为封面」走**透明 PNG**（2026-10-23 用户拍板：封面不需要是 JPG）', () => {
    // 透明 PNG → 封面缩略图也是 PNG（`toPNG()` 保 alpha）→ 卡片透出画布色，
    // "保存封面后卡片出现一块方底"从根上消失。
    expect(DIALOG).toContain('renderBallToPng(')
    expect(DIALOG).not.toContain('renderBallToJpeg(')
    // PNG 分支恒为透明，不许再传 background（留着只会误导）
    expect(DIALOG).not.toContain('background: paperColor()')
    expect(DIALOG).not.toMatch(/background:\s*['"]#[0-9a-fA-F]{3,8}['"]/)
  })

  it('★`MaterialBall.saveCover`（内嵌面板那条）同样是 PNG（口径一致，别只修弹窗）', () => {
    const at = SOURCE.indexOf('const saveCover = async () => {')
    expect(at).toBeGreaterThan(-1)
    const body = SOURCE.slice(at, SOURCE.indexOf('\n  }', at))
    expect(body).toContain('renderBallToPng(')
    expect(body).not.toContain('renderBallToJpeg(')
  })

  it('★`renderBallToJpeg` 已不用于封面：源码守卫（防止以后被接回去）', () => {
    expect(DIALOG).not.toContain('renderBallToJpeg(')
    // 弹窗也不再需要 paperColor（那是 JPEG 的底色）
    expect(DIALOG).not.toContain('paperColor')
  })

  it('球图缩略图与封面**都**走 renderBallToPng（透明）；store 里不许出现 JPEG 球图', () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/store.ts'),
      'utf-8'
    )
    // 2026-10 缓存策略：选项里多了 shape（形态参与球图身份），但**格式仍是 PNG**。
    // 断言用主谓部分 + 选项内容分开写，避免"多一个合法选项就红"。
    expect(store).toContain('mod.renderBallToPng(asset.relFolder, slots, { params, shape })')
    expect(store).toContain('const shape = resolveRenderShape(asset)')
    // 球图管线里不许出现 JPEG 渲染（那会把背景色烤进像素）
    const ballSection = store.slice(store.indexOf('async function renderBallThumbFor('))
    expect(ballSection.slice(0, ballSection.indexOf('\n}\n'))).not.toContain('renderBallToJpeg')
  })
})

/**
 * 透明 PNG 封面**在整条主进程链路上不被降级成 JPEG**。
 *
 * 只断言纯函数（不真跑 nativeImage）：`detectCoverImageFormat`（magic bytes）→
 * `coverImageExt`（落盘扩展名）→ `thumbOutputExt`（缩略图扩展名）。
 * 主进程侧的实际写入分支是 `main/thumb.ts:80`：`ext === 'png' ? scaled.toPNG() : toJPEG()`，
 * 即 **PNG 源 → `toPNG()` → alpha 保住**（`tests/ballThumb.test.ts` 那条链路已有覆盖）。
 */
describe('透明 PNG 封面：主进程链路不降级', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('★PNG magic bytes 被认成 png，落盘扩展名也是 png（→ `<资产名>.cover.png`）', () => {
    expect(detectCoverImageFormat(PNG_MAGIC)).toBe('png')
    expect(coverImageExt('png')).toBe('png')
    expect(coverFileName('榆木-001', 'png')).toBe('榆木-001.cover.png')
  })

  it('★封面是 .png → 缩略图仍是 png（`toPNG()` 分支，alpha 不被烤掉）', () => {
    expect(thumbOutputExt('png')).toBe('png')
    expect(thumbOutputExt('.png')).toBe('png')
    // ⚠️ 反向确保：封面若退化成 jpg，缩略图也会退化成不透明 jpg（正是本 bug 的形态）
    expect(thumbOutputExt('jpg')).toBe('jpg')
  })

  it('PNG 不会被 20MB 上限卡住（480×480 透明 PNG 约 0.2–0.7MB）', () => {
    // 上限是**体积**，不是格式白名单：`validateCoverImage` 只拒 超大 / 非图片。
    expect(MAX_COVER_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    const sample = Buffer.concat([PNG_MAGIC, Buffer.alloc(512 * 1024)])
    expect(validateCoverImage(sample)).toEqual({ ok: true, format: 'png' })
  })
})
