/**
 * 破坏性 / 可执行外部程序的 IPC 通道**运行期边界守卫**（0.9.2）。
 *
 * ## 为什么主进程必须自己挡一道
 *
 * 渲染层是「同源但不可信」的：`shell.openPath` / `shell.showItemInFolder` /
 * 「移入系统回收站」三条通道一旦拿到任意绝对路径，就等于把**整台机器的文件系统**
 * 当成自己 IPC 的入参面：
 *
 * - `openPath('C:\\Windows\\System32\\xxx.exe')` → 直接执行本机程序；
 * - `reveal('C:\\Users\\...\\Desktop')` → 在资源管理器里暴露出库外的任意目录；
 * - `trashPaths(['D:\\工作\\图纸'])` → 把用户**库外**的资料搬进回收站
 *   （这是唯一**不可逆**的后果：撤销条 5 秒后就没了，用户找不回来）。
 *
 * 渲染层的调用点本身都是"库内文件 / 库内资产目录"（见 `AssetGrid` / `DetailPanel` /
 * `AssetContextMenu` / `FileContextMenu` / `store.commitDelete`），所以正常业务
 * 一条都不会被拦；被拦下来的都是「渲染层被注入 / 状态串味 / 库目录刚被改」这类
 * 异常态。**守卫只做减法，不改变任何既有成功路径的行为。**
 *
 * ## 允许根 = 库根 ∪ 日志目录
 *
 * ⚠️ 只允许库根会打断「设置 → 打开日志文件夹」（`SettingsDialog` 对
 * `logStat.dir` 调 `openPath`，该目录在 `app.getPath('userData')/logs`，**在库外**）。
 * 日志目录是主进程自己产出的东西，允许它不扩大攻击面。
 *
 * ## 为什么不直接复用 `importer.ts:isInsideLibraryDir`
 *
 * 那个函数的**包含判定**口径是正确的（resolve + 统一分隔符 + 去尾分隔符 +
 * 小写 + `root + sep` 前缀），但它是为「已确定为 string 的库内相对/绝对路径」写的，
 * 缺三样本守卫必需的能力：
 *
 * 1. **类型不安全**：入参声明为 `string`，`path.resolve(123)` 会**抛 TypeError**。
 *    本模块的入参是 `unknown`（IPC 入参可能是任何东西），必须永不抛。
 * 2. **不要求绝对路径**：`isInsideLibraryDir` 会把相对路径按 `process.cwd()` 解析，
 *    而主进程的 cwd 在开发态/打包态完全不同 —— 相对路径的语义不可控，必须直接拒。
 * 3. **库根为空/为盘符根**时的边界（`''`、`'/'`）没有显式定义。
 *
 * 因此这里**新写**一份口径相同的实现，`importer.ts` 一行不动
 * （它有 30+ 测试依赖，改动风险另开任务）。
 *
 * ## 纯函数、零 electron 依赖
 *
 * 本文件只 import `node:path` 与两个纯常量模块，可在 `environment: 'node'` 的
 * vitest 里直测（见 `tests/ipcGuard.test.ts`）。
 */

import path from 'node:path'
import { STAGING_DIR } from './fsutil'
import { LIBRARY_TRASH_DIR } from './trash'

/** 守卫结果：`ok` 原样放行，`rejected` 拒绝并上报（值都是**原始入参**，便于日志对账） */
export interface GuardedPaths {
  /** 通过守卫的路径（保持入参原始字符串，未做任何归一化改写） */
  ok: string[]
  /** 被拒绝的路径（原始字符串；非字符串入参给出可读标签） */
  rejected: string[]
}

/** `C:\…` / `C:/…`：Windows 盘符绝对路径 */
const DRIVE_ABS_RE = /^[a-zA-Z]:[\\/]/

/** `\\server\share…` 或 `//server/share…`：UNC 绝对路径 */
const UNC_RE = /^[\\/]{2}/

/**
 * 是否为**绝对路径**（Windows 语义为主，同时兼容 POSIX 根）。
 *
 * 注意 `C:foo`（盘符相对，无分隔符）与 `\foo`（当前盘的根相对）**都不算绝对**：
 * 它们的真实位置取决于该盘的当前目录，语义不可控 → 拒。
 */
