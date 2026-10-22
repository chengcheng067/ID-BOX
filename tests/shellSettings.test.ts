/**
 * UI 规范 v0.2 外壳层设置单测（2026-10 shell-engineer）。
 *
 * 覆盖本轮新增的两个设置字段（shared/types.ts + main/settings.ts）：
 * - `theme`：仅 light/dark，非法值回落默认浅色（规范 §1）；
 * - `extractConcurrency`：默认 2，夹到 [1, 8]（规范 §3.6 导入 tab stepper）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { normalizeSettings, SettingsSchema } from '../src/main/settings'

const base = (): Partial<Settings> => ({
  libraryDir: 'E:\\ModVault\\Library'
})

describe('theme 设置（UI 规范 §1）', () => {
  it('默认主题为浅色（Soft UI）', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('light')
    expect(normalizeSettings(base()).theme).toBe('light')
  })

  it('显式选择深色被保留', () => {
    expect(normalizeSettings({ ...base(), theme: 'dark' }).theme).toBe('dark')
  })

  it('非法主题值（含旧档脏值）回落浅色，不抛错', () => {
    expect(normalizeSettings({ theme: 'blue' } as unknown as Partial<Settings>).theme).toBe('light')
    expect(normalizeSettings({ theme: undefined }).theme).toBe('light')
  })
})

describe('extractConcurrency 设置（UI 规范 §3.6 stepper）', () => {
  it('默认值为 2（规范 §3.6 拍板）', () => {
    expect(DEFAULT_SETTINGS.extractConcurrency).toBe(2)
    expect(normalizeSettings(base()).extractConcurrency).toBe(2)
  })

  it('合法值 1-8 原样保留', () => {
    expect(normalizeSettings({ ...base(), extractConcurrency: 1 }).extractConcurrency).toBe(1)
    expect(normalizeSettings({ ...base(), extractConcurrency: 8 }).extractConcurrency).toBe(8)
  })

  it('越界值被夹回 [1, 8]，小数取整', () => {
    expect(normalizeSettings({ ...base(), extractConcurrency: 0 }).extractConcurrency).toBe(1)
    expect(normalizeSettings({ ...base(), extractConcurrency: 99 }).extractConcurrency).toBe(8)
    expect(normalizeSettings({ ...base(), extractConcurrency: 3.6 }).extractConcurrency).toBe(4)
  })

  it('非法输入（NaN）回落默认 2', () => {
    expect(
      normalizeSettings({ ...base(), extractConcurrency: Number.NaN }).extractConcurrency
    ).toBe(2)
  })
})

// ── 知末封面两个开关（docs/24 §3.5）──────────────────────────────────────
//
// 方向与 materialStage / verboseLogging **相反**：那两个默认关，这两个默认开
// （装上就有效果）。归一化必须**各自独立**，否则用户关一次总开关会丢掉子偏好。
describe('zhimoCover 设置（知末封面抓取）', () => {
  it('缺键 → 两项都默认 true', () => {
    expect(DEFAULT_SETTINGS.zhimoCover).toBe(true)
    expect(DEFAULT_SETTINGS.zhimoCoverReplacePacked).toBe(true)
    const s = normalizeSettings(base())
    expect(s.zhimoCover).toBe(true)
    expect(s.zhimoCoverReplacePacked).toBe(true)
  })

  it('严格 false 被保留（两项各自独立）', () => {
    const s = normalizeSettings({ ...base(), zhimoCover: false, zhimoCoverReplacePacked: false })
    expect(s.zhimoCover).toBe(false)
    expect(s.zhimoCoverReplacePacked).toBe(false)
    // 单项关闭不影响另一项
    expect(normalizeSettings({ ...base(), zhimoCover: false }).zhimoCoverReplacePacked).toBe(true)
    expect(normalizeSettings({ ...base(), zhimoCoverReplacePacked: false }).zhimoCover).toBe(true)
  })

  it('脏值（"yes" / 1 / null）→ 回落 true，且不抛错', () => {
    const dirty = [
      { zhimoCover: 'yes', zhimoCoverReplacePacked: 1 },
      { zhimoCover: null, zhimoCoverReplacePacked: 'no' },
      { zhimoCover: 0, zhimoCoverReplacePacked: {} }
    ]
    for (const patch of dirty) {
      const s = normalizeSettings({ ...base(), ...patch } as unknown as Partial<Settings>)
      expect(s.zhimoCover).toBe(true)
      expect(s.zhimoCoverReplacePacked).toBe(true)
    }
  })

  it('总开关为 false 时，子开关的显式 false 不被改写（不丢子偏好）', () => {
    const s = normalizeSettings({ ...base(), zhimoCover: false, zhimoCoverReplacePacked: false })
    expect(s.zhimoCover).toBe(false)
    expect(s.zhimoCoverReplacePacked).toBe(false)
    // 反向：总开关关、子开关开 → 子开关仍是 true（不能因为总开关关而顺手改 false）
    const s2 = normalizeSettings({ ...base(), zhimoCover: false, zhimoCoverReplacePacked: true })
    expect(s2.zhimoCover).toBe(false)
    expect(s2.zhimoCoverReplacePacked).toBe(true)
  })
})

describe('zhimoCover 的 zod 单项降级（脏值不拖垮整份 settings.json）', () => {
  it('脏值只让该字段回落 true，safeParse 仍成功（libraryDir 不丢）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: 'E:\Library',
      zhimoCover: 'yes',
      zhimoCoverReplacePacked: 1
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // `.catch(true)`：脏值回落默认开，而不是让整份 safeParse 失败
      expect(parsed.data.zhimoCover).toBe(true)
      expect(parsed.data.zhimoCoverReplacePacked).toBe(true)
      expect(parsed.data.libraryDir).toBe('E:\Library')
    }
  })

  it('缺键不产出该字段（由 DEFAULT_SETTINGS 兜底 true）', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\Library' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.zhimoCover).toBeUndefined()
      expect(parsed.data.zhimoCoverReplacePacked).toBeUndefined()
    }
  })
})
