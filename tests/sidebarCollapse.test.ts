/**
 * 0.8.3 左右侧边栏折叠（用户 2026-10-28 反馈「左右侧边栏都需要能够被折叠」）。
 *
 * 三层钉法（与 motionQuality / settingsStage 同一套策略）：
 * A. Settings 字段与默认值（false = 展开态，老用户升级无感知）；
 * B. 走真实读档链路（`SettingsSchema.safeParse` → `migrateSettings`，与 loadSettings 同一条路），
 *    并验证**单项降级**：脏值（'yes' / 1 / null）只让该项回落展开，绝不拖垮整份 settings.json
 *    （否则 libraryDir 一起丢，库会"消失"—— 本项目在 gridDensity 上踩过的坑）；
 * C. 源码守卫：App.tsx 必须读取两个字段、经 `saveSettings` 落库（折叠切换即时持久化）、
 *    折叠走宽度过渡 + overflow 裁切（内容固定宽，不做挤压变形）。
 *
 * 仓库 vitest 是 `node` 环境、无 jsdom，React 组件渲染不了 → 交互层用源码守卫。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { SettingsSchema, migrateSettings, normalizeSettings } from '../src/main/settings'

const read = (rel: string): string =>
  fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8')

const LIB = 'E:\\ModVault\\Library'

describe('侧栏折叠 · Settings 字段与默认值', () => {
  it('新增两个字段且默认 false（= 展开态）', () => {
    expect(DEFAULT_SETTINGS.sidebarLeftCollapsed).toBe(false)
    expect(DEFAULT_SETTINGS.sidebarRightCollapsed).toBe(false)
  })
})

describe('侧栏折叠 · zod schema 单项降级', () => {
  it('脏值不拖垮整份设置，只让该项回落 false', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      sidebarLeftCollapsed: 'yes',
      sidebarRightCollapsed: 1
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.sidebarLeftCollapsed).toBe(false)
    expect(parsed.data.sidebarRightCollapsed).toBe(false)
  })

  it('缺键时字段不出现在解析结果（由归一化补默认）', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: LIB })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.sidebarLeftCollapsed).toBeUndefined()
    expect(parsed.data.sidebarRightCollapsed).toBeUndefined()
  })
})

describe('侧栏折叠 · normalizeSettings 写档收口', () => {
  it('缺键 → false；严格 true 保留；脏值 → false', () => {
    const missing = normalizeSettings({ libraryDir: LIB })
    expect(missing.sidebarLeftCollapsed).toBe(false)
    expect(missing.sidebarRightCollapsed).toBe(false)

    const on = normalizeSettings({
      libraryDir: LIB,
      sidebarLeftCollapsed: true,
      sidebarRightCollapsed: true
    })
    expect(on.sidebarLeftCollapsed).toBe(true)
    expect(on.sidebarRightCollapsed).toBe(true)

    const dirty = normalizeSettings({
      libraryDir: LIB,
      sidebarLeftCollapsed: 'yes' as never,
      sidebarRightCollapsed: null as never
    })
    expect(dirty.sidebarLeftCollapsed).toBe(false)
    expect(dirty.sidebarRightCollapsed).toBe(false)
  })

  it('两侧互相独立：只折叠一侧不影响另一侧', () => {
    const s = normalizeSettings({ libraryDir: LIB, sidebarLeftCollapsed: true })
    expect(s.sidebarLeftCollapsed).toBe(true)
    expect(s.sidebarRightCollapsed).toBe(false)
  })
})

describe('侧栏折叠 · 真实读档链路（safeParse → migrateSettings）', () => {
  it('true 双向保真，缺键一侧回落 false', () => {
    const parsed = SettingsSchema.safeParse({ libraryDir: LIB, sidebarLeftCollapsed: true })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.sidebarLeftCollapsed).toBe(true)
    expect(s.sidebarRightCollapsed).toBe(false)
  })

  it('旧档脏值经 catch 降级后不拖垮 libraryDir', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      sidebarLeftCollapsed: 'true',
      sidebarRightCollapsed: 0
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.libraryDir).toBe(LIB)
    expect(s.sidebarLeftCollapsed).toBe(false)
    expect(s.sidebarRightCollapsed).toBe(false)
  })
})

describe('侧栏折叠 · 源码守卫（App 挂载与持久化接线）', () => {
  const app = read('renderer/App.tsx')

  it('App 读取两个字段（缺省 false）并经 saveSettings 即时落库', () => {
    expect(app).toContain('sidebarLeftCollapsed')
    expect(app).toContain('sidebarRightCollapsed')
    expect(app).toMatch(/saveSettings\(\{\s*sidebarLeftCollapsed:/)
    expect(app).toMatch(/saveSettings\(\{\s*sidebarRightCollapsed:/)
  })

  it('折叠容器：宽度过渡 + overflow 裁切（内容固定宽不变形），折叠后 aria-hidden', () => {
    expect(app).toContain('overflow-hidden')
    expect(app).toContain('SIDEBAR_COLLAPSE_MS')
    expect(app).toMatch(/width \$\{SIDEBAR_COLLAPSE_MS\}ms ease/)
    expect(app).toMatch(/aria-hidden=\{collapsed \|\| undefined\}/)
  })

  it('中栏两缘各有一颗唤出 / 收起按钮（左缘 + 右缘对称）', () => {
    expect(app).toMatch(/<SidebarEdgeToggle side="left"/)
    expect(app).toMatch(/<SidebarEdgeToggle side="right"/)
    // 按钮可访问性：aria-expanded 表达当前展开态
    expect(app).toContain('aria-expanded={!collapsed}')
  })

  it('挂载点：左栏包住 Sidebar、右栏包住 DetailPanel（id 供 aria-controls 引用）', () => {
    expect(app).toMatch(/id="sidebar-left"[\s\S]{0,200}<Sidebar /)
    expect(app).toMatch(/id="detail-panel"[\s\S]{0,200}<DetailPanel \/>/)
  })
})

describe('侧栏折叠 · 源码守卫（main 侧归一化收口）', () => {
  const settings = read('main/settings.ts')

  it('zod schema 与 normalizeSettings 都只认严格 true', () => {
    expect(settings).toMatch(/sidebarLeftCollapsed: z\.boolean\(\)\.optional\(\)\.catch\(false\)/)
    expect(settings).toMatch(/sidebarRightCollapsed: z\.boolean\(\)\.optional\(\)\.catch\(false\)/)
    expect(settings).toMatch(/merged\.sidebarLeftCollapsed = merged\.sidebarLeftCollapsed === true/)
    expect(settings).toMatch(/merged\.sidebarRightCollapsed = merged\.sidebarRightCollapsed === true/)
  })
})
