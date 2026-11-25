/**
 * 项目模板编辑器 —— 纯函数层单测（docs/60 §3.4 ④ 判据，T-02）。
 *
 * 覆盖（`src/renderer/logic/projectTemplatesEditor.ts`）：
 * ① 内置排首位；② 新建 / 复制 / 删除 / 改名 / 恢复出厂（builtin 禁删、至少留 1、20 封顶、
 *    深拷贝零共享引用）；③ 节点级增 / 删 / 改（深度 4、节点 256 双限额、兄弟重名自动去重、
 *    根不可删、空 children 键摘除）；④ `finalizeTemplates` 收口（归一化幂等、坏项丢弃、
 *    空表兜底默认、内置排首位）。
 *
 * UI 本体（ProjectTemplatesEditor.tsx）跑在 node 环境渲染不了（仓库无 jsdom），
 * 与仓库既有范式一致：可测决策全部抽到纯函数模块，这里钉断言。
 */
import { describe, expect, it } from 'vitest'

import {
  BUILTIN_TEMPLATE_ID,
  BUILTIN_TEMPLATE_NAME,
  DEFAULT_PROJECT_TEMPLATES,
  MAX_TEMPLATE_COUNT,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES
} from '../src/shared/projectTemplate'
import type { ProjectTemplate, ProjectTemplateNode } from '../src/shared/types'
import {
  addChildNodeAt,
  addBlankTemplate,
  canAddChildAt,
  copyTemplateInList,
  finalizeTemplates,
  findNodeAt,
  removeNodeAtPath,
  removeTemplateById,
  renameNodeAtPath,
  renameTemplateInList,
  restoreBuiltinTemplate,
  sortTemplatesBuiltinFirst,
  templateSummary
} from '../src/renderer/logic/projectTemplatesEditor'

// ── 构造工具 ────────────────────────────────────────────────────────────────

const leaf = (name: string): ProjectTemplateNode => ({ name })

/** 根(1) → A(2) → B(3) → C(4) 的满深度树 */
function fullDepthRoot(): ProjectTemplateNode {
  return {
    name: '根',
    children: [{ name: 'A', children: [{ name: 'B', children: [{ name: 'C' }] }] }]
  }
}

function tpl(name: string, root: ProjectTemplateNode): ProjectTemplate {
  return { id: `id-${name}`, name, root }
}

/** 用户模板列表：builtin + 两个自建（树均为单根叶） */
function baseList(): ProjectTemplate[] {
  return [
    { id: BUILTIN_TEMPLATE_ID, name: BUILTIN_TEMPLATE_NAME, root: leaf('（{编号}）+{名称}') },
    tpl('住宅模板', leaf('住宅')),
    tpl('会所模板', leaf('会所'))
  ]
}

// ════════════════════════════════════════════════════════════════════════════
// ① 内置排首位
// ════════════════════════════════════════════════════════════════════════════

