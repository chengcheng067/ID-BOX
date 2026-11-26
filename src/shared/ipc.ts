/** IPC 通道名（主进程 / 预加载 / 渲染进程共用）
 *
 * 约定：新增通道必须同时改 `shared/ipc.ts` + `preload/index.ts` + `main/index.ts`，三处缺一不可。
 * `drag:start` 必须走 `ipcRenderer.send`（同步），不能用 invoke。
 */
import type { PluginInstallStatus } from './pluginInstall'
import type { ProjectTemplate, ProjectTemplateNode } from './types'

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
  // ── 首页自定义背景图（docs/55 §2.1.4，Q-5/Q-6） ────────────────
  /**
   * 保存背景图（invoke）：本地文件复制 / URL 下载到 `<userData>/home-bg/`。
   * 入参 `HomeBackgroundSaveInput`，返回 `HomeBackgroundSaveResult`（**永不 reject**，
   * 失败原因写在 `error` 字段给界面直接展示）。
   */
  homeBackgroundSave: 'homeBackground:save',
  /**
   * 清理一张缓存背景图（invoke，单槽位替换 / 移除时删旧文件）。
   * 入参 `string | null`，幂等、永不抛错。
   */
  homeBackgroundClear: 'homeBackground:clear',
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
  /**
   * 渲染进程 → 主进程：**查询 SketchUp 插件联通状态**（2026-11-22 用户需求「联通绿点」）。
   *
   * 只读一个本地文件：`%APPDATA%\idbox\plugin\manifest.json`（插件索引快照的信封，
   * 字段表见 `shared/pluginSnapshot.ts` 的 `PluginManifest`）。文件存在、JSON 可解析、
   * 且（若有 enabled 类字段）未被置 false ⇒ 视为「检测到联通」。
   * 读不到 / 解析失败 / 异常一律返回 `{ connected: false, generatedAt: null }`，
   * **绝不抛错** —— 绿点只是状态提示，不能变成报错源。零网络：这条链路只碰本地盘。
   *
   * 返回 `PluginLinkStatus`（本文件下方定义）。
   */
  pluginLinkStatus: 'plugin:linkStatus',
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
  inboxUsageAck: 'inbox:usageAck',
  // ── 一键打包与素材同步（docs/58 §2.5 · T1 骨架，8 条新通道）────────────
  //
  // 铁律 `ipc.ts:3`：这 8 条必须同时存在于 shared/ipc.ts + preload/index.ts + main/index.ts。
  // 全部「不抛错、结果带 ok/error」沿用 HomeBackgroundSaveResult（本文件 :384-387）。
  /** invoke：弹保存对话框定库包落点，返回路径 / null（取消）。 */
  packageExportPick: 'package:exportPick',
  /** invoke：主进程流式写单文件 zip（ZIP64 + store），返回 PackageExportResult。 */
  packageExport: 'package:export',
  /** main → renderer on：导出进度 `{ phase:'assets'|'finalize', done, total }`。 */
  packageExportProgress: 'package:exportProgress',
  /** send：请求取消导出；只置代次计数，在写的那一个正常收尾后删 .tmp。 */
  packageExportCancel: 'package:exportCancel',
  /** invoke：弹打开对话框选库包，返回路径 / null（取消）。 */
  packageImportPick: 'package:importPick',
  /** invoke：**只读**验包（central directory + 校验器），返回 PackageInspectResult。 */
  packageImportInspect: 'package:importInspect',
  /** invoke：按清单白名单提取 + 还原记录，返回 PackageImportResult。 */
  packageImportApply: 'package:importApply',
  /** main → renderer on：导入进度 `{ done, total }`。 */
  packageImportProgress: 'package:importProgress',
  // ── 项目文件夹模板 / 首页快速访问（docs/60 §4-§6）────────────────────────
  //
  // 铁律 `ipc.ts:3`：以下通道必须同时存在于 shared/ipc.ts + preload/index.ts + main/index.ts。
  /**
   * invoke：标题参数化的**通用**选目录对话框（docs/60 §5.2 通道 1）。
   * 新建项目向导（T-03 选位置）与首页「添加快速访问」（T-05）共用同一条。
   * 入参 `PickDirectoryInput`，返回目录绝对路径 / null（取消）。**不改既有 `pickWatchDir`**。
   */
  pickDirectory: 'dialog:pickDirectory',
  /**
   * invoke：打开一条首页快速访问（钉选）文件夹（docs/60 §5.2 通道 3）。
   *
   * 入参只有 `HomePinnedFolder.id`：主进程**按 id 从自己的 settings** 解析 `absPath`
   * （不信渲染层传来的路径，`mergeMaterial` 同款防御），`existsSync` 通过后
   * `shell.showItemInFolder`。**0.9.2 守卫（`allowedOpenRoots`）不放宽** ——
   * 钉选打开不走 `shell:openPath` / `shell:reveal` 通道，走本通道的 id 白名单。
   * 返回 `null` = 成功；字符串 = 中文错误（未找到 id / 文件夹不存在），**永不 reject**。
   */
  homePinnedOpen: 'home:pinnedOpen',
  /**
   * invoke：**新建项目**（docs/60 §5.2 通道 2，T-03）。主进程两阶段落盘：
   * 阶段一对父目录 + 模板树展开出的**全部**目标路径逐条 `existsSync` 预检
   * （任一已存在 → 整体拒绝、零创建，错误串指明冲突目录）；阶段二按先浅后深
   * 逐个 mkdir（半程 IO 失败**不回滚不删除**，错误串如实报告已建数量）。
   *
   * W6 加固：渲染层传来的 `template` **不可信**，主进程重跑
   * `normalizeProjectTemplate`（清洗 / 4 级剪枝 / 兄弟去重 / 256 节点截断），
   * 根名用 `resolveRootName` 两分支解析（编号可选，docs/60 §2.4）。
   *
   * 返回 `ProjectCreateResult`（**永不 reject**，错误收口 `{ok:false, error:中文单行}`）。
   * 成功后主进程顺手 `shell.showItemInFolder(rootPath)`（W9，不经渲染层 reveal ——
   * 0.9.2 守卫只放行库根 ∪ 日志目录）；渲染层随后自动钉选（`addHomePinnedFolder`）。
   */
  projectCreate: 'project:create',
  /**
   * invoke：**只读**扫描一个文件夹的目录树，转成项目模板草稿（v1.2 反馈批 C，
   * 设置页「项目文件夹模板」卡支持「拖入文件夹自动识别」）。
   *
   * 入参 `TemplateScanInput`（`dirPath` = 拖入文件夹的绝对路径，渲染层经
   * `getPathForFile` 取得）。主进程 `fs.readdir withFileTypes` 递归下钻：
   * 跳过文件 / 符号链接 / 隐藏目录（`.` 开头，如 `.git`）；目录名清洗与
   * 深度 4 / 节点 256 限额全部收口到 `normalizeProjectTemplate`（唯一实现）。
   * 扫描本身比模板上限**多探一层**（深度 5 / 节点 1024 硬上限即停），
   * 用于统计「超出上限被丢弃」的数量（硬上限命中时丢弃数为**至少**口径）。
   *
   * ⚠️ **纯扫描零写盘**：不建目录、不写任何文件；目录不存在 / 无读权限 /
   * 空目录（没有任何子文件夹）都给明确中文错误。
   * 返回 `TemplateScanResult`（**永不 reject**，错误收口 `{ok:false, error:中文单行}`）。
   * ⚠️ 「让用户选」的纪律：扫描结果只是**预览草稿**，渲染层必须弹预览确认层、
   * 用户点「生成模板」才写入草稿（再走既有保存链）——绝不静默写入。
   */
  templateScanFromDir: 'template:scanFromDir',
  // ── 钉选目录应用内浏览（v1.2 反馈批 B，docs/60 §5.2 延伸）────────────────
  //
  // 用户原话：「我希望双击用户自己的文件夹以后，进入的仍然是我们的软件界面，
  // 也就是我们的软件代替了文件资源管理器的功能。」双击钉选卡不再弹资源管理器，
  // 改为渲染层的 `PinnedFolderBrowser`；这两条通道是它的数据面。
  // 铁律 `ipc.ts:3`：必须同时存在于 shared/ipc.ts + preload/index.ts + main/index.ts。
  //
  // ⚠️ 守卫零放宽：0.9.2 的 `allowedOpenRoots`（库根 ∪ 日志目录）**不为钉选目录开口**。
  // 两条通道各自在 main 侧按 `pinId` 从主进程自己的 settings 解析钉选根
  // （id 白名单，`home:pinnedOpen` 同款防御），再经 `main/pinnedDirGuard.ts` 的
  // `resolveWithinPinRoot` 做「逐段 resolve 后必须仍以该根为前缀」校验
  // （挡 `..` 穿越 / relPath 塞绝对路径 / 盘符切换），越界一律 `{ok:false}`。
  /**
   * invoke：**只读**列出钉选目录的**一层**条目（应用内浏览，每下钻一次调一次）。
   *
   * 入参 `FsListDirInput`（`pinId` + 相对钉选根的 `relPath`，空串 = 根）。
   * 跳过隐藏文件（`.` 开头）与符号链接；目录在前排序；单层条目数硬上限
   * `LIST_DIR_MAX_ENTRIES`（2000）防炸。返回 `FsListDirResult`
   * （**永不 reject**，错误收口 `{ok:false, error:中文单行}`）。
   * `home:pinnedOpen` 保留不动 —— 右键菜单「在资源管理器中打开」仍走它（兜底出口）。
   */
  fsListDir: 'fs:listDir',
  /**
   * invoke：用**系统默认程序**打开钉选目录内的一个条目（文件双击的「直达」——
   * 用户要的仍是打开文件，只是目录浏览留在软件内）。
   *
   * 入参 `FsOpenEntryInput`；main 侧同样走 pin 根前缀校验，越界 / 不存在一律
   * `{ok:false}`。返回 `FsOpenEntryResult`（**永不 reject**，`shell.openPath`
   * 的错误串压成中文单行）。渲染层只对文件调用；目录的双击在渲染层内下钻。
   */
  fsOpenEntry: 'fs:openEntry',
  // ── 钉选目录浏览器 v2 · 写操作 + 归档（docs/61 §批注结果 · 方案二）────────
  //
  // 铁律 `ipc.ts:3`：以下通道必须同时存在于 shared/ipc.ts + preload/index.ts + main/index.ts。
  // 全部入参带 `pinId`（主进程按 id 白名单从自己的 settings 解析钉选根，不信渲染层路径），
  // `dirRel` 相对钉选根（空串 = 根），过 `resolveWithinPinRoot` 前缀校验；条目名是
  // **单段**（不含路径分隔符，`main/archiveOps.ts#validateEntryName` 拒 `\/:*?"<>|` 等）。
  // 写通道失败统一收口 `{ ok:false, reason, error:中文单行 }`，**永不 reject**。
  /** invoke：在 dirRel 下新建文件夹。重名 `{ok:false, reason:'exists'}`。 */
  fsMkdir: 'fs:mkdir',
  /** invoke：重命名 dirRel 下的条目。重名拒绝；新旧同名（含仅大小写变化）直接 ok。 */
  fsRenameEntry: 'fs:renameEntry',
  /** invoke：把多个条目移入系统回收站（shell.trashItem）。部分失败不整批失败；单次上限 500。 */
  fsTrashEntries: 'fs:trashEntries',
  /**
   * invoke：列出**钉选根内部隐藏回收区**（`.idbox-trash`）的可恢复条目。
   *
   * 为什么需要：Windows 系统回收站对**网络映射盘**（DriveType 4）无效
   * （`shell.trashItem` 报 `Failed to perform delete operation`）。这类条目改走同盘
   * 原子 `rename` 进钉选根内的隐藏回收区，本通道即它的长期可访问入口。
   * 入参 `FsListPinnedTrashInput`（只收 `pinId`，路径由主进程从 settings 解析）。
   * 返回 `FsListPinnedTrashResult`（**永不 reject**）。
   */
  fsListPinnedTrash: 'fs:listPinnedTrash',
  /**
   * invoke：把隐藏回收区里的一个条目**真实还原**回原目录（同盘 `rename`）。
   *
   * 入参 `FsRestorePinnedTrashInput`（`pinId` + `token`；token 是 UUID，白名单
   * `/^[0-9a-f-]{36}$/` 防穿越；绝不接收原始中文名当路径段）。原位置被占用时
   * 自动追加 `-2/-3` 并返回 `renamed:true`。返回 `FsRestorePinnedTrashResult`
   * （**永不 reject**）。
   */
  fsRestorePinnedTrash: 'fs:restorePinnedTrash',
  /** invoke：7z 解压压缩包到同目录同名文件夹（防穿越校验；7z 缺失报 `no-7z`）。 */
  fsExtractArchive: 'fs:extractArchive',
  /** invoke：7z 压缩为同目录 zip；7z 缺失降级 PowerShell Compress-Archive。 */
  fsCompressEntries: 'fs:compressEntries',
  /** invoke：Windows「打开方式」对话框（rundll32 OpenAs_RunDLL；失败落日志不抛）。 */
  fsOpenWith: 'fs:openWith',
  /**
   * invoke：取钉选目录里**一个文件**的缩略图（图标视图预览，主进程链路）。
   *
   * 入参 `FsEntryThumbInput`（`pinId` + `dirRel` + 单段 `name`），守卫与其它 fs:*
   * 通道同一套（id 白名单 + `resolveWithinPinRoot` + `validateEntryName`）。
   * 分派：图片（jpg/jpeg/png/webp/bmp/gif）→ 解码降采样 ≤512 落缓存；skp → 复用
   * `main/skpPreview.ts` 提取内嵌预览；其余扩展名直接 `not-available`
   * （**不做**系统级缩略图 API，渲染层自绘类型图标兜底）。
   * 缓存在 `<userData>/pinned-thumbs/`，URL 走**专用协议** `pinned-thumb://<缓存文件名>`
   * （`protocol.ts` 注册；禁止 `file://` 直连）。handler 内有并发上限 4 的 promise 池，
   * 大文件夹一次请求几十张不会卡死主进程。
   * 返回 `PinnedEntryThumbResult`（**永不 reject**）。
   */
  fsEntryThumb: 'fs:entryThumb',
  /**
   * invoke：在**资源管理器**里按条目揭示钉选目录内的一个文件 / 子目录
   * （2026-11-25 缺陷：右键「在资源管理器中显示」弹的是钉选根而不是当前条目）。
   *
   * 为什么要新通道：渲染层原先复用 `home:pinnedOpen`，而它的语义是「打开钉选根」，
   * **不带子路径**；既有的 `shell:reveal` 又有 0.9.2 守卫（只放行库根 ∪ 日志目录），
   * 钉选路径会被拒。所以这里单开一条，守卫与其它 `fs:*` 完全同源：
   * `pinId` 白名单（`resolvePinnedRootById`）+ `relPath` 过 `resolveWithinPinRoot`
   * 逐段 resolve + 前缀校验（`..` 穿越 / 绝对路径 / 盘符切换全拒）。
   *
   * 入参 `FsRevealEntryInput`；`relPath` 用 `/` 分隔、空串 = 钉选根自己。
   * 文件 / 目录都走 `shell.showItemInFolder`（Windows 上目录会在父目录里选中它）。
   * 返回 `FsRevealEntryResult`（**永不 reject**，失败收口 `{ok:false, reason, error}`）。
   */
  fsRevealEntry: 'fs:revealEntry',
  // ── 「关闭窗口」询问（2026-11 用户需求）──────────────────────────
  //
  // 三段式，结构照 `importConflictAsk` / `importConflictAnswer` / `importConflictExpired`
  // （问 / 答 / 作废）：主进程问、渲染层答、主进程单方面结束时要显式作废。
  //
  // 触发链：`settings.closeBehavior === 'ask'`（默认档）时用户点主窗口 ✕
  // → `main/index.ts` 的 `win.on('close')` 拦下并 `preventDefault` → 发本询问
  // → `CloseAskDialog` 用户点「退至后台 / 彻底退出」→ 答复 → 主进程**执行完动作才收场**。
  /**
   * 主进程 → 渲染进程：用户点了窗口 ✕，请裁决「退至后台」还是「彻底退出」
   * （Payload = `CloseAskPayload`）。
   *
   * 一次 ✕ 只发一次：主进程侧 `closeAskInFlight` 挡住"弹窗还开着又点 ✕"的重复询问。
   */
  closeAsk: 'app:closeAsk',
  /**
   * 渲染进程 → 主进程：裁决结果（Payload = `CloseAnswer`）。
   *
   * 主进程按 `requestId` 兑现挂起的 Promise；**未知 / 过期 requestId 必须静默丢弃**
   * （超时 15s 之后迟到的答复不能反过来把已经 hide 的窗口再关一次）。
   * 用 `invoke` 只是为了拿到兑现确认，主进程侧返回 void。
   */
  closeAnswer: 'app:closeAnswer',
  /**
   * 主进程 → 渲染进程：**这次询问已作废**（Payload = `CloseAskExpired`）。
   *
   * 只在**主进程单方面结束**时必须发：15s 超时（兜底动作 `'tray'`）。渲染层收到就关掉
   * 弹窗 —— 否则它会挂在屏幕上，而用户之后的每次点击都会被当作「过期答复」静默丢弃
   * （`requestId` 已从 `pendingCloseAsks` 移除），表现为"关不掉、点了没反应"（DEF-19-1）。
   *
   * 其它终止路径不需要发：用户自己答复时渲染层会主动清弹窗；渲染进程崩溃时已无接收方。
   */
  closeAskExpired: 'app:closeAskExpired'
} as const

