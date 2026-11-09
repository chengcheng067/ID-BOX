# ID BOX · SketchUp 插件离线冒烟（不需要 SketchUp、不需要安装插件）
#
# 为什么有这个脚本（2026-11-05 的教训）：
#   1.0.1 里写了 `@dialog.set_min_size(...)` —— `UI::HtmlDialog` **没有**这个方法，
#   抛 NoMethodError 后被 rescue 折成"找不到 panel.html"，真机排查白跑两轮。
#   当时的"结构粗筛 + 契约对账"完全抓不到这类错。
#
# 做法：用只实现**官方文档列出的方法**的桩替身跑一遍 `Panel#show`。
#   桩里故意不实现 set_min_size / set_content_size 之外的多余方法，
#   所以任何越界调用都会当场抛 NoMethodError —— 这正是我们要抓的。
#
# T01 新增（docs/42 §3.4）：
#   ① `Sketchup.require` 转发桩（main.rb 收敛为装配入口后靠它加载 5 个 lib/*.rb）；
#   ② 最小 `UI::Command` / `UI::Toolbar` 桩（T03 的注册链；越界调用照样抛 NoMethodError）。
#   判据（场景 A/B）与 `require 'idbox_panel/main'` 保持不变。
#
# 用法（在仓库根目录）：
#   ruby scripts/plugin-smoke.rb <ruby.exe 路径可省，默认 PATH 里的 ruby>
#
# 判据：
#   · 场景 A 期望 show() => true，且**不产生诊断文件**（成功路径零写盘）；
#   · 场景 B（强制找不到 panel.html）期望 show() => false，且写出诊断文件。
#   任一不符即退出码 1。

root = File.expand_path('..', __dir__)
# 场景 F 会 spawn 一个 Electron 子进程；输出必须实时刷出，否则一旦子进程异常，
# 已被管道缓冲的行会连同「跑到哪一步」一起丢掉，排查时看不出断点。
$stdout.sync = true
# ⚠️ 这两行必须保留（docs/42 §3.4「辨析·勿误删」）：官方 U6「Don't modify the $LOAD_PATH」
# 只约束**插件在 SketchUp 进程内**的代码（plugin-src/），不约束离线测试脚手架。
# 删了它们 `require 'sketchup.rb'`（桩）与 `require 'idbox_panel/main'` 都解析不了。
$LOAD_PATH.unshift File.join(root, 'scripts', 'plugin-stub')
$LOAD_PATH.unshift File.join(root, 'plugin-src')

module Sketchup
  def self.version
    '24.0.0'
  end

  # 桩里刻意返回 nil：逼插件走 __FILE__ / AppData 兜底分支（真机也常是这条）
  def self.find_support_file(_name, _path = nil)
    nil
  end

  def self.status_text=(_value); end

  # 官方 Sketchup.platform（SU 6.0，返回 :platform_win / :platform_osx）。
  # 补这个桩之前，guard 块里的 Toolbar.build 会抛 NoMethodError → 整块 registration failed，
  # 连带把同一 guard 块里的右键菜单注册也吞掉（V1.0 新增上下文菜单后才发现这个空洞）。
  def self.platform
    :platform_win
  end

  def self.active_model
    nil
  end

  # ── T01 新增：Sketchup.require 转发桩（照 api-report §15:921-936 的绝对路径版） ──
  # 要点：用绝对路径拼、不再改动 $LOAD_PATH、天然「只加载一次」（Kernel.require 去重）、
  # 返回 Boolean、找不到文件只打印控制台、不抛 LoadError（官方行为：SU 2026.2 起才抛）。
  # 桩内常量（非插件代码）；__dir__ 即 scripts/，'..' 为仓库根；
  # 不复用文件顶部 :19 的局部 root —— module 作用域不共享局部变量。
  IDBOX_PLUGIN_ROOT = File.join(File.expand_path('..', __dir__), 'plugin-src')

  def self.require(path)
    rel = path.to_s
    rel = rel.empty? ? '' : (rel.end_with?('.rb') ? rel : (rel + '.rb'))  # 明文包：不带 .rb → 补 .rb
    return false if rel.empty?
    full = File.join(IDBOX_PLUGIN_ROOT, rel)
    unless File.file?(full)
      puts "[smoke] Sketchup.require miss: #{full}"   # 2021 行为：打印控制台，不抛 LoadError
      return false
    end
    # 显式写 Kernel.require：不能裸写 require（会递归回本桩自己）
    Kernel.require(full)
  end
end

