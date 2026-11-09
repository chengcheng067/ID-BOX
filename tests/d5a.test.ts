/**
 * 「D5 Render 资产包」大类（V1.0，`AssetKind` 新增 `'d5a'`）的契约守卫。
 *
 * 依据：`docs/48-V1.0拍板台账 §1/§5`（用户 2026-11-09 拍板）+ `docs/46 §1.3/§1.4`。
 * 一句话口径：**`.d5a` 整包存档、不解包，单文件直导入库，无封面时走紫色占位。**
 *
 * 为什么需要这个文件：加一个 kind，编译器只看得住**穷尽表**（`Record<AssetKind, …>`）；
 * 下面这些看不见的约定全靠测试钉住 ——
 *
 * ① `EXT_KIND.d5a` 映射（且**没有**污染任何模型 / 图片 / HDR 扩展名）；
 * ② 落盘目录 `D5A/` 与显示名解耦，四段路径拼得对；
 * ③ **不解包**：`.d5a` 的内容其实是标准 ZIP，包里 4 个条目一个都不许落地；
 * ④ **无封面**（`isCoverless`）：`cover=undefined` / `coverSource='placeholder'` /
 *    `thumbStatus='none'` / `ensureThumb` 拿到的 `coverAbs` 必须是 `null`
 *    （`main/thumb.ts:58` 首行 `if (!id || !coverAbs) return null` ⇒ 不会去解码 ZIP）；
 * ⑤ `dedupeKey = 'd5a:<资产名>'`，与 `model:<同名>` / `texture:<同名>` 不撞；
 * ⑥ 词表不建册 ⇒ 恒双「未分类」；
 * ⑦ **源码守卫**：`extractor.ts` 的解压白名单仍只有 3 个值、`importer.ts` 的 `.d5a`
 *    分流必须早于 `extractArchive` 调用点（这两条改回去都不会有编译错误，只会真机炸）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EXT_KIND,
  KIND_FILTER_CAPS,
  KIND_FOLDER,
  KIND_GROUP_MEMBERS,
  KIND_LABEL,
  KIND_NAV_ORDER,
  kindFolder,
  kindsOfFilter,
  kindFromFolderName,
  kindOfExt,
  isKindFolderName,
  pickCover,
  pickPrimaryFile,
  primaryKind
} from '../src/shared/classify'
import { classifyAssetName } from '../src/shared/classifyAsset'
import { dedupeKeyOf } from '../src/shared/naming'
import { HOME_FOLDER_KEYS } from '../src/renderer/logic/homeKinds'
import { DEFAULT_FILTERS, applyFilters } from '../src/renderer/logic/filters'
import { getModelFormat, MODEL_FORMAT_OPTIONS } from '../src/shared/modelFormat'
import { extractArchive, ExtractionError } from '../src/main/extractor'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import { rescanLibrary } from '../src/main/rescan'
import type { Asset, AssetFile, ImportEvent } from '../src/shared/types'

const read = (rel: string): string => fss.readFileSync(path.join(process.cwd(), rel), 'utf8')

/** 页面上真正要显示/落盘的那个显示名 */
const D5_LABEL = 'D5A'
/** 落盘顶层目录名 */
const D5_FOLDER = 'D5A'

// ── 夹具 ────────────────────────────────────────────────────────────────

/**
 * 造一个「内容是真 ZIP、后缀是 `.d5a`」的样本（与用户实测样本同构：
 * `R1 §3:220-230` 记录包内是 `1.d5mesh` + `d5material.xml` + `info.json` + `textures/*`）。
 *
 * 必须用**真 ZIP 字节**：只有这样「没有被解包」才是被证实的（否则用一段假字节，
 * 解包路径本来也会失败，测试等于什么都没证明）。
 */
function makeD5aZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('1.d5mesh', Buffer.from('d5mesh-binary-placeholder'))
  zip.addFile('d5material.xml', Buffer.from('<material name="休闲椅"/>'))
  zip.addFile('info.json', Buffer.from('{"productID":"0123456789abcdef0123456789abcdef"}'))
  zip.addFile('textures/布纹_BaseColor.png', Buffer.from('png-placeholder'))
  return zip.toBuffer()
}

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-d5a-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

function makeDeps(
  libraryDir: string,
  over: Partial<ImportDeps> = {}
): {
  deps: ImportDeps
  events: ImportEvent[]
  thumbs: Array<{ id: string; coverAbs: string | null }>
} {
  const events: ImportEvent[] = []
  const thumbs: Array<{ id: string; coverAbs: string | null }> = []
  const deps: ImportDeps = {
    libraryDir,
    sevenZipPath: null,
    // 刻意给 `keep`：本文件要顺带断言"源存档原地不动"（整包入库是复制，不是搬走）
    archiveDisposal: 'keep',
    defaultSource: '本机',
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: 200 * 1024 * 1024,
    spaceSafetyFactor: 1.2,
    concurrency: DEFAULT_CONCURRENCY,
    ensureThumb: async (id, coverAbs) => {
      thumbs.push({ id, coverAbs })
      // 与生产实现同契约（`main/thumb.ts:58`）：coverAbs 为空直接返回 null ⇒ thumbStatus='none'
      return coverAbs ? `${id}-stub.jpg` : null
    },
    emit: (ev) => events.push(ev),
    ...over
  }
  return { deps, events, thumbs }
}

