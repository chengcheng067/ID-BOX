/**
 * 「关闭窗口时」三档（`ask` = 每次询问【默认】 · `quit` = 彻底退出 · `tray` = 退至后台）。
 *
 * 2026-11 用户需求原话：「我需要做一个后台常驻的功能，让用户选择彻底关闭还是常驻后台」，
 * 后续追加：「需要有弹窗。如果用户没有在弹窗上默认勾选"记住"的设置，那么以后都会弹窗」。
 *
 * 已定口径：**默认 `'ask'`**（点 ✕ 先弹窗问一次，用户在弹窗里勾「记住我的选择」才免打扰）。
 * ⚠️ 默认档从旧版的 `'quit'` 改成了 `'ask'` —— 老档缺键的升级用户因此落到「每次询问」，
 * 这是**刻意**的：静默退出会掐断正在跑的导入与分类，多问一次的成本只是点一下。
 *
 * 这份守卫钉三件事：
 * ① `DEFAULT_SETTINGS.closeBehavior === 'ask'` —— 默认值不许被改回静默退出；
 * ② `normalizeCloseBehavior` 是唯一归一化入口：三值原样保留，脏值（含缺键）一律 `'ask'`；
 * ③ zod 侧**单项降级**：`closeBehavior` 写坏不能拖垮整份 settings.json（`libraryDir` 必须还在
 *    —— 这个仓库在 gridDensity / trashRetention / motionQuality 上都踩过"裸 enum 让整份
 *    parse 失败"的坑）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  SettingsSchema,
  migrateSettings,
  normalizeCloseBehavior,
  normalizeSettings,
  planCloseBehaviorMigration
} from '../src/main/settings'

/** 剥注释（守卫"不该存在的东西"时防注释里的词误伤，见 categoryPicker.test.ts 同款） */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('DEFAULT_SETTINGS.closeBehavior', () => {
  it('默认「每次询问」= 点 ✕ 先弹窗问一次，用户选了才执行', () => {
    expect(DEFAULT_SETTINGS.closeBehavior).toBe('ask')
  })
})

describe('normalizeCloseBehavior（唯一归一化入口）', () => {
  it('三个合法档位原样保留', () => {
    expect(normalizeCloseBehavior('ask')).toBe('ask')
    expect(normalizeCloseBehavior('quit')).toBe('quit')
    expect(normalizeCloseBehavior('tray')).toBe('tray')
  })

  it('缺键 / 脏值一律回落 ask（每次询问都比静默退出安全）', () => {
    for (const dirty of [
      undefined,
      null,
      '',
      'TRAY',
      'Tray',
      'tray ',
      'ASK',
      'Quit',
      'minimize',
      'hide',
      1,
      0,
      true,
      {},
      []
    ]) {
      expect(normalizeCloseBehavior(dirty), JSON.stringify(dirty)).toBe('ask')
    }
  })
})

describe('SettingsSchema：closeBehavior 单项降级', () => {
  it('缺键 → 不报错，parse 后为 undefined（由 normalize 收口成 ask）', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.closeBehavior).toBeUndefined()
  })

  it('脏值只让这一项回落 ask，libraryDir 不被拖垮', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehavior: 'minimize' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.closeBehavior).toBe('ask')
      expect(parsed.data.libraryDir).toBe('E:\\Lib')
    }
  })

  it("'tray' 能过 schema", () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehavior: 'tray' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.closeBehavior).toBe('tray')
  })

  it("'ask' / 'quit' 都能过 schema", () => {
    for (const value of ['ask', 'quit'] as const) {
      const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehavior: value })
      expect(parsed.success, value).toBe(true)
      if (parsed.success) expect(parsed.data.closeBehavior).toBe(value)
    }
  })
})

describe('normalizeSettings（写档前收口）', () => {
  it('缺键 → 补默认 ask', () => {
    expect(normalizeSettings({}).closeBehavior).toBe('ask')
  })

  it('quit / tray 原样保留（用户主动选择不能被归一化吃掉）', () => {
    expect(normalizeSettings({ closeBehavior: 'quit' }).closeBehavior).toBe('quit')
    expect(normalizeSettings({ closeBehavior: 'tray' }).closeBehavior).toBe('tray')
  })

  it('脏值 → ask', () => {
    // 渲染层 patch 可能带进任意值，归一化后必须是合法档位
    expect(normalizeSettings({ closeBehavior: 'background' as never }).closeBehavior).toBe('ask')
  })
})

