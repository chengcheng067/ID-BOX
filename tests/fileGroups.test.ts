/**
 * 详情面板「文件按 PBR 槽位分组」单测（被测对象：`src/renderer/logic/fileGroups.ts`）。
 *
 * 样本 B 即用户真实样本（Crystal 材质包 8 文件，见 tests/materialBall.test.ts）。
 * 需求书 §3.2 拍板：槽位组 → 元数据(json) → 预览 → 其他；未识别的不丢弃。
 */
import { describe, expect, it } from 'vitest'
import type { AssetFile } from '../src/shared/types'
import { FILE_GROUP_LABEL, groupFilesBySlot } from '../src/renderer/logic/fileGroups'

function file(rel: string, ext: string, kind: AssetFile['kind'] = 'texture'): AssetFile {
  const name = rel.split('/').pop() ?? rel
  return { rel, name, ext: ext.toLowerCase(), size: 1024, kind }
}

/** 用户样本 B：Crystal 材质包 8 文件（保持包内枚举序） */
function sampleB(): AssetFile[] {
  return [
    file('vh1sbjl_2K_Albedo.jpg', 'jpg'),
    file('vh1sbjl_2K_AO.jpg', 'jpg'),
    file('vh1sbjl_2K_Normal.jpg', 'jpg'),
    file('vh1sbjl_2K_Roughness.jpg', 'jpg'),
    file('vh1sbjl_2K_Displacement.jpg', 'jpg'),
    file('vh1sbjl_2K_Displacement.exr', 'exr', 'hdri'),
    file('vh1sbjl_2K.json', 'json', 'other'),
    file('Brick_Rough_vh1sbjl_surface_Preview.png', 'png')
  ]
}

describe('logic/fileGroups · 用户样本 B 分组', () => {
  it('五个槽位 + 元数据 + 预览七组齐全，顺序符合需求书 §3.2', () => {
    const groups = groupFilesBySlot(sampleB())
    expect(groups.map((g) => g.key)).toEqual([
      'albedo',
      'normal',
      'roughness',
      'ao',
      'displacement',
      'metadata',
      'preview'
    ])
  })

  it('每组文件落位正确；置换组同时收 jpg 与 exr', () => {
    const groups = groupFilesBySlot(sampleB())
    const byKey = new Map(groups.map((g) => [g.key, g]))
    expect(byKey.get('albedo')!.files.map((f) => f.name)).toEqual(['vh1sbjl_2K_Albedo.jpg'])
    expect(byKey.get('normal')!.files.map((f) => f.name)).toEqual(['vh1sbjl_2K_Normal.jpg'])
    expect(byKey.get('roughness')!.files.map((f) => f.name)).toEqual(['vh1sbjl_2K_Roughness.jpg'])
    expect(byKey.get('ao')!.files.map((f) => f.name)).toEqual(['vh1sbjl_2K_AO.jpg'])
    expect(byKey.get('displacement')!.files.map((f) => f.name)).toEqual([
      'vh1sbjl_2K_Displacement.jpg',
      'vh1sbjl_2K_Displacement.exr'
    ])
    expect(byKey.get('metadata')!.files.map((f) => f.name)).toEqual(['vh1sbjl_2K.json'])
    expect(byKey.get('preview')!.files.map((f) => f.name)).toEqual([
      'Brick_Rough_vh1sbjl_surface_Preview.png'
    ])
  })

  it('组头文案非空且「其他」组存在定义（标签兜底完整性）', () => {
    for (const key of [
      'albedo',
      'normal',
      'roughness',
      'ao',
      'displacement',
      'metadata',
      'preview',
      'other'
    ] as const) {
      expect(FILE_GROUP_LABEL[key].length).toBeGreaterThan(0)
    }
    expect(FILE_GROUP_LABEL.normal).toContain('法线')
    expect(FILE_GROUP_LABEL.ao).toContain('AO')
  })
})

describe('logic/fileGroups · 预览词优先于槽位词', () => {
  it('Brick_Rough_…_Preview.png 进预览组，不因 rough 被误判成粗糙度贴图', () => {
    const groups = groupFilesBySlot([file('Brick_Rough_Preview.png', 'png')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('preview')
  })

  it('中文预览词同样命中：材质预览图.jpg → 预览组', () => {
    const groups = groupFilesBySlot([file('木纹_材质预览图.jpg', 'jpg')])
    expect(groups[0]!.key).toBe('preview')
  })
})

describe('logic/fileGroups · 元数据 / 其他 / 边界', () => {
  it('.json 进元数据组（大小写不敏感：.JSON 同样命中）', () => {
    const groups = groupFilesBySlot([file('a.json', 'json', 'other'), file('B.JSON', 'JSON', 'other')])
    expect(groups.map((g) => g.key)).toEqual(['metadata'])
    expect(groups[0]!.files).toHaveLength(2)
  })

  it('识别不进槽位的文件归「其他」组，不丢弃（需求书明确）', () => {
    const files = [
      file('衣柜.skp', 'skp', 'model'),
      file('README.md', 'md', 'other'),
      file('贴图合集.psd', 'psd')
    ]
    const groups = groupFilesBySlot(files)
    expect(groups.map((g) => g.key)).toEqual(['other'])
    expect(groups[0]!.files).toHaveLength(3)
  })

  it('tokenOnly 短词不做子串匹配：Column_Map 不误判 albedo（col 子串）', () => {
    const groups = groupFilesBySlot([file('Column_Map.jpg', 'jpg')])
    expect(groups[0]!.key).toBe('other')
  })

  it('模型/HDRI 等非贴图资产同样可以分组（不按大类短路）', () => {
    const groups = groupFilesBySlot([
      file('水立方.hdri', 'hdr', 'hdri'),
      file('说明.txt', 'txt', 'other'),
      file('封面图.jpg', 'jpg')
    ])
    // 封面图命中预览词；hdri 原样、「说明.txt」均归其他
    expect(groups.map((g) => g.key)).toEqual(['preview', 'other'])
  })

  it('空文件列表 → 空数组', () => {
    expect(groupFilesBySlot([])).toEqual([])
  })

  it('组内顺序保持入参顺序（展示稳定，不重排）', () => {
    const files = [
      file('B_2K_Normal.jpg', 'jpg'),
      file('A_2K_Normal.jpg', 'jpg'),
      file('C_2K_Normal.png', 'png')
    ]
    const groups = groupFilesBySlot(files)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.files.map((f) => f.name)).toEqual([
      'B_2K_Normal.jpg',
      'A_2K_Normal.jpg',
      'C_2K_Normal.png'
    ])
  })

  it('子目录里的槽位贴图按 basename 判组（rel 保留子目录）', () => {
    const groups = groupFilesBySlot([file('Textures/Marble_2K_AO.jpg', 'jpg')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('ao')
    expect(groups[0]!.files[0]!.rel).toBe('Textures/Marble_2K_AO.jpg')
  })

  it('AO 短词与 arm 打包图都进 AO 组（2026-10 第 3 轮追加词表）', () => {
    // vh1sbjl_2K_AO：ao 是 tokenOnly 短词，token 全等口径命中（QA 实测口径）
    expect(groupFilesBySlot([file('vh1sbjl_2K_AO.jpg', 'jpg')])[0]!.key).toBe('ao')
    // PolyHaven arm = AO+Roughness+Metalness 打包图：分组认 AO 语义（packed 标记）
    expect(groupFilesBySlot([file('wood_floor_arm_4k.jpg', 'jpg')])[0]!.key).toBe('ao')
  })
})
