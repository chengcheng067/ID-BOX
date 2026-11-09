/**
 * 「更新 ID BOX 中的这个模型」的**落盘实现**（收件箱通道 `IPC.inboxApplyUpdate`）。
 *
 * ## 为什么单独一个文件
 *
 * 本文件只 import `node:fs` / `node:path` / 两个**不含 electron** 的模块
 * （`./ipcGuard`、`../shared/inbox`），所以 `tests/inboxUpdate.test.ts` 能在
 * `environment: 'node'` 的 vitest 里用真实临时目录跑完整落盘路径。
 * `src/main/inbox.ts` 那边要 `app.getPath` + chokidar，测不了。
 *
 * ## 用户口径（`docs/48` §7，逐字）
 *
 * > 做「右键更新 IDBOX 中的这个模型」：**覆盖同名 .skp 本体，保留元数据**
 * > （分类、渲染参数、自定义封面不动）
 *
 * ## ⛔ 硬约束：绝不走 `IPC.importPaths` 的覆盖档
 *
 * `importer.ts:replaceAssetFolder()` 会把旧资产目录**整个 rename 走再送进系统回收站**，
 * 而 `applyOverwriteInherit()` 只继承 12 个字段（id/name/favorite/rating/colorTag/tags/
 * styles/note/category1/2/classifyReview/zhimoId/dedupeKey）—— **没有**
 * `renderParams` / `renderShape` / `cover` / `coverSource` / `thumbPath`。
 * 也就是说走那条路 = 用户调好的材质球参数全丢、自定义封面连文件一起进回收站
 * （勘察 §Q4-3 / §风险 R5 已把这条写死）。本文件是那条禁令的**唯一**例外实现：
 * 只覆盖一个 `.skp` 文件，目录里其它文件一个字节都不动。
 *
 * ## 原子写（勘察 §R4）
 *
 * 一律 `<name>.skp.tmp` → `rename` 就位（同目录同卷 = 原子替换，先例
 * `pluginExport.ts:59/165`）。**绝不 `fs.rm` 原文件**：删完再写会在"写一半失败"
 * 时把用户的模型彻底弄丢。失败时删掉自己刚建的 `.tmp`，旧文件原样还在。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isWithinRoot } from './ipcGuard'
import {
  INBOX_TMP_SUFFIX,
  describeInboxWriteError,
  isInboxJobId,
  planSkpUpdateTarget,
  resolveInboxTargetDir,
  type InboxApplyUpdatePayload,
  type InboxApplyUpdateResult
} from '../shared/inbox'

/** 注入点（主进程传真实设置；测试传临时目录） */
export interface InboxUpdateDeps {
  /** 库根（`settings.libraryDir`）；空串 = 还没设置库 */
  libraryDir: string
  /** `%APPDATA%\idbox_export\incoming`（源文件必须落在这里面） */
  incomingDir: string
}

/** 统一的失败形状（**不抛错**：IPC 表面只有一种形状） */
function fail(reason: string): InboxApplyUpdateResult {
  return { ok: false, reason }
}