function isAbsoluteLike(p: string): boolean {
  if (p.length === 0) return false
  if (DRIVE_ABS_RE.test(p)) return true
  if (UNC_RE.test(p)) return true
  // POSIX 根（Electron 在 Linux/macOS 上的 userData 长这样）
  return p.startsWith('/')
}

/**
 * 归一化成**可直接做字符串比较**的形态：
 * 统一分隔符为 `/` → 消掉 `.`/`..` 与重复分隔符 → 去尾部 `/` → 转小写。
 *
 * 为什么不直接用 `path.resolve`：
 * - `path.resolve` 依赖 `process.cwd()`，相对路径会被悄悄绑到 cwd 上（本模块直接拒相对路径，
 *   所以不需要这个能力）；
 * - `path.resolve` 是**平台相关**的：同一份逻辑在 Windows 开发机与 Linux CI 上会给出
 *   不同结果。这里先统一分隔符再走 `path.posix.normalize`，语义在任何平台都一致
 *   （`C:\a\..\b` → `c:/b`，`..` 穿越因此能被真正消掉而不是被当成普通目录名）。
 *
 * ⚠️ **小写是无条件的**（不按 `process.platform` 分支）：ID BOX 只发 Windows 安装包，
 * Windows 文件系统大小写不敏感；无条件小写同时让单测在任何 CI 平台都确定。
 * 这与 `importer.ts:isInsideLibraryDir` 的既有口径完全一致。
 */
function normalizeForCompare(p: string): string {
  const unified = p.replace(/\\/g, '/')
  const collapsed = path.posix.normalize(unified)
  return collapsed.replace(/\/+$/, '').toLowerCase()
}

/**
 * 把任意入参转成可放进日志/`failed[]` 的字符串标签。**永不抛**。
 *
 * （`String(Object.create(null))` 会抛 TypeError，所以必须兜 try。）
 */
function labelOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === null) return 'null'
  if (raw === undefined) return 'undefined'
  try {
    return String(raw)
  } catch {
    return '[unprintable]'
  }
}

/**
 * `target` 是否等于 `root` 或位于其**内部**（目录穿越防护，纯字符串判定）。
 *
 * 口径（与 `importer.ts:isInsideLibraryDir` 一致，另补类型/绝对路径约束）：
 * - `target` 必须是**绝对路径字符串**；非字符串 / 空串 / 相对路径 → `false`；
 * - `path.resolve` 等价归一（`..`、重复分隔符、尾部 `\`）后再比较，穿越出根 → `false`；
 * - Windows 语义：大小写不敏感（`C:\Foo` 与 `c:\foo` 同一目录）；
 * - `root` **自身**算「在根内」（`reveal(libraryDir)` 要能用）；
 * - 前缀必须带分隔符：`C:\lib` **不**匹配 `C:\lib2\x`；
 * - `root` 为空 / 非绝对 / 归一无意义（如 `'/'`）→ 一律 `false`（deny by default）；
 * - **本函数不抛任何异常**（`root`/`target` 在生产里可能是 `unknown` 强转进来的）。
 */
export function isWithinRoot(root: string, target: string): boolean {
  // 运行期类型闸门：签名是 string，但调用方传的是 IPC 原始入参（可能是任何东西）
  if (typeof root !== 'string' || typeof target !== 'string') return false
  if (root.length === 0 || target.length === 0) return false
  if (!isAbsoluteLike(root) || !isAbsoluteLike(target)) return false
  const r = normalizeForCompare(root)
  const t = normalizeForCompare(target)
  // 空结果 = 根就是文件系统根（`/`）之类无法做包含判定的形态 → 拒
  if (r.length === 0 || t.length === 0) return false
  if (t === r) return true
  return t.startsWith(r + '/')
}

