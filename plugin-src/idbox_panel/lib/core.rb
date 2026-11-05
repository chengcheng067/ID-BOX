# ID BOX · SketchUp 插件 —— lib/core.rb（契约常量 + ErrCode + Support + Messages）
#
# 装配加载顺序（docs/42 §3.2）：本文件必须**第一个**被 Sketchup.require，
# 它定义 module IDBoxPanel 与全部契约常量，后 5 个 lib 文件都在该模块内注入
# 方法/类；晚加载会 NameError。
#
# 本文件的定位（docs/42 §2 文件 3）：**零依赖、无 IO、无 UI 的纯地基层**。
#   - 无 IO：只有字符串/类型转换与 JSON 解析；读文件属 lib/paths.rb 与 lib/loader.rb。
#   - 无 UI：不引用 UI.* 的任何对象（文案是纯字符串，弹窗由 lib/panel_dialog.rb 负责）。
#   - 零依赖：不 Sketchup.require 任何其它 lib 文件（保持加载链严格单向拓扑）。
#
# 硬约束（docs/39 §4.1，改这个文件时不得放开）：
#   1) 零网络：包内不得出现 http / socket / Net::HTTP / open-uri；
#   2) 零原生件：只用 stdlib（json / digest）与 SketchUp 自带 API；
#   3) 零 token、零端口、零后台服务；
#   4) 纯读方：本文件不写任何盘；
#   5) 全部代码在单一唯一命名模块 IDBoxPanel 内，禁止全局变量（$x）；
#   6) 包内互相 require 用 Sketchup.require 'idbox_panel/xxx'（不带 .rb），不用 require_relative；
#   7) 不得用 __FILE__ 拼资源路径（资源路径统一走 lib/paths.rb）。
#
# 兼容性：门槛 SketchUp 2021+（docs/38 §8.1 已拍板）⇒ Ruby 2.7 兼容写法。
# 禁忌：Hash#except / endless method（def x = ...）/ => 右赋值 / pattern matching。

require 'json'

