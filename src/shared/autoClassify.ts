/**
 * 文件名智能预分类（2026-10 装机反馈第 3 轮 · 用户拍板方案 A）。
 *
 * 背景：此前导入一律落 `未分类/未分类`、事后由用户指派，用户反馈
 * 「并没有主动分类一级二级」。本模块在**导入时**拿资产名 + 文件名
 * 对 `taxonomy.ts` 的受控词表做匹配，命中即预分类，未命中仍落未分类。
 *
 * **零 IO、零 electron / node 依赖**（与 taxonomy.ts 同纪律），可直接单测。
 *
 * ── 匹配强度（刻意保守，防误伤）─────────────────────────────────
 * 1. **中文词（含 CJK）**：命中 = 某个 CJK token 的**后缀或全等**（大小写不敏感）。
 *    依据：中文产品名中心语后置（「北欧椅子」「实木门」尾部是品类词），
 *    而「藤编屏风」头部的「藤编」只是材料修饰语——若用任意位置 `includes`，
 *    整包屏风模型会被误拉进 贴图频道 木材/藤编（样本 A 实证）。不做单字模糊。
 * 2. **纯 ASCII 词**（当前词表仅「LOFT」）：按 **token 全等**（大小写不敏感）。
 *    token = 按「非字母数字」切分（`_ - 空格 . /` 等都是分隔符）。
 *    子串匹配会误伤（`art` ⊂ `Apart`），整词相等才认。
 * 3. 含 `/` 的词条（如「椅子/凳子」「灯膜/灯罩」）：按 `/` 拆成子词，
 *    任一子词命中即算命中；落盘值仍是**完整词条**（目录名保持词表原貌）。
 * 4. **二级优先、原词优先、最长优先**：二级命中永远压过一级命中；同层内先比
 *    **命中强度**（词条原文命中 > 规则 A 词根派生命中——否则本身就是词条原文的
 *    「展架」会被词根「架」按等长键序截胡成 家具/架子），再取**最长词**
 *    （「卫生间瓷砖」不该被「卫生间」截胡成 家装/卫生间）；等长按 `LEVEL2_MAP` 键序。
 * 5. **文件名只参与二级匹配，不参与一级匹配**：包内几乎总有「木纹 01.jpg」
 *    这类材质文件，一级词太粗，会让模型包被误拉进贴图频道的一级；
 *    二级词足够具体才可信。一级（含"只命中一级"）只看资产名。
 * 6. **重名二级**：`LEVEL2_MAP` 有 8 组跨一级重名（如「装饰画」「门」），
 *    首选 = 键序第一个一级，其余候选放进 `alternativeCategories1`
 *    （后续 UI 可让用户改派）。
 * 7. **尾字族词根**（2026-10 命中率改进，规则 A）：词表里以虚词「子」结尾的
 *    二级词条共 5 个（桌子 / 椅子–凳子 / 柜子 / 架子 / 竹子），中文实际命名
 *    几乎不写「子」（写「玄关柜」「餐椅」「书架」「书桌」）。故对这批词条
 *    派生**词根**，CJK token **以词根结尾**即算命中该词条。
 *    【v1.0.9】白名单再加第 6 条 `床具 → 床`：词表家具组只有集合词「床具」，
 *    单件词（双人床 / 单人床 / 儿童床）靠尾锚定「床」才命中；详见常量处注释。
 *    ⚠️ 词根表是**显式常量白名单**（`TAIL_FAMILY_ROOTS`），**不从词表自动推导**：
 *    自动推导意味着将来词表加一个「xx子」就会悄悄改变匹配行为（不可审计）。
 *    ⚠️ 单字词根风险高，「竹」**刻意排除**（理由见常量处注释）。
 * 8. **尾部功能词剥离**（2026-10 命中率改进，规则 B）：品类词后面常再挂
 *    「3D模型 / 模型 / 组合 / 套装 / 贴图」或版本号（`书架01`、`吊灯3D模型`），
 *    严格尾锚定会整包漏分（诊断实测：二级词条 + `3D模型` 的命中率 **0/375**）。
 *    故对每个 CJK token 生成「剥掉尾部功能词 / 尾部数字字母」的**候选词头**，
 *    仍要求**词头尾锚定**命中——**不是任意位置 `includes`**，「藤编屏风」
 *    头部的材料修饰语依旧不会被匹配（防误伤红线，rule 1 的结论不变）。
 *    **8b.【2026-10-20 新增】「CJK + ID」尾巴**：知末的文件名普遍以 `ID_<数字>`
 *    收尾，而 `_` 是分词分隔符、`ID` 又紧贴前一段中文，于是 token 会变成
 *    `无堺黑色木纹ID` / `挂画组合ID`（**ID 粘在 CJK 词尾**）。原来的两条剥离
 *    （功能词 / 版本号）都匹配不了结尾的 `ID`，候选词头停在 `…木纹ID`，
 *    后缀匹配全军覆没（2026-10-20 用户实测：10 个材质资产全落未分类）。
 *    故增加第三条**有界**剥离：token 以 `ID`/`id` 结尾、**前一字符是 CJK**、
 *    剥完长度 ≥ 2 才剥；剥完继续参与同一循环（`挂画组合ID` → `挂画组合` → `挂画`）。
 *    ⚠️ 「前一字符必须是 CJK」是防误伤红线：`grid`/`rapid`/`invalid` 等英文词
 *    以 `id` 结尾，剥成 `gr`/`rap`/`inval` 会把 LOFT 之类的整词匹配搞坏（有单测）。
 * 9. **三级节点归并**（2026-10-20，`LEVEL3_ALIAS` / docs/17）：知末分类树是三级，
 *    我们的落盘结构是四级，三级节点（屏风 / 隔断 / 花瓶花艺 / 边几角几 / 卡座沙发…）
 *    被归并到它的**上级二级**。命中规则与二级词条**完全一致**（rule 1~B 原样复用），
 *    命中后 `category2` 取归并表指定的二级、`matchedTerm` 取**实际命中的三级词**，
 *    并附加 `matchedLevel:'l3-alias'`。与二级词条同属"二级强度"：
 *    **最长优先；等长时二级原文优先**（候选数组把二级放前面，`pickBest` 只在严格更长时替换）。
 *    【v0.8.5】归并表**按频道分册**：默认扫 `LEVEL3_ALIAS`（SU，9 条），
 *    `level2Scope:'cad'` 时只扫 `CAD_LEVEL3_ALIAS`（CAD，364 条）。两者互不可见。
 * 10. **一级回退开关**（v1.0.12，`AutoClassifyOptions.level1Only`）：可选参数，
 *    为 `true` 时**跳过轮 1**（二级 + 三级归并），只做一级尾锚定。供 `importer` 在
 *    "二级命中的一级被 kind 闸门拒绝"时再问一次 —— **宁可不分二级，也要保住正确的一级**。
 *    默认 `undefined` = 老行为，既有调用方零改动。
 *
 * 词表纪律：**本模块不新增、不改写任何词条**——词表唯一权威是
 * `docs/06-分类体系设计.md` + `src/shared/taxonomy.ts`（逐项照抄，禁止凭记忆敲）。
 */

