/// <reference lib="dom" />
// ↑ 本文件经由 tsconfig.node（tests/**）编译，而 renderer 源码依赖 DOM 全局（window/Crypto）。
//   `Window.modvault` 的真实声明在 src/renderer/env.d.ts（仅对 tsconfig.web 程序生效），
//   这里按 tests/storeFlow.test.ts 的既有做法补一个测试用的宽松声明。
declare global {
  interface Window {
    modvault: ModVaultApi
  }
}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { ModVaultApi } from '../src/preload/index'
import { DEFAULT_SETTINGS, type Asset, type ImportConflictAsk, type ImportConflictExpired, type ImportEvent } from '../src/shared/types'
import {
  CONFLICT_RESOLUTIONS,
  applyBatchDefault,
  buildConflictAnswer,
  buildDedupeSnapshot,
  conflictTitle,
  initialConflictState,
  isRowCustom,
  isStrongReason,
  otherCopiesText,
  reasonLabel,
  remainingItemsText,
  resolutionOf,
  setRowChoice,
  sizeDiffPercent
} from '../src/renderer/logic/importConflict'
import {
  autoDismissDelayMs,
  importItemDetail,
  isTerminalStatus,
  overwriteSummaryText,
  skippedSummaryText,
  statusClass
} from '../src/renderer/logic/importText'

/**
 * 导入重复处置的**渲染层**（docs/27 T-06 / T-07 / T-08）。
 *
 * 本项目没有 RTL（vitest 跑 node 环境，组件渲染不了），所以策略是
 * 「纯逻辑用单测钉死 + 组件只留排布、接线用源码守卫钉住」：
 * ① `buildDedupeSnapshot`：排除软删、meta 齐全（store 传给主进程的判重快照）；
 * ② 弹窗状态机：默认档 / 顶部覆盖所有行 / 行内只改该行 / Esc→cancelled / 载荷形状；
 * ③ `importText` 三处 `skipped` 同步（配色 / 倒计时 / 终态）——`ImportStatus` 加值**不会**
 *    触发编译报错，所以必须由测试钉住；
 * ④ 真实 store：`answerConflict` 清 `conflictAsk`、订阅幂等、`skipped` 计入 settled + 汇总 toast。
 */

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

type AskCb = (ask: ImportConflictAsk) => void
type ExpiredCb = (ev: ImportConflictExpired) => void
type ImportCb = (ev: ImportEvent) => void

let askHandler: AskCb | null = null
let expiredHandler: ExpiredCb | null = null
let importHandler: ImportCb | null = null
let batchDoneHandler: (() => void) | null = null

const modvault = {
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  setSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  detectMaterialMerge: vi.fn(async () => ({ needMerge: false, count: 0, sources: [] })),
  onMaterialMergeNotice: vi.fn(() => () => undefined),
  onImportBatchDone: vi.fn((cb: () => void) => {
    batchDoneHandler = cb
    return () => undefined
  }),
  onImportEvent: vi.fn((cb: ImportCb) => {
    importHandler = cb
    return () => undefined
  }),
  onImportConflictAsk: vi.fn((cb: AskCb) => {
    askHandler = cb
    return () => undefined
  }),
  onImportConflictExpired: vi.fn((cb: ExpiredCb) => {
    expiredHandler = cb
    return () => undefined
  }),
  answerImportConflict: vi.fn(async () => undefined),
  importPaths: vi.fn(async () => [])
}

/**
 * `onSettingsChanged`（DEF-22-1）：`store.init()` 会订阅设置广播，缺了它会直接抛错。
 * 本文件不验这条回路（`tests/settingsBroadcast.test.ts` 专门验），只补个空实现。
 * **必须挂在 `modvault` 对象本身上**，不能用 `{...modvault}` 展开：
 * 下面几条用例会替换 `modvault.reportLog` 之类的属性，浅拷贝不会跟随。
 */
;(modvault as unknown as { onSettingsChanged: () => () => void }).onSettingsChanged = () =>
  () => undefined
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')

Object.defineProperty(db, 'assets', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkPut: vi.fn(async () => 0),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})
Object.defineProperty(db, 'backups', {
  value: {
    toArray: vi.fn(async () => []),
    put: vi.fn(async () => undefined),
    bulkDelete: vi.fn(async () => 0)
  },
  configurable: true
})

const { useVault, ensureConflictAskSubscribed } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

function asset(over: Partial<Asset> = {}): Asset {
  seq += 1
  const n = String(seq).padStart(3, '0')
  return {
    id: `id-${n}`,
    name: `资产${n}`,
    kind: 'model',
    source: '知末网',
    folder: `E:\\ModVault\\Library\\模型\\未分类\\未分类\\资产${n}`,
    relFolder: `模型/未分类/未分类/资产${n}`,
    files: [],
    size: 1024,
    tags: ['奶油'],
    note: '备注',
    favorite: false,
    rating: 0,
    colorTag: null,
    dedupeKey: `model:资产${n}`,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    category1: '未分类',
    category2: '未分类',
    styles: ['现代'],
    ...over
  }
}

function ask(over: Partial<ImportConflictAsk> = {}): ImportConflictAsk {
  return {
    requestId: 'req-1',
    batchDefault: 'skip',
    remainingItems: 0,
    items: [
      {
        seq: 1,
        item: 'E:\\downloads\\卧室双人床.skp.rar',
        itemName: '卧室双人床.skp.rar',
        assetName: '卧室双人床',
        kind: 'model',
        size: 486 * 1024 * 1024,
        reason: 'same-name',
        existing: {
          id: 'id-old',
          name: '卧室双人床',
          kind: 'model',
          relFolder: '模型/家具/卧室',
          size: 512 * 1024 * 1024,
          importedAt: 1_757_000_000_000,
          otherCopies: 0,
          sizeMismatch: false
        }
      },
      {
        seq: 2,
        item: 'E:\\downloads\\现代壁灯ID_1232108421.rar',
        itemName: '现代壁灯ID_1232108421.rar',
        assetName: '现代壁灯',
        kind: 'model',
        size: 42 * 1024 * 1024,
        reason: 'zhimo-id',
        zhimoId: '1232108421',
        existing: {
          id: 'id-old-2',
          name: '现代壁灯',
          kind: 'model',
          relFolder: '模型/灯具/吊灯',
          size: 42 * 1024 * 1024,
          importedAt: 1_759_000_000_000,
          otherCopies: 2,
          sizeMismatch: false
        }
      }
    ],
    ...over
  }
}

