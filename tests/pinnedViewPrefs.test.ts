/**
 * 钉选浏览器视图 / 排序偏好的**归一化真值表**（2026-11-25 用户需求①）。
 *
 * 两层都要钉：
 * 1. `shared/pinnedViewPrefs` 的纯函数（脏值只丢那一条 / 32 键封顶 / 默认回退）；
 * 2. 主进程 `SettingsSchema` + `migrateSettings` / `normalizeSettings` 的**单项降级** ——
 *    一条脏偏好记录绝不能让整份 settings.json 回落默认（否则 libraryDir 一起丢、库会"消失"，
 *    本项目在 gridDensity / trashRetention 上都踩过这个坑）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_PINNED_VIEW_PREFS,
  MAX_PINNED_VIEW_PREFS,
  normalizePinnedViewPrefs,
  normalizePinnedViewPrefsMap
} from '../src/shared/pinnedViewPrefs'
import { migrateSettings, normalizeSettings, SettingsSchema } from '../src/main/settings'

const LIB = 'E:\\ModVault\\Library'

const read = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')

describe('normalizePinnedViewPrefs（单条）', () => {
  it('缺省 / 非对象 → 列表 + 名称升序（与没有本功能时一致）', () => {
    expect(normalizePinnedViewPrefs(undefined)).toEqual(DEFAULT_PINNED_VIEW_PREFS)
    expect(normalizePinnedViewPrefs(null)).toEqual(DEFAULT_PINNED_VIEW_PREFS)
    expect(normalizePinnedViewPrefs('grid')).toEqual(DEFAULT_PINNED_VIEW_PREFS)
    expect(normalizePinnedViewPrefs(42)).toEqual(DEFAULT_PINNED_VIEW_PREFS)
  })

  it('合法值原样保留（三种排序键 × 两个方向）', () => {
    expect(normalizePinnedViewPrefs({ view: 'grid', sortKey: 'mtime', sortDir: 'desc' })).toEqual({
      view: 'grid',
      sortKey: 'mtime',
      sortDir: 'desc'
    })
    expect(normalizePinnedViewPrefs({ view: 'list', sortKey: 'size', sortDir: 'asc' })).toEqual({
      view: 'list',
      sortKey: 'size',
      sortDir: 'asc'
    })
    expect(normalizePinnedViewPrefs({ view: 'grid', sortKey: 'kind', sortDir: 'asc' }).sortKey).toBe(
      'kind'
    )
  })

  it('单个脏字段只回落该字段（其余合法值保留）', () => {
    expect(normalizePinnedViewPrefs({ view: 'big', sortKey: 'mtime', sortDir: 'desc' })).toEqual({
      view: 'list',
      sortKey: 'mtime',
      sortDir: 'desc'
    })
    expect(normalizePinnedViewPrefs({ view: 'grid', sortKey: 'date', sortDir: 'down' })).toEqual({
      view: 'grid',
      sortKey: 'name',
      sortDir: 'asc'
    })
  })
})

describe('normalizePinnedViewPrefsMap（整表）', () => {
  it('非对象 / 数组 → 空表（全部走默认视图）', () => {
    expect(normalizePinnedViewPrefsMap(undefined)).toEqual({})
    expect(normalizePinnedViewPrefsMap(null)).toEqual({})
    expect(normalizePinnedViewPrefsMap('oops')).toEqual({})
    expect(normalizePinnedViewPrefsMap([{ view: 'grid' }])).toEqual({})
  })

  it('脏条目逐条丢弃：空 pinId / 非对象值 / 数组值', () => {
    const out = normalizePinnedViewPrefsMap({
      '': { view: 'grid' },
      '   ': { view: 'grid' },
      p1: 'grid',
      p2: null,
      p3: [{ view: 'grid' }],
      p4: { view: 'grid', sortKey: 'size', sortDir: 'desc' }
    })
    expect(out).toEqual({ p4: { view: 'grid', sortKey: 'size', sortDir: 'desc' } })
  })

  it('合法条目逐字段归一化（脏字段不连坐同条的其它字段）', () => {
    const out = normalizePinnedViewPrefsMap({
      a: { view: 'grid' },
      b: { view: 'nope', sortKey: 'kind' },
      c: {}
    })
    expect(out).toEqual({
      a: { view: 'grid', sortKey: 'name', sortDir: 'asc' },
      b: { view: 'list', sortKey: 'kind', sortDir: 'asc' },
      c: { view: 'list', sortKey: 'name', sortDir: 'asc' }
    })
  })

  it(`键数封顶 ${MAX_PINNED_VIEW_PREFS}：保留先出现的，丢弃多余项`, () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < MAX_PINNED_VIEW_PREFS + 8; i += 1) raw[`pin-${i}`] = { view: 'grid' }
    const out = normalizePinnedViewPrefsMap(raw)
    expect(Object.keys(out).length).toBe(MAX_PINNED_VIEW_PREFS)
    expect(out['pin-0']).toBeDefined()
    expect(out[`pin-${MAX_PINNED_VIEW_PREFS - 1}`]).toBeDefined()
    expect(out[`pin-${MAX_PINNED_VIEW_PREFS}`]).toBeUndefined()
  })

  it('返回新对象，不修改入参', () => {
    const raw = { a: { view: 'grid' } }
    const out = normalizePinnedViewPrefsMap(raw)
    expect(out).not.toBe(raw)
    expect(out.a).not.toBe(raw.a)
  })
})

describe('Settings 单项降级：脏 pinnedViewPrefs 不拖垮整份设置', () => {
  it('schema 放行任意形状；migrateSettings 只丢脏条目，libraryDir 保持', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      pinnedViewPrefs: 'oops'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.libraryDir).toBe(LIB)
    expect(s.pinnedViewPrefs).toEqual({})
  })

  it('部分脏 / 部分合法：合法条目保留，脏条目丢弃', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: LIB,
      pinnedViewPrefs: {
        good: { view: 'grid', sortKey: 'mtime', sortDir: 'desc' },
        bad: 'grid',
        weird: { view: 'huge', sortKey: 'size' }
      }
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const s = migrateSettings(parsed.data)
    expect(s.pinnedViewPrefs).toEqual({
      good: { view: 'grid', sortKey: 'mtime', sortDir: 'desc' },
      weird: { view: 'list', sortKey: 'size', sortDir: 'asc' }
    })
  })

  it('写档路径 normalizeSettings 同样收口，且缺键回落空表', () => {
    const s = normalizeSettings({
      libraryDir: LIB,
      pinnedViewPrefs: { a: { view: 'grid' }, b: 1 }
    } as unknown as Parameters<typeof normalizeSettings>[0])
    expect(s.libraryDir).toBe(LIB)
    expect(s.pinnedViewPrefs).toEqual({ a: { view: 'grid', sortKey: 'name', sortDir: 'asc' } })
    expect(normalizeSettings({ libraryDir: LIB }).pinnedViewPrefs).toEqual({})
  })
})

describe('组件接线守卫（持久化写入 + 图标视图两行名字）', () => {
  const browserSrc = read('src/renderer/components/home/PinnedFolderBrowser.tsx')

  it('视图 / 排序偏好读写桥走 Settings（不再有内存级 usePinnedViewPrefs）', () => {
    expect(browserSrc).toContain("from '../../logic/pinnedViewPrefs'")
    expect(browserSrc).toContain('patchPinnedViewPrefs')
    expect(browserSrc).toContain('flushPinnedViewPrefs')
    expect(browserSrc).not.toContain('usePinnedViewPrefs')
    expect(browserSrc).toContain('settings?.pinnedViewPrefs')
  })

  it('图标视图名字：最多两行（line-clamp-2）+ 预留两行高度（min-h-[30px]）；列表仍单行', () => {
    // 与主库卡片标题同一套：12px 字号 / 15px 行高 / 两行 = 30px
    expect(browserSrc).toContain('line-clamp-2 min-h-[30px] w-full text-center text-[12px] leading-[15px]')
    // 旧实现（单行省略）不得回潮
    expect(browserSrc).not.toContain('w-full truncate text-center text-[12px]')
    // 列表视图的名字仍是单行 truncate（需求②只改图标视图）
    expect(browserSrc).toContain('block truncate text-[13px] text-primary')
  })
})
