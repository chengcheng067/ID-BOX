/**
 * 别名建议单测（docs/20 §5.3 · T-D1）。
 *
 * 契约：**只建议、不猜，且不得降级**。返回值只可能来自 `taxonomy.ts` 的受控词条；
 * 命中不了（典型：纯英文包名）一律 `null`；名字里**已经含**该词的也返回 `null`
 * （否则等于把用户的名字改短）。
 */
import { describe, expect, it } from 'vitest'
import { suggestAlias } from '../src/shared/aliasSuggest'

describe('suggestAlias — 命中受控词表且带来新信息', () => {
  it('尾字族命中：现代简约玄关柜 → 柜子（名字里没有「柜子」二字，不复伤）', () => {
    expect(suggestAlias('现代简约玄关柜')).toBe('柜子')
  })

  it('含 / 的并列词条取第一个子词：北欧实木餐椅 → 椅子（不是「椅子/凳子」）', () => {
    expect(suggestAlias('北欧实木餐椅')).toBe('椅子')
    expect(suggestAlias('北欧实木餐椅')).not.toContain('/')
  })

  it('规则 B 剥掉尾部功能词后仍能建议：电视柜组合 / 书架01', () => {
    // 「电视柜组合」剥「组合」→「电视柜」→ 词根「柜」→ 柜子
    expect(suggestAlias('电视柜组合')).toBe('柜子')
    // 「书架01」剥版本号 →「书架」→ 词根「架」→ 架子
    expect(suggestAlias('书架01')).toBe('架子')
  })
})

describe('suggestAlias — 降级守卫（名字里已有该词 → null）', () => {
  it('已含命中词的纯中文名不降级：无堺黑色木纹ID_1151853396 → null', () => {
    // 命中一级「木纹」，但「无堺黑色木纹」本来就看懂，建议「木纹」是改短名字
    expect(suggestAlias('无堺黑色木纹ID_1151853396')).toBeNull()
  })

  it('同一条守卫不会误伤"只差虚词"的名字：现代简约玄关柜 仍建议 柜子', () => {
    // 「玄关柜」含「柜」但不含「柜子」，所以候选带来新信息 → 建议
    expect(suggestAlias('现代简约玄关柜')).toBe('柜子')
    expect(suggestAlias('现代简约玄关柜')).not.toBeNull()
  })

  it('候选与原名完全相同 → null（守卫之外的第一道闸）', () => {
    expect(suggestAlias('沙发')).toBeNull()
    expect(suggestAlias('柜子')).toBeNull()
    expect(suggestAlias('石材')).toBeNull()
  })
})

describe('suggestAlias — 命中不了就返回 null（不猜）', () => {
  it('纯英文材质名 → null（词表是中文的，不做音译/机翻）', () => {
    expect(suggestAlias('Brick_Rough_vh1sbjl_2K_surface_ms')).toBeNull()
    expect(suggestAlias('Polished_Concrete_4K')).toBeNull()
    expect(suggestAlias('marble_travertine')).toBeNull()
  })

  it('中文但无任何品类词 → null', () => {
    expect(suggestAlias('完全无关节西')).toBeNull()
    expect(suggestAlias('现代风格效果图')).toBeNull()
  })

  it('空串 / 纯空白 / 非字符串 → null，不抛', () => {
    expect(suggestAlias('')).toBeNull()
    expect(suggestAlias('   ')).toBeNull()
    expect(suggestAlias(undefined as unknown as string)).toBeNull()
  })
})
