/**
 * ID BOX 写盘侧（插件导出）—— `docs/39` §2–§3 的落地。
 *
 * ## 分层（照 docs/39 §2.1 定案）
 * - **渲染层生成内容**：读 Dexie → 按 §3.2 字段子集序列化 → 把记录交给主进程（渲染层
 *   没有任何 Node 能力，`README.md:285`、preload 全文无 `node:fs`）。先例是
 *   `IPC.indexBackup`（`src/shared/ipc.ts:78`、`src/main/index.ts:1832-1849`）。
 * - **主进程执行 IO**：本文件。字段表在 `src/shared/pluginSnapshot.ts`（两侧共用同一份），
 *   时间语义在 `src/main/pluginThrottle.ts`，本文件只干四件事：目录、原子写、串行队列、SHA256。
 *
 * ## 三条硬纪律（都不许退化）
 * 1. **串行写队列**：`docs/39 §2.1` 明确「文件锁这条建议取消，修法是串行写队列」——单实例锁
 *    已保证单写者（`src/main/index.ts:886-888`、`:976-981`），真风险是**固定 tmp 名 + 无串行**
 *    （`src/main/settings.ts:225-238` 的实测现场：rename ENOENT 与更隐蔽的内容互相覆盖）。
 *    这里另立一条独立链（不与 settings 共用），但保留同样两条不变量：`then(fn, fn)`（前次失败
 *    仍继续）与「链不持有 rejection」。
 * 2. **原子写**：写 `<file>.tmp` 再 `rename`（照 `src/main/materialMerge.ts:267-277` 的 JSON
 *    原子写先例）。tmp 名固定是刻意的（同目录同卷才原子、崩溃残留可预测、插件侧只需忽略
 *    `*.tmp*`）。换随机 tmp 名只能消 ENOENT，治不了乱序 —— 所以修法是串行。
 * 3. **写入顺序**（§3.1 硬约定）：① 生成 index 内容 → ② tmp+rename 成 `index.json` →
 *    ③ 算 SHA256 → ④ tmp+rename 成 `manifest.json`。SHA256 必须算在**同一份落盘字符串**上，
 *    所以先 serialize 再写，绝不重序列化。
 *
 * ## 失败纪律（§2.3）
 * 写盘失败**不阻断主流程**（照 `src/main/kindMigrate.ts:256-261` 的「仅 warn、不阻断」口径，
 * 但不照抄它的非原子写），且**绝不写空内容掩盖失败**：取不到内容时保留上一份有效快照，把失败
 * 记进 `manifest.lastError` —— 读者看到「旧但完整 + 明确的错误状态」，不是空文件。
 * 因此本文件的任何一次失败只做三件事：`logWarn` + `state='error'` + 不动上一份文件。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { logWarn } from './logger'
import { createPluginThrottle, systemClock } from './pluginThrottle'
import type { ThrottleClock, ThrottlePending } from './pluginThrottle'
import {
  FRESHNESS_HINT_SECONDS,
  MAX_INDEX_BYTES,
  MAX_RECORDS,
  PLUGIN_API_VERSION,
  PLUGIN_APP_DIR_NAME,
  PLUGIN_DIR_NAME,
  PLUGIN_INDEX_FILE_NAME,
  PLUGIN_MANIFEST_FILE_NAME,
  byteLengthUtf8,
  buildPluginEnvelope,
  isPluginTrigger,
  scaleBranch,
  serializeCompact,
  toPosix,
  type PluginLastErrorCode,
  type PluginManifest,
  type PluginSnapshotRecord,
  type PluginTrigger,
  type ScaleBranch
} from '../shared/pluginSnapshot'

/** 原子写的临时文件后缀（固定名：插件侧「忽略一切 `*.tmp*`」的判据就是它） */
export const PLUGIN_TMP_SUFFIX = '.tmp'

