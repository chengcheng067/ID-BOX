/**
 * 库目录漂移体检（`renderer/logic/libraryDrift.ts`）—— DEF-19-3 的可见性判据。
 *
 * 重点钉住「窗口路径语义」：Windows 上大小写不敏感、`\`/`/` 混用、尾部多分隔符、
 * `..` 归一，且 **`Library` 与 `Library2` 不是父子关系**（只 `startsWith(root)`
 * 会把整库误判成"还在库内"，症状就是回填静默失败而界面一声不吭）。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  libraryDriftWarning,
  planLibraryDrift,
  resolutionDriftHint
} from '../src/renderer/logic/libraryDrift'
import type { Asset, AssetFile } from '../src/shared/types'

const ROOT = 'E:\\ModVault\\Library'

/** 一条资产文件（默认：贴图 jpg，已带尺寸 —— 需要"缺尺寸"时显式不传 size） */
function file(rel: string, ext: string, size?: { w?: number; h?: number }): AssetFile {
  return {
    rel,
    name: rel.split('/').pop() ?? rel,
    ext,
    size: 1024,
    kind: 'texture',
    ...(size?.w !== undefined ? { w: size.w } : {}),
    ...(size?.h !== undefined ? { h: size.h } : {})
  }
}

/** 一条活资产（默认 kind=texture = 分辨率有意义；需要别的视图时 patch） */
function asset(patch: Partial<Asset> & { folder: string }): Asset {
  const { folder, files, ...rest } = patch
  return {
    id: `id-${folder}`,
    name: '某资产',
    kind: 'texture',
    source: '手动导入',
    folder,
    relFolder: '材质/未分类/未分类/某资产',
    files: files ?? [],
    size: 1024,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...rest
  } as Asset
}

describe('planLibraryDrift — 路径比较', () => {
  it('库内的父子路径不算漂移', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\石材\\A' }), asset({ folder: ROOT })],
      ROOT
    )
    expect(drift).toEqual({ outsideCount: 0, stalledFileCount: 0 })
  })

  it('前缀陷阱：Library2 不是 Library 的子目录', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library2\\材质\\A' })],
      ROOT
    )
    expect(drift.outsideCount).toBe(1)
  })

  it('大小写不同不算漂移（Windows 语义）', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'e:\\modvault\\library\\材质\\A' })],
      ROOT
    )
    expect(drift.outsideCount).toBe(0)
  })

  it('反斜杠 / 正斜杠混用不算漂移', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:/ModVault/Library/材质/A' })],
      'E:/ModVault/Library'
    )
    expect(drift.outsideCount).toBe(0)

    // 两侧写法相反也必须一致
    const drift2 = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\A' })],
      'E:/ModVault/Library'
    )
    expect(drift2.outsideCount).toBe(0)
  })

  it('末尾多余分隔符不算漂移', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\A\\' })],
      'E:\\ModVault\\Library\\\\'
    )
    expect(drift.outsideCount).toBe(0)
  })

  it('`..` 归一后仍在库内不算漂移', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\石材\\..\\石材\\A' })],
      ROOT
    )
    expect(drift.outsideCount).toBe(0)
  })

  it('库目录自身带 `..`（指向同一根）也能正确判定', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\A' })],
      'E:\\ModVault\\Library\\sub\\..'
    )
    expect(drift.outsideCount).toBe(0)
  })

  it('`..` 归一后跑到库外要算漂移', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\..\\Library2\\A' })],
      ROOT
    )
    expect(drift.outsideCount).toBe(1)
  })

  it('整库指向旧根时全部算漂移（DEF-19-3 现场）', () => {
    const drift = planLibraryDrift(
      [
        asset({ folder: 'E:\\ModVault\\Library_old\\材质\\A' }),
        asset({ folder: 'D:\\备份\\ModVault\\Library\\材质\\B' }),
        asset({ folder: 'E:\\ModVault\\Library\\材质\\C' })
      ],
      ROOT
    )
    expect(drift.outsideCount).toBe(2)
  })
})

