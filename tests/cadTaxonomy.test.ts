/**
 * CAD 图纸频道词表（v0.8.5 / `docs/34` + `cad_tree.json`）的契约守卫。
 *
 * 这个文件守四类**看不见的约定**（编译器一条都看不住）：
 *
 * ① **词表与 JSON 逐项同源**：`CAD_LEVEL1_LIST` / `CAD_LEVEL2_MAP` / `CAD_LEVEL3_ALIAS`
 *    全部由脚本从 `cad_tree.json` 生成（不许手抄）。所以这里**直接对着 JSON 断言**——
 *    手抄错一个字、漏一条、顺序错位，都会红。
 * ② **作用域隔离**：CAD 的 97 个二级里有 28 个与 SU 重名、364 条三级里有 24 条与 SU 重名。
 *    不隔离就会双向污染（SU 的「餐厅」落进 `CAD/家装空间/餐厅`、CAD 的「沙发」落进 `家具/沙发`）。
 * ③ **重名节点的归属**：5 组重名二级按 `canonicalParentFromPage` 覆盖一级、
 *    4 组重名三级按"直连能回本支 → 否则先出现者"去重。这两条都是站方事实，不是偏好。
 * ④ **风格册**：CAD 与贴图册**同一数组引用**（20 项、不含 SSR-only 的「其他」）。
 *
 * ⚠️ 断言用的 JSON 是**冻结快照** `tests/fixtures/cad-taxonomy/cad_tree.json`
 * （= `docs/probe/cad-taxonomy/cad_tree.json` 2026-10-29 版，329,664 B / 480 节点）。
 * 为什么不直接读 `docs/probe/`：`.gitignore:16` 把 `docs/probe/` 整目录排除（探针原始样本
 * 按政策不入库），直接读会让**干净 clone / CI 上这个文件红一片**。
 * 快照是会漂的 —— 重跑探针后请一并刷新此夹具（内容变了就是新事实，得同步改断言）。
 *
 * 📌 **如果这些用例红了，先分清是哪一种**（写给半年后的你）：
 * - 红的是「与 JSON 逐项相等 / 计数」类 → 要么生产表被手改了（**回去改代码**，
 *   词表唯一来源是 `docs/34` + 快照），要么**有意更新了词表**——那就必须同时：
 *   ① 重跑探针 → 刷新 `docs/probe/` 的 JSON；② 刷新本夹具
 *   `tests/fixtures/cad-taxonomy/cad_tree.json`；③ 在 `docs/34` 里给这次抄录起一个新版本号。
 *   **三件事缺一不可**，只改夹具不改 docs 等于给词表造了个没出处的副本。
 * - 红的是「匹配行为 / 作用域隔离」类 → 那是匹配逻辑变了，**别动夹具**，
 *   回去看 `autoClassify` 的 cad 支与 `classifyAssetName` 的闸门。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  CAD_LEVEL1_LIST,
  CAD_LEVEL2_CANONICAL_PARENT,
  CAD_LEVEL2_MAP,
  CAD_LEVEL3_ALIAS,
  CHANNEL_LEVEL1,
  LEVEL2_MAP,
  LEVEL3_ALIAS,
  STYLE_LIST_BY_KIND,
  isLevel1AllowedForKind,
  styleListAll,
  styleListOf
} from '../src/shared/taxonomy'
import { autoClassify } from '../src/shared/autoClassify'
import { classifyAssetName } from '../src/shared/classifyAsset'
import { KIND_FOLDER, kindFolder } from '../src/shared/classify'
import { composeRelFolder } from '../src/shared/naming'

// ── 机器可读事实源（只读，断言用）─────────────────────────────
interface JsonNode3 {
  level: 3
  name: string
  url: string
  reachable: boolean
  directUrlRendersOwnBranch: boolean
  parent: { level1: string; level2: string }
}
interface JsonNode2 {
  level: 2
  name: string
  url: string
  canonicalParentFromPage?: string
  parent: { level1: string }
  children?: JsonNode3[]
}
interface JsonNode1 {
  level: 1
  name: string
  children: JsonNode2[]
}
interface JsonTree {
  _meta: { counts: Record<string, number> }
  styles: { items: string[]; renderedCount: number; ssrOnlyNotRendered: string[] }
  categories: JsonNode1[]
}

const TREE = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/cad-taxonomy/cad_tree.json'), 'utf8')
) as JsonTree

/** 展平成 { level1, level2, name, ... } 的三级节点清单（368 项） */
const jsonLevel3 = TREE.categories.flatMap((c1) =>
  c1.children.flatMap((c2) =>
    (c2.children ?? []).map((c3) => ({
      level1: c2.parent.level1,
      level2: c2.name,
      name: c3.name,
      url: c3.url,
      reachable: c3.reachable,
      own: c3.directUrlRendersOwnBranch
    }))
  )
)
/** 展平成 { level1, name } 的二级节点清单（102 项，含 5 组重名） */
const jsonLevel2 = TREE.categories.flatMap((c1) =>
  c1.children.map((c2) => ({ level1: c1.name, name: c2.name, canonical: c2.canonicalParentFromPage }))
)

