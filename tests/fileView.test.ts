/**
 * 「中栏文件视图」纯逻辑单测（被测对象：`src/renderer/logic/fileView.ts`）。
 *
 * 需求：docs/15 §6c —— 双击卡片进软件内文件夹浏览器，文件行双击用系统默认程序打开。
 * 这些用例只跑 node 环境（模块不 import React / DOM / electron）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { AssetFile } from '../src/shared/types'
import { formatBytes } from '../src/shared/format'
import {
  buildFileRows,
  extLabelOf,
  fileRowKindOf,
  summarizeFiles
} from '../src/renderer/logic/fileView'

function file(rel: string, size = 1024, kind: AssetFile['kind'] = 'other'): AssetFile {
  const name = rel.split('/').pop() ?? rel
  const dot = name.lastIndexOf('.')
  return {
    rel,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    size,
    kind
  }
}

const FOLDER = 'E:\\Lib\\模型\\现代衣柜'

describe('logic/fileView · buildFileRows 基本映射', () => {
  it('字段映射完整，绝对路径按 folder 的路径形态拼接（Windows 反斜杠）', () => {
    const rows = buildFileRows({ folder: FOLDER, files: [file('贴图/木纹 01.jpg', 2048, 'texture')] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rel: '贴图/木纹 01.jpg',
      name: '木纹 01.jpg',
      ext: 'jpg',
      extLabel: 'JPG',
      size: 2048,
      sizeText: '2.0 KB',
      kind: 'image',
      kindLabel: '图片',
      absPath: `${FOLDER}\\贴图\\木纹 01.jpg`,
      isImage: true
    })
  })

  it('posix 夹具目录同样正确拼接（不手写反斜杠）', () => {
    const rows = buildFileRows({ folder: '/lib/model/wardrobe', files: [file('textures/wood.png')] })
    expect(rows[0]!.absPath).toBe('/lib/model/wardrobe/textures/wood.png')
  })

  it('无扩展名的文件 extLabel 为空串（UI 不渲染徽标）', () => {
    const rows = buildFileRows({ folder: FOLDER, files: [file('README')] })
    expect(rows[0]!.ext).toBe('')
    expect(rows[0]!.extLabel).toBe('')
    expect(extLabelOf('skp')).toBe('SKP')
    // 文件名里带多个点时扩展名可能超长 → 截断，避免撑破行
    expect(extLabelOf('verylongextension')).toBe('VERYLO')
  })
})

describe('logic/fileView · 图片 / 模型识别', () => {
  it('jpg / png / webp 判为图片，skp 不是图片', () => {
    expect(fileRowKindOf({ ext: 'jpg', kind: 'texture' })).toBe('image')
    expect(fileRowKindOf({ ext: 'png', kind: 'texture' })).toBe('image')
    expect(fileRowKindOf({ ext: 'webp', kind: 'texture' })).toBe('image')
    expect(fileRowKindOf({ ext: 'skp', kind: 'model' })).toBe('model')
    expect(fileRowKindOf({ ext: 'skp', kind: 'model' }) === 'image').toBe(false)
    // 大写扩展名也要认（历史数据可能没规范化）
    expect(fileRowKindOf({ ext: 'PNG', kind: 'other' })).toBe('image')
  })

  it('kind=model 但扩展名不认识时仍归模型组；json/txt 归其他', () => {
    expect(fileRowKindOf({ ext: 'dae', kind: 'other' })).toBe('model')
    expect(fileRowKindOf({ ext: 'unknownext', kind: 'model' })).toBe('model')
    expect(fileRowKindOf({ ext: 'json', kind: 'other' })).toBe('other')
    expect(fileRowKindOf({ ext: 'txt', kind: 'other' })).toBe('other')
  })
})

describe('logic/fileView · 大小格式化', () => {
  it('每行 sizeText 与 formatBytes 完全一致（不重复实现格式化）', () => {
    const sizes = [0, 1, 999, 1024, 1536, 1024 ** 2 * 3.5]
    const rows = buildFileRows({
      folder: FOLDER,
      files: sizes.map((s, i) => file(`f${i}.bin`, s))
    })
    for (const row of rows) expect(row.sizeText).toBe(formatBytes(row.size))
  })
})

describe('logic/fileView · 空输入', () => {
  it('files 为空数组 → 空行列表（组件渲染空态）', () => {
    expect(buildFileRows({ folder: FOLDER, files: [] })).toEqual([])
    expect(summarizeFiles([])).toEqual({ count: 0, totalBytes: 0, text: '0 个文件 · 0 B' })
  })

  it('files 为 undefined / 非数组时也不炸（防御历史脏数据）', () => {
    expect(buildFileRows({ folder: FOLDER, files: undefined as unknown as AssetFile[] })).toEqual([])
    expect(summarizeFiles(undefined).text).toBe('0 个文件 · 0 B')
  })
})

describe('logic/fileView · 排序', () => {
  /**
   * 2026-10 用户反馈改口径：**模型文件排第一**（原口径是图片优先）。
   * 原话：「SKP 后缀的这一个文件应该排在第一位，而不是 JPG 这些材质排在第一位」。
   * 期望值随之调整，但"组内自然序"的行为必须保持（下面第二条用例钉住）。
   */
  it('分组顺序：模型 → 图片 → 其他；组内自然序（2 在 10 前）', () => {
    const rows = buildFileRows({
      folder: FOLDER,
      files: [
        file('说明.json'),
        file('主模型.skp', 1024, 'model'),
        file('10.jpg'),
        file('贴图/b.png'),
        file('2.jpg')
      ]
    })
    expect(rows.map((r) => r.name)).toEqual([
      '主模型.skp',
      '2.jpg',
      '10.jpg',
      'b.png',
      '说明.json'
    ])
    expect(rows.map((r) => r.kind)).toEqual(['model', 'image', 'image', 'image', 'other'])
  })

  it('典型知末包：.skp 排在 .max 与自动生成的 .preview.jpg 之前（用户第一条反馈的原场景）', () => {
    const rows = buildFileRows({
      folder: FOLDER,
      files: [
        file('衣柜.preview.jpg', 4096),
        file('衣柜.skp', 1024 * 1024 * 8, 'model'),
        file('衣柜.max', 1024 * 1024 * 9, 'model')
      ]
    })
    // 模型组内 .skp 是次级排序键的第一档（用户原话：「SKP 后缀的这一个文件应该排在第一位」）
    expect(rows.map((r) => r.name)).toEqual(['衣柜.skp', '衣柜.max', '衣柜.preview.jpg'])
    expect(rows[0]!.kind).toBe('model')
    expect(rows[0]!.ext).toBe('skp')
    // 断言口径本身：图片不得出现在模型之前
    const firstImage = rows.findIndex((r) => r.kind === 'image')
    const lastModel = rows.map((r) => r.kind).lastIndexOf('model')
    expect(firstImage).toBeGreaterThan(lastModel)
  })

  it('两个 .skp：同扩展名内仍按自然序（次级键没有把顺序写乱）', () => {
    const rows = buildFileRows({
      folder: FOLDER,
      files: [file('b.skp', 10, 'model'), file('a.skp', 20, 'model')]
    })
    expect(rows.map((r) => r.name)).toEqual(['a.skp', 'b.skp'])
  })

  it('反向守卫：图片组顺序完全不受 .skp 次级键影响（仍是自然序）', () => {
    const rows = buildFileRows({
      folder: FOLDER,
      files: [file('b.png'), file('10.jpg'), file('2.jpg'), file('z.skp', 1, 'model')]
    })
    // 模型整组在前；图片组内保持 2 < 10 < b（b.png 不因为"名字靠后"被提到 2.jpg 前面）
    expect(rows.map((r) => r.name)).toEqual(['z.skp', '2.jpg', '10.jpg', 'b.png'])
    expect(rows.slice(1).map((r) => r.ext)).toEqual(['jpg', 'jpg', 'png'])
  })

  it('同名文件按 rel 兜底比较，结果与入参顺序无关（稳定、可复现）', () => {
    const a = [file('b/x.jpg'), file('a/x.jpg')]
    const b = [file('a/x.jpg'), file('b/x.jpg')]
    expect(buildFileRows({ folder: FOLDER, files: a }).map((r) => r.rel)).toEqual(['a/x.jpg', 'b/x.jpg'])
    expect(buildFileRows({ folder: FOLDER, files: b }).map((r) => r.rel)).toEqual(['a/x.jpg', 'b/x.jpg'])
  })

  it('不修改入参数组（纯函数语义：排序作用在新数组上）', () => {
    const files = [file('a.skp', 1024, 'model'), file('b.png')]
    const before = files.map((f) => f.rel)
    buildFileRows({ folder: FOLDER, files })
    expect(files.map((f) => f.rel)).toEqual(before)
  })
})

