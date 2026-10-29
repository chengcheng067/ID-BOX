/**
 * 分类体系数据与查询（T06，`docs/06-分类体系设计.md` v1.0.2 §9.1）
 *
 * 纯数据 + 纯函数，**零 IO、零 electron / node 依赖**，renderer 与 main 共用（无需 IPC）。
 *
 * 词表来源（**逐项照抄，禁止凭记忆敲、禁止生成 slug**）：
 * - SU 模型频道：`docs/05-知末分类词表-原始抄录.md` §2（一级 19 项）/ §5（二级 6 组【事实】）
 *   + 06 §3.2（13 组【推断】）
 * - 贴图材质频道：`docs/07-贴图材质分类词表-原始抄录.md` §2（一级 22 项含「推荐」）/ §3（二级 21 组 195 项）
 * - 材质频道：`docs/07` §5.11 —— 无二级分类排 → 建键给空数组
 *
 * 三条使用规则（06 §9.1 末尾，防词表被误用）：
 * 1. 受控词表用于"建议"不用于"强制" —— 未知但格式合法的值**放行落盘**
 * 2. "是否属于词表"**不落库**（派生信息，落库会随词表更新过期成脏数据）
 * 3. 【推断】标记进数据（`CONFIDENCE`），核对后只改数据一个字符串
 */

/** 哨兵：未分类（落盘目录名，也是 Asset.category1/category2 的默认值） */
export const UNCLASSIFIED = '未分类'

/**
 * 一级分类：19 项【事实 · docs/05 §2 照抄】
 * （「全部」= 不筛选，不是分类，**不进枚举**）
 */
export const LEVEL1_LIST: readonly string[] = [
  '家装', '工装', '景观', '建筑', '家具', '灯具', '软装陈设', '植物', '硬装构件',
  '厨卫五金', '电器/器材', '家装户型', 'SU材质', '美陈装置', '标识广告',
  '人物/动物', '交通工具', '展厅/展台', '舞台'
]

/** 贴图频道一级分类：21 项【事实 · docs/07 §2，已剔除「推荐」——它指向频道首页信息流，不是内容类目】 */
export const TEXTURE_LEVEL1_LIST: readonly string[] = [
  '石材', '砖材', '大理石', '木地板', '瓷砖', '木纹', '地毯', '外景', '木材', '挂画',
  '玻璃', '金属', '壁纸壁画', '布纹', '皮革', '墙面地面屋面', 'HDR贴图', '涂料',
  '凹凸贴图', '素材贴图', '商业元素'
]

/**
 * 材质频道一级分类：21 项【事实 · docs/07 §5.11，已剔除首项「全部」】
 *
 * 【v1.0.8 / docs/14 §2.2】从 `CHANNEL_LEVEL1.material` 的匿名数组提为**具名常量**，
 * 供 `MERGED_MATERIAL_LEVEL1` 派生使用；值一字未改。
 */
export const MATERIAL_LEVEL1_LIST: readonly string[] = [
  '石材', '木材', '木地板', '地毯', '布料', '金属', '皮革', '玻璃', '塑料', '陶瓷',
  '涂料', '墙面', '地面', '植物', '外景', '皮肤器官', '液体', '食物', '纸制品', '半透明体', '其他'
]

/**
 * 【v0.8.5 / docs/34 §一】CAD 图纸频道一级分类：**10 项**（含末项「其他图纸」）。
 *
 * 来源：`docs/probe/cad-taxonomy/cad_tree.json`（`categories[].name` 原序）+
 * `docs/34-知末CAD频道词表-原始抄录.md` §一。**用脚本逐项生成，未手抄。**
 *
 * ⚠️ 顺序是站方筛选栏原序：`CAD图库 / 节点详图 / 家装空间 / 工装空间 / …`
 * （**家装空间在工装空间之前**，与 SU 频道的「家装 / 工装」顺序相反，别照 SU 的习惯敲）。
 * ⚠️ 首项「全部」= 不筛选，**不进枚举**（与 docs/05 §2、docs/07 §2 同一纪律）。
 * ⚠️ 站方一级里**没有「推荐」**，也**没有「豪宅空间」**（docs/34 §0-2：当前站点查无此节点）。
 */
export const CAD_LEVEL1_LIST: readonly string[] = [
  'CAD图库', '节点详图', '家装空间', '工装空间', '园林景观', '建筑设计', '平立面系统图', '结构设计', '机电工程', '其他图纸'
]

/**
 * 【v1.0.8 / docs/14 §2.2】材质大类语境下的**一级词表并集（33 项）**。
 *
 * 「材质」目录下 `texture` 与 `material` 两类资产共用同一棵分类树，词表必须同源，
 * 否则会出现"贴图能选、材质选不到"的同一目录两套选项。
 * 顺序：贴图册原序（21 项） + 材质独有项按 07 §5.11 原序（12 项）= 33 项。
 *
 * ⚠️ 这是**派生列表，不进 `LEVEL2_MAP` 键空间**；它只用于 UI 下拉与校验展示。
 * 9 个同名一级（石材/木材/木地板/地毯/金属/皮革/玻璃/涂料/外景）的二级词表**不变**。
 */
export const MERGED_MATERIAL_LEVEL1: readonly string[] = [
  ...TEXTURE_LEVEL1_LIST,
  ...MATERIAL_LEVEL1_LIST.filter((v) => !TEXTURE_LEVEL1_LIST.includes(v))
]

/**
 * 【v1.0.3 新增】频道 → 一级分类词表的归属表（含**已抄录但未建键**的频道）。
 *
 * 作用：① CategoryPicker 的「一级下拉」**按大类取这里的来源**，不靠 `LEVEL2_MAP` 的 keys 巧合推导；
 *      ② 把「材质频道一级已抄录（07 §5.11）、本轮未建 LEVEL2_MAP 键」这一观察钉在数据里，将来做材质不会丢。
 *
 * `material` 逐项照抄 docs/07 §5.11（剔除首项「全部」）。
 * 【裁定 v1.0.4】计数勘误已确认：06 v1.0.3 写「材质 20 项」是笔误，剔「全部」后实为 **21 项**（含末项「其他」）。
 * **「其他」保留、不剔除**，21 项即终态（架构师驳回"剔除进 EXCLUDED_TERMS"提议，理由见 06 §15 v1.0.4：
 * 「全部/推荐」的剔除判据是"导航控件非内容类目"，而「其他」是站方真实的可筛选内容桶；
 * 且「其他」（终态）≠「未分类」（待办），删掉会把"永远无类"的资产挤进未分类、污染待整理清单语义）。
 * 本表按原文**逐项照抄 21 项**，不删项凑数 —— 判断正确，已获架构师确认。
 *
 * 【v1.0.8 / docs/14 §2.2】`material` 改为引用具名常量 `MATERIAL_LEVEL1_LIST`，值一字未改。
 * 注意：**UI 级联下拉不走本表**——`texture` 与 `material` 都改用并集 `MERGED_MATERIAL_LEVEL1`
 * （见 `renderer/logic/category.ts:level1OptionsFor`）；本表保留原册以便追溯来源。
 */
export const CHANNEL_LEVEL1: Readonly<
  Record<'model' | 'texture' | 'material' | 'cad', readonly string[]>
> = {
  // SU 模型频道 19 项【事实 · docs/05 §2】
  model: LEVEL1_LIST,
  // 贴图频道 21 项【事实 · docs/07 §2，剔除「推荐」】
  texture: TEXTURE_LEVEL1_LIST,
  // 材质频道 21 项【事实 · docs/07 §5.11，剔除「全部」；本轮未建 LEVEL2_MAP 键】
  material: MATERIAL_LEVEL1_LIST,
  // 【v0.8.5 / docs/34 §一】CAD 图纸频道 10 项【事实 · cad_tree.json 原序】。
  // 加这一册之后 `isLevel1AllowedForKind('cad', …)` 自动生效（它读的正是本表）——
  // 加册前该函数对 cad 恒返回 false（`CHANNEL_LEVEL1['cad'] === undefined`）。
  // ⚠️ CAD 的一级与 SU 19 项、贴图 21 项、材质 21 项**零交集**（有守卫），故四册键空间仍唯一。
  cad: CAD_LEVEL1_LIST
}

/**
 * 一级 → 二级 级联映射。
 * - SU 频道：6 组【事实】+ 13 组【推断】（06 §3.1 / §3.2）
 * - 贴图频道：21 组 195 项【事实 · docs/07 §3】（每组首行「全部」**不进枚举**；「推荐」无二级排）
 * - 材质频道：**本轮不建键**（Scope Out，v1.0.3 裁定，见 §3.3-② 与 §15）；一级词表归属见 `CHANNEL_LEVEL1`
 * - **排除清单**（见 `EXCLUDED_TERMS`）从入库值中剔除，剔除是数据、可审计，不是静默省略
 *
 * ⚠️ **显式不变式（v1.0.3 起生效）**：key = 一级分类名，且**当前已建键全局唯一**
 * （SU 19 项与贴图 21 项经核对零交集，`tests/taxonomy.test.ts` 有守卫）。
 * 将来建材质频道时，它与贴图有 **9 个同名一级**（石材/木材/木地板/地毯/金属/皮革/玻璃/涂料/外景，07 §5.11）、
 * 与 SU 有 **1 个**（植物）——**撞键总数 10**（06 v1.0.4 存档）。届时**必须**升级为按大类嵌套
 * （`Record<大类, Record<一级, 二级[]>>`）或引入频道前缀键，**禁止**维持扁平 map 硬塞同名 key（守卫测试会变红）。
 *
 * 📌 **升级时的精确判据（架构师口头裁定 v1.0.4，未单独发版，存档于此供未来工程师查阅）**：
 * **嵌套键 = 大类**（`Asset.category1` 本就不带频道信息，schema 层的正解）；
 * 但大类与频道**不是一一对应**——例如 `texture` 大类未来可能同时从 贴图频道 + PS素材频道 进词表，
 * 若两频道一级同名，大类内仍会撞。故：**大类内若有多频道贡献且一级撞名 → 才在该大类内加频道前缀**。
 * 即「先按大类嵌套，撞了再在类内加频道前缀」，不要一上来就全局频道前缀。
 *
 * 🆕 **v1.0.8 / docs/14 §2.2 追加（材质大类合并，2026-10-19）**：
 * 材质频道（07 §5.11）**无二级分类排** → 它对二级的贡献为 **0 项**，因此本次合并
 * **不触发**上面的嵌套升级不变式（**触发器保留**：哪天真采到材质二级排且与贴图撞名，
 * 必须回来升级嵌套/前缀键，禁止扁平地硬塞同名 key）。
 * 裁定：**`LEVEL2_MAP` 零新增键，键数仍是 40**；材质独有的 11 项（布料/塑料/陶瓷/墙面/地面/
 * 皮肤器官/液体/食物/纸制品/半透明体/其他）**不建 `[]` 空键** ——
 * `autoClassify.ts` 的一级匹配会遍历 `Object.keys(LEVEL2_MAP)`，空键会让「墙面装饰板」
 * 这类**模型**被误分到 `模型/墙面/未分类`（真实回归）。缺键与空键在 `level2Of()` 上行为一致。
 * 材质语境的一级词表并集（33 项）走独立的派生列表 `MERGED_MATERIAL_LEVEL1`，不进键空间。
 */
