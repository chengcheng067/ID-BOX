/**
 * 弹窗视觉层级（0.7.8 T-ZSTACK，用户 2026-10-26 真机反馈）。
 *
 * 用户原话：
 * > 「这个舞台球的层级还是有点太高了……是不是我们一切的新增的弹窗，就是新点出来的
 * >   弹窗都应该层级更高呢？现在舞台球的层级非常的高，这个应该是一个逻辑性上的一个 bug。」
 *
 * 两件事：
 * 1. **舞台球不再是最高层**：它是 `pointer-events:none` 的纯装饰，没有资格压过任何可交互
 *    元素。`MaterialStage` 用 `zIndex: 45`（见 `Z_STAGE_BALL`）—— 高于全部内容层（≤40）、
 *    低于最底层弹窗（50）。
 * 2. **弹窗层级随 Esc 层栈递增**：第 1 层 50、第 2 层 60、第 3 层 70、第 4 层及以后 80。
 *
 * 为什么必须由**层栈深度**算、而不是各弹窗自己写死一个更大的数：
 * 用户的诉求是「新点出来的弹窗在上」。这条规则的权威来源已经是 `logic/escLayer.ts` 的栈
 * （它决定 Esc 归谁，也就是「谁在最上」）。视觉层级若另立一套来源，两者迟早错位，出现
 * 「看着在上层、Esc 却答下层」的错配 —— 那正是本模块只提供一个纯函数、不持有任何状态的
 * 原因：**唯一来源是层栈，这里只做「深度 → z-index」的换算**。
 *
 * 封顶（`Z_MODAL_MAX_LAYERS = 4`）的理由：正常使用不会叠超过 3 层（设置 + 渲染 + 确认），
 * 无上限递增会让任何新弹窗都能把 z-index 推到四位数，调试时无从判断真实层次；封顶后
 * 第 4 层及以后同高，由 DOM 顺序决定（后挂载的在后 → 在上），与浏览器默认行为一致。
 */

/** 最底层弹窗的 z-index：比全部内容层（≤40）高，比舞台球（45）高 */
export const Z_MODAL_BASE = 50

/** 每多叠一层，z-index 抬高多少 */
export const Z_MODAL_STEP = 10

/** 参与抬升的最大层数（第 4 层及以后同高 = 80） */
export const Z_MODAL_MAX_LAYERS = 4

/** 舞台球的 z-index：低于所有弹窗（≥50），高于所有内容层（≤40） */
export const Z_STAGE_BALL = 45

/**
 * 深度 → z-index（纯函数，可单测）。
 *
 * 脏值兜底（`depth` 可能在首帧是 0、也可能是 NaN）：一律按第 1 层处理 → 50。
 * 不抛错是刻意的 —— 层级算错只是叠放顺序难看，抛错会让整个弹窗不渲染。
 */
export function zIndexOfDepth(depth: number): number {
  const safe = Number.isFinite(depth) ? Math.floor(depth) : 1
  const layer = Math.min(Math.max(safe, 1), Z_MODAL_MAX_LAYERS)
  return Z_MODAL_BASE + (layer - 1) * Z_MODAL_STEP
}

/**
 * 深度 → Tailwind 的 z-index 类名（纯函数，可单测）。
 *
 * ⚠️ 这里写成**字面量数组**而不是 `z-${n}` 模板串：Tailwind 是源码扫描式生成 CSS，
 * 模板串拼出来的类名它看不到 → 产物里没有 `.z-60`，弹窗会全部退回文档流默认层级
 * （表现为「叠放顺序随机」）。`tailwind.config.js` 也据此把 60/70/80 补进了
 * `theme.extend.zIndex`（默认只有 0/10/20/30/40/50，`z-60` 不配置根本不存在）。
 */
const Z_CLASS_BY_DEPTH: readonly string[] = ['z-50', 'z-60', 'z-70', 'z-80']

/** 深度 → Tailwind 类名（1 → `z-50`；第 4 层及以后封顶 `z-80`；脏值兜底 `z-50`） */
export function zClassForDepth(depth: number): string {
  const safe = Number.isFinite(depth) ? Math.floor(depth) : 1
  const layer = Math.min(Math.max(safe, 1), Z_MODAL_MAX_LAYERS)
  return Z_CLASS_BY_DEPTH[layer - 1]
}
