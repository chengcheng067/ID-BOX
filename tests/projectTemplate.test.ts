/**
 * 项目文件夹模板 —— 数据层单测（docs/60 §2.5 ④ 判据 + §5.3 白名单双向断言，T-01）。
 *
 * 覆盖：
 * ① 内置 4×15 模板**逐字比对**（防手滑改词表 —— 词表的每个字都是用户拍板真源）；
 * ② `normalizeProjectTemplate` 各容错分支（脏类型 / 深度 5 层剪枝 / 257 节点截断 /
 *    兄弟重名去重 / 超长码点截断 / 占位符字面量保留 / id 重生成）；
 * ③ `normalizeProjectTemplates`（坏项丢弃 / id 去重重生成 / 20 封顶 / 整表空回落默认 / 幂等）；
 * ④ `resolveRootName` 两分支（编号已填替换占位符 / 编号留空直接用名称，docs/60 §2.4 表）；
 * ⑤ 旧档缺键零迁移（`DEFAULT_SETTINGS.projectTemplates` == `DEFAULT_PROJECT_TEMPLATES`）；
 * ⑥ `normalizeSettings` 收口（三键归一化走通，单项降级不拖垮其它键）；
 * ⑦ 钉选 / 底纹归一化（脏类型 / 非绝对路径 / 同 absPath 去重 / 32 条封顶；
 *    未知命名空间键丢弃 / 空 fileName 丢弃 / 64 键封顶）；
 * ⑧ 白名单键数 11→12 + 双向断言（`projectTemplates` 进包、
 *    `homePinnedFolders` / `homeFolderWallpaper` 不进包）。
 */
import { describe, expect, it } from 'vitest'

import {
  BUILTIN_TEMPLATE_ID,
  BUILTIN_TEMPLATE_NAME,
  DEFAULT_PROJECT_TEMPLATES,
  MAX_TEMPLATE_COUNT,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES,
  ROOT_NAME_PATTERN,
  cloneDefaultTemplates,
  countTemplateNodes,
  normalizeProjectTemplate,
  normalizeProjectTemplates,
  resolveRootName,
  templateDepth
} from '../src/shared/projectTemplate'
import { DEFAULT_SETTINGS, type ProjectTemplate } from '../src/shared/types'
import {
  MAX_HOME_FOLDER_WALLPAPER_KEYS,
  MAX_HOME_PINNED_FOLDERS,
  normalizeHomeFolderWallpaper,
  normalizeHomePinnedFolders,
  normalizeSettings
} from '../src/main/settings'

