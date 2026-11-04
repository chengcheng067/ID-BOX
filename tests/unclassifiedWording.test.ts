/**
 * 「未分类三口径」按语义统一后的守卫（docs/25「待统一 · 「未分类」有三种口径」条目）。
 *
 * ## 本次统一的是什么
 *
 * **语义与判据源**，不是把三个数字强行改成同一个值。三者量的本就不是同一个集合：
 * - ① `countLevel1`：分类树按 `category1` **分组计数**（未分类节点 = 一级未分类，不套筛选）；
 * - ② `isCategoryIncomplete`：中栏头「· 待补 N」，`||`（半归类也算），套当前筛选；
 * - ③ `isUnclassified`：「全库一对都没定」的唯一判据源，`&&`，不套筛选。
 *
 * ## 为什么有「源码守卫」这一段
 *
 * `vitest.config.ts` 是 `environment: 'node'`，没有 jsdom / react-test-renderer，
 * 而中栏头文案、注释口径、选择器初值这类东西既不是纯函数、也挂不上 DOM。
 * 沿用 `tests/triageQueueScope.test.ts` / `tests/importCancelUi.test.ts` 的既有惯例：
 * 用 `readFileSync` 读源码串断言，钉住「改名真的落地、判据没被顺手改坏」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Asset } from '../src/shared/types'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import { normalizeCategoryPair } from '../src/shared/naming'
import {
  categoriesOf,
  countLevel1,
  isCategoryIncomplete
} from '../src/renderer/logic/category'
import { isUnclassified } from '../src/renderer/logic/triageFlow'

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

/** 一条最小合法资产；`category1` / `category2` 由 patch 给，缺省即老数据（无字段） */
function asset(patch: Partial<Asset> = {}): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `资产${seq}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\Lib\\模型\\资产${seq}`,
    relFolder: `模型/未分类/未分类/资产${seq}`,
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

// ── A · 两种判据在「半归类资产」上刻意不同 ───────────────────────────

describe('A · isUnclassified（③ 双未分类）vs isCategoryIncomplete（② 待补）', () => {
  it('★半归类资产（一级已填、二级未分类）：③ false / ② true', () => {
    const half = asset({ category1: '椅子', category2: UNCLASSIFIED })
    expect(categoriesOf(half)).toEqual({ category1: '椅子', category2: UNCLASSIFIED })
    expect(isUnclassified(half)).toBe(false)
    expect(isCategoryIncomplete(half)).toBe(true)
  })

  it('★双未分类（两级都空）：③ true / ② true', () => {
    const none = asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED })
    expect(isUnclassified(none)).toBe(true)
    expect(isCategoryIncomplete(none)).toBe(true)
  })

  it('★完整归类（两级都有值）：③ false / ② false', () => {
    const done = asset({ category1: '椅子', category2: '餐椅' })
    expect(isUnclassified(done)).toBe(false)
    expect(isCategoryIncomplete(done)).toBe(false)
  })

  it('★老数据缺字段 → categoriesOf 兜底为双未分类，两个判据都 true', () => {
    const legacy = asset()
    expect(categoriesOf(legacy)).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
    expect(isUnclassified(legacy)).toBe(true)
    expect(isCategoryIncomplete(legacy)).toBe(true)
  })

  it('★空值防御：null / undefined 两个判据都返回 false（不炸、不算待补）', () => {
    expect(isUnclassified(null)).toBe(false)
    expect(isUnclassified(undefined)).toBe(false)
    expect(isCategoryIncomplete(null)).toBe(false)
    expect(isCategoryIncomplete(undefined)).toBe(false)
  })
})

// ── B · ① countLevel1 仍是「按 category1 分组」 ──────────────────────

