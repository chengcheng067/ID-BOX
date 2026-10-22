/**
 * 大库性能基线（0.6.0）——**这是"能不能扛住万级库"的量化闸门**，不是普通单测。
 *
 * 为什么要它：虚拟滚动早就有，但没人量过「1 万条资产时，一次筛选 / 一帧滚动窗口计算
 * 要花多少毫秒」。没有基线就没法判断"卡"是来自筛选、行高、还是渲染。
 *
 * 阈值取**宽松**（慢机器上 3 倍余量），只拦"数量级劣化"（比如 O(n²) 混进来）。
 * 实际数字会打印出来，供人工对比。
 */
import { describe, expect, it } from 'vitest'
import { applyFilters, DEFAULT_FILTERS } from '../src/renderer/logic/filters'
import { computeRowWindow } from '../src/renderer/logic/virtualWindow'
import { gridRowHeights } from '../src/renderer/logic/gridMetrics'
import type { Asset, AssetFile, AssetKind } from '../src/shared/types'

const KINDS: AssetKind[] = ['model', 'material', 'texture', 'hdri', 'other']
const CATS = ['家具', '灯具', '软装陈设', '硬装构件', '植物']

function makeAsset(i: number): Asset {
  const kind = KINDS[i % KINDS.length]!
  const c1 = CATS[i % CATS.length]!
  const c2 = `二级${i % 17}`
  const folder = `E:\\Library\\${kind}\\${c1}\\${c2}\\资产${i}`
  const file: AssetFile = {
    rel: `资产${i}.skp`,
    name: `资产${i}.skp`,
    ext: 'skp',
    size: 1024 * (i + 1),
    kind
  }
  return {
    id: `E:\\Library\\${kind}\\${c1}\\${c2}\\资产${i}`,
    name: `资产${i}`,
    kind,
    source: '知末网',
    folder,
    relFolder: `${kind}\\${c1}\\${c2}\\资产${i}`,
    cover: file.rel,
    coverSource: 'named',
    thumbPath: `thumb-${i}.jpg`,
    thumbStatus: 'ready',
    files: [file],
    size: file.size,
    suVersion: i % 3 === 0 ? 'SU 2024' : undefined,
    suMajor: i % 3 === 0 ? 2024 : undefined,
    category1: c1,
    category2: c2,
    styles: i % 4 === 0 ? ['侘寂'] : [],
    tags: i % 5 === 0 ? ['常用'] : [],
    note: '',
    favorite: i % 7 === 0,
    rating: i % 6,
    colorTag: null,
    dedupeKey: `${kind}:资产${i}`,
    importedAt: Date.UTC(2026, 0, 1) + i * 60_000,
    updatedAt: Date.UTC(2026, 0, 1) + i * 60_000
  }
}

function ms(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

describe('大库性能 · 1 万条资产', () => {
  const N = 10_000
  const assets = Array.from({ length: N }, (_, i) => makeAsset(i))

  it('applyFilters（无筛选，全量过一遍）< 80ms', () => {
    let out: Asset[] = []
    const t = ms(() => {
      out = applyFilters(assets, DEFAULT_FILTERS, 'assets')
    })
    console.log(`  applyFilters(10k, 无筛选) = ${t.toFixed(1)}ms，结果 ${out.length} 条`)
    expect(out.length).toBe(N)
    expect(t).toBeLessThan(80)
  })

  it('applyFilters（分类 + 关键词 + 排序）< 120ms', () => {
    let out: Asset[] = []
    const t = ms(() => {
      out = applyFilters(
        assets,
        { ...DEFAULT_FILTERS, category1: '家具', query: '资产1', sort: 'name' },
        'assets'
      )
    })
    console.log(`  applyFilters(10k, 分类+关键词+排序) = ${t.toFixed(1)}ms，结果 ${out.length} 条`)
    expect(t).toBeLessThan(120)
  })

  it('computeRowWindow（2500 行网格：滚动一帧）< 8ms', () => {
    const cols = 4
    const heights = gridRowHeights(
      assets.map((a) => a.kind),
      cols,
      204.5
    )
    const t = ms(() => {
      for (let i = 0; i < 60; i++) {
        computeRowWindow({
          rowHeights: heights,
          viewportH: 900,
          scrollTop: i * 120,
          gap: 16
        })
      }
    })
    const per = t / 60
    console.log(`  computeRowWindow(${heights.length} 行) = ${per.toFixed(3)}ms/帧（60 帧共 ${t.toFixed(1)}ms）`)
    expect(per).toBeLessThan(8)
  })

  it('computeRowWindow（10000 行列表：滚动一帧）< 12ms', () => {
    const heights = new Array<number>(N).fill(44)
    const t = ms(() => {
      for (let i = 0; i < 30; i++) {
        computeRowWindow({ rowHeights: heights, viewportH: 900, scrollTop: i * 200, gap: 0 })
      }
    })
    const per = t / 30
    console.log(`  computeRowWindow(10000 行) = ${per.toFixed(3)}ms/帧（30 帧共 ${t.toFixed(1)}ms）`)
    expect(per).toBeLessThan(12)
  })
})
