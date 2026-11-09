import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconClose, IconSearch } from '../../icons'
import './home-search-command.css'

/**
 * 首页搜索入口 —— 「同一个盒子连续缩放变形」的命令面板。
 *
 * 动效出处：skiper-92（Vercel Command Search）。关键不是「下拉」，而是：
 * 一个 240×32 的盒子被弹簧驱动**连续**长到 560×(49+列表高)，长高的同时
 * 面板整体在 scale，内部每个子元素（放大镜 / 输入容器 / Esc 徽标 / 键帽 / 列表）
 * 各自按父级缩放比例**反向补偿**，所以文字始终是 1:1，只有盒子在变。
 *
 * 为什么不用 React state 驱动动画：
 * 每帧要写 7 个元素的 transform，走 state 等于把 React 调和塞进 60fps 关键路径。
 * 这里 state 只承载「开没开」和「结果列表」（都是低频），所有几何值走 ref +
 * 一个 requestAnimationFrame 循环直接写 style，全部通道静止后循环自己停掉。
 *
 * 弹簧（过阻尼、无回弹）：
 *   movePhysical(key, target, 450, 25, 0.1)
 *   → k = 450/0.1 = 4500、damping = 25/0.1 = 250、mass = 1
 *   → ζ = 250 / (2·√4500) ≈ 1.86（> 1，过阻尼）
 * 求解用**解析解**（阻尼谐振子），对任意 dt 都精确，掉帧不会改手感。
 *
 * 主题：颜色全走 token（--surface-card / --border / --text-* / --accent-*），
 * 深浅色自动跟随；本文件不含主题色硬编码，也不含装饰性渐变。
 *
 * 展开方向（v0.10.x 用户点名的改动，两种锚点）：
 *   - `variant='center'`（首页默认）：**从画面中心往两边长**。面板盒子不是左上角
 *     锚定的，而是「中心从收起条中心插值到视口中心、盒子围着中心对称长大」
 *     （见 `commandProjection`）；收起条自己 transform 置 none，原地淡出。
 *   - `variant='toolbar'`（库内顶栏）：**自左上向右下长**。上边缘钉在收起条上沿
 *     不动，盒子只向右下扩张（参考件 skiper-92 的原始形态）。
 *
 * 列表内容（v0.10.x 第二轮用户反馈）：
 *   - 结果行带 36×36 缩略图（纯文字行找不到素材，用户原话「不会特别直观，也不会快」）；
 *   - 空查询不再显示「分类」，改显示「最近搜索」（本地 localStorage，最多 6 条）。
 */

/* ── 几何常量（改动必须同步改 home-search-command.css 里对应的自然布局盒） ── */

/**
 * 收起态盒子尺寸，也是面板最终被缩放到的小盒。
 *
 * 参考实现用的是 192×32，那是**网页里一个紧凑命令触发器**的尺寸。
 * 搬到 1440 桌面首页的底部主入口上，192 撑不起身份：5 个文件夹各 228 宽、
 * 合计 1140，中间插一个 192 的条像张贴纸，而且放不下占位串（被截成
 * 「搜索素材、分…」）。取 240：比单个文件夹窄一档、能显示完整的
 * 「搜索素材、分类或文件名」里的前 8 字，又不抢文件夹的视觉权重。
 * 改这里必须同步改 `home-search-command.css` 里 `.hsc-root` 的 width。
 */
const COLLAPSED_W = 240
const COLLAPSED_H = 32
/** 头部高度（含 1px 分隔线）。列表的 y 起点就是它 */
const HEAD_H = 49
/** 展开态宽度：1440 宽窗口下 560 才拉得出「拉伸感」（参考实现是 384） */
const PANEL_W = 560
/** 列表高度上下限 */
const LIST_MIN_H = 120
/**
 * 列表高度上限。
 *
 * 行变高之后复核过一遍预算（见 css 的 `.hsc-list` 注释）：
 *   分组内边距 4 + 分组标题 28 + 4 行缩略图行 4×56 = 224 + 内边距 4 = 260
 * 260 < 300，且底部 28px 的功能性遮罩从 272 才开始，所以第 4 行**完整露出**。
 * 结论：不需要抬到 320，保持 300（与 css 的 max-height 必须一致）。
 */
const LIST_MAX_H = 300

/* ── 最近搜索（localStorage）───────────────────────────────────────────── */

/** 存储键，固定值（仓库外没有任何地方引用它，改名等于丢用户数据） */
const RECENT_KEY = 'idbox.search.recent'
/** 最多记 6 条，新的在前 */
const RECENT_MAX = 6
/**
 * 单条搜索词的长度上限（字符）。
 *
 * 只用于**读**侧的脏数据过滤：localStorage 是用户可以手改的，一条 10 万字符的
 * 串塞进来会把列表行撑成一大段（虽然有 ellipsis，但单行高度会稳不住）。
 * 超过这个长度的条目直接丢弃，当作没记过 —— 不抛错、不截断（截断会产生一条
 * 用户从没搜过的词，比丢掉更糟）。
 */
const RECENT_TERM_MAX = 200
/** 「最近搜索」分组标题（渲染与 aria 都用这一处） */
const RECENT_TITLE = '最近搜索'
/** 空历史的提示串 */
const RECENT_EMPTY_LABEL = '暂无最近搜索'

/**
 * 读最近搜索。
 *
 * 容错口径（localStorage 是脏数据的第一来源，任何一步都不能抛）：
 *   ① getItem / JSON.parse 整体 try/catch → 异常返回 []；
 *   ② 解析结果不是数组 → []；
 *   ③ 数组里逐项校验：非字符串、trim 后为空、超长（> RECENT_TERM_MAX）→ 丢弃该项；
 *   ④ 去重（保留先出现的位置）；
 *   ⑤ 只取前 RECENT_MAX 条（手改过的数组可能有一千条）。
 *
 * @returns 干净的、最多 6 条的搜索词数组（新的在前）；任何异常都返回 []
 */
function readRecentSearches(): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (raw === null || raw === '') return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue
      const value = entry.trim()
      if (value === '') continue
      if (value.length > RECENT_TERM_MAX) continue
      if (out.indexOf(value) !== -1) continue
      out.push(value)
      if (out.length >= RECENT_MAX) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * 记一条搜索词：unshift → 去重 → 截断 RECENT_MAX → 写回。
 *
 * 写入失败（隐私模式禁 localStorage / 配额满 / 磁盘只读）**静默吞掉**：
 * 用户的搜索行为不该因为存不了历史而报错，内存里的列表照样更新。
 *
 * @param term 用户这次真正提交的搜索词（调用方保证非空）
 * @returns 写入后的内存列表（写盘失败也返回它，UI 立刻能反映）
 */
function rememberSearch(term: string): string[] {
  const current = readRecentSearches()
  const value = term.trim()
  if (value === '' || value.length > RECENT_TERM_MAX) return current
  const next = [value, ...current.filter((entry) => entry !== value)].slice(0, RECENT_MAX)
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    }
  } catch {
    /* 静默：隐私模式 / 配额满都走这里，不冒泡给 React */
  }
  return next
}

/** 两个字符串数组逐项相等（避免无意义 setState 造成重渲染） */
function sameRecentList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/* ── 对外类型 ───────────────────────────────────────────────────────────── */

/** 展开锚点：'center'（首页，向四周长）/ 'toolbar'（库内顶栏，自左上向右下长） */
export type HomeSearchVariant = 'center' | 'toolbar'

export interface HomeSearchItem {
  id: string
  label: string
  /** 右侧弱化文字，如 "24 个素材" */
  meta?: string
  /** 右侧键帽，如 "⌘1" */
  shortcut?: string
  /**
   * 行首 36×36 缩略图 URL，由父级提供。
   *
   * 缺省 / null / 空串 → **不渲染**缩略图槽，退化成 44px 纯文字行
   * （分类组、最近搜索都用这个形态）。加载失败也只留空底，不留破图框。
   */
  thumb?: string | null
}

export interface HomeSearchGroup {
  title: string
  items: HomeSearchItem[]
}

