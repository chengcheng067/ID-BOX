/**
 * 排序方向（正序 / 倒序）—— 2026-11 用户反馈：「Idbox 本体在时间的筛选上，应该是正序和倒序
 * 的一个功能。」
 *
 * 数据契约：`Filters.sortDesc` 是**三态**（`null` / `true` / `false`），不是普通布尔。
 * - `null` = 该键的**自然方向**（= 本功能上线前的行为，必须逐元素不变）；
 * - `true` = 降序；`false` = 升序。
 *
 * 本文件守四件事：
 * ① 四个键 × 三种 `sortDesc` 的排序结果（含"`false` 语义统一"）；
 * ② **向后兼容守门**：省略第三参 / 显式 `null` 的结果 = 改动前写死的方向（逐元素）；
 * ③ `filtersFromSavedView` 对脏 `sortDesc` 的清洗（只认布尔字面量）；
 * ④ 切键时方向重置为 `null`（`sortChangePatch`）。
 */
/// <reference lib="dom" />
// ↑ 本文件里有一段要驱动**真实 store action**（`setFilter` 的"换键重置方向"）。
//   tests 走 tsconfig.node，renderer 源码用到 `window` → 必须把 DOM lib 挂进来，
//   并按 `tests/storeFlow.test.ts` 的做法补一份 `Window.modvault` 声明。
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import type { Asset, SavedView } from '../src/shared/types'
import {
  DEFAULT_FILTERS,
  NATURAL_SORT_DESC,
  applyFilters,
  effectiveSortDesc,
  filtersFromSavedView,
  naturalSortDesc,
  snapshotFilters,
  sortAssets,
  sortChangePatch,
  type SortKey
} from '../src/renderer/logic/filters'

declare global {
  interface Window {
    /** 真实声明在 src/renderer/env.d.ts（仅对 tsconfig.web 生效），node 程序复用同一类型 */
    modvault: ModVaultApi
  }
}

// 边界桩必须在动态 import store 之前就位。`setFilter` 只用内存 state，不碰 IPC / Dexie，
// 所以空对象就够（与 `tests/savedViewStore.test.ts` 同一个手法）。
;(globalThis as unknown as { window: { modvault: unknown } }).window = {
  modvault: {} as unknown as ModVaultApi
}

const { useVault } = await import('../src/renderer/store')

let seq = 0

