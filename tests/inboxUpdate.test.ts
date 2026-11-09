/**
 * 「更新 ID BOX 中的这个模型」的**真实落盘**测试（`src/main/inboxUpdate.ts`）。
 *
 * 与 `tests/inboxManifest.test.ts` 的分工：那边测纯决策（目标名怎么选、什么判废），
 * 这边测**磁盘上到底动了什么**——而这一层的每个断言都对应一条用户口径或一条风险：
 *
 * | 断言组 | 防的事故 |
 * |---|---|
 * | 只覆盖那一个 `.skp`，兄弟文件逐字节不变 | 走 `importPaths` 覆盖档会把旧目录送进回收站、丢掉 renderParams / 自定义封面（勘察 §R5） |
 * | 成功后目录里没有残留 `.skp.tmp` | 残留的 `.tmp` 会被 rescan 当普通文件收进 `files[]` |
 * | 源文件必须在 `incoming\<jobId>\` 里 | 渲染层被注入后可以拿任意库外文件覆盖库内模型 |
 * | `targetRelFolder` 逐段校验 | `../../Windows` 这类穿越写库外 |
 * | 多 `.skp` 且不同名 → 拒绝（不猜） | 猜错 = 把一个模型的内容写进另一个模型 |
 *
 * 全部用 `os.tmpdir()` 下的真实临时目录（node 环境已够，不需要 jsdom）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyInboxSkpUpdate, type InboxUpdateDeps } from '../src/main/inboxUpdate'

/** 契约形态的 jobId（`isInboxJobId` 会校验它） */
const JOB_ID = '20261109-184000-ab12'
/** 相对库根的资产目录（四段标准形态） */
const REL = '模型/家具/椅子/休闲椅'

let root = ''
let lib = ''
let incoming = ''
let jobDir = ''
let srcSkp = ''
let deps: InboxUpdateDeps

/** 写文件并返回绝对路径（父目录自动建） */
async function writeFile(abs: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
  return abs
}

async function readFile(abs: string): Promise<string> {
  return fs.readFile(abs, 'utf-8')
}

