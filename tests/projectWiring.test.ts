/**
 * T-03 · 新建项目向导接线守卫（docs/60 §4 / §5.2 通道 2，范式 = homePinnedWiring.test.ts）。
 *
 * | # | 守卫 | 防的退化 |
 * |---|------|----------|
 * | 1 | project:create 三处同改（ipc.ts / preload / main） | ipc.ts:3 铁律破坏 |
 * | 2 | 主进程 W6 加固：normalizeProjectTemplate + resolveRootName + 两阶段 | 渲染层注入树直落盘 / 冲突覆盖 |
 * | 3 | 主进程成功路径 showItemInFolder，不走 shell.openPath | 0.9.2 守卫被绕开 |
 * | 4 | 向导成功路径无 reveal / openPath，打开走 homePinnedOpen | §4.4④ 判据回归 |
 * | 5 | 向导用 Modal（Esc 层栈）+ resolveRootName 实时预览 + 自动钉选 | 零系统控件 / Esc 纪律破坏 |
 * | 6 | 双入口接线：HomeCover 虚卡 + 排右键菜单「新建项目…」 | W0 入口丢失 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

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

describe('IPC · project:create 三处同改（ipc.ts:3 铁律）', () => {
  it('shared/ipc.ts 有通道 + 契约类型', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("projectCreate: 'project:create'")
    expect(src).toContain('export interface ProjectCreateInput')
    expect(src).toContain('export type ProjectCreateResult')
    // 永不 reject 的收口形状：ok/error 两个分支
    expect(src).toContain('{ ok: true; rootPath: string; dirsCreated: number }')
    expect(src).toContain('{ ok: false; error: string; dirsCreated?: number }')
  })

  it('preload 有暴露', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('IPC.projectCreate')
    expect(src).toContain('projectCreate: (input: ProjectCreateInput)')
  })

  it('main 有 handler 且引用生成器（不在 handler 里复制清洗逻辑）', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('IPC.projectCreate')
    expect(src).toContain('buildProjectPlan')
    expect(src).toContain('createProjectDirs')
    expect(src).toContain("from './projectCreate'")
  })
})

describe('主进程 · W6 加固 + 两阶段落盘（安全铁律写死）', () => {
  const src = stripComments(readSrc('src/main/projectCreate.ts'))

  it('模板经 normalizeProjectTemplate 归一化，根名走 resolveRootName（唯一实现，不复制）', () => {
    expect(src).toContain('normalizeProjectTemplate(raw.template)')
    expect(src).toContain('resolveRootName(template.root.name, code, name)')
    expect(src).toContain("from '../shared/projectTemplate'")
  })

  it('阶段一全量预检在阶段二 mkdir 之前；任一已存在 → 整体拒绝零创建', () => {
    // 两个同名循环：第一个是预检（exists），第二个是落盘（mkdir）——顺序写死
    const firstLoop = src.indexOf('for (const target of plan.targets)')
    const secondLoop = src.indexOf('for (const target of plan.targets)', firstLoop + 1)
    expect(firstLoop).toBeGreaterThan(0)
    expect(secondLoop).toBeGreaterThan(firstLoop)
    const precheck = src.slice(firstLoop, secondLoop)
    expect(precheck, '预检循环必须逐条 existsSync').toContain('io.exists(target)')
    expect(precheck, '任一冲突 → ok:false').toContain('ok: false')
    expect(precheck, '阶段一拒绝 = 零创建').toContain('dirsCreated: 0')
    const phaseTwo = src.slice(secondLoop)
    expect(phaseTwo).toContain('io.mkdir(target)')
    expect(phaseTwo).toContain('dirsCreated += 1')
  })

  it('半程失败不回滚：错误串带 dirsCreated，成功才返回 rootPath', () => {
    expect(src).toContain('已创建的文件夹保留在原处')
    // mkdir 一律带 recursive:true（默认 io 唯一落盘点，测试注入假 io 复现半程失败）
    expect(src).toContain('mkdirSync(p, { recursive: true })')
    // 成功分支返回 rootPath + dirsCreated
    expect(src).toContain('return { ok: true, rootPath: plan.rootPath, dirsCreated }')
  })

  it('盘根拒绝（path.dirname 等于自身）', () => {
    expect(src).toContain('path.dirname(normalizedParent) === normalizedParent')
  })
})

describe('主进程 · 成功收尾走 showItemInFolder（不走 0.9.2 守卫通道）', () => {
  it('project:create handler：成功 showItemInFolder，失败 logWarn，永不抛错', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    const start = src.indexOf('IPC.projectCreate')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = src.slice(start, src.indexOf('ipcMain.handle(', start + 10))
    expect(body).toContain('shell.showItemInFolder(')
    expect(body).toContain('logWarn')
    expect(body).toContain('try {')
    // handler 里不得直接 fs 落盘（生成逻辑唯一入口在 projectCreate.ts）
    expect(body).not.toContain('mkdirSync(')
    expect(body, '钉选/新建项目不得借 openPath 通道').not.toContain('shell.openPath(')
  })
})

describe('渲染层 · 向导接线（docs/60 §4.3 W1-W10）', () => {
  const src = stripComments(readSrc('src/renderer/components/home/NewProjectWizard.tsx'))

  it('成功路径零 reveal / openPath：打开走 home:pinnedOpen 的 id 白名单', () => {
    expect(src).toContain('homePinnedOpen(done.pinId)')
    expect(src).not.toContain('modvault.reveal')
    expect(src).not.toContain('modvault.openPath')
  })

  it('Esc 走 Modal 层栈（useEscLayer 语义）+ 创建等待中禁误关', () => {
    expect(src).toContain('<Modal')
    expect(src).toContain('dismissOnEsc={!creating}')
    expect(src).toContain('dismissOnScrim={!creating}')
  })

  it('W2 实时预览根名走 resolveRootName；W3 选位置走 dialog:pickDirectory', () => {
    expect(src).toContain('resolveRootName(selected.root.name, code, name)')
    expect(src).toContain('pickDirectory(')
    expect(src).toContain("'选择存放位置'")
  })

  it('W9 自动钉选：addHomePinnedFolder（查重/封顶在 store），打开走钉选 id', () => {
    expect(src).toContain('addHomePinnedFolder(rootName, result.rootPath)')
    expect(src).toContain('pinId')
  })

  it('编号输入框带建议文案；零系统控件关键词', () => {
    expect(src).toContain('建议填写，将用于项目文件夹命名')
    expect(src).not.toContain('<dialog')
    expect(src).not.toContain('window.confirm')
    expect(src).not.toContain('window.prompt')
    expect(src).not.toContain('window.alert')
  })

  it('失败分支：错误单行展示、向导不关（可改了重试）', () => {
    expect(src).toContain('setError(result.error)')
    expect(src).toContain('role="alert"')
  })
})

describe('入口 · 双入口同开一个向导（docs/60 §4.3 W0）', () => {
  it('HomeCover：虚卡排在钉选卡之后，可选 prop 不传不渲染', () => {
    const src = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
    const pinIdx = src.indexOf('{visiblePinned.map((pin, pinIndex) => {')
    const newIdx = src.indexOf('<NewProjectFolderCard')
    expect(pinIdx).toBeGreaterThan(0)
    expect(newIdx).toBeGreaterThan(pinIdx)
    // v1.2 反馈批 A：虚卡改为文件夹形态 —— HomeCover 渲染 NewProjectFolderCard，
    // 组件本体在 GlassFolder.tsx（BACK_PATH/FRONT_PATH 就近复用，形状永远同源）
    expect(src).toContain('<NewProjectFolderCard')
    expect(src).toContain('onClick={onNewProject}')
    const folderSrc = readSrc('src/renderer/components/home/GlassFolder.tsx')
    expect(folderSrc, '虚卡根节点必须同时挂 gf-root（形状/三态同源）与 np-new-card（差异样式）')
      .toContain('className="gf-root np-new-card"')
  })

  it('排右键菜单：新建项目… 在添加快速访问… 之前', () => {
    const src = stripComments(readSrc('src/renderer/logic/contextMenu.ts'))
    expect(src).toContain("label: '新建项目…'")
    const newIdx = src.indexOf("'新建项目…'")
    const addIdx = src.indexOf("'添加快速访问…'")
    expect(newIdx).toBeGreaterThan(0)
    expect(addIdx).toBeGreaterThan(newIdx)
  })

  it('App.tsx：HomeCover 传 onNewProject + 挂载 NewProjectWizard', () => {
    const src = stripComments(readSrc('src/renderer/App.tsx'))
    expect(src).toContain('onNewProject={openNewProjectWizard}')
    expect(src).toContain('NewProjectWizard')
    expect(src).toContain('newProjectOpen')
  })

  it('虚卡样式独立成文件（不掺 T-05 定稿的 glass-folder.css），尺寸阶梯同源', () => {
    const css = readSrc('src/renderer/components/home/new-project-card.css')
    expect(css).toContain('.np-new-card')
    expect(css).toContain('--gf-scale')
    expect(css).toContain('@media (min-width: 1440px)')
    // glass-folder.css 不应被本项目改动混入向导样式
    const gf = readSrc('src/renderer/components/home/glass-folder.css')
    expect(gf).not.toContain('np-new-card')
  })
})
