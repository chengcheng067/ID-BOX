/**
 * `src/shared/homeTide.ts` 零依赖纯函数单测（docs/55 §1.1 / §4-T1）。
 *
 * 三个函数守住首页数据落盘前的最后一道口径：
 * - `clampWaveHeight`：非数 → 0.65；越界夹到 [0.2, 1.5]（边界本身原样保留）；
 * - `validHexOrNull`：只认六位 hex，非法 → null（= 未自定义，渲染层回落原 palette）；
 * - `clampDimAlpha`：非数 → 0.35；越界夹到 [0, 0.85]。
 *
 * 另附一条源码守卫：`HEX_PATTERN` 必须从 `HomeParticles.tsx` re-export 且主体定义在
 * shared 模块中 —— 保证主进程 schema 与渲染层用的是同一份正则，不漂移。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HEX_PATTERN,
  clampDimAlpha,
  clampWaveHeight,
  validHexOrNull
} from '../src/shared/homeTide'
import {
  HOME_PARTICLE_DENSITY_RANGE,
  HOME_PARTICLE_SIZE_RANGE,
  HOME_WAVE_LENGTH_RANGE,
  HOME_WAVE_SPEED_RANGE,
  clampHomeTideNumber
} from '../src/shared/types'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

// ── HEX_PATTERN ──────────────────────────────────────────────────────────

describe('HEX_PATTERN', () => {
  it('只认 #RRGGBB 六位，大小写都可', () => {
    expect(HEX_PATTERN.test('#aabbcc')).toBe(true)
    expect(HEX_PATTERN.test('#AABBCC')).toBe(true)
    expect(HEX_PATTERN.test('#aBcDeF')).toBe(true)
  })

  it('拒绝三位 / 无 # / 非 hex 字符 / 多余空白', () => {
    expect(HEX_PATTERN.test('#fff')).toBe(false)
    expect(HEX_PATTERN.test('aabbcc')).toBe(false)
    expect(HEX_PATTERN.test('#gggggg')).toBe(false)
    expect(HEX_PATTERN.test('#aabbcc ')).toBe(false)
    expect(HEX_PATTERN.test('')).toBe(false)
  })

  it('无 g 标志 → 连续 .test() 不受 lastIndex 影响', () => {
    expect(HEX_PATTERN.flags).not.toContain('g')
    expect(HEX_PATTERN.test('#123456')).toBe(true)
    expect(HEX_PATTERN.test('#123456')).toBe(true)
  })
})

// ── clampWaveHeight ──────────────────────────────────────────────────────

describe('clampWaveHeight', () => {
  it('非数 / NaN / Infinity 一律回落默认 0.65', () => {
    const dirties: unknown[] = [undefined, null, '0.65', 'large', true, {}, [], NaN, Infinity, -Infinity]
    for (const v of dirties) expect(clampWaveHeight(v)).toBe(0.65)
  })

  it('合法区间内原样保留，边界值不被动', () => {
    expect(clampWaveHeight(0.2)).toBe(0.2)
    expect(clampWaveHeight(0.65)).toBe(0.65)
    expect(clampWaveHeight(1.5)).toBe(1.5)
    expect(clampWaveHeight(0.87)).toBe(0.87)
  })

  it('越界数值夹到 [0.2, 1.5]', () => {
    expect(clampWaveHeight(0.1)).toBe(0.2)
    expect(clampWaveHeight(-3)).toBe(0.2)
    expect(clampWaveHeight(1.51)).toBe(1.5)
    expect(clampWaveHeight(99)).toBe(1.5)
  })
})

// ── validHexOrNull ───────────────────────────────────────────────────────

describe('validHexOrNull', () => {
  it('合法六位 hex 原样返回（含大写）', () => {
    expect(validHexOrNull('#aabbcc')).toBe('#aabbcc')
    expect(validHexOrNull('#AABBCC')).toBe('#AABBCC')
  })

  it('非法值一律 null —— "未自定义"语义', () => {
    const dirties: unknown[] = [
      undefined,
      null,
      '#fff',
      'aabbcc',
      '#gggggg',
      'red',
      123,
      true,
      {},
      []
    ]
    for (const v of dirties) expect(validHexOrNull(v)).toBe(null)
  })
})

// ── clampDimAlpha ────────────────────────────────────────────────────────

describe('clampDimAlpha', () => {
  it('非数 / NaN / Infinity 一律回落默认 0.35', () => {
    const dirties: unknown[] = [undefined, null, '0.35', 'dark', false, {}, NaN, Infinity, -Infinity]
    for (const v of dirties) expect(clampDimAlpha(v)).toBe(0.35)
  })

  it('合法区间内原样保留，边界值不被动', () => {
    expect(clampDimAlpha(0)).toBe(0)
    expect(clampDimAlpha(0.35)).toBe(0.35)
    expect(clampDimAlpha(0.85)).toBe(0.85)
  })

  it('越界数值夹到 [0, 0.85]', () => {
    expect(clampDimAlpha(-1)).toBe(0)
    expect(clampDimAlpha(0.9)).toBe(0.85)
    expect(clampDimAlpha(1)).toBe(0.85)
    expect(clampDimAlpha(100)).toBe(0.85)
  })
})

// ── clampHomeTideNumber（2026-11-22 海浪参数重排，shared/types） ─────────────

describe('clampHomeTideNumber', () => {
  const RANGE = HOME_WAVE_SPEED_RANGE

  it('非数 / NaN / Infinity 一律回落默认（脏值没有方向，不夹到边界）', () => {
    const dirties: unknown[] = [undefined, null, '1.6', 'fast', true, {}, [], NaN, Infinity, -Infinity]
    for (const v of dirties) expect(clampHomeTideNumber(v, RANGE)).toBe(RANGE.default)
  })

  it('合法区间内原样保留，边界值不被动', () => {
    expect(clampHomeTideNumber(RANGE.min, RANGE)).toBe(RANGE.min)
    expect(clampHomeTideNumber(RANGE.default, RANGE)).toBe(RANGE.default)
    expect(clampHomeTideNumber(RANGE.max, RANGE)).toBe(RANGE.max)
    expect(clampHomeTideNumber(1.23, RANGE)).toBe(1.23)
  })

  it('越界数值夹回区间（四个 RANGE 都验一遍）', () => {
    for (const range of [
      HOME_WAVE_SPEED_RANGE,
      HOME_WAVE_LENGTH_RANGE,
      HOME_PARTICLE_SIZE_RANGE,
      HOME_PARTICLE_DENSITY_RANGE
    ]) {
      expect(clampHomeTideNumber(range.min - 1, range)).toBe(range.min)
      expect(clampHomeTideNumber(range.max + 1, range)).toBe(range.max)
      expect(clampHomeTideNumber(-100, range)).toBe(range.min)
      expect(clampHomeTideNumber(10000, range)).toBe(range.max)
    }
  })
})

// ── 源码守卫：同一份正则 ─────────────────────────────────────────────────

describe('源码守卫 · HEX_PATTERN 单一真源', () => {
  it('shared 模块里定义正则本体', () => {
    const src = read('src/shared/homeTide.ts')
    expect(src).toMatch(/export const HEX_PATTERN:\s*RegExp\s*=\s*\/\^#\[0-9a-f\]\{6\}\$\/i/)
  })

  it('HomeParticles 从 shared re-export（不再自带第二份正则字面量）', () => {
    const src = read('src/renderer/components/home/HomeParticles.tsx')
    expect(src).toContain("export { HEX_PATTERN } from '../../../shared/homeTide'")
    // 原字面量不得残留（否则两处正则会漂移）
    expect(src).not.toContain('/^#[0-9a-f]{6}$/i')
    // 本地仍有 import：:290 的 readCanvasBackground 要用它判断 --bg-canvas
    expect(src).toContain("import { HEX_PATTERN } from '../../../shared/homeTide'")
  })
})