/** `fs` 错误 → 错误码（`NodeJS.ErrnoException` 的 `code` 可能缺失） */
function codeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 把收件箱任务里的 `.skp` **就地覆盖**库内同名 `.skp`。
 *
 * 完整流程（每一步的失败分支都返回中文原因，调用方原样给用户看）：
 *
 * 1. **入参三查**：`jobId` 必须是合法 jobId（`YYYYMMDD-HHmmss-xxxx`）、库目录已设置且是绝对路径；
 * 2. **源文件必须在 `incoming\<jobId>\` 里**：渲染层传的 `skpSourcePath` 不可信，
 *    用 `path.relative(jobDir, src)` 判「直接子文件」（不含分隔符、不以 `..` 开头），
 *    再用 `isWithinRoot` 兜一道 —— 否则被打穿的渲染层可以把任意库外文件写进库内；
 * 3. **读目标目录**：`readdir` 失败（目录不存在 / 无权）→ 判废；
 * 4. **推导目标文件名**：`planSkpUpdateTarget`（同名优先 → 唯一 `.skp` 兜底 → 其余判废）；
 * 5. **路径越界复检**：`isWithinRoot(libraryDir, targetAbs)`（用既有守卫，另写一套必然漂移）；
 * 6. **原子写**：`copyFile(源, target + '.tmp')` → `rename(tmp, target)`；
 *    失败删 tmp 并翻译错误码（`EBUSY` → 「请先在 SketchUp 里关闭该文件」）。
 *
 * ⚠️ 第 2 步的 `stat` 也顺带拿到字节数（写进结果供日志对账）。
 * ⚠️ 只碰 `.skp` 一个文件：**不删目录、不写 renderParams.json、不动 cover 文件**。
 */
export async function applyInboxSkpUpdate(
  payload: unknown,
  deps: InboxUpdateDeps
): Promise<InboxApplyUpdateResult> {
  const raw = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<InboxApplyUpdatePayload>
  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : ''
  const targetRelFolder = typeof raw.targetRelFolder === 'string' ? raw.targetRelFolder : ''
  const skpSourcePath = typeof raw.skpSourcePath === 'string' ? raw.skpSourcePath.trim() : ''

  // ── ① 入参三查 ────────────────────────────────────────────────
  if (!isInboxJobId(jobId)) {
    return fail('任务编号不合法：更新通道只处理收件箱里的任务（jobId 形如 20261109-184000-ab12）')
  }
  const libraryDir = typeof deps?.libraryDir === 'string' ? deps.libraryDir.trim() : ''
  if (libraryDir.length === 0) {
    return fail('库目录尚未设置，无法更新模型。请先在「设置 → 库」里选择库目录')
  }
  if (skpSourcePath.length === 0) return fail('源文件路径为空，无法更新')

  // ── ② 源文件必须直接躺在 incoming\<jobId>\ 里 ──────────────────
  const jobDir = path.resolve(deps.incomingDir, jobId)
  const srcAbs = path.resolve(skpSourcePath)
  if (!isWithinRoot(jobDir, srcAbs)) {
    return fail('源文件不在该任务的收件箱目录里，已拒绝（只允许用 %APPDATA%\\idbox_export\\incoming 里的文件更新）')
  }
  const relToJobDir = path.relative(jobDir, srcAbs)
  if (relToJobDir.length === 0 || relToJobDir.includes(path.sep) || relToJobDir.startsWith('..')) {
    return fail('源文件必须是任务目录下的直接文件（不允许子目录或穿出任务目录）')
  }
  if (path.extname(srcAbs).toLowerCase() !== '.skp') {
    return fail('源文件不是 .skp，无法更新')
  }
  let srcSize = 0
  try {
    const st = await fs.stat(srcAbs)
    if (!st.isFile()) return fail('源文件不是普通文件，无法更新')
    if (st.size <= 0) return fail('源文件是空的（0 字节），可能是插件导出失败，已取消更新')
    srcSize = st.size
  } catch (err) {
    return fail(`读不到源文件（${srcAbs}）：${describeInboxWriteError(codeOf(err), path.basename(srcAbs))}`)
  }

  // ── ③ 解析目标目录（纯字符串：库根 + relFolder）──────────────────
  const dir = resolveInboxTargetDir(libraryDir, targetRelFolder, path.sep)
  if (!dir.ok) return fail(dir.reason)
  const targetDirAbs = dir.targetDirAbs

  let existingNames: string[]
  try {
    existingNames = await fs.readdir(targetDirAbs)
  } catch (err) {
    const code = codeOf(err)
    if (code === 'ENOENT') {
      return fail(
        `库里找不到这个模型的目录（${dir.relSegments.join('/')}）——分类目录可能被改过，请先在 ID BOX 里重新扫描库`
      )
    }
    return fail(`读不到目标目录（${dir.relSegments.join('/')}）：${code ?? '未知错误'}`)
  }

  // ── ④ 推导要覆盖的那一个 .skp ─────────────────────────────────
  const plan = planSkpUpdateTarget({
    libraryDir,
    targetRelFolder,
    skpFileName: path.basename(srcAbs),
    existingNames,
    sep: path.sep
  })
  if (!plan.ok) return fail(plan.reason)

  // ── ⑤ 越界复检（用既有守卫，绝不自己写一套包含判定）──────────────
  const resolvedTarget = path.resolve(plan.targetAbs)
  if (!isWithinRoot(path.resolve(libraryDir), resolvedTarget)) {
    return fail('目标路径不在库目录内，已拒绝（这是一次越界写入尝试）')
  }
  if (resolvedTarget === srcAbs) return fail('源文件与目标文件是同一个文件，已跳过')

  // ── ⑥ 原子写：先写 .tmp 再 rename 就位 ─────────────────────────
  const tmp = resolvedTarget + INBOX_TMP_SUFFIX
  // 残留的 .tmp（上一次崩溃留下的）先清掉：不清的话 copyFile 会直接覆盖它，无害，
  // 但 rename 失败后我们删的是自己这份 —— 显式清一次让"失败分支"的语义更干净。
  await fs.rm(tmp, { force: true }).catch(() => {})
  try {
    await fs.copyFile(srcAbs, tmp)
    await fs.rename(tmp, resolvedTarget)
  } catch (err) {
    const code = codeOf(err)
    // 删掉自己刚建的半成品；**绝不动被覆盖的原文件**（它还在原位）
    await fs.rm(tmp, { force: true }).catch(() => {})
    return fail(describeInboxWriteError(code, plan.targetName))
  }

  return {
    ok: true,
    targetAbs: resolvedTarget,
    targetName: plan.targetName,
    bytes: srcSize,
    selection: plan.selection
  }
}
