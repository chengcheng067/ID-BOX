/**
 * D5A 资产贴自定义封面后整包大类被误判成 texture 的 P0 回归（2026-11-11 真机缺陷）。
 *
 * ## 根因链（已逐行核实，本测试只钉行为，不重新调研）
 * ① 导入正确：`.d5a` 走 `importMediaOne`，落 `D5A/未分类/未分类/<资产名>/`，`kind='d5a'`；
 * ② 埋雷：`store.ts#commitCover()` 把 `<资产名>.cover.png` 作为 `AssetFile` 追加进
 *    `files[]`，`kind: existing?.kind ?? 'texture'`，**当场不改 asset.kind**；
 * ③ 引爆：`rescan.ts` 用 `walkFiles` 收齐目录全部文件 → `primaryKind(files)`；
 *    `KIND_PRIORITY` 里 `texture` 排在 `d5a` 前 ⇒ `present={d5a,texture}` 返回 `texture`；
 * ④ 写回：`store.ts` 合并时 `kind: s.kind` 无条件覆盖 Dexie；
 * ⑤ 显示：`CategoryPicker` 读 `asset.kind` → 「材质（贴图）」+ 材质合并词表（石材/砖材/木纹）；
 * ⑥ 连带：`pickPrimaryFile` 的 `files[0]` 兜底把 `mainFile` 选成 `.cover.png`（插件
 *    `index.json` 里已出现该脏值）；
 * ⑦ 损坏风险：`assignCategory` 用 `kindFolder(asset.kind)` 拼目标目录，错误状态下点「指派」
 *    会把资产从 `D5A/` 真实搬进 `材质/`。
 *
 * ## 修法（本批）
 * `shared/classify.ts` 新增 `withoutProgramCovers()`：判定 `present` / 材质包 / 主文件时
 * 剔除 `isCoverAssetImage(rel)` 命中的附属封面。**刻意不动 `KIND_PRIORITY` 顺序** ——
 * 调顺序会改坏「真实模型包 + 贴图仍 model」「手工塞预览图仍 texture」等既有语义。
 *
 * ## 为什么不写用户库 / 不写迁移
 * 修好 `primaryKind` 后，用户下次点「刷新 / 重新扫描库」时 `rescan` 会自然重算成 `d5a`
 * 并经 `store.ts` 的 `kind: s.kind` 合并通道写回 Dexie —— 自愈路径，无需迁移脚本。
 * 本文件末尾有源码守卫钉住这条通道没被"好心加保护"堵死。
 *
 * 纯逻辑、零 IO（只读源码文本），vitest `environment: 'node'`，无 jsdom。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  KIND_LABEL,
  detectMaterialPack,
  isCoverAssetImage,
  kindFolder,
  kindOfExt,
  pickPrimaryFile,
  primaryKind
} from '../src/shared/classify'
import { level1OptionsFor } from '../src/renderer/logic/category'
import { buildPluginRecord } from '../src/shared/pluginSnapshot'
import type { Asset, AssetFile } from '../src/shared/types'

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8')

/** 造一条完整的 AssetFile（ext 用真实后缀推导 kind，贴近 walkFiles 的产出） */
function f(rel: string, ext: string, size = 1): AssetFile {
  return { rel, name: rel.split('/').pop() ?? rel, ext, size, kind: kindOfExt(ext) }
}

/** 用户实测的样本：D5A 资产「中古侘寂沙发」贴了自定义封面后的 files[] */
function d5aWithCover(): AssetFile[] {
  return [
    f('中古侘寂沙发.cover.png', 'png'),
    f('中古侘寂沙发.d5a', 'd5a')
  ]
}

// ── ① 核心缺陷：附属封面不得决定整包大类 ──────────────────────────────

