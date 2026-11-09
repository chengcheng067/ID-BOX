/**
 * T05 · D-2 首启引导（`pluginIndexGuideShown`）+「插件写盘不自动勾选」契约守卫。
 *
 * 背景（用户会撞上的真空白）：插件面板的数据来自主进程导出到
 * `%APPDATA%\idbox\plugin\` 的两个 UTF-8 JSON，而写盘开关（`pluginIndexEnabled`）
 * **默认关闭**、界面上原先没有任何地方解释这件事 ⇒ 第一次打开插件看到空列表，
 * 用户只会以为插件坏了。
 *
 * 本文件钉两面（渲染层没有 jsdom，`environment: 'node'`，所以 UI 侧只能扫源码）：
 *
 * **A 数据面（真值表，跑真代码）**
 * - `SettingsSchema` 对 `pluginIndexGuideShown` 的脏值降级：`'true'` / `0` / `null`
 *   只让**这一项**回落，不拖垮整份 settings.json；
 * - `normalizeSettings` 的最终收口：缺键 / 脏值一律 `false`（= 下次还显示引导）。
 *   ⚠️ 方向与 `pluginIndexEnabled` **相反**是刻意的：写盘开关回落成"关"是安全的，
 *   引导回落成"已看过"会让用户永远看不到提示。
 * - `pluginIndexEnabled` 默认值**必须仍是 `false`**（用户拍板「由你主动勾选」）。
 *
 * **B 源码面（守卫，防回退）**
 * - 提示带的显示条件是**两个 `!== true` 同时成立**（写 `=== false` 会让缺键的老用户看不到）；
 * - 点关闭**只写** `pluginIndexGuideShown`，绝不顺手写 `pluginIndexEnabled`；
 * - 用户自己勾开写盘时才允许"引导位跟着写盘位走"（且只单向）；
 * - 提示带里不许出现 Tailwind `dark:` 变体（本项目主题是 `[data-theme]` 属性切换，
 *   `dark:` 跟的是操作系统，必然串色）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { SettingsSchema, normalizeSettings } from '../src/main/settings'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

/** 去掉块注释与行注释：守卫只针对真实代码，注释里提到 `dark:` 不算违规 */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const dialogCode = (): string => codeOnly(read('src/renderer/components/SettingsDialog.tsx'))

// ── A 数据面 ─────────────────────────────────────────────────────────────

describe('pluginIndexGuideShown · 默认值', () => {
  it('DEFAULT_SETTINGS 里默认 false（= 装上先露一次脸）', () => {
    expect(DEFAULT_SETTINGS.pluginIndexGuideShown).toBe(false)
  })

  it('★pluginIndexEnabled 默认值必须仍是 false（用户拍板「由你主动勾选」，本轮不得改动）', () => {
    expect(DEFAULT_SETTINGS.pluginIndexEnabled).toBe(false)
  })
})

