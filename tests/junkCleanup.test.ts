/**
 * 「杂质**物理删除**」专项（2026-10-30 用户要求：进库后把推广件从磁盘上删掉）。
 *
 * 背景事实：`classify.isJunkFileName` 只让杂质**不进 files 索引**，磁盘上一个都不会少。
 * 用户拖进 CAD 包后仍能在资源管理器里看到那三件推广文件，明确要求"进库后自动删掉"。
 *
 * 本文件钉两件事：
 * ① **窄规则安全网**（`shared/junkCleanup.ts`）：`设计说明.dwg` / `下载的模型.skp` /
 *    材质包 `.json` 这类**真素材必须不删**——删除不可逆，误判就是丢用户的图纸；
 * ② 端到端：真 zip 导入后，磁盘上那三件真的不存在、事件带 `cleanedJunk`；反向
 *    （包里全是真素材）一个文件都不少且**不出现** `cleanedJunk` 字段。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import { STRONG_PROMO_NAME_RE, shouldDeleteJunkFile } from '../src/shared/junkCleanup'
import type { ArchiveDisposal, Asset, ImportEvent } from '../src/shared/types'
import { buildZip, skpContent, zipDir, zipEntry } from './fixtures/gbkZip'

/** 用户截图里的真实三件推广文件（原样文件名，一个字符都不改） */
const SHOT_JPG = '微信扫码 看案例找灵感下素材必用知末.jpg'
const SHOT_HTML = '知末CAD图纸-精选行业施工图，追踪最新图纸.html'
const SHOT_TXT = '知末网说明.txt'

/** 真实 dwg 样本（探针产出的原始下载件）；缺席时退回合成字节，保证本用例恒可跑 */
const REAL_DWG = 'E:/workbuddy/2026-10-13-01-03-46/cad-probe/out/餐厅平面设计方案.dwg'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-junkclean-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ① 纯函数层：窄规则判定 ────────────────────────────────────────────────

describe('shouldDeleteJunkFile · 用户截图那三件必须删', () => {
  it('微信扫码 看案例找灵感下素材必用知末.jpg（扩展名是素材，但命中强推广词）', () => {
    expect(shouldDeleteJunkFile(SHOT_JPG)).toBe(true)
  })

  it('知末CAD图纸-精选行业施工图，追踪最新图纸.html（非素材扩展名 + 强推广词）', () => {
    expect(shouldDeleteJunkFile(SHOT_HTML)).toBe(true)
  })

  it('知末网说明.txt（非素材扩展名）', () => {
    expect(shouldDeleteJunkFile(SHOT_TXT)).toBe(true)
  })
})

/**
 * 核心安全网：这些是**真素材**，删了不可逆。
 * 每一条独立 `it`——将来谁把规则改宽，红的那条会直接指出是哪种素材被误杀。
 */
describe('shouldDeleteJunkFile · 真素材必须保留（误删 = 丢用户图纸）', () => {
  it('设计说明.dwg（「说明」是标准图纸名的一部分，实测会被 isJunkFileName 误判）', () => {
    expect(shouldDeleteJunkFile('设计说明.dwg')).toBe(false)
  })

  it('施工说明.dwg', () => {
    expect(shouldDeleteJunkFile('施工说明.dwg')).toBe(false)
  })

  it('图例说明.dwg', () => {
    expect(shouldDeleteJunkFile('图例说明.dwg')).toBe(false)
  })

  it('下载的模型.skp（「下载」是泛词，用户自己存下来的模型）', () => {
    expect(shouldDeleteJunkFile('下载的模型.skp')).toBe(false)
  })

  it('推广方案.pdf（「推广」是泛词：广告类设计素材本来就这么命名）', () => {
    expect(shouldDeleteJunkFile('推广方案.pdf')).toBe(false)
  })

  it('餐厅平面设计方案.dwg', () => {
    expect(shouldDeleteJunkFile('餐厅平面设计方案.dwg')).toBe(false)
  })

  it('餐厅平面设计方案.preview.png（程序生成的预览图同样是资产内文件）', () => {
    expect(shouldDeleteJunkFile('餐厅平面设计方案.preview.png')).toBe(false)
  })

  it('Poliigon_Material.json（PBR 元数据，importer 要读它填 materialMeta）', () => {
    expect(shouldDeleteJunkFile('Poliigon_Material.json')).toBe(false)
  })
})

