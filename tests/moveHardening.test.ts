/**
 * 目录 / 路径边界硬化（2026-11 自查）· 单测
 *
 * 三个独立缺陷，一处一个用例组：
 * 1. `fsutil.moveDir` 的 catch 曾是无条件的 → 非跨卷失败（目标已存在 / 文件被占用）会走
 *    `fs.cp`（默认 `force: true`）**把源合并进已有目标**再 `rm(src)` = 静默丢数据；
 * 2. `layout.moveAssetCategory` 的「readdir 快照 + uniqueName + rename」不是原子单元 →
 *    并发搬到同一 parent 会选出同一个名字，第二个 rename 撞已存在目标（Windows EPERM/EEXIST）；
 * 3. `shared/vault.isWithinRoot` 大小写敏感 → Windows 下合法路径被判越界，一串 fail-closed 故障。
 *
 * 全部在 `os.tmpdir()` 造目录（**绝不触碰真实库**），`afterEach` 清理；本文件最多建 9 个
 * 临时根目录（`materialMerge.test.ts` 曾因建 51 个目录把 5000ms 默认超时顶破）。
 *
 * `node:fs/promises` 被**模块级 mock**：只替换 `rename`（`EXDEV` 注入 + 调用顺序记录 + 闸门），
 * 其余（`mkdtemp` / `cp` / `rm` / `readdir`…）全部透传真实实现——真磁盘、真 IO。
 * 注入开关用 `vi.hoisted` 建立，保证 `vi.mock` 工厂（会被提升）能安全引用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** rename 注入点（`vi.mock` 工厂内使用，必须先于 import 建立） */
const hook = vi.hoisted(() => ({
  /** 非 null 时 `fs.rename` 直接抛这个 `code`（模拟 EXDEV / EPERM …） */
  renameCode: null as string | null,
  /** 每次进入 rename 的 `{ from, to }`（按调用顺序） */
  order: [] as Array<{ from: string; to: string }>,
  /** 命中的那次 rename 会先 await 闸门（串行性用例用） */
  gateMatch: null as string | null,
  gate: null as Promise<void> | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const rename = async (oldPath: string, newPath: string): Promise<void> => {
    const from = String(oldPath)
    const to = String(newPath)
    hook.order.push({ from, to })
    if (hook.renameCode) {
      const err: NodeJS.ErrnoException = new Error(
        `${hook.renameCode}: injected rename, '${from}' -> '${to}'`
      )
      err.code = hook.renameCode
      throw err
    }
    if (hook.gate && hook.gateMatch && from.includes(hook.gateMatch)) {
      const wait = hook.gate
      hook.gate = null // 只卡第一次命中
      await wait
    }
    await actual.rename(oldPath, newPath)
  }
  // 同时替换命名导出与 default（`fsutil/layout` 用的是 `import fs from 'node:fs/promises'`）
  return { ...actual, rename, default: { ...actual, rename } }
})

// ⚠️ 必须在 vi.mock 之后 import（vi.mock 已被提升，这里只为可读性排列）
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { moveDir } from '../src/main/fsutil'
import { moveAssetCategory, moveQueueIdle } from '../src/main/layout'
import { LIBRARY_TRASH_DIR, moveToLibraryTrash } from '../src/main/trash'
import { isWithinRoot } from '../src/shared/vault'

// ── 临时目录（本文件最多 7 个） ───────────────────────────────────────

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-movehard-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  await moveQueueIdle()
  hook.renameCode = null
  hook.order.length = 0
  hook.gateMatch = null
  hook.gate = null
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined)
  }
})

beforeEach(() => {
  hook.renameCode = null
  hook.order.length = 0
  hook.gateMatch = null
  hook.gate = null
})

/** 路径存在判定（断言用，避免到处 try/catch） */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** 造目录 + 一个文件，返回该目录的绝对路径 */
async function makeDirWithFile(dir: string, fileName: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, fileName), content)
  return dir
}

/** 轮询等待条件成立（最多 2s）——避免用固定 sleep 猜时序 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: 条件未在超时内成立')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 装一道闸门：源路径含 match 的那次 rename 会停在这里，直到返回的函数被调用 */
function openGate(match: string): () => void {
  let open: () => void = () => undefined
  hook.gate = new Promise<void>((resolve) => {
    open = resolve
  })
  hook.gateMatch = match
  return () => open()
}

// ── A. moveDir ────────────────────────────────────────────────────────

