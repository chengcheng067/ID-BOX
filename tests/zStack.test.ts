/// <reference lib="dom" />
/**
 * 弹窗层级（0.7.8 T-ZSTACK）—— 纯函数 + 源码守卫。
 *
 * 用户 2026-10-26 真机原话：
 * > 「这个舞台球的层级还是有点太高了……是不是我们一切的新增的弹窗，就是新点出来的弹窗
 * >   都应该层级更高呢？现在舞台球的层级非常的高，这个应该是一个逻辑性上的一个 bug。」
 *
 * 这套用例钉三件事：
 * ① **映射关系**：层栈深度 → z-index 类（1→50 / 2→60 / 3→70 / 4 及以上→80，脏值兜底 50）；
 * ② **结构性守卫**：舞台球 45（低于全部弹窗）、`ImportConflictDialog` 不再写死 `z-[60]`、
 *    三个自绘 `dialog-scrim` 的 `z-50` 硬编码全部换成深度计算 —— 否则「新弹窗在上」这条
 *    规则会在下一次新增弹窗时悄悄退回「谁写死得更大谁在上」；
 * ③ **同源**：深度读的是 `escLayer` 的栈（`getEscLayerRank`），与「谁吃 Esc」同一份数据 ——
 *    这一条决定了不会出现「看着在上层、Esc 答下层」的错配。
 *
 * 组件在 node 环境渲染不了（仓库 vitest `environment: 'node'`、无 jsdom），
 * 所以「组件里用的是哪个层级」只能靠源码守卫钉，纯函数部分直接测。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  Z_MODAL_BASE,
  Z_MODAL_MAX_LAYERS,
  Z_STAGE_BALL,
  zClassForDepth,
  zIndexOfDepth
} from '../src/renderer/logic/zStack'
import { getEscLayerRank, popEscLayer, pushEscLayer, resetEscLayers } from '../src/renderer/logic/escLayer'

const read = (rel: string): string =>
  fs.readFileSync(new URL(`../src/renderer/${rel}`, import.meta.url), 'utf-8')

/** 取源码里第一条包含 needle 的行（守卫按行断言用；找不到直接失败，避免"空串也算通过"） */
function lineWith(src: string, needle: string): string {
  const line = src.split('\n').find((l) => l.includes(needle))
  expect(line, `源码里找不到含「${needle}」的行`).toBeDefined()
  return line ?? ''
}

// ── ① 映射：深度 → z-index ────────────────────────────────────────────
describe('zClassForDepth：新点出来的弹窗层级更高', () => {
  it('第 1 层 50 / 第 2 层 60 / 第 3 层 70 / 第 4 层 80', () => {
    expect(zClassForDepth(1)).toBe('z-50')
    expect(zClassForDepth(2)).toBe('z-60')
    expect(zClassForDepth(3)).toBe('z-70')
    expect(zClassForDepth(4)).toBe('z-80')
  })

  it('封顶：第 5 层起与第 4 层同高（防无限叠出四位数的 z-index）', () => {
    expect(zClassForDepth(5)).toBe('z-80')
    expect(zClassForDepth(99)).toBe('z-80')
    expect(Z_MODAL_MAX_LAYERS).toBe(4)
  })

  it('脏值兜底 50：首帧 depth=0、负数、NaN 都按最底层处理（不抛错）', () => {
    expect(zClassForDepth(0)).toBe('z-50')
    expect(zClassForDepth(-1)).toBe('z-50')
    expect(zClassForDepth(Number.NaN)).toBe('z-50')
    expect(zClassForDepth(Number.POSITIVE_INFINITY)).toBe('z-50')
  })

  it('zIndexOfDepth 与类名一致（类名就是 z-<数字>，不许两套换算）', () => {
    for (const depth of [1, 2, 3, 4, 5, 0, -3]) {
      expect(zClassForDepth(depth)).toBe(`z-${zIndexOfDepth(depth)}`)
    }
    expect(zIndexOfDepth(1)).toBe(Z_MODAL_BASE)
  })

  it('舞台球 45：低于最底层弹窗、高于全部内容层（内容层最高 40）', () => {
    expect(Z_STAGE_BALL).toBe(45)
    expect(Z_STAGE_BALL).toBeLessThan(Z_MODAL_BASE)
    expect(Z_STAGE_BALL).toBeGreaterThan(40)
  })
})

// ── ③ 同源：深度来自 Esc 层栈本身 ──────────────────────────────────────
describe('getEscLayerRank：层级与 Esc 应答读同一份栈', () => {
  beforeEach(() => {
    resetEscLayers()
  })

  it('1 = 最底；栈顶 = layers.length；不在栈里 = 0', () => {
    const lower = pushEscLayer()
    expect(getEscLayerRank(lower)).toBe(1)
    const upper = pushEscLayer()
    expect(getEscLayerRank(upper)).toBe(2)
    expect(getEscLayerRank(9999)).toBe(0)

    // 上层关掉 → 下层重新变成第 1 层（z 回到 50），这就是"关掉最上面那个，下面的露出来"
    popEscLayer(upper)
    expect(getEscLayerRank(lower)).toBe(1)
  })

  it('同一 token 的 rank 与 isTopEscLayer 始终自洽（栈顶 ⇔ rank === depth）', () => {
    const lower = pushEscLayer()
    const upper = pushEscLayer()
    expect(getEscLayerRank(upper)).toBe(2) // 栈顶
    expect(getEscLayerRank(lower)).toBe(1) // 非栈顶
    popEscLayer(lower) // 出栈不依赖顺序
    expect(getEscLayerRank(upper)).toBe(1)
  })
})

