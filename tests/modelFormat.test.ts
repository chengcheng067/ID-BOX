/**
 * 3DMAX（.max）格式支持的**数据面契约**（2026-10 用户需求）：
 *
 * > 「1. 需要增加 3DMAX 格式的模型文件。3DMAX 的文件需要像 SketchUp 文件一样，
 * >    做一个偏向于 3DMAX 的颜色，并在我们的模型卡片上写上"3DS"
 * >  2. 在模型格式上提供一个选项，用于显示 3DMAX 还是 SU。」
 *
 * ⚠️ 2026-10-29 用户改口（本文件的断言已按新口径）：卡片字样要我口述的
 * 小写 `max`（旧的三字母缩写作废），颜色由红棕换成 3ds Max 官方青蓝。
 *
 * 钉住四件事：
 * ① `shared/modelFormat.getModelFormat` 纯函数（格式识别，skp > max 优先级）；
 * ② 徽标文案（skp→SU / max→max）与 AssetGrid 源码守卫（组件在 node 渲染不了，
 *    本仓库惯例见 `tests/filterCaps.test.ts`）；
 * ③ 筛选维度：`Filters.modelFormat` 只对 kind=model 生效、切视图被 sanitize 清掉、
 *    智能集合快照/还原完整、入口可见性走能力表 `capsOfFilter(kind,'modelFormat')`；
 * ④ 文件夹视图排序（max 与 skp 并列第一档）在 `tests/fileView.test.ts` 已覆盖，不重复。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Asset, AssetFile } from '../src/shared/types'
import {
  getModelFormat,
  MODEL_FORMAT_BADGE_LABEL,
  MODEL_FORMAT_NAME,
  MODEL_FORMAT_OPTIONS
} from '../src/shared/modelFormat'
import { KIND_FILTER_CAPS, capsOfFilter } from '../src/shared/classify'
import {
  DEFAULT_FILTERS,
  activeFilterDimensions,
  filtersFromSavedView,
  matchesFilters,
  sanitizeFiltersForKind,
  snapshotFilters,
  type Filters
} from '../src/renderer/logic/filters'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

function f(ext: string, kind: AssetFile['kind'] = 'model'): AssetFile {
  return { rel: `a.${ext}`, name: `a.${ext}`, ext, size: 10, kind }
}

let seq = 0
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
    files: [],
    size: 1024,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 0,
    updatedAt: 0,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...patch
  }
}

function filters(patch: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...patch }
}

// ── ① 格式识别纯函数 ─────────────────────────────────────────────

describe('getModelFormat · 按文件扩展名识别模型格式', () => {
  it('只有 .max → 3DMAX；只有 .skp → SU；都没有 → null', () => {
    expect(getModelFormat([f('max')])).toBe('max')
    expect(getModelFormat([f('skp')])).toBe('skp')
    expect(getModelFormat([f('png', 'texture'), f('json', 'other')])).toBeNull()
    expect(getModelFormat([])).toBeNull()
    expect(getModelFormat(undefined)).toBeNull()
    expect(getModelFormat(null)).toBeNull()
  })

  it('skp > max：双格式包按 SketchUp 对待（与 PRIMARY_MODEL_EXTS 同口径）', () => {
    expect(getModelFormat([f('max'), f('skp')])).toBe('skp')
    expect(getModelFormat([f('skp'), f('max')])).toBe('skp')
  })

  it('扩展名大小写不敏感（历史数据可能没规范化）', () => {
    expect(getModelFormat([{ ext: 'MAX' }])).toBe('max')
    expect(getModelFormat([{ ext: 'SKP' }])).toBe('skp')
  })

  it('fbx/obj 等其它模型格式本批不区分 → null', () => {
    expect(getModelFormat([f('fbx'), f('obj')])).toBeNull()
  })
})

// ── ② 徽标文案与 AssetGrid 源码守卫 ──────────────────────────────

describe('格式徽标 · 文案表与源码守卫', () => {
  it('文案表：skp→SU、max→max（2026-10-29 用户改口「3D Max 的字样换成 max」）', () => {
    expect(MODEL_FORMAT_BADGE_LABEL.skp).toBe('SU')
    expect(MODEL_FORMAT_BADGE_LABEL.max).toBe('max')
    // 筛选下拉的中文口径不跟着改（仍是 3DMAX）
    expect(MODEL_FORMAT_NAME.max).toBe('3DMAX')
  })

  it('筛选选项表：全部 / SU / 3DMAX（单选，含「全部」= null 档）', () => {
    expect(MODEL_FORMAT_OPTIONS.map((o) => o.label)).toEqual(['全部', 'SU', '3DMAX'])
    expect(MODEL_FORMAT_OPTIONS.map((o) => o.value)).toEqual([null, 'skp', 'max'])
  })

  it('AssetGrid 源码守卫：max 占位图标 + 双格式徽标 + .max 文件封面', () => {
    const grid = read('src/renderer/components/AssetGrid.tsx')
    // 占位图标（无封面兜底要能区分 3DMAX）
    expect(grid).toContain('function Icon3dsMax')
    expect(grid).toContain('is3dsMaxAsset')
    // 卡片格式徽标：kind=model 时按格式出 badge-su / badge-max
    expect(grid).toContain('badge-su')
    expect(grid).toContain('badge-max')
    expect(grid).toContain('MODEL_FORMAT_BADGE_LABEL')
    // 文件视图 .max 强化封面（与 .skp 的大 SU 同族）
    expect(grid).toContain("row.ext.toLowerCase() === 'max'")
    // 占位图标用 3ds Max 青蓝的深一档 #2A7A99（色值写死在图标里，与 IconSketchUp 同做法）
    expect(grid).toContain('#2A7A99')
  })

  it('2026-10-29 改口守卫：源码里不再出现旧的三字母缩写，也不会残留红棕色值', () => {
    const grid = read('src/renderer/components/AssetGrid.tsx')
    // 五处（徽标文案 / 两个 SVG text / rect fill / drop-shadow）一处没改就会命中这里
    expect(grid).not.toContain('3DS')
    // 红棕 #B3453B 与其 rgba(179,69,59) 都必须清掉，否则界面一半红一半青蓝
    expect(grid).not.toContain('#B3453B')
    expect(grid).not.toContain('rgba(179,69,59')
    // 新青蓝的阴影 rgba(42,122,153) 在
    expect(grid).toContain('rgba(42,122,153')
    const modelFormat = read('src/shared/modelFormat.ts')
    expect(modelFormat).not.toContain('3DS')
    const css = read('src/renderer/styles.css')
    expect(css).not.toContain('3DS')
    expect(css).not.toContain('#B3453B')
    const tailwind = read('tailwind.config.js')
    expect(tailwind).not.toContain('3DS')
    expect(tailwind).not.toContain('#B3453B')
  })

  it('CAD 卡片守卫：FileCover 有 row.kind===\'cad\' 分支 + 双主题 token + tailwind 映射', () => {
    const grid = read('src/renderer/components/AssetGrid.tsx')
    // 分支判据（别用 getModelFormat —— 那只认 skp/max）
    expect(grid).toContain("row.kind === 'cad'")
    expect(grid).toContain("row.ext === 'dwg'")
    expect(grid).toContain("row.ext === 'dxf'")
    // 大字 CAD + token 类名（颜色不写死 hex）
    expect(grid).toContain('bg-cad-tint text-cad')
    expect(grid).not.toContain('#E51050')
    const css = read('src/renderer/styles.css')
    // 浅 / 深主题各一档
    expect(css.match(/--brand-cad-bg:/g)?.length).toBe(2)
    expect(css.match(/--brand-cad-text:/g)?.length).toBe(2)
    const tailwind = read('tailwind.config.js')
    expect(tailwind).toContain('--brand-cad-bg')
    expect(tailwind).toContain('--brand-cad-text')
    expect(tailwind).toContain("'cad-tint'")
    expect(tailwind).toContain('cad: token')
  })

  it('styles.css / tailwind 配置守卫：brand token 双主题登记', () => {
    const css = read('src/renderer/styles.css')
    // 浅 / 深主题各一档（:root 与 [data-theme='dark'] 各出现一次）
    expect(css.match(/--brand-max-bg:/g)?.length).toBe(2)
    expect(css.match(/--brand-su-bg:/g)?.length).toBe(2)
    expect(css).toContain('.badge-su')
    expect(css).toContain('.badge-max')
    const tailwind = read('tailwind.config.js')
    expect(tailwind).toContain("--brand-max-bg")
    expect(tailwind).toContain("--brand-su-bg")
  })

  /**
   * 小写字形的字号补偿（2026-10-29 主理人复核后追加，同日定稿为 52）。
   *
   * `max` 全是小写、无上伸部，同字号下视觉高度只有 x-height；`SU` / `CAD` 全大写占
   * cap height。实测（Chromium + 本机字体栈，weight 700，viewBox user unit）：
   *   SU@38 → cap 30 ；CAD@38 → cap 30 ；max@38 → x-height 21（矮 30%，并排一眼看出）
   *   max@52 → x-height 29（与 30 差 1 unit = 3%，静态卡片上看不出）
   * 所以 max 必须用 52，**不能**跟着 SU/CAD 用 38。
   *
   * 52 的代价是宽度溢出（自然宽 109.37 > viewBox 100），用 textLength=96 +
   * spacingAndGlyphs 整体等比压 12% 收回。主理人已明确否决「降字号换取留白」：
   * 48 号只把留白从 2.0 提到 2.4，却要付 10% 的字高，是坏交易。
   */
  it('字号补偿守卫：max 用 52 + textLength 96，SU/CAD 仍用 38', () => {
    const raw = read('src/renderer/components/AssetGrid.tsx')
    // 断言前先剥掉注释：注释里会写「试过 textLength="82"，已否决」这类记录，
    // 那是给人看的，不该让守卫自伤（本仓惯例：守卫看代码，不看注释）
    const grid = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    // FileCover 的 .max 大字号：52 + textLength 压回 viewBox 内
    expect(grid).toContain('fontSize="52"')
    expect(grid).toContain('textLength="96"')
    expect(grid).toContain('lengthAdjust="spacingAndGlyphs"')
    // 两个属性必须同时出现且顺序正确（少了 textLength 就是两边裁字）
    expect(grid.indexOf('fontSize="52"')).toBeLessThan(grid.indexOf('textLength="96"'))
    // `spacingOnly` 不是合法 SVG 值（会被静默当成 spacing，字母重叠 -14.77）
    expect(grid).not.toMatch(/lengthAdjust="spacingOnly"/)
    // 大写字形保持 38（别把 SU/CAD 一起提到 52 —— 那会让它们顶出边界）
    expect(grid.match(/fontSize="38"/g)?.length).toBeGreaterThanOrEqual(2)
    // 占位图标里的小 max 同样按比例补：14 而非 SU 的 10.5
    expect(grid).toContain('fontSize="14"')
    expect(grid).toContain('fontSize="10.5"')
  })
})

