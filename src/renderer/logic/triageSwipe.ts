/**
 * 整理浮层的**左右飞出**动画判据（纯逻辑，零 DOM / 零 React → 可直接进 vitest）。
 *
 * ## 需求来源（2026-10-30 用户原话）
 *
 * > 「关于"确认"或者"跳过"的操作，可以参考探探的动画效果，即"跳过"就向左滑，
 * >   卡片往左边飞出去；"确认"就向右滑，卡片往右边飞出去。」
 *
 * ## 为什么方向映射要单独成函数，而不是在组件里写 `dir === 'confirm' ? 'right' : 'left'`
 *
 * 这句话是**交互契约**：想改方向（比如以后换成"跳过右飞"）只该改一处，
 * 而组件里那份三元表达式会被键盘、按钮、候选按钮三条路径各写一遍 —— 迟早漂移成
 * "按钮左飞、J 键右飞"。所以方向、时长、类名全部收在这一个文件，
 * 组件只问「confirm 该往哪儿飞」。
 *
 * ## 三档强度与项目的 `motionQuality` 对齐
 *
 * 与 `styles.css` 里的 `.folder-stage` / `.folder-anim-item` 磁贴动画**同一套分档思路**
 * （`smooth` 只吃合成层位移 / `balanced` 加旋转缩放 / `ultra` 上 3D），
 * 但这里是**单卡翻页**，不是列表错峰入场，所以：
 * - 不带 stagger（只有一张卡，没有"队列"可错峰）；
 * - 位移量按卡片宽度给（360 / 420px），不是磁贴的 26px。
 *
 * ⚠️ 这里是**唯一**的时长来源，`styles.css` 里那几个 `animation:` 的时长必须与本表一致
 * （`tests/triageSwipe.test.ts` 会去 styles.css 里核对，改一边不改另一边会红）。
 *
 * ## 无障碍
 *
 * `prefers-reduced-motion: reduce` 命中时**完全不做位移**，退化成 160ms 纯 opacity。
 * 这不是"降级体验"，是硬要求：位移动画对前庭功能障碍用户是真实的不适源。
 * 判断依据由调用方传入（组件用 `usePrefersReducedMotion()` 订阅系统偏好），
 * 本模块不碰 `window`，才能在 node 环境里单测。
 */

/** 飞出方向。`right` = 确认，`left` = 跳过（探探式） */
export type SwipeDir = 'left' | 'right'

/** 触发飞出的动作（与 `logic/triageFlow.ts` 的键位语义对齐：confirm / skip） */
export type SwipeAction = 'confirm' | 'skip'

/** 与 `shared/types.ts` 的 `settings.motionQuality` 同集合 */
export type SwipeMotionTier = 'smooth' | 'balanced' | 'ultra'

/**
 * 一次飞出 / 入场所需的时长与类名。
 *
 * 为什么 `outMs` / `inMs` 与 CSS 里的时长重复：`className` 才是真正生效的东西
 * （CSS 里写着 `animation: ... 250ms`），毫秒数在这里是**给测试与调用方读的契约值**。
 * 两处一致由 `tests/triageSwipe.test.ts` 的源码守卫保证，不靠自觉。
 */
export interface SwipeTiming {
  /** 飞出时长（ms） */
  outMs: number
  /** 下一张入场时长（ms） */
  inMs: number
  /** 挂到「卡片主体」上的飞出 class（还需叠加 `swipeDirClass()` 定方向） */
  className: string
  /** 下一张入场 class（方向仍由 `swipeDirClass()` 的 CSS 变量决定） */
  inClassName: string
}

/**
 * 三档强度表。
 *
 * - `smooth`  250ms：纯 `translate3d` + opacity。低端机只吃合成层位移，
 *   不带 rotate / perspective（与 `folder-tile-slide-*` 同一条取舍）。
 * - `balanced` 320ms：位移 + 6° 旋转 + 0.96 缩放 + 24px 下坠。
 *   那个 `24px` 的 y 位移是**刻意**的：探探那种"甩出去"的手感来自卡片不是水平滑走，
 *   而是带一点下坠的抛物线，纯水平位移会显得像"抽屉滑出"。
 * - `ultra`   340ms：在 balanced 上叠 `perspective` + `rotateY`（与 `folder-tile-in-ultra`
 *   同款手法）。卡片看起来是"转着飞走"而不是"平移飞走"。
 */
const TIER_TIMING: Readonly<Record<SwipeMotionTier, SwipeTiming>> = {
  smooth: {
    outMs: 250,
    inMs: 200,
    className: 'triage-swipe-out-smooth',
    inClassName: 'triage-swipe-in'
  },
  balanced: {
    outMs: 320,
    inMs: 200,
    className: 'triage-swipe-out-balanced',
    inClassName: 'triage-swipe-in'
  },
  ultra: {
    outMs: 340,
    inMs: 200,
    className: 'triage-swipe-out-ultra',
    inClassName: 'triage-swipe-in'
  }
}

/**
 * 减少动效档：**三档共用同一组**（160ms 纯淡出 / 淡入）。
 *
 * 为什么三档都塌成一样：系统级无障碍偏好优先于用户选的性能档 —— 用户开了
 * "减少动效"，`ultra` 也不该给他 3D 旋转。位移全部压成 0，只剩 opacity。
 */
const REDUCED_TIMING: SwipeTiming = {
  outMs: 160,
  inMs: 160,
  className: 'triage-swipe-fade-out',
  inClassName: 'triage-swipe-fade-in'
}

/**
 * 取本次动画的时长与类名。
 *
 * @param motion  `settings.motionQuality`（缺省由调用方给 `'balanced'`）
 * @param reduced 系统是否命中 `prefers-reduced-motion: reduce`
 *
 * 未知档位（旧配置文件 / 手改库）落回 `balanced`，不抛错 —— 一个动画档位不认识
 * 不该让整个整理浮层打不开。
 */
export function swipeTimingOf(motion: SwipeMotionTier, reduced: boolean): SwipeTiming {
  if (reduced) return REDUCED_TIMING
  return TIER_TIMING[motion] ?? TIER_TIMING.balanced
}

/**
 * 动作 → 飞出方向（**交互契约唯一来源**）。
 *
 * 确认（归类成功）向右、跳过向左，与探探一致：右手向右"接受"，向左"略过"。
 */
export function swipeDirOf(action: SwipeAction): SwipeDir {
  return action === 'confirm' ? 'right' : 'left'
}

/**
 * 方向 → 挂到卡片主体上的 class。
 *
 * 不在这里拼 `translate3d(±420px)`：方向在 CSS 里由 `--triage-dir: 1 | -1` 表达，
 * 一份 `@keyframes` 服务两个方向（`calc(var(--triage-dir) * 420px)`）——
 * 否则左右各写一套 keyframes，三档就是六份几乎相同的 `@keyframes`，改一处漏一处。
 */
export function swipeDirClass(dir: SwipeDir): string {
  return dir === 'right' ? 'triage-swipe-right' : 'triage-swipe-left'
}

/**
 * 动画类名合成：档位 class + 方向 class。
 *
 * 抽成函数是为了让组件里那一行不至于长到看不清，也让测试能直接断言
 * 「confirm 出来的是 right 那一组」而不必解析 JSX。
 */
export function swipeClassOf(timing: SwipeTiming, dir: SwipeDir, out: boolean): string {
  return `${out ? timing.className : timing.inClassName} ${swipeDirClass(dir)}`
}
