/**
 * 文件名智能预分类单测（2026-10 任务 1）。
 *
 * 覆盖主理人点名的样本 + 匹配强度决策（最长优先 / token 全等 / 重名首选规则）。
 * 注意：「中古侘寂屏风…」样本 —— **v1.0.10 起事实变了**：知末的分类树是三级，
 * 「屏风」是 `硬装构件 > 屏风隔断` 下的三级节点（docs/17 实地抄录），
 * 经 `LEVEL3_ALIAS` 归并后命中 `硬装构件/屏风隔断`（不再落 null）。
 */
import { describe, expect, it } from 'vitest'
import { autoClassify } from '../src/shared/autoClassify'
import { findDuplicateLevel2Names, isLevel1AllowedForKind, level2Of, UNCLASSIFIED } from '../src/shared/taxonomy'
import { MUST_KEEP, MUST_STRIP } from './fixtures/idSuffixSamples'

describe('autoClassify — 主理人点名样本', () => {
  it('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风 → 硬装构件/屏风隔断（v1.0.10：知末三级节点已确认）', () => {
    // ⚠️ v1.0.10 事实变更（docs/17）：知末的分类树是**三级**，
    // 站方节点 = `硬装构件 > 屏风隔断 > 屏风`（su.znzmo.com/sunewhome/dhpf.html）。
    // 「屏风」被归并到上级二级 `屏风隔断`（落盘结构仍是四级，不变），
    // 故本样本从"落 null"改为命中 —— 这条**不是放宽规则**：命中的是
    // **词尾中心语**「屏风」（四个 token 全部以「屏风」结尾），
    // 头部的「藤编」材料修饰语依旧不会被任意位置 includes 命中。
    expect(autoClassify('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')).toEqual({
      category1: '硬装构件',
      category2: '屏风隔断',
      matchedTerm: '屏风',
      alternativeCategories1: [],
      matchedLevel: 'l3-alias'
    })
  })

  it('Brick_Rough_vh1sbjl_2K_surface_ms → null（英文词表 token 全等，词表无此词）', () => {
    // 决策：词表源自知末中文电商词表，唯一纯 ASCII 词条是「LOFT」。
    // 英文资产名（AmbientCG/PolyHaven 的 Brick_Rough…）几乎不可能命中中文业务词，
    // 刻意不做音译/意译猜测，保守返回 null → 落 未分类/未分类 待用户指派。
    expect(autoClassify('Brick_Rough_vh1sbjl_2K_surface_ms')).toBeNull()
  })

  it('沙发 → 家具/沙发', () => {
    expect(autoClassify('沙发')).toEqual({
      category1: '家具',
      category2: '沙发',
      matchedTerm: '沙发',
      alternativeCategories1: []
    })
  })

  it('完全无关节西 → null', () => {
    expect(autoClassify('完全无关节西')).toBeNull()
  })
})

describe('autoClassify — 匹配强度（防误伤）', () => {
  it('最长词优先：「卫生间瓷砖」落 瓷砖/卫生间瓷砖，不被「卫生间」截胡成 家装/卫生间', () => {
    expect(autoClassify('卫生间瓷砖')).toEqual({
      category1: '瓷砖',
      category2: '卫生间瓷砖',
      matchedTerm: '卫生间瓷砖',
      alternativeCategories1: []
    })
  })

  it('纯 ASCII 词条按 token 全等：LOFT 命中、loft 大小写不敏感', () => {
    expect(autoClassify('复式LOFT公寓')?.category1).toBe('家装户型')
    expect(autoClassify('Modern Loft')?.matchedTerm).toBe('LOFT')
  })

  it('ASCII 词不做子串模糊：kolost / loftlike 都不命中 LOFT', () => {
    expect(autoClassify('kolost')).toBeNull()
    expect(autoClassify('loftlike')).toBeNull()
  })

  it('含 / 的词条拆子词匹配，落盘用完整词条：椅子 → 家具/椅子/凳子', () => {
    expect(autoClassify('北欧椅子')?.category2).toBe('椅子/凳子')
    expect(autoClassify('吧台凳子')?.category2).toBe('椅子/凳子')
  })

  it('文件名参与二级匹配：资产名无词但文件名含具体二级 → 命中', () => {
    expect(autoClassify('pack-2026', ['预览图.jpg', '人字拼木地板.jpg'])).toEqual({
      category1: '木地板',
      category2: '人字拼木地板',
      matchedTerm: '人字拼木地板',
      alternativeCategories1: []
    })
  })

  it('文件名不参与一级匹配：包内「木纹 01.jpg」不会把资产拉进 木纹（防误伤）', () => {
    // 模型包里几乎总有材质贴图文件，一级词太粗，只信资产名
    // 2026-10 命中率改进后「衣柜」能以尾字族词根「柜」命中 家具/柜子（正确行为），
    // 故断言跟着**用例本意**（包内材质文件不得把资产拉进一级 木纹）走，而不是
    // 继续钉住当时的副产品「什么都匹配不到」。
    const hit = autoClassify('现代衣柜', ['预览图.jpg', '贴图/木纹 01.jpg'])
    expect(hit?.category1).not.toBe('木纹')
    expect(hit?.category2).toBe('柜子')
  })

  it('空 / 空白输入 → null', () => {
    expect(autoClassify('')).toBeNull()
    expect(autoClassify('   ')).toBeNull()
    expect(autoClassify('', [])).toBeNull()
  })
})

