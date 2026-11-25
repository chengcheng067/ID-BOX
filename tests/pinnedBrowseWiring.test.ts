/**
 * 钉选目录应用内浏览 · 接线守卫（v1.2 反馈批 B）。
 *
 * 范式 = `tests/homePinnedWiring.test.ts` 的 `readSrc()` 源码守卫（vitest node
 * 环境，无 DOM）：行为归 `tests/pinnedDirGuard.test.ts` 的纯函数真值表，这里守
 * 「IPC 三处同改 + 双击不再弹资源管理器 + 守卫零放宽 + Esc 层栈」防退化。
 *
 * | # | 守卫 | 防的退化 |
 * |---|------|----------|
 * | 1 | fs:listDir / fs:openEntry 三处同改 | ipc.ts:3 铁律破坏 |
 * | 2 | main 两条通道走 pinId 白名单 + resolveWithinPinRoot 前缀校验 | 越界列目录 / 越界开文件 |
 * | 3 | fsListDir 只读（不出现 shell.openPath / 写盘 API） | 列目录变成执行面 |
 * | 4 | 右键菜单「在资源管理器中打开」走 onRevealPinned（home:pinnedOpen 兜底） | 菜单语义漂移 |
 * | 5 | 双击钉选卡仍走 onOpenPinned（App 侧已改为进应用内浏览） | 接线守卫（双击不再调 pinnedOpen） |
 * | 6 | App：浏览器按 pinId 挂载、关闭即回首页（首页状态原样） | 回首页状态破坏 |
 * | 7 | 浏览器组件：Esc 走 useEscLayer；双击文件走 openPinnedEntry；零系统控件 | 交互规范破坏 |
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

describe('IPC · fs:listDir / fs:openEntry 三处同改（ipc.ts:3 铁律）', () => {
  it('shared/ipc.ts 两条通道都有契约注释与载荷类型', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("fsListDir: 'fs:listDir'")
    expect(src).toContain("fsOpenEntry: 'fs:openEntry'")
    expect(src).toContain('FsListDirInput')
    expect(src).toContain('FsOpenEntryInput')
    expect(src).toContain('FsListDirResult')
    expect(src).toContain('FsOpenEntryResult')
    expect(src).toContain('interface FsEntry')
  })

  it('preload 两条通道都有暴露', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('IPC.fsListDir')
    expect(src).toContain('IPC.fsOpenEntry')
    expect(src).toContain('listPinnedDir')
    expect(src).toContain('openPinnedEntry')
  })

  it('main 两条通道都有 handler', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('IPC.fsListDir')
    expect(src).toContain('IPC.fsOpenEntry')
  })
})

describe('main · 两条通道的守卫（pinId 白名单 + pin 根前缀校验，零放宽）', () => {
  const src = stripComments(readSrc('src/main/index.ts'))

  it('fsListDir：按 id 从主进程 settings 解析钉选根 + resolveWithinPinRoot，越界记 ipc:guard', () => {
    const start = src.indexOf('IPC.fsListDir')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = src.indexOf('ipcMain.handle', start)
    const body = src.slice(start, end)
    expect(body, '必须经 resolveWithinPinRoot 前缀校验').toContain('resolveWithinPinRoot(')
    expect(body, '越界必须记 ipc:guard').toContain("logWarn('ipc:guard'")
    expect(body, '只读列目录不得调 shell.openPath').not.toContain('shell.openPath(')
    expect(body, '永不 reject：错误收口 ok:false').toContain('{ ok: false')
  })

  it('fsOpenEntry：同一套校验，文件打开走 shell.openPath（错误压单行）', () => {
    const start = src.indexOf('IPC.fsOpenEntry')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = src.indexOf('ipcMain.handle', start)
    const body = src.slice(start, end)
    expect(body, '必须经 resolveWithinPinRoot 前缀校验').toContain('resolveWithinPinRoot(')
    expect(body, '打开走 shell.openPath').toContain('await shell.openPath(')
    expect(body, '错误收口 ok:false').toContain('{ ok: false')
  })

  it('0.9.2 allowedOpenRoots 不为钉选目录开口（守卫零放宽）', () => {
    const start = src.indexOf('function allowedOpenRoots()')
    const end = src.indexOf('const OPEN_PATH_DENIED', start)
    const body = src.slice(start, end)
    expect(body).not.toContain('homePinnedFolders')
    expect(body).not.toContain('pinned')
  })

  it('守卫实现收口在 pinnedDirGuard.ts（列目录模块只读、无写盘 API）', () => {
    const guard = stripComments(readSrc('src/main/pinnedDirGuard.ts'))
    expect(guard).toContain('export function resolveWithinPinRoot(')
    expect(guard).toContain('export function readDirEntries(')
    expect(guard).toContain('LIST_DIR_MAX_ENTRIES = 2000')
    expect(guard).not.toMatch(/writeFile|appendFile|mkdir|rmdir|unlink|rename\(|chmod/)
  })
})

describe('接线 · 双击钉选卡进应用内浏览（不再弹资源管理器）', () => {
  it('HomeCover：双击 onOpen 仍走 onOpenPinned（App 侧语义已改为应用内浏览）', () => {
    const src = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
    expect(src).toContain('onOpenPinned(pin.id)')
  })

  it('HomeCover：右键菜单改走 onRevealPinned（home:pinnedOpen 兜底出口）', () => {
    const src = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
    expect(src).toContain('onRevealPinned(menu.id)')
    // 双击与菜单两条路互不借用：菜单不得再调 onOpenPinned
    expect(src).not.toContain('onOpenPinned(menu.id)')
  })

  it('contextMenu：菜单项文案改为「在资源管理器中打开」', () => {
    const src = stripComments(readSrc('src/renderer/logic/contextMenu.ts'))
    expect(src).toContain("'在资源管理器中打开'")
    expect(src).not.toMatch(/label:\s*'打开'/)
  })

  it('App：浏览器按 pinId/name 挂载、HomeCover 与浏览器互斥、关闭即回首页', () => {
    const src = stripComments(readSrc('src/renderer/App.tsx'))
    expect(src).toContain('PinnedFolderBrowser')
    expect(src).toContain('browseHomePinnedFolder')
    expect(src).toContain('setPinnedBrowser(null)')
    expect(src).toContain('onOpenPinned={browseHomePinnedFolder}')
    expect(src).toContain('onRevealPinned={openHomePinnedFolder}')
    // 兜底出口仍接 homePinnedOpen（右键菜单），且绝不借 openPath / reveal 通道
    expect(src).toContain('homePinnedOpen(id)')
    expect(src).not.toContain('modvault.openPath')
    expect(src).not.toContain('modvault.reveal')
  })

  it('渲染层双击链路不再出现 homePinnedOpen 调用（HomeCover / GlassFolder 源码守卫）', () => {
    const cover = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))
    const glass = stripComments(readSrc('src/renderer/components/home/GlassFolder.tsx'))
    expect(cover).not.toContain('homePinnedOpen')
    expect(glass).not.toContain('homePinnedOpen')
  })

  it('浏览器组件：Esc 走 useEscLayer；列目录 / 开文件走新通道；零系统控件', () => {
    const src = stripComments(readSrc('src/renderer/components/home/PinnedFolderBrowser.tsx'))
    expect(src).toContain('useEscLayer(onClose, true)')
    expect(src).toContain('listPinnedDir(')
    expect(src).toContain('openPinnedEntry(')
    expect(src).not.toContain('<select')
    expect(src).not.toContain('window.open(')
    // v2 对齐（2026-11-25 lead 收口单第 5 条）：右键菜单补「在资源管理器中显示」。
    // 2026-11-25 二次修订（用户：「弹开的并不是我右键点击的这个文件所在的文件夹」）：
    // 主路径改为专用通道 fs:revealEntry（按 pinId + relPath 精确到条目），
    // 旧口径 home:pinnedOpen（只揭示钉选根）降级为运行期兜底（可选链调用）。
    expect(src).toContain('revealPinnedEntry({ pinId, relPath: rel })')
    expect(src).toContain('homePinnedOpen?.(pinId)')
    expect(src).not.toContain('modvault.openPath')
    expect(src).not.toContain('modvault.reveal')
  })
})

/**
 * 右键菜单落点守卫（2026-11-25 用户实测：「右键菜单并没有跟随鼠标的位置生成，
 * 而是离鼠标有一段距离」）。
 *
 * 机制铁律：祖先只要残留非 `none` 的 `transform`，`position: fixed` 后代的包含块
 * 就从**视口**变成该祖先的 padding box。浏览器面板根节点挂着 `.pinned-browser-enter`，
 * 曾经的 `animation ... both` 会把结束帧的 `transform: translateY(0) scale(1)` 永久
 * 留在计算样式里 → 菜单坐标被叠加面板原点、遮罩少盖顶栏一条。
 *
 * 两道防线，缺一不可：
 * ① 样式：入场 fill 改 `backwards`，动画结束后面板交还 `transform: none`
 *    （退场刻意保留 `both`，见 CSS 注释）；
 * ② 组件：入场动画进行中的 180ms 内面板仍是 containing block，菜单**必须** portal
 *    到 `<body>`，否则那段时间 clientX/clientY 仍不等于视口坐标。
 * 这条守卫防的正是「顺手把 portal 改回普通渲染 / 把 backwards 改回 both」这类静默回归。
 */
