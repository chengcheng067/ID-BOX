/**
 * 知末分类显式映射表（`src/shared/zhimoTaxonomyMap.ts`）单测。
 *
 * 守三件事：
 * 1. **契约**：空值/未知名/null → `null` 且不抛；一对多 → 候选数组，绝不替用户选；
 * 2. **数据合法性**：表里每个落点都必须真实存在于 `taxonomy.ts` 的受控词表
 *    （防"手滑写了个不存在的二级"，也防未来词表改名后映射表悄悄失效）；
 * 3. **与人工裁定清单一致**：多候选的名字必须出现在 `ZHIMO_HUMAN_REVIEW`，
 *    未映射的名字必须真的查不到 —— 两边不许各自漂移。
 *
 * 【2026-10-26 增量】文件末尾追加两组：kind 分流（拍板 B）与一级-only（只写一级）。
 * 既有断言一行未改，只在末尾追加 `describe`。
 */

import { describe, expect, it } from 'vitest'
import {
  ZHIMO_CATEGORY_MAP,
  ZHIMO_HUMAN_REVIEW,
  ZHIMO_MAP_GROUPS,
  mapZhimoCategory,
  zhimoMapStats,
  type ZhimoCategoryTarget
} from '../src/shared/zhimoTaxonomyMap'
import { LEVEL2_MAP, MATERIAL_LEVEL2_MAP, UNCLASSIFIED } from '../src/shared/taxonomy'
import {
  ZHIMO_APPROX,
  ZHIMO_KIND_ROUTING,
  ZHIMO_LEVEL1_ONLY,
  isLevel1Only,
  type ZhimoApproxTarget,
  type ZhimoLookupTarget
} from '../src/shared/zhimoTaxonomyMap'
import type { AssetKind } from '../src/shared/types'

/** 取某个站方名的唯一落点（多条候选时直接失败，避免测试里偷偷取第一条） */
function soleTarget(baseName: string): ZhimoCategoryTarget {
  const hit = mapZhimoCategory(baseName)
  expect(hit, `「${baseName}」应命中映射表`).not.toBeNull()
  expect(hit!.length, `「${baseName}」应只有一个落点`).toBe(1)
  return hit![0]!
}

function pairsOf(baseName: string): string[] {
  const hit = mapZhimoCategory(baseName)
  if (hit === null) return []
  return hit.map((t) => `${t.category1}/${t.category2}`).sort()
}

describe('mapZhimoCategory · 空值与未知名（契约：绝不抛错、绝不猜）', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['空串', ''],
    ['纯空白', '   '],
    ['全角空格', '　　'],
    ['未登记的名字', '这个词表里绝对没有'],
    ['带修饰语的资产名', '现代壁灯'], // 站方只给分类名，不做包含匹配
    ['只差一个字', '金属网格栏'],
    ['站方占位符', '--']
  ])('%s → null', (_label, input) => {
    expect(mapZhimoCategory(input as string | null | undefined)).toBeNull()
  })

  it('非字符串入参不抛错（历史脏数据兜底）', () => {
    for (const bad of [42, {}, [], true, Symbol('x')] as unknown[]) {
      expect(() => mapZhimoCategory(bad as unknown as string)).not.toThrow()
      expect(mapZhimoCategory(bad as unknown as string)).toBeNull()
    }
  })

  it('首尾空白会被 trim，但不会做其它归一化', () => {
    expect(soleTarget('  壁灯  ').category2).toBe('壁灯')
    // 全角/别名不做等价：站方原文必须逐字命中
    expect(mapZhimoCategory('壁　灯')).toBeNull()
  })
})

