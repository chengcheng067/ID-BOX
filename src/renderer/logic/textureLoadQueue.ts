/**
 * 舞台球第三批性能（B5 / B2 / B4）的**纯逻辑**：定义集签名、roughness 等待门控、
 * 延迟槽位判定、并发闸门与 idle 调度。
 *
 * ── 为什么单独抽一个模块（而不是散在 `MaterialBall.tsx` 里）──────────────────
 * `MaterialBall.tsx` 需要 three / DOM 才能跑；而这三条修复的**判定规则**本身
 * 与 GPU 无关，全部可以在 node 里单测：
 *
 * - **B5 定义集签名**：`material.needsUpdate = true` 会让 three 走一遍 shader define
 *   比对 + 可能的 program 重编译（5 槽冷启一次 42ms 量级）。真正需要重编译的只有
 *   「哪些槽有图 / transparent / alphaTest / side」这类**参与 `#ifdef` 的定义**；
 *   同一个槽从 A 图换成 B 图（uniform 换引用）**不需要**。所以把定义集压成一个字符串
 *   签名，只在签名变化时置 `needsUpdate`。
 * - **B2 roughness 门控**：本批**声明了** roughness 槽但贴图还没到 → 这一小段窗口里
 *   不要用「无 map 口径」（`base × mult` = 0.5 × 1.7 = 0.85）去呈现，而是沿用上一份
 *   材质的 roughness（首次加载 = 构造时的中性基准），等 map 到了再切一次。
 * - **B4 延迟槽位**：`ao` / `displacement` 对「第一眼质感」的贡献远小于
 *   albedo / normal / roughness，把它们推到 idle 并限并发，能把冷启尖峰摊开。
 * - **并发闸门**：5 个槽同时 fetch + 解码会互相抢带宽（docs/26 §2.2c）。
 *
 * 刻意**不 import three**：`MaterialDefineSource` 用结构类型描述材质（three 的
 * `MeshPhysicalMaterial` 结构上满足），这样测试传普通对象即可。
 */

// ── B4 · 延迟槽位与并发上限 ───────────────────────────────────────────────────

/**
 * 可以推到 idle 的槽位（docs/29 §5 B4）。
 *
 * ⚠️ 只能放「不影响剪影与第一眼质感」的槽：`albedo`/`normal`/`roughness` 决定颜色、
 * 凹凸与反光，晚到一眼就能看出来。`ao` 只压暗缝隙、`displacement` 只在球面上做微浮雕
 * （基准 0.04，见 `BallScene.baseDisplacementScale`）。
 */
export const DEFERRED_SLOT_KEYS: readonly string[] = ['ao', 'displacement']

/** 该槽位是否可以延迟到 idle（离屏渲染的 `eager` 路径会整体关掉这条规则） */
export function isDeferredSlot(slot: string): boolean {
  return DEFERRED_SLOT_KEYS.includes(slot)
}

/**
 * 同时进行的贴图加载数上限（B4）。
 *
 * 3 的依据：核心三槽（albedo / normal / roughness）本来就该同时跑；5 槽并发时
 * fetch 与解码互相抢（docs/26 §2.2c 的 5 槽 81ms + 42ms 里有一大截是排队），
 * 限 3 之后核心槽不必等 ao/disp 让出的带宽，而 ao/disp 本来就走 idle。
 */
export const MAX_PARALLEL_MAP_LOADS = 3

/**
 * 并发闸门（先进先出）。
 *
 * 语义：
 * - `run(task)` 立刻返回 Promise；任务在**有空位**时才开始（不是先跑再排队）；
 * - 任务同步抛错 / reject 都会归还名额（`finally`），不会把闸门卡死；
 * - `max < 1` 时按 1 处理（否则任务永远不开始，`applyMaps` 会永久挂起）。
 *
 * 纯逻辑（无 three / DOM），可直接单测并发峰值。
 */