describe('primaryKind — D5A + 自定义封面（P0 主场景）', () => {
  it('★D5A 包 + .cover.png ⇒ d5a（派工单逐字用例）', () => {
    expect(
      primaryKind([
        { rel: 'x.d5a', kind: 'd5a' },
        { rel: 'x.cover.png', kind: 'texture' }
      ])
    ).toBe('d5a')
  })

  it('对照：D5A 包只有整包自己 ⇒ d5a（原本就对，别被改坏）', () => {
    expect(primaryKind([{ rel: 'x.d5a', kind: 'd5a' }])).toBe('d5a')
  })

  it('★真机形状：walkFiles 顺序把 .cover.png 排在 .d5a 前面，仍是 d5a', () => {
    // rescan 的 walkFiles 按目录遍历顺序，封面常常先于主文件 —— 两种顺序都测
    const files = d5aWithCover()
    expect(files[0]!.rel.endsWith('.cover.png')).toBe(true)
    expect(primaryKind(files)).toBe('d5a')
    expect(primaryKind([...files].reverse())).toBe('d5a')
  })

  it('.cover.jpg / .cover.jpeg / 大写 .COVER.PNG 三种变体都被剔除', () => {
    for (const coverRel of [
      '中古侘寂沙发.cover.jpg',
      '中古侘寂沙发.cover.jpeg',
      '中古侘寂沙发.COVER.PNG'
    ]) {
      expect(isCoverAssetImage(coverRel)).toBe(true)
      expect(primaryKind([f('中古侘寂沙发.d5a', 'd5a'), f(coverRel, 'jpg')])).toBe('d5a')
    }
  })

  it('同时有 .cover.jpg 与 .cover.png 两张封面也仍是 d5a', () => {
    expect(
      primaryKind([
        f('中古侘寂沙发.cover.jpg', 'jpg'),
        f('中古侘寂沙发.cover.png', 'png'),
        f('中古侘寂沙发.d5a', 'd5a')
      ])
    ).toBe('d5a')
  })
})

// ── ② 回归：为什么没动 KIND_PRIORITY 顺序 ────────────────────────────

describe('primaryKind — 既有大类语义一字不改（防"调优先级"错修）', () => {
  it('真实模型包 + 贴图 ⇒ model（贴图不叫 .cover.*，必须继续参与判定）', () => {
    expect(primaryKind([f('沙发.skp', 'skp'), f('Textures/布纹.png', 'png')])).toBe('model')
  })

  it('真实模型包 + 贴图 + 自定义封面 ⇒ 仍是 model', () => {
    expect(
      primaryKind([
        f('沙发.cover.png', 'png'),
        f('沙发.skp', 'skp'),
        f('Textures/布纹.png', 'png')
      ])
    ).toBe('model')
  })

  it('PBR 材质包（同前缀 Albedo + Normal + Roughness）⇒ material', () => {
    const pack = [
      f('vh1sbjl_2K_Albedo.jpg', 'jpg'),
      f('vh1sbjl_2K_Normal.jpg', 'jpg'),
      f('vh1sbjl_2K_Roughness.jpg', 'jpg')
    ]
    expect(detectMaterialPack(pack)).not.toBeNull()
    expect(primaryKind(pack)).toBe('material')
  })

  it('PBR 材质包 + 自定义封面 ⇒ 仍是 material（剔除封面不该把三槽位也剔掉）', () => {
    const pack = [
      f('vh1sbjl_2K_Albedo.jpg', 'jpg'),
      f('vh1sbjl_2K_Normal.jpg', 'jpg'),
      f('vh1sbjl_2K_Roughness.jpg', 'jpg'),
      f('vh1sbjl_2K.cover.jpg', 'jpg')
    ]
    expect(primaryKind(pack)).toBe('material')
  })

  it('HDR 包 ⇒ hdri；HDR 包 + 封面 ⇒ 仍 hdri', () => {
    expect(primaryKind([f('天空.hdr', 'hdr'), f('天空.exr', 'exr')])).toBe('hdri')
    expect(primaryKind([f('天空.cover.jpg', 'jpg'), f('天空.hdr', 'hdr')])).toBe('hdri')
  })

  it('★纯材质资产 + .cover.jpg ⇒ 仍 texture（不能因为剔除封面被打飞）', () => {
    expect(primaryKind([f('大理石.jpg', 'jpg'), f('大理石.cover.jpg', 'jpg')])).toBe('texture')
    expect(primaryKind([f('大理石.jpg', 'jpg')])).toBe('texture')
  })

  it('CAD 包 + 贴图 + 封面 ⇒ cad（贴图不抢、封面也不抢）', () => {
    expect(
      primaryKind([
        f('平面图.cover.png', 'png'),
        f('预览.jpg', 'jpg'),
        f('平面图.dwg', 'dwg')
      ])
    ).toBe('cad')
  })

  it('★手工塞的非封面预览图仍压过 d5a ⇒ texture（KIND_PRIORITY 顺序未动的证据）', () => {
    // 与 tests/d5a.test.ts:344-346 同口径：预览.jpg 不带 .cover. 后缀，是真实贴图，
    // 不参与"附属封面免疫"，仍按既有优先级返回 texture。
    expect(
      primaryKind([
        { rel: '休闲椅.d5a', kind: 'd5a' },
        { rel: '预览.jpg', kind: 'texture' }
      ])
    ).toBe('texture')
    expect(isCoverAssetImage('预览.jpg')).toBe(false)
  })

  it('名字里带 cover 但不是受控后缀的文件不被剔除（x_cover.jpg / my-cover-photo.jpg）', () => {
    for (const rel of ['x_cover.jpg', 'my-cover-photo.jpg', 'cover.jpg']) {
      expect(isCoverAssetImage(rel)).toBe(false)
      expect(
        primaryKind([{ rel: 'x.d5a', kind: 'd5a' }, { rel, kind: 'texture' }])
      ).toBe('texture')
    }
  })

  it('空列表 ⇒ other（改动前后一致）', () => {
    expect(primaryKind([])).toBe('other')
  })
})