describe('mapZhimoCategory · 一对多返回候选数组', () => {
  it('窗帘 → 布纹/窗帘 + 软装陈设/窗帘布艺（不替用户选）', () => {
    expect(pairsOf('窗帘')).toEqual(['布纹/窗帘', '软装陈设/窗帘布艺'])
  })

  it('贴图/材质同名二级全部返回两条候选', () => {
    for (const name of ['棉布', '麻布', '绒布', '路面', '地坪漆', '亚克力', '原木木纹']) {
      const hit = mapZhimoCategory(name)
      expect(hit, `${name} 应命中`).not.toBeNull()
      expect(hit!.length, `${name} 应有 2 个候选`).toBe(2)
      expect(new Set(hit!.map((t) => `${t.category1}/${t.category2}`)).size).toBe(2)
    }
  })

  it('跨一级的同名（绿植 / 小区景观）也是候选数组', () => {
    expect(pairsOf('绿植')).toEqual(['植物/盆栽', '植物/绿植'])
    expect(pairsOf('小区景观')).toEqual(['外景/小区景观', '景观/小区景观'])
  })

  it('返回的数组是冻结的（调用方不能改内部状态）', () => {
    const hit = mapZhimoCategory('窗帘')
    expect(Object.isFrozen(hit)).toBe(true)
    expect(() => {
      ;(hit as ZhimoCategoryTarget[]).push({ category1: 'X', category2: 'Y', source: 'test' })
    }).toThrow()
  })
})

describe('mapZhimoCategory · 真实条目抽查（≥10 条，覆盖四种来源）', () => {
  it.each([
    // docs/05 §5 六组【事实】
    ['壁灯', '灯具', '壁灯', 'docs/05'],
    ['吊灯', '灯具', '吊灯', 'docs/05'],
    ['落地灯', '灯具', '落地灯', 'docs/05'],
    ['茶几', '家具', '茶几', 'docs/05'],
    ['酒店民宿', '工装', '酒店/民宿', 'docs/05'],
    ['筒灯射灯', '灯具', '筒灯/射灯', 'docs/05'],
    // docs/17 §4 / §4.1 三级节点归并
    ['卡座沙发', '家具', '沙发', 'docs/17'],
    ['屏风', '硬装构件', '屏风隔断', 'docs/17'],
    ['花瓶花艺', '软装陈设', '摆件', 'docs/17'],
    ['绿植摆件', '软装陈设', '摆件', 'docs/17'],
    ['边几角几', '家具', '茶几', 'docs/17'],
    // docs/07 贴图二级
    ['莱姆石', '石材', '莱姆石', 'docs/07'],
    ['仿古砖', '砖材', '仿古砖', 'docs/07'],
    ['灰色瓷砖', '瓷砖', '灰色瓷砖', 'docs/07'],
    ['做旧金属', '金属', '做旧金属', 'docs/07'],
    ['黑白凹凸', '凹凸贴图', '黑白凹凸', 'docs/07'],
    ['塑木地板', '木地板', '塑木地板', 'docs/07'],
    ['黄花梨', '木纹', '黄花梨', 'docs/07'],
    // docs/18 材质二级
    ['其他石材', '石材', '其他石材', 'docs/18'],
    ['磨砂玻璃', '玻璃', '磨砂玻璃', 'docs/18'],
    ['满铺地毯', '地毯', '满铺地毯', 'docs/18'],
    // 站方实测（2026-10-26 真实 ID）
    ['茶柜', '家具', '柜子', '站方实测'],
    ['餐椅', '家具', '椅子/凳子', '站方实测'],
    ['办公椅', '家具', '椅子/凳子', '站方实测'],
    ['餐桌椅', '家具', '家具组合', '站方实测'],
    ['餐厅吊灯', '灯具', '吊灯', '站方实测'],
    ['墙面壁灯', '灯具', '壁灯', '站方实测'],
    ['庭院小品', '景观', '庭院景观', '站方实测'],
    ['乔木', '植物', '乔木', '站方实测'],
    ['镜子', '软装陈设', '摆件', '站方实测'],
    ['挂画', '软装陈设', '挂画', '站方实测'],
    ['海洋板', '木材', '板材', '站方实测'],
    ['水泥墙', '墙面地面屋面', '水泥', '站方实测']
  ])('「%s」→ %s / %s（来源：%s）', (name, category1, category2, sourceKeyword) => {
    const target = soleTarget(name)
    expect(target.category1).toBe(category1)
    expect(target.category2).toBe(category2)
    expect(target.source).toContain(sourceKeyword)
  })
})

