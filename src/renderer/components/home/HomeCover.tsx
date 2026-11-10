import { useEffect, useState } from 'react'
import { useVault } from '../../store'
import { IconSettings } from '../../icons'
import { HomeParticles } from './HomeParticles'
import { HomeStats } from './HomeStats'
import { GlassFolder } from './GlassFolder'
import type { GlassFolderOpenPayload } from './GlassFolder'
import {
  HomeSearchCommand,
  type HomeSearchGroup,
  type HomeSearchItem
} from './HomeSearchCommand'
import type { MotionQuality } from '../../../shared/types'
// 退场（`data-leaving`）那套规则的宿主。它和过场的时间轴是同一件事的两半，所以与
// `HomeOutro` 共用一份 CSS（本组件没有自己的样式文件，理由见 `home-outro.css` 里
// 「首页退场」那一节的注释）。显式 import，不依赖"HomeOutro 先渲染过"这种隐式前提。
import './home-outro.css'

/**
 * 首页封面页（v0.9.4「侧栏第一项『全部』→『首页』」的落地形态）。
 *
 * 产品口径（已定稿，不要再改设计）：
 * - 侧栏第一个节点「首页」进入的不是资产网格，而是**这一块封面页**；
 * - 首页态下左栏 / 右栏折起（由 `App.tsx` 传 `collapsed` 给 `CollapsibleColumn`）；
 * - 内容区 = 粒子背景（铺满、`pointer-events:none`、在内容层之下）
 *   + 右上数据看板（磨砂玻璃卡，含分类占比环，见 `HomeStats`）
 *   + 屏幕中央靠下的变形搜索条（`HomeSearchCommand`）
 *   + 下方磨砂文件夹排（数量 = 有素材的分类数，当前 4 个；空分类不占入口）
 *   + 一行提示字 + 左下角一个设置齿轮；
 * - 首页**不放**回收站 / 重复资产 / 排序 / 筛选 / 视图切换（那些都在网格态）。
 *
 * 本组件是**纯展示组件**，不直接读写业务数据：`folders` / `stats` / `searchValue`
 * 全部由 `App.tsx` 传进来（便于以后单测与 Storybook 预览）。
 *
 * 唯一的例外是下面那一次 `useVault`：粒子背景的"花哨程度"是全局外观设置
 * （`settings.motionQuality`），它既不是业务数据也不该由 App 逐层往下透传 ——
 * 与 `HomeParticles` 的 props 契约（`quality: MotionQuality`）对齐后只在这里读一次。
 *
 * 仓库纪律提醒：本文件**自己**不写任何 CSS 渐变、不用 `backdrop-filter`。
 * 玻璃质感由 `GlassFolder`（`glass-folder.css`）与 `HomeStats`（`home-stats.css`，
 * 用户明确要求「磨砂玻璃框住展示」的第二处豁免）各自负责；`HomeSearchCommand`
 * 只用 token 的实色 + 阴影 + 一条功能性 mask，无装饰渐变。
 * 布局数值全部是设计稿量出来的真规格。
 */

/** 首页文件夹卡的数据项（key 与侧栏导航节点一一对应） */
export interface HomeFolderItem {
  /**
   * `materialGroup` = 侧栏的「材质」分组节点（texture + material 两类合并）。
   *
   * ⚠️ **没有 `'d5a'`**（2026-11-09 收口后）：`.d5a` 不是大类，而是**模型的一种格式**，
   * 入口走「模型」卡 → 中栏头「格式」→ D5A（与 `.max` 同构）。所以首页不会出现
   * 独立的 D5A 文件夹 —— 同一个东西不该有第四种说法。
   *
   * 候选顺序由 `logic/homeKinds.ts#HOME_FOLDER_KEYS` 给出（= `KIND_NAV_ORDER`），
   * 仍然只显示 `count > 0` 的卡；「模型」卡的计数走 `kindsOfFilter('model')`
   * = `{model, d5a}`，与点进去的网格条数一致。
   */
  key: 'model' | 'cad' | 'materialGroup' | 'hdri' | 'other'
  label: string
  count: number
  /** 封面缩略图 URL；长度恒为 3，不足用 `null` 占位（由 `GlassFolder` 画空槽） */
  thumbs: Array<string | null>
}

