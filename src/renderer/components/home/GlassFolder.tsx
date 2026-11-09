/**
 * 首页封面页 · 磨砂玻璃文件夹（Glass Folder）+ 3 张叠在夹内的缩略图卡。
 *
 * 本组件是 `E:/workbuddy/2026-08-04-22-21-44/glass-folder-cards-clone.html`
 * （21st.dev @kedhareswer · glass-folder-cards 的活 DOM 实测复刻）的**原样搬入**，
 * 不是"照感觉再画一个"。几何、层级、三态变量、错峰延迟全部来自那份参考；
 * 与参考不同的只有下面六处（均在 glass-folder.css 里另有说明）：
 *
 *  1. 名称 + 数量压在文件夹**内部左下角**（"My Files / 3 items" 那种排版）。
 *     文字**不参与缩放**：整组已缩到 0.307 倍，12px × 0.307 只剩 4px，读不清。
 *  2. **没有描边**：参考件本来就没有 stroke，形状全靠 clip-path + 玻璃 tint 的
 *     明暗差。旧版那两条 SVG path 描边已删除；外轮廓阴影由 `.gf-back` 上的
 *     `filter: drop-shadow()` 承担（**唯一正确写法**：box-shadow 会被同一元素的
 *     clip-path 一起裁掉，不要"优化"回去）。
 *  3. 卡片内容是**真缩略图**（`<img>`），不是参考里的程序化艺术渐变；背板上那层
 *     参考用 canvas 艺术画撑画面，这里换成 `thumbs[0]` 的真封面。
 *  4. 交互语义（用户口径）：**单击 = 只播翻开动画，双击 = 进入该分类**。
 *     原话「我双击才会进入素材库，如果单击的话，只给我文件夹的一个动画就可以了」。
 *     为什么要这样：首页 5 个文件夹是"选一格"的位置，单击就跳转属于误触即
 *     被拽进分类（用户此前明确抱怨过）；单击先给一次翻开的视觉反馈、看清是哪个
 *     分类，双击才是"确认进入"。键盘 **Enter 等价双击**（直接进入），**Space**
 *     走 `<button>` 原生 click，等价于单击（只播动画）。
 *     ★ 双击 / Enter 时**先把根节点矩形与背板缩略图量好**再调 `onOpen(payload)`：
 *       本组件那一刻起就可能被卸载，父级的「卡片长成全屏 → 淡出 → 露出库」过场
 *       （`HomeOutro`）只能靠这份快照接着播（见 `GlassFolderOpenPayload`）。
 *  5. 静止态 `--gf-lift` 从参考的 `42px`（卡片全塞进口袋）改成 `-44px`，
 *     让卡片不被 hover 也探出 22px —— 首页 5 个分类入口不能是 5 张白纸。
 *     动效其余数值（hover / open）与参考一致。
 *  6. 展开态**必定**自己收回：单击后的 `AUTO_COLLAPSE_MS`（900ms）自动收回是
 *     **主路径**（不再是"跳转没生效"的保险丝）；另外二次点击 / 点组件外面 /
 *     Esc / 双击跳转之前都会先 `collapse()`。参考件把 `data-open` 当"展示态"
 *     （点了就一直开着），我们只把它当单击的一次性反馈，绝不允许它停在那儿。
 *
 * 结构（与参考一致的层级，`clip-path` 一体成形，没有"齿"，没有描边）：
 *
 *   button.gf-root                      ← 键盘可达：onClick=单击动效 / onDoubleClick=进入 /
 *                                         Enter=进入 / Space 原生 click=单击动效
 *     div.gf-stage                      ← transform: scale(--gf-scale)，几何恒为 340×272
 *       div.gf-tilt                     ← 指针倾斜 perspective(1400px) rotateX/rotateY
 *         div.gf-shadow
 *         div.gf-back[clip-path=BACK_PATH]
 *           img.gf-art                  ← thumbs[0]；null / 空串 / 加载失败 → 整层不渲染
 *           div.gf-back-sheen           ← 顶部薄高光，压在艺术图之上
 *         div.gf-files                  ← 3 × div.gf-sheet（槽位 / 深度 / 抖动走 CSS 变量）
 *         div.gf-front[clip-path=FRONT_PATH]
 *           div.gf-tint / div.gf-spec   ← 磨砂玻璃层（没有描边）
 *     div.gf-label                      ← 名称 + 数量，绝对定位压在前翻盖左下角
 *
 * 纪律：只依赖 react 与 ./glass-folder.css；零新增依赖；不用 Math.random()（每次
 * 渲染都会重新洗牌），抖动是写死的确定性常量。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import './glass-folder.css'

/**
 * 背板轮廓：viewBox 0 0 340 272。
 *
 * 上沿是「左低右高」的 S 形斜切（`C170 34 172 0 198 0`）——文件夹形状全靠这一刀，
 * 不是圆角矩形 + 耳朵。字符串**只**供给 `style.clipPath`（描边已按设计稿删除），
 * 是本组件里这个形状的唯一来源，改动即改形状。
 */
