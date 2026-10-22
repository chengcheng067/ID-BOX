import { describe, expect, it } from 'vitest'
import {
  LEVEL1_LIST,
  LEVEL2_MAP,
  LEVEL3_ALIAS,
  TEXTURE_LEVEL1_LIST,
  MATERIAL_LEVEL1_LIST,
  MERGED_MATERIAL_LEVEL1,
  CHANNEL_LEVEL1,
  STYLE_LIST_BY_KIND,
  EXCLUDED_TERMS,
  BRAND_LIST,
  OBSERVED_NOT_ENUMERATED,
  CONFIDENCE,
  UNCLASSIFIED,
  level2Of,
  isKnownLevel1,
  isKnownCombo,
  isLevel1AllowedForKind,
  isStyle,
  isReservedName,
  styleListOf,
  styleListAll,
  taxonomySummary,
  findDuplicateLevel2Names
} from '../src/shared/taxonomy'

describe('一级分类（docs/05 §2 照抄）', () => {
  it('模型频道一级 19 项', () => {
    expect(LEVEL1_LIST.length).toBe(19)
    expect(LEVEL1_LIST[0]).toBe('家装')
    expect(LEVEL1_LIST[18]).toBe('舞台')
  })

  it('贴图频道一级 21 项（已剔除「推荐」——它指向频道首页信息流，不是内容类目）', () => {
    expect(TEXTURE_LEVEL1_LIST.length).toBe(21)
    expect(TEXTURE_LEVEL1_LIST).not.toContain('推荐')
    expect(TEXTURE_LEVEL1_LIST[0]).toBe('石材')
    expect(TEXTURE_LEVEL1_LIST[20]).toBe('商业元素')
  })

  it('「全部」不在任何枚举里（它 = 不筛选，不是分类）', () => {
    expect(LEVEL1_LIST).not.toContain('全部')
    expect(TEXTURE_LEVEL1_LIST).not.toContain('全部')
    for (const list of Object.values(LEVEL2_MAP)) {
      expect(list).not.toContain('全部')
    }
    expect(Object.keys(LEVEL2_MAP)).not.toContain('全部')
  })
})

