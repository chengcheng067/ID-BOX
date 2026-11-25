/**
 * 一键打包与素材同步 · T1 地基单测（docs/58 §2.1 / §2.5 / §2.6 / §4.3）。
 *
 * 覆盖两条线：
 * 1. **11 个纯函数**：parseManifest / validateManifest / parseIndex / validateIndex /
 *    isSafeRelFolder / isSafeFileRel / collectExpectedEntries / toPortableAsset /
 *    fromPortableAsset / pickPersonalSettings / mergePersonalSettings
 *    —— 重点用例按 T1 卡验收判据②逐条落地。
 * 2. **源码守卫**：`folder` 不在 PortableAsset（类型层 + 运行时双层）、11 函数确有导出、
 *    packageFormat.ts 零 `node:` import、8 通道在 ipc.ts / preload / main 各命中一次。
 *
 * 环境：vitest node（`vitest.config.ts` 全局配置），本文件是唯一允许 import `node:` 的地方
 * —— 被测模块本身必须保持零 node 依赖（守卫里断言）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_API_VERSION,
  PACKAGE_ASSETS_PREFIX,
  PACKAGE_FORMAT_MAGIC,
  PACKAGE_FORMAT_VERSION,
  PACKAGE_KIND_ORDER,
  PERSONAL_SETTINGS_KEYS,
  PORTABLE_OMIT_KEYS,
  collectExpectedEntries,
  fromPortableAsset,
  isSafeFileRel,
  isSafeRelFolder,
  mergePersonalSettings,
  parseIndex,
  parseManifest,
  pickPersonalSettings,
  toPortableAsset,
  validateIndex,
  validateManifest,
  type PackageManifest,
  type PersonalPatch,
  type PortableAsset,
  type PortableAssetFile
} from '../src/shared/packageFormat'
import { DEFAULT_SETTINGS, type Asset, type AssetKind, type Settings } from '../src/shared/types'
import type { AliasRecord } from '../src/shared/aliasRules'

/** 相对仓库根读源码（与 tests/classifyUiWiring.test.ts 的 readSrc 同款）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

function countMatches(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length
}

// ── fixtures ────────────────────────────────────────────────────────────────

function makeFile(rel: string, size = 100): PortableAssetFile {
  const base = path.posix.basename(rel)
  const ext = path.posix.extname(base).replace(/^\./, '').toLowerCase()
  return { rel, name: base, ext, size, kind: 'texture' }
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    name: '橡木地板',
    kind: 'texture',
    source: '知末网',
    folder: 'E:\\ModVault\\Library\\贴图\\木纹\\橡木\\橡木地板',
    relFolder: '贴图/木纹/橡木/橡木地板',
    thumbPath: 'a1b2c3d4-9f3c.jpg',
    thumbStatus: 'ready',
    files: [makeFile('wood_4k.png')],
    size: 100,
    tags: ['木纹'],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    deletedAt: undefined,
    trashRel: undefined,
    dedupeKey: 'texture:橡木地板',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function makeManifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    format: PACKAGE_FORMAT_MAGIC,
    formatVersion: PACKAGE_FORMAT_VERSION,
    apiVersion: PACKAGE_API_VERSION,
    appVersion: '1.1.0',
    generatedAt: '2026-11-23T00:00:00.000Z',
    count: 1,
    assetsBytes: 100,
    includedKinds: ['model', 'texture', 'hdri'] as AssetKind[],
    includePersonalSettings: false,
    indexSha256: 'a'.repeat(64),
    ...overrides
  }
}

function makePortable(overrides: Partial<PortableAsset> = {}): PortableAsset {
  return {
    ...toPortableAsset(makeAsset()),
    ...overrides
  }
}

function alias(id: string, key: string, name: string, createdAt = 1): AliasRecord {
  return { id, scope: 'key', key, name, createdAt }
}

// ════════════════════════════════════════════════════════════════════════════
// ① parseManifest
// ════════════════════════════════════════════════════════════════════════════

describe('parseManifest — JSON 解析 + 必填字段类型收口', () => {
  it('合法文本解析为 PackageManifest，可选字段默认不出现', () => {
    const parsed = parseManifest(JSON.stringify(makeManifest()))
    expect(parsed).not.toBeNull()
    expect(parsed?.format).toBe(PACKAGE_FORMAT_MAGIC)
    expect(parsed?.formatVersion).toBe(1)
    expect(parsed?.apiVersion).toBe('1')
    expect(parsed?.count).toBe(1)
    expect('sourceLibraryRoot' in (parsed as PackageManifest)).toBe(false)
    expect('personalSha256' in (parsed as PackageManifest)).toBe(false)
  })

  it('保留显式写入的 personalSha256 / sourceLibraryRoot（兼容旧包，导出端仍不写）', () => {
    const parsed = parseManifest(
      JSON.stringify(makeManifest({ personalSha256: 'b'.repeat(64), sourceLibraryRoot: 'E:\\old' }))
    )
    expect(parsed?.personalSha256).toBe('b'.repeat(64))
    expect(parsed?.sourceLibraryRoot).toBe('E:\\old')
  })

  it.each([
    ['语法坏', '{not json'],
    ['顶层 null', 'null'],
    ['顶层数组', '[]'],
    ['缺 count', JSON.stringify({ ...makeManifest(), count: undefined })],
    ['count 非数', JSON.stringify({ ...makeManifest(), count: '1' })],
    ['includedKinds 非数组', JSON.stringify({ ...makeManifest(), includedKinds: 'model' })],
    ['includedKinds 含未知大类', JSON.stringify({ ...makeManifest(), includedKinds: ['model', 'foobar'] })],
    ['两字段都缺', JSON.stringify({ ...makeManifest(), includedKinds: undefined, includeHdri: undefined })],
    ['indexSha256 非串', JSON.stringify({ ...makeManifest(), indexSha256: 42 })]
  ])('%s → null', (_label, text) => {
    expect(parseManifest(text)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ①-b F-2：includedKinds 新旧包兼容收口
// ════════════════════════════════════════════════════════════════════════════

describe('parseManifest · includedKinds（F-2 契约变更）', () => {
  it('PACKAGE_KIND_ORDER 是 7 个合法大类的唯一顺序真源', () => {
    expect(PACKAGE_KIND_ORDER).toEqual(['model', 'texture', 'material', 'hdri', 'cad', 'd5a', 'other'])
  })

  it('新包：按固定顺序去重收口，并保留合法大类', () => {
    const parsed = parseManifest(
      JSON.stringify(makeManifest({ includedKinds: ['hdri', 'model', 'model', 'cad'] as AssetKind[] }))
    )
    expect(parsed?.includedKinds).toEqual(['model', 'hdri', 'cad'])
    expect(parsed?.includeHdri).toBeUndefined()
  })

  it('旧包：只有 includeHdri=true → 全部大类；false → 除 hdri 外全部', () => {
    const base = makeManifest()
    const legacy = { ...base, includedKinds: undefined, includeHdri: true }
    expect(parseManifest(JSON.stringify(legacy))?.includedKinds).toEqual([...PACKAGE_KIND_ORDER])
    expect(parseManifest(JSON.stringify({ ...legacy, includeHdri: false }))?.includedKinds).toEqual(
      PACKAGE_KIND_ORDER.filter((k) => k !== 'hdri')
    )
  })

  it('旧包回执字段只留档不参与新逻辑（两字段都在时以新字段为准）', () => {
    const parsed = parseManifest(JSON.stringify({ ...makeManifest(), includeHdri: false }))
    expect(parsed?.includeHdri).toBe(false)
    expect(parsed?.includedKinds).toEqual(['model', 'texture', 'hdri'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② validateManifest
// ════════════════════════════════════════════════════════════════════════════

describe('validateManifest — 魔数 / 版本 / apiVersion / count', () => {
  it('完全合法 → null', () => {
    expect(validateManifest(makeManifest())).toBeNull()
  })

  it('format 魔数不符 → 中文错误', () => {
    const err = validateManifest(makeManifest({ format: 'random-zip' as PackageManifest['format'] }))
    expect(err).toContain('不是 ID BOX 素材包')
  })

  it('formatVersion 过新 → 拒绝并提示升级', () => {
    const err = validateManifest(makeManifest({ formatVersion: 2 as PackageManifest['formatVersion'] }))
    expect(err).toContain('请升级 ID BOX')
  })

  it('apiVersion 错 → 格式不兼容', () => {
    const err = validateManifest(makeManifest({ apiVersion: '2' as PackageManifest['apiVersion'] }))
    expect(err).toContain('格式不兼容')
  })

  it('count < 0 → 记录数无效', () => {
    expect(validateManifest(makeManifest({ count: -1 }))).toContain('记录数无效')
    expect(validateManifest(makeManifest({ count: 1.5 }))).toContain('记录数无效')
  })

  it('自定义 supportedFormatVersion / apiVersion 时按传入口径放行', () => {
    expect(
      validateManifest(
        makeManifest({ formatVersion: 2 as PackageManifest['formatVersion'], apiVersion: '2' as PackageManifest['apiVersion'] }),
        { supportedFormatVersion: 2, apiVersion: '2' }
      )
    ).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ parseIndex
// ════════════════════════════════════════════════════════════════════════════

describe('parseIndex — index.json 解析', () => {
  it('合法数组解析为 PortableAsset[]', () => {
    const records = parseIndex(JSON.stringify([makePortable()]))
    expect(records).toHaveLength(1)
    expect(records?.[0].id).toBe('asset-1')
  })

  it.each([
    ['语法坏', '{oops'],
    ['顶层对象', '{}'],
    ['元素缺 files', JSON.stringify([{ id: 'x', relFolder: '贴图/木纹/橡木/资产' }])]
  ])('%s → null', (_label, text) => {
    expect(parseIndex(text)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ④ validateIndex
// ════════════════════════════════════════════════════════════════════════════

describe('validateIndex — 条数 / sha256 / 路径 / id 唯一', () => {
  it('合法 → null', () => {
    expect(validateIndex([makePortable()], makeManifest())).toBeNull()
  })

  it('count 不符 → 坏包', () => {
    const records = [makePortable(), makePortable({ id: 'asset-2' })]
    expect(validateIndex(records, makeManifest({ count: 1 }))).toContain('记录数与清单不符')
  })

  it('sha256 不符 → 坏包（调用方传入实际 hash 才校验）', () => {
    expect(validateIndex([makePortable()], makeManifest(), 'b'.repeat(64))).toContain('校验和不符')
    expect(validateIndex([makePortable()], makeManifest(), 'a'.repeat(64))).toBeNull()
  })

  it('id 重复 → 坏包', () => {
    const records = [makePortable(), makePortable()]
    expect(validateIndex(records, makeManifest({ count: 2 }))).toContain('重复记录 id')
  })

  it('relFolder 不合法 → 坏包', () => {
    const records = [makePortable({ relFolder: '../贴图/木纹/橡木' })]
    expect(validateIndex(records, makeManifest())).toContain('路径不合法')
  })

  it('files[].rel 不合法 → 坏包', () => {
    const records = [makePortable({ files: [makeFile('../evil.png')] })]
    expect(validateIndex(records, makeManifest())).toContain('不合法的文件路径')
  })

  it('非数组 → 索引格式错误', () => {
    expect(validateIndex(null as unknown as PortableAsset[], makeManifest())).toContain('索引格式错误')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ isSafeRelFolder
// ════════════════════════════════════════════════════════════════════════════

describe('isSafeRelFolder — 四段 + posix + 无逃逸', () => {
  it('四段合法路径 → true', () => {
    expect(isSafeRelFolder('贴图/木纹/橡木/橡木地板-01')).toBe(true)
    expect(isSafeRelFolder('模型/家具/沙发/现代沙发')).toBe(true)
  })

  it.each([
    ['三段', '贴图/木纹/橡木'],
    ['五段', '贴图/木纹/橡木/地板/子目录'],
    ['.. 逃逸（末段）', '贴图/木纹/橡木/../evil'],
    ['.. 逃逸（首段）', '../贴图/木纹/橡木'],
    ['.. 中段', '贴图/../木纹/橡木/资产'],
    ['绝对路径', '/贴图/木纹/橡木/资产'],
    ['盘符', 'C:/贴图/木纹/橡木/资产'],
    ['反斜杠', '贴图\\木纹\\橡木\\资产'],
    ['空段', '贴图//木纹/橡木/资产'],
    ['空串', '']
  ])('%s → false', (_label, rel) => {
    expect(isSafeRelFolder(rel)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥ isSafeFileRel
// ════════════════════════════════════════════════════════════════════════════

describe('isSafeFileRel — 相对资产文件夹', () => {
  it('单层 / 多层相对路径 → true', () => {
    expect(isSafeFileRel('wood_4k.png')).toBe(true)
    expect(isSafeFileRel('textures/wood_4k.exr')).toBe(true)
  })

  it.each([
    ['.. 逃逸', '../evil.png'],
    ['.. 中段', 'textures/../../evil.png'],
    ['绝对路径', '/textures/wood.png'],
    ['盘符', 'C:/textures/wood.png'],
    ['反斜杠', 'textures\\wood.png'],
    ['点段', './wood.png'],
    ['空串', '']
  ])('%s → false', (_label, rel) => {
    expect(isSafeFileRel(rel)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑦ collectExpectedEntries
// ════════════════════════════════════════════════════════════════════════════

describe('collectExpectedEntries — zip 提取白名单', () => {
  it('生成 assets/<relFolder>/<file.rel> 精确集合', () => {
    const records = [
      makePortable({ files: [makeFile('wood.png'), makeFile('textures/wood_4k.exr')] })
    ]
    const entries = collectExpectedEntries(records)
    expect(entries.size).toBe(2)
    expect([...entries].sort()).toEqual([
      `${PACKAGE_ASSETS_PREFIX}贴图/木纹/橡木/橡木地板/textures/wood_4k.exr`,
      `${PACKAGE_ASSETS_PREFIX}贴图/木纹/橡木/橡木地板/wood.png`
    ])
  })

  it('不安全 relFolder / file.rel 不进白名单（zip-slip 防线）', () => {
    const records = [
      makePortable({ relFolder: '../贴图/木纹/橡木', files: [makeFile('evil.png')] }),
      makePortable({ id: 'ok', files: [makeFile('../evil.png'), makeFile('good.png')] })
    ]
    const entries = collectExpectedEntries(records)
    expect([...entries]).toEqual([`${PACKAGE_ASSETS_PREFIX}贴图/木纹/橡木/橡木地板/good.png`])
  })

  it('空输入 → 空集合', () => {
    expect(collectExpectedEntries([]).size).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑧ toPortableAsset / fromPortableAsset
// ════════════════════════════════════════════════════════════════════════════

/** 类型层守卫：PortableAsset 上不存在 `folder` 键。 */
type HasFolder = 'folder' extends keyof PortableAsset ? true : false
const PORTABLE_HAS_FOLDER: HasFolder = false

