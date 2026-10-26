/**
 * 知末站方分类名 → 本地分类 的**显式映射表**（「导入时自动落库」的前置件）。
 *
 * ⚠️ 本阶段**只提供数据与纯函数，不写任何库**：`src/main` / Dexie / `E:/ModVault/Library`
 * 都没有接线。接线方案与未决项见 `docs/28-知末分类映射-样本核准.md`。
 *
 * ── 为什么需要这张表 ────────────────────────────────────────────────
 * `src/main/zhimoCover.ts` 已经从详情页解析出站方 `classifyBaseName`（站方分类树里
 * **最深节点**的名字：二级或三级），但只解析不落库（见该文件 `ZhimoDetailExtras` 注释）。
 * 原因是站方的**三级轴**与本地重排过的**两级分类**不是一一对应：
 * - 站方二级写法与本地不同：`酒店民宿` / `筒灯射灯` / `椅子` / `布艺软饰` / `墙饰墙绘`…
 * - 站方三级节点（`卡座沙发` / `屏风` / `镜子` / `茶柜`）在本地没有同名二级；
 * - 站方贴图/材质频道的一级与本地同名一级语义错位（站方 `木纹 > 木材`，本地 `木纹` 是一级）。
 * 所以不能直接 `asset.category1 = classifyBaseName`，必须查表。
 *
 * ── 纪律（改动本文件前先读）────────────────────────────────────────
 * 1. **只做精确查表**（`trim()` 后全等）。没有任何包含/前缀/模糊匹配 ——
 *    「包含某字就归某类」正是会把 `藤编屏风` 拉进 `木材/藤编` 的那类错误。
 *    查不到 → `null`，调用方落 `未分类`，绝不猜。
 * 2. **每一条都要有出处**：`source` 指向 `docs/05` / `docs/07` / `docs/17` / `docs/18`
 *    的具体章节与行号，或「站方实测」的真实商品 ID（2026-10-26 抓详情页 `__NEXT_DATA__`）。
 *    词条**逐项照抄**，禁止凭记忆补、禁止自创。
 * 3. **一对多只列候选**：同一个站方名字可能落本地多个二级（贴图与材质同名、
 *    同名二级跨一级），此时返回**候选数组**，不替用户选。
 * 4. **拿不准的不进表**：宁可不分（返回 null），也不写错。清单见 `ZHIMO_HUMAN_REVIEW`，
 *    与 `docs/28 §5` 的裁定表逐条对应（2026-10-26 已全部定案：10 条按 kind 分流 + 5 条不映射）。
 * 5. **零 IO、零 electron / node 依赖**（与 `taxonomy.ts` / `autoClassify.ts` 同纪律），
 *    可直接单测；表在模块加载时一次性摊平成只读索引。
 *
 * ── 2026-10-26 用户拍板的三条口径（本文件已实现）──────────────────
 * 1. **多候选按资产大类分流**（拍板 B）：`mapZhimoCategory(name, kind)` ——
 *    kind 能唯一确定 → 返回**单个落点**；该 kind 在候选里没有匹配 → **退回候选数组**（不猜）；
 *    不传 kind → 与改造前完全一致（数组 / null，对象形状零变化）。
 *    10 条一对多的裁定结果见 `ZHIMO_KIND_ROUTING`。
 * 2. **站方只给一级 → 只写一级**：返回 `{ category1, category2: '未分类', level: 1 }`
 *    （`ZhimoLevel1Target`，用 `isLevel1Only()` 判定），清单见 `ZHIMO_LEVEL1_ONLY`。
 *    判据：站方 `classifyBaseName` **本身就是一级名**且本地有同名一级（实测只有 `木纹`）。
 * 3. **本地没有的类目 → 就近归并**（用户拍板，架构侧持保留意见）：返回带
 *    `approx: true` + `stationName` + `approxReason` 的落点，清单见 `ZHIMO_APPROX`。
 *    ⚠️ 规则**只活在表里**，不许散到 importer/store 的 if 分支；站方原值可用资产名里的
 *    ID 从详情页重新取回，所以删改表里的条目即可**一键重映射**，无需改调用点。
 *    `夹胶玻璃` → 玻璃、`红砖` → 砖材 是"一级近似"（`level:1` + `approx:true`）。
 *
 * ── 覆盖口径（计数见 `zhimoMapStats()`，抽样核准见 docs/28）──────────
 * - 贴图频道：`docs/07 §3` 21 组 195 项（剔除 `taxonomy.EXCLUDED_TERMS` 已判为商品名的 4 项）
 * - 材质频道：`docs/18 §3` 20 组 106 项（「其他」组站方无二级排，不建条目）
 * - SU 模型频道：`docs/05 §5` 六组【事实】86 项（剔除 2 个品牌名 → 84 项）
 * - 三级节点归并：`docs/17 §4`（7 个节点）+ `§4.1`（3 个派生词）共 10 项
 * - 站方实测：2026-10-26 从用户库 58 条真实 ID 抓到的名字（每条带 ID）
 * - **合计 58 组 / 386 个唯一名字 / 396 个落点**，其中 10 个名字有 2 个候选。
 *   这组数字由 `zhimoMapStats()` 现算，`tests/zhimoTaxonomyMap.test.ts` 里有精确断言
 *   （改表就必须同步 docs/28 与断言，防止"表悄悄变了、报告还是旧的"）。
 * - 另有 **1 条「只有一级确定」**（`木纹`，`ZHIMO_LEVEL1_ONLY`）
 *   与 **6 条「就近归并」**（`ZHIMO_APPROX`），均不计入 386。
 *   `玻璃` / `金属` 因在本地同时是 `模型/SU材质` 的二级（二义）**未登记一级-only**，仍返回 null。
 *   （`夹胶玻璃` → 玻璃 是另一条 `approx`，用站方父链的一级做近似，不是"玻璃"这个名字的一级-only。）
 *
 * 📌 未覆盖的部分**不是站方没有**：SU 模型频道另外 13 个一级的二级全表尚未抄录
 * （`docs/17 §3.2` 明确写了「不要拿没抄到当站方没有」），所以本表对它们没有条目。
 * 要扩展必须先补抄录（走 `docs/06 §12.2` 流程），**不要**用名字相似去补。
 *
 * ⚠️ **材质树也只抄到两级，站方存在三级**（与 `docs/07` 同性质）：实测 `石材 > 墙砖 > 其他石材`、
 * `玻璃 > 玻璃屏幕 > 其他玻璃`，`墙砖` / `玻璃屏幕` 不在 `docs/18` 的 106 条里。
 * 因此本表对这两个名字**没有条目**（本地也无安全落点，不硬凑）；将来补抄录的入口是 `docs/18`。
 */

import { UNCLASSIFIED } from './taxonomy'
import type { AssetKind } from './types'

/** 站方频道（只用于标注来源与统计，不参与匹配） */
export type ZhimoMapChannel = 'model' | 'texture' | 'material'

/** 所有落点的公共字段 */
interface ZhimoTargetBase {
  category1: string
  category2: string
  /** 该条的证据来源（文档章节 + 行号 / 站方实测商品 ID） */
  source: string
  /** 站方父链原文（详情页 `breadcrumb_data` 或 docs 表格），留档与消歧用 */
  stationPath?: readonly string[]
  /** 需要提醒的坑（同名、站方父链异常、本地词表写法差异…） */
  note?: string
  /**
   * 缺省 = 2（两级都确定）；`1` = **只有一级确定**（二级是哨兵「未分类」）。
   * 老的两级落点**不写该字段**，对象形状与改造前一字不差。
   */
  level?: 1 | 2
}

/**
 * 一个落点。`category1/category2` 必须都存在于本地受控词表（`tests/zhimoTaxonomyMap.test.ts` 守卫）。
 *
 * 运行时**不会**带 `level`（保持既有两级条目对象形状不变）；类型上允许 `1 | 2`
 * 只是为了让「一级-only / 近似」在结构上兼容本类型，便于老调用方零改动。
 */
export interface ZhimoCategoryTarget extends ZhimoTargetBase {}

