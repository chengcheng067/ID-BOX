/**
 * C 线「最近删除」+ 保留期四档（docs/20 §4，2026-10 用户拍板）。
 *
 * 覆盖：
 * - 四档归一化（缺键 / 脏值 → '30d'，四值各自保留）与**单项降级**（脏值不拖垮整份 settings）
 * - 软删（rename 到 `.trash/`）/ 还原（含重名追加序号）/ 彻底删除（进系统回收站）
 * - `sweepExpired`：过期先清、未过期不动、超容量从最旧开始清
 * - rescan 与 watcher 必须跳过 `.trash`（硬约束，否则软删资产会被重新索引）
 *
 * 所有文件系统实验都在 `os.tmpdir()`，绝不碰真实库与 userData。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_VALUES
} from '../src/shared/types'
import {
  normalizeSettings,
  normalizeTrashRetention,
  SettingsSchema
} from '../src/main/settings'
import {
  emptyLibraryTrash,
  LIBRARY_TRASH_DIR,
  listTrashEntries,
  moveToLibraryTrash,
  purgeToRecycleBin,
  restoreFromLibraryTrash,
  sweepExpired,
  TRASH_MAX_BYTES,
  trashRootOf,
  type TrashStrategy
} from '../src/main/trash'
import { rescanLibrary } from '../src/main/rescan'
import { shouldIgnoreWatchPath } from '../src/main/watcher'

const tmpRoots: string[] = []

async function tmpLib(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-trash-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 造一个 4 层布局的资产目录，返回其绝对路径 */
async function makeAsset(lib: string, name = '沙发'): Promise<string> {
  const dir = path.join(lib, '模型', '未分类', '未分类', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, '模型.skp'), Buffer.alloc(32, 1))
  return dir
}

/** 回收站策略桩：真的删掉目录（模拟 shell.trashItem 成功），并记录调用 */
function makeStrategy(): { strategy: TrashStrategy; trashed: string[] } {
  const trashed: string[] = []
  return {
    trashed,
    strategy: {
      trashItem: async (p: string) => {
        trashed.push(p)
        await fs.rm(p, { recursive: true, force: true })
      },
      packageTrash: async () => {
        throw new Error('packageTrash 不应被调用（首选策略已成功）')
      }
    }
  }
}

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'

// ── 1. 四档归一化 ──────────────────────────────────────────────────

