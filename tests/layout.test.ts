import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyLayoutMigration,
  moveAssetCategory,
  planLayoutMigration
} from '../src/main/layout'
import type { Asset } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-layout-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

function asset(
  id: string,
  kind: Asset['kind'],
  relFolder: string,
  folder: string,
  name: string
): Pick<Asset, 'id' | 'folder' | 'relFolder' | 'kind' | 'name'> {
  return { id, kind, relFolder, folder, name }
}

describe('planLayoutMigration —— DB 驱动，零启发式（03 §4.4 / 06 §10.2）', () => {
  it('2 段遗留 → 4 段双哨兵；3 段草稿同理', () => {
    const lib = 'E:\\ModVault\\Library'
    const plan = planLayoutMigration(
      [
        asset('a', 'model', '模型/现代衣柜', 'E:\\ModVault\\Library\\模型\\现代衣柜', '现代衣柜'),
        asset('b', 'model', '模型/家具/吊灯', 'E:\\ModVault\\Library\\模型\\家具\\吊灯', '吊灯'),
        asset('c', 'texture', '贴图/木纹 01', 'E:\\x\\贴图\\木纹 01', '木纹 01')
      ],
      lib
    )
    expect(plan.skipped).toEqual([])
    expect(plan.moves.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(plan.moves[0]!.relFolder).toBe('模型/未分类/未分类/现代衣柜')
    expect(plan.moves[0]!.to).toBe(
      path.join(lib, '模型', '未分类', '未分类', '现代衣柜')
    )
    expect(plan.moves[2]!.relFolder).toBe('材质/未分类/未分类/木纹 01')
  })

  it('已是 4 段的记录 skip（跑两次计划相同 = 幂等）', () => {
    const lib = 'E:\\ModVault\\Library'
    const canonical = asset(
      'ok',
      'model',
      '模型/未分类/未分类/现代衣柜',
      path.join(lib, '模型', '未分类', '未分类', '现代衣柜'),
      '现代衣柜'
    )
    const first = planLayoutMigration([canonical], lib)
    expect(first.moves).toEqual([])
    expect(first.skipped).toEqual(['ok'])
    const second = planLayoutMigration([canonical], lib)
    expect(second).toEqual(first)
  })

  it('folder / name 缺失的记录 skip（无 IO，无法核实磁盘）', () => {
    const plan = planLayoutMigration(
      [asset('bad', 'model', '模型/老衣柜', '', '老衣柜'), asset('bad2', 'model', '模型/老衣柜2', 'X:\\y', '')],
      'E:\\ModVault\\Library'
    )
    expect(plan.moves).toEqual([])
    expect(plan.skipped).toEqual(['bad', 'bad2'])
  })
})

describe('applyLayoutMigration —— 批量搬动真实目录', () => {
  it('2 段 → 4 段：目录真搬到 <大类>/未分类/未分类/<名>', async () => {
    const lib = await tmpDir()
    const src = path.join(lib, '模型', '现代衣柜')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, '预览图.jpg'), 'x')

    const plan = planLayoutMigration(
      [asset('a', 'model', '模型/现代衣柜', src, '现代衣柜')],
      lib
    )
    const res = await applyLayoutMigration(plan.moves)
    // T08：ok 回传**最终落盘值**的 LayoutMove（含 to 与 relFolder）
    expect(res.ok).toEqual([
      {
        id: 'a',
        from: src,
        to: path.join(lib, '模型', '未分类', '未分类', '现代衣柜'),
        relFolder: '模型/未分类/未分类/现代衣柜'
      }
    ])
    expect(res.failed).toEqual([])
    await expect(fs.stat(path.join(lib, '模型', '未分类', '未分类', '现代衣柜', '预览图.jpg'))).resolves.toBeTruthy()
    await expect(fs.stat(src)).rejects.toThrow() // 原位置已不在
  })

  it('源目录不存在 → 计入 failed，不吞错、不影响其余', async () => {
    const lib = await tmpDir()
    const good = path.join(lib, '贴图', '木纹')
    await fs.mkdir(good, { recursive: true })
    await fs.writeFile(path.join(good, 'a.jpg'), 'x')

    const plan = planLayoutMigration(
      [
        asset('gone', 'model', '模型/不存在', path.join(lib, '模型', '不存在'), '不存在'),
        asset('good', 'texture', '贴图/木纹', good, '木纹')
      ],
      lib
    )
    const res = await applyLayoutMigration(plan.moves)
    expect(res.ok.map((m) => m.id)).toEqual(['good'])
    expect(res.failed.length).toBe(1)
    expect(res.failed[0]!.id).toBe('gone')
    expect(res.failed[0]!.reason).toContain('源目录不存在')
  })

  it('self-target：from === to → 幂等 no-op，计入 ok 且不抛错', async () => {
    const lib = await tmpDir()
    const same = path.join(lib, '模型', '未分类', '未分类', '已就位')
    await fs.mkdir(same, { recursive: true })
    await fs.writeFile(path.join(same, 'a.skp'), 'x')

    const res = await applyLayoutMigration([
      { id: 'noop', from: same, to: same, relFolder: '模型/未分类/未分类/已就位' }
    ])
    expect(res.ok).toEqual([
      { id: 'noop', from: same, to: same, relFolder: '模型/未分类/未分类/已就位' }
    ])
    expect(res.failed).toEqual([])
    await expect(fs.stat(path.join(same, 'a.skp'))).resolves.toBeTruthy()
  })

  it('目标已存在同名 → uniqueName 追加 -2，永不覆盖', async () => {
    const lib = await tmpDir()
    const src = path.join(lib, '模型', '沙发')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'a.skp'), 'new')

    // 目标位置已有一个同名目录（内容不同）
    const destExisting = path.join(lib, '模型', '未分类', '未分类', '沙发')
    await fs.mkdir(destExisting, { recursive: true })
    await fs.writeFile(path.join(destExisting, 'b.skp'), 'old')

    const plan = planLayoutMigration([asset('a', 'model', '模型/沙发', src, '沙发')], lib)
    const res = await applyLayoutMigration(plan.moves)
    expect(res.failed).toEqual([])
    // 旧内容原样保留，新内容落在 -2
    await expect(fs.stat(path.join(destExisting, 'b.skp'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(lib, '模型', '未分类', '未分类', '沙发-2', 'a.skp'))).resolves.toBeTruthy()
    // T08：ok[0] 回传**最终落盘值** —— to/relFolder 是追加序号后的，不是计划值
    expect(res.ok).toEqual([
      {
        id: 'a',
        from: src,
        to: path.join(lib, '模型', '未分类', '未分类', '沙发-2'),
        relFolder: '模型/未分类/未分类/沙发-2'
      }
    ])
  })
})

