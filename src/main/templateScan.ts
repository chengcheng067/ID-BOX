/**
 * 拖入文件夹 → 项目模板草稿扫描器（v1.2 反馈批 C，docs/60 的「拖入自动识别」增补）。
 *
 * ## 分层（与 `projectCreate.ts` 同款：纯转换 + 可注入 io）
 *
 * - `scanTemplateFromDir(input, io)` —— 主进程入口：入参校验（存在 / 是目录）→
 *   `fs.readdir withFileTypes` 递归下钻 → 交给 `normalizeProjectTemplate` 收口
 *   （清洗 / 兄弟去重 / 深度 4 剪枝 / 256 节点截断，**唯一实现不复制**）→
 *   统计「超限丢弃」数量。**纯只读，绝不写盘**。
 * - `io` 依赖注入：默认真实 `node:fs`；测试用假 io（内存目录树）复现
 *   各容错分支（真实盘上无法稳定制造无权限 / 深度超限等场景）。
 *
 * ## 扫描口径
 *
 * - **跳过**：文件、符号链接（防环 + 防跨盘误扫）、隐藏目录（`.` 开头，如 `.git`）；
 * - **深度**：模板上限 4 级（根记 1），**多探一层**（第 5 层只计数不展开）——
 *   用户需要知道「拖进来的树比模板上限深、丢了多少」；
 * - **数量**：扫描硬上限 `SCAN_MAX_DIRS`(1024) = 模板 256 之外再多探 4 页即停，
 *   防极端目录树把主进程拖死；命中硬上限时丢弃统计是**至少**口径（如实不虚报）；
 * - **单项降级**：某个子目录读不了（权限 / 竞态删除）→ 静默当叶子跳过，不拖垮整棵；
 *   只有**根目录**读不了才报错（用户明确需要知道为什么拖进来没反应）。
 *
 * ## 错误口径
 *
 * 全部收口为 `{ok:false, error:中文单行}`，**永不抛错**；用户可见文案不暴露内部词。
 * 空目录（没有任何子文件夹）明确拒绝：单节点模板没有生成价值（与设置页手动新建
 * 空白模板的入口互不替代）。
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { MAX_TEMPLATE_DEPTH, countTemplateNodes, normalizeProjectTemplate } from '../shared/projectTemplate'
import type { TemplateScanResult } from '../shared/ipc'
import type { ProjectTemplateNode } from '../shared/types'

/* ────────────────────────────────────────────────────────────────────────────
 * 可注入文件系统能力（默认真实 node:fs；测试注入内存假树）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 一条目录项的最小形状（`fs.Dirent` 的子集，测试可直接手造） */
export interface TemplateScanDirent {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** 文件系统能力（默认真实 `node:fs`；测试注入假实现） */
export interface TemplateScanIo {
  /** 目录判定：`true`/`false` = 是否目录；`null` = 路径不存在 */
  statIsDirectory(p: string): boolean | null
  /** 列目录项；失败（不存在 / 无权限）抛错，由调用方按位置区分处理 */
  readdir(p: string): TemplateScanDirent[]
}

export const defaultTemplateScanIo: TemplateScanIo = {
  statIsDirectory: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return null
    }
  },
  readdir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isSymbolicLink: d.isSymbolicLink()
    }))
}

/* ────────────────────────────────────────────────────────────────────────────
 * 扫描上限（模板上限之外「多探一层」的量化，docs/60 §2.3 口径的延伸）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 扫描目录硬上限（含根）：256 之外再多探 4 页即停。
 * 命中即停时，丢弃统计是「至少」口径 —— 宁可少报不可拖死主进程。
 */
export const SCAN_MAX_DIRS = 1024

/** 扫描累计器（`visited` 含根；`depthExtra` = 第 5 层目录数；`capped` = 命中硬上限） */
interface ScanAcc {
  visited: number
  depthExtra: number
  capped: boolean
}

/** 能下钻的目录项：真目录（不是文件）+ 非符号链接 + 非隐藏目录 */
function isScannableDir(e: TemplateScanDirent): boolean {
  return e.isDirectory && !e.isSymbolicLink && !e.name.startsWith('.')
}

/** 稳定排序（同名目录树重复扫描结果一致；localeCompare 对中文/数字足够） */
function byName(a: TemplateScanDirent, b: TemplateScanDirent): number {
  return a.name.localeCompare(b.name)
}

/**
 * 递归扫描一个目录，返回它自身的树节点。
 *
 * `depth` = 本目录所处层级（根 = 1）。到达模板深度顶（第 4 级）时**多探一层**：
 * 只 readdir 一次统计第 5 层目录数（丢弃统计），不再下钻 —— 「多探一层即可停」。
 */