function file(rel: string, ext: string, size = 1): AssetFile {
  return { rel, name: path.basename(rel), ext, size, kind: kindOfExt(ext) }
}

/**
 * `.d5a` 资产夹具（与 `importMediaOne` 落出来的形状逐字对齐：
 * `cover=undefined` / `coverSource='placeholder'` / `thumbStatus='none'` / 双「未分类」）。
 */
function makeD5aAsset(): Asset {
  return {
    id: 'id-d5a',
    name: '休闲椅',
    kind: 'd5a',
    source: '本机',
    folder: 'E:\\Lib\\D5A\\未分类\\未分类\\休闲椅',
    relFolder: 'D5A/未分类/未分类/休闲椅',
    files: [file('休闲椅.d5a', 'd5a', 8_229_266)],
    size: 8_229_266,
    tags: [],
    note: '',
    favorite: false,
    rating: 0,
    colorTag: null,
    cover: undefined,
    coverSource: 'placeholder',
    thumbStatus: 'none',
    category1: '未分类',
    category2: '未分类',
    styles: [],
    dedupeKey: dedupeKeyOf('休闲椅', 'd5a'),
    importedAt: 1_794_227_518_427,
    updatedAt: 1_794_227_518_427
  }
}

// ── ① 扩展名映射 ────────────────────────────────────────────────────────

describe('d5a 大类 · 扩展名映射（EXT_KIND）', () => {
  it('d5a → d5a（kindOfExt 大小写 / 带点都能吃）', () => {
    expect(EXT_KIND.d5a).toBe('d5a')
    expect(kindOfExt('d5a')).toBe('d5a')
    expect(kindOfExt('D5A')).toBe('d5a')
    expect(kindOfExt('.d5a')).toBe('d5a')
  })

  it('防误伤：模型 / 图片 / HDR / 材质扩展名一个都不能跟着变', () => {
    for (const ext of ['skp', 'skb', 'max', '3ds', '3dm', 'fbx', 'obj', 'rvt', 'stl', 'glb']) {
      expect(EXT_KIND[ext], `${ext} 不该被 d5a 波及`).toBe('model')
    }
    for (const ext of ['dwg', 'dxf']) expect(EXT_KIND[ext], `${ext} 仍是 cad`).toBe('cad')
    for (const ext of ['hdr', 'exr']) expect(EXT_KIND[ext], `${ext} 仍是 hdri`).toBe('hdri')
    for (const ext of ['png', 'jpg', 'tga']) expect(EXT_KIND[ext], `${ext} 仍是 texture`).toBe('texture')
    expect(EXT_KIND.vismat).toBe('material')
  })

  it('未登记扩展名不因为新增 d5a 而被顺手放行（仍是 other）', () => {
    expect(kindOfExt('d5mesh')).toBe('other')
    expect(kindOfExt('d5m')).toBe('other')
    expect(kindOfExt('')).toBe('other')
  })
})

// ── ② 显示名 / 落盘目录 / 四段路径 ──────────────────────────────────────

describe('d5a 大类 · 显示名 / 落盘目录（落盘唯一入口 kindFolder）', () => {
  it('KIND_LABEL.d5a = 「D5A」（仅 UI 显示）', () => {
    expect(KIND_LABEL.d5a).toBe(D5_LABEL)
  })

  it('KIND_FOLDER.d5a = 「D5A」（第 7 个顶层目录）', () => {
    expect(KIND_FOLDER.d5a).toBe(D5_FOLDER)
    expect(kindFolder('d5a')).toBe(D5_FOLDER)
  })

  it('★目录拼得对：D5A/未分类/未分类/休闲椅（拼路径只准走 kindFolder）', () => {
    const segs = [kindFolder('d5a'), '未分类', '未分类', '休闲椅']
    expect(segs.join('/')).toBe('D5A/未分类/未分类/休闲椅')
    // 反例守卫：显示名与目录名恰好同名，但拼路径永远不该看到 KIND_LABEL 参与
    expect(kindFolder('d5a')).toBe(KIND_FOLDER.d5a)
  })

  it('反查：目录名 D5A → d5a；未知目录仍是 other；大小写不敏感不在此处放宽', () => {
    expect(kindFromFolderName('D5A')).toBe('d5a')
    expect(kindFromFolderName('d5a')).toBe('other')
    expect(kindFromFolderName('不存在的目录')).toBe('other')
    // 安全门（asset:assignCategory 白名单）必须认 D5A
    expect(isKindFolderName('D5A')).toBe(true)
  })

  it('D5A 不与任何现有 kind 共用顶层目录（不会被 AMBIGUOUS 判成 null）', () => {
    const folders = Object.values(KIND_FOLDER)
    expect(folders.filter((f) => f === D5_FOLDER)).toHaveLength(1)
  })
})

