import { useEffect, useState } from 'react'
import { useVault } from '../store'
import { graceSecondsLeft } from '../logic/deleteFlow'
import { resolveUndoTarget, shouldRenderBubble } from '../logic/noticeLifecycle'
import { IconClose } from '../icons'

/**
 * **屏幕底部居中的临时气泡**（2026-11-13 用户改口后的口径）。
 *
 * 用户原话（按时间先后，两代口径都要留档）：
 * > 2026-11-10：「排查一下底部的这一类弹窗提示，全部把它编到中间来做临时弹窗气泡。」
 * > 「2026-11-10 晚逐条弹窗确认：三类内容全部搬到屏幕居中气泡（不是只搬纯文字提示）。
 * >   底部通栏整条取消。」
 * > 2026-11-13：「弹窗气泡往屏幕下方移啊，你现在给我做在正中央的。」→ 弹窗拍板：
 * >   **底部居中贴底（约 16px），导入队列上移让位**；✕ 保留作兜底；时长统一 3 秒。
 *
 * ## 形态变化
 * 旧实现是 `App` 根 flex column 的**第三行真实布局行**（`h-11 shrink-0 border-t bg-toast`），
 * 有内容时吃掉 44px 窗口高度、且没有任何关闭出口。现在整条取消，三类内容
 * （`notice` 轻提示 / `grace` 删除撤销 / `assignGrace` 归类撤销）全部装进一个
 * `fixed` + `bottom-4 left-1/2 -translate-x-1/2` 的**底部居中**气泡（最下一条给气泡）：
 * - 容器 `pointer-events-none`（不挡网格/详情面板的点击），气泡本体 `pointer-events-auto`；
 * - 撤销按钮与 ✕ 都在气泡本体内，天然可点；
 * - 全走既有 token（不自行取色）：`bg-card` / `border-panel-line` / `shadow-modal` /
 *   `rounded-modal` / `bg-success` / `text-danger` / `bg-accent` / `bg-accent-tint`；
 * - 宽度上限 `w-[min(420px,calc(100vw_-_48px))]`（与 `ImportQueue` 同一档，窄窗口留 24px 边距）。
 *
 * `fixed` 元素不参与 flex 布局 → App 根不再有这一行，三列区自然拿回原来的 44px。
 *
 * ## 底部空间分配（2026-11-13 拍板）
 * 气泡拿最下一条 = `bottom-4`（16px）。`ImportQueue` 原来占的 `bottom-3` 让位上移到
 * `bottom-16`（64px）：气泡本体高约 44px（单行 13px 文字 + py-3.5），16 + 44 = 60，
 * 队列底边落在 64px → 两者**最少的可视间隙约 4px**；气泡若带撤销条会更高（约 76px），
 * 那种情况下队列会与之贴得很近甚至叠，但因为两者都只在各自有内容时渲染，实际同屏概率低。
 * ⚠️ 不许把气泡改成动态 bottom（会与队列互相抖）。锚点各自固定：气泡 `bottom-4`、队列 `bottom-16`。
 *
 * ## 层级
 * `z-48` = `logic/zStack.ts` 的 `Z_NOTICE_BUBBLE`：**高于舞台球 45、低于最底层弹窗 50**。
 * ⚠️ Tailwind 扫描式生成，类名必须写字面量 `z-48`（不能拼模板串），且 `48` 已同步登记进
 * `tailwind.config.js` 的 `theme.extend.zIndex`。
 *
 * ## 「从底层规避提示不消失」——本组件**不再持有任何 notice 消失计时器**
 * 旧代码 `:46-50` 在组件里起了一个 4.5 秒的 `setTimeout`，回调把 `setNotice` 置回
 * `null`，再配一个 cleanup 里的 `clearTimeout` —— 这就是 bug 的根因：组件一旦在计时器触发前
 * 卸载（`<React.StrictMode>` 双挂载、ErrorBoundary
 * 「重新加载窗口」重建整棵树），计时器被清掉、再没人重新排期 → `notice` 永久残留。
 *
 * 现在到期清理归 **store 状态层**（`logic/noticeLifecycle.ts` 的模块作用域 `NoticeRuntime`）：
 * 每条 notice 带绝对 `expiresAt` + 来源 `id`，超时回调按 id 校验再清；组件卸载/重挂/重载
 * 都不影响状态层计时器。本组件退化成**纯渲染**（state → UI），只保留两个撤销倒计时
 * （它们不是 notice 的消失计时器，语义必须保持不变）。
 *
 * ✕ 走新增的 `dismissNotice()` action，给用户一个手动关闭出口。
 *
 * ## 内容口径（与旧通栏逐字一致）
 * - 左/上：绿圆勾 + 结果文字；
 * - 右/下：撤销条——删除（「删除「资产名」」）或拖拽归类（「已归类 N 个到「一级 / 二级」」），
 *   蓝底「撤销 Ns」倒计时按钮，归零自动收尾。**不新造 toast**。
 * - 两个撤销条同时存在时**删除优先**：删除是「文件将消失」的不可逆动作，注意力先给它
 *   （判据已抽成纯函数 `resolveUndoTarget`，可在无 jsdom 的 node 环境单测）。
 * - `graceMs === 0`（设置里选「不等待」）时 store 直接 `commitDelete()`，永不进入
 *   `grace` 阶段 → 天然渲染不出撤销条，这里不需要任何特判。
 *
 * ⚠️ ✕ **只在 `notice` 在场时**出现：删除/归类撤销条是「有倒计时终态」的状态机，点 ✕
 * 关闭它既不能当撤销（会误保留文件）也不能当收尾（会提前删文件），语义上不成立。
 * 这类气泡靠倒计时归零自动收尾，撤销按钮本身就是出口。
 */
