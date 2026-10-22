/**
 * 别名接线单测（0.6.0 §3.3 · `renderer/logic/aliasIndex.ts`）。
 *
 * 覆盖三件事：
 * ① **memo 语义**：`settings.aliases` 引用不变 → 索引对象必须同一个（不重建 Map）；
 *    引用变了（哪怕内容相同）→ 必须重建；
 * ② **显示名优先级**：别名（asset 级 > key 级）> `displayName()` 剥知末 ID > 原名，
 *    并逐条钉住"同名多条目（createdAt 新的赢）/ 资产级覆盖 / key 归一化"；
 * ③ **源码守卫**：AssetGrid / DetailPanel 不再裸用 `displayName(...)` 而是走
 *    `resolveAssetDisplayName`；SettingsDialog 有「别名」tab 且文案含"磁盘上的文件名不动"。
 */
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  EMPTY_ALIASES,
  MAX_ALIASES,
  aliasIndexOf,
  buildAliasIndexCached,
  mergeAliasRecords,
  parseAliasImport,
  resetAliasIndexCache,
  resolveAssetDisplayName,
  serializeAliases,
  suggestAliasRecords,
  type AliasIndexMemo
} from '../src/renderer/logic/aliasIndex'
import { aliasKeyOf, buildAliasIndex, type AliasRecord } from '../src/shared/aliasRules'

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

function readSrc(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
}

beforeEach(() => {
  resetAliasIndexCache()
})

// ── ① memo：按数组引用 ──────────────────────────────────────────

describe('buildAliasIndexCached — 同一引用不重建', () => {
  it('prev 命中（同一数组引用）→ 原样返回同一个 memo 对象与同一个 Map', () => {
    const records = [rec({ key: 'marble', name: '大理石' })]
    const first = buildAliasIndexCached(records, null)
    const second = buildAliasIndexCached(records, first)

    // 对象身份相同 = 连 Map 都没重建（这是"不要每次渲染重建"的硬指标）
    expect(second).toBe(first)
    expect(second.index).toBe(first.index)
    expect(second.index.byKey.get('marble')).toBe('大理石')
  })

  it('引用变化（内容相同也算）→ 重建，且新索引不再共享旧 Map', () => {
    const a = [rec({ key: 'marble', name: '大理石' })]
    const first = buildAliasIndexCached(a, null)
    const b = [rec({ key: 'marble', name: '大理石' })]
    const second = buildAliasIndexCached(b, first)

    expect(second).not.toBe(first)
    expect(second.index).not.toBe(first.index)
    expect(second.records).toBe(b)
  })

  it('内容真的变了 → 新名字生效（不是只有新引用、旧内容）', () => {
    const before = [rec({ key: 'marble', name: '大理石' })]
    const m1 = buildAliasIndexCached(before, null)
    const after = [rec({ key: 'marble', name: '云石' })]
    const m2 = buildAliasIndexCached(after, m1)
    expect(m2.index.byKey.get('marble')).toBe('云石')
  })

  it('prev = null 时正常构建（首次渲染 / 清缓存后）', () => {
    const memo: AliasIndexMemo = buildAliasIndexCached(EMPTY_ALIASES, null)
    expect(memo.records).toBe(EMPTY_ALIASES)
    expect(memo.index.byKey.size).toBe(0)
  })
})

describe('aliasIndexOf — 模块级共享 memo（网格 / 详情面板共用一份 Map）', () => {
  it('同一数组引用 → 同一个索引对象（不会两个组件各建一份）', () => {
    const records = [rec({ key: 'marble', name: '大理石' })]
    const a = aliasIndexOf(records)
    const b = aliasIndexOf(records)
    expect(b).toBe(a)
  })

  it('换引用 → 换索引；reset 后重新构建', () => {
    const first = aliasIndexOf([rec({ key: 'marble', name: '大理石' })])
    const second = aliasIndexOf([rec({ key: 'marble', name: '大理石' })])
    expect(second).not.toBe(first)

    const stable = [rec({ key: 'brick', name: '砖' })]
    const x = aliasIndexOf(stable)
    resetAliasIndexCache()
    const y = aliasIndexOf(stable)
    expect(y).not.toBe(x)
    expect(y.byKey.get('brick')).toBe('砖')
  })

  it('EMPTY_ALIASES 是稳定常量（不能写成 ?? []，否则 memo 永远失效）', () => {
    const a = aliasIndexOf(EMPTY_ALIASES)
    const b = aliasIndexOf(EMPTY_ALIASES)
    expect(b).toBe(a)
    expect(EMPTY_ALIASES).toEqual([])
  })
})

