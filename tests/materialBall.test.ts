/**
 * T09 材质球纯逻辑单测（被测对象：`src/renderer/logic/materialBall.ts`）。
 *
 * 样本 B 即用户真实样本（Crystal 材质包，8 文件，见 tests/importerJunk.test.ts
 * 与 docs/04 §样本 B）：`vh1sbjl_2K_{Albedo,AO,Normal,Roughness,Displacement}.jpg`
 * + 同名 `.exr` + `.json` + `Brick_Rough_vh1sbjl_surface_Preview.png`。
 */
import { describe, expect, it } from 'vitest'
import type { AssetFile } from '../src/shared/types'
import { parseThumbFileName } from '../src/shared/thumb'
import {
  ballThumbName,
  dataChannelLabel,
  effectiveMaterialSlots,
  hasMaterialSlots,
  materialSlots,
  slotRelPaths,
  slotUrls
} from '../src/renderer/logic/materialBall'
// golden 锁需要 shared 侧的同一实现做交叉核对（§10：hash 只能有一份实现）
import {
  ballHash,
  ballThumbName as ballThumbNameShared,
  DEFAULT_PARAM_SCALES
} from '../src/shared/ballParams'

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

describe('logic/materialBall · materialSlots（用户样本 B）', () => {
  it('样本 B 的 5 个槽位全部正确识别', () => {
    expect(materialSlots(sampleB())).toEqual({
      albedo: 'vh1sbjl_2K_Albedo.jpg',
      normal: 'vh1sbjl_2K_Normal.jpg',
      roughness: 'vh1sbjl_2K_Roughness.jpg',
      ao: 'vh1sbjl_2K_AO.jpg',
      displacement: 'vh1sbjl_2K_Displacement.jpg'
    })
  })

  it('样本 B：同槽位的 .exr 让位 .jpg（TextureLoader 加载不了 exr）', () => {
    const slots = materialSlots(sampleB())
    expect(slots.displacement).toBe('vh1sbjl_2K_Displacement.jpg')
    expect(slots.displacement).not.toContain('.exr')
  })

  it('样本 B：.json 元数据 / Preview.png 不进槽位；Preview 的 rough 前缀组槽位少不抢标', () => {
    const slots = materialSlots(sampleB())
    // roughness 来自主组（vh1sbjl 前缀，5 槽位），不是 Preview 那张（brick_rough_vh1sbjl_surface 前缀，1 槽位）
    expect(slots.roughness).toBe('vh1sbjl_2K_Roughness.jpg')
    expect(Object.keys(slots)).toHaveLength(5)
  })

  it('嵌套子目录的贴图同样识别（按 basename 匹配，rel 保留子目录）', () => {
    const files = [
      file('Textures/Marble_2K_BaseColor.jpg', 'jpg'),
      file('textures/marble_2k_normal.png', 'png'),
      file('模型.skp', 'skp', 'model')
    ]
    expect(materialSlots(files)).toEqual({
      albedo: 'Textures/Marble_2K_BaseColor.jpg',
      normal: 'textures/marble_2k_normal.png'
    })
  })
})

describe('logic/materialBall · 无槽位 / 非贴图文件', () => {
  it('只有模型 + 预览图 + 说明书 → 空对象', () => {
    const files = [
      file('衣柜.skp', 'skp', 'model'),
      file('预览.jpg', 'jpg'),
      file('知末网说明.txt', 'txt', 'other')
    ]
    expect(materialSlots(files)).toEqual({})
  })

  it('空文件列表 → 空对象', () => {
    expect(materialSlots([])).toEqual({})
  })

  it('图片扩展名白名单：psd/dds/zip 等不参与识别', () => {
    const files = [file('a_2K_BaseColor.psd', 'psd'), file('b_2K_Normal.zip', 'zip')]
    expect(materialSlots(files)).toEqual({})
  })
})

