/**
 * 一键打包 T5「入口、说明与端到端收口」的**接线守卫**（docs/58 §T5 + docs/57 §6 F-1/F-2/F-3）。
 *
 * 为什么不跑运行时：`vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL
 * （既定选择，不引入）。所以「设置卡只剩一个入口 / 弹窗按库里实际大类生成勾选项 /
 * 失败原因不再被硬翻译成磁盘不足 / App 有没有真的挂弹窗」只能靠读源码文本断言 ——
 * 与 `tests/zhimoCoverWiring.test.ts` / `tests/inboxWiring.test.ts` 同一套 `readSrc()` 范式。
 * 每条守卫都对应一个**具体的退化形态**，写在各自注释里。
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 相对仓库根读源码；换行统一成 `\n`（工作区是 CRLF，逐行/切片断言用 `\n` 定位） */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 取两个锚点之间的源码片段（锚点缺失直接让断言红，不静默返回空串） */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `源码里找不到起始锚点：${from}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(to, start + from.length)
  expect(end, `源码里找不到结束锚点：${to}`).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('设置「素材打包」卡：F-1 收成唯一一个入口按钮', () => {
  const src = readSrc('src/renderer/components/SettingsDialog.tsx')

  it('只从 store 取 openPackageDialog（导入动作不再在设置页暴露）', () => {
    expect(src).toContain('useVault((s) => s.openPackageDialog)')
    expect(src).not.toContain('useVault((s) => s.pickPackageImport)')
  })

  it('「素材打包」卡只有一个 SettingsRow / 一个「素材打包与同步」按钮', () => {
    const card = sliceBetween(src, 'title="素材打包"', '{/* 一键重扫 · 从知末获取封面')
    expect(card).toContain('title="素材打包与同步"')
    expect(card.match(/<SettingsRow/g)?.length ?? 0).toBe(1)
    expect(card.match(/<button/g)?.length ?? 0).toBe(1)
    // 两个旧按钮文案都不能再出现在设置页（导入功能保留在弹窗内）
    expect(card).not.toContain('打包本地素材')
    expect(card).not.toContain('导入素材包')
  })

  it('唯一入口按钮触发 openPackageDialog', () => {
    expect(src).toMatch(/onClick=\{\(\) => openPackageDialog\(\)\}/)
  })

  it('入口文案说清「弹窗里可选导出或导入」，且零内部词 / 零网络词', () => {
    const card = sliceBetween(src, 'title="素材打包"', '{/* 一键重扫 · 从知末获取封面')
    expect(card).toContain('可选导出或导入')
    for (const word of ['sha256', 'SHA256', 'sha-256', 'apiVersion', 'relFolder', 'path', 'zip', '7z']) {
      expect(card, `素材打包卡用户可见文案不应出现内部词：${word}`).not.toContain(word)
    }
    for (const word of ['网盘', '云盘', '上传', 'http', 'API', '在线同步', '自动同步']) {
      expect(card, `素材打包卡用户可见文案不应出现网络词：${word}`).not.toContain(word)
    }
  })

  it('弹窗内仍保留导入入口（F-1 只收设置页，不丢功能）', () => {
    const dlg = readSrc('src/renderer/components/PackageDialog.tsx')
    expect(dlg).toContain('pickPackageImport')
    expect(dlg).toContain('从素材包导入')
  })
})

describe('App 根挂载：一键打包弹窗全应用只挂一个实例', () => {
  const src = readSrc('src/renderer/App.tsx')

  it('import 了 PackageDialog 组件', () => {
    expect(src).toContain("import { PackageDialog } from './components/PackageDialog'")
  })

  it('与其它 Modal 同级挂载 <PackageDialog />，且只挂一次（多份会有两个 Esc 层）', () => {
    expect(src).toContain('<PackageDialog />')
    expect(src.match(/<PackageDialog \/>/g)?.length ?? 0).toBe(1)
  })

  it('弹窗内部自管 Esc 层与 z-index（App 不额外包一层监听）', () => {
    const dlg = readSrc('src/renderer/components/PackageDialog.tsx')
    expect(dlg).toContain('useEscLayer')
    expect(dlg).toContain('zClassForDepth')
  })
})

describe('F-2：导出选项按库里实际大类动态生成', () => {
  const dlg = readSrc('src/renderer/components/PackageDialog.tsx')

  it('从 store 的 assets 计算可用大类，并排除软删记录', () => {
    expect(dlg).toContain('useVault((s) => s.assets)')
    expect(dlg).toContain('isDeletedAsset(asset)')
    expect(dlg).toContain('PACKAGE_KIND_ORDER.filter((kind) => present.has(kind))')
  })

  it('勾选项由 availableKinds.map 动态渲染：库里没有的大类不显示该项', () => {
    expect(dlg).toContain('availableKinds.map((kind) => (')
    expect(dlg).toContain('label={packageKindLabel(kind)}')
    expect(dlg).not.toContain('带上环境光贴图')
    expect(dlg).not.toContain('环境光贴图')
  })

  it('HDR 就显示「HDR」，其它大类沿用 KIND_LABEL', () => {
    expect(dlg).toContain("const PACKAGE_KIND_LABEL: Partial<Record<AssetKind, string>> = { hdri: 'HDR' }")
    expect(dlg).toContain('KIND_LABEL[kind]')
  })

  it('空选时禁用导出按钮并给出单行提示（不打空包）', () => {
    expect(dlg).toContain('includedKinds.length === 0')
    expect(dlg).toContain('请至少选择一个大类再导出')
  })

  it('导出调用传 includedKinds，不再出现 includeHdri', () => {
    expect(dlg).toContain('exportPackage({ includedKinds, includePersonalSettings })')
    expect(dlg).not.toContain('includeHdri')
  })
})

describe('F-3：真实错误文案透传 + 主进程补日志', () => {
  const store = readSrc('src/renderer/store.ts')
  const dlg = readSrc('src/renderer/components/PackageDialog.tsx')
  const main = readSrc('src/main/index.ts')

  it('store 不再写「请检查磁盘空间」，主进程 reason 原样保留；仅非 IPC 异常用中性文案', () => {
    const body = sliceBetween(store, 'async exportPackage(opts)', 'async pickPackageImport()')
    expect(body).not.toContain('请检查磁盘空间')
    expect(body).not.toContain('磁盘空间不足')
    expect(body).toContain("set({ packageError: result.error || '导出失败，请重试' })")
    expect(body).toContain("set({ packageError: '导出失败，请重试' })")
  })

  it('UI 删掉按空间/磁盘关键词硬翻译，带可行动数字的原因原样单行显示', () => {
    expect(dlg).not.toContain("message.includes('空间')")
    expect(dlg).not.toContain("message.includes('磁盘')")
    expect(dlg).not.toContain('磁盘空间不足，请清理后再试')
    expect(dlg).toContain('/需要约|可用/.test(message)')
    // 中性展示时仍把真实原因放进 title，不吞掉
    expect(dlg).toContain('title={rawError ?? undefined}')
  })

  it('主进程 result.error 分支与 catch 都写 package:export-failed 日志且带 destPath', () => {
    expect((main.match(/logError\('package:export-failed'/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(main).toContain('destPath: input.destPath')
    expect(main).toContain('includedKinds: input.includedKinds')
  })
})

describe('端到端通道链：入口最终触发的 IPC 通道逐字存在', () => {
  it('shared/ipc.ts 定义 packageExportPick / packageImportPick 两条通道名', () => {
    const ipc = readSrc('src/shared/ipc.ts')
    expect(ipc).toContain("packageExportPick: 'package:exportPick'")
    expect(ipc).toContain("packageImportPick: 'package:importPick'")
  })

  it('store.exportPackage → packageExportPick（package:exportPick）', () => {
    const store = readSrc('src/renderer/store.ts')
    const body = sliceBetween(store, 'async exportPackage(opts)', 'async pickPackageImport()')
    expect(body).toContain('window.modvault.packageExportPick()')
    expect(body).toContain('includedKinds.includes(a.kind)')
  })

  it('store.pickPackageImport → packageImportPick（package:importPick）', () => {
    const store = readSrc('src/renderer/store.ts')
    const body = sliceBetween(store, 'async pickPackageImport()', 'confirmPackageImport: () =>')
    expect(body).toContain('window.modvault.packageImportPick()')
  })
})

describe('README：C 方案说明 + 网盘承诺守卫 + 隐私行逐字', () => {
  const raw = readSrc('README.md')
  const lines = raw.split('\n')

  it('含 C 方案说明词（手动打包搬运 + 库目录放进同步文件夹）', () => {
    expect(raw).toContain('跨机同步')
    expect(raw).toContain('打包本地素材')
    expect(raw).toContain('导入素材包')
    expect(raw).toContain('Syncthing')
    expect(raw).toContain('绿联 NAS')
    expect(raw).toContain('同步文件夹')
    expect(raw).toContain('ID BOX 只读取这个目录')
  })

  it('无任何网盘直连 / 云 API 支持承诺（守卫「百度网盘支持」「阿里云盘支持」命中 0）', () => {
    for (const phrase of [
      '百度网盘支持',
      '阿里云盘支持',
      '百度网盘',
      '阿里云盘',
      '网盘 API',
      '网盘API',
      '云盘 API',
      '网盘直连'
    ]) {
      expect(raw, `README 不应出现网盘 / 云 API 承诺：${phrase}`).not.toContain(phrase)
    }
  })

  it('README:350 隐私行逐字未动', () => {
    // 第 350 行（1-based）= 索引 349；C 方案新段插在它之后，本行必须一字不改。
    expect(lines[349]).toBe('- 不收集遥测，不上传任何素材或路径')
  })

  it('隐私段落「只在本机 / 不上传」的口径没有被 C 方案说明冲淡', () => {
    const privacy = sliceBetween(raw, '## 数据与隐私', '## 跨机同步')
    expect(privacy).toContain('不收集遥测，不上传任何素材或路径')
    expect(privacy).not.toContain('网盘')
  })
})