import {
  CAD_LEVEL2_CANONICAL_PARENT,
  CAD_LEVEL2_MAP,
  CAD_LEVEL3_ALIAS,
  LEVEL2_MAP,
  LEVEL3_ALIAS,
  MATERIAL_LEVEL2_MAP,
  UNCLASSIFIED
} from './taxonomy'

/**
 * 命中来源层级（v1.0.10 / v1.0.14 / v0.8.5）：
 * - `'l2'`：直接命中 `LEVEL2_MAP` 的二级词条（词表原文）；
 * - `'l3-alias'`：命中 `LEVEL3_ALIAS` 的三级归并表（落盘仍用归并表指定的二级）；
 * - `'material-l2'`：命中 `MATERIAL_LEVEL2_MAP`（**材质频道专属**二级表，v1.0.14）。
 *   只有显式传 `level2Scope:'material'` 时才会出现 —— 不传则该值永不存在。
 * - `'cad-l2'` / `'cad-l3'`：命中 `CAD_LEVEL2_MAP` / `CAD_LEVEL3_ALIAS`
 *   （**CAD 频道专属**二级表与三级归并表，v0.8.5）。同样只在
 *   `level2Scope:'cad'` 时出现。
 *
 * ⚠️ 与 `matchedLevel` 无关的调用方（如 importer）无需感知本字段。
 */
export type AutoClassifyLevel = 'l2' | 'l3-alias' | 'material-l2' | 'cad-l2' | 'cad-l3'

export interface AutoClassifyHit {
  category1: string
  category2: string
  /** 命中的词表词条（原文，含 `/` 的取完整词条）；三级归并命中时是**实际命中的三级词** */
  matchedTerm: string
  /**
   * 同名二级的**其余**候选一级（按 `LEVEL2_MAP` 键序，不含首选）。
   * 非重名词条为空数组。
   */
  alternativeCategories1: string[]
  /**
   * 【v1.0.10 **可选**字段】命中来源：`'l3-alias'` = 经三级归并表命中。
   * 二级原文命中时**不写本字段**（保持既有对象形状，零影响存量断言/调用方）。
   */
  matchedLevel?: AutoClassifyLevel
}

