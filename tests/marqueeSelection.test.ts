/**
 * 中栏**框选多选**（marquee / 橡皮筋）+ **文件视图进出场动画**的回归测试。
 *
 * 分两层（与仓库既有做法一致）：
 * ① **纯几何**：`renderer/logic/fileView.ts` 的 `boxOf` / `boxesIntersect` / `marqueeHitIds`
 *    在 node 环境真跑 —— 命中算法是这块最容易出错、也最难肉眼验证的部分；
 * ② **源码守卫**：组件里含 React / Dexie（node 环境 import 不了），只能钉住关键接线
 *    （4px 阈值 / 一次性快照 / 追加语义 / Esc 恢复 / 动画分档 / reduced-motion），
 *    防止这些行为被后续重构静默改掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxOf, boxesIntersect, marqueeHitIds, type BoxRect } from '../src/renderer/logic/fileView'

const box = (left: number, top: number, right: number, bottom: number): BoxRect => ({
  left,
  top,
  right,
  bottom
})

describe('框选几何 · boxOf 归一化', () => {
  it('向右下拖：宽高直接取差', () => {
    expect(boxOf(10, 20, 110, 220)).toEqual(box(10, 20, 110, 220))
  })

  it('向左上拖：结果与向右下拖完全一致（宽高恒为正）', () => {
    expect(boxOf(110, 220, 10, 20)).toEqual(box(10, 20, 110, 220))
    expect(boxOf(110, 20, 10, 220)).toEqual(box(10, 20, 110, 220))
  })

  it('原地不动（起手未过阈值）→ 零面积矩形', () => {
    expect(boxOf(5, 5, 5, 5)).toEqual(box(5, 5, 5, 5))
  })
})

describe('框选命中 · boxesIntersect（相交即选中，不要求包含）', () => {
  it('部分重叠算命中（手指拖框最常见的情况）', () => {
    // 卡片 100×100，选框只擦到右下角 10×10
    expect(boxesIntersect(box(90, 90, 200, 200), box(0, 0, 100, 100))).toBe(true)
  })

  it('选框完全包住卡片 / 卡片完全包住选框 → 都算命中', () => {
    expect(boxesIntersect(box(-50, -50, 300, 300), box(0, 0, 100, 100))).toBe(true)
    expect(boxesIntersect(box(10, 10, 20, 20), box(0, 0, 100, 100))).toBe(true)
  })

  it('分离 / 仅边界相切 → 不算命中（卡片 14px 缝隙里划过不该误选）', () => {
    expect(boxesIntersect(box(200, 200, 300, 300), box(0, 0, 100, 100))).toBe(false)
    // 右边贴在卡片左边上（相切）
    expect(boxesIntersect(box(100, 0, 200, 100), box(0, 0, 100, 100))).toBe(false)
    // 只在 y 轴上重叠、x 轴完全分离
    expect(boxesIntersect(box(200, 10, 300, 90), box(0, 0, 100, 100))).toBe(false)
  })

  it('零面积选框（点击）不会命中任何卡片', () => {
    expect(boxesIntersect(box(50, 50, 50, 50), box(0, 0, 100, 100))).toBe(false)
  })
})

describe('框选命中 · marqueeHitIds', () => {
  const rects = new Map<string, BoxRect>([
    ['a', box(0, 0, 100, 100)],
    ['b', box(120, 0, 220, 100)],
    ['c', box(0, 120, 100, 220)]
  ])

  it('结果顺序 = 渲染顺序（不按矩形表插入顺序）', () => {
    expect(marqueeHitIds(rects, ['c', 'a', 'b'], box(0, 0, 130, 220))).toEqual(['c', 'a', 'b'])
    // 选框只覆盖上面一排（y < 110）→ c（top 120）不命中
    expect(marqueeHitIds(rects, ['a', 'b', 'c'], box(0, 0, 130, 110))).toEqual(['a', 'b'])
  })

  it('未采集到矩形的 id 直接跳过（虚拟滚动未渲染的卡片不该被选中）', () => {
    expect(marqueeHitIds(rects, ['a', 'zzz', 'b'], box(0, 0, 130, 130))).toEqual(['a', 'b'])
  })

  it('空选框 → 空命中（替换模式下等于"清空选择"）', () => {
    expect(marqueeHitIds(rects, ['a', 'b', 'c'], box(500, 500, 500, 500))).toEqual([])
  })
})

/* ── 源码守卫 ──────────────────────────────────────────────────────────────── */

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const GRID = read('src/renderer/components/AssetGrid.tsx')
const CSS = read('src/renderer/styles.css')

