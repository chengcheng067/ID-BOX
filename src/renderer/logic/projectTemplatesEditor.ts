/**
 * 项目模板编辑器 —— 纯函数层（docs/60 §3，T-02）。
 *
 * ## 定位
 *
 * 设置页「项目文件夹模板」编辑器（`components/ProjectTemplatesEditor.tsx`）的**全部
 * 可测决策**都收在这份文件里：模板级操作（新建 / 复制 / 删除 / 改名 / 恢复出厂）与
 * 节点级操作（增子级 / 删子树 / 改名）都是纯函数，输入输出可直接单测
 * （`tests/projectTemplatesEditor.test.ts`）。组件只做状态搬运与渲染，不写第二套判定
 * —— 任何一处复制清洗 / 限额逻辑迟早漂移（`HEX_PATTERN` 迁 shared 的同一教训）。
 *
 * ## 硬约束（docs/60 §3.3，用户批注口径）
 *
 * 1. **内置模板 `id='builtin'` 不可删除**（UI 灰置 + 提示），但**内容可编辑**；
 *    「恢复出厂」只重置 builtin 那一项为 4×15，不动用户自建模板。
 * 2. 模板条数 ≤ `MAX_TEMPLATE_COUNT`(20)、树深度 ≤ `MAX_TEMPLATE_DEPTH`(4，根记 1)、
 *    总节点 ≤ `MAX_TEMPLATE_NODES`(256)、模板名 / 节点名 ≤ 40 码点。
 * 3. 限额判定**在编辑时就拦截**（UI 灰置按钮或给单行提示），保存时再过
 *    `normalizeProjectTemplate` 收口 —— 绝不静默丢用户数据。
 * 4. 兄弟重名在编辑期就按 `uniqueName` 自动去重（-2、-3…），并把最终名回传给
 *    UI 做展示反馈；保存时归一化的二次去重只是兜底。
 * 5. 零 IO / 零 electron 依赖：node 环境 vitest 可直接单测。
 */

import {
  BUILTIN_TEMPLATE_ID,
  MAX_TEMPLATE_COUNT,
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES,
  NAME_PLACEHOLDER,
  TEMPLATE_NAME_MAX_LEN,
  cloneDefaultTemplates,
  countTemplateNodes,
  newTemplateId,
  normalizeProjectTemplate,
  templateDepth
} from '../../shared/projectTemplate'
import { MAX_SEGMENT_LEN, sanitizeName, uniqueName } from '../../shared/naming'
import type { ProjectTemplate, ProjectTemplateNode } from '../../shared/types'

// ── 结果形状（UI 只认这些字段，不各自再发明一套） ────────────────────────────

/** 节点操作被拒的原因：`depth`=到深度顶 / `nodes`=到节点顶 / `missing`=路径失效 / `root`=根不可删 */
export type NodeLimitReason = 'depth' | 'nodes' | 'missing' | 'root'

/** 模板级操作结果（新建 / 复制回传 `newId` 供 UI 选中） */
export interface ListOpResult {
  ok: boolean
  list?: ProjectTemplate[]
  error?: string
  newId?: string
  applied?: string
}

