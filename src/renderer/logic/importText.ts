/**
 * 导入队列的**纯逻辑**：
 * ① 失败文案（P0-3 空间不足的「可用 X GB / 需要 Y GB」）；
 * ② 终态条目的**自动消失时机**（2026-10 用户反馈：条目完成后不消失，连导多个包堆一屏）；
 * ③ 条目明细文案 + 状态配色（docs/27 T-08：`skipped` 与「已覆盖 / 已保留为」两种重复处置结果）。
 *
 * ⚠️ `ImportStatus` 是字符串字面量联合，**加值时不会触发编译报错**（全仓没有
 * `Record<ImportStatus, _>` / 穷举 switch）。所以状态 → 配色 / 倒计时 / 文案这三处
 * 必须集中在本文件，由 `tests/importConflictUi.test.ts` 钉住，组件里不再各写一份。
 */
import { humanGB } from '../../shared/space'
import type { ImportEvent, ImportStatus } from '../../shared/types'

export function spaceShortageText(
  needBytes?: number | null,
  freeBytes?: number | null
): string | null {
  if (typeof needBytes !== 'number' || !Number.isFinite(needBytes) || needBytes <= 0) return null
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) return null
  return `可用 ${humanGB(freeBytes)} / 需要 ${humanGB(needBytes)}`
}

/** 队列条目的状态（`pending` 是渲染层自己加的，main 不会推） */
export type ImportQueueStatus = ImportStatus | 'pending'

/** 成功条目在队列里停留的时长（够看清「已归档到…」，又不至于堆屏） */
export const IMPORT_DONE_DISMISS_MS = 6000

/** 失败条目停留时长：错误信息需要更长时间读完（是成功态的两倍） */
export const IMPORT_ERROR_DISMISS_MS = 12000

/**
 * 该状态的条目应在「进入终态后」多久自动消失；`null` = **永不自动消失**。
 *
 * 只有 done / error / skipped 有倒计时：pending / extracting / organizing 是进行中，
 * 提前消失会让用户以为任务丢了（队列此刻正是唯一的进度反馈）。
 *
 * `skipped`（docs/27）与 `done` 同为「本条目已经处理完毕、不需要用户再看」，
 * 停留 6 秒即可；**不给它 error 的 12 秒**——跳过不是失败，留太久反而像出了问题。
 */
export function autoDismissDelayMs(status: ImportQueueStatus): number | null {
  if (status === 'done') return IMPORT_DONE_DISMISS_MS
  if (status === 'error') return IMPORT_ERROR_DISMISS_MS
  if (status === 'skipped') return IMPORT_DONE_DISMISS_MS
  return null
}

/** 终态（不会再变、可以倒计时消失、可以手动 ✕）：done / error / skipped */
export function isTerminalStatus(status: ImportQueueStatus): boolean {
  return status === 'done' || status === 'error' || status === 'skipped'
}

/**
 * 状态 → 图标/文字颜色（Tailwind 类名，全部走 token，无硬编码色值）。
 *
 * `skipped` 用**中性灰**（`text-muted`）：跳过是「这次不导入」，不是告警，
 * 写成 `text-danger` 会让用户以为素材坏了或导入失败了（docs/27 T-08 明确要求）。
 */
export function statusClass(status: ImportQueueStatus): string {
  switch (status) {
    case 'done':
      return 'text-success'
    case 'error':
      return 'text-danger'
    case 'skipped':
      return 'text-muted'
    case 'extracting':
    case 'organizing':
      return 'text-accent'
    case 'pending':
    default:
      return 'text-muted'
  }
}

/**
 * 批次结束后的一条汇总（docs/27 §3.1）：`已跳过 N 个重复素材，原文件保留在原位`。
 * N ≤ 0 返回 `null`（不打扰用户）。
 */
export function skippedSummaryText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  return `已跳过 ${count} 个重复素材，原文件保留在原位`
}

/**
 * 覆盖的批次汇总文案（与 `skippedSummaryText` 对称）。
 *
 * - 有退化条目（`degraded > 0`）→ `已覆盖 N 个重复素材，其中 M 个旧版未进回收站`
 *   （绝不能笼统说"在回收站"，用户会以为空间已经释放了）；
 * - 全部正常 → `已覆盖 N 个重复素材（旧版在系统回收站）`；
 * - `total ≤ 0` → `null`（不打扰）。
 * `degraded` 会被夹在 `[0, total]`：脏数据也印不出「其中 3 个」但只有 1 条覆盖。
 *
 * 计数由调用方从**事件字段** `ImportEvent.conflict.degraded` 累加（不做 message 文案嗅探）：
 * `degraded` 缺省（旧主进程 / 老日志）一律按 `false` 处理 —— 本版主进程与渲染层同包发布，
 * 不存在跨版本混用，所以这是唯一能从类型上做出的判断。
 */
export function overwriteSummaryText(total: number, degraded = 0): string | null {
  if (!Number.isFinite(total)) return null
  const n = Math.floor(total)
  if (n <= 0) return null
  const d = Number.isFinite(degraded) ? Math.min(Math.max(0, Math.floor(degraded)), n) : 0
  if (d > 0) return `已覆盖 ${n} 个重复素材，其中 ${d} 个旧版未进回收站`
  return `已覆盖 ${n} 个重复素材（旧版在系统回收站）`
}