describe('planLibraryDrift — 计数口径', () => {
  it('软删资产不计入（回收站里的不该触发警告）', () => {
    const drift = planLibraryDrift(
      [
        asset({ folder: 'E:\\ModVault\\Library_old\\A', deletedAt: 1_700_000_000_100 }),
        asset({ folder: 'E:\\ModVault\\Library_old\\B', deletedAt: null as unknown as undefined })
      ],
      ROOT
    )
    // 第一条软删跳过；第二条 deletedAt 显式为 null = 未删 → 计入
    expect(drift.outsideCount).toBe(1)
  })

  it('libraryDir 为空串 / 纯空白 / 非字符串 → 全 0（设置未就绪不许误报）', () => {
    const assets = [asset({ folder: 'E:\\ModVault\\Library_old\\A' })]
    expect(planLibraryDrift(assets, '')).toEqual({ outsideCount: 0, stalledFileCount: 0 })
    expect(planLibraryDrift(assets, '   ')).toEqual({ outsideCount: 0, stalledFileCount: 0 })
    expect(planLibraryDrift(assets, undefined as unknown as string)).toEqual({
      outsideCount: 0,
      stalledFileCount: 0
    })
  })

  it('资产 folder 为空 / 非字符串 → 跳过，不制造假警告', () => {
    const drift = planLibraryDrift(
      [{ ...asset({ folder: '' }) }, { ...asset({ folder: 'E:\\x' }), folder: undefined as unknown as string }],
      ROOT
    )
    expect(drift.outsideCount).toBe(0)
  })

  it('stalledFileCount 只数真的缺尺寸的图片扩展名（.zip / .txt 不数）', () => {
    const drift = planLibraryDrift(
      [
        asset({
          folder: 'E:\\ModVault\\Library_old\\材质\\A',
          files: [
            file('贴图/a.jpg', 'jpg'), // 缺 w/h → 数
            file('贴图/b.jpg', 'jpg', { w: 1024, h: 1024 }), // 已有尺寸 → 不数
            file('贴图/c.hdr', 'hdr'), // HDR 在回填白名单里，缺尺寸 → 数
            file('贴图/d.webp', 'webp'), // 2026-10 起解析器认 webp → 缺尺寸也数
            file('贴图/e.bmp', 'bmp'), // 解析器不认 → 不数
            file('包/a.zip', 'zip'), // 非图片 → 不数
            file('说明.txt', 'txt') // 非图片 → 不数
          ]
        })
      ],
      ROOT
    )
    expect(drift.outsideCount).toBe(1)
    expect(drift.stalledFileCount).toBe(3)
  })

  it('库内的资产即使缺尺寸也不计入 stalledFileCount', () => {
    const drift = planLibraryDrift(
      [asset({ folder: 'E:\\ModVault\\Library\\材质\\A', files: [file('a.jpg', 'jpg')] })],
      ROOT
    )
    expect(drift).toEqual({ outsideCount: 0, stalledFileCount: 0 })
  })

  it('模型 / 其他视图的资产不计 stalledFileCount（那里没有分辨率筛选入口）', () => {
    const drift = planLibraryDrift(
      [
        asset({
          folder: 'E:\\ModVault\\Library_old\\模型\\A',
          kind: 'model',
          files: [file('a.jpg', 'jpg')]
        })
      ],
      ROOT
    )
    expect(drift.outsideCount).toBe(1)
    expect(drift.stalledFileCount).toBe(0)
  })

  it('纯函数：不改入参、重复调用结果一致', () => {
    const assets = [
      asset({
        folder: 'E:\\ModVault\\Library_old\\A',
        files: [file('a.jpg', 'jpg')]
      })
    ]
    const snapshot = JSON.stringify(assets)
    const first = planLibraryDrift(assets, ROOT)
    const second = planLibraryDrift(assets, ROOT)
    expect(first).toEqual(second)
    expect(JSON.stringify(assets)).toBe(snapshot)
  })
})

// ── 两个提示面：从"数据"到"该不该显示、显示哪句话"的全链路 ──────────────
//
// 场景 = DEF-19-3 现场：DB 里老资产的 folder 指向**旧根**，settings.libraryDir
// 已经指向**新根**。这里一路验到用户会看到的那句话，而不是只验计数。