/**
 * `fs:listDir` / `fs:openEntry` 的入参（v1.2 反馈批 B）。
 *
 * `pinId` = `HomePinnedFolder.id`（主进程按它从**自己的 settings** 解析钉选根，
 * 不信渲染层传来的路径）；`relPath` = 相对钉选根的路径（**不可信**，main 侧
 * `resolveWithinPinRoot` 逐段 resolve + 前缀校验；空串 = 根；目录段用 `/` 连接，
 * Windows 下 `path.resolve` 接受正斜杠）。
 */
export interface FsListDirInput {
  pinId: string
  relPath: string
}

/** `fs:openEntry` 的入参（与 `FsListDirInput` 同形 —— 语义分开命名，防混用） */
export interface FsOpenEntryInput {
  pinId: string
  relPath: string
}

/** 一层目录条目（实现见 `main/pinnedDirGuard.ts#readDirEntries`） */
export interface FsEntry {
  /** 文件 / 子目录名（不含路径） */
  name: string
  /** true = 子目录（渲染层双击下钻）；false = 文件（双击走 `fs:openEntry`） */
  isDir: boolean
  /** 文件字节数（仅文件；stat 失败省略） */
  size?: number
  /** 修改时间毫秒值（stat 失败省略） */
  mtimeMs?: number
}

