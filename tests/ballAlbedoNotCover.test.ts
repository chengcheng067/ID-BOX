/**
 * 回归锁：贴图球的 albedo **不许**是「我们自己生成的商品预览图」。
 *
 * 用户症状（原话）：「UV 重新渲染居然用的是球面来渲染，**不是用的材质本身**来渲染」。
 * 真机取证：20 条 `kind==='texture'` 资产的 albedo 全部是 `<资产名>.cover.jpg` ——
 * 封面是商品页截图（常带边框/水印/整张渲染图），贴在球上自然不像材质。
 *
 * 成因（见 `src/renderer/logic/materialBall.ts` 与 `src/main/coverImage.ts`）：
 * 封面固定叫 `<资产文件夹名>.cover.<ext>`，按文件名排序时 `c` < `j`/`p`，
 * 于是旧兜底 `files.find(第一张非数据通道图)` 永远先撞到封面。
 *
 * 本文件覆盖：
 * ① `*.cover.*` 不当 albedo；② 只剩封面时允许退化为 albedo（不返回空）；
 * ③ 多候选取体积最大；④ material 资产行为零变化；
 * ⑤ 真机 143 条记录逐条比对（`_probe_db/assets-full.json`，缺文件则跳过）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssetFile } from '../src/shared/types'
import {
  dataChannelLabel,
  dataChannelOf,
  effectiveMaterialSlots,
  isDerivedCover,
  materialSlots
} from '../src/renderer/logic/materialBall'

/** 构造 AssetFile（size 默认 1024，可用第 4 参覆盖） */
function file(
  rel: string,
  ext: string,
  kind: AssetFile['kind'] = 'texture',
  size = 1024
): AssetFile {
  const name = rel.split('/').pop() ?? rel
  return { rel, name, ext: ext.toLowerCase(), size, kind }
}

/** 修复前的实现（唯一用途：打印"改前/改后"对照表，锁住症状） */
function legacyEffectiveMaterialSlots(files: AssetFile[]): {
  albedo?: string
  normal?: string
  roughness?: string
  ao?: string
  displacement?: string
} {
  const slots = materialSlots(files)
  if (slots.albedo) return slots
  const firstColor = files.find(
    (f) => ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'tif', 'tiff', 'exr', 'hdr'].includes(
      f.ext.toLowerCase()
    ) && dataChannelOf(f) === null
  )
  if (!firstColor) return {}
  return { ...slots, albedo: firstColor.rel }
}

describe('logic/materialBall · isDerivedCover（派生封面判据）', () => {
  it('命中历史真实样本：<资产名>.cover.jpg / .cover.png（根层）', () => {
    // 全部取自真机快照 `_probe_db/assets-full.json`
    expect(isDerivedCover(file('灰色渐变玻璃贴图ID_1127350943.cover.jpg', 'jpg'))).toBe(true)
    expect(isDerivedCover(file('灰色瓷砖ID_1212473286.cover.jpg', 'jpg'))).toBe(true)
    expect(isDerivedCover(file('混凝土.cover.jpg', 'jpg', 'material'))).toBe(true)
    expect(isDerivedCover(file('墙面（3）.cover.jpg', 'jpg', 'material'))).toBe(true)
    expect(isDerivedCover(file('衣柜.cover.png', 'png', 'model'))).toBe(true)
  })

  it('大小写不敏感 + 覆盖 webp/jpeg 等常见图片后缀', () => {
    expect(isDerivedCover(file('X.COVER.JPG', 'jpg'))).toBe(true)
    expect(isDerivedCover(file('X.Cover.WebP', 'webp'))).toBe(true)
    expect(isDerivedCover(file('X.cover.jpeg', 'jpeg'))).toBe(true)
  })

  it('SKP 内嵌缩略图 <主名>.preview.<ext> 同样是派生图', () => {
    expect(isDerivedCover(file('衣柜.preview.jpg', 'jpg', 'model'))).toBe(true)
  })

  it('非派生：真贴图 / 用户自己的名字 / 非图片后缀 / 嵌套子目录', () => {
    // 真贴图（哪怕名字里带 preview 字样，只要不是 `.preview.` 中缀）
    expect(isDerivedCover(file('灰色渐变玻璃贴图ID_1127350943.jpeg', 'jpeg'))).toBe(false)
    expect(isDerivedCover(file('Concrete_Damaged_viyjde3_surface_Preview.png', 'png'))).toBe(false)
    // 用户自己叫 cover 的文件（缺 `.cover.` 中缀）
    expect(isDerivedCover(file('cover.jpg', 'jpg'))).toBe(false)
    expect(isDerivedCover(file('cover_灰色.jpg', 'jpg'))).toBe(false)
    expect(isDerivedCover(file('x_cover.jpg', 'jpg'))).toBe(false)
    // 中缀对但后缀不是图片（`.cover.json` 之类）
    expect(isDerivedCover(file('x.cover.json', 'json'))).toBe(false)
    // 嵌套子目录不属于封面族（与 store.ts 的 isRootCoverRel 同口径）
    expect(isDerivedCover(file('Textures/x.cover.jpg', 'jpg'))).toBe(false)
  })
})