describe('CAD 词表 · 事实源自检（JSON 本身没坏才谈得上验证代码）', () => {
  it('cad_tree.json 计数与 docs/34 §五 一致（10 / 102 / 97 / 368 / 364）', () => {
    expect(TREE.categories).toHaveLength(10)
    expect(jsonLevel2).toHaveLength(102)
    expect(new Set(jsonLevel2.map((x) => x.name)).size).toBe(97)
    expect(jsonLevel3).toHaveLength(368)
    expect(new Set(jsonLevel3.map((x) => x.name)).size).toBe(364)
    expect(TREE._meta.counts.level1).toBe(10)
    expect(TREE._meta.counts.level2DistinctName).toBe(97)
    expect(TREE._meta.counts.level3).toBe(368)
    expect(TREE._meta.counts.level3DistinctName).toBe(364)
  })
})

describe('CAD_LEVEL1_LIST（docs/34 §一：10 项，站方原序）', () => {
  it('长度 10，与 JSON categories[].name 逐项同序相等（家装空间在工装空间之前）', () => {
    expect(CAD_LEVEL1_LIST).toHaveLength(10)
    expect([...CAD_LEVEL1_LIST]).toEqual(TREE.categories.map((c) => c.name))
    // 站方顺序的手写钉：家装空间(2) 在 工装空间(3) 之前 —— 与 SU 的「家装/工装」习惯相反
    expect(CAD_LEVEL1_LIST.indexOf('家装空间')).toBe(2)
    expect(CAD_LEVEL1_LIST.indexOf('工装空间')).toBe(3)
  })

  it('不含「全部」/「推荐」/「豪宅空间」（docs/34 §0：当前站点查无「推荐」「豪宅空间」）', () => {
    for (const bad of ['全部', '推荐', '豪宅空间']) {
      expect(CAD_LEVEL1_LIST).not.toContain(bad)
    }
  })

  it('与 SU 19 项、贴图 21 项零交集（进 CHANNEL_LEVEL1 的前提）', () => {
    for (const l1 of CAD_LEVEL1_LIST) {
      expect(CHANNEL_LEVEL1.model).not.toContain(l1)
      expect(CHANNEL_LEVEL1.texture).not.toContain(l1)
      expect(CHANNEL_LEVEL1.material).not.toContain(l1)
    }
    expect(CHANNEL_LEVEL1.cad).toBe(CAD_LEVEL1_LIST) // 同一引用，不是副本
  })
})

