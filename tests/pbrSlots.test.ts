/**
 * PBR 槽位唯一权威表 + 两侧消费方的单测（2026-10 第 2 轮 QA 缺陷 DEF-07）。
 *
 * 覆盖 QA 实测的四个样本（此前三个识别不全）：
 *   ① AmbientCG 新版 `Wood062_1K-JPG_{Color,NormalGL,Roughness,AmbientOcclusion,Displacement}`
 *   ② PolyHaven `wood_floor_{diff,nor_gl,rough,arm}_4k`
 *   ③ 裸简写 `marble_{color,normal,rough}`
 *   ④ 原有样本 B `vh1sbjl_2K_{Albedo,AO,Normal,Roughness,Displacement.jpg,Displacement.exr}`
 * 每个样本同时断言：大类判定（classify 侧，子串口径）与槽位识别（materialBall 侧，token 口径）。
 */
import { describe, expect, it } from 'vitest'
import {
  MATERIAL_PACK_REQUIRED_SLOTS,
  PBR_SLOT_ORDER,
  PBR_SLOT_WORDS,
  findPbrSlotInStem,
  matchPbrSlotToken,
  pbrSubstringWords,
  pbrTokenWords
} from '../src/shared/pbrSlots'
import { detectMaterialPack, kindOfExt, primaryKind } from '../src/shared/classify'
import {
  hasMaterialSlots,
  materialSlots
} from '../src/renderer/logic/materialBall'
import type { AssetFile } from '../src/shared/types'

function f(rel: string, size = 1): AssetFile {
  const name = rel.split('/').pop()!
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return { rel, name, ext, size, kind: kindOfExt(ext) }
}

// ── QA 四个实测样本 ────────────────────────────────────────────────

/** ① AmbientCG 新版（Color / NormalGL / AmbientOcclusion 是新词） */
const AMBIENTCG_NEW = [
  'Wood062_1K-JPG_Color.jpg',
  'Wood062_1K-JPG_NormalGL.jpg',
  'Wood062_1K-JPG_Roughness.jpg',
  'Wood062_1K-JPG_AmbientOcclusion.jpg',
  'Wood062_1K-JPG_Displacement.jpg'
].map((r) => f(r))

/** ② PolyHaven（diff / nor_gl / arm） */
const POLYHAVEN = [
  'wood_floor_diff_4k.jpg',
  'wood_floor_nor_gl_4k.jpg',
  'wood_floor_rough_4k.jpg',
  'wood_floor_arm_4k.jpg'
].map((r) => f(r))

/** ③ 裸简写 */
const BARE = ['marble_color.jpg', 'marble_normal.jpg', 'marble_rough.jpg'].map((r) => f(r))

/** ④ 原有样本 B（回归：不能因为补词表而退化） */
const SAMPLE_B = [
  'vh1sbjl_2K_Albedo.jpg',
  'vh1sbjl_2K_AO.jpg',
  'vh1sbjl_2K_Normal.jpg',
  'vh1sbjl_2K_Roughness.jpg',
  'vh1sbjl_2K_Displacement.jpg',
  'vh1sbjl_2K_Displacement.exr',
  'Brick_Rough_vh1sbjl_surface_Preview.png'
].map((r) => f(r))

describe('QA 四样本 · 大类判定（classify，子串口径）', () => {
  it('① AmbientCG 新版 Color/NormalGL → material', () => {
    expect(detectMaterialPack(AMBIENTCG_NEW)).toBe('wood062_1k_jpg')
    expect(primaryKind(AMBIENTCG_NEW)).toBe('material')
  })

  it('② PolyHaven diff/nor_gl/rough → material', () => {
    expect(detectMaterialPack(POLYHAVEN)).toBe('wood_floor')
    expect(primaryKind(POLYHAVEN)).toBe('material')
  })

  it('③ 裸简写 color/normal/rough → material', () => {
    expect(detectMaterialPack(BARE)).toBe('marble')
    expect(primaryKind(BARE)).toBe('material')
  })

  it('④ 样本 B 不退化（仍是 vh1sbjl_2k → material）', () => {
    expect(detectMaterialPack(SAMPLE_B)).toBe('vh1sbjl_2k')
    expect(primaryKind(SAMPLE_B)).toBe('material')
  })
})

describe('QA 四样本 · 槽位识别（materialBall，token 口径）', () => {
  it('① AmbientCG 新版：albedo+normal+roughness 全认出（此前全缺 → 灰球）', () => {
    const s = materialSlots(AMBIENTCG_NEW)
    expect(s.albedo).toBe('Wood062_1K-JPG_Color.jpg')
    expect(s.normal).toBe('Wood062_1K-JPG_NormalGL.jpg')
    expect(s.roughness).toBe('Wood062_1K-JPG_Roughness.jpg')
    expect(s.ao).toBe('Wood062_1K-JPG_AmbientOcclusion.jpg')
    expect(s.displacement).toBe('Wood062_1K-JPG_Displacement.jpg')
    expect(hasMaterialSlots(s)).toBe(true)
  })

  it('② PolyHaven：diff→albedo、nor_gl→normal、rough→roughness', () => {
    const s = materialSlots(POLYHAVEN)
    expect(s.albedo).toBe('wood_floor_diff_4k.jpg')
    expect(s.normal).toBe('wood_floor_nor_gl_4k.jpg')
    expect(s.roughness).toBe('wood_floor_rough_4k.jpg')
    // arm（AO/Roughness/Metalness 打包图）不该被认成任何槽位
    expect(Object.values(s).every((v) => v !== 'wood_floor_arm_4k.jpg')).toBe(true)
  })

  it('③ 裸简写：color→albedo', () => {
    const s = materialSlots(BARE)
    expect(s.albedo).toBe('marble_color.jpg')
    expect(s.normal).toBe('marble_normal.jpg')
    expect(s.roughness).toBe('marble_rough.jpg')
  })

  it('④ 样本 B：全槽位且不退化（exr 让位 jpg、Preview 不进槽位）', () => {
    const s = materialSlots(SAMPLE_B)
    expect(s.albedo).toBe('vh1sbjl_2K_Albedo.jpg')
    expect(s.normal).toBe('vh1sbjl_2K_Normal.jpg')
    expect(s.roughness).toBe('vh1sbjl_2K_Roughness.jpg')
    expect(s.ao).toBe('vh1sbjl_2K_AO.jpg')
    expect(s.displacement).toBe('vh1sbjl_2K_Displacement.jpg') // jpg 赢 exr
  })
})

