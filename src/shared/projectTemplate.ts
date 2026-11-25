/**
 * 项目文件夹模板 —— 类型守卫外的**纯函数层**（docs/60 §2，T-01 数据层地基）。
 *
 * ## 定位
 *
 * 多模板（`Settings.projectTemplates: ProjectTemplate[]`）的默认值、归一化与根名
 * 解析**只写在这一份文件里**：主进程 `settings.ts`（读档/写档收口）、T-03 的
 * `projectCreate.ts`（W6 主进程加固重跑归一化）、T-02 的编辑 UI（树校验）全部复用，
 * 任何一处都不许复制清洗逻辑 —— 抄一份迟早漂移（`HEX_PATTERN` 迁入 shared 的同一教训）。
 *
 * ## 硬约束（docs/60 §2.3 / §2.4，已批注口径）
 *
 * 1. **零 IO / 零 electron 依赖**：本文件不读盘、不写盘、不 import 任何 `node:` / `electron`
 *    模块，node 环境 vitest 可直接单测，渲染层（T-02 编辑器 / T-03 向导）也可安全引用。
 * 2. 树**深度 4 级封顶**（根 + 3 层子级，Q-6）、**总节点 256 上限**、**单名 ≤40 字**
 *    （对齐 `naming.ts` 的 `MAX_SEGMENT_LEN`）、兄弟重名去重、节点名 `sanitizeName` 清洗。
 * 3. 根名占位符 `{编号}` / `{名称}` **只支持根目录名**（Q-4）：子目录名是纯字面量，
 *    归一化**原样保留**占位符字面量（`sanitizeName` 不清洗 `{}` / `（）` / `+`）。
 * 4. 归一化**永不抛错**：脏项丢弃 / 剪枝 / 截断 / 回落默认，绝不拖垮整份 settings.json
 *    （`gridDensity` / `trashRetention` 踩过的单项降级纪律）。
 */

import { MAX_SEGMENT_LEN, sanitizeName, uniqueName } from './naming'
import type { ProjectTemplate, ProjectTemplateNode } from './types'

// ── 常量（上限口径的唯一真源，UI / 主进程 / 测试都从这里取） ────────────────────

/** 内置模板的固定 id（打包 / 向导 / 设置页都用它当锚点，不生成、不改变） */
export const BUILTIN_TEMPLATE_ID = 'builtin'

/** 内置模板的界面名（不落盘语义：随 settings.json 落档，仅作展示） */
export const BUILTIN_TEMPLATE_NAME = '公司标准模板'

/**
 * 内置模板根名模式：占位符**只出现在根目录名**（Q-4）。
 * `编号已填 → 替换占位符；编号留空 → 直接 sanitizeName(名称)`（Q-3 两分支，见 `resolveRootName`）。
 */
export const ROOT_NAME_PATTERN = '（{编号}）+{名称}'

/** 根名占位符：项目编号（建议填写但允许跳过，Q-3） */
export const CODE_PLACEHOLDER = '{编号}'

/** 根名占位符：项目名称（必填） */
export const NAME_PLACEHOLDER = '{名称}'

/** 树深度上限（Q-6 用户批注：4 级封顶 = 根 + 3 层子级；内置默认模板仍是两级） */
export const MAX_TEMPLATE_DEPTH = 4

/** 整棵树总节点上限（含根；超出在归一化里静默截断，docs/60 §2.3 合理性复核） */
export const MAX_TEMPLATE_NODES = 256

/** 模板条数上限（防设置膨胀；超出时新建 / 复制入口禁用，归一化截断） */
export const MAX_TEMPLATE_COUNT = 20

/** 模板界面名上限（与目录名同口径，对齐 naming.ts 的 MAX_SEGMENT_LEN = 40） */
export const TEMPLATE_NAME_MAX_LEN = MAX_SEGMENT_LEN

// ── 内置默认模板（用户实测抄录的 4×15 两级树，逐字真源，单测硬编码比对） ────────

/**
 * 默认模板数组：**只含内置 4×15 一项**（docs/60 §2.3）。
 *
 * ⚠️ 逐字真源：4 个一级 + 15 个二级的**每个字**都有单测硬编码比对
 * （`tests/projectTemplate.test.ts`）防手滑改词表 —— 改这里必须同时改测试，
 * 且只允许用户拍板才改。
 *
 * `DEFAULT_SETTINGS` 引用本常量（旧档缺键回落到这里 = 升级零迁移）。
 * 类型循环注意：本文件对 `./types` 只有 `import type`（编译期擦除），
 * `types.ts` 对本文件是值导入 —— 运行时无环。
 */