describe('数据合法性 · 每个落点都必须在受控词表里', () => {
  it('组内 category1 必须已建键，且 category2 必须是该一级下的二级', () => {
    for (const group of ZHIMO_MAP_GROUPS) {
      const catalog =
        group.channel === 'material' ? MATERIAL_LEVEL2_MAP : (LEVEL2_MAP as Record<string, readonly string[]>)
      const level2 = catalog[group.category1]
      expect(level2, `组 category1「${group.category1}」不在 ${
        group.channel === 'material' ? 'MATERIAL_LEVEL2_MAP' : 'LEVEL2_MAP'
      } 里（${group.source}）`).toBeDefined()
      for (const term of group.terms ?? []) {
        expect(term, `${group.source} 有空词条`).toBe(term.trim())
        expect(term.length).toBeGreaterThan(0)
        expect(level2, `${group.category1}/${term}（${group.source}）的二级不存在`).toContain(term)
      }
      for (const pair of group.pairs ?? []) {
        expect(pair.station, `${group.source} 有空站方名`).toBe(pair.station.trim())
        expect(level2, `${group.category1}/${pair.category2}（${pair.source ?? group.source}）的二级不存在`).toContain(
          pair.category2
        )
      }
    }
  })

  it('映射表里不允许出现哨兵「未分类」', () => {
    for (const [name, list] of ZHIMO_CATEGORY_MAP) {
      for (const t of list) {
        expect(t.category2, `「${name}」把哨兵当二级写进了映射表`).not.toBe(UNCLASSIFIED)
      }
    }
  })

  it('每个候选都带 source，且键无首尾空白', () => {
    for (const [name, list] of ZHIMO_CATEGORY_MAP) {
      expect(name).toBe(name.trim())
      expect(list.length).toBeGreaterThan(0)
      for (const t of list) {
        expect(t.source.trim().length).toBeGreaterThan(0)
        if (t.stationPath) expect(t.stationPath.length).toBeGreaterThan(0)
      }
    }
  })

  it('同一个名字下不允许出现重复落点', () => {
    for (const [name, list] of ZHIMO_CATEGORY_MAP) {
      const keys = list.map((t) => `${t.category1}/${t.category2}`)
      expect(new Set(keys).size, `「${name}」有重复落点：${keys.join(',')}`).toBe(keys.length)
    }
  })

  it('映射表规模与人工裁定数量（改动表必须同步 docs/28 与本节数字）', () => {
    expect(zhimoMapStats()).toEqual({
      groups: 58,
      names: 385,
      targets: 395,
      multiCandidateNames: 10,
      groupsByChannel: { model: 15, texture: 23, material: 20 }
    })
  })
})

describe('与「需人工裁定」清单的一致性', () => {
  const ambiguous = ZHIMO_HUMAN_REVIEW.filter((e) => e.status === 'ambiguous')
  const unmapped = ZHIMO_HUMAN_REVIEW.filter((e) => e.status === 'unmapped')

  it('所有多候选的名字都在人工裁定清单里（且候选集合一致）', () => {
    const multiNames = [...ZHIMO_CATEGORY_MAP.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([name]) => name)
      .sort()
    expect(ambiguous.map((e) => e.station).sort()).toEqual(multiNames)
    for (const entry of ambiguous) {
      expect(entry.candidates.map((c) => `${c.category1}/${c.category2}`).sort()).toEqual(pairsOf(entry.station))
    }
  })

  it('未映射条目确实查不到（且候选只是建议，不在表里）', () => {
    expect(unmapped.length).toBeGreaterThan(0)
    for (const entry of unmapped) {
      expect(mapZhimoCategory(entry.station), `「${entry.station}」被误加进映射表`).toBeNull()
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.suggestion.length).toBeGreaterThan(0)
    }
  })

  it('人工裁定清单里没有重复项，也不与已映射的唯一落点冲突', () => {
    const names = ZHIMO_HUMAN_REVIEW.map((e) => e.station)
    expect(new Set(names).size).toBe(names.length)
    for (const entry of ZHIMO_HUMAN_REVIEW) {
      const hit = mapZhimoCategory(entry.station)
      if (entry.status === 'unmapped') expect(hit).toBeNull()
      else expect(hit!.length).toBeGreaterThan(1)
    }
  })
})

// ── 2026-10-26 增量：kind 分流（用户拍板 B） ────────────────────────────