/** 类型层守卫：PersonalPatch 上不存在 `libraryDir` 键。 */
type PatchHasLibraryDir = 'libraryDir' extends keyof PersonalPatch ? true : false
const PATCH_HAS_LIBRARY_DIR: PatchHasLibraryDir = false

describe('toPortableAsset — 去 folder / 清缓存', () => {
  it('folder 不在类型里，也不在运行时对象里', () => {
    expect(PORTABLE_HAS_FOLDER).toBe(false)
    expect(PORTABLE_OMIT_KEYS).toContain('folder')
    const portable = toPortableAsset(makeAsset())
    expect(Object.prototype.hasOwnProperty.call(portable, 'folder')).toBe(false)
    expect(JSON.stringify(portable)).not.toContain('"folder"')
  })

  it('thumbPath / thumbStatus / deletedAt / trashRel 全部剔除，其余字段保留', () => {
    const source = makeAsset({ deletedAt: 1_700_000_001_000, trashRel: '.trash/asset-1' })
    const portable = toPortableAsset(source)
    for (const key of PORTABLE_OMIT_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(portable, key)).toBe(false)
    }
    expect(portable.id).toBe('asset-1')
    expect(portable.relFolder).toBe('贴图/木纹/橡木/橡木地板')
    expect(portable.dedupeKey).toBe('texture:橡木地板')
    expect(portable.files).toHaveLength(1)
  })

  it('不改入参，files 是新数组', () => {
    const source = makeAsset()
    const portable = toPortableAsset(source)
    expect(portable.files).not.toBe(source.files)
    expect(source.folder).toBe('E:\\ModVault\\Library\\贴图\\木纹\\橡木\\橡木地板')
    expect(source.thumbStatus).toBe('ready')
  })
})

