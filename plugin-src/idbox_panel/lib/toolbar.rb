# ID BOX · SketchUp 插件 —— lib/toolbar.rb（UI::Toolbar + UI::Command）
#
# 加载顺序（docs/42 §3.2）：序 6，**必须最后** —— 命令 block 只在运行时解析
# `IDBoxPanel::Panel.instance.toggle`，加载期不解析 Panel 常量（Panel#toggle 属 T04，
# 本文件不实现它）。main.rb 的 guard 块已预留 `Toolbar.build if defined?(Toolbar)`，
# 本文件落地后自动生效，main.rb 只补一行 Sketchup.require。
#
# 依据口径（docs/42 §4 的反推链是【推断】，施工一律以 docs/42 + api-report 为准）：
#   - `【查证】` `UI::Command.new(menutext) { ... }`、`small_icon=` / `large_icon=` /
#     `tooltip=` / `status_bar_text=` / `menu_text=` 全是**实例 setter**（不是构造参数）、
#     `UI::Toolbar.new(name)`（参数是显示名）、`add_item(cmd)` ⇒ 返回 toolbar 自身：
#     `api-report §1:58-87`、`§2:110-136`、`§9` R2/R4/R5/R6/R7/R8。
#   - `【查证】` guard（`Tools/sketchup.rb`）注释明说防 "duplicate menus and **toolbars**"
#     ⇒ 工具栏注册必须并进 main.rb 的同一个 `file_loaded?` 块（`api-report §6.3:502`），
#     所以本文件只提供 `build`，注册动作由 main.rb 的 guard 块发起。
#
# 防误抄纪律（docs/42 §5.4 / api-report §16）：**抄机制、不抄分支**。
#   本文件照抄 api-report §10.1 的**结构层机制**（持久引用 / setter / 平台二选一 /
#   get_last_state 分派），不照抄它里两段 show 语义的 `toggle` 片段。
#
# 硬约束（不得放开）：
#   - 全部代码在单一模块 IDBoxPanel 内、**禁止全局变量**（A7）；持久引用用模块实例变量
#     `@toolbar` / `@command`（防 GC，对齐 HtmlDialog 构造函数 Note「If there is no
#     reference kept ... the window will close once GC runs」，`api-report §9` R7）。
#   - 零网络、零原生件、零写盘：注册失败只 `puts` 真实异常（docs/42 §7.3），**不得**调用
#     Diagnostics（A6 的唯一写盘例外＝建窗失败，注册阶段写盘会破 A6）。
#   - 资源绝对路径一律走 `IDBoxPanel::Paths`（docs/39 §4.4 / docs/42 §3.3 实测：扩展里的
#     `__FILE__` 可能是相对路径），**不得**用 `__FILE__` 拼图标路径。
#   - 图标 stem = `toolbar`（`【裁定】` docs/42 §5.5 末「图标 stem 命名裁定」，承 §11.1）：
#     `assets/toolbar.svg` / `assets/toolbar.pdf` 与本文件 `lib/toolbar.rb` 严格同名，
#     满足 `docs/41 P0-2` 判据④ / A13④「SVG 与 PDF 成对、stem 与 rb 同名」。
#     ⚠️ `api-report §10.1:657` 的片段里写的是 `toolbar_idbox` —— 那是示意用名，
#     本文件按 §5.5 裁定覆盖它，差异如实登记于 docs/42 §10.2 风险 9。
#
# 禁用门槛外 API（门槛 SU 2021+，`api-report §7:508-536` / §5.5 D1）：
#   `get_validation_proc` / `proc` / `extension=`（2022.0）、`HtmlDialog#hide`（2026.1）、
#   SVG 通吃 Win+Mac（2027）、`load_error`（2026.2）。
#
# 兼容性：Ruby 2.7。禁 Hash#except / endless method（def x = ...）/ => 右赋值 / pattern matching。