/** 是否含 CJK 字符（词表里的中文词走 token 后缀匹配；纯 ASCII 词走 token 全等） */
const CJK_RE = /[\u4e00-\u9fff]/

/** CJK token 切分：中文与字母数字连成词，标点/分隔符切开（`藤编屏风` 是一个 token） */
const CJK_TOKEN_SPLIT_RE = /[^A-Za-z0-9\u4e00-\u9fff]+/
/** ASCII token 切分：CJK 字符也是分隔符（`复式LOFT公寓` 里能拆出 `loft`） */
const ASCII_TOKEN_SPLIT_RE = /[^a-z0-9]+/

/**
 * 【规则 A】尾字族词根**显式白名单**（key = 词表完整词条，value = 允许的词根）。
 *
 * 收「由集合词派生单件构词」的二级词条，逐个人工判定。
 * 前 5 条 = 「词表里以『子』结尾」的词条（v1.0.7 及以前）：
 * - `桌子`   → 「桌」：「餐桌/书桌/电脑桌/圆桌」全是桌子，无同名竞争词条，安全。
 * - `椅子/凳子` → 「椅」「凳」：「餐椅/躺椅/办公椅/转椅」「圆凳/板凳」。
 *   风险仅「轮椅」一类边缘词，仍属坐具，可接受。
 * - `柜子`   → 「柜」：「玄关柜/电视柜/书柜/衣柜/床头柜」。
 *   反例「柜门」以「门」结尾，**不会**命中（后缀锚定天然挡住）。
 * - `架子`   → 「架」：「书架/博古架/置物架/花架」。
 *   与「晾衣架/灯光架/展架」等**更长的词表词条**同场竞争时，rule 4「最长优先」
 *   会让具体词条胜出（`晾衣架` 长度 3 > `架子` 长度 2）。
 * - `竹子`   → **刻意留空（排除「竹」）**。理由：
 *   ① 「毛竹」「紫竹」「竹篱笆」是**植物**（`植物/竹类`），不是 `木材/竹子`；
 *   ② 「竹编」在词表里是 `木材` 下**另一个**二级词条，被「竹」截胡会造成同组错配；
 *   ③ 单字「竹」在中文构词里作材料/属名前缀（竹木、竹节、竹叶、竹纹）远多于作
 *      品类中心语，尾锚定也挡不住（「毛竹」就是以「竹」结尾）。
 *   留空而非删 key：把「评估过并否决」这个结论钉在代码里，防止后人"顺手加回来"。
 *
 * 【v1.0.9 新增第 6 条】`床具` → 「床」：词表家具组只有**集合词**「床具」
 * （docs/05:114 原文 `沙发、床具、茶几…`，站方无单件词「床 / 双人床 / 单人床」），
 * 故「双人床 / 单人床 / 儿童床 / 榻榻米床」在严格尾锚定下整包漏分。
 * 判定「床」可入白名单（与被排除的「竹」性质相反）：
 * ① 「床」在中文构词里作**中心语后缀**（X+床 = 某种床），不作材料/属名前缀；
 * ② 词表内无第二个以「床」结尾的竞争词条（「床品」是前缀构词，不被尾锚定命中）；
 * ③ 「床头柜」以「柜」结尾 → 由 `柜子` 先吃掉，本词根不冲突（单测钉住）。
 * ⚠️ 只加「床」一个单字，**不要**顺手加「垫」「头」——「床垫」词表无此项，
 *    「床头」是部件词不是品类中心语，语义与「床」不同。
 */
const TAIL_FAMILY_ROOTS: Readonly<Record<string, readonly string[]>> = {
  桌子: ['桌'],
  '椅子/凳子': ['椅', '凳'],
  柜子: ['柜'],
  架子: ['架'],
  竹子: [],
  床具: ['床']
}

/**
 * 【规则 B】尾部功能词（**有界白名单**，不是通用停用词表）。
 *
 * 只收「明确不是品类中心语、只表示交付形态/组织方式」的词：
 * - `3d模型` / `模型`：交付形态（`吊灯3D模型`）
 * - `组合` / `套装`：组织方式（`沙发组合`「家具组合」本身是词条，最长优先不受影响）
 * - `贴图`：交付形态（`胡桃木地板贴图`）
 *
 * ⚠️ 刻意**不收**「材质」「素材」「源文件」等：「材质」既是交付形态也可能出现在
 * 真实品类名里（`金属材质`），收进来收益不抵误伤风险。
 * ⚠️ 顺序有意义：长词在前，先剥 `3d模型` 再剥 `模型`，避免留下 `3d` 残尾
 * （虽然下面的数字字母剥离也能兜住，但显式更可读）。
 */
