/**
 * T5 · 插件卡片显示口径（用户 2026-11-20 最终口径，覆盖 docs/55 早先的 Q-16/Q-17 双指标方案）。
 *
 * 两层覆盖：
 * 1. `deriveDisplayMetric()` 纯函数单测 —— 所有 kind 统一显示主文件大小，
 *    与 kind 无关；缺字段 / 非法 / 0 值一律回退 null（Q-19）；
 * 2. 源码守卫 —— `panel.html` 副标题区只拼 `displayMetric` 与 `categoryPath`，
 *    单行省略 CSS 不动、排序档内部字段保留、`loader.rb` 透传且落位链不碰。
 *
 * vitest 是 `environment: 'node'`（无 jsdom / RTL），UI 只能这样守；行为由纯函数用例兜住。
 * `readSrc()` 范式见 `tests/classifyUiWiring.test.ts:35-37`（换行归一 `\n`）。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import { formatBytes } from '../src/shared/format'
import { buildPluginRecord, deriveDisplayMetric } from '../src/shared/pluginSnapshot'
import type { Asset, AssetFile, AssetKind } from '../src/shared/types'

/** 相对仓库根读源码；CRLF → LF，源码切片才不会因为换行符失配切错区间 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 只剥注释：本仓注释里会写"要防的那段代码"，不剥会误判 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 副标题拼接区：`var meta = categoryPath(...)` 起，到写入 `.card-meta` 节点止 */
function subtitleRegion(html: string): string {
  const start = html.indexOf('var meta = categoryPath(record);')
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf("body.appendChild(make('div', 'card-meta', meta));", start)
  expect(end).toBeGreaterThan(start)
  return stripComments(html.slice(start, end))
}

/** 造一个逐文件 stat 过的文件（w/h 是可选字段，模拟旧索引缺尺寸） */
function f(overrides: Partial<AssetFile> = {}): AssetFile {
  return {
    rel: 'main.png',
    name: 'main.png',
    ext: 'png',
    size: 1024,
    kind: 'texture',
    ...overrides
  }
}

/** `Asset.size` 故意填一个与 files 累加不同的值，用来钉死 R-12「仅主文件体积」 */
function asset(kind: AssetKind, files: AssetFile[]): Asset {
  return {
    id: 't5-0001',
    name: 'T5 样本',
    kind,
    source: '测试',
    folder: 'E:/Lib/测试',
    relFolder: '测试',
    files,
    size: 999_999_999
  } as Asset
}

// ── 纯函数：所有 kind 统一主文件大小 ──────────────────────────────────────────
describe('deriveDisplayMetric：与 kind 无关，恒为主文件大小', () => {
  it('texture / material / hdri / model / cad / d5a / other 同一输入同一结果', () => {
    const primary = f({ size: 1_258_291 })
    const expected = formatBytes(1_258_291) // '1.2 MB'
    // 函数签名不再接收 kind；这里走 buildPluginRecord 全链路证明各资产大类一致
    for (const kind of ['texture', 'material', 'hdri', 'model', 'cad', 'd5a', 'other'] as const) {
      expect(buildPluginRecord(asset(kind, [primary])).displayMetric).toBe(expected)
    }
    expect(deriveDisplayMetric(primary)).toBe(expected)
  })

  it('副标题实例：贴图与模型都在分类路径后拼主文件大小', () => {
    const tex = buildPluginRecord(asset('texture', [f({ rel: 'main.png', size: 3_355_443 })]))
    const mdl = buildPluginRecord(asset('model', [
      f({ rel: 'sofa.skp', ext: 'skp', kind: 'model', size: 4_194_304 })
    ]))
    // 模拟 panel.html 的 categoryPath 前缀拼接（分类路径原样保留）
    expect('家具 / 沙发 · ' + tex.displayMetric).toBe('家具 / 沙发 · 3.2 MB')
    expect('家具 / 沙发 · ' + mdl.displayMetric).toBe('家具 / 沙发 · 4.0 MB')
  })

  it('小于 1 KB 走 B 档（formatBytes 现成格式）', () => {
    expect(deriveDisplayMetric(f({ size: 512 }))).toBe('512 B')
  })
})

// ── 纯函数：回退（Q-19）──────────────────────────────────────────────────────
describe('deriveDisplayMetric：缺字段 / 非法 / 0 值一律回退 null（Q-19）', () => {
  it('primary 缺失（空 files）→ null', () => {
    expect(deriveDisplayMetric(undefined)).toBe(null)
  })

  it('Q-16 作废：w/h 不再参与派生，即使 w/h 非法也只看 size', () => {
    expect(deriveDisplayMetric(f({ size: 1024, w: Number.NaN, h: -1 }))).toBe('1.0 KB')
    expect(deriveDisplayMetric(f({ size: 1024 }))).toBe('1.0 KB')
  })

  it('模型 / 贴图共用同一套 size 回退：0 / 负数 / NaN / Infinity / 非数 → null', () => {
    const dirty: AssetFile[] = [
      f({ size: 0 }),
      f({ size: -1 }),
      f({ size: Number.NaN }),
      f({ size: Number.POSITIVE_INFINITY }),
      f({ size: '1024' as never }),
      f({ size: undefined as never })
    ]
    for (const primary of dirty) {
      expect(deriveDisplayMetric(primary)).toBe(null)
    }
  })
})