/**
 * 「**只有一级确定**」的落点（2026-10-26 用户拍板第 2 个问题）。
 *
 * 背景：站方 `classifyBaseName` 有时**本身就是一级名**（实测 `木纹`，见下），
 * 本地这一级存在但没有同名二级 —— 此时「只写一级、二级留未分类」是用户选定的口径，
 * 不能返回 null（否则一级这个确定信息就丢了），也不能硬塞一个二级。
 *
 * 与 `ZhimoCategoryTarget` 的**类型区分**：本类型**必有** `level: 1`，
 * 且 `category2` 收紧为哨兵 `'未分类'`；两级都确定的结果**没有** `level` 字段
 * （保持既有两级条目的对象形状一字不变）。落库侧用 `isLevel1Only()` 或 `t.level === 1` 判定，
 * 据此决定日志口径与是否给用户提示"这条只分到一级"。
 *
 * 判据（写死，不许放宽）：
 * - 站方 `classifyBaseName` 本身就是**站方一级名**（`docs/05 §2` / `docs/07 §2`），
 *   且本地存在**同名一级**；
 * - 本地**没有**同名二级（否则按二级落，优先级见 `mapZhimoCategory` 注释）；
 * - 名字在本地**不是任何二级**（否则会产生二义，例如 `地毯` / `挂画`，这种不登记）。
 */
export interface ZhimoLevel1Target extends ZhimoTargetBase {
  category2: typeof UNCLASSIFIED
  level: 1
}

/**
 * **就近归并**的落点（2026-10-26 用户拍板第 3 个问题）。
 *
 * 用户选择"本地没有对应类目时，就近归并到相近类目"。为了让这类数据**可回溯、可一键重映射**，
 * 每一条都必须在 `ZHIMO_APPROX` 表里显式登记，并把三个字段带到返回值上：
 * - `stationName`：站方原话（`classifyBaseName`，即资产名里的 ID 反查能重新取回的那个值）；
 * - `approxReason`：**为什么算相近**（人工判定，必须写，不许空）；
 * - `source`：抄录出处 / 实测商品 ID。
 *
 * 落库侧看到 `approx: true` 必须：① 日志写"按相近类目归并"而不是"站方分类"；
 * ② 以后纠正时按 `approx` 一次性筛出。
 *
 * `level: 1` 的近似（`夹胶玻璃` → 玻璃、`红砖` → 砖材）表示**连二级都没有归并**，
 * 只把站方父链上的那一级写进去 —— 它们仍带 `approx: true`，因为丢掉的是站方的更细名字。
 */
export interface ZhimoApproxTarget extends ZhimoTargetBase {
  approx: true
  stationName: string
  approxReason: string
}

/** 查表可能返回的元素：两级确定 / 一级-only / 就近归并 */
export type ZhimoLookupTarget = ZhimoCategoryTarget | ZhimoLevel1Target | ZhimoApproxTarget

/** `isLevel1Only()` 收窄后的类型（一级-only 或 一级近似） */
export type ZhimoLevel1LikeTarget =
  | ZhimoLevel1Target
  | (ZhimoApproxTarget & { level: 1 })

/**
 * 类型守卫：该落点是否「只有一级确定」（含"一级近似"）。
 *
 * 不要靠 `category2 === '未分类'` 猜：哨兵可能被别的路径写入；只认 `level === 1`。
 */
export function isLevel1Only(target: ZhimoLookupTarget): target is ZhimoLevel1LikeTarget {
  return target.level === 1
}

/**
 * 组内的一条「站方名 → 本地二级」。
 * - `category2` 与 `station` 不同 = 站方写法与本地词表不一致（如 `酒店民宿` → `酒店/民宿`）；
 * - 缺省 `source` 时继承所在组的 `source`；
 * - `kinds` 覆盖该条的适用大类（缺省继承组级），用于一对多时按资产大类分流。
 */
export interface ZhimoMapPair {
  station: string
  category2: string
  source?: string
  stationPath?: readonly string[]
  note?: string
  /** 适用资产大类；缺省继承组级（组级缺省 = 该组 channel 对应的大类） */
  kinds?: readonly AssetKind[]
}

/**
 * 一组映射。`terms` 是「站方名与本地二级同名」的**简写**（逐项照抄），
 * `pairs` 用于写法不同或需要额外标注的条目；两者可以并存。
 */
export interface ZhimoMapGroup {
  /** 组级来源（该组所有 terms 都出自这里） */
  source: string
  channel: ZhimoMapChannel
  /** 组内条目共同的本地一级 */
  category1: string
  terms?: readonly string[]
  pairs?: readonly ZhimoMapPair[]
  /** 组级适用大类；缺省 = `[channel]` */
  kinds?: readonly AssetKind[]
}


/**
 * 映射表数据源（**唯一权威是这里**）。
 *
 * 新增条目的流程：
 * 1. 先在 `docs/05` / `docs/07` / `docs/17` / `docs/18` 找到原文（或抓真实详情页）；
 * 2. 在对应组追加一行，`source` 写章节 + 行号（实测写商品 ID）；
 * 3. 跑 `tests/zhimoTaxonomyMap.test.ts`（会校验落点确实存在于受控词表）；
 * 4. `docs/28` 的样本核准表同步更新命中率。
 */
