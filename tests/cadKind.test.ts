/**
 * 「CAD 图纸」大类（2026-10-29，`AssetKind` 新增 `'cad'`）的契约守卫。
 *
 * 为什么需要这个文件：`dwg` / `dxf` 从 `'model'` 迁到 `'cad'` 之后，**编译器只看得住
 * 穷尽表**（`Record<AssetKind, …>` 少一行就红）。下面这些看不见的约定只能靠测试钉住：
 *
 * ① `EXT_KIND` 的迁移边界（dwg/dxf 走、模型扩展名一个都不许动）；
 * ② 落盘目录 `CAD/` 与显示名「CAD图纸」解耦（拼路径只准用 `KIND_FOLDER`）；
 * ③ `KIND_PRIORITY` 里 `cad` **低于** `model` —— 同一个包里同时有 skp 与 dwg 时
 *    必须判 `model`（模型是主内容、图纸是附件）；
 * ④ 筛选能力表 `cad` 三项全 false（图纸不是位图、没有风格轴、不是 3D 模型格式）；
 * ⑤ **源码守卫**：`importer.ts` 的单文件分支必须**同时**接受 `'model'` 与 `'cad'`。
 *    这条防的是"以后有人把它改回去"——改回去之后单个 `.dwg` 拖进来会掉进
 *    `extractArchive` 并被判「不是压缩包」，是**一拖就中**的真机 bug，而且不会有
 *    任何编译错误或其它测试变红。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EXT_KIND,
  KIND_FILTER_CAPS,
  KIND_FOLDER,
  KIND_LABEL,
  KIND_NAV_ORDER,
  kindFolder,
  kindFromFolderName,
  primaryKind
} from '../src/shared/classify'
import { isLevel1AllowedForKind } from '../src/shared/taxonomy'
import { classifyAssetName } from '../src/shared/classifyAsset'
import type { AssetFile } from '../src/shared/types'

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

function f(rel: string, ext: string): Pick<AssetFile, 'rel' | 'kind'> {
  return { rel, kind: EXT_KIND[ext] ?? 'other' }
}

describe('cad 大类 · 扩展名映射（EXT_KIND）', () => {
  it('dwg / dxf → cad', () => {
    expect(EXT_KIND.dwg).toBe('cad')
    expect(EXT_KIND.dxf).toBe('cad')
  })

  it('防误伤：模型扩展名一个都不能跟着变', () => {
    for (const ext of ['skp', 'skb', 'max', '3ds', '3dm', 'fbx', 'obj', 'rvt', 'stl', 'glb']) {
      expect(EXT_KIND[ext], `${ext} 不该被 CAD 改动波及`).toBe('model')
    }
  })
})

describe('cad 大类 · 显示名 / 落盘目录', () => {
  it('KIND_LABEL.cad = 「CAD图纸」（仅 UI 显示）', () => {
    expect(KIND_LABEL.cad).toBe('CAD图纸')
  })

  it('KIND_FOLDER.cad = 「CAD」（第 6 个顶层目录，落盘唯一来源）', () => {
    expect(KIND_FOLDER.cad).toBe('CAD')
    expect(kindFolder('cad')).toBe('CAD')
    // 显示名与目录名必须解耦：拿显示名去拼路径是本仓库的头号禁忌
    expect(KIND_LABEL.cad).not.toBe(KIND_FOLDER.cad)
  })

  it('反查：目录名 CAD → cad；小写变体由 rescan 兜底（不在 classify 里放宽）', () => {
    expect(kindFromFolderName('CAD')).toBe('cad')
    // `kindFromFolderName` 是**精确匹配**（`KIND_FOLDER.cad === 'CAD'` 是应用自己写的唯一形态）；
    // 小写 `cad/` 由 `main/rescan.ts` 的 `fallbackKindOf` 单独兜一条（见下面源码守卫），
    // 刻意不把整个反查改成大小写不敏感 —— 那会顺带改变 `hdri` / `HDRI` 等既有目录名语义。
    expect(kindFromFolderName('cad')).toBe('other')
  })
})

describe('cad 大类 · primaryKind 优先级', () => {
  it('只有 dwg → cad', () => {
    expect(primaryKind([f('平面图.dwg', 'dwg')])).toBe('cad')
  })

  it('只有 dxf → cad', () => {
    expect(primaryKind([f('立面.dxf', 'dxf')])).toBe('cad')
  })

  it('★同时有 skp 与 dwg → model（模型是主内容，图纸是附件）', () => {
    expect(primaryKind([f('椅.skp', 'skp'), f('椅三视图.dwg', 'dwg')])).toBe('model')
    // 文件顺序反过来也一样（优先级不依赖 readdir 顺序）
    expect(primaryKind([f('椅三视图.dwg', 'dwg'), f('椅.skp', 'skp')])).toBe('model')
  })

  it('dwg + 预览图 → cad（图纸压过贴图）', () => {
    expect(primaryKind([f('平面图.dwg', 'dwg'), f('预览.jpg', 'jpg')])).toBe('cad')
  })
})

describe('cad 大类 · 侧栏导航序', () => {
  it('KIND_NAV_ORDER 含 cad，且紧跟 model（在 materialGroup 之前）', () => {
    const order = [...KIND_NAV_ORDER]
    const iModel = order.indexOf('model')
    const iCad = order.indexOf('cad')
    const iGroup = order.indexOf('materialGroup')
    expect(iCad).toBeGreaterThan(iModel)
    expect(iCad).toBeLessThan(iGroup)
  })

  it('cad 只出现一次（不是一个分组成员）', () => {
    expect(KIND_NAV_ORDER.filter((k) => k === 'cad')).toHaveLength(1)
  })
})

describe('cad 大类 · 筛选能力表', () => {
  it('分辨率 / 风格 / 模型格式 三项全 false', () => {
    expect(KIND_FILTER_CAPS.cad).toEqual({
      resolution: false,
      style: false,
      modelFormat: false
    })
  })
})

describe('cad 大类 · 分类词表（本批不建词表，必须安全回落）', () => {
  it('CHANNEL_LEVEL1 没有 cad 册 → isLevel1AllowedForKind 恒 false（不抛错）', () => {
    expect(isLevel1AllowedForKind('cad', '家装')).toBe(false)
    expect(isLevel1AllowedForKind('cad', '石材')).toBe(false)
    expect(isLevel1AllowedForKind('cad', '')).toBe(false)
  })

  it('classifyAssetName(kind=cad) 走双哨兵，不崩、不返回怪值', () => {
    // 即便资产名命中了别的频道的一级（「家具沙发」→ 模型频道），CAD 也不该吞下它
    for (const name of ['生态主题餐厅工装平面图', '家具沙发', '大理石瓷砖', '']) {
      const out = classifyAssetName(name, ['平面图.dwg'], 'cad')
      expect(out).toEqual({ category1: '未分类', category2: '未分类' })
    }
  })
})

describe('cad 大类 · 源码守卫（防回退）', () => {
  it('★importer.ts 单文件分支同时接受 model 与 cad', () => {
    const src = read('src/main/importer.ts')
    const lines = src.split('\n')
    const idx = lines.findIndex((l) => l.includes('return importModelOne('))
    expect(idx, '找不到 importModelOne 的单文件分支').toBeGreaterThan(-1)
    // 往回看 8 行（含判据与注释），判据行必须两个都认
    const window = lines.slice(Math.max(0, idx - 8), idx + 1).join('\n')
    expect(window).toContain(`'model'`)
    expect(window).toContain(`'cad'`)
    // 并且必须是"同一个条件里用 || 连接"，不是两个互不相干的字符串
    expect(window).toMatch(/===\s*'model'[\s\S]{0,80}===\s*'cad'/)
  })

  it('importModelOne 内部不得把 kind 写死成 model（否则 dwg 会落进 模型/）', () => {
    const src = read('src/main/importer.ts')
    const start = src.indexOf('async function importModelOne(')
    expect(start).toBeGreaterThan(-1)
    // 取函数体前 40 行（kind / folderName 的推导都在开头）
    const head = src.slice(start, start + 4000)
    expect(head).toContain('kindOfExt(ext)')
    expect(head).not.toMatch(/const kind:\s*AssetKind\s*=\s*'model'/)
  })

  it('rescan 兜底认小写 cad 目录（fallbackKindOf 里那一行是手写的，编译器看不住）', () => {
    const src = read('src/main/rescan.ts')
    expect(src).toMatch(/kindFolderName\.toLowerCase\(\)\s*===\s*'cad'/)
    // 兜底不能退化成"整个反查都大小写不敏感"（会改变 hdri/HDRI 等既有语义）
    expect(src).not.toMatch(/kindFromFolderName\s*\(\s*kindFolderName\.toLowerCase/)
  })
})
