# ID BOX · SketchUp 插件 —— lib/exporter.rb（导出至 IDBOX / 更新 ID BOX 中的这个模型）
#
# 加载顺序（docs/42 §3.2）：序 7，在 core / paths / loader 之后（本文件用到三者）：
#   - core   ：Support / ErrCode / Messages / PLUGIN_VERSION / YES_NO_BUTTONS / YES_ANSWER
#   - paths  ：Paths.export_root / inbox_dir / ensure_dir / within_root? / absolute_like? /
#              normalize_slashes / windows?
#   - loader ：Loader.load / Loader.signature（认身份要 manifest.libraryRoot + records）
#
# 负责什么（docs/48 §7 / docs/probe/su-export-to-idbox.md 是唯一事实底稿）：
#   ① 右键「导出至 IDBOX」    → 选中对象存成 .skp + 截当前视口当封面 → 写一个 job 目录；
#   ② 右键「更新 IDBOX 中的这个模型」→ 同上，但 manifest.op = "update" 且带 targetRelFolder，
#      由 ID BOX 主进程**覆盖同名 .skp 本体**（分类 / 渲染参数 / 自定义封面不动，见台账 §7）。
#
# ══════════════════ 写盘边界（2026-11-09 主理人批准的唯一松绑）══════════════════
# 本文件是插件「纯读方」铁律的**唯一**破例处（docs/39 §4.1#4 / docs/48 §7）。边界写死如下，
# 后人改代码**不得放开**：
#   1) 只写 `%APPDATA%\idbox_export\` 之下 —— 由 Paths.export_root / Paths.inbox_dir 单点定义，
#      本文件不自己拼根路径。
#   2) **绝不**写 `%APPDATA%\idbox\`：库目录、`plugin\`（索引快照）、`thumbs\`、`settings.json`、
#      `logs\` 一律零写入。所以 `%APPDATA%\idbox_export` 是 `%APPDATA%\idbox` 的**同级兄弟**，
#      不在它内部（这是契约，不是实现细节）。
#   3) **绝不**改动任何已入库的资产文件。「更新」也只写收件箱，真正的覆盖由主程序在收到
#      manifest 后做（同目录 tmp → rename），插件这边永远不碰库里的 .skp。
#   4) 目录名 / 文件名一律由本文件自己拼（jobId 子目录 + sanitize 过的资产名），
#      **不接受**任何外部传入的路径片段；每次写盘前用 `writable_dir?` 复核
#      「在 export_root 之下 + 不在 %APPDATA%\idbox 之下 + 不在库根之下」，防 `..` 逃逸。
#
# 为什么要落盘（docs/probe Q2）：.skp 与截图本来就必须是文件；收件箱方案是唯一「不联网、
# 不唤起进程、主程序没开也能攒着」的交接方式。R7 的错配风险由 manifest.apiVersion 兜住。
#
# 契约（已由主理人钉死，**字段名逐字，不得改动**）：
#   根     = %APPDATA%\idbox_export
#   incoming = 根\incoming\<jobId>\，jobId = YYYYMMDD-HHmmss-<4 位随机>
#   ⚠️ jobId **必须匹配主程序契约 `^\d{8}-\d{6}-[0-9a-z]{4}$`**，否则任务被判废（见 new_job_id 注释）。
#   内容   = <baseName>.skp / <baseName>.cover.png / manifest.json（**最后写**，.tmp → rename）
#   manifest = {
#     "apiVersion": 1, "op": "create" | "update", "name": "...",
#     "skp": "<baseName>.skp", "cover": "<baseName>.cover.png" | null,
#     "targetRelFolder": null | "模型/家具/椅子/休闲椅",
#     "pluginVersion": "1.2.0", "createdAt": "2026-11-09T18:40:00+08:00"
#   }
#   ⇒ manifest.json 的出现即代表「这个 job 齐全」。任一失败路径都会删掉 manifest（并清目录），
#     所以主程序永远不会看到半成品（R1 / R3 的缓解）。
#
# 命名（2026-11-09 用户要求：「先在 SketchUp 里让我命名，再做导出保存」）：
#   点「导出至 IDBOX」→ `UI.inputbox` 先问名字（默认值 = 组件名 / 文档标题 / 文件名）→ 再建 job。
#   ⚠️ **取消 ⇒ 一个文件都不写**（连 job 目录都不建），这不是错误，只落状态栏。
#   ⚠️ `<baseName>`、`<baseName>.skp`、`<baseName>.cover.png`、`manifest.name` 四者**必须同值**：
#      主程序按 `manifest.name` 给资产改名，磁盘名与之不一致就会"改完名字找不到文件"。
#
# ══════════════════ 右键菜单到底"对着谁"（2026-11-09 装机反馈后定案）══════════════════
# 用户原话：「右键更新至 idbox 触发不稳定…如果旁边有定义，并且能和我们的库里面匹配上，
#           那这个右键更新是不是就能够被触发呢？」⇒ 判据不能再要求"先选中再右键"。
#
# 【查证】SketchUp **没有**任何 API 能给出「右键时的光标位置」或「光标下的实体」：
#   · `UI.add_context_menu_handler { |menu| }` 的块只收一个 Menu，无实体、无坐标
#     （官方 UI 文档该方法的全部说明与示例，见 ruby.sketchup.com/UI.html）；
#   · `Sketchup::ViewObserver` 只有 `onViewChanged` / `onScaleFactorChange`(2025+)，
#     **没有 onMouseMove** —— 所以"在观察者里缓存鼠标坐标"这条路不存在；
#   · `Sketchup::View` 全表 47 个方法里没有任何 cursor / mouse_position 取位置的方法；
#     `pick_helper` / `inputpoint` / `pickray` 都要显式传 x, y。
#   · 唯一能拿到鼠标坐标的是**当前激活的自定义 Tool** 的 `onMouseMove(flags, x, y, view)`，
#     而用户建模时激活的是原生「选择」工具 —— 插件不能为了右键去抢工具。
#   （用 Win32API/Fiddle 调 GetCursorPos 属"原生件/系统调用"，破零原生件铁律，不用。）
#
# ⇒ 实现口径（由具体到笼统，见 update_targets）：
#   ① 选中恰 1 个组件          → 组件定义路径
#   ② 正在编辑的组件（active_path 末项）→ 该实例的定义路径
#   ③ 当前文档（Model#path）   → 直接打开库里的 .skp 修改的场景
#   ④ 上面全落空时，扫**顶层**已放置实例，认它们的定义路径
#   候选 >1 ⇒ 菜单给子项（「更新 ID BOX 中的这个模型 ▸ 资产名」），让用户自己点。
#   一个都认不出 ⇒ **不显示该项**（绝不显示成点了才报错）。
#
# 技术事实（实测已确认，不要推翻，详见 docs/probe/su-export-to-idbox.md Q1/Q2）：
#   · 首选 `ComponentDefinition#save_as(path)`：选中恰 1 个 ComponentInstance 时零事务、零改动；
#     但它会改定义 guid（SU < 2027 的官方 @bug），对本功能无影响（身份认的是**文件路径**）。
#   · 兜底 `start_operation → definitions.add → add_group(selection) → explode → save_as →
#     abort_operation`：`ensure` 里也 abort，保证用户文档不留改动。
#   · **绝不用 `Model#save`**（会把用户文档绑到库文件 / 覆盖用户文件）；
#     **绝不用 `Sketchup.file_new`**（Windows 上会关掉当前文档）。
#   · `View#write_image` **必须显式给 width/height**（SU2023 早期 vpwidth==0 直接报错），
#     且**不动相机**（用户口径是「所见即所得」）。返回 Boolean，必须检查；失败就降级为无封面。
#
# 硬约束（不得放开）：零网络 / 零外链 / 零原生件 / 零 token；Ruby 2.7 兼容写法
# （禁 Hash#except / endless method / => 右赋值 / pattern matching）；单一 module IDBoxPanel
# 内、无全局变量；包内互相 require 用 Sketchup.require 'idbox_panel/xxx'。

