/// <reference lib="dom" />
/**
 * 设置页「按站方分类重排」**结果汇总行**的口径守卫（T-14 · docs/35）。
 *
 * ## 为什么是源码守卫
 *
 * `vitest.config.ts` 是 `environment: 'node'`，全仓没有 jsdom / RTL（`docs/35 §9.4`
 * 明令不引入）。所以沿 `tests/classifyUiWiring.test.ts` / `tests/triageWiring.test.ts`
 * 的 `readSrc()` + `stripComments()` 范式：读组件源码、断言关键接线点。
 * 真正的**数据**口径（哪些条数进哪个桶）由 `tests/zhimoReclass.test.ts` 那批能真跑的
 * 纯函数用例兜住，本文件只守"界面有没有按新口径说人话"。
 *
 * ## 每条守卫防一个具体的退化形态
 *
 * | # | 守卫 | 防的退化 |
 * |---|---|---|
 * | 1 | `ambiguous` 零出现 | 有人"顺手保留"旧桶 → 用户看到一个永远 0 的「多候选」 |
 * | 2 | `unverified` 出现在界面上 | 单源搬运悄悄混进 `moved` → 用户以为条条都过了两源互证 |
 * | 3 | `conflicts` 出现且可点 | 只给数字不给入口 → 用户得自己去侧栏翻「待确认」 |
 * | 4 | 三段文案的原文 | 改文案时"顺便统一语气" → 口径解释丢失，数字再次无法解读 |
 * | 5 | 两个子集为 0 时省句 | 退化成「移动 12 个（其中单源 0 个、近似归并 0 个）」的空话 |
 * | 6 | 进度 / 取消 / 撤销逻辑未动 | 改汇总行时误伤同卡的运行中状态与备份撤销入口 |
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 相对仓库根的源码读取。
 *
 * 换行统一成 `\n`：本仓检出的工作区是 CRLF（git autocrlf），切片断言用
 * `indexOf` 找边界，不归一化在 CRLF 上会切偏。换行符不是契约的一部分。
 */
function readSrc(rel: string): string {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
}