export const LEVEL2_MAP: Readonly<Record<string, readonly string[]>> = {
  // ── SU 模型频道 · 6 组【事实 · docs/05 §5 照抄】 ──────────────────
  家装: [
    '客厅', '客餐厅', '餐厅', '家居吧台区', '卧室', '儿童房', '卫生间', '厨房', '阳台',
    '玄关', '书房', '茶室', '衣帽间', '洗衣房', '休闲娱乐室', '家装整体方案', '单身公寓'
  ],
  工装: [
    '通用空间', '办公空间', '酒店/民宿', '商业空间', '商场', '餐饮空间', '公共空间',
    '休闲娱乐', '文教空间', '体育空间', '医疗空间'
  ],
  景观: [
    '景观小品', '雕塑小品', '景观铺装', '景观小建筑', '庭院景观', '小区景观', '公园景观',
    '儿童游乐区', '广场景观', '滨水景观', '商业景观', '办公景观', '校园景观', '生态停车场'
  ],
  建筑: [
    '住宅建筑', '办公建筑', '商业建筑', '文教建筑', '体育建筑', '医疗建筑', '工业建筑',
    '农业建筑', '交通建筑', '特色建筑', '城市规划', '公共建筑', '路桥工程', '建筑构件',
    '空间部品', '商务配套', '康健配套', '休闲配套', '艺术配套', '构筑物'
  ],
  // 原词表含品牌 Minotti / Poliform（06 §8 裁定剔除 → 品牌），剔除后 9 项
  家具: ['沙发', '床具', '茶几', '桌子', '椅子/凳子', '柜子', '架子', '家具组合', '户外家具'],
  灯具: [
    '吊灯', '壁灯', '落地灯', '台灯', '吸顶灯', '筒灯/射灯', '装饰灯', '景观灯', '格栅灯',
    '路灯', '灯笼', '灯具组合', '其他灯具'
  ],
  // ── SU 模型频道 · 13 组【推断 · 06 §3.2，未经知末确认】 ────────────
  // 【v1.0.11 / 2026-10-20 站方核对】本组 2026-10-20 经站方筛选树实地核对，
  // 站方写法为 `摆件 / 挂画 / 挂件 / 服饰鞋帽 / 玩具 / 布艺软饰 / 地毯`
  // （核对结论记于本轮任务单；docs/17 本轮只收录三级节点，二级全表尚未入档）。
  // 本轮**只加不删**：补 `挂画`（站方确有此项，且用户实测「挂画组合ID_…」应落本类）；
  // `装饰画` / `花艺` / `抱枕` / `床品` / `餐具` / `书籍摆件` / `雕塑摆件` 是**本地补充、
  // 站方无此二级** —— 删掉会孤立库里可能已存在的 category2 值，故原样保留（不重命名、不迁移）。
  // ⚠️ `挂画` **追加在末尾**而非插到站方顺序位：既有条目的数组下标保持不变，
  // 等长并列时的键序择优结果不回退（`pickBest` 等长取先出现者）。
  软装陈设: ['装饰画', '摆件', '花艺', '地毯', '窗帘布艺', '抱枕', '床品', '餐具', '书籍摆件', '雕塑摆件', '挂画'],
  植物: ['乔木', '灌木', '地被花卉', '草坪', '盆栽', '绿篱', '竹类', '棕榈科', '水生植物', '多肉'],
  // 【v1.0.10 / docs/17 §4】2026-10-20 用真实浏览器从知末分类筛选树实地抄录，
  // 站方二级全表 = 门 / 窗 / 吊顶 / 背景墙·墙面 / 屏风隔断 / 装饰线条 / 楼梯 / 电梯 / 栏杆。
  // 本轮**只加不改**：补 `屏风隔断`（三级 屏风/隔断 的上级）、`装饰线条`、`电梯` 三项；
  // 既有 `墙面装饰` / `地面铺装` / `柱式` / `踢脚线` / `壁炉` 是**本地补充、站方无此二级**——
  // 删掉会孤立库里可能已存在的 category2 值，故保留（原样留档，不重命名、不迁移）。
  硬装构件: [
    // 站方二级（按站方顺序；`背景墙` 即站方 `背景墙·墙面`，本轮不改名）
    '门', '窗', '吊顶', '背景墙',
    '屏风隔断', '装饰线条', // 【v1.0.10 新增】站方二级补齐
    '楼梯', '电梯', '栏杆', // `电梯` 【v1.0.10 新增】
    // 本地补充·站方无此二级（保留以免孤立既有数据）
    '墙面装饰', '地面铺装', '柱式', '踢脚线', '壁炉'
  ],
  厨卫五金: ['水龙头', '水槽', '花洒', '马桶', '浴缸', '浴室柜', '厨房电器', '五金配件', '晾衣架'],
  '电器/器材': ['冰箱', '洗衣机', '空调', '电视', '音响', '厨房电器', '办公设备', '健身器材'],
  家装户型: ['小户型', '中户型', '大平层', '复式', '别墅', 'LOFT', '单身公寓'],
  SU材质: ['木材', '石材', '金属', '玻璃', '布艺', '皮革', '涂料', '壁纸', '瓷砖', '混凝土'],
  美陈装置: ['节日美陈', '商场美陈', '橱窗陈列', 'DP点', '气球装置', '灯饰装置'],
  标识广告: ['导视牌', '门头招牌', '灯箱', '展架', 'LOGO墙', '广告牌', '指示牌'],
  '人物/动物': ['人物', '动物', '卡通形象', '雕塑人像'],
  交通工具: ['汽车', '摩托车', '自行车', '船', '飞机', '火车', '工程车辆'],
  '展厅/展台': ['企业展厅', '展会展台', '博物馆展陈', '展柜', '展板', '接待台'],
  舞台: ['舞台背景', '灯光架', '音响设备', '演出道具', '桁架'],

  // ── 贴图频道 · 21 组【事实 · docs/07 §3 照抄，剔除「全部」行】 ──────
  石材: ['水磨石', '岩板', '文化石', '洞石', '花岗岩', '奢石', '火山岩', '人造石', '石材拼花', '石雕', '莱姆石'],
  砖材: ['马赛克', '仿古砖', '外墙砖', '户外砖', '踢脚线', '腰线', '波打线', '门槛石'],
  // 原词表含花色商品名 冷翡翠 / 宝格丽大理石 / 潘多拉大理石 / 爵士白大理石（06 §9.1 裁定剔除），剔除后 9 项
  大理石: [
    '黑白大理石', '深色大理石', '米色大理石', '山水大理石', '鱼肚白大理石', '大理石石材',
    '浅色大理石', '意式地砖', '木纹大理石'
  ],
  木地板: [
    '拼花木地板', '人字拼木地板', '鱼骨木地板', '胡桃木地板', '户外木地板', '塑木地板',
    '防腐木地板', '柚木地板', '原木地板', '橡木地板', '深色木地板', '红木地板'
  ],
  瓷砖: [
    '柔光砖', '灰色瓷砖', '白色瓷砖', '条形砖', '大理石瓷砖', '黑色瓷砖', '哑光砖',
    '卫生间瓷砖', '素色瓷砖', '暖色地砖', '厨房砖', '花纹砖'
  ],
  木纹: [
    '胡桃木', '原木木纹', '枫木', '科技木', '烟熏橡木', '深色木纹', '浅色木纹', '树瘤',
    '白蜡木', '乌金木', '旧木纹', '松木', '橡木木纹', '金丝楠木', '黄花梨'
  ],
  地毯: ['圆形地毯', '几何地毯', '条纹地毯', '办公地毯', '酒店地毯', '儿童地毯', '格子地毯'],
  外景: ['天空外景', '街道外景', '小区外景', '城市外景', '乡村', '外立面', '风景'],
  木材: ['板材', '藤编', '竹编', '竹子', '木头', '树皮', '年轮'],
  挂画: ['装饰画', '山水画', '油画', '抽象画', '字画', '水墨画', '艺术画', '黑白挂画'],
  玻璃: ['夹丝玻璃', '长虹玻璃', '花纹玻璃', '玻璃砖'],
  金属: ['穿孔板', '金属网', '金属板', '水波纹金属', '鎏金板', '做旧金属', '金属格栅', '集装箱', '金属浮雕', '金箔/银箔'],
  壁纸壁画: ['壁纸', '壁画'],
  布纹: [
    '花纹布纹', '绒布', '麻布', '丝绸', '纱布', '羊羔绒', '针织', '毛毡/毛呢', '抱枕', '窗帘',
    '棉布', '素色布纹', '条纹布', '扎染', '刺绣', '蕾丝', '牛仔布', '迷彩布'
  ],
  皮革: ['编织皮', '细纹皮革', '粗纹皮革', '动物皮毛'],
  墙面地面屋面: [
    '硬包', '软包', '吊顶', '文化墙', '黑板', '夯土', '水泥', '绿植墙', '涂鸦墙', '塑胶地板',
    '自然地面', '路面', '瓦', '茅草', '太阳能板', '石膏'
  ],
  HDR贴图: ['天空HDR', '城市HDR', '小区HDR', '室内HDR', '户外HDR'],
  涂料: [
    '艺术漆', '乳胶漆', '真石漆', '微水泥', '硅藻泥', '地坪漆', '金属漆', '稻草漆', '马来漆',
    '裂纹漆', '浮雕漆', '灰泥'
  ],
  凹凸贴图: ['法线', '反射贴图', '黑白凹凸', '高光'],
  素材贴图: [
    '屏幕', '杜邦纸', '塑料', '麻绳', '鱼缸', '门', '窗户', '水面', '剪影', '月球表面',
    '纸书本', '美食', '灯膜/灯罩', '壁炉/火焰', '室内场景', '亚克力'
  ],
  商业元素: ['招牌', '广告', '店铺', '菜单']

  // ⛔ v1.0.3 裁定：**不建** `材质预设: []` 占位键。
  // `LEVEL2_MAP` 的 key 语义是**一级分类名**，`材质预设` 是大类名——把大类名混进一级键空间
  // 是不可被合法查询的死键。删除后行为不变：`level2Of(<材质一级名>) → undefined → []`
  // → UI 渲染为「可自由输入」。材质频道的一级词表归属改记在 `CHANNEL_LEVEL1.material`。
}