const BACK_PATH =
  'M0 56A22 22 0 0 1 22 34L146 34C170 34 172 0 198 0L318 0A22 22 0 0 1 340 22L340 250A22 22 0 0 1 318 272L22 272A22 22 0 0 1 0 250Z'

/** 前翻盖轮廓：viewBox 0 0 340 198（上沿同一套 S 形斜切，位置下移 32px）。只供给 clipPath。 */
const FRONT_PATH =
  'M0 22A22 22 0 0 1 22 0L118 0C144 0 146 32 172 32L318 32A22 22 0 0 1 340 54L340 176A22 22 0 0 1 318 198L22 198A22 22 0 0 1 0 176Z'

/** 缩略图卡的固定张数：恒为 3（少一张扇形会断档，thumbs[i] 为空也要渲染空卡）。 */
const CARD_COUNT = 3

/**
 * 三张卡的确定性抖动（参考件用 seed 伪随机，取值范围 jx ±4.5px / jr ±1.6deg）。
 *
 * 为什么不在这里算伪随机：`Math.random()` 会在每次渲染重新洗牌，
 * 用 seed 又要多带一份 rng 实现。直接写成常量表最稳，也最好读。
 */
const SHEET_JITTER: ReadonlyArray<{ jx: number; jr: number }> = [
  { jx: -3.2, jr: -1.1 },
  { jx: 1.4, jr: 0.6 },
  { jx: 2.8, jr: -0.9 }
]

/** 入场逐张错峰的基准步长（ms），与 `--gf-enter-delay` 相乘。 */
const ENTRANCE_STEP_MS = 60

/**
 * 单击后展开态自己收回的时间（ms）——**主路径**，不是兜底保险丝。
 *
 * 手势是"单击 = 只播动画"，所以这里没有"180ms 后跳转顺带卸载"那条旧路径，
 * 展开态必须自己结束。900ms 的取值：翻开过渡本身约 0.42s（见 CSS 的
 * `--gf-transition`），展开态（翻盖 `-24deg` / 卡片 `lift -96px spread 40px fan 5deg`）
 * 停 ~0.48s 足够看清是哪个分类；再长就"像卡住了"（用户对上一版展开态停住
 * 的原话是「单击以后并不能缩回，就只能一直展开」）。
 */
const AUTO_COLLAPSE_MS = 900

/**
 * 双击 / 键盘 Enter 时交给父级的「过场素材」。
 *
 * 为什么要把坐标交给父级：跳转之后本组件立刻被卸载，动画只能由父级在**另一个**
 * 组件（`HomeOutro`）里接着播，所以起点必须在卸载前一次性量好、传出去。
 * `rect` 是根节点（`<button>`）在视口里的矩形，即"卡片长成全屏"的起点。
 */