describe('moveAssetCategory —— assignCategory 的落盘动作（03 §5.1）', () => {
  it('移动到 <大类>/<一级>/<二级>/，返回新 folder 与 name', async () => {
    const lib = await tmpDir()
    const src = path.join(lib, '模型', '未分类', '未分类', '沙发')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'a.skp'), 'x')

    const parent = path.join(lib, '模型', '家具', '沙发')
    const res = await moveAssetCategory(src, parent)
    expect(res.renamed).toBe(false)
    expect(res.name).toBe('沙发')
    expect(res.folder).toBe(path.join(parent, '沙发'))
    await expect(fs.stat(path.join(parent, '沙发', 'a.skp'))).resolves.toBeTruthy()
  })

  it('目标已有同名 → 追加 -2 且 renamed=true，永不覆盖', async () => {
    const lib = await tmpDir()
    const src = path.join(lib, '模型', '未分类', '未分类', '沙发')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'new.skp'), 'new')

    const parent = path.join(lib, '模型', '家具', '沙发')
    // 目标位置已有一个名为「沙发」的资产目录（内容不同）
    const existing = path.join(parent, '沙发')
    await fs.mkdir(existing, { recursive: true })
    await fs.writeFile(path.join(existing, 'old.skp'), 'old')

    const res = await moveAssetCategory(src, parent)
    expect(res.renamed).toBe(true)
    expect(res.name).toBe('沙发-2')
    await expect(fs.stat(path.join(existing, 'old.skp'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(parent, '沙发-2', 'new.skp'))).resolves.toBeTruthy()
  })

  it('父目录不存在时自动建齐（一次 mkdir 两级）', async () => {
    const lib = await tmpDir()
    const src = path.join(lib, '模型', '未分类', '未分类', '吊灯')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'a.skp'), 'x')

    const parent = path.join(lib, '模型', '灯具', '吊灯')
    const res = await moveAssetCategory(src, parent)
    expect(res.folder).toBe(path.join(parent, '吊灯'))
    await expect(fs.stat(path.join(parent, '吊灯', 'a.skp'))).resolves.toBeTruthy()
  })

  // ── T08 self-target 守卫 ─────────────────────────────────────

  it('self-target：资产已在目标分类下 → no-op，不被误改名成「名字-2」', async () => {
    const lib = await tmpDir()
    // 资产已经位于 模型/家具/沙发/沙发（即 parentDir 下）
    const parent = path.join(lib, '模型', '家具', '沙发')
    const src = path.join(parent, '沙发')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'a.skp'), 'x')

    const res = await moveAssetCategory(src, parent)
    // 修复前：readdir(parent) 读到「沙发」→ uniqueName 误判重名 → 改名成 沙发-2
    expect(res).toEqual({ folder: src, name: '沙发', moved: false, renamed: false })
    // 磁盘上没有多出 沙发-2，原资产原位未动
    await expect(fs.stat(path.join(parent, '沙发', 'a.skp'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(parent, '沙发-2'))).rejects.toThrow()
  })

  it('self-target：重复指派同分类多次仍然幂等', async () => {
    const lib = await tmpDir()
    const parent = path.join(lib, '模型', '灯具', '吊灯')
    const src = path.join(parent, '某吊灯')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'a.skp'), 'x')

    for (let i = 0; i < 3; i++) {
      const res = await moveAssetCategory(src, parent)
      expect(res.moved).toBe(false)
      expect(res.folder).toBe(src)
    }
    await expect(fs.stat(path.join(parent, '某吊灯', 'a.skp'))).resolves.toBeTruthy()
    await expect(fs.readdir(parent)).resolves.toEqual(['某吊灯'])
  })

  it('源目录不存在 → 抛错（不吞，03 §5.2：失败原路返回）', async () => {
    const lib = await tmpDir()
    await expect(
      moveAssetCategory(path.join(lib, '模型', '不存在'), path.join(lib, '模型', '家具'))
    ).rejects.toThrow()
  })
})
