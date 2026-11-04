/**
 * ID BOX · SketchUp 插件包（`.rbz`）打包 —— `docs/39` §4.1 / §4.2 / §4.3 的落地（**导出侧**）。
 *
 * ## 口径（都不许改，改了就装不上）
 * - `.rbz` = **改名的 ZIP**（§4.1 第 1 条，用户 2026-11-04 拍板：ID BOX 只导出 `.rbz`）。
 * - ZIP 根**恰好两项**（§4.2）：`idbox_panel.rb` + `idbox_panel/`（同名支持目录树）。
 *   官方 Extension 打包要求就是这两项，多一项少一项都可能不被扩展管理器登记 ⇒ 本文件
 *   在**写盘之前**先断言，不靠"大概没问题"。
 * - 用户选定的形态是「ID BOX 只导出 + 引导用户去扩展管理器安装」（§4.3 形态①）：
 *   所以这里**不联网、不下载、不执行代码、不往 Plugins 目录复制**，只产出一个文件。
 *   形态②（自动复制到 Plugins 目录）V1.0 明确不采用 —— 不要在这里"顺手"实现它。
 * - 源码根**除两项外一律报错**（不静默塞、也不静默丢），唯一白名单是 `README.md`
 *   （工程说明，本就不属于包；见 `RBZ_SOURCE_IGNORED_ENTRIES` 的注释）。
 *
 * ## 与 `pluginExport.ts` 同一套写盘纪律
 * 1. **原子写**：写 `<file>.tmp` 再 `rename`（同 `src/main/pluginExport.ts` 的 `atomicWriteJson`、
 *    `src/main/settings.ts:217-220`）。写到一半崩溃 → 用户看到的是"没有这个文件"，而不是
 *   一个会让 SketchUp 报"版本无效"的半截 ZIP。
 * 2. **串行写队列**：固定 tmp 名 + 并发 = 内容互相覆盖（`src/main/settings.ts:225-238` 的实测
 *    现场）。用户连点两次导出会选到同一个路径，所以这里也串起来，理由与 `pluginExport.ts`
 *    完全一致：**修法是串行，不是随机 tmp 名**。
 * 3. **不抛异常**：一切失败都收敛成 `{ ok: false, error }`，让 IPC 层原样交给 UI 显示。
 *
 * ## 为什么 `srcDir` 是参数
 * 生产调用方传 `plugin-src/` 的解析结果（见 `resolvePluginSrcDir`），单测传临时 fixture 目录。
 * 本文件**不 import electron**：`app.getVersion()` / `process.resourcesPath` 全部由调用方注入，
 * 否则 `tests/pluginPackage.test.ts`（vitest `environment: 'node'`）根本跑不起来。
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'

/** 源码目录名（仓库根 / 打包后的 `resources/` 下都是这个名字） */
export const RBZ_SRC_DIR_NAME = 'plugin-src'
/** 根注册文件（只做扩展注册，纯 ASCII 文件名 —— §4.2 / §4.4 第 1 条） */
export const RBZ_ROOT_RB_FILE_NAME = 'idbox_panel.rb'
/** 支持目录名（= 根 `.rb` 去掉后缀，§4.2 硬要求） */
export const RBZ_SUPPORT_DIR_NAME = 'idbox_panel'
/** 支持目录在 ZIP 内的条目名（目录条目必须带尾斜杠） */
export const RBZ_SUPPORT_DIR_ENTRY = `${RBZ_SUPPORT_DIR_NAME}/`
/** 分发后缀（`.rbz` 不是 `.rb`） */
export const RBZ_EXTENSION = '.rbz'
/** 原子写的临时文件后缀（与 `pluginExport.ts` 的 `PLUGIN_TMP_SUFFIX` 同名同义） */
export const RBZ_TMP_SUFFIX = '.tmp'
/** ZIP 根必须恰好这两项（§4.2，断言用的唯一真相源） */
export const RBZ_TOP_LEVEL_ENTRIES = [RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_ENTRY] as const