describe('trashRetention 四档归一化', () => {
  it('默认值是 30d（对用户最安全）', () => {
    expect(DEFAULT_SETTINGS.trashRetention).toBe('30d')
    expect(TRASH_RETENTION_DAYS['30d']).toBe(30)
    expect(TRASH_RETENTION_DAYS.recycle).toBe(0)
    expect([...TRASH_RETENTION_VALUES]).toEqual(['5d', '10d', '30d', 'recycle'])
  })

  it('四个合法值原样保留', () => {
    for (const v of TRASH_RETENTION_VALUES) {
      expect(normalizeTrashRetention(v)).toBe(v)
    }
  })

  it('缺键 / 脏值 → 30d（含 null、数字、相似但非法的字符串）', () => {
    for (const bad of [undefined, null, '', '7d', '30', 30, true, {}]) {
      expect(normalizeTrashRetention(bad)).toBe('30d')
    }
  })

  it('zod 单项降级：trashRetention 脏值不拖垮整份 settings（libraryDir 必须保住）', () => {
    const parsed = SettingsSchema.safeParse({
      libraryDir: 'E:\\ModVault\\Library',
      trashRetention: '7d'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.libraryDir).toBe('E:\\ModVault\\Library')
    expect(normalizeTrashRetention(parsed.data.trashRetention)).toBe('30d')
  })

  it('normalizeSettings 写档前同样归一到四档', () => {
    expect(normalizeSettings({ libraryDir: 'X', trashRetention: '10d' }).trashRetention).toBe('10d')
    const dirty = normalizeSettings({
      libraryDir: 'X',
      // 故意塞脏值：写档前必须回落 30d，不能把非法值写进 settings.json
      trashRetention: 'garbage' as never
    })
    expect(dirty.trashRetention).toBe('30d')
  })
})

// ── 2. 软删 / 还原 / 彻底删除 ──────────────────────────────────────

describe('moveToLibraryTrash（软删）', () => {
  it('目录 rename 到 .trash/<id>/，原位置消失，meta 记下 deletedAt/relFolder/size', async () => {
    const lib = await tmpLib()
    const folder = await makeAsset(lib)

    const r = await moveToLibraryTrash(lib, ID, folder)

    expect(r.trashRel).toBe(`${LIBRARY_TRASH_DIR}/${ID}`)
    expect(r.deletedAt).toBeGreaterThan(0)
    expect(r.size).toBeGreaterThanOrEqual(32)

    // 原位置没了，回收区里有
    await expect(fs.stat(folder)).rejects.toThrow()
    await expect(fs.stat(path.join(trashRootOf(lib), ID, '模型.skp'))).resolves.toBeTruthy()

    // meta：directory 外，不污染资产本体
    const meta = JSON.parse(
      await fs.readFile(path.join(trashRootOf(lib), '.meta', `${ID}.json`), 'utf-8')
    )
    expect(meta.id).toBe(ID)
    expect(meta.relFolder).toBe('模型/未分类/未分类/沙发')
    expect(meta.name).toBe('沙发')
    expect(meta.deletedAt).toBe(r.deletedAt)
    expect(meta.size).toBe(r.size)
  })

  it('非法 id / 库外路径 → 抛错且不动磁盘', async () => {
    const lib = await tmpLib()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-outside-'))
    tmpRoots.push(outside)
    await fs.writeFile(path.join(outside, 'x.txt'), 'x')

    await expect(moveToLibraryTrash(lib, '../evil', outside)).rejects.toThrow()
    await expect(moveToLibraryTrash(lib, ID, outside)).rejects.toThrow()
    await expect(fs.stat(path.join(outside, 'x.txt'))).resolves.toBeTruthy()
  })
})

describe('restoreFromLibraryTrash（还原）', () => {
  it('搬回原路径，meta 清掉，renamed=false', async () => {
    const lib = await tmpLib()
    const folder = await makeAsset(lib)
    const soft = await moveToLibraryTrash(lib, ID, folder)

    const r = await restoreFromLibraryTrash(lib, {
      trashRel: soft.trashRel,
      relFolder: '模型/未分类/未分类/沙发',
      name: '沙发'
    })

    expect(r.renamed).toBe(false)
    expect(r.folder).toBe(folder)
    expect(r.relFolder).toBe('模型/未分类/未分类/沙发')
    await expect(fs.stat(path.join(folder, '模型.skp'))).resolves.toBeTruthy()
    // 回收区已空
    expect(await listTrashEntries(lib)).toEqual([])
  })

  it('原位置已被占用 → uniqueName 追加 -2，renamed=true 且 relFolder 同步（不静默）', async () => {
    const lib = await tmpLib()
    const folder = await makeAsset(lib)
    const soft = await moveToLibraryTrash(lib, ID, folder)

    // 还原前又建了一个同名资产（磁盘是真相，不查词表）
    const occupied = path.join(lib, '模型', '未分类', '未分类', '沙发')
    await fs.mkdir(occupied, { recursive: true })
    await fs.writeFile(path.join(occupied, 'other.skp'), 'x')

    const r = await restoreFromLibraryTrash(lib, {
      trashRel: soft.trashRel,
      relFolder: '模型/未分类/未分类/沙发',
      name: '沙发'
    })

    expect(r.renamed).toBe(true)
    expect(path.basename(r.folder)).toBe('沙发-2')
    expect(r.relFolder).toBe('模型/未分类/未分类/沙发-2')
    await expect(fs.stat(path.join(r.folder, '模型.skp'))).resolves.toBeTruthy()
  })

  it('分类目录被删 → mkdir -p 重建（不要求分类词表存在）', async () => {
    const lib = await tmpLib()
    const folder = await makeAsset(lib)
    const soft = await moveToLibraryTrash(lib, ID, folder)
    await fs.rm(path.join(lib, '模型'), { recursive: true, force: true })

    const r = await restoreFromLibraryTrash(lib, {
      trashRel: soft.trashRel,
      relFolder: '模型/未分类/未分类/沙发',
      name: '沙发'
    })
    await expect(fs.stat(path.join(r.folder, '模型.skp'))).resolves.toBeTruthy()
  })

  it('非法 trashRel（越界 / 多段）→ 抛错', async () => {
    const lib = await tmpLib()
    await expect(
      restoreFromLibraryTrash(lib, {
        trashRel: '.trash/../../Windows',
        relFolder: '模型/未分类/未分类/x',
        name: 'x'
      })
    ).rejects.toThrow()
    await expect(
      restoreFromLibraryTrash(lib, {
        trashRel: '模型/未分类',
        relFolder: '模型/未分类/未分类/x',
        name: 'x'
      })
    ).rejects.toThrow()
  })
})

describe('purgeToRecycleBin / emptyLibraryTrash（进系统回收站）', () => {
  it('只允许操作 .trash 内的路径，且调用注入的 trashItem', async () => {
    const lib = await tmpLib()
    const folder = await makeAsset(lib)
    const soft = await moveToLibraryTrash(lib, ID, folder)
    const { strategy, trashed } = makeStrategy()

    await purgeToRecycleBin(lib, soft.trashRel, strategy)
    expect(trashed).toHaveLength(1)
    expect(trashed[0]!.startsWith(path.resolve(trashRootOf(lib)))).toBe(true)
    expect(await listTrashEntries(lib)).toEqual([])

    await expect(purgeToRecycleBin(lib, '模型/未分类', strategy)).rejects.toThrow()
  })

  it('清空回收区：多个条目全部送往回收站', async () => {
    const lib = await tmpLib()
    const a = await makeAsset(lib, '沙发')
    const b = await makeAsset(lib, '椅子')
    await moveToLibraryTrash(lib, ID, a)
    await moveToLibraryTrash(lib, 'bbbbbbbb-2222-4333-8444-555566667777', b)
    const { strategy, trashed } = makeStrategy()

    const r = await emptyLibraryTrash(lib, strategy)
    expect(r.purged).toBe(2)
    expect(r.failed).toBe(0)
    expect(trashed).toHaveLength(2)
    expect(await listTrashEntries(lib)).toEqual([])
  })
})

// ── 3. sweepExpired：过期 / 容量 ───────────────────────────────────

describe('sweepExpired', () => {
  /** 造一条带指定 deletedAt 的回收项（直接写 meta，跳过 rename 以控制时间） */
  async function makeEntry(
    lib: string,
    id: string,
    deletedAt: number,
    bytes: number
  ): Promise<void> {
    const root = trashRootOf(lib)
    await fs.mkdir(path.join(root, id), { recursive: true })
    await fs.writeFile(path.join(root, id, 'f.bin'), Buffer.alloc(bytes, 1))
    await fs.mkdir(path.join(root, '.meta'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.meta', `${id}.json`),
      JSON.stringify({
        id,
        deletedAt,
        relFolder: `模型/未分类/未分类/${id}`,
        name: id,
        size: bytes
      }),
      'utf-8'
    )
  }

  it('保留期 5 天：6 天前的清掉，2 天前的不动', async () => {
    const lib = await tmpLib()
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    await makeEntry(lib, 'old-old-old', now - 6 * DAY, 10)
    await makeEntry(lib, 'fresh-entry', now - 2 * DAY, 10)
    const { strategy, trashed } = makeStrategy()

    const r = await sweepExpired(lib, 5, TRASH_MAX_BYTES, strategy)

    expect(r.purged).toBe(1)
    expect(trashed).toHaveLength(1)
    const left = await listTrashEntries(lib)
    expect(left.map((e) => e.id)).toEqual(['fresh-entry'])
  })

  it('retentionDays=0（recycle 档）跳过过期判定，只做容量兜底', async () => {
    const lib = await tmpLib()
    await makeEntry(lib, 'ancient-entry', Date.now() - 999 * 24 * 60 * 60 * 1000, 10)
    const { strategy } = makeStrategy()

    const r = await sweepExpired(lib, 0, TRASH_MAX_BYTES, strategy)
    expect(r.purged).toBe(0)
    expect(await listTrashEntries(lib)).toHaveLength(1)
  })

  it('超容量：从最旧的开始清，直到总量 ≤ maxBytes', async () => {
    const lib = await tmpLib()
    const now = Date.now()
    await makeEntry(lib, 'oldest', now - 3000, 100)
    await makeEntry(lib, 'middle', now - 2000, 100)
    await makeEntry(lib, 'newest', now - 1000, 100)
    const { strategy, trashed } = makeStrategy()

    // 上限 250 字节 / 3×100 = 300 → 必须清掉最旧的 1 条
    const r = await sweepExpired(lib, 30, 250, strategy)
    expect(r.purged).toBe(1)
    expect(r.bytes).toBe(100)
    const left = (await listTrashEntries(lib)).map((e) => e.id).sort()
    expect(left).toEqual(['middle', 'newest'])
    expect(trashed).toHaveLength(1)
  })

  it('5GB 是默认容量上限常量', () => {
    expect(TRASH_MAX_BYTES).toBe(5 * 1024 * 1024 * 1024)
  })
})

// ── 4. rescan / watcher 跳过 .trash（硬约束） ───────────────────────

describe('rescan 与 watcher 必须跳过 .trash', () => {
  it('rescan 不把 .trash 里的软删资产重新索引出来', async () => {
    const lib = await tmpLib()
    await makeAsset(lib, '正常资产')
    // 模拟"已软删"的资产：目录躺在 .trash 里，链路完全同构
    const trashedDir = path.join(lib, '.trash', ID, '模型', '未分类', '未分类', '已删资产')
    await fs.mkdir(trashedDir, { recursive: true })
    await fs.writeFile(path.join(trashedDir, 'x.skp'), Buffer.alloc(8, 1))

    const { assets, ignored } = await rescanLibrary(lib)
    expect(assets.map((a) => a.name)).toEqual(['正常资产'])
    // `.trash` 是合法排除项，不应作为"结构异常"上报（否则用户会看到莫名其妙的提示）
    expect(ignored).toEqual([])
  })

  it('watcher 忽略判定：.trash 段 / 隐藏目录 / 临时文件', () => {
    expect(shouldIgnoreWatchPath('E:\\Lib\\.trash\\abc\\model.zip')).toBe(true)
    expect(shouldIgnoreWatchPath('E:\\Lib\\模型\\.trash\\x.zip')).toBe(true)
    expect(shouldIgnoreWatchPath('E:\\Lib\\.staging\\a.zip')).toBe(true)
    expect(shouldIgnoreWatchPath('E:\\Downloads\\包.zip.crdownload')).toBe(true)
    // 正常下载包必须放行（别把功能误伤掉）
    expect(shouldIgnoreWatchPath('E:\\Downloads\\沙发.zip')).toBe(false)
  })
})
