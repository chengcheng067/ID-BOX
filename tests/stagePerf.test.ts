/**
 * 舞台双击性能 + 白球修复的**源码守卫**（2026-10，用户反馈：双击掉帧 / 白球一闪）。
 *
 * 为什么只能扫源码：这两条修复的全部价值都在"React 生命周期 + 真实 rAF 时序"里，
 * node 环境跑不了 WebGL，也没有可观测的 GPU 上传。能守住的是**结构约束**：
 *
 * ① renderer 只在 `deps: []` 的 effect 里创建（换资产只换贴图，不重建上下文）；
 * ② `applyMaps()` 一进来就把 `mapsReady` 置回 false（否则复用场景时 isReady() 撒谎）；
 * ③ opening 先摆起手位、opacity 保持 0，等 isReady()（上限 400ms）并让出一帧后才显示，
 *    且 340ms 时间轴的逐帧数学一字未变。
 *
 * 这些断言刻意钉"意图"而非行号：重构可以移动代码，但不能退回旧结构。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const BALL = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/MaterialBall.tsx'),
  'utf-8'
)
const STAGE = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/MaterialStage.tsx'),
  'utf-8'
)
const GRID = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/AssetGrid.tsx'),
  'utf-8'
)
const DLG = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/CustomRenderDialog.tsx'),
  'utf-8'
)

/** 取以 `marker` 为锚点、向前找最近 `useEffect(`、向后找 `endMark` 的那一段 */
function effectBlock(src: string, marker: string, endMark: string): string {
  const at = src.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const head = src.lastIndexOf('useEffect(', at)
  const tail = src.indexOf(endMark, at)
  expect(head).toBeGreaterThan(-1)
  expect(tail).toBeGreaterThan(at)
  return src.slice(head, tail + endMark.length)
}