describe('autoClassify — 重名二级首选规则', () => {
  it('重名二级按 LEVEL2_MAP 键序取第一个一级，其余进 alternatives', () => {
    // 「装饰画」重名：软装陈设（键序在前）与 挂画
    expect(autoClassify('新中式装饰画')).toEqual({
      category1: '软装陈设',
      category2: '装饰画',
      matchedTerm: '装饰画',
      alternativeCategories1: ['挂画']
    })
  })

  it('「门」重名：硬装构件 首选、素材贴图 备选', () => {
    const hit = autoClassify('实木门')
    expect(hit?.category1).toBe('硬装构件')
    expect(hit?.category2).toBe('门')
    expect(hit?.alternativeCategories1).toEqual(['素材贴图'])
  })

  it('重名组数与词表守卫一致（8 组，tests/taxonomy.test.ts 同源）', () => {
    expect(findDuplicateLevel2Names().size).toBe(8)
  })
})

describe('autoClassify — 只命中一级', () => {
  it('灯具 → 灯具/未分类（二级留哨兵待指派）', () => {
    expect(autoClassify('灯具')).toEqual({
      category1: '灯具',
      category2: UNCLASSIFIED,
      matchedTerm: '灯具',
      alternativeCategories1: []
    })
  })

  it('二级优先于一级：「吊灯组合」命中 吊灯 而不是只给一级', () => {
    expect(autoClassify('吊灯')?.category2).toBe('吊灯')
  })

  it('一级同样最长优先：「木地板」是一级，不被子串误判', () => {
    // 「木地板」本身是一级键；「拼花木地板」才是二级 → 纯「木地板」落一级
    expect(autoClassify('木地板')).toEqual({
      category1: '木地板',
      category2: UNCLASSIFIED,
      matchedTerm: '木地板',
      alternativeCategories1: []
    })
    // 但更具体的二级在词表里时应胜出
    expect(autoClassify('人字拼木地板')?.category2).toBe('人字拼木地板')
  })
})

/**
 * 规则 A：尾字族词根（2026-10 命中率改进）。
 *
 * 词表里以「子」结尾的二级只有 5 个（桌子 / 椅子–凳子 / 柜子 / 架子 / 竹子），
 * 中文实际命名几乎不写「子」——「玄关柜」「餐椅」「书架」全部漏分。
 * 词根表是**显式常量白名单**（`TAIL_FAMILY_ROOTS`），不从词表自动推导。
 */
describe('autoClassify — 尾字族词根（规则 A）', () => {
  it('「xx柜」→ 家具/柜子', () => {
    for (const name of ['玄关柜', '电视柜', '书柜', '衣柜', '床头柜']) {
      expect(autoClassify(name)).toEqual({
        category1: '家具',
        category2: '柜子',
        matchedTerm: '柜子',
        alternativeCategories1: []
      })
    }
  })

  it('「xx椅」→ 家具/椅子/凳子', () => {
    for (const name of ['餐椅', '躺椅', '办公椅', '转椅', '休闲椅']) {
      expect(autoClassify(name)?.category1).toBe('家具')
      expect(autoClassify(name)?.category2).toBe('椅子/凳子')
    }
  })

  it('「xx凳」→ 家具/椅子/凳子（词条按 `/` 拆出的子词也派生词根）', () => {
    for (const name of ['圆凳', '板凳', '方凳']) {
      expect(autoClassify(name)?.category2).toBe('椅子/凳子')
    }
  })

  it('「xx架」→ 家具/架子', () => {
    for (const name of ['书架', '博古架', '置物架', '花架']) {
      expect(autoClassify(name)).toEqual({
        category1: '家具',
        category2: '架子',
        matchedTerm: '架子',
        alternativeCategories1: []
      })
    }
  })

  it('「xx桌」→ 家具/桌子', () => {
    for (const name of ['餐桌', '书桌', '电脑桌', '圆桌', '学习桌']) {
      expect(autoClassify(name)?.category2).toBe('桌子')
    }
  })

  it('词根可与修饰语叠加：实木北欧餐椅 / 现代简约玄关柜 仍尾锚定命中', () => {
    expect(autoClassify('实木北欧餐椅')?.category2).toBe('椅子/凳子')
    expect(autoClassify('现代简约玄关柜')?.category2).toBe('柜子')
  })

  it('反例·部件词不误判：柜门 / 椅背 不以词根结尾 → 不落柜子/椅子', () => {
    // 「柜门」尾部是「门」——正好是硬装构件的词表词条，应落 门 而不是 柜子
    expect(autoClassify('柜门')?.category2).toBe('门')
    expect(autoClassify('柜门')?.category2).not.toBe('柜子')
    // 「椅背」既不以「椅」结尾也不以「椅」开头，纯部件词，不得命中椅子
    expect(autoClassify('椅背')).toBeNull()
  })

  it('反例·更长词表词条仍按「最长优先」胜出（词根不截胡）', () => {
    // 「晾衣架」是 厨卫五金 的二级（长度 3 > 架子 长度 2）
    expect(autoClassify('晾衣架')?.category1).toBe('厨卫五金')
    expect(autoClassify('晾衣架')?.category2).toBe('晾衣架')
    // 「灯光架」是 舞台 的二级
    expect(autoClassify('灯光架')?.category2).toBe('灯光架')
    // 「展架」是 标识广告 的二级
    expect(autoClassify('展架')?.category2).toBe('展架')
    // 「衣帽间」是 家装 的二级，不能被「衣」旁的柜子类词根牵连
    expect(autoClassify('衣帽间')?.category2).toBe('衣帽间')
  })

  it('反例·「竹」词根被刻意排除：毛竹/竹编 都不落 木材/竹子', () => {
    // 「竹」排除理由见 autoClassify.ts `TAIL_FAMILY_ROOTS` 注释：
    // 毛竹/紫竹是植物，竹编是木材下另一个二级词条，单字「竹」作材料属名前缀远多于中心语。
    // 本用例防止将来有人"顺手加回来"。
    expect(autoClassify('毛竹')).toBeNull()
    expect(autoClassify('紫竹')).toBeNull()
    expect(autoClassify('毛竹')?.category2).not.toBe('竹子')
    // 「竹编」本身是词表词条 → 命中 木材/竹编，绝不是 木材/竹子
    expect(autoClassify('竹编')?.category2).toBe('竹编')
    expect(autoClassify('竹编')?.category2).not.toBe('竹子')
  })

  it('反例·纯英文名不受词根规则影响', () => {
    expect(autoClassify('chair')).toBeNull()
    expect(autoClassify('cabinet')).toBeNull()
    expect(autoClassify('shelf')).toBeNull()
  })
})

