/**
 * 导入取消 · **渲染层入口** 的接线验收（2026-10，数据层见 commit `0885189`）。
 *
 * 分两半，都在这里钉住：
 *
 * **A. `store.cancelImport()` 的真实行为**（不打桩实现，只打桩两个边界：
 *    `window.modvault`（IPC 桥）→ vi.fn；这样驱动的是**实际发布的 store action**）。
 *    重点不是"有没有调 IPC"，而是**本地乐观标记的边界**：
 *    - 只有 `pending` 变 `cancelled`；
 *    - `extracting` / `organizing` **一个字段都不能动**（拿 `toBe` 断言引用不变）。
 *      它们正在做，标成 cancelled 会先被 6 秒倒计时删卡、再被 `done` 事件追加到队尾，
 *      卡片"消失又冒出来"—— 这是本文件最想挡住的那个回归。
 *
 * **B. `ImportQueue.tsx` 的源码 guard**：`environment: 'node'`，没有 jsdom，
 *    所以不写渲染测试，改为读源码断言结构。三条硬约束都靠 `indexOf` 数字钉住：
 *    ① 「全部取消」必须排在卡片 `map` 之**后**（`flex-col-reverse` 下 DOM 末尾 = 视觉顶部）；
 *    ② 用到 `runningCount` / `isTerminalStatus`（口径跟终态定义同源）；
 *    ③ 不许出现 danger 红（取消不是危险操作，与 `skipped` / `cancelled` 的中性口径一致）。
 *
 * **C. `store.ts` 的源码 guard**：确认实现块里只有 `pending` 一个分支，
 *    且 IPC 调用被 `try` 包住（preload 缺失时不能把队列/设置页炸掉）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import type { ImportItem } from '../src/renderer/store'

// ── 边界打桩 ①：IPC 桥 ────────────────────────────────────────────────
// `cancelImport` 是 fire-and-forget（返回 void，没有回执），所以桩也返回 undefined。
// 故意**不加** mockResolvedValue：若实现改成 await 一个非 Promise，这里能立刻暴露。
const modvault = {
  cancelImport: vi.fn()
}

;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ─────────────────────────────────────────────────────────────

/** 造一条队列条目（只填必要字段，行为断言只关心 status / message / settledAt） */
function item(name: string, status: ImportItem['status'], over: Partial<ImportItem> = {}): ImportItem {
  return { item: `E:\\Lib\\in\\${name}`, itemName: name, status, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  modvault.cancelImport.mockReset()
  useVault.setState({ imports: [] })
})

// ── A. store action 行为 ─────────────────────────────────────────────

describe('store.cancelImport()', () => {
  // ① 只调一次 IPC
  it('调 window.modvault.cancelImport() 恰好 1 次', () => {
    useVault.setState({ imports: [item('a.zip', 'pending')] })

    useVault.getState().cancelImport()

    expect(modvault.cancelImport).toHaveBeenCalledTimes(1)
  })

  // ② 只动 pending；其余四档**引用不变**
  it('只把 pending 标成 cancelled，其它状态的对象引用完全不变', () => {
    const pendingA = item('a.zip', 'pending')
    const pendingB = item('b.zip', 'pending')
    const extracting = item('c.zip', 'extracting')
    const organizing = item('d.zip', 'organizing', { asset: { id: 'x' } as ImportItem['asset'] })
    const done = item('e.zip', 'done', { settledAt: 1_700_000_000_000 })
    const error = item('f.zip', 'error', { settledAt: 1_700_000_000_001 })
    useVault.setState({
      imports: [pendingA, pendingB, extracting, organizing, done, error]
    })

    useVault.getState().cancelImport()

    const after = useVault.getState().imports
    expect(after).toHaveLength(6)

    // a / b：原地补丁 —— item / itemName 保住（列表 key 与文案不变），status 换掉
    for (const [idx, src] of [
      [0, pendingA],
      [1, pendingB]
    ] as const) {
      const cur = after[idx]
      expect(cur.status).toBe('cancelled')
      // 文案与主进程逐字一致（两套说法会让用户怀疑到底停没停）
      expect(cur.message).toBe('已取消：这一项还没开始处理')
      expect(typeof cur.settledAt).toBe('number')
      expect(cur.item).toBe(src.item)
      expect(cur.itemName).toBe(src.itemName)
    }

    // c / d / e / f：**必须**是同一个对象引用（`toBe`，不是 `toEqual`）。
    // 只要实现里手滑写成"把 extracting 也算 cancelled"，这条立刻红。
    expect(after[2]).toBe(extracting)
    expect(after[3]).toBe(organizing)
    expect(after[4]).toBe(done)
    expect(after[5]).toBe(error)
  })

  // ③ IPC 抛错不冒泡，且本地标记照做
  it('IPC 抛错时不冒泡，pending 仍被本地标记', () => {
    modvault.cancelImport.mockImplementation(() => {
      throw new Error('preload 缺失')
    })
    useVault.setState({ imports: [item('a.zip', 'pending')] })

    // 不冒泡 = 不抛。若实现漏了 try，这里直接红
    expect(() => useVault.getState().cancelImport()).not.toThrow()

    const cur = useVault.getState().imports[0]
    expect(cur.status).toBe('cancelled')
    expect(cur.message).toBe('已取消：这一项还没开始处理')
  })

  // ④ 空队列调用无害
  it('imports 为空时调用不抛，队列仍为空', () => {
    useVault.setState({ imports: [] })

    expect(() => useVault.getState().cancelImport()).not.toThrow()

    expect(useVault.getState().imports).toHaveLength(0)
    // 空批次也照发 IPC：主进程那边幂等，且可能有监控目录导入的批次在跑
    expect(modvault.cancelImport).toHaveBeenCalledTimes(1)
  })

  // ⑤ 幂等：连点两次
  it('连调两次：IPC 调 2 次，状态不重复变化', () => {
    useVault.setState({ imports: [item('a.zip', 'pending'), item('b.zip', 'extracting')] })

    useVault.getState().cancelImport()
    const first = useVault.getState().imports
    useVault.getState().cancelImport()
    const second = useVault.getState().imports

    expect(modvault.cancelImport).toHaveBeenCalledTimes(2)

    // 第二次没有 pending 可改 → 每条都是**原对象**（`map` 里走 `: i` 分支），
    // 连 `settledAt` 都不会重算（重算会让 6 秒倒计时莫名复活）。
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second).toEqual(first)
    expect(second[0].status).toBe('cancelled')
    expect(second[1].status).toBe('extracting')
  })
})