// ── ② 源码守卫：六个使用点 ────────────────────────────────────────────
describe('舞台球：降到所有弹窗之下', () => {
  const stage = read('components/MaterialStage.tsx')

  it('zIndex 是 45（低于弹窗基座 50）', () => {
    expect(stage).toContain('zIndex: 45')
  })

  it('不再出现 zIndex: 60（旧值：比全部弹窗都高，用户看到球浮在设置之上）', () => {
    expect(stage).not.toContain('zIndex: 60')
    expect(stage).not.toContain('zIndex: 60,')
  })
})

describe('ImportConflictDialog：不再写死 z-[60]，改用层栈', () => {
  const dialog = read('components/ImportConflictDialog.tsx')

  it('不出现 z-[60]（写死的数字与 Esc 栈是两套来源）', () => {
    expect(dialog).not.toContain('z-[60]')
  })

  it('走 Modal 外壳，层级由 Modal 按层栈深度算', () => {
    expect(dialog).toContain("from './Modal'")
    expect(dialog).not.toContain('zClass=')
    expect(dialog).toContain('dismissOnScrim={false}')
    expect(dialog).toContain('dismissOnEsc={false}')
  })
})

describe('三个自绘 dialog-scrim：z-50 硬编码换成深度计算', () => {
  const files = [
    'components/SettingsDialog.tsx',
    'components/CustomRenderDialog.tsx',
    'components/HdrPreviewDialog.tsx'
  ] as const

  for (const file of files) {
    it(`${file} 的 scrim 用 zClassForDepth，且自己没有新的层级魔法数字`, () => {
      const src = read(file)
      // 深度助手必须来自纯函数模块（不是各文件里再抄一遍换算）
      expect(src).toContain("import { zClassForDepth } from '../logic/zStack'")
      // scrim 那一行：不再有字面 z-50，改成深度算出来的类
      // ⚠️ 用 `dialog-scrim fixed inset-0` 定位，不能用 `dialog-scrim`：文件里解释架构的
      // 注释也提到这个词，会先命中到注释行（那种"守卫看着绿、其实断言在注释上"是假绿）。
      const scrim = lineWith(src, 'dialog-scrim fixed inset-0')
      expect(scrim).toContain('zClassForDepth(')
      expect(scrim).not.toContain(' z-50 ')
      expect(scrim).not.toContain('z-[60]')
      // 仍然占一层（0.7.6-ESC-01 的结构性前提，不能被这次改动带跑）
      expect(src).toContain('useEscLayer(')
    })
  }

  it('每个自绘弹窗都把 useEscLayer 的返回值（本层深度）接进 scrim', () => {
    // 只要"调了 useEscLayer 但丢掉了返回值"就会退回 z-50 → 上层弹窗被下层盖住。
    const pairs: Array<[string, string]> = [
      ['components/SettingsDialog.tsx', 'const escDepth = useEscLayer(onClose, !!settings)'],
      ['components/CustomRenderDialog.tsx', 'const escDepth = useEscLayer(beginClose, renderable)'],
      ['components/HdrPreviewDialog.tsx', 'const escDepth = useEscLayer(onClose, true)']
    ]
    for (const [file, decl] of pairs) {
      expect(read(file)).toContain(decl)
    }
  })
})

describe('Modal：层级由层栈深度算，且不再提供写死的 zClass 出入口', () => {
  const modal = read('components/Modal.tsx')

  it('scrim 用 zClassForDepth(depth)', () => {
    const scrim = lineWith(modal, 'dialog-scrim fixed inset-0')
    expect(scrim).toContain('zClassForDepth(depth)')
    expect(scrim).not.toContain(' z-50 ')
  })

  it('depth 来自本层 token 在栈里的位置（与 Esc 应答同一个 token）', () => {
    expect(modal).toContain('const token = pushEscLayer()')
    expect(modal).toContain('setDepth(getEscLayerRank(token))')
    expect(modal).toContain('subscribeEscLayers(syncDepth)')
    expect(modal).toContain('if (!isTopEscLayer(token)) return')
  })

  it('旧的 zClass prop 已删除（谁都不许再手写更大的数字插队）', () => {
    expect(modal).not.toContain('zClass?:')
    expect(modal).not.toContain("zClass = 'z-50'")
  })
})

describe('StageControls：死代码的 z-[61] 已去掉', () => {
  it('文件留着（有文档引用），但不再有 z-[61]', () => {
    const src = read('components/StageControls.tsx')
    expect(src).not.toContain('z-[61]')
    expect(src).toContain('0.7.8 T-ZSTACK')
  })
})