export interface HomeSearchCommandProps {
  /** 由父级提供的纯函数：给查询词返回分组结果。父级已 memo。 */
  groups: (query: string) => HomeSearchGroup[]
  /** 用户回车 / 点击某一项 */
  onPick: (item: HomeSearchItem) => void
  /** 面板展开/收起（父级用来暂停粒子或做别的） */
  onOpenChange?: (open: boolean) => void
  /** 展开态输入框的占位文字 */
  placeholder?: string
  /** 快捷键的键字符；实际绑定为 Cmd/Ctrl + 该键 */
  shortcut?: string
  /**
   * 收起态那 192px 里显示的标签。
   *
   * **默认与 `placeholder` 同串**，这不是偷懒：收起态标签和展开态输入框的
   * placeholder 在变形中途是**互相淡入淡出、叠在同一处**的（参考实现里两边
   * 都是 "Find..."，正是因为这个）。如果给两串不同的文字，中途就会出现两层
   * 字叠在一起的鬼影（实测在 80ms 那一帧非常明显）。
   * 代价是收起态那 192px 放不下整串，会被 ellipsis 截断 —— 这是这个尺寸下的
   * 必然结果。父级若更在意收起态的观感，可以传一个 4 字以内的短标签，
   * 但要知道中途会有轻微叠字。
   */
  collapsedLabel?: string
  /**
   * 展开锚点（默认 'center'，即不传时行为与旧版逐像素一致）。
   *
   * - `'center'`：首页。面板中心从收起条中心插值到**视口中心**，盒子围着中心
   *   向四周长（v0.10.x 用户点名的「从画面中心往两边展开」）。
   * - `'toolbar'`：库内顶栏。面板上边缘钉在收起条上沿、左边缘只做 16px 的
   *   1px 补偿，盒子自左上向右下长（参考件 skiper-92 的原始形态）。
   *
   * 只影响 `commandProjection` 里 panel 原点的取法，子元素的 local 公式
   * 一字不动 —— 它们本来就是面板局部坐标，panel 挪到哪它们就跟到哪。
   */
  variant?: HomeSearchVariant
  /**
   * 受控查询词。**提供时组件不再持有 query**（顶栏用：词必须写回 `filters.query`，
   * 网格靠它过滤，否则在网格里打字不会筛）；不提供时维持原来的非受控行为（首页用）。
   *
   * 判定口径是「是不是字符串」而不是「是不是 undefined」：传 `''` 是**受控的空词**
   * （把词清空后父级仍要收到后续变更），不传才是非受控。
   */
  value?: string
  /** 受控变更回调，与 `value` 成对使用。非受控时被忽略。 */
  onQueryChange?: (q: string) => void
  /**
   * 打开信号：**值发生变化**时打开面板并聚焦输入框（光标落在末尾）。
   *
   * 用途：离开首页那一刻把焦点从「随首页一起卸载的输入框」交接给本组件
   * （2026-10「在首页打一个字就丢掉后续输入」那个 bug 的补丁）。
   * 初值**不触发** —— 否则一进网格就会自动弹出一个面板。
   */
  openSignal?: number
}

/* ── 列表行（把「结果」与「最近搜索」统一成一条可选项）─────────────────── */

/**
 * 渲染用的一行。结果行和最近搜索行结构相同，只有 `action` 不同：
 *   - 'pick'    → 真实结果，回车/点击 = 选中这个素材（走 onPick）
 *   - 'requery' → 最近搜索，回车/点击 = **把词填回输入框再查一次**（不走 onPick）
 * 这样 ↑↓ / Enter / Home / End / 滚动到选中 全都只有一条代码路径。
 */
interface RenderRow {
  /** React key（结果行用 item.id，最近搜索用 `recent:${词}`） */
  key: string
  label: string
  meta?: string
  shortcut?: string
  thumb?: string | null
  action: 'pick' | 'requery'
  /** action === 'pick' 时必填 */
  item?: HomeSearchItem
  /** action === 'requery' 时必填 */
  value?: string
}

interface RenderSection {
  title: string
  rows: RenderRow[]
  /** 该组第一行在扁平数组里的下标（供 option 索引用） */
  start: number
}

/** 稳定的空数组引用：让 useMemo 的依赖比较不会每帧造新数组 */
const NO_GROUPS: HomeSearchGroup[] = []
const NO_SECTIONS: RenderSection[] = []

/* ── 动画基建 ───────────────────────────────────────────────────────────── */

type Box = { x: number; y: number; w: number; h: number }

type ChannelKey = 'command' | 'word' | 'listOpacity' | 'listY'

interface Channel {
  /** 当前值 */
  x: number
  /** 当前速度 */
  v: number
  target: number
  /** 刚度（已除以 mass） */
  k: number
  /** 阻尼（已除以 mass） */
  damping: number
  kind: 'spring' | 'tween'
  /** 弹簧起跳值：用来把 0..1 的进度还原出来做交叉淡入淡出 */
  from: number
  restDelta: number
  restSpeed: number
  ease: 'motion' | 'easeOut'
  elapsed: number
  duration: number
}

