# encoding: utf-8
# ID BOX · SketchUp V1.0 真机核实探针 v1（D2 前置：材质 API + 方法名 + 非 ASCII 路径）
#
# 运行方式：SketchUp 2024 → 窗口 → Ruby 控制台，把本文件全文粘贴后回车。
# 建议在新建的空模型里跑（第 4 段会创建一个材质并赋给一个新建的面）。
# 探针只打印事实，不改任何库文件；写文件仅限 %APPDATA%\idbox_probe\。
# 跑完把控制台输出整段贴回给我，我按 docs/39 §5 的口径决定 D2 是否进 V1.0。

# ── 可选：填了才跑"功能探针"；不填只跑方法名核实 ──
TEX_PATH = ''   # 例：'E:/ModVault/Library/xxx/yyy.jpg'（库内一张真实贴图）
SKP_PATH = ''   # 例：'E:/ModVault/Library/xxx/yyy.skp'（库内一个真实组件）

out = []
say = ->(s) { out << s; puts s }

say '== 0. 环境 =='
say "ruby        : #{RUBY_VERSION}"
say "su          : #{Sketchup.version}"
say "default_ext : #{Encoding.default_external}   # 若不是 UTF-8，读 JSON 必须显式 UTF-8（docs/39 §4.3）"
say "default_int : #{Encoding.default_internal.inspect}"
say "appdata     : #{ENV['APPDATA']}"
plug = File.join(ENV['APPDATA'].to_s, 'SketchUp', "SketchUp #{Sketchup.version[0,4]}", 'Plugins')
say "plugins dir : #{plug}  exists=#{File.directory?(plug)}  writable=#{File.writable?(plug) rescue false}"

say "\n== 1. 方法名存在性（只查，不猜；docs/38 §7 / docs/39 §5 的【待核实】项） =="
checks = [
  [Sketchup::Entity,        'set_attribute'],
  [Sketchup::Entity,        'attribute_dictionary'],
  [Sketchup::Model,         'set_attribute'],
  [Sketchup::DefinitionList, 'load'],
  [Sketchup::Materials,     'add'],
  [Sketchup::Material,      'texture='],
  [Sketchup::Material,      'texture'],
  [Sketchup::Face,          'material='],
  [Sketchup::Model,         'import'],
]
checks.each do |klass, name|
  ok = klass.instance_methods.include?(name.to_sym)
  say format("%-46s %s", "#{klass.name}##{name}", ok ? 'OK' : 'MISSING')
end
say format("%-46s %s", 'UI::HtmlDialog', Object.const_defined?('UI::HtmlDialog') ? 'OK' : 'MISSING')

say "\n== 2. 非 ASCII 路径：加载自身扩展文件（可搭鸭实证的场景，docs/37:92） =="
begin
  dir = File.join(ENV['APPDATA'].to_s, 'idbox_probe', '测试探针')
  Dir.mkdir(dir) unless File.directory?(dir)
  f_ascii = File.join(dir, 'probe_ascii.rb')
  f_cn    = File.join(dir, '探针中文名.rb')
  [f_ascii, f_cn].each do |p|
    File.write(p, "OUT_MARK = #{p.object_id}\n", mode: 'w:UTF-8')
    begin
      load p
      say "load #{File.basename(p)} → 成功"
    rescue => e
      say "load #{File.basename(p)} → 失败：#{e.class}: #{e.message}"
    end
  end
rescue => e
  say "探针目录写入失败：#{e.class}: #{e.message}"
end

say "\n== 3. 读 UTF-8 JSON（模拟读 index.json，含中文路径） =="
begin
  j = File.join(ENV['APPDATA'].to_s, 'idbox_probe', 'probe.json')
  File.write(j, '{"rel":"素材/布艺/测试.png"}', mode: 'w:UTF-8')
  raw = File.read(j)
  say "默认读取得到编码 #{raw.encoding}；强制 UTF-8 后 valid?=#{raw.dup.force_encoding('UTF-8').valid_encoding?}"
rescue => e
  say "JSON 探针失败：#{e.class}: #{e.message}"
end

say "\n== 4. 功能探针（需上面两个路径，否则跳过） =="
if TEX_PATH.empty? || SKP_PATH.empty?
  say '跳过 —— 未填 TEX_PATH / SKP_PATH'
else
  m = Sketchup.active_model
  m.start_transaction('IDBOX probe')
  begin
    # 4a 材质：建材质 → 赋贴图 → 赋给一个新建面
    tex = m.materials.add('IDBOX_PROBE_MAT')
    tex.texture = TEX_PATH
    say "materials.add + texture= → OK（#{tex.name}）"
    ent = m.entities.grep(Sketchup::Face).first
    if ent
      ent.material = tex
      say "Face#material= → OK"
    else
      say "当前模型里没有面，Face#material= 未验证"
    end
    # 4b 组件：DefinitionList#load（docs/36:129【查证】）
    defn = m.definitions.load(SKP_PATH)
    say "definitions.load → OK（#{defn.name}）"
    say "字典方法回读：#{Sketchup::Entity.instance_methods.include?(:set_attribute) ? '可写' : '不可写'}"
  rescue => e
    say "功能探针失败：#{e.class}: #{e.message}"
  ensure
    m.abort_transaction('IDBOX probe')  # 探针改动回滚，不留在模型里
  end
end

say "\n== 5. 收尾 =="
say '本探针回滚了模型改动；%APPDATA%\idbox_probe\ 里的探针文件可以留着自己看，也可以手动删。'