/**
 * `fs:listDir` 的返回：**永不 reject**，错误是中文单行（目录消失 / 无权限 / 越界）。
 *
 * `truncated`（浏览器 v2，docs/61 A14「2000 截断明示」）：本层条目数超过
 * `LIST_DIR_MAX_ENTRIES`（2000）被截断时为 `true` —— 渲染层必须在列表末尾单行提示，
 * 不允许静默吞掉。**不是分页**：仍只返回前 2000 条。
 */
export type FsListDirResult =
  | { ok: true; entries: FsEntry[]; truncated: boolean }
  | { ok: false; error: string }

/** `fs:openEntry` 的返回：**永不 reject**（`shell.openPath` 的系统错误串压成中文单行） */
export type FsOpenEntryResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * `fs:revealEntry` 的入参（2026-11-25「揭示到当前条目」缺陷修复）。
 *
 * 形状与 `FsListDirInput` 同构：`pinId` 由主进程从**自己的 settings** 解析成钉选根
 * （不信渲染层传来的路径）；`relPath` 相对钉选根、用 `/` 分隔（**不可信**，
 * 主进程侧过 `resolveWithinPinRoot` 前缀校验），空串 = 钉选根自己。
 */
export interface FsRevealEntryInput {
  pinId: string
  relPath: string
}

