/**
 * 新建项目生成器（docs/60 §4.3 W6-W8，T-03）。
 *
 * ## 分层
 *
 * - `buildProjectPlan(input)` —— **纯函数**（只有 `path.join`，零 IO）：
 *   W6 主进程加固的落点。渲染层传来的 `template` **不可信**：重跑
 *   `normalizeProjectTemplate`（清洗 / 4 级剪枝 / 兄弟去重 / 256 节点截断），
 *   根名用 `resolveRootName` 两分支解析（编号可选，docs/60 §2.4），
 *   展开出**全部**目标路径（先浅后深 BFS，含根）。
 * - `createProjectDirs(plan, io)` —— 两阶段落盘（docs/60 §4.3 W7-W8 安全铁律）：
 *   - **阶段一**：父目录存在性 + 目标清单逐条预检。任一已存在 → **整体拒绝、零创建**，
 *     错误串指明首个冲突目录（相对父目录名，不暴露绝对路径）；
 *   - **阶段二**：先浅后深逐个 mkdir。半程 IO 失败**不回滚、不删除已建目录**
 *     （删用户盘上的目录比留半棵树更危险），错误串如实报告已建数量。
 * - `io` 依赖注入：默认真实 `node:fs`；测试用假 io 复现"半程失败"（真实盘上
 *   无法稳定制造中途 IO 异常，Windows 只读目录属性拦不住 mkdir）。
 *
 * ## 错误口径（docs/60 §4.3 安全拒绝分支表）
 *
 * 全部收口为 `{ok:false, error:中文单行}`，**永不抛错**；用户可见文案不暴露内部词。
 * 失败日志由 `main/index.ts` 的 handler 记（`project:create-failed`，含 parentDir /
 * 冲突名 / dirsCreated —— docs/57 §6 F-3/F-4：失败必须留日志）。
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { normalizeProjectTemplate, resolveRootName } from '../shared/projectTemplate'
import type { ProjectTemplateNode } from '../shared/types'
import type { ProjectCreateResult } from '../shared/ipc'

/* ────────────────────────────────────────────────────────────────────────────
 * 计划（纯数据，主进程内部传递；不跨 IPC）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 计划成功态：展开好的目标路径清单（先浅后深，targets[0] = 根目录） */
export interface ProjectCreatePlan {
  ok: true
  /** 父目录绝对路径（阶段一存在性检查 + 冲突目录的相对名都以它为基准） */
  parentDir: string
  /** 最终根目录名（已过两分支解析 + sanitizeName） */
  rootName: string
  /** 根目录绝对路径（= path.join(parentDir, rootName)） */
  rootPath: string
  /** 全部目标路径，先浅后深（BFS），targets[0] = 根目录 */
  targets: string[]
  /** 模板界面名（确认页 / 日志用） */
  templateName: string
}

/** 计划失败态：中文单行错误（阶段一开始前的问题：模板 / 名称 / 位置不合法） */
export type ProjectPlanOutcome = ProjectCreatePlan | { ok: false; error: string }

/* ────────────────────────────────────────────────────────────────────────────
 * buildProjectPlan —— W6 加固（纯函数，单测覆盖）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 把树展开成先浅后深（BFS）的目标路径清单。
 *
 * 为什么 BFS 而不是 DFS：阶段二"逐个 mkdir"要求**父目录先于子目录创建**
 * （docs/60 §4.3 W8"先浅后深"），BFS 天然满足 —— 同层兄弟连成一片、父层全部
 * 先于任何子层，中途失败时"已建到哪一层"的语义最直白。
 */
function collectTargets(root: ProjectTemplateNode, rootPath: string): string[] {
  const targets: string[] = [rootPath]
  const queue: Array<{ node: ProjectTemplateNode; dir: string }> = [{ node: root, dir: rootPath }]
  while (queue.length > 0) {
    const head = queue.shift()
    if (!head) break
    const children = Array.isArray(head.node.children) ? head.node.children : []
    for (const child of children) {
      const childPath = path.join(head.dir, child.name)
      targets.push(childPath)
      queue.push({ node: child, dir: childPath })
    }
  }
  return targets
}

/**
 * 由向导入参构建创建计划（W6，**不信渲染层**）。
 *
 * 校验顺序（失败即短路，错误串给界面直接展示）：
 * 1. `parentDir`：字符串 + 绝对路径 + **不是盘根**（`path.dirname` 等于自身即盘根，
 *    docs/60 §4.3 "目标根不允许是盘根"）；
 * 2. `template`：过 `normalizeProjectTemplate` —— 拿不到 / 坏 → 拒绝（渲染层被注入
 *    后传超深 / 超多节点的树也在这里被剪到 4 级 / 256 节点）；
 * 3. `name`：trim 后非空（编号空是合法态，Q-3）；
 * 4. 根名：`resolveRootName` 两分支（编号已填 → 占位符替换；留空 → 直接用名称）。
 */
