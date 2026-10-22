/**
 * 别名纯函数单测（docs/20 §5 · T-D1）。
 *
 * 覆盖：归一化（大小写/空格/下划线/连字符/括号/`ID_<数字>`/分辨率/扩展名）、
 * 四级优先级、空别名回落、索引空态、搜索双向命中、中文自然序排序。
 *
 * ⚠️ 样例唯一来源 `tests/fixtures/idSuffixSamples.ts`，改样例必须两处同时绿
 * （另一处：`tests/autoClassify.test.ts` 的镜像断言）。
 */
import { describe, expect, it } from 'vitest'
import {
  aliasKeyOf,
  buildAliasIndex,
  compareByDisplayName,
  matchesQuery,
  resolveDisplayName,
  type AliasRecord
} from '../src/shared/aliasRules'
import { ALREADY_CLEAN, MUST_KEEP, MUST_STRIP } from './fixtures/idSuffixSamples'

function rec(o: {
  id?: string
  scope?: 'key' | 'asset'
  key: string
  name: string
  createdAt?: number
}): AliasRecord {
  return {
    id: o.id ?? 'r1',
    scope: o.scope ?? 'key',
    key: o.key,
    name: o.name,
    createdAt: o.createdAt ?? 1
  }
}

describe('aliasKeyOf — 归一化', () => {
  it('大小写 / 空格 / 下划线 / 连字符一律抹平', () => {
    expect(aliasKeyOf('Polished_Concrete-Wall')).toBe('polishedconcretewall')
    expect(aliasKeyOf('polished concrete wall')).toBe('polishedconcretewall')
    expect(aliasKeyOf('POLISHED_CONCRETE_WALL')).toBe('polishedconcretewall')
  })

  it('括号只抹字符本身，不抹内容（不同内容必须是不同 key）', () => {
    expect(aliasKeyOf('Concrete (Polished)')).toBe('concretepolished')
    expect(aliasKeyOf('Concrete (Rough)')).toBe('concreterough')
    expect(aliasKeyOf('石材【亮面】[A]')).toBe('石材亮面a')
    // 中文全角括号也要抹
    expect(aliasKeyOf('石材（亮面）')).toBe('石材亮面')
  })

  it('下载站重复下载的数字括号尾巴整段丢弃：石材(1) → 石材', () => {
    expect(aliasKeyOf('石材(1)')).toBe('石材')
    expect(aliasKeyOf('石材 (12)')).toBe('石材')
    // ⚠️ 只丢"纯数字括号"，带文字的不丢（否则不同材质会被并成一个 key）
    expect(aliasKeyOf('石材(亮面)')).toBe('石材亮面')
  })

  it('知末尾巴 ID_<数字>：CJK 紧贴写法（样例取自共享 fixture）', () => {
    expect(aliasKeyOf(MUST_STRIP[0]!)).toBe('无堺黑色木纹')
    // 真实样本：下划线后面的「挂画组合」必须留住，只切 ID 段
    expect(aliasKeyOf(MUST_STRIP[2]!)).toBe('传薇佳画挂画组合')
  })

  it('知末尾巴 ID_<数字>：分隔符写法（大小写不敏感）', () => {
    expect(aliasKeyOf(MUST_STRIP[1]!)).toBe('brickrough')
    expect(aliasKeyOf('stone wall id 42')).toBe('stonewall')
    expect(aliasKeyOf('marble-id-7')).toBe('marble')
  })

  it('防误伤：英文单词里的 id 结尾不剥（MUST_KEEP 全组原样保留）', () => {
    // 与 autoClassify 的规则 B-2（stripCjkTrailingId）触发条件同源：
    // 必须"ID 前是 CJK"或"ID 前有分隔符"，否则 grid123 会变成 gr。
    // 共享样例见 tests/fixtures/idSuffixSamples.ts（另一处镜像断言在 autoClassify.test.ts）
    expect(MUST_KEEP).toEqual(['grid123', 'rapid42', 'invalid7', 'Material.v2'])
    for (const s of MUST_KEEP) {
      expect(aliasKeyOf(s)).toBe(s.toLowerCase())
    }
  })

  it('本来就是干净的中文名：ALREADY_CLEAN 原样返回（不产生任何剥离副作用）', () => {
    for (const s of ALREADY_CLEAN) {
      expect(aliasKeyOf(s)).toBe(s)
    }
  })

  it('分辨率尾巴 4K/2K/8K/1K 归一：Marble_4K 与 Marble 同一 key', () => {
    expect(aliasKeyOf('Marble_4K')).toBe('marble')
    expect(aliasKeyOf('Marble')).toBe('marble')
    expect(aliasKeyOf('石材 2K')).toBe('石材')
    expect(aliasKeyOf('石材8k')).toBe('石材')
  })

  it('扩展名白名单剥离：石材.skp 与 石材 同一 key', () => {
    expect(aliasKeyOf('石材.skp')).toBe('石材')
    expect(aliasKeyOf('Marble.JPG')).toBe('marble')
    // 非扩展名的点号不动（Material.v2 ≠ Material）
    expect(aliasKeyOf('Material.v2')).toBe('material.v2')
  })

  it('幂等：aliasKeyOf(aliasKeyOf(x)) === aliasKeyOf(x)', () => {
    const samples = [...MUST_STRIP, ...MUST_KEEP, ...ALREADY_CLEAN, 'Polished_Concrete-4K', '石材(1).skp']
    for (const s of samples) {
      const once = aliasKeyOf(s)
      expect(aliasKeyOf(once)).toBe(once)
    }
  })

  it('空输入 / 纯空白 / 非字符串 → 空串，不抛', () => {
    expect(aliasKeyOf('')).toBe('')
    expect(aliasKeyOf('   ')).toBe('')
    expect(aliasKeyOf(undefined as unknown as string)).toBe('')
  })
})

