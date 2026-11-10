# ID BOX · SketchUp 插件 —— 根注册文件（registrar）
#
# 这个文件是 .rbz 的根条目，按官方扩展包约定**只做扩展注册与元数据**：
#   - 不含任何业务逻辑；
#   - 不加载除 main.rb 之外的任何文件（main.rb 由 SketchupExtension 自己加载）；
#   - 文件名纯 ASCII（docs/39 §4.4 第 1 条）。
#
# .rbz 包内结构（docs/39 §4.2，恰好两项）：
#   idbox_panel.rb          ← 本文件
#   idbox_panel/            ← 同名支持目录（main.rb / panel.html / lib/*.rb / assets/）
# 源码目录根下的 README.md 是给人看的工程说明，**不进包**（打包侧白名单放行、不收）。
#
# 硬约束（docs/39 §4.1，违反即不合格，后人改代码时不得放开）：
#   1) 零网络：包内不得出现 http / socket / Net::HTTP / open-uri；
#   2) 零原生件：不 require 任何 .so / .bundle / .dll，不依赖第三方 gem，只用 stdlib；
#   3) 零 token、零端口、零后台服务；
#   4) 不解压、不读任何压缩包；
#   5) 不自删、不自升级；
#   6) 纯读方：绝不写 %APPDATA%\idbox\plugin\ 下任何文件（也绝不写 ID BOX 的任何数据）；
#   7) 所有代码包在单一唯一命名模块 IDBoxPanel 内，禁止使用全局变量（$x）；
#   8) 包内互相 require 用 Sketchup.require 'idbox_panel/xxx'（不带 .rb）。
#
# 兼容性：门槛 SketchUp 2021+（docs/38 §8.1 已拍板）⇒ Ruby 2.7 兼容写法。
# 写法禁忌：Hash#except / endless method / => 右赋值 / pattern matching。

require 'sketchup.rb'
require 'extensions.rb'

module IDBoxPanel
  # 扩展元数据。**注意**：这里的常量名与 main.rb 里的常量不得重名，
  # 否则 Ruby 会报 "already initialized constant"。
  module Registrar
    # 支持目录名必须与根 .rb 同名（去掉 .rb），否则 SketchupExtension 找不到入口。
    ENTRY_POINT = 'idbox_panel/main'.freeze
    EXT_NAME = 'ID BOX Panel'.freeze
    # 插件包版本。**必须与 lib/core.rb 的 PLUGIN_VERSION 同值**（两处都是本插件包的版本，
    # 不是文档版本、也不是主程序版本；面板左上角显示的是主程序 appVersion，见 main.rb 的 VERSION 注释）。
    #
    # 1.1.0 → 1.1.1（2026-11-09）：1.1.0 是 R-2 修复之前的快照（`Snapshot#thumbs_root` 恒返回空串
    # ⇒ 面板封面全部降级成类型图标）；1.1.1 才含该修复 + 本批 UI 改动。
    # 1.1.1 → 1.2.0（2026-11-09）：功能性新增（右键「导出至 IDBOX / 更新 IDBOX 中的这个模型」），
    # 按语义化版本升 minor。⚠️ 必须与 lib/core.rb 的 PLUGIN_VERSION 同值（那边也有同样的提示）。
    # 1.2.0 → 1.2.1（2026-11-09 装机实测反馈）：行为修复（右键更新判据 / 导出先命名 / 材质当前材质
    # 从未生效 / 面板侧栏分类 + 大中小预览档），按语义化版本升 patch。
    # 1.2.1 → 1.2.2（2026-11-09 用户实测）：材质双击后自动切油漆桶工具，升 patch。
    # 1.2.2 → 1.2.3（2026-11-09 用户实测）：插件里只显示 SketchUp 模型（屏蔽 3ds Max 等格式），升 patch。
    # 1.2.3 → 1.3.0（2026-11-09 V1.0 批次收口）：功能性新增与外观收口一批 —— 自绘窗口
    #   控件（折叠）、Logo 与版本号跟本体同源、只显示模型与材质、材质双击建材质并设为当前
    #   材质、导出与右键「更新 IDBOX 中的这个模型」收件箱通道、撤销胶囊三态、A 级文案收口
    #   （逐条见 docs/48 §6 / §7 / §12 与 docs/50 的插件章节），按语义化版本升 minor。
    #   ⚠️ 必须与 lib/core.rb 的 PLUGIN_VERSION 同值（那边也有同样的提示，两处一起改）。
    #   2026-11-10 T01 只补齐这条滞后的变更记录，本轮**不升版本号**（§8 D10 = A）。
    #
    # 为什么这里不能直接引用 `IDBoxPanel::PLUGIN_VERSION`（试过，不安全）：
    #   本文件是**扩展入口**，它在 `Registrar.register`（文件末尾）这一行才触发
    #   `Sketchup.register_extension(meta, true)`，而 core.rb 是由 `main.rb` 被加载时才
    #   `Sketchup.require` 进来的 —— 也就是说 `apply_metadata` 执行时 PLUGIN_VERSION **还不存在**。
    #   而「根 .rb 只做注册、不得加载额外文件」是硬约束（docs/42 §2 文件 1），
    #   不能为了取一个版本号提前 require core。⇒ 只能保持字面量 + 人工同步。
    EXT_VERSION = '1.3.0'.freeze
    EXT_CREATOR = 'ID BOX'.freeze
    EXT_COPYRIGHT = 'ID BOX'.freeze
    EXT_DESCRIPTION =
      'ID BOX asset panel for SketchUp: search your local ID BOX library ' \
      'and insert a collected model with one click. Read-only, offline, no telemetry.'.freeze

    # SketchUp 的扩展注册类名在 docs/36:128 里仍标【待核实】
    # （SketchupExtension / Sketchup::Extension 两种写法历史上都出现过），
    # 因此这里做存在性探测，取实际可用的那个，不把未核实的名字写死。
    def self.register
      return false unless defined?(SketchupExtension) || defined?(Sketchup::Extension)
      meta = build_extension
      return false if meta.nil?
      Sketchup.register_extension(meta, true)
      true
    rescue StandardError => error
      # 注册失败不能把 SketchUp 启动搞崩：吞掉异常、只留控制台痕迹。
      puts("[ID BOX] extension registration failed: #{error.class}: #{error.message}")
      false
    end

    def self.build_extension
      if defined?(SketchupExtension)
        ext = SketchupExtension.new(EXT_NAME, ENTRY_POINT)
      else
        ext = Sketchup::Extension.new(EXT_NAME, ENTRY_POINT)
      end
      apply_metadata(ext)
      ext
    rescue StandardError
      nil
    end

    def self.apply_metadata(ext)
      ext.version = EXT_VERSION if ext.respond_to?(:version=)
      ext.creator = EXT_CREATOR if ext.respond_to?(:creator=)
      ext.copyright = EXT_COPYRIGHT if ext.respond_to?(:copyright=)
      ext.description = EXT_DESCRIPTION if ext.respond_to?(:description=)
      ext
    rescue StandardError
      ext
    end
  end

  Registrar.register
end
