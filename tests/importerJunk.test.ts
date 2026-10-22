import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONCURRENCY,
  importPaths,
  type ImportDeps
} from '../src/main/importer'
import { extractArchive } from '../src/main/extractor'
import { buildZip, skpContent, skpContentWithPreview, TINY_PNG, zipDir, zipEntry } from './fixtures/gbkZip'
import type { Asset, ArchiveDisposal, ImportEvent } from '../src/shared/types'

/**
 * 2026-10 装机反馈专项：知末典型包的杂质剔除 + contentRoot 递归下钻 + 材质包零误杀。
 * Fixture 全部按用户提供的真实样本结构手工拼装。
 */

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-junk-'))
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
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    archiveDisposal: 'keep' as ArchiveDisposal,
    defaultSource: '知末网',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async () => null,
    disposeArchive: async () => {},
    emit: (ev) => events.push(ev)
  }
  return { deps, events }
}

/** 用户样本 A：知末模型包，**双层嵌套** + 3 个推广杂质（rar 后缀 zip 内容） */
function zhimoModelArchive(withEmbeddedPreview: boolean): Buffer {
  const skp = withEmbeddedPreview
    ? skpContentWithPreview(TINY_PNG, { versionText: 'SketchUp Model {8.0.1}' })
    : skpContent('SketchUp Model {8.0.1}')
  return buildZip([
    zipDir('attachment_17328465716023114'),
    zipDir('attachment_17328465716023114/中古侘寂屏风_木屏风_藤编屏风_可折叠屏风'),
    zipEntry(
      'attachment_17328465716023114/中古侘寂屏风_木屏风_藤编屏风_可折叠屏风/znzmo-1180221079-1.skp',
      skp
    ),
    zipEntry('attachment_17328465716023114/微信扫码 看案例找灵感下载素材必用知末.jpg', Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])),
    zipEntry('attachment_17328465716023114/知末SU-掌握行业前沿，探索设计趋势.html', '<html>推广</html>'),
    zipEntry('attachment_17328465716023114/知末网说明.txt', '推广说明')
  ])
}

describe('样本 A：知末模型包（双层嵌套 + 杂质）', () => {
  it('contentRoot 递归下钻 → 资产名=内层文件夹名，files 只有 skp，封面不是二维码', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '中古侘寂屏风_木屏风_藤编屏风_可折叠屏风ID_1180221079.rar')
    await fs.writeFile(src, zhimoModelArchive(false))

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(events.filter((e) => e.status === 'error')).toEqual([])
    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    // 资产名 = 最终下钻层的文件夹名（不再是 attachment_1732…）
    expect(a.name).toBe('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')
    // ⚠️ 【v1.0.10】本用例主题是**递归下钻 + 杂质剔除**，分类只是顺带产物。
    // 故这里**不再硬编码分类段**（否则词表一改，垃圾处理测试就被牵着红一次），
    // 改成：① 显式记录本次改进（三级归并后样本 A 自动落对，不再是双哨兵）；
    //        ② 用 `a.folder` 做路径断言（路径由实现自己拼）。
    expect(a.category1).toBe('硬装构件') // v1.0.10：三级归并后样本 A 自动落对，不再是双哨兵
    expect(a.category2).toBe('屏风隔断')
    expect(a.relFolder).toBe(`模型/${a.category1}/${a.category2}/${a.name}`)
    expect(a.folder).toBe(path.join(lib, '模型', a.category1!, a.category2!, a.name))
    // junk 全部出局：files 只有模型本体
    expect(a.files.map((f) => f.rel)).toEqual(['znzmo-1180221079-1.skp'])
    // 封面不是二维码（junk 不进 files，pickCover 也选不到它）
    expect(a.cover).toBeUndefined()
    expect(a.coverSource).toBe('placeholder')
    // 体积不含 junk
    expect(a.size).toBe(a.files[0]!.size)
    // 磁盘上杂质文件确实没被搬进库（staging 已清）—— 路径走 `a.folder`，不手写分类段
    await expect(fs.stat(path.join(a.folder, '知末网说明.txt'))).rejects.toThrow()
  })

  it('rar 后缀但内容是 zip：无 7z 时按内容嗅探走 adm-zip（不按后缀拒绝）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'sample.rar')
    await fs.writeFile(src, zhimoModelArchive(false))
    const dest = path.join(root, 'out')

    const res = await extractArchive(src, dest, {
      sevenZipPath: null,
      codepage: 'auto',
      timeoutMs: 60_000,
      maxBytesForJsFallback: 200 * 1024 * 1024
    })
    expect(res.engine).toBe('admzip')
    // 解出来的目录结构就是 zip 里的双层嵌套（junk 也在，杂质过滤发生在导入层而非解压层）
    await expect(fs.stat(path.join(dest, 'attachment_17328465716023114', '知末网说明.txt'))).resolves.toBeTruthy()
  })

  it('rar 后缀 + 非 zip 内容（真 rar 魔数）+ 无 7z → 仍然 no7z（内容嗅探不误放行）', async () => {
    const root = await tmpDir()
    const src = path.join(root, 'real.rar')
    await fs.writeFile(src, Buffer.concat([Buffer.from('Rar!\u001a\u0007\u0001\u0000'), Buffer.alloc(64, 1)]))
    const err = await extractArchive(src, path.join(root, 'o'), {
      sevenZipPath: null,
      codepage: 'auto',
      timeoutMs: 60_000,
      maxBytesForJsFallback: 200 * 1024 * 1024
    }).catch((e) => e)
    expect((err as { kind?: string }).kind).toBe('no7z')
  })
})

