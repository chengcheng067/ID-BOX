/**
 * 一键打包 · T4 渲染层单测（docs/58 §4.3 / §5，验收判据 ①~⑥）。
 *
 * 环境：vitest node（无 jsdom / RTL）—— 纯函数真跑，UI 约束靠源码守卫。
 * 每条守卫都对应验收判据里的一条，见各 describe 的注释。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type Asset,
  type Settings
} from '../src/shared/types'
import {
  fromPortableAsset,
  mergePersonalSettings,
  toPortableAsset,
  type PersonalPatch,
  type PortableAsset
} from '../src/shared/packageFormat'
import {
  INITIAL_PACKAGE_CONFLICT_STATE,
  buildPackageConflicts,
  canApplyPackage,
  conflictStateReducer,
  isResolutionComplete,
  resolutionTable,
  shouldSkipConfirm,
  unresolvedIds
} from '../src/renderer/logic/packageRestore'

/** 相对仓库根读源码（与 tests/classifyUiWiring.test.ts 同款） */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：注释里会提到要防的那些词，不剥会让反向断言假红 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

// ── fixtures ────────────────────────────────────────────────────────────────

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    name: '橡木地板',
    kind: 'texture',
    source: '知末网',
    folder: 'E:\\Library\\贴图\\木纹\\橡木\\橡木地板',
    relFolder: '贴图/木纹/橡木/橡木地板',
    files: [{ rel: 'wood.png', name: 'wood.png', ext: 'png', size: 100, kind: 'texture' }],
    size: 100,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: 'texture:橡木地板',
    category1: '贴图',
    category2: '木纹',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function makePortable(overrides: Partial<PortableAsset> = {}): PortableAsset {
  return { ...toPortableAsset(makeAsset()), ...overrides }
}

// ════════════════════════════════════════════════════════════════════════════
// 验收 ①：空库直导 / 非空库必须确认（真值表）
// ════════════════════════════════════════════════════════════════════════════