/**
 * 规则 B：尾部功能词 / 版本号剥离（2026-10 命中率改进）。
 *
 * 诊断实测：二级词条 + `3D模型` 的命中率改前 **0/375**——严格尾锚定遇到
 * 知末高频的「xx3D模型 / xx组合 / xx贴图」就整包漏分。
 * 只做**尾部有界剥离后仍要求尾锚定**，不是任意位置 includes。
 */
describe('autoClassify — 尾部功能词剥离（规则 B）', () => {
  it('「词条+3D模型」→ 命中：吊灯3D模型 / 餐椅3D模型', () => {
    expect(autoClassify('现代吊灯3D模型')?.category2).toBe('吊灯')
    expect(autoClassify('北欧餐椅3D模型')?.category2).toBe('椅子/凳子')
    expect(autoClassify('实木门3D模型')?.category2).toBe('门')
  })

  it('「词条+组合/套装」→ 命中：玄关柜组合 / 装饰画套装', () => {
    expect(autoClassify('玄关柜组合')?.category2).toBe('柜子')
    expect(autoClassify('新中式装饰画套装')?.category2).toBe('装饰画')
    expect(autoClassify('懒人沙发组合')?.category2).toBe('沙发')
  })

  it('「词条+贴图」→ 命中：胡桃木地板贴图', () => {
    // 「胡桃木地板」本身是 木地板 下的二级词条，比「木地板」更具体
    expect(autoClassify('胡桃木地板贴图')?.category2).toBe('胡桃木地板')
  })

  it('尾部版本号/分辨率：书架01 / 吊灯2K / LOFT3D', () => {
    expect(autoClassify('书架01')?.category2).toBe('架子')
    expect(autoClassify('吊灯2K')?.category2).toBe('吊灯')
    expect(autoClassify('LOFT3D')?.matchedTerm).toBe('LOFT')
  })

  it('剥离不改变「最长优先」：家具组合 仍取二级「家具组合」而非一级「家具」', () => {
    expect(autoClassify('家具组合')?.category1).toBe('家具')
    expect(autoClassify('家具组合')?.category2).toBe('家具组合')
  })

  it('红线·仍不做任意位置 includes：命中的是词尾「屏风」，不是头部「藤编」', () => {
    // ⚠️ v1.0.10 事实变更：知末分类树是三级，`屏风` 是 `硬装构件 > 屏风隔断 > 屏风`
    // 的三级节点（docs/17），经 `LEVEL3_ALIAS` 归并后**应当**命中 —— 这是新增的
    // **正确事实**，不是红线失效。
    // 本用例守的红线**原样不变**：命中的必须是**词尾的中心语**，
    // 头部的材料修饰语（藤编）绝不能靠任意位置 includes 把资产拉进 木材/藤编。
    const hit = autoClassify('藤编屏风')
    expect(hit?.category2).toBe('屏风隔断')
    expect(hit?.category1).not.toBe('木材')
    expect(hit?.matchedTerm).toBe('屏风') // 命中的是「屏风」，不是「藤编」
    // 加 3D模型 后缀剥完还是「藤编屏风」，结论不变（红线路径未被规则 B 破坏）
    expect(autoClassify('藤编屏风3D模型')?.category2).toBe('屏风隔断')
    expect(autoClassify('藤编屏风3D模型')?.category1).not.toBe('木材')
    // 「屏风贴图」剥成「屏风」→ 归并命中 屏风隔断（词表**确实**有它，不再"不猜"）
    expect(autoClassify('屏风贴图')?.category2).toBe('屏风隔断')
  })

  it('已知可接受风险·「建筑模型」落一级 建筑（方向正确但较宽）', () => {
    // 规则 B 的代价：交付形态词剥离后，一级词条也可能命中。
    // 「建筑模型」剥成「建筑」→ 建筑/未分类，比 未分类/未分类 更接近人工结论，
    // 且二级留哨兵可改派。故判定为可接受；若将来要收紧，把「模型」从
    // FUNCTIONAL_TAIL_WORDS 移除即可，但会一并失去「吊灯模型」这类高价值命中。
    expect(autoClassify('建筑模型')).toEqual({
      category1: '建筑',
      category2: UNCLASSIFIED,
      matchedTerm: '建筑',
      alternativeCategories1: []
    })
  })

  it('文件名不参与一级匹配这条不变：包内「木纹 01.jpg」不影响一级', () => {
    // 资产名只命中二级时，一级来自二级归属；包内材质文件不参与一级判断
    const hit = autoClassify('北欧餐椅3D模型', ['预览图.jpg', '贴图/木纹 01.jpg'])
    expect(hit?.category1).toBe('家具')
    expect(hit?.category2).toBe('椅子/凳子')
    expect(hit?.category1).not.toBe('木纹')
  })
})

/**
 * 防放水反例（改 `:80` 那条断言时同步新增，见 2026-10 命中率改进）。
 *
 * 目的：证明放宽规则后匹配器**没有变成"什么都匹配"**——不含品类中心语的名字
 * 必须继续落空；规则 B 的剥离必须**尾部有界**（顺序敏感），不是任意位置删词。
 */
