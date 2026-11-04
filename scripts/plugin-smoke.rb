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
# 用法（在仓库根目录）：
#   ruby scripts/plugin-smoke.rb <ruby.exe 路径可省，默认 PATH 里的 ruby>
#
# 判据：
#   · 场景 A 期望 show() => true，且**不产生诊断文件**（成功路径零写盘）；
#   · 场景 B（强制找不到 panel.html）期望 show() => false，且写出诊断文件。
#   任一不符即退出码 1。

root = File.expand_path('..', __dir__)
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

  def self.active_model
    nil
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

  def self.messagebox(*args)
    puts "  [MSGBOX] #{args.first.to_s.lines.first.to_s.strip}"
    1
  end

  def self.menu(name = 'Plugins'); Menu.new(name); end
  def self.menu_append_item(*_args); Object.new; end
end

require 'idbox_panel/main'

failures = []
diag = IDBoxPanel::Diagnostics.path
File.delete(diag) if File.file?(diag)

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
if failures.empty?
  puts '冒烟通过（2/2）'
  exit 0
else
  puts '冒烟失败：'
  failures.each { |f| puts "  · #{f}" }
  exit 1
end
