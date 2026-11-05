# ID BOX · SketchUp 插件 —— lib/panel_dialog.rb（class Panel）
#
# 加载顺序（docs/42 §3.2）：序 5，必须在 core / paths / loader / panel_callback 之后 ——
#   - core：契约常量（DIALOG_*、POLL_SECONDS、MIN_SU_MAJOR、INSERTABLE_KINDS）+ Support + Messages + ErrCode
#   - paths：Paths.html_path（set_file）与 Diagnostics（**唯一写盘点**，只在建窗失败时调用）
#   - loader：Snapshot / Loader / Inserter
#   - panel_callback：PanelCallback.bind（注册 + 可重绑）
#
# T01 纪律：**行为不变**（1189 行 main.rb 里的 Panel 逐字搬迁）。
#   - `Panel#build_dialog` 的 rescue 纪律必须保留：失败必须留下**真实异常类 + message**，
#     不得把 NoMethodError 折成「找不到 panel.html」（1.0.1 的真机教训，docs/39 §4.4）；
#   - 成功路径零写盘（A6）：Diagnostics.write 只在 build_dialog 失败时调用；
#   - `toggle` 与 `show` 的「关窗后重绑」语义属 **T04**，本卡不改：
#     这里只把回调注册收口到 `PanelCallback.bind` 的调用点（T04 只需再调一次 bind），
#     `show` 的 else 分支保留重绑调用点（机制就位，判据不变）。
#   - `close` / `visible?` / `toggle` 三个方法名属 docs/42 §2 文件 7 的最终形状；
#     本卡 `toggle` 不实现（T04 的裁定：`visible? ? close : (bind + show)`，
#     ⚠️ 不得照抄 api-report 的 show 语义片段 —— 抄机制、不抄分支，docs/42 §5.4）。
#
# 硬约束（不得放开）：零网络 / 零原生件 / 零 token / 零端口 / 零后台服务（只有面板打开时的
# 3 s 轮询，面板关闭即 stop_timer）；只用官方 HtmlDialog 方法（无 set_min_size、不用 hide、
# 不用 set_can_close）；顶层在 `module IDBoxPanel` 内、无全局变量（A7）；
# 不得用 `__FILE__` 拼资源路径（路径统一走 Paths）。
#
# 兼容性：Ruby 2.7（SU 2021+ 门槛）。禁 Hash#except / endless method / => 右赋值 / pattern matching。

