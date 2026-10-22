/**
 * 导入重复的**询问门**（docs/27 T-03）：整批聚合、一次弹窗、答复后不再打扰。
 *
 * ## 为什么要这一层（而不是每条冲突各问一次）
 *
 * 一次导入最多 20 包、并发 3（`importer.DEFAULT_CONCURRENCY`）。逐条问 = 连弹 N 次，
 * 且并发导致弹出顺序与用户预期不符（docs/27 §2.2）。这里把**聚合窗口**内到达的冲突
 * 合成一次 `sendAsk`，答复里的 `batchDefault` 成为后续所有冲突的默认档 —— 用户视角
 * 就是「一次导入只问一次」（D07）。
 *
 * ## 三个不变量（测试钉住，改动前先读）
 *
 * ① **只问一次**：整批只会有一次 `sendAsk`。窗口期间（`mode='collecting'`）与等待答复
 *    期间（`mode='asking'`）新来的冲突都进同一个缓冲，绝不会触发第二次询问；
 * ② **超时即定档**：`sendAsk` 返回 `null`（窗口没了 / 120s 超时 / 渲染进程崩了）→
 *    当前所有挂起的冲突一律 `skip`，并把批次策略**锁定为 skip**，后续冲突直接跳过、
 *    不再弹窗（D07/§4.4：没人应答就说明用户不在电脑前，再弹只会堆过期弹窗）；
 * ③ **不留 pending**：`cancelAll()` 兑现所有挂起 Promise（含正在等答复的那批），
 *    主进程关窗 / 崩溃清场时不会有 Promise 永久悬挂。
 *
 * ## 窗口时长
 *
 * 首个冲突起 **800ms**；每来一条新冲突 **+400ms**；自首个冲突起**最多 2500ms**。
 * 取值理由见 §4.5：给并发 3 的第一波留出全部到齐的时间，又不至于让用户干等。
 *
 * ## 超时/关窗为什么由注入的 `sendAsk` 负责
 *
 * 只有它知道窗口还在不在（`win.isDestroyed()` / `webContents.isDestroyed()`），
 * 也只有它能挂 120s 定时器。本模块**不 import electron**，纯逻辑可单测。
 *
 * 答复有两条入口，都收敛到同一个 deferred，**先到先得、后到幂等丢弃**：
 * - `sendAsk()` 返回的 Promise（主进程走这条：`pendingAsks` + 120s 超时，见 main/index.ts）；
 * - `answer()`（进程内直投：单测用，未来若把答复改走单向 send 也只需改这里）。
 */

import { randomUUID } from 'node:crypto'
import type {
  ImportConflictAnswer,
  ImportConflictAsk,
  ImportConflictItem,
  ImportConflictResolution
} from '../shared/types'

/** 聚合窗口基数：首个冲突起等 800ms */
export const CONFLICT_AGGREGATE_MS = 800
/** 每来一条新冲突，窗口延长 400ms */
export const CONFLICT_AGGREGATE_EXTEND_MS = 400
/** 自首个冲突起的窗口上限 2500ms */
export const CONFLICT_AGGREGATE_MAX_MS = 2500

/** 超时 / 无窗口时的兜底档（§4.4：唯一零副作用的选项） */
const FALLBACK: ImportConflictResolution = 'skip'

/**
 * 一条待裁决的冲突 = `ImportConflictItem` 去掉 `seq`（seq 由本模块按到达顺序发号）。
 *
 * `remainingItems`（本批还没出结果的源文件数）由 importer 侧算好带进来 ——
 * 只有它知道批量进度；聚合时取最大值，用于弹窗顶部「还有 N 个包正在检查」。
 */
export interface ConflictQuery extends Omit<ImportConflictItem, 'seq'> {
  remainingItems?: number
}

export interface ConflictGateOptions {
  /**
   * 发出一次询问。返回 `null` / `undefined` / reject = 窗口不可用或已超时
   * （主进程的实现见 `main/index.ts:sendConflictAsk`）。
   */
  sendAsk: (
    ask: ImportConflictAsk
  ) =>
    | Promise<ImportConflictAnswer | null | undefined>
    | ImportConflictAnswer
    | null
    | undefined
  /** 聚合窗口基数（默认 {@link CONFLICT_AGGREGATE_MS}） */
  aggregateMs?: number
  /** 每条新冲突的延长量（默认 {@link CONFLICT_AGGREGATE_EXTEND_MS}） */
  extendMs?: number
  /** 窗口上限（默认 {@link CONFLICT_AGGREGATE_MAX_MS}） */
  maxAggregateMs?: number
  /** 时钟注入（单测与假定时器对齐用；生产走 `Date.now`） */
  now?: () => number
  /** requestId 生成器（单测可固定；生产用 UUID） */
  newRequestId?: () => string
}