describe('CAD_LEVEL2_MAP（docs/34 §二：10 键 / 102 项 / 去重 97）', () => {
  it('键数 10、键与 JSON 一级同序；总项数 102、去重 97', () => {
    expect(Object.keys(CAD_LEVEL2_MAP)).toHaveLength(10)
    expect(Object.keys(CAD_LEVEL2_MAP)).toEqual(TREE.categories.map((c) => c.name))
    const all = Object.values(CAD_LEVEL2_MAP).flat()
    expect(all).toHaveLength(102)
    expect(new Set(all).size).toBe(97)
  })

  it('每个一级下的二级清单与 JSON 逐项同序相等（10 组全覆盖，不是抽查）', () => {
    for (const c1 of TREE.categories) {
      expect(CAD_LEVEL2_MAP[c1.name], `${c1.name} 二级清单`).toEqual(c1.children.map((c) => c.name))
    }
  })

  it('5 组重名二级：两处都保留（键不同不冲突），且页面归属唯一', () => {
    const dups = new Map<string, string[]>()
    for (const [l1, list] of Object.entries(CAD_LEVEL2_MAP)) {
      for (const l2 of list) dups.set(l2, [...(dups.get(l2) ?? []), l1])
    }
    const multi = [...dups.entries()].filter(([, owners]) => owners.length > 1)
    expect(multi.map(([name]) => name).sort()).toEqual(
      ['建筑节点', '景观图库', '景观节点详图', '电气工程节点', '结构节点图'].sort()
    )
    // 与 JSON 的 canonicalParentFromPage 逐项一致
    for (const [name] of multi) {
      const canon = new Set(jsonLevel2.filter((x) => x.name === name).map((x) => x.canonical))
      expect(canon.size, `${name} 页面归属应唯一`).toBe(1)
    }
  })

  it('CAD_LEVEL2_CANONICAL_PARENT：恰为那 5 组，取值 = canonicalParentFromPage', () => {
    const keys = Object.keys(CAD_LEVEL2_CANONICAL_PARENT).sort()
    expect(keys).toEqual(['建筑节点', '景观图库', '景观节点详图', '电气工程节点', '结构节点图'].sort())
    for (const [name, level1] of Object.entries(CAD_LEVEL2_CANONICAL_PARENT)) {
      const node = jsonLevel2.find((x) => x.name === name)!
      expect(node.canonical, `${name} 归属`).toBe(level1)
      // 覆盖目标必须真在该一级的二级清单里
      expect(CAD_LEVEL2_MAP[level1], `${name} 不在 ${level1} 下`).toContain(name)
    }
  })

  it('⚠️ 不并进 LEVEL2_MAP：CAD 10 个一级一个都不是 LEVEL2_MAP 的键', () => {
    for (const l1 of CAD_LEVEL1_LIST) {
      expect(Object.prototype.hasOwnProperty.call(LEVEL2_MAP, l1), l1).toBe(false)
    }
  })

  it('★ 重名规模就是"必须分表"的证据：28 个二级 / 24 条三级与 SU 词表同名', () => {
    const suL2 = new Set(Object.values(LEVEL2_MAP).flat())
    const overlap2 = [...new Set(Object.values(CAD_LEVEL2_MAP).flat())]
      .filter((t) => suL2.has(t))
      .sort()
    expect(overlap2).toEqual(
      [
        '别墅', '卧室', '客厅', '餐厅', '儿童房', '客餐厅', '茶室', '卫生间', '书房', '阳台',
        '厨房', '衣帽间', '洗衣房', '玄关', '办公空间', '餐饮空间', '商业空间', '公共空间',
        '医疗空间', '景观小品', '庭院景观', '公园景观', '广场景观', '商业景观', '商业建筑',
        '办公建筑', '公共建筑', '交通建筑'
      ].sort()
    )
    expect(overlap2).toHaveLength(28)

    const suL3 = new Set([...suL2, ...LEVEL3_ALIAS.map((a) => a.term)])
    const overlap3 = CAD_LEVEL3_ALIAS.map((a) => a.term)
      .filter((t) => suL3.has(t))
      .sort()
    expect(overlap3).toEqual(
      [
        '沙发', '柜子', '桌子', '窗帘', '地毯', '挂画', '摆件', '鱼缸', '人物', '动物', '壁炉',
        '背景墙', '文化墙', '屏风隔断', '晾衣架', '桁架', '大平层', '单身公寓', '商场', '企业展厅',
        '栏杆', '办公景观', '集装箱', '城市规划',
        // v0.8.6 派生词带来的新重名：`健身器材` 也是 SU `电器/器材` 的二级。
        // ⚠️ 这是**我们主动加的派生词**，不是抄录错误 —— 别去查站方词表。
        // 隔离由 `level2Scope:'cad'` 保证：CAD 侧扫 `CAD_LEVEL3_ALIAS`，
        // SU 侧扫 `LEVEL3_ALIAS`，两边互不可见（`cadTaxonomy` 的"反向不污染"用例守着）。
        '健身器材'
      ].sort()
    )
    expect(overlap3).toHaveLength(25)
  })
})