describe('接线 · 右键菜单脱离 transform 祖先（portal 到 body）', () => {
  const menu = stripComments(readSrc('src/renderer/components/home/PinnedBrowserMenu.tsx'))
  const browser = stripComments(readSrc('src/renderer/components/home/PinnedFolderBrowser.tsx'))

  it('PinnedBrowserMenu 用 createPortal(..., document.body) 渲染，且仍按视口坐标定位', () => {
    expect(menu).toContain("import { createPortal } from 'react-dom'")
    expect(menu).toContain('return createPortal(')
    expect(menu).toContain('document.body')
    // 定位基准仍是 clientX/clientY + fixed：portal 后才与视口一一对应
    expect(menu).toContain('menuPlacement(x, y,')
    expect(menu).toContain('window.innerWidth')
    expect(menu).toContain('window.innerHeight')
    expect(menu).toContain('fixed z-50')
  })

  it('浏览器侧菜单坐标仍取 e.clientX / e.clientY（不得改成容器内坐标）', () => {
    expect(browser).toContain('setMenu({ kind: \'entry\', x: e.clientX, y: e.clientY, targets })')
    expect(browser).toContain('setMenu({ kind: \'blank\', x: e.clientX, y: e.clientY })')
  })

  it('入场 fill 必须是 backwards（结束交还 transform:none），退场必须 both（钉住淡出终态）', () => {
    const css = stripComments(readSrc('src/renderer/components/home/pinned-enter.css'))
    const enterAt = css.indexOf('.pinned-browser-enter')
    const exitAt = css.indexOf('.pinned-browser-exit')
    expect(enterAt, '入场规则必须存在').toBeGreaterThanOrEqual(0)
    expect(exitAt, '退场规则必须排在入场之后').toBeGreaterThan(enterAt)

    // 入场：backwards —— 播完后面板不再是 containing block（菜单 / 遮罩才按视口定位）
    const enterRule = css.slice(enterAt, exitAt)
    expect(enterRule).toContain('animation: pinned-browser-in 180ms')
    expect(enterRule).toContain('backwards;')
    expect(enterRule, '入场不得用 both/forwards：否则 transform 永久残留').not.toContain(' both;')

    // 退场：both —— 淡出终态要撑到 EXIT_ANIM_MS 卸载，掉了会闪一帧
    const exitRule = css.slice(exitAt, css.indexOf('@keyframes pinned-browser-out'))
    expect(exitRule).toContain('animation: pinned-browser-out 150ms')
    expect(exitRule, '退场必须保留 both').toContain(' both;')

    // 结束帧本身是恒等 transform（改成 backwards 才不会有视觉差异）
    expect(css).toContain('transform: translateY(0) scale(1)')
  })
})

