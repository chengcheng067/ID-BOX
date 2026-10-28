/**
 * 全局 Esc 该谁吃（0.7.6 T-ESC）。
 *
 * 背景：`App.tsx` 原来的全局 Esc 尾部是**无条件** `select(null)` + `setSettingsOpen(false)`，
 * 前面只对 HDR 预览 / 删除确认 / 文件视图让路。于是「批量重命名」开着按 Esc 会先清空选中，
 * 右侧面板卸载但 `renameIds` 还在 → 弹窗悬空；封面选择器 / 彻底删除确认那种组件局部弹窗
 * 更是靠「选中被清 → 组件卸载」顺带关掉的，附带清空选择的副作用。
 *
 * 修法：把判断抽成**纯函数**（这里），App 只做 dispatch，不再往 JSX/事件回调里堆 if。
 * 判据按**栈顶优先**（后开的先吃）：弹窗层 > 危险确认 > 全屏预览 > 文件视图 > 清选中。
 *
 * 注意两类「局部 state 弹窗」（封面选择器 `coverPickerOpen`、彻底删除确认 `purgeIds`
 * 分别在 `DetailPanel` / `AssetGrid` 的局部 state 里）**不进这个函数的输入**：
 * 它们都由 `Modal` 承载，Esc 已经被 `Modal` 的捕获阶段监听消费并 `stopPropagation`
 * （见 `Modal.tsx`），全局监听根本收不到；把它们提到 store 只会为了一个 if 引入跨组件状态，
 * 收益为负。`modalOpen` 这一项就是那层保障的可测化表达。
 */

/** 全局 Esc 的动作标识（App 只按这个 dispatch，不做二次判断） */
export type EscAction =
  | 'none'
  | 'undo-delete'
  | 'close-rename'
  | 'close-category-picker'
  | 'close-settings'
  | 'close-folder-view'
  | 'close-quick-look'
  | 'clear-selection'

/** 判据输入：全部由调用方从 store / App state 现取，函数本身不读任何全局状态 */
export interface EscContext {
  /** 是否有弹窗层在吃 Esc（`hasEscLayer()`）。为 true 时 App 一个字都不做 */
  modalOpen: boolean
  /** HDR 预览：`HdrPreviewDialog` 自己监听 Esc，App 只让路 */
  hdrPreviewOpen: boolean
  /** 删除二次确认（含 5 秒宽限期，此时弹窗已收但 `pendingDelete` 还在） */
  pendingDelete: boolean
  /** 批量重命名弹窗（store 的 `renameIds`） */
  renameOpen: boolean
  /** 分类选择器（store 的 `categoryPickerIds`） */
  categoryPickerOpen: boolean
  /** 设置弹窗（App 的 `settingsOpen` 局部 state） */
  settingsOpen: boolean
  /** 软件内文件视图（store 的 `folderViewAssetId`） */
  folderViewOpen: boolean
  /** Quick Look 浮层（store 的 `quickLookAssetId`） */
  quickLookOpen: boolean
  /** 是否还有选中项可清 */
  hasSelection: boolean
}

/**
 * 按栈顶优先返回 Esc 动作。
 *
 * 顺序不能换：弹窗层在最前（它已经吃过按键，这里是双保险，避免事件阶段语义不可靠时
 * 一次按键关两层）；`pendingDelete` 在 `rename` 之前（删除是不可逆方向，先撤销它）；
 * `folderView` 在清选中之前（原行为：退回网格时选中态要留着）。
 *
 * 0.8.3 Quick Look：`quickLookOpen` 排在 `pendingDelete` 之前 —— 浮层是**视觉上最上的
 * 可交互层**（它盖在网格上，用户按 Esc 的直觉是"先退出眼前这一层"），所以必须先答它。
 * 而且它的答案是 `close-quick-look` 而不是 `clear-selection`：**关闭浮层不能顺手清掉
 * 选中**。Quick Look 的作用就是"在保持选中的前提下比素材"（选中集 ≥2 时浮层就是这几张
 * 之间的序列），如果 Esc 退浮层时把选中清了，用户退回网格后得重新选一遍 —— 这正是
 * `folderView` 当年被单独列在清选中之前的同一条理由。第二次 Esc（浮层已关）才走
 * `clear-selection`。
 */
export function decideEsc(ctx: EscContext): EscAction {
  if (ctx.modalOpen) return 'none'
  if (ctx.hdrPreviewOpen) return 'none'
  if (ctx.quickLookOpen) return 'close-quick-look'
  if (ctx.pendingDelete) return 'undo-delete'
  if (ctx.renameOpen) return 'close-rename'
  if (ctx.categoryPickerOpen) return 'close-category-picker'
  if (ctx.settingsOpen) return 'close-settings'
  if (ctx.folderViewOpen) return 'close-folder-view'
  if (ctx.hasSelection) return 'clear-selection'
  return 'none'
}