describe('B · countLevel1 保留分组判据：半归类计入其一级节点，不进「未分类」节点', () => {
  it('★半归类资产计入「椅子」节点，不计入「未分类」节点', () => {
    const list: Asset[] = [
      asset({ category1: '椅子', category2: UNCLASSIFIED }), // 半归类
      asset({ category1: '椅子', category2: UNCLASSIFIED }), // 半归类
      asset({ category1: '椅子', category2: '餐椅' }), // 完整归类
      asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED }) // 双未分类
    ]
    const nodes = countLevel1(list, 'model')
    const chair = nodes.find((n) => n.value === '椅子')
    const un = nodes.find((n) => n.value === UNCLASSIFIED)

    // 半归类资产留在自己的一级下（2 条半归类 + 1 条完整归类）
    expect(chair?.count).toBe(3)
    // 只有那条双未分类进「未分类」节点
    expect(un?.count).toBe(1)
    // 分组计数不丢不重
    expect(nodes.reduce((sum, n) => sum + n.count, 0)).toBe(list.length)
    // 未分类哨兵恒排最后
    expect(nodes[nodes.length - 1]?.value).toBe(UNCLASSIFIED)
  })

  it('★同一批数据下 ② 与 ③ 的数量本就不同（不强行统一成同一个值）', () => {
    const list: Asset[] = [
      asset({ category1: '椅子', category2: UNCLASSIFIED }),
      asset({ category1: '椅子', category2: UNCLASSIFIED }),
      asset({ category1: '椅子', category2: '餐椅' }),
      asset({ category1: UNCLASSIFIED, category2: UNCLASSIFIED })
    ]
    expect(list.filter(isUnclassified)).toHaveLength(1) // ③ 只认双未分类
    expect(list.filter(isCategoryIncomplete)).toHaveLength(3) // ② 半归类也算待补
  })
})

// ── C · ① 与 ③ 的差异只发生在非法数据上，而它被 normalizeCategoryPair 挡住 ──

describe('C · 非法数据「一级未分类、二级有值」经 normalizeCategoryPair 后二级被降级', () => {
  it('★(未分类, 餐椅) → (未分类, 未分类)，且报 changed', () => {
    const pair = normalizeCategoryPair(UNCLASSIFIED, '餐椅')
    expect(pair.category1).toBe(UNCLASSIFIED)
    expect(pair.category2).toBe(UNCLASSIFIED)
    expect(pair.changed).toBe(true)
  })

  it('★降级前 ① 与 ③ 会分叉；降级后重新一致（注释里那句结论的实测）', () => {
    const illegal = asset({ category1: UNCLASSIFIED, category2: '餐椅' })
    // 降级前：① 按 category1 把它算进「未分类」节点，③ 的 && 不算它
    expect(countLevel1([illegal], 'model').find((n) => n.value === UNCLASSIFIED)?.count).toBe(1)
    expect(isUnclassified(illegal)).toBe(false)

    const pair = normalizeCategoryPair(illegal.category1, illegal.category2)
    const fixed = asset({ category1: pair.category1, category2: pair.category2 })
    // 降级后：两者都认它是双未分类，① 的未分类节点与 ③ 不再有分歧
    expect(isUnclassified(fixed)).toBe(true)
    expect(isCategoryIncomplete(fixed)).toBe(true)
    expect(countLevel1([fixed], 'model').find((n) => n.value === UNCLASSIFIED)?.count).toBe(1)
  })

  it('★正常的半归类（椅子, 未分类）不会被降级（不是非法数据）', () => {
    const pair = normalizeCategoryPair('椅子', UNCLASSIFIED)
    expect(pair.category1).toBe('椅子')
    expect(pair.category2).toBe(UNCLASSIFIED)
    expect(pair.changed).toBe(false)
  })
})

// ── D · 源码守卫（node 环境无 DOM，读源串断言） ───────────────────────

