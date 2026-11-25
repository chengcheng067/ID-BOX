/**
 * 首页封面页 · 磨砂玻璃文件夹（Glass Folder）+ 3 张叠在夹内的缩略图卡。
 *
 * 本组件是 `E:/workbuddy/2026-08-04-22-21-44/glass-folder-cards-clone.html`
 * （21st.dev @kedhareswer · glass-folder-cards 的活 DOM 实测复刻）的**原样搬入**，
 * 不是"照感觉再画一个"。几何、层级、四态变量、错峰延迟全部来自那份参考；
 * 与参考不同的只有下面五处（均在 glass-folder.css 里另有说明）：
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
 *  5. **收起的时序比参考多一档**（2026-11-25 用户逐字要求：「鼠标点击其他位置，
 *     这3张卡片会先收回到上一个动画，再过一段时间，才会完全不显示3张卡片」）：
 *     参考件只有"hover 档 / open 档"两档 CSS 变量、靠指针离开自然回落；我们的
 *     桌面卡在被点外面时指针已不在卡上，回落会一步到底。所以关合拆成两段——
 *     `data-open` 摘掉后先落到 **hover 档**（`data-closing`，保持 `CLOSE_HOLD_MS`），
 *     时间到才摘 `data-closing` 落到 idle 档。展开态**不再自动收回**（参考件也是
 *     点了才开、再点/点外面才收），只有二次点击 / 点组件外面 / Esc / 双击跳转
 *     之前才 `collapse()`。
 *
 * 玻璃的成因（2026-11-25 第五次返工，取证见 design-tmp/frost-check/）：
 * `.gf-front` **不再用 `backdrop-filter`**。它在"父级 scale(0.443) + 自身
 * perspective"的合成层里会让滤镜结果在 clip 边缘以**未上 tint 的形态**漏出 1 个
 * 设备像素——即用户反复说的"底下一圈发白的光"（实测：底边外 0.4px 处亮度
 * 74/255，同位置背景 43、无 backdrop-filter 时 23）。磨砂改由 `.gf-frost`
 * （壁纸/封面自体模糊烤成的位图，压在前板 tint 之下）确定承担，与底纹卡原有
 * 做法同一条路；无背板图（空分类 / 无底纹钉选卡）就只留 tint，没有可模糊的内容。
 * 「新建项目」虚卡也不再用 backdrop-filter：它除了漏边，还会在 Chromium 130 的
 * 真实窗口合成里把 path() 的 A 圆弧拍平（见 BACK_PATH 注释），已一并移除。
 *
 * 结构（与参考一致的层级，`clip-path` 一体成形，没有"齿"，没有描边）：
 *
 *   button.gf-root                      ← 键盘可达：onClick=单击动效 / onDoubleClick=进入 /
 *                                         Enter=进入 / Space 原生 click=单击动效
 *     div.gf-stage                      ← transform: scale(--gf-scale)，几何恒为 340×272
 *       div.gf-tilt                     ← 指针倾斜 perspective(1400px) rotateX/rotateY
 *         div.gf-shadow
 *         div.gf-back[clip-path=BACK_PATH]
 *           img.gf-art                  ← 背板图（底纹优先，回落 thumbs[0]）；失败整层不渲染
 *           div.gf-back-sheen           ← 顶部薄高光，压在艺术图之上
 *         div.gf-frost[clip-path=FRONT_PATH] ← 前板区域的磨砂位图（同图 blur 烤进像素）
 *         div.gf-files                  ← 3 × div.gf-sheet（槽位 / 深度 / 抖动走 CSS 变量）
 *         div.gf-front[clip-path=FRONT_PATH]
 *           div.gf-tint / div.gf-spec   ← 磨砂玻璃层（没有描边、没有 backdrop-filter）
 *     div.gf-label                      ← 名称 + 数量，绝对定位压在前翻盖左下角
 *
 * ⚠️ DOM 顺序是 back → frost → files → front，但 `.gf-frost` 的 `z-index: 6`
 *    把它提到 `.gf-files`(5) 之上：沉到前板上沿以下的夹内卡片被这层不透明磨砂
 *    整片盖住（= 参考稿"卡片被玻璃糊掉"的观感），露在袋口以上的部分在本层 clip
 *    之外、照常可见。
 *
 * 纪律：只依赖 react、./glass-folder.css 与 `logic/wallpaperTone` /
 * `logic/folderWallpaperScrim`（底纹取样与罩层纯函数）；零新增 UI 依赖；不用
 * Math.random()（每次渲染都会重新洗牌），抖动是写死的确定性常量。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import './glass-folder.css'
// 自定义底纹的明暗取样（与 HomeCover 全局壁纸同一套判定，32×32 离屏 canvas）
import {
  WALLPAPER_TONE_SAMPLE,
  wallpaperToneFromImageData,
  type WallpaperTone
} from '../../logic/wallpaperTone'
// 底纹模式的罩层/tint 颜色计算（纯函数，单测见 tests/folderWallpaperScrim.test.ts）
import { scrimToneForWallpaper, wallFrontTint } from '../../logic/folderWallpaperScrim'

/**
 * 背板轮廓：viewBox 0 0 340 272。
 *
 * 上沿是「左低右高」的 S 形斜切（`C170 34 172 0 198 0`）——文件夹形状全靠这一刀，
 * 不是圆角矩形 + 耳朵。字符串**只**供给 `style.clipPath`（描边已按设计稿删除），
 * 是本组件里这个形状的唯一来源，改动即改形状。
 *
 * ⚠️ 2026-11-25：参考稿的 `A22 22 …` 圆弧全部改写成**三次贝塞尔**（22px 四分之一圆，
 * 控制柄 k = 22×0.55228475 ≈ 12.15）。原因：Chromium 130（Electron 33）在
 * `clip-path: path()` + 合成层（3D transform / backdrop-filter）的场景下，**A(arc)
 * 命令在真实窗口渲染里被拍平成直线**——静止态看起来是圆角，hover/open 或用户肉眼看
 * 到的是四个直角、且前板比背板更宽（真机截图见 design-tmp/frost-check/real-third-hover*）。
 * C 曲线走的是普通的路径栅格化路径，不受该缺陷影响；两个路径的形状差 < 0.03%。
 */
