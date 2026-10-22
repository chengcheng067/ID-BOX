/**
 * PBR 材质包识别 + AmbientCG 元数据解析单测（2026-10 装机反馈，任务 4）。
 *
 * 样本 B（已核实）：Crystal/AmbientCG 材质包 `Brick_Rough_vh1sbjl_2K_surface_ms.zip`：
 *   vh1sbjl_2K_{Albedo,AO,Normal,Roughness,Displacement.jpg,Displacement.exr}
 *   + vh1sbjl_2K.json + Brick_Rough_vh1sbjl_surface_Preview.png
 * 裁定：同前缀 PBR 槽位齐全 → material 大类（优先级高于 hdri/texture）。
 */
import { describe, expect, it } from 'vitest'
import { detectMaterialPack, kindOfExt, primaryKind } from '../src/shared/classify'
import { parseMaterialMetaJson, parseMaterialMetaJsonText } from '../src/main/materialMeta'
import type { AssetFile } from '../src/shared/types'

function f(rel: string, size = 1): AssetFile {
  const name = rel.split('/').pop()!
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { rel, name, ext, size, kind: kindOfExt(ext) }
}

/** 样本 B 的 8 个文件（扁平结构） */
function sampleBFiles(): AssetFile[] {
  return [
    f('vh1sbjl_2K_Albedo.jpg'),
    f('vh1sbjl_2K_AO.jpg'),
    f('vh1sbjl_2K_Normal.jpg'),
    f('vh1sbjl_2K_Roughness.jpg'),
    f('vh1sbjl_2K_Displacement.jpg'),
    f('vh1sbjl_2K_Displacement.exr'),
    f('vh1sbjl_2K.json'),
    f('Brick_Rough_vh1sbjl_surface_Preview.png')
  ]
}

/** 样本 B 的 AmbientCG 元数据 json（实测结构片段） */
const SAMPLE_B_JSON = {
  semanticTags: {
    name: 'Square Floor Tiles',
    contains: ['Tiles', 'Floor Tiles'],
    theme: ['Interior'],
    descriptive: ['Square', 'Ceramic'],
    color: ['White', 'Beige'],
    country: ['Italy'],
    region: ['Europe']
  }
}

describe('detectMaterialPack', () => {
  it('样本 B（含 .exr）→ 命中，前缀 vh1sbjl_2k', () => {
    expect(detectMaterialPack(sampleBFiles())).toBe('vh1sbjl_2k')
  })

  it('BaseColor 写法同样识别（ Substance 风格命名）', () => {
    const files = [f('wall_BaseColor.png'), f('wall_Normal.png'), f('wall_Roughness.png')]
    expect(detectMaterialPack(files)).toBe('wall')
  })

  it('base-color / base color 连接符变体', () => {
    // base-color 位于文件名开头 → 前缀为空，组键只剩目录 'a/'
    expect(
      detectMaterialPack([f('a/base-color.png'), f('a/Normal.png'), f('a/Roughness.png')])
    ).toBe('a/')
    expect(
      detectMaterialPack([f('base color.png'), f('normal.png'), f('roughness.png')])
    ).toBe('')
  })

  it('普通贴图文件夹（无 PBR 槽位）→ null', () => {
    const files = [f('a.png'), f('b.jpg'), f('预览图.png'), f('木纹.jpg')]
    expect(detectMaterialPack(files)).toBeNull()
  })

  it('只有单张 exr → null（仍走 hdri）', () => {
    expect(detectMaterialPack([f('sky.exr')])).toBeNull()
  })

  it('槽位不齐（缺 Roughness）→ null', () => {
    expect(detectMaterialPack([f('x_Albedo.jpg'), f('x_Normal.jpg')])).toBeNull()
  })

  it('跨目录散装槽位不并组（Wood/Albedo + Metal/Normal + Cloth/Roughness → null）', () => {
    const files = [f('Wood/Albedo.png'), f('Metal/Normal.png'), f('Cloth/Roughness.png')]
    expect(detectMaterialPack(files)).toBeNull()
  })

  it('同目录不同前缀不并组', () => {
    const files = [f('t/a_Albedo.png'), f('t/a_Normal.png'), f('t/b_Roughness.png')]
    expect(detectMaterialPack(files)).toBeNull()
  })

  it('同目录同前缀跨子目录层级一致时命中', () => {
    const files = [
      f('maps/vh1sbjl_2K_Albedo.jpg'),
      f('maps/vh1sbjl_2K_Normal.jpg'),
      f('maps/vh1sbjl_2K_Roughness.jpg')
    ]
    expect(detectMaterialPack(files)).toBe('maps/vh1sbjl_2k')
  })

  it('非图片文件不参与槽位分组', () => {
    // json/preview 不是槽位文件；三个槽位缺一个就不算
    const files = [f('p_Albedo.jpg'), f('p_Normal.jpg'), f('p.json'), f('p_Preview.png')]
    expect(detectMaterialPack(files)).toBeNull()
  })
})

