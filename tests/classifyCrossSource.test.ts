/**
 * S2（站方面包屑）解析单测（`docs/35 §3` · T-04 / T-05）。
 *
 * 两条路径分别守：
 * - `s2FromBreadcrumb(crumbs, 'cad')` —— **恒等优先** + 一级别名，绝不走 `mapZhimoCategory`；
 * - `s2FromBreadcrumbGeneric(crumbs, kind)` —— 走既有 `mapZhimoCategory`，表一个字不改。
 *
 * 数据全部是 **2026-10-29 主进程直连详情页实测抓到的真实 `breadcrumb_data`**
 * （sku ID 写在每条用例上，可复现：`https://su.znzmo.com/sumoxing/<id>.html` → 301 →
 * `https://sgt.znzmo.com/sgt/<id>.html`）。这里用**手写数组**而不是 HTML 快照，
 * 是为了让"解析算法"与"HTML 解析"两件事分开测 —— 后者由 `tests/zhimoCover.test.ts` 覆盖。
 *
 * 三个必须钉住的反例（踩过才知道）：
 * 1. `1186414883` 的 `level` 是 `[1, 2, 2]`（**两个并列二级**）→ 必须"逐条试映射"，
 *    "取最深一条"会拿到不映射的 `墙饰墙绘` 而整条丢掉；
 * 2. `mapZhimoCategory('办公空间', 'cad')` 返回 **SU 频道的 `工装/办公空间`** → CAD 绝不能走它，
 *    必须恒等 + 别名得到 `工装空间/办公空间`；
 * 3. `ARR(n>1)` 是"筛不出唯一"→ 整条 `null`，**不许**退到更浅的 crumb 换个粗答案。
 */
import { describe, expect, it } from 'vitest'

import {
  s2FromBreadcrumb,
  s2FromBreadcrumbGeneric,
  type StationCrumb
} from '../src/shared/classifyCrossSource'
import { CAD_LEVEL2_CANONICAL_PARENT, CAD_LEVEL2_MAP } from '../src/shared/taxonomy'

// ── 真实抓包的面包屑（原样照抄 href/level，别手改层级）────────────────────

/** sku 1135394272「工业园厂区厂房景观绿化 施工图」 */
const CRUMB_1135394272: StationCrumb[] = [
  { termId: 14586, name: '园林景观', href: 'f14586', level: 1 },
  { termId: 14521, name: '办公工业景观', href: 'f14586s14521', level: 2 },
  { termId: 18167, name: '厂房景观', href: 'f14586s18167', level: 3 }
]

/** sku 1138820079「上海创智天地商业办公景观」 */
const CRUMB_1138820079: StationCrumb[] = [
  { termId: 14586, name: '园林景观', href: 'f14586', level: 1 },
  { termId: 14521, name: '办公工业景观', href: 'f14586s14521', level: 2 },
  { termId: 18339, name: '办公景观', href: 'f14586s18339', level: 3 }
]

/** sku 1131587879「69套住宅小区园林景观规划平面图」 */
const CRUMB_1131587879: StationCrumb[] = [
  { termId: 14594, name: '建筑设计', href: 'f14594', level: 1 },
  { termId: 14613, name: '规划设计', href: 'f14594s14613', level: 2 },
  { termId: 18181, name: '景观规划', href: 'f14594s18181', level: 3 }
]

/** sku 371284697「各种软膜灯箱喷绘节点大样图」 */
const CRUMB_371284697: StationCrumb[] = [
  { termId: 12890, name: '节点详图', href: 'f12890', level: 1 },
  { termId: 17146, name: '灯节点', href: 'f12890s17146', level: 2 }
]

/** sku 1137756813「天花吊顶 图库」 */
const CRUMB_1137756813: StationCrumb[] = [
  { termId: 17137, name: '其他图纸', href: 'f17137', level: 1 },
  { termId: 17176, name: '吊顶图', href: 'f17137s17176', level: 2 }
]

/** sku 1134052403「结构配筋详图 施工图」 */
const CRUMB_1134052403: StationCrumb[] = [
  { termId: 14588, name: '结构设计', href: 'f14588', level: 1 },
  { termId: 14527, name: '钢结构', href: 'f14588s14527', level: 2 }
]