module UI
  MB_OK = 0
  MB_YESNO = 4
  IDYES = 6
  IDNO = 7

  class Menu
    def initialize(*_args); end
    def add_item(*_args); Object.new; end
    def add_submenu(*_args); Object.new; end
  end

  # ⚠️ 这里**只能**列出 ruby.sketchup.com/UI/HtmlDialog 上确实存在的方法。
  class HtmlDialog
    STYLE_DIALOG = 1
    STYLE_UTILITY = 2
    STYLE_WINDOW = 3
    CEF_VERSION = 'stub'
    CHROME_VERSION = 'stub'

    attr_reader :calls, :file_path, :opts

    def initialize(opts = {})
      @opts = opts
      @calls = []
    end

    def set_size(width, height); @calls << [:set_size, width, height]; true; end
    def set_content_size(width, height); @calls << [:set_content_size, width, height]; nil; end
    def set_position(left, top); @calls << [:set_position, left, top]; true; end
    def center; @calls << :center; true; end
    def bring_to_front; @calls << :bring_to_front; nil; end
    def set_file(file); @calls << [:set_file, file]; @file_path = file; nil; end
    def set_html(html); @calls << [:set_html, html.to_s.length]; nil; end
    def set_url(url); @calls << [:set_url, url]; nil; end
    def add_action_callback(name, &block); @calls << [:cb, name]; (@callbacks ||= {})[name] = block; true; end
    def set_on_closed(&block); @calls << :on_closed; (@on_closed = block); true; end
    def execute_script(script); @calls << [:script, script.to_s.length]; nil; end
    def show; @calls << :show; nil; end
    def show_modal; @calls << :show_modal; nil; end
    def close; @calls << :close; nil; end
    def visible?; true; end
  end

  # ── T01 新增：最小 UI::Command / UI::Toolbar（只实现官方 ≤2017 方法） ──
  # 延续「桩只实现官方列出的方法、越界即抛 NoMethodError」的纪律（api-report §1:58-87、§2:110-136）。
  # 官方 Version 标签 > 2017 的方法一律不实现：get_validation_proc / proc / extension=（2022.0）、
  # load_error（2026.2）——用了就当场 NoMethodError，正是 A2 要抓的东西。
  class Command
    attr_accessor :small_icon, :large_icon, :tooltip, :status_bar_text, :menu_text

    def initialize(menutext, &block)
      @menutext = menutext
      @block = block
      @calls = []
    end

    attr_reader :calls, :menutext

    def set_validation_proc(&block)
      @calls << :set_validation_proc
      (@validation_proc = block)
      self
    end

    def run
      @calls << :run
      @block.nil? ? nil : @block.call
    end
  end

  class Toolbar
    attr_reader :items, :calls, :name

    def initialize(name)
      @name = name
      @items = []
      @calls = []
    end

    def add_item(cmd)
      @calls << :add_item
      @items << cmd
      self
    end

    def add_separator
      @calls << :add_separator
      self
    end

    def show; @calls << :show; nil; end
    def hide; @calls << :hide; nil; end
    def restore; @calls << :restore; nil; end
    def visible?; false; end
    def get_last_state; -1; end   # 模拟 TB_NEVER_SHOWN 首装
  end

  def self.messagebox(*args)
    puts "  [MSGBOX] #{args.first.to_s.lines.first.to_s.strip}"
    1
  end

  def self.menu(name = 'Plugins'); Menu.new(name); end
  def self.menu_append_item(*_args); Object.new; end

  # ── V1.0 新增：右键菜单挂载（官方 UI.add_context_menu_handler，SU 6.0）──
  # 桩只记录回调、**不执行** —— 冒烟要验的是「注册链没越界调用」，不是菜单交互。
  # 返回 nil 与官方一致；handler 真正被调用需要 active_model，属真机范畴。
  def self.add_context_menu_handler(&block)
    (@context_menu_handlers ||= []) << block
    nil
  end

  def self.context_menu_handlers
    @context_menu_handlers || []
  end
end

require 'idbox_panel/main'

failures = []
diag = IDBoxPanel::Diagnostics.path
File.delete(diag) if File.file?(diag)

# ── 加载链自检（T01 新增，只做事实打印，不改 A/B 判据） ──
loaded_chain = %w[
  IDBoxPanel
  IDBoxPanel::ErrCode
  IDBoxPanel::Support
  IDBoxPanel::Messages
  IDBoxPanel::Paths
  IDBoxPanel::Diagnostics
  IDBoxPanel::Snapshot
  IDBoxPanel::Loader
  IDBoxPanel::Inserter
  IDBoxPanel::PanelCallback
  IDBoxPanel::Panel
  IDBoxPanel::Exporter
]
missing = loaded_chain.select do |name|
  begin
    !Object.const_get(name)
  rescue NameError
    true
  end
end
puts "── 加载链（序 1-5）──"
puts "  已定义常量: #{loaded_chain.length - missing.length}/#{loaded_chain.length}"
puts "  缺失: #{missing.inspect}" unless missing.empty?
puts "  PanelCallback::CALLBACK_NAMES => #{IDBoxPanel::PanelCallback::CALLBACK_NAMES.inspect}"
failures << '加载链：存在未定义模块' unless missing.empty?
failures << 'A8 契约：CALLBACK_NAMES 应为 ready/refreshIndex/insertRecord' unless
  IDBoxPanel::PanelCallback::CALLBACK_NAMES == %w[ready refreshIndex insertRecord]
failures << 'A7：Paths.support_candidates 必须是 def self.（冒烟场景 B 的 monkey-patch 依赖它）' unless
  IDBoxPanel::Paths.respond_to?(:support_candidates)

puts
puts "── 场景 A：正常（panel.html 存在）──"
panel = IDBoxPanel::Panel.new
ok = panel.show
dialog = panel.instance_variable_get(:@dialog)
puts "  show() => #{ok.inspect}"
puts "  set_file => #{dialog.file_path.inspect} exists=#{File.file?(dialog.file_path.to_s)}"
puts "  calls => #{dialog.calls.map { |c| c.is_a?(Array) ? c.first : c }.inspect}"
wrote = File.file?(diag)
puts "  成功路径写盘了吗（期望 false）=> #{wrote}"

