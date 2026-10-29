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
  // ── 2026-10-19 AI 辅助分类（docs/15 §7，词表优先 + 模型兜底） ──────────
  /** 请求一批资产名的分类结论（main 侧发 HTTP，渲染层有 CORS/CSP 限制） */
  aiClassify: 'ai:classify',
  /** 「测试连接」：发一条最小请求，回报成功 / 失败原因 */
  aiClassifyTest: 'ai:test',
  /** 主进程 → 渲染进程：一个导入批次已结束（Payload = ImportBatchDoneEvent） */
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
  importConflictExpired: 'import:conflictExpired'
} as const
