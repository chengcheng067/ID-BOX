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
 * - **PNG（球图缩略图）**：背景恒为 `undefined` → `BallScene` 用 `alpha:true` +
 *   清屏色 0 → 透明，卡片 `bg-canvas` 透得出来，深浅主题共用同一份缓存；
 * - **JPEG（保存为封面）**：背景 = 调用方显式色，否则 `paperColor()`
 *   （读 `--render-canvas-bg`：浅色 `#FFFFFF` / 深色 `#1C1C1E`），**绝不回落成 `#000000`**。
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

  it('「保存 · 设为封面」显式传 paperColor()（主题画布色），不硬编码近黑', () => {
    expect(DIALOG).toContain('renderBallToJpeg(')
    expect(DIALOG).toContain('background: paperColor()')
    // 2026-10 之前的实现曾是硬编码近黑，这里防止回归
    expect(DIALOG).not.toMatch(/background:\s*['"]#[0-9a-fA-F]{3,8}['"]/)
  })

  it('球图缩略图走 renderBallToPng（透明），封面走 renderBallToJpeg（不透明）', () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/store.ts'),
      'utf-8'
    )
    expect(store).toContain('mod.renderBallToPng(asset.relFolder, slots, { params })')
    // 球图管线里不许出现 JPEG 渲染（那会把背景色烤进像素）
    const ballSection = store.slice(store.indexOf('async function renderBallThumbFor('))
    expect(ballSection.slice(0, ballSection.indexOf('\n}\n'))).not.toContain('renderBallToJpeg')
  })
})
