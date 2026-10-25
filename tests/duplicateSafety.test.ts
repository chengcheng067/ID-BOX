import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Asset } from '../src/shared/types'
import {
  compareFields,
  duplicateCountMap,
  duplicatesOf,
  extraCopyCount,
  groupDuplicates,
  groupOf,
  keepOnlyTargets
} from '../src/renderer/logic/duplicates'

/**
 * P0 回归：**重复副本不能把本体删掉**（2026-10 用户报）。
 *
 * 事故链（修复前）：
 * ① 软删只写 `deletedAt`，记录仍留在 `store.assets` 里 → 回收站页能选中它；
 * ② `duplicatesOf(assets, 回收站记录 id)` 只按 `id !== self` 排除，把**还活着的**
 *    同 key 资产算成"重复副本"；
 * ③ 「保留这份，其余移入回收站」→ `requestDelete(活着的那些 id)`
 *    → **唯一还在库里的那份被推进回收站**，用户看到的就是「本体也被删了」。
 *
 * 修复：判定只在**活着**的记录之间成立 + 回收站视图整块不渲染 + `keepOnlyTargets()`
 * 从 id 计算层再兜一次底。
 */

let seq = 0
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  const name = patch.name ?? `椅子${n}`
  return {
    id: `id-${n}`,
    name,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\未分类\\未分类\\${name}`,
    relFolder: `模型/未分类/未分类/${name}`,
    files: [{ rel: 'a.skp', name: 'a.skp', ext: 'skp', size: 10, kind: 'model' }],
    size: 10,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:${name}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '未分类',
    category2: '未分类',
    styles: [],
    ...patch
  }
}

/** 同一个 dedupeKey 的活着的资产 */
function live(name = '椅子'): Asset {
  return asset({ name, dedupeKey: `model:${name}` })
}

/** 同 key 但已软删（回收站）的记录 */
function trashed(name = '椅子', deletedAt = 1_700_000_100_000): Asset {
  return asset({ name, dedupeKey: `model:${name}`, deletedAt })
}

// ── ① 重复判定只在活着记录之间成立 ──────────────────────────────

describe('P0：软删记录不参与重复判定', () => {
  it('两条都活着 → duplicatesOf 返回 1 条；其中一条软删 → 返回 0 条', () => {
    const a = live()
    const b = live()
    expect(duplicatesOf([a, b], a.id).map((x) => x.id)).toEqual([b.id])

    const bTrashed = { ...b, deletedAt: 1_700_000_100_000 }
    expect(duplicatesOf([a, bTrashed], a.id)).toEqual([])
    // 只剩自己一份 → 也不构成重复组
    expect(groupDuplicates([a, bTrashed])).toEqual([])
    expect(groupOf([a, bTrashed], a.id)).toBeNull()
  })

  it('已软删的记录自己调 duplicatesOf → 返回 0 条（不能反向把活的算成副本）', () => {
    const a = live()
    const gone = trashed()
    expect(duplicatesOf([a, gone], gone.id)).toEqual([])
    expect(duplicatesOf([gone], gone.id)).toEqual([])
    expect(groupOf([a, gone], gone.id)).toBeNull()
  })

  it('份数 Map 不含软删记录（回收站条目不显示 ×N 角标）', () => {
    const a = live()
    const b = live()
    const c = trashed()
    const map = duplicateCountMap([a, b, c])
    expect(map.get(a.id)).toBe(2)
    expect(map.get(b.id)).toBe(2)
    expect(map.has(c.id)).toBe(false)

    // 只有 1 条活着 + 1 条软删 → 没有重复，Map 为空
    expect(duplicateCountMap([a, c]).size).toBe(0)
    // 侧栏「多余份数」也只算活着的
    expect(extraCopyCount(groupDuplicates([a, c]))).toBe(0)
  })

  it('修复前行为复现：旧口径（只排自己）会返回活着的唯一副本 → 这就是误删的原因', () => {
    const a = live()
    const gone = trashed()
    const all = [a, gone]

    // 旧实现等价复刻：没有 deletedAt 过滤
    const keyOf = (x: Asset): string => x.dedupeKey
    const oldTargets = all
      .filter((x) => x.id !== gone.id && keyOf(x) === keyOf(gone))
      .map((x) => x.id)
    expect(oldTargets).toEqual([a.id]) // ← requestDelete([a.id]) 把唯一活着的推进回收站

    // 新实现：同样输入，返回空
    expect(duplicatesOf(all, gone.id)).toEqual([])
    expect(keepOnlyTargets(all, gone.id)).toEqual([])
  })
})

// ── ② keepOnlyTargets：删除目标 id 的最终兜底 ─────────────────

describe('keepOnlyTargets —— 「保留这份」实际会删哪些 id', () => {
  it('不含保留项自己、不含软删记录、不含不同 key 的资产', () => {
    const keep = live('椅子')
    const copy1 = live('椅子')
    const copy2 = live('椅子')
    const goneCopy = trashed('椅子')
    const other = asset({ name: '沙发', dedupeKey: 'model:沙发' })

    const ids = keepOnlyTargets([keep, copy1, copy2, goneCopy, other], keep.id)

    expect(ids.sort()).toEqual([copy1.id, copy2.id].sort())
    expect(ids).not.toContain(keep.id) // 不删要保留的那份
    expect(ids).not.toContain(goneCopy.id) // 不重复删回收站里的
    expect(ids).not.toContain(other.id) // 不误伤别的资产
  })

  it('保留项已软删 / 不存在 → 返回空数组（回收站里点什么都不会发生）', () => {
    const a = live()
    const gone = trashed()
    expect(keepOnlyTargets([a, gone], gone.id)).toEqual([])
    expect(keepOnlyTargets([a], 'not-exist')).toEqual([])
    expect(keepOnlyTargets([], a.id)).toEqual([])
  })

  it('保留某一份副本时，当前本体也会进删除名单（语义：只留这一份）', () => {
    const a = live('椅子')
    const b = live('椅子')
    expect(keepOnlyTargets([a, b], b.id)).toEqual([a.id])
  })
})

// ── ③ 并排对比的字段差异 ────────────────────────────────────────

describe('compareFields —— 弹窗对比的差异标记', () => {
  it('值不同的字段 differs=true，相同的为 false', () => {
    const a = asset({
      name: '椅子',
      size: 100,
      relFolder: '模型/未分类/未分类/椅子',
      files: []
    })
    const b = asset({
      name: '椅子',
      size: 300,
      relFolder: '模型/未分类/未分类/椅子-2',
      files: []
    })

    const fields = compareFields([a, b])
    const byKey = new Map(fields.map((f) => [f.key, f]))

    expect(byKey.get('size')!.differs).toBe(true)
    expect(byKey.get('size')!.values).toEqual(['100 B', '300 B'])
    expect(byKey.get('relFolder')!.differs).toBe(true)
    expect(byKey.get('name')!.differs).toBe(false) // 显示名相同
    expect(byKey.get('files')!.differs).toBe(false)
    expect(byKey.get('category')!.differs).toBe(false)
  })

  it('SU 版本：一份有、一份没有 → 也算差异（正是用户要看见的）', () => {
    const a = asset({ suVersion: 'SU 2024' })
    const b = asset({ suVersion: undefined })
    const field = compareFields([a, b]).find((f) => f.key === 'suVersion')!
    expect(field.values).toEqual(['SU 2024', ''])
    expect(field.differs).toBe(true)
  })

  it('字段顺序固定（显示名 → 相对路径 → 体积 → 文件数 → 导入时间 → 分类 → SU 版本）', () => {
    expect(compareFields([asset()]).map((f) => f.key)).toEqual([
      'name',
      'relFolder',
      'size',
      'files',
      'importedAt',
      'category',
      'suVersion'
    ])
  })
})

// ── ④ 源码守卫：UI 侧的接线不能回退 ────────────────────────────

describe('源码守卫：回收站视图不提供「保留这份」/ 对比弹窗接线', () => {
  it('详情面板的重复副本区块渲染条件是 `!asset.deletedAt && dupCopies.length > 0`', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'DetailPanel.tsx'),
      'utf8'
    )
    expect(src).toContain('!asset.deletedAt && dupCopies.length > 0')
    // 「保留这份」只能走 keepOnlyTargets（统一兜底），不能直接 map dupCopies
    expect(src).toContain('keepOnlyTargets(assets, keepId)')
    expect(src).not.toContain('dupCopies.map((c) => c.id)')
  })

  it('对比弹窗：横向滚动容器 + 无缩略图占位 + 差异字段强调色', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'DuplicateCompareDialog.tsx'),
      'utf8'
    )
    expect(src).toContain('overflow-x-auto') // 4 列以上可横向滚动
    expect(src).toContain('无缩略图') // 没有缩略图给占位
    expect(src).toContain('f.differs') // 差异字段标记
    expect(src).toContain('text-accent-text') // 复用既有强调色 token
    // 弹窗本身不直接算删除目标 / 不碰删除链路：只回调 onKeep(id)
    expect(src).toContain('onKeep(a.id)')
    expect(src).not.toContain('requestDelete(')
  })

  it('对比弹窗自己接 Esc（Modal 外壳不带键盘处理），且用捕获阶段避免关两层', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'DuplicateCompareDialog.tsx'),
      'utf8'
    )
    expect(src).toContain("if (e.key !== 'Escape') return")
    expect(src).toContain("window.addEventListener('keydown', onKey, true)")
    expect(src).toContain('e.stopPropagation()')
  })

  it('保留某个副本时焦点跟随（select(keepId)），保留当前份时不跳', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src', 'renderer', 'components', 'DetailPanel.tsx'),
      'utf8'
    )
    expect(src).toContain('if (keepId !== asset.id) select(keepId)')
  })
})