describe('migrateSettings（读档侧收口）', () => {
  it('旧档缺 closeBehavior → ask（升级后先被问一次，不是静默退出）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', theme: 'dark' })
    const next = migrateSettings(raw)
    expect(next.closeBehavior).toBe('ask')
    // 其余字段照旧读进来，迁移没有副作用
    expect(next.libraryDir).toBe('E:\\Lib')
    expect(next.theme).toBe('dark')
  })

  it('已选「退至后台」的档读回来仍是 tray', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', closeBehavior: 'tray' })
    expect(migrateSettings(raw).closeBehavior).toBe('tray')
  })

  it('已选「彻底退出」的档读回来仍是 quit（记住过的选择不能被改回 ask）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', closeBehavior: 'quit' })
    expect(migrateSettings(raw).closeBehavior).toBe('quit')
  })
})

// ── 「关闭窗口时」一次性迁移（2026-11-27 装机反馈，v1.2.1）──────────────
//
// 用户（杨雯丞）装 1.2.1 后反馈：初次打开新版本「关闭窗口时」落在「彻底退出」，
// 第一次点 ✕ 没有弹窗。根因：v1.2.0 及更早**没有** closeBehavior 字段（外部老用户
// 升级走默认 'ask' 是对的），但 dev / 测试期间的机器 settings.json 里已经落了残留值
// （他的是 `"closeBehavior": "tray"`），原样读入 → 不再弹。
// 产品口径：**升级到 1.2.1 后第一次必须落在「每次询问」**。

describe('planCloseBehaviorMigration（一次性迁移决策，纯函数）', () => {
  it('残留档（标记缺省 / false + closeBehavior=tray）→ 强制 ask + 标记 true + 需要写盘', () => {
    // 用户杨雯丞的档就是这个形态：1.2.0 dev 期间落下的 tray + 没有标记
    for (const flag of [undefined, false]) {
      const planned = planCloseBehaviorMigration({
        ...DEFAULT_SETTINGS,
        libraryDir: 'E:\\Lib',
        closeBehavior: 'tray',
        closeBehaviorMigrated: flag
      } as never)
      expect(planned, `flag=${String(flag)}`).not.toBeNull()
      expect(planned!.closeBehavior).toBe('ask')
      expect(planned!.closeBehaviorMigrated).toBe(true)
      // 迁移不得动其它字段（libraryDir 是"库空了"的命根子）
      expect(planned!.libraryDir).toBe('E:\\Lib')
    }
  })

  it('残留档 closeBehavior=quit 同样强制回 ask（1.2.1 前写出的档一律视为未确认）', () => {
    const planned = planCloseBehaviorMigration({
      ...DEFAULT_SETTINGS,
      closeBehavior: 'quit',
      closeBehaviorMigrated: false
    })
    expect(planned).not.toBeNull()
    expect(planned!.closeBehavior).toBe('ask')
  })

  it('标记已 true + 用户显式 quit / tray → 原样保留（不迁移、不写盘）', () => {
    // 迁移只跑一次：之后用户在弹窗勾「记住我的选择」或设置页切的档永远不被再动
    expect(
      planCloseBehaviorMigration({ ...DEFAULT_SETTINGS, closeBehavior: 'quit', closeBehaviorMigrated: true })
    ).toBeNull()
    expect(
      planCloseBehaviorMigration({ ...DEFAULT_SETTINGS, closeBehavior: 'tray', closeBehaviorMigrated: true })
    ).toBeNull()
    expect(
      planCloseBehaviorMigration({ ...DEFAULT_SETTINGS, closeBehavior: 'ask', closeBehaviorMigrated: true })
    ).toBeNull()
  })

  it('全新安装（两键皆无 → DEFAULT_SETTINGS 兜底）→ ask + 标记 true + 需要写盘', () => {
    // DEFAULT_SETTINGS 本身就是 ask + 标记 false：翻牌是为了让"标记已落盘"对三种
    // 档形态都成立 —— 否则新装用户第一次勾「记住：彻底退出」落盘的档里标记还是
    // false，下次启动又被强制回 ask（等于他选的档被吃掉）。
    const planned = planCloseBehaviorMigration({ ...DEFAULT_SETTINGS, libraryDir: 'E:\\Lib' })
    expect(planned).not.toBeNull()
    expect(planned!.closeBehavior).toBe('ask')
    expect(planned!.closeBehaviorMigrated).toBe(true)
  })

  it('迁移是幂等的：对已迁移的档再跑一次返回 null', () => {
    const first = planCloseBehaviorMigration({
      ...DEFAULT_SETTINGS,
      closeBehavior: 'tray',
      closeBehaviorMigrated: false
    })!
    expect(planCloseBehaviorMigration(first)).toBeNull()
  })
})