describe('样本 A + SKP 内嵌预览（T04 接线集成）', () => {
  it('skp 内嵌预览图优先于包内预览图 → 封面=提取出的 preview 文件', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'with-preview.rar')
    await fs.writeFile(src, zhimoModelArchive(true))

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.name).toBe('中古侘寂屏风_木屏风_藤编屏风_可折叠屏风')
    expect(a.cover).toBe('znzmo-1180221079-1.preview.png')
    expect(a.coverSource).toBe('embedded')
    // 预览图落盘成真实文件并进 files（与 rescan 的 walkFiles 视图一致）
    expect(a.files.map((f) => f.rel).sort()).toEqual(['znzmo-1180221079-1.preview.png', 'znzmo-1180221079-1.skp'])
    // 提取出的字节与 fixture 内嵌图一致
    const written = await fs.readFile(path.join(a.folder, 'znzmo-1180221079-1.preview.png'))
    expect(written.equals(TINY_PNG)).toBe(true)
  })
})

/** 用户样本 B：Crystal 材质包，扁平 8 文件，零嵌套零杂质 */
function materialPackArchive(): Buffer {
  const jpg = (tag: string) => Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(tag)])
  return buildZip([
    zipEntry('vh1sbjl_2K_Albedo.jpg', jpg('albedo')),
    zipEntry('vh1sbjl_2K_AO.jpg', jpg('ao')),
    zipEntry('vh1sbjl_2K_Normal.jpg', jpg('normal')),
    zipEntry('vh1sbjl_2K_Roughness.jpg', jpg('rough')),
    zipEntry('vh1sbjl_2K_Displacement.jpg', jpg('disp')),
    zipEntry('vh1sbjl_2K_Displacement.exr', jpg('disp-exr')),
    // AmbientCG 元数据 json（实测结构：semanticTags.name + 各类语义数组）
    zipEntry(
      'vh1sbjl_2K.json',
      JSON.stringify({
        semanticTags: {
          name: 'Square Floor Tiles',
          contains: ['Tiles', 'Floor Tiles'],
          theme: ['Interior'],
          descriptive: ['Square', 'Ceramic'],
          color: ['White', 'Beige'],
          country: ['Italy'],
          region: ['Europe']
        }
      })
    ),
    zipEntry('Brick_Rough_vh1sbjl_surface_Preview.png', jpg('preview'))
  ])
}