function createChannel(initial: number): Channel {
  return {
    x: initial,
    v: 0,
    target: initial,
    k: 4500,
    damping: 250,
    kind: 'spring',
    from: initial,
    restDelta: 0.001,
    restSpeed: 0.01,
    ease: 'motion',
    elapsed: 0,
    duration: 0
  }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * 阻尼谐振子的解析解（半隐式欧拉会有帧长相关的误差，解析解没有）。
 *
 * @param x 当前位移 @param v 当前速度 @param target 目标 @param dt 步长（秒）
 * @param k 刚度（质量为 1） @param damping 阻尼系数（质量为 1）
 * @returns [新位移, 新速度]
 */
function springStep(
  x: number,
  v: number,
  target: number,
  dt: number,
  k: number,
  damping: number
): [number, number] {
  if (dt <= 0) return [x, v]
  const w = Math.sqrt(k)
  const a = damping / 2
  const delta = x - target
  const discriminant = w * w - a * a
  // 临界阻尼：(A + Bt)·e^{-at}
  if (Math.abs(discriminant) < 1e-7) {
    const b = v + a * delta
    const e = Math.exp(-a * dt)
    return [target + e * (delta + b * dt), e * (v - a * b * dt)]
  }
  // 欠阻尼：正余弦振荡
  if (discriminant > 0) {
    const b = Math.sqrt(discriminant)
    const sin = Math.sin(b * dt)
    const cos = Math.cos(b * dt)
    const e = Math.exp(-a * dt)
    const c = (v + a * delta) / b
    return [
      target + e * (delta * cos + c * sin),
      e * ((-a * delta + b * c) * cos + (-a * c - b * delta) * sin)
    ]
  }
  // 过阻尼：两条指数衰减（本组件 ζ≈1.86 走的就是这条）
  const b = Math.sqrt(-discriminant)
  const slow = -a + b
  const fast = -a - b
  const c = (v - fast * delta) / (slow - fast)
  const d = delta - c
  const e1 = Math.exp(slow * dt)
  const e2 = Math.exp(fast * dt)
  return [target + c * e1 + d * e2, slow * c * e1 + fast * d * e2]
}

/**
 * 三次贝塞尔缓动求值器（二分法反解 x → t，再取 y）。
 * 只用于两条 100ms 级别的短补间，24 次二分对性能没有影响。
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const sampleX = (t: number): number => {
    const q = 1 - t
    return 3 * q * q * t * x1 + 3 * q * t * t * x2 + t * t * t
  }
  const sampleY = (t: number): number => {
    const q = 1 - t
    return 3 * q * q * t * y1 + 3 * q * t * t * y2 + t * t * t
  }
  return (p: number): number => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let low = 0
    let high = 1
    let t = p
    for (let i = 0; i < 24; i += 1) {
      const x = sampleX(t)
      if (Math.abs(x - p) < 1e-6) break
      if (x < p) low = t
      else high = t
      t = (low + high) / 2
    }
    return sampleY(t)
  }
}

/** Motion 库 transform 默认缓动 cubic-bezier(.25,.1,.35,1) */
const easeMotion = cubicBezier(0.25, 0.1, 0.35, 1)
/** CSS `ease-out` = cubic-bezier(0,0,.58,1)，Esc 徽标那条 100ms 用它 */
const easeOut = cubicBezier(0, 0, 0.58, 1)

/**
 * 几何投影：给定「面板展开进度 p」「Esc 徽标通道 word」与视口中心，算出四个盒子。
 *
 * 所有盒子都在**根坐标系**里（不是面板局部坐标）—— 面板自己写 left/top，
 * 子元素靠 `projectChild` 拿 target 减面板原点反算出自己的位移。
 *
 * 面板原点的取法由 `anchor` 决定，**这是两种 variant 唯一的差别**：
 *
 * ① `anchor === 'center'`（默认，首页）
 *    面板的**中心**才是被插值的量：p=0 时它等于收起条中心，p=1 时落在视口中心；
 *    盒子围绕这个中心**对称**长大（x = cx - w/2），所以左右上下同时外扩。
 *    与旧版（左上角锚定）的等价性：旧版 panel.x = -16p、panel.y = -8p，把它的
 *    local 公式整体平移 -panel 就得到这里的 local 公式；代入 p=0 得到
 *    icon(8,8) / center(32,0) / word(208,0)，与旧版逐值相同。
 *
 * ② `anchor === 'toolbar'`（库内顶栏，参考件 skiper-92 的原始形态）
 *    panel = { x: -16p, y: 0, w, h }：
 *      · y 恒为 0 → 上边缘**钉死**在收起条上沿，盒子只向下长；
 *      · x 从 0 走到 -16 → 左边缘只做 16px 的 1px 级补偿（面板比条宽 320，
 *        这 16px 让左右各多出的那一半不至于把左边"顶住"），其余全靠 w 长大；
 *      · 合起来就是用户说的「从左上角往右下角展开」。
 *    注意：这里**不需要** vpCx / vpCy，工具栏位姿下方框往右下长不需要知道视口中心。
 *
 * 子元素的 local 公式（icon / center / word）两种 anchor 完全共用：它们是
 * 面板局部坐标，panel 原点挪到哪它们就跟到哪。
 *
 * @param p 面板展开进度（0..1）
 * @param word Esc 徽标通道（0..1，收起时 0）
 * @param width 展开态宽度（PANEL_W）
 * @param height 展开态高度（HEAD_H + 列表高）
 * @param vpCx 视口中心在 root 局部坐标系里的 x（仅 'center' 用）
 * @param vpCy 视口中心在 root 局部坐标系里的 y（仅 'center' 用）
 * @param anchor 展开锚点（见上）
 */
function commandProjection(
  p: number,
  word: number,
  width: number,
  height: number,
  vpCx: number,
  vpCy: number,
  anchor: HomeSearchVariant
): { panel: Box; icon: Box; center: Box; word: Box } {
  /* 1) 尺寸：还是原来那条线性插值，不动（240×32 → 560×(49+列表高)） */
  const w = COLLAPSED_W + (width - COLLAPSED_W) * p
  const h = COLLAPSED_H + (height - COLLAPSED_H) * p

  /* 2) 面板原点：唯一按 variant 分叉的地方。
   *    两边的 p=0 都给 { 0, 0, 240, 32 } —— 收起态必须与 .hsc-root 严丝合缝，
   *    否则闭合那一刻会看到一次 1px 的位移抖动。 */
  let panel: Box
  if (anchor === 'toolbar') {
    /* 左上角锚定 / 自左上向右下长：上沿钉死，左边只走 16px 补偿 */
    panel = { x: -16 * p, y: 0, w, h }
  } else {
    /* 中心锚定 / 向四周长：中心从收起条中心插值到视口中心 */
    const cx = COLLAPSED_W / 2 + (vpCx - COLLAPSED_W / 2) * p
    const cy = COLLAPSED_H / 2 + (vpCy - COLLAPSED_H / 2) * p
    panel = { x: cx - w / 2, y: cy - h / 2, w, h }
  }

  return {
    panel,
    /* 头部放大镜：local { x: 8+8p, y: 8+8p, w:16, h:16 } */
    icon: { x: panel.x + 8 + 8 * p, y: panel.y + 8 + 8 * p, w: 16, h: 16 },
    /* 输入容器：local { x: 32+16p, y: 6p, w: 286+(w-96-286)p, h: 32+4p } */
    center: {
      x: panel.x + 32 + 16 * p,
      y: panel.y + 6 * p,
      w: 286 + (width - 96 - 286) * p,
      h: 32 + 4 * p
    },
    word: {
      /* 基线必须跟着 COLLAPSED_W 走，不能写死参考件的 160 / 224。
       * 参考件收起态是 192 宽，word 盒在 p=0 时正好落在 160..192（贴右）；
       * 我们把收起态加宽到 240 之后，160..192 会落在**条子中间**，
       * 于是键帽压在占位文字上（实测截图里 K 盖住了「件名」两个字）。
       * 用 (COLLAPSED_W - 32) 作基线、跨度用 (width - 64) - (COLLAPSED_W - 32)：
       * - 参考件代入 COLLAPSED_W=192、width=384 → 160 / 160，与原式完全等价；
       * - 我们代入 240 / 560 → 208 / 288，p=0 时贴右、p=1 时回到面板右缘。
       * 注意这三行是**面板局部**坐标（local），x 再统一加 panel.x 变成 root 坐标。 */
      x: panel.x + (COLLAPSED_W - 32) + (width - 64 - (COLLAPSED_W - 32)) * word + 16 * p,
      y: panel.y + 8 * p - 8 * word,
      w: 32 + 16 * word,
      h: 32 + 16 * word
    }
  }
}

/**
 * 子元素反向补偿：把 element 摆到 target 盒上，同时抵掉祖先面板的缩放。
 *
 * element 此刻的自然布局盒是 natural（见 css 注释），祖先面板被 scale(sx,sy)，
 * 所以「想让它落在 target」= 先反算出局部坐标，再乘 1/sx 反缩放。
 */
function projectChild(
  element: HTMLElement | null,
  natural: Box,
  target: Box,
  parent: Box,
  width: number,
  height: number
): void {
  if (!element) return
  const sx = parent.w / width
  const sy = parent.h / height
  if (sx === 0 || sy === 0 || natural.w === 0 || natural.h === 0) return
  const x = (target.x - parent.x) / sx - natural.x
  const y = (target.y - parent.y) / sy - natural.y
  element.style.transformOrigin = '0 0'
  element.style.transform = `translate(${x}px,${y}px) scale(${target.w / natural.w / sx},${
    target.h / natural.h / sy
  })`
}

/**
 * 同步收起条内部三个元素（放大镜 / 占位文字 / 键帽）的样式。
 *
 * transform 一律复位成 identity：面板改成「从画面中心长出来」之后，条子本身
 * 不再缩放，它们也不该再参与几何映射（理由见 paint 里的长注释）。写成显式
 * 复位而不是「干脆不写」，是为了能清掉任何残留的内联值。
 *
 * opacity 由调用方按「面板当前不透明度取反」传进来 —— 面板显形到哪里，
 * 条子内容就退到哪里，交接期不会出现两份同款文字同时在屏。
 */
function syncTriggerContent(node: HTMLElement | null, opacity: string): void {
  if (!node) return
  node.style.transformOrigin = '0 0'
  node.style.transform = 'none'
  node.style.opacity = opacity
}

/** 平台判断：只为了把 ⌘K / Ctrl K 显示对 */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || navigator.userAgent || ''
  return /mac|iphone|ipad/i.test(platform)
}

/* ── 组件 ───────────────────────────────────────────────────────────────── */