function scanNode(
  absDir: string,
  name: string,
  depth: number,
  acc: ScanAcc,
  io: TemplateScanIo
): ProjectTemplateNode {
  const childDepth = depth + 1
  if (childDepth > MAX_TEMPLATE_DEPTH) {
    // 深度顶格：孩子属于第 5 层 → 只计数不展开（「多探一层即可停」，递归到此为止）
    if (acc.visited < SCAN_MAX_DIRS) {
      try {
        const entries = io.readdir(absDir).filter(isScannableDir)
        acc.depthExtra += entries.length
        acc.visited += entries.length
        if (acc.visited >= SCAN_MAX_DIRS) acc.capped = true
      } catch {
        /* 第 4 级目录读不了 → 不影响丢弃统计的正确性（少报而已），当叶子 */
      }
    }
    return { name }
  }

  let entries: TemplateScanDirent[]
  try {
    entries = io.readdir(absDir).filter(isScannableDir).sort(byName)
  } catch {
    // 子目录读不了（权限 / 竞态删除）→ 单项降级当叶子，不拖垮整棵
    return { name }
  }

  const children: ProjectTemplateNode[] = []
  for (const d of entries) {
    if (acc.visited >= SCAN_MAX_DIRS) {
      acc.capped = true
      break
    }
    acc.visited += 1
    children.push(scanNode(path.join(absDir, d.name), d.name, childDepth, acc, io))
  }
  // 与归一化同口径：空 children 退化成叶子（不留空数组）
  return children.length > 0 ? { name, children } : { name }
}

/* ────────────────────────────────────────────────────────────────────────────
 * scanTemplateFromDir —— 主入口（只读，永不抛错）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 扫描拖入的文件夹，转成模板树草稿（`template:scanFromDir` 的实现）。
 *
 * 校验顺序（失败即短路，错误串给界面直接展示）：
 * 1. `dirPath`：非空字符串；
 * 2. 存在且是目录（是文件 → 明确拒绝）；
 * 3. 根目录可读（无权限 / 其他 IO 错误 → 明确中文错误）；
 * 4. 至少有一个子文件夹（空目录 → 明确拒绝）。
 *
 * 通过后递归扫描（跳过文件 / 符号链接 / 隐藏目录）→ `normalizeProjectTemplate`
 * 收口（目录名清洗 / 兄弟去重 / 深度 4 剪枝 / 256 节点截断，唯一实现）→
 * 统计丢弃：`truncated.depth` = 第 5 层目录数；`truncated.nodes` = 深度 ≤4 但没进
 * 最终树的目录数（命中扫描硬上限时为至少口径）。
 */
export function scanTemplateFromDir(
  input: unknown,
  io: TemplateScanIo = defaultTemplateScanIo
): TemplateScanResult {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const dirPath = typeof raw.dirPath === 'string' ? raw.dirPath.trim() : ''
  if (dirPath.length === 0) {
    return { ok: false, error: '未拿到文件夹路径，请重新拖入' }
  }

  // ── 存在性 / 目录判定 ──────────────────────────────────────────────
  const stat = io.statIsDirectory(dirPath)
  if (stat === null) {
    return { ok: false, error: '文件夹不存在或已被移动，请重新拖入' }
  }
  if (!stat) {
    return { ok: false, error: '请拖入文件夹（而不是文件）' }
  }

  // ── 根目录可读性（只有这里报权限错；子目录单项降级） ────────────────
  let rootEntries: TemplateScanDirent[]
  try {
    rootEntries = io.readdir(dirPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      error:
        code === 'EACCES' || code === 'EPERM'
          ? '没有权限读取该文件夹，请检查访问权限'
          : '读取文件夹失败，请重试'
    }
  }

  const rootDirs = rootEntries.filter(isScannableDir).sort(byName)
  if (rootDirs.length === 0) {
    return { ok: false, error: '该文件夹里没有子文件夹，无法生成模板' }
  }

  // ── 递归扫描（visited 从根的 1 起计） ──────────────────────────────
  const acc: ScanAcc = { visited: 1, depthExtra: 0, capped: false }
  const rootChildren: ProjectTemplateNode[] = []
  for (const d of rootDirs) {
    if (acc.visited >= SCAN_MAX_DIRS) {
      acc.capped = true
      break
    }
    acc.visited += 1
    rootChildren.push(scanNode(path.join(dirPath, d.name), d.name, 2, acc, io))
  }

  // ── 归一化收口（清洗 / 去重 / 深度 4 剪枝 / 256 截断，唯一实现） ────
  const rootName = path.basename(dirPath)
  const normalized = normalizeProjectTemplate({
    root: { name: rootName, children: rootChildren }
  })
  if (!normalized) {
    // 理论不可达（扫描树必然含根且合法），防御兜底不抛错
    return { ok: false, error: '该文件夹的结构无法生成模板，请检查后重试' }
  }

  // 深度 ≤4 的目录数 = 访问总数 - 第 5 层计数；没进最终树的 = 被 256 截掉的
  const inDepthDirs = acc.visited - acc.depthExtra
  const truncated = {
    depth: acc.depthExtra,
    nodes: Math.max(0, inDepthDirs - countTemplateNodes(normalized.root))
  }
  return {
    ok: true,
    root: normalized.root,
    truncated,
    scannedDirs: acc.visited
  }
}