// ── 源码读入（B / C 两段共用） ─────────────────────────────────────────

const queueSrc = readFileSync(
  fileURLToPath(new URL('../src/renderer/components/ImportQueue.tsx', import.meta.url)),
  'utf8'
)
const storeSrc = readFileSync(
  fileURLToPath(new URL('../src/renderer/store.ts', import.meta.url)),
  'utf8'
)

// ── B. ImportQueue.tsx 源码 guard ─────────────────────────────────────

describe('ImportQueue.tsx 源码', () => {
  // ⑥ 有按钮文案、有 action 接线
  it('含「全部取消」与 cancelImport', () => {
    expect(queueSrc).toContain('全部取消')
    expect(queueSrc).toContain('cancelImport')
  })

  // ⑦ 可见性口径与终态定义同源
  it('含 runningCount 与 isTerminalStatus', () => {
    expect(queueSrc).toContain('runningCount')
    expect(queueSrc).toContain('isTerminalStatus')
    // 从 store 取 action（而不是直接摸 window.modvault）
    expect(queueSrc).toContain('useVault((s) => s.cancelImport)')
  })

  // ⑧ **位置断言**：取消条必须排在卡片 map 之后（column-reverse → DOM 末尾 = 视觉顶部）
  it('「全部取消」的源码位置在卡片渲染块之后', () => {
    const cardAnchor = queueSrc.indexOf('imports.slice(-6).reverse().map')
    const cancelAnchor = queueSrc.indexOf('全部取消')

    expect(cardAnchor).toBeGreaterThan(-1)
    expect(cancelAnchor).toBeGreaterThan(-1)
    // 严格大于 → 取消条在卡片之后。写成 `<=` 就会渲染到卡片栈下方（贴着 bottom-14），
    // 看起来像"最新一条"，是这次最容易被挪错的地方。
    expect(cancelAnchor).toBeGreaterThan(cardAnchor)
  })

  // ⑨ 取消不是危险操作 —— 不许 danger 红
  it('不含 hover:bg-danger / text-danger', () => {
    expect(queueSrc).not.toContain('hover:bg-danger')
    expect(queueSrc).not.toContain('text-danger')
  })

  // 补充：不要把二次确认塞进来（无损操作，弹窗只会让用户多点一次）
  it('不加二次确认弹窗', () => {
    const start = queueSrc.indexOf('{hasRunning &&')
    expect(start).toBeGreaterThan(-1)
    const cancelBlock = queueSrc.slice(start)
    expect(cancelBlock).not.toContain('confirm(')
    expect(cancelBlock).not.toContain('Modal')
    expect(cancelBlock).not.toContain('setNotice')
  })
})

// ── C. store.ts 源码 guard ────────────────────────────────────────────

describe('store.ts 的 cancelImport 实现', () => {
  /** 取出实现块（从 `cancelImport: () => {` 到紧随其后的 `\n  },` 收尾） */
  function cancelBlock(): string {
    // ⚠️ 必须带 `{`：接口里那句是 `cancelImport: () => void`，不带 `{` 会先命中接口声明，
    // 于是截到的"实现块"会一路吃到下面几百行action，断言全部失真。
    const start = storeSrc.indexOf('cancelImport: () => {')
    expect(start).toBeGreaterThan(-1)
    const end = storeSrc.indexOf('\n  },', start)
    expect(end).toBeGreaterThan(start)
    return storeSrc.slice(start, end)
  }

  // ⑩ 只对 pending 打补丁，块内不出现 extracting
  it('只判 i.status === \'pending\'，实现块里不出现 extracting', () => {
    const block = cancelBlock()
    expect(block).toContain("i.status === 'pending'")
    // 这条是"手滑回归"的哨兵：把 extracting / organizing 也标成 cancelled 会让卡片
    // 先被倒计时删掉、再被 done 事件追加到队尾（消失又冒出来）。
    expect(block).not.toContain("'extracting'")
    expect(block).not.toContain("'organizing'")
  })

  // ⑪ IPC 调用被 try 包住
  it('含 window.modvault.cancelImport() 且被 try 包住', () => {
    const block = cancelBlock()
    expect(block).toContain('window.modvault.cancelImport()')

    const tryAt = block.indexOf('try {')
    const callAt = block.indexOf('window.modvault.cancelImport()')
    const catchAt = block.indexOf('catch')
    expect(tryAt).toBeGreaterThan(-1)
    expect(catchAt).toBeGreaterThan(tryAt)
    // try{ ... } catch{ ... } 的完整包裹：调用夹在中间
    expect(callAt).toBeGreaterThan(tryAt)
    expect(callAt).toBeLessThan(catchAt)
  })
})
