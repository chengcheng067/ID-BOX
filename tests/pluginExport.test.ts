/**
 * ID BOX 写盘侧（插件导出）单测 —— `docs/39` §2–§3 的验收。
 *
 * 六层覆盖（对应派工单的 a–f）：
 * (a) happy path 字段形状：信封 + 记录逐字段，紧凑 JSON、无 BOM、posix、ISO8601 UTC；
 * (b) `mainFile` 可 null：`pickPrimaryFile()` 对空 files 返回 undefined；
 * (c) sha256 不符 / 半写检测：SHA256 必须算在**同一份落盘字符串**上，连续 3 轮才报 102；
 * (d) debounce + max-wait：quiet 1.5 s、max-wait 5 s、**没有定时兜底**（假时钟逐毫秒推进）；
 * (e) 触发集排除缩略图涓流：常量断言 + `store.ts` 源码守卫 + 软删判据与 `trashView.ts` 一致；
 * (f) 规模判据分支：≤2000 条且 ≤2 MB 走全量，超阈值走 over-limit。
 * 另加：APPDATA 路径解析、串行写队列、原子写顺序（index 先于 manifest）、失败不写空内容。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  DEBOUNCE_QUIET_MS,
  EXCLUDED_PLUGIN_TRIGGERS,
  FRESHNESS_HINT_SECONDS,
  HALF_WRITE_MAX_ROUNDS,
  IDBOX_ERROR_CODES,
  MAX_ERROR_CODES,
  MAX_INDEX_BYTES,
  MAX_RECORDS,
  MAX_WAIT_MS,
  PLUGIN_API_VERSION,
  PLUGIN_APP_DIR_NAME,
  PLUGIN_DIR_NAME,
  PLUGIN_INDEX_FILE_NAME,
  PLUGIN_MANIFEST_FILE_NAME,
  PLUGIN_TRIGGER_SET,
  RESERVED_ERROR_CODES,
  byteLengthUtf8,
  buildPluginEnvelope,
  buildPluginRecord,
  buildPluginRecords,
  createHalfWriteGuard,
  isDefinedErrorCode,
  isPluginTrigger,
  scaleBranch,
  serializeCompact,
  toPosix,
  type PluginSnapshotRecord
} from '../src/shared/pluginSnapshot'
import { createPluginThrottle, type ThrottleClock } from '../src/main/pluginThrottle'
import { isDeletedAsset } from '../src/renderer/logic/trashView'
import { DEFAULT_SETTINGS, type Asset, type AssetFile, type Settings } from '../src/shared/types'

// ── 假时钟（逐毫秒推进：时间语义只能靠注入时钟钉住）────────────────────────
function fakeClock(start = 0): { clock: ThrottleClock; advance: (ms: number) => void } {
  let nowValue = start
  const timers: { at: number; cb: () => void; cancelled: boolean }[] = []
  const clock: ThrottleClock = {
    now: () => nowValue,
    schedule: (cb, ms) => {
      const entry = { at: nowValue + ms, cb, cancelled: false }
      timers.push(entry)
      return () => {
        entry.cancelled = true
      }
    }
  }
  /** 推进到 nextMs，按到期顺序执行未取消的定时器 */
  const advance = (nextMs: number): void => {
    const target = nowValue + nextMs
    while (true) {
      const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      nowValue = due.at
      due.cancelled = true
      due.cb()
    }
    nowValue = target
  }
  return { clock, advance }
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 给"未处理 rejection"留出触发窗口（Node 在微任务队列排空后 emit） */
const settleUnhandled = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 30))

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

// ── 假 logger（写盘失败只记 warn，单测里要能数它被调用过）───────────────────
const logSpy = vi.hoisted(() => ({ warns: [] as string[], infos: [] as string[] }))

vi.mock('../src/main/logger', () => ({
  logWarn: (message: string): void => {
    logSpy.warns.push(message)
  },
  logInfo: (message: string): void => {
    logSpy.infos.push(message)
  }
}))

// ── 假 fs（原子写 + 顺序可观测）────────────────────────────────────────────
const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  ops: [] as string[],
  writeCount: 0,
  renameCount: 0,
  failWriteAt: -1,
  failRenameAt: -1
}))

vi.mock('node:fs/promises', () => {
  const errno = (p: string, op: string, code: string): NodeJS.ErrnoException => {
    const err = new Error(`${code}: ${op} '${p}'`) as NodeJS.ErrnoException
    err.code = code
    err.path = p
    return err
  }
  return {
    mkdir: async (p: string): Promise<void> => {
      fake.ops.push(`mkdir:${p}`)
    },
    writeFile: async (p: string, data: string): Promise<void> => {
      fake.ops.push(`write:${p}`)
      fake.writeCount += 1
      if (fake.writeCount === fake.failWriteAt) throw errno(p, 'open', 'EBUSY')
      fake.files.set(p, String(data))
    },
    rename: async (from: string, to: string): Promise<void> => {
      fake.renameCount += 1
      if (fake.renameCount === fake.failRenameAt) throw errno(from, 'rename', 'EPERM')
      const v = fake.files.get(from)
      if (v === undefined) throw errno(from, 'rename', 'ENOENT')
      fake.files.set(to, v)
      fake.files.delete(from)
      fake.ops.push(`rename:${from}->${to}`)
    }
  }
})

