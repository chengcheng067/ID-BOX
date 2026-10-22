import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rescanLibrary, type IgnoredReason } from '../src/main/rescan'
import { isKnownLevel1 } from '../src/shared/taxonomy'

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-rescan-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 造一个 4 段资产目录：模型/未分类/未分类/现代衣柜 */
async function makeAsset(
  lib: string,
  kind: string,
  cat1: string,
  cat2: string,
  name: string,
  files: Record<string, Buffer | string>
): Promise<string> {
  const dir = path.join(lib, kind, cat1, cat2, name)
  await fs.mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'))
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content)
  }
  return dir
}

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const SKP = Buffer.concat([
  Buffer.from([0xff, 0xfe, 0xff, 0x0e]),
  Buffer.from('SketchUp Model {24.0.594}', 'utf16le')
])

describe('rescanLibrary —— 固定四层纯路径解析（06 §11.2，零启发式）', () => {
  it('四层布局产出正确：kind / category1 / category2 / relFolder / name', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '模型', '未分类', '未分类', '现代衣柜', {
      '预览图.jpg': IMG,
      '贴图/木纹.jpg': IMG,
      '现代衣柜.skp': SKP
    })
    await makeAsset(lib, '模型', '家具', '沙发', '北欧布艺沙发', { 'a.skp': SKP })
    await makeAsset(lib, '材质', '石材', '水磨石', '木纹 01', { 'b.jpg': IMG })

    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(3)

    const byRel = new Map(assets.map((a) => [a.relFolder, a]))
    const a1 = byRel.get('模型/未分类/未分类/现代衣柜')!
    expect(a1).toBeTruthy()
    expect(a1.kind).toBe('model')
    expect(a1.category1).toBe('未分类')
    expect(a1.category2).toBe('未分类')
    expect(a1.name).toBe('现代衣柜')
    expect(a1.folder).toBe(path.join(lib, '模型', '未分类', '未分类', '现代衣柜'))

    const a2 = byRel.get('模型/家具/沙发/北欧布艺沙发')!
    expect(a2).toBeTruthy()
    expect(a2.category1).toBe('家具')
    expect(a2.category2).toBe('沙发')
    // kind 由 primaryKind(files) 决定，不由目录决定
    expect(a2.kind).toBe('model')

    const a3 = byRel.get('材质/石材/水磨石/木纹 01')!
    expect(a3).toBeTruthy()
    // 钉住"kind 由内容定、不由目录定"：目录名「材质」对两个 kind 有歧义，kind 仍必须正确
    expect(a3.kind).toBe('texture')
    expect(a3.category1).toBe('石材')
    expect(a3.category2).toBe('水磨石')

    // 每个 id 都是 UUID
    for (const a of assets) {
      expect(a.id).toMatch(/^[0-9a-f-]{36}$/i)
    }
  })

  it('category1/category2 直接取磁盘目录名，不做清洗（用户手工命名照抄）', async () => {
    const lib = await tmpDir()
    // Windows 不允许目录名含 * 等非法字符，所以"脏名字"只能用合法但会被
    // normalizeCategoryPair 改写的形态：段内空格 / 非词表值。rescan 一律照抄不清洗。
    await makeAsset(lib, '模型', '自定义 分类', '二级 名', 'a', { 'a.png': IMG })
    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(1)
    expect(assets[0]!.category1).toBe('自定义 分类')
    expect(assets[0]!.category2).toBe('二级 名')
    // 词表外的值也照抄（rescan 不查词表，词表只用于"建议"）
    expect(isKnownLevel1('自定义 分类')).toBe(false)
  })

  it('.staging 与 . 开头目录跳过；空分类目录不产出资产', async () => {
    const lib = await tmpDir()
    await fs.mkdir(path.join(lib, '.staging', 'x'), { recursive: true })
    await makeAsset(lib, '.staging', '未分类', '未分类', '不应出现', { 'a.png': IMG })
    await makeAsset(lib, '.隐藏', '未分类', '未分类', '不应出现2', { 'a.png': IMG })
    await makeAsset(lib, '模型', '空分类', '空二级', '占位', {})
    await fs.rmdir(path.join(lib, '模型', '空分类', '空二级', '占位'))

    const ignored: Array<{ rel: string; reason: IgnoredReason }> = []
    const { assets } = await rescanLibrary(lib, { onIgnored: (rel, r) => ignored.push({ rel, reason: r }) })
    expect(assets.length).toBe(0)
    expect(ignored).toEqual([])
  })
})