describe('buildAliasIndex — 索引构建', () => {
  it('空记录数组 → 空索引，resolveDisplayName 回原名、不崩', () => {
    const index = buildAliasIndex([])
    expect(index.byKey.size).toBe(0)
    expect(index.byAssetId.size).toBe(0)
    expect(resolveDisplayName({ id: 'a1', name: 'Polished_Concrete' }, index)).toBe(
      'Polished_Concrete'
    )
  })

  it('空 name 的记录被丢弃（不许把标题变成空白）', () => {
    const index = buildAliasIndex([
      rec({ key: 'polishedconcrete', name: '抛光混凝土' }),
      rec({ key: 'polishedconcrete', name: '   ', createdAt: 99 })
    ])
    expect(index.byKey.get('polishedconcrete')).toBe('抛光混凝土')
  })

  it('同 key 多条：createdAt 最大的胜出（与数组顺序无关）', () => {
    const newer = buildAliasIndex([
      rec({ id: 'old', key: 'marble', name: '旧名', createdAt: 100 }),
      rec({ id: 'new', key: 'marble', name: '新名', createdAt: 200 })
    ])
    expect(newer.byKey.get('marble')).toBe('新名')
    const reversed = buildAliasIndex([
      rec({ id: 'new', key: 'marble', name: '新名', createdAt: 200 }),
      rec({ id: 'old', key: 'marble', name: '旧名', createdAt: 100 })
    ])
    expect(reversed.byKey.get('marble')).toBe('新名')
  })

  it('词典 key 存的是未归一化字符串也能命中（构建时再做一次归一化）', () => {
    const index = buildAliasIndex([rec({ key: 'Polished_Concrete', name: '抛光混凝土' })])
    expect(index.byKey.get('polishedconcrete')).toBe('抛光混凝土')
  })
})