/** 递归快照一个目录（path → 内容），用于断言"其它文件一个字节都没动" */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (cur: string): Promise<void> => {
    const entries = await fs.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(cur, e.name)
      if (e.isDirectory()) await walk(abs)
      else out[path.relative(dir, abs)] = await fs.readFile(abs, 'utf-8')
    }
  }
  await walk(dir)
  return out
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-inbox-'))
  lib = path.join(root, 'Library')
  incoming = path.join(root, 'idbox_export', 'incoming')
  jobDir = path.join(incoming, JOB_ID)
  srcSkp = await writeFile(path.join(jobDir, '休闲椅.skp'), 'SKP-V2-CONTENT')
  await writeFile(path.join(jobDir, '休闲椅.cover.png'), 'PNG-NEW')
  deps = { libraryDir: lib, incomingDir: incoming }
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** 造一个"已有资产"的目标目录，返回其绝对路径 */
async function seedAsset(
  files: Record<string, string> = { '休闲椅.skp': 'SKP-V1-CONTENT' }
): Promise<string> {
  const dir = path.join(lib, ...REL.split('/'))
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('applyInboxSkpUpdate — 正常路径', () => {
  it('同名 .skp 就地覆盖，返回 targetAbs / targetName / bytes / selection', async () => {
    const dir = await seedAsset()
    const targetAbs = path.join(dir, '休闲椅.skp')

    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.targetAbs).toBe(targetAbs)
    expect(r.targetName).toBe('休闲椅.skp')
    expect(r.bytes).toBe('SKP-V2-CONTENT'.length)
    expect(r.selection).toBe('exact')
    expect(await readFile(targetAbs)).toBe('SKP-V2-CONTENT')
  })

  it('⭐ 只覆盖那一个 .skp：分类/渲染参数/自定义封面/其它文件逐字节不变', async () => {
    const dir = await seedAsset({
      '休闲椅.skp': 'SKP-V1-CONTENT',
      '休闲椅.cover.png': 'USER-CUSTOM-COVER',
      'renderParams.json': '{"metalness":0.8}',
      '贴图/albedo.jpg': 'ALBEDO-BYTES'
    })
    const before = await snapshotDir(dir)

    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(true)

    const after = await snapshotDir(dir)
    // 只有 skp 变了，其余逐字节相同（这正是不许走 importPaths 覆盖档的原因）
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expect(after['休闲椅.skp']).toBe('SKP-V2-CONTENT')
    for (const key of Object.keys(before)) {
      if (key === '休闲椅.skp') continue
      expect(after[key]).toBe(before[key])
    }
    // renderParams / 自定义封面必须还在盘上（走覆盖档的话它们会被搬进回收站）
    expect(await readFile(path.join(dir, 'renderParams.json'))).toBe('{"metalness":0.8}')
    expect(await readFile(path.join(dir, '休闲椅.cover.png'))).toBe('USER-CUSTOM-COVER')
  })

  it('成功后不留 .tmp 残留（否则 rescan 会把它当普通文件收进 files[]）', async () => {
    const dir = await seedAsset()
    await applyInboxSkpUpdate({ targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID }, deps)
    const names = await fs.readdir(dir)
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('幂等：连续更新两次仍是同一结果', async () => {
    const dir = await seedAsset()
    const payload = { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID }
    expect((await applyInboxSkpUpdate(payload, deps)).ok).toBe(true)
    expect((await applyInboxSkpUpdate(payload, deps)).ok).toBe(true)
    expect(await readFile(path.join(dir, '休闲椅.skp'))).toBe('SKP-V2-CONTENT')
  })

  it('交付名与库内文件名不同但只有一个 .skp → 仍覆盖它（sole-skp，防主文件漂移）', async () => {
    const dir = await seedAsset({ 'Chair.skp': 'SKP-V1' })
    const otherSrc = await writeFile(path.join(jobDir, '椅子-减面.skp'), 'SKP-V2')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: otherSrc, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.selection).toBe('sole-skp')
    expect(r.targetName).toBe('Chair.skp')
    expect(await readFile(path.join(dir, 'Chair.skp'))).toBe('SKP-V2')
  })

  it('源 skp 可以是 job 目录里的子文件名（manifest.skp 不强制叫原名）', async () => {
    const dir = await seedAsset()
    const alt = await writeFile(path.join(jobDir, '导出副本.skp'), 'SKP-ALT')
    const r = await applyInboxSkpUpdate({ targetRelFolder: REL, skpSourcePath: alt, jobId: JOB_ID }, deps)
    expect(r.ok).toBe(true)
    expect(await readFile(path.join(dir, '休闲椅.skp'))).toBe('SKP-ALT')
  })
})

describe('applyInboxSkpUpdate — 安全边界', () => {
  it('jobId 不合法 → 拒绝', async () => {
    await seedAsset()
    for (const jobId of ['', '../x', 'latest', '20261109-184000-ab']) {
      const r = await applyInboxSkpUpdate({ targetRelFolder: REL, skpSourcePath: srcSkp, jobId }, deps)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('任务编号不合法')
    }
  })

  it('库目录未设置 → 拒绝（不崩）', async () => {
    await seedAsset()
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      { libraryDir: '   ', incomingDir: incoming }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('库目录尚未设置')
  })

  it('源文件不在 incoming\\<jobId>\\ 里 → 拒绝（防拿任意文件覆盖库内模型）', async () => {
    await seedAsset()
    const outside = await writeFile(path.join(root, 'evil.skp'), 'EVIL')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: outside, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不在该任务的收件箱目录里')
  })

  it('源文件在别的 job 目录里 → 拒绝', async () => {
    await seedAsset()
    const otherJob = await writeFile(
      path.join(incoming, '20261109-190000-zz99', 'x.skp'),
      'OTHER-JOB'
    )
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: otherJob, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
  })

  it('源文件在 job 子目录里 → 拒绝（只认直接子文件）', async () => {
    await seedAsset()
    const nested = await writeFile(path.join(jobDir, 'sub', 'x.skp'), 'NESTED')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: nested, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('直接文件')
  })

  it('源文件不是 .skp → 拒绝', async () => {
    await seedAsset()
    const png = await writeFile(path.join(jobDir, 'x.max'), 'MAX')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: png, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不是 .skp')
  })

  it('源文件 0 字节 → 拒绝（插件导出失败的典型形态）', async () => {
    await seedAsset()
    const empty = await writeFile(path.join(jobDir, 'empty.skp'), '')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: empty, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('空')
  })

  it('源文件不存在 → 拒绝', async () => {
    await seedAsset()
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: path.join(jobDir, 'nope.skp'), jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('读不到源文件')
  })

  it('targetRelFolder 穿越 → 拒绝，且库外文件不被写', async () => {
    await seedAsset()
    const outsideTarget = path.join(root, 'x.skp')
    await writeFile(outsideTarget, 'UNTOUCHED')
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: '../../../x', skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    expect(await readFile(outsideTarget)).toBe('UNTOUCHED')
  })

  it('targetRelFolder 是绝对路径 → 拒绝', async () => {
    await seedAsset()
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: 'C:\\Windows\\System32', skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不能带盘符')
  })

  it('targetRelFolder 落 .trash → 拒绝', async () => {
    await seedAsset()
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: '.trash/休闲椅', skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('保留目录')
  })
})

describe('applyInboxSkpUpdate — 目标目录异常', () => {
  it('目标目录不存在 → 中文原因 + 提示重扫', async () => {
    // 只建 incoming，不建库内资产目录
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('重新扫描库')
  })

  it('目标目录里没有 .skp → 拒绝', async () => {
    await seedAsset({ '休闲椅.cover.png': 'COVER' })
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('没有 .skp 文件')
  })

  it('目标目录里有多个 .skp 且都不同名 → 拒绝，且一个都不改', async () => {
    const dir = await seedAsset({ 'a.skp': 'A', 'b.skp': 'B' })
    const r = await applyInboxSkpUpdate(
      { targetRelFolder: REL, skpSourcePath: srcSkp, jobId: JOB_ID },
      deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('无法确定要覆盖哪一个')
    expect(await readFile(path.join(dir, 'a.skp'))).toBe('A')
    expect(await readFile(path.join(dir, 'b.skp'))).toBe('B')
  })
})

describe('applyInboxSkpUpdate — 入参类型容错（IPC 原始入参可能是任何东西）', () => {
  it('payload 为 null / undefined / 数字 → 拒绝而不抛', async () => {
    for (const payload of [null, undefined, 42, 'x', []]) {
      const r = await applyInboxSkpUpdate(payload, deps)
      expect(r.ok).toBe(false)
    }
  })
})