describe('primaryKind — 材质包裁定（2026-10）', () => {
  it('样本 B → material（不再落 HDRI 大类）', () => {
    expect(primaryKind(sampleBFiles())).toBe('material')
  })

  it('普通贴图文件夹 → 仍 texture', () => {
    expect(primaryKind([f('a.png'), f('b.jpg')])).toBe('texture')
  })

  it('只有单张 exr → 仍 hdri', () => {
    expect(primaryKind([f('sky.exr')])).toBe('hdri')
  })

  it('model 优先级仍高于材质包（带 skp 的包是模型）', () => {
    const files = [...sampleBFiles(), f('模型.skp')]
    expect(primaryKind(files)).toBe('model')
  })

  it('既有语义不回归：skp+贴图 → model；空列表 → other', () => {
    expect(primaryKind([f('a.skp'), f('b.png')])).toBe('model')
    expect(primaryKind([])).toBe('other')
  })
})

describe('parseMaterialMetaJson — AmbientCG 元数据', () => {
  it('样本 B 实测结构 → name + 合并 tags + color', () => {
    const r = parseMaterialMetaJson(SAMPLE_B_JSON)!
    expect(r).not.toBeNull()
    expect(r.name).toBe('Square Floor Tiles')
    // contains + theme + descriptive + country + region，保序去重
    expect(r.tags).toEqual([
      'Tiles',
      'Floor Tiles',
      'Interior',
      'Square',
      'Ceramic',
      'Italy',
      'Europe'
    ])
    expect(r.color).toEqual(['White', 'Beige'])
  })

  it('tags 去重且 color 不进 tags', () => {
    const r = parseMaterialMetaJson({
      semanticTags: { name: 'X', contains: ['A', 'A', 'B'], color: ['Red'] }
    })!
    expect(r.tags).toEqual(['A', 'B'])
    expect(r.color).toEqual(['Red'])
  })

  it('字段类型不对时按缺失处理（数组里混非字符串）', () => {
    const r = parseMaterialMetaJson({
      semanticTags: { name: 123, contains: ['A', 1, null, 'B'], theme: 'not-array' }
    })!
    expect(r.name).toBeUndefined()
    expect(r.tags).toEqual(['A', 'B'])
  })

  it('semanticTags 缺失 → null', () => {
    expect(parseMaterialMetaJson({})).toBeNull()
    expect(parseMaterialMetaJson({ semanticTags: 'nope' })).toBeNull()
  })

  it('三大字段全空 → null（没有可用元数据）', () => {
    expect(parseMaterialMetaJson({ semanticTags: {} })).toBeNull()
    expect(parseMaterialMetaJson({ semanticTags: { name: '  ', contains: [1, 2] } })).toBeNull()
  })

  it('非对象入参 → null（绝不抛）', () => {
    expect(parseMaterialMetaJson(null)).toBeNull()
    expect(parseMaterialMetaJson(undefined)).toBeNull()
    expect(parseMaterialMetaJson('str')).toBeNull()
    expect(parseMaterialMetaJson([1, 2])).toBeNull()
  })
})

describe('parseMaterialMetaJsonText', () => {
  it('合法 JSON 文本 → 解析结果', () => {
    const r = parseMaterialMetaJsonText(JSON.stringify(SAMPLE_B_JSON))!
    expect(r.name).toBe('Square Floor Tiles')
  })

  it('损坏 JSON → null 不抛', () => {
    expect(parseMaterialMetaJsonText('{ not json')).toBeNull()
    expect(parseMaterialMetaJsonText('')).toBeNull()
  })
})