/**
 * `fs:revealEntry` 的返回：**永不 reject**。
 *
 * - `guard`：`pinId` 未登记 / 钉选根已不存在 / `relPath` 越界（`..`、绝对路径、盘符切换）；
 * - `invalid`：入参形状不合法（保留给调用方分支，当前实现把坏入参并按 guard 收口）；
 * - `io`：`stat` 失败（条目已不存在）或 `shell.showItemInFolder` 抛错；
 *   `error` 是可直接展示的中文单行。
 */
export type FsRevealEntryResult =
  | { ok: true }
  | { ok: false; reason: 'guard' | 'invalid' | 'io'; error: string }

// ── 钉选目录浏览器 v2 · 写操作 + 归档契约（docs/61 §批注结果 · 方案二）────────

/**
 * 浏览器写通道的公共入参骨架：`pinId` + `dirRel`。
 *
 * ⚠️ `pinId` 是守卫的根 —— 主进程只收 id，钉选根的绝对路径由主进程从**自己的 settings**
 * 解析（`fs:listDir` 同款 id 白名单，渲染层传来的任何路径都不信）。`dirRel` 相对钉选根
 * （空串 = 根），过 `resolveWithinPinRoot` 逐段 resolve + 前缀校验。
 */
export interface FsDirScopedInput {
  pinId: string
  dirRel: string
}

