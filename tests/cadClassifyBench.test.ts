/**
 * CAD 分类**基准台**（v0.8.5）：打表量现状 + 三条验收线。
 *
 * 背景：CAD 词表接上之后，"匹配策略该不该改"只能用数据回答 —— 图种轴
 * （平面图 / 立面图 / 节点详图 / 施工图）和内容轴（别墅 / 餐厅 / 沙发）在知末的
 * 分类树里是两根互相竞争的轴，而匹配器吃的是**尾锚定**，谁在名字末尾谁赢。
 *
 * 数据：`tests/fixtures/cad-taxonomy/labeled-titles.json` —— **站方真值**（1091 条，
 * 知末二级列表页标题 → 它天然所属的一级/二级）。文件不在 → 整档 `skip`，绝不让全量变红。
 * ⚠️ 这套指标**只能用真值跑**。手写"拟真样本"曾把命中率报成 67.5%（真值是 30.8%），
 * 已删除，别再加回来。
 *
 * 本文件两部分：
 * 1. `量现状 + 三个上限` —— 纯 `console.log` 打表（量具）；
 * 2. `回归线` —— 三条硬断言，守 v0.8.5 两个改动的净收益与"文件名不再回流"。
 *
 * 跑法：`npx vitest run tests/cadClassifyBench.test.ts`
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CAD_LEVEL2_MAP, CAD_LEVEL3_ALIAS } from '../src/shared/taxonomy'
import { autoClassify } from '../src/shared/autoClassify'
import { classifyAssetName } from '../src/shared/classifyAsset'

interface LabelRow {
  title: string
  zhimoId?: number
  level1: string
  level2: string
  level3?: string | null
  /** 夹具里条目自身的三级名（采集页第三排） */
  own3?: string | null
  /** 采集页给的三级（旧字段，兼容） */
  itemOwn?: { first?: string; base?: string; third?: string }
  fromUrl?: string
}
interface LabelFile {
  rows: LabelRow[]
}

/** 真值三级：`level3` 优先，其次夹具的 `own3`，再次采集页 `itemOwn.third` */
const level3Of = (r: LabelRow): string | null => r.level3 ?? r.own3 ?? r.itemOwn?.third ?? null

const REAL = 'tests/fixtures/cad-taxonomy/labeled-titles.json'
/** 采集 worker 的落点在 `docs/probe/`（被 .gitignore 排除）——真值先到那边时也直接能量 */
const REAL_PROBE = 'docs/probe/cad-taxonomy/labeled-titles.json'
const abs = (p: string): string => path.join(process.cwd(), p)
const exists = (p: string): boolean => fs.existsSync(abs(p))
const REAL_PATH = exists(REAL) ? REAL : exists(REAL_PROBE) ? REAL_PROBE : null
const load = (p: string): LabelRow[] => (JSON.parse(fs.readFileSync(abs(p), 'utf8')) as LabelFile).rows

/** 二级严格命中：一级与二级都要对 */
const isL2Hit = (row: LabelRow, out: { category1: string; category2: string }): boolean =>
  out.category1 === row.level1 && out.category2 === row.level2
const isBothMiss = (out: { category1: string; category2: string }): boolean =>
  out.category1 === '未分类' && out.category2 === '未分类'

/** CAD 一级里那三个"图种/图库"册 —— 用来量"图种词把资产吸走"的规模 */
const DRAWING_TYPE_SINKS = new Set(['平立面系统图', '节点详图', 'CAD图库'])

/** 包内真实文件名固定池（docs/probe/cad-probe.md:515-524 那 10 个） */
const REAL_FILE_NAMES = [
  '60 1F-2F立面图.dwg',
  '20-50 2F平面图.dwg',
  '94 台盆柜大样图.dwg',
  '94 固定家具节点详图.dwg',
  '索引图例.dwg',
  'SD_Cover.dwg',
  'FrameA2.dwg',
  '1F平面图.dwg',
  '2F平面图.dwg',
  '餐厅平面设计方案.dwg'
]

/** 剥尾词用的有界词表。**长的排在前面**（否则 `平面图` 会先被 `图` 吃掉） */
const STRIP_TAILS = [
  '施工图纸', '施工图', '节点详图', '节点图', '大样图', '三视图', '立面图', '剖面图',
  '平面图', '方案图', '设计图', '放大图', '详图', '图纸', '图'
]

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)
const pad = (s: string, n: number): string => {
  // 中文按 2 宽近似对齐（够看即可，不做终端宽度精确计算）
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}