export interface GlassFolderOpenPayload {
  /** 文件夹根节点在视口里的矩形（长动画的起点） */
  rect: { left: number; top: number; width: number; height: number }
  /** 背板那张真缩略图（可能为 null：空分类 / 无图 / 加载失败） */
  thumb: string | null
}

/**
 * 双击后的**退场几何**：让这个文件夹本体飞到屏幕正中，再从中心挖洞化开。
 *
 * 为什么由父级（`HomeCover`）算而不是组件自己算：起点矩形、视口中心、以及
 * "什么时候开始消隐"这三个量都只有父级知道（它掌握整条过场时间轴）；组件只负责
 * "按给到的数把自己摆到那儿"。时间轴**只有一个主人**，不在这里起任何时钟。
 */
export interface GlassFolderExit {
  /** 水平位移（px，屏幕坐标）：本文件夹中心 → 视口中心的横向差 */
  dx: number
  /** 垂直位移（px，屏幕坐标）：本文件夹中心 → 视口中心的纵向差 */
  dy: number
  /** 放大倍率（1 = 原尺寸）。1.5 时 104×84 的文件夹在屏幕上约 156×126 */
  scale: number
}

/** 组件 props（签名由产品/架构侧定死；`exit` 是 2026-11 过场改版新增的可选项）。 */
export interface GlassFolderProps {
  /** 分类名，显示在文件夹内部左下角。 */
  label: string
  /** 该分类下的素材数量；为 0 时三张卡全部走纯色底。 */
  count: number
  /** 3 张缩略图 URL，长度恒为 3，元素可能为 null。 */
  thumbs: Array<string | null>
  /**
   * **双击 / 键盘 Enter** 后的跳转动作，由父级提供（单击**不会**调它）。
   *
   * 形参是过场素材（起点矩形 + 背板缩略图）：父级拿它算退场几何（飞到屏幕正中），
   * 替代"一帧之内整块封面被网格替换"的生硬切换。
   */
  onOpen: (payload: GlassFolderOpenPayload) => void
  /** 同一行内的序号（0..4），用于入场逐张错峰。 */
  index: number
  /**
   * 双击后的退场几何；`undefined` / `null` = 不进入退场态（正常静态卡片）。
   *
   * 非空时根节点打上 `data-leaving="self"` 并把三个量内联成 CSS 变量，几何与消隐
   * 全部在 `glass-folder.css` 的「退场」那一节。**组件自己不起任何时钟，也不写
   * 逐帧变量**：飞是 CSS transition，消隐是 CSS `@keyframes`（高斯模糊晕开）。
   */
  exit?: GlassFolderExit | null
}


/**
 * 监听 `prefers-reduced-motion` 的局部实现（不单独开 hooks 文件）。
 *
 * @returns 当前是否要求「减少动效」
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  return reduced
}

/**
 * 单张缩略图卡。
 *
 * 槽位公式照抄参考件：`slot = i/(n-1)*2-1`（i=0,1,2 → -1, 0, 1）、
 * `depth = n-1-i`（→ 2, 1, 0）。几何（272×184 @ 34,96）与状态变量全在 CSS 里。
 *
 * @param props.url 缩略图 URL，`null` 表示这个槽没有图（不足 3 张 / count 为 0）
 * @param props.index 0..2，决定槽位、深度、抖动与 z-index
 * @returns 一张卡片；无图时是纯色底，不留破图框
 */
