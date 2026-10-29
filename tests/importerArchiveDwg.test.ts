/**
 * 压包路径的 CAD 封面（M2 第二站）：zip 里装着的 `.dwg` 也要出内嵌预览。
 *
 * 为什么单文件路径不够：知末的 CAD 下载件**大量是 zip 里装 dwg**（原生压包，
 * 不是我们那套四段目录）。只改 `importModelOne` 的话，用户拖 zip 进来仍是灰图标。
 *
 * 这里用 `tests/fixtures/gbkZip.ts` 手工拼**真 zip**（STORED + GBK 文件名，知末/
 * WinRAR 的典型形态），内容塞**真实 dwg**（`cad-probe/out/餐厅平面设计方案.dwg`）——
 * 不造假字节：位图转换 + 封面接线这两段都用真实样本才算测到。
 *
 * 钉四条：
 * ① zip 内的 dwg → `coverSource='embedded'` + `<主名>.preview.png` 落盘 + 进 files；
 * ② 没有内嵌图的 dwg → 占位，不崩、不抛多余文件；
 * ③ skp+dwg 混合包：**skp 优先**（主类型是 model，封面必须跟主类型走，
 *    不能因为遍历顺序让 dwg 抢走封面）；
 * ④ 源码守卫：两支的存在顺序写死（`??` 链 skp 在前）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { Asset, ImportEvent } from '../src/shared/types'
import { buildZip, zipDir, zipEntry } from './fixtures/gbkZip'

/** 真实 dwg（只读；探针产出的原始下载件，AC1015 / 8 位调色板 DIB / 184×87） */
const REAL_DWG = 'E:/workbuddy/2026-10-13-01-03-46/cad-probe/out/餐厅平面设计方案.dwg'
const hasRealSample = existsSync(REAL_DWG)

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-archdwg-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  return {
    events,
    deps: {
      libraryDir,
      // JS 回退（adm-zip）：STORED 包不需要真 7z，跑得更快也更稳定
      sevenZipPath: null,
      archiveDisposal: 'delete',
      defaultSource: '本机',
      codepage: 'auto',
      timeoutMs: 60_000,
      maxBytesForJsFallback: 200 * 1024 * 1024,
      spaceSafetyFactor: 1.2,
      concurrency: DEFAULT_CONCURRENCY,
      emit: (ev) => events.push(ev)
    }
  }
}

/** 把一个 zip 放进 tmp 并导入，返回资产列表 */
async function importZip(lib: string, entries: Parameters<typeof buildZip>[0]): Promise<Asset[]> {
  const root = path.dirname(lib)
  const zipPath = path.join(root, `包-${Math.random().toString(36).slice(2, 8)}.zip`)
  await fs.writeFile(zipPath, buildZip(entries))
  const { deps } = makeDeps(lib)
  return importPaths([zipPath], deps)
}

describe('压包路径：zip 内的 .dwg 出内嵌预览（真实样本）', () => {
  it.skipIf(!hasRealSample)('包内一层中文目录 + 真 dwg → embedded + .preview.png 落盘 + 进 files', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const dwg = await fs.readFile(REAL_DWG)
    const assets = await importZip(lib, [
      zipDir('餐厅平面设计方案'),
      zipEntry('餐厅平面设计方案/餐厅平面设计方案.dwg', dwg)
    ])

    expect(assets.length).toBe(1)
    const a = assets[0]!
    expect(a.kind).toBe('cad')
    expect(a.coverSource).toBe('embedded')
    expect(a.cover?.endsWith('.preview.png')).toBe(true)
    // 与落盘文件同名（`<dwg 主名>.preview.png`），且 dfs 能 stat 到
    expect(a.cover).toBe('餐厅平面设计方案.preview.png')
    await expect(fs.stat(path.join(a.folder, a.cover!))).resolves.toBeTruthy()
    // ★ rescan 口径：预览图必须在 files 里，否则重扫后 pickCover 翻面
    expect(a.files.some((f) => f.rel === a.cover)).toBe(true)
    expect(a.files.find((f) => f.rel === a.cover)!.kind).toBe('texture')
    // 主类型不被这条 texture 抢走（pickPrimaryFile: model → cad → files[0]）
    expect(a.files.some((f) => f.ext === 'dwg' && f.kind === 'cad')).toBe(true)
  })

  it('包内是没有内嵌预览的假 dwg → placeholder，不崩', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const assets = await importZip(lib, [
      zipEntry('空图纸/空图纸.dwg', Buffer.from('AC1032-fake-no-thumbnail'))
    ])

    expect(assets.length).toBe(1)
    const a = assets[0]!
    expect(a.kind).toBe('cad')
    expect(a.coverSource).toBe('placeholder')
    expect(a.cover).toBeUndefined()
    expect(a.thumbStatus).toBe('none')
    // 不留下半个预览文件
    const inside = await fs.readdir(a.folder)
    expect(inside).toEqual(['空图纸.dwg'])
  })

  it.skipIf(!hasRealSample)('skp + dwg 混合包：skp 优先，dwg 的预览不抢封面', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const dwg = await fs.readFile(REAL_DWG)
    const assets = await importZip(lib, [
      // dwg 在 zip 里排前面：如果实现写成 `find(skp || dwg)` 就会让它抢到封面
      zipEntry('混合包/餐厅平面设计方案.dwg', dwg),
      zipEntry('混合包/中古侘寂屏风.skp', Buffer.from('fake-skp-bytes'))
    ])

    expect(assets.length).toBe(1)
    const a = assets[0]!
    // 主类型按 KIND_PRIORITY 判 model → 封面也必须跟主类型走
    expect(a.kind).toBe('model')
    expect(a.coverSource).toBe('placeholder')
    // 假 skp 解不出预览 → 不应该退而用 dwg 的预览图
    expect(a.files.some((f) => f.rel.endsWith('.preview.png'))).toBe(false)
  })
})

describe('源码守卫：压包路径的 master 顺序写死 skp → dwg', () => {
  it('`??` 链 skp 在前、dwg 在后，且两支都调了对应的提取函数', async () => {
    const src = await fs.readFile(new URL('../src/main/importer.ts', import.meta.url), 'utf-8')
    const start = src.indexOf('const master =')
    expect(start, '压包路径找不到 master').toBeGreaterThan(-1)
    const seg = src.slice(Math.max(0, start - 400), start + 500)
    const skpAt = seg.indexOf("f.ext === 'skp'")
    const dwgAt = seg.indexOf("f.ext === 'dwg'")
    expect(skpAt).toBeGreaterThan(-1)
    expect(dwgAt).toBeGreaterThan(skpAt)
    expect(seg).toContain('??')
    // 禁止合取写法（遍历顺序会决定谁抢封面）
    expect(seg).not.toMatch(/f\.ext === 'skp' \|\| f\.ext === 'dwg'/)
    expect(seg).toContain('writeSkpPreviewInto')
    expect(seg).toContain('writeDwgPreviewInto')
  })
})
