import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MENU_TARGET_SELECTOR,
  assetMenuItems,
  assetOpenModeOf,
  canCustomRender,
  clearFilterPatch,
  emptyMenuItems,
  fileMenuItems,
  hasClearableFilters,
  isCoverSourceExt,
  isMenuItem,
  menuPlacement,
  normalizeMenuItems,
  rescanNoticeOf,
  type AssetMenuActions,
  type ContextMenuItem,
  type EmptyMenuActions,
  type FileMenuActions
} from '../src/renderer/logic/contextMenu'
import { DEFAULT_FILTERS, type Filters } from '../src/renderer/logic/filters'
import { buildFileRows } from '../src/renderer/logic/fileView'
import type { Asset, AssetFile } from '../src/shared/types'

/**
 * 右键菜单体系（卡片 / 文件行 / 空白处）的纯逻辑单测。
 *
 * 覆盖四件事：
 * ① 菜单项的**构成**（哪一项在什么条件下出现、文案、禁用、末尾危险项）；
 * ② 动作注入是否接对了（点某一项 → 对应回调被调一次）；
 * ③ 空白处「刷新 / 清除筛选」的判定边界（特别是"大类不算筛选"这条）；
 * ④ 源码守卫：接线不能被后人改回（卡片标记属性、空白处 onContextMenu、
 *    `AssetContextMenu` 的导出签名）。
 */

/* ── 夹具 ─────────────────────────────────────────────────────────── */

let seq = 0

/** 资产夹具（默认是一个模型，`files` / `kind` / `favorite` 由调用方覆盖） */
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [{ rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 10, kind: 'model' }],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...patch
  }
}

/** 一张贴图文件（材质族资产要它才拿得到 baseColor 槽位） */
function texFile(name = 'a.jpg'): AssetFile {
  return { rel: name, name, ext: 'jpg', size: 1024, kind: 'texture' }
}

/** 材质族的资产夹具 */
function materialAsset(patch: Partial<Asset> = {}): Asset {
  return asset({
    kind: 'texture',
    files: [texFile()],
    ...patch
  })
}

/** 只记录"被点了哪一项"的动作集合（默认全空实现） */
function assetActions(): AssetMenuActions & { hits: string[]; favoriteNext: boolean[] } {
  const hits: string[] = []
  const favoriteNext: boolean[] = []
  return {
    hits,
    favoriteNext,
    onEnterFolder: () => hits.push('enterFolder'),
    onPreviewHdr: () => hits.push('previewHdr'),
    onReveal: () => hits.push('reveal'),
    onChangeCover: () => hits.push('changeCover'),
    onCustomRender: () => hits.push('customRender'),
    onAssignCategory: () => hits.push('assignCategory'),
    onToggleFavorite: (next) => {
      hits.push('favorite')
      favoriteNext.push(next)
    },
    onCopyName: () => hits.push('copyName'),
    onCopyFolderPath: () => hits.push('copyFolderPath'),
    onKeepThis: () => hits.push('keepThis'),
    onDelete: () => hits.push('delete')
  }
}

function labelsOf(items: readonly ContextMenuItem[]): string[] {
  return items.filter(isMenuItem).map((i) => i.label)
}

/** 取某一项（找不到就报错，避免"断言了个不存在的东西") */
function itemOf(items: readonly ContextMenuItem[], label: string) {
  const hit = items.find((i) => isMenuItem(i) && i.label === label)
  if (!hit || !isMenuItem(hit)) throw new Error(`菜单里没有「${label}」，实际为：${labelsOf(items).join(' / ')}`)
  return hit
}

/** 分组完整性：不许出现首/尾/连续分隔线（三个菜单共用口径） */
function expectCleanSeparators(items: readonly ContextMenuItem[]): void {
  expect(items.length).toBeGreaterThan(0)
  expect(items[0]).not.toBe('separator')
  expect(items[items.length - 1]).not.toBe('separator')
  for (let i = 1; i < items.length; i++) {
    if (items[i] === 'separator') expect(items[i - 1]).not.toBe('separator')
  }
}