/** 词条可能带 `/`（如 `立面图/剖面图`），拆开逐个做尾锚定 */
const endsWithAnyPart = (text: string, term: string | null | undefined): boolean => {
  if (!term) return false
  return (term.includes('/') ? term.split('/') : [term]).some((p) => p.length > 0 && text.endsWith(p))
}

/** 与匹配器同口径的分词（非字母数字/CJK 都是分隔符）—— 真实标题普遍是空格串关键词 */
const TOKEN_SPLIT = /[^A-Za-z0-9\u4e00-\u9fff]+/
const tokensOf = (s: string): string[] => s.toLowerCase().split(TOKEN_SPLIT).filter(Boolean)

/** 逐层剥尾词，每剥一层就问一次"真值能不能尾锚定命中" */
function stripReachable(title: string, row: LabelRow): { ok: boolean; depth: number; last: string } {
  const l3 = level3Of(row)
  const hit = (t: string): boolean =>
    endsWithAnyPart(t, row.level2) || endsWithAnyPart(t, l3) || t.endsWith(row.level1)
  let ok = false
  let depth = 0
  for (const raw of tokensOf(title)) {
    let cur = raw
    for (let d = 0; d <= 4; d++) {
      if (hit(cur)) {
        ok = true
        depth = Math.max(depth, d)
        break
      }
      const tail = STRIP_TAILS.find((t) => cur.length > t.length + 1 && cur.endsWith(t))
      if (tail === undefined) break
      cur = cur.slice(0, -tail.length).trimEnd()
    }
  }
  return { ok, depth, last: '' }
}

interface RowResult {
  row: LabelRow
  predicted: { category1: string; category2: string }
  predictedWithFile: { category1: string; category2: string }
  matchedTerm: string | undefined
  matchedLevel: string | undefined
}

function measure(rows: LabelRow[]): RowResult[] {
  return rows.map((row, i) => {
    const predicted = classifyAssetName(row.title, undefined, 'cad')
    const predictedWithFile = classifyAssetName(row.title, [REAL_FILE_NAMES[i % REAL_FILE_NAMES.length]!], 'cad')
    const raw = autoClassify(row.title, undefined, { level2Scope: 'cad' })
    return { row, predicted, predictedWithFile, matchedTerm: raw?.matchedTerm, matchedLevel: raw?.matchedLevel }
  })
}

