/**
 * HDR / EXR 单文件直导（0.6.5，任务 A）单测。
 *
 * 覆盖用户真实场景：把 `21.古月视觉HDR-偏移 V：-0.01平铺：2.hdr` 这种文件
 * 直接拖进应用 —— 必须落 `HDRI/未分类/未分类/<名字>`、`kind='hdri'`、
 * 文件名里的全景参数进 `note`、且**不做封面**（.hdr 不能当图片解码）。
 *
 * ⚠️ 与 `importerSingleImage.test.ts` 的分工：那边锁死「图片 → 材质」链路，
 * 这边只锁「HDR → HDRI」，两条链路共用 `importMediaOne`（同一个实现，不同 kind）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import { panoramaNoteFromName } from '../src/shared/hdrExts'
import type { ImportEvent } from '../src/shared/types'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-hdr-import-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 假 HDR 字节：importer 不解析内容（解码只发生在预览时），任意字节即可 */
const FAKE_HDR = Buffer.alloc(2048, 0x11)

function makeDeps(libraryDir: string): {
  deps: ImportDeps
  events: ImportEvent[]
  thumbs: Array<{ id: string; coverAbs: string | null }>
} {
  const events: ImportEvent[] = []
  const thumbs: Array<{ id: string; coverAbs: string | null }> = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep', // 源文件保留（用户原图不动）
    defaultSource: '本机',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async (id, coverAbs) => {
      thumbs.push({ id, coverAbs })
      return null
    },
    emit: (ev) => events.push(ev)
  }
  return { deps, events, thumbs }
}

describe('importPaths — HDR 单文件直导', () => {
  it('hdr → kind=hdri、落 HDRI/未分类/未分类、note 带全景参数、不做封面', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const name = '21.古月视觉HDR-偏移 V：-0.01平铺：2.hdr'
    const src = path.join(root, name)
    await fs.writeFile(src, FAKE_HDR)

    const { deps, events, thumbs } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a = assets[0]!
    expect(a.kind).toBe('hdri')
    // 落盘大类目录名走 KIND_FOLDER.hdri = 'HDRI'；hdri 没有一级词表 → 双哨兵
    expect(a.relFolder).toBe('HDRI/未分类/未分类/21.古月视觉HDR-偏移 V：-0.01平铺：2')
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.files).toEqual([
      { rel: name, name, ext: 'hdr', size: FAKE_HDR.length, kind: 'hdri' }
    ])
    // 全景参数进 note（不结构化、不参与筛选）
    expect(a.note).toBe(panoramaNoteFromName(name))
    expect(a.note).toBe('全景参数：偏移V -0.01 / 平铺 2')
    // 不做封面 / 不做缩略图：.hdr 不是图片解码器能吃的格式，UI 走 IconHdr 占位
    expect(a.cover).toBeUndefined()
    expect(a.coverSource).toBe('placeholder')
    expect(a.thumbStatus).toBe('none')
    expect(thumbs).toEqual([{ id: a.id, coverAbs: null }])

    // 事件流与图片路径一致
    expect(events.map((e) => e.status)).toEqual(['extracting', 'organizing', 'done'])
    expect(events[0]!.message).toBe('正在读取 HDR…')

    // 源文件按 archiveDisposal='keep' 原地保留；库内有一份拷贝
    await expect(fs.stat(src)).resolves.toBeTruthy()
    const copied = await fs.readFile(path.join(a.folder, name))
    expect(copied.length).toBe(FAKE_HDR.length)
  })

  it('exr 同样入 HDRI 大类（预览解码器只吃 RGBE，但入库不拦）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'Displacement_4K.exr')
    await fs.writeFile(src, FAKE_HDR)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(1)
    expect(assets[0]!.kind).toBe('hdri')
    expect(assets[0]!.relFolder).toBe('HDRI/未分类/未分类/Displacement_4K')
    // 名字里没有全景参数 → note 保持空（不留一个空壳前缀）
    expect(assets[0]!.note).toBe('')
  })

  it('同名 HDR 二次导入 → 目录加序号（与其它大类同规则）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const first = path.join(root, 'a', 'Pano.hdr')
    const second = path.join(root, 'b', 'Pano.hdr')
    await fs.mkdir(path.dirname(first), { recursive: true })
    await fs.mkdir(path.dirname(second), { recursive: true })
    await fs.writeFile(first, FAKE_HDR)
    await fs.writeFile(second, FAKE_HDR)

    const { deps } = makeDeps(lib)
    const one = await importPaths([first], deps)
    const two = await importPaths([second], deps)
    expect(one[0]!.relFolder).toBe('HDRI/未分类/未分类/Pano')
    expect(two[0]!.relFolder).toBe('HDRI/未分类/未分类/Pano-2')
    // 重复检测键用改名前的名字（与其它大类同口径）
    expect(two[0]!.dedupeKey).toBe(one[0]!.dedupeKey)
  })
})