describe('rescanLibrary —— 结构符合性检查 + 忽略上报（06 §12.3 RA6）', () => {
  it('深度不符（遗留两段布局、用户手工散装目录）→ onIgnored(depth) 且不产出', async () => {
    const lib = await tmpDir()
    // 遗留两段布局：<大类>/<资产名>
    const legacy = path.join(lib, '模型', '某沙发')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, '预览图.jpg'), IMG)
    // 用户手工拖进来的散装三层
    const loose = path.join(lib, '贴图', '布纹', '某贴图包')
    await fs.mkdir(loose, { recursive: true })
    await fs.writeFile(path.join(loose, 'b.jpg'), IMG)
    // 正常四层（对照）
    await makeAsset(lib, '模型', '未分类', '未分类', '正常资产', { 'a.skp': SKP })

    const ignored: Array<{ rel: string; reason: IgnoredReason }> = []
    const { assets } = await rescanLibrary(lib, { onIgnored: (rel, r) => ignored.push({ rel, reason: r }) })

    expect(assets.length).toBe(1)
    expect(assets[0]!.relFolder).toBe('模型/未分类/未分类/正常资产')
    expect(ignored).toContainEqual({ rel: '模型/某沙发', reason: 'depth' })
    expect(ignored).toContainEqual({ rel: '贴图/布纹/某贴图包', reason: 'depth' })
  })

  it('期望目录的位置上出现文件 → onIgnored(not-dir)', async () => {
    const lib = await tmpDir()
    await fs.mkdir(path.join(lib, '模型', '未分类'), { recursive: true })
    await fs.writeFile(path.join(lib, '模型', '未分类', '说明.txt'), 'hello')
    await makeAsset(lib, '模型', '未分类', '未分类', '正常资产', { 'a.skp': SKP })

    const ignored: Array<{ rel: string; reason: IgnoredReason }> = []
    const { assets } = await rescanLibrary(lib, { onIgnored: (rel, r) => ignored.push({ rel, reason: r }) })

    expect(assets.length).toBe(1)
    expect(ignored).toContainEqual({ rel: '模型/未分类/说明.txt', reason: 'not-dir' })
  })

  it('库目录不存在 → 返回 []，不抛错', async () => {
    const { assets } = await rescanLibrary('X:\\不存在的库目录\\xxx')
    expect(assets).toEqual([])
  })

  it('T08：ignored 清单随返回值回传（onIgnored 与返回值同时可用）', async () => {
    const lib = await tmpDir()
    const legacy = path.join(lib, '模型', '某沙发')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, '预览图.jpg'), IMG)
    await fs.mkdir(path.join(lib, '模型', '未分类'), { recursive: true })
    await fs.writeFile(path.join(lib, '模型', '未分类', '说明.txt'), 'x')
    await makeAsset(lib, '模型', '未分类', '未分类', '正常资产', { 'a.skp': SKP })

    const { assets, ignored } = await rescanLibrary(lib)
    expect(assets.length).toBe(1)
    // 顺序：先扫 模型 的一级目录（说明.txt 在此报 not-dir），再逐个下钻（某沙发在此报 depth）
    expect(ignored).toEqual([
      { relPath: '模型/未分类/说明.txt', reason: 'not-dir' },
      { relPath: '模型/某沙发', reason: 'depth' }
    ])
  })

  it('不传 onIgnored 也能安全跳过（回调可选），ignored 仍进返回值', async () => {
    const lib = await tmpDir()
    const legacy = path.join(lib, '模型', '散装')
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'a.jpg'), IMG)
    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(0)
  })
})

