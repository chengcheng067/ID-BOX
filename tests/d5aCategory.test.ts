import { describe, expect, it } from 'vitest'
import { level1OptionsFor, level2OptionsFor, styleOptionsFor } from '../src/renderer/logic/category'
import type { AssetKind } from '../src/shared/types'

/**
 * D5A 必须与「模型」共用同一套分类词表（2026-11-09 真机缺陷回归）。
 *
 * ## 缺陷现象（用户截图，逐字）
 * 「我现在发现第 5a 是没有办法选择一级分类、二级分类的。那既然是模型，那肯定是跟我们
 * 模型的一级分类、二级分类是在一起的呀。」
 *
 * 截图里整理浮层给一个 `.d5a` 资产（休闲椅 · D5A · 未分类/未分类）指派分类，
 * 一级分类下拉只有一个「未分类」——选不出任何真实类目，等于这个资产永远无法分类。
 *
 * ## 根因
 * `level1OptionsFor` / `styleOptionsFor` 用裸 `kind === 'model'` 判定，
 * 而 D5A 的 `AssetKind` 是 `'d5a'`，直接落到 `return []`。
 * 根源是「D5A 属于模型域」这条收口只做到了筛选与落盘，没做到分类选择器。
 *
 * ## 为什么这组测试要用「与 model 逐项相等」而不是「非空」
 * 非空只能证明"有东西可选"；这条缺陷的本质是**两边词表必须同源**——
 * 一旦将来有人给 D5A 单开一张表，它就又变成"模型域里的另一套分类"，
 * 与 `MODEL_KIND_MEMBERS` 收口时的结论冲突。所以判据钉成逐项相等。
 */

const MODEL_LIKE: AssetKind[] = ['model', 'd5a']

describe('D5A 与模型共用分类词表', () => {
  it('一级分类选项与 model 逐项相同，且不为空', () => {
    const model = level1OptionsFor('model')
    expect(model.length).toBeGreaterThan(0)
    for (const kind of MODEL_LIKE) {
      expect(level1OptionsFor(kind)).toEqual(model)
    }
  })

  it('一级选项里能选到真实类目（不是只剩「未分类」）', () => {
    const opts = level1OptionsFor('d5a')
    // 家具是模型频道最基础的一级，出现在这里说明词表真的接上了
    expect(opts).toContain('家具')
    expect(opts).not.toContain('未分类')
  })

  it('二级分类按一级级联，且与 model 一致', () => {
    const modelL2 = level2OptionsFor('家具', 'model')
    expect(modelL2).not.toBeNull()
    expect(level2OptionsFor('家具', 'd5a')).toEqual(modelL2)
    // 与 model 同表 ⇒ 二级也是真实类目
    expect(Array.isArray(modelL2) && modelL2.length).toBeTruthy()
  })

  it('风格选项与 model 逐项相同（D5A 也要能选风格）', () => {
    const modelStyles = styleOptionsFor('model')
    expect(modelStyles.length).toBeGreaterThan(0)
    expect(styleOptionsFor('d5a')).toEqual(modelStyles)
  })
})

describe('反向守卫：不要把别的 kind 误并进模型域', () => {
  it('CAD 仍走自己的词表，不等于模型的一级', () => {
    const cad = level1OptionsFor('cad')
    expect(cad.length).toBeGreaterThan(0)
    expect(cad).not.toEqual(level1OptionsFor('model'))
  })

  it('HDRI 仍走自己的词表', () => {
    const hdri = level1OptionsFor('hdri')
    expect(hdri.length).toBeGreaterThan(0)
    expect(hdri).not.toEqual(level1OptionsFor('model'))
  })

  it('材质（texture / material）仍走合并后的材质词表', () => {
    const tex = level1OptionsFor('texture')
    expect(tex.length).toBeGreaterThan(0)
    expect(level1OptionsFor('material')).toEqual(tex)
    expect(tex).not.toEqual(level1OptionsFor('model'))
  })

  it('未知 / 其他类目拿不到模型词表（兜底仍是空）', () => {
    expect(level1OptionsFor('other')).toEqual([])
    expect(styleOptionsFor('other')).toEqual([])
  })
})