describe('样本 B：Crystal 材质包（扁平 8 文件）', () => {
  it('8 个文件全进 files、零 junk、封面=Preview.png', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'Brick_Rough_vh1sbjl_2K_surface_ms.zip')
    await fs.writeFile(src, materialPackArchive())

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(events.filter((e) => e.status === 'error')).toEqual([])
    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    // 2026-10 材质包裁定：含 .exr displacement，但同前缀 PBR 槽位齐全
    // （Albedo+Normal+Roughness）→ material 大类，不再落 HDRI
    expect(a.kind).toBe('material')
    // 材质包文件一个不少（含 .json 元数据）。排序按 UTF-16 码元：_AO < _Albedo（O<l）
    expect(a.files.map((f) => f.rel).sort()).toEqual([
      'Brick_Rough_vh1sbjl_surface_Preview.png',
      'vh1sbjl_2K.json',
      'vh1sbjl_2K_AO.jpg',
      'vh1sbjl_2K_Albedo.jpg',
      'vh1sbjl_2K_Displacement.exr',
      'vh1sbjl_2K_Displacement.jpg',
      'vh1sbjl_2K_Normal.jpg',
      'vh1sbjl_2K_Roughness.jpg'
    ])
    // 封面命中 named 级（名字含 Preview）
    expect(a.cover).toBe('Brick_Rough_vh1sbjl_surface_Preview.png')
    expect(a.coverSource).toBe('named')
    // 没有 skp → 不触发内嵌预览提取，资产名走 zip 名
    expect(a.name).toBe('Brick_Rough_vh1sbjl_2K_surface_ms')
  })

  it('AmbientCG 元数据 json 解析入库（materialMeta）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'Brick_Rough_vh1sbjl_2K_surface_ms.zip')
    await fs.writeFile(src, materialPackArchive())

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(1)
    // name + contains/theme/descriptive/country/region 合并（color 暂不入库）
    expect(assets[0]!.materialMeta).toEqual({
      name: 'Square Floor Tiles',
      tags: ['Tiles', 'Floor Tiles', 'Interior', 'Square', 'Ceramic', 'Italy', 'Europe']
    })
  })

  it('json 不是 AmbientCG 结构 → materialMeta 缺席但不阻断导入', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'odd-json.zip')
    await fs.writeFile(
      src,
      buildZip([
        zipEntry('vh1sbjl_2K_Albedo.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])),
        zipEntry('vh1sbjl_2K_Normal.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])),
        zipEntry('vh1sbjl_2K_Roughness.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 3])),
        zipEntry('vh1sbjl_2K.json', '{"material":"Brick Rough","no-semantic-tags":true}')
      ])
    )

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(events.filter((e) => e.status === 'error')).toEqual([])
    expect(assets.length).toBe(1)
    expect(assets[0]!.kind).toBe('material') // PBR 槽位判定不受 json 影响
    expect(assets[0]!.materialMeta).toBeUndefined()
  })
})

describe('杂质在模型文件夹**内部**时同样剔除', () => {
  it('内层文件夹里的 说明.txt / 推广.html 不进 files、不计入体积', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, 'inner-junk.zip')
    await fs.writeFile(
      src,
      buildZip([
        zipDir('包名'),
        zipEntry('包名/模型.skp', skpContent()),
        zipEntry('包名/知末网说明.txt', 'junk'),
        zipEntry('包名/微信扫码.jpg', Buffer.from([0xff, 0xd8, 0xff])),
        zipEntry('包名/贴图/木纹.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      ])
    )

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(1)
    expect(assets[0]!.files.map((f) => f.rel).sort()).toEqual(['模型.skp', '贴图/木纹.jpg'])
  })
})

/**
 * 【v1.0.10】kind ↔ 一级频道一致性闸门（导入侧端到端）。
 *
 * 洞的事实：`autoClassify` 不知道 kind，若命中结果的一级属于**别的频道**
 * （`硬装构件` 是模型频道的一级），贴图资产会落进 `材质/硬装构件/…`。
 * 闸门加在 `importer.ts` 两处 `autoClassify()` 之后：
 * 一级不属于本 kind 的频道 → **丢弃整个 hit**，落双哨兵（宁可不分，不可分错）。
 */
describe('v1.0.10 · kind ↔ 一级频道闸门（导入端到端）', () => {
  /** 假图片字节（单图直导不做 magic 校验） */
  const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])

  it('贴图「屏风贴图.jpg」命中模型频道一级 → 被闸门丢弃，落 材质/未分类/未分类', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '屏风贴图.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('texture')
    // 纯匹配器会命中 硬装构件/屏风隔断，但那是模型频道的一级 → 闸门拒绝
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.relFolder).toBe('材质/未分类/未分类/屏风贴图')
    // 物理目录同样不带错位分类段
    expect(a.folder).toBe(path.join(lib, '材质', '未分类', '未分类', '屏风贴图'))
  })

  it('反例·贴图「大理石瓷砖.jpg」是贴图频道一级 → 闸门放行，仍落 瓷砖/大理石瓷砖', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '大理石瓷砖.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    const a: Asset = assets[0]!
    expect(a.category1).toBe('瓷砖')
    expect(a.category2).toBe('大理石瓷砖')
    expect(a.relFolder).toBe('材质/瓷砖/大理石瓷砖/大理石瓷砖')
  })
})

