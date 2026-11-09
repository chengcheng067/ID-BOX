/**
 * SketchUp 插件「**使用记录**」回传（`src/shared/inboxUsage.ts` + `src/main/inboxUsage.ts`）单测。
 *
 * 三段：
 * 1. **纯决策真值表**（`parseInboxUsage` / `isInboxUsageFileName`）—— 每条判废规则一条用例，
 *    理由写在用例名里，改规则的人一眼能看出"哪种坏文件会被收下、判废文案说什么"；
 * 2. **真实落盘 IO**（`scanUsageDir` / `removeUsageFile` / `dispatchStoredInboxUsage`）——
 *    用 `os.tmpdir()` 的临时目录，`afterEach` 删掉（不污染仓库、不留垃圾）；
 * 3. **接线守卫**（`shared/ipc.ts` / `preload` / `main/index.ts`）——
 *    本仓 vitest 是 `environment: 'node'`（无 jsdom），"有没有接上"只能读文本断言，
 *    与 `tests/inboxWiring.test.ts` 同一套范式。
 *
 * ⚠️ `src/main/inboxUsage.ts` 刻意**不 import electron / logger**（logger 顶部 import 了
 *    `app`），所以这里可以直接 `import` 它而不用 `vi.mock`。
 */
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INBOX_USAGE_ASSET_ID_MAX_LEN,
  INBOX_USAGE_DIR_NAME,
  INBOX_USAGE_MAX_BYTES,
  isInboxUsageFileName,
  parseInboxUsage,
  type InboxUsageEvent
} from '../src/shared/inboxUsage'
import {
  dispatchStoredInboxUsage,
  removeUsageFile,
  resolveInboxUsageDir,
  scanUsageDir
} from '../src/main/inboxUsage'

// ── 基准样本 ────────────────────────────────────────────────────────────

/** 合法记录（逐字对应磁盘契约；`assetId` 是 36 字符 UUID 形态） */
const VALID = {
  apiVersion: 1,
  op: 'usage',
  assetId: '3f2b1c8e-9a4d-4f7b-8c1e-2d3a4b5c6d7e',
  at: '2026-11-09T18:40:00+08:00',
  pluginVersion: '1.2.0'
}

/** 每次调用给一个**唯一**的合法文件名（`dispatched` 集合是进程级的，用例之间不能撞名） */
let seq = 0
function usageFileName(): string {
  seq += 1
  const sec = String(seq % 60).padStart(2, '0')
  const rnd = seq.toString(36).padStart(4, '0').slice(-4)
  return `20261109-1840${sec}-${rnd}.json`
}

// ── 1. 文件名闸门 ───────────────────────────────────────────────────────

describe('isInboxUsageFileName：只认 `YYYYMMDD-HHmmss-<4位随机>.json`', () => {
  it('正例：标准形态 / 大写扩展名 / 大小写混合的随机段', () => {
    expect(isInboxUsageFileName('20261109-184000-ab12.json')).toBe(true)
    // 插件在某些环境会写大写扩展名 ⇒ 大小写不敏感（与 INBOX_JOB_ID_RE 的 i 标志同口径）
    expect(isInboxUsageFileName('20261109-184000-ab12.JSON')).toBe(true)
    expect(isInboxUsageFileName('20261109-184000-AB12.json')).toBe(true)
    expect(isInboxUsageFileName('20261109-184000-0000.json')).toBe(true)
  })

  it('反例：`.tmp` 中间态 / 缺随机段 / 多一段 / 含路径 / 空串', () => {
    // `.tmp` 是插件原子写的中间态：认了就会读到半截 JSON
    expect(isInboxUsageFileName('20261109-184000-ab12.json.tmp')).toBe(false)
    expect(isInboxUsageFileName('20261109-184000.json')).toBe(false)
    expect(isInboxUsageFileName('20261109-184000-ab12-extra.json')).toBe(false)
    expect(isInboxUsageFileName('2026110-184000-ab12.json')).toBe(false)
    expect(isInboxUsageFileName('20261109-1840-ab12.json')).toBe(false)
    // 多一段路径：绝不能当成单段文件名（这是 removeUsageFile 的安全前提）
    expect(isInboxUsageFileName('usage/20261109-184000-ab12.json')).toBe(false)
    expect(isInboxUsageFileName('..\\20261109-184000-ab12.json')).toBe(false)
    expect(isInboxUsageFileName('manifest.json')).toBe(false)
    expect(isInboxUsageFileName('')).toBe(false)
  })
})

