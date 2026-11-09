# ID BOX · SketchUp 插件 —— lib/loader.rb（Snapshot + Loader + Inserter）
#
# 加载顺序（docs/42 §3.2）：序 3，必须在 core 与 paths 之后 ——
#   - 依赖 core：ErrCode / Messages / 契约常量（API_VERSION、MANIFEST_FILE、KINDS、
#     INSERTABLE_KINDS、KIND_LABELS、PLUGIN_VERSION、OP_NAME、YES_*、SHA_RETRY_*）
#   - 依赖 paths：Paths.manifest_path / Paths.index_path / Paths.within_root?
#
# 职责（docs/42 §2 文件 5）：数据流四件套，彼此内聚，拆开会造成跨文件互引：
#   - Snapshot：Loader.load 的返回载体（永不抛，读取结果一律用它承载）；
#   - Loader：读 manifest/index + SHA256 三轮重试 + normalize_record（thumbRel 逐字保留）；
#   - Inserter：DefinitionList#load（docs/36:129【查证】），消费 Snapshot#find 的 record；
#   - Materializer（V1.0 新增，docs/48 §6）：双击材质 → 建材质 + 设当前材质（**不贴面**）。
#
# ⚠️ 纪律（搬运不改行为，T01 只做物理搬迁）：
#   - Snapshot 永不抛；Loader / Inserter 的每个 rescue 语义逐字保留；
#   - 纯读方：本文件不写任何盘（唯一写盘点在 lib/paths.rb 的 Diagnostics，
#     且只在建窗失败时由 lib/panel_dialog.rb 调用）；
#     ⚠️ 例外说明（2026-11 新增使用记录通道）：`Inserter.insert` 成功后会调
#     `UsageLog.record_insert`（lib/usage_log.rb）往 `%APPDATA%\idbox_export\usage\`
#     写一个几十字节的记录。**写盘代码不在本文件**，且失败静默、绝不影响插入。
#   - 零网络、零原生件、零 token、零端口、零后台服务；
#   - 顶层必须在 `module IDBoxPanel` 内、禁止全局变量（A7）；
#   - 不得用 `__FILE__` 拼资源路径（A7/A13，路径统一走 Paths）。
#
# 兼容性：Ruby 2.7 写法（禁 Hash#except / endless method / => 右赋值 / pattern matching）。