/**
 * 源码根里**允许存在但不进包**的条目（白名单，逐条列出，绝不按模式匹配）。
 *
 * 为什么需要它：`plugin-src/README.md` 是给工程师看的说明（怎么安装、V1.0 支持什么），
 * 从设计上就**不属于**插件包（它自己的「目录结构」一节写的也是「`.rbz` 根里恰好两项」）。
 * 如果按"源码根必须一字不多"来判，这个 README 会让导出**永久失败**——那就把一条正确的
 * 安全守卫变成了产品缺陷。
 *
 * 白名单只有一条，且**其余任何杂项仍然报错并点名**：这条守卫真正要防的不是"多一个说明
 * 文件"，而是"作者以为会进包的第二个 `.rb` 被静默丢掉"（本模块只打那两项）。
 */
export const RBZ_SOURCE_IGNORED_ENTRIES = ['README.md'] as const

/**
 * 打包结果。**只有两种形态**，没有第三个"成功了一半"：
 * - `ok: true` → `bytes` = 落盘字节数，`entries` = ZIP 根的两个顶层条目（顺序与
 *   `RBZ_TOP_LEVEL_ENTRIES` 一致），调用方可以原样显示给用户；
 * - `ok: false` → `error` 是给用户看的中文文案（含具体文件名 / 路径），不是错误码。
 */
export type BuildRbzResult =
  | { ok: true; bytes: number; entries: string[] }
  | { ok: false; error: string }

/** `buildRbz` 的可注入项（生产不传；测试用来钉死时间戳 / 覆盖期望条目） */
export interface BuildRbzOptions {
  /**
   * 期望的 ZIP 根条目集合。默认 `RBZ_TOP_LEVEL_ENTRIES`。
   * **生产不要传**——它是断言用的常量，开成参数只为让单测能验证"断言真的在断言"。
   */
  expectedEntries?: readonly string[]
  /** ZIP 内文件时间戳（默认当前时刻）。可注入 → 构建结果可重复，测试不必等时间 */
  now?: () => Date
}

/** 打包上下文（由 `index.ts` 注入，避免本文件依赖 electron） */
export interface RbzSourceContext {
  /** 是否已打包（`app.isPackaged`） */
  isPackaged: boolean
  /** `app.getAppPath()`：dev 下就是仓库根 */
  appPath: string
  /** `process.resourcesPath`：打包后 `plugin-src` 随 `extraResources` 落在这里 */
  resourcesPath: string
}

// ── 路径解析（dev vs 打包）───────────────────────────────────────────────────

/**
 * 解析 `plugin-src/` 的绝对路径。
 *
 * - dev（`!app.isPackaged`）：`<仓库根>/plugin-src`，仓库根取 `app.getAppPath()`
 *   （electron-vite dev 下它就是项目根；不用 `process.cwd()`，那条会随启动方式漂移）；
 * - 打包：`<process.resourcesPath>/plugin-src`，靠 `package.json` 的
 *   `build.extraResources` 真的把它塞进 `resources/`。
 *
 * 纯函数、**永不抛异常**：`resourcesPath` 缺失（异常环境）时退回 `appPath`，让上层的
 * 「源目录不存在」错误把真实路径报出来，而不是在这里抛一个用户看不懂的异常。
 */
export function resolvePluginSrcDir(ctx: RbzSourceContext): string {
  const resourcesPath = typeof ctx.resourcesPath === 'string' ? ctx.resourcesPath.trim() : ''
  if (ctx.isPackaged && resourcesPath) {
    return path.join(resourcesPath, RBZ_SRC_DIR_NAME)
  }
  const base = typeof ctx.appPath === 'string' && ctx.appPath.trim() ? ctx.appPath.trim() : process.cwd()
  return path.join(base, RBZ_SRC_DIR_NAME)
}

/**
 * 默认输出文件名 `idbox_panel-<appVersion>.rbz`（§4.3 分发层命名）。
 * 版本号取 `app.getVersion()`，本函数只负责拼名字（空值回落到 `0.0.0`，不产生
 * `idbox_panel-.rbz` 这种让人怀疑的产物）。
 */