failures << '场景 A：show() 应为 true' unless ok == true
failures << '场景 A：set_file 应指向真实存在的 panel.html' unless dialog && File.file?(dialog.file_path.to_s)
failures << '场景 A：成功路径不应写诊断文件' if wrote

puts
puts '── 场景 B：强制失败（模拟找不到 panel.html）──'
module IDBoxPanel
  module Paths
    def self.support_candidates
      []
    end
  end
end
panel2 = IDBoxPanel::Panel.new
ok2 = panel2.show
wrote2 = File.file?(diag)
puts "  show() => #{ok2.inspect}"
puts "  失败时写诊断了吗（期望 true）=> #{wrote2}"
if wrote2
  puts '  ── 诊断文件内容 ──'
  puts File.read(diag).lines.map { |line| '  ' + line }.join
end

failures << '场景 B：show() 应为 false' unless ok2 == false
failures << '场景 B：失败时应写出诊断文件' unless wrote2

puts
puts '── 场景 C：R-2 越界用例（root 必须来自 ENV，不得来自 JSON）──'
env_root = IDBoxPanel::Paths.thumbs_dir
puts "  ENV 推导根（可信）=> #{env_root.inspect}"

# 被校验对象：manifest 里的 thumbsRoot 是「伪造的库根」，record 的 thumbRel 带 `..` 逃逸
evil_manifest = { 'thumbsRoot' => 'C:\\evil\\not-thumbs' }
evil_records = [{ 'id' => 'x1', 'thumbRel' => '../../evil/x.png' }]
snap = IDBoxPanel::Snapshot.new(
  :ok => true,
  :manifest => evil_manifest,
  :records => evil_records,
  :notes => []
)
got = snap.thumbs_root
puts "  thumbs_root 回传值 => #{got.inspect}"
puts "  notes => #{snap.notes.inspect}"

# 断言①：回传的必须是 ENV 推导根，绝不能是 JSON 里的值（JSON 值不可作 root）
failures << '场景 C：回传的 root 应为 ENV 推导值，不是 JSON 值' unless got == env_root
failures << '场景 C：JSON 伪造值不得出现在返回值里' if got.to_s.include?('evil') && env_root.to_s.empty?
# 断言②：越界走 IDBOX-105，由 notes 承载
notes_text = snap.notes.join(' ')
failures << '场景 C：越界应由 notes 承载 IDBOX-105' unless notes_text.include?('IDBOX-105')
# 断言③：`..` 逃逸被拒（校验口径本身）
failures << '场景 C：`..` 逃逸应被 within_root? 判否' if
  IDBoxPanel::Paths.within_root?(env_root, File.join(env_root, '../../evil/x.png'))
# 断言④：plugin_dir 作 root 会恒判越界（R-2 的裁定理由，留一条反证打印）
probe = File.join(env_root, 'ok.png')
puts "  反证：用 plugin_dir 当 root 校验真文件 => #{IDBoxPanel::Paths.within_root?(IDBoxPanel::Paths.plugin_dir, probe).inspect}（应为 false）"
puts "  正常记录（根内）=> #{IDBoxPanel::Paths.within_root?(env_root, File.join(env_root, 'ok.png')).inspect}（应为 true）"

# 断言⑤：APPDATA 缺失 ⇒ 推 ''（不回退 plugin_dir），A12 降级口径不变
saved_appdata = ENV['APPDATA']
ENV['APPDATA'] = nil
empty_root = IDBoxPanel::Paths.thumbs_dir
puts "  APPDATA 缺失时 thumbs_dir => #{empty_root.inspect}（应为 \"\"）"
failures << '场景 C：APPDATA 缺失应推空值（不回退 plugin_dir）' unless empty_root == ''
ENV['APPDATA'] = saved_appdata

puts
puts '── 场景 D：V1.0 导出收件箱契约（docs/48 §7）──'
export_root = IDBoxPanel::Paths.export_root
inbox = IDBoxPanel::Paths.inbox_dir
idbox_data = File.join(saved_appdata.to_s, 'idbox')
puts "  export_root => #{export_root.inspect}"
puts "  inbox_dir   => #{inbox.inspect}"
puts "  %APPDATA%\\idbox => #{idbox_data.inspect}"

# 判据①：收件箱必须叫 <export_root>\incoming，且 export_root 在 %APPDATA% 下
failures << '场景 D：inbox_dir 应为 <export_root>/incoming' unless inbox == File.join(export_root, 'incoming')
failures << '场景 D：export_root 必须落在 %APPDATA% 之下' unless
  export_root.start_with?(saved_appdata.to_s) && !saved_appdata.to_s.empty?
# 判据②：export_root 与 %APPDATA%\idbox 是**同级**，绝不落在 idbox 内部（这条是收件箱方案的根）
failures << '场景 D：export_root 不得落在 %APPDATA%\\idbox 内部' if
  IDBoxPanel::Paths.within_root?(idbox_data, export_root)
failures << '场景 D：export_root 不得等于 %APPDATA%\\idbox' if
  export_root.downcase == idbox_data.downcase
