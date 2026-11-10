/** IPC 通道名（主进程 / 预加载 / 渲染进程共用）
 *
 * 约定：新增通道必须同时改 `shared/ipc.ts` + `preload/index.ts` + `main/index.ts`，三处缺一不可。
 * `drag:start` 必须走 `ipcRenderer.send`（同步），不能用 invoke。
 */
export const IPC = {
  importPaths: 'import:paths',
  importEvent: 'import:event',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  /**
   * 主进程 → 渲染进程：设置已被改写（DEF-22-1，2026-10 真机取证）。
   *
   * 存在的理由：`settings:set` 的 handler 只写主进程内存 + 磁盘，**不通知渲染层** →
   * 通过 `window.modvault.setSettings({theme:'dark'})` 改设置后 `settings.json` 已是 dark，
   * 但活实例的 `document.documentElement.dataset.theme` 仍是 light，界面不变、必须重启。
   *
   * Payload = **归一化后的完整 `Settings`**（不是 patch）：渲染层直接 `set({settings})`，
   * 不需要再发一次 `getSettings`（多一次 IPC 且可能读到更晚的第三次写入）。
   *
   * ⚠️ 只在**写盘成功后**发。写盘失败时渲染层必须保持旧值，否则"界面说改了、重启又变回去"。
   */
  settingsChanged: 'settings:changed',
  chooseLibrary: 'settings:chooseLibrary',
  pickArchives: 'dialog:pickArchives',
  pickWatchDir: 'dialog:pickWatchDir',
  openPath: 'shell:openPath',
  reveal: 'shell:reveal',
  trashPaths: 'shell:trash',
  openLibrary: 'shell:openLibrary',
  renameAsset: 'asset:rename',
  /**
   * 批量重命名资产**文件夹**（0.6.0，docs/22 §3.4）。
   * 入参 `RenameFolderPlanItem[]`；主进程先整体预检（目标越界 / 已存在 / 非法）再逐条
   * `fs.rename`，任何一条失败 → **反向回滚已成功的**并返回 `rolledBack:true`。
   * 只改文件夹名，**不改包内文件名**。
   */
  renameFolders: 'asset:renameFolders',
  rescan: 'library:rescan',
  sevenZipPath: 'env:sevenZip',
  // ── T01 新增（T04 完成接线） ──────────────────────────────────
  /**
   * 拖出到 DCC：payload = 文件绝对路径 + 可选缩略图文件名 + 可选预渲染卡片 PNG
   * `(absPath, thumbName, cardPng?: Uint8Array)`；必须 send 不是 invoke
   * （`webContents.startDrag` 要在 dragstart 的同步段发起）。`cardPng` 缺失/解码失败时
   * main 回退到 `resolveDragIcon(thumbName)`。
   */
  dragStart: 'drag:start',
  thumbEnsure: 'thumb:ensure',
  /**
   * 生成 / 复用 **≤1024 预览图**（docs/26 方案 C + H，拖拽卡片用）。
   * 入参 `(assetId, absPath)`，返回缓存文件名（`vault://thumb/<name>` 可直接读）。
   *
   * 与 `thumb:ensure` 的区别只有「尺寸档位 + 文件名后缀」：缩略图是 480（网格），
   * 预览图是 1024（拖拽卡片）。**幂等**：文件已存在时主进程只 stat，不解码原图。
   * 返回 null = 读不了 / 解码不了（TGA 等）→ 渲染层必须回退缩略图或原图。
   */
  thumbPreview: 'thumb:preview',
  thumbDelete: 'thumb:delete',
  /** 材质球调参持久化：单删某资产的**某一个**缓存文件（`thumbDelete` 是按 id 通配全删，不能复用） */
  thumbDeleteOne: 'thumb:deleteOne',
  thumbPrune: 'thumb:prune',
  thumbClear: 'thumb:clear',
  /** T04 追加：缓存数量 / 占用，设置面板显示用 */
  thumbStats: 'thumb:stats',
  /**
   * **只读**列出缩略图缓存目录里的文件（2026-10 数据救援）：
   * 返回 `ThumbFileEntry[]`（name / size / mtimeMs）。
   *
   * 存在的理由：rescan 曾把 `thumbPath` 抹成空，而图片文件还在盘上——
   * 通用修复需要知道"盘上到底有哪些 `<id>-<8hex>`"，否则只能靠硬编码对照表。
   *
   * ⚠️ 本通道**只读**：不提供任何删除能力（清理仍走 thumb:delete / thumb:deleteOne / thumb:prune）。
   * 尤其**不要**用 `thumb:prune` 当探测——它会把不在 liveIds 里的文件全部删掉。
   */
  thumbList: 'thumb:list',
  diskFree: 'disk:free',
  indexBackup: 'index:backup',
  // ── T06 新增（分类体系，06 v1.0.2 §12.1） ──────────────────────
  /** 指派分类：移动目录到 <大类>/<一级>/<二级>/，返回新 folder/relFolder */
  assignCategory: 'asset:assignCategory',
  /** 遗留布局迁移（2/3 段 → 4 段双哨兵），DB 驱动 */
  migrateLayout: 'library:migrateLayout',
  // ── 2026-10-30 存量大类迁移（P0：升级前被判成 model 的 CAD 图纸搬进 CAD/）──
  /**
   * **只读**探测：库里有几个资产「当前是 model、包内只有 CAD 图纸」待搬进 `CAD/`。
   *
   * 判据（`main/kindMigrate.ts` 文件头）：`kind==='model' && hasCad && !hasModel`
   * —— 含 `.skp`+`.dwg` 的混合包**不迁**（模型优先的既有裁定）。
   * 幂等：迁移完成后 `kind` 变 `cad` → 本探测返回空。零写入（不建目录、不写快照）。
   */
  detectKindMigration: 'library:detectKindMigration',
  /**
   * 执行迁移。**渲染层只传空对象触发**，不接受任何路径 ——
   * main 自己按 `settings.libraryDir` + 库内资产重算 plan 再执行
   * （防渲染层被注入后传任意路径；与 `mergeMaterial` 的白名单校验同理但更严）。
   *
   * 返回 `KindMoveResult[]`（最终落盘值），DB 更新由渲染层做。
   */
  applyKindMigration: 'library:applyKindMigration',
  // ── 2026-10-19 材质大类合并（docs/14 §2.3，T-03） ─────────────────
  /** 只读探测：库里是否还有 `贴图/` / `材质预设/` 待合并（启动探测用，零写入） */
  detectMaterialMerge: 'library:detectMaterialMerge',
  /** 执行迁移：逐资产搬进 `材质/`（>50 条且未 force 时只返回 needsManual） */
  mergeMaterial: 'library:mergeMaterial',
  /** 回滚：按 manifest 逆序搬回（P2 UI；函数与单测本批已交付） */
  rollbackMaterialMerge: 'library:rollbackMaterialMerge',
  /** 主进程 → 渲染进程：启动只读探测发现有旧大类目录待合并（Payload = MergeMaterialDetectResult） */
  materialMergeNotice: 'library:materialMergeNotice',
  // ── 2026-10 装机反馈：截图/本地图片设为封面（任务 3） ─────────────
  /** 把剪贴板/本地图片写进资产文件夹并返回 rel 路径（main 侧校验 magic bytes/大小/路径） */
  setCoverImage: 'asset:setCoverImage',
  // ── 2026-10：材质球离屏渲染图落盘（任务 6） ──────────────────────
  /**
   * 渲染出的材质球**透明 PNG** 写进 thumbs 目录；文件名与既有缩略图同格式，返回缓存文件名。
   * 载荷含 `params` / `shape`：两者都参与 hash（shape 只在非球面时），必须由渲染层传来。
   */
  saveBallThumb: 'thumb:saveBall',
  /**
   * 尺寸**回填**（2026-10「分辨率筛选失效」）：`(folder, rels)` → `ProbedImageSize[]`。
   *
   * 只读文件头（64KB）、不解码整图，读不出的条目**静默省略**（返回条数可能少于入参）。
   * 单次上限 `PROBE_SIZES_MAX`（200 条），渲染层自己分片。**不做任何回填调度**：
   * 落库完全由调用方按返回的 `rel` 决定。
   * main 侧必须校验 `folder` 在库目录内，越界返回空数组。
   */
  probeSizes: 'asset:probeSizes',
  // ── 2026-10 UI 规范 v0.2：无边框窗口自绘控制（§3.1/§4-2）+ 应用版本 ──
  /** 最小化（send，fire-and-forget） */
  winMinimize: 'win:minimize',
  /** 最大化/还原切换（send；主进程切完经 winMaximizedEvent 广播新状态） */
  winMaximizeToggle: 'win:maximize',
  /** 主进程 → 渲染进程：最大化状态变化（WindowControls 切 □/❐ 图标） */
  winMaximizedEvent: 'win:maximizedChanged',
  /** 关闭窗口（send） */
  winClose: 'win:close',
  // ── 2026-10 导入批次取消（用户拖错包时的「叫停」） ────────────────
  /**
   * 请求取消**当前进行中的导入批次**（send；fire-and-forget，不需要回执）。
   *
   * 为什么是 `send` 而不是 `invoke`：这个通道没有返回值可等。
   * `invoke` 会向渲染层承诺一个 Promise 兑现，而主进程能做的最多就是"把取消
   * 代次计数器 +1"——那是同步的一行代码，包成 Promise 只会在渲染层多一个
   * 没人 await 的悬空 promise（还容易被误读成"取消已完成"，其实真正生效要等
   * 在途的那几条复制跑完）。取消的真实结果由 `importEvent` 流里的 `cancelled`
   * 条目和仍在推进的 `done` 条目自然表达，不需要额外回执。
   *
   * 语义见 `main/index.ts#importCancelGen`：**只停止还没开始的条目**，
   * 正在复制的那几条会正常做完（中途 abort 会在库里留下半成品目录）。
   */
  cancelImport: 'import:cancel',
  /** package.json 版本号（设置·关于 tab 版本胶囊 / 侧栏小字） */
  getAppVersion: 'app:getVersion',
  // ── 2026-10 自动检查更新（GitHub Releases） ──────────────────────
  /**
   * 检查 GitHub 最新正式版。入参 `force?: boolean`（true = 绕过主进程 10 分钟缓存，
   * 「立即检查」按钮用）；返回 `UpdateInfo`。**永不 reject**（失败写在 `error` 字段）。
   */
  checkUpdate: 'app:checkUpdate',
  /**
   * 用系统默认浏览器打开 http(s) 外链（「去下载」按钮）。
   * 与 `openPath` 分开：`shell.openPath` 是给本地路径用的，喂 URL 在 Windows 上
   * 会返回错误串（不是"打开浏览器"的语义）。只接受 http/https，其余返回 false。
   */
  openExternal: 'shell:openExternal',
  /**
   * 主进程 → 渲染进程：一个导入批次已结束（Payload = ImportBatchDoneEvent）。
   * 知末封面流水线 / 三源交叉验证 / 插件索引快照共用这条通道，**不是 AI 专属**。
   */
  importBatchDone: 'import:batchDone',
  // ── 2026-10 诊断日志（崩溃取证 + 用户自助导出） ──────────────────
  /** 日志目录 / 文件数 / 总大小（设置页展示，invoke） */
  logStats: 'log:stats',
  /** 打包 logs 目录为 zip（主进程弹保存对话框）；返回 LogExportResult */
  logExport: 'log:export',
  /** 渲染进程 → 主进程：转发一条渲染侧日志（send，fire-and-forget；渲染层已限流） */
  logWrite: 'log:write',
  // ── C 线：库内「最近删除」（docs/20 §4） ─────────────────────────
  /** 软删：资产目录 rename 到 `<库根>/.trash/`（保留期非 recycle 档用；返回 trashRel/deletedAt/size） */
  trashSoftDelete: 'trash:softDelete',
  /** 还原：从 `.trash/` 搬回原路径（重名追加序号，返回**最终落盘值**） */
  trashRestore: 'trash:restore',
  /** 彻底删除：指定软删项送进**系统回收站**（双保险） */
  trashPurge: 'trash:purge',
  /** 清空回收区：全部送进系统回收站 */
  trashEmptyAll: 'trash:emptyAll',
  /** 到期 / 超容量清理（启动 + 每 6 小时 + 设置页手动共用） */
  trashSweep: 'trash:sweep',
  // ── 知末封面抓取（docs/24，T-03） ──────────────────────────────
  /**
   * 从知末详情页抓模型主图当封面。
   *
   * 分工（与 `setCoverImage` 同款）：**抓取 + 落盘在主进程**
   * （渲染进程受 CORS/CSP 约束，且封面必须写成资产文件夹内的真实文件
   * `<资产名>.cover.<ext>` 才能被 `vault://asset/` 读到、rescan 才不会洗掉），
   * **写 Dexie 在渲染层**（主进程拿不到 IndexedDB）。
   * 入参 `FetchZhimoCoverPayload`，返回 `FetchZhimoCoverResult`（扁平结构，失败带 `reason`）。
   * 主进程侧必须校验 `folder` 在库目录内；本通道**不抛错**。
   */
  fetchZhimoCover: 'zhimo:fetchCover',
  /**
   * 知末**只取详情页**的轻量入口（站方分类 / 风格 / 版本 / 标题）。
   *
   * 与 `fetchZhimoCover` 的区别只有"不下图片、不写盘"：
   * 只发**一次**详情页 GET，绝不请求任何图片字节，因此**不需要 `folder`**、
   * 也不会出现 `too-small` / `bad-image` 这类只在图片步骤才有的失败。
   *
   * 存在理由：封面通道必须"下到图且 ≥200px"才算成功，图 404 会让
   * **已经解析出来的站方分类**跟着一起丢。分类落库前必须查
   * `shared/zhimoTaxonomyMap.ts` 的 `mapZhimoCategory()`（本通道不做映射）。
   *
   * 入参 `FetchZhimoMetaPayload`，返回 `FetchZhimoMetaResult`（扁平结构，**不抛错**）。
   */
  fetchZhimoMeta: 'zhimo:fetchMeta',
  // ── HDR 预览（0.6.5） ─────────────────────────────────────────────
  /**
   * 准备 HDR 预览：主进程流式解码 + 盒式降采样 + 落缓存（命中直接返回）。
   *
   * 入参 `{ path: string, targetWidth?: number }`（目标宽度白名单 512/2048/4096，
   * 其他值夹到最近的，缺省 2048）。
   * 返回 `HdrPrepareResult`：`{ ok:true, cachedPath, width, height, fromCache }`
   * 或 `{ ok:false, reason }`（**不抛错**，IPC 表面只有一种形状）。
   *
   * 渲染进程拿到 `cachedPath` 后用 `hdr://<文件名>` 读（见 `main/protocol.ts` 的 hdr host）。
   * 源图 300MB+ 的解码在主进程做，渲染进程只拿 ≤4096 宽的产物（16384 px 是很多显卡的
   * MAX_TEXTURE_SIZE 上限，原尺寸 Float32 解码要 1.6GB —— 必须降采样）。
   */
  hdrPrepare: 'hdr:prepare',
  /** 主进程 → 渲染进程：HDR 解码进度（`HdrProgressEvent = { path, ratio }`，按 path 区分） */
  hdrProgress: 'hdr:progress',
  // ── 2026-10 导入重复处置（docs/27） ────────────────────────────────
  /**
   * 主进程 → 渲染进程：导入中发现重复，请用户裁决（Payload = `ImportConflictAsk`）。
   *
   * **一次导入只发一次**（整批聚合，800ms 聚合窗口 + 每来一条新冲突 +400ms、上限 2500ms）。
   * 之后才发现的冲突一律按答复里的 `batchDefault` 处理，不再打扰用户。
   */
  importConflictAsk: 'import:conflictAsk',
  /**
   * 渲染进程 → 主进程：裁决结果（Payload = `ImportConflictAnswer`）。
   *
   * 主进程按 `requestId` 兑现挂起的 Promise；**未知 / 过期 requestId 必须静默丢弃**
   * （超时之后迟到的答复不能影响下一批）。用 `invoke` 只是为了拿到兑现确认，
   * 主进程侧返回 void。
   */
  importConflictAnswer: 'import:conflictAnswer',
  /**
   * 主进程 → 渲染进程：**这次询问已作废**（Payload = `ImportConflictExpired`）。
   *
   * 只在**主进程单方面结束**时必须发：120s 超时。渲染层收到就关掉弹窗——
   * 否则弹窗会挂在屏幕上，而用户之后的每次点击都会被当作「过期答复」静默丢弃
   * （`requestId` 已从 `pendingAsks` 移除），表现为"关不掉、点了没反应"（DEF-19-1）。
   *
   * 其它终止路径不需要发：用户自己答复时渲染层会主动清 `conflictAsk`；
   * 渲染进程崩溃时已经没有接收方。
   */
  importConflictExpired: 'import:conflictExpired',
  // ── 插件导出（docs/39 §2.1，写盘侧）──────────────────────────────
  /**
   * 渲染进程 → 主进程：交付一份插件快照记录（Payload = `PluginSnapshotPayload`）。
   *
   * 形状照既有先例 `indexBackup`（`shared/ipc.ts:78`、`main/index.ts:1832-1849`）：
   * **渲染层生成内容、主进程执行落盘**——渲染层没有任何 Node 能力（`README.md:285`、preload
   * 全文无 `node:fs`），它写不了 `%APPDATA%\idbox\plugin\`，只能把内容交出去。
   *
   * `trigger` 必须落在 `PLUGIN_TRIGGER_SET` 内（deny by default）；不在集里的一律拒，
   * 缩略图涓流就是典型（§2.3 明确不入触发集）。主进程侧只做入队与节流，不重复判据。
   *
   * 返回 `true` = 本次触发**立即落盘**（或已排进 quiet 窗口）；`false` = 被拒（开关关 /
   * 触发点不合法）。fire-and-forget 语义：本通道不抛错，渲染层 `.catch` 后继续。
   */
  pluginSnapshot: 'plugin:snapshot',
  /**
   * 渲染进程 → 主进程：**导出 SketchUp 插件包（`.rbz`）**。
   *
   * 用户 2026-11-04 拍板（`docs/39` §4.3 形态①）：ID BOX 侧动作只有「导出文件 + 引导用户去
   * 扩展管理器安装」——**不联网、不下载、不执行代码、不复制到 Plugins 目录**。
   * 形态②（自动复制进 Plugins）V1.0 不采用，这条通道不是它的入口。
   *
   * 无入参（源码目录由主进程解析：dev = `<仓库根>/plugin-src`，打包 = `resources/plugin-src`）。
   * 返回 `PluginRbzExportResult`：成功带路径（主进程会顺手 `shell.showItemInFolder`），
   * 取消带 `canceled:true`，失败带中文 `error`（含「先开启插件索引导出」这一类前置校验）。
   */
  pluginExportRbz: 'plugin:exportRbz',
  // ── SketchUp 插件收件箱（docs/probe/su-export-to-idbox.md · 方案 A）────────
  //
  // 插件把「业务产物」写到 `%APPDATA%\idbox_export\incoming\<jobId>\`（manifest 最后
  // 用 `.tmp` → rename 落下），主进程负责发现 + 搬运，渲染层负责导入 / 覆盖 + 写 Dexie。
  // 契约与纯校验规则见 `shared/inbox.ts`。
  /**
   * 主进程 → 渲染进程：收件箱里有一个**完整且已通过校验**的任务（Payload = `InboxJob`）。
   *
   * `InboxJob` 里的 `jobDir` / `skpPath` / `coverPath` 都是主进程算好并 stat 过的绝对路径
   * —— 渲染层没有 Node 能力，不要自己拼。
   *
   * ⚠️ **at-least-once**：渲染层没就绪时主进程会每 3 秒重发一次（最长约 2 分钟），直到收到
   * `inboxAck`。消费方必须按 `jobId` 去重（同一 jobId 只处理一次，重复到达时补一次 ack）。
   */
  inboxJob: 'inbox:job',
  /**
   * 渲染进程 → 主进程：这个任务处理完了（**成功和失败都要调**，否则目录会一直堆在
   * `incoming\` 里）。主进程把 `<incoming>\<jobId>\` 整目录搬到 `<done>\<jobId>\`
   * 或 `<failed>\<jobId>\`，失败时在目录内写 `error.txt`（人类可读中文原因）。
   *
   * 幂等：目录已不在 incoming（重复 ack / 上一轮已搬走）返回 `archivedTo: null`，**不是错误**。
   * 绝不删除任何文件 —— 归档目录留给用户排查。
   */
  inboxAck: 'inbox:ack',
  /**
   * 渲染进程 → 主进程：把任务里的 `.skp` **就地覆盖**库内同名 `.skp`（「更新」通道）。
   *
   * 只覆盖那一个文件：`<name>.skp.tmp` → `rename` 原子替换；**绝不**动目录里其它文件，
   * **绝不**动 `renderParams` / `renderShape` / 分类 / 自定义封面（用户口径 `docs/48 §7`）。
   *
   * ⛔ 与 `import:paths` 的覆盖档是两件事：那条路会把旧目录整个送进回收站且只继承 12 个
   * 字段（`importer.ts:replaceAssetFolder` / `applyOverwriteInherit`），用在「更新」上
   * 会丢渲染参数与自定义封面（勘察 §Q4-3 / §风险 R5）。
   *
   * 返回 `InboxApplyUpdateResult`（**不抛错**，失败原因在 `reason` 里，可直接展示）。
   */
  inboxApplyUpdate: 'inbox:applyUpdate',
  // ── SketchUp 插件「使用记录」回传（插入一次 = 用过一次，累加计数）──────────────
  //
  // 独立目录 `%APPDATA%\idbox_export\usage\<jobId>.json`（一个文件 = 一条记录），
  // 与 `incoming\` 的导出通道**完全隔离**（互不读对方的目录、互不共用 watcher）。
  // 契约与纯校验规则见 `shared/inboxUsage.ts`。
  /**
   * 主进程 → 渲染进程：插件用过一次某个模型（Payload = `InboxUsageEvent`）。
   *
   * 语义与 `inboxJob` **刻意不同**：没有重发定时器，**文件本身就是队列** —
   * 渲染层不 `ackInboxUsage` 就不会删文件，下次启动扫描会再发一次。所以：
   * - 进程内**至多一次**（主进程按 `fileName` 去重，同一次插入不会被算成两次）；
   * - 跨启动**至少一次**（没消费的成功记录会被重放）。
   * 消费方按 `fileName` 去重、处理完（成功或失败）都要 ack。
   */
  inboxUsage: 'inbox:usage',
  /**
   * 渲染进程 → 主进程：这条使用记录处理完了（Payload = `InboxUsageAckPayload`）。
   *
   * `ok:true` → 删掉 `usage\<fileName>`（幂等：文件已不在也算成功）；
   * `ok:false` → **保留文件**，下次启动重试（Dexie 写失败时不能把记录吞掉）。
   *
   * ⚠️ 主进程只接受**文件名**，且必须过 `isInboxUsageFileName`（单段、无分隔符）——
   * 这是本通道唯一的安全边界，防止渲染层被注入后借它删任意文件。
   */
  inboxUsageAck: 'inbox:usageAck'
} as const