/**
 * 剥注释后再断言。
 *
 * 本文件守的这段代码，注释里**就写着**要防的那几个字段名（例如
 * "`ambiguous` 从界面拿掉：新通道恒 0"）—— 不剥注释，反向断言会把自己的说明
 * 文字判成违规。
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 注释（必须先于块注释：`{/* */}` 内含 `/* */`）
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, '') // 行注释
}

const DIALOG = readSrc('src/renderer/components/SettingsDialog.tsx')
const CODE = stripComments(DIALOG)

/**
 * 切出汇总块那一段（`const zhimoResultBlock =` 到 `const clearThumbs`）。
 *
 * 为什么要切：`unverified` 这类字段名在 store 里也有、组件别处也可能读，
 * 只按整份文件断言等于没断言"**汇总行**改对了"。边界用两个必然相邻的锚点
 * （汇总块紧接着的下一段就是 `clearThumbs`），任一锚点找不到就返回整份源码并
 * 由下面第一条 `length` 守卫报红 —— 静默退化成"全过"是最坏的失败模式。
 */
function resultBlock(): string {
  const start = CODE.indexOf('const zhimoResultBlock')
  const end = CODE.indexOf('const clearThumbs', start)
  return start >= 0 && end > start ? CODE.slice(start, end) : ''
}

const BLOCK = resultBlock()

// ── 切段自检（先证伪：切歪了后面全是假绿） ──────────────────────────

describe('⓪ 切片自检 · 汇总块被正确切出', () => {
  it('切出的片段非空，且确实是汇总块（含 moved 与三段文案的锚点）', () => {
    expect(BLOCK.length).toBeGreaterThan(500)
    expect(BLOCK).toContain('zhimoReclassResult.moved')
    expect(BLOCK).toContain('交叉验证')
  })
})

// ── ① ambiguous 从界面消失 ─────────────────────────────────────────

describe('① `ambiguous` 从界面拿掉（新通道恒 0）', () => {
  it('★整份组件源码里 `zhimoReclassResult.ambiguous` 零出现', () => {
    // 为什么必须零出现：新通道的 `s2FromBreadcrumbGeneric` 遇候选不唯一会**整条放弃**
    // （有末级名就落进 `unmapped`），所以这个桶恒 0。留在界面上等于告诉用户
    // "多候选这条路还在跑"，而实际上它已经不存在了。
    expect(CODE).not.toContain('zhimoReclassResult.ambiguous')
  })

  it('★汇总块里也没有「多候选」这个词', () => {
    // 只删字段引用、留着「多候选 0」的话，用户看到的还是一个恒 0 的说法
    expect(BLOCK).not.toContain('多候选')
  })

  it('★也不要"留着但注释掉"：整份源码里没有 ambiguous 的用法', () => {
    expect(CODE).not.toMatch(/zhimoReclassResult\s*\.\s*ambiguous/)
  })
})

// ── ② unverified 出现在界面上 ──────────────────────────────────────

describe('② `unverified`（单源搬运）必须在界面上', () => {
  it('★汇总块含 `zhimoReclassResult.unverified`', () => {
    // `moved` 现在包含 `medium-s2` 单源搬运（docs/35 §5.3）。不把 `unverified` 单列，
    // 用户会以为搬的每一条都过了两源互证 —— 这是"有多少条是只有知末一个来源支持的"
    // 的唯一锚点。
    expect(BLOCK).toContain('zhimoReclassResult.unverified')
  })

  it('★界面上写成「单源 X 个」', () => {
    expect(BLOCK).toContain('单源')
  })

  it('★文案没有把两个子集写成相加（`unverified + approx` / `+ approx`）', () => {
    // 两个都是 `moved` 的子集，且**可以重叠**（一条既单源又近似归并）。
    // 任何求和写法都会把同一条算两遍，用户算出来的总数对不上 `moved`。
    expect(BLOCK).not.toMatch(/unverified\s*\+\s*zhimoReclassResult\.approx/)
    expect(BLOCK).not.toMatch(/approx\s*\+\s*zhimoReclassResult\.unverified/)
  })
})

// ── ③ conflicts 出现且可点 ─────────────────────────────────────────

describe('③ 「待确认」用 `conflicts` 且可点进队列', () => {
  it('★汇总块含 `zhimoReclassResult.conflicts`', () => {
    expect(BLOCK).toContain('zhimoReclassResult.conflicts')
  })

  it('★入口调 `openReview()`（不是 `openTriage`，也不是改筛选）', () => {
    // docs/35 §4.3 三个入口共用 `openReview()`：它内部是 `openTriage('conflict')`，
    // 且**空队列时不退化成未分类模式**（docs/35 的核心约束）。
    // 写成 `openTriage()` 会默认进未分类队列 —— 用户点「待确认」却看到一批没分过类的。
    expect(BLOCK).toContain('openReview()')
    expect(BLOCK).not.toContain('openTriage(')
  })

  it('★从 store 取 `openReview`（订阅写法与既有入口一致）', () => {
    expect(CODE).toContain('const openReview = useVault((s) => s.openReview)')
  })

  it('★`> 0` 才做成可点（0 条时给一个点了没反应的链接更差）', () => {
    expect(BLOCK).toMatch(/zhimoReclassResult\.conflicts > 0/)
    expect(BLOCK).toContain('<button')
  })

  it('★先 `openReview()` 成功再关弹窗（队列空时不误关设置页）', () => {
    // `openReview()` 返回 boolean（是否真的打开了）。队列已被裁完时它返回 false 并只给
    // 一条 notice，此时若无条件 `onClose()`，用户点了、界面退了、什么都看不到。
    expect(BLOCK).toContain('if (openReview()) onClose()')
  })

  it('★「待确认」这三个字在界面上（与侧栏节点同名，不另起叫法）', () => {
    expect(BLOCK).toContain('待确认')
  })
})

// ── ④ 三段文案原文 ─────────────────────────────────────────────────

describe('④ 三段文案：第一行 / 第二行 / 说明', () => {
  it('★第一行是「移动 N 个」+ 子集括号', () => {
    expect(BLOCK).toContain('移动')
    expect(BLOCK).toContain('zhimoReclassResult.moved')
  })

  it('★第二行的其余桶：未映射 / 站方未给 / 失败 + 红色强调', () => {
    expect(BLOCK).toContain('未映射')
    expect(BLOCK).toContain('zhimoReclassResult.unmapped')
    expect(BLOCK).toContain('站方未给')
    expect(BLOCK).toContain('zhimoReclassResult.noStation')
    expect(BLOCK).toContain('zhimoReclassResult.failed > 0')
    expect(BLOCK).toContain('text-danger')
  })

  it('★第三行解释新口径（交叉验证 / 两源一致 / 不再自动搬）', () => {
    expect(BLOCK).toContain('交叉验证')
    expect(BLOCK).toContain('两源一致或仅知末有分类时才移动')
    expect(BLOCK).toContain('不再自动搬')
  })

  it('★「单源」与「近似归并」各自有解释（两个词都还在用）', () => {
    expect(BLOCK).toContain('「单源」= 只有知末给了分类')
    expect(BLOCK).toContain('「近似归并」= 站方类目在本地没有一一对应')
  })

  it('★字号层级沿用既有（说明行是 `text-[10px] text-muted`，不新造）', () => {
    expect(BLOCK).toContain('text-[10px] text-muted')
    // 第一行是正文（`mt-1`，继承块容器的 11px）；块头那层是 11px + secondary
    expect(BLOCK).toContain('text-[11px] leading-relaxed text-secondary')
  })
})

// ── ⑤ 两个子集都为 0 时省句 ────────────────────────────────────────

describe('⑤ 子集为 0 时省句（默认情况就是 0，别写空话）', () => {
  it('★`unverified` / `approx` 都按 `> 0` 条件渲染', () => {
    expect(BLOCK).toMatch(/zhimoReclassResult\.unverified > 0/)
    expect(BLOCK).toMatch(/zhimoReclassResult\.approx > 0/)
  })

  it('★「其中」两个字也在条件里（两个都为 0 时不能只剩一个空括号）', () => {
    // 若「其中」写死在括号里、只有内部两段条件化，会渲染出「移动 12 个（其中）。」
    expect(BLOCK).toMatch(
      /zhimoReclassResult\.unverified > 0 \|\| zhimoReclassResult\.approx > 0/
    )
  })

  it('★分隔符只在两段都在时出现（并列子集，不是两条互斥桶）', () => {
    expect(BLOCK).toMatch(
      /zhimoReclassResult\.unverified > 0 && zhimoReclassResult\.approx > 0/
    )
  })
})

// ── ⑥ 既有逻辑未动（进度 / 取消 / 撤销 / 备份） ─────────────────────

describe('⑥ 同卡的运行中状态与撤销入口一字未动', () => {
  it('★进度块：已完成 x / 共 y + 取消按钮', () => {
    expect(CODE).toContain('已完成')
    expect(CODE).toContain('zhimoReclass.done')
    expect(CODE).toContain('cancelZhimoCategoryReclass()')
  })

  it('★取消语义文案仍在（取消 ≠ 回滚）', () => {
    expect(CODE).toContain('取消只是不再抓新记录')
    expect(CODE).toContain('已抓到的结果会照常落库')
  })

  it('★取消态百分比：`zhimoReclassResult.scanned` 仍在用', () => {
    // 取消分支要显示"本轮抓取 x / 共 y 条候选"，这条不能跟着汇总行一起被删掉
    expect(CODE).toContain('zhimoReclassResult.scanned')
    expect(CODE).toContain('runZhimoCategoryReclass')
  })

  it('★撤销入口仍走知末通道前缀（用常量，不手抄字符串）', () => {
    expect(CODE).toContain('undoLastReclassify(ZHIMO_RECLASS_BACKUP_PREFIX)')
    expect(CODE).toContain('refreshZhimoReclassBackupCount')
  })

  it('★候选数仍用纯逻辑同一个判定函数在渲染层算', () => {
    expect(CODE).toContain('isZhimoReclassCandidate')
  })

  it('★确认弹窗与「会真实移动目录」的警示仍在', () => {
    expect(CODE).toContain('会真实移动磁盘上的目录')
  })
})
