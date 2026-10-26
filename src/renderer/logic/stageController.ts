/**
 * 舞台的**进程内单例**（A 线 T-03 接线用）。
 *
 * 为什么不让 App 用 props 传下去：双击发生在 `AssetGrid` 深处（卡片 inline 渲染，
 * 中间还隔着虚拟滚动），而舞台挂在 App 根节点。如果一路透传回调，中间每一层都要加
 * 参数，且虚拟化回收卡片时 props 会跟着消失。用一个小单例 + 订阅，两端各取所需。
 *
 * 纪律：
 * - 状态机全部委托给 `ballStage.ts` 的纯函数，这里**不写任何 if/else 判定**，
 *   否则判定逻辑就会有两份（一份在纯函数里被测，一份在这里没被测）；
 * - 只暴露"拍快照 → 开门"这一个入口，`rect` 必须在 dblclick 的**同步段**传入。
 */
import {
  STAGE_IDLE,
  abort as abortFn,
  beginClose,
  beginHandback,
  beginHandoff,
  beginOpen,
  settleActive,
  settleHandback,
  settleHandoff,
  sweep,
  type StageState
} from './ballStage'

let state: StageState = STAGE_IDLE
const listeners = new Set<() => void>()

/**
 * 预热目标（hover 预加载）。**与 StageState 分开一个快照**：
 * 合成一个对象会让 useSyncExternalStore 每帧拿到新引用 → 无限重渲染。
 */
let previewId: string | null = null
const previewListeners = new Set<() => void>()

function emit(next: StageState): void {
  state = next
  listeners.forEach((fn) => fn())
}

function emitPreview(next: string | null): void {
  if (next === previewId) return
  previewId = next
  previewListeners.forEach((fn) => fn())
}

/**
 * 哪些资产该有材质球：**只有材质类**（`texture` / `material`）。
 * 模型（model）、HDRI、其他都不生成 —— 它们没有 PBR 槽位，出球既无意义又会白解码贴图。
 */
export function canStage(asset: { kind: string }): boolean {
  return asset.kind === 'texture' || asset.kind === 'material'
}

export const stageController = {
  /** useSyncExternalStore 的快照读法（必须返回稳定引用，不能每次新建对象） */
  get: (): StageState => state,

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  /** 预热快照（hover 时先让球把该资产的贴图解码好，双击就不掉帧） */
  getPreview: (): string | null => previewId,

  subscribePreview(fn: () => void): () => void {
    previewListeners.add(fn)
    return () => {
      previewListeners.delete(fn)
    }
  },

  /**
   * hover 预热：只在 idle 阶段接受，避免干扰正在演的过场。
   *
   * ★ 性能修复 G（docs/26 §4-G，第二批只写契约，接线在 `AssetGrid`）：
   * 传 `null` = **撤回预热**。契约是「球保持当前贴图不动，不卸载」——
   * `App.tsx` 把 `previewId` 映射成 `asset=null` 交给 `MaterialStage`，
   * 而它只在 `asset` 非空时更新 `shownRef`（`MaterialStage.tsx:227`），
   * 所以 `MaterialBall` 既不换 `urls`、也不卸载（`deps: []` 的建场景 effect 不受影响）。
   *
   * 为什么这里已经能接受 `null`：① `emitPreview` 对 `null` 有 `if (next === previewId) return`
   * 的短路；② `MaterialStage` 有 `if (!shown) return null` 兜底（真正的空态才卸载）。
   * **目前 `AssetGrid` 的 `onPointerLeave` 还没有调用它**（那是禁止本批修改的文件），
   * 所以「快速划过一排卡不再白解码」这条收益要等下一批接线（docs/29 §5 第 1 条）。
   */
  preview(assetId: string | null): void {
    if (state.phase !== 'idle') return
    emitPreview(assetId)
  },

  /** 双击：同步拍 rect 快照 → opening */
  open(assetId: string, rect: DOMRect): void {
    emit(beginOpen(state, { assetId, rect }))
  },

  /** 入场动画演完（只有本轮 runId 能落定） */
  settled(runId: number): void {
    emit(settleActive(state, runId))
  },

  /**
   * 「自定义渲染」弹窗接管这颗球：把球从顶栏槽位飞到弹窗里那颗球的位置。
   * `rect` 由弹窗按自己的 canvas 与 `sphereScreenDiameter()` 算出（同步段传入）。
   * 纯函数里判定来源相位与 handedOff，这里只 emit。
   */
  handoff(rect: DOMRect): void {
    emit(beginHandoff(state, rect))
  },

  /** 交接动画演完（runId 守卫）：phase back to active + handedOff=true（舞台球隐身） */
  settledHandoff(runId: number): void {
    emit(settleHandoff(state, runId))
  },

  /**
   * 关弹窗 / 保存：球从弹窗位置飞回**顶栏槽位**（不是回网格卡片）。
   * 与 `close()`（退文件视图 → 回卡片）是两个方向，别互相替代。
   */
  handback(): void {
    emit(beginHandback(state))
  },

  /** 回槽位动画演完（runId 守卫）→ active，球继续留在顶部可见 */
  settledHandback(runId: number): void {
    emit(settleHandback(state, runId))
  },

  /** Esc / 返回 / 关掉文件视图 → closing */
  close(): void {
    emit(beginClose(state))
  },

  /** 返回动画演完 → idle */
  swept(runId: number): void {
    emit(sweep(state, runId))
  },

  /** 资产被删等外部事件：直接回 idle，不播动画 */
  abort(): void {
    emit(abortFn(state))
  }
}