describe('shouldDeleteJunkFile · 扩展名规则', () => {
  it.each(['.html', '.htm', '.txt', '.url', '.lnk'])(
    '非素材扩展名 %s 一律删（名字正常也删，如 readme）',
    (ext) => {
      expect(shouldDeleteJunkFile(`readme${ext}`)).toBe(true)
      expect(shouldDeleteJunkFile(`随便什么名字${ext}`)).toBe(true)
    }
  )

  it('.json 不删（PBR 材质包元数据，删了丢材质名与标签）', () => {
    expect(shouldDeleteJunkFile('vh1sbjl_2K.json')).toBe(false)
    expect(shouldDeleteJunkFile('readme.json')).toBe(false)
  })
})

describe('shouldDeleteJunkFile · 强推广词即使素材扩展名也删', () => {
  it('二维码.png', () => {
    expect(shouldDeleteJunkFile('二维码.png')).toBe(true)
  })

  it('qrcode_pattern.jpg（正则带 i，大小写不敏感）', () => {
    expect(shouldDeleteJunkFile('qrcode_pattern.jpg')).toBe(true)
  })

  it('扫码关注我们.jpg / 扫码领取素材.skp', () => {
    expect(shouldDeleteJunkFile('扫码关注我们.jpg')).toBe(true)
    expect(shouldDeleteJunkFile('扫码领取素材.skp')).toBe(true)
  })
})

describe('shouldDeleteJunkFile · 大小写与空值安全', () => {
  it('QRCODE.PNG 大小写不敏感 → 删', () => {
    expect(shouldDeleteJunkFile('QRCODE.PNG')).toBe(true)
  })

  it('SCAN.jpg 不在表里 → 保留（不误伤正常英文名）', () => {
    expect(shouldDeleteJunkFile('SCAN.jpg')).toBe(false)
  })

  it('空串 / undefined / null → false（不抛）', () => {
    expect(shouldDeleteJunkFile('')).toBe(false)
    expect(shouldDeleteJunkFile(undefined)).toBe(false)
    expect(shouldDeleteJunkFile(null)).toBe(false)
    // @ts-expect-error 防御：运行时传进非字符串也不该抛
    expect(shouldDeleteJunkFile(123)).toBe(false)
  })
})

describe('STRONG_PROMO_NAME_RE · 常量本身的口径', () => {
  it('导出给测试引用，且**不含**「说明 / 下载 / 推广 / 必用」这类泛词', () => {
    expect(STRONG_PROMO_NAME_RE.test('微信扫码')).toBe(true)
    // 泛词逐个确认不命中（这些都在 isJunkFileName 里，但绝不能进删除规则）
    expect(STRONG_PROMO_NAME_RE.test('设计说明')).toBe(false)
    expect(STRONG_PROMO_NAME_RE.test('下载的模型')).toBe(false)
    expect(STRONG_PROMO_NAME_RE.test('推广方案')).toBe(false)
    expect(STRONG_PROMO_NAME_RE.test('必用的节点')).toBe(false)
  })
})

// ── ② 端到端层：真 zip 导入后磁盘删除 ──────────────────────────────────────

