# ID BOX · SketchUp 插件 —— 全部逻辑
#
# 入口：根注册文件 idbox_panel.rb 里的 SketchupExtension.new('ID BOX Panel', 'idbox_panel/main')
# 数据：%APPDATA%\idbox\plugin\manifest.json + index.json（ID BOX 主进程写，本插件**只读**）
# 契约：src/shared/pluginSnapshot.ts（PluginManifest / PluginIndexEnvelope / PluginSnapshotRecord）
# 规范：docs/39-插件架构-索引快照与包规范.md §3（文件格式）、§4（包规范）、§5（错误码）
#
# ============================ 硬约束（违反即不合格） ============================
# 1) 零网络：本包内不得出现 Net::HTTP / TCPSocket / open-uri / URI.open / 任何 http 客户端。
# 2) 零原生件：不 require 任何 .so / .bundle / .dll，不用第三方 gem；只用 Ruby stdlib
#    （json / digest）与 SketchUp 自带 API。
# 3) 零 token、零端口、零后台服务：插件不监听端口、不起线程常驻服务（只有面板打开时的
#    3 s 轮询定时器，面板关闭即 stop_timer）。
# 4) 不解压、不读任何压缩包：V1.0 只取用**已入库**的单个文件。
# 5) 不自删、不自升级。
# 6) 纯读方：绝不 File.write / File.delete / File.rename 到 %APPDATA%\idbox\plugin\
#    或 ID BOX 的任何数据目录。整个文件里不存在任何写文件调用。
# 7) 全部代码在本单一模块 IDBoxPanel 内；**禁止全局变量**（$x 一律不许出现）。
# 8) 包内互相 require 用 Sketchup.require 'idbox_panel/xxx'（不带 .rb）。
#
# 兼容性：门槛 SketchUp 2021+（docs/38 §8.1 已拍板）⇒ Ruby 2.7 兼容写法。
# 禁忌：Hash#except / endless method（def x = ...）/ => 右赋值 / pattern matching。
# ==============================================================================

require 'sketchup.rb'
require 'json'

