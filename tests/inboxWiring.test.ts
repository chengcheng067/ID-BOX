/**
 * SketchUp 插件收件箱的**接线守卫**（`docs/probe/su-export-to-idbox.md` 方案 A）。
 *
 * 为什么是源码守卫：`vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL
 * （既定选择，不引入）。所以"主进程有没有真的注册 handle / 渲染层有没有真的订阅"
 * 只能靠读文本断言 —— 与 `tests/aliasWiring.test.ts` / `tests/classifyUiWiring.test.ts`
 * 同一套 `readSrc()` 范式。**行为**由 `tests/inboxManifest.test.ts`（纯决策）与
 * `tests/inboxUpdate.test.ts`（真实落盘）兜住，本文件只守"有没有接上"。
 *
 * 每条守卫都对应一个**具体的退化形态**，写在各自的注释里。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 相对仓库根读源码（换行统一成 `\n`：工作区是 CRLF，切片断言用 `\n` 定位） */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/**
 * 剥掉**整行**注释后再断言（注释里提到 `importPaths` 不该让守卫变绿或变红）。
 *
 * ⚠️ 只认「行首」的块注释 / 行注释，不用「全量替换块注释」那种正则：
 * 源码注释里会出现带块注释起始符的 glob 字面量（`importer.ts` 的分拣注释里就有
 * 星号-星号-斜杠-星号-.skp 这种形态），全量正则会把那两字符当成块注释起点、
 * 一直吃到下一个块注释结束符为止 —— 实测会把 `if (isDir) {` 整段代码一起吞掉，
 * 守卫于是「什么都没找到」却仍然绿。（本行注释里也不写那两个字符，否则它会把
 * 上面这段注释**提前结束**，本文件直接语法错误 —— 同一个坑踩了两次。）
 */
function stripComments(src: string): string {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取 `from` 之后到 `to` 之前的片段（都找不到就返回空串，让断言直接红） */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from)
  if (i < 0) return ''
  const j = src.indexOf(to, i + from.length)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

describe('IPC 通道常量（shared/ipc.ts）', () => {
  const src = readSrc('src/shared/ipc.ts')

  it('三条通道名逐字存在（改动 = 主/预加载/渲染三处同时断）', () => {
    expect(src).toContain("inboxJob: 'inbox:job'")
    expect(src).toContain("inboxAck: 'inbox:ack'")
    expect(src).toContain("inboxApplyUpdate: 'inbox:applyUpdate'")
  })

  it('注释里写清「成功和失败都要 ack」（这是最容易漏的一条）', () => {
    expect(src).toContain('成功和失败都要调')
  })
})

