/**
 * DEF-01 真正的根因回归：**Unix 制作的 GBK zip**
 *
 * 背景（2026-10-29 真机验收第一次暴露）：
 * 用户真实包 `生态主题餐厅工装平面图ID_1152305168.zip` 导入后文件名全是方块乱码。
 * 逐层定位后发现两个独立缺陷，缺一不可：
 *
 * ① **乱码嗅探认不出这种乱码** —— 7-Zip 对「Unix 制作的 zip（中央目录 madeBy 高字节 = 3）
 *    + 无 UTF-8 flag」会**假定文件名是 UTF-8**，解 GBK 字节失败后把解不出的字节写进
 *    **私用区 PUA（U+E000–U+F8FF）**。老的可疑字符类只覆盖拉丁扩展，PUA 一个都不在 →
 *    `ratio = 0`、`hasReplacement = false` → `isScanMojibake` 为假 →
 *    **换码页重解与 adm-zip 兜底两条路一次都没执行**（"三种配置全乱码"的真因：
 *    不是三种都失败，是三种都走不到）。
 * ② **`-mcp=GBK` 不是合法参数** —— 7-Zip 23.01 只认数字码页，`-mcp=GBK` 会让整条命令
 *    退化成 `Can't open as archive`；必须 `-mcp=936`。
 *
 * 本文件用 fixture 复刻 ①（`buildZip(..., { madeByOs: 3 })`），断言整条链能自己救回来。
 * 对照组 `madeByOs: 0`（DOS 制作）= 裸参数本来就对，覆盖"别把正常包也重解两遍"。
 *
 * ⚠️ 依赖真 7-Zip（`MODVAULT_7Z` 或默认安装路径）；没有就 skip —— **绝不**拿
 * `C:/Users/.../Downloads` 里的真包做单测（换机器必红）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractArchive } from '../src/main/extractor'
import { DEFAULT_CONCURRENCY, importPaths, type ImportDeps } from '../src/main/importer'
import type { Asset } from '../src/shared/types'
import { buildZip, zipEntry } from './fixtures/gbkZip'

const SEVEN_ZIP = process.env.MODVAULT_7Z || 'C:/Program Files/7-Zip/7z.exe'
const has7z = existsSync(SEVEN_ZIP)

const tmpRoots: string[] = []

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-gbkunix-'))
  tmpRoots.push(d)
  return d
}

afterEach(async () => {
  for (const d of tmpRoots.splice(0)) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 递归列相对路径（posix） */
async function walk(d: string, base = d, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    out.push(path.relative(base, p).split(path.sep).join('/'))
    if (e.isDirectory()) await walk(p, base, out)
  }
  return out.sort()
}

/** 真机那个包的三类文件：正经 dwg + 知末扫码广告 jpg + 说明 txt（后两个是 junk） */
const FILES: Array<[string, Buffer]> = [
  ['餐厅平面设计方案.dwg', Buffer.from('AC1032-fake-dwg-bytes')],
  ['微信扫码 看案例找灵感下素材必用知末.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
  ['知末网说明.txt', Buffer.from('说明文本', 'utf8')]
]

/** 造包：GBK 文件名 + 不置 UTF-8 flag；madeByOs 决定 7-Zip 走哪条解码分支 */
function gbkZip(opts: { madeByOs: number }): Buffer {
  return buildZip(
    FILES.map(([name, body]) => zipEntry(name, body)),
    { madeByOs: opts.madeByOs }
  )
}

async function extractZip(
  madeByOs: number,
  over: { maxBytesForJsFallback?: number } = {}
): Promise<{ names: string[]; result: Awaited<ReturnType<typeof extractArchive>> }> {
  const root = await tmpDir()
  const zip = path.join(root, `p${madeByOs}.zip`)
  const dest = path.join(root, 'out')
  await fs.writeFile(zip, gbkZip({ madeByOs }))
  const result = await extractArchive(zip, dest, {
    sevenZipPath: SEVEN_ZIP,
    codepage: 'auto',
    timeoutMs: 60_000,
    maxBytesForJsFallback: over.maxBytesForJsFallback ?? 200 * 1024 * 1024
  })
  return { names: await walk(dest), result }
}

describe('extractArchive — Unix 制作的 GBK zip（DEF-01 根因回归）', () => {
  it.skipIf(!has7z)(
    'madeBy os=3：裸 7z 解成 PUA 乱码 → 嗅探命中 → -mcp=936 重解 → 文件名逐字正确',
    async () => {
      // `maxBytesForJsFallback: 1` 是**故意**的：把 adm-zip 兜底掐死，只留 `-mcp=936` 一条救法。
      // 不这么设的话，`-mcp` 参数写错也会被 adm-zip 悄悄救回来（本用例就测不出参数对不对）。
      const { names, result } = await extractZip(3, { maxBytesForJsFallback: 1 })
      // 逐字正确（不是"看起来像"）
      expect(names).toEqual(['餐厅平面设计方案.dwg', '微信扫码 看案例找灵感下素材必用知末.jpg', '知末网说明.txt'].sort())
      // 走的是兜底重解那条路：codepage 标 gbk，且最终不再标乱码
      expect(result.codepage).toBe('gbk')
      expect(result.mojibake).toBe(false)
      expect(result.suspiciousRatio).toBe(0)
    }
  )

  it.skipIf(!has7z)(
    '对照：madeBy os=0（DOS 制作）→ 裸参数本来就对，不该白跑一次重解',
    async () => {
      const { names, result } = await extractZip(0)
      expect(names).toEqual(['餐厅平面设计方案.dwg', '微信扫码 看案例找灵感下素材必用知末.jpg', '知末网说明.txt'].sort())
      expect(result.codepage).toBe('acp')
      expect(result.mojibake).toBe(false)
    }
  )

  it.skipIf(!has7z)(
    '连带伤害修复：乱码不再是 junk 过滤失效的原因 —— 扫码 jpg / 说明 txt 不进 files',
    async () => {
      const root = await tmpDir()
      const lib = path.join(root, 'Library')
      await fs.mkdir(lib, { recursive: true })
      const zip = path.join(root, 'pkg.zip')
      await fs.writeFile(zip, gbkZip({ madeByOs: 3 }))

      const deps: ImportDeps = {
        libraryDir: lib,
        sevenZipPath: SEVEN_ZIP,
        archiveDisposal: 'keep',
        defaultSource: '本机',
        codepage: 'auto',
        timeoutMs: 60_000,
        maxBytesForJsFallback: 200 * 1024 * 1024,
        spaceSafetyFactor: 1.2,
        concurrency: DEFAULT_CONCURRENCY,
        emit: () => {}
      }
      const assets = await importPaths([zip], deps)
      expect(assets.length).toBe(1)
      const a: Asset = assets[0]!
      expect(a.kind).toBe('cad')
      // 名字可读（junk 规则才可能命中）
      expect(a.files.map((f) => f.name)).toEqual(['餐厅平面设计方案.dwg'])
      expect(a.files.some((f) => /扫码|说明|\.html$|\.txt$/i.test(f.name))).toBe(false)
      // 物理文件里：junk 文件仍在（本产品只"不进索引"、不删用户文件 —— 既有行为，不是本缺陷）
      const onDisk = await walk(a.folder)
      expect(onDisk).toContain('餐厅平面设计方案.dwg')
    }
  )
})