/**
 * 【v1.0.14 / docs/18】**材质频道专属的「一级 → 二级」表**（20 键 / 106 项）。
 *
 * 来源：`docs/18-知末材质频道词表-原始抄录.md`（2026-10-20 用真实浏览器逐个点进
 * 一级页抄录；**首页不显示二级排**，必须先点进一级才出现）。逐项照抄，不改名、不合并。
 *
 * ⚠️ **旧结论已证伪**：`docs/07` §5.11 写「材质无二级分类排」是在频道**首页**观察的
 * 结果，属采集深度不足（详见 docs/18 §0 与 07 的勘误条）。实测 21 个一级里 **20 个有二级**，
 * 只有「其他」没有（故本表**不建 `其他` 键**——那是"一级即终点"的合法终点，不是漏抄）。
 *
 * ⚠️ **为什么不并进 `LEVEL2_MAP`**（关键设计决策）：
 * ① `LEVEL2_MAP` 是**模型频道 + 贴图频道**共用的一级键空间，材质二级若并进去，
 *    模型资产命中的「植物」会去匹配「材质/植物」的 花草/树木/绿植 —— 跨频道污染；
 * ② 9 个同名一级的二级清单**没有一个与贴图频道一致**（docs/18 §4：木材零重合、
 *    石材/金属/涂料仅 1~2 项偶合），复用贴图二级会系统性错分；
 * ③ 分表后 `LEVEL2_MAP` 一个键都不动，40 键 / 188 二级 / 8 组重名的守卫全部不受影响。
 *
 * 使用方（唯一）：`autoClassify(..., { level2Scope: 'material' })` —— 由
 * `shared/classifyAsset.classifyAssetName` 在 `kind` 为材质容器时传入。
 * 匹配规则与二级词条完全一致（CJK 后缀/全等、规则 A/B/B-2、最长优先）。
 *
 * ⚠️ 本表的 20 个一级必须都落在 `MERGED_MATERIAL_LEVEL1`（33 项并集）里，否则会被
 * kind 闸门丢掉（`tests/taxonomy.test.ts` 有守卫）。
 *
 * ⚠️ **已知限制（站方词表颗粒度导致，不是匹配 bug，不要用启发式去"修"）**：
 * 金属组有 5 个**单字二级** `金 / 银 / 铜 / 铁 / 铝`。匹配器对 CJK 词条用**尾字锚定**
 * （规则 1），于是 `铝合金` 会命中单字「金」→ 落 `金属/金`，**不是** `金属/铝`；
 * 同理 `镍合金` → `金属/金`。这是站方把「金属种类」切到单字的必然结果（`金` 既指黄金
 * 也指"含金/金属"），任何"看前缀猜材质"的启发式都会引入更大的误伤（例如把「金箔」
 * 判成非金属）。要么接受现状，要么走 06 §12.2 补抄录、把站方词表升级为多字写法。
 */
export const MATERIAL_LEVEL2_MAP: Readonly<Record<string, readonly string[]>> = {
  // 7
  石材: ['大理石', '岩板', '瓷砖', '文化石', '水磨石', '木纹砖', '其他石材'],
  // 5
  木材: ['高光木纹', '哑光木纹', '粗糙木纹', '原木木纹', '其他木材'],
  // 4
  木地板: ['工字拼木地板', '人字拼木地板', '田字拼木地板', '其他木地板'],
  // 4
  地毯: ['方形地毯', '圆形地毯', '满铺地毯', '其他地毯'],
  // 4
  布料: ['棉布', '麻布', '绒布', '其他布料'],
  // 10
  金属: ['金', '银', '铜', '铁', '铝', '不锈钢', '花纹板', '铝扣板', '穿孔板', '其他金属'],
  // 5
  皮革: ['打孔皮革', '压纹皮革', '编织皮革', '车线皮革', '其他皮革'],
  // 6
  玻璃: ['透明玻璃', '磨砂玻璃', '彩色玻璃', '夹丝玻璃', '玻璃幕墙', '其他玻璃'],
  // 7
  塑料: ['高光塑料', '哑光塑料', '粗糙塑料', '亚克力', '地胶板', '橡胶', '其他塑料'],
  // 4
  陶瓷: ['高光陶瓷', '哑光陶瓷', '粗糙陶瓷', '其他陶瓷'],
  // 6
  涂料: ['乳胶漆', '硅藻泥', '烤漆', '油漆', '车漆', '其他涂料'],
  // 4
  墙面: ['墙纸', '墙布', '护墙板', '其他墙面'],
  // 12
  地面: [
    '地坪漆', '泥地', '沙地', '草地', '雪地', '沥青', '路面', '跑道',
    '水泥地面', '石子地面', '户外地砖', '其他地面'
  ],
  // 4
  植物: ['花草', '树木', '绿植', '其他植物'],
  // 7
  外景: ['小区景观', '城市景观', '街景', '建筑外立面', '天空', '风景', '其他外景'],
  // 3
  皮肤器官: ['人物皮肤', '动物皮肤', '其他皮肤器官'],
  // 3
  液体: ['自然水', '泳池水', '其他液体'],
  // 4
  食物: ['蔬菜', '水果', '甜品', '其他食物'],
  // 4
  纸制品: ['书籍报刊', '牛皮纸', '纸张', '其他纸制品'],
  // 3
  半透明体: ['水晶', '玉石', '其他半透明体']
  // 「其他」一级：站方无二级排，**不建键**（不是漏抄，见 docs/18 §3.21）
}

/**
 * 【v0.8.5 / docs/34 §二】**CAD 频道专属的「一级 → 二级」表**（10 键 / **102 项**，
 * 去重后 **97** 个二级名）。
 *
 * 来源：`docs/probe/cad-taxonomy/cad_tree.json` 的 `categories[].children[].name`
 * （Python 脚本从站方 SSR `__NEXT_DATA__` 逐字段取词，**非手工录入**）。
 * 每组首项「全部」= 不筛选，**不进枚举**。
 *
 * ⚠️ **为什么不并进 `LEVEL2_MAP`**（与 `MATERIAL_LEVEL2_MAP` 同一条原则）：
 * ① `LEVEL2_MAP` 是**模型 + 贴图**共用的一级键空间，CAD 的一级虽然与它们零同名
 *    （10 ∩ 19 ∩ 21 = ∅，键唯一性不冲突），但 **CAD 的 97 个二级里有 28 个与 SU 词表重名**
 *    （别墅 / 卧室 / 客厅 / 餐厅 / 办公空间 / 餐饮空间 / 商业空间 / 公共空间 / 医疗空间 /
 *    景观小品 / 庭院景观 / 公园景观 / 广场景观 / 商业景观 / 商业建筑 / 办公建筑 /
 *    公共建筑 / 交通建筑 …）。并进去之后 `autoClassify` 的**跨频道扫描**会让一个 SU
 *    模型名「餐厅」命中 `家装空间/餐厅` —— 那是**跨频道污染**，不是"更细的分类"。
 * ② 分表后 `LEVEL2_MAP` 一个键都不动（仍 40 键 / 8 组重名），既有守卫与断言零影响。
 *
 * 使用方（唯一）：`autoClassify(..., { level2Scope: 'cad' })` —— 由
 * `shared/classifyAsset.classifyAssetName` 在 `kind === 'cad'` 时传入。
 *
 * ⚠️ **5 组重名二级（同名词挂在两个一级下）**：本表**两处都保留**（键不同，不冲突），
 * 但页面只认 `canonicalParentFromPage` 那个父级 —— 命中时的 `category1` 以
 * `CAD_LEVEL2_CANONICAL_PARENT` 为准（见下一个常量）：
 *   - 景观图库：出现于 CAD图库 + 园林景观 → 页面实际归属 **园林景观**
 *   - 景观节点详图：出现于 节点详图 + 园林景观 → 页面实际归属 **园林景观**
 *   - 结构节点图：出现于 节点详图 + 结构设计 → 页面实际归属 **结构设计**
 *   - 建筑节点：出现于 节点详图 + 建筑设计 → 页面实际归属 **建筑设计**
 *   - 电气工程节点：出现于 节点详图 + 机电工程 → 页面实际归属 **机电工程**
 */
export const CAD_LEVEL2_MAP: Readonly<Record<string, readonly string[]>> = {
  // CAD图库（16 项）
  'CAD图库': [
    '制图规范', '填充图案', '家具图库', '灯具图库', '软装摆件图库', '工装图库', '植物图库', '人物动物图库', '硬装构件图库', '厨房卫浴设施',
    '器材设备图库', '标识图库', '交通工具图库', '地图图库', '剪影图库', '景观图库'
  ],
  // 节点详图（9 项）
  节点详图: [
    '室内工艺节点', '家具节点详图', '灯节点', '卫浴节点', '器材设备详图', '景观节点详图', '结构节点图', '建筑节点', '电气工程节点'
  ],
  // 家装空间（20 项）
  家装空间: [
    '别墅', '平层', '公寓', '卧室', '客厅', '餐厅', '儿童房', '客餐厅', '茶室', '卫生间', '书房', '阳台', '厨房', '衣帽间',
    '影音室', '佛堂', '电竞房', '洗衣房', '玄关', '酒窖'
  ],
  // 工装空间（12 项）
  工装空间: [
    '办公空间', '餐饮空间', '商业空间', '酒店', '运动场', '民宿', '休闲娱乐空间', '公共空间', '医疗空间', '教育空间', '文化空间', '展厅'
  ],
  // 园林景观（15 项）
  园林景观: [
    '景观图库', '景观小品', '酒店度假景观', '庭院景观', '屋顶花园', '公园景观', '居住区景观', '医疗教育景观', '道路绿化', '广场景观',
    '商业景观', '乡村景观', '办公工业景观', '商业街景观', '景观节点详图'
  ],
  // 建筑设计（11 项）
  建筑设计: [
    '酒店民宿建筑', '商业建筑', '办公建筑', '公共建筑', '居住建筑', '教育建筑', '交通建筑', '文化建筑', '古建筑', '规划设计', '建筑节点'
  ],
  // 平立面系统图（3 项）
  平立面系统图: [
    '户型优化', '立面图/剖面图', '平面图'
  ],
  // 结构设计（6 项）
  结构设计: [
    '钢结构', '木结构', '混凝土结构', '幕墙结构', '砌体结构', '结构节点图'
  ],
  // 机电工程（7 项）
  机电工程: [
    '电气工程节点', '给排水', '电气图', '暖通图', '消防图', '水处理', '机械设备'
  ],
  // 其他图纸（3 项）
  其他图纸: [
    '三视图', '吊顶图', '水电图'
  ]
}

