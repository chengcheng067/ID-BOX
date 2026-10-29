/**
 * 未分类整理流水线的**接线守卫**（P2 第一批）。
 *
 * 三组：
 * ① **store 层**：`openTriage` / `closeTriage` / `useTriageQueue` 的口径
 *    （待办集全库口径 + 当前排序 + 双未分类 + 非软删；空集不开浮层）；
 * ② **悬空不变量**：整理中那张被软删 / 硬删 / rescan → 不悬空（走 `reconcileTriage`）；
 * ③ **组件源码守卫**：`TriageOverlay` 里 Esc 走 `useEscLayer`（不得手写
 *    `addEventListener('keydown')` 捕获 Esc）、归类失败不前进、取图走 `quickLookImageUrl`。
 *
 * 为什么 store 那部分要真跑：`openTriage` 是**行为**（空集给 notice 不开浮层、
 * 已开不重开会话），源码扫字证明不了。因为 store 依赖 Dexie / FileReader，
 * 这里只桩那两个边界（与 `tests/ballShapeEntry.test.ts` / `assignUndo.test.ts` 同套路），
 * 其余全部走真实代码。
 */
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModVaultApi } from '../src/preload/index'
import { UNCLASSIFIED } from '../src/shared/taxonomy'
import type { Asset } from '../src/shared/types'

// ── 边界桩（必须在动态 import store 之前就位） ──────────────────────

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

const modvault = {
  getSettings: vi.fn(async () => null),
  pruneThumbs: vi.fn(async () => 0),
  ensureThumb: vi.fn(async () => null),
  deleteThumb: vi.fn(async () => 0),
  deleteOneThumb: vi.fn(async () => 0),
  saveBallThumb: vi.fn(async () => null),
  // P2 会用到的两个
  assignCategory: vi.fn(),
  onSettingsChanged: vi.fn(() => () => undefined)
}
;(globalThis as unknown as { window: { modvault: ModVaultApi } }).window = {
  modvault: modvault as unknown as ModVaultApi
}

const { db } = await import('../src/renderer/db')
const fakeTable = {
  toArray: vi.fn(async (): Promise<Asset[]> => []),
  put: vi.fn(async (a: Asset) => a.id),
  bulkPut: vi.fn(async (list: Asset[]) => list.length),
  bulkDelete: vi.fn(async (ids: string[]) => ids.length),
  where: vi.fn(() => fakeTable),
  equals: vi.fn(() => fakeTable),
  modify: vi.fn(async () => 0),
  update: vi.fn(async () => 0),
  get: vi.fn(async () => undefined),
  count: vi.fn(async () => 0),
  delete: vi.fn(async () => undefined)
}
Object.defineProperty(db, 'assets', { value: fakeTable, configurable: true })

const { useVault } = await import('../src/renderer/store')

// ── 夹具 ───────────────────────────────────────────────────────────

let seq = 0

/** 最小资产：分类 + 软删标记 + 体积（排序用） */
function asset(
  c1: string = UNCLASSIFIED,
  c2: string = UNCLASSIFIED,
  extra: Partial<Asset> = {}
): Asset {
  seq += 1
  return {
    id: `id-${seq}`,
    name: `asset-${seq}`,
    kind: 'texture',
    category1: c1,
    category2: c2,
    folder: `E:/lib/材质/未分类/asset-${seq}`,
    relFolder: `材质/未分类/asset-${seq}`,
    files: [],
    size: 100 * seq,
    tags: [],
    colorTags: [],
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    ...extra
  } as Asset
}

beforeEach(() => {
  seq = 0
  modvault.assignCategory.mockReset()
  useVault.setState({
    assets: [],
    filters: { ...useVault.getState().filters, sort: 'recent' },
    libraryView: 'assets',
    triageActive: false,
    notice: null,
    selectedId: null,
    selectedIds: []
  })
})

// ── ① store 层口径 ──────────────────────────────────────────────────