/**
 * 归并表分两类：
 * - **站方节点**（364 条）：`source` 是 sgt 页面 URL，必须在 JSON 快照里找得到同三元组；
 * - **派生归并词**（v0.8.6 起）：站方**没有**这个节点，是我们按真值补的别名，
 *   `source` 以「派生自」开头并注明词的类型（简称/截断/同义/下义词/复合长形）。
 *   ⚠️ 两类必须分开断言：派生词**不允许**出现在 JSON 里（出现了说明其实抄漏了站方节点，
 *   那就该走"补抄录"流程进 `CAD_LEVEL2_MAP`，而不是当派生词塞进 alias）。
 */
const DERIVED_PREFIX = '派生自'
const isDerived = (a: { source?: string }): boolean => (a.source ?? '').startsWith(DERIVED_PREFIX)
const stationRows = CAD_LEVEL3_ALIAS.filter((a) => !isDerived(a))
const derivedRows = CAD_LEVEL3_ALIAS.filter((a) => isDerived(a))

describe('CAD_LEVEL3_ALIAS（docs/34 §三：368 项 → 364 站方 + 13 派生 = 377）', () => {
  it('长度 378 = 364 站方 + 14 派生，且 term 唯一（重复会让命中归因不可复现）', () => {
    // 377 = 364 站方 + 13 派生。
    // ⚠️ 候选表里曾出现 `博物馆`，但**没有**落成派生词：它已经是站方三级节点
    // `工装空间 > 文化空间 > 博物馆`，再加一条到 `建筑设计/文化建筑` 会撞 term
    // （匹配器是扁平表，没有"同名 alias 按一级区分"的能力），且会覆盖站方语义。
    // 那 4 条真值标 文化建筑 的标题是站方"树 vs 列表页"自相矛盾，属数据问题。
    // → 下一轮看到"候选表有博物馆、表里没有"是**故意**的，别再加一遍。
    expect(CAD_LEVEL3_ALIAS).toHaveLength(377)
    expect(stationRows).toHaveLength(364)
    expect(derivedRows).toHaveLength(13)
    const terms = CAD_LEVEL3_ALIAS.map((a) => a.term)
    expect(new Set(terms).size).toBe(377)
  })

  it('★ 站方 364 条每一条都能在 JSON 里找到同 (一级, 二级, 名称) 的节点 —— 全覆盖，不是抽查', () => {
    const triples = new Set(jsonLevel3.map((n) => `${n.level1}|${n.level2}|${n.name}`))
    for (const a of stationRows) {
      expect(triples.has(`${a.level1}|${a.level2}|${a.term}`), `${a.term} → ${a.level1}/${a.level2}`).toBe(true)
    }
  })

  it('★ 派生词一条都不在 JSON 里（在的话说明是抄漏，该走补抄录而不是当派生）', () => {
    const triples = new Set(jsonLevel3.map((n) => `${n.level1}|${n.level2}|${n.name}`))
    for (const a of derivedRows) {
      expect(triples.has(`${a.level1}|${a.level2}|${a.term}`), `${a.term} 其实在站方树里，别当派生词`).toBe(false)
    }
  })

  it('★ 派生词必须写明词类型（防止"碎片词"混进来）', () => {
    const KINDS = ['简称', '截断', '同义', '下义词', '复合长形']
    for (const a of derivedRows) {
      expect(a.source, `${a.term} 的 source 必须注明词类型`).toMatch(/派生自「.+」，非站方节点 · (.+)/)
      expect(KINDS.some((k) => a.source!.includes(k)), `${a.term} 的词类型不在白名单里：${a.source}`).toBe(true)
    }
  })

  it('★ JSON 里 364 个不同三级名一个都没漏（含 21 项「点不进去」的）', () => {
    const ours = new Map(stationRows.map((a) => [a.term, a]))
    const missing = [...new Set(jsonLevel3.map((n) => n.name))].filter((n) => !ours.has(n))
    expect(missing).toEqual([])
    // 21 项 reachable:false 的也必须进表（我们要的是文件名匹配，不是导航）
    const unreachable = jsonLevel3.filter((n) => !n.reachable)
    expect(unreachable).toHaveLength(21)
    for (const n of unreachable) expect(ours.has(n.name), `${n.name} 未进表`).toBe(true)
  })

  it('★ 被丢掉的恰是 4 条同名另一支（3 个机电节点 + 展台），一条不多一条不少', () => {
    const ours = new Map(stationRows.map((a) => [a.term, a]))
    const dropped = jsonLevel3
      .filter((n) => {
        const kept = ours.get(n.name)
        return kept !== undefined && (kept.level1 !== n.level1 || kept.level2 !== n.level2)
      })
      .map((n) => `${n.level1}/${n.level2}/${n.name}`)
      .sort()
    expect(dropped).toEqual(
      [
        '工装空间/展厅/展台',
        '节点详图/电气工程节点/暖通节点',
        '节点详图/电气工程节点/电气节点',
        '节点详图/电气工程节点/水处理节点'
      ].sort()
    )
  })

  it('3 个机电节点取「机电工程/电气工程节点」（直连 URL 落到那支）', () => {
    for (const term of ['暖通节点', '电气节点', '水处理节点']) {
      const row = CAD_LEVEL3_ALIAS.find((a) => a.term === term)!
      expect(row.level1, term).toBe('机电工程')
      expect(row.level2, term).toBe('电气工程节点')
      // 事实佐证：JSON 里这一支 own=true，另一支 own=false
      const own = jsonLevel3.find((n) => n.name === term && n.level1 === '机电工程')!
      const other = jsonLevel3.find((n) => n.name === term && n.level1 === '节点详图')!
      expect(own.own, `${term} 机电工程支应能直连回本支`).toBe(true)
      expect(other.own, `${term} 节点详图支直连落到另一支`).toBe(false)
    }
  })

  it('`展台` 取先出现的 `工装空间/公共空间`（页面顺序：公共空间在展厅之前）', () => {
    const row = CAD_LEVEL3_ALIAS.find((a) => a.term === '展台')!
    expect(row.level1).toBe('工装空间')
    expect(row.level2).toBe('公共空间')
    const order = TREE.categories
      .find((c) => c.name === '工装空间')!
      .children.map((c) => c.name)
    expect(order.indexOf('公共空间')).toBeLessThan(order.indexOf('展厅'))
    // 两个父级都真实存在（另一归属客观存在，只是不重复入表）
    expect(CAD_LEVEL2_MAP['工装空间']).toContain('公共空间')
    expect(CAD_LEVEL2_MAP['工装空间']).toContain('展厅')
  })

  it('每一行的 level1/level2 都是 CAD 表内的合法组合（否则会落出跨类目录）', () => {
    for (const a of CAD_LEVEL3_ALIAS) {
      expect(CAD_LEVEL2_MAP[a.level1], `${a.term} → 未知 CAD 一级 ${a.level1}`).toBeDefined()
      expect(CAD_LEVEL2_MAP[a.level1], `${a.term} → ${a.level1}/${a.level2} 非法`).toContain(a.level2)
    }
  })

  it('站方条目带节点 URL、派生条目写清派生依据（两者格式都要可复核）', () => {
    for (const a of stationRows) {
      expect(a.source, `${a.term} 缺站方 URL`).toMatch(/^https:\/\/sgt\.znzmo\.com\/sgt\//)
    }
    for (const a of derivedRows) {
      expect(a.source, `${a.term} 缺派生说明`).toMatch(/^派生自「.+」，非站方节点/)
    }
  })

  it('抽查 5 条（固定 5 条 + 种子伪随机的另 5 条）：{term, level1, level2} 与 JSON 一致', () => {
    const picked = ['图例', '沙发', '火锅店', '商场', '暖通节点']
    for (const term of picked) {
      // 固定抽查必须是**站方节点**（派生词不在 JSON 里，见上面的专测）
      const row = stationRows.find((a) => a.term === term)!
      const node = jsonLevel3.find(
        (n) => n.name === term && n.level1 === row.level1 && n.level2 === row.level2
      )
      expect(node, `${term} 在 JSON 里找不到对应节点`).toBeDefined()
      expect({ term: row.term, level1: row.level1, level2: row.level2 }).toEqual({
        term,
        level1: node!.level1,
        level2: node!.level2
      })
    }
    // 种子伪随机（可复现）：从 364 条里另外抽 5 条
    let seed = 20261029
    for (let k = 0; k < 5; k++) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const row = stationRows[seed % stationRows.length]!
      const node = jsonLevel3.find(
        (n) => n.name === row.term && n.level1 === row.level1 && n.level2 === row.level2
      )
      expect(node, `${row.term} → ${row.level1}/${row.level2}`).toBeDefined()
    }
  })

  it('⚠️ 不污染全局：CAD 三级词一条都没进 LEVEL3_ALIAS（SU 归并表仍是 10 条）', () => {
    expect(LEVEL3_ALIAS).toHaveLength(10)
    const suTerms = new Set(LEVEL3_ALIAS.map((a) => a.term))
    // 几个 SU 里绝对不该有的 CAD 专有三级词
    for (const t of ['火锅店', '图例', '指北针', '明档', '树池']) {
      expect(suTerms.has(t), `${t} 是 CAD 三级，不得进 SU 归并表`).toBe(false)
    }
  })
})