# 判据③：`..` 逃逸到 idbox 内部的 job 目录必须被判越界（exporter 的写盘闸门依赖这条）
escape = IDBoxPanel::Paths.within_root?(export_root, File.join(export_root, '../idbox/evil'))
puts "  `..` 逃逸到 idbox 内 => #{escape.inspect}（应为 false）"
failures << '场景 D：`..` 逃逸到 idbox 应被拒' if escape

# 判据④：右键菜单入口在「没有活动模型」时必须安全返回 false（不抛异常、不弹窗）
ok_menu = begin
  IDBoxPanel::Exporter.build_menu(nil)
rescue StandardError => e
  "raised #{e.class}"
end
puts "  Exporter.build_menu(nil) => #{ok_menu.inspect}（应为 false）"
failures << '场景 D：build_menu(nil) 应安全返回 false' unless ok_menu == false
puts "  Exporter.update_ready?（无模型）=> #{IDBoxPanel::Exporter.update_ready?.inspect}（应为 false）"
failures << '场景 D：无模型时 update_ready? 应为 false' unless IDBoxPanel::Exporter.update_ready? == false

# 判据⑤：右键 handler 已在 main.rb 的 guard 块里注册（同一 guard，防重复注册）
puts "  UI.add_context_menu_handler 已注册数 => #{UI.context_menu_handlers.length}（应为 ≥1）"
failures << '场景 D：main.rb 应注册右键菜单 handler' if UI.context_menu_handlers.empty?

# 判据⑥：插件版本号两处必须同值（core.rb 与根注册文件的纪律，人工同步的两个字面量）
core_src = File.read(File.join(root, 'plugin-src', 'idbox_panel', 'lib', 'core.rb'))
ext_src = File.read(File.join(root, 'plugin-src', 'idbox_panel.rb'))
core_ver = core_src[/PLUGIN_VERSION\s*=\s*'([^']+)'/, 1]
ext_ver = ext_src[/EXT_VERSION\s*=\s*'([^']+)'/, 1]
puts "  版本号：core.rb=#{core_ver.inspect} / idbox_panel.rb=#{ext_ver.inspect}"
failures << '场景 D：PLUGIN_VERSION 与 EXT_VERSION 必须同值' unless
  !core_ver.nil? && core_ver == ext_ver

puts
puts '── 场景 E：T04 撤销胶囊三态（源级静态断言，docs/46 §1.6）──'
panel_src = File.read(File.join(root, 'plugin-src', 'idbox_panel', 'panel.html'))

# ① 新增 DOM id 只允许 id="undo" 一个；既有 11 个必须逐个还在（42 §4.1:297）
undo_ids = panel_src.scan('id="undo"').length
puts "  id=\"undo\" 出现次数 => #{undo_ids}（应为 1）"
failures << '场景 E：id="undo" 必须恰好 1 个' unless undo_ids == 1

existing_ids = %w[banner clear count empty fresh list notes q refresh status ver]
missing_ids = existing_ids.reject { |name| panel_src.scan('id="' + name + '"').length == 1 }
puts "  11 个既有 DOM id => #{existing_ids.length - missing_ids.length}/#{existing_ids.length}" \
     "#{missing_ids.empty? ? '' : '  缺失/重复: ' + missing_ids.inspect}"
failures << '场景 E：11 个既有 DOM id 必须逐个保留且唯一' unless missing_ids.empty?

# ⑨ 窗口控件（2026-11-09 用户拍板 B′）：自绘「关闭」必须**不存在** —— 它与系统标题栏的 ×
#    完全重复，留着就是"两排按钮打架"。反向断言，防止以后有人加回来又变成 3+2。
win_close_hits = panel_src.scan('id="win-close"').length
win_fold_hits = panel_src.scan('id="win-fold"').length
puts "  #win-close 出现次数 => #{win_close_hits}（应为 0：B′ 已删）"
puts "  #win-fold 出现次数 => #{win_fold_hits}（应为 1）"
failures << '场景 E：自绘 #win-close 已按 B′ 删除，不得再出现（关闭交给系统 × / 菜单）' unless win_close_hits.zero?
failures << '场景 E：#win-fold 必须恰好 1 个' unless win_fold_hits == 1
# 折叠按钮已搬到顶栏左侧：.win-controls 不得再贴右（margin-left:auto 会把它塞回系统按钮正下方）
win_controls_css = panel_src[/\.win-controls \{[^}]*\}/].to_s
win_controls_right = win_controls_css.include?('margin-left: auto')
puts "  .win-controls 仍贴右（margin-left:auto）=> #{win_controls_right}（应为 false）"
failures << '场景 E：.win-controls 不得再用 margin-left:auto（B′ 已移到 logo 右侧）' if win_controls_right
# 关闭桥必须留着（Ruby 侧 closePanel 回调 + 菜单/工具栏关闭走同一条路）
failures << '场景 E：closePanel 桥 / 回调名不得删除（菜单与工具栏关闭依赖它）' unless
  panel_src.include?('window.sketchup.closePanel()')

