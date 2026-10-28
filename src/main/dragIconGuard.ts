/**
 * drag:start 图标兜底决策（0.8.3 P0 崩溃修复 —— 纯逻辑，不 import electron，可在 vitest 直测）。
 *
 * ## 崩溃现场（外部用户 v0.8.2 日志实锤，2026-10-28 07:27:40 UTC）
 *
 * ```
 * [ERROR] fatal:uncaughtException
 *   Error: Failed to load image from path 'C:\...\Temp\idbox-drag-card.png'
 *     at IpcMainImpl.<anonymous> (out/main/index.cjs:7982:16)
 * ```
 *
 * 根因：`webContents.startDrag({ icon: <字符串路径> })` 时，Electron 会在 native 内部
 * 自己 `nativeImage.createFromPath(路径)`，**读成空图直接 throw** —— 异常从 ipcMain
 * 处理器冒出去就成了 uncaughtException。而刚写进系统 Temp 的 PNG 可能被杀软
 * （Defender 等）以独占锁瞬时扫描，间歇性读成空图（同一用户 6 秒后重拖即成功
 * = 典型的瞬时锁竞态，不是确定性 bug）。
 *
 * ## 决策
 *
 * 主进程在把路径交给 `startDrag` **之前**，同步段里自己先读一遍：
 * - 读得出来且非空 → 原样把路径交给 `startDrag`（Windows 只有「icon 为路径」
 *   那条分支才会真正采用拖拽影像，见 `resolveDragCard` 的注释，不能改传内存图）；
 * - 空图 / 读抛错 → 降级为**内嵌图标**（永远在内存里、startDrag 必不再抛
 *   "Failed to load image"），文件本体照拖 —— 拖拽可用性优先于图标观感。
 *
 * 调用方（`main/index.ts` 的 dragStart 处理器）注入真实的 `nativeImage`，
 * 这里保持纯函数以便单测注入桩。
 */

/** 降级原因：路径读成空图 / 路径读取抛错 */
export type DragIconGuardReason = 'decode-empty' | 'decode-error'

/** 注入的依赖（生产用 `nativeImage`，测试用桩） */
export interface DragIconGuardDeps<Img> {
  /** 按路径读图；文件不存在 / 解码失败时**抛错**，读成空图时返回 `isEmpty()` 为真的图 */
  loadFromPath: (p: string) => Img
  /** 图片是否为空（对应 `NativeImage.isEmpty()`） */
  isEmpty: (img: Img) => boolean
  /** 内嵌兜底图标（每次调用现造一个；startDrag 收到内存图不会再抛路径加载错） */
  makeEmbedded: () => Img
}

export interface DragIconGuardResult<Img> {
  /** 守卫后可安全交给 `startDrag` 的图标（原路径 / 内嵌图二选一） */
  icon: string | Img
  /** 是否发生了降级（调用方据此记 `drag:icon-missing`） */
  degraded: boolean
  reason: DragIconGuardReason | null
}

/**
 * 路径型图标的自验兜底。
 *
 * - `icon` 已经是内存图（NativeImage，如内嵌档）→ 原样通过，不再校验；
 * - `icon` 是路径 → `loadFromPath` 抛错或读成空图都降级内嵌，**本函数自身不 throw**。
 */
export function guardDragIconPath<Img>(
  icon: string | Img,
  deps: DragIconGuardDeps<Img>
): DragIconGuardResult<Img> {
  // 内存图不存在「路径加载失败」这一失败模式，直接放行
  if (typeof icon !== 'string') {
    return { icon, degraded: false, reason: null }
  }
  let img: Img
  try {
    img = deps.loadFromPath(icon)
  } catch {
    // 文件被删 / 被独占锁锁死读不出来 → 降级，绝不把异常抛给调用方
    return { icon: deps.makeEmbedded(), degraded: true, reason: 'decode-error' }
  }
  if (deps.isEmpty(img)) {
    // 杀软瞬时扫描锁最常见的表现：读到了文件但解码为空
    return { icon: deps.makeEmbedded(), degraded: true, reason: 'decode-empty' }
  }
  return { icon, degraded: false, reason: null }
}