describe('级联映射 LEVEL2_MAP', () => {
  it('SU 6 组【事实】取值与 docs/05 §5 逐项一致（抽查）', () => {
    expect(level2Of('家具')).toEqual([
      '沙发', '床具', '茶几', '桌子', '椅子/凳子', '柜子', '架子', '家具组合', '户外家具'
    ])
    expect(level2Of('灯具')).toContain('筒灯/射灯')
    expect(level2Of('家装')).toContain('家居吧台区')
    expect(level2Of('建筑')).toHaveLength(20)
  })

  it('【v1.0.11】软装陈设补站方二级 `挂画`，既有本地补充词条一个不少（只加不删）', () => {
    // 2026-10-20 站方核对：软装陈设 二级含 挂画；本地推断词条保留（删了会孤立存量 category2）
    expect(level2Of('软装陈设')).toContain('挂画')
    for (const kept of ['装饰画', '摆件', '花艺', '地毯', '窗帘布艺', '抱枕', '床品', '餐具', '书籍摆件', '雕塑摆件']) {
      expect(level2Of('软装陈设'), `「${kept}」不得被删除`).toContain(kept)
    }
    expect(level2Of('软装陈设')).toHaveLength(11)
  })

  it('贴图频道二级总数 195 → 剔除 4 个花色商品名后 191', () => {
    const raw = 195
    const excluded = EXCLUDED_TERMS['大理石']!.length
    const kept = TEXTURE_LEVEL1_LIST.reduce((s, k) => s + level2Of(k).length, 0)
    expect(kept).toBe(raw - excluded)
  })

  it('SU 频道二级总数 190 → 剔除 2 个品牌后 188', () => {
    // 186 = docs/05 原始抄录的总数；+3 = 【v1.0.10 / docs/17 §4】站方二级补齐
    // （屏风隔断 / 装饰线条 / 电梯）。其余词条一字未改（**只加不改**），
    // 本地补充的 5 项（墙面装饰/地面铺装/柱式/踢脚线/壁炉）仍在原位。
    // +1 = 【v1.0.11 / 2026-10-20】软装陈设补站方二级 `挂画`（只加不删）。
    const raw = 190
    const excluded = EXCLUDED_TERMS['家具']!.length
    const kept = LEVEL1_LIST.reduce((s, k) => s + level2Of(k).length, 0)
    expect(kept).toBe(raw - excluded)
  })

  it('材质频道本轮不建键（v1.0.3 裁定）：大类名不是一级分类名，删除占位死键', () => {
    // `LEVEL2_MAP` 的 key 语义是一级分类名；`材质预设` 是大类名，混进去是不可被合法查询的死键。
    expect(Object.keys(LEVEL2_MAP)).not.toContain('材质预设')
    expect(level2Of('材质预设')).toEqual([]) // undefined → [] → UI「可自由输入」
    expect(isKnownLevel1('材质预设')).toBe(false)
    // 材质频道的一级名同样未建键
    expect(isKnownLevel1('皮肤器官')).toBe(false)
    expect(level2Of('皮肤器官')).toEqual([])
  })

  it('未知一级 → level2Of 返回 []（无键与空键行为一致）', () => {
    expect(level2Of('不存在的分类')).toEqual([])
  })

  it('排除清单已生效：EXCLUDED_TERMS 六词条不得出现在任何 LEVEL2_MAP 值里', () => {
    const all = Object.values(LEVEL2_MAP).flat()
    for (const terms of Object.values(EXCLUDED_TERMS)) {
      for (const t of terms) {
        expect(all, `「${t}」应被剔除却出现在词表里`).not.toContain(t)
      }
    }
  })

  it('EXCLUDED_TERMS 共 6 词条（品牌 2 + 花色 4），BRAND_LIST 与之一致', () => {
    const terms = Object.values(EXCLUDED_TERMS).flat()
    expect(terms.length).toBe(6)
    expect(BRAND_LIST).toEqual(EXCLUDED_TERMS['家具'])
  })
})

describe('风格分册（06 v1.0.2 §9.1：按大类分册，不合并）', () => {
  it('两册各 20 项', () => {
    expect(STYLE_LIST_BY_KIND.model.length).toBe(20)
    expect(STYLE_LIST_BY_KIND.texture.length).toBe(20)
  })

  it('SU 册含「简洁」不含「简欧」；贴图册反之（仅差一项，07 §5.10）', () => {
    expect(styleListOf('model')).toContain('简洁')
    expect(styleListOf('model')).not.toContain('简欧')
    expect(styleListOf('texture')).toContain('简欧')
    expect(styleListOf('texture')).not.toContain('简洁')
  })

  it('styleListAll() = 派生并集 21 项（不落库、不进 schema）', () => {
    const all = styleListAll()
    expect(all.length).toBe(21)
    expect(all).toContain('简洁')
    expect(all).toContain('简欧')
  })

  it('isStyle 对两册都命中；未知值不命中', () => {
    expect(isStyle('侘寂')).toBe(true)
    expect(isStyle('简欧')).toBe(true)
    expect(isStyle('不存在的风格')).toBe(false)
  })

  it('未知大类 → styleListOf 返回 []（不猜测归属）', () => {
    expect(styleListOf('hdri')).toEqual([])
    expect(styleListOf('material')).toEqual([])
  })
})

describe('CONFIDENCE 可信度标记', () => {
  it('6 组【事实】+ 13 组【推断】', () => {
    const summary = taxonomySummary()
    expect(summary.level1Count).toBe(19)
    expect(summary.factGroups).toBe(6)
    expect(summary.inferredGroups).toBe(13)
    expect(summary.styleCount).toBe(20)
  })

  it('19 组全部有标记，不缺漏', () => {
    expect(Object.keys(CONFIDENCE).length).toBe(19)
    for (const k of LEVEL1_LIST) expect(CONFIDENCE[k]).toBeDefined()
  })
})