function report(rows: LabelRow[], tag: string): void {
  const res = measure(rows)
  const n = res.length
  const l1Ok = (r: RowResult): boolean => r.predicted.category1 === r.row.level1
  const l2Ok = (r: RowResult): boolean => isL2Hit(r.row, r.predicted)
  const fileL2Ok = (r: RowResult): boolean =>
    r.predictedWithFile.category1 === r.row.level1 && r.predictedWithFile.category2 === r.row.level2
  const bothMiss = (r: RowResult): boolean => isBothMiss(r.predicted)

  const c1 = res.filter(l1Ok).length
  const c2 = res.filter(l2Ok).length
  const l1OkL2Wrong = res.filter((r) => l1Ok(r) && !l2Ok(r)).length
  const miss = res.filter(bothMiss).length
  const wrong = res.filter((r) => !l2Ok(r)).length
  const sink = res.filter((r) => DRAWING_TYPE_SINKS.has(r.predicted.category1)).length
  // 「吸走」= 真值**不在**图种三册，却被预测进图种三册（这才是"图种词把资产吸走"）
  const suckedFromOthers = res.filter(
    (r) => !DRAWING_TYPE_SINKS.has(r.row.level1) && DRAWING_TYPE_SINKS.has(r.predicted.category1)
  ).length
  const othersTruth = res.filter((r) => !DRAWING_TYPE_SINKS.has(r.row.level1)).length
  const fileC2 = res.filter(fileL2Ok).length

  console.log(`\n===== [${tag}] 样本 ${n} 条 =====`)
  console.log(`一级命中率        ${c1}/${n}  ${pct(c1, n)}`)
  console.log(`二级命中率(严格)  ${c2}/${n}  ${pct(c2, n)}`)
  console.log(`一级对/二级错     ${l1OkL2Wrong}/${n}  ${pct(l1OkL2Wrong, n)}   ← 最长优先选错轴的主要来源`)
  console.log(`双未分类          ${miss}/${n}  ${pct(miss, n)}`)
  console.log(`预测落图种三册    ${sink}/${n}  ${pct(sink, n)}   （平立面系统图 / 节点详图 / CAD图库，含本来就该落的）`)
  console.log(
    `★被图种册吸走     ${suckedFromOthers}/${othersTruth}  ${pct(suckedFromOthers, othersTruth)}   （真值不在三册、却被判进三册 = 纯误吸）`
  )
  console.log(`★带包内文件名后二级命中 ${fileC2}/${n}  ${pct(fileC2, n)}  （掉 ${(((c2 - fileC2) / n) * 100).toFixed(1)} 个点）`)

  // 按真值一级分组（同时就是「每个一级下有多少条资产」的条目数分布）
  const groups = new Map<string, RowResult[]>()
  for (const r of res) groups.set(r.row.level1, [...(groups.get(r.row.level1) ?? []), r])
  console.log(`\n-- 按真值一级分组（条目数 = 该一级在样本里的资产数）--`)
  console.log(
    `${pad('一级', 14)}${pad('条目数', 8)}${pad('占比', 8)}${pad('一级命中', 11)}${pad('二级命中', 11)}${pad('双未分类', 11)}落图种册`
  )
  // v0.8.5 取舍标注：这两册退为兜底桶后是被**主动削**的，看表时别误以为退化
  const SHRUNK: Record<string, string> = {
    平立面系统图: ' ← 主动削（内容压图种），25.0% → 17.5%',
    节点详图: ' ← 主动削（内容压图种），38.0% → 37.0%'
  }
  for (const l1 of [...groups.keys()].sort((a, b) => groups.get(b)!.length - groups.get(a)!.length)) {
    const g = groups.get(l1)!
    console.log(
      `${pad(l1, 14)}${pad(String(g.length), 8)}${pad(pct(g.length, n), 8)}${pad(pct(g.filter(l1Ok).length, g.length), 11)}` +
        `${pad(pct(g.filter(l2Ok).length, g.length), 11)}${pad(pct(g.filter(bothMiss).length, g.length), 11)}` +
        `${g.filter((r) => DRAWING_TYPE_SINKS.has(r.predicted.category1)).length}${SHRUNK[l1] ?? ''}`
    )
  }

  // 最差 diff
  const worst = res
    .filter((r) => !l2Ok(r))
    .sort((a, b) => Number(bothMiss(b)) - Number(bothMiss(a)) || Number(l1Ok(b)) - Number(l1Ok(a)))
    .slice(0, 30)
  console.log(`\n-- 最差 ${worst.length} 条 --`)
  for (const r of worst) {
    const truth = `${r.row.level1}/${r.row.level2}${r.row.level3 ? `(${r.row.level3})` : ''}`
    const got = `${r.predicted.category1}/${r.predicted.category2}`
    console.log(
      `${pad(truth, 26)}→ ${pad(got, 26)} 词=${r.matchedTerm ?? '—'}${r.matchedLevel ? `[${r.matchedLevel}]` : ''}  ｜ ${r.row.title}`
    )
  }

  // ── 三个理论上限（只量天花板，不实现策略）──────────────────────
  const l2Terms = Object.values(CAD_LEVEL2_MAP).flat()
  const l3Terms = CAD_LEVEL3_ALIAS.map((a) => a.term)

  // ① 后缀剥离上限
  let rescuedNew = 0
  let rescuedAll = 0
  const rescueDepth: Record<number, number> = {}
  for (const r of res) {
    const s = stripReachable(r.row.title, r.row)
    if (!s.ok) continue
    rescuedAll++
    if (!l2Ok(r)) {
      rescuedNew++
      rescueDepth[s.depth] = (rescueDepth[s.depth] ?? 0) + 1
    }
  }
  console.log(`\n-- 上限① 后缀剥离（${STRIP_TAILS.length} 个尾词，长的优先，逐层问尾锚定）--`)
  console.log(
    `可达 ${rescuedAll}/${n} ${pct(rescuedAll, n)} ｜ 现状没命中 ${wrong} 条 → 可新救回 ${rescuedNew}/${wrong} = ${pct(rescuedNew, wrong)} ｜ 需剥几层 ${JSON.stringify(rescueDepth)}`
  )

  // ② 任意位置包含上限
  const incL2 = res.filter(({ row }) => row.title.includes(row.level2)).length
  const incL3 = res.filter(({ row }) => {
    const l3 = level3Of(row)
    return l3 ? row.title.includes(l3) : false
  }).length
  const incAny = res.filter(({ row }) => {
    const l3 = level3Of(row)
    return row.title.includes(row.level2) || (l3 ? row.title.includes(l3) : false)
  }).length
  console.log(`-- 上限② 任意位置包含（"放开成 includes"的天花板）--`)
  console.log(
    `includes(真值二级) ${incL2}/${n} ${pct(incL2, n)} ｜ includes(真值三级) ${incL3}/${n} ${pct(incL3, n)} ｜ 二者任一 ${incAny}/${n} ${pct(incAny, n)} ｜ 现状严格命中 ${c2}/${n} ${pct(c2, n)}`
  )

  // ②b 词表天花板（oracle）：真值那个 (一级,二级) 下的**任何**词条出现在标题里就算可达
  const byCat = new Map<string, string[]>()
  for (const [l1, list] of Object.entries(CAD_LEVEL2_MAP)) {
    for (const l2 of list) byCat.set(`${l1}/${l2}`, l2.includes('/') ? l2.split('/') : [l2])
  }
  for (const a of CAD_LEVEL3_ALIAS) {
    const k = `${a.level1}/${a.level2}`
    byCat.set(k, [...(byCat.get(k) ?? []), a.term])
  }
  let oracleInc = 0
  let oracleEnd = 0
  for (const { row } of res) {
    const terms = byCat.get(`${row.level1}/${row.level2}`) ?? []
    const toks = tokensOf(row.title)
    if (terms.some((t) => row.title.includes(t))) oracleInc++
    // 与匹配器同口径：**任一 token 以该词结尾**（不是整串结尾）
    if (terms.some((t) => toks.some((tok) => tok.endsWith(t)))) oracleEnd++
  }
  console.log(`-- 上限②b 词表天花板（真值那一格里**任一**词条出现即算可达）--`)
  console.log(
    `任意位置 ${oracleInc}/${n} ${pct(oracleInc, n)} ｜ 尾锚定 ${oracleEnd}/${n} ${pct(oracleEnd, n)} ｜ 现状二级命中 ${c2}/${n} ${pct(c2, n)}`
  )

  // ②c 词表**补词**的天花板：标题里有真值二级的「词头」（前 2 字）但没有完整词 → 靠同义/省略形才救得回
  const headOnly = res.filter(({ row }) => {
    const head = row.level2.slice(0, 2)
    return head.length === 2 && row.title.includes(head) && !row.title.includes(row.level2)
  }).length
  const headAny = res.filter(({ row }) => row.title.includes(row.level2.slice(0, 2))).length
  console.log(`-- 上限②c 词表补词（同义/省略形）--`)
  console.log(
    `标题含真值二级词头(前 2 字) ${headAny}/${n} ${pct(headAny, n)} ｜ 其中有词头但无完整词 ${headOnly}/${n} ${pct(headOnly, n)}  ← 这部分只能靠补词表（如 办公空间→办公室/办公楼）`
  )

  // ③ includes 策略的假阳性/抢答风险（粗估）
  let truthMid = 0
  let longSteal = 0
  for (const { row, predicted } of res) {
    if (!(predicted.category1 === row.level1 && predicted.category2 === row.level2)) continue
    if (row.title.includes(row.level2) && !endsWithAnyPart(row.title, row.level2)) truthMid++
    const longer = [...l2Terms, ...l3Terms].filter(
      (t) => t.length > row.level2.length && row.title.endsWith(t) && t !== row.level2
    )
    if (longer.length > 0) longSteal++
  }
  console.log(`-- 上限③ includes 抢答风险（只在**当前已对**的 ${c2} 条里看）--`)
  console.log(
    `真值 term 出现在中间但不在结尾 ${truthMid}/${c2} ${pct(truthMid, c2)} ｜ 结尾有更长词可被抢走 ${longSteal}/${c2} ${pct(longSteal, c2)}`
  )

  // 文件名塌陷（两档：固定池轮询 = 平均伤害；单一 `1F平面图.dwg` = 最坏情况）
  const collapsed = res.filter((r) => r.predictedWithFile.category1 === '平立面系统图' && r.predictedWithFile.category2 === '平面图').length
  let worstCaseL2 = 0
  for (const { row } of res) {
    const got = classifyAssetName(row.title, ['1F平面图.dwg'], 'cad')
    if (got.category1 === row.level1 && got.category2 === row.level2) worstCaseL2++
  }
  console.log(
    `-- 包内文件名档 --\n池轮询：塌进 平立面系统图/平面图 ${collapsed}/${n} ${pct(collapsed, n)} ｜ 二级命中 ${c2} → ${fileC2}\n` +
      `最坏情形（每行都配 1F平面图.dwg）：二级命中 ${c2} → ${worstCaseL2}（掉 ${(c2 - worstCaseL2)} 条）`
  )
  console.log('')
}