describe('logic/materialBall · 贴图球不再用商品预览图当 albedo', () => {
  /** 真机 20 条 texture 的统一形态：封面 + 一张真贴图 */
  it('封面在前（真机实际顺序）→ albedo 是真贴图，且不再是 cover', () => {
    const files = [
      file('灰色渐变玻璃贴图ID_1127350943.cover.jpg', 'jpg', 'texture', 120_000),
      file('灰色渐变玻璃贴图ID_1127350943.jpeg', 'jpeg', 'texture', 1_800_000)
    ]
    // 前提：修复前确实认错（钉住症状，避免用例变成"空转"）
    expect(legacyEffectiveMaterialSlots(files).albedo).toBe(
      '灰色渐变玻璃贴图ID_1127350943.cover.jpg'
    )
    expect(effectiveMaterialSlots(files)).toEqual({
      albedo: '灰色渐变玻璃贴图ID_1127350943.jpeg'
    })
  })

  it('输入顺序颠倒也一样（判据不依赖顺序）', () => {
    const files = [
      file('无缝黑色木纹ID_1151853396.jpeg', 'jpeg'),
      file('无缝黑色木纹ID_1151853396.cover.jpg', 'jpg')
    ]
    expect(effectiveMaterialSlots(files).albedo).toBe('无缝黑色木纹ID_1151853396.jpeg')
  })

  it('PNG 贴图 + cover 同样正确；且 cover 不进任何槽位', () => {
    const files = [
      file('灰色瓷砖ID_1212473286.cover.jpg', 'jpg'),
      file('灰色瓷砖ID_1212473286.png', 'png')
    ]
    const slots = effectiveMaterialSlots(files)
    expect(slots).toEqual({ albedo: '灰色瓷砖ID_1212473286.png' })
    expect(slots.albedo).not.toMatch(/\.cover\./i)
  })

  it('封面名里带槽位词（x_Base_Color.cover.jpg）也抢不到 albedo 槽位', () => {
    const files = [
      file('Brick_Base_Color.cover.jpg', 'jpg'),
      file('Brick_Diffuse.jpg', 'jpg', 'texture', 900_000)
    ]
    // 过滤后只剩 Diffuse 一张 → 走 materialSlots 正常识别
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: 'Brick_Diffuse.jpg' })
  })

  it('封面不是唯一候选时，多候选按体积取最大（不选中缩略图/小图）', () => {
    const files = [
      file('木纹.cover.jpg', 'jpg', 'texture', 90_000), // 派生图，先出局
      file('木纹_缩略图.png', 'png', 'texture', 20_000),
      file('木纹_大图.png', 'png', 'texture', 2_400_000),
      file('木纹_中图.jpg', 'jpg', 'texture', 800_000)
    ]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: '木纹_大图.png' })
  })

  it('体积相同 → 仍取输入序第一张（确定性，不随机挑）', () => {
    const files = [
      file('B_Texture.jpg', 'jpg', 'texture', 1024),
      file('A_Texture.png', 'png', 'texture', 1024)
    ]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: 'B_Texture.jpg' })
  })

  it('体积字段缺失（旧索引）→ 当作 0，不抛错、仍能选出候选', () => {
    const legacy = { rel: '旧贴图.jpeg', name: '旧贴图.jpeg', ext: 'jpeg', kind: 'texture' as const }
    // @ts-expect-error 故意构造缺 size 的旧记录（运行时确实可能是 undefined）
    expect(effectiveMaterialSlots([legacy])).toEqual({ albedo: '旧贴图.jpeg' })
  })
})