function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\资产${seq}`,
    relFolder: `模型/资产${seq}`,
    files: [],
    size: 0,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `dk-${seq}`,
    importedAt: seq * 1000,
    updatedAt: seq * 1000,
    ...patch
  }
}

/**
 * 本文件只管**老四键**：它是「`sortDesc` 三态 + `false` 语义统一 + 向后兼容」的回归锁，
 * 期望值全部是手算的固定样本顺序。2026-10 新增的 `lastUsed` / `mostUsed` 用的是**另一套
 * 样本**（要构造"用了 20 次但 90 天前"这种资产），完整矩阵在 `tests/usageSort.test.ts`，
 * 塞进来会把这个文件变成两套夹具混住的大杂烩。
 *
 * 所以键域用 `as const` 收窄（instead of `SortKey[]`）：`Record<LegacySortKey, …>` 不再
 * 要求新键的出现 —— 但**不**放松任何老键的断言。
 */
const KEYS = ['recent', 'name', 'size', 'su'] as const
type LegacySortKey = (typeof KEYS)[number]

/**
 * 三个维度**互不重叠**的固定样本（每个键排出来的顺序都不一样，能真正区分四个分支）：
 *
 * | id | name | size | importedAt | suMajor |
 * |----|------|------|-----------|---------|
 * | a  | 沙发 | 30   | 3         | 20      |
 * | b  | 床   | 10   | 1         | 24      |
 * | c  | 衣柜 | 20   | 2         | 22      |
 */
function fixture(): Asset[] {
  return [
    asset({ id: 'a', name: '沙发', size: 30, importedAt: 3, updatedAt: 3, suMajor: 20, suVersion: 'SU 2020', dedupeKey: 'dk-a' }),
    asset({ id: 'b', name: '床', size: 10, importedAt: 1, updatedAt: 1, suMajor: 24, suVersion: 'SU 2024', dedupeKey: 'dk-b' }),
    asset({ id: 'c', name: '衣柜', size: 20, importedAt: 2, updatedAt: 2, suMajor: 22, suVersion: 'SU 2022', dedupeKey: 'dk-c' })
  ]
}

function ids(list: Asset[]): string[] {
  return list.map((a) => a.id)
}

describe('sortAssets · 四个键 × 三种 sortDesc', () => {
  /**
   * 期望值（独立于实现手算出来的）：
   * - recent  asc = 旧→新 1,2,3 → b,c,a ；desc 反过来 a,c,b
   * - name    asc = 拼音 c(chuáng) < s(沙发) < y(衣柜) → b,a,c ；desc c,a,b
   * - size    asc = 小→大 10,20,30 → b,c,a ；desc a,c,b
   * - su      asc = 旧版本→新版本 20,22,24 → a,c,b ；desc b,c,a
   */
  const EXPECTED: Record<LegacySortKey, { asc: string[]; desc: string[] }> = {
    recent: { asc: ['b', 'c', 'a'], desc: ['a', 'c', 'b'] },
    name: { asc: ['b', 'a', 'c'], desc: ['c', 'a', 'b'] },
    size: { asc: ['b', 'c', 'a'], desc: ['a', 'c', 'b'] },
    su: { asc: ['a', 'c', 'b'], desc: ['b', 'c', 'a'] }
  }

  it('sortDesc=false 一律「小→大 / 旧→新 / A→Z」（四个键语义统一）', () => {
    for (const key of KEYS) {
      expect(ids(sortAssets(fixture(), key, false)), `${key} 升序`).toEqual(EXPECTED[key].asc)
    }
  })

  it('sortDesc=true 一律反向', () => {
    for (const key of KEYS) {
      expect(ids(sortAssets(fixture(), key, true)), `${key} 降序`).toEqual(EXPECTED[key].desc)
    }
  })

  it('sortDesc=null 落回各键的自然方向（不是统一 asc / desc）', () => {
    for (const key of KEYS) {
      const dir = NATURAL_SORT_DESC[key] ? 'desc' : 'asc'
      expect(ids(sortAssets(fixture(), key, null)), `${key} 自然方向 ${dir}`).toEqual(
        EXPECTED[key][dir]
      )
    }
    // 自然方向表本身钉死：recent / size / su / lastUsed / mostUsed 降序，name 升序
    //（2026-10 两条使用统计键同样是"新的 / 高的在上"，所以自然方向 = 降序）
    expect(NATURAL_SORT_DESC).toEqual({
      recent: true,
      name: false,
      size: true,
      su: true,
      lastUsed: true,
      mostUsed: true
    })
  })

  it('不修改入参（纯函数）', () => {
    const list = fixture()
    const before = ids(list)
    sortAssets(list, 'name', false)
    sortAssets(list, 'size', true)
    expect(ids(list)).toEqual(before)
  })

  it('su 方向反转时，同版本号的次级键仍是名称 A→Z', () => {
    const list = [
      asset({ id: 'z', name: '衣柜', suMajor: 24, suVersion: 'SU 2024' }),
      asset({ id: 'b', name: '床', suMajor: 24, suVersion: 'SU 2024' })
    ]
    expect(ids(sortAssets(list, 'su', false))).toEqual(['b', 'z'])
    expect(ids(sortAssets(list, 'su', true))).toEqual(['b', 'z'])
  })
})

describe('向后兼容守门：省略第三参 = 改动前的写死方向', () => {
  /** 这四个数组是**改动前**各分支写死方向的产物（手算，不是从新实现里抄的） */
  const LEGACY: Record<LegacySortKey, string[]> = {
    recent: ['a', 'c', 'b'], // b.importedAt - a.importedAt（新→旧）
    name: ['b', 'a', 'c'], // a.name.localeCompare(b.name,'zh-CN')（A→Z）
    size: ['a', 'c', 'b'], // b.size - a.size（大→小）
    su: ['b', 'c', 'a'] // suMajorOf(b) - suMajorOf(a)（新版本→旧版本）
  }

  it('sortAssets(list, key) —— 老调用点（store 的整理队列等）行为零变化', () => {
    for (const key of KEYS) {
      expect(ids(sortAssets(fixture(), key)), `${key} 省略第三参`).toEqual(LEGACY[key])
    }
  })

  it('sortAssets(list, key, null) 与省略第三参逐元素相同', () => {
    for (const key of KEYS) {
      expect(ids(sortAssets(fixture(), key, null)), `${key} 显式 null`).toEqual(LEGACY[key])
      expect(ids(sortAssets(fixture(), key, null))).toEqual(ids(sortAssets(fixture(), key)))
    }
  })

  it('applyFilters(DEFAULT_FILTERS) 仍是「最近导入在前」且 DEFAULT_FILTERS.sortDesc === null', () => {
    expect(DEFAULT_FILTERS.sortDesc).toBeNull()
    // 出厂默认 = recent + null → 与新→旧完全一致
    expect(ids(applyFilters(fixture(), DEFAULT_FILTERS))).toEqual(LEGACY.recent)
  })
})

describe('effectiveSortDesc / naturalSortDesc', () => {
  it('null 翻译成自然方向，布尔值原样透出', () => {
    expect(effectiveSortDesc('recent', null)).toBe(true)
    expect(effectiveSortDesc('name', null)).toBe(false)
    expect(effectiveSortDesc('size', null)).toBe(true)
    expect(effectiveSortDesc('su', null)).toBe(true)
    // 用户手选的方向永远压过自然方向
    expect(effectiveSortDesc('size', false)).toBe(false)
    expect(effectiveSortDesc('name', true)).toBe(true)
    expect(naturalSortDesc('name')).toBe(false)
    expect(naturalSortDesc('recent')).toBe(true)
  })
})

describe('applyFilters · 回收站的方向跟随', () => {
  function trashed(): Asset[] {
    return [
      asset({ id: 'a', deletedAt: 300 }),
      asset({ id: 'b', deletedAt: 100 }),
      asset({ id: 'c', deletedAt: 200 })
    ]
  }

  it('trash + recent + sortDesc 缺省/true → 最近删的在前（deletedAt 降序）', () => {
    expect(ids(applyFilters(trashed(), { ...DEFAULT_FILTERS, sortDesc: null }, 'trash'))).toEqual([
      'a',
      'c',
      'b'
    ])
    expect(ids(applyFilters(trashed(), { ...DEFAULT_FILTERS, sortDesc: true }, 'trash'))).toEqual([
      'a',
      'c',
      'b'
    ])
  })

  it('trash + recent + sortDesc=false → 按 deletedAt 升序（先删的在前）', () => {
    expect(ids(applyFilters(trashed(), { ...DEFAULT_FILTERS, sortDesc: false }, 'trash'))).toEqual([
      'b',
      'c',
      'a'
    ])
  })
})

describe('sortChangePatch · 切键时方向重置', () => {
  it('换键 → sortDesc 回 null（不继承上一个键的反向）', () => {
    expect(sortChangePatch('size', 'name')).toEqual({ sort: 'name', sortDesc: null })
    expect(sortChangePatch('recent', 'su')).toEqual({ sort: 'su', sortDesc: null })
  })

  it('同一键 → 只写 sort，补丁里不出现 sortDesc（不清掉用户刚调好的方向）', () => {
    const patch = sortChangePatch('name', 'name')
    expect(patch).toEqual({ sort: 'name' })
    expect('sortDesc' in patch).toBe(false)
  })

  it('补丁语义：应用到已有 filters 上，方向确实被重置', () => {
    const current = { ...DEFAULT_FILTERS, sort: 'size' as SortKey, sortDesc: true as boolean | null }
    // 应用"换到名称"的补丁 —— 等价于 App 里的 `setFilter(sortChangePatch(...))`
    const next = { ...current, ...sortChangePatch(current.sort, 'name') }
    expect(next.sort).toBe('name')
    expect(next.sortDesc).toBeNull()
    // 而重复点当前项则保留方向
    const same = { ...current, ...sortChangePatch(current.sort, 'size') }
    expect(same.sortDesc).toBe(true)
  })
})

describe('filtersFromSavedView · sortDesc 白名单（只认布尔字面量）', () => {
  function view(
    filters: Record<string, unknown>,
    sort?: string
  ): Pick<SavedView, 'filters'> & { sort?: string } {
    return { filters, sort }
  }

  it('true / false 原样还原', () => {
    expect(filtersFromSavedView(view({ sortDesc: true })).sortDesc).toBe(true)
    expect(filtersFromSavedView(view({ sortDesc: false })).sortDesc).toBe(false)
  })

  it('缺省 / 字符串 / 数字 / null / 对象 → 一律 null（不猜意图）', () => {
    const dirty: unknown[] = [undefined, 'true', 'false', 'yes', 1, 0, null, {}, []]
    for (const v of dirty) {
      expect(filtersFromSavedView(view({ sortDesc: v })).sortDesc, `脏值 ${JSON.stringify(v)}`).toBeNull()
    }
    // 整个 filters 都不是对象时也不炸
    expect(filtersFromSavedView(view({})).sortDesc).toBeNull()
  })

  it('方向与排序键独立还原（脏方向不影响合法的 sort）', () => {
    const out = filtersFromSavedView(view({ sort: 'size', sortDesc: '倒着来' }, 'size'))
    expect(out.sort).toBe('size')
    expect(out.sortDesc).toBeNull()
  })

  it('本版快照不写 sortDesc：存一个集合再套用 = 回到自然方向', () => {
    // `snapshotFilters` 逐键挑选，方向不在其中（方向的入口是中栏头那枚按钮，不是集合）
    const snap = snapshotFilters({ ...DEFAULT_FILTERS, sort: 'size', sortDesc: false })
    expect('sortDesc' in snap).toBe(false)
    expect(filtersFromSavedView(view(snap, 'size')).sortDesc).toBeNull()
  })
})

/**
 * store 级接线：`setFilter` 是 `filters` 的**唯一写点**，"换键 → 方向回自然方向"落在那里，
 * 所以任何入口（popover 点击 / 键盘回车 / 将来的批量恢复）都自动遵守。
 *
 * 这里驱动的是**真实 action**（不是逻辑副本）——`setFilter` 只读改内存 state，
 * 不需要 Dexie / IPC 桩，见 `tests/savedViewStore.test.ts` 的同类做法。
 */
describe('store.setFilter · 换键重置方向（真实 action）', () => {
  beforeEach(() => {
    useVault.setState({ filters: { ...DEFAULT_FILTERS } })
  })

  it('换了键 → sortDesc 回 null（不继承上一个键的反向）', () => {
    useVault.getState().setFilter({ sort: 'size', sortDesc: true })
    expect(useVault.getState().filters.sortDesc).toBe(true)

    useVault.getState().setFilter({ sort: 'name' })
    expect(useVault.getState().filters.sort).toBe('name')
    expect(useVault.getState().filters.sortDesc).toBeNull()
  })

  it('重复点当前键 → 方向原地保留（不清掉用户刚调好的方向）', () => {
    useVault.getState().setFilter({ sort: 'size', sortDesc: false })
    useVault.getState().setFilter({ sort: 'size' })
    expect(useVault.getState().filters.sort).toBe('size')
    expect(useVault.getState().filters.sortDesc).toBe(false)
  })

  it('方向按钮那条路径：只写 sortDesc，不动 sort', () => {
    useVault.getState().setFilter({ sort: 'su' })
    useVault.getState().setFilter({ sortDesc: true })
    expect(useVault.getState().filters.sort).toBe('su')
    expect(useVault.getState().filters.sortDesc).toBe(true)
  })

  it('显式带 sortDesc 的同一个补丁优先（不会被自动重置覆盖）', () => {
    useVault.getState().setFilter({ sort: 'recent' })
    useVault.getState().setFilter({ sort: 'size', sortDesc: false })
    expect(useVault.getState().filters.sort).toBe('size')
    expect(useVault.getState().filters.sortDesc).toBe(false)
  })
})

/**
 * UI 接线守卫（node 环境渲染不了 React 组件，仓库惯例是守源码形状）。
 *
 * 只钉**契约**，不钉像素：
 * ① 文案读 `effectiveSortDesc(filters.sort, filters.sortDesc)`，而不是原始三态字段
 *    （否则"按大小本来就降序"时按钮文案会错成"当前正序"）；
 * ② 点击**只翻方向**、不收起浮层（按钮块的 `onClick` 直指 `toggleSortDesc`，块内没有
 *    `setSortPanel`）；
 * ③ 按钮与胶囊同处 `sortRef` 容器（浮层的"点外面关闭"判据是 `sortRef.contains`，
 *    放容器外点一下就会把浮层关掉）；
 * ④ 配色只用既有语义 token（`bg-pill` / `text-secondary`），带当前方向的 35% 淡化，
 *    且**没有** Tailwind `dark:` 变体（本项目主题是 `[data-theme]` 属性）。
 */
describe('UI 接线：方向按钮', () => {
  const APP = fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf-8')

  /** 方向按钮自身那段 JSX：从它独有的 className 起、到闭合标签止 */
  function dirButtonJsx(src: string): string {
    const start = src.indexOf('inline-flex h-7 w-7')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('</button>', start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  /** 剥注释（说明文字里必然会出现 `dark:` / 箭头字符这类反例，不剥会误判） */
  function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('按钮在 sortRef 容器内（点它不会触发"点外面关闭浮层"）', () => {
    const container = APP.indexOf('ref={sortRef}')
    const dirButton = APP.indexOf('aria-label={sortDirHint}')
    const saveView = APP.indexOf('0.6.0 智能集合', dirButton)
    expect(container).toBeGreaterThan(-1)
    expect(dirButton).toBeGreaterThan(container)
    expect(saveView).toBeGreaterThan(dirButton)
  })

  it('点击只翻方向、不收起浮层', () => {
    const block = dirButtonJsx(APP)
    expect(block).not.toContain('setSortPanel')
    expect(APP).toContain('setFilter({ sortDesc: !sortDescNow })')
  })

  it('方向取的是生效值（三态归一后的布尔），文案随状态变化且全中文', () => {
    expect(APP).toContain('effectiveSortDesc(filters.sort, filters.sortDesc)')
    expect(APP).toContain('当前降序，点击切换为正序')
    expect(APP).toContain('当前正序，点击切换为降序')
    // 文案里不出现字段名 / 英文 key（用户看到的是方向，不是内部状态）
    for (const hint of ['当前降序，点击切换为正序', '当前正序，点击切换为降序']) {
      expect(hint).not.toMatch(/[A-Za-z]/)
      expect(hint).not.toContain('sortDesc')
    }
    // title 与 aria-label 同一句（不写两遍，避免读屏与悬浮提示不一致）
    expect(dirButtonJsx(APP)).toContain('aria-label={sortDirHint}')
    expect(dirButtonJsx(APP)).toContain('title={sortDirHint}')
  })

  it('配色只用既有 token，无 dark: 变体、无 emoji', () => {
    const block = codeOf(dirButtonJsx(APP))
    expect(block).toContain('rounded-pill-header bg-pill')
    expect(block).toContain('text-secondary')
    expect(block).toContain('stroke="currentColor"')
    expect(block).not.toMatch(/\bdark:/)
    // 反例正则：命中常见 emoji / 箭头字符区段（图标必须是 SVG path，不是字符）
    expect(block).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/u)
  })
})