describe('autoClassify — 防放水反例', () => {
  it('不含任何品类尾词的资产名仍必须落空：现代风格效果图 → null', () => {
    expect(autoClassify('现代风格效果图', ['预览图.jpg'])).toBeNull()
  })

  it('规则 B 是尾部有序剥离，不是任意位置删词：模型贴图 / 贴图模型 都 → null', () => {
    // 「模型贴图合集」：尾部两边都不构成「品类词 + 功能词」，无可剥
    expect(autoClassify('模型贴图合集')).toBeNull()
    // 「贴图模型」：能剥掉尾部的「模型」，但剩下的「贴图」不是词表词条 → 仍 null
    expect(autoClassify('贴图模型')).toBeNull()
    // 「贴图打包」：打包不在功能词白名单 → 不剥
    expect(autoClassify('贴图打包')).toBeNull()
  })

  it('历史踩坑用例的防误伤契约不变：藤编屏风 落 屏风隔断 而不是 木材/藤编', () => {
    // ⚠️ v1.0.10 事实变更（docs/17）：`屏风` 是知末的三级节点，经归并表命中
    // `硬装构件/屏风隔断`。**红线本身不变**：绝不能被头部的「藤编」拉进 木材/藤编。
    const hit = autoClassify('藤编屏风')
    expect(hit?.category2).toBe('屏风隔断')
    expect(hit?.category1).not.toBe('木材')
    expect(hit?.matchedTerm).toBe('屏风')
    // 加后缀让规则 B 剥一刀，红线结论也不变
    expect(autoClassify('藤编屏风3D模型')?.category2).toBe('屏风隔断')
    expect(autoClassify('藤编屏风3D模型')?.category1).not.toBe('木材')
  })
})

/**
 * v1.0.9 词表修正的匹配侧验收（docs/06 §15 v1.0.9）。
 *
 * 两处改动都不新增词条：
 * ① 三条并列复合词条改斜杠写法（筒灯/射灯、金箔/银箔、酒店/民宿）——站方在
 *    同类词条（椅子/凳子、灯膜/灯罩）本就使用斜杠，属**格式对齐**，
 *    拆出的子词可命中、落盘值仍是完整词条；
 * ② `TAIL_FAMILY_ROOTS` 增 `床具 → 床`——词表家具组只有集合词「床具」，
 *    单件构词（双人床 / 单人床 / 儿童床 / 榻榻米床）靠**中心语后缀**「床」命中。
 *
 * 反例守的是纪律本身：三级节点**只能**进归并表，**不能**进二级词表
 * （v1.0.10 起「屏风」经 `LEVEL3_ALIAS` 命中，但仍不在 `LEVEL2_MAP` 里）。
 */
describe('autoClassify — v1.0.9 词表修正（斜杠对齐 + 床具词根）', () => {
  it('斜杠复合词条·灯具：现代射灯 / 筒灯 都落 灯具/筒灯/射灯（落盘值是完整词条）', () => {
    expect(autoClassify('现代射灯')).toEqual({
      category1: '灯具',
      category2: '筒灯/射灯',
      matchedTerm: '筒灯/射灯',
      alternativeCategories1: []
    })
    expect(autoClassify('筒灯')).toEqual({
      category1: '灯具',
      category2: '筒灯/射灯',
      matchedTerm: '筒灯/射灯',
      alternativeCategories1: []
    })
    // 旧写法（连写）仍需命中：斜杠只是把两个子词拆出来，不改变原词条语义
    expect(autoClassify('筒灯射灯')?.matchedTerm).toBe('筒灯/射灯')
  })

  it('斜杠复合词条·金属：金箔 → 金属/金箔/银箔', () => {
    expect(autoClassify('金箔')).toEqual({
      category1: '金属',
      category2: '金箔/银箔',
      matchedTerm: '金箔/银箔',
      alternativeCategories1: []
    })
    expect(autoClassify('银箔')?.category2).toBe('金箔/银箔')
    // 旧写法（连写）仍命中，且不会被拆成两个短词截胡
    expect(autoClassify('金箔银箔')?.matchedTerm).toBe('金箔/银箔')
  })

  it('斜杠复合词条·工装：酒店 → 工装/酒店/民宿', () => {
    expect(autoClassify('酒店')).toEqual({
      category1: '工装',
      category2: '酒店/民宿',
      matchedTerm: '酒店/民宿',
      alternativeCategories1: []
    })
    expect(autoClassify('民宿')?.category2).toBe('酒店/民宿')
    expect(autoClassify('酒店民宿')?.matchedTerm).toBe('酒店/民宿')
  })

  it('床具词根：双人床 / 单人床 / 儿童床 / 榻榻米床 都落 家具/床具', () => {
    for (const name of ['双人床', '单人床', '儿童床', '榻榻米床']) {
      expect(autoClassify(name)).toEqual({
        category1: '家具',
        category2: '床具',
        matchedTerm: '床具',
        alternativeCategories1: []
      })
    }
    // 修饰语叠加同样成立（中心语后置）
    expect(autoClassify('现代简约双人床')?.category2).toBe('床具')
  })

  it('床具词根·不误伤：「床头柜」以「柜」结尾 → 家具/柜子（不是床具）', () => {
    expect(autoClassify('床头柜')).toEqual({
      category1: '家具',
      category2: '柜子',
      matchedTerm: '柜子',
      alternativeCategories1: []
    })
    expect(autoClassify('床头柜')?.category2).not.toBe('床具')
  })

  it('床具词根·不越界：「床垫」「床头」词表无此项 → 仍 null（未顺手加「垫」「头」）', () => {
    // 「床垫」「床头」都不以「床」结尾（尾锚定天然挡住），且词表无对应词条
    expect(autoClassify('床垫')).toBeNull()
    expect(autoClassify('床头')).toBeNull()
    // 「床品」本身是词表词条（软装陈设），前缀构词不受「床」词根影响
    expect(autoClassify('床品')?.category2).toBe('床品')
    expect(autoClassify('床品')?.category1).toBe('软装陈设')
  })

  it('v1.0.10 事实变更：「屏风」经归并表命中，但**仍未进 LEVEL2_MAP**', () => {
    // docs/17：屏风 = 硬装构件 > 屏风隔断 > 屏风（三级节点）。
    // 词表纪律的准确表述是：**三级节点只进 `LEVEL3_ALIAS`，不进二级词表**。
    expect(autoClassify('屏风')?.category2).toBe('屏风隔断')
    expect(autoClassify('屏风')?.matchedLevel).toBe('l3-alias')
    expect(autoClassify('中式屏风')?.category2).toBe('屏风隔断')
    // ← 这条比"整体 null"守得更准：落盘枚举里**没有**「屏风」这个二级
    expect(level2Of('硬装构件')).not.toContain('屏风')
  })
})

