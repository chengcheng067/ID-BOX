/**
 * 主进程兜底：`importPaths` 必须先剔除「本就在库目录内」的路径（v0.5.4 数据事故）。
 *
 * 事故链路：卡片拖出在窗口内松手 → `drop` 拿到库内文件路径 → `importPaths`
 * → staging → `uniqueName` 生成 `名字-2…-6` → 库里多出副本，且原文件可能被处置。
 * 渲染层已按库根过滤（`logic/libraryPath.ts`），这里是**第二道闸**：
 * 库内路径连 staging 都不该建。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { importPaths, isInsideLibraryDir, type ImportDeps } from '../src/main/importer'
import type { ImportEvent } from '../src/shared/types'

const LIB = path.join(os.tmpdir(), 'idbox-guard-lib')
const GUARD_MESSAGE = '这个文件已经在素材库里，已跳过（不会重复导入）'

function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep',
    defaultSource: '测试',
    codepage: 'auto',
    timeoutMs: 5_000,
    maxBytesForJsFallback: 1024 * 1024,
    spaceSafetyFactor: 1,
    concurrency: 2,
    emit: (ev) => events.push(ev)
  }
  return { deps, events }
}

describe('importer · isInsideLibraryDir（大小写不敏感）', () => {
  it('库根 / 子路径 / 尾部分隔符 / 大小写 / 正反斜杠都算库内', () => {
    const child = path.join(LIB, '模型', '未分类', '未分类', '资产A')
    expect(isInsideLibraryDir(LIB, LIB)).toBe(true)
    expect(isInsideLibraryDir(LIB, child)).toBe(true)
    expect(isInsideLibraryDir(LIB + path.sep, child)).toBe(true)
    expect(isInsideLibraryDir(LIB.toUpperCase(), child.toUpperCase())).toBe(true)
    expect(isInsideLibraryDir(LIB.replace(/\\/g, '/'), child.replace(/\\/g, '/'))).toBe(true)
  })

  it('同前缀不同目录不算库内（Library2 陷阱）', () => {
    expect(isInsideLibraryDir(LIB, `${LIB}2${path.sep}a.skp`)).toBe(false)
    expect(isInsideLibraryDir(LIB, `${LIB}-old${path.sep}a.skp`)).toBe(false)
  })
})

describe('importer · importPaths 库内过滤', () => {
  it('库内路径不进导入链路：零资产 + 一条明确的 error 事件', async () => {
    const { deps, events } = makeDeps(LIB)
    const inside = path.join(LIB, '模型', '未分类', '未分类', '资产A', '资产A.skp')

    const assets = await importPaths([inside], deps)

    expect(assets).toEqual([])
    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      item: inside,
      itemName: '资产A.skp',
      status: 'error',
      message: GUARD_MESSAGE
    })
    // 没有 extracting / organizing 等中间事件 —— 说明连 staging 都没建
    expect(events.some((e) => e.status === 'extracting')).toBe(false)
  })

  it('大小写 / 斜杠变体同样被拦截', async () => {
    const { deps, events } = makeDeps(LIB)
    const variant = `${LIB.toUpperCase().replace(/\\/g, '/')}/贴图/石材/a.jpg`

    const assets = await importPaths([variant], deps)

    expect(assets).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]!.message).toBe(GUARD_MESSAGE)
  })

  it('同前缀的 Library2 不会被误拦（证明守卫不是裸 startsWith）', async () => {
    const { deps, events } = makeDeps(LIB)
    // 路径不存在 → 进了 importOne 才会报 ENOENT；被误拦的话会报 GUARD_MESSAGE
    const sibling = `${LIB}2${path.sep}包.zip`

    const assets = await importPaths([sibling], deps)

    expect(assets).toEqual([])
    expect(events.length).toBe(1)
    expect(events[0]!.message).not.toBe(GUARD_MESSAGE)
    expect(events[0]!.status).toBe('error')
  })

  it('混合批次：库内的被跳过、库外的照常进入导入链路', async () => {
    const { deps, events } = makeDeps(LIB)
    const inside = path.join(LIB, '材质', '石材', '大理石', 'A', 'A.jpg')
    const outside = path.join(os.tmpdir(), 'idbox-guard-outside', 'missing.zip')

    await importPaths([inside, outside], deps)

    expect(events.filter((e) => e.message === GUARD_MESSAGE)).toHaveLength(1)
    const outsideEvents = events.filter((e) => e.item === outside)
    expect(outsideEvents.length).toBeGreaterThan(0)
    expect(outsideEvents.every((e) => e.message !== GUARD_MESSAGE)).toBe(true)
  })

  it('全部库内 → 直接返回，不产生任何导入事件（除跳过提示）', async () => {
    const { deps, events } = makeDeps(LIB)
    const list = [
      path.join(LIB, 'a.zip'),
      path.join(LIB, '模型', 'b.zip')
    ]

    const assets = await importPaths(list, deps)

    expect(assets).toEqual([])
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.message === GUARD_MESSAGE)).toBe(true)
  })
})

describe('importer · 事故复现：库内文件回灌不产生副本（真实磁盘）', () => {
  it('同一个库内文件连拖 6 次 → 库里仍然只有原来那一个资产目录（没有 -2…-6）', async () => {
    const lib = await fs.mkdtemp(path.join(os.tmpdir(), 'idbox-reimport-'))
    try {
      // 造一个"已在库里"的资产：<库>/模型/未分类/未分类/<名字>/<预览图>
      const assetName = '深色仿古砖ID_1172815578'
      const assetDir = path.join(lib, '模型', '未分类', '未分类', assetName)
      await fs.mkdir(assetDir, { recursive: true })
      const draggedFile = path.join(assetDir, '预览图.jpeg')
      await fs.writeFile(draggedFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

      const { deps, events } = makeDeps(lib)
      // 事故日志：10:35:40–10:35:53 连拖 6 次
      for (let i = 0; i < 6; i++) await importPaths([draggedFile], deps)

      // 关键断言：分类目录下没有多出 `<名字>-2 … -6`
      const siblings = await fs.readdir(path.join(lib, '模型', '未分类', '未分类'))
      expect(siblings).toEqual([assetName])

      // 6 次都只产生"已跳过"提示，没有任何 extracting/organizing/done
      expect(events).toHaveLength(6)
      expect(events.every((e) => e.status === 'error' && e.message === GUARD_MESSAGE)).toBe(true)

      // 原文件仍在原处、内容未被处置
      const still = await fs.readFile(draggedFile)
      expect(still.byteLength).toBe(4)
    } finally {
      await fs.rm(lib, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
