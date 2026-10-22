import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildZip, zipDir, zipEntry } from './fixtures/gbkZip'
import { extractArchive, listUncompressedBytes } from '../src/main/extractor'
import { walkFiles } from '../src/main/fsutil'
import type { AssetFile } from '../src/shared/types'

/**
 * 真机 7-Zip 回归（DEF-01，QA 第 1 轮打回的致命缺陷）
 *
 * **为什么 248 条单测全绿也测不出**：所有解压用例都在 `sevenZipPath: null` 下走 adm-zip 分支，
 * 7z 主路径零真实覆盖 —— 而装有 7-Zip 的目标机器上 `x -mcp=GBK` 报
 * "Can't open as archive"（`-mcp` 对解压不受支持），裸参数才对。
 *
 * 注入方式：环境变量 `MODVAULT_7Z` 指向 7z.exe。没有该变量时整组 `describe.skip`，
 * 不影响无 7z 环境的 CI / 其他开发者。
 *
 * QA（严过关）本机条件：`MODVAULT_7Z=C:\Program Files\7-Zip\7z.exe`（7-Zip 23.01 x64）
 */

const SEVEN_ZIP = process.env['MODVAULT_7Z'] ?? null

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-7z-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

const OPTS = (over: Partial<{ maxBytesForJsFallback: number }> = {}) => ({
  sevenZipPath: SEVEN_ZIP,
  codepage: 'auto' as const,
  timeoutMs: 60_000,
  maxBytesForJsFallback: over.maxBytesForJsFallback ?? 200 * 1024 * 1024
})

async function relsOf(dir: string): Promise<string[]> {
  const files: AssetFile[] = []
  await walkFiles(dir, dir, files)
  return files.map((f) => f.rel).sort()
}

describe.skipIf(!SEVEN_ZIP)(`真机 7-Zip 回归（MODVAULT_7Z=${SEVEN_ZIP ?? '未设置'}）`, () => {
  it('GBK zip：裸参数首选，中文路径零乱码（DEF-01 修复点）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(
      src,
      buildZip([
        zipDir('现代衣柜'),
        zipDir('现代衣柜/贴图'),
        zipEntry('现代衣柜/预览图.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
        zipEntry('现代衣柜/贴图/木纹 01.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])),
        zipEntry('现代衣柜/现代衣柜.txt', 'model placeholder')
      ])
    )
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, OPTS())

    // 裸参数走的是系统 ACP（中文系统 = 936），不是显式 -mcp=GBK
    expect(res.engine).toBe('7z')
    expect(res.mojibake).toBe(false)
    expect(res.codepage).toBe('acp')
    // JS 默认按 UTF-16 码元排序：现 U+73B0 < 贴 U+8D34 < 预 U+9884
    // `.txt` 已被 junk 规则滤除（T09，与 extractor.test.ts 同一规则）
    // 排序：现 U+73B0 < 贴 U+8D34 < 预 U+9884
    expect(await relsOf(dest)).toEqual([
      '现代衣柜/贴图/木纹 01.jpg',
      '现代衣柜/预览图.jpg'
    ])
  })

  it('.7z 格式：真实 7z 引擎可解（单测环境无 7z 时此路径零覆盖）', async () => {
    const root = await tmpDir()
    // 用真 7z 自压一个含中文条目的 .7z（fixture 无法手拼 7z 容器格式）
    const stageDir = path.join(root, 'stage', '材质包')
    await fs.mkdir(stageDir, { recursive: true })
    await fs.writeFile(path.join(stageDir, '贴图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    await fs.writeFile(path.join(stageDir, '说明.txt'), '7z container test')
    const src = path.join(root, '材质包.7z')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(SEVEN_ZIP!, ['a', '-y', src, path.join(root, 'stage', '材质包')], {
      windowsHide: true
    })
    await fs.rm(path.join(root, 'stage'), { recursive: true, force: true })

    const dest = path.join(root, 'out')
    const res = await extractArchive(src, dest, OPTS())

    expect(res.engine).toBe('7z')
    expect(res.mojibake).toBe(false)
    // `.txt` 已被 junk 规则滤除（T09）
    expect(await relsOf(dest)).toEqual(['材质包/贴图.png'])
  })

  it('空间预估：真机 `l -slt` 取精确值（P0-3 取值链）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'pack.zip')
    await fs.writeFile(
      src,
      buildZip([
        zipDir('现代衣柜'),
        zipEntry('现代衣柜/预览图.jpg', Buffer.alloc(1234)),
        zipEntry('现代衣柜/现代衣柜.txt', 'x'.repeat(5678))
      ])
    )
    const info = await listUncompressedBytes(src, {
      sevenZipPath: SEVEN_ZIP,
      maxBytesForJsFallback: 200 * 1024 * 1024
    })
    expect(info.exact).toBe(true)
    expect(info.bytes).toBe(6912) // 1234 + 5678
  })

  it('损坏的 zip → ExtractionError（不裸抛，错误可行动）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'broken.zip')
    await fs.writeFile(src, Buffer.from('PK\x03\x04garbage-garbage-garbage'))
    const err = await extractArchive(src, path.join(root, 'o'), OPTS()).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(typeof err.message).toBe('string')
    expect(err.message.length).toBeGreaterThan(0)
  })
})