// ── ③ 筛选能力表 / 侧栏导航 ─────────────────────────────────────────────

describe('d5a 大类 · 筛选能力表与导航序', () => {
  it('分辨率 / 风格 / 模型格式 三项全 false（整包存档没有可筛的位图或格式轴）', () => {
    expect(KIND_FILTER_CAPS.d5a).toEqual({
      resolution: false,
      style: false,
      modelFormat: false
    })
  })

  it('U-1 回签：KIND_NAV_ORDER 不新增 D5A 节点（侧栏不出现 D5A 项）', () => {
    expect(KIND_NAV_ORDER).not.toContain('d5a')
  })

  /**
   * 2026-11-09 用户 P0：「我刚才拖入一个 d5a 文件，然后拖进去不在了，我找不到它」
   * + 同日第二次回签：「D5a 本身属于模型格式」。
   *
   * 复盘结论（两段）：**导入链路完全正常**（磁盘有
   * `D5A/未分类/未分类/休闲椅/休闲椅.d5a`、Dexie 里 `kind='d5a'` 那条在、
   * `deletedAt` 为空），坏的是**可达性**。第一版修法是"给首页补一张 D5A 文件夹卡"，
   * 但用户当场指出那让同一个东西有了三种说法（侧栏没有 / 格式筛不到 / 首页却有卡）。
   * 现在收口成一句话：**`.d5a` 是模型的一种格式**（与 `.max` 同构；存储仍是独立 kind、
   * **不迁库**、落盘目录仍是 `D5A/`），入口统一走「模型 → 格式=D5A」。
   *
   * 下面四条断言把新口径钉死（不要用"删掉某条断言"的方式让它变绿）：
   * ① 首页候选集**不含** `d5a`（不再单独占卡），且顺序就是导航序；
   * ② 导航序**仍然没有** `d5a`（U-1 回签，侧栏不长出 D5A 项 —— 与"并进模型"一致）；
   * ③ 「模型」视图**能筛到** `d5a`（`kindsOfFilter('model')` = {model, d5a}）；
   * ④ 格式筛 `D5A` **能筛出来**（`getModelFormat` 认 `.d5a`）。
   */
  it('首页文件夹候选集不含 d5a（不占卡，入口走模型 + 格式）', () => {
    expect(HOME_FOLDER_KEYS).not.toContain('d5a')
    // 候选集回到纯导航序（首页不再有任何"补丁项"）
    expect([...HOME_FOLDER_KEYS]).toEqual([...KIND_NAV_ORDER])
    // 幂等 / 不重复：候选集里每个节点只出现一次
    expect(new Set(HOME_FOLDER_KEYS).size).toBe(HOME_FOLDER_KEYS.length)
    // 按落盘目录去重（2026-11-09 用户当场指出「首页做那么多文件夹干什么」）：
    // `texture`（显示「贴图」）与 `material`（显示「材质预设」）落盘都是同一个「材质」目录，
    // 若候选集按 kind 补，首页会多出两张和「材质」指向同一目录的卡。
    const folderOf = (node: string): string => {
      const members = (KIND_GROUP_MEMBERS as Readonly<Record<string, readonly string[]>>)[node]
      // 分组哨兵取**第一个成员**的目录（分组成员必然同目录），不要摊成数组 ——
      // 摊平会让「材质」被算两次，把这条断言变成假的重复。
      const probe = members ? members[0] : node
      return KIND_FOLDER[probe as keyof typeof KIND_FOLDER]
    }
    const allFolders = HOME_FOLDER_KEYS.map(folderOf)
    expect(new Set(allFolders).size).toBe(allFolders.length)
    // 两个「材质类」的单 kind 不许再单独占卡（分组卡已覆盖该目录）
    expect(HOME_FOLDER_KEYS).not.toContain('texture')
    expect(HOME_FOLDER_KEYS).not.toContain('material')
    // D5A 的落盘目录仍在，只是不再有独立入口（不迁库）
    expect(KIND_FOLDER.d5a).toBe('D5A')
  })

  it('侧栏轨道不含 d5a（RAIL_KIND_SEQUENCE 与导航序求交集的结果里没有它）', () => {
    // 源码守卫：轨道顺序表是侧栏的**展示序**唯一来源，它必须是固定四项，
    // 谁把 'd5a' 塞进去，首页卡与侧栏就会出现两套口径（用户回签的是"侧栏不出现 D5A"，
    // 现在与"并进模型"完全一致 —— 入口在模型视图的格式筛选里）。
    const src = read('src/renderer/components/Sidebar.tsx')
    const block = src.slice(
      src.indexOf('const RAIL_KIND_SEQUENCE'),
      src.indexOf('const RAIL_KINDS')
    )
    expect(block).not.toContain("'d5a'")
    expect(block).not.toContain('"d5a"')
  })

  it('「模型」视图能筛到 d5a（kindsOfFilter 口径 = 模型域）', () => {
    const d5aAsset = makeD5aAsset()
    const modelAsset: Asset = {
      ...makeD5aAsset(),
      id: 'id-model',
      name: '测试沙发',
      kind: 'model',
      folder: 'E:\\Lib\\模型\\未分类\\未分类\\测试沙发',
      relFolder: '模型/未分类/未分类/测试沙发',
      files: [file('测试沙发.skp', 'skp', 2048)],
      dedupeKey: dedupeKeyOf('测试沙发', 'model')
    }
    // 模型视图（kind='model'）= 模型的全部格式 ⇒ 两个都出
    expect(kindsOfFilter('model')).toEqual(new Set(['model', 'd5a']))
    expect(
      applyFilters([d5aAsset, modelAsset], { ...DEFAULT_FILTERS, kind: 'model' }, 'assets')
        .map((a) => a.id)
        .sort()
    ).toEqual(['id-d5a', 'id-model'])
    // 「全部」视图仍能看到它（回归保护：别为了收口把它在「全部」里弄丢）
    expect(applyFilters([d5aAsset], DEFAULT_FILTERS, 'assets').map((a) => a.id)).toEqual(['id-d5a'])
    // 其它大类视图仍然看不到它（模型域之外）
    for (const kind of ['texture', 'material', 'materialGroup', 'hdri', 'cad', 'other'] as const) {
      expect(applyFilters([d5aAsset], { ...DEFAULT_FILTERS, kind }, 'assets')).toEqual([])
    }
    // 回收站视图里也不该出现（未软删）
    expect(applyFilters([d5aAsset], DEFAULT_FILTERS, 'trash')).toEqual([])
  })

  it('格式筛 D5A 能筛出来（getModelFormat 认 .d5a；且不进 SU / 3DMAX 档）', () => {
    const d5aAsset = makeD5aAsset()
    expect(getModelFormat(d5aAsset.files)).toBe('d5a')
    expect(
      applyFilters([d5aAsset], { ...DEFAULT_FILTERS, kind: 'model', modelFormat: 'd5a' }, 'assets')
        .map((a) => a.id)
    ).toEqual(['id-d5a'])
    // 选 SU / 3DMAX 时 d5a 必须被排除（不能"什么格式都算它一份"）
    for (const fmt of ['skp', 'max'] as const) {
      expect(
        applyFilters([d5aAsset], { ...DEFAULT_FILTERS, kind: 'model', modelFormat: fmt }, 'assets')
      ).toEqual([])
    }
    // 格式选项表里有 D5A 档（UI 弹层直接映射这张表）
    expect(MODEL_FORMAT_OPTIONS.map((o) => o.value)).toEqual([null, 'skp', 'max', 'd5a'])
    expect(MODEL_FORMAT_OPTIONS.map((o) => o.label)).toEqual(['全部', 'SU', '3DMAX', 'D5A'])
  })
})