describe('风格册（docs/34 §四：20 项，与贴图册逐项相等）', () => {
  it('styleListOf(cad) 与 styleListOf(texture) 逐项同序相等，长度 20', () => {
    expect(styleListOf('cad')).toHaveLength(20)
    expect(styleListOf('cad')).toEqual(styleListOf('texture'))
    expect([...styleListOf('cad')]).toEqual(TREE.styles.items) // 与 JSON 的 20 项一致
    expect(TREE.styles.items).toHaveLength(TREE.styles.renderedCount)
  })

  it('是同一个数组引用（toBe，证明不是复制出来的第二份）', () => {
    expect(STYLE_LIST_BY_KIND.cad).toBe(STYLE_LIST_BY_KIND.texture)
  })

  it('不含 SSR-only 的「其他」（界面永不渲染，按 20 项入代码）', () => {
    expect(TREE.styles.ssrOnlyNotRendered).toEqual(['其他'])
    expect(styleListOf('cad')).not.toContain('其他')
    expect(styleListOf('cad')).not.toContain('全部')
    // 与 SU 册的唯一差异仍只在下标 18（简洁 ↔ 简欧）
    expect(styleListOf('cad')[18]).toBe('简欧')
    expect(styleListOf('model')[18]).toBe('简洁')
  })

  it('styleListAll() 仍是 21 项（cad 与 texture 同引用，不新增并集项）', () => {
    expect(styleListAll()).toHaveLength(21)
  })
})