/** 节点级操作结果（成功回传新根与最终名，供 UI 做重名反馈） */
export interface NodeOpResult {
  ok: boolean
  root?: ProjectTemplateNode
  reason?: NodeLimitReason
  applied?: string
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 按码点截断（`String.slice` 会割开 emoji 代理对，naming.ts / projectTemplate.ts 同款纪律） */
function truncateByCodePoint(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return chars.slice(0, max).join('')
}

/** 树的深拷贝（≤256 节点，JSON 往返足够；不共享任何引用） */
function deepCloneNode(root: ProjectTemplateNode): ProjectTemplateNode {
  return JSON.parse(JSON.stringify(root)) as ProjectTemplateNode
}

/** 按子级索引链定位节点（`[]` = 根；越界 / 缺 children 返回 null） */
export function findNodeAt(
  root: ProjectTemplateNode,
  path: number[]
): ProjectTemplateNode | null {
  let node: ProjectTemplateNode | null = root
  for (const idx of path) {
    const children: ProjectTemplateNode[] | undefined = node?.children
    if (!children || !Number.isInteger(idx) || idx < 0 || idx >= children.length) return null
    node = children[idx]
  }
  return node
}

// ── 模板级操作 ─────────────────────────────────────────────────────────────

/**
 * 内置模板排首位（稳定：其余保持原顺序）。
 *
 * 归一化 / 打包都不改数组序，这里的排序**只影响编辑器展示**：设置页约定内置排首位，
 * 但 settings.json 里的落盘顺序由归一化结果决定 —— 保存时也走同一函数，展示与落盘同序。
 */
export function sortTemplatesBuiltinFirst(templates: ProjectTemplate[]): ProjectTemplate[] {
  const head = templates.filter((t) => t.id === BUILTIN_TEMPLATE_ID)
  const rest = templates.filter((t) => t.id !== BUILTIN_TEMPLATE_ID)
  return [...head, ...rest]
}

/** 新建空白模板的形状：界面名「未命名模板」，根名默认只带 `{名称}` 占位符（编号可留空，Q-3） */
export function blankTemplate(): ProjectTemplate {
  return { id: newTemplateId(), name: '未命名模板', root: { name: NAME_PLACEHOLDER } }
}

/** 新建空白模板：条数 20 封顶，超出拒绝（UI 同时灰置按钮，不静默丢） */
export function addBlankTemplate(list: ProjectTemplate[]): ListOpResult {
  if (list.length >= MAX_TEMPLATE_COUNT) {
    return { ok: false, error: `模板已达上限 ${MAX_TEMPLATE_COUNT} 个，请先删除不用的模板` }
  }
  const tpl = blankTemplate()
  return { ok: true, list: [...list, tpl], newId: tpl.id }
}

/**
 * 复制现有模板（含内置）：新 id + 深拷贝的树 + 「源名-副本」（重名自动 -2）。
 *
 * ⚠️ 拷贝必须与源**零共享引用**：编辑副本不能改动原件（JSON 往返深拷贝）。
 */
export function copyTemplateInList(list: ProjectTemplate[], id: string): ListOpResult {
  const source = list.find((t) => t.id === id)
  if (!source) return { ok: false, error: '未找到要复制的模板' }
  if (list.length >= MAX_TEMPLATE_COUNT) {
    return { ok: false, error: `模板已达上限 ${MAX_TEMPLATE_COUNT} 个，请先删除不用的模板` }
  }
  const taken = new Set(list.map((t) => t.name))
  const base = truncateByCodePoint(sanitizeName(`${source.name}-副本`), TEMPLATE_NAME_MAX_LEN)
  const copy: ProjectTemplate = {
    id: newTemplateId(),
    name: uniqueName(base, taken),
    root: deepCloneNode(source.root)
  }
  return { ok: true, list: [...list, copy], newId: copy.id }
}

/** 删除模板：内置禁删（用户批注口径）；至少保留 1 个模板 */
export function removeTemplateById(list: ProjectTemplate[], id: string): ListOpResult {
  if (id === BUILTIN_TEMPLATE_ID) return { ok: false, error: '内置模板不能删除' }
  if (list.length <= 1) return { ok: false, error: '至少保留一个模板' }
  const next = list.filter((t) => t.id !== id)
  if (next.length === list.length) return { ok: false, error: '未找到要删除的模板' }
  return { ok: true, list: next }
}

/** 模板改名：过 `sanitizeName` + 40 码点截断（与归一化同一口径；清洗后不会为空，兜底「未命名」） */
export function renameTemplateInList(
  list: ProjectTemplate[],
  id: string,
  rawName: string
): ListOpResult {
  if (!list.some((t) => t.id === id)) return { ok: false, error: '未找到要改名的模板' }
  const cleaned = truncateByCodePoint(sanitizeName(String(rawName ?? '')), TEMPLATE_NAME_MAX_LEN)
  if (!cleaned) return { ok: false, error: '模板名不能为空' }
  return {
    ok: true,
    list: list.map((t) => (t.id === id ? { ...t, name: cleaned } : t)),
    applied: cleaned
  }
}

/**
 * 「恢复出厂模板」：把 builtin 那一项重置为默认 4×15（深拷贝，零共享引用），
 * **不动用户自建模板**；builtin 意外缺失（脏档）时按「内置排首位」补回。
 */
export function restoreBuiltinTemplate(list: ProjectTemplate[]): ListOpResult {
  const factory = cloneDefaultTemplates()[0]
  const at = list.findIndex((t) => t.id === BUILTIN_TEMPLATE_ID)
  if (at < 0) return { ok: true, list: sortTemplatesBuiltinFirst([factory, ...list]) }
  const next = [...list]
  next[at] = factory
  return { ok: true, list: next }
}

// ── 节点级操作（path = 子级索引链，[] = 根） ────────────────────────────────

/**
 * 该位置还能不能加子级（编辑期判定，UI 据此灰置「＋子级」按钮）：
 * 深度：节点深度 + 1 ≤ `MAX_TEMPLATE_DEPTH`（根记 1，Q-6 四级封顶）；
 * 节点：整棵树 < `MAX_TEMPLATE_NODES`（含根，256 封顶）。
 */
export function canAddChildAt(
  root: ProjectTemplateNode,
  path: number[]
): { ok: boolean; reason?: NodeLimitReason } {
  if (!nodeExists(root, path)) return { ok: false, reason: 'missing' }
  const depth = path.length + 1
  if (depth + 1 > MAX_TEMPLATE_DEPTH) return { ok: false, reason: 'depth' }
  if (countTemplateNodes(root) >= MAX_TEMPLATE_NODES) return { ok: false, reason: 'nodes' }
  return { ok: true }
}

function nodeExists(root: ProjectTemplateNode, path: number[]): boolean {
  return findNodeAt(root, path) !== null
}

/** 加一个子级（默认名「新建文件夹」，兄弟重名自动 -2）；限额被拒时不动树、带回原因 */
export function addChildNodeAt(root: ProjectTemplateNode, path: number[]): NodeOpResult {
  const check = canAddChildAt(root, path)
  if (!check.ok) return { ok: false, reason: check.reason }
  const next = deepCloneNode(root)
  const parent = findNodeAt(next, path)
  if (!parent) return { ok: false, reason: 'missing' }
  const taken = new Set((parent.children ?? []).map((c) => c.name))
  const name = uniqueName('新建文件夹', taken)
  parent.children = [...(parent.children ?? []), { name }]
  return { ok: true, root: next, applied: name }
}

/**
 * 删除节点（**连带整棵子树**，确认弹窗的数字由 UI 用 `findNodeAt` + `countTemplateNodes` 算）。
 * 根不可删（path = [] 拒绝）；删除后父节点空 children 键一并摘掉（落档形状干净，与归一化一致）。
 */
export function removeNodeAtPath(root: ProjectTemplateNode, path: number[]): NodeOpResult {
  if (path.length === 0) return { ok: false, reason: 'root' }
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  const parent = findNodeAt(root, parentPath)
  if (!parent?.children || !Number.isInteger(idx) || idx < 0 || idx >= parent.children.length) {
    return { ok: false, reason: 'missing' }
  }
  const next = deepCloneNode(root)
  const nextParent = findNodeAt(next, parentPath)
  if (!nextParent?.children) return { ok: false, reason: 'missing' }
  nextParent.children = nextParent.children.filter((_, i) => i !== idx)
  if (nextParent.children.length === 0) delete nextParent.children
  return { ok: true, root: next }
}

/**
 * 节点改名（根也走这里）：`sanitizeName` 清洗 + 40 码点截断；根名占位符
 * `{编号}` / `{名称}` 不在非法字符表内，**原样保留**（与归一化判据⑦同一口径）。
 * 非根节点做**兄弟重名自动去重**（-2、-3…），最终名回传 `applied` 供 UI 反馈。
 */
export function renameNodeAtPath(
  root: ProjectTemplateNode,
  path: number[],
  rawName: string
): NodeOpResult {
  if (!nodeExists(root, path)) return { ok: false, reason: 'missing' }
  const cleaned = truncateByCodePoint(sanitizeName(String(rawName ?? '')), MAX_SEGMENT_LEN)
  if (path.length === 0) {
    return { ok: true, root: { ...root, name: cleaned }, applied: cleaned }
  }
  const parentPath = path.slice(0, -1)
  const siblings = findNodeAt(root, parentPath)?.children ?? []
  const taken = new Set(
    siblings.filter((_, i) => i !== path[path.length - 1]).map((c) => c.name)
  )
  const finalName = uniqueName(cleaned, taken)
  const next = deepCloneNode(root)
  const target = findNodeAt(next, path)
  if (!target) return { ok: false, reason: 'missing' }
  target.name = finalName
  return { ok: true, root: next, applied: finalName }
}

// ── 保存收口 ───────────────────────────────────────────────────────────────

/**
 * 草稿 → 可落盘整表：逐棵过 `normalizeProjectTemplate`（清洗 / 剪枝 / 去重 / 256 上限，
 * **永不抛错**），坏项丢弃；全坏兜底默认模板数组；内置排首位（与展示同序）。
 *
 * id 在归一化里原样保留 → 保存后选中态不跳。正常路径下草稿已被编辑期限额拦住，
 * 这里是第二道闸（主进程 normalizeSettings 还有第三道，docs/60 §2.3 三处同一实现）。
 */
export function finalizeTemplates(draft: ProjectTemplate[]): ProjectTemplate[] {
  const out: ProjectTemplate[] = []
  for (const t of draft) {
    const normalized = normalizeProjectTemplate(t)
    if (normalized) out.push(normalized)
  }
  if (out.length === 0) return cloneDefaultTemplates()
  return sortTemplatesBuiltinFirst(out)
}

// ── 展示辅助 ───────────────────────────────────────────────────────────────

/** 选中模板的度量摘要（UI 统计行 / 删除确认弹窗共用同一口径） */
export function templateSummary(root: ProjectTemplateNode): { depth: number; nodes: number } {
  return { depth: templateDepth(root), nodes: countTemplateNodes(root) }
}
