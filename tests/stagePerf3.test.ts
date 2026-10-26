/**
 * 第三批舞台球性能（B5 / B2 / B4）的守卫。
 *
 * node 环境没有 WebGL，也没有可观测的 shader 重编译 / 解码线程占用；能守住的是
 * **判定规则**（纯逻辑，直接单测）与**接线结构**（源码守卫）。三条都容易被"看起来
 * 更整洁"的重构悄悄退回，而测试仍然全绿：
 *
 * - **B5 定义集签名**：`material.needsUpdate = true` 只能出现在"定义集真的变了"的分支里。
 *   一旦有人把它搬回 `loadMap` 的尾部（换贴图就置），每次来回切资产都会重编译一次
 *   （冷启 5 槽 42ms 量级）。
 * - **B2 roughness 门控**：声明了 roughness 槽但贴图未到的那几毫秒，不许走"无 map 口径"
 *   （0.5 × 1.7 = 0.85）——那正是用户看到的粗糙度跳变。
 * - **B4 延迟槽位**：只有 ao / displacement 可以延迟；核心三槽必须仍在主 Promise 里；
 *   离屏渲染（`eagerMaps`）必须拿全量，否则卡片球图会缺 AO 并被烤进缓存。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConcurrencyLimiter,
  DEFERRED_IDLE_TIMEOUT_MS,
  DEFERRED_SLOT_KEYS,
  MAX_PARALLEL_MAP_LOADS,
  defineKey,
  defineSetFromSlots,
  defineSetOfMaterial,
  isDeferredSlot,
  scheduleIdleTask,
  shouldHoldRoughness
} from '../src/renderer/logic/textureLoadQueue'

const BALL = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/MaterialBall.tsx'),
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

// ── B5 · 定义集签名 ──────────────────────────────────────────────────────────

describe('B5 · 定义集签名：只有 define 变化才重编译', () => {
  const base = { transparent: false, alphaTest: 0, side: 0 }

  it('同一组槽位 → 同一个签名（换的是哪张贴图与签名无关）', () => {
    const a = defineSetFromSlots(['albedo', 'normal', 'roughness'], base)
    const b = defineSetFromSlots(['roughness', 'albedo', 'normal'], base)
    expect(defineKey(a)).toBe(defineKey(b))
  })

  it('增删任何一个槽位都会改签名（这些才是参与 #ifdef 的事实）', () => {
    const three = defineKey(defineSetFromSlots(['albedo', 'normal', 'roughness'], base))
    expect(defineKey(defineSetFromSlots(['albedo', 'normal'], base))).not.toBe(three)
    expect(defineKey(defineSetFromSlots(['albedo', 'normal', 'roughness', 'ao'], base))).not.toBe(
      three
    )
    expect(
      defineKey(defineSetFromSlots(['albedo', 'normal', 'roughness', 'displacement'], base))
    ).not.toBe(three)
    expect(defineKey(defineSetFromSlots(['albedo', 'normal', 'roughness', 'alpha'], base))).not.toBe(
      three
    )
  })

  it('transparent / alphaTest / side 也并入签名（否则它们能绕过门控）', () => {
    const slots = ['albedo', 'normal']
    const plain = defineKey(defineSetFromSlots(slots, base))
    expect(defineKey(defineSetFromSlots(slots, { ...base, transparent: true }))).not.toBe(plain)
    expect(defineKey(defineSetFromSlots(slots, { ...base, alphaTest: 0.5 }))).not.toBe(plain)
    expect(defineKey(defineSetFromSlots(slots, { ...base, side: 2 }))).not.toBe(plain)
  })

  it('defineSetOfMaterial：读的是"挂没挂"，不是"有没有声明"', () => {
    const tex = { id: 'tex' }
    const empty = defineSetOfMaterial({
      map: null,
      normalMap: null,
      roughnessMap: null,
      aoMap: null,
      displacementMap: null,
      alphaMap: null,
      transparent: false,
      alphaTest: 0,
      side: 0
    })
    const full = defineSetOfMaterial({
      map: tex,
      normalMap: tex,
      roughnessMap: tex,
      aoMap: tex,
      displacementMap: tex,
      alphaMap: tex,
      transparent: true,
      alphaTest: 0.5,
      side: 2
    })
    expect(defineKey(empty)).not.toBe(defineKey(full))
    expect(empty.albedo).toBe(false)
    expect(full.albedo).toBe(true)
    expect(full.alphaTest).toBe(true)
    expect(empty.alphaTest).toBe(false)
  })

  it('needsUpdate 只能出现在"定义集变了"的分支里（不许搬回 loadMap 尾部）', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    const at = body.indexOf('if (declaredDefineKey !== this.currentDefineKey) {')
    expect(at).toBeGreaterThan(-1)
    // 分支体：到 armRoughnessHold() 之前（这一段覆盖 clearMaps / 归还 / 自建贴图释放 / needsUpdate）
    const branch = body.slice(at, body.indexOf('this.armRoughnessHold()'))
    expect(branch).toContain('clearMaps(this.material)')
    expect(branch).toContain('this.releaseSlots()')
    expect(branch).toContain('this.material.needsUpdate = true')
    // 归还顺序不变：先摘材质引用，再归还（逐出可能立刻 dispose），最后释放自建贴图
    expect(branch.indexOf('this.releaseSlots()')).toBeGreaterThan(branch.indexOf('clearMaps'))
    expect(branch.indexOf('for (const t of this.maps) t.dispose()')).toBeGreaterThan(
      branch.indexOf('this.releaseSlots()')
    )
  })

  it('loadMap 尾部不再直接置 needsUpdate，改走 syncMaterialDefines()', () => {
    const body = memberBody(BALL, 'private async loadMap(')
    expect(body).toContain('this.syncMaterialDefines()')
    expect(body).not.toContain('this.material.needsUpdate = true')
  })

  it('syncMaterialDefines 的语义：签名相同就 return（不置），不同才置', () => {
    const body = memberBody(BALL, 'private syncMaterialDefines(): void {')
    const guard = body.indexOf('if (this.currentDefineKey === next) return')
    const write = body.indexOf('this.material.needsUpdate = true')
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
    expect(body).toContain('const next = this.readDefineKey()')
  })

  it('"定义集没变"时不摘旧贴图（否则签名会短暂变空集 → 照样重编译）', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    // clearMaps 必须在 if 里面（外层无条件调用会让 B5 的收益归零）
    const ifAt = body.indexOf('if (declaredDefineKey !== this.currentDefineKey) {')
    const clearAt = body.indexOf('clearMaps(this.material)')
    expect(clearAt).toBeGreaterThan(ifAt)
  })

  it('单图资产预判时把"合成法线"算进定义集（最常见的切换才吃得到 B5）', () => {
    const at = BALL.indexOf('function predictedDefineSlots(')
    expect(at).toBeGreaterThan(-1)
    const body = BALL.slice(at, BALL.indexOf('\n}', at))
    expect(body).toContain("has.has('albedo')")
    expect(body).toContain("!has.has('normal')")
    expect(body).toContain("out.push('normal')")
    // 预判必须在 applyMaps 里生效（不是写了没人用）
    expect(memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')).toMatch(
      /defineSetFromSlots\(\s*predictedDefineSlots\(/
    )
  })
})

// ── B2 · roughness 等待门控 ──────────────────────────────────────────────────

describe('B2 · 声明了 roughness 但 map 未到：按住不写（方案甲）', () => {
  it('shouldHoldRoughness 只在"声明了 + 还没到 + 未落定"时为真', () => {
    expect(shouldHoldRoughness(true, false, false)).toBe(true)
    expect(shouldHoldRoughness(true, true, false)).toBe(false) // 已经挂上了
    expect(shouldHoldRoughness(true, false, true)).toBe(false) // 已落定（失败也要降级）
    expect(shouldHoldRoughness(false, false, false)).toBe(false) // 本批没声明
  })

  it('applyParams 在按住时写"布防时呈现的值"，不写刚算出的无 map 值', () => {
    const body = memberBody(BALL, 'private applyParams(values: MaterialParamValues): void {')
    // 按住分支里必须用 heldRoughness（而不是 values.roughness / 0.85）
    expect(body).toMatch(
      /if \(this\.holdRoughness\) \{[\s\S]{0,900}?this\.material\.roughness = Math\.min\(1, Math\.max\(0, this\.heldRoughness \* ratio\)\)/
    )
    const branch = body.slice(body.indexOf('if (this.holdRoughness) {'))
    expect(branch.slice(0, branch.indexOf('setAlphaInvert'))).not.toContain(
      'this.material.roughness = values.roughness'
    )
  })

  it('armRoughnessHold 布防时记录"此刻材质上真实呈现的值"', () => {
    const body = memberBody(BALL, 'private armRoughnessHold(): void {')
    expect(body).toContain('this.heldRoughness = Number.isFinite(this.material.roughness)')
    expect(body).toContain('this.heldRoughnessMult = effectiveRoughness(')
  })

  it('applyMaps 收集"声明槽位"并在摘贴图之后布防', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    expect(body).toContain('this.declaredSlots = new Set(entries.map(([slot]) => slot))')
    const clear = body.indexOf('clearMaps(this.material)')
    const arm = body.indexOf('this.armRoughnessHold()')
    expect(arm).toBeGreaterThan(clear) // 摘完贴图才知道"map 到没到"
  })

  it('armRoughnessHold 的判据走纯函数，且以"声明了 roughness"为前提', () => {
    const body = memberBody(BALL, 'private armRoughnessHold(): void {')
    expect(body).toContain('shouldHoldRoughness(')
    expect(body).toContain("this.declaredSlots.has('roughness')")
    expect(body).toContain('this.material.roughnessMap !== null')
  })

  it('roughness 贴图一到就解除门控（不等 settle，避免"贴图在了反光没变"）', () => {
    const body = memberBody(BALL, 'private async loadMap(')
    expect(body).toContain("if (slot === 'roughness')")
    expect(body).toContain('this.holdRoughness = false')
    expect(body).toContain('this.setParamBasis({ hasRoughnessMap: true })')
  })

  it('落定时无条件解除（加载失败也要退回"无 map 口径"，不能锁死在中性值）', () => {
    const body = memberBody(BALL, 'private settleParamBasis(): void {')
    const release = body.indexOf('this.holdRoughness = false')
    const apply = body.indexOf('this.applyParams(')
    expect(release).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(release)
  })
})

// ── B4 · 延迟槽位 + 并发上限 + eager ─────────────────────────────────────────

describe('B4 · ao/disp 走 idle，核心三槽仍在主 Promise', () => {
  it('延迟槽位集合只有 ao / displacement（albedo/normal/roughness 一秒都不许等）', () => {
    expect([...DEFERRED_SLOT_KEYS].sort()).toEqual(['ao', 'displacement'])
    expect(isDeferredSlot('ao')).toBe(true)
    expect(isDeferredSlot('displacement')).toBe(true)
    for (const slot of ['albedo', 'normal', 'roughness', 'alpha']) {
      expect(isDeferredSlot(slot)).toBe(false)
    }
  })

  it('并发上限 = 3，且 idle 兜底超时是有限的（不许无限等）', () => {
    expect(MAX_PARALLEL_MAP_LOADS).toBe(3)
    expect(DEFERRED_IDLE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DEFERRED_IDLE_TIMEOUT_MS)).toBe(true)
  })

  it('applyMaps：主 Promise 仍等核心槽，ao/disp 单独成批', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    // 核心槽进 mapEntries（老断言依赖 `const jobs = mapEntries.map(` 的字面形式）
    expect(body).toContain('const jobs = mapEntries.map(')
    expect(body).toContain('isDeferredSlot(slot)')
    // 延迟批次在主 Promise 的 then 里开跑（不参与它）
    const jobsAt = body.indexOf('return Promise.all(jobs).then(')
    const deferredAt = body.indexOf('this.deferredReady = this.loadDeferredMaps(')
    expect(jobsAt).toBeGreaterThan(-1)
    expect(deferredAt).toBeGreaterThan(jobsAt)
  })

  it('eager（离屏）时延迟分流整体失效：ao/disp 回到主 Promise', () => {
    const body = memberBody(BALL, 'applyMaps(urls: MaterialSlotUrls): Promise<void> {')
    expect(body).toContain('const deferredEntries = this.eagerMaps')
    expect(body).toContain('? []')
    expect(body).toContain('const mapEntries = this.eagerMaps')
    // eager → allMapEntries（全量，含 ao/disp）
    expect(body).toContain('? allMapEntries')
  })

  it('构造默认：preserveDrawingBuffer（离屏）⇒ eagerMaps 为真', () => {
    expect(BALL).toContain('this.eagerMaps = opts.eagerMaps === true || opts.preserveDrawingBuffer === true')
    expect(BALL).toContain('eagerMaps?: boolean')
  })

  it('★验收红线：renderBallBlob（卡片球图 / 封面）显式 eagerMaps: true', () => {
    const at = BALL.indexOf('async function renderBallBlob(')
    expect(at).toBeGreaterThan(-1)
    const body = BALL.slice(at, BALL.indexOf('\n}', at))
    expect(body).toContain('preserveDrawingBuffer: true')
    expect(body).toContain('eagerMaps: true')
    // 离屏路径仍然是"await applyMaps 之后立刻 renderOnce"
    const apply = body.indexOf('await ball.applyMaps(urls)')
    const render = body.indexOf('ball.renderOnce()')
    expect(apply).toBeGreaterThan(-1)
    expect(render).toBeGreaterThan(apply)
  })

  it('loadDeferredMaps 走 scheduleIdleTask（带 timeout），且永不 reject', () => {
    const body = memberBody(BALL, 'private loadDeferredMaps(')
    expect(body).toContain('scheduleIdleTask(')
    expect(body).toContain('new ConcurrencyLimiter(MAX_PARALLEL_MAP_LOADS)')
    // 代次 / 取消 / 卸载都当场 resolve（不让等待方挂住）
    expect(body).toContain('this.disposed || gen !== this.mapsGen || signal?.aborted === true')
    expect(body).toContain('() => resolve(),')
  })

  it('whenDeferredReady() 暴露全量落定（applyMaps 的 resolve 语义不承担它）', () => {
    expect(BALL).toContain('whenDeferredReady(): Promise<void> {')
    expect(memberBody(BALL, 'whenDeferredReady(): Promise<void> {')).toContain(
      'return this.deferredReady'
    )
  })
})

describe('B4 · idle 调度回退链（rIC → setTimeout(0) → 同步）', () => {
  it('有 requestIdleCallback 时带 timeout 用它', () => {
    const calls: Array<{ timeout?: number }> = []
    scheduleIdleTask(
      () => undefined,
      {
        requestIdleCallback: (_cb, opts) => {
          calls.push(opts ?? {})
          return 1
        },
        setTimeout: () => 2
      },
      123
    )
    expect(calls).toEqual([{ timeout: 123 }])
  })

  it('没有 rIC（老内核 / 测试环境）回退 setTimeout(0)', () => {
    const delays: number[] = []
    scheduleIdleTask(
      () => undefined,
      {
        requestIdleCallback: undefined,
        setTimeout: (_cb, ms) => {
          delays.push(ms)
          return 1
        }
      },
      123
    )
    expect(delays).toEqual([0])
  })

  it('rIC 存在但调用即抛 → 回退 setTimeout，不丢任务', () => {
    const delays: number[] = []
    scheduleIdleTask(
      () => undefined,
      {
        requestIdleCallback: () => {
          throw new Error('not implemented')
        },
        setTimeout: (_cb, ms) => {
          delays.push(ms)
          return 1
        }
      }
    )
    expect(delays).toEqual([0])
  })

  it('两个调度器都没有 → 同步执行（宁可同步，也绝不丢任务）', () => {
    let ran = 0
    scheduleIdleTask(
      () => {
        ran += 1
      },
      { requestIdleCallback: undefined, setTimeout: undefined }
    )
    expect(ran).toBe(1)
  })
})

describe('B4 · 并发闸门：先进先出、峰值不超过上限', () => {
  it('6 个任务、上限 3：并发峰值 = 3，全部完成，顺序是先进先出', async () => {
    const limiter = new ConcurrencyLimiter(3)
    let active = 0
    let peak = 0
    const started: number[] = []
    const releases: Array<() => void> = []
    const tasks = Array.from({ length: 6 }, (_, i) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(i)
            active += 1
            peak = Math.max(peak, active)
            releases.push(() => {
              active -= 1
              resolve(i)
            })
          })
      )
    )
    // 前三格被占满，后三个在排队
    expect(started).toEqual([0, 1, 2])
    expect(limiter.pending).toBe(3)
    // 逐个放行：每放开一个，队头补一个
    while (releases.length > 0) {
      const next = releases.shift()
      if (next) next()
      await Promise.resolve()
      await Promise.resolve()
    }
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(3)
    expect(started).toEqual([0, 1, 2, 3, 4, 5])
    expect(limiter.running).toBe(0)
  })

  it('任务 reject 也归还名额（不许把闸门卡死）', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const bad = limiter.run(() => Promise.reject(new Error('boom')))
    await expect(bad).rejects.toThrow('boom')
    // 失败之后第二个任务仍能开跑
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(limiter.running).toBe(0)
  })

  it('任务同步抛错：调用方收到 reject，闸门不泄漏名额', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const syncThrow = limiter.run<string>(() => {
      throw new Error('sync')
    })
    await expect(syncThrow).rejects.toThrow('sync')
    await expect(limiter.run(() => Promise.resolve('after'))).resolves.toBe('after')
    expect(limiter.running).toBe(0)
  })

  it('上限 <= 0 时按 1 处理（否则任务永远不开始，applyMaps 会挂死）', async () => {
    const limiter = new ConcurrencyLimiter(0)
    await expect(limiter.run(() => Promise.resolve(1))).resolves.toBe(1)
  })
})