describe('权威表结构', () => {
  it('五个槽位齐全、顺序固定（哈希与择优都依赖它）', () => {
    expect(PBR_SLOT_ORDER).toEqual(['albedo', 'normal', 'roughness', 'ao', 'displacement'])
    for (const slot of PBR_SLOT_ORDER) {
      expect(PBR_SLOT_WORDS[slot].length).toBeGreaterThan(0)
    }
  })

  it('QA 点名缺失的词全部补齐', () => {
    const albedo = pbrTokenWords('albedo')
    for (const w of ['color', 'col', 'diff', 'diffuse', 'basecol', 'basecolor', 'base_color']) {
      expect(albedo).toContain(w)
    }
    const normal = pbrTokenWords('normal')
    for (const w of ['normalgl', 'normaldx', 'nor', 'nrm', 'nor_gl']) {
      expect(normal).toContain(w)
    }
  })

  it('AO 短词 token 全等可命中（vh1sbjl_2K_AO 的 QA 实测口径）', () => {
    expect(matchPbrSlotToken('ao')).toBe('ao')
  })

  it('arm（PolyHaven AO/Rough/Metal 打包图）：分组口径认 AO 语义、渲染口径排除', () => {
    // 分组/展示（fileGroups 的 slotOfStem 走 matchPbrSlotToken）→ 认 ao
    expect(matchPbrSlotToken('arm')).toBe('ao')
    // 渲染择优（materialBall 的 SLOT_KEYWORDS 走 pbrTokenWords）→ 排除 packed
    expect(pbrTokenWords('ao')).not.toContain('arm')
    // 子串口径同样排除（tokenOnly 本就不进子串表，防 _arm_ 之类误伤）
    expect(pbrSubstringWords('ao')).not.toContain('arm')
  })

  it('子串词表排除 tokenOnly 短词（防 col→column / nor→north / ao→kaolin 误伤）', () => {
    expect(pbrSubstringWords('albedo')).not.toContain('col')
    expect(pbrSubstringWords('normal')).not.toContain('nor')
    expect(pbrSubstringWords('normal')).not.toContain('nrm')
    expect(pbrSubstringWords('ao')).not.toContain('ao')
    // 但 token 词表必须保留它们（样本 B 的 AO、PolyHaven 的 nor 靠这个认）
    expect(pbrTokenWords('ao')).toContain('ao')
    expect(pbrTokenWords('normal')).toContain('nor')
  })

  it('token 全等匹配：整词才命中', () => {
    expect(matchPbrSlotToken('color')).toBe('albedo')
    expect(matchPbrSlotToken('nor')).toBe('normal')
    expect(matchPbrSlotToken('ao')).toBe('ao')
    expect(matchPbrSlotToken('height')).toBe('displacement')
    // 误伤样本的整词本就不在表里
    expect(matchPbrSlotToken('column')).toBeNull()
    expect(matchPbrSlotToken('north')).toBeNull()
    expect(matchPbrSlotToken('kaolin')).toBeNull()
    expect(matchPbrSlotToken('')).toBeNull()
  })

  it('子串匹配取最右命中 → Height_2K_Normal 判 normal 而非 displacement', () => {
    expect(findPbrSlotInStem('Height_2K_Normal')?.slot).toBe('normal')
    expect(findPbrSlotInStem('Height_2K_Normal')?.prefix).toBe('Height_2K')
  })

  it('分隔符归一：`base-color` / `base color` 与 `base_color` 同前缀', () => {
    expect(findPbrSlotInStem('base-color')?.prefix).toBe('')
    expect(findPbrSlotInStem('base color')?.prefix).toBe('')
    expect(findPbrSlotInStem('base_color')?.prefix).toBe('')
    expect(findPbrSlotInStem('basecolor')?.prefix).toBe('')
  })

  it('非槽位文件名返回 null', () => {
    // 整个函数返回 null（不是 { slot: null }），空主干同理
    expect(findPbrSlotInStem('Brick_Rough_vh1sbjl_surface_Preview')).toBeNull()
    expect(findPbrSlotInStem('')).toBeNull()
  })

  it('材质包必需槽位 = Albedo + Normal + Roughness（ao/displacement 不强制）', () => {
    expect(MATERIAL_PACK_REQUIRED_SLOTS).toEqual(['albedo', 'normal', 'roughness'])
  })
})