/** 断言"唯一命中"并收窄成单对象（带 kind 时才会出现单对象） */
function soleLookup(
  hit: ZhimoLookupTarget | readonly ZhimoLookupTarget[] | null
): ZhimoLookupTarget {
  expect(hit, '期望唯一命中，实际 null').not.toBeNull()
  expect(Array.isArray(hit), '期望单对象，实际返回了数组').toBe(false)
  return hit as ZhimoLookupTarget
}

const ALL_KINDS: readonly AssetKind[] = ['model', 'texture', 'hdri', 'material', 'other']

describe('mapZhimoCategory(name, kind) · 按资产大类分流', () => {
  it('棉布：texture 取贴图册、material 取材质册（单对象 + 原 source）', () => {
    expect(mapZhimoCategory('棉布', 'texture')).toStrictEqual({
      category1: '布纹',
      category2: '棉布',
      source: 'docs/07 §3.14（L272）'
    })
    expect(mapZhimoCategory('棉布', 'material')).toStrictEqual({
      category1: '布料',
      category2: '棉布',
      source: 'docs/18 §3.5（L106）'
    })
  })

  it('绿植：model → 植物/盆栽，texture/material → 植物/绿植', () => {
    expect(mapZhimoCategory('绿植', 'model')).toMatchObject({
      category1: '植物',
      category2: '盆栽'
    })
    expect(mapZhimoCategory('绿植', 'texture')).toMatchObject({
      category1: '植物',
      category2: '绿植'
    })
    expect(mapZhimoCategory('绿植', 'material')).toMatchObject({
      category1: '植物',
      category2: '绿植'
    })
  })

  it('窗帘：model → 软装陈设/窗帘布艺，texture/material → 布纹/窗帘', () => {
    expect(mapZhimoCategory('窗帘', 'model')).toMatchObject({
      category1: '软装陈设',
      category2: '窗帘布艺'
    })
    expect(mapZhimoCategory('窗帘', 'texture')).toMatchObject({
      category1: '布纹',
      category2: '窗帘'
    })
    expect(mapZhimoCategory('窗帘', 'material')).toMatchObject({
      category1: '布纹',
      category2: '窗帘'
    })
  })

  it('kind 在候选里没有匹配 → 退回完整候选数组（绝不猜）', () => {
    const multi = mapZhimoCategory('棉布', 'model')
    expect(Array.isArray(multi)).toBe(true)
    expect(multi).toHaveLength(2)

    // 唯一落点的名字也一样：不匹配就退回数组（长度 1），不是 null、也不是猜成别的
    const single = mapZhimoCategory('壁灯', 'texture')
    expect(Array.isArray(single)).toBe(true)
    expect(single).toHaveLength(1)
  })

  it('kind 省略 → 与改造前完全等价（数组形态 / 顺序 / source 一字不差）', () => {
    expect(mapZhimoCategory('棉布')).toStrictEqual([
      { category1: '布纹', category2: '棉布', source: 'docs/07 §3.14（L272）' },
      { category1: '布料', category2: '棉布', source: 'docs/18 §3.5（L106）' }
    ])
  })

  it('ZHIMO_KIND_ROUTING 与查表结果逐条一致（表是给人看的，索引才是执行者）', () => {
    expect(ZHIMO_KIND_ROUTING).toHaveLength(10)
    for (const route of ZHIMO_KIND_ROUTING) {
      for (const kind of ALL_KINDS) {
        const expected = route.routes[kind]
        if (expected === undefined) {
          // 该 kind 未列 → 退回候选数组（这些名字全部是 2 候选）
          const hit = mapZhimoCategory(route.station, kind)
          expect(Array.isArray(hit), `${route.station}/${kind} 应退回数组`).toBe(true)
          expect(hit).toHaveLength(2)
        } else {
          expect(mapZhimoCategory(route.station, kind), `${route.station}/${kind}`).toMatchObject(
            expected
          )
        }
      }
    }
  })

  it('10 条多候选全部标记为「已按 kind 裁定」，与路由表一一对应', () => {
    const ambiguous = ZHIMO_HUMAN_REVIEW.filter((e) => e.status === 'ambiguous')
    expect(ambiguous).toHaveLength(10)
    expect(ambiguous.every((e) => e.resolvedByKind === true)).toBe(true)
    expect(ZHIMO_KIND_ROUTING.map((r) => r.station).sort()).toEqual(
      ambiguous.map((e) => e.station).sort()
    )
  })
})