/**
 * 导航行顺序守卫（2026-11-25 用户需求：「把文件夹的"回到首页"按钮放到"上一级"的
 * 前面去」）。
 *
 * 三件事一起钉：
 * ① 回首页在导航行**最左**（在 goUp 之前）；
 * ② 导航行里只有**一颗**回首页 —— 右侧旧入口不得回潮（否则出现两个入口）；
 * ③ 点击仍走 `requestClose`（150ms 退场动画的唯一退出路径），不得直连 onClose。
 */
describe('接线 · 回首页在导航行最左（上一级之前）+ 走 requestClose', () => {
  const src = stripComments(readSrc('src/renderer/components/home/PinnedFolderBrowser.tsx'))

  it('回首页排在 goUp 之前，且导航行内只有一颗', () => {
    const firstHome = src.indexOf('onClick={requestClose}')
    const firstUp = src.indexOf('onClick={goUp}')
    const toolRow = src.indexOf('pb-2.5 pt-2') // 工具行容器（导航行的下一段）
    expect(firstHome, '导航行必须有回首页按钮').toBeGreaterThanOrEqual(0)
    expect(firstUp, '导航行必须有上一级按钮').toBeGreaterThan(firstHome)
    expect(toolRow).toBeGreaterThan(firstUp)

    const navBlock = src.slice(firstHome, toolRow)
    expect(navBlock, '回首页必须走统一退场函数').toContain('onClick={requestClose}')
    expect(navBlock).toContain('title="返回首页（Esc）"')
    // 只数按钮文案（`>回首页`）；标题 "返回首页" 不算第二个入口
    expect(navBlock.match(/>\s*回首页/g) ?? [], '右侧旧入口不得回潮（会出现两个入口）').toHaveLength(1)
    expect(navBlock, '不得绕过 requestClose 直接 onClose').not.toContain('onClick={onClose}')
  })
})