module IDBoxPanel
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

    # R-2 落地件（docs/42 §13 R-2，2026-11-06 裁定）：校验的 root **不得来自 JSON** ——
    # 被校验对象本身是不可信输入（docs/39 §4.1#8：任何来自 JSON 的路径出参必须做 isWithinRoot
    # 等价校验），拿一个 JSON 值去校验另一个 JSON 值不成立 ⇒ root 一律由**环境推导**：
    # `Paths.thumbs_dir`（= ENV['APPDATA']/idbox/thumbs，写入侧 `src/main/paths.ts:20-22` `thumbsDir()`）。
    # `Paths.plugin_dir` 不作 root（不同根，用它校验会恒判越界、双轨永久失效）。
    #
    # 形状（照 §6.1 步 1 预留口径）：
    #   root = Paths.thumbs_dir                                    # 可信：环境推导
    #   raw  = JSON 里的 thumbsRoot / record 的 thumbRel           # 不可信：只作被校验对象
    #   拒相对路径（absolute_like?）→ 消 `..`、归一化小写、大小写不敏感（src/main/ipcGuard.ts:128-139）
    #   越界 → ErrCode::PATH_OUTSIDE（IDBOX-105），由 notes 承载；
    #   返回的永远是环境推导根本身（绝不回传 JSON 原值 ⇒ 不把未校验路径拼进 HTML）。
    # APPDATA 缺失 ⇒ 仍推 ''（deny by default 不变 ⇒ A12 按降级口径：全部 SVG 占位并记录，不判失败）。
    def thumbs_root
      root = Paths.thumbs_dir
      return '' if root.strip.empty?

      raw = Support.text(@manifest['thumbsRoot']).strip
      note = nil
      # ⚠️ 必须先判「同根」（2026-11-09 修 IDBOX-105 误报）：
      #   `manifest.thumbsRoot` 报的就是**根目录本身**，而 `Paths.within_root?` 有意让
      #   「target == root」返回 false（它服务的是「文件必须落在根之下」的场景）。
      #   直接拿它校验 thumbsRoot ⇒ 每次都判越界 ⇒ 面板顶部常驻一条红色 IDBOX-105，
      #   用户会以为缩略图坏了。**根目录自身是合法目标，不算越界**。
      if !raw.empty? && !same_path?(root, raw) && !(Paths.absolute_like?(raw) && Paths.within_root?(root, raw))
        note = outside_note(raw)
      end

      # 记录级 thumbRel：`..` 逃逸同样拒（panel.html 靠它拼 <img> 前缀，拒后收空值即走 SVG 占位）
      @records.each do |record|
        rel = Support.text(record['thumbRel']).strip
        next if rel.empty?
        next if Paths.within_root?(root, File.join(root, rel))
        note ||= outside_note(rel)
      end

      add_note(note) unless note.nil?
      root
    end

    # 两个绝对路径是否指向同一个目录（消 `..`、归一化斜杠、Windows 大小写不敏感）。
    # 只用于「根目录自身算不算合法」这一处判定；**不改** Paths.within_root? 的既有语义
    # （那个方法服务「文件必须在根之下」，其它调用方依赖 target == root 返回 false）。
    # 相对路径仍拒（deny by default，与 absolute_like? 同口径）；永不抛异常。
    def same_path?(left, right)
      return false unless Paths.absolute_like?(right)
      a = Paths.normalize_slashes(File.expand_path(Support.text(left)))
      b = Paths.normalize_slashes(File.expand_path(Support.text(right)))
      return false if a.empty? || b.empty?
      return a.downcase == b.downcase if Paths.windows?
      a == b
    rescue StandardError
      false
    end

    # A14 码表与文案不改（docs/42 §9）：这里只是把 IDBOX-105 按既有 Messages.with_code 组装。
    # 2026-11-09 A 级文案收口：**用户可见文本不带绝对路径**（用户看不懂，还会把单行提示条占满）。
    # 具体是哪个路径越界只打到 Ruby 控制台（不写盘、不进 UI），排障时在「窗口 → Ruby 控制台」看。
    # 只在真的越界时才调用本方法，正常路径一次都不会打日志。
    def outside_note(value)
      puts("[ID BOX] thumb path rejected (outside root): #{Support.text(value)}")
      Messages.with_code(
        ErrCode::PATH_OUTSIDE,
        '部分缩略图指向了素材库外，已跳过（这些封面显示为图标）'
      )
    end

    # notes 去重：面板每 3 s 轮询会重复构造 payload，同一越界告警不能逐次累积
    def add_note(note)
      @notes << note unless @notes.include?(note)
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
        # A8「只增不删」：payload 只增字段，不删不改已有字段
        #   （v1.1.0 增 `thumbsRoot`；V1.0 增 `materialKinds`，见下方 records 之后的注释）。
        # R-2（docs/42 §13）落地后的取值口径：root 由**环境推导**（`Paths.thumbs_dir`），不用 JSON 值；
        # 校验只判 JSON 里的 `thumbsRoot`/`thumbRel` 是否落在该根内，越界 → IDBOX-105 由 notes 承载，
        # 且这里回传的永远是环境推导根本身（绝不回传 JSON 原值 ⇒ 不把未校验路径拼进 HTML）。
        # APPDATA 缺失 ⇒ 仍推 '' ⇒ panel.html（T02 已写、本卡不可碰）的 `state.thumbsRoot = data.thumbsRoot || ''`
        # （:1055）收到空值即全走内联 SVG 占位，A12 按降级口径不判失败（docs/42 §6.3）。
        'thumbsRoot' => thumbs_root,
        'stateError' => Support.text(@state_error),
        'notes' => @notes,
        'records' => @records,
        # 2026-11-09 新增（A8「只增不删」允许）：
        #   materialKinds = 允许「双击创建材质」的 kind（texture / material）。
        #   与 insertableKinds 分开是刻意的：单击插入组件 与 双击建材质 是两个不同动作，
        #   合成一张表会让面板无法区分「这条能双击」还是「这条只能单击」。
        'materialKinds' => MATERIAL_KINDS,
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
        # A 级文案收口：原来括号里写的是内部字段名，改成使用者能懂的说法
        return failure(ErrCode::INDEX_INVALID, Messages.bad_index('内容结构不完整'), notes)
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
      # 使用记录回传：插入成功 = 这个资产被用过一次（主程序累加计数）。
      # ⚠️ 必须在 `place` **之后**、返回成功之前：place 只负责落位，它自身失败不算插入失败
      #    （定义已进模型，用户可以自己拖入，见 place 的方法注释）。
      # ⚠️ 静默忽略写入失败：统计是附属行为，绝不能打断「插入模型」这个主流程。
      record_usage(record)
      result(true, nil, Messages.insert_ok(record['name']))
    end

    # 使用统计（`lib/usage_log.rb`）。
    #
    # 为什么用 `defined?(UsageLog)` 守卫：lib 的加载顺序里 `usage_log` 是序 8，
    # 在 loader（序 3）之后 —— 正常启动时运行到这里它一定已加载，但离线冒烟脚本
    # 可能只加载部分 lib（`scripts/plugin-smoke.rb` 的场景 A），没有守卫会 NameError，
    # 而 NameError 会让「插入」这条最常用的路径直接炸掉。
    def record_usage(record)
      return false unless defined?(UsageLog)
      UsageLog.record_insert(record)
    rescue StandardError
      false
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

  # ── 材质创建（双击贴图 / 材质；docs/48 §6，2026-11-09 拍板）─────────────────
  #
  # 用户逐字：「双击以后我们创建了材质，然后 SketchUp 里面就会有油漆桶，右侧会显示当前的材质
  #            是什么。用户想怎么贴怎么贴，后面不归我们管」
  # ⇒ 本模块**只做三件事**：materials.add → mat.texture = 图片 → materials.current = mat。
  #   ⚠️ 「当前材质」的**唯一**官方 API 是 `model.materials.current = mat`（不是 `active_material`，
  #      后者不是 SketchUp 的 API，见下方 activate 的查证）。设完必须 `current` 读回断言。
  #   ⚠️ **绝不自动贴面**：不碰 model.selection、不调 entities 的任何贴图方法，即使用户选了面。
  #   （这是与 Inserter 的语义分界：Inserter 往模型里加东西，Materializer 只往材质库加东西。）
  #
  # 取哪张图（「预设贴图 = 多张 PBR」的场景）：
  #   - 普通贴图：资产目录里通常只有一张可用图片 ⇒ 直接用它（mainFile 优先，见 pick_texture）；
  #   - 预设贴图：按 albedo 词表挑 **Albedo / BaseColor / Diffuse / Color** 那一张；
  #     Normal / Roughness / AO / Displacement / 预览图 一律判为**排斥项**，避免把法线贴成颜色。
  #   ⚠️ 词表是 `src/shared/pbrSlots.ts` 的**精简镜像**（Ruby 侧 require 不到 TS 模块）。
  #      主程序改词表时，这里要人工对齐（只在「新增别名 / 新增槽位」时才需要动）。
  #
  # 命名：用资产显示名；重名加序号（`木纹` / `木纹 2` / `木纹 3`），保证不与已有材质撞名。
  #
  # 纪律：纯读方（只读图片字节，不写任何盘）；不抛异常（一律用 result 承载）；
  #       SU 事务包住「建材质 + 挂贴图」，所以 Ctrl+Z 可撤销。
  module Materializer
    module_function

    # ── 自动切油漆桶工具（2026-11-09 用户实测要求）────────────────────────────
    # 用户原话：「双击材质后，右侧的首选材质确实是我想要的了，但是我还需要再去点一下，
    #            或者按一下快捷键 B，才会有贴材质的油漆桶出现。可不可以双击并载入材质后，
    #            自动触发快捷键 B，让油漆桶直接在鼠标上显示着？」
    #
    # 【查证】官方 `Sketchup.send_action(action)`（SU 6.0，@return Boolean）的 action 清单里，
    #   油漆桶的**具名 action 字符串**是 `selectPaintTool:`（官方原文清单
    #   「# - selectPaintTool:」，示例写法 `Sketchup.send_action("selectArcTool:")`）。
    #   同一份文档在「PC only / officially unsupported」的数字表里给出 `21078: select the
    #   Paint Bucket tool` —— 注意**不是** 21031（那是 Freehand Draw tool，常见误记）。
    # ⇒ 选**字符串**形态：跨平台（数字值文档明写 PC only 且"不再维护"）。
    #   同时 send_action 本身被官方标为 @deprecated（不推荐依赖）：所以**必须**容错，
    #   切换失败绝不能让"材质已经建好"这件事变成一次失败。
    PAINT_ACTION = 'selectPaintTool:'.freeze

    # SU 能当 Material#texture 直读的位图格式（webp / exr / hdr 不在内：SU 读不了）
    IMAGE_EXTS = %w[jpg jpeg png bmp tif tiff].freeze
    # 目录扫描上限：正常资产目录只有几张图，这个是防「relFolder 指到库根」的兜底
    SCAN_LIMIT = 200
    SCAN_DEPTH = 2

    # albedo 词表（`pbrSlots.ts` PBR_SLOT_WORDS.albedo 的子串项）
    ALBEDO_WORDS = %w[albedo basecolor basecol diffuse diff color].freeze
    # albedo 词表里只允许「整 token 相等」的短词（`col` 做子串会命中 column）
    ALBEDO_TOKEN_ONLY = %w[col].freeze
    # 排斥项（其余槽位 + 预览图）；命中即判 9 分，不选
    REJECT_WORDS = %w[
      normal nrm roughness rough ambientocclusion occlusion displacement disp height
      metalness preview cover thumb
    ].freeze
    # 排斥项里只允许「整 token 相等」的短词（`ao` 做子串会命中 kaolin，`nor` 会命中 north）
    REJECT_TOKEN_ONLY = %w[ao nor arm].freeze

    def result(ok, code, message, level = nil)
      {
        :ok => ok ? true : false,
        :code => code,
        :message => message,
        :level => level
      }
    end

    # 返回值：{ :ok, :code, :message, :level }
    #   :ok => true 且 :level 为 nil      → 完全成功
    #   :ok => true 且 :level == 'warn'   → 材质建好了但贴图没挂上（要如实告诉用户）
    #   :ok => false                      → 什么都没做（原因在 :message）
    def apply(record, manifest)
      return result(false, ErrCode::PATH_GONE, Messages.no_model) unless record.is_a?(Hash)
      model = Sketchup.active_model
      return result(false, ErrCode::PATH_GONE, Messages.no_model) if model.nil?

      folder = asset_folder(record, manifest)
      if folder.nil?
        return result(false, ErrCode::DISCOVERY_MISSING, Messages.no_library_root)
      end
      if folder == :outside
        return result(false, ErrCode::PATH_OUTSIDE, Messages.outside_root(Support.text(record['relFolder'])))
      end
      if folder == :missing
        return result(false, ErrCode::DISCOVERY_MISSING, Messages.no_asset_folder(record['relFolder']))
      end

      # relFolder 为空 ⇒ folder 就是库根，绝不能当资产目录去扫（会扫到整库）；
      # 那种情况只认 mainFile 自己。
      rel = Support.text(record['relFolder']).strip
      image = pick_texture(folder, record, !rel.empty?)
      if image.empty?
        return result(false, ErrCode::PATH_GONE, Messages.material_no_image(record['name']))
      end

      create(model, record, image)
    rescue StandardError => error
      result(false, ErrCode::PATH_GONE, Messages.material_exception(error.message))
    end

    # 资产目录：relFolder 为空（字段缺失）时退回库根 —— 那种情况只认 mainFile，不扫目录
    # （否则会扫整个库，几千个文件）。
    def asset_folder(record, manifest)
      library_root = Support.text(manifest['libraryRoot']).strip
      return nil if library_root.empty?
      rel = Support.text(record['relFolder']).strip
      return library_root if rel.empty?
      folder = File.join(library_root, rel)
      return :outside unless Paths.within_root?(library_root, folder)
      return :missing unless File.directory?(folder)
      folder
    end

    def create(model, record, image)
      base_name = material_name(record)
      created = nil
      texture_error = ''
      model.start_operation(MATERIAL_OP_NAME, true)
      begin
        created = model.materials.add(unique_material_name(model, base_name))
      rescue StandardError => error
        created = nil
        texture_error = error.message
      end
      if created.nil?
        abort_quietly(model)
        return result(false, ErrCode::PATH_GONE, Messages.material_exception(texture_error))
      end

      begin
        created.texture = image
      rescue StandardError => error
        texture_error = error.message
      end
      # 事务里先设一次（面板刷新通常跟着这次一起走）
      activate_error = activate(model, created)
      begin
        model.commit_operation
      rescue StandardError
        nil
      end
      # ⚠️ 提交之后再**确认一次**：SU 在 commit 时可能把「当前材质」还原成上一次的状态
      #    （用户 2026-11-09 实测：材质只进了「模型中」列表、没成为当前材质）。
      #    这里按「设 → 读回断言」处理，不靠猜。
      activate_error = activate(model, created) if activate_error.nil?

      name = material_name_of(created, base_name)
      if texture_attached?(created)
        if activate_error.nil?
          # ⚠️ 只有**完全成功**这一条路径才切工具：
          #   · 贴图没挂上 / 没能设为当前材质（上面两个 warn 分支）⇒ 不切，别给用户一个
          #     拿着错误材质的油漆桶；
          #   · 只读态 / 无活动模型根本到不了这里（apply 前面已经 return）；
          #   · Inserter（单击插入模型）**绝不**切工具 —— 那会把用户正在放组件的手打断。
          switch_to_paint_tool
          result(true, nil, Messages.material_ok(name))
        else
          result(true, nil, Messages.material_not_current(name, activate_error), 'warn')
        end
      else
        detail = texture_error
        detail = detail + '；' + activate_error.to_s unless activate_error.nil?
        result(true, nil, Messages.material_texture_missing(name, detail), 'warn')
      end
    end

    # 切到油漆桶工具（= 让油漆桶直接跟着鼠标，用户不用再按 B）。
    #
    # 【查证】`Sketchup.send_action('selectPaintTool:')`：官方 send_action 的 action 清单里有
    #   `selectPaintTool:`（数字等价物是 PC-only/unsupported 的 21078；**21031 是自由手绘**）。
    # 【查证】send_action 被官方标为 @deprecated（"not being maintained"），且是**异步**投递
    #   到消息队列 —— 所以：
    #   · 返回 false / 抛异常都**不影响本函数调用方**（材质已经建好并设为当前，这是既成事实）；
    #   · 只在控制台留一行痕迹便于排障，**不弹窗、不改成功文案**（用户没输，就不该看到报错）。
    def switch_to_paint_tool
      begin
        ok = Sketchup.send_action(PAINT_ACTION)
        puts("[ID BOX] send_action('#{PAINT_ACTION}') => #{ok.inspect}") unless ok == true
        ok == true
      rescue StandardError => error
        puts("[ID BOX] send_action failed: #{error.class}: #{error.message}")
        false
      end
    end

    # 把材质设为「当前材质」（= 材质面板里被选中的那个 = 油漆桶拿起来的那个），并**读回断言**。
    #
    # 【查证·一手证据】官方 API 是 `Sketchup::Materials#current=`：
    #   「The current= method is used to set the current material.」
    #   例：`materials = Sketchup.active_model.materials; materials.current = materials[0]`
    #   （ruby.sketchup.com/Sketchup/Materials.html）
    #   `Materials#current` 的说明更是逐字点名了面板：
    #   「the material that the user has selected in the Materials dialog」。
    # ⚠️ 上一版写的 `model.active_material = mat` **不是** SketchUp 的 API（Model 的实例方法表里
    #   没有它，`Sketchup::Model` 文档与官方 ruby-api-stubs 均可核对）⇒ 那一行一直在抛
    #   NoMethodError、被 rescue 吞掉，所以材质建出来了却从来不是当前材质。**不要再改回去**。
    #
    # 返回 nil（成功）或错误描述字符串（失败原因，直接给用户看）。
    def activate(model, material)
      materials = model.materials
      return '取不到当前模型的材质集合' if materials.nil?
      begin
        materials.current = material
      rescue StandardError => error
        return error.message
      end
      # 读回断言：`Materials#current` 就是面板里被选中的那个材质
      current = begin
        materials.current
      rescue StandardError
        nil
      end
      return '当前材质没有被切换（可能是 SketchUp 版本差异）' if current.nil?
      return nil if material_name_of(current, '') == material_name_of(material, '')
      '当前材质与新建材质不一致'
    rescue StandardError => error
      error.message
    end

    def abort_quietly(model)
      begin
        model.abort_operation
      rescue StandardError
        nil
      end
    end

    def material_name_of(material, fallback)
      begin
        name = Support.text(material.name).strip
        name.empty? ? fallback : name
      rescue StandardError
        fallback
      end
    end

    def texture_attached?(material)
      begin
        !material.texture.nil?
      rescue StandardError
        false
      end
    end

    # ── 选图 ────────────────────────────────────────────────────────────────
    # 只认位图；maps / Scenes 之类的子目录最多下钻 2 层（预设贴图常见 `maps/albedo.png`）。
    # scan = false 时只看 mainFile（relFolder 为空那种「没有资产目录」的记录）。
    def pick_texture(folder, record, scan)
      main_file = Support.text(record['mainFile']).strip
      main_abs = main_file.empty? ? '' : File.join(folder, main_file)
      main_is_image = !main_abs.empty? && image_file?(main_abs)

      candidates = scan ? image_files(folder) : []
      if candidates.empty?
        return main_is_image ? main_abs : ''
      end

      main_abs = '' unless main_is_image
      scored = []
      candidates.each do |absolute|
        scored << [texture_score(absolute), absolute == main_abs ? 0 : 1, File.basename(absolute).downcase, absolute]
      end
      scored.sort!
      best_score, _pref, _name, best = scored[0]
      # 整目录都是法线 / 粗糙度这类排斥项时，退回 mainFile（若它是图片），否则用第一个
      if best_score >= 9
        return main_abs unless main_abs.empty?
        return candidates[0]
      end
      best
    end

    def image_files(folder)
      out = []
      return out unless File.directory?(folder)
      walk_images(folder, 0, out)
      out
    end

    def walk_images(dir, depth, out)
      return if depth > SCAN_DEPTH || out.length >= SCAN_LIMIT
      entries = begin
        Dir.entries(dir).sort
      rescue StandardError
        return
      end
      entries.each do |entry|
        next if entry == '.' || entry == '..'
        path = File.join(dir, entry)
        if File.directory?(path)
          walk_images(path, depth + 1, out)
        elsif image_file?(path)
          out << path
        end
        return if out.length >= SCAN_LIMIT
      end
    end

    def image_file?(path)
      ext = Support.text(File.extname(path)).sub('.', '').downcase
      return false if ext.empty?
      return false unless IMAGE_EXTS.include?(ext)
      File.file?(path)
    end

    # 0 = albedo 命中（最想要）
    # 3 = 中性（没有槽位词，比如 `木纹.jpg`）
    # 9 = 排斥（法线 / 粗糙度 / AO / 置换 / 预览图）
    def texture_score(absolute)
      basename = Support.text(File.basename(absolute, '.*')).downcase
      return 9 if basename.include?('预览') || basename.include?('缩略')
      stem = basename.gsub(/[\s\-]+/, '_')
      tokens = stem.split(/[^a-z0-9]+/)
      flat = stem.gsub(/[^a-z0-9]+/, '')

      ALBEDO_WORDS.each do |word|
        return 0 if flat.include?(word)
      end
      ALBEDO_TOKEN_ONLY.each do |word|
        return 0 if tokens.include?(word)
      end
      REJECT_WORDS.each do |word|
        return 9 if flat.include?(word)
      end
      REJECT_TOKEN_ONLY.each do |word|
        return 9 if tokens.include?(word)
      end
      3
    end

    # ── 命名 ────────────────────────────────────────────────────────────────
    def material_name(record)
      base = Support.text(record['name']).strip
      if base.empty?
        main_file = Support.text(record['mainFile']).strip
        base = Support.text(File.basename(main_file, '.*')).strip unless main_file.empty?
      end
      base = 'ID BOX 材质' if base.empty?
      # 材质名过长在「材质」面板里会被截断；48 字足够辨识，也避免撞上有长度限制的实现
      base.length > 48 ? base[0, 48] : base
    end

    # 重名加序号：SketchUp 的材质名是用户可见的主键，撞名会让用户分不清哪个是刚建的
    def unique_material_name(model, base)
      materials = model.materials
      return base if materials[base].nil?
      index = 2
      while index < 1000
        candidate = base + ' ' + index.to_s
        return candidate if materials[candidate].nil?
        index += 1
      end
      base + ' ' + Time.now.to_i.to_s
    end
  end
end