describe('查询 API', () => {
  it('isKnownLevel1：SU 19 项 + 贴图 21 项 都算已知；未建键的频道不算', () => {
    expect(isKnownLevel1('家具')).toBe(true)
    expect(isKnownLevel1('石材')).toBe(true) // 贴图频道一级
    expect(isKnownLevel1('材质预设')).toBe(false) // v1.0.3：占位死键已删
    expect(isKnownLevel1('不存在的分类')).toBe(false)
  })

  it('isKnownCombo：合法组合 true，跨类组合 false', () => {
    expect(isKnownCombo('家具', '沙发')).toBe(true)
    expect(isKnownCombo('家装', '客厅')).toBe(true)
    expect(isKnownCombo('石材', '水磨石')).toBe(true)
    // 值在词表但属于另一一级 → false（06 §9.2 规则 4）
    expect(isKnownCombo('家具', '客厅')).toBe(false)
    expect(isKnownCombo('未知一级', '任意')).toBe(false)
  })

  it('isReservedName 只认哨兵', () => {
    expect(isReservedName('未分类')).toBe(true)
    expect(isReservedName(' 未分类 ')).toBe(false) // 精确匹配，空白由 normalizeCategoryPair 处理
    expect(isReservedName('家具')).toBe(false)
  })

  it('OBSERVED_NOT_ENUMERATED：属性/颜色两排不进落盘枚举【裁定 v1.0.2】', () => {
    expect(OBSERVED_NOT_ENUMERATED).toEqual(['属性(热词)', '颜色(11色块)'])
    const keys = Object.keys(LEVEL2_MAP)
    for (const t of OBSERVED_NOT_ENUMERATED) expect(keys).not.toContain(t)
  })

  it('UNCLASSIFIED = 未分类', () => {
    expect(UNCLASSIFIED).toBe('未分类')
  })
})

describe('CHANNEL_LEVEL1（v1.0.3：频道 → 一级归属表）', () => {
  it('model = SU 19 项，与 LEVEL1_LIST 同源', () => {
    expect(CHANNEL_LEVEL1.model).toEqual(LEVEL1_LIST)
    expect(CHANNEL_LEVEL1.model.length).toBe(19)
  })

  it('texture = 贴图 21 项（剔除「推荐」）', () => {
    expect(CHANNEL_LEVEL1.texture.length).toBe(21)
    expect(CHANNEL_LEVEL1.texture).not.toContain('推荐')
    expect(CHANNEL_LEVEL1.texture).not.toContain('全部')
  })

  it('material = 材质频道一级，逐项照抄 docs/07 §5.11（剔除「全部」）', () => {
    // ⚠️ 计数勘误：06 v1.0.3 写「20 项」，07 §5.11 原文剔除「全部」后实为 **21 项**（含末项「其他」）。
    // 按"逐项照抄、不删项凑数"原则录 21 项；是否剔除「其他」留架构师裁定（docs/04 §9.5）。
    expect(CHANNEL_LEVEL1.material.length).toBe(21)
    expect(CHANNEL_LEVEL1.material).not.toContain('全部')
    expect(CHANNEL_LEVEL1.material[0]).toBe('石材')
    expect(CHANNEL_LEVEL1.material).toEqual([
      '石材', '木材', '木地板', '地毯', '布料', '金属', '皮革', '玻璃', '塑料', '陶瓷',
      '涂料', '墙面', '地面', '植物', '外景', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
    ])
  })

  it('三频道都不含「全部」；material 独有的一级未建 LEVEL2_MAP 键', () => {
    for (const list of Object.values(CHANNEL_LEVEL1)) {
      expect(list).not.toContain('全部')
    }
    // material 与 texture 有 9 个同名一级（石材/木材/…），它们作为**贴图**键存在于 LEVEL2_MAP —— 这是同名共存，不是材质键。
    // material 与 SU 有 1 个同名一级（植物）。两者都**不算**材质键。
    // 只有 material **独有**的 11 个一级才完全未建键（v1.0.3 裁定：材质频道 Scope Out）。
    const known = new Set([...CHANNEL_LEVEL1.model, ...CHANNEL_LEVEL1.texture])
    const materialOnly = CHANNEL_LEVEL1.material.filter((v) => !known.has(v))
    expect(materialOnly).toEqual([
      '布料', '塑料', '陶瓷', '墙面', '地面', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
    ])
    for (const l1 of materialOnly) {
      expect(LEVEL2_MAP).not.toHaveProperty(l1)
      expect(level2Of(l1)).toEqual([])
    }
  })

  it('material 与 texture 有 9 个同名一级（将来建键必须升级嵌套/前缀键）', () => {
    const overlap = CHANNEL_LEVEL1.material.filter((v) => CHANNEL_LEVEL1.texture.includes(v))
    expect(overlap.sort()).toEqual(
      ['外景', '木材', '地毯', '木地板', '涂料', '玻璃', '石材', '金属', '皮革'].sort()
    )
    // 06 v1.0.3 §9.1 不变式注释里点名的就是这 9 个
    expect(overlap.length).toBe(9)
  })
})