// ── ④ primaryKind / pickPrimaryFile / pickCover ─────────────────────────

describe('d5a 大类 · 主大类与主文件判定', () => {
  it('files 只有整包 → primaryKind = d5a', () => {
    expect(primaryKind([file('休闲椅.d5a', 'd5a')])).toBe('d5a')
  })

  it('万一目录里被塞了张预览图：贴图优先（d5a 排在 texture 之后）', () => {
    expect(primaryKind([file('休闲椅.d5a', 'd5a'), file('预览.jpg', 'jpg')])).toBe('texture')
  })

  it('★pickPrimaryFile 退到 files[0]，就是那个 .d5a（不进 PRIMARY_MODEL_EXTS）', () => {
    const d5a = file('休闲椅.d5a', 'd5a')
    expect(pickPrimaryFile([d5a])).toBe(d5a)
  })

  it('pickCover 对纯整包返回 null（⇒ coverSource 走 placeholder）', () => {
    expect(pickCover([file('休闲椅.d5a', 'd5a')])).toBeNull()
  })

  it('dedupeKey = d5a:休闲椅，与 model / texture 同名不撞', () => {
    expect(dedupeKeyOf('休闲椅', 'd5a')).toBe('d5a:休闲椅')
    expect(dedupeKeyOf('休闲椅', 'model')).toBe('model:休闲椅')
    expect(dedupeKeyOf('休闲椅', 'd5a')).not.toBe(dedupeKeyOf('休闲椅', 'model'))
    expect(dedupeKeyOf('休闲椅', 'd5a')).not.toBe(dedupeKeyOf('休闲椅', 'texture'))
  })
})