/**
 * v1.0.10 三级节点归并（docs/17 · `LEVEL3_ALIAS`）的匹配侧验收。
 *
 * 事实来源：2026-10-20 用真实浏览器从 `su.znzmo.com` 分类筛选树实地抄录——
 * **知末的分类树是三级，我们此前只抄到二级**。三级节点被归并到它的上级二级
 * （落盘结构不变，只是让它能被识别）：
 * - 硬装构件 > 屏风隔断 > **屏风** / **隔断**
 * - 软装陈设 > 摆件 > **花瓶花艺** / **绿植摆件**；植物 > **盆栽**（绿植 双归属）
 * - 家具 > 茶几 > **边几角几**；家具 > 沙发 > **卡座沙发**
 *
 * 命中规则与二级词条**完全一致**（后缀/全等、最长优先）；`matchedTerm` 记实际命中的词，
 * `category2` 用归并表指定的二级；等长时二级原文优先于三级归并。
 */
describe('autoClassify — v1.0.10 三级节点归并（LEVEL3_ALIAS）', () => {
  it('屏风族 → 硬装构件/屏风隔断（落盘二级是上级二级，不是三级名）', () => {
    const names = ['中古侘寂屏风', '木屏风', '藤编屏风', '可折叠屏风', '新中式屏风']
    for (const name of names) {
      expect(autoClassify(name), name).toEqual({
        category1: '硬装构件',
        category2: '屏风隔断',
        matchedTerm: '屏风',
        alternativeCategories1: [],
        matchedLevel: 'l3-alias'
      })
    }
  })

  it('隔断族 → 硬装构件/屏风隔断（玄关隔断 / 玻璃隔断）', () => {
    for (const name of ['玄关隔断', '玻璃隔断', '长虹玻璃隔断']) {
      expect(autoClassify(name), name).toEqual({
        category1: '硬装构件',
        category2: '屏风隔断',
        matchedTerm: '隔断',
        alternativeCategories1: [],
        matchedLevel: 'l3-alias'
      })
    }
  })

  it('花瓶 → 软装陈设/摆件（「花瓶」由站方三级节点「花瓶花艺」派生）', () => {
    for (const name of ['陶瓷花瓶', '玻璃花瓶', '现代简约花瓶']) {
      expect(autoClassify(name), name).toEqual({
        category1: '软装陈设',
        category2: '摆件',
        matchedTerm: '花瓶',
        alternativeCategories1: [],
        matchedLevel: 'l3-alias'
      })
    }
    // 站方节点原文（4 字）比派生的中心语更长 → 最长优先取节点原文
    expect(autoClassify('陶瓷花瓶花艺')?.matchedTerm).toBe('花瓶花艺')
    expect(autoClassify('陶瓷花瓶花艺')?.category2).toBe('摆件')
  })

  it('边几 → 家具/茶几（边几角几 是站方三级节点，边几 是派生中心语）', () => {
    for (const name of ['边几', '异形边几', '北欧边几']) {
      expect(autoClassify(name), name).toEqual({
        category1: '家具',
        category2: '茶几',
        matchedTerm: '边几',
        alternativeCategories1: [],
        matchedLevel: 'l3-alias'
      })
    }
    expect(autoClassify('边几角几')?.matchedTerm).toBe('边几角几')
  })

  it('卡座 → 家具/沙发（卡座沙发 是站方三级节点；更长者胜出）', () => {
    expect(autoClassify('餐厅卡座')).toEqual({
      category1: '家具',
      category2: '沙发',
      matchedTerm: '卡座',
      alternativeCategories1: [],
      matchedLevel: 'l3-alias'
    })
    // 「卡座沙发」(4) 与二级词条「沙发」(2) 同时命中 → 最长优先取「卡座沙发」，
    // 落盘二级仍是 沙发（归并表指定的值）
    expect(autoClassify('卡座沙发')).toEqual({
      category1: '家具',
      category2: '沙发',
      matchedTerm: '卡座沙发',
      alternativeCategories1: [],
      matchedLevel: 'l3-alias'
    })
  })

  it('绿植 → 植物/盆栽（站方双归属，取 植物/盆栽 为主）', () => {
    expect(autoClassify('室内盆栽绿植组合')).toEqual({
      category1: '植物',
      category2: '盆栽',
      matchedTerm: '绿植',
      alternativeCategories1: [],
      matchedLevel: 'l3-alias'
    })
    expect(autoClassify('仿真绿植')?.category2).toBe('盆栽')
    // 完整节点名派生形式明确指向 软装陈设/摆件
    expect(autoClassify('绿植摆件')?.category1).toBe('软装陈设')
    expect(autoClassify('绿植摆件')?.category2).toBe('摆件')
  })

  it('反例·「绿植墙」不被 盆栽 截胡（它是 墙面地面屋面 下的独立二级，更长者胜出）', () => {
    // 归并表只收到「三级节点 + 其中心语」这一层，不能把更长的独立二级吃掉
    const hit = autoClassify('绿植墙')
    expect(hit?.category2).toBe('绿植墙')
    expect(hit?.category1).toBe('墙面地面屋面')
    expect(hit?.category2).not.toBe('盆栽')
    // 词条原文命中 → 不写 matchedLevel（保持二级命中的对象形状）
    expect(hit?.matchedLevel).toBeUndefined()
    // 修饰语叠加同样成立
    expect(autoClassify('室内绿植墙')?.category2).toBe('绿植墙')
  })

  it('反例·「隔断柜」以「柜」结尾 → 仍优先命中 家具/柜子（尾字族不被归并表打乱）', () => {
    expect(autoClassify('隔断柜')).toEqual({
      category1: '家具',
      category2: '柜子',
      matchedTerm: '柜子',
      alternativeCategories1: []
    })
    expect(autoClassify('隔断柜')?.category2).not.toBe('屏风隔断')
    expect(autoClassify('玄关隔断柜')?.category2).toBe('柜子')
  })

  it('反例·红线不变：不做任意位置 includes（「藤编」头部的材料词不构成命中）', () => {
    // 「藤编屏风」现在命中的是**词尾**「屏风」，不是头部「藤编」；
    // 证明方式：去掉词尾品类词后，头部的「藤编」单独不再构成 屏风隔断 的命中。
    expect(autoClassify('藤编屏风')?.category2).toBe('屏风隔断')
    expect(autoClassify('藤编屏风')?.category1).not.toBe('木材')
    expect(autoClassify('藤编可折叠')).toBeNull()
    // 「藤编」单独作资产名时是**独立二级词条**（木材/藤编），属既有正确行为，
    // 与"头部修饰语被 includes 拉进木材"是两件事。
    expect(autoClassify('藤编')).toEqual({
      category1: '木材',
      category2: '藤编',
      matchedTerm: '藤编',
      alternativeCategories1: []
    })
    expect(autoClassify('藤编柜子')?.category2).toBe('柜子')
  })
})

