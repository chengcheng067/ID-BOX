/// <reference lib="dom" />
/**
 * 弹窗统一 Esc 关闭（0.7.6 T-ESC）——源码守卫 + 层栈行为。
 *
 * 组件在 node 环境渲染不了（仓库无 jsdom，vitest 走 `environment: 'node'`），
 * 所以「Esc 接到哪」只能这样钉：
 * ① `Modal` 是唯一的键盘入口，且必须挂在**捕获阶段**（第三个参 `true`）；
 * ② 曾经各自手写 Esc 的组件里不再出现 `'Escape'` 字样（防止又长回四份重复实现）；
 * ③ 层栈本身的行为用纯 JS 直接测（LIFO、出栈、重复出栈）。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  hasEscLayer,
  isTopEscLayer,
  popEscLayer,
  pushEscLayer,
  resetEscLayers
} from '../src/renderer/logic/escLayer'

const read = (p: string): string =>
  fs.readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf-8')

describe('Modal：唯一的 Esc 入口（捕获阶段）', () => {
  const src = read('components/Modal.tsx')

  it('keydown 挂在 window 捕获阶段，成对移除', () => {
    expect(src).toContain("window.addEventListener('keydown', onKey, true)")
    expect(src).toContain("window.removeEventListener('keydown', onKey, true)")
    // 捕获阶段 + stopPropagation：App 的全局 Esc 在冒泡阶段，收不到这次按键
    expect(src).toContain('e.stopPropagation()')
    expect(src).toContain("if (e.key !== 'Escape') return")
  })

  it('dismissOnEsc 默认 true（其它调用点零改动），false = 吃掉但不关', () => {
    expect(src).toContain('dismissOnEsc = true')
    // false 时仍然占一层：否则按键会落到 App 的全局 Esc 上去清选中 / 关下层视图
    expect(src).toContain('if (!handlerRef.current.dismissOnEsc) return')
  })

  it('按层栈决定谁吃（栈顶优先），卸载时出栈', () => {
    expect(src).toContain('const token = pushEscLayer()')
    expect(src).toContain('if (!isTopEscLayer(token)) return')
    expect(src).toContain('popEscLayer(token)')
  })

  it('输入框可以用 data-esc-own 保留自己的 Esc 语义（别名草稿回滚）', () => {
    expect(src).toContain('escOwnedByControl(e.target)')
  })

  it('data-esc-own 的判定在共享层（Modal 与 useEscLayer 都认，少一处就回到真机缺陷）', () => {
    const layer = read('logic/escLayer.ts')
    expect(layer).toContain('export function escOwnedByControl')
    expect(layer).toContain("closest('[data-esc-own]')")
    // useEscLayer 内部也必须放行：自绘弹窗里的输入框只经过这一条路径
    expect(layer).toContain('if (escOwnedByControl(e.target)) return')
  })
})

describe('四份手写 Esc 已删除', () => {
  const files = [
    'components/CategoryPicker.tsx',
    'components/DuplicateCompareDialog.tsx',
    'components/ImportConflictDialog.tsx'
  ]

  for (const file of files) {
    it(`${file} 不再出现 'Escape' / 自己挂 keydown`, () => {
      const src = read(file)
      expect(src).not.toContain("'Escape'")
      expect(src).not.toContain("addEventListener('keydown'")
    })
  }

  it('SettingsDialog 只剩「别名草稿回滚」这一处 Esc（不是关弹窗）', () => {
    const src = read('components/SettingsDialog.tsx')
    // 0.7.5 盘点把它记成"自接 Esc 关窗"，实际是 AliasRow 输入框里的草稿回滚。
    // 那部分必须留（否则 Esc 会关掉整个设置弹窗），但不许再挂 window 监听。
    expect(src).not.toContain("addEventListener('keydown'")
    expect(src.match(/'Escape'/g)?.length).toBe(1)
    expect(src).toContain('data-esc-own')
    // blur 是同步派发的：回滚必须靠标记跳过 commit，否则 Esc 反而会把编辑存下去
    expect(src).toContain('revertingRef.current = true')
    // 设置页是**自绘** dialog-scrim（不走 Modal）：必须自己占一层，否则 Esc 会落到
    // App 的全局 decideEsc → close-settings（qa-real076 真机缺陷 0.7.6-ESC-01）
    expect(src).toContain('useEscLayer(onClose, !!settings)')
  })
})

describe('自绘 dialog-scrim 一律要进层栈（0.7.6-ESC-01 的结构性守卫）', () => {
  // 这条守卫针对的是真机那条缺陷的成因：设置页自绘外壳不在栈里 → hasEscLayer() 为 false
  // → App 的全局 Esc 把它关掉，`data-esc-own` 也轮不到生效。
  // 以后再有新的自绘弹窗，忘了 useEscLayer 会在测试里直接红。
  const dir = new URL('../src/renderer/components/', import.meta.url)
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && f !== 'Modal.tsx')
    .filter((f) => fs.readFileSync(new URL(f, dir), 'utf-8').includes('dialog-scrim'))

  it('至少扫到 HdrPreview / CustomRender / Settings 三个自绘弹窗', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files).toContain('SettingsDialog.tsx')
  })

  for (const file of files) {
    it(`${file} 自绘外壳也调 useEscLayer`, () => {
      const src = fs.readFileSync(new URL(file, dir), 'utf-8')
      expect(src).toContain('useEscLayer(')
    })
  }
})

describe('全部 Modal 使用者都白拿 Esc', () => {
  const users = [
    'components/ConfirmDialog.tsx',
    'components/CoverPicker.tsx',
    'components/PurgeConfirmDialog.tsx',
    'components/RenameDialog.tsx',
    'components/CategoryPicker.tsx',
    'components/DuplicateCompareDialog.tsx',
    'components/SettingsDialog.tsx',
    'components/ImportConflictDialog.tsx'
  ]

  for (const file of users) {
    it(`${file} 走 Modal 外壳，不自挂 Esc`, () => {
      const src = read(file)
      expect(src).toContain("from './Modal'")
      expect(src).not.toContain("addEventListener('keydown'")
    })
  }

  it('ImportConflictDialog 显式关掉 Esc（Esc 不许等同于「整批跳过」）', () => {
    const src = read('components/ImportConflictDialog.tsx')
    expect(src).toContain('dismissOnEsc={false}')
  })

  it('CustomRenderDialog 自绘外壳，用 useEscLayer 补上同一层', () => {
    const src = read('components/CustomRenderDialog.tsx')
    expect(src).toContain("import { useEscLayer } from '../logic/escLayer'")
    expect(src).toContain('useEscLayer(beginClose, renderable)')
  })
})

describe('层栈：后开的先吃（栈顶优先）', () => {
  beforeEach(() => {
    resetEscLayers()
  })

  it('空栈时没有任何层，App 的全局 Esc 可以接手', () => {
    expect(hasEscLayer()).toBe(false)
  })

  it('压两层 → 只有栈顶是 top；弹出栈顶后下面那层接上', () => {
    const lower = pushEscLayer() // 设置弹窗
    const upper = pushEscLayer() // 导入重复处置（后开）
    expect(hasEscLayer()).toBe(true)
    expect(isTopEscLayer(lower)).toBe(false)
    expect(isTopEscLayer(upper)).toBe(true)

    popEscLayer(upper)
    expect(isTopEscLayer(lower)).toBe(true)

    popEscLayer(lower)
    expect(hasEscLayer()).toBe(false)
  })

  it('重复出栈 / 出未知 token 都静默忽略（StrictMode 双挂载下清理会跑两次）', () => {
    const token = pushEscLayer()
    popEscLayer(token)
    popEscLayer(token)
    popEscLayer(9999)
    expect(hasEscLayer()).toBe(false)
  })
})