// ── 2026-10-26 增量：一级-only（用户拍板：只写一级，二级留未分类）─────

describe('一级-only · 站方只给一级时的返回形态', () => {
  it('木纹 → level:1 + 未分类（无 kind 时仍是数组，保持老契约）', () => {
    const hit = mapZhimoCategory('木纹')
    expect(Array.isArray(hit)).toBe(true)
    const list = hit as readonly ZhimoLookupTarget[]
    expect(list).toHaveLength(1)
    const target = list[0]!
    expect(isLevel1Only(target)).toBe(true)
    if (!isLevel1Only(target)) throw new Error('unreachable')
    expect(target.level).toBe(1)
    expect(target.category1).toBe('木纹')
    expect(target.category2).toBe(UNCLASSIFIED)
    expect(target.source.length).toBeGreaterThan(0)
  })

  it('一级-only 与 kind 无关：木纹在 5 个 kind 下都返回单对象', () => {
    for (const kind of ALL_KINDS) {
      const target = soleLookup(mapZhimoCategory('木纹', kind))
      expect(isLevel1Only(target), `木纹/${kind} 应是 level:1`).toBe(true)
      if (!isLevel1Only(target)) throw new Error('unreachable')
      expect(target.category2, `木纹/${kind} 的二级应为哨兵`).toBe(UNCLASSIFIED)
    }
  })

  it('「一级-only」与「本地没这个类目」必须可区分（防以后把 null 一律改写成一级）', () => {
    // 正例：站方给的名字本身就是一级名
    expect(mapZhimoCategory('木纹', 'texture')).toMatchObject({
      level: 1,
      category1: '木纹',
      category2: UNCLASSIFIED
    })

    // 反例一：玻璃/金属 是站方一级名，但本地**同时是 SU材质 的二级** → 二义，必须 null
    for (const name of ['玻璃', '金属']) {
      expect(mapZhimoCategory(name), `${name} 有二义，不该命中`).toBeNull()
      expect(mapZhimoCategory(name, 'texture')).toBeNull()
    }

    // 反例二：父级太宽 / 品牌 → 不映射，必须 null（且将来也不许被凑成一级-only）
    for (const name of ['布艺软饰', '墙饰墙绘', '厨房用品', 'Minotti', 'Poliform']) {
      expect(mapZhimoCategory(name), `${name} 不该命中任何落点`).toBeNull()
      for (const kind of ALL_KINDS) {
        expect(mapZhimoCategory(name, kind), `${name}/${kind} 不该命中`).toBeNull()
      }
    }
  })

  it('ZHIMO_LEVEL1_ONLY 的落点合法：category1 是本地一级，且该名字不是任何二级', () => {
    expect(ZHIMO_LEVEL1_ONLY).toHaveLength(1)
    for (const entry of ZHIMO_LEVEL1_ONLY) {
      const isTextureLevel1 = Object.prototype.hasOwnProperty.call(LEVEL2_MAP, entry.category1)
      const isMaterialLevel1 = Object.prototype.hasOwnProperty.call(
        MATERIAL_LEVEL2_MAP,
        entry.category1
      )
      expect(isTextureLevel1 || isMaterialLevel1, `${entry.station} 的本地一级不存在`).toBe(true)
      const allLevel2 = [
        ...Object.values(LEVEL2_MAP).flat(),
        ...Object.values(MATERIAL_LEVEL2_MAP).flat()
      ]
      expect(allLevel2, `「${entry.station}」在本地是二级，按一级处理会二义`).not.toContain(
        entry.station
      )
      expect(entry.source.length).toBeGreaterThan(0)
    }
  })
})

// ── 2026-10-26 增量：就近归并（用户拍板第 3 个问题，必须带 approx 标记）──

/** 断言返回单对象且是近似落点 */
function approxTarget(hit: ZhimoLookupTarget | readonly ZhimoLookupTarget[] | null): ZhimoApproxTarget {
  expect(hit, '预期命中近似落点，实际 null').not.toBeNull()
  expect(Array.isArray(hit), '预期单对象（带 kind 且唯一），实际是数组').toBe(false)
  const target = hit as ZhimoLookupTarget
  expect('approx' in target && target.approx === true, '缺少 approx:true 标记').toBe(true)
  return target as ZhimoApproxTarget
}

