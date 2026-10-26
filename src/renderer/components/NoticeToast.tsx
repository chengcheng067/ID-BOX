import { useEffect, useState } from 'react'
import { useVault } from '../store'
import { graceSecondsLeft } from '../logic/deleteFlow'

/**
 * 底部合并 toast（UI 设计规范 v0.2 §3.5，高 44 通栏）—— **文档流里的真实布局行，不是浮层**。
 *
 * 2026-10 用户裁定：原来这条是 `position: fixed` 的浮层（`fixed inset-x-0 bottom-0 z-40`），
 * 会盖住它下面的任何东西 —— 左下侧栏的「设置」行、右侧详情面板的底部操作行（红色「删除」钮）
 * 都被压住/看起来被裁切。现在它是 `App` 根 flex column 的第三行：
 * `Toolbar` → 三列区 → 本行。所以它不再遮挡任何东西，代价是窗口可用高度少 44px。
 * ⚠️ 只在**有内容时**才占高度（`return null` 时这一行不存在，网格/详情面板拿回全部高度），
 * 这与浮层「显示时才出现」的语义一致，但现在是挤压布局而不是覆盖。`shrink-0` 保证三列区
 * 内容再长也不会把这条压扁（三列区是 `min-h-0 flex-1`，高度富余归它）。
 *
 * 原 `NoticeToast`（左下浮窗轻提示）与 `UndoToast`（居中撤销条）**合并为本组件**：
 * - 左：绿圆勾图标 + 结果文字（如「导入完成 3 个资产 · 已自动剔除 2 个杂质文件」）；
 * - 右：撤销条——删除（「删除「资产名」」）或拖拽归类（「已归类 N 个到「一级 / 二级」」），
 *   蓝底「撤销 Ns」倒计时按钮，归零自动收尾。**不新造 toast**：反馈 6d 明确要求
 *   「复用删除那套撤销机制」，所以归类撤销就长在同一条通栏里，只是文案与回调不同。
 *
 * ⚠️ 删除撤销条的倒计时长度来自 `pendingDelete.graceMs`（设置·数据与备份「删除撤销期」，
 * 三档 0 / 3000 / 5000）。`graceMs === 0`（不等待）时 store 的 `confirmDelete()` **不会**
 * 进入 `grace` 阶段，因此本组件天然渲染不出撤销条 —— 这里不需要为 0 加任何特判：
 * `grace` 变量只在 `stage === 'grace'` 时非 null（见下方 `const grace = ...`）。
 * 归类撤销（`pendingAssign`）是**另一条链路**（`logic/dragAssign.ts`），固定 5 秒，不受该设置影响。
 *
 * 选型说明：两者互斥出现频率低、且都属「底部条状反馈」，合并后视觉只有一个落点，
 * 不再互相遮挡（原左下轻提示会被居中撤销条盖住）。轻提示 4.5 秒自动消失；
 * 撤销倒计时基于 `pending.startedAt` 绝对时间计算，不怕定时器漂移。
 */