// ── ③ 边界：目录里只有一张封面、没有任何主文件 ──────────────────────────

describe('primaryKind — 只有封面的空壳目录（不打飞、行为与改动前一致）', () => {
  it('★只有 .cover.png ⇒ 不崩、不返回 other，行为与改动前一致（texture）', () => {
    const only = [f('只有封面.cover.png', 'png')]
    expect(() => primaryKind(only)).not.toThrow()
    expect(primaryKind(only)).toBe('texture')
    // 若为 'other'，assignCategory 会用 kindFolder('other')='其他' 拼目录 → 真实搬库
    expect(primaryKind(only)).not.toBe('other')
    expect(kindFolder('texture')).toBe('材质')
    expect(kindFolder('other')).toBe('其他')
  })

  it('只有 .cover.jpg 同样成立；两张封面（全被剔除）也仍 texture', () => {
    expect(primaryKind([f('只有封面.cover.jpg', 'jpg')])).toBe('texture')
    expect(
      primaryKind([f('只有封面.cover.jpg', 'jpg'), f('只有封面.cover.png', 'png')])
    ).toBe('texture')
  })

  it('只有封面时不含其它 kind，detectMaterialPack 也不会误判成 material', () => {
    const only = [f('只有封面.cover.png', 'png')]
    expect(detectMaterialPack(only)).toBeNull()
    expect(primaryKind(only)).not.toBe('material')
  })
})

// ── ④ 连带损害：mainFile 不能是封面 ────────────────────────────────────

describe('pickPrimaryFile — 附属封面不参与主文件判定', () => {
  it('★D5A + cover（封面排在前面）⇒ mainFile 回到 .d5a', () => {
    const files = d5aWithCover()
    expect(pickPrimaryFile(files)?.rel).toBe('中古侘寂沙发.d5a')
    expect(pickPrimaryFile([...files].reverse())?.rel).toBe('中古侘寂沙发.d5a')
    expect(pickPrimaryFile(files)?.rel).not.toContain('.cover.')
  })

  it('对照：D5A 只有整包自己 ⇒ 仍是 .d5a（退到 files[0] 的既有行为）', () => {
    const only = f('休闲椅.d5a', 'd5a')
    expect(pickPrimaryFile([only])).toBe(only)
  })

  it('不破坏 skp > max 优先（封面在最前也不抢）', () => {
    expect(
      pickPrimaryFile([
        f('沙发.cover.png', 'png'),
        f('沙发.max', 'max'),
        f('沙发.skp', 'skp')
      ])?.rel
    ).toBe('沙发.skp')
  })

  it('不破坏 CAD：纯 CAD 包里 .dwg 是主文件（预览图 + 封面都不抢）', () => {
    expect(
      pickPrimaryFile([
        f('封面.cover.png', 'png'),
        f('预览图.jpg', 'jpg'),
        f('平面图.dwg', 'dwg')
      ])?.rel
    ).toBe('平面图.dwg')
  })

  it('边界：只有一张封面时仍返回它（不是 undefined、不崩，与改动前一致）', () => {
    const only = f('只有封面.cover.png', 'png')
    expect(pickPrimaryFile([only])).toBe(only)
    expect(pickPrimaryFile([only])).not.toBeUndefined()
  })

  it('空列表 ⇒ undefined（改动前后一致）', () => {
    expect(pickPrimaryFile([])).toBeUndefined()
  })
})