describe('logic/materialBall · 大小写 / 分辨率 / 分词变体', () => {
  it('大小写不敏感：BASECOLOR / basecolor / BaseColor / NORMAL 均命中', () => {
    const files = [
      file('Oak_4K_BASECOLOR.jpg', 'jpg'),
      file('Oak_4K_basecolor.jpg', 'jpg'),
      file('Oak_4K_BaseColor.jpg', 'jpg'),
      file('Oak_4K_NORMAL.jpg', 'jpg')
    ]
    const slots = materialSlots(files)
    expect(slots.albedo).toBeDefined()
    expect(slots.normal).toBe('Oak_4K_NORMAL.jpg')
  })

  it('分辨率标记忽略：_2K / _4K / 无标记 / _8K 都能识别，且同前缀同组', () => {
    const files = [
      file('Wood_2K_Albedo.jpg', 'jpg'),
      file('Wood_4K_Normal.jpg', 'jpg'),
      file('Wood_Roughness.jpg', 'jpg'),
      file('Wood_8K_AO.jpg', 'jpg')
    ]
    expect(materialSlots(files)).toEqual({
      albedo: 'Wood_2K_Albedo.jpg',
      normal: 'Wood_4K_Normal.jpg',
      roughness: 'Wood_Roughness.jpg',
      ao: 'Wood_8K_AO.jpg'
    })
  })

  it('同槽位多文件取高分辨率：4K 胜 2K（与输入序无关）', () => {
    const files = [file('Marble_2K_Albedo.jpg', 'jpg'), file('Marble_4K_Albedo.jpg', 'jpg')]
    expect(materialSlots(files).albedo).toBe('Marble_4K_Albedo.jpg')
    const reordered = [file('Marble_4K_Albedo.jpg', 'jpg'), file('Marble_2K_Albedo.jpg', 'jpg')]
    expect(materialSlots(reordered).albedo).toBe('Marble_4K_Albedo.jpg')
  })

  it('分词变体：Base_Color / Ambient_Occlusion / 空格分隔均命中', () => {
    const files = [
      file('Oak_Base_Color.jpg', 'jpg'),
      file('Oak_Ambient_Occlusion.jpg', 'jpg'),
      file('Oak Height.png', 'png'),
      file('Oak_Rough.jpg', 'jpg')
    ]
    expect(materialSlots(files)).toEqual({
      albedo: 'Oak_Base_Color.jpg',
      ao: 'Oak_Ambient_Occlusion.jpg',
      displacement: 'Oak Height.png',
      roughness: 'Oak_Rough.jpg'
    })
  })

  it('关键词右侧优先：Height_2K_Normal 判 normal 而非 displacement', () => {
    expect(materialSlots([file('Height_2K_Normal.jpg', 'jpg')]).normal).toBe('Height_2K_Normal.jpg')
    expect(materialSlots([file('Height_2K_Normal.jpg', 'jpg')]).displacement).toBeUndefined()
    // 单纯的高度图仍判 displacement
    expect(materialSlots([file('Terrain_Height.jpg', 'jpg')]).displacement).toBe('Terrain_Height.jpg')
  })

  it('关键词是完整 token：MyBaseColorNotes 这类子串不误命中', () => {
    expect(materialSlots([file('MyBaseColorNotes.jpg', 'jpg')])).toEqual({})
  })
})