export const ZHIMO_MAP_GROUPS: readonly ZhimoMapGroup[] = [
  // ══ 贴图频道：docs/07 §3 逐组照抄（站方二级名 = 本地同名二级）════════════
  {
    source: 'docs/07 §3.1（L78）',
    channel: 'texture',
    category1: '石材',
    terms: [
      '水磨石', '岩板', '文化石', '洞石', '花岗岩', '奢石', '火山岩', '人造石', '石材拼花', '石雕', '莱姆石',
    ]
  },
  {
    source: 'docs/07 §3.2（L95）',
    channel: 'texture',
    category1: '砖材',
    terms: [
      '马赛克', '仿古砖', '外墙砖', '户外砖', '踢脚线', '腰线', '波打线', '门槛石',
    ]
  },
  {
    source: 'docs/07 §3.3（L109）',
    channel: 'texture',
    category1: '大理石',
    terms: [
      '黑白大理石', '深色大理石', '米色大理石', '山水大理石', '鱼肚白大理石', '大理石石材', '浅色大理石', '意式地砖', '木纹大理石',
    ]
  },
  {
    source: 'docs/07 §3.4（L128）',
    channel: 'texture',
    category1: '木地板',
    terms: [
      '拼花木地板', '人字拼木地板', '鱼骨木地板', '胡桃木地板', '户外木地板', '塑木地板', '防腐木地板', '柚木地板', '原木地板', '橡木地板',
      '深色木地板', '红木地板',
    ]
  },
  {
    source: 'docs/07 §3.5（L146）',
    channel: 'texture',
    category1: '瓷砖',
    terms: [
      '柔光砖', '灰色瓷砖', '白色瓷砖', '条形砖', '大理石瓷砖', '黑色瓷砖', '哑光砖', '卫生间瓷砖', '素色瓷砖', '暖色地砖', '厨房砖',
      '花纹砖',
    ]
  },
  {
    source: 'docs/07 §3.6（L164）',
    channel: 'texture',
    category1: '木纹',
    terms: [
      '胡桃木', '原木木纹', '枫木', '科技木', '烟熏橡木', '深色木纹', '浅色木纹', '树瘤', '白蜡木', '乌金木', '旧木纹', '松木',
      '橡木木纹', '金丝楠木', '黄花梨',
    ]
  },
  {
    source: 'docs/07 §3.7（L185）',
    channel: 'texture',
    category1: '地毯',
    terms: [
      '圆形地毯', '几何地毯', '条纹地毯', '办公地毯', '酒店地毯', '儿童地毯', '格子地毯',
    ]
  },
  {
    source: 'docs/07 §3.8（L198）',
    channel: 'texture',
    category1: '外景',
    terms: [
      '天空外景', '街道外景', '小区外景', '城市外景', '乡村', '外立面', '风景',
    ]
  },
  {
    source: 'docs/07 §3.9（L211）',
    channel: 'texture',
    category1: '木材',
    terms: [
      '板材', '藤编', '竹编', '竹子', '木头', '树皮', '年轮',
    ]
  },
  {
    source: 'docs/07 §3.10（L224）',
    channel: 'texture',
    category1: '挂画',
    terms: [
      '装饰画', '山水画', '油画', '抽象画', '字画', '水墨画', '艺术画', '黑白挂画',
    ]
  },
  {
    source: 'docs/07 §3.11（L238）',
    channel: 'texture',
    category1: '玻璃',
    terms: [
      '夹丝玻璃', '长虹玻璃', '花纹玻璃', '玻璃砖',
    ]
  },
  {
    source: 'docs/07 §3.12（L248）',
    channel: 'texture',
    category1: '金属',
    terms: [
      '穿孔板', '金属网', '金属板', '水波纹金属', '鎏金板', '做旧金属', '金属格栅', '集装箱', '金属浮雕',
    ],
    // docs/07:262 原文是 `金箔银箔`；docs/06 v1.0.9 已裁定「并列复合词条改斜杠写法」，
    // 实现层词表是 `金箔/银箔`（词条集合未变）。这里按裁定后的实现写法登记，不新增词条。
    pairs: [
      {
        station: '金箔银箔',
        category2: '金箔/银箔',
        source: 'docs/07 §3.12（L262）｜写法按 docs/06 v1.0.9 裁定对齐为斜杠'
      }
    ]
  },
  {
    source: 'docs/07 §3.13（L264）',
    channel: 'texture',
    category1: '壁纸壁画',
    terms: [
      '壁纸', '壁画',
    ]
  },
  {
    source: 'docs/07 §3.14（L272）',
    channel: 'texture',
    category1: '布纹',
    terms: [
      '花纹布纹', '绒布', '麻布', '丝绸', '纱布', '羊羔绒', '针织', '毛毡/毛呢', '抱枕', '棉布', '素色布纹', '条纹布',
      '扎染', '刺绣', '蕾丝', '牛仔布', '迷彩布',
    ],
    // `窗帘` 从 terms 挪到 pairs：它同时是模型侧 软装陈设/窗帘布艺 的落点（站方实测），
    // 需要按资产大类分流（用户 2026-10-26 拍板 B）。贴图/材质两种大类都取 布纹/窗帘。
    pairs: [
      {
        station: '窗帘',
        category2: '窗帘',
        kinds: ['texture', 'material'],
        note: '与 软装陈设/窗帘布艺 同名（站方实测 3 条）；kind=model 时走模型那支'
      }
    ]
  },
  {
    source: 'docs/07 §3.15（L296）',
    channel: 'texture',
    category1: '皮革',
    terms: [
      '编织皮', '细纹皮革', '粗纹皮革', '动物皮毛',
    ]
  },
  {
    source: 'docs/07 §3.16（L306）',
    channel: 'texture',
    category1: '墙面地面屋面',
    terms: [
      '硬包', '软包', '吊顶', '文化墙', '黑板', '夯土', '水泥', '绿植墙', '涂鸦墙', '塑胶地板', '自然地面', '路面', '瓦', '茅草',
      '太阳能板', '石膏',
    ]
  },
  {
    source: 'docs/07 §3.17（L328）',
    channel: 'texture',
    category1: 'HDR贴图',
    terms: [
      '天空HDR', '城市HDR', '小区HDR', '室内HDR', '户外HDR',
    ]
  },
  {
    source: 'docs/07 §3.18（L339）',
    channel: 'texture',
    category1: '涂料',
    terms: [
      '艺术漆', '乳胶漆', '真石漆', '微水泥', '硅藻泥', '地坪漆', '金属漆', '稻草漆', '马来漆', '裂纹漆', '浮雕漆', '灰泥',
    ]
  },
  {
    source: 'docs/07 §3.19（L357）',
    channel: 'texture',
    category1: '凹凸贴图',
    terms: [
      '法线', '反射贴图', '黑白凹凸', '高光',
    ]
  },
  {
    source: 'docs/07 §3.20（L367）',
    channel: 'texture',
    category1: '素材贴图',
    terms: [
      '屏幕', '杜邦纸', '塑料', '麻绳', '鱼缸', '门', '窗户', '水面', '剪影', '月球表面', '纸书本', '美食', '灯膜/灯罩',
      '壁炉/火焰', '室内场景', '亚克力',
    ]
  },
  {
    source: 'docs/07 §3.21（L389）',
    channel: 'texture',
    category1: '商业元素',
    terms: [
      '招牌', '广告', '店铺', '菜单',
    ]
  },

  // ══ 材质频道：docs/18 §3 逐组照抄（站方二级名 = 本地同名二级）════════════
  {
    source: 'docs/18 §3.1（L68）',
    channel: 'material',
    category1: '石材',
    terms: [
      '大理石', '岩板', '瓷砖', '文化石', '水磨石', '木纹砖', '其他石材',
    ]
  },
  {
    source: 'docs/18 §3.2（L79）',
    channel: 'material',
    category1: '木材',
    terms: [
      '高光木纹', '哑光木纹', '粗糙木纹', '原木木纹', '其他木材',
    ]
  },
  {
    source: 'docs/18 §3.3（L90）',
    channel: 'material',
    category1: '木地板',
    terms: [
      '工字拼木地板', '人字拼木地板', '田字拼木地板', '其他木地板',
    ]
  },
  {
    source: 'docs/18 §3.4（L98）',
    channel: 'material',
    category1: '地毯',
    terms: [
      '方形地毯', '圆形地毯', '满铺地毯', '其他地毯',
    ]
  },
  {
    source: 'docs/18 §3.5（L106）',
    channel: 'material',
    category1: '布料',
    terms: [
      '棉布', '麻布', '绒布', '其他布料',
    ]
  },
  {
    source: 'docs/18 §3.6（L114）',
    channel: 'material',
    category1: '金属',
    terms: [
      '金', '银', '铜', '铁', '铝', '不锈钢', '花纹板', '铝扣板', '穿孔板', '其他金属',
    ]
  },
  {
    source: 'docs/18 §3.7（L128）',
    channel: 'material',
    category1: '皮革',
    terms: [
      '打孔皮革', '压纹皮革', '编织皮革', '车线皮革', '其他皮革',
    ]
  },
  {
    source: 'docs/18 §3.8（L137）',
    channel: 'material',
    category1: '玻璃',
    terms: [
      '透明玻璃', '磨砂玻璃', '彩色玻璃', '夹丝玻璃', '玻璃幕墙', '其他玻璃',
    ]
  },
  {
    source: 'docs/18 §3.9（L147）',
    channel: 'material',
    category1: '塑料',
    terms: [
      '高光塑料', '哑光塑料', '粗糙塑料', '亚克力', '地胶板', '橡胶', '其他塑料',
    ]
  },
  {
    source: 'docs/18 §3.10（L158）',
    channel: 'material',
    category1: '陶瓷',
    terms: [
      '高光陶瓷', '哑光陶瓷', '粗糙陶瓷', '其他陶瓷',
    ]
  },
  {
    source: 'docs/18 §3.11（L166）',
    channel: 'material',
    category1: '涂料',
    terms: [
      '乳胶漆', '硅藻泥', '烤漆', '油漆', '车漆', '其他涂料',
    ]
  },
  {
    source: 'docs/18 §3.12（L176）',
    channel: 'material',
    category1: '墙面',
    terms: [
      '墙纸', '墙布', '护墙板', '其他墙面',
    ]
  },
  {
    source: 'docs/18 §3.13（L184）',
    channel: 'material',
    category1: '地面',
    terms: [
      '地坪漆', '泥地', '沙地', '草地', '雪地', '沥青', '路面', '跑道', '水泥地面', '石子地面', '户外地砖', '其他地面',
    ]
  },
  {
    source: 'docs/18 §3.14（L200）',
    channel: 'material',
    category1: '植物',
    terms: [
      '花草', '树木', '其他植物',
    ],
    // `绿植` 从 terms 挪到 pairs：模型侧站方三级 `绿植` 归并到 植物/盆栽（docs/17 §4），
    // 与材质册的 植物/绿植 同名不同二级 → 按资产大类分流（用户 2026-10-26 拍板 B）。
    pairs: [
      {
        station: '绿植',
        category2: '绿植',
        kinds: ['texture', 'material'],
        note: 'kind=model 时落 植物/盆栽（docs/17 §4 的三级归并）'
      }
    ]
  },
  {
    source: 'docs/18 §3.15（L208）',
    channel: 'material',
    category1: '外景',
    terms: [
      '城市景观', '街景', '建筑外立面', '天空', '风景', '其他外景',
    ],
    // `小区景观` 需要同时适用于 texture 与 material：模型侧另有 景观/小区景观（docs/05 §5）。
    pairs: [
      {
        station: '小区景观',
        category2: '小区景观',
        kinds: ['texture', 'material'],
        note: 'kind=model 时落 景观/小区景观（docs/05 §5）'
      }
    ]
  },
  {
    source: 'docs/18 §3.16（L221）',
    channel: 'material',
    category1: '皮肤器官',
    terms: [
      '人物皮肤', '动物皮肤', '其他皮肤器官',
    ]
  },
  {
    source: 'docs/18 §3.17（L228）',
    channel: 'material',
    category1: '液体',
    terms: [
      '自然水', '泳池水', '其他液体',
    ]
  },
  {
    source: 'docs/18 §3.18（L235）',
    channel: 'material',
    category1: '食物',
    terms: [
      '蔬菜', '水果', '甜品', '其他食物',
    ]
  },
  {
    source: 'docs/18 §3.19（L243）',
    channel: 'material',
    category1: '纸制品',
    terms: [
      '书籍报刊', '牛皮纸', '纸张', '其他纸制品',
    ]
  },
  {
    source: 'docs/18 §3.20（L253）',
    channel: 'material',
    category1: '半透明体',
    terms: [
      '水晶', '玉石', '其他半透明体',
    ]
  },

  // ══ SU 模型频道：docs/05 §5 六组【事实】══════════════════════════════════
  {
    source: 'docs/05 §5（L110）',
    channel: 'model',
    category1: '家装',
    terms: [
      '客厅', '客餐厅', '餐厅', '家居吧台区', '卧室', '儿童房', '卫生间', '厨房', '阳台', '玄关', '书房', '茶室', '衣帽间', '洗衣房',
      '休闲娱乐室', '家装整体方案', '单身公寓',
    ]
  },
  {
    source: 'docs/05 §5（L111）',
    channel: 'model',
    category1: '工装',
    terms: [
      '通用空间', '办公空间', '商业空间', '商场', '餐饮空间', '公共空间', '休闲娱乐', '文教空间', '体育空间', '医疗空间',
    ],
    pairs: [
      { station: '酒店民宿', category2: '酒店/民宿', source: 'docs/05 §5（L111）｜站方写法无斜杠，本地词表为「酒店/民宿」' },
    ]
  },
  {
    source: 'docs/05 §5（L112）',
    channel: 'model',
    category1: '景观',
    terms: [
      '景观小品', '雕塑小品', '景观铺装', '景观小建筑', '庭院景观', '小区景观', '公园景观', '儿童游乐区', '广场景观', '滨水景观', '商业景观',
      '办公景观', '校园景观', '生态停车场',
    ]
  },
  {
    source: 'docs/05 §5（L113）',
    channel: 'model',
    category1: '建筑',
    terms: [
      '住宅建筑', '办公建筑', '商业建筑', '文教建筑', '体育建筑', '医疗建筑', '工业建筑', '农业建筑', '交通建筑', '特色建筑', '城市规划',
      '公共建筑', '路桥工程', '建筑构件', '空间部品', '商务配套', '康健配套', '休闲配套', '艺术配套', '构筑物',
    ]
  },
  {
    source: 'docs/05 §5（L114）',
    channel: 'model',
    category1: '家具',
    terms: [
      '沙发', '床具', '茶几', '桌子', '椅子/凳子', '柜子', '架子', '家具组合', '户外家具',
    ]
  },
  {
    source: 'docs/05 §5（L115）',
    channel: 'model',
    category1: '灯具',
    terms: [
      '吊灯', '壁灯', '落地灯', '台灯', '吸顶灯', '装饰灯', '景观灯', '格栅灯', '路灯', '灯笼', '灯具组合', '其他灯具',
    ],
    pairs: [
      { station: '筒灯射灯', category2: '筒灯/射灯', source: 'docs/05 §5（L115）｜站方写法无斜杠，本地词表为「筒灯/射灯」' },
    ]
  },

  // ══ 三级节点归并：docs/17 §4（L58-66）+ §4.1（L72-76）════════════════════
  {
    source: 'docs/17 §4（L58-66）',
    channel: 'model',
    category1: '硬装构件',
    pairs: [
      { station: '屏风', category2: '屏风隔断', stationPath: ['硬装构件', '屏风隔断', '屏风'] },
      { station: '隔断', category2: '屏风隔断', stationPath: ['硬装构件', '屏风隔断', '隔断'] }
    ]
  },
  {
    source: 'docs/17 §4（L61-64）+ §4.1（L72-76）',
    channel: 'model',
    category1: '软装陈设',
    pairs: [
      { station: '花瓶花艺', category2: '摆件', stationPath: ['软装陈设', '摆件', '花瓶花艺'] },
      { station: '花瓶', category2: '摆件', note: '由节点名派生的中心语（docs/17 §4.1），无独立节点 URL' },
      { station: '绿植摆件', category2: '摆件', stationPath: ['软装陈设', '摆件', '绿植摆件'] }
    ]
  },
  {
    source: 'docs/17 §4（L64）',
    channel: 'model',
    category1: '植物',
    pairs: [
      {
        station: '绿植',
        category2: '盆栽',
        stationPath: ['植物', '盆栽'],
        note: '站方双归属（另一归属 软装陈设>摆件）；按 docs/17 取 植物/盆栽 为主'
      }
    ]
  },
  {
    source: 'docs/17 §4（L65-66）+ §4.1（L72-76）',
    channel: 'model',
    category1: '家具',
    pairs: [
      { station: '边几角几', category2: '茶几', stationPath: ['家具', '茶几', '边几角几'] },
      { station: '边几', category2: '茶几', note: '由节点名派生的中心语（docs/17 §4.1）' },
      { station: '卡座沙发', category2: '沙发', stationPath: ['家具', '沙发', '卡座沙发'] },
      { station: '卡座', category2: '沙发', note: '由节点名派生的中心语（docs/17 §4.1）' }
    ]
  },

  // ══ 站方实测（2026-10-26，用户库真实 ID 抓详情页 __NEXT_DATA__）══════════
  // 每一行的 stationPath 都是详情页 breadcrumb_data 原文；本地落点取「父链末级 = 本地同名二级」，
  // 不是按名字猜语义。样本清单见 docs/28。
  {
    source: '站方实测（家具组 5 条样本）',
    channel: 'model',
    category1: '家具',
    pairs: [
      {
        station: '椅子',
        category2: '椅子/凳子',
        stationPath: ['家具', '椅子'],
        note: '站方二级写作「椅子」，本地词表为「椅子/凳子」（docs/05 §5 L114）'
      },
      { station: '餐椅', category2: '椅子/凳子', stationPath: ['家具', '椅子', '餐椅'], source: '站方实测（ID 1182850298）' },
      { station: '办公椅', category2: '椅子/凳子', stationPath: ['家具', '椅子', '办公椅'], source: '站方实测（ID 1168720849）' },
      { station: '茶柜', category2: '柜子', stationPath: ['家具', '柜子', '茶柜'], source: '站方实测（ID 1194596930）' },
      { station: '餐桌椅', category2: '家具组合', stationPath: ['家具', '家具组合', '餐桌椅'], source: '站方实测（ID 1181734192）' }
    ]
  },
  {
    source: '站方实测（灯具组 2 条样本）',
    channel: 'model',
    category1: '灯具',
    pairs: [
      { station: '餐厅吊灯', category2: '吊灯', stationPath: ['灯具', '吊灯', '餐厅吊灯'], source: '站方实测（ID 1158463845）' },
      {
        station: '墙面壁灯',
        category2: '壁灯',
        stationPath: ['灯具', '壁灯', '户外壁灯'],
        source: '站方实测（ID 1179769209）',
        note: '站方三级节点显示名是「户外壁灯」，但 classifyBaseName 返回「墙面壁灯」；取父链二级 壁灯'
      }
    ]
  },
  {
    source: '站方实测（景观组 1 条样本）',
    channel: 'model',
    category1: '景观',
    pairs: [
      { station: '庭院小品', category2: '庭院景观', stationPath: ['景观', '庭院景观', '庭院小品'], source: '站方实测（ID 1158280573）' }
    ]
  },
  {
    source: '站方实测（植物组 1 条样本）',
    channel: 'model',
    category1: '植物',
    pairs: [
      {
        station: '乔木',
        category2: '乔木',
        stationPath: ['灯具', '植物', '乔木'],
        source: '站方实测（ID 1146709125）',
        note: '⚠️ 站方父链把「植物」挂在「灯具」下（疑站方数据错挂）；本地按二级/三级同名 乔木 落 植物/乔木'
      }
    ]
  },
  {
    source: '站方实测（软装陈设组 3 条样本）',
    channel: 'model',
    category1: '软装陈设',
    pairs: [
      { station: '镜子', category2: '摆件', stationPath: ['软装陈设', '摆件', '镜子'], source: '站方实测（ID 1190654473 / 1182843178）' },
      { station: '挂画', category2: '挂画', stationPath: ['软装陈设', '墙饰墙绘', '挂画'], source: '站方实测（ID 1186414883）' },
      {
        station: '窗帘',
        category2: '窗帘布艺',
        stationPath: ['软装陈设', '布艺软饰', '窗帘'],
        source: '站方实测（ID 1146380661 / 1176515673 / 1178820730）',
        note: '⚠️ 与 布纹/窗帘 同名（docs/07 §3.14）→ 本表返回 2 个候选，不替用户选'
      }
    ]
  },
  {
    source: '站方实测（贴图-木材 2 条样本）',
    channel: 'texture',
    category1: '木材',
    pairs: [
      {
        station: '海洋板',
        category2: '板材',
        stationPath: ['木材', '板材'],
        source: '站方实测（ID 1148779647）',
        note: '站方三级名落在二级「板材」下'
      },
      {
        station: '木板',
        category2: '板材',
        stationPath: ['木材', '板材'],
        source: '站方实测（库内材质 ID 1153222981）',
        note: '父链与「海洋板」完全相同（木材>板材），按同一口径落 木材/板材；详情页 301 到 tietu，属贴图树'
      }
    ]
  },
  {
    source: '站方实测（贴图-墙面地面屋面 1 条样本）',
    channel: 'texture',
    category1: '墙面地面屋面',
    pairs: [
      { station: '水泥墙', category2: '水泥', stationPath: ['墙面地面屋面', '水泥'], source: '站方实测（ID 1150580161）' }
    ]
  },

]