describe('pluginIndexGuideShown · zod 单项降级（脏值只让这一项回落）', () => {
  /**
   * 表格右侧是**两层的期望值**，它们合法地不同：
   * - `schema` 层：`.optional()` 允许缺键 → `undefined`（不是 false）；脏值被 `.catch(false)` 接住 → false；
   * - `normalize` 层：`=== true` 收口 → 缺键也变 false。
   * 真正的对外契约是 normalize 之后（`readSettings` 一定跑它），schema 层只是第一道闸。
   */
  const table: Array<{ label: string; raw: unknown; schema: unknown; normalized: boolean }> = [
    { label: '缺键（老档 / 首次运行）', raw: undefined, schema: undefined, normalized: false },
    { label: "字符串 'true'", raw: 'true', schema: false, normalized: false },
    { label: "字符串 'false'", raw: 'false', schema: false, normalized: false },
    { label: '数字 0', raw: 0, schema: false, normalized: false },
    { label: '数字 1', raw: 1, schema: false, normalized: false },
    { label: 'null', raw: null, schema: false, normalized: false },
    { label: '对象 {}', raw: {}, schema: false, normalized: false },
    { label: '布尔 false', raw: false, schema: false, normalized: false },
    { label: '布尔 true', raw: true, schema: true, normalized: true }
  ]

  for (const row of table) {
    it(`${row.label} → schema ${String(row.schema)} / normalize ${row.normalized}`, () => {
      // `libraryDir` 是 schema 里唯一必填项（真实 settings.json 必然有它），
      // 这里给一个固定值，好让断言只盯 `pluginIndexGuideShown` 这一项。
      const input: Record<string, unknown> = {
        libraryDir: 'E:\\ModVault\\Library',
        ...(row.raw === undefined ? {} : { pluginIndexGuideShown: row.raw })
      }
      const parsed = SettingsSchema.safeParse(input)
      // 单项降级的第一层保证：**整份 schema 不许因为这一项失败**
      expect(parsed.success, '脏值把整份 settings.json 拖垮了').toBe(true)
      expect(parsed.success && parsed.data.pluginIndexGuideShown).toBe(row.schema)

      // 第二层：写档前归一化收口成布尔
      const normalized = normalizeSettings(input as Partial<Settings>)
      expect(normalized.pluginIndexGuideShown).toBe(row.normalized)
    })
  }

  it('★脏值不拖垮邻居：同一份输入里 libraryDir 必须原样保留', () => {
    // 这条防的是"把 .catch 写到 zod 对象外"或"整份回默认"的退化 —— 那会让库"消失"
    const normalized = normalizeSettings({
      libraryDir: 'D:\\MyLibrary',
      pluginIndexGuideShown: 'yes' as unknown as boolean
    })
    expect(normalized.libraryDir).toBe('D:\\MyLibrary')
    expect(normalized.pluginIndexGuideShown).toBe(false)
  })

  it('两个字段互不反写：只给引导位 true，写盘开关必须保持默认 false', () => {
    const normalized = normalizeSettings({ pluginIndexGuideShown: true })
    expect(normalized.pluginIndexGuideShown).toBe(true)
    expect(normalized.pluginIndexEnabled).toBe(false)
  })

  it('反向同理：只给写盘开关 true，引导位不得被反写成 true', () => {
    const normalized = normalizeSettings({ pluginIndexEnabled: true })
    expect(normalized.pluginIndexEnabled).toBe(true)
    // 引导位保持默认 false —— 归一化阶段不许有"开了开关就当看过引导"的联动
    expect(normalized.pluginIndexGuideShown).toBe(false)
  })
})

// ── B 源码面（渲染层无 jsdom，只能扫源码） ────────────────────────────────

describe('SettingsDialog · 提示带显示条件', () => {
  it('★两个 `!== true` 同时成立才显示（不是 === false）', () => {
    const code = dialogCode()
    const m = /const showPluginIndexGuide\s*=\s*([\s\S]{0,220})/.exec(code)
    expect(m, '找不到 showPluginIndexGuide 的定义').not.toBeNull()
    const expr = m![1]!
    // 两个条件都在
    expect(expr).toMatch(/pluginIndexGuideShown\s*!==\s*true/)
    expect(expr).toMatch(/pluginIndexEnabled\s*!==\s*true/)
    // 用 && 连接（两个都未满足才显示）
    expect(expr).toMatch(/pluginIndexGuideShown\s*!==\s*true\s*&&[\s\S]{0,80}pluginIndexEnabled\s*!==\s*true/)
    // ⛔ 反过来写会让缺键（undefined）的老用户永远看不到引导
    expect(expr).not.toMatch(/pluginIndexGuideShown\s*===\s*false/)
  })

  it('提示带渲染受该条件控制，且位于「SketchUp 插件」写盘开关之前（同一屏同一段视线）', () => {
    const code = dialogCode()
    const iBand = code.indexOf('showPluginIndexGuide &&')
    const iRow = code.indexOf('title="SketchUp 插件"')
    expect(iBand).toBeGreaterThan(-1)
    expect(iRow).toBeGreaterThan(-1)
    expect(iBand, '提示带必须渲染在写盘开关上方').toBeLessThan(iRow)
  })
})