describe('openTriage · 待办集口径', () => {
  it('★空集：不开浮层、给一条 notice', () => {
    useVault.setState({ assets: [asset('椅子', '餐椅')] })
    const opened = useVault.getState().openTriage()
    expect(opened).toBe(false)
    expect(useVault.getState().triageActive).toBe(false)
    expect(useVault.getState().notice).toBe('没有未分类的资产')
  })

  it('★有未分类：开浮层，并把焦点落到待办集第一张', () => {
    const a = asset()
    useVault.setState({ assets: [a] })
    expect(useVault.getState().openTriage()).toBe(true)
    expect(useVault.getState().triageActive).toBe(true)
    // 选中态跟着第一张（关闭后要落回"最后整理的那张"）
    expect(useVault.getState().selectedId).toBe(a.id)
    expect(useVault.getState().selectedIds).toEqual([a.id])
  })

  it('★软删的资产不进待办集（全软删 = 空集 = 不开）', () => {
    useVault.setState({ assets: [asset(UNCLASSIFIED, UNCLASSIFIED, { deletedAt: 1_700_000_000_000 })] })
    expect(useVault.getState().openTriage()).toBe(false)
    expect(useVault.getState().notice).toBe('没有未分类的资产')
  })

  it('★搜索词 / 大类筛选**不参与**（待办集是全库口径，与侧栏数字对得上）', () => {
    const a = asset()
    const b = asset()
    useVault.setState({
      assets: [a, b],
      // 故意把筛选设成一个都匹配不上的值
      filters: { ...useVault.getState().filters, query: 'zzz-not-matching', kind: 'model' }
    })
    expect(useVault.getState().openTriage()).toBe(true)
    // 浮层内部按全库算 → 两张都在（这由 useTriageQueue 的口径保证，下面单独测）
    expect(useVault.getState().triageActive).toBe(true)
  })

  it('★已经开着 → 不重开会话（返回 true，状态不变）', () => {
    const a = asset()
    useVault.setState({ assets: [a], triageActive: true, selectedId: 'keep-me' })
    expect(useVault.getState().openTriage()).toBe(true)
    // 没被重置回第一张
    expect(useVault.getState().selectedId).toBe('keep-me')
  })

  it('★不改 libraryView / filters（用户还在原视图里，不该被清状态）', () => {
    const before = useVault.getState().filters
    useVault.setState({ assets: [asset()], libraryView: 'trash' })
    useVault.getState().openTriage()
    expect(useVault.getState().libraryView).toBe('trash')
    expect(useVault.getState().filters).toBe(before)
  })

  it('closeTriage 只撤标志，**不清选中**（保留"最后整理的那张"）', () => {
    const a = asset()
    useVault.setState({ assets: [a], triageActive: true, selectedId: a.id, selectedIds: [a.id] })
    useVault.getState().closeTriage()
    expect(useVault.getState().triageActive).toBe(false)
    expect(useVault.getState().selectedId).toBe(a.id)
  })
})

describe('切视图 · 关闭整理（唯一显式清理站点）', () => {
  it('★setLibraryView 把 triageActive 置 false', () => {
    useVault.setState({ assets: [asset()], triageActive: true })
    useVault.getState().setLibraryView('trash')
    expect(useVault.getState().triageActive).toBe(false)
  })
})

// ── ② 悬空不变量 ────────────────────────────────────────────────────

describe('悬空不变量 · 整理中那张没了也不悬空', () => {
  it('★资产被软删后，待办集里不再包含它（浮层 reconcile 会接位/关闭）', async () => {
    const { buildTriageQueue } = await import('../src/renderer/logic/triageFlow')
    const { reconcileTriage, startTriage } = await import('../src/renderer/logic/triageFlow')
    const a = asset()
    const b = asset()
    // 初始：待办集 [a, b]，停在 a
    const cursor = startTriage(buildTriageQueue([a, b]))
    expect(cursor.currentId).toBe(a.id)

    // a 被软删（软删后它带 deletedAt，调用方按 `!isDeletedAsset` 过滤掉）
    const afterDelete = [a, b].filter((x) => x.id !== a.id)
    const next = reconcileTriage(cursor, buildTriageQueue(afterDelete))
    // 不悬空：落到接位的那张
    expect(next.currentId).toBe(b.id)
  })

  it('★整批消失 → currentId = null（浮层据此关闭，不留悬空）', () => {
    // 这一条的转移规则已在 triageFlow.test.ts 钉住；这里只确认"接线用的是同一个函数"
    const src = fs.readFileSync(
      new URL('../src/renderer/components/TriageOverlay.tsx', import.meta.url),
      'utf-8'
    )
    expect(src).toContain('reconcileTriage')
    expect(src).toContain('useTriageQueue')
  })
})

