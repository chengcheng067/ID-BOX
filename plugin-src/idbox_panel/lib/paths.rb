# ID BOX · SketchUp 插件 —— lib/paths.rb（Paths + Diagnostics）
#
# 加载顺序（docs/42 §3.2）：序 2，必须在 lib/core 之后 —— 本文件依赖 core 的
# Support（Paths 用它读 ENV、转字符串）与 PLUGIN_VERSION（Diagnostics.write 写它）。
#
# 职责（docs/42 §2 文件 4）：「路径与诊断」这一横切关注点合并在一层：
#   - Paths：多候选支持目录 + 插件数据目录 + isWithinRoot 等价越界校验（docs/39 §4.1#8）；
#   - Diagnostics：建窗失败时的诊断落点（用户 2026-11-05 批准，只在建窗失败时调用）。
#
# ⚠️ 写盘点（2026-11-09 经主理人批准的有意松绑，docs/48 §7；2026-11 增补第③点）：
#   全包有**且仅有三个**写盘落点 ——
#     ① 本文件的 `Diagnostics.write` → %TEMP%\idbox_panel_diag.txt（仅建窗失败）；
#     ② lib/exporter.rb → %APPDATA%\idbox_export\（仅「导出至 IDBOX」的作业产物）；
#     ③ lib/usage_log.rb → %APPDATA%\idbox_export\usage\（仅「插入一次 = 用过一次」的
#        一条使用记录，几十字节、原子写、失败静默）。
#   除此之外一律不写：**绝不写库目录、绝不写 %APPDATA%\idbox\plugin\、绝不改动任何既有资产文件**。
#   `export_root` / `inbox_dir` 是落点②的**唯一定义处**，`export_root` 同时是落点③的根
#   （exporter.rb / usage_log.rb 都不得自己拼 `%APPDATA%`）。
#
# ⚠️ A7 纪律：本文件顶层必须在 `module IDBoxPanel` 内、无全局变量；
# `Paths` 保持 `module_function`（`def self.` 语义）—— 冒烟场景 B（smoke:116-122）
# 靠 monkey-patch 覆盖 `IDBoxPanel::Paths.support_candidates`，改成实例方法会失效。