describe('logic/materialBall · 多前缀选组', () => {
  it('取槽位最全的一组（完整材质组 5 槽位 > 零散单张）', () => {
    const files = [
      file('Loose_Normal.jpg', 'jpg'), // 零散组：1 槽位
      file('Brick_2K_Albedo.jpg', 'jpg'),
      file('Brick_2K_Normal.jpg', 'jpg'),
      file('Brick_2K_Roughness.jpg', 'jpg'),
      file('Brick_2K_AO.jpg', 'jpg'),
      file('Brick_2K_Displacement.jpg', 'jpg')
    ]
    expect(materialSlots(files)).toEqual({
      albedo: 'Brick_2K_Albedo.jpg',
      normal: 'Brick_2K_Normal.jpg',
      roughness: 'Brick_2K_Roughness.jpg',
      ao: 'Brick_2K_AO.jpg',
      displacement: 'Brick_2K_Displacement.jpg'
    })
  })

  it('槽位数并列时取输入序在前的组（确定性）', () => {
    const files = [
      file('A_2K_Albedo.jpg', 'jpg'),
      file('B_2K_Albedo.jpg', 'jpg'),
      file('A_2K_Normal.jpg', 'jpg'),
      file('B_2K_Normal.jpg', 'jpg')
    ]
    expect(materialSlots(files)).toEqual({
      albedo: 'A_2K_Albedo.jpg',
      normal: 'A_2K_Normal.jpg'
    })
  })
})

describe('logic/materialBall · effectiveMaterialSlots（反馈 4：单图兜底当基础色）', () => {
  it('单张 jpg 且认不出槽位 → 第一张图被填成 baseColor（albedo）', () => {
    const files = [file('单图贴图.jpg', 'jpg')]
    // 先确认前提：原识别逻辑确实认不出（否则这条用例测的不是兜底）
    expect(materialSlots(files)).toEqual({})
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: '单图贴图.jpg' })
  })

  it('多图但都认不出槽位 → 只取输入序第一张（确定性，不随机挑）', () => {
    const files = [file('B_Texture.jpg', 'jpg'), file('A_Texture.png', 'png')]
    expect(materialSlots(files)).toEqual({})
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: 'B_Texture.jpg' })
  })

  it('非图片文件被跳过：说明书在前、图片在后 → 取那张图片', () => {
    const files = [
      file('知末网说明.txt', 'txt', 'other'),
      file('素材.json', 'json', 'other'),
      file('实拍.png', 'png')
    ]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: '实拍.png' })
  })

  it('只有 .skp、没有任何图片 → 返回空对象（仍不可渲球）', () => {
    const files = [file('衣柜.skp', 'skp', 'model'), file('说明.txt', 'txt', 'other')]
    expect(effectiveMaterialSlots(files)).toEqual({})
    expect(hasMaterialSlots(effectiveMaterialSlots(files))).toBe(false)
  })

  it('正常 PBR 命名（basecolor / normal）→ 走原识别逻辑，不被"第一张图"兜底覆盖', () => {
    // 故意把 normal 放在第一位：若兜底逻辑误伤，albedo 会变成 Wood_2K_Normal.jpg
    const files = [file('Wood_2K_Normal.jpg', 'jpg'), file('Wood_2K_BaseColor.jpg', 'jpg')]
    expect(effectiveMaterialSlots(files)).toEqual({
      albedo: 'Wood_2K_BaseColor.jpg',
      normal: 'Wood_2K_Normal.jpg'
    })
  })
})

describe('logic/materialBall · slotRelPaths / hasMaterialSlots', () => {
  it('slotRelPaths：去重 + 排序（顺序无关，哈希才稳定）', () => {
    const slots = { albedo: 'b.jpg', normal: 'a.jpg', roughness: 'a.jpg' }
    expect(slotRelPaths(slots)).toEqual(['a.jpg', 'b.jpg'])
  })

  it('hasMaterialSlots：有槽位 true，空对象 false', () => {
    expect(hasMaterialSlots(materialSlots(sampleB()))).toBe(true)
    expect(hasMaterialSlots({})).toBe(false)
  })
})

