/// <reference lib="dom" />
// ↑ 本文件走 tsconfig.node（tests/**）：store 部分用到 `window`，按 savedViewStore.test.ts 同手法挂 DOM lib。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import {
  EMPTY_CUSTOM_TAXONOMY,
  MAX_CUSTOM_TERMS,
  countCustomUsage,
  customLevel1Of,
  customLevel2Of,
  mergeVocab,
  normalizeCustomTaxonomy,
  sanitizeCustomTerm
} from '../src/shared/customTaxonomy'
import { normalizeSettings } from '../src/main/settings'
import { composeRelFolder, sanitizeCategorySegment } from '../src/shared/naming'
import { autoClassify } from '../src/shared/autoClassify'
import { level1OptionsFor, level2OptionsFor } from '../src/renderer/logic/category'

// ── 1. 词条清洗（与落盘目录段同源） ────────────────────────────────────

describe('sanitizeCustomTerm：清洗规则与落盘管线一致', () => {
  it('`/` 与 `\\` 替换为 `_`，且与 composeRelFolder 内部用的 sanitizeCategorySegment 同结果', () => {
    expect(sanitizeCustomTerm('床/沙发')).toBe('床_沙发')
    expect(sanitizeCustomTerm('床/沙发')).toBe(sanitizeCategorySegment('床/沙发'))
    expect(sanitizeCustomTerm('a\\b')).toBe('a_b')
    // 组合落盘：净化后的自定义词条进 composeRelFolder 得到合法四段路径
    expect(composeRelFolder('模型', sanitizeCustomTerm('软装/灯'), '未分类', 'x.skp')).toBe(
      '模型/软装_灯/未分类/x.skp'
    )
  })

  it('去首尾空白、折叠连续空白、掐掉尾部 [. ]（Windows 目录段不允许以点空格结尾）', () => {
    expect(sanitizeCustomTerm('  新中式  ')).toBe('新中式')
    expect(sanitizeCustomTerm('北欧  风')).toBe('北欧 风')
    expect(sanitizeCustomTerm('北欧风. .')).toBe('北欧风')
  })

  it('非法值丢弃：空串 / 非字符串 / 哨兵「未分类」/ 只含占位符', () => {
    expect(sanitizeCustomTerm('')).toBe('')
    expect(sanitizeCustomTerm('   ')).toBe('')
    expect(sanitizeCustomTerm(123)).toBe('')
    expect(sanitizeCustomTerm(null)).toBe('')
    expect(sanitizeCustomTerm('未分类')).toBe('')
    expect(sanitizeCustomTerm('___')).toBe('')
    expect(sanitizeCustomTerm('. . .')).toBe('')
  })

  it('超长按码点截断到 40（与 cleanSegment 同限，不割开代理对）', () => {
    const long = '测'.repeat(45)
    expect(Array.from(sanitizeCustomTerm(long))).toHaveLength(40)
    const emoji = '🏠'.repeat(45)
    expect(Array.from(sanitizeCustomTerm(emoji))).toHaveLength(40)
    expect(sanitizeCustomTerm(emoji)).not.toContain('\uFFFD')
  })
})

// ── 2. 词表归一化（读档 / 写档唯一入口） ──────────────────────────────