describe('fromPortableAsset — 目标机现算 folder / 清缓存', () => {
  it('Windows 库根：folder === path.win32.join(libraryDir, relFolder)', () => {
    const record = makePortable()
    const root = 'E:\\ModVault\\Library'
    expect(fromPortableAsset(record, root).folder).toBe(path.win32.join(root, record.relFolder))
  })

  it('posix 库根：folder === path.posix.join(libraryDir, relFolder)', () => {
    const record = makePortable()
    const root = '/home/user/lib'
    expect(fromPortableAsset(record, root).folder).toBe(path.posix.join(root, record.relFolder))
  })

  it('缓存字段置 undefined / none，且不改入参', () => {
    const record = makePortable()
    const asset = fromPortableAsset(record, 'E:\\ModVault\\Library')
    expect(asset.thumbPath).toBeUndefined()
    expect(asset.thumbStatus).toBe('none')
    expect(asset.files).not.toBe(record.files)
    expect(Object.prototype.hasOwnProperty.call(record, 'thumbPath')).toBe(false)
  })

  it('往返：toPortable → fromPortable 后身份字段一致、folder 由目标库决定', () => {
    const original = makeAsset()
    const restored = fromPortableAsset(toPortableAsset(original), 'D:\\NewLib')
    expect(restored.id).toBe(original.id)
    expect(restored.dedupeKey).toBe(original.dedupeKey)
    expect(restored.folder).toBe(path.win32.join('D:\\NewLib', original.relFolder))
    expect(restored.folder).not.toBe(original.folder)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑨ pickPersonalSettings / mergePersonalSettings
// ════════════════════════════════════════════════════════════════════════════

describe('pickPersonalSettings — 12 键白名单', () => {
  it('恰好产出 PERSONAL_SETTINGS_KEYS 的 12 个键（2 组 + 9 home* + projectTemplates）', () => {
    const patch = pickPersonalSettings(DEFAULT_SETTINGS)
    const keys = Object.keys(patch).sort()
    expect(keys).toEqual([...PERSONAL_SETTINGS_KEYS].sort())
    expect(keys).toHaveLength(12)
    expect(keys.filter((k) => k.startsWith('home'))).toHaveLength(9)
    expect(keys).toContain('projectTemplates')
  })

  it('不含 libraryDir / 引导记位 / 侧栏折叠 / 插件与网络偏好 / 钉选 / 底纹', () => {
    const patch = pickPersonalSettings(DEFAULT_SETTINGS) as Record<string, unknown>
    for (const forbidden of [
      'libraryDir',
      'watchDir',
      'sevenZipPath',
      'homeGuideFirstRunShown',
      'homeGuideLastVersion',
      'homeGuideDisabled',
      'sidebarLeftCollapsed',
      'sidebarRightCollapsed',
      'pluginIndexEnabled',
      'pluginIndexGuideShown',
      'autoCheckUpdate',
      'zhimoCover',
      'savedViews',
      'theme',
      'motionQuality',
      // docs/60 §5.3 双向断言：机器路径 / 缓存引用永不随包走
      'homePinnedFolders',
      'homeFolderWallpaper'
    ]) {
      expect(forbidden in patch).toBe(false)
    }
  })

  it('深拷贝叶子：改 patch 不回写 settings', () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      customTaxonomy: { level1: ['自定义一级'], level2: { 自定义一级: ['自定义二级'] } }
    }
    const patch = pickPersonalSettings(settings)
    ;(patch.customTaxonomy as { level1: string[] }).level1.push('另一级')
    ;(patch.homeBackground as { source: string }).source = 'wallpaper'
    expect(settings.customTaxonomy.level1).toEqual(['自定义一级'])
    expect(settings.homeBackground.source).toBe('none')
  })

  it('缺键的旧 settings 不写空键到补丁', () => {
    const partial = { aliases: [] } as unknown as Settings
    expect(Object.keys(pickPersonalSettings(partial))).toEqual(['aliases'])
  })
})

describe('mergePersonalSettings — 白名单补丁合并，保护目标机', () => {
  it('目标机 libraryDir 不被覆盖（即使补丁注入非法键）', () => {
    expect(PATCH_HAS_LIBRARY_DIR).toBe(false)
    const current: Settings = { ...DEFAULT_SETTINGS, libraryDir: 'D:\\Target\\Library' }
    const dirtyPatch = { aliases: [], libraryDir: 'H:\\Hacked' } as unknown as PersonalPatch
    expect(mergePersonalSettings(current, dirtyPatch).libraryDir).toBe('D:\\Target\\Library')
  })

  it('非白名单键逐字保留，白名单键被覆盖', () => {
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      libraryDir: 'D:\\Target\\Library',
      theme: 'dark',
      trashRetention: '5d',
      homeWaveHeight: 0.65
    }
    const patch: PersonalPatch = { homeWaveHeight: 1.1 }
    const merged = mergePersonalSettings(current, patch)
    expect(merged.libraryDir).toBe('D:\\Target\\Library')
    expect(merged.theme).toBe('dark')
    expect(merged.trashRetention).toBe('5d')
    expect(merged.homeWaveHeight).toBe(1.1)
  })

  it('aliases 走 mergeAliasRecords：同键覆盖、目标机已有别名不丢、新键追加', () => {
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      aliases: [alias('r1', 'wood', '木纹', 1), alias('keep', 'stone', '石材', 1)]
    }
    const patch: PersonalPatch = {
      aliases: [alias('r2', 'wood', '木纹新版', 2), alias('r3', 'metal', '金属', 3)]
    }
    const merged = mergePersonalSettings(current, patch)
    expect(merged.aliases).toHaveLength(3)
    expect(merged.aliases.find((r) => r.key === 'wood')?.name).toBe('木纹新版')
    expect(merged.aliases.find((r) => r.key === 'stone')?.name).toBe('石材')
    expect(merged.aliases.find((r) => r.key === 'metal')?.name).toBe('金属')
  })

  it('不改入参 current', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, homeWaveSpeed: 1.6 }
    const before = current.homeWaveSpeed
    mergePersonalSettings(current, { homeWaveSpeed: 9 })
    expect(current.homeWaveSpeed).toBe(before)
  })

  it('空补丁 → 逐字等价的副本', () => {
    const current: Settings = { ...DEFAULT_SETTINGS }
    const merged = mergePersonalSettings(current, {})
    expect(merged).toEqual(current)
    expect(merged).not.toBe(current)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 源码守卫：11 函数 / 零 node import / 8 通道三处齐
// ════════════════════════════════════════════════════════════════════════════

describe('源码守卫 — T1 契约不可回退', () => {
  const PF = readSrc('src/shared/packageFormat.ts')
  const IPC_SRC = readSrc('src/shared/ipc.ts')
  const PRELOAD = readSrc('src/preload/index.ts')
  const MAIN = readSrc('src/main/index.ts')

  it('11 个函数全部 export function 定义', () => {
    const functions = [
      'parseManifest',
      'validateManifest',
      'parseIndex',
      'validateIndex',
      'isSafeRelFolder',
      'isSafeFileRel',
      'collectExpectedEntries',
      'toPortableAsset',
      'fromPortableAsset',
      'pickPersonalSettings',
      'mergePersonalSettings'
    ]
    for (const fn of functions) {
      expect(PF).toMatch(new RegExp(`export function ${fn}\\(`))
    }
  })

  it('packageFormat.ts 零 node: import（可在 node vitest 直接测）', () => {
    expect(/from\s+['"]node:/.test(PF)).toBe(false)
    expect(/require\(['"]node:/.test(PF)).toBe(false)
    expect(/import\s+['"]node:/.test(PF)).toBe(false)
  })

  it('folder 不在 PortableAsset：Omit 里显式列出 + 无 folder 属性声明', () => {
    expect(PF).toMatch(/Omit<Asset,/)
    expect(PF).toContain("'folder'")
    expect(/interface\s+PortableAsset\s*\{/.test(PF)).toBe(false)
  })

  it('8 通道在 ipc.ts / preload / main 各命中一次', () => {
    const channels = [
      'packageExportPick',
      'packageExport',
      'packageExportProgress',
      'packageExportCancel',
      'packageImportPick',
      'packageImportInspect',
      'packageImportApply',
      'packageImportProgress'
    ]
    for (const key of channels) {
      expect(countMatches(IPC_SRC, new RegExp(`\\b${key}:`, 'g'))).toBe(1)
      expect(countMatches(PRELOAD, new RegExp(`IPC\\.${key}\\b`, 'g'))).toBe(1)
      expect(countMatches(MAIN, new RegExp(`IPC\\.${key}\\b`, 'g'))).toBe(1)
    }
    // 排除前缀误命中：packageExport 是 packageExportPick 的前缀，逐文件总数也必须恰好 8。
    expect(countMatches(IPC_SRC, /\bpackage(?:Export|Import)[A-Za-z]*:/g)).toBe(8)
    expect(countMatches(PRELOAD, /IPC\.package(?:Export|Import)[A-Za-z]*/g)).toBe(8)
    expect(countMatches(MAIN, /IPC\.package(?:Export|Import)[A-Za-z]*/g)).toBe(8)
  })
})