module IDBoxPanel
  # ── 常驻工具栏（单按钮） ────────────────────────────────────────────────────
  module Toolbar
    # 持久引用（防 GC 回收）；与 file_loaded? guard 双保险 ⇒ build 幂等。
    @toolbar = nil
    @command = nil

    # `【查证】` UI::Command#small_icon= / #large_icon= 官方（`api-report §3:140-232`）逐字：
    #   "Starting in SketchUp 2016 ... SVG format for Windows and PDF format for Mac.
    #    Since the vector images scale for both small and large icon sizes, you only
    #    need to use one. Starting in SketchUp 2027 it is possible to use SVG on both
    #    Windows and Mac."
    # ⇒ 门槛 SU 2021 < 2027：Windows 用 SVG，macOS 仍必须 PDF（成对 ship、按平台二选一，
    #    不是两个都传；矢量一份同时供 small/large，无需 PNG / @2x）。
    def self.icon_extension
      (Sketchup.platform == :platform_win) ? 'svg' : 'pdf'
    end

    # 绝对路径走 Paths（不得只信 __FILE__）。Paths 只返回字符串、不校验存在性 ——
    # 存在性由调用方决定如何提示（A13② 真机首验要看的是「真渲染出来」，不是「格式被接受」）。
    def self.icon_path
      Paths.asset_path("toolbar.#{icon_extension}")
    end

    def self.build
      return @toolbar unless @toolbar.nil?   # 幂等：与 main.rb 的 file_loaded? guard 双保险

      # `【查证】` UI::Command.new(menutext) { ... }：menutext = 菜单项文字，block = 点击执行。
      # block 里调用 Panel#toggle（运行时解析；toggle 属 T04，本卡不实现）。
      cmd = UI::Command.new('ID BOX 素材库') do
        IDBoxPanel::Panel.instance.toggle
      end

      icon = icon_path
      # `【查证】` setter，不是构造参数；同一矢量文件同时给 small/large（官方 "you only need
      # to use one"）。路径为空时不赋值（空串会被 API 接受成无图标，不如显式跳过）。
      unless icon.empty?
        cmd.small_icon = icon
        cmd.large_icon = icon
      end

      # `【查证】` Note「tooltip text should repeat the commands' title text」⇒ tooltip 重复标题；
      # 描述放 status_bar_text（一句、句末带点，`api-report §9` R5/R6）。
      cmd.tooltip = 'ID BOX 素材库'
      cmd.status_bar_text = '在 ID BOX 本地库里搜索并插入模型。'
      cmd.menu_text = 'ID BOX 素材库'

      # D4（§5.5）：**本批不启用**。`set_validation_proc` 是 SU 6.0、理论上可做「面板开着=打勾」
      # 的按下态（官方举例正是「the command toggling a dialog window may be displayed as
      # checked while the dialog is open」），但架构裁定列 P2/可选：避开 Mac Known Bug
      # 「validation proc 刷新不及时」进验收面。故此处只留说明、不写代码；
      # 若日后启用，必须同时把 `get_validation_proc` / `proc` / `extension=`（2022.0）留在门槛外。

      tb = UI::Toolbar.new('ID BOX')   # `【查证】` new(toolbarname) = "The name for the new toolbar"
      tb.add_item(cmd)                 # `【查证】` add_item(command) ⇒ UI::Toolbar；单按钮不需 add_separator

      # `【查证】` #restore = "reposition ... and show if not hidden"（首要职责是**位置**，
      # **不保证首次安装显示**）；#get_last_state ⇒ TB_VISIBLE(1) / TB_HIDDEN(0) / TB_NEVER_SHOWN(-1)。
      # 【推断·本机 DM_Bevel/main.rb:1349-1355 旁证】首装(-1)单靠 restore 不保证显示
      #   ⇒ 按 last_state 分派：保证「常驻按钮首装即出现」，且尊重用户上次主动隐藏（0）。
      #   这条分派是【推断】，官方对 restore 在 -1 的行为无明文 ⇒ 真机首验第一条（A13①）。
      #   用数值字面量，不依赖 TB_* 常量是否在该版本定义（与 DM_Bevel 一致）。
      state = tb.get_last_state
      if state == 0                       # TB_HIDDEN：上次被用户主动隐藏 ⇒ 尊重，不弹出来
        tb.hide
      else                                # 1 = 上次可见，-1 = 从未显示 ⇒ 保证出现
        tb.show
        tb.restore if state == 1          # 仅「上次可见」才恢复停靠位置（-1 无位置可恢复）
      end

      @command = cmd                      # 持久引用
      @toolbar = tb                       # 持久引用
      tb
    end
  end
end