const OLD_ROOT = 'E:\ModVault\Library_old'

describe('DEF-19-3 现场：库目录换过之后，提示真的会出现', () => {
  /** 一条来自旧根的贴图资产：只有一个 jpg，且没有 w/h（= 该探但探不到） */
  const driftedAsset = asset({
    id: 'old-1',
    folder: `${OLD_ROOT}\材质\石材\A`,
    files: [file('贴图/a.jpg', 'jpg')]
  })

  it('planLibraryDrift：旧根 vs 新根 → 1 条资产漂移、1 个文件缺尺寸', () => {
    const drift = planLibraryDrift([driftedAsset], ROOT)
    expect(drift).toEqual({ outsideCount: 1, stalledFileCount: 1 })
  })

  it('设置页警示条：主句带数字、副句给可行动入口', () => {
    const drift = planLibraryDrift([driftedAsset], ROOT)
    const warning = libraryDriftWarning(drift)
    expect(warning).not.toBeNull()
    expect(warning?.title).toBe('有 1 个资产的索引路径不在当前库目录内')
    // 副句必须说清"后果 + 怎么办"，且指向的是**只读**检查，不是一键重建
    expect(warning?.body).toContain('分辨率')
    expect(warning?.body).toContain('筛不到')
    expect(warning?.body).toContain('检查索引与磁盘')
    expect(warning?.body).not.toContain('重建索引并删除')
  })

  it('设置页警示条：outsideCount === 0 时返回 null（零视觉噪音）', () => {
    expect(libraryDriftWarning({ outsideCount: 0, stalledFileCount: 0 })).toBeNull()
    expect(libraryDriftWarning(null)).toBeNull()
  })

  it('分辨率浮层提示：选了档位 + 可见结果为空 + 有漂移 → 出现', () => {
    const drift = planLibraryDrift([driftedAsset], ROOT)
    const hint = resolutionDriftHint(drift, {
      minResolution: '4k',
      visibleCount: 0,
      inTrash: false
    })
    expect(hint).toBe('有 1 个资产的尺寸没能采集，可能就藏在这里面')
  })

  it('分辨率浮层提示：三种不该出现的场景都返回 null', () => {
    const drift = { outsideCount: 3, stalledFileCount: 2 }
    // ① 「不限」档：列表空是别的原因，不能归咎于尺寸
    expect(resolutionDriftHint(drift, { minResolution: null, visibleCount: 0, inTrash: false })).toBeNull()
    // ② 看见有结果：说明筛得到，不需要解释
    expect(resolutionDriftHint(drift, { minResolution: '4k', visibleCount: 7, inTrash: false })).toBeNull()
    // ③ 回收站：空是正常的
    expect(resolutionDriftHint(drift, { minResolution: '4k', visibleCount: 0, inTrash: true })).toBeNull()
    // ④ 没有漂移：什么都不说
    expect(
      resolutionDriftHint({ outsideCount: 0, stalledFileCount: 0 }, {
        minResolution: '4k',
        visibleCount: 0,
        inTrash: false
      })
    ).toBeNull()
  })
})

describe('接线守卫：两个提示面必须走同一个纯函数，不许各写一套文案', () => {
  const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

  it('SettingsDialog 渲染 libraryDriftWarning() 的结果（不缺分支、不硬编码文案）', () => {
    const src = read('src/renderer/components/SettingsDialog.tsx')
    expect(src).toContain('libraryDriftWarning(')
    expect(src).toContain('driftWarning.title')
    expect(src).toContain('driftWarning.body')
    // 文案只在纯函数里，组件里再写一份就会与单测漂移
    expect(src).not.toContain('个资产的索引路径不在当前库目录内')
  })

  it('App 分辨率浮层渲染 resolutionDriftHint() 的结果（不缺分支、不硬编码文案）', () => {
    const src = read('src/renderer/App.tsx')
    expect(src).toContain('resolutionDriftHint(')
    expect(src).toContain('{resolutionHint}')
    expect(src).not.toContain('个资产的尺寸没能采集')
  })
})
