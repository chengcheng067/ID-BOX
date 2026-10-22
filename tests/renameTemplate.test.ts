import { describe, expect, it } from 'vitest'
import {
  FALLBACK_FOLDER_NAME,
  RENAME_PLACEHOLDERS,
  applyRenameTemplate,
  isReservedFolderName,
  planRenames,
  sanitizeFolderName,
  unknownTokensOf,
  type RenamePlanItem
} from '../src/shared/renameTemplate'

/**
 * 命名模板的**纯函数**验收（0.6.0，docs/22 §3.4）。
 *
 * 覆盖任务书要求的五组：
 * ① 模板替换；② `{n:2}` 补零；③ 非法字符清洗；④ 重名冲突；⑤ 未知占位符保留。
 */

const ctx = { name: '现代衣柜', c1: '家具', c2: '衣柜', year: 2026, n: 7 }

function item(over: Partial<RenamePlanItem> = {}): RenamePlanItem {
  return {
    id: over.id ?? 'a1',
    name: over.name ?? '现代衣柜ID_1172815578',
    c1: over.c1 ?? '家具',
    c2: over.c2 ?? '衣柜',
    year: over.year ?? 2026
  }
}

describe('RENAME_PLACEHOLDERS', () => {
  it('声明的占位符与实际求值能力一致（每个 token 都能被替换）', () => {
    for (const p of RENAME_PLACEHOLDERS) {
      const out = applyRenameTemplate(p.token, ctx)
      expect(out).not.toContain('{')
      expect(out.length).toBeGreaterThan(0)
    }
    // 五个 token 都在清单里
    expect(RENAME_PLACEHOLDERS.map((p) => p.token)).toEqual([
      '{name}',
      '{c1}',
      '{c2}',
      '{year}',
      '{n}'
    ])
  })
})

describe('applyRenameTemplate', () => {
  it('替换全部已知占位符', () => {
    expect(applyRenameTemplate('{c1}-{c2}-{name}', ctx)).toBe('家具-衣柜-现代衣柜')
    expect(applyRenameTemplate('{year}_{n}', ctx)).toBe('2026_7')
  })

  it('{n:2} 补零；宽度不够时不截断', () => {
    expect(applyRenameTemplate('{n:2}', { ...ctx, n: 1 })).toBe('01')
    expect(applyRenameTemplate('{n:2}', { ...ctx, n: 10 })).toBe('10')
    expect(applyRenameTemplate('{n:3}', { ...ctx, n: 7 })).toBe('007')
    // 100 在 {n:2} 下保持 100（补零只管左侧）
    expect(applyRenameTemplate('{n:2}', { ...ctx, n: 100 })).toBe('100')
  })

  it('占位符大小写不敏感', () => {
    expect(applyRenameTemplate('{NAME}', ctx)).toBe('现代衣柜')
  })

  it('未知占位符原样保留，并进 unknownTokens', () => {
    const tpl = '{c1}-{foo}-{name}'
    expect(applyRenameTemplate(tpl, ctx)).toBe('家具-{foo}-现代衣柜')
    expect(unknownTokensOf(tpl)).toEqual(['{foo}'])
  })

  it('{n:x}（宽度非法）按未知处理，原样保留', () => {
    const tpl = '{n:x}'
    expect(applyRenameTemplate(tpl, ctx)).toBe('{n:x}')
    expect(unknownTokensOf(tpl)).toEqual(['{n:x}'])
  })

  it('{n:99} 超出补零上限 → 原样保留（不产出 99 长度的名字）', () => {
    expect(applyRenameTemplate('{n:99}', ctx)).toBe('{n:99}')
    expect(unknownTokensOf('{n:99}')).toEqual(['{n:99}'])
  })

  it('空模板 → 空串（由清洗层回退原名，等于不改名）', () => {
    expect(applyRenameTemplate('', ctx)).toBe('')
    expect(applyRenameTemplate('   ', ctx)).toBe('')
  })

  it('不含占位符的模板原样返回（不做任何清洗）', () => {
    expect(applyRenameTemplate('固定名字 ', ctx)).toBe('固定名字 ')
  })

  it('year 非法（0 / NaN）渲染成空串而不是 "NaN"', () => {
    expect(applyRenameTemplate('{year}', { ...ctx, year: 0 })).toBe('')
    expect(applyRenameTemplate('{year}', { ...ctx, year: Number.NaN })).toBe('')
  })
})

