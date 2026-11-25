/**
 * 首页钉选（快速访问）目录的**应用内浏览守卫 + 只读列目录**（v1.2 反馈批 B）。
 *
 * 用户需求原话：「我希望双击用户自己的文件夹以后，进入的仍然是我们的软件界面，
 * 也就是我们的软件代替了文件资源管理器的功能。」为此新增两条 IPC：
 * `fs:listDir`（只读列一层条目）与 `fs:openEntry`（系统默认程序打开文件）。
 * 两条通道的**全部路径安全边界都收口在本文件**，守卫零放宽：
 *
 * - 0.9.2 的 `allowedOpenRoots` 只放行「库根 ∪ 日志目录」，**不允许**为钉选目录放宽；
 *   钉选目录走自己的白名单 —— 主进程按 `HomePinnedFolder.id` 从**自己的 settings**
 *   解析 `absPath`（不信渲染层传来的路径，`home:pinnedOpen` 同款防御）；
 * - `relPath` 相对钉选根（空串 = 根）。逐段 `path.resolve` 之后**必须仍以该根为前缀**
 *   （Windows 大小写不敏感比较），越界一律拒绝 —— 这一条同时挡住三类注入：
 *     ① `..` 穿越（`sub/../../outside` → resolve 后越出根 → 拒）；
 *     ② relPath 塞绝对路径（`D:\x` / `/etc` → resolve 直接跳走 → 拒）；
 *     ③ 盘符切换（Windows 同上）。
 * - 列目录**只读**：`readdirSync` + `statSync`，本文件不出现任何写入 API；
 *   跳过隐藏文件（`.` 开头）与符号链接（防借软链越界读写、防循环遍历）；
 *   目录在前、同组按名称排序；单层条目数硬上限 `LIST_DIR_MAX_ENTRIES`（2000）防炸。
 *
 * 纯函数 + 纯 Node API，无 React / electron 依赖 —— 单测见 `tests/pinnedDirGuard.test.ts`。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

/**
 * 单层列目录的条目数硬上限。
 *
 * 取值理由：2000 条按每条一次 statSync（约 0.05-0.2ms/条，SSD）最坏也在一秒内收口，
 * 网络盘等慢介质由调用侧的加载态兜住；超过上限的目录把后面的条目截掉 ——
 * 这是「防炸」不是「分页」，渲染层不给翻页，超限本身视为异常目录。
 */
export const LIST_DIR_MAX_ENTRIES = 2000

/** 一层目录条目（`fs:listDir` 的返回元素）。`size` 只对文件有意义；stat 失败时两者省略。 */
export interface PinnedDirEntry {
  /** 文件 / 子目录名（不含路径，只含最后一段） */
  name: string
  /** true = 子目录（渲染层双击下钻）；false = 文件（双击走 `fs:openEntry`） */
  isDir: boolean
  /** 文件字节数（仅文件；stat 失败省略） */
  size?: number
  /** 修改时间毫秒值（stat 失败省略） */
  mtimeMs?: number
}

/** 路径守卫结果：`ok:false` 时 `error` 是可直接展示的中文单行（永不抛错）。 */
export type PinPathGuardResult =
  | { ok: true; absPath: string }
  | { ok: false; error: string }

/**
 * 把渲染层传来的 `relPath`（相对钉选根，**不可信**）解析成绝对路径，并校验
 * 结果仍在 `rootAbs` 之内。任何越界 / 非法输入都返回 `{ok:false}`，**绝不抛错**。
 *
 * 校验顺序（每一条都可能独立拦下注入）：
 * 1. 根必须是**绝对路径**字符串（`homePinnedOpen` 写入 settings 时已保证，这里再防一手）；
 * 2. `relPath` 必须是字符串且不含 NUL（`\0` 截断注入的老手法，直接拒）；
 * 3. `path.resolve(root, relPath)` —— resolve 本身会消费 `..` 与绝对前缀；
 * 4. 结果与根做**大小写不敏感**的前缀比较（Windows 文件系统大小写不敏感，
 *    `E:\mod\A` 与 `E:\mod\a` 是同一目录，严格比较会误拒合法请求）；
 *    前缀必须整段对齐（`E:\mod\ab` 不得冒充 `E:\mod\a` 的子路径 —— 比较时补 `path.sep`）。
 *
 * @param rootAbs 钉选根的绝对路径（来自主进程自己的 settings）
 * @param relPath 相对路径；空串 / `.` = 根本身
 */