export function NoticeToast() {
  const notice = useVault((s) => s.notice)
  const dismissNotice = useVault((s) => s.dismissNotice)
  const pending = useVault((s) => s.pendingDelete)
  const undoDelete = useVault((s) => s.undoDelete)
  const commitDelete = useVault((s) => s.commitDelete)
  const pendingAssign = useVault((s) => s.pendingAssign)
  const undoAssign = useVault((s) => s.undoAssign)
  const commitAssign = useVault((s) => s.commitAssign)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [assignSecondsLeft, setAssignSecondsLeft] = useState(0)

  // ⚠️ 这里**故意没有** notice 的消失计时器（旧版是组件里的 4.5 秒 `setTimeout`）。
  // 消失计时器已整体搬到 store 状态层（见 `logic/noticeLifecycle.ts`）。组件卸载不再
  // 影响它，从底层杜绝「提示不消失」。以下两个 effect 只是撤销条的倒计时，不是它。

  // 撤销倒计时（grace 阶段）：归零自动 commitDelete —— 语义与旧通栏完全相同。
  useEffect(() => {
    if (!pending || pending.stage !== 'grace') return
    const tick = () => {
      const left = graceSecondsLeft(pending.startedAt, Date.now(), pending.graceMs)
      setSecondsLeft(left)
      if (left <= 0) void commitDelete()
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [pending?.stage, pending?.startedAt, pending?.graceMs, commitDelete])

  // 归类撤销倒计时：归零只清状态（归类已落盘，到期 = 放弃撤销），不做任何回滚。
  useEffect(() => {
    if (!pendingAssign) return
    const tick = () => {
      const left = graceSecondsLeft(pendingAssign.startedAt, Date.now(), pendingAssign.graceMs)
      setAssignSecondsLeft(left)
      if (left <= 0) commitAssign(pendingAssign.startedAt)
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [pendingAssign?.startedAt, pendingAssign?.graceMs, commitAssign])

  const hasNotice = Boolean(notice)
  const hasDeleteGrace = pending !== null && pending.stage === 'grace'
  const hasAssignGrace = pendingAssign !== null

  // 纯函数判据：三类内容任一在即渲染；两个撤销条同时存在时删除优先。
  if (!shouldRenderBubble(hasNotice, hasDeleteGrace, hasAssignGrace)) return null
  const undoTarget = resolveUndoTarget(hasDeleteGrace, hasAssignGrace)

  const grace = undoTarget === 'delete' ? pending : null
  const assignGrace = undoTarget === 'assign' ? pendingAssign : null

  const count = grace ? grace.ids.length : 0
  const name = grace
    ? count === 1
      ? (grace.targets[0]?.name ?? '')
      : `${count} 个资产`
    : ''

  // 有 notice 时，下方撤销区补一条分隔线；只有撤销条时不加，避免气泡里出现孤零零的横线。
  const rowClass = hasNotice
    ? 'flex items-center justify-between gap-2.5 border-t border-panel-line pt-2.5'
    : 'flex items-center justify-between gap-2.5'

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-48 -translate-x-1/2">
      <div className="pointer-events-auto flex w-[min(420px,calc(100vw_-_48px))] flex-col gap-2.5 rounded-modal border border-panel-line bg-card px-4 py-3.5 shadow-modal">
        {/* 上：绿圆勾 + 结果文字 + 手动关闭 ✕（走状态层 dismissNotice，按 id 校验） */}
        {hasNotice && (
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </span>
            <span className="min-w-0 flex-1 break-words text-[13px] leading-5 text-secondary">
              {notice}
            </span>
            <button
              type="button"
              className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-primary"
              onClick={dismissNotice}
              title="关闭提示"
              aria-label="关闭提示"
            >
              <IconClose width={14} height={14} />
            </button>
          </div>
        )}

        {/* 下：删除撤销条（删除优先） */}
        {grace && (
          <div className={rowClass}>
            <span className="min-w-0 flex-1 truncate text-[12px] text-danger" title={`删除「${name}」`}>
              删除「{name}」
            </span>
            <UndoPill
              label={`撤销 ${secondsLeft}s`}
              title="撤销本次删除（宽限期内文件仍在原位）"
              onClick={undoDelete}
            />
          </div>
        )}

        {/* 下：归类撤销条（反馈 6d）：点「撤销」= 按原分类把目录再搬回去 */}
        {assignGrace && (
          <div className={rowClass}>
            <span
              className="min-w-0 flex-1 truncate text-[12px] text-secondary"
              title={`已归类 ${assignGrace.moved} 个到「${assignGrace.label}」`}
            >
              已归类 {assignGrace.moved} 个到「{assignGrace.label}」
            </span>
            <UndoPill
              label={`撤销 ${assignSecondsLeft}s`}
              title="撤销本次归类（按原分类搬回去；目标重名会自动加序号）"
              onClick={() => void undoAssign()}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 撤销按钮胶囊（删除 / 归类共用同一套画布样式）。
 *
 * B6#24（形态类按画布）：画布撤销区是「tint 胶囊包实心钮」两层——
 * 外层 r8 pad10 h28 gap8 `bg-accent-tint` / 内层 r6 pad8 h20 `bg-accent` 白字。
 * **不新造颜色**，全部走既有 token。搬到居中气泡后形态一个字未改。
 */
function UndoPill({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-toast-undo bg-accent-tint px-2.5">
      <button
        type="button"
        className="inline-flex h-5 items-center rounded-toast-undo-inner bg-accent px-2 text-[11px] font-semibold text-white transition"
        onClick={onClick}
        title={title}
      >
        {label}
      </button>
    </span>
  )
}