// ── 路径（§2.2 / PRD D1）────────────────────────────────────────────────────
//
// `docs/39 §2.2` 的用词是 `userDataDir()`（`src/main/paths.ts:15-18` = `app.getPath('userData')`）。
// 本模块按用户口径直接从 `process.env.APPDATA` 解析：两者在 Windows 上等价（package.json 的
// `name` = `idbox` ⇒ userData = `%APPDATA%\idbox`），但这里**不另立第二套根、也不依赖 electron**：
// 纯环境变量解析可单测，且插件侧（Ruby）用的就是 `ENV['APPDATA']`，两侧读同一来源最不易漂移。

/**
 * 解析插件落盘根目录：`%APPDATA%\idbox\plugin\`。
 *
 * 纯函数、可注入 env、**永不抛异常**。拿不到 APPDATA（非 Windows / 未注入）返回 null ——
 * 调用方据此放弃写盘并记 warn，绝不回落到某个猜测路径（「插件不能猜路径」是用户原话）。
 */
export function resolvePluginRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const appdata = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : ''
  if (!appdata) return null
  return path.join(appdata, PLUGIN_APP_DIR_NAME, PLUGIN_DIR_NAME)
}

/** 生产入口（读 `process.env`） */
export function pluginRootDir(): string | null {
  return resolvePluginRoot(process.env)
}

/** 两个固定文件名的绝对路径（固定名是硬要求：插件不能猜路径） */
export function pluginIndexPath(dir: string): string {
  return path.join(dir, PLUGIN_INDEX_FILE_NAME)
}

export function pluginManifestPath(dir: string): string {
  return path.join(dir, PLUGIN_MANIFEST_FILE_NAME)
}

// ── 串行写队列（§2.1：修法是这个，不是文件锁、也不是随机 tmp 名）─────────────

/** 插件写盘串行队列（纯逻辑、零 IO，可单测） */
export interface PluginWriteQueue {
  /** 把一次写盘动作排到链尾；返回的 Promise 兑现这一次任务自己的结果/错误 */
  enqueue<T>(fn: () => Promise<T>): Promise<T>
  /** 队列**排空**后 resolve（失败也算排空）；永不 reject，方便测试收尾 */
  idle(): Promise<void>
}

/**
 * 创建插件写盘串行队列。
 *
 * 与 `createSettingsWriteQueue()`（`src/main/settings.ts:267-277`）同语义，但**是另一条链**：
 * 插件快照与 settings 是两份不同的文件，共用一条链会让「插件写盘失败」把设置保存也堵住。
 * 两条不变量逐字保留：
 * 1. `writeChain.then(fn, fn)` —— **前一次失败时仍要执行这一次**，否则一个 EBUSY 会把链永久挂住；
 * 2. `writeChain = next.catch(() => undefined)` —— 链自己**不持有 rejection**（正是 0.7.10 那个
 *    bug 冒到渲染层的形态），失败只回传给该次的调用方。
 */
export function createPluginWriteQueue(): PluginWriteQueue {
  let writeChain: Promise<unknown> = Promise.resolve()
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const next = writeChain.then(fn, fn)
      writeChain = next.catch(() => undefined)
      return next
    },
    idle(): Promise<void> {
      return writeChain.then(
        () => undefined,
        () => undefined
      )
    }
  }
}

/** 全进程唯一的插件写队列（单实例锁保证只有一个进程会用它） */
const pluginWriteQueue = createPluginWriteQueue()

/**
 * 把一次写盘动作排进串行队列。
 * 任何新增的「写 `plugin/*.json`」路径都**必须**经过这里，否则又会绕过串行化。
 */
export function enqueuePluginWrite<T>(fn: () => Promise<T>): Promise<T> {
  return pluginWriteQueue.enqueue(fn)
}

/** 等待插件写队列排空（测试 / 退出前用；永不 reject） */
export function pluginWritesIdle(): Promise<void> {
  return pluginWriteQueue.idle()
}