export class ConcurrencyLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []
  private readonly limit: number

  constructor(max: number) {
    const n = Math.floor(Number.isFinite(max) ? max : 1)
    this.limit = n >= 1 ? n : 1
  }

  /** 正在跑的任务数（测试断言并发峰值用） */
  get running(): number {
    return this.active
  }

  /** 还在排队、尚未开始的任务数 */
  get pending(): number {
    return this.queue.length
  }

  /** 排队执行一个任务；返回它的结果 Promise */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1
        let result: Promise<T>
        try {
          result = task()
        } catch (err) {
          // 同步抛错也要归还名额，否则闸门永久少一格
          this.active -= 1
          this.drain()
          reject(err)
          return
        }
        result.then(resolve, reject).finally(() => {
          this.active -= 1
          this.drain()
        })
      }
      if (this.active < this.limit) start()
      else this.queue.push(start)
    })
  }

  /** 归还名额后尽量把队列头部拉起来 */
  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next !== undefined) next()
    }
  }
}

// ── B4 · idle 调度（带 timeout 兜底，绝不无限等） ─────────────────────────────

/**
 * idle 回调的**兜底超时**。
 *
 * 为什么必须有：隐藏窗口 / 后台标签 / 省电模式下 `requestIdleCallback` 可能几秒不回调，
 * 而 `applyMaps` 的「全量就绪」承诺要能被等待方（`whenDeferredReady()`）在有限时间内兑现。
 * 200ms 远大于一次空闲窗口的间隔，又短到用户感觉不到「AO 没上」。
 */
export const DEFERRED_IDLE_TIMEOUT_MS = 200

/** 调度器依赖（单测注入；生产环境用 `globalThis`） */
export interface IdleSchedulerScope {
  requestIdleCallback?: ((cb: () => void, opts?: { timeout?: number }) => number) | undefined
  setTimeout?: ((cb: () => void, ms: number) => number) | undefined
}

/**
 * 在浏览器空闲时执行 `task`，并用 `timeoutMs` 兜底。
 *
 * 回退链：`requestIdleCallback(timeout)` → `setTimeout(0)` → 同步执行。
 * 最后一档只服务「既没有 rIC 也没有 setTimeout」的极端环境（例如某些精简的
 * 测试沙箱）——**宁可同步跑，也绝不丢任务**（丢了 = 球永远缺 AO）。
 */
export function scheduleIdleTask(
  task: () => void,
  scope: IdleSchedulerScope = globalThis as IdleSchedulerScope,
  timeoutMs: number = DEFERRED_IDLE_TIMEOUT_MS
): void {
  const ric = scope.requestIdleCallback
  if (typeof ric === 'function') {
    try {
      ric(() => task(), { timeout: timeoutMs })
      return
    } catch {
      // 某些内核 rIC 存在但调用即抛（历史实现差异）：落到下一档，不丢任务
    }
  }
  const st = scope.setTimeout
  if (typeof st === 'function') {
    st(() => task(), 0)
    return
  }
  task()
}

// ── B5 · shader 定义集签名 ────────────────────────────────────────────────────

/**
 * 「哪些 shader define 存在」的布尔画像。
 *
 * 只收**参与 `#ifdef` 的**东西：六个贴图槽 + `transparent`（three 据此推
 * `OPAQUE`）+ `alphaTest`（`USE_ALPHATEST`）+ `side`（`DOUBLE_SIDED` / `FLIP_SIDED`）。
 * 故意**不收** `colorSpace` / `repeat` / `anisotropy`：那些是采样器状态或 uniform，
 * 换贴图身份时改了也不需要重编译（各自有 `texture.needsUpdate` / uniform 写入口）。
 */
export interface DefineSet {
  albedo: boolean
  normal: boolean
  roughness: boolean
  ao: boolean
  displacement: boolean
  alpha: boolean
  transparent: boolean
  alphaTest: boolean
  side: number
}

/**
 * 定义集 → 稳定签名（顺序固定，可比对、可打日志）。
 *
 * 形如 `map|normal|-|ao|-|alpha|O|-|s0`（`-` = 该 define 不存在）。
 */