/**
 * 「内容压图种」这笔取舍的**代价**，钉在这里。
 *
 * `CAD_DRAWING_TYPE_LEVEL1`（`平立面系统图` / `节点详图`）是主动退成兜底桶的那两个册：
 * 两趟都命中时，内容册的答案优先。它净赚 14 条（救 13 / 伤 3），代价就是下面这 3 条 ——
 * 真值本来就是 `平立面系统图`，但标题里出现了房间/空间内容词。
 *
 * 为什么必须写成测试：这是**我们主动削一个册**的产品取舍，不能只活在 commit message 里。
 * 将来若有人把 `CAD_DRAWING_TYPE_LEVEL1` 置空（回退到 353 那版），这三条会立刻变绿，
 * 而 13 条救回会变红 —— 一改就看得见。
 */
describe.skipIf(REAL_PATH === null)('内容压图种的代价（平立面系统图 组 25.0% → 17.5%）', () => {
  it('★这三条真值是 平立面系统图，但被判进了内容册（已知取舍）', () => {
    const cases: Array<[string, string, string]> = [
      [
        '家装立面图 客厅立面图 餐厅立面图 卧室立面图 厨房立面图 卫生间立面图 施工图',
        '家装空间',
        '卫生间' // 一包多房间立面图，站方归「卫生间」；我们取最后一个内容词
      ],
      ['展厅立面图 施工图', '工装空间', '展厅'],
      ['145㎡咖啡厅平面图', '工装空间', '餐饮空间']
    ]
    for (const [title, c1, c2] of cases) {
      expect(classifyAssetName(title, undefined, 'cad'), title).toEqual({ category1: c1, category2: c2 })
    }
  })

  it('★但 `平立面系统图` 组不得被削到 15% 以下（防止将来词表一改把这组清零）', () => {
    const rows = load(REAL_PATH!).filter((r) => r.level1 === '平立面系统图')
    const hit = rows.filter((r) => isL2Hit(r, classifyAssetName(r.title, undefined, 'cad'))).length
    console.log(`
[平立面系统图组] ${hit}/${rows.length} = ${pct(hit, rows.length)}（v0.8.5 取舍后基线 17.5%，取舍前 25.0%）`)
    expect(rows.length, '真值里应有一批平立面系统图的行').toBeGreaterThan(10)
    expect(hit / rows.length, '平立面系统图 组被削过头了 —— 检查 CAD_DRAWING_TYPE_LEVEL1').toBeGreaterThanOrEqual(0.15)
  })
})