const FUNCTIONAL_TAIL_WORDS: readonly string[] = ['3d模型', '模型', '组合', '套装', '贴图']

/**
 * 尾部版本号/分辨率尾巴（`书架01`、`吊灯3d`、`餐桌2k`、`LOFT3D`）。
 *
 * ⚠️ 必须是**有界枚举**而非 `[a-z0-9]+$`：后者在 `loft3d` 上会从首字符一路吃满
 * （整串都是 `[a-z0-9]`），把词本身剥没了（实测 bug，已在单测钉住）。
 * 剥完要求**至少剩 2 个字符**：`3d`、`01` 这种"整个 token 就是版本号"的不剥。
 */
const TRAILING_VERSION_RE = /(?:3d|2k|4k|8k|\d{1,3})$/

/**
 * 【规则 B-2】知末文件名尾巴 `ID` / `id`（2026-10-20）。
 *
 * 知末资产名普遍是 `<中文标题>ID_<站点 id>`（例：`挂画组合ID_1186414883`）。
 * 分词器把 `_` 当分隔符，`ID` 便**粘在它前面那段 CJK 词尾**上，形成
 * `挂画组合ID` 这种 token —— 严格尾锚定下 `挂画` / `挂画组合` 都匹配不到。
 *
 * 剥离条件（三条同时满足，缺一不剥）：
 * 1. token 以 `ID`/`id` 结尾（大小写不敏感：分词后是 `id`，但本函数对外的入参
 *    没有强制小写，用 `i` 兜住两种写法）；
 * 2. **`ID` 的前一个字符是 CJK** —— 这一条是防误伤红线：英文词 `grid` /
 *    `rapid` / `invalid` / `solid` 都以 `id` 结尾，若只按"结尾 id"剥，
 *    会变成 `gr` / `rap` / `inval` / `sol`，把 LOFT（`ASCII token 全等`）之类的
 *    匹配搞坏，也会让纯英文资产名莫名其妙地产生短候选；
 * 3. 剥完**至少剩 2 个字符**（`ID` 本身、`aID` 这类不剥，绝不产出空候选）。
 *
 * 剥完不终止：继续回到功能词/版本号剥离，故 `挂画组合ID` → `挂画组合` → `挂画`
 * 能连续命中（单测钉住）。
 */
const TRAILING_ID_RE = /id$/i

/**
 * 剥掉「CJK 紧接 ID」的尾巴；不满足剥离条件时**原样返回**。
 * @param token 候选词头（可能已被前面的规则剥过一刀）
 * @returns 剥掉 `ID` 后的词头，或原 token
 */
function stripCjkTrailingId(token: string): string {
  const m = TRAILING_ID_RE.exec(token)
  if (m === null) return token
  const trimmed = token.slice(0, -m[0].length)
  // 条件 3：至少剩 2 字符（`ID` 单独、`aID` 都不剥）
  if (trimmed.length < 2) return token
  // 条件 2：`ID` 前一字符必须是 CJK（`grid`/`rapid`/`invalid` 一个都不能剥）
  const lastChar = trimmed.charAt(trimmed.length - 1)
  if (!CJK_RE.test(lastChar)) return token
  return trimmed
}


/**
 * 生成一个 token 的**候选词头**（含原文，按"由长到短"顺序）。
 *
 * 仅做**尾部有界剥离**：原文 → 去功能词 → 去版本号 → 去 `ID` → 再循环。
 * 例：`北欧餐椅3d模型` → [`北欧餐椅3d模型`, `北欧餐椅`]；
 *     `玄关柜组合` → [`玄关柜组合`, `玄关柜`]；
 *     `loft3d` → [`loft3d`, `loft`]；
 *     `挂画组合id` → [`挂画组合id`, `挂画组合`, `挂画`]（规则 B-2 剥 ID 后继续剥「组合」）；
 *     `毛竹` → [`毛竹`]（无功能词/版本号/ID 可剥，原样保留）。
 *
 * ⚠️ 永远只动**尾部**，头部一个字符都不切——这是「藤编屏风」不被误判的根。
 */
