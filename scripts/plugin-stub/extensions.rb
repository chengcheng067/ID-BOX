# 离线桩：SketchUp 自带 extensions.rb 的最小替身（只需 SketchupExtension 类）
class SketchupExtension
  attr_accessor :name, :description, :version, :creator, :copyright

  def initialize(*_args); end
end