describe('MERGED_MATERIAL_LEVEL1（v1.0.8 / docs/14 §2.2：材质语境一级并集 33 项）', () => {
  const MATERIAL_ONLY = MATERIAL_LEVEL1_LIST.filter((v) => !TEXTURE_LEVEL1_LIST.includes(v))

  it('并集 33 项、无重复、无「全部」/「推荐」', () => {
    expect(MERGED_MATERIAL_LEVEL1.length).toBe(33)
    expect(new Set(MERGED_MATERIAL_LEVEL1).size).toBe(33)
    expect(MERGED_MATERIAL_LEVEL1).not.toContain('全部')
    expect(MERGED_MATERIAL_LEVEL1).not.toContain('推荐')
  })

  it('构成 = 贴图 21 项 + 材质独有 12 项；同名 9 项只出现一次', () => {
    expect(MATERIAL_LEVEL1_LIST.length).toBe(21)
    expect(TEXTURE_LEVEL1_LIST.length).toBe(21)
    expect(MATERIAL_ONLY.length).toBe(12)
    expect(MERGED_MATERIAL_LEVEL1.filter((v) => TEXTURE_LEVEL1_LIST.includes(v))).toHaveLength(21)
    expect(MERGED_MATERIAL_LEVEL1.filter((v) => MATERIAL_LEVEL1_LIST.includes(v))).toHaveLength(21)
    const overlap = MERGED_MATERIAL_LEVEL1.filter(
      (v) => TEXTURE_LEVEL1_LIST.includes(v) && MATERIAL_LEVEL1_LIST.includes(v)
    )
    expect(overlap).toHaveLength(9)
    expect(overlap.sort()).toEqual(
      ['外景', '木材', '地毯', '木地板', '涂料', '玻璃', '石材', '金属', '皮革'].sort()
    )
  })

  it('前 21 项保持贴图册原序；后 12 项是材质独有项按 07 §5.11 原序', () => {
    expect(MERGED_MATERIAL_LEVEL1.slice(0, 21)).toEqual([...TEXTURE_LEVEL1_LIST])
    expect(MERGED_MATERIAL_LEVEL1.slice(21)).toEqual([
      '布料', '塑料', '陶瓷', '墙面', '地面', '植物', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
    ])
    // 派生列表不是键空间的一部分：材质独有且**全局无键**的 11 项必须没有键
    // （「植物」是例外：它因 SU 频道已有 10 项二级而有键，见下一个用例）
    for (const v of [
      '布料', '塑料', '陶瓷', '墙面', '地面', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
    ]) {
      expect(LEVEL2_MAP).not.toHaveProperty(v)
    }
  })

  it('⚠️ 材质独有的 11 项仍未建 LEVEL2_MAP 键（键数仍 40；空键会污染 autoClassify 一级匹配）', () => {
    expect(Object.keys(LEVEL2_MAP).length).toBe(40)
    const notInAnyChannel = MATERIAL_ONLY.filter(
      (v) => ![...CHANNEL_LEVEL1.model, ...CHANNEL_LEVEL1.texture].includes(v)
    )
    expect(notInAnyChannel).toEqual([
      '布料', '塑料', '陶瓷', '墙面', '地面', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
    ])
    for (const v of notInAnyChannel) {
      expect(LEVEL2_MAP).not.toHaveProperty(v)
      expect(level2Of(v)).toEqual([])
      expect(isKnownLevel1(v)).toBe(false)
    }
  })

  it('9 个同名一级的二级词表一条未增减（材质频道无二级排 → 贡献 0 项）', () => {
    const expected: Record<string, number> = {
      石材: 11, 木材: 7, 木地板: 12, 地毯: 7, 金属: 10, 皮革: 4, 玻璃: 4, 涂料: 12, 外景: 7
    }
    for (const [l1, len] of Object.entries(expected)) {
      expect(level2Of(l1)).toHaveLength(len)
    }
    // 「植物」的二级来自 SU 频道（物种名），本次记录既有事实、不做特判（docs/14 §2.2）
    expect(level2Of('植物')).toHaveLength(10)
  })

  it('isKnownCombo 不放松：40 键值零变化 → 既有合法/跨类组合判定逐字节一致', () => {
    expect(isKnownCombo('石材', '水磨石')).toBe(true)
    expect(isKnownCombo('石材', '布料')).toBe(false)
    expect(isKnownCombo('布料', '棉布')).toBe(false)
  })
})