module IDBoxPanel
  # ── 契约常量（与 src/shared/pluginSnapshot.ts 逐字对齐，不得自造字段） ──────
  API_VERSION = '1'.freeze
  PLUGIN_VERSION = '1.0.1'.freeze
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

  DIALOG_WIDTH = 420
  DIALOG_HEIGHT = 620
  DIALOG_MIN_WIDTH = 340
  DIALOG_MIN_HEIGHT = 440

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

  # ── 错误码（docs/39 §5 / PRD §6.2，六条语义逐条照抄） ───────────────────────
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

  # ── 路径（含 isWithinRoot 等价校验，docs/39 §4.1 第 8 条） ─────────────────
  module Paths
    module_function

    def windows?
      File::ALT_SEPARATOR ? true : false
    end

    # 支持目录 = 装好的 <Plugins>/idbox_panel。
    #
    # ⚠️ 真机踩过的坑（2026-11-05，SU 2024 + 本机 AppData）：SketchUp 把扩展里的
    # `__FILE__` 给成**相对路径**（`idbox_panel/main.rb`），`File.expand_path` 于是按
    # "当前工作目录"（SketchUp 安装目录）解析，算出 `...\SketchUp\idbox_panel` ——
    # 目录不存在 → 面板报「找不到 panel.html」。所以**不能只信 `__FILE__`**。
    #
    # 按可信度依次尝试，第一个"目录存在且里面真有 panel.html"的胜出：
    #   ① `__FILE__` 绝对路径（正常情况下就是它）
    #   ② `Sketchup.find_support_file`（官方 API，按 Plugins 相对路径找，最稳）
    #   ③ 从 `Sketchup.find_support_file('Plugins')` 拼
    #   ④ AppData 兜底扫描（覆盖 2021–2026 各版本；真机实测真实路径是
    #      `%APPDATA%\SketchUp\SketchUp 2024\SketchUp\Plugins`，比文档假设多一层 `SketchUp`）
    def support_candidates
      list = []
      begin
        list << File.expand_path(File.dirname(__FILE__))
      rescue StandardError
        nil
      end
      begin
        found = Sketchup.find_support_file('panel.html', File.join('Plugins', SUPPORT_DIR_NAME))
        list << File.dirname(found) if found && !found.to_s.empty?
      rescue StandardError
        nil
      end
      begin
        plugins_root = Sketchup.find_support_file('Plugins')
        list << File.join(plugins_root, SUPPORT_DIR_NAME) if plugins_root && !plugins_root.to_s.empty?
      rescue StandardError
        nil
      end
      begin
        appdata = Support.text(ENV['APPDATA'])
        unless appdata.strip.empty?
          Dir.glob(File.join(appdata, 'SketchUp', 'SketchUp *', '**', 'Plugins', SUPPORT_DIR_NAME)).each do |dir|
            list << dir
          end
        end
      rescue StandardError
        nil
      end
      list.compact.uniq
    end

    def support_dir
      support_candidates.each do |dir|
        return dir if File.directory?(dir) && File.file?(File.join(dir, 'panel.html'))
      end
      ''
    end

    def html_path
      dir = support_dir
      dir.empty? ? '' : File.join(dir, 'panel.html')
    end

    # 失败时把"试过哪些路径"一起给出来 —— 下一轮真机问题不用再猜（可诊断性优先）
    def tried_paths_text
      list = support_candidates
      return '(无可尝试路径)' if list.empty?
      list.map { |dir| "· #{dir}" }.join("\n")
    end

    # %APPDATA%\idbox\plugin —— D1 已拍板（docs/38 §8.1），不猜路径、不立第二个根
    def plugin_dir
      appdata = Support.text(ENV['APPDATA'])
      return '' if appdata.strip.empty?
      File.join(appdata, 'idbox', 'plugin')
    end

    def manifest_path
      dir = plugin_dir
      dir.empty? ? '' : File.join(dir, MANIFEST_FILE)
    end

    def index_path
      dir = plugin_dir
      dir.empty? ? '' : File.join(dir, INDEX_FILE)
    end

    # 绝对路径形态判定（deny by default：相对路径一律拒绝）
    def absolute_like?(path)
      str = Support.text(path)
      return false if str.strip.empty?
      if windows?
        return true unless (str =~ /\A[A-Za-z]:[\\\/]/).nil?
        return true if str.start_with?('\\\\') || str.start_with?('//')
        false
      else
        str.start_with?('/')
      end
    end

    def normalize_slashes(path)
      # 用 gsub 而不是 tr：tr 会把反斜杠当转义前缀，gsub 的字符串模式是无语义的字面替换
      Support.text(path).gsub('\\', '/').sub(%r{/+\z}, '')
    end

    # isWithinRoot 等价（src/main/ipcGuard.ts:128-139 的纪律）：
    # 拒相对路径、消 .. 、归一化、Windows 无条件小写、前缀必须带分隔符，**永不抛异常**。
    def within_root?(root, target)
      begin
        return false unless absolute_like?(root)
        return false unless absolute_like?(target)
        root_path = normalize_slashes(File.expand_path(Support.text(root)))
        target_path = normalize_slashes(File.expand_path(Support.text(target)))
        return false if root_path.empty? || target_path.empty?
        if windows?
          root_path = root_path.downcase
          target_path = target_path.downcase
        end
        # 库根本身（目录）不算命中：要的是它下面的文件
        return false if target_path == root_path
        target_path.start_with?(root_path + '/')
      rescue StandardError
        false
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

  # ── 快照（manifest + 记录）；读取结果一律用它承载，永不抛 ────────────────────
  class Snapshot
    attr_reader :code, :message, :manifest, :records, :notes, :read_only_reason, :state_error

    def initialize(attributes)
      opts = attributes.is_a?(Hash) ? attributes : {}
      @ok = opts[:ok] ? true : false
      @code = opts[:code]
      @message = opts[:message]
      @manifest = opts[:manifest].is_a?(Hash) ? opts[:manifest] : {}
      @records = opts[:records].is_a?(Array) ? opts[:records] : []
      @notes = opts[:notes].is_a?(Array) ? opts[:notes] : []
      @read_only = opts[:read_only] ? true : false
      @read_only_reason = opts[:read_only_reason]
      @state_error = opts[:state_error]
    end

    def ok?
      @ok
    end

    def read_only?
      @read_only
    end

    def find(record_id)
      key = Support.text(record_id)
      return nil if key.empty?
      @records.each do |record|
        return record if Support.text(record['id']) == key
      end
      nil
    end

    def freshness_seconds
      value = Support.num_or_nil(@manifest['freshnessHintSeconds'])
      return 10.0 if value.nil? || value <= 0
      value
    end

    def to_payload
      {
        'ok' => ok?,
        'code' => Support.text(@code),
        'codeText' => Messages.code_text(@code),
        'message' => Support.text(@message),
        'readOnly' => read_only?,
        'readOnlyReason' => Support.text(@read_only_reason),
        'count' => @records.length,
        'declaredCount' => Support.int_or_nil(@manifest['indexCount']),
        'generatedAt' => Support.text(@manifest['generatedAt']),
        'freshnessHintSeconds' => freshness_seconds,
        'appVersion' => Support.text(@manifest['appVersion']),
        'apiVersion' => Support.text(@manifest['apiVersion']),
        'libraryRoot' => Support.text(@manifest['libraryRoot']),
        'stateError' => Support.text(@state_error),
        'notes' => @notes,
        'records' => @records,
        'insertableKinds' => INSERTABLE_KINDS,
        'kindLabels' => KIND_LABELS,
        'unsupportedInsertHint' => UNSUPPORTED_INSERT_HINT,
        'sketchupVersion' => begin
          Support.text(Sketchup.version)
        rescue StandardError
          ''
        end,
        'pluginVersion' => PLUGIN_VERSION
      }
    end
  end

  # ── 读取与校验（顺序严格照 docs/39 §3.4 + 派工单 A 节） ─────────────────────
  module Loader
    module_function

    def failure(code, message, notes = [])
      Snapshot.new(:ok => false, :code => code, :message => message, :notes => notes)
    end

    def load
      notes = []
      dir = Paths.plugin_dir
      return failure(ErrCode::DISCOVERY_MISSING, Messages.no_appdata) if dir.strip.empty?
      notes << Messages.user_dir_non_ascii(dir) unless Support.ascii_only?(dir)

      # ── A1/A2：manifest ────────────────────────────────────────────────────
      manifest_path = Paths.manifest_path
      unless File.file?(manifest_path)
        return failure(ErrCode::DISCOVERY_MISSING, Messages.missing_manifest(manifest_path), notes)
      end

      manifest_text = Support.read_text(manifest_path)
      if manifest_text.nil?
        return failure(ErrCode::INDEX_INVALID, Messages.bad_manifest('不是合法 UTF-8 或不可读'), notes)
      end

      manifest = Support.parse_json(manifest_text)
      unless manifest.is_a?(Hash)
        return failure(ErrCode::INDEX_INVALID, Messages.bad_manifest('JSON 解析失败'), notes)
      end

      # A2：开关为 false ⇒ 同样按 101 处理，但文案区分开（字段缺失也按未开启处理）
      flag = manifest['pluginIndexEnabled']
      unless flag == true
        message = flag == false ? Messages.index_disabled : Messages.index_flag_missing
        return failure(ErrCode::DISCOVERY_MISSING, message, notes)
      end

      # A5：apiVersion 不是 "1" ⇒ 只读展示、禁用插入（不拒绝服务）
      read_only = false
      reasons = []
      manifest_api = Support.text(manifest['apiVersion'])
      if manifest_api != API_VERSION
        read_only = true
        reasons << Messages.api_mismatch('manifest', manifest_api)
      end

      # A4：写入侧状态（不拒绝服务，只在面板顶部显示）
      state_error = read_state_error(manifest)

      # ── A3：index.json + SHA256 三轮重试 ───────────────────────────────────
      index_path = Paths.index_path
      unless File.file?(index_path)
        return failure(ErrCode::DISCOVERY_MISSING, Messages.missing_index(index_path), notes)
      end

      expected = Support.text(manifest['indexSha256']).strip.downcase
      has_hash = !(expected =~ /\A[0-9a-f]{64}\z/).nil?
      if !has_hash
        notes << Messages.sha_missing
      elsif !HAS_DIGEST
        has_hash = false
        notes << Messages.digest_unavailable
      end

      raw = nil
      body = nil
      attempts = 0
      mismatch_actual = ''
      loop do
        attempts += 1
        candidate = Support.read_binary(index_path)
        if candidate.nil?
          return failure(ErrCode::INDEX_INVALID, Messages.bad_index('文件不可读'), notes)
        end
        if has_hash
          actual = Digest::SHA256.hexdigest(candidate)
          if actual != expected
            mismatch_actual = actual
            if attempts >= SHA_RETRY_ROUNDS
              return failure(
                ErrCode::INDEX_INVALID,
                Messages.hash_mismatch(attempts, expected, mismatch_actual),
                notes
              )
            end
            # 唯一不一致窗口 = 主进程两次 rename 之间 ⇒ 先当「正在写」
            sleep(SHA_RETRY_SLEEP)
            next
          end
        end
        raw = candidate
        body = Support.decode_utf8(raw)
        break
      end

      if body.nil?
        return failure(ErrCode::INDEX_INVALID, Messages.bad_index('不是合法 UTF-8'), notes)
      end

      envelope = Support.parse_json(body)
      unless envelope.is_a?(Hash)
        return failure(ErrCode::INDEX_INVALID, Messages.bad_index('JSON 解析失败'), notes)
      end

      index_api = Support.text(envelope['apiVersion'])
      if index_api != API_VERSION
        read_only = true
        reasons << Messages.api_mismatch('index', index_api)
      end

      raw_records = envelope['records']
      unless raw_records.is_a?(Array)
        return failure(ErrCode::INDEX_INVALID, Messages.bad_index('records 不是数组'), notes)
      end

      records = []
      raw_records.each do |raw_record|
        normalized = normalize_record(raw_record)
        records << normalized unless normalized.nil?
      end

      declared = Support.int_or_nil(envelope['count'])
      declared = Support.int_or_nil(manifest['indexCount']) if declared.nil?
      if !declared.nil? && declared != records.length
        notes << Messages.count_mismatch(declared, records.length)
      end

      read_only_reason = reasons.join("\n")
      Snapshot.new(
        :ok => true,
        :manifest => manifest,
        :records => records,
        :notes => notes,
        :read_only => read_only,
        :read_only_reason => read_only_reason,
        :state_error => state_error
      )
    end

    # A4：lastError 只在 state == "error" 时读；字段缺失也不崩
    def read_state_error(manifest)
      return nil unless Support.text(manifest['state']) == 'error'
      last_error = manifest['lastError']
      return Messages.state_error_blank unless last_error.is_a?(Hash)
      parts = []
      code = Support.text(last_error['code'])
      detail = Support.text(last_error['message'])
      at = Support.text(last_error['at'])
      parts << Messages.code_text(code) unless code.empty?
      parts << detail unless detail.empty?
      parts << at unless at.empty?
      return Messages.state_error_blank if parts.empty?
      Messages.state_error(parts.join(' · '))
    end

    # 只取契约里真实存在的字段（不自造、不扩 schema）；非法记录直接跳过
    def normalize_record(raw_record)
      return nil unless raw_record.is_a?(Hash)
      id = Support.text(raw_record['id']).strip
      return nil if id.empty?
      kind = Support.text(raw_record['kind']).strip
      kind = 'other' unless KINDS.include?(kind)
      main_file = Support.nil_text(raw_record['mainFile'])
      {
        'id' => id,
        'name' => display_name(raw_record['name'], main_file, id),
        'kind' => kind,
        'category1' => Support.nil_text(raw_record['category1']),
        'category2' => Support.nil_text(raw_record['category2']),
        'relFolder' => Support.text(raw_record['relFolder']),
        'mainFile' => main_file,
        'suMajor' => Support.normalize_su_major(raw_record['suMajor']),
        'thumbRel' => Support.nil_text(raw_record['thumbRel']),
        'fileCount' => raw_record['files'].is_a?(Array) ? raw_record['files'].length : 0
      }
    end

    # 快照里存的是原始 Asset.name（不在导出时折叠）；展示名在这里兜底
    def display_name(name, main_file, id)
      candidate = Support.text(name).strip
      return candidate unless candidate.empty?
      from_file = Support.text(main_file).strip
      return from_file unless from_file.empty?
      id[0, 8]
    end

    # 3 s 轮询只比这两个字段（docs/39 §3.5：变了才重读 index.json）
    def signature
      path = Paths.manifest_path
      return 'no-manifest' if path.strip.empty? || !File.file?(path)
      text_value = Support.read_text(path)
      return 'bad-manifest' if text_value.nil?
      data = Support.parse_json(text_value)
      return 'bad-manifest' unless data.is_a?(Hash)
      Support.text(data['generatedAt']) + '|' + Support.text(data['indexSha256'])
    rescue StandardError
      'error'
    end
  end

  # ── 插入（DefinitionList#load，docs/36:129【查证】） ────────────────────────
  module Inserter
    module_function

    def result(ok, code, message)
      { :ok => ok ? true : false, :code => code, :message => message }
    end

    def insert(record, manifest)
      return result(false, ErrCode::PATH_GONE, Messages.no_model) unless record.is_a?(Hash)
      model = Sketchup.active_model
      return result(false, ErrCode::PATH_GONE, Messages.no_model) if model.nil?

      library_root = Support.text(manifest['libraryRoot']).strip
      return result(false, ErrCode::DISCOVERY_MISSING, Messages.no_library_root) if library_root.empty?

      rel_folder = Support.text(record['relFolder'])
      main_file = Support.text(record['mainFile'])
      if main_file.strip.empty?
        return result(false, ErrCode::PATH_GONE, Messages.no_main_file(record['name']))
      end

      # 用 File.join 拼，不手拼斜杠（relFolder 是 posix 相对路径，Windows 上同样可用）
      absolute = File.join(library_root, rel_folder, main_file)

      # 越界校验（等价 isWithinRoot）：失败即拒，不尝试「修正」路径
      unless Paths.within_root?(library_root, absolute)
        return result(false, ErrCode::PATH_OUTSIDE, Messages.outside_root(absolute))
      end

      unless File.file?(absolute)
        return result(false, ErrCode::PATH_GONE, Messages.file_gone(absolute))
      end

      # 版本预警（在 start_operation 之前问，避免交互弹窗夹在事务里）
      guard = version_guard(record)
      return guard unless guard.nil?

      model.start_operation(OP_NAME, true)
      definition = nil
      load_error = ''
      begin
        definition = model.definitions.load(absolute)
      rescue StandardError => error
        definition = nil
        load_error = error.message
      end

      if definition.nil?
        # 文件可能被移动/删除/损坏：abort 保证不留下半个组件定义
        begin
          model.abort_operation
        rescue StandardError
          nil
        end
        return result(false, ErrCode::PATH_GONE, Messages.load_failed(absolute, load_error))
      end

      begin
        model.commit_operation
      rescue StandardError => error
        return result(false, ErrCode::PATH_GONE, Messages.load_failed(absolute, error.message))
      end

      place(model, definition)
      result(true, nil, Messages.insert_ok(record['name']))
    end

    # 返回 nil 表示放行；返回 result 表示已拒（调用方直接返回它）
    def version_guard(record)
      file_major = Support.int_or_nil(record['suMajor'])
      return nil if file_major.nil?
      now_major = Support.su_major_now
      return nil if now_major.nil?
      return nil unless file_major > now_major
      answer = begin
        UI.messagebox(
          Messages.version_warning(record['name'], file_major, now_major),
          YES_NO_BUTTONS
        )
      rescue StandardError
        NO_ANSWER
      end
      return nil if answer == YES_ANSWER
      result(false, ErrCode::SU_TOO_NEW, Messages.version_cancelled)
    end

    # 插入落位：优先用 place_component（交回 SketchUp 的放置工具，用户自己点位置）；
    # 不可用时退回「放在原点」。两种情况都不额外算位置。
    def place(model, definition)
      begin
        if model.respond_to?(:place_component)
          model.place_component(definition)
          return true
        end
      rescue StandardError
        nil
      end
      begin
        entities = model.active_entities
        return false if entities.nil?
        entities.add_instance(definition, Geom::Transformation.new)
        true
      rescue StandardError
        # 定义已加载进当前模型，用户可以自己从「组件」里拖入：不视为失败
        false
      end
    end
  end

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
          UI.messagebox(
            "ID BOX 面板加载失败：找不到 panel.html。请重新安装插件（.rbz）。\n\n" \
            "已尝试以下路径：\n#{Paths.tried_paths_text()}"
          )
          return false
        end
      end
      reload
      begin
        if @dialog.visible?
          @dialog.bring_to_front
        else
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
      html = Paths.html_path
      return false if html.empty? || !File.file?(html)
      options = {
        :dialog_title => 'ID BOX',
        :preferences_key => 'idbox_panel_main_dialog',
        :scrollable => false,
        :resizable => true,
        :width => DIALOG_WIDTH,
        :height => DIALOG_HEIGHT,
        :min_width => DIALOG_MIN_WIDTH,
        :min_height => DIALOG_MIN_HEIGHT,
        :style => UI::HtmlDialog::STYLE_DIALOG
      }
      @dialog = UI::HtmlDialog.new(options)
      @dialog.set_size(DIALOG_WIDTH, DIALOG_HEIGHT)
      @dialog.set_min_size(DIALOG_MIN_WIDTH, DIALOG_MIN_HEIGHT)
      @dialog.center
      @dialog.set_file(html)
      @dialog.add_action_callback('ready') { |_context| on_ready }
      @dialog.add_action_callback('refreshIndex') { |_context| on_refresh }
      @dialog.add_action_callback('insertRecord') { |_context, record_id| on_insert(record_id) }
      @dialog.set_on_closed { stop_polling }
      true
    rescue StandardError => error
      puts("[ID BOX] build dialog failed: #{error.class}: #{error.message}")
      @dialog = nil
      false
    end

    # ── 回调 ───────────────────────────────────────────────────────────────
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

  # ── 菜单挂载（只挂一次） ───────────────────────────────────────────────────
  unless file_loaded?(__FILE__)
    begin
      UI.menu('Extensions').add_item('ID BOX 资产面板') { IDBoxPanel::Panel.instance.show }
    rescue StandardError => error
      puts("[ID BOX] menu registration failed: #{error.class}: #{error.message}")
    end
    file_loaded(__FILE__)
  end
end