// ── 「只有一级确定」的条目（独立小表，不进上面的两级映射）──────────────────

/** 一条「站方名 = 站方一级名，本地同名一级存在」的登记 */
export interface ZhimoLevel1Entry {
  /** 站方 `classifyBaseName` 原文（必须本身就是站方一级名） */
  station: string
  /** 本地同名一级（必须已在 `LEVEL2_MAP` / `MATERIAL_LEVEL2_MAP` 建键） */
  category1: string
  source: string
  note?: string
}

/**
 * 「只有一级确定」的登记表（用户 2026-10-26 拍板第 2 个问题：只写一级、二级留未分类）。
 *
 * ⚠️ **判据（不许放宽）**：站方 `classifyBaseName` **本身就是一级名**（`docs/05 §2` / `docs/07 §2`），
 * 且本地存在同名一级 —— 才登记。**不是**"名字里含某个字就去凑一级"：
 * `夹胶玻璃` / `红砖` / `金属网格` / `茶具` / `食物饮料` / `植物组合` 都是**二级名**，
 * 本地没有对应二级 → 仍然返回 `null`（本地词表缺口，等第 3 个问题定了再处理）。
 *
 * ⚠️ 不批量登记全部频道一级名：`瓷砖` / `地毯` / `挂画` 等一级名在本地**同时是某个二级名**，
 * 一律按一级处理会制造二义。只登记有依据、且本地不是任何二级的名字。
 */