describe('normalizeCustomTaxonomy：脏值逐条丢弃，绝不抛错', () => {
  it('非法形状（null / 非对象 / 数组字段缺失）→ 空词表', () => {
    expect(normalizeCustomTaxonomy(null)).toEqual(EMPTY_CUSTOM_TAXONOMY)
    expect(normalizeCustomTaxonomy(undefined)).toEqual(EMPTY_CUSTOM_TAXONOMY)
    expect(normalizeCustomTaxonomy('garbage')).toEqual(EMPTY_CUSTOM_TAXONOMY)
    expect(normalizeCustomTaxonomy({})).toEqual(EMPTY_CUSTOM_TAXONOMY)
  })

  it('层内去重 + 清洗 + 剔除与预设同名（含净化后形态等价）的词条', () => {
    const out = normalizeCustomTaxonomy({
      level1: [' 木质家具 ', '家具', '', '未分类', 123, '木质家具', '电器/器材'],
      level2: {
        家具: ['床/沙发', '床_沙发', ''],
        '': ['不应出现'],
        '   ': ['也不应出现']
      }
    })
    // 「家具」是预设一级；「电器/器材」净化成「电器_器材」仍与预设「电器/器材」形态等价 → 都不收
    expect(out.level1).toEqual(['木质家具'])
    // 层内去重（床/沙发 与 床_沙发 净化后同名）；空父键整组丢弃
    expect(out.level2).toEqual({ 家具: ['床_沙发'] })
  })

  it('空二级组不落档；level2 非数组列表整组丢弃', () => {
    const out = normalizeCustomTaxonomy({
      level1: [],
      level2: { 家具: [], 灯具: 'not-an-array' }
    })
    expect(out.level2).toEqual({})
  })

  it(`每层封顶 ${MAX_CUSTOM_TERMS} 条（防 settings.json 被病态撑爆）`, () => {
    const many = Array.from({ length: MAX_CUSTOM_TERMS + 50 }, (_, i) => `自定义分类${i}`)
    const out = normalizeCustomTaxonomy({ level1: many })
    expect(out.level1).toHaveLength(MAX_CUSTOM_TERMS)
  })
})

// ── 3. 合并展示：预设在前、自定义在后且可区分 ────────────────────────

describe('mergeVocab：自定义词条与预设并列且可区分', () => {
  it('custom 标记：预设行 false、自定义行 true', () => {
    const merged = mergeVocab(['石材', '木纹'], ['我的收藏', '石材'])
    expect(merged).toEqual([
      { value: '石材', custom: false },
      { value: '木纹', custom: false },
      { value: '我的收藏', custom: true }
    ])
  })

  it('自定义为空 → 全部是预设行', () => {
    expect(mergeVocab(['石材'], [])).toEqual([{ value: '石材', custom: false }])
    expect(mergeVocab(['石材'], undefined)).toEqual([{ value: '石材', custom: false }])
  })

  it('与预设词表叠加：level1OptionsFor / level2OptionsFor 仍只出预设（合并发生在 UI 层）', () => {
    const custom = { level1: ['我的收藏'], level2: { 家具: ['床_沙发'] } }
    // 预设函数不动（自动分类与既有调用方零影响）
    expect(level1OptionsFor('model')).not.toContain('我的收藏')
    expect(level2OptionsFor('家具')).not.toContain('床_沙发')
    // UI 合并后自定义词条可区分地出现在尾部
    const l1 = mergeVocab(level1OptionsFor('model'), customLevel1Of(custom))
    expect(l1.at(-1)).toEqual({ value: '我的收藏', custom: true })
    const l2 = mergeVocab(level2OptionsFor('家具') ?? [], customLevel2Of(custom, '家具'))
    expect(l2.at(-1)).toEqual({ value: '床_沙发', custom: true })
  })
})

// ── 4. 删除保护：被资产使用的词条不许删 ──────────────────────────────

describe('countCustomUsage：删除保护的唯一判据', () => {
  const assets = [
    { category1: '我的收藏', category2: '未分类' },
    { category1: '我的收藏', category2: '宝贝' },
    { category1: '家具', category2: '宝贝' }, // 不同一级下的同名二级，互不牵连
    { category1: '石材', category2: '未分类' }
  ]

  it('level1 按一级名全局计数', () => {
    expect(countCustomUsage(assets, { level: 'level1', name: '我的收藏' })).toBe(2)
    expect(countCustomUsage(assets, { level: 'level1', name: '不存在' })).toBe(0)
  })

  it('level2 按「一级 + 二级」成对计数', () => {
    expect(countCustomUsage(assets, { level: 'level2', parent: '我的收藏', name: '宝贝' })).toBe(1)
    expect(countCustomUsage(assets, { level: 'level2', parent: '家具', name: '宝贝' })).toBe(1)
    expect(countCustomUsage(assets, { level: 'level2', parent: '石材', name: '宝贝' })).toBe(0)
  })

  it('资产缺 category 字段（老数据）按未分类兜底，不抛错', () => {
    expect(countCustomUsage([{} as { category1: string; category2: string }], { level: 'level1', name: '我的收藏' })).toBe(0)
  })
})