// ── ② 显示名优先级 ────────────────────────────────────────────

describe('resolveAssetDisplayName — 别名 > displayName() > 原名', () => {
  it('没有任何别名 → 走 displayName() 剥知末 ID（与 0.5.x 行为一致）', () => {
    const index = buildAliasIndex([])
    expect(resolveAssetDisplayName({ id: 'a1', name: '复古砖ID_1172815578' }, index)).toBe(
      '复古砖'
    )
    expect(resolveAssetDisplayName({ id: 'a2', name: '石材' }, index)).toBe('石材')
  })

  it('key 级别名压过 displayName()：别名原样显示（哪怕原名能剥出更短的名字）', () => {
    // 原名剥 ID 后是「复古砖」，但用户显式写了「深色仿古砖」→ 用用户的
    const index = buildAliasIndex([rec({ key: '复古砖ID_1172815578', name: '深色仿古砖' })])
    expect(
      resolveAssetDisplayName({ id: 'a1', name: '复古砖ID_1172815578' }, index)
    ).toBe('深色仿古砖')
  })

  it('key 归一化：词典写未归一化的 key，也能命中带 4K / 不同大小写的资产名', () => {
    const index = buildAliasIndex([rec({ key: 'Polished_Concrete', name: '抛光混凝土' })])
    expect(index.byKey.get(aliasKeyOf('Polished_Concrete'))).toBe('抛光混凝土')
    expect(
      resolveAssetDisplayName({ id: 'a2', name: 'polished concrete 4K' }, index)
    ).toBe('抛光混凝土')
  })

  it('资产级（scope=asset）覆盖 key 级：改一个不影响同名其它资产', () => {
    const index = buildAliasIndex([
      rec({ id: 'key-1', scope: 'key', key: 'marble', name: '大理石' }),
      rec({ id: 'asset-1', scope: 'asset', key: 'a1', name: '一号样板' })
    ])
    expect(resolveAssetDisplayName({ id: 'a1', name: 'Marble' }, index)).toBe('一号样板')
    expect(resolveAssetDisplayName({ id: 'a2', name: 'Marble' }, index)).toBe('大理石')
  })

  it('aliasOverride 最优先（压过 asset 级与 key 级）', () => {
    const index = buildAliasIndex([
      rec({ scope: 'key', key: 'marble', name: '大理石' }),
      rec({ scope: 'asset', key: 'a1', name: '一号样板' })
    ])
    expect(
      resolveAssetDisplayName({ id: 'a1', name: 'Marble', aliasOverride: '客户改了名' }, index)
    ).toBe('客户改了名')
  })

  it('同名多条目：createdAt 最大的胜出（与数组顺序无关）', () => {
    const older = rec({ id: 'old', key: 'marble', name: '旧名', createdAt: 100 })
    const newer = rec({ id: 'new', key: 'marble', name: '新名', createdAt: 200 })
    const index1 = buildAliasIndex([older, newer])
    const index2 = buildAliasIndex([newer, older])
    expect(resolveAssetDisplayName({ id: 'a1', name: 'Marble' }, index1)).toBe('新名')
    expect(resolveAssetDisplayName({ id: 'a1', name: 'Marble' }, index2)).toBe('新名')
  })

  it('空别名（空白串）不生效 → 回落 displayName()，绝不显示空白', () => {
    const index = buildAliasIndex([rec({ key: '复古砖', name: '   ', createdAt: 9 })])
    expect(
      resolveAssetDisplayName({ id: 'a1', name: '复古砖ID_1172815578' }, index)
    ).toBe('复古砖')
  })
})

// ── ②b 设置页纯逻辑：合并 / 导入 / 导出 / 建议 ──────────────────