# ⑪ 「只显示 SketchUp 模型」（2026-11-09 用户实测：面板里出现了 3ds Max 文件）：
#   · 判据必须是**白名单**（MODEL_MAIN_EXTS = ['skp']），不是黑名单 …
puts "  MODEL_MAIN_EXTS 白名单 => #{panel_src.include?("MODEL_MAIN_EXTS = ['skp']") ? "['skp']" : '未命中'}（应为 [\'skp\']）"
failures << "场景 E：模型显示判据必须是白名单 MODEL_MAIN_EXTS = ['skp']" unless
  panel_src.include?("MODEL_MAIN_EXTS = ['skp']")
failures << '场景 E：必须存在唯一的显示判据入口 isDisplayableRecord' unless
  panel_src.include?('function isDisplayableRecord(record)')
failures << '场景 E：scopedRecords 必须改走 isDisplayableRecord（计数/分类/列表同源）' unless
  panel_src.include?('if (isDisplayableRecord(records[i])) { out.push(records[i]); }')
#   · 库里只有非 SU 模型时，空态必须说「没有可插入的 SketchUp 模型」，不能说「库为空」…
puts "  空态文案「没有可插入的 SketchUp 模型」=> #{panel_src.include?('没有可插入的 SketchUp 模型')}"
failures << '场景 E：非 SU 模型占满时，空态必须有「没有可插入的 SketchUp 模型」这一句' unless
  panel_src.include?('没有可插入的 SketchUp 模型')