const BACK_PATH =
  'M0 56C0 43.85 9.85 34 22 34L146 34C170 34 172 0 198 0L318 0C330.15 0 340 9.85 340 22L340 250C340 262.15 330.15 272 318 272L22 272C9.85 272 0 262.15 0 250Z'

/** 前翻盖轮廓：viewBox 0 0 340 198（上沿同一套 S 形斜切，位置下移 32px）；四角 C 曲线同 BACK_PATH。只供给 clipPath。 */
const FRONT_PATH =
  'M0 22C0 9.85 9.85 0 22 0L118 0C144 0 146 32 172 32L318 32C330.15 32 340 41.85 340 54L340 176C340 188.15 330.15 198 318 198L22 198C9.85 198 0 188.15 0 176Z'

/**
 * 前板的**裁切**轮廓：与 {@link FRONT_PATH} 逐点相同，**只有下沿多 1px（198 → 199）**。
 *
 * 为什么（2026-11-25 第六次返工 · 静止态取证 design-tmp/frost-check/）：
 * 静止态下，卡片底边外 1 个设备像素处会比"同一位置没有卡片"更亮 —— 成因是
 * `.gf-back`（锐利底纹）与 `.gf-front`（深色 tint）是**两个独立栅格化的合成层**，
 * 两者 clip 的 AA 行对不齐：亮层的 AA 行有一小截没被暗层盖住，就漏出一条浅色缝。
 * 上 / 左 / 右三边实测 Δ=0（没有缝，因为亮层与暗层在那三边对齐），只有底边有。
 * 让前板在底边**多盖 1px**（tint/spec 同步 `bottom: -1px`）后，亮层的 AA 行被完整的
 * 深色 tint 覆盖。实测（同一静止门禁、同刻差分、3 次中位数）：
 *   底边外 1px 的 Δ：含 backdrop-filter 的最初版 **+47** → 去掉滤镜 **+9** →
 *   再加这 1px 覆盖 **−28**（负值 = 比没有卡片时更暗，即彻底没有"发白"）；
 *   上 / 左 / 右三边始终为 0。
 * 代价是轮廓向下多 0.44 个页面像素（0.67 设备像素），肉眼不可见；换成浅色玻璃卡
 * 时这一条同为浅色，同样不可见。
 * ⚠️ 不要把它也用给 `.gf-frost`：磨砂层必须严格贴合 198 的前板形状。
 */
const FRONT_PANEL_PATH =
  'M0 22C0 9.85 9.85 0 22 0L118 0C144 0 146 32 172 32L318 32C330.15 32 340 41.85 340 54L340 177C340 189.15 330.15 199 318 199L22 199C9.85 199 0 189.15 0 177Z'

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
 * 磨砂层（`.gf-frost`）的画布参数。
 *
 * ★ 2026-11-25 第二次根治（第一次是 CSS `filter: blur()`，用户实测仍漏底：
 *   「动画刚结束那一瞬间是不漏的，静态化的那一个是错的」——即 blur 只在卡片被
 *   提升为合成层的那几帧生效，落回静态合成层后滤镜被丢弃，贴图恢复清晰）。
 *   结论：**任何"活滤镜"（backdrop-filter / filter）在这条 DOM 链上都不可靠**，
 *   必须把磨砂烤成**位图**——canvas 2D `ctx.filter` 只在绘制那一刻生效，画完
 *   就是一张普通位图，之后无论怎么合成都不会丢。
 *
 * ★ 2026-11-25 第三次（本轮）：这层从"仅底纹卡"扩到**所有有背板图的卡**
 *   （底纹优先，回落 thumbs[0]）—— 因为 `.gf-front` 的 backdrop-filter 已被
 *   整体移除（它会在 clip 边缘漏出 1px 未上 tint 的亮线，见文件头）。玻璃下面
 *   "被模糊的背板"从此由这层位图确定承担，视觉与参考稿的 backdrop-filter 等价。
 *
 * 坐标系：画布 CSS 尺寸恒为 364×296（与 `.gf-art` 同几何，位置由 CSS 给），
 * 备份存储按 FROST_RENDER_SCALE 倍放大，保证 `--gf-scale` 0.474 × DPR 3 下仍清晰。
 * FROST_OVERSCAN：模糊会把边缘晕开成透明，先在画布内把图画大一圈再模糊，四边
 * 才有实像素可采（与 CSS 的 `scale(1.173)` 叠加后仍盖满）。
 */
