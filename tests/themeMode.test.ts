/**
 * 跟随系统主题（0.6.0）—— 纯函数 `resolveTheme` + 接线守卫。
 *
 * 为什么需要这个解析：`document.documentElement.dataset.theme` 只认 light/dark，
 * 把 'system' 直接写进 DOM 会让 styles.css 的全部 token 落空（没有 [data-theme='system']）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveTheme } from '../src/shared/theme'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

describe('theme · 跟随系统', () => {
  it('system + 系统深色 → dark；system + 系统浅色 → light', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('显式 light / dark 不受系统影响', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('脏值（旧档 / 手改）一律回落 light', () => {
    expect(resolveTheme('nope' as never, true)).toBe('light')
    expect(resolveTheme(undefined as never, false)).toBe('light')
  })
})

describe('theme · 接线守卫', () => {
  it('App 写 DOM 前必须先解析（不能把 system 写进 dataset.theme）', () => {
    const src = read('src/renderer/App.tsx')
    expect(src).toContain('resolveTheme(theme, systemDark)')
    expect(src).not.toMatch(/dataset\.theme\s*=\s*theme\b/)
  })

  it('系统深浅色变化要实时跟随（监听 prefers-color-scheme）', () => {
    const src = read('src/renderer/App.tsx')
    expect(src).toContain("matchMedia('(prefers-color-scheme: dark)')")
    expect(src).toContain("addEventListener('change'")
  })

  it('设置里三张主题卡都可点（跟随系统不再是禁用占位）', () => {
    const src = read('src/renderer/components/SettingsDialog.tsx')
    expect(src).toContain("(['light', 'dark', 'system'] as const)")
    expect(src).not.toContain('跟随系统（v0.2 留位）')
  })

  it('主进程落档接受 system（旧档脏值仍回落 light）', () => {
    const src = read('src/main/settings.ts')
    expect(src).toContain("z.enum(['light', 'dark', 'system'])")
    expect(src).toContain("merged.theme === 'system' ? 'system' : 'light'")
  })
})