#   · …并且**代码里不得出现 '.max' / 'max' 这种黑名单字面量**（注释与用户文案除外，先剥注释）。
#     ⚠️ 只看"引号包起来的扩展名字面量"，不能用裸 `.max` 子串判 —— `Math.max(` 会误命中。
code_only = panel_src.gsub(/<!--.*?-->/m, '').gsub(%r{/\*.*?\*/}m, '').gsub(%r{^\s*//.*$}, '')
blacklist_hits = code_only.scan(/['"]\.?max['"]/i).length
puts "  代码（剥注释）里的 max 黑名单字面量 => #{blacklist_hits}（应为 0：只放行白名单）"
failures << "场景 E：不得用 '.max' 黑名单做过滤（只放 .skp 白名单；将来支持新格式只改这一处）" unless
  blacklist_hits.zero?

# ② 冷启动默认隐藏；显隐必须走 opacity/visibility + transition，不得 display:none 硬切
failures << '场景 E：胶囊应带默认隐藏类 is-hidden' unless panel_src.include?('class="undo-pill is-hidden"')
failures << '场景 E：缺少 .undo-pill.is-hidden 规则' unless panel_src.include?('.undo-pill.is-hidden')
undo_css = panel_src[/\.undo-pill \{[^}]*\}/].to_s
hard_cut = undo_css.include?('display: none')
puts "  .undo-pill 规则里是否为 display:none 硬切 => #{hard_cut}（应为 false）"
failures << '场景 E：胶囊显隐不得用 display:none 硬切' if hard_cut
failures << '场景 E：胶囊规则缺少 transition' unless undo_css.include?('transition')
failures << '场景 E：缺少 prefers-reduced-motion 覆盖' unless
  panel_src.include?('@media (prefers-reduced-motion: reduce)')

# ③ 5 s 计时 + 覆盖式重新起计（单变量 + clearTimeout 在 setTimeout 之前）
failures << '场景 E：计时常量应为 5000ms' unless panel_src.include?('UNDO_PILL_MS = 5000')
pill_body = panel_src[/function updateUndoPill\(level\) \{.*?\n  \}/m].to_s
clear_at = pill_body.index('clearTimeout(undoTimer)')
start_at = pill_body.index('setTimeout(')
puts "  updateUndoPill 内 clearTimeout 在 setTimeout 之前 => #{!clear_at.nil? && !start_at.nil? && clear_at < start_at}"
failures << '场景 E：连续插入必须先 clearTimeout 再重新起计' unless
  !clear_at.nil? && !start_at.nil? && clear_at < start_at
failures << '场景 E：非 ok 的 level 必须收起胶囊' unless pill_body.include?("!== 'ok'")

# ④ setStatus 内只允许一处联动调用，且签名不变
status_body = panel_src[/function setStatus\(payload\) \{.*?\n  \}/m].to_s
undo_calls = status_body.scan('updateUndoPill(').length
puts "  setStatus 内 updateUndoPill 调用数 => #{undo_calls}（应为 1）"
failures << '场景 E：setStatus 内 updateUndoPill 必须恰好 1 处' unless undo_calls == 1
failures << '场景 E：setStatus 仍应只接收一个 payload 参数' unless status_body.include?('payload.message')

# ⑤ P2-2 文案：删旧句、正文不动
failures << '场景 E：旧 title 句「面板不实现撤销计时」应已删除' if
  panel_src.include?('面板不实现撤销计时')
failures << '场景 E：新 title 文案缺失' unless
  panel_src.include?('提示会在 5 秒后收起；撤销始终在 SketchUp 里用 Ctrl+Z')
failures << '场景 E：胶囊正文「撤销 Ctrl+Z」不得改动' unless panel_src.include?('撤销 Ctrl+Z</span>')

# ⑥ 落位链不变：可插入 kind 仍只有 model
puts "  INSERTABLE_KINDS => #{IDBoxPanel::INSERTABLE_KINDS.inspect}（应为 [\"model\"]）"
failures << '场景 E：INSERTABLE_KINDS 仍须为 %w[model]' unless IDBoxPanel::INSERTABLE_KINDS == %w[model]

# ⑦ P2-1（+ 2026-11-09 续卡）：**用户可见文本里不得出现任何内部字段名**。
#    口径：先整体剥注释（注释里保留 `manifest.appVersion` 这类来源链说明是有价值的），
#    再只从**字符串字面量**里数。为什么只数字面量：代码里的 `data.generatedAt` /
#    `record.mainFile` 是正常取值，不该误判；而字段名一旦进了文案，就必然在某个字面量里。
ui_only = panel_src.gsub(/<!--.*?-->/m, '').gsub(%r{/\*.*?\*/}m, '').gsub(%r{^\s*//.*$}, '')
literals = ui_only.scan(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/).join(' ')
# 词表：面板实现里用到的字段名/开发常量一个都不许进文案（文件名 manifest.json 允许，见下面 scrub）
field_words = %w[
  manifest. apiVersion generatedAt mainFile thumbsRoot thumbRel relFolder pluginVersion
  readOnlyReason pluginIndexEnabled indexSha256 indexCount libraryRoot isWithinRoot
  ALLOWED_KINDS records
]
scrub = lambda { |text| text.to_s.gsub('manifest.json', '') }   # 文件名可以出现，字段名不行
leaks = field_words.select { |word| scrub.call(literals).include?(word) }
puts "  界面字符串字面量里的内部字段名 => #{leaks.empty? ? '0（干净）' : leaks.inspect}（应为空）"
failures << "场景 E：界面文案不得出现内部字段名 #{leaks.inspect}（P2-1/续卡）" unless leaks.empty?

# 负对照：注释里确实还留着 manifest.*（若上面的剥注释失效，这条会立刻暴露）
puts "  负对照：注释里保留的 manifest.* 处数 => #{panel_src.scan('manifest.').length - ui_only.scan('manifest.').length}（应 >0）"

puts "  新鲜度兜底文案 => #{panel_src.include?('索引时间未知（这份索引没带写入时间）') ? '新文案' : '未命中新文案'}"
failures << '场景 E：新鲜度兜底文案应改为使用者语言' unless
  panel_src.include?('索引时间未知（这份索引没带写入时间）')
# 两处只读拦截：分别说清禁用了哪个动作
failures << '场景 E：只读态的「插入」提示应改为使用者语言' unless
  panel_src.include?('ID BOX 与插件版本不匹配，插入已禁用；请把主程序与插件升级到同一版本')
failures << '场景 E：只读态的「建材质」提示应改为使用者语言' unless
  panel_src.include?('ID BOX 与插件版本不匹配，建材质已禁用；请把主程序与插件升级到同一版本')
failures << '场景 E：旧的 apiVersion 提示语应已消失' if panel_src.include?('apiVersion 不是')

# core.rb 侧（顶部提示条 readOnlyReason 的唯一来源）：同样不得出现字段名与版本数值
mismatch_text = IDBoxPanel::Messages.api_mismatch('manifest', '2')
core_leaks = field_words.select { |word| mismatch_text.include?(word) }
core_leaks << '版本数值' if mismatch_text =~ /\d/
puts "  Messages.api_mismatch => #{mismatch_text}"
failures << "场景 E：api_mismatch 文案不得出现内部字段名/数值 #{core_leaks.inspect}" unless core_leaks.empty?
failures << '场景 E：api_mismatch 应同时说明「插入与建材质」都被禁用' unless
  mismatch_text.include?('插入与建材质已禁用')

# 提示条可见性（2026-11-09 本卡发现并修的既有缺陷，加断言防回退）
#   .banner 原来写死 display:none，而 renderBanner 显示时给的是 `banner warn` / `banner error`
#   （不含 hidden），两个变体又都没重设 display ⇒ IDBOX-101 / 只读态 / 写入侧报错三条提示全哑。
banner_css = panel_src[/\.banner \{[^}]*\}/].to_s
puts "  .banner 基础 display => #{banner_css.include?('display: flex') ? 'flex（可见）' : '未设 flex'}"
failures << '场景 E：.banner 不得用 display:none 隐藏（否则提示条永远不可见）' unless
  banner_css.include?('display: flex')
failures << '场景 E：只读原因应按行去重（readOnlyText）' unless
  panel_src.include?('function readOnlyText(data)')

# ⑧ 同一判据覆盖 core.rb：**逐条调用** Messages 的每个函数，扫它们真正吐给用户的字符串。
#    这比扫源码更硬 —— 它测的是「用户最后看到的那句话」，插值后的值也在里面。
msg = IDBoxPanel::Messages
message_samples = [
  msg.no_appdata,
  msg.missing_manifest('C:/x/manifest.json'),
  msg.index_disabled,
  msg.index_flag_missing,
  msg.missing_index('C:/x/index.json'),
  msg.bad_manifest('解析失败'),
  msg.bad_index('解析失败'),
  msg.hash_mismatch(3, 'a' * 64, 'b' * 64),
  msg.digest_unavailable,
  msg.sha_missing,
  msg.user_dir_non_ascii('C:/用户'),
  msg.count_mismatch(2, 3),
  msg.api_mismatch('manifest', '2'),
  msg.state_error('x'),
  msg.state_error_blank,
  msg.no_model,
  msg.no_library_root,
  msg.no_main_file('x'),
  msg.outside_root('C:/y'),
  msg.file_gone('C:/y'),
  msg.version_warning('x', 2024, 2021),
  msg.version_cancelled,
  msg.su_too_old(2020),
  msg.load_failed('C:/y', 'x'),
  msg.insert_ok('x'),
  msg.insert_exception('x'),
  msg.no_asset_folder('a/b'),
  msg.material_ok('m'),
  msg.material_no_image('m'),
  msg.material_texture_missing('m', 'x'),
  msg.material_exception('x')
]
joined = scrub.call(message_samples.join("\n"))
msg_leaks = field_words.select { |word| joined.include?(word) }
puts "  Messages 全部 #{message_samples.length} 条文案里的内部字段名 => #{msg_leaks.empty? ? '0（干净）' : msg_leaks.inspect}（应为空）"
failures << "场景 E：Messages 文案不得出现内部字段名 #{msg_leaks.inspect}（续卡）" unless msg_leaks.empty?
# 101 的用户视角断言：讲「还没拿到索引 + 去哪打开」，不讲内部开关
failures << '场景 E：101 文案应指向「设置 · SketchUp 插件」里的索引导出' unless
  msg.index_disabled.include?('插件索引导出') && msg.index_disabled.include?('插件还没拿到索引')
failures << '场景 E：101 文案不得出现「关闭的（…= false）」这类内部开关解释' if
  msg.index_disabled.include?('= false')
failures << '场景 E：102 文案应讲清「可能还没写完 + 点刷新」' unless
  msg.missing_index('C:/x/index.json').include?('还没写完') &&
    msg.missing_index('C:/x/index.json').include?('刷新')

# ⑨ A 级文案收口（2026-11-09 独立体检，4 处 5 条）：
#    panel_dialog.rb ×2（只读态两个动作）/ panel.html ×1（不显示提示）/ loader.rb ×2（105 / 102）
dialog_src = File.read(File.join(root, 'plugin-src', 'idbox_panel', 'lib', 'panel_dialog.rb'))
loader_src = File.read(File.join(root, 'plugin-src', 'idbox_panel', 'lib', 'loader.rb'))
expectations = [
  ['panel_dialog 插入被禁', dialog_src, 'ID BOX 与插件版本不匹配，插入已禁用；请把主程序与插件升级到同一版本。'],
  ['panel_dialog 建材质被禁', dialog_src, 'ID BOX 与插件版本不匹配，建材质已禁用；请把主程序与插件升级到同一版本。'],
  ['panel.html 不显示提示', panel_src, '这类资产本版不显示（只做模型与材质）'],
  ['loader 105 提示', loader_src, '部分缩略图指向了素材库外，已跳过（这些封面显示为图标）'],
  ['loader 102 结构', loader_src, '内容结构不完整']
]
expectations.each do |label, src, expected|
  puts "  #{label} => #{src.include?(expected) ? '新文案' : '未命中'}"
  failures << "场景 E：#{label} 应改用使用者语言" unless src.include?(expected)
end
failures << '场景 E：panel_dialog 不得再出现「apiVersion 不是」' if dialog_src.include?('apiVersion 不是')
failures << '场景 E：建材质的动作词应统一为「建材质」（不得再写「创建材质已禁用」）' if
  dialog_src.include?('创建材质已禁用')
failures << '场景 E：loader 不得再出现「records 不是数组」' if loader_src.include?('records 不是数组')

# ⑩ 双击材质后**自动切油漆桶**（2026-11-09 用户实测要求）：
#   · Materializer 必须用官方 action 名 `selectPaintTool:`（数字 21078 是 PC-only/unsupported，
#     21031 是自由手绘 —— 不采用），且必须有调用点；
#   · Inserter（单击插入模型）**不得**出现工具切换 —— 那会打断用户正在放组件。
puts "  Materializer 的 action 常量 => #{loader_src.include?("PAINT_ACTION = 'selectPaintTool:'") ? 'selectPaintTool:' : '未命中'}（应为 selectPaintTool:）"
failures << '场景 E：Materializer 必须用 selectPaintTool: 这个官方 action 名' unless
  loader_src.include?("PAINT_ACTION = 'selectPaintTool:'")
failures << '场景 E：Materializer 必须真的调用 Sketchup.send_action（切油漆桶）' unless
  loader_src.include?('Sketchup.send_action(PAINT_ACTION)')
inserter_src = loader_src[/module Inserter.*?(?=module Materializer)/m].to_s
puts "  Inserter 段落里是否含 send_action => #{inserter_src.include?('send_action')}（应为 false）"
failures << '场景 E：Inserter（单击插入）不得切换工具（会打断放置组件）' if
  inserter_src.include?('send_action')
# 负向断言（你点名要的）：开发常量 ALLOWED_KINDS 不得出现在任何界面字符串字面量里
puts "  ALLOWED_KINDS 出现在界面字面量 => #{literals.include?('ALLOWED_KINDS')}（应为 false）"
failures << '场景 E：ALLOWED_KINDS 不得出现在界面文案（它只给开发看）' if literals.include?('ALLOWED_KINDS')

# 运行时验证 105 的 note：不许把绝对路径带上界面
evil_snap = IDBoxPanel::Snapshot.new(
  :ok => true,
  :manifest => { 'thumbsRoot' => 'C:/evil/not-thumbs' },
  :records => []
)
evil_snap.thumbs_root
note_text = evil_snap.notes.join(' ')
puts "  105 note => #{note_text}"
failures << '场景 E：105 note 不得包含绝对路径（应只进控制台）' if
  note_text.include?('C:/evil') || note_text.include?('evil')

puts
puts '── 场景 F：提示条三变体可见性（真实渲染读计算样式）──'
# 为什么要真实渲染：源级断言只看得见「基础规则写了 flex」，若将来谁给
# .banner.warn / .banner.error 补一句 display:none，字符串断言抓不到。
# 本机没有 node_modules/electron 时**跳过**（不判失败），保证纯 Ruby 环境也能跑完 A–E。
electron = [
  File.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  File.join(root, 'node_modules', '.bin', 'electron.cmd')
].find { |path| File.file?(path) }

if electron.nil?
  puts '  跳过：没找到 node_modules/electron（源级断言见场景 E）'
else
  require 'tmpdir'
  probe_path = File.join(Dir.tmpdir, 'idbox_banner_probe.cjs')
  panel_url = File.join(root, 'plugin-src', 'idbox_panel', 'panel.html').tr('\\', '/')
  # 提示条是「≤ 单行 + 省略号」，所以「第一行必须整句可见」是硬预算。
  # 取 101/102 家族里最长的那条首行做实测（150% 缩放/窄窗口不在本卡范围）。
  banner_heads = [
    msg.missing_manifest('C:/Users/x/AppData/Roaming/idbox/plugin/manifest.json'),
    msg.index_disabled,
    msg.index_flag_missing,
    msg.missing_index('C:/Users/x/AppData/Roaming/idbox/plugin/index.json'),
    msg.bad_manifest('JSON 解析失败'),
    msg.bad_index('JSON 解析失败'),
    msg.hash_mismatch(3, 'a', 'b'),
    msg.api_mismatch('manifest', '2')
  ].map { |text| text.split("\n").first }
  longest_head = banner_heads.max_by { |head| head.length }
  puts "  最长的 101/102 首行 => #{longest_head.length} 字"
  File.write(probe_path, <<~JS)
    const { app, BrowserWindow } = require('electron')
    app.disableHardwareAcceleration()
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 960, height: 620, show: false, useContentSize: true })
      await win.loadFile('#{panel_url}')
      const out = await win.webContents.executeJavaScript(`(function(){
        var el = document.getElementById('banner');
        var res = { variants: {} };
        ['banner', 'banner warn', 'banner error'].forEach(function (c) {
          el.className = c;
          res.variants[c] = getComputedStyle(el).display;
        });
        el.className = 'banner hidden';
        res.variants['banner hidden'] = getComputedStyle(el).display;
        el.className = 'banner error';
        el.textContent = #{longest_head.to_json};
        res.headWidth = el.scrollWidth;
        res.boxWidth = el.clientWidth;
        res.headFits = el.scrollWidth <= el.clientWidth + 1;
        return res;
      })()`)
      console.log('RESULT ' + JSON.stringify(out))
      app.quit()
    }).catch(function (e) { console.error('ERR ' + e.message); app.quit() })
  JS
  raw = begin
    # ELECTRON_RUN_AS_NODE 在部分环境被设成 1（会把 electron 当纯 node 跑）⇒ 必须清掉
    IO.popen({ 'ELECTRON_RUN_AS_NODE' => nil }, [electron, probe_path], :err => [:child, :out]) { |io| io.read }
  rescue StandardError => error
    "ERR #{error.class}: #{error.message}"
  ensure
    File.delete(probe_path) if File.file?(probe_path)
  end
  result_line = raw.to_s.lines.find { |line_text| line_text.start_with?('RESULT ') }
  if result_line.nil?
    puts "  跳过：探针没有给出结果（#{raw.to_s.lines.first.to_s.strip}）"
  else
    shown = JSON.parse(result_line.sub('RESULT ', ''))
    variants = shown['variants'] || {}
    variants.each { |key, value| puts "  #{key} => #{value}" }
    visible = variants.reject { |key, _| key == 'banner hidden' }
    hidden_ones = visible.select { |_, value| value == 'none' }.keys
    puts "  无 .hidden 时不可见的变体 => #{hidden_ones.empty? ? '无（全部可见）' : hidden_ones.inspect}"
    failures << "场景 F：这些变体在无 .hidden 时 display 不能是 none：#{hidden_ones.inspect}" unless hidden_ones.empty?
    failures << '场景 F：.banner.hidden 必须仍然不可见' unless variants['banner hidden'] == 'none'
    puts "  最长首行是否整句可见 => #{shown['headFits']}（#{shown['headWidth']} / #{shown['boxWidth']} px）"
    failures << '场景 F：101/102 首行被省略号截断（提示条预算不够，文案要缩短）' unless shown['headFits']
  end
end


puts
if failures.empty?
  puts '冒烟通过（2/2）'
  exit 0
else
  puts '冒烟失败：'
  failures.each { |f| puts "  · #{f}" }
  exit 1
end