/**
 * Quick Look 背景守卫（2026-11-25 用户需求：「按下空格后，背景应该是全部都高斯模糊掉，
 * 而不是单纯压黑，同时注意文字对比度」）。
 *
 * 关键点：
 * ① 遮罩换成本组件专属 `.ql-scrim`（不改进程里的全局 `.dialog-scrim`，删除确认层还在用）；
 * ② 必须同时有 `-webkit-backdrop-filter` 与标准属性（Electron/Chromium 双保险）；
 * ③ 信息行 / 提示行放进 `.ql-caption` 局部托底（模糊背景会透出任意壁纸）；
 * ④ 键盘行为与层级不动（useEscLayer + decideQuickLookKey + 深度类）。
 */
describe('接线 · Quick Look 真高斯模糊遮罩 + 文字托底', () => {
  const ql = stripComments(readSrc('src/renderer/components/home/PinnedQuickLook.tsx'))
  const css = stripComments(readSrc('src/renderer/components/home/pinned-browser.css'))

  it('遮罩改 ql-scrim（不再借用全局 dialog-scrim），层级仍由 zClassForDepth 算', () => {
    expect(ql).toContain('ql-scrim fixed inset-0')
    expect(ql).toContain('zClassForDepth(escDepth)')
    expect(ql).not.toContain('dialog-scrim')
  })

  it('ql-scrim：24px blur + saturate 1.15（带 -webkit- 前缀）+ 双主题更淡底色', () => {
    const lightAt = css.indexOf('.ql-scrim {')
    const darkAt = css.indexOf("[data-theme='dark'] .ql-scrim")
    expect(lightAt).toBeGreaterThanOrEqual(0)
    expect(darkAt).toBeGreaterThan(lightAt)

    const lightRule = css.slice(lightAt, darkAt)
    expect(lightRule).toContain('-webkit-backdrop-filter: blur(24px) saturate(1.15)')
    expect(lightRule).toContain('backdrop-filter: blur(24px) saturate(1.15)')
    expect(lightRule).toContain('rgba(248, 250, 252, 0.3)')

    const darkRule = css.slice(darkAt, css.indexOf('}', darkAt) + 1)
    expect(darkRule).toContain('rgba(10, 10, 12, 0.45)')
  })

  it('信息行 / 键盘提示进 .ql-caption 局部托底（--bg-canvas 88% + 白 10% 描边）', () => {
    expect(ql).toContain('ql-caption')
    expect(css).toContain('.ql-caption {')
    expect(css).toContain('color-mix(in srgb, var(--bg-canvas) 88%, transparent)')
    expect(css).toContain('color-mix(in srgb, #ffffff 10%, transparent)')
    // 提示行从 tertiary 提到 secondary（原色在模糊背景上不可读）
    expect(ql).not.toContain('text-[11px] text-tertiary')
  })

  it('键盘行为与固定画框尺寸不动', () => {
    expect(ql).toContain('useEscLayer(onClose, true)')
    expect(ql).toContain('decideQuickLookKey(')
    expect(ql).toContain('stepQuickLookFile(')
    expect(ql).toContain('h-[min(76vh,720px)]')
  })
})

describe('「在资源管理器中显示」精确到条目（2026-11-25 用户反馈）', () => {
  const browser = stripComments(readSrc('src/renderer/components/home/PinnedFolderBrowser.tsx'))
  const ipc = stripComments(readSrc('src/shared/ipc.ts'))
  const preload = stripComments(readSrc('src/preload/index.ts'))

  it('契约：fs:revealEntry 通道 + preload revealPinnedEntry', () => {
    expect(ipc).toContain("fsRevealEntry: 'fs:revealEntry'")
    expect(preload).toContain('revealPinnedEntry')
    expect(preload).toContain('IPC.fsRevealEntry')
  })

  it('渲染层按「当前目录相对路径 + 条目名」调专用通道，不再只揭示钉选根', () => {
    // 拼 relPath 后调 revealPinnedEntry（精确到右键点的那一条）
    expect(browser).toContain('revealPinnedEntry({ pinId, relPath: rel })')
    expect(browser).toMatch(/const rel = relPath\.length > 0 \? `\$\{relPath\}\/\$\{entry\.name\}` : entry\.name/)
    // 旧口径（只用 pinId 打开根目录）降级为运行期兜底，不再是主路径
    expect(browser).toContain('typeof api.revealPinnedEntry === \'function\'')
  })
})