/**
 * v1.0.10 · kind ↔ 一级频道一致性闸门（`isLevel1AllowedForKind`）。
 *
 * 洞里的事实：落盘父链同时含大类与一级，若命中结果的一级属于**别的频道**
 * （`硬装构件` 是模型频道的一级），就会造出 `材质/硬装构件/…` 这种错位目录。
 * `autoClassify` 本身**不知道 kind**（它是纯匹配器），所以闸门放在 `main/importer.ts`
 * 的两处调用之后；本组用同一个纯函数复现导入侧的判定，钉住"宁可不分，不可分错"。
 */
describe('autoClassify — v1.0.10 kind ↔ 一级频道闸门', () => {
  /** 复现 importer 的判定：命中 + 一级属于本 kind 的频道才采用，否则丢弃 → null */
  const gated = (name: string, kind: string) => {
    const hit = autoClassify(name)
    if (hit === null) return null
    return isLevel1AllowedForKind(kind, hit.category1) ? hit : null
  }

  it('「屏风贴图」在 texture kind 下**不落** 硬装构件（模型频道的一级）→ null', () => {
    // 纯匹配器本身会命中（这是正确的事实）
    expect(autoClassify('屏风贴图')?.category1).toBe('硬装构件')
    // 但贴图频道没有「硬装构件」这个一级 → 闸门丢弃整个 hit
    expect(gated('屏风贴图', 'texture')).toBeNull()
    expect(gated('屏风贴图', 'material')).toBeNull()
    // 同理：任何贴图只要名字尾部是模型频道的一级词，都不该落进 材质/硬装构件
    expect(gated('实木门', 'texture')).toBeNull()
  })

  it('「屏风」在 model kind 下正常落 硬装构件/屏风隔断（闸门不误伤正确命中）', () => {
    expect(gated('屏风', 'model')).toEqual({
      category1: '硬装构件',
      category2: '屏风隔断',
      matchedTerm: '屏风',
      alternativeCategories1: [],
      matchedLevel: 'l3-alias'
    })
    expect(gated('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风', 'model')?.category2).toBe('屏风隔断')
  })

  it('闸门不改变贴图侧的正确命中：大理石瓷砖 在 texture kind 下仍落 瓷砖', () => {
    expect(gated('大理石瓷砖', 'texture')).toEqual({
      category1: '瓷砖',
      category2: '大理石瓷砖',
      matchedTerm: '大理石瓷砖',
      alternativeCategories1: []
    })
  })
})

/**
 * v1.0.11（2026-10-20）· 「CJK + ID」尾巴剥离（规则 B-2）。
 *
 * 事实来源：**用户库里的真实资产名**。知末文件名普遍以 `ID_<数字>` 收尾，
 * `_` 是分词分隔符 → `ID` 粘在前一段中文词尾（`无堺黑色木纹ID` / `挂画组合ID`），
 * 旧的「功能词 / 版本号」两条剥离都匹配不上，后缀匹配全灭。
 * 2026-10-20 用户实测：材质大类下 10 个资产全部落 `未分类`。
 *
 * 修复判据（三条同时满足）：结尾 `ID`/`id`、**前一字符是 CJK**、剥完长度 ≥ 2；
 * 剥完**继续**参与功能词/版本号剥离（`挂画组合ID` → `挂画组合` → `挂画`）。
 */
