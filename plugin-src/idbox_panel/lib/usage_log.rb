# ID BOX · SketchUp 插件 —— lib/usage_log.rb（使用记录回传：插入一次 = 用过一次）
#
# 加载顺序（docs/42 §3.2）：序 8，在 core / paths / exporter 之后 ——
#   - core   ：Support / PLUGIN_VERSION
#   - paths  ：Paths.export_root / Paths.ensure_dir / Paths.within_root?
#   ⚠️ 本文件**不**依赖 loader / exporter / panel_*：它只写一个几十字节的 JSON，
#      与被插入的那个 record 只有「读一个 id」的关系（见 record_insert）。
#
# ── 干什么 ────────────────────────────────────────────────────────────────
# 用户在面板里单击插入一个模型（`loader.rb` 的 `Inserter.insert` 成功返回前）会调
# `UsageLog.record_insert(record)`，本文件往
#
#     %APPDATA%\idbox_export\usage\<jobId>.json
#
# 落一条记录。主程序扫这个目录、把记录交给渲染层累加计数（"最常用哪几个模型"）。
#
# 磁盘契约（**与 `src/shared/inboxUsage.ts` 逐字一致，改一边必须改另一边**）：
#   {
#     "apiVersion": 1,
#     "op": "usage",
#     "assetId": "<index.json 记录里的 id（UUID）>",
#     "at": "2026-11-09T18:40:00+08:00",
#     "pluginVersion": "1.2.0"
#   }
#   · 文件名 = <jobId>.json，jobId 形态 `YYYYMMDD-HHmmss-<4 位数字>`
#     （与 exporter.rb 的任务目录同名同形态；主程序按 `^\d{8}-\d{6}-[0-9a-z]{4}\.json$` 认）；
#   · **原子写**：先写 `usage\<jobId>.json.tmp` 再 `rename`（与 exporter.rb 的
#     manifest 同口径）⇒ 主程序看到 `.json` 即可信，`.tmp` 一律被忽略。
#
# ── 写盘边界（与 exporter.rb 同一套铁律，一条都不能松）────────────────────────
#   1) 只写 `%APPDATA%\idbox_export\`（本文件写它下面的 `usage\` 子目录）；
#   2) **绝不**写 `%APPDATA%\idbox\`（库、plugin\、thumbs\、settings.json、logs\ 零写入）；
#   3) **绝不**改任何已入库资产文件 —— 本功能只写一个自有 JSON，不碰库；
#   4) 目录名 / 文件名全部由本文件自己拼，**不接受**任何外部路径片段；
#      资产 id 只作为 JSON 的**值**落进文件（不参与拼路径），且仍过一遍字符白名单。
#
# ── 失败语义（硬约束）─────────────────────────────────────────────────────
# 所有失败**静默**：`record_insert` 恒返回 Boolean、**永不抛**。
# 统计是附属行为 —— 用户插模型时不能因为写不了统计文件而看到报错、更不能打断插入。
# 所以这里刻意没有 messagebox / status_text / puts（与 exporter.rb 的可见反馈相反）。
#
# 兼容性：Ruby 2.7 写法（禁 Hash#except / endless method / => 右赋值 / pattern matching）；
# 单一 module、无全局变量、零新增 gem（只用 stdlib 的 json，main.rb 已 require）。