// ── ⑤ 端到端：插件快照 index.json 里的 mainFile ───────────────────────

describe('buildPluginRecord — 插件快照 mainFile 不再被封面污染', () => {
  /** 最小但完整的 Asset（必填字段齐全；可选字段留空以贴近真实脏行） */
  function d5aAsset(files: AssetFile[]): Asset {
    return {
      id: 'd5a-kind-cover-0001',
      name: '中古侘寂沙发',
      kind: 'd5a',
      source: '本机',
      folder: 'E:\\Lib\\D5A\\未分类\\未分类\\中古侘寂沙发',
      relFolder: 'D5A/未分类/未分类/中古侘寂沙发',
      files,
      size: 8_229_266,
      tags: [],
      note: '',
      favorite: false,
      rating: 0,
      colorTag: null,
      dedupeKey: 'd5a:中古侘寂沙发',
      importedAt: 1,
      updatedAt: 1
    }
  }

  it('★封面排在 files[0] 时 mainFile 仍是 .d5a（真机脏值 mainFile:"…cover.png" 的反例）', () => {
    const record = buildPluginRecord(d5aAsset(d5aWithCover()))
    expect(record.kind).toBe('d5a')
    expect(record.mainFile).toBe('中古侘寂沙发.d5a')
    expect(record.mainFile).not.toContain('.cover.')
    // files[] 仍完整保留封面（剔除只发生在"判定"里，不删用户数据）
    expect(record.files.map((x) => x.rel)).toContain('中古侘寂沙发.cover.png')
  })

  it('files 为空 ⇒ mainFile 为 null（既有契约不回退）', () => {
    expect(buildPluginRecord(d5aAsset([])).mainFile).toBeNull()
  })
})

// ── ⑥ 源码守卫：修好后弹窗能拿到「模型」词表 + 自愈通道没被堵死 ───────

describe('源码守卫 · 分类词表与自愈路径', () => {
  it('★level1OptionsFor("d5a") 与 level1OptionsFor("model") 逐项相同（弹窗拿到模型词表）', () => {
    const model = level1OptionsFor('model')
    expect(model.length).toBeGreaterThan(0)
    const d5a = level1OptionsFor('d5a')
    expect(d5a).toEqual(model)
    expect(d5a).toContain('家具')
    // 反例：不能是材质合并词表（缺陷截图里的一级全是石材/砖材/木纹）
    expect(d5a).not.toEqual(level1OptionsFor('texture'))
  })

  it('KIND_PRIORITY 顺序原样未动（本批刻意不靠调顺序修）', () => {
    const src = read('src/shared/classify.ts')
    expect(src).toContain(
      "const KIND_PRIORITY: AssetKind[] = ['model', 'cad', 'material', 'hdri', 'texture', 'd5a', 'other']"
    )
  })

  it('primaryKind 与 pickPrimaryFile 都走同一个 withoutProgramCovers 判定集', () => {
    const src = read('src/shared/classify.ts')
    expect(src).toContain('function withoutProgramCovers')
    const pk = src.slice(src.indexOf('export function primaryKind'))
    expect(pk.slice(0, 400)).toContain('withoutProgramCovers(files)')
    const ppf = src.slice(src.indexOf('export function pickPrimaryFile'))
    expect(ppf.slice(0, 400)).toContain('withoutProgramCovers(files)')
  })

  it('★自愈通道仍在：rescan 调 primaryKind(files)、store 合并仍是 kind: s.kind', () => {
    // 用户点一次「刷新 / 重新扫描库」→ rescan 重算 kind='d5a' → 合并写回 Dexie。
    // 若有人给合并加"保护旧 kind"，存量那条 texture 就永远修不回来。
    const rescan = read('src/main/rescan.ts')
    expect(rescan).toContain('primaryKind(files)')
    const store = read('src/renderer/store.ts')
    expect(store).toContain('kind: s.kind')
  })

  it('显示口径：d5a 落盘/显示都是 D5A（不是材质/贴图）', () => {
    expect(kindFolder('d5a')).toBe('D5A')
    expect(KIND_LABEL.d5a).toBe('D5A')
    expect(kindFolder('texture')).toBe('材质')
    expect(KIND_LABEL.texture).toBe('贴图')
  })
})
