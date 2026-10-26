/**
 * 第二批性能修复（D + E）的**源码守卫**。
 *
 * 为什么只能扫源码：node 环境没有 WebGL，也没有可观测的 GPU 上传 / 解码线程占用。
 * 能守住的只有「结构约束」——它们一旦被退回，优化就悄悄消失了（而测试仍然全绿）：
 *
 * D（贴图池）：
 *  ① `applyMaps` 换资产时**归还**槽位贴图，不再无条件 dispose（只有自建贴图释放）；
 *  ② 池命中路径在 `fetch` **之前**（这就是「切回来 0ms」的全部来源）；
 *  ③ `dispose()` 必须 `disposeAll()`（renderer 都要销毁了，池里的贴图不能留着）。
 *
 * E（取消在途）：
 *  ④ `applyMaps` 每代先 `abort()` 上一代；
 *  ⑤ `signal` 透传到 `fetch` 与解码入口；
 *  ⑥ 取消 / 过期代次**静默**（不许 `console.warn` 刷日志）。
 *
 * G（舞台保持挂载）：⑦ 无 albedo 时传空槽位（灰球）而不是 `return null`。
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

/** 取类成员函数体：从签名到下一个 `\n  }`（类内方法都在两个空格缩进收尾） */
function memberBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('\n  }', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end)
}

/** 取模块级函数体：从签名到下一个列首的 `}`（`loadTexture` 是模块级函数） */
function moduleFnBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end)
}

describe('D · 跨资产贴图池：只归还、不 dispose，命中在 fetch 之前', () => {
  it('applyMaps 先 clearMaps 再归还槽位，且仍会释放自建贴图', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    const clear = body.indexOf('clearMaps(this.material)')
    const release = body.indexOf('this.releaseSlots()')
    const disposeOwned = body.indexOf('for (const t of this.maps) t.dispose()')
    expect(clear).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(clear) // 先摘材质引用，再归还（逐出可能立刻 dispose）
    expect(disposeOwned).toBeGreaterThan(release) // 自建贴图（合成法线 / 兜底）照旧释放
  })

  it('releaseSlots 只 release，绝不 dispose（池里还要用）', () => {
    const body = memberBody(BALL, 'private releaseSlots(): void {')
    expect(body).toContain('this.texPool.release(t)')
    expect(body).not.toContain('.dispose()')
  })

  it('loadTexture 在 fetch 之前查池（命中 = 零 IO、零解码、零上传）', () => {
    const body = moduleFnBody(BALL, 'async function loadTexture(')
    const take = body.indexOf('pool.take(poolKey)')
    const fetchCall = body.indexOf('fetchImpl:')
    expect(take).toBeGreaterThan(-1)
    expect(fetchCall).toBeGreaterThan(take)
    expect(body).toContain('texturePoolKey(url, MAX_TEX_PX, linear)')
    // 命中必须缓存"这张是池管的"，否则换资产时会被 dispose 掉
    expect(body).toContain('return { texture: cachedTex, pooled: true }')
  })

  it('loadMap 对池化贴图只归还，对自建贴图才 dispose', () => {
    const body = memberBody(BALL, 'private async loadMap(')
    expect(body).toContain('if (loaded.pooled) this.texPool.release(tex)')
    expect(body).toContain('else tex.dispose()')
    // 非池化贴图必须记进 this.maps，否则卸载时没人释放
    expect(body).toContain('if (!loaded.pooled) this.maps.push(tex)')
  })

  it('dispose() 释放整个池 + 取消在途加载', () => {
    const body = memberBody(BALL, 'dispose(): void {')
    expect(body).toContain('this.texPool.disposeAll()')
    expect(body).toContain('this.mapsAbort?.abort()')
  })

  it('对每张贴图做事的三个地方都走 liveTextures()（槽位贴图不在 this.maps 里了）', () => {
    expect(memberBody(BALL, 'private applyRepeat(): void {')).toContain('this.liveTextures()')
    expect(memberBody(BALL, 'applyMotionProfile(profile: MotionProfile): void {')).toContain(
      'this.liveTextures()'
    )
    const live = memberBody(BALL, 'private liveTextures(): Texture[] {')
    expect(live).toContain('this.slotTextures.values()')
    expect(live).toContain('this.maps')
  })
})