/**
 * 【v1.0.12】容器口径闸门 + **一级回退**（导入端到端，真实文件名）。
 *
 * 两条事实变化：
 * ① 闸门对 `texture`/`material` 改查并集 `MERGED_MATERIAL_LEVEL1`（33 项）——
 *    `木纹`/`砖材`/`瓷砖` 这类"只在贴图册里"的一级，对**材质**资产终于放行
 *    （UI 下拉本来就能选，此前自动分类永远选不中 → 用户实测 10 个材质资产全落未分类）；
 * ② 二级命中被闸门拒绝时**回退成一级** —— `北欧挂画` 的二级 `软装陈设/挂画` 被拒后
 *    保住一级 `挂画`，落 `材质/挂画/未分类`，而不是退回双未分类（**宁可不分二级，
 *    也要保住正确的一级**）。真跨频道（`屏风贴图` → 硬装构件）回退也失败 → 仍双哨兵。
 */
describe('v1.0.12 · 容器口径闸门 + 一级回退（导入端到端）', () => {
  const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7])

  /** 最小 PBR 材质包（3 个同前缀槽位 → `detectMaterialPack` 判 material） */
  const pbrPackZip = (): Buffer =>
    buildZip([
      zipEntry('vh1sbjl_2K_Albedo.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])),
      zipEntry('vh1sbjl_2K_Normal.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])),
      zipEntry('vh1sbjl_2K_Roughness.jpg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 3]))
    ])

  it('真实样本·材质「无堺黑色木纹ID_1151853396」→ 材质/木纹/未分类（并集闸门放行）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '无堺黑色木纹ID_1151853396.zip')
    await fs.writeFile(src, pbrPackZip())

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('material')
    expect(a.category1).toBe('木纹')
    expect(a.category2).toBe('未分类') // 材质容器无二级词表 → 哨兵待指派
    expect(a.relFolder).toBe('材质/木纹/未分类/无堺黑色木纹ID_1151853396')
    expect(a.folder).toBe(path.join(lib, '材质', '木纹', '未分类', '无堺黑色木纹ID_1151853396'))
    // 磁盘上真的建出来了
    await expect(fs.stat(a.folder)).resolves.toBeTruthy()
  })

  it('材质「现代仿古砖ID_1100000001」→ 材质/砖材/仿古砖（ID 剥离 + 并集闸门）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '现代仿古砖ID_1100000001.zip')
    await fs.writeFile(src, pbrPackZip())

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('material')
    expect(a.category1).toBe('砖材')
    expect(a.category2).toBe('仿古砖')
    expect(a.relFolder).toBe('材质/砖材/仿古砖/现代仿古砖ID_1100000001')
  })

  it('贴图「北欧挂画.jpg」→ 一级回退生效，落 材质/挂画/未分类（不是双未分类）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '北欧挂画.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    const a: Asset = assets[0]!
    expect(a.kind).toBe('texture')
    // 全量匹配是 软装陈设/挂画（二级压过一级），`软装陈设` 不是材质容器一级 → 拒绝
    // → 回退拿到一级 `挂画`（贴图册一级，属于材质容器）→ 落 材质/挂画/未分类
    expect(a.category1).toBe('挂画')
    expect(a.category2).toBe('未分类')
    expect(a.relFolder).toBe('材质/挂画/未分类/北欧挂画')
  })

  it('反例·真跨频道「屏风贴图.jpg」一级回退也失败 → 仍双未分类（闸门原始目的不丢）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '屏风贴图.jpg')
    await fs.writeFile(src, FAKE_JPG)

    const { deps } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    const a: Asset = assets[0]!
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.relFolder).toBe('材质/未分类/未分类/屏风贴图')
  })
})