describe.skipIf(REAL_PATH === null)('CAD 分类基准台 · 站方真值（labeled-titles.json）', () => {
  it('量现状 + 三个上限（打表，不做断言）', () => {
    const rows = load(REAL_PATH!)
    report(rows, `站方真值 · 全部（${REAL_PATH}）`)
  })

  /**
   * 验收线（不是精确值，留余量防脆）。
   *
   * 这三条守的是 v0.8.5 两个改动的**净收益**与**不再回流**：
   * - 剥离图种尾词 + 文件名只兜底 → 二级严格命中 30.8% → 34% 上下
   * - 双未分类 52.2% → 47% 上下
   * - 反向：给每条都配 `60 1F-2F立面图.dwg`，二级命中不得低于 30%
   *   （合并池时代这一项是 1.8% —— 有人把 fileNames 塞回第一趟，这条立刻红）
   */
  it('回归线：二级命中 ≥ 0.33、双未分类 ≤ 0.52、统一配 立面图.dwg 后二级命中 ≥ 0.30', () => {
    const rows = load(REAL_PATH!)
    const total = rows.length
    const res = measure(rows)
    const l2 = res.filter((r) => isL2Hit(r.row, r.predicted)).length
    const miss = res.filter(
      (r) => r.predicted.category1 === '未分类' && r.predicted.category2 === '未分类'
    ).length
    // 反向：把最毒的那个文件名配给**每一条**，看会不会塌
    const worst = rows.filter((row) =>
      isL2Hit(row, classifyAssetName(row.title, ['60 1F-2F立面图.dwg'], 'cad'))
    ).length

    console.log(
      `\n[回归线] total=${total} 二级命中=${l2} (${pct(l2, total)}) 双未分类=${miss} (${pct(miss, total)}) 配立面图后=${worst} (${pct(worst, total)})`
    )
    expect(l2 / total, '二级严格命中率跌破 0.33 —— 剥尾/兜底被改坏了？').toBeGreaterThanOrEqual(0.33)
    expect(miss / total, '双未分类超过 0.52 —— 命中能力退化了？').toBeLessThanOrEqual(0.52)
    expect(worst / total, '配 立面图.dwg 后塌缩 —— fileNames 又被塞回第一趟了？').toBeGreaterThanOrEqual(0.3)
  })
})
