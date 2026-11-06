# ID BOX · SketchUp 插件 —— lib/panel_callback.rb（回调集中分发 + 可重绑）
#
# 加载顺序（docs/42 §3.2）：序 4，早于 lib/panel_dialog ——
# ⚠️ 本文件**加载期不得引用 `Panel` 常量**：`bind(dialog, panel)` 通过参数拿实例，
#    这样即使它先于 panel_dialog 加载也不会 NameError（docs/42 §2 文件 6 / §3.2 序 4）。
#
# 为什么单独成一层（docs/42 §2 文件 6）：
#   官方 add_action_callback 的 Note（api-report §5【查证】）：
#   「When an HtmlDialog is closed, all callbacks to that instance are cleared.
#    Attach or re-attach them before you show the dialog.」
#   ⇒ 回调注册必须是「可重绑」的形状，而不是只在建窗时注册一次。
#   本层把回调名收口进 CALLBACK_NAMES，把注册动作收口进 bind，
#   T04 实现 show 的重绑分支时只需再调一次 bind，不需要改这里的回调体。
#
# 防误抄纪律（docs/42 §5.4 / api-report §16）：**抄机制、不抄分支**。
#   api-report 里两段 toggle 片段是 show 语义（照抄会导致第二次点击关不掉）；
#   正确机制是 `visible? ? close : (bind_callbacks + show)`。
#   T04 已在 lib/panel_dialog.rb 落地 `close` / `visible?` / `toggle`（本层只提供机制）。
#
# 重绑安全性的依据（T04 补写，卡面要求必须在注释里写明）：
#   【查证】官方 Note 只明文「closed ⇒ all callbacks to that instance are cleared，
#     Attach or re-attach them before you show」——即官方预设「同实例重绑再 show」这条路径。
#   【推断】同名回调是**覆盖而非叠加**：因此每次 show 前重复 bind 同一组名字不会累积多份
#     handler、不会导致一次 click 触发两次 insertRecord。官方文档**没有**明文这条覆盖语义
#     （api-report 全文 grep 未找到逐字依据）⇒ 本处如实标注为【推断】，不当作【查证】，
#     列 QA 真机观测项（关窗再开、单次 click 只插一次）。
#
# 硬约束（不得放开）：
#   - 回调契约只增不删（A8 / docs/42 §1.2 不变量 2）：
#     JS 侧 `sketchup.ready()` / `refreshIndex()` / `insertRecord(id)`，
#     Ruby 注入 `window.IDBOX.render(payload)` / `window.IDBOX.setStatus(obj)`。
#     CALLBACK_NAMES 必须与 panel.html:10-23 的契约逐字一致（大小写照抄）。
#   - 零网络、零原生件、零写盘（本文件不写任何盘，也不调用 Diagnostics）；
#   - 顶层必须在 `module IDBoxPanel` 内、禁止全局变量（A7）；
#   - 只用官方 ≤2021 的 HtmlDialog 方法（A4 / docs/39 §4.4：无 set_min_size、不用 hide、
#     不用 set_can_close）。
#
# 兼容性：Ruby 2.7（SU 2021+ 门槛）。

module IDBoxPanel
  # ── 回调注册（注册 + 可重绑；名字与 panel.html 契约逐字一致） ────────────────
  module PanelCallback
    module_function

    # A8 契约名：JS 里调用的三个 action_callback，逐字照抄 panel.html:10-23。
    # 顺序即注册顺序；不要改名、不要增删（只增不删）。
    CALLBACK_NAMES = %w[ready refreshIndex insertRecord].freeze

    # dialog：UI::HtmlDialog 实例；panel：Panel 实例（加载期不解析 Panel 常量，
    # 靠参数传入 ⇒ 本文件可以排在 panel_dialog 之前加载，见 docs/42 §3.2 序 4）。
    #
    # 回调体一律委托给 panel 的 on_* 方法，本层不写业务逻辑，也不吞异常
    # （异常由 panel.on_* 自己 rescue 成用户可读文案，见 lib/panel_dialog.rb）。
    def bind(dialog, panel)
      return false if dialog.nil? || panel.nil?

      # ready：面板初始化（panel.html 加载完第一帧后调用）
      dialog.add_action_callback('ready') { |_context| panel.on_ready }

      # refreshIndex：用户手动点「刷新」
      dialog.add_action_callback('refreshIndex') { |_context| panel.on_refresh }

      # insertRecord(id)：点一下即插入（A14：不做二次确认）
      dialog.add_action_callback('insertRecord') { |_context, record_id| panel.on_insert(record_id) }

      true
    rescue StandardError => error
      # 注册失败只暴露真实异常（docs/42 §7.3），**不写盘**（A6）。
      puts("[ID BOX] callback bind failed: #{error.class}: #{error.message}")
      false
    end
  end
end