module IDBoxPanel
  # ── 面板（UI::HtmlDialog + panel.html） ────────────────────────────────────
  class Panel
    def self.instance
      @instance ||= Panel.new
    end

    def initialize
      @dialog = nil
      @timer = nil
      @snapshot = nil
      @signature = nil
      # build_dialog 失败的真实原因（上次 catch 把 NoMethodError 误报成"文件找不到"）
      @build_error = nil
    end

    def show
      # 门槛 SketchUp 2021+（docs/38 §8.1）：低于它不开面板，直接给 IDBOX-106
      current_major = Support.su_major_now
      if !current_major.nil? && current_major < MIN_SU_MAJOR
        UI.messagebox(Messages.with_code(ErrCode::SU_TOO_OLD, Messages.su_too_old(current_major)))
        return false
      end
      if @dialog.nil?
        unless build_dialog
          # 只在失败时写诊断（成功路径零写盘）；写不出来也不能影响弹窗
          diag_ok = Diagnostics.write(@build_error.to_s.empty? ? '(未知)' : @build_error)
          diag_hint = diag_ok ? "\n\n诊断已写入：#{Diagnostics.path}" : ''
          UI.messagebox(
            "ID BOX 面板打开失败。\n\n原因：#{@build_error.to_s.empty? ? '(未知)' : @build_error}\n\n" \
            "已尝试的 panel.html 路径：\n#{Paths.tried_paths_text()}#{diag_hint}"
          )
          return false
        end
      end
      reload
      begin
        if @dialog.visible?
          @dialog.bring_to_front
        else
          # 任务卡要求「`show` 内调用 `PanelCallback.bind` 的调用点要在」⇒ 这里就是那个调用点。
          # 官方 Note【查证】（api-report §5）：「When an HtmlDialog is closed, all callbacks to
          # that instance are cleared. Attach or re-attach them before you show the dialog.」
          # ⇒ 在 show 之前 re-attach 是官方推荐动作；add_action_callback 对同名回调是覆盖而非
          # 叠加，所以本卡加这一行不改变可观察行为（判据与 1.0.3 逐字一致）。
          # ⚠️ T04 才在这里补「关窗后重绑」的完整语义（`visible? ? close : (bind + show)`），
          #    本卡不写 toggle（抄机制、不抄分支，docs/42 §5.4）。
          # 冒烟场景 A 走的是上面的 bring_to_front 分支（桩 visible? 恒 true），判据未变。
          PanelCallback.bind(@dialog, self)
          @dialog.show
        end
      rescue StandardError
        begin
          @dialog.show
        rescue StandardError
          return false
        end
      end
      push_state
      start_polling
      true
    end

    def build_dialog
      @build_error = nil
      html = Paths.html_path
      if html.empty? || !File.file?(html)
        @build_error = "panel.html 不存在或不可读：#{html.empty? ? '(空路径)' : html}"
        return false
      end
      options = {
        :dialog_title => 'ID BOX',
        :preferences_key => 'idbox_panel_main_dialog',
        :scrollable => false,
        :resizable => true,
        :width => DIALOG_WIDTH,
        :height => DIALOG_HEIGHT,
        # min 尺寸只能走构造函数 options（官方支持的唯一写法）。
        # ⚠️ UI::HtmlDialog **没有** set_min_size（docs/39 §4.4：1.0.1 因此白跑两轮）。
        # 物理上的内容下限同时由 panel.html 的 CSS min-width/min-height 承担（T02）。
        :min_width => DIALOG_MIN_WIDTH,
        :min_height => DIALOG_MIN_HEIGHT,
        :style => UI::HtmlDialog::STYLE_DIALOG
      }
      @dialog = UI::HtmlDialog.new(options)
      @dialog.set_size(DIALOG_WIDTH, DIALOG_HEIGHT)
      # ⚠️ 不要调 set_min_size：**UI::HtmlDialog 没有这个方法**（官方 API 只有构造函数里的
      # :min_width / :min_height）。1.0.1 在这里抛 NoMethodError，被下面的 rescue 吞掉后
      # 被 show() 误报成「找不到 panel.html」——真机排查白跑了两轮。
      # 最小尺寸已在上面 options 里给了，这里不需要再设。
      @dialog.center
      @dialog.set_file(html)
      # 回调注册收口到 PanelCallback（注册 + 可重绑；名字与 panel.html 契约逐字一致，A8）。
      PanelCallback.bind(@dialog, self)
      @dialog.set_on_closed { stop_polling }
      true
    rescue StandardError => error
      # 失败必须留下**真实原因**：这句 rescue 曾经把 NoMethodError 伪装成"文件找不到"。
      @build_error = "#{error.class}: #{error.message}"
      # 把失败前已经调过的 dialog 方法也记下来（对照官方 API 一眼看出哪个方法不存在）
      begin
        if @dialog.respond_to?(:calls)
          @build_error = @build_error + "\n已调用的 dialog 方法: " + Diagnostics.describe_dialog(@dialog)
        end
      rescue StandardError
        nil
      end
      puts("[ID BOX] build dialog failed: #{@build_error}")
      @dialog = nil
      false
    end

    # ── 回调 ───────────────────────────────────────────────────────────────
    # 这三个方法被 lib/panel_callback.rb 通过参数（panel 实例）委托调用，
    # 因此必须在 Panel 上保持 public；名字与 A8 契约一一对应。
    def on_ready
      reload if @snapshot.nil?
      push_state
    rescue StandardError => error
      push_status('面板初始化失败：' + error.message, 'error')
    end

    def on_refresh
      reload
      push_state
      push_status('已重新读取索引。', 'info')
    rescue StandardError => error
      push_status('刷新失败：' + error.message, 'error')
    end

    def on_insert(record_id)
      snapshot = @snapshot
      if snapshot.nil? || !snapshot.ok?
        push_status('索引当前不可用，请先点「刷新」。', 'error')
        return
      end
      if snapshot.read_only?
        push_status('索引版本与插件不匹配（apiVersion 不是 "1"），插入已禁用。', 'error')
        return
      end
      record = snapshot.find(record_id)
      if record.nil?
        push_status('这条记录已不在当前索引里，请点「刷新」后重试。', 'error')
        return
      end
      unless INSERTABLE_KINDS.include?(Support.text(record['kind']))
        push_status(UNSUPPORTED_INSERT_HINT, 'warn')
        return
      end
      outcome = Inserter.insert(record, snapshot.manifest)
      if outcome[:ok]
        push_status(Support.text(outcome[:message]), 'ok')
      else
        text_value = Messages.with_code(outcome[:code], Support.text(outcome[:message]))
        push_status(text_value, 'error')
        messagebox(text_value)
      end
    rescue StandardError => error
      push_status(Messages.insert_exception(error.message), 'error')
    end

    # ── 数据流 ─────────────────────────────────────────────────────────────
    # 注意：@signature 用 Loader.signature（只读 manifest 的两个字段），而**不是**
    # Snapshot 自己的状态串 —— 否则「索引缺失」时会每 3 s 反复重读，形成无意义循环。
    def reload
      @signature = Loader.signature
      @snapshot = Loader.load
      @snapshot
    end

    # Ruby → JS 注入：window.IDBOX.render(payload) / window.IDBOX.setStatus(obj)
    # （A8 契约，只增不删；JSON 序列化走 Support.json_for_script，转义 U+2028/U+2029）
    def push_state
      return if @dialog.nil?
      snapshot = @snapshot
      snapshot = reload if snapshot.nil?
      json = Support.json_for_script(snapshot.to_payload)
      script = 'if (window.IDBOX) { window.IDBOX.render(' + json + '); }'
      begin
        @dialog.execute_script(script)
      rescue StandardError
        nil
      end
    end

    def push_status(text_value, level)
      return if @dialog.nil?
      json = Support.json_for_script('message' => Support.text(text_value), 'level' => Support.text(level))
      begin
        @dialog.execute_script('if (window.IDBOX) { window.IDBOX.setStatus(' + json + '); }')
      rescue StandardError
        nil
      end
    end

    def messagebox(text_value)
      UI.messagebox(Support.text(text_value))
    rescue StandardError
      nil
    end

    # ── 轮询（只在面板打开时跑；关闭即停，不常驻） ───────────────────────────
    def start_polling
      stop_polling
      begin
        @timer = UI.start_timer(POLL_SECONDS, true) { poll }
      rescue StandardError
        @timer = nil
      end
    end

    def stop_polling
      return if @timer.nil?
      begin
        UI.stop_timer(@timer)
      rescue StandardError
        nil
      end
      @timer = nil
    end

    def poll
      return if @dialog.nil?
      visible = begin
        @dialog.visible?
      rescue StandardError
        true
      end
      unless visible
        stop_polling
        return
      end
      current = Loader.signature
      return if current == @signature
      reload
      push_state
      push_status('检测到索引有更新，已重新读取。', 'info')
    rescue StandardError
      nil
    end
  end
end