function ThumbSheet({ url, index }: { url: string | null; index: number }): ReactElement {
  // 记「哪一条 URL 加载失败」而不是记 boolean：props 换 URL（比如重新抓封面）后
  // 无需 effect 复位，天然不会串味。
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  const jitter = SHEET_JITTER[index] ?? { jx: 0, jr: 0 }
  const slot = CARD_COUNT <= 1 ? 0 : (index / (CARD_COUNT - 1)) * 2 - 1
  const depth = CARD_COUNT - 1 - index

  const sheetStyle = {
    '--gf-slot': slot,
    '--gf-depth': depth,
    '--gf-jx': `${jitter.jx}px`,
    '--gf-jr': `${jitter.jr}deg`,
    zIndex: index + 1
  } as CSSProperties

  // 收窄成 string | null：布尔变量没法让 TS 对 url 做类型收窄，这里直接算地址
  const imageUrl: string | null = url !== null && failedUrl !== url ? url : null

  return (
    <div className="gf-sheet" style={sheetStyle} aria-hidden="true">
      {imageUrl !== null ? (
        <img
          className="gf-sheet-img"
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <div className="gf-sheet-ph" />
      )}
    </div>
  )
}

/**
 * 磨砂玻璃文件夹（首页封面页的分类入口）。
 *
 * @param props 见 {@link GlassFolderProps}
 * @returns 340×272 的玻璃文件夹（等比缩放到窗口）+ 3 张夹内缩略图卡 + 内部左下角名称
 */