describe('autoClassify — v1.0.11「CJK + ID」尾巴剥离（真实文件名）', () => {
  it('真实样本①：传薇佳画_挂画组合ID_1186414883 → 软装陈设/挂画', () => {
    // 三段剥离链：`挂画组合id` →（规则 B-2）`挂画组合` →（功能词「组合」）`挂画`
    expect(autoClassify('传薇佳画_挂画组合ID_1186414883')).toEqual({
      category1: '软装陈设',
      category2: '挂画',
      matchedTerm: '挂画',
      alternativeCategories1: []
    })
  })

  it('真实样本②：无堺黑色木纹ID_1151853396 → 一级 木纹（材质容器；二级词表无此项 → 未分类）', () => {
    // 说明（如实）：`木纹` 是**一级**分类（贴图频道 21 项之一），`LEVEL2_MAP['木纹']`
    // 下没有能尾锚定命中「无堺黑色木纹」的词条（深色木纹/浅色木纹/旧木纹… 都不是它的后缀），
    // 所以二级仍是哨兵 `未分类`。改前是整体 `null`（双未分类），改后拿到一级 —— 匹配层已修好。
    expect(autoClassify('无堺黑色木纹ID_1151853396')).toEqual({
      category1: '木纹',
      category2: UNCLASSIFIED,
      matchedTerm: '木纹',
      alternativeCategories1: []
    })
    expect(isLevel1AllowedForKind('texture', '木纹')).toBe(true)
    // 【v1.0.12】材质容器按并集（33 项）校验 → `木纹` 对 material kind 也放行，
    // 该类资产真的会落 `材质/木纹/未分类`（端到端见 `tests/importerJunk.test.ts`）。
    expect(isLevel1AllowedForKind('material', '木纹')).toBe(true)
  })

  it('ID 剥离后能继续走功能词/版本号：现代吊灯ID_123 → 灯具/吊灯', () => {
    expect(autoClassify('现代吊灯ID_123')).toEqual({
      category1: '灯具',
      category2: '吊灯',
      matchedTerm: '吊灯',
      alternativeCategories1: []
    })
  })

  it('大小写都剥：木纹ID 与 木纹id 结果一致（分词已小写，规则用 i 兜住原样入参）', () => {
    for (const name of ['木纹ID', '木纹id']) {
      expect(autoClassify(name), name).toEqual({
        category1: '木纹',
        category2: UNCLASSIFIED,
        matchedTerm: '木纹',
        alternativeCategories1: []
      })
    }
  })

  it('边界·剥完过短/无可剥 → 不产出空候选、不崩：组合ID_9 / ID_9 / 画id', () => {
    // `组合id` 剥完是 `组合`（2 字，允许剥），但「组合」不是任何词条的后缀 → null
    expect(autoClassify('组合ID_9')).toBeNull()
    // 纯 ASCII token `id` 不满足「前一字符是 CJK」→ 原样保留 → null
    expect(autoClassify('ID_9')).toBeNull()
    // `画id` → 剥完只剩 1 字（< 2）→ 不剥 → null（绝不产出空串候选）
    expect(autoClassify('画id')).toBeNull()
    expect(() => autoClassify('ID_')).not.toThrow()
    expect(autoClassify('ID_')).toBeNull()
  })

  it('反例（关键）· 纯英文以 id 结尾的词绝不被剥：grid / rapid / invalid → null', () => {
    for (const name of ['grid', 'rapid', 'invalid', 'solid', 'void']) {
      expect(autoClassify(name), name).toBeNull()
    }
  })

  it('反例·决定性证明：loftid / LOFTID 不被剥成 loft（否则会把 LOFT 误命中）', () => {
    // 若规则只按「结尾 id」剥，`loftid` → `loft` → 命中 家装户型/LOFT（误伤）。
    // 「前一字符必须是 CJK」这条把 `t` 挡住，故必须仍是 null。
    expect(autoClassify('loftid')).toBeNull()
    expect(autoClassify('LOFTID')).toBeNull()
    // 对照：正常写法仍命中（规则没破坏已有的 ASCII 全等匹配）
    expect(autoClassify('复式LOFT公寓ID_123')?.matchedTerm).toBe('LOFT')
    expect(autoClassify('Modern Loft Grid')?.matchedTerm).toBe('LOFT')
  })

  it('反例·CJK 后面不是 ID 的尾巴不受影响：idle / identify 之类不产生短候选', () => {
    expect(autoClassify('idle')).toBeNull()
    expect(autoClassify('identify')).toBeNull()
    // 中文正常词尾带 `id` 以外字母的（分词后粘字母）也不剥
    expect(autoClassify('木纹grid')).toBeNull()
  })
})

/**
 * v1.0.12 · **闸门改按容器并集 + 一级回退**（2026-10-20 主理人裁定）。
 *
 * 两个事实变化：
 * ① `isLevel1AllowedForKind('texture'|'material', …)` 改查 `MERGED_MATERIAL_LEVEL1`（33 项）——
 *    texture/material 落同一棵「材质」树，UI 也按并集给选项，闸门必须按**容器口径**校验；
 * ② 新增 `AutoClassifyOptions.level1Only`：二级命中被闸门拒绝时，导入侧再问一次"一级对不对"，
 *    用 `{ 一级, 未分类 }` 兜住 —— **宁可不分二级，也要保住正确的一级**。
 *
 * 端到端（真实落盘路径）在 `tests/importerSingleImage.test.ts` / `tests/importerJunk.test.ts` 钉住，
 * 本组只钉匹配器与闸门这两个纯函数的行为。
 */