function expandTokenHeads(token: string): string[] {
  const heads: string[] = [token]
  let current = token
  for (;;) {
    let next = current
    for (const word of FUNCTIONAL_TAIL_WORDS) {
      // `next.length > word.length`：不允许被剥成空串（`模型` 本身不剥离）
      if (next.length > word.length && next.endsWith(word)) {
        next = next.slice(0, -word.length)
        break
      }
    }
    if (next === current) {
      const m = TRAILING_VERSION_RE.exec(next)
      if (m !== null) {
        const trimmed = next.slice(0, -m[0].length)
        // 剥完至少剩 2 字符：`3d`/`01` 这种"整个 token 就是版本号"的不剥，
        // `loft3d` → `loft`、`书架01` → `书架`、`吊灯2k` → `吊灯` 这种才剥
        if (trimmed.length >= 2) next = trimmed
      }
    }
    // 【规则 B-2】`挂画组合id` → `挂画组合`（继续回到循环，下一轮剥「组合」→ `挂画`）
    if (next === current) next = stripCjkTrailingId(next)
    if (next === current || next.length === 0) break
    heads.push(next)
    current = next
  }
  return heads
}

/**
 * token 化（小写）。
 * 返回 cjkHeads（原 token + 规则 B 剥离后的候选词头，**后缀匹配用这个**）与
 * asciiTokens（纯字母数字，用于英文词的全等匹配）。
 */
function tokenize(text: string): { cjkHeads: string[]; asciiTokens: Set<string> } {
  const cjkHeads: string[] = []
  const asciiTokens = new Set<string>()
  for (const raw of text.toLowerCase().split(CJK_TOKEN_SPLIT_RE)) {
    if (!raw) continue
    for (const head of expandTokenHeads(raw)) {
      cjkHeads.push(head)
      // ASCII 词条也吃规则 B 的尾巴：`LOFT3D` → 词头 `loft3d` → `loft` → 命中 LOFT
      for (const a of head.split(ASCII_TOKEN_SPLIT_RE)) {
        if (a) asciiTokens.add(a)
      }
    }
  }
  return { cjkHeads, asciiTokens }
}

/**
 * 命中强度：
 * - `term`：词条**原文**尾锚定/全等命中（含 `/` 子词）；
 * - `root`：仅由**规则 A 词根**命中（如「展架」命中词根「架」→ 架子）。
 *
 * 强度用于 rule 4 的择优：**原文命中永远压过词根命中**，否则「展架」（本身就是
 * 标识广告的二级词条）会被「架子」按等长键序截胡成 家具/架子（实测回归）。
 */
type MatchKind = 'term' | 'root'

/**
 * 单个词条是否命中。
 * @param term 词表词条（可能含 `/`）
 * @param asciiTokens 检索文本的 ASCII token 集合（小写）
 * @param cjkHeads 检索文本的 CJK 候选词头（含原文 + 规则 B 剥离结果）
 * @returns 命中强度；不命中返回 `null`
 */
function matchTerm(
  term: string,
  asciiTokens: Set<string>,
  cjkHeads: string[]
): MatchKind | null {
  // 含 `/` 的词条拆子词，任一命中即算（落盘仍用完整词条）
  const parts = term.includes('/') ? term.split('/') : [term]
  for (const part of parts) {
    const p = part.toLowerCase()
    if (CJK_RE.test(part)) {
      // 中文词 = 某个 token 的**后缀或全等**（中心语后置是中文产品名的构词法：
      // 「北欧椅子」「实木门」尾部是品类词；而「藤编屏风」头部的「藤编」
      // 只是材料修饰语，不该把整个产品拉进 木材/藤编）。
      if (cjkHeads.some((t) => t.endsWith(p))) return 'term'
    } else if (asciiTokens.has(p)) {
      // 纯 ASCII 词按 token 全等（子串会误伤：art ⊂ Apart）
      return 'term'
    }
  }

  // 【规则 A】尾字族词根：词条在显式白名单里 → 词根尾锚定也算命中该词条。
  // 放在原文匹配之后：原文命中强度更高，不会被词根截胡。
  const roots = TAIL_FAMILY_ROOTS[term]
  if (roots !== undefined && roots.length > 0) {
    if (cjkHeads.some((h) => roots.some((r) => h.endsWith(r)))) return 'root'
  }

  return null
}

/**
 * 同层多命中择优，两级排序：
 * 1. 命中强度：`term`（词条原文）→ `root`（词根派生）；
 * 2. 同强度内最长词优先（更具体），等长按词表键序（先出现者胜）。
 */
function pickBest<T extends { term: string; kind: MatchKind }>(hits: T[]): T {
  let best = hits[0]!
  for (const h of hits) {
    if (h.kind !== best.kind) {
      if (h.kind === 'term') best = h
      continue
    }
    if (h.term.length > best.term.length) best = h
  }
  return best
}