describe('logic/materialBall · 只剩派生封面时允许退化', () => {
  it('资产里只有 <名>.cover.jpg → 用封面当 albedo（不返回空，否则不出球）', () => {
    const files = [file('石材.cover.jpg', 'jpg', 'texture', 300_000)]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: '石材.cover.jpg' })
  })

  it('只有封面 + 说明书 → 仍用封面，不被 txt/json 干扰', () => {
    const files = [
      file('石材.cover.png', 'png', 'texture', 300_000),
      file('知末网说明.txt', 'txt', 'other'),
      file('素材.json', 'json', 'other')
    ]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: '石材.cover.png' })
  })

  it('只有封面 + 数据通道图 → 保留通道，albedo 退化用封面', () => {
    const files = [
      file('x.cover.jpg', 'jpg', 'texture', 300_000),
      file('x_2K_Normal.jpg', 'jpg', 'texture', 900_000)
    ]
    expect(effectiveMaterialSlots(files)).toEqual({
      normal: 'x_2K_Normal.jpg',
      albedo: 'x.cover.jpg'
    })
  })

  it('一张图都没有（只有 skp / json）→ 仍是空对象，不可渲球', () => {
    const files = [file('衣柜.skp', 'skp', 'model'), file('pbugp0.json', 'json', 'other')]
    expect(effectiveMaterialSlots(files)).toEqual({})
  })

  it('只有一张 Normal（无封面）→ 仍返回空对象（原行为不变，白球缺陷不回归）', () => {
    const files = [file('sfeqopl_2K_Normal.jpg', 'jpg')]
    expect(effectiveMaterialSlots(files)).toEqual({})
  })
})

describe('logic/materialBall · material 资产零变化', () => {
  /** 真机 `混凝土` 的记录（AmbientCG 包，含封面 + Preview + 真 PBR 槽位） */
  function concrete(): AssetFile[] {
    return [
      file('Concrete_Damaged_viyjde3_surface_Preview.png', 'png', 'texture', 500_000),
      file('Concrete_Smooth_pbugp0_surface_Preview.png', 'png', 'texture', 500_000),
      file('pbugp0.json', 'json', 'other'),
      file('pbugp_2K_Albedo.jpg', 'jpg', 'texture', 3_000_000),
      file('pbugp_2K_AO.jpg', 'jpg', 'texture', 900_000),
      file('pbugp_2K_Displacement.exr', 'exr', 'hdri', 4_000_000),
      file('pbugp_2K_Displacement.jpg', 'jpg', 'texture', 1_200_000),
      file('pbugp_2K_Normal.jpg', 'jpg', 'texture', 2_000_000),
      file('pbugp_2K_Roughness.jpg', 'jpg', 'texture', 800_000),
      file('viyjde3.json', 'json', 'other'),
      file('viyjde3_2K_Albedo.jpg', 'jpg', 'texture', 3_100_000),
      file('viyjde3_2K_AO.jpg', 'jpg', 'texture', 910_000),
      file('viyjde3_2K_Displacement.exr', 'exr', 'hdri', 4_100_000),
      file('viyjde3_2K_Displacement.jpg', 'jpg', 'texture', 1_210_000),
      file('viyjde3_2K_Normal.jpg', 'jpg', 'texture', 2_010_000),
      file('viyjde3_2K_Roughness.jpg', 'jpg', 'texture', 810_000),
      file('混凝土.cover.jpg', 'jpg', 'texture', 400_000)
    ]
  }

  it('真 PBR 资产：槽位与修复前逐字段相同，albedo 仍是 *_Albedo.jpg', () => {
    const files = concrete()
    const before = legacyEffectiveMaterialSlots(files)
    const after = effectiveMaterialSlots(files)
    expect(after).toEqual(before)
    expect(after.albedo).toMatch(/_Albedo\.jpg$/)
    expect(after.albedo).not.toMatch(/\.cover\./i)
    // 5 个槽位都在，且 displacement 仍让位给 jpg（exr 不参与渲染）
    expect(Object.keys(after).sort()).toEqual(
      ['albedo', 'ao', 'displacement', 'normal', 'roughness'].sort()
    )
    expect(after.displacement).toBe('pbugp_2K_Displacement.jpg')
  })

  it('只有 albedo 的材质包（无 normal/roughness）：封面不干扰，仍取 Albedo', () => {
    const files = [
      file('墙面.cover.jpg', 'jpg', 'texture'),
      file('ti1nebpfw_2K_Albedo.jpg', 'jpg', 'texture')
    ]
    expect(effectiveMaterialSlots(files)).toEqual({ albedo: 'ti1nebpfw_2K_Albedo.jpg' })
  })
})

describe('logic/materialBall · 卡片通道角标不受影响', () => {
  it('dataChannelLabel 仍只看单文件与数据通道语义', () => {
    expect(dataChannelLabel([file('a_2K_Normal.jpg', 'jpg')])).toBe('法线')
    expect(dataChannelLabel([file('a_2K_AO.jpg', 'jpg')])).toBe('AO')
    expect(dataChannelLabel([file('单图贴图.jpg', 'jpg')])).toBeNull()
    // 封面 + 真图（2 张）→ 不显示通道角标（本就不是单图），与修复前一致
    expect(
      dataChannelLabel([file('x.cover.jpg', 'jpg'), file('x.jpeg', 'jpeg')])
    ).toBeNull()
  })
})