// ── 2. parseInboxUsage 真值表 ───────────────────────────────────────────

describe('parseInboxUsage：合法样例', () => {
  it('契约基准样本原样通过，且 `op` 被收窄成 `usage`', () => {
    const r = parseInboxUsage({ ...VALID })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.record).toEqual(VALID)
    expect(r.record.op).toBe('usage')
    expect(r.record.apiVersion).toBe(1)
  })

  it('四个字符串字段都会 trim（盘上的写法可能是 " usage "）', () => {
    const r = parseInboxUsage({
      ...VALID,
      op: 'usage',
      assetId: `  ${VALID.assetId}  `,
      at: `\t${VALID.at} `,
      pluginVersion: ' 1.2.0 '
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.record.assetId).toBe(VALID.assetId)
    expect(r.record.at).toBe(VALID.at)
    expect(r.record.pluginVersion).toBe('1.2.0')
  })
})

describe('parseInboxUsage：判废真值表（每条对应一种真实的坏文件）', () => {
  const cases: Array<{ name: string; raw: unknown; keyword: string }> = [
    // ── 整体形状 ──
    { name: 'null（截断成空文件后 JSON.parse 得 null）', raw: null, keyword: '不是一个 JSON 对象' },
    { name: '数组（插件把记录当数组追加写）', raw: [VALID], keyword: '不是一个 JSON 对象' },
    { name: '字符串', raw: JSON.stringify(VALID), keyword: '不是一个 JSON 对象' },
    { name: '数字', raw: 1, keyword: '不是一个 JSON 对象' },
    { name: '布尔', raw: true, keyword: '不是一个 JSON 对象' },
    // ── apiVersion ──
    { name: 'apiVersion 缺失', raw: { ...VALID, apiVersion: undefined }, keyword: '缺失或不是整数' },
    { name: 'apiVersion 是字符串 "1"', raw: { ...VALID, apiVersion: '1' }, keyword: '缺失或不是整数' },
    { name: 'apiVersion 是小数 1.5', raw: { ...VALID, apiVersion: 1.5 }, keyword: '缺失或不是整数' },
    { name: 'apiVersion 是 2（新协议）', raw: { ...VALID, apiVersion: 2 }, keyword: '本机只支持 1' },
    { name: 'apiVersion 是 0', raw: { ...VALID, apiVersion: 0 }, keyword: '本机只支持 1' },
    // ── op ──
    { name: 'op 是 create（导出 manifest 误写进 usage\\）', raw: { ...VALID, op: 'create' }, keyword: '只能是 usage' },
    { name: 'op 是 update', raw: { ...VALID, op: 'update' }, keyword: '只能是 usage' },
    { name: 'op 缺失', raw: { ...VALID, op: undefined }, keyword: '只能是 usage' },
    // ── assetId ──
    { name: 'assetId 缺失', raw: { ...VALID, assetId: undefined }, keyword: '缺失或不是字符串' },
    { name: 'assetId 是数字', raw: { ...VALID, assetId: 42 }, keyword: '缺失或不是字符串' },
    { name: 'assetId 是空串', raw: { ...VALID, assetId: '' }, keyword: '为空' },
    { name: 'assetId 全是空白', raw: { ...VALID, assetId: '   ' }, keyword: '为空' },
    {
      name: `assetId 超过 ${INBOX_USAGE_ASSET_ID_MAX_LEN} 字`,
      raw: { ...VALID, assetId: 'a'.repeat(INBOX_USAGE_ASSET_ID_MAX_LEN + 1) },
      keyword: '过长'
    },
    { name: 'assetId 含正斜杠（路径形态）', raw: { ...VALID, assetId: 'a/b' }, keyword: '含非法字符' },
    { name: 'assetId 含反斜杠（Windows 路径形态）', raw: { ...VALID, assetId: 'C:\\models\\a' }, keyword: '含非法字符' },
    { name: 'assetId 含 Windows 保留字符 *', raw: { ...VALID, assetId: 'a*b' }, keyword: '含非法字符' },
    { name: 'assetId 含控制字符', raw: { ...VALID, assetId: 'ab\u0007cd' }, keyword: '含非法字符' },
    // ── at ──
    { name: 'at 缺失', raw: { ...VALID, at: undefined }, keyword: '缺失或不是字符串' },
    { name: 'at 是时间戳数字', raw: { ...VALID, at: 1762700000000 }, keyword: '缺失或不是字符串' },
    { name: 'at 是空串（时钟 API 异常时会出现）', raw: { ...VALID, at: '  ' }, keyword: '为空' },
    { name: 'at 不是可解析时间（占位串）', raw: { ...VALID, at: '(unknown time)' }, keyword: '不是可解析的时间' },
    // ── pluginVersion ──
    { name: 'pluginVersion 缺失', raw: { ...VALID, pluginVersion: undefined }, keyword: '缺失或不是字符串' },
    { name: 'pluginVersion 是数字', raw: { ...VALID, pluginVersion: 1.2 }, keyword: '缺失或不是字符串' },
    { name: 'pluginVersion 全是空白', raw: { ...VALID, pluginVersion: ' \n ' }, keyword: '为空' }
  ]

  for (const c of cases) {
    it(`判废：${c.name}`, () => {
      const r = parseInboxUsage(c.raw)
      expect(r.ok).toBe(false)
      if (r.ok) return
      // 文案是**人类可读中文**（会进日志），断言关键字防止被改成英文 / 空串
      expect(r.reason).toContain(c.keyword)
    })
  }

  it('合法的 64 字 assetId 边界通过（不多不少）', () => {
    const r = parseInboxUsage({ ...VALID, assetId: 'a'.repeat(INBOX_USAGE_ASSET_ID_MAX_LEN) })
    expect(r.ok).toBe(true)
  })
})

