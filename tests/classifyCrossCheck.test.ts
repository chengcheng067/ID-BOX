/**
 * `decideClassify` 的单元测试（docs/35 · T-03）。
 *
 * 结构：
 * 1. 规则 1~10 逐条用例（每条规则至少一条，含最容易写错的三条边界）；
 * 2. `candidates` / `sources` 的形状纪律；
 * 3. 源码守卫（纯函数：零 electron / 零 indexedDB / 零 window）；
 * 4. 真样本回归（1091 条 CAD 真值当 S2 的 oracle）—— **只打表 + 宽松守卫，不做精确断言**。
 *
 * 为什么真样本那条不写精确数字：它的 S2 是"站方完全准确"的理想值，词表升级会让
 * 数字漂。它守的是"桶边界不许漂"，不是"线上准确率"（docs/35 §9.2）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyAssetName } from '../src/shared/classifyAsset'
import {
  decideClassify,
  UNCLASSIFIED_CAT,
  type ClassifyDecision
} from '../src/shared/classifyCrossCheck'

const U = UNCLASSIFIED_CAT

const s1 = (category1: string, category2: string) => ({ category1, category2 })
const s2 = (level1: string, level2: string) => ({ level1, level2, raw: [level1, level2] })

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

// ── 规则 1 · 两边都空 ────────────────────────────────────────────────

describe('规则 1 · 两边都空 → none / none', () => {
  it('S1 双未分类 + S2 为 null → none', () => {
    const d = decideClassify({ s1: s1(U, U), s2: null })
    expect(d.confidence).toBe('none')
    expect(d.used).toBe('none')
    expect(d.category1).toBe(U)
    expect(d.category2).toBe(U)
    expect(d.candidates).toBeUndefined()
  })

  it('S1 未传 + S2 为 null → none', () => {
    const d = decideClassify({})
    expect(d.confidence).toBe('none')
    expect(d.used).toBe('none')
    expect(d.category1).toBe(U)
  })

  it('S1 双未分类 + S2 的 level1 是未分类 → 等价于"站方没给" → none', () => {
    const d = decideClassify({ s1: s1(U, U), s2: s2(U, U) })
    expect(d.confidence).toBe('none')
    expect(d.used).toBe('none')
  })
})

// ── 规则 2 · 只有 S1 ─────────────────────────────────────────────────

describe('规则 2 · 只有 S1 → medium-s1 / s1', () => {
  it('S1 有值 + S2 为 null', () => {
    const d = decideClassify({ s1: s1('工装空间', '办公空间'), s2: null })
    expect(d.confidence).toBe('medium-s1')
    expect(d.used).toBe('s1')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
    expect(d.candidates).toBeUndefined()
  })

  it('S2 存在但 level1 是未分类 → 仍按"只有 S1"处理（不是 conflict）', () => {
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2(U, U)
    })
    expect(d.confidence).toBe('medium-s1')
    expect(d.used).toBe('s1')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
  })
})

// ── 规则 3 · 只有 S2（含"只到一级"这条必测边界） ──────────────────────

describe('规则 3 · 只有 S2 → medium-s2 / s2', () => {
  it('S1 双未分类 + S2 两级都有 → medium-s2', () => {
    const d = decideClassify({ s1: s1(U, U), s2: s2('工装空间', '办公空间') })
    expect(d.confidence).toBe('medium-s2')
    expect(d.used).toBe('s2')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
    expect(d.candidates).toBeUndefined()
  })

  it('★ S2 只到一级（level2=未分类）→ 仍是 medium-s2，不降级成 none', () => {
    const d = decideClassify({
      s2: { level1: '工装空间', level2: U, raw: ['工装空间'] }
    })
    expect(d.confidence).toBe('medium-s2')
    expect(d.used).toBe('s2')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe(U)
  })

  it('S1 未传（undefined）+ S2 只到一级 → medium-s2', () => {
    const d = decideClassify({ s2: { level1: '建筑设计', level2: U, raw: ['建筑设计'] } })
    expect(d.confidence).toBe('medium-s2')
    expect(d.category1).toBe('建筑设计')
    expect(d.category2).toBe(U)
  })
})

// ── 规则 4 · 完全一致 ────────────────────────────────────────────────

describe('规则 4 · 一级相同、二级相同 → high / both', () => {
  it('两级完全一致', () => {
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2('工装空间', '办公空间')
    })
    expect(d.confidence).toBe('high')
    expect(d.used).toBe('both')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
    expect(d.candidates).toBeUndefined()
  })

  it('两边二级都是未分类 → high / both（一级互证已经足够）', () => {
    const d = decideClassify({
      s1: s1('建筑设计', U),
      s2: s2('建筑设计', U)
    })
    expect(d.confidence).toBe('high')
    expect(d.used).toBe('both')
    expect(d.category2).toBe(U)
  })
})

// ── 规则 5 / 6 · R-06 两个方向 ───────────────────────────────────────

describe('规则 5 · R-06 正向：一级同、S1 有二级、S2 只到一级 → high / 用 S1 的二级', () => {
  it('s1={工装空间,办公空间} + s2={工装空间,未分类}', () => {
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2('工装空间', U)
    })
    expect(d.confidence).toBe('high')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
    // used 语义：定案的二级来自 S1（S2 只提供了"一级通过"的校验）
    expect(d.used).toBe('s1')
    expect(d.candidates).toBeUndefined()
  })
})

describe('规则 6 · R-06 反向：一级同、S1 只到一级、S2 有二级 → high / 用 S2 的二级', () => {
  it('s1={工装空间,未分类} + s2={工装空间,办公空间}', () => {
    const d = decideClassify({
      s1: s1('工装空间', U),
      s2: s2('工装空间', '办公空间')
    })
    expect(d.confidence).toBe('high')
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
    expect(d.used).toBe('s2')
    expect(d.candidates).toBeUndefined()
  })
})

// ── 规则 7 · 一级同、二级不同 → conflict ─────────────────────────────

describe('规则 7 · 一级同、二级都不同 → conflict', () => {
  it('s1={工装空间,办公空间} + s2={工装空间,餐饮空间}', () => {
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2('工装空间', '餐饮空间')
    })
    expect(d.confidence).toBe('conflict')
    expect(d.candidates?.length).toBe(2)
    expect(d.candidates?.[0].from).toBe('s1')
    expect(d.candidates?.[1].from).toBe('s2')
    expect(d.candidates?.[0].category2).toBe('办公空间')
    expect(d.candidates?.[1].category2).toBe('餐饮空间')
  })
})

// ── 规则 8 · 一级不同 → conflict（最容易被 R-06 吞掉的一条） ───────────

describe('规则 8 · 一级不同 → conflict（S2 二级为空也不能被 R-06 吞掉）', () => {
  it('★ s1={建筑设计,规划设计} + s2={工装空间,未分类} → conflict', () => {
    const d = decideClassify({
      s1: s1('建筑设计', '规划设计'),
      s2: s2('工装空间', U)
    })
    expect(d.confidence).toBe('conflict')
    expect(d.used).toBe('none')
    expect(d.category1).toBe('建筑设计')
    expect(d.category2).toBe('规划设计')
    expect(d.candidates?.length).toBe(2)
    expect(d.candidates?.[0]).toEqual({
      category1: '建筑设计',
      category2: '规划设计',
      from: 's1'
    })
    expect(d.candidates?.[1]).toEqual({
      category1: '工装空间',
      category2: U,
      from: 's2'
    })
  })

  it('一级不同（两边都只有一级）→ conflict', () => {
    const d = decideClassify({
      s1: s1('园林景观', U),
      s2: s2('结构设计', U)
    })
    expect(d.confidence).toBe('conflict')
    expect(d.used).toBe('none')
    expect(d.candidates?.length).toBe(2)
  })

  it('报告口径样本：节点详图/电气工程节点 vs 机电工程/电气工程节点 → conflict', () => {
    const d = decideClassify({
      s1: s1('节点详图', '电气工程节点'),
      s2: s2('机电工程', '电气工程节点')
    })
    expect(d.confidence).toBe('conflict')
    expect(d.category1).toBe('节点详图')
    expect(d.candidates?.map((c) => `${c.category1}/${c.category2}`)).toEqual([
      '节点详图/电气工程节点',
      '机电工程/电气工程节点'
    ])
  })
})

// ── 规则 9 · conflict 绝不自动定案 ───────────────────────────────────

describe('规则 9 · conflict 绝不自动定案', () => {
  it('conflict 时 used 恒为 none，即使 category1/category2 保留了 S1 的值', () => {
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2('工装空间', '餐饮空间')
    })
    expect(d.used).toBe('none')
    // 落点仍是 S1（"当前不动时的建议值"），但 used 明确表示未定案
    expect(d.category1).toBe('工装空间')
    expect(d.category2).toBe('办公空间')
  })

  it('不存在任何"隐式消歧"：不选更长的一级、不选站方的、不选 S1 的', () => {
    // 构造三种"看起来该消歧"的形态，全部必须是 conflict
    const cases = [
      { a: s1('CAD图库', '工装图库'), b: s2('建筑设计', '居住区规划') }, // 站方一级更长
      { a: s1('建筑设计', '规划设计'), b: s2('工装空间', U) }, // 站方只到一级
      { a: s1('平立面系统图', U), b: s2('园林景观', '庭院景观') } // S1 落在图种册
    ]
    for (const c of cases) {
      const d = decideClassify({ s1: c.a, s2: c.b })
      expect(d.confidence).toBe('conflict')
      expect(d.used).toBe('none')
    }
  })
})

// ── 规则 10 · S3 只做旁证 ────────────────────────────────────────────

describe('规则 10 · S3 只做旁证，永不影响判定', () => {
  type Input = Parameters<typeof decideClassify>[0]
  const base: Array<{ name: string; input: Input }> = [
    { name: 'none', input: { s1: s1(U, U), s2: null } },
    { name: 'medium-s1', input: { s1: s1('工装空间', '办公空间'), s2: null } },
    { name: 'medium-s2', input: { s2: s2('工装空间', U) } },
    {
      name: 'high',
      input: { s1: s1('工装空间', '办公空间'), s2: s2('工装空间', '办公空间') }
    },
    {
      name: 'conflict',
      input: { s1: s1('工装空间', '办公空间'), s2: s2('工装空间', '餐饮空间') }
    }
  ]

  it('同样的输入，s3 传值 / 传 null / 不传，判定四要素完全相同', () => {
    const key = (d: ClassifyDecision) =>
      [d.confidence, d.used, d.category1, d.category2].join('|')

    for (const c of base) {
      const withS3 = decideClassify({ ...c.input, s3: '工装平面图' })
      const nullS3 = decideClassify({ ...c.input, s3: null })
      const noS3 = decideClassify({ ...c.input })
      expect(key(withS3), `case=${c.name}`).toBe(key(nullS3))
      expect(key(withS3), `case=${c.name}`).toBe(key(noS3))
      expect(withS3.sources.s3, `case=${c.name}`).toBe('工装平面图')
      expect(nullS3.sources.s3, `case=${c.name}`).toBeNull()
      expect('s3' in noS3.sources, `case=${c.name}`).toBe(false)
    }
  })

  it('S3 与 S2 不一致时不产生 conflict（docs/34 §七-7 的 1206625741 情形）', () => {
    // 面包屑末级=办公室，classifyBaseName=开放办公室
    const d = decideClassify({
      s1: s1('工装空间', '办公空间'),
      s2: s2('工装空间', '办公空间'),
      s3: '开放办公室'
    })
    expect(d.confidence).toBe('high')
    expect(d.candidates).toBeUndefined()
    expect(d.sources.s3).toBe('开放办公室')
  })
})

// ── sources 透传 / 空判据 ────────────────────────────────────────────

describe('sources 与哨兵纪律', () => {
  it('sources 原样透传 S1 的 matchedTerm / matchedLevel 与 S2 的 raw / viaAlias', () => {
    const d = decideClassify({
      s1: { category1: '工装空间', category2: '办公空间', matchedTerm: '办公室', matchedLevel: 'cad-l2' },
      s2: { level1: '工装空间', level2: '办公空间', raw: ['室内空间', '办公空间', '办公室'], viaAlias: '室内空间' }
    })
    expect(d.sources.s1?.matchedTerm).toBe('办公室')
    expect(d.sources.s1?.matchedLevel).toBe('cad-l2')
    expect(d.sources.s2?.raw).toEqual(['室内空间', '办公空间', '办公室'])
    expect(d.sources.s2?.viaAlias).toBe('室内空间')
  })

  it('UNCLASSIFIED_CAT 就是 taxonomy 的 未分类（不写死字符串）', () => {
    expect(UNCLASSIFIED_CAT).toBe('未分类')
  })

  it('"空"的判据是一级 === 未分类，不是空串', () => {
    // 空串一级视为"有值"（词表里不会出现，但判据不能靠空串兜底）
    const d = decideClassify({ s1: s1('', ''), s2: null })
    expect(d.confidence).toBe('medium-s1')
    expect(d.category1).toBe('')
  })
})

// ── 源码守卫 ─────────────────────────────────────────────────────────

describe('源码守卫 · classifyCrossCheck 是纯函数', () => {
  const src = readSrc('../src/shared/classifyCrossCheck.ts')

  it('零 electron / 零 indexedDB / 零 window.', () => {
    expect(src).not.toContain("from 'electron'")
    expect(src).not.toContain('from "electron"')
    expect(src).not.toContain('indexedDB')
    expect(src).not.toContain('window.')
  })

  it('零 IO：不 import node:fs / node:path / Dexie', () => {
    expect(src).not.toContain("from 'node:fs'")
    expect(src).not.toContain("from 'node:path'")
    // 只查 import 语句：文件头注释里写了"零 Dexie"这句承诺本身
    expect(src).not.toContain("from 'dexie'")
    expect(src).toMatch(/^import .*from '\.\/taxonomy'$/m)
  })

  it('不 import 任何映射表 / 编排模块（S2 由调用方映射好再传进来）', () => {
    expect(src).not.toContain('zhimoTaxonomyMap')
    expect(src).not.toContain('classifyCadStationAlias')
    expect(src).not.toContain('renderer/')
    expect(src).not.toContain('importer')
  })
})

// ── 真样本回归（1091 条 CAD 真值当 S2 的 oracle） ─────────────────────

interface LabeledRow {
  title: string
  level1: string
  level2: string
  own3: string | null
}

describe('真样本回归 · 1091 条 CAD 真值当 S2 oracle', () => {
  const fixtureUrl = new URL('./fixtures/cad-taxonomy/labeled-titles.json', import.meta.url)
  const hasFixture = fs.existsSync(fixtureUrl)

  it.skipIf(!hasFixture)('四个桶的分布打表 + 宽松守卫', () => {
    const raw = JSON.parse(fs.readFileSync(fixtureUrl, 'utf-8')) as { rows: LabeledRow[] }
    const rows = raw.rows
    const buckets: Record<string, number> = {
      high: 0,
      'medium-s1': 0,
      'medium-s2': 0,
      conflict: 0,
      none: 0
    }
    const usedBuckets: Record<string, number> = { s1: 0, s2: 0, both: 0, none: 0 }

    for (const r of rows) {
      const s1Out = classifyAssetName(r.title, undefined, 'cad')
      const d = decideClassify({
        s1: { category1: s1Out.category1, category2: s1Out.category2 },
        s2: { level1: r.level1, level2: r.level2, raw: [r.level1, r.level2] },
        s3: r.own3
      })
      buckets[d.confidence] += 1
      usedBuckets[d.used] += 1
    }

    const total = rows.length
    const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`
    console.log(
      [
        `[classifyCrossCheck] 真样本 ${total} 条（S2 = 真值 oracle，上界估计）`,
        `  high       ${buckets.high}\t${pct(buckets.high)}`,
        `  medium-s1  ${buckets['medium-s1']}\t${pct(buckets['medium-s1'])}`,
        `  medium-s2  ${buckets['medium-s2']}\t${pct(buckets['medium-s2'])}`,
        `  conflict   ${buckets.conflict}\t${pct(buckets.conflict)}`,
        `  none       ${buckets.none}\t${pct(buckets.none)}`,
        `  used: s1=${usedBuckets.s1} s2=${usedBuckets.s2} both=${usedBuckets.both} none=${usedBuckets.none}`
      ].join('\n')
    )

    // 宽松守卫（只守"桶边界不漂"，不锁具体数字 —— 词表还会变）
    const conflictRatio = buckets.conflict / total
    expect(conflictRatio).toBeGreaterThanOrEqual(0.1)
    expect(conflictRatio).toBeLessThanOrEqual(0.2)

    // 真值 oracle 下 S2 恒有值 → 不可能出现 medium-s1 / none
    expect(buckets['medium-s1']).toBe(0)
    expect(buckets.none).toBe(0)

    // R-06 必须有命中（正反两个方向合计），否则说明分支被写死成 conflict
    expect(usedBuckets.s1 + usedBuckets.s2).toBeGreaterThan(0)

    // high 必须明显多于 conflict（否则"交叉验证"没有收益）
    expect(buckets.high).toBeGreaterThan(buckets.conflict)
  })
})