// ── ① buildDedupeSnapshot ─────────────────────────────────────────

describe('buildDedupeSnapshot —— 判重快照（docs/27 §4.2 / D17）', () => {
  it('排除软删（deletedAt 非空）资产：回收站里的那份不算「已存在」', () => {
    const alive = asset({ name: '活的' })
    const trashed = asset({ name: '已删', deletedAt: 1_760_000_000_000, trashRel: '.trash/1' })
    const snap = buildDedupeSnapshot([alive, trashed])
    expect(snap.map((e) => e.name)).toEqual(['活的'])
    expect(snap.some((e) => e.id === trashed.id)).toBe(false)
  })

  it('meta 继承字段齐全（收藏 / 评分 / 色标 / 标签 / 风格 / 备注 / 双分类）', () => {
    const a = asset({
      favorite: true,
      rating: 4,
      colorTag: 'red',
      tags: ['奶油', '侘寂'],
      styles: ['现代', '极简'],
      note: 'HDR 全景参数：EV+1',
      category1: '家具',
      category2: '卧室'
    })
    const [e] = buildDedupeSnapshot([a])
    expect(e!.meta).toEqual({
      favorite: true,
      rating: 4,
      colorTag: 'red',
      tags: ['奶油', '侘寂'],
      styles: ['现代', '极简'],
      note: 'HDR 全景参数：EV+1',
      category1: '家具',
      category2: '卧室'
    })
    // 定位 / 展示字段
    expect(e!.id).toBe(a.id)
    expect(e!.name).toBe(a.name)
    expect(e!.kind).toBe(a.kind)
    expect(e!.folder).toBe(a.folder)
    expect(e!.relFolder).toBe(a.relFolder)
    expect(e!.size).toBe(a.size)
    expect(e!.importedAt).toBe(a.importedAt)
    expect(e!.dedupeKey).toBe(a.dedupeKey)
  })

  it('缺分类 / 缺字段 → 双哨兵与非空默认值（覆盖时才能判定「用户从未指派」）', () => {
    const bare = asset({ category1: undefined, category2: undefined, tags: undefined as never, styles: undefined, note: undefined as never, favorite: undefined as never, rating: undefined as never, colorTag: undefined })
    const [e] = buildDedupeSnapshot([bare])
    expect(e!.meta.category1).toBe('未分类')
    expect(e!.meta.category2).toBe('未分类')
    expect(e!.meta.tags).toEqual([])
    expect(e!.meta.styles).toEqual([])
    expect(e!.meta.note).toBe('')
    expect(e!.meta.favorite).toBe(false)
    expect(e!.meta.rating).toBe(0)
    expect(e!.meta.colorTag).toBeNull()
  })

  it('空的 dedupeKey / zhimoId 传 undefined（由主进程用 baseNameOf 兜底重算，不传空串当有效键）', () => {
    const a = asset({ dedupeKey: '   ', zhimoId: '' })
    const [e] = buildDedupeSnapshot([a])
    expect(e!.dedupeKey).toBeUndefined()
    expect(e!.zhimoId).toBeUndefined()
  })

  it('tags / styles 是拷贝（快照被主进程消费时不会反向改写库内数组）', () => {
    const tags = ['a']
    const a = asset({ tags })
    const [e] = buildDedupeSnapshot([a])
    e!.meta.tags.push('b')
    expect(tags).toEqual(['a'])
    expect(a.tags).toEqual(['a'])
  })
})

// ── ② 弹窗状态机 ───────────────────────────────────────────────────