export interface ConflictGate {
  /** 询问一条冲突的处置档；返回的 Promise 一定兑现（skip/overwrite/keep-both） */
  ask(query: ConflictQuery): Promise<ImportConflictResolution>
  /** 进程内答复入口；未知 / 过期 `requestId` **幂等丢弃** */
  answer(answer: ImportConflictAnswer): void
  /** 清场：兑现所有挂起 Promise（`skip`）并锁定批次策略，不留 pending */
  cancelAll(): void
  /** 挂起中的询问数（测试断言「不留 pending」用） */
  pendingCount(): number
  /** 已确定的批次默认档；`null` = 用户还没答复过 */
  batchDefault(): ImportConflictResolution | null
  /** 批次策略是否已被锁定为兜底档（超时 / 取消 / 清场后为 true） */
  locked(): boolean
}

interface Waiting {
  seq: number
  query: ConflictQuery
  /** 复用键：同键的两条冲突共用一次答复（docs/27 §4.5） */
  key: string
  settled: boolean
  resolve: (r: ImportConflictResolution) => void
}

const RESOLUTIONS: ReadonlySet<string> = new Set(['skip', 'overwrite', 'keep-both'])

function normalizeResolution(value: unknown): ImportConflictResolution {
  return typeof value === 'string' && RESOLUTIONS.has(value)
    ? (value as ImportConflictResolution)
    : FALLBACK
}

/**
 * 冲突的**复用键**：同一件库内素材被判重多次时，用户答一次就该管到底。
 *
 * - `zhimo-id` → `zhimo:<id>`（同一件知末素材）；
 * - `same-name` → `asset:<库内那份的 id>`（同一条库内记录；比 dedupeKey 更精确，
 *   因为 `dedupeKey` 可能对应库里多份，而我们只覆盖其中最早的一份）。
 */
function conflictKeyOf(query: ConflictQuery): string {
  const zid = typeof query.zhimoId === 'string' ? query.zhimoId.trim() : ''
  if (query.reason === 'zhimo-id' && zid) return `zhimo:${zid}`
  return `asset:${query.existing.id}`
}

/**
 * 建一个**批次级**询问门（一批一个实例；`runImport` 里创建、`finally` 里 `cancelAll`）。
 */