module IDBoxPanel
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
        # 候选① 逐字保留（原 main.rb 里就是这个表达式）。
        # ⚠️ 拆分带来的唯一必要补充（如实报备）：原 main.rb 直接躺在支持目录里，所以
        # `File.dirname(__FILE__)` 就是支持目录；本文件在 `lib/` 内，dirname 会多一层 `lib/`
        # （`.../idbox_panel/lib` ⇒ 里面没有 panel.html）。因此在①之后追加①′＝回退一级
        # 取 lib 的上一级，这才是真机里的 `<Plugins>/idbox_panel`。①不删，保证行为是纯增量；
        # support_dir 只挑「目录存在且真有 panel.html」的第一个，所以两者不冲突。
        list << File.expand_path(File.dirname(__FILE__))
        list << File.expand_path(File.join(File.dirname(__FILE__), '..'))
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

    # 工具栏图标目录（T03 的 assets/toolbar.svg / toolbar.pdf 用）。
    # 照 html_path 的形状：走多候选 support_dir，**不得**用 __FILE__ 拼资源路径
    # （docs/42 §3.3 / docs/39 §4.4：扩展里的 __FILE__ 可能是相对路径，会算出不存在的目录）。
    # 这里只返回路径字符串，不校验文件是否存在（存在性由调用方决定如何提示）。
    def assets_dir
      dir = support_dir
      dir.empty? ? '' : File.join(dir, 'assets')
    end

    def asset_path(name)
      dir = assets_dir
      stem = Support.text(name)
      (dir.empty? || stem.empty?) ? '' : File.join(dir, stem)
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

    # R-2（docs/42 §13 R-2，2026-11-06 裁定）：校验用的 root **必须由环境推导，不得来自 JSON**——
    # 被校验对象本身是不可信输入（docs/39 §4.1#8），拿一个 JSON 值去校验另一个 JSON 值不成立。
    # 真根 = 写入侧 `src/main/paths.ts:20-22` 的 `thumbsDir()`，即 %APPDATA%\idbox\thumbs。
    # ⚠️ 不得用上面的 `plugin_dir` 当 root：它是索引快照目录，与 `thumbRel` 的实际归属不同根，
    #    用它校验会恒判越界、双轨永久失效。
    # 本方法只读 ENV、不碰盘、不抛异常；APPDATA 缺失 ⇒ 推 ''（**不回退**到 plugin_dir）。
    # 拼接口径与 plugin_dir 一致（File.join，Windows 反斜杠形态可被 absolute_like? 判定）。
    def thumbs_dir
      appdata = Support.text(ENV['APPDATA'])
      return '' if appdata.strip.empty?
      File.join(appdata, 'idbox', 'thumbs')
    end

    def manifest_path
      dir = plugin_dir
      dir.empty? ? '' : File.join(dir, MANIFEST_FILE)
    end

    # ── 导出收件箱（docs/48 §7 / docs/probe/su-export-to-idbox.md Q2）──────────
    #
    # `%APPDATA%\idbox_export` 是 `%APPDATA%\idbox` 的**同级兄弟目录**，不在它内部。
    # 这样「插件会写盘」这件事被物理限制在一个独立根里：`idbox\plugin\`（索引快照）、
    # `idbox\thumbs\`（缩略图）、`idbox\settings.json` / `logs\` 仍然**零写入**，
    # 也没有任何路径能拼到库目录里去（库根只读，见 exporter.rb 的边界校验）。
    #
    # 契约（已由主理人钉死，不得自行改动）：
    #   根       = %APPDATA%\idbox_export
    #   收件箱   = 根\incoming\<jobId>\  ← jobId = YYYYMMDD-HHmmss-<4 位随机>
    #   job 内容 = <baseName>.skp / <baseName>.cover.png / manifest.json（**最后写**）
    # 只读 ENV、不碰盘、不抛异常；APPDATA 缺失 ⇒ 推 ''（与 plugin_dir / thumbs_dir 同口径，
    # 绝不回退到任何其它根 —— 拿不准路径时宁可不写）。
    def export_root
      appdata = Support.text(ENV['APPDATA'])
      return '' if appdata.strip.empty?
      File.join(appdata, 'idbox_export')
    end

    def inbox_dir
      root = export_root
      root.empty? ? '' : File.join(root, 'incoming')
    end

    # 递归建目录（不用 FileUtils：插件 require 白名单只有 sketchup.rb / extensions.rb /
    # json / digest，见 docs/39 §4.1#3 与 main.rb 头注）。只建**目录**、不写任何文件；
    # 已存在直接算成功。永不抛异常，失败一律 false。
    def ensure_dir(path)
      dir = Support.text(path)
      return false if dir.strip.empty?
      return true if File.directory?(dir)
      parent = File.dirname(dir)
      return false if parent == dir          # 到达盘符根却仍不是目录 ⇒ 放弃
      return false unless ensure_dir(parent)
      begin
        Dir.mkdir(dir)
        true
      rescue StandardError
        # 并发/权限：只要最终确实是目录就算成功（另一个实例可能刚建好）
        File.directory?(dir)
      end
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

  # ── 失败诊断（写盘点①，用户 2026-11-05 批准） ──────────────────────────────
  #
  # ⚠️ 只允许在面板建窗失败时调用，成功路径一个字都不写（A6）。
  #   （写盘点② 是 lib/exporter.rb 的导出作业目录，见本文件头注；两者互不相干。）
  # 工具栏/菜单**注册失败**属注册阶段，不得调用本方法 —— 只 puts（docs/42 §7.3），
  # 否则用户正常启动 SketchUp 时也会产生诊断文件，破 A6。
  #
  # 为什么需要它：真机排查两轮都卡在"报错文案与真实原因不符"上（1.0.1 的
  # `set_min_size` NoMethodError 被折成"找不到 panel.html"）。有了这份文件，
  # 任何失败都能直接看到环境与真实异常，不必再靠猜或让用户手敲控制台。
  #
  # 落点：%TEMP%\idbox_panel_diag.txt（不写 ID BOX 的任何目录）。
  # 本方法自身也必须 rescue 全部异常 —— 诊断写不出来绝不能连带把面板搞崩。
  module Diagnostics
    module_function

    def path
      dir = Support.text(ENV['TEMP']).strip
      dir = Support.text(ENV['TMP']).strip if dir.empty?
      dir = '.' if dir.empty?
      File.join(dir, 'idbox_panel_diag.txt')
    end

    def stamp
      begin
        Time.now.utc.strftime('%Y-%m-%dT%H:%M:%SZ')
      rescue StandardError
        '(unknown time)'
      end
    end

    def write(reason, extra = nil)
      lines = []
      lines << 'ID BOX 面板诊断快照'
      lines << "生成时间(UTC): #{stamp}"
      lines << "插件版本: #{PLUGIN_VERSION}"
      lines << "Ruby: #{RUBY_VERSION}"
      lines << "SketchUp: #{Support.text(Sketchup.version)}"
      lines << "失败原因: #{Support.text(reason)}"
      lines << "extra: #{Support.text(extra)}" unless extra.nil?
      lines << ''
      lines << "__FILE__: #{Support.text(__FILE__)}"
      lines << "ENV['APPDATA']: #{Support.text(ENV['APPDATA'])}"
      lines << "ENV['TEMP']: #{Support.text(ENV['TEMP'])}"
      lines << "Encoding.default_external: #{Encoding.default_external.to_s}"
      lines << ''
      lines << '候选支持目录（dir? / panel.html?）：'
      Paths.support_candidates.each do |dir|
        lines << format(
          '  %s | dir=%s | panel.html=%s',
          dir,
          (File.directory?(dir) ? 'Y' : 'N'),
          (File.file?(File.join(dir, 'panel.html')) ? 'Y' : 'N')
        )
      end
      lines << "support_dir 命中: #{Paths.support_dir.inspect}"
      lines << ''
      lines << '插件数据文件：'
      [Paths.manifest_path, Paths.index_path].each do |file|
        next if file.to_s.empty?
        exists = (File.file?(file) ? 'Y' : 'N')
        size = (File.file?(file) ? (File.size(file).to_s + ' B') : '-')
        lines << "  #{file} | exists=#{exists} | size=#{size}"
      end
      begin
        File.open(path, 'w') do |f|
          f.write(lines.join("\n"))
          f.write("\n")
        end
        true
      rescue StandardError
        false
      end
    rescue StandardError
      false
    end

    # 对话框相关的调用序列（知道自己调了哪些 HtmlDialog 方法，便于对照官方 API）
    def describe_dialog(dialog)
      return '(无 dialog 对象)' if dialog.nil?
      calls = (dialog.respond_to?(:calls) ? dialog.calls : nil)
      calls.nil? ? '(不可读)' : calls.inspect
    rescue StandardError
      '(读取失败)'
    end
  end
end