describe('logic/materialBall · ballThumbName（缓存文件名）', () => {
  const id = 'a1b2c3d4-9f3c-1a2b-3c4d-5e6f7a8b9c0d'
  const slots = materialSlots(sampleB())

  it('格式 <id>-<8位十六进制>.png', () => {
    const name = ballThumbName(id, slots)
    expect(name).toBe(`${id}-${name.slice(id.length + 1, -4)}.png`)
    expect(name).toMatch(/^[0-9a-f-]+-[0-9a-f]{8}\.png$/)
  })

  it('与既有缩略图管线兼容：parseThumbFileName 能解析出同一 id', () => {
    const parsed = parseThumbFileName(ballThumbName(id, slots))
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(id)
    expect(parsed!.ext).toBe('png')
  })

  it('换任何一张贴图 → 缓存名变（缓存自然失效）', () => {
    const before = ballThumbName(id, slots)
    const changed = { ...slots, normal: 'vh1sbjl_2K_Normal_v2.jpg' }
    expect(ballThumbName(id, changed)).not.toBe(before)
  })

  it('rel 集合内容不变 → 缓存名不变（与传入顺序无关）', () => {
    const a = ballThumbName(id, { albedo: 'a.jpg', normal: 'b.jpg' })
    const b = ballThumbName(id, { normal: 'b.jpg', albedo: 'a.jpg' })
    expect(a).toBe(b)
  })

  it('空 slots 也有确定名字（不会炸）', () => {
    expect(ballThumbName(id, {})).toMatch(new RegExp(`^${id}-[0-9a-f]{8}\\.png$`))
  })
})

describe('logic/materialBall · slotUrls（vault:// 拼装）', () => {
  const slots = materialSlots(sampleB())

  it('vault://asset/<relFolder>/<rel>，中文目录逐段编码', () => {
    const urls = slotUrls('贴图/未分类/未分类/Brick_Rough_vh1sbjl_2K_surface_ms', slots)
    expect(urls.albedo).toBe(
      'vault://asset/%E8%B4%B4%E5%9B%BE/%E6%9C%AA%E5%88%86%E7%B1%BB/%E6%9C%AA%E5%88%86%E7%B1%BB/Brick_Rough_vh1sbjl_2K_surface_ms/vh1sbjl_2K_Albedo.jpg'
    )
    expect(urls.displacement).toContain('/vh1sbjl_2K_Displacement.jpg')
  })

  it('relFolder 尾部斜杠不产生双斜杠', () => {
    const urls = slotUrls('模型/某沙发/', { albedo: '贴图/木纹.jpg' })
    expect(urls.albedo).toBe('vault://asset/%E6%A8%A1%E5%9E%8B/%E6%9F%90%E6%B2%99%E5%8F%91/%E8%B4%B4%E5%9B%BE/%E6%9C%A8%E7%BA%B9.jpg')
  })

  it('缺的槽位不出现在 URL 映射里', () => {
    const urls = slotUrls('f', { albedo: 'a.jpg' })
    expect(Object.keys(urls)).toEqual(['albedo'])
  })
})

// ── 2026-10 调参持久化（docs/12 §6.2 末段）：golden 锁 ─────────────
// 既有 202-234 的断言一条未改（它们没有硬编码 hash 值）。这里补的是「硬编码」，
// 因为**没有既有测试锁 hash** —— 将来任何人改 hash 输入格式都不会被测试拦住。
// 被测对象是 `src/shared/ballParams.ts`（hash 的唯一实现），`materialBall.ts`
// 的 `ballThumbName` 已改为转发，所以两者必须算出同一个值（§10 第一条）。