const FROST_W = 364
const FROST_H = 296
const FROST_RENDER_SCALE = 2
const FROST_BLUR_PX = 20
const FROST_SATURATE = 1.3
const FROST_OVERSCAN = 1.15

/**
 * 关合时"回到 hover 档"的停留时长（ms）——用户逐字要求的两阶段收起：
 *
 *   「鼠标点击其他位置，这3张卡片会先收回到上一个动画，再过一段时间，才会完全
 *     不显示3张卡片，只显示文件夹。」
 *
 * 参考件的两档（hover / open）靠指针离开自然回落，没有第三档；我们的点击发生在
 * 卡片之外，一步回落会直接掉到 idle。所以摘掉 `data-open` 后先挂 `data-closing`
 * 停在 hover 档，停留这个时长再摘掉落到 idle。
 *
 * 取值：卡片回落本身是 `transform .75s var(--gf-spring)` + 逐张 `depth*40ms` 错峰
 * （最深一张 delay 80ms），78ms 余量后正好落定 → 780ms。停留期内用户能明确看到
 * "卡片还在、但已经收回一档"，再开始第二次下沉，两段不会糊成一段。
 */
const CLOSE_HOLD_MS = 780

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
  /**
   * **钉选变体**（docs/60 §6.1，T-05 F-1）：首页快速访问的磁盘文件夹卡。
   *
   * 与素材大类卡同排、同一套玻璃质感，差异只有三处视觉语义：
   *   ① 右上角「钉选」小角标（一眼可分，布局不变）；
   *   ② 数量行不显示素材计数，改显示「外部」标识（钉的是磁盘目录，不是素材大类）；
   *   ③ 夹内三张缩略图卡全部走空槽（钉选目录的素材缩略图不在库索引里，没有图可放；
   *      底纹可由用户自定义 —— 见 `wallpaperUrl`）。
   *
   * 交互口径与大类卡一致：单击 = 翻开动画，**双击 / Enter = 打开**（主进程
   * `home:pinnedOpen`，`onOpen` 由父级接 id）。钉选卡不参与大类切换的退场过场
   * （父级不会给钉选卡传 `exit`）。
   */
  pinned?: boolean
  /**
   * 底纹 URL（T-05 F-3，`bg://<fileName>`，由父级按 `homeFolderWallpaper[key]` 派生）。
   * 非空时**替换**背板图（`thumbs[0]` 那层）；`null` / `undefined` = 未命中映射 → 现状默认底图。
   * 加载失败自动整层不渲染（与缩略图同一退化路径，绝不留破图层）。
   */
  wallpaperUrl?: string | null
  /**
   * 右键（F-1 排序 / F-3 底纹菜单，菜单本体由父级渲染，组件只透传事件）。
   * 不传 = 无右键行为。**不 preventDefault**：菜单打开本身要拦默认菜单，由父级决定。
   */
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void
  /**
   * 拖动排序的**槽位键**（2026-11-25）：`kind:<key>` / `pin:<id>`，只作为
   * `data-slot-key` 落到根节点上 —— 父级 `HomeCover` 用它按指针命中的卡片认槽位
   * （pointer 事件委托在排容器上，本组件不关心拖动本身）。不传 = 不可拖（虚卡）。
   */
  slotKey?: string
  /**
   * 视觉顺序（CSS `flex order`，2026-11-25）。
   *
   * 拖动重排后卡片的**视觉位置**变、DOM 顺序不变（HomeCover 保持「大类 map 在前、
   * 钉选 map 在后」的两段渲染，守卫测试与无障碍标签都依赖这个结构），靠这个值让
   * flex 排成用户拖出来的次序。不传 = 0（默认 DOM 顺序）。
   */
  order?: number
  /**
   * 退场分半（2026-11-25 拖动排序的配套修正）：`left` / `right`，只作为
   * `data-exit-half` 落到根节点上，供 `home-outro.css` 决定"整排退场时往哪边退"。
   *
   * 为什么不能再用 CSS `nth-child` 切半：拖动排序后 DOM 顺序（大类 map → 钉选 map）
   * 与**视觉顺序**（flex `order`）不再一致，`nth-child` 会把视觉左半的卡往右赶。
   * 取值由父级按"排序后的视觉槽位下标"算（`i < ceil(n/2)` 为 left）。
   * 不传 = 不写该属性（样式里无方向的卡只淡出、不位移）。
   */
  exitHalf?: 'left' | 'right'
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
 * 对底纹图采样明暗档（复用 `logic/wallpaperTone` 的 32×32 离屏 canvas 判定）。
 *
 * 与 `HomeCover` 对全局壁纸的做法同构：换底纹即时生效（状态驱动 + 本地取样），
 * 不新增 IPC。判定失败（图挂了 / canvas 被 taint）返回 null，调用方按「亮图」
 * 回退 —— 取色失败绝不能搞挂首页卡片。
 *
 * @param url 底纹图 URL（`bg://…`）；null = 未设底纹，档位恒 null
 */