describe('匹配行为 · CAD 二级（level2Scope:cad）', () => {
  it('「别墅」→ 家装空间/别墅（CAD 二级原文命中，matchedLevel=cad-l2）', () => {
    const hit = autoClassify('别墅', undefined, { level2Scope: 'cad' })
    expect(hit).toMatchObject({
      category1: '家装空间',
      category2: '别墅',
      matchedTerm: '别墅',
      alternativeCategories1: [],
      matchedLevel: 'cad-l2'
    })
  })

  it('「餐厅」→ CAD 的家装空间/餐厅（不是 SU 的家装/餐厅）', () => {
    expect(classifyAssetName('餐厅', undefined, 'cad')).toEqual({
      category1: '家装空间',
      category2: '餐厅'
    })
    // 对照：同一个词在 model 作用域下仍是 SU 的答案
    expect(classifyAssetName('餐厅', undefined, 'model')).toEqual({
      category1: '家装',
      category2: '餐厅'
    })
  })

  it('「生态主题餐厅工装平面图」→ 平立面系统图/平面图（尾锚定命中「平面图」）', () => {
    // ⚠️ 这个结果与"直觉上的 餐饮空间"不同，是**规则 1（CJK 尾锚定）+ 最长优先**的
    // 必然后果：名字以「平面图」结尾，而「平面图」是站方真实二级（3 字 > 2 字）。
    // 站方的「平立面系统图」正是按图纸类型分的一级，故这是合法归属，不是错分。
    // 若要改成"内容优先"，是**产品裁定**（需另开单），不在词表接线范围内。
    expect(classifyAssetName('生态主题餐厅工装平面图', undefined, 'cad')).toEqual({
      category1: '平立面系统图',
      category2: '平面图'
    })
  })

  it('文件名也参与二级匹配（CAD 包内 .dwg 名同样能命中）', () => {
    expect(classifyAssetName('未命名包', ['给排水.dwg'], 'cad')).toEqual({
      category1: '机电工程',
      category2: '给排水'
    })
  })

  it('CAD 一级也能落（一档匹配，二级留未分类）', () => {
    expect(classifyAssetName('结构设计', undefined, 'cad')).toEqual({
      category1: '结构设计',
      category2: '未分类'
    })
  })
})