// ── ③ 筛选维度 ──────────────────────────────────────────────────

describe('模型格式筛选 · 匹配 / 归一化 / 快照 / 入口', () => {
  it('max 档只放行含 .max 的模型资产；skp 档反之', () => {
    const maxAsset = asset({ files: [f('max')] })
    const skpAsset = asset({ files: [f('skp')] })
    expect(matchesFilters(maxAsset, filters({ modelFormat: 'max' }))).toBe(true)
    expect(matchesFilters(maxAsset, filters({ modelFormat: 'skp' }))).toBe(false)
    expect(matchesFilters(skpAsset, filters({ modelFormat: 'skp' }))).toBe(true)
    expect(matchesFilters(skpAsset, filters({ modelFormat: 'max' }))).toBe(false)
    // 双格式包：skp 优先 → 只算 SU
    const both = asset({ files: [f('max'), f('skp')] })
    expect(matchesFilters(both, filters({ modelFormat: 'skp' }))).toBe(true)
    expect(matchesFilters(both, filters({ modelFormat: 'max' }))).toBe(false)
  })

  it('只对 kind=model 的资产生效：贴图 / HDR 不受模型格式条件约束', () => {
    const texture = asset({ kind: 'texture', files: [f('png', 'texture')] })
    expect(matchesFilters(texture, filters({ modelFormat: 'max' }))).toBe(true)
    expect(matchesFilters(texture, filters({ modelFormat: 'skp' }))).toBe(true)
  })

  it('判不出格式的模型资产不进任何格式档（与分辨率"未知不进档"同一口径）', () => {
    const fbx = asset({ files: [f('fbx')] })
    expect(matchesFilters(fbx, filters({ modelFormat: 'max' }))).toBe(false)
    expect(matchesFilters(fbx, filters({ modelFormat: 'skp' }))).toBe(false)
    expect(matchesFilters(fbx, filters({ modelFormat: null }))).toBe(true)
  })

  it('切到材质 / HDR / 其他视图：modelFormat 被 sanitize 清掉；模型视图保留', () => {
    expect(sanitizeFiltersForKind(filters({ kind: 'model', modelFormat: 'max' })).modelFormat).toBe('max')
    for (const kind of ['texture', 'material', 'materialGroup', 'hdri', 'other'] as const) {
      expect(sanitizeFiltersForKind(filters({ kind, modelFormat: 'max' })).modelFormat).toBeNull()
    }
  })

  it('能力表：只有 model 视图开放模型格式维度（材质 / HDR / 其他不显示入口）', () => {
    expect(capsOfFilter('model', 'modelFormat')).toBe(true)
    for (const kind of ['texture', 'material', 'hdri', 'other'] as const) {
      expect(capsOfFilter(kind, 'modelFormat')).toBe(false)
    }
    // 「全部」取并集 = true：格式条件只约束模型资产，在全部视图筛 3DMAX 仍能看到其它大类
    expect(capsOfFilter('all', 'modelFormat')).toBe(true)
    expect(Object.values(KIND_FILTER_CAPS).every((c) => 'modelFormat' in c)).toBe(true)
  })

  it('智能集合快照 / 还原：合法值往返、非法值丢弃', () => {
    const snap = snapshotFilters(filters({ modelFormat: 'max' }))
    expect(snap.modelFormat).toBe('max')
    expect(
      filtersFromSavedView({ filters: snap }).modelFormat
    ).toBe('max')
    // 非法值（脏数据 / 旧档）→ null
    expect(
      filtersFromSavedView({ filters: { modelFormat: 'fbx' } }).modelFormat
    ).toBeNull()
    expect(
      filtersFromSavedView({ filters: { modelFormat: 42 } }).modelFormat
    ).toBeNull()
    // 缺键 → 默认 null
    expect(filtersFromSavedView({ filters: {} }).modelFormat).toBeNull()
  })

  it('空态维度摘要：模型格式生效时列出「模型格式」维度', () => {
    const dims = activeFilterDimensions(filters({ modelFormat: 'max' }))
    const hit = dims.find((d) => d.key === 'modelFormat')
    expect(hit?.label).toBe('模型格式')
    // 摘要与卡片徽标**同源**（MODEL_FORMAT_BADGE_LABEL）→ 改口后摘要也显示 max
    expect(hit?.value).toBe('max')
    expect(activeFilterDimensions(filters()).some((d) => d.key === 'modelFormat')).toBe(false)
  })

  it('App.tsx 源码守卫：入口可见性走能力表（禁止硬编码 filters.kind 比较）', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).toContain("capsOfFilter(filters.kind, 'modelFormat')")
    expect(app).toContain('MODEL_FORMAT_OPTIONS')
    expect(app).toContain("toggleExtraPanel('format')")
    // 硬编码大类判断在本仓已被 filterCaps 守卫禁止；这里守格式入口不另开判法
    expect(app).not.toMatch(/filters\.kind\s*(?:===|!==)\s*'model'/)
  })
})