// ── 5. 硬约束守卫：自动分类完全不认自定义词 ──────────────────────────

describe('autoClassify 对自定义词条返回 null（守卫测试）', () => {
  it('自定义一级词条出现在资产名里 → 不命中（自动分类只认预设词表）', () => {
    const custom = normalizeCustomTaxonomy({ level1: ['星际档案馆'] })
    expect(custom.level1).toEqual(['星际档案馆'])
    expect(autoClassify('星际档案馆收藏合集')).toBeNull()
  })

  it('自定义二级词条同理不参与二级匹配', () => {
    const custom = normalizeCustomTaxonomy({ level2: { 家具: ['超现实躺椅'] } })
    expect(custom.level2['家具']).toEqual(['超现实躺椅'])
    expect(autoClassify('超现实躺椅三件套')).toBeNull()
  })
})

// ── 6. settings 落档：脏词条只丢词条，不拖垮整份设置 ─────────────────

describe('normalizeSettings × customTaxonomy', () => {
  it('DEFAULT_SETTINGS.customTaxonomy 为空词表', () => {
    expect(DEFAULT_SETTINGS.customTaxonomy).toEqual(EMPTY_CUSTOM_TAXONOMY)
  })

  it('写档前统一清洗（脏形状 / 脏词条逐条降级）', () => {
    const s = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customTaxonomy: {
        level1: [' 新中式 ', '家具', null, ''],
        level2: { 家具: ['床/沙发'], 灯具: 'garbage' }
      }
    } as unknown as Partial<Settings>)
    expect(s.customTaxonomy.level1).toEqual(['新中式'])
    expect(s.customTaxonomy.level2).toEqual({ 家具: ['床_沙发'] })
    // 其余设置不受牵连
    expect(s.libraryDir).toBe(DEFAULT_SETTINGS.libraryDir)
  })

  it('customTaxonomy 缺键 / 整块脏值 → 空词表（不抛错）', () => {
    const missing = normalizeSettings({ ...DEFAULT_SETTINGS } as Partial<Settings>)
    expect(missing.customTaxonomy).toEqual(EMPTY_CUSTOM_TAXONOMY)
    const dirty = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customTaxonomy: 'garbage'
    } as unknown as Partial<Settings>)
    expect(dirty.customTaxonomy).toEqual(EMPTY_CUSTOM_TAXONOMY)
  })
})

// ── 7. store 动作：新增 / 删除（删除保护在 store 层） ────────────────

const setSettings = vi.fn()

;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault: { setSettings } as unknown as ModVaultApi
}

const { useVault } = await import('../src/renderer/store')

/** 与 main/settings.ts 的语义一致：合并补丁后返回完整 Settings */
function merged(patch: Partial<Settings>): Settings {
  const cur = useVault.getState().settings ?? DEFAULT_SETTINGS
  return { ...cur, ...patch }
}

beforeEach(() => {
  setSettings.mockReset()
  setSettings.mockImplementation(async (patch: Partial<Settings>) => merged(patch))
  useVault.setState({
    settings: { ...DEFAULT_SETTINGS },
    assets: [],
    notice: null
  })
})

describe('store.addCustomCategory', () => {
  it('新增一级词条：清洗后写入 settings.customTaxonomy 并落档', async () => {
    const ok = await useVault.getState().addCustomCategory('level1', null, '  新中式  ')
    expect(ok).toBe(true)
    expect(useVault.getState().settings?.customTaxonomy.level1).toEqual(['新中式'])
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings.mock.calls[0][0].customTaxonomy).toEqual({
      level1: ['新中式'],
      level2: {}
    })
  })

  it('重复新增 → false 且不发写档', async () => {
    await useVault.getState().addCustomCategory('level1', null, '新中式')
    expect(await useVault.getState().addCustomCategory('level1', null, ' 新中式 ')).toBe(false)
    expect(setSettings).toHaveBeenCalledTimes(1)
  })

  it('新增二级词条：挂到所属一级名下；`/` 净化为 `_`', async () => {
    await useVault.getState().addCustomCategory('level2', '我的收藏', '床/沙发')
    expect(useVault.getState().settings?.customTaxonomy.level2).toEqual({
      我的收藏: ['床_沙发']
    })
  })

  it('清洗后为空（如「未分类」）→ false 不落档', async () => {
    expect(await useVault.getState().addCustomCategory('level1', null, '未分类')).toBe(false)
    expect(setSettings).not.toHaveBeenCalled()
  })
})