/**
 * `openPath` / `reveal` 的入参守卫（两个通道共用：一个打开、一个在文件夹中显示）。
 *
 * `raw` 是 IPC 原始入参（`unknown`）：正常调用是单个字符串；收到数组时逐个判定
 * （**不抛**，任一通过即可放行），其余类型一律进 `rejected` 供调用方记日志。
 *
 * @param raw   渲染层传来的原始入参
 * @param roots 允许的根目录列表（库根 ∪ 日志目录），空/非字符串项自动忽略
 */
export function guardOpenPaths(raw: unknown, roots: readonly string[]): GuardedPaths {
  const ok: string[] = []
  const rejected: string[] = []
  const allowedRoots = (Array.isArray(roots) ? roots : []).filter(
    (r): r is string => typeof r === 'string' && r.length > 0
  )
  const candidates: unknown[] = Array.isArray(raw) ? raw : [raw]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      rejected.push(labelOf(candidate))
      continue
    }
    if (allowedRoots.some((root) => isWithinRoot(root, candidate))) ok.push(candidate)
    else rejected.push(candidate)
  }
  return { ok, rejected }
}

/**
 * `trashPaths` 的入参守卫：**只有库内、且不是结构节点的目录**才允许进系统回收站。
 *
 * 除「必须在库根内」外的三类额外禁令（删掉任何一个都会毁掉整个库结构）：
 * 1. **库根本身** —— 删了等于把用户整个素材库扔进回收站；
 * 2. **库根的直接子目录**（也就是 `模型 / 材质 / CAD / HDR / 贴图` 这一层大类目录）——
 *    rescan 按「固定三层下钻」读库，删掉一个大类目录等于让该大类全部资产凭空消失；
 * 3. **`.trash` / `.staging` 两个保留目录及其内部任何路径** ——
 *    `trashPaths` 的语义是"进系统回收站"，把回收区自己的内容再回收一次只会让
 *    「最近删除」的还原链路指向不存在的目录；`.staging` 是导入中间态，
 *    动它会和并发导入抢同一份目录。
 *
 * 非数组入参 → `{ ok: [], rejected: [] }`：保持现有"容错不抛"的行为
 * （`main/index.ts` 旧实现就是 `Array.isArray(paths) ? paths : []`）。
 *
 * `rejected` 里的值**保留原始字符串**：`store.commitDelete` 用
 * `failedSet.has(a.folder)` 对账，换成归一化路径会让"被拒"的资产被误当成"已删"。
 */
export function guardTrashPaths(raw: unknown, libraryDir: string): GuardedPaths {
  const ok: string[] = []
  const rejected: string[] = []
  if (!Array.isArray(raw)) return { ok, rejected }
  if (typeof libraryDir !== 'string' || libraryDir.length === 0) {
    // 库根未配置（设置未加载 / 被清空）：没有可信的允许根 → 全拒（宁可删不掉，不可删错）
    for (const item of raw) rejected.push(labelOf(item))
    return { ok, rejected }
  }
  const libNorm = normalizeForCompare(libraryDir)
  if (libNorm.length === 0) {
    for (const item of raw) rejected.push(labelOf(item))
    return { ok, rejected }
  }
  /** 保留目录的归一化前缀（`.trash` 自身 + 其下所有内容） */
  const reservedPrefixes = [LIBRARY_TRASH_DIR, STAGING_DIR].map((name) =>
    normalizeForCompare(`${libNorm}/${name}`)
  )

  for (const item of raw) {
    if (typeof item !== 'string') {
      rejected.push(labelOf(item))
      continue
    }
    // ① 必须在库根内（绝对路径 + 无穿越 + 带分隔符前缀）
    if (!isWithinRoot(libraryDir, item)) {
      rejected.push(item)
      continue
    }
    const p = normalizeForCompare(item)
    // ② 库根本身
    if (p === libNorm) {
      rejected.push(item)
      continue
    }
    // ③ 库根的直接子目录 = 大类目录（`模型` / `材质` / …）
    if (path.posix.dirname(p) === libNorm) {
      rejected.push(item)
      continue
    }
    // ④ 回收区 / 暂存区自身及其内部
    if (reservedPrefixes.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) {
      rejected.push(item)
      continue
    }
    ok.push(item)
  }
  return { ok, rejected }
}
