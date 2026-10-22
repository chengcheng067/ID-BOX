import { describe, expect, it } from 'vitest'
import {
  sanitizeName,
  stripNoise,
  pickAssetName,
  uniqueName,
  dedupeKeyOf,
  displayName,
  zhimoIdFromSources,
  zhimoIdFromText,
  zhimoIdOf
} from '../src/shared/naming'
import {
  normalizeCategoryPair,
  composeRelFolder,
  MAX_SEGMENT_LEN
} from '../src/shared/naming'

describe('sanitizeName', () => {
  it('替换 Windows 非法字符', () => {
    expect(sanitizeName('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
  })

  it('清理首尾空白与点', () => {
    expect(sanitizeName('  沙发.  ')).toBe('沙发')
  })

  it('空值兜底（全为非法字符时替换后的 ___ 也要判空）', () => {
    expect(sanitizeName('///')).toBe('未命名')
    expect(sanitizeName('')).toBe('未命名')
    expect(sanitizeName('???')).toBe('未命名')
  })
})

describe('stripNoise', () => {
  it('剥离知末水印括号', () => {
    expect(stripNoise('现代沙发(知末网www.znmo.com)')).toBe('现代沙发')
    expect(stripNoise('单椅[www.znmo.com]')).toBe('单椅')
  })

  it('剥离 znmo / 知末 字样', () => {
    expect(stripNoise('沙发-znmo')).toBe('沙发')
    expect(stripNoise('沙发_知末')).toBe('沙发')
  })

  it('保留正常名字', () => {
    expect(stripNoise('北欧风布艺沙发')).toBe('北欧风布艺沙发')
  })

  it('清洗后为空时返回原值', () => {
    expect(stripNoise('(znmo)')).toBe('(znmo)')
  })
})

describe('pickAssetName', () => {
  it('单一顶层文件夹 → 用文件夹名', () => {
    expect(pickAssetName('download', [{ name: '某品牌沙发组', isDir: true }])).toBe('某品牌沙发组')
  })

  it('多文件散装 → 用压缩包名（调用方已去扩展名）', () => {
    expect(pickAssetName('沙发合集', [
      { name: 'a.skp', isDir: false },
      { name: 'b.png', isDir: false }
    ])).toBe('沙发合集')
  })

  it('防御性去扩展名（调用方忘了去也不会把 .zip 带进文件夹名）', () => {
    expect(pickAssetName('沙发合集.zip', [
      { name: 'a.skp', isDir: false },
      { name: 'b.png', isDir: false }
    ])).toBe('沙发合集')
  })

  it('单一顶层文件夹带水印 → 剥离', () => {
    expect(pickAssetName('x.zip', [{ name: '老板椅(知末网www.znmo.com)', isDir: true }])).toBe('老板椅')
  })
})

describe('uniqueName', () => {
  it('无冲突时用原名', () => {
    expect(uniqueName('沙发', new Set())).toBe('沙发')
  })

  it('冲突时追加序号', () => {
    expect(uniqueName('沙发', new Set(['沙发']))).toBe('沙发-2')
    expect(uniqueName('沙发', new Set(['沙发', '沙发-2']))).toBe('沙发-3')
  })
})

describe('dedupeKeyOf', () => {
  it('忽略大小写与分隔符差异', () => {
    expect(dedupeKeyOf('Modern Sofa', 'model')).toBe(dedupeKeyOf('modern-sofa', 'model'))
  })

  it('不同大类不判重', () => {
    expect(dedupeKeyOf('沙发', 'model')).not.toBe(dedupeKeyOf('沙发', 'texture'))
  })
})

// ── T06：分类对校验（docs/06 v1.0.2 §9.2 六条规则） ──────────────────

describe('normalizeCategoryPair', () => {
  it('规则1：trim + 非法字符清洗（/ → _，恰好保证单段）', () => {
    expect(normalizeCategoryPair(' 家具 ', '沙发')).toEqual({
      category1: '家具',
      category2: '沙发',
      changed: false
    })
    expect(normalizeCategoryPair('家/具', '沙*发')).toEqual({
      category1: '家_具',
      category2: '沙_发',
      changed: true
    })
  })

  it('规则1：清洗后为空 → 落哨兵', () => {
    expect(normalizeCategoryPair('', '  ')!.category1).toBe('未分类')
    expect(normalizeCategoryPair('', '  ')!.category2).toBe('未分类')
    expect(normalizeCategoryPair('///', undefined)!.category1).toBe('未分类')
  })

  it('规则2：哨兵幂等（含前后空白差异），不报 changed', () => {
    expect(normalizeCategoryPair('未分类', ' 未分类 ')).toEqual({
      category1: '未分类',
      category2: '未分类',
      changed: false
    })
  })

  it('规则2：undefined / null 都落哨兵，且不算 changed（只是填默认值）', () => {
    expect(normalizeCategoryPair(undefined, undefined)).toEqual({
      category1: '未分类',
      category2: '未分类',
      changed: false
    })
    expect(normalizeCategoryPair(null, null)!.changed).toBe(false)
  })

  it('规则3：级联一致性 —— (未分类, 已知二级) 强制降级为 (未分类, 未分类)', () => {
    expect(normalizeCategoryPair('未分类', '沙发')).toEqual({
      category1: '未分类',
      category2: '未分类',
      changed: true
    })
  })

  it('规则4：词表放行 —— 未知一级、或二级不在该一级下，都照常保留（不降级）', () => {
    expect(normalizeCategoryPair('自定义分类', '自定义二级')).toEqual({
      category1: '自定义分类',
      category2: '自定义二级',
      changed: false
    })
    // 「值在词表但属于另一一级」→ 保留，磁盘是唯一真相（isKnownCombo 为 false 但放行）
    expect(normalizeCategoryPair('家具', '客厅')).toEqual({
      category1: '家具',
      category2: '客厅',
      changed: false
    })
  })

  it('规则5：超长按码点截断到 MAX_SEGMENT_LEN=40', () => {
    expect(MAX_SEGMENT_LEN).toBe(40)
    const long = '家'.repeat(45)
    const r = normalizeCategoryPair(long, undefined)!
    expect(Array.from(r.category1).length).toBe(40)
    expect(r.changed).toBe(true)
  })

  it('规则5：emoji 按码点截断不割半（slice 会割开代理对，Array.from 不会）', () => {
    const emoji = '🀄'.repeat(45) // 🀄 = U+1F004，占 2 个 UTF-16 码元
    const r = normalizeCategoryPair(emoji, undefined)!
    expect(Array.from(r.category1).length).toBe(40)
    expect(r.category1.endsWith('🀄')).toBe(true)
  })

  it('规则6：changed 标记 —— 只填默认值不算，真实改写才算', () => {
    expect(normalizeCategoryPair(undefined, undefined)!.changed).toBe(false)
    expect(normalizeCategoryPair('家具', '沙发')!.changed).toBe(false)
    expect(normalizeCategoryPair('未分类', '沙发')!.changed).toBe(true) // 级联降级
    expect(normalizeCategoryPair('a<b', 'ok')!.changed).toBe(true) // 非法字符
  })
})

describe('composeRelFolder（06 §9.3，四段）', () => {
  it('<大类>/<一级>/<二级>/<资产名>', () => {
    expect(composeRelFolder('模型', '未分类', '未分类', '现代衣柜')).toBe('模型/未分类/未分类/现代衣柜')
    expect(composeRelFolder('贴图', '石材', '水磨石', '木纹 01')).toBe('贴图/石材/水磨石/木纹 01')
  })
})

describe('composeRelFolder — DEF-14 回归：含 / 的分类词条不得拆段', () => {
  it('「椅子/凳子」落为单段「椅子_凳子」，保持固定四层', () => {
    expect(composeRelFolder('模型', '家具', '椅子/凳子', '北欧椅子')).toBe(
      '模型/家具/椅子_凳子/北欧椅子'
    )
  })
  it('一级与二级都含分隔符时全部净化', () => {
    expect(composeRelFolder('贴图', '灯膜/灯罩', '毛毡/毛呢', 'x')).toBe(
      '贴图/灯膜_灯罩/毛毡_毛呢/x'
    )
  })
  it('反斜杠同样净化', () => {
    expect(composeRelFolder('模型', '家具', '椅子\\凳子', 'x')).toBe(
      '模型/家具/椅子_凳子/x'
    )
  })
  it('rescan 视角：四段拆分后 category2 完整回读（不丢「凳子」）', () => {
    const rel = composeRelFolder('模型', '家具', '椅子/凳子', '北欧椅子')
    const segs = rel.split('/')
    expect(segs).toHaveLength(4)
    expect(segs[2]).toBe('椅子_凳子')
  })
})

describe('displayName（只影响界面显示，磁盘名不动）', () => {
  it('剥掉知末 ID 尾巴：紧贴 / 下划线 / 连字符 / 空格', () => {
    expect(displayName('新中式复古仿古砖_复古砖_墙砖_地砖_深色仿古砖ID_1172815578')).toBe(
      '新中式复古仿古砖_复古砖_墙砖_地砖_深色仿古砖'
    )
    expect(displayName('传薇佳画_挂画组合ID_1186414883')).toBe('传薇佳画_挂画组合')
    expect(displayName('无堺黑色木纹ID-1151853396')).toBe('无堺黑色木纹')
    expect(displayName('北欧椅子  id 1234567')).toBe('北欧椅子')
    expect(displayName('陶瓷花瓶ID1172815578')).toBe('陶瓷花瓶')
  })

  it('剥完顺手清掉悬空的分隔符（不留「复古砖_」这种尾巴）', () => {
    expect(displayName('复古砖_ID_1172815578')).toBe('复古砖')
    expect(displayName('复古砖 - ID_1172815578')).toBe('复古砖')
    expect(displayName('复古砖ID_1172815578 ')).toBe('复古砖')
  })

  it('位数门槛护住真实名字：4 位年份/型号不剥', () => {
    expect(displayName('型号ID2024')).toBe('型号ID2024')
    expect(displayName('门牌ID123')).toBe('门牌ID123')
  })

  it('压根没有 ID 段 → 原样返回（连末尾分隔符也不动）', () => {
    expect(displayName('北欧椅子')).toBe('北欧椅子')
    expect(displayName('ID卡')).toBe('ID卡')
    // ID 不在尾巴、后面还跟着别的词 → 归「中间段」规则处理（见上一条用例）
    expect(displayName('ID_1172815578_拷贝')).toBe('拷贝')
  })

  it('剥完为空则保留原值（宁可露出 ID，也不给空名）', () => {
    expect(displayName('ID_1172815578')).toBe('ID_1172815578')
    expect(displayName('ID_1172815578_')).toBe('ID_1172815578_')
    expect(displayName('')).toBe('')
  })

  it('ID 在名字中间（后面还跟 _resize / _2K 这类后缀）也要剥——实测样本', () => {
    expect(displayName('中古木纹_无缝中古樱桃木_樱桃木木纹ID_1166965084_resize')).toBe(
      '中古木纹_无缝中古樱桃木_樱桃木木纹_resize'
    )
    expect(displayName('复古砖_ID_1172815578_2K')).toBe('复古砖_2K')
    expect(displayName('石材ID_1234567.jpg')).toBe('石材.jpg')
  })

  it('幂等', () => {
    const once = displayName('复古砖ID_1172815578')
    expect(displayName(once)).toBe(once)
  })

  it('喂进来的不是字符串也不炸（历史数据/脏索引兜底）', () => {
    expect(displayName(undefined as unknown as string)).toBe('')
    expect(displayName(null as unknown as string)).toBe('')
  })
})

// ── 知末商品 ID 提取（docs/24 §3.2，T-01）────────────────────────────────
//
// 口径与 displayName() **严格共用同两条正则**（不许新增第三条，否则两条规则必然漂移：
// 会出现"显示名剥掉了 ID、却抓不到 ID"这种自相矛盾的库）。
describe('zhimoIdOf（从资产名取知末商品 ID）', () => {
  it('普通尾 ID：ID 顶在名字末尾（绝大多数真实样本）', () => {
    expect(zhimoIdOf('传薇佳画_挂画组合ID_1186414883')).toBe('1186414883')
    expect(zhimoIdOf('中古侘寂壁灯ID_1200166260')).toBe('1200166260')
  })

  it('MID 命中：ID 后面还跟着 `_resize` 等后缀（必须穿透）', () => {
    expect(zhimoIdOf('中古木纹_无缝中古樱桃木_樱桃木木纹ID_1166965084_resize')).toBe('1166965084')
    expect(zhimoIdOf('复古砖_ID_1172815578_2K')).toBe('1172815578')
    expect(zhimoIdOf('石材ID_1234567.jpg')).toBe('1234567')
  })

  it('连字符分隔：`ID-` 写法', () => {
    expect(zhimoIdOf('侘寂挂画_挂画组合ID-1186414883')).toBe('1186414883')
    expect(zhimoIdOf('ID-1172815578')).toBe('1172815578')
  })

  it('空格分隔 / 大小写混写', () => {
    expect(zhimoIdOf('北欧椅子 id 1234567')).toBe('1234567')
    expect(zhimoIdOf('  复古砖 ID_1172815578  ')).toBe('1172815578')
    expect(zhimoIdOf('noise Id_7654321')).toBe('7654321')
  })

  it('多个 ID 段取**最右**一个（下载器把站点 ID 追加在尾巴上）', () => {
    expect(zhimoIdOf('椅子ID_1111111_版本ID_2222222')).toBe('2222222')
    expect(zhimoIdOf('A_ID_1111111_B_ID_3333333_resize')).toBe('3333333')
  })

  it('没有 ID 段 → null', () => {
    expect(zhimoIdOf('北欧椅子')).toBeNull()
    expect(zhimoIdOf('grid123')).toBeNull()
    expect(zhimoIdOf('rapid42')).toBeNull()
    expect(zhimoIdOf('Brick_Rough_ID_42')).toBeNull()
  })

  it('`ID卡` 这类非数字不误命中（后面的字符必须能解析出数字串）', () => {
    expect(zhimoIdOf('ID卡')).toBeNull()
    expect(zhimoIdOf('ID卡_北欧')).toBeNull()
    expect(zhimoIdOf('型号ID2024')).toBeNull()
  })

  it('6 位以下不命中（位数门槛护住年份/型号），恰好 6 位命中', () => {
    expect(zhimoIdOf('门牌ID123')).toBeNull()
    expect(zhimoIdOf('ID_12345')).toBeNull()
    expect(zhimoIdOf('ID_123456')).toBe('123456')
  })

  it('空值 / 非字符串不炸', () => {
    expect(zhimoIdOf('')).toBeNull()
    expect(zhimoIdOf('   ')).toBeNull()
    expect(zhimoIdOf(undefined as unknown as string)).toBeNull()
    expect(zhimoIdOf(null as unknown as string)).toBeNull()
  })

  it('与 displayName() 口径一致：能剥掉的名字一定能取到 ID（反之亦然）', () => {
    const samples = [
      '传薇佳画_挂画组合ID_1186414883',
      '中古木纹_无缝中古樱桃木_樱桃木木纹ID_1166965084_resize',
      '无堺黑色木纹ID_1151853396-2',
      'ID_1234567_拷贝'
    ]
    for (const s of samples) {
      const id = zhimoIdOf(s)
      expect(id, `${s} 应当取到 ID`).not.toBeNull()
      expect(displayName(s)).not.toContain(id as string)
    }
  })
})

// ── 0.6.3：ID 识别扩容（znzmo 前缀 + 裸数字兜底）───────────────────────────
//
// 用户实测反例（本轮修复的**全部**依据，改规则前先读这三条）：
// ① 资产「中古侘寂屏风_木屏风_藤编屏风_可折叠屏风」→ 包内是 `znzmo-1180221079-1.skp`
//    （资产名里一个 ID 字都没有 → 旧实现取不到 ID → 封面按钮禁用）；
// ② 资产「现代中古吊灯_极简奶油风吊灯…」→ 包内是 `znzmo-1191034576-1.skp`；
// ③ `现代壁灯ID_1232108421.rar` → 解包后 `attachment_1786942463670\现代壁灯\现代壁灯.skp`
//    （包内零 ID 痕迹，ID 只在压缩包名上 —— 必须从第三处的文件名解析出来）。
describe('zhimoIdFromText（ID 识别扩容：ID 标记 / znzmo 前缀 / 裸数字兜底）', () => {
  it('① `ID` 标记仍是最高优先，旧口径全部保持', () => {
    expect(zhimoIdFromText('传薇佳画_挂画组合ID_1186414883')).toBe('1186414883')
    expect(zhimoIdFromText('中古木纹_无缝中古樱桃木_樱桃木木纹ID_1166965084_resize')).toBe(
      '1166965084'
    )
    expect(zhimoIdFromText('椅子ID_1111111_版本ID_2222222')).toBe('2222222')
    expect(zhimoIdFromText('石材ID_1234567.jpg')).toBe('1234567')
  })

  it('② `znzmo-<ID>-<序号>`：只取第一段数字，`-1` 是站方序号不是 ID', () => {
    expect(zhimoIdFromText('znzmo-1180221079-1.skp')).toBe('1180221079')
    expect(zhimoIdFromText('znzmo-1191034576-1.preview.jpg')).toBe('1191034576')
    expect(zhimoIdFromText('znzmo-1100221079-1.preview.jpg')).toBe('1100221079')
    // 下划线 / 空格分隔同样成立
    expect(zhimoIdFromText('znzmo_1180221079_1.skp')).toBe('1180221079')
    // 完整相对路径也能解析（包内深层路径）
    expect(zhimoIdFromText('模型/znzmo-1180221079-1.skp')).toBe('1180221079')
  })

  it('② `znzmo` 多个候选取其最右（下载器追加站点 ID 的既有口径）', () => {
    expect(zhimoIdFromText('znzmo-111111111-1_znzmo-222222222-2.skp')).toBe('222222222')
  })

  it('③ 裸 9–10 位数字兜底（名字里就是一串数字）', () => {
    expect(zhimoIdFromText('现代壁灯 1232108421')).toBe('1232108421')
    expect(zhimoIdFromText('123210842')).toBe('123210842') // 9 位
    // 10 位
    expect(zhimoIdFromText('1232108421')).toBe('1232108421')
  })

  it('③ 绝不能误命中的反例（宁可 null，不可返回错的 ID）', () => {
    // 13 位解压目录名（用户样本）：内部 10 位片段也不许命中
    expect(zhimoIdFromText('attachment_1786942463670')).toBeNull()
    expect(zhimoIdFromText('attachment_1786942463670\\现代壁灯\\现代壁灯.skp')).toBeNull()
    // 11 位同样太长
    expect(zhimoIdFromText('17869424636')).toBeNull()
    // 4 位年份 / 型号
    expect(zhimoIdFromText('型号ID2024')).toBeNull()
    expect(zhimoIdFromText('椅子-2024')).toBeNull()
    // 8 位太短（知末真实 ID 是 9–10 位）
    expect(zhimoIdFromText('12345678')).toBeNull()
  })

  it('真实反例：无任何 ID 的资产名 → null（这正是封面按钮被禁用的原因）', () => {
    expect(zhimoIdFromText('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')).toBeNull()
    expect(zhimoIdFromText('现代中古吊灯_极简奶油风吊灯_客厅吊灯')).toBeNull()
  })

  it('压缩包名带扩展名同样能取到 ID（用户样本 ③）', () => {
    expect(zhimoIdFromText('现代壁灯ID_1232108421.rar')).toBe('1232108421')
    // 与 MID 口径一致：ID 后面跟 `.` 属于后缀
    expect(zhimoIdFromText('现代壁灯ID_1232108421.zip')).toBe('1232108421')
  })

  it('空值 / 非字符串不炸', () => {
    expect(zhimoIdFromText('')).toBeNull()
    expect(zhimoIdFromText('   ')).toBeNull()
    expect(zhimoIdFromText(undefined as unknown as string)).toBeNull()
    expect(zhimoIdFromText(null as unknown as string)).toBeNull()
  })

  it('zhimoIdOf 是 zhimoIdFromText 的兼容别名（同输入同输出）', () => {
    const samples = [
      'znzmo-1180221079-1.skp',
      '现代壁灯ID_1232108421.rar',
      'attachment_1786942463670',
      '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风'
    ]
    for (const s of samples) expect(zhimoIdOf(s)).toBe(zhimoIdFromText(s))
  })
})

describe('zhimoIdFromSources（三来源按可信度取第一个非空）', () => {
  it('压缩包名优先于资产名与包内文件（用户样本 ③ 的核心）', () => {
    expect(
      zhimoIdFromSources('现代壁灯ID_1232108421.rar', '现代壁灯', [
        'attachment_1786942463670/现代壁灯.skp'
      ])
    ).toBe('1232108421')
  })

  it('压缩包名没有 ID → 退到资产名', () => {
    expect(zhimoIdFromSources('中古侘寂屏风.zip', '屏风ID_1186414883', ['a.skp'])).toBe(
      '1186414883'
    )
  })

  it('压缩包名与资产名都没有 → 退到包内文件相对路径（znzmo 样本）', () => {
    expect(
      zhimoIdFromSources('中古侘寂屏风.zip', '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风', [
        '预览图.jpg',
        'znzmo-1180221079-1.skp'
      ])
    ).toBe('1180221079')
  })

  it('取第一个能解析出的文件（顺序 = 包内遍历顺序）', () => {
    expect(
      zhimoIdFromSources(null, null, ['a.txt', 'znzmo-111111111-1.skp', 'znzmo-222222222-1.skp'])
    ).toBe('111111111')
  })

  it('包内文件名只认强证据（ID 标记 / znzmo），裸数字不算（防贴图包互判重复）', () => {
    // 贴图文件名常带 9–10 位序号 —— 当成 ID 会把两套不同贴图并成"重复副本"
    expect(zhimoIdFromSources('大理石贴图.zip', '大理石贴图', ['marble_123456789.jpg'])).toBeNull()
    // 但包内文件名里的 `ID_` 标记仍然采信
    expect(zhimoIdFromSources('贴图包.zip', '贴图包', ['木纹ID_1166965084.png'])).toBe('1166965084')
  })

  it('三处都解析不出 → null（调用方据此不写库）', () => {
    expect(zhimoIdFromSources('椅子.zip', '椅子', ['椅子.skp'])).toBeNull()
    expect(zhimoIdFromSources(null, null, null)).toBeNull()
    expect(zhimoIdFromSources(undefined, undefined, [])).toBeNull()
  })
})
