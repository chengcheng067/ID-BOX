# ID BOX · SketchUp 插件 —— 装配入口（main.rb）
#
# 入口：根注册文件 idbox_panel.rb 里的 SketchupExtension.new('ID BOX Panel', 'idbox_panel/main')
# 数据：%APPDATA%\idbox\plugin\manifest.json + index.json（ID BOX 主进程写，本插件**只读**）
# 契约：src/shared/pluginSnapshot.ts（PluginManifest / PluginIndexEnvelope / PluginSnapshotRecord）
# 规范：docs/39-插件架构-索引快照与包规范.md §3（文件格式）、§4（包规范）、§5（错误码）
# 本文件形态：docs/42 §2 文件 2 + §3.2 —— **收敛为装配入口，不再有业务逻辑**。
#   原 9 个模块与契约常量全部下沉到 lib/（core / paths / loader / panel_callback / panel_dialog），
#   本文件只做三件事：① 序 0 的 require；② 按 §3.2 拓扑加载 5 个 lib 文件；
#   ③ 单个 file_loaded? guard 块内挂菜单（+ 工具栏预留）。
#
# ============================ 硬约束（违反即不合格） ============================
# 1) 零网络：本包内不得出现 Net::HTTP / TCPSocket / open-uri / URI.open / 任何 http 客户端。
# 2) 零原生件：不 require 任何 .so / .bundle / .dll，不用第三方 gem；只用 Ruby stdlib
#    （json / digest）与 SketchUp 自带 API。require 白名单 = sketchup.rb / extensions.rb /
#    json / digest + Sketchup.require（docs/39 §4.1#3、§4.2、A4）。
# 3) 零 token、零端口、零后台服务：插件不监听端口、不起线程常驻服务（只有面板打开时的
#    3 s 轮询定时器，面板关闭即 stop_timer）。
# 4) 不解压、不读任何压缩包：V1.0 只取用**已入库**的单个文件。
# 5) 不自删、不自升级。
# 6) 纯读方：绝不 File.write / File.delete / File.rename 到 %APPDATA%\idbox\plugin\
#    或 ID BOX 的任何数据目录。
#    **唯一例外（用户 2026-11-05 批准）**：面板建窗失败时，向
#    `%TEMP%\idbox_panel_diag.txt` 写一份诊断快照（环境 + 候选路径 + 真实异常），
#    用于真机排障 —— 成功路径一个字都不写。见 lib/paths.rb 的 `Diagnostics` 模块。
#    ⚠️ 菜单/工具栏**注册失败**不得写诊断（docs/42 §7.3），只 puts，否则破 A6。
# 7) 全部代码在本单一模块 IDBoxPanel 内；**禁止全局变量**（$x 一律不许出现）。
# 8) 包内互相 require 用 Sketchup.require 'idbox_panel/xxx'（不带 .rb），不用 require_relative。
# 9) `.rbz` 顶层恰好两项：根 `idbox_panel.rb` + 同名支持目录 `idbox_panel/`（A5）；
#    `lib/`、`assets/` 都在支持目录内部，不新增第三项。
# 10) `lib/*.rb` 不得用 `__FILE__` 拼资源路径（真机 2026-11-05 实证 __FILE__ 可能是相对路径），
#     图标绝对路径统一走 `Paths.assets_dir`（docs/42 §3.3 / §10.2 风险 3）。
#
# 兼容性：门槛 SketchUp 2021+（docs/38 §8.1 已拍板）⇒ Ruby 2.7 兼容写法。
# 禁忌：Hash#except / endless method（def x = ...）/ => 右赋值 / pattern matching。
# ==============================================================================

# ── 序 0：require 白名单内（sketchup.rb 是 SketchUp 自带，json 是 stdlib） ─────
require 'sketchup.rb'
require 'json'

module IDBoxPanel
  # ── 序 1–5：加载链（严格单向拓扑，照 docs/42 §3.2 逐条实现） ────────────────
  #
  # 为什么必须按这个顺序（逐条对应 docs/42 §3.2 表）：
  #   序 1 core           —— 必须第一：定义 module IDBoxPanel 与全部契约常量，后 4 个文件
  #                          都在该模块内注入方法/类，晚加载则 NameError。
  #   序 2 paths          —— 依赖 core 的 Support 与 PLUGIN_VERSION。
  #   序 3 loader         —— 依赖 core（ErrCode / Messages / 常量）+ paths（Paths.*）。
  #   序 4 panel_callback —— 依赖 core；加载期不引用 Panel 常量（靠 bind 参数拿实例），
  #                          故可先于 panel_dialog。
  #   序 5 panel_dialog   —— 依赖 core / paths / loader / panel_callback。
  Sketchup.require 'idbox_panel/lib/core'
  Sketchup.require 'idbox_panel/lib/paths'
  Sketchup.require 'idbox_panel/lib/loader'
  Sketchup.require 'idbox_panel/lib/panel_callback'
  Sketchup.require 'idbox_panel/lib/panel_dialog'

  # 序 6：`Sketchup.require 'idbox_panel/lib/toolbar'` —— **必须最后**（命令 block 运行时
  # 才解析 IDBoxPanel::Panel.instance.toggle，docs/42 §3.2 序 6）。
  # ⚠️ 本卡（T01）**不写这一行**：`lib/toolbar.rb` 属 T03（工具栏注册）。
  #    T03 落地后在此补一行即可，本文件的 guard 块已经预留 `Toolbar.build if defined?(Toolbar)`，
  #    所以现在不写也不会报错；若提前写，离线冒烟会走桩的 miss 分支（打印 `[smoke] Sketchup.require miss:`
  #    并返回 false，不抛 LoadError —— SU 2026.2 起才抛），真机上同样只是打印提示。
  #    这里保持注释而非空 require，是为了让「T03 只需补一行、不改 guard 块」这条可核对。
  # Sketchup.require 'idbox_panel/lib/toolbar'

  # ── 序 7：只挂一次（guard 块位于 main.rb 末尾、module IDBoxPanel 内） ────────
  #
  # 【查证】`file_loaded?` 是官方 Tools/sketchup.rb 的标准 guard，注释点名防
  # "duplicate menus and toolbars"（docs/42 §3.3 / api-report §6.3:502）
  # ⇒ 菜单与工具栏必须放在**同一个** guard 块内。
  #
  # ⚠️ 块内只 puts 真实异常类 + message，**不写盘**：写诊断会破 A6（纯读方，
  # 唯一例外＝建窗失败）。注册失败发生在启动阶段，用户正常启动也会产生诊断文件。
  #
  # 菜单保持 `show` 语义（docs/42 §5.4：T01 不改判据；`toggle` 属 T04）。
  unless file_loaded?(__FILE__)
    begin
      UI.menu('Extensions').add_item('ID BOX 资产面板') { Panel.instance.show }
      # 工具栏预留：T01 不创建 lib/toolbar.rb，`defined?(Toolbar)` 为 false ⇒ 这里什么都不做；
      # T03 落地后自动生效，本行不需要改（这是 T01 特意留下的接口，见上面序 6 注释）。
      Toolbar.build if defined?(Toolbar)
    rescue StandardError => error
      puts("[ID BOX] registration failed: #{error.class}: #{error.message}")
    end
    file_loaded(__FILE__)
  end
end