describe('resolveDisplayName — 四级优先级', () => {
  const index = buildAliasIndex([
    rec({ id: 'key-1', scope: 'key', key: 'polishedconcrete', name: '抛光混凝土' }),
    rec({ id: 'asset-1', scope: 'asset', key: 'a1', name: '一号单资产名' })
  ])

  it('① aliasOverride 最优先（压过词典与单资产记录）', () => {
    expect(
      resolveDisplayName(
        { id: 'a1', name: 'Polished_Concrete', aliasOverride: '我的抛光面' },
        index
      )
    ).toBe('我的抛光面')
  })

  it('② 其次 scope=asset 的记录', () => {
    expect(resolveDisplayName({ id: 'a1', name: 'Polished_Concrete' }, index)).toBe(
      '一号单资产名'
    )
  })

  it('③ 再次 scope=key 的词典记录（一改影响 N 个同名资产）', () => {
    expect(resolveDisplayName({ id: 'a2', name: 'Polished_Concrete' }, index)).toBe(
      '抛光混凝土'
    )
    // 同名但未登记 id 的资产也吃同一条词典
    expect(resolveDisplayName({ id: 'a3', name: 'polished concrete 4K' }, index)).toBe(
      '抛光混凝土'
    )
  })

  it('④ 都没有 → 原名兜底', () => {
    expect(resolveDisplayName({ id: 'a9', name: 'Brick_Rough' }, index)).toBe('Brick_Rough')
  })

  it('空别名（空串 / 全空白）不生效，逐级回落而不是显示空白', () => {
    expect(
      resolveDisplayName({ id: 'a2', name: 'Polished_Concrete', aliasOverride: '' }, index)
    ).toBe('抛光混凝土')
    expect(
      resolveDisplayName({ id: 'a2', name: 'Polished_Concrete', aliasOverride: '   ' }, index)
    ).toBe('抛光混凝土')
    expect(resolveDisplayName({ id: 'a1', name: 'Polished_Concrete', aliasOverride: '  ' }, index)).toBe(
      '一号单资产名'
    )
  })
})

describe('matchesQuery — 原名与显示名双向命中', () => {
  const index = buildAliasIndex([
    rec({ scope: 'key', key: 'polishedconcrete', name: '抛光混凝土' })
  ])
  const asset = { id: 'a1', name: 'Polished_Concrete_4K' }

  it('命中显示名（中文搜索）', () => {
    expect(matchesQuery(asset, '抛光', index)).toBe(true)
    expect(matchesQuery(asset, '混凝土', index)).toBe(true)
  })

  it('命中原名（英文搜索，含空格/大小写归一）', () => {
    expect(matchesQuery(asset, 'polished', index)).toBe(true)
    expect(matchesQuery(asset, 'POLISHED', index)).toBe(true)
    expect(matchesQuery(asset, 'polished concrete', index)).toBe(true)
  })

  it('不命中 → false', () => {
    expect(matchesQuery(asset, '大理石', index)).toBe(false)
    expect(matchesQuery(asset, 'travertine', index)).toBe(false)
  })

  it('空 query 视为不筛 → true；纯空白同', () => {
    expect(matchesQuery(asset, '', index)).toBe(true)
    expect(matchesQuery(asset, '   ', index)).toBe(true)
  })

  it('没有词典条目时，直接用原名匹配（空索引不崩）', () => {
    const empty = buildAliasIndex([])
    expect(matchesQuery(asset, 'polished', empty)).toBe(true)
    expect(matchesQuery(asset, '抛光', empty)).toBe(false)
  })
})

describe('compareByDisplayName — 中文自然序', () => {
  it('数字串按自然序（石材 2 在 石材 10 之前）', () => {
    expect(compareByDisplayName('石材 2', '石材 10')).toBeLessThan(0)
    expect(compareByDisplayName('石材 10', '石材 2')).toBeGreaterThan(0)
  })

  it('中文按拼音序（沙发 sha < 桌椅 zhuo）', () => {
    expect(compareByDisplayName('沙发', '桌椅')).toBeLessThan(0)
  })

  it('相同字符串 → 0', () => {
    expect(compareByDisplayName('抛光混凝土', '抛光混凝土')).toBe(0)
  })
})