describe('MaterialBall：renderer 只建一次，换资产只换贴图', () => {
  it('组件里的 BallScene 建在 deps 为 [] 的 effect 里（卸载才 dispose）', () => {
    const mount = effectBlock(
      BALL,
      'ball = new BallScene(canvas, { shape, interactive: true })',
      '}, [])'
    )
    expect(mount).toContain('new ResizeObserver(fit)')
    expect(mount).toContain('ball.startLoop()')
    // 挂载 effect 里不允许加载贴图：贴图归 effect B，否则会重复加载一次
    expect(mount).not.toContain('applyMaps')
  })

  it('换资产那个 effect（deps: [urlsKey, alphaMapEnabled]）只 applyMaps，不重建场景', () => {
    // 0.7.6 起 deps 多了 `alphaMapEnabled`（灰度透明开关要能重新收集 entries），
    // 守卫的**意图不变**：这个 effect 只 applyMaps、不重建场景。
    const swap = effectBlock(
      BALL,
      'ballRef.current?.applyMaps(urlsRef.current)',
      '}, [urlsKey, alphaMapEnabled])'
    )
    expect(swap).toContain('applyMaps')
    expect(swap).not.toContain('new BallScene')
    expect(swap).not.toContain('.dispose()')
  })

  it('挂载 effect 的 cleanup 归还上下文（dispose + canvas.remove + ro.disconnect）', () => {
    const mount = effectBlock(
      BALL,
      'ball = new BallScene(canvas, { shape, interactive: true })',
      '}, [])'
    )
    const cleanup = mount.slice(mount.indexOf('return () => {'))
    expect(cleanup).toContain('ro.disconnect()')
    expect(cleanup).toContain('ball.dispose()')
    expect(cleanup).toContain('canvas.remove()')
    // api 引用必须同时置空，否则舞台拿着已 dispose 的实例
    expect(cleanup).toContain('apiRefRef.current.current = null')
  })

  it('applyMaps() 第一件事是把 mapsReady 置回 false（在 dispose 旧贴图之前）', () => {
    const at = BALL.indexOf('applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    expect(at).toBeGreaterThan(-1)
    const head = BALL.slice(at, BALL.indexOf('\n  }', at))
    const flag = head.indexOf('this.mapsReady = false')
    expect(flag).toBeGreaterThan(-1)
    expect(flag).toBeLessThan(head.indexOf('for (const t of this.maps) t.dispose()'))
  })

  it('过期的贴图加载不会贴到新资产上（代次令牌）', () => {
    const at = BALL.indexOf('private async loadMap(')
    expect(at).toBeGreaterThan(-1)
    const head = BALL.slice(at, BALL.indexOf('\n  }', at))
    expect(head).toContain('gen !== this.mapsGen')
    expect(head).toContain('tex.dispose()')
  })

  /**
   * 第三批：`isReady()` 语义收窄成「albedo 落定即可上屏」，但返回的 Promise 仍等全部槽位。
   * 这两条必须同时成立：前者决定舞台何时显示，后者决定离屏封面/缩略图会不会缺图。
   */
  it('albedo 优先就绪：mapsReady 在 albedo 完成回调里置真', () => {
    const at = BALL.indexOf('applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    expect(at).toBeGreaterThan(-1)
    const body = BALL.slice(at, BALL.indexOf('\n  }', at))
    expect(body).toMatch(/const markReady = \(\): void => \{[\s\S]*this\.mapsReady = true/)
    expect(body).toContain("if (slot === 'albedo') markReady()")
    // 无 albedo 的资产保持旧口径（全部到齐才就绪）
    expect(body).toContain('if (!hasAlbedo) markReady()')
    expect(body).toContain('const hasAlbedo = entries.some(')
    // synthesizeNormalIfMissing 必须在 albedo 的 assignMap 之后（在回调里，不在 applyMaps 开头）
    const readyAt = body.indexOf('const markReady = ')
    expect(body.indexOf('this.synthesizeNormalIfMissing(urls)', readyAt)).toBeGreaterThan(readyAt)
  })

  it('Promise 语义不变：applyMaps 仍等全部槽位（离屏渲染依赖它）', () => {
    const at = BALL.indexOf('applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    const body = BALL.slice(at, BALL.indexOf('\n  }', at))
    // 0.7.6：alpha 项从并发批次里摘出来（同 URL 串行，避免解码两遍），
    // 但仍在这个 Promise 里被 await →「等全部槽位才 resolve」的语义不变。
    expect(body).toContain('const jobs = mapEntries.map(')
    expect(body).toContain('return Promise.all(jobs).then(')
    expect(body).toContain("await this.loadMap('alpha', alphaEntry[1], gen)")
    // 不能在 albedo 回调里提前 resolve / return
    expect(body).not.toContain('return Promise.resolve()\n    }')
  })
})

describe('AssetGrid：舞台预热抢跑（idle → 立即调度）', () => {
  it('舞台预热走 schedulePrewarmSoon（延迟由档位决定），拖拽卡片位图仍走 idle', () => {
    expect(GRID).toContain(
      'const schedulePrewarmSoon = (fn: () => void, delayMs: number): number =>'
    )
    expect(GRID).toContain('return window.setTimeout(fn, delayMs)')
    // 第四批：延迟由「动效性能」档位决定（极致 0ms / 其它 60ms），但入口必须仍是抢跑
    expect(GRID).toContain('schedulePrewarmSoon(')
    expect(GRID).toContain('() => stageController.preview(a.id)')
    expect(GRID).toContain('currentMotionProfile().eagerPrewarm ? 0 : 60')
    // 旧写法必须消失（否则抢跑等于没接上）
    expect(GRID).not.toContain('scheduleIdlePrewarm(() => stageController.preview(a.id))')
    // 拖拽卡片预热是画 canvas 的重活，必须继续留在 idle 里
    expect(GRID).toContain('dragCardTimer.current = scheduleIdlePrewarm(() => prewarmDragCard(a))')
  })
})

describe('MaterialStage：opening 就绪门控 + 让一帧', () => {
  const opening = STAGE.slice(
    STAGE.indexOf("if (phase !== 'opening' || !originRect) return"),
    // 0.6.2 起 deps 多了两个交接字段（结构变了，锚点跟着改；不删断言）
    STAGE.indexOf('}, [phase, originRect, asset?.id, handoffRect, handedOff])')
  )

  it('门控上限常量存在且 = 400ms（兜底放行，不能把双击卡死）', () => {
    expect(STAGE).toContain('const OPEN_READY_MS = 400')
    expect(opening).toContain('OPEN_READY_MS')
  })

  it('进 opening 先摆起手位且 opacity 仍为 0（不许一进来就显示）', () => {
    const hide = opening.indexOf("host.style.opacity = '0'")
    expect(hide).toBeGreaterThan(-1)
    expect(hide).toBeLessThan(opening.indexOf('place(start, COLD_Z0)'))
    // 统一 setOpacity('1') 的老写法必须已经拆掉：opening 的显示点在门控之后
    expect(STAGE).not.toContain('setRunning(true)\n    host.style.opacity')
  })

  it('轮询 isReady() 才放行，且放行后先让一帧再显示', () => {
    expect(opening).toContain('api.isReady()')
    const reveal = opening.slice(opening.indexOf('const reveal = '), opening.indexOf('const waitReady = '))
    const raf = reveal.indexOf('requestAnimationFrame(() => {')
    const show = reveal.indexOf("host.style.opacity = '1'")
    expect(raf).toBeGreaterThan(-1)
    expect(show).toBeGreaterThan(raf) // 显示发生在让出的那一帧里
    // 起动画 / 起厚度时钟也都在那一帧里：门控耗时不能吃进 340ms
    expect(reveal.indexOf('host.animate(')).toBeGreaterThan(show)
    expect(reveal.indexOf('const z0 = performance.now()')).toBeGreaterThan(show)
  })

  it('active / closing 仍然立刻可见（不能把落定球和返回动画一起藏掉）', () => {
    const active = STAGE.slice(
      STAGE.indexOf("if (phase === 'active')"),
      STAGE.indexOf("if (phase === 'closing')")
    )
    expect(active).toContain("host.style.opacity = '1'")
    const closing = STAGE.slice(
      STAGE.indexOf("if (phase === 'closing')"),
      STAGE.indexOf("if (phase !== 'opening'")
    )
    expect(closing).toContain("host.style.opacity = '1'")
    // 0.6.2：起点可以是弹窗位置（交接回来的球从那里起飞），终点仍是卡片
    expect(closing).toContain('animate(from, origin, CLOSE_MS')
    expect(closing).toContain('handoffRect ? rectToGeom(handoffRect) : readTarget()')
  })

  /**
   * 2026-10 第三批：轨迹从「JS 逐帧插值」改成 WAAPI（合成器线程）。
   * 旧断言（`lerpGeom(start, peak, …)` 三行逐字在）钉的是**已被推翻的结构**，
   * 这里改成钉新契约，不能删：三站 offset / 时长缓动 / onfinish / z 循环。
   */
  it('轨迹交给 WAAPI：三站 offset 对齐既有时间轴（0 / PEAK_AT / 1）', () => {
    expect(opening).toContain('host.animate(')
    expect(opening).toContain('{ transform: tf(poseOf(start)), offset: 0 }')
    expect(opening).toContain('{ transform: tf(poseOf(peak)), offset: PEAK_AT }')
    expect(opening).toContain('{ transform: tf(poseOf(slot)), offset: 1 }')
    // 原几何插值本来就是线性：加缓动会改变已验收的观感
    expect(opening).toContain('{ duration: OPEN_MS, easing: \'linear\', fill: \'both\' }')
    // 逐帧插值必须已经退出 opening（只在 closing 的 animate() 里还用它）
    expect(opening).not.toContain('lerpGeom')
  })

  it('动画结束（onfinish）才回执 onDone，且撤掉 fill 后把终态落成内联值', () => {
    const at = opening.indexOf('.onfinish = ')
    expect(at).toBeGreaterThan(-1)
    const handler = opening.slice(at, at + 600)
    expect(handler).toContain('flight.cancel()')
    expect(handler).toContain('place(slot, 1)')
    expect(handler).toContain('doneRef.current?.()')
    // 抢占后（seq 变了）不许再回执
    expect(handler).toContain('mySeq !== seqRef.current')
  })

  it('厚度 z 仍由主线程 rAF 驱动：时长 = OPEN_MS × PEAK_Z_AT，算法 unchanged', () => {
    expect(opening).toContain('/ (OPEN_MS * PEAK_Z_AT)')
    expect(opening).toContain('lerp(COLD_Z0, 1, easeOut(zt))')
    expect(opening).toContain('zRafRef.current = requestAnimationFrame(zStep)')
  })

  it('抢占纪律：idle / closing / opening 重入 / 卸载都 cancel 动画（≥3 处）', () => {
    const cancels = STAGE.split('animRef.current?.cancel()').length - 1
    expect(cancels).toBeGreaterThanOrEqual(3)
    // 卸载专用 effect 必须存在（fill:'both' 不 cancel 会留终态动画）
    expect(STAGE).toContain('() => () => {')
    expect(STAGE).toContain('cancelAnimationFrame(zRafRef.current)')
    // 重入时清掉上一轮内联 transform，避免与 place() 打架
    expect(opening).toContain("host.style.transform = ''")
  })

  it('所有 rAF 分支保留 seq 取消语义（idle / closing 可抢占 opening）', () => {
    expect(opening).toContain('mySeq !== seqRef.current')
    // 三处：reveal 外、让帧内、waitReady 内（少一处就会在抢占后继续写 style）
    const guards = opening.split('mySeq !== seqRef.current').length - 1
    expect(guards).toBeGreaterThanOrEqual(3)
    expect(opening).toContain('doneRef.current?.()')
  })
})

/**
 * 0.6.2：两件事的源码守卫（node 里跑不了 WAAPI / WebGL，只能钉接线与契约）。
 *
 * A 背景渐显遮罩：`#stage-veil` 由 MaterialStage 用 WAAPI 驱动，opening 之后才淡出；
 * B 交接：舞台球飞进「自定义渲染」弹窗的那颗球，关闭/保存时再从弹窗位置飞回卡片。
 */
describe('0.6.2 · 舞台遮罩（#stage-veil）', () => {
  it('遮罩节点由 App 挂出，静止值是 opacity:0（动画由舞台接管）', () => {
    const APP = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/App.tsx'),
      'utf-8'
    )
    expect(APP).toContain('id="stage-veil"')
    expect(APP).toContain('pointer-events-none absolute inset-0 z-40 bg-canvas')
    expect(APP).toContain('style={{ opacity: 0 }}')
  })

  it('MaterialStage 每次现取节点（不缓存），opening 淡出 / closing 淡入', () => {
    expect(STAGE).toContain("document.getElementById('stage-veil')")
    // opening：内容随球落地浮现
    expect(STAGE).toContain('[{ opacity: 1 }, { opacity: 0 }]')
    expect(STAGE).toContain('duration: OPEN_MS')
    // closing：内容在球飞回时隐去
    expect(STAGE).toContain('[{ opacity: 0 }, { opacity: 1 }]')
    expect(STAGE).toContain('duration: CLOSE_MS')
    // 两者都必须是 fill:'both'（否则 React 重渲染会把内联 opacity 打回去）
    expect(STAGE.split("fill: 'both'").length - 1).toBeGreaterThanOrEqual(3)
  })

  it('opening 之前遮罩已经是 1（不能先闪一帧完整内容），idle 复位成 0', () => {
    const at = STAGE.indexOf("if (phase !== 'opening' || !originRect) return")
    const gate = STAGE.indexOf('const gate0 = performance.now()', at)
    const setOpaque = STAGE.indexOf("veilAtStart.style.opacity = '1'", at)
    expect(setOpaque).toBeGreaterThan(at)
    expect(setOpaque).toBeLessThan(gate) // 门控之前（= 球上屏之前）就盖住了
    // idle：cancel 动画 + 落回内联 0
    const idle = STAGE.slice(STAGE.indexOf("if (phase === 'idle')"), STAGE.indexOf("if (phase === 'active')"))
    expect(idle).toContain('resetVeil()')
    expect(idle).toContain("veil.style.opacity = '0'")
  })

  it('blur 只在极致档加（默认档加回去等于把掉帧请回来）', () => {
    expect(STAGE).toContain("currentMotionProfile().id === 'ultra'")
    expect(STAGE).toContain("'blur(12px)'")
    expect(STAGE).toContain('color-mix(in srgb, var(--bg-canvas) 72%, transparent)')
  })
})

describe('0.6.2 · 舞台球 → 弹窗球交接', () => {
  it('handoff 分支：300ms + easeOutCubic（不用 linear），到位后隐身', () => {
    const at = STAGE.indexOf("if (phase === 'handoff')")
    expect(at).toBeGreaterThan(-1)
    const branch = STAGE.slice(at, STAGE.indexOf("if (phase === 'closing')", at))
    expect(branch).toContain('HANDOFF_MS')
    expect(branch).toContain('HANDOFF_EASING')
    expect(branch).toContain('rectToGeom(handoffRect)')
    expect(branch).toContain("host.style.opacity = '0'") // 到位即隐身，由弹窗球接管
    expect(branch).toContain('doneRef.current?.()')
    // 常量本身：300ms + cubic-bezier(0.215, 0.61, 0.355, 1)
    expect(STAGE).toContain('const HANDOFF_MS = 300')
    expect(STAGE).toContain("const HANDOFF_EASING = 'cubic-bezier(0.215, 0.61, 0.355, 1)'")
  })

  it('active 分支：handedOff 时球必须隐身（不许同时两颗）', () => {
    const at = STAGE.indexOf("if (phase === 'active')")
    const branch = STAGE.slice(at, STAGE.indexOf("if (phase === 'handoff')", at))
    expect(branch).toContain('if (handedOff)')
    expect(branch).toContain("host.style.opacity = '0'")
  })

  it('closing 起点优先用 handoffRect（从弹窗位置飞回，不是从槽位）', () => {
    const at = STAGE.indexOf("if (phase === 'closing')")
    const branch = STAGE.slice(at, STAGE.indexOf("if (phase !== 'opening'", at))
    expect(branch).toContain('handoffRect ? rectToGeom(handoffRect) : readTarget()')
    expect(branch).toContain("host.style.opacity = '1'") // 先复活
  })

  it('弹窗用球的投影直径发起交接，关闭/保存走"球回家"', () => {
    expect(DLG).toContain('sphereScreenDiameter()')
    expect(DLG).toContain('stageController.handoff(')
    expect(DLG).toContain('apiRef={ballApiRef}')
    // 0.6.3：关弹窗必须走 handback（回顶栏槽位），**不能**再走 close（回网格卡片）
    expect(DLG).toContain('stageController.handback()')
    expect(DLG).not.toContain('stageController.close()')
    // 先让舞台球复活（handback），再 120ms 后卸载弹窗
    const backAt = DLG.indexOf('stageController.handback()')
    const laterAt = DLG.indexOf('closeTimerRef.current = window.setTimeout(() => {')
    expect(backAt).toBeGreaterThan(-1)
    expect(laterAt).toBeGreaterThan(backAt)
    expect(DLG).toContain('}, 120)')
    // 关闭入口全部改走 beginClose（不许有直接 onClose 的残留）
    expect(DLG).not.toContain('onClick={onClose}')
  })

  it('舞台与弹窗用同一套渲染参数（否则飞回来那颗会"换个样子"）', () => {
    expect(STAGE).toContain('params={resolveRenderParams(shown)}')
  })
})

/**
 * 0.6.3 真 bug 修复：关弹窗后球必须飞回**顶栏槽位**并留在那里可见。
 * 这里钉住"两个方向两个终点"这条契约，防止再次误用 closing。
 */
describe('0.6.3 · 回槽位（handback）', () => {
  it('MaterialStage 有独立 handback 分支，终点是 readTarget()、复用 300ms/easeOutCubic', () => {
    const at = STAGE.indexOf("if (phase === 'handback')")
    expect(at).toBeGreaterThan(-1)
    // 必须排在 closing 之前（两者互斥，顺序错了 closing 会先吃掉）
    expect(at).toBeLessThan(STAGE.indexOf("if (phase === 'closing')"))
    const branch = STAGE.slice(at, STAGE.indexOf("if (phase === 'closing')", at))
    expect(branch).toContain('const to = readTarget()')
    expect(branch).toContain('rectToGeom(handoffRect)')
    expect(branch).toContain('HANDOFF_MS')
    expect(branch).toContain('HANDOFF_EASING')
    expect(branch).toContain("fill: 'both'")
    // 到位后必须保持可见（球留在槽位里）——这是 bug 的直接反面
    expect(branch).toContain("host.style.opacity = '1'")
    expect(branch).toContain('place(to, 1)')
    expect(branch).toContain('doneRef.current?.()')
    // 回槽位不碰遮罩（内容一直是可见状态）
    expect(branch).not.toContain('veil')
  })

  it('App 的 onDone 把 handback 收口到 settledHandback', () => {
    const APP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf-8')
    expect(APP).toContain("s.phase === 'handback'")
    expect(APP).toContain('stageController.settledHandback(s.runId)')
  })
})