export function buildProjectPlan(input: unknown): ProjectPlanOutcome {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  const parentDir = typeof raw.parentDir === 'string' ? raw.parentDir : ''
  if (parentDir.length === 0 || !path.isAbsolute(parentDir)) {
    return { ok: false, error: '存放位置不可用，请重新选择' }
  }
  const normalizedParent = path.normalize(parentDir)
  // 盘根判定：dirname('E:\\') === 'E:\\'（POSIX 的 '/' 同理）。盘根下不允许整树生成。
  if (path.dirname(normalizedParent) === normalizedParent) {
    return { ok: false, error: '存放位置不可用，请重新选择' }
  }

  const template = normalizeProjectTemplate(raw.template)
  if (!template) {
    return { ok: false, error: '模板不可用，请重新选择模板' }
  }

  const name = typeof raw.name === 'string' ? raw.name : ''
  if (name.trim().length === 0) {
    return { ok: false, error: '请填写项目名称' }
  }
  const code = typeof raw.code === 'string' ? raw.code : ''

  const rootName = resolveRootName(template.root.name, code, name)
  if (rootName.length === 0 || rootName === '.' || rootName === '..') {
    return { ok: false, error: '项目名称不合法，请换个名称' }
  }

  const rootPath = path.join(normalizedParent, rootName)
  return {
    ok: true,
    parentDir: normalizedParent,
    rootName,
    rootPath,
    targets: collectTargets(template.root, rootPath),
    templateName: template.name
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * createProjectDirs —— W7 预检 + W8 落盘（io 可注入，测试复现半程失败）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 文件系统能力（默认真实 `node:fs`；测试注入假实现） */
export interface ProjectCreateIo {
  exists(p: string): boolean
  isDirectory(p: string): boolean
  mkdir(p: string): void
}

export const defaultProjectCreateIo: ProjectCreateIo = {
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  // recursive:true 与 BFS 先浅后深叠加：每一级自己先建好，本调用只补"自己这一段"，
  // 外部进程抢建了中间层也不会让 mkdir 炸（预检已拒绝已存在的情况，这里只兜竞态）
  mkdir: (p) => {
    mkdirSync(p, { recursive: true })
  }
}

/**
 * 两阶段落盘（docs/60 §4.3 W7-W8 安全铁律，写死不接受推翻"拒绝"本身）。
 *
 * - **阶段一（预检）**：父目录存在且是目录 + 全量目标逐条 `existsSync`。
 *   任一已存在 → 整体拒绝、零创建，错误串指明首个冲突目录的相对名
 *   （分隔符统一成 `/`，Windows 反斜杠在中文提示里读起来太技术）；
 * - **阶段二（落盘）**：按 `plan.targets` 顺序逐个 mkdir。失败即停，
 *   **不回滚、不删除**，返回 `dirsCreated` = 已建数量；ENAMETOOLONG（根名超长）
 *   在错误串里补「名称过长」（docs/60 §4.3 分支表最后一行）。
 */
export function createProjectDirs(
  plan: ProjectCreatePlan,
  io: ProjectCreateIo = defaultProjectCreateIo
): ProjectCreateResult {
  // ── 阶段一 · 父目录 ──────────────────────────────────────────────
  if (!io.exists(plan.parentDir) || !io.isDirectory(plan.parentDir)) {
    return { ok: false, error: '存放位置不可用，请重新选择' }
  }

  // ── 阶段一 · 全量预检（任一冲突 = 整体拒绝、零创建，Q-5）──────────
  for (const target of plan.targets) {
    if (io.exists(target)) {
      const rel = path.relative(plan.parentDir, target).split(path.sep).join('/')
      const conflictName = rel.length > 0 ? rel : plan.rootName
      return {
        ok: false,
        error: `该位置已存在同名文件夹「${conflictName}」，请换个名称或位置`,
        dirsCreated: 0
      }
    }
  }

  // ── 阶段二 · 先浅后深逐个 mkdir（失败即停，不回滚不删除）──────────
  let dirsCreated = 0
  for (const target of plan.targets) {
    try {
      io.mkdir(target)
      dirsCreated += 1
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const code = (err as NodeJS.ErrnoException | null)?.code
      const prefix = code === 'ENAMETOOLONG' ? '名称过长，' : ''
      return {
        ok: false,
        error: `${prefix}创建文件夹失败：${reason}（已完成 ${dirsCreated} 个，已创建的文件夹保留在原处）`,
        dirsCreated
      }
    }
  }

  return { ok: true, rootPath: plan.rootPath, dirsCreated }
}
