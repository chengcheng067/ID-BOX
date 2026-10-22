/**
 * 材质频道二级词表（v1.0.14 · `MATERIAL_LEVEL2_MAP` · docs/18）验收。
 *
 * 背景：此前以为「材质频道只有一级、没有二级」（docs/07 §5.11），所以
 * `材质/木纹/未分类` 被当作"正常终点"。docs/18 用真实浏览器点进一级页后证明该结论
 * 是在**频道首页**观察的（首页不显示二级排），实测 20 个一级共 **106 个二级**。
 *
 * 本组钉四件事：
 * ① 表结构与 docs/18 逐项一致（20 键 / 106 项 / 无「其他」键 / 一级全部过闸门）；
 * ② `level2Scope:'material'` 的优先级（材质二级 > 通用二级 > 三级归并 > 一级）；
 * ③ 材质二级**不污染**模型/贴图侧（同一名字在 model 下仍走三级归并）；
 * ④ 不传 `level2Scope` 时行为一个字节都不变。
 */
import { describe, expect, it } from 'vitest'
import { autoClassify } from '../src/shared/autoClassify'
import { classifyAssetName } from '../src/shared/classifyAsset'
import {
  isLevel1AllowedForKind,
  MATERIAL_LEVEL2_MAP,
  MERGED_MATERIAL_LEVEL1,
  UNCLASSIFIED
} from '../src/shared/taxonomy'

describe('MATERIAL_LEVEL2_MAP — 表结构（docs/18 逐项）', () => {
  it('20 个键 / 106 项二级 / 不含「其他」键（站方该一级无二级排）', () => {
    const keys = Object.keys(MATERIAL_LEVEL2_MAP)
    expect(keys).toHaveLength(20)
    expect(keys).not.toContain('其他')
    const total = keys.reduce((n, k) => n + MATERIAL_LEVEL2_MAP[k]!.length, 0)
    expect(total).toBe(106)
    // 逐组数量与 docs/18 §2 的一级总表一致（顺序也按站方一级顺序）
    expect(keys.map((k) => [k, MATERIAL_LEVEL2_MAP[k]!.length])).toEqual([
      ['石材', 7], ['木材', 5], ['木地板', 4], ['地毯', 4], ['布料', 4],
      ['金属', 10], ['皮革', 5], ['玻璃', 6], ['塑料', 7], ['陶瓷', 4],
      ['涂料', 6], ['墙面', 4], ['地面', 12], ['植物', 4], ['外景', 7],
      ['皮肤器官', 3], ['液体', 3], ['食物', 4], ['纸制品', 4], ['半透明体', 3]
    ])
  })

  it('每一项所属的一级都在材质容器并集（33 项）里 —— 否则会被 kind 闸门丢掉', () => {
    for (const level1 of Object.keys(MATERIAL_LEVEL2_MAP)) {
      expect(MERGED_MATERIAL_LEVEL1, `「${level1}」不在 33 项并集里`).toContain(level1)
      expect(isLevel1AllowedForKind('material', level1), level1).toBe(true)
      expect(isLevel1AllowedForKind('texture', level1), level1).toBe(true)
    }
  })

  it('每组都以外站方兜底项「其他××」结尾；同一一级内二级不重复', () => {
    for (const [level1, list] of Object.entries(MATERIAL_LEVEL2_MAP)) {
      expect(list[list.length - 1], level1).toMatch(/^其他/)
      expect(new Set(list).size, `${level1} 组内有重复`).toBe(list.length)
    }
  })
})