/* ── 1. 资产卡片菜单 ──────────────────────────────────────────────── */

describe('assetMenuItems —— 第一项按 kind 变形态', () => {
  it('model / texture / material 的第一项是「进入文件夹」', () => {
    for (const kind of ['model', 'texture', 'material'] as const) {
      const a = kind === 'model' ? asset({ kind }) : materialAsset({ kind })
      const items = assetMenuItems([a], [a.id], assetActions())
      const first = items.find(isMenuItem)
      expect(first?.label).toBe('进入文件夹')
      expectCleanSeparators(items)
    }
  })

  it('hdri 的第一项是「预览 HDR」', () => {
    const a = asset({ kind: 'hdri', files: [{ rel: 'a.hdr', name: 'a.hdr', ext: 'hdr', size: 9, kind: 'hdri' }] })
    const items = assetMenuItems([a], [a.id], assetActions())
    expect(items.find(isMenuItem)?.label).toBe('预览 HDR')
  })

  it('other 的第一项是「打开文件位置」，且全菜单只有一个该项（不重复摆两遍）', () => {
    const a = asset({ kind: 'other', files: [{ rel: 'a.pdf', name: 'a.pdf', ext: 'pdf', size: 9, kind: 'other' }] })
    const items = assetMenuItems([a], [a.id], assetActions())
    expect(items.find(isMenuItem)?.label).toBe('打开文件位置')
    expect(labelsOf(items).filter((l) => l === '打开文件位置').length).toBe(1)
  })

  it('assetOpenModeOf：单选按 kind 分流，多选一律 multi', () => {
    expect(assetOpenModeOf([asset({ kind: 'model' })])).toBe('folder')
    expect(assetOpenModeOf([asset({ kind: 'hdri' })])).toBe('hdr')
    expect(assetOpenModeOf([asset({ kind: 'other' })])).toBe('reveal')
    expect(assetOpenModeOf([asset(), asset()])).toBe('multi')
  })

  it('点第一项会调到对应的回调（注入的动作真的接上了）', () => {
    const a = asset({ kind: 'model' })
    const actions = assetActions()
    const items = assetMenuItems([a], [a.id], actions)
    itemOf(items, '进入文件夹').onClick()
    expect(actions.hits).toEqual(['enterFolder'])
  })
})

describe('assetMenuItems —— 「自定义渲染…」只在材质族出现', () => {
  it('material / texture 出现', () => {
    for (const kind of ['material', 'texture'] as const) {
      const a = materialAsset({ kind })
      expect(labelsOf(assetMenuItems([a], [a.id], assetActions()))).toContain('自定义渲染…')
    }
  })

  it('model / hdri / other 不出现', () => {
    const model = asset({ kind: 'model' })
    const hdri = asset({ kind: 'hdri' })
    const other = asset({ kind: 'other' })
    for (const a of [model, hdri, other]) {
      expect(labelsOf(assetMenuItems([a], [a.id], assetActions()))).not.toContain('自定义渲染…')
    }
  })

  it('材质族但没有任何图片（拿不到 baseColor）→ 不出现（与详情面板 canCustomRender 同判据）', () => {
    const a = materialAsset({ files: [{ rel: 'a.tga', name: 'a.tga', ext: 'tga', size: 9, kind: 'texture' }] })
    expect(canCustomRender(a)).toBe(false)
    expect(labelsOf(assetMenuItems([a], [a.id], assetActions()))).not.toContain('自定义渲染…')
  })

  it('canCustomRender 对 null / 未知 kind 一律 false', () => {
    expect(canCustomRender(null)).toBe(false)
    expect(canCustomRender(undefined)).toBe(false)
    expect(canCustomRender(asset({ kind: 'other' }))).toBe(false)
  })
})

