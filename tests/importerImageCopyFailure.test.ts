/**
 * 单图导入 · 复制失败路径（2026-10 缺陷修复的配套验收点 5）。
 *
 * 契约：**先复制成功，再处置源文件**。复制失败时必须满足三条：
 *   1. 该条导入标记为 error、不产出 Asset（`importPaths` 返回空数组）；
 *   2. 源文件必须完好（绝不允许「源没了、库里也没有」）；
 *   3. 库内不留半成品（`mkdir` 占位目录要被撤掉，不能剩一个空资产壳）。
 *
 * 为什么单独一个文件：用 `vi.mock('node:fs/promises')` 把 `copyFile` 打成 EACCES，
 * 模拟「目标目录不可写」。模块级 mock 会作用于整个测试文件，故与其他用例隔离。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  /** 只让「文件名含 -COPY-FAIL- 的源」复制失败，其余透传真实实现 */
  const copyFile = async (src: string, dest: string, mode?: number): Promise<void> => {
    if (String(src).includes('-COPY-FAIL-')) {
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, copyfile '${String(src)}' -> '${String(dest)}'`
      )
      err.code = 'EACCES'
      throw err
    }
    await actual.copyFile(src, dest, mode)
  }
  return { ...actual, copyFile, default: { ...actual, copyFile } }
})

// ⚠️ 必须在 vi.mock 之后 import（vi.mock 已提升，这里只是可读性排列）
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-image-copyfail-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9])

describe('importPaths — 单图导入复制失败（源文件必须幸存）', () => {
  it('copyFile 抛 EACCES → error 事件、无资产、源文件完好、库内无空壳', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'wood-COPY-FAIL-.png')
    await fs.writeFile(src, FAKE_JPG)

    const events: ImportEvent[] = []
    const deps: ImportDeps = {
      libraryDir: lib,
      sevenZipPath: null,
      // 'keep' 档下失败依旧不能动源文件；即便设成 delete，也轮不到处置（先复制）
      archiveDisposal: 'delete',
      defaultSource: '本机',
      codepage: 'auto',
      timeoutMs: 60_000,
      maxBytesForJsFallback: 200 * 1024 * 1024,
      spaceSafetyFactor: 1.2,
      concurrency: DEFAULT_CONCURRENCY,
      emit: (ev) => events.push(ev)
    }

    const assets = await importPaths([src], deps)
    expect(assets).toEqual([])

    // 1) 该条标记 error，且透出真实原因
    const err = events.find((e) => e.status === 'error')
    expect(err).toBeTruthy()
    expect(err!.message).toContain('EACCES')
    // 没有 done 事件（失败绝不误报成功）
    expect(events.some((e) => e.status === 'done')).toBe(false)

    // 2) 源文件还在，字节未变 —— 「源没了、库里也没有」被彻底排除
    await expect(fs.stat(src)).resolves.toBeTruthy()
    await expect(fs.readFile(src)).resolves.toEqual(FAKE_JPG)

    // 3) 库内无半成品：分类目录在（mkdir 已发生的既定行为），但其下没有任何空资产壳
    const cat2Dir = path.join(lib, '材质', '未分类', '未分类')
    await expect(fs.readdir(cat2Dir)).resolves.toEqual([])
    // 库根也不该多出 .staging 之类的东西（单图直导本来就无 staging 链路）
    await expect(fs.readdir(lib)).resolves.toEqual(['材质'])
  })
})