/** 数据看板的三项数字（顺序固定：本月入库 / 库总量 / 待补分类） */
export interface HomeStatsData {
  monthImports: number
  totalAssets: number
  pendingCategory: number
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 双击进入分类的**退场**时间轴（2026-11 第三轮用户口径）
 *
 * 用户原话（逐字）：
 *   「第一，文件夹移动，而不是我们的缩略图移动。第二，移动到比如模型的这个文件夹时，
 *     它应该是中心消隐的，而不是瞬间不见的，这个动画需要做进去。」
 *
 * 实现方式：**不复制**，直接让 DOM 里那个真的 `<button.gf-root>` 平移 + 放大到屏幕
 * 正中（FLIP 的思路，但只有"最后一帧"是 JS 算的位移，中间过程全交给 CSS transition），
 * 到位停住之后由 CSS `@keyframes` 用**高斯模糊晕开**（blur 0→14px + opacity 1→0）把它化掉。
 *
 *   0 ── 360 到中心 ── 600 停留完 ── 880 消隐完 ── 880 切视图（库卡片随即滑入）
 *        飞 360ms         停 240ms        消隐 280ms
 *
 * ⚠️ 三处必须同步的配对（改一处就要改另一处）：
 *   · EXIT_FLY_MS(360)      ↔ `glass-folder.css` 里 `.gf-root[data-leaving='self']` 的
 *                             `transition: transform 360ms`；
 *   · EXIT_FLY_MS+EXIT_HOLD_MS(600) ↔ 同一条规则里 `animation` 的 `600ms` 延迟
 *                             （顺序是"先停、后消隐"，不是"边飞边消隐"）；
 *   · EXIT_FLY_MS+EXIT_HOLD_MS+EXIT_DISSOLVE_MS(880) ↔ `App.tsx` 的
 *                             `HOME_OUTRO_SWITCH_MS`（= 880）与 `HomeOutro` 的
 *                             `HOME_OUTRO_TOTAL_MS`（= 880）。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 三段时长。**组件内部一处都不读**（飞行是 CSS transition、消隐是 CSS animation，
 * 时间全写在 `glass-folder.css` 里），之所以仍然保留并导出，是为了让这张时间轴
 * 在 JS 侧有一个可被引用/被测试断言的**唯一来源** —— 否则"880 = 360+240+280"
 * 这个等式只存在于三份互相抄的注释里，迟早会漂。
 */
export const EXIT_FLY_MS = 360
/** 在正中停住的时长（ms）——用户明确要的"停留一小段时间"，不要省 */
export const EXIT_HOLD_MS = 240
/** 消隐（高斯模糊晕开）用时（ms）↔ `@keyframes gf-folder-dissolve` 的 280ms */
export const EXIT_DISSOLVE_MS = 280
/** 过场总时长（ms）= 360 + 240 + 280 = **880**，与 `App.tsx` / `HomeOutro.tsx` 同值 */
export const HOME_COVER_TOTAL_MS = EXIT_FLY_MS + EXIT_HOLD_MS + EXIT_DISSOLVE_MS
/** 飞到中点时的放大倍率：104×84 → 156×126（近处看清，但不铺满屏） */
const EXIT_SCALE = 1.5

/**
 * 退场几何：由被双击那个文件夹的矩形算出来，交给 `GlassFolder` 内联成 CSS 变量。
 * 字段含义见 `GlassFolderExit`（`GlassFolder.tsx`）。
 */
interface ExitGeom {
  dx: number
  dy: number
  scale: number
}

/**
 * 算「飞到屏幕正中」的位移与倍率。
 *
 * dx/dy 是**中心对中心**的屏幕 px 差：`transform: translate() scale()` 里 translate
 * 作用在元素自身坐标（1 单位 = 1 屏幕 px），所以直接写这个差值即可，不需要按倍率换算。
 *
 * 消隐不需要任何几何参数（模糊半径是固定常数，写在 keyframes 里），所以这里只出三个数。
 *
 * @param rect 文件夹根节点的视口矩形（`GlassFolder` 在双击那一刻量好的快照）
 * @returns 退场几何（屏幕坐标）
 */
function computeExitGeom(rect: { left: number; top: number; width: number; height: number }): ExitGeom {
  const scale: number = EXIT_SCALE
  if (typeof window === 'undefined') {
    // SSR / 测试环境：退化成"原地不动、不放大"，绝不产生 NaN / Infinity
    return { dx: 0, dy: 0, scale }
  }
  return {
    dx: window.innerWidth / 2 - (rect.left + rect.width / 2),
    dy: window.innerHeight / 2 - (rect.top + rect.height / 2),
    scale
  }
}


/**
 * `prefers-reduced-motion: reduce` 订阅。
 *
 * 只在组件内部用（不进 store）：它是**系统级**偏好，与 `settings.motionQuality`
 * （用户显式选的性能档）是两件事，命中任一条都该退化。
 * 与 `AssetGrid.tsx` 里的同名 hook 同构 —— 那边是组件私有实现，没有导出，
 * 这里按同一写法本地再实现一份（不为一个 20 行的 matchMedia 订阅去改别人的文件）。
 */
function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (): void => setReduced(mq.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    // 老 Chromium 只有 addListener；Electron 33 两者都有，这里只是兜底
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])
  return reduced
}

