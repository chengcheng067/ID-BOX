/**
 * 首页 → 分类库的**过场遮罩**（v4：只剩一层吃点击的透明板）。
 *
 * 用户口径的演化（三轮，最后一条是当前实现）：
 *   ① 「文件夹里面的卡片应该有一个弹出来，快要放大成整个窗口的样子」→ v1 整屏铺缩略图，糊；
 *   ② 「这个比我们的缩略图要模糊」→ v2 改成纯色卡片长满屏，仍然被否；
 *   ③ （当前，逐字）「第一，文件夹移动，而不是我们的缩略图移动。第二，移动到比如模型的
 *      这个文件夹时，它应该是中心消隐的，而不是瞬间不见的。」
 *
 * ③ 把前两版的实现方式整个推翻：**飞的必须是"文件夹"这个整体**（玻璃本体 + 三张扇形
 * 排开的卡 + 左下角的名称/数量），不是一张缩略图。而"整块文件夹"只存在于一个地方 ——
 * 首页那个真的 `<button class="gf-root">`。所以 v4 **不再复制任何东西**：
 *   · 飞行与消隐：`HomeCover` 让那个真节点自己 translate+scale 到屏幕正中，再每帧推到
 *     中心挖洞化开（几何/时间轴都在 `HomeCover.tsx` + `glass-folder.css`）；
 *   · 本组件退化成一块**纯透明、吃点击**的板子，只解决一件事：0–880ms 期间用户不能
 *     在文件夹飞走的过程中又点到别的东西（点两次文件夹 = 两条跳转打架）。
 *
 * 为什么遮罩必须透明到底（一个颜色都不上）：它盖住的正是"文件夹本体正在飞 + 其余信息
 * 正在向屏幕边缘退开"的整个画面。一旦给它底色，这个镜头就被一块板截断了。
 *
 * 时序总账（单位 ms，t=0 = 双击那一刻；真正的动画在别处，这里只列出来方便一处读懂）：
 *
 *   0 ── 360 到中心 ── 600 停留完 ── 880 消隐完 ── 880 切视图（库卡片随即从两侧滑入）
 *        飞 360ms         停 240ms        消隐 280ms
 *   ├────────────────────── 本遮罩全程在场（z-index 70）──────────────────────┤
 *
 * 为什么遮罩的寿命**正好**是 880ms、一毫秒都不多留：它 `pointer-events: auto`、铺满
 * 视口 —— 多留 400ms 就等于"库已经出现了，但前 0.4 秒点不动任何卡片"。这不是保险丝
 * 该付的代价，所以这里只留一个**等长**定时器（超时即交还控制权），不再加宽限。
 * 没有 rAF 之后也就不存在"rAF 被挂起导致遮罩一直挂着"的问题了：定时器在窗口最小化时
 * 只是被节流，不会被永久冻结。
 *
 * 依赖纪律：零第三方依赖，只用 `window.setTimeout`；不碰 three.js、不碰 store、
 * 不读业务数据、不渲染任何视觉内容。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import './home-outro.css'

/**
 * 过场总时长（ms）= 360 飞 + 240 停 + 280 消隐。
 *
 * 与本组件的关系只剩"遮罩在场多久"；与 `App.tsx` 的 `HOME_OUTRO_SWITCH_MS`（切视图）
 * 是**同一个数**，两边注释互相点名。改一处必须改另一处，否则要么露空档、要么遮罩挡手。
 */
export const HOME_OUTRO_TOTAL_MS = 880

/** 组件 props。 */
export interface HomeOutroProps {
  /** 过场结束（= 遮罩该撤了）时回调，父级据此清掉状态、卸载本组件 */
  onDone: () => void
}

/**
 * 读一次「减少动效」系统偏好（不订阅）。
 *
 * 与 `HomeCover` / `GlassFolder` 里那两个 `usePrefersReducedMotion` **不共享**：
 * 那两处会跟随系统设置变化而更新，这里只在挂载那一刻判一次就够（遮罩最长 880ms，
 * 中途改系统设置还要求"立刻改道"属于过度设计）。
 *
 * @returns 当前是否要求「减少动效」
 */
function prefersReducedMotionOnce(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 首页 → 分类库的过场遮罩（透明、吃点击）。
 *
 * 渲染结构（一层，别再加图层）：
 *
 *   div.ho-shield   ← fixed inset:0、z-index 70、background: transparent、
 *                     pointer-events: auto。**没有内容、没有动画**。
 *
 * 动画（飞中 / 停留 / 中心消隐）全部发生在真实文件夹节点上，见
 * `HomeCover.tsx` 的「退场」那一节与 `glass-folder.css` 的 `.gf-root[data-leaving='self']`。
 *
 * @param props 见 {@link HomeOutroProps}
 * @returns 遮罩层；`prefers-reduced-motion` 下什么都不画（挂载即调 `onDone`）
 */
export function HomeOutro({ onDone }: HomeOutroProps): ReactElement {
  /** 减少动效：挂载那一刻判一次（不订阅，理由见 `prefersReducedMotionOnce`） */
  const [reduced] = useState<boolean>(prefersReducedMotionOnce)

  /**
   * `onDone` 存进 ref：父级传的是内联箭头函数（每次渲染都是新引用），
   * 若把它写进 effect 依赖，父级任何一次重渲染都会**重排**这个定时器。
   * ref 的同步放在 effect 里而不是渲染期（渲染期写 ref 属于渲染副作用）。
   */
  const onDoneRef = useRef<() => void>(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    // 减少动效：不铺遮罩，直接把控制权交回去（父级在同一帧切视图）
    if (reduced) {
      onDoneRef.current()
      return
    }
    const timer = window.setTimeout(() => {
      onDoneRef.current()
    }, HOME_OUTRO_TOTAL_MS)
    return () => window.clearTimeout(timer)
  }, [reduced])

  // 减少动效：一张纸都不画（父级已在 effect 里收到 onDone 并卸载本组件）
  if (reduced) {
    return <></>
  }

  return <div className="ho-shield" role="presentation" aria-hidden="true" />
}

export default HomeOutro