describe('mergeAliasRecords — 同键覆盖 + 上限', () => {
  it('同归一化 key → 原位覆盖（不产生第二行）', () => {
    const existing = [rec({ id: 'k1', key: 'polishedconcrete', name: '旧名' })]
    const r = mergeAliasRecords(existing, [
      rec({ id: 'k2', key: 'Polished_Concrete', name: '新名', createdAt: 50 })
    ])
    expect(r.records).toHaveLength(1)
    expect(r.records[0]!.name).toBe('新名')
    expect(r.records[0]!.key).toBe('polishedconcrete')
    expect(r.added).toBe(0)
    expect(r.replaced).toBe(1)
    expect(r.dropped).toBe(0)
  })

  it('新 key → 追加；空 key / 空 name → 丢弃并计数', () => {
    const r = mergeAliasRecords(
      [],
      [
        rec({ key: 'marble', name: '大理石' }),
        rec({ key: '   ', name: '空 key' }),
        rec({ key: 'brick', name: '   ' })
      ]
    )
    expect(r.records).toHaveLength(1)
    expect(r.added).toBe(1)
    expect(r.dropped).toBe(2)
  })

  it('上限：超出 limit 的条目不写入（dropped 计数）', () => {
    const r = mergeAliasRecords(
      [rec({ key: 'a', name: 'A' })],
      [rec({ key: 'b', name: 'B' }), rec({ key: 'c', name: 'C' })],
      2
    )
    expect(r.records).toHaveLength(2)
    expect(r.added).toBe(1)
    expect(r.dropped).toBe(1)
    expect(MAX_ALIASES).toBe(500)
  })

  it('asset 级记录不会被 key 级同键覆盖（key 是 assetId，语义不同）', () => {
    const existing = [rec({ id: 'a', scope: 'asset', key: 'a1', name: '单资产名' })]
    const r = mergeAliasRecords(existing, [rec({ id: 'b', scope: 'key', key: 'a1', name: '词典名' })])
    expect(r.records).toHaveLength(2)
    expect(r.added).toBe(1)
  })
})

describe('parseAliasImport / serializeAliases — 导入导出', () => {
  it('标准格式 [{key,name}]：逐行转成记录，key 归一化', () => {
    const r = parseAliasImport(
      JSON.stringify([
        { key: 'Polished_Concrete', name: '抛光混凝土' },
        { key: 'Marble_4K', name: '大理石' }
      ]),
      1000
    )
    expect(r.error).toBeNull()
    expect(r.records.map((x) => x.key)).toEqual(['polishedconcrete', 'marble'])
    expect(r.records.every((x) => x.scope === 'key')).toBe(true)
    expect(r.skipped).toBe(0)
  })

  it('非法行只跳过，不整份失败', () => {
    const r = parseAliasImport(
      JSON.stringify([{ key: 'marble', name: '大理石' }, { name: '缺 key' }, { key: 'brick' }, 42]),
      1
    )
    expect(r.error).toBeNull()
    expect(r.records).toHaveLength(1)
    expect(r.skipped).toBe(3)
  })

  it('顶层是 { aliases: [...] } 也接受', () => {
    const r = parseAliasImport(JSON.stringify({ aliases: [{ key: 'marble', name: '大理石' }] }), 1)
    expect(r.error).toBeNull()
    expect(r.records).toHaveLength(1)
  })

  it('不是 JSON / 顶层不是数组 / 空文件 → error（不是静默成功）', () => {
    expect(parseAliasImport('not json', 1).error).toContain('JSON')
    expect(parseAliasImport('{"foo":1}', 1).error).not.toBeNull()
    expect(parseAliasImport('   ', 1).error).not.toBeNull()
    expect(parseAliasImport('[]', 1).error).not.toBeNull()
  })

  it('导出只带 key / name，且能被导入回去（互逆）', () => {
    const json = serializeAliases([
      rec({ id: 'x', key: 'marble', name: '大理石' }),
      rec({ id: 'y', key: 'brick', name: '砖' })
    ])
    const rows = JSON.parse(json) as unknown[]
    expect(rows).toEqual([
      { key: 'marble', name: '大理石' },
      { key: 'brick', name: '砖' }
    ])
    const back = parseAliasImport(json, 1)
    expect(back.records.map((x) => [x.key, x.name])).toEqual([
      ['marble', '大理石'],
      ['brick', '砖']
    ])
  })
})