describe('ImportConflictDialog 状态机（纯函数）', () => {
  it('默认档 = 跳过（最安全）；ask.batchDefault 合法时尊重它，非法值一律归 skip', () => {
    expect(initialConflictState(ask()).batchDefault).toBe('skip')
    expect(initialConflictState(ask()).rowChoices).toEqual({})
    expect(initialConflictState(null).batchDefault).toBe('skip')
    expect(initialConflictState(ask({ batchDefault: 'overwrite' })).batchDefault).toBe('overwrite')
    expect(
      initialConflictState(ask({ batchDefault: 'oops' as unknown as 'skip' })).batchDefault
    ).toBe('skip')
  })

  it('三档顺序固定（跳过 / 覆盖 / 保留两者），行内未指定时全部跟随批次默认档', () => {
    expect(CONFLICT_RESOLUTIONS).toEqual(['skip', 'overwrite', 'keep-both'])
    const s = initialConflictState(ask())
    expect(resolutionOf(s, 1)).toBe('skip')
    expect(resolutionOf(s, 2)).toBe('skip')
    expect(isRowCustom(s, 1)).toBe(false)
  })

  it('点顶部三档 → 覆盖所有行（含先前被单独指定的行）', () => {
    let s = initialConflictState(ask())
    s = setRowChoice(s, 2, 'keep-both')
    expect(resolutionOf(s, 2)).toBe('keep-both')

    s = applyBatchDefault(s, 'overwrite')
    expect(s.batchDefault).toBe('overwrite')
    expect(s.rowChoices).toEqual({}) // 行内指定全部让位
    expect(resolutionOf(s, 1)).toBe('overwrite')
    expect(resolutionOf(s, 2)).toBe('overwrite')
    expect(isRowCustom(s, 2)).toBe(false)
  })

  it('行内改档只改该行（另一行仍跟随默认档），且不修改原状态（不可变）', () => {
    const base = initialConflictState(ask())
    const s = setRowChoice(base, 2, 'overwrite')

    expect(resolutionOf(s, 2)).toBe('overwrite')
    expect(resolutionOf(s, 1)).toBe('skip')
    expect(isRowCustom(s, 2)).toBe(true)
    expect(isRowCustom(s, 1)).toBe(false)

    // 原状态未被改写（React setState 依赖引用变化）
    expect(base.rowChoices).toEqual({})
    expect(s).not.toBe(base)
  })

  it('行内选到与默认档相同的值 → 退化为「跟随」（不留下无意义的 override）', () => {
    const s0 = initialConflictState(ask())
    const s1 = setRowChoice(s0, 1, 'keep-both')
    const s2 = setRowChoice(s1, 1, 'skip') // 回到默认档
    expect(s2.rowChoices).toEqual({})
    expect(isRowCustom(s2, 1)).toBe(false)
  })

  it('提交载荷：只带与默认档不同的行、seq 升序；全跟随时不带 overrides 键', () => {
    let s = initialConflictState(ask())
    s = setRowChoice(s, 2, 'overwrite')
    const a = buildConflictAnswer(ask(), s)
    expect(a).toEqual({
      requestId: 'req-1',
      batchDefault: 'skip',
      overrides: [{ seq: 2, resolution: 'overwrite' }]
    })
    expect('cancelled' in a).toBe(false)

    const plain = buildConflictAnswer(ask(), initialConflictState(ask()))
    expect(plain).toEqual({ requestId: 'req-1', batchDefault: 'skip' })
    expect(plain.overrides).toBeUndefined()
  })

  it('Esc / 全部取消 / ✕ → cancelled:true + 全跳过，且不携带任何行内指定', () => {
    let s = initialConflictState(ask())
    s = setRowChoice(s, 1, 'overwrite')
    s = applyBatchDefault(s, 'keep-both')

    const a = buildConflictAnswer(ask(), s, true)
    expect(a.cancelled).toBe(true)
    expect(a.batchDefault).toBe('skip')
    expect(a.requestId).toBe('req-1')
    expect(a.overrides).toBeUndefined()
  })
})

// ── ③ 弹窗里的派生文案 ─────────────────────────────────────────────

describe('弹窗文案与体积差（N 必须算出来，不许写死）', () => {
  it('体积差百分数 = (大 - 小) / 小，与 duplicates.ts 的 30% 同口径', () => {
    const MB = 1024 * 1024
    expect(sizeDiffPercent(486 * MB, 512 * MB)).toBe(5) // 设计稿例：486 vs 512 → 5%
    expect(sizeDiffPercent(1.2 * 1024 * MB, 610 * MB)).toBe(101) // 610MB vs 1.2GB → ~101%
    expect(sizeDiffPercent(100, 100)).toBe(0)
    expect(sizeDiffPercent(0, 100)).toBe(0) // 任何一侧为 0 不比
    expect(sizeDiffPercent(Number.NaN, 100)).toBe(0)
    // 方向无关（新包比库里大 / 小都是同一差值）
    expect(sizeDiffPercent(512 * MB, 486 * MB)).toBe(5)
  })

  it('strong / weak 两种标签：zhimo-id 是「同一件素材(ID)」，same-name 是「同名素材」', () => {
    expect(reasonLabel('zhimo-id')).toBe('同一件素材(ID)')
    expect(reasonLabel('same-name')).toBe('同名素材')
    expect(isStrongReason('zhimo-id')).toBe(true)
    expect(isStrongReason('same-name')).toBe(false)
  })

  it('otherCopies 只在 > 0 时才出文案；「其余」按源文件数算且要扣掉已列出的行', () => {
    expect(otherCopiesText(0)).toBeNull()
    expect(otherCopiesText(2)).toContain('库里还有 2 份')
    // remainingItems 含正在问的这一条：单包冲突（1 条已列出）→ 没有「其余」，不显示
    expect(remainingItemsText(1, 1)).toBeNull()
    expect(remainingItemsText(0, 0)).toBeNull()
    // 8 个源文件还没出结果、弹窗里已列出 3 条 → 其余 5 个
    expect(remainingItemsText(8, 3)).toBe('还有 5 个源文件正在检查，若也有重复将按上方选择处理')
    // 脏值：剩余少于已列出 → 不显示（绝不给用户看负数）
    expect(remainingItemsText(2, 5)).toBeNull()
    expect(remainingItemsText(Number.NaN, 1)).toBeNull()
  })

  it('标题带条数', () => {
    expect(conflictTitle(3)).toBe('发现 3 个可能重复的素材')
  })
})

// ── ④ ImportQueue / importText 的 skipped 映射（三处同步的其中两处） ──