describe('assetMenuItems —— 多选语义', () => {
  it('多选时「复制资产名」「更换封面…」禁用，「自定义渲染…」「保留这份…」不出现', () => {
    const a = asset({ kind: 'model' })
    const b = asset({ kind: 'model' })
    const items = assetMenuItems([a, b], [a.id, b.id], assetActions())
    expect(itemOf(items, '复制资产名').disabled).toBe(true)
    expect(itemOf(items, '更换封面…').disabled).toBe(true)
    expect(labelsOf(items)).not.toContain('自定义渲染…')
    expect(labelsOf(items)).not.toContain('保留这份，其余移入回收站')
  })

  it('单选时这两项可用', () => {
    const a = materialAsset({ kind: 'material' })
    const items = assetMenuItems([a], [a.id], assetActions())
    expect(itemOf(items, '复制资产名').disabled).toBeFalsy()
    expect(itemOf(items, '更换封面…').disabled).toBeFalsy()
  })

  it('多选时收藏标签带「（N 项）」，且动作传 true（还有没收藏的就全收藏）', () => {
    const a = asset({ kind: 'model' })
    const b = asset({ kind: 'model', favorite: true })
    const actions = assetActions()
    const items = assetMenuItems([a, b], [a.id, b.id], actions)
    const fav = itemOf(items, '收藏（2 项）')
    fav.onClick()
    expect(actions.favoriteNext).toEqual([true])
  })

  it('全部已收藏 → 显示「取消收藏」并传 false', () => {
    const a = asset({ kind: 'model', favorite: true })
    const actions = assetActions()
    const items = assetMenuItems([a], [a.id], actions)
    itemOf(items, '取消收藏').onClick()
    expect(actions.favoriteNext).toEqual([false])
  })

  it('多选的第一项是「打开第一个所在文件夹」', () => {
    const a = asset()
    const b = asset()
    const items = assetMenuItems([a, b], [a.id, b.id], assetActions())
    expect(items.find(isMenuItem)?.label).toBe('打开第一个所在文件夹')
  })
})

describe('assetMenuItems —— 「保留这份，其余移入回收站」的出现条件', () => {
  it('单选 + 属于重复组 + 组内还有副本 → 出现（且点它只调 onKeepThis）', () => {
    const a = asset({ dedupeKey: 'model:椅子', importedAt: 1 })
    const b = asset({ dedupeKey: 'model:椅子', importedAt: 2 })
    const actions = assetActions()
    const items = assetMenuItems([a, b], [a.id], actions)
    itemOf(items, '保留这份，其余移入回收站').onClick()
    expect(actions.hits).toEqual(['keepThis'])
  })

  it('没有副本 → 不出现', () => {
    const a = asset()
    const items = assetMenuItems([a], [a.id], assetActions())
    expect(labelsOf(items)).not.toContain('保留这份，其余移入回收站')
  })

  it('多选（哪怕都在同一重复组）→ 不出现（作用域会重叠，语义不成立）', () => {
    const a = asset({ dedupeKey: 'model:椅子' })
    const b = asset({ dedupeKey: 'model:椅子' })
    const items = assetMenuItems([a, b], [a.id, b.id], assetActions())
    expect(labelsOf(items)).not.toContain('保留这份，其余移入回收站')
  })
})