/**
 * 【v1.0.12】**可选**调用参数（加可选、不改既有签名与返回值结构）。
 *
 * `level1Only: true` → **只做一级匹配**：跳过第一轮的"二级词条 + 三级归并"，
 * 直接落到第二轮的"一级尾锚定"。调用方是 `main/importer.ts` 的**一级回退**：
 * 当二级命中被 kind 闸门拒绝时，再问一次"至少一级对不对"，
 * 用 `{ category1, category2: 未分类 }` 兜住 —— **宁可不分二级，也要保住正确的一级**。
 *
 * ⚠️ 只影响"匹配哪几轮"，不影响任何匹配强度/剥离规则（规则 A / B / B-2 原样复用）。
 */
export interface AutoClassifyOptions {
  level1Only?: boolean
  /**
   * 【v1.0.14】**材质频道专属二级表优先**：`'material'` = 先扫 `MATERIAL_LEVEL2_MAP`
   * 的全部 106 项（20 个一级），命中即返回（`matchedLevel:'material-l2'`）；
   * 未命中才继续走既有通用流程（二级词条 → 三级归并 → 一级）。
   *
   * 为什么必须显式开关而不是默认启用：材质二级与贴图/模型二级是**三套不同的切分维度**
   * （docs/18 §4：9 个同名一级的二级清单零一致），混用会系统性错分。
   * 不传 = 老行为，一个字节都不变。
   *
   * 【v0.8.5 / docs/34】`'cad'` = 同样的隔离，但换的是**整套 CAD 词表**：
   * - 二级扫 `CAD_LEVEL2_MAP`（10 键 / 102 项），命中 `matchedLevel:'cad-l2'`；
   * - 三级归并扫 `CAD_LEVEL3_ALIAS`（364 条），命中 `matchedLevel:'cad-l3'`；
   * - **一级轮**改成扫 `CAD_LEVEL2_MAP` 的键（10 项），否则 `level1Only` 回退对
   *   CAD 永远为空（CAD 的一级不在 `LEVEL2_MAP` 里）；
   * - **两级都未命中 → 直接 `null`，不回落通用词表**（与 `'material'` 支刻意不同：
   *   材质专表只是"更具体的优先"，通用表仍是它的合法来源；CAD 是独立频道，
   *   没有任何 SU / 贴图词条属于它）。
   * 不做这三层隔离的后果是双向污染：SU 命 CAD（`餐厅` → `家装空间/餐厅`）、
   * CAD 命 SU（`沙发` → `家具/沙发`）。
   */
  level2Scope?: 'material' | 'cad'
}

/**
 * 文件名智能预分类（纯函数）。
 *
 * @param assetName 资产名（导入时的最终层文件夹名 / 压缩包名 / 图片文件名去扩展名）
 * @param fileNames 资产内文件名列表（可选；英文贴图名常只出现在文件名里，如 `LOFT`）
 * @param opts 可选开关（v1.0.12：`level1Only` 只做一级匹配；v1.0.14：`level2Scope:'material'`
 *             先跑材质频道专属二级表；v0.8.5：`level2Scope:'cad'` 整轮换成 CAD 词表
 *             ——二级 `CAD_LEVEL2_MAP` + 三级归并 `CAD_LEVEL3_ALIAS` + 一级键也换 CAD 的 10 项）
 * @returns 命中 → `{ category1, category2, matchedTerm, alternativeCategories1 }`；
 *          全不命中 → `null`（调用方落 `未分类/未分类`）
 */