describe('moveDir —— 只对跨卷退化（EXDEV）', () => {
  it('① 同卷移动：源消失、目标出现、不抛', async () => {
    const root = await tmpDir()
    const src = await makeDirWithFile(path.join(root, 'src'), 'a.txt', 'A')
    const dest = path.join(root, 'dest')

    await expect(moveDir(src, dest)).resolves.toBeUndefined()

    await expect(fs.readFile(path.join(dest, 'a.txt'), 'utf-8')).resolves.toBe('A')
    expect(await exists(src)).toBe(false)
    // 走的是 rename，不是 cp+rm
    expect(hook.order).toEqual([{ from: src, to: dest }])
  })

  it('② 目标已存在 → 必须抛错，且源与目标内容都不受影响（不发生合并）', async () => {
    const root = await tmpDir()
    const src = await makeDirWithFile(path.join(root, 'src'), 'from-src.txt', 'SRC')
    const dest = await makeDirWithFile(path.join(root, 'dest'), 'already-there.txt', 'KEEP')

    await expect(moveDir(src, dest)).rejects.toThrow()

    // 源目录完好（修复前这里会被 rm 掉）
    await expect(fs.readFile(path.join(src, 'from-src.txt'), 'utf-8')).resolves.toBe('SRC')
    // 目标里的原有文件仍在
    await expect(fs.readFile(path.join(dest, 'already-there.txt'), 'utf-8')).resolves.toBe('KEEP')
    // 没有发生合并：目标里不该出现源的任何文件名
    await expect(fs.readdir(dest)).resolves.toEqual(['already-there.txt'])
    // 只尝试了 rename，没有退化到 cp
    expect(hook.order).toHaveLength(1)
  })

  it(
    '③ 模拟 EXDEV → 退化 cp+rm：源消失、目标内容完整',
    async () => {
      const root = await tmpDir()
      const src = await makeDirWithFile(path.join(root, 'src'), 'a.txt', 'A')
      await fs.mkdir(path.join(src, 'sub'), { recursive: true })
      await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'B')
      const dest = path.join(root, 'dest')

      hook.renameCode = 'EXDEV'
      await expect(moveDir(src, dest)).resolves.toBeUndefined()

      await expect(fs.readFile(path.join(dest, 'a.txt'), 'utf-8')).resolves.toBe('A')
      await expect(fs.readFile(path.join(dest, 'sub', 'b.txt'), 'utf-8')).resolves.toBe('B')
      expect(await exists(src)).toBe(false)
    },
    20000
  )

  it(
    '④ 模拟 EXDEV + 目标已有同名文件 → errorOnExist 生效、抛错、源目录保留（复制失败绝不删源）',
    async () => {
      const root = await tmpDir()
      const src = await makeDirWithFile(path.join(root, 'src'), 'a.txt', 'NEW')
      const dest = await makeDirWithFile(path.join(root, 'dest'), 'a.txt', 'OLD')

      hook.renameCode = 'EXDEV'
      await expect(moveDir(src, dest)).rejects.toThrow()

      // 目标原有内容没被覆盖
      await expect(fs.readFile(path.join(dest, 'a.txt'), 'utf-8')).resolves.toBe('OLD')
      // 源目录**保留**（本用例钉的就是「复制失败绝不删源」）
      await expect(fs.readFile(path.join(src, 'a.txt'), 'utf-8')).resolves.toBe('NEW')
    },
    20000
  )

  it(
    '⑭ 模拟 EXDEV + 目标**空目录**已存在 → 抛错（中文可读原因）、源保留、目标不被写入',
    async () => {
      const root = await tmpDir()
      const src = await makeDirWithFile(path.join(root, 'src'), 'a.txt', 'A')
      const dest = path.join(root, 'dest')
      await fs.mkdir(dest) // 空目录：报错必须来自显式探活，而不是靠 cp 的英文 EEXIST

      hook.renameCode = 'EXDEV'
      await expect(moveDir(src, dest)).rejects.toThrow(/目标已存在/)

      // 源目录保留
      await expect(fs.readFile(path.join(src, 'a.txt'), 'utf-8')).resolves.toBe('A')
      // 目标仍是空目录：没有被"合并写入"
      await expect(fs.readdir(dest)).resolves.toEqual([])
      // 反向验证结论（实测）：回退到 d93af1d 的无条件 catch 版本时本用例报
      // 「promise resolved instead of rejecting」——即静默合并；
      // 只回退到 `errorOnExist` 版本时抛的是 Node 的 `Target already exists: cp returned EEXIST`
      // （英文、无路径、随 Node 版本漂移）。`pathExists` 前置探活给的是用户能看懂的中文原因。
    },
    20000
  )
})

// ── A2. 软删路径复用 moveDir（2026-11 第二批） ───────────────────────