describe('⚠️ 显式不变式（v1.0.3）：LEVEL2_MAP 的 key 全局唯一', () => {
  /**
   * key = 一级分类名，当前 SU 19 与贴图 21 零交集。
   * 将来建材质频道会引入 9 个同名一级 —— 届时**必须**把 LEVEL2_MAP 升级为
   * 按大类嵌套（Record<大类, Record<一级, 二级[]>>）或频道前缀键，
   * **禁止**维持扁平 map 硬塞同名 key。谁硬塞，这条就红。
   */
  it('当前所有 key 全局唯一（出现重复即失败）', () => {
    const keys = Object.keys(LEVEL2_MAP)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('贴图 21 项全部已建键且与 SU 19 项零交集', () => {
    const su = new Set(LEVEL1_LIST)
    for (const l1 of TEXTURE_LEVEL1_LIST) {
      expect(LEVEL2_MAP).toHaveProperty(l1)
      expect(su.has(l1)).toBe(false)
    }
  })
})

describe('跨频道重名守卫（⚠️ 06 v1.0.2 §15-④ 的断言实测不成立，v1.0.3 已勘误采纳）', () => {
  /**
   * 06 v1.0.2 声称「SU 86 项 ∩ 贴图 195 项 = ∅，频道内部亦无重名」。
   * v1.0.3 已勘误采纳实测结果：SU 二级 184 项（非 86）、贴图 191 项（剔除 4 个花色商品名后），
   * 存在 **8 组重名**，归类为 **2 组 SU 频道内部** + **6 组跨 SU↔贴图**：
   * - SU 内部：单身公寓[家装/家装户型]、厨房电器[厨卫五金/电器·器材]（两侧都在 SU 频道）
   * - 跨 SU↔贴图：装饰画、抱枕、门、吊顶、踢脚线、壁纸
   *
   * 本用例把**当前已知的 8 组**钉死：任何新增重名都会让这里变红，提醒决策；
   * 而已知重名不会误报（它们是词表事实，照抄自 docs/05 / docs/07，v1.0.3 裁定**接受同名共存**，
   * **禁止**把重名词条加进 EXCLUDED_TERMS —— 那是"非类目词"机制，混用会毁掉其语义）。
   */
  it('已知重名恰为 8 组，清单固定', () => {
    const dup = findDuplicateLevel2Names()
    expect(dup.size).toBe(8)
    expect(dup.get('单身公寓')).toEqual(['家装', '家装户型'])
    expect(dup.get('厨房电器')).toEqual(['厨卫五金', '电器/器材'])
    expect(dup.get('装饰画')).toEqual(['软装陈设', '挂画'])
    expect(dup.get('抱枕')).toEqual(['软装陈设', '布纹'])
    expect(dup.get('门')).toEqual(['硬装构件', '素材贴图'])
    expect(dup.get('吊顶')).toEqual(['硬装构件', '墙面地面屋面'])
    expect(dup.get('踢脚线')).toEqual(['硬装构件', '砖材'])
    expect(dup.get('壁纸')).toEqual(['SU材质', '壁纸壁画'])
  })

  it('除上述 8 组外，任何二级名只属于一个一级分类', () => {
    const dup = findDuplicateLevel2Names()
    const known = new Set(dup.keys())
    expect(known).toEqual(
      new Set(['单身公寓', '厨房电器', '装饰画', '抱枕', '门', '吊顶', '踢脚线', '壁纸'])
    )
  })

  it('重名归类核对：恰为 2 组 SU 内部 + 6 组跨 SU↔贴图（v1.0.3 修订）', () => {
    const dup = findDuplicateLevel2Names()
    const SU = new Set(LEVEL1_LIST)
    const TEXTURE = new Set(TEXTURE_LEVEL1_LIST)
    let internalSu = 0
    let crossSuTexture = 0
    for (const owners of dup.values()) {
      const inSu = owners.every((o) => SU.has(o))
      const suTex = owners.some((o) => SU.has(o)) && owners.some((o) => TEXTURE.has(o))
      if (inSu) internalSu++
      else if (suTex) crossSuTexture++
    }
    expect(internalSu).toBe(2) // 单身公寓、厨房电器
    expect(crossSuTexture).toBe(6) // 装饰画、抱枕、门、吊顶、踢脚线、壁纸
  })
})

/**
 * 【v1.0.10 / docs/17】硬装构件二级补齐 + 三级归并表（`LEVEL3_ALIAS`）结构守卫。
 *
 * 事实来源：2026-10-20 从 `su.znzmo.com` 分类筛选树实地抄录（三级树）。
 * 本组只守**数据结构不变式**：归并表每一行的 `level1` 必须是已建键的一级、
 * `level2` 必须是该一级下**真实存在**的二级 —— 否则归并会把资产落进
 * `isKnownCombo() === false` 的跨类组合（06 §9.2 规则 4 的合法形态会退化）。
 */
describe('LEVEL3_ALIAS（v1.0.10 三级 → 二级归并表）', () => {
  it('硬装构件 补齐站方 3 个二级：屏风隔断 / 装饰线条 / 电梯', () => {
    for (const l2 of ['屏风隔断', '装饰线条', '电梯']) {
      expect(level2Of('硬装构件')).toContain(l2)
    }
    // 只加不改：既有 11 项一个都没丢
    for (const l2 of [
      '门', '窗', '楼梯', '栏杆', '墙面装饰', '吊顶', '地面铺装', '柱式', '踢脚线', '壁炉', '背景墙'
    ]) {
      expect(level2Of('硬装构件')).toContain(l2)
    }
    expect(level2Of('硬装构件')).toHaveLength(14)
  })

  it('每一行的 level1 已建键、level2 真实存在于该一级下（归并目标必须合法）', () => {
    expect(LEVEL3_ALIAS.length).toBeGreaterThan(0)
    for (const alias of LEVEL3_ALIAS) {
      expect(isKnownLevel1(alias.level1), `${alias.term} → 未知一级 ${alias.level1}`).toBe(true)
      expect(
        isKnownCombo(alias.level1, alias.level2),
        `${alias.term} → ${alias.level1}/${alias.level2} 不是合法组合`
      ).toBe(true)
    }
  })

  it('归并表不改落盘枚举：三级词条本身不得混进 LEVEL2_MAP 的值', () => {
    // 「屏风」「隔断」「花瓶」「边几」「卡座」是**三级**节点，归并只影响匹配，
    // 不得把它们写成二级词条（否则会多出与站方层级不符的目录）。
    const all = Object.values(LEVEL2_MAP).flat()
    for (const term of ['屏风', '隔断', '花瓶', '花瓶花艺', '边几', '边几角几', '卡座', '卡座沙发', '绿植摆件']) {
      expect(all, `「${term}」是三级节点，不得进入 LEVEL2_MAP`).not.toContain(term)
    }
    // 反例：站方真实二级必须已入表
    expect(all).toContain('屏风隔断')
  })

  it('每个 term 至多出现一次（重复会让命中归因不可复现）', () => {
    const terms = LEVEL3_ALIAS.map((a) => a.term)
    expect(new Set(terms).size).toBe(terms.length)
  })

  it('站方真实节点带 source，派生中心语可以不带', () => {
    const byTerm = new Map(LEVEL3_ALIAS.map((a) => [a.term, a]))
    expect(byTerm.get('屏风')?.source).toBe('https://su.znzmo.com/sunewhome/dhpf.html')
    expect(byTerm.get('隔断')?.source).toBe('https://su.znzmo.com/sunewhome/gd.html')
    expect(byTerm.get('花瓶花艺')?.source).toBe('https://su.znzmo.com/sunewhome/hp.html')
    expect(byTerm.get('边几角几')?.source).toBe('https://su.znzmo.com/sunewhome/bianj.html')
    expect(byTerm.get('卡座沙发')?.source).toBe('https://su.znzmo.com/sunewhome/kzsf.html')
    // 派生形式（无独立节点）
    expect(byTerm.get('花瓶')?.source).toBeUndefined()
    expect(byTerm.get('绿植')?.source).toBeUndefined()
  })
})

/**
 * 【v1.0.10】kind ↔ 一级频道一致性闸门（`isLevel1AllowedForKind`）。
 *
 * 背景：`isKnownCombo()` 只校验"一级/二级是否成对"，**不校验一级属于哪个频道**。
 * 落盘父链含大类 + 一级，一旦一级跨频道就会造出错位目录
 * （贴图名命中模型频道的一级 → `材质/硬装构件/…`）。
 * 本组把允许域钉死；`hdri`/`other` 没有一级词表 → 一律 false。
 *
 * 【v1.0.12 修正】`texture` / `material` 共用「材质」容器树（`MERGED_MATERIAL_LEVEL1` 33 项，
 * 与 UI 下拉同源），故**两个 kind 都按并集校验**；`model` 仍按 SU 19 项。
 */
describe('isLevel1AllowedForKind（v1.0.10 频道一致性闸门 / v1.0.12 容器口径）', () => {
  it('model：只认 SU 频道 19 项一级', () => {
    expect(isLevel1AllowedForKind('model', '硬装构件')).toBe(true)
    expect(isLevel1AllowedForKind('model', '家具')).toBe(true)
    for (const l1 of LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('model', l1), l1).toBe(true)
    }
    // 贴图频道独有的一级不在模型频道
    expect(isLevel1AllowedForKind('model', '瓷砖')).toBe(false)
    expect(isLevel1AllowedForKind('model', '木地板')).toBe(false)
  })

  it('texture：认材质容器并集 33 项（v1.0.12 容器口径；模型频道的一级一律拒绝）', () => {
    // 【v1.0.12】texture 与 material 落同一棵「材质」树，闸门按容器并集 `MERGED_MATERIAL_LEVEL1`
    // （33 项 = 贴图 21 ∪ 材质独有 12）校验，与 UI 下拉同源。
    expect(isLevel1AllowedForKind('texture', '瓷砖')).toBe(true)
    expect(isLevel1AllowedForKind('texture', '木地板')).toBe(true)
    for (const l1 of TEXTURE_LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('texture', l1), l1).toBe(true)
    }
    // 材质册独有的项也在同一容器里（UI 对 texture 同样列出这 12 项）
    expect(isLevel1AllowedForKind('texture', '陶瓷')).toBe(true)
    expect(isLevel1AllowedForKind('texture', '布料')).toBe(true)
    // 「硬装构件」是模型频道的一级 → 贴图必须被闸门挡住（`屏风贴图` 的实际路径）
    expect(isLevel1AllowedForKind('texture', '硬装构件')).toBe(false)
    expect(isLevel1AllowedForKind('texture', '家具')).toBe(false)
    expect(isLevel1AllowedForKind('texture', '软装陈设')).toBe(false)
    expect(isLevel1AllowedForKind('texture', '未分类')).toBe(false)
  })

  it('material：认材质容器并集 33 项（v1.0.12：材质容器按并集校验，不再按单册）', () => {
    expect(isLevel1AllowedForKind('material', '石材')).toBe(true)
    expect(isLevel1AllowedForKind('material', '陶瓷')).toBe(true) // 材质独有
    for (const l1 of MATERIAL_LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('material', l1), l1).toBe(true)
    }
    expect(isLevel1AllowedForKind('material', '硬装构件')).toBe(false)
    // 两册的抄录差异仍在（`CHANNEL_LEVEL1` 原样保留仅供追溯），但**闸门不再按单册**：
    // 贴图独有的一级对 material kind 同样放行（它们本来就在「材质」树里、UI 也能选）。
    expect(TEXTURE_LEVEL1_LIST.filter((v) => !MATERIAL_LEVEL1_LIST.includes(v))).toEqual([
      '砖材', '大理石', '瓷砖', '木纹', '挂画', '壁纸壁画', '布纹', '墙面地面屋面', 'HDR贴图',
      '凹凸贴图', '素材贴图', '商业元素'
    ])
    expect(isLevel1AllowedForKind('material', '瓷砖')).toBe(true)
    expect(isLevel1AllowedForKind('material', '木纹')).toBe(true)
    expect(isLevel1AllowedForKind('material', '砖材')).toBe(true)
    expect(isLevel1AllowedForKind('material', '软装陈设')).toBe(false)
    // `MERGED_MATERIAL_LEVEL1` 是唯一判据：33 项之外一律拒绝
    expect(isLevel1AllowedForKind('material', '未分类')).toBe(false)
    expect(MERGED_MATERIAL_LEVEL1.length).toBe(33)
  })

  it('未知 / 无一级词表的 kind（hdri / other）→ 一律 false（命中即丢弃）', () => {
    expect(isLevel1AllowedForKind('hdri', '石材')).toBe(false)
    expect(isLevel1AllowedForKind('other', '家具')).toBe(false)
    expect(isLevel1AllowedForKind('', '家具')).toBe(false)
    expect(isLevel1AllowedForKind('model', '')).toBe(false)
  })

  it('守卫：归并表的目标一级必须都属于模型（SU）频道 —— 否则归并会跨频道落错目录', () => {
    // 归并表的全部来源都是 SU 频道的三级节点（docs/17），目标一级必须也在 SU 频道，
    // 否则 `model` 资产会被归并进别的频道的一级（闸门虽会兜底丢弃，但那说明表本身错了）。
    for (const alias of LEVEL3_ALIAS) {
      expect(
        isLevel1AllowedForKind('model', alias.level1),
        `${alias.term} → ${alias.level1} 不在模型频道一级词表里`
      ).toBe(true)
    }
  })
})