export const ZHIMO_LEVEL1_ONLY: readonly ZhimoLevel1Entry[] = [
  {
    station: '木纹',
    category1: '木纹',
    source: '站方实测（ID 1166965084 / 1151853396 / 1145254381）',
    note: '3 条样本的 classifyBaseName 都是「木纹」本身（站方一级），本地木纹组无同名二级'
  }
]

/**
 * ⚠️ 为什么只有一条：`玻璃` / `金属` 虽然是站方一级名、本地也有一级，但它们在本地
 * **同时是 `模型/SU材质` 的二级**（`LEVEL2_MAP.SU材质` 含 `玻璃` / `金属`）。
 * 若按"一级-only"处理，会与 `SU材质/玻璃`、`SU材质/金属` 产生二义 —— 按纪律返回 null，
 * 留给以后补抄录/人工裁定。单测 `ZHIMO_LEVEL1_ONLY 的落点合法` 会拦住这类二义登记。
 */

/**
 * 「就近归并」登记表（2026-10-26 用户拍板第 3 个问题）。
 *
 * ⚠️ **规则只活在这张表里**，不许散到 `importer` / `store` 的 if 分支 ——
 * 散出去就再也找不回来。站方的原始名字（`classifyBaseName`）都能用资产名里的
 * ID 重新从详情页取回，所以只要规则在表里，将来就能**一键重映射**：
 * 把本表某条删掉/改掉，重跑导入即可，不需要改调用点。
 *
 * 每条必须写全 `stationName` / `approxReason` / `source`（单测守卫非空），
 * 返回的落点会带 `approx: true` 与这两个说明字段，供落库侧写日志与后续筛选。
 */
export interface ZhimoApproxEntry {
  /** 站方 `classifyBaseName` 原话 */
  stationName: string
  category1: string
  /** 二级；`level:1` 时必须是哨兵 `未分类` */
  category2: string
  /** 只写一级的近似（夹胶玻璃/红砖）；缺省 = 2 */
  level?: 1
  /** 为什么算相近（人工判定，必须具体） */
  approxReason: string
  /** 抄录出处 / 实测商品 ID */
  source: string
  /** 站方父链原文 */
  stationPath?: readonly string[]
  /** 适用资产大类（近似只在已知大类内成立；kind 不匹配时返回 null） */
  kinds: readonly AssetKind[]
  note?: string
}

export const ZHIMO_APPROX: readonly ZhimoApproxEntry[] = [
  {
    stationName: '茶具',
    category1: '软装陈设',
    category2: '摆件',
    approxReason:
      '站方父链 厨卫五金>厨房用品>茶具；本地厨卫五金没有「茶具」二级。茶具在室内陈设里属器皿摆件，归 软装陈设/摆件 语义最近（2 条样本现也被预分类放在这里）。',
    source: '站方实测（ID 1193032547 / 1163008389）',
    stationPath: ['厨卫五金', '厨房用品', '茶具'],
    kinds: ['model']
  },
  {
    stationName: '食物饮料',
    category1: '软装陈设',
    category2: '摆件',
    approxReason:
      '站方父链 厨卫五金>厨房用品>食物饮料；本地无对应二级。样本（ID 1178549241）现被误分到 家具/架子，归 摆件 比留在错误的一级更接近。',
    source: '站方实测（ID 1178549241）',
    stationPath: ['厨卫五金', '厨房用品', '食物饮料'],
    kinds: ['model']
  },
  {
    stationName: '夹胶玻璃',
    category1: '玻璃',
    category2: UNCLASSIFIED,
    level: 1,
    approxReason:
      '站方父链只有一级「玻璃」；本地玻璃组无「夹胶玻璃」，且夹胶 ≠ 夹丝（工艺不同）不能塞进 夹丝玻璃 —— 只写一级，二级留未分类。⚠️ 已知二义：本地「玻璃」同时是 模型/SU材质 的二级（`LEVEL2_MAP.SU材质` 含 玻璃），按一级写会与 `SU材质/玻璃` 同名；此处按用户"就近归并"裁定仍返回一级-only，不静默退回 null（落库侧看到 approx+level:1 应知这是近似）。',
    source: '站方实测（ID 1127350943）',
    stationPath: ['玻璃'],
    kinds: ['texture']
  },
  {
    stationName: '红砖',
    category1: '砖材',
    category2: UNCLASSIFIED,
    level: 1,
    approxReason:
      '站方父链只有一级「砖材」（classifyBaseName=红砖，本地砖材组无此二级）；本地 外墙砖/户外砖 都不能确定，按裁定只写一级。',
    source: '站方实测（ID 1193950340）',
    stationPath: ['砖材'],
    kinds: ['texture']
  },
  {
    stationName: '金属网格',
    category1: '金属',
    category2: '金属网',
    approxReason:
      '站方名「金属网格」与本地词条「金属网」只差一个「格」字，判为同义 —— 这是**人工判定的同义**，不是字符串包含/相似度匹配。',
    source: '站方实测（ID 1141057558）',
    stationPath: ['金属'],
    kinds: ['texture']
  },
  {
    stationName: '植物组合',
    category1: '植物',
    category2: '盆栽',
    approxReason:
      '站方父链异常（灯具>植物>植物组合，疑站方错挂）；本地植物组无「植物组合」，多株组合在本地语义上属「盆栽」。ID 1159818293 仍建议人工复核。',
    source: '站方实测（ID 1159818293）',
    stationPath: ['灯具', '植物', '植物组合'],
    kinds: ['model']
  }
]

// ── 摊平：站方名 → 候选落点数组（模块加载时一次，之后只读）────────────────

/**
 * 构建期的一条记录：落点 + 它适用的资产大类（`undefined` = 不限制）。
 *
 * `kinds` **不放进对外的 `ZhimoCategoryTarget`**：既有两级条目的对象形状必须一字不变
 * （用户要求"kind 省略时与改造前完全等价"），所以 kind 只作为**并行的索引**存在。
 */
interface MappingSlot {
  target: ZhimoCategoryTarget
  kinds?: readonly AssetKind[]
}

/** 合并两条同名同落点的 kinds（任一为 undefined 视为不限制；否则取并集） */
function mergeKinds(
  a: readonly AssetKind[] | undefined,
  b: readonly AssetKind[] | undefined
): readonly AssetKind[] | undefined {
  if (a === undefined || b === undefined) return undefined
  const out = [...a]
  for (const k of b) if (!out.includes(k)) out.push(k)
  return out
}