export function GlassFolder({
  label,
  count,
  thumbs,
  onOpen,
  index,
  exit = null
}: GlassFolderProps): ReactElement {
  const reducedMotion: boolean = usePrefersReducedMotion()

  /** 单击后的"翻开"态：单击 → 置 true 播翻开动画，`AUTO_COLLAPSE_MS` 到点自己收回；
      双击 / Enter 直接 `onOpen(payload)`（跳转前先 `collapse()`，别留定时器改状态） */
  const [opening, setOpening] = useState<boolean>(false)
  /** 入场组装：首帧 false → 挂载后一帧置 true，CSS 才播得出来 */
  const [entered, setEntered] = useState<boolean>(false)
  /** 背板图的"加载失败"与"已就绪"各记 URL（不是 boolean，换 URL 后天然不复位串味） */
  const [artFailedUrl, setArtFailedUrl] = useState<string | null>(null)
  const [artReadyUrl, setArtReadyUrl] = useState<string | null>(null)

  const rootRef = useRef<HTMLButtonElement | null>(null)
  /** 自动收回定时器（`AUTO_COLLAPSE_MS`）：**必须**在卸载时清掉，
      否则到点会对已卸载组件 `setOpening(false)` */
  const collapseTimerRef = useRef<number | null>(null)
  /** 指针倾斜的值先攒在 ref 里，由 rAF 统一写 CSS 变量（不进 state，避免每帧重渲染） */
  const tiltRef = useRef<{ tx: number; ty: number }>({ tx: 0, ty: 0 })
  const rafRef = useRef<number | null>(null)

  /** 卸载清理：定时器 + 未执行的 rAF，一个都不许漏
      （漏 `collapseTimer` 是真实 bug 形态：到点对已卸载组件 setState） */
  useEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current)
        collapseTimerRef.current = null
      }
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  /** 入场：挂载后下一帧再置位，否则首帧样式与目标样式相同 → 不播过渡 */
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  /* ── 派生数据：卡片槽位 + 背板图 ────────────────────────────────────────
   * 原来这段摆在渲染前最后一段；为了让 `handleDoubleClick` / Enter 能把
   * 「背板那张真缩略图」跟起点矩形一起交给父级播过渡动画，挪到所有回调之前。
   * 纯 props / state 派生，不含 hook，挪位置不影响任何时序。
   */

  // count === 0：形态照旧完整，3 张卡全部走纯色底（不是禁用态、不加锁图标）
  const isEmpty: boolean = count === 0
  const sheetUrls: Array<string | null> = []
  for (let i = 0; i < CARD_COUNT; i += 1) {
    sheetUrls.push(isEmpty ? null : thumbs[i] ?? null)
  }

  /**
   * 背板上的那张"艺术图"（参考件是 canvas 艺术画，我们换成 thumbs[0] 真封面）。
   *
   * 为什么需要它：卡片静止态只在口袋上沿探出 22px，磨砂玻璃后面如果是空的，
   * 整张文件夹就读成一张白纸。参考件靠背板艺术图撑住画面，我们靠真缩略图。
   *
   * 退化路径与卡片一致：`count === 0`、`thumbs[0]` 为 null/空串、加载失败
   * → **整层不渲染**，退回纯净的半透明底色，绝不留破图层。
   */
  const firstThumb: string | null = isEmpty ? null : thumbs[0] ?? null
  const backArtUrl: string | null =
    firstThumb !== null && firstThumb.length > 0 && artFailedUrl !== firstThumb ? firstThumb : null

  /**
   * 量一次根节点矩形，打包成父级要的过场素材。
   *
   * ⚠️ 必须在 `onOpen()` **之前**调用：父级一收到 `onOpen` 就切视图，本组件随即可
   * 被卸载（`rootRef.current` 变 null），那之后再量就只剩 0×0。事件只可能来自本节点，
   * 所以"取不到节点"理论上不会发生；真发生就退化成 0×0（过场从视口左上角的一粒
   * 淡入整屏，不报错、不阻塞跳转）。
   */
  const readOpenPayload = useCallback((): GlassFolderOpenPayload => {
    const element = rootRef.current
    if (element === null) {
      return { rect: { left: 0, top: 0, width: 0, height: 0 }, thumb: backArtUrl }
    }
    const rect = element.getBoundingClientRect()
    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      thumb: backArtUrl
    }
  }, [backArtUrl])

  const clearCollapseTimer = useCallback((): void => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }
  }, [])

  /**
   * 收回展开态（不跳转）：清掉自动收回定时器 → 翻盖回到静止态。
   *
   * 所有"结束展开态"的路径共用这一份，避免各处漏清定时器：
   *   1. 双击 / Enter 跳转之前（先把定时器掐掉，否则跳转后它还会改状态）
   *   2. 展开态下再点一次（二次点击 = 收起）
   *   3. 点组件外面（等于取消这次反馈）
   *   4. Esc
   */
  const collapse = useCallback((): void => {
    clearCollapseTimer()
    setOpening(false)
  }, [clearCollapseTimer])

  /**
   * 单击：**只播翻开动画，不跳转**（用户口径，见文件头第 4 条）。
   *
   * 流程：已经展开 → 收起（二次点击的出口）；否则置 `data-open` 播动画，
   * 并挂 `AUTO_COLLAPSE_MS` 自动收回 —— 到点自己合回去，不留永久展开态。
   * 跳转**不在这里**：走 {@link handleDoubleClick} / Enter。
   */
  const handleActivate = useCallback((): void => {
    // 已经展开了还点 → 收回（双击的第二下会走到这里，随后 dblclick 再 onOpen，
    // 这是有意为之：跳转前先回静止态，避免"带着展开态被卸载"）
    if (opening) {
      collapse()
      return
    }
    // 减少动效：单击不播动画也就没有"看动画"这回事，直接什么都不做
    // （双击 / Enter 仍然进入分类，见 handleDoubleClick / handleKeyDown）
    if (reducedMotion) {
      return
    }
    clearCollapseTimer()
    setOpening(true)
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null
      setOpening(false)
    }, AUTO_COLLAPSE_MS)
  }, [clearCollapseTimer, collapse, opening, reducedMotion])

  /**
   * 双击：进入该分类（并交出过场素材）。
   *
   * 顺序固定：**先量矩形** → `collapse()` → `onOpen(payload)`。
   * 量矩形必须在最前（一收到 `onOpen` 父级就切视图，DOM 就没了）；
   * `collapse()` 清掉自动收回定时器（否则跳转之后它还会对已卸载组件 setState），
   * 并让翻盖回静止态。
   * 不延迟：双击这一刻用户已经确认了目标，第一下单击也早已把翻盖翻开，
   * 接下来由父级的过场动画接手（卡片长成全屏 → 淡出 → 露出库）。
   */
  const handleDoubleClick = useCallback((): void => {
    const payload = readOpenPayload()
    collapse()
    onOpen(payload)
  }, [collapse, onOpen, readOpenPayload])

  /**
   * 展开态下点组件外面 → 收起。
   *
   * 用捕获阶段的 `pointerdown`（不是 click）：用户按下外部时就要立刻有反应，
   * 不必等他松手；捕获阶段还能抢在选中 / 拖拽等既有处理之前。
   * 触发"展开"的那一次 pointerdown 早于本 effect 挂载，所以不会自己把自己关掉。
   * `opening` 变 false 时 effect cleanup 自动摘监听，不常驻 document。
   */
  useEffect(() => {
    if (!opening) return
    const handleDocumentPointerDown = (event: PointerEvent): void => {
      const element = rootRef.current
      // target 不是 Node（合成事件 / 已被移除的节点）一律当"外面"
      if (element !== null && event.target instanceof Node && element.contains(event.target)) {
        return
      }
      collapse()
    }
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  }, [collapse, opening])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      // Esc：回到静止态（不跳转）
      if (event.key === 'Escape') {
        event.stopPropagation()
        collapse()
        return
      }
      // Enter：等价于双击 → 进入分类（同样先量矩形再跳，理由见 handleDoubleClick）。
      // 必须 preventDefault：`<button>` 对 Enter 原生也会派发一次 click，
      // 不拦住就会先跑 handleActivate（多一次无谓的展开态）再进分类。
      if (event.key === 'Enter') {
        event.preventDefault()
        const payload = readOpenPayload()
        collapse()
        onOpen(payload)
        return
      }
      // Space 故意**不处理**：`<button>` 原生派发 click → handleActivate，
      // 即"单击"语义（只播翻开动画）。这是可接受的取舍 —— 键盘用户要进入分类
      // 有 Enter 这条明确路径，Space 保持"浏览器原生按钮"的感觉不另造语义。
    },
    [collapse, onOpen, readOpenPayload]
  )

  /** rAF 里唯一一次写 CSS 变量的地方 */
  const writeTilt = useCallback((): void => {
    rafRef.current = null
    const element = rootRef.current
    if (element === null) return
    element.style.setProperty('--gf-px', tiltRef.current.tx.toFixed(3))
    element.style.setProperty('--gf-py', tiltRef.current.ty.toFixed(3))
  }, [])

  const scheduleTiltWrite = useCallback((): void => {
    if (rafRef.current === null) {
      rafRef.current = window.requestAnimationFrame(writeTilt)
    }
  }, [writeTilt])

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      // 触屏没有"指针位置"这回事：跟随手指只会让整块抖
      if (event.pointerType === 'touch') return
      const element = rootRef.current
      if (element === null) return
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      tiltRef.current = {
        tx: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        ty: ((event.clientY - rect.top) / rect.height) * 2 - 1
      }
      scheduleTiltWrite()
    },
    [scheduleTiltWrite]
  )

  const handlePointerLeave = useCallback((): void => {
    tiltRef.current = { tx: 0, ty: 0 }
    scheduleTiltWrite()
  }, [scheduleTiltWrite])

  /** 入场错峰：保证是非负整数，脏数据不至于写出非法 CSS 值 */
  const safeIndex: number = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0

  /** 是否处于退场态（父级给了几何）。`exit` 默认 null，所以静态卡片永远走不到这些变量。 */
  const leaving: boolean = exit !== null

  /**
   * 根节点的内联 CSS 变量。
   *
   * · `--gf-enter-delay`：入场逐张错峰（原有）。
   * · `--gf-exit-x / -y / -s`：退场飞向屏幕正中的位移与倍率。不处于退场态时写成
   *   0 / 0 / 1（恒等值）——比"条件性不写"更好读，也不会因为 `undefined` 让
   *   React 在 style 上留空洞。
   *
   * 就这三个。消隐**不需要**任何变量：`filter: blur` 与 `opacity` 的终点写死在
   * `@keyframes gf-folder-dissolve` 里，组件只负责"给不给几何"。
   */
  const rootStyle = {
    '--gf-enter-delay': `${safeIndex * ENTRANCE_STEP_MS}ms`,
    '--gf-exit-x': `${exit?.dx ?? 0}px`,
    '--gf-exit-y': `${exit?.dy ?? 0}px`,
    '--gf-exit-s': `${exit?.scale ?? 1}`
  } as CSSProperties

  /** 两条 clip-path 内联写入：BACK_PATH / FRONT_PATH 是这个形状的唯一来源 */
  const backClip: CSSProperties = { clipPath: `path('${BACK_PATH}')` }
  const frontClip: CSSProperties = { clipPath: `path('${FRONT_PATH}')` }

  /**
   * 退场态用 `data-leaving="self"` 标记。三个取值各有明确含义，别混用：
   * · `'self'`  = 这个文件夹**本体**正在飞向屏幕正中（父级给了 `exit` 几何）；
   * · `'false'` = 静止卡片。
   * 父级 `HomeCover` 的根节点上也有一个 `data-leaving`（`'true'` 表示"整页正在退场"），
   * 那是**不同元素上的不同协议**，同名只是巧合 —— `glass-folder.css` 只认 `'self'`。
   */
  return (
    <button
      ref={rootRef}
      type="button"
      className="gf-root"
      data-entered={entered ? 'true' : 'false'}
      data-open={opening ? 'true' : 'false'}
      data-empty={isEmpty ? 'true' : 'false'}
      data-leaving={leaving ? 'self' : 'false'}
      aria-label={`${label}，${count} 个素材，双击进入`}
      title="双击进入 · 单击预览"
      style={rootStyle}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onClick={handleActivate}
      onDoubleClick={handleDoubleClick}
    >
      <div className="gf-stage">
        <div className="gf-tilt">
          {/* 地面投影 */}
          <div className="gf-shadow" aria-hidden="true" />

          {/* 背板：clip-path 一体成形（无描边）。内部是艺术图 + 顶部高光 */}
          <div className="gf-back" style={backClip} aria-hidden="true">
            {backArtUrl !== null ? (
              <img
                className="gf-art"
                src={backArtUrl}
                alt=""
                decoding="async"
                draggable={false}
                data-ready={artReadyUrl === backArtUrl ? 'true' : 'false'}
                onLoad={() => setArtReadyUrl(backArtUrl)}
                onError={() => setArtFailedUrl(backArtUrl)}
              />
            ) : null}
            <div className="gf-back-sheen" />
          </div>

          {/* 3 张底部锚定的缩略图卡（槽位 / 深度 / 抖动全部来自 CSS 变量） */}
          <div className="gf-files" aria-hidden="true">
            {sheetUrls.map((url, sheetIndex) => (
              <ThumbSheet key={`gf-sheet-${sheetIndex}`} url={url} index={sheetIndex} />
            ))}
          </div>

          {/* 前翻盖（磨砂玻璃）：tint + spec，同样没有描边 */}
          <div className="gf-front" style={frontClip} aria-hidden="true">
            <div className="gf-tint" />
            <div className="gf-spec" />
          </div>
        </div>
      </div>

      {/* 名称 + 数量：压在文件夹**内部**左下角，左右/下边距按 --gf-scale 换算，
          文字本身不参与缩放（否则 0.307 倍下 12px 会变成 4px） */}
      <div className="gf-label">
        <span className="gf-name">{label}</span>
        <span className="gf-count">{count} 个素材</span>
      </div>
    </button>
  )
}

export default GlassFolder
