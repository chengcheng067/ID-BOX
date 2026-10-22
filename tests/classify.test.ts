import { describe, expect, it } from 'vitest'
import {
  kindOfExt,
  primaryKind,
  pickCover,
  pickPrimaryFile,
  KIND_LABEL,
  KIND_FOLDER,
  KIND_NAV_ORDER,
  MATERIAL_GROUP,
  KIND_GROUP_MEMBERS,
  kindFolder,
  kindFromFolderName,
  isKindFolderName,
  kindsOfFilter,
  kindFilterLabel
} from '../src/shared/classify'
import type { AssetFile, AssetKind } from '../src/shared/types'

function f(rel: string, ext: string, size = 1): AssetFile {
  return { rel, name: rel.split('/').pop()!, ext, size, kind: kindOfExt(ext) }
}

describe('kindOfExt', () => {
  it('映射常见模型格式', () => {
    expect(kindOfExt('skp')).toBe('model')
    expect(kindOfExt('3ds')).toBe('model')
    expect(kindOfExt('max')).toBe('model')
    expect(kindOfExt('fbx')).toBe('model')
    expect(kindOfExt('blend')).toBe('model')
  })

  it('映射贴图与 HDRI', () => {
    expect(kindOfExt('png')).toBe('texture')
    expect(kindOfExt('JPG')).toBe('texture') // 大小写不敏感
    expect(kindOfExt('tga')).toBe('texture')
    expect(kindOfExt('hdr')).toBe('hdri')
    expect(kindOfExt('exr')).toBe('hdri')
  })

  it('未知扩展名归入其他', () => {
    expect(kindOfExt('pdf')).toBe('other')
    expect(kindOfExt('')).toBe('other')
  })

  it('【裁定 06 §6】dwg/dxf 维持归 model，不改「其他」——防止未来被"顺手修正"', () => {
    // 理由：「其他」是垃圾桶不是第四个大类；kind 的真实语义是"用什么软件打开、怎么取出去"，
    // DWG 与模型资产同构（独占文件夹、有配套引用、要拖进 CAD/天正）。
    // 扩建触发条件：库内 dwg/dxf 类资产 > 30 个，或用户主动提出一次。
    expect(kindOfExt('dwg')).toBe('model')
    expect(kindOfExt('dxf')).toBe('model')
  })
})

describe('primaryKind', () => {
  it('同时有 skp 和贴图时判为模型', () => {
    expect(primaryKind([f('a.skp', 'skp'), f('b.png', 'png')])).toBe('model')
  })

  it('只有图片时判为贴图', () => {
    expect(primaryKind([f('a.png', 'png'), f('b.jpg', 'jpg')])).toBe('texture')
  })

  it('只有 HDRI 时判为 HDRI', () => {
    expect(primaryKind([f('a.exr', 'exr')])).toBe('hdri')
  })

  it('空列表判为其他', () => {
    expect(primaryKind([])).toBe('other')
  })
})

describe('pickCover', () => {
  it('根目录层名字命中预览词 → named', () => {
    const pick = pickCover([
      f('01.jpg', 'jpg'),
      f('预览图.jpg', 'jpg'),
      f('model.skp', 'skp')
    ])
    expect(pick).toEqual({ rel: '预览图.jpg', source: 'named' })
  })

  it('根目录层没命中预览词 → 根目录首图（root）', () => {
    const pick = pickCover([f('b.jpg', 'jpg'), f('a.png', 'png'), f('model.skp', 'skp')])
    expect(pick?.source).toBe('root')
    expect(pick?.rel).toBe('a.png')
  })

  it('图片只在子目录里 → 最大图（largest）', () => {
    const pick = pickCover([
      f('Textures/small.jpg', 'jpg', 100),
      f('Textures/big.jpg', 'jpg', 9999),
      f('model.skp', 'skp')
    ])
    expect(pick).toEqual({ rel: 'Textures/big.jpg', source: 'largest' })
  })

  it('Textures/ 里的预览图不算 named（必须根目录层）', () => {
    const pick = pickCover([f('Textures/预览图.jpg', 'jpg', 10), f('root.jpg', 'jpg', 1)])
    expect(pick?.source).toBe('root')
    expect(pick?.rel).toBe('root.jpg')
  })

  it('内嵌缩略图作为第三级回退（P1 预留）', () => {
    const pick = pickCover([f('Textures/a.jpg', 'jpg', 10)], { embeddedThumbRel: 'Textures/a.jpg' })
    expect(pick?.source).toBe('embedded')
  })

  it('纯模型包没有封面 → null（placeholder）', () => {
    expect(pickCover([f('model.skp', 'skp')])).toBeNull()
  })
})

describe('pickPrimaryFile', () => {
  it('skp 优先于 max', () => {
    expect(pickPrimaryFile([f('a.max', 'max'), f('b.skp', 'skp')])?.rel).toBe('b.skp')
  })

  it('按 skp > max > fbx > obj > 3ds 排序', () => {
    expect(pickPrimaryFile([f('a.3ds', '3ds'), f('b.fbx', 'fbx')])?.rel).toBe('b.fbx')
  })

  it('无主模型时退回首个模型文件', () => {
    expect(pickPrimaryFile([f('a.png', 'png'), f('b.blend', 'blend')])?.rel).toBe('b.blend')
  })

  it('空列表返回 undefined', () => {
    expect(pickPrimaryFile([])).toBeUndefined()
  })
})

