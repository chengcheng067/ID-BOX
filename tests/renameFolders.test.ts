import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renameAssetFolders } from '../src/main/rename'
import type { RenameFolderPlanItem } from '../src/shared/types'

/**
 * `main/rename.ts` 的**真实文件系统**验收（0.6.0，docs/22 §3.4）。
 *
 * 不用任何 mock 文件系统：直接在本机 `os.tmpdir()` 里建库、改名、断言目录存在与否。
 * 这是本项目唯一会移动用户文件的批量动作，必须用真盘验证「成功 / 冲突拦下 / 失败回滚」。
 */

let root = ''

/** 建一个假库：`<tmp>/<name>/…` */
async function makeDir(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'a.txt'), `content of ${name}`)
  return dir
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 计划项：`folder` 是绝对路径，`to` 是单段新名 */
function plan(folder: string, to: string, id = path.basename(folder)): RenameFolderPlanItem {
  return { id, folder, to }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-rename-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('renameAssetFolders · 成功路径', () => {
  it('3 个目录全部改名：新目录存在、旧目录消失、包内文件保留', async () => {
    const a = await makeDir('沙发')
    const b = await makeDir('桌子')
    const c = await makeDir('床')

    const res = await renameAssetFolders(
      [plan(a, '001-沙发'), plan(b, '002-桌子'), plan(c, '003-床')],
      { libraryDir: root }
    )

    expect(res.failed).toEqual([])
    expect(res.rolledBack).toBe(false)
    expect(res.renamed.map((r) => r.id)).toEqual(['沙发', '桌子', '床'])
    expect(res.renamed.map((r) => r.name)).toEqual(['001-沙发', '002-桌子', '003-床'])

    for (const [oldName, newName] of [
      ['沙发', '001-沙发'],
      ['桌子', '002-桌子'],
      ['床', '003-床']
    ]) {
      expect(await exists(path.join(root, oldName))).toBe(false)
      expect(await exists(path.join(root, newName))).toBe(true)
      // 只改文件夹名，包里的文件原样
      expect(await fs.readFile(path.join(root, newName, 'a.txt'), 'utf-8')).toBe(
        `content of ${oldName}`
      )
    }
    // 返回的 folder 是最终落盘值
    expect(res.renamed[0].folder).toBe(path.join(root, '001-沙发'))
  })

  it('新旧同名 → 跳过，不算失败也不动盘', async () => {
    const a = await makeDir('沙发')
    const res = await renameAssetFolders([plan(a, '沙发')], { libraryDir: root })
    expect(res).toEqual({ renamed: [], failed: [], rolledBack: false })
    expect(await exists(a)).toBe(true)
  })
})

describe('renameAssetFolders · 冲突在动盘之前就拦下', () => {
  it('批内两条改成同一个名字 → 整批拒绝，两个目录都保持原名', async () => {
    const a = await makeDir('沙发')
    const b = await makeDir('桌子')
    const res = await renameAssetFolders([plan(a, '同名'), plan(b, '同名')], {
      libraryDir: root
    })

    expect(res.renamed).toEqual([])
    expect(res.rolledBack).toBe(false)
    // 只报「后来者」：先受理的那条本身合法，报它失败会误导用户
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].id).toBe('桌子')
    expect(res.failed[0].reason).toContain('重名')
    // 磁盘零改动
    expect(await exists(a)).toBe(true)
    expect(await exists(b)).toBe(true)
    expect(await exists(path.join(root, '同名'))).toBe(false)
  })

  it('目标已被另一个（不在本批的）目录占用 → 拒绝，不覆盖', async () => {
    const a = await makeDir('沙发')
    const occupied = await makeDir('已占用')

    const res = await renameAssetFolders([plan(a, '已占用')], { libraryDir: root })

    expect(res.renamed).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].reason).toContain('已存在同名目录')
    await expect(fs.readFile(path.join(occupied, 'a.txt'), 'utf-8')).resolves.toBe(
      'content of 已占用'
    )
    expect(await exists(a)).toBe(true)
  })

  it('新名字带路径分隔符 → 拒绝（防"改名变搬家"）', async () => {
    const a = await makeDir('沙发')
    const res = await renameAssetFolders([plan(a, '../跑出去')], { libraryDir: root })
    expect(res.renamed).toEqual([])
    expect(res.failed[0].reason).toContain('路径分隔符')
    expect(await exists(a)).toBe(true)
  })

  it('源目录在库外 → 拒绝', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-outside-'))
    await fs.mkdir(path.join(outside, '野目录'), { recursive: true })
    try {
      const res = await renameAssetFolders([plan(path.join(outside, '野目录'), '新名')], {
        libraryDir: root
      })
      expect(res.renamed).toEqual([])
      expect(res.failed[0].reason).toContain('不在库目录内')
      expect(await exists(path.join(outside, '野目录'))).toBe(true)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('Windows 保留名 → 拒绝', async () => {
    const a = await makeDir('沙发')
    const res = await renameAssetFolders([plan(a, 'CON')], { libraryDir: root })
    expect(res.renamed).toEqual([])
    expect(res.failed[0].reason).toContain('保留名')
    expect(await exists(a)).toBe(true)
  })

  it('源目录已被外部删除 → 拒绝并给出可读原因', async () => {
    const ghost = path.join(root, '不存在')
    const res = await renameAssetFolders([plan(ghost, '新名')], { libraryDir: root })
    expect(res.renamed).toEqual([])
    expect(res.failed[0].reason).toContain('源目录不存在')
  })
})