/** `fs:mkdir` 入参：在 `dirRel` 下新建名为 `name` 的文件夹（单段名） */
export interface FsMkdirInput extends FsDirScopedInput {
  name: string
}

/** `fs:renameEntry` 入参：把 `dirRel` 下的 `oldName` 改名为 `newName`（均为单段名） */
export interface FsRenameEntryInput extends FsDirScopedInput {
  oldName: string
  newName: string
}

/** `fs:trashEntries` 入参：把 `dirRel` 下的这些条目移入系统回收站（单段名，≤500 个） */
export interface FsTrashEntriesInput extends FsDirScopedInput {
  names: string[]
}

/** `fs:extractArchive` 入参：解压 `dirRel` 下的压缩包 `name`（按扩展名识别） */
export interface FsExtractArchiveInput extends FsDirScopedInput {
  name: string
}

/** `fs:compressEntries` 入参：把 `dirRel` 下的这些条目压缩成同目录一个 zip（≤500 个） */
export interface FsCompressEntriesInput extends FsDirScopedInput {
  names: string[]
}

/** `fs:openWith` 入参：对 `dirRel` 下的 `name` 弹 Windows「打开方式」对话框 */
export interface FsOpenWithInput extends FsDirScopedInput {
  name: string
}

/**
 * 写通道失败的统一收口：`reason` 是**稳定枚举**（渲染层按它分支），`error` 是
 * 可直接展示的中文单行。**永不 reject** —— 所有失败形态都落在这一个形状里。
 *
 * - `exists`：目标名已存在（重命名 / 新建 / 解压 / 压缩输出重名）；
 * - `guard`：`dirRel` 越界（`..` / 绝对路径 / 盘符切换）或 pinId 未登记；
 * - `invalid`：条目名非法（空 / 带路径分隔符 / Windows 非法字符等）；
 * - `io`：磁盘动作失败（源不存在 / 权限 / 压缩包损坏 / 有密码 / 超时）；
 * - `no-7z`：本机没有 7-Zip，无法解压该格式；
 * - `not-archive`：目标不是可识别的压缩包扩展名；
 * - `too-many`：一次批量操作的条目数超上限（500）；
 * - `system-fallback-failed`：7z 缺失走 PowerShell 降级压缩也失败了。
 */