describe('软删路径 —— 复用 moveDir，目标被占用时绝不合并', () => {
  it(
    '⑮ `.trash/<id>` 已被占用 → 走 `id-<时间戳>` 新名，两份资产各自完好（不熔成一份）',
    async () => {
      const root = await tmpDir()
      const lib = path.join(root, 'Library')
      const assetId = 'asset-1'
      const asset = await makeDirWithFile(
        path.join(lib, '模型', '未分类', '未分类', '沙发'),
        'a.skp',
        'NEW'
      )
      // 目标名已被上一次软删（或崩溃残留）占住，里面是**另一份**资产的内容
      const taken = await makeDirWithFile(
        path.join(lib, LIBRARY_TRASH_DIR, assetId),
        'old.skp',
        'OLD'
      )

      const res = await moveToLibraryTrash(lib, assetId, asset)

      // 换了名字，没往已有目录里塞
      expect(res.abs).not.toBe(taken)
      expect(path.dirname(res.abs)).toBe(path.join(lib, LIBRARY_TRASH_DIR))
      expect(path.basename(res.abs)).toMatch(/^asset-1-\d+$/)
      expect(res.trashRel).toBe(`${LIBRARY_TRASH_DIR}/${path.basename(res.abs)}`)

      // 旧条目原封不动（只有它自己那份文件）
      await expect(fs.readdir(taken)).resolves.toEqual(['old.skp'])
      await expect(fs.readFile(path.join(taken, 'old.skp'), 'utf-8')).resolves.toBe('OLD')
      // 新条目只有搬进来的那份文件（没有和 old.skp 熔在一起）
      await expect(fs.readdir(res.abs)).resolves.toEqual(['a.skp'])
      await expect(fs.readFile(path.join(res.abs, 'a.skp'), 'utf-8')).resolves.toBe('NEW')
      // 源目录已搬走
      expect(await exists(asset)).toBe(false)
    },
    20000
  )
})

// ── B. moveAssetCategory 串行化 ───────────────────────────────────────

describe('moveAssetCategory —— 目录移动串行队列', () => {
  it(
    '⑤ 并发 3 个同名移动到同一 parent → 全部成功，落到 同名 / 同名-2 / 同名-3',
    async () => {
      const root = await tmpDir()
      const parent = path.join(root, '库', '模型', '家具', '沙发')
      const srcs = ['A', 'B', 'C'].map((tag) =>
        path.join(root, '库', '模型', '未分类', tag, '同名')
      )
      for (let i = 0; i < srcs.length; i++) {
        await makeDirWithFile(srcs[i]!, 'x.txt', `SRC${i}`)
      }

      // 同时发起（不做任何人为串行）：uniqueName 的快照判重会让修复前的实现撞车
      const results = await Promise.all(srcs.map((src) => moveAssetCategory(src, parent)))

      // 三个都成功、名字互不相同
      expect(results.map((r) => r.moved)).toEqual([true, true, true])
      expect(results.map((r) => r.name).sort()).toEqual(['同名', '同名-2', '同名-3'])
      expect((await fs.readdir(parent)).sort()).toEqual(['同名', '同名-2', '同名-3'])
      // 每个 source 的内容都在，且对应自己那份
      for (const r of results) {
        await expect(fs.readFile(path.join(r.folder, 'x.txt'), 'utf-8')).resolves.toMatch(/^SRC\d$/)
      }
      // 源目录全部搬空
      for (const src of srcs) expect(await exists(src)).toBe(false)

      await moveQueueIdle()
    },
    20000
  )

  it(
    '⑥ 串行性：第一个移动未完成时，第二个不会进入 rename',
    async () => {
      const root = await tmpDir()
      const parent = path.join(root, '目标')
      const srcA = await makeDirWithFile(path.join(root, 'A', '资产'), 'x.txt', 'A')
      const srcB = await makeDirWithFile(path.join(root, 'B', '资产'), 'x.txt', 'B')

      // 让第一次 rename（源在 …/A/…）停在闸门上，模拟「移动未完成」
      const release = openGate(path.join('A', '资产'))
      const pA = moveAssetCategory(srcA, parent)
      const pB = moveAssetCategory(srcB, parent)

      await until(() => hook.order.length === 1)
      // 关键断言：A 还卡在 rename 里，B 绝不能已经进 rename（串行化生效）
      expect(hook.order).toHaveLength(1)
      expect(hook.order[0]!.from).toBe(srcA)

      release()
      const [resA, resB] = await Promise.all([pA, pB])
      expect(resA.moved).toBe(true)
      expect(resB.moved).toBe(true)
      // 顺序：A 的 rename 先于 B
      expect(hook.order).toHaveLength(2)
      expect(hook.order[1]!.from).toBe(srcB)
      expect(resA.name).toBe('资产')
      expect(resB.name).toBe('资产-2') // 串行后 B 读到 A 已占用的名字
    },
    20000
  )

  it('⑦ 队列不因失败断开：第一个抛错后，第二个仍能正常执行', async () => {
    const root = await tmpDir()
    const parent = path.join(root, '目标')
    const missing = path.join(root, '不存在', '资产')
    const good = await makeDirWithFile(path.join(root, '源', '资产'), 'x.txt', 'OK')

    // 第一个：源目录不存在 → rename ENOENT
    await expect(moveAssetCategory(missing, parent)).rejects.toThrow()
    // 第二个：必须照样跑（`moveChain.then(fn, fn)` 的语义）
    const res = await moveAssetCategory(good, parent)
    expect(res.moved).toBe(true)
    expect(res.name).toBe('资产')
    await expect(fs.readFile(path.join(parent, '资产', 'x.txt'), 'utf-8')).resolves.toBe('OK')
  })
})