// ── 3. 真实落盘 ─────────────────────────────────────────────────────────

describe('resolveInboxUsageDir', () => {
  it('拼出 `<appData>\\idbox_export\\usage`', () => {
    const appData = path.join('C:', 'Users', 'tester', 'AppData', 'Roaming')
    expect(resolveInboxUsageDir(appData)).toBe(path.join(appData, 'idbox_export', INBOX_USAGE_DIR_NAME))
  })

  it('appData 为空 / 非字符串 → 返回空串（**不猜路径**）', () => {
    expect(resolveInboxUsageDir('')).toBe('')
    expect(resolveInboxUsageDir('   ')).toBe('')
  })
})

describe('scanUsageDir / removeUsageFile / dispatchStoredInboxUsage（真实临时目录）', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-usage-'))
  })

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  /** 写一个 JSON 文件（`body` 直接落盘，便于造坏文件） */
  async function writeRaw(fileName: string, body: string): Promise<void> {
    await fs.writeFile(path.join(dir, fileName), body, 'utf-8')
  }

  it('目录不存在 → 返回空结果，**不抛**（首次使用时的正常形态）', async () => {
    const missing = path.join(dir, 'not-created-yet')
    const r = await scanUsageDir(missing)
    expect(r).toEqual({ records: [], bad: [], entries: [] })
  })

  it('空目录 → 空结果', async () => {
    const r = await scanUsageDir(dir)
    expect(r.records).toEqual([])
    expect(r.bad).toEqual([])
  })

  it('正常记录被读出，`entries` 与 `records` 同序且带文件名', async () => {
    const name = usageFileName()
    await writeRaw(name, JSON.stringify(VALID))
    const r = await scanUsageDir(dir)
    expect(r.records).toEqual([VALID])
    expect(r.entries).toEqual([{ fileName: name, record: VALID }])
    expect(r.bad).toEqual([])
  })

  it('坏 JSON / 空文件 / 超限文件 → 进 bad，不进 records（且都**留在盘上**）', async () => {
    const goodName = usageFileName()
    const badJsonName = usageFileName()
    const emptyName = usageFileName()
    const hugeName = usageFileName()

    await writeRaw(goodName, JSON.stringify(VALID))
    await writeRaw(badJsonName, '{"apiVersion":1,"op":"usa') // 截断
    await writeRaw(emptyName, '')
    await writeRaw(hugeName, 'x'.repeat(INBOX_USAGE_MAX_BYTES + 1))

    const r = await scanUsageDir(dir)
    expect(r.records).toEqual([VALID])
    expect(r.entries.map((e) => e.fileName)).toEqual([goodName])
    expect(new Set(r.bad)).toEqual(new Set([badJsonName, emptyName, hugeName]))
    // 判废的文件**不删**（留着才是排查凭据）
    for (const name of r.bad) {
      await expect(fs.stat(path.join(dir, name))).resolves.toBeTruthy()
    }
  })

  it('形状不合法的记录（op=create）进 bad', async () => {
    const name = usageFileName()
    await writeRaw(name, JSON.stringify({ ...VALID, op: 'create' }))
    const r = await scanUsageDir(dir)
    expect(r.records).toEqual([])
    expect(r.bad).toEqual([name])
  })

  it('`.tmp` / 无关文件名 / 子目录 / 非普通文件一律忽略（连 bad 都不进）', async () => {
    const goodName = usageFileName()
    await writeRaw(goodName, JSON.stringify(VALID))
    // 插件的原子写中间态：合法名字 + `.tmp`
    await writeRaw(`${goodName}.tmp`, JSON.stringify(VALID))
    // 别人的杂项文件
    await writeRaw('desktop.ini', '[.ShellClassInfo]')
    await writeRaw('manifest.json', JSON.stringify(VALID))
    // 同形态的**目录**（外部程序造的怪东西）：不是普通文件，不碰
    await fs.mkdir(path.join(dir, '20261109-184000-zz99.json'), { recursive: true })

    const r = await scanUsageDir(dir)
    expect(r.records).toEqual([VALID])
    expect(r.bad).toEqual([])
    expect(r.entries.map((e) => e.fileName)).toEqual([goodName])
  })

  it('removeUsageFile：删成功 true；再删一次仍 true（ENOENT 幂等）', async () => {
    const name = usageFileName()
    await writeRaw(name, JSON.stringify(VALID))
    await expect(removeUsageFile(dir, name)).resolves.toBe(true)
    await expect(fs.stat(path.join(dir, name))).rejects.toThrow()
    await expect(removeUsageFile(dir, name)).resolves.toBe(true)
  })

  it('removeUsageFile：文件名不合法一律 false，**绝不删**目录里别的东西', async () => {
    const keep = usageFileName()
    await writeRaw(keep, JSON.stringify(VALID))
    // 目录外的目标文件（用来证明路径注入被挡住）
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-victim.json`)
    await fs.writeFile(outside, 'do not delete', 'utf-8')

    await expect(removeUsageFile(dir, '..\\..\\victim.json')).resolves.toBe(false)
    await expect(removeUsageFile(dir, `../${path.basename(outside)}`)).resolves.toBe(false)
    await expect(removeUsageFile(dir, 'C:\\Windows\\a.json')).resolves.toBe(false)
    await expect(removeUsageFile(dir, `${keep}.tmp`)).resolves.toBe(false)
    await expect(removeUsageFile(dir, '')).resolves.toBe(false)

    // 两个文件都还在
    await expect(fs.readFile(path.join(dir, keep), 'utf-8')).resolves.toContain('usage')
    await expect(fs.readFile(outside, 'utf-8')).resolves.toBe('do not delete')
    await fs.rm(outside, { force: true })
  })

  it('dispatchStoredInboxUsage：启动扫描把记录逐条交出，且**进程内只发一次**', async () => {
    const name = usageFileName()
    await writeRaw(name, JSON.stringify(VALID))

    const got: InboxUsageEvent[] = []
    const first = await dispatchStoredInboxUsage(dir, (ev) => got.push(ev))
    expect(first.sent).toBe(1)
    expect(got).toHaveLength(1)
    expect(got[0]!.fileName).toBe(name)
    expect(got[0]!.record).toEqual(VALID)

    // 第二次扫描（模拟"chokidar 与启动扫描撞车"）：同一条**不重发** ——
    // 重发会让用户的使用次数被多算一次，这是本功能唯一不可接受的错误
    const second = await dispatchStoredInboxUsage(dir, (ev) => got.push(ev))
    expect(second.sent).toBe(0)
    expect(second.skipped).toBe(1)
    expect(got).toHaveLength(1)
  })

  it('dispatchStoredInboxUsage：目录不存在 / 全坏文件时安静返回', async () => {
    const r1 = await dispatchStoredInboxUsage(path.join(dir, 'nope'), () => {
      throw new Error('不该被调用')
    })
    expect(r1).toEqual({ sent: 0, bad: 0, skipped: 0 })

    const badName = usageFileName()
    await writeRaw(badName, 'not json')
    const r2 = await dispatchStoredInboxUsage(dir, () => {
      throw new Error('不该被调用')
    })
    expect(r2).toEqual({ sent: 0, bad: 1, skipped: 0 })
  })
})

// ── 4. 接线守卫（三处缺一不可：shared/ipc.ts + preload + main/index.ts）────────

/** 相对仓库根读源码（换行统一成 `\n`：工作区是 CRLF） */
function readSrc(rel: string): string {
  return fsSync.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥掉整行注释后再断言（注释里提到通道名不该让守卫变绿或变红） */
function stripComments(src: string): string {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取 `from` 之后到 `to` 之前的片段（找不到就返回空串，让断言直接红） */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from)
  if (i < 0) return ''
  const j = src.indexOf(to, i + from.length)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

describe('接线守卫', () => {
  it('shared/ipc.ts：两条通道名逐字存在', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("inboxUsage: 'inbox:usage'")
    expect(src).toContain("inboxUsageAck: 'inbox:usageAck'")
  })

  it('preload：暴露 onInboxUsage / ackInboxUsage，且都压在 IPC 常量上', () => {
    const src = stripComments(readSrc('src/preload/index.ts'))
    expect(src).toContain('onInboxUsage:')
    expect(src).toMatch(/onInboxUsage:[\s\S]{0,220}ipcRenderer\.on\(IPC\.inboxUsage/)
    expect(src).toContain('ackInboxUsage:')
    expect(src).toMatch(/ackInboxUsage:[\s\S]{0,220}ipcRenderer\.invoke\(IPC\.inboxUsageAck/)
    // 退订函数：否则每次 init 都泄漏一个 handler（与 onInboxJob 同款）
    const body = slice(src, 'onInboxUsage:', 'ackInboxUsage:')
    expect(body).toContain('ipcRenderer.off(IPC.inboxUsage, handler)')
    // 渲染层的既有能力探测靠 `typeof x === 'function'`，属性不能是可选（`onInboxUsage?:`）
    expect(src).not.toContain('onInboxUsage?:')
    expect(src).not.toContain('ackInboxUsage?:')
  })

  it('主进程：ack handler 存在，且**先校验文件名**再删（防注入删任意文件）', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    expect(src).toContain('ipcMain.handle(\n  IPC.inboxUsageAck')
    const body = slice(src, 'IPC.inboxUsageAck', '// ── T04 新增')
    expect(body).toContain('isInboxUsageFileName(fileName)')
    expect(body).toContain('removeUsageFile(inboxUsageDir(), fileName')
    // 渲染层传的 ok 不是 true（没落库）时必须保留文件
    expect(body).toContain('raw.ok !== true')
  })

  it('主进程：启动时起通道（watcher + 存量扫描），退出时停掉', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    expect(src).toContain('startInboxUsage()')
    expect(src).toContain('dispatchStoredInboxUsage(')
    expect(src).toContain('startInboxUsageWatcher(')
    expect(src).toMatch(/will-quit[\s\S]{0,200}stopInboxUsageWatcher\(\)/)
  })

  it('主进程：记录经 IPC.inboxUsage 推给渲染层（不是只打日志）', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    expect(src).toContain('target.webContents.send(IPC.inboxUsage, ev)')
  })

  it('⭐ 现有 `incoming` 导出通道保持不变：startInbox 里没有任何 usage 字样', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    // ⚠️ 结束标记必须是**代码**且紧贴 `startInbox` 之后（`inboxUsageDir`）——
    //    用注释行不行：`stripComments` 会把整行注释删掉，标记消失后 slice 会一路吃到文件尾。
    const body = slice(src, 'function startInbox(): void', 'function inboxUsageDir(): string')
    expect(body).toContain('startInboxWatcher(')
    expect(body).toContain('IPC.inboxJob')
    expect(body).not.toContain('IPC.inboxUsage')
    expect(body).not.toContain('InboxUsage')
  })

  it('⭐ 使用记录的 watcher 是**独立实例**：main/inboxUsage.ts 不碰 incoming 的机制', () => {
    const src = stripComments(readSrc('src/main/inboxUsage.ts'))
    // 不许复用导出通道的派发器 / 归档 / 目录常量
    expect(src).not.toContain('startInboxWatcher')
    expect(src).not.toContain('enqueueDispatch')
    expect(src).not.toContain('archiveInboxJob')
    expect(src).not.toContain('INBOX_INCOMING_DIR_NAME')
    // 只 import 了零依赖的 shared 契约 + node:* + chokidar（绝不 import electron / logger）
    expect(src).not.toContain("from 'electron'")
    expect(src).not.toContain("from './logger'")
  })
})