module IDBoxPanel
  module Exporter
    module_function

    # ── 菜单文案（右键子菜单）──────────────────────────────────────────────
    MENU_TITLE = 'IDBOX'.freeze
    MENU_EXPORT = '导出至 IDBOX'.freeze
    MENU_UPDATE = '更新 IDBOX 中的这个模型'.freeze
    # 命名对话框（UI.inputbox：prompts / defaults / title；取消返回 false）
    NAMING_PROMPT = '名称'.freeze
    NAMING_TITLE = '导出至 ID BOX'.freeze

    # ── 右键候选的规模上限 ─────────────────────────────────────────────────
    # 官方 UI 文档明确警告：context menu 回调里做重活会拖慢菜单弹出 ⇒ 两条上限都是必需的。
    # MAX_UPDATE_TARGETS：子菜单最多列这么多个不同资产（再多就只给前 N 个）。
    # INSTANCE_SCAN_LIMIT：扫顶层实体最多看这么多条（大模型顶层可能上万）。
    MAX_UPDATE_TARGETS = 8
    INSTANCE_SCAN_LIMIT = 2000

    # ── 产物命名与尺寸 ─────────────────────────────────────────────────────
    SKP_EXT = '.skp'.freeze
    COVER_EXT = '.cover.png'.freeze
    # 1600×1000：写死尺寸是**硬要求**（vpwidth 可能为 0），也是面板 4:3 / 16:10 卡片的取景口径；
    # 与 docs/probe Q2 的示例值一致。改它会改变封面构图，属产品口径，不要随手调。
    COVER_WIDTH = 1600
    COVER_HEIGHT = 1000
    # 资产名长度上限：Windows 路径总长与 ID BOX 的卡片标题都吃不满更长的名字
    NAME_MAX = 60
    FALLBACK_NAME = 'ID BOX 导出'.freeze
    UNTITLED_NAMES = %w[untitled 无标题 未命名].freeze
    # Windows 文件名非法字符（含控制字符）
    ILLEGAL_NAME_CHARS = /[\\\/:*?"<>|\x00-\x1f]/

    # ── job / manifest ────────────────────────────────────────────────────
    MANIFEST_API_VERSION = 1           # 注意：这里是**数字 1**，不是快照契约里的字符串 '1'
    MANIFEST_FILE = 'manifest.json'.freeze
    MANIFEST_TMP_FILE = 'manifest.json.tmp'.freeze
    OP_CREATE = 'create'.freeze
    OP_UPDATE = 'update'.freeze
    JOB_ID_TRIES = 8

    # ── 兜底路线的临时定义 ─────────────────────────────────────────────────
    # 前缀固定便于用户/排障时识别；abort 后本应消失，异常残留时也能一眼看出是插件的锅。
    TMP_DEFINITION_PREFIX = 'IDBOX_TMP_'.freeze
    TEMP_OP_NAME = 'ID BOX 导出（临时）'.freeze

    # ── 快照缓存（认身份用；按 Loader.signature 失效）──────────────────────
    # 右键菜单每次弹出都要判断「更新」能不能用，不能每次都读 + 校验整份 index.json
    # （几千条记录时会明显卡手）。Loader.signature 只读 manifest.json 的
    # generatedAt|indexSha256，索引一变签名就变 ⇒ 缓存自然失效。
    @snapshot = nil
    @snapshot_signature = nil
    # 菜单项命令的持久引用：context menu 是临时的，但命令对象在菜单生命周期内必须活着
    # （对齐 toolbar.rb 防 GC 的纪律，成本几乎为零）。
    @menu_commands = nil

    # ══════════════════════════════ 入口 1／2：新建导出（先命名）══════════════════
    #
    # 「导出哪一块」由当前上下文决定（右键拿不到光标实体，见头注 §右键判据），见 export_payload：
    #   选中对象 → 正在编辑的组件 → 整份文档。
    # 返回 { :ok, :code, :message, :level, :jobId }，**永不抛异常**。
    def export_selection
      model = Sketchup.active_model
      return result(false, ErrCode::PATH_GONE, Messages.export_no_model) if model.nil?

      payload = export_payload(model)
      # 空文档（从未保存、顶层也没有任何实体）没有可导出的东西：别产出一个空资产
      if payload[:whole_model] && Support.text(model_path(model)).strip.empty? && entities_empty?(model)
        return result(false, ErrCode::EXPORT_FAILED, Messages.export_no_selection)
      end

      base_name = ask_export_name(payload[:default_name])
      # 用户取消：**不建 job 目录、不写任何文件**；这不是错误，只落状态栏、不弹失败框
      return result(true, nil, Messages.export_cancelled, 'info') if base_name.nil?

      run_job(model, payload, base_name, OP_CREATE, nil)
    rescue StandardError => error
      # 走到这里说明连 job 目录都还没建（run_job 内部自己兜异常并清理），不会留半成品
      result(false, ErrCode::EXPORT_FAILED, Messages.export_exception(error.message))
    end

    # ══════════════════════════════ 入口 2／2：更新库内模型 ══════════════════════
    #
    # 「更新」的判定（docs/probe Q4）：身份建在**文件绝对路径**上 ——
    #   ComponentDefinition#path（组件实例）或 Model#path（文档），
    #   减去 manifest.libraryRoot ⇒ relFolder ⇒ 就是库里那条资产的目录。
    # 2026-11-09 起**不再要求先选中**（右键本身就是对着光标下实体的），候选见 update_targets。
    # 认不出来 ⇒ **不静默创建副本**（那会在库里留下两条一样的资产），
    # 而是明确提示「不在库里」并询问是否改为「导出为新资产」。
    #
    # rel_folder：菜单子项点下来的库内相对目录；nil ⇒ 按当前上下文重新解析第一个候选。
    def update_existing(rel_folder = nil)
      model = Sketchup.active_model
      return result(false, ErrCode::PATH_GONE, Messages.export_no_model) if model.nil?

      data = snapshot
      if data.nil? || !data.ok?
        return result(false, ErrCode::DISCOVERY_MISSING, Messages.update_no_index)
      end

      wanted = Support.text(rel_folder).strip
      target = pick_update_target(wanted)
      if target.nil?
        # 菜单刚算过、点下来却认不出 ⇒ 期间文件被挪走/删掉了：明确说清，绝不去建副本
        unless wanted.empty?
          return result(false, ErrCode::PATH_GONE, Messages.update_target_gone)
        end
        answer = ask_yes_no(Messages.update_ask_create(Support.text(export_payload(model)[:default_name])))
        # 用户选「否」：什么都不做，也不弹失败框（这不是错误）
        return result(true, nil, Messages.update_cancelled, 'info') unless answer == YES_ANSWER
        return export_selection
      end

      run_job(model, update_payload_for(target), target[:base_name], OP_UPDATE, target[:rel_folder])
    rescue StandardError => error
      result(false, ErrCode::EXPORT_FAILED, Messages.export_exception(error.message))
    end

    # 「更新」菜单项出不出（main.rb / build_menu 用）：**不再要求先选中**，
    # 只要这个模型（文档 / 正在编辑的组件 / 已放置的库内组件）能在库里认出身份就出。
    # 一个都认不出 ⇒ **不显示**该项（而不是显示成点了才报错）。
    def update_ready?
      !update_targets.empty?
    rescue StandardError
      false
    end

    # ══════════════════════════════ 右键菜单 ══════════════════════════════
    #
    # 由 main.rb 在**同一个** file_loaded? guard 块里挂：
    #   UI.add_context_menu_handler { |menu| Exporter.build_menu(menu) }
    # 每次右键都会回调一次，所以「更新」项按本次状态决定是否加入（不依赖
    # set_validation_proc 在 context menu 里是否被调用 —— 那条官方无明文，见 probe 待核实 7）。
    # 候选 >1（模型里有多个库内资产）⇒ 用子菜单让用户点名要更新哪一个。
    def build_menu(menu)
      return false if menu.nil?
      return false if Sketchup.active_model.nil?

      submenu = menu.add_submenu(MENU_TITLE)
      return false if submenu.nil?

      commands = []

      export_command = UI::Command.new(MENU_EXPORT) { run_export }
      export_command.tooltip = MENU_EXPORT
      export_command.menu_text = MENU_EXPORT
      export_command.status_bar_text = '把选中的对象（或当前组件 / 整份文档）导出为 .skp + 当前视口封面，先命名再保存。'
      submenu.add_item(export_command)
      commands << export_command

      targets = update_targets
      if targets.length == 1
        command = update_command(MENU_UPDATE, nil)
        submenu.add_item(command)
        commands << command
      elsif targets.length > 1
        holder = submenu.add_submenu(MENU_UPDATE)
        unless holder.nil?
          targets.each do |target|
            command = update_command(target[:label], target[:rel_folder])
            holder.add_item(command)
            commands << command
          end
        end
      end

      @menu_commands = commands
      true
    rescue StandardError => error
      # 菜单构建失败只留控制台痕迹（注册阶段不得写盘，docs/42 §7.3）
      puts("[ID BOX] context menu failed: #{error.class}: #{error.message}")
      false
    end

    # 单个「更新」命令。rel_folder 为 nil ⇒ 点击时按当前上下文重新解析（单选路径）。
    # ⚠️ rel_folder 是**块里的局部变量**，每次循环各自捕获，不会串到别的子项上。
    def update_command(text_value, rel_folder)
      label = Support.text(text_value).strip
      label = MENU_UPDATE if label.empty?
      command = UI::Command.new(label) { run_update(rel_folder) }
      command.tooltip = MENU_UPDATE
      command.menu_text = label
      command.status_bar_text = '把当前对象写回 ID BOX 里对应的资产（覆盖同名 .skp，保留分类/渲染参数/自定义封面）。'
      command
    end

    def run_export
      report(export_selection)
    rescue StandardError => error
      report(result(false, ErrCode::EXPORT_FAILED, Messages.export_exception(error.message)))
    end

    def run_update(rel_folder = nil)
      report(update_existing(rel_folder))
    rescue StandardError => error
      report(result(false, ErrCode::EXPORT_FAILED, Messages.export_exception(error.message)))
    end

    # 成功只落状态栏（不弹窗打断建模）；失败才 messagebox（用户要求「不要静默」）。
    def report(outcome)
      return false unless outcome.is_a?(Hash)
      message = Support.text(outcome[:message])
      return false if message.empty?
      if outcome[:ok] == true
        status_text(message)
        true
      else
        messagebox(Messages.with_code(outcome[:code], message))
        false
      end
    rescue StandardError
      false
    end

    # ══════════════════════════════ job 主流程 ══════════════════════════════
    #
    # 顺序不可换：skp → cover → manifest。manifest 最后写（.tmp → rename），
    # 它一出现就代表「这个 job 齐全」，主程序可以立刻消费。
    #
    # payload（见 export_payload / update_payload_for）：
    #   :whole_model => true  ⇒ 整份文档进 .skp（Model#save_copy）
    #   :whole_model => false ⇒ :entities 进 .skp（组件定义 save_as / 临时定义兜底）
    def run_job(model, payload, base_name, op, target_rel_folder)
      rel_folder = Support.text(target_rel_folder).strip
      if op == OP_UPDATE && !safe_rel_folder?(rel_folder)
        return result(false, ErrCode::EXPORT_FAILED, Messages.export_failed('目标资产目录不合法'))
      end

      # 名字已经过 sanitize（命名对话框 / 库内文件名），这里再做一次幂等清洗兜住内部调用方：
      # ⚠️ 之后的 .skp 名、封面名、manifest.name 全部用这一个值，绝不各自再取一次。
      name = sanitize_name(base_name)

      inbox = Paths.inbox_dir
      if inbox.empty?
        return result(false, ErrCode::INBOX_UNWRITABLE, Messages.export_inbox_unavailable(''))
      end
      unless Paths.ensure_dir(inbox)
        return result(false, ErrCode::INBOX_UNWRITABLE, Messages.export_inbox_unavailable(inbox))
      end

      job_dir, job_id = create_job_dir(inbox)
      if job_dir.nil?
        return result(false, ErrCode::INBOX_UNWRITABLE, Messages.export_inbox_unavailable(inbox))
      end
      unless writable_dir?(job_dir)
        cleanup(job_dir)
        return result(false, ErrCode::INBOX_UNWRITABLE, Messages.export_outside(job_dir))
      end

      begin
        perform_job(model, payload, job_dir, job_id, name, op, rel_folder)
      rescue StandardError => error
        # 任何未预见的异常都必须清掉半成品（尤其不能留下 manifest.json）
        cleanup(job_dir)
        result(false, ErrCode::EXPORT_FAILED, Messages.export_exception(error.message))
      end
    end

    def perform_job(model, payload, job_dir, job_id, base_name, op, rel_folder)
      # ① .skp（失败即整单失败：没有本体的 job 毫无意义）
      skp_name = base_name + SKP_EXT
      skp_path = File.join(job_dir, skp_name)
      saved, detail = save_payload(model, payload, skp_path)
      unless saved && File.file?(skp_path) && File.size(skp_path) > 0
        cleanup(job_dir)
        return result(false, ErrCode::EXPORT_FAILED, Messages.export_failed(detail))
      end
      # 成功但需要让用户知道的一句话（目前只有 save_copy 改写了文档关联路径这种极小概率）
      warning = saved ? Support.text(detail).strip : ''

      # ② 封面（非致命：失败就 cover=null，主程序回落到 .skp 内嵌预览）
      cover_name = base_name + COVER_EXT
      cover_path = File.join(job_dir, cover_name)
      has_cover, cover_detail = capture_cover(model, cover_path)
      cover_value = nil
      if has_cover
        cover_value = cover_name
      else
        # 可能写出了一个半截 png：删掉，避免主程序把它当封面
        remove_file(cover_path)
        warning = warning.empty? ? Support.text(cover_detail).strip : warning
      end

      # ③ manifest（最后写，原子就位）
      manifest = build_manifest(op, base_name, skp_name, cover_value, op == OP_UPDATE ? rel_folder : nil)
      unless write_manifest(job_dir, manifest)
        cleanup(job_dir)
        return result(
          false,
          ErrCode::INBOX_UNWRITABLE,
          Messages.export_inbox_unavailable(File.join(job_dir, MANIFEST_FILE))
        )
      end

      if op == OP_UPDATE
        message = has_cover ? Messages.update_ok(base_name) : Messages.update_ok_no_cover(base_name)
      else
        message = has_cover ? Messages.export_ok(base_name, job_id) : Messages.export_ok_no_cover(base_name, job_id)
      end
      unless warning.empty?
        message = message + "\n" + warning
      end
      result(true, nil, message, (has_cover && warning.empty?) ? nil : 'warn', job_id)
    end

    # ══════════════════════════════ 存 .skp ══════════════════════════════
    #
    # payload → .skp 的分派。两类的差别只在「哪段几何进文件」，命名与清单逻辑完全共用：
    #   整份文档 ⇒ save_document（Model#save_copy）
    #   选中/组件 ⇒ save_selection（下面两条路线）
    def save_payload(model, payload, path)
      if payload.is_a?(Hash) && payload[:whole_model] == true
        return save_document(model, path)
      end
      entities = payload.is_a?(Hash) ? payload[:entities] : nil
      entities = [] unless entities.is_a?(Array)
      save_selection(model, entities, path)
    end

    # 整份文档 → .skp。
    #
    # 【查证】官方只有 `Model#save_copy(path[, version])`（「save the copy of the current model
    #   to a file」），而且**绝不能**用 `Model#save`（会把用户文档绑到库文件）。见 docs/probe Q1。
    # 【查证】官方文档没有写明 save_copy 会不会改写「文档关联路径」（对比
    #   `ComponentDefinition#save_copy` 明写"不改变已关联的路径"）。
    # 【推断】社区通行用法（拿它出备份 / 模板 / 单场景文件）表明不改写；这里仍做一次前后比对：
    #   万一真被改写，就把这句话作为警告带给用户（去「文件 ▸ 另存为」存回原路径）——
    #   这是**用户文档**级别的风险，宁可多说一句。
    # ⚠️ 不做事务包裹：save_copy 是整份存盘，包在 start_operation 里没有意义（且可能在
    #    操作未提交时被拒）。
    def save_document(model, path)
      before = Support.text(model_path(model)).strip
      ok = begin
        model.save_copy(path)
      rescue StandardError => error
        return [false, error.message]
      end
      return [false, 'Model#save_copy 返回 false'] unless ok == true

      after = Support.text(model_path(model)).strip
      if !before.empty? && before != after
        puts("[ID BOX] save_copy changed document path: #{before} -> #{after}")
        return [true, '提示：SketchUp 把当前文档关联到了导出副本，请用「文件 ▸ 另存为」存回原路径。']
      end
      [true, '']
    end

    # 选中内容 → .skp
    #
    # 两条路线（docs/probe Q1 D 表）：
    #   ①a 选中恰 1 个 ComponentInstance → inst.definition.save_as(path)：零事务、零改动；
    #   ①b 其它情况 → 临时定义 + 事务 + abort_operation：靠回滚保证用户文档不变。
    # ①a 失败（极少：定义不可保存等）才降级到 ①b，两者都失败才报错。
    def save_selection(model, selection, path)
      if selection.length == 1 && component_instance?(selection[0])
        saved, detail = save_via_definition(selection[0], path)
        return [true, ''] if saved
        remove_file(path)   # save_as 失败可能留 0 字节文件，别让它污染 ①b 的结果判断
        fallback_saved, fallback_detail = save_via_temp_definition(model, selection, path)
        return [true, ''] if fallback_saved
        return [false, detail.empty? ? fallback_detail : (detail + '；备用路线：' + fallback_detail)]
      end
      save_via_temp_definition(model, selection, path)
    end

    # 路线 ①a
    def save_via_definition(instance, path)
      definition = begin
        instance.definition
      rescue StandardError
        nil
      end
      return [false, '取不到组件定义'] if definition.nil?
      begin
        ok = definition.save_as(path)
        ok == true ? [true, ''] : [false, 'ComponentDefinition#save_as 返回 false']
      rescue StandardError => error
        [false, error.message]
      end
    end

    # 路线 ①b
    #
    # ⚠️ `abort_operation` 必须在 ensure 里也执行：正常路径、save_as 抛错、add_group 抛错
    #    三种情况都要回滚，否则用户模型里会留下 IDBOX_TMP_* 定义（R3）。
    # ⚠️ 事务只包住「搬进临时定义 + 存盘」这一小段，不打断用户的撤销栈语义。
    def save_via_temp_definition(model, selection, path)
      started = false
      saved = false
      detail = ''
      begin
        model.start_operation(TEMP_OP_NAME, true)
        started = true
        definition = model.definitions.add(temp_definition_name(model))
        if definition.nil?
          detail = '无法创建临时组件定义'
        else
          group = definition.entities.add_group(selection)
          group.explode
          ok = definition.save_as(path)
          saved = (ok == true)
          detail = 'ComponentDefinition#save_as 返回 false' unless saved
        end
      rescue StandardError => error
        saved = false
        detail = error.message
      ensure
        abort_quietly(model) if started
      end
      [saved, detail]
    end

    def temp_definition_name(model)
      base = TMP_DEFINITION_PREFIX + Time.now.to_i.to_s
      name = base
      index = 1
      while definition_exists?(model, name) && index < 1000
        index += 1
        name = base + '_' + index.to_s
      end
      name
    end

    def definition_exists?(model, name)
      !model.definitions[name].nil?
    rescue StandardError
      false
    end

    def abort_quietly(model)
      model.abort_operation
      true
    rescue StandardError
      false
    end

    # ══════════════════════════════ 截图 ══════════════════════════════
    #
    # `write_image` 的唯一可靠调用形态（docs/probe Q2）：
    #   · 用**显式 options Hash**（不用关键字实参：SU 的 C 接口收的是位置 Hash，
    #     Ruby 2.7/3.x 下传 Hash 字面量最稳，也避开 kwargs 兼容坑）；
    #   · 必须给 :width / :height（vpwidth 可能是 0）；
    #   · 不改相机、不 zoom ⇒ 「所见即所得」。
    def capture_cover(model, path)
      view = model.active_view
      return [false, '当前模型没有活动视图'] if view.nil?
      options = {
        :filename => path,
        :width => COVER_WIDTH,
        :height => COVER_HEIGHT,
        :antialias => true,
        :compression => 0.9,
        :transparent => false
      }
      ok = view.write_image(options)
      return [false, 'View#write_image 返回 false'] unless ok == true
      return [false, '截图文件没有落盘'] unless File.file?(path)
      [true, '']
    rescue StandardError => error
      [false, error.message]
    end

    # ══════════════════════════════ manifest ══════════════════════════════
    def build_manifest(op, base_name, skp_name, cover_name, rel_folder)
      {
        'apiVersion' => MANIFEST_API_VERSION,
        'op' => op,
        'name' => base_name,
        'skp' => skp_name,
        'cover' => cover_name,
        'targetRelFolder' => (op == OP_UPDATE ? Support.text(rel_folder) : nil),
        'pluginVersion' => PLUGIN_VERSION,
        'createdAt' => timestamp
      }
    end

    # 本地时区 + 偏移（形如 2026-11-09T18:40:00+08:00）——主程序据此判断 job 新旧
    def timestamp
      Time.now.strftime('%Y-%m-%dT%H:%M:%S%:z')
    rescue StandardError
      ''
    end

    # `.tmp` → rename：主程序只认 manifest.json，所以在 rename 完成之前它看不到这个 job。
    def write_manifest(job_dir, manifest)
      final_path = File.join(job_dir, MANIFEST_FILE)
      tmp_path = File.join(job_dir, MANIFEST_TMP_FILE)
      json = begin
        JSON.generate(manifest)
      rescue StandardError
        nil
      end
      return false if json.nil? || json.empty?

      written = begin
        # 二进制写：JSON.generate 产出 UTF-8 字节，不让 Windows 的换行/编码转换插手
        File.open(tmp_path, 'wb') { |file| file.write(json) }
        File.file?(tmp_path) && File.size(tmp_path) > 0
      rescue StandardError
        false
      end
      return false unless written

      begin
        File.rename(tmp_path, final_path)
        File.file?(final_path)
      rescue StandardError
        remove_file(tmp_path)
        false
      end
    end

    # ══════════════════════════════ 失败清理 ══════════════════════════════
    #
    # 只清本文件自己建的文件（不递归、不碰上级目录），并且**先删 manifest** ——
    # 只要 manifest 不在，主程序就永远不会把这个 job 当完整作业。
    def cleanup(job_dir)
      return false if Support.text(job_dir).strip.empty?
      remove_file(File.join(job_dir, MANIFEST_FILE))
      remove_file(File.join(job_dir, MANIFEST_TMP_FILE))
      entries = begin
        Dir.entries(job_dir)
      rescue StandardError
        []
      end
      entries.each do |entry|
        next if entry == '.' || entry == '..'
        remove_file(File.join(job_dir, entry))
      end
      begin
        Dir.rmdir(job_dir)
        true
      rescue StandardError
        false
      end
    end

    def remove_file(path)
      text = Support.text(path)
      return false if text.strip.empty?
      return false unless File.file?(text)
      File.delete(text)
      true
    rescue StandardError
      false
    end

    # ══════════════════════════════ 目录与越界校验 ══════════════════════════════
    def create_job_dir(inbox)
      attempt = 0
      while attempt < JOB_ID_TRIES
        attempt += 1
        job_id = new_job_id
        dir = File.join(inbox, job_id)
        next unless Paths.within_root?(inbox, dir)
        begin
          Dir.mkdir(dir)
          return [dir, job_id]
        rescue StandardError
          nil                                  # 撞名/并发：换一个 jobId 重试
        end
      end
      [nil, '']
    end

    # jobId = 任务目录名。⚠️ **必须匹配主程序契约 `^\d{8}-\d{6}-[0-9a-z]{4}$`** ——
    # 主程序按这个正则认任务编号，不匹配就会把整个任务判废（搬进 failed\ 并写 error.txt），
    # 用户这边看到的是「导出成功」、ID BOX 里却永远收不到。所以：
    #   · 前缀固定 8 位日期 + '-' + 6 位时间 + '-'（本地时间，便于人眼对时）；
    #   · 后缀恰好 4 位 [0-9a-z]（这里用 4 位十进制，天然是子集）。
    # 后来者**不要**再加别形态的兜底（例如 'job-' + epoch：可读性好但会被判废）。
    def new_job_id
      Time.now.strftime('%Y%m%d-%H%M%S') + '-' + format('%04d', rand(10000))
    rescue StandardError
      # 极端兜底（时钟 API 不可用的理论场景）：**仍产出同形态名字**，契约优先于可读性。
      # 用固定纪元 Time.at(0)（本地时区渲染）反算，绝不产出 'job-...' 这类契约外名字。
      # 若真走到这里，名字会是 1970 年 —— 主程序可能按「过期任务」归档，这是可接受的降级
      # （被归档 ≥ 被判废：至少还留着一份可人工捞回的产物）。
      stamp = begin
        Time.at(0).strftime('%Y%m%d-%H%M%S')
      rescue StandardError
        '19700101-000000'
      end
      stamp + '-' + format('%04d', rand(10000))
    end

    # 写盘前的最后一道闸（deny by default）：
    #   ① 必须在 %APPDATA%\idbox_export 之下（含 `..` 归一化后判断）；
    #   ② 不能在 %APPDATA%\idbox 之下（哪怕未来有人把 export_root 改成它的子目录）；
    #   ③ 不能在库根之下（库只读，这是本产品最重要的一条）。
    def writable_dir?(dir)
      root = Paths.export_root
      return false if root.empty?
      return false unless Paths.within_root?(root, dir)

      data_root = idbox_data_root
      return false if !data_root.empty? && Paths.within_root?(data_root, dir)

      library = library_root
      return false if !library.empty? && Paths.within_root?(library, dir)
      true
    rescue StandardError
      false
    end

    def idbox_data_root
      appdata = Support.text(ENV['APPDATA'])
      appdata.strip.empty? ? '' : File.join(appdata, 'idbox')
    end

    # ══════════════════════════════ 右键候选（更新用）══════════════════════════════
    #
    # 返回 [] 或一组候选（每个都是「库里的一条资产」）：
    #   { :path, :rel_folder, :base_name, :record, :instance, :label }
    # 「认得出」的判据是**物理事实**：.skp 真的在库根之下且真的在盘上。
    # record 只用于取资产显示名，不参与判定 —— 索引可能比磁盘旧（用户刚手动放进去），
    # 那时按目录照样能更新（主程序是按 folder 合并的，见 docs/probe Q4）。
    #
    # 顺序 = 意图强弱（见头注 §右键判据）。①②③ 里有任意一个命中就返回，
    # **只有全落空**才去扫顶层实例（④）—— 那一档是"可能是好几个资产"的兜底，代价也最高。
    def update_targets
      model = Sketchup.active_model
      return [] if model.nil?
      data = snapshot
      return [] if data.nil? || !data.ok?
      root = Support.text(data.manifest['libraryRoot']).strip
      return [] if root.empty?

      list = []
      # ① 选中的组件（用户显式点过）
      selection = selected_entities(model)
      if selection.length == 1 && component_instance?(selection[0])
        push_target(list, data, root, definition_path(selection[0]), selection[0])
      end
      # ② 正在编辑的组件（双击进组件后右键，最贴近"光标下就是这个组件"）
      editing = editing_instance(model)
      push_target(list, data, root, definition_path(editing), editing) unless editing.nil?
      # ③ 文档本身（直接打开库里的 .skp 来改 —— 用户最常走的一条）
      push_target(list, data, root, model_path(model), nil)
      return list unless list.empty?

      # ④ 兜底：这个场景里已放置的库内组件（>1 个 ⇒ 菜单给子项让用户点名）
      top_level_instances(model).each do |instance|
        break if list.length >= MAX_UPDATE_TARGETS
        push_target(list, data, root, definition_path(instance), instance)
      end
      list
    rescue StandardError
      []
    end

    # 把一条「盘上真实存在的库内 .skp」收进候选表（同 relFolder 只留第一条 = 意图最强的）。
    def push_target(list, data, root, abs, instance)
      path = Support.text(abs).strip
      return false if path.empty?
      return false unless Paths.absolute_like?(path)
      return false unless File.file?(path)
      return false unless Paths.within_root?(root, path)
      rel_folder = folder_relative_to(root, path)
      return false if rel_folder.nil?

      key = normalize_rel(rel_folder)
      return false if list.any? { |item| normalize_rel(item[:rel_folder]) == key }

      base = Support.text(File.basename(path, '.*')).strip
      return false if base.empty?
      record = find_record(data, rel_folder)
      list << {
        :path => path,
        :rel_folder => rel_folder,
        # 库内文件的 basename 一定不含 Windows 非法字符（否则它自己在盘上就不存在），
        # 过一遍 sanitize 只是为了让 manifest 与本文件其余命名逻辑同构。
        :base_name => sanitize_name(base),
        :record => record,
        :instance => instance,
        :label => target_label(record, base)
      }
      true
    rescue StandardError
      false
    end

    # 子菜单里显示的名字：优先索引里的资产显示名（用户认得出的那个），没有就用文件名。
    def target_label(record, fallback)
      name = record.is_a?(Hash) ? Support.text(record['name']).strip : ''
      name.empty? ? fallback : name
    rescue StandardError
      fallback
    end

    # 点「更新」时按 rel_folder 重新找一次目标（菜单是几秒前算的，模型可能已变）。
    # 空 ⇒ 按当前上下文取第一个候选（菜单只有一项时走这条）。
    def pick_update_target(rel_folder)
      wanted = Support.text(rel_folder).strip
      targets = update_targets
      return targets.first if wanted.empty?

      key = normalize_rel(wanted)
      target = targets.find { |item| normalize_rel(item[:rel_folder]) == key }
      target
    rescue StandardError
      nil
    end

    # 候选 → 导出 payload。
    # ⚠️ 文档级更新**永远整份存盘**：库里那条 .skp 就是这个文档，
    #    若只把选中内容存进去，等于把资产覆盖成一小块（数据事故）。见 save_document。
    def update_payload_for(target)
      instance = target[:instance]
      if instance.nil? || !entity_alive?(instance)
        return { :whole_model => true, :entities => [], :default_name => target[:base_name] }
      end
      { :whole_model => false, :entities => [instance], :default_name => target[:base_name] }
    end

    def entity_alive?(entity)
      return false if entity.nil?
      return false unless entity.respond_to?(:valid?)
      entity.valid? == true
    rescue StandardError
      false
    end

    # ══════════════════════════════ 导出哪一块 ══════════════════════════════
    #
    # 右键菜单拿不到光标实体（见头注），所以「对着谁导出」只能按上下文推断：
    #   ① 有选中 ⇒ 选中内容（用户显式指定过，最可靠）
    #   ② 在组件里编辑 ⇒ 那个组件实例
    #   ③ 其它 ⇒ 整份文档
    # default_name 一律走 export_base_name（组件名 → 文档标题 → 文件名 → 兜底），
    # 它同时是命名对话框的默认值。
    def export_payload(model)
      selection = selected_entities(model)
      unless selection.empty?
        return {
          :whole_model => false,
          :entities => selection,
          :default_name => export_base_name(model, selection)
        }
      end
      editing = editing_instance(model)
      unless editing.nil?
        return {
          :whole_model => false,
          :entities => [editing],
          :default_name => export_base_name(model, [editing])
        }
      end
      { :whole_model => true, :entities => [], :default_name => export_base_name(model, []) }
    rescue StandardError
      { :whole_model => true, :entities => [], :default_name => FALLBACK_NAME }
    end

    # 用户双击进了某个组件在编辑 ⇒ active_path 末项就是那个组件实例
    # 【查证】`Model#active_path`：「the sequence of entities the user has double-clicked on
    #   for editing」，未在编辑态时为 nil 或空数组。
    def editing_instance(model)
      path = model.active_path
      return nil if path.nil? || path.empty?
      last = path[path.length - 1]
      component_instance?(last) ? last : nil
    rescue StandardError
      nil
    end

    # 只扫**顶层**：库内资产插进来就是顶层实例；递归进去会把家具内部的每个零件都翻一遍。
    # 扫描上限 INSTANCE_SCAN_LIMIT：大模型顶层可能上万条，context menu 回调里不能无限扫。
    def top_level_instances(model)
      out = []
      entities = model.entities
      return out if entities.nil?
      scanned = 0
      entities.each do |entity|
        scanned += 1
        break if scanned > INSTANCE_SCAN_LIMIT || out.length >= INSTANCE_SCAN_LIMIT
        out << entity if component_instance?(entity)
      end
      out
    rescue StandardError
      []
    end

    # 只判「有没有」，不把整份实体表读进数组（导出前的空文档检查用）。
    def entities_empty?(model)
      entities = model.entities
      return true if entities.nil?
      entities.each { |_entity| return false }
      true
    rescue StandardError
      true
    end

    def definition_path(instance)
      definition = instance.definition
      definition.nil? ? '' : Support.text(definition.path)
    rescue StandardError
      ''
    end

    def model_path(model)
      Support.text(model.path)
    rescue StandardError
      ''
    end

    # 绝对路径 → 相对库根的**目录**（posix 斜杠，形如 模型/家具/椅子/休闲椅）。
    # 只用于拼 targetRelFolder；越界/同路径一律 nil。
    def folder_relative_to(root, abs)
      root_norm = Paths.normalize_slashes(File.expand_path(Support.text(root)))
      abs_norm = Paths.normalize_slashes(File.expand_path(Support.text(abs)))
      return nil if root_norm.empty? || abs_norm.empty?

      # 比较用大小写不敏感（Windows），但**取值**用原始大小写（relFolder 要与索引逐字对齐）
      comparable_root = Paths.windows? ? root_norm.downcase : root_norm
      comparable_abs = Paths.windows? ? abs_norm.downcase : abs_norm
      return nil unless comparable_abs.start_with?(comparable_root + '/')

      rest = abs_norm[(root_norm.length + 1)..-1]
      return nil if rest.nil? || rest.strip.empty?
      parts = rest.split('/')
      parts.pop                                  # 去掉文件名本身，剩下的就是目录
      return nil if parts.empty?
      parts.join('/')
    rescue StandardError
      nil
    end

    def find_record(data, rel_folder)
      target = normalize_rel(rel_folder)
      return nil if target.empty?
      data.records.each do |record|
        return record if normalize_rel(record['relFolder']) == target
      end
      nil
    rescue StandardError
      nil
    end

    def normalize_rel(value)
      text = Paths.normalize_slashes(Support.text(value)).strip
      Paths.windows? ? text.downcase : text
    end

    # targetRelFolder 只接受**库内相对目录**：拒绝绝对路径、拒绝 `.` / `..` 段。
    # （它会被主程序拼到库根上，是最需要防注入的一处输入。）
    def safe_rel_folder?(value)
      rel = Support.text(value).strip
      return false if rel.empty?
      return false if Paths.absolute_like?(rel)
      parts = rel.gsub('\\', '/').split('/')
      return false if parts.empty?
      parts.each do |part|
        return false if part == '..' || part == '.' || part.empty?
      end
      true
    rescue StandardError
      false
    end

    # ══════════════════════════════ 快照（缓存）══════════════════════════════
    #
    # 只缓存**成功**的快照：失败（manifest 缺失 / index 正在写导致 SHA 对不上）不缓存 ——
    # 签名只由 manifest 的 generatedAt|indexSha256 决定，若把失败也按签名钉住，
    # 主程序刚写完索引那一刻的临时失败会一直生效到下次刷新索引，症状是「更新项凭空不出现」。
    def snapshot
      signature = Loader.signature
      return @snapshot if !@snapshot.nil? && @snapshot_signature == signature

      loaded = Loader.load
      return loaded unless loaded.is_a?(Snapshot) && loaded.ok?
      @snapshot = loaded
      @snapshot_signature = signature
      @snapshot
    rescue StandardError
      nil
    end

    def library_root
      data = snapshot
      return '' if data.nil? || !data.ok?
      Support.text(data.manifest['libraryRoot']).strip
    rescue StandardError
      ''
    end

    # ══════════════════════════════ 命名 ══════════════════════════════
    #
    # 取名顺序：组件定义名 → 文档标题 → 文档文件名 → 固定兜底。
    # 用组件名优先是因为「导出至 IDBOX」最常见的就是把库里没有的单个组件收进来，
    # 组件名才是用户认得出的资产名；空选中（整份文档导出）时自然落到标题/文件名。
    # ⚠️ 返回值是**唯一**的资产名：既是命名对话框的默认值，也是 .skp / .cover.png /
    #    manifest.name 的共同前缀（用户改过的话以用户为准，见 ask_export_name）。
    def export_base_name(model, selection)
      candidate = ''
      if selection.length == 1 && component_instance?(selection[0])
        candidate = Support.text(definition_name(selection[0])).strip
      end
      if candidate.empty?
        title = Support.text(model_title(model)).strip
        candidate = title unless untitled?(title)
      end
      if candidate.empty?
        path = Support.text(model_path(model)).strip
        candidate = Support.text(File.basename(path, '.*')).strip unless path.empty?
      end
      sanitize_name(candidate)
    end

    # 导出前先问名字（用户 2026-11-09：「能不能在 SketchUp 里直接让我先命名文件，然后再做导出保存」）。
    #
    # 【查证】`UI.inputbox(prompts, defaults, title)` 返回**与输入框同序的数组**；
    #   用户点「取消」时返回 `false`（官方 UI 文档 @return [Array, false]）。
    # ⇒ 取消 = 返回 nil，调用方据此**一个文件都不写**（连 job 目录都不建）。
    # 名字留空 ⇒ 用默认值；含非法字符 ⇒ sanitize_name 清洗（与磁盘名同一套规则）。
    def ask_export_name(default_name)
      fallback = sanitize_name(default_name)
      answer = UI.inputbox([NAMING_PROMPT], [fallback], NAMING_TITLE)
      return nil if answer.nil? || answer == false
      value = answer.is_a?(Array) ? Support.text(answer[0]).strip : ''
      value.empty? ? fallback : sanitize_name(value)
    rescue StandardError => error
      # 弹不出对话框（极端环境）⇒ 当作用户取消：宁可不导出，也不静默用一个他没点过确认的名字
      puts("[ID BOX] naming dialog failed: #{error.class}: #{error.message}")
      nil
    end

    def definition_name(instance)
      definition = instance.definition
      definition.nil? ? '' : Support.text(definition.name)
    rescue StandardError
      ''
    end

    def model_title(model)
      Support.text(model.title)
    rescue StandardError
      ''
    end

    def untitled?(value)
      UNTITLED_NAMES.include?(Support.text(value).strip.downcase)
    end

    # 只做「能在 Windows 上落成文件名」的最小处理，不改语义：
    # 非法字符换 _、结尾的点/空格去掉（Windows 会静默截断）、限长 60 字。
    def sanitize_name(value)
      text = Support.text(value).strip.gsub(ILLEGAL_NAME_CHARS, '_')
      text = text[0, NAME_MAX].to_s if text.length > NAME_MAX
      text = text.gsub(/[. ]+\z/, '').strip
      text.empty? ? FALLBACK_NAME : text
    end

    # ══════════════════════════════ 小工具 ══════════════════════════════
    def selected_entities(model)
      selection = model.selection
      return [] if selection.nil?
      list = []
      selection.each { |entity| list << entity }
      list
    rescue StandardError
      []
    end

    def component_instance?(entity)
      return false if entity.nil?
      return false unless defined?(Sketchup::ComponentInstance)
      entity.is_a?(Sketchup::ComponentInstance)
    rescue StandardError
      false
    end

    def result(ok, code, message, level = nil, job_id = nil)
      {
        :ok => ok == true,
        :code => code,
        :message => message,
        :level => level,
        :jobId => job_id
      }
    end

    def status_text(message)
      Sketchup.status_text = Support.text(message)
      true
    rescue StandardError
      false
    end

    def messagebox(message)
      UI.messagebox(Support.text(message))
      true
    rescue StandardError
      false
    end

    def ask_yes_no(question)
      UI.messagebox(Support.text(question), YES_NO_BUTTONS)
    rescue StandardError
      NO_ANSWER
    end
  end
end