describe('suggestAliasRecords — 只建议，不写库', () => {
  it('命中词表 → 给出候选；已有别名的 key 被跳过；最多 10 条', () => {
    const index = buildAliasIndex([rec({ key: '北欧实木餐椅', name: '椅子' })])
    const assets = [
      { name: '现代简约玄关柜' }, // 建议「柜子」
      { name: '北欧实木餐椅' }, // 已有别名 → 跳过
      { name: 'Polished_Concrete_4K' } // 词表认不出 → 跳过
    ]
    const list = suggestAliasRecords(assets, index, 10)
    expect(list).toHaveLength(1)
    expect(list[0]!.sourceName).toBe('现代简约玄关柜')
    expect(list[0]!.name).toBe('柜子')
    expect(list[0]!.key).toBe(aliasKeyOf('现代简约玄关柜'))
  })

  it('同一 key 只出现一次（同名资产不刷屏）', () => {
    const index = buildAliasIndex([])
    // 括号数字尾巴会被归一化抹掉 → 两条资产是同一个 key
    expect(aliasKeyOf('现代简约玄关柜(1)')).toBe(aliasKeyOf('现代简约玄关柜'))
    const list = suggestAliasRecords(
      [{ name: '现代简约玄关柜' }, { name: '现代简约玄关柜(1)' }],
      index,
      10
    )
    expect(list).toHaveLength(1)
  })

  it('limit 真的生效', () => {
    const index = buildAliasIndex([])
    const assets = Array.from({ length: 30 }, (_, i) => ({ name: `现代简约玄关柜${i}` }))
    expect(suggestAliasRecords(assets, index, 3)).toHaveLength(3)
  })
})

// ── ③ 源码守卫 ────────────────────────────────────────────────

describe('源码守卫：显示名接线 / 设置页别名 tab', () => {
  it('AssetGrid 走 aliasIndex（不再裸用 displayName(a.name)）', () => {
    const src = readSrc('../src/renderer/components/AssetGrid.tsx')
    expect(src).toContain("from '../logic/aliasIndex'")
    expect(src).toContain('resolveAssetDisplayName')
    expect(src).toContain('aliasIndexOf')
    expect(src).toContain('EMPTY_ALIASES')
    // 裸用（把别名绕过去）会在这里被抓住
    expect(src).not.toContain('displayName(a.name)')
    expect(src).not.toContain("import { displayName }")
    // 卡片标题 / 列表行 / 拖拽卡片名三个落点都走 displayOf
    expect(src.match(/displayOf\(a\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })

  it('DetailPanel 走 aliasIndex（显示名一行；标题输入框仍是真实名）', () => {
    const src = readSrc('../src/renderer/components/DetailPanel.tsx')
    expect(src).toContain("from '../logic/aliasIndex'")
    expect(src).toContain('resolveAssetDisplayName')
    expect(src).toContain('aliasIndexOf')
    expect(src).not.toContain('displayName(asset.name)')
  })

  it('SettingsDialog 有「别名」tab，且写明"磁盘上的文件名不动"', () => {
    const src = readSrc('../src/renderer/components/SettingsDialog.tsx')
    expect(src).toContain("key: 'alias'")
    expect(src).toContain("label: '别名'")
    expect(src).toContain('tab === \'alias\'')
    expect(src).toContain('磁盘上的文件名不动')
    // 别名排在「库与分类」之后
    expect(src.indexOf("label: '别名'")).toBeGreaterThan(src.indexOf("label: '库与分类'"))
  })

  it('SettingsDialog 具备：导入导出 / 建议 / 上限，且建议必须手动加入', () => {
    const src = readSrc('../src/renderer/components/SettingsDialog.tsx')
    expect(src).toContain('serializeAliases')
    expect(src).toContain('parseAliasImport')
    expect(src).toContain('mergeAliasRecords')
    expect(src).toContain('MAX_ALIASES')
    expect(src).toContain('suggestAliasRecords')
    // 导入结果文案口径：导入 N 条，跳过 M 条
    expect(src).toContain('导入 ${')
    expect(src).toContain('跳过 ${')
    // 建议的唯一写入点是一个显式按钮（没有任何 useEffect 自动写）
    expect(src).toContain('加入选中项（')
    expect(src).toContain('采纳建议')
  })
})