describe('kindFolder / KIND_LABEL —— 显示名与目录名解耦（docs/14 §2.1）', () => {
  it('非合并类大类的文件夹名仍等于显示名', () => {
    expect(kindFolder('model')).toBe('模型')
    expect(KIND_LABEL.hdri).toBe('HDRI')
    expect(kindFolder('hdri')).toBe('HDRI')
    expect(kindFolder('other')).toBe('其他')
  })

  it('★配对守卫：texture 落盘「材质」，但显示名仍是「贴图」', () => {
    expect(kindFolder('texture')).toBe('材质')
    expect(KIND_LABEL.texture).toBe('贴图')
    // 二者必须不同——这是"解耦"这件事本身的守卫，未来被"顺手改回去"会立刻变红
    expect(kindFolder('texture')).not.toBe(KIND_LABEL.texture)
  })

  it('★配对守卫：material 落盘「材质」，但显示名仍是「材质预设」', () => {
    expect(kindFolder('material')).toBe('材质')
    expect(KIND_LABEL.material).toBe('材质预设')
    expect(kindFolder('material')).not.toBe(KIND_LABEL.material)
  })

  it('两个材质类共用同一个大类目录（kind 降级为属性维度）', () => {
    expect(kindFolder('texture')).toBe(kindFolder('material'))
  })

  it('kindFolder 对未知 kind 返回空串（保留 truthiness 守卫语义）', () => {
    expect(kindFolder('nope' as AssetKind)).toBe('')
  })

  it('kindFromFolderName：新目录名可唯一反解', () => {
    expect(kindFromFolderName('模型')).toBe('model')
    expect(kindFromFolderName('HDRI')).toBe('hdri')
    expect(kindFromFolderName('其他')).toBe('other')
  })

  it('kindFromFolderName：「材质」有歧义 → null（由调用方按内容兜底，禁止启发式）', () => {
    expect(kindFromFolderName('材质')).toBeNull()
  })

  it('kindFromFolderName：历史别名仍可反解（旧库兼容）', () => {
    expect(kindFromFolderName('贴图')).toBe('texture')
    expect(kindFromFolderName('材质预设')).toBe('material')
  })

  it('kindFromFolderName：未知名 → other（与合并前的反查行为一致）', () => {
    expect(kindFromFolderName('随便一个目录')).toBe('other')
    expect(kindFromFolderName('')).toBe('other')
  })

  it('isKindFolderName：接受 4 个现行目录名 + 2 个历史别名', () => {
    for (const v of ['模型', '材质', 'HDRI', '其他', '贴图', '材质预设']) {
      expect(isKindFolderName(v)).toBe(true)
    }
  })

  it('isKindFolderName：拒绝近似值 / 拼接值 / 空值', () => {
    for (const v of ['模型 ', '贴图材质', '材质预设+', '', 'material', 'texture']) {
      expect(isKindFolderName(v)).toBe(false)
    }
  })

  it('KIND_FOLDER 全表可遍历且无空值（落盘路径不会拼出空段）', () => {
    for (const [kind, folder] of Object.entries(KIND_FOLDER)) {
      expect(folder.length).toBeGreaterThan(0)
      expect(kind.length).toBeGreaterThan(0)
    }
  })
})

describe('侧栏导航序 + 筛选分组哨兵（docs/14 §2.4）', () => {
  it('KIND_NAV_ORDER：材质只出现一次（用 materialGroup 哨兵，不是 texture/material）', () => {
    expect(KIND_NAV_ORDER).toContain(MATERIAL_GROUP)
    expect(KIND_NAV_ORDER).not.toContain('texture')
    expect(KIND_NAV_ORDER).not.toContain('material')
    expect(KIND_NAV_ORDER).toHaveLength(4)
    // HDRI 仍在第 3 位、其他仍在末位（§6.1 的视觉顺序）
    expect(KIND_NAV_ORDER[2]).toBe('hdri')
    expect(KIND_NAV_ORDER[3]).toBe('other')
  })

  it('★分组值不能叫 material（会与 AssetKind.material 静默混淆）', () => {
    expect(MATERIAL_GROUP).toBe('materialGroup')
    expect(MATERIAL_GROUP).not.toBe('material')
  })

  it('KIND_GROUP_MEMBERS：materialGroup = {texture, material}', () => {
    expect([...KIND_GROUP_MEMBERS.materialGroup]).toEqual(['texture', 'material'])
  })

  it('kindsOfFilter：分组 → 两成员；单 kind → 单元素集；all → null', () => {
    expect(kindsOfFilter(MATERIAL_GROUP)).toEqual(new Set(['texture', 'material']))
    expect(kindsOfFilter('material')).toEqual(new Set(['material']))
    expect(kindsOfFilter('texture')).toEqual(new Set(['texture']))
    expect(kindsOfFilter('model')).toEqual(new Set(['model']))
    expect(kindsOfFilter('all')).toBeNull()
  })

  it('kindsOfFilter：对 5 个 AssetKind 逐一与旧语义（单值等值判断）等价', () => {
    const kinds: AssetKind[] = ['model', 'texture', 'hdri', 'material', 'other']
    for (const f of kinds) {
      const set = kindsOfFilter(f)
      expect(set).not.toBeNull()
      for (const a of kinds) {
        expect(set!.has(a)).toBe(a === f)
      }
    }
  })

  it('kindFilterLabel：all→全部；AssetKind→显示名；materialGroup→材质（目录名）', () => {
    expect(kindFilterLabel('all')).toBe('全部')
    expect(kindFilterLabel('texture')).toBe('贴图')
    expect(kindFilterLabel('material')).toBe('材质预设')
    expect(kindFilterLabel(MATERIAL_GROUP)).toBe('材质')
  })
})
