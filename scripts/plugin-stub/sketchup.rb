# 离线桩：SketchUp 自带方法的替身（仅供 scripts/plugin-smoke.rb 使用）
# 只提供真实 SketchUp 里确实存在的东西，避免"桩太宽松、把 bug 放过"。
$idbox_loaded = {}

def file_loaded?(f)
  $idbox_loaded[f] ? true : false
end

def file_loaded(f)
  $idbox_loaded[f] = true
end