// ── ⑤ 词表：不建册 ⇒ 恒双未分类 ─────────────────────────────────────────

describe('d5a 大类 · 分类（不新建词表册，恒双「未分类」）', () => {
  it('「休闲椅」不会被模型频道的词吞掉 → 未分类/未分类', () => {
    expect(classifyAssetName('休闲椅', ['休闲椅.d5a'], 'd5a')).toEqual({
      category1: '未分类',
      category2: '未分类'
    })
  })

  it('带强词根的样本也一样（D5A 本批不接词表，是设计结论不是缺陷）', () => {
    for (const name of ['大理石瓷砖', '北欧布艺沙发', '天空HDR', '工装平面图', '']) {
      expect(classifyAssetName(name, undefined, 'd5a')).toEqual({
        category1: '未分类',
        category2: '未分类'
      })
    }
  })
})

// ── ⑥ 端到端：真 ZIP 内容的 .d5a 整包入库（核心） ───────────────────────

describe('importPaths — .d5a 整包直导（真 ZIP 内容也不许解包）', () => {
  it('★整包入库：files 恰 1 项、包内 4 个条目一个都没落地、源存档原地不动', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '休闲椅.d5a')
    const bytes = makeD5aZip()
    await fs.writeFile(src, bytes)

    const { deps, events } = makeDeps(lib)
    const assets = await importPaths([src], deps)

    // 不报 unsupported / 不静默丢：状态成功且产出一条资产
    expect(assets.length).toBe(1)
    expect(events.some((e) => e.status === 'error')).toBe(false)
    expect(events.some((e) => e.status === 'done')).toBe(true)

    const a: Asset = assets[0]!
    expect(a.kind).toBe('d5a')
    expect(a.name).toBe('休闲椅')
    // 四段路径：D5A/未分类/未分类/休闲椅
    expect(a.relFolder).toBe('D5A/未分类/未分类/休闲椅')
    expect(a.folder).toBe(path.join(lib, 'D5A', '未分类', '未分类', '休闲椅'))
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.dedupeKey).toBe('d5a:休闲椅')

    // ★ files[] 恰 1 项 = 整包自己
    expect(a.files).toHaveLength(1)
    expect(a.files[0]!.rel).toBe('休闲椅.d5a')
    expect(a.files[0]!.ext).toBe('d5a')
    expect(a.files[0]!.kind).toBe('d5a')
    expect(a.files[0]!.size).toBe(bytes.length)
    expect(a.size).toBe(bytes.length)

    // ★ 不解包：资产目录里只有那一个文件，包内条目一个都没有
    const inside = await fs.readdir(a.folder)
    expect(inside).toEqual(['休闲椅.d5a'])
    expect(inside).not.toContain('1.d5mesh')
    expect(inside).not.toContain('d5material.xml')
    expect(inside).not.toContain('info.json')
    expect(inside).not.toContain('textures')

    // 内容按字节原样复制（没有"重新打包"这类小动作）
    expect(await fs.readFile(path.join(a.folder, '休闲椅.d5a'))).toEqual(bytes)

    // ★ 源存档原地不动（archiveDisposal='keep'）
    await expect(fs.stat(src)).resolves.toBeTruthy()
    expect(await fs.readFile(src)).toEqual(bytes)
  })

  it('★无封面（isCoverless）：cover=undefined / placeholder / thumbStatus=none', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '休闲椅.d5a')
    await fs.writeFile(src, makeD5aZip())

    const { deps, thumbs } = makeDeps(lib)
    const [a] = await importPaths([src], deps)

    // ★ 这四条合起来就是「不会把 ZIP 当图片解码」的证据链
    expect(a!.cover).toBeUndefined()
    expect(a!.coverSource).toBe('placeholder')
    expect(a!.thumbStatus).toBe('none')
    expect(a!.thumbPath).toBeUndefined()
    // ensureThumb 拿到的 coverAbs 必须是 null（生产实现在 thumb.ts:58 首行即返回，
    // 不会走到 nativeImage.createFromPath —— 这就是"不做 D5 缩略图"的落点）
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]!.coverAbs).toBeNull()

    // 顺手确认：没有把 name 当封面文件名、也没有伪造文件
    expect(a!.files.map((f) => f.rel)).toEqual(['休闲椅.d5a'])
  })

  it('导入文案说的是 D5A，不是「正在读取图片…」（大包导入慢时不能误导）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '休闲椅.d5a')
    await fs.writeFile(src, makeD5aZip())

    const { deps, events } = makeDeps(lib)
    await importPaths([src], deps)
    const readMsg = events.find((e) => e.status === 'extracting')
    expect(readMsg?.message).toBe('正在读取 D5A…')
    expect(events.some((e) => (e.message ?? '').includes('正在解压'))).toBe(false)
  })

  it('同名再拖一次：不覆盖，生成唯一目录（与另两条路径同一套 uniqueName/台账）', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '休闲椅.d5a')
    await fs.writeFile(src, makeD5aZip())

    const first = await importPaths([src], makeDeps(lib).deps)
    const second = await importPaths([src], makeDeps(lib).deps)
    expect(first[0]!.folder).not.toBe(second[0]!.folder)
    expect(second[0]!.name).toBe('休闲椅-2')
    // 两条都是 d5a，且目录名仍在大类 D5A 下
    for (const a of [first[0]!, second[0]!]) {
      expect(a.kind).toBe('d5a')
      expect(a.relFolder.startsWith('D5A/')).toBe(true)
    }
  })

  it('rescan 回读：资产不丢、kind 不漂移、封面仍是 placeholder', async () => {
    const root = await tmpDir()
    const lib = path.join(root, 'Library')
    await fs.mkdir(lib, { recursive: true })
    const src = path.join(root, '休闲椅.d5a')
    await fs.writeFile(src, makeD5aZip())

    const [imported] = await importPaths([src], makeDeps(lib).deps)
    const { assets } = await rescanLibrary(lib)
    expect(assets).toHaveLength(1)
    const a = assets[0]!
    // rescan 生成新 UUID（id 由渲染层按 folder 对齐），这里只守 kind / 目录 / 封面 / 键
    expect(a.folder).toBe(imported!.folder)
    expect(a.kind).toBe('d5a')
    expect(a.relFolder).toBe('D5A/未分类/未分类/休闲椅')
    expect(a.category1).toBe('未分类')
    expect(a.category2).toBe('未分类')
    expect(a.files).toHaveLength(1)
    expect(a.files[0]!.kind).toBe('d5a')
    expect(a.cover).toBeUndefined()
    expect(a.coverSource).toBe('placeholder')
    expect(a.dedupeKey).toBe('d5a:休闲椅')
  })
})