export function createConflictGate(options: ConflictGateOptions): ConflictGate {
  const aggregateMs = Math.max(0, options.aggregateMs ?? CONFLICT_AGGREGATE_MS)
  const extendMs = Math.max(0, options.extendMs ?? CONFLICT_AGGREGATE_EXTEND_MS)
  const maxAggregateMs = Math.max(aggregateMs, options.maxAggregateMs ?? CONFLICT_AGGREGATE_MAX_MS)
  const now = options.now ?? (() => Date.now())
  const newRequestId = options.newRequestId ?? (() => randomUUID())

  /** 已答复的逐键决定（同键复用） */
  const decisions = new Map<string, ImportConflictResolution>()
  /** 全部未兑现的等待项（`cancelAll` 与 `pendingCount` 的唯一真源） */
  const waiting = new Set<Waiting>()
  /** 聚合缓冲（窗口内到达、还没发问的） */
  let buffer: Waiting[] = []
  let mode: 'idle' | 'collecting' | 'asking' | 'locked' = 'idle'
  let batchDefault: ImportConflictResolution | null = null
  let seqCounter = 0
  /** 本轮聚合窗口的绝对截止时刻（首个冲突起算） */
  let windowStart = 0
  let windowTimer: ReturnType<typeof setTimeout> | null = null
  /** 清场令牌：`cancelAll` 自增，flush 回来发现变了就直接退出（不重复兑现） */
  let abortToken = 0
  /** 当前在等的那次询问（答复入口按 requestId 匹配） */
  let inflight: { requestId: string; settled: boolean; settle: (a: ImportConflictAnswer | null) => void } | null = null

  function settle(item: Waiting, resolution: ImportConflictResolution): void {
    if (item.settled) return
    item.settled = true
    waiting.delete(item)
    item.resolve(resolution)
  }

  function settleAll(items: readonly Waiting[], resolution: ImportConflictResolution): void {
    for (const item of items) settle(item, resolution)
  }

  function clearWindow(): void {
    if (windowTimer !== null) {
      clearTimeout(windowTimer)
      windowTimer = null
    }
  }

  /** 锁定批次策略为兜底档：之后任何冲突直接 skip，不再发问（D07/§4.4） */
  function lock(): void {
    mode = 'locked'
    batchDefault = null
    decisions.clear()
    settleAll(buffer, FALLBACK)
    buffer = []
    clearWindow()
  }

  function scheduleWindow(): void {
    const at = now()
    if (windowTimer === null) windowStart = at
    const deadline = Math.min(
      windowStart + aggregateMs + extendMs * Math.max(0, buffer.length - 1),
      windowStart + maxAggregateMs
    )
    clearWindow()
    windowTimer = setTimeout(() => {
      void flush()
    }, Math.max(0, deadline - at))
  }

  /** 把答复应用到一批等待项：overrides 优先，缺省用批次默认档；并记住逐键决定 */
  function applyAnswer(answer: ImportConflictAnswer, batch: readonly Waiting[]): void {
    const bySeq = new Map<number, ImportConflictResolution>()
    for (const o of answer.overrides ?? []) {
      if (!o || typeof o.seq !== 'number') continue
      bySeq.set(o.seq, normalizeResolution(o.resolution))
    }
    const fallback = normalizeResolution(answer.batchDefault)
    batchDefault = fallback
    for (const item of batch) {
      const resolution = bySeq.get(item.seq) ?? fallback
      decisions.set(item.key, resolution)
      settle(item, resolution)
    }
  }

  /** 答复落地后，把「等答复期间新到达」的冲突按同一策略一次性处理（不再发问） */
  function drainBufferWithDecision(): void {
    if (buffer.length === 0) return
    clearWindow()
    const rest = buffer
    buffer = []
    for (const item of rest) {
      settle(item, decisions.get(item.key) ?? batchDefault ?? FALLBACK)
    }
  }

  function requestAnswer(ask: ImportConflictAsk): Promise<ImportConflictAnswer | null> {
    return new Promise<ImportConflictAnswer | null>((resolve) => {
      const state = { settled: false }
      const settleOnce = (a: ImportConflictAnswer | null): void => {
        if (state.settled) return
        state.settled = true
        resolve(a)
      }
      inflight = { requestId: ask.requestId, settled: false, settle: settleOnce }

      let returned: unknown
      try {
        returned = options.sendAsk(ask)
      } catch {
        // sendAsk 自己抛错 = 窗口不可用，等同于超时（绝不把异常漏给整批导入）
        settleOnce(null)
        return
      }
      if (returned && typeof (returned as Promise<unknown>).then === 'function') {
        ;(returned as Promise<ImportConflictAnswer | null | undefined>).then(
          (a) => settleOnce(a ?? null),
          () => settleOnce(null)
        )
        return
      }
      // 同步返回：对象 = 直接答复（测试/进程内）；null/undefined = 窗口不可用
      if (returned && typeof returned === 'object') {
        settleOnce(returned as ImportConflictAnswer)
        return
      }
      settleOnce(null)
    })
  }

  async function flush(): Promise<void> {
    windowTimer = null
    if (buffer.length === 0 || mode === 'locked') return
    const batch = buffer
    buffer = []
    mode = 'asking'
    const token = abortToken

    const requestId = newRequestId()
    const ask: ImportConflictAsk = {
      requestId,
      // 默认档固定「跳过」：主进程超时兜底与弹窗预选都靠它（§4.4）
      batchDefault: FALLBACK,
      items: batch.map((item) => ({
        seq: item.seq,
        item: item.query.item,
        itemName: item.query.itemName,
        assetName: item.query.assetName,
        kind: item.query.kind,
        size: item.query.size,
        reason: item.query.reason,
        zhimoId: item.query.zhimoId,
        existing: item.query.existing
      })),
      remainingItems: batch.reduce((max, item) => Math.max(max, item.query.remainingItems ?? 0), 0)
    }

    const answer = await requestAnswer(ask)
    inflight = null

    // 清场（cancelAll）已经把它们兑现过了：这里什么都不做，避免二次结算
    if (token !== abortToken) return

    mode = 'idle'
    if (!answer || answer.cancelled === true) {
      settleAll(batch, FALLBACK)
      lock()
      return
    }

    applyAnswer(answer, batch)
    drainBufferWithDecision()
  }

  return {
    ask(query) {
      return new Promise<ImportConflictResolution>((resolve) => {
        const item: Waiting = {
          seq: 0,
          query,
          key: conflictKeyOf(query),
          settled: false,
          resolve
        }

        // ① 已锁定（超时/取消/清场）→ 直接跳过，绝不再打扰
        if (mode === 'locked') {
          item.settled = true
          resolve(FALLBACK)
          return
        }
        // ② 已有批次策略 → 同键复用，否则套用默认档，不发问
        if (batchDefault !== null) {
          item.settled = true
          resolve(decisions.get(item.key) ?? batchDefault)
          return
        }

        seqCounter += 1
        item.seq = seqCounter
        waiting.add(item)
        buffer.push(item)
        mode = 'collecting'
        // 正在等答复时**不重排窗口**：这批冲突会被 `drainBufferWithDecision()` 一次吞掉
        if (inflight === null) scheduleWindow()
      })
    },

    answer(answer) {
      if (!answer || typeof answer.requestId !== 'string') return
      // 幂等：超时后才到的答复 / 别的批次的答复 → 丢弃
      if (!inflight || inflight.requestId !== answer.requestId || inflight.settled) return
      inflight.settled = true
      inflight.settle(answer)
    },

    cancelAll() {
      abortToken += 1
      clearWindow()
      mode = 'locked'
      const orphan = [...waiting]
      buffer = []
      settleAll(orphan, FALLBACK)
      // 叫醒正在等答复的那次 flush（它的 batch 刚被上面一并兑现了）
      if (inflight && !inflight.settled) {
        inflight.settled = true
        inflight.settle(null)
      }
      inflight = null
      batchDefault = null
      decisions.clear()
    },

    pendingCount() {
      return waiting.size
    },

    batchDefault() {
      return batchDefault
    },

    locked() {
      return mode === 'locked'
    }
  }
}
