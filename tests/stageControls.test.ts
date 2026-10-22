/**
 * 舞台浮层控制条的定位逻辑（`logic/stageControls.placeBeside`）单测。
 *
 * 三条硬要求：
 * ① 默认贴在球右侧、与球垂直居中；
 * ② 越界时夹回视口（先夹右、再夹下），不出现"浮层跑出屏幕"；
 * ③ 没有可用 anchor（球还没落定 / rect 只有几像素）时退回右上角，且 `anchorUsable` 为 false。
 */
import { describe, expect, it } from 'vitest'
import { anchorUsable, placeBeside, type AnchorLike } from '../src/renderer/logic/stageControls'

function anchor(left: number, top: number, w = 72, h = 72): AnchorLike {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h }
}

const VIEW = { width: 1280, height: 800 }
const SIZE = { width: 208, height: 108 }

describe('placeBeside：贴右 + 垂直居中', () => {
  it('球在顶部中间时，浮层在球右侧、垂直居中对齐', () => {
    const p = placeBeside(anchor(600, 20), SIZE, VIEW)
    expect(p.left).toBe(600 + 72 + 12)
    // 球中心 20+36=56，浮层高 108 → top = 56-54 = 2 → 被 margin 夹到 8
    expect(p.top).toBe(8)
  })

  it('球有足够空间时 top 就是居中值（不被夹）', () => {
    const p = placeBeside(anchor(600, 300), SIZE, VIEW)
    expect(p.top).toBe(300 + 36 - 54)
  })
})

describe('placeBeside：夹进视口', () => {
  it('球贴右边时，浮层被夹到可用最右位置', () => {
    const p = placeBeside(anchor(1200, 300), SIZE, VIEW)
    expect(p.left).toBe(VIEW.width - SIZE.width - 8)
  })

  it('球贴底部时，浮层被夹到可用最下位置', () => {
    const p = placeBeside(anchor(600, 790, 72, 72), SIZE, VIEW)
    expect(p.top).toBe(VIEW.height - SIZE.height - 8)
  })

  it('视口比浮层还窄时也不会出现负数坐标', () => {
    const p = placeBeside(anchor(10, 10), { width: 400, height: 400 }, { width: 300, height: 200 })
    expect(p.left).toBe(8)
    expect(p.top).toBe(8)
  })
})

describe('没有可用 anchor 时的兜底', () => {
  it('null → 右上角（不会跑到屏幕外）', () => {
    const p = placeBeside(null, SIZE, VIEW)
    expect(p.left).toBe(VIEW.width - SIZE.width - 8)
    expect(p.top).toBe(8)
  })

  it('rect 只有几像素（P2 收缩末帧）视为不可用', () => {
    expect(anchorUsable(anchor(600, 20, 4, 4))).toBe(false)
    expect(anchorUsable(anchor(600, 20))).toBe(true)
    expect(anchorUsable(null)).toBe(false)
  })
})