// ── 排空假 fs 状态（每个用例独立，避免 ops / 计数器串台）────────────────────
function resetFake(): void {
  fake.files.clear()
  fake.ops.length = 0
  fake.writeCount = 0
  fake.renameCount = 0
  fake.failWriteAt = -1
  fake.failRenameAt = -1
  logSpy.warns.length = 0
  logSpy.infos.length = 0
}

// ⚠️ 必须在 vi.mock 之后 import（vi.mock 已提升，这里只是可读性排列）
import {
  PLUGIN_TMP_SUFFIX,
  createPluginWriteQueue,
  createPluginWriter,
  enqueuePluginWrite,
  pluginIndexPath,
  pluginManifestPath,
  resolvePluginRoot,
  sha256Hex,
  writePluginSnapshot,
  type PluginWriteContext
} from '../src/main/pluginExport'

// ── 样本资产（字段形状照 `src/shared/types.ts:293`）─────────────────────────
const LIB = 'E:\\ModVault\\Library'
const THUMBS = 'C:\\Users\\x\\AppData\\Roaming\\idbox\\thumbs'
const APPDATA = 'C:\\Users\\x\\AppData\\Roaming'

function file(rel: string, ext: string, kind: AssetFile['kind']): AssetFile {
  return { rel, ext, name: rel.split('/').pop() ?? rel, size: 512, kind }
}

function sampleAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1b2c3d4-0001',
    name: '测试模型-中文名字',
    kind: 'model',
    source: '知末网',
    folder: path.join(LIB, '模型', '人物', '测试模型'),
    relFolder: '模型/人物/测试模型',
    files: [file('测试模型.skp', 'skp', 'model'), file('./预览图.jpg', 'JPG', 'other')],
    size: 1536,
    thumbPath: 'a1b2c3.jpg',
    thumbStatus: 'ready',
    suMajor: 2024,
    updatedAt: Date.UTC(2026, 10, 4, 10, 0, 0),
    ...overrides
  } as Asset
}

function ctx(overrides: Partial<PluginWriteContext> = {}): PluginWriteContext {
  return {
    dir: path.join(APPDATA, PLUGIN_APP_DIR_NAME, PLUGIN_DIR_NAME),
    appVersion: '0.9.3',
    libraryRoot: LIB,
    pluginIndexEnabled: true,
    thumbsRoot: THUMBS,
    now: () => '2026-11-04T10:00:00.000Z',
    ...overrides
  }
}

