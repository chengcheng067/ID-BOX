/**
 * T-05 首页渲染卡 · 接线守卫 + 涟漪开关真值表（docs/60 §6 + 任务子项 4/5）。
 *
 * 范式 = `tests/homeCustomWiring.test.ts` 的 `readSrc()` 源码守卫（vitest node 环境，
 * 无 DOM）：行为归 `tests/homePinned.test.ts` 的纯函数真值表，这里守"关键接线点
 * 有没有接上 + 防退化"。
 *
 * | # | 守卫 | 防的退化 |
 * |---|------|----------|
 * | 1 | clickRippleAllowed 真值表 | 涟漪脱离总开关（任一关闭仍激涟漪） |
 * | 2 | HomeParticles pointerdown 先判总闸再判涟漪子开关 | 子项 4 回归（涟漪不跟总开关走） |
 * | 3 | 引擎 ripple() 与调用侧共用同一真值表 | 两处判定漂移 |
 * | 4 | home:pinnedOpen / dialog:pickDirectory 三处同改 | ipc.ts:3 铁律破坏 |
 * | 5 | 主进程 pinnedOpen 走 id 白名单 + showItemInFolder，不走 openPath | 0.9.2 守卫被绕开 |
 * | 6 | HomeCover 钉选卡 / 悬停滚动 / 底纹接线 | 同排追加 / smooth 降级 / bg:// 底纹回退 |
 * | 7 | SettingsDialog 海浪面板按静态图片背景显隐 | 子项 5 回归 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clickRippleAllowed } from '../src/renderer/components/home/particleTide'

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

describe('子项 4 · clickRippleAllowed（涟漪跟总开关走）', () => {
  it('真值表：总闸与涟漪子开关都开才放行', () => {
    expect(clickRippleAllowed(true, true)).toBe(true)
    expect(clickRippleAllowed(false, true)).toBe(false)
    expect(clickRippleAllowed(true, false)).toBe(false)
    expect(clickRippleAllowed(false, false)).toBe(false)
  })

  it('HomeParticles：pointerdown 先判总闸（interactive），再判涟漪子开关', () => {
    const src = stripComments(readSrc('src/renderer/components/home/HomeParticles.tsx'))
    const start = src.indexOf('const onPointerDown =')
    const end = src.indexOf('/** 指针离开', start)
    const body = src.slice(start, end)
    expect(body, 'onPointerDown 缺总闸守卫').toContain('if (!settings.interactive) return')
    expect(body, 'onPointerDown 缺涟漪真值表判定').toContain('clickRippleAllowed(')
    // 顺序：总闸判定出现在 ripple 调用之前（防"先激涟漪再判开关"的倒装）
    expect(body.indexOf('if (!settings.interactive) return')).toBeLessThan(body.indexOf('renderer.ripple('))
  })

  it('引擎 ripple() 与调用侧共用 clickRippleAllowed（同一份真值表，不许两处漂移）', () => {
    const src = stripComments(readSrc('src/renderer/components/home/particleTide.ts'))
    expect(src).toContain('export function clickRippleAllowed(')
    expect(src).toContain('clickRippleAllowed(settings.interactive, settings.clickRipples)')
  })
})

describe('IPC · home:pinnedOpen / dialog:pickDirectory 三处同改（ipc.ts:3 铁律）', () => {
  it('shared/ipc.ts 两条通道都有契约注释', () => {
    const src = readSrc('src/shared/ipc.ts')
    expect(src).toContain("homePinnedOpen: 'home:pinnedOpen'")
    expect(src).toContain("pickDirectory: 'dialog:pickDirectory'")
    expect(src).toContain('PickDirectoryInput')
  })

  it('preload 两条通道都有暴露', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('IPC.pickDirectory')
    expect(src).toContain('IPC.homePinnedOpen')
  })

  it('main 两条通道都有 handler', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('IPC.pickDirectory')
    expect(src).toContain('IPC.homePinnedOpen')
  })

  it('pinnedOpen 走 id 白名单 + showItemInFolder，绝不走 shell.openPath / 守卫通道', () => {
    const src = stripComments(readSrc('src/main/index.ts'))
    const start = src.indexOf('IPC.homePinnedOpen')
    expect(start).toBeGreaterThanOrEqual(0)
    // 只看本 handler 的函数体（到下一个 ipcMain.handle 为止）——
    // 修完后紧接着就是 openPath handler，直接切 2400 字符会把它切进来误判。
    const end = src.indexOf('ipcMain.handle', start)
    const body = src.slice(start, end)
    expect(body, '必须按 id 从主进程自己的 settings 解析路径').toContain('homePinnedFolders')
    expect(body, '必须先 existsSync 再打开').toContain('existsSync(')
    expect(body, '必须用 shell.showItemInFolder').toContain('shell.showItemInFolder(')
    expect(body, '钉选打开不得借 openPath 通道（0.9.2 守卫零放宽）').not.toContain('shell.openPath(')
  })

  it('渲染层打开钉选只调 homePinnedOpen，不调 reveal / openPath', () => {
    const src = stripComments(readSrc('src/renderer/App.tsx'))
    expect(src).toContain('homePinnedOpen(id)')
    // App 全文不允许出现 shell:openPath / reveal 通道（守卫会拒库外路径）
    expect(src).not.toContain('modvault.openPath')
    expect(src).not.toContain('modvault.reveal')
  })
})

describe('F-1/F-2/F-3 · HomeCover 接线守卫', () => {
  const src = stripComments(readSrc('src/renderer/components/home/HomeCover.tsx'))

  it('钉选卡同排追加在素材大类卡之后（§6.1 拍板形态）', () => {
    const kindIndex = src.indexOf('{visibleFolders.map((folder, index) => {')
    const pinIndex = src.indexOf('{visiblePinned.map((pin, pinIndex) => {')
    expect(kindIndex).toBeGreaterThanOrEqual(0)
    expect(pinIndex).toBeGreaterThan(kindIndex)
    expect(src).toContain('pinned')
    expect(src).toContain('onOpenPinned(pin.id)')
  })

  it('悬停自动滚动：方向判定走纯函数，smooth 档整体禁用（rAF 不启动）', () => {
    expect(src).toContain('const edgeScrollEnabled = quality !==')
    expect(src).toContain("quality !== 'smooth'")
    expect(src).toContain('edgeScrollDirection(')
    expect(src).toContain('nextScrollLeft(')
    // smooth 档下 rAF 不启动：startEdgeScroll 首行守卫
    const startIdx = src.indexOf('const startEdgeScroll = useCallback')
    const body = src.slice(startIdx, startIdx + 600)
    expect(body, 'smooth 档必须在不启动 rAF 之前短路').toContain('!edgeScrollEnabled')
  })

  it('底纹：key 命名空间 + bg:// 派生走 logic/homePinned（无第二份实现）', () => {
    expect(src).toContain('kindWallpaperKey(')
    expect(src).toContain('pinWallpaperKey(')
    expect(src).toContain('wallpaperUrlOf(')
    // 组件里 `bg://` 只允许出现一次 —— 壁纸明暗取样的既有效应（wallTone effect）；
    // 文件夹底纹的 bg:// 一律由 wallpaperUrlOf 派生，不许再手拼第二份。
    const bgCount = src.match(/bg:\/\//g)?.length ?? 0
    expect(bgCount, 'HomeCover 里 bg:// 只应是壁纸取色既有的那一处').toBe(1)
  })
})

describe('F-1/F-3 · GlassFolder 钉选变体守卫', () => {
  const src = stripComments(readSrc('src/renderer/components/home/GlassFolder.tsx'))

  it('钉选卡标记点 / 无计数 / 底纹优先', () => {
    expect(src).toContain('data-pinned')
    // 2026-11-25 用户拍板：右上角「置顶」圆钉取消，改成名字行前的强调蓝小圆点
    expect(src).toContain('gf-kind-dot')
    expect(src).not.toContain('gf-pin-badge')
    expect(src).toContain("pinned ? '外部'")
    expect(src).toContain('wallpaperUrl !== null')
    expect(src).toContain('onContextMenu={onContextMenu}')
  })
})

describe('子项 5 · SettingsDialog 海浪面板随静态图片背景显隐', () => {
  it('面板判定走 homeWavePanelVisible 纯函数（与 HomeCover hasWallpaper 同源）', () => {
    const src = stripComments(readSrc('src/renderer/components/SettingsDialog.tsx'))
    expect(src).toContain('homeWavePanelVisible(')
  })
})
