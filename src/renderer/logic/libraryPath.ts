/**
 * 库目录包含判定（纯逻辑，可单测）—— 渲染层「回灌守卫」的核心。
 *
 * ## 为什么需要它（2026-10-21 数据事故）
 *
 * 卡片拖出走的是 `webContents.startDrag` 发起的**系统级 OLE 拖拽**：在窗口内松手时，
 * 窗口的 `drop` 事件会拿到 `dataTransfer.files = [库内某个文件]`，
 * 而 `dataTransfer.types` 只有 `['Files']`（没有应用内归类的自定义 MIME）——
 * 于是被当成「用户从资源管理器拖了一个文件进来」→ `importPaths` → 库里多出一份
 * `名字-2 … 名字-6` 的副本，且 `importOne` 末尾的 `disposeArchive` 可能把原文件送进回收站。
 *
 * 修法：`drop` 里先按库根过滤。**判定必须大小写不敏感**（Windows 路径），
 * 且不能用裸 `startsWith(root)`（`…\Library2` 会被误判成 `…\Library` 之内）。
 *
 * ⚠️ 不要复用 `shared/vault.ts:isWithinRoot`：它是**大小写敏感**的，且被 `vault://`
 * 路由当作安全边界使用；改它会改变既有行为。这里按渲染层需求单独实现。
 */

/**
 * 归一化：统一分隔符为 `\`、去尾部 `\`、转小写。
 *
 * - 正/反斜杠混用（`E:/ModVault/Library` vs `E:\ModVault\Library`）在 Windows 上等价；
 * - 尾部斜杠数量不一致（`…\Library\` / `…\Library\\`）也必须等价；
 * - 大小写不敏感是 Windows 语义（`E:\MODVAULT` 与 `e:\modvault` 是同一个目录）。
 */
export function normalizeWinPath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * `target` 是否落在 `libraryDir` 之内（含库根本身）。
 *
 * 判定：`p === root || p.startsWith(root + '\\')` —— 后半个条件保证
 * `E:\ModVault\Library2` **不会**被当成 `E:\ModVault\Library` 之内。
 *
 * 空值一律 false（未加载完设置时不做任何过滤，宁可让主进程的兜底守卫拦）。
 */
export function isInsideLibrary(
  libraryDir: string | null | undefined,
  target: string | null | undefined
): boolean {
  if (!libraryDir || !target) return false
  const root = normalizeWinPath(libraryDir)
  const p = normalizeWinPath(target)
  if (!root || !p) return false
  return p === root || p.startsWith(root + '\\')
}

/**
 * 批量过滤：返回**不在库内**的路径（保持原顺序，去重）。
 *
 * `drop` 里一次可能拖进多个文件（资源管理器多选），逐个判定后只把库外的交给导入。
 */
export function pathsOutsideLibrary(
  libraryDir: string | null | undefined,
  paths: readonly string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    if (isInsideLibrary(libraryDir, p)) continue
    const key = normalizeWinPath(p)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}