export type FsWriteFailureReason =
  | 'exists'
  | 'guard'
  | 'invalid'
  | 'io'
  | 'no-7z'
  | 'not-archive'
  | 'too-many'
  | 'system-fallback-failed'

/** 写通道失败的统一形状（`reason` 供分支，`error` 供展示） */
export interface FsWriteFailure {
  ok: false
  reason: FsWriteFailureReason
  error: string
}

/** `fs:mkdir` 返回：成功带新目录的条目形状（供渲染层直接插入列表） */
export type FsMkdirResult = { ok: true; entry: FsEntry } | FsWriteFailure

/** `fs:renameEntry` 返回：成功带改名后的条目形状 */
export type FsRenameEntryResult = { ok: true; entry: FsEntry } | FsWriteFailure

/** `fs:trashEntries` 的单个失败项（部分失败不整批失败） */
export interface FsTrashFailedItem {
  name: string
  /** 中文单行失败原因（可直接展示） */
  message: string
}

/**
 * `fs:trashEntries` 的一个**成功移出**条目。
 *
 * `token === null`：进了**系统回收站**（本地盘），系统级，本应用**不可撤销**；
 * `token` 非 null：进了**钉选根内隐藏回收区**（网络盘兜底），可用
 * `fs:restorePinnedTrash` 按 token 真实还原，也可在回收站入口里长期查看。
 * 渲染层必须按此区分撤销条的可用性 —— 不要把系统回收站的条目做成可撤销按钮。
 */
export interface FsTrashedItem {
  name: string
  token: string | null
}

/**
 * `fs:trashEntries` 返回：`ok:true` 表示批次已执行完，**个别条目的失败在 `failed`
 * 里**（回收站化可能因占用 / 权限个别失败，其余条目照常成功）；`trashed` 是
 * 已成功移出的条目及其去向（见 {@link FsTrashedItem}）。
 */
export type FsTrashEntriesResult =
  | { ok: true; failed: FsTrashFailedItem[]; trashed: FsTrashedItem[] }
  | FsWriteFailure

/**
 * 隐藏回收区（`<pinRoot>/.idbox-trash`）里的一个可恢复条目。
 *
 * `token` 是 UUID **目录名**（不是原始中文名，避免路径穿越与编码问题）；
 * `relFolder` 是原所在目录相对 `pinRoot` 的 posix 路径，`''` = 钉选根本身。
 */