describe('sanitizeFolderName', () => {
  it('替换 Windows 非法字符（含 / 与 \\，保证结果永远是单段名）', () => {
    expect(sanitizeFolderName('椅子/凳子')).toBe('椅子_凳子')
    expect(sanitizeFolderName('a\\b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
  })

  it('去掉首尾空格与点，多空格合一', () => {
    expect(sanitizeFolderName('  .现代   衣柜.  ')).toBe('现代 衣柜')
    expect(sanitizeFolderName('...')).toBe(FALLBACK_FOLDER_NAME)
  })

  it('清洗后为空 → 回退 fallback（传原名即"回退原名"）', () => {
    expect(sanitizeFolderName('   ', '原名')).toBe('原名')
    expect(sanitizeFolderName('///', '原名')).toBe('原名')
    // 连 fallback 都不可用 → 兜底名
    expect(sanitizeFolderName('', '')).toBe(FALLBACK_FOLDER_NAME)
    expect(sanitizeFolderName('', '///')).toBe(FALLBACK_FOLDER_NAME)
  })

  it('正常名字不被改写（幂等）', () => {
    expect(sanitizeFolderName('现代衣柜')).toBe('现代衣柜')
    expect(sanitizeFolderName(sanitizeFolderName('现代衣柜'))).toBe('现代衣柜')
  })
})

describe('isReservedFolderName', () => {
  it('识别 Windows 保留设备名（含带扩展名与大小写变体）', () => {
    expect(isReservedFolderName('CON')).toBe(true)
    expect(isReservedFolderName('con.txt')).toBe(true)
    expect(isReservedFolderName('LPT1')).toBe(true)
    expect(isReservedFolderName('COM9')).toBe(true)
    // 不是保留名
    expect(isReservedFolderName('COM0')).toBe(false)
    expect(isReservedFolderName('console')).toBe(false)
  })
})

describe('planRenames', () => {
  it('{name} 用的是显示名（剥掉知末 ID）', () => {
    const plan = planRenames([item({ id: 'a', name: '现代衣柜ID_1172815578' })], '{name}')
    expect(plan.rows[0].from).toBe('现代衣柜ID_1172815578')
    expect(plan.rows[0].to).toBe('现代衣柜')
    expect(plan.rows[0].reason).toBeUndefined()
    expect(plan.ok).toBe(true)
  })

  it('按序生成 {n}（从 1 起）', () => {
    const plan = planRenames(
      [item({ id: 'a', name: '甲' }), item({ id: 'b', name: '乙' }), item({ id: 'c', name: '丙' })],
      '{n:2}-{name}'
    )
    expect(plan.rows.map((r) => r.to)).toEqual(['01-甲', '02-乙', '03-丙'])
    expect(plan.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('重名冲突：同批两个目标相同 → 两行都标 dup，ok=false', () => {
    const plan = planRenames(
      [item({ id: 'a', name: '甲' }), item({ id: 'b', name: '乙' })],
      '固定名'
    )
    expect(plan.rows.map((r) => r.reason)).toEqual(['dup', 'dup'])
    expect(plan.ok).toBe(false)
  })

  it('重名比较忽略大小写（Windows 大小写不敏感）', () => {
    const plan = planRenames(
      [item({ id: 'a', name: 'Sofa' }), item({ id: 'b', name: 'sofa' })],
      '{name}'
    )
    // 目标字面不同（Sofa / sofa）但在 Windows 上是同一个目录 → 必须拦
    expect(plan.rows.map((r) => r.to)).toEqual(['Sofa', 'sofa'])
    expect(plan.rows.every((r) => r.reason === 'dup')).toBe(true)
    expect(plan.ok).toBe(false)
  })

  it('有冲突时即使还有正常行，整批也不可执行', () => {
    const plan = planRenames(
      [item({ id: 'a', name: '甲' }), item({ id: 'b', name: '乙' }), item({ id: 'c', name: '丙' })],
      '{c1}' // 三行同分类 → 全部 dup
    )
    expect(plan.ok).toBe(false)
    expect(plan.rows.every((r) => r.reason === 'dup')).toBe(true)
  })

  it('新旧同名标 unchanged（允许跳过，不算错）', () => {
    const plan = planRenames([item({ id: 'a', name: '沙发' })], '{name}')
    expect(plan.rows[0]).toMatchObject({ from: '沙发', to: '沙发', reason: 'unchanged' })
    expect(plan.ok).toBe(true)
  })

  it('unchanged 行与改名行撞名 → 也算 dup（它同样占着这个名字）', () => {
    const plan = planRenames(
      [item({ id: 'a', name: '沙发' }), item({ id: 'b', name: '别的东西' })],
      '沙发'
    )
    expect(plan.rows.map((r) => r.reason)).toEqual(['dup', 'dup'])
    expect(plan.ok).toBe(false)
  })

  it('Windows 保留名标 invalid（不可执行）', () => {
    const plan = planRenames([item({ id: 'a', name: '甲' })], 'CON')
    expect(plan.rows[0].reason).toBe('invalid')
    expect(plan.ok).toBe(false)
  })

  it('模板产出空 → 回退原名（结果 unchanged，不产生空文件夹名）', () => {
    const plan = planRenames([item({ id: 'a', name: '沙发' })], '   ')
    expect(plan.rows[0].to).toBe('沙发')
    expect(plan.rows[0].reason).toBe('unchanged')
    expect(plan.ok).toBe(true)
  })

  it('模板里的 / 被清洗成 _（不会把资产搬进别的目录）', () => {
    const plan = planRenames([item({ id: 'a', name: '甲' })], '{c1}/{c2}')
    expect(plan.rows[0].to).toBe('家具_衣柜')
    expect(plan.rows[0].to).not.toContain('/')
  })

  it('未知占位符出现在计划里（UI 必须提示）', () => {
    const plan = planRenames([item({ id: 'a', name: '甲' })], '{bogus}-{name}')
    expect(plan.unknownTokens).toEqual(['{bogus}'])
    // 未知占位符原样落在名字里（不静默吞掉）
    expect(plan.rows[0].to).toBe('{bogus}-甲')
  })

  it('rows 与 items 等长同序（预览表按下标对齐）', () => {
    const items = [item({ id: 'x', name: '甲' }), item({ id: 'y', name: '乙' })]
    const plan = planRenames(items, '{n}')
    expect(plan.rows).toHaveLength(items.length)
    expect(plan.rows.map((r) => r.id)).toEqual(['x', 'y'])
  })
})