describe('logic/materialBall · golden 锁（用户样本 B，防 hash 输入格式漂移）', () => {
  const id = 'a1b2c3d4-9f3c-1a2b-3c4d-5e6f7a8b9c0d'
  const slots = materialSlots(sampleB())

  it('样本 B 的 5 槽位集合（排序后）→ 430d90cc（方案 B：默认参数不贡献 hash）', () => {
    // 排序基串（slotRelPaths 去重 + sort 的结果，逐字锁死）
    expect(slotRelPaths(slots)).toEqual([
      'vh1sbjl_2K_AO.jpg',
      'vh1sbjl_2K_Albedo.jpg',
      'vh1sbjl_2K_Displacement.jpg',
      'vh1sbjl_2K_Normal.jpg',
      'vh1sbjl_2K_Roughness.jpg'
    ])
    expect(ballHash(slots, DEFAULT_PARAM_SCALES)).toBe('430d90cc')
    expect(ballThumbName(id, slots)).toBe(`${id}-430d90cc.png`)
    // 转发口径：renderer 与 shared 必须给出同一个名字（主进程与渲染进程同一 hash）
    expect(ballThumbName(id, slots)).toBe(ballThumbNameShared(id, slots))
  })

  it('样本 B + (1.50,1.00,0.50) → 1d4fe276（调参后名字变，既有缓存保留）', () => {
    expect(ballHash(slots, { roughness: 1.5, bump: 1, uv: 0.5 })).toBe('1d4fe276')
    expect(ballThumbName(id, slots, { roughness: 1.5, bump: 1, uv: 0.5 })).toBe(
      `${id}-1d4fe276.png`
    )
    expect(ballThumbName(id, slots, { roughness: 1.5, bump: 1, uv: 0.5 })).not.toBe(
      ballThumbName(id, slots)
    )
  })

  it('显式默认参数与不传参数 → 同一个名字（方案 B 硬约束）', () => {
    expect(ballThumbName(id, slots)).toBe(ballThumbName(id, slots, DEFAULT_PARAM_SCALES))
    expect(ballThumbName(id, slots)).toBe(`${id}-430d90cc.png`)
  })
})

describe('logic/materialBall · 数据通道图不当颜色图（2026-10-21 走查：白球缺陷）', () => {
  it('只有一张 Normal → 没有 baseColor，直接不上球（以前会返回 {normal} 渲出白球）', () => {
    const files = [file('sfeqopl_2K_Normal.jpg', 'jpg')]
    // 前提：槽位识别本身认得它是 normal
    expect(materialSlots(files)).toEqual({ normal: 'sfeqopl_2K_Normal.jpg' })
    // 结论：没有 albedo → 空对象 → 详情/舞台都不提供球
    expect(effectiveMaterialSlots(files)).toEqual({})
  })

  it('只有 AO / 粗糙度 也不上球', () => {
    expect(effectiveMaterialSlots([file('tex_2K_AO.jpg', 'jpg')])).toEqual({})
    expect(effectiveMaterialSlots([file('tex_2K_Roughness.jpg', 'jpg')])).toEqual({})
    expect(
      effectiveMaterialSlots([file('tex_2K_Normal.jpg', 'jpg'), file('tex_2K_Rough.jpg', 'jpg')])
    ).toEqual({})
  })

  it('有 normal + 一张普通颜色图 → 补齐 albedo 并保留 normal', () => {
    const files = [file('brick_2K_Normal.jpg', 'jpg'), file('brick.jpg', 'jpg')]
    expect(effectiveMaterialSlots(files)).toEqual({
      albedo: 'brick.jpg',
      normal: 'brick_2K_Normal.jpg'
    })
  })

  it('dataChannelLabel：单张数据图给中文通道名，普通图/多图给 null', () => {
    expect(dataChannelLabel([file('a_2K_Normal.jpg', 'jpg')])).toBe('法线')
    expect(dataChannelLabel([file('a_2K_AO.jpg', 'jpg')])).toBe('AO')
    expect(dataChannelLabel([file('a_2K_Roughness.jpg', 'jpg')])).toBe('粗糙度')
    expect(dataChannelLabel([file('a_2K_Displacement.jpg', 'jpg')])).toBe('位移')
    expect(dataChannelLabel([file('单图贴图.jpg', 'jpg')])).toBeNull()
    expect(
      dataChannelLabel([file('a_2K_Normal.jpg', 'jpg'), file('a_2K_AO.jpg', 'jpg')])
    ).toBeNull()
  })
})
