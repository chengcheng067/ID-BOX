/**
 * 首页自定义 6 字段的**设置迁移三处齐全**守卫（docs/55 §1.1 / §4-T1 验收判据 1-3）。
 *
 * 背景（本项目反复踩过的坑）：settings.json 一旦因某个新字段的脏值导致
 * `SettingsSchema.safeParse` 整体失败，`loadSettings` 会回落默认 →
 * `libraryDir` 一起丢 → 用户看到"库空了"。所以新字段必须**每项叶子单独降级**，
 * 并把「含全部脏值的对象仍能 safeParse 成功且 libraryDir 保持」钉成测试。
 *
 * 环境是 vitest `node`（无 jsdom/RTL）：数据面跑真代码，接线面沿
 * `tests/classifyUiWiring.test.ts` 的 `readSrc()` 范式做源码守卫。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import {
  HOME_PARTICLE_DENSITY_RANGE,
  HOME_PARTICLE_SIZE_RANGE,
  HOME_WAVE_LENGTH_RANGE,
  HOME_WAVE_SPEED_RANGE
} from '../src/shared/types'
import { SettingsSchema, migrateSettings, normalizeSettings } from '../src/main/settings'

const LIB = 'E:\\ModVault\\Library'
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

/** 取 src 中 marker..endMarker 之间的文本（行首大括号才算结束，避开缩进的嵌套括号）。 */
function blockAfter(src: string, marker: string, endMarker: string): string {
  const start = src.indexOf(marker)
  expect(start, `找不到 ${marker}`).toBeGreaterThan(-1)
  const end = src.indexOf(endMarker, start + marker.length)
  expect(end, `找不到 ${endMarker}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** SettingsSchema 的 z.object({...}) 主体（用于逐字段断言 `.catch`）。 */
function schemaBlock(): string {
  return blockAfter(read('src/main/settings.ts'), 'export const SettingsSchema = z.object({', '\n})')
}

/** 某一顶层字段从它自己到下一个顶层字段之间的源码片段。 */
function fieldSegment(block: string, field: string): string {
  const matches = [...block.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)]
  const idx = matches.findIndex((m) => m[1] === field)
  expect(idx, `schema 缺少字段 ${field}`).toBeGreaterThan(-1)
  const from = matches[idx].index as number
  const to = idx + 1 < matches.length ? (matches[idx + 1].index as number) : block.length
  return block.slice(from, to)
}

const NEW_FIELDS = [
  'homeWaveColors',
  'homeWaveHeight',
  'homeBackground',
  'homeGuideFirstRunShown',
  'homeGuideLastVersion',
  'homeGuideDisabled',
  // 2026-11-22 海浪参数重排：六个新字段与上面六字段同一纪律（叶子单项降级）
  'homeWaveSpeed',
  'homeWaveLength',
  'homeParticleSize',
  'homeParticleDensity',
  'homeWaveInteractive',
  'homeWaveClickRipples'
] as const

const ZERO_WAVE_COLORS: Settings['homeWaveColors'] = {
  light: { waterColor: null, crestColor: null },
  dark: { waterColor: null, crestColor: null }
}
const ZERO_BACKGROUND: Settings['homeBackground'] = {
  source: 'none',
  fileName: null,
  sourceUrl: null,
  dimAlpha: 0.35
}

// ── 判据 1：类型 + 默认值三处齐全 ───────────────────────────────────────

describe('T1 判据1 · Settings / DEFAULT_SETTINGS 六字段齐全', () => {
  it('运行时默认值逐项正确', () => {
    expect(DEFAULT_SETTINGS.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(DEFAULT_SETTINGS.homeWaveHeight).toBe(0.65)
    expect(DEFAULT_SETTINGS.homeBackground).toEqual(ZERO_BACKGROUND)
    expect(DEFAULT_SETTINGS.homeGuideFirstRunShown).toBe(false)
    expect(DEFAULT_SETTINGS.homeGuideLastVersion).toBe(null)
    expect(DEFAULT_SETTINGS.homeGuideDisabled).toBe(false)
  })

  it('源码守卫：Settings 接口与 DEFAULT_SETTINGS 都出现六字段名', () => {
    const typesSrc = read('src/shared/types.ts')
    const iface = blockAfter(typesSrc, 'export interface Settings {', '\n}\n')
    const defaults = blockAfter(typesSrc, 'export const DEFAULT_SETTINGS', '\n}\n')
    for (const field of NEW_FIELDS) {
      expect(iface, `Settings 缺 ${field}`).toContain(field)
      expect(defaults, `DEFAULT_SETTINGS 缺 ${field}`).toContain(field)
    }
  })
})

// ── 判据 2：单项降级 schema + normalize clamp ────────────────────────────

describe('T1 判据2 · SettingsSchema 每项叶子单项降级', () => {
  const block = schemaBlock()

  it('源码守卫：六个新字段各自带 `.catch(`', () => {
    for (const field of NEW_FIELDS) {
      const seg = fieldSegment(block, field)
      expect(seg, `${field} 没有单项降级`).toContain('.catch(')
    }
  })

  it('源码守卫：海浪颜色叶子复用 shared 的 HEX_PATTERN 且非法→null', () => {
    const src = read('src/main/settings.ts')
    expect(src).toContain("from '../shared/homeTide'")
    expect(src).toContain('z.string().regex(HEX_PATTERN).nullable().optional().catch(null)')
  })

  it('源码守卫：背景 source / dimAlpha 的 catch 默认与 clamp 入口都在', () => {
    const bg = fieldSegment(block, 'homeBackground')
    expect(bg).toContain("z.enum(['none', 'local', 'url']).catch('none')")
    expect(bg).toContain('dimAlpha: z.number().catch(0.35)')
    const src = read('src/main/settings.ts')
    expect(src).toContain('clampWaveHeight(')
    expect(src).toContain('clampDimAlpha(')
  })

  it('脏 hex 只回落那一片叶子，合法叶子保留（逐叶子粒度）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      homeWaveColors: {
        light: { waterColor: '#gggggg', crestColor: 123 },
        dark: { waterColor: null, crestColor: '#123456' }
      }
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.homeWaveColors).toEqual({
      light: { waterColor: null, crestColor: null },
      dark: { waterColor: null, crestColor: '#123456' }
    })
  })

  it('六个字段全部脏值 → safeParse 成功且各自回落默认', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      homeWaveColors: {
        light: { waterColor: '#zzz', crestColor: 999 },
        dark: { waterColor: 'red', crestColor: '#fff' }
      },
      homeWaveHeight: 'huge',
      homeBackground: { source: 'hacked', fileName: 42, sourceUrl: true, dimAlpha: 'dark' },
      homeGuideFirstRunShown: 'yes',
      homeGuideLastVersion: 99,
      homeGuideDisabled: 1
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(parsed.data.homeWaveHeight).toBe(0.65)
    expect(parsed.data.homeBackground).toEqual(ZERO_BACKGROUND)
    expect(parsed.data.homeGuideFirstRunShown).toBe(false)
    expect(parsed.data.homeGuideLastVersion).toBe(null)
    expect(parsed.data.homeGuideDisabled).toBe(false)
  })

  it('整块写坏（字符串 / 数字）也只回落该块，不炸整份设置', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      homeWaveColors: 'totally-wrong',
      homeBackground: 42
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.libraryDir).toBe(LIB)
    expect(parsed.data.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(parsed.data.homeBackground).toEqual(ZERO_BACKGROUND)
  })
})

// ── 判据 3：含脏值的主字段 libraryDir 保持 ───────────────────────────────

describe('T1 判据3 · 脏值绝不拖垮整份 settings.json（libraryDir 保持在）', () => {
  it('★全部脏值对象：safeParse 成功 + migrateSettings 后 libraryDir 原样', () => {
    const dirty = {
      libraryDir: LIB,
      homeWaveColors: { light: { waterColor: 'oops', crestColor: 1 }, dark: null },
      homeWaveHeight: 'yes',
      homeBackground: { source: 1, fileName: [], sourceUrl: {}, dimAlpha: null },
      homeGuideFirstRunShown: 1,
      homeGuideLastVersion: false,
      homeGuideDisabled: 'false'
    }
    const parsed = SettingsSchema.safeParse(dirty)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.libraryDir).toBe(LIB)

    const s = migrateSettings(parsed.data)
    expect(s.libraryDir).toBe(LIB)
    expect(s.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(s.homeWaveHeight).toBe(0.65)
    expect(s.homeBackground).toEqual(ZERO_BACKGROUND)
    expect(s.homeGuideFirstRunShown).toBe(false)
    expect(s.homeGuideLastVersion).toBe(null)
    expect(s.homeGuideDisabled).toBe(false)
  })

  it('旧档缺键（只有 libraryDir）→ 全默认，行为与今天逐字一致', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: LIB })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.libraryDir).toBe(LIB)
    expect(s.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(s.homeWaveHeight).toBe(0.65)
    expect(s.homeBackground).toEqual(ZERO_BACKGROUND)
    expect(s.homeGuideFirstRunShown).toBe(false)
    expect(s.homeGuideLastVersion).toBe(null)
    expect(s.homeGuideDisabled).toBe(false)
  })
})

// ── 2026-11-22 海浪参数重排：六个新字段的数据面 ─────────────────────────────

describe('海浪参数重排 · 默认值 = 引擎定稿值（默认画面逐帧一致）', () => {
  it('DEFAULT_SETTINGS 六项默认与改动前引擎硬编码一致', () => {
    expect(DEFAULT_SETTINGS.homeWaveSpeed).toBe(1.6) // 旧 BASE_SPEED
    expect(DEFAULT_SETTINGS.homeWaveLength).toBe(1.1) // 旧 BASE_WAVELENGTH
    expect(DEFAULT_SETTINGS.homeParticleSize).toBe(2) // 旧 palette.particleSize
    expect(DEFAULT_SETTINGS.homeParticleDensity).toBe(1.5) // 旧 palette.density
    expect(DEFAULT_SETTINGS.homeWaveInteractive).toBe(true)
    expect(DEFAULT_SETTINGS.homeWaveClickRipples).toBe(true)
    // shared RANGE.default 与 DEFAULT_SETTINGS 同源（防两处漂移）
    expect(HOME_WAVE_SPEED_RANGE.default).toBe(DEFAULT_SETTINGS.homeWaveSpeed)
    expect(HOME_WAVE_LENGTH_RANGE.default).toBe(DEFAULT_SETTINGS.homeWaveLength)
    expect(HOME_PARTICLE_SIZE_RANGE.default).toBe(DEFAULT_SETTINGS.homeParticleSize)
    expect(HOME_PARTICLE_DENSITY_RANGE.default).toBe(DEFAULT_SETTINGS.homeParticleDensity)
  })
})

describe('海浪参数重排 · schema 单项降级 + clamp 收口', () => {
  it('六个字段全部脏值 → safeParse 成功且各自回落默认', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      homeWaveSpeed: 'fast',
      homeWaveLength: null,
      homeParticleSize: true,
      homeParticleDensity: {},
      homeWaveInteractive: 'yes',
      homeWaveClickRipples: 0
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.homeWaveSpeed).toBe(1.6)
    expect(parsed.data.homeWaveLength).toBe(1.1)
    expect(parsed.data.homeParticleSize).toBe(2)
    expect(parsed.data.homeParticleDensity).toBe(1.5)
    expect(parsed.data.homeWaveInteractive).toBe(true)
    expect(parsed.data.homeWaveClickRipples).toBe(true)
  })

  it('越界数值 migrateSettings 夹回区间；布尔只认严格 false 才关', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      homeWaveSpeed: 99,
      homeWaveLength: 0.01,
      homeParticleSize: 100,
      homeParticleDensity: 0.01,
      homeWaveInteractive: false,
      homeWaveClickRipples: 'x'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.homeWaveSpeed).toBe(HOME_WAVE_SPEED_RANGE.max)
    expect(s.homeWaveLength).toBe(HOME_WAVE_LENGTH_RANGE.min)
    expect(s.homeParticleSize).toBe(HOME_PARTICLE_SIZE_RANGE.max)
    expect(s.homeParticleDensity).toBe(HOME_PARTICLE_DENSITY_RANGE.min)
    expect(s.homeWaveInteractive).toBe(false)
    expect(s.homeWaveClickRipples).toBe(true) // 'x' 不是严格 false → 开
  })

  it('★新六字段全脏 + 老六字段全脏：libraryDir 保持在，新旧默认各自回落', () => {
    const dirty = {
      libraryDir: LIB,
      homeWaveColors: 'oops',
      homeWaveHeight: 'huge',
      homeBackground: 42,
      homeGuideFirstRunShown: 1,
      homeGuideLastVersion: 99,
      homeGuideDisabled: 'false',
      homeWaveSpeed: 'fast',
      homeWaveLength: null,
      homeParticleSize: true,
      homeParticleDensity: {},
      homeWaveInteractive: 'yes',
      homeWaveClickRipples: 0
    }
    const parsed = SettingsSchema.safeParse(dirty)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.libraryDir).toBe(LIB)
    expect(s.homeWaveColors).toEqual(ZERO_WAVE_COLORS)
    expect(s.homeWaveHeight).toBe(0.65)
    expect(s.homeBackground).toEqual(ZERO_BACKGROUND)
    expect(s.homeWaveSpeed).toBe(1.6)
    expect(s.homeWaveLength).toBe(1.1)
    expect(s.homeParticleSize).toBe(2)
    expect(s.homeParticleDensity).toBe(1.5)
    expect(s.homeWaveInteractive).toBe(true)
    expect(s.homeWaveClickRipples).toBe(true)
  })

  it('normalizeSettings（写档路径）同样收口：越界夹回、脏布尔只认严格 false', () => {
    const s = normalizeSettings({
      libraryDir: LIB,
      homeWaveSpeed: 99,
      homeWaveLength: -5,
      homeParticleSize: 0.5,
      homeParticleDensity: 7,
      homeWaveInteractive: 'no',
      homeWaveClickRipples: false
    } as unknown as Partial<Settings>)
    expect(s.homeWaveSpeed).toBe(HOME_WAVE_SPEED_RANGE.max)
    expect(s.homeWaveLength).toBe(HOME_WAVE_LENGTH_RANGE.min)
    expect(s.homeParticleSize).toBe(HOME_PARTICLE_SIZE_RANGE.min)
    expect(s.homeParticleDensity).toBe(HOME_PARTICLE_DENSITY_RANGE.max)
    expect(s.homeWaveInteractive).toBe(true) // 'no' 不是严格 false → 开
    expect(s.homeWaveClickRipples).toBe(false)
  })
})

// ── normalizeSettings 收口（写档路径）────────────────────────────────────

describe('normalizeSettings · 浪高 / 压暗 clamp 与引导布尔收口', () => {
  it('越界数值夹到区间；合法 hex 保留、非法 hex 归 null', () => {
    const s = normalizeSettings({
      libraryDir: LIB,
      homeWaveHeight: 99,
      homeBackground: { source: 'local', fileName: 'sea.png', sourceUrl: null, dimAlpha: 5 },
      homeWaveColors: {
        light: { waterColor: '#AABBCC', crestColor: 'red' },
        dark: { waterColor: null, crestColor: null }
      }
    } as Partial<Settings>)
    expect(s.homeWaveHeight).toBe(1.5)
    expect(s.homeBackground.dimAlpha).toBe(0.85)
    expect(s.homeBackground.source).toBe('local')
    expect(s.homeBackground.fileName).toBe('sea.png')
    expect(s.homeWaveColors.light.waterColor).toBe('#AABBCC')
    expect(s.homeWaveColors.light.crestColor).toBe(null)
  })

  it('下界同样收口（浪高 0.1 → 0.2，压暗 -1 → 0）', () => {
    const s = normalizeSettings({
      libraryDir: LIB,
      homeWaveHeight: 0.1,
      homeBackground: { ...ZERO_BACKGROUND, dimAlpha: -1 }
    })
    expect(s.homeWaveHeight).toBe(0.2)
    expect(s.homeBackground.dimAlpha).toBe(0)
  })

  it('引导三项脏值收口：boolean 只认 true，版本号非字符串 → null', () => {
    const s = normalizeSettings({
      libraryDir: LIB,
      homeGuideFirstRunShown: 'yes',
      homeGuideLastVersion: 123,
      homeGuideDisabled: 1
    } as unknown as Partial<Settings>)
    expect(s.homeGuideFirstRunShown).toBe(false)
    expect(s.homeGuideLastVersion).toBe(null)
    expect(s.homeGuideDisabled).toBe(false)
  })

  it('写档归一化也绝不丢 libraryDir', () => {
    expect(normalizeSettings({ libraryDir: LIB }).libraryDir).toBe(LIB)
  })
})