/**
 * 把 `ZHIMO_MAP_GROUPS` 摊平成两份**按下标对齐**的索引：
 * - `byName`：站方名 → 候选落点数组（对外只读，`ZHIMO_CATEGORY_MAP`）；
 * - `kinds`：站方名 → 每个候选对应的大类数组（内部用，按 kind 分流）。
 *
 * - 同一个站方名在多个组出现 → 合并成**候选数组**（顺序 = 分组出现顺序，稳定可断言）；
 * - 完全相同的 `(category1, category2)` 只保留第一次出现那条（保留 source/note），
 *   但 kinds **取并集** —— 例如「小区景观」在贴图册与材质册各有一条同落点，合并后
 *   同时适用于 texture 与 material；
 * - 空名/纯空白名直接丢弃（站方偶尔返回 `--`/空串，见 `zhimoCover.stationText`）。
 */
function buildMappingIndex(groups: readonly ZhimoMapGroup[]): {
  byName: ReadonlyMap<string, readonly ZhimoCategoryTarget[]>
  kinds: ReadonlyMap<string, readonly (readonly AssetKind[] | undefined)[]>
} {
  const slots = new Map<string, MappingSlot[]>()

  const add = (station: string, target: ZhimoCategoryTarget, kinds?: readonly AssetKind[]): void => {
    const key = station.trim()
    if (!key) return
    const list = slots.get(key)
    if (list === undefined) {
      slots.set(key, [{ target, kinds }])
      return
    }
    const same = list.find(
      (s) => s.target.category1 === target.category1 && s.target.category2 === target.category2
    )
    if (same !== undefined) {
      same.kinds = mergeKinds(same.kinds, kinds)
      return
    }
    list.push({ target, kinds })
  }

  for (const group of groups) {
    const category1 = group.category1.trim()
    if (!category1) continue
    const groupKinds = group.kinds ?? [group.channel]
    for (const term of group.terms ?? []) {
      add(term, { category1, category2: term.trim(), source: group.source }, groupKinds)
    }
    for (const pair of group.pairs ?? []) {
      add(
        pair.station,
        {
          category1,
          category2: pair.category2.trim(),
          source: pair.source ?? group.source,
          ...(pair.stationPath ? { stationPath: pair.stationPath } : {}),
          ...(pair.note ? { note: pair.note } : {})
        },
        pair.kinds ?? groupKinds
      )
    }
  }

  // 冻结到条目级：调用方拿到的是只读数据，改不动本模块的内部状态
  const byName = new Map<string, readonly ZhimoCategoryTarget[]>()
  const kinds = new Map<string, readonly (readonly AssetKind[] | undefined)[]>()
  for (const [key, list] of slots) {
    byName.set(key, Object.freeze(list.map((s) => s.target)))
    kinds.set(key, Object.freeze(list.map((s) => (s.kinds ? Object.freeze([...s.kinds]) : undefined))))
  }
  return { byName, kinds }
}

const MAPPING_INDEX = buildMappingIndex(ZHIMO_MAP_GROUPS)

/**
 * 站方分类名 → 候选落点（只读索引）。
 *
 * 键 = 站方 `classifyBaseName` **原文**（未做任何归一化，只有 `trim()`）。
 * 用 `Map` 而不是普通对象，避免站方字符串撞 `constructor` / `__proto__` 之类的原型键。
 */
export const ZHIMO_CATEGORY_MAP: ReadonlyMap<string, readonly ZhimoCategoryTarget[]> =
  MAPPING_INDEX.byName

/** 与 `ZHIMO_CATEGORY_MAP` **按下标对齐**的大类索引（内部用；不导出，避免被误当成公共 API） */
const KIND_INDEX = MAPPING_INDEX.kinds

/** 一级-only 的只读索引（两种情况各取所需：带 kind 返单对象，不带 kind 返单元素数组） */
const LEVEL1_ONLY_INDEX: ReadonlyMap<string, ZhimoLevel1Target> = (() => {
  const m = new Map<string, ZhimoLevel1Target>()
  for (const entry of ZHIMO_LEVEL1_ONLY) {
    const key = entry.station.trim()
    if (!key) continue
    m.set(
      key,
      Object.freeze({
        category1: entry.category1.trim(),
        category2: UNCLASSIFIED,
        level: 1 as const,
        source: entry.source,
        ...(entry.note ? { note: entry.note } : {})
      })
    )
  }
  return m
})()

/** 一级-only 的数组包装（模块级复用，避免每次查表都新建数组） */
const LEVEL1_ONLY_ARRAY_INDEX: ReadonlyMap<string, readonly ZhimoLevel1Target[]> = (() => {
  const m = new Map<string, readonly ZhimoLevel1Target[]>()
  for (const [key, target] of LEVEL1_ONLY_INDEX) m.set(key, Object.freeze([target]))
  return m
})()

interface ApproxSlot {
  target: ZhimoApproxTarget
  kinds: readonly AssetKind[]
}

/** 就近归并索引：站方名 → { 落点, 适用大类 } */
const APPROX_INDEX: ReadonlyMap<string, ApproxSlot> = (() => {
  const m = new Map<string, ApproxSlot>()
  for (const entry of ZHIMO_APPROX) {
    const key = entry.stationName.trim()
    if (!key) continue
    const target: ZhimoApproxTarget = Object.freeze({
      category1: entry.category1.trim(),
      category2: entry.category2.trim(),
      ...(entry.level === 1 ? { level: 1 as const } : {}),
      approx: true,
      stationName: entry.stationName,
      approxReason: entry.approxReason,
      source: entry.source,
      ...(entry.stationPath ? { stationPath: entry.stationPath } : {}),
      ...(entry.note ? { note: entry.note } : {})
    })
    m.set(key, { target, kinds: Object.freeze([...entry.kinds]) })
  }
  return m
})()

/** 近似落点的数组包装（保持"无 kind 恒为数组"的老契约） */
const APPROX_ARRAY_INDEX: ReadonlyMap<string, readonly ZhimoApproxTarget[]> = (() => {
  const m = new Map<string, readonly ZhimoApproxTarget[]>()
  for (const [key, slot] of APPROX_INDEX) m.set(key, Object.freeze([slot.target]))
  return m
})()

/**
 * 查表：站方 `classifyBaseName` → 本地分类。
 *
 * **三层查找，优先级写死：**
 * 1. 两级映射（`ZHIMO_CATEGORY_MAP`）优先 —— 能确定到二级就不降级；
 * 2. 查不到才看「一级-only」小表（`ZHIMO_LEVEL1_ONLY`）—— 只有站方给的就是一级名时才命中；
 * 3. 再查「就近归并」表（`ZHIMO_APPROX`）—— 用户 2026-10-26 拍板：本地没有对应类目时
 *    归并到相近类目，**必须**带 `approx: true` + `stationName` + `approxReason` 以便回溯。
 * 4. 都没有 → `null`（拿不准一律不猜）。
 *
 * ⚠️ 「站方只给一级」与「本地没这个类目」是两件事：
 * - 前者的类别在 `ZHIMO_LEVEL1_ONLY`（`木纹`），返回 `level:1`；
 * - 后者的类别在 `ZHIMO_APPROX`（茶具/食物饮料/夹胶玻璃/红砖/金属网格/植物组合），
 *   返回带 `approx:true` 的落点（`夹胶玻璃`/`红砖` 同时 `level:1`）。
 *
 * **`kind` 参数（2026-10-26 用户拍板 B：按资产大类自动分流）：**
 * - `kind` 省略 → 与改造前**完全一致**：返回候选数组（长度 1 = 唯一落点）；
 * - `kind` 给了且能唯一筛出一条 → 返回**单个落点对象**；
 * - `kind` 给了但候选里**没有**匹配该大类的 → **退回完整候选数组**（绝不猜、也不报错）；
 * - `kind` 给了且筛出多条 → 返回筛选后的候选数组（仍不替用户选）。
 *
 * **一级-only / 近似与 kind 的关系：**
 * - 一级-only（`木纹`）与大类无关：带 kind 直接返回单对象，不做 kind 过滤；
 * - 近似（`ZHIMO_APPROX`）有适用大类：kind 不匹配时返回 **null**（不把模型的近似套到贴图上），
 *   匹配时返回带 `approx:true` 的单对象；不带 kind 返回 `[该对象]`。
 * 当前没有任何名字同时具备「一级-only」与「多 kind 分支」；若将来出现，
 * 按上面的优先级：**能确定到二级就用二级**，不降级成一级-only。
 *
 * 纯函数、零 IO、无副作用；返回的数组/对象都是模块内冻结数据，**不要修改**。
 */