/**
 * 【v0.8.5 / docs/34 §二】上表 **5 组重名二级的「页面实际归属」覆盖表**。
 *
 * 为什么要单独一张表（而不是给词条加 `level1Override` 字段）：
 * ① `CAD_LEVEL2_MAP` 的类型是 `Record<string, readonly string[]>`（纯数据、与
 *    `MATERIAL_LEVEL2_MAP` 同形），塞字段就得改类型、连带改变所有读表方；
 * ② 覆盖值是**站方事实**（`canonicalParentFromPage`），与词条本身正交 ——
 *    放在独立常量里可审计、可测试，且两处重名（同名出现在两个一级下）只需记一条；
 * ③ 匹配侧只需在 `pickBest` 之后查一次表，命中才覆盖，零额外分支。
 *
 * 语义：`category1` 取本表的值（页面真的会落到这个一级），另一个一级进
 * `alternativeCategories1`（用户可改派）。**无覆盖项的词条**按所在键的一级落盘。
 */
export const CAD_LEVEL2_CANONICAL_PARENT: Readonly<Record<string, string>> = {
  '景观图库': '园林景观',
  '景观节点详图': '园林景观',
  '结构节点图': '结构设计',
  '建筑节点': '建筑设计',
  '电气工程节点': '机电工程'
}

/**
 * 【v1.0.10 / docs/17】三级节点 → 上级二级的**归并表**。
 *
 * 知末的分类树是**三级**，我们的落盘结构是四级（大类/一级/二级/资产），
 * 所以三级节点被归并到它的上级二级里 —— **落盘结构不变，只是让它能被识别**。
 * 每一行都有站点出处（见 `docs/17-知末分类树补充抄录.md`），**不是自创词**。
 *
 * 用法（`autoClassify.ts`）：
 * - 命中规则与二级词条**完全一致**：CJK token 的**后缀或全等**，最长优先；
 * - 命中后 `category1/category2` 用本表指定的值，`matchedTerm` 记**实际命中的词**；
 * - 与二级词条命中同为"二级强度"，等长时**二级原文优先**。
 *
 * ⚠️ 归并不等于"把三级名写进二级词表"：`LEVEL2_MAP` 仍是落盘枚举的唯一权威，
 * 本表只影响**匹配**。若要真正新增一个二级类目，仍走 06 §12.2 的补抄录流程。
 */
export interface Level3Alias {
  /** 三级节点原文（站方写法） */
  term: string
  /** 归并到的上级二级（必须已存在于 LEVEL2_MAP 的对应一级下） */
  level1: string
  level2: string
  /** 站方节点 URL，留档用（由节点名派生的中心语形式可省略） */
  source?: string
}

export const LEVEL3_ALIAS: readonly Level3Alias[] = [
  // ── 硬装构件 > 屏风隔断 ───────────────────────────────────────
  { term: '屏风', level1: '硬装构件', level2: '屏风隔断', source: 'https://su.znzmo.com/sunewhome/dhpf.html' },
  { term: '隔断', level1: '硬装构件', level2: '屏风隔断', source: 'https://su.znzmo.com/sunewhome/gd.html' },
  // ── 软装陈设 > 摆件（站方三级 `花瓶花艺` / `绿植摆件`）────────────
  { term: '花瓶花艺', level1: '软装陈设', level2: '摆件', source: 'https://su.znzmo.com/sunewhome/hp.html' },
  // 「花瓶」是从站方三级节点名 `花瓶花艺` 派生的**中心语**（无独立节点 URL），
  // 目的是让「陶瓷花瓶」「玻璃花瓶」这类命名能命中；落盘仍归并到 摆件。
  { term: '花瓶', level1: '软装陈设', level2: '摆件' },
  // `绿植` 站方双归属（植物 > 盆栽 / 软装陈设 > 摆件 > 绿植摆件），取 植物/盆栽 为主；
  // `绿植摆件` 是从该双归属节点的完整名派生，明确指向 软装陈设/摆件。
  { term: '绿植', level1: '植物', level2: '盆栽' },
  { term: '绿植摆件', level1: '软装陈设', level2: '摆件' },
  // ── 家具 > 茶几（站方三级 `边几角几`）──────────────────────────
  { term: '边几角几', level1: '家具', level2: '茶几', source: 'https://su.znzmo.com/sunewhome/bianj.html' },
  // 「边几」由 `边几角几` 派生（中文常单说「边几」）
  { term: '边几', level1: '家具', level2: '茶几' },
  // ── 家具 > 沙发（站方三级 `卡座沙发`）──────────────────────────
  { term: '卡座沙发', level1: '家具', level2: '沙发', source: 'https://su.znzmo.com/sunewhome/kzsf.html' },
  // 「卡座」由 `卡座沙发` 派生（餐厅卡座 / 卡座区 常单说「卡座」）
  { term: '卡座', level1: '家具', level2: '沙发' }
]

/**
 * 【v0.8.5 / docs/34 §三】**CAD 频道三级节点 → 上级二级的归并表**（**364** 条 / 源 368 项）。
 *
 * 知末分类树是**三级**，我们的落盘结构是四级（大类/一级/二级/资产），所以三级节点
 * **归并到它的上级二级** —— 落盘结构不变，只是让它能被文件名识别。
 * 用法与 `LEVEL3_ALIAS` **完全一致**（同一个 `matchTerm`：CJK 后缀/全等、词根、尾部剥离；
 * 命中后 `category2` 取归并表指定的二级，`matchedTerm` 记实际命中的三级词）。
 * ⚠️ 但**必须作用域隔离**：只有在 `autoClassify(..., { level2Scope: 'cad' })` 时才扫本表 ——
 * 364 项里有 24 项与 SU 词表重名（沙发 / 桌子 / 窗帘 / 地毯 / 挂画 / 摆件 / 人物 / 动物 /
 * 壁炉 / 背景墙 / 屏风隔断 / 桁架 / 大平层 / 商场 …），塞进全局表会污染模型分类。
 *
 * ── 368 → 364：4 组重名的处理（逐条，别改）──────────────────
 * ① `暖通节点` / `电气节点` / `水处理节点`：同时挂在 `节点详图 > 电气工程节点` 与
 *    `机电工程 > 电气工程节点` 下（同一 termId、同一 URL）。直连 URL 落到**机电工程**那一支
 *    （`directUrlRendersOwnBranch:false` 的两条正是节点详图那支）→ **取 `机电工程/电气工程节点`**，
 *    与页面实际渲染一致。
 * ② `展台`：同时挂在 `工装空间 > 公共空间` 与 `工装空间 > 展厅` 下（两条都可达）。
 *    同一 term 写两条会让匹配结果依赖数组顺序 → **只留先出现的 `公共空间`**；
 *    另一归属 `工装空间/展厅` 客观存在，记在此处备查。
 *
 * 去重规则（脚本实现，可复现）：同 term 优先取 `directUrlRendersOwnBranch:true` 的那条，
 * 都 true 时取**站方一级顺序里先出现者**。
 *
 * ⚠️ 368 项**全部保留**（含 21 项「从二级点不进去」的 `reachable:false`）——
 * 我们要的是**文件名匹配**而不是给用户点导航，那 21 项的 name 与 parent 都是站方真实值。
 */