/**
 * 杂质的批次汇总文案（与 `skippedSummaryText` 对称）。
 *
 * 为什么必须汇总、而且必须**说清"已删除"**：这条汇总的唯一价值是让用户知道
 * **磁盘上少了东西**。此前这些推广件只是"不进索引"，文件还在；0.9.0 之后是 `fs.rm`，
 * 不可逆、不进回收站。用户看到包里的扫码图 / 说明 html 消失了，必须有一个回执把它
 * 解释成"我们干的"，否则会怀疑是不是导入把素材弄丢了。
 *
 * - `count ≤ 0` → `null`（不打扰；绝大多数包没有杂质）；
 * - 只报条数不报文件名：批量导入时文件名列表能刷满三屏，而用户要的信息只有"删了几个"。
 *
 * 计数由调用方从 `ImportEvent.cleanedJunk` 的**长度**累加（只累加、批次结束发一条，
 * 挂在逐条事件上就是"拖 50 个包弹 50 次"）。
 */
export function junkCleanupSummaryText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const n = Math.floor(count)
  if (n <= 0) return null
  return `已清理 ${n} 个推广/说明文件（导入时自动删除，不进回收站）`
}

/** `ImportItem` 里本文件用得到的字段（结构化类型，测试可直接传字面量） */
export interface ImportItemTextInput {
  status: ImportQueueStatus
  message?: string
  asset?: { name?: string; relFolder?: string }
  conflict?: ImportEvent['conflict']
  needBytes?: number
  freeBytes?: number
}

/**
 * 队列条目第二行的明细文案（唯一定义处，组件直接渲染）。
 *
 * 顺序即优先级：
 * - `error`：空间不足的可行动数字 > 主进程给的 message > 「导入失败」；
 * - `skipped`：主进程的 message（`已跳过重复素材（原文件保留在原位）`）> 兜底同义文案；
 * - `done` + message：**message 优先**（见下）；
 * - `done` + 重复处置：`已覆盖到「旧名」` / `已保留为「新名」`（docs/27 §6.1 的文案）；
 * - `done` 普通：沿用「已归档到「大类」」，逐字符不变；
 * - 其余（pending / extracting / organizing）：message > 「处理中…」。
 *
 * ⚠️ 为什么 `done` 要先看 `message`：main 侧 `doneMessage()`（importer.ts:423）只在
 * **覆盖档的两条退化路径**上给 message，且都是用户必须知道的事实：
 * ① 旧目录已被手工删除 / 快照 folder 在库外 / kind 变了 → 「已覆盖（原目录已不存在，按新素材落盘）」
 *   —— 说「已覆盖到「旧名」」会让用户以为还是原来那个目录；
 * ② 旧版本没能进回收站（DCC 占用等）→ 「已覆盖；旧版本未能移入回收站，已暂存为 .idbox-old-*」
 *   —— 吞掉这句，用户会以为旧版已经进回收站了（其实没有，空间也没释放）。
 * 正常落盘的 done 事件不带 message（`doneMessage` 返回 undefined），所以这条优先级
 * 不会改变 0.6.9 的「已归档到「大类」」行为。
 */
export function importItemDetail(it: ImportItemTextInput): string {
  if (it.status === 'error') {
    return spaceShortageText(it.needBytes, it.freeBytes) ?? (it.message?.trim() || '导入失败')
  }
  if (it.status === 'skipped') {
    return it.message?.trim() || '已跳过重复素材（原文件保留在原位）'
  }
  if (it.status === 'done') {
    const override = it.message?.trim()
    if (override) return override
    const c = it.conflict
    if (c?.resolution === 'overwrite') return `已覆盖到「${c.existingName}」`
    if (c?.resolution === 'keep-both') {
      // 新资产名由主进程 `uniqueName` 决定（可能是 -2 / -3），有就用真值
      const name = it.asset?.name?.trim() || `${c.existingName}-2`
      return `已保留为「${name}」`
    }
    const top = it.asset?.relFolder?.split('/')[0]
    return `已归档${top ? `到「${top}」` : ''}`
  }
  return it.message ?? '处理中…'
}

/**
 * 从**绝对时间戳**算剩余停留时间（毫秒，≥0）；`null` = 不自动消失。
 *
 * 为什么需要它：队列支持「鼠标悬停暂停倒计时」。暂停/恢复不能靠 `setTimeout`
 * 的剩余量记忆（组件一重渲染就丢），而是每次都用 `settledAt + 延迟 - now` 重算：
 * - `settledAt` 缺失（老数据 / 进行中）→ 视作"刚刚进入终态"，返回完整时长；
 * - 已超时 → 0（立即移除）。
 */
export function dismissRemainingMs(
  status: ImportQueueStatus,
  settledAt: number | null | undefined,
  now: number
): number | null {
  const delay = autoDismissDelayMs(status)
  if (delay === null) return null
  if (typeof settledAt !== 'number' || !Number.isFinite(settledAt)) return delay
  const elapsed = Number.isFinite(now) ? now - settledAt : 0
  return Math.max(0, delay - elapsed)
}