/** sku 1163552603「2024最新超全工装CAD图库」 */
const CRUMB_1163552603: StationCrumb[] = [
  { termId: 12851, name: 'CAD图库', href: 'f12851', level: 1 },
  { termId: 16150, name: '工装图库', href: 'f12851s16150', level: 2 },
  { termId: 18158, name: '工装综合图库', href: 'f12851s18158', level: 3 }
]

/** sku 1136238891「办公空间 施工图」—— 站方**旧一级** `室内空间`（termId 14585） */
const CRUMB_1136238891: StationCrumb[] = [
  { termId: 14585, name: '室内空间', href: 'f14585', level: 1 },
  { termId: 12842, name: '办公空间', href: 'f14585s12842', level: 2 },
  { termId: 14644, name: '办公室', href: 'f14585s14644', level: 2 }
]

/** sku 592065370「排水沟 大样 施工图」—— 二级 `电气工程节点` 的重名父级要覆盖 */
const CRUMB_592065370: StationCrumb[] = [
  { termId: 12890, name: '节点详图', href: 'f12890', level: 1 },
  { termId: 17149, name: '电气工程节点', href: 'f12890s17149', level: 2 },
  { termId: 14546, name: '给排水节点', href: 'f12890s14546', level: 2 }
]

/** sku 1126047887「300套别墅设计图」—— 二级 `居住区规划` **不在** CAD 词表里 */
const CRUMB_1126047887: StationCrumb[] = [
  { termId: 15370, name: '工装空间', href: 'f15370', level: 1 },
  { termId: 18182, name: '居住区规划', href: 'f15370s18182', level: 2 }
]

// ── T-04：CAD 恒等优先 ──────────────────────────────────────────────────

describe('s2FromBreadcrumb（CAD）：10 条真实 sku 的验收数据', () => {
  /** 只断言落点两级，`viaAlias` 的缺省也是契约的一部分，单独测 */
  const pairOf = (crumbs: StationCrumb[]): [string, string] | null => {
    const parsed = s2FromBreadcrumb(crumbs, 'cad')
    return parsed ? [parsed.level1, parsed.level2] : null
  }

  it('园林景观 > 办公工业景观 > 厂房景观 → 园林景观/办公工业景观（最深那层不在词表，自动退一级）', () => {
    expect(pairOf(CRUMB_1135394272)).toEqual(['园林景观', '办公工业景观'])
  })

  it('园林景观 > 办公工业景观 > 办公景观 → 园林景观/办公工业景观', () => {
    expect(pairOf(CRUMB_1138820079)).toEqual(['园林景观', '办公工业景观'])
  })

  it('建筑设计 > 规划设计 > 景观规划 → 建筑设计/规划设计', () => {
    expect(pairOf(CRUMB_1131587879)).toEqual(['建筑设计', '规划设计'])
  })

  it('节点详图 > 灯节点 → 节点详图/灯节点（只有两级）', () => {
    expect(pairOf(CRUMB_371284697)).toEqual(['节点详图', '灯节点'])
  })

  it('其他图纸 > 吊顶图 → 其他图纸/吊顶图', () => {
    expect(pairOf(CRUMB_1137756813)).toEqual(['其他图纸', '吊顶图'])
  })

  it('结构设计 > 钢结构 → 结构设计/钢结构', () => {
    expect(pairOf(CRUMB_1134052403)).toEqual(['结构设计', '钢结构'])
  })

  it('CAD图库 > 工装图库 > 工装综合图库 → CAD图库/工装图库（二级命中即停，不追三级）', () => {
    expect(pairOf(CRUMB_1163552603)).toEqual(['CAD图库', '工装图库'])
  })

  it('★ 室内空间 > 办公空间 > 办公室 → **工装空间**/办公空间（走别名，不是 SU 的「工装」）', () => {
    const parsed = s2FromBreadcrumb(CRUMB_1136238891, 'cad')
    expect(parsed).not.toBeNull()
    if (!parsed) return
    // 这一条是整个 T-04 的核心断言：绝不许出现 '工装'（SU 频道的一级）
    expect(parsed.level1).toBe('工装空间')
    expect(parsed.level1).not.toBe('工装')
    expect(parsed.level2).toBe('办公空间')
    expect(parsed.viaAlias).toBe('室内空间→工装空间')
    expect(parsed.raw).toEqual(['室内空间', '办公空间', '办公室'])
  })

  it('★ 节点详图 > 电气工程节点 > 给排水节点 → 机电工程/电气工程节点（CANONICAL_PARENT 覆盖）', () => {
    expect(pairOf(CRUMB_592065370)).toEqual(['机电工程', '电气工程节点'])
  })

  it('★ 工装空间 > 居住区规划 → 工装空间/未分类（二级不在词表，只能到一级，不是 null）', () => {
    const parsed = s2FromBreadcrumb(CRUMB_1126047887, 'cad')
    expect(parsed).not.toBeNull()
    expect(parsed?.level1).toBe('工装空间')
    expect(parsed?.level2).toBe('未分类')
    // 一级不是解析出来的别名，就不该带 viaAlias（UI 据此决定要不要说"站方用的是旧叫法"）
    expect(parsed?.viaAlias).toBeUndefined()
  })
})