export function NoticeToast() {
  const notice = useVault((s) => s.notice)
  const setNotice = useVault((s) => s.setNotice)
  const pending = useVault((s) => s.pendingDelete)
  const undoDelete = useVault((s) => s.undoDelete)
  const commitDelete = useVault((s) => s.commitDelete)
  // 拖拽归类撤销（反馈 6d）：与删除撤销共用同一条底部通栏、同一套倒计时/按钮样式
  const pendingAssign = useVault((s) => s.pendingAssign)
  const undoAssign = useVault((s) => s.undoAssign)
  const commitAssign = useVault((s) => s.commitAssign)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [assignSecondsLeft, setAssignSecondsLeft] = useState(0)

  // 轻提示 4.5 秒自动消失；可被下一条覆盖
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice, setNotice])

  // 撤销倒计时（grace 阶段）：归零自动 commitDelete
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

  // 归类撤销倒计时：归零只清状态（归类已落盘，到期 = 放弃撤销），不做任何回滚
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

  const grace = pending && pending.stage === 'grace' ? pending : null
  // 两个撤销条同时存在时**删除优先**：删除是「文件将消失」的不可逆动作，注意力先给它
  const assignGrace = grace ? null : pendingAssign
  if (!notice && !grace && !assignGrace) return null

  const count = grace ? grace.ids.length : 0
  const name = grace
    ? count === 1
      ? (grace.targets[0]?.name ?? '')
      : `${count} 个资产`
    : ''

  // B6#22（形态类按画布）：画布 `2:168` 底是 #F8FAFC（canvas 灰）不是白卡，
  // 描边 #E8EDF2（= --border-panel）；深 `2:446` #161618 + #2A2A2D。
  // 通栏直角条形态本就与画布一致（画布 cornerRadius 0），只补底色与描边档。
  // B5 口径「按画布实测值」延伸到本条：pad20 / gap10（原 px-4 gap-3）。
  //
  // ⚠️ 2026-10 用户拍板：本条**不再是浮层**。原来是 `fixed inset-x-0 bottom-0 z-40`，
  // 它盖在它下面的任何东西之上 —— 左栏底部的「设置」行、右栏底部操作行都被压住
  // （用户截图里右栏最后一行残缺、红色「删」按钮被切就是这条造成的）。
  // 现在它是 `App` 根 flex column 里的**真实布局行**：Toolbar → 三列区 → 本行。
  // `shrink-0` 保证这一行不被三列区挤扁；组件返回 null 时不占任何高度（见上）。
  // 视觉 token 一个不动：h-11 / border-t border-panel-line / bg-toast / px-5 / gap-2.5。
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-t border-panel-line bg-toast px-5">
      {/* 左：绿圆勾 + 结果文字（§3.5） */}
      {notice && (
        <span className="flex min-w-0 items-center gap-2 text-[12px] text-secondary">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-white">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          <span className="truncate" title={notice}>
            {notice}
          </span>
        </span>
      )}

      <div className="flex-1" />

      {/* 右：撤销条（§3.5）——删除优先；删除不在场时显示归类撤销。
          只在 `stage === 'grace'` 时渲染：设置里选「不等待」（graceMs=0）时 store
          直接 commitDelete，永远到不了 grace → 这里不会出现倒计时条。 */}
      {grace && (
        <span className="flex shrink-0 items-center gap-2.5">
          <span className="max-w-[280px] truncate text-[12px] text-danger" title={`删除「${name}」`}>
            删除「{name}」
          </span>
          <UndoPill
            label={`撤销 ${secondsLeft}s`}
            title="撤销本次删除（宽限期内文件仍在原位）"
            onClick={undoDelete}
          />
        </span>
      )}

      {/* 归类撤销（反馈 6d）：归类已落盘，点「撤销」= 按原分类把目录再搬回去 */}
      {assignGrace && (
        <span className="flex shrink-0 items-center gap-2.5">
          <span
            className="max-w-[280px] truncate text-[12px] text-secondary"
            title={`已归类 ${assignGrace.moved} 个到「${assignGrace.label}」`}
          >
            已归类 {assignGrace.moved} 个到「{assignGrace.label}」
          </span>
          <UndoPill
            label={`撤销 ${assignSecondsLeft}s`}
            title="撤销本次归类（按原分类搬回去；目标重名会自动加序号）"
            onClick={() => void undoAssign()}
          />
        </span>
      )}
    </div>
  )
}

/**
 * 撤销按钮胶囊（删除 / 归类共用同一套画布样式）。
 *
 * B6#24（形态类按画布）：画布撤销区是「tint 胶囊包实心钮」两层——
 * 外层 `2:174` r8 pad10 h28 gap8 fill #E1EFFF（浅）/ `2:452` r7 #1E2A38（深）；
 * 内层 `2:176` r6 pad8 h20 fill #007AFF 白字 / `2:454` r5 #0A84FF。
 * 原实现是单个实心蓝胶囊（缺外层 tint），已补两层。**不新造颜色**，全部走既有 token。
 */
function UndoPill({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-toast-undo bg-accent-tint px-2.5">
      <button
        className="inline-flex h-5 items-center rounded-toast-undo-inner bg-accent px-2 text-[11px] font-semibold text-white transition"
        onClick={onClick}
        title={title}
      >
        {label}
      </button>
    </span>
  )
}
