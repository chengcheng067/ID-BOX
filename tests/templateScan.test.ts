/**
 * 拖入文件夹自动识别 —— 扫描器单测 + IPC 三处同改守卫 + 预览确认流源码守卫
 * （v1.2 反馈批 C；范式 = projectWiring.test.ts / projectTemplate.test.ts）。
 *
 * | # | 覆盖 | 防的退化 |
 * |---|------|----------|
 * | 1 | scanTemplateFromDir 纯转换（假 io 目录树 → 模板树） | 清洗 / 限额逻辑被复制漂移 |
 * | 2 | 跳过文件 / 符号链接 / 隐藏目录（.git 等） | 把无关内容扫进模板 |
 * | 3 | 深度 4 剪枝 + 多探一层统计 / 256 节点截断统计 | 丢弃数静默丢失 |
 * | 4 | 错误分支（不存在 / 是文件 / 无权限 / 空目录 / 坏入参） | 错误收口变成 reject |
 * | 5 | 纯只读：源码无任何写盘调用 | 扫描通道变写通道 |
 * | 6 | IPC 三处同改（ipc.ts / preload / main） | ipc.ts:3 铁律破坏 |
 * | 7 | 预览确认流源码守卫（拖入 / stopPropagation / 预览层 / 生成按钮） | 静默写入 / 拖入被吞 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  MAX_TEMPLATE_DEPTH,
  MAX_TEMPLATE_NODES,
  countTemplateNodes,
  templateDepth
} from '../src/shared/projectTemplate'
import {
  SCAN_MAX_DIRS,
  scanTemplateFromDir,
  type TemplateScanDirent,
  type TemplateScanIo
} from '../src/main/templateScan'
import type { ProjectTemplateNode } from '../src/shared/types'

// ── 假文件系统（内存目录树 → TemplateScanIo） ───────────────────────────────

/** 假目录树节点：dir（可带 children）/ file / symlink */
type FakeItem =
  | { type: 'dir'; name: string; children?: FakeItem[] }
  | { type: 'file'; name: string }
  | { type: 'symlink'; name: string }

/** 以 `/` 为分隔的内存路径表：目录路径 → 目录项列表；文件路径单独记录 */
function buildFakeFs(root: FakeItem): {
  io: TemplateScanIo
  rootPath: string
} {
  const dirs = new Map<string, TemplateScanDirent[]>()
  const files = new Set<string>()
  const walk = (node: FakeItem, parent: string): void => {
    const p = parent ? `${parent}/${node.name}` : node.name
    if (node.type === 'dir') {
      const children = node.children ?? []
      dirs.set(
        p,
        children.map((c) => ({
          name: c.name,
          isDirectory: c.type === 'dir',
          isSymbolicLink: c.type === 'symlink'
        }))
      )
      for (const c of children) {
        if (c.type === 'dir') walk(c, p)
        else files.add(`${p}/${c.name}`)
      }
    } else {
      files.add(p)
    }
  }
  walk(root, '')
  return {
    rootPath: root.name,
    io: {
      statIsDirectory: (p) => {
        // Windows 上被测代码用 path.join（`\` 分隔），内存树键用 `/` —— 归一后比对
        const key = p.replace(/\\/g, '/')
        if (dirs.has(key)) return true
        if (files.has(key)) return false
        return null
      },
      readdir: (p) => {
        const entries = dirs.get(p.replace(/\\/g, '/'))
        if (!entries) {
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
        }
        return entries
      }
    }
  }
}

const dir = (name: string, children?: FakeItem[]): FakeItem => ({ type: 'dir', name, children })
const file = (name: string): FakeItem => ({ type: 'file', name })
const link = (name: string): FakeItem => ({ type: 'symlink', name })

// ════════════════════════════════════════════════════════════════════════════
// ① 纯转换：目录树 → 模板树
// ════════════════════════════════════════════════════════════════════════════