describe('rescanLibrary —— 材质大类合并的兼容性（docs/14 §2.1 / §2.6）', () => {
  const VISMAT = Buffer.from('vismat preset bytes')

  it('旧库目录名（贴图/、材质预设/）仍能被正常索引，kind 反解正确', async () => {
    const lib = await tmpDir()
    // 旧库未迁移：两个历史大类目录并存
    await makeAsset(lib, '贴图', '石材', '水磨石', '旧贴图', { 'a.jpg': IMG })
    // 只有未知扩展名文件 → primaryKind 判不出 → 走目录名反查（历史别名）
    // （注意不能用 .txt：它是 junk 扩展名，会被 walkFiles 过滤掉）
    await makeAsset(lib, '贴图', '未分类', '未分类', '旧贴图说明包', { 'payload.bin': 'x' })
    await makeAsset(lib, '材质预设', '未分类', '未分类', '旧材质', { 'preset.vismat': VISMAT })

    const { assets, ignored } = await rescanLibrary(lib)
    expect(ignored).toEqual([])
    expect(assets.length).toBe(3)

    const byRel = new Map(assets.map((a) => [a.relFolder, a]))
    expect(byRel.get('贴图/石材/水磨石/旧贴图')!.kind).toBe('texture')
    // 「贴图」是历史别名 → 反解 texture（旧行为：只有说明文件的散装包不会被判成 other）
    expect(byRel.get('贴图/未分类/未分类/旧贴图说明包')!.kind).toBe('texture')
    expect(byRel.get('材质预设/未分类/未分类/旧材质')!.kind).toBe('material')
  })

  it('新目录「材质」+ 内容判不出 → 兜底 texture（不抛错、不丢资产）', async () => {
    const lib = await tmpDir()
    // 未知扩展名（.bin 不在 EXT_KIND，且不是 junk）→ primaryKind === 'other'
    await makeAsset(lib, '材质', '未分类', '未分类', '只有说明', { 'payload.bin': 'x' })
    await makeAsset(lib, '材质', '未分类', '未分类', '真材质', { 'preset.vismat': VISMAT })

    const { assets } = await rescanLibrary(lib)
    expect(assets.length).toBe(2)
    const byRel = new Map(assets.map((a) => [a.relFolder, a]))
    // 内容判不出 → kindFromFolderName('材质') === null → 兜底 'texture'
    expect(byRel.get('材质/未分类/未分类/只有说明')!.kind).toBe('texture')
    // 内容判得出 → 由扩展名决定，不被目录名带偏
    expect(byRel.get('材质/未分类/未分类/真材质')!.kind).toBe('material')
  })

  it('三目录共存（旧两目录 + 新「材质」）都能索引：迁移前的完全可用态', async () => {
    const lib = await tmpDir()
    await makeAsset(lib, '贴图', '石材', '水磨石', 'a', { 'a.jpg': IMG })
    await makeAsset(lib, '材质预设', '未分类', '未分类', 'b', { 'b.vismat': VISMAT })
    await makeAsset(lib, '材质', '金属', '金属板', 'c', { 'c.jpg': IMG })

    const { assets, ignored } = await rescanLibrary(lib)
    expect(ignored).toEqual([])
    expect(assets.length).toBe(3)
    expect(assets.map((a) => a.kind).sort()).toEqual(['material', 'texture', 'texture'])
    // relFolder 原样保留（rescan 不重写首段，迁移是独立动作）
    expect(new Set(assets.map((a) => a.relFolder.split('/')[0]))).toEqual(
      new Set(['贴图', '材质预设', '材质'])
    )
  })
})