export function defaultRbzFileName(appVersion: string): string {
  const version = typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim() : '0.0.0'
  return `${RBZ_SUPPORT_DIR_NAME}-${version}${RBZ_EXTENSION}`
}

// ── 串行写队列（与 `pluginExport.ts` 同两条不变量）────────────────────────────

let writeChain: Promise<unknown> = Promise.resolve()

/**
 * 把一次写盘动作排到链尾。
 *
 * 两条不变量逐字保留（`src/main/pluginExport.ts:createPluginWriteQueue`）：
 * 1. `writeChain.then(fn, fn)` —— 前一次失败时**仍要执行**这一次，否则一个 EBUSY 会把链永久挂住；
 * 2. `writeChain = next.catch(() => undefined)` —— 链自己**不持有 rejection**，失败只回传给该次调用方。
 */
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => undefined)
  return next
}

// ── 源目录检查 ────────────────────────────────────────────────────────────────

/** `stat` 的安全包装：任何错误（ENOENT / EACCES / 非法字符）都只是 `false`，不抛 */
async function kindOf(target: string): Promise<'file' | 'dir' | 'other' | 'missing'> {
  try {
    const s = await stat(target)
    if (s.isFile()) return 'file'
    if (s.isDirectory()) return 'dir'
    return 'other'
  } catch {
    return 'missing'
  }
}

/** 源码根检查的结论：要么拿到两个真实路径，要么拿到一句能直接显示的错误 */
type SourceRootCheck =
  | { ok: true; rootFile: string; supportDir: string }
  | { ok: false; error: string }

/**
 * 检查源码目录的**顶层**是否恰好两项。
 *
 * 为什么顶层也要查（不只是打完包再查 ZIP）：源目录里多出个 `.DS_Store` / 打包前误放的
 * `dist/` / 第二个 `.rb`，都会**让作者以为它进包了**（而本模块只打那两项）。宁可报错让用户
 * 看见，也不静默丢掉——静默丢掉的症状同样是「扩展管理器装完没反应」，用户无从判断哪里错了。
 *
 * 唯一例外是 `RBZ_SOURCE_IGNORED_ENTRIES`（当前只有 `README.md`，工程说明，本身就不属于包），
 * 见该常量的注释。
 */