describe('源码守卫 · 框选状态机（AssetGrid）', () => {
  it('阈值 4px：位移不足视为点击空白，不进入框选态', () => {
    expect(GRID).toContain('const MARQUEE_MIN_PX = 4')
    expect(GRID).toContain('if (moved < MARQUEE_MIN_PX) return')
  })

  it('只在空白处起手：卡片本体 / 控件上的 mousedown 一律不接管（不抢"拖出到建模软件"）', () => {
    expect(GRID).toContain('if (target?.closest(MARQUEE_IGNORE_SELECTOR)) return')
    const selectorAt = GRID.indexOf('const MARQUEE_IGNORE_SELECTOR')
    expect(selectorAt).toBeGreaterThan(-1)
    const selector = GRID.slice(selectorAt, GRID.indexOf('].join', selectorAt))
    // 卡片本体必须是第一个豁免项 —— 少了它，框选会吃掉核心拖出手势
    expect(selector).toContain("'[data-asset-card]'")
  })

  it('命中尺寸/位置一次性快照：paintMarquee 内不再查 DOM（几百张卡时不掉帧）', () => {
    const start = GRID.indexOf('const paintMarquee')
    const end = GRID.indexOf('const startMarquee', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const paint = GRID.slice(start, end)
    expect(paint).not.toContain('getBoundingClientRect')
    expect(paint).not.toContain('querySelectorAll')
    // 快照在起手时采集一次、滚动时增量合并
    expect(GRID).toContain('rects: snapshotCardBoxes(container)')
  })

  it('命中集不变就不写 store（避免每次 mousemove 触发整网格重渲染）', () => {
    expect(GRID).toContain('if (key === drag.applied) return')
  })

  it('Ctrl/Cmd 起手 = 追加，否则 = 替换（与系统文件管理器一致）', () => {
    expect(GRID).toContain('additive: e.ctrlKey || e.metaKey')
    expect(GRID).toContain('drag.additive ? [...drag.snapshot, ...hits] : hits')
  })

  it('Esc 取消并恢复起手时的选择；空快照退回 select(null)', () => {
    const start = GRID.indexOf('const endMarquee')
    const end = GRID.indexOf('const paintMarquee', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = GRID.slice(start, end)
    expect(body).toContain('if (!cancel || !drag.armed) return')
    expect(body).toContain('st.selectMany(drag.snapshot)')
    expect(body).toContain('st.select(null)')
    // Esc 必须在捕获阶段吞掉，否则一次按键会同时关掉文件视图/弹窗
    expect(GRID).toContain("window.addEventListener('keydown', onKey, true)")
    expect(GRID).toContain('ev.stopPropagation()')
  })

  it('框选期间卡片交出指针事件（不出 hover / 不误触双击 / 不误起拖）', () => {
    expect(GRID).toContain("drag.container.dataset.marquee = '1'")
    expect(GRID).toContain('delete drag.container.dataset.marquee')
    // CSS 侧真的把它接到了 pointer-events 上
    expect(CSS).toContain("[data-marquee='1'] [data-asset-card]")
    const at = CSS.indexOf("[data-marquee='1'] [data-asset-card]")
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    expect(rule).toContain('pointer-events: none')
  })

  it('矩形用内容坐标系（滚动跟随）+ 容器裁剪（不溢出到侧栏/右栏）', () => {
    // 内容坐标 = client - 容器 rect + scrollLeft/scrollTop
    expect(GRID).toContain('clientX - r.left + container.scrollLeft')
    expect(GRID).toContain('clientY - r.top + container.scrollTop')
    // 滚动时重算（不是拿 clientY 直算）
    expect(GRID).toContain("container.addEventListener('scroll', onScroll")
    // 滚动容器必须 relative + overflow-auto，矩形才是它的绝对定位子元素并被裁剪
    expect(GRID).toContain('relative flex-1 overflow-auto px-5 pt-5 pb-4')
    expect(GRID).toContain('relative flex-1 overflow-auto px-4 py-3')
  })

  it('松手 / 失焦 / 卸载都会摘监听（不留孤儿 handler）', () => {
    expect(GRID).toContain('const onBlur = (): void => endMarquee(false)')
    expect(GRID.split('drag.detach()').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('卡片与列表行都带 data-asset-id（命中要能映射回 assetId）', () => {
    expect(GRID.split('data-asset-id={a.id}').length - 1).toBeGreaterThanOrEqual(2)
  })
})

describe('源码守卫 · 文件视图进出场动画', () => {
  it('进入 / 退出各有一个 stage，且网格不被卸载（无空白帧）', () => {
    expect(GRID).toContain('className="folder-stage folder-stage-enter absolute inset-0 z-20 flex flex-col"')
    expect(GRID).toContain('className="folder-stage folder-stage-leave absolute inset-0 z-20 flex flex-col"')
    // 网格与文件视图同帧渲染（文件视图是覆盖层，不是条件替换）
    expect(GRID).toContain("{view === 'list' ? list : grid}")
    // 旧的"硬切"（早退替换整块中栏）必须彻底消失
    expect(GRID).not.toContain('if (folderAsset) return')
  })

  it('stagger：20–30ms 递增、最多前 8 条封顶', () => {
    expect(GRID).toContain('const FOLDER_STAGGER_MS = 24')
    expect(GRID).toContain('const FOLDER_STAGGER_MAX_INDEX = 8')
    expect(GRID).toContain('Math.min(index, FOLDER_STAGGER_MAX_INDEX) * FOLDER_STAGGER_MS')
    expect(GRID).toContain('--folder-stagger')
    expect(CSS).toContain('animation-delay: var(--folder-stagger, 0ms)')
    // 每一条文件行 / 文件卡都挂上动画类
    expect(GRID.split('folder-anim-item').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('退出走上一份资产快照 + layoutEffect（否则会先看到一帧网格 = 硬切）', () => {
    expect(GRID).toContain('lastFolderAssetRef.current = folderAsset')
    expect(GRID).toContain('setFolderExitAsset(last)')
    expect(GRID).toContain('useLayoutEffect(() => {')
    expect(GRID).toContain('const duration = reducedMotion ? FOLDER_REDUCED_MS : FOLDER_EXIT_MS')
    // 2026-10-22：160 → 260。磁贴出场要"看得见"，卸载时刻必须 ≥ 舞台延迟淡出 + 出场错峰 + 磁贴时长，
    // 即 ≥ 120(舞台保持) / 96(错峰) + 150(磁贴) = 246ms，留 14ms 余量。
    expect(GRID).toContain('const FOLDER_EXIT_MS = 260')
    expect(GRID).toContain('const FOLDER_REDUCED_MS = 190')
    // reduced 必须**快于**普通档，不能出现"减少动效反而等更久"
    const exitMs = Number(/const FOLDER_EXIT_MS = (\d+)/.exec(GRID)?.[1])
    const reducedMs = Number(/const FOLDER_REDUCED_MS = (\d+)/.exec(GRID)?.[1])
    expect(exitMs).toBeGreaterThan(reducedMs)
  })

  it('CSS：出场是"看得见的磁贴飞出"，舞台延迟淡出 + 错峰 + 大位移', () => {
    // ① 舞台前 46% 保持不透明（否则整层淡出会把磁贴位移盖掉 —— 这就是用户说的"失效"）
    expect(CSS).toContain('animation: folder-stage-out 260ms')
    const stageOut = CSS.slice(CSS.indexOf('@keyframes folder-stage-out'), CSS.indexOf('@keyframes folder-fade-in'))
    expect(stageOut).toContain('46%')
    expect(stageOut.match(/opacity: 1/g)?.length ?? 0).toBeGreaterThanOrEqual(2) // 0% + 46% 都保持 1
    // ② 出场也读错峰（×0.5：12ms/条，最多 96ms），且位移量级够大
    expect(CSS).toContain('animation-delay: calc(var(--folder-stagger, 0ms) * 0.5)')
    const tileOut = CSS.slice(CSS.indexOf('@keyframes folder-tile-out'), CSS.indexOf('@keyframes folder-tile-slide-in'))
    expect(tileOut).toContain('translate3d(0, -26px, 0)')
    expect(tileOut).toContain('60%') // 前 60% 保持不透明：位移先跑完，再淡出
    const slideOut = CSS.slice(CSS.indexOf('@keyframes folder-tile-slide-out'), CSS.indexOf('@keyframes folder-tile-in-ultra'))
    expect(slideOut).toContain('translate3d(0, -20px, 0)')
    expect(slideOut).toContain('60%')
    // ③ reduced-motion 仍压成纯 opacity：舞台也换回纯淡出、错峰归零
    const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
    const reduced = CSS.slice(at)
    expect(reduced).toContain('animation-name: folder-fade-out !important')
    expect(reduced).toContain('animation-delay: 0ms !important')
  })

  it('CSS：三档 motionQuality 的差异都在 data-motion 选择器里', () => {
    expect(CSS).toContain('[data-motion=\'smooth\'][data-folder-anim=\'enter\'] .folder-anim-item')
    expect(CSS).toContain('[data-motion=\'ultra\'][data-folder-anim=\'enter\'] .folder-anim-item')
    // 标准档 = 默认 keyframes（无模糊）
    expect(CSS).toContain('@keyframes folder-tile-in')
    expect(CSS).toContain('rotateY(-8deg) scale(0.96)')
    expect(CSS).toContain('@keyframes folder-tile-out')
    // 2026-10-22：出场位移 6px→26px、放大量 3%→6%、前倾 4°→7°（6px 在 184px 卡上只有 3%，等于没动）
    expect(CSS).toContain('rotateY(7deg) scale(1.06)')
    expect(CSS).toContain('@keyframes folder-tile-in-ultra')
    expect(CSS).toContain('filter: blur(2px)')
    // 2026-10-22 决策反转：流畅档**也要磁贴语言**（位移+缩放），不再是纯 opacity。
    // 用户原话：「流畅档位是应该有这个磁贴语言的」。这条守卫正着钉住新契约。
    expect(CSS).toContain('@keyframes folder-tile-slide-in')
    expect(CSS).toContain('@keyframes folder-tile-slide-out')
    expect(CSS).toContain('animation-name: folder-tile-slide-in')
    expect(CSS).toContain('animation-name: folder-tile-slide-out')
    // 错峰：JS 写 24ms，流畅档在 CSS 里乘 0.67 收到约 16ms（不新增 TS 常量）
    expect(CSS).toContain('calc(var(--folder-stagger, 0ms) * 0.67)')
    // folder-fade-* 只保留给「减少动效」的兜底，不再是任何档位的入场动画
    expect(CSS).toContain('@keyframes folder-fade-in')
    expect(CSS).toContain('animation-name: folder-fade-in !important')
  })

  it('prefers-reduced-motion：全部退化成 190ms 纯 opacity、取消延迟', () => {
    const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = CSS.slice(at)
    expect(block).toContain('animation-duration: 190ms !important')
    expect(block).toContain('animation-delay: 0ms !important')
    expect(block).toContain('transform: none !important')
  })

  it('退出动画不阻塞点击（飞出期间点网格立即响应）', () => {
    const at = CSS.indexOf('.folder-stage-leave')
    expect(at).toBeGreaterThan(-1)
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    expect(rule).toContain('pointer-events: none')
  })
})