describe('s2FromBreadcrumb（CAD）：算法边界', () => {
  it('父级按 href 前缀查，不按数组下标（1186414883 的 level = [1, 2, 2]）', () => {
    // `挂画` 的父是第 1 条 `软装陈设`（f765），不是第 2 条（f765s806）。
    // CAD 侧这两个名字都不是 CAD 词条，整条应落到"一级都没命中"→ null
    const crumbs: StationCrumb[] = [
      { termId: 765, name: '软装陈设', href: 'f765', level: 1 },
      { termId: 806, name: '墙饰墙绘', href: 'f765s806', level: 2 },
      { termId: 1035, name: '挂画', href: 'f765s1035', level: 2 }
    ]
    expect(s2FromBreadcrumb(crumbs, 'cad')).toBeNull()
  })

  it('重名二级在没有父条目时按 CANONICAL_PARENT 定（电气工程节点 → 机电工程）', () => {
    // 只剩末级一条（站方偶尔只给最深节点）：靠二级名的唯一归属一级兜底
    const parsed = s2FromBreadcrumb([{ name: '电气工程节点', level: 2 }], 'cad')
    expect(parsed?.level1).toBe('机电工程')
    expect(parsed?.level2).toBe('电气工程节点')
  })

  it('★ 父级真的按 href 查：末条 L2 的父是第一个一级（不是数组里前一条一级）', () => {
    // 若用 `crumbs[i-1]` 当父：`吊顶图` 会挂到 `结构设计` 下 → 不在词表 → 只能退到一级
    // `{其他图纸, 未分类}`；按 href `f17137s` 查父才得到 `{其他图纸, 吊顶图}`。
    const crumbs: StationCrumb[] = [
      { termId: 17137, name: '其他图纸', href: 'f17137', level: 1 },
      { termId: 14588, name: '结构设计', href: 'f14588', level: 1 },
      { termId: 17176, name: '吊顶图', href: 'f17137s17176', level: 2 }
    ]
    const parsed = s2FromBreadcrumb(crumbs, 'cad')
    expect(parsed?.level1).toBe('其他图纸')
    expect(parsed?.level2).toBe('吊顶图')
  })

  it('重名二级的「先出现者胜」是兜底分支：当前 5 组重名**全部**已有 CANONICAL_PARENT 覆盖', () => {
    // 这条守卫的是"覆盖表漏项"——一旦有人往 CAD_LEVEL2_MAP 加一条重名二级却忘了
    // 写 CAD_LEVEL2_CANONICAL_PARENT，这里会红。（`taxonomy.ts` 是别人管的词表，
    // 本模块只读不写，所以用守卫而不是改表。）
    const owners = new Map<string, string[]>()
    for (const [level1, list] of Object.entries(CAD_LEVEL2_MAP)) {
      for (const name of list) {
        if (!owners.has(name)) owners.set(name, [])
        owners.get(name)?.push(level1)
      }
    }
    const duplicated = [...owners.entries()].filter(([, l1s]) => l1s.length > 1)
    expect(duplicated.length).toBeGreaterThan(0) // 前提：确实存在重名
    for (const [name] of duplicated) {
      expect(CAD_LEVEL2_CANONICAL_PARENT[name], `重名二级 ${name} 缺 canonical 父级`).toBeTruthy()
    }
  })

  it('面包屑只有一级 → 一级 + 未分类（旧一级名也走别名）', () => {
    const parsed = s2FromBreadcrumb([{ termId: 14585, name: '室内空间', href: 'f14585', level: 1 }], 'cad')
    expect(parsed?.level1).toBe('工装空间')
    expect(parsed?.level2).toBe('未分类')
    expect(parsed?.viaAlias).toBe('室内空间→工装空间')
  })

  it('一条都对不上 → null（不许编一个「其他图纸」兜底）', () => {
    expect(s2FromBreadcrumb([{ name: '某个不存在的分类', level: 1 }], 'cad')).toBeNull()
  })

  it('空数组 / null / undefined / 全脏条目 → null，不抛错', () => {
    expect(s2FromBreadcrumb([], 'cad')).toBeNull()
    expect(s2FromBreadcrumb(null, 'cad')).toBeNull()
    expect(s2FromBreadcrumb(undefined, 'cad')).toBeNull()
    expect(s2FromBreadcrumb([{ name: '   ' }, { name: '' }], 'cad')).toBeNull()
    expect(s2FromBreadcrumb([{ name: 123 as unknown as string }], 'cad')).toBeNull()
  })

  it('kind 不是 cad → null（本函数只管 CAD，别的 kind 不许借道）', () => {
    expect(s2FromBreadcrumb(CRUMB_1135394272, 'model')).toBeNull()
    expect(s2FromBreadcrumb(CRUMB_1135394272, 'texture')).toBeNull()
  })

  it('绝不产出 SU 频道的一级（工装 / 家装 / 家具 / 灯具…）', () => {
    // CAD 一级与 SU 19 项零交集；这里用最容易串台的「办公空间」验一次
    for (const crumbs of [CRUMB_1136238891, CRUMB_592065370, CRUMB_1126047887]) {
      const parsed = s2FromBreadcrumb(crumbs, 'cad')
      expect(parsed?.level1).not.toBe('工装')
      expect(parsed?.level1).not.toBe('家装')
      expect(parsed?.level1).not.toBe('家具')
    }
  })

  it('raw 是面包屑原文（按 level 升序，同层保持原序）', () => {
    const parsed = s2FromBreadcrumb(CRUMB_592065370, 'cad')
    expect(parsed?.raw).toEqual(['节点详图', '电气工程节点', '给排水节点'])
  })
})