export interface PinnedTrashEntry {
  token: string
  name: string
  relFolder: string
  deletedAt: number
  size: number
  isDirectory: boolean
}

/** `fs:listPinnedTrash` 入参：只收 pinId，钉选根由主进程按 id 白名单解析 */
export interface FsListPinnedTrashInput {
  pinId: string
}

/** `fs:listPinnedTrash` 返回：**永不 reject** */
export type FsListPinnedTrashResult =
  | { ok: true; entries: PinnedTrashEntry[] }
  | FsWriteFailure

/** `fs:restorePinnedTrash` 入参：`token` 必须过 UUID 白名单 */
export interface FsRestorePinnedTrashInput {
  pinId: string
  token: string
}

/**
 * `fs:restorePinnedTrash` 返回：**永不 reject**。
 * `renamed:true` 表示原位被占用、已追加 `-2/-3`，渲染层必须提示用户新名字。
 */
export type FsRestorePinnedTrashResult =
  | { ok: true; name: string; relFolder: string; renamed: boolean }
  | FsWriteFailure

/** `fs:extractArchive` 返回：`dirName` = 解压出的文件夹名（同目录下，渲染层刷新即见） */
export type FsExtractArchiveResult = { ok: true; dirName: string } | FsWriteFailure

/** `fs:compressEntries` 返回：`engine` 标明本次用的引擎（`system` = PowerShell 降级） */
export type FsCompressEntriesResult =
  | { ok: true; zipName: string; engine: '7z' | 'system' }
  | FsWriteFailure

/**
 * `fs:openWith` 返回。对话框的唤起是 fire-and-forget：spawn 已受理即 `{ok:true}`，
 * rundll32 之后的失败只落日志（对话框本身没有可回收的错误通道）；
 * `{ok:false}` 仅表示守卫拒绝 / 源不存在 / spawn 本身没发出去。
 */
export type FsOpenWithResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * `fs:entryThumb` 入参：钉选目录 `dirRel` 下的单段文件名 `name`
 * （守卫与写通道同款：pinId 白名单 + dirRel 前缀校验 + name 单段校验）。
 */
export interface FsEntryThumbInput extends FsDirScopedInput {
  name: string
}

/**
 * `fs:entryThumb` 返回：**永不 reject**。
 *
 * - `ok:true` → `url` 是 `pinned-thumb://<缓存文件名>`（`<img src>` 可直接用，
 *   协议 handler 读 `<userData>/pinned-thumbs/` 并做越界夹取）；
 * - `reason:'not-available'`：不是可预览的图片 / SKP 没有内嵌预览 / 源文件不存在
 *   —— **不是错误**，渲染层回退自绘类型图标；
 * - `reason:'io'`：读盘 / 写缓存失败（同样回退图标，不打扰用户）；
 * - `reason:'guard'`：dirRel 越界或条目名非法（附中文 `error`，只落日志取证）。
 */
export type PinnedEntryThumbResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'guard' | 'not-available' | 'io'; error?: string }

/**
 * `template:scanFromDir` 的入参（v1.2 反馈批 C）。
 * `dirPath` = 拖入文件夹的绝对路径（渲染层从 `getPathForFile` 取得，不可信，主进程自校验）。
 */
export interface TemplateScanInput {
  dirPath: string
}

/** `template:scanFromDir` 的丢弃统计：`depth` = 超出 4 级深度被剪的目录数；`nodes` = 超出 256 节点被截的目录数 */
export interface TemplateScanTruncated {
  depth: number
  nodes: number
}

/**
 * `template:scanFromDir` 的返回（**永不 reject**，v1.2 反馈批 C）。
 *
 * - 成功：`root` = 清洗后的模板树草稿（深度 4 / 节点 256 限额内），
 *   `truncated` = 超限丢弃统计，`scannedDirs` = 实际访问过的目录数（含根）；
 * - 失败：`error` 是**中文单行**（文件夹不存在 / 是文件 / 无权限 / 没有子文件夹）。
 */
export type TemplateScanResult =
  | { ok: true; root: ProjectTemplateNode; truncated: TemplateScanTruncated; scannedDirs: number }
  | { ok: false; error: string }

/**
 * `dialog:pickDirectory` 的入参（docs/60 §5.2 通道 1）。
 * 标题与确认按钮文案都由调用方给 —— 向导与钉选添加两个场景的文案不同。
 */