describe('匹配行为 · CAD 三级归并（level2Scope:cad）', () => {
  it('「火锅店」→ 工装空间/餐饮空间（三级归并，matchedLevel=cad-l3）', () => {
    // 「火锅店」在 JSON 里确实是 工装空间 > 餐饮空间 下的三级节点（已由上文全覆盖断言保证）
    const hit = autoClassify('火锅店', undefined, { level2Scope: 'cad' })
    expect(hit).toMatchObject({
      category1: '工装空间',
      category2: '餐饮空间',
      matchedTerm: '火锅店',
      matchedLevel: 'cad-l3'
    })
  })

  it('「沙发」→ CAD图库/家具图库（三级归并）；同一词在 model 下是 家具/沙发', () => {
    expect(classifyAssetName('沙发', undefined, 'cad')).toEqual({
      category1: 'CAD图库',
      category2: '家具图库'
    })
    expect(classifyAssetName('沙发', undefined, 'model')).toEqual({
      category1: '家具',
      category2: '沙发'
    })
  })

  it('「商场」「酒吧」分别落到 CAD 的 商业空间 / 休闲娱乐空间', () => {
    expect(classifyAssetName('商场', undefined, 'cad')).toEqual({
      category1: '工装空间',
      category2: '商业空间'
    })
    expect(classifyAssetName('酒吧', undefined, 'cad')).toEqual({
      category1: '工装空间',
      category2: '休闲娱乐空间'
    })
  })

  it('「暖通节点」→ 机电工程/电气工程节点（双归属取直连落点那支）', () => {
    const hit = autoClassify('暖通节点', undefined, { level2Scope: 'cad' })
    expect(hit).toMatchObject({
      category1: '机电工程',
      category2: '电气工程节点',
      matchedTerm: '暖通节点',
      matchedLevel: 'cad-l3'
    })
  })
})

