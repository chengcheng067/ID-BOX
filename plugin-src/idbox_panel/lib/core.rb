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
  # 插件**包**版本。字面量只在本行出现一次（对外别名见 main.rb 的 VERSION）。
  # ⚠️ 根注册文件 idbox_panel.rb 的 Registrar::EXT_VERSION **必须与本值同值** ——
  #    那份文件是扩展入口、本文件由 main.rb 加载，入口执行时这里还不存在，
  #    所以那边**无法**引用本常量，只能人工同步（那边有同样的说明，两处一起改）。
  # 1.1.0 → 1.1.1（2026-11-09）：1.1.0 的快照里 `Snapshot#thumbs_root` 恒返回空串
  # （R-2 修复之前），面板封面全部降级成类型图标；1.1.1 含该修复 + 本批 UI/材质改动。
  # 1.1.1 → 1.2.0（2026-11-09）：功能性新增（右键「导出至 IDBOX / 更新 IDBOX 中的这个模型」，
  # 见 docs/48 §7）⇒ 按语义化版本升 minor。**不是** bugfix，不要改回 patch 位。
  # 1.2.0 → 1.2.1（2026-11-09 装机实测反馈）：**行为修复**，三处"报告成功但其实没成功"：
  #   ① 右键「更新」判据（不再要求先选中）+ 导出前可命名 + 文档级更新整份存盘；
  #   ② 材质"当前材质"从未生效（用了不存在的 `Model#active_material`，改为官方
  #      `Model#materials.current=` 并读回断言）；
  #   ③ 面板侧栏一级分类与本体同构（全部视图不再混排模型/材质的一级分类）+
  #      「大/中/小」预览档从纯文本做成可点并能记忆。
  #   ⇒ 按语义化版本升 patch。**与 idbox_panel.rb 的 EXT_VERSION 必须同值**（smoke 有断言）。
  # 1.2.1 → 1.2.2（2026-11-09 用户实测）：材质双击后**自动切油漆桶工具**
  #   （`Sketchup.send_action('selectPaintTool:')`，失败容错、只影响成功路径）。
  # 1.2.2 → 1.2.3（2026-11-09 用户实测）：面板**只显示 SketchUp 模型**——
  #   `.skp` 与 `.max` 在索引里 kind 都是 model，之前只按 kind 过滤会把 3ds Max 文件放进插件；
  #   改为「kind=model ⇒ 主文件扩展名白名单（skp）」的显示过滤（面板侧一处判据）。
  # 注意：这不是主程序版本（主程序仍是 0.9.3）；面板显示的是主程序 appVersion。
  PLUGIN_VERSION = '1.3.0'.freeze
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

  # ── 折叠态（用户 2026-11-09 拍板：自绘「关闭 + 折叠」两个按钮，docs/48 §6）────────
  # 折叠 = 整个窗口收成一条窄栏（只剩 logo + 品牌 + 版本 + 两个窗口按钮），真的省屏幕空间。
  # 高度取顶栏高度 + 4px（顶栏 56px，见 panel.html `.topbar`），不靠猜。
  DIALOG_COLLAPSED_HEIGHT = 60
  # ⚠️ SU 侧的 :min_height 必须 ≤ DIALOG_COLLAPSED_HEIGHT，否则 set_size 会被系统钳制在 520，
  #    折叠就变成「窗口没变小」——功能等于失效。因此 build_dialog 里 :min_height 用**折叠高度**，
  #    展开态的物理下限改由 panel.html 的 CSS（body min-height: 520px）承担。
  #    ⚠️ 代价一（已由 team-lead 2026-11-09 拍板接受，**不要"优化"回去**）：
  #       用户手动可以把这个窗口拖到 60px 高，此时展开态内容会被裁切（拖大即恢复）。
  #       反过来把 :min_height 提回 520 会直接让「折叠」这个功能失效（set_size 被钳制），
  #       而 UI::HtmlDialog 没有 set_min_size、也没有"只在折叠时改最小高度"的办法。
  #       取舍：宁可允许用户拖小（可恢复），也不能让折叠按钮点了没反应（不可理解）。
  DIALOG_COLLAPSED_MIN_WIDTH = 320

  OP_NAME = '插入 ID BOX 资产'.freeze
  CODE_PREFIX = 'IDBOX-'.freeze

  # 六值（types.ts:19）
  KINDS = %w[model texture hdri material cad other].freeze
  # 允许「单击插入模型」的 kind：只有 model。
  # ⚠️ 材质（texture / material）不走这里：它走**双击建材质**（MATERIAL_KINDS + Materializer），
  #    见 docs/48 §6「材质双击语义」——只建材质并设为当前材质，绝不自动贴面。
  INSERTABLE_KINDS = %w[model].freeze
  # 允许「双击创建材质」的 kind（2026-11-09 拍板，docs/48 §6）。
  # 与 INSERTABLE_KINDS 分开：两者动作不同（插组件 vs 建材质），不要合并成一个表。
  MATERIAL_KINDS = %w[texture material].freeze
  # 材质相关的两个文案常量（面板显示 + 操作名）
  MATERIAL_OP_NAME = '创建 ID BOX 材质'.freeze
  KIND_LABELS = {
    'model' => '模型',
    'texture' => '贴图',
    'hdri' => 'HDRI',
    'material' => '材质',
    'cad' => 'CAD',
    'other' => '其他'
  }.freeze

  UNSUPPORTED_INSERT_HINT = '材质/贴图取用待真机验证，暂不支持'.freeze
  # 设置入口的指路文案（用户可见）。必须**短**：101/102 的 message 只进顶部提示条，
  # 而提示条是「≤ 单行 + 省略号」（docs/42 §4.1 / P1-2）⇒ 太长会把「怎么办」那段截掉。
  # 实测预算：960px 窗口里约 78 个汉字可见。带完整路径的写法（→ 数据与备份 → …）留给弹窗类文案。
  SETTINGS_HINT = 'ID BOX 的「设置 · SketchUp 插件」'.freeze

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
    # 2026-11-09 新增（V1.0「导出至 IDBOX」，docs/48 §7）：**启用预留编号，不改既有 101–106**。
    # docs/39:23 / :264 曾把 107–110 标为「预留但不定义」，理由是「插件纯读方 ⇒ 写入失败没有
    # 可观测形态」。本批经主理人批准开了唯一的写盘落点（%APPDATA%\idbox_export\），
    # 于是「导出作业没产出」「收件箱不可写」第一次成为**用户可见的失败**，必须有自己的码，
    # 否则只能借用 101（会把「权限不足」说成「文件缺失」，真机排障会重复 1.0.1 的老路）。
    # 只启用 107 / 108 两条，109 / 110 仍保持预留、不定义。
    EXPORT_FAILED = '107'.freeze     # 导出失败（没有产出可被 ID BOX 收下的作业）
    INBOX_UNWRITABLE = '108'.freeze  # 收件箱不可写 / 导出目标路径越界
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

    # ── 101 / 102 的**用户可见**文案（2026-11-09 续卡：界面不得出现内部字段名）──────
    # 纪律（与 panel.html 的「字段名词表」断言同一条）：
    #   - **字段名不许出现**：pluginIndexEnabled / indexSha256 / indexCount / libraryRoot /
    #     mainFile / relFolder / isWithinRoot 之类，用户不知道是什么，只会以为软件在报错；
    #   - **文件名可以出现**：manifest.json / index.json 是用户能在资源管理器里对上的东西，
    #     101 的文案本来就要求指明落点，留着更利于自助排查；
    #   - 排障细节（开关取值 / 哈希片段 / 声明条数）**留在内存态**：
    #     `IDBoxPanel::Loader.load.manifest[...]` 在 SketchUp 的 Ruby 控制台可读；
    #     不新增任何写盘通道。
    #   - 101 的用户视角 =「插件还没拿到索引 + 你去哪打开导出」，
    #     **不要**解释成「我们内部有个开关是 false」。
    #   - ☑ 单行预算：这些 message 只进顶部提示条（≤ 单行 + 省略号），所以**第一行必须
    #     自带「怎么办」**，第二行的「预期位置」属补充信息，被截掉也不影响自助。
    def missing_manifest(path)
      "插件还没拿到索引：请到 #{SETTINGS_HINT}打开「插件索引导出」，再点 ID BOX 里的「刷新索引」。\n" \
      "预期位置：#{Support.text(path)}"
    end

    def index_disabled
      "插件还没拿到索引：「插件索引导出」还没打开，请到 #{SETTINGS_HINT}打开它，再点「刷新索引」。"
    end

    def index_flag_missing
      "插件还没拿到索引（导出开关状态不明）：请到 #{SETTINGS_HINT}打开「插件索引导出」，再点「刷新索引」。"
    end

    def missing_index(path)
      "只找到索引清单、没找到索引内容：可能还没写完 —— 请稍等几秒，或在 ID BOX 里点「刷新索引」后重试。\n" \
      "预期位置：#{Support.text(path)}"
    end

    def bad_manifest(message)
      "索引清单（manifest.json）读不出来或格式不对，请点 ID BOX 里的「刷新索引」重新导出。\n" \
      "（#{Support.text(message)}）"
    end

    def bad_index(message)
      "索引内容（index.json）读不出来或格式不对，请点 ID BOX 里的「刷新索引」重新导出。\n" \
      "（#{Support.text(message)}）"
    end

    # 完整性校验失败：讲「怎么回事 + 怎么办」；哈希片段属排障细节，不上界面。
    # 形参保留（调用方是 loader.rb：hash_mismatch(attempts, expected, actual)）。
    def hash_mismatch(rounds, _expected, _actual)
      "索引文件与校验值连续 #{rounds} 次对不上：可能正在写入；若一直如此，请点 ID BOX 里的「刷新索引」重新导出。"
    end

    def digest_unavailable
      '当前 SketchUp 的 Ruby 环境缺少校验组件，本轮跳过索引完整性校验（仍会检查文件是否可读）。'
    end

    def sha_missing
      '这份索引没有带完整性校验值，本轮跳过完整性校验（仍会检查文件是否可读）。'
    end

    def user_dir_non_ascii(path)
      "提示：当前用户目录含非 ASCII 字符（#{Support.text(path)}）。" \
      '若面板偶尔加载异常，属已知风险，不是错误。'
    end

    def count_mismatch(declared, actual)
      "索引里声明的素材条数与实际读到的不一致（声明 #{declared} / 实际 #{actual}）——" \
      '可能正在写入，本面板以实际读到的条数为准。'
    end

    # 版本不匹配 ⇒ 只读展示的**用户可见**文案（2026-11-09 续卡：界面不得出现内部字段名）。
    # 口径与 panel.html 的两处前端拦截**同一套话术**：说清「禁用了什么」+「怎么办」，
    # 不出现 apiVersion / manifest. / 具体数值。
    #
    # 两侧（清单 / 内容）**故意用同一句话**：用户能做的动作是同一个（升到同一版本），
    # 区分是哪一侧对不上对他没有价值，反而会在提示条里出现两句几乎一样的话。
    # （面板 renderBanner 会对 readOnlyReason 按行去重，两侧同时不匹配时只显示一句。）
    #
    # 技术细节（实际值 / 期望值 / 是哪一侧）**故意不进文案**，但没有丢：
    #   - manifest 侧原始值仍在 `Snapshot#manifest['apiVersion']`（内存态）；
    #   - 同时照样随 payload 下发给面板（`payload.apiVersion`，内存态）。
    # 排查时在 SketchUp 的 Ruby 控制台执行 `IDBoxPanel::Loader.load.manifest['apiVersion']` 即可读到。
    # ⚠️ 不要为了「留细节」新增写盘通道：插件零写盘（唯一例外是建窗失败的 Diagnostics），
    #    也不能把内部字段名塞回提示条。要接诊断导出，须走既有通道并另行回签。
    # ⚠️ 形参仍然保留两个：调用方是 loader.rb（本卡不动它），删参数会 ArgumentError。
    def api_mismatch(_where, _value)
      'ID BOX 与插件版本不匹配，插入与建材质已禁用；请把主程序与插件升级到同一版本。'
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
      '索引里缺少库目录信息，无法把素材的相对路径换算成绝对路径。请在 ID BOX 里点一次「刷新索引」重新导出。'
    end

    def no_main_file(name)
      "「#{Support.text(name)}」没有主文件，无法插入。"
    end

    def outside_root(abs)
      "路径越界被拒：#{Support.text(abs)} 不在当前库根目录内。\n" \
      '为保持只读与安全，插件只允许加载库根目录之下的文件。'
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
      "当前 SketchUp 版本是 #{Support.text(current)}，本插件需要 SketchUp #{MIN_SU_MAJOR} 或更新的版本。\n" \
      '请升级 SketchUp 后重试。'
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

    # ── 材质（双击创建，docs/48 §6）────────────────────────────────────────
    # 语义口径（用户逐字）：「双击以后我们创建了材质，然后 SketchUp 里面就会有油漆桶，
    # 右侧会显示当前的材质是什么。用户想怎么贴怎么贴，后面不归我们管」
    # ⇒ 成功的文案必须点明「**没有**自动贴到任何面上」，否则用户会以为已经贴好了。
    def material_ok(name)
      "已创建材质「#{Support.text(name)}」并设为当前材质（油漆桶已就绪，贴到哪个面由你决定；未自动贴面）"
    end

    def material_no_image(name)
      "「#{Support.text(name)}」里找不到可用的贴图文件（只认 jpg / jpeg / png / bmp / tif / tiff），材质未创建。"
    end

    # 材质建出来了但贴图没挂上：**不静默**，也不回滚（用户仍能拿到一个可用的空材质手动换图）
    def material_texture_missing(name, detail)
      tail = Support.text(detail).empty? ? '' : "（#{Support.text(detail)}）"
      "材质「#{Support.text(name)}」已创建并设为当前材质，但贴图没挂上#{tail}。" \
      '可在 SketchUp 的「材质」面板里手动选图。'
    end

    # 材质建出来了、但「当前材质」没切过去（2026-11-09 装机实测：材质只进了「模型中」列表）。
    # ⚠️ 这句是**如实告知**，不是免责：因为此时油漆桶拿起来的不是这个材质。
    def material_not_current(name, detail)
      tail = Support.text(detail).empty? ? '' : "（#{Support.text(detail)}）"
      "材质「#{Support.text(name)}」已创建（在「材质」面板的「模型中」里），但没能切成当前材质#{tail}。\n" \
      '请在「材质」面板里点一下它，再用油漆桶贴。'
    end

    def material_exception(detail)
      "创建材质时出现异常：#{Support.text(detail)}"
    end

    # 形参保留（调用方是 loader.rb）：值（相对目录）不上界面，排障时看记录本身即可。
    def no_asset_folder(_rel)
      '这条记录没有可用的资产目录，无法定位贴图。'
    end

    # ── 导出至 ID BOX / 更新库内模型（右键菜单，docs/48 §7）────────────────────
    # 口径：**成功不弹窗**（只落 Sketchup.status_text 轻提示），只有失败才 messagebox ——
    # 导出是建模中途的高频动作，每次都弹窗会打断手感（与 on_apply_material 同一条纪律）。
    def export_no_model
      '当前没有打开的 SketchUp 模型，无法导出。请先新建或打开一个模型。'
    end

    def export_no_selection
      '请先在 SketchUp 里选中要导出的对象（组件、组或若干实体），再点「导出至 IDBOX」。'
    end

    # detail 为空时不带括号尾巴（避免出现「导出失败（）。」这种半截文案）
    def export_failed(detail)
      tail = Support.text(detail).empty? ? '' : "（#{Support.text(detail)}）"
      "导出失败#{tail}。\n没有生成可被 ID BOX 收下的作业，半成品已清理。"
    end

    def export_inbox_unavailable(dir)
      shown = Support.text(dir).strip
      shown = '%APPDATA%\\idbox_export\\incoming' if shown.empty?
      "无法写入 ID BOX 的导出收件箱：#{shown}\n" \
      "这个目录与 ID BOX 的库目录是分开的，插件只会写这里。\n" \
      '请确认当前 Windows 用户对它可写（权限不足 / 磁盘满 / 安全软件拦截都可能）。'
    end

    def export_outside(path)
      "导出目标路径越界被拒：#{Support.text(path)}\n" \
      '为保持库只读，插件只允许写 %APPDATA%\\idbox_export 之下，绝不写库目录。'
    end

    def export_ok(name, job_id)
      "已导出「#{Support.text(name)}」到 ID BOX 收件箱（作业 #{Support.text(job_id)}）。" \
      'ID BOX 收到后会自动入库；若它此刻没开，下次启动也会自动收下。'
    end

    def export_ok_no_cover(name, job_id)
      "已导出「#{Support.text(name)}」（作业 #{Support.text(job_id)}），但当前视口截图失败：" \
      '封面将回落到 .skp 自带的预览图，几何本体不受影响。'
    end

    def export_exception(detail)
      "导出过程中出现异常：#{Support.text(detail)}\n本次没有生成任何文件（半成品已清理）。"
    end

    # 命名对话框点「取消」：不写任何文件，所以文案要说清「什么都没发生」，不要像报错。
    def export_cancelled
      '已取消导出：没有生成任何文件。'
    end

    # 菜单刚算过、点下来却认不出目标（文件被挪走/删掉）：这是 410 语义，必须说清而不是去建副本。
    def update_target_gone
      "这个模型已经不在 ID BOX 库里了（文件被移动、改名或删除）。\n" \
      '请确认库目录是否改过，或在 ID BOX 里刷新索引后重试；本次没有导出任何文件。'
    end

    def update_ok(name)
      "已提交更新「#{Support.text(name)}」：覆盖同名 .skp 本体，" \
      '分类 / 渲染参数 / 自定义封面保持不动。'
    end

    def update_ok_no_cover(name)
      "已提交更新「#{Support.text(name)}」：覆盖同名 .skp 本体（分类 / 渲染参数 / 自定义封面不动）。" \
      '但当前视口截图失败，这一版没有新封面 —— 包里原有的封面会继续留着。'
    end

    def update_no_index
      "读不到 ID BOX 的插件索引（manifest.json / index.json），无法判断这个模型属于库里哪条资产。\n" \
      "请到 #{SETTINGS_HINT}打开「插件索引导出」，并在 ID BOX 里刷新一次索引。"
    end

    # 「更新」的失败不是错误，是**认不出身份**：必须明确说清「不在库里」，并给下一步选项，
    # 绝不静默复制一份（那会在库里留下两条一模一样的资产）。
    def update_ask_create(name)
      "「#{Support.text(name)}」不在 ID BOX 库里（找不到它对应的库内文件路径）。\n\n" \
      '要改为「导出为新资产」吗？选「否」则本次什么都不做。'
    end

    def update_cancelled
      '已取消：这个模型不在 ID BOX 库里，本次没有导出。'
    end

    def update_no_name
      '认不出这个模型的名字（组件名与文档名都是空的），无法为导出文件命名。请给组件或文档起个名再试。'
    end
  end
end
