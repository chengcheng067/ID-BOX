# ID BOX · SketchUp 插件 —— 根注册文件（registrar）
#
# 这个文件是 .rbz 的根条目，按官方扩展包约定**只做扩展注册与元数据**：
#   - 不含任何业务逻辑；
#   - 不加载除 main.rb 之外的任何文件（main.rb 由 SketchupExtension 自己加载）；
#   - 文件名纯 ASCII（docs/39 §4.4 第 1 条）。
#
# .rbz 包内结构（docs/39 §4.2，恰好两项）：
#   idbox_panel.rb          ← 本文件
#   idbox_panel/            ← 同名支持目录（main.rb / panel.html）
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
    EXT_VERSION = '1.0.0'.freeze
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