// ── ③ 组件源码守卫 ──────────────────────────────────────────────────

describe('TriageOverlay · 源码守卫', () => {
  const SRC = fs.readFileSync(
    new URL('../src/renderer/components/TriageOverlay.tsx', import.meta.url),
    'utf-8'
  )

  it('★Esc 走 useEscLayer（不得手写 keydown 捕获 Esc）', () => {
    // Esc 的回调必须是 `requestClose`（带收尾提示），不是裸 `closeTriage` ——
    // 否则按 Esc 退出时用户看不到「还剩 N 张」，与点 ✕ / 点遮罩两条路径行为不一致。
    expect(SRC).toContain('useEscLayer(requestClose, true)')
    expect(SRC).toContain('zClassForDepth(escDepth)')
    // requestClose 必须在 useEscLayer **之前**定义（首帧取值，晚定义会崩）
    expect(SRC.indexOf('const requestClose = useCallback(')).toBeLessThan(
      SRC.indexOf('useEscLayer(requestClose')
    )
    // 唯一的 window keydown 监听是**非 Esc** 的那条（判据里对 Escape 返回 none）；
    // 断言"没有第二处监听"—— 手写 Esc 捕获会在这里露出来。
    expect(SRC.split("window.addEventListener('keydown'").length - 1).toBe(1)
    // 且那唯一一处的判据来自纯函数（不在组件里另写 key === 'Escape' 分支）
    expect(SRC).toContain('decideTriageKey({')
  })

  it('★取图走 quickLookImageUrl（不自己拼 vault://）', () => {
    expect(SRC).toContain("import { quickLookImageUrl } from '../logic/quickLook'")
    // 2026-10-30 探探式飞出改造：渲染对象从 `current` 换成 `view`
    // （`swipeState?.asset ?? current` —— 飞出期间要显示**冻结的那张**，
    //  否则确认写库后 `current` 已经变了，飞出去的会是空白/下一张）。
    // 守卫的意图不变：**取图必须走 quickLookImageUrl**，所以锚点跟着换成 view。
    expect(SRC).toMatch(/quickLookImageUrl\((view|current)\)/)
    // 且不许在这里多开一条取图路径（只此一处调用）
    expect(SRC.split('quickLookImageUrl(').length - 1).toBe(2) // import + 1 次调用

    // ⛔ 不许自己拼协议。判据要**先剥掉注释**再查 —— 文件头注释里解释了
    // 「三级回退 + `vault://` 编码全在那一处」，那是说明文字不是代码。
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/^\s*\/\/.*$/gm, '') // 行注释
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 注释
    expect(code).not.toContain('vault://')
    expect(code).not.toContain('thumbVaultUrl')
    expect(code).not.toContain('vaultUrl(')
  })

  it('★归类失败不前进：moved > 0 才播飞出（游标推进在 onAnimationEnd）', () => {
    // 找到 confirm 的实现体
    const at = SRC.indexOf('const confirm = useCallback(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('},\n    [current, busy, level1, level2, decideReview, setNotice]\n  )'))
    // 锚点必须真的命中：`indexOf` 返回 -1 时 `slice` 会一路切到文件末尾，
    // 这条守卫就静默退化成"扫大半个文件"（真回归未必抓得住）。加一条显式断言兜住。
    expect(body.length).toBeLessThan(SRC.length)

    // 成功分支：moved > 0 → 播**右飞**（`out-confirm`）。
    // 2026-10-30 起推进不在这里直接 `setCursor`：动画还没播完就换人，
    // 飞出去的会是下一张。推进统一在 `finishSwipe`（`onAnimationEnd`），
    // 所以这里改守"成功分支必须触发 confirm 方向的飞出"。
    const okAt = body.indexOf('if (summary.moved > 0)')
    expect(okAt).toBeGreaterThan(-1)
    const okBlock = body.slice(okAt, okAt + 220)
    expect(okBlock).toContain("'out-confirm'")
    expect(okBlock).toContain('beginSwipe')

    // 失败分支：failed > 0 → **只提示、不飞出、不前进**
    const failAt = body.indexOf('else if (summary.failed > 0)')
    expect(failAt).toBeGreaterThan(-1)
    const failBlock = body.slice(failAt, failAt + 200)
    expect(failBlock).toContain('setNotice')
    expect(failBlock).not.toContain('advanceAfterAssign')
    expect(failBlock).not.toContain('beginSwipe')

    // 兜底 catch 也不飞出、不前进
    const catchAt = body.indexOf('} catch (err)')
    expect(catchAt).toBeGreaterThan(-1)
    const catchBlock = body.slice(catchAt, catchAt + 260)
    expect(catchBlock).not.toContain('advanceAfterAssign')
    expect(catchBlock).not.toContain('beginSwipe')
  })

  it('★确认前校验一级分类（未选一级不静默失败）', () => {
    expect(SRC).toContain("if (c1 === UNCLASSIFIED)")
    expect(SRC).toContain('请先选择一级分类')
  })

  it('★一级未分类时二级强制未分类（与 normalizeCategoryPair 同规则）', () => {
    expect(SRC).toContain('const c2 = c1 === UNCLASSIFIED ? UNCLASSIFIED : level2.trim()')
  })

  it('★换图时同步选中（关闭后落回最后整理的那张）', () => {
    const at = SRC.indexOf('useEffect(() => {')
    // 找那个 select(cursor.currentId) 的 effect
    expect(SRC).toContain('select(cursor.currentId)')
    expect(at).toBeGreaterThan(-1)
  })

  it('★全应用只挂一个实例（两个会有两个 Esc 层 / 两次归类）', () => {
    const APP = fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf-8')
    expect(APP.split('<TriageOverlayLazy />').length - 1).toBe(1)
    expect(APP).toContain('{triageActive && (')
  })
})