describe('E · 取消在途加载：每代一个 controller，越界结果静默丢弃', () => {
  it('applyMaps 先 abort 上一代，再建新的 controller，并把 signal 发下去', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    const abort = body.indexOf('this.mapsAbort?.abort()')
    const fresh = body.indexOf('new AbortController()')
    expect(abort).toBeGreaterThan(-1)
    expect(fresh).toBeGreaterThan(abort)
    expect(body).toContain('const signal = abort.signal')
    // 两条加载路径都必须带上 signal（mapEntries 与 alpha 单发）
    expect(body).toContain('await this.loadMap(slot, url, gen, signal)')
    expect(body).toContain("await this.loadMap('alpha', alphaEntry[1], gen, signal)")
  })

  it('signal 一路传到 fetch 与解码入口（解码不可中断，但"还没开始"的必须判掉）', () => {
    const body = moduleFnBody(BALL, 'async function loadTexture(')
    expect(body).toContain('fetch(u, signal ? { signal } : undefined)')
    expect(body).toContain('if (signal?.aborted === true) throw abortError()')
    // TextureLoader 不支持取消：进入兜底之前必须再判一次
    const flag = body.indexOf('if (signal?.aborted) return null')
    expect(flag).toBeGreaterThan(-1)
    expect(flag).toBeLessThan(body.indexOf('new Promise'))
  })

  it('取消是预期路径：不退回 TextureLoader、不打 warn', () => {
    const body = moduleFnBody(BALL, 'async function loadTexture(')
    expect(body).toContain('if (isAbortError(err) || signal?.aborted) return null')
    const loadMap = memberBody(BALL, 'private async loadMap(')
    const silent = loadMap.indexOf('if (signal?.aborted === true || gen !== this.mapsGen) return')
    const warn = loadMap.indexOf('console.warn')
    expect(silent).toBeGreaterThan(-1)
    expect(warn).toBeGreaterThan(silent) // 静默判定必须在 warn 之前
  })
})

describe('G · 无 albedo 时渲灰球、保持挂载（不卸载、不重建上下文）', () => {
  it('没有 albedo 时传空槽位（纯灰球），不是 return null', () => {
    expect(STAGE).toContain('const EMPTY_SLOTS: MaterialSlots = {}')
    expect(STAGE).toContain(
      'const ballSlots = renderable && shownSlots !== null ? shownSlots : EMPTY_SLOTS'
    )
    // 组件只在「一个资产都没见过」时卸载（真正的空态）
    expect(STAGE).toContain('if (!shown) return null')
    expect(STAGE).not.toContain('if (!renderable) return null')
  })

  it('不可渲时只隐藏 + 停帧，**不 dispose**（上下文与共享 envMap 留着）', () => {
    const block = STAGE.slice(
      STAGE.indexOf('if (!renderable) {'),
      STAGE.indexOf("if (phase === 'idle')")
    )
    expect(block).toContain("host.style.opacity = '0'")
    expect(block).toContain("host.style.pointerEvents = 'none'")
    expect(block).toContain('api?.setRunning(false)')
    expect(block).not.toContain('dispose()')
    // 相位必须照常回执，否则 App 永远停在 opening
    expect(block).toContain("if (phase === 'opening' || phase === 'closing') doneRef.current?.()")
  })

  // 0.7.8 T-ZSTACK 翻转了这条规格：本批就是"下一批"。
  // 60 → 45：球是 pointer-events:none 的纯装饰，必须低于所有弹窗（基座 50），
  // 否则打开设置/渲染弹窗时球浮在弹窗之上（用户 2026-10-26 真机截图）。
  it('zIndex 45（低于全部弹窗，高于全部内容层）', () => {
    expect(STAGE).toContain('zIndex: 45')
    expect(STAGE).not.toContain('zIndex: 60')
  })
})
