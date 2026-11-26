/**
 * 边缘箭头**点击**滚动目标值的单测（`clickScrollTarget`，homePinned.ts）。
 *
 * 与悬停自动滚动（rAF 逐帧小步，测在 homePinned.test.ts 的 nextScrollLeft）
 * 不同：点击是一次性跳一个「卡步进」（一张卡宽 + 行 gap，见 glass-folder.css
 * / home-outro.css 的 `.hc-folder-row`），重点验证边界夹取与两向对称。
 *
 * 测试范式：vitest node 环境（纯函数不 import React / DOM / electron）。
 */
import { describe, expect, it } from 'vitest'
import { clickScrollTarget } from '../src/renderer/logic/homePinned'

describe('clickScrollTarget · 边缘箭头点击滚动目标', () => {
  // 典型场景：卡步进 = 卡宽 161 + gap 48 ≈ 209（1520 窗档位），可滚区间 [0, 400]
  it('向右 +1：走一个 step，落在区间内不夹取', () => {
    expect(clickScrollTarget(50, 1, 209, 0, 400)).toBe(259)
  })

  it('向左 -1：走一个 step，落在区间内不夹取', () => {
    expect(clickScrollTarget(350, -1, 209, 0, 400)).toBe(141)
  })

  it('越界向下夹取到 max：剩余量小于 step 时停在头', () => {
    expect(clickScrollTarget(300, 1, 209, 0, 400)).toBe(400)
  })

  it('越界向上夹取到 min：剩余量小于 step 时停在头', () => {
    expect(clickScrollTarget(100, -1, 209, 0, 400)).toBe(0)
  })

  it('已经处在 max 时向右点击 → 原地不动', () => {
    expect(clickScrollTarget(400, 1, 209, 0, 400)).toBe(400)
  })

  it('已经处在 min 时向左点击 → 原地不动', () => {
    expect(clickScrollTarget(0, -1, 209, 0, 400)).toBe(0)
  })

  it('step 大于整个可滚区间：任何位置点击都直接滚到对应端头', () => {
    expect(clickScrollTarget(120, 1, 500, 0, 400)).toBe(400)
    expect(clickScrollTarget(280, -1, 500, 0, 400)).toBe(0)
  })

  it('current 越出 [min, max]（DOM 尺寸中途变小）→ 结果仍收口在区间内', () => {
    // 语义与 nextScrollLeft 一致：current + dir×step 后**一次性**收口，
    // 不先夹 current 再走 step（调用方传的是真实 scrollLeft，正常永远在区间内）。
    expect(clickScrollTarget(500, 1, 209, 0, 400)).toBe(400)
    expect(clickScrollTarget(-30, -1, 209, 0, 400)).toBe(0)
    // 500 向左走 209 落回 291，仍在区间内 → 不触发夹取
    expect(clickScrollTarget(500, -1, 209, 0, 400)).toBe(291)
  })

  it('step 非有限 / ≤0 → 不产生 NaN，原地收口到区间内', () => {
    expect(clickScrollTarget(100, 1, 0, 0, 400)).toBe(100)
    expect(clickScrollTarget(100, -1, -5, 0, 400)).toBe(100)
    expect(clickScrollTarget(100, 1, Number.NaN, 0, 400)).toBe(100)
    expect(clickScrollTarget(100, 1, Number.POSITIVE_INFINITY, 0, 400)).toBe(100)
    // current 本身越界且 step 无效 → 只收口，不滚动
    expect(clickScrollTarget(999, 1, 0, 0, 400)).toBe(400)
  })

  it('min > max 的退化区间 → 一律收口到 max（防御性，正常 DOM 几何给不出这种值）', () => {
    expect(clickScrollTarget(50, 1, 209, 400, 100)).toBe(100)
    expect(clickScrollTarget(50, -1, 209, 400, 100)).toBe(100)
  })
})