describe('scanTemplateFromDir — 目录树 → 模板树转换', () => {
  it('嵌套目录转成同构树；scannedDirs 含根；truncated 全 0', () => {
    const fsx = buildFakeFs(
      dir('公司模板', [
        dir('01-方案', [dir('1.1-参考资料'), dir('1.2-效果图')]),
        dir('02-施工图', [dir('2.1-图纸')])
      ])
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.name).toBe('公司模板')
    expect(r.root.children?.map((c) => c.name)).toEqual(['01-方案', '02-施工图'])
    expect(r.root.children?.[0].children?.map((c) => c.name)).toEqual(['1.1-参考资料', '1.2-效果图'])
    expect(r.scannedDirs).toBe(6) // 根 + 2 + 3
    expect(r.truncated).toEqual({ depth: 0, nodes: 0 })
    // 叶子不带空 children 键（落档形状干净）
    expect('children' in (r.root.children![0].children![0] as ProjectTemplateNode)).toBe(false)
  })

  it('根名与子目录名过 sanitizeName 清洗（非法字符 → 下划线，唯一实现收口）', () => {
    const fsx = buildFakeFs(
      dir('模板<测试>', [dir('方案:一'), dir('正常')])
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.name).toBe('模板_测试_')
    expect(r.root.children?.map((c) => c.name)).toEqual(['方案_一', '正常'])
  })

  it('兄弟清洗后重名自动去重（-2），与归一化同一口径', () => {
    // 尾随空格清洗后与兄弟「照片」撞名 → uniqueName -2
    const fsx = buildFakeFs(dir('相册', [dir('照片 '), dir('照片')]))
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.children?.map((c) => c.name)).toEqual(['照片', '照片-2'])
  })

  it('子目录读不了（权限/竞态）→ 单项降级当叶子，不拖垮整棵', () => {
    const fsx = buildFakeFs(dir('根', [dir('好的', [dir('孙子')]), dir('读不了')]))
    // 把「读不了」从目录表里挖掉 → readdir 抛错
    fsx.io.readdir = (p) => {
      if (p.replace(/\\/g, '/').endsWith('/读不了')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      return buildFakeFs(dir('根', [dir('好的', [dir('孙子')]), dir('读不了')])).io.readdir(p)
    }
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const names = r.root.children?.map((c) => c.name) ?? []
    expect(names).toHaveLength(2)
    expect(names).toContain('好的')
    expect(names).toContain('读不了')
    const good = (r.root.children ?? []).find((c) => c.name === '好的')
    expect(good?.children?.[0].name).toBe('孙子')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② 跳过：文件 / 符号链接 / 隐藏目录
// ════════════════════════════════════════════════════════════════════════════

describe('scanTemplateFromDir — 跳过文件 / 符号链接 / 隐藏目录', () => {
  it('文件与符号链接一律跳过；.git / .vscode 等隐藏目录跳过', () => {
    const fsx = buildFakeFs(
      dir('公司模板', [
        file('说明.txt'),
        link('快捷方式'),
        dir('.git', [dir('objects')]),
        dir('.vscode'),
        dir('方案')
      ])
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.root.children?.map((c) => c.name)).toEqual(['方案'])
    expect(r.scannedDirs).toBe(2) // 根 + 方案（.git 未下钻不计数）
  })

  it('只剩隐藏目录 / 文件时按空目录拒绝（没有可识别的子文件夹）', () => {
    const fsx = buildFakeFs(dir('只有隐藏', [dir('.git'), file('a.txt')]))
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('没有子文件夹')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 深度 4 剪枝 + 多探一层统计 / 256 节点截断统计 / 扫描硬上限
// ════════════════════════════════════════════════════════════════════════════

describe('scanTemplateFromDir — 限额与丢弃统计', () => {
  it('深度 4 封顶（根记 1）：第 5 层目录被剪，truncated.depth 统计被剪数量', () => {
    const fsx = buildFakeFs(
      dir('根', [
        dir('L2', [dir('L3', [dir('L4a', [dir('L5a'), dir('L5b')]), dir('L4b')])])
      ])
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(templateDepth(r.root)).toBe(MAX_TEMPLATE_DEPTH)
    expect(r.root.children![0].children![0].children?.map((c) => c.name)).toEqual(['L4a', 'L4b'])
    // L4a 不再下钻（L5a/L5b 只计数）；L4b 是叶子
    expect(r.root.children![0].children![0].children![0].children).toBeUndefined()
    expect(r.truncated.depth).toBe(2)
    expect(r.truncated.nodes).toBe(0)
    expect(r.scannedDirs).toBe(7) // 根 L2 L3 L4a L4b = 5 + 多探统计的 2 个第 5 层
  })

  it('超过 256 节点截断：树收到 MAX_TEMPLATE_NODES，truncated.nodes = 超出数', () => {
    // 根 + 300 个一级子目录 = 301 个目录
    const fsx = buildFakeFs(
      dir('大模板', Array.from({ length: 300 }, (_, i) => dir(`c${i}`)))
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(countTemplateNodes(r.root)).toBe(MAX_TEMPLATE_NODES)
    expect(r.truncated.nodes).toBe(301 - MAX_TEMPLATE_NODES)
    expect(r.truncated.depth).toBe(0)
  })

  it('深度 + 数量双超限：两项统计并存', () => {
    // 第 4 层下挂 260 个第 5 层目录（既超深也超 256 总量）
    const fsx = buildFakeFs(
      dir('根', [
        dir('L2', [dir('L3', [dir('L4', Array.from({ length: 260 }, (_, i) => dir(`d${i}`)))])])
      ])
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(templateDepth(r.root)).toBe(MAX_TEMPLATE_DEPTH)
    expect(r.truncated.depth).toBe(260)
    // 深度 ≤4 的目录 = 根 L2 L3 L4 = 4；树 = 4 节点 → nodes 截断 0（第 5 层全算深度丢弃）
    expect(r.truncated.nodes).toBe(0)
  })

  it('扫描硬上限：超过 SCAN_MAX_DIRS 即停，树仍是合法的 256 节点（至少口径）', () => {
    // 1100 个一级子目录 > SCAN_MAX_DIRS(1024)
    const fsx = buildFakeFs(
      dir('超大', Array.from({ length: 1100 }, (_, i) => dir(`c${i}`)))
    )
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(countTemplateNodes(r.root)).toBe(MAX_TEMPLATE_NODES)
    // 访问数不超过硬上限（宁可少报不可拖死主进程）
    expect(r.scannedDirs).toBeLessThanOrEqual(SCAN_MAX_DIRS)
    expect(r.truncated.nodes).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ④ 错误分支（永不 reject，错误全部中文单行）
// ════════════════════════════════════════════════════════════════════════════

describe('scanTemplateFromDir — 错误分支', () => {
  it('目录不存在 → 中文错误', () => {
    const fsx = buildFakeFs(dir('存在', [dir('子')]))
    const r = scanTemplateFromDir({ dirPath: '不存在' }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('不存在')
  })

  it('拖入的是文件 → 中文错误', () => {
    const fsx = buildFakeFs(dir('某目录', [file('说明.txt')]))
    const r = scanTemplateFromDir({ dirPath: '某目录/说明.txt' }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('文件')
  })

  it('根目录无权限（EACCES）→ 中文错误', () => {
    const fsx = buildFakeFs(dir('锁住的', [dir('子')]))
    fsx.io.readdir = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('权限')
  })

  it('根目录其他 IO 错误 → 中文错误（不暴露内部码）', () => {
    const fsx = buildFakeFs(dir('怪目录', [dir('子')]))
    fsx.io.readdir = () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' })
    }
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('读取')
    expect(r.error).not.toContain('EIO')
  })

  it('空目录（没有子文件夹）→ 中文错误', () => {
    const fsx = buildFakeFs(dir('空目录', []))
    const r = scanTemplateFromDir({ dirPath: fsx.rootPath }, fsx.io)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('没有子文件夹')
  })

  it('坏入参（缺 dirPath / 非对象）→ 中文错误，不抛错', () => {
    expect(scanTemplateFromDir(null).ok).toBe(false)
    expect(scanTemplateFromDir(undefined).ok).toBe(false)
    expect(scanTemplateFromDir({}).ok).toBe(false)
    expect(scanTemplateFromDir({ dirPath: '   ' }).ok).toBe(false)
    const bad = scanTemplateFromDir({ dirPath: 123 as unknown as string })
    expect(bad.ok).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ 纯只读守卫 + IPC 三处同改 + 预览确认流源码守卫
// ════════════════════════════════════════════════════════════════════════════

/** 相对仓库根读源码，换行归一（工作区 CRLF，切片断言不能被换行符干扰）。 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/** 剥注释：本仓注释里就写着要防的东西，不剥会误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('纯只读守卫 — 扫描通道绝无写盘能力', () => {
  const src = stripComments(readSrc('src/main/templateScan.ts'))

  it('源码无 mkdir / writeFile / rm / unlink 等任何写盘调用', () => {
    expect(src).not.toMatch(/mkdir|writeFile|rmdir|rmSync|unlink|rename\(|copyFile/)
  })

  it('只 import node:fs 的 readdirSync / statSync（读侧 API）', () => {
    expect(src).toContain("import { readdirSync, statSync } from 'node:fs'")
  })

  it('归一化收口走 normalizeProjectTemplate（唯一实现，不复制清洗逻辑）', () => {
    expect(src).toContain('normalizeProjectTemplate(')
    expect(src).toContain("from '../shared/projectTemplate'")
  })
})

describe('IPC · template:scanFromDir 三处同改（ipc.ts:3 铁律）', () => {
  it('shared/ipc.ts 有通道 + 契约类型（永不 reject 的收口形状）', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("templateScanFromDir: 'template:scanFromDir'")
    expect(src).toContain('export interface TemplateScanInput')
    expect(src).toContain('export interface TemplateScanTruncated')
    expect(src).toContain('export type TemplateScanResult')
    expect(src).toContain(
      '{ ok: true; root: ProjectTemplateNode; truncated: TemplateScanTruncated; scannedDirs: number }'
    )
    expect(src).toContain('{ ok: false; error: string }')
  })

  it('preload 有暴露', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('IPC.templateScanFromDir')
    expect(src).toContain('templateScanFromDir: (input: TemplateScanInput)')
  })

  it('main 有 handler 且引用扫描器（不在 handler 里复制扫描逻辑）+ 失败留日志', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    expect(src).toContain('IPC.templateScanFromDir')
    expect(src).toContain('scanTemplateFromDir(input)')
    expect(src).toContain("from './templateScan'")
    const start = src.indexOf('IPC.templateScanFromDir')
    // 尾界 = 下一个 ipcMain.handle(（v1.2 后 index.ts 在本 handler 与 allowedOpenRoots 之间插入了多个 fs:* handler，用函数名当尾界会把邻居圈进来造成假失败）
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 10))
    expect(body).toContain('logWarn')
    expect(body).toContain('try {')
    // handler 里不得直接 fs 落盘（扫描逻辑唯一入口在 templateScan.ts）
    expect(body).not.toMatch(/mkdir|writeFile/)
  })
})

describe('渲染层 · 拖入预览确认流源码守卫（ProjectTemplatesEditor.tsx）', () => {
  const src = stripComments(readSrc('src/renderer/components/ProjectTemplatesEditor.tsx'))

  it('卡内有 dragenter/over/leave/drop 四事件，drop 必须 stopPropagation 拦窗口级导入', () => {
    expect(src).toContain('onDragEnter={handleDragEnter}')
    expect(src).toContain('onDragOver={handleDragOver}')
    expect(src).toContain('onDragLeave={handleDragLeave}')
    expect(src).toContain('onDrop={handleDrop}')
    const dropIdx = src.indexOf('const handleDrop')
    expect(dropIdx).toBeGreaterThan(0)
    const dropBody = src.slice(dropIdx, src.indexOf('const startScan', dropIdx))
    expect(dropBody).toContain('e.stopPropagation()')
    expect(dropBody).toContain('e.preventDefault()')
  })

  it('应用内归类拖拽不接管（hasAssetDragPayload 判定）', () => {
    expect(src).toContain('hasAssetDragPayload')
  })

  it('drop → getPathForFile → templateScanFromDir（只读扫描）', () => {
    expect(src).toContain('window.modvault.getPathForFile(file)')
    expect(src).toContain("window.modvault.templateScanFromDir({ dirPath })")
  })

  it('预览确认层走 Modal（Esc 层栈）+「生成模板」才写入草稿，绝不静默写入', () => {
    expect(src).toContain('<Modal')
    expect(src).toContain('从文件夹生成模板')
    expect(src).toContain('松开以从该文件夹生成模板')
    const confirmIdx = src.indexOf('const confirmPreview')
    expect(confirmIdx).toBeGreaterThan(0)
    const body = src.slice(confirmIdx, src.indexOf('return (', confirmIdx))
    expect(body).toContain('addBlankTemplate(fullBase())')
    expect(body).toContain('renameTemplateInList')
    expect(body).toContain('记得点「保存」写入')
    // 生成走既有草稿链，不出现任何直接 IPC 写设置调用
    expect(body).not.toContain('saveSettings')
  })

  it('丢弃统计可见 + 零系统控件', () => {
    expect(src).toContain('preview.truncated.depth')
    expect(src).toContain('preview.truncated.nodes')
    expect(src).not.toContain('<dialog')
    expect(src).not.toContain('window.confirm')
    expect(src).not.toContain('window.prompt')
    expect(src).not.toContain('window.alert')
  })

  it('扫描失败就地单行展示（role=alert），不打断编辑器', () => {
    expect(src).toContain('setScanError(r.error)')
    expect(src).toContain('role="alert"')
  })
})