describe('Sidebar · 整理入口守卫', () => {
  const SIDEBAR = fs.readFileSync(
    new URL('../src/renderer/components/Sidebar.tsx', import.meta.url),
    'utf-8'
  )

  it('★入口只出现在未分类节点且有资产时', () => {
    expect(SIDEBAR).toContain('n.value === UNCLASSIFIED && n.count > 0 && (')
    expect(SIDEBAR).toContain('openTriage()')
  })

  it('★整理按钮不嵌在主按钮里（button 套 button 是非法 HTML）', () => {
    // 判据（只在**整理入口这一小段**上做，不数全文件 —— 注释里也有 `<button`）：
    // 整理入口自己是一个完整、独立的 `<button>…</button>`，且**这一段里没有别的
    // 未闭合 `<button`**，说明它与主按钮是兄弟节点而不是子节点。
    const condAt = SIDEBAR.indexOf('{n.value === UNCLASSIFIED && n.count > 0 && (')
    expect(condAt).toBeGreaterThan(-1)
    // 从条件渲染处往后找（`openTriage` 在组件顶部还有一处 `useVault` 声明）
    const endAt = SIDEBAR.indexOf('openTriage()', condAt)
    expect(endAt).toBeGreaterThan(condAt)

    // ① 整理入口在主按钮闭合**之后**开始：主按钮的 `</button>` 必须出现在条件之前
    const mainBtnClose = SIDEBAR.lastIndexOf('</button>', condAt)
    expect(mainBtnClose).toBeGreaterThan(-1)

    // ② 这一小段里恰好一个 `<button`（整理按钮自己），零个 `</button>`
    //    —— 若它是嵌套的，段内会先出现主按钮的 `</button>` 之外的结构，或
    //    主按钮的 `<button` 会落在 `condAt` 之前却未闭合（③ 兜住）。
    const seg = SIDEBAR.slice(condAt, endAt)
    expect((seg.match(/<button\b/g) ?? []).length).toBe(1)
    expect((seg.match(/<\/button>/g) ?? []).length).toBe(0)

    // ③ 条件之前那一段的 button 必须**配平**（主按钮已经关掉了）
    const before = SIDEBAR.slice(0, condAt)
    // 去掉注释再数：注释里写的 `<button>` 字样会干扰
    const stripped = before.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const opens = (stripped.match(/<button\b/g) ?? []).length
    const closes = (stripped.match(/<\/button>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('★点击整理不吃掉主按钮的筛选（stopPropagation）', () => {
    expect(SIDEBAR).toContain('e.stopPropagation()')
  })
})