export const DEFAULT_PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: BUILTIN_TEMPLATE_ID,
    name: BUILTIN_TEMPLATE_NAME,
    root: {
      name: ROOT_NAME_PATTERN,
      children: [
        {
          name: '1-工作资料',
          children: [
            { name: '1.1-设计资料' },
            { name: '1.2-专业资料' },
            { name: '1.3-供应商资料' },
            { name: '1.4-现场过程照片' }
          ]
        },
        {
          name: '2-工作文件',
          children: [
            { name: '2.1-方案' },
            { name: '2.2-施工图' },
            { name: '2.3-软装' },
            { name: '2.4-模型文件' },
            { name: '2.5-渲染文件' },
            { name: '2.6-成果文件' }
          ]
        },
        {
          name: '3-协调文件',
          children: [
            { name: '3.1-收文件' },
            { name: '3.2-发文件' },
            { name: '3.3-管理文件' }
          ]
        },
        {
          name: '4-归档文件',
          children: [
            { name: '4.1-施工图' },
            { name: '4.2-完工照片' }
          ]
        }
      ]
    }
  }
]

/**
 * 深拷贝默认模板数组（新副本，与常量零共享引用）。
 *
 * `normalizeProjectTemplates` 回落默认时用它：调用方（如设置页编辑器）拿到手改
 * 不会污染 `DEFAULT_PROJECT_TEMPLATES` 常量本体（改坏常量 = 所有回落路径跟着坏）。
 */
export function cloneDefaultTemplates(): ProjectTemplate[] {
  return JSON.parse(JSON.stringify(DEFAULT_PROJECT_TEMPLATES)) as ProjectTemplate[]
}

// ── 小工具（纯函数） ────────────────────────────────────────────────────────

/** 宽松对象判定（数组不算：children 数组由调用方单独处理） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 按码点截断（`Array.from`，不能 `String.slice` —— 会割开 emoji 代理对，naming.ts 同款纪律） */
function truncateByCodePoint(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return chars.slice(0, max).join('')
}

// ── id 生成（"UUID 用现有生成方式 —— Asset.id 同款"，docs/60 §7.1 注） ─────────

let fallbackIdCounter = 0

/**
 * 模板 id 生成：优先 `crypto.randomUUID()`（主进程 `node:crypto` 与渲染层
 * `globalThis.crypto` 都有），无 crypto 环境（老 node / 极端测试环境）回落
 * `tpl-<时间36进制>-<计数>`，保证唯一性不依赖外部条件。
 */
export function newTemplateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  fallbackIdCounter += 1
  return `tpl-${Date.now().toString(36)}-${fallbackIdCounter}`
}

// ── 树的度量（纯函数，T-02 编辑 UI / T-03 加固判定共用） ───────────────────────

/**
 * 统计整棵树的节点数（**含根**）。内置 4×15 模板 = 1 + 4 + 15 = 20。
 */
export function countTemplateNodes(root: ProjectTemplateNode): number {
  let count = 1
  if (Array.isArray(root.children)) {
    for (const child of root.children) count += countTemplateNodes(child)
  }
  return count
}

/**
 * 树的最大深度（根记 1；上限见 `MAX_TEMPLATE_DEPTH` = 4，Q-6"根 + 3 层子级"）。
 *
 * ⚠️ docs/60 说内置模板是"两级"，指的是**根之下的内容层级**（4 个一级 + 15 个二级）；
 * 按节点深度计 = 根(1) + 一级(2) + 二级(3) = **3**。目录落盘深度同理（根目录 + 两层子目录）。
 */
export function templateDepth(root: ProjectTemplateNode): number {
  let max = 1
  if (Array.isArray(root.children)) {
    for (const child of root.children) max = Math.max(max, 1 + templateDepth(child))
  }
  return max
}

// ── 单棵树归一化 ────────────────────────────────────────────────────────────

/**
 * 递归归一化一个节点。
 *
 * `depth` 从 1（根）起计；`budget.left` 是剩余节点配额（含当前节点），
 * 配额耗尽后**静默剪掉**剩余兄弟与更深层级（256 上限，docs/60 §2.3）。
 *
 * 清洗顺序：`sanitizeName` → 码点截断 40 → 兄弟 `uniqueName` 去重。
 * 占位符字面量（`{编号}` / `{名称}`）不在 `ILLEGAL_RE` 内，`sanitizeName` 原样保留
 * —— 归一化不清洗占位符（docs/60 §2.3 判据⑦）。
 */