async function checkSourceRoot(srcDir: string, expected: readonly string[]): Promise<SourceRootCheck> {
  const dirKind = await kindOf(srcDir)
  if (dirKind === 'missing') {
    return { ok: false, error: `插件源码目录不存在：${srcDir}` }
  }
  if (dirKind !== 'dir') {
    return { ok: false, error: `插件源码路径不是目录：${srcDir}` }
  }

  let names: string[]
  try {
    const items = await readdir(srcDir, { withFileTypes: true })
    names = items.map((it) => it.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch (err) {
    return { ok: false, error: `插件源码目录不可读：${srcDir}（${errorText(err)}）` }
  }

  const rootFile = path.join(srcDir, RBZ_ROOT_RB_FILE_NAME)
  const supportDir = path.join(srcDir, RBZ_SUPPORT_DIR_NAME)

  if ((await kindOf(rootFile)) !== 'file') {
    return { ok: false, error: `插件源码缺少根注册文件：${RBZ_ROOT_RB_FILE_NAME}（应位于 ${srcDir}）` }
  }
  if ((await kindOf(supportDir)) !== 'dir') {
    return { ok: false, error: `插件源码缺少支持目录：${RBZ_SUPPORT_DIR_ENTRY}（应位于 ${srcDir}）` }
  }

  const allowed = new Set([RBZ_ROOT_RB_FILE_NAME, RBZ_SUPPORT_DIR_NAME])
  const ignored = new Set<string>(RBZ_SOURCE_IGNORED_ENTRIES)
  const stray = names.filter((n) => !allowed.has(n) && !ignored.has(n))
  if (stray.length > 0) {
    return {
      ok: false,
      error:
        `插件源码根必须恰好两项（${RBZ_ROOT_RB_FILE_NAME} + ${RBZ_SUPPORT_DIR_ENTRY}），` +
        `但多出了：${stray.join('、')}（实际 ${names.length} 项）`
    }
  }
  const packagingEntries = names.filter((n) => !ignored.has(n))
  if (packagingEntries.length !== expected.length) {
    // 理论上不可达（上面两个 kindOf 已经把缺项挡掉了），留一条兜底把不一致说清楚
    return {
      ok: false,
      error: `插件源码根必须恰好两项（${RBZ_ROOT_RB_FILE_NAME} + ${RBZ_SUPPORT_DIR_ENTRY}），实际：${packagingEntries.join('、') || '（空目录）'}`
    }
  }

  return { ok: true, rootFile, supportDir }
}

/** `unknown` → 可显示文本（`Error.message` 优先，绝不抛） */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ── 组装 ZIP ─────────────────────────────────────────────────────────────────

/** 加一条目录条目（`entryName` 必须以 `/` 结尾，adm-zip 靠这个判目录） */
function addDirEntry(zip: AdmZip, entryName: string, mtime: Date): void {
  const entry = zip.addFile(entryName, Buffer.alloc(0), '')
  entry.header.time = mtime
}

/** 加一个文件条目（内容取自磁盘；`zipName` 是 posix 相对路径） */
async function addFileEntry(zip: AdmZip, absPath: string, zipName: string, mtime: Date): Promise<void> {
  const data = await readFile(absPath)
  const entry = zip.addFile(zipName, data, '')
  entry.header.time = mtime
}

/**
 * 递归把一棵目录树打进 ZIP（含**空目录**）。
 *
 * 为什么不用 `zip.addLocalFolder()`：它只遍历文件，空目录会被丢掉。`plugin-src` 里
 * `native/<platform>/<rubyVer>/` 这类"只立约定、暂不产出文件"的目录（§4.2 末两条）正需要
 * 保留；丢掉的后果是将来往包里加原生件时目录结构要靠猜。自己走一遍 + `zip.addFile()`
 * 仍然是"用 adm-zip 生成 ZIP"，不是手写 ZIP 格式。
 *
 * 排序固定（按名字升序）→ 同一份源码产出的字节序稳定，便于比对与排查。
 */
async function addTree(zip: AdmZip, absDir: string, zipPrefix: string, mtime: Date): Promise<number> {
  const items = await readdir(absDir, { withFileTypes: true })
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  let count = 0
  for (const item of items) {
    const abs = path.join(absDir, item.name)
    const zipName = `${zipPrefix}/${item.name}`
    if (item.isDirectory()) {
      addDirEntry(zip, `${zipName}/`, mtime)
      count += await addTree(zip, abs, zipName, mtime)
      continue
    }
    if (!item.isFile()) {
      // 符号链接 / 设备文件：不猜语义，直接报错（猜错就是打出一个坏包）
      throw new Error(`插件源码含非普通文件（符号链接等）：${abs}`)
    }
    await addFileEntry(zip, abs, zipName, mtime)
    count += 1
  }
  return count
}

/**
 * 把 ZIP 条目名收敛成"顶层项"：
 * `idbox_panel.rb` → `idbox_panel.rb`；`idbox_panel/` → `idbox_panel/`；
 * `idbox_panel/main.rb` → `idbox_panel/`。反斜杠一并归一（Windows 上也照 posix 判）。
 */
export function topLevelEntries(entryNames: readonly string[]): string[] {
  const set = new Set<string>()
  for (const raw of entryNames) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const name = raw.replace(/\\/g, '/')
    const slash = name.indexOf('/')
    if (slash >= 0) set.add(name.slice(0, slash + 1))
    else set.add(name)
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** 两个「顶层项集合」是否严格相等（顺序无关；两边都先排序） */
function sameEntrySet(actual: readonly string[], expected: readonly string[]): boolean {
  const a = [...actual].sort()
  const b = [...expected].sort()
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// ── 原子写 ───────────────────────────────────────────────────────────────────

/**
 * 原子写：`mkdir -p` 父目录 → 写 `.tmp` → `rename` 覆盖。
 *
 * 父目录不存在时**建出来**（保存对话框给的路径可能是用户刚敲出来的新目录；
 * 直接 ENOENT 报错等于让用户自己去建目录，没必要）。`rename` 失败时删掉 `.tmp`，
 * 不留残留（`tests/pluginPackage.test.ts` 的 (e) 项就钉这个）。
 */
async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}${RBZ_TMP_SUFFIX}`
  await writeFile(tmp, data)
  try {
    await rename(tmp, filePath)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 把 `srcDir` 打成 `outPath`（`.rbz`）。
 *
 * 顺序（每一步失败都收敛成 `ok:false`，绝不抛）：
 * ① 检查源码根 = 恰好两项（多一项就报错，点名是谁）；
 * ② 用 adm-zip 组装：根 `.rb` + `idbox_panel/` 目录条目 + 整棵支持目录树（含空目录）；
 * ③ **重新读一遍产出的字节**并断言 ZIP 根恰好两项 —— 断言对象必须是"真正要落盘的那份
 *    字节"，不是内存里的对象（`pluginExport.ts` 里 SHA256 必须算在同一份字符串上，同理）；
 * ④ 串行队列内原子写（`.tmp` + `rename`）。
 *
 * @param srcDir 源码目录（生产 = `resolvePluginSrcDir()`；测试 = 临时 fixture）
 * @param outPath 目标 `.rbz` 路径（父目录不存在会被创建）
 * @param opts 可注入项（时间戳 / 期望条目；生产不传）
 */
export async function buildRbz(
  srcDir: string,
  outPath: string,
  opts: BuildRbzOptions = {}
): Promise<BuildRbzResult> {
  const expected = opts.expectedEntries ?? RBZ_TOP_LEVEL_ENTRIES
  const mtime = opts.now ? opts.now() : new Date()

  if (typeof srcDir !== 'string' || !srcDir.trim()) {
    return { ok: false, error: '未指定插件源码目录' }
  }
  if (typeof outPath !== 'string' || !outPath.trim()) {
    return { ok: false, error: '未指定插件包输出路径' }
  }

  const checked = await checkSourceRoot(srcDir, expected)
  if (!checked.ok) return { ok: false, error: checked.error }

  let buffer: Buffer
  try {
    const zip = new AdmZip()
    // ① 根注册文件（必须在 ZIP 根，一项不多一项不少）
    await addFileEntry(zip, checked.rootFile, RBZ_ROOT_RB_FILE_NAME, mtime)
    // ② 支持目录条目 + 整棵树（目录条目保留，空目录也不丢）
    addDirEntry(zip, RBZ_SUPPORT_DIR_ENTRY, mtime)
    await addTree(zip, checked.supportDir, RBZ_SUPPORT_DIR_NAME, mtime)
    buffer = zip.toBuffer()
  } catch (err) {
    return { ok: false, error: `打包失败：${errorText(err)}` }
  }

  // ③ 断言对象 = 真正要落盘的那份字节
  let actualEntries: string[]
  try {
    const verify = new AdmZip(buffer)
    actualEntries = topLevelEntries(verify.getEntries().map((e) => e.entryName))
  } catch (err) {
    return { ok: false, error: `插件包自检失败（无法回读刚生成的 ZIP）：${errorText(err)}` }
  }
  if (!sameEntrySet(actualEntries, expected)) {
    return {
      ok: false,
      error:
        `插件包根必须恰好两项（${[...expected].join(' + ')}），` +
        `实际为：${actualEntries.join('、') || '（空包）'}`
    }
  }

  // ④ 原子写（串行，理由见文件头第 2 条）
  try {
    await enqueueWrite(() => atomicWriteFile(outPath, buffer))
  } catch (err) {
    return { ok: false, error: `写入插件包失败：${outPath}（${errorText(err)}）` }
  }

  return { ok: true, bytes: buffer.length, entries: [...expected] }
}
