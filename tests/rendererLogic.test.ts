/**
 * T05 渲染层纯逻辑单测。
 *
 * 被测对象全部来自 `src/renderer/logic/*`——这些模块不 import React / DOM / electron，
 * 所以能在 node 环境直接跑（组件本体依赖 window.modvault，无法在 vitest 里测）。
 */
import { describe, expect, it } from 'vitest'
import type { Asset, AssetFile } from '../src/shared/types'
import type { Filters } from '../src/renderer/logic/filters'
import {
  DEFAULT_FILTERS,
  activeFilterDimensions,
  applyFilters,
  nextExpandKind,
  countSuVersions,
  matchesFilters,
  searchHaystack,
  sortAssets,
  suMajorOf
} from '../src/renderer/logic/filters'
import {
  assetFileAbs,
  pathSepFor,
  primaryFileAbs,
  primaryFileName,
  revealTargetFor
} from '../src/renderer/logic/assetPath'
import {
  DELETE_GRACE_MS,
  describeDelete,
  graceSecondsLeft,
  remainingGraceMs,
  toDeleteTargets
} from '../src/renderer/logic/deleteFlow'
import { spaceShortageText } from '../src/renderer/logic/importText'

const GB = 1024 ** 3

function file(rel: string, kind: AssetFile['kind'], size = 100): AssetFile {
  const name = rel.split('/').pop() ?? rel
  return { rel, name, ext: (name.split('.').pop() ?? '').toLowerCase(), size, kind }
}

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\资产${seq}`,
    relFolder: `模型/资产${seq}`,
    files: [],
    size: 0,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `dk-${seq}`,
    importedAt: seq * 1000,
    updatedAt: seq * 1000,
    ...patch
  }
}

describe('logic/filters · searchHaystack', () => {
  it('haystack 包含 suVersion（P0-15 派单要求补上）', () => {
    const a = asset({ suVersion: 'SU 2024' })
    expect(searchHaystack(a)).toContain('su 2024')
  })

  it('搜索「2024」能命中 SU 版本', () => {
    const a = asset({ suVersion: 'SU 2024' })
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, query: '2024' })).toBe(true)
  })

  it('haystack 还包含名称 / 标签 / 备注 / 来源 / 大类名', () => {
    const a = asset({ name: '现代衣柜', tags: ['卧室'], note: '白蜡木', source: '3d66' })
    const hay = searchHaystack(a)
    for (const kw of ['现代衣柜', '卧室', '白蜡木', '3d66', '模型']) expect(hay).toContain(kw)
  })
})

describe('logic/filters · matchesFilters', () => {
  it('kind / tag / source / suVersion 各档独立生效', () => {
    const a = asset({ kind: 'texture', tags: ['木纹'], source: '知末网', suVersion: undefined })
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, kind: 'texture' })).toBe(true)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, kind: 'model' })).toBe(false)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, tag: '木纹' })).toBe(true)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, tag: '布艺' })).toBe(false)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, source: '知末网' })).toBe(true)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, source: '3d66' })).toBe(false)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, suVersion: 'SU 2024' })).toBe(false)
  })

  it('suVersion 精确匹配（不是子串）', () => {
    const a = asset({ suVersion: 'SU 2024' })
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, suVersion: 'SU 2024' })).toBe(true)
    expect(matchesFilters(a, { ...DEFAULT_FILTERS, suVersion: 'SU 2022' })).toBe(false)
  })
})

describe('logic/filters · sortAssets', () => {
  it('recent：按导入时间降序', () => {
    const list = sortAssets([asset({ importedAt: 1 }), asset({ importedAt: 9 }), asset({ importedAt: 5 })], 'recent')
    expect(list.map((a) => a.importedAt)).toEqual([9, 5, 1])
  })

  it('size：按大小降序', () => {
    const list = sortAssets([asset({ size: 10 }), asset({ size: 300 }), asset({ size: 50 })], 'size')
    expect(list.map((a) => a.size)).toEqual([300, 50, 10])
  })

  it('name：中文名 localeCompare', () => {
    const list = sortAssets([asset({ name: '沙发' }), asset({ name: '床' }), asset({ name: '衣柜' })], 'name')
    expect(list.map((a) => a.name)).toEqual(['床', '沙发', '衣柜'])
  })

  it('su：按 SU 版本新→旧，无版本的排最后', () => {
    const list = sortAssets(
      [asset({ name: 'a' }), asset({ name: 'b', suVersion: 'SU 2020', suMajor: 20 }), asset({ name: 'c', suVersion: 'SU 2024', suMajor: 24 })],
      'su'
    )
    expect(list.map((a) => a.name)).toEqual(['c', 'b', 'a'])
  })

  it('suMajorOf 兜底：无 suMajor 时从标签尾数字取，都没有为 -1', () => {
    expect(suMajorOf(asset({ suVersion: 'SU 2019' }))).toBe(2019)
    expect(suMajorOf(asset({ suVersion: 'SU 2024', suMajor: 24 }))).toBe(24)
    expect(suMajorOf(asset({ suVersion: undefined }))).toBe(-1)
  })
})

describe('logic/filters · applyFilters + countSuVersions', () => {
  it('过滤 + 排序一次完成', () => {
    const list = [
      asset({ name: '衣柜A', kind: 'texture' }),
      asset({ name: '衣柜B', kind: 'model' }),
      asset({ name: '衣柜C', kind: 'texture', size: 9 })
    ]
    const out = applyFilters(list, { ...DEFAULT_FILTERS, kind: 'texture', sort: 'size' })
    expect(out.map((a) => a.name)).toEqual(['衣柜C', '衣柜A'])
  })

  it('countSuVersions：分组计数、count 降序、同数按 major 降序', () => {
    const list = [
      asset({ suVersion: 'SU 2024', suMajor: 24 }),
      asset({ suVersion: 'SU 2024', suMajor: 24 }),
      asset({ suVersion: 'SU 2022', suMajor: 22 }),
      asset({ suVersion: 'SU 2022', suMajor: 22 }),
      asset({ suVersion: 'SU 2022', suMajor: 22 }),
      asset({ suVersion: undefined })
    ]
    expect(countSuVersions(list)).toEqual([
      { version: 'SU 2022', count: 3, major: 22 },
      { version: 'SU 2024', count: 2, major: 24 }
    ])
  })

  it('countSuVersions：空数组返回空', () => {
    expect(countSuVersions([])).toEqual([])
  })
})

describe('logic/filters · activeFilterDimensions（用户反馈第 5 条 · 空结果提示）', () => {
  it('非空资产集 + 只含残留 query 筛选 → 结果为 0，且正确报告生效维度', () => {
    const list = [asset({ name: '现代衣柜' }), asset({ name: '北欧沙发' })]
    const f = { ...DEFAULT_FILTERS, query: '不存在的词' }
    expect(applyFilters(list, f)).toHaveLength(0)
    // 库真不为空 → App 的全局空态（拖包 CTA）此时不该出现，必须走 AssetGrid 空分支
    expect(list.length).toBe(2)
    expect(activeFilterDimensions(f)).toEqual([{ key: 'query', label: '搜索词', value: '不存在的词' }])
  })

  it('残留 styles 筛选 → 结果为 0；多选维度的值用「、」拼接', () => {
    const list = [asset({ styles: ['现代'] }), asset({ styles: ['北欧'] })]
    const f = { ...DEFAULT_FILTERS, styles: ['工业', '复古'] }
    expect(applyFilters(list, f)).toHaveLength(0)
    expect(activeFilterDimensions(f)).toEqual([{ key: 'styles', label: '风格', value: '工业、复古' }])
  })

  it('多维度同时生效 → 按固定顺序列出，空维度不出现，query 先 trim', () => {
    const f: Filters = {
      ...DEFAULT_FILTERS,
      kind: 'model',
      category1: '家具',
      styles: ['现代'],
      suVersion: 'SU 2024',
      query: '  衣柜  '
    }
    expect(activeFilterDimensions(f)).toEqual([
      { key: 'kind', label: '大类', value: '模型' },
      { key: 'category1', label: '一级分类', value: '家具' },
      { key: 'styles', label: '风格', value: '现代' },
      { key: 'suVersion', label: 'SU 版本', value: 'SU 2024' },
      { key: 'query', label: '搜索词', value: '衣柜' }
    ])
  })

  it('DEFAULT_FILTERS 无生效维度；清空筛选后恢复全量', () => {
    const list = [asset({ kind: 'model', styles: ['现代'] }), asset({ kind: 'texture' })]
    const f: Filters = { ...DEFAULT_FILTERS, kind: 'texture', tag: '布艺', query: '木纹' }
    expect(applyFilters(list, f)).toHaveLength(0)
    expect(activeFilterDimensions(f)).toHaveLength(3)
    // 组件「清空筛选」按钮 = setFilter(DEFAULT_FILTERS)（merge 语义）→ 恢复全量
    expect(applyFilters(list, DEFAULT_FILTERS)).toHaveLength(2)
    expect(activeFilterDimensions(DEFAULT_FILTERS)).toEqual([])
  })

  it('sort 是排序维度、不是筛选维度，不参与空结果提示', () => {
    expect(activeFilterDimensions({ ...DEFAULT_FILTERS, sort: 'size' })).toEqual([])
  })
})

describe('logic/filters · nextExpandKind（用户反馈第 5 条 · 缺陷 2 首次点击即展开）', () => {
  it('首次点击大类（未展开）→ 展开该大类', () => {
    expect(nextExpandKind(false, 'model')).toBe('model')
  })

  it('已展开的该大类再点一次 → 折叠（toggle 语义不变）', () => {
    expect(nextExpandKind(true, 'model')).toBeNull()
  })

  it('展开状态只有单一状态源：显式折叠后筛选仍在，再点即回到展开', () => {
    // 此前 openKind 从 filters.category1 反推 → 显式折叠与筛选回退互相打架。
    // 现在 openKind 只看显式展开状态：折叠后筛选（kind/残留维度）不变，下一次点击即重新展开。
    const collapsed = nextExpandKind(true, 'texture')
    expect(collapsed).toBeNull()
    // 折叠后残留的二级筛选不会替用户把树重新撑开（openKind = collapsed，单一状态源）
    const f: Filters = { ...DEFAULT_FILTERS, kind: 'texture', category1: '家具', category2: '沙发' }
    const openKind = collapsed
    expect(openKind === 'texture').toBe(false)
    // 该状态下再点大类：expanded=false → 重新展开
    expect(nextExpandKind(openKind === 'texture', 'texture')).toBe('texture')
    expect(f.kind).toBe('texture')
  })
})

describe('logic/assetPath', () => {
  it('pathSepFor：Windows 反斜杠 / posix 正斜杠', () => {
    expect(pathSepFor('E:\\Lib\\模型')).toBe('\\')
    expect(pathSepFor('/home/user/lib')).toBe('/')
  })

  it('assetFileAbs：rel 的 posix 分隔符转成平台分隔符', () => {
    expect(assetFileAbs('E:\\Lib\\模型\\衣柜', '贴图/木纹 01.jpg')).toBe('E:\\Lib\\模型\\衣柜\\贴图\\木纹 01.jpg')
    expect(assetFileAbs('/lib/model/wardrobe', 'textures/wood.jpg')).toBe('/lib/model/wardrobe/textures/wood.jpg')
  })

  it('primaryFileAbs：skp > max > fbx > obj > 3ds 优先级', () => {
    const a = asset({
      files: [file('a.max', 'model'), file('b.skp', 'model'), file('c.fbx', 'model'), file('d.obj', 'model')]
    })
    expect(primaryFileAbs(a)).toBe(`${a.folder}\\b.skp`)
  })

  it('primaryFileAbs：无五类主格式时取首个模型文件，再退 files[0]', () => {
    const onlyModel = asset({ files: [file('mesh.dae', 'model'), file('diff.png', 'texture')] })
    expect(primaryFileAbs(onlyModel)).toBe(`${onlyModel.folder}\\mesh.dae`)
    const onlyTex = asset({ files: [file('diff.png', 'texture'), file('nrm.png', 'texture')] })
    expect(primaryFileAbs(onlyTex)).toBe(`${onlyTex.folder}\\diff.png`)
  })

  it('primaryFileAbs：files 为空返回 null；revealTargetFor 回退资产文件夹', () => {
    const a = asset({ files: [] })
    expect(primaryFileAbs(a)).toBeNull()
    expect(revealTargetFor(a)).toBe(a.folder)
    expect(primaryFileName(a)).toBeNull()
  })

  it('primaryFileName 返回主文件名；revealTargetFor 选中主模型文件（Q3）', () => {
    const a = asset({ files: [file('预览.jpg', 'texture'), file('衣柜.skp', 'model')] })
    expect(primaryFileName(a)).toBe('衣柜.skp')
    expect(revealTargetFor(a)).toBe(`${a.folder}\\衣柜.skp`)
  })
})

describe('logic/deleteFlow', () => {
  it('describeDelete 单选：名称 + 大小 + 文件数（P0-16）', () => {
    const s = describeDelete(toDeleteTargets([asset({ name: '现代衣柜', size: 2.5 * GB, files: [file('a.skp', 'model')] })]))
    expect(s.title).toBe('现代衣柜')
    expect(s.detail).toBe('1 个文件 · 2.5 GB')
    expect(s.count).toBe(1)
    expect(s.totalBytes).toBe(2.5 * GB)
  })

  it('describeDelete 多选：「N 个资产 · 合计 X GB」（P0-16）', () => {
    const s = describeDelete(
      toDeleteTargets([asset({ size: GB }), asset({ size: 2 * GB }), asset({ size: 512 * 1024 * 1024 })])
    )
    expect(s.title).toBe('3 个资产')
    expect(s.detail).toBe('合计 3.5 GB')
    expect(s.count).toBe(3)
  })

  it('describeDelete 空数组不炸', () => {
    const s = describeDelete([])
    expect(s.title).toBe('0 个资产')
    expect(s.totalBytes).toBe(0)
  })

  it('toDeleteTargets 只摘 id/name/size/files 快照字段', () => {
    const [t] = toDeleteTargets([asset({ files: [file('a.skp', 'model'), file('b.png', 'texture')] })])
    expect(t).toEqual({ id: t!.id, name: t!.name, size: 0, files: 2 })
  })

  it('remainingGraceMs：线性递减、不为负', () => {
    expect(remainingGraceMs(1000, 1000 + 1500)).toBe(3500)
    expect(remainingGraceMs(1000, 1000 + DELETE_GRACE_MS + 999)).toBe(0)
    // 绝对截止时间设计：时钟回拨（now < startedAt）只是让剩余时间变长，不会出负数
    expect(remainingGraceMs(1000, 100)).toBe(5900)
  })

  it('graceSecondsLeft：向上取整（3999ms → 4）', () => {
    expect(graceSecondsLeft(0, DELETE_GRACE_MS - 3999)).toBe(4)
    expect(graceSecondsLeft(0, DELETE_GRACE_MS)).toBe(0)
    expect(graceSecondsLeft(0, DELETE_GRACE_MS + 1)).toBe(0)
  })
})

describe('logic/importText · spaceShortageText（P0-3）', () => {
  it('有 needBytes / freeBytes 时给出「可用 X GB / 需要 Y GB」', () => {
    expect(spaceShortageText(12.5 * GB, 3.2 * GB)).toBe('可用 3.2 GB / 需要 12.5 GB')
  })

  it('字段缺失 / 非法 / 非正数时返回 null（退回普通错误文案）', () => {
    expect(spaceShortageText(undefined, undefined)).toBeNull()
    expect(spaceShortageText(NaN, 1)).toBeNull()
    expect(spaceShortageText(1, NaN)).toBeNull()
    expect(spaceShortageText(0, 100)).toBeNull()
    expect(spaceShortageText(-1, 100)).toBeNull()
  })

  it('freeBytes 为 0（盘满）是合法值，正常显示', () => {
    expect(spaceShortageText(GB, 0)).toBe('可用 0.0 GB / 需要 1.0 GB')
  })
})
