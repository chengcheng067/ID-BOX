/**
 * HDR 一级分类词表（站方 hdrtietu 频道页 5 项）+ 自动分类接线。
 *
 * 背景（用户原话：「知末上把hdr的一级分类词表抄了就是」）：HDR 是 0.6.5 就有的独立大类，
 * 但一级词表一直空着 —— 表现为两个问题：
 * ① 手动改派 HDR 资产时一级下拉是空的（只能自由输入）；
 * ② 导入的 HDR 永远落 `未分类/未分类`（`isLevel1AllowedForKind('hdri', …)` 恒 false）。
 *
 * 本文件钉住四件事：
 * - 词表本身（逐字照抄、5 项、无「全部」）；
 * - **闸门**（`isLevel1AllowedForKind`）对 hdri 放行本册、拒绝别册；`other` 仍恒 false；
 * - **自动分类**（`classifyAssetName`）真的能命中 —— 这一条最关键：只加
 *   `CHANNEL_LEVEL1.hdri` 而不给 `autoClassify` 加 `level2Scope:'hdri'` 时，
 *   `classifyAssetName('天空HDR', [], 'hdri')` 仍是双未分类（一级键不在扫描池里）；
 * - **隔离**（`木纹HDR` 必须双未分类）—— 证明通用 40 项二级词条没污染 HDR。
 *
 * ⚠️ 全部是纯函数调用，零 IO、不碰任何真实库目录。
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_LEVEL1,
  HDRI_LEVEL1_LIST,
  LEVEL2_MAP,
  TEXTURE_LEVEL1_LIST,
  isLevel1AllowedForKind,
  level2Of,
  UNCLASSIFIED
} from '../src/shared/taxonomy'
import { autoClassify } from '../src/shared/autoClassify'
import { classifyAssetName } from '../src/shared/classifyAsset'
import { level1OptionsFor, level2OptionsFor } from '../src/renderer/logic/category'

// ── 词表本体 ──────────────────────────────────────────────────────────

describe('HDRI_LEVEL1_LIST：站方 hdrtietu 频道页 5 项（逐字照抄）', () => {
  it('恰好 5 项，逐字为 天空HDR / 城市HDR / 小区HDR / 室内HDR / 户外HDR，且顺序照抄原序', () => {
    expect(HDRI_LEVEL1_LIST).toHaveLength(5)
    // 逐字断言（用数组而非 toContain：顺序也是数据，站方筛选栏就是这个顺序）
    expect([...HDRI_LEVEL1_LIST]).toEqual(['天空HDR', '城市HDR', '小区HDR', '室内HDR', '户外HDR'])
  })

  it('不含「全部」（导航控件不是内容类目，与贴图/材质/CAD 同一条剔除纪律）', () => {
    expect(HDRI_LEVEL1_LIST).not.toContain('全部')
  })

  it('保留词条尾巴上的「HDR」——词表纪律是照抄原文，不为了目录好看去掉', () => {
    for (const l1 of HDRI_LEVEL1_LIST) expect(l1.endsWith('HDR'), l1).toBe(true)
  })

  it('已挂进 CHANNEL_LEVEL1.hdri，且是**同一引用**（不是副本）', () => {
    expect(CHANNEL_LEVEL1.hdri).toBe(HDRI_LEVEL1_LIST)
  })

  it('与另外四册零交集（进 CHANNEL_LEVEL1 的前提；否则键空间不唯一）', () => {
    for (const l1 of HDRI_LEVEL1_LIST) {
      expect(CHANNEL_LEVEL1.model, l1).not.toContain(l1)
      expect(CHANNEL_LEVEL1.texture, l1).not.toContain(l1)
      expect(CHANNEL_LEVEL1.material, l1).not.toContain(l1)
      expect(CHANNEL_LEVEL1.cad, l1).not.toContain(l1)
    }
    // 特别钉住「HDR贴图」vs「天空HDR」：前者是**贴图频道的一级**（HDR 贴图这一整类），
    // 后者是 **HDR 频道的二级细分**（站方两处词表不同源），绝不能混为一谈。
    expect(HDRI_LEVEL1_LIST).not.toContain('HDR贴图')
    expect(TEXTURE_LEVEL1_LIST).toContain('HDR贴图')
  })

  it('5 项都**没有** LEVEL2_MAP 键（站方 HDR 频道只有一级、无第三级 → 无级联）', () => {
    for (const l1 of HDRI_LEVEL1_LIST) {
      expect(LEVEL2_MAP).not.toHaveProperty(l1)
      expect(level2Of(l1)).toEqual([])
    }
  })
})

// ── 闸门（isLevel1AllowedForKind）─────────────────────────────────────

describe('isLevel1AllowedForKind：hdri 放行本册，other 仍恒拒', () => {
  it('★每个 HDR 一级都被 hdri 放行（加册后闸门自动生效，函数体不用改）', () => {
    for (const l1 of HDRI_LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('hdri', l1), l1).toBe(true)
    }
    expect(isLevel1AllowedForKind('hdri', '天空HDR')).toBe(true)
  })

  it('★模型/材质频道的词**不被** hdri 放行（`室内` ≠ `室内HDR`）', () => {
    expect(isLevel1AllowedForKind('hdri', '室内')).toBe(false)
    expect(isLevel1AllowedForKind('hdri', '户外')).toBe(false)
    expect(isLevel1AllowedForKind('hdri', '家具')).toBe(false)
    expect(isLevel1AllowedForKind('hdri', '石材')).toBe(false)
    expect(isLevel1AllowedForKind('hdri', 'HDR贴图')).toBe(false)
    expect(isLevel1AllowedForKind('hdri', UNCLASSIFIED)).toBe(false)
  })

  it('other 仍然恒拒（本轮只给 hdri 加册，other 一个字节没动）', () => {
    for (const any of ['天空HDR', '家具', '石材', 'CAD图库', '室内HDR', UNCLASSIFIED]) {
      expect(isLevel1AllowedForKind('other', any), any).toBe(false)
    }
  })

  it('反向不污染：HDR 的一级不会被模型/材质/CAD 放行', () => {
    for (const l1 of HDRI_LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('model', l1), l1).toBe(false)
      expect(isLevel1AllowedForKind('texture', l1), l1).toBe(false)
      expect(isLevel1AllowedForKind('material', l1), l1).toBe(false)
      expect(isLevel1AllowedForKind('cad', l1), l1).toBe(false)
    }
  })
})

// ── UI 下拉（level1OptionsFor / level2OptionsFor）─────────────────────

describe('UI 级联：HDR 有一级册、无二级级联', () => {
  it('level1OptionsFor(hdri) = 5 项（手动改派终于有下拉可选）', () => {
    expect(level1OptionsFor('hdri')).toHaveLength(5)
    expect(level1OptionsFor('hdri')).toEqual(HDRI_LEVEL1_LIST)
  })

  it('level2OptionsFor(任一 HDR 一级, hdri) === null → UI 走「可自由输入」', () => {
    for (const l1 of HDRI_LEVEL1_LIST) {
      expect(level2OptionsFor(l1, 'hdri'), l1).toBeNull()
    }
    expect(level2OptionsFor('天空HDR', 'hdri')).toBeNull()
    // 与「一级=未分类」的锁定分支区分开：那条返回 `[]`，不是 `null`
    expect(level2OptionsFor(UNCLASSIFIED, 'hdri')).toEqual([])
  })

  it("level1OptionsFor('other') 仍为 []（只有 other 无词表了）", () => {
    expect(level1OptionsFor('other')).toEqual([])
  })
})

// ── 自动分类（关键接线）────────────────────────────────────────────

describe('autoClassify · level2Scope:hdri（只换一级键、不跑二级）', () => {
  it('★level1Only + hdri scope 能命中一级（不加 scope 时扫的是 40 个 SU/贴图键，恒 null）', () => {
    const hit = autoClassify('天空HDR', undefined, { level1Only: true, level2Scope: 'hdri' })
    expect(hit).toMatchObject({ category1: '天空HDR', category2: UNCLASSIFIED })

    // 反证：同一名字**不带** scope 时，一级键换成 `Object.keys(LEVEL2_MAP)`，
    // HDR 的 5 项不在池子里 → 一个都判不出（这正是"只加册等于白加"的证据）
    expect(autoClassify('天空HDR', undefined, { level1Only: true })).toBeNull()
  })

  it('不带 level1Only 也能命中（scope 分支自己跳过轮 1，不依赖调用方传 level1Only）', () => {
    const hit = autoClassify('天空HDR', undefined, { level2Scope: 'hdri' })
    expect(hit).toMatchObject({ category1: '天空HDR', category2: UNCLASSIFIED })
  })
})

describe('classifyAssetName · HDR 端到端（导入 / 重跑分类走的唯一入口）', () => {
  const classify = (name: string) => classifyAssetName(name, [], 'hdri')

  it('★真实用户库的命名格式（纯参数名）→ 双未分类，**不能**因为含「HDR」就乱塞一个类', () => {
    // 用户真实库 33 个 HDR 全是这种名字；「HDR」在这里是产品名后缀，不是分类信号
    expect(classify('古月视觉HDR-偏移U：0.23')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
    expect(classify('21.古月视觉HDR-偏移 V：-0.01平铺：2')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })

  it('名字含「天空」→ 天空HDR / 未分类（一级命中、二级留哨兵）', () => {
    expect(classify('天空HDR 晴天')).toEqual({
      category1: '天空HDR',
      category2: UNCLASSIFIED
    })
  })

  it('裸「天空」（无 HDR 后缀）**不**命中 —— 尾锚定纪律，不做模糊匹配', () => {
    // `matchTerm` 对 CJK 词条要求「某个 token **以词条结尾**」。token `天空` 不以
    // `天空hdr` 结尾 → 不命中。这是 autoClassify 一贯的**刻保守**纪律（禁止单字/任意位置
    // 模糊，见模块头规则 1），不能为了"多命中几个 HDR"给它开口子：
    // 一旦放宽成 includes，`天空` 会同时命中任何名字带「天空」的模型/贴图资产。
    expect(classify('天空')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })

  it('名字含「室内」/「城市」/「小区」/「户外」→ 各自的一级', () => {
    expect(classify('室内HDR 客厅').category1).toBe('室内HDR')
    expect(classify('城市HDR 夜景').category1).toBe('城市HDR')
    expect(classify('小区HDR 日景').category1).toBe('小区HDR')
    expect(classify('户外HDR 草地').category1).toBe('户外HDR')
    // 五个一级全部可达（不是只有其中一个通了）
    for (const l1 of HDRI_LEVEL1_LIST) {
      const bare = l1.replace(/HDR$/, '')
      expect(classify(`${bare}HDR`).category1, bare).toBe(l1)
    }
  })

  it('★隔离：`木纹HDR` → 双未分类（通用 40 项二级词条没有污染 HDR 频道）', () => {
    // 「木纹」是贴图频道的**一级**（二级表里也有大量木纹词）。若 `level2Scope:'hdri'`
    // 没有跳过轮 1，这里会被判成 `木纹/…`（错分进贴图频道）。
    expect(classify('木纹HDR')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
    // 再补两个确认不是"恰好木纹不命中"：石材 / 沙发 也一样必须双未分类
    expect(classify('石材HDR').category1).toBe(UNCLASSIFIED)
    expect(classify('沙发HDR').category1).toBe(UNCLASSIFIED)
  })

  it('★反向不污染：`天空` 给 kind=model 不该判成天空HDR', () => {
    const model = classifyAssetName('天空', [], 'model')
    expect(model.category1).not.toBe('天空HDR')
    // 模型频道也不该因为「天空」被判进任何 HDR 一级
    for (const l1 of HDRI_LEVEL1_LIST) expect(model.category1).not.toBe(l1)
  })

  it('回归：既有的 hdri 用例口径不变（`北欧挂画` 仍双未分类）', () => {
    // 这条是 `tests/classifyAsset.test.ts` 里那条的镜像：加册前它靠"无词表恒拒"成立，
    // 现在靠"一级册里没有挂画"成立 —— 结果一致，理由不同（值得在守卫里留一份）。
    expect(classify('北欧挂画')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
  })
})