export interface PickDirectoryInput {
  title: string
  buttonLabel: string
}

/**
 * `project:create` 的入参（docs/60 §5.2 通道 2，W5）。
 *
 * `template` 传**完整的** `ProjectTemplate`（渲染层从 settings 里选中的那一份）——
 * 主进程 W6 会重跑 `normalizeProjectTemplate` 加固，不信任这份树的任何内容；
 * `code` 可为空串（编号可选，Q-3：留空 → 根名直接 `sanitizeName(名称)`）。
 */
export interface ProjectCreateInput {
  template: ProjectTemplate
  /** 项目编号（**可选**：空串 / 空白 = 用户跳过，走「直接用名称」分支） */
  code: string
  /** 项目名称（必填；主进程经 `resolveRootName` → `sanitizeName` 清洗） */
  name: string
  /** 存放位置（用户自选的父目录绝对路径；不允许盘根） */
  parentDir: string
}

/**
 * `project:create` 的返回（**永不 reject**，docs/60 §5.2 通道 2）。
 *
 * - 成功：`rootPath` = 新建根目录绝对路径，`dirsCreated` = 实际创建的目录数
 *   （= 归一化后模板树节点数）；
 * - 失败：`error` 是**中文单行**（冲突时指明首个冲突目录的相对名）；
 *   `dirsCreated` 只在**阶段二半程失败**时有值（>0 = 已落盘的目录数，
 *   按铁律不回滚不删除，错误串如实报告）；阶段一拒绝时恒为 0 / 缺省。
 */
export type ProjectCreateResult =
  | { ok: true; rootPath: string; dirsCreated: number }
  | { ok: false; error: string; dirsCreated?: number }

/**
 * `homeBackground:save` 的入参（shared 定义：main / preload / renderer 共用同一份契约，
 * 避免 preload 反向 import main —— 见 `preload/index.ts` 文件头约定）。
 *
 * 本地只交绝对路径，URL 只交 http/https 串；落盘后的 `fileName` 由主进程决定
 * （`<sha256>.<ext>`），渲染层不拼文件名。
 */
export type HomeBackgroundSaveInput =
  | { kind: 'local'; filePath: string }
  | { kind: 'url'; url: string }

/** `homeBackground:save` 的返回：**永不 reject**，失败原因写在 `error` 字段。 */
export type HomeBackgroundSaveResult =
  | { ok: true; fileName: string }
  | { ok: false; error: string }

/**
 * `plugin:linkStatus` 的返回（2026-11-22 用户需求「同步插件 · 联通绿点」）。
 *
 * - `connected:true` = `%APPDATA%\idbox\plugin\manifest.json` 存在、JSON 可解析、
 *   且（若有 enabled 类字段）未被置 false —— SketchUp 卡名称后方据此亮绿点；
 * - `generatedAt` = manifest 信封的落盘时刻（ISO8601 UTC），用于绿点 title；
 *   非字符串 / 缺失 → null（title 只写「已检测到插件连接」）。
 * - 任何失败形态（文件不存在 / 解析失败 / 读盘异常）都**收敛为**
 *   `{ connected: false, generatedAt: null }`，主进程不抛错、渲染层不报红。
 */
export interface PluginLinkStatus {
  connected: boolean
  generatedAt: string | null
  /**
   * 1.1.0 增：**真机插件安装情况**（扫 SketchUp Plugins 目录，2026-11-23 用户拍板）。
   *
   * 可选字段：旧壳 / 旧 preload / 扫描失败时都不会有它，渲染层必须按
   * `install === undefined` 回退成「安装插件」按钮（向后兼容，不硬依赖）。
   * 判据与四态见 `shared/pluginInstall.ts`。
   */
  install?: PluginInstallStatus
}

// ── 一键打包与素材同步：契约类型从 packageFormat.ts 单一定义、此处转出 ──────
//
// 放在这里是为了让 preload / main 沿用既有习惯「IPC 载荷与结果类型从 shared/ipc.ts 取」，
// 与 HomeBackgroundSaveResult 同款；定义本体只在 packageFormat.ts，避免两处漂移。
export type {
  PackageExportInput,
  PackageExportProgressEvent,
  PackageExportResult,
  PackageImportApplyInput,
  PackageImportProgressEvent,
  PackageImportResult,
  PackageInspectResult,
  PackageResolution,
  PackageResolutions
} from './packageFormat'