describe('assetMenuItems —— 整体顺序 / 末尾危险项', () => {
  it('末尾一定是「分隔线 + 删除」，且删除是 danger', () => {
    const a = materialAsset({ kind: 'material' })
    const items = assetMenuItems([a], [a.id], assetActions())
    expect(items[items.length - 2]).toBe('separator')
    const last = items[items.length - 1]
    expect(isMenuItem(last) && last.label.startsWith('删除')).toBe(true)
    expect(itemOf(items, '删除…').danger).toBe(true)
  })

  it('顺序与产品口径一致（材质单选，含全部分组）', () => {
    const a = materialAsset({ kind: 'material', dedupeKey: 'texture:椅子' })
    const b = materialAsset({ kind: 'material', dedupeKey: 'texture:椅子' })
    const items = assetMenuItems([a, b], [a.id], assetActions())
    expect(labelsOf(items)).toEqual([
      '进入文件夹',
      '更换封面…',
      '自定义渲染…',
      '指派分类…',
      '收藏',
      '复制资产名',
      '复制文件夹路径',
      '打开文件位置',
      '保留这份，其余移入回收站',
      '删除…'
    ])
    expectCleanSeparators(items)
  })

  it('三个条件都不成立时也不留空行（模型 + 无副本）', () => {
    const a = asset({ kind: 'model' })
    const items = assetMenuItems([a], [a.id], assetActions())
    expectCleanSeparators(items)
    expect(labelsOf(items)).toEqual([
      '进入文件夹',
      '更换封面…',
      '指派分类…',
      '收藏',
      '复制资产名',
      '复制文件夹路径',
      '打开文件位置',
      '删除…'
    ])
  })

  it('ids 全都不存在 → 空数组（不给"幽灵菜单"）', () => {
    const a = asset()
    expect(assetMenuItems([a], ['nope'], assetActions())).toEqual([])
    expect(assetMenuItems([a], [], assetActions())).toEqual([])
  })
})

/* ── 2. 文件行菜单 ───────────────────────────────────────────────── */

const fileActions = (): FileMenuActions & { hits: string[] } => {
  const hits: string[] = []
  return {
    hits,
    onOpen: () => hits.push('open'),
    onReveal: () => hits.push('reveal'),
    onSetCover: () => hits.push('setCover'),
    onCopyName: () => hits.push('copyName'),
    onCopyPath: () => hits.push('copyPath')
  }
}

describe('fileMenuItems —— 图片才有「设为封面」', () => {
  it('jpg / png / webp / tif 都有', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff']) {
      expect(isCoverSourceExt(ext)).toBe(true)
      expect(labelsOf(fileMenuItems({ ext }, fileActions()))).toContain('设为封面')
    }
  })

  it('skp / hdr / tga / gif 没有（后两者是"能看但不能当封面"）', () => {
    for (const ext of ['skp', 'hdr', 'tga', 'gif', 'svg']) {
      expect(labelsOf(fileMenuItems({ ext }, fileActions()))).not.toContain('设为封面')
    }
  })

  it('大小写不敏感', () => {
    expect(isCoverSourceExt('JPG')).toBe(true)
    expect(labelsOf(fileMenuItems({ ext: 'PNG' }, fileActions()))).toContain('设为封面')
  })
})

describe('fileMenuItems —— 文案与顺序', () => {
  it('图片行：打开 / 显示 / 设为封面 / 复制文件名 / 复制完整路径', () => {
    const items = fileMenuItems({ ext: 'jpg' }, fileActions())
    expect(labelsOf(items)).toEqual([
      '用默认程序打开',
      '在资源管理器中显示',
      '设为封面',
      '复制文件名',
      '复制完整路径'
    ])
    expectCleanSeparators(items)
  })

  it('非图片行：没有设为封面，且不留下双分隔线', () => {
    const items = fileMenuItems({ ext: 'skp' }, fileActions())
    expect(labelsOf(items)).toEqual([
      '用默认程序打开',
      '在资源管理器中显示',
      '复制文件名',
      '复制完整路径'
    ])
    expectCleanSeparators(items)
  })

  it('每项都接到正确的回调', () => {
    const actions = fileActions()
    const items = fileMenuItems({ ext: 'png' }, actions)
    for (const label of labelsOf(items)) itemOf(items, label).onClick()
    expect(actions.hits).toEqual(['open', 'reveal', 'setCover', 'copyName', 'copyPath'])
  })

  it('与真实 FileRow 结构化匹配（buildFileRows 的产物直接可用）', () => {
    const a = asset({
      folder: 'E:\\Lib\\模型\\未分类\\未分类\\资产X',
      files: [
        { rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 10, kind: 'model' },
        { rel: 'preview.jpg', name: 'preview.jpg', ext: 'jpg', size: 20, kind: 'texture' }
      ]
    })
    const rows = buildFileRows(a)
    const jpgRow = rows.find((r) => r.ext === 'jpg')
    expect(jpgRow).toBeTruthy()
    expect(labelsOf(fileMenuItems(jpgRow!, fileActions()))).toContain('设为封面')
    const skpRow = rows.find((r) => r.ext === 'skp')
    expect(labelsOf(fileMenuItems(skpRow!, fileActions()))).not.toContain('设为封面')
  })
})