// ── ⑦ 解压闸门：extractor 必须始终拒绝 .d5a ─────────────────────────────

describe('extractor — .d5a 永远进不了解压链路', () => {
  it('★extractArchive(.d5a) 抛 unsupported（兜底防线，不是主防线）', async () => {
    const root = await tmpDir()
    const src = path.join(root, '休闲椅.d5a')
    await fs.writeFile(src, makeD5aZip())
    const dest = path.join(root, 'out')

    await expect(
      extractArchive(src, dest, {
        sevenZipPath: null,
        codepage: 'auto',
        timeoutMs: 5_000,
        maxBytesForJsFallback: 200 * 1024 * 1024
      })
    ).rejects.toThrow(/暂不支持 \.d5a 格式/)

    // 抛错发生在 mkdir 之前 ⇒ 不留半成品
    await expect(fs.stat(dest)).rejects.toThrow()

    // 错误 kind 必须是 unsupported（渲染层据此给"可行动"文案）
    const err = await extractArchive(src, dest, {
      sevenZipPath: null,
      codepage: 'auto',
      timeoutMs: 5_000,
      maxBytesForJsFallback: 200 * 1024 * 1024
    }).then(
      () => null,
      (e: unknown) => e as InstanceType<typeof ExtractionError>
    )
    expect(err).toBeInstanceOf(ExtractionError)
    expect(err?.kind).toBe('unsupported')
  })
})

// ── ⑧ 源码守卫（改回去不会有编译错误，只会真机炸） ──────────────────────