export function HomeCover(props: {
  folders: HomeFolderItem[]
  stats: HomeStatsData
  /**
   * 搜索面板取结果用的纯函数（由 `App.tsx` memo 后传入）。
   *
   * 为什么是函数而不是现成数组：查询词由 `HomeSearchCommand` 内部持有
   * （它是受控输入框，父级不该为每一次按键重渲染整个首页），所以父级
   * 交出来的是「给我词、我给你分组」这个能力，不是一份快照。
   */
  searchGroups: (query: string) => HomeSearchGroup[]
  /** 用户在搜索面板里选中某一项 */
  onPickSearch: (item: HomeSearchItem) => void
  /**
   * 双击 / Enter 某个文件夹 → 进入该分类。
   *
   * 第二个形参是**过场素材**（起点矩形 + 背板缩略图），由 `GlassFolder` 在卸载前
   * 量好交上来；`App` 拿它播「该文件夹飞到屏幕正中 → 停一小段 → 淡出 → 露出库」的
   * 过场。本组件只负责透传，不认识也不使用这两个字段。
   */
  onOpenKind: (key: HomeFolderItem['key'], payload: GlassFolderOpenPayload) => void
  onOpenSettings: () => void
}): JSX.Element {
  const { folders, stats, searchGroups, onPickSearch, onOpenKind, onOpenSettings } = props

  /** 粒子背景的档位（唯一一次读 store，理由见文件头 doc） */
  const quality: MotionQuality = useVault((s) => s.settings?.motionQuality ?? 'balanced')
  /**
   * 右上数据卡是否显示（设置·外观「首页 · 数据卡片」，默认开）。
   *
   * 用 `!== false` 而不是 `=== true`：缺键 / 旧 settings.json / 脏值都按"显示"处理，
   * 与 `settings.ts` 的归一化方向一致（那里是"只有严格 false 才关"）。
   * 不传下来、在这里直接读 store 的理由同 `quality`：它是外观偏好，不是业务数据。
   */
  const showHomeStats: boolean = useVault((s) => s.settings?.showHomeStats !== false)
  const reduced = usePrefersReducedMotion()

  /**
   * 正在退场的那个文件夹（`null` = 还没开始退场）。
   *
   * 用途有两个，都是纯视觉：
   *   · 给根节点打上 `data-leaving` → 整页**其余**信息按 `home-outro.css` 那套规则
   *     向屏幕边缘退开并淡出，给「文件夹本体飞到正中」让出画面；
   *   · 决定 `exit` 几何交给哪一张卡（只有它自己会飞）。
   *
   * ⚠️ **不动任何业务状态**：双击的真正落地仍是 `onOpenKind`（`App` 里排 880ms 后切
   * 视图）。因此不需要"退场结束后复位"的逻辑 —— 880ms 时视图切换、本组件整体卸载，
   * `leavingKey` / `exitGeom` 随之消失。
   *
   * （早期版本还需要 `data-leaving-index` + `:nth-child` 才能把被双击的那张从"整排
   * 向两侧退开"里摘出来；现在卡自己带着 `data-leaving="self"`，CSS 一条
   * `:not([data-leaving='self'])` 就够了，下标已无用处，不要再把它加回来。）
   */
  const [leavingKey, setLeavingKey] = useState<HomeFolderItem['key'] | null>(null)

  /**
   * 被双击那个文件夹的**退场几何**（飞到屏幕正中的位移 / 倍率）。
   * `null` = 没有过场在进行。只在 `onOpen` 里算一次：起点矩形那一刻就固定了，
   * 中途窗口 resize 不该让它改道。
   */
  const [exitGeom, setExitGeom] = useState<ExitGeom | null>(null)

  /**
   * 一次性入场淡入（`opacity 0 → 1`，200ms）。
   *
   * 为什么用 state 而不是 CSS `animation`：`animation` 在"组件重挂载"与
   * "父级重渲染"两种情况下行为不同，而这里要的是"每次进首页淡一下"。
   * 首帧必须是 0、下一帧才置 1，transition 才会真正播放（同步设成 1 不会过渡）。
   */
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    setEntered(true)
  }, [])

  /**
   * ⚠️ 这里**故意没有**驱动消隐的 effect。
   *
   * 消隐是一段纯 CSS 动画（`@keyframes gf-folder-dissolve`：blur 0→14px 同时
   * opacity 1→0，600ms 延迟、280ms 时长、`both` 填充），起止时刻由 `glass-folder.css`
   * 写死，与 `EXIT_FLY_MS / EXIT_HOLD_MS / EXIT_DISSOLVE_MS` 三个常量配成一对。
   *
   * 曾经有一版在这里起 rAF 逐帧写 `--gf-hole`（从中心挖一个圆洞）。用户看到真机后
   * 否掉了那个方案（「我要的是高斯模糊的消影哦，你给我的是中间一个圆圈，然后把它挖掉」），
   * 整套 mask + rAF 一起删除。**不要再加回来**：JS 逐帧改 filter/opacity 会让每一帧
   * 都穿越 React 之外的合成路径，且必然与 CSS 动画争同一个属性（animation origin
   * 高于 style attribute），形成"看不出谁在驱动"的随机 bug。
   */

  /**
   * 退场开关（过场时间轴的前半段，60–320ms）挂在根节点上：
   * `data-leaving="true"` = 整页其余信息向屏幕边缘退开 + 淡出。
   * 被双击的那张卡**不**参与这套规则（它自己带着 `data-leaving="self"` 在飞），
   * 靠 `home-outro.css` 里的 `:not([data-leaving='self'])` 摘出来。
   *
   * `data-folder-count`：这个排里实际有几张卡。**少于 4 张时排布要从"两端撑开"
   * 切成"居中紧凑"**，数据卡的位置也要跟着解耦（见 `home-outro.css` / `home-stats.css`）。
   * 用户的原话：「有很多用户可能只用我们的"材质"和"模型"文件夹，另外几个文件夹
   * 可能就不存在，那就不显示了。所以这个问题是需要考虑到的。」
   */
  return (
    <div
      className="hc-root relative flex min-h-0 flex-1 flex-col"
      data-leaving={leavingKey !== null ? 'true' : 'false'}
      data-folder-count={folders.length}
      style={{
        opacity: reduced || entered ? 1 : 0,
        transition: reduced ? undefined : 'opacity 200ms ease'
      }}
    >
      {/* ① 粒子层：铺满内容区、在一切内容之下、不吃点击（否则会吞掉文件夹的 hover）。
          退场时只压暗到 0.25、不位移（理由见 `home-outro.css` 的 `.hc-exit--faint`）。 */}
      <div className="hc-exit hc-exit--faint pointer-events-none absolute inset-0 z-0" aria-hidden="true">
        <HomeParticles quality={quality} />
      </div>

      {/* ② 设置齿轮：**左下角**（用户 2026-11-09：「首页的设置放到左下角去」）。
          原先在右上角，和磨砂数据卡抢同一块视觉重心；挪到左下后右上只留数据卡，
          整屏重心也压回中间那排文件夹上。
          `app-no-drag` 是顶栏拖动区纪律的配套类 —— 虽然这里不在顶栏内，
          但内容区与顶栏拖动条视觉相连，保持一致并无害。
          退场时向左退 32px 并淡出（`hc-exit--left`）。 */}
      <button
        type="button"
        className="hc-exit hc-exit--left app-no-drag absolute bottom-[24px] left-[24px] z-20 flex h-8 w-8 items-center justify-center rounded-[8px] text-tertiary transition-colors hover:bg-elevated hover:text-primary"
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
      >
        <IconSettings width={16} height={16} />
      </button>

      {/* ③ 数据看板：磨砂玻璃卡（本月入库 / 库总量 / 待补分类），见 HomeStats。
          本版**不做**点击跳转（等验收后再加，避免一次交付两套交互）。
          退场时向右退 48px 并淡出 —— 但它**不能**在这里套一层带 `hc-exit` 的 div：
          `.hs-card` 是 `position: absolute`，一旦包一层会被加上 `translate` 的父级
          （= 新的包含块），它的 `right/top` 会改成相对那个零尺寸盒子解析、瞬间跳到
          左上角。所以方向/淡出由 `home-outro.css` 直接命中 `.hs-card`（那边同时要
          撤掉入场 `animation` 的 `fill`，否则 opacity 改不动）。

          `showHomeStats`（设置·外观）关掉后整块不渲染 —— 用户口径是「只用模型和材质
          两个文件夹的人，右上那三个数字没意义」。条件渲染而不是 `display:none`：
          关掉就该连空间一起消失，别留一块看不见的绝对定位元素在 `pointer-events`
          之外游荡。 */}
      {showHomeStats ? <HomeStats stats={stats} folders={folders} /> : null}

      {/* ④ 底部组：搜索 → 文件夹排 → 一行提示。整组靠底，`justify-end` 吃掉上方余量 */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end px-[92px] pb-[56px]">
        {/* 搜索：收起态是 240×32 的一条，点开后**同一个盒子**被弹簧连续长成
            560×(49+列表高) 的命令面板（skiper-92 那套）。
            ⚠️ 面板靠溢出显示，上沿比收起盒高 8px、向下长约 350px ——
            祖先链上**不能**出现 `overflow:hidden` / `overflow:clip`。
            本组是 flex-col + justify-end，下方余量够，但改布局时要注意。
            退场时整条向下退 28px 并淡出（`hc-exit--down` 挂在下面这层包裹上）。 */}
        <div className="hc-exit hc-exit--down mx-auto shrink-0">
          <HomeSearchCommand
            groups={searchGroups}
            onPick={onPickSearch}
            placeholder="搜索素材、分类或文件名"
            shortcut="K"
          />
        </div>

        {/* 文件夹排：`GlassFolder` 卡片（当前库里 4 个分类有素材 → 4 张；
            空分类不占入口的规则在 `App.tsx` 的 `homeFolders` 里，本组件不判）。
            尺寸由组件自己的 `--gf-scale` 跟窗口走（整排已缩到上一版的 2/3：
            1080 ≈ 104px、1440 ≈ 151px、1520+ 上限 161px），父级**不要**再写死宽高。
            ⚠️ 父级**不能**加 `overflow-hidden` —— 卡片的翻盖/阴影会伸出根部盒子。

            ── 行宽上限 960 → 820（用户 2026-11-09：「变成下方 4 个文件夹」）──────────
            960 是给「5 张卡」定的：缩到 2/3 以后 5×151=753 摊在 ~1256 里太散架
            （4 个间隙各 ~126px），所以收窄到 960 并居中。
            而 5 张变成 4 张后，960 反而太松：4×151 = 604，3 个间隙各 (960−604)/3 ≈ 118px，
            又是"散架"的读数。按 4 张卡反算：
              · 1440 窗口：可用宽 = 100vw − 184 = 1256 > 820 → 行宽取 820，
                4×151 = 604，(820 − 604) / 3 ≈ **72px** 间隙 —— 紧凑但不挤。
              · 1080 窗口（窗口最小宽）：可用宽 = 896 > 820 → 行宽仍是 820，
                4×104 = 416，(820 − 416) / 3 ≈ **135px** 间隙。
                1080 下确实偏松 —— 但这是卡片等比缩放的必然结果（卡变小、带子不变），
                且 1080 是极限窄窗口，**不要**为它加断点特例：宁可偏松也不要让
                常驻窗口（1280~1600）变紧。
              · 1520+：卡封顶 161 → 4×161 = 644，(820 − 644) / 3 ≈ 59px。
            ⚠️ 改了这里的 820，必须同步改 `home-stats.css` 里 `.hs-card` 的 `right`
            （数据卡右边缘要与第 4 张卡的右边缘逐像素对齐，公式里含行宽）。

            `justify-between` 让卡片在这条 820 的带子里均分空白；若将来「其他」分类
            有了素材、第 5 张卡回来，5×151=755 ≤ 820 依然放得下，间隙缩到 ~16px，可接受。
            `[&>*]:shrink-0`：组件根节点已经写了 `flex: none`，这里再兜一道，
            防止将来有人给 `.gf-root` 换 class 名时被 flex 压扁 ——
            内部是按设计稿 340×272 等比缩放的一组卡片，一压就会互相穿模。

            ── `onOpen` 里的两句**顺序不能换**（本轮新增）──────────────────────
            · `setLeavingKey(folder.key)`：整页其余信息在同一帧开始向边缘退开，
              并且这一张立刻消失（它的替身由 `HomeOutro` 从同一矩形接着飞）；
            · `onOpenKind(folder.key, payload)`：交给 `App` 排「600ms 后切视图」。
            反过来的话 `App` 先切视图 → 本组件先卸载，退场动画根本不会播。
            两个 setState 在同一个事件回调里，React 18 会合并成一次渲染。
            另外这一排的 class `hc-folder-row` 是退场规则的选择器锚点（左右半排分开退），
            见 `home-outro.css`。 */}
        <div
          className="hc-folder-row mx-auto mt-10 flex w-full max-w-[820px] items-start justify-between [&>*]:shrink-0"
          data-count={folders.length}
        >
          {folders.map((folder, index) => (
            <GlassFolder
              key={folder.key}
              label={folder.label}
              count={folder.count}
              thumbs={folder.thumbs}
              index={index}
              /**
               * `exit` 只给**被双击的那一个**（其余是 null → 走 CSS 的"向两侧退开"）。
               * 用 `leavingKey` 判等而不是下标：`folders` 顺序将来变了也不影响。
               */
              exit={folder.key === leavingKey ? exitGeom : null}
              onOpen={(payload) => {
                /**
                 * 顺序：**先算几何 / 打退场标记，再跳转**。
                 * · `setExitGeom` + `setLeavingKey` 让这一个文件夹本体开始飞、整页其余
                 *   信息向边缘退开；
                 * · `onOpenKind` 只是把"880ms 后切视图"排进 `App` 的定时器。
                 * 反过来的话 `App` 先切视图 → 本组件先卸载，退场动画根本不会播。
                 * 三个 setState 在同一个事件回调里，React 18 合并成一次渲染 ——
                 * 所以文件夹拿到 `exit` 的那一帧，也是整页开始退场的那一帧。
                 *
                 * `reduced`（系统要求减少动效）：什么都不做。`App` 会立刻切视图、
                 * 本组件当场卸载；既不用飞、也不用消隐，连 rAF 都不该起。
                 */
                if (!reduced) {
                  setExitGeom(computeExitGeom(payload.rect))
                  setLeavingKey(folder.key)
                }
                onOpenKind(folder.key, payload)
              }}
            />
          ))}
        </div>

        {/* 提示字：常驻，不做渐隐（首页控件 ≤ 1 图标 + 1 行提示的口径）。
            前半句「双击文件夹进入」是交互改动的必要提示：单击只播翻开动画，
            不给这行字用户会以为单击失灵。
            后半句用「拖入文件」而非「拖入压缩包」（2026-11-11 用户拍板）：
            导入入口不只收压缩包，单张图片、模型文件、CAD 图纸、HDR、D5A 等都能直接拖入，
            写「压缩包」会把其他入口说没了。不要改回旧文案。
            退场时向下退 24px 并淡出（`hc-exit--down-soft`：它离底边更近，少退 4px）。 */}
        <div className="hc-exit hc-exit--down-soft mt-[54px] text-center text-[12px] text-tertiary">
          双击文件夹进入 · 拖入文件即可导入
        </div>
      </div>
    </div>
  )
}