// ── SHA256 与原子写 ──────────────────────────────────────────────────────────

/**
 * SHA256（小写 64 hex）。
 * 输入必须是**即将落盘的那一份字符串**，不能是「再序列化一次」的结果 ——
 * 否则插件重算比对必然对不上（§3.4 第 3 条）。
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 原子写：写 tmp → rename 覆盖。
 * `rename` 失败时**原文件保持不动**（§3.4 第 7 条）⇒ 插件仍看到一份完整可用的旧快照，
 * 降级是优雅的。这里**不做盲目重试**（§3.4 第 7 条明确主进程侧不重试）。
 */
async function atomicWriteJson(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}${PLUGIN_TMP_SUFFIX}`
  await writeFile(tmp, text, 'utf-8')
  await rename(tmp, filePath)
}

// ── 一次完整落盘（§3.1 写入顺序）─────────────────────────────────────────────

/** 写盘上下文（由 `index.ts` 注入；本文件不 import electron，便于单测） */
export interface PluginWriteContext {
  /** 插件根目录（由 `resolvePluginRoot` 解析） */
  dir: string
  /** `app.getVersion()` 口径 */
  appVersion: string
  /** `settings.libraryDir`（manifest 里写成 posix 绝对路径） */
  libraryRoot: string
  /** 开关状态（false → 不落盘；插件读不到文件即 IDBOX-101） */
  pluginIndexEnabled: boolean
  /** `thumbsDir()`（§3.1：manifest 必须暴露它，插件直接读本地缩略图） */
  thumbsRoot: string
  /** 记录/信封生成时刻（ISO8601 UTC，照 `logger.ts:199` 口径），可注入便于测试 */
  now?: () => string
}

/** 一次写盘的结果（可观测形态只有两种：成功，或记进 lastError） */
export interface PluginWriteResult {
  ok: boolean
  trigger: string
  /** 规模判据分支（§3.3 写死） */
  branch: ScaleBranch
  indexBytes: number
  indexCount: number
  indexSha256: string
  error: PluginLastErrorCode | null
}

/** 失败码（§5：不新增码 —— 写侧失败能归入 101/102 就归入） */
function writeError(code: string, message: string, at: string): PluginLastErrorCode {
  return { code, message, at }
}

/** 失败结果骨架（保证调用方拿到的字段形状与成功时一致） */
function failedResult(trigger: string, branch: ScaleBranch, error: PluginLastErrorCode): PluginWriteResult {
  return { ok: false, trigger, branch, indexBytes: 0, indexCount: 0, indexSha256: '', error }
}

/**
 * 执行一次完整落盘，顺序照 §3.1：① 生成内容 → ② index（tmp+rename）→ ③ SHA256 → ④ manifest。
 *
 * 三条前置守卫（都属「绝不写空内容掩盖失败」）：
 * - 开关关：不落盘（插件读到 `pluginIndexEnabled:false` → IDBOX-101 的「未开导出」文案）；
 * - 触发点不在白名单：拒（deny by default，缩略图涓流就是典型）；
 * - 取不到内容（`null`）：不落盘、保留上一份，只记 error。
 *
 * ⚠️ 规模判据（§3.3）：超阈值时 V1.0 **没有增量协议可走**（§3.3 明写「这是 V1.0 之后的事，
 * 本轮不设计增量协议」）。唯一安全行为 = 拒写 + 保留上一份有效快照 + 记 error。码表 107–110
 * 是「预留但不定义」，所以只能归入 102；真实语义写在 `message` 里，不让用户猜码。
 * 这一条是「无法按规格实现」项，已在最终报告中如实列出。
 */
export async function writePluginSnapshot(
  records: readonly PluginSnapshotRecord[] | null,
  trigger: string,
  ctx: PluginWriteContext
): Promise<PluginWriteResult> {
  const at = ctx.now ? ctx.now() : new Date().toISOString()

  if (!ctx.pluginIndexEnabled) {
    logWarn('plugin:write:skipped', { trigger, reason: 'pluginIndexEnabled=false' })
    return failedResult(trigger, 'full', writeError('101', '插件索引导出开关未开启', at))
  }

  if (!isPluginTrigger(trigger)) {
    // deny by default：不在触发集里的事件不该走到这里（缩略图涓流就是典型）
    logWarn('plugin:write:rejected-trigger', { trigger })
    return failedResult(trigger, 'full', writeError('102', `触发点不在触发集内：${trigger}`, at))
  }

  if (!Array.isArray(records)) {
    // 「取不到内容」——保留上一份有效快照，绝不写空文件
    logWarn('plugin:write:no-content', { trigger })
    return failedResult(trigger, 'full', writeError('102', '渲染层未交付记录，保留上一份有效快照', at))
  }

  // ① 生成内容（紧凑 JSON、无 pretty-print、UTF-8 无 BOM）
  const envelope = buildPluginEnvelope(records, { generatedAt: at, libraryRoot: ctx.libraryRoot })
  const indexText = serializeCompact(envelope)
  const bytes = byteLengthUtf8(indexText)
  const branch = scaleBranch(records.length, bytes)

  if (branch === 'over-limit') {
    logWarn('plugin:write:over-limit', { trigger, count: records.length, bytes })
    return failedResult(
      trigger,
      branch,
      writeError(
        '102',
        `超出 V1.0 全量判据（>${MAX_RECORDS} 条或 >${MAX_INDEX_BYTES} 字节）：本轮拒写并保留上一份快照（增量协议未设计）`,
        at
      )
    )
  }

  try {
    return await enqueuePluginWrite(async () => {
      await mkdir(ctx.dir, { recursive: true })

      // ② index：写 tmp → rename
      await atomicWriteJson(pluginIndexPath(ctx.dir), indexText)

      // ③ SHA256：算在**同一份字符串**上（不能重新序列化）
      const digest = sha256Hex(indexText)

      // ④ manifest：写 tmp → rename
      const manifest: PluginManifest = {
        apiVersion: envelope.apiVersion,
        appVersion: ctx.appVersion,
        generatedAt: new Date().toISOString(),
        libraryRoot: toPosix(ctx.libraryRoot),
        pluginIndexEnabled: true,
        state: 'ok',
        lastError: null,
        indexSha256: digest,
        indexBytes: bytes,
        indexCount: records.length,
        thumbsRoot: toPosix(ctx.thumbsRoot),
        freshnessHintSeconds: FRESHNESS_HINT_SECONDS
      }
      await atomicWriteJson(pluginManifestPath(ctx.dir), serializeCompact(manifest))

      return {
        ok: true,
        trigger,
        branch,
        indexBytes: bytes,
        indexCount: records.length,
        indexSha256: digest,
        error: null
      }
    })
  } catch (err) {
    // 失败不阻断主流程（§2.3）：只记日志 + 把状态落进 manifest 的数据字段（§5 第 2 条）。
    // manifest 本身也写不出去（整个目录不可写）时上一份文件保持不动 —— 插件看到旧但完整的快照。
    const message = err instanceof Error ? err.message : String(err)
    logWarn('plugin:write:failed', { trigger, error: message })

    const error = writeError('102', `写盘失败：${message}`, new Date().toISOString())
    const manifest: PluginManifest = {
      apiVersion: PLUGIN_API_VERSION,
      appVersion: ctx.appVersion,
      generatedAt: error.at,
      libraryRoot: toPosix(ctx.libraryRoot),
      pluginIndexEnabled: true,
      state: 'error',
      lastError: error,
      indexSha256: sha256Hex(indexText),
      indexBytes: bytes,
      indexCount: records.length,
      thumbsRoot: toPosix(ctx.thumbsRoot),
      freshnessHintSeconds: FRESHNESS_HINT_SECONDS
    }
    try {
      // manifest 也走同一条串行链（否则又回到「固定 tmp 名 + 并发」的老问题）
      await enqueuePluginWrite(() => atomicWriteJson(pluginManifestPath(ctx.dir), serializeCompact(manifest)))
    } catch {
      /* manifest 也写不出去：保留上一份，不重试（§3.4 第 7 条） */
    }

    return failedResult(trigger, branch, error)
  }
}

// ── 节流 + 排期（§6 A1 已拍板）───────────────────────────────────────────────

/**
 * 插件写盘排期器：`节流 + 串行队列 + 上下文` 三者的接合点。
 *
 * - `schedule()` 记下**最新一次**交付的记录，交给节流决定「现在写 / 安静后写」；quiet 窗口后
 *   落盘的是**当时最新的**内容，不是第一次触发时的快照 —— 否则新内容会被旧快照覆盖。
 * - `flushNow()` = 面板「手动刷新」，绕过节流立刻落盘。
 *   ⚠️ PRD §3.5 明确：插件侧的手动刷新**不能**触发主进程写盘（插件无写权限、无 IPC）——
 *   这里的手动刷新只存在于 ID BOX 面板一侧。
 * - 开关关 / 触发点不在白名单 → 直接返回 false，不落盘。
 */
export interface PluginWriter {
  /** @returns `true` = 本次触发立即落盘；`false` = 已排进 quiet 窗口 */
  schedule(trigger: string, records: readonly PluginSnapshotRecord[] | null): boolean
  /** 立刻落盘（启动写一次 + 面板手动刷新） */
  flushNow(trigger: PluginTrigger, records: readonly PluginSnapshotRecord[] | null): Promise<PluginWriteResult>
  /** 节流排期与写队列都落定后 resolve（测试收尾用） */
  idle(): Promise<void>
  /** 当前节流排期 */
  pending(): ThrottlePending | null
}

/** 全进程唯一的排期器 */
let pluginWriter: PluginWriter | null = null

/**
 * 创建（或替换）全局排期器。
 *
 * ⚠️ 上下文**按次读取**（`PluginWriteContext | (() => PluginWriteContext)`）而不是建器时快照：
 * `pluginIndexEnabled` 和 `libraryRoot` 都会在同一进程里变（设置页开关、`chooseLibrary`）。
 * 如果建器时把值快照进 ctx，中途打开开关后 `schedule()` 仍按旧值判 false —— 用户必须重启
 * 才能生效，这不是可接受的行为；`libraryDir` 改了更会把快照写进错误的库根。
 * 传函数即可彻底消除这种陈旧值；测试传固定对象也可以（两者都支持）。
 */
export function createPluginWriter(
  ctx: PluginWriteContext | (() => PluginWriteContext),
  clock: ThrottleClock = systemClock
): PluginWriter {
  const getCtx: () => PluginWriteContext = typeof ctx === 'function' ? ctx : () => ctx
  let latest: readonly PluginSnapshotRecord[] | null = null

  const throttle = createPluginThrottle(async (trigger) => {
    await writePluginSnapshot(latest, trigger, getCtx())
  }, clock)

  const writer: PluginWriter = {
    schedule(trigger, records): boolean {
      const current = getCtx()
      if (!current.pluginIndexEnabled) return false
      if (!isPluginTrigger(trigger)) return false
      latest = records
      return throttle.hit(trigger)
    },
    async flushNow(trigger, records): Promise<PluginWriteResult> {
      latest = records
      throttle.cancel()
      return writePluginSnapshot(latest, trigger, getCtx())
    },
    async idle(): Promise<void> {
      await throttle.idle()
      return pluginWriteQueue.idle()
    },
    pending(): ThrottlePending | null {
      return throttle.pending()
    }
  }

  pluginWriter = writer
  return writer
}

/** 取当前排期器（未初始化返回 null，调用方据此跳过） */
export function getPluginWriter(): PluginWriter | null {
  return pluginWriter
}