describe('源码守卫 · 防回退', () => {
  it('extractor.ts 的解压白名单仍只有 zip / rar / 7z（加 .d5a = 解包）', () => {
    const src = read('src/main/extractor.ts')
    const m = /const SUPPORTED_EXTS = new Set\(\[([^\]]*)\]\)/.exec(src)
    expect(m, '找不到 SUPPORTED_EXTS 定义').not.toBeNull()
    const exts = m![1]!.match(/'[^']+'/g) ?? []
    expect(exts).toEqual(["'.zip'", "'.rar'", "'.7z'"])
    expect(src).not.toContain("'.d5a'")
  })

  it('★importer.ts 的 .d5a 分流必须早于 importModelOne 与 extractArchive 调用点', () => {
    const src = read('src/main/importer.ts')
    const iD5a = src.indexOf("if (extKind === 'd5a') return importMediaOne(")
    const iModel = src.indexOf('if (extKind === \'model\' || extKind === \'cad\') return importModelOne(')
    const iExtract = src.indexOf('await extractArchive(src, staging')
    expect(iD5a, '找不到 .d5a 单文件分流分支').toBeGreaterThan(-1)
    expect(iModel).toBeGreaterThan(-1)
    expect(iExtract).toBeGreaterThan(-1)
    // 顺序：d5a 分支 < 模型分支 < 解压调用点（越晚越安全）
    expect(iD5a).toBeLessThan(iModel)
    expect(iD5a).toBeLessThan(iExtract)
  })

  it('importer.ts 用 isCoverless（= HDR ‖ D5A）管封面 / 缩略图，且没有把 d5a 交给 importModelOne', () => {
    const src = read('src/main/importer.ts')
    expect(src).toMatch(/const isCoverless = isHdr \|\| kind === 'd5a'/)
    expect(src).toContain('const coverAbs = isCoverless ? null : destFile')
    expect(src).toContain('cover: isCoverless ? undefined : itemName')
    expect(src).toContain("coverSource: isCoverless ? 'placeholder' : 'named'")
    // 全景参数（HDR 专属）不能被 isCoverless 顺手带上
    expect(src).toContain('const note = isHdr ? panoramaNoteFromName(itemName) : ')
  })

  it('classify.ts 没把 d5a 塞进模型主文件优先级 / 没有 d5a 的解压白名单旁路', () => {
    const src = read('src/shared/classify.ts')
    expect(src).toMatch(/export const PRIMARY_MODEL_EXTS = \[[^\]]*\] as const/)
    expect(src).not.toMatch(/PRIMARY_MODEL_EXTS[^\n]*d5a/)
  })

  it('styles.css：紫色 token 成对存在（浅深各一对）且带显式例外注释', () => {
    const css = read('src/renderer/styles.css')
    const brands = css.match(/--d5-brand:\s*#[0-9a-fA-F]{6}/g) ?? []
    const tints = css.match(/--d5-brand-tint:\s*#[0-9a-fA-F]{6}/g) ?? []
    expect(brands).toHaveLength(2)
    expect(tints).toHaveLength(2)
    // 色值口径：用户 2026-11-09 拍板（docs/48 §1），不许被"顺手优化"
    expect(css).toContain('--d5-brand: #9977f9')
    expect(css).toContain('--d5-brand: #b9a6ff')
    // 显式例外注释（唯一一处 / 第二处须重新回签）
    expect(css).toContain('显式例外')
    expect(css).toContain('新增第二处使用前须重新回签')
    // 禁紫红线原文保留（例外不是删除红线）
    expect(css).toContain('⛔ 全局禁用：橙色/棕色高亮、紫色系')
  })
})

// ── ⑨ 呈现层：IconD5a + 紫色占位卡 + 文件视图 D5A 块 ─────────────────────

describe('呈现层 · IconD5a（自绘图标）', () => {
  const icons = read('src/renderer/icons.tsx')

  it('导出 IconD5a，且几何用导出的常量（卡片占位复用同一份路径，不抄第二份）', () => {
    expect(icons).toContain('export const IconD5a')
    expect(icons).toContain('export const D5A_MARK_PATH')
    expect(icons).toContain('export const D5A_MARK_FOLD_PATH')
    // 图标本体引用常量而不是内联 d
    expect(icons).toMatch(/<path d=\{D5A_MARK_PATH\} \/>/)
    expect(icons).toMatch(/<path d=\{D5A_MARK_FOLD_PATH\} \/>/)
  })

  it('走既有 Base 容器 ⇒ 24×24 viewBox / 20×20 占位 / strokeWidth 2.25 / currentColor', () => {
    // Base 是唯一容器：IconD5a 必须写成 `<Base {...p}>`（不自绘 svg，否则描边口径会漂）
    const fn = icons.slice(icons.indexOf('export const IconD5a'))
    expect(fn.slice(0, 200)).toContain('<Base {...p}>')
    expect(fn.slice(0, 200)).not.toContain('<svg')
    // Base 的三条硬规格仍原样
    expect(icons).toContain('viewBox="0 0 24 24"')
    expect(icons).toContain('strokeWidth="2.25"')
    expect(icons).toContain('stroke="currentColor"')
  })

  it('六边形顶点落在 20×20 安全区内（四周留 2），不靠 translate 硬掰', () => {
    const m = /export const D5A_MARK_PATH = '([^']+)'/.exec(icons)
    expect(m).not.toBeNull()
    // 顶点坐标全是 3.9 / 12 / 20.1 / 2.6 / 21.4 —— 全部落在 [2,22]
    const nums = (m![1]!.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
    expect(nums.length).toBeGreaterThan(4)
    for (const n of nums) {
      expect(n, `坐标 ${n} 越出 20×20 安全区`).toBeGreaterThanOrEqual(2)
      expect(n, `坐标 ${n} 越出 20×20 安全区`).toBeLessThanOrEqual(22)
    }
  })
})

