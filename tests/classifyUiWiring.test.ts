/**
 * 分类三源交叉验证的**三个 UI 入口**接线守卫（docs/35 · T-11 / T-12 / T-13）。
 *
 * ## 为什么全是源码守卫（而不是渲染测试）
 *
 * `vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL —— 这是既定选择
 * （引入会牵连整个测试套件的启动耗时，`docs/35 §9.4` 明令不引入）。
 * 所以这里沿 `tests/aliasWiring.test.ts` / `tests/triageWiring.test.ts` 的 `readSrc()` 范式：
 * 读文件文本 + 断言关键接线点。**行为**由 `tests/reviewFlow.test.ts` /
 * `tests/storeTriageMode.test.ts` 那些能真跑的纯函数用例兜住（本文件只守"组件有没有接上"）。
 *
 * ## 每条守卫都防一个具体的退化形态（写在各自的注释里）
 *
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | 1 | 浮层用 `useActiveTriageQueue()` | 有人"顺手改回" `useTriageQueue()` → conflict 模式渲出未分类那批 |
 * | 2 | `unclassified` 文案未改 | 改文案时"顺便统一语气" → 既有用户肌肉记忆 + 断言失效 |
 * | 3 | conflict 三行 + 两个候选按钮 | 只做标题分叉、右栏没给依据 → 用户不知道在裁什么 |
 * | 4 | `sources.s2` 缺失有兜底 | 裸访问 `s2.level1` → 旧数据把整个浮层炸掉 |
 * | 5 | 侧栏入口计数 > 0 才渲染 | 写成常显 → 库里没存疑时留一个"点了没反应"的行 |
 * | 6 | 批次汇总不在逐包路径 | 挂到 `onImportEvent` → 拖 50 个包弹 50 条 |
 * | 7 | 卡片徽标判据是 `reviewReasonOf` | 用 `classifyReview?.reason` → 已定案的卡片永不摘徽标 |
 * | 8 | 徽标不在回收站渲染 | 已删资产的 hover 角上多一个点了必然失败的按钮 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 相对仓库根的源码读取（`new URL(..., import.meta.url)` 与既有测试同款）。
 *
 * 换行统一成 `\n`：本仓检出的工作区是 CRLF（git autocrlf），而下面的切片断言用
 * `indexOf('\n}\n')` 找函数体结束 —— 不归一化会在 CRLF 上返回 -1，切出一整片
 * 无关代码导致反向断言诡异地红。换行符不是契约的一部分。
 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/**
 * 剥注释后再断言。
 *
 * 本仓这几处**注释里就写着要防的那段代码**（例如 AssetGrid 的注释明写
 * "判据用 `reviewReasonOf` 而不是 `classifyReview.reason === 'conflict'`"）——
 * 不剥注释的话反向断言会把自己说明文字判成违规。
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 注释（必须先于块注释：`{/* */}` 内含 `/* */`）
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, '') // 行注释
}

const OVERLAY = readSrc('src/renderer/components/TriageOverlay.tsx')
const OVERLAY_CODE = stripComments(OVERLAY)
const SIDEBAR = readSrc('src/renderer/components/Sidebar.tsx')
const SIDEBAR_CODE = stripComments(SIDEBAR)
const GRID = readSrc('src/renderer/components/AssetGrid.tsx')
const GRID_CODE = stripComments(GRID)
const STORE = readSrc('src/renderer/store.ts')
const STORE_CODE = stripComments(STORE)

// ── ① 浮层：队列来源 ────────────────────────────────────────────────

describe('① TriageOverlay · 队列来源按 triageMode 自动选', () => {
  it('★用 useActiveTriageQueue()（不是固定的 useTriageQueue）', () => {
    expect(OVERLAY_CODE).toContain('useActiveTriageQueue()')
    expect(OVERLAY_CODE).toContain("from '../store'")
  })

  it('★防回退：不再有 `const queue = useTriageQueue()`', () => {
    // 这条是 T-11 的核心（一行改动），退化后 conflict 模式会渲出未分类那批资产，
    // 而队列条数与侧栏「待确认」徽标对不上 —— 用户会以为丢了数据。
    expect(OVERLAY_CODE).not.toContain('const queue = useTriageQueue()')
    // 也不许"两个都调用再二选一"：hooks 数量必须稳定，且 startTriage 的惰性初始化
    // 会拿到错的那一批（理由见 store 的 useActiveTriageQueue 注释）
    expect(OVERLAY_CODE).not.toContain('useReviewQueue()')
  })

  it('★Esc 仍走 useEscLayer（conflict 模式不破这条纪律）', () => {
    expect(OVERLAY_CODE).toContain('useEscLayer(requestClose, true)')
    // 唯一的 window keydown 监听仍是**非 Esc** 那条；手写 Esc 捕获会在这里露出来
    expect(OVERLAY_CODE.split("window.addEventListener('keydown'").length - 1).toBe(1)
  })

  it('★decideTriageKey 零改动（键位两种模式完全一致）', () => {
    expect(OVERLAY_CODE).toContain('decideTriageKey({')
    // 组件里不许自己认 Esc（那会和 useEscLayer 一层按键关两层）
    expect(OVERLAY_CODE).not.toContain("e.key === 'Escape'")
  })
})

// ── ② unclassified 文案一个字都不能变 ────────────────────────────────

describe('② unclassified 模式文案 · 逐字不变', () => {
  it('★标题仍是「指派分类」', () => {
    expect(OVERLAY_CODE).toContain("'指派分类'")
  })

  it('★aria-label 仍是「整理未分类：…」', () => {
    expect(OVERLAY_CODE).toContain("'整理未分类'")
    expect(OVERLAY_CODE).toContain('aria-label={')
  })

  it('★收尾提示仍来自 triageCloseNotice（conflict 才分叉）', () => {
    // 分叉门必须在判据里：`mode !== 'conflict'` → 直通 `triageCloseNotice`
    expect(OVERLAY_CODE).toContain('function closeNoticeOf(')
    expect(OVERLAY_CODE).toContain("if (mode !== 'conflict') return triageCloseNotice(remaining)")
    // 两条关闭路径都用它（Esc / ✕ / 点遮罩 走 requestClose；空集 effect 走另一处）
    expect(OVERLAY_CODE).toContain('setNotice(closeNoticeOf(triageMode, queue.length))')
    expect(OVERLAY_CODE).toContain('setNotice(closeNoticeOf(triageMode, 0))')
  })

  it('★未分类的两句原文仍在 triageFlow.ts（没被顺手改）', () => {
    const FLOW = fs.readFileSync(
      new URL('../src/renderer/logic/triageFlow.ts', import.meta.url),
      'utf-8'
    )
    expect(FLOW).toContain("return '未分类已清空'")
    expect(FLOW).toContain('return `还剩 ${n} 张未分类`')
  })
})

// ── ③ conflict 模式：三行来源对比 + 两个候选 ────────────────────────

describe('③ conflict 模式 · 来源对比三行 + 两个候选按钮', () => {
  it('★三行都有：语义 / 站方判成 / 站方另说', () => {
    expect(OVERLAY_CODE).toContain('语义判成')
    expect(OVERLAY_CODE).toContain('站方判成')
    expect(OVERLAY_CODE).toContain('站方另说')
  })

  it('★「语义判成」取当前分类（S1 不落库，不能从 sources 拿）', () => {
    // 这是最容易"顺手补个 s1 字段"的地方（R-13 明确不落库，`ClassifyReview.sources`
    // 里根本没有 s1）。语义结论 = 资产当前分类，取法必须走 categoriesOf。
    const at = OVERLAY_CODE.indexOf('function ConflictSources(')
    expect(at).toBeGreaterThan(-1)
    const body = OVERLAY_CODE.slice(at, OVERLAY_CODE.indexOf('export function TriageOverlay()'))
    expect(body).toContain('categoriesOf(asset)')
    expect(body).not.toContain('sources.s1')
  })

  it('★站方两行分别取 sources.s2 / sources.s3', () => {
    const at = OVERLAY_CODE.indexOf('function ConflictSources(')
    const body = OVERLAY_CODE.slice(at, OVERLAY_CODE.indexOf('export function TriageOverlay()'))
    expect(body).toContain('classifyReview?.sources?.s2')
    expect(body).toContain('classifyReview?.sources?.s3')
    expect(body).toContain('s2.level1')
    expect(body).toContain('s2.level2')
  })

  it('★两个候选按钮存在，且复用同一条确认路径（不复制归类逻辑）', () => {
    expect(OVERLAY_CODE).toContain('用语义的')
    expect(OVERLAY_CODE).toContain('用站方的')
    // 候选按钮把 (c1, c2) 传给 confirm，而不是自己写一份归类 + moved/failed/skipped
    // 三分支（复制必然漏掉其中一条）
    expect(OVERLAY_CODE).toContain('onPick={(c1, c2) => void confirm({ c1, c2 })}')
    // 全文件只有一处定案调用（就在 confirm 里）
    expect(OVERLAY_CODE.split('await decideReview(').length - 1).toBe(1)
  })

  it('★两条确认路径都走 decideReview，且本浮层不直接调 assignCategory', () => {
    // 走 `assignCategory` 会留下 `classifyReview.reason` → 用户确认完仍在待确认队列里
    // （下一轮 reconcileTriage 又排回来），表现为"按了没反应"。
    expect(OVERLAY_CODE).toContain('const decideReview = useVault((s) => s.decideReview)')
    expect(OVERLAY_CODE).toContain('await decideReview(current.id, c1, t2)')
    // 反向守卫：源码里不许出现任何 assignCategory 调用（注释已在 stripComments 里剥掉）
    expect(OVERLAY_CODE).not.toContain('await assignCategory(')
    expect(OVERLAY_CODE).not.toContain('s.assignCategory')
  })

  it('★只有 conflict 模式渲染这一块', () => {
    expect(OVERLAY_CODE).toContain('{isConflict && (')
    expect(OVERLAY_CODE).toContain('<ConflictSources')
    expect(OVERLAY_CODE).toContain("const isConflict = triageMode === 'conflict'")
  })
})

// ── ④ s2 缺失的兜底 ────────────────────────────────────────────────

describe('④ sources.s2 缺失 · 不崩、不显示空行', () => {
  it('★有 if (!s2) 早退分支，给出可执行的提示', () => {
    const at = OVERLAY_CODE.indexOf('function ConflictSources(')
    const body = OVERLAY_CODE.slice(at, OVERLAY_CODE.indexOf('export function TriageOverlay()'))
    expect(body).toContain('if (!s2)')
    expect(body).toContain('这一条的分类有争议，请手动选择')
    // 早退必须在取值之前：`return` 之后不再渲染 s2 那两行
    const guardAt = body.indexOf('if (!s2)')
    const firstUseAt = body.indexOf('s2.level1')
    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(firstUseAt)
  })

  it('★不裸访问：s2 的每一次取值都在守卫之后（`s2?.` 或已收窄）', () => {
    const at = OVERLAY_CODE.indexOf('function ConflictSources(')
    const body = OVERLAY_CODE.slice(at, OVERLAY_CODE.indexOf('export function TriageOverlay()'))
    // 源码里不许出现 `classifyReview.sources.s2.` 这种连续三段式的裸访问
    expect(body).not.toMatch(/classifyReview\.sources\.s2\./)
    expect(body).not.toContain('sources!.s2')
  })
})

// ── ⑤ 侧栏「待确认」入口 ────────────────────────────────────────────

describe('⑤ Sidebar · 「待确认」入口', () => {
  it('★调用 openReview()（不是 openTriage，也不是 setFilter）', () => {
    expect(SIDEBAR_CODE).toContain('const openReview = useVault((s) => s.openReview)')
    expect(SIDEBAR_CODE).toContain('openReview()')
    // 入口语义是"打开待确认浮层"，不套筛选、不切视图（与 openTriage 的两条纪律一致）
    const at = SIDEBAR_CODE.indexOf('openReview()')
    expect(at).toBeGreaterThan(-1)
    const seg = SIDEBAR_CODE.slice(Math.max(0, at - 400), at + 100)
    expect(seg).not.toContain('setFilter(')
    expect(seg).not.toContain('setLibraryView(')
  })

  it('★计数 > 0 才渲染整行（0 时不存在，不是 disabled）', () => {
    expect(SIDEBAR_CODE).toContain('{conflictCount > 0 && (')
    // 反向：这一行没有 disabled / opacity-40（那是「重复资产」的常驻形态）
    const at = SIDEBAR_CODE.indexOf('{conflictCount > 0 && (')
    expect(at).toBeGreaterThan(-1)
    const seg = SIDEBAR_CODE.slice(at, at + 900)
    expect(seg).toContain('待确认')
    expect(seg).not.toContain('disabled=')
    expect(seg).not.toContain('opacity-40')
  })

  it('★计数走 countPendingReview(...).conflict（全库口径 + 只数 conflict）', () => {
    expect(SIDEBAR_CODE).toContain("import { countPendingReview } from '../logic/reviewFlow'")
    expect(SIDEBAR_CODE).toContain('countPendingReview(activeAssets).conflict')
    // 分母必须是 activeAssets（已滤软删）—— `countPendingReview` 自己不滤软删，
    // 传 `assets` 进来会把回收站里的存疑资产也算进徽标
    expect(SIDEBAR_CODE).not.toContain('countPendingReview(assets)')
  })

  it('★不冒泡（侧栏行级点击有历史包袱：navTo / 折叠树）', () => {
    const at = SIDEBAR_CODE.indexOf('{conflictCount > 0 && (')
    const seg = SIDEBAR_CODE.slice(at, at + 900)
    expect(seg).toContain('e.stopPropagation()')
  })

  it('★与「未分类」数字不互相污染：两个数各有独立来源', () => {
    // 「未分类」那一行读 n.count（来自 countLevel1），「待确认」读 countPendingReview。
    // 两者判据在 reviewFlow.ts 里互斥（reviewReasonOf 每个资产只返回一个 reason）——
    // 真正的互斥性由 tests/reviewFlow.test.ts 的 3+2 用例钉住，这里只守"没有合并成一个数"。
    expect(SIDEBAR_CODE).toContain('n.value === UNCLASSIFIED && n.count > 0 && (')
    expect(SIDEBAR_CODE).toContain('{conflictCount > 0 && (')
    // 反向：不许写成 `n.count + conflictCount` 这种合并
    expect(SIDEBAR_CODE).not.toContain('n.count + conflictCount')
  })
})

// ── ⑥ 批次汇总：一次，不逐包 ────────────────────────────────────────

describe('⑥ 批次汇总 · 只发一次，绝不逐包', () => {
  it('★reportReviewSummary 有定义，且只在 scheduleZhimoPipeline 里被调用', () => {
    expect(STORE_CODE).toContain('function reportReviewSummary(): void')
    // 调用点恰好一处
    expect(STORE_CODE.split('reportReviewSummary()').length - 1).toBe(2) // 1 处定义 + 1 处调用
  })

  it('★调用点在流水线收尾（在 runZhimoCovers 之后），不在逐包回调里', () => {
    const pipeAt = STORE_CODE.indexOf('function scheduleZhimoPipeline(): void {')
    expect(pipeAt).toBeGreaterThan(-1)
    const pipeBody = STORE_CODE.slice(pipeAt, STORE_CODE.indexOf('\n}\n', pipeAt))
    expect(pipeBody).toContain('reportReviewSummary()')

    // 它在 await runZhimoCovers() **之后** —— conflict 只有抓完详情页才知道
    const callAt = STORE_CODE.indexOf('reportReviewSummary()', pipeAt)
    const coversAt = STORE_CODE.indexOf('runZhimoCovers()', pipeAt)
    expect(coversAt).toBeGreaterThan(-1)
    expect(callAt).toBeGreaterThan(coversAt)

    // 收尾那段（调用点往后 200 字符）里不许出现循环 —— 出现 `for (` / `.map(`
    // 说明有人把它塞进了逐条循环（"拖 50 个包弹 50 条"的形态）
    const tail = STORE_CODE.slice(callAt, callAt + 200)
    expect(tail).not.toContain('for (')
    expect(tail).not.toContain('.map(')
    expect(tail).not.toContain('.forEach(')
  })

  it('★onImportEvent 的逐条回调体里不含汇总调用（S-03 的正面断言）', () => {
    const at = STORE_CODE.indexOf('window.modvault.onImportEvent(')
    expect(at).toBeGreaterThan(-1)
    // 回调体到注册结束（下一个 `    })` + 换行）
    const endAt = STORE_CODE.indexOf('\n    })', at)
    expect(endAt).toBeGreaterThan(at)
    const body = STORE_CODE.slice(at, endAt)
    expect(body).not.toContain('reportReviewSummary')
    expect(body).not.toContain('enqueueNotice(`本批')
    expect(body).not.toContain('待确认')
    // 只允许累加计数
    expect(body).toContain('importedInBatchCount += 1')
  })

  it('★文案三段与设计逐字一致（M>0 / M===0&&K>0 / 都不发）', () => {
    expect(STORE_CODE).toContain(
      '本批 ${imported} 个素材，其中 ${conflicts} 个分类存疑 → 点侧栏「待确认」处理'
    )
    expect(STORE_CODE).toContain('本批 ${imported} 个素材已分类，其中 ${unverified} 个仅据知末分类')
    // 两个分支都必须早退（M=0 且 K=0 时不发）
    const at = STORE_CODE.indexOf('function reportReviewSummary(): void {')
    const body = STORE_CODE.slice(at, STORE_CODE.indexOf('\n}\n', at))
    expect(body).toContain('if (conflicts > 0)')
    expect(body).toContain('if (unverified > 0)')
    expect(body).toContain('return')
  })

  it('★走 enqueueNotice，不新造 modal', () => {
    const at = STORE_CODE.indexOf('function reportReviewSummary(): void {')
    const body = STORE_CODE.slice(at, STORE_CODE.indexOf('\n}\n', at))
    expect(body).toContain('enqueueNotice(')
    // 汇总函数里不许直接写 notice 字段（那会与队列里的其它汇总互相吞并）
    expect(body).not.toContain('set({ notice')
  })
})