describe('preload 暴露（src/preload/index.ts）', () => {
  const src = stripComments(readSrc('src/preload/index.ts'))

  it('三个方法都在，且走对应的 IPC 常量', () => {
    expect(src).toContain('onInboxJob:')
    expect(src).toMatch(/onInboxJob:[\s\S]{0,200}ipcRenderer\.on\(IPC\.inboxJob/)
    expect(src).toContain('ackInboxJob:')
    expect(src).toMatch(/ackInboxJob:[\s\S]{0,200}ipcRenderer\.invoke\(IPC\.inboxAck/)
    expect(src).toContain('applyInboxUpdate:')
    expect(src).toMatch(/applyInboxUpdate:[\s\S]{0,200}ipcRenderer\.invoke\(IPC\.inboxApplyUpdate/)
  })

  it('onInboxJob 直接挂在 api 对象里（不是条件挂载 / 不是可选属性）', () => {
    // `?` 出现在属性名上 = 类型上可选 = 渲染层还要再判一次，装配会退化成"薛定谔的订阅"
    expect(src).not.toContain('onInboxJob?:')
  })

  it('onInboxJob 返回退订函数（否则每次 init 都泄漏一个 handler）', () => {
    const body = slice(src, 'onInboxJob:', 'ackInboxJob:')
    expect(body).toContain('ipcRenderer.off(IPC.inboxJob, handler)')
  })
})

describe('主进程接线（src/main/index.ts）', () => {
  const src = stripComments(readSrc('src/main/index.ts'))

  it('启动时起收件箱监听（bootstrap 的 whenReady 里）', () => {
    expect(src).toContain('function startInbox(): void')
    expect(src).toMatch(/createWindow\(\)\n\s*restartWatcher\(\)/)
    expect(src).toMatch(/restartWatcher\(\)[\s\S]{0,400}startInbox\(\)/)
    expect(src).toMatch(/startInboxWatcher\(\(job\)/)
  })

  it('任务经 IPC.inboxJob 推给渲染层（不是只打日志）', () => {
    expect(src).toContain('target.webContents.send(IPC.inboxJob, job)')
  })

  it('两个 handle 都注册了', () => {
    expect(src).toContain('ipcMain.handle(IPC.inboxAck')
    expect(src).toContain('ipcMain.handle(IPC.inboxApplyUpdate')
  })

  it('⭐ update 通道**绝不**复用导入链路（那会丢 renderParams / 自定义封面）', () => {
    const body = slice(src, 'ipcMain.handle(IPC.inboxApplyUpdate', '})\n\n')
    expect(body).toContain('applyInboxSkpUpdate')
    expect(body).not.toContain('runImport')
    expect(body).not.toContain('importPaths')
    expect(body).not.toContain('batchChain')
  })

  it('update 通道把**主进程的** libraryDir 交给实现（不信渲染层）', () => {
    const body = slice(src, 'ipcMain.handle(IPC.inboxApplyUpdate', '})\n\n')
    expect(body).toContain('libraryDir: settings.libraryDir')
    expect(body).toContain('incomingDir: inboxIncomingDir()')
  })

  it('退出时停掉监听与派发重发', () => {
    expect(src).toMatch(/app\.on\('will-quit',[\s\S]{0,120}stopInboxWatcher\(\)/)
  })
})

describe('落盘实现（src/main/inboxUpdate.ts）', () => {
  const src = stripComments(readSrc('src/main/inboxUpdate.ts'))

  it('只用「copyFile → rename」原子替换（先例 pluginExport.ts）', () => {
    expect(src).toContain('fs.copyFile(srcAbs, tmp)')
    expect(src).toContain('fs.rename(tmp, resolvedTarget)')
    expect(src).toContain('INBOX_TMP_SUFFIX')
  })

  it('失败时删的是自己写的 .tmp，绝不 rm 目标文件', () => {
    // 唯一允许的 rm 是 `fs.rm(tmp, { force: true })`
    const rmCalls = src.match(/fs\.rm\([^)]*\)/g) ?? []
    expect(rmCalls.length).toBeGreaterThan(0)
    for (const call of rmCalls) expect(call).toContain('tmp')
    expect(src).not.toContain('recursive: true')
  })

  it('落点过既有越界守卫（isWithinRoot），不自己写包含判定', () => {
    expect(src).toContain("import { isWithinRoot } from './ipcGuard'")
    expect(src).toContain('isWithinRoot(path.resolve(libraryDir), resolvedTarget)')
    expect(src).toContain('isWithinRoot(jobDir, srcAbs)')
  })

  it('绝不 import importer / importPaths（那是覆盖档，会进回收站）', () => {
    expect(src).not.toContain("from './importer'")
    expect(src).not.toContain('importPaths')
  })
})

describe('发现与搬运（src/main/inbox.ts）', () => {
  const src = stripComments(readSrc('src/main/inbox.ts'))

  it('收件箱根在 %APPDATA% 下且与 idbox 同级（用 appData 不是 userData）', () => {
    expect(src).toContain("app.getPath('appData')")
    expect(src).not.toContain("app.getPath('userData')")
    expect(src).toContain('INBOX_ROOT_DIR_NAME')
  })

  it('只认 manifest.json 的 add 事件（不理会 change / unlink / skp 本体）', () => {
    expect(src).toContain("watcher.on('add'")
    expect(src).toContain('isInboxManifestFileName')
    expect(src).not.toContain("watcher.on('change'")
    expect(src).not.toContain("watcher.on('unlink'")
  })

  it('无 manifest 的残留目录按 24h 判废（不能误杀正在写的任务）', () => {
    expect(src).toContain('INBOX_ORPHAN_MAX_AGE_MS')
    expect(src).toMatch(/age > INBOX_ORPHAN_MAX_AGE_MS/)
  })

  it('归档只搬运不删除（done / failed 目录留给用户排查）', () => {
    expect(src).toContain("import { moveDir, pathExists } from './fsutil'")
    // 归档函数体内**不允许**出现任何删除：搬走的目录是排查凭据
    const archiveBody = slice(src, 'export async function archiveInboxJob', 'export async function ackInboxJob')
    expect(archiveBody.length).toBeGreaterThan(200)
    expect(archiveBody).not.toContain('fs.rm')
    expect(archiveBody).not.toContain('rmdir')
    expect(archiveBody).toContain('await moveDir(src, dest)')
  })

  it('done\\ 有 30 天保留期清理，且**只在启动时**扫一次（无常驻计时器）', () => {
    expect(src).toContain('export const INBOX_DONE_RETENTION_DAYS = 30')
    expect(src).toContain('export async function sweepInboxDoneArchive')
    // 启动路径上调用一次
    expect(src).toMatch(/await scanInboxIncoming\(\)[\s\S]{0,300}sweepInboxDoneArchive\(\)/)
    // 不能有 setInterval（收件箱是低频通道，不值得养定时器）
    expect(src).not.toContain('setInterval')
    // 唯一的删除点必须在 done 清理里，且删的是 inboxDoneDir 的子目录
    const sweepBody = slice(src, 'export async function sweepInboxDoneArchive', 'async function dirSize(')
    expect(sweepBody.length).toBeGreaterThan(200)
    expect(sweepBody).toContain('fs.rm(dir, { recursive: true, force: true })')
    expect(sweepBody).toContain('inboxDoneDir()')
    // failed\ 不清理（排查凭据：error.txt + 原始交付文件）
    expect(sweepBody).not.toContain('inboxFailedDir')
  })

  it('失败归档会写 error.txt（人类可读中文原因）', () => {
    expect(src).toContain("'error.txt'")
  })

  it('派发是 at-least-once（有界重发，直到 ack）', () => {
    expect(src).toContain('DISPATCH_RETRY_MS')
    expect(src).toContain('DISPATCH_MAX_ATTEMPTS')
    expect(src).toContain('export function settleInboxJob')
  })
})

describe('渲染层消费（src/renderer/store.ts）', () => {
  const raw = readSrc('src/renderer/store.ts')
  const src = stripComments(raw)

  it('init() 里订阅收件箱（幂等）', () => {
    expect(src).toContain('export function ensureInboxSubscribed')
    expect(src).toMatch(/ensureConflictAskSubscribed\(\)\n[\s\S]{0,600}ensureInboxSubscribed\(\)/)
  })

  /**
   * 装配守卫（反向）：允许**能力缺失**（旧 preload / 只桩部分方法的测试），
   * 但**不允许**把功能悄悄关掉 —— 探测之后必须真的调 `.onInboxJob(...)`。
   *
   * 防的退化形态：有人为了"修复被新 API 打挂的测试"把订阅整段注释掉 / 写成
   * `if (false)` / 只留一个能力探测分支不接线 —— 那时界面永远收不到任务，
   * 而所有测试都是绿的（正是本轮 8 条测试暴露出的同一类风险的镜像）。
   */
  it('⭐ 能力探测之后**必须真的**调 .onInboxJob(...)（装配不许被悄悄关掉）', () => {
    const body = raw.slice(
      raw.indexOf('export function ensureInboxSubscribed'),
      raw.indexOf('export function resetInboxForTests')
    )
    expect(body.length).toBeGreaterThan(200)
    // 真的订阅了（不是只探测）
    expect(body).toContain('.onInboxJob((job) =>')
    expect(body).toContain('void consumeInboxJob(job)')
    // 订阅标志必须在探测**通过之后**才置位
    expect(body.indexOf('inboxJobSubscribed = true')).toBeGreaterThan(
      body.indexOf("typeof bridge?.onInboxJob !== 'function'")
    )
    // 没有 if(false) 之类的死路
    expect(stripComments(body)).not.toContain('if (false)')
    expect(stripComments(body)).not.toContain('return // ')
  })

  it('能力缺失时**必须**记一条 warn（允许缺失，但不允许静默）', () => {
    const body = raw.slice(
      raw.indexOf('function warnInboxSubscribeSkipped'),
      raw.indexOf('export function ensureInboxSubscribed')
    )
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain("message: 'inbox:subscribe-skipped'")
    expect(body).toContain("level: 'warn'")
    // 只打一次（否则 StrictMode / 重扫重建会刷屏）
    expect(body).toContain('if (inboxSubscribeWarned) return')
    // reportLog 缺失时兜 console.warn（极简测试桩上也要留痕）
    expect(body).toContain('console.warn')
    // 不允许靠 try/catch 把整个 init 吞掉：探测分支只 return，不抛
    expect(stripComments(body)).not.toContain('throw ')
  })

  it('create 走既有导入通道 importPaths([jobDir])', () => {
    expect(src).toContain('await useVault.getState().importPaths([job.jobDir])')
  })

  it('⭐ update 不走 importPaths，只调 applyInboxUpdate + rescan', () => {
    const updateBranch = raw.slice(
      raw.indexOf("if (manifest.op === 'update')"),
      raw.indexOf('// ── 新建：走既有导入通道')
    )
    expect(updateBranch.length).toBeGreaterThan(200)
    expect(updateBranch).toContain('window.modvault.applyInboxUpdate(')
    expect(updateBranch).toContain('.rescan()')
    expect(stripComments(updateBranch)).not.toContain('importPaths')
  })

  it('成功与失败都要 ack（不 ack 主进程会每 3 秒重发）', () => {
    const body = slice(src, 'async function consumeInboxJob', 'export function ensureInboxSubscribed')
    expect(body).toContain('await ackInbox(jobId, true)')
    expect(body).toContain('await ackInbox(jobId, false')
    // 重复到达也要补 ack（否则主进程重发到上限）
    expect(body).toMatch(/inboxHandledJobs\.has\(jobId\)[\s\S]{0,200}ackInbox\(jobId, true\)/)
  })

  it('失败文案要能指导用户动作（不是"失败"两个字）', () => {
    const body = slice(src, 'async function consumeInboxJob', 'export function ensureInboxSubscribed')
    expect(body).toMatch(/SketchUp 更新「\$\{name\}」失败：\$\{result\.reason\}/)
    expect(body).toMatch(/SketchUp 导出「\$\{name\}」入库失败：\$\{reason\}/)
  })

  it('走既有 notice 通道（enqueueNotice），不新造 toast', () => {
    const body = slice(src, 'async function consumeInboxJob', 'export function ensureInboxSubscribed')
    expect(body).toContain('enqueueNotice(')
  })

  it('⭐ 去重是**永久集合**，不是时间窗口（迟到的重发也不能二次导入）', () => {
    const block = slice(src, 'const inboxHandledJobs = new Set<string>()', 'export function resetInboxForTests')
    expect(block.length).toBeGreaterThan(1000)
    // 处理完只 add、放进 finally；没有任何 delete / clear / 过期清理
    expect(block).toContain('inboxHandledJobs.add(jobId)')
    expect(block).not.toContain('inboxHandledJobs.delete')
    expect(block).not.toContain('inboxHandledJobs.clear')
    // 唯一允许清空的地方是仅供单测的 reset（运行时禁止调用，注释里写死了）
    expect(src).toContain('export function resetInboxForTests')
  })
})

describe('契约实现方（插件侧）与主程序侧的字段口径必须一致', () => {
  it('shared/inbox.ts 的路径常量与 docs/48 §7 口径对齐', () => {
    const src = readSrc('src/shared/inbox.ts')
    expect(src).toContain("export const INBOX_ROOT_DIR_NAME = 'idbox_export'")
    expect(src).toContain("export const INBOX_INCOMING_DIR_NAME = 'incoming'")
    expect(src).toContain("export const INBOX_DONE_DIR_NAME = 'done'")
    expect(src).toContain("export const INBOX_FAILED_DIR_NAME = 'failed'")
    expect(src).toContain("export const INBOX_MANIFEST_FILE = 'manifest.json'")
    expect(src).toContain('export const INBOX_API_VERSION = 1')
  })
})

describe('协议文件不许进用户的库（importer 侧）', () => {
  it('文件夹导入在 listTopLevel / walkFiles **之前**剔除 job 里的 manifest.json', () => {
    const src = stripComments(readSrc('src/main/importer.ts'))
    const dirBranch = slice(src, 'if (isDir) {', '} else {')
    expect(dirBranch).toContain('await fs.cp(src, staging, { recursive: true })')
    expect(dirBranch).toContain('dropInboxProtocolManifest(staging)')
    // 必须在 walkFiles 之前（否则 files[] / size / 分类已经算进它了）
    const cpIdx = src.indexOf('dropInboxProtocolManifest(staging)')
    expect(cpIdx).toBeGreaterThan(0)
    expect(cpIdx).toBeLessThan(src.indexOf('await walkFiles(contentRoot'))
  })

  it('判据是"文件名 + 内容"双条件，不是按名字一刀切', () => {
    const src = stripComments(readSrc('src/main/fsutil.ts'))
    const body = slice(src, 'export async function dropInboxProtocolManifest', '/** 递归统计目录字节数')
    expect(body.length).toBeGreaterThan(200)
    expect(body).toContain('INBOX_MANIFEST_FILE')
    expect(body).toContain('isInboxManifestJson(text)')
    // 只删这一个精确文件名，绝不是 `*.json` 通配
    expect(body).not.toContain('endsWith(\'.json\')')
  })

  it('判据只有一份实现（shared/inbox.ts），fsutil 不复制正则', () => {
    const src = stripComments(readSrc('src/main/fsutil.ts'))
    expect(src).toContain("from '../shared/inbox'")
    expect(src).not.toContain('apiVersion')
  })
})