describe('level2Scope:material — 材质二级优先（真实材质资产名）', () => {
  const classify = (name: string) => autoClassify(name, undefined, { level2Scope: 'material' })

  it('哑光木纹 → 木材/哑光木纹（matchedLevel = material-l2）', () => {
    expect(classify('哑光木纹')).toEqual({
      category1: '木材',
      category2: '哑光木纹',
      matchedTerm: '哑光木纹',
      alternativeCategories1: [],
      matchedLevel: 'material-l2'
    })
    // kind 入口（classifyAssetName）也必须走同一条路
    expect(classifyAssetName('哑光木纹', undefined, 'material')).toEqual({
      category1: '木材',
      category2: '哑光木纹'
    })
  })

  it('工字拼木地板 → 木地板/工字拼木地板（拼法维度，不与贴图「人字拼」混用）', () => {
    expect(classifyAssetName('工字拼木地板', undefined, 'material')).toEqual({
      category1: '木地板',
      category2: '工字拼木地板'
    })
    expect(classify('工字拼木地板')?.matchedLevel).toBe('material-l2')
  })

  it('室内盆栽绿植组合（material）→ 植物/绿植（材质二级压过三级归并的 盆栽）', () => {
    // 同一个词 `绿植` 有两重身份：材质二级（植物/绿植）+ 三级归并（植物/盆栽）。
    // 材质容器下必须先取材质二级 —— 这是 level2Scope 的**核心优先级**。
    expect(classify('室内盆栽绿植组合')).toEqual({
      category1: '植物',
      category2: '绿植',
      matchedTerm: '绿植',
      alternativeCategories1: [],
      matchedLevel: 'material-l2'
    })
    expect(classifyAssetName('室内盆栽绿植组合', undefined, 'material')).toEqual({
      category1: '植物',
      category2: '绿植'
    })
  })

  it('不锈钢 → 金属/不锈钢；铝合金 → 金属/金（单字二级「金」的匹配行为如实记录）', () => {
    expect(classifyAssetName('不锈钢', undefined, 'material')).toEqual({
      category1: '金属',
      category2: '不锈钢'
    })
    // ⚠️ 站方金属组有单字二级「金」「银」「铜」「铁」「铝」；后缀锚定下
    // `铝合金` 以「金」结尾 → 落 `金属/金`，**不是** `金属/铝`。
    // 这是既有匹配规则（尾锚定）的直接结果，不是本次改动引入；单字词条天然歧义，
    // 若要更准需引入"最长前缀材料词"另一套规则（本轮不做，如实记录）。
    expect(classifyAssetName('铝合金', undefined, 'material')).toEqual({
      category1: '金属',
      category2: '金'
    })
    // 对照：单字二级本身作为名字时也是合法的
    expect(classifyAssetName('铝', undefined, 'material')).toEqual({
      category1: '金属',
      category2: '铝'
    })
  })

  it('材质二级未命中时落回通用流程：仿古砖 → 砖材/仿古砖；黑色木纹 → 木纹/未分类', () => {
    // 106 项里没有「仿古砖」→ 走通用二级表命中 砖材/仿古砖（行为不变）
    expect(classifyAssetName('现代仿古砖ID_1100000001', undefined, 'material')).toEqual({
      category1: '砖材',
      category2: '仿古砖'
    })
    // 如实说明：材质 106 项只有「高光/哑光/粗糙/原木木纹」，没有「黑色木纹」这种色名，
    // 所以这个真实资产**没有被救回二级**，仍是一级 `木纹` + 二级哨兵。
    expect(classifyAssetName('无堺黑色木纹ID_1151853396', undefined, 'material')).toEqual({
      category1: '木纹',
      category2: UNCLASSIFIED
    })
  })
})

describe('材质二级不得污染模型 / 贴图侧（红线）', () => {
  it('同一名字在 model 下仍走三级归并：室内盆栽绿植组合 → 植物/盆栽', () => {
    expect(classifyAssetName('室内盆栽绿植组合', undefined, 'model')).toEqual({
      category1: '植物',
      category2: '盆栽'
    })
    expect(autoClassify('室内盆栽绿植组合')?.matchedLevel).toBe('l3-alias')
  })

  it('贴图仍用贴图词表：大理石瓷砖 → 瓷砖/大理石瓷砖（不被材质「瓷砖」截胡）', () => {
    expect(classifyAssetName('大理石瓷砖', undefined, 'texture')).toEqual({
      category1: '瓷砖',
      category2: '大理石瓷砖'
    })
    // 若给 texture 也开材质表，会退化成 石材/瓷砖 —— 记录这个对比，钉住"目前不开"
    expect(autoClassify('大理石瓷砖', undefined, { level2Scope: 'material' })).toEqual({
      category1: '石材',
      category2: '瓷砖',
      matchedTerm: '瓷砖',
      alternativeCategories1: [],
      matchedLevel: 'material-l2'
    })
  })

  it('不传 level2Scope 时默认行为完全不变（哑光木纹 → 木纹/未分类，无 material-l2）', () => {
    const hit = autoClassify('哑光木纹')
    expect(hit).toEqual({
      category1: '木纹',
      category2: UNCLASSIFIED,
      matchedTerm: '木纹',
      alternativeCategories1: []
    })
    expect(hit?.matchedLevel).toBeUndefined()
  })
})