// ── 真机 143 条记录逐条比对（缺快照则整块跳过，别人的机器上不会红） ─────────────
interface ProbeFile {
  rel: string
  name: string
  ext: string
  size?: number
  w?: number
  h?: number
}

interface ProbeAsset {
  id: string
  name: string
  kind: string
  files: ProbeFile[]
}

const PROBE_CANDIDATES = [
  path.resolve(process.cwd(), '../_probe_db/assets-full.json'),
  path.resolve(process.cwd(), '_probe_db/assets-full.json'),
  'E:/workbuddy/2026-10-13-01-03-46/_probe_db/assets-full.json'
]

const PROBE_PATH = PROBE_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
})

function loadProbe(): ProbeAsset[] {
  if (!PROBE_PATH) return []
  const raw = fs.readFileSync(PROBE_PATH, 'utf8')
  return JSON.parse(raw) as ProbeAsset[]
}

/** 快照文件 → AssetFile（缺 size 的旧记录按 0 处理，与真实类型一致） */
function toAssetFile(f: ProbeFile): AssetFile {
  return {
    rel: f.rel,
    name: f.name,
    ext: (f.ext || '').toLowerCase(),
    size: typeof f.size === 'number' ? f.size : 0,
    kind: 'texture',
    ...(typeof f.w === 'number' ? { w: f.w } : {}),
    ...(typeof f.h === 'number' ? { h: f.h } : {})
  }
}

/** 按显示宽度补空格（中文按 2 列算，表格才对齐） */
function padEndDisplay(s: string, width: number): string {
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

describe.skipIf(!PROBE_PATH)('真机快照：143 条记录的 albedo 改前/改后对照', () => {
  it('texture：改后 albedo 一律不再是封面（且非空）', () => {
    const all = loadProbe()
    const textures = all.filter((a) => a.kind === 'texture')
    expect(textures.length).toBeGreaterThan(0)

    const rows: string[] = []
    for (const a of textures) {
      const files = a.files.map(toAssetFile)
      const before = legacyEffectiveMaterialSlots(files).albedo ?? '(无)'
      const after = effectiveMaterialSlots(files).albedo ?? '(无)'
      rows.push(`${padEndDisplay(a.name.slice(0, 24), 50)} | ${padEndDisplay(before, 46)} | ${after}`)
      // ① 不再是派生封面
      expect(after).not.toMatch(/\.cover\./i)
      // ② 仍然能渲球（不是空）
      expect(after).not.toBe('(无)')
    }
    console.log(
      [
        '',
        `── texture 共 ${textures.length} 条（albedo 改前 → 改后）──`,
        `${padEndDisplay('资产名', 50)} | ${padEndDisplay('改前 albedo', 46)} | 改后 albedo`,
        '-'.repeat(140),
        ...rows,
        ''
      ].join('\n')
    )
  })

  it('texture：改后 albedo 必须是资产里真实存在、且非派生的文件', () => {
    for (const a of loadProbe().filter((x) => x.kind === 'texture')) {
      const files = a.files.map(toAssetFile)
      const albedo = effectiveMaterialSlots(files).albedo
      const hit = files.find((f) => f.rel === albedo)
      expect(hit, `${a.name} 的 albedo 必须来自 files`).toBeDefined()
      expect(isDerivedCover(hit!)).toBe(false)
    }
  })

  it('material：行为零变化（albedo 仍是 *_Albedo.jpg，槽位逐字段相同）', () => {
    const materials = loadProbe().filter((a) => a.kind === 'material')
    expect(materials.length).toBeGreaterThan(0)
    const rows: string[] = []
    for (const a of materials) {
      const files = a.files.map(toAssetFile)
      const before = legacyEffectiveMaterialSlots(files)
      const after = effectiveMaterialSlots(files)
      rows.push(
        `${padEndDisplay(a.name.slice(0, 20), 40)} | ${padEndDisplay(materialSlots(files).albedo ?? '(无)', 34)} | ${after.albedo ?? '(无)'}`
      )
      expect(after).toEqual(before)
      if (materialSlots(files).albedo) {
        expect(after.albedo).toBe(materialSlots(files).albedo)
        expect(after.albedo).toMatch(/_Albedo\.jpg$/i)
      }
    }
    console.log(
      [
        '',
        `── material 共 ${materials.length} 条（materialSlots 结果 = effective 结果）──`,
        `${padEndDisplay('资产名', 40)} | ${padEndDisplay('槽位识别 albedo', 34)} | effective albedo`,
        '-'.repeat(120),
        ...rows,
        ''
      ].join('\n')
    )
  })
})