export const CAD_LEVEL3_ALIAS: readonly Level3Alias[] = [
  // ── CAD图库 > 制图规范 ────────────────────────────────
  { term: '图例', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/tukuangtuli.html' },
  { term: '图框', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/tukuang.html' },
  { term: '设计说明', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/shejism.html' },
  { term: '封面', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/fengmian.html' },
  { term: '指北针', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/zhibeizhen.html' },
  { term: '字体', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/ziti.html' },
  { term: '罗盘', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/luopan.html' },
  { term: '索引图', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/suoyintu.html' },
  { term: '图表', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/tubiao.html' },
  { term: '综合制图规范', level1: 'CAD图库', level2: '制图规范', source: 'https://sgt.znzmo.com/sgt/zonghezhitu.html' },
  // ── CAD图库 > 家具图库 ────────────────────────────────
  { term: '沙发', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/shafa.html' },
  { term: '柜子', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/guiti.html' },
  { term: '吧台', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/batai.html' },
  { term: '榻榻米', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/tatami.html' },
  { term: '床', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/chuang.html' },
  { term: '椅子', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/yizi.html' },
  { term: '桌椅', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/zhuoyi.html' },
  { term: '桌子', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/zhuozi.html' },
  { term: '遮阳伞', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/zheyangsan.html' },
  { term: '家具图库', level1: 'CAD图库', level2: '家具图库', source: 'https://sgt.znzmo.com/sgt/qitajiaju.html' },
  // ── CAD图库 > 软装摆件图库 ──────────────────────────────
  { term: '窗帘', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/cl.html' },
  { term: '地毯', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/ditan.html' },
  { term: '挂画', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/guahua.html' },
  { term: '摆件', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/baijian.html' },
  { term: '书', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/shu.html' },
  { term: '玩具', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/wanju.html' },
  { term: '镜子', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/jingzi.html' },
  { term: '鱼缸', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/yugang.html' },
  { term: '珠宝首饰', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/zhubao.html' },
  { term: '佛龛佛像', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/foxiang.html' },
  { term: '服装鞋帽', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/fzxm.html' },
  { term: '食物', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/shiwu.html' },
  { term: '综合软装摆件图库', level1: 'CAD图库', level2: '软装摆件图库', source: 'https://sgt.znzmo.com/sgt/zongherzbj.html' },
  // ── CAD图库 > 工装图库 ────────────────────────────────
  { term: '办公家具图库', level1: 'CAD图库', level2: '工装图库', source: 'https://sgt.znzmo.com/sgt/jjbgtk.html' },
  { term: '酒店家具', level1: 'CAD图库', level2: '工装图库', source: 'https://sgt.znzmo.com/sgt/jdjj.html' },
  { term: '餐厅家具', level1: 'CAD图库', level2: '工装图库', source: 'https://sgt.znzmo.com/sgt/ctjj.html' },
  { term: '展览展厅家具', level1: 'CAD图库', level2: '工装图库', source: 'https://sgt.znzmo.com/sgt/zlztjj.html' },
  { term: '工装综合图库', level1: 'CAD图库', level2: '工装图库', source: 'https://sgt.znzmo.com/sgt/gzzhtk.html' },
  // ── CAD图库 > 植物图库 ────────────────────────────────
  { term: '树', level1: 'CAD图库', level2: '植物图库', source: 'https://sgt.znzmo.com/sgt/shutk.html' },
  { term: '花', level1: 'CAD图库', level2: '植物图库', source: 'https://sgt.znzmo.com/sgt/huatk.html' },
  { term: '综合植物图库', level1: 'CAD图库', level2: '植物图库', source: 'https://sgt.znzmo.com/sgt/zhzhiwu.html' },
  // ── CAD图库 > 人物动物图库 ──────────────────────────────
  { term: '人物', level1: 'CAD图库', level2: '人物动物图库', source: 'https://sgt.znzmo.com/sgt/renwu.html' },
  { term: '动物', level1: 'CAD图库', level2: '人物动物图库', source: 'https://sgt.znzmo.com/sgt/dongwu.html' },
  { term: '人体工程学', level1: 'CAD图库', level2: '人物动物图库', source: 'https://sgt.znzmo.com/sgt/rtgcx.html' },
  { term: '综合人物动物图库', level1: 'CAD图库', level2: '人物动物图库', source: 'https://sgt.znzmo.com/sgt/zgrwdw.html' },
  // ── CAD图库 > 硬装构件图库 ──────────────────────────────
  { term: '门窗', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/menchuangsc.html' },
  { term: '壁炉', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/bilu.html' },
  { term: '开关插座', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/kaiguangcz.html' },
  { term: '背景墙', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/dianshibjq.html' },
  { term: '文化墙', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/wenhuaqiang.html' },
  { term: '雕花', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/dh.html' },
  { term: '地面拼花', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/dianmianph.html' },
  { term: '屏风隔断', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/xuanguangd.html' },
  { term: '柜门', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/guimen.html' },
  { term: '五金管件', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/wj.html' },
  { term: '线条/雕花', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/diaohua.html' },
  { term: '栏杆/楼梯', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/langanlouti.html' },
  { term: '综合硬装构件图库', level1: 'CAD图库', level2: '硬装构件图库', source: 'https://sgt.znzmo.com/sgt/zhyzgjtk.html' },
  // ── CAD图库 > 厨房卫浴设施 ──────────────────────────────
  { term: '厨房设施', level1: 'CAD图库', level2: '厨房卫浴设施', source: 'https://sgt.znzmo.com/sgt/chufangshebei.html' },
  { term: '卫浴设施', level1: 'CAD图库', level2: '厨房卫浴设施', source: 'https://sgt.znzmo.com/sgt/weiyusheshi.html' },
  { term: '综合厨房卫浴设施', level1: 'CAD图库', level2: '厨房卫浴设施', source: 'https://sgt.znzmo.com/sgt/zhcfwy.html' },
  // ── CAD图库 > 器材设备图库 ──────────────────────────────
  { term: '帐篷', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/zhangpeng.html' },
  { term: '监控', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/jiankong.html' },
  { term: '乐器', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/yueqi.html' },
  { term: '电器', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/dq.html' },
  { term: '晾衣架', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/laingyijia.html' },
  { term: '运动器材', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/ydqc.html' },
  { term: '娱乐器材', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/ylqc.html' },
  { term: '儿童器材', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/ertongqicai.html' },
  { term: '消防器材', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/xiaofangqicai.html' },
  { term: '摊位', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/tanwei.html' },
  { term: '施工设备', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/shigongshebei.html' },
  { term: '综合器材设备图库', level1: 'CAD图库', level2: '器材设备图库', source: 'https://sgt.znzmo.com/sgt/zhqcsb.html' },
  // ── 节点详图 > 室内工艺节点 ───────────────────────────────
  { term: '吊顶节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/dianding.html' },
  { term: '楼梯节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/loutilang.html' },
  { term: '门节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/menjiedian.html' },
  { term: '地面节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/dm.html' },
  { term: '墙面节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/qiangm.html' },
  { term: '窗节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/chuangjd.html' },
  { term: '包柱节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/baozhujd.html' },
  { term: '包管节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/baoguanjiedian.html' },
  { term: '隔断节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/gdjd.html' },
  { term: '收口节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/shoukoujd.html' },
  { term: '梁节点', level1: '节点详图', level2: '室内工艺节点', source: 'https://sgt.znzmo.com/sgt/liangjd.html' },
  // ── 节点详图 > 家具节点详图 ───────────────────────────────
  { term: '吧台节点', level1: '节点详图', level2: '家具节点详图', source: 'https://sgt.znzmo.com/sgt/bataijiedian.html' },
  { term: '柜体节点', level1: '节点详图', level2: '家具节点详图', source: 'https://sgt.znzmo.com/sgt/GTJD.html' },
  { term: '卡座节点', level1: '节点详图', level2: '家具节点详图', source: 'https://sgt.znzmo.com/sgt/KZJD.html' },
  { term: '前台节点', level1: '节点详图', level2: '家具节点详图', source: 'https://sgt.znzmo.com/sgt/qiantaijiedian.html' },
  { term: '综合家具节点', level1: '节点详图', level2: '家具节点详图', source: 'https://sgt.znzmo.com/sgt/ZHJJJD.html' },
  // ── 节点详图 > 卫浴节点 ─────────────────────────────────
  { term: '地漏节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/DLJD.html' },
  { term: '镜子节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/JZJD.html' },
  { term: '淋浴房节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/LYJD.html' },
  { term: '拖把池节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/TBJD.html' },
  { term: '卫生间防水', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/WSJFS.html' },
  { term: '卫生间排水', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/WSJPS.html' },
  { term: '洗手台节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/XSTJD.html' },
  { term: '卫生间隔断', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/WSJGD.html' },
  { term: '卫生间综合节点', level1: '节点详图', level2: '卫浴节点', source: 'https://sgt.znzmo.com/sgt/WSJZHJD.html' },
  // ── 节点详图 > 结构节点图 ────────────────────────────────
  { term: '桁架', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/hj.html' },
  { term: '钢结构节点', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/gangjgjd.html' },
  { term: '混凝土节点', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/hunntjd.html' },
  { term: '幕墙结构节点', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/muqiangjgjd.html' },
  { term: '转换层', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/zhc.html' },
  { term: '其他结构设计', level1: '节点详图', level2: '结构节点图', source: 'https://sgt.znzmo.com/sgt/qtjgjd.html' },
  // ── 节点详图 > 建筑节点 ─────────────────────────────────
  { term: '吊装节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/DZJD.html' },
  { term: '斗拱节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/DGJD.html' },
  { term: '楼板节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/LBJD.html' },
  { term: '女儿墙节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/NEQJD.html' },
  { term: '塔吊节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/DTJD.html' },
  { term: '天窗节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/TCJD.html' },
  { term: '屋檐节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/WYJD.html' },
  { term: '屋顶节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/WDJD.html' },
  { term: '柱子节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/ZZJD.html' },
  { term: '建筑综合节点', level1: '节点详图', level2: '建筑节点', source: 'https://sgt.znzmo.com/sgt/JZZHJD.html' },
  // ── 节点详图 > 电气工程节点 ───────────────────────────────
  { term: '给排水节点', level1: '节点详图', level2: '电气工程节点', source: 'https://sgt.znzmo.com/sgt/geipsjd.html' },
  { term: '其他电气工程节点', level1: '节点详图', level2: '电气工程节点', source: 'https://sgt.znzmo.com/sgt/qtdqgcjd.html' },
  // ── 家装空间 > 平层 ───────────────────────────────────
  { term: '大平层', level1: '家装空间', level2: '平层', source: 'https://sgt.znzmo.com/sgt/dapingceng.html' },
  { term: '小户型平层', level1: '家装空间', level2: '平层', source: 'https://sgt.znzmo.com/sgt/xiaohuxing.html' },
  { term: '超大型平层', level1: '家装空间', level2: '平层', source: 'https://sgt.znzmo.com/sgt/cdxpc.html' },
  // ── 家装空间 > 公寓 ───────────────────────────────────
  { term: 'loft公寓', level1: '家装空间', level2: '公寓', source: 'https://sgt.znzmo.com/sgt/loftgy.html' },
  { term: '公寓', level1: '家装空间', level2: '公寓', source: 'https://sgt.znzmo.com/sgt/qtgy.html' },
  { term: '单身公寓', level1: '家装空间', level2: '公寓', source: 'https://sgt.znzmo.com/sgt/dsgy.html' },
  { term: '复式公寓', level1: '家装空间', level2: '公寓', source: 'https://sgt.znzmo.com/sgt/fsgy.html' },
  { term: '酒店公寓', level1: '家装空间', level2: '公寓', source: 'https://sgt.znzmo.com/sgt/jdgy.html' },
  // ── 工装空间 > 办公空间 ─────────────────────────────────
  { term: '整体办公空间', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/duogongnt.html' },
  { term: '办公室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/bsngongs.html' },
  { term: '会议室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/huiyis.html' },
  { term: '直播间', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/zhibojian.html' },
  { term: '茶水间', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/chashuij.html' },
  { term: '接待室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/jiedaishi.html' },
  { term: '工作室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/gongzuoshi.html' },
  { term: '独立办公室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/dlbgs.html' },
  { term: '休息室', level1: '工装空间', level2: '办公空间', source: 'https://sgt.znzmo.com/sgt/huikt.html' },
  // ── 工装空间 > 餐饮空间 ─────────────────────────────────
  { term: '咖啡厅', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/kafeidian.html' },
  { term: '奶茶店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/naichadian.html' },
  { term: '火锅店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/huoguod.html' },
  { term: '中餐厅', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/zhongct.html' },
  { term: '西餐厅', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/xicant.html' },
  { term: '食堂', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/shitang.html' },
  { term: '自助餐厅', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/zizhuct.html' },
  { term: '快餐店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/kuaicand.html' },
  { term: '烧烤店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/shaokaod.html' },
  { term: '烤肉店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/kaoroudian.html' },
  { term: '蛋糕店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/tianpindian.html' },
  { term: '面包店', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/mianbaodian.html' },
  { term: '酒楼', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/jiulou.html' },
  { term: '后厨', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/houchu.html' },
  { term: '明档', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/mingdang.html' },
  { term: '茶餐厅', level1: '工装空间', level2: '餐饮空间', source: 'https://sgt.znzmo.com/sgt/chacanting.html' },
  // ── 工装空间 > 商业空间 ─────────────────────────────────
  { term: '服装店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/fuzhuangdian.html' },
  { term: '便利店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/bianlidian.html' },
  { term: '书店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/shudian.html' },
  { term: '超市', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/chaos.html' },
  { term: '售楼处', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/shoulouzx.html' },
  { term: '商场', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/shangc.html' },
  { term: '婚纱店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/hunshadian.html' },
  { term: '农贸市场', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/nongmaoshivhang.html' },
  { term: '宠物店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/chongwudian.html' },
  { term: '花店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/huadian.html' },
  { term: '珠宝店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/zhubaodian.html' },
  { term: '文创店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/wenchuangdian.html' },
  { term: '烟酒店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/yanjiudian.html' },
  { term: '水果店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/shuiguodian.html' },
  { term: '眼镜店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/yanjingdian.html' },
  { term: '鞋店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/xiedian.html' },
  { term: '4s店', level1: '工装空间', level2: '商业空间', source: 'https://sgt.znzmo.com/sgt/sisdian.html' },
  // ── 工装空间 > 酒店 ───────────────────────────────────
  { term: '酒店', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/qtjiudiankj.html' },
  { term: '酒店客房', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/jiudiankf.html' },
  { term: '酒店套房', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/TF.html' },
  { term: '酒店公区', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/jiudiangq.html' },
  { term: '酒店大堂', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/jiudiandt.html' },
  { term: '酒店餐厅', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/JDCT.html' },
  { term: '酒店宴会厅', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/YHT.html' },
  { term: '酒店卫生间', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/JDWSJ.html' },
  { term: '其他酒店', level1: '工装空间', level2: '酒店', source: 'https://sgt.znzmo.com/sgt/QTJD.html' },
  // ── 工装空间 > 运动场 ──────────────────────────────────
  { term: '操场', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/caochang.html' },
  { term: '足球场', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/zuqiuchang.html' },
  { term: '羽毛球场', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/yumaoqiu.html' },
  { term: '网球场', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/wqc.html' },
  { term: '看台', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/kantai.html' },
  { term: '高尔夫', level1: '工装空间', level2: '运动场', source: 'https://sgt.znzmo.com/sgt/gaoerfu.html' },
  // ── 工装空间 > 休闲娱乐空间 ───────────────────────────────
  { term: '健身房', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/jiansf.html' },
  { term: '会所', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/xiuxianhs.html' },
  { term: '酒吧', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/jiub.html' },
  { term: '美容院', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/spamry.html' },
  { term: 'KTV', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/ktv.html' },
  { term: '棋牌室', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/qipais.html' },
  { term: '儿童乐园', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/ertongleyuan.html' },
  { term: '理发店', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/lifad.html' },
  { term: '茶馆', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/chas.html' },
  { term: '洗浴中心', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/xiyuzx.html' },
  { term: '台球厅', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/taiqiuting.html' },
  { term: '电影院', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/dianyy.html' },
  { term: '舞台', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/wutai.html' },
  { term: '网吧', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/wangba.html' },
  { term: '美甲店', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/meijiadina.html' },
  { term: '瑜伽馆', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/yujiaguan.html' },
  { term: '足浴店', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/zuyudian.html' },
  { term: '电玩城', level1: '工装空间', level2: '休闲娱乐空间', source: 'https://sgt.znzmo.com/sgt/dianwancheng.html' },
  // ── 工装空间 > 公共空间 ─────────────────────────────────
  { term: '楼梯间', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/loutijian.html' },
  { term: '停车场', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/tingchechang.html' },
  { term: '公共卫生间', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/weishengjian.html' },
  { term: '交通空间', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/jtkj.html' },
  { term: '宿舍', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/sushe.html' },
  { term: '门头', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/mentou.html' },
  { term: '母婴室', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/muyingshi.html' },
  { term: '市政单位', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/szdw.html' },
  { term: '活动中心', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/huodongzx.html' },
  { term: '展台', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/zhantai.html' },
  { term: '大厅', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/dating.html' },
  { term: '仓库', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/cagnku.html' },
  { term: '更衣室', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/gengyishi.html' },
  { term: '服务中心', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/fuwuzx.html' },
  { term: '电梯厅', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/daintiting.html' },
  { term: '档案室', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/danganshi.html' },
  { term: '车间', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/chejian.html' },
  { term: '会展', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/huizhan.html' },
  { term: '走廊', level1: '工装空间', level2: '公共空间', source: 'https://sgt.znzmo.com/sgt/zoulang.html' },
  // ── 工装空间 > 医疗空间 ─────────────────────────────────
  { term: '医院', level1: '工装空间', level2: '医疗空间', source: 'https://sgt.znzmo.com/sgt/yiyuansn.html' },
  { term: '养老院', level1: '工装空间', level2: '医疗空间', source: 'https://sgt.znzmo.com/sgt/liaoyy.html' },
  { term: '中医馆', level1: '工装空间', level2: '医疗空间', source: 'https://sgt.znzmo.com/sgt/zhongyiguan.html' },
  { term: '月子中心', level1: '工装空间', level2: '医疗空间', source: 'https://sgt.znzmo.com/sgt/yuezizhongxin.html' },
  { term: '宠物医院', level1: '工装空间', level2: '医疗空间', source: 'https://sgt.znzmo.com/sgt/chongwuyiyuan.html' },
  // ── 工装空间 > 教育空间 ─────────────────────────────────
  { term: '幼儿园', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/youeryuansn.html' },
  { term: '学校', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/xuexiaosn.html' },
  { term: '教室', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/jiaoshi.html' },
  { term: '实验室', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/shiyanshi.html' },
  { term: '舞蹈室', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/wudaoshi.html' },
  { term: '画室', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/huashi.html' },
  { term: '培训中心', level1: '工装空间', level2: '教育空间', source: 'https://sgt.znzmo.com/sgt/peixunzx.html' },
  // ── 工装空间 > 文化空间 ─────────────────────────────────
  { term: '图书馆', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/tushuguanshinei.html' },
  { term: '博物馆', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/bowuguansn.html' },
  { term: '美术馆', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/meishuguan.html' },
  { term: '游泳馆', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/youyongguan.html' },
  { term: '科技馆', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/kejiguan.html' },
  { term: '剧院', level1: '工装空间', level2: '文化空间', source: 'https://sgt.znzmo.com/sgt/juyuanjz.html' },
  // ── 工装空间 > 展厅 ───────────────────────────────────
  { term: '企业展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/qyzt.html' },
  { term: '文化展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/whzt.html' },
  { term: '科技展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/kjzt.html' },
  { term: '家具展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/jjzt.html' },
  { term: '汽车展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/qczt.html' },
  { term: '展馆', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/zg.html' },
  { term: '其他展厅', level1: '工装空间', level2: '展厅', source: 'https://sgt.znzmo.com/sgt/qtzt.html' },
  // ── 园林景观 > 景观图库 ─────────────────────────────────
  { term: '铺装图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/puztk.html' },
  { term: '座凳图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/zuodengtk.html' },
  { term: '假山水景图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/jssjtk.html' },
  { term: '景墙图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/jingqiangtk.html' },
  { term: '围墙图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/weiqiangtk.html' },
  { term: '景观雕塑图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/jignguandskt.html' },
  { term: '植物配置图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/zhwupeizhi.html' },
  { term: '树池图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/shuchitk.html' },
  { term: '亭子图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/tingzikt.html' },
  { term: '水井图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/shuijingtk.html' },
  { term: '公墓图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/gongmukt.html' },
  { term: '菜地图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/caidikt.html' },
  { term: '微地形图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/weidixing.html' },
  { term: '综合景观图库', level1: '园林景观', level2: '景观图库', source: 'https://sgt.znzmo.com/sgt/zonghejgtk.html' },
  // ── 园林景观 > 景观小品 ─────────────────────────────────
  { term: '沙坑', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/shakeng.html' },
  { term: '花卉配置', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/huahuipeizhijd.html' },
  { term: '亭子', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/tingzi.html' },
  { term: '平台', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/qinshuipt.html' },
  { term: '廊架', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/langjia.html' },
  { term: '景观桥', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/jingguanqiao.html' },
  { term: '栈道', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/zhandao.html' },
  { term: '枯山水', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/kushanshui.html' },
  { term: '宣传栏', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/xuanchuanlan.html' },
  { term: '垃圾桶', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/lajitong.html' },
  { term: '门楼', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/menloujd.html' },
  { term: '围挡', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/weidang.html' },
  { term: '挡土墙', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/dangtuqiang.html' },
  { term: '雕塑', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/diaosu.html' },
  { term: '大棚', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/dapengjiedian.html' },
  { term: '景观坐凳', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/jgzuodeng.html' },
  { term: '水井', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/shuijingjd.html' },
  { term: '公墓', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/gongmujd.html' },
  { term: '升旗台', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/shengqitaijd.html' },
  { term: '停车位', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/tingcheweijd.html' },
  { term: '标识', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/biaoshijd.html' },
  { term: '雨棚', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/yupengjd.html' },
  { term: '景墙', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/jingqiang.html' },
  { term: '栏杆', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/langanjd.html' },
  { term: '水景', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/shuijing.html' },
  { term: '屋顶', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/wudingjd.html' },
  { term: '围墙', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/weiqiang.html' },
  { term: '铺装', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/puzhuangjd.html' },
  { term: '入口', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/rukoudamen.html' },
  { term: '树池', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/shuchihuatan.html' },
  { term: '坡道', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/podaojd.html' },
  { term: '综合景观小品', level1: '园林景观', level2: '景观小品', source: 'https://sgt.znzmo.com/sgt/qtjingguanjd.html' },
  // ── 园林景观 > 酒店度假景观 ───────────────────────────────
  { term: '度假村景观', level1: '园林景观', level2: '酒店度假景观', source: 'https://sgt.znzmo.com/sgt/djcjg.html' },
  { term: '酒店景观', level1: '园林景观', level2: '酒店度假景观', source: 'https://sgt.znzmo.com/sgt/jdjg.html' },
  { term: '民宿景观', level1: '园林景观', level2: '酒店度假景观', source: 'https://sgt.znzmo.com/sgt/msjg.html' },
  // ── 园林景观 > 公园景观 ─────────────────────────────────
  { term: '综合性公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/ZHXGY.html' },
  { term: '儿童公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/ETGY.html' },
  { term: '口袋公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/KDGY.html' },
  { term: '滨水公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/BSGY.html' },
  { term: '体育公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/TYGY.html' },
  { term: '湿地公园', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/SDGY.html' },
  { term: '露营', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/LY.html' },
  { term: '其他公园景观', level1: '园林景观', level2: '公园景观', source: 'https://sgt.znzmo.com/sgt/QTGYJG.html' },
  // ── 园林景观 > 居住区景观 ────────────────────────────────
  { term: '售楼处景观', level1: '园林景观', level2: '居住区景观', source: 'https://sgt.znzmo.com/sgt/slcjg.html' },
  { term: '示范区景观', level1: '园林景观', level2: '居住区景观', source: 'https://sgt.znzmo.com/sgt/shifanqu.html' },
  // ── 园林景观 > 乡村景观 ─────────────────────────────────
  { term: '乡村振兴', level1: '园林景观', level2: '乡村景观', source: 'https://sgt.znzmo.com/sgt/xczx.html' },
  { term: '乡村改造', level1: '园林景观', level2: '乡村景观', source: 'https://sgt.znzmo.com/sgt/xcgz.html' },
  { term: '其他乡村景观', level1: '园林景观', level2: '乡村景观', source: 'https://sgt.znzmo.com/sgt/qtxcjg.html' },
  // ── 园林景观 > 办公工业景观 ───────────────────────────────
  { term: '办公景观', level1: '园林景观', level2: '办公工业景观', source: 'https://sgt.znzmo.com/sgt/BGJG.html' },
  { term: '产业园景观', level1: '园林景观', level2: '办公工业景观', source: 'https://sgt.znzmo.com/sgt/cyyjg.html' },
  { term: '厂房景观', level1: '园林景观', level2: '办公工业景观', source: 'https://sgt.znzmo.com/sgt/cfjg.html' },
  { term: '其他办公工业景观', level1: '园林景观', level2: '办公工业景观', source: 'https://sgt.znzmo.com/sgt/qtbggyjg.html' },
  // ── 建筑设计 > 酒店民宿建筑 ───────────────────────────────
  { term: '酒店建筑', level1: '建筑设计', level2: '酒店民宿建筑', source: 'https://sgt.znzmo.com/sgt/bingguanjdjz.html' },
  { term: '民宿建筑', level1: '建筑设计', level2: '酒店民宿建筑', source: 'https://sgt.znzmo.com/sgt/minsujianzhu.html' },
  // ── 建筑设计 > 商业建筑 ─────────────────────────────────
  { term: '商业街建筑', level1: '建筑设计', level2: '商业建筑', source: 'https://sgt.znzmo.com/sgt/shangyj.html' },
  { term: '商业综合体建筑', level1: '建筑设计', level2: '商业建筑', source: 'https://sgt.znzmo.com/sgt/shangyezongheti.html' },
  { term: '美食街建筑', level1: '建筑设计', level2: '商业建筑', source: 'https://sgt.znzmo.com/sgt/meishijie.html' },
  { term: '农贸市场建筑', level1: '建筑设计', level2: '商业建筑', source: 'https://sgt.znzmo.com/sgt/nongmaoshchangjz.html' },
  { term: '售楼处建筑', level1: '建筑设计', level2: '商业建筑', source: 'https://sgt.znzmo.com/sgt/shoulouchu.html' },
  // ── 建筑设计 > 办公建筑 ─────────────────────────────────
  { term: '办公楼建筑', level1: '建筑设计', level2: '办公建筑', source: 'https://sgt.znzmo.com/sgt/bangongl.html' },
  { term: '产业园建筑', level1: '建筑设计', level2: '办公建筑', source: 'https://sgt.znzmo.com/sgt/chanyy.html' },
  { term: '厂房', level1: '建筑设计', level2: '办公建筑', source: 'https://sgt.znzmo.com/sgt/changfang.html' },
  // ── 建筑设计 > 公共建筑 ─────────────────────────────────
  { term: '公厕', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/ggcesuo.html' },
  { term: '停车楼', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/tingchelpou.html' },
  { term: '医院建筑', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/yiyuanjz.html' },
  { term: '消防站', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/xiaofangzhan.html' },
  { term: '行政机构建筑', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/xingzhengjg.html' },
  { term: '会议中心建筑', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/huiyizx.html' },
  { term: '门卫室建筑', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/menweishijz.html' },
  { term: '集装箱', level1: '建筑设计', level2: '公共建筑', source: 'https://sgt.znzmo.com/sgt/jizhuangxiang.html' },
  // ── 建筑设计 > 居住建筑 ─────────────────────────────────
  { term: '住宅楼建筑', level1: '建筑设计', level2: '居住建筑', source: 'https://sgt.znzmo.com/sgt/zhuzqjz.html' },
  { term: '四合院建筑', level1: '建筑设计', level2: '居住建筑', source: 'https://sgt.znzmo.com/sgt/siheyuanjz.html' },
  { term: '别墅建筑', level1: '建筑设计', level2: '居住建筑', source: 'https://sgt.znzmo.com/sgt/bieshujz.html' },
  // ── 建筑设计 > 教育建筑 ─────────────────────────────────
  { term: '幼儿园建筑', level1: '建筑设计', level2: '教育建筑', source: 'https://sgt.znzmo.com/sgt/youeryuan.html' },
  { term: '学校建筑', level1: '建筑设计', level2: '教育建筑', source: 'https://sgt.znzmo.com/sgt/xuexiaojz.html' },
  // ── 建筑设计 > 交通建筑 ─────────────────────────────────
  { term: '驿站', level1: '建筑设计', level2: '交通建筑', source: 'https://sgt.znzmo.com/sgt/yizhan.html' },
  { term: '加油站', level1: '建筑设计', level2: '交通建筑', source: 'https://sgt.znzmo.com/sgt/jiayouz.html' },
  { term: '客运站', level1: '建筑设计', level2: '交通建筑', source: 'https://sgt.znzmo.com/sgt/keyunzhan.html' },
  { term: '机场建筑', level1: '建筑设计', level2: '交通建筑', source: 'https://sgt.znzmo.com/sgt/jichangjz.html' },
  { term: '服务区', level1: '建筑设计', level2: '交通建筑', source: 'https://sgt.znzmo.com/sgt/fuwuqu.html' },
  // ── 建筑设计 > 文化建筑 ─────────────────────────────────
  { term: '图书馆建筑', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/tushuguan.html' },
  { term: '博物馆建筑', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/bowuguan.html' },
  { term: '体育馆建筑', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/tiyuegjz.html' },
  { term: '美术馆建筑', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/meishuguanjz.html' },
  { term: '游泳馆建筑', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/youyonggjz.html' },
  { term: '教堂', level1: '建筑设计', level2: '文化建筑', source: 'https://sgt.znzmo.com/sgt/jiaotangjz.html' },
  // ── 建筑设计 > 古建筑 ──────────────────────────────────
  { term: '祠堂', level1: '建筑设计', level2: '古建筑', source: 'https://sgt.znzmo.com/sgt/citang.html' },
  { term: '寺庙', level1: '建筑设计', level2: '古建筑', source: 'https://sgt.znzmo.com/sgt/simiao.html' },
  { term: '徽派建筑', level1: '建筑设计', level2: '古建筑', source: 'https://sgt.znzmo.com/sgt/hpjz.html' },
  { term: '仿古建筑', level1: '建筑设计', level2: '古建筑', source: 'https://sgt.znzmo.com/sgt/fgjz.html' },
  { term: '其他古建筑', level1: '建筑设计', level2: '古建筑', source: 'https://sgt.znzmo.com/sgt/qtgjz.html' },
  // ── 建筑设计 > 规划设计 ─────────────────────────────────
  { term: '城市规划', level1: '建筑设计', level2: '规划设计', source: 'https://sgt.znzmo.com/sgt/chengshigh.html' },
  { term: '公园规划', level1: '建筑设计', level2: '规划设计', source: 'https://sgt.znzmo.com/sgt/gygh.html' },
  { term: '景观规划', level1: '建筑设计', level2: '规划设计', source: 'https://sgt.znzmo.com/sgt/jggh.html' },
  { term: '乡村规划', level1: '建筑设计', level2: '规划设计', source: 'https://sgt.znzmo.com/sgt/xcgh.html' },
  // ── 平立面系统图 > 平面图 ────────────────────────────────
  { term: '家装平面图', level1: '平立面系统图', level2: '平面图', source: 'https://sgt.znzmo.com/sgt/jiazhuangpmt.html' },
  { term: '工装平面图', level1: '平立面系统图', level2: '平面图', source: 'https://sgt.znzmo.com/sgt/gongzhuangpmt.html' },
  { term: '景观平面图', level1: '平立面系统图', level2: '平面图', source: 'https://sgt.znzmo.com/sgt/jgpmt.html' },
  { term: '建筑平面图', level1: '平立面系统图', level2: '平面图', source: 'https://sgt.znzmo.com/sgt/jzpmt.html' },
  { term: '规划平面图', level1: '平立面系统图', level2: '平面图', source: 'https://sgt.znzmo.com/sgt/guihuapingmiantu.html' },
  // ── 机电工程 > 电气工程节点 ───────────────────────────────
  { term: '电气节点', level1: '机电工程', level2: '电气工程节点', source: 'https://sgt.znzmo.com/sgt/dianqijd.html' },
  { term: '暖通节点', level1: '机电工程', level2: '电气工程节点', source: 'https://sgt.znzmo.com/sgt/nuantjd.html' },
  { term: '水处理节点', level1: '机电工程', level2: '电气工程节点', source: 'https://sgt.znzmo.com/sgt/huichulijd.html' },
  // ── 机电工程 > 给排水 ──────────────────────────────────
  { term: '建筑给排水', level1: '机电工程', level2: '给排水', source: 'https://sgt.znzmo.com/sgt/jianzhugps.html' },
  { term: '景观给排水', level1: '机电工程', level2: '给排水', source: 'https://sgt.znzmo.com/sgt/jggps.html' },
  { term: '市政给排水', level1: '机电工程', level2: '给排水', source: 'https://sgt.znzmo.com/sgt/shizhenggps.html' },
  { term: '其他给排水', level1: '机电工程', level2: '给排水', source: 'https://sgt.znzmo.com/sgt/qtgps.html' },
]

/**
 * 风格词表：**按大类分册**（06 v1.0.2 主理人裁定）。
 * 两册各 20 项、19 项共有，仅差一项 —— SU 有「简洁」、贴图有「简欧」（07 §5.10）。
 * 「全部」视图下的筛选器用派生并集 `styleListAll()`，**派生结果不落库、不进 schema**。
 *
 * 【v0.8.5 / docs/34 §四】CAD 频道**不新抄一份**：它的 20 项与贴图册
 * `STYLE_LIST_BY_KIND.texture` **逐项、同序完全相等（20/20）**，
 * 故 `cad` 直接**引用同一个冻结数组**（`texture: TEXTURE_STYLES, cad: TEXTURE_STYLES`）。
 * ⚠️ 为什么不在对象字面量里写 `cad: STYLE_LIST_BY_KIND.texture`：初始化期间自引用拿不到值
 * （TDZ / undefined），必须先提具名常量。
 * ⚠️ 为什么**不**写成「SU 表 + 替换第 19 项」：多一个"替换下标"的出错点，
 * 且会把"两册相等"从数据事实变成运行时派生，测试也就无法用 `toBe` 钉住同一引用。
 * ⚠️ SSR 里还有第 21 项「其他」，**界面永不渲染** → **不写进代码**，按 20 项。
 */
const TEXTURE_STYLES: readonly string[] = [
  // docs/07 §4 的 20 项（含「简欧」）
  '现代', '新中式', '中式', '法式', '美式', '欧式', '日式', '意式', '轻奢', '复古',
  '极简', '中古', '奶油', '简约', '侘寂', '原木', '北欧', '禅意', '简欧', '工业'
]

export const STYLE_LIST_BY_KIND: Readonly<
  Record<'model' | 'texture' | 'cad', readonly string[]>
> = {
  // docs/05 §3 的 20 项（含「简洁」）
  model: [
    '现代', '新中式', '中式', '法式', '美式', '欧式', '日式', '意式', '轻奢', '复古',
    '极简', '中古', '奶油', '简约', '侘寂', '原木', '北欧', '禅意', '简洁', '工业'
  ],
  // docs/07 §4 的 20 项（含「简欧」）
  texture: TEXTURE_STYLES,
  // 【v0.8.5 / docs/34 §四】CAD 册 = 贴图册（**同一数组引用**，20 项，不含 SSR-only 的「其他」）
  cad: TEXTURE_STYLES
}

export type StyleKind = keyof typeof STYLE_LIST_BY_KIND

/** 某大类的风格词表；未知大类返回空数组（不猜测归属） */
export function styleListOf(kind: string): readonly string[] {
  const list = (STYLE_LIST_BY_KIND as Readonly<Record<string, readonly string[]>>)[kind]
  return list ?? []
}

/** 两册并集（21 项），仅用于 kind=all 的筛选视图；派生结果不落库 */
export function styleListAll(): readonly string[] {
  const seen = new Set<string>()
  for (const list of Object.values(STYLE_LIST_BY_KIND)) {
    for (const s of list) seen.add(s)
  }
  return [...seen]
}

/**
 * 词表排除清单：从枚举中剔除、转做自由标签的词条。**排除必须在此登记（可审计），禁止在抄录时静默省略。**
 * - 品牌（SU 家具组）：Minotti、Poliform → 品牌（06 §8）
 * - 花色商品名（贴图大理石组，07 §3.3）：冷翡翠、宝格丽大理石、潘多拉大理石、爵士白大理石
 *   —— 与品牌同性质，是"商品变体/流行词"不是稳定分类层级，且会持续膨胀 → 剔除，进自由标签
 */
export const EXCLUDED_TERMS: Readonly<Record<string, readonly string[]>> = {
  家具: ['Minotti', 'Poliform'],
  大理石: ['冷翡翠', '宝格丽大理石', '潘多拉大理石', '爵士白大理石']
}

/** 品牌词表（自由标签的自动补全源，06 §8） */
export const BRAND_LIST: readonly string[] = ['Minotti', 'Poliform']

/**
 * 贴图频道「属 性」排（随一级联动的搜索热词，07 §5.8）与「颜 色」排（11 个无文字色块，07 §5.9）
 * ——【裁定 v1.0.2】两排**均不进落盘枚举**：属性是热词聚合不是稳定分类树（且未全录），颜色无名称无法成目录。
 * 未来出口：属性 → 自由标签的"热门建议源"；颜色 → 复用风格那套受控标签机制，都不新增 schema 字段。
 */
export const OBSERVED_NOT_ENUMERATED: readonly string[] = ['属性(热词)', '颜色(11色块)']

/** 词表可信度：'fact'（截图确认）| 'inferred'（推断，UI 显示「待核对」灰标） */
export const CONFIDENCE: Readonly<Record<string, 'fact' | 'inferred'>> = {
  家装: 'fact',
  工装: 'fact',
  景观: 'fact',
  建筑: 'fact',
  家具: 'fact',
  灯具: 'fact',
  软装陈设: 'inferred',
  植物: 'inferred',
  // 【v1.0.10 / docs/17】该组的**二级已实地核对**（站方全表见 docs/17 §4），
  // 但组内仍有本地补充项（墙面装饰/地面铺装/柱式/踢脚线/壁炉 站方无此二级），
  // 组级整体仍标 'inferred'（不升 fact），避免给出"整组已确认"的错误信号。
  硬装构件: 'inferred',
  厨卫五金: 'inferred',
  '电器/器材': 'inferred',
  家装户型: 'inferred',
  SU材质: 'inferred',
  美陈装置: 'inferred',
  标识广告: 'inferred',
  '人物/动物': 'inferred',
  交通工具: 'inferred',
  '展厅/展台': 'inferred',
  舞台: 'inferred'
}

// ── 查询 API（全部纯函数） ─────────────────────────────────────────

/** 某一级分类下的二级分类；未知一级 → []（无键与空键行为一致） */
export function level2Of(level1: string): readonly string[] {
  return LEVEL2_MAP[level1] ?? []
}

/**
 * 是否已知的一级分类（**以 LEVEL2_MAP 有无登记为准**，即"已建键"）。
 *
 * ⚠️ 与 `CHANNEL_LEVEL1` 的分工：后者是 **UI 一级下拉的数据源**，含已抄录但未建键的频道
 * （如 `material` 的 21 项）。所以 `CHANNEL_LEVEL1.material` 里的值**不**被本函数视为已知 ——
 * 它们没有级联登记，`level2Of()` 返回 `[]`，UI 走「可自由输入」，这正是 v1.0.3 的裁定结果。
 */
export function isKnownLevel1(v: string): boolean {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEVEL2_MAP, v)
}

/** 组合是否在词表内。注意：**false 只代表"跨类组合"，不代表非法**（06 §9.2 规则 4：照常放行落盘） */
export function isKnownCombo(level1: string, level2: string): boolean {
  return level2Of(level1).includes(level2)
}

/**
 * 【v1.0.10】**kind ↔ 一级频道 一致性闸门**（纯函数，零 IO）。
 *
 * 背景：落盘布局是 `<大类>/<一级>/<二级>/<资产名>`，父链里**同时**含大类与一级，
 * 于是"一级属于另一个频道"就会造出错位目录 —— 例如贴图资产名命中 `硬装构件`
 * （那是**模型频道**的一级）→ `材质/硬装构件/…`，一个大类下出现别的频道的一级。
 *
 * 用法（`main/importer.ts` 的预分类之后）：
 * **不属于当前容器的一级 → 丢弃该命中**，再由调用方尝试**一级回退**（v1.0.12），
 * 仍不行才落 `未分类/未分类`。
 * 取舍原则：**宁可不分，不可分错**（未分类是待办，错分类是脏数据）。
 *
 * ⚠️【v1.0.12 修正】`texture` 与 `material` 落盘大类**都是「材质」**（docs/14 §2.1），
 * 两者共用**同一棵**分类树 —— UI 下拉（`level1OptionsFor`）也统一按并集
 * `MERGED_MATERIAL_LEVEL1`（33 项）给选项。因此**闸门必须按"容器口径"校验，
 * 不能按单个频道册校验**：只查 `CHANNEL_LEVEL1.material`（21 项）会把
 * `木纹/砖材/瓷砖/挂画…`（贴图册独有、但确实存在于「材质」树里）全部拒掉，
 * 造成"UI 能选、自动分类却永远选不中"（2026-10-20 用户实测：材质资产全落未分类）。
 *
 * 本次修改**不削弱** v1.0.10 的原始目的：`硬装构件` / `软装陈设` / `家具` 等
 * **模型频道**的一级不在 33 项并集里，依旧被挡（`屏风贴图` 仍落双未分类）。
 * `CHANNEL_LEVEL1` 三册原样保留（追溯抄录来源用），不再是本函数的判据。
 *
 * ⚠️ `hdri` / `other` 没有一级词表 → 一律 `false`（命中即丢弃），这是刻意的。
 *
 * @param kind 资产大类（`AssetKind`）
 * @param level1 候选一级分类名
 * @returns 该一级是否属于该 kind 所属**容器**的一级词表
 */
export function isLevel1AllowedForKind(kind: string, level1: string): boolean {
  if (typeof level1 !== 'string' || level1 === '') return false
  // 【v1.0.12】**材质容器 = 并集词表**：texture 与 material 落同一棵「材质」树，
  // 闸门按容器口径（33 项）校验，不按单个频道册。
  if (kind === 'texture' || kind === 'material') {
    return MERGED_MATERIAL_LEVEL1.includes(level1)
  }
  const allowed = (CHANNEL_LEVEL1 as Readonly<Record<string, readonly string[]>>)[kind]
  if (allowed === undefined) return false
  return allowed.includes(level1)
}

/** 是否受控风格词（任一分册命中即算，供打标签时校验拼写） */
export function isStyle(v: string): boolean {
  return styleListAll().includes(v)
}

/** 是否哨兵目录名（未分类） */
export function isReservedName(v: string): boolean {
  return v === UNCLASSIFIED
}

/** 词表自检摘要（QA / 设置页诊断用） */
export function taxonomySummary(): {
  level1Count: number
  factGroups: number
  inferredGroups: number
  styleCount: number
} {
  let factGroups = 0
  let inferredGroups = 0
  for (const v of Object.values(CONFIDENCE)) {
    if (v === 'fact') factGroups++
    else inferredGroups++
  }
  return {
    level1Count: LEVEL1_LIST.length,
    factGroups,
    inferredGroups,
    styleCount: STYLE_LIST_BY_KIND.model.length
  }
}

/**
 * 找出跨组重名的二级分类。
 *
 * ⚠️ 06 v1.0.2 §15-④ 断言「SU 86 项 ∩ 贴图 195 项 = ∅，频道内部亦无重名」——**实测不成立**：
 * 实际存在多组重名（SU↔贴图的材质名如 石材/木材/金属…，以及 SU 频道内部的 单身公寓）。
 * 本函数只负责**算出事实**，是否允许重名由调用方/测试决定（见 tests/taxonomy.test.ts 的守卫用例）。
 */
export function findDuplicateLevel2Names(): Map<string, string[]> {
  const owner = new Map<string, string[]>()
  for (const [level1, list] of Object.entries(LEVEL2_MAP)) {
    for (const l2 of list) {
      const owners = owner.get(l2) ?? []
      if (!owners.includes(level1)) owners.push(level1)
      owner.set(l2, owners)
    }
  }
  const dup = new Map<string, string[]>()
  for (const [name, owners] of owner) {
    if (owners.length > 1) dup.set(name, owners)
  }
  return dup
}