describe('logic/fileView · summarizeFiles', () => {
  it('合计大小按行累加，文案为「N 个文件 · 合计大小」', () => {
    const s = summarizeFiles([file('a.jpg', 1024), file('b.skp', 1024 * 1024, 'model')])
    expect(s.count).toBe(2)
    expect(s.totalBytes).toBe(1024 + 1024 * 1024)
    expect(s.text).toBe(`2 个文件 · ${formatBytes(1024 + 1024 * 1024)}`)
  })

  it('非法 size（NaN）按 0 计，不污染合计', () => {
    const s = summarizeFiles([file('a.jpg', Number.NaN), file('b.jpg', 2048)])
    expect(s.totalBytes).toBe(2048)
    expect(s.count).toBe(2)
  })
})

// ── 源码守卫：文件卡片里 .skp 的「强化」封面 ────────────────────────────────
// 组件在 node 环境渲染不了（依赖 store / electron），守契约防回退。
describe('源码守卫 · SKP 文件卡片（淡蓝 tint 底板 + 大号 SU）', () => {
  const GRID = fs.readFileSync(new URL('../src/renderer/components/AssetGrid.tsx', import.meta.url), 'utf8')

  it('只对 model + skp 生效（.max/.rvt/.fbx 仍走类型图标）', () => {
    expect(GRID).toContain("row.kind === 'model' && row.ext.toLowerCase() === 'skp'")
  })

  it('底板/字色走 token，字号约封面高度的 38%，粗体、负字距、无描边阴影', () => {
    const at = GRID.indexOf("row.kind === 'model' && row.ext.toLowerCase() === 'skp'")
    const block = GRID.slice(at, GRID.indexOf('const src = fileThumbUrl(asset, row)', at))
    expect(at).toBeGreaterThan(-1)
    expect(block).toContain('bg-accent-tint') // 淡蓝 tint（浅 #E1EFFF / 深 #1E2A38）
    expect(block).toContain('text-accent') // 系统蓝（浅 #007AFF / 深 #0A84FF）
    expect(block).toContain('fontSize="38"') // viewBox 100×100 → 38% 封面高度
    expect(block).toContain('fontWeight="700"')
    expect(block).toContain('letterSpacing="-0.02em"')
    // 不要描边/阴影/斜体：这几个都会让"大 SU"变得脏
    expect(block).not.toContain('stroke')
    expect(block).not.toContain('drop-shadow')
    expect(block).not.toContain('italic')
    // 灰色立方体图标不再渲染（大 SU 已承担识别）
    expect(block).not.toContain('<Icon')
  })
})