/* ── 3. 空白处菜单 ───────────────────────────────────────────────── */

const emptyActions = (): EmptyMenuActions & { hits: string[] } => {
  const hits: string[] = []
  return { hits, onRefresh: () => hits.push('refresh'), onClearFilters: () => hits.push('clear') }
}

describe('emptyMenuItems —— 刷新永远在，清除筛选按需', () => {
  it('无任何筛选 → 只有「刷新」', () => {
    const items = emptyMenuItems(DEFAULT_FILTERS, emptyActions())
    expect(labelsOf(items)).toEqual(['刷新'])
    expectCleanSeparators(items)
  })

  it.each<[string, Partial<Filters>]>([
    ['体积', { minBytes: 10 * 1024 * 1024 }],
    ['时间', { importedAfter: 1_700_000_000_000 }],
    ['分辨率', { minResolution: '4k' }],
    ['色标', { colorTags: ['red'] }],
    ['风格', { styles: ['现代'] }],
    ['搜索词', { query: '椅子' }],
    ['分类', { category1: '家具' }],
    ['收藏', { favoriteOnly: true }],
    ['标签', { tag: '常用' }],
    ['来源', { source: '知末网' }],
    ['SU 版本', { suVersion: 'SU 2024' }]
  ])('有%s筛选 → 含「清除筛选」', (_name, patch) => {
    const f: Filters = { ...DEFAULT_FILTERS, ...patch }
    const items = emptyMenuItems(f, emptyActions())
    expect(labelsOf(items)).toEqual(['刷新', '清除筛选'])
  })

  it('「大类」不算筛选（它就是视图本身）：模型视图无其它条件 → 不出现清除筛选', () => {
    const f: Filters = { ...DEFAULT_FILTERS, kind: 'model' }
    expect(hasClearableFilters(f)).toBe(false)
    expect(labelsOf(emptyMenuItems(f, emptyActions()))).toEqual(['刷新'])
  })

  it('空的搜索词 / 空数组不算筛选', () => {
    const f: Filters = { ...DEFAULT_FILTERS, query: '   ', styles: [], colorTags: [] }
    expect(hasClearableFilters(f)).toBe(false)
  })

  it('点「刷新」只调刷新，点「清除筛选」只调清空', () => {
    const actions = emptyActions()
    const items = emptyMenuItems({ ...DEFAULT_FILTERS, query: '椅子' }, actions)
    itemOf(items, '刷新').onClick()
    itemOf(items, '清除筛选').onClick()
    expect(actions.hits).toEqual(['refresh', 'clear'])
  })
})