describe('renameAssetFolders · 失败回滚', () => {
  it('第 2 条失败 → 第 1 条被反向改回，磁盘零改动，rolledBack=true', async () => {
    const a = await makeDir('沙发')
    const b = await makeDir('桌子')

    let calls = 0
    const move = async (src: string, dest: string): Promise<void> => {
      calls += 1
      // 第 2 次调用 = 第二个资产改名 → 模拟"文件被占用"
      if (calls === 2) throw new Error('EBUSY: 文件被占用')
      await fs.rename(src, dest)
    }

    const res = await renameAssetFolders(
      [plan(a, '001-沙发'), plan(b, '002-桌子')],
      { libraryDir: root, move }
    )

    expect(res.rolledBack).toBe(true)
    expect(res.renamed).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].id).toBe('桌子')
    expect(res.failed[0].reason).toContain('改名失败')

    // 第一条已被反向改回：两个原目录都在，新目录都不在
    expect(await exists(a)).toBe(true)
    expect(await exists(b)).toBe(true)
    expect(await exists(path.join(root, '001-沙发'))).toBe(false)
    expect(await exists(path.join(root, '002-桌子'))).toBe(false)
    await expect(fs.readFile(path.join(a, 'a.txt'), 'utf-8')).resolves.toBe('content of 沙发')
  })

  it('第 1 条就失败 → 没有需要回滚的东西，仍返回 rolledBack=true（磁盘未动）', async () => {
    const a = await makeDir('沙发')
    const move = async (): Promise<void> => {
      throw new Error('EPERM')
    }
    const res = await renameAssetFolders([plan(a, '001-沙发')], { libraryDir: root, move })
    expect(res.renamed).toEqual([])
    expect(res.rolledBack).toBe(true)
    expect(await exists(a)).toBe(true)
  })

  it('回滚本身失败 → 如实上报，并把"磁盘仍是新名字"的条目放进 renamed（供索引对齐）', async () => {
    const a = await makeDir('沙发')
    const b = await makeDir('桌子')

    let calls = 0
    const move = async (src: string, dest: string): Promise<void> => {
      calls += 1
      // 1: a → 001-沙发（成功）
      // 2: b → 002-桌子（执行失败，触发回滚）
      // 3: 001-沙发 → 沙发（回滚也失败）
      if (calls === 1) {
        await fs.rename(src, dest)
        return
      }
      if (calls === 2) throw new Error('EBUSY: 文件被占用')
      throw new Error('EROLLBACK: 磁盘锁死')
    }

    const res = await renameAssetFolders([plan(a, '001-沙发'), plan(b, '002-桌子')], {
      libraryDir: root,
      move
    })

    expect(res.rolledBack).toBe(false)
    // 第一条没能回滚 → 仍在磁盘上叫新名字 → 必须出现在 renamed 里（渲染层据此写库）
    expect(res.renamed.map((r) => r.name)).toEqual(['001-沙发'])
    expect(await exists(path.join(root, '001-沙发'))).toBe(true)
    expect(await exists(path.join(root, '沙发'))).toBe(false)
    expect(res.failed.some((f) => f.reason.includes('回滚失败'))).toBe(true)
  })
})

describe('renameAssetFolders · 入参防御', () => {
  it('空计划 → 什么都没发生', async () => {
    const res = await renameAssetFolders([], { libraryDir: root })
    expect(res).toEqual({ renamed: [], failed: [], rolledBack: false })
  })

  it('缺字段 / 空名字 → 记失败，不动盘', async () => {
    const a = await makeDir('沙发')
    const res = await renameAssetFolders(
      [{ id: '', folder: a, to: '' }, { id: 'x', folder: '', to: '新名' }],
      { libraryDir: root }
    )
    expect(res.renamed).toEqual([])
    expect(res.failed).toHaveLength(2)
    expect(await exists(a)).toBe(true)
  })

  it('同一资产在一批里出现两次 → 拒绝（第二条），不动盘', async () => {
    const a = await makeDir('沙发')
    const res = await renameAssetFolders([plan(a, '001-沙发', 'id1'), plan(a, '002-沙发', 'id2')], {
      libraryDir: root
    })
    expect(res.renamed).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].id).toBe('id2')
    expect(await exists(a)).toBe(true)
  })
})