// ── (a) happy path 字段形状 ─────────────────────────────────────────────────
describe('插件快照字段形状（docs/39 §3.2）', () => {
  it('记录字段与 §3.2 的表逐键一致、顺序可对账', () => {
    const record = buildPluginRecord(sampleAsset())
    expect(Object.keys(record)).toEqual([
      'id',
      'name',
      'kind',
      'category1',
      'category2',
      'source',
      'zhimoId',
      'relFolder',
      'mainFile',
      'files',
      'thumbRel',
      'suMajor',
      'updatedAt'
    ])
    expect(record.id).toBe('a1b2c3d4-0001')
    expect(record.name).toBe('测试模型-中文名字')
    expect(record.kind).toBe('model')
    // 未分类哨兵（`taxonomy.ts:19`）：Asset 上缺 category 时快照写 '未分类'，不写 null
    expect(record.category1).toBe('未分类')
    expect(record.category2).toBe('未分类')
    expect(record.source).toBe('知末网')
    // 显式可空：「无」与「未提供」必须能区分
    expect(record.zhimoId).toBe(null)
    expect(record.relFolder).toBe('模型/人物/测试模型')
    expect(record.mainFile).toBe('测试模型.skp')
    // `files` 只两键（J2 不暴露 schema）
    expect(record.files).toEqual([
      { rel: '测试模型.skp', ext: 'skp' },
      { rel: '预览图.jpg', ext: 'jpg' }
    ])
    expect(Object.keys(record.files[0])).toEqual(['rel', 'ext'])
    expect(record.thumbRel).toBe('a1b2c3.jpg')
    expect(record.suMajor).toBe(2024)
    expect(record.updatedAt).toBe('2026-11-04T10:00:00.000Z')
  })

  it('信封是顶层对象（不是数组），`generatedAt` 只在信封级出现一次', () => {
    const records = buildPluginRecords([sampleAsset()])
    const envelope = buildPluginEnvelope(records, {
      generatedAt: '2026-11-04T10:00:00.000Z',
      libraryRoot: LIB
    })
    expect(Array.isArray(envelope)).toBe(false)
    expect(Object.keys(envelope)).toEqual(['apiVersion', 'generatedAt', 'libraryRoot', 'count', 'records'])
    expect(envelope.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(envelope.count).toBe(1)
    expect(envelope.libraryRoot).toBe('E:/ModVault/Library')
    // 逐条字段里不许有 generatedAt（§3.2 架构偏差：已改为 updatedAt）
    expect(envelope.records[0]).not.toHaveProperty('generatedAt')
    expect(envelope.records[0]).toHaveProperty('updatedAt')
  })

  it('紧凑 JSON：无 pretty-print、无 BOM；字节数用 TextEncoder 而非 `.length`', () => {
    const text = serializeCompact(
      buildPluginEnvelope(buildPluginRecords([sampleAsset()]), {
        generatedAt: '2026-11-04T10:00:00.000Z',
        libraryRoot: LIB
      })
    )
    expect(text).not.toContain('\n')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(text).toBe(JSON.stringify(JSON.parse(text)))
    // 中文名：UTF-8 字节数 > JS 字符数（判据按字节，这条就是防 `.length` 偷懒）
    expect(byteLengthUtf8(text)).toBeGreaterThan(text.length)
  })

  it('路径统一 posix：反斜杠、开头 `./`、结尾分隔符都收口，非字符串返回空串且不抛', () => {
    expect(toPosix('模型\\人物\\测试模型')).toBe('模型/人物/测试模型')
    expect(toPosix('./预览图.jpg')).toBe('预览图.jpg')
    expect(toPosix('a/b//')).toBe('a/b')
    expect(toPosix(null)).toBe('')
    expect(() => toPosix(undefined)).not.toThrow()
  })

  it('软删记录不入快照，且判据与 `trashView.ts` 逐条一致', () => {
    const samples: Asset[] = [
      sampleAsset({ id: 'live', deletedAt: undefined }),
      sampleAsset({ id: 'deleted', deletedAt: 1730000000000 }),
      sampleAsset({ id: 'dirty-nan', deletedAt: Number.NaN as never }),
      sampleAsset({ id: 'dirty-string', deletedAt: '1730000000000' as never }),
      sampleAsset({ id: 'dirty-infinity', deletedAt: Number.POSITIVE_INFINITY as never })
    ]
    // 判据是「`deletedAt` 是有限数字才算软删」：NaN / 字符串 / Infinity 这类脏值
    // 一律当**未删除**（与 trashView.ts:52 同口径），所以它们仍留在快照里。
    expect(buildPluginRecords(samples).map((r) => r.id)).toEqual([
      'live',
      'dirty-nan',
      'dirty-string',
      'dirty-infinity'
    ])
    // 两份实现必须对同一批样本给出同一答案（main/shared 不许反向依赖 renderer）
    for (const a of samples) {
      expect(buildPluginRecords([a]).length === 0).toBe(isDeletedAsset(a))
    }
  })

  it('`thumbRel` 只在 `thumbStatus === "ready"` 时写（none / failed 一律 null）', () => {
    expect(buildPluginRecord(sampleAsset({ thumbStatus: 'none' })).thumbRel).toBe(null)
    expect(buildPluginRecord(sampleAsset({ thumbStatus: 'failed' })).thumbRel).toBe(null)
    expect(buildPluginRecord(sampleAsset({ thumbStatus: 'ready', thumbPath: undefined })).thumbRel).toBe(null)
    expect(buildPluginRecord(sampleAsset({ thumbStatus: 'ready', thumbPath: 'x.jpg' })).thumbRel).toBe('x.jpg')
  })

  it('非数字时间戳 / 非数字 `suMajor` → null（实测缺失率高，插件不得假定有值）', () => {
    const r = buildPluginRecord(sampleAsset({ updatedAt: 'abc' as never, suMajor: undefined }))
    expect(r.updatedAt).toBe(null)
    expect(r.suMajor).toBe(null)
    expect(buildPluginRecord(sampleAsset({ updatedAt: Number.NaN })).updatedAt).toBe(null)
  })
})

// ── (b) mainFile 可 null ────────────────────────────────────────────────────
describe('`mainFile` 是派生值，可 null（不是 Asset 字段）', () => {
  it('空 files → null（`pickPrimaryFile()` 返回 undefined）', () => {
    expect(buildPluginRecord(sampleAsset({ files: [] })).mainFile).toBe(null)
  })

  it('优先级 .skp > .max > .fbx > .obj > .3ds > 首个 model > 首个 cad > files[0]', () => {
    const mixed = [file('预览图.jpg', 'jpg', 'other'), file('model.max', 'max', 'model'), file('model.fbx', 'fbx', 'model')]
    expect(buildPluginRecord(sampleAsset({ files: mixed })).mainFile).toBe('model.max')
    expect(buildPluginRecord(sampleAsset({ files: [file('a.dwg', 'dwg', 'cad')] })).mainFile).toBe('a.dwg')
    // 纯图片包：没有 model / cad → 落到 files[0]（口径如此）
    expect(buildPluginRecord(sampleAsset({ files: [file('a.png', 'png', 'other')] })).mainFile).toBe('a.png')
  })

  it('files 非数组（脏数据）→ 空数组，不抛异常，mainFile 为 null', () => {
    const r = buildPluginRecord(sampleAsset({ files: null as never }))
    expect(r.files).toEqual([])
    expect(r.mainFile).toBe(null)
  })
})

// ── (c) sha256 与半写检测 ───────────────────────────────────────────────────
describe('SHA256 必须算在同一份落盘字符串上（§3.4 第 3 条）', () => {
  it('写盘后读回文件重算，与 manifest.indexSha256 相符', async () => {
    resetFake()
    const c = ctx()
    const result = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'importBatchDone', c)
    expect(result.ok).toBe(true)
    expect(result.branch).toBe('full')
    expect(result.error).toBe(null)

    const indexText = fake.files.get(pluginIndexPath(c.dir)) as string
    const manifest = JSON.parse(fake.files.get(pluginManifestPath(c.dir)) as string)
    // 插件读前重算比对：这是半写检测的全部依据
    expect(createHash('sha256').update(indexText, 'utf8').digest('hex')).toBe(manifest.indexSha256)
    expect(manifest.indexSha256).toBe(result.indexSha256)
    expect(manifest.indexSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.indexBytes).toBe(byteLengthUtf8(indexText))
    expect(manifest.indexCount).toBe(1)
    expect(manifest.state).toBe('ok')
    expect(manifest.lastError).toBe(null)
    expect(manifest.freshnessHintSeconds).toBe(FRESHNESS_HINT_SECONDS)
    expect(manifest.pluginIndexEnabled).toBe(true)
    expect(manifest.libraryRoot).toBe('E:/ModVault/Library')
    expect(manifest.thumbsRoot).toBe('C:/Users/x/AppData/Roaming/idbox/thumbs')
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(manifest.appVersion).toBe('0.9.3')
  })

  it('SHA256 对不上时连续 3 轮才报 102（前两轮当「正在写」），中间成功要清零', () => {
    const guard = createHalfWriteGuard()
    expect(guard.observe(false)).toBe('retry')
    expect(guard.rounds()).toBe(1)
    expect(guard.code()).toBe(null)
    expect(guard.observe(false)).toBe('retry')
    expect(guard.observe(false)).toBe('error')
    expect(guard.code()).toBe('102')
    // 「两个 rename 之间的窗口」下一轮就自愈，误报会让插件在窗口里显示错误状态
    expect(guard.observe(true)).toBe('ok')
    expect(guard.rounds()).toBe(0)
    expect(guard.code()).toBe(null)
    expect(HALF_WRITE_MAX_ROUNDS).toBe(3)
  })

  it('写入顺序硬约定：index 先 rename、manifest 后 rename，tmp 不残留', async () => {
    resetFake()
    const c = ctx()
    const result = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'rescan', c)
    expect(result.ok).toBe(true)

    const renames = fake.ops.filter((o) => o.startsWith('rename:'))
    expect(renames.length).toBe(2)
    expect(renames[0]).toMatch(/->.*index\.json$/)
    expect(renames[1]).toMatch(/->.*manifest\.json$/)
    // 固定 tmp 名 + rename 后不残留（插件侧只需忽略 `*.tmp*`）
    expect(fake.files.has(`${pluginIndexPath(c.dir)}${PLUGIN_TMP_SUFFIX}`)).toBe(false)
    expect(fake.files.has(`${pluginManifestPath(c.dir)}${PLUGIN_TMP_SUFFIX}`)).toBe(false)
  })

  it('rename 失败时原文件保持不动：插件仍看到完整可用的旧快照，失败只记进数据字段', async () => {
    resetFake()
    const c = ctx()
    // 先落一份有效快照（模拟「上一份」）
    const first = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'startup', c)
    expect(first.ok).toBe(true)
    const savedIndex = fake.files.get(pluginIndexPath(c.dir))
    expect(savedIndex).toBeDefined()

    fake.failRenameAt = fake.renameCount + 1 // 本次 index 的 rename 失败
    const result = await writePluginSnapshot(buildPluginRecords([sampleAsset({ id: 'new' })]), 'rescan', c)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('102')
    expect(result.error?.message).toContain('写盘失败')
    expect(logSpy.warns).toContain('plugin:write:failed')

    // index.json 仍是上一份内容（被拒的那次没有落盘，也没被清空）
    expect(fake.files.get(pluginIndexPath(c.dir))).toBe(savedIndex)
    // manifest 走的是状态记录，且它自己也在同一条串行链上
    const manifest = JSON.parse(fake.files.get(pluginManifestPath(c.dir)) as string)
    expect(manifest.state).toBe('error')
    expect(manifest.lastError?.code).toBe('102')
    expect(manifest.lastError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

// ── (d) debounce + max-wait（假时钟逐毫秒推进）─────────────────────────────
describe('节流：quiet 1.5 s + max-wait 5 s，无定时兜底', () => {
  it('quiet 窗口内多次触发只落盘一次，且第一次触发不抢跑', async () => {
    const flushes: string[] = []
    const { clock, advance } = fakeClock(1000)
    const throttle = createPluginThrottle((t) => {
      flushes.push(t)
    }, clock)

    expect(throttle.hit('importBatchDone')).toBe(false)
    expect(flushes.length).toBe(0) // ⚠️ 首触发不写：拍板口径是「安静后落盘一次」
    advance(DEBOUNCE_QUIET_MS - 1)
    expect(flushes.length).toBe(0)
    advance(1)
    await throttle.idle()
    expect(flushes).toEqual(['importBatchDone'])
    expect(throttle.pending()).toBe(null)
  })

  it('持续小流不断续期 quiet 窗口，到 max-wait 必须强制落盘一次', async () => {
    const flushes: string[] = []
    const { clock, advance } = fakeClock(0)
    const throttle = createPluginThrottle((t) => {
      flushes.push(t)
    }, clock)

    throttle.hit('rescan')
    for (let i = 0; i < 4; i += 1) {
      advance(1000) // 每 1 s 一次：quiet 窗口被续期，永远不到期
      throttle.hit('rescan')
      expect(flushes.length).toBe(0)
    }
    expect(clock.now()).toBe(4000)
    expect(clock.now()).toBeLessThan(throttle.pending()?.maxWaitAt ?? 0)
    advance(1000) // 到 5000 ms 硬上限
    expect(clock.now()).toBe(5000)
    expect(throttle.hit('rescan')).toBe(true)
    await throttle.idle()
    expect(flushes).toEqual(['rescan'])
    expect(DEBOUNCE_QUIET_MS).toBe(1500)
    expect(MAX_WAIT_MS).toBe(5000)
  })

  it('quiet 落盘必须携带真实触发名，不能写死 `quiet`（白名单是 deny by default）', async () => {
    const flushes: string[] = []
    const { clock, advance } = fakeClock(0)
    const throttle = createPluginThrottle((t) => {
      flushes.push(t)
    }, clock)
    throttle.hit('assignCategory')
    advance(DEBOUNCE_QUIET_MS)
    await throttle.idle()
    expect(flushes).toEqual(['assignCategory'])
    expect(flushes).not.toContain('quiet')
    expect(isPluginTrigger('quiet')).toBe(false)
  })

  it('没有定时兜底：静默一段时间后不产生任何新的落盘（拍板项）', async () => {
    const flushes: string[] = []
    const { clock, advance } = fakeClock(0)
    const throttle = createPluginThrottle((t) => {
      flushes.push(t)
    }, clock)

    throttle.hit('importBatchDone')
    advance(DEBOUNCE_QUIET_MS)
    await throttle.idle()
    expect(flushes.length).toBe(1)
    advance(30_000) // 再推 30 秒：没有「每 N 秒写一次」的定时器
    await throttle.idle()
    expect(flushes.length).toBe(1)
    expect(throttle.pending()).toBe(null)
  })

  it('落盘回调抛错不卡死后续排期（与 `createSettingsWriteQueue` 同一纪律）', async () => {
    const { clock, advance } = fakeClock(0)
    let calls = 0
    const throttle = createPluginThrottle((t) => {
      calls += 1
      if (calls === 1) throw new Error('EBUSY')
      return Promise.resolve()
    }, clock)

    throttle.hit('rescan')
    advance(DEBOUNCE_QUIET_MS)
    await throttle.idle()
    expect(calls).toBe(1)
    throttle.hit('rescan')
    advance(DEBOUNCE_QUIET_MS)
    await throttle.idle()
    expect(calls).toBe(2)
  })

  it('flushNow 绕过节流立刻落盘（面板手动刷新），被取消的 quiet 窗口不能再落盘', async () => {
    const flushes: string[] = []
    const { clock, advance } = fakeClock(0)
    const throttle = createPluginThrottle((t) => {
      flushes.push(t)
    }, clock)
    throttle.hit('rescan')
    await throttle.flushNow('manualRefresh')
    expect(flushes).toEqual(['manualRefresh'])
    advance(DEBOUNCE_QUIET_MS)
    await throttle.idle()
    expect(flushes).toEqual(['manualRefresh'])
  })

  it('节流源码守卫：不许出现周期性兜底定时器（`setInterval`）', () => {
    const src = readFileSync(new URL('../src/main/pluginThrottle.ts', import.meta.url), 'utf-8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('setInterval')
    expect(code).toContain('setTimeout')
  })
})

// ── (e) 触发集排除缩略图涓流 ────────────────────────────────────────────────
describe('触发集（§6 A1 已拍板，deny by default）', () => {
  it('触发集恰好六项，且不含缩略图涓流', () => {
    expect([...PLUGIN_TRIGGER_SET]).toEqual([
      'startup',
      'importBatchDone',
      'rescan',
      'assignCategory',
      'trashRestore',
      'manualRefresh'
    ])
    for (const excluded of EXCLUDED_PLUGIN_TRIGGERS) {
      expect(PLUGIN_TRIGGER_SET as readonly string[]).not.toContain(excluded)
      expect(isPluginTrigger(excluded)).toBe(false)
    }
    expect(EXCLUDED_PLUGIN_TRIGGERS).toEqual(['thumbDrip'])
    // 未知事件一律拒
    expect(isPluginTrigger('watcherChange')).toBe(false)
    expect(isPluginTrigger(null)).toBe(false)
    expect(isPluginTrigger(123)).toBe(false)
  })

  it('store.ts 的上报调用点恰好六个，且缩略图涓流函数体内没有调用', () => {
    const src = readFileSync(new URL('../src/renderer/store.ts', import.meta.url), 'utf-8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const callSites = [...code.matchAll(/reportPluginSnapshot\('([A-Za-z]+)'\)/g)].map((m) => m[1]).sort()
    expect(callSites).toEqual([
      'assignCategory',
      'importBatchDone',
      'manualRefresh',
      'rescan',
      'startup',
      'trashRestore'
    ])

    // 涓流函数体里不许出现上报调用（它形成的持续小流会把 debounce 永久续期）
    const dripAt = code.indexOf('export async function ensureMissingThumbs(')
    expect(dripAt).toBeGreaterThan(0)
    const nextAt = code.indexOf('\nfunction ', dripAt + 1)
    const dripBody = code.slice(dripAt, nextAt > dripAt ? nextAt : code.length)
    expect(dripBody).not.toContain('reportPluginSnapshot')

    // 反例保护：若有人把 rescan 的上报挪到涓流**之后**，守卫要能发现
    const rescanAt = code.indexOf('async rescan(')
    const rescanBody = code.slice(rescanAt, code.indexOf('\n  async forceRescan(', rescanAt))
    const callIdx = rescanBody.indexOf("reportPluginSnapshot('rescan')")
    const dripIdx = rescanBody.indexOf('void ensureMissingThumbs()')
    expect(callIdx).toBeGreaterThan(-1)
    expect(dripIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeLessThan(dripIdx)
  })

  it('不在触发集里的事件走到写盘必须被拒（102），一个字节都不写', async () => {
    resetFake()
    const result = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'thumbDrip', ctx())
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('102')
    expect(result.error?.message).toContain('触发点不在触发集内')
    expect(fake.ops.length).toBe(0)
    expect(logSpy.warns).toContain('plugin:write:rejected-trigger')
  })

  it('开关关闭：不落盘、归入 101（插件读不到文件即 IDBOX-101）', async () => {
    resetFake()
    const result = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'startup', ctx({ pluginIndexEnabled: false }))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('101')
    expect(fake.ops.length).toBe(0)
    expect(logSpy.warns).toContain('plugin:write:skipped')
  })

  it('取不到内容（null）：保留上一份，绝不写空内容掩盖失败', async () => {
    resetFake()
    const c = ctx()
    const first = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'startup', c)
    expect(first.ok).toBe(true)
    const savedIndex = fake.files.get(pluginIndexPath(c.dir))
    expect(savedIndex).toBeDefined()

    // 基线那次成功落盘本身产生了 ops；这里只关心**第二次**有没有产生新 ops
    const opsAfterBaseline = fake.ops.length
    expect(opsAfterBaseline).toBeGreaterThan(0)

    const second = await writePluginSnapshot(null, 'rescan', c)
    expect(second.ok).toBe(false)
    expect(second.error?.code).toBe('102')
    expect(second.error?.message).toContain('保留上一份有效快照')
    expect(fake.ops.length).toBe(opsAfterBaseline)
    expect(fake.files.get(pluginIndexPath(c.dir))).toBe(savedIndex)
  })
})

// ── (f) 规模判据分支（写死为代码常量）───────────────────────────────────────
describe('规模判据（§3.3 写死）', () => {
  it('≤2000 条且 ≤2 MB → full；任一项超 → over-limit', () => {
    expect(MAX_RECORDS).toBe(2000)
    expect(MAX_INDEX_BYTES).toBe(2 * 1024 * 1024)
    expect(scaleBranch(1, 10)).toBe('full')
    expect(scaleBranch(MAX_RECORDS, MAX_INDEX_BYTES)).toBe('full')
    expect(scaleBranch(MAX_RECORDS + 1, 10)).toBe('over-limit')
    expect(scaleBranch(1, MAX_INDEX_BYTES + 1)).toBe('over-limit')
  })

  it('超阈值：拒写 + 保留上一份 + 记 error（V1.0 无增量协议可走）', async () => {
    resetFake()
    const c = ctx()
    const before = await writePluginSnapshot(buildPluginRecords([sampleAsset()]), 'startup', c)
    expect(before.ok).toBe(true)
    const savedIndex = fake.files.get(pluginIndexPath(c.dir))

    // 基线成功落盘的 ops 不计入本轮断言：只验证「超阈值这一轮一个字节都不写」
    const opsAfterBaseline = fake.ops.length
    const many = buildPluginRecords(range(MAX_RECORDS + 1).map((i) => sampleAsset({ id: `x${i}` })))
    expect(many.length).toBe(MAX_RECORDS + 1)
    const over = await writePluginSnapshot(many, 'importBatchDone', c)
    expect(over.ok).toBe(false)
    expect(over.branch).toBe('over-limit')
    expect(over.error?.code).toBe('102') // 107–110 是「预留不定义」，只能归入 102
    expect(over.error?.message).toContain('增量协议未设计')
    expect(fake.ops.length).toBe(opsAfterBaseline)
    expect(fake.files.get(pluginIndexPath(c.dir))).toBe(savedIndex)
    expect(logSpy.warns).toContain('plugin:write:over-limit')
  })

  it('字节判据按 UTF-8 字节而非字符数（中文名一条就差几十字节）', () => {
    expect(byteLengthUtf8('a'.repeat(10))).toBe(10)
    expect(byteLengthUtf8('测'.repeat(10))).toBe(30)
    expect(byteLengthUtf8('测'.repeat(10))).not.toBe('测'.repeat(10).length)
    expect(byteLengthUtf8(null as never)).toBe(0)
  })
})

// ── 路径解析（PRD D1：插件不能猜路径，两个固定文件名）────────────────────────
describe('插件根目录解析（`process.env.APPDATA`，不另立第二套根）', () => {
  it('%APPDATA%\\idbox\\plugin\\', () => {
    const dir = resolvePluginRoot({ APPDATA })
    expect(dir).toBe(path.join(APPDATA, 'idbox', 'plugin'))
    expect(PLUGIN_APP_DIR_NAME).toBe('idbox')
    expect(PLUGIN_DIR_NAME).toBe('plugin')
    expect(PLUGIN_INDEX_FILE_NAME).toBe('index.json')
    expect(PLUGIN_MANIFEST_FILE_NAME).toBe('manifest.json')
    expect(PLUGIN_TMP_SUFFIX).toBe('.tmp')
    // pluginIndexPath / pluginManifestPath 收的是**解析后的插件根目录**，不是原始 APPDATA
    const resolved = resolvePluginRoot({ APPDATA })
    if (resolved) {
      expect(pluginIndexPath(resolved)).toBe(path.join(resolved, 'index.json'))
      expect(pluginManifestPath(resolved)).toBe(path.join(resolved, 'manifest.json'))
    }
  })

  it('APPDATA 缺失 / 空串 / 非字符串 → null（绝不回落到猜测路径）', () => {
    expect(resolvePluginRoot({})).toBe(null)
    expect(resolvePluginRoot({ APPDATA: '   ' })).toBe(null)
    expect(resolvePluginRoot({ APPDATA: 123 as never })).toBe(null)
    expect(() => resolvePluginRoot({ APPDATA: undefined })).not.toThrow()
  })

  it('SHA256 输出小写 64 hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── 串行写队列（§2.1：修法是它，不是文件锁、也不是随机 tmp 名）──────────────
describe('插件写盘串行队列', () => {
  it('8 个并发任务严格串行：无交错，开始/结束顺序与入队顺序一致', async () => {
    const queue = createPluginWriteQueue()
    const events: string[] = []
    let active = 0
    let maxActive = 0

    const tasks = range(10).map((i) =>
      queue.enqueue(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push(`start-${i}`)
        await tick()
        await tick()
        events.push(`end-${i}`)
        active -= 1
        return i
      })
    )

    const results = await Promise.all(tasks)
    expect(maxActive).toBe(1)
    expect(active).toBe(0)
    expect(events).toEqual(range(10).flatMap((i) => [`start-${i}`, `end-${i}`]))
    expect(results).toEqual(range(10)) // 返回值不串台
  })

  it('第 3 个任务 reject 不阻断后续：链不卡死、失败只回传给该次调用方', async () => {
    const queue = createPluginWriteQueue()
    const ran: number[] = []
    const results = await Promise.allSettled(
      range(10).map((i) =>
        queue.enqueue(async () => {
          await tick()
          if (i === 2) throw new Error('EPERM')
          ran.push(i)
          return i
        })
      )
    )
    expect(ran).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9])
    expect(results[2].status).toBe('rejected')
    expect(results[3].status).toBe('fulfilled')
    await queue.idle()
  })

  it('链不持有 rejection：排空后没有未处理拒绝冒出来', async () => {
    const queue = createPluginWriteQueue()
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.once('unhandledRejection', listener)
    await queue.enqueue(async () => {
      throw new Error('boom')
    }).catch(() => undefined)
    await queue.idle()
    await settleUnhandled()
    process.removeListener('unhandledRejection', listener)
    expect(unhandled).toEqual([])
  })

  it('6 次并发落盘：write / rename 严格交替不交错，最终落盘是第 6 次内容', async () => {
    resetFake()
    const c = ctx()
    const index = pluginIndexPath(c.dir)
    const tmp = `${index}${PLUGIN_TMP_SUFFIX}`
    const queue = createPluginWriteQueue()

    await Promise.all(
      range(6).map((i) =>
        queue.enqueue(async () => {
          const text = serializeCompact({ n: i })
          await enqueuePluginWrite(async () => {
            // 与模块内同一个假 fs（writeFile / rename 已 mock）
            const fsPromises = await import('node:fs/promises')
            await fsPromises.writeFile(tmp, text, 'utf-8')
            await fsPromises.rename(tmp, index)
          })
        })
      )
    )

    expect(fake.ops).toEqual(range(6).flatMap(() => [`write:${tmp}`, `rename:${tmp}->${index}`]))
    expect(JSON.parse(fake.files.get(index) as string)).toEqual({ n: 5 })
  })

  it('串行队列源码守卫：`then(fn, fn)` 与「链不持有 rejection」两条写法不许退化', () => {
    const src = readFileSync(new URL('../src/main/pluginExport.ts', import.meta.url), 'utf-8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('writeChain.then(fn, fn)')
    expect(code).toContain('writeChain = next.catch(() => undefined)')
  })
})

// ── 错误码归属（§5：共用一张 ≤10 的表，不另立）────────────────────────────────
describe('错误码归属（§5）', () => {
  it('101–106 已定义、107–110 预留不定义、总数 ≤10', () => {
    expect(Object.keys(IDBOX_ERROR_CODES)).toEqual(['101', '102', '103', '104', '105', '106'])
    expect(MAX_ERROR_CODES).toBe(10)
    expect(RESERVED_ERROR_CODES).toEqual(['107', '108', '109', '110'])
    for (const code of ['101', '102', '103', '104', '105', '106']) {
      expect(isDefinedErrorCode(code)).toBe(true)
    }
    for (const code of RESERVED_ERROR_CODES) {
      expect(isDefinedErrorCode(code)).toBe(false)
    }
    expect(isDefinedErrorCode('111')).toBe(false)
    expect(isDefinedErrorCode(null)).toBe(false)
    expect(Object.keys(IDBOX_ERROR_CODES).length + RESERVED_ERROR_CODES.length).toBeLessThanOrEqual(MAX_ERROR_CODES)
  })

  it('写侧失败只归入 101/102（不新增码）', async () => {
    const used = new Set<string>()
    const cases: Array<{ label: string; trigger: string; records: PluginSnapshotRecord[] | null; patch: Partial<PluginWriteContext> }> = [
      { label: '开关关', trigger: 'startup', records: buildPluginRecords([sampleAsset()]), patch: { pluginIndexEnabled: false } },
      { label: '触发点不合法', trigger: 'thumbDrip', records: buildPluginRecords([sampleAsset()]), patch: {} },
      { label: '取不到内容', trigger: 'rescan', records: null, patch: {} },
      { label: '超阈值', trigger: 'importBatchDone', records: buildPluginRecords(range(MAX_RECORDS + 1).map((i) => sampleAsset({ id: `z${i}` }))), patch: {} },
      { label: 'IO 失败', trigger: 'rescan', records: buildPluginRecords([sampleAsset()]), patch: {} }
    ]
    for (const c of cases) {
      resetFake()
      if (c.label === 'IO 失败') fake.failWriteAt = 1
      const result = await writePluginSnapshot(c.records, c.trigger, ctx(c.patch))
      expect(result.ok, c.label).toBe(false)
      if (result.error) {
        expect(isDefinedErrorCode(result.error.code), c.label).toBe(true)
        used.add(result.error.code)
      }
    }
    expect([...used].sort()).toEqual(['101', '102'])
  })
})

// ── Settings 开关的单项降级纪律（§2.2）──────────────────────────────────────
describe('SettingsSchema.pluginIndexEnabled 单项降级', () => {
  it('脏值只让这一项回落 false，同文件的 libraryDir 不丢（否则库会「消失」）', async () => {
    const { SettingsSchema, normalizeSettings } = await import('../src/main/settings')
    const parsed = SettingsSchema.safeParse({ libraryDir: LIB, pluginIndexEnabled: 'yes' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const s = normalizeSettings(parsed.data as Partial<Settings>)
      expect(s.pluginIndexEnabled).toBe(false)
      expect(s.libraryDir).toBe(LIB)
    }
  })

  it('严格 true 才开；缺键默认 false（写盘是新增副作用，必须用户显式开启）', async () => {
    const { SettingsSchema, normalizeSettings } = await import('../src/main/settings')
    const on = SettingsSchema.safeParse({ libraryDir: LIB, pluginIndexEnabled: true })
    if (on.success) expect(normalizeSettings(on.data as Partial<Settings>).pluginIndexEnabled).toBe(true)
    const missing = SettingsSchema.safeParse({ libraryDir: LIB })
    if (missing.success) expect(normalizeSettings(missing.data as Partial<Settings>).pluginIndexEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.pluginIndexEnabled).toBe(false)
  })
})

// ── 排期器（§6 A1）───────────────────────────────────────────────────────────
describe('排期器：最新内容与按次读取的上下文', () => {
  it('quiet 落盘用的是当时最新的记录，不是第一次触发时的快照', async () => {
    resetFake()
    const c = ctx()
    const { clock, advance } = fakeClock(0)
    const writer = createPluginWriter(c, clock)

    expect(writer.schedule('importBatchDone', buildPluginRecords([sampleAsset({ id: 'old' })]))).toBe(false)
    expect(writer.schedule('importBatchDone', buildPluginRecords([sampleAsset({ id: 'new' })]))).toBe(false)
    expect(writer.pending()).not.toBe(null)
    advance(DEBOUNCE_QUIET_MS)
    await writer.idle()

    const envelope = JSON.parse(fake.files.get(pluginIndexPath(c.dir)) as string)
    expect(envelope.records.map((r: PluginSnapshotRecord) => r.id)).toEqual(['new'])
  })

  it('上下文按次读取：中途打开开关后下一次触发立即生效（不需重启）', async () => {
    resetFake()
    const enabled = { value: false }
    const { clock, advance } = fakeClock(0)
    const writer = createPluginWriter(() => ({ ...ctx(), pluginIndexEnabled: enabled.value }), clock)

    expect(writer.schedule('importBatchDone', buildPluginRecords([sampleAsset()]))).toBe(false)
    expect(fake.ops.length).toBe(0)

    enabled.value = true
    expect(writer.schedule('importBatchDone', buildPluginRecords([sampleAsset()]))).toBe(false)
    advance(DEBOUNCE_QUIET_MS)
    await writer.idle()

    const dir = path.join(APPDATA, PLUGIN_APP_DIR_NAME, PLUGIN_DIR_NAME)
    expect(fake.files.has(pluginIndexPath(dir))).toBe(true)
    const manifest = JSON.parse(fake.files.get(pluginManifestPath(dir)) as string)
    expect(manifest.pluginIndexEnabled).toBe(true)
    expect(manifest.state).toBe('ok')
  })

  it('非触发集事件在排期器层就被拒（返回 false，不排进 quiet 窗口）', async () => {
    resetFake()
    const { clock } = fakeClock(0)
    const writer = createPluginWriter(ctx(), clock)
    expect(writer.schedule('thumbDrip', buildPluginRecords([sampleAsset()]))).toBe(false)
    expect(writer.pending()).toBe(null)
    expect(fake.ops.length).toBe(0)
  })
})

// ── 分层纪律：渲染层无 Node 能力（README.md:285）────────────────────────────
describe('分层与接线守卫', () => {
  it('preload 白名单里有 reportPluginSnapshot，且插件快照模块零 Node 能力', () => {
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf-8')
    const code = preload.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('reportPluginSnapshot')
    expect(code).not.toContain('node:fs')

    const snapshot = readFileSync(new URL('../src/shared/pluginSnapshot.ts', import.meta.url), 'utf-8')
    const snapshotCode = snapshot.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // 纯函数层：不许出现 IO / electron / Dexie
    for (const banned of ['node:fs', 'node:crypto', 'electron', 'dexie', 'Dexie']) {
      expect(snapshotCode, banned).not.toContain(banned)
    }
  })

  it('主进程 handler 存在且走白名单校验（fire-and-forget）', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain(`ipcMain.handle(IPC.pluginSnapshot`)
    expect(code).toContain('isPluginTrigger(payload.trigger)')
    expect(code).toContain('getPluginWriter()')
  })

  it('IPC 通道名固定为 `plugin:snapshot`，共享层不反向依赖 renderer', () => {
    const ipc = readFileSync(new URL('../src/shared/ipc.ts', import.meta.url), 'utf-8')
    expect(ipc).toContain("pluginSnapshot: 'plugin:snapshot'")
    const snapshot = readFileSync(new URL('../src/shared/pluginSnapshot.ts', import.meta.url), 'utf-8')
    expect(snapshot).not.toContain('../renderer')
  })
})