// ── buildPluginRecord 接线 ───────────────────────────────────────────────────
describe('buildPluginRecord 复用 pickPrimaryFile 派生 displayMetric', () => {
  it('贴图也显主文件大小：mainFile 与 displayMetric 同源，w/h 不再参与（Q-16 作废）', () => {
    const files = [
      f({ rel: 'b.png', size: 800 }),
      f({ rel: 'a.png', size: 1920 })
    ]
    const record = buildPluginRecord(asset('texture', files))
    expect(record.mainFile).toBe('b.png')
    expect(record.displayMetric).toBe('800 B')

    const old = buildPluginRecord(asset('material', [f({ rel: 'old.jpg' })]))
    expect(old.mainFile).toBe('old.jpg')
    expect(old.displayMetric).toBe('1.0 KB') // 旧索引缺 w/h 也照显主文件 size
  })

  it('模型取主模型文件的 size，不是 Asset.size、也不是附件大图（R-12）', () => {
    const files = [
      f({ rel: 'preview.jpg', ext: 'jpg', kind: 'other', size: 5_000_000 }),
      f({ rel: 'm.skp', ext: 'skp', kind: 'model', size: 1536 })
    ]
    const record = buildPluginRecord(asset('model', files))
    expect(record.mainFile).toBe('m.skp')
    expect(record.displayMetric).toBe('1.5 KB') // formatBytes(1536)，而非 Asset.size=999999999
  })

  it('A 级只增：13 旧字段 + 1 新字段 + 4 排序字段，files 仍只有 rel/ext 两键', () => {
    const record = buildPluginRecord(asset('model', [f({ rel: 'm.skp', ext: 'skp', size: 512 })]))
    expect(Object.keys(record)).toEqual([
      'id', 'name', 'kind', 'category1', 'category2', 'source', 'zhimoId', 'relFolder',
      'mainFile', 'files', 'thumbRel', 'suMajor', 'updatedAt', 'displayMetric',
      'size', 'importedAt', 'lastUsedAt', 'useCount'
    ])
    expect(Object.keys(record.files[0])).toEqual(['rel', 'ext'])
  })
})

// ── 源码守卫：副标题、CSS、排序档、Ruby 透传 ──────────────────────────────────
describe('源码守卫：panel.html / loader.rb', () => {
  const html = readSrc('plugin-src/idbox_panel/panel.html')

  it('副标题区含 displayMetric + categoryPath，且无旧拼接 / 旧文案', () => {
    const code = subtitleRegion(html)
    expect(code).toContain('categoryPath(record)')
    expect(code).toContain('displayMetric')
    expect(code).toContain("meta += ' · ' + metric")
    expect(code).not.toContain('个文件')
    expect(code).not.toContain('Number(record.fileCount)')
    // Q-19：非法字面量在插件侧再挡一道，根因 guard 仍在主进程
    expect(code).toContain("metric === 'NaN'")
    expect(code).toContain("metric === 'undefined'")
    expect(code).toContain("metric === '-'")
    // 整份 panel.html 的副标题文案不再出现「个文件」字样（排序档的「按文件数」不是它）
    expect(stripComments(html)).not.toContain(' 个文件')
    expect(html).not.toContain(" + ' 个文件'")
  })

  it('Q-16 作废守卫：deriveDisplayMetric 不接收 kind，函数体无 w×h 分支', () => {
    const src = stripComments(readSrc('src/shared/pluginSnapshot.ts'))
    const start = src.indexOf('export function deriveDisplayMetric(')
    const end = src.indexOf('export function buildPluginRecord(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const fn = src.slice(start, end)
    expect(fn).toContain('primary: AssetFile | undefined')
    expect(fn).not.toContain('kind: AssetKind')
    expect(fn).not.toContain('w×h')
    expect(fn).toContain('formatBytes(size)')
  })

  it('单行省略 CSS（.card-meta）逐字不动', () => {
    const line = html.split('\n').find((l) => l.trim().startsWith('.card-meta {'))
    expect(line).toBeDefined()
    expect(line).toContain('overflow: hidden;')
    expect(line).toContain('text-overflow: ellipsis;')
    expect(line).toContain('white-space: nowrap;')
  })

  it('排序档「按文件数」内部实现保留（docs/55 §3-C；T-SORT 后为 8 键新形态）', () => {
    // T-SORT（2026-11-26）把 4 键循环 chip 改成对齐主程序的 8 键下拉 + 方向按钮，
    // 但「按文件数」这一插件既有能力必须保留（守卫的真实意图）→ 断言更新到新字面。
    expect(html).toContain(
      "var SORT_KEYS = ['lastUsed', 'mostUsed', 'recent', 'name', 'size', 'su', 'category1', 'fileCount'];"
    )
    expect(html).toContain("fileCount: '按文件数'")
    expect(html).toContain('if (key === \'fileCount\')')
    expect(html).toContain('numOf(a.fileCount) - numOf(b.fileCount)')
  })

  it('loader.rb 透传 displayMetric，保留 fileCount，落位链 / A8 不动', () => {
    const loader = readSrc('plugin-src/idbox_panel/lib/loader.rb')
    const start = loader.indexOf('def normalize_record(raw_record)')
    const end = loader.indexOf('def display_name(name, main_file, id)', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const normalize = loader.slice(start, end)
    expect(normalize).toContain("'displayMetric' => Support.nil_text(raw_record['displayMetric'])")
    expect(normalize).toContain("'fileCount' => raw_record['files'].is_a?(Array)")
    // 落位链（Inserter#insert）：原样保留，不因显示改动引入回归
    expect(loader).toContain('def insert(record, manifest)')
    expect(loader).toContain('model.start_operation(OP_NAME, true)')
    expect(loader).toContain('model.commit_operation')
    expect(loader).toContain('Paths.within_root?(library_root, absolute)')
  })

  it('插件铁律：副标题改动未引入网络 / 外链 / 原生调用', () => {
    const code = subtitleRegion(html)
    for (const banned of ['fetch(', 'http://', 'https://', 'sketchup.', 'require(']) {
      expect(code, banned).not.toContain(banned)
    }
  })
})