describe('呈现层 · 卡片紫底占位（无封面）与封面优先', () => {
  const grid = read('src/renderer/components/AssetGrid.tsx')

  it('★有封面时先走缩略图分支，紫底占位只在没有缩略图时出现', () => {
    const iThumb = grid.indexOf('if (src && brokenSrc !== src)')
    const iD5a = grid.indexOf("if (asset.kind === 'd5a')")
    expect(iThumb).toBeGreaterThan(-1)
    expect(iD5a).toBeGreaterThan(-1)
    // 缩略图 < 紫底分支 ⇒ 有图就显示图，不会拿紫底盖住用户自己贴的封面
    expect(iThumb).toBeLessThan(iD5a)
  })

  it('占位内容只有「标记 + D5A 大字」：不放说明性小字（紫底小字必然低于 4.5:1）', () => {
    const start = grid.indexOf("if (asset.kind === 'd5a')")
    // 分支边界截到通用占位那行，避免窗口溢出到后面的组件里
    const end = grid.indexOf('const Icon = KIND_ICON[asset.kind]', start)
    expect(end).toBeGreaterThan(start)
    const block = grid.slice(start, end)
    expect(block).toContain('D5A')
    expect(block).toContain('D5A_MARK_PATH')
    expect(block).toContain('className="d5a-cover')
    // 不得出现文件名 / 10px 小字（generic 占位那条 `text-[10px]` 不许被抄进来）
    expect(block).not.toContain('text-[10px]')
    expect(block).not.toContain('fileName')
  })

  it('占位画在一张 100×100 的 SVG 里（三档密度等比缩放，不按 px 算字号）', () => {
    const start = grid.indexOf("if (asset.kind === 'd5a')")
    const end = grid.indexOf('const Icon = KIND_ICON[asset.kind]', start)
    const block = grid.slice(start, end)
    expect(block).toContain('viewBox="0 0 100 100"')
    // 大字档：粗体 800 + fontSize 30（小密度档渲染 cap ≈23px > 粗体门槛 18.66px）
    expect(block).toContain('fontWeight="800"')
    expect(block).toContain('fontSize="30"')
  })

  it('⛔ 不用 Tailwind `dark:` 变体（本项目主题是 data-theme 属性，dark: 会跟系统串色）', () => {
    expect(grid).not.toMatch(/dark:bg-d5/)
    expect(grid).not.toMatch(/dark:text-d5/)
  })
})

describe('呈现层 · d5a-card.css（主题成对的紫底规则）', () => {
  const css = read('src/renderer/components/d5a-card.css')

  it('浅色档实底品牌紫 + 深色档 tint 底，两条规则都在', () => {
    expect(css).toMatch(/\.d5a-cover\s*{[^}]*var\(--d5-brand\)/s)
    expect(css).toMatch(/\[data-theme='dark'\]\s*\.d5a-cover\s*{[^}]*var\(--d5-brand-tint\)/s)
  })

  it('只吃 token：去掉注释后文件里没有任何写死 hex', () => {
    const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(noComment).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(noComment).toContain('var(--d5-brand)')
    expect(noComment).toContain('var(--d5-brand-tint)')
  })

  it('文件头写明"唯一一处 / 新增第二处须重新回签"', () => {
    expect(css).toContain('新增第二处使用前须重新回签')
    expect(css).toContain('D5A 卡片封面占位')
  })
})

describe('呈现层 · 四处 KIND_ICON 全部换成 IconD5a', () => {
  const files = [
    'src/renderer/components/AssetGrid.tsx',
    'src/renderer/components/DetailPanel.tsx',
    'src/renderer/components/DuplicateCompareDialog.tsx',
    'src/renderer/components/QuickLookOverlay.tsx'
  ]

  it('每处都是 d5a: IconD5a（没有残留 d5a: IconOther）', () => {
    for (const f of files) {
      const src = read(f)
      expect(src, `${f} 缺 d5a: IconD5a`).toMatch(/d5a: IconD5a,/)
      expect(src, `${f} 仍残留 d5a: IconOther`).not.toMatch(/d5a: IconOther/)
      // 且必须真的从 '../icons' 导入（否则 typecheck 红，但这条钉的是"导入没被删"）
      expect(src, `${f} 没导入 IconD5a`).toContain('IconD5a')
    }
  })

  it('icons.tsx 仍保留 IconOther（other 大类还要用，别被人一起改名）', () => {
    expect(read('src/renderer/icons.tsx')).toContain('export const IconOther')
  })
})

describe('呈现层 · 文件视图 .d5a 文字块', () => {
  const grid = read('src/renderer/components/AssetGrid.tsx')

  it('FileCover 里有 .d5a 分支：bg-d5-tint + text-d5 + 大号 D5A', () => {
    expect(grid).toContain("if (rowExt === 'd5a')")
    expect(grid).toContain('bg-d5-tint text-d5')
    expect(grid).toContain('const rowExt = row.ext.toLowerCase()')
  })

  it('判定用扩展名而不是 row.kind（fileView 把 .d5a 归 other，不动分组口径）', () => {
    // 只换封面外观：fileView.ts 一个字都不该被这次改动碰
    const fv = read('src/renderer/logic/fileView.ts')
    expect(fv).not.toContain('d5a')
  })

  it('列表视图的行图标也换 IconD5a（否则同一行两套语义）', () => {
    expect(grid).toContain("row.ext.toLowerCase() === 'd5a' ? IconD5a : FILE_ROW_ICON[row.kind]")
  })
})