describe('shouldSkipConfirm — 空库直导真值表', () => {
  it('空库 / 无效输入 → true（不弹确认）', () => {
    expect(shouldSkipConfirm([])).toBe(true)
    expect(shouldSkipConfirm(null)).toBe(true)
    expect(shouldSkipConfirm(undefined)).toBe(true)
  })

  it('非空库 → false（必须显式确认）', () => {
    expect(shouldSkipConfirm([makeAsset()])).toBe(false)
    expect(shouldSkipConfirm([makeAsset(), makeAsset({ id: 'asset-2' })])).toBe(false)
  })

  it('只有软删资产 = 事实上的空库 → true；混合库 → false', () => {
    expect(shouldSkipConfirm([makeAsset({ deletedAt: 1_700_000_100_000 })])).toBe(true)
    expect(
      shouldSkipConfirm([makeAsset({ deletedAt: 1 }), makeAsset({ id: 'live', deletedAt: undefined })])
    ).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 冲突比对
// ════════════════════════════════════════════════════════════════════════════

describe('buildPackageConflicts — id + 判重键比对', () => {
  it('空快照 / 空库 → 无冲突', () => {
    expect(buildPackageConflicts([], [])).toEqual([])
    expect(buildPackageConflicts([makeAsset()], [])).toEqual([])
    expect(buildPackageConflicts([], [makePortable()])).toEqual([])
  })

  it('id 全等 → same-id；分类不同 → category-moved', () => {
    const local = makeAsset()
    const same = buildPackageConflicts([local], [makePortable()])
    expect(same).toHaveLength(1)
    expect(same[0]!.reason).toBe('same-id')
    expect(same[0]!.categoryChanged).toBe(false)
    expect(same[0]!.id).toBe('asset-1')

    const moved = buildPackageConflicts([local], [makePortable({ category2: '石材' })])
    expect(moved[0]!.reason).toBe('category-moved')
    expect(moved[0]!.categoryChanged).toBe(true)
  })

  it('知末 ID 全等 → zhimo-id（强判定优先于同名）', () => {
    const local = makeAsset({ zhimoId: '1180221079', dedupeKey: 'texture:别的名字' })
    const incoming = makePortable({ id: 'new-id', name: '完全不同的名字', zhimoId: '1180221079' })
    const rows = buildPackageConflicts([local], [incoming])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('zhimo-id')
    expect(rows[0]!.localId).toBe('asset-1')
  })

  it('双方都无 ID 且同名同类型 → same-name（dedupeKey 缺失时现场重算）', () => {
    const local = makeAsset({ dedupeKey: undefined })
    const incoming = makePortable({ id: 'new-id', dedupeKey: undefined, name: '橡木地板' })
    const rows = buildPackageConflicts([local], [incoming])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('same-name')
  })

  it('双方各有不同知末 ID → 不判重（D02，不敢判）；软删记录不参与', () => {
    const local = makeAsset({ zhimoId: '1111111111' })
    expect(
      buildPackageConflicts([local], [makePortable({ id: 'new-id', zhimoId: '2222222222' })])
    ).toEqual([])
    expect(buildPackageConflicts([makeAsset({ deletedAt: 9 })], [makePortable()])).toEqual([])
  })

  it('纯函数：不改入参', () => {
    const local = makeAsset()
    const incoming = makePortable()
    const beforeLocal = JSON.stringify(local)
    const beforeIncoming = JSON.stringify(incoming)
    buildPackageConflicts([local], [incoming])
    expect(JSON.stringify(local)).toBe(beforeLocal)
    expect(JSON.stringify(incoming)).toBe(beforeIncoming)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 验收 ②：每条冲突有 resolution 才放行
// ════════════════════════════════════════════════════════════════════════════

function twoConflicts() {
  return buildPackageConflicts(
    [makeAsset(), makeAsset({ id: 'local-2', name: '大理石', dedupeKey: 'texture:大理石' })],
    [
      makePortable(),
      makePortable({ id: 'incoming-2', name: '大理石', dedupeKey: 'texture:大理石' })
    ]
  )
}

describe('conflictStateReducer — 逐项三档裁决状态机', () => {
  it('初始态 → inspecting → 非空库停在 confirm', () => {
    let state = conflictStateReducer(INITIAL_PACKAGE_CONFLICT_STATE, { type: 'inspecting' })
    expect(state.phase).toBe('inspecting')
    state = conflictStateReducer(state, {
      type: 'inspect',
      conflicts: twoConflicts(),
      total: 2,
      needsConfirm: true
    })
    expect(state.phase).toBe('confirm')
    expect(state.confirmed).toBe(false)
    expect(canApplyPackage(state)).toBe(false)
  })

  it('未确认前的裁决动作被忽略；确认后逐项裁决', () => {
    const conflicts = twoConflicts()
    let state = conflictStateReducer(INITIAL_PACKAGE_CONFLICT_STATE, {
      type: 'inspect', conflicts, total: 2, needsConfirm: true
    })
    state = conflictStateReducer(state, { type: 'choose', id: conflicts[0]!.id, resolution: 'skip' })
    expect(state.conflicts[0]!.resolution).toBeUndefined()

    state = conflictStateReducer(state, { type: 'confirm' })
    expect(state.phase).toBe('resolving')
    state = conflictStateReducer(state, { type: 'choose', id: conflicts[0]!.id, resolution: 'skip' })
    expect(state.phase).toBe('resolving')
    expect(isResolutionComplete(state)).toBe(false)
    expect(unresolvedIds(state)).toEqual([conflicts[1]!.id])
    expect(canApplyPackage(state)).toBe(false)

    state = conflictStateReducer(state, { type: 'choose', id: conflicts[1]!.id, resolution: 'keep-both' })
    expect(state.phase).toBe('ready')
    expect(canApplyPackage(state)).toBe(true)
    expect(resolutionTable(state)).toEqual({
      [conflicts[0]!.id]: 'skip',
      [conflicts[1]!.id]: 'keep-both'
    })
  })

  it('空库无冲突 → 直接 ready 放行；全部同档按钮可一次裁完', () => {
    let state = conflictStateReducer(INITIAL_PACKAGE_CONFLICT_STATE, {
      type: 'inspect', conflicts: [], total: 3, needsConfirm: false
    })
    expect(state.phase).toBe('ready')
    expect(canApplyPackage(state)).toBe(true)

    state = conflictStateReducer(INITIAL_PACKAGE_CONFLICT_STATE, {
      type: 'inspect', conflicts: twoConflicts(), total: 2, needsConfirm: false
    })
    state = conflictStateReducer(state, { type: 'choose-all', resolution: 'overwrite' })
    expect(canApplyPackage(state)).toBe(true)
    expect(Object.values(resolutionTable(state))).toEqual(['overwrite', 'overwrite'])
  })

  it('非法档位 / 不存在的 id 不改状态；ready 才能进 importing', () => {
    const conflicts = twoConflicts()
    let state = conflictStateReducer(INITIAL_PACKAGE_CONFLICT_STATE, {
      type: 'inspect', conflicts, total: 2, needsConfirm: false
    })
    const illegal = conflictStateReducer(state, {
      type: 'choose', id: conflicts[0]!.id, resolution: 'maybe' as never
    })
    expect(illegal).toBe(state)
    const unknown = conflictStateReducer(state, {
      type: 'choose', id: 'not-exist', resolution: 'skip'
    })
    expect(unknown).toBe(state)
    const early = conflictStateReducer(state, { type: 'importing' })
    expect(early).toBe(state)

    state = conflictStateReducer(state, { type: 'choose-all', resolution: 'skip' })
    state = conflictStateReducer(state, { type: 'importing' })
    expect(state.phase).toBe('importing')
    state = conflictStateReducer(state, { type: 'done' })
    expect(state.phase).toBe('done')
    state = conflictStateReducer(state, { type: 'reset' })
    expect(state).toEqual(INITIAL_PACKAGE_CONFLICT_STATE)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 验收 ④：个人设置合并不改目标机 libraryDir；folder 现算
// ════════════════════════════════════════════════════════════════════════════

describe('个人设置合并 + folder 现算', () => {
  it('libraryDir / watchDir / sevenZipPath 逐字保留，恶意注入键也不覆盖', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, libraryDir: 'D:\\Target\\Library', homeWaveSpeed: 1.6 }
    const evil = {
      libraryDir: 'C:\\Evil\\Library',
      watchDir: 'C:\\Evil\\Watch',
      sevenZipPath: 'C:\\Evil\\7z.exe',
      homeWaveSpeed: 9
    } as unknown as PersonalPatch
    const merged = mergePersonalSettings(current, evil)
    expect(merged.libraryDir).toBe('D:\\Target\\Library')
    expect(merged.watchDir).toBe(current.watchDir)
    expect(merged.sevenZipPath).toBe(current.sevenZipPath)
    expect(merged.homeWaveSpeed).toBe(9)
    expect(current.homeWaveSpeed).toBe(1.6)
  })

  it('白名单外的引导记位 / 主题等一律不动', () => {
    const current: Settings = { ...DEFAULT_SETTINGS, theme: 'light', homeGuideDisabled: true }
    const patch = { theme: 'dark', homeGuideDisabled: false, homeWaveHeight: 0.8 } as unknown as PersonalPatch
    const merged = mergePersonalSettings(current, patch)
    expect(merged.theme).toBe('light')
    expect(merged.homeGuideDisabled).toBe(true)
    expect(merged.homeWaveHeight).toBe(0.8)
  })

  it('fromPortableAsset 用目标机库根现算 folder，缓存指针清空', () => {
    const record = {
      ...makePortable(),
      thumbPath: 'old.jpg',
      thumbStatus: 'ready'
    } as PortableAsset
    const restored = fromPortableAsset(record, 'D:\\NewMachine\\Library')
    expect(restored.folder).toBe('D:\\NewMachine\\Library\\贴图\\木纹\\橡木\\橡木地板')
    expect(restored.thumbPath).toBeUndefined()
    expect(restored.thumbStatus).toBe('none')
    expect(Object.prototype.hasOwnProperty.call(record, 'folder')).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 验收 ③⑤⑥：源码守卫
// ════════════════════════════════════════════════════════════════════════════

describe('源码守卫 — T4 不可回退', () => {
  const STORE = readSrc('src/renderer/store.ts')
  const DIALOG = stripComments(readSrc('src/renderer/components/PackageDialog.tsx'))
  const STORE_CODE = stripComments(STORE)

  it('③ 写库前先落 backups 快照（顺序守卫）', () => {
    expect(STORE_CODE).toMatch(/db\.backups\.put\(\{/)
    expect(STORE_CODE).toContain('package-import-')
    const applyBody = STORE_CODE.slice(
      STORE_CODE.indexOf('async applyPackageImport()'),
      STORE_CODE.indexOf('async addCustomCategory(')
    )
    const backupAt = applyBody.indexOf('backupPackageImport(existing)')
    const writeAt = applyBody.indexOf('db.assets.bulkPut(restored)')
    expect(backupAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(backupAt)
  })

  it('③ 写库用 fromPortableAsset，个人设置走 mergePersonalSettings', () => {
    expect(STORE_CODE).toMatch(/fromPortableAsset\(record as PortableAsset, libraryDir\)/)
    expect(STORE_CODE).toMatch(/mergePersonalSettings\(current, applied\.personal\)/)
    expect(STORE_CODE).toMatch(/window\.modvault\.setSettings\(merged\)/)
  })

  it('⑤ Esc 走 useEscLayer，层级走 zStack.ts，零系统默认控件', () => {
    expect(DIALOG).toMatch(/useEscLayer\(close, open\)/)
    expect(DIALOG).toMatch(/zClassForDepth\(escDepth\)/)
    expect(DIALOG).not.toMatch(/addEventListener/)
    expect(DIALOG).not.toMatch(/<input\b/)
    expect(DIALOG).not.toMatch(/<select\b/)
    expect(DIALOG).not.toMatch(/type=["']checkbox["']/)
  })

  it('⑥ 文案单行、不暴露机器词', () => {
    for (const token of ['sha256', 'approx', 'apiVersion', 'dedupeKey', 'relFolder', 'package-import-']) {
      expect(DIALOG).not.toContain(token)
    }
    expect(DIALOG).not.toMatch(/\\n/)
    expect(DIALOG).not.toMatch(/[A-Za-z]:\\\\/)
  })

  it('⑤ 逐项三档按钮复用既有原语（文案不另写一套）', () => {
    expect(DIALOG).toContain('ResolutionButton')
    expect(DIALOG).toContain('CONFLICT_RESOLUTIONS')
    const conflictDialog = readSrc('src/renderer/components/ImportConflictDialog.tsx')
    expect(conflictDialog).toMatch(/export function ResolutionButton\(/)
  })
})