describe('importText：skipped 的配色 / 倒计时 / 终态（ImportStatus 加值不会编译报错，必须测）', () => {
  it('skipped 用中性色（text-muted），绝不是 danger（跳过不是失败）', () => {
    const cls = statusClass('skipped')
    expect(cls).toBe('text-muted')
    expect(cls).not.toContain('danger')
    // 三个既有状态的配色一个字符都不许变
    expect(statusClass('done')).toBe('text-success')
    expect(statusClass('error')).toBe('text-danger')
    expect(statusClass('extracting')).toBe('text-accent')
    expect(statusClass('organizing')).toBe('text-accent')
    expect(statusClass('pending')).toBe('text-muted')
  })

  it('skipped 有 6 秒自动消失（与 done 一致，不是 error 的 12 秒，也不是永不消失）', () => {
    expect(autoDismissDelayMs('skipped')).toBe(6000)
    expect(autoDismissDelayMs('skipped')).toBe(autoDismissDelayMs('done'))
    expect(autoDismissDelayMs('pending')).toBeNull()
  })

  it('skipped 是终态（store 的 settled / 队列的 ✕ 按钮都靠它）', () => {
    expect(isTerminalStatus('skipped')).toBe(true)
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('error')).toBe(true)
    expect(isTerminalStatus('organizing')).toBe(false)
    expect(isTerminalStatus('extracting')).toBe(false)
    expect(isTerminalStatus('pending')).toBe(false)
  })

  it('skipped 文案：优先主进程 message，缺失时用同义兜底文案', () => {
    expect(importItemDetail({ status: 'skipped', message: '已跳过重复素材（原文件保留在原位）' })).toBe(
      '已跳过重复素材（原文件保留在原位）'
    )
    expect(importItemDetail({ status: 'skipped', message: '   ' })).toBe(
      '已跳过重复素材（原文件保留在原位）'
    )
  })

  it('done + overwrite / keep-both 的文案（docs/27 §6.1）', () => {
    expect(
      importItemDetail({
        status: 'done',
        conflict: { reason: 'zhimo-id', resolution: 'overwrite', existingName: '现代壁灯' }
      })
    ).toBe('已覆盖到「现代壁灯」')

    // keep-both：优先用真实落库名（uniqueName 可能给 -2 / -3）
    expect(
      importItemDetail({
        status: 'done',
        asset: { name: '卧室双人床-2', relFolder: '模型/家具/卧室/卧室双人床-2' },
        conflict: { reason: 'same-name', resolution: 'keep-both', existingName: '卧室双人床' }
      })
    ).toBe('已保留为「卧室双人床-2」')

    // 拿不到真实资产名时按 -2 兜底
    expect(
      importItemDetail({
        status: 'done',
        conflict: { reason: 'same-name', resolution: 'keep-both', existingName: '卧室双人床' }
      })
    ).toBe('已保留为「卧室双人床-2」')
  })

  it('done + message：覆盖档的两条退化路径必须原样显示（不能被「已覆盖到「旧名」」吞掉）', () => {
    // main `doneMessage()` 只在这两种情况下给 message（importer.ts:423）
    // ① 旧目录已不存在 / 在库外 / kind 变了 → 按新素材落盘
    expect(
      importItemDetail({
        status: 'done',
        message: '已覆盖（原目录已不存在，按新素材落盘）',
        asset: { name: '现代壁灯', relFolder: '模型/灯具/现代壁灯' },
        conflict: { reason: 'zhimo-id', resolution: 'overwrite', existingName: '现代壁灯' }
      })
    ).toBe('已覆盖（原目录已不存在，按新素材落盘）')

    // ② 旧版本没能进回收站（被 DCC 占用）→ 用户必须知道"其实没进回收站"
    expect(
      importItemDetail({
        status: 'done',
        message: '已覆盖；旧版本未能移入回收站，已暂存为 .idbox-old-*',
        conflict: { reason: 'same-name', resolution: 'overwrite', existingName: '卧室双人床' }
      })
    ).toBe('已覆盖；旧版本未能移入回收站，已暂存为 .idbox-old-*')

    // 正常覆盖（无 message）仍走 §6.1 的文案
    expect(
      importItemDetail({
        status: 'done',
        conflict: { reason: 'same-name', resolution: 'overwrite', existingName: '卧室双人床' }
      })
    ).toBe('已覆盖到「卧室双人床」')
  })

  it('没有 conflict 的 done / error / 进行中：文案与 0.6.9 逐字符一致（不回归）', () => {
    expect(importItemDetail({ status: 'done', asset: { relFolder: '模型/家具/卧室/x' } })).toBe(
      '已归档到「模型」'
    )
    expect(importItemDetail({ status: 'done' })).toBe('已归档')
    expect(importItemDetail({ status: 'error' })).toBe('导入失败')
    expect(importItemDetail({ status: 'error', message: '解压失败' })).toBe('解压失败')
    expect(
      importItemDetail({ status: 'error', needBytes: 2 * 1024 ** 3, freeBytes: 1 * 1024 ** 3 })
    ).toBe('可用 1.0 GB / 需要 2.0 GB')
    expect(importItemDetail({ status: 'organizing' })).toBe('处理中…')
    expect(importItemDetail({ status: 'extracting', message: '正在解压…' })).toBe('正在解压…')
  })

  it('跳过汇总文案（§3.1 的 toast 原话）', () => {
    expect(skippedSummaryText(3)).toBe('已跳过 3 个重复素材，原文件保留在原位')
    expect(skippedSummaryText(0)).toBeNull()
    expect(skippedSummaryText(-1)).toBeNull()
    expect(skippedSummaryText(Number.NaN)).toBeNull()
  })

  it('覆盖汇总文案（与跳过对称；M 夹在 [0, N]）', () => {
    expect(overwriteSummaryText(2)).toBe('已覆盖 2 个重复素材（旧版在系统回收站）')
    expect(overwriteSummaryText(2, 1)).toBe('已覆盖 2 个重复素材，其中 1 个旧版未进回收站')
    expect(overwriteSummaryText(2, 9)).toBe('已覆盖 2 个重复素材，其中 2 个旧版未进回收站')
    expect(overwriteSummaryText(2, -1)).toBe('已覆盖 2 个重复素材（旧版在系统回收站）')
    expect(overwriteSummaryText(0)).toBeNull()
    expect(overwriteSummaryText(Number.NaN)).toBeNull()
  })
})

// ── ⑤ 真实 store：订阅 / 答复 / skipped 计入 settled / 汇总 toast ──