export function resolveWithinPinRoot(rootAbs: string, relPath: string): PinPathGuardResult {
  if (typeof rootAbs !== 'string' || rootAbs.length === 0 || !path.isAbsolute(rootAbs)) {
    return { ok: false, error: '快速访问文件夹不可用，请从快速访问移除后重新添加' }
  }
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    return { ok: false, error: '路径不合法' }
  }
  const root = path.normalize(rootAbs)
  const abs = path.resolve(root, relPath)
  const rootLow = root.toLowerCase()
  const absLow = abs.toLowerCase()
  // 整段前缀：abs == root，或 abs 以 root + 分隔符开头（防止 "rootAB" 冒充 "rootA" 子路径）
  if (absLow !== rootLow && !absLow.startsWith(rootLow + path.sep)) {
    return { ok: false, error: '目标不在该文件夹内' }
  }
  return { ok: true, absPath: abs }
}

/**
 * **只读**列出一层目录条目（`fs:listDir` 的实现体）。
 *
 * 规则（契约见 `shared/ipc.ts` 的 `fsListDir` 注释）：
 * - 跳过隐藏条目（`.` 开头，如 `.git` / `.DS_Store`）与符号链接
 *   （软链可能指到钉选根之外，放进来等于给前缀守卫开后门）；
 * - 非「目录 / 常规文件」的条目（管道、socket 等）同样跳过；
 * - 目录在前、文件在后，同组按名称升序（`localeCompare`，中文文件名按拼音段排）；
 * - 条目数截到 `maxEntries`（默认 `LIST_DIR_MAX_ENTRIES`）；**截断发生时返回
 *   `truncated: true`**（docs/61 A14「2000 截断明示」——渲染层必须提示，不再静默吞）；
 *   仍只返回前 `maxEntries` 条，这不是分页；
 * - 单个条目 stat 失败（竞态删除 / 权限）→ 该条省略 `size` / `mtimeMs`，**不中断整层**；
 * - 目录本身读不了（不存在 / 无权限）→ `{ok:false, error:中文单行}`，不抛错。
 *
 * @param dirAbs 已通过 {@link resolveWithinPinRoot} 校验的目录绝对路径
 * @param maxEntries 单层条目数上限（测试注入用；调用方走默认）
 */
export function readDirEntries(
  dirAbs: string,
  maxEntries: number = LIST_DIR_MAX_ENTRIES
): { ok: true; entries: PinnedDirEntry[]; truncated: boolean } | { ok: false; error: string } {
  if (typeof maxEntries !== 'number' || !Number.isFinite(maxEntries) || maxEntries <= 0) {
    return { ok: true, entries: [], truncated: false }
  }
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return { ok: false, error: '无法读取这个文件夹（可能已被移动或没有权限）' }
  }
  const dirs: PinnedDirEntry[] = []
  const files: PinnedDirEntry[] = []
  for (const d of dirents) {
    // 隐藏条目与符号链接一律跳过（理由见文件头）
    if (d.name.startsWith('.') || d.isSymbolicLink()) continue
    if (!d.isDirectory() && !d.isFile()) continue
    const isDir = d.isDirectory()
    const entry: PinnedDirEntry = isDir ? { name: d.name, isDir: true } : { name: d.name, isDir: false }
    // stat 只为补展示字段（大小 / 修改时间）；失败不中断 —— 条目本身照样列出
    try {
      const st = statSync(path.join(dirAbs, d.name))
      entry.mtimeMs = st.mtimeMs
      if (!isDir) entry.size = st.size
    } catch {
      // 竞态（读取中被删）/ 无权限：省略字段，条目保留
    }
    if (isDir) dirs.push(entry)
    else files.push(entry)
  }
  const byName = (a: PinnedDirEntry, b: PinnedDirEntry): number => a.name.localeCompare(b.name, 'zh-Hans-CN')
  dirs.sort(byName)
  files.sort(byName)
  const combined = [...dirs, ...files]
  return { ok: true, entries: combined.slice(0, Math.trunc(maxEntries)), truncated: combined.length > Math.trunc(maxEntries) }
}