function normalizeNode(
  raw: unknown,
  depth: number,
  budget: { left: number }
): ProjectTemplateNode | null {
  if (!isPlainObject(raw)) return null
  // 节点必须有字符串名（缺失 / 非字符串 = 坏节点）：根坏 → 整棵丢弃，子节点坏 → 单独跳过。
  // 注意 `sanitizeName` 对空串的兜底是 `'未命名'`，不能用来吞掉"没有名"这种结构性坏数据。
  if (typeof raw.name !== 'string') return null
  if (depth > MAX_TEMPLATE_DEPTH || budget.left <= 0) return null

  const name = truncateByCodePoint(sanitizeName(raw.name), MAX_SEGMENT_LEN)
  budget.left -= 1

  // 深度已到顶：只保留本节点名，不再下钻（Q-6 剪枝）
  if (depth >= MAX_TEMPLATE_DEPTH) return { name }

  const rawChildren = Array.isArray(raw.children) ? raw.children : []
  if (rawChildren.length === 0) return { name }

  const taken = new Set<string>()
  const children: ProjectTemplateNode[] = []
  for (const childRaw of rawChildren) {
    if (budget.left <= 0) break
    const child = normalizeNode(childRaw, depth + 1, budget)
    if (!child) continue
    // 兄弟重名去重（uniqueName 语义：依次追加 -2、-3…，naming.ts:283）
    const unique = uniqueName(child.name, taken)
    child.name = unique
    taken.add(unique)
    children.push(child)
  }
  // 全部子节点无效 → 退化成叶子（不留空 children 数组，落档形状干净）
  if (children.length === 0) return { name }
  return { name, children }
}

/**
 * 单棵模板归一化（docs/60 §2.3）。
 *
 * - 非对象 / `root` 缺失或无效 → 返回 `null`（由 `normalizeProjectTemplates` 丢弃该"坏项"）；
 * - `id` 缺失 / 非字符串 / 空白 → 重新生成（`newTemplateId`）；
 * - 模板名过 `sanitizeName` + 40 字码点截断；清洗失败回落 `'未命名模板'`；
 * - 逐节点清洗 / 深度 4 剪枝 / 兄弟去重 / 256 节点截断（见 `normalizeNode`）。
 *
 * **永不抛错**；输出可安全落 settings.json / 过 IPC structured clone。
 */
export function normalizeProjectTemplate(raw: unknown): ProjectTemplate | null {
  if (!isPlainObject(raw)) return null
  const root = normalizeNode(raw.root, 1, { left: MAX_TEMPLATE_NODES })
  if (!root) return null
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  const rawName = typeof raw.name === 'string' ? raw.name : '未命名模板'
  return {
    id: rawId || newTemplateId(),
    name: truncateByCodePoint(sanitizeName(rawName), TEMPLATE_NAME_MAX_LEN) || '未命名模板',
    root
  }
}

// ── 整表归一化 ──────────────────────────────────────────────────────────────

/**
 * 模板整表归一化（docs/60 §2.3：`normalizeProjectTemplates(v: unknown)`）。
 *
 * - 非数组 / 全部坏项 / 空表 → **回落默认数组**（`cloneDefaultTemplates`，新副本）；
 * - 逐项过 `normalizeProjectTemplate`，坏项丢弃；
 * - `id` 重复 → 后到的重新生成（id 是锚点：向导选择 / 删除 / 打包替换都按它，
 *   重复 id 会让这些操作命中错对象，必须去重）；
 * - 条数 > `MAX_TEMPLATE_COUNT`(20) 截断。
 */
export function normalizeProjectTemplates(value: unknown): ProjectTemplate[] {
  if (!Array.isArray(value)) return cloneDefaultTemplates()
  const out: ProjectTemplate[] = []
  const seenIds = new Set<string>()
  for (const raw of value) {
    if (out.length >= MAX_TEMPLATE_COUNT) break
    const template = normalizeProjectTemplate(raw)
    if (!template) continue
    if (seenIds.has(template.id)) template.id = newTemplateId()
    seenIds.add(template.id)
    out.push(template)
  }
  if (out.length === 0) return cloneDefaultTemplates()
  return out
}

// ── 根名解析（Q-3 两分支，docs/60 §2.4） ────────────────────────────────────

/**
 * 由模板根名模式 + 项目编号（可选）+ 项目名称解析出**最终根目录名**。
 *
 * 两分支（docs/60 §2.4 表，逐字口径）：
 * - **编号已填**：`sanitizeName(模式.replace('{编号}', sanitizeName(编号)).replace('{名称}', sanitizeName(名称)))`
 *   —— 例：编号 `2026-018`、名称 `江畔会所` → `（2026-018）+江畔会所`；
 * - **编号留空**：**直接** `sanitizeName(名称)`（忽略模板根名里的占位符结构，
 *   无论模式改成什么都走这条分支 —— 与用户批注语义逐字对齐）。
 *
 * 编号判空用**原始 trim**（不是清洗后的值：`sanitizeName('')` 会得到 `'未命名'`，
 * 会让"留空"误判成"已填"）。子目录名不做任何替换（Q-4：占位符只限根名）。
 */
export function resolveRootName(rootPattern: string, code: string, name: string): string {
  const cleanName = sanitizeName(String(name ?? ''))
  const rawCode = String(code ?? '').trim()
  if (rawCode === '') return cleanName
  const cleanCode = sanitizeName(rawCode)
  const pattern = String(rootPattern ?? '')
  return sanitizeName(
    pattern.replace(CODE_PLACEHOLDER, cleanCode).replace(NAME_PLACEHOLDER, cleanName)
  )
}