describe('clearFilterPatch —— 复位筛选但不动排序与视图', () => {
  it('重置全部筛选维度，保留 kind 与 sort（sort 不在 patch 里）', () => {
    const f: Filters = {
      ...DEFAULT_FILTERS,
      kind: 'hdri',
      sort: 'size',
      query: '椅子',
      styles: ['现代'],
      colorTags: ['red'],
      minBytes: 100,
      maxBytes: 200,
      importedAfter: 1,
      importedBefore: 2,
      minResolution: '8k',
      category1: '家具',
      category2: '椅子',
      tag: '常用',
      source: '知末网',
      suVersion: 'SU 2024',
      favoriteOnly: true
    }
    const patch = clearFilterPatch(f)
    expect(patch.kind).toBe('hdri')
    expect(patch).not.toHaveProperty('sort')
    const merged: Filters = { ...f, ...patch }
    expect(merged.sort).toBe('size')
    // 除 kind / sort 外全部回到默认值（sort 被保留，所以基准要带上它）
    expect({ ...merged, kind: DEFAULT_FILTERS.kind, sort: DEFAULT_FILTERS.sort }).toEqual(
      DEFAULT_FILTERS
    )
    expect(hasClearableFilters(merged)).toBe(false)
  })
})

/* ── 4. 定位 / 文案 / 选择器 ─────────────────────────────────────── */

describe('menuPlacement —— 按真实宽高夹取，不超出视口', () => {
  it('正常位置原样返回', () => {
    expect(menuPlacement(100, 100, 200, 300, 1200, 800)).toEqual({ left: 100, top: 100 })
  })

  it('贴右下角时整体内收（不被切掉）', () => {
    expect(menuPlacement(1150, 780, 200, 400, 1200, 800)).toEqual({ left: 992, top: 392 })
  })

  it('负数 / 超小视口不会推出左上边界', () => {
    expect(menuPlacement(-50, -50, 200, 300, 1200, 800)).toEqual({ left: 8, top: 8 })
    expect(menuPlacement(5, 5, 200, 300, 100, 100)).toEqual({ left: 8, top: 8 })
  })

  it('同一位置下，菜单越高越往上收（说明用的是实际高度而不是常数）', () => {
    const short = menuPlacement(900, 600, 200, 200, 1200, 800)
    const tall = menuPlacement(900, 600, 200, 500, 1200, 800)
    expect(tall.top).toBeLessThan(short.top)
  })
})

describe('rescanNoticeOf —— 成功 / 被拒都如实说', () => {
  it('成功给出条数', () => {
    expect(rescanNoticeOf({ aborted: null, scanned: 42 })).toBe('已刷新：42 个资产')
  })

  it('空扫描 / 骤减中止都要说明"索引未改动"', () => {
    expect(rescanNoticeOf({ aborted: 'empty-scan', scanned: 0 })).toContain('索引未改动')
    expect(rescanNoticeOf({ aborted: 'mass-delete', scanned: 3 })).toContain('索引未改动')
    expect(rescanNoticeOf({ aborted: 'mass-delete', scanned: 3 })).not.toContain('已刷新')
  })
})

describe('normalizeMenuItems / 选择器常量', () => {
  it('去掉首尾与连续分隔线', () => {
    const shape = normalizeOf(['separator', 'a', 'separator', 'separator', 'b', 'separator']).map(
      (e) => (e === 'separator' ? 'separator' : e.label)
    )
    expect(shape).toEqual(['a', 'separator', 'b'])
  })

  it('空白处豁免选择器同时覆盖卡片与文件行（值必须是 "1"）', () => {
    expect(MENU_TARGET_SELECTOR).toContain('[data-asset-card="1"]')
    expect(MENU_TARGET_SELECTOR).toContain('[data-file-row="1"]')
  })
})

/** 用假 item 跑一遍 normalize（避免在测试里造 10 个 onClick） */
function normalizeOf(seqLabels: readonly (string | 'separator')[]): ContextMenuItem[] {
  const items: ContextMenuItem[] = seqLabels.map((x) =>
    x === 'separator' ? 'separator' : { label: x, onClick: () => undefined }
  )
  return normalizeMenuItems(items)
}

/* ── 5. 源码守卫（防止后人把接线改坏）──────────────────────────── */

const root = path.resolve(__dirname, '..')

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8')
}