// ── C. isWithinRoot 大小写 ────────────────────────────────────────────

describe('isWithinRoot —— Windows 大小写不敏感（POSIX 不受影响）', () => {
  const WIN = '\\'

  it('⑧ sep 为反斜杠：大小写不同的同一目录算在内；同前缀不同目录仍被挡', () => {
    expect(isWithinRoot('C:\\Lib', 'c:\\lib\\x', WIN)).toBe(true)
    expect(isWithinRoot('c:\\lib', 'C:\\Lib\\x', WIN)).toBe(true)
    expect(isWithinRoot('C:\\Lib', 'C:\\LIB2\\x', WIN)).toBe(false)
    expect(isWithinRoot('C:\\Lib', 'C:\\Lib', WIN)).toBe(true)
    expect(isWithinRoot('C:\\Lib', 'c:\\LIB', WIN)).toBe(true)
    // root 带尾分隔符 + 大小写不同
    expect(isWithinRoot('C:\\Lib\\', 'c:\\lib\\a.png', WIN)).toBe(true)
  })

  it('⑨ sep 为斜杠（POSIX）：保持大小写敏感，未被连坐', () => {
    expect(isWithinRoot('/lib', '/LIB/x', '/')).toBe(false)
    expect(isWithinRoot('/lib', '/lib/x', '/')).toBe(true)
    expect(isWithinRoot('/lib', '/libbak/x', '/')).toBe(false)
  })

  it('⑩ 空串一律 false（回归）', () => {
    expect(isWithinRoot('', 'c:\\lib\\x', WIN)).toBe(false)
    expect(isWithinRoot('C:\\Lib', '', WIN)).toBe(false)
    expect(isWithinRoot('', '', '/')).toBe(false)
  })
})

// ── D. 接线 guard（读源码，防实现被回退） ────────────────────────────

describe('接线 guard —— 硬化必须留在源码里', () => {
  async function readSrc(rel: string): Promise<string> {
    return fs.readFile(new URL(rel, import.meta.url), 'utf-8')
  }

  it('⑪ fsutil.moveDir：catch 条件化（只认 EXDEV）+ 跨卷前显式拒绝已存在目标', async () => {
    const src = await readSrc('../src/main/fsutil.ts')
    expect(src).toContain("!== 'EXDEV'")
    expect(src).toContain('if (await pathExists(dest))')
    expect(src).toContain('目标已存在')
    expect(src).toContain('errorOnExist: true')
    expect(src).toContain('force: false')
    // 不能再有无条件 catch（`catch {` 后直接 cp）
    expect(src).not.toMatch(/catch\s*\{\s*await fs\.cp/)
  })

  it('⑫ layout.moveAssetCategory：函数体被模块级串行队列包住', async () => {
    const src = await readSrc('../src/main/layout.ts')
    expect(src).toContain('let moveChain: Promise<unknown> = Promise.resolve()')
    expect(src).toContain('enqueueMove(')
    // 对外函数只是入队（整段 mkdir→rename 在 moveAssetCategoryUnlocked 里）
    expect(src).toMatch(
      /export async function moveAssetCategory\([\s\S]{0,300}?return enqueueMove\(\(\) => moveAssetCategoryUnlocked\(/
    )
    // 真正的 rename 在锁内的实现里
    expect(src).toContain('await fs.rename(folder, dest)')
  })

  it('⑬ shared/vault.isWithinRoot：Windows 分支按小写比较', async () => {
    const src = await readSrc('../src/shared/vault.ts')
    expect(src).toContain("if (sep === '\\\\')")
    expect(src).toContain('root.toLowerCase()')
    expect(src).toContain('abs.toLowerCase()')
  })

  it('⑯ trash.ts：复用 `fsutil.moveDir`，内联的无条件 catch 副本已删除', async () => {
    const src = await readSrc('../src/main/trash.ts')
    expect(src).toContain("from './fsutil'")
    expect(src).toContain('import { moveDir }')
    expect(src).toContain('await moveDir(src, dest)')
    // 不许再出现内联副本，也不许再直接 cp（那正是「无条件退化合并」的入口）
    expect(src).not.toContain('moveDirFallback')
    expect(src).not.toContain('fs.cp(')
  })
})