function useWallpaperTone(url: string | null): WallpaperTone | null {
  const [tone, setTone] = useState<WallpaperTone | null>(null)

  useEffect(() => {
    if (url === null || url.length === 0) {
      setTone(null)
      return
    }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = WALLPAPER_TONE_SAMPLE
        canvas.height = WALLPAPER_TONE_SAMPLE
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          if (!cancelled) setTone(null)
          return
        }
        ctx.drawImage(image, 0, 0, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE)
        const px = ctx.getImageData(0, 0, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE)
        if (!cancelled) {
          setTone(wallpaperToneFromImageData(px.data, WALLPAPER_TONE_SAMPLE, WALLPAPER_TONE_SAMPLE))
        }
      } catch {
        // canvas 被 taint / 读像素失败：回退亮图档（浅罩深字），不报错不阻塞
        if (!cancelled) setTone(null)
      }
    }
    image.onerror = () => {
      if (!cancelled) setTone(null)
    }
    image.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  return tone
}

/**
 * 磨砂位图层（`.gf-frost > canvas.gf-frost-img`）。
 *
 * 为什么是 canvas 而不是 `<img style="filter: blur(...)">`：见上方 FROST_* 常量
 * 的注释——活滤镜在静态合成层上会被丢弃（用户实测：动画结束瞬间不漏、之后漏）。
 * 这里在图片 onLoad 后用 `ctx.filter` 画一次，模糊成为**像素**，与合成层无关。
 *
 * 只画不读（不调 getImageData / toDataURL），所以 `bg://` 图是否 taint 都无所谓。
 *
 * @param props.url 背板图 URL（底纹优先，回落 thumbs[0]；与 `.gf-art` 同一张，走缓存）
 */