describe('源码守卫 —— 接线不能改回去', () => {
  it('AssetGrid：卡片 / 文件行有标记属性，空白处有 onContextMenu 接线', async () => {
    const src = await read('src/renderer/components/AssetGrid.tsx')
    expect(src).toContain('data-asset-card="1"')
    expect(src).toContain("data-file-row': '1'")
    // 空白处：网格容器与列表容器都挂上了
    expect(src).toContain('onContextMenu={onEmptyContextMenu}')
    expect(src).toContain('MENU_TARGET_SELECTOR')
    // 三张菜单都真的被渲染
    expect(src).toContain('<AssetContextMenu')
    expect(src).toContain('<FileContextMenu')
    expect(src).toContain('<EmptyAreaContextMenu')
  })

  it('AssetContextMenu：导出 props 仍是 { x, y, ids, onClose }（调用点靠它）', async () => {
    const src = await read('src/renderer/components/AssetContextMenu.tsx')
    for (const key of ['x', 'y', 'ids', 'onClose']) {
      expect(src).toMatch(new RegExp(`${key}\\s*:`))
    }
    expect(src).toMatch(/ids:\s*string\[\]/)
    expect(src).toMatch(/onClose:\s*\(\)\s*=>\s*void/)
    // 复用既有弹窗，不新造
    expect(src).toContain("from './CoverPicker'")
    expect(src).toContain("from './CustomRenderDialog'")
    // 菜单项构成不能在组件里重写一遍
    expect(src).toContain('assetMenuItems(')
  })

  it('logic/contextMenu：不 import store（纯函数才能在 node 里测）', async () => {
    const src = await read('src/renderer/logic/contextMenu.ts')
    expect(src).not.toMatch(/from '\.\.\/store'/)
    expect(src).not.toMatch(/from 'react'/)
    expect(src).not.toMatch(/window\.modvault/)
  })

  it('空白处菜单用 forceRescan，并且有"正在扫描"与结果两种 notice', async () => {
    const src = await read('src/renderer/components/EmptyAreaContextMenu.tsx')
    expect(src).toContain('forceRescan')
    expect(src).toContain('正在重新扫描本地库')
    expect(src).toContain('rescanNoticeOf')
  })

  it('文件行菜单用 setCover + openPath + reveal（三个既有 IPC）', async () => {
    const src = await read('src/renderer/components/FileContextMenu.tsx')
    expect(src).toContain('setCover')
    expect(src).toContain('openPath')
    expect(src).toContain('.reveal(')
  })

  it('ContextMenu 外壳：Esc / 点外部关闭、禁用不触发、按量到的高度夹取', async () => {
    const src = await read('src/renderer/components/ContextMenu.tsx')
    expect(src).toContain("role=\"menu\"")
    expect(src).toContain("e.key !== 'Escape'")
    expect(src).toContain("'mousedown'")
    expect(src).toContain('menuPlacement')
    expect(src).toContain('getBoundingClientRect')
    expect(src).toContain('disabled={disabled}')
  })

  /**
   * 「回到顶部」：交互无法在 node 环境验证（没有 DOM / 没有真实滚动），
   * 所以这里只守**接线**——按钮存在、走容器的 `scrollTo`、阈值是 600、
   * 网格/列表与文件视图各挂了一处。行为本身要靠真机走查。
   */
  it('AssetGrid：回到顶部按钮存在（aria-label / 阈值 / scrollTo / 两处挂载）', async () => {
    const src = await read('src/renderer/components/AssetGrid.tsx')
    expect(src).toContain('aria-label="回到顶部"')
    expect(src).toContain('title="回到顶部（滚动超过一屏时出现）"')
    expect(src).toMatch(/BACK_TO_TOP_THRESHOLD\s*=\s*600/)
    // 必须是**容器**的 scrollTo（不是 window / document）
    expect(src).toContain('containerRef.current?.scrollTo({')
    expect(src).toContain("behavior: 'smooth'")
    // 网格/列表一处 + 文件视图一处
    expect((src.match(/<BackToTop/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
