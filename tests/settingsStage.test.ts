/**
 * 材质球舞台开关（docs/19 裁定①，T-01）单测。
 *
 * 三条语义是硬要求：
 * ① 旧档缺键 → false（默认关，双击仍走既有文件视图）；
 * ② 脏值（'yes' / 1 / 0）→ 只让这一项回 false，**同文件的 libraryDir 等字段不丢**
 *    （zod 默认行为是整份 safeParse 失败，那会让用户"库消失"，本项目在 gridDensity 上踩过）；
 * ③ 严格 true → 保留 true。
 *
 * 注意方向：showFavorites 那三个是「默认 true、只有严格 false 才关」，
 * 这个字段**相反**（默认 false、只有严格 true 才开），所以两边不能互相抄。
 */
import { describe, expect, it } from 'vitest'
import { SettingsSchema, migrateSettings, normalizeSettings } from '../src/main/settings'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'

const LIB = 'E:\\ModVault\\Library'

/** 走「读档链路」：schema 解析 → 迁移收口（与 loadSettings 同一条路） */
function readThroughSchema(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw)
  expect(parsed.success).toBe(true)
  // safeParse 成功时 data 才是 RawSettings；这里与生产同一入口
  return migrateSettings(parsed.success ? parsed.data : ({} as never))
}

describe('materialStage：读档（schema @catch + migrate）', () => {
  it('缺键 → false（旧档升级后默认关闭）', () => {
    const s = readThroughSchema({ libraryDir: LIB })
    expect(s.materialStage).toBe(false)
    expect(s.libraryDir).toBe(LIB)
  })

  it('脏值 "yes" / 1 / 0 → false，且 libraryDir 等既有字段不丢', () => {
    for (const dirty of ['yes', 1, 0, null, {}, [] as unknown]) {
      const s = readThroughSchema({ libraryDir: LIB, materialStage: dirty, gridDensity: 'small' })
      expect(s.materialStage).toBe(false)
      // 关键断言：整份设置没有被回退成默认值
      expect(s.libraryDir).toBe(LIB)
      expect(s.gridDensity).toBe('small')
    }
  })

  it('严格 true → 保留 true', () => {
    const s = readThroughSchema({ libraryDir: LIB, materialStage: true })
    expect(s.materialStage).toBe(true)
  })
})

describe('materialStage：写档归一化（normalizeSettings）', () => {
  it('缺键 / 脏值 → false，true → true', () => {
    expect(normalizeSettings({ libraryDir: LIB }).materialStage).toBe(false)
    expect(
      normalizeSettings({ libraryDir: LIB, materialStage: 'yes' as unknown as boolean }).materialStage
    ).toBe(false)
    expect(
      normalizeSettings({ libraryDir: LIB, materialStage: 1 as unknown as boolean }).materialStage
    ).toBe(false)
    expect(normalizeSettings({ libraryDir: LIB, materialStage: true }).materialStage).toBe(true)
  })

  it('默认值与 showFavorites 方向相反（防抄反）', () => {
    expect(DEFAULT_SETTINGS.materialStage).toBe(false)
    expect(DEFAULT_SETTINGS.showFavorites).toBe(true)
  })
})