export function mapZhimoCategory(
  baseName: string | null | undefined
): readonly ZhimoLookupTarget[] | null
export function mapZhimoCategory(
  baseName: string | null | undefined,
  kind: AssetKind
): ZhimoLookupTarget | readonly ZhimoLookupTarget[] | null
export function mapZhimoCategory(
  baseName: string | null | undefined,
  kind?: AssetKind
): ZhimoLookupTarget | readonly ZhimoLookupTarget[] | null {
  if (typeof baseName !== 'string') return null
  const key = baseName.trim()
  if (!key) return null

  // ── 第 1 层：两级映射 ─────────────────────────────────────────────
  const list = ZHIMO_CATEGORY_MAP.get(key)
  if (list !== undefined && list.length > 0) {
    // 不带 kind：完全保持改造前的行为（同一个冻结数组，长度/顺序/对象形状不变）
    if (kind === undefined) return list
    const kindsOf = KIND_INDEX.get(key)
    const matched = list.filter((_, i) => {
      const kinds = kindsOf?.[i]
      return kinds === undefined || kinds.includes(kind)
    })
    // 能唯一确定 → 单对象（落库侧不必再解包）
    if (matched.length === 1) return matched[0]!
    // 没有一条匹配该大类 → 退回完整候选（不猜）
    if (matched.length === 0) return list
    // 多条都匹配 → 仍是候选数组
    return Object.freeze(matched)
  }

  // ── 第 2 层：一级-only ───────────────────────────────────────────
  const level1 = LEVEL1_ONLY_INDEX.get(key)
  if (level1 !== undefined) {
    return kind === undefined ? (LEVEL1_ONLY_ARRAY_INDEX.get(key) ?? null) : level1
  }

  // ── 第 3 层：就近归并（始终带 approx:true，便于回溯与日后重映射）──────
  const approx = APPROX_INDEX.get(key)
  if (approx !== undefined) {
    // 近似有前提（只对某些大类成立）；kind 明确但不在适用范围内 → 不套用，返回 null
    if (kind !== undefined && !approx.kinds.includes(kind)) return null
    return kind === undefined ? (APPROX_ARRAY_INDEX.get(key) ?? null) : approx.target
  }

  return null
}

/** 映射表规模（诊断 / 报告用；纯函数，无外部依赖） */
export function zhimoMapStats(): {
  groups: number
  names: number
  targets: number
  multiCandidateNames: number
  groupsByChannel: Readonly<Record<ZhimoMapChannel, number>>
} {
  let targets = 0
  let multiCandidateNames = 0
  for (const list of ZHIMO_CATEGORY_MAP.values()) {
    targets += list.length
    if (list.length > 1) multiCandidateNames++
  }
  const groupsByChannel: Record<ZhimoMapChannel, number> = { model: 0, texture: 0, material: 0 }
  for (const group of ZHIMO_MAP_GROUPS) groupsByChannel[group.channel]++
  return {
    groups: ZHIMO_MAP_GROUPS.length,
    names: ZHIMO_CATEGORY_MAP.size,
    targets,
    multiCandidateNames,
    groupsByChannel
  }
}

// ── 裁定记录（**不进映射表**；2026-10-26 已全部定案，无待办）─────────────────

/**
 * 人工裁定条目状态：
 * - `'ambiguous'`：表里有**多个合法候选**（同名二级跨频道/跨一级），形状上仍是"一对多"；
 *   是否已经裁定看 `resolvedByKind`（2026-10-26 起这 10 条已按资产大类分流）；
 * - `'unmapped'`：**没进表**，`mapZhimoCategory()` 返回 `null` —— 只剩
 *   "父级太宽不能整体映射"（布艺软饰/墙饰墙绘/厨房用品）与品牌（Minotti/Poliform）。
 *   本地缺口已按用户裁定走 `ZHIMO_APPROX`，不在本状态里。
 */
export type ZhimoReviewStatus = 'ambiguous' | 'unmapped'

export interface ZhimoReviewCandidate {
  category1: string
  category2: string
}

export interface ZhimoHumanReviewEntry {
  /** 站方 `classifyBaseName` 原文（或站方二级名，`stationPath` 末项） */
  station: string
  status: ZhimoReviewStatus
  /**
   * 已按资产大类裁定（2026-10-26 用户拍板 B）。
   *
   * 置 `true` 的条目**不再需要人工拍板**：`mapZhimoCategory(name, kind)` 能给出唯一落点
   * （`model` / `texture` / `material` 的分流见 `ZHIMO_KIND_ROUTING`）。
   * 之所以保留在本清单里：① 老断言（多候选必须在这里）依赖它；
   * ② 将来新增 kind 时要回来确认"新大类该走哪一支"。
   */
  resolvedByKind?: true
  /**
   * 已裁定「不映射」（2026-10-26，用户拍板 C）。
   *
   * 置 `true` 的条目**不再挂账**：查表明确返回 `null`，理由写在 `reason` 里。
   * 分两类：① 站方父级太宽（布艺软饰/墙饰墙绘/厨房用品）——只映射其下三级；
   * ② 品牌（Minotti/Poliform）——品牌标签属后续独立功能，不在分类映射职责内。
   * 保留在清单里的原因同 `resolvedByKind`：作为可读记录 + 防止以后被重新当成"漏映射"。
   */
  resolvedNotMapped?: true
  /** 站方父链原文 */
  stationPath?: readonly string[]
  /**
   * `ambiguous`：与 `mapZhimoCategory()` 的返回**完全一致**（测试守卫）；
   * `unmapped`：人工**建议**的落点，**不是**映射表内容（可能包含本地没有的类目）。
   */
  candidates: readonly ZhimoReviewCandidate[]
  reason: string
  suggestion: string
}

/**
 * 一对多的 10 个名字**按资产大类分流后的裁定结果**（2026-10-26 用户拍板 B）。
 *
 * 这是一份**可读的裁定记录**，不是匹配逻辑本身：真正的分流由 `groups/pairs` 上的
 * `kinds` 元数据驱动，`mapZhimoCategory(name, kind)` 查的就是那份索引。
 * 保留本表的原因：① 落库侧/QA 可以直接拿它核对"哪个 kind 该落哪"；
 * ② 将来新增 `AssetKind`（例如把 `other` 细分）时，必须回来逐条确认新大类走哪一支。
 *
 * `routes` 里**没列出的 kind** = 该名字对这个大类不适用 → `mapZhimoCategory` 退回候选数组，
 * 由调用方决定（不猜）。
 */
export interface ZhimoKindRoute {
  station: string
  routes: Readonly<Partial<Record<AssetKind, ZhimoReviewCandidate>>>
  /** 裁定依据（两册出处 / 站方实测） */
  basis: string
}

export const ZHIMO_KIND_ROUTING: readonly ZhimoKindRoute[] = [
  {
    station: '原木木纹',
    routes: {
      texture: { category1: '木纹', category2: '原木木纹' },
      material: { category1: '木材', category2: '原木木纹' }
    },
    basis: '贴图册 docs/07 §3.6 vs 材质册 docs/18 §3.2'
  },
  {
    station: '棉布',
    routes: {
      texture: { category1: '布纹', category2: '棉布' },
      material: { category1: '布料', category2: '棉布' }
    },
    basis: '贴图册 docs/07 §3.14（布纹） vs 材质册 docs/18 §3.5（布料）'
  },
  {
    station: '麻布',
    routes: {
      texture: { category1: '布纹', category2: '麻布' },
      material: { category1: '布料', category2: '麻布' }
    },
    basis: '贴图册 docs/07 §3.14 vs 材质册 docs/18 §3.5'
  },
  {
    station: '绒布',
    routes: {
      texture: { category1: '布纹', category2: '绒布' },
      material: { category1: '布料', category2: '绒布' }
    },
    basis: '贴图册 docs/07 §3.14 vs 材质册 docs/18 §3.5'
  },
  {
    station: '路面',
    routes: {
      texture: { category1: '墙面地面屋面', category2: '路面' },
      material: { category1: '地面', category2: '路面' }
    },
    basis: '贴图册 docs/07 §3.16 vs 材质册 docs/18 §3.13（地面）'
  },
  {
    station: '地坪漆',
    routes: {
      texture: { category1: '涂料', category2: '地坪漆' },
      material: { category1: '地面', category2: '地坪漆' }
    },
    basis: '贴图册 docs/07 §3.18（涂料） vs 材质册 docs/18 §3.13（地面）'
  },
  {
    station: '亚克力',
    routes: {
      texture: { category1: '素材贴图', category2: '亚克力' },
      material: { category1: '塑料', category2: '亚克力' }
    },
    basis: '贴图册 docs/07 §3.20（素材贴图） vs 材质册 docs/18 §3.9（塑料）'
  },
  {
    station: '窗帘',
    routes: {
      model: { category1: '软装陈设', category2: '窗帘布艺' },
      texture: { category1: '布纹', category2: '窗帘' },
      material: { category1: '布纹', category2: '窗帘' }
    },
    basis: '站方实测 3 条（软装陈设>布艺软饰>窗帘） vs 贴图册 docs/07 §3.14'
  },
  {
    station: '绿植',
    routes: {
      model: { category1: '植物', category2: '盆栽' },
      texture: { category1: '植物', category2: '绿植' },
      material: { category1: '植物', category2: '绿植' }
    },
    basis: 'docs/17 §4（模型三级归并到 盆栽） vs docs/18 §3.14（材质二级 绿植）'
  },
  {
    station: '小区景观',
    routes: {
      model: { category1: '景观', category2: '小区景观' },
      texture: { category1: '外景', category2: '小区景观' },
      material: { category1: '外景', category2: '小区景观' }
    },
    basis: 'docs/05 §5（景观组） vs docs/07 §3.8 / docs/18 §3.15（外景组）'
  }
]