// ── ⑦ 卡片「存疑」徽标 ──────────────────────────────────────────────

describe('⑦ AssetGrid · 卡片存疑徽标', () => {
  it('★判据是 reviewReasonOf(...) === "conflict"', () => {
    expect(GRID_CODE).toContain("import { reviewReasonOf } from '../logic/reviewFlow'")
    expect(GRID_CODE).toContain("reviewReasonOf(a) === 'conflict'")
  })

  it('★防用错判据（绕过节案过滤）', () => {
    // 用 `classifyReview?.reason === 'conflict'` 的快照会漏掉「已定案」这条 ——
    // reviewReasonOf 的第 1 条把 decidedAt 有值判成 null，用户处理完徽标才摘得掉
    expect(GRID_CODE).not.toContain("classifyReview?.reason === 'conflict'")
    expect(GRID_CODE).not.toContain("classifyReview.reason === 'conflict'")
  })

  it('★点击 stopPropagation + openReview()', () => {
    const at = GRID_CODE.indexOf("reviewReasonOf(a) === 'conflict' && (")
    expect(at).toBeGreaterThan(-1)
    const seg = GRID_CODE.slice(at, at + 500)
    expect(seg).toContain('e.stopPropagation()')
    expect(seg).toContain('openReview()')
    expect(seg).toContain('存疑')
  })

  it('★复用既有 .badge 样式（不新造颜色 token）', () => {
    const at = GRID_CODE.indexOf("reviewReasonOf(a) === 'conflict' && (")
    const seg = GRID_CODE.slice(at, at + 500)
    expect(seg).toContain('"badge')
    // 不许出现硬编码色值 / 自造 bg-xxx（项目纪律：颜色一律取 token）
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(seg).not.toMatch(/bg-(amber|yellow|orange|red)-/)
  })

  it('★回收站里不渲染（与 GripHandle 同一条纪律）', () => {
    // 整条渲染条件是 `{!trashMode && !selected && reviewReasonOf(a) === 'conflict' && (`
    // —— `!trashMode` 必须在**同一个条件表达式**里（不是靠外层容器包住）
    expect(GRID_CODE).toContain("{!trashMode && !selected && reviewReasonOf(a) === 'conflict' && (")
    const condAt = GRID_CODE.indexOf("{!trashMode && !selected && reviewReasonOf(a) === 'conflict' && (")
    expect(condAt).toBeGreaterThan(-1)
    const seg = GRID_CODE.slice(condAt, condAt + 500)
    expect(seg).toContain('存疑')
    expect(seg).toContain('openReview()')
  })
})