function makeDeps(libraryDir: string): { deps: ImportDeps; events: ImportEvent[] } {
  const events: ImportEvent[] = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null, // JS 回退（adm-zip）：STORED 包不需要真 7z
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

/** 真 dwg 字节；样本缺席时用合成字节（预览提取失败只是没有封面，不影响本用例主题） */
async function dwgBytes(): Promise<Buffer> {
  if (existsSync(REAL_DWG)) return fs.readFile(REAL_DWG)
  return Buffer.from('AC1015-fake-dwg-for-junk-cleanup', 'ascii')
}

describe('端到端 · CAD 包：真 dwg + 截图那三件垃圾', () => {
  it('导入后磁盘上那三件不存在，asset.files 只有 dwg(+可能生成的 preview)，事件带 cleanedJunk=3', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src = path.join(root, '餐厅平面设计方案ID_1152305168.zip')
    await fs.writeFile(
      src,
      buildZip([
        zipDir('餐厅平面设计方案'),
        zipEntry('餐厅平面设计方案/餐厅平面设计方案.dwg', await dwgBytes()),
        zipEntry(`餐厅平面设计方案/${SHOT_JPG}`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
        zipEntry(`餐厅平面设计方案/${SHOT_HTML}`, '<html>推广</html>'),
        zipEntry(`餐厅平面设计方案/${SHOT_TXT}`, '推广说明')
      ])
    )

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    expect(events.filter((e) => e.status === 'error')).toEqual([])
    expect(assets.length).toBe(1)
    const a: Asset = assets[0]!

    // files 只有真内容（dwg 本体 + 可能由 dwg 内嵌图生成的 preview）
    expect(a.files.some((f) => f.rel === '餐厅平面设计方案.dwg')).toBe(true)
    expect(a.files.some((f) => f.rel.includes('微信扫码'))).toBe(false)
    expect(a.files.some((f) => f.rel.includes('知末'))).toBe(false)

    // ⚠️ 本用例主题：磁盘上真的被删掉了（此前只做到"不进索引"）
    for (const junk of [SHOT_JPG, SHOT_HTML, SHOT_TXT]) {
      await expect(fs.access(path.join(a.folder, junk))).rejects.toThrow(/ENOENT/)
    }
    // 真内容还在
    await expect(fs.access(path.join(a.folder, '餐厅平面设计方案.dwg'))).resolves.toBeUndefined()

    // 事件里报出删除数量（UI 提示「已清理 N 个杂质文件」）
    const done = events.find((e) => e.status === 'done' && e.asset?.id === a.id)
    expect(done).toBeTruthy()
    expect(done!.cleanedJunk?.slice().sort()).toEqual([SHOT_HTML, SHOT_JPG, SHOT_TXT].sort())
  })
})

describe('端到端 · 反向：包里全是真素材', () => {
  it('一个文件都不少，且事件**没有** cleanedJunk 字段（不是空数组）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })

    const src = path.join(root, '木纹材质包.zip')
    const jpg = (tag: string): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.from(tag)])
    await fs.writeFile(
      src,
      buildZip([
        zipDir('木纹材质包'),
        zipEntry('木纹材质包/桌子.skp', skpContent()),
        zipEntry('木纹材质包/vh1sbjl_2K_Albedo.jpg', jpg('albedo')),
        zipEntry('木纹材质包/vh1sbjl_2K_Normal.jpg', jpg('normal')),
        zipEntry('木纹材质包/vh1sbjl_2K_Roughness.jpg', jpg('rough')),
        zipEntry('木纹材质包/vh1sbjl_2K.json', JSON.stringify({ material: 'Wood' })),
        zipEntry('木纹材质包/设计说明.dwg', await dwgBytes())
      ])
    )

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)
    expect(events.filter((e) => e.status === 'error')).toEqual([])

    const a: Asset = assets[0]!
    // 每个源文件都还在磁盘上（含「设计说明.dwg」——泛词但真素材）
    for (const rel of ['桌子.skp', 'vh1sbjl_2K_Albedo.jpg', 'vh1sbjl_2K_Normal.jpg', 'vh1sbjl_2K_Roughness.jpg', 'vh1sbjl_2K.json', '设计说明.dwg']) {
      await expect(fs.access(path.join(a.folder, rel))).resolves.toBeUndefined()
    }

    const done = events.find((e) => e.status === 'done' && e.asset?.id === a.id)
    expect(done).toBeTruthy()
    // 关键：字段**缺席**（`'cleanedJunk' in done === false`），不是 `[]`
    expect('cleanedJunk' in done!).toBe(false)
  })
})
