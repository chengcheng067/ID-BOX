# ID BOX · SketchUp 插件 —— lib/loader.rb（Snapshot + Loader + Inserter）
#
# 加载顺序（docs/42 §3.2）：序 3，必须在 core 与 paths 之后 ——
#   - 依赖 core：ErrCode / Messages / 契约常量（API_VERSION、MANIFEST_FILE、KINDS、
#     INSERTABLE_KINDS、KIND_LABELS、PLUGIN_VERSION、OP_NAME、YES_*、SHA_RETRY_*）
#   - 依赖 paths：Paths.manifest_path / Paths.index_path / Paths.within_root?
#
# 职责（docs/42 §2 文件 5）：数据流三件套，三者内聚，拆开会造成跨文件互引：
#   - Snapshot：Loader.load 的返回载体（永不抛，读取结果一律用它承载）；
#   - Loader：读 manifest/index + SHA256 三轮重试 + normalize_record（thumbRel 逐字保留）；
#   - Inserter：DefinitionList#load（docs/36:129【查证】），消费 Snapshot#find 的 record。
#
# ⚠️ 纪律（搬运不改行为，T01 只做物理搬迁）：
#   - Snapshot 永不抛；Loader / Inserter 的每个 rescue 语义逐字保留；
#   - 纯读方：本文件不写任何盘（唯一写盘点在 lib/paths.rb 的 Diagnostics，
#     且只在建窗失败时由 lib/panel_dialog.rb 调用）；
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
      if !raw.empty? && !(Paths.absolute_like?(raw) && Paths.within_root?(root, raw))
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

    # A14 码表与文案不改（docs/42 §9）：这里只是把 IDBOX-105 按既有 Messages.with_code 组装
    def outside_note(value)
      Messages.with_code(
        ErrCode::PATH_OUTSIDE,
        '缩略图路径不可信，已拒绝使用（校验根由环境推导，不用 JSON 值）：' + Support.text(value)
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
        # A8「只增不删」：payload 只增 `thumbsRoot` 这一个字段，字段总数仍 22（§12 C-5 不改索引快照字段）。
        # R-2（docs/42 §13）落地后的取值口径：root 由**环境推导**（`Paths.thumbs_dir`），不用 JSON 值；
        # 校验只判 JSON 里的 `thumbsRoot`/`thumbRel` 是否落在该根内，越界 → IDBOX-105 由 notes 承载，
        # 且这里回传的永远是环境推导根本身（绝不回传 JSON 原值 ⇒ 不把未校验路径拼进 HTML）。
        # APPDATA 缺失 ⇒ 仍推 '' ⇒ panel.html（T02 已写、本卡不可碰）的 `state.thumbsRoot = data.thumbsRoot || ''`
        # （:1055）收到空值即全走内联 SVG 占位，A12 按降级口径不判失败（docs/42 §6.3）。
        'thumbsRoot' => thumbs_root,
        'stateError' => Support.text(@state_error),
        'notes' => @notes,
        'records' => @records,
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
        return failure(ErrCode::INDEX_INVALID, Messages.bad_index('records 不是数组'), notes)
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
      result(true, nil, Messages.insert_ok(record['name']))
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
end