// ── T-05：model / texture / material 走既有映射表 ────────────────────────

describe('s2FromBreadcrumbGeneric：走 mapZhimoCategory（表一个字不动）', () => {
  it('木材 > 板材（texture）→ 木材/板材', () => {
    const parsed = s2FromBreadcrumbGeneric([{ name: '木材' }, { name: '板材' }], 'texture')
    expect(parsed?.level1).toBe('木材')
    expect(parsed?.level2).toBe('板材')
    expect(parsed?.raw).toEqual(['木材', '板材'])
  })

  it('★ 1186414883 的真实面包屑 软装陈设 > 墙饰墙绘 > 挂画 → 软装陈设/挂画（逐条试，不取最深）', () => {
    // ⚠️ 这里**不能**期望 null。docs/35 §3.3 脚注 ¹ 与 docs/28 核准表第 47 行都写明了：
    //    `墙饰墙绘` 是"父级不映射"的 5 条之一，但它的**子级** `挂画` 精确映射到 `软装陈设/挂画`
    //    （`mapZhimoCategory('挂画','model')` = 软装陈设/挂画，站方实测 ID 就是 1186414883）。
    //    "取最深一条再映射"才会拿到 `墙饰墙绘` → null，那是 docs/35 §3.3 明确判为 bug 的写法。
    const crumbs: StationCrumb[] = [
      { termId: 765, name: '软装陈设', href: 'f765', level: 1 },
      { termId: 806, name: '墙饰墙绘', href: 'f765s806', level: 2 },
      { termId: 1035, name: '挂画', href: 'f765s1035', level: 2 }
    ]
    const parsed = s2FromBreadcrumbGeneric(crumbs, 'model')
    expect(parsed?.level1).toBe('软装陈设')
    expect(parsed?.level2).toBe('挂画')
  })

  it('同一面包屑走 texture → null（`软装陈设` 不在材质容器的 33 项并集里，被闸门挡掉）', () => {
    const crumbs: StationCrumb[] = [
      { termId: 765, name: '软装陈设', href: 'f765', level: 1 },
      { termId: 806, name: '墙饰墙绘', href: 'f765s806', level: 2 },
      { termId: 1035, name: '挂画', href: 'f765s1035', level: 2 }
    ]
    expect(s2FromBreadcrumbGeneric(crumbs, 'texture')).toBeNull()
  })

  it('★ 单元素数组要解包：石材拼花（material）→ 石材/石材拼花', () => {
    const parsed = s2FromBreadcrumbGeneric([{ name: '石材' }, { name: '石材拼花' }], 'material')
    expect(parsed?.level1).toBe('石材')
    expect(parsed?.level2).toBe('石材拼花')
  })

  it('★ 多元素数组（筛不出唯一）→ null，且**不**退回更浅的 crumb 换个粗答案', () => {
    // `原木木纹` 在 model 下有两个候选（木纹/原木木纹 与 木材/原木木纹）
    expect(
      s2FromBreadcrumbGeneric([{ name: '木材' }, { name: '原木木纹' }], 'model')
    ).toBeNull()
  })

  it('一级兜底：砖材（只有一级、且它是本地一级）→ 砖材/未分类', () => {
    const parsed = s2FromBreadcrumbGeneric([{ name: '砖材' }], 'texture')
    expect(parsed?.level1).toBe('砖材')
    expect(parsed?.level2).toBe('未分类')
  })

  it('一级兜底只在"试完所有 crumb"之后（木纹 > 木材 要先试到木纹，不能停在木材）', () => {
    // `mapZhimoCategory('木材')` = null（它是贴图一级名，不是二级），`木纹` 是 `ZHIMO_LEVEL1_ONLY`
    const parsed = s2FromBreadcrumbGeneric([{ name: '木纹' }, { name: '木材' }], 'texture')
    expect(parsed?.level1).toBe('木纹')
    expect(parsed?.level2).toBe('未分类')
  })

  it('approx 条目照用，但必须透传 approx:true（夹胶玻璃 → 玻璃/未分类）', () => {
    const parsed = s2FromBreadcrumbGeneric([{ name: '玻璃' }, { name: '夹胶玻璃' }], 'texture')
    expect(parsed?.level1).toBe('玻璃')
    expect(parsed?.level2).toBe('未分类')
    expect(parsed?.approx).toBe(true)
  })

  it('命中精确映射时不带 approx 字段（UI 不会误报"这是近似"）', () => {
    const parsed = s2FromBreadcrumbGeneric([{ name: '木材' }, { name: '板材' }], 'texture')
    expect(parsed && 'approx' in parsed).toBe(false)
  })

  it('空数组 / null / 全脏 → null，不抛错', () => {
    expect(s2FromBreadcrumbGeneric([], 'texture')).toBeNull()
    expect(s2FromBreadcrumbGeneric(null, 'texture')).toBeNull()
    expect(s2FromBreadcrumbGeneric(undefined, 'texture')).toBeNull()
    expect(s2FromBreadcrumbGeneric([{ name: '  ' }, { name: '不存在' }], 'texture')).toBeNull()
  })

  it('闸门：落点一级不属于该 kind 的容器 → null（CAD 名喂 model 不许穿过去）', () => {
    // `平立面系统图` 是 CAD 一级；model 的容器词表里没有它
    expect(s2FromBreadcrumbGeneric([{ name: '平立面系统图' }], 'model')).toBeNull()
  })
})
