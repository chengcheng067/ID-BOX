import { describe, expect, it } from 'vitest'
import { trashOne, trashPaths, type TrashStrategy } from '../src/main/trash'

/**
 * 回收站策略单测（2026-10 装机缺陷单的根因层）。
 *
 * 历史缺陷：主进程曾直接调 `trash` 包，打包态从 app.asar 内 spawn
 * windows-trash.exe 报 ENOENT → trash() 静默 reject → 删除链路 no-op。
 * 修复后策略 = shell.trashItem 优先 + trash 包兜底 + 失败上报。
 * 本文件用桩策略钉住这三条语义（真实 shell.trashItem 的打包态实测见交付报告）。
 */

function makeStrategy(behavior: {
  trashItem?: 'ok' | 'fail'
  packageTrash?: 'ok' | 'fail'
}): { strategy: TrashStrategy; calls: { trashItem: string[]; packageTrash: string[] } } {
  const calls = { trashItem: [] as string[], packageTrash: [] as string[] }
  const strategy: TrashStrategy = {
    trashItem: async (p) => {
      calls.trashItem.push(p)
      if (behavior.trashItem === 'fail') throw new Error('shell.trashItem 失败（模拟占用）')
    },
    packageTrash: async (p) => {
      calls.packageTrash.push(p)
      if (behavior.packageTrash === 'fail') throw new Error('spawn ENOENT（模拟打包态 trash 包缺陷）')
    }
  }
  return { strategy, calls }
}

describe('trashOne — 策略顺序（P0-16 修复核心）', () => {
  it('shell.trashItem 成功 → 不调兜底，直接resolve', async () => {
    const { strategy, calls } = makeStrategy({ trashItem: 'ok' })
    await expect(trashOne('E:\\lib\\模型\\某沙发', strategy)).resolves.toBeUndefined()
    expect(calls.trashItem).toEqual(['E:\\lib\\模型\\某沙发'])
    expect(calls.packageTrash).toEqual([])
  })

  it('shell.trashItem 失败 → 兜底 trash 包成功 → 不抛（打包态缺陷被兜底掩盖）', async () => {
    const { strategy, calls } = makeStrategy({ trashItem: 'fail', packageTrash: 'ok' })
    await expect(trashOne('E:\\lib\\资产', strategy)).resolves.toBeUndefined()
    expect(calls.trashItem).toEqual(['E:\\lib\\资产'])
    expect(calls.packageTrash).toEqual(['E:\\lib\\资产'])
  })

  it('两者都失败 → 抛出**trashItem 的错误**（主路径错误信息更具体）', async () => {
    const { strategy } = makeStrategy({ trashItem: 'fail', packageTrash: 'fail' })
    await expect(trashOne('E:\\lib\\资产', strategy)).rejects.toThrow('shell.trashItem 失败（模拟占用）')
  })

  it('回归：trash 包兜底不可用（打包态 ENOENT）但 trashItem 可用时，删除必须成功', async () => {
    // 这正是装机缺陷的场景：兜底路径烂掉，但只要首选路径工作，用户无感
    const { strategy, calls } = makeStrategy({ trashItem: 'ok', packageTrash: 'fail' })
    await expect(trashOne('E:\\lib\\模型\\中古侘寂屏风', strategy)).resolves.toBeUndefined()
    expect(calls.trashItem).toEqual(['E:\\lib\\模型\\中古侘寂屏风'])
    expect(calls.packageTrash).toEqual([]) // 首选成功，根本不走兜底
  })
})

describe('trashPaths — 批量失败上报', () => {
  it('全部成功 → failed 为空', async () => {
    const { strategy } = makeStrategy({ trashItem: 'ok' })
    await expect(trashPaths(['a', 'b', 'c'], strategy)).resolves.toEqual([])
  })

  it('部分失败 → 只把失败的放进 failed（成功的不返回）', async () => {
    const calls: string[] = []
    const strategy: TrashStrategy = {
      trashItem: async (p) => {
        calls.push(p)
        if (p === 'b') throw new Error('占用')
      },
      packageTrash: async () => {
        throw new Error('ENOENT')
      }
    }
    await expect(trashPaths(['a', 'b', 'c'], strategy)).resolves.toEqual(['b'])
    expect(calls).toEqual(['a', 'b', 'c']) // 单个失败不阻断其余
  })

  it('空数组 → 空结果（不调策略）', async () => {
    const { strategy, calls } = makeStrategy({ trashItem: 'ok' })
    await expect(trashPaths([], strategy)).resolves.toEqual([])
    expect(calls.trashItem).toEqual([])
  })
})