export function HomeSearchCommand(props: HomeSearchCommandProps): JSX.Element {
  const {
    groups,
    onPick,
    onOpenChange,
    placeholder = '搜索素材、分类或文件名',
    shortcut = 'K',
    collapsedLabel = placeholder,
    variant = 'center',
    value,
    onQueryChange,
    openSignal
  } = props

  const uid = useId()
  const listId = `${uid}-list`
  const optionId = (index: number): string => `${uid}-opt-${index}`

  /* —— DOM 引用 —— */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const triggerIconRef = useRef<HTMLSpanElement | null>(null)
  const triggerLabelRef = useRef<HTMLSpanElement | null>(null)
  const keyRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const headIconRef = useRef<HTMLSpanElement | null>(null)
  const centerRef = useRef<HTMLSpanElement | null>(null)
  const wordRef = useRef<HTMLSpanElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  /* —— React 只承载低频状态 —— */
  const [openRender, setOpenRender] = useState(false)
  /**
   * **非受控**查询词（首页用）。受控时（父级传了 `value`）这里永远是初值 `''`，
   * 一切读写都走 `value` / `onQueryChange` —— 两条入口统一收敛到下面的 `query`
   * 与 `setQuery()`，组件里不再有任何地方直接碰这两个 storage。
   */
  const [internalQuery, setInternalQuery] = useState('')
  const [active, setActive] = useState(0)
  /** 最近搜索（只在面板打开且 query 为空时从 localStorage 读一次） */
  const [recent, setRecent] = useState<string[]>([])
  /**
   * 加载失败的缩略图 URL 集合。
   *
   * 存 **URL** 而不是 boolean，是为了「换 URL 后自然复位」：同一行换了封面之后
   * `has(新URL) === false`，图片会重新渲染；存 boolean 的话一次失败会把这一格
   * 永久锁死成空底。用 Set + state（而不是 ref）是为了让失败那一格真的重渲染
   * 一次把 <img> 摘掉 —— 失败是高概率一次性的、低频的事件，不在 rAF 热路径上。
   */
  const [failedThumbs, setFailedThumbs] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )

  /**
   * 当前锚点。用 ref 是因为 `paint()` 会被**旧渲染**创建的 rAF 循环（tick）调用，
   * 闭包里捕获的 props 可能已经过期；variant 理论上整个生命周期不变，但用 ref
   * 读当前值零成本，顺手把这个隐患堵死。
   * （渲染期直接赋值，与下面 channelsRef 的写法一致。）
   */
  const variantRef = useRef<HomeSearchVariant>(variant)
  variantRef.current = variant

  /* —— 查询词：受控 / 非受控的**唯一**读写入口 ——
   *
   * `query` 读、`setQuery()` 写。组件内四处读写必须全部走它们，少一处就会出现
   * 「受控组件自己偷偷改词」→ 顶栏那条收起态标签和网格的 filters.query 不同步：
   *   ① 输入框 onChange   ② 最近搜索 requery   ③ pick 前读当前词
   *   ④ setOpen 打开时的清空（受控时**不清**，见 setOpen 里的注释） */
  const isControlled = typeof value === 'string'
  const query = value ?? internalQuery
  const onQueryChangeRef = useRef(onQueryChange)
  useLayoutEffect(() => {
    onQueryChangeRef.current = onQueryChange
  }, [onQueryChange])

  /**
   * 写查询词。
   *
   * 受控时**只通知父级**、不改本地 state：真正的值由 `value` 回流，这样组件永远
   * 是父级状态的镜像（父级拒绝更新时 UI 不会偷偷跑偏）。非受控时才落到 state。
   */
  function setQuery(next: string): void {
    if (isControlled) onQueryChangeRef.current?.(next)
    else setInternalQuery(next)
  }

  /**
   * 空查询 = 「最近搜索」模式。
   *
   * 产品口径（用户原话）：「原始的搜索框，这个位置给我弹出来分类其实没有什么意义，
   * 这里显示最近搜索」。父级在空查询时仍会返回「分类」分组（那是 App.tsx 的事），
   * 这里**直接不渲染**父级的返回，改用本地历史 —— 组件内接管，父级不用改。
   */
  const isRecentMode = query.trim() === ''

  /* 结果：空查询连 groups() 都不调用，省一次父级遍历 */
  const result = useMemo<HomeSearchGroup[]>(
    () => (isRecentMode ? NO_GROUPS : groups(query)),
    [groups, query, isRecentMode]
  )

  /** 结果分组 → 渲染行（两组分开 memo，最近搜索变化时不会惊动结果列表） */
  const resultSections = useMemo<RenderSection[]>(() => {
    let offset = 0
    return result.map((group) => {
      const start = offset
      offset += group.items.length
      return {
        title: group.title,
        start,
        rows: group.items.map((item) => ({
          key: item.id,
          label: item.label,
          meta: item.meta,
          shortcut: item.shortcut,
          thumb: item.thumb,
          action: 'pick' as const,
          item
        }))
      }
    })
  }, [result])

  /** 最近搜索 → 渲染行（单个分组，action 全是 'requery'） */
  const recentSections = useMemo<RenderSection[]>(() => {
    if (recent.length === 0) return NO_SECTIONS
    return [
      {
        title: RECENT_TITLE,
        start: 0,
        rows: recent.map((value) => ({
          key: `recent:${value}`,
          label: value,
          action: 'requery' as const,
          value
        }))
      }
    ]
  }, [recent])

  const sections = isRecentMode ? recentSections : resultSections
  const flat = useMemo<RenderRow[]>(() => sections.flatMap((section) => section.rows), [
    sections
  ])
  /** 高亮索引夹在合法范围内（过滤后 flat 可能变短） */
  const safeActive = flat.length === 0 ? 0 : Math.min(active, flat.length - 1)

  /* —— 动画引擎的可变状态（不进 state，避免每帧渲染） —— */
  const openRef = useRef(false)
  const focusPendingRef = useRef(false)
  /**
   * 「这次聚焦要把光标放到末尾」。
   *
   * 只由 `openSignal` 那条路径置位（离开首页的焦点交接）。用户正在续写，光标停在
   * 第 0 位会让下一个字插到最前面；Cmd/Ctrl+F 打开则保持浏览器默认（不动选区），
   * 与旧顶栏的行为一致。
   */
  const caretToEndRef = useRef(false)
  const reducedRef = useRef(false)
  const rafRef = useRef(0)
  const lastTimeRef = useRef(0)
  const engineRef = useRef<{ setOpen: (next: boolean) => void; paint: () => void } | null>(null)
  /**
   * `.hsc-root` 的盒子快照（视口坐标系）。
   *
   * 只服务一件事：把「视口中心」换算成 root 局部坐标 —— 面板要长到那儿去
   * （见 `commandProjection` 的 cx / cy）。**只有 `variant='center'` 用得上**：
   * toolbar 模式是左上角锚定的，不需要知道视口中心。
   *
   * ⚠️ **不能**在 `paint()` 里每帧 `getBoundingClientRect()`：它会强制同步布局，
   * 60fps 的关键路径上插一次就是一次掉帧。所以只在三处写它：
   *   ① 打开面板时（`setOpen`）② `window` resize ③ `paint()` 发现它是 null 时补读一次。
   *
   * ⚠️ 已知偏差，**故意不修**：进首页时左栏有 180ms 折叠动画，若用户在这 180ms
   * 内就按 Cmd+K，快照会量到滑动途中的位置，于是「终态中心」最多偏 ~108px
   * （左栏宽 216 的一半）。权衡：改成每帧重量能吃掉这个偏差，但那正是上面
   * 明令禁止的强制布局 —— 用 60fps 的稳定性换一个「首帧 180ms 内的边缘偏差」
   * 是划算的。真要修的正确做法是订阅折叠动画的过渡结束事件再刷新快照，
   * 而不是把 getBoundingClientRect 塞回热路径。
   */
  const rootRectRef = useRef<DOMRect | null>(null)
  /** 列表高度缓存；结果变化时置脏，避免每帧读 scrollHeight */
  const listHeightRef = useRef(LIST_MAX_H)
  const listHeightDirtyRef = useRef(true)

  const onOpenChangeRef = useRef(onOpenChange)
  const onPickRef = useRef(onPick)
  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange
    onPickRef.current = onPick
  }, [onOpenChange, onPick])

  /* 通道容器：整个组件生命周期只建一次 */
  const channelsRef = useRef<Record<ChannelKey, Channel> | null>(null)
  if (channelsRef.current === null) {
    channelsRef.current = {
      command: createChannel(0),
      word: createChannel(0),
      listOpacity: createChannel(0),
      listY: createChannel(-50)
    }
  }
  const channels = channelsRef.current

  /**
   * 量一次自然布局盒里**随内容变化**的那一个：收起态占位文字的可视宽度。
   * offsetWidth 不受 transform 影响，所以任何时刻量都安全。
   *
   * 注：`collapsedLabel` 的宽度必须自己算出来写成内联 width —— 收起条要留出
   * 放大镜(32) + 间隙(12) + 键帽 + 右边距(5) 的位置，剩下的才是文字能用的宽度，
   * 超出的部分由 `.hsc-trigger-label` 自己的 ellipsis 吃掉。
   */
  function measureNaturals(): void {
    const key = keyRef.current
    const label = triggerLabelRef.current
    if (!key || !label) return
    const keyWidth = key.offsetWidth > 0 ? key.offsetWidth : 22
    // 32(放大镜占位) + 文字 + 12(间隙) + 键帽 + 5(右边距) = COLLAPSED_W
    const labelWidth = Math.max(40, COLLAPSED_W - 32 - keyWidth - 12 - 5)
    label.style.width = `${labelWidth}px`
  }

  /**
   * 把当前所有通道值刷到 DOM 上。
   * 顺序纪律：**先读后写**（列表高度是一次强制布局，要放在所有写入之前）。
   */
  function paint(): void {
    const root = rootRef.current
    const panel = panelRef.current
    const trigger = triggerRef.current
    const list = listRef.current
    if (!root || !panel || !trigger || !list) return

    /* —— 读 —— */
    if (listHeightDirtyRef.current) {
      listHeightDirtyRef.current = false
      /* ⚠️ **收起动画进行中不重量列表高度。**
       *
       * 这条守卫是 v0.10.x 接进顶栏之后补的，防的是这个真实序列：
       *   ① 用户在网格里搜「chair」，点中一条结果 → `pick()`；
       *   ② `onPick` 进父级 → 父级把 `filters.query` 清成 ''（进分类/开文件夹都会清）；
       *   ③ 受控的 query 一变，本组件立刻从「结果视图」翻回「最近搜索视图」，
       *      `flat` 换引用 → 触发重绘，而此刻**收起弹簧才刚起步**；
       *   ④ 若在这里重量，面板高度会从「结果列表 300」瞬间变成「最近搜索 ~168」，
       *      于是关闭动画的第一帧看到整块面板纵向塌一下。
       *
       * 收起期间沿用上一次的高度（盒子继续按旧尺寸缩回去，视觉上完全连续），
       * 下次打开时 `setOpen(true)` 会重新置脏 → 按新内容量一次。 */
      if (openRef.current) {
        const raw = list.scrollHeight
        listHeightRef.current = Math.max(LIST_MIN_H, Math.min(LIST_MAX_H, raw))
      }
    }
    const listHeight = listHeightRef.current

    /* 视口中心在 root 局部坐标系里的位置 —— 面板就长到这儿（见 commandProjection）。
     * 快照由 setOpen / resize 写入；万一还是 null（首帧、或挂在别处没人刷新）
     * 在这里补读一次，之后的每一帧都只读这个 ref，绝不碰强制布局。
     *
     * ⚠️ 为什么基准是「视口」而不是「内容区」——这是**有意为之**，别"修正"：
     * 用户原话是「从画面中心往两边展开，居中展示」，画面中心就是窗口中心。
     * 顶栏（Toolbar h-14 = 56px）确实让内容区中心比视口中心低 28px，但要把
     * 56/2 补进来就得把顶栏高度硬编进这个组件，顶栏一改高度这里就静默偏位。
     * 两害相权，选「跟随窗口」这条更稳的口径。
     *
     * toolbar 模式跳过这段（左上角锚定不需要视口中心），也就顺带省掉了
     * 一次 getBoundingClientRect —— 库内顶栏这种位姿下，省下来的就是白赚的。 */
    const anchor = variantRef.current
    let vpCx = 0
    let vpCy = 0
    if (anchor === 'center') {
      let rootRect: DOMRect | null = rootRectRef.current
      if (rootRect === null) {
        rootRect = root.getBoundingClientRect()
        rootRectRef.current = rootRect
      }
      vpCx = window.innerWidth / 2 - rootRect.left
      vpCy = window.innerHeight / 2 - rootRect.top
    }

    /* —— 写 —— */
    const width = PANEL_W
    const height = HEAD_H + listHeight
    const command = channels.command
    const p = clamp01(command.x)
    const word = clamp01(channels.word.x)
    const geometry = commandProjection(p, word, width, height, vpCx, vpCy, anchor)
    const bounds = geometry.panel
    const sx = bounds.w / width
    const sy = bounds.h / height

    panel.style.width = `${width}px`
    panel.style.height = `${height}px`
    panel.style.left = `${bounds.x}px`
    panel.style.top = `${bounds.y}px`
    panel.style.transformOrigin = '0 0'
    panel.style.transform = `scale(${sx},${sy})`

    /* 面板与触发器的互相淡入淡出：
     * lead 用 circOut 走 [0,.5]，follow 线性走 [.5,.95] —— 两条曲线不重叠，
     * 所以变形全程不会出现「两边都看不见」的空窗。 */
    const progress =
      command.target === command.from
        ? 1
        : clamp01((command.x - command.from) / (command.target - command.from))
    const lead = Math.sqrt(1 - Math.pow(Math.min(1, progress * 2) - 1, 2))
    const follow = 1 - clamp01((progress - 0.5) / 0.45)
    const isOpen = openRef.current
    /* 面板当前的不透明度抽成一个数，条子内容直接拿它取反用（见下面的交接）。 */
    const panelOpacity = isOpen ? lead : p > 0.0001 ? follow : 0
    panel.style.opacity = String(panelOpacity)
    trigger.style.opacity = String(isOpen ? follow : lead)
    /* 收起条**不再跟着面板飞**。
     * 旧版面板是左上角锚定的，条子按面板 bounds 写 translate+scale 就能一路
     * 「长成」面板；现在面板要长到视口中心（center）/ 从左上往右下长（toolbar），
     * 再让条子跟着算就会把它整块拽走。所以它保持自己的 240×32 原地不动，
     * 只按 lead/follow 淡出（opacity 曲线一点没改）。读起来是：条子原地淡出，
     * 面板从它身上长出去。 */
    trigger.style.transformOrigin = '0 0'
    trigger.style.transform = 'none'

    const parent: Box = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }

    // 头部放大镜（面板内，恒 16×16，只跟着位移）
    projectChild(
      headIconRef.current,
      { x: 16, y: 16, w: 16, h: 16 },
      geometry.icon,
      parent,
      width,
      height
    )
    // 输入容器
    projectChild(
      centerRef.current,
      { x: 48, y: 6, w: width - 96, h: 36 },
      geometry.center,
      parent,
      width,
      height
    )
    // Esc 徽标容器
    projectChild(
      wordRef.current,
      { x: width - 48, y: 0, w: 48, h: 48 },
      geometry.word,
      parent,
      width,
      height
    )

    /* 收起条内部的三个元素：**原地不动**，跟着按钮的 opacity 一起淡出。
     *
     * 为什么不再把它们映射进 geometry：
     *   ① 那套映射的前提是「条子被 scale 成面板大小」—— 现在条子 transform 是
     *      none，再按面板比例反算，位移会被 1/sx 除法扭成完全不同的轨迹；
     *   ② 条子的 overflow 会裁掉飞出去的内容（位移最大到 -150px 量级）；
     *   ③ 面板现在是「从条子身上长出去」，条子内容跟着飞会和面板自己的
     *      放大镜 / 输入框抢同一个落点。
     * 三者叠加，唯一自洽的做法就是：内容留在原地，靠淡出完成交接。
     *
     * 交接曲线为什么是「1 − 面板当前不透明度」，而不是「1 − lead」也不是「直接 0」：
     *   - 不能直接留 0：条子本体（玻璃底板 + 投影）按 follow 淡到 progress≈0.95，
     *     内容先没了会看到「一块空白玻璃」先飘一下；
     *   - 不能用 1 − lead：lead 只描述**展开**方向。收起时 lead 是从 0 涨回 1 的，
     *     1 − lead 会在关闭动画结束时把内容压成 0 —— 收起条从此变成一个空壳
     *     （面板 opacity 在关闭时走的是 follow，不是 lead）。这是真机一开一关就
     *     能看到的破绽，所以这里取「面板此刻有多不透明」再取反：
     *       · 展开途中：面板 = lead → 内容 = 1 − lead（面板一显形，条子内容立刻让位，
     *         progress 0.5 时已完全透明，两份同款占位文字不会同时在屏）；
     *       · 收起途中：面板 = follow → 内容 = 1 − follow（面板退到哪里，内容回到哪里）；
     *       · 两端静止：面板 0/1 → 内容 1/0，收起态永远可读、展开态永远干净。
     *   - 只动这三个子元素，**不碰** `.hsc-trigger` 与 `::before` 的 opacity：
     *     玻璃底板和投影必须仍按 follow 曲线淡出，否则中途会忽然空一块。 */
    const contentOpacity = String(1 - panelOpacity)
    syncTriggerContent(triggerIconRef.current, contentOpacity)
    syncTriggerContent(triggerLabelRef.current, contentOpacity)
    syncTriggerContent(keyRef.current, contentOpacity)

    // 列表：整体跟着面板走，同时用 listY 做一次「从下方 50px 滑上来」
    const listOpacity = clamp01(channels.listOpacity.x)
    list.style.height = `${listHeight}px`
    list.style.opacity = String(listOpacity)
    // 收起态它会被 1/sy 放大近 11 倍，隐藏掉免得白建一个巨图层
    list.style.visibility = listOpacity > 0.01 ? 'visible' : 'hidden'
    projectChild(
      list,
      { x: 0, y: HEAD_H, w: width, h: listHeight },
      { x: bounds.x, y: bounds.y + HEAD_H + channels.listY.x, w: width, h: listHeight },
      parent,
      width,
      height
    )
  }

  /**
   * 起一个弹簧。目标没变且上一个动作也是弹簧时直接返回（避免重启动画）。
   * 中断策略 = retarget：新目标立刻接管。
   */
  function movePhysical(
    key: ChannelKey,
    target: number,
    stiffness: number,
    damping: number,
    mass = 1
  ): void {
    const channel = channels[key]
    if (Math.abs(channel.target - target) < 1e-7 && channel.kind === 'spring') return
    channel.target = target
    channel.kind = 'spring'
    channel.k = stiffness / mass
    channel.damping = damping / mass
    channel.restDelta = 0.001
    channel.restSpeed = 0.01
    channel.elapsed = 0
    channel.duration = 0
    kick()
  }

  /** 起一段补间（只用于 Esc 徽标 100ms 收起） */
  function tween(key: ChannelKey, target: number, durationMs: number, ease: 'motion' | 'easeOut'): void {
    const channel = channels[key]
    if (Math.abs(channel.target - target) < 1e-7 && channel.kind === 'tween') return
    channel.kind = 'tween'
    channel.ease = ease
    channel.from = channel.x
    channel.target = target
    channel.v = 0
    channel.elapsed = 0
    channel.duration = durationMs / 1000
    kick()
  }

  /**
   * 面板尺寸通道专用：参考实现的 projection.startAnimation 每次快照都带
   * velocity:0，所以每次改目标都把速度清零、from 重置到当前值
   * （这决定了交叉淡入淡出的进度从 0 重新走）。
   */
  function moveCommandLayout(key: 'command' | 'word', target: number): void {
    const channel = channels[key]
    const changed = channel.target !== target
    movePhysical(key, target, 450, 25, 0.1)
    if (changed) {
      channel.v = 0
      channel.from = channel.x
      channel.restDelta = 0.0005
      channel.restSpeed = 0.002
    }
  }

  /** 单帧推进 */
  function tick(now: number): void {
    rafRef.current = 0
    if (document.hidden) return
    // 夹到 64ms：掉帧或切回标签页时不要让一帧跳完整个动画
    const dt = Math.min(0.064, Math.max(0, (now - lastTimeRef.current) / 1000))
    lastTimeRef.current = now
    let moving = false
    for (const channel of Object.values(channels)) {
      if (channel.kind === 'tween') {
        channel.elapsed = Math.min(channel.duration, channel.elapsed + dt)
        const t = channel.duration > 0 ? channel.elapsed / channel.duration : 1
        const ease = channel.ease === 'easeOut' ? easeOut : easeMotion
        channel.x = channel.from + (channel.target - channel.from) * ease(t)
        if (t < 1) moving = true
        else channel.x = channel.target
      } else {
        if (dt > 0) {
          const [nextX, nextV] = springStep(
            channel.x,
            channel.v,
            channel.target,
            dt,
            channel.k,
            channel.damping
          )
          channel.x = nextX
          channel.v = nextV
        }
        if (
          Math.abs(channel.x - channel.target) < channel.restDelta &&
          Math.abs(channel.v) < channel.restSpeed
        ) {
          channel.x = channel.target
          channel.v = 0
        } else {
          moving = true
        }
      }
    }
    paint()
    if (moving) rafRef.current = requestAnimationFrame(tick)
  }

  /** 起循环（已在跑就不重复起） */
  function kick(): void {
    // 减少动效：直接置终值，一帧都不跑
    if (reducedRef.current) {
      for (const channel of Object.values(channels)) {
        channel.x = channel.target
        channel.v = 0
        channel.from = channel.target
        channel.elapsed = channel.duration
      }
      paint()
      return
    }
    if (rafRef.current !== 0) return
    lastTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }

  /**
   * 展开 / 收起。
   *
   * 只做三件事：改通道目标、同步 openRef、把状态推给 React（aria 与结果列表）。
   * 焦点与 inert 交给下面的 layout effect —— 必须等 React 提交、inert 真正解除
   * 之后才能 focus，否则 focus 会被 inert 吃掉。
   */
  function setOpen(next: boolean): void {
    if (openRef.current === next) return
    openRef.current = next
    if (next) {
      /* 面板这一趟要长到「视口中心」（center 模式），所以打开前先把 root 的盒子
       * 量准（窗口尺寸、侧栏折叠动画、字体变化都可能让它在两次打开之间挪位）。
       * toolbar 模式是左上角锚定的，压根不用视口中心 —— 跳过这次强制布局。 */
      if (variantRef.current === 'center') {
        rootRectRef.current = rootRef.current?.getBoundingClientRect() ?? null
      }
      /* 非受控（首页）：每次打开都从空查询开始 —— 空查询即「最近搜索」。
       *
       * 受控（顶栏）：查询词就是父级正在生效的筛选条件，**打开面板不许动它**。
       * 否则在网格里点一下搜索框（或按 Ctrl+F）就会把当前筛选清掉，网格当场
       * 从"筛过的 3 条"变成"全部 2248 条" —— 这是比"忘掉上次搜的词"严重得多的
       * 事故。受控时打开就是「继续编辑当前这一份筛选」。 */
      if (!isControlled) setQuery('')
      setActive(0)
      const list = listRef.current
      if (list) list.scrollTop = 0
      listHeightDirtyRef.current = true
    }
    moveCommandLayout('command', next ? 1 : 0)
    if (next) moveCommandLayout('word', 1)
    else tween('word', 0, 100, 'easeOut')
    movePhysical('listOpacity', next ? 1 : 0, 450, 25, 0.1)
    movePhysical('listY', next ? 0 : -50, 450, 25, 0.1)
    setOpenRender(next)
    onOpenChangeRef.current?.(next)
  }

  /* engineRef 每次都指向最新闭包；事件处理器只可能在挂载之后被调用 */
  useLayoutEffect(() => {
    engineRef.current = {
      setOpen: (next: boolean): void => {
        if (next && !openRef.current) focusPendingRef.current = true
        setOpen(next)
      },
      paint
    }
  })

  /* —— 首帧：量自然盒 + 摆到收起态（避免面板在左上角闪一下） —— */
  useLayoutEffect(() => {
    reducedRef.current =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    measureNaturals()
    listHeightDirtyRef.current = true
    paint()
    // 字体加载完键帽宽度可能变，重量一次
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => {
        measureNaturals()
        paint()
      })
    }
  }, [])

  /* —— 结果变化：列表高度变了，重新量一遍并立即重绘 ——
   * 最近搜索是渲染里的另一支（sections 换成 recentSections），flat 的引用同样会
   * 变，所以这条 effect 把两种列表都覆盖了，不需要第二份。 */
  useLayoutEffect(() => {
    listHeightDirtyRef.current = true
    paint()
  }, [flat])

  /**
   * 最近搜索的**读**时机：面板打开 && query 为空。
   *
   * 只在「进入最近搜索视图」这一刻读一次 localStorage，不在 rAF 循环里读
   * （localStorage 是同步 IO，塞进 60fps 的 paint 里就是等着掉帧）。
   * 依赖里带 `query`：用户把输入框清空回到「最近搜索」时会**重新读一遍**，
   * 这样别的标签页/窗口写进去的记录也能立刻反映。
   *
   * 为什么是 useLayoutEffect（而不是 useEffect）：读回来的条数直接决定列表
   * scrollHeight，而列表高度是面板高度的输入。放在 passive effect 里，第一帧
   * 会先按「暂无最近搜索」的 80px 画一次、下一帧才跳到真实高度 —— 虽然那时
   * 面板 opacity 还接近 0（看不出来），但没必要留这个窗口。layout effect 里
   * setState 会让 React 在**浏览器绘制之前**同步补一轮，高度一次到位。
   */
  useLayoutEffect(() => {
    if (!openRender) return
    if (query.trim() !== '') return
    const next = readRecentSearches()
    setRecent((prev) => (sameRecentList(prev, next) ? prev : next))
  }, [openRender, query])

  /**
   * 聚焦输入框，必要时把光标放到末尾。
   *
   * 为什么单独抽出来：两条路径要用同一套收尾逻辑 ——
   *   ① `openSignal` 打开（面板从关到开，要等 React 提交 + inert 解除之后，
   *      所以真正的调用点在下面那个 `[openRender]` layout effect 里）；
   *   ② `openSignal` 到来时面板**本来就开着**（`setOpen` 是幂等的，不会再触发
   *      一次 `[openRender]`），此时可以立刻聚焦。
   */
  function focusInputAtEnd(): void {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (caretToEndRef.current) {
      caretToEndRef.current = false
      const end = el.value.length
      // 光标落到末尾 —— 用户接着敲字就是续写，而不是把已输入的字覆盖掉
      el.setSelectionRange(end, end)
    }
  }

  /* —— 展开后的收尾：解除 inert、把焦点交给输入框 —— */
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel) {
      ;(panel as HTMLElement & { inert: boolean }).inert = !openRender
    }
    if (openRender && focusPendingRef.current) {
      focusPendingRef.current = false
      focusInputAtEnd()
    }
  }, [openRender])

  /**
   * 打开信号（父级说「请打开并聚焦」）。
   *
   * **只在值发生变化时**响应：ref 的初值就是首帧的 prop 值，所以初次挂载、
   * 以及「首页↔网格切换导致的重挂载」都不会误触发（否则一进网格就自动弹面板，
   * 用户根本没点搜索）。
   *
   * 与 reduced-motion 无关：那条通道只管"要不要播放形变"，不管"开不开"；
   * 减少动效时 `kick()` 会把通道直接置终值，面板仍然打开、仍然聚焦。
   */
  const openSignalRef = useRef<number>(typeof openSignal === 'number' ? openSignal : 0)
  useEffect(() => {
    const signal = typeof openSignal === 'number' ? openSignal : 0
    if (signal === openSignalRef.current) return
    openSignalRef.current = signal
    if (openRef.current) {
      /* 已经开着：不会再有 openRender 变化，自己聚焦收尾 */
      focusInputAtEnd()
      return
    }
    caretToEndRef.current = true
    focusPendingRef.current = true
    engineRef.current?.setOpen(true)
  }, [openSignal])

  /* —— 卸载：停 rAF（监听在各 effect 里自行清理） —— */
  useEffect(() => {
    return () => {
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  /* —— 窗口尺寸变化：刷新 root 快照，已展开的面板按新的视口中心重画 ——
   * 收起态（p=0）的几何与快照无关，所以只在开着的时候才需要重画。
   * 这里用 engineRef 拿最新的 paint 闭包，避免 effect 捕获旧渲染。
   * toolbar 模式下 paint 不读快照，这里多量一次也无害（resize 是低频事件）。 */
  useEffect(() => {
    const onResize = (): void => {
      rootRectRef.current = rootRef.current?.getBoundingClientRect() ?? null
      if (openRef.current) engineRef.current?.paint()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* —— 全局 Cmd/Ctrl + K —— */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() !== shortcut.toLowerCase()) return
      const target = event.target
      // 已经有别的输入框在编辑时不抢
      if (target instanceof HTMLElement) {
        const editing =
          target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
        if (editing && target !== inputRef.current) return
      }
      event.preventDefault()
      event.stopPropagation()
      if (openRef.current) inputRef.current?.focus({ preventScroll: true })
      else engineRef.current?.setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [shortcut])

  /* —— 门外点击关闭（捕获阶段，避免被内层 stopPropagation 吃掉） —— */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!openRef.current) return
      const root = rootRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      engineRef.current?.setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  /* —— 选中项滚动到可视区（两种列表共用：都带 data-selected） —— */
  useEffect(() => {
    const list = listRef.current
    if (!list || !openRef.current) return
    const node = list.querySelector<HTMLElement>("[data-selected='true']")
    if (!node) return
    // 手算而不是 scrollIntoView：后者会连带滚动祖先容器，把首页整体顶一下
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    const viewTop = list.scrollTop
    const viewBottom = viewTop + list.clientHeight
    if (top < viewTop) list.scrollTop = top
    else if (bottom > viewBottom) list.scrollTop = bottom - list.clientHeight
  }, [safeActive, flat])

  /**
   * 缩略图加载失败：按 URL 记一笔，然后把这一格的 <img> 摘掉（只留 36×36 空底）。
   * 不用 boolean 的原因见 failedThumbs 的注释。
   */
  function markThumbFailed(url: string): void {
    setFailedThumbs((prev) => {
      if (prev.has(url)) return prev
      const next = new Set(prev)
      next.add(url)
      return next
    })
  }

  /** 选中一个真实结果（写最近搜索 → 交给父级 → 收起面板） */
  function pick(item: HomeSearchItem | undefined): void {
    if (!item) return
    /* 写最近搜索的时机 = 用户**真正选了一项**之前。
     * 只记「有实际查询词」的那次：空查询下点最近搜索走的是 requery 分支，
     * 不会到这里；分类/推荐类的空词结果也不该污染历史。 */
    const term = query.trim()
    if (term !== '') setRecent(rememberSearch(term))
    onPickRef.current(item)
    engineRef.current?.setOpen(false)
  }

  /**
   * 最近搜索行：把词填回输入框并立刻重新查询。
   *
   * **不调用 onPick** —— 最近搜索是「再搜一次」，不是「选中某个素材」。
   * 面板保持展开，列表切到结果视图（isRecentMode 由非空 query 自动翻转）。
   */
  function requery(value: string): void {
    setQuery(value)
    setActive(0)
    const list = listRef.current
    if (list) list.scrollTop = 0
    listHeightDirtyRef.current = true
    // 鼠标点行会把焦点留在按钮上，重新查一次要能直接继续打字
    inputRef.current?.focus({ preventScroll: true })
  }

  /** 统一的行激活：两种列表共用一条路径（↑↓ 选中后回车也走这里） */
  function activateRow(row: RenderRow | undefined): void {
    if (!row) return
    if (row.action === 'requery') {
      requery(typeof row.value === 'string' ? row.value : row.label)
      return
    }
    pick(row.item)
  }

  /**
   * 一键清词（v0.10.x，补回旧顶栏那个 ×）。
   *
   * 只清词：**不关面板、不调 onPick、不写历史** —— 用户下一步一定是接着重新搜，
   * 面板一关就得再点开一次。焦点还给输入框、光标落 0（词已经空了，0 即末尾）。
   * 受控时走 `setQuery('')` → 父级 `filters.query` 一起归零，网格当场恢复全量，
   * 与「退格删干净」是同一条路径，没有第二套语义。
   */
  function clearQuery(): void {
    setQuery('')
    const el = inputRef.current
    if (el) {
      el.focus({ preventScroll: true })
      el.setSelectionRange(0, 0)
    }
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    /* 中文输入法组词中：Enter 是"确认候选词"、↑↓ 是"选候选词"、Esc 是"取消候选"，
     * 一个都不该被面板抢走 —— 否则打第一个词按回车就选中一条结果并把面板关了。
     *
     * React 的合成事件**没有** `isComposing`，必须读 `event.nativeEvent`；
     * `keyCode === 229` 是老内核（以及部分 IME）在组词期给出的等价信号，两道一起判。
     *
     * 位置纪律：必须是函数**第一行**，排在 `preventDefault()` 和所有分支之前 ——
     * 任何一次 `preventDefault` 都可能把这次按键从 IME 手里夺走。 */
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      engineRef.current?.setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      activateRow(flat[safeActive])
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => {
        const from = Math.min(current, flat.length - 1)
        return (from + delta + flat.length) % flat.length
      })
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (flat.length === 0) return
      setActive(event.key === 'Home' ? 0 : flat.length - 1)
    }
  }

  const isMac = useMemo<boolean>(() => detectMac(), [])
  const shortcutLabel = isMac ? `⌘${shortcut}` : `Ctrl ${shortcut}`

  /**
   * 收起态那条 240px 里的文字。
   *
   * 顶栏（toolbar）是**常驻**控件，用户必须一眼看出"现在在筛什么"，所以查询词
   * 非空时直接显示词本身（超出由 `.hsc-trigger-label` 的 ellipsis 截断）。
   * 旧顶栏是靠「图标钮留在激活色 + title 提示」表达的，换成变形条之后那套表达
   * 没了，只能写在标签上。
   *
   * 首页（center）**保持**「永远显示 placeholder」：它收起态是一句提示，
   * 不是状态栏，跟着查询词变反而会闪（打开时会被清空，文字跳一下）。
   */
  const triggerLabelText =
    variant === 'toolbar' && query.trim() !== '' ? query.trim() : collapsedLabel

  return (
    <div
      className="hsc-root"
      ref={rootRef}
      data-open={openRender ? 'true' : 'false'}
      data-variant={variant}
    >
      {/* 门外点击层：完全透明，只吃指针；面板 z-index 更高所以盖不住它 */}
      {openRender ? (
        <div
          className="hsc-shade"
          aria-hidden="true"
          onPointerDown={() => engineRef.current?.setOpen(false)}
        />
      ) : null}

      {/* ① 收起态触发器：COLLAPSED_W×32 这一个盒子 */}
      <button
        type="button"
        className="hsc-trigger"
        ref={triggerRef}
        aria-expanded={openRender}
        aria-controls={listId}
        aria-label={placeholder}
        onClick={() => engineRef.current?.setOpen(true)}
      >
        <span className="hsc-trigger-icon" ref={triggerIconRef}>
          <IconSearch />
        </span>
        <span className="hsc-trigger-label" ref={triggerLabelRef}>
          {triggerLabelText}
        </span>
        <kbd className="hsc-key" ref={keyRef}>
          {shortcutLabel}
        </kbd>
      </button>

      {/* ② 命令面板：同一个盒子长高长宽长出来的形态 */}
      <div className="hsc-panel" ref={panelRef} aria-hidden={!openRender}>
        <div className="hsc-head">
          <span className="hsc-head-slot">
            <span className="hsc-head-icon" ref={headIconRef}>
              <IconSearch />
            </span>
          </span>
          <span className="hsc-center" ref={centerRef}>
            <input
              ref={inputRef}
              className="hsc-input"
              type="text"
              role="combobox"
              aria-expanded={openRender}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label={placeholder}
              aria-activedescendant={flat.length > 0 ? optionId(safeActive) : undefined}
              placeholder={placeholder}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
                const list = listRef.current
                if (list) list.scrollTop = 0
              }}
              onKeyDown={handleInputKeyDown}
            />
            {/* 一键清词（v0.10.x）。放在**输入容器内部**而不是头部第四个 flex 子项：
                `.hsc-center` 的自然盒是几何常量（{x:48, y:6, w:面板宽-96, h:36}），
                往它内部加一个 flex:none 的 20×20 只会让 input 少 20px（input 是
                flex:1 + min-width:0），**不动任何 projectChild 的 natural 值**；
                若加成 `.hsc-head` 的直接子项，会把 `.hsc-word` 的自然 x 从
                `width-48` 顶走，几何映射立刻错位。位置效果一样：输入区右端、
                Esc 徽标左边。
                条件渲染、不留空位：头部本来就是右对齐的，占位只会白缩短输入框。 */}
            {query !== '' ? (
              <button
                type="button"
                className="hsc-clear"
                aria-label="清空搜索"
                title="清空搜索"
                /* mousedown 阻止默认：不然按下这一下就把焦点从输入框抢走，
                   词虽然清了但光标没了，用户还得再点一下输入框。 */
                onMouseDown={(event) => event.preventDefault()}
                onClick={clearQuery}
              >
                <IconClose width={12} height={12} />
              </button>
            ) : null}
          </span>
          <span className="hsc-word" ref={wordRef}>
            <button
              type="button"
              className="hsc-esc"
              aria-label="关闭搜索"
              onClick={() => {
                engineRef.current?.setOpen(false)
                triggerRef.current?.focus({ preventScroll: true })
              }}
            >
              Esc
            </button>
          </span>
        </div>

        <div className="hsc-list" ref={listRef} id={listId} role="listbox" aria-label="搜索结果">
          {flat.length === 0 ? (
            isRecentMode ? (
              /* 空历史：分组标题 + 一行**不可点击**的提示（不是选项，不进 flat，
               * 所以 ↑↓ 不会停在它上面，回车也不会误触发任何动作） */
              <div className="hsc-group">
                <div className="hsc-group-title">{RECENT_TITLE}</div>
                <div className="hsc-recent-empty">{RECENT_EMPTY_LABEL}</div>
              </div>
            ) : (
              <div className="hsc-empty">没有找到相关内容</div>
            )
          ) : (
            sections.map((section) => (
              <div className="hsc-group" key={`${section.title}#${section.start}`}>
                <div className="hsc-group-title">{section.title}</div>
                {section.rows.map((row, offset) => {
                  const index = section.start + offset
                  const selected = index === safeActive
                  /* 缩略图 URL 归一：undefined / null / 空串都当「没有缩略图」，
                   * 这一行就退化成 44px 纯文字行，连 36×36 的槽都不渲染。 */
                  const thumb =
                    typeof row.thumb === 'string' && row.thumb !== '' ? row.thumb : null
                  const showThumb = thumb !== null && !failedThumbs.has(thumb)
                  return (
                    <button
                      key={row.key}
                      type="button"
                      id={optionId(index)}
                      className="hsc-item"
                      role="option"
                      aria-selected={selected}
                      data-selected={selected ? 'true' : 'false'}
                      data-thumb={thumb !== null ? 'true' : 'false'}
                      tabIndex={-1}
                      onPointerEnter={() => setActive(index)}
                      onClick={() => activateRow(row)}
                    >
                      {thumb !== null ? (
                        /* 空底留在槽上（--bg-elevated + 6px 圆角），所以加载失败
                         * 也不会露出破图框；成功时 <img> 用 cover 铺满它。 */
                        <span className="hsc-thumb" aria-hidden="true">
                          {showThumb ? (
                            <img
                              className="hsc-thumb-img"
                              src={thumb}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              draggable={false}
                              onError={() => markThumbFailed(thumb)}
                            />
                          ) : null}
                        </span>
                      ) : null}
                      <span className="hsc-item-label">{row.label}</span>
                      {row.meta ? <span className="hsc-item-meta">{row.meta}</span> : null}
                      {row.shortcut ? (
                        <span className="hsc-item-shortcut">{row.shortcut}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