describe('SettingsDialog · 文案与「不自动勾选」硬约束', () => {
  const code = dialogCode()

  it('文案包含两个必需要点：写盘位置 + 由你主动勾选（A 级口径：说人话，不点名字段名）', () => {
    // ① 写盘位置：正文说「电脑上的 idbox\plugin 文件夹」，**完整路径只在 title 里**
    //    （docs/48 A 级文案裁定：主程序界面不出现文件名与字段名）
    expect(code).toContain('只在确有变化时刷新')
    expect(code).toContain('电脑上的 idbox\\plugin 文件夹')
    expect(code).toContain('共两个素材清单文件')
    // ② 「由你主动勾选」（强调不自动开）
    expect(code).toContain('由你主动勾选')
    // 顺带保留可行动信息：未勾开时插件显示「未开导出」
    expect(code).toContain('未开导出')
  })

  it('★A 级口径：正文不出现 %APPDATA% / manifest.json / index.json / UTF-8 / JSON / 主进程', () => {
    const code = dialogCode()
    const iBand = code.indexOf('showPluginIndexGuide &&')
    const iRow = code.indexOf('title="SketchUp 插件"')
    expect(iBand).toBeGreaterThan(-1)
    expect(iRow).toBeGreaterThan(iBand)
    const band = code.slice(iBand, iRow)

    // 完整路径**必须保留**在 title 里（想找文件的人悬停能看到并抄走）
    expect(band).toContain('title="完整路径：%APPDATA%\\idbox\\plugin\\"')
    // 正文里不许再出现第二处 `%APPDATA%`（= 只能出现在 title 属性里这一处）
    expect(band.match(/%APPDATA%/g) ?? []).toHaveLength(1)

    // 文件名 / 格式名 / 内部层次名一律不出现
    expect(band).not.toContain('manifest.json')
    expect(band).not.toContain('index.json')
    expect(band).not.toContain('UTF-8')
    expect(band).not.toContain('JSON')
    expect(band).not.toContain('主进程')
  })

  it('★关闭按钮只写 pluginIndexGuideShown（绝不顺手写 pluginIndexEnabled）', () => {
    const code = dialogCode()
    const iBtn = code.indexOf('知道了，不再提示')
    expect(iBtn).toBeGreaterThan(-1)
    // 取关闭按钮所在的那个 onClick 片段（到下一个 `>` 或 300 字符为止）
    const seg = code.slice(iBtn, iBtn + 700)
    const onClickIdx = seg.indexOf('onClick=')
    expect(onClickIdx).toBeGreaterThan(-1)
    const onClickSeg = seg.slice(onClickIdx, onClickIdx + 260)
    expect(onClickSeg).toContain('saveSettings({ pluginIndexGuideShown: true })')
    expect(onClickSeg, '关闭引导时不许动写盘开关').not.toContain('pluginIndexEnabled')
  })

  it('★全文件唯一允许写 pluginIndexEnabled 的地方是 CheckRow 的 onChange', () => {
    const code = dialogCode()
    // 找出所有 `saveSettings({ ... pluginIndexEnabled ... })` 的出现位置
    const writes = [...code.matchAll(/saveSettings\(\s*[^)]*pluginIndexEnabled/g)].map((m) => m.index ?? -1)
    // 只允许一处（勾选框）；出现第二处意味着有别的地方在替用户开/关
    expect(writes).toHaveLength(1)
  })

  it('★「引导位跟着写盘位走」只允许单向：勾开时顺带写引导位，关闭时不写', () => {
    const code = dialogCode()
    // 勾开分支：同时写两项
    expect(code).toMatch(
      /next\s*\?\s*\{\s*pluginIndexEnabled:\s*true,\s*pluginIndexGuideShown:\s*true\s*\}/
    )
    // 取消勾选分支：只写写盘开关，不回写引导位（否则"关掉再打开"就再也看不到引导了）
    expect(code).toMatch(/:\s*\{\s*pluginIndexEnabled:\s*false\s*\}/)
  })

  it('⛔ 提示带内不许出现 Tailwind `dark:` 变体（会跟系统而不是跟应用主题）', () => {
    expect(code).not.toMatch(/\bdark:(bg|text|border|ring|from|to)-/)
  })

  it('提示带只用既有 token 的样式语言（bg-canvas / border-line / text-secondary），不写死 hex', () => {
    const code = dialogCode()
    const iBand = code.indexOf('showPluginIndexGuide &&')
    const seg = code.slice(iBand, iBand + 1800)
    expect(seg).toContain('bg-canvas')
    expect(seg).toContain('border-line')
    expect(seg).toContain('text-secondary')
    // 不写死色值（#rrggbb / rgb( / rgba( 一律不许）
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(seg).not.toMatch(/\brgba?\(/)
  })
})

describe('渲染层不碰 App.tsx（U-2 回签：设置页内嵌，不做首启浮层）', () => {
  it('SettingsDialog 自己渲染提示带，App.tsx 里没有引导相关代码', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).not.toContain('pluginIndexGuideShown')
    expect(app).not.toContain('showPluginIndexGuide')
  })
})