const APP = readFileSync(
  fileURLToPath(new URL('../src/renderer/App.tsx', import.meta.url)),
  'utf-8'
)
const FLOW = readFileSync(
  fileURLToPath(new URL('../src/renderer/logic/triageFlow.ts', import.meta.url)),
  'utf-8'
)
const PICKER = readFileSync(
  fileURLToPath(new URL('../src/renderer/components/CategoryPicker.tsx', import.meta.url)),
  'utf-8'
)
const CATEGORY = readFileSync(
  fileURLToPath(new URL('../src/renderer/logic/category.ts', import.meta.url)),
  'utf-8'
)

describe('D · 源码守卫：文案 / 注释 / 初值语义', () => {
  it('★App.tsx 中栏头显示串出现「待补」，且那句不再拼 UNCLASSIFIED、不再出现「未分类」', () => {
    const displayLine = APP.split('\n').find((l) => l.includes('· 待补 ${pendingCategory}'))
    expect(displayLine).toBeDefined()
    expect(displayLine as string).toContain('待补')
    // ② 的显示串里不再把 UNCLASSIFIED 拼进去；「未分类」这个词也不再出现
    expect(displayLine as string).not.toContain('UNCLASSIFIED')
    expect(displayLine as string).not.toContain('未分类')
    // 旧的整段模板串不许回来
    expect(APP).not.toContain('` · ${UNCLASSIFIED} ${unclassified}`')
  })

  it('★App.tsx 变量名改叫 pendingCategory、判据只调用纯函数（不再内联 ||）', () => {
    expect(APP).toContain('const pendingCategory = assets.filter(isCategoryIncomplete).length')
    expect(APP).not.toContain('const unclassified')
    expect(APP).toContain("import { isCategoryIncomplete } from './logic/category'")
    // ② 的判据（||）不在组件里重写
    expect(APP).not.toContain('category1 === UNCLASSIFIED ||')
  })

  it('★triageFlow.ts 不再含「未实施」，也不再自称「不是全局真理源」', () => {
    expect(FLOW).not.toContain('未实施')
    expect(FLOW).not.toContain('不是全局真理源')
    expect(FLOW).not.toContain('已挂账')
    // ③ 判据一个字节没动，且明确写成「唯一判据源」
    expect(FLOW).toContain('c.category1 === UNCLASSIFIED && c.category2 === UNCLASSIFIED')
    expect(FLOW).toContain('唯一判据源')
    expect(FLOW).toContain('待补')
  })

  it('★CategoryPicker.tsx 初值表达式仍在（统一口径不涉此处）', () => {
    expect(PICKER).toContain('setLevel1(targets[0].category1 || UNCLASSIFIED)')
    expect(PICKER).toContain('setLevel2(targets[0].category2 || UNCLASSIFIED)')
    // 只看「目标集合变化 → 重置为当前值」那个 effect：初值必须仍取 targets[0] 现状，
    // 不能被顺手改成常量哨兵。全仓另有一处合法的 `setLevel1(UNCLASSIFIED)`
    //（deleteCustom 删掉当前一级后的级联复位），不在本守卫范围内。
    const at = PICKER.indexOf('if (pickerIds && targets.length > 0) {')
    expect(at).toBeGreaterThan(-1)
    const block = PICKER.slice(at, PICKER.indexOf('}', at) + 1)
    expect(block).toContain('setLevel1(targets[0].category1 || UNCLASSIFIED)')
    expect(block).toContain('setLevel2(targets[0].category2 || UNCLASSIFIED)')
    expect(block).not.toContain('setLevel1(UNCLASSIFIED)')
    expect(PICKER).toContain('不涉此处')
  })

  it('★category.ts 导出 isCategoryIncomplete，且 countLevel1 上方补了统一后的口径注释', () => {
    expect(CATEGORY).toContain('export function isCategoryIncomplete')
    const at = CATEGORY.indexOf('export function countLevel1(')
    expect(at).toBeGreaterThan(-1)
    const comment = CATEGORY.slice(Math.max(0, at - 1400), at)
    expect(comment).toContain('normalizeCategoryPair')
    expect(comment).toContain('同源')
    expect(comment).toContain('一级未分类')
    expect(comment).toContain('双未分类总量')
  })
})