describe('store.removeCustomCategory（删除保护）', () => {
  it('被资产使用 → 拒绝并返回使用数，settings 不变', async () => {
    useVault.setState({
      settings: { ...DEFAULT_SETTINGS, customTaxonomy: { level1: ['新中式'], level2: {} } },
      assets: [
        { id: 'a', category1: '新中式', category2: '未分类' } as never,
        { id: 'b', category1: '新中式', category2: '宝宝房' } as never
      ]
    })
    const res = await useVault.getState().removeCustomCategory('level1', null, '新中式')
    expect(res).toEqual({ ok: false, used: 2 })
    expect(useVault.getState().settings?.customTaxonomy.level1).toEqual(['新中式'])
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('未被使用 → 删除成功；删一级时其名下的自定义二级一并移除', async () => {
    useVault.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        customTaxonomy: { level1: ['新中式'], level2: { 新中式: ['宝宝房'] } }
      },
      assets: []
    })
    const res = await useVault.getState().removeCustomCategory('level1', null, '新中式')
    expect(res).toEqual({ ok: true, used: 0 })
    expect(useVault.getState().settings?.customTaxonomy).toEqual(EMPTY_CUSTOM_TAXONOMY)
  })

  it('删二级只删该词条；组空了连键一起清', async () => {
    useVault.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        customTaxonomy: { level1: [], level2: { 我的收藏: ['宝贝', '珍藏'] } }
      },
      assets: []
    })
    expect(
      await useVault.getState().removeCustomCategory('level2', '我的收藏', '宝贝')
    ).toEqual({ ok: true, used: 0 })
    expect(useVault.getState().settings?.customTaxonomy.level2).toEqual({ 我的收藏: ['珍藏'] })
    await useVault.getState().removeCustomCategory('level2', '我的收藏', '珍藏')
    expect(useVault.getState().settings?.customTaxonomy.level2).toEqual({})
  })

  it('词条不存在 → ok:false（幂等，不写档）', async () => {
    const res = await useVault.getState().removeCustomCategory('level1', null, '不存在')
    expect(res.ok).toBe(false)
    expect(setSettings).not.toHaveBeenCalled()
  })
})

// ── 8. 选择器源码守卫：入口 UI 真的接上了自定义词表 ──────────────────

const PICKER = 'src/renderer/components/CategoryPicker.tsx'

describe('CategoryPicker 自定义词表接线（源码守卫）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), PICKER), 'utf8')

  it('两处浮层都从自定义词表合并选项，且带 custom 区分标记', () => {
    expect(src).toContain("customLevel1Of(customTax)")
    expect(src).toContain("customLevel2Of(customTax, level1)")
    // mergeVocab 在一级 / 二级各用一次
    expect(src.split('mergeVocab(').length - 1).toBe(2)
  })

  it('自定义词条尾部画「自定义」角标（group-hover 隐藏，给删除 × 让位）', () => {
    expect(src.split('group-hover:hidden').length - 1).toBe(2)
    expect(src).toContain('自定义')
  })

  it('两处浮层都有「＋ 新增自定义」输入行（Enter 提交并选中）', () => {
    expect(src).toContain('＋ 新增自定义一级分类')
    expect(src).toContain('＋ 新增自定义二级分类')
    expect(src).toContain("void commitAdd('level1')")
    expect(src).toContain("void commitAdd('level2')")
  })

  it('自定义词条带删除 ×（删除保护提示走 setNotice）', () => {
    expect(src).toContain('删除自定义一级分类')
    expect(src).toContain('删除自定义二级分类')
    expect(src).toContain('已被 ${res.used} 个资产使用，无法删除')
  })

  it('确认指派时：不在任何词表的输入值自动记为自定义词条（HDR 等自由输入大类的自定义通道）', () => {
    expect(src).toContain("await addCustomCategory('level1', null, c1)")
    expect(src).toContain("await addCustomCategory('level2', c1, c2)")
  })
})
