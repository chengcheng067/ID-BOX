/**
 * 「拖出到建模软件」的唯一入口（系统级拖拽）。
 *
 * ## 为什么必须 `preventDefault()`（2026-10 拖出闪退的根因）
 *
 * Electron 的系统级拖出是**两条独立原生拖拽**叠在同一个 UI 线程上：
 * ① 渲染进程自己的 HTML5 拖拽（`draggable` 元素 + `dragstart` 的默认动作）；
 * ② 主进程 `webContents.startDrag()` 发起的 OLE `DoDragDrop`。
 *
 * 不取消 ① 时，`startDrag` 在 ① 的拖拽会话里被调用 → 同一线程重入 `DoDragDrop`
 * → Windows 原生层直接崩（表现：日志只有 `drag:start`、没有 `drag:start:returned`，
 * 也没有 `fatal:uncaughtException`，进程消失后 4 秒重启；拖任何类型都崩）。
 *
 * `preventDefault()` 取消 ① 的默认动作 → 渲染进程不启动自己的拖拽会话，
 * 场上只剩 ② 这一次原生拖拽，不存在重入。
 *
 * ## 三条硬约束
 *
 * 1. **`preventDefault()` 必须是第一步**（先掐掉 ①，再发起 ②）；
 * 2. **归类抓手不得走本函数**（`AssetGrid` 的 `gripProps`）：抓手故意保留渲染进程的
 *    HTML5 拖拽，供左栏节点接收 `drop`（应用内归类）。给它 `preventDefault` 会掐死拖拽；
 * 3. 本函数是**纯逻辑**（不碰 `window`）：`startDrag` 由调用方注入，可在 vitest 直测。
 */

/** 只依赖用到的那几个成员，React / 原生 DragEvent 都结构化兼容（便于单测注入桩） */
export interface SystemDragEventLike {
  preventDefault(): void
  dataTransfer: {
    setData(format: string, data: string): void
    effectAllowed: string
  }
}

/**
 * 系统级拖出的时间窗（毫秒）。
 *
 * 为什么用时间窗而不是事件清除：主进程 `startDrag` 发起的 OLE 拖拽期间，
 * 渲染进程**收不到任何可用于清标志的 DOM 输入事件**（鼠标事件被 OS 拖拽循环接管），
 * 而拖拽结束后也没有对应的 `dragend` 会冒泡到 window（HTML5 拖拽已被 preventDefault 取消）。
 * 10 秒 = 一次人工拖拽操作的上限，足够覆盖「拖起来、犹豫一下、松手」。
 */
export const INTERNAL_DRAG_OUT_WINDOW_MS = 10_000

/** 最近一次系统级拖出的时间戳（0 = 从未发生） */
let lastInternalDragOutAt = 0

/**
 * 标记「刚刚发起过一次系统级拖出」。
 *
 * 由 `beginSystemDrag` 内部调用，调用方不需要关心。生产只有一个写入点，
 * 目的是让 `App` 的全窗拖拽监听能区分「这是卡片拖出被 OS 回放到窗口上的事件」
 * 与「用户从资源管理器拖了真文件进来」——两者的 `dataTransfer.types` 都是 `['Files']`，
 * 唯一可用的信号就是"我们自己刚刚发起过 OLE 拖拽"。
 */
export function markInternalDragOut(now: number = Date.now()): void {
  lastInternalDragOutAt = now
}

/** 是否处于「系统级拖出」的时间窗内（`windowMs` 仅供单测缩短窗口） */
export function isInternalDragOut(now: number = Date.now(), windowMs: number = INTERNAL_DRAG_OUT_WINDOW_MS): boolean {
  if (lastInternalDragOutAt <= 0) return false
  const elapsed = now - lastInternalDragOutAt
  // elapsed < 0（时钟回拨）也视为窗口内，避免因为系统时间跳变把遮罩闪出来
  return elapsed < windowMs
}

/**
 * 清空标记。
 *
 * 生产用途：`App` 的 window `drop` 里调用 —— 一次 `drop` 意味着上一个拖拽手势已经结束，
 * 此时再保留时间窗只会让**下一次**外部拖入短暂没有遮罩（10 秒盲区）。清掉它可以让
 * 「拖出后在窗口内松手 → 立刻从资源管理器拖一个包进来」这条路恢复正确的视觉反馈。
 * 其余场景（拖出去落在别的应用里）不会有 drop，只能等时间窗自然过期。
 */
export function resetInternalDragOut(): void {
  lastInternalDragOutAt = 0
}

/**
 * 发起**唯一一次**系统级拖出。
 *
 * @param ev        触发拖拽的事件（React 的 `onDragStart` 事件对象）
 * @param label     `text/plain` 兜底文案（文件行用文件名，卡片用资产名）
 * @param abs       要拖出的**绝对路径**（主进程据此构造 `file://` 图标与拖拽数据）
 * @param thumbName 拖拽图标用的缩略图缓存文件名；没有则传 `null`
 * @param startDrag 真正的主进程调用（生产传 `(abs, thumb) => window.modvault.startDrag(abs, thumb, cardPng)`）
 */
export function beginSystemDrag(
  ev: SystemDragEventLike,
  label: string,
  abs: string,
  thumbName: string | null,
  startDrag: (abs: string, thumbName: string | null) => void
): void {
  // ① 先取消渲染进程自己的 HTML5 拖拽（否则主进程的 startDrag 会和它重入 → 原生崩溃）
  ev.preventDefault()
  // ② setData 是 Chromium 认定「这是一次合法拖拽」的必要条件；内容无人消费，只作兜底
  ev.dataTransfer.setData('text/plain', label)
  ev.dataTransfer.effectAllowed = 'copy'
  // ③ 打时间窗标记：OLE 拖拽回到窗口上方时，全窗 dragenter/dragover 的 types 只是
  //    ['Files']，靠这个标记才能不上「松手即导入」遮罩（见 App 的 isInternalDragOut 用法）
  markInternalDragOut()
  // ④ 交给主进程：全场唯一的一次原生拖拽
  startDrag(abs, thumbName)
}