export function autoClassify(
  assetName: string,
  fileNames?: string[],
  opts?: AutoClassifyOptions
): AutoClassifyHit | null {
  const parts = [assetName, ...(fileNames ?? [])].filter(
    (s) => typeof s === 'string' && s.trim()
  )
  if (parts.length === 0) return null

  // 【v1.0.12】`level1Only` 时整轮跳过（连分词都省掉）。
  const skipLevel2 = opts?.level1Only === true
  const { cjkHeads, asciiTokens } = skipLevel2
    ? { cjkHeads: [] as string[], asciiTokens: new Set<string>() }
    : tokenize(parts.join('\n'))

  // ── 第一轮：二级分类词表 + 三级归并表（命中即返回，二级压过一级） ──────
  if (!skipLevel2) {
    // 【v1.0.14】材质频道专属二级表**优先**（docs/18 · 20 键 / 106 项）。
    //
    // 为什么优先于通用二级：材质与贴图/模型是**三套不同的切分维度**，同一资产名
    // 在材质侧的正确答案常常是更具体的「光泽度/金属种类/拼法」（如 `哑光木纹`），
    // 而通用表里只有「木纹」这种一级粗粒度。命中即返回，未命中才落回通用流程。
    //
    // ⚠️ 只认显式 `level2Scope:'material'`：默认不启用，否则模型资产的「植物」
    // 会被材质二级（花草/树木/绿植）截胡 —— 跨频道污染。
    if (opts?.level2Scope === 'material') {
      const materialHits: Array<{ term: string; level1: string; kind: MatchKind }> = []
      for (const [level1, list] of Object.entries(MATERIAL_LEVEL2_MAP)) {
        for (const term of list) {
          const kind = matchTerm(term, asciiTokens, cjkHeads)
          if (kind !== null) materialHits.push({ term, level1, kind })
        }
      }
      if (materialHits.length > 0) {
        // 与二级词条同一套择优：原文命中 > 词根命中，同强度取最长（更具体）
        const best = pickBest(materialHits)
        return {
          category1: best.level1,
          category2: best.term,
          matchedTerm: best.term,
          alternativeCategories1: [],
          matchedLevel: 'material-l2'
        }
      }
    }

    // 【v0.8.5 / docs/34】CAD 频道专属词表（二级 102 项 + 三级归并 364 条）。
    //
    // 为什么要整套隔离（而不是只加二级）：CAD 的**二级 97 个名里有 28 个与 SU 重名**
    // （餐厅 / 卧室 / 客厅 / 办公空间 / 商业建筑 …）、**三级 364 条里有 24 条与 SU 重名**
    // （沙发 / 桌子 / 窗帘 / 地毯 / 挂画 / 摆件 / 人物 / 动物 / 壁炉 / 背景墙 / 桁架 / 大平层 …）。
    // 任何一层漏出作用域，都会让 SU 模型资产被分进 `CAD/…` 或反过来。
    //
    // 与 `material` 支的**唯一差异**：CAD 的三级归并也在这条支里跑（那里没有三级表）。
    // 两个候选池合成一个数组再 `pickBest`，所以「等长时二级原文优先于三级归并」的既有
    // 语义原样成立（`pickBest` 只在**严格更长**时替换，等长保留先出现者）。
    if (opts?.level2Scope === 'cad') {
      const cadHits: Array<{
        term: string
        level1s: string[]
        kind: MatchKind
        category2: string
        matchedLevel: AutoClassifyLevel
      }> = []
      for (const [level1, list] of Object.entries(CAD_LEVEL2_MAP)) {
        for (const term of list) {
          const kind = matchTerm(term, asciiTokens, cjkHeads)
          if (kind === null) continue
          // 5 组重名二级挂在两个一级下 → 合并成一条候选（`level1s` 两个值），
          // 由 `CAD_LEVEL2_CANONICAL_PARENT` 决定哪个是 category1、哪个进 alternative。
          const existing = cadHits.find((h) => h.term === term && h.matchedLevel === 'cad-l2')
          if (existing) {
            existing.level1s.push(level1)
          } else {
            cadHits.push({ term, level1s: [level1], kind, category2: term, matchedLevel: 'cad-l2' })
          }
        }
      }
      for (const alias of CAD_LEVEL3_ALIAS) {
        const kind = matchTerm(alias.term, asciiTokens, cjkHeads)
        if (kind === null) continue
        cadHits.push({
          term: alias.term,
          level1s: [alias.level1],
          kind,
          category2: alias.level2,
          matchedLevel: 'cad-l3'
        })
      }
      if (cadHits.length > 0) {
        const best = pickBest(cadHits)
        // ⚠️ 覆盖只对**二级命中**生效：三级归并表的 level1/level2 已是页面实际归属
        // （重名三级在生成表时就去重定向了，见 `CAD_LEVEL3_ALIAS` 注释）。
        const canonical =
          best.matchedLevel === 'cad-l2' ? CAD_LEVEL2_CANONICAL_PARENT[best.term] : undefined
        const category1 = canonical ?? best.level1s[0]!
        const rest = best.level1s.filter((l1) => l1 !== category1)
        return {
          category1,
          category2: best.category2,
          matchedTerm: best.term,
          alternativeCategories1: rest,
          matchedLevel: best.matchedLevel
        }
      }
      // 【v0.8.5】**CAD 表未命中 → 一律 null，不回落通用词表**（主理人 2026-10-29 裁定）。
      //
      // 此前照抄 `material` 支的"未命中继续走通用流程"，结果是 `autoClassify('LOFT',
      // {level2Scope:'cad'})` 会返回模型频道的 `家装户型/LOFT` —— 端到端虽然有
      // `isLevel1AllowedForKind` 闸门兜住（CAD 一级与 model/texture/material 一级零交集），
      // 但那是"**能泄漏的通道 + 靠下游拦着**"：拿到 SU 二级必然被拒、等于白算一遍，
      // 还让"cad 只认 cad 词表"这条不变量变成隐式依赖。
      //
      // ⚠️ 与 `material` 支的差异是**刻意的**：那边未命中回落通用词表是设计（材质专表
      // 只是"更具体的优先"，通用表仍是它的合法来源）；而 CAD 是一个**独立频道**，
      // 没有任何 SU/贴图词条属于它。
      // ⚠️ 一级档不受影响：`classifyAssetName` 的一级回退会另起一次
      // `{ level1Only: true, level2Scope: 'cad' }`（一级轮按 CAD 的 10 个键扫），
      // 所以 `'结构设计'` 仍能落 `{结构设计, 未分类}`，只是不经这次调用。
      return null
    }

    const level2Hits: Array<{
      term: string
      level1s: string[]
      kind: MatchKind
      /** 落盘用的二级（二级词条命中 = term；三级归并命中 = 归并表指定的上级二级） */
      category2: string
      /** 命中来源（v1.0.10） */
      matchedLevel: AutoClassifyLevel
    }> = []
    for (const [level1, list] of Object.entries(LEVEL2_MAP)) {
      for (const term of list) {
        const kind = matchTerm(term, asciiTokens, cjkHeads)
        if (kind === null) continue
        const existing = level2Hits.find((h) => h.term === term && h.matchedLevel === 'l2')
        if (existing) {
          existing.level1s.push(level1)
        } else {
          level2Hits.push({ term, level1s: [level1], kind, category2: term, matchedLevel: 'l2' })
        }
      }
    }

    // 三级节点归并（v1.0.10 / docs/17）：命中规则与二级词条**完全一致**
    // （走同一个 `matchTerm`，含 rule 1 后缀/全等、rule A 词根、rule B 尾部剥离）。
    // 落盘的 category2 用归并表指定的二级，matchedTerm 记**实际命中的词**。
    const aliasHits: typeof level2Hits = []
    for (const alias of LEVEL3_ALIAS) {
      const kind = matchTerm(alias.term, asciiTokens, cjkHeads)
      if (kind === null) continue
      aliasHits.push({
        term: alias.term,
        level1s: [alias.level1],
        kind,
        category2: alias.level2,
        matchedLevel: 'l3-alias'
      })
    }

    // ⚠️ `level2Hits` 必须排在 `aliasHits` **前面**：`pickBest` 只在"严格更长"时替换，
    // 等长时保留先出现者 → 天然实现"等长时二级原文优先于三级归并"。
    const candidates = [...level2Hits, ...aliasHits]
    if (candidates.length > 0) {
      const best = pickBest(candidates)
      const [category1, ...rest] = best.level1s
      const hit: AutoClassifyHit = {
        category1: category1!,
        category2: best.category2,
        matchedTerm: best.term,
        alternativeCategories1: rest
      }
      // 只在三级归并命中时**附加**该字段：二级命中保持对象形状不变（存量断言零影响）。
      if (best.matchedLevel === 'l3-alias') hit.matchedLevel = 'l3-alias'
      return hit
    }
  }

  // ── 第二轮：只命中一级（如「灯具」）→ 二级留哨兵待用户指派 ────
  // ⚠️ 一级命中只看**资产名**，不看文件名：包内几乎总有 `木纹 01.jpg`
  // `石材 xxx.jpg` 这类材质文件，让它们参与一级匹配会把整个资产
  // 误拉进贴图频道的一级（模型包落「模型/木纹/…」）。二级词足够具体，
  // 文件名仍参与二级匹配（见上）。
  const assetTokens = tokenize(parts[0]!)
  const level1Hits: Array<{ term: string; index: number; kind: MatchKind }> = []
  // 【v0.8.5 / docs/34】一级词表的**作用域**：CAD 频道扫 CAD 的 10 个键。
  // 不隔离的话 `{ level1Only: true }` 对 CAD 恒为空（CAD 一级不在 `LEVEL2_MAP` 里），
  // `classifyAssetName` 的「一级回退」就永远救不回一个 CAD 资产。
  // 不传 scope 时仍扫 `LEVEL2_MAP` —— 既有行为一个字节不变。
  const level1Keys =
    opts?.level2Scope === 'cad' ? Object.keys(CAD_LEVEL2_MAP) : Object.keys(LEVEL2_MAP)
  let index = 0
  for (const level1 of level1Keys) {
    const kind = matchTerm(level1, assetTokens.asciiTokens, assetTokens.cjkHeads)
    if (kind !== null) {
      level1Hits.push({ term: level1, index, kind })
    }
    index++
  }
  if (level1Hits.length > 0) {
    const best = pickBest(level1Hits)
    return {
      category1: best.term,
      category2: UNCLASSIFIED,
      matchedTerm: best.term,
      alternativeCategories1: []
    }
  }

  return null
}