export function defineKey(set: DefineSet): string {
  return [
    set.albedo ? 'map' : '-',
    set.normal ? 'normal' : '-',
    set.roughness ? 'rough' : '-',
    set.ao ? 'ao' : '-',
    set.displacement ? 'disp' : '-',
    set.alpha ? 'alpha' : '-',
    set.transparent ? 'T' : 'O',
    set.alphaTest ? 'AT' : '-',
    `s${Number.isFinite(set.side) ? set.side : 0}`
  ].join('|')
}

/** 材质侧最小结构（`MeshPhysicalMaterial` 结构上满足；单测用普通对象） */
export interface MaterialDefineSource {
  map: unknown | null
  normalMap: unknown | null
  roughnessMap: unknown | null
  aoMap: unknown | null
  displacementMap: unknown | null
  alphaMap: unknown | null
  transparent: boolean
  alphaTest: number
  side: number
}

/** 从**材质当前状态**读定义集（`clearMaps` 之后立刻调用即可得到"空集"签名） */
export function defineSetOfMaterial(m: MaterialDefineSource): DefineSet {
  return {
    albedo: m.map !== null && m.map !== undefined,
    normal: m.normalMap !== null && m.normalMap !== undefined,
    roughness: m.roughnessMap !== null && m.roughnessMap !== undefined,
    ao: m.aoMap !== null && m.aoMap !== undefined,
    displacement: m.displacementMap !== null && m.displacementMap !== undefined,
    alpha: m.alphaMap !== null && m.alphaMap !== undefined,
    transparent: m.transparent === true,
    alphaTest: Number.isFinite(m.alphaTest) && m.alphaTest > 0,
    side: Number.isFinite(m.side) ? m.side : 0
  }
}

/**
 * 预判「本批加载完成后」的定义集：`slots` = 这一批**声明要挂**的槽位
 * （含 `'alpha'`），其余 define 取材质当前值（`transparent` / `alphaTest` / `side`
 * 不受贴图批次影响，只会被 `applyMaterialParams` 改）。
 *
 * 判据只能是「声明」，不能是「已加载完成」——`applyMaps` 一开始就要决定
 * 要不要摘掉旧贴图（摘 = 一帧空集签名 = 一次重编译）。
 */
export function defineSetFromSlots(
  slots: Iterable<string>,
  base: { transparent: boolean; alphaTest: number; side: number }
): DefineSet {
  const has = new Set<string>()
  for (const slot of slots) has.add(slot)
  return {
    albedo: has.has('albedo'),
    normal: has.has('normal'),
    roughness: has.has('roughness'),
    ao: has.has('ao'),
    displacement: has.has('displacement'),
    alpha: has.has('alpha'),
    transparent: base.transparent === true,
    alphaTest: Number.isFinite(base.alphaTest) && base.alphaTest > 0,
    side: Number.isFinite(base.side) ? base.side : 0
  }
}

// ── B2 · roughness 等待门控 ───────────────────────────────────────────────────

/**
 * 这一帧要不要**按住** roughness 不写（方案甲：等 map，而不是先用错值）。
 *
 * 判定 = 本批声明了 roughness 槽 ∧ 该贴图还没挂上 ∧ 本批尚未落定。
 *
 * - 成立时：`applyParams` 不写 `material.roughness`（保留上一份材质呈现的值；
 *   首次加载保留构造时的中性基准 0.5），于是不会出现 0.5 × 1.7 = 0.85 的中间态；
 * - 落定后（`settled === true`）一律为 false —— 即使贴图加载**失败**，也回到
 *   「无 map 口径」的最终值，不会永远停在中性基准上（失败可降级，不能锁死）。
 */
export function shouldHoldRoughness(
  declaredRoughness: boolean,
  hasRoughnessMap: boolean,
  settled: boolean
): boolean {
  return declaredRoughness === true && hasRoughnessMap !== true && settled !== true
}