describe('autoClassify — v1.0.12 容器口径闸门 + 一级回退', () => {
  it('闸门按容器并集：material 放行 木纹/砖材，texture 放行 陶瓷/布料', () => {
    expect(isLevel1AllowedForKind('material', '木纹')).toBe(true)
    expect(isLevel1AllowedForKind('material', '砖材')).toBe(true)
    expect(isLevel1AllowedForKind('texture', '木纹')).toBe(true)
    expect(isLevel1AllowedForKind('texture', '陶瓷')).toBe(true)
    expect(isLevel1AllowedForKind('texture', '布料')).toBe(true)
  })

  it('闸门不削弱原始目的：模型频道的一级仍被材质容器拒绝', () => {
    expect(isLevel1AllowedForKind('texture', '硬装构件')).toBe(false)
    expect(isLevel1AllowedForKind('material', '软装陈设')).toBe(false)
    expect(isLevel1AllowedForKind('material', '家具')).toBe(false)
  })

  it('level1Only：只做一级匹配，二级恒为未分类、且不进三级归并', () => {
    // 「屏风」全量匹配经三级归并落 硬装构件/屏风隔断；只做一级时应**完全没有结果**
    // （因为它不是任何一级键的后缀）—— 证明 level1Only 真的跳过了轮 1。
    expect(autoClassify('屏风', undefined, { level1Only: true })).toBeNull()
    // 「北欧挂画」的两级身份：全量 → 软装陈设/挂画（二级强度压过一级）；
    // 只做一级 → 挂画/未分类（`挂画` 本身是贴图频道的一级键）。
    expect(autoClassify('北欧挂画')?.category1).toBe('软装陈设')
    expect(autoClassify('北欧挂画')?.category2).toBe('挂画')
    expect(autoClassify('北欧挂画', undefined, { level1Only: true })).toEqual({
      category1: '挂画',
      category2: UNCLASSIFIED,
      matchedTerm: '挂画',
      alternativeCategories1: []
    })
    // 不返回三级归并标记
    expect(autoClassify('北欧挂画', undefined, { level1Only: true })?.matchedLevel).toBeUndefined()
  })

  it('level1Only 不影响老行为：不传 opts 时结果与三分支前完全一致', () => {
    expect(autoClassify('沙发')?.category2).toBe('沙发')
    expect(autoClassify('吊灯ID_123')?.category2).toBe('吊灯')
    expect(autoClassify('屏风')?.matchedLevel).toBe('l3-alias')
  })

  it('复现导入侧判定（全量 → 闸门 → 一级回退）：北欧挂画(texture) → 挂画/未分类', () => {
    /** 与 `main/importer.ts:classifyForKind` 同逻辑（改动时两处必须同步） */
    const classifyForKind = (name: string, kind: string): { category1: string; category2: string } => {
      const raw = autoClassify(name)
      if (raw !== null && isLevel1AllowedForKind(kind, raw.category1)) {
        return { category1: raw.category1, category2: raw.category2 }
      }
      const l1 = autoClassify(name, undefined, { level1Only: true })
      if (l1 !== null && isLevel1AllowedForKind(kind, l1.category1)) {
        return { category1: l1.category1, category2: UNCLASSIFIED }
      }
      return { category1: UNCLASSIFIED, category2: UNCLASSIFIED }
    }

    // ① 回退生效：二级 软装陈设 被拒 → 一级 挂画 被放行（不是双未分类）
    expect(classifyForKind('北欧挂画', 'texture')).toEqual({ category1: '挂画', category2: UNCLASSIFIED })
    // ② 容器并集生效：材质资产的 木纹/砖材 不再被丢弃
    expect(classifyForKind('无堺黑色木纹ID_1151853396', 'material')).toEqual({
      category1: '木纹',
      category2: UNCLASSIFIED
    })
    expect(classifyForKind('现代仿古砖ID_1100000001', 'material')).toEqual({
      category1: '砖材',
      category2: '仿古砖'
    })
    // ③ 真跨频道 + 一级回退也失败 → 双未分类
    expect(classifyForKind('屏风贴图', 'texture')).toEqual({
      category1: UNCLASSIFIED,
      category2: UNCLASSIFIED
    })
    // ④ 模型资产不受影响
    expect(classifyForKind('传薇佳画_挂画组合ID_1186414883', 'model')).toEqual({
      category1: '软装陈设',
      category2: '挂画'
    })
  })
})

/**
 * 镜像断言：ID 尾巴剥离的**判据**与 `src/shared/aliasRules.ts` 的 `aliasKeyOf` 共享。
 *
 * 两边实现**故意不共用**（语义不同：这里只需切掉紧贴 CJK 的 `ID` 两个字母，
 * 词典 key 要连 `ID_<数字>` 整段切掉），靠本组镜像断言防漂移。
 *
 * ⚠️ 样例唯一来源 `tests/fixtures/idSuffixSamples.ts`，改样例必须两处同时绿
 * （另一处：`tests/aliasRules.test.ts`）。本文件**只加断言，不改 autoClassify 源码**。
 */
describe('autoClassify — ID 尾巴剥离的镜像断言', () => {
  it('MUST_STRIP：ID 段被剥掉后仍能尾锚定命中词条', () => {
    // CJK 紧贴 ID → 剥成「无堺黑色木纹」→ 命中一级 木纹
    expect(autoClassify(MUST_STRIP[0]!)?.matchedTerm).toBe('木纹')
    // 真实样本：标题_品类ID_数字 → 剥成「传薇佳画_挂画组合」→ 命中 软装陈设/挂画
    expect(autoClassify(MUST_STRIP[2]!)?.category2).toBe('挂画')
    // MUST_STRIP[1]（纯英文 Brick_Rough_ID_42）不在此断言：
    // 剥不剥都无中文词条可命中，断言 null 无法区分"剥对了"和"没剥"，属无效断言。
  })

  it('MUST_KEEP：以 id 结尾的英文词不被误剥（否则 grid123 会变成 gr 残词）', () => {
    // 若规则 B-2 丢了"CJK 前置/分隔符前置"这条红线，这些名字会产出 gr/rap/inval
    // 之类的短候选，可能出现假的命中；正确行为是一律 null。
    for (const s of MUST_KEEP) {
      expect(autoClassify(s)).toBeNull()
    }
  })
})