module IDBoxPanel
  # ── 契约常量（与 src/shared/pluginSnapshot.ts 逐字对齐，不得自造字段） ──────
  API_VERSION = '1'.freeze
  # 插件版本：1.0.3 → 1.1.0（docs/42 §11.1，本批新增真工具栏 + 六块 UI 重构 + lib/ 拆分）。
  # 另一处在根注册文件 idbox_panel.rb 的 Registrar::EXT_VERSION，两处必须同步。
  PLUGIN_VERSION = '1.1.0'.freeze
  MANIFEST_FILE = 'manifest.json'.freeze
  INDEX_FILE = 'index.json'.freeze
  # 支持目录名 = 根 .rb 同名（去掉 .rb），docs/39 §4.2 硬要求
  SUPPORT_DIR_NAME = 'idbox_panel'.freeze

  # 轮询（docs/39 §3.5：建议 3 s，只在面板打开时跑）
  POLL_SECONDS = 3
  # 半写防护（docs/39 §3.4 第 4 条：连续 3 轮不一致才报 102）
  SHA_RETRY_ROUNDS = 3
  SHA_RETRY_SLEEP = 0.2

  # 门槛 SketchUp 2021+（docs/38 §8.1 已拍板）——低于它直接提示 IDBOX-106，不进入面板
  MIN_SU_MAJOR = 2021

  # 窗口尺寸（用户 2026-11-06 拍板，docs/42 §10.3 风险 1 的架构裁定）：
  #   原 420×620 / min 340×440 放不下「左栏 216px + 3 列 4:3 卡 + 顶栏 56px + 底栏 44px」，
  #   A9 判据②④ 在该尺寸下物理无解 ⇒ 放宽为 960×680 / min 760×520。
  # ⚠️ UI::HtmlDialog **没有** set_min_size 实例方法（docs/39 §4.4 第 4 条：1.0.1 因此白跑两轮）。
  #   官方支持的写法只有**构造函数 options** 里的 :min_width / :min_height（1.0.2 起即为下面这样），
  #   所以本组常量继续走 options；物理上的最小尺寸同时由 panel.html 的 CSS min-width/min-height 承担
  #   （窗口 options 是 SU 侧的下限，CSS 是内容侧的下限，两者一致 ⇒ 不会互相矛盾）。真机目视校准属 QA（A9）。
  DIALOG_WIDTH = 960
  DIALOG_HEIGHT = 680
  DIALOG_MIN_WIDTH = 760
  DIALOG_MIN_HEIGHT = 520

  OP_NAME = '插入 ID BOX 资产'.freeze
  CODE_PREFIX = 'IDBOX-'.freeze

  # 六值（types.ts:19）
  KINDS = %w[model texture hdri material cad other].freeze
  # 本轮只允许插入 model；材质/贴图 API 仍【待核实】（docs/38 §8.2 D2）
  INSERTABLE_KINDS = %w[model].freeze
  KIND_LABELS = {
    'model' => '模型',
    'texture' => '贴图',
    'hdri' => 'HDRI',
    'material' => '材质',
    'cad' => 'CAD',
    'other' => '其他'
  }.freeze

  UNSUPPORTED_INSERT_HINT = '材质/贴图取用待真机验证，暂不支持'.freeze
  SETTINGS_HINT = 'ID BOX → 设置 → 数据与备份 → SketchUp 插件'.freeze

  # UI.messagebox 的按钮/返回值常量由 SketchUp 的 C 层提供（本机 Tools/*.rb 里查不到定义），
  # 因此用 defined? 兜一层：万一常量解析不到，也不能把「确认」误判成「取消」。
  # 取值沿用 Windows MessageBox 口径：MB_YESNO=4 / IDYES=6 / IDNO=7。
  YES_NO_BUTTONS = defined?(MB_YESNO) ? MB_YESNO : 4
  YES_ANSWER = defined?(IDYES) ? IDYES : 6
  NO_ANSWER = defined?(IDNO) ? IDNO : 7

  # digest 在 SketchUp 自带的 Ruby 里通常可用；缺失时降级为「只做 JSON 解析校验」。
  HAS_DIGEST = begin
    begin
      require 'digest'
    rescue LoadError
      nil
    end
    defined?(Digest::SHA256) ? true : false
  end

  # ── 错误码（docs/39 §5 / PRD §6.2，六条语义逐条照抄；A14 不得改动） ─────────
  module ErrCode
    DISCOVERY_MISSING = '101'.freeze # 发现文件缺失（含未开导出）
    INDEX_INVALID = '102'.freeze     # JSON 解析/校验失败（含半写）
    PATH_GONE = '103'.freeze         # 路径失效（快照与盘不符，等价 410 GONE）
    SU_TOO_NEW = '104'.freeze        # .skp 版本高于当前 SketchUp
    PATH_OUTSIDE = '105'.freeze      # 路径越界被拒
    SU_TOO_OLD = '106'.freeze        # SketchUp 版本低于门槛
  end

  # ── 基础工具（一律不抛异常） ────────────────────────────────────────────────
  module Support
    module_function

    def text(value)
      return '' if value.nil?
      return value if value.is_a?(String)
      begin
        value.to_s
      rescue StandardError
        ''
      end
    end

    def nil_text(value)
      str = text(value)
      str.empty? ? nil : str
    end

    def int_or_nil(value)
      return value.to_i if value.is_a?(Integer)
      return value.to_i if value.is_a?(Float) && value.finite?
      return nil unless value.is_a?(String)
      str = value.strip
      return nil if str.empty?
      begin
        Integer(str, 10)
      rescue StandardError
        nil
      end
    end

    def num_or_nil(value)
      return value.to_f if value.is_a?(Numeric)
      nil
    end

    def blank_text?(value)
      text(value).strip.empty?
    end

    def ascii_only?(value)
      text(value).ascii_only?
    end

    # 显式 UTF-8 读（docs/39 §4.4 第 2 条）。失败一律返回 nil，不抛。
    # 注意 mode 用关键字形式：Ruby 2.7 下 File.read(path, {:mode => ...}) 会被当成 length。
    def read_text(path)
      path_text = text(path)
      return nil if path_text.empty?
      return nil unless File.file?(path_text)
      raw = begin
        File.read(path_text, mode: 'r:UTF-8')
      rescue StandardError
        nil
      end
      return nil if raw.nil?
      decode_utf8(raw)
    end

    # 二进制读：SHA256 必须对**落盘字节**算，不能对已转码的字符串算。
    def read_binary(path)
      path_text = text(path)
      return nil if path_text.empty?
      return nil unless File.file?(path_text)
      begin
        File.read(path_text, mode: 'rb')
      rescue StandardError
        nil
      end
    end

    def decode_utf8(raw)
      return nil unless raw.is_a?(String)
      str = raw.dup
      str.force_encoding('UTF-8')
      return nil unless str.valid_encoding?
      # 写入侧保证无 BOM；这里只做防御（不修改源文件）
      str = str.sub(/\A\uFEFF/, '')
      str
    end

    def parse_json(text_value)
      source = text(text_value)
      return nil if source.strip.empty?
      begin
        JSON.parse(source)
      rescue StandardError
        nil
      end
    end

    # 把数据序列化后安全地嵌进 execute_script 的 JS 源码。
    # U+2028 / U+2029 在 ES2019 之前的 JS 字符串字面量里非法，必须转义（老 CEF 会遇到）。
    def json_for_script(value)
      json = value.to_json
      json = json.gsub("\u2028") { '\\u2028' }
      json.gsub("\u2029") { '\\u2029' }
    end

    # Sketchup.version.to_s 形如 "21.0.339" / "24.0.484"，to_i 得 21 / 24；
    # 而快照里的 suMajor 口径是**四位年份**（2024，见 ts 契约注释与 docs/39 §3.2）。
    # 两者量纲不同，必须先归一化再比较，否则每条记录都会误报「版本过高」。
    def normalize_su_major(value)
      major = int_or_nil(value)
      return nil if major.nil?
      return major + 2000 if major > 0 && major < 100
      major
    end

    def su_major_now
      begin
        normalize_su_major(Sketchup.version.to_i)
      rescue StandardError
        nil
      end
    end
  end

  # ── 用户可读文案（中文；不弹裸异常，不给用户看 Ruby 栈） ────────────────────
  module Messages
    module_function

    def code_text(code)
      text = Support.text(code)
      text.empty? ? '' : CODE_PREFIX + text
    end

    def with_code(code, body)
      head = code_text(code)
      head.empty? ? body : (head + ' · ' + body)
    end

    def no_appdata
      "读不到 Windows 环境变量 APPDATA，无法定位 ID BOX 的插件索引目录。\n" \
      "请确认 SketchUp 正常启动（不是以异常方式拉起），再重开面板。"
    end

    def missing_manifest(path)
      "ID BOX 还没写出插件索引（找不到 manifest.json）。\n" \
      "请到 #{SETTINGS_HINT} 打开「插件索引导出」，然后在 ID BOX 里刷新一次索引。\n" \
      "预期位置：#{Support.text(path)}"
    end

    def index_disabled
      "ID BOX 的「插件索引导出」当前是关闭的（manifest.pluginIndexEnabled = false）。\n" \
      "请到 #{SETTINGS_HINT} 打开它，然后在 ID BOX 里刷新一次索引。"
    end

    def index_flag_missing
      "manifest.json 里没有可用的 pluginIndexEnabled 字段 —— 按「未开启导出」处理。\n" \
      "请到 #{SETTINGS_HINT} 打开「插件索引导出」，并在 ID BOX 里点一次「刷新索引」重新导出。"
    end

    def missing_index(path)
      "只找到 manifest.json，没找到 index.json —— 索引可能还没写完。\n" \
      "请在 ID BOX 里点一次「刷新索引」，等几秒再回到这里点「刷新」。\n" \
      "预期位置：#{Support.text(path)}"
    end

    def bad_manifest(message)
      "manifest.json 读不出来或不是合法的 UTF-8 JSON（#{Support.text(message)}）。\n" \
      "请在 ID BOX 里点一次「刷新索引」重新导出。"
    end

    def bad_index(message)
      "index.json 读不出来或不是合法的 UTF-8 JSON（#{Support.text(message)}）。\n" \
      "请在 ID BOX 里点一次「刷新索引」重新导出。"
    end

    def hash_mismatch(rounds, expected, actual)
      "index.json 与 manifest.indexSha256 连续 #{rounds} 轮不一致 —— 可能正在写盘，也可能文件损坏/被改过。\n" \
      "若稍后点「刷新」仍然如此，请在 ID BOX 里点一次「刷新索引」重新导出。\n" \
      "manifest：#{Support.text(expected)[0, 16]}… / 实测：#{Support.text(actual)[0, 16]}…"
    end

    def digest_unavailable
      '当前 Ruby 没有可用 digest 库，本轮跳过 SHA256 校验（只做 JSON 解析校验）。'
    end

    def sha_missing
      'manifest.indexSha256 缺失或不是 64 位十六进制，本轮跳过 SHA256 校验（只做 JSON 解析校验）。'
    end

    def user_dir_non_ascii(path)
      "提示：当前用户目录含非 ASCII 字符（#{Support.text(path)}）。" \
      '若面板偶尔加载异常，属已知风险（docs/39 §4.4），不是错误。'
    end

    def count_mismatch(declared, actual)
      "manifest.indexCount = #{declared}，但 index.json 实际有 #{actual} 条记录。" \
      '两者可能不同步（正在写盘），本面板以实际记录为准。'
    end

    def api_mismatch(where, value)
      shown = Support.text(value)
      shown = '(缺失)' if shown.empty?
      "#{Support.text(where)}.apiVersion = #{shown}，本插件只认识 \"#{API_VERSION}\"。" \
      '插件与 ID BOX 版本可能不匹配 —— 已切换为只读展示：可以搜索和浏览，插入被禁用。' \
      '请升级其中一侧。'
    end

    def state_error(detail)
      "ID BOX 报告导出失败：#{Support.text(detail)}"
    end

    def state_error_blank
      'ID BOX 报告导出失败（没有给出具体原因），索引可能不是最新，但仍可浏览与插入。'
    end

    def no_model
      '当前没有打开的 SketchUp 模型，无法插入。请先新建或打开一个模型。'
    end

    def no_library_root
      '索引里没有 libraryRoot，无法把相对路径换算成绝对路径。请让 ID BOX 重新导出一份索引。'
    end

    def no_main_file(name)
      "「#{Support.text(name)}」没有主文件（mainFile 为空），无法插入。"
    end

    def outside_root(abs)
      "路径越界被拒：#{Support.text(abs)} 不在当前库根目录内。\n" \
      '为保持只读与安全，插件只允许加载库根之下的文件（等价 isWithinRoot 校验）。'
    end

    def file_gone(abs)
      "文件不在了：#{Support.text(abs)}\n" \
      '可能被移动、改名或删除（快照与磁盘不一致）。请在 ID BOX 里重新扫描 / 刷新索引。'
    end

    def version_warning(name, file_major, now_major)
      "「#{Support.text(name)}」来自 SketchUp #{file_major}，当前是 SketchUp #{now_major}。\n" \
      '高版本文件在低版本 SketchUp 里会加载失败。仍要继续插入吗？'
    end

    def version_cancelled
      '已取消：该文件版本高于当前 SketchUp（可先在更高版本里另存为低版本）。'
    end

    def su_too_old(current)
      "当前 SketchUp 版本是 #{Support.text(current)}，本插件门槛是 SketchUp #{MIN_SU_MAJOR}+" \
      '（面板依赖 UI::HtmlDialog）。请升级 SketchUp 后重试。'
    end

    def load_failed(abs, detail)
      tail = Support.text(detail).empty? ? '' : "\n（#{Support.text(detail)}）"
      "加载失败：#{Support.text(abs)}#{tail}\n" \
      '该文件可能不是有效的 SketchUp 组件、已被占用，或已损坏。'
    end

    def insert_ok(name)
      "已插入：#{Support.text(name)}（可用 Ctrl+Z 单步撤销）"
    end

    def insert_exception(detail)
      "插入过程中出现异常：#{Support.text(detail)}"
    end
  end
end