describe('作用域隔离 · 反向不污染', () => {
  it('不传 scope 时 CAD 词一条都不参与（「火锅店」→ null）', () => {
    expect(autoClassify('火锅店')).toBeNull()
    // 而 SU 的既有命中不受影响
    expect(autoClassify('沙发')).toMatchObject({ category1: '家具', category2: '沙发' })
  })

  it('★CAD 表外的一律不外借：未命中直接 null，不回落通用词表（v0.8.5 裁定）', () => {
    // 这三个词都能被**别的频道**的通用词表命中（LOFT → 家装户型/LOFT、实木门 → 硬装构件/门、
    // 大理石瓷砖 → 瓷砖/大理石瓷砖），而 CAD 表里没有它们。cad 作用域下必须一个都不外借 ——
    // 否则就是"能泄漏的通道 + 靠下游闸门拦着"，且白白算一遍 SU/贴图词表。
    for (const name of ['LOFT', '实木门', '大理石瓷砖']) {
      expect(autoClassify(name, undefined, { level2Scope: 'cad' }), name).toBeNull()
      // 对照：不带 scope 时它们仍有别的频道的答案（证明是"作用域收口"，不是"词表坏了"）
      expect(autoClassify(name), name).not.toBeNull()
    }
    // 端到端仍是双哨兵
    for (const name of ['LOFT', '实木门', '大理石瓷砖']) {
      expect(classifyAssetName(name, undefined, 'cad'), name).toEqual({
        category1: '未分类',
        category2: '未分类'
      })
    }
    // ⚠️ 反例钉一下别误伤：`双人床` 看似"SU 的家具词"，但 `床` 是 CAD 自己的三级词条
    // （CAD图库 > 家具图库 > 床），故 cad 作用域**必须**命中 —— 这不是外借。
    expect(autoClassify('双人床', undefined, { level2Scope: 'cad' })).toMatchObject({
      category1: 'CAD图库',
      category2: '家具图库',
      matchedTerm: '床',
      matchedLevel: 'cad-l3'
    })
  })

  it('model 侧：28 个重名二级一律走 SU 的答案，不进 CAD', () => {
    const cases: Array<[string, string, string]> = [
      ['餐厅', '家装', '餐厅'],
      ['卧室', '家装', '卧室'],
      ['办公空间', '工装', '办公空间'],
      ['商业空间', '工装', '商业空间']
    ]
    for (const [name, c1, c2] of cases) {
      expect(classifyAssetName(name, undefined, 'model'), name).toEqual({
        category1: c1,
        category2: c2
      })
    }
  })

  it('texture 侧：CAD 二级不参与（「别墅」→ 未分类，不落 CAD 的家装空间）', () => {
    // 贴图/材质走的是容器词表，「别墅」在材质树里没有对应一级 → 双哨兵
    expect(classifyAssetName('别墅', undefined, 'texture')).toEqual({
      category1: '未分类',
      category2: '未分类'
    })
    // 对照：CAD 下同一个词有答案
    expect(classifyAssetName('别墅', undefined, 'cad').category1).toBe('家装空间')
  })

  it('一级闸门：CAD 一级只对 cad 放行，且不泄漏到 model', () => {
    for (const l1 of CAD_LEVEL1_LIST) {
      expect(isLevel1AllowedForKind('cad', l1), l1).toBe(true)
      expect(isLevel1AllowedForKind('model', l1), l1).toBe(false)
      expect(isLevel1AllowedForKind('texture', l1), l1).toBe(false)
      expect(isLevel1AllowedForKind('material', l1), l1).toBe(false)
    }
    // 反向：模型/贴图的一级也不被 cad 放行
    expect(isLevel1AllowedForKind('cad', '家装')).toBe(false)
    expect(isLevel1AllowedForKind('cad', '石材')).toBe(false)
    expect(isLevel1AllowedForKind('cad', '')).toBe(false)
  })

  it('一级轮也按 scope 换键：level1Only + cad 能命中 CAD 一级，不带 scope 命中不了', () => {
    expect(autoClassify('结构设计', undefined, { level1Only: true, level2Scope: 'cad' })).toMatchObject({
      category1: '结构设计',
      category2: '未分类'
    })
    expect(autoClassify('结构设计', undefined, { level1Only: true })).toBeNull()
  })
})

describe('重名二级的 level1 归属（5 组，取页面实际归属）', () => {
  const cases: Array<[string, string, string]> = [
    ['景观图库', '园林景观', 'CAD图库'],
    ['景观节点详图', '园林景观', '节点详图'],
    ['结构节点图', '结构设计', '节点详图'],
    ['建筑节点', '建筑设计', '节点详图'],
    ['电气工程节点', '机电工程', '节点详图']
  ]

  for (const [term, canonical, other] of cases) {
    it(`「${term}」→ ${canonical}（另一归属 ${other} 进 alternativeCategories1）`, () => {
      expect(classifyAssetName(term, undefined, 'cad')).toEqual({
        category1: canonical,
        category2: term
      })
      const hit = autoClassify(term, undefined, { level2Scope: 'cad' })
      expect(hit?.category1).toBe(canonical)
      expect(hit?.alternativeCategories1).toEqual([other])
    })
  }
})

describe('落盘路径不受影响（KIND_FOLDER.cad = CAD）', () => {
  it('CAD 资产的 relFolder 第一段是 CAD，其后是一级/二级/名', () => {
    expect(KIND_FOLDER.cad).toBe('CAD')
    const out = classifyAssetName('火锅店', undefined, 'cad')
    const rel = composeRelFolder(kindFolder('cad'), out.category1, out.category2, '火锅店')
    expect(rel.split('/')).toEqual(['CAD', '工装空间', '餐饮空间', '火锅店'])
  })
})