describe('SettingsSchema：closeBehaviorMigrated 单项降级', () => {
  it('缺键 → 不报错，parse 后为 undefined（由 migrateSettings 收口成 false）', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.closeBehaviorMigrated).toBeUndefined()
  })

  it('脏值（字符串 / 数字 / null / 对象）只让这一项回落 false，libraryDir 不被拖垮', () => {
    for (const dirty of ['yes', 1, null, {}]) {
      const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehaviorMigrated: dirty })
      expect(parsed.success, JSON.stringify(dirty)).toBe(true)
      if (parsed.success) {
        expect(parsed.data.closeBehaviorMigrated).toBe(false)
        expect(parsed.data.libraryDir).toBe('E:\\Lib')
      }
    }
  })

  it('严格 true 能过 schema', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: 'E:\\Lib', closeBehaviorMigrated: true })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.closeBehaviorMigrated).toBe(true)
  })
})

describe('migrateSettings：closeBehaviorMigrated 透传收口', () => {
  it('缺键 → false（未迁移，loadSettings 会接手）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib' })
    expect(migrateSettings(raw).closeBehaviorMigrated).toBe(false)
  })

  it('true 原样保留（迁移只跑一次的不变量靠它）', () => {
    const raw = SettingsSchema.parse({ libraryDir: 'E:\\Lib', closeBehaviorMigrated: true })
    expect(migrateSettings(raw).closeBehaviorMigrated).toBe(true)
  })
})

describe('normalizeSettings：closeBehaviorMigrated 写档前收口', () => {
  it('缺键 / 脏值 → false；true 原样保留', () => {
    expect(normalizeSettings({}).closeBehaviorMigrated).toBe(false)
    expect(normalizeSettings({ closeBehaviorMigrated: 'yes' as never }).closeBehaviorMigrated).toBe(false)
    expect(normalizeSettings({ closeBehaviorMigrated: true }).closeBehaviorMigrated).toBe(true)
  })

  it('显式改档（closeBehavior）不会顺手把标记抹掉 —— 设置页切档路径安全', () => {
    // settings:set 的合并链路是 {...settings, ...patch} 再 normalizeSettings：
    // 内存里的 settings 已带 true（启动迁移置的），patch 只动 closeBehavior
    const merged = normalizeSettings({
      ...DEFAULT_SETTINGS,
      closeBehaviorMigrated: true,
      closeBehavior: 'quit'
    })
    expect(merged.closeBehavior).toBe('quit')
    expect(merged.closeBehaviorMigrated).toBe(true)
  })
})

describe('loadSettings 迁移链路（源码守卫，node 环境跑不了 electron）', () => {
  const SETTINGS = 'src/main/settings.ts'
  const src = fs.readFileSync(path.join(process.cwd(), SETTINGS), 'utf8')
  const code = codeOf(src)

  it('三条读档路径（主档 / 备份 / 全新默认）都过迁移', () => {
    // loadSettings 里 applyCloseBehaviorMigration 的调用点必须有 3 处
    const calls = code.split('applyCloseBehaviorMigration(').length - 1
    expect(calls).toBeGreaterThanOrEqual(4) // 1 次函数声明 + 3 次调用
  })

  it('需要迁移时立刻写回（saveSettings），失败只告警不阻断启动', () => {
    expect(code).toMatch(/const planned = planCloseBehaviorMigration\(s\)/)
    expect(code).toMatch(/if \(!planned\) return s/)
    expect(code).toMatch(/await saveSettings\(planned\)/)
    expect(code).toMatch(/catch \(err\) \{[\s\S]{0,200}console\.warn/)
  })

  it('标记落盘后短路（迁移只跑一次），不许放在 normalizeSettings / migrateSettings 里', () => {
    // 迁移决策必须以"标记已 true → null"短路 —— 否则用户显式选择会被反复打回
    expect(code).toMatch(
      /function planCloseBehaviorMigration[\s\S]{0,300}closeBehaviorMigrated === true\) return null/
    )
    // normalizeSettings 里只许透传收口，不许翻牌置 true
    // （切片边界用下一个导出函数的代码行：注释被剥掉后，docblock 里的中文锚点找不着）
    const normalizeBlock = code.slice(
      code.indexOf('export function normalizeSettings'),
      code.indexOf('export async function resolveDefaultLibraryDir')
    )
    expect(normalizeBlock).toContain('closeBehaviorMigrated === true')
    expect(normalizeBlock).not.toContain("closeBehavior: 'ask'")
  })
})