function FrostCanvas({ url }: { url: string }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    // 重挂载 / 换图时先清干净，避免旧图残留在新 url 加载完成之前
    canvas.width = FROST_W * FROST_RENDER_SCALE
    canvas.height = FROST_H * FROST_RENDER_SCALE

    let cancelled = false
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.save()
      // 进 CSS px 坐标系，再把备份存储按倍率放大
      ctx.scale(FROST_RENDER_SCALE, FROST_RENDER_SCALE)
      // 先画大一圈（overscan），模糊晕四周才有实像素、不会露透明边
      const w = FROST_W * FROST_OVERSCAN
      const h = FROST_H * FROST_OVERSCAN
      // 滤镜在绘制那一刻生效：blur 半径按 device px 给（× RENDER_SCALE）
      ctx.filter = `blur(${FROST_BLUR_PX * FROST_RENDER_SCALE}px) saturate(${FROST_SATURATE})`
      ctx.drawImage(image, (FROST_W - w) / 2, (FROST_H - h) / 2, w, h)
      ctx.restore()
    }
    image.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <canvas
      ref={canvasRef}
      className="gf-frost-img"
      width={FROST_W * FROST_RENDER_SCALE}
      height={FROST_H * FROST_RENDER_SCALE}
      aria-hidden="true"
    />
  )
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
  exit = null,
  pinned = false,
  wallpaperUrl = null,
  onContextMenu,
  slotKey,
  order,
  exitHalf
}: GlassFolderProps): ReactElement {
  const reducedMotion: boolean = usePrefersReducedMotion()

  /** 单击后的"翻开"态（open 档变量，见 glass-folder.css 的四态表） */
  const [opening, setOpening] = useState<boolean>(false)
  /**
   * 关合的第一段：`data-open` 已摘、但还没落到底，先把变量停在 **hover 档**。
   * `CLOSE_HOLD_MS` 后清掉才真正落到 idle（卡片彻底沉进口袋）。
   */
  const [closing, setClosing] = useState<boolean>(false)
  /** 入场组装：首帧 false → 挂载后一帧置 true，CSS 才播得出来 */
  const [entered, setEntered] = useState<boolean>(false)
  /** 背板图的"加载失败"与"已就绪"各记 URL（不是 boolean，换 URL 后天然不复位串味） */
  const [artFailedUrl, setArtFailedUrl] = useState<string | null>(null)
  const [artReadyUrl, setArtReadyUrl] = useState<string | null>(null)

  /* ── 自定义底纹模式（v1.2 反馈批 A；2026-11 按「照搬参考稿」返工）──────────
   * 用户原话：「我希望文件夹如果自定义了底纹的话，对比度可以强一些。……」
   * 2026-11 用户裁定：「我们的这个动态文件夹完全可以照搬这个源代码来做」——
   * 玻璃视觉逐值照搬权威参考稿（glass-folder-cards-clone.html）。底纹模式只做
   * 三件事：
   *   ① 前翻盖 tint 内联参考稿对应档逐值（`wallFrontTint`，纯函数出值进 rootStyle）；
   *   ② 文字色按底纹明暗切换（CSS 按 data-wtone 命中，暗图 → 深玻璃浅字）；
   *   ③ 背板图优先用底纹（回落 thumbs[0]），前板磨砂由 `.gf-frost` 位图承担
   *     （见下方渲染处与 glass-folder.css 的 `.gf-frost` 一节）。
   * 原文字区罩层（.gf-wall-scrim / wallScrimGradient）已随裁定删除：参考稿的名字
   * 直接坐在 front 玻璃上，可读性由 tint 底部 .93/.94 近实心保证。
   * 未设底纹 / 加载中 / 加载失败 → wallpaperActive = false，走主题基线玻璃。
   */
  const wallpaperCandidate: string | null =
    wallpaperUrl !== null && wallpaperUrl.length > 0 ? wallpaperUrl : null
  const wallTone: WallpaperTone | null = useWallpaperTone(wallpaperCandidate)
  const scrimTone = scrimToneForWallpaper(wallTone)
  /** 只在底纹图真正 onLoad 成功后激活：加载中/失败不留"低遮罩空卡"的中间态 */
  const wallpaperActive: boolean =
    wallpaperCandidate !== null && artReadyUrl === wallpaperCandidate && artFailedUrl !== wallpaperCandidate

  /* ── 名字折行排版（v1.2 反馈批 A 续修）────────────────────────────────────
   * 用户实证：「(2026-11) +桥上人家」折成「(2026-11) +桥上人 / 家」—— 编号和正文
   * 混在一行、第二行只剩一个字，难看。
   * 策略（先缩号、后折行，名字整串一起折，绝不把编号拆成独立行）：
   *   ① 挂载/换名后用**单行探针**量一次：探针（nowrap 镜像）宽于容器可用宽 →
   *     当前字号装不下 → `data-name-shrink` 缩一号（12→10 / 窄窗 11→9.5）；
   *   ② 缩号后仍装不下 → 才折行，`text-wrap: balance` 把两行收得均匀（消灭
   *     "第二行只剩一个字"的孤行）。缩号 + 均衡折行后仍装不下的极端长名继续
   *     向上长（标签 bottom 锚定），**不回省略号** —— 批 A 的硬要求是完整显示。
   * 探针挂在 `.gf-name` 内部（继承同一字号档位，含窄窗媒体查询），测量零偏移。 */
  const nameRef = useRef<HTMLSpanElement | null>(null)
  const nameProbeRef = useRef<HTMLSpanElement | null>(null)
  const [nameShrunk, setNameShrunk] = useState<boolean>(false)

  /** 换名字时先回到常态字号重测（否则上一个长名的缩号会黏在新名字上） */
  useEffect(() => {
    setNameShrunk(false)
  }, [label])

  useEffect(() => {
    const probe = nameProbeRef.current
    const name = nameRef.current
    if (probe === null || name === null) return
    // +0.5px 容差：亚像素取整不让刚好放得下的名字误判超长
    if (!nameShrunk && probe.offsetWidth > name.clientWidth + 0.5) {
      setNameShrunk(true)
    }
  }, [label, nameShrunk])

  const rootRef = useRef<HTMLButtonElement | null>(null)
  /** 关合第一段的停留定时器（`CLOSE_HOLD_MS`）：**必须**在卸载时清掉，
      否则到点会对已卸载组件 `setClosing(false)` */
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
  // 钉选卡：夹内没有素材缩略图（磁盘目录不在库索引里），三张槽全部走空卡
  const sheetUrls: Array<string | null> = []
  for (let i = 0; i < CARD_COUNT; i += 1) {
    sheetUrls.push(isEmpty || pinned ? null : thumbs[i] ?? null)
  }

  /**
   * 背板上的那张"艺术图"（参考件是 canvas 艺术画，我们换成 thumbs[0] 真封面）。
   *
   * 为什么需要它：卡片静止态只在口袋上沿探出 22px，磨砂玻璃后面如果是空的，
   * 整张文件夹就读成一张白纸。参考件靠背板艺术图撑住画面，我们靠真缩略图。
   *
   * 底纹（T-05 F-3）**优先于**缩略图：用户给这个文件夹设了底纹（`bg://` URL）时
   * 背板就是那张图；未设底纹回落 thumbs[0]（钉选卡没有缩略图 → 回落纯色底）。
   *
   * 退化路径与卡片一致：`count === 0`、`thumbs[0]` 为 null/空串、加载失败
   * → **整层不渲染**，退回纯净的半透明底色，绝不留破图层。
   */
  const firstThumb: string | null = isEmpty ? null : thumbs[0] ?? null
  const backArtUrl: string | null =
    wallpaperUrl !== null && wallpaperUrl.length > 0 && artFailedUrl !== wallpaperUrl
      ? wallpaperUrl
      : firstThumb !== null && firstThumb.length > 0 && artFailedUrl !== firstThumb
        ? firstThumb
        : null

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
   * 收回展开态（不跳转）：两段式，见文件头第 5 条与 `CLOSE_HOLD_MS`。
   *
   *   ① `opening=false, closing=true` → 变量落到 hover 档（卡片收一档、仍在）；
   *   ② `CLOSE_HOLD_MS` 后 `closing=false` → 落到 idle 档（卡片彻底沉进口袋）。
   *
   * `immediate`：双击 / Enter / Esc / 减少动效时一步到底 —— 这些场景要么马上卸载，
   * 要么用户明确在"取消"，不该再陪跑 780ms + 750ms 的收合。
   *
   * 所有"结束展开态"的路径共用这一份，避免各处漏清定时器：
   *   1. 双击 / Enter 跳转之前（immediate，否则跳转后定时器还会改状态）
   *   2. 展开态下再点一次（二次点击 = 收起，两段）
   *   3. 点组件外面（两段）
   *   4. Esc（immediate）
   */
  const collapse = useCallback(
    (immediate = false): void => {
      clearCollapseTimer()
      if (!opening) {
        // 已不在 open 档：可能正停在 closing 的停留段里（比如双击的第二下已经把它
        // 推进了停留段，紧接着 dblclick 又调一次 collapse(true)）。这时只允许
        // "立刻到底"把停留段截断，否则 closing 会没有定时器兜着、永久停在 hover 档。
        if (immediate) setClosing(false)
        return
      }
      setOpening(false)
      if (immediate || reducedMotion) {
        setClosing(false)
        return
      }
      setClosing(true)
      collapseTimerRef.current = window.setTimeout(() => {
        collapseTimerRef.current = null
        setClosing(false)
      }, CLOSE_HOLD_MS)
    },
    [clearCollapseTimer, opening, reducedMotion]
  )

  /**
   * 单击：**只播翻开动画，不跳转**（用户口径，见文件头第 4 条）。
   *
   * 流程：已经展开 → `collapse()`（二次点击的出口，两段收起）；否则置 `data-open`
   * 播动画。**不再自动收回**：参考件就是"点了才开、再点 / 点外面 / Esc 才收"，
   * 用户本轮也明确要"点击其他位置后才先回落再收起"这条更细的时序。
   * 跳转**不在这里**：走 {@link handleDoubleClick} / Enter。
   */
  const handleActivate = useCallback((): void => {
    // 已经展开了还点 → 收回（双击的第二下会走到这里，随后 dblclick 再 onOpen，
    // 这是有意为之：跳转前先收起，避免"带着展开态被卸载"）
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
    setClosing(false)
    setOpening(true)
  }, [clearCollapseTimer, collapse, opening, reducedMotion])

  /**
   * 双击：进入该分类（并交出过场素材）。
   *
   * 顺序固定：**先量矩形** → `collapse(true)` → `onOpen(payload)`。
   * 量矩形必须在最前（一收到 `onOpen` 父级就切视图，DOM 就没了）；
   * `collapse(true)` 清掉停留定时器并一步回位（否则跳转之后它还会对已卸载组件
   * setState）。
   * 不延迟：双击这一刻用户已经确认了目标，第一下单击也早已把翻盖翻开，
   * 接下来由父级的过场动画接手（卡片长成全屏 → 淡出 → 露出库）。
   */
  const handleDoubleClick = useCallback((): void => {
    const payload = readOpenPayload()
    collapse(true)
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
      // Esc：回到静止态（不跳转）。取消语义 → 一步到底，不陪跑两段收起
      if (event.key === 'Escape') {
        event.stopPropagation()
        collapse(true)
        return
      }
      // Enter：等价于双击 → 进入分类（同样先量矩形再跳，理由见 handleDoubleClick）。
      // 必须 preventDefault：`<button>` 对 Enter 原生也会派发一次 click，
      // 不拦住就会先跑 handleActivate（多一次无谓的展开态）再进分类。
      if (event.key === 'Enter') {
        event.preventDefault()
        const payload = readOpenPayload()
        collapse(true)
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
    // 拖动排序的视觉次序（flex order）：不传则保持 DOM 顺序（= 旧排布逐字不变）
    ...(order !== undefined && Number.isFinite(order) ? { order } : {}),
    '--gf-enter-delay': `${safeIndex * ENTRANCE_STEP_MS}ms`,
    '--gf-exit-x': `${exit?.dx ?? 0}px`,
    '--gf-exit-y': `${exit?.dy ?? 0}px`,
    '--gf-exit-s': `${exit?.scale ?? 1}`,
    // 底纹模式专属：前翻盖 tint 从纯函数取参考稿逐值（亮图 → 浅玻璃 / 暗图 → 深玻璃）。
    // 玻璃底色跟**底纹**走（主题 token 则跟主题走），未激活不写、回落主题基线。
    ...(wallpaperActive ? { '--gf-front-tint': wallFrontTint(scrimTone) } : {})
  } as CSSProperties

  /** 三条 clip-path 内联写入：BACK_PATH / FRONT_PATH / FRONT_PANEL_PATH 是形状的唯一来源。
   *  前板用「下沿多 1px」的那条（见 FRONT_PANEL_PATH 注释），磨砂层仍用严格 198 的。 */
  const backClip: CSSProperties = { clipPath: `path('${BACK_PATH}')` }
  const frontClip: CSSProperties = { clipPath: `path('${FRONT_PATH}')` }
  const frontPanelClip: CSSProperties = { clipPath: `path('${FRONT_PANEL_PATH}')` }

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
      data-closing={closing ? 'true' : 'false'}
      data-empty={isEmpty ? 'true' : 'false'}
      data-pinned={pinned ? 'true' : 'false'}
      data-wallpaper={wallpaperActive ? 'true' : 'false'}
      data-wtone={scrimTone}
      /** 有无背板图（= 有无 .gf-frost）。CSS 用它决定夹内卡在 idle 档靠磨砂层
       *  遮盖（有图）还是靠透明度兜底（无图），见 glass-folder.css 的 .gf-files。 */
      data-art={backArtUrl !== null ? 'true' : 'false'}
      data-name-shrink={nameShrunk ? 'true' : 'false'}
      data-leaving={leaving ? 'self' : 'false'}
      data-slot-key={slotKey}
      data-exit-half={exitHalf}
      aria-label={
        pinned ? `${label}，快速访问，双击打开` : `${label}，${count} 个素材，双击进入`
      }
      title={pinned ? '双击打开 · 单击预览' : '双击进入 · 单击预览'}
      style={rootStyle}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onClick={handleActivate}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
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
            {/* 背板只保留顶部薄高光。**不允许**再叠任何模糊位图：用户原话
                「背后的卡片根本就不需要模糊呀」——玻璃之外露出来的那块背板必须
                是锐利的（磨砂只属于前板，见下一层）。 */}
            <div className="gf-back-sheen" />
          </div>

          {/* 前板磨砂层（gf-frost）：
              · 2026-11-25 第一次：底纹卡用 CSS filter 磨砂 → 静态合成层丢滤镜；
              · 第二次：改成 canvas 位图（ctx.filter 画一次，模糊成为像素）；
              · 第三次（本轮）：**所有有背板图的卡**都渲染这层，并彻底移除
                `.gf-front` 的 backdrop-filter —— 那个滤镜会在 clip 边缘以"未上
                tint"的形态漏出 1 个设备像素的亮线（用户说的「底下一圈发白的光」，
                实测数据见文件头）。磨砂改由这层确定承担，视觉与参考稿等价。
              层级 z1：压在 .gf-back（锐利图）之上、.gf-files(z5) 与 .gf-front(z10)
              之下。夹内缩略图卡是内容物，仍在其上可见。
              `key` 绑 URL：换底纹 / 换封面时重挂画布，不会串图。 */}
          {backArtUrl !== null ? (
            <div className="gf-frost" style={frontClip} aria-hidden="true">
              <FrostCanvas key={backArtUrl} url={backArtUrl} />
            </div>
          ) : null}

          {/* 3 张底部锚定的缩略图卡（槽位 / 深度 / 抖动全部来自 CSS 变量）。
              钉选卡没有素材缩略图 → 三张全走空槽（与空分类同一形态）。 */}
          <div className="gf-files" aria-hidden="true">
            {sheetUrls.map((url, sheetIndex) => (
              <ThumbSheet key={`gf-sheet-${sheetIndex}`} url={url} index={sheetIndex} />
            ))}
          </div>

          {/* 前翻盖（磨砂玻璃）：tint + spec，没有描边、**没有 backdrop-filter**
              （理由见文件头：它会在 clip 边缘漏 1px 亮线）。磨砂由上面那层
              `.gf-frost` 位图承担；底纹模式只由 rootStyle 内联替换 tint
              （wallFrontTint 参考稿逐值），不再叠任何罩层 —— 参考稿的名字直接
              坐在 front 玻璃上，可读性由 tint 底部 .93/.94 近实心保证。
              裁切用 frontPanelClip（下沿 199，比背板多盖 1px），见 FRONT_PANEL_PATH。 */}
          <div className="gf-front" style={frontPanelClip} aria-hidden="true">
            <div className="gf-tint" />
            <div className="gf-spec" />
          </div>
        </div>
      </div>

      {/* 名称 + 数量：压在文件夹**内部**左下角，左右/下边距按 --gf-scale 换算，
          文字本身不参与缩放（否则 0.307 倍下 12px 会变成 4px）。
          钉选卡不显示素材计数，改显示「外部」标识（钉的是磁盘目录）。
          ★ 2026-11-25 用户拍板：右上角那枚「置顶」小圆钉**取消**（「我觉得不太需要吧」），
            改成名字行前的一颗**小圆点**——「这是项目的文件夹，在前面的磨砂层帮我加一个
            绿色或者蓝色的小点，这样用户就方便区分一些」。点走强调蓝（与全仓强调色一致），
            钉选卡才渲染；素材大类卡零变化。 */}
      <div className="gf-label">
        <div className="gf-name-row">
          {pinned ? <span className="gf-kind-dot" aria-hidden="true" /> : null}
          <span className="gf-name" ref={nameRef}>
            {/* 单行探针：绝对定位 + nowrap + hidden，只用于量"名字整串不折行有多宽"，
                不参与布局、不进无障碍树（aria-hidden）。放在 .gf-name 内部是为了
                继承同一字号档位（含窄窗媒体查询），缩号后测量自动跟着走。 */}
            <span className="gf-name-probe" ref={nameProbeRef} aria-hidden="true">
              {label}
            </span>
            {label}
          </span>
        </div>
        <span className="gf-count">{pinned ? '外部' : `${count} 个素材`}</span>
      </div>
    </button>
  )
}

export default GlassFolder

/**
 * 「新建项目」虚卡（v1.2 反馈批 A 改版）。
 *
 * 用户原话：「如果要新建项目，我认为它的外观可以是现在这个期望的文件夹，只不过
 * 中间有一个加号，下面有"新建项目"的字样。这个文件夹会比其他的文件夹更透明，
 * 但不会完全透明，仅此而已。」
 *
 * 形态：**复用 GlassFolder 的整套形状与结构**（BACK_PATH / FRONT_PATH clip、
 * stage→tilt→shadow/back/front 层级、`--gf-scale` 尺寸阶梯、hover 三态、入场
 * `data-entered` 错峰全部照搬 —— 根节点直接挂 `gf-root` 类，hover/open 的 CSS
 * 变量规则自动生效），差异只有三点，全部写在 `new-project-card.css`：
 *   ① 更透明：`--gf-back-fill` / `--gf-front-tint` / blur 在 `.np-new-card` 上
 *     整体调低一档（更透，但不完全透明）；
 *   ② 中央大「+」+ 下方「新建项目」文字（`.np-face`，与 `.gf-label` 同纪律：
 *     不参与缩放、常驻可读字号）；
 *   ③ 无夹内缩略图、无钉选角标、无底纹（虚卡不是文件夹，是动作入口）。
 *
 * 交互（与旧虚卡逐字一致）：
 *   · **单击即开向导**（`onClick`），没有"单击只播动画 / 双击进入"的文件夹语义 ——
 *     它不是文件夹入口，无双击语义；
 *   · **右键不拦**：contextmenu 事件自然冒泡到 `HomeCover` 的 `.hc-folder-wrap`
 *     处理器 → 打开排菜单（含「新建项目…」），右键菜单因此保留；
 *   · hover 反馈与普通文件夹一致（翻盖后仰 + 卡片上抬，来自 `.gf-root:hover`）。
 *
 * 为什么放在 `GlassFolder.tsx`：BACK_PATH / FRONT_PATH / ENTRANCE_STEP_MS 是本
 * 文件私有常量，虚卡要与文件夹形状"永远同源"，就近复用最稳（导出常量反而多一条
 * 被误改的通路）。
 */
export interface NewProjectFolderCardProps {
  /** 排内序号（入场错峰），接在大类卡与钉选卡之后续排 */
  index: number
  /** 单击 → 打开新建项目向导（由父级接线，本组件只透传） */
  onClick: () => void
  /**
   * 视觉顺序（CSS `flex order`，2026-11-25 拖动排序）：虚卡不可拖，但同排其它卡
   * 靠 order 排位后，它必须显式拿**最大值**才能稳在末尾（order 默认 0 会跑到最前）。
   */
  order?: number
}

export function NewProjectFolderCard({
  index,
  onClick,
  order
}: NewProjectFolderCardProps): ReactElement {
  /** 入场组装：与 GlassFolder 同款（首帧 false → 挂载后一帧置 true，CSS 才播得出） */
  const [entered, setEntered] = useState<boolean>(false)

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  /** 入场错峰：保证是非负整数，脏数据不至于写出非法 CSS 值（与 GlassFolder 同款守卫） */
  const safeIndex: number = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0

  const rootStyle = {
    ...(order !== undefined && Number.isFinite(order) ? { order } : {}),
    '--gf-enter-delay': `${safeIndex * ENTRANCE_STEP_MS}ms`
  } as CSSProperties

  /** 两条 clip-path 内联写入：BACK_PATH / FRONT_PATH 与真文件夹同一来源 */
  const backClip: CSSProperties = { clipPath: `path('${BACK_PATH}')` }
  const frontClip: CSSProperties = { clipPath: `path('${FRONT_PATH}')` }

  return (
    <button
      type="button"
      className="gf-root np-new-card"
      data-entered={entered ? 'true' : 'false'}
      /* 虚卡恒在末位（视觉最右）：退场时跟随右半排往右退（2026-11-25 拖动排序配套） */
      data-exit-half="right"
      style={rootStyle}
      onClick={onClick}
      title="新建项目"
      aria-label="新建项目"
    >
      {/* 形状层：与真文件夹完全同构（stage 缩放 / tilt 倾斜 / shadow / back / front）。
          不带 aria-hidden 的只有 button 本身 —— 内部全是装饰。 */}
      <div className="gf-stage" aria-hidden="true">
        <div className="gf-tilt">
          <div className="gf-shadow" />
          <div className="gf-back" style={backClip}>
            <div className="gf-back-sheen" />
          </div>
          <div className="gf-front" style={frontClip}>
            <div className="gf-tint" />
            <div className="gf-spec" />
          </div>
        </div>
      </div>

      {/* 中央「+」+ 下方「新建项目」：不进 stage（不参与缩放），绝对定位压在
          前翻盖区域内居中，几何换算走 --gf-scale（与 .gf-label 同一套纪律） */}
      <div className="np-face" aria-hidden="true">
        <span className="np-face-plus">
          <svg
            width="26"
            height="26"
            viewBox="0 0 26 26"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M13 4v18M4 13h18" />
          </svg>
        </span>
        <span className="np-face-label">新建项目</span>
      </div>
    </button>
  )
}