describe('就近归并 · approx:true 与可回溯字段', () => {
  it.each([
    ['茶具', '软装陈设', '摆件', 2, 'model'],
    ['食物饮料', '软装陈设', '摆件', 2, 'model'],
    ['金属网格', '金属', '金属网', 2, 'texture'],
    ['植物组合', '植物', '盆栽', 2, 'model'],
    ['夹胶玻璃', '玻璃', UNCLASSIFIED, 1, 'texture'],
    ['红砖', '砖材', UNCLASSIFIED, 1, 'texture']
  ] as const)('%s → %s/%s（level=%i，kind=%s）', (station, category1, category2, level, kind) => {
    const hit = mapZhimoCategory(station)
    expect(Array.isArray(hit)).toBe(true)
    const list = hit as readonly ZhimoLookupTarget[]
    expect(list).toHaveLength(1)
    const target = approxTarget(mapZhimoCategory(station, kind))
    expect(target.category1).toBe(category1)
    expect(target.category2).toBe(category2)
    expect(target.level).toBe(level === 1 ? 1 : undefined)
    if (level === 1) expect(target.category2).toBe(UNCLASSIFIED)
    // 三个可回溯字段必须带到返回值上
    expect(target.stationName).toBe(station)
    expect(target.approxReason.length).toBeGreaterThan(4)
    expect(target.source.length).toBeGreaterThan(0)
    // 无 kind 时只有一条候选，且与带 kind 的结果一致
    expect(list[0]).toMatchObject({ category1, category2, approx: true, stationName: station })
  })

  it('kind 不在该近似的适用范围内 → null（不把模型的近似套到贴图上）', () => {
    for (const name of ['茶具', '食物饮料', '植物组合']) {
      expect(mapZhimoCategory(name, 'texture')).toBeNull()
      expect(mapZhimoCategory(name, 'material')).toBeNull()
    }
    for (const name of ['金属网格', '夹胶玻璃', '红砖']) {
      expect(mapZhimoCategory(name, 'model')).toBeNull()
      expect(mapZhimoCategory(name, 'material')).toBeNull()
    }
  })

  it('ZHIMO_APPROX 每条都写全 stationName / approxReason / source（防漏写理由）', () => {
    expect(ZHIMO_APPROX).toHaveLength(6)
    const level1Keys = new Set([
      ...Object.keys(LEVEL2_MAP),
      ...Object.keys(MATERIAL_LEVEL2_MAP)
    ])
    for (const entry of ZHIMO_APPROX) {
      expect(entry.stationName.trim(), 'stationName 不能为空/带空白').toBe(entry.stationName)
      expect(entry.stationName.length).toBeGreaterThan(0)
      expect(entry.approxReason.length, `${entry.stationName} 缺 approxReason`).toBeGreaterThan(4)
      expect(entry.source.length, `${entry.stationName} 缺 source`).toBeGreaterThan(0)
      expect(entry.kinds.length, `${entry.stationName} 缺 kinds`).toBeGreaterThan(0)
      // 落点的一级必须真实存在（防写错类目名）
      expect(level1Keys.has(entry.category1), `${entry.stationName} 的 category1 不是本地一级`).toBe(true)
      if (entry.level === 1) {
        expect(entry.category2).toBe(UNCLASSIFIED)
      } else {
        expect(LEVEL2_MAP[entry.category1], `${entry.category1}/${entry.category2} 二级不存在`).toContain(
          entry.category2
        )
      }
    }
  })

  it('近似落点是冻结对象（调用方改不动内部状态）', () => {
    const target = approxTarget(mapZhimoCategory('茶具', 'model'))
    expect(Object.isFrozen(target)).toBe(true)
  })

  it('人工裁定清单已收敛：剩下的 unmapped 只有父级不映射 + 品牌', () => {
    const unmapped = ZHIMO_HUMAN_REVIEW.filter((e) => e.status === 'unmapped').map((e) => e.station)
    expect(unmapped.sort()).toEqual(
      ['布艺软饰', '墙饰墙绘', '厨房用品', 'Minotti', 'Poliform'].sort()
    )
    for (const name of unmapped) expect(mapZhimoCategory(name)).toBeNull()
  })
})