describe('store 接线（docs/27 T-06）', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // ⚠️ 不能把 `askHandler` 置 null：重复询问的订阅是**幂等**的（整个文件只注册一次），
    // 后续 init 不会重新注册，置 null 就再也拿不到回调了。`importHandler` / `batchDoneHandler`
    // 每次 init 都会重订，置 null 安全。
    importHandler = null
    batchDoneHandler = null
    useVault.setState({ imports: [], assets: [], notice: null, conflictAsk: null })
    await useVault.getState().init()
  })

  it('订阅幂等：重复 init / 重复 ensureConflictAskSubscribed 只注册一次（否则一次询问被处理多次）', async () => {
    expect(modvault.onImportConflictAsk).toHaveBeenCalledTimes(1)
    expect(modvault.onImportConflictExpired).toHaveBeenCalledTimes(1)
    await useVault.getState().init()
    ensureConflictAskSubscribed()
    ensureConflictAskSubscribed()
    expect(modvault.onImportConflictAsk).toHaveBeenCalledTimes(1)
    // 作废通道与 ask 共用同一个守卫，同样只订一次
    expect(modvault.onImportConflictExpired).toHaveBeenCalledTimes(1)
    // 且注册的那个 handler 真的写进 store（弹窗可见性只有一个真相）
    expect(askHandler).not.toBeNull()
    expect(expiredHandler).not.toBeNull()
    askHandler!(ask())
    expect(useVault.getState().conflictAsk?.requestId).toBe('req-1')
  })

  it('answerConflict：把载荷原样交给主进程，并把 conflictAsk 清空', async () => {
    useVault.setState({ conflictAsk: ask() })
    const answer = { requestId: 'req-1', batchDefault: 'overwrite' as const }

    await useVault.getState().answerConflict(answer)

    expect(modvault.answerImportConflict).toHaveBeenCalledTimes(1)
    expect(modvault.answerImportConflict).toHaveBeenCalledWith(answer)
    expect(useVault.getState().conflictAsk).toBeNull()
  })

  it('answerConflict：主进程不可达（invoke reject）时仍然清空，弹窗不会永远挂着', async () => {
    modvault.answerImportConflict.mockRejectedValueOnce(new Error('render gone'))
    useVault.setState({ conflictAsk: ask() })

    await expect(
      useVault.getState().answerConflict({ requestId: 'req-1', batchDefault: 'skip' })
    ).resolves.toBeUndefined()
    expect(modvault.answerImportConflict).toHaveBeenCalledTimes(1)
    expect(useVault.getState().conflictAsk).toBeNull()
  })

  // ── DEF-19-1：主进程单方面超时后，僵尸弹窗必须能被清掉 ──────────────

  it('DEF-19-1①：answerConflict 先同步清空再等 IPC —— IPC reject 时弹窗照样消失', async () => {
    modvault.answerImportConflict.mockRejectedValueOnce(new Error('render gone'))
    useVault.setState({ conflictAsk: ask() })

    const p = useVault.getState().answerConflict({ requestId: 'req-1', batchDefault: 'skip' })
    // **还没 await**：此刻必须已经清空（"先清再等"，不能等返回值）
    expect(useVault.getState().conflictAsk).toBeNull()

    await expect(p).resolves.toBeUndefined()
    expect(modvault.answerImportConflict).toHaveBeenCalledTimes(1)
    expect(useVault.getState().conflictAsk).toBeNull()
  })

  it('DEF-19-1②：作废事件 requestId 匹配 → 清空 + 中性提示', () => {
    useVault.setState({ conflictAsk: { ...ask(), requestId: 'req-exp' }, notice: null })

    expiredHandler!({ requestId: 'req-exp' })

    expect(useVault.getState().conflictAsk).toBeNull()
    expect(useVault.getState().notice).toBe('已超时未答复，本次重复项已全部按跳过处理')
  })

  it('DEF-19-1③：作废事件 requestId 不匹配 → 绝不能关掉当前这条（迟到的作废）', () => {
    useVault.setState({ conflictAsk: { ...ask(), requestId: 'req-current' }, notice: null })

    expiredHandler!({ requestId: 'req-stale' })

    expect(useVault.getState().conflictAsk?.requestId).toBe('req-current')
    expect(useVault.getState().notice).toBeNull()
  })

  it('DEF-19-1④：conflictAsk 本来就是 null 时收到作废事件 → 不抛、不产生提示（幂等）', () => {
    useVault.setState({ conflictAsk: null, notice: null })

    expect(() => expiredHandler!({ requestId: 'req-whatever' })).not.toThrow()
    expect(useVault.getState().notice).toBeNull()
  })

  it('DEF-19-1⑤：看门狗兜底 —— 事件没到时 121s 后同样清空（同一条文案，不重复入队）', () => {
    vi.useFakeTimers()
    try {
      useVault.setState({ notice: null })
      // 记录"notice 每次变成新文案"，用于断言不会重复入队
      const shown: string[] = []
      let last: string | null = null
      const unsub = useVault.subscribe((s) => {
        if (s.notice && s.notice !== last) {
          last = s.notice
          shown.push(s.notice)
        }
      })

      askHandler!({ ...ask(), requestId: 'req-timeout' })
      expect(useVault.getState().conflictAsk?.requestId).toBe('req-timeout')

      // 120s：主进程刚超时，还没到渲染层余量 → 弹窗仍在
      vi.advanceTimersByTime(120_000)
      expect(useVault.getState().conflictAsk?.requestId).toBe('req-timeout')

      // 121s：看门狗收尸
      vi.advanceTimersByTime(1_000)
      expect(useVault.getState().conflictAsk).toBeNull()
      expect(useVault.getState().notice).toBe('已超时未答复，本次重复项已全部按跳过处理')

      // 迟到的作废事件：conflictAsk 已是 null → 幂等，不会把提示再入队一次
      expiredHandler!({ requestId: 'req-timeout' })
      vi.advanceTimersByTime(4_500)

      unsub()
      expect(shown).toEqual(['已超时未答复，本次重复项已全部按跳过处理'])
      // 没有伪造答复（主进程早把该 requestId 丢弃）
      expect(modvault.answerImportConflict).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * DEF-19-1⑧：两条 toast 都必须出现，顺序按主进程的**真实时序**（不可人为控制）。
   *
   * main 的 `sendConflictAsk` 超时分支是 `send(importConflictExpired)` → 再 `resolve(null)`，
   * 同一条 webContents 上 IPC 保序，所以渲染层**先**收到作废事件（超时提示），
   * 该条 skip 的 item 事件与 `batchDone` 排在后面（汇总 4.5s 后才轮到）。
   */
  it('DEF-19-1⑧：超时提示先出、批次汇总 4.5s 后继上（两条都在，互不吞并）', () => {
    vi.useFakeTimers()
    try {
      const seq: string[] = []
      let last: string | null = null
      const unsub = useVault.subscribe((s) => {
        if (s.notice && s.notice !== last) {
          last = s.notice
          seq.push(s.notice)
        }
      })
      useVault.setState({ notice: null })

      // 用户一直不答：弹窗在等
      askHandler!({ ...ask(), requestId: 'req-queue' })

      // 120s：主进程先发作废事件（此时批次还没收尾）→ 清弹窗 + 超时提示立刻展示
      expiredHandler!({ requestId: 'req-queue' })
      expect(useVault.getState().conflictAsk).toBeNull()
      expect(useVault.getState().notice).toBe('已超时未答复，本次重复项已全部按跳过处理')

      // 随后该条被 skip → item 事件 → batchDone → 跳过汇总入队，**不能同 tick 顶掉超时提示**
      importHandler!({
        item: 'E:\\a.zip',
        itemName: 'a.zip',
        status: 'skipped',
        message: '已跳过重复素材（原文件保留在原位）',
        conflict: { reason: 'same-name', resolution: 'skip', existingName: '卧室双人床' }
      })
      batchDoneHandler!()
      expect(useVault.getState().notice).toBe('已超时未答复，本次重复项已全部按跳过处理')

      // 4.5s 后批次汇总续上
      vi.advanceTimersByTime(4_500)
      expect(useVault.getState().notice).toBe('已跳过 1 个重复素材，原文件保留在原位')

      unsub()
      // 两条都出现过，且顺序 = 超时 → 汇总（主进程时序决定，渲染层不人为调序）
      expect(seq).toEqual([
        '已超时未答复，本次重复项已全部按跳过处理',
        '已跳过 1 个重复素材，原文件保留在原位'
      ])
      expect(seq.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * DEF-19-1⑨：反向顺序（批次汇总已在展示时才收到作废事件）—— 超时提示必须排队不丢。
   *
   * 真机顺序是 ⑧（事件先到）；这条覆盖"事件比 batchDone 晚到"的抖动 / 看门狗先触发后
   * 又收到迟到事件的场景，验证队列不会把超时提示丢掉、也不会把汇总顶掉。
   */
  it('DEF-19-1⑨：批次汇总正在展示时收到作废 → 超时提示排队，4.5s 后补上（不丢不顶）', () => {
    vi.useFakeTimers()
    try {
      const seq: string[] = []
      let last: string | null = null
      const unsub = useVault.subscribe((s) => {
        if (s.notice && s.notice !== last) {
          last = s.notice
          seq.push(s.notice)
        }
      })
      useVault.setState({ notice: null })

      askHandler!({ ...ask(), requestId: 'req-late' })

      // 批次先收尾（作废事件还没到）：汇总立刻展示
      importHandler!({
        item: 'E:\\a.zip',
        itemName: 'a.zip',
        status: 'skipped',
        message: '已跳过重复素材（原文件保留在原位）',
        conflict: { reason: 'same-name', resolution: 'skip', existingName: '卧室双人床' }
      })
      batchDoneHandler!()
      expect(useVault.getState().notice).toBe('已跳过 1 个重复素材，原文件保留在原位')

      // 迟到的作废事件：清弹窗，但**不能**顶掉正在展示的汇总
      expiredHandler!({ requestId: 'req-late' })
      expect(useVault.getState().conflictAsk).toBeNull()
      expect(useVault.getState().notice).toBe('已跳过 1 个重复素材，原文件保留在原位')

      vi.advanceTimersByTime(4_500)
      expect(useVault.getState().notice).toBe('已超时未答复，本次重复项已全部按跳过处理')

      unsub()
      expect(seq).toEqual([
        '已跳过 1 个重复素材，原文件保留在原位',
        '已超时未答复，本次重复项已全部按跳过处理'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('DEF-19-1⑥：用户按时答复 → 撤表，121s 后不再冒出"已超时"', async () => {
    vi.useFakeTimers()
    try {
      useVault.setState({ notice: null })
      askHandler!({ ...ask(), requestId: 'req-answered' })
      await useVault.getState().answerConflict({ requestId: 'req-answered', batchDefault: 'skip' })
      expect(useVault.getState().conflictAsk).toBeNull()

      vi.advanceTimersByTime(130_000)
      expect(useVault.getState().conflictAsk).toBeNull()
      expect(useVault.getState().notice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('DEF-19-1⑦：连续两次询问 → 只按最新那条计时（旧 requestId 不会误清新询问）', () => {
    vi.useFakeTimers()
    try {
      askHandler!({ ...ask(), requestId: 'req-old' })
      vi.advanceTimersByTime(60_000)
      askHandler!({ ...ask(), requestId: 'req-new' }) // 重新计时
      vi.advanceTimersByTime(61_000) // 距 req-old 已 121s，但 req-new 才 61s

      expect(useVault.getState().conflictAsk?.requestId).toBe('req-new')

      // 迟到的作废（req-old）也不能关掉 req-new
      expiredHandler!({ requestId: 'req-old' })
      expect(useVault.getState().conflictAsk?.requestId).toBe('req-new')

      vi.advanceTimersByTime(60_000) // req-new 满 121s
      expect(useVault.getState().conflictAsk).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skipped 计为终态（写 settledAt）并累计到批次汇总 toast', () => {
    importHandler!({
      item: 'E:\\a.zip',
      itemName: 'a.zip',
      status: 'skipped',
      message: '已跳过重复素材（原文件保留在原位）',
      conflict: { reason: 'same-name', resolution: 'skip', existingName: '卧室双人床' }
    })

    const item = useVault.getState().imports[0]!
    expect(item.status).toBe('skipped')
    // ⚠️ 这里是 T-06 的 `settled` 判定：漏掉 skipped 会让条目永不消失
    expect(typeof item.settledAt).toBe('number')
    expect(item.settledAt).toBeGreaterThan(0)
    expect(item.conflict?.existingName).toBe('卧室双人床')

    // 批次结束 → 一条汇总 notice（原文件保留在原位）
    batchDoneHandler!()
    expect(useVault.getState().notice).toBe('已跳过 1 个重复素材，原文件保留在原位')
  })

  it('没有跳过项时批次结束不给 toast（没跳过就不打扰）', () => {
    importHandler!({ item: 'E:\\b.zip', itemName: 'b.zip', status: 'done' })
    batchDoneHandler!()
    expect(useVault.getState().notice).toBeNull()
  })

  it('覆盖汇总：2 条 overwrite + 0 条退化 → 一条「（旧版在系统回收站）」', () => {
    importHandler!({
      item: 'E:\\1.zip',
      itemName: '1.zip',
      status: 'done',
      asset: { name: '现代壁灯' } as never,
      conflict: { reason: 'zhimo-id', resolution: 'overwrite', existingName: '现代壁灯' }
    })
    importHandler!({
      item: 'E:\\2.zip',
      itemName: '2.zip',
      status: 'done',
      asset: { name: '卧室双人床' } as never,
      conflict: { reason: 'same-name', resolution: 'overwrite', existingName: '卧室双人床' }
    })
    // keep-both 不算覆盖（没有"旧版进回收站"这回事）
    importHandler!({
      item: 'E:\\3.zip',
      itemName: '3.zip',
      status: 'done',
      asset: { name: '椅子-2' } as never,
      conflict: { reason: 'same-name', resolution: 'keep-both', existingName: '椅子' }
    })

    batchDoneHandler!()
    expect(useVault.getState().notice).toBe('已覆盖 2 个重复素材（旧版在系统回收站）')
  })

  it('覆盖汇总：degraded=true → 走「其中 M 个旧版未进回收站」（M=1）', () => {
    importHandler!({
      item: 'E:\\1.zip',
      itemName: '1.zip',
      status: 'done',
      asset: { name: '现代壁灯' } as never,
      // 退化由**事件字段**表达（不嗅探 message 文案）；message 只负责队列里的明细展示
      conflict: {
        reason: 'zhimo-id',
        resolution: 'overwrite',
        existingName: '现代壁灯',
        degraded: true
      },
      message: '已覆盖；旧版本未能移入回收站，已暂存为 .idbox-old-*'
    })

    batchDoneHandler!()
    // 绝不能笼统说"在回收站"——空间其实没释放
    expect(useVault.getState().notice).toBe('已覆盖 1 个重复素材，其中 1 个旧版未进回收站')
  })

  it('覆盖汇总：degraded=false 与 degraded 缺省（兼容口径）都按「在系统回收站」', () => {
    // false：主进程明确告诉我们没退化
    importHandler!({
      item: 'E:\\1.zip',
      itemName: '1.zip',
      status: 'done',
      asset: { name: '现代壁灯' } as never,
      conflict: {
        reason: 'zhimo-id',
        resolution: 'overwrite',
        existingName: '现代壁灯',
        degraded: false
      }
    })
    batchDoneHandler!()
    expect(useVault.getState().notice).toBe('已覆盖 1 个重复素材（旧版在系统回收站）')

    // 缺省：旧主进程 / 老日志 → 类型上只能按 false 处理（本版同包发布，无跨版本混用）
    useVault.setState({ notice: null })
    importHandler!({
      item: 'E:\\2.zip',
      itemName: '2.zip',
      status: 'done',
      asset: { name: '卧室双人床' } as never,
      conflict: { reason: 'same-name', resolution: 'overwrite', existingName: '卧室双人床' }
    })
    batchDoneHandler!()
    expect(useVault.getState().notice).toBe('已覆盖 1 个重复素材（旧版在系统回收站）')
  })

  it('同一批次同时有 skipped 与 overwrite → 两条 toast 依次发（互不吞并）', () => {
    vi.useFakeTimers()
    try {
      const seq: string[] = []
      const unsub = useVault.subscribe((s) => {
        if (s.notice) seq.push(s.notice)
      })

      importHandler!({
        item: 'E:\\a.zip',
        itemName: 'a.zip',
        status: 'skipped',
        message: '已跳过重复素材（原文件保留在原位）',
        conflict: { reason: 'same-name', resolution: 'skip', existingName: '卧室双人床' }
      })
      importHandler!({
        item: 'E:\\b.zip',
        itemName: 'b.zip',
        status: 'done',
        asset: { name: '现代壁灯' } as never,
        conflict: { reason: 'zhimo-id', resolution: 'overwrite', existingName: '现代壁灯' }
      })

      batchDoneHandler!()
      // 第一条立刻可见（跳过），第二条排队中
      expect(useVault.getState().notice).toBe('已跳过 1 个重复素材，原文件保留在原位')

      // 4.5s 后自动续上第二条（覆盖）
      vi.advanceTimersByTime(4500)
      expect(useVault.getState().notice).toBe('已覆盖 1 个重复素材（旧版在系统回收站）')

      unsub()
      expect(seq).toEqual([
        '已跳过 1 个重复素材，原文件保留在原位',
        '已覆盖 1 个重复素材（旧版在系统回收站）'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('importPaths 把判重快照作为第二个参数传下去（D22），且快照排除软删', async () => {
    const alive = asset({ name: '活的' })
    const trashed = asset({ name: '已删', deletedAt: 1_760_000_000_000 })
    useVault.setState({ assets: [alive, trashed] })

    await useVault.getState().importPaths(['E:\\a.zip'])

    expect(modvault.importPaths).toHaveBeenCalledTimes(1)
    const [paths, ctx] = modvault.importPaths.mock.calls[0] as unknown as [
      string[],
      { index: Array<{ id: string; meta: Record<string, unknown> }> }
    ]
    expect(paths).toEqual(['E:\\a.zip'])
    expect(ctx.index.map((e) => e.id)).toEqual([alive.id])
    expect(ctx.index[0]!.meta).toHaveProperty('favorite')
    // pending 条目先入队（用户看得见"在排队/在跑"）
    expect(useVault.getState().imports[0]!.status).toBe('pending')
  })
})

// ── ⑥ 源码守卫（组件在 node 环境渲染不了，接线只能这样钉） ──────────

describe('源码守卫：组件接线', () => {
  const read = (p: string): string =>
    fs.readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf-8')

  it('ImportQueue 用 statusClass / isTerminalStatus / importItemDetail（不再自建 STATUS_CLS 表）', () => {
    const s = read('components/ImportQueue.tsx')
    expect(s).toContain('statusClass(')
    expect(s).toContain('isTerminalStatus(')
    expect(s).toContain('importItemDetail(')
    expect(s).not.toContain('STATUS_CLS')
    // 悬停暂停的既有行为不能被改坏
    expect(s).toContain('onMouseEnter')
    expect(s).toContain('onMouseLeave')
    expect(s).toContain('if (hovered || imports.length === 0) return')
  })

  it('弹窗：遮罩不关闭 + Esc 也不等同于「跳过」（0.7.6 T-ESC 裁定）', () => {
    const dialog = read('components/ImportConflictDialog.tsx')
    expect(dialog).toContain('dismissOnScrim={false}')
    // Esc 曾经 = submit(true) ≡ 整批按「跳过」，与关掉 dismissOnScrim 的理由自相矛盾。
    // 现在两处口径一致：都不许"顺手"把整批按跳过，取消导入只能点界面按钮。
    expect(dialog).toContain('dismissOnEsc={false}')
    expect(dialog).toContain('submit(true)')
    // 不再自己接 Esc（统一由 Modal 内置，见 tests/modalEsc.test.ts）
    expect(dialog).not.toContain("e.key !== 'Escape'")
    expect(dialog).not.toContain("addEventListener('keydown'")
    // 提交走 store 的唯一入口，不直接调 IPC
    expect(dialog).toContain('answerConflict(')
    expect(dialog).not.toContain('window.modvault.answerImportConflict')
    // 层级压在其它弹窗之上（§5.4）—— 0.7.8 T-ZSTACK 换实现：不再写死 z-[60]，
    // 改由 Esc 层栈深度算（后开的 = 栈顶 = 更高），与「Esc 先答它」同源。
    expect(dialog).not.toContain('z-[60]')
    expect(dialog).not.toContain('zClass=')
    expect(read('App.tsx')).toContain('<ImportConflictDialog />')
  })

  it('Modal：dismissOnScrim 默认 true（其余调用点零改动）', () => {
    const s = read('components/Modal.tsx')
    expect(s).toContain('dismissOnScrim = true')
    expect(s).toContain('dismissOnScrim ? onClose : undefined')
    // 新增的 Esc 开关同样默认 true：除导入重复处置外，其它弹窗零改动就获得 Esc
    expect(s).toContain('dismissOnEsc = true')
  })

  it('store：importPaths 传 ctx + skipped 计入 settled + 订阅幂等入口', () => {
    const s = read('store.ts')
    expect(s).toContain('buildDedupeSnapshot(get().assets)')
    expect(s).toContain('window.modvault.importPaths(paths, ctx)')
    expect(s).toContain('const settled = isTerminalStatus(ev.status)')
    expect(s).toContain('ensureConflictAskSubscribed()')
    expect(s).toContain('if (conflictUnsubscribers.length > 0) return')
    // ⚠️ 写入路径一行都不许改（覆盖 = 同一个 id 的 put，天然是替换同一行）
    expect(s).toContain('void db.assets.put(ev.asset)')
  })

  /**
   * 退化判定**只认结构化字段** `ImportEvent.conflict.degraded`。
   *
   * 主理人明确否掉了两种替代方案（按中文文案子串嗅探 / 按 message 有无推断），
   * 理由是文案一改就静默退化成"谎称旧版在回收站"，而这是数据安全信息。
   * 所以这里做源码守卫：嗅探函数不许存在，相关中文子串不许出现在**代码**里
   * （注释里解释这两条 main 文案不算违规，故先剔除注释行）。
   */
  it('源码守卫：退化判定只读 conflict.degraded，代码里不许有文案嗅探', () => {
    const importText = read('logic/importText.ts')
    const store = read('store.ts')

    // ① 嗅探函数彻底消失（不留"备用路径"）
    expect(importText).not.toContain('isDegradedOverwriteMessage')
    expect(store).not.toContain('isDegradedOverwriteMessage')

    // ② importText 的**代码行**里不许出现两条退化文案的中文子串
    const codeOf = (src: string): string =>
      src
        .split('\n')
        .filter((l) => {
          const t = l.trim()
          return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
        })
        .join('\n')
    expect(codeOf(importText)).not.toContain('未能移入回收站')
    expect(codeOf(importText)).not.toContain('原目录已不存在')

    // ③ store 的导入事件处理段：只用字段判定，不出现任何文案嗅探
    const start = store.indexOf('onImportEvent(')
    const end = store.indexOf("if (ev.status === 'done' && ev.asset)")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handler = store.slice(start, end)
    expect(handler).toContain('ev.conflict?.resolution === \'overwrite\'')
    expect(handler).toContain('ev.conflict.degraded === true')
    expect(handler).not.toContain('未能移入回收站')
    expect(handler).not.toContain('原目录已不存在')
    expect(handler).not.toContain('message.includes')
  })

  it('弹窗不写死色值（只用 token 类名），深浅两主题都能看', () => {
    const s = read('components/ImportConflictDialog.tsx')
    // 排除注释里的示例，只看 className 里的 #rrggbb
    const classLines = s.split('\n').filter((l) => l.includes('className'))
    for (const l of classLines) expect(l).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // 外壳的底色 / 描边由 Modal 提供（bg-card / border-line），本组件内部用 canvas 底 + 分隔线
    expect(s).toContain('bg-canvas')
    expect(s).toContain('border-line')
    expect(s).toContain('divide-line')
    expect(s).toContain('chip-accent')
    expect(s).toContain('text-secondary')
  })
})