/**
 * 裁定记录（与 `docs/28 §5` 的裁定表逐条对应）。**2026-10-26 已全部定案，没有待办**。
 *
 * - `ambiguous` + `resolvedByKind`：已按资产大类分流（10 条，`ZHIMO_KIND_ROUTING`）；
 * - `unmapped` + `resolvedNotMapped`：已裁定不映射（5 条：3 个父级太宽 + 2 个品牌）；
 * - 没有 `resolved*` 标记的条目 = 仍未定案（当前为 0）。
 */
export const ZHIMO_HUMAN_REVIEW: readonly ZhimoHumanReviewEntry[] = [
  // ── A. 已进表但一对多 ────────────────────────────────────────────
  {
    station: '原木木纹',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '木纹', category2: '原木木纹' },
      { category1: '木材', category2: '原木木纹' }
    ],
    reason: '贴图册（docs/07 §3.6）与材质册（docs/18 §3.2）都有同名二级，且两个落点都合法。',
    suggestion:
      '已按 kind 裁定：texture → 木纹/原木木纹，material → 木材/原木木纹；其它 kind 退回候选数组。'
  },
  {
    station: '棉布',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '布纹', category2: '棉布' },
      { category1: '布料', category2: '棉布' }
    ],
    reason: '贴图册（docs/07 §3.14 布纹）与材质册（docs/18 §3.5 布料）同名二级。',
    suggestion: '已按 kind 裁定：texture → 布纹/棉布，material → 布料/棉布；其它 kind 退回候选数组。'
  },
  {
    station: '麻布',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '布纹', category2: '麻布' },
      { category1: '布料', category2: '麻布' }
    ],
    reason: '贴图册（docs/07 §3.14 布纹）与材质册（docs/18 §3.5 布料）同名二级。',
    suggestion: '同「棉布」（已按 kind 裁定：texture → 布纹，material → 布料）。'
  },
  {
    station: '绒布',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '布纹', category2: '绒布' },
      { category1: '布料', category2: '绒布' }
    ],
    reason: '贴图册（docs/07 §3.14 布纹）与材质册（docs/18 §3.5 布料）同名二级。',
    suggestion: '同「棉布」（已按 kind 裁定：texture → 布纹，material → 布料）。'
  },
  {
    station: '路面',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '墙面地面屋面', category2: '路面' },
      { category1: '地面', category2: '路面' }
    ],
    reason: '贴图册（docs/07 §3.16）与材质册（docs/18 §3.13 地面）同名二级。',
    suggestion: '已按 kind 裁定：texture → 墙面地面屋面/路面，material → 地面/路面；其它 kind 退回候选数组。'
  },
  {
    station: '地坪漆',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '涂料', category2: '地坪漆' },
      { category1: '地面', category2: '地坪漆' }
    ],
    reason: '贴图册把地坪漆放在「涂料」（docs/07 §3.18），材质册把它放在「地面」（docs/18 §3.13）。',
    suggestion: '已按 kind 裁定：texture → 涂料/地坪漆，material → 地面/地坪漆；其它 kind 退回候选数组。'
  },
  {
    station: '亚克力',
    status: 'ambiguous',
    resolvedByKind: true,
    candidates: [
      { category1: '素材贴图', category2: '亚克力' },
      { category1: '塑料', category2: '亚克力' }
    ],
    reason: '贴图册放在「素材贴图」（docs/07 §3.20），材质册放在「塑料」（docs/18 §3.9）。',
    suggestion: '已按 kind 裁定：texture → 素材贴图/亚克力，material → 塑料/亚克力；其它 kind 退回候选数组。'
  },
  {
    station: '窗帘',
    status: 'ambiguous',
    resolvedByKind: true,
    stationPath: ['软装陈设', '布艺软饰', '窗帘'],
    candidates: [
      { category1: '布纹', category2: '窗帘' },
      { category1: '软装陈设', category2: '窗帘布艺' }
    ],
    reason:
      '站方实测（3 条模型样本）落在 软装陈设>布艺软饰>窗帘；同时贴图册有 布纹/窗帘（docs/07 §3.14）。',
    suggestion:
      '已按 kind 裁定：model → 软装陈设/窗帘布艺，texture/material → 布纹/窗帘；其它 kind 退回候选数组。'
  },
  {
    station: '绿植',
    status: 'ambiguous',
    resolvedByKind: true,
    stationPath: ['植物', '盆栽'],
    candidates: [
      { category1: '植物', category2: '绿植' },
      { category1: '植物', category2: '盆栽' }
    ],
    reason:
      'docs/18 §3.14（材质-植物）把「绿植」当二级；docs/17 §4 的三级节点「绿植」归并到 植物/盆栽。两个落点 category1 相同，二级二选一。',
    suggestion:
      '已按 kind 裁定：model → 植物/盆栽，texture/material → 植物/绿植；其它 kind 退回候选数组。'
  },
  {
    station: '小区景观',
    status: 'ambiguous',
    resolvedByKind: true,
    stationPath: ['景观'],
    candidates: [
      { category1: '景观', category2: '小区景观' },
      { category1: '外景', category2: '小区景观' }
    ],
    reason:
      'docs/05 §5（景观组）与 docs/07 §3.8（外景组）都有「小区景观」：一个是场景类，一个是贴图类。',
    suggestion:
      '已按 kind 裁定：model → 景观/小区景观，texture/material → 外景/小区景观；其它 kind 退回候选数组。'
  },

  // ── B. 不映射（父级太宽 / 品牌）────────────────────────────────────
  // 本地缺口（茶具/食物饮料/夹胶玻璃/红砖/金属网格/植物组合）已按用户裁定走
  // `ZHIMO_APPROX`（带 approx:true）；「站方只给一级」走 `ZHIMO_LEVEL1_ONLY`。
  // 这里只剩：**父级不能整体映射**（会把更宽的语义压进一个二级）与**品牌**。
  {
    station: '布艺软饰',
    status: 'unmapped',
    resolvedNotMapped: true,
    stationPath: ['软装陈设', '布艺软饰'],
    candidates: [{ category1: '软装陈设', category2: '窗帘布艺' }],
    reason: '站方二级「布艺软饰」覆盖面大于本地二级「窗帘布艺」（还含抱枕/床品等）。',
    suggestion: '**不要**把父级整体映射到「窗帘布艺」；只映射它下面的三级（如 窗帘）。'
  },
  {
    station: '墙饰墙绘',
    status: 'unmapped',
    resolvedNotMapped: true,
    stationPath: ['软装陈设', '墙饰墙绘'],
    candidates: [{ category1: '软装陈设', category2: '挂画' }],
    reason: '站方二级「墙饰墙绘」比本地「挂画」宽（可能含墙贴/墙绘/壁饰）。',
    suggestion: '同「布艺软饰」：只映射其下三级（挂画），父级不映射。'
  },
  {
    station: '厨房用品',
    status: 'unmapped',
    resolvedNotMapped: true,
    stationPath: ['厨卫五金', '厨房用品'],
    candidates: [],
    reason: '本地厨卫五金组没有这一层级（只有 水龙头/水槽/花洒/马桶/浴缸/浴室柜/厨房电器/五金配件/晾衣架）。',
    suggestion: '不映射父级；等其下三级逐个补词表（茶具/食物饮料 已单列）。'
  },
  {
    station: 'Minotti',
    status: 'unmapped',
    resolvedNotMapped: true,
    stationPath: ['家具'],
    candidates: [],
    reason: '品牌名，不是分类层级；`taxonomy.EXCLUDED_TERMS` 已把它从家具组剔除。',
    suggestion: '写 `BRAND_LIST` / 自由标签，不写 category1/2。'
  },
  {
    station: 'Poliform',
    status: 'unmapped',
    resolvedNotMapped: true,
    stationPath: ['家具'],
    candidates: [],
    reason: '品牌名，同 Minotti。',
    suggestion: '写 `BRAND_LIST` / 自由标签，不写 category1/2。'
  }
]