// ════════════════════════════════════════════════════════════════════════════
// ① 内置模板逐字比对（用户实测抄录真源，docs/60 §2.3）
// ════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_PROJECT_TEMPLATES — 内置 4×15 逐字真源', () => {
  it('唯一一项，id 固定 builtin，界面名 公司标准模板，根名带占位符', () => {
    expect(DEFAULT_PROJECT_TEMPLATES).toHaveLength(1)
    expect(DEFAULT_PROJECT_TEMPLATES[0].id).toBe(BUILTIN_TEMPLATE_ID)
    expect(DEFAULT_PROJECT_TEMPLATES[0].id).toBe('builtin')
    expect(DEFAULT_PROJECT_TEMPLATES[0].name).toBe(BUILTIN_TEMPLATE_NAME)
    expect(DEFAULT_PROJECT_TEMPLATES[0].name).toBe('公司标准模板')
    expect(DEFAULT_PROJECT_TEMPLATES[0].root.name).toBe('（{编号}）+{名称}')
    expect(DEFAULT_PROJECT_TEMPLATES[0].root.name).toBe(ROOT_NAME_PATTERN)
  })

  it('两级树逐字比对：4 个一级 + 15 个二级，每个字都对', () => {
    const root = DEFAULT_PROJECT_TEMPLATES[0].root
    expect(root.children?.map((c) => c.name)).toEqual([
      '1-工作资料',
      '2-工作文件',
      '3-协调文件',
      '4-归档文件'
    ])
    expect(root.children?.[0].children?.map((c) => c.name)).toEqual([
      '1.1-设计资料',
      '1.2-专业资料',
      '1.3-供应商资料',
      '1.4-现场过程照片'
    ])
    expect(root.children?.[1].children?.map((c) => c.name)).toEqual([
      '2.1-方案',
      '2.2-施工图',
      '2.3-软装',
      '2.4-模型文件',
      '2.5-渲染文件',
      '2.6-成果文件'
    ])
    expect(root.children?.[2].children?.map((c) => c.name)).toEqual([
      '3.1-收文件',
      '3.2-发文件',
      '3.3-管理文件'
    ])
    expect(root.children?.[3].children?.map((c) => c.name)).toEqual([
      '4.1-施工图',
      '4.2-完工照片'
    ])
    // 4 一级 × 二级数 4+6+3+2 = 15
    expect(root.children?.map((c) => c.children?.length ?? 0)).toEqual([4, 6, 3, 2])
  })

  it('度量：总节点 20（1 根 + 4 + 15）；按节点深度计 3（根 + 两级内容，Q-6 的"两级"指内容层）', () => {
    const root = DEFAULT_PROJECT_TEMPLATES[0].root
    expect(countTemplateNodes(root)).toBe(20)
    expect(templateDepth(root)).toBe(3)
    expect(templateDepth(root)).toBeLessThanOrEqual(MAX_TEMPLATE_DEPTH)
    expect(countTemplateNodes(root)).toBeLessThanOrEqual(MAX_TEMPLATE_NODES)
  })

  it('旧档缺键零迁移：DEFAULT_SETTINGS.projectTemplates == DEFAULT_PROJECT_TEMPLATES', () => {
    expect(DEFAULT_SETTINGS.projectTemplates).toEqual(DEFAULT_PROJECT_TEMPLATES)
    expect(DEFAULT_SETTINGS.homePinnedFolders).toEqual([])
    expect(DEFAULT_SETTINGS.homeFolderWallpaper).toEqual({})
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② normalizeProjectTemplate — 单棵容错
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeProjectTemplate — 单棵归一化', () => {
  it('内置模板过归一化后逐字不变（幂等，占位符原样保留）', () => {
    const normalized = normalizeProjectTemplate(DEFAULT_PROJECT_TEMPLATES[0])
    expect(normalized).toEqual(DEFAULT_PROJECT_TEMPLATES[0])
    expect(normalized?.root.name).toBe('（{编号}）+{名称}')
  })

  it('合法的自定义树原样通过（id / 名称保留）', () => {
    const tree: ProjectTemplate = {
      id: 'u-1',
      name: '我的模板',
      root: { name: '项目根', children: [{ name: '图纸' }, { name: '照片' }] }
    }
    expect(normalizeProjectTemplate(tree)).toEqual(tree)
  })

  it('脏类型 / 缺 root / root.name 非字符串 → null（坏项，交给整表丢弃）', () => {
    expect(normalizeProjectTemplate(null)).toBeNull()
    expect(normalizeProjectTemplate(undefined)).toBeNull()
    expect(normalizeProjectTemplate('模板')).toBeNull()
    expect(normalizeProjectTemplate(42)).toBeNull()
    expect(normalizeProjectTemplate([])).toBeNull()
    expect(normalizeProjectTemplate({ id: 'x', name: '无根' })).toBeNull()
    expect(normalizeProjectTemplate({ id: 'x', name: '根坏', root: 7 })).toBeNull()
    expect(normalizeProjectTemplate({ id: 'x', name: '根坏', root: { children: [] } })).toBeNull()
  })

  it('节点名非法字符被 sanitizeName 清洗（/ → _ 等）', () => {
    const t = normalizeProjectTemplate({
      id: 'x',
      name: 't',
      root: { name: '根', children: [{ name: 'a/b<c>:"d' }] }
    })
    expect(t?.root.children?.[0].name).toBe('a_b_c___d')
  })

  it('深度 5 层 → 剪枝到 4 级（Q-6：深度 4 封顶）', () => {
    const t = normalizeProjectTemplate({
      id: 'x',
      name: 't',
      root: {
        name: 'L1',
        children: [
          {
            name: 'L2',
            children: [{ name: 'L3', children: [{ name: 'L4', children: [{ name: 'L5' }] }] }]
          }
        ]
      }
    })
    expect(t).not.toBeNull()
    expect(templateDepth(t!.root)).toBe(MAX_TEMPLATE_DEPTH)
    expect(templateDepth(t!.root)).toBe(4)
    // L4 成为叶子，L5 被剪掉
    expect(t!.root.children![0].children![0].children![0]).toEqual({ name: 'L4' })
  })

  it('总节点 257 → 截断到 256（含根；静默剪掉多余兄弟）', () => {
    const children = Array.from({ length: 300 }, (_, i) => ({ name: `子${i + 1}` }))
    const t = normalizeProjectTemplate({ id: 'x', name: 't', root: { name: '根', children } })
    expect(t).not.toBeNull()
    // 根 + 255 个子节点 = 256
    expect(countTemplateNodes(t!.root)).toBe(MAX_TEMPLATE_NODES)
    expect(t!.root.children).toHaveLength(255)
  })

  it('兄弟重名自动去重（uniqueName 语义：依次追加 -2、-3）', () => {
    const t = normalizeProjectTemplate({
      id: 'x',
      name: 't',
      root: { name: '根', children: [{ name: '椅子' }, { name: '椅子' }, { name: '椅子' }] }
    })
    expect(t?.root.children?.map((c) => c.name)).toEqual(['椅子', '椅子-2', '椅子-3'])
  })

  it('单名超 40 字按码点截断（MAX_SEGMENT_LEN；emoji 不割代理对）', () => {
    const long = '名'.repeat(50)
    const t = normalizeProjectTemplate({ id: 'x', name: 't', root: { name: '根', children: [{ name: long }] } })
    expect(Array.from(t!.root.children![0].name)).toHaveLength(40)

    const emoji = '🏠'.repeat(45)
    const t2 = normalizeProjectTemplate({ id: 'x', name: 't', root: { name: '根', children: [{ name: emoji }] } })
    expect(Array.from(t2!.root.children![0].name)).toHaveLength(40)
    expect(t2!.root.children![0].name).toBe('🏠'.repeat(40))
  })

  it('id 缺失 / 空白 → 重新生成非空 id；id 合法则保留', () => {
    const noId = normalizeProjectTemplate({ name: 't', root: { name: '根' } })
    expect(noId).not.toBeNull()
    expect(typeof noId!.id).toBe('string')
    expect(noId!.id.length).toBeGreaterThan(0)

    const blankId = normalizeProjectTemplate({ id: '   ', name: 't', root: { name: '根' } })
    expect(blankId!.id.length).toBeGreaterThan(0)

    const kept = normalizeProjectTemplate({ id: 'my-id', name: 't', root: { name: '根' } })
    expect(kept!.id).toBe('my-id')
  })

  it('模板名清洗：非法字符清洗 + 空/脏名回落，40 字封顶', () => {
    const dirty = normalizeProjectTemplate({ id: 'x', name: 'a<b>c', root: { name: '根' } })
    expect(dirty!.name).toBe('a_b_c')

    const empty = normalizeProjectTemplate({ id: 'x', name: '///', root: { name: '根' } })
    // sanitizeName 对"清洗后为空"的兜底是 未命名（naming.ts:18），永不返回空串
    expect(empty!.name).toBe('未命名')

    const missing = normalizeProjectTemplate({ id: 'x', root: { name: '根' } })
    expect(missing!.name).toBe('未命名模板')

    const long = normalizeProjectTemplate({ id: 'x', name: '长'.repeat(50), root: { name: '根' } })
    expect(Array.from(long!.name)).toHaveLength(40)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ normalizeProjectTemplates — 整表归一化
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeProjectTemplates — 整表归一化', () => {
  it('合法整表逐项通过', () => {
    const list: ProjectTemplate[] = [
      DEFAULT_PROJECT_TEMPLATES[0],
      { id: 'u-1', name: '自建', root: { name: '根A' } },
      { id: 'u-2', name: '自建2', root: { name: '根B', children: [{ name: '子' }] } }
    ]
    const out = normalizeProjectTemplates(list)
    expect(out).toHaveLength(3)
    expect(out.map((t) => t.id)).toEqual(['builtin', 'u-1', 'u-2'])
  })

  it('坏项丢弃，好项保留', () => {
    const out = normalizeProjectTemplates([
      null,
      '垃圾',
      42,
      { id: 'good', name: '好模板', root: { name: '根' } },
      { id: 'bad', name: '坏模板' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('good')
  })

  it('重复 id → 后到的重新生成，保证 id 唯一（id 是锚点）', () => {
    const out = normalizeProjectTemplates([
      { id: 'dup', name: 'A', root: { name: '根A' } },
      { id: 'dup', name: 'B', root: { name: '根B' } }
    ])
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('dup')
    expect(out[1].id).not.toBe('dup')
    expect(new Set(out.map((t) => t.id)).size).toBe(2)
  })

  it('条数 > 20 截断到 MAX_TEMPLATE_COUNT', () => {
    const list = Array.from({ length: 25 }, (_, i) => ({
      id: `t-${i + 1}`,
      name: `模板${i + 1}`,
      root: { name: `根${i + 1}` }
    }))
    const out = normalizeProjectTemplates(list)
    expect(out).toHaveLength(MAX_TEMPLATE_COUNT)
    expect(out.map((t) => t.id)).toEqual(list.slice(0, 20).map((t) => t.id))
  })

  it('整表坏 / 空 / 非数组 → 回落默认数组（新副本，不与常量共享引用）', () => {
    for (const bad of [undefined, null, '表', 42, {}, [], [null, '垃圾']]) {
      const out = normalizeProjectTemplates(bad)
      expect(out).toEqual(DEFAULT_PROJECT_TEMPLATES)
    }
    const out = normalizeProjectTemplates([])
    expect(out[0]).not.toBe(DEFAULT_PROJECT_TEMPLATES[0])
    expect(cloneDefaultTemplates()[0]).not.toBe(DEFAULT_PROJECT_TEMPLATES[0])
  })

  it('幂等：归一化两次结果一致（重启读回一致判据）', () => {
    const once = normalizeProjectTemplates([
      { id: 'u-1', name: '自建', root: { name: '根', children: [{ name: 'a' }, { name: 'a' }] } }
    ])
    const twice = normalizeProjectTemplates(once)
    expect(twice).toEqual(once)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ④ resolveRootName — 根名两分支（docs/60 §2.4 表，逐字示例）
// ════════════════════════════════════════════════════════════════════════════

describe('resolveRootName — 编号可选两分支（Q-3）', () => {
  it('编号已填：替换 {编号} 与 {名称} 占位符（文档示例逐字）', () => {
    expect(resolveRootName('（{编号}）+{名称}', '2026-018', '江畔会所')).toBe('（2026-018）+江畔会所')
  })

  it('编号留空：直接 sanitizeName(名称)，忽略占位符结构', () => {
    expect(resolveRootName('（{编号}）+{名称}', '', '江畔会所')).toBe('江畔会所')
    expect(resolveRootName('（{编号}）+{名称}', '   ', '江畔会所')).toBe('江畔会所')
    // 无论模式改成什么都走这条分支（用户批注语义逐字对齐）
    expect(resolveRootName('{编号}-{名称}', '', '江畔会所')).toBe('江畔会所')
    expect(resolveRootName('随便什么模式', '', '江畔会所')).toBe('江畔会所')
  })

  it('编号/名称非法字符先各自清洗，再替换、再整体清洗', () => {
    expect(resolveRootName('（{编号}）+{名称}', 'a/b', '江畔会所')).toBe('（a_b）+江畔会所')
    expect(resolveRootName('（{编号}）+{名称}', '2026-018', '江畔/会所')).toBe('（2026-018）+江畔_会所')
  })

  it('名称空 → sanitizeName 兜底 未命名（向导 W2 会禁用下一步，这里是纯函数兜底）', () => {
    expect(resolveRootName('（{编号}）+{名称}', '', '')).toBe('未命名')
    expect(resolveRootName('（{编号}）+{名称}', '2026-018', '')).toBe('（2026-018）+未命名')
  })

  it('占位符只做字面替换：模式里没有占位符时编号不会凭空出现', () => {
    expect(resolveRootName('纯字面根名', '2026-018', '江畔会所')).toBe('纯字面根名')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥⑦ normalizeSettings 收口 + 钉选 / 底纹归一化
// ════════════════════════════════════════════════════════════════════════════

describe('normalizeSettings — 三新键收口（单项降级）', () => {
  it('旧档缺三键 → 内置模板 / 空钉选 / 空底纹（升级零迁移）', () => {
    const legacy = { libraryDir: 'E:\\ModVault\\Library' } as unknown as Parameters<typeof normalizeSettings>[0]
    const s = normalizeSettings(legacy)
    expect(s.projectTemplates).toEqual(DEFAULT_PROJECT_TEMPLATES)
    expect(s.homePinnedFolders).toEqual([])
    expect(s.homeFolderWallpaper).toEqual({})
    // 不拖垮其它键
    expect(s.libraryDir).toBe('E:\\ModVault\\Library')
    expect(s.undoGraceMs).toBe(5000)
  })

  it('脏模板表回落默认，libraryDir 等其它键不受影响（R-4 判据）', () => {
    const s = normalizeSettings({
      libraryDir: 'D:\\Lib',
      projectTemplates: '整张表都坏了'
    } as unknown as Parameters<typeof normalizeSettings>[0])
    expect(s.projectTemplates).toEqual(DEFAULT_PROJECT_TEMPLATES)
    expect(s.libraryDir).toBe('D:\\Lib')
  })

  it('合法模板表写档前再归一化一遍（幂等），钉选 / 底纹同收口', () => {
    const s = normalizeSettings({
      libraryDir: 'D:\\Lib',
      projectTemplates: [{ id: 'u-1', name: '自建', root: { name: '根' } }],
      homePinnedFolders: [{ id: 'p1', name: '常用', absPath: 'D:\\常用' }],
      homeFolderWallpaper: { 'kind:model': 'abc.jpg', 'pin:p1': 'def.png' }
    } as unknown as Parameters<typeof normalizeSettings>[0])
    expect(s.projectTemplates.map((t) => t.id)).toEqual(['u-1'])
    expect(s.homePinnedFolders).toEqual([{ id: 'p1', name: '常用', absPath: 'D:\\常用' }])
    expect(s.homeFolderWallpaper).toEqual({ 'kind:model': 'abc.jpg', 'pin:p1': 'def.png' })
  })
})

describe('normalizeHomePinnedFolders — 钉选归一化（docs/60 §6.1 ④）', () => {
  const valid = { id: 'p1', name: '常用素材', absPath: 'D:\\素材库' }

  it('合法条目保序通过', () => {
    expect(normalizeHomePinnedFolders([valid])).toEqual([valid])
  })

  it('脏类型逐条丢弃：非对象 / 缺 id / 缺 name / 缺 absPath', () => {
    expect(normalizeHomePinnedFolders('表')).toEqual([])
    expect(normalizeHomePinnedFolders(null)).toEqual([])
    expect(
      normalizeHomePinnedFolders([
        null,
        '垃圾',
        { name: '无id', absPath: 'D:\\x' },
        { id: 'p2', absPath: 'D:\\x' },
        { id: 'p3', name: '无path' },
        valid
      ])
    ).toEqual([valid])
  })

  it('absPath 非绝对路径丢弃（主进程 pinnedOpen 无法定位）', () => {
    expect(
      normalizeHomePinnedFolders([
        { id: 'p1', name: '相对', absPath: '素材库' },
        { id: 'p2', name: '空', absPath: '' },
        valid
      ])
    ).toEqual([valid])
  })

  it('同 absPath 去重（保留先出现的那条）', () => {
    const out = normalizeHomePinnedFolders([
      valid,
      { id: 'p2', name: '重复路径', absPath: 'D:\\素材库' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p1')
  })

  it(`条数 ${MAX_HOME_PINNED_FOLDERS} 封顶，保序截断`, () => {
    const list = Array.from({ length: MAX_HOME_PINNED_FOLDERS + 5 }, (_, i) => ({
      id: `p${i + 1}`,
      name: `钉${i + 1}`,
      absPath: `D:\\dir${i + 1}`
    }))
    const out = normalizeHomePinnedFolders(list)
    expect(out).toHaveLength(MAX_HOME_PINNED_FOLDERS)
    expect(out[MAX_HOME_PINNED_FOLDERS - 1].id).toBe(`p${MAX_HOME_PINNED_FOLDERS}`)
  })
})

describe('normalizeHomeFolderWallpaper — 底纹归一化（docs/60 §6.3 ④）', () => {
  it('kind: / pin: 两个命名空间的合法键通过', () => {
    expect(
      normalizeHomeFolderWallpaper({ 'kind:model': 'a.jpg', 'pin:p1': 'b.png' })
    ).toEqual({ 'kind:model': 'a.jpg', 'pin:p1': 'b.png' })
  })

  it('未知命名空间键丢弃（防手改档写任意键）', () => {
    expect(
      normalizeHomeFolderWallpaper({
        'kind:model': 'a.jpg',
        'asset:xyz': 'bad.jpg',
        'folder:D:\\x': 'bad2.jpg',
        model: 'bad3.jpg',
        'kind:': 'bad4.jpg'
      })
    ).toEqual({ 'kind:model': 'a.jpg' })
  })

  it('fileName 非字符串 / trim 后为空丢弃', () => {
    expect(
      normalizeHomeFolderWallpaper({
        'kind:model': 'a.jpg',
        'kind:texture': '',
        'kind:hdri': '   ',
        'pin:p1': 42
      })
    ).toEqual({ 'kind:model': 'a.jpg' })
  })

  it('非对象 → 空映射（全部回落默认底纹）', () => {
    expect(normalizeHomeFolderWallpaper(null)).toEqual({})
    expect(normalizeHomeFolderWallpaper('map')).toEqual({})
    expect(normalizeHomeFolderWallpaper(['a'])).toEqual({})
  })

  it(`键数 ${MAX_HOME_FOLDER_WALLPAPER_KEYS} 封顶`, () => {
    const map: Record<string, string> = {}
    for (let i = 0; i < MAX_HOME_FOLDER_WALLPAPER_KEYS + 5; i++) {
      map[`pin:p${i + 1}`] = `f${i + 1}.jpg`
    }
    const out = normalizeHomeFolderWallpaper(map)
    expect(Object.keys(out)).toHaveLength(MAX_HOME_FOLDER_WALLPAPER_KEYS)
  })
})