module IDBoxPanel
  module UsageLog
    module_function

    # ── 契约常量（与 src/shared/inboxUsage.ts 对应）─────────────────────────
    USAGE_DIR_NAME = 'usage'.freeze
    FILE_SUFFIX = '.json'.freeze
    # 原子写的中间态后缀：主程序只认 `.json`，`.tmp` 过期残留也只是几十字节
    TMP_SUFFIX = '.tmp'.freeze
    API_VERSION = 1                 # 注意：是**数字 1**，不是字符串 '1'
    OP_USAGE = 'usage'.freeze
    ASSET_ID_MAX = 64               # UUID 是 36 字符，留一倍余量
    JOB_ID_TRIES = 8                # 撞名重试次数（同一秒内连点插入的极端情形）

    # 资产 id 的字符白名单（反向枚举）：Windows 文件名非法字符 + 路径分隔符 + 控制字符。
    # 反向：命中的**不是** id，而是注入尝试 / 损坏值 ⇒ 整条跳过。
    ILLEGAL_ID_CHARS = /[\\\/:*?"<>|\x00-\x1f\x7f]/

    # ── 入口（**唯一** public 语义的方法；恒 Boolean、永不抛）────────────────
    #
    # record 必须是 `Inserter.insert` 收到的那份 Hash（index.json 的一条记录）。
    # 只读它的 `id` 字段（Snapshot 的 normalize_record 已把它规范成字符串）。
    # 传 nil / 非 Hash / 没有 id ⇒ 直接 false（**不猜**：宁可少记一次，也不写脏数据）。
    def record_insert(record)
      return false unless record.is_a?(Hash)

      asset_id = asset_id_of(record)
      return false if asset_id.empty?

      dir = usage_dir
      return false if dir.empty?
      return false unless writable_dir?(dir)
      return false unless Paths.ensure_dir(dir)

      json = payload_json(asset_id)
      return false if json.empty?

      write_record(dir, json)
    rescue StandardError
      # 任何未预见的异常都吞掉：统计写入绝不能影响「插入模型」这个主流程
      false
    end

    # `usage\` 目录（`%APPDATA%\idbox_export\usage`）。
    # 根路径**只**从 Paths.export_root 取，本文件不自己拼 `%APPDATA%`——
    # 这样"只有一个地方定义导出根"这条纪律继续成立。
    def usage_dir
      root = Paths.export_root
      root.empty? ? '' : File.join(root, USAGE_DIR_NAME)
    end

    # 资产 id：去空白 + 白名单 + 长度上限。不合规一律 ''（调用方直接放弃）。
    def asset_id_of(record)
      id = Support.text(record['id']).strip
      return '' if id.empty?
      return '' if id.length > ASSET_ID_MAX
      return '' if ILLEGAL_ID_CHARS.match?(id)
      id
    rescue StandardError
      ''
    end

    # 记录体（字段名与顺序照契约；顺序本身不影响解析，只是便于人眼对账）
    def payload_json(asset_id)
      payload = {
        'apiVersion' => API_VERSION,
        'op' => OP_USAGE,
        'assetId' => asset_id,
        'at' => timestamp,
        'pluginVersion' => PLUGIN_VERSION
      }
      text = begin
        JSON.generate(payload)
      rescue StandardError
        ''
      end
      Support.text(text)
    rescue StandardError
      ''
    end

    # 本地时区 + 偏移（形如 2026-11-09T18:40:00+08:00）——与 exporter.rb 的 manifest 同口径，
    # 主程序用 Date.parse 校验（带偏移才不会被当成本地时间再偏一次）。
    def timestamp
      Time.now.strftime('%Y-%m-%dT%H:%M:%S%:z')
    rescue StandardError
      ''
    end

    # 写盘前的最后一道闸（deny by default）：
    #   ① 必须是绝对路径且在 %APPDATA%\idbox_export 之下（含 `..` 归一化后判断）；
    #   ② 不能在 %APPDATA%\idbox 之下（哪怕未来有人把 export_root 改成它的子目录）。
    # ⚠️ 不做 exporter.rb 里那条"不能在库根之下"的检查：那需要读索引快照
    #    （Loader.load + SHA256），每次插入都付这个代价不对等；而 usage_dir 是纯
    #    字符串拼出来的固定子目录，不可能落在库根里（库根来自同一份快照的 libraryRoot，
    #    它在别的盘/别的树）。这条判断对它是恒真的死代码。
    def writable_dir?(dir)
      root = Paths.export_root
      return false if root.empty?
      return false unless Paths.within_root?(root, dir)

      data_root = idbox_data_root
      return false if !data_root.empty? && Paths.within_root?(data_root, dir)
      true
    rescue StandardError
      false
    end

    def idbox_data_root
      appdata = Support.text(ENV['APPDATA'])
      appdata.strip.empty? ? '' : File.join(appdata, 'idbox')
    end

    # ── 原子写 ─────────────────────────────────────────────────────────────
    #
    # 撞名重试：同一秒内连点两次插入会算出同一个 jobId 前缀 + 同一个随机段（概率极低但存在），
    # `File.exist?` 预检 + 重试 8 次足够；仍撞名就放弃（少记一次，不覆盖别人的记录）。
    def write_record(dir, json)
      attempt = 0
      while attempt < JOB_ID_TRIES
        attempt += 1
        return true if write_one(dir, new_job_id, json)
      end
      false
    rescue StandardError
      false
    end

    # `.tmp` → rename（同目录同卷原子）。失败时删掉 tmp，不留半成品。
    def write_one(dir, job_id, json)
      final_path = File.join(dir, job_id + FILE_SUFFIX)
      return false if File.exist?(final_path)

      tmp_path = final_path + TMP_SUFFIX
      written = begin
        # 二进制写：JSON.generate 产出 UTF-8 字节，不让 Windows 的换行/编码转换插手
        File.open(tmp_path, 'wb') { |file| file.write(json) }
        File.file?(tmp_path) && File.size(tmp_path) > 0
      rescue StandardError
        false
      end
      unless written
        remove_file(tmp_path)
        return false
      end

      begin
        File.rename(tmp_path, final_path)
        File.file?(final_path)
      rescue StandardError
        remove_file(tmp_path)
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

    # jobId = 记录文件名（不含扩展名）。⚠️ **必须匹配主程序契约**
    # `^\d{8}-\d{6}-[0-9a-z]{4}\.json$` —— 不匹配的文件名会被主程序整条忽略
    # （用户这边毫无感知，只是"统计没涨"）。所以：
    #   · 8 位日期 + '-' + 6 位时间 + '-'（本地时间，便于人眼对时）；
    #   · 后缀恰好 4 位十进制（天然是 [0-9a-z] 的子集）。
    # 后人**不要**改成 epoch / 'usage-' + n 之类：那会被主程序静默忽略。
    def new_job_id
      Time.now.strftime('%Y%m%d-%H%M%S') + '-' + format('%04d', rand(10000))
    rescue StandardError
      # 极端兜底（时钟 API 不可用的理论场景）：**仍产出同形态名字**，契约优先于可读性。
      stamp = begin
        Time.at(0).strftime('%Y%m%d-%H%M%S')
      rescue StandardError
        '19700101-000000'
      end
      stamp + '-' + format('%04d', rand(10000))
    end
  end
end