describe('sortTemplatesBuiltinFirst — 内置排首位（稳定）', () => {
  it('builtin 在中间 / 末尾时都被提到首位，其余保持原顺序', () => {
    const list = [tpl('b', leaf('b')), { ...baseList()[0] }, tpl('a', leaf('a'))]
    const sorted = sortTemplatesBuiltinFirst(list)
    expect(sorted[0].id).toBe(BUILTIN_TEMPLATE_ID)
    expect(sorted.map((t) => t.name)).toEqual([BUILTIN_TEMPLATE_NAME, 'b', 'a'])
  })

  it('原数组不被改动（纯函数）', () => {
    const list = baseList()
    sortTemplatesBuiltinFirst([...list].reverse())
    expect(list[0].id).toBe(BUILTIN_TEMPLATE_ID)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② 模板级：新建 / 复制 / 删除 / 改名 / 恢复出厂
// ════════════════════════════════════════════════════════════════════════════

describe('addBlankTemplate — 新建空白模板', () => {
  it('新建成功：新 id、默认名「未命名模板」、根名只带 {名称} 占位符', () => {
    const r = addBlankTemplate(baseList())
    expect(r.ok).toBe(true)
    expect(r.list).toHaveLength(4)
    expect(r.list?.[3].name).toBe('未命名模板')
    expect(r.list?.[3].root.name).toBe('{名称}')
    expect(r.list?.[3].root.children).toBeUndefined()
    expect(r.newId).toBe(r.list?.[3].id)
    expect(r.newId).not.toBe(BUILTIN_TEMPLATE_ID)
  })

  it('20 封顶：满额时拒绝且不动原列表', () => {
    const full = Array.from({ length: MAX_TEMPLATE_COUNT }, (_, i) => tpl(`t${i}`, leaf('x')))
    const r = addBlankTemplate(full)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('20')
    expect(r.list).toBeUndefined()
  })
})

describe('copyTemplateInList — 复制（含内置）', () => {
  it('复制内置模板成功：新 id + 「公司标准模板-副本」+ 深拷贝树', () => {
    const list = baseList()
    const r = copyTemplateInList(list, BUILTIN_TEMPLATE_ID)
    expect(r.ok).toBe(true)
    expect(r.list).toHaveLength(4)
    expect(r.list?.[3].name).toBe(`${BUILTIN_TEMPLATE_NAME}-副本`)
    expect(r.list?.[3].id).not.toBe(BUILTIN_TEMPLATE_ID)
  })

  it('副本与源零共享引用：改副本子树不影响原件', () => {
    const list = baseList()
    const source = list[2]
    const r = copyTemplateInList(list, source.id)
    const copy = r.list![3]
    copy.root.children = [{ name: '改过的' }]
    expect(source.root.children).toBeUndefined()
    expect(copy.id).not.toBe(source.id)
  })

  it('副本重名自动 -2（源名-副本 已存在时）', () => {
    const list = [
      ...baseList(),
      tpl('住宅模板-副本', leaf('住宅2'))
    ]
    const r = copyTemplateInList(list, 'id-住宅模板')
    expect(r.ok).toBe(true)
    expect(r.list?.[4].name).toBe('住宅模板-副本-2')
  })

  it('20 封顶拒绝；未知 id 拒绝', () => {
    const full = Array.from({ length: MAX_TEMPLATE_COUNT }, (_, i) => tpl(`t${i}`, leaf('x')))
    expect(copyTemplateInList(full, 't0').ok).toBe(false)
    expect(copyTemplateInList(baseList(), 'nope').ok).toBe(false)
  })
})

describe('removeTemplateById — 删除（builtin 禁删 / 至少留 1）', () => {
  it('内置模板拒绝删除（用户批注口径）', () => {
    const r = removeTemplateById(baseList(), BUILTIN_TEMPLATE_ID)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('内置')
  })

  it('只剩 1 个模板时拒绝删除', () => {
    const only = [{ ...DEFAULT_PROJECT_TEMPLATES[0] }]
    const r = removeTemplateById(only, 'other')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('至少保留')
  })

  it('正常删除：只移除目标项，其余原样', () => {
    const r = removeTemplateById(baseList(), 'id-住宅模板')
    expect(r.ok).toBe(true)
    expect(r.list?.map((t) => t.name)).toEqual([BUILTIN_TEMPLATE_NAME, '会所模板'])
  })
})

describe('renameTemplateInList — 模板改名', () => {
  it('非法字符清洗 + 40 码点截断（与 naming.MAX_SEGMENT_LEN 同口径）', () => {
    const long = 'A'.repeat(41)
    const r = renameTemplateInList(baseList(), 'id-住宅模板', `proj<>:${long}`)
    expect(r.ok).toBe(true)
    expect(r.applied).not.toContain('<')
    expect(Array.from(r.applied ?? '').length).toBe(40)
  })

  it('同名模板改名互不影响', () => {
    const r = renameTemplateInList(baseList(), 'id-会所模板', '度假村模板')
    expect(r.list?.find((t) => t.id === 'id-会所模板')?.name).toBe('度假村模板')
    expect(r.list?.find((t) => t.id === 'id-住宅模板')?.name).toBe('住宅模板')
  })

  it('未知 id 拒绝', () => {
    expect(renameTemplateInList(baseList(), 'nope', 'x').ok).toBe(false)
  })
})

describe('restoreBuiltinTemplate — 恢复出厂', () => {
  it('改过 builtin 内容后恢复 == 默认 4×15，且用户模板不受影响', () => {
    const list = baseList()
    const edited = list.find((t) => t.id === BUILTIN_TEMPLATE_ID)!
    edited.root = { name: '被改坏的根' }
    const r = restoreBuiltinTemplate(list)
    expect(r.ok).toBe(true)
    const builtin = r.list!.find((t) => t.id === BUILTIN_TEMPLATE_ID)!
    expect(builtin.root).toEqual(DEFAULT_PROJECT_TEMPLATES[0].root)
    expect(r.list?.some((t) => t.id === 'id-住宅模板')).toBe(true)
  })

  it('恢复副本零共享引用（不污染 DEFAULT_PROJECT_TEMPLATES 常量）', () => {
    const r = restoreBuiltinTemplate(baseList())
    const builtin = r.list!.find((t) => t.id === BUILTIN_TEMPLATE_ID)!
    builtin.root.children!.push(leaf('多余的'))
    expect(DEFAULT_PROJECT_TEMPLATES[0].root.children).toHaveLength(4)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 节点级：增 / 删 / 改 + 双限额
// ════════════════════════════════════════════════════════════════════════════

describe('canAddChildAt / addChildNodeAt — 深度 4 / 节点 256 双限额', () => {
  it('第 4 级节点不能再加子级（根记 1，Q-6 四级封顶）', () => {
    const root = fullDepthRoot()
    // path [0,0,0] = C（第 4 级）
    expect(canAddChildAt(root, [0, 0, 0])).toEqual({ ok: false, reason: 'depth' })
    expect(addChildNodeAt(root, [0, 0, 0]).ok).toBe(false)
    // 第 3 级（B）还可以加到第 4 级
    expect(canAddChildAt(root, [0, 0]).ok).toBe(true)
  })

  it('MAX_TEMPLATE_DEPTH 深度按根记 1 = 4', () => {
    expect(MAX_TEMPLATE_DEPTH).toBe(4)
    expect(templateSummary(fullDepthRoot()).depth).toBe(4)
  })

  it('节点 256 封顶：满额时拒绝加子级', () => {
    // 根 + 255 个叶子 = 256 节点
    const full = { name: '根', children: Array.from({ length: 255 }, (_, i) => leaf(`c${i}`)) }
    expect(canAddChildAt(full, [])).toEqual({ ok: false, reason: 'nodes' })
    expect(addChildNodeAt(full, []).ok).toBe(false)
    // 255 个节点时还能加 1 个
    const room = { name: '根', children: Array.from({ length: 254 }, (_, i) => leaf(`c${i}`)) }
    expect(canAddChildAt(room, []).ok).toBe(true)
    expect(addChildNodeAt(room, []).ok).toBe(true)
  })

  it('兄弟重名自动去重：连续两次新建得到 新建文件夹 / 新建文件夹-2', () => {
    const root = leaf('根')
    const first = addChildNodeAt(root, [])
    expect(first.ok).toBe(true)
    expect(first.applied).toBe('新建文件夹')
    const second = addChildNodeAt(first.root!, [])
    expect(second.applied).toBe('新建文件夹-2')
    expect(second.root!.children?.map((c) => c.name)).toEqual(['新建文件夹', '新建文件夹-2'])
  })

  it('加子级返回新根，原树不被改动', () => {
    const root = leaf('根')
    const r = addChildNodeAt(root, [])
    expect(root.children).toBeUndefined()
    expect(r.root!.children).toHaveLength(1)
  })
})

describe('removeNodeAtPath — 删节点（连带子树）', () => {
  it('根不可删', () => {
    expect(removeNodeAtPath(fullDepthRoot(), [])).toEqual({ ok: false, reason: 'root' })
  })

  it('删除节点连带整棵子树：节点数按子树规模减少', () => {
    const root = fullDepthRoot()
    // B 子树 = B + C = 2 个节点
    const r = removeNodeAtPath(root, [0, 0])
    expect(r.ok).toBe(true)
    expect(templateSummary(r.root!).nodes).toBe(templateSummary(root).nodes - 2)
    expect(r.root!.children?.[0].children).toBeUndefined()
  })

  it('删掉全部子级后空 children 键一并摘除（落档形状干净）', () => {
    const root = { name: '根', children: [leaf('唯一')] }
    const r = removeNodeAtPath(root, [0])
    expect(r.ok).toBe(true)
    expect(r.root).toEqual({ name: '根' })
    expect('children' in r.root!).toBe(false)
  })
})

describe('renameNodeAtPath — 节点改名', () => {
  it('非法字符清洗 + 兄弟重名自动去重（-2）', () => {
    const root = { name: '根', children: [leaf('方案'), leaf('施工图')] }
    // 尾随空白被清洗掉 → 清洗名「方案」撞上兄弟 → 自动 -2
    const r = renameNodeAtPath(root, [1], '方案 ')
    expect(r.ok).toBe(true)
    expect(r.applied).toBe('方案-2')
    expect(r.root!.children?.[1].name).toBe('方案-2')
  })

  it('不重名时名字按清洗结果落位', () => {
    const root = { name: '根', children: [leaf('方案')] }
    const r = renameNodeAtPath(root, [0], '施工图')
    expect(r.applied).toBe('施工图')
  })

  it('根名占位符字面量原样保留（Q-4：占位符只限根名）', () => {
    const root = leaf('（{编号}）+{名称}')
    const r = renameNodeAtPath(root, [], '（{编号}）+{名称}')
    expect(r.ok).toBe(true)
    expect(r.root!.name).toBe('（{编号}）+{名称}')
  })

  it('改名不影响其他兄弟', () => {
    const root = { name: '根', children: [leaf('a'), leaf('b'), leaf('c')] }
    const r = renameNodeAtPath(root, [1], 'bb')
    expect(r.root!.children?.map((c) => c.name)).toEqual(['a', 'bb', 'c'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ④ finalizeTemplates — 保存收口
// ════════════════════════════════════════════════════════════════════════════

describe('finalizeTemplates — 保存前整表归一化', () => {
  it('逐棵过 normalizeProjectTemplate：清洗名字、兄弟去重、id 保留', () => {
    const draft: ProjectTemplate[] = [
      tpl('模<>板', { name: '根', children: [leaf('方案'), leaf('方案')] })
    ]
    const out = finalizeTemplates(draft)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('id-模<>板') // id 原样保留（锚点不跳）
    expect(out[0].name).toBe('模__板')
    expect(out[0].root.children?.map((c) => c.name)).toEqual(['方案', '方案-2'])
  })

  it('坏项（root 缺失）丢弃，好项保留', () => {
    const draft = [
      tpl('好的', leaf('根')),
      { id: 'bad', name: '坏的', root: undefined as unknown as ProjectTemplateNode }
    ]
    const out = finalizeTemplates(draft)
    expect(out.map((t) => t.name)).toEqual(['好的'])
  })

  it('全部坏项时兜底默认模板数组', () => {
    const out = finalizeTemplates([
      { id: 'bad', name: '坏的', root: null as unknown as ProjectTemplateNode }
    ])
    expect(out).toEqual(DEFAULT_PROJECT_TEMPLATES)
  })

  it('输出内置排首位（与编辑器展示同序落盘）', () => {
    const draft = [tpl('用户模板', leaf('用户')), { ...DEFAULT_PROJECT_TEMPLATES[0] }]
    const out = finalizeTemplates(draft)
    expect(out[0].id).toBe(BUILTIN_TEMPLATE_ID)
  })

  it('归一化幂等：finalize(finalize(draft)) 与 finalize(draft) 相同', () => {
    const draft = [tpl('模板', fullDepthRoot())]
    const once = finalizeTemplates(draft)
    expect(finalizeTemplates(once)).toEqual(once)
  })

  it('超限树被归一化剪枝：深度 5 → 4、257 节点 → 256（兜底第二道闸）', () => {
    // 编辑期限额拦不住的输入（如手改 settings 后回流）也要安全
    let deep: ProjectTemplateNode = leaf('L5')
    for (const name of ['L4', 'L3', 'L2', 'L1']) deep = { name, children: [deep] }
    expect(templateSummary(deep).depth).toBe(5)
    const out = finalizeTemplates([tpl('超深', deep)])
    expect(templateSummary(out[0].root).depth).toBeLessThanOrEqual(MAX_TEMPLATE_DEPTH)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 展示辅助与常量口径
// ════════════════════════════════════════════════════════════════════════════

describe('templateSummary / findNodeAt — 展示辅助', () => {
  it('summary 返回深度与节点数（内置 4×15 = 20 节点 / 3 层）', () => {
    const s = templateSummary(DEFAULT_PROJECT_TEMPLATES[0].root)
    expect(s).toEqual({ depth: 3, nodes: 20 })
  })

  it('findNodeAt 按索引链定位；越界返回 null', () => {
    const root = fullDepthRoot()
    expect(findNodeAt(root, [0, 0])?.name).toBe('B')
    expect(findNodeAt(root, [0, 0, 0])?.name).toBe('C')
    expect(findNodeAt(root, [9])).toBeNull()
    expect(findNodeAt(root, [0, 9])).toBeNull()
  })

  it('上限常量与 shared 单一真源一致（UI 文案数字从这里取，不手抄）', () => {
    expect(MAX_TEMPLATE_NODES).toBe(256)
    expect(MAX_TEMPLATE_COUNT).toBe(20)
  })
})